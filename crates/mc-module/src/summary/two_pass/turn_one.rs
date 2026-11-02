//! The two-pass historian's first turn: its envelope, the send record kept
//! before it goes out, the failure budget that falls back to the one-pass
//! summarizer, and the publication that stores its facts as candidates for
//! the second turn. Ported from the plugin's `memory/turn-one-publication.ts`;
//! every table here is shared with the plugin (`context.db` migration 99).

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Value};

use super::text::lifecycle_text_hash;
use crate::summary::chunk::PrintedBlock;
use crate::summary::validate::{resolve_fact_anchor, FactCandidate};

/// The combined system prompt both turns run under, exactly as the plugin
/// sends it (`TWO_PASS_SYSTEM`).
pub const SYSTEM: &str = include_str!("../../../testdata/two-pass/system.md");

/// Appended to the first turn's prompt; the second turn sees it in the
/// conversation (`HISTORIAN_FORMAT_INSTRUCTION`).
pub const FORMAT_INSTRUCTION: &str = r#"Reply with exactly one JSON object with a result object. On turn one use {"result":{"step":"turn_one","xml":"the complete compartment XML"}}. On turn two use {"result":{"step":"turn_two","decisions":[],"scores":[]}} with the decisions and scores described in the system contract. Do not call tools."#;

/// Parse failures for one counter key after which the one-pass summarizer
/// runs instead.
pub const FAILURE_BUDGET: usize = 3;

/// The categories a candidate may have: the five current ones and the older
/// ones still promotable (`PROMOTABLE_CATEGORIES`).
const PROMOTABLE: [&str; 12] = [
    "PROJECT_RULES",
    "ARCHITECTURE",
    "CONSTRAINTS",
    "CONFIG_VALUES",
    "NAMING",
    "ARCHITECTURE_DECISIONS",
    "CONFIG_DEFAULTS",
    "USER_PREFERENCES",
    "USER_DIRECTIVES",
    "ENVIRONMENT",
    "WORKFLOW_RULES",
    "KNOWN_ISSUES",
];

/// The summary XML of a first-turn reply: one JSON object whose `result`
/// has `step: "turn_one"` and a string `xml`. Unknown fields are ignored;
/// anything else is no reply (`parseEnabledTurnOne`).
pub fn parse_reply(text: &str) -> Option<String> {
    let value: Value = serde_json::from_str(text).ok()?;
    let result = value.get("result")?;
    (result.get("step")?.as_str()? == "turn_one")
        .then(|| result.get("xml")?.as_str().map(str::to_owned))
        .flatten()
}

/// What identifies a run for the failure budget: the parent session, the
/// chunk's first message, and the model and prompt bytes it ran with. A
/// growing chunk keeps its key, so its failures add up across runs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CounterKey {
    pub parent_session: String,
    pub first_message: String,
    pub profile_hash: String,
    pub rendering_hash: String,
    pub schema_hash: String,
    pub tool_hash: String,
}

impl CounterKey {
    /// The key for a run of `model` (provider, model, variant) on the
    /// `carrier`, with `system` as its system prompt.
    pub fn new(
        parent_session: &str,
        first_message: &str,
        carrier: &str,
        model: &Value,
        system: &str,
    ) -> Self {
        let profile = json!({"lane": "enabled", "carrier": carrier, "model": model});
        Self {
            parent_session: parent_session.to_owned(),
            first_message: first_message.to_owned(),
            profile_hash: lifecycle_text_hash(&profile.to_string()),
            rendering_hash: lifecycle_text_hash(system),
            schema_hash: lifecycle_text_hash(FORMAT_INSTRUCTION),
            tool_hash: lifecycle_text_hash("[]"),
        }
    }

    fn json(&self) -> Value {
        json!({
            "parentSessionId": self.parent_session,
            "firstMessageId": self.first_message,
            "profileHash": self.profile_hash,
            "renderingHash": self.rendering_hash,
            "schemaHash": self.schema_hash,
            "toolHash": self.tool_hash,
        })
    }

    /// The counter rows' publication id. `serde_json` sorts the keys, as the
    /// plugin's canonical JSON does.
    fn publication(&self) -> String {
        format!("t1fail:{}", lifecycle_text_hash(&self.json().to_string()))
    }
}

/// Parse failures counted for `key` since its last reset.
pub fn failure_count(
    conn: &Connection,
    project: &str,
    key: &CounterKey,
) -> rusqlite::Result<usize> {
    let publication = key.publication();
    let mut statement = conn.prepare_cached(
        "SELECT run_attempt, state FROM memory_stage_attempts
         WHERE project_path = ?1 AND publication_id = ?2 AND stage = 'turn_one'",
    )?;
    let rows: Vec<(i64, String)> = statement
        .query_map(params![project, publication], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?
        .collect::<Result<_, _>>()?;
    let reset = rows
        .iter()
        .filter(|(_, state)| state == "counter_reset")
        .map(|(attempt, _)| *attempt)
        .max()
        .unwrap_or(0);
    Ok(rows
        .iter()
        .filter(|(attempt, state)| state == "parse_failed" && *attempt > reset)
        .count())
}

/// Record a parse failure for `key`, or reset its count after a
/// publication. A reset with nothing counted writes nothing. The rows need
/// no publication of their own, so restarts and growing chunks keep the
/// count.
pub fn record_counter(
    conn: &Connection,
    project: &str,
    key: &CounterKey,
    harness: &str,
    carrier: &str,
    failed: bool,
    now_ms: i64,
) -> rusqlite::Result<()> {
    if !failed && failure_count(conn, project, key)? == 0 {
        return Ok(());
    }
    let publication = key.publication();
    let attempt: i64 = conn.query_row(
        "SELECT COALESCE(MAX(run_attempt), 0) + 1 FROM memory_stage_attempts
         WHERE project_path = ?1 AND publication_id = ?2",
        params![project, publication],
        |row| row.get(0),
    )?;
    conn.execute(
        "INSERT INTO memory_stage_attempts
            (stage_key, project_path, publication_id, run_attempt, stage, session_id, harness,
             carrier, state, request_json, started_at)
         VALUES (?1, ?2, ?3, ?4, 'turn_one', ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            format!("{publication}:{attempt}"),
            project,
            publication,
            attempt,
            key.parent_session,
            harness,
            carrier,
            if failed {
                "parse_failed"
            } else {
                "counter_reset"
            },
            key.json().to_string(),
            now_ms,
        ],
    )?;
    Ok(())
}

/// Which first turn a run sends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lane {
    /// Anchored facts become candidates for the second turn.
    Enabled,
    /// The one-pass summarizer: memory block in the prompt, facts promoted
    /// at once.
    Dormant,
}

impl Lane {
    fn name(self) -> &'static str {
        match self {
            Self::Enabled => "enabled",
            Self::Dormant => "dormant",
        }
    }
}

/// The send record kept before a first turn goes out.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Send {
    pub publication_id: String,
    pub run_attempt: i64,
    pub stage_key: String,
    pub lane: Lane,
    /// The chunk's first and last ordinal.
    pub chunk: (u64, u64),
}

/// What a send record names.
pub struct SendInput<'a> {
    pub project: &'a str,
    pub session: &'a str,
    pub harness: &'a str,
    pub carrier: &'a str,
    pub lane: Lane,
    pub chunk: (u64, u64),
    /// The model and routing decision the turn runs on, which the second
    /// turn and its checks reuse.
    pub model: Value,
    pub child: &'a str,
}

/// Keep the send record before the first turn goes out, in one transaction:
/// the session's uncommitted publication is reused, so one chunk publishes
/// under one id however many sends it takes; `run_attempt` is its highest
/// plus one; older sends of it that never published are superseded.
///
/// The plugin recovers an unanswered earlier send instead of sending again.
/// ck-mc sends again: a run lost with its module is superseded here, and the
/// runner's answer to it, if any, is never read.
pub fn allocate(
    conn: &mut Connection,
    input: &SendInput<'_>,
    now_ms: i64,
) -> rusqlite::Result<Send> {
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    tx.execute(
        "UPDATE memory_stage_attempts SET state = 'superseded'
         WHERE project_path = ?1 AND session_id = ?2 AND harness = ?3 AND carrier = ?4
           AND stage = 'turn_one' AND state IN ('dispatched', 'sending', 'replied')",
        params![input.project, input.session, input.harness, input.carrier],
    )?;
    let reusable: Option<String> = tx
        .query_row(
            "SELECT p.publication_id FROM memory_publications p
             WHERE p.project_path = ?1 AND p.source_session_id = ?2 AND p.commit_order IS NULL
               AND EXISTS (SELECT 1 FROM memory_stage_attempts s
                           WHERE s.publication_id = p.publication_id AND s.stage = 'turn_one'
                             AND s.session_id = p.source_session_id AND s.harness = ?3)
             ORDER BY p.rowid DESC LIMIT 1",
            params![input.project, input.session, input.harness],
            |row| row.get(0),
        )
        .optional()?;
    let publication_id = match reusable {
        Some(id) => id,
        None => {
            let id = uuid();
            tx.execute(
                "INSERT INTO memory_publications(publication_id, project_path, source_session_id)
                 VALUES (?1, ?2, ?3)",
                params![id, input.project, input.session],
            )?;
            id
        }
    };
    let run_attempt: i64 = tx.query_row(
        "SELECT COALESCE(MAX(run_attempt), 0) + 1 FROM memory_stage_attempts
         WHERE project_path = ?1 AND publication_id = ?2 AND stage = 'turn_one'",
        params![input.project, publication_id],
        |row| row.get(0),
    )?;
    let stage_key = json!([input.project, publication_id, run_attempt, "turn_one"]).to_string();
    let request = json!({
        "lane": input.lane.name(),
        "chunkStart": input.chunk.0,
        "chunkEnd": input.chunk.1,
        "model": input.model,
    });
    tx.execute(
        "INSERT INTO memory_stage_attempts
            (stage_key, project_path, publication_id, run_attempt, stage, session_id, harness,
             carrier, state, request_json, child_session_id, started_at)
         VALUES (?1, ?2, ?3, ?4, 'turn_one', ?5, ?6, ?7, 'sending', ?8, ?9, ?10)",
        params![
            stage_key,
            input.project,
            publication_id,
            run_attempt,
            input.session,
            input.harness,
            input.carrier,
            request.to_string(),
            input.child,
            now_ms,
        ],
    )?;
    tx.commit()?;
    Ok(Send {
        publication_id,
        run_attempt,
        stage_key,
        lane: input.lane,
        chunk: input.chunk,
    })
}

/// A random UUID v4 in its canonical text form.
fn uuid() -> String {
    let bytes: [u8; 16] = rand_bytes();
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-4{}-{:x}{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[13..16],
        (bytes[8] & 0x3) | 0x8,
        &hex[17..20],
        &hex[20..32]
    )
}

fn rand_bytes() -> [u8; 16] {
    use sha2::{Digest, Sha256};
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let seed = format!(
        "{}:{:?}:{}",
        std::process::id(),
        std::time::SystemTime::now(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    );
    let digest = Sha256::digest(seed.as_bytes());
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes
}

/// What a first turn publishes besides its summaries.
#[derive(Clone, Debug)]
pub struct Publication {
    pub send: Send,
    pub project: String,
    pub session: String,
    pub harness: String,
    pub carrier: String,
    pub counter: Option<CounterKey>,
    /// The printed lines the summarizer saw whole.
    pub blocks: Vec<PrintedBlock>,
    /// On the enabled lane: the facts of the reply, kept as candidates.
    pub candidates: Vec<FactCandidate>,
}

/// What [`commit`] stored.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Committed {
    pub commit_order: i64,
    pub candidates: usize,
    pub anchored: usize,
    pub blocks: usize,
}

/// Commit a first turn's publication inside the transaction that stores its
/// summaries (`compartment_ids` and `ranges`, in reply order): the
/// publication commits exactly once with the next commit order, the send
/// becomes `published`, each new summary is counted once in the activity
/// ledger, the failure budget resets, and on the enabled lane the facts
/// become candidates with the lines they cite. Fails when the publication
/// already committed or its send was released, which rolls the summaries
/// back too.
pub fn commit(
    tx: &Transaction<'_>,
    publication: &Publication,
    compartment_ids: &[i64],
    ranges: &[(u64, u64)],
    now_ms: i64,
) -> rusqlite::Result<Committed> {
    let send = &publication.send;
    let state: Option<String> = tx
        .query_row(
            "SELECT state FROM memory_stage_attempts WHERE stage_key = ?1",
            params![send.stage_key],
            |row| row.get(0),
        )
        .optional()?;
    if matches!(state.as_deref(), Some("revoked" | "expired" | "superseded")) {
        return Err(rusqlite::Error::ToSqlConversionFailure(
            "the first turn's send was released before publication".into(),
        ));
    }
    let changed = tx.execute(
        "UPDATE memory_publications
         SET commit_order = (SELECT COALESCE(MAX(commit_order), 0) + 1 FROM memory_publications),
             committed_at = ?1
         WHERE publication_id = ?2 AND commit_order IS NULL",
        params![now_ms, send.publication_id],
    )?;
    if changed != 1 {
        return Err(rusqlite::Error::ToSqlConversionFailure(
            format!(
                "memory publication {} is already committed",
                send.publication_id
            )
            .into(),
        ));
    }
    let commit_order: i64 = tx.query_row(
        "SELECT commit_order FROM memory_publications WHERE publication_id = ?1",
        params![send.publication_id],
        |row| row.get(0),
    )?;
    tx.execute(
        "UPDATE memory_stage_attempts SET state = 'published' WHERE stage_key = ?1",
        params![send.stage_key],
    )?;
    tx.execute(
        "UPDATE memory_stage_attempts SET state = 'superseded'
         WHERE project_path = ?1 AND publication_id = ?2 AND stage = 'turn_one'
           AND state = 'dispatched' AND stage_key IS NOT ?3",
        params![publication.project, send.publication_id, send.stage_key],
    )?;
    for id in compartment_ids {
        tx.execute(
            "INSERT OR IGNORE INTO memory_activity_ledger(project_path, publication_id, compartment_id, committed_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![publication.project, send.publication_id, id, now_ms],
        )?;
    }
    if let Some(key) = &publication.counter {
        record_counter(
            tx,
            &publication.project,
            key,
            &publication.harness,
            &publication.carrier,
            false,
            now_ms,
        )?;
    }
    let mut committed = Committed {
        commit_order,
        ..Committed::default()
    };
    if send.lane != Lane::Enabled || ranges.is_empty() {
        return Ok(committed);
    }
    // Summaries are contiguous: a cited range outside their outer bounds
    // points at an unpublished tail, and its fact is dropped.
    let published = (
        ranges.iter().map(|range| range.0).min().unwrap_or(0),
        ranges.iter().map(|range| range.1).max().unwrap_or(0),
    );
    let printed: Vec<(u64, u64)> = publication
        .blocks
        .iter()
        .map(|block| (block.start, block.end))
        .collect();
    for (index, fact) in publication.candidates.iter().enumerate() {
        if fact.content.trim().is_empty() || !PROMOTABLE.contains(&fact.category.as_str()) {
            continue;
        }
        if fact.source_ranges.iter().any(|range| {
            range.start.min(range.end) < published.0 || range.start.max(range.end) > published.1
        }) {
            continue;
        }
        let resolved = resolve_fact_anchor(fact, ranges, &printed, send.chunk);
        let compartment = resolved
            .as_ref()
            .and_then(|resolved| compartment_ids.get(resolved.compartment_index as usize - 1));
        let inserted = tx.execute(
            "INSERT OR IGNORE INTO memory_pending_facts
                (project_path, publication_id, fact_index, compartment_id, category, content,
                 anchor_known, state, fact_attempts, reason)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'retryable', 0, NULL)",
            params![
                publication.project,
                send.publication_id,
                index as i64,
                compartment,
                fact.category,
                fact.content,
                i64::from(resolved.is_some()),
            ],
        )?;
        if inserted != 1 {
            continue;
        }
        committed.candidates += 1;
        let Some(resolved) = resolved else {
            continue;
        };
        committed.anchored += 1;
        let fact_id = tx.last_insert_rowid();
        for range in &fact.source_ranges {
            let selected: Vec<&PrintedBlock> = resolved
                .block_indexes
                .iter()
                .map(|index| &publication.blocks[*index])
                .filter(|block| block.start >= range.start && block.end <= range.end)
                .collect();
            let role = if selected.iter().all(|block| block.role == selected[0].role) {
                selected[0].role.clone()
            } else {
                "mixed".to_owned()
            };
            let parts: Vec<String> = if role == "mixed" {
                selected
                    .iter()
                    .map(|block| {
                        let span = if block.start == block.end {
                            block.start.to_string()
                        } else {
                            format!("{}-{}", block.start, block.end)
                        };
                        format!("[{span}] {}: {}", block.role, block.parts.join(" / "))
                    })
                    .collect()
            } else {
                selected
                    .iter()
                    .flat_map(|block| block.parts.clone())
                    .collect()
            };
            committed.blocks += tx.execute(
                "INSERT OR IGNORE INTO memory_fact_blocks
                    (publication_id, source_session_id, start_ordinal, end_ordinal, role, parts_json, joined_text)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    send.publication_id,
                    publication.session,
                    range.start as i64,
                    range.end as i64,
                    role,
                    serde_json::to_string(&parts).expect("strings serialize"),
                    parts.join(" / "),
                ],
            )?;
            let block_id: i64 = tx.query_row(
                "SELECT id FROM memory_fact_blocks
                 WHERE publication_id = ?1 AND start_ordinal = ?2 AND end_ordinal = ?3",
                params![send.publication_id, range.start as i64, range.end as i64],
                |row| row.get(0),
            )?;
            tx.execute(
                "INSERT OR IGNORE INTO memory_fact_block_links(fact_id, block_id) VALUES (?1, ?2)",
                params![fact_id, block_id],
            )?;
        }
    }
    Ok(committed)
}
