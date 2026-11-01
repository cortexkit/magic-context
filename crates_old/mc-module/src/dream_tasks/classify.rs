//! Non-served classify/map tasks over a project snapshot, using the Dreamer runner.
//!
//! The caller supplies activation captured at task start and a model-completion
//! carrier running away from the serving thread. The host adapter checks paths
//! and commits metadata updates. It must release store locks before model calls
//! and must not increment cache epochs: background results appear at a natural rebuild.

use std::{collections::HashSet, path::Path, time::Duration};

use mc_store::{ClassificationUpdate, MappingUpdate};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    config::McModuleConfig,
    dream_runner::{self, DreamCarrier, DreamRequest, DreamRole},
};

pub const CLASSIFY_TASK: &str = "classify-memories";
pub const MAP_TASK: &str = "map-memories";
pub const MAP_BATCH_FLOOR_MS: u64 = 240_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
/// One active memory from the caller's project-scoped snapshot. Selection flags
/// come from classification markers, open historian items and mapping sentinels;
/// the task never widens that snapshot by reading another session or project.
pub struct Memory {
    pub id: i64,
    pub category: String,
    pub content: String,
    pub normalized_hash: String,
    pub importance: Option<i32>,
    pub scope: Option<String>,
    pub shareable: bool,
    pub unclassified: bool,
    pub open_classification: bool,
    pub unmapped: bool,
    pub has_sentinel: bool,
    pub files: Vec<String>,
    pub mapping_origin: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Classification {
    pub id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub importance: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shareable: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Mapping {
    pub id: i64,
    pub files: Vec<String>,
    pub independent: bool,
}

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("fixed Dreamer regex")
}

fn describe_shape(text: &str, root: &str) -> String {
    let expected = format!("expected <{root}> with <memory> entries");
    let json = |s: &str| {
        if s.starts_with('[') {
            Some("array")
        } else if s.starts_with('{') {
            Some("object")
        } else {
            None
        }
    };
    let text = text.trim();
    if let Some(kind) = json(text) {
        return format!("JSON {kind} unrecognized; {expected}");
    }
    let tag = re(r"<([A-Za-z][A-Za-z0-9_:-]*)\b");
    if let Some(c) = tag.captures(text) {
        if !c[1].eq_ignore_ascii_case(root) {
            return format!("root <{}> unrecognized; {expected}", &c[1]);
        }
    }
    let root_re = re(&format!(r"(?is)<{root}\b[^>]*>(.*?)</{root}>"));
    let body = root_re
        .captures(text)
        .map(|c| c[1].trim().to_owned())
        .unwrap_or_default();
    if let Some(kind) = json(&body) {
        return format!("JSON {kind} unrecognized; {expected}");
    }
    if let Some(c) = tag.captures(&body) {
        if !c[1].eq_ignore_ascii_case("memory") {
            return format!("root <{}> unrecognized; {expected}", &c[1]);
        }
    }
    format!("parsed zero entries; {expected}")
}

fn body(text: &str, root: &str) -> Result<String, String> {
    if let Some(c) = re(&format!(r"(?is)<{root}\b[^>]*>(.*?)</{root}>")).captures(text) {
        return Ok(c[1].to_owned());
    }
    let described = describe_shape(text, root);
    if !described.starts_with("parsed zero entries") {
        return Err(described);
    }
    if re(&format!(r"(?i)<{root}\b")).is_match(text)
        && !re(&format!(r"(?i)</{root}>")).is_match(text)
    {
        Err(format!("{root} manifest missing closing root tag"))
    } else {
        Err(format!("{root} manifest missing complete root element"))
    }
}

fn attr(attrs: &str, name: &str, value: &str, insensitive: bool) -> Option<String> {
    re(&format!(
        r#"{}\b{name}\s*=\s*"({value})""#,
        if insensitive { "(?i)" } else { "" }
    ))
    .captures(attrs)
    .map(|c| c[1].to_owned())
}

fn unique(ids: impl IntoIterator<Item = i64>, root: &str) -> Result<(), String> {
    let mut seen = HashSet::new();
    for id in ids {
        if !seen.insert(id) {
            return Err(format!("{root} manifest contains duplicate id {id}"));
        }
    }
    Ok(())
}

pub fn parse_classify_manifest(text: &str) -> Result<Vec<Classification>, String> {
    let body = body(text, "classify")?;
    let mut out = Vec::new();
    for c in re(r"<memory\b([^>]*)/?>").captures_iter(&body) {
        let attrs = &c[1];
        let id = attr(attrs, "id", "[0-9]+", false)
            .and_then(|v| v.parse().ok())
            .ok_or("classify manifest entry missing numeric id")?;
        let importance = attr(attrs, "importance", "[0-9]+", false)
            .map(|v| v.parse::<f64>().unwrap_or(f64::INFINITY).clamp(1.0, 100.0) as i32);
        let scope = attr(attrs, "scope", "[a-z]+", true).map(|v| v.to_ascii_lowercase());
        if let Some(scope) = &scope {
            if !matches!(scope.as_str(), "project" | "ecosystem" | "universe") {
                return Err(format!("classify manifest invalid scope {scope}"));
            }
        }
        let shareable = attr(attrs, "shareable", "true|false|1|0", true)
            .map(|v| v.eq_ignore_ascii_case("true") || v == "1");
        if importance.is_none() && scope.is_none() && shareable.is_none() {
            return Err(format!(
                "classify manifest entry {id} missing classification fields"
            ));
        }
        out.push(Classification {
            id,
            importance,
            scope,
            shareable,
        });
    }
    if out.is_empty() && !body.trim().is_empty() {
        return Err(describe_shape(text, "classify"));
    }
    unique(out.iter().map(|v| v.id), "classify")?;
    Ok(out)
}

pub fn validate_classify_manifest(
    text: &str,
    expected: &[i64],
) -> Result<Vec<Classification>, String> {
    let out = parse_classify_manifest(text)?;
    if out.is_empty() && !expected.is_empty() {
        return Err(describe_shape(text, "classify"));
    }
    for v in &out {
        if !expected.contains(&v.id) {
            return Err(format!("classify manifest contains unknown id {}", v.id));
        }
    }
    for id in expected {
        if !out.iter().any(|v| v.id == *id) {
            return Err(format!("classify manifest missing id {id}"));
        }
    }
    Ok(out)
}

pub fn parse_map_manifest(text: &str) -> Result<Vec<Mapping>, String> {
    let body = body(text, "mappings")?;
    let mut out = Vec::new();
    for c in re(r"(?is)<memory\b([^>]*)(?:/>|>(.*?)</memory>)").captures_iter(&body) {
        let attrs = &c[1];
        let id = attr(attrs, "id", "[0-9]+", false)
            .and_then(|v| v.parse().ok())
            .ok_or("mappings manifest entry missing numeric id")?;
        let independent = attr(attrs, "independent", "true|1", true).is_some();
        let mut files: Vec<String> = attr(attrs, "files", r#"[^"]*"#, false)
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
            .collect();
        if files.is_empty() {
            for f in re(r"(?i)<file\b([^>]*)/?>").captures_iter(c.get(2).map_or("", |v| v.as_str()))
            {
                if let Some(path) = attr(&f[1], "path", r#"[^"]+"#, false) {
                    if !path.trim().is_empty() {
                        files.push(path.trim().into());
                    }
                }
            }
        }
        if !independent && files.is_empty() {
            return Err(format!(
                "mappings manifest entry {id} has neither files nor independent=\"true\""
            ));
        }
        out.push(Mapping {
            id,
            independent: independent && files.is_empty(),
            files,
        });
    }
    if out.is_empty() && !body.trim().is_empty() {
        return Err(describe_shape(text, "mappings"));
    }
    Ok(out)
}

pub fn validate_map_manifest(text: &str, expected: &[i64]) -> Result<Vec<Mapping>, String> {
    let out = parse_map_manifest(text)?;
    if out.is_empty() && !expected.is_empty() {
        return Err(describe_shape(text, "mappings"));
    }
    unique(
        out.iter()
            .filter(|v| expected.contains(&v.id))
            .map(|v| v.id),
        "mappings",
    )?;
    Ok(out)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ClassifyPlan {
    pub stage: u8,
    pub ids: Vec<i64>,
    pub anchors: Vec<i64>,
}

pub fn plan_classify(active: &[Memory]) -> ClassifyPlan {
    if active.len() < 10 {
        return ClassifyPlan {
            stage: 1,
            ids: vec![],
            anchors: vec![],
        };
    }
    let stage = if active.len() <= 100 { 2 } else { 3 };
    let ids = active
        .iter()
        .filter(|m| m.unclassified && !m.open_classification)
        .map(|m| m.id)
        .collect();
    let mut classified: Vec<_> = if stage == 3 {
        active.iter().filter(|m| !m.unclassified).collect()
    } else {
        vec![]
    };
    if classified.len() > 30 {
        classified.sort_by_key(|m| m.importance.unwrap_or(50));
        let len = classified.len();
        classified = (0..30).map(|i| classified[i * len / 30]).collect();
    }
    ClassifyPlan {
        stage,
        ids,
        anchors: classified.iter().map(|m| m.id).collect(),
    }
}

pub fn build_classify_prompt(project: &str, memories: &[Memory], anchors: &[Memory]) -> String {
    let anchors = if anchors.is_empty() {
        String::new()
    } else {
        format!("### Already-classified reference memories (calibrate against these — do NOT re-score them, they are NOT in your output)\n{}\n\n", anchors.iter().map(|m|format!("[{}] {} importance={}\n{}",m.id,m.category,m.importance.unwrap_or(50),m.content)).collect::<Vec<_>>().join("\n\n"))
    };
    let pool = memories
        .iter()
        .map(|m| {
            format!(
                "[{}] {} (current: importance={} scope={} shareable={})\n{}",
                m.id,
                m.category,
                m.importance.unwrap_or(50),
                m.scope.as_deref().unwrap_or("project"),
                m.shareable,
                m.content
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    format!("## Task: Classify Project Memories\n\n**Project:** {project}\n\nScore EVERY memory in the pool below. Emit one <classify> manifest covering every id.\n\n{anchors}### Memory pool to classify\n{pool}")
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MapInput {
    pub id: i64,
    pub category: String,
    pub content: String,
    pub candidates: Vec<String>,
}

pub fn candidate_paths(content: &str, mut exists: impl FnMut(&str) -> bool) -> Vec<String> {
    let mut found = Vec::new();
    for c in re(r"`?((?:[A-Za-z0-9_.-]+/)+[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|rs|go|py|json|jsonc|sql|toml|sh))`?").captures_iter(content) {
        let rel = &c[1];
        if !rel.contains("..") && !found.iter().any(|v| v == rel) && exists(rel) { found.push(rel.to_owned()); }
        if found.len() >= 3 { break; }
    }
    found
}

pub fn select_map_inputs(active: &[Memory], mut exists: impl FnMut(&str) -> bool) -> Vec<MapInput> {
    let input = |m: &Memory, candidates| MapInput {
        id: m.id,
        category: m.category.clone(),
        content: m.content.clone(),
        candidates,
    };
    let mut inputs: Vec<_> = active
        .iter()
        .filter(|m| m.unmapped)
        .map(|m| input(m, candidate_paths(&m.content, &mut exists)))
        .collect();
    let mut healed = 0;
    for m in active.iter().filter(|m| {
        !m.unmapped
            && m.has_sentinel
            && m.files.is_empty()
            && m.mapping_origin.as_deref() != Some("host_rejected_fallback")
    }) {
        let candidates = candidate_paths(&m.content, &mut exists);
        if !candidates.is_empty() {
            inputs.push(input(m, candidates));
            healed += 1;
        }
        if healed >= 20 {
            break;
        }
    }
    inputs
}

pub fn build_map_prompt(project: &str, inputs: &[MapInput]) -> String {
    let list = inputs
        .iter()
        .map(|m| {
            let seed = if m.candidates.is_empty() {
                String::new()
            } else {
                format!(
                    "\nLikely files (named in the memory, confirmed to exist): {}",
                    m.candidates.join(", ")
                )
            };
            format!("[{}] {}\n{}{seed}", m.id, m.category, m.content)
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    format!("## Map these memories to their backing files\n\nProject: {project}\n\nFor each memory below, find the repo file(s) it makes a claim about, or mark it file-independent. Behavioral process/workflow directives stay file-independent even when they name files. When \"Likely files\" are listed, those paths are named in the memory and confirmed to exist — START there only for code claims: confirm each actually backs the claim (a quick read/outline), drop any that don't, add others only if genuinely needed. Search from scratch only when no likely files are given. Then output ONE <mappings> manifest covering every id.\n\n<memories>\n{list}\n</memories>")
}

pub fn directive_shaped_rule(category: &str, content: &str) -> bool {
    if category != "PROJECT_RULES" {
        return false;
    }
    let text = content.trim();
    [
        r"(?:^|[.!?]\s+|\n\s*)(?:[-*]\s+|\d+[.)]\s+)?(?:you\s+|we\s+)?(?:must(?:\s+not)?|never|always|do\s+not|don't|shall\s+not)\b",
        r"\b(?:you|we|agents?|masons?|workers?|operators?|users?|maintainers?)\s+(?:must(?:\s+not)?|should(?:\s+not)?|need\s+to|shall(?:\s+not)?|cannot|can't|may\s+not)\b",
        r"\bwhen\s+(?:you(?:'re|\s+are)?|we(?:'re|\s+are)?|told|asked|requested|working|debugging|reviewing|checking|verifying|investigating|using|running|editing|changing)\b",
        r"(?:^|[.!?]\s+|\n\s*)(?:[-*]\s+|\d+[.)]\s+)?(?:please\s+)?(?:run|use|check|ask|avoid|prefer|ensure|keep|follow|brief|report|inspect|search|open|read|review|validate|confirm|delegate|stop|start|remember)\b",
        r"\b(?:the\s+)?(?:user|operator|maintainer|owner)\s+(?:decides|chooses|approves|has\s+(?:the\s+)?final\s+say)\b",
    ].iter().any(|pattern| re(&format!("(?i){pattern}")).is_match(text))
}

/// These are host identity inputs, not project configuration. Recording them
/// makes the TS diagnostic-redaction shareability gate reproducible in fixtures.
#[derive(Default)]
pub struct SensitiveContext {
    pub home: String,
    pub username: String,
}

pub fn sensitive_text(text: &str, context: &SensitiveContext) -> bool {
    if (!context.home.is_empty() && context.home != "~" && text.contains(&context.home))
        || (!context.username.is_empty()
            && context.username != "<USER>"
            && text.contains(&context.username))
    {
        return true;
    }
    for (pattern, replacement) in [
        (r"/Users/[^/]+/", "/Users/<USER>/"),
        (r"/home/[^/]+/", "/home/<USER>/"),
        (r"C:\\Users\\[^\\]+\\", "C:\\Users\\<USER>\\"),
    ] {
        if re(pattern).replace_all(text, replacement).as_ref() != text {
            return true;
        }
    }
    let patterns = [
        r"\bsk-ant-(?:api03-)?[A-Za-z0-9_-]{32,}",
        r"\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}",
        r"\bgithub_pat_[A-Za-z0-9_]{20,}",
        r"\b(?:gh[opsu]|ghr)_[A-Za-z0-9]{30,}",
        r"\bhf_[A-Za-z0-9]{30,}",
        r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b",
        r"\bxox[abprsuvc]-[A-Za-z0-9-]{10,}",
        r"\bAIza[A-Za-z0-9_-]{35}\b",
        r"(?i)\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/=-]{8,}",
        r"(?i)\b(?:Proxy-)?Authorization\s*:\s*(?:Basic|Digest|Token|Negotiate|NTLM)\s+[A-Za-z0-9._~+/=-]{4,}",
        r"(?i)\b[a-z][a-z0-9+.-]*://[^\s/:@]+:[^\s/@]+@",
        r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+",
        r"(?i)\bC:/Users/[^/\s]+",
        r"(?:^|\s)~/[^\s]+",
        r"(?i)\b(?:api[_-]?key|secret|token|password|passwd|pwd|client[_-]?secret|access[_-]?key)\b\s*[:=]\s*\S+",
        r"(?i)\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?\b",
        r"\b(?:10|127)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b",
        r"\b192\.168\.\d{1,3}\.\d{1,3}\b",
        r"\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b",
    ];
    if patterns.iter().any(|p| re(p).is_match(text)) {
        return true;
    }
    let scalar = |v: &str| {
        matches!(v.trim(), "true" | "false" | "null" | "undefined")
            || re(r"^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$").is_match(v.trim())
    };
    for c in re(r#"(?i)\b(?:x-)?(?:api-?key|api-?token|auth-?token|access-?token)\s*:\s*([^\s'"`,;<>]{6,})"#).captures_iter(text) { if !scalar(&c[1]) { return true; } }
    for c in re(r#"(?i)\b[A-Za-z0-9_.-]*(?:key|token|secret|password|auth|bearer|credential)[A-Za-z0-9_.-]*\s*=\s*([^\s'"`]+)"#).captures_iter(text) { if !scalar(&c[1]) { return true; } }
    // The TS regex requires matching quotes on both key and value. Splitting
    // by quote kind preserves that rule without a regex backreference.
    for key_quote in ['\'', '"'] {
        for value_quote in ['\'', '"'] {
            let p = format!(
                r#"(?i){key_quote}[^"']*(?:key|token|secret|password|auth|bearer|credential)[^"']*{key_quote}\s*:\s*{value_quote}([^"']*){value_quote}"#
            );
            for c in re(&p).captures_iter(text) {
                if !scalar(&c[1]) {
                    return true;
                }
            }
        }
    }
    false
}

pub fn classification_updates(
    memories: &[Memory],
    parsed: &[Classification],
    sensitive: &SensitiveContext,
) -> Vec<ClassificationUpdate> {
    parsed
        .iter()
        .filter_map(|p| {
            memories
                .iter()
                .find(|m| m.id == p.id)
                .map(|m| ClassificationUpdate {
                    memory_id: p.id,
                    content_hash_at_prompt: m.normalized_hash.clone(),
                    importance: p.importance,
                    scope: p.scope.clone(),
                    shareable: p
                        .shareable
                        .map(|v| v && !sensitive_text(&m.content, sensitive)),
                })
        })
        .collect()
}

/// Path normalization must run before the lease-guarded write. The normalizer
/// must reject untracked/out-of-repository paths, including symlink escapes.
pub fn mapping_updates(
    memories: &[Memory],
    parsed: &[Mapping],
    budget_finalized: bool,
    mut normalize: impl FnMut(&[String]) -> Result<Vec<String>, String>,
) -> Result<Vec<MappingUpdate>, String> {
    let valid: Vec<_> = parsed
        .iter()
        .filter(|p| memories.iter().any(|m| m.id == p.id))
        .collect();
    unique(valid.iter().map(|p| p.id), "mappings")?;
    if !budget_finalized && valid.len() * 2 < memories.len() {
        return Err(format!("mappings manifest covers {}/{} batch ids after filtering unknown entries; rejecting mostly-wrong manifest",valid.len(),memories.len()));
    }
    let mut out = Vec::new();
    for p in valid {
        let m = memories
            .iter()
            .find(|m| m.id == p.id)
            .expect("filtered batch member");
        let directive =
            !p.independent && !p.files.is_empty() && directive_shaped_rule(&m.category, &m.content);
        let files = if p.independent || directive {
            vec![]
        } else {
            if p.files.is_empty() {
                return Err(format!(
                    "mapping entry {} has no files and no independent sentinel",
                    p.id
                ));
            }
            normalize(&p.files)?
        };
        let rejected = directive || (!p.independent && files.is_empty());
        out.push(MappingUpdate {
            memory_id: p.id,
            content_hash_at_prompt: m.normalized_hash.clone(),
            mapped_files: if files.is_empty() { None } else { Some(files) },
            mapping_origin: if rejected {
                "host_rejected_fallback"
            } else {
                "mapper"
            }
            .into(),
        });
    }
    Ok(out)
}

pub struct TaskContext<'a> {
    pub route_config: &'a McModuleConfig,
    pub trusted_config: &'a Value,
    pub harness: &'a str,
    pub parent_session_id: &'a str,
    pub directory: &'a Path,
    pub project: &'a str,
    pub deadline_ms: u64,
    pub token_budget: Option<u64>,
    pub sensitive: &'a SensitiveContext,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskError {
    Runner(dream_runner::Failure),
    Commit(String),
    Budget,
    LeaseLost,
}

/// The integration adapter owns the existing task lease/heartbeat and records
/// runner attempts. Both commit methods must recheck that lease and prompt-time
/// hashes in the bounded transaction, return only accepted rows, and must not
/// bump cache epochs or claim memory authority. No adapter call may open a live
/// store in fixtures. Repository checks happen outside the write transaction.
pub trait TaskHost: DreamCarrier {
    fn check_control(&self) -> Result<(), TaskError>;
    fn now_ms(&self) -> u64;
    fn path_exists(&self, relative: &str) -> bool;
    fn normalize_files(&self, files: &[String]) -> Result<Vec<String>, String>;
    fn budget_finalized(&self) -> bool;
    fn record_attempts(&mut self, task: &str, attempts: &[dream_runner::Attempt]);
    fn commit_classifications(
        &mut self,
        rows: &[ClassificationUpdate],
    ) -> Result<(usize, usize), TaskError>;
    fn commit_mappings(&mut self, rows: &[MappingUpdate]) -> Result<Vec<i64>, TaskError>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClassifyResult {
    pub classified: usize,
    pub changed: usize,
    pub chunks: usize,
    pub stage: u8,
    pub remaining: usize,
    pub complete: bool,
}

pub async fn run_classify(
    activated: bool,
    context: &TaskContext<'_>,
    active: &[Memory],
    host: &mut impl TaskHost,
) -> Result<Option<ClassifyResult>, TaskError> {
    if !activated {
        return Ok(None);
    }
    let plan = plan_classify(active);
    let targets: Vec<_> = active
        .iter()
        .filter(|m| plan.ids.contains(&m.id))
        .cloned()
        .collect();
    let anchors: Vec<_> = plan
        .anchors
        .iter()
        .filter_map(|id| active.iter().find(|m| m.id == *id).cloned())
        .collect();
    let mut result = ClassifyResult {
        classified: 0,
        changed: 0,
        chunks: 0,
        stage: plan.stage,
        remaining: targets.len(),
        complete: targets.is_empty(),
    };
    let chunks: Vec<_> = targets.chunks(100).collect();
    for (i, chunk) in chunks.iter().enumerate() {
        host.check_control()?;
        let remaining = context.deadline_ms.saturating_sub(host.now_ms());
        if remaining == 0 {
            break;
        }
        let prompt = build_classify_prompt(context.project, chunk, &anchors);
        let ids: Vec<_> = chunk.iter().map(|m| m.id).collect();
        let request = request(
            context,
            CLASSIFY_TASK,
            DreamRole::Classifier,
            CLASSIFY_SYSTEM_PROMPT,
            &prompt,
            (remaining / (chunks.len() - i) as u64).max(1),
        );
        let run = dream_runner::run_dream_task(
            activated,
            context.route_config,
            context.trusted_config,
            &request,
            host,
            |c| validate_classify_manifest(&c.text, &ids),
        )
        .await;
        host.record_attempts(CLASSIFY_TASK, &run.attempts);
        host.check_control()?;
        let parsed = match run.result {
            Ok(parsed) => parsed,
            Err(dream_runner::Failure::Validation(_) | dream_runner::Failure::Empty) => {
                result.chunks += 1;
                continue;
            }
            Err(error) => return Err(TaskError::Runner(error)),
        };
        let rows = classification_updates(chunk, &parsed, context.sensitive);
        let (classified, changed) = host.commit_classifications(&rows)?;
        result.classified += classified;
        result.changed += changed;
        result.remaining -= classified;
        result.chunks += 1;
    }
    result.complete = result.remaining == 0;
    Ok(Some(result))
}

fn request<'a>(
    context: &'a TaskContext<'a>,
    task: &'a str,
    role: DreamRole,
    system: &'a str,
    prompt: &'a str,
    slice: u64,
) -> DreamRequest<'a> {
    DreamRequest {
        task,
        role,
        harness: context.harness,
        parent_session_id: context.parent_session_id,
        directory: context.directory,
        system,
        prompt,
        timeout: Duration::from_millis(slice),
        token_budget: context.token_budget,
        allow_empty: false,
    }
}

pub fn map_batch_slice_ms(remaining: u64, batches: usize) -> u64 {
    remaining.min(MAP_BATCH_FLOOR_MS.max(remaining / batches.max(1) as u64))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MapResult {
    pub mapped: usize,
    pub independent: usize,
    pub batches: usize,
    pub remaining: usize,
    pub complete: bool,
    #[serde(rename = "stopReason", skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
}

pub async fn run_map(
    activated: bool,
    context: &TaskContext<'_>,
    active: &[Memory],
    host: &mut impl TaskHost,
) -> Result<Option<MapResult>, TaskError> {
    if !activated {
        return Ok(None);
    }
    let inputs = select_map_inputs(active, |p| host.path_exists(p));
    let mut batches: Vec<_> = inputs.chunks(20).map(|v| (v.to_vec(), false)).collect();
    let mut result = MapResult {
        mapped: 0,
        independent: 0,
        batches: 0,
        remaining: inputs.len(),
        complete: inputs.is_empty(),
        stop_reason: None,
    };
    let mut timeouts = 0;
    let mut i = 0;
    while i < batches.len() {
        host.check_control()?;
        let remaining = context.deadline_ms.saturating_sub(host.now_ms());
        if remaining < MAP_BATCH_FLOOR_MS {
            result.stop_reason = Some("deadline".into());
            break;
        }
        let (batch, retry) = batches[i].clone();
        let ids: Vec<_> = batch.iter().map(|m| m.id).collect();
        let prompt = build_map_prompt(context.project, &batch);
        let request = request(
            context,
            MAP_TASK,
            DreamRole::MemoryMapper,
            MAP_MEMORIES_SYSTEM_PROMPT,
            &prompt,
            map_batch_slice_ms(remaining, batches.len() - i),
        );
        let run = dream_runner::run_dream_task(
            activated,
            context.route_config,
            context.trusted_config,
            &request,
            host,
            |c| validate_map_manifest(&c.text, &ids),
        )
        .await;
        host.record_attempts(MAP_TASK, &run.attempts);
        host.check_control()?;
        let outcome = match run.result {
            Ok(parsed) => {
                let memories: Vec<_> = batch
                    .iter()
                    .filter_map(|v| active.iter().find(|m| m.id == v.id).cloned())
                    .collect();
                match mapping_updates(&memories, &parsed, host.budget_finalized(), |files| {
                    host.normalize_files(files)
                }) {
                    Ok(rows) => {
                        let accepted = host.commit_mappings(&rows)?;
                        let mapped = rows
                            .iter()
                            .filter(|r| accepted.contains(&r.memory_id) && r.mapped_files.is_some())
                            .count();
                        let independent = rows
                            .iter()
                            .filter(|r| accepted.contains(&r.memory_id) && r.mapped_files.is_none())
                            .count();
                        result.mapped += mapped;
                        result.independent += independent;
                        result.remaining -= mapped + independent;
                        if mapped + independent > 0 {
                            result.batches += 1;
                        }
                        let omitted: Vec<_> = batch
                            .into_iter()
                            .filter(|v| !parsed.iter().any(|p| p.id == v.id))
                            .collect();
                        if !retry && !host.budget_finalized() && !omitted.is_empty() {
                            batches.insert(i + 1, (omitted, true));
                        }
                        false
                    }
                    Err(_) => false,
                }
            }
            Err(dream_runner::Failure::Timeout) => true,
            Err(_) => false,
        };
        timeouts = if outcome { timeouts + 1 } else { 0 };
        if timeouts >= 2 {
            result.stop_reason = Some("timeout-circuit-breaker".into());
            break;
        }
        i += 1;
    }
    result.complete = result.remaining == 0;
    Ok(Some(result))
}

// Keep model instructions identical to the TypeScript compatibility baseline
// while moving orchestration to Rust. These prompts are copied verbatim from
// packages/plugin/src/features/magic-context/dreamer/
// {classify-prompt,map-memories-prompt}.ts at 282d9c08bce490346583a3b8c145c402499f980f.
// Hashes identify the full source files; tests separately pin the prompt bytes.
// Source-file SHA256: classify 2eb7678db84542110e3d607a579bdac499f19472b9a7df8abd610b072783ed50;
// map 4232865ee46a6811380cc45fbe3764355607e216e9df4910d1b224ec7e4ba01c.
pub const CLASSIFY_SYSTEM_PROMPT: &str = r####"You are a memory classifier for the magic-context system. You classify project memories by metadata only. You do NOT rewrite, merge, archive, verify, or create memories, and you do NOT read code — you judge each memory from its own text.

### How to score importance (1-100)
Importance decides which memories survive when the injected memory block is over budget: high scores stay in context, low scores drop first. So the score is only useful if it **discriminates** — if most memories land in the same band, you have not classified them, you have just labelled them.

Use judgment, not a formula. Blend:
- **Durability / decay-rate value:** Will this fact still matter weeks from now, across sessions?
- **Operational impact:** Would missing this fact cause wrong code, wasted time, broken workflows, or violated constraints?

Most memories are ordinary working facts — they belong in the middle, not the top. Reserve the high band for the genuinely load-bearing handful a teammate would be sunk without; push routine observations, one-off details, and now-obvious facts down. A "real, true fact" is not automatically important — truth is not importance.

Rough anchors (not quotas — spread naturally within them): transient/obvious observations 1-30, ordinary helpful project facts 40-65, load-bearing rules/architecture/constraints 70-100. A constraint that is a genuine must/never/always rule the project actively depends on floors around 60; but not every memory in a category is load-bearing — a niche, dated, or narrowly-scoped external quirk can sit lower even if it is a "constraint". Score the fact, not the label. If you assigned most of the pool to one band, re-read and differentiate.

One hard floor: an operating rule whose VIOLATION causes a public-facing or irreversible mistake — posting under the wrong identity, committing/pushing without approval, leaking private content, running destructive commands — scores at least 80. These rules only work if they are always in view; a mid-band score silently drops them from context exactly when the pool grows, and the violation happens. Judge by consequence-of-forgetting, not by how mundane the rule text reads.

### Scope
- `project` — only meaningful inside this repository/product (default when uncertain).
- `ecosystem` — useful to sibling projects in the same stack, harness, provider, or company ecosystem.
- `universe` — broadly true outside this codebase (protocol/platform/API facts), still written as a concise memory.

### Shareability
Shareability is about EXPOSURE, not scope: **would a teammate working on THIS SAME project benefit from seeing this memory, and is it free of anything personal, local, or sensitive?** If yes, set `shareable="true"`. This is the COMMON case — most project knowledge is exactly what you'd hand a new teammate: architecture, design rules, conventions, constraints, file locations, hard-won gotchas. Mark those shareable even though they are specific to this repo's internals.

Keep `shareable="false"` only for what is tied to the USER or their machine rather than the project: personal/absolute paths, usernames, local or private endpoints (e.g. localhost), credentials/secrets/tokens, customer data, machine-specific config, and personal working-style preferences. A fact's scope does NOT decide shareability. The host also fails closed and forces secret/credential/personal-path text to private regardless.

Output ONE XML manifest at the very end and NOTHING else — no narration, no per-memory commentary, no reasoning:
<classify>
<memory id="N" importance="75" scope="project" shareable="true"/>
<memory id="M" importance="20" scope="universe" shareable="false"/>
</classify>

Rules:
- Every memory in the pool below MUST appear exactly once.
- importance is an integer 1-100; scope is one of project|ecosystem|universe; shareable is true|false."####;
pub const MAP_MEMORIES_SYSTEM_PROMPT: &str = r####"You are a memory mapper for the magic-context system. You map project memories to the repository files that back them.

A memory's BACKING FILES are the file(s) whose code the memory makes a claim about — the files you would open to check whether the memory is accurate. You do NOT judge accuracy, rewrite, or remove anything. You only LOCATE backing files.

Tools (read-only): read, grep, glob. Request line ranges rather than full files; use offset/limit for longer files. Each memory may come with "Likely files" already named in it and confirmed to exist — confirm those FIRST (cheap) instead of searching. Use search/grep to FIND code only when no likely files are given. Do not guess — confirm a file exists and genuinely backs the memory before listing it. Keep reads minimal: you do not need to read a whole file to confirm it backs a one-line claim.

For each memory decide ONE of:
- Backing files found → the COMPLETE set of repo-relative paths whose code the memory is about.
- File-independent → the memory describes EXTERNAL behavior (a provider / API / platform / protocol limit, e.g. "Anthropic returns 400 on empty content"), or a pure process / workflow / philosophy rule, with NO specific local file that backs it. A BEHAVIORAL claim (when to act, how to work, who decides, or tool-usage discipline) is file-independent even when it cites file paths or commands as examples: a named file is not the file backing the rule.

Output ONE XML manifest at the very end and NOTHING else — no narration, no per-memory commentary, no reasoning:
<mappings>
<memory id="N" files="path/a.ts,path/b.ts"/>
<memory id="M" independent="true"/>
</mappings>

Rules:
- Every input memory id MUST appear exactly once.
- files: repo-relative, comma-separated, no spaces inside a path. Only files that actually exist and genuinely back the memory.
- A BACKING FILE is CODE that implements or handles the claim — not a file that merely mentions it. A path named inside a process directive is an action target or example, not evidence that the file backs the directive. A markdown doc (.md), a PARITY/notes file, or a test that only DESCRIBES an external fact is NOT a backing file. If the only place a memory's fact appears is prose/docs/a test (no code implements or handles it), mark it independent="true".
- Many CONSTRAINTS are HYBRID: "external system does X, and OUR code handles it here." Map those to the HANDLING code (you can verify the handling, even though you can't verify the external behavior). Only mark independent when there is NO local code that implements or handles the fact.
- Prefer the most specific file(s); do not pad with tangential files. Most memories map to one file; some to a few.
- When you genuinely cannot find any local backing and it is not clearly external, still emit the memory with independent="true" (do not drop it)."####;

// Recorded inputs and outputs from the TypeScript functions at the revision
// below. The TS test setup supplies memory snapshots, captures metadata writes,
// permits lease-guarded writes, replays model completions and fixes the clock.
// Parser, selection, prompt and apply logic execute from the pinned TS sources;
// keep these expectations independent of the Rust implementation.
#[cfg(test)]
const TS_VECTORS: &str = r####"{
  "revision": "282d9c08bce490346583a3b8c145c402499f980f",
  "parsers": [
    {
      "kind": "classify",
      "text": "<classify><memory id=\"1\" importance=\"0\" scope=\"UNIVERSE\" shareable=\"1\"/><memory id=\"2\" importance=\"999\"/></classify>",
      "ids": [
        1,
        2
      ],
      "result": {
        "ok": [
          {
            "id": 1,
            "importance": 1,
            "scope": "universe",
            "shareable": true
          },
          {
            "id": 2,
            "importance": 100
          }
        ]
      }
    },
    {
      "kind": "classify",
      "text": "<classify><memory id=\"1\" shareable=\"FALSE\"/></classify>",
      "ids": [
        1
      ],
      "result": {
        "ok": [
          {
            "id": 1,
            "shareable": false
          }
        ]
      }
    },
    {
      "kind": "classify",
      "text": "<classify><memory id=\"1\" importance=\"50\"/></classify>",
      "ids": [
        1,
        2
      ],
      "result": {
        "err": "classify manifest missing id 2"
      }
    },
    {
      "kind": "classify",
      "text": "<classify><memory id=\"3\" importance=\"50\"/></classify>",
      "ids": [
        1
      ],
      "result": {
        "err": "classify manifest contains unknown id 3"
      }
    },
    {
      "kind": "classify",
      "text": "<classify><memory id=\"1\" importance=\"50\"/><memory id=\"1\" scope=\"project\"/></classify>",
      "ids": [
        1
      ],
      "result": {
        "err": "classify manifest contains duplicate id 1"
      }
    },
    {
      "kind": "classify",
      "text": "<classify><memory id=\"1\" scope=\"galaxy\"/></classify>",
      "ids": [
        1
      ],
      "result": {
        "err": "classify manifest invalid scope galaxy"
      }
    },
    {
      "kind": "classify",
      "text": "<classify><memory id=\"1\"/></classify>",
      "ids": [
        1
      ],
      "result": {
        "err": "classify manifest entry 1 missing classification fields"
      }
    },
    {
      "kind": "classify",
      "text": "<classify><memory id=\"1\" importance=\"50\"/>",
      "ids": [
        1
      ],
      "result": {
        "err": "classify manifest missing closing root tag"
      }
    },
    {
      "kind": "classify",
      "text": "<classify></classify>",
      "ids": [
        1
      ],
      "result": {
        "err": "parsed zero entries; expected <classify> with <memory> entries"
      }
    },
    {
      "kind": "classify",
      "text": "<classify></classify>",
      "ids": [],
      "result": {
        "ok": []
      }
    },
    {
      "kind": "classify",
      "text": "<classify><MEMORY id=\"1\" importance=\"20\"/></classify>",
      "ids": [
        1
      ],
      "result": {
        "err": "parsed zero entries; expected <classify> with <memory> entries"
      }
    },
    {
      "kind": "classify",
      "text": "{\"memories\":[]}",
      "ids": [
        1
      ],
      "result": {
        "err": "JSON object unrecognized; expected <classify> with <memory> entries"
      }
    },
    {
      "kind": "classify",
      "text": "<map/>",
      "ids": [
        1
      ],
      "result": {
        "err": "root <map> unrecognized; expected <classify> with <memory> entries"
      }
    },
    {
      "kind": "mappings",
      "text": "<mappings><memory id=\"1\"><file path=\"src/a.ts\"/><file path=\" src/b.rs \"/></memory><memory id=\"2\" independent=\"true\"/></mappings>",
      "ids": [
        1,
        2
      ],
      "result": {
        "ok": [
          {
            "id": 1,
            "files": [
              "src/a.ts",
              "src/b.rs"
            ],
            "independent": false
          },
          {
            "id": 2,
            "files": [],
            "independent": true
          }
        ]
      }
    },
    {
      "kind": "mappings",
      "text": "<mappings><memory id=\"1\" files=\"src/a.ts, src/a.ts,,\" independent=\"true\"/></mappings>",
      "ids": [
        1
      ],
      "result": {
        "ok": [
          {
            "id": 1,
            "files": [
              "src/a.ts",
              "src/a.ts"
            ],
            "independent": false
          }
        ]
      }
    },
    {
      "kind": "mappings",
      "text": "<mappings><memory id=\"1\" files=\"src/a.ts\"/><memory id=\"7\" independent=\"1\"/><memory id=\"7\" independent=\"1\"/></mappings>",
      "ids": [
        1,
        2
      ],
      "result": {
        "ok": [
          {
            "id": 1,
            "files": [
              "src/a.ts"
            ],
            "independent": false
          },
          {
            "id": 7,
            "files": [],
            "independent": true
          },
          {
            "id": 7,
            "files": [],
            "independent": true
          }
        ]
      }
    },
    {
      "kind": "mappings",
      "text": "<mappings><memory id=\"1\" files=\"src/a.ts\"/><memory id=\"1\" independent=\"1\"/></mappings>",
      "ids": [
        1
      ],
      "result": {
        "err": "mappings manifest contains duplicate id 1"
      }
    },
    {
      "kind": "mappings",
      "text": "<mappings><memory id=\"1\"/></mappings>",
      "ids": [
        1
      ],
      "result": {
        "err": "mappings manifest entry 1 has neither files nor independent=\"true\""
      }
    },
    {
      "kind": "mappings",
      "text": "<mappings><memory id=\"1\" files=\"\"/></mappings>",
      "ids": [
        1
      ],
      "result": {
        "err": "mappings manifest entry 1 has neither files nor independent=\"true\""
      }
    },
    {
      "kind": "mappings",
      "text": "<mappings><memory id=\"1\" independent=\"true\"/>",
      "ids": [
        1
      ],
      "result": {
        "err": "mappings manifest missing closing root tag"
      }
    },
    {
      "kind": "mappings",
      "text": "<mappings></mappings>",
      "ids": [
        1
      ],
      "result": {
        "err": "parsed zero entries; expected <mappings> with <memory> entries"
      }
    },
    {
      "kind": "mappings",
      "text": "<mappings></mappings>",
      "ids": [],
      "result": {
        "ok": []
      }
    },
    {
      "kind": "mappings",
      "text": "<mappings><mapping id=\"1\"/></mappings>",
      "ids": [
        1
      ],
      "result": {
        "err": "root <mapping> unrecognized; expected <mappings> with <memory> entries"
      }
    },
    {
      "kind": "mappings",
      "text": "[]",
      "ids": [
        1
      ],
      "result": {
        "err": "JSON array unrecognized; expected <mappings> with <memory> entries"
      }
    },
    {
      "kind": "mappings",
      "text": "<MAPPINGS><MEMORY id=\"1\" files=\"src/a.ts\"/></MAPPINGS>",
      "ids": [
        1
      ],
      "result": {
        "ok": [
          {
            "id": 1,
            "files": [
              "src/a.ts"
            ],
            "independent": false
          }
        ]
      }
    }
  ],
  "plans": [
    {
      "n": 9,
      "result": {
        "stage": 1,
        "ids": [],
        "anchors": []
      }
    },
    {
      "n": 10,
      "result": {
        "stage": 2,
        "ids": [
          4,
          7
        ],
        "anchors": []
      }
    },
    {
      "n": 100,
      "result": {
        "stage": 2,
        "ids": [
          4,
          7,
          13,
          16,
          22,
          25,
          31,
          34,
          40,
          43,
          49,
          52,
          58,
          61,
          67,
          70,
          76,
          79,
          85,
          88,
          94,
          97
        ],
        "anchors": []
      }
    },
    {
      "n": 101,
      "result": {
        "stage": 3,
        "ids": [
          4,
          7,
          13,
          16,
          22,
          25,
          31,
          34,
          40,
          43,
          49,
          52,
          58,
          61,
          67,
          70,
          76,
          79,
          85,
          88,
          94,
          97
        ],
        "anchors": [
          2,
          5,
          8,
          11,
          14,
          18,
          21,
          24,
          27,
          32,
          35,
          38,
          41,
          45,
          48,
          51,
          54,
          57,
          62,
          65,
          68,
          71,
          75,
          78,
          81,
          84,
          89,
          92,
          95,
          98
        ]
      }
    },
    {
      "n": 160,
      "result": {
        "stage": 3,
        "ids": [
          4,
          7,
          13,
          16,
          22,
          25,
          31,
          34,
          40,
          43,
          49,
          52,
          58,
          61,
          67,
          70,
          76,
          79,
          85,
          88,
          94,
          97,
          103,
          106,
          112,
          115,
          121,
          124,
          130,
          133,
          139,
          142,
          148,
          151,
          157,
          160
        ],
        "anchors": [
          102,
          104,
          107,
          9,
          12,
          14,
          17,
          120,
          123,
          125,
          128,
          30,
          33,
          35,
          38,
          41,
          144,
          147,
          149,
          152,
          54,
          57,
          59,
          65,
          69,
          75,
          80,
          86,
          90,
          96
        ]
      }
    },
    {
      "n": 231,
      "result": {
        "stage": 3,
        "ids": [
          4,
          7,
          13,
          16,
          22,
          25,
          31,
          34,
          40,
          43,
          49,
          52,
          58,
          61,
          67,
          70,
          76,
          79,
          85,
          88,
          94,
          97,
          103,
          106,
          112,
          115,
          121,
          124,
          130,
          133,
          139,
          142,
          148,
          151,
          157,
          160,
          166,
          169,
          175,
          178,
          184,
          187,
          193,
          196,
          202,
          205,
          211,
          214,
          220,
          223,
          229
        ],
        "anchors": [
          102,
          104,
          6,
          210,
          11,
          215,
          117,
          119,
          122,
          24,
          228,
          29,
          32,
          36,
          140,
          44,
          48,
          152,
          156,
          59,
          63,
          167,
          171,
          75,
          179,
          183,
          86,
          90,
          194,
          198
        ]
      }
    }
  ],
  "prompts": {
    "memories": [
      {
        "id": 1,
        "category": "PROJECT_FACTS",
        "content": "Use <tags> & Unicode 日本語.",
        "normalized_hash": "hash-1",
        "normalizedHash": "hash-1",
        "importance": 0,
        "scope": "project",
        "shareable": true,
        "unclassified": true,
        "open_classification": false,
        "unmapped": true,
        "has_sentinel": false,
        "files": [],
        "mapping_origin": null
      },
      {
        "id": 2,
        "category": "PROJECT_RULES",
        "content": "Never push without approval.",
        "normalized_hash": "hash-2",
        "normalizedHash": "hash-2",
        "importance": 91,
        "scope": "universe",
        "shareable": false,
        "unclassified": true,
        "open_classification": false,
        "unmapped": true,
        "has_sentinel": false,
        "files": [],
        "mapping_origin": null
      }
    ],
    "inputs": [
      {
        "id": 1,
        "category": "PROJECT_FACTS",
        "content": "Use <tags> & Unicode 日本語.",
        "normalized_hash": "hash-1",
        "normalizedHash": "hash-1",
        "importance": 0,
        "scope": "project",
        "shareable": true,
        "unclassified": true,
        "open_classification": false,
        "unmapped": true,
        "has_sentinel": false,
        "files": [],
        "mapping_origin": null,
        "candidates": [
          "src/a.ts",
          "src/b.rs",
          "src/d.go"
        ]
      },
      {
        "id": 2,
        "category": "PROJECT_RULES",
        "content": "Never push without approval.",
        "normalized_hash": "hash-2",
        "normalizedHash": "hash-2",
        "importance": 91,
        "scope": "universe",
        "shareable": false,
        "unclassified": true,
        "open_classification": false,
        "unmapped": true,
        "has_sentinel": false,
        "files": [],
        "mapping_origin": null,
        "candidates": []
      }
    ],
    "classify": "## Task: Classify Project Memories\n\n**Project:** /repo\n\nScore EVERY memory in the pool below. Emit one <classify> manifest covering every id.\n\n### Already-classified reference memories (calibrate against these — do NOT re-score them, they are NOT in your output)\n[2] PROJECT_RULES importance=91\nNever push without approval.\n\n### Memory pool to classify\n[1] PROJECT_FACTS (current: importance=0 scope=project shareable=true)\nUse <tags> & Unicode 日本語.\n\n[2] PROJECT_RULES (current: importance=91 scope=universe shareable=false)\nNever push without approval.",
    "map": "## Map these memories to their backing files\n\nProject: /repo\n\nFor each memory below, find the repo file(s) it makes a claim about, or mark it file-independent. Behavioral process/workflow directives stay file-independent even when they name files. When \"Likely files\" are listed, those paths are named in the memory and confirmed to exist — START there only for code claims: confirm each actually backs the claim (a quick read/outline), drop any that don't, add others only if genuinely needed. Search from scratch only when no likely files are given. Then output ONE <mappings> manifest covering every id.\n\n<memories>\n[1] PROJECT_FACTS\nUse <tags> & Unicode 日本語.\nLikely files (named in the memory, confirmed to exist): src/a.ts, src/b.rs, src/d.go\n\n[2] PROJECT_RULES\nNever push without approval.\n</memories>"
  },
  "sensitivities": [
    {
      "text": "ordinary code facts",
      "result": false
    },
    {
      "text": "/Users/alice/secret",
      "result": true
    },
    {
      "text": "/home/bob/work",
      "result": true
    },
    {
      "text": "C:\\Users\\bob\\work",
      "result": true
    },
    {
      "text": "C:/Users/bob/work",
      "result": true
    },
    {
      "text": "~/local",
      "result": true
    },
    {
      "text": "localhost:9000",
      "result": true
    },
    {
      "text": "172.31.1.2",
      "result": true
    },
    {
      "text": "172.32.1.2",
      "result": false
    },
    {
      "text": "10.1.2.3",
      "result": true
    },
    {
      "text": "192.168.3.4",
      "result": true
    },
    {
      "text": "token: true",
      "result": true
    },
    {
      "text": "tokens.input=45000",
      "result": false
    },
    {
      "text": "max_tokens=+4096e-2",
      "result": false
    },
    {
      "text": "max_tokens=TRUE",
      "result": true
    },
    {
      "text": "apiKey=secret-value",
      "result": true
    },
    {
      "text": "Authorization: Basic dXNlcjpwYXNz",
      "result": true
    },
    {
      "text": "https://a:password@host",
      "result": true
    },
    {
      "text": "sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "result": true
    },
    {
      "text": "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "result": true
    },
    {
      "text": "hf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "result": true
    },
    {
      "text": "\"auth\":\"true\"",
      "result": false
    },
    {
      "text": "\"auth\":\"private\"",
      "result": true
    },
    {
      "text": "fixtureuser owns this",
      "result": true
    },
    {
      "text": "/home/fixture/work",
      "result": true
    }
  ],
  "directives": [
    {
      "category": "PROJECT_RULES",
      "text": "Never edit src/a.ts without approval.",
      "result": true
    },
    {
      "category": "PROJECT_FACTS",
      "text": "Never edit src/a.ts without approval.",
      "result": false
    },
    {
      "category": "PROJECT_RULES",
      "text": "The workers should use src/a.ts.",
      "result": true
    },
    {
      "category": "PROJECT_FACTS",
      "text": "The workers should use src/a.ts.",
      "result": false
    },
    {
      "category": "PROJECT_RULES",
      "text": "When reviewing, read src/a.ts.",
      "result": true
    },
    {
      "category": "PROJECT_FACTS",
      "text": "When reviewing, read src/a.ts.",
      "result": false
    },
    {
      "category": "PROJECT_RULES",
      "text": "Run tests before edits to src/a.ts.",
      "result": true
    },
    {
      "category": "PROJECT_FACTS",
      "text": "Run tests before edits to src/a.ts.",
      "result": false
    },
    {
      "category": "PROJECT_RULES",
      "text": "The owner decides model choice.",
      "result": true
    },
    {
      "category": "PROJECT_FACTS",
      "text": "The owner decides model choice.",
      "result": false
    },
    {
      "category": "PROJECT_RULES",
      "text": "The parser uses src/a.ts to load facts.",
      "result": false
    },
    {
      "category": "PROJECT_FACTS",
      "text": "The parser uses src/a.ts to load facts.",
      "result": false
    }
  ],
  "mapSelection": {
    "active": [
      {
        "id": 1,
        "category": "PROJECT_FACTS",
        "content": "src/a.ts src/b.rs ../src/c.py src/d.go",
        "normalized_hash": "hash-1",
        "normalizedHash": "hash-1",
        "importance": 50,
        "scope": "project",
        "shareable": false,
        "unclassified": true,
        "open_classification": false,
        "unmapped": true,
        "has_sentinel": false,
        "files": [],
        "mapping_origin": null
      },
      {
        "id": 2,
        "category": "PROJECT_FACTS",
        "content": "src/a.ts",
        "normalized_hash": "hash-2",
        "normalizedHash": "hash-2",
        "importance": 50,
        "scope": "project",
        "shareable": false,
        "unclassified": true,
        "open_classification": false,
        "unmapped": false,
        "has_sentinel": true,
        "files": [],
        "mapping_origin": null
      },
      {
        "id": 3,
        "category": "PROJECT_FACTS",
        "content": "src/b.rs",
        "normalized_hash": "hash-3",
        "normalizedHash": "hash-3",
        "importance": 50,
        "scope": "project",
        "shareable": false,
        "unclassified": true,
        "open_classification": false,
        "unmapped": false,
        "has_sentinel": true,
        "files": [],
        "mapping_origin": "host_rejected_fallback"
      },
      {
        "id": 4,
        "category": "PROJECT_FACTS",
        "content": "src/c.py",
        "normalized_hash": "hash-4",
        "normalizedHash": "hash-4",
        "importance": 50,
        "scope": "project",
        "shareable": false,
        "unclassified": true,
        "open_classification": false,
        "unmapped": false,
        "has_sentinel": true,
        "files": [],
        "mapping_origin": null
      },
      {
        "id": 5,
        "category": "PROJECT_FACTS",
        "content": "src/c.py",
        "normalized_hash": "hash-5",
        "normalizedHash": "hash-5",
        "importance": 50,
        "scope": "project",
        "shareable": false,
        "unclassified": true,
        "open_classification": false,
        "unmapped": false,
        "has_sentinel": true,
        "files": [],
        "mapping_origin": null
      },
      {
        "id": 6,
        "category": "PROJECT_FACTS",
        "content": "src/c.py",
        "normalized_hash": "hash-6",
        "normalizedHash": "hash-6",
        "importance": 50,
        "scope": "project",
        "shareable": false,
        "unclassified": true,
        "open_classification": false,
        "unmapped": false,
        "has_sentinel": true,
        "files": [],
        "mapping_origin": null
      },
      {
        "id": 7,
        "category": "PROJECT_FACTS",
        "content": "src/c.py",
        "normalized_hash": "hash-7",
        "normalizedHash": "hash-7",
        "importance": 50,
        "scope": "project",
        "shareable": false,
        "unclassified": true,
        "open_classification": false,
        "unmapped": false,
        "has_sentinel": true,
        "files": [],
        "mapping_origin": null
      },
      {
        "id": 8,
        "category": "PROJECT_FACTS",
        "content": "src/c.py",
        "normalized_hash": "hash-8",
        "normalizedHash": "hash-8",
        "importance": 50,
        "scope": "project",
        "shareable": false,
        "unclassified": true,
        "open_classification": false,
        "unmapped": false,
        "has_sentinel": true,
        "files": [],
        "mapping_origin": null
      },
      {
        "id": 9,
        "category": "PROJECT_FACTS",
        "content": "src/c.py",
        "normalized_hash": "hash-9",
        "normalizedHash": "hash-9",
        "importance": 50,
        "scope": "project",
        "shareable": false,
        "unclassified": true,
        "open_classification": false,
        "unmapped": false,
        "has_sentinel": true,
        "files": [],
        "mapping_origin": null
      },
      {
        "id": 10,
        "category": "PROJECT_FACTS",
        "content": "src/c.py",
        "normalized_hash": "hash-10",
        "normalizedHash": "hash-10",
        "importance": 50,
        "scope": "project",
        "shareable": false,
        "unclassified": true,
        "open_classification": false,
        "unmapped": false,
        "has_sentinel": true,
        "files": [],
        "mapping_origin": null
      },
      {
        "id": 11,
        "category": "PROJECT_FACTS",
        "content": "src/c.py",
        "normalized_hash": "hash-11",
        "normalizedHash": "hash-11",
        "importance": 50,
        "scope": "project",
        "shareable": false,
        "unclassified": true,
        "open_classification": false,
        "unmapped": false,
        "has_sentinel": true,
        "files": [],
        "mapping_origin": null
      },
      {
        "id": 12,
        "category": "PROJECT_FACTS",
        "content": "src/c.py",
        "normalized_hash": "hash-12",
        "normalizedHash": "hash-12",
        "importance": 50,
        "scope": "project",
        "shareable": false,
        "unclassified": true,
        "open_classification": false,
        "unmapped": false,
        "has_sentinel": true,
        "files": [],
        "mapping_origin": null
      },
      {
        "id": 13,
        "category": "PROJECT_FACTS",
        "content": "src/c.py",
        "normalized_hash": "hash-13",
        "normalizedHash": "hash-13",
        "importance": 50,
        "scope": "project",
        "shareable": false,
        "unclassified": true,
        "open_classification": false,
        "unmapped": false,
        "has_sentinel": true,
        "files": [],
        "mapping_origin": null
      },
      {
        "id": 14,
        "category": "PROJECT_FACTS",
        "content": "src/c.py",
        "normalized_hash": "hash-14",
        "normalizedHash": "hash-14",
        "importance": 50,
        "scope": "project",
        "shareable": false,
        "unclassified": true,
        "open_classification": false,
        "unmapped": false,
        "has_sentinel": true,
        "files": [],
        "mapping_origin": null
      },
      {
        "id": 15,
        "category": "PROJECT_FACTS",
        "content": "src/c.py",
        "normalized_hash": "hash-15",
        "normalizedHash": "hash-15",
        "importance": 50,
        "scope": "project",
        "shareable": false,
        "unclassified": true,
        "open_classification": false,
        "unmapped": false,
        "has_sentinel": true,
        "files": [],
        "mapping_origin": null
      },
      {
        "id": 16,
        "category": "PROJECT_FACTS",
        "content": "src/c.py",
        "normalized_hash": "hash-16",
        "normalizedHash": "hash-16",
        "importance": 50,
        "scope": "project",
        "shareable": false,
        "unclassified": true,
        "open_classification": false,
        "unmapped": false,
        "has_sentinel": true,
        "files": [],
        "mapping_origin": null
      },
      {
        "id": 17,
        "category": "PROJECT_FACTS",
        "content": "src/c.py",
        "normalized_hash": "hash-17",
        "normalizedHash": "hash-17",
        "importance": 50,
        "scope": "project",
        "shareable": false,
        "unclassified": true,
        "open_classification": false,
        "unmapped": false,
        "has_sentinel": true,
        "files": [],
        "mapping_origin": null
      },
      {
        "id": 18,
        "category": "PROJECT_FACTS",
        "content": "src/c.py",
        "normalized_hash": "hash-18",
        "normalizedHash": "hash-18",
        "importance": 50,
        "scope": "project",
        "shareable": false,
        "unclassified": true,
        "open_classification": false,
        "unmapped": false,
        "has_sentinel": true,
        "files": [],
        "mapping_origin": null
      },
      {
        "id": 19,
        "category": "PROJECT_FACTS",
        "content": "src/c.py",
        "normalized_hash": "hash-19",
        "normalizedHash": "hash-19",
        "importance": 50,
        "scope": "project",
        "shareable": false,
        "unclassified": true,
        "open_classification": false,
        "unmapped": false,
        "has_sentinel": true,
        "files": [],
        "mapping_origin": null
      },
      {
        "id": 20,
        "category": "PROJECT_FACTS",
        "content": "src/c.py",
        "normalized_hash": "hash-20",
        "normalizedHash": "hash-20",
        "importance": 50,
        "scope": "project",
        "shareable": false,
        "unclassified": true,
        "open_classification": false,
        "unmapped": false,
        "has_sentinel": true,
        "files": [],
        "mapping_origin": null
      },
      {
        "id": 21,
        "category": "PROJECT_FACTS",
        "content": "src/c.py",
        "normalized_hash": "hash-21",
        "normalizedHash": "hash-21",
        "importance": 50,
        "scope": "project",
        "shareable": false,
        "unclassified": true,
        "open_classification": false,
        "unmapped": false,
        "has_sentinel": true,
        "files": [],
        "mapping_origin": null
      },
      {
        "id": 22,
        "category": "PROJECT_FACTS",
        "content": "src/c.py",
        "normalized_hash": "hash-22",
        "normalizedHash": "hash-22",
        "importance": 50,
        "scope": "project",
        "shareable": false,
        "unclassified": true,
        "open_classification": false,
        "unmapped": false,
        "has_sentinel": true,
        "files": [],
        "mapping_origin": null
      },
      {
        "id": 23,
        "category": "PROJECT_FACTS",
        "content": "src/c.py",
        "normalized_hash": "hash-23",
        "normalizedHash": "hash-23",
        "importance": 50,
        "scope": "project",
        "shareable": false,
        "unclassified": true,
        "open_classification": false,
        "unmapped": false,
        "has_sentinel": true,
        "files": [],
        "mapping_origin": null
      },
      {
        "id": 24,
        "category": "PROJECT_FACTS",
        "content": "src/c.py",
        "normalized_hash": "hash-24",
        "normalizedHash": "hash-24",
        "importance": 50,
        "scope": "project",
        "shareable": false,
        "unclassified": true,
        "open_classification": false,
        "unmapped": false,
        "has_sentinel": true,
        "files": [],
        "mapping_origin": null
      },
      {
        "id": 25,
        "category": "PROJECT_FACTS",
        "content": "src/c.py",
        "normalized_hash": "hash-25",
        "normalizedHash": "hash-25",
        "importance": 50,
        "scope": "project",
        "shareable": false,
        "unclassified": true,
        "open_classification": false,
        "unmapped": false,
        "has_sentinel": true,
        "files": [],
        "mapping_origin": null
      },
      {
        "id": 26,
        "category": "PROJECT_FACTS",
        "content": "src/c.py",
        "normalized_hash": "hash-26",
        "normalizedHash": "hash-26",
        "importance": 50,
        "scope": "project",
        "shareable": false,
        "unclassified": true,
        "open_classification": false,
        "unmapped": false,
        "has_sentinel": true,
        "files": [],
        "mapping_origin": null
      },
      {
        "id": 27,
        "category": "PROJECT_FACTS",
        "content": "src/c.py",
        "normalized_hash": "hash-27",
        "normalizedHash": "hash-27",
        "importance": 50,
        "scope": "project",
        "shareable": false,
        "unclassified": true,
        "open_classification": false,
        "unmapped": false,
        "has_sentinel": true,
        "files": [],
        "mapping_origin": null
      },
      {
        "id": 28,
        "category": "PROJECT_FACTS",
        "content": "src/c.py",
        "normalized_hash": "hash-28",
        "normalizedHash": "hash-28",
        "importance": 50,
        "scope": "project",
        "shareable": false,
        "unclassified": true,
        "open_classification": false,
        "unmapped": false,
        "has_sentinel": true,
        "files": [],
        "mapping_origin": null
      }
    ],
    "result": [
      {
        "id": 1,
        "category": "PROJECT_FACTS",
        "content": "src/a.ts src/b.rs ../src/c.py src/d.go",
        "candidates": [
          "src/a.ts",
          "src/b.rs",
          "src/d.go"
        ]
      },
      {
        "id": 2,
        "category": "PROJECT_FACTS",
        "content": "src/a.ts",
        "candidates": [
          "src/a.ts"
        ]
      },
      {
        "id": 4,
        "category": "PROJECT_FACTS",
        "content": "src/c.py",
        "candidates": [
          "src/c.py"
        ]
      },
      {
        "id": 5,
        "category": "PROJECT_FACTS",
        "content": "src/c.py",
        "candidates": [
          "src/c.py"
        ]
      },
      {
        "id": 6,
        "category": "PROJECT_FACTS",
        "content": "src/c.py",
        "candidates": [
          "src/c.py"
        ]
      },
      {
        "id": 7,
        "category": "PROJECT_FACTS",
        "content": "src/c.py",
        "candidates": [
          "src/c.py"
        ]
      },
      {
        "id": 8,
        "category": "PROJECT_FACTS",
        "content": "src/c.py",
        "candidates": [
          "src/c.py"
        ]
      },
      {
        "id": 9,
        "category": "PROJECT_FACTS",
        "content": "src/c.py",
        "candidates": [
          "src/c.py"
        ]
      },
      {
        "id": 10,
        "category": "PROJECT_FACTS",
        "content": "src/c.py",
        "candidates": [
          "src/c.py"
        ]
      },
      {
        "id": 11,
        "category": "PROJECT_FACTS",
        "content": "src/c.py",
        "candidates": [
          "src/c.py"
        ]
      },
      {
        "id": 12,
        "category": "PROJECT_FACTS",
        "content": "src/c.py",
        "candidates": [
          "src/c.py"
        ]
      },
      {
        "id": 13,
        "category": "PROJECT_FACTS",
        "content": "src/c.py",
        "candidates": [
          "src/c.py"
        ]
      },
      {
        "id": 14,
        "category": "PROJECT_FACTS",
        "content": "src/c.py",
        "candidates": [
          "src/c.py"
        ]
      },
      {
        "id": 15,
        "category": "PROJECT_FACTS",
        "content": "src/c.py",
        "candidates": [
          "src/c.py"
        ]
      },
      {
        "id": 16,
        "category": "PROJECT_FACTS",
        "content": "src/c.py",
        "candidates": [
          "src/c.py"
        ]
      },
      {
        "id": 17,
        "category": "PROJECT_FACTS",
        "content": "src/c.py",
        "candidates": [
          "src/c.py"
        ]
      },
      {
        "id": 18,
        "category": "PROJECT_FACTS",
        "content": "src/c.py",
        "candidates": [
          "src/c.py"
        ]
      },
      {
        "id": 19,
        "category": "PROJECT_FACTS",
        "content": "src/c.py",
        "candidates": [
          "src/c.py"
        ]
      },
      {
        "id": 20,
        "category": "PROJECT_FACTS",
        "content": "src/c.py",
        "candidates": [
          "src/c.py"
        ]
      },
      {
        "id": 21,
        "category": "PROJECT_FACTS",
        "content": "src/c.py",
        "candidates": [
          "src/c.py"
        ]
      },
      {
        "id": 22,
        "category": "PROJECT_FACTS",
        "content": "src/c.py",
        "candidates": [
          "src/c.py"
        ]
      }
    ]
  },
  "slices": [
    {
      "remaining": 240000,
      "batches": 4,
      "result": 240000
    },
    {
      "remaining": 900000,
      "batches": 4,
      "result": 240000
    },
    {
      "remaining": 1200000,
      "batches": 2,
      "result": 600000
    },
    {
      "remaining": 1000,
      "batches": 5,
      "result": 1000
    }
  ],
  "apply": [
    {
      "kind": "classify",
      "active": [
        {
          "id": 1,
          "category": "PROJECT_FACTS",
          "content": "localhost:9000",
          "normalized_hash": "hash-1",
          "normalizedHash": "hash-1",
          "importance": 50,
          "scope": "project",
          "shareable": false,
          "unclassified": true,
          "open_classification": false,
          "unmapped": true,
          "has_sentinel": false,
          "files": [],
          "mapping_origin": null
        },
        {
          "id": 2,
          "category": "PROJECT_FACTS",
          "content": "Fact 2",
          "normalized_hash": "hash-2",
          "normalizedHash": "hash-2",
          "importance": 50,
          "scope": "project",
          "shareable": false,
          "unclassified": true,
          "open_classification": false,
          "unmapped": true,
          "has_sentinel": false,
          "files": [],
          "mapping_origin": null
        }
      ],
      "text": "<classify><memory id=\"1\" shareable=\"true\"/><memory id=\"2\" importance=\"80\" scope=\"ecosystem\" shareable=\"true\"/></classify>",
      "result": {
        "ok": {
          "classified": 2,
          "changed": 1
        }
      },
      "writes": [
        {
          "id": 1,
          "shareable": false
        },
        {
          "id": 2,
          "importance": 80,
          "scope": "ecosystem",
          "shareable": true
        }
      ]
    },
    {
      "kind": "mappings",
      "active": [
        {
          "id": 1,
          "category": "PROJECT_FACTS",
          "content": "Fact 1",
          "normalized_hash": "hash-1",
          "normalizedHash": "hash-1",
          "importance": 50,
          "scope": "project",
          "shareable": false,
          "unclassified": true,
          "open_classification": false,
          "unmapped": true,
          "has_sentinel": false,
          "files": [],
          "mapping_origin": null
        },
        {
          "id": 2,
          "category": "PROJECT_RULES",
          "content": "Never modify src/a.ts.",
          "normalized_hash": "hash-2",
          "normalizedHash": "hash-2",
          "importance": 50,
          "scope": "project",
          "shareable": false,
          "unclassified": true,
          "open_classification": false,
          "unmapped": true,
          "has_sentinel": false,
          "files": [],
          "mapping_origin": null
        }
      ],
      "text": "<mappings><memory id=\"1\" files=\"../escape,src/b.rs,src/a.ts,src/b.rs\"/><memory id=\"2\" files=\"src/a.ts\"/></mappings>",
      "result": {
        "ok": {
          "mapped": 1,
          "independent": 1
        }
      },
      "writes": [
        {
          "id": 1,
          "files": [
            "src/a.ts",
            "src/b.rs"
          ],
          "origin": "mapper"
        },
        {
          "id": 2,
          "files": [],
          "origin": "host_rejected_fallback"
        }
      ]
    },
    {
      "kind": "mappings",
      "active": [
        {
          "id": 1,
          "category": "PROJECT_FACTS",
          "content": "Fact 1",
          "normalized_hash": "hash-1",
          "normalizedHash": "hash-1",
          "importance": 50,
          "scope": "project",
          "shareable": false,
          "unclassified": true,
          "open_classification": false,
          "unmapped": true,
          "has_sentinel": false,
          "files": [],
          "mapping_origin": null
        },
        {
          "id": 2,
          "category": "PROJECT_FACTS",
          "content": "Fact 2",
          "normalized_hash": "hash-2",
          "normalizedHash": "hash-2",
          "importance": 50,
          "scope": "project",
          "shareable": false,
          "unclassified": true,
          "open_classification": false,
          "unmapped": true,
          "has_sentinel": false,
          "files": [],
          "mapping_origin": null
        }
      ],
      "text": "<mappings><memory id=\"1\" files=\"../escape\"/><memory id=\"99\" independent=\"true\"/></mappings>",
      "result": {
        "ok": {
          "mapped": 0,
          "independent": 1
        }
      },
      "writes": [
        {
          "id": 1,
          "files": [],
          "origin": "host_rejected_fallback"
        }
      ]
    },
    {
      "kind": "mappings",
      "active": [
        {
          "id": 1,
          "category": "PROJECT_FACTS",
          "content": "Fact 1",
          "normalized_hash": "hash-1",
          "normalizedHash": "hash-1",
          "importance": 50,
          "scope": "project",
          "shareable": false,
          "unclassified": true,
          "open_classification": false,
          "unmapped": true,
          "has_sentinel": false,
          "files": [],
          "mapping_origin": null
        },
        {
          "id": 2,
          "category": "PROJECT_FACTS",
          "content": "Fact 2",
          "normalized_hash": "hash-2",
          "normalizedHash": "hash-2",
          "importance": 50,
          "scope": "project",
          "shareable": false,
          "unclassified": true,
          "open_classification": false,
          "unmapped": true,
          "has_sentinel": false,
          "files": [],
          "mapping_origin": null
        },
        {
          "id": 3,
          "category": "PROJECT_FACTS",
          "content": "Fact 3",
          "normalized_hash": "hash-3",
          "normalizedHash": "hash-3",
          "importance": 50,
          "scope": "project",
          "shareable": false,
          "unclassified": true,
          "open_classification": false,
          "unmapped": true,
          "has_sentinel": false,
          "files": [],
          "mapping_origin": null
        }
      ],
      "text": "<mappings><memory id=\"99\" independent=\"true\"/></mappings>",
      "result": {
        "err": "mappings manifest covers 0/3 batch ids after filtering unknown entries; rejecting mostly-wrong manifest"
      },
      "writes": []
    }
  ],
  "runs": [
    {
      "name": "map-omission-retry",
      "n": 4,
      "responses": [
        {
          "text": "<mappings><memory id=\"1\" files=\"src/a.ts\"/><memory id=\"2\" independent=\"true\"/></mappings>"
        },
        {
          "text": "<mappings><memory id=\"3\" independent=\"true\"/></mappings>"
        }
      ],
      "result": {
        "ok": {
          "mapped": 1,
          "independent": 2,
          "batches": 2,
          "remaining": 1,
          "complete": false
        }
      },
      "writes": [
        {
          "id": 1,
          "files": [
            "src/a.ts"
          ],
          "origin": "mapper"
        },
        {
          "id": 2,
          "files": [],
          "origin": "mapper"
        },
        {
          "id": 3,
          "files": [],
          "origin": "mapper"
        }
      ]
    },
    {
      "name": "map-budget-finalized",
      "n": 4,
      "responses": [
        {
          "text": "<mappings><memory id=\"1\" independent=\"true\"/></mappings>",
          "finalize": true
        }
      ],
      "result": {
        "ok": {
          "mapped": 0,
          "independent": 1,
          "batches": 1,
          "remaining": 3,
          "complete": false
        }
      },
      "writes": [
        {
          "id": 1,
          "files": [],
          "origin": "mapper"
        }
      ]
    },
    {
      "name": "map-timeout-circuit-breaker",
      "n": 41,
      "responses": [
        {
          "timeout": true
        },
        {
          "timeout": true
        }
      ],
      "result": {
        "ok": {
          "mapped": 0,
          "independent": 0,
          "batches": 0,
          "remaining": 41,
          "complete": false,
          "stopReason": "timeout-circuit-breaker"
        }
      },
      "writes": []
    },
    {
      "name": "map-no-time",
      "n": 2,
      "responses": [],
      "deadline": 200000,
      "result": {
        "ok": {
          "mapped": 0,
          "independent": 0,
          "batches": 0,
          "remaining": 2,
          "complete": false,
          "stopReason": "deadline"
        }
      },
      "writes": []
    },
    {
      "name": "map-wrong-shape",
      "n": 2,
      "responses": [
        {
          "text": "<map/>"
        }
      ],
      "result": {
        "ok": {
          "mapped": 0,
          "independent": 0,
          "batches": 0,
          "remaining": 2,
          "complete": false
        }
      },
      "writes": []
    },
    {
      "name": "classify-success",
      "n": 10,
      "responses": [
        {
          "text": "<classify><memory id=\"1\" importance=\"1\" shareable=\"true\"/><memory id=\"2\" importance=\"2\" shareable=\"true\"/><memory id=\"3\" importance=\"3\" shareable=\"true\"/><memory id=\"4\" importance=\"4\" shareable=\"true\"/><memory id=\"5\" importance=\"5\" shareable=\"true\"/><memory id=\"6\" importance=\"6\" shareable=\"true\"/><memory id=\"7\" importance=\"7\" shareable=\"true\"/><memory id=\"8\" importance=\"8\" shareable=\"true\"/><memory id=\"9\" importance=\"9\" shareable=\"true\"/><memory id=\"10\" importance=\"10\" shareable=\"true\"/></classify>"
        }
      ],
      "result": {
        "ok": {
          "classified": 10,
          "changed": 10,
          "chunks": 1,
          "stage": 2,
          "remaining": 0,
          "complete": true
        }
      },
      "writes": [
        {
          "id": 1,
          "importance": 1,
          "shareable": true
        },
        {
          "id": 2,
          "importance": 2,
          "shareable": true
        },
        {
          "id": 3,
          "importance": 3,
          "shareable": true
        },
        {
          "id": 4,
          "importance": 4,
          "shareable": true
        },
        {
          "id": 5,
          "importance": 5,
          "shareable": true
        },
        {
          "id": 6,
          "importance": 6,
          "shareable": true
        },
        {
          "id": 7,
          "importance": 7,
          "shareable": true
        },
        {
          "id": 8,
          "importance": 8,
          "shareable": true
        },
        {
          "id": 9,
          "importance": 9,
          "shareable": true
        },
        {
          "id": 10,
          "importance": 10,
          "shareable": true
        }
      ]
    },
    {
      "name": "classify-invalid",
      "n": 10,
      "responses": [
        {
          "text": "<classify><memory id=\"1\" importance=\"10\"/></classify>"
        }
      ],
      "result": {
        "ok": {
          "classified": 0,
          "changed": 0,
          "chunks": 1,
          "stage": 2,
          "remaining": 10,
          "complete": false
        }
      },
      "writes": []
    }
  ]
}"####;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dream_runner::{CarrierError, ChildRequest, Completion, Usage};
    use serde_json::json;
    use sha2::{Digest, Sha256};
    use std::collections::VecDeque;

    fn vectors() -> Value {
        serde_json::from_str(TS_VECTORS).unwrap()
    }
    fn memory(id: i64) -> Memory {
        Memory {
            id,
            category: "PROJECT_FACTS".into(),
            content: format!("Fact {id}"),
            normalized_hash: format!("hash-{id}"),
            importance: Some(50),
            scope: Some("project".into()),
            shareable: false,
            unclassified: true,
            open_classification: false,
            unmapped: true,
            has_sentinel: false,
            files: vec![],
            mapping_origin: None,
        }
    }
    fn result<T: Serialize>(value: Result<T, String>) -> Value {
        match value {
            Ok(v) => json!({"ok":v}),
            Err(e) => json!({"err":e}),
        }
    }
    fn memories(value: &Value) -> Vec<Memory> {
        serde_json::from_value(value.clone()).unwrap()
    }
    fn exists(path: &str) -> bool {
        matches!(path, "src/a.ts" | "src/b.rs" | "src/c.py" | "src/d.go")
    }
    fn normalize(files: &[String]) -> Result<Vec<String>, String> {
        let mut files: Vec<_> = files.iter().filter(|f| exists(f)).cloned().collect();
        files.sort();
        files.dedup();
        Ok(files)
    }
    fn sensitivity() -> SensitiveContext {
        SensitiveContext {
            home: "/home/fixture".into(),
            username: "fixtureuser".into(),
        }
    }

    #[test]
    fn classify_parser_matches_pinned_ts() {
        for v in vectors()["parsers"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|v| v["kind"] == "classify")
        {
            let ids: Vec<i64> = serde_json::from_value(v["ids"].clone()).unwrap();
            assert_eq!(
                result(validate_classify_manifest(
                    v["text"].as_str().unwrap(),
                    &ids
                )),
                v["result"],
                "{}",
                v["text"]
            );
        }
    }
    #[test]
    fn map_parser_matches_pinned_ts() {
        for v in vectors()["parsers"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|v| v["kind"] == "mappings")
        {
            let ids: Vec<i64> = serde_json::from_value(v["ids"].clone()).unwrap();
            assert_eq!(
                result(validate_map_manifest(v["text"].as_str().unwrap(), &ids)),
                v["result"],
                "{}",
                v["text"]
            );
        }
    }
    #[test]
    fn classify_selection_and_anchors_match_pinned_ts() {
        for v in vectors()["plans"].as_array().unwrap() {
            let active: Vec<_> = (0..v["n"].as_i64().unwrap())
                .map(|i| {
                    let mut m = memory(i + 1);
                    m.unclassified = i % 3 == 0;
                    m.open_classification = i % 9 == 0;
                    m.importance = Some((i % 101) as i32);
                    m
                })
                .collect();
            assert_eq!(
                serde_json::to_value(plan_classify(&active)).unwrap(),
                v["result"],
                "pool {}",
                active.len()
            );
        }
    }
    #[test]
    fn prompts_match_pinned_ts_bytes() {
        let v = &vectors()["prompts"];
        let memories = memories(&v["memories"]);
        let inputs: Vec<MapInput> = serde_json::from_value(v["inputs"].clone()).unwrap();
        assert_eq!(
            build_classify_prompt("/repo", &memories, &memories[1..]),
            v["classify"]
        );
        assert_eq!(build_map_prompt("/repo", &inputs), v["map"]);
        assert_eq!(
            format!("{:x}", Sha256::digest(CLASSIFY_SYSTEM_PROMPT)),
            "b288cfd1baad087ec20f23b44f747fbe1bad93807e91b0b1c6de8f2df0dddadb"
        );
        assert_eq!(
            format!("{:x}", Sha256::digest(MAP_MEMORIES_SYSTEM_PROMPT)),
            "8c8c800f26411aedea708128875967244b8a940f82d8125a3ba15f35e5f817f1"
        );
    }
    #[test]
    fn sensitive_text_stays_private_like_pinned_ts() {
        for v in vectors()["sensitivities"].as_array().unwrap() {
            assert_eq!(
                sensitive_text(v["text"].as_str().unwrap(), &sensitivity()),
                v["result"],
                "{}",
                v["text"]
            );
        }
        let mut m = memory(1);
        m.content = "localhost:9000".into();
        let parsed = validate_classify_manifest(
            "<classify><memory id=\"1\" shareable=\"true\"/></classify>",
            &[1],
        )
        .unwrap();
        assert_eq!(
            classification_updates(&[m], &parsed, &sensitivity())[0].shareable,
            Some(false)
        );
    }
    #[test]
    fn directive_mapping_gate_matches_pinned_ts() {
        for v in vectors()["directives"].as_array().unwrap() {
            assert_eq!(
                directive_shaped_rule(v["category"].as_str().unwrap(), v["text"].as_str().unwrap()),
                v["result"],
                "{v}"
            );
        }
    }
    #[test]
    fn map_selection_heals_only_bounded_mapper_independence_like_ts() {
        let v = &vectors()["mapSelection"];
        assert_eq!(
            serde_json::to_value(select_map_inputs(&memories(&v["active"]), exists)).unwrap(),
            v["result"]
        );
        assert_eq!(
            candidate_paths("src/a.ts src/b.rs src/a.ts ../src/c.py src/d.go", exists),
            vec!["src/a.ts", "src/b.rs", "src/d.go"]
        );
    }
    #[test]
    fn mapping_slices_match_pinned_ts() {
        for v in vectors()["slices"].as_array().unwrap() {
            assert_eq!(
                map_batch_slice_ms(
                    v["remaining"].as_u64().unwrap(),
                    v["batches"].as_u64().unwrap() as usize
                ),
                v["result"]
            );
        }
    }

    struct Host {
        active: Vec<Memory>,
        answers: VecDeque<Value>,
        writes: Vec<Value>,
        requests: Vec<ChildRequest>,
        finalized: bool,
        lost: bool,
        attempts: usize,
    }
    impl Host {
        fn new(active: Vec<Memory>, answers: Vec<Value>) -> Self {
            Self {
                active,
                answers: answers.into(),
                writes: vec![],
                requests: vec![],
                finalized: false,
                lost: false,
                attempts: 0,
            }
        }
    }
    impl DreamCarrier for Host {
        async fn open(&mut self, request: &ChildRequest) -> Result<String, CarrierError> {
            self.requests.push(request.clone());
            Ok("child".into())
        }
        async fn complete(
            &mut self,
            _child: &str,
            _request: &ChildRequest,
        ) -> Result<Completion, CarrierError> {
            let answer = self
                .answers
                .pop_front()
                .expect("recorded completion exists");
            if answer["timeout"] == true {
                return std::future::pending().await;
            }
            self.finalized = answer["finalize"] == true;
            if answer["lose_lease"] == true {
                self.lost = true;
            }
            Ok(Completion {
                text: answer["text"].as_str().unwrap().into(),
                length_capped: answer["length_capped"] == true,
                usage: Usage::default(),
            })
        }
        async fn close(&mut self, _child: &str, _settled: bool) -> Result<(), CarrierError> {
            Ok(())
        }
    }
    impl TaskHost for Host {
        fn check_control(&self) -> Result<(), TaskError> {
            if self.lost {
                Err(TaskError::LeaseLost)
            } else {
                Ok(())
            }
        }
        fn now_ms(&self) -> u64 {
            1000
        }
        fn path_exists(&self, path: &str) -> bool {
            exists(path)
        }
        fn normalize_files(&self, files: &[String]) -> Result<Vec<String>, String> {
            normalize(files)
        }
        fn budget_finalized(&self) -> bool {
            self.finalized
        }
        fn record_attempts(&mut self, _task: &str, attempts: &[dream_runner::Attempt]) {
            self.attempts += attempts.len();
        }
        fn commit_classifications(
            &mut self,
            rows: &[ClassificationUpdate],
        ) -> Result<(usize, usize), TaskError> {
            let mut classified = 0;
            let mut changed = 0;
            for row in rows {
                let Some(m) = self.active.iter_mut().find(|m| {
                    m.id == row.memory_id && m.normalized_hash == row.content_hash_at_prompt
                }) else {
                    continue;
                };
                let mut write = json!({"id":row.memory_id});
                if let Some(v) = row.importance {
                    write["importance"] = json!(v);
                }
                if let Some(v) = &row.scope {
                    write["scope"] = json!(v);
                }
                if let Some(v) = row.shareable {
                    write["shareable"] = json!(v);
                }
                self.writes.push(write);
                changed += usize::from(
                    row.importance.is_some_and(|v| Some(v) != m.importance)
                        || row
                            .scope
                            .as_ref()
                            .is_some_and(|v| Some(v) != m.scope.as_ref())
                        || row.shareable.is_some_and(|v| v != m.shareable),
                );
                classified += 1;
                m.unclassified = false;
                if let Some(v) = row.importance {
                    m.importance = Some(v);
                }
                if let Some(v) = &row.scope {
                    m.scope = Some(v.clone());
                }
                if let Some(v) = row.shareable {
                    m.shareable = v;
                }
            }
            Ok((classified, changed))
        }
        fn commit_mappings(&mut self, rows: &[MappingUpdate]) -> Result<Vec<i64>, TaskError> {
            let mut accepted = vec![];
            for row in rows {
                let Some(m) = self.active.iter_mut().find(|m| {
                    m.id == row.memory_id && m.normalized_hash == row.content_hash_at_prompt
                }) else {
                    continue;
                };
                self.writes.push(json!({"id":row.memory_id,"files":row.mapped_files.clone().unwrap_or_default(),"origin":row.mapping_origin}));
                accepted.push(m.id);
                m.unmapped = false;
                m.files = row.mapped_files.clone().unwrap_or_default();
                m.has_sentinel = m.files.is_empty();
                m.mapping_origin = Some(row.mapping_origin.clone());
            }
            Ok(accepted)
        }
    }
    #[test]
    fn apply_plans_match_pinned_ts_and_carry_prompt_hashes() {
        for v in vectors()["apply"].as_array().unwrap() {
            let active = memories(&v["active"]);
            let mut host = Host::new(active.clone(), vec![]);
            let text = v["text"].as_str().unwrap();
            let actual = if v["kind"] == "classify" {
                let ids: Vec<_> = active.iter().map(|m| m.id).collect();
                result(validate_classify_manifest(text, &ids).map(|p| {
                    let rows = classification_updates(&active, &p, &sensitivity());
                    for row in &rows {
                        assert_eq!(
                            row.content_hash_at_prompt,
                            format!("hash-{}", row.memory_id)
                        );
                    }
                    let (classified, changed) = host.commit_classifications(&rows).unwrap();
                    json!({"classified":classified,"changed":changed})
                }))
            } else {
                result(parse_map_manifest(text).and_then(|p|mapping_updates(&active,&p,false,normalize)).map(|rows| {
                    for row in &rows {assert_eq!(row.content_hash_at_prompt,format!("hash-{}",row.memory_id));}
                    host.commit_mappings(&rows).unwrap();
                    json!({"mapped":rows.iter().filter(|r|r.mapped_files.is_some()).count(),"independent":rows.iter().filter(|r|r.mapped_files.is_none()).count()})
                }))
            };
            assert_eq!(actual, v["result"], "{text}");
            assert_eq!(json!(host.writes), v["writes"], "{text}");
        }
    }
    fn context<'a>(
        config: &'a McModuleConfig,
        trusted: &'a Value,
        sensitive: &'a SensitiveContext,
        deadline: u64,
    ) -> TaskContext<'a> {
        TaskContext {
            route_config: config,
            trusted_config: trusted,
            harness: "pi",
            parent_session_id: "parent",
            directory: Path::new("/repo"),
            project: "/repo",
            deadline_ms: deadline,
            token_budget: Some(1000),
            sensitive,
        }
    }
    #[tokio::test]
    async fn classify_runs_match_pinned_ts() {
        run_vectors(false).await;
    }
    #[tokio::test]
    async fn map_runs_match_pinned_ts() {
        run_vectors(true).await;
    }
    async fn run_vectors(map: bool) {
        for v in vectors()["runs"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|v| v["name"].as_str().unwrap().starts_with("map") == map)
        {
            let config = McModuleConfig::default();
            let sensitive = sensitivity();
            // A real short runner timer, not a string masquerading as a timeout,
            // exercises the same Timeout branch as a production slice expiry.
            let trusted = if v["name"] == "map-timeout-circuit-breaker" {
                json!({"dreamer":{"pi":{"tasks":{"map-memories":{"timeout_minutes":0.0000167}}}}})
            } else {
                json!({})
            };
            let context = context(
                &config,
                &trusted,
                &sensitive,
                v["deadline"].as_u64().unwrap_or(10_000_000),
            );
            let active: Vec<_> = (1..=v["n"].as_i64().unwrap()).map(memory).collect();
            let mut host = Host::new(active.clone(), v["responses"].as_array().unwrap().clone());
            let actual = if map {
                json!({"ok":run_map(true,&context,&active,&mut host).await.unwrap().unwrap()})
            } else {
                json!({"ok":run_classify(true,&context,&active,&mut host).await.unwrap().unwrap()})
            };
            assert_eq!(actual, v["result"], "{}", v["name"]);
            assert_eq!(json!(host.writes), v["writes"], "{}", v["name"]);
            assert_eq!(host.attempts, host.requests.len());
            for req in &host.requests {
                assert_eq!(
                    req.agent,
                    if map {
                        "dreamer-memory-mapper"
                    } else {
                        "dreamer-classifier"
                    }
                );
                assert_eq!(req.temperature, None);
                assert_eq!(
                    req.system,
                    if map {
                        MAP_MEMORIES_SYSTEM_PROMPT
                    } else {
                        CLASSIFY_SYSTEM_PROMPT
                    }
                );
            }
        }
    }
    #[tokio::test]
    async fn inactive_tasks_and_lease_loss_do_not_write() {
        let config = McModuleConfig::default();
        let trusted = json!({});
        let sensitive = sensitivity();
        let context = context(&config, &trusted, &sensitive, 10_000_000);
        let active: Vec<_> = (1..=10).map(memory).collect();
        let mut host = Host::new(active.clone(), vec![]);
        assert_eq!(
            run_classify(false, &context, &active, &mut host)
                .await
                .unwrap(),
            None
        );
        assert_eq!(
            run_map(false, &context, &active, &mut host).await.unwrap(),
            None
        );
        assert!(host.requests.is_empty());
        assert!(host.writes.is_empty());
        host.answers.push_back(json!({"text":"<mappings><memory id=\"1\" independent=\"true\"/></mappings>","lose_lease":true}));
        assert_eq!(
            run_map(true, &context, &active[..1], &mut host).await,
            Err(TaskError::LeaseLost)
        );
        assert!(host.writes.is_empty());
    }
    #[tokio::test]
    async fn classifier_fallback_validates_before_committing() {
        let config = McModuleConfig::default();
        let trusted = json!({"dreamer":{"pi":{"model":"primary/model","fallback_models":["fallback/model"]}}});
        let sensitive = sensitivity();
        let context = context(&config, &trusted, &sensitive, 10_000_000);
        let active: Vec<_> = (1..=10).map(memory).collect();
        let valid = format!(
            "<classify>{}</classify>",
            (1..=10)
                .map(|id| format!("<memory id=\"{id}\" importance=\"60\"/>"))
                .collect::<String>()
        );
        let mut host = Host::new(
            active.clone(),
            vec![json!({"text":"<classify/>"}), json!({"text":valid})],
        );
        let result = run_classify(true, &context, &active, &mut host)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.classified, 10);
        assert_eq!(host.writes.len(), 10);
        assert_eq!(host.attempts, 2);
        assert_eq!(
            host.requests[1].model.as_ref().unwrap().model,
            "fallback/model"
        );
    }
}
