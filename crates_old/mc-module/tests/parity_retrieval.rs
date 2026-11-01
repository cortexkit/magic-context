//! Compare Rust retrieval results with captured TypeScript searches and prompt visibility.

use mc_module::memory_tool::{self, SearchQueryVector, SupportedSearchOptions};
use mc_module::parity_contract::*;
use mc_module::retrieval::{compartments::CompartmentChunk, hybrid::*};
use rusqlite::{params, Connection, OpenFlags};
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeSet;

#[derive(Deserialize)]
struct Fixture {
    now: i64,
    project: String,
    session: String,
    model: String,
    visible: Vec<i64>,
    baseline: i64,
    delta: i64,
    stale: i64,
    m0: String,
    m1: String,
    cases: Vec<Case>,
}
#[derive(Deserialize)]
struct Case {
    name: String,
    query: String,
    options: SupportedSearchOptions,
    model: String,
    vector: Option<Vec<f32>>,
    visibility: bool,
    results: Vec<Value>,
    reported_scores: Vec<String>,
    suppressed_visible_memory_ids: Vec<i64>,
}

fn fixture() -> Fixture {
    serde_json::from_str(include_str!("../testdata/parity_retrieval/golden.json")).unwrap()
}
fn identity(model: &str) -> EmbeddingIdentity {
    EmbeddingIdentity {
        provider: "fixture".into(),
        model: model.into(),
        dimensions: 3,
        query_recipe: "fixture-query".into(),
        passage_recipe: "fixture-passage".into(),
        fingerprint: "fixture-identity".into(),
        epoch: 1,
    }
}
fn scope(f: &Fixture) -> StoreScope {
    StoreScope {
        project: ProjectId(f.project.clone()),
        session: SessionId(f.session.clone()),
        generation: Generation(1),
    }
}

struct TsStore {
    conn: std::sync::Mutex<Connection>,
    now: i64,
    visibility: bool,
    _root: tempfile::TempDir,
}
impl TsStore {
    fn open(f: &Fixture, visibility: bool) -> Self {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("context.db");
        std::fs::write(
            &path,
            include_bytes!("../testdata/parity_retrieval/context.db"),
        )
        .unwrap();
        let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        Self {
            conn: std::sync::Mutex::new(conn),
            now: f.now,
            visibility,
            _root: root,
        }
    }
    fn memory_filter(&self, scope: &StoreScope) -> (String, Vec<rusqlite::types::Value>) {
        let conn = self.conn.lock().unwrap();
        let workspace: Option<i64> = conn
            .query_row(
                "SELECT workspace_id FROM workspace_members WHERE project_path=?",
                [&scope.project.0],
                |r| r.get(0),
            )
            .ok();
        let mut identities = vec![scope.project.0.clone()];
        let mut categories = Vec::<String>::new();
        if let Some(workspace) = workspace {
            identities = conn.prepare("SELECT project_path FROM workspace_members WHERE workspace_id=? ORDER BY project_path")
                .unwrap().query_map([workspace], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
            let json: String = conn
                .query_row(
                    "SELECT share_categories FROM workspaces WHERE id=?",
                    [workspace],
                    |r| r.get(0),
                )
                .unwrap();
            categories = serde_json::from_str(&json).unwrap();
        }
        let placeholders = |n: usize| vec!["?"; n].join(",");
        let mut binds: Vec<_> = identities
            .iter()
            .cloned()
            .map(rusqlite::types::Value::Text)
            .collect();
        let sharing = if workspace.is_some() {
            binds.push(scope.project.0.clone().into());
            binds.extend(categories.iter().cloned().map(rusqlite::types::Value::Text));
            format!("AND (memories.project_path=? OR (memories.category IN ({}) AND memories.shareable=1 AND memories.scope IN ('project','ecosystem','universe')))", placeholders(categories.len()))
        } else {
            String::new()
        };
        (format!("memories.project_path IN ({}) {sharing} AND memories.status IN ('active','permanent') AND (memories.expires_at IS NULL OR memories.expires_at > ?)", placeholders(identities.len())), { binds.push(self.now.into()); binds })
    }
    fn filtered_sql(
        &self,
        scope: &StoreScope,
        dates: DateBounds,
    ) -> (String, Vec<rusqlite::types::Value>) {
        let (filter, mut binds) = self.memory_filter(scope);
        binds.push(dates.from_ms.unwrap_or(-9_007_199_254_740_991).into());
        binds.push(dates.to_ms.unwrap_or(9_007_199_254_740_991).into());
        (
            format!("{filter} AND memories.created_at BETWEEN ? AND ?"),
            binds,
        )
    }
}
fn available<T>(value: T) -> CapabilityResult<T> {
    CapabilityResult::Available { value }
}
fn decode_vector(blob: Vec<u8>) -> Vec<f32> {
    assert_eq!(blob.len() % 4, 0);
    blob.as_chunks::<4>()
        .0
        .iter()
        .map(|b| f32::from_le_bytes(*b))
        .collect()
}

impl RetrievalInputStore for TsStore {
    fn read_search_memories(
        &self,
        scope: &StoreScope,
        dates: DateBounds,
    ) -> CapabilityResult<Vec<SearchMemory>> {
        let (filter, binds) = self.filtered_sql(scope, dates);
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!("SELECT memories.id, memories.category, memories.content, memories.created_at, CASE WHEN memories.project_path=? THEN NULL ELSE workspace_members.display_name END FROM memories LEFT JOIN workspace_members ON workspace_members.project_path=memories.project_path WHERE {filter} ORDER BY memories.id")).unwrap();
        let binds = std::iter::once(scope.project.0.clone().into())
            .chain(binds)
            .collect::<Vec<rusqlite::types::Value>>();
        available(
            stmt.query_map(rusqlite::params_from_iter(binds), |r| {
                Ok(SearchMemory {
                    id: r.get(0)?,
                    category: r.get(1)?,
                    content: r.get(2)?,
                    created_at_ms: r.get(3)?,
                    source_name: r.get(4)?,
                })
            })
            .unwrap()
            .map(Result::unwrap)
            .collect(),
        )
    }
    fn search_memory_fts(
        &self,
        scope: &StoreScope,
        query: &str,
        dates: DateBounds,
        limit: usize,
    ) -> CapabilityResult<Vec<MemoryFtsHit>> {
        let run = |query: &str| {
            let (filter, mut binds) = self.filtered_sql(scope, dates);
            let conn = self.conn.lock().unwrap();
            binds.push(query.to_string().into());
            binds.push((limit as i64).into());
            let mut stmt = conn.prepare(&format!("SELECT memories.id, bm25(memories_fts) FROM memories_fts INNER JOIN memories ON memories.id=memories_fts.rowid WHERE {filter} AND memories_fts MATCH ? ORDER BY bm25(memories_fts), memories.updated_at DESC, memories.id ASC LIMIT ?")).unwrap();
            stmt.query_map(rusqlite::params_from_iter(binds), |r| {
                Ok(MemoryFtsHit {
                    memory_id: r.get(0)?,
                    bm25: r.get(1)?,
                })
            })
            .unwrap()
            .map(Result::unwrap)
            .collect::<Vec<_>>()
        };
        let quote = |s: &str| format!("\"{}\"", s.replace('"', "\"\""));
        let sanitized = query
            .replace('\0', " ")
            .split_whitespace()
            .map(quote)
            .collect::<Vec<_>>()
            .join(" ");
        if sanitized.is_empty() {
            return available(Vec::new());
        }
        let mut hits = run(&sanitized);
        if hits.is_empty() {
            let mut seen = BTreeSet::new();
            let token = regex::Regex::new(r"[\p{L}\p{N}_]+").unwrap();
            let relaxed = token
                .find_iter(query)
                .map(|m| m.as_str())
                .filter(|s| seen.insert(s.to_string()))
                .filter(|s| s.encode_utf16().count() > 2 || s.chars().any(|c| c.is_ascii_digit()))
                .take(16)
                .map(quote)
                .collect::<Vec<_>>()
                .join(" OR ");
            if !relaxed.is_empty() && relaxed != sanitized {
                hits = run(&relaxed);
            }
        }
        available(hits)
    }
    fn read_memory_vectors(
        &self,
        _: &StoreScope,
        memory_ids: &[i64],
        identity: &EmbeddingIdentity,
    ) -> CapabilityResult<Vec<MemoryVector>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT memory_id, embedding FROM memory_embeddings WHERE model_id=? ORDER BY memory_id").unwrap();
        available(
            stmt.query_map([&identity.model], |r| {
                Ok(MemoryVector {
                    memory_id: r.get(0)?,
                    identity: identity.clone(),
                    values: decode_vector(r.get(1)?),
                })
            })
            .unwrap()
            .map(Result::unwrap)
            .filter(|v| memory_ids.contains(&v.memory_id))
            .collect(),
        )
    }
    fn read_compartment_chunks(
        &self,
        scope: &StoreScope,
        _: DateBounds,
        identity: &EmbeddingIdentity,
    ) -> CapabilityResult<Vec<CompartmentChunk>> {
        // Date bounds overlap the times of a compartment's first and last
        // messages. These persisted message times, not the date a summary was
        // written, determine which conversation interval is searched.
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT e.compartment_id, e.session_id, e.project_path, c.title, c.start_message, c.end_message, start_map.message_time_ms, end_map.message_time_ms, e.vector FROM compartment_chunk_embeddings e JOIN compartments c ON c.id=e.compartment_id LEFT JOIN message_fts_rowid_map start_map ON start_map.session_id=c.session_id AND start_map.message_ordinal=c.start_message LEFT JOIN message_fts_rowid_map end_map ON end_map.session_id=c.session_id AND end_map.message_ordinal=c.end_message WHERE e.session_id=? AND e.project_path=? AND e.model_id=? ORDER BY e.compartment_id ASC, e.window_index ASC").unwrap();
        available(
            stmt.query_map(
                params![scope.session.0, scope.project.0, identity.model],
                |r| {
                    Ok(CompartmentChunk {
                        compartment_id: r.get(0)?,
                        session_id: r.get(1)?,
                        project_path: r.get(2)?,
                        title: r.get(3)?,
                        start_ordinal: r.get(4)?,
                        end_ordinal: r.get(5)?,
                        start_time_ms: r.get(6)?,
                        end_time_ms: r.get(7)?,
                        identity: identity.clone(),
                        values: decode_vector(r.get(8)?),
                    })
                },
            )
            .unwrap()
            .map(Result::unwrap)
            .collect(),
        )
    }
    fn read_visible_memory_ids(&self, scope: &StoreScope) -> CapabilityResult<BTreeSet<i64>> {
        if !self.visibility {
            return available(BTreeSet::new());
        }
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT a.memory_id, a.projected_metadata_json FROM memory_applied_rows a JOIN memories m ON m.id=a.memory_id AND m.content=a.projected_text WHERE a.session_id=? AND a.harness='opencode' AND m.status!='archived'").unwrap();
        let ids = stmt
            .query_map([&scope.session.0], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            })
            .unwrap()
            .map(Result::unwrap)
            .filter_map(|(id, metadata)| {
                let metadata: Value = serde_json::from_str(&metadata).unwrap();
                metadata["representations"]
                    .as_array()
                    .is_some_and(|values| values.iter().any(|v| v == "text" || v == "delta"))
                    .then_some(id)
            })
            .collect();
        available(ids)
    }
}

#[test]
fn typescript_memory_and_compartment_parity() {
    let f = fixture();
    assert!(f.m0.contains("baseline already rendered"));
    assert!(f.m1.contains("delta already rendered"));
    assert!(f.visible.contains(&f.baseline) && f.visible.contains(&f.delta));
    assert!(!f.visible.contains(&f.stale));
    assert_eq!(f.cases.len(), 20);
    for case in &f.cases {
        let store = TsStore::open(&f, case.visibility);
        let query = case.vector.clone().map(|values| SearchQueryVector {
            identity: identity(&case.model),
            values,
        });
        let outcome = memory_tool::search_retrieval_inputs(
            &store,
            &scope(&f),
            &case.query,
            &case.options,
            query.as_ref(),
        );
        assert_eq!(
            outcome.diagnostics.suppressed_visible_memory_ids, case.suppressed_visible_memory_ids,
            "{} visibility",
            case.name
        );
        assert_eq!(
            outcome.results.len(),
            case.results.len(),
            "{} candidate set",
            case.name
        );
        for (index, (actual, expected)) in outcome.results.iter().zip(&case.results).enumerate() {
            assert_eq!(
                actual.reported_score(),
                case.reported_scores[index],
                "{} score at {index}",
                case.name
            );
            assert!(
                (actual.score() - expected["score"].as_f64().unwrap()).abs() < 1e-12,
                "{} raw score",
                case.name
            );
            let mut actual = serde_json::to_value(actual).unwrap();
            let mut expected = expected.clone();
            actual.as_object_mut().unwrap().remove("score");
            expected.as_object_mut().unwrap().remove("score");
            assert_eq!(actual, expected, "{} item at {index}", case.name);
        }
    }
    println!("Compared 20 production TypeScript cases, including persisted FTS5, float32 vectors and m[0]/m[1] visibility");
}

#[test]
fn unsupported_sources_are_unavailable_not_empty_success() {
    let f = fixture();
    let store = TsStore::open(&f, true);
    let outcome = memory_tool::search_retrieval_inputs(
        &store,
        &scope(&f),
        "queue",
        &SupportedSearchOptions::default(),
        None,
    );
    for component in [
        "raw_message",
        "git_commit",
        "primer",
        "note",
        "query_embedding",
        "compartment_vectors",
    ] {
        assert!(
            matches!(
                outcome.diagnostics.components.get(component),
                Some(Availability::Unavailable { .. })
            ),
            "{component}"
        );
    }
    assert!(
        !outcome.results.is_empty(),
        "Missing vectors must not disable lexical memory recall"
    );
}

#[test]
fn search_limits_match_typescript_defaults_and_clamps() {
    let mut options = SupportedSearchOptions::default();
    assert_eq!(options.limit(), 10);
    for (input, expected) in [
        (f64::NAN, 10),
        (f64::INFINITY, 10),
        (-1.0, 1),
        (0.0, 1),
        (2.9, 2),
        (10000.0, 25),
    ] {
        options.limit = Some(input);
        assert_eq!(options.limit(), expected);
    }
}

#[test]
fn legacy_store_search_diagnoses_missing_bm25_and_vectors() {
    use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
    let root = tempfile::tempdir().unwrap();
    let store = mc_store::McStore::open_for_test(&StorageDescriptor {
        module_id: "retrieval-parity".into(),
        storage_namespace: "mc_cache".into(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: root.path().join("store.db").to_string_lossy().into(),
        },
    })
    .unwrap();
    let outcome = memory_tool::search_available_corpora_for_session_with_diagnostics(
        &store,
        "project",
        "session",
        "queue",
        memory_tool::MemorySearchOptions {
            limit: 10,
            include_memories: true,
            include_messages: true,
            include_notes: false,
            excluded_memory_ids: &BTreeSet::new(),
            from_ms: None,
            to_ms: None,
        },
    )
    .unwrap();
    for component in ["memory", "compartment"] {
        assert!(
            matches!(outcome.diagnostics.source_availability.get(component), Some(Availability::Degraded { reason }) if reason.code == "literal_only")
        );
    }
    assert!(matches!(
        outcome.diagnostics.source_availability.get("raw_message"),
        Some(Availability::Unavailable { .. })
    ));
}

struct TestProvider {
    identity: EmbeddingIdentity,
    mode: &'static str,
    calls: std::sync::atomic::AtomicUsize,
}
impl EmbeddingProvider for TestProvider {
    fn availability(&self) -> Availability {
        Availability::Available
    }
    fn embed<'a>(
        &'a self,
        context: &'a RequestContext,
        request: &'a EmbeddingRequest,
    ) -> CallbackFuture<'a, EmbeddingResult> {
        Box::pin(async move {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            assert_eq!(request.kind, EmbeddingInputKind::Query);
            assert_eq!(request.inputs.len(), 1);
            assert_eq!(request.inputs[0].text, "queue");
            match self.mode {
                "unavailable" => CapabilityResult::unavailable("fake_provider"),
                "cancelled" => {
                    context.control.cancel();
                    CapabilityResult::unavailable("fake_provider")
                }
                _ => available(EmbeddingResult {
                    identity: self.identity.clone(),
                    generation: Generation(if self.mode == "stale" { 6 } else { 7 }),
                    vectors: vec![mc_store::parity_schema_manifest::StoredVector {
                        source: request.inputs[0].source.clone(),
                        embedding: self.identity.clone(),
                        values: vec![1.0, 0.0, 0.0],
                    }],
                }),
            }
        })
    }
}

#[tokio::test]
async fn provider_query_is_shared_and_failure_preserves_lexical_recall() {
    let f = fixture();
    let store = TsStore::open(&f, false);
    let options = SupportedSearchOptions {
        sources: Some(vec![
            memory_tool::SearchSource::Memory,
            memory_tool::SearchSource::Message,
        ]),
        ..Default::default()
    };
    for mode in ["available", "unavailable", "stale", "cancelled"] {
        let provider = TestProvider {
            identity: identity(&f.model),
            mode,
            calls: Default::default(),
        };
        let context = RequestContext {
            contract_version: PARITY_CONTRACT_VERSION,
            route: RouteIdentity::from_authenticated_route(scope(&f), InputOrigin::Broca),
            invocation: InvocationId("query".into()),
            config_generation: Generation(7),
            control: CallbackControl::new(i64::MAX),
        };
        let result = memory_tool::search_retrieval_inputs_with_provider(
            &store,
            &provider,
            &context,
            " queue ",
            &options,
            &provider.identity,
        )
        .await;
        assert_eq!(provider.calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        match mode {
            "available" => {
                assert!(result
                    .results
                    .iter()
                    .any(|h| matches!(h, SearchHit::Memory(_))));
                assert!(result
                    .results
                    .iter()
                    .any(|h| matches!(h, SearchHit::Compartment(_))));
            }
            "cancelled" => assert!(result.results.is_empty()),
            _ => {
                assert!(!result.results.is_empty());
                assert!(result
                    .results
                    .iter()
                    .all(|h| matches!(h, SearchHit::Memory(m) if m.match_type == MatchType::Fts)));
                assert_ne!(
                    result.diagnostics.components["query_embedding"],
                    Availability::Available
                );
            }
        }
    }
}
