//! The two-pass historian's second turn: reconcile candidate facts with the
//! project's memories in the conversation the first turn answered in, and
//! resolve each fact through the shared applier. Ported from the plugin's
//! `memory/turn-two.ts`, `turn-two-retrieval.ts` and `turn-two-scoring.ts`.
//!
//! Fact states (`memory_pending_facts.state`): `retryable` facts are the only
//! ones sent; `in_flight` facts are reserved by one send (a stage) from
//! before it goes out until each resolves, and stay reserved across an
//! unknown outcome; `applied`, `covered` and `decided_pending` are final.
//!
//! What spends one of a fact's three attempts: a send that fails, a reply
//! that is no valid envelope (every fact of the send), a check that fails
//! to send, a source that moved since the decision read it, and giving up
//! on a send whose outcome stays unknown. A decision that is malformed,
//! refused by a gate or a check, or abstains leaves its fact pending at
//! once.
//!
//! Differences from the plugin: every call names its model, and the runner
//! reports none back, so the second turn and its checks run on the first
//! turn's model and settings and no reply is matched against a frozen
//! identity. A send whose outcome is unknown is reattached by sending it
//! again under the same send id, which a runner answers with the run it
//! already started.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use cortexkit_role_compaction::read::{SessionRef, StepUsage};
use cortexkit_role_compaction::setup::ModelRef;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};

use super::applier::{self, Admission, Reservation, Resolution};
use super::constants::{MAX_STAGE2_ATTEMPTS, NEIGHBOUR_SHORTLIST_CAP, RETRY_BACKLOG_PER_RUN};
use super::envelope::{
    self, Decision, Entry, Neighbour, PromptBlock, PromptFact, PromptItem, Score,
};
use super::gates::{self, AddedClause, ChangedClause, Check, Revision, Verdict};
use super::text::{
    lifecycle_text_hash, normalize_lifecycle_text, split_memory_clauses, EvidenceBlock,
};
use crate::client::{Child, RunnerClient};
use crate::context_db::ContextDb;
use crate::summary::account_wait::{AccountWait, SendKind};
use crate::summary::run::{self, Continuation, Model, SummaryError};

pub const STAGE: &str = "turn_two";
/// The second turn's prompt bound in UTF-16 units: whole facts and items
/// only; the rest wait, and the prompt says how many.
pub const PROMPT_MAX: usize = 160_000;
/// Recovery visits after which a send whose outcome is still unknown is
/// given up.
pub const UNKNOWN_MAX_VISITS: i64 = 3;
/// How long a send stays open when nothing can reach it.
pub const UNREACHABLE_MAX_AGE_MS: i64 = 24 * 60 * 60 * 1000;
/// How long one send or check may take.
const TIMEOUT: Duration = Duration::from_secs(20 * 60);
/// What a check's child session adds to its parent's.
const CHECK_CHILD: &str = "mc-check";
/// The neighbours a fact is shown at most (`TURN_TWO_NEIGHBOUR_LIMIT`).
const NEIGHBOUR_LIMIT: usize = 3;
/// The error a wait that ran out of time ends with: the outcome is unknown.
const TIMED_OUT: &str = "the run did not finish in time";

/// One second turn to run.
#[derive(Clone)]
pub struct Job {
    /// The session the summary ran for; it owns the send.
    pub owner: SessionRef,
    pub project: String,
    /// The session's project folder, where the runner creates check children.
    pub project_root: Option<String>,
    pub continuation: Continuation,
    pub memory_enabled: bool,
    pub auto_promote: bool,
    pub embedding: Option<crate::embedding::Provider>,
    /// The session's writer authority, for new memories' level records.
    pub authority: Option<crate::memory_levels::Authority>,
}

/// How a second turn ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    Skipped(&'static str),
    NothingToSend,
    Resolved,
    /// A send or check outcome is unknown: its facts stay reserved for
    /// recovery.
    InFlight,
    /// A send met the runner's account wait: the stage it belonged to is
    /// revoked, its unresolved facts are retryable with no attempt spent, and
    /// its classification items spend no send.
    AccountWait(AccountWait),
    Failed(String),
}

/// Stage keys this process is working on, so recovery leaves them alone.
fn working() -> &'static Mutex<BTreeSet<String>> {
    static WORKING: OnceLock<Mutex<BTreeSet<String>>> = OnceLock::new();
    WORKING.get_or_init(|| Mutex::new(BTreeSet::new()))
}

/// Holds a stage key in [`working`] until dropped.
struct Working(String);

impl Working {
    fn claim(stage: &str) -> Option<Self> {
        working()
            .lock()
            .expect("working stages")
            .insert(stage.to_owned())
            .then(|| Self(stage.to_owned()))
    }
}

impl Drop for Working {
    fn drop(&mut self) {
        working().lock().expect("working stages").remove(&self.0);
    }
}

/// Where a send goes and how it is made: the first turn's child and model.
#[derive(Clone, Debug)]
struct Carrier {
    runner: String,
    /// Stage and check-attempt rows belong to the owning session's harness.
    harness: String,
    child_harness: String,
    owner: String,
    child: String,
    project_root: Option<String>,
    model: ModelRef,
    decision_id: String,
    output_tokens: u64,
    language: Option<String>,
}

impl Carrier {
    fn of(job: &Job) -> Self {
        Self {
            runner: job.owner.runner.clone(),
            harness: job.owner.harness.clone(),
            child_harness: job.continuation.child.session.harness.clone(),
            owner: job.owner.session.clone(),
            child: job.continuation.child.session.session.clone(),
            project_root: job.project_root.clone(),
            model: job.continuation.model.clone(),
            decision_id: job.continuation.decision_id.clone(),
            output_tokens: job.continuation.output_tokens,
            language: job.continuation.language.clone(),
        }
    }

    /// The carrier name stored on stage rows: ck-mc and the runner.
    fn name(&self) -> String {
        format!("ck-mc:{}", self.runner)
    }

    fn child(&self, session: &str) -> Child {
        Child {
            session: SessionRef::new(self.runner.clone(), self.child_harness.clone(), session),
            project_root: self.project_root.clone(),
        }
    }

    fn model_json(&self) -> Value {
        json!({
            "provider": self.model.provider,
            "model": self.model.model,
            "variant": self.model.variant,
            "decision": self.decision_id,
            "outputTokens": self.output_tokens,
            "language": self.language,
        })
    }

    fn stage_model_json(&self) -> Value {
        let mut model = self.model_json();
        // Recovery needs the child's route, but check keys hash only the model
        // profile so a route change never causes the same check to be sent twice.
        model["childHarness"] = json!(self.child_harness);
        model
    }

    /// The carrier a stage row and its request name, for recovery.
    fn from_stage(row: &StageRow, project_root: Option<String>) -> Option<Self> {
        let runner = row.carrier.strip_prefix("ck-mc:")?.to_owned();
        let model = &row.request["model"];
        let mut chosen = ModelRef::new(
            model["provider"].as_str()?.to_owned(),
            model["model"].as_str()?.to_owned(),
        );
        chosen.variant = model["variant"].as_str().map(str::to_owned);
        Some(Self {
            runner,
            harness: row.harness.clone(),
            // Older stages did not record a child route and used the owner's.
            child_harness: model["childHarness"]
                .as_str()
                .unwrap_or(&row.harness)
                .to_owned(),
            owner: row.session.clone(),
            child: row.child.clone()?,
            project_root,
            model: chosen,
            decision_id: model["decision"].as_str()?.to_owned(),
            output_tokens: model["outputTokens"].as_u64()?,
            language: model["language"].as_str().map(str::to_owned),
        })
    }

    /// Send `prompt` in `child` under `send_id` with `system`, and wait.
    async fn send<C: RunnerClient>(
        &self,
        client: &C,
        child: &str,
        send_id: &str,
        prompt: &str,
        system: &str,
    ) -> Result<run::Reply, SummaryError> {
        let how = Model {
            model: &self.model,
            decision_id: &self.decision_id,
            output_tokens: self.output_tokens,
            system,
            deadline: tokio::time::Instant::now() + TIMEOUT,
            // Preserve the existing second-turn and memory-check parameters.
            continuation: true,
            // Turn two reuses the first turn's child; memory fact checks use their
            // own child, even when reattaching an interrupted check by send id.
            creates_child: child != self.child,
            cache_ttl: cortexkit_role_llm_runner::cache::Ttl::Short,
            send: if child == self.child {
                SendKind::TurnTwo
            } else {
                SendKind::FactCheck
            },
        };
        let mut usage: Option<StepUsage> = None;
        run::send_and_wait(
            client,
            &self.child(child),
            send_id,
            prompt,
            &how,
            &mut usage,
        )
        .await
    }
}

/// A candidate fact as the second turn reads it.
#[derive(Clone, Debug)]
struct FactRow {
    id: i64,
    project: String,
    publication: String,
    category: String,
    content: String,
    anchor_known: bool,
    attempts: i64,
}

const FACT_COLUMNS: &str =
    "f.id, f.project_path, f.publication_id, f.category, f.content, f.anchor_known, f.fact_attempts";

fn fact_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<FactRow> {
    Ok(FactRow {
        id: row.get(0)?,
        project: row.get(1)?,
        publication: row.get(2)?,
        category: row.get(3)?,
        content: row.get(4)?,
        anchor_known: row.get::<_, i64>(5)? == 1,
        attempts: row.get(6)?,
    })
}

/// Every `retryable` fact of this publication, then at most
/// [`RETRY_BACKLOG_PER_RUN`] of earlier committed publications of the
/// project, oldest first.
fn select_facts(
    conn: &Connection,
    project: &str,
    publication: &str,
) -> rusqlite::Result<Vec<FactRow>> {
    let mut facts: Vec<FactRow> = conn
        .prepare_cached(&format!(
            "SELECT {FACT_COLUMNS} FROM memory_pending_facts f
             WHERE f.project_path = ?1 AND f.publication_id = ?2 AND f.state = 'retryable' ORDER BY f.id"
        ))?
        .query_map(params![project, publication], fact_row)?
        .collect::<Result<_, _>>()?;
    let backlog: Vec<FactRow> = conn
        .prepare_cached(&format!(
            "SELECT {FACT_COLUMNS} FROM memory_pending_facts f
             JOIN memory_publications p ON p.publication_id = f.publication_id
             WHERE f.project_path = ?1 AND f.publication_id != ?2 AND f.state = 'retryable'
               AND p.commit_order IS NOT NULL
             ORDER BY p.commit_order, f.id LIMIT ?3"
        ))?
        .query_map(
            params![project, publication, RETRY_BACKLOG_PER_RUN as i64],
            fact_row,
        )?
        .collect::<Result<_, _>>()?;
    facts.extend(backlog);
    Ok(facts)
}

/// A fact's stored evidence blocks with their source session, oldest first.
fn fact_blocks(conn: &Connection, fact: i64) -> rusqlite::Result<Vec<(String, EvidenceBlock)>> {
    conn.prepare_cached(
        "SELECT b.source_session_id, b.start_ordinal, b.end_ordinal, b.role, b.parts_json, b.joined_text
         FROM memory_fact_block_links l JOIN memory_fact_blocks b ON b.id = l.block_id
         WHERE l.fact_id = ?1 ORDER BY b.start_ordinal",
    )?
    .query_map(params![fact], |row| {
        Ok((
            row.get::<_, String>(0)?,
            EvidenceBlock {
                start_ordinal: row.get(1)?,
                end_ordinal: row.get(2)?,
                role: row.get(3)?,
                parts: serde_json::from_str(&row.get::<_, String>(4)?).unwrap_or_default(),
                joined_text: row.get(5)?,
            },
        ))
    })?
    .collect()
}

fn publication_session(conn: &Connection, publication: &str) -> rusqlite::Result<String> {
    Ok(conn
        .query_row(
            "SELECT source_session_id FROM memory_publications WHERE publication_id = ?1",
            params![publication],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or_default())
}

/// A memory as a neighbour: live, with its revision.
fn neighbour_of(conn: &Connection, project: &str, id: i64) -> rusqlite::Result<Option<Neighbour>> {
    conn.query_row(
        "SELECT id, revision, origin_category, content FROM memories
         WHERE id = ?1 AND level = 'project' AND owner_id = ?2 AND COALESCE(status, 'active') != 'archived'",
        params![id, project],
        |row| {
            Ok(Neighbour {
                id: row.get(0)?,
                revision: row.get(1)?,
                category: row.get(2)?,
                content: row.get(3)?,
            })
        },
    )
    .optional()
}

const STOP_WORDS: &str = "a an the is are was were be been to of for in on at with by from and or not no it its this that as must should always never use only project user agent when after before every all can do does into than then same both";

fn terms(text: &str) -> BTreeSet<String> {
    let stop: BTreeSet<&str> = STOP_WORDS.split(' ').collect();
    text.to_lowercase()
        .split(|ch: char| !(ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_'))
        .filter(|word| word.len() > 2 && !stop.contains(word))
        .map(str::to_owned)
        .collect()
}

/// The neighbours worth showing: substantial shared words, or close
/// meaning; a lone generic keyword is not a neighbour
/// (`rankTurnTwoNeighbours`).
fn rank_neighbours(
    fact: &str,
    candidates: Vec<Neighbour>,
    semantic: &BTreeMap<i64, f64>,
) -> Vec<Neighbour> {
    let query = terms(fact);
    let mut ranked: Vec<(f64, Neighbour)> = candidates
        .into_iter()
        .filter_map(|neighbour| {
            let words = terms(&neighbour.content);
            let shared = query.iter().filter(|word| words.contains(*word)).count();
            let lexical = shared as f64 / query.len().max(1) as f64;
            let meaning = semantic.get(&neighbour.id).copied().unwrap_or(0.0);
            let relevant = (shared >= query.len().min(2) && lexical >= 0.35 && !query.is_empty())
                || meaning >= 0.75;
            relevant.then_some((lexical.max(meaning), neighbour))
        })
        .collect();
    ranked.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.id.cmp(&b.1.id)));
    ranked
        .into_iter()
        .take(NEIGHBOUR_LIMIT)
        .map(|(_, neighbour)| neighbour)
        .collect()
}

/// A fact's neighbouring memories by words and, with an embedding, by
/// meaning (`retrieveTurnTwoNeighbours`). The flag is true when meaning
/// played no part.
fn neighbours(
    conn: &Connection,
    project: &str,
    fact: &str,
    query: Option<(&[f32], &str)>,
) -> rusqlite::Result<(Vec<Neighbour>, bool)> {
    let lexical =
        crate::search::sources::memory_words(conn, project, fact, NEIGHBOUR_SHORTLIST_CAP);
    let mut semantic: Vec<i64> = Vec::new();
    let mut scores = BTreeMap::new();
    if let Some((vector, model)) = query {
        let stored = crate::search::sources::memory_vectors(conn, project, model);
        let mut scored: Vec<(i64, f64)> = stored
            .iter()
            .filter(|(_, stored)| stored.len() == vector.len())
            .map(|(id, stored)| (*id, crate::embedding::similarity(vector, stored)))
            .collect();
        scored.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
        for (id, score) in scored {
            scores.insert(id, score);
            semantic.push(id);
        }
    }
    let cap = NEIGHBOUR_SHORTLIST_CAP * 2;
    let mut ordered: Vec<i64> = Vec::new();
    for id in lexical {
        if ordered.len() < cap && !ordered.contains(&id) {
            ordered.push(id);
        }
    }
    for id in &semantic {
        if ordered.len() >= cap {
            break;
        }
        if !ordered.contains(id) && neighbour_of(conn, project, *id)?.is_some() {
            ordered.push(*id);
        }
    }
    let mut candidates = Vec::new();
    for id in ordered {
        candidates.extend(neighbour_of(conn, project, id)?);
    }
    Ok((
        rank_neighbours(fact, candidates, &scores),
        semantic.is_empty(),
    ))
}

/// How many second-turn sends carried an item: its attempts.
const ITEM_SENDS: &str = "(SELECT COUNT(*) FROM memory_stage_attempts s, json_each(s.request_json, '$.items') j
    WHERE s.project_path = i.project_path AND s.stage = 'turn_two' AND j.value = i.enqueue_sequence)";

/// Agent memories due for scoring: pending, with a stored excerpt, at or
/// below the stage's watermark, and sent fewer than three times.
fn due_items(conn: &Connection, project: &str, watermark: i64) -> rusqlite::Result<Vec<i64>> {
    conn.prepare_cached(&format!(
        "SELECT i.enqueue_sequence FROM memory_classification_items i
         WHERE i.project_path = ?1 AND i.state = 'pending' AND i.excerpt IS NOT NULL
           AND i.enqueue_sequence <= ?2 AND {ITEM_SENDS} < ?3
         ORDER BY i.enqueue_sequence"
    ))?
    .query_map(params![project, watermark, MAX_STAGE2_ATTEMPTS], |row| {
        row.get(0)
    })?
    .collect()
}

fn prompt_items(conn: &Connection, items: &[i64]) -> rusqlite::Result<Vec<PromptItem>> {
    let mut found = Vec::new();
    for item in items {
        let row = conn
            .query_row(
                "SELECT i.enqueue_sequence, i.memory_id, m.content, i.excerpt
                 FROM memory_classification_items i JOIN memories m ON m.id = i.memory_id
                 WHERE i.enqueue_sequence = ?1 AND i.state = 'pending' AND i.excerpt IS NOT NULL",
                params![item],
                |row| {
                    Ok(PromptItem {
                        item: row.get(0)?,
                        memory_id: row.get(1)?,
                        content: row.get(2)?,
                        excerpt: row.get(3)?,
                    })
                },
            )
            .optional()?;
        found.extend(row);
    }
    Ok(found)
}

/// Record a reply's scores for the items its send carried. A score lands
/// only on an item still pending; it copies the importance onto the memory
/// (keeping a safety-critical memory at 80 or more) and keeps the class as
/// a proposal on the item (`recordItemScores`).
fn record_scores(conn: &Connection, sent: &[i64], scores: &[Score]) -> rusqlite::Result<usize> {
    let safety: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('memories') WHERE name = 'safety_critical')",
        [],
        |row| row.get(0),
    )?;
    let now = crate::memory_writes::now_ms();
    let mut recorded = 0;
    for score in scores {
        if !sent.contains(&score.item) {
            continue;
        }
        let won = conn.execute(
            "UPDATE memory_classification_items SET state = 'scored', importance = ?1, proposed_class = ?2, scored_at = ?3
             WHERE enqueue_sequence = ?4 AND state = 'pending'",
            params![score.importance, score.proposed_class, now, score.item],
        )?;
        if won != 1 {
            continue;
        }
        let importance = if safety {
            format!(
                "CASE WHEN safety_critical = 1 THEN MAX({}, ?1) ELSE ?1 END",
                crate::memory_writes::SAFETY_CRITICAL_MIN_IMPORTANCE
            )
        } else {
            "?1".to_owned()
        };
        conn.execute(
            &format!(
                "UPDATE memories SET importance = {importance}, classified_at = ?2
                 WHERE id = (SELECT memory_id FROM memory_classification_items WHERE enqueue_sequence = ?3)
                   AND status != 'archived'"
            ),
            params![score.importance, now, score.item],
        )?;
        recorded += 1;
    }
    Ok(recorded)
}

/// A stage row as recovery and resolution read it.
#[derive(Clone, Debug)]
struct StageRow {
    session: String,
    harness: String,
    carrier: String,
    child: Option<String>,
    started_at: i64,
    request: Value,
    reply: Option<Value>,
}

fn stage_row(conn: &Connection, key: &str) -> rusqlite::Result<Option<StageRow>> {
    conn.query_row(
        "SELECT stage_key, session_id, harness, carrier, child_session_id, started_at, request_json, reply_json
         FROM memory_stage_attempts WHERE stage_key = ?1",
        params![key],
        |row| {
            Ok(StageRow {
                session: row.get(1)?,
                harness: row.get(2)?,
                carrier: row.get(3)?,
                child: row.get(4)?,
                started_at: row.get(5)?,
                request: serde_json::from_str(&row.get::<_, String>(6)?).unwrap_or(Value::Null),
                reply: row
                    .get::<_, Option<String>>(7)?
                    .and_then(|json| serde_json::from_str(&json).ok()),
            })
        },
    )
    .optional()
}

/// The facts a send carried, with the attempts each had then.
fn sent_attempts(request: &Value) -> BTreeMap<i64, i64> {
    request["factAttempts"]
        .as_object()
        .map(|map| {
            map.iter()
                .filter_map(|(id, attempts)| Some((id.parse().ok()?, attempts.as_i64()?)))
                .collect()
        })
        .unwrap_or_default()
}

fn sent_items(request: &Value) -> Vec<i64> {
    request["items"]
        .as_array()
        .map(|items| items.iter().filter_map(Value::as_i64).collect())
        .unwrap_or_default()
}

/// Charge every fact `stage` still reserves one attempt and move the stage
/// to `state`, in one transaction (`consumeStageAttempts`). False when the
/// stage was no longer open.
fn charge_stage(
    conn: &mut Connection,
    stage: &str,
    reason: &str,
    state: &str,
) -> rusqlite::Result<bool> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let open: Option<i64> = tx
        .query_row(
            "SELECT 1 FROM memory_stage_attempts WHERE stage_key = ?1 AND state IN ('reserved', 'sending', 'replied')",
            params![stage],
            |row| row.get(0),
        )
        .optional()?;
    if open.is_none() {
        return Ok(false);
    }
    let facts: Vec<(i64, String)> = tx
        .prepare_cached(
            "SELECT id, project_path FROM memory_pending_facts WHERE state = 'in_flight' AND reserved_stage_key = ?1",
        )?
        .query_map(params![stage], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<_, _>>()?;
    for (fact, project) in facts {
        applier::charge(
            &tx,
            &json!([stage, fact, reason]).to_string(),
            &project,
            fact,
            reason,
        )?;
    }
    tx.execute(
        "UPDATE memory_stage_attempts SET state = ?2 WHERE stage_key = ?1 AND state IN ('reserved', 'sending', 'replied')",
        params![stage, state],
    )?;
    tx.commit()?;
    Ok(true)
}

/// Revoke an open stage: its facts go back to `retryable` without spending
/// an attempt. With `items_unsent`, the classification items the stage
/// carried spend no send either: their sequences move from the request's
/// `items` to `itemsHeldForAccount`. An item's sends are counted from
/// `items` of every second-turn row in any state, by ck-mc ([`ITEM_SENDS`])
/// and by the plugin hosts alike, so neither side counts them. The other
/// revocations come after the stage's reply, when the model has scored or
/// passed over the items, and their sends still count.
fn revoke(conn: &mut Connection, stage: &str, items_unsent: bool) -> rusqlite::Result<bool> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let changed = tx.execute(
        "UPDATE memory_stage_attempts SET state = 'revoked' WHERE stage_key = ?1 AND state IN ('reserved', 'sending', 'replied')",
        params![stage],
    )?;
    if changed == 0 {
        return Ok(false);
    }
    if items_unsent {
        tx.execute(
            "UPDATE memory_stage_attempts
             SET request_json = json_set(json_remove(request_json, '$.items'),
                                         '$.itemsHeldForAccount', json(json_extract(request_json, '$.items')))
             WHERE stage_key = ?1 AND json_type(request_json, '$.items') = 'array'",
            params![stage],
        )?;
    }
    tx.execute(
        "UPDATE memory_pending_facts SET state = 'retryable', reason = 'turn_two_revoked', reserved_stage_key = NULL
         WHERE reserved_stage_key = ?1 AND state = 'in_flight'",
        params![stage],
    )?;
    tx.commit()?;
    Ok(true)
}

/// Every fact the send carried is still held by it, or resolved under its
/// own receipt.
fn reservations_intact(conn: &Connection, stage: &str, request: &Value) -> rusqlite::Result<bool> {
    for fact in sent_attempts(request).keys() {
        let row: Option<(String, Option<String>)> = conn
            .query_row(
                "SELECT state, reserved_stage_key FROM memory_pending_facts WHERE id = ?1",
                params![fact],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((state, reserved)) = row else {
            return Ok(false);
        };
        if state == "in_flight" && reserved.as_deref() == Some(stage) {
            continue;
        }
        let own: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM memory_decision_receipts WHERE fact_id = ?1
                   AND CASE WHEN json_valid(decision_key) THEN json_extract(decision_key, '$[5]') END = ?2",
                params![fact, stage],
                |row| row.get(0),
            )
            .optional()?;
        if own.is_none() {
            return Ok(false);
        }
    }
    Ok(true)
}

fn still_reserved(conn: &Connection, stage: &str) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM memory_pending_facts WHERE state = 'in_flight' AND reserved_stage_key = ?1",
        params![stage],
        |row| row.get(0),
    )
}

/// The decision key: the project, the fact, its attempts at send, the
/// decision's position in the reply, the targets with the revisions it
/// read, and the stage, so the same reply never applies twice.
fn decision_key(
    project: &str,
    fact: i64,
    attempts: i64,
    decision: Option<&Decision>,
    stage: &str,
) -> String {
    let mut targets: Vec<(i64, Option<i64>)> = match decision {
        Some(Decision {
            sources: Some(sources),
            ..
        }) => sources
            .iter()
            .map(|(id, revision)| (*id, Some(*revision)))
            .collect(),
        Some(decision) => decision
            .target_id
            .map(|target| vec![(target, decision.revision)])
            .unwrap_or_default(),
        None => Vec::new(),
    };
    targets.sort_by_key(|target| target.0);
    json!([
        project,
        fact,
        attempts,
        decision.map_or(-1, |decision| decision.ordinal as i64),
        targets
            .iter()
            .map(|(id, revision)| json!([id, revision]))
            .collect::<Vec<_>>(),
        stage
    ])
    .to_string()
}

/// What resolving a stage needs besides the store.
struct Resolver<'a, C> {
    client: &'a C,
    db: &'a ContextDb,
    carrier: Carrier,
    memory_enabled: bool,
    auto_promote: bool,
    authority: Option<crate::memory_levels::Authority>,
}

/// Why resolving a stage stopped before every fact was resolved.
enum Stopped {
    /// A check's outcome could not be known: the stage keeps the rest of its
    /// facts reserved for recovery.
    Unknown,
    /// The runner holds summarizer sends back until an account has room. The
    /// caller revokes the stage, which returns its unresolved facts to
    /// `retryable` without spending an attempt.
    AccountWait(AccountWait),
}

impl<C: RunnerClient> Resolver<'_, C> {
    fn reservation(&self, fact: &FactRow, stage: &str, attempts: i64) -> Reservation {
        Reservation {
            stage_key: stage.to_owned(),
            fact_id: fact.id,
            project: fact.project.clone(),
            attempts,
        }
    }

    fn pending(
        &self,
        fact: &FactRow,
        reservation: &Reservation,
        key: &str,
        reason: &str,
        memory: Option<i64>,
        mapping: Option<Value>,
    ) -> Result<(), String> {
        self.db
            .with_connection(|conn| {
                applier::resolve(
                    conn,
                    key,
                    &fact.project,
                    fact.id,
                    Some(reservation),
                    "turn_two",
                    Resolution::Pending,
                    reason,
                    memory,
                    mapping,
                )
            })
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    /// Resolve every fact of a replied stage from its recorded reply
    /// (`resolveStage`). `Err` when it stopped: a check's outcome is unknown,
    /// or a check met an account wait.
    async fn stage(&self, stage: &str) -> Result<Result<(), Stopped>, String> {
        let row = self
            .db
            .with_connection(|conn| stage_row(conn, stage))
            .map_err(|error| error.to_string())?;
        let Some(row) = row.filter(|row| row.reply.is_some()) else {
            return Ok(Ok(()));
        };
        let reply = row.reply.clone().unwrap_or_default();
        let replied: bool = self
            .db
            .with_connection(|conn| {
                conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM memory_stage_attempts WHERE stage_key = ?1 AND state = 'replied')",
                    params![stage],
                    |row| row.get(0),
                )
            })
            .map_err(|error| error.to_string())?;
        if !replied {
            return Ok(Ok(()));
        }
        let intact = self
            .db
            .with_connection(|conn| reservations_intact(conn, stage, &row.request))
            .map_err(|error| error.to_string())?;
        if !intact {
            self.db
                .with_connection(|conn| revoke(conn, stage, false))
                .map_err(|error| error.to_string())?;
            return Ok(Ok(()));
        }
        let sent = sent_attempts(&row.request);
        let items = sent_items(&row.request);
        let parsed = envelope::parse(
            reply["text"].as_str().unwrap_or(""),
            reply["lengthCapped"].as_bool().unwrap_or(false),
            false,
        );
        let envelope = match parsed {
            Ok(envelope) => envelope,
            Err(refusal) => {
                self.db
                    .with_connection(|conn| {
                        charge_stage(
                            conn,
                            stage,
                            &format!("envelope_{}", refusal.as_str()),
                            "envelope_failed",
                        )
                    })
                    .map_err(|error| error.to_string())?;
                return Ok(Ok(()));
            }
        };
        let extra: Vec<i64> = envelope
            .decisions
            .keys()
            .filter(|id| !sent.contains_key(id))
            .copied()
            .collect();
        if !extra.is_empty() {
            tracing::info!("ck-mc: turn two: ignored extra fact ids: {extra:?}");
        }
        let facts: Vec<FactRow> = self
            .db
            .with_connection(|conn| {
                conn.prepare_cached(&format!(
                    "SELECT {FACT_COLUMNS} FROM memory_pending_facts f
                     WHERE f.state = 'in_flight' AND f.reserved_stage_key = ?1 ORDER BY f.id"
                ))?
                .query_map(params![stage], fact_row)?
                .collect::<Result<Vec<_>, _>>()
            })
            .map_err(|error| error.to_string())?;
        for fact in &facts {
            let attempts = sent.get(&fact.id).copied().unwrap_or(fact.attempts);
            let reservation = self.reservation(fact, stage, attempts);
            match self
                .fact(
                    fact,
                    attempts,
                    envelope.decisions.get(&fact.id),
                    &reservation,
                    stage,
                )
                .await?
            {
                Ok(()) => {}
                Err(stopped) => return Ok(Err(stopped)),
            }
        }
        self.db
            .with_connection(|conn| -> rusqlite::Result<()> {
                let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
                let open: Option<i64> = tx
                    .query_row(
                        "SELECT 1 FROM memory_stage_attempts WHERE stage_key = ?1 AND state = 'replied'",
                        params![stage],
                        |row| row.get(0),
                    )
                    .optional()?;
                if open.is_none() {
                    return Ok(());
                }
                if !reservations_intact(&tx, stage, &row.request)? {
                    drop(tx);
                    revoke(conn, stage, false)?;
                    return Ok(());
                }
                record_scores(&tx, &items, &envelope.scores)?;
                if still_reserved(&tx, stage)? == 0 {
                    tx.execute(
                        "UPDATE memory_stage_attempts SET state = 'resolved' WHERE stage_key = ?1 AND state = 'replied'",
                        params![stage],
                    )?;
                }
                tx.commit()
            })
            .map_err(|error| error.to_string())?;
        Ok(Ok(()))
    }

    /// Resolve one fact from its decision (`resolveFact`).
    async fn fact(
        &self,
        fact: &FactRow,
        attempts: i64,
        entry: Option<&Entry>,
        reservation: &Reservation,
        stage: &str,
    ) -> Result<Result<(), Stopped>, String> {
        let decision = match entry {
            Some(Entry::Decision(decision)) => decision.as_ref(),
            other => {
                let key = decision_key(&fact.project, fact.id, attempts, None, stage);
                let reason = if other.is_none() {
                    "missing_decision"
                } else {
                    "malformed_decision"
                };
                return self
                    .pending(fact, reservation, &key, reason, None, None)
                    .map(Ok);
            }
        };
        let key = decision_key(&fact.project, fact.id, attempts, Some(decision), stage);
        match decision.action.as_str() {
            "abstain" => self
                .pending(fact, reservation, &key, "abstain", None, None)
                .map(Ok),
            "retire" | "promote_rule" => {
                tracing::info!(
                    "ck-mc: turn two dropped {} for fact {}",
                    decision.action,
                    fact.id
                );
                let reason = format!("{}_dropped", decision.action);
                self.pending(fact, reservation, &key, &reason, None, None)
                    .map(Ok)
            }
            "new" | "conflict" => {
                let conflict = decision.action == "conflict";
                if conflict && !self.auto_promote {
                    let target = self.live_target(&fact.project, decision.target_id)?;
                    return match target {
                        None => {
                            self.pending(fact, reservation, &key, "conflict_target", None, None)
                        }
                        Some((target, _)) => self.pending(
                            fact,
                            reservation,
                            &key,
                            "auto_promote_disabled",
                            Some(target),
                            Some(json!({"conflictWith": target})),
                        ),
                    }
                    .map(Ok);
                }
                let session = self
                    .db
                    .with_connection(|conn| publication_session(conn, &fact.publication))
                    .map_err(|error| error.to_string())?;
                let content = if conflict {
                    fact.content.clone()
                } else {
                    envelope::apply_decided_prefix(&fact.content, decision.decided)
                };
                self.db
                    .with_connection(|conn| {
                        applier::admit(
                            conn,
                            &Admission {
                                key: &key,
                                operation: &decision.action,
                                project: &fact.project,
                                category: &fact.category,
                                content: &content,
                                source_session: &session,
                                memory_enabled: self.memory_enabled,
                                auto_promote: self.auto_promote,
                                conflict_target: decision.target_id.filter(|_| conflict),
                                fact_id: fact.id,
                                reservation: Some(reservation),
                                authority: self.authority.as_ref(),
                                expires: decision.expires.as_deref().filter(|_| !conflict),
                            },
                        )
                    })
                    .map(|_| Ok(()))
                    .map_err(|error| error.to_string())
            }
            "covered" => self.covered(fact, reservation, &key, decision).map(Ok),
            "edit" | "replaces" | "merge" => self.revision(fact, reservation, &key, decision).await,
            _ => self
                .pending(fact, reservation, &key, "malformed_decision", None, None)
                .map(Ok),
        }
    }

    /// A live memory of the project, with its revision.
    fn live_target(&self, project: &str, id: Option<i64>) -> Result<Option<(i64, i64)>, String> {
        let Some(id) = id else {
            return Ok(None);
        };
        self.db
            .with_connection(|conn| {
                conn.query_row(
                    "SELECT id, revision FROM memories WHERE id = ?1 AND level = 'project' AND owner_id = ?2
                       AND COALESCE(status, 'active') != 'archived'",
                    params![id, project],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
            })
            .map_err(|error| error.to_string())
    }

    /// `covered`: an existing memory already states the fact. Only evidence
    /// a person wrote can show that; a fact with no stored lines, or one
    /// whose excerpt is just a clause of the memory, could be the model
    /// repeating memory back, so it stays pending (`resolveCovered`).
    fn covered(
        &self,
        fact: &FactRow,
        reservation: &Reservation,
        key: &str,
        decision: &Decision,
    ) -> Result<(), String> {
        let Some((target, revision)) = self.live_target(&fact.project, decision.target_id)? else {
            return self.pending(fact, reservation, key, "covered_target", None, None);
        };
        if Some(revision) != decision.revision {
            return self
                .db
                .with_connection(|conn| {
                    applier::resolve(
                        conn,
                        key,
                        &fact.project,
                        fact.id,
                        Some(reservation),
                        "turn_two",
                        Resolution::Retryable,
                        "cas_loss",
                        None,
                        None,
                    )
                })
                .map(|_| ())
                .map_err(|error| error.to_string());
        }
        let content: String = self
            .db
            .with_connection(|conn| {
                conn.query_row(
                    "SELECT content FROM memories WHERE id = ?1",
                    params![target],
                    |row| row.get(0),
                )
            })
            .map_err(|error| error.to_string())?;
        let clauses = split_memory_clauses(&content);
        let ordinals = decision.clauses.clone().unwrap_or_default();
        let distinct: BTreeSet<i64> = ordinals.iter().copied().collect();
        if distinct.len() != ordinals.len()
            || ordinals
                .iter()
                .any(|ordinal| *ordinal < 1 || *ordinal > clauses.len() as i64)
        {
            return self.pending(fact, reservation, key, "covered_mapping", None, None);
        }
        let blocks = self
            .db
            .with_connection(|conn| fact_blocks(conn, fact.id))
            .map_err(|error| error.to_string())?;
        if !fact.anchor_known || blocks.is_empty() {
            return self.pending(fact, reservation, key, "unknown_lineage", None, None);
        }
        if !blocks.iter().any(|(_, block)| person_wrote(block)) {
            return self.pending(fact, reservation, key, "recitation", None, None);
        }
        if let Some(excerpt) = &decision.excerpt {
            let excerpt = normalize_lifecycle_text(excerpt);
            if clauses
                .iter()
                .any(|clause| normalize_lifecycle_text(&clause.text) == excerpt)
            {
                return self.pending(fact, reservation, key, "recitation", None, None);
            }
        }
        self.db
            .with_connection(|conn| {
                applier::resolve(
                    conn,
                    key,
                    &fact.project,
                    fact.id,
                    Some(reservation),
                    "covered",
                    Resolution::Covered,
                    "covered",
                    Some(target),
                    Some(json!({"memoryId": target, "revision": revision, "clauses": ordinals})),
                )
            })
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    /// `edit`, `replaces`, `merge`: the gates, then the narrow checks, then
    /// the commit (`resolveRevision`, `applyHistorianRevision`).
    async fn revision(
        &self,
        fact: &FactRow,
        reservation: &Reservation,
        key: &str,
        decision: &Decision,
    ) -> Result<Result<(), Stopped>, String> {
        let expected: Vec<(i64, i64)> = if decision.action == "merge" {
            decision.sources.clone().unwrap_or_default()
        } else {
            vec![(
                decision.target_id.unwrap_or(-1),
                decision.revision.unwrap_or(-1),
            )]
        };
        let changes: Vec<ChangedClause> = decision
            .removed
            .iter()
            .map(|clause| (clause, false))
            .chain(decision.replaced.iter().map(|clause| (clause, true)))
            .map(|(clause, replacement)| ChangedClause {
                memory_id: clause.memory_id,
                ordinal: clause.clause,
                block: clause.block,
                excerpt: clause.excerpt.clone(),
                replacement,
            })
            .collect();
        let added: Vec<AddedClause> = decision
            .added
            .iter()
            .map(|clause| AddedClause {
                text: clause.text.clone(),
                block: clause.block,
                excerpt: clause.excerpt.clone(),
            })
            .collect();
        // The kept clauses must be exactly the clauses the decision doesn't
        // change, read at the revisions it cites. A source that moved since
        // is left to the commit, which retries it as a compare-and-swap loss.
        let mut current = Vec::new();
        for (id, _) in &expected {
            current.push(self.live_target(&fact.project, Some(*id))?);
        }
        if current
            .iter()
            .zip(&expected)
            .all(|(live, (_, revision))| live.is_some_and(|(_, live)| live == *revision))
        {
            let mut expected_kept = BTreeSet::new();
            for (id, _) in &expected {
                let content: String = self
                    .db
                    .with_connection(|conn| {
                        conn.query_row(
                            "SELECT content FROM memories WHERE id = ?1",
                            params![id],
                            |row| row.get(0),
                        )
                    })
                    .map_err(|error| error.to_string())?;
                for clause in split_memory_clauses(&content) {
                    if !changes.iter().any(|change| {
                        change.memory_id == *id && change.ordinal == clause.ordinal as i64
                    }) {
                        expected_kept.insert((*id, clause.ordinal as i64));
                    }
                }
            }
            let named: Vec<(i64, i64)> = decision.kept.clone();
            let distinct: BTreeSet<(i64, i64)> = named.iter().copied().collect();
            if named.len() != expected_kept.len()
                || distinct.len() != named.len()
                || named.iter().any(|entry| !expected_kept.contains(entry))
            {
                return self
                    .pending(fact, reservation, key, "kept_mismatch", None, None)
                    .map(Ok);
            }
        }
        let revision = Revision {
            key: key.to_owned(),
            action: decision.action.clone(),
            project: fact.project.clone(),
            expected: expected.clone(),
            survivor: if decision.action == "merge" {
                decision.survivor_id.unwrap_or(-1)
            } else {
                decision.target_id.unwrap_or(-1)
            },
            final_text: decision.final_text.clone().unwrap_or_default(),
            changes,
            added,
            expires: decision.expires.clone(),
        };
        let existing = self
            .db
            .with_connection(|conn| applier::read_receipt(conn, key))
            .map_err(|error| error.to_string())?;
        if existing.is_some() {
            return Ok(Ok(()));
        }
        let sources = self
            .db
            .with_connection(|conn| applier::sources(conn, &expected))
            .map_err(|error| error.to_string())?;
        let failed = |reason: &str, retryable: bool| {
            self.db
                .with_connection(|conn| {
                    applier::revision_failed(
                        conn,
                        &revision,
                        fact.id,
                        Some(reservation),
                        reason,
                        retryable,
                    )
                })
                .map(|_| Ok(()))
                .map_err(|error| error.to_string())
        };
        // A source of the project archived or revised since the decision
        // read it: the decision is stale, not wrong, so it is retried.
        if expected.iter().any(|(id, revision)| {
            sources.iter().any(|source| {
                source.id == *id
                    && source.project == fact.project
                    && (source.status == "archived" || source.revision != *revision)
            })
        }) {
            return failed("cas_loss", true);
        }
        let blocks: Vec<EvidenceBlock> = self
            .db
            .with_connection(|conn| fact_blocks(conn, fact.id))
            .map_err(|error| error.to_string())?
            .into_iter()
            .map(|(_, block)| block)
            .collect();
        let context = gates::Context {
            memory_enabled: self.memory_enabled,
            auto_promote: self.auto_promote,
            anchor_known: fact.anchor_known,
            blocks: &blocks,
            sources: &sources,
        };
        let plan = match gates::plan(&revision, &context) {
            Ok(plan) => plan,
            Err(reason) => return failed(reason, false),
        };
        for check in &plan.checks {
            match self.check(key, check).await? {
                Err(stopped) => return Ok(Err(stopped)),
                Ok(Err((reason, retryable))) => return failed(&reason, retryable),
                Ok(Ok(())) => {}
            }
        }
        self.db
            .with_connection(|conn| {
                applier::commit_revision(
                    conn,
                    &revision,
                    &plan,
                    fact.id,
                    Some(reservation),
                    self.authority.as_ref(),
                )
            })
            .map(|_| Ok(()))
            .map_err(|error| error.to_string())
    }

    /// Run one narrow check through the attempt ledger: a stored reply
    /// answers at once; otherwise the request is recorded before it goes
    /// out, in a fresh child of its own, under its key as the send id, so an
    /// interrupted check is reattached rather than sent twice.
    /// `Ok(Err((reason, retryable)))` when it sank the revision.
    async fn check(
        &self,
        decision_key: &str,
        check: &Check,
    ) -> Result<Result<Result<(), (String, bool)>, Stopped>, String> {
        let model = self.carrier.model_json();
        let key = gates::check_key(decision_key, check, &model);
        let system = check.kind.system();
        let stored: Option<Option<String>> = self
            .db
            .with_connection(|conn| {
                conn.query_row(
                    "SELECT reply_json FROM memory_check_attempts WHERE check_key = ?1",
                    params![key],
                    |row| row.get(0),
                )
                .optional()
            })
            .map_err(|error| error.to_string())?;
        let reply: Value = match stored {
            Some(Some(json)) => serde_json::from_str(&json).unwrap_or(Value::Null),
            _ => {
                if stored.is_none() {
                    let operand_ids = gates::expected_ids(check);
                    self.db
                        .with_connection(|conn| {
                            conn.execute(
                                "INSERT OR IGNORE INTO memory_check_attempts
                                    (check_key, decision_key, session_id, harness, kind, operand_ids_json, input_hash,
                                     request_profile_hash, request_json, state, started_at)
                                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'in_flight', ?10)",
                                params![
                                    key,
                                    decision_key,
                                    self.carrier.owner,
                                    self.carrier.harness,
                                    check.kind.name(),
                                    serde_json::to_string(&operand_ids).expect("ids serialize"),
                                    lifecycle_text_hash(&check.input),
                                    lifecycle_text_hash(&json!({"model": model, "system": lifecycle_text_hash(&system)}).to_string()),
                                    json!({"kind": check.kind.name(), "prompt": gates::render_input(check)}).to_string(),
                                    crate::memory_writes::now_ms(),
                                ],
                            )
                        })
                        .map_err(|error| error.to_string())?;
                }
                let child = format!("{}:{CHECK_CHILD}:{}", self.carrier.owner, &key[..16]);
                match self
                    .carrier
                    .send(
                        self.client,
                        &child,
                        &key,
                        &gates::render_input(check),
                        &system,
                    )
                    .await
                {
                    Ok(reply) => {
                        let reply = json!({
                            "verdicts": if reply.length_capped { Vec::new() } else { gates::parse_verdicts(&reply.text) },
                            "lengthCapped": reply.length_capped,
                        });
                        self.db
                            .with_connection(|conn| {
                                conn.execute(
                                    "UPDATE memory_check_attempts SET reply_json = ?2, state = 'resolved' WHERE check_key = ?1",
                                    params![key, reply.to_string()],
                                )
                            })
                            .map_err(|error| error.to_string())?;
                        reply
                    }
                    Err(SummaryError::Failed(error)) if error == TIMED_OUT => {
                        return Ok(Err(Stopped::Unknown))
                    }
                    // Nothing reached a model. The ledger row only guards
                    // against sending the check twice, so it goes; the stage
                    // that asked for the check is revoked by the caller, and
                    // a later second turn decides its facts afresh.
                    Err(SummaryError::AccountWait(wait)) => {
                        self.db
                            .with_connection(|conn| {
                                conn.execute(
                                    "DELETE FROM memory_check_attempts WHERE check_key = ?1 AND reply_json IS NULL",
                                    params![key],
                                )
                            })
                            .map_err(|error| error.to_string())?;
                        return Ok(Err(Stopped::AccountWait(wait)));
                    }
                    Err(SummaryError::Failed(error)) => {
                        tracing::warn!("ck-mc: turn two: check failed to send: {error}");
                        self.db
                            .with_connection(|conn| {
                                conn.execute(
                                    "UPDATE memory_check_attempts SET state = 'transport_failed' WHERE check_key = ?1",
                                    params![key],
                                )
                            })
                            .map_err(|error| error.to_string())?;
                        return Ok(Ok(Err(("check_transport".into(), true))));
                    }
                }
            }
        };
        let verdicts = reply["verdicts"].as_array().cloned().unwrap_or_default();
        Ok(Ok(
            match gates::judge(
                check,
                &verdicts,
                reply["lengthCapped"].as_bool().unwrap_or(false),
            ) {
                Verdict::Passed => Ok(()),
                Verdict::Malformed => Err(("malformed_check".into(), false)),
                Verdict::Refused(kind) => Err((format!("{}_refused", kind.name()), false)),
            },
        ))
    }
}

/// Evidence a person wrote: a user line, or a mixed block holding one.
///
/// The plugin asks for a `user` or `tool` block, but its stored blocks carry
/// the chunk's role letters (`U`, `A`, `mixed`), so no block ever matches
/// there and every `covered` decision stays pending. ck-mc applies the rule
/// as meant; tool output never reaches the summarizer's lines.
fn person_wrote(block: &EvidenceBlock) -> bool {
    match block.role.as_str() {
        "U" | "user" => true,
        "mixed" => block.parts.iter().any(|part| {
            part.split_once("] ")
                .is_some_and(|(_, rest)| rest.starts_with("U: "))
        }),
        _ => false,
    }
}

/// What a send reserved.
struct Reserved {
    stage: String,
    prompt: String,
}

/// Reserve the facts and store the stage, its classification watermark and
/// its request in one transaction before anything is sent; a fact another
/// send reserved meanwhile is left out. `None` when nothing is left to send.
fn reserve(
    conn: &mut Connection,
    job: &Job,
    carrier: &Carrier,
    facts: &[FactRow],
    prompt_facts: &BTreeMap<i64, PromptFact>,
    lexical_only: bool,
) -> rusqlite::Result<Option<Reserved>> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let publication = &job.continuation.publication_id;
    let attempt: i64 = tx.query_row(
        "SELECT COALESCE(MAX(run_attempt), 0) + 1 FROM memory_stage_attempts
         WHERE project_path = ?1 AND publication_id = ?2 AND stage = ?3",
        params![job.project, publication, STAGE],
        |row| row.get(0),
    )?;
    let stage = json!([job.project, publication, attempt, STAGE]).to_string();
    let watermark: i64 = tx.query_row(
        "SELECT COALESCE(MAX(enqueue_sequence), 0) FROM memory_classification_items WHERE project_path = ?1",
        params![job.project],
        |row| row.get(0),
    )?;
    let items = due_items(&tx, &job.project, watermark)?;
    tx.execute(
        "INSERT INTO memory_stage_attempts
            (stage_key, project_path, publication_id, run_attempt, stage, session_id, harness, child_session_id,
             carrier, state, classification_watermark, request_json, started_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'reserved', ?10, '{}', ?11)",
        params![
            stage,
            job.project,
            publication,
            attempt,
            STAGE,
            carrier.owner,
            carrier.harness,
            carrier.child,
            carrier.name(),
            watermark,
            crate::memory_writes::now_ms(),
        ],
    )?;
    let mut available = Vec::new();
    for fact in facts {
        let reserved = tx.execute(
            "UPDATE memory_pending_facts SET state = 'in_flight', reserved_stage_key = ?1 WHERE id = ?2 AND state = 'retryable'",
            params![stage, fact.id],
        )?;
        if reserved == 1 {
            available.push(fact);
        }
    }
    let item_views = prompt_items(&tx, &items)?;
    let fitted = envelope::fit(
        &job.continuation.prompts,
        &available
            .iter()
            .map(|fact| prompt_facts[&fact.id].clone())
            .collect::<Vec<_>>(),
        &item_views,
        lexical_only,
        PROMPT_MAX,
    );
    let selected: BTreeSet<i64> = fitted.facts.iter().map(|fact| fact.fact_id).collect();
    for fact in &available {
        if !selected.contains(&fact.id) {
            tx.execute(
                "UPDATE memory_pending_facts SET state = 'retryable', reserved_stage_key = NULL WHERE id = ?1 AND reserved_stage_key = ?2",
                params![fact.id, stage],
            )?;
        }
    }
    if selected.is_empty() && fitted.items.is_empty() {
        tx.execute(
            "DELETE FROM memory_stage_attempts WHERE stage_key = ?1",
            params![stage],
        )?;
        tx.commit()?;
        return Ok(None);
    }
    if fitted.deferred != (0, 0) {
        tracing::info!(
            "ck-mc: turn two: the prompt size bound left out {} fact(s) and {} item(s); they wait for a later run",
            fitted.deferred.0, fitted.deferred.1
        );
    }
    let attempts: serde_json::Map<String, Value> = available
        .iter()
        .filter(|fact| selected.contains(&fact.id))
        .map(|fact| (fact.id.to_string(), json!(fact.attempts)))
        .collect();
    let request = json!({
        "model": carrier.stage_model_json(),
        "factAttempts": attempts,
        "items": fitted.items.iter().map(|item| item.item).collect::<Vec<_>>(),
        "lexicalOnly": lexical_only,
        "prompt": fitted.prompt,
    });
    tx.execute(
        "UPDATE memory_stage_attempts SET request_json = ?2 WHERE stage_key = ?1",
        params![stage, request.to_string()],
    )?;
    tx.commit()?;
    Ok(Some(Reserved {
        stage,
        prompt: fitted.prompt,
    }))
}

fn record_reply(
    conn: &Connection,
    stage: &str,
    carrier: &Carrier,
    reply: &run::Reply,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE memory_stage_attempts SET reply_json = ?2, reported_profile_json = ?3, state = 'replied'
         WHERE stage_key = ?1 AND state IN ('reserved', 'sending')",
        params![
            stage,
            json!({"text": reply.text, "lengthCapped": reply.length_capped, "toolActivity": false}).to_string(),
            carrier.model_json().to_string(),
        ],
    )?;
    Ok(())
}

/// Count one more recovery visit of a stage and return the count.
fn count_visit(conn: &Connection, stage: &str) -> rusqlite::Result<i64> {
    let Some(row) = stage_row(conn, stage)? else {
        return Ok(UNKNOWN_MAX_VISITS);
    };
    let mut request = row.request;
    let visits = request["recoveryVisits"].as_i64().unwrap_or(0) + 1;
    request["recoveryVisits"] = json!(visits);
    conn.execute(
        "UPDATE memory_stage_attempts SET request_json = ?2 WHERE stage_key = ?1",
        params![stage, request.to_string()],
    )?;
    Ok(visits)
}

/// Reattach every open second turn of the project that ck-mc sent and no
/// run of this process is working on: a recorded reply is resolved without
/// sending again; otherwise the send is made again under its own send id,
/// which the runner answers with the run it already started. No stage
/// keeps its facts in flight for ever: an outcome still unknown after three
/// visits, or a stage nothing can reach for a day, is given up.
///
/// A send that meets an account wait revokes its stage and stops the
/// recovery: every other stage would ask the same runner for the same
/// accounts. The wait is returned.
async fn recover<C: RunnerClient>(
    client: &C,
    db: &ContextDb,
    job: &Job,
) -> Result<Option<AccountWait>, String> {
    let stages: Vec<String> = db
        .with_connection(|conn| {
            conn.prepare_cached(
                "SELECT stage_key FROM memory_stage_attempts
                 WHERE project_path = ?1 AND stage = ?2 AND state IN ('reserved', 'sending', 'replied')
                   AND carrier LIKE 'ck-mc:%'
                 ORDER BY started_at, stage_key",
            )?
            .query_map(params![job.project, STAGE], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|error| error.to_string())?;
    for stage in stages {
        let Some(_working) = Working::claim(&stage) else {
            continue;
        };
        match recover_one(client, db, job, &stage).await {
            Ok(None) => continue,
            Ok(Some(wait)) => return Ok(Some(wait)),
            Err(error) => {
                tracing::warn!("ck-mc: turn two: recovering {stage} failed: {error}");
                let given_up = db
                    .with_connection(|conn| -> rusqlite::Result<bool> {
                        if count_visit(conn, &stage)? >= UNKNOWN_MAX_VISITS {
                            return charge_stage(conn, &stage, "recovery_error", "expired");
                        }
                        Ok(false)
                    })
                    .unwrap_or(false);
                if given_up {
                    tracing::warn!("ck-mc: turn two: gave up {stage} (recovery_error)");
                }
            }
        }
    }
    Ok(None)
}

/// Revoke `stage` for an account wait: its unresolved facts return to
/// `retryable` with no attempt spent, its classification items spend no
/// send, and a later second turn sends them
/// under a new stage, in the child of the summary run that starts it. This
/// child gets nothing more: a run may have begun in it, so a new send would
/// repeat the prompt in its transcript, and a send under this stage's own
/// send id would only reattach to the run the runner already refused.
fn revoke_for_account(db: &ContextDb, stage: &str) -> Result<(), String> {
    db.with_connection(|conn| revoke(conn, stage, true))
        .map(|_| ())
        .map_err(|error| error.to_string())
}

async fn recover_one<C: RunnerClient>(
    client: &C,
    db: &ContextDb,
    job: &Job,
    stage: &str,
) -> Result<Option<AccountWait>, String> {
    let row = db
        .with_connection(|conn| stage_row(conn, stage))
        .map_err(|error| error.to_string())?
        .ok_or("the stage is gone")?;
    let give_up = |reason: &str, state: &str| {
        db.with_connection(|conn| charge_stage(conn, stage, reason, state))
            .map(|given_up| {
                if given_up {
                    tracing::warn!("ck-mc: turn two: gave up {stage} ({reason})");
                }
            })
            .map_err(|error| error.to_string())
    };
    let Some(carrier) = Carrier::from_stage(&row, job.project_root.clone()) else {
        if crate::memory_writes::now_ms() - row.started_at >= UNREACHABLE_MAX_AGE_MS {
            give_up("carrier_unreachable", "expired")?;
        }
        return Ok(None);
    };
    if row.reply.is_none() {
        let prompt = row.request["prompt"].as_str().unwrap_or("").to_owned();
        let system = run::two_pass_system(
            &job.continuation.prompts.system,
            carrier.language.as_deref(),
        );
        match carrier
            .send(client, &carrier.child, stage, &prompt, &system)
            .await
        {
            Ok(reply) => db
                .with_connection(|conn| record_reply(conn, stage, &carrier, &reply))
                .map_err(|error| error.to_string())?,
            Err(SummaryError::AccountWait(wait)) => {
                revoke_for_account(db, stage)?;
                return Ok(Some(wait));
            }
            Err(SummaryError::Failed(error)) => {
                tracing::warn!("ck-mc: turn two: reattaching {stage}: {error}");
                let visits = db
                    .with_connection(|conn| count_visit(conn, stage))
                    .map_err(|error| error.to_string())?;
                if visits >= UNKNOWN_MAX_VISITS {
                    give_up("outcome_unknown", "expired")?;
                }
                return Ok(None);
            }
        }
    }
    let resolver = Resolver {
        client,
        db,
        carrier,
        memory_enabled: job.memory_enabled,
        auto_promote: job.auto_promote,
        authority: job.authority.clone(),
    };
    match resolver.stage(stage).await? {
        Ok(()) => {}
        Err(Stopped::AccountWait(wait)) => {
            revoke_for_account(db, stage)?;
            return Ok(Some(wait));
        }
        Err(Stopped::Unknown) => {
            let visits = db
                .with_connection(|conn| count_visit(conn, stage))
                .map_err(|error| error.to_string())?;
            if visits >= UNKNOWN_MAX_VISITS {
                give_up("check_outcome_unknown", "expired")?;
            }
        }
    }
    Ok(None)
}

/// Run the second turn for the publication the first turn just committed
/// (`runTurnTwo`): recover the project's open sends, then reconcile this
/// publication's candidates and some older ones with the project's
/// memories in the first turn's conversation.
pub async fn run<C: RunnerClient>(client: &C, db: &ContextDb, job: &Job) -> Outcome {
    if !job.memory_enabled {
        return Outcome::Skipped("memory_disabled");
    }
    match recover(client, db, job).await {
        Ok(None) => {}
        // This publication's own send would ask for the same accounts.
        Ok(Some(wait)) => return Outcome::AccountWait(wait),
        Err(error) => tracing::warn!("ck-mc: turn two: recovery failed: {error}"),
    }
    match send(client, db, job).await {
        Ok(outcome) => outcome,
        Err(error) => Outcome::Failed(error),
    }
}

async fn send<C: RunnerClient>(client: &C, db: &ContextDb, job: &Job) -> Result<Outcome, String> {
    let carrier = Carrier::of(job);
    let facts = db
        .with_connection(|conn| select_facts(conn, &job.project, &job.continuation.publication_id))
        .map_err(|error| error.to_string())?;
    // One query embedding per fact, under the provider's current model.
    let mut prompt_facts = BTreeMap::new();
    let mut lexical_only = false;
    for fact in &facts {
        let vector = match &job.embedding {
            Some(provider) => provider.embed_query(&fact.content).await,
            None => None,
        };
        let model = job.embedding.as_ref().map(|provider| provider.model_id());
        let query = vector.as_deref().zip(model.as_deref());
        let (blocks, session, (neighbours, lexical)) = db
            .with_connection(|conn| -> rusqlite::Result<_> {
                Ok((
                    fact_blocks(conn, fact.id)?,
                    publication_session(conn, &fact.publication)?,
                    neighbours(conn, &job.project, &fact.content, query)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        lexical_only |= lexical;
        prompt_facts.insert(
            fact.id,
            PromptFact {
                fact_id: fact.id,
                category: fact.category.clone(),
                content: fact.content.clone(),
                source_session_id: blocks
                    .first()
                    .map_or(session, |(session, _)| session.clone()),
                anchor_known: fact.anchor_known,
                backlog: fact.publication != job.continuation.publication_id,
                blocks: blocks
                    .iter()
                    .map(|(_, block)| PromptBlock {
                        start_ordinal: block.start_ordinal,
                        end_ordinal: block.end_ordinal,
                        role: block.role.clone(),
                        parts: block.parts.clone(),
                    })
                    .collect(),
                neighbours,
            },
        );
    }
    let reserved = db
        .with_connection(|conn| reserve(conn, job, &carrier, &facts, &prompt_facts, lexical_only))
        .map_err(|error| error.to_string())?;
    let Some(reserved) = reserved else {
        return Ok(Outcome::NothingToSend);
    };
    let _working = Working::claim(&reserved.stage);
    db.with_connection(|conn| {
        conn.execute(
            "UPDATE memory_stage_attempts SET state = 'sending' WHERE stage_key = ?1",
            params![reserved.stage],
        )
    })
    .map_err(|error| error.to_string())?;
    let system = run::two_pass_system(
        &job.continuation.prompts.system,
        carrier.language.as_deref(),
    );
    let reply = match carrier
        .send(
            client,
            &carrier.child,
            &reserved.stage,
            &reserved.prompt,
            &system,
        )
        .await
    {
        Ok(reply) => reply,
        Err(SummaryError::Failed(error)) if error == TIMED_OUT => return Ok(Outcome::InFlight),
        Err(SummaryError::AccountWait(wait)) => {
            revoke_for_account(db, &reserved.stage)?;
            return Ok(Outcome::AccountWait(wait));
        }
        Err(SummaryError::Failed(error)) => {
            // A known failure spends an attempt; facts with attempts left retry later.
            db.with_connection(|conn| {
                charge_stage(
                    conn,
                    &reserved.stage,
                    "stage2_transport",
                    "transport_failed",
                )
            })
            .map_err(|error| error.to_string())?;
            return Ok(Outcome::Failed(format!(
                "the second turn failed to send: {error}"
            )));
        }
    };
    db.with_connection(|conn| record_reply(conn, &reserved.stage, &carrier, &reply))
        .map_err(|error| error.to_string())?;
    let resolver = Resolver {
        client,
        db,
        carrier,
        memory_enabled: job.memory_enabled,
        auto_promote: job.auto_promote,
        authority: job.authority.clone(),
    };
    let done = resolver.stage(&reserved.stage).await?;
    if let Err(Stopped::AccountWait(wait)) = done {
        // A fact check met the wait. Facts the reply already resolved stay
        // resolved; the rest go back to retryable with no attempt spent.
        revoke_for_account(db, &reserved.stage)?;
        return Ok(Outcome::AccountWait(wait));
    }
    let reserved_left = db
        .with_connection(|conn| still_reserved(conn, &reserved.stage))
        .map_err(|error| error.to_string())?;
    Ok(if done.is_err() || reserved_left > 0 {
        Outcome::InFlight
    } else {
        Outcome::Resolved
    })
}

#[cfg(test)]
#[path = "turn_two_tests.rs"]
mod tests;
