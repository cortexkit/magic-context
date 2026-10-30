//! Shared history and recovery for module-owned and TS-owned project memories.
//! Each write repeats its ownership check under SQLite's writer lock; refusing a
//! request never transfers ownership to another writer.
use crate::FacadeMutationTxn;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

const FIELDS: &[&str] = &[
    "id",
    "projectPath",
    "revision",
    "category",
    "content",
    "normalizedHash",
    "importance",
    "scope",
    "shareable",
    "safetyCritical",
    "sourceSessionId",
    "sourceType",
    "seenCount",
    "retrievalCount",
    "firstSeenAt",
    "createdAt",
    "updatedAt",
    "lastSeenAt",
    "lastRetrievedAt",
    "status",
    "expiresAt",
    "verificationStatus",
    "verifiedAt",
    "supersededByMemoryId",
    "mergedFrom",
    "metadataJson",
];
const NULLABLE: &[&str] = &[
    "safetyCritical",
    "importance",
    "sourceSessionId",
    "sourceType",
    "lastRetrievedAt",
    "expiresAt",
    "verifiedAt",
    "supersededByMemoryId",
    "mergedFrom",
    "metadataJson",
];
const NUMERIC: &[&str] = &[
    "safetyCritical",
    "id",
    "revision",
    "importance",
    "shareable",
    "seenCount",
    "retrievalCount",
    "firstSeenAt",
    "createdAt",
    "updatedAt",
    "lastSeenAt",
    "lastRetrievedAt",
    "expiresAt",
    "verifiedAt",
    "supersededByMemoryId",
];
const CATEGORIES: &[&str] = &[
    "PROJECT_RULES",
    "ARCHITECTURE",
    "CONFIG_VALUES",
    "ARCHITECTURE_DECISIONS",
    "CONSTRAINTS",
    "CONFIG_DEFAULTS",
    "NAMING",
    "USER_PREFERENCES",
    "USER_DIRECTIVES",
    "ENVIRONMENT",
    "WORKFLOW_RULES",
    "KNOWN_ISSUES",
];
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RevisionExpectation {
    pub memory_id: i64,
    pub revision: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditChange {
    pub memory_id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditRequest {
    pub project_path: String,
    pub operation_id: String,
    pub expected_revisions: Vec<RevisionExpectation>,
    pub changes: Vec<EditChange>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RestoreRequest {
    pub project_path: String,
    pub decision_key: String,
    pub operation_id: String,
    pub expected_revisions: Vec<RevisionExpectation>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryRequest {
    pub project_path: String,
    pub memory_id: Option<i64>,
    pub limit: Option<usize>,
    pub cursor: Option<String>,
}
#[derive(Clone, Copy)]
pub enum MemoryWriter {
    Local,
    Module,
}
fn storage(error: impl std::fmt::Display) -> String {
    error.to_string()
}
fn snake(input: &str) -> String {
    input
        .chars()
        .flat_map(|c| {
            if c.is_ascii_uppercase() {
                vec!['_', c.to_ascii_lowercase()]
            } else {
                vec![c]
            }
        })
        .collect()
}
pub fn canonical_json(value: &Value) -> String {
    fn sorted(value: &Value) -> Value {
        match value {
            Value::Object(map) => serde_json::to_value(
                map.iter()
                    .map(|(key, value)| (key.clone(), sorted(value)))
                    .collect::<BTreeMap<_, _>>(),
            )
            .unwrap(),
            Value::Array(values) => Value::Array(values.iter().map(sorted).collect()),
            _ => value.clone(),
        }
    }
    serde_json::to_string(&sorted(value)).expect("JSON values serialize")
}
pub fn normalize_snapshot(input: &Value, revision: Option<i64>) -> Option<Value> {
    let input = if input.get("version").is_some() {
        if input["version"] != 1 {
            return None;
        }
        &input["snapshot"]
    } else {
        input
    };
    if !input.is_object() {
        return None;
    }
    let mut out = BTreeMap::new();
    for &field in FIELDS {
        let value = if let Some(value) = input.get(field).or_else(|| input.get(snake(field))) {
            value.clone()
        } else if let Some(revision) = revision.filter(|_| field == "revision") {
            json!(revision)
        } else {
            Value::Null
        };
        if value.is_null() {
            if !NULLABLE.contains(&field) {
                return None;
            }
        } else if NUMERIC.contains(&field) {
            if value
                .as_i64()
                .is_none_or(|n| n.unsigned_abs() > 9_007_199_254_740_991)
            {
                return None;
            }
        } else if !value.is_string() {
            return None;
        }
        out.insert(field, value);
    }
    let out = serde_json::to_value(out).ok()?;
    if out["id"].as_i64()? <= 0
        || out["revision"].as_i64()? <= 0
        || !CATEGORIES.contains(&out["category"].as_str()?)
        || !["active", "permanent", "archived"].contains(&out["status"].as_str()?)
        || !["project", "ecosystem", "universe"].contains(&out["scope"].as_str()?)
        || ![0, 1].contains(&out["shareable"].as_i64()?)
        || (!out["safetyCritical"].is_null() && ![0, 1].contains(&out["safetyCritical"].as_i64()?))
    {
        return None;
    }
    Some(out)
}
pub fn snapshot(conn: &Connection, id: i64) -> Result<Option<Value>, String> {
    let mut statement = conn
        .prepare("SELECT * FROM memories WHERE id=?1")
        .map_err(storage)?;
    let names = statement
        .column_names()
        .iter()
        .map(|name| name.to_string())
        .collect::<Vec<_>>();
    let raw = statement
        .query_row([id], |row| {
            let mut out = serde_json::Map::new();
            for (index, name) in names.iter().enumerate() {
                use rusqlite::types::ValueRef;
                let value = match row.get_ref(index)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(n) => json!(n),
                    ValueRef::Real(n) => json!(n),
                    ValueRef::Text(s) => json!(String::from_utf8_lossy(s)),
                    ValueRef::Blob(_) => Value::Null,
                };
                out.insert(name.clone(), value);
            }
            Ok(Value::Object(out))
        })
        .optional()
        .map_err(storage)?;
    Ok(raw
        .as_ref()
        .and_then(|value| normalize_snapshot(value, None)))
}
fn exists(conn: &Connection, table: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name=?1)",
        [table],
        |row| row.get(0),
    )
    .map_err(storage)
}
pub fn local_owns(conn: &Connection, project: &str) -> Result<bool, String> {
    for table in ["authority_managed", "authority_repair_pending"] {
        if exists(conn, table)?
            && conn
                .query_row(
                    &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE project_path=?1)"),
                    [project],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(storage)?
        {
            return Ok(false);
        }
    }
    Ok(true)
}
fn admitted(conn: &Connection, project: &str, writer: MemoryWriter) -> Result<bool, String> {
    match writer {
        MemoryWriter::Local => local_owns(conn, project),
        MemoryWriter::Module => {
            crate::memory_lifecycle::authority::module_owns_memory(conn, project).map_err(storage)
        }
    }
}
#[allow(clippy::too_many_arguments)]
pub fn decision(
    key: &str,
    project: &str,
    writer: &str,
    operation: &str,
    reason: &str,
    now: i64,
    before: &[Option<Value>],
    after: &[Value],
    source_ids: &[i64],
    survivor: Option<i64>,
    evidence: Value,
) -> Value {
    let rows=after.iter().enumerate().map(|(index,after)| { let prior=before.get(index).cloned().flatten(); let id=after["id"].as_i64().unwrap(); json!({"memoryId":id,"role":if survivor==Some(id){"survivor"}else if after.is_object() && source_ids.len()>1{"source"}else{"target"},"beforeRevision":prior.as_ref().map(|v|v["revision"].clone()),"afterRevision":after["revision"],"before":prior,"after":after,"completeness":"complete"}) }).collect::<Vec<_>>();
    json!({"version":1,"decisionKey":key,"projectPath":project,"writer":writer,"operation":operation,"reason":reason,"appliedAt":now,"evidence":evidence,"sourceIds":source_ids,"survivorId":survivor,"rows":rows,"restorable":true,"refusalReason":null})
}
pub fn record_decision(conn: &Connection, decision: &Value) -> Result<(), String> {
    for row in decision["rows"].as_array().ok_or("invalid decision")? {
        conn.execute("INSERT INTO memory_history(memory_id,revision,previous_text,after_text,before_json,after_json,applied_at,reason,evidence_json,source_ids_json,decision_key) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",params![row["memoryId"].as_i64(),row["beforeRevision"].as_i64().unwrap_or(0),row["before"]["content"].as_str().unwrap_or(""),row["after"]["content"].as_str().unwrap_or(""),canonical_json(&json!({"version":1,"snapshot":row["before"]})),canonical_json(&json!({"version":1,"snapshot":row["after"]})),decision["appliedAt"].as_i64(),decision["reason"].as_str(),canonical_json(&decision["evidence"]),canonical_json(&decision["sourceIds"]),decision["decisionKey"].as_str()]).map_err(storage)?;
    }
    Ok(())
}
pub fn read_decision(conn: &Connection, project: &str, key: &str) -> Result<Option<Value>, String> {
    let journal: Option<(Option<String>, Option<String>, String)> = conn.query_row("SELECT before_json,after_json,operation FROM memory_journal WHERE project_path=?1 AND decision_key=?2", params![project, key], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional().map_err(storage)?;
    let mut statement = conn.prepare("SELECT h.memory_id,h.revision,h.before_json,h.after_json,h.applied_at,h.reason,h.evidence_json FROM memory_history h JOIN memories m ON m.id=h.memory_id WHERE m.project_path=?1 AND h.decision_key=?2 ORDER BY h.id").map_err(storage)?;
    let records = statement
        .query_map(params![project, key], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
            ))
        })
        .map_err(storage)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(storage)?;
    let Some(first) = records.first() else {
        return Ok(None);
    };
    let total: usize = conn
        .query_row(
            "SELECT COUNT(*) FROM memory_history WHERE decision_key=?1",
            [key],
            |row| row.get(0),
        )
        .map_err(storage)?;
    let foreign = total != records.len();
    let parse = |raw: Option<&String>| {
        raw.and_then(|s| serde_json::from_str::<Value>(s).ok())
            .unwrap_or(Value::Null)
    };
    let saved = parse(journal.as_ref().and_then(|row| row.0.as_ref()));
    if !foreign
        && saved["version"] == 1
        && saved["decisionKey"] == key
        && saved["projectPath"] == project
        && saved["restorable"] == true
        && saved["rows"].as_array().is_some_and(|rows| {
            rows.len() == records.len()
                && rows
                    .iter()
                    .map(|row| row["memoryId"].as_i64())
                    .collect::<BTreeSet<_>>()
                    .len()
                    == records.len()
                && rows.iter().all(|row| {
                    records
                        .iter()
                        .any(|record| Some(record.0) == row["memoryId"].as_i64())
                        && row["completeness"] == "complete"
                        && row["afterRevision"] == row["after"]["revision"]
                        && row["beforeRevision"] == row["before"]["revision"]
                        && normalize_snapshot(&row["after"], None).is_some()
                        && row["after"]["projectPath"] == project
                        && row["memoryId"] == row["after"]["id"]
                        && (row["before"].is_null()
                            || (normalize_snapshot(&row["before"], None).is_some()
                                && row["before"]["projectPath"] == project
                                && row["before"]["id"] == row["memoryId"]))
                })
        })
    {
        return Ok(Some(saved));
    }
    let after_journal = parse(journal.as_ref().and_then(|row| row.1.as_ref()));
    let paired = saved
        .as_array()
        .zip(after_journal.as_array())
        .filter(|(before, after)| before.len() == after.len());
    let entries = if let Some((before, after)) = paired {
        after
            .iter()
            .enumerate()
            .map(|(index, after)| {
                let revision = records
                    .iter()
                    .find(|row| Some(row.0) == after["id"].as_i64())
                    .map(|row| row.1);
                (
                    before[index].clone(),
                    after.clone(),
                    revision,
                    records.get(index).map(|row| row.0).unwrap_or(0),
                )
            })
            .collect::<Vec<_>>()
    } else {
        records
            .iter()
            .map(|row| {
                (
                    parse(row.2.as_ref()),
                    parse(row.3.as_ref()),
                    Some(row.1),
                    row.0,
                )
            })
            .collect()
    };
    let rows = entries.iter().map(|(before,after,revision,id)| {
        let prior = normalize_snapshot(before,*revision); let after = normalize_snapshot(after,revision.map(|rev|rev+1)); let created = paired.is_some() && before.is_null() && after.is_some();
        json!({"memoryId":after.as_ref().or(prior.as_ref()).and_then(|row|row["id"].as_i64()).unwrap_or(*id),"role":if created{"survivor"}else if entries.len()>1{"source"}else{"target"},"beforeRevision":prior.as_ref().map(|row|row["revision"].clone()),"afterRevision":after.as_ref().map(|row|row["revision"].clone()),"completeness":if after.is_some()&&(prior.is_some()||created){"complete"}else{"legacy-partial"},"before":prior,"after":after})
    }).collect::<Vec<_>>();
    let complete = !foreign
        && saved.get("version").is_none()
        && rows.iter().all(|row| {
            row["completeness"] == "complete"
                && row["after"]["projectPath"] == project
                && (row["before"].is_null() || row["before"]["projectPath"] == project)
        });
    let operation = journal
        .as_ref()
        .map(|row| row.2.as_str())
        .unwrap_or(&first.5);
    let writer = journal
        .as_ref()
        .map(|row| row.2.split('_').next().unwrap_or("unknown"))
        .unwrap_or_else(|| key.split(':').next().unwrap_or("unknown"));
    let survivor = rows
        .iter()
        .find(|row| row["role"] == "survivor")
        .map(|row| row["memoryId"].clone());
    Ok(Some(
        json!({"version":1,"decisionKey":key,"projectPath":project,"writer":writer,"operation":operation,"reason":first.5,"appliedAt":first.4,"evidence":serde_json::from_str::<Value>(&first.6).unwrap_or(Value::Null),"sourceIds":records.iter().map(|row|row.0).collect::<Vec<_>>(),"survivorId":survivor,"rows":rows,"restorable":complete,"refusalReason":if complete{Value::Null}else{json!("incomplete_decision")}}),
    ))
}

struct Plan {
    state: &'static str,
    reason: Option<&'static str>,
    conflicts: Vec<Value>,
    before: Vec<Value>,
    after: Vec<Value>,
    decision: Option<Value>,
}
impl Plan {
    fn failed(state: &'static str, reason: &'static str, conflicts: Vec<Value>) -> Self {
        Self {
            state,
            reason: Some(reason),
            conflicts,
            before: vec![],
            after: vec![],
            decision: None,
        }
    }
}
fn plan(
    conn: &Connection,
    request: &Value,
    now: i64,
    writer: MemoryWriter,
    check_revisions: bool,
) -> Result<Plan, String> {
    let project = request["projectPath"].as_str().ok_or("invalid_request")?;
    if !admitted(conn, project, writer)? {
        return Ok(Plan::failed("refused", "authority_unavailable", vec![]));
    }
    let restoring = request.get("decisionKey").is_some();
    let decision = if restoring {
        read_decision(
            conn,
            project,
            request["decisionKey"].as_str().ok_or("invalid_request")?,
        )?
    } else {
        None
    };
    if restoring && decision.is_none() {
        return Ok(Plan::failed("refused", "history_not_found", vec![]));
    }
    if restoring
        && decision
            .as_ref()
            .is_some_and(|value| value["restorable"] != true)
    {
        return Ok(Plan::failed("refused", "incomplete_decision", vec![]));
    }
    let rows = if restoring {
        decision.as_ref().unwrap()["rows"]
            .as_array()
            .ok_or("invalid_request")?
    } else {
        request["changes"].as_array().ok_or("invalid_request")?
    };
    let ids = rows
        .iter()
        .map(|row| row["memoryId"].as_i64())
        .collect::<Option<Vec<_>>>()
        .ok_or("invalid_request")?;
    if ids.is_empty()
        || ids.iter().any(|id| *id <= 0)
        || ids.iter().collect::<BTreeSet<_>>().len() != ids.len()
    {
        return Ok(Plan::failed("refused", "invalid_request", vec![]));
    }
    let expectations = request["expectedRevisions"]
        .as_array()
        .ok_or("invalid_request")?;
    if check_revisions
        && (expectations.len() != ids.len()
            || expectations
                .iter()
                .map(|row| row["memoryId"].as_i64())
                .collect::<BTreeSet<_>>()
                .len()
                != ids.len()
            || expectations.iter().any(|row| {
                row["revision"].as_i64().is_none_or(|rev| rev <= 0)
                    || !ids.contains(&row["memoryId"].as_i64().unwrap_or(0))
            }))
    {
        return Ok(Plan::failed("refused", "invalid_request", vec![]));
    }
    let mut before = vec![];
    let mut after = vec![];
    for &id in &ids {
        let Some(current) = snapshot(conn, id)? else {
            return Ok(Plan::failed("refused", "target_not_owned", vec![]));
        };
        if current["projectPath"] != project {
            return Ok(Plan::failed("refused", "target_not_owned", vec![]));
        }
        let expected = expectations
            .iter()
            .find(|row| row["memoryId"] == id)
            .and_then(|row| row["revision"].as_i64());
        let revision = current["revision"].as_i64().unwrap();
        if check_revisions && Some(revision) != expected {
            return Ok(Plan::failed(
                "conflict",
                "stale_revision",
                vec![json!({"memoryId":id,"expectedRevision":expected,"currentRevision":revision})],
            ));
        }
        let mut target = current.clone();
        let row = rows.iter().find(|row| row["memoryId"] == id).unwrap();
        if restoring {
            if [
                "content",
                "category",
                "importance",
                "scope",
                "status",
                "expiresAt",
                "supersededByMemoryId",
                "mergedFrom",
                "metadataJson",
                "safetyCritical",
                "sourceSessionId",
                "sourceType",
            ]
            .iter()
            .any(|&field| current[field] != row["after"][field])
            {
                return Ok(Plan::failed(
                    "conflict",
                    if rows.len() > 1 {
                        "successor_changed"
                    } else {
                        "stale_revision"
                    },
                    vec![
                        json!({"memoryId":id,"expectedRevision":expected,"currentRevision":revision}),
                    ],
                ));
            }
            let operation = decision.as_ref().unwrap()["operation"]
                .as_str()
                .unwrap_or("");
            if (operation.contains("merge") || operation == "replaces")
                && !current["supersededByMemoryId"].is_null()
            {
                let link: Option<String> = conn.query_row("SELECT decision_key FROM memory_successor_links WHERE source_id=?1 AND successor_id=?2", params![id, current["supersededByMemoryId"].as_i64()], |row|row.get(0)).optional().map_err(storage)?;
                if link.as_deref() != decision.as_ref().unwrap()["decisionKey"].as_str() {
                    return Ok(Plan::failed(
                        "conflict",
                        "successor_changed",
                        vec![
                            json!({"memoryId":id,"expectedRevision":expected,"currentRevision":revision}),
                        ],
                    ));
                }
            }
            if row["before"].is_null()
                || row["role"] == "survivor"
                || decision.as_ref().unwrap()["survivorId"] == id
            {
                let dependents = conn
                    .prepare("SELECT id FROM memories WHERE superseded_by_memory_id=?1")
                    .map_err(storage)?
                    .query_map([id], |row| row.get::<_, i64>(0))
                    .map_err(storage)?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(storage)?;
                if dependents.iter().any(|source| !ids.contains(source)) {
                    return Ok(Plan::failed("conflict", "successor_changed", vec![]));
                }
            }
            if row["before"].is_null() {
                target["status"] = json!("archived");
                target["supersededByMemoryId"] = Value::Null;
            } else {
                for field in [
                    "category",
                    "content",
                    "importance",
                    "scope",
                    "status",
                    "expiresAt",
                    "supersededByMemoryId",
                    "mergedFrom",
                    "metadataJson",
                    "safetyCritical",
                    "sourceSessionId",
                    "sourceType",
                ] {
                    target[field] = row["before"][field].clone();
                }
                if matches!(
                    decision.as_ref().unwrap()["operation"].as_str(),
                    Some("new" | "conflict")
                ) {
                    target["seenCount"] = row["before"]["seenCount"].clone();
                    target["lastSeenAt"] = row["before"]["lastSeenAt"].clone();
                }
            }
        } else {
            for field in ["content", "category", "status"] {
                if let Some(value) = row.get(field) {
                    target[field] = if field == "content" {
                        json!(value
                            .as_str()
                            .ok_or("invalid_request")?
                            .trim_matches(crate::is_js_whitespace))
                    } else {
                        value.clone()
                    };
                }
            }
        }
        let content = target["content"].as_str().ok_or("invalid_request")?;
        if content.trim_matches(crate::is_js_whitespace).is_empty()
            || content.encode_utf16().count() > 20_000
            || !CATEGORIES.contains(&target["category"].as_str().unwrap_or(""))
            || !["active", "permanent", "archived"]
                .contains(&target["status"].as_str().unwrap_or(""))
            || !["project", "ecosystem", "universe"]
                .contains(&target["scope"].as_str().unwrap_or(""))
        {
            return Ok(Plan::failed("refused", "invalid_request", vec![]));
        }
        target["normalizedHash"] = json!(crate::compute_normalized_memory_hash(content));
        target["shareable"] = json!(0);
        target["verificationStatus"] = json!("unverified");
        target["verifiedAt"] = Value::Null;
        target["updatedAt"] = json!(now);
        target["revision"] = json!(revision + 1);
        before.push(current);
        after.push(target);
    }
    if !restoring
        && after.iter().zip(&before).all(|(target, prior)| {
            ["content", "category", "status"]
                .iter()
                .all(|&field| target[field] == prior[field])
        })
    {
        return Ok(Plan::failed("refused", "no_change", vec![]));
    }
    for target in &after {
        let id = target["id"].as_i64().unwrap();
        if after.iter().any(|other| {
            other["id"] != id
                && other["category"] == target["category"]
                && other["normalizedHash"] == target["normalizedHash"]
        }) {
            return Ok(Plan::failed("conflict", "duplicate_content", vec![]));
        }
        let mut statement=conn.prepare("SELECT id FROM memories WHERE project_path=?1 AND category=?2 AND normalized_hash=?3 AND id!=?4").map_err(storage)?;
        let collisions = statement
            .query_map(
                params![
                    project,
                    target["category"].as_str(),
                    target["normalizedHash"].as_str(),
                    id
                ],
                |row| row.get::<_, i64>(0),
            )
            .map_err(storage)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage)?;
        if let Some(duplicate) = collisions.iter().find(|id| !ids.contains(id)) {
            let rev = target["revision"].as_i64().unwrap() - 1;
            return Ok(Plan::failed(
                "conflict",
                "duplicate_content",
                vec![
                    json!({"memoryId":id,"expectedRevision":rev,"currentRevision":rev,"duplicateId":duplicate}),
                ],
            ));
        }
        if let Some(successor) = target["supersededByMemoryId"].as_i64() {
            if successor == id
                || snapshot(conn, successor)?.is_none_or(|value| value["projectPath"] != project)
            {
                return Ok(Plan::failed("refused", "target_not_owned", vec![]));
            }
        }
    }
    Ok(Plan {
        state: "ready",
        reason: None,
        conflicts: vec![],
        before,
        after,
        decision,
    })
}
fn epoch_identity(project: &str) -> String {
    if project.starts_with("git:") || project.starts_with("dir:") {
        return project.to_owned();
    }
    let input = std::path::Path::new(project);
    let mut path = if input.is_absolute() {
        std::path::PathBuf::new()
    } else {
        std::env::current_dir().unwrap_or_default()
    };
    for component in input.components() {
        match component {
            std::path::Component::RootDir => path.push("/"),
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                path.pop();
            }
            _ => path.push(component.as_os_str()),
        }
    }
    let hash = format!("{:x}", md5::compute(path.to_string_lossy().as_bytes()));
    format!("dir:{}", &hash[..12])
}
fn apply_plan(
    conn: &Connection,
    plan: &Plan,
    key: &str,
    project: &str,
    now: i64,
    writer: &str,
) -> Result<Value, String> {
    for source in &plan.before {
        let changed = conn.execute("UPDATE memories SET normalized_hash=?1,revision=revision+1 WHERE id=?2 AND revision=?3", params![format!("history-pending:{key}:{}", source["id"].as_i64().unwrap()), source["id"].as_i64(), source["revision"].as_i64()]).map_err(storage)?;
        if changed != 1 {
            return Err("Memory revision changed during apply".into());
        }
    }
    for (index, target) in plan.after.iter().enumerate() {
        let source = &plan.before[index];
        let changed=conn.execute("UPDATE memories SET content=?1,category=?2,normalized_hash=?3,importance=?4,scope=?5,status=?6,expires_at=?7,superseded_by_memory_id=?8,merged_from=?9,metadata_json=?10,shareable=0,classified_at=NULL,verification_status='unverified',verified_at=NULL,updated_at=?11 WHERE id=?12 AND revision=?13",params![target["content"].as_str(),target["category"].as_str(),target["normalizedHash"].as_str(),target["importance"].as_i64(),target["scope"].as_str(),target["status"].as_str(),target["expiresAt"].as_i64(),target["supersededByMemoryId"].as_i64(),target["mergedFrom"].as_str(),target["metadataJson"].as_str(),now,target["id"].as_i64(),source["revision"].as_i64().map(|revision| revision + 1)]).map_err(storage)?;
        if changed != 1 {
            return Err("Memory revision changed during apply".into());
        }
        conn.execute(
            "UPDATE memories SET safety_critical=?1 WHERE id=?2",
            params![target["safetyCritical"].as_i64(), target["id"].as_i64()],
        )
        .map_err(storage)?;
        conn.execute(
            "UPDATE memories SET source_session_id=?1,source_type=?2,seen_count=?3,last_seen_at=?4 WHERE id=?5",
            params![target["sourceSessionId"].as_str(), target["sourceType"].as_str(), target["seenCount"].as_i64(), target["lastSeenAt"].as_i64(), target["id"].as_i64()],
        ).map_err(storage)?;
        if let Some(restored) = plan
            .decision
            .as_ref()
            .and_then(|decision| decision["rows"].as_array())
            .and_then(|rows| rows.iter().find(|row| row["memoryId"] == target["id"]))
            .map(|row| &row["before"])
            .filter(|before| !before.is_null())
        {
            // Evidence follows the restored text, but the revision number must never go backwards.
            conn.execute("INSERT INTO memory_clause_evidence(memory_id,revision,clause_ordinal,text_hash,evidence_json) SELECT memory_id,?1,clause_ordinal,text_hash,evidence_json FROM memory_clause_evidence WHERE memory_id=?2 AND revision=?3", params![target["revision"].as_i64(), target["id"].as_i64(), restored["revision"].as_i64()]).map_err(storage)?;
        }
        conn.execute(
            "DELETE FROM memory_embeddings WHERE memory_id=?1",
            [target["id"].as_i64()],
        )
        .map_err(storage)?;
        if exists(conn, "memory_verifications")? {
            conn.execute(
                "DELETE FROM memory_verifications WHERE memory_id=?1",
                [target["id"].as_i64()],
            )
            .map_err(storage)?;
        }
        let columns = conn
            .prepare("PRAGMA table_info(memories)")
            .map_err(storage)?
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(storage)?
            .collect::<Result<BTreeSet<_>, _>>()
            .map_err(storage)?;
        let derived = [
            "mural_cue",
            "mural_cue_hash",
            "mural_cue_at",
            "verify_result",
            "verify_files_json",
            "verify_commit",
        ]
        .iter()
        .filter(|column| columns.contains(**column))
        .map(|column| format!("{column}=NULL"))
        .collect::<Vec<_>>();
        if !derived.is_empty() {
            conn.execute(
                &format!("UPDATE memories SET {} WHERE id=?1", derived.join(",")),
                [target["id"].as_i64()],
            )
            .map_err(storage)?;
        }
    }
    if let Some(decision) = &plan.decision {
        conn.execute(
            "DELETE FROM memory_successor_links WHERE decision_key=?1",
            [decision["decisionKey"].as_str()],
        )
        .map_err(storage)?;
        conn.execute(
            "DELETE FROM memory_conflict_links WHERE decision_key=?1",
            [decision["decisionKey"].as_str()],
        )
        .map_err(storage)?;
    }
    for target in &plan.after {
        if !target["supersededByMemoryId"].is_null() {
            conn.execute("INSERT OR IGNORE INTO memory_successor_links(source_id,successor_id,decision_key) VALUES(?1,?2,?3)",params![target["id"].as_i64(),target["supersededByMemoryId"].as_i64(),key]).map_err(storage)?;
        }
    }
    let reason = plan.decision.as_ref().map_or_else(
        || "dashboard_edit".into(),
        |decision| format!("restore:{}", decision["decisionKey"].as_str().unwrap()),
    );
    let evidence=plan.decision.as_ref().map_or_else(||json!([]),|decision|json!({"restoredDecisionKey":decision["decisionKey"],"originalEvidence":decision["evidence"]}));
    let decision = decision(
        key,
        project,
        writer,
        if writer == "dashboard_restore" {
            "restore"
        } else {
            "edit"
        },
        &reason,
        now,
        &plan.before.iter().cloned().map(Some).collect::<Vec<_>>(),
        &plan.after,
        &plan
            .before
            .iter()
            .map(|row| row["id"].as_i64().unwrap())
            .collect::<Vec<_>>(),
        None,
        evidence,
    );
    record_decision(conn, &decision)?;
    // Keep the prompt delta in the canonical write transaction. The epoch remains
    // a search-cache signal, not permission to rebuild a session's prefix.
    for target in &plan.after {
        let kind = if !target["supersededByMemoryId"].is_null() {
            "superseded"
        } else if target["status"] == "archived" {
            "archive"
        } else {
            "update"
        };
        conn.execute("INSERT INTO memory_mutation_log(project_path,mutation_type,target_memory_id,superseded_by_id,category,new_content,queued_at,operation_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)", params![project,kind,target["id"].as_i64(),target["supersededByMemoryId"].as_i64(),target["category"].as_str(),target["content"].as_str(),now,format!("dashboard:{key}")]).map_err(storage)?;
    }
    let epoch_project = epoch_identity(project);
    let mut identities = BTreeSet::from([epoch_project.clone()]);
    if exists(conn, "workspace_members")? {
        let mut statement=conn.prepare("SELECT project_path FROM workspace_members WHERE workspace_id IN (SELECT workspace_id FROM workspace_members WHERE project_path=?1)").map_err(storage)?;
        for member in statement
            .query_map([&epoch_project], |row| row.get::<_, String>(0))
            .map_err(storage)?
        {
            identities.insert(member.map_err(storage)?);
        }
    }
    for identity in identities {
        conn.execute("INSERT INTO project_state(project_path,project_memory_epoch,project_user_profile_version,updated_at) VALUES(?1,1,0,?2) ON CONFLICT(project_path) DO UPDATE SET project_memory_epoch=project_memory_epoch+1,updated_at=excluded.updated_at",params![identity,now]).map_err(storage)?;
    }
    Ok(decision)
}
fn receipt(
    request: &Value,
    state: &str,
    reason: Option<&str>,
    key: Option<&str>,
    revisions: Value,
    conflicts: Value,
) -> Value {
    let mut value = json!({"version":1,"state":state,"projectPath":request["projectPath"],"operationId":request["operationId"],"reason":reason,"decisionKey":key,"revisions":revisions,"conflicts":conflicts});
    if let Some(original) = request.get("decisionKey") {
        value["decisionKey"] = original.clone();
        value["restoredDecisionKey"] = json!(key);
        value["adoption"] = json!("next_allowed_bust");
    }
    value
}
impl FacadeMutationTxn<'_> {
    pub fn audited_memory_write(
        &self,
        request: &Value,
        now: i64,
        writer: MemoryWriter,
    ) -> Result<Value, String> {
        let project = request["projectPath"].as_str().ok_or("invalid_request")?;
        let operation = request["operationId"].as_str().ok_or("invalid_request")?;
        if operation.is_empty() || operation.encode_utf16().count() > 128 {
            return Ok(receipt(
                request,
                "refused",
                Some("invalid_request"),
                None,
                json!([]),
                json!([]),
            ));
        }
        if !admitted(self.tx, project, writer)? {
            return Ok(receipt(
                request,
                "refused",
                Some("authority_unavailable"),
                None,
                json!([]),
                json!([]),
            ));
        }
        let restoring = request.get("decisionKey").is_some();
        let key = canonical_json(&json!([
            if restoring {
                "memory-restore"
            } else {
                "memory-edit"
            },
            project,
            operation
        ]));
        let mut identity = request.clone();
        let expectations = identity["expectedRevisions"]
            .as_array_mut()
            .ok_or("invalid_request")?;
        expectations.sort_by_key(|row| row["memoryId"].as_i64());
        let identity = canonical_json(&identity);
        let other_key = canonical_json(&json!([
            if restoring {
                "memory-edit"
            } else {
                "memory-restore"
            },
            project,
            operation
        ]));
        let used = self.tx.query_row("SELECT EXISTS(SELECT 1 FROM memory_decision_receipts WHERE decision_key=?1 AND project_path=?2)", params![other_key, project], |row|row.get::<_,bool>(0)).map_err(storage)?;
        if used {
            return Ok(receipt(
                request,
                "refused",
                Some("operation_id_reused"),
                None,
                json!([]),
                json!([]),
            ));
        }
        let saved:Option<String>=self.tx.query_row("SELECT receipt_json FROM memory_decision_receipts WHERE decision_key=?1 AND project_path=?2",params![key,project],|row|row.get(0)).optional().map_err(storage)?;
        if let Some(saved) = saved {
            let value: Value = serde_json::from_str(&saved).map_err(storage)?;
            return Ok(if value["identity"] == identity {
                value["receipt"].clone()
            } else {
                receipt(
                    request,
                    "refused",
                    Some("operation_id_reused"),
                    None,
                    json!([]),
                    json!([]),
                )
            });
        }
        let plan = plan(self.tx, request, now, writer, true)?;
        let result = if plan.state != "ready" {
            receipt(
                request,
                plan.state,
                plan.reason,
                None,
                json!([]),
                json!(plan.conflicts),
            )
        } else {
            let decision = apply_plan(
                self.tx,
                &plan,
                &key,
                project,
                now,
                if restoring {
                    "dashboard_restore"
                } else {
                    "dashboard_edit"
                },
            )?;
            let result = receipt(
                request,
                "applied",
                None,
                Some(&key),
                json!(plan
                    .after
                    .iter()
                    .map(|row| json!({"memoryId":row["id"],"revision":row["revision"]}))
                    .collect::<Vec<_>>()),
                json!([]),
            );
            self.tx.execute("INSERT INTO memory_journal(project_path,decision_key,operation,receipt_json,applied_at,before_json,after_json) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![project,key,decision["writer"].as_str(),canonical_json(&result),now,canonical_json(&decision),canonical_json(&decision)]).map_err(storage)?;
            result
        };
        self.tx.execute("INSERT INTO memory_decision_receipts(decision_key,project_path,fact_id,receipt_json,resolved_at) VALUES(?1,?2,NULL,?3,?4)",params![key,project,canonical_json(&json!({"identity":identity,"receipt":result})),now]).map_err(storage)?;
        Ok(result)
    }
}
/// Local editor entry point. Admission and durable replay run under SQLite's writer lock.
pub fn local_write(conn: &mut Connection, request: &Value, now: i64) -> Result<Value, String> {
    let request = validate_write_request(
        if request.get("decisionKey").is_some() {
            "memory.restore"
        } else {
            "memory.edit"
        },
        request,
    )?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage)?;
    let result = FacadeMutationTxn {
        tx: &tx,
        automated: true,
        // History edits only update existing ids, so their placement stays unchanged.
        memory_writer: None,
    }
    .audited_memory_write(&request, now, MemoryWriter::Local)?;
    tx.commit().map_err(storage)?;
    Ok(result)
}
pub fn preview(
    conn: &Connection,
    project: &str,
    key: &str,
    now: i64,
    writer: MemoryWriter,
) -> Result<Value, String> {
    let request = json!({"projectPath":project,"decisionKey":key,"operationId":"preview","expectedRevisions":[]});
    let plan = plan(conn, &request, now, writer, false)?;
    let decision = match plan.decision {
        Some(decision) => Some(decision),
        None => read_decision(conn, project, key)?,
    };
    let mut current_rows = vec![];
    if let Some(rows) = decision
        .as_ref()
        .and_then(|decision| decision["rows"].as_array())
    {
        for row in rows {
            if let Some(current) =
                snapshot(conn, row["memoryId"].as_i64().ok_or("invalid_request")?)?
            {
                if current["projectPath"] == project {
                    current_rows.push(current);
                }
            }
        }
    }
    Ok(
        json!({"version":1,"state":plan.state,"projectPath":project,"decisionKey":key,"reason":plan.reason,"decision":decision,"expectedRevisions":current_rows.iter().map(|row|json!({"memoryId":row["id"],"revision":row["revision"]})).collect::<Vec<_>>(),"changes":plan.after.iter().zip(&plan.before).map(|(after,before)|json!({"memoryId":after["id"],"before":before,"after":after})).collect::<Vec<_>>(),"adoption":"next_allowed_bust"}),
    )
}

pub fn history(conn: &Connection, request: &HistoryRequest) -> Result<Value, String> {
    if request.project_path.is_empty()
        || request.memory_id.is_some_and(|id| {
            snapshot(conn, id)
                .ok()
                .flatten()
                .is_none_or(|row| row["projectPath"] != request.project_path)
        })
    {
        return Err("target_not_owned".into());
    }
    let cursor = request
        .cursor
        .as_ref()
        .map(|raw| serde_json::from_str::<Value>(raw).map_err(storage))
        .transpose()?;
    if cursor.as_ref().is_some_and(|value| {
        value["projectPath"] != request.project_path
            || value.get("memoryId").and_then(Value::as_i64) != request.memory_id
            || value["high"].as_i64().is_none()
            || value["time"].as_i64().is_none()
            || value["key"].as_str().is_none()
    }) {
        return Err("invalid_request".into());
    }
    let high = match &cursor {
        Some(value) => value["high"].as_i64().unwrap(),
        None => conn
            .query_row(
                "SELECT COALESCE(MAX(id),0) FROM memory_history",
                [],
                |row| row.get(0),
            )
            .map_err(storage)?,
    };
    let limit = request.limit.unwrap_or(25).clamp(1, 100);
    let mut statement=conn.prepare("SELECT h.decision_key,MAX(h.applied_at) time FROM memory_history h JOIN memories m ON m.id=h.memory_id WHERE m.project_path=?1 AND h.id<=?2 AND (?3 IS NULL OR h.decision_key IN (SELECT decision_key FROM memory_history WHERE memory_id=?3)) GROUP BY h.decision_key HAVING (?4 IS NULL OR MAX(h.applied_at)<?4 OR (MAX(h.applied_at)=?4 AND h.decision_key<?5)) ORDER BY time DESC,h.decision_key DESC LIMIT ?6").map_err(storage)?;
    let selected = statement
        .query_map(
            params![
                request.project_path,
                high,
                request.memory_id,
                cursor.as_ref().and_then(|v| v["time"].as_i64()),
                cursor.as_ref().and_then(|v| v["key"].as_str()),
                (limit + 1) as i64
            ],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .map_err(storage)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(storage)?;
    let mut decisions = vec![];
    for (key, _) in selected.iter().take(limit) {
        if let Some(value) = read_decision(conn, &request.project_path, key)? {
            decisions.push(value);
        }
    }
    let next = if selected.len() > limit {
        let (key, time) = &selected[limit - 1];
        let mut value =
            json!({"projectPath":request.project_path,"high":high,"time":time,"key":key});
        if let Some(id) = request.memory_id {
            value["memoryId"] = json!(id);
        }
        Some(canonical_json(&value))
    } else {
        None
    };
    Ok(json!({"version":1,"decisions":decisions,"nextCursor":next}))
}
impl crate::McStore {
    pub fn memory_history_rpc(
        &self,
        method: &str,
        request: &Value,
        now: i64,
    ) -> Result<Value, crate::McStoreError> {
        let sql_error = |error: String| {
            rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(error)))
        };
        match method {
            "memory.history" => self.context_read(|conn| {
                let request: HistoryRequest = serde_json::from_value(request.clone())
                    .map_err(|error| sql_error(storage(error)))?;
                history(conn, &request).map_err(sql_error)
            }),
            "memory.restore.preview" => self.context_read(|conn| {
                preview(
                    conn,
                    request["projectPath"]
                        .as_str()
                        .ok_or(rusqlite::Error::InvalidQuery)?,
                    request["decisionKey"]
                        .as_str()
                        .ok_or(rusqlite::Error::InvalidQuery)?,
                    now,
                    MemoryWriter::Module,
                )
                .map_err(sql_error)
            }),
            "memory.restore" | "memory.edit" => {
                let request = validate_write_request(method, request).map_err(|error| {
                    crate::McStoreError::Store(cortexkit_store::StoreError::Backend(error))
                })?;
                self.context_write(
                    &[
                        "memories",
                        "memory_history",
                        "memory_journal",
                        "memory_decision_receipts",
                        "memory_successor_links",
                        "memory_embeddings",
                        "memory_verifications",
                        "project_state",
                    ],
                    |tx| {
                        FacadeMutationTxn {
                            tx,
                            automated: true,
                            // Restore and edit only update existing ids; neither creates a memory.
                            memory_writer: None,
                        }
                        .audited_memory_write(&request, now, MemoryWriter::Module)
                        .map_err(sql_error)
                    },
                )
            }
            _ => Err(crate::McStoreError::Store(
                cortexkit_store::StoreError::Backend("unknown memory method".into()),
            )),
        }
    }
}

pub(crate) fn capture(conn: &Connection) -> Result<BTreeMap<i64, Value>, String> {
    let mut statement = conn
        .prepare("SELECT id FROM memories ORDER BY id")
        .map_err(storage)?;
    let ids = statement
        .query_map([], |row| row.get::<_, i64>(0))
        .map_err(storage)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(storage)?;
    let mut rows = BTreeMap::new();
    for id in ids {
        if let Some(value) = snapshot(conn, id)? {
            rows.insert(id, value);
        }
    }
    Ok(rows)
}
pub(crate) fn finish_capture(
    conn: &Connection,
    before: &BTreeMap<i64, Value>,
    key: &str,
    writer: &str,
    operation: &str,
    now: i64,
) -> Result<(), String> {
    let mut changed = vec![];
    for (id, row) in capture(conn)? {
        if before
            .get(&id)
            .is_some_and(|prior| prior["revision"] == row["revision"])
        {
            continue;
        }
        let prior_revision = before
            .get(&id)
            .and_then(|prior| prior["revision"].as_i64())
            .unwrap_or(0);
        let recorded = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM memory_history WHERE memory_id=?1 AND revision=?2)",
                params![id, prior_revision],
                |row| row.get::<_, bool>(0),
            )
            .map_err(storage)?;
        if !recorded {
            changed.push((id, row));
        }
    }
    if changed.is_empty() {
        return Ok(());
    }
    let project = changed[0].1["projectPath"]
        .as_str()
        .ok_or("invalid project")?;
    if changed.iter().any(|(_, row)| row["projectPath"] != project) {
        return Err("cross-project decision".into());
    }
    for (id, row) in &changed {
        if let Some(successor) = row["supersededByMemoryId"].as_i64() {
            conn.execute("INSERT OR IGNORE INTO memory_successor_links(source_id,successor_id,decision_key) VALUES(?1,?2,?3)", params![id, successor, key]).map_err(storage)?;
        }
    }
    let prior = changed
        .iter()
        .map(|(id, _)| before.get(id).cloned())
        .collect::<Vec<_>>();
    let after = changed
        .iter()
        .map(|(_, row)| row.clone())
        .collect::<Vec<_>>();
    let ids = changed
        .iter()
        .filter(|(id, _)| before.contains_key(id))
        .map(|(id, _)| *id)
        .collect::<Vec<_>>();
    let survivor = if operation == "merge" {
        changed
            .iter()
            .find(|(_, row)| row["status"] != "archived")
            .map(|(id, _)| *id)
    } else {
        None
    };
    let decision = decision(
        key,
        project,
        writer,
        operation,
        &format!("{writer}_{operation}"),
        now,
        &prior,
        &after,
        &ids,
        survivor,
        json!([]),
    );
    record_decision(conn, &decision)?;
    conn.execute("INSERT INTO memory_journal(project_path,decision_key,operation,receipt_json,applied_at,before_json,after_json) VALUES(?1,?2,?3,'{}',?4,?5,?5)",params![project,key,format!("{writer}_{operation}"),now,canonical_json(&decision)]).map_err(storage)?;
    Ok(())
}

/// Public normalized-content hash used by canonical writers and fixture builders.
pub fn normalized_hash(content: &str) -> String {
    crate::compute_normalized_memory_hash(content)
}

/// History and preview use a read snapshot, including when the module's host is idle.
pub fn readonly_rpc(
    conn: &mut Connection,
    method: &str,
    request: &Value,
    now: i64,
) -> Result<Value, String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Deferred)
        .map_err(storage)?;
    let result = match method {
        "memory.history" => history(
            &tx,
            &serde_json::from_value(request.clone()).map_err(storage)?,
        )?,
        "memory.restore.preview" => {
            let project = request["projectPath"].as_str().ok_or("invalid_request")?;
            preview(
                &tx,
                project,
                request["decisionKey"].as_str().ok_or("invalid_request")?,
                now,
                if local_owns(&tx, project)? {
                    MemoryWriter::Local
                } else {
                    MemoryWriter::Module
                },
            )?
        }
        _ => return Err("unknown_memory_method".into()),
    };
    tx.commit().map_err(storage)?;
    Ok(result)
}

/// A display message or a partial response cannot certify an atomic multi-row write.
pub fn valid_receipt(method: &str, request: &Value, value: &Value) -> bool {
    let positive = |v: &Value| {
        v.as_i64()
            .is_some_and(|n| n > 0 && n <= 9_007_199_254_740_991)
    };
    if value["version"] != 1
        || value["projectPath"] != request["projectPath"]
        || value["operationId"] != request["operationId"]
        || value.get("reason").is_none()
        || (!value["reason"].is_null() && !value["reason"].is_string())
    {
        return false;
    }
    let Some(state) = value["state"].as_str() else {
        return false;
    };
    if !["applied", "refused", "conflict"].contains(&state) {
        return false;
    }
    let Some(revisions) = value["revisions"].as_array() else {
        return false;
    };
    let Some(conflicts) = value["conflicts"].as_array() else {
        return false;
    };
    if revisions
        .iter()
        .any(|row| !positive(&row["memoryId"]) || !positive(&row["revision"]))
        || revisions
            .iter()
            .map(|row| row["memoryId"].as_i64())
            .collect::<BTreeSet<_>>()
            .len()
            != revisions.len()
        || conflicts.iter().any(|row| {
            !positive(&row["memoryId"])
                || row.get("expectedRevision").is_none()
                || row.get("currentRevision").is_none()
                || (!row["expectedRevision"].is_null() && !positive(&row["expectedRevision"]))
                || (!row["currentRevision"].is_null() && !positive(&row["currentRevision"]))
                || row.get("duplicateId").is_some_and(|id| !positive(id))
        })
    {
        return false;
    }
    if (value.get(if method == "memory.restore" {
        "restoredDecisionKey"
    } else {
        "decisionKey"
    }))
    .is_none()
    {
        return false;
    }
    let decision = if method == "memory.restore" {
        if value["decisionKey"] != request["decisionKey"]
            || !matches!(
                value["adoption"].as_str(),
                Some("next_allowed_bust" | "dashboard_epoch_hard")
            )
        {
            return false;
        }
        &value["restoredDecisionKey"]
    } else {
        &value["decisionKey"]
    };
    if state == "applied" {
        let Some(expected) = request["expectedRevisions"].as_array() else {
            return false;
        };
        value["reason"].is_null()
            && decision.as_str().is_some_and(|key| !key.is_empty())
            && expected.len() == revisions.len()
            && revisions.iter().all(|row| {
                expected
                    .iter()
                    .any(|expectation| expectation["memoryId"] == row["memoryId"])
            })
    } else {
        decision.is_null()
            && revisions.is_empty()
            && value["reason"]
                .as_str()
                .is_some_and(|reason| !reason.is_empty())
    }
}

pub fn validate_write_request(method: &str, request: &Value) -> Result<Value, String> {
    match method {
        "memory.restore" => serde_json::from_value::<RestoreRequest>(request.clone())
            .and_then(serde_json::to_value)
            .map_err(|_| "invalid_request".into()),
        "memory.edit" => serde_json::from_value::<EditRequest>(request.clone())
            .and_then(serde_json::to_value)
            .map_err(|_| "invalid_request".into()),
        _ => Err("unknown_memory_method".into()),
    }
}

pub fn refused_write(request: &Value, reason: &str) -> Value {
    receipt(request, "refused", Some(reason), None, json!([]), json!([]))
}
