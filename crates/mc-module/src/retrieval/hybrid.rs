//! Memory retrieval policy, independent of the storage engine and embedding transport.
//!
//! FTS ranks must come from the original index: rebuilding an index over visible rows
//! changes BM25 document frequencies and can change both candidates and their order.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use super::compartments::{CompartmentChunk, CompartmentHit};
use crate::parity_contract::{Availability, CapabilityResult, EmbeddingIdentity, StoreScope};

// Export recovery helpers for retrieval callers without registering a callable
// tool or changing the existing search entry points.
#[path = "expand.rs"]
pub mod expand;

use crate::parity_contract::{RetrievalHit, RetrievalIntent, RetrievalSource};
use regex::Regex;
use serde_json::{json, Value};
use std::{sync::OnceLock, time::Duration};
use subc_client_rs::{async_trait, CallOptions, SubcConsumer};
use subc_protocol::{BindIdentity, RouteTarget};

pub const RERANK_MODEL: &str = "gte-reranker-modernbert-base-f32";
pub const RERANK_LANE_LIMIT: usize = 25;
pub const RERANK_DEADLINE_MS: u64 = 1500;

/// Literal recall is deliberately absent from automatic searches and hints.
pub fn literal_probes(intent: RetrievalIntent, query: &str) -> Vec<String> {
    if intent != RetrievalIntent::Explicit {
        return Vec::new();
    }
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        [
            r#"["`]([^"`]{1,80})["`]"#,
            r"(?i)/[a-z][a-z0-9]*(?:-[a-z0-9]+)+",
            r"\b(?:TS\d{4,}|ERR_[A-Z][A-Z0-9_]*)\b",
            r"(?i)[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9_-]+)+",
            r"(?i)[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+",
            r"\b[a-zA-Z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b",
            r"(?i)\b[0-9a-f]{7,40}\b",
        ]
        .into_iter()
        // JavaScript's identifier and boundary classes are ASCII, even when the
        // surrounding question contains Unicode prose.
        .enumerate()
        .map(|(i, p)| {
            Regex::new(&if i == 0 {
                p.to_owned()
            } else {
                format!("(?-u:{p})")
            })
            .expect("literal probe pattern")
        })
        .collect()
    });
    let mut seen = BTreeSet::new();
    let mut probes = Vec::new();
    for (kind, pattern) in patterns.iter().enumerate() {
        for capture in pattern.captures_iter(trim_query(query)) {
            let probe = trim_query(capture.get(usize::from(kind == 0)).unwrap().as_str());
            if probe.encode_utf16().count() < 3
                || (kind == 0 && probe.encode_utf16().count() > 80)
                || (kind == 6 && !probe.bytes().any(|b| b.is_ascii_digit()))
                || !seen.insert(probe.to_lowercase())
            {
                continue;
            }
            probes.push(probe.to_owned());
            if probes.len() == 5 {
                return probes;
            }
        }
    }
    probes
}

pub fn contains_probe_verbatim(text: &str, probes: &[String]) -> bool {
    let text = text.to_lowercase();
    probes
        .iter()
        .any(|probe| text.contains(&probe.to_lowercase()))
}

pub fn is_prose_query(query: &str) -> bool {
    static REJECT: OnceLock<Regex> = OnceLock::new();
    static PLAIN: OnceLock<Regex> = OnceLock::new();
    static QUESTION: OnceLock<Regex> = OnceLock::new();
    let text = trim_query(query);
    let reject = REJECT.get_or_init(|| Regex::new(concat!(
        r#"(?:[\n;]|^["'`]|["'`]$|"#,
        r"(?i:^(?:error\b|cannot\b|failed\b|panic\b|traceback\b|assertion\b|SQLITE_|TypeError\b|ReferenceError\b|SyntaxError\b))|",
        r"\b(?:[A-Z][A-Z_]+:|\w*(?:Error|Exception):)|\bat\s+\S+\s*\()"
    )).unwrap());
    if text.is_empty() || reject.is_match(text) {
        return false;
    }
    let words: Vec<_> = text
        .strip_suffix(['?', '!', '.'])
        .unwrap_or(text)
        .split(js_space)
        .filter(|w| !w.is_empty())
        .collect();
    let plain = PLAIN.get_or_init(|| Regex::new(r"^[a-zA-Z]+(?:['’-][a-zA-Z]+)*$").unwrap());
    let count = words.iter().filter(|w| plain.is_match(w)).count();
    let question = QUESTION
        .get_or_init(|| Regex::new(r"(?i-u)^(?:how|why|what|where|when|which|who)\b").unwrap());
    if question.is_match(text) {
        words.len() >= 3 && count >= 3
    } else {
        words.len() >= 4 && count >= 3 && !text.contains(['\\', '/', '=']) && !text.contains("::")
    }
}

#[derive(Debug, Clone)]
pub struct ProbeMatches {
    pub probe: String,
    pub document_frequency: usize,
    /// Original FTS order and full content, before preview truncation.
    pub hits: Vec<RetrievalHit>,
}

/// Fuse already scoped FTS snapshots; the caller owns SQL, cutoff and date gates.
pub fn rank_message_probes(
    baseline: &[RetrievalHit],
    probes: &[ProbeMatches],
    corpus_size: usize,
    row_limit: usize,
    limit: usize,
) -> Vec<RetrievalHit> {
    let weights: Vec<_> = probes
        .iter()
        .map(|p| {
            if corpus_size == 0 || p.document_frequency == 0 {
                1.0
            } else {
                1.0 / (1.0 + 100.0 * p.document_frequency as f64 / corpus_size as f64)
            }
        })
        .collect();
    let mut fused: Vec<(RetrievalHit, f64)> = Vec::new();
    for (hits, weight) in std::iter::once((baseline, 1.0)).chain(
        probes
            .iter()
            .zip(&weights)
            .map(|(p, w)| (p.hits.as_slice(), *w)),
    ) {
        for (rank, hit) in hits.iter().take(row_limit).enumerate() {
            let score = weight / (60 + rank) as f64;
            if let Some(row) = fused.iter_mut().find(|(h, _)| h.source_id == hit.source_id) {
                row.1 += score;
            } else {
                fused.push((hit.clone(), score));
            }
        }
    }
    for (hit, score) in &mut fused {
        let best = probes
            .iter()
            .zip(&weights)
            .filter(|(p, _)| contains_probe_verbatim(&hit.text, std::slice::from_ref(&p.probe)))
            .map(|(_, w)| *w)
            .fold(0.0, f64::max);
        *score += best / 60.0;
    }
    fused.sort_by(|(a, sa), (b, sb)| {
        sb.total_cmp(sa)
            .then_with(|| a.ordinal.map(|o| o.value).cmp(&b.ordinal.map(|o| o.value)))
    });
    fused.truncate(limit);
    let count = fused.len();
    fused
        .into_iter()
        .enumerate()
        .map(|(rank, (mut hit, _))| {
            hit.score = if count <= 1 {
                1.0
            } else {
                1.0 - rank as f64 / count as f64
            };
            hit.text = preview(&hit.text);
            hit
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SearchCandidate {
    pub hit: RetrievalHit,
    /// Inclusive raw-message bounds, set only on compartment candidates.
    pub compartment_range: Option<(u64, u64)>,
}

/// Field order is the TS lane insertion order, not lexicographic map order.
#[derive(Debug, Clone, Default)]
pub struct SearchLanes {
    pub memory_fts: Vec<SearchCandidate>,
    pub memory_vector: Vec<SearchCandidate>,
    pub primer_fts: Vec<SearchCandidate>,
    pub primer_vector: Vec<SearchCandidate>,
    pub message_fts: Vec<SearchCandidate>,
    pub chunk_vector: Vec<SearchCandidate>,
    pub git_fts: Vec<SearchCandidate>,
    pub git_vector: Vec<SearchCandidate>,
    pub notes: Vec<SearchCandidate>,
}

pub fn fuse_search_lanes(lanes: &SearchLanes) -> Vec<SearchCandidate> {
    let mut fused: Vec<(SearchCandidate, f64)> = Vec::new();
    for (lane_index, lane) in [
        &lanes.memory_fts,
        &lanes.memory_vector,
        &lanes.primer_fts,
        &lanes.primer_vector,
        &lanes.message_fts,
        &lanes.chunk_vector,
        &lanes.git_fts,
        &lanes.git_vector,
        &lanes.notes,
    ]
    .into_iter()
    .enumerate()
    {
        let mut seen = BTreeSet::new();
        for (index, original) in lane.iter().take(RERANK_LANE_LIMIT).enumerate() {
            let candidate = if lane_index == 4 && original.hit.source == RetrievalSource::RawMessage
            {
                lanes
                    .chunk_vector
                    .iter()
                    .find(|c| {
                        c.hit.source == RetrievalSource::Compartment
                            && c.compartment_range
                                .zip(original.hit.ordinal)
                                .is_some_and(|((start, end), o)| o.value >= start && o.value <= end)
                    })
                    .unwrap_or(original)
            } else {
                original
            };
            let key = format!("{:?}:{}", candidate.hit.source, candidate.hit.source_id);
            if !seen.insert(key) {
                continue;
            }
            let score = 1.0 / (61 + index) as f64;
            if let Some(row) = fused.iter_mut().find(|(c, _)| {
                c.hit.source == candidate.hit.source && c.hit.source_id == candidate.hit.source_id
            }) {
                row.1 += score;
            } else {
                fused.push((candidate.clone(), score));
            }
        }
    }
    // Stable sort retains first insertion order for equal RRF totals.
    fused.sort_by(|a, b| b.1.total_cmp(&a.1));
    fused.into_iter().take(20).map(|(hit, _)| hit).collect()
}

pub fn truncate_utf8(text: &str, bytes: usize) -> &str {
    let mut end = text.len().min(bytes);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

pub fn candidate_text(location: &str, title: &str, body: &str) -> String {
    let header = format!(
        "{}\n{}\n",
        truncate_utf8(&location.replace('\n', " "), 200),
        truncate_utf8(&title.replace('\n', " "), 120)
    );
    format!("{header}{}", truncate_utf8(body, 1024 - header.len()))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RerankIdentity {
    pub project_root: String,
    pub harness: String,
    pub session: String,
}

impl RerankIdentity {
    pub fn new(project_root: String, session: String) -> Self {
        Self {
            project_root,
            harness: "magic-context".into(),
            session,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RerankCallOptions {
    pub timeout_ms: u64,
    pub target_kind: String,
    pub identity: RerankIdentity,
}

#[async_trait]
pub trait RerankClient: Send + Sync {
    async fn call(
        &self,
        module: &str,
        method: &str,
        params: Value,
        options: RerankCallOptions,
    ) -> Result<Value, String>;
}

/// Calls Synapse through the module RPC client, with no alternate model transport.
/// Retrieval integration must add a Synapse rerank purpose to `RegisteredRoute`
/// in route_targets.rs and pass that registry-resolved target here. This adapter
/// never constructs a route target or changes the module's consumed routes.
pub struct SubcRerankClient<'a> {
    pub consumer: &'a SubcConsumer,
    pub target: RouteTarget,
}

#[async_trait]
impl RerankClient for SubcRerankClient<'_> {
    async fn call(
        &self,
        _module: &str,
        method: &str,
        params: Value,
        options: RerankCallOptions,
    ) -> Result<Value, String> {
        let budget = Duration::from_millis(options.timeout_ms);
        let bytes = SubcConsumer::call(
            self.consumer,
            self.target.clone(),
            BindIdentity::new(options.identity.harness, options.identity.session),
            serde_json::to_vec(&json!({"method":method,"params":params}))
                .map_err(|e| e.to_string())?,
            CallOptions {
                timeout: budget,
                route_retry_deadline: budget,
                ..CallOptions::default()
            },
        )
        .await
        .map_err(|e| e.to_string())?;
        serde_json::from_slice(&bytes).map_err(|e| e.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PinnedReranker {
    pub fingerprint: String,
    pub table_epoch: i64,
}

fn unwrap_rerank(value: &Value) -> Option<&Value> {
    let body = value
        .get("result")
        .filter(|v| !v.is_null())
        .unwrap_or(value);
    (body.is_object()
        && !body
            .get("error")
            .is_some_and(|v| !v.is_null() && v != &Value::Bool(false)))
    .then_some(body)
}

pub fn pin_reranker(value: &Value) -> Option<PinnedReranker> {
    let body = unwrap_rerank(value)?;
    let model = body
        .get("models")?
        .as_array()?
        .iter()
        .find(|m| m.get("model_id").and_then(Value::as_str) == Some(RERANK_MODEL))?;
    let fingerprints = model.get("fingerprints")?.as_array()?;
    let fingerprint = fingerprints.first()?.as_str()?;
    let table_epoch = body.get("table_epoch")?.as_i64()?;
    if model.get("certified") != Some(&Value::Bool(true))
        || fingerprints.len() != 1
        || fingerprint.len() != 64
        || !fingerprint
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || table_epoch.unsigned_abs() > 9_007_199_254_740_991
    {
        return None;
    }
    Some(PinnedReranker {
        fingerprint: fingerprint.into(),
        table_epoch,
    })
}

fn rerank_options(identity: &RerankIdentity) -> RerankCallOptions {
    RerankCallOptions {
        timeout_ms: RERANK_DEADLINE_MS,
        target_kind: "management_surface".into(),
        identity: identity.clone(),
    }
}

pub async fn prepare_reranker(
    intent: RetrievalIntent,
    query: &str,
    client: Option<&dyn RerankClient>,
    identity: &RerankIdentity,
) -> Option<PinnedReranker> {
    if intent != RetrievalIntent::Explicit || !is_prose_query(query) {
        return None;
    }
    let response = tokio::time::timeout(
        Duration::from_millis(RERANK_DEADLINE_MS),
        client?.call(
            "synapse",
            "models.list",
            json!({}),
            rerank_options(identity),
        ),
    )
    .await
    .ok()?
    .ok()?;
    pin_reranker(&response)
}

pub struct RerankSession<'a> {
    pub client: &'a dyn RerankClient,
    pub lane: PinnedReranker,
    pub identity: RerankIdentity,
}

/// All failure exits clone the caller's baseline, never the expanded fused pool.
pub async fn rerank_search_results(
    intent: RetrievalIntent,
    session: Option<&RerankSession<'_>>,
    query: &str,
    baseline: &[SearchCandidate],
    pool: &[SearchCandidate],
    texts: &[String],
    limit: usize,
) -> Vec<SearchCandidate> {
    if intent != RetrievalIntent::Explicit
        || pool.is_empty()
        || pool.len() > 20
        || texts.len() != pool.len()
        || texts.iter().any(|t| t.len() > 1024)
    {
        return baseline.to_vec();
    }
    let Some(session) = session else {
        return baseline.to_vec();
    };
    let response = tokio::time::timeout(Duration::from_millis(RERANK_DEADLINE_MS), session.client.call("synapse", "rerank.score", json!({
        "model":RERANK_MODEL,"query":query,"candidates":texts,"required_fingerprint":session.lane.fingerprint,
        "allow_equivalent":false,"accept_declared":false,"max_queue_ms":100,"deadline_ms":RERANK_DEADLINE_MS,
    }), rerank_options(&session.identity))).await;
    let Ok(Ok(response)) = response else {
        return baseline.to_vec();
    };
    let Some(body) = unwrap_rerank(&response) else {
        return baseline.to_vec();
    };
    if body.get("fingerprint").and_then(Value::as_str) != Some(session.lane.fingerprint.as_str())
        || body.get("table_epoch").and_then(Value::as_i64) != Some(session.lane.table_epoch)
    {
        return baseline.to_vec();
    }
    let Some(scores) = body.get("scores").and_then(Value::as_array) else {
        return baseline.to_vec();
    };
    let Some(scores) = scores
        .iter()
        .map(|s| s.as_f64().filter(|s| s.is_finite()))
        .collect::<Option<Vec<_>>>()
    else {
        return baseline.to_vec();
    };
    if scores.len() != pool.len() {
        return baseline.to_vec();
    }
    let mut order: Vec<_> = (0..pool.len()).collect();
    order.sort_by(|a, b| {
        scores[*b]
            .partial_cmp(&scores[*a])
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.cmp(b))
    });
    order
        .into_iter()
        .take(limit)
        .map(|i| pool[i].clone())
        .collect()
}

pub const FTS_CANDIDATE_LIMIT: usize = 50;
const SEMANTIC_WEIGHT: f64 = 0.7;
const FTS_WEIGHT: f64 = 0.3;
pub const SINGLE_SOURCE_PENALTY: f64 = 0.8;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct DateBounds {
    pub from_ms: Option<i64>,
    pub to_ms: Option<i64>,
}

impl DateBounds {
    pub fn contains(self, timestamp: i64) -> bool {
        self.from_ms.is_none_or(|from| timestamp >= from)
            && self.to_ms.is_none_or(|to| timestamp <= to)
    }
}

#[derive(Debug, Clone)]
pub struct SearchMemory {
    pub id: i64,
    pub category: String,
    pub content: String,
    pub created_at_ms: i64,
    pub source_name: Option<String>,
}

#[derive(Debug, Clone)]
pub struct MemoryFtsHit {
    pub memory_id: i64,
    /// The index's original BM25 value, in ascending order. Scoring uses rank,
    /// not the magnitude of BM25; retain it so adapters can expose index provenance.
    pub bm25: f64,
}

#[derive(Debug, Clone)]
pub struct MemoryVector {
    pub memory_id: i64,
    pub identity: EmbeddingIdentity,
    pub values: Vec<f32>,
}

/// Store reads use authenticated scope. Memory reads must apply active/permanent,
/// expiry, project aliases and workspace shared-category policy before returning rows.
/// FTS date/scope predicates precede LIMIT, but BM25 uses the full persisted index.
/// Chunk reads preserve the store's chunk order, including equal-score chunks.
pub trait RetrievalInputStore: Send + Sync {
    fn read_search_memories(
        &self,
        scope: &StoreScope,
        dates: DateBounds,
    ) -> CapabilityResult<Vec<SearchMemory>>;
    fn search_memory_fts(
        &self,
        scope: &StoreScope,
        query: &str,
        dates: DateBounds,
        limit: usize,
    ) -> CapabilityResult<Vec<MemoryFtsHit>>;
    fn read_memory_vectors(
        &self,
        scope: &StoreScope,
        memory_ids: &[i64],
        identity: &EmbeddingIdentity,
    ) -> CapabilityResult<Vec<MemoryVector>>;
    fn read_compartment_chunks(
        &self,
        scope: &StoreScope,
        dates: DateBounds,
        identity: &EmbeddingIdentity,
    ) -> CapabilityResult<Vec<CompartmentChunk>>;
    /// IDs rendered in the cached baseline and subsequent prompt updates, rather
    /// than all memories eligible for rendering on the next transform.
    fn read_visible_memory_ids(&self, scope: &StoreScope) -> CapabilityResult<BTreeSet<i64>>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MatchType {
    Fts,
    Semantic,
    Hybrid,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryHit {
    pub content: String,
    pub score: f64,
    pub memory_id: i64,
    pub category: String,
    pub match_type: MatchType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "source", rename_all = "snake_case")]
pub enum SearchHit {
    Memory(MemoryHit),
    Compartment(CompartmentHit),
}

impl SearchHit {
    pub fn score(&self) -> f64 {
        match self {
            Self::Memory(hit) => hit.score,
            Self::Compartment(hit) => hit.score,
        }
    }
    pub fn reported_score(&self) -> String {
        reported_score(self.score())
    }
    pub fn effective_score(&self) -> f64 {
        self.score()
            * match self {
                Self::Memory(_) => 1.3,
                Self::Compartment(_) => 1.275,
            }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RetrievalDiagnostics {
    pub suppressed_visible_memory_ids: Vec<i64>,
    /// An unavailable component is different from a successful read with no rows.
    pub components: BTreeMap<String, Availability>,
}

impl RetrievalDiagnostics {
    pub fn take<T>(&mut self, component: &str, result: CapabilityResult<T>) -> Option<T> {
        self.components
            .insert(component.into(), result.availability());
        match result {
            CapabilityResult::Available { value } | CapabilityResult::Degraded { value, .. } => {
                Some(value)
            }
            CapabilityResult::Unavailable { .. } => None,
        }
    }
}

/// Accumulate in f64, as JavaScript does after reading float32 storage. A zero
/// vector or a nonfinite cosine contributes a defined zero semantic score.
pub fn cosine_score(a: &[f32], b: &[f32]) -> f64 {
    if a.len() != b.len() {
        return 0.0;
    }
    let mut dot = 0.0;
    let mut norm_a = 0.0;
    let mut norm_b = 0.0;
    for (&a, &b) in a.iter().zip(b) {
        let (a, b) = (f64::from(a), f64::from(b));
        dot += a * b;
        norm_a += a * a;
        norm_b += b * b;
    }
    let score = dot / (norm_a.sqrt() * norm_b.sqrt());
    if score.is_finite() {
        score.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

pub fn rank_memories(
    memories: &[SearchMemory],
    fts: &[MemoryFtsHit],
    vectors: &[MemoryVector],
    query: Option<(&EmbeddingIdentity, &[f32])>,
    visible: &BTreeSet<i64>,
    dates: DateBounds,
    limit: usize,
) -> (Vec<MemoryHit>, Vec<i64>) {
    let fts_scores: BTreeMap<_, _> = fts
        .iter()
        .take(FTS_CANDIDATE_LIMIT)
        .enumerate()
        .map(|(rank, hit)| (hit.memory_id, 1.0 / (rank + 1) as f64))
        .collect();
    let vectors: BTreeMap<_, _> = vectors.iter().map(|v| (v.memory_id, v)).collect();
    let mut hits = Vec::new();
    let mut suppressed = Vec::new();
    for memory in memories.iter().filter(|m| dates.contains(m.created_at_ms)) {
        let fts_score = fts_scores.get(&memory.id).copied();
        let semantic = query.and_then(|(identity, query)| {
            let vector = vectors.get(&memory.id)?;
            if &vector.identity != identity || vector.values.len() != identity.dimensions as usize {
                return None;
            }
            Some(cosine_score(query, &vector.values))
        });
        let (score, match_type) = match (semantic, fts_score) {
            (Some(semantic), Some(fts)) => (
                SEMANTIC_WEIGHT * semantic + FTS_WEIGHT * fts,
                MatchType::Hybrid,
            ),
            (Some(semantic), None) => (semantic * SINGLE_SOURCE_PENALTY, MatchType::Semantic),
            (None, Some(fts)) => (fts * SINGLE_SOURCE_PENALTY, MatchType::Fts),
            (None, None) => continue,
        };
        if score <= 0.0 {
            continue;
        }
        if visible.contains(&memory.id) {
            suppressed.push(memory.id);
            continue;
        }
        hits.push(MemoryHit {
            content: preview(&memory.content),
            score,
            memory_id: memory.id,
            category: memory.category.clone(),
            match_type,
            source_name: memory.source_name.clone(),
        });
    }
    hits.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then(a.memory_id.cmp(&b.memory_id))
    });
    hits.truncate(limit);
    suppressed.sort_unstable();
    (hits, suppressed)
}

pub fn sort_supported_hits(hits: &mut [SearchHit]) {
    // Stable sorting preserves lane order when different sources have equal boosts.
    hits.sort_by(|a, b| {
        b.effective_score()
            .total_cmp(&a.effective_score())
            .then_with(|| match (a, b) {
                (SearchHit::Memory(a), SearchHit::Memory(b)) => a.memory_id.cmp(&b.memory_id),
                (SearchHit::Compartment(a), SearchHit::Compartment(b)) => {
                    a.start_ordinal.cmp(&b.start_ordinal)
                }
                _ => std::cmp::Ordering::Equal,
            })
    });
}

fn js_space(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}' |
        '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

pub fn trim_query(text: &str) -> &str {
    text.trim_matches(js_space)
}

pub fn preview(text: &str) -> String {
    let mut normalized = String::new();
    let mut space = false;
    for c in text.chars() {
        if js_space(c) {
            space = !normalized.is_empty();
        } else {
            if space {
                normalized.push(' ');
                space = false;
            }
            normalized.push(c);
        }
    }
    let utf16: Vec<_> = normalized.encode_utf16().collect();
    if utf16.len() <= 220 {
        return normalized;
    }
    format!(
        "{}…",
        String::from_utf16_lossy(&utf16[..219]).trim_end_matches(js_space)
    )
}

/// Round the binary value itself, not a rounded intermediate `score * 100`.
/// This implements fixed-two-decimal reporting with ties rounded upwards;
/// multiplying first would incorrectly render values such as 0.615 as 0.62.
pub fn reported_score(score: f64) -> String {
    assert!(score.is_finite() && (0.0..=1.0).contains(&score));
    let bits = score.to_bits();
    let exponent = ((bits >> 52) & 0x7ff) as i32;
    let mantissa = (bits & ((1u64 << 52) - 1)) | if exponent == 0 { 0 } else { 1u64 << 52 };
    let shift = 52 + 1023 - exponent.max(1);
    let numerator = u128::from(mantissa) * 100;
    let rounded = if shift >= 128 {
        0
    } else {
        let denominator = 1u128 << shift;
        numerator / denominator + u128::from(numerator % denominator >= denominator / 2)
    };
    format!("{}.{:02}", rounded / 100, rounded % 100)
}

// Expected values were generated by executing TypeScript at the provenance commit
// with recorded inputs; they are independent of the Rust implementation.
#[cfg(test)]
const FROZEN_SEARCH: &str = r####"{
  "provenance": {
    "commit": "282d9c08bce490346583a3b8c145c402499f980f",
    "sha256": {
      "packages/plugin/src/hooks/magic-context/token-count-exact.ts": "7e48906e5dbe57ccec12de2181b967a7fa132ba23d780e9ae5251c36ad8733e9",
      "packages/plugin/src/hooks/magic-context/read-session-formatting.ts": "5e5cdcb8027b4be256ad7eba45c254688583dd613cba21c6587a64044984c304",
      "packages/plugin/src/shared/historian-tool-template.ts": "74800c8fc681c84f9ccfa703c7d3b68cf02c289ece4f3a0c7b1f642e05b70d81",
      "packages/plugin/src/shared/historian-tool-preview-defaults.json": "b9246fdaad6ab38650f94c4c1d7e360d9e85d7d031c01760d0850d9a068cc13d",
      "packages/plugin/src/shared/historian-tool-defaults.json": "eb3891f2fe1f4b030dacc6b711b22037647a40ed7ae91e9979ac920f14e555cc",
      "packages/plugin/src/shared/historian-tool-expansions.ts": "bbbc7ac16ad1908e991497aab8835f40f3207cade6f0749eb694768ef9668071",
      "packages/plugin/src/tools/ctx-expand/render.ts": "2551e4025fd3b8abfd999fdca05ca804c2938d3facf4d62a30c4027ed6681d7a",
      "packages/plugin/src/features/magic-context/literal-probes.ts": "cb38519de49197dea3609fa26d6ac936c27c6bdbfdf0239f723e21647e1d93e6",
      "packages/plugin/src/features/magic-context/search-rerank.ts": "314a0a80a54136a154f8ae605bb20ee31cca81046170d389fadee0a1aebab855",
      "packages/plugin/src/tools/ctx-expand/tools.ts": "2e2fe2d9fb62b742d1a0fd93a9099146dcf7f46801ce5483dde5915e0c2959e0",
      "packages/plugin/src/tools/ctx-expand/constants.ts": "dcad832dcb04e12b8265de97e38e0a55a08563ef87d4d560b108e175d5d79292",
      "packages/plugin/src/features/magic-context/search.ts": "89a9913e7645f991e196ca3a5cfd2a1a4a1dd92770b74c200dfeb32e05eafda3"
    },
    "tokenEstimator": "tokenizer:43",
    "generator": "generate.ts: frozen source executed with recorded SQL rows, raw-message visitor and fake Synapse; no live store"
  },
  "probes": [
    {
      "query": "",
      "expected": []
    },
    {
      "query": "why did the tool calls inflate",
      "expected": []
    },
    {
      "query": "why did /ctx-status tool calls inflate",
      "expected": [
        "/ctx-status",
        "ctx-status"
      ]
    },
    {
      "query": "\"exact phrase\" and `second literal` /ctx-status TS2345 search.ts ctx_status getMessageOrdinal a12b34c",
      "expected": [
        "exact phrase",
        "second literal",
        "/ctx-status",
        "TS2345",
        "search.ts"
      ]
    },
    {
      "query": "ERR_FOO_BAR error then file/path.ts and RawMessage 1234567 feedface",
      "expected": [
        "ERR_FOO_BAR",
        "path.ts",
        "RawMessage",
        "1234567"
      ]
    },
    {
      "query": "getMessageOrdinal getmessageordinal materializeM0 RawMessage 1a2b3c4",
      "expected": [
        "getMessageOrdinal",
        "materializeM0",
        "RawMessage",
        "1a2b3c4"
      ]
    },
    {
      "query": "﻿/CTX-status ctx-status memory.auto_search abc_def﻿",
      "expected": [
        "/CTX-status",
        "memory.auto_search",
        "CTX-status",
        "auto_search",
        "abc_def"
      ]
    },
    {
      "query": "\"🙂x\" `日本語`",
      "expected": [
        "🙂x",
        "日本語"
      ]
    },
    {
      "query": "\"🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂\"",
      "expected": []
    }
  ],
  "prose": [
    {
      "query": "how does memory retrieval work?",
      "expected": true
    },
    {
      "query": "find useful persisted memory facts",
      "expected": true
    },
    {
      "query": "error cannot find the memory",
      "expected": false
    },
    {
      "query": "TypeError: foo at fn()",
      "expected": false
    },
    {
      "query": "search.ts memory.foo RawMessage",
      "expected": false
    },
    {
      "query": "how foo bar??",
      "expected": false
    },
    {
      "query": "why can’t we find this",
      "expected": true
    },
    {
      "query": "why foo bar\n",
      "expected": true
    },
    {
      "query": "what happened to the file",
      "expected": true
    }
  ],
  "fusion": {
    "lanes": {
      "memory_fts": [
        {
          "source": "memory",
          "memoryId": 9,
          "content": "memory 9",
          "score": 0.9,
          "category": "fact",
          "matchType": "fts"
        },
        {
          "source": "memory",
          "memoryId": 1,
          "content": "memory 1",
          "score": 0.9,
          "category": "fact",
          "matchType": "fts"
        },
        {
          "source": "memory",
          "memoryId": 9,
          "content": "memory 9",
          "score": 0.9,
          "category": "fact",
          "matchType": "fts"
        }
      ],
      "memory_vector": [
        {
          "source": "memory",
          "memoryId": 1,
          "content": "memory 1",
          "score": 0.9,
          "category": "fact",
          "matchType": "fts"
        },
        {
          "source": "memory",
          "memoryId": 7,
          "content": "memory 7",
          "score": 0.9,
          "category": "fact",
          "matchType": "fts"
        }
      ],
      "primer_fts": [],
      "primer_vector": [],
      "message_fts": [
        {
          "source": "message",
          "messageId": "covered",
          "messageOrdinal": 5,
          "content": "raw",
          "role": "assistant",
          "score": 0.2
        },
        {
          "source": "message",
          "messageId": "covered2",
          "messageOrdinal": 6,
          "content": "raw2",
          "role": "assistant",
          "score": 0.2
        },
        {
          "source": "message",
          "messageId": "free",
          "messageOrdinal": 12,
          "content": "outside",
          "role": "assistant",
          "score": 0.2
        }
      ],
      "chunk_vector": [
        {
          "source": "compartment",
          "compartmentId": 3,
          "sessionId": "s",
          "startOrdinal": 4,
          "endOrdinal": 9,
          "title": "chunk",
          "content": "summary",
          "score": 0.4,
          "matchType": "semantic"
        }
      ],
      "git_fts": [
        {
          "source": "git_commit",
          "sha": "dead123",
          "content": "git",
          "score": 0.1
        }
      ],
      "git_vector": [],
      "notes": [
        {
          "source": "note",
          "noteId": 2,
          "content": "note",
          "score": 0.1
        }
      ]
    },
    "expected": [
      "compartment:3",
      "memory:1",
      "memory:9",
      "git_commit:dead123",
      "note:2",
      "memory:7",
      "message:free"
    ],
    "cappedExpected": [
      "note:0",
      "note:1",
      "note:2",
      "note:3",
      "note:4",
      "note:5",
      "note:6",
      "note:7",
      "note:8",
      "note:9",
      "note:10",
      "note:11",
      "note:12",
      "note:13",
      "note:14",
      "note:15",
      "note:16",
      "note:17",
      "note:18",
      "note:19"
    ],
    "laneLimit": {
      "lanes": {
        "memory_fts": [
          {
            "source": "memory",
            "memoryId": 0,
            "content": "memory 0",
            "score": 0.9,
            "category": "fact",
            "matchType": "fts"
          },
          {
            "source": "memory",
            "memoryId": 0,
            "content": "memory 0",
            "score": 0.9,
            "category": "fact",
            "matchType": "fts"
          },
          {
            "source": "memory",
            "memoryId": 0,
            "content": "memory 0",
            "score": 0.9,
            "category": "fact",
            "matchType": "fts"
          },
          {
            "source": "memory",
            "memoryId": 0,
            "content": "memory 0",
            "score": 0.9,
            "category": "fact",
            "matchType": "fts"
          },
          {
            "source": "memory",
            "memoryId": 0,
            "content": "memory 0",
            "score": 0.9,
            "category": "fact",
            "matchType": "fts"
          },
          {
            "source": "memory",
            "memoryId": 0,
            "content": "memory 0",
            "score": 0.9,
            "category": "fact",
            "matchType": "fts"
          },
          {
            "source": "memory",
            "memoryId": 0,
            "content": "memory 0",
            "score": 0.9,
            "category": "fact",
            "matchType": "fts"
          },
          {
            "source": "memory",
            "memoryId": 0,
            "content": "memory 0",
            "score": 0.9,
            "category": "fact",
            "matchType": "fts"
          },
          {
            "source": "memory",
            "memoryId": 0,
            "content": "memory 0",
            "score": 0.9,
            "category": "fact",
            "matchType": "fts"
          },
          {
            "source": "memory",
            "memoryId": 0,
            "content": "memory 0",
            "score": 0.9,
            "category": "fact",
            "matchType": "fts"
          },
          {
            "source": "memory",
            "memoryId": 0,
            "content": "memory 0",
            "score": 0.9,
            "category": "fact",
            "matchType": "fts"
          },
          {
            "source": "memory",
            "memoryId": 0,
            "content": "memory 0",
            "score": 0.9,
            "category": "fact",
            "matchType": "fts"
          },
          {
            "source": "memory",
            "memoryId": 0,
            "content": "memory 0",
            "score": 0.9,
            "category": "fact",
            "matchType": "fts"
          },
          {
            "source": "memory",
            "memoryId": 0,
            "content": "memory 0",
            "score": 0.9,
            "category": "fact",
            "matchType": "fts"
          },
          {
            "source": "memory",
            "memoryId": 0,
            "content": "memory 0",
            "score": 0.9,
            "category": "fact",
            "matchType": "fts"
          },
          {
            "source": "memory",
            "memoryId": 0,
            "content": "memory 0",
            "score": 0.9,
            "category": "fact",
            "matchType": "fts"
          },
          {
            "source": "memory",
            "memoryId": 0,
            "content": "memory 0",
            "score": 0.9,
            "category": "fact",
            "matchType": "fts"
          },
          {
            "source": "memory",
            "memoryId": 0,
            "content": "memory 0",
            "score": 0.9,
            "category": "fact",
            "matchType": "fts"
          },
          {
            "source": "memory",
            "memoryId": 0,
            "content": "memory 0",
            "score": 0.9,
            "category": "fact",
            "matchType": "fts"
          },
          {
            "source": "memory",
            "memoryId": 0,
            "content": "memory 0",
            "score": 0.9,
            "category": "fact",
            "matchType": "fts"
          },
          {
            "source": "memory",
            "memoryId": 0,
            "content": "memory 0",
            "score": 0.9,
            "category": "fact",
            "matchType": "fts"
          },
          {
            "source": "memory",
            "memoryId": 0,
            "content": "memory 0",
            "score": 0.9,
            "category": "fact",
            "matchType": "fts"
          },
          {
            "source": "memory",
            "memoryId": 0,
            "content": "memory 0",
            "score": 0.9,
            "category": "fact",
            "matchType": "fts"
          },
          {
            "source": "memory",
            "memoryId": 0,
            "content": "memory 0",
            "score": 0.9,
            "category": "fact",
            "matchType": "fts"
          },
          {
            "source": "memory",
            "memoryId": 0,
            "content": "memory 0",
            "score": 0.9,
            "category": "fact",
            "matchType": "fts"
          },
          {
            "source": "memory",
            "memoryId": 99,
            "content": "memory 99",
            "score": 0.9,
            "category": "fact",
            "matchType": "fts"
          }
        ],
        "memory_vector": [
          {
            "source": "memory",
            "memoryId": 99,
            "content": "memory 99",
            "score": 0.9,
            "category": "fact",
            "matchType": "fts"
          }
        ],
        "primer_fts": [],
        "primer_vector": [],
        "message_fts": [],
        "chunk_vector": [],
        "git_fts": [],
        "git_vector": [],
        "notes": []
      },
      "expected": [
        "memory:0",
        "memory:99"
      ]
    },
    "dedup": {
      "lanes": {
        "memory_fts": [
          {
            "source": "memory",
            "memoryId": 1,
            "content": "memory 1",
            "score": 0.9,
            "category": "fact",
            "matchType": "fts"
          },
          {
            "source": "memory",
            "memoryId": 9,
            "content": "memory 9",
            "score": 0.9,
            "category": "fact",
            "matchType": "fts"
          },
          {
            "source": "memory",
            "memoryId": 9,
            "content": "memory 9",
            "score": 0.9,
            "category": "fact",
            "matchType": "fts"
          },
          {
            "source": "memory",
            "memoryId": 9,
            "content": "memory 9",
            "score": 0.9,
            "category": "fact",
            "matchType": "fts"
          }
        ],
        "memory_vector": [
          {
            "source": "memory",
            "memoryId": 1,
            "content": "memory 1",
            "score": 0.9,
            "category": "fact",
            "matchType": "fts"
          }
        ],
        "primer_fts": [],
        "primer_vector": [],
        "message_fts": [],
        "chunk_vector": [],
        "git_fts": [],
        "git_vector": [],
        "notes": []
      },
      "expected": [
        "memory:1",
        "memory:9"
      ]
    }
  },
  "rerank": {
    "pool": [
      {
        "source": "memory",
        "memoryId": 7,
        "content": "memory 7",
        "score": 0.9,
        "category": "fact",
        "matchType": "fts"
      },
      {
        "source": "memory",
        "memoryId": 1,
        "content": "memory 1",
        "score": 0.9,
        "category": "fact",
        "matchType": "fts"
      },
      {
        "source": "memory",
        "memoryId": 9,
        "content": "memory 9",
        "score": 0.9,
        "category": "fact",
        "matchType": "fts"
      }
    ],
    "baseline": [
      {
        "source": "memory",
        "memoryId": 42,
        "content": "memory 42",
        "score": 0.9,
        "category": "fact",
        "matchType": "fts"
      },
      {
        "source": "memory",
        "memoryId": 43,
        "content": "memory 43",
        "score": 0.9,
        "category": "fact",
        "matchType": "fts"
      }
    ],
    "expected": [
      "memory:1",
      "memory:9"
    ],
    "equal": [
      "memory:7",
      "memory:1",
      "memory:9"
    ],
    "calls": [
      [
        "synapse",
        "rerank.score",
        {
          "model": "gte-reranker-modernbert-base-f32",
          "query": "how does memory retrieval work?",
          "candidates": [
            "seven",
            "one",
            "nine"
          ],
          "required_fingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "allow_equivalent": false,
          "accept_declared": false,
          "max_queue_ms": 100,
          "deadline_ms": 1500
        },
        {
          "timeoutMs": 1500,
          "targetKind": "management_surface",
          "identity": {
            "project_root": "/fixture/project",
            "harness": "magic-context",
            "session": "s"
          }
        }
      ]
    ],
    "fallback": [
      [
        "memory:42",
        "memory:43"
      ],
      [
        "memory:42",
        "memory:43"
      ],
      [
        "memory:42",
        "memory:43"
      ],
      [
        "memory:42",
        "memory:43"
      ],
      [
        "memory:42",
        "memory:43"
      ],
      [
        "memory:42",
        "memory:43"
      ],
      [
        "memory:42",
        "memory:43"
      ]
    ]
  },
  "candidateTexts": [
    {
      "args": [
        "location\nline",
        "title\nline",
        "body"
      ],
      "expected": "location line\ntitle line\nbody"
    },
    {
      "args": [
        "日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語",
        "🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂",
        "éééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééé"
      ],
      "expected": "日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語\n🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂\néééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééé"
    }
  ],
  "probeRanking": {
    "input": {
      "corpus": 1000,
      "rowLimit": 10,
      "limit": 4,
      "base": [
        {
          "messageId": "base",
          "messageOrdinal": 4,
          "content": "b",
          "role": "assistant"
        },
        {
          "messageId": "overlap",
          "messageOrdinal": 3,
          "content": "/ctx-status common_name",
          "role": "assistant"
        }
      ],
      "probes": [
        {
          "probe": "/ctx-status",
          "df": 1,
          "rows": [
            {
              "messageId": "rare",
              "messageOrdinal": 1,
              "content": "/ctx-status",
              "role": "user"
            },
            {
              "messageId": "overlap",
              "messageOrdinal": 3,
              "content": "/ctx-status common_name",
              "role": "assistant"
            }
          ]
        },
        {
          "probe": "common_name",
          "df": 800,
          "rows": [
            {
              "messageId": "common",
              "messageOrdinal": 2,
              "content": "common_name",
              "role": "assistant"
            }
          ]
        }
      ]
    },
    "expected": [
      {
        "source": "message",
        "content": "/ctx-status common_name",
        "score": 1,
        "messageOrdinal": 3,
        "messageId": "overlap",
        "role": "assistant"
      },
      {
        "source": "message",
        "content": "/ctx-status",
        "score": 0.75,
        "messageOrdinal": 1,
        "messageId": "rare",
        "role": "user"
      },
      {
        "source": "message",
        "content": "b",
        "score": 0.5,
        "messageOrdinal": 4,
        "messageId": "base",
        "role": "assistant"
      },
      {
        "source": "message",
        "content": "common_name",
        "score": 0.25,
        "messageOrdinal": 2,
        "messageId": "common",
        "role": "assistant"
      }
    ]
  }
}"####;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scores_use_binary_to_fixed_rounding() {
        for (input, expected) in [
            (0.125, "0.13"),
            (0.615, "0.61"),
            (0.145, "0.14"),
            (1.0, "1.00"),
            (0.0, "0.00"),
        ] {
            assert_eq!(reported_score(input), expected);
        }
    }

    #[test]
    fn previews_use_ecmascript_whitespace_and_utf16_lengths() {
        assert_eq!(preview("\u{feff}a \n b\u{feff}"), "a b");
        assert_eq!(preview(&"🙂".repeat(110)), "🙂".repeat(110));
        assert_eq!(cosine_score(&[0.0], &[1.0]), 0.0);
        assert_eq!(cosine_score(&[1.0], &[-1.0]), 0.0);
        assert_eq!(cosine_score(&[f32::NAN], &[1.0]), 0.0);
    }
}

#[cfg(test)]
mod campaign_3a {
    use super::*;
    use std::sync::Mutex;

    fn fixture() -> Value {
        serde_json::from_str(FROZEN_SEARCH).unwrap()
    }

    fn candidate(row: &Value) -> SearchCandidate {
        let (source, id) = match row["source"].as_str().unwrap() {
            "memory" => (RetrievalSource::Memory, &row["memoryId"]),
            "primer" => (RetrievalSource::Primer, &row["primerId"]),
            "message" => (RetrievalSource::RawMessage, &row["messageId"]),
            "compartment" => (RetrievalSource::Compartment, &row["compartmentId"]),
            "git_commit" => (RetrievalSource::GitCommit, &row["sha"]),
            "note" => (RetrievalSource::Note, &row["noteId"]),
            _ => panic!("unknown frozen TS source"),
        };
        let id = id
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| id.to_string());
        SearchCandidate {
            hit: serde_json::from_value(json!({"source":source,"source_id":id,"provenance":{
                "origin":"core","source_id":id,"source_revision":"282d9c08bce4","content_hash":"fixture","generation":0,"observed_at_ms":0
            },"ordinal":row.get("messageOrdinal").map(|o| json!({"value":o,"base":"one"})),"score":row.get("score").cloned().unwrap_or(json!(0.0)),"text":row["content"]})).unwrap(),
            compartment_range: row["startOrdinal"].as_u64().zip(row["endOrdinal"].as_u64()),
        }
    }
    fn candidates(rows: &Value) -> Vec<SearchCandidate> {
        rows.as_array().unwrap().iter().map(candidate).collect()
    }
    fn keys(pool: &[SearchCandidate]) -> Value {
        json!(pool
            .iter()
            .map(|c| format!(
                "{}:{}",
                match c.hit.source {
                    RetrievalSource::RawMessage => "message",
                    RetrievalSource::Memory => "memory",
                    RetrievalSource::Compartment => "compartment",
                    RetrievalSource::Primer => "primer",
                    RetrievalSource::Note => "note",
                    RetrievalSource::GitCommit => "git_commit",
                },
                c.hit.source_id
            ))
            .collect::<Vec<_>>())
    }
    fn lanes_from_ts(rows: &Value) -> SearchLanes {
        SearchLanes {
            memory_fts: candidates(&rows["memory_fts"]),
            memory_vector: candidates(&rows["memory_vector"]),
            primer_fts: candidates(&rows["primer_fts"]),
            primer_vector: candidates(&rows["primer_vector"]),
            message_fts: candidates(&rows["message_fts"]),
            chunk_vector: candidates(&rows["chunk_vector"]),
            git_fts: candidates(&rows["git_fts"]),
            git_vector: candidates(&rows["git_vector"]),
            notes: candidates(&rows["notes"]),
        }
    }

    #[test]
    fn literal_probes_match_frozen_ts() {
        for vector in fixture()["probes"].as_array().unwrap() {
            let query = vector["query"].as_str().unwrap();
            assert_eq!(
                json!(literal_probes(RetrievalIntent::Explicit, query)),
                vector["expected"],
                "{query}"
            );
        }
        assert!(contains_probe_verbatim(
            "The /CTX-STATUS command",
            &["/ctx-status".into()]
        ));
        assert!(!contains_probe_verbatim(
            "a paraphrase",
            &["/ctx-status".into()]
        ));
    }

    #[test]
    fn prose_gate_matches_frozen_ts() {
        for vector in fixture()["prose"].as_array().unwrap() {
            assert_eq!(
                json!(is_prose_query(vector["query"].as_str().unwrap())),
                vector["expected"],
                "{}",
                vector["query"]
            );
        }
    }

    #[test]
    fn probe_rank_fusion_matches_frozen_ts() {
        let f = fixture();
        let input = &f["probeRanking"]["input"];
        let baseline: Vec<_> = input["base"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| {
                let mut r = r.clone();
                r["source"] = json!("message");
                candidate(&r).hit
            })
            .collect();
        let probes: Vec<_> = input["probes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| ProbeMatches {
                probe: p["probe"].as_str().unwrap().into(),
                document_frequency: p["df"].as_u64().unwrap() as usize,
                hits: p["rows"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|r| {
                        let mut r = r.clone();
                        r["source"] = json!("message");
                        candidate(&r).hit
                    })
                    .collect(),
            })
            .collect();
        let actual = rank_message_probes(
            &baseline,
            &probes,
            input["corpus"].as_u64().unwrap() as usize,
            input["rowLimit"].as_u64().unwrap() as usize,
            input["limit"].as_u64().unwrap() as usize,
        );
        let expected = f["probeRanking"]["expected"].as_array().unwrap();
        assert_eq!(actual.len(), expected.len());
        for (actual, expected) in actual.iter().zip(expected) {
            assert_eq!(actual.source_id, expected["messageId"]);
            assert_eq!(actual.text, expected["content"]);
            assert_eq!(
                actual.ordinal.unwrap().value,
                expected["messageOrdinal"].as_u64().unwrap()
            );
            assert_eq!(actual.score, expected["score"].as_f64().unwrap());
        }
    }

    #[test]
    fn lane_fusion_matches_frozen_ts() {
        let f = fixture();
        let mut lanes = lanes_from_ts(&f["fusion"]["lanes"]);
        for name in ["laneLimit", "dedup"] {
            assert_eq!(
                keys(&fuse_search_lanes(&lanes_from_ts(
                    &f["fusion"][name]["lanes"]
                ))),
                f["fusion"][name]["expected"],
                "{name}"
            );
        }
        assert_eq!(keys(&fuse_search_lanes(&lanes)), f["fusion"]["expected"]);
        // Each hit retains the first lane's full payload, not an RRF score.
        let fused = fuse_search_lanes(&lanes);
        assert_eq!(
            fused.iter().find(|c| c.hit.source_id == "1").unwrap(),
            &lanes.memory_fts[1]
        );
        lanes = SearchLanes::default();
        lanes.notes = (0..30)
            .map(|id| {
                candidate(
                    &json!({"source":"note","noteId":id,"content":format!("n{id}"),"score":1}),
                )
            })
            .collect();
        assert_eq!(
            keys(&fuse_search_lanes(&lanes)),
            f["fusion"]["cappedExpected"]
        );
    }

    #[test]
    fn candidate_text_matches_frozen_ts_byte_caps() {
        for row in fixture()["candidateTexts"].as_array().unwrap() {
            let a = &row["args"];
            let actual = candidate_text(
                a[0].as_str().unwrap(),
                a[1].as_str().unwrap(),
                a[2].as_str().unwrap(),
            );
            assert_eq!(actual, row["expected"]);
            assert!(actual.len() <= 1024);
        }
    }

    struct FakeClient {
        response: Result<Value, String>,
        calls: Mutex<Vec<Value>>,
        hang: bool,
    }
    #[async_trait]
    impl RerankClient for FakeClient {
        async fn call(
            &self,
            module: &str,
            method: &str,
            params: Value,
            options: RerankCallOptions,
        ) -> Result<Value, String> {
            self.calls
                .lock()
                .unwrap()
                .push(json!([module, method, params, options]));
            if self.hang {
                std::future::pending::<()>().await;
            }
            self.response.clone()
        }
    }
    fn fake(response: Result<Value, String>) -> FakeClient {
        FakeClient {
            response,
            calls: Mutex::default(),
            hang: false,
        }
    }
    fn session(client: &dyn RerankClient) -> RerankSession<'_> {
        RerankSession {
            client,
            lane: PinnedReranker {
                fingerprint: "a".repeat(64),
                table_epoch: 6,
            },
            identity: RerankIdentity::new("/fixture/project".into(), "s".into()),
        }
    }
    fn texts() -> Vec<String> {
        ["seven", "one", "nine"]
            .into_iter()
            .map(str::to_owned)
            .collect()
    }

    #[tokio::test]
    async fn rerank_request_and_order_match_frozen_ts() {
        let f = fixture();
        let pool = candidates(&f["rerank"]["pool"]);
        let baseline = candidates(&f["rerank"]["baseline"]);
        let client = fake(Ok(
            json!({"result":{"fingerprint":"a".repeat(64),"table_epoch":6,"scores":[0.2,0.9,0.8]}}),
        ));
        let actual = rerank_search_results(
            RetrievalIntent::Explicit,
            Some(&session(&client)),
            "how does memory retrieval work?",
            &baseline,
            &pool,
            &texts(),
            2,
        )
        .await;
        assert_eq!(keys(&actual), f["rerank"]["expected"]);
        assert_eq!(
            client.calls.lock().unwrap().as_slice(),
            f["rerank"]["calls"].as_array().unwrap()
        );
    }

    #[tokio::test]
    async fn rerank_equal_scores_keep_pool_order() {
        let f = fixture();
        let pool = candidates(&f["rerank"]["pool"]);
        let baseline = candidates(&f["rerank"]["baseline"]);
        let client = fake(Ok(
            json!({"fingerprint":"a".repeat(64),"table_epoch":6,"scores":[0,-0.0,0]}),
        ));
        let actual = rerank_search_results(
            RetrievalIntent::Explicit,
            Some(&session(&client)),
            "query",
            &baseline,
            &pool,
            &texts(),
            3,
        )
        .await;
        assert_eq!(keys(&actual), f["rerank"]["equal"]);
        assert_eq!(actual, pool);
    }

    #[tokio::test]
    async fn rerank_failures_retain_entire_baseline() {
        let f = fixture();
        let pool = candidates(&f["rerank"]["pool"]);
        let baseline = candidates(&f["rerank"]["baseline"]);
        let valid = json!({"fingerprint":"a".repeat(64),"table_epoch":6,"scores":[1,2,3]});
        let mut responses = vec![
            Err("missing Synapse".into()),
            Ok(Value::Null),
            Ok(json!({"error":{"code":"busy"}})),
            Ok(json!({"fingerprint":"b".repeat(64),"table_epoch":6,"scores":[1,2,3]})),
            Ok(json!({"fingerprint":"a".repeat(64),"table_epoch":7,"scores":[1,2,3]})),
        ];
        for scores in [
            json!([1, 2]),
            json!([1, 2, "3"]),
            json!([1, null, 3]),
            json!([1, {}, 3]),
            json!("not an array"),
        ] {
            let mut body = valid.clone();
            body["scores"] = scores;
            responses.push(Ok(body));
        }
        for response in responses {
            let client = fake(response);
            assert_eq!(
                rerank_search_results(
                    RetrievalIntent::Explicit,
                    Some(&session(&client)),
                    "query",
                    &baseline,
                    &pool,
                    &texts(),
                    1
                )
                .await,
                baseline
            );
        }
        let client = fake(Ok(valid));
        assert_eq!(
            rerank_search_results(
                RetrievalIntent::Explicit,
                None,
                "query",
                &baseline,
                &pool,
                &texts(),
                1
            )
            .await,
            baseline
        );
        for (p, t) in [
            (Vec::new(), Vec::new()),
            (vec![pool[0].clone(); 21], vec!["a".into(); 21]),
            (pool.clone(), vec!["é".repeat(513); 3]),
            (pool.clone(), vec!["missing texts".into()]),
        ] {
            assert_eq!(
                rerank_search_results(
                    RetrievalIntent::Explicit,
                    Some(&session(&client)),
                    "query",
                    &baseline,
                    &p,
                    &t,
                    1
                )
                .await,
                baseline
            );
        }
        assert!(client.calls.lock().unwrap().is_empty());
        let mut client = fake(Ok(Value::Null));
        client.hang = true;
        assert_eq!(
            rerank_search_results(
                RetrievalIntent::Explicit,
                Some(&session(&client)),
                "query",
                &baseline,
                &pool,
                &texts(),
                1
            )
            .await,
            baseline
        );
    }

    #[tokio::test]
    async fn auto_and_auto_hint_skip_probes_and_rerank() {
        let f = fixture();
        let pool = candidates(&f["rerank"]["pool"]);
        let baseline = candidates(&f["rerank"]["baseline"]);
        let client = fake(Err("must never be called".into()));
        for query in [
            "how does memory retrieval work?",
            "why did /ctx-status calls inflate",
        ] {
            assert!(literal_probes(RetrievalIntent::Auto, query).is_empty());
            assert!(prepare_reranker(
                RetrievalIntent::Auto,
                query,
                Some(&client),
                &session(&client).identity
            )
            .await
            .is_none());
            assert_eq!(
                rerank_search_results(
                    RetrievalIntent::Auto,
                    Some(&session(&client)),
                    query,
                    &baseline,
                    &pool,
                    &texts(),
                    1
                )
                .await,
                baseline
            );
        }
        assert!(client.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn catalog_pin_and_discovery_validate_certified_lane() {
        let catalog = json!({"result":{"table_epoch":6,"models":[{"model_id":RERANK_MODEL,"certified":true,"fingerprints":["a".repeat(64)]}]}});
        let client = fake(Ok(catalog.clone()));
        let identity = session(&client).identity;
        assert_eq!(
            prepare_reranker(
                RetrievalIntent::Explicit,
                "how does memory retrieval work?",
                Some(&client),
                &identity
            )
            .await,
            Some(session(&client).lane)
        );
        assert_eq!(
            *client.calls.lock().unwrap(),
            vec![
                json!(["synapse","models.list",{},{"timeoutMs":1500,"targetKind":"management_surface","identity":identity}])
            ]
        );
        for (field, value) in [
            ("certified", json!(false)),
            ("fingerprints", json!(["a".repeat(64), "b".repeat(64)])),
            ("fingerprints", json!(["A".repeat(64)])),
        ] {
            let mut body = catalog.clone();
            body["result"]["models"][0][field] = value;
            assert!(pin_reranker(&body).is_none());
        }
        let mut body = catalog;
        body["result"]["table_epoch"] = json!(9007199254740992_i64);
        assert!(pin_reranker(&body).is_none());
    }
}
