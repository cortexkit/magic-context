//! Incremental provider storage. Request handlers supply pre-op JSON bytes and
//! decide hook policy inside a single fenced transaction; no engine state is read.
use crate::{McStore, McStoreError, McTagRow, ProviderSessionKey};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug)]
pub enum ProviderError {
    Storage(McStoreError),
    InvalidParams { field: &'static str },
    Transient(String),
}
impl std::fmt::Display for ProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Storage(e) => e.fmt(f),
            Self::InvalidParams { field } => write!(f, "conflicting provider {field}"),
            Self::Transient(reason) => f.write_str(reason),
        }
    }
}
impl std::error::Error for ProviderError {}
impl From<rusqlite::Error> for ProviderError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Transient(e.to_string())
    }
}

impl ProviderSessionKey {
    pub fn conversation_key(&self) -> String {
        serde_json::to_string(&(&self.project_root, &self.session, &self.harness)).unwrap()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProviderConversation {
    pub lineage_id: String,
    pub preset: Option<String>,
    pub params_json: String,
    pub setup_json: Option<String>,
    pub engine_namespace: String,
    pub version_high_water: u64,
    pub rebuild_epoch: u64,
    pub hook_counters_json: String,
    pub last_answer_json: Option<String>,
    pub wait_request: Option<String>,
    pub cursor_frontier: u64,
    pub served_through_ordinal: Option<u64>,
    pub historian_model_chain_json: String,
}
impl Default for ProviderConversation {
    fn default() -> Self {
        Self {
            lineage_id: String::new(),
            preset: None,
            params_json: "{}".into(),
            setup_json: None,
            engine_namespace: String::new(),
            version_high_water: 0,
            rebuild_epoch: 0,
            hook_counters_json: "{}".into(),
            last_answer_json: None,
            wait_request: None,
            cursor_frontier: 0,
            served_through_ordinal: None,
            historian_model_chain_json: "[]".into(),
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderMessage {
    pub ordinal: u64,
    pub mid: String,
    pub message_bytes: Vec<u8>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderLineage {
    pub lineage_id: String,
    pub first_ordinal: u64,
    pub descends_from: Option<String>,
    pub through_ordinal: Option<u64>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderSubject {
    pub subject_mid: String,
    pub hook: String,
    pub subject_part: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProviderAnswerTag {
    pub number: i64,
    pub block_id: String,
    pub kind: String,
    pub source: String,
    pub token_count: i64,
    pub created_at_ms: i64,
}
#[derive(Clone, Debug)]
pub struct ProviderHookAnswer {
    pub subject: ProviderSubject,
    pub ordinal: u64,
    pub ops_json: String,
    pub tags: Vec<ProviderAnswerTag>,
}
#[derive(Clone, Debug)]
pub struct ProviderStoredAnswer {
    pub lineage_id: String,
    pub answer: ProviderHookAnswer,
    pub state: String,
}
/// Policy sees counters after burns and promotion, never a transcript snapshot.
#[derive(Debug)]
pub struct ProviderHookContext {
    pub counters: Value,
    pub policy: ProviderPolicyTotals,
    pub tag_high_water: i64,
    pub pending_answers: u64,
    pub live_answers: u64,
}

/// Content-free, admission-time contributions. They are adjusted transactionally
/// when an answer is burned or its tool output is queued for release.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct ProviderPolicyTotals {
    pub text_tokens: i64,
    pub tool_tokens: i64,
    pub reclaimable_tokens: i64,
    pub tool_outputs: i64,
    pub real_users: i64,
}

fn policy_totals(counters: &Value) -> rusqlite::Result<ProviderPolicyTotals> {
    serde_json::from_value(
        counters
            .get("policy_totals")
            .cloned()
            .unwrap_or_else(|| json!({})),
    )
    .map_err(sql_json)
}

fn adjust_policy_tx(
    conn: &Connection,
    conv: &str,
    delta: &ProviderPolicyTotals,
    sign: i64,
) -> rusqlite::Result<()> {
    let raw: String = conn.query_row(
        "SELECT hook_counters_json FROM mc_provider_conversations_v2 WHERE conv_key=?1",
        [conv],
        |r| r.get(0),
    )?;
    let mut counters = parse(&raw)?;
    let mut totals = policy_totals(&counters)?;
    totals.text_tokens += sign * delta.text_tokens;
    totals.tool_tokens += sign * delta.tool_tokens;
    totals.reclaimable_tokens += sign * delta.reclaimable_tokens;
    totals.tool_outputs += sign * delta.tool_outputs;
    totals.real_users += sign * delta.real_users;
    counters["policy_totals"] = serde_json::to_value(totals).map_err(sql_json)?;
    conn.execute(
        "UPDATE mc_provider_conversations_v2 SET hook_counters_json=?2 WHERE conv_key=?1",
        params![conv, counters.to_string()],
    )?;
    Ok(())
}

fn remove_policy_tx(
    conn: &Connection,
    conv: &str,
    predicate: &str,
    parameters: impl rusqlite::Params,
) -> rusqlite::Result<()> {
    let mut q = conn.prepare(&format!("SELECT answer_seq,policy_json FROM mc_provider_hook_answers_v1 WHERE conv_key=?1 AND state IN ('pending','live') AND {predicate}"))?;
    let rows = q
        .query_map(parameters, |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (seq, raw) in rows {
        let mut policy = parse(&raw)?;
        if let Some(metrics) = policy.get("metrics") {
            let metrics: ProviderPolicyTotals =
                serde_json::from_value(metrics.clone()).map_err(sql_json)?;
            adjust_policy_tx(conn, conv, &metrics, -1)?;
            policy["metrics"] = json!({});
            conn.execute("UPDATE mc_provider_hook_answers_v1 SET policy_json=?3 WHERE conv_key=?1 AND answer_seq=?2",params![conv,seq,policy.to_string()])?;
        }
    }
    Ok(())
}

/// Restore cadence from the newest surviving answer, not from an allocation
/// that a timed-out or repeated subject has just burned.
fn surviving_policy_state_tx(
    conn: &Connection,
    conv: &str,
    lineage: &str,
) -> rusqlite::Result<Value> {
    let mut latest = None;
    for (ancestor, cut) in ancestry_tx(conn, conv, lineage)? {
        let row: Option<(i64,String)> = conn.query_row("SELECT answer_seq,policy_json FROM mc_provider_hook_answers_v1 WHERE conv_key=?1 AND lineage_id=?2 AND ordinal<=?3 AND state IN ('pending','live') AND legacy_json IS NULL ORDER BY answer_seq DESC LIMIT 1",params![conv,ancestor.lineage_id,as_i64(cut)?],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        if let Some(row) = row {
            if latest
                .as_ref()
                .is_none_or(|(seq, _): &(i64, String)| row.0 > *seq)
            {
                latest = Some(row);
            }
        }
    }
    latest
        .map(|(_, raw)| parse(&raw))
        .transpose()
        .map(|p| p.unwrap_or_else(|| json!({})))
}

/// Consume releases on the caller's transaction, so a rebuild and its queue
/// drain cannot become separately durable. Repeated consumption is a no-op.
pub fn consume_provider_drops_tx(
    conn: &Connection,
    key: &ProviderSessionKey,
    numbers: &[i64],
) -> rusqlite::Result<()> {
    let conv = key.conversation_key();
    for number in numbers {
        if conn.execute(
            "DELETE FROM mc_provider_pending_drops_v1 WHERE conv_key=?1 AND tag_number=?2",
            params![conv, number],
        )? == 0
        {
            continue;
        }
        let mut q=conn.prepare("SELECT a.answer_seq,a.policy_json,t.key,json_extract(t.value,'$.kind'),coalesce(json_extract(t.value,'$.token_count'),0) FROM mc_provider_hook_answers_v1 a,json_each(a.tags_json) t WHERE a.conv_key=?1 AND a.state IN ('pending','live') AND json_extract(t.value,'$.number')=?2")?;
        let rows = q
            .query_map(params![conv, number], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (seq, raw, index, kind, tokens) in rows {
            let mut policy = parse(&raw)?;
            let mut metrics: ProviderPolicyTotals =
                serde_json::from_value(policy.get("metrics").cloned().unwrap_or_else(|| json!({})))
                    .map_err(sql_json)?;
            let delta = if kind == "tool_result" {
                ProviderPolicyTotals {
                    tool_tokens: metrics.tool_tokens,
                    ..Default::default()
                }
            } else {
                ProviderPolicyTotals {
                    text_tokens: tokens.min(metrics.text_tokens).max(0),
                    ..Default::default()
                }
            };
            adjust_policy_tx(conn, &conv, &delta, -1)?;
            metrics.tool_tokens -= delta.tool_tokens;
            metrics.text_tokens -= delta.text_tokens;
            policy["metrics"] = serde_json::to_value(metrics).map_err(sql_json)?;
            conn.execute("UPDATE mc_provider_hook_answers_v1 SET policy_json=?3,tags_json=json_set(tags_json,?4,true) WHERE conv_key=?1 AND answer_seq=?2",params![conv,seq,policy.to_string(),format!("$[{index}].consumed")])?;
        }
    }
    Ok(())
}
pub struct ProviderHookWrite {
    pub answer: Option<ProviderHookAnswer>,
    pub counters: Value,
}
pub struct ProviderHookRequest<'a> {
    pub lineage: &'a ProviderLineage,
    pub message: Option<&'a ProviderMessage>,
    pub served_through_ordinal: Option<u64>,
    pub unserved_subjects: &'a [ProviderSubject],
    /// A retry burns only this subject's pending answer, including its tool part.
    pub repeat_subject: Option<&'a ProviderSubject>,
}

pub struct ProviderStatusPage<'a> {
    pub lineage: &'a ProviderLineage,
    pub messages: &'a [ProviderMessage],
    pub served: Option<u64>,
    pub unserved: &'a [ProviderSubject],
    pub newest: Option<u64>,
    pub more: bool,
}

fn sql_json(e: serde_json::Error) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(e))
}
fn parse(raw: &str) -> rusqlite::Result<Value> {
    serde_json::from_str(raw).map_err(sql_json)
}
fn as_i64(n: u64) -> rusqlite::Result<i64> {
    i64::try_from(n).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))
}
pub(crate) fn conversation_tx(
    conn: &Connection,
    key: &ProviderSessionKey,
) -> rusqlite::Result<Option<ProviderConversation>> {
    conn.query_row("SELECT lineage_id,preset,params_json,setup_json,engine_namespace,version_high_water,rebuild_epoch,hook_counters_json,last_answer_json,wait_request,cursor_frontier,served_through_ordinal,historian_model_chain_json FROM mc_provider_conversations_v2 WHERE conv_key=?1", [key.conversation_key()], |r| Ok(ProviderConversation {
        lineage_id:r.get(0)?, preset:r.get(1)?, params_json:r.get(2)?, setup_json:r.get(3)?, engine_namespace:r.get(4)?, version_high_water:r.get(5)?, rebuild_epoch:r.get(6)?, hook_counters_json:r.get(7)?, last_answer_json:r.get(8)?, wait_request:r.get(9)?, cursor_frontier:r.get(10)?, served_through_ordinal:r.get(11)?, historian_model_chain_json:r.get(12)?,
    })).optional()
}
pub(crate) fn save_conversation_tx(
    conn: &Connection,
    key: &ProviderSessionKey,
    c: &ProviderConversation,
) -> rusqlite::Result<()> {
    conn.execute("INSERT INTO mc_provider_conversations_v2 (conv_key,project_root,session,harness,lineage_id,preset,params_json,setup_json,engine_namespace,version_high_water,rebuild_epoch,hook_counters_json,last_answer_json,wait_request,cursor_frontier,served_through_ordinal,historian_model_chain_json)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)
        ON CONFLICT(conv_key) DO UPDATE SET lineage_id=excluded.lineage_id,preset=excluded.preset,params_json=excluded.params_json,setup_json=excluded.setup_json,engine_namespace=excluded.engine_namespace,version_high_water=max(version_high_water,excluded.version_high_water),rebuild_epoch=excluded.rebuild_epoch,hook_counters_json=excluded.hook_counters_json,last_answer_json=excluded.last_answer_json,wait_request=excluded.wait_request,cursor_frontier=excluded.cursor_frontier,served_through_ordinal=excluded.served_through_ordinal,historian_model_chain_json=excluded.historian_model_chain_json",
        params![key.conversation_key(),key.project_root,key.session,key.harness,c.lineage_id,c.preset,c.params_json,c.setup_json,c.engine_namespace,as_i64(c.version_high_water)?,as_i64(c.rebuild_epoch)?,c.hook_counters_json,c.last_answer_json,c.wait_request,as_i64(c.cursor_frontier)?,c.served_through_ordinal.map(as_i64).transpose()?,c.historian_model_chain_json])?;
    Ok(())
}
fn lineage_tx(
    conn: &Connection,
    conv: &str,
    lineage: &str,
) -> rusqlite::Result<Option<ProviderLineage>> {
    conn.query_row("SELECT lineage_id,first_ordinal,descends_from,through_ordinal FROM mc_provider_lineages_v1 WHERE conv_key=?1 AND lineage_id=?2", params![conv,lineage], |r| Ok(ProviderLineage {lineage_id:r.get(0)?,first_ordinal:r.get(1)?,descends_from:r.get(2)?,through_ordinal:r.get(3)?})).optional()
}
/// Leaf first, with each ancestor bounded by all intervening cuts.
fn ancestry_tx(
    conn: &Connection,
    conv: &str,
    lineage: &str,
) -> rusqlite::Result<Vec<(ProviderLineage, u64)>> {
    let mut rows = Vec::new();
    let mut current = lineage.to_string();
    let mut through = i64::MAX as u64;
    while let Some(row) = lineage_tx(conn, conv, &current)? {
        if rows
            .iter()
            .any(|(r, _): &(ProviderLineage, u64)| r.lineage_id == current)
        {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let parent = row.descends_from.clone();
        let cut = row.through_ordinal;
        rows.push((row, through));
        let Some(parent) = parent else { break };
        through = through.min(cut.ok_or(rusqlite::Error::InvalidQuery)?);
        current = parent;
    }
    Ok(rows)
}
fn messages_tx(
    conn: &Connection,
    conv: &str,
    lineage: &str,
) -> rusqlite::Result<Vec<ProviderMessage>> {
    let mut messages = Vec::new();
    for (row, through) in ancestry_tx(conn, conv, lineage)? {
        let mut q = conn.prepare("SELECT ordinal,mid,message_bytes FROM mc_provider_messages_v1 WHERE conv_key=?1 AND lineage_id=?2 AND ordinal<=?3 ORDER BY ordinal")?;
        messages.extend(
            q.query_map(params![conv, row.lineage_id, as_i64(through)?], |r| {
                Ok(ProviderMessage {
                    ordinal: r.get(0)?,
                    mid: r.get(1)?,
                    message_bytes: r.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?,
        );
    }
    messages.sort_by_key(|m| m.ordinal);
    Ok(messages)
}
fn frontier_tx(conn: &Connection, conv: &str, lineage: &str) -> rusqlite::Result<u64> {
    let ancestors = ancestry_tx(conn, conv, lineage)?;
    let Some((root, _)) = ancestors.last() else {
        return Ok(0);
    };
    let mut next = root.first_ordinal;
    let mut ordinals = Vec::new();
    for (row, through) in ancestors {
        let mut q = conn.prepare("SELECT ordinal FROM mc_provider_messages_v1 WHERE conv_key=?1 AND lineage_id=?2 AND ordinal<=?3 ORDER BY ordinal")?;
        ordinals.extend(
            q.query_map(params![conv, row.lineage_id, as_i64(through)?], |r| {
                r.get::<_, u64>(0)
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?,
        );
    }
    ordinals.sort_unstable();
    for ordinal in ordinals {
        if ordinal != next {
            break;
        }
        next += 1;
    }
    Ok(next)
}

/// Acknowledgement is bounded by held ordinals, not by the caller's newest
/// claim. Reading MAX keeps this check independent of transcript payload size.
fn acknowledged_through_tx(
    conn: &Connection,
    conv: &str,
    c: &ProviderConversation,
    row: &ProviderLineage,
    new_lineage: bool,
    served: Option<u64>,
) -> Result<Option<u64>, ProviderError> {
    let reverting = new_lineage && row.descends_from.as_deref() == Some(&c.lineage_id);
    let previous = if reverting {
        c.served_through_ordinal
            .map(|n| n.min(row.through_ordinal.expect("validated descent")))
    } else {
        c.served_through_ordinal
    };
    let Some(served) = served else {
        // Absence is not confirmation, but must not erase the monotone watermark.
        return Ok(previous);
    };
    let mut newest = None;
    for (ancestor, cut) in ancestry_tx(conn, conv, &row.lineage_id)? {
        let held: Option<u64> = conn.query_row(
            "SELECT max(ordinal) FROM mc_provider_messages_v1 WHERE conv_key=?1 AND lineage_id=?2 AND ordinal<=?3",
            params![conv, ancestor.lineage_id, as_i64(cut)?], |r| r.get(0),
        )?;
        newest = newest.max(held);
    }
    if served > newest.unwrap_or(0) || previous.is_some_and(|n| served < n) {
        return Err(ProviderError::InvalidParams {
            field: "served_through_ordinal",
        });
    }
    Ok(Some(served))
}
fn ensure_lineage_tx(
    conn: &Connection,
    conv: &str,
    row: &ProviderLineage,
) -> Result<(), ProviderError> {
    if let Some(held) = lineage_tx(conn, conv, &row.lineage_id)? {
        if held != *row {
            return Err(ProviderError::InvalidParams {
                field: "lineage_id",
            });
        }
        return Ok(());
    }
    match (&row.descends_from, row.through_ordinal) {
        (Some(parent), Some(cut))
            if parent != &row.lineage_id && row.first_ordinal == cut.saturating_add(1) =>
        {
            if lineage_tx(conn, conv, parent)?.is_none() || frontier_tx(conn, conv, parent)? <= cut
            {
                return Err(ProviderError::Transient(
                    "unsatisfied lineage descent".into(),
                ));
            }
            for (ancestor, _) in ancestry_tx(conn, conv, parent)? {
                remove_policy_tx(
                    conn,
                    conv,
                    "lineage_id=?2 AND ordinal>?3",
                    params![conv, ancestor.lineage_id, as_i64(cut)?],
                )?;
                burn_where_tx(
                    conn,
                    conv,
                    "lineage_id=?2 AND ordinal>?3",
                    params![conv, ancestor.lineage_id, as_i64(cut)?],
                )?;
                conn.execute("UPDATE mc_provider_hook_answers_v1 SET state='burned' WHERE conv_key=?1 AND lineage_id=?2 AND ordinal>?3 AND state='pending'",params![conv,ancestor.lineage_id,as_i64(cut)?])?;
            }
        }
        (None, None) => {
            let exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM mc_provider_lineages_v1 WHERE conv_key=?1)",
                [conv],
                |r| r.get(0),
            )?;
            if exists {
                return Err(ProviderError::InvalidParams {
                    field: "lineage_id",
                });
            }
        }
        _ => {
            return Err(ProviderError::InvalidParams {
                field: "lineage_id",
            })
        }
    }
    conn.execute(
        "INSERT INTO mc_provider_lineages_v1 VALUES (?1,?2,?3,?4,?5,json_extract(?1,'$[1]'))",
        params![
            conv,
            row.lineage_id,
            as_i64(row.first_ordinal)?,
            row.descends_from,
            row.through_ordinal.map(as_i64).transpose()?
        ],
    )?;
    Ok(())
}
fn held_message_tx(
    conn: &Connection,
    conv: &str,
    lineage: &str,
    ordinal: u64,
    mid: &str,
) -> rusqlite::Result<(Option<ProviderMessage>, Option<u64>)> {
    let mut at_ordinal = None;
    let mut at_mid = None;
    for (row, through) in ancestry_tx(conn, conv, lineage)? {
        if ordinal <= through && at_ordinal.is_none() {
            at_ordinal = conn.query_row("SELECT ordinal,mid,message_bytes FROM mc_provider_messages_v1 WHERE conv_key=?1 AND lineage_id=?2 AND ordinal=?3", params![conv,row.lineage_id,as_i64(ordinal)?], |r| Ok(ProviderMessage {ordinal:r.get(0)?,mid:r.get(1)?,message_bytes:r.get(2)?})).optional()?;
        }
        if at_mid.is_none() {
            at_mid = conn.query_row("SELECT ordinal FROM mc_provider_messages_v1 WHERE conv_key=?1 AND lineage_id=?2 AND mid=?3 AND ordinal<=?4",params![conv,row.lineage_id,mid,as_i64(through)?], |r|r.get(0)).optional()?;
        }
    }
    Ok((at_ordinal, at_mid))
}
pub(crate) fn insert_message_tx(
    conn: &Connection,
    conv: &str,
    lineage: &str,
    m: &ProviderMessage,
) -> Result<bool, ProviderError> {
    let (at_ordinal, at_mid) = held_message_tx(conn, conv, lineage, m.ordinal, &m.mid)?;
    if at_ordinal.as_ref().is_some_and(|p| p.mid != m.mid) {
        return Err(ProviderError::InvalidParams {
            field: "subject_ordinal",
        });
    }
    if at_mid.is_some_and(|o| o != m.ordinal) {
        return Err(ProviderError::InvalidParams {
            field: "subject_mid",
        });
    }
    if let Some(held) = at_ordinal {
        if held.message_bytes != m.message_bytes {
            return Err(ProviderError::Transient(
                "an ingested ordinal changed".into(),
            ));
        }
        return Ok(false);
    }
    let first = lineage_tx(conn, conv, lineage)?
        .ok_or(rusqlite::Error::InvalidQuery)?
        .first_ordinal;
    if m.ordinal < first {
        return Err(ProviderError::InvalidParams {
            field: "subject_ordinal",
        });
    }
    // Validate without re-encoding: whitespace, key order and escape spelling are
    // part of the host's frozen message and must survive unchanged.
    serde_json::from_slice::<Value>(&m.message_bytes)
        .map_err(|e| ProviderError::Transient(e.to_string()))?;
    conn.execute(
        "INSERT INTO mc_provider_messages_v1 VALUES (?1,?2,?3,?4,?5,json_extract(?1,'$[1]'))",
        params![conv, lineage, as_i64(m.ordinal)?, m.mid, m.message_bytes],
    )?;
    Ok(true)
}
fn burn_where_tx(
    conn: &Connection,
    _conv: &str,
    predicate: &str,
    parameters: impl rusqlite::Params,
) -> rusqlite::Result<()> {
    // Pending drops are scoped to answer allocations. Burning cannot remove a
    // drop queued on an unrelated live answer.
    conn.execute(&format!("DELETE FROM mc_provider_pending_drops_v1 WHERE conv_key=?1 AND tag_number IN (SELECT json_extract(t.value,'$.number') FROM mc_provider_hook_answers_v1 a,json_each(a.tags_json) t WHERE a.conv_key=?1 AND a.state='pending' AND {predicate})"),parameters)?;
    // The caller updates the same selected answers to burned immediately after
    // discarding their drops, within this transaction.
    Ok(())
}
fn burn_subject_tx(
    conn: &Connection,
    conv: &str,
    lineage: &str,
    s: &ProviderSubject,
) -> rusqlite::Result<()> {
    let predicate = "lineage_id=?2 AND subject_mid=?3 AND hook=?4 AND subject_part=?5";
    remove_policy_tx(
        conn,
        conv,
        &format!("state='pending' AND {predicate}"),
        params![conv, lineage, s.subject_mid, s.hook, s.subject_part],
    )?;
    burn_where_tx(
        conn,
        conv,
        predicate,
        params![conv, lineage, s.subject_mid, s.hook, s.subject_part],
    )?;
    conn.execute("UPDATE mc_provider_hook_answers_v1 SET state='burned' WHERE conv_key=?1 AND lineage_id=?2 AND subject_mid=?3 AND hook=?4 AND subject_part=?5 AND state='pending'",params![conv,lineage,s.subject_mid,s.hook,s.subject_part])?;
    Ok(())
}
pub(crate) fn insert_tags_tx(
    conn: &Connection,
    namespace: &str,
    tags: &[McTagRow],
) -> rusqlite::Result<()> {
    for t in tags {
        conn.execute("INSERT OR IGNORE INTO mc_tags (session_id,tag_number,block_id,kind,token_count,created_at_ms,source_bytes) VALUES (?1,?2,?3,?4,?5,?6,?7)",params![namespace,t.tag_number,t.block_id,t.kind,t.token_count,t.created_at_ms,t.source_bytes.as_ref()])?;
    }
    Ok(())
}
fn promote_tx(
    conn: &Connection,
    conv: &str,
    namespace: &str,
    lineage: &str,
    served: Option<u64>,
) -> rusqlite::Result<()> {
    let Some(served) = served else { return Ok(()) };
    for (row, cut) in ancestry_tx(conn, conv, lineage)? {
        let through = served.min(cut);
        let mut q = conn.prepare("SELECT answer_seq,tags_json FROM mc_provider_hook_answers_v1 WHERE conv_key=?1 AND lineage_id=?2 AND state='pending' AND ordinal<=?3 AND legacy_json IS NULL")?;
        let answers = q
            .query_map(params![conv, row.lineage_id, as_i64(through)?], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (seq, tags) in answers {
            let tags: Vec<ProviderAnswerTag> = serde_json::from_str(&tags).map_err(sql_json)?;
            let rows = tags
                .into_iter()
                .map(|t| McTagRow {
                    tag_number: t.number,
                    block_id: t.block_id,
                    kind: t.kind,
                    token_count: t.token_count,
                    created_at_ms: t.created_at_ms,
                    source_bytes: t.source.into_bytes().into(),
                })
                .collect::<Vec<_>>();
            insert_tags_tx(conn, namespace, &rows)?;
            conn.execute("UPDATE mc_provider_hook_answers_v1 SET state='live' WHERE conv_key=?1 AND answer_seq=?2",params![conv,seq])?;
        }
    }
    Ok(())
}

impl McStore {
    pub fn load_provider_policy_totals(
        &self,
        key: &ProviderSessionKey,
    ) -> Result<ProviderPolicyTotals, McStoreError> {
        Ok(self.inner.with_conn(|conn| {
            let c = conversation_tx(conn, key)?.ok_or(rusqlite::Error::InvalidQuery)?;
            policy_totals(&parse(&c.hook_counters_json)?)
        })?)
    }

    /// Resolve only requested numbers, never hydrate stored messages or ops.
    pub fn provider_answer_tag_known(
        &self,
        key: &ProviderSessionKey,
        number: i64,
    ) -> Result<bool, McStoreError> {
        Ok(self.inner.with_conn(|conn| {
            let Some(c)=conversation_tx(conn,key)? else {return Ok(false)};
            for (ancestor,cut) in ancestry_tx(conn,&key.conversation_key(),&c.lineage_id)? {
                let known:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM mc_provider_hook_answers_v1 a,json_each(a.tags_json) t WHERE a.conv_key=?1 AND a.lineage_id=?2 AND a.ordinal<=?3 AND a.state IN ('pending','live') AND a.legacy_json IS NULL AND json_extract(t.value,'$.number')=?4 AND NOT coalesce(json_extract(t.value,'$.consumed'),false))",params![key.conversation_key(),ancestor.lineage_id,as_i64(cut)?,number],|r|r.get(0))?;
                if known {return Ok(true)}
            }
            Ok(false)
        })?)
    }
    pub fn load_provider_conversation(
        &self,
        key: &ProviderSessionKey,
    ) -> Result<Option<ProviderConversation>, McStoreError> {
        Ok(self.inner.with_conn(|conn| conversation_tx(conn, key))?)
    }
    /// Read only the lineage's ordinal origin and ancestry. Sparse status pages
    /// need this metadata even when they carry no messages; hydrating the message
    /// log to recover it would turn a noop into whole-history work.
    pub fn load_provider_lineage(
        &self,
        key: &ProviderSessionKey,
        lineage_id: &str,
    ) -> Result<Option<ProviderLineage>, McStoreError> {
        Ok(self
            .inner
            .with_conn(|conn| lineage_tx(conn, &key.conversation_key(), lineage_id))?)
    }
    /// Advance a frozen view's application state without reading or rewriting
    /// replacement bytes. An invalidated/rejected view cannot become applied.
    pub fn set_provider_view_state(
        &self,
        key: &ProviderSessionKey,
        version: u64,
        state: &str,
    ) -> Result<(), McStoreError> {
        if !matches!(state, "applied" | "not_applied") {
            return Err(McStoreError::Serde("invalid_params: state".into()));
        }
        let refusal = self.inner.with_conn_fenced(|conn| {
            let conv = key.conversation_key();
            let held: Option<String> = conn
                .query_row(
                    "SELECT state FROM mc_provider_views_v1 WHERE conv_key=?1 AND version=?2",
                    params![conv, as_i64(version)?],
                    |r| r.get(0),
                )
                .optional()?;
            let Some(held) = held else {
                return Ok(Some("version"));
            };
            if held == "not_applied" && state == "applied" {
                return Ok(Some("state"));
            }
            conn.execute(
                "UPDATE mc_provider_views_v1 SET state=?3 WHERE conv_key=?1 AND version=?2",
                params![conv, as_i64(version)?, state],
            )?;
            Ok(None)
        })?;
        if let Some(field) = refusal {
            return Err(McStoreError::Serde(format!("invalid_params: {field}")));
        }
        Ok(())
    }
    pub fn save_provider_conversation(
        &self,
        key: &ProviderSessionKey,
        conversation: &ProviderConversation,
    ) -> Result<(), McStoreError> {
        self.inner
            .with_conn_fenced(|conn| save_conversation_tx(conn, key, conversation))?;
        Ok(())
    }
    /// Message admission, burns, promotion, policy, answer allocation and counters
    /// either all commit or all roll back. The callback must not perform store IO.
    pub fn commit_provider_hook<T>(
        &self,
        key: &ProviderSessionKey,
        request: ProviderHookRequest<'_>,
        decide: impl FnOnce(&ProviderHookContext) -> Result<(ProviderHookWrite, T), ProviderError>,
    ) -> Result<T, ProviderError> {
        let messages = request.message.map(std::slice::from_ref).unwrap_or(&[]);
        self.commit_provider_delta(key, request, messages, None, decide)
    }

    /// A status page validates every entry before burns or promotion. The last
    /// page can then promote answers without constructing a whole record.
    pub fn commit_provider_status(
        &self,
        key: &ProviderSessionKey,
        lineage: &ProviderLineage,
        messages: &[ProviderMessage],
        served: Option<u64>,
        unserved: &[ProviderSubject],
    ) -> Result<(), ProviderError> {
        self.commit_provider_delta(
            key,
            ProviderHookRequest {
                lineage,
                message: None,
                served_through_ordinal: served,
                unserved_subjects: unserved,
                repeat_subject: None,
            },
            messages,
            None,
            |ctx| {
                Ok((
                    ProviderHookWrite {
                        answer: None,
                        counters: ctx.counters.clone(),
                    },
                    (),
                ))
            },
        )
    }

    /// Final pages validate completeness in the same rollback fence as conflicts.
    /// Intermediate pages only admit bytes; acknowledgement waits for a complete
    /// final page. A returned gap committed nothing, including message admissions.
    pub fn commit_provider_status_page(
        &self,
        key: &ProviderSessionKey,
        page: ProviderStatusPage<'_>,
    ) -> Result<Option<u64>, ProviderError> {
        let result = self.commit_provider_delta(
            key,
            ProviderHookRequest {
                lineage: page.lineage,
                message: None,
                served_through_ordinal: if page.more { None } else { page.served },
                unserved_subjects: if page.more { &[] } else { page.unserved },
                repeat_subject: None,
            },
            page.messages,
            if page.more { None } else { page.newest },
            |ctx| {
                Ok((
                    ProviderHookWrite {
                        answer: None,
                        counters: ctx.counters.clone(),
                    },
                    (),
                ))
            },
        );
        match result {
            Ok(()) => Ok(None),
            Err(ProviderError::Transient(reason))
                if reason.starts_with("provider history gap:") =>
            {
                Ok(Some(
                    reason["provider history gap:".len()..]
                        .parse()
                        .expect("store-authored ordinal"),
                ))
            }
            Err(error) => Err(error),
        }
    }

    fn commit_provider_delta<T>(
        &self,
        key: &ProviderSessionKey,
        request: ProviderHookRequest<'_>,
        messages: &[ProviderMessage],
        complete_through: Option<u64>,
        decide: impl FnOnce(&ProviderHookContext) -> Result<(ProviderHookWrite, T), ProviderError>,
    ) -> Result<T, ProviderError> {
        let mut refusal = None;
        let result = self.inner.with_conn_fenced(|conn| {
            let operation = || -> Result<T,ProviderError> {
                let conv = key.conversation_key();
                let c = conversation_tx(conn,key)?.ok_or_else(||ProviderError::Transient("provider conversation is not initialized".into()))?;
                let new_lineage = lineage_tx(conn,&conv,&request.lineage.lineage_id)?.is_none();
                ensure_lineage_tx(conn,&conv,request.lineage)?;
                for m in messages {insert_message_tx(conn,&conv,&request.lineage.lineage_id,m)?;}
                if let Some(newest) = complete_through {
                    let gap = frontier_tx(conn,&conv,&request.lineage.lineage_id)?;
                    if gap <= newest {return Err(ProviderError::Transient(format!("provider history gap:{gap}")))}
                }
                let acknowledged = acknowledged_through_tx(conn,&conv,&c,request.lineage,new_lineage,request.served_through_ordinal)?;
                for s in request.unserved_subjects {
                    for (ancestor, _) in ancestry_tx(conn,&conv,&request.lineage.lineage_id)? {
                        burn_subject_tx(conn,&conv,&ancestor.lineage_id,s)?;
                    }
                }
                if let Some(s) = request.repeat_subject {burn_subject_tx(conn,&conv,&request.lineage.lineage_id,s)?;}
                promote_tx(conn,&conv,&c.engine_namespace,&request.lineage.lineage_id,request.served_through_ordinal)?;
                let current = conversation_tx(conn,key)?.ok_or(rusqlite::Error::InvalidQuery)?;
                let mut counters = parse(&current.hook_counters_json)?;
                counters["policy_state"] = surviving_policy_state_tx(conn,&conv,&request.lineage.lineage_id)?;
                let policy = policy_totals(&counters)?;
                let live_max: i64 = conn.query_row("SELECT coalesce(max(tag_number),0) FROM mc_tags WHERE session_id=?1",[&c.engine_namespace],|r|r.get(0))?;
                let tag_high_water = counters.get("tag_high_water").and_then(Value::as_i64).unwrap_or(0).max(counters.get("high_water").and_then(Value::as_i64).unwrap_or(0)).max(live_max);
                let mut pending_answers=0u64;
                let mut live_answers=0u64;
                for (ancestor, cut) in ancestry_tx(conn,&conv,&request.lineage.lineage_id)? {
                    let (pending,live):(u64,u64)=conn.query_row("SELECT coalesce(sum(state='pending'),0),coalesce(sum(state='live'),0) FROM mc_provider_hook_answers_v1 WHERE conv_key=?1 AND lineage_id=?2 AND ordinal<=?3 AND legacy_json IS NULL",params![conv,ancestor.lineage_id,as_i64(cut)?],|r|Ok((r.get(0)?,r.get(1)?)))?;
                    pending_answers+=pending;
                    live_answers+=live;
                }
                let (mut write,value) = decide(&ProviderHookContext {counters,policy,tag_high_water,pending_answers,live_answers})?;
                let answer_policy = write.counters.as_object_mut().and_then(|c|c.remove("answer_policy")).unwrap_or_else(||json!({}));
                let mut high = tag_high_water;
                if let Some(a) = write.answer {
                    if a.subject.subject_mid != request.message.map_or(a.subject.subject_mid.as_str(),|m|m.mid.as_str()) || request.message.is_some_and(|m|m.ordinal!=a.ordinal) {return Err(ProviderError::InvalidParams {field:"subject_mid"})}
                    parse(&a.ops_json)?;
                    for t in &a.tags {
                        if t.number<=high {return Err(ProviderError::Transient("tag allocation must advance its high water".into()))}
                        high=t.number;
                    }
                    burn_subject_tx(conn,&conv,&request.lineage.lineage_id,&a.subject)?;
                    conn.execute("INSERT INTO mc_provider_hook_answers_v1 (conv_key,answer_seq,lineage_id,subject_mid,hook,subject_part,ordinal,ops_json,tags_json,state,session) VALUES (?1,(SELECT coalesce(max(answer_seq),-1)+1 FROM mc_provider_hook_answers_v1 WHERE conv_key=?1),?2,?3,?4,?5,?6,?7,?8,'pending',json_extract(?1,'$[1]'))",params![conv,request.lineage.lineage_id,a.subject.subject_mid,a.subject.hook,a.subject.subject_part,as_i64(a.ordinal)?,a.ops_json,serde_json::to_string(&a.tags).map_err(sql_json)?])?;
                    conn.execute("UPDATE mc_provider_hook_answers_v1 SET policy_json=?2 WHERE conv_key=?1 AND answer_seq=(SELECT max(answer_seq) FROM mc_provider_hook_answers_v1 WHERE conv_key=?1)",params![conv,answer_policy.to_string()])?;
                }
                if !write.counters.is_object() {return Err(ProviderError::Transient("hook counters must be an object".into()))}
                write.counters["tag_high_water"]=json!(high);
                conn.execute("UPDATE mc_provider_conversations_v2 SET lineage_id=?2,served_through_ordinal=?3,hook_counters_json=?4 WHERE conv_key=?1",params![conv,request.lineage.lineage_id,acknowledged.map(as_i64).transpose()?,write.counters.to_string()])?;
                if let Some(metrics) = answer_policy.get("metrics") {
                    let metrics: ProviderPolicyTotals = serde_json::from_value(metrics.clone()).map_err(sql_json)?;
                    adjust_policy_tx(conn,&conv,&metrics,1)?;
                }
                Ok(value)
            };
            operation().map_err(|e| {refusal=Some(e);rusqlite::Error::InvalidQuery})
        });
        match result {
            Ok(value) => Ok(value),
            Err(e) => Err(refusal.unwrap_or_else(|| ProviderError::Storage(e.into()))),
        }
    }
    pub fn load_provider_messages(
        &self,
        key: &ProviderSessionKey,
        lineage: &str,
    ) -> Result<Vec<ProviderMessage>, McStoreError> {
        Ok(self
            .inner
            .with_conn(|conn| messages_tx(conn, &key.conversation_key(), lineage))?)
    }
    pub fn provider_frontier(
        &self,
        key: &ProviderSessionKey,
        lineage: &str,
    ) -> Result<u64, McStoreError> {
        Ok(self
            .inner
            .with_conn(|conn| frontier_tx(conn, &key.conversation_key(), lineage))?)
    }
    pub fn load_provider_hook_answers(
        &self,
        key: &ProviderSessionKey,
    ) -> Result<Vec<ProviderStoredAnswer>, McStoreError> {
        Ok(self.inner.with_conn(|conn| {
            let mut q=conn.prepare("SELECT lineage_id,subject_mid,hook,subject_part,ordinal,ops_json,tags_json,state FROM mc_provider_hook_answers_v1 WHERE conv_key=?1 AND legacy_json IS NULL ORDER BY answer_seq")?;
            let rows = q.query_map([key.conversation_key()],|r| {
                let tags:String=r.get(6)?;
                Ok(ProviderStoredAnswer {lineage_id:r.get(0)?,answer:ProviderHookAnswer {subject:ProviderSubject {subject_mid:r.get(1)?,hook:r.get(2)?,subject_part:r.get(3)?},ordinal:r.get(4)?,ops_json:r.get(5)?,tags:serde_json::from_str(&tags).map_err(sql_json)?},state:r.get(7)?})
            })?.collect();
            rows
        })?)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderView {
    pub version: u64,
    pub lineage_id: String,
    pub range_from: u64,
    pub range_to: u64,
    pub replacement_json: String,
    pub state: String,
}
impl McStore {
    /// View content is immutable at a version; only its application state moves.
    pub fn save_provider_view(
        &self,
        key: &ProviderSessionKey,
        view: &ProviderView,
    ) -> Result<(), McStoreError> {
        self.inner.with_conn_fenced(|conn| {
            let conv=key.conversation_key();
            parse(&view.replacement_json)?;
            let held=conn.query_row("SELECT lineage_id,range_from,range_to,replacement_json FROM mc_provider_views_v1 WHERE conv_key=?1 AND version=?2",params![conv,as_i64(view.version)?],|r|Ok((r.get::<_,String>(0)?,r.get::<_,u64>(1)?,r.get::<_,u64>(2)?,r.get::<_,String>(3)?))).optional()?;
            if held.is_some_and(|h|h!=(view.lineage_id.clone(),view.range_from,view.range_to,view.replacement_json.clone())) {return Err(rusqlite::Error::InvalidQuery)}
            conn.execute("INSERT INTO mc_provider_views_v1 VALUES (?1,?2,?3,?4,?5,?6,?7,'{}',json_extract(?1,'$[1]')) ON CONFLICT(conv_key,version) DO UPDATE SET state=excluded.state",params![conv,as_i64(view.version)?,view.lineage_id,as_i64(view.range_from)?,as_i64(view.range_to)?,view.replacement_json,view.state])?;
            Ok(())
        })?;
        Ok(())
    }
    pub fn load_provider_views(
        &self,
        key: &ProviderSessionKey,
    ) -> Result<Vec<ProviderView>, McStoreError> {
        Ok(self.inner.with_conn(|conn| {
            let mut q=conn.prepare("SELECT version,lineage_id,range_from,range_to,replacement_json,state FROM mc_provider_views_v1 WHERE conv_key=?1 ORDER BY version")?;
            let rows=q.query_map([key.conversation_key()],|r|Ok(ProviderView {version:r.get(0)?,lineage_id:r.get(1)?,range_from:r.get(2)?,range_to:r.get(3)?,replacement_json:r.get(4)?,state:r.get(5)?}))?.collect();
            rows
        })?)
    }
    pub fn queue_provider_drops(
        &self,
        key: &ProviderSessionKey,
        numbers: &[i64],
    ) -> Result<(), McStoreError> {
        self.inner.with_conn_fenced(|conn| {
            let conv=key.conversation_key();
            for number in numbers {
                let known:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM mc_provider_hook_answers_v1 a,json_each(a.tags_json) t WHERE a.conv_key=?1 AND a.state IN ('pending','live') AND a.legacy_json IS NULL AND json_extract(t.value,'$.number')=?2 AND NOT coalesce(json_extract(t.value,'$.consumed'),false))",params![conv,number],|r|r.get(0))?;
                if !known {return Err(rusqlite::Error::InvalidQuery)}
                conn.execute("INSERT INTO mc_provider_pending_drops_v1 VALUES (?1,?2,json_extract(?1,'$[1]')) ON CONFLICT DO NOTHING",params![conv,number])?;
                let mut q=conn.prepare("SELECT a.answer_seq,a.policy_json FROM mc_provider_hook_answers_v1 a,json_each(a.tags_json) t WHERE a.conv_key=?1 AND a.state IN ('pending','live') AND json_extract(t.value,'$.number')=?2")?;
                let rows=q.query_map(params![conv,number],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
                for (seq,raw) in rows {
                    let mut policy=parse(&raw)?;
                    let mut metrics:ProviderPolicyTotals=serde_json::from_value(policy.get("metrics").cloned().unwrap_or_else(||json!({}))).map_err(sql_json)?;
                    let delta=ProviderPolicyTotals {reclaimable_tokens:metrics.reclaimable_tokens,tool_outputs:metrics.tool_outputs,..Default::default()};
                    adjust_policy_tx(conn,&conv,&delta,-1)?;
                    metrics.reclaimable_tokens=0; metrics.tool_outputs=0;
                    policy["metrics"]=serde_json::to_value(metrics).map_err(sql_json)?;
                    conn.execute("UPDATE mc_provider_hook_answers_v1 SET policy_json=?3 WHERE conv_key=?1 AND answer_seq=?2",params![conv,seq,policy.to_string()])?;
                }
            }
            Ok(())
        })?;
        Ok(())
    }
    pub fn consume_provider_drops(
        &self,
        key: &ProviderSessionKey,
        numbers: &[i64],
    ) -> Result<(), McStoreError> {
        self.inner
            .with_conn_fenced(|conn| consume_provider_drops_tx(conn, key, numbers))?;
        Ok(())
    }
    pub fn load_provider_pending_drops(
        &self,
        key: &ProviderSessionKey,
    ) -> Result<Vec<i64>, McStoreError> {
        Ok(self.inner.with_conn(|conn| {
            let mut q=conn.prepare("SELECT tag_number FROM mc_provider_pending_drops_v1 WHERE conv_key=?1 ORDER BY tag_number")?;
            let rows=q.query_map([key.conversation_key()],|r|r.get(0))?.collect();rows
        })?)
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod lineage_metadata_tests {
    use super::*;
    use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};

    #[test]
    fn lineage_metadata_reads_origin_and_ancestry_without_message_payloads() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open_for_test(&StorageDescriptor {
            module_id: "magic-context".into(),
            storage_namespace: crate::NS.into(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: dir.path().join("store.db").to_string_lossy().into_owned(),
            },
        })
        .unwrap();
        let key = ProviderSessionKey {
            project_root: "/project".into(),
            session: "session".into(),
            harness: "opencode".into(),
        };
        let root = ProviderLineage {
            lineage_id: "root".into(),
            first_ordinal: 4_000,
            descends_from: None,
            through_ordinal: None,
        };
        let child = ProviderLineage {
            lineage_id: "child".into(),
            first_ordinal: 4_001,
            descends_from: Some("root".into()),
            through_ordinal: Some(4_000),
        };
        store.inner.with_conn_fenced(|conn| {
            let conv = key.conversation_key();
            conn.execute("INSERT INTO mc_provider_lineages_v1 VALUES (?1,'root',4000,NULL,NULL,'session')", [&conv])?;
            conn.execute("INSERT INTO mc_provider_lineages_v1 VALUES (?1,'child',4001,'root',4000,'session')", [&conv])?;
            // Deliberately unreadable JSON proves this query cannot be satisfied
            // by decoding a compatibility record or a message payload.
            conn.execute("INSERT INTO mc_provider_messages_v1 VALUES (?1,'root',4000,'m4000',x'ff','session')", [&conv])?;
            Ok(())
        }).unwrap();
        assert_eq!(
            store.load_provider_lineage(&key, "root").unwrap(),
            Some(root)
        );
        assert_eq!(
            store.load_provider_lineage(&key, "child").unwrap(),
            Some(child)
        );
        assert_eq!(store.load_provider_lineage(&key, "absent").unwrap(), None);
    }
}

#[cfg(test)]
mod policy_tests {
    use super::*;
    use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
    fn fixture(dir: &std::path::Path) -> (McStore, ProviderSessionKey, ProviderLineage) {
        let store = McStore::open_for_test(&StorageDescriptor {
            module_id: "magic-context".into(),
            storage_namespace: crate::NS.into(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: dir.join("store.db").to_string_lossy().into(),
            },
        })
        .unwrap();
        let key = ProviderSessionKey {
            project_root: "/project".into(),
            session: "s".into(),
            harness: "opencode".into(),
        };
        store
            .save_provider_conversation(
                &key,
                &ProviderConversation {
                    engine_namespace: "s".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        (
            store,
            key,
            ProviderLineage {
                lineage_id: "L".into(),
                first_ordinal: 1,
                descends_from: None,
                through_ordinal: None,
            },
        )
    }
    fn allocate(
        store: &McStore,
        key: &ProviderSessionKey,
        l: &ProviderLineage,
        n: u64,
        metrics: ProviderPolicyTotals,
        unserved: &[ProviderSubject],
        repeat: bool,
        expected: ProviderPolicyTotals,
    ) -> ProviderSubject {
        let s = ProviderSubject {
            subject_mid: format!("m{n}"),
            hook: "post_tool".into(),
            subject_part: "part".into(),
        };
        let m = ProviderMessage {
            mid: s.subject_mid.clone(),
            ordinal: n,
            message_bytes: b"{}".to_vec(),
        };
        store.commit_provider_hook(key,ProviderHookRequest {lineage:l,message:Some(&m),served_through_ordinal:None,unserved_subjects:unserved,repeat_subject:repeat.then_some(&s)},|ctx| {
            assert_eq!(ctx.policy,expected,"policy must be read after burns");
            let mut counters=ctx.counters.clone();counters["answer_policy"]=json!({"metrics":metrics,"channel1":{"channel1_last_nudge_undropped":n*100}});
            Ok((ProviderHookWrite {answer:Some(ProviderHookAnswer {subject:s.clone(),ordinal:n,ops_json:"[]".into(),tags:vec![ProviderAnswerTag {number:ctx.tag_high_water+1,block_id:format!("m{n}#0"),kind:"tool_result".into(),source:"payload".into(),token_count:10,created_at_ms:1}]}),counters},()))
        }).unwrap();
        s
    }
    #[test]
    fn incremental_policy_totals_equal_fixture_recomputation_after_promote_burn_retry_and_drop() {
        let dir = tempfile::tempdir().unwrap();
        let (store, key, l) = fixture(dir.path());
        let metrics = ProviderPolicyTotals {
            text_tokens: 20,
            tool_tokens: 80,
            reclaimable_tokens: 80,
            tool_outputs: 1,
            real_users: 1,
        };
        let s = allocate(
            &store,
            &key,
            &l,
            1,
            metrics.clone(),
            &[],
            false,
            ProviderPolicyTotals::default(),
        );
        assert_eq!(store.load_provider_policy_totals(&key).unwrap(), metrics);
        store
            .commit_provider_status(&key, &l, &[], Some(1), &[])
            .unwrap();
        assert_eq!(
            store.load_provider_policy_totals(&key).unwrap(),
            metrics,
            "pending-to-live does not count content twice"
        );
        let twice = ProviderPolicyTotals {
            text_tokens: 40,
            tool_tokens: 160,
            reclaimable_tokens: 160,
            tool_outputs: 2,
            real_users: 2,
        };
        let second = allocate(
            &store,
            &key,
            &l,
            2,
            metrics.clone(),
            &[s],
            false,
            metrics.clone(),
        );
        assert_eq!(
            store.load_provider_policy_totals(&key).unwrap(),
            twice,
            "an unserved live answer stays live"
        );
        allocate(
            &store,
            &key,
            &l,
            2,
            metrics.clone(),
            &[],
            true,
            metrics.clone(),
        );
        let third = allocate(
            &store,
            &key,
            &l,
            3,
            metrics.clone(),
            &[second.clone(), second],
            false,
            metrics.clone(),
        );
        assert_eq!(store.load_provider_policy_totals(&key).unwrap(), twice);
        let number = store
            .load_provider_hook_answers(&key)
            .unwrap()
            .iter()
            .find(|a| a.answer.subject == third)
            .unwrap()
            .answer
            .tags[0]
            .number;
        store.queue_provider_drops(&key, &[number]).unwrap();
        store.queue_provider_drops(&key, &[number]).unwrap();
        let expected = ProviderPolicyTotals {
            reclaimable_tokens: 80,
            tool_outputs: 1,
            ..twice
        };
        assert_eq!(store.load_provider_policy_totals(&key).unwrap(), expected);
        let recomputed=store.inner.with_conn(|conn| {
            let mut totals=ProviderPolicyTotals::default();
            let rows=conn.prepare("SELECT policy_json FROM mc_provider_hook_answers_v1 WHERE conv_key=?1 AND state IN ('pending','live')")?.query_map([key.conversation_key()],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            for row in rows {let m:ProviderPolicyTotals=serde_json::from_value(parse(&row)?.get("metrics").cloned().unwrap_or_else(||json!({}))).map_err(sql_json)?;totals.text_tokens+=m.text_tokens;totals.tool_tokens+=m.tool_tokens;totals.reclaimable_tokens+=m.reclaimable_tokens;totals.tool_outputs+=m.tool_outputs;totals.real_users+=m.real_users;}
            Ok(totals)
        }).unwrap();
        assert_eq!(recomputed, expected);
    }

    #[test]
    fn provider_drop_consumption_is_atomic_with_engine_commit_and_never_requeues() {
        let dir = tempfile::tempdir().unwrap();
        let (store, key, l) = fixture(dir.path());
        let core = crate::CoreState::default();
        let meta = crate::ModuleMeta::default();
        let version = store.commit("s", None, &core, &meta).unwrap();
        let metrics = ProviderPolicyTotals {
            tool_tokens: 80,
            reclaimable_tokens: 80,
            tool_outputs: 1,
            ..Default::default()
        };
        allocate(
            &store,
            &key,
            &l,
            1,
            metrics.clone(),
            &[],
            false,
            ProviderPolicyTotals::default(),
        );
        store
            .commit_provider_status(&key, &l, &[], Some(1), &[])
            .unwrap();
        store.queue_provider_drops(&key, &[1]).unwrap();
        store
            .append_pending_agent_drops("s", &["m1#0".into()], 1)
            .unwrap();
        let id = store.load_pending_agent_drops("s").unwrap()[0].id;
        store.inner.with_conn(|conn|conn.execute_batch("CREATE TRIGGER fail_engine_drop_commit BEFORE DELETE ON pending_agent_drops BEGIN SELECT RAISE(ABORT,'injected failure before commit'); END;")).unwrap();
        assert!(store
            .commit_with_consumed_drops("s", Some(version), &core, &meta, &[id], None)
            .is_err());
        assert_eq!(store.load_provider_pending_drops(&key).unwrap(), [1]);
        assert_eq!(store.load_pending_agent_drops("s").unwrap().len(), 1);
        assert_eq!(
            store.load_provider_policy_totals(&key).unwrap(),
            ProviderPolicyTotals {
                tool_tokens: 80,
                ..Default::default()
            }
        );
        assert_eq!(store.load_meta("s").unwrap().row_version, Some(version));
        store
            .inner
            .with_conn(|conn| conn.execute_batch("DROP TRIGGER fail_engine_drop_commit"))
            .unwrap();
        let next = store
            .commit_with_consumed_drops("s", Some(version), &core, &meta, &[id], None)
            .unwrap();
        assert!(store.load_provider_pending_drops(&key).unwrap().is_empty());
        assert!(store.load_pending_agent_drops("s").unwrap().is_empty());
        assert_eq!(
            store.load_provider_policy_totals(&key).unwrap(),
            ProviderPolicyTotals::default()
        );
        assert!(!store.provider_answer_tag_known(&key, 1).unwrap());
        assert!(store.queue_provider_drops(&key, &[1]).is_err());
        store.consume_provider_drops(&key, &[1, 1, 999]).unwrap();
        store
            .commit_with_consumed_drops("s", Some(next), &core, &meta, &[id], None)
            .unwrap();
        assert!(store.load_provider_pending_drops(&key).unwrap().is_empty());
        assert_eq!(
            store.load_provider_policy_totals(&key).unwrap(),
            ProviderPolicyTotals::default()
        );
    }

    #[test]
    fn non_provider_consumption_uses_namespace_index_and_changes_no_provider_rows_or_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let (store, key, _) = fixture(dir.path());
        let before = store
            .load_provider_conversation(&key)
            .unwrap()
            .unwrap()
            .hook_counters_json;
        store.inner.with_conn(|conn| {
            for table in ["mc_provider_conversations_v2","mc_provider_hook_answers_v1","mc_provider_pending_drops_v1"] {
                for op in ["INSERT","UPDATE","DELETE"] {conn.execute_batch(&format!("CREATE TRIGGER guard_{table}_{op} BEFORE {op} ON {table} BEGIN SELECT RAISE(ABORT,'non-provider commit wrote provider state'); END;"))?;}
            }
            let plan: String=conn.query_row("EXPLAIN QUERY PLAN SELECT project_root,session,harness FROM mc_provider_conversations_v2 WHERE engine_namespace=?1",["not-provider"],|r|r.get(3))?;
            assert!(plan.contains("mc_provider_conversations_engine_namespace"),"{plan}");
            Ok(())
        }).unwrap();
        let core = crate::CoreState::default();
        let meta = crate::ModuleMeta::default();
        store
            .commit_with_consumed_drops("not-provider", None, &core, &meta, &[999], None)
            .unwrap();
        store.commit("control", None, &core, &meta).unwrap();
        let encoded = |namespace: &str| {
            store.inner.with_conn(|conn|conn.query_row("SELECT core_state,meta,section_index FROM mc_cache_state WHERE session_id=?1",[namespace],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))).unwrap()
        };
        assert_eq!(encoded("not-provider"), encoded("control"));
        assert_eq!(
            store
                .load_provider_conversation(&key)
                .unwrap()
                .unwrap()
                .hook_counters_json,
            before
        );
    }
}
