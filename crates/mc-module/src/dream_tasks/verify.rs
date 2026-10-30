//! Off-thread verification and declared-TTL expiry. Callers provide recorded or
//! host-resolved Git evidence and a lease guard. Existing user-facing memory tools
//! do not invoke this code.

pub use crate::memory_actions::{
    EmbeddingEffect, EmbeddingEffectKind, MemoryActionContext, MemoryEmbeddingQueue, MemoryRole,
};
use mc_store::compute_normalized_memory_hash;
use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

pub const BATCH_SIZE: usize = 20;
pub const BATCH_FLOOR_MS: i64 = 240_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Memory {
    pub id: i64,
    pub category: String,
    pub content: String,
    pub revision: i64,
    pub content_hash: String,
    pub files: Vec<String>,
    pub verified_at: i64,
    #[serde(default)]
    pub verified_commit: Option<String>,
}

/// None means Git failed, not that no files changed. Missing mapped files are
/// represented separately from Git's committed and working-tree changes.
#[derive(Default)]
pub struct Changes {
    pub committed_at: Option<BTreeMap<String, i64>>,
    pub uncommitted: BTreeSet<String>,
    pub missing: BTreeSet<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Scope {
    pub mode: &'static str,
    pub selected: Vec<usize>,
    pub skipped: Vec<i64>,
    pub unmapped: Vec<usize>,
}

pub fn partition(memories: &[Memory], changes: &Changes, broad_start: Option<i64>) -> Scope {
    let mut scope = Scope {
        mode: if broad_start.is_some() {
            "broad"
        } else if changes.committed_at.is_none() {
            "full"
        } else {
            "incremental"
        },
        selected: vec![],
        skipped: vec![],
        unmapped: vec![],
    };
    for (index, memory) in memories.iter().enumerate() {
        if memory.files.is_empty() {
            scope.unmapped.push(index);
            continue;
        }
        let needs = if let Some(start) = broad_start {
            memory.verified_at < start
        } else {
            changes.committed_at.as_ref().is_none_or(|times| {
                memory.verified_at == 0
                    || memory.files.iter().any(|file| {
                        changes.missing.contains(file)
                            || changes.uncommitted.contains(file)
                            || times.get(file).copied().unwrap_or(0) >= memory.verified_at - 1_000
                    })
            })
        };
        if needs {
            scope.selected.push(index);
        } else {
            scope.skipped.push(memory.id);
        }
    }
    if broad_start.is_some() {
        scope
            .selected
            .sort_by_key(|i| (memories[*i].verified_at, memories[*i].id));
    } else if scope.selected.is_empty() && scope.skipped.is_empty() {
        scope.mode = "incremental";
    }
    scope
}

pub fn batch_slice_ms(remaining_ms: i64, batches_remaining: usize) -> i64 {
    remaining_ms.min(BATCH_FLOOR_MS.max(remaining_ms / batches_remaining.max(1) as i64))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EvidenceFile {
    pub path: String,
    pub text: String,
    pub memory_ids: Vec<i64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DiffEvidence {
    pub head: String,
    pub mode: String,
    pub files: Vec<EvidenceFile>,
}

/// The host collects Git diffs for each mapped file from the earliest time a
/// memory using that file was verified. If obtaining a Git base or diff fails,
/// return None so the model reads source. Large diffs become line-range headers
/// with change counts, keeping the verification prompt small enough to process.
pub fn bounded_evidence(head: String, mut files: Vec<EvidenceFile>) -> DiffEvidence {
    let ranges = files
        .iter()
        .map(|f| f.text.encode_utf16().count())
        .sum::<usize>()
        > 36_000;
    if ranges {
        for file in &mut files {
            let lines = file.text.split('\n').collect::<Vec<_>>();
            let headers = lines
                .iter()
                .copied()
                .filter(|line| {
                    [
                        "@@",
                        "diff --git",
                        "rename ",
                        "deleted file mode",
                        "new file mode",
                        "RENAMED",
                        "DELETED",
                        "Uncommitted changes:",
                    ]
                    .iter()
                    .any(|prefix| line.starts_with(prefix))
                })
                .collect::<Vec<_>>()
                .join("\n");
            let added = lines
                .iter()
                .filter(|l| l.starts_with('+') && !l.starts_with("+++"))
                .count();
            let removed = lines
                .iter()
                .filter(|l| l.starts_with('-') && !l.starts_with("---"))
                .count();
            file.text=format!("Changed lines: +{added}/-{removed}.\n{headers}\nRead only these changed line ranges if they may affect the claim.");
        }
    }
    DiffEvidence {
        head,
        mode: if ranges { "ranges" } else { "diff" }.into(),
        files,
    }
}

pub fn build_prompt(
    project: &str,
    batch: &[Memory],
    evidence: Option<&DiffEvidence>,
) -> Result<String, String> {
    build_prompt_with_mode(project, batch, evidence, "full")
}

pub(crate) fn build_prompt_with_mode(
    project: &str,
    batch: &[Memory],
    evidence: Option<&DiffEvidence>,
    mode: &str,
) -> Result<String, String> {
    let list = batch
        .iter()
        .map(|m| {
            format!(
                "[{}] {}\nContent: {}\nBacking files: {}",
                m.id,
                m.category,
                m.content,
                m.files.join(", ")
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let suffix = evidence
        .map(|e| {
            format!(
                "\n\n<changed-files mode=\"{}\">\n{}\n</changed-files>",
                e.mode,
                e.files
                    .iter()
                    .map(|f| format!(
                        "File: {} (memories: {})\n{}",
                        f.path,
                        f.memory_ids
                            .iter()
                            .map(i64::to_string)
                            .collect::<Vec<_>>()
                            .join(", "),
                        f.text
                    ))
                    .collect::<Vec<_>>()
                    .join("\n\n")
            )
        })
        .unwrap_or_default();
    crate::persona_host::dream::task_with_mode(
        crate::persona_host::dream::Kind::Verify,
        &crate::persona_host::dream::Input {
            project,
            memories: &list,
            has_evidence: evidence.is_some(),
            evidence: &suffix,
            ..Default::default()
        },
        mode,
    )
    .map_err(|error| format!("mc_persona_invalid: {error}"))
}

pub fn batches(memories: &[Memory], scope: &Scope) -> Vec<Vec<Memory>> {
    let groups = if scope.mode == "incremental" {
        vec![
            scope
                .selected
                .iter()
                .copied()
                .filter(|i| memories[*i].verified_at != 0)
                .collect::<Vec<_>>(),
            scope
                .selected
                .iter()
                .copied()
                .filter(|i| memories[*i].verified_at == 0)
                .collect(),
        ]
    } else {
        vec![scope.selected.clone()]
    };
    groups
        .into_iter()
        .flat_map(|group| {
            group
                .chunks(BATCH_SIZE)
                .map(|chunk| chunk.iter().map(|i| memories[*i].clone()).collect())
                .collect::<Vec<_>>()
        })
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Verdict {
    pub id: i64,
    pub kind: String,
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub consolidation: bool,
}

fn attr(text: &str, name: &str) -> Option<String> {
    Regex::new(&format!(r#"\b{name}\s*=\s*"([^"]*)""#))
        .unwrap()
        .captures(text)
        .map(|c| c[1].to_owned())
}

/// The closing root is mandatory: a truncated completion must never commit its
/// apparently valid prefix. Unknown ids are dropped before duplicate/coverage checks.
pub fn parse_manifest(
    text: &str,
    expected: &[Memory],
    finalized: bool,
) -> Result<Vec<Verdict>, String> {
    let root = Regex::new(r"(?is)<verify\b[^>]*>(.*?)</verify>").unwrap();
    let body = root
        .captures(text)
        .ok_or("verify manifest missing complete root element")?;
    let expected: BTreeSet<_> = expected.iter().map(|m| m.id).collect();
    let mut entries = vec![];
    let mut recognized = 0;
    let mut seen = BTreeSet::new();
    let prefix = Regex::new(r"^[\s\x{feff}]*([+-]?[0-9]+)").unwrap();
    for (tag, kind) in [
        ("verified", "verified"),
        ("update", "update"),
        ("archive", "archive"),
        ("skip", "skipped"),
    ] {
        let pattern = if tag == "update" {
            r"(?s)<update\b([^>]*?)(?:/>|>(.*?)</update>)".to_owned()
        } else {
            format!(r"<{tag}\b([^>]*)/?>")
        };
        for capture in Regex::new(&pattern).unwrap().captures_iter(&body[1]) {
            // Accept an integer prefix with an optional sign, ignoring trailing text.
            let raw = attr(&capture[1], "id").unwrap_or_default();
            let id = prefix
                .captures(&raw)
                .and_then(|c| c[1].parse::<i64>().ok())
                .ok_or("verify manifest entry missing numeric id")?;
            recognized += 1;
            if !expected.contains(&id) {
                continue;
            }
            if !seen.insert(id) {
                return Err(format!("verify manifest contains duplicate id {id}"));
            }
            entries.push(Verdict {
                id,
                kind: kind.into(),
                files: attr(&capture[1], "files")
                    .unwrap_or_default()
                    .split(',')
                    .map(js_trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .collect(),
                content: capture
                    .get(2)
                    .map_or("", |m| js_trim(m.as_str()))
                    .to_owned(),
                reason: attr(&capture[1], "reason").unwrap_or_default(),
                consolidation: attr(&capture[1], "consolidation")
                    .is_some_and(|s| s.to_lowercase() == "true"),
            });
        }
    }
    if !expected.is_empty() && recognized == 0 {
        return Err("verify manifest parsed zero entries".into());
    }
    if !finalized && entries.len() * 2 < expected.len() {
        return Err("verify manifest covers fewer than half the batch ids".into());
    }
    Ok(entries)
}

fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}

fn directive(memory: &Memory) -> bool {
    if memory.category != "PROJECT_RULES" {
        return false;
    }
    [r"(?:^|[.!?]\s+|\n\s*)(?:[-*]\s+|\d+[.)]\s+)?(?:you\s+|we\s+)?(?:must(?:\s+not)?|never|always|do\s+not|don't|shall\s+not)\b",
     r"\b(?:you|we|agents?|masons?|workers?|operators?|users?|maintainers?)\s+(?:must(?:\s+not)?|should(?:\s+not)?|need\s+to|shall(?:\s+not)?|cannot|can't|may\s+not)\b",
     r"\bwhen\s+(?:you(?:'re|\s+are)?|we(?:'re|\s+are)?|told|asked|requested|working|debugging|reviewing|checking|verifying|investigating|using|running|editing|changing)\b",
     r"(?:^|[.!?]\s+|\n\s*)(?:[-*]\s+|\d+[.)]\s+)?(?:please\s+)?(?:run|use|check|ask|avoid|prefer|ensure|keep|follow|brief|report|inspect|search|open|read|review|validate|confirm|delegate|stop|start|remember)\b",
     r"\b(?:the\s+)?(?:user|operator|maintainer|owner)\s+(?:decides|chooses|approves|has\s+(?:the\s+)?final\s+say)\b"]
        .iter().any(|pattern| Regex::new(&format!("(?i){pattern}").replace("\\b", r"(?-u:\b)").replace("\\d", "[0-9]").replace("\\s", r"[\t\n\x0B\x0C\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]" )).unwrap().is_match(js_trim(&memory.content)))
}

#[derive(Default, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Counts {
    pub verified: usize,
    pub updated: usize,
    pub archived: usize,
    pub skipped: usize,
    pub refused: usize,
}
impl Counts {
    fn count(&mut self, kind: &str, result: &Value) {
        let value = result["verificationResult"].as_str().unwrap_or("failed");
        if result["state"] == "applied"
            && kind == "update"
            && ["updated", "unmapped"].contains(&value)
        {
            self.updated += 1;
        } else if value == "archived" && result["state"] == "applied" {
            self.archived += 1;
        } else if value == "confirmed" {
            self.verified += 1;
        } else if kind == "skipped" {
            self.skipped += 1;
        } else if kind != "failed" && kind != "unmapped" {
            self.refused += 1;
        }
    }
    fn processed(&self) -> usize {
        self.verified + self.updated + self.archived + self.skipped + self.refused
    }
}

fn error(message: impl Into<String>) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(message.into())))
}

fn row_json(conn: &Connection, id: i64) -> rusqlite::Result<Option<Value>> {
    let mut statement = conn.prepare("SELECT * FROM memories WHERE id=?1")?;
    let names = statement
        .column_names()
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    statement
        .query_row([id], |row| {
            let mut fields = serde_json::Map::new();
            for (i, name) in names.iter().enumerate() {
                use rusqlite::types::ValueRef;
                let value = match row.get_ref(i)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(v) => json!(v),
                    ValueRef::Real(v) => json!(v),
                    ValueRef::Text(v) => json!(String::from_utf8_lossy(v)),
                    ValueRef::Blob(_) => return Err(error("unexpected memory blob")),
                };
                fields.insert(name.clone(), value);
            }
            Ok(Value::Object(fields))
        })
        .optional()
}

// Metadata is stored as JSON text. Preserve object insertion order recursively
// when adding stamps, rather than reordering existing user metadata on every run.
#[derive(Clone)]
enum Metadata {
    Scalar(Value),
    Array(Vec<Metadata>),
    Object(Vec<(String, Metadata)>),
}
impl<'de> Deserialize<'de> for Metadata {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = Metadata;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("JSON metadata")
            }
            fn visit_unit<E: serde::de::Error>(self) -> Result<Metadata, E> {
                Ok(Metadata::Scalar(Value::Null))
            }
            fn visit_bool<E: serde::de::Error>(self, v: bool) -> Result<Metadata, E> {
                Ok(Metadata::Scalar(json!(v)))
            }
            fn visit_i64<E: serde::de::Error>(self, v: i64) -> Result<Metadata, E> {
                Ok(Metadata::Scalar(json!(v)))
            }
            fn visit_u64<E: serde::de::Error>(self, v: u64) -> Result<Metadata, E> {
                Ok(Metadata::Scalar(json!(v)))
            }
            fn visit_f64<E: serde::de::Error>(self, v: f64) -> Result<Metadata, E> {
                Ok(Metadata::Scalar(json!(v)))
            }
            fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<Metadata, E> {
                Ok(Metadata::Scalar(json!(v)))
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> Result<Metadata, A::Error> {
                let mut values = vec![];
                while let Some(value) = seq.next_element()? {
                    values.push(value);
                }
                Ok(Metadata::Array(values))
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> Result<Metadata, A::Error> {
                let mut fields: Vec<(String, Metadata)> = vec![];
                while let Some((key, value)) = map.next_entry::<String, Metadata>()? {
                    if let Some(field) = fields.iter_mut().find(|(k, _)| k == &key) {
                        field.1 = value;
                    } else {
                        fields.push((key, value));
                    }
                }
                // ECMAScript enumerates array-index property names before other keys.
                let index = |key: &str| {
                    key.parse::<u32>()
                        .ok()
                        .filter(|i| *i < u32::MAX && i.to_string() == key)
                };
                fields.sort_by_key(|(key, _)| index(key).map_or((1, 0), |i| (0, i)));
                Ok(Metadata::Object(fields))
            }
        }
        deserializer.deserialize_any(Visitor)
    }
}
impl Serialize for Metadata {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Scalar(value) => value.serialize(serializer),
            Self::Array(values) => values.serialize(serializer),
            Self::Object(fields) => {
                use serde::ser::SerializeMap;
                let mut map = serializer.serialize_map(Some(fields.len()))?;
                for (key, value) in fields {
                    map.serialize_entry(key, value)?;
                }
                map.end()
            }
        }
    }
}
fn metadata_with(row: &Value, updates: &[(&str, Value)]) -> String {
    let mut fields = match row["metadata_json"]
        .as_str()
        .and_then(|s| serde_json::from_str::<Metadata>(s).ok())
    {
        Some(Metadata::Object(fields)) => fields,
        _ => vec![],
    };
    for (key, value) in updates {
        if let Some(field) = fields.iter_mut().find(|(k, _)| k == key) {
            field.1 = Metadata::Scalar(value.clone());
        } else {
            fields.push(((*key).into(), Metadata::Scalar(value.clone())));
        }
    }
    serde_json::to_string(&Metadata::Object(fields)).unwrap()
}

fn receipt(
    tx: &Transaction<'_>,
    ctx: &MemoryActionContext<'_>,
    key: &str,
    operation: &str,
    result: &Value,
    after: Option<Value>,
) -> rusqlite::Result<()> {
    tx.execute("INSERT INTO memory_decision_receipts(decision_key,project_path,receipt_json,resolved_at) VALUES(?1,?2,?3,?4)", params![key,ctx.project_path,result.to_string(),ctx.now_ms])?;
    if result["state"] == "applied" {
        tx.execute("INSERT INTO memory_journal(project_path,decision_key,operation,receipt_json,after_json,applied_at) VALUES(?1,?2,?3,?4,?5,?6)", params![ctx.project_path,key,operation,result.to_string(),after.map(|v| v.to_string()),ctx.now_ms])?;
    }
    Ok(())
}

fn history(
    tx: &Transaction<'_>,
    ctx: &MemoryActionContext<'_>,
    before: &Value,
    after: &Value,
    key: &str,
    reason: &str,
) -> rusqlite::Result<()> {
    tx.execute("INSERT INTO memory_history(memory_id,revision,previous_text,after_text,before_json,after_json,applied_at,reason,evidence_json,source_ids_json,decision_key) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'[]',?9,?10)",
        params![before["id"].as_i64(),before["revision"].as_i64(),before["content"].as_str(),after["content"].as_str(),before.to_string(),after.to_string(),ctx.now_ms,reason,json!([before["id"]]).to_string(),key])?;
    Ok(())
}

fn enqueue(
    tx: &Transaction<'_>,
    queue: &impl MemoryEmbeddingQueue,
    ctx: &MemoryActionContext<'_>,
    id: i64,
    kind: EmbeddingEffectKind,
) -> rusqlite::Result<()> {
    let row = row_json(tx, id)?.ok_or_else(|| error("missing embedding target"))?;
    queue.enqueue_tx(
        tx,
        &EmbeddingEffect {
            project_path: ctx.project_path.into(),
            session_id: ctx.session_id.into(),
            memory_id: id,
            kind,
            content: if kind == EmbeddingEffectKind::Embed {
                row["content"].as_str().map(str::to_owned)
            } else {
                None
            },
            content_hash: row["normalized_hash"].as_str().unwrap_or_default().into(),
            queued_at: ctx.now_ms,
        },
    )
}

/// Non-served memory adapter using the Dreamer context from
/// MemoryActions::execute_tx. Only the bound project may be edited, never other
/// workspace members. Propagate errors to roll back memory, history and outbox.
pub fn execute_tx(
    tx: &Transaction<'_>,
    queue: &impl MemoryEmbeddingQueue,
    ctx: &MemoryActionContext<'_>,
    batch: &[Memory],
    verdicts: &[Verdict],
    checked_commit: Option<&str>,
    current_commit: Option<&str>,
) -> rusqlite::Result<Counts> {
    if ctx.role != MemoryRole::Dreamer || !ctx.memory_enabled {
        return Err(error("Dreamer memory context required"));
    }
    let mut counts = Counts::default();
    for verdict in verdicts {
        let original = batch
            .iter()
            .find(|m| m.id == verdict.id)
            .ok_or_else(|| error("target outside batch"))?;
        let key = format!(
            "verify:{}:{}",
            json!([
                ctx.project_path,
                ctx.session_id,
                ctx.harness,
                ctx.decision_key
            ]),
            verdict.id
        );
        if let Some((project, saved)) = tx.query_row("SELECT project_path,receipt_json FROM memory_decision_receipts WHERE decision_key=?1", [&key], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional()? {
            if project != ctx.project_path { return Err(error("decision key belongs to another project")); }
            counts.count(&verdict.kind, &serde_json::from_str::<Value>(&saved).map_err(|e| error(e.to_string()))?);
            continue;
        }
        let target = row_json(tx, verdict.id)?;
        let stale = match target.as_ref() {
            None => Some("target_not_owned"),
            Some(row) if row["project_path"] != ctx.project_path => Some("target_not_owned"),
            Some(row)
                if row["revision"] != original.revision
                    || row["normalized_hash"] != original.content_hash
                    || row["status"] == "archived"
                    || !row["superseded_by_memory_id"].is_null() =>
            {
                Some("stale_revision")
            }
            _ => None,
        };
        if let Some(reason) = stale {
            let result = json!({"state":"decided_pending","reason":reason,"memoryId":verdict.id,"adoptionClass":"deferred","verificationResult":"stale"});
            receipt(tx, ctx, &key, "verification", &result, None)?;
            counts.count(&verdict.kind, &result);
            continue;
        }
        let before = target.unwrap();
        let mut files = verdict.files.clone();
        files.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        files.dedup();
        let content = js_trim(&verdict.content);
        let stored = Memory {
            category: before["category"].as_str().unwrap_or_default().into(),
            content: before["content"].as_str().unwrap_or_default().into(),
            ..original.clone()
        };
        let refusal = if ["update", "archive"].contains(&verdict.kind.as_str())
            && directive(&stored)
        {
            Some("directive-shaped-project-rule".to_owned())
        } else if verdict.kind == "update"
            && (content.is_empty() || content.encode_utf16().count() > 20_000)
        {
            Some("invalid_content".into())
        } else if verdict.kind == "update"
            && !verdict.consolidation
            && content.encode_utf16().count() * 2 < js_trim(&stored.content).encode_utf16().count()
        {
            Some("content-loss".into())
        } else {
            None
        };
        let source_matches = checked_commit == current_commit;
        let mut result = if !source_matches {
            "failed"
        } else if refusal.is_some() {
            "refused"
        } else {
            match verdict.kind.as_str() {
                "verified" => {
                    if files.is_empty() {
                        "unmapped"
                    } else {
                        "confirmed"
                    }
                }
                "update" => {
                    if files.is_empty() {
                        "unmapped"
                    } else {
                        "updated"
                    }
                }
                "archive" => "archived",
                "skipped" => "skipped",
                "unmapped" => "unmapped",
                "failed" => "failed",
                _ => return Err(error("invalid verification kind")),
            }
        };
        let mut reason = refusal;
        if source_matches && reason.is_none() && verdict.kind == "update" {
            let hash = compute_normalized_memory_hash(content);
            let duplicate: Option<i64> = tx.query_row("SELECT id FROM memories WHERE project_path=?1 AND category=?2 AND normalized_hash=?3 AND id!=?4 LIMIT 1",params![ctx.project_path,original.category,hash,verdict.id],|r|r.get(0)).optional()?;
            if let Some(id) = duplicate {
                result = "refused";
                reason = Some(format!("duplicate_of:{id}"));
            }
        }
        if source_matches
            && reason.is_none()
            && ["update", "archive"].contains(&verdict.kind.as_str())
        {
            if verdict.kind == "update" {
                tx.execute("UPDATE memories SET revision=revision+1,content=?1,normalized_hash=?2,updated_at=?3,shareable=0,classified_at=NULL,mural_cue=NULL,mural_cue_hash=NULL,mural_cue_at=NULL,mural_cue_rejection_count=0 WHERE id=?4",params![content,compute_normalized_memory_hash(content),ctx.now_ms,verdict.id])?;
            } else {
                tx.execute("UPDATE memories SET revision=revision+1,status='archived',updated_at=?1,shareable=0,classified_at=NULL,metadata_json=?2 WHERE id=?3",params![ctx.now_ms,if js_trim(&verdict.reason).is_empty() {before["metadata_json"].as_str().map(str::to_owned)} else {Some(metadata_with(&before,&[("archive_reason",json!(js_trim(&verdict.reason)))]))},verdict.id])?;
            }
            tx.execute(
                "DELETE FROM memory_embeddings WHERE memory_id=?1",
                [verdict.id],
            )?;
            tx.execute(
                "DELETE FROM memory_verifications WHERE memory_id=?1",
                [verdict.id],
            )?;
            let after = row_json(tx, verdict.id)?.unwrap();
            let mutation_key = format!("{key}:mutation");
            history(
                tx,
                ctx,
                &before,
                &after,
                &mutation_key,
                if verdict.kind == "update" {
                    "verify_update"
                } else {
                    &verdict.reason
                },
            )?;
            let mutation = json!({"state":"applied","reason":verdict.kind,"memoryId":verdict.id,"adoptionClass":"deferred","supersededIds":[]});
            receipt(
                tx,
                ctx,
                &mutation_key,
                &format!("verify_{}", verdict.kind),
                &mutation,
                Some(json!([after])),
            )?;
            enqueue(
                tx,
                queue,
                ctx,
                verdict.id,
                if verdict.kind == "update" {
                    EmbeddingEffectKind::Embed
                } else {
                    EmbeddingEffectKind::Invalidate
                },
            )?;
            if verdict.kind == "update" {
                tx.execute("UPDATE memories SET verification_status='unverified',verified_at=NULL WHERE id=?1",[verdict.id])?;
            }
        }
        tx.execute("UPDATE memories SET verify_result=?1,verify_files_json=?2,verify_commit=?3 WHERE id=?4",params![result,json!(files).to_string(),checked_commit,verdict.id])?;
        if result == "confirmed" || result == "updated" {
            tx.execute(
                "DELETE FROM memory_verifications WHERE memory_id=?1",
                [verdict.id],
            )?;
            for file in &files {
                tx.execute("INSERT INTO memory_verifications(memory_id,file_path,verified_at,mapped_at,mapping_origin) VALUES(?1,?2,?3,?3,'mapper')",params![verdict.id,file,ctx.now_ms])?;
            }
            tx.execute("UPDATE memories SET verification_status='verified',verified_at=?1,metadata_json=?2 WHERE id=?3",params![ctx.now_ms,metadata_with(&before,&[("dreamerVerifiedAt",json!(ctx.now_ms)),("dreamerVerifiedCommit",json!(checked_commit))]),verdict.id])?;
        }
        let value = json!({"state":if result=="refused" {"decided_pending"} else {"applied"},"reason":if !source_matches {"source_commit_changed"} else {reason.as_deref().unwrap_or(result)},"memoryId":verdict.id,"adoptionClass":"deferred","verificationResult":result});
        receipt(
            tx,
            ctx,
            &key,
            "verification",
            &value,
            Some(
                json!({"files":files,"checkedCommit":checked_commit,"revision":original.revision}),
            ),
        )?;
        counts.count(&verdict.kind, &value);
    }
    Ok(counts)
}

/// Read the bound project's active/permanent memories whose TTL has not expired.
/// The empty-string mapping row denotes a memory with no backing source file.
pub fn memories(conn: &Connection, project: &str, now: i64) -> rusqlite::Result<Vec<Memory>> {
    let mut query = conn.prepare("SELECT id,category,content,revision,normalized_hash FROM memories WHERE project_path=?1 AND status IN ('active','permanent') AND (expires_at IS NULL OR expires_at>?2) ORDER BY category ASC,updated_at DESC,id ASC")?;
    let rows = query
        .query_map(params![project, now], |r| {
            Ok(Memory {
                id: r.get(0)?,
                category: r.get(1)?,
                content: r.get(2)?,
                revision: r.get(3)?,
                content_hash: r.get(4)?,
                files: vec![],
                verified_at: 0,
                verified_commit: None,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter().map(|mut memory| {
        let mappings = conn.prepare("SELECT file_path,verified_at FROM memory_verifications WHERE memory_id=?1 ORDER BY file_path")?.query_map([memory.id],|r| Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
        for (file,at) in mappings { if !file.is_empty() {memory.files.push(file);} memory.verified_at=memory.verified_at.max(at); }
        if let Some(row)=row_json(conn,memory.id)? {
            if let Some(metadata)=row["metadata_json"].as_str().and_then(|s|serde_json::from_str::<Value>(s).ok()) {
                if metadata["dreamerVerifiedAt"]==memory.verified_at {
                    memory.verified_commit=metadata["dreamerVerifiedCommit"].as_str().filter(|s|s.len()==40&&s.bytes().all(|b|b.is_ascii_hexdigit())).map(str::to_owned);
                }
            }
        }
        Ok(memory)
    }).collect()
}

fn ts_memory(row: &Value) -> Value {
    let mut result = serde_json::Map::new();
    for (camel, snake) in [
        ("id", "id"),
        ("projectPath", "project_path"),
        ("category", "category"),
        ("content", "content"),
        ("normalizedHash", "normalized_hash"),
        ("importance", "importance"),
        ("scope", "scope"),
        ("shareable", "shareable"),
        ("sourceSessionId", "source_session_id"),
        ("sourceType", "source_type"),
        ("seenCount", "seen_count"),
        ("retrievalCount", "retrieval_count"),
        ("firstSeenAt", "first_seen_at"),
        ("createdAt", "created_at"),
        ("updatedAt", "updated_at"),
        ("lastSeenAt", "last_seen_at"),
        ("lastRetrievedAt", "last_retrieved_at"),
        ("status", "status"),
        ("expiresAt", "expires_at"),
        ("verificationStatus", "verification_status"),
        ("verifiedAt", "verified_at"),
        ("supersededByMemoryId", "superseded_by_memory_id"),
        ("mergedFrom", "merged_from"),
        ("metadataJson", "metadata_json"),
    ] {
        result.insert(
            camel.into(),
            if camel == "importance" && row[snake].is_null() {
                json!(50)
            } else {
                row[snake].clone()
            },
        );
    }
    Value::Object(result)
}

pub fn expired_ids(conn: &Connection, project: &str, now: i64) -> rusqlite::Result<Vec<i64>> {
    conn.prepare("SELECT id FROM memories WHERE project_path=?1 AND status='active' AND expires_at IS NOT NULL AND expires_at<=?2 ORDER BY id")?.query_map(params![project,now],|r|r.get(0))?.collect()
}

/// Recheck selected TTLs under the writer transaction. Expiry changes status
/// without rewriting mappings or derived columns: the declared TTL, rather than
/// a new code check, caused the archive. Queue invalidation for retrieval vectors.
pub fn expire_tx(
    tx: &Transaction<'_>,
    queue: &impl MemoryEmbeddingQueue,
    ctx: &MemoryActionContext<'_>,
    selected: &[i64],
) -> rusqlite::Result<usize> {
    if ctx.role != MemoryRole::Dreamer || !ctx.memory_enabled {
        return Err(error("Dreamer memory context required"));
    }
    if selected.len() > 100 {
        return Err(error("expiry batch exceeds 100 ids"));
    }
    let selected: BTreeSet<_> = selected.iter().copied().collect();
    let still_expired = expired_ids(tx, ctx.project_path, ctx.now_ms)?;
    let mut count = 0;
    for id in still_expired.into_iter().filter(|id| selected.contains(id)) {
        let before = row_json(tx, id)?.unwrap();
        tx.execute(
            "UPDATE memories SET status='archived',metadata_json=?1,updated_at=?2 WHERE id=?3",
            params![
                metadata_with(&before, &[("archive_reason", json!("expired"))]),
                ctx.now_ms,
                id
            ],
        )?;
        let after = row_json(tx, id)?.unwrap();
        let key = format!("expire:{id}:{}", before["revision"]);
        tx.execute("INSERT INTO memory_history(memory_id,revision,previous_text,after_text,before_json,after_json,applied_at,reason,evidence_json,source_ids_json,decision_key) VALUES(?1,?2,?3,?3,?4,?5,?6,'expired','[]',?7,?8)",params![id,before["revision"].as_i64(),before["content"].as_str(),ts_memory(&before).to_string(),ts_memory(&after).to_string(),ctx.now_ms,json!([id]).to_string(),key])?;
        tx.execute("UPDATE memories SET revision=revision+1 WHERE id=?1", [id])?;
        enqueue(tx, queue, ctx, id, EmbeddingEffectKind::Invalidate)?;
        count += 1;
    }
    Ok(count)
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
enum Request {
    Verify {
        batch: Vec<Memory>,
        manifest: String,
        checked_commit: Option<String>,
        current_commit: Option<String>,
        #[serde(default)]
        budget_finalized: bool,
    },
    Expire {
        ids: Vec<i64>,
    },
}

/// Callable non-served method body. Its dispatch_value caller must validate the
/// management binding, protocol version and session before constructing context.
/// Check the lease inside the transaction, after model work and normalization.
pub fn execute_value(
    conn: &mut Connection,
    queue: &impl MemoryEmbeddingQueue,
    ctx: &MemoryActionContext<'_>,
    value: Value,
    mut lease_owned: impl FnMut(&Connection) -> bool,
    mut normalize: impl FnMut(&[String]) -> Result<Vec<String>, String>,
) -> rusqlite::Result<Value> {
    let request: Request = serde_json::from_value(value).map_err(|e| error(e.to_string()))?;
    let (batch, verdicts, checked, current, expiry) = match request {
        Request::Expire { ids } => (vec![], vec![], None, None, Some(ids)),
        Request::Verify {
            batch,
            manifest,
            checked_commit,
            current_commit,
            budget_finalized,
        } => {
            if batch.len() > BATCH_SIZE {
                return Err(error("verify batch exceeds 20 memories"));
            }
            let mut verdicts =
                parse_manifest(&manifest, &batch, budget_finalized).map_err(error)?;
            for verdict in &mut verdicts {
                if ["archive", "skipped"].contains(&verdict.kind.as_str()) {
                    verdict.files = batch
                        .iter()
                        .find(|m| m.id == verdict.id)
                        .unwrap()
                        .files
                        .clone();
                }
                verdict.files = normalize(&verdict.files).map_err(error)?;
            }
            (batch, verdicts, checked_commit, current_commit, None)
        }
    };
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if !lease_owned(&tx) {
        return Err(error("Dream lease lost before memory write"));
    }
    let result = if let Some(ids) = expiry {
        json!({"archived":expire_tx(&tx,queue,ctx,&ids)?})
    } else {
        serde_json::to_value(execute_tx(
            &tx,
            queue,
            ctx,
            &batch,
            &verdicts,
            checked.as_deref(),
            current.as_deref(),
        )?)
        .map_err(|e| error(e.to_string()))?
    };
    tx.commit()?;
    Ok(result)
}

/// The background runner supplies its resolved model chain and read-only tools.
/// Provider failures and timeouts cannot apply even a closed fragment of model
/// output. No connection or write lock is passed to the model.
pub trait VerifyHost {
    fn now_ms(&self) -> i64;
    fn head(&mut self) -> Option<String>;
    fn lease_owned(&mut self, conn: &Connection) -> bool;
    fn normalize_files(&mut self, files: &[String]) -> Result<Vec<String>, String>;
    fn evidence(&mut self, _batch: &[Memory]) -> Option<DiffEvidence> {
        None
    }
    fn complete(&mut self, request: BatchRequest<'_>) -> Result<Completion, String>;
}
pub struct BatchRequest<'a> {
    pub batch: &'a [Memory],
    pub slice_ms: i64,
    pub system: &'static str,
    pub prompt: String,
}
pub struct Completion {
    pub manifest: String,
    pub budget_finalized: bool,
    pub timed_out: bool,
    pub provider_failure: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    #[serde(flatten)]
    pub counts: Counts,
    pub batches: usize,
    pub in_scope: usize,
    pub remaining: usize,
    pub complete: bool,
    pub mode: &'static str,
    #[serde(rename = "broadCycleStartAt", skip_serializing_if = "Option::is_none")]
    pub broad_cycle_start: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<&'static str>,
}

/// A broad run revisits every memory verified before broad_start. The scheduler
/// persists this start until complete, then clears it only if it has not changed.
/// Omitted/timed-out memories keep their previous verified_at and remain eligible.
pub fn run_verify(
    conn: &mut Connection,
    queue: &impl MemoryEmbeddingQueue,
    ctx: &MemoryActionContext<'_>,
    changes: &Changes,
    broad_start: Option<i64>,
    deadline: i64,
    host: &mut impl VerifyHost,
) -> Result<RunResult, String> {
    let pool = memories(conn, ctx.project_path, ctx.now_ms).map_err(|e| e.to_string())?;
    let scope = partition(&pool, changes, broad_start);
    let batches = batches(&pool, &scope);
    let mut result = RunResult {
        counts: Counts::default(),
        batches: 0,
        in_scope: scope.selected.len(),
        remaining: scope.selected.len(),
        complete: true,
        mode: scope.mode,
        broad_cycle_start: broad_start,
        stop_reason: None,
    };
    // Memories without backing source files get an unmapped result, not a
    // successful code-verification stamp.
    if !scope.unmapped.is_empty() {
        let head = host.head();
        let write_ctx = MemoryActionContext {
            now_ms: host.now_ms(),
            ..*ctx
        };
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        if !host.lease_owned(&tx) {
            return Err("Dream lease lost before unmapped write".into());
        }
        let batch = scope
            .unmapped
            .iter()
            .map(|i| pool[*i].clone())
            .collect::<Vec<_>>();
        let verdicts = batch
            .iter()
            .map(|m| Verdict {
                id: m.id,
                kind: "unmapped".into(),
                files: vec![],
                content: String::new(),
                reason: String::new(),
                consolidation: false,
            })
            .collect::<Vec<_>>();
        execute_tx(
            &tx,
            queue,
            &write_ctx,
            &batch,
            &verdicts,
            head.as_deref(),
            head.as_deref(),
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
    }
    let mut last_provider_failure = None;
    let mut prior_provider_failure = None;
    let mut consecutive_provider_failures = 0;
    for (index, batch) in batches.iter().enumerate() {
        let remaining = deadline.saturating_sub(host.now_ms()).max(0);
        if remaining < BATCH_FLOOR_MS {
            result.stop_reason = Some("deadline");
            break;
        }
        let head = host.head();
        let evidence = if broad_start.is_none() && batch.iter().all(|m| m.verified_at > 0) {
            host.evidence(batch)
        } else {
            None
        };
        let completion = host.complete(BatchRequest {
            batch,
            slice_ms: batch_slice_ms(remaining, batches.len() - index),
            system: system_prompt()?,
            prompt: build_prompt_with_mode(
                ctx.project_path,
                batch,
                evidence.as_ref(),
                if broad_start.is_some() {
                    "broad"
                } else {
                    "full"
                },
            )?,
        })?;
        let current = host.head();
        if completion.timed_out {
            result.batches += 1;
            result.stop_reason = Some("batch-timeout");
            break;
        }
        if let Some(failure) = completion.provider_failure {
            consecutive_provider_failures = if prior_provider_failure.as_ref() == Some(&failure) {
                consecutive_provider_failures + 1
            } else {
                1
            };
            prior_provider_failure = Some(failure.clone());
            last_provider_failure = Some(failure.clone());
            result.batches += 1;
            if consecutive_provider_failures >= 2 {
                return Err(failure);
            }
            continue;
        }
        prior_provider_failure = None;
        consecutive_provider_failures = 0;
        let mut verdicts =
            parse_manifest(&completion.manifest, batch, completion.budget_finalized)?;
        for verdict in &mut verdicts {
            if ["archive", "skipped"].contains(&verdict.kind.as_str()) {
                verdict.files = batch
                    .iter()
                    .find(|m| m.id == verdict.id)
                    .unwrap()
                    .files
                    .clone();
            }
            verdict.files = host.normalize_files(&verdict.files)?;
        }
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        if !host.lease_owned(&tx) {
            return Err("Dream lease lost before verification write".into());
        }
        let write_ctx = MemoryActionContext {
            now_ms: host.now_ms(),
            ..*ctx
        };
        let counts = execute_tx(
            &tx,
            queue,
            &write_ctx,
            batch,
            &verdicts,
            head.as_deref(),
            current.as_deref(),
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        result.remaining -= counts.processed();
        result.batches += 1;
        result.counts.verified += counts.verified;
        result.counts.updated += counts.updated;
        result.counts.archived += counts.archived;
        result.counts.skipped += counts.skipped;
        result.counts.refused += counts.refused;
    }
    if let Some(failure) = last_provider_failure {
        return Err(failure);
    }
    result.complete = result.remaining == 0;
    Ok(result)
}

pub fn run_expiry(
    conn: &mut Connection,
    queue: &impl MemoryEmbeddingQueue,
    ctx: &MemoryActionContext<'_>,
    mut lease_owned: impl FnMut(&Connection) -> bool,
) -> rusqlite::Result<usize> {
    let ids = expired_ids(conn, ctx.project_path, ctx.now_ms)?;
    let mut count = 0;
    // An empty probe must still report loss of the task's lease.
    if ids.is_empty() && !lease_owned(conn) {
        return Err(error("Dream lease lost before expired-memory probe"));
    }
    for batch in ids.chunks(100) {
        let value = execute_value(
            conn,
            queue,
            ctx,
            json!({"action":"expire","ids":batch}),
            &mut lease_owned,
            |f| Ok(f.to_vec()),
        )?;
        count += value["archived"].as_u64().unwrap_or(0) as usize;
    }
    if !lease_owned(conn) {
        return Err(error("Dream lease lost during expired-memory archive"));
    }
    Ok(count)
}

pub fn system_prompt() -> Result<&'static str, String> {
    crate::persona_host::dream::system(crate::persona_host::dream::Kind::Verify)
        .map_err(|error| format!("mc_persona_invalid: {error}"))
}

// Generated by the pinned TypeScript oracle; functions under packages/plugin/src/features/magic-context at commit 282d9c08bce4. Full commit, file SHA-256 hashes and inputs follow.
#[cfg(test)]
const TS_FIXTURE: &str = r###"{"taskDeadline":{"verified":0,"updated":0,"archived":0,"skipped":0,"refused":0,"batches":0,"inScope":21,"remaining":21,"complete":false,"mode":"full","stopReason":"deadline"},"metadataExpected":"{\"z\":{\"b\":2,\"a\":1},\"dreamerVerifiedCommit\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"a\":1,\"dreamerVerifiedAt\":1700000000000}","gate":{"selected":[1,2,3,4],"skipped":[5],"unmapped":[6],"fallback":[1,2,3,4,5]},"prompt":"## Verify these memories against the code\n\nProject: project-a\n\nThe git diff below is the evidence. If changed hunks do not touch a claim, mark it verified without opening files. Open files only when a diff suggests the claim may have changed. A rename or deletion requires an update or archive when positively supported; do not archive on uncertainty. Decide verified / update / archive / skip (default verified; behavioral directives only permit verified or skip), then output ONE <verify> manifest covering every id.\n\n<memories>\n[1] ARCHITECTURE\nContent: The handler has one argument.\nBacking files: src/a.ts\n</memories>\n\n<changed-files mode=\"diff\">\nFile: src/a.ts (memories: 1)\ndiff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n\n</changed-files>","system":"You are a memory verifier for the magic-context system. You verify project memories against the CURRENT code.\n\nEach memory below comes with its backing file(s) — the code it makes a claim about. For EACH memory: use the provided git diff as evidence when present. If no diff is supplied, read its backing files (you may read more if needed) and decide whether the memory is still accurate.\n\nTools (read-only): read, grep, glob. Request line ranges and keep reads short. You read code only when the evidence requires it; you change nothing.\n\nDecide ONE of four outcomes per memory:\n- VERIFIED — still accurate. Keep it as-is.\n- UPDATE — a CODE FACT is still true but a file-falsifiable DETAIL drifted (a renamed symbol, moved file, changed number/name). Provide corrected content in terse present tense (\"X uses Y\", not \"X was changed to Y\"). Only update for genuine drift, not style. If a legitimate update intentionally consolidates the old claim into much shorter content, set consolidation=\"true\" explicitly.\n- ARCHIVE — a CODE FACT is positively falsified: the code clearly contradicts it, or the API/symbol/path it describes no longer exists.\n- SKIP — the claim is not a code fact, or code cannot decide it. Keep it unchanged and do not claim verification.\n\nUPDATE and ARCHIVE are ONLY for claims a repository file can falsify, such as an API that no longer exists, a path that moved, or a constant that changed. Behavioral directives (when to act, how to work, who decides, tool-usage discipline) can only be VERIFIED or SKIPPED. A named path inside a directive does not make the directive a code fact, and a file's failure to corroborate a behavioral rule is never grounds to update or archive it.\n\nBE CONSERVATIVE ABOUT ARCHIVING. Wrong archival of a TRUE memory is the worst possible outcome — far worse than leaving a slightly-stale memory. If you cannot find the code, or you are unsure, or it might still be true somewhere you didn't look: mark it VERIFIED or SKIPPED, never archived. Archive ONLY when you have positive evidence the code contradicts a code fact.\n\nOutput ONE XML manifest at the very end and NOTHING else — no narration, no per-memory commentary, no reasoning:\n<verify>\n<verified id=\"N\" files=\"path/a.ts,path/b.ts\"/>\n<update id=\"M\" files=\"path/c.ts\">corrected present-tense content</update>\n<update id=\"C\" files=\"path/d.ts\" consolidation=\"true\">intentionally consolidated content</update>\n<archive id=\"K\" reason=\"specific evidence the code contradicts it\"/>\n<skip id=\"S\" reason=\"behavioral directive; code cannot decide it\"/>\n</verify>\n\nRules:\n- Every input memory id MUST appear exactly once, in exactly one of verified/update/archive/skip.\n- files = the COMPLETE current backing set (repo-relative, comma-separated). It may differ from the given mapping if a file moved — record what you actually verified against.\n- Default to VERIFIED. skip when code cannot decide the claim. update and archive are the exceptions, not the norm.","smallEvidence":{"head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","mode":"diff","files":[{"path":"src/a.ts","memoryIds":[1],"text":"diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n"}]},"largeEvidence":{"head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","mode":"ranges","files":[{"path":"src/a.ts","memoryIds":[1],"text":"Changed lines: +1/-1.\ndiff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\nRead only these changed line ranges if they may affect the claim."}]},"commit":"282d9c08bce490346583a3b8c145c402499f980f","hashes":{"packages/plugin/src/features/magic-context/memory/constants.ts":"50550cc9627e87063ac076f591bc520817927653eff620e2519d4c8c2b4f85df","packages/plugin/src/features/magic-context/dreamer/expire-memories.test.ts":"b8bc53b7648a82a4439e91f0e98b820027031c3dcaf7cc3047ebe5610cea49c5","packages/plugin/src/features/magic-context/dreamer/expire-memories.ts":"9ba25c69ebed5a38f07d0014ece1da899815b5431e465479ae1e6d1209d585e2","packages/plugin/src/features/magic-context/memory/lifecycle-applier.ts":"d44420e713e0f39deb5dc662e09e0d11ce4b3e4ab2f69331fa35b7b69b5cf4ad","packages/plugin/src/features/magic-context/dreamer/manifest-parser.ts":"dc20d1c1e3d373b226dcced1ae6560c00bf693f587f8f1a932bf50bd859abd5b","packages/plugin/src/features/magic-context/dreamer/memory-claim-safety.ts":"ba423d5d18a7eec2be92d3aed179074230912776ba7dd766cc78afb910bd19f1","packages/plugin/src/features/magic-context/memory/normalize-hash.ts":"825c413d7faff8c474c4b35ff3ac5fdddf03d792e5c5688da72cf4054d7c48d4","packages/plugin/src/features/magic-context/memory/storage-memory-verifications.ts":"01e815297e5a2c903a8ea5c3fd263d0fd801cb242b7786af87189c68127a6080","packages/plugin/src/features/magic-context/memory/storage-memory.ts":"61c45628a632bc6e4c32f554ab5864641d8dae979e1eb6f28f717ad47fe95a77","packages/plugin/src/features/magic-context/memory/verification-paths.ts":"77d5fd1d641cdcb5be7c60df27b27ed40c68a4821877e1d1091dcf38a512212c","packages/plugin/src/features/magic-context/dreamer/verify-diff.ts":"0eaec21159da4145f6f1b38111ef06ad6679b6239f4b1395bc23fd715291f767","packages/plugin/src/features/magic-context/dreamer/verify-gate.test.ts":"016408f48e613eb7b2f55c99806f43087d77f53ab6fbd3ada79452aa4db20485","packages/plugin/src/features/magic-context/dreamer/verify-gate.ts":"fc4f123112fc684017da8c5db189bd65487ef71ddd897cb458cd9be8be6f57ed","packages/plugin/src/features/magic-context/dreamer/verify-prompt.test.ts":"552a002a856dbf0dc0fbe3fd24053163cabc2619b24a51691f23a944ae6b0208","packages/plugin/src/features/magic-context/dreamer/verify-prompt.ts":"772c272c465476fea4d22f031f4dcfe83dbe13418f21fa4f87f120dc45c59fa6","packages/plugin/src/features/magic-context/dreamer/verify.test.ts":"aa7ea2c1f95abfdcc14219670bca67e8b7f079272ca7f9e717a240c61dc72a3c","packages/plugin/src/features/magic-context/dreamer/verify.ts":"55b2c4ede02115514fa0cc3818278f039e333c0fa4bb5fbf868e2871b167b2a4"},"manifest":"<verify><verified id=\"1\" files=\"src/a.ts\"/><update id=\"2\" files=\"src/a.ts\">The handler uses the new name.</update><archive id=\"3\" reason=\"API removed\"/><archive id=\"4\" reason=\"not in source\"/><update id=\"5\" files=\"src/a.ts\">Tiny.</update><skip id=\"6\" reason=\"cannot decide\"/><archive id=\"999\" reason=\"unknown\"/></verify>","counts":{"verified":1,"updated":1,"archived":1,"skipped":1,"refused":2},"verify":{"rows":[{"id":1,"project_path":"project-a","category":"ARCHITECTURE","content":"The handler has one argument.","normalized_hash":"06d04fd7af49160bab1dfecc759d6d40","status":"active","revision":1,"verification_status":"verified","verified_at":1700000000000,"verify_result":"confirmed","verify_files_json":"[\"src/a.ts\"]","verify_commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","metadata_json":"{\"dreamerVerifiedAt\":1700000000000,\"dreamerVerifiedCommit\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}","shareable":0,"classified_at":null,"expires_at":null},{"id":2,"project_path":"project-a","category":"ARCHITECTURE","content":"The handler uses the new name.","normalized_hash":"9665bcc05434678aad7b083879c909c8","status":"active","revision":2,"verification_status":"verified","verified_at":1700000000000,"verify_result":"updated","verify_files_json":"[\"src/a.ts\"]","verify_commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","metadata_json":"{\"dreamerVerifiedAt\":1700000000000,\"dreamerVerifiedCommit\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}","shareable":0,"classified_at":null,"expires_at":null},{"id":3,"project_path":"project-a","category":"ARCHITECTURE","content":"The deleted API returns true.","normalized_hash":"0b813ee2ff5811c4d2aa13c9d765105b","status":"archived","revision":2,"verification_status":"unverified","verified_at":null,"verify_result":"archived","verify_files_json":"[\"src/a.ts\"]","verify_commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","metadata_json":"{\"archive_reason\":\"API removed\"}","shareable":0,"classified_at":null,"expires_at":null},{"id":4,"project_path":"project-a","category":"PROJECT_RULES","content":"Always inspect src/a.ts before editing.","normalized_hash":"13d8c353b8107fdc69de994d5cc9c4e6","status":"active","revision":1,"verification_status":"unverified","verified_at":null,"verify_result":"refused","verify_files_json":"[\"src/a.ts\"]","verify_commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","metadata_json":null,"shareable":0,"classified_at":null,"expires_at":null},{"id":5,"project_path":"project-a","category":"ARCHITECTURE","content":"The old implementation has a long claim with details.","normalized_hash":"731504c3e267259d426daa65fe4f42bc","status":"active","revision":1,"verification_status":"unverified","verified_at":null,"verify_result":"refused","verify_files_json":"[\"src/a.ts\"]","verify_commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","metadata_json":null,"shareable":0,"classified_at":null,"expires_at":null},{"id":6,"project_path":"project-a","category":"ARCHITECTURE","content":"A behavior cannot be checked.","normalized_hash":"06ef73800083bb45064390221133a459","status":"active","revision":1,"verification_status":"unverified","verified_at":null,"verify_result":"skipped","verify_files_json":"[\"src/a.ts\"]","verify_commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","metadata_json":null,"shareable":0,"classified_at":null,"expires_at":null}],"mappings":[{"memory_id":1,"file_path":"src/a.ts","verified_at":1700000000000,"mapped_at":1700000000000,"mapping_origin":"mapper"},{"memory_id":2,"file_path":"src/a.ts","verified_at":1700000000000,"mapped_at":1700000000000,"mapping_origin":"mapper"},{"memory_id":4,"file_path":"src/a.ts","verified_at":0,"mapped_at":1699999990000,"mapping_origin":"mapper"},{"memory_id":5,"file_path":"src/a.ts","verified_at":0,"mapped_at":1699999990000,"mapping_origin":"mapper"},{"memory_id":6,"file_path":"src/a.ts","verified_at":0,"mapped_at":1699999990000,"mapping_origin":"mapper"}],"history":[{"memory_id":2,"revision":1,"previous_text":"The handler uses the old name.","after_text":"The handler uses the new name.","before_json":{"id":2,"project_path":"project-a","category":"ARCHITECTURE","content":"The handler uses the old name.","normalized_hash":"2e99a4abfeff4ba6a5debc09324e7550","importance":null,"scope":"project","shareable":0,"source_session_id":"session-a","source_type":"agent","seen_count":1,"retrieval_count":0,"first_seen_at":1700000000000,"created_at":1700000000000,"updated_at":1700000000000,"last_seen_at":1700000000000,"last_retrieved_at":null,"status":"active","expires_at":null,"verification_status":"unverified","verified_at":null,"classified_at":null,"superseded_by_memory_id":null,"merged_from":null,"metadata_json":null,"mural_cue":null,"mural_cue_hash":null,"mural_cue_at":null,"mural_cue_rejection_count":0,"revision":1,"verify_result":null,"verify_files_json":null,"verify_commit":null},"after_json":{"id":2,"project_path":"project-a","category":"ARCHITECTURE","content":"The handler uses the new name.","normalized_hash":"9665bcc05434678aad7b083879c909c8","importance":null,"scope":"project","shareable":0,"source_session_id":"session-a","source_type":"agent","seen_count":1,"retrieval_count":0,"first_seen_at":1700000000000,"created_at":1700000000000,"updated_at":1700000000000,"last_seen_at":1700000000000,"last_retrieved_at":null,"status":"active","expires_at":null,"verification_status":"unverified","verified_at":null,"classified_at":null,"superseded_by_memory_id":null,"merged_from":null,"metadata_json":null,"mural_cue":null,"mural_cue_hash":null,"mural_cue_at":null,"mural_cue_rejection_count":0,"revision":2,"verify_result":null,"verify_files_json":null,"verify_commit":null},"reason":"verify_update","evidence_json":[],"source_ids_json":[2]},{"memory_id":3,"revision":1,"previous_text":"The deleted API returns true.","after_text":"The deleted API returns true.","before_json":{"id":3,"project_path":"project-a","category":"ARCHITECTURE","content":"The deleted API returns true.","normalized_hash":"0b813ee2ff5811c4d2aa13c9d765105b","importance":null,"scope":"project","shareable":0,"source_session_id":"session-a","source_type":"agent","seen_count":1,"retrieval_count":0,"first_seen_at":1700000000000,"created_at":1700000000000,"updated_at":1700000000000,"last_seen_at":1700000000000,"last_retrieved_at":null,"status":"active","expires_at":null,"verification_status":"unverified","verified_at":null,"classified_at":null,"superseded_by_memory_id":null,"merged_from":null,"metadata_json":null,"mural_cue":null,"mural_cue_hash":null,"mural_cue_at":null,"mural_cue_rejection_count":0,"revision":1,"verify_result":null,"verify_files_json":null,"verify_commit":null},"after_json":{"id":3,"project_path":"project-a","category":"ARCHITECTURE","content":"The deleted API returns true.","normalized_hash":"0b813ee2ff5811c4d2aa13c9d765105b","importance":null,"scope":"project","shareable":0,"source_session_id":"session-a","source_type":"agent","seen_count":1,"retrieval_count":0,"first_seen_at":1700000000000,"created_at":1700000000000,"updated_at":1700000000000,"last_seen_at":1700000000000,"last_retrieved_at":null,"status":"archived","expires_at":null,"verification_status":"unverified","verified_at":null,"classified_at":null,"superseded_by_memory_id":null,"merged_from":null,"metadata_json":"{\"archive_reason\":\"API removed\"}","mural_cue":null,"mural_cue_hash":null,"mural_cue_at":null,"mural_cue_rejection_count":0,"revision":2,"verify_result":null,"verify_files_json":null,"verify_commit":null},"reason":"API removed","evidence_json":[],"source_ids_json":[3]}],"receipts":[{"state":"applied","reason":"confirmed","memoryId":1,"adoptionClass":"deferred","verificationResult":"confirmed"},{"state":"applied","reason":"update","memoryId":2,"adoptionClass":"deferred","supersededIds":[]},{"state":"applied","reason":"updated","memoryId":2,"adoptionClass":"deferred","verificationResult":"updated"},{"state":"decided_pending","reason":"content-loss","memoryId":5,"adoptionClass":"deferred","verificationResult":"refused"},{"state":"applied","reason":"archive","memoryId":3,"adoptionClass":"deferred","supersededIds":[]},{"state":"applied","reason":"archived","memoryId":3,"adoptionClass":"deferred","verificationResult":"archived"},{"state":"decided_pending","reason":"directive-shaped-project-rule","memoryId":4,"adoptionClass":"deferred","verificationResult":"refused"},{"state":"applied","reason":"skipped","memoryId":6,"adoptionClass":"deferred","verificationResult":"skipped"}],"journal":[{"operation":"verification","receipt_json":{"state":"applied","reason":"confirmed","memoryId":1,"adoptionClass":"deferred","verificationResult":"confirmed"},"after_json":{"files":["src/a.ts"],"checkedCommit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","revision":1}},{"operation":"verify_update","receipt_json":{"state":"applied","reason":"update","memoryId":2,"adoptionClass":"deferred","supersededIds":[]},"after_json":[{"id":2,"project_path":"project-a","category":"ARCHITECTURE","content":"The handler uses the new name.","normalized_hash":"9665bcc05434678aad7b083879c909c8","importance":null,"scope":"project","shareable":0,"source_session_id":"session-a","source_type":"agent","seen_count":1,"retrieval_count":0,"first_seen_at":1700000000000,"created_at":1700000000000,"updated_at":1700000000000,"last_seen_at":1700000000000,"last_retrieved_at":null,"status":"active","expires_at":null,"verification_status":"unverified","verified_at":null,"classified_at":null,"superseded_by_memory_id":null,"merged_from":null,"metadata_json":null,"mural_cue":null,"mural_cue_hash":null,"mural_cue_at":null,"mural_cue_rejection_count":0,"revision":2,"verify_result":null,"verify_files_json":null,"verify_commit":null}]},{"operation":"verification","receipt_json":{"state":"applied","reason":"updated","memoryId":2,"adoptionClass":"deferred","verificationResult":"updated"},"after_json":{"files":["src/a.ts"],"checkedCommit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","revision":1}},{"operation":"verify_archive","receipt_json":{"state":"applied","reason":"archive","memoryId":3,"adoptionClass":"deferred","supersededIds":[]},"after_json":[{"id":3,"project_path":"project-a","category":"ARCHITECTURE","content":"The deleted API returns true.","normalized_hash":"0b813ee2ff5811c4d2aa13c9d765105b","importance":null,"scope":"project","shareable":0,"source_session_id":"session-a","source_type":"agent","seen_count":1,"retrieval_count":0,"first_seen_at":1700000000000,"created_at":1700000000000,"updated_at":1700000000000,"last_seen_at":1700000000000,"last_retrieved_at":null,"status":"archived","expires_at":null,"verification_status":"unverified","verified_at":null,"classified_at":null,"superseded_by_memory_id":null,"merged_from":null,"metadata_json":"{\"archive_reason\":\"API removed\"}","mural_cue":null,"mural_cue_hash":null,"mural_cue_at":null,"mural_cue_rejection_count":0,"revision":2,"verify_result":null,"verify_files_json":null,"verify_commit":null}]},{"operation":"verification","receipt_json":{"state":"applied","reason":"archived","memoryId":3,"adoptionClass":"deferred","verificationResult":"archived"},"after_json":{"files":["src/a.ts"],"checkedCommit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","revision":1}},{"operation":"verification","receipt_json":{"state":"applied","reason":"skipped","memoryId":6,"adoptionClass":"deferred","verificationResult":"skipped"},"after_json":{"files":["src/a.ts"],"checkedCommit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","revision":1}}],"mutationCount":0},"expired":1,"expiry":{"rows":[{"id":1,"project_path":"project-a","category":"ARCHITECTURE","content":"expired","normalized_hash":"c4bfb2a0bab0e91bc7dcfbe3bbec246e","status":"archived","revision":2,"verification_status":"unverified","verified_at":null,"verify_result":null,"verify_files_json":null,"verify_commit":null,"metadata_json":"{\"archive_reason\":\"expired\"}","shareable":0,"classified_at":null,"expires_at":1700000000000},{"id":2,"project_path":"project-a","category":"ARCHITECTURE","content":"future","normalized_hash":"da907a1b8f74e6922d93b025eecfb852","status":"active","revision":1,"verification_status":"unverified","verified_at":null,"verify_result":null,"verify_files_json":null,"verify_commit":null,"metadata_json":null,"shareable":0,"classified_at":null,"expires_at":1700000000001},{"id":3,"project_path":"project-a","category":"ARCHITECTURE","content":"permanent","normalized_hash":"b0b701fff3d01c5b515f9293cb4ede4d","status":"permanent","revision":1,"verification_status":"unverified","verified_at":null,"verify_result":null,"verify_files_json":null,"verify_commit":null,"metadata_json":null,"shareable":0,"classified_at":null,"expires_at":1699999999999},{"id":4,"project_path":"project-b","category":"ARCHITECTURE","content":"other","normalized_hash":"795f3202b17cb6bc3d4b771d8c6c9eaf","status":"active","revision":1,"verification_status":"unverified","verified_at":null,"verify_result":null,"verify_files_json":null,"verify_commit":null,"metadata_json":null,"shareable":0,"classified_at":null,"expires_at":1699999999999},{"id":5,"project_path":"project-a","category":"ARCHITECTURE","content":"no ttl","normalized_hash":"14334c3fdc9f4997d7774a17bda40004","status":"active","revision":1,"verification_status":"unverified","verified_at":null,"verify_result":null,"verify_files_json":null,"verify_commit":null,"metadata_json":null,"shareable":0,"classified_at":null,"expires_at":null}],"mappings":[{"memory_id":1,"file_path":"src/a.ts","verified_at":0,"mapped_at":1699999990000,"mapping_origin":"mapper"},{"memory_id":2,"file_path":"src/a.ts","verified_at":0,"mapped_at":1699999990000,"mapping_origin":"mapper"},{"memory_id":3,"file_path":"src/a.ts","verified_at":0,"mapped_at":1699999990000,"mapping_origin":"mapper"},{"memory_id":4,"file_path":"src/a.ts","verified_at":0,"mapped_at":1699999990000,"mapping_origin":"mapper"},{"memory_id":5,"file_path":"src/a.ts","verified_at":0,"mapped_at":1699999990000,"mapping_origin":"mapper"}],"history":[{"memory_id":1,"revision":1,"previous_text":"expired","after_text":"expired","before_json":{"id":1,"projectPath":"project-a","category":"ARCHITECTURE","content":"expired","normalizedHash":"c4bfb2a0bab0e91bc7dcfbe3bbec246e","importance":50,"scope":"project","shareable":0,"sourceSessionId":"session-a","sourceType":"agent","seenCount":1,"retrievalCount":0,"firstSeenAt":1700000000000,"createdAt":1700000000000,"updatedAt":1700000000000,"lastSeenAt":1700000000000,"lastRetrievedAt":null,"status":"active","expiresAt":1700000000000,"verificationStatus":"unverified","verifiedAt":null,"supersededByMemoryId":null,"mergedFrom":null,"metadataJson":null},"after_json":{"id":1,"projectPath":"project-a","category":"ARCHITECTURE","content":"expired","normalizedHash":"c4bfb2a0bab0e91bc7dcfbe3bbec246e","importance":50,"scope":"project","shareable":0,"sourceSessionId":"session-a","sourceType":"agent","seenCount":1,"retrievalCount":0,"firstSeenAt":1700000000000,"createdAt":1700000000000,"updatedAt":1700000000000,"lastSeenAt":1700000000000,"lastRetrievedAt":null,"status":"archived","expiresAt":1700000000000,"verificationStatus":"unverified","verifiedAt":null,"supersededByMemoryId":null,"mergedFrom":null,"metadataJson":"{\"archive_reason\":\"expired\"}"},"reason":"expired","evidence_json":[],"source_ids_json":[1]}],"receipts":[],"journal":[],"mutationCount":0}}"###;

#[cfg(test)]
mod tests {
    use super::*;
    const NOW: i64 = 1_700_000_000_000;
    fn database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            &include_str!("../../../mc-store/testdata/context_schema/schema.sql")
                .replace(":applied_at", &NOW.to_string()),
        )
        .unwrap();
        conn.execute_batch("CREATE TABLE test_queue(effect TEXT NOT NULL)")
            .unwrap();
        conn
    }
    struct Queue;
    impl MemoryEmbeddingQueue for Queue {
        fn enqueue_tx(
            &self,
            tx: &Transaction<'_>,
            effect: &EmbeddingEffect,
        ) -> rusqlite::Result<()> {
            assert!(!tx.is_autocommit());
            tx.execute(
                "INSERT INTO test_queue(effect) VALUES(?1)",
                [serde_json::to_string(effect).unwrap()],
            )?;
            Ok(())
        }
    }
    fn context(key: &str) -> MemoryActionContext<'_> {
        MemoryActionContext {
            project_path: "project-a",
            session_id: "session-a",
            harness: "opencode",
            role: MemoryRole::Dreamer,
            workspace_members: &[],
            shared_categories: &[],
            curate_category: None,
            memory_enabled: true,
            now_ms: NOW,
            decision_key: key,
        }
    }
    fn seed(
        conn: &Connection,
        id: i64,
        content: &str,
        category: &str,
        expires: Option<i64>,
        status: &str,
        project: &str,
    ) {
        conn.execute("INSERT INTO memories(id,project_path,category,content,normalized_hash,source_session_id,source_type,created_at,updated_at,first_seen_at,last_seen_at,expires_at,status) VALUES(?1,?2,?3,?4,?5,'session-a','agent',?6,?6,?6,?6,?7,?8)",params![id,project,category,content,compute_normalized_memory_hash(content),NOW,expires,status]).unwrap();
        conn.execute("INSERT INTO memory_verifications(memory_id,file_path,verified_at,mapped_at,mapping_origin) VALUES(?1,'src/a.ts',0,?2,'mapper')",params![id,NOW-10_000]).unwrap();
    }
    fn verify_seed(conn: &Connection) {
        for (i, (text, category)) in [
            ("The handler has one argument.", "ARCHITECTURE"),
            ("The handler uses the old name.", "ARCHITECTURE"),
            ("The deleted API returns true.", "ARCHITECTURE"),
            ("Always inspect src/a.ts before editing.", "PROJECT_RULES"),
            (
                "The old implementation has a long claim with details.",
                "ARCHITECTURE",
            ),
            ("A behavior cannot be checked.", "ARCHITECTURE"),
        ]
        .iter()
        .enumerate()
        {
            seed(
                conn,
                i as i64 + 1,
                text,
                category,
                None,
                "active",
                "project-a",
            );
        }
    }
    fn rows(conn: &Connection, sql: &str) -> Vec<Value> {
        let mut statement = conn.prepare(sql).unwrap();
        let names = statement
            .column_names()
            .into_iter()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        statement
            .query_map([], |row| {
                let mut map = serde_json::Map::new();
                for (index, name) in names.iter().enumerate() {
                    use rusqlite::types::ValueRef;
                    let value = match row.get_ref(index)? {
                        ValueRef::Null => Value::Null,
                        ValueRef::Integer(v) => json!(v),
                        ValueRef::Text(v) => json!(String::from_utf8_lossy(v)),
                        other => panic!("unexpected {other:?}"),
                    };
                    map.insert(name.clone(), value);
                }
                Ok(Value::Object(map))
            })
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }
    fn snapshot(conn: &Connection) -> Value {
        let mut history=rows(conn,"SELECT memory_id,revision,previous_text,after_text,before_json,after_json,reason,evidence_json,source_ids_json FROM memory_history ORDER BY id");
        for row in &mut history {
            for key in [
                "before_json",
                "after_json",
                "evidence_json",
                "source_ids_json",
            ] {
                row[key] = serde_json::from_str(row[key].as_str().unwrap()).unwrap();
            }
        }
        let receipts = rows(
            conn,
            "SELECT receipt_json FROM memory_decision_receipts ORDER BY rowid",
        )
        .iter()
        .map(|r| serde_json::from_str::<Value>(r["receipt_json"].as_str().unwrap()).unwrap())
        .collect::<Vec<_>>();
        let mut journal = rows(
            conn,
            "SELECT operation,receipt_json,after_json FROM memory_journal ORDER BY id",
        );
        for row in &mut journal {
            for key in ["receipt_json", "after_json"] {
                if let Some(raw) = row[key].as_str() {
                    row[key] = serde_json::from_str(raw).unwrap();
                }
            }
        }
        json!({"rows":rows(conn,"SELECT id,project_path,category,content,normalized_hash,status,revision,verification_status,verified_at,verify_result,verify_files_json,verify_commit,metadata_json,shareable,classified_at,expires_at FROM memories ORDER BY id"),"mappings":rows(conn,"SELECT * FROM memory_verifications ORDER BY memory_id,file_path"),"history":history,"receipts":receipts,"journal":journal,"mutationCount":conn.query_row("SELECT count(*) FROM memory_mutation_log",[],|r|r.get::<_,i64>(0)).unwrap()})
    }
    fn fixture() -> Value {
        fn add_unassessed_safety(value: &mut Value) {
            match value {
                Value::Object(object) => {
                    // The historical oracle predates the nullable safety column. Extend only
                    // its full memory snapshots; keep every recorded value and projection exact.
                    if object.contains_key("normalized_hash")
                        && object.contains_key("mural_cue_rejection_count")
                    {
                        assert!(!object.contains_key("safety_critical"));
                        object.insert("safety_critical".into(), Value::Null);
                    }
                    for field in object.values_mut() {
                        add_unassessed_safety(field);
                    }
                }
                Value::Array(values) => values.iter_mut().for_each(add_unassessed_safety),
                _ => {}
            }
        }
        let mut fixture = serde_json::from_str(TS_FIXTURE).unwrap();
        add_unassessed_safety(&mut fixture);
        fixture
    }
    fn verify_request(conn: &Connection, manifest: &str) -> Value {
        json!({"action":"verify","batch":memories(conn,"project-a",NOW).unwrap(),"manifest":manifest,"checked_commit":"a".repeat(40),"current_commit":"a".repeat(40)})
    }
    fn apply(conn: &mut Connection, key: &str, request: Value) -> rusqlite::Result<Value> {
        execute_value(
            conn,
            &Queue,
            &context(key),
            request,
            |_| true,
            |files| Ok(files.to_vec()),
        )
    }
    fn assert_ts_owns(conn: &Connection) {
        for table in ["authority_managed", "authority_repair_pending"] {
            assert_eq!(rows(conn, &format!("SELECT * FROM {table}")).len(), 0);
        }
        assert!(rows(
            conn,
            "SELECT * FROM memory_pending_facts WHERE reason='authority_elsewhere'"
        )
        .is_empty());
        assert!(rows(conn, "SELECT * FROM memory_agent_fragments").is_empty());
    }

    #[test]
    fn pinned_ts_verify_adapter_matches_replies_rows_history_and_queue() {
        let mut conn = database();
        verify_seed(&conn);
        let oracle = fixture();
        let request = verify_request(&conn, oracle["manifest"].as_str().unwrap());
        let counts = apply(&mut conn, "verify", request.clone()).unwrap();
        assert_eq!(counts, oracle["counts"]);
        assert_eq!(snapshot(&conn), oracle["verify"]);
        let effects = rows(&conn, "SELECT effect FROM test_queue")
            .into_iter()
            .map(|r| serde_json::from_str::<Value>(r["effect"].as_str().unwrap()).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(effects,json!([{"project_path":"project-a","session_id":"session-a","memory_id":2,"kind":"embed","content":"The handler uses the new name.","content_hash":"9665bcc05434678aad7b083879c909c8","queued_at":NOW},{"project_path":"project-a","session_id":"session-a","memory_id":3,"kind":"invalidate","content":null,"content_hash":"0b813ee2ff5811c4d2aa13c9d765105b","queued_at":NOW}]).as_array().unwrap().clone());
        let before = snapshot(&conn);
        assert_eq!(apply(&mut conn, "verify", request).unwrap(), counts);
        assert_eq!(snapshot(&conn), before);
        assert_eq!(rows(&conn, "SELECT effect FROM test_queue").len(), 2);
        assert_ts_owns(&conn);
    }
    #[test]
    fn pinned_ts_expiry_adapter_matches_boundary_history_and_preserves_permanent() {
        let mut conn = database();
        seed(
            &conn,
            1,
            "expired",
            "ARCHITECTURE",
            Some(NOW),
            "active",
            "project-a",
        );
        seed(
            &conn,
            2,
            "future",
            "ARCHITECTURE",
            Some(NOW + 1),
            "active",
            "project-a",
        );
        seed(
            &conn,
            3,
            "permanent",
            "ARCHITECTURE",
            Some(NOW - 1),
            "permanent",
            "project-a",
        );
        seed(
            &conn,
            4,
            "other",
            "ARCHITECTURE",
            Some(NOW - 1),
            "active",
            "project-b",
        );
        seed(
            &conn,
            5,
            "no ttl",
            "ARCHITECTURE",
            None,
            "active",
            "project-a",
        );
        let ids = expired_ids(&conn, "project-a", NOW).unwrap();
        assert_eq!(ids, vec![1]);
        assert_eq!(
            apply(
                &mut conn,
                "expiry",
                json!({"action":"expire","ids":[1,2,3,4,5]})
            )
            .unwrap(),
            json!({"archived":fixture()["expired"]})
        );
        assert_eq!(snapshot(&conn), fixture()["expiry"]);
        assert_eq!(rows(&conn, "SELECT effect FROM test_queue").len(), 1);
        assert_ts_owns(&conn);
    }
    #[test]
    fn changed_file_gate_selects_deleted_uncommitted_second_granular_and_fallback() {
        let conn = database();
        for id in 1..=6 {
            seed(
                &conn,
                id,
                &format!("Claim {id}."),
                "ARCHITECTURE",
                None,
                "active",
                "project-a",
            );
        }
        let mut pool = memories(&conn, "project-a", NOW).unwrap();
        for (i, m) in pool.iter_mut().enumerate() {
            m.files = vec![format!("src/{i}.ts")];
            m.verified_at = NOW - 10_000;
        }
        pool[0].verified_at = 0;
        pool[5].files.clear();
        let changes = Changes {
            committed_at: Some(BTreeMap::from([
                ("src/3.ts".into(), NOW - 11_000),
                ("src/4.ts".into(), NOW - 11_001),
            ])),
            uncommitted: BTreeSet::from(["src/1.ts".into()]),
            missing: BTreeSet::from(["src/2.ts".into()]),
        };
        let scope = partition(&pool, &changes, None);
        assert_eq!(
            json!(scope
                .selected
                .iter()
                .map(|i| pool[*i].id)
                .collect::<Vec<_>>()),
            fixture()["gate"]["selected"]
        );
        assert_eq!(json!(scope.skipped), fixture()["gate"]["skipped"]);
        assert_eq!(
            json!(scope
                .unmapped
                .iter()
                .map(|i| pool[*i].id)
                .collect::<Vec<_>>()),
            fixture()["gate"]["unmapped"]
        );
        assert_eq!(
            batches(&pool, &scope)
                .iter()
                .map(|b| b.iter().map(|m| m.id).collect::<Vec<_>>())
                .collect::<Vec<_>>(),
            vec![vec![2, 3, 4], vec![1]]
        );
        assert_eq!(
            partition(&pool, &Changes::default(), None).selected,
            vec![0, 1, 2, 3, 4]
        );
        pool[1].verified_at = NOW;
        let broad = partition(&pool, &changes, Some(NOW));
        assert_eq!(broad.selected, vec![0, 2, 3, 4]);
        assert_eq!(batch_slice_ms(1_200_000, 10), 240_000);
        assert_eq!(batch_slice_ms(720_001, 2), 360_000);
    }
    #[test]
    fn truncated_duplicate_low_coverage_and_lost_lease_commit_nothing() {
        let mut conn = database();
        verify_seed(&conn);
        let before = snapshot(&conn);
        for text in [
            "<verify><verified id=\"1\" files=\"src/a.ts\"/><verified id=\"2\" files=\"src/a.ts\"/><archive id=\"3\"/>",
            "<verify><verified id=\"1\"/><skip id=\"1\"/></verify>",
            "<verify><archive id=\"3\"/></verify>",
            "<verify></verify>",
        ] {
            let request = verify_request(&conn, text);
            assert!(apply(&mut conn, "bad", request).is_err());
            assert_eq!(snapshot(&conn), before);
        }
        let request = verify_request(&conn, fixture()["manifest"].as_str().unwrap());
        assert!(execute_value(
            &mut conn,
            &Queue,
            &context("lost"),
            request,
            |_| false,
            |f| Ok(f.to_vec())
        )
        .is_err());
        assert_eq!(snapshot(&conn), before);
        let mut request = verify_request(
            &conn,
            "<verify><verified id=\"1\" files=\"src/a.ts\"/></verify>",
        );
        request["budget_finalized"] = json!(true);
        assert_eq!(apply(&mut conn, "partial", request).unwrap()["verified"], 1);
        assert_eq!(
            rows(&conn, "SELECT id FROM memories WHERE verified_at IS NULL").len(),
            5
        );
    }
    #[test]
    fn source_revision_project_and_duplicate_guards_refuse_without_content_edits() {
        let mut conn = database();
        verify_seed(&conn);
        let mut request = verify_request(
            &conn,
            "<verify><archive id=\"3\" reason=\"gone\"/></verify>",
        );
        request["budget_finalized"] = json!(true);
        request["current_commit"] = json!("b".repeat(40));
        assert_eq!(apply(&mut conn, "source", request).unwrap()["refused"], 1);
        assert_eq!(
            row_json(&conn, 3).unwrap().unwrap()["verify_result"],
            "failed"
        );
        let mut request = verify_request(&conn, "<verify><archive id=\"3\"/></verify>");
        request["budget_finalized"] = json!(true);
        conn.execute("UPDATE memories SET revision=revision+1 WHERE id=3", [])
            .unwrap();
        assert_eq!(apply(&mut conn, "revision", request).unwrap()["refused"], 1);
        let mut request = verify_request(&conn, "<verify><archive id=\"3\"/></verify>");
        request["budget_finalized"] = json!(true);
        conn.execute(
            "UPDATE memories SET project_path='project-b' WHERE id=3",
            [],
        )
        .unwrap();
        assert_eq!(apply(&mut conn, "project", request).unwrap()["refused"], 1);
        let mut request=verify_request(&conn,"<verify><update id=\"2\" files=\"src/a.ts\">The handler has one argument.</update></verify>");
        request["budget_finalized"] = json!(true);
        assert_eq!(
            apply(&mut conn, "duplicate", request).unwrap()["refused"],
            1
        );
        assert!(rows(&conn, "SELECT * FROM memory_history").is_empty());
        assert!(rows(&conn, "SELECT effect FROM test_queue").is_empty());
        assert_ts_owns(&conn);
    }
    #[test]
    fn queue_failure_rolls_back_memory_history_receipts_and_expiry_rechecks_ttl() {
        struct Failing;
        impl MemoryEmbeddingQueue for Failing {
            fn enqueue_tx(&self, _: &Transaction<'_>, _: &EmbeddingEffect) -> rusqlite::Result<()> {
                Err(error("queue unavailable"))
            }
        }
        let mut conn = database();
        verify_seed(&conn);
        let before = snapshot(&conn);
        let request = verify_request(&conn, fixture()["manifest"].as_str().unwrap());
        assert!(execute_value(
            &mut conn,
            &Failing,
            &context("rollback"),
            request,
            |_| true,
            |f| Ok(f.to_vec())
        )
        .is_err());
        assert_eq!(snapshot(&conn), before);
        conn.execute("UPDATE memories SET expires_at=?1 WHERE id=1", [NOW])
            .unwrap();
        let selected = expired_ids(&conn, "project-a", NOW).unwrap();
        conn.execute("UPDATE memories SET expires_at=?1 WHERE id=1", [NOW + 1])
            .unwrap();
        assert_eq!(
            apply(
                &mut conn,
                "renewed",
                json!({"action":"expire","ids":selected})
            )
            .unwrap()["archived"],
            0
        );
    }
    struct Host {
        now: i64,
        calls: usize,
        timeout: bool,
        provider_error: bool,
    }
    impl VerifyHost for Host {
        fn now_ms(&self) -> i64 {
            self.now
        }
        fn head(&mut self) -> Option<String> {
            Some("a".repeat(40))
        }
        fn lease_owned(&mut self, _: &Connection) -> bool {
            true
        }
        fn normalize_files(&mut self, files: &[String]) -> Result<Vec<String>, String> {
            Ok(files.to_vec())
        }
        fn complete(&mut self, request: BatchRequest<'_>) -> Result<Completion, String> {
            let batch = request.batch;
            self.calls += 1;
            let provider_failure = self.provider_error.then(|| "provider failure".into());
            Ok(Completion {
                manifest: format!(
                    "<verify>{}</verify>",
                    batch
                        .iter()
                        .map(|m| format!("<verified id=\"{}\" files=\"src/a.ts\"/>", m.id))
                        .collect::<String>()
                ),
                budget_finalized: false,
                timed_out: self.timeout,
                provider_failure,
            })
        }
    }
    #[test]
    fn task_uses_adapter_bounded_batches_deadline_timeout_and_provider_fail_closed() {
        let mut conn = database();
        for id in 1..=21 {
            seed(
                &conn,
                id,
                &format!("Claim {id}."),
                "ARCHITECTURE",
                None,
                "active",
                "project-a",
            );
        }
        let mut host = Host {
            now: NOW,
            calls: 0,
            timeout: false,
            provider_error: false,
        };
        let result = run_verify(
            &mut conn,
            &Queue,
            &context("deadline"),
            &Changes::default(),
            None,
            NOW + BATCH_FLOOR_MS - 1,
            &mut host,
        )
        .unwrap();
        assert_eq!(host.calls, 0);
        assert_eq!(result.remaining, 21);
        assert_eq!(result.stop_reason, Some("deadline"));
        assert_eq!(
            serde_json::to_value(&result).unwrap(),
            fixture()["taskDeadline"]
        );
        host.timeout = true;
        let result = run_verify(
            &mut conn,
            &Queue,
            &context("timeout"),
            &Changes::default(),
            None,
            NOW + 900_000,
            &mut host,
        )
        .unwrap();
        assert_eq!(result.remaining, 21);
        assert_eq!(host.calls, 1);
        assert_eq!(result.stop_reason, Some("batch-timeout"));
        host.timeout = false;
        host.provider_error = true;
        assert!(run_verify(
            &mut conn,
            &Queue,
            &context("provider"),
            &Changes::default(),
            None,
            NOW + 900_000,
            &mut host
        )
        .is_err());
        assert!(rows(&conn, "SELECT * FROM memory_decision_receipts").is_empty());
        host.provider_error = false;
        let result = run_verify(
            &mut conn,
            &Queue,
            &context("task"),
            &Changes::default(),
            None,
            NOW + 900_000,
            &mut host,
        )
        .unwrap();
        assert!(result.complete);
        assert_eq!(result.batches, 2);
        assert_eq!(result.counts.verified, 21);
        assert_eq!(
            rows(
                &conn,
                "SELECT * FROM memory_verifications WHERE verified_at>0"
            )
            .len(),
            21
        );
    }

    #[test]
    fn pinned_ts_bounded_evidence_and_model_prompt_preserve_conservative_rules() {
        let conn = database();
        verify_seed(&conn);
        let pool = memories(&conn, "project-a", NOW).unwrap();
        let small = bounded_evidence(
            "a".repeat(40),
            vec![EvidenceFile {
                path: "src/a.ts".into(),
                text: "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n".into(),
                memory_ids: vec![1],
            }],
        );
        assert_eq!(
            build_prompt("project-a", &pool[..1], Some(&small)).unwrap(),
            fixture()["prompt"].as_str().unwrap()
        );
        assert_eq!(
            system_prompt().unwrap(),
            fixture()["system"].as_str().unwrap()
        );
        let large = bounded_evidence(
            "a".repeat(40),
            vec![EvidenceFile {
                path: "src/a.ts".into(),
                text: format!(
                    "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+{}\n",
                    "x".repeat(36_000)
                ),
                memory_ids: vec![1],
            }],
        );
        assert_eq!(large.mode, "ranges");
        assert_eq!(
            large.files[0].text,
            fixture()["largeEvidence"]["files"][0]["text"]
                .as_str()
                .unwrap()
        );
        assert_eq!(
            small.files[0].text,
            fixture()["smallEvidence"]["files"][0]["text"]
                .as_str()
                .unwrap()
        );
        assert!(build_prompt("project-a", &pool[..1], None)
            .unwrap()
            .contains("Read each memory's backing files"));
    }
    #[test]
    fn task_never_bumps_cache_epoch_or_publishes_prompt_fragments() {
        let mut conn = database();
        verify_seed(&conn);
        conn.execute("INSERT INTO project_state(project_path,project_memory_epoch,project_user_profile_version,updated_at) VALUES('project-a',17,23,41)",[]).unwrap();
        let before = rows(&conn, "SELECT * FROM project_state");
        let mut host = Host {
            now: NOW,
            calls: 0,
            timeout: false,
            provider_error: false,
        };
        run_verify(
            &mut conn,
            &Queue,
            &context("cache"),
            &Changes::default(),
            None,
            NOW + 900_000,
            &mut host,
        )
        .unwrap();
        conn.execute("UPDATE memories SET expires_at=?1 WHERE id=3", [NOW])
            .unwrap();
        assert_eq!(
            run_expiry(&mut conn, &Queue, &context("cache-expiry"), |_| true).unwrap(),
            1
        );
        assert_eq!(rows(&conn, "SELECT * FROM project_state"), before);
        assert!(rows(&conn, "SELECT * FROM memory_mutation_log").is_empty());
        assert_ts_owns(&conn);
    }
    #[test]
    fn adapter_refuses_primary_disabled_and_checks_actual_directive_not_request_copy() {
        let mut conn = database();
        verify_seed(&conn);
        let before = snapshot(&conn);
        let request = verify_request(&conn, fixture()["manifest"].as_str().unwrap());
        let primary = MemoryActionContext {
            role: MemoryRole::Primary,
            ..context("primary")
        };
        assert!(execute_value(
            &mut conn,
            &Queue,
            &primary,
            request.clone(),
            |_| true,
            |f| Ok(f.to_vec())
        )
        .is_err());
        let disabled = MemoryActionContext {
            memory_enabled: false,
            ..context("disabled")
        };
        assert!(execute_value(
            &mut conn,
            &Queue,
            &disabled,
            request,
            |_| true,
            |f| Ok(f.to_vec())
        )
        .is_err());
        assert_eq!(snapshot(&conn), before);
        let mut request = verify_request(
            &conn,
            "<verify><archive id=\"4\" reason=\"not in source\"/></verify>",
        );
        request["budget_finalized"] = json!(true);
        for memory in request["batch"].as_array_mut().unwrap() {
            if memory["id"] == 4 {
                memory["category"] = json!("ARCHITECTURE");
                memory["content"] = json!("A code fact.");
            }
        }
        assert_eq!(apply(&mut conn, "forged", request).unwrap()["refused"], 1);
        assert_eq!(row_json(&conn, 4).unwrap().unwrap()["status"], "active");
    }

    #[test]
    fn provider_outage_stops_after_two_identical_batches_and_applies_no_fragment() {
        let mut conn = database();
        for id in 1..=61 {
            seed(
                &conn,
                id,
                &format!("Claim {id}."),
                "ARCHITECTURE",
                None,
                "active",
                "project-a",
            );
        }
        let mut host = Host {
            now: NOW,
            calls: 0,
            timeout: false,
            provider_error: true,
        };
        let before = snapshot(&conn);
        assert_eq!(
            run_verify(
                &mut conn,
                &Queue,
                &context("outage"),
                &Changes::default(),
                None,
                NOW + 1_200_000,
                &mut host
            )
            .unwrap_err(),
            "provider failure"
        );
        assert_eq!(host.calls, 2);
        assert_eq!(snapshot(&conn), before);
    }
    #[test]
    fn pinned_ts_metadata_order_and_verified_commit_round_trip() {
        let mut conn = database();
        seed(
            &conn,
            1,
            "A metadata claim.",
            "ARCHITECTURE",
            None,
            "active",
            "project-a",
        );
        conn.execute(
            "UPDATE memories SET metadata_json=?1 WHERE id=1",
            [r#"{"z":{"b":2,"a":1},"dreamerVerifiedCommit":"old","a":1,"dreamerVerifiedAt":8}"#],
        )
        .unwrap();
        let request = verify_request(
            &conn,
            "<verify><verified id=\"1\" files=\"src/a.ts\"/></verify>",
        );
        apply(&mut conn, "metadata", request).unwrap();
        assert_eq!(
            row_json(&conn, 1).unwrap().unwrap()["metadata_json"],
            fixture()["metadataExpected"]
        );
        assert_eq!(
            memories(&conn, "project-a", NOW).unwrap()[0].verified_commit,
            Some("a".repeat(40))
        );
        conn.execute(
            "UPDATE memory_verifications SET verified_at=verified_at-1 WHERE memory_id=1",
            [],
        )
        .unwrap();
        assert_eq!(
            memories(&conn, "project-a", NOW).unwrap()[0].verified_commit,
            None
        );
    }
}
