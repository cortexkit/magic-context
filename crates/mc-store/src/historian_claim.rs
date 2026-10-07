//! The claim lane: historian runs whose model call is made by a host process
//! rather than by this module.
//!
//! A run enters the lane when the module has assembled a chunk and built the
//! prompt but has no producer of its own to send it to. The run is queued, a
//! claimant (the host serving that session) takes it under a lease, and the
//! module accepts exactly one terminal report per claim. Chunking, validation,
//! the publish CAS and the failure taxonomy all stay module-side and are
//! identical whichever side made the call.
//!
//! Two rules make this safe without trusting the claimant:
//!
//! 1. The module mints the attempt number and the token. A claimant never
//!    chooses either, so it cannot forge a newer claim than the one it holds.
//! 2. What a report presents is the token, not an identity. A claimant that
//!    stalled and was replaced still holds a real token, but not the CURRENT
//!    one, so its late report is refused before its output is parsed. Refusing
//!    on identity instead would let a restarted claimant with the same install
//!    identity publish over its own replacement.

use std::sync::atomic::{AtomicU64, Ordering};

use rusqlite::{params, OptionalExtension};
use sha2::{Digest, Sha256};

use crate::{HistorianDurableState, HistorianPhase, McStore, McStoreError, ModuleMeta};

/// The longest a claim may hold a run before another claimant may take it.
///
/// A fold legitimately runs for minutes, so the lease cannot be short. It also
/// cannot be unbounded: a claimant that dies silently would park the run forever.
/// 600 s is the module's own per-run producer await, so a claimant is allowed
/// exactly as long as the module would have waited for its own producer.
pub const HISTORIAN_LEASE_CEILING_MS: i64 = 600_000;

/// How often a live claimant is expected to extend its lease. Two missed beats
/// plus a margin is what turns "slow" into "gone", so a working claimant is never
/// stolen from and a dead one is replaced in about a minute rather than ten.
pub const HISTORIAN_HEARTBEAT_INTERVAL_MS: i64 = 30_000;

/// Queue phase written to `mc_historian_pending_run.phase`.
const PHASE_PENDING: &str = "pending";
const PHASE_CLAIMED: &str = "claimed";
/// A terminal report is stored on the row and is waiting to be published. The run
/// stops being offered and stops being claimable here, so the stored report cannot
/// be superseded by a later claim.
const PHASE_REPORTED: &str = "reported";
/// A run nobody module-side is waiting for any more, because the process that
/// queued it restarted. The row is kept rather than deleted: it still carries the
/// chunk fingerprint and the prompt bytes, which is everything a boot-time
/// re-publication needs. It is never offered to a claimant while parked, and the
/// sweep deletes it once the run's own deadline passes.
const PHASE_PARKED: &str = "parked";

/// The lease a claim gets. A run whose await budget outlives the ceiling is
/// leased for the ceiling, which is what leaves time to re-claim it.
pub fn historian_lease_ms(await_budget_ms: i64) -> i64 {
    await_budget_ms.clamp(1, HISTORIAN_LEASE_CEILING_MS)
}

/// A run queued for a claimant, in the shape `historian.pending` answers with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistorianPendingRun {
    pub run_id: String,
    pub session_id: String,
    pub chunk_fingerprint: String,
    /// UTF-8 bytes of the system prompt plus the user prompt — exactly the two
    /// strings `historian.claim` hands back, so a claimant can size the request
    /// before taking it.
    pub prompt_bytes_len: u64,
    /// When the run itself stops being worth running, not when the current lease
    /// expires. A run past this deadline is never handed out again.
    pub deadline_ms: i64,
}

/// Everything needed to queue one run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewHistorianPendingRun {
    pub run_id: String,
    pub session_id: String,
    pub project_path: String,
    pub firing_seq: u64,
    pub chunk_fingerprint: String,
    pub system_prompt: String,
    pub user_prompt: String,
    pub model_chain: Vec<String>,
    pub await_budget_ms: i64,
    /// The queuing request's own per-attempt timeout: how long the module's lane
    /// would give each model in the chain. Handed to the claimant so every host
    /// attempts the run the same way. `None` when the queuer had none to give.
    pub historian_timeout_ms: Option<i64>,
    pub now_ms: i64,
}

/// What a successful `historian.claim` hands back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistorianClaim {
    pub run_id: String,
    pub session_id: String,
    pub attempt: u32,
    pub token: String,
    pub system_prompt: String,
    pub user_prompt: String,
    pub model_chain: Vec<String>,
    pub await_budget_ms: i64,
    /// Per-attempt timeout the claimant uses for each model, taken from the queuing
    /// request rather than from the claimant's own configuration.
    pub historian_timeout_ms: Option<i64>,
    pub claim_deadline_ms: i64,
}

/// Why a claim was refused. Each maps to one wire code so a claimant can tell
/// "someone beat me to it" from "that run never existed".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistorianClaimRefusal {
    /// No queue row with that id: never queued, already terminal, or expired.
    UnknownRun,
    /// The run exists but is not waiting for a claimant.
    NotPending,
    /// Another claimant holds it and its lease has not run out.
    AlreadyClaimed,
}

impl HistorianClaimRefusal {
    pub fn as_wire_str(self) -> &'static str {
        match self {
            HistorianClaimRefusal::UnknownRun => "unknown_run",
            HistorianClaimRefusal::NotPending => "not_pending",
            HistorianClaimRefusal::AlreadyClaimed => "already_claimed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HistorianClaimOutcome {
    Claimed(Box<HistorianClaim>),
    Refused(HistorianClaimRefusal),
}

/// Why a heartbeat or a terminal report was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistorianReportRefusal {
    UnknownRun,
    /// The run exists but nobody holds it, so no token can be current.
    NotClaimed,
    /// The token was real once, but the claim it belonged to is over: the sender
    /// is describing an attempt that no longer exists.
    SupersededToken,
    /// A terminal report for this run is already stored and waiting to be
    /// published. The module takes exactly one per run.
    AlreadyReported,
    /// The claim is still the current one, but the run itself is past its own
    /// deadline: the module has stopped waiting, so no report can be delivered any
    /// more. It tells a claimant to stop rather than to retry.
    RunExpired,
}

impl HistorianReportRefusal {
    pub fn as_wire_str(self) -> &'static str {
        match self {
            HistorianReportRefusal::UnknownRun => "unknown_run",
            HistorianReportRefusal::NotClaimed => "not_claimed",
            HistorianReportRefusal::SupersededToken => "superseded_token",
            HistorianReportRefusal::AlreadyReported => "already_reported",
            HistorianReportRefusal::RunExpired => "run_expired",
        }
    }
}

/// What a claimant reported, in the shape the queue row stores it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HistorianRunReport {
    /// The completion produced text. `length_capped` means the model stopped at
    /// its output ceiling, so the document may be cut mid-structure.
    Output { text: String, length_capped: bool },
    /// The completion did not happen, in the claimant's own vocabulary.
    Failed { code: String, message: String },
}

/// A run this session parked for a claimant, as the recovery path sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistorianParkedRun {
    pub run_id: String,
    pub attempt: u32,
    /// When the run stops being worth publishing at all.
    pub deadline_ms: i64,
    /// The terminal report a claimant already handed back, if one arrived while
    /// no task in this process was waiting for it.
    pub report: Option<HistorianRunReport>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HistorianRecordOutcome {
    Recorded,
    Refused(HistorianReportRefusal),
}

/// The run identity a verified report is allowed to act on. The caller validates
/// and publishes under exactly this pair.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistorianReportAuthorization {
    pub run_id: String,
    pub session_id: String,
    pub attempt: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HistorianReportOutcome {
    Authorized(HistorianReportAuthorization),
    Refused(HistorianReportRefusal),
}

/// What one sweep did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HistorianSweepOutcome {
    /// Runs whose claimant stopped reporting. Their sessions are parked for
    /// reclaim and the rows are offerable again.
    pub reclaimed: Vec<String>,
    /// Parked rows past the run's own deadline, deleted rather than kept.
    pub dropped: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HistorianHeartbeatOutcome {
    /// The lease now runs until this wall-clock time.
    Extended {
        claim_deadline_ms: i64,
    },
    Refused(HistorianReportRefusal),
}

impl HistorianDurableState {
    /// Drop the claim but keep the run: `run_id`, chunk fingerprint, selected
    /// identities and `firing_seq` all survive, so the next claimant continues the
    /// same run instead of paying to assemble a new chunk. Clearing the token is
    /// what makes the departing claimant's late report refusable.
    pub fn park_for_reclaim(&mut self) {
        self.state = HistorianPhase::Reclaiming;
        self.coordinator_token = None;
        self.claim_deadline_ms = None;
    }

    /// Hand the run to a claimant. The attempt and token are minted by the module
    /// so a claimant cannot present a newer claim than the one it was given.
    pub fn grant_claim(&mut self, attempt: u32, token: String, claim_deadline_ms: i64) {
        self.state = HistorianPhase::AwaitingProducer;
        self.producer_attempt = attempt;
        self.coordinator_token = Some(token);
        self.claim_deadline_ms = Some(claim_deadline_ms);
        // A claim establishes a producer run, so whatever cooldown or failure
        // detail preceded it is resolved — the same rule the in-module producer
        // path applies when its own run starts.
        self.failure_backoff_at_ms = None;
        self.last_failure = None;
    }

    /// Whether the current claim has stopped being current.
    pub fn claim_expired(&self, now_ms: i64) -> bool {
        self.claim_deadline_ms
            .is_some_and(|deadline| deadline <= now_ms)
    }
}

/// Distinguishes tokens minted in the same millisecond for the same run.
static TOKEN_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Mint the secret a claim is identified by.
///
/// `(run_id, attempt)` is already unique, so uniqueness costs nothing here; the
/// hash exists so a claimant that knows a run id cannot derive the token of a
/// claim it does not hold.
fn mint_token(run_id: &str, attempt: u32, claimant_instance_id: &str, now_ms: i64) -> String {
    let sequence = TOKEN_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let mut hasher = Sha256::new();
    hasher.update(run_id.as_bytes());
    hasher.update([0u8]);
    hasher.update(attempt.to_le_bytes());
    hasher.update(claimant_instance_id.as_bytes());
    hasher.update([0u8]);
    hasher.update(now_ms.to_le_bytes());
    hasher.update(sequence.to_le_bytes());
    hasher.update(std::process::id().to_le_bytes());
    let digest = hasher.finalize();
    digest.iter().take(16).map(|b| format!("{b:02x}")).collect()
}

/// Return true when an owned move drain cancels this session's recorded intent.
/// Frozen/staged gates are never terminalization permissions.
fn cancel_for_move(tx: &rusqlite::Transaction<'_>, session: &str) -> rusqlite::Result<bool> {
    let Some(phase) = crate::move_store::phase(tx, session)? else {
        return Ok(false);
    };
    if phase != "draining" {
        return Err(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT_TRIGGER),
            Some("session_moving".into()),
        ));
    }
    tx.execute(
        "DELETE FROM mc_historian_pending_run WHERE session_id = ?1",
        [session],
    )?;
    if let Some((version, mut meta)) = load_meta(tx, session)? {
        if meta.historian.state != HistorianPhase::Idle {
            meta.historian = crate::idle_historian_after_success(&meta.historian);
            meta.historian.last_failure = Some("cancelled for session move".into());
            store_meta(tx, session, version, &meta)?;
        }
    }
    Ok(true)
}

/// Read a session's meta and its row version inside an open transaction.
fn load_meta(
    tx: &rusqlite::Transaction<'_>,
    session_id: &str,
) -> rusqlite::Result<Option<(i64, ModuleMeta)>> {
    let row = tx
        .query_row(
            "SELECT row_version, meta FROM mc_cache_state WHERE session_id = ?1",
            params![session_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    let Some((row_version, meta_json)) = row else {
        return Ok(None);
    };
    match crate::cache_codec::decode_small_meta(&meta_json) {
        Ok(meta) => Ok(Some((row_version, meta))),
        // A meta blob this connection cannot read is not something a claim may
        // repair; report it as "no session" so the caller refuses rather than
        // overwriting a row it did not understand.
        Err(_) => Ok(None),
    }
}

/// Write a session's meta back under the row version it was read at.
fn store_meta(
    tx: &rusqlite::Transaction<'_>,
    session_id: &str,
    current_row_version: i64,
    meta: &ModuleMeta,
) -> rusqlite::Result<u64> {
    let next = current_row_version.max(0) as u64 + 1;
    // Meta-only: the small row's `meta` and nothing else, so a claim or heartbeat never
    // touches `section_index` or the frozen chunks it vouches for.
    let meta_json = crate::cache_codec::encode_small_meta(meta).map_err(|error| {
        rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(error.to_string())))
    })?;
    let affected = tx.execute(
        "UPDATE mc_cache_state SET row_version = ?2, meta = ?3
         WHERE session_id = ?1 AND row_version = ?4",
        params![session_id, next as i64, meta_json, current_row_version],
    )?;
    // This function's signature promises the write landed, and every caller acts on
    // that: it returns the new row version and moves on. Every caller today reads
    // and writes inside one transaction, so the row version cannot move underneath
    // it and this cannot fire. It is checked anyway, because the first caller added
    // outside a transaction would otherwise get a silent no-op that reads exactly
    // like a successful write.
    if affected != 1 {
        return Err(rusqlite::Error::StatementChangedRows(affected));
    }
    crate::advance_row_state_digest_tx(tx, session_id, current_row_version, next as i64)?;
    Ok(next)
}

impl McStore {
    /// Complete cancellation of an already recorded historian intent during a
    /// move drain. No compartments, facts, prompts or cache sections are published.
    pub fn cancel_historian_for_move(&self, session_id: &str) -> Result<(), McStoreError> {
        self.inner
            .with_conn_fenced(|tx| {
                cancel_for_move(tx, session_id)?;
                Ok(())
            })
            .map_err(Into::into)
    }
    /// Queue a fired run for a claimant and park the session on `Reclaiming`.
    ///
    /// Both writes land in one transaction: a queue row whose session is not
    /// parked would be handed to a claimant whose claim could never be admitted,
    /// and a parked session with no queue row would never be claimed at all.
    pub fn publish_pending_historian_run(
        &self,
        run: &NewHistorianPendingRun,
    ) -> Result<u64, McStoreError> {
        let deadline_ms = run.now_ms.saturating_add(run.await_budget_ms.max(0));
        let lease_ms = historian_lease_ms(run.await_budget_ms);
        let model_chain = serde_json::to_string(&run.model_chain)
            .map_err(|error| McStoreError::Serde(error.to_string()))?;
        let outcome = self.inner.with_conn_fenced(|tx| {
            let Some((row_version, mut meta)) = load_meta(tx, &run.session_id)? else {
                return Ok(None);
            };
            if meta.historian.state != HistorianPhase::Firing {
                return Ok(None);
            }
            meta.historian.producer_run_id = Some(run.run_id.clone());
            meta.historian.producer_attempt = 0;
            meta.historian.park_for_reclaim();
            let next = store_meta(tx, &run.session_id, row_version, &meta)?;
            tx.execute(
                "INSERT OR REPLACE INTO mc_historian_pending_run (
                     run_id, session_id, project_path, firing_seq, chunk_fingerprint,
                     phase, attempt, claimant_instance_id, coordinator_token,
                     claim_deadline_ms, lease_ms, deadline_ms, system_prompt, user_prompt,
                     model_chain, await_budget_ms, historian_timeout_ms, created_at_ms,
                     updated_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, NULL, NULL, NULL, ?7, ?8, ?9, ?10, ?11, ?12, ?14, ?13, ?13)",
                params![
                    run.run_id,
                    run.session_id,
                    run.project_path,
                    run.firing_seq as i64,
                    run.chunk_fingerprint,
                    PHASE_PENDING,
                    lease_ms,
                    deadline_ms,
                    run.system_prompt,
                    run.user_prompt,
                    model_chain,
                    run.await_budget_ms,
                    run.now_ms,
                    run.historian_timeout_ms,
                ],
            )?;
            Ok(Some(next))
        })?;
        outcome.ok_or_else(|| {
            McStoreError::Serde(format!(
                "historian run {} cannot be queued: session {} is not firing",
                run.run_id, run.session_id
            ))
        })
    }

    /// Runs waiting for a claimant in one project, newest-queued last.
    ///
    /// `project_path` is the caller's own project, not a filter it chooses: one
    /// store serves every project on the machine, and the prompts a claim hands
    /// back are the folded conversation transcript. A caller only ever sees runs
    /// queued by the project its channel is bound to.
    ///
    /// A run whose own deadline has passed is not offered: taking it would spend a
    /// provider call on output the module has already stopped waiting for. Nor is a
    /// parked one, whose module-side waiter is gone.
    ///
    /// This is a pure read and runs on the plain read path. Polling is the claim
    /// lane's steady state — every claimant asks on an interval — and routing that
    /// through a fenced write transaction would take the store's exclusive write
    /// lock, competing with transform commits, for a query that writes nothing.
    pub fn list_pending_historian_runs(
        &self,
        project_path: &str,
        session_id: Option<&str>,
        now_ms: i64,
    ) -> Result<Vec<HistorianPendingRun>, McStoreError> {
        let rows = self.inner.with_conn(|conn| {
            let mut statement = conn.prepare(
                "SELECT run_id, session_id, chunk_fingerprint,
                        LENGTH(CAST(system_prompt AS BLOB)) + LENGTH(CAST(user_prompt AS BLOB)),
                        deadline_ms, phase, claim_deadline_ms
                   FROM mc_historian_pending_run
                  WHERE project_path = ?1
                    AND (?2 IS NULL OR session_id = ?2)
                    AND deadline_ms > ?3
                    AND NOT EXISTS(SELECT 1 FROM mc_move_fences f
                                   WHERE f.session_id = mc_historian_pending_run.session_id)
                  ORDER BY created_at_ms ASC, run_id ASC",
            )?;
            let mapped = statement
                .query_map(params![project_path, session_id, now_ms], |row| {
                    Ok((
                        HistorianPendingRun {
                            run_id: row.get(0)?,
                            session_id: row.get(1)?,
                            chunk_fingerprint: row.get(2)?,
                            prompt_bytes_len: row.get::<_, i64>(3)?.max(0) as u64,
                            deadline_ms: row.get(4)?,
                        },
                        row.get::<_, String>(5)?,
                        row.get::<_, Option<i64>>(6)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(mapped)
        })?;
        Ok(rows
            .into_iter()
            .filter(|(_, phase, claim_deadline_ms)| is_claimable(phase, *claim_deadline_ms, now_ms))
            .map(|(run, _, _)| run)
            .collect())
    }

    /// Take a queued run under a fresh attempt and token.
    ///
    /// The queue row and the session's phase move together so a claimant that is
    /// told it won always finds the session ready to accept its report.
    ///
    /// `project_path` is the caller's own project. A run belonging to another
    /// project is answered exactly as a run that does not exist: the prompts handed
    /// back are a conversation transcript, so a caller must not even learn that
    /// another project on this machine has a run outstanding.
    pub fn claim_historian_run(
        &self,
        project_path: &str,
        run_id: &str,
        claimant_instance_id: &str,
        now_ms: i64,
    ) -> Result<HistorianClaimOutcome, McStoreError> {
        let outcome = self.inner.with_conn_fenced(|tx| {
            let row = tx
                .query_row(
                    "SELECT session_id, phase, attempt, claim_deadline_ms, lease_ms,
                            deadline_ms, system_prompt, user_prompt, model_chain, await_budget_ms,
                            historian_timeout_ms
                       FROM mc_historian_pending_run
                      WHERE run_id = ?1 AND project_path = ?2",
                    params![run_id, project_path],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, Option<i64>>(3)?,
                            row.get::<_, i64>(4)?,
                            row.get::<_, i64>(5)?,
                            row.get::<_, String>(6)?,
                            row.get::<_, String>(7)?,
                            row.get::<_, String>(8)?,
                            row.get::<_, i64>(9)?,
                            row.get::<_, Option<i64>>(10)?,
                        ))
                    },
                )
                .optional()?;
            let Some((
                session_id,
                phase,
                attempt,
                claim_deadline_ms,
                lease_ms,
                deadline_ms,
                system_prompt,
                user_prompt,
                model_chain,
                await_budget_ms,
                historian_timeout_ms,
            )) = row
            else {
                return Ok(HistorianClaimOutcome::Refused(
                    HistorianClaimRefusal::UnknownRun,
                ));
            };
            if deadline_ms <= now_ms {
                return Ok(HistorianClaimOutcome::Refused(
                    HistorianClaimRefusal::NotPending,
                ));
            }
            if !is_claimable(&phase, claim_deadline_ms, now_ms) {
                return Ok(HistorianClaimOutcome::Refused(if phase == PHASE_CLAIMED {
                    HistorianClaimRefusal::AlreadyClaimed
                } else {
                    HistorianClaimRefusal::NotPending
                }));
            }

            let Some((row_version, mut meta)) = load_meta(tx, &session_id)? else {
                return Ok(HistorianClaimOutcome::Refused(
                    HistorianClaimRefusal::UnknownRun,
                ));
            };
            if meta.historian.producer_run_id.as_deref() != Some(run_id) {
                return Ok(HistorianClaimOutcome::Refused(
                    HistorianClaimRefusal::NotPending,
                ));
            }
            // AwaitingProducer -> Reclaiming. A claimant can arrive before the sweep
            // that would otherwise park the session, so the expiry transition runs
            // here too rather than making the claimant wait for a sweep to notice.
            // It keeps run_id, chunk fingerprint and firing_seq and drops only the
            // claim, which is what lets the replacement continue the same run.
            if meta.historian.state == HistorianPhase::AwaitingProducer
                && meta.historian.claim_expired(now_ms)
            {
                meta.historian.park_for_reclaim();
            }
            // Any phase other than the parked one means the run moved on (published,
            // abandoned, or refired) since the queue row was written, so the row is
            // stale rather than claimable.
            if meta.historian.state != HistorianPhase::Reclaiming {
                return Ok(HistorianClaimOutcome::Refused(
                    HistorianClaimRefusal::NotPending,
                ));
            }

            let next_attempt = (attempt.max(0) as u32).saturating_add(1);
            let token = mint_token(run_id, next_attempt, claimant_instance_id, now_ms);
            let claim_deadline_ms = now_ms.saturating_add(lease_ms).min(deadline_ms);

            meta.historian
                .grant_claim(next_attempt, token.clone(), claim_deadline_ms);
            store_meta(tx, &session_id, row_version, &meta)?;

            tx.execute(
                "UPDATE mc_historian_pending_run
                    SET phase = ?2, attempt = ?3, claimant_instance_id = ?4,
                        coordinator_token = ?5, claim_deadline_ms = ?6, updated_at_ms = ?7
                  WHERE run_id = ?1",
                params![
                    run_id,
                    PHASE_CLAIMED,
                    next_attempt as i64,
                    claimant_instance_id,
                    token,
                    claim_deadline_ms,
                    now_ms,
                ],
            )?;

            let model_chain: Vec<String> = serde_json::from_str(&model_chain).unwrap_or_default();
            Ok(HistorianClaimOutcome::Claimed(Box::new(HistorianClaim {
                run_id: run_id.to_string(),
                session_id,
                attempt: next_attempt,
                token,
                system_prompt,
                user_prompt,
                model_chain,
                await_budget_ms,
                historian_timeout_ms,
                claim_deadline_ms,
            })))
        })?;
        Ok(outcome)
    }

    /// Extend the current claim's lease. Only the holder of the current token can,
    /// and only while the run itself is still worth finishing.
    ///
    /// Past the run's own deadline the lease cannot be extended at all — the cap is
    /// the deadline — so answering "extended" there would hand back a lease already
    /// in the past. `pending` has stopped offering the run and `claim` refuses it by
    /// then, which would leave the heartbeat as the one op still telling a claimant
    /// to keep paying a provider for a completion nothing can accept.
    pub fn heartbeat_historian_run(
        &self,
        project_path: &str,
        run_id: &str,
        token: &str,
        now_ms: i64,
    ) -> Result<HistorianHeartbeatOutcome, McStoreError> {
        let outcome = self.inner.with_conn_fenced(|tx| {
            let Some(claim) = read_claim(tx, project_path, run_id)? else {
                return Ok(HistorianHeartbeatOutcome::Refused(
                    HistorianReportRefusal::UnknownRun,
                ));
            };
            let session_id = claim.session_id;
            let Some(stored_token) = claim.coordinator_token else {
                return Ok(HistorianHeartbeatOutcome::Refused(
                    HistorianReportRefusal::NotClaimed,
                ));
            };
            if stored_token != token {
                return Ok(HistorianHeartbeatOutcome::Refused(
                    HistorianReportRefusal::SupersededToken,
                ));
            }
            if now_ms >= claim.deadline_ms {
                return Ok(HistorianHeartbeatOutcome::Refused(
                    HistorianReportRefusal::RunExpired,
                ));
            }
            if cancel_for_move(tx, &session_id)? {
                return Ok(HistorianHeartbeatOutcome::Refused(
                    HistorianReportRefusal::RunExpired,
                ));
            }
            let claim_deadline_ms = now_ms.saturating_add(claim.lease_ms).min(claim.deadline_ms);
            tx.execute(
                "UPDATE mc_historian_pending_run
                    SET claim_deadline_ms = ?2, updated_at_ms = ?3
                  WHERE run_id = ?1",
                params![run_id, claim_deadline_ms, now_ms],
            )?;
            if let Some((row_version, mut meta)) = load_meta(tx, &session_id)? {
                if meta.historian.coordinator_token.as_deref() == Some(token) {
                    meta.historian.claim_deadline_ms = Some(claim_deadline_ms);
                    store_meta(tx, &session_id, row_version, &meta)?;
                }
            }
            Ok(HistorianHeartbeatOutcome::Extended { claim_deadline_ms })
        })?;
        Ok(outcome)
    }

    /// Check that a terminal report belongs to the current claim.
    ///
    /// The phase is deliberately left alone here. A report still has to pass
    /// validation and the publish CAS, both of which own their own transitions;
    /// advancing the phase on arrival would make a rejected report look published.
    pub fn authorize_historian_report(
        &self,
        project_path: &str,
        run_id: &str,
        token: &str,
    ) -> Result<HistorianReportOutcome, McStoreError> {
        let outcome = self.inner.with_conn_fenced(|tx| {
            let Some(claim) = read_claim(tx, project_path, run_id)? else {
                return Ok(HistorianReportOutcome::Refused(
                    HistorianReportRefusal::UnknownRun,
                ));
            };
            let session_id = claim.session_id;
            let Some(stored_token) = claim.coordinator_token else {
                return Ok(HistorianReportOutcome::Refused(
                    HistorianReportRefusal::NotClaimed,
                ));
            };
            if stored_token != token {
                return Ok(HistorianReportOutcome::Refused(
                    HistorianReportRefusal::SupersededToken,
                ));
            }
            let Some((_row_version, meta)) = load_meta(tx, &session_id)? else {
                return Ok(HistorianReportOutcome::Refused(
                    HistorianReportRefusal::UnknownRun,
                ));
            };
            // The queue row and the session state are written together, so a
            // disagreement between them means this report raced a transition that
            // has already superseded its claim.
            if meta.historian.coordinator_token.as_deref() != Some(token)
                || meta.historian.producer_run_id.as_deref() != Some(run_id)
            {
                return Ok(HistorianReportOutcome::Refused(
                    HistorianReportRefusal::SupersededToken,
                ));
            }
            Ok(HistorianReportOutcome::Authorized(
                HistorianReportAuthorization {
                    run_id: run_id.to_string(),
                    session_id,
                    attempt: meta.historian.producer_attempt,
                },
            ))
        })?;
        Ok(outcome)
    }

    /// Store a claimant's terminal report on the queue row so a task that is not
    /// in this process can publish it later.
    ///
    /// This is the durable half of `historian.complete`. It exists because a fold
    /// legitimately runs for minutes and the module can be restarted inside that
    /// window: the firing task that queued the run is then gone, and without a
    /// place to put the answer the provider call the host already paid for would
    /// be discarded. The report is picked up by the next transform pass for the
    /// session, which validates and publishes it through exactly the same code an
    /// in-process report goes through.
    ///
    /// The token is re-checked inside this transaction rather than trusted from an
    /// earlier read: between authorizing a report and storing it the lease can
    /// lapse and the run can be handed to somebody else, and a report from the
    /// claim that was replaced must not land.
    ///
    /// `project_path` is the caller's own project, for the same reason the four ops
    /// around it take one: this is a write reached from the claim lane, and a
    /// caller must not be able to leave a document on a run belonging to another
    /// project on this machine. A run in another project answers `unknown_run`,
    /// the same answer as a run that does not exist.
    pub fn record_historian_report(
        &self,
        project_path: &str,
        run_id: &str,
        token: &str,
        report: &HistorianRunReport,
        now_ms: i64,
    ) -> Result<HistorianRecordOutcome, McStoreError> {
        let outcome = self.inner.with_conn_fenced(|tx| {
            let row = tx
                .query_row(
                    "SELECT coordinator_token, report_kind, deadline_ms, session_id
                       FROM mc_historian_pending_run
                      WHERE run_id = ?1 AND project_path = ?2",
                    params![run_id, project_path],
                    |row| {
                        Ok((
                            row.get::<_, Option<String>>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, String>(3)?,
                        ))
                    },
                )
                .optional()?;
            let Some((stored_token, existing_report, deadline_ms, session_id)) = row else {
                return Ok(HistorianRecordOutcome::Refused(
                    HistorianReportRefusal::UnknownRun,
                ));
            };
            if existing_report.is_some() {
                return Ok(HistorianRecordOutcome::Refused(
                    HistorianReportRefusal::AlreadyReported,
                ));
            }
            let Some(stored_token) = stored_token else {
                return Ok(HistorianRecordOutcome::Refused(
                    HistorianReportRefusal::NotClaimed,
                ));
            };
            if stored_token != token {
                return Ok(HistorianRecordOutcome::Refused(
                    HistorianReportRefusal::SupersededToken,
                ));
            }
            // A run whose own deadline has passed is not worth storing an answer
            // for: the module stopped waiting for it, and the next pass would only
            // release it. The refusal is the same one a heartbeat past the deadline
            // gets, because it means the same thing and asks for the same response:
            // the run is over, stop rather than take the next one.
            if deadline_ms <= now_ms {
                return Ok(HistorianRecordOutcome::Refused(
                    HistorianReportRefusal::RunExpired,
                ));
            }
            if cancel_for_move(tx, &session_id)? {
                return Ok(HistorianRecordOutcome::Refused(
                    HistorianReportRefusal::RunExpired,
                ));
            }
            let (kind, text, length_capped, code, message) = match report {
                HistorianRunReport::Output {
                    text,
                    length_capped,
                } => (
                    "output",
                    Some(text.as_str()),
                    Some(i64::from(*length_capped)),
                    None,
                    None,
                ),
                HistorianRunReport::Failed { code, message } => (
                    "error",
                    None,
                    None,
                    Some(code.as_str()),
                    Some(message.as_str()),
                ),
            };
            tx.execute(
                "UPDATE mc_historian_pending_run
                    SET phase = ?2, report_kind = ?3, report_text = ?4,
                        report_length_capped = ?5, report_error_code = ?6,
                        report_error_message = ?7, reported_at_ms = ?8, updated_at_ms = ?8
                  WHERE run_id = ?1",
                params![
                    run_id,
                    PHASE_REPORTED,
                    kind,
                    text,
                    length_capped,
                    code,
                    message,
                    now_ms,
                ],
            )?;
            Ok(HistorianRecordOutcome::Recorded)
        })?;
        Ok(outcome)
    }

    /// Put a run that outlived this process back on offer.
    ///
    /// Called by the restart path for a run whose claimant is still out. The row
    /// survived, so nothing is minted here — the same `run_id`, the same chunk
    /// fingerprint and the same firing sequence go back on offer, which is what
    /// makes a re-claim cost one completion instead of a re-assembled chunk.
    ///
    /// It is a no-op for a row that is already on offer or already claimed, and it
    /// refuses to revive a row that carries a report or has outlived its deadline:
    /// both of those are answers, and re-offering them would buy a second
    /// completion for a question that is already settled.
    pub fn republish_parked_historian_run(
        &self,
        run_id: &str,
        now_ms: i64,
    ) -> Result<bool, McStoreError> {
        let republished = self.inner.with_conn_fenced(|tx| {
            let row = tx
                .query_row(
                    "SELECT phase, report_kind, deadline_ms, claim_deadline_ms
                       FROM mc_historian_pending_run WHERE run_id = ?1",
                    params![run_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, Option<i64>>(3)?,
                        ))
                    },
                )
                .optional()?;
            let Some((phase, report, deadline_ms, claim_deadline_ms)) = row else {
                return Ok(false);
            };
            if report.is_some() || deadline_ms <= now_ms {
                return Ok(false);
            }
            if is_claimable(&phase, claim_deadline_ms, now_ms) || phase == PHASE_CLAIMED {
                return Ok(false);
            }
            tx.execute(
                "UPDATE mc_historian_pending_run
                    SET phase = ?2, claimant_instance_id = NULL, coordinator_token = NULL,
                        claim_deadline_ms = NULL, updated_at_ms = ?3
                  WHERE run_id = ?1",
                params![run_id, PHASE_PENDING, now_ms],
            )?;
            Ok(true)
        })?;
        Ok(republished)
    }

    /// The run a session is currently parked on, if it has one.
    ///
    /// Answers the question the restart path asks: this session is not idle and no
    /// task in this process owns it — is there a queued run behind that, and did
    /// its claimant already answer?
    pub fn load_parked_historian_run(
        &self,
        session_id: &str,
    ) -> Result<Option<HistorianParkedRun>, McStoreError> {
        let parked = self.inner.with_conn_fenced(|tx| {
            let Some((_row_version, meta)) = load_meta(tx, session_id)? else {
                return Ok(None);
            };
            let Some(run_id) = meta.historian.producer_run_id.clone() else {
                return Ok(None);
            };
            tx.query_row(
                "SELECT attempt, deadline_ms, report_kind, report_text,
                        report_length_capped, report_error_code, report_error_message
                   FROM mc_historian_pending_run WHERE run_id = ?1 AND session_id = ?2",
                params![run_id, session_id],
                |row| {
                    let kind: Option<String> = row.get(2)?;
                    let report = match kind.as_deref() {
                        Some("output") => Some(HistorianRunReport::Output {
                            text: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                            length_capped: row.get::<_, Option<i64>>(4)?.unwrap_or(0) != 0,
                        }),
                        Some("error") => Some(HistorianRunReport::Failed {
                            code: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                            message: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
                        }),
                        _ => None,
                    };
                    Ok(HistorianParkedRun {
                        run_id: run_id.clone(),
                        attempt: row.get::<_, i64>(0)?.max(0) as u32,
                        deadline_ms: row.get(1)?,
                        report,
                    })
                },
            )
            .optional()
        })?;
        Ok(parked)
    }

    /// Drop a queue row on any terminal outcome. Terminal runs are removed rather
    /// than marked so the queue stays the size of the work actually outstanding.
    pub fn finish_historian_pending_run(&self, run_id: &str) -> Result<bool, McStoreError> {
        let removed = self.inner.with_conn_fenced(|tx| {
            tx.execute(
                "DELETE FROM mc_historian_pending_run WHERE run_id = ?1",
                params![run_id],
            )
        })?;
        Ok(removed > 0)
    }

    /// Stop offering a run without losing it, because the process that was waiting
    /// for its report is gone.
    ///
    /// Called on restart recovery, where the session is being released: the run has
    /// no module-side waiter any more, so a claimant that took it would produce a
    /// completion nothing could accept. The row keeps its chunk fingerprint and its
    /// prompt bytes so a boot-time re-publication can adopt it instead of paying to
    /// assemble the chunk again; the sweep deletes it if nothing does.
    pub fn park_historian_pending_run(
        &self,
        run_id: &str,
        now_ms: i64,
    ) -> Result<bool, McStoreError> {
        let parked = self.inner.with_conn_fenced(|tx| {
            tx.execute(
                "UPDATE mc_historian_pending_run
                    SET phase = ?2, claimant_instance_id = NULL, coordinator_token = NULL,
                        claim_deadline_ms = NULL, updated_at_ms = ?3
                  WHERE run_id = ?1",
                params![run_id, PHASE_PARKED, now_ms],
            )
        })?;
        Ok(parked > 0)
    }

    /// Stop offering a run that nobody is actively working on, for as long as the
    /// process that owns it is re-establishing the state behind it.
    ///
    /// This is the restart path's park, narrowed to the rows it is safe to take a
    /// claim away from. A row a claimant is still holding is left exactly as it is:
    /// that claimant is heartbeating against this row and paying a provider for the
    /// completion right now, and clearing its token would make its report
    /// unpublishable for nothing. A row carrying a report is left alone for the
    /// same reason — the answer is already here.
    ///
    /// Returns whether a row moved, so the caller can say which of the two it did.
    pub fn park_unclaimed_historian_run(
        &self,
        run_id: &str,
        now_ms: i64,
    ) -> Result<bool, McStoreError> {
        let parked = self.inner.with_conn_fenced(|tx| {
            tx.execute(
                "UPDATE mc_historian_pending_run
                    SET phase = ?2, claimant_instance_id = NULL, coordinator_token = NULL,
                        claim_deadline_ms = NULL, updated_at_ms = ?3
                  WHERE run_id = ?1
                    AND report_kind IS NULL
                    AND (phase <> ?4 OR claim_deadline_ms IS NULL OR claim_deadline_ms <= ?3)",
                params![run_id, PHASE_PARKED, now_ms, PHASE_CLAIMED],
            )
        })?;
        Ok(parked > 0)
    }

    /// Return every run whose claimant stopped reporting to the queue, and park
    /// its session so the next claimant continues the same run. Parked rows whose
    /// run is past its own deadline are deleted in the same pass.
    ///
    /// A reclaimed run keeps its `run_id`, its chunk and its firing sequence: only
    /// the claim is dropped. That is what makes a re-claim cheap — the replacement
    /// claimant pays for one completion, not for re-assembling the chunk.
    pub fn expire_historian_claims(
        &self,
        now_ms: i64,
    ) -> Result<HistorianSweepOutcome, McStoreError> {
        let expired = self.inner.with_conn_fenced(|tx| {
            let mut statement = tx.prepare(
                "SELECT run_id, session_id FROM mc_historian_pending_run
                   WHERE phase = ?1 AND claim_deadline_ms IS NOT NULL AND claim_deadline_ms <= ?2
                     AND NOT EXISTS(SELECT 1 FROM mc_move_fences f
                                    WHERE f.session_id = mc_historian_pending_run.session_id)",
            )?;
            let rows = statement
                .query_map(params![PHASE_CLAIMED, now_ms], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            drop(statement);

            let mut reclaimed = Vec::new();
            for (run_id, session_id) in rows {
                tx.execute(
                    "UPDATE mc_historian_pending_run
                        SET phase = ?2, claimant_instance_id = NULL, coordinator_token = NULL,
                            claim_deadline_ms = NULL, updated_at_ms = ?3
                      WHERE run_id = ?1",
                    params![run_id, PHASE_PENDING, now_ms],
                )?;
                if let Some((row_version, mut meta)) = load_meta(tx, &session_id)? {
                    if meta.historian.state == HistorianPhase::AwaitingProducer
                        && meta.historian.producer_run_id.as_deref() == Some(run_id.as_str())
                    {
                        meta.historian.park_for_reclaim();
                        store_meta(tx, &session_id, row_version, &meta)?;
                    }
                }
                reclaimed.push(run_id);
            }

            // A parked run past its own deadline is the end of the line: nobody is
            // waiting for it module-side and re-publishing it would queue work whose
            // deadline has already passed. Dropping it here is what keeps the queue
            // the size of the work actually outstanding across restarts.
            let mut statement = tx.prepare(
                "SELECT run_id FROM mc_historian_pending_run
                   WHERE phase = ?1 AND deadline_ms <= ?2
                     AND NOT EXISTS(SELECT 1 FROM mc_move_fences f
                                    WHERE f.session_id = mc_historian_pending_run.session_id)",
            )?;
            let dropped = statement
                .query_map(params![PHASE_PARKED, now_ms], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            drop(statement);
            for run_id in &dropped {
                tx.execute(
                    "DELETE FROM mc_historian_pending_run WHERE run_id = ?1",
                    params![run_id],
                )?;
            }

            Ok(HistorianSweepOutcome { reclaimed, dropped })
        })?;
        Ok(expired)
    }

    /// The durable historian state for one session, for tests and diagnostics.
    pub fn historian_state(&self, session_id: &str) -> Result<HistorianDurableState, McStoreError> {
        Ok(self.load_meta(session_id)?.meta.historian)
    }
}

/// The claim-bearing columns of one queue row.
struct StoredClaim {
    session_id: String,
    /// Absent while no claimant holds the run.
    coordinator_token: Option<String>,
    lease_ms: i64,
    /// When the run itself expires, which caps every lease granted on it.
    deadline_ms: i64,
}

/// Read one queue row, scoped to the caller's project: a run belonging to another
/// project reads as absent rather than as refused, so nothing about it leaks.
fn read_claim(
    tx: &rusqlite::Transaction<'_>,
    project_path: &str,
    run_id: &str,
) -> rusqlite::Result<Option<StoredClaim>> {
    tx.query_row(
        "SELECT session_id, coordinator_token, lease_ms, deadline_ms
           FROM mc_historian_pending_run WHERE run_id = ?1 AND project_path = ?2",
        params![run_id, project_path],
        |row| {
            Ok(StoredClaim {
                session_id: row.get(0)?,
                coordinator_token: row.get(1)?,
                lease_ms: row.get(2)?,
                deadline_ms: row.get(3)?,
            })
        },
    )
    .optional()
}

/// A run is claimable when nobody holds it, or when whoever held it stopped
/// extending the lease. The expired-lease case is checked here rather than only
/// in the sweep so a claimant that arrives before the sweep runs is not told the
/// run is busy when it is in fact abandoned. A parked run is not claimable in any
/// case: its module-side waiter is gone, so a completion for it has nowhere to go.
fn is_claimable(phase: &str, claim_deadline_ms: Option<i64>, now_ms: i64) -> bool {
    match phase {
        PHASE_PENDING => true,
        PHASE_CLAIMED => claim_deadline_ms.is_some_and(|deadline| deadline <= now_ms),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CoreState, ModuleMeta};
    use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};

    const AWAIT_BUDGET_MS: i64 = 660_000;
    /// The project every run in these tests is queued under, and the one a caller
    /// has to present to see it.
    const PROJECT: &str = "git:proj";

    fn open_store(dir: &std::path::Path) -> McStore {
        McStore::open_for_test(&StorageDescriptor {
            module_id: "magic-context-test".to_string(),
            storage_namespace: "mc_cache".to_string(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: dir.join("store.db").to_string_lossy().to_string(),
            },
        })
        .unwrap()
    }

    /// Seed a session in the phase a firing reaches just before its completion
    /// runs, then queue that run for a claimant under a named project.
    fn queue_run_for_project(
        store: &McStore,
        run_id: &str,
        session_id: &str,
        project_path: &str,
        now_ms: i64,
    ) {
        let loaded = store.load(session_id).unwrap();
        let mut meta = ModuleMeta::default();
        meta.historian.state = HistorianPhase::Firing;
        meta.historian.firing_seq = 1;
        meta.historian.chunk_fingerprint = "fp".to_string();
        store
            .commit(session_id, loaded.row_version, &CoreState::default(), &meta)
            .unwrap();
        store
            .publish_pending_historian_run(&NewHistorianPendingRun {
                run_id: run_id.to_string(),
                session_id: session_id.to_string(),
                project_path: project_path.to_string(),
                firing_seq: 1,
                chunk_fingerprint: "fp".to_string(),
                system_prompt: "sys".to_string(),
                user_prompt: "user".to_string(),
                model_chain: vec!["test/model".to_string()],
                await_budget_ms: AWAIT_BUDGET_MS,
                historian_timeout_ms: None,
                now_ms,
            })
            .unwrap();
    }

    /// Seed a session in the phase a firing reaches just before its completion
    /// runs, then queue that run for a claimant.
    fn queue_run(store: &McStore, run_id: &str, session_id: &str, now_ms: i64) {
        let loaded = store.load(session_id).unwrap();
        let mut meta = ModuleMeta::default();
        meta.historian.state = HistorianPhase::Firing;
        meta.historian.firing_seq = 1;
        meta.historian.chunk_fingerprint = "fp".to_string();
        store
            .commit(session_id, loaded.row_version, &CoreState::default(), &meta)
            .unwrap();
        store
            .publish_pending_historian_run(&NewHistorianPendingRun {
                run_id: run_id.to_string(),
                session_id: session_id.to_string(),
                project_path: PROJECT.to_string(),
                firing_seq: 1,
                chunk_fingerprint: "fp".to_string(),
                system_prompt: "sys".to_string(),
                user_prompt: "user".to_string(),
                model_chain: vec!["test/model".to_string()],
                await_budget_ms: AWAIT_BUDGET_MS,
                historian_timeout_ms: None,
                now_ms,
            })
            .unwrap();
    }

    #[test]
    fn queueing_a_run_parks_the_session_and_offers_it() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(dir.path());
        queue_run(&store, "run-1", "ses", 1_000);

        let state = store.historian_state("ses").unwrap();
        assert_eq!(state.state, HistorianPhase::Reclaiming);
        assert_eq!(state.producer_run_id.as_deref(), Some("run-1"));
        assert_eq!(state.coordinator_token, None);

        let pending = store
            .list_pending_historian_runs(PROJECT, None, 2_000)
            .unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].run_id, "run-1");
        assert_eq!(pending[0].session_id, "ses");
        assert_eq!(pending[0].deadline_ms, 1_000 + AWAIT_BUDGET_MS);
        assert_eq!(
            pending[0].prompt_bytes_len,
            "sys".len() as u64 + "user".len() as u64
        );
    }

    /// Claim `run_id` and hand back the token the module minted for it.
    fn claim_token(store: &McStore, run_id: &str, claimant: &str, now_ms: i64) -> String {
        match store
            .claim_historian_run(PROJECT, run_id, claimant, now_ms)
            .unwrap()
        {
            HistorianClaimOutcome::Claimed(claim) => claim.token,
            other => panic!("expected a claim, got {other:?}"),
        }
    }

    #[test]
    fn a_report_with_nowhere_to_go_is_kept_on_the_run_for_the_next_pass() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(dir.path());
        queue_run(&store, "run-1", "ses", 1_000);
        let token = claim_token(&store, "run-1", "install-one", 1_000);

        assert_eq!(
            store
                .record_historian_report(
                    PROJECT,
                    "run-1",
                    &token,
                    &HistorianRunReport::Output {
                        text: "<compartments/>".to_string(),
                        length_capped: false,
                    },
                    2_000,
                )
                .unwrap(),
            HistorianRecordOutcome::Recorded
        );

        let parked = store
            .load_parked_historian_run("ses")
            .unwrap()
            .expect("the parked run survives to carry its report");
        assert_eq!(parked.run_id, "run-1");
        assert_eq!(parked.attempt, 1);
        assert_eq!(
            parked.report,
            Some(HistorianRunReport::Output {
                text: "<compartments/>".to_string(),
                length_capped: false,
            })
        );
        // The session is left exactly where the claim put it, because publishing is
        // still ahead: validation and the publish CAS own those transitions.
        assert_eq!(
            store.historian_state("ses").unwrap().state,
            HistorianPhase::AwaitingProducer
        );
    }

    #[test]
    fn a_stored_report_takes_the_run_out_of_the_queue_for_everyone_else() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(dir.path());
        queue_run(&store, "run-1", "ses", 1_000);
        let token = claim_token(&store, "run-1", "install-one", 1_000);
        store
            .record_historian_report(
                PROJECT,
                "run-1",
                &token,
                &HistorianRunReport::Failed {
                    code: "chain_exhausted".to_string(),
                    message: "every configured model refused".to_string(),
                },
                2_000,
            )
            .unwrap();

        // Long past the lease, which would otherwise make the run stealable.
        let after_lease = 1_000 + HISTORIAN_LEASE_CEILING_MS + 1;
        assert!(store
            .list_pending_historian_runs(PROJECT, None, after_lease)
            .unwrap()
            .is_empty());
        assert_eq!(
            store
                .claim_historian_run(PROJECT, "run-1", "install-two", after_lease)
                .unwrap(),
            HistorianClaimOutcome::Refused(HistorianClaimRefusal::NotPending)
        );
        assert_eq!(
            store.expire_historian_claims(after_lease).unwrap(),
            HistorianSweepOutcome::default(),
            "a reported run is out of the sweep's reach too: neither reclaimed nor dropped"
        );
        assert_eq!(
            store
                .load_parked_historian_run("ses")
                .unwrap()
                .and_then(|parked| parked.report),
            Some(HistorianRunReport::Failed {
                code: "chain_exhausted".to_string(),
                message: "every configured model refused".to_string(),
            }),
            "the stored report cannot be superseded by a later claim"
        );
    }

    #[test]
    fn only_the_current_claim_may_leave_a_report_and_only_once() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(dir.path());
        queue_run(&store, "run-1", "ses", 1_000);
        let first = claim_token(&store, "run-1", "install-one", 1_000);
        let report = HistorianRunReport::Output {
            text: "<compartments/>".to_string(),
            length_capped: false,
        };

        // The lease lapses and a second claimant takes the run.
        let after_lease = 1_000 + HISTORIAN_LEASE_CEILING_MS + 1;
        let second = claim_token(&store, "run-1", "install-two", after_lease);
        assert_ne!(first, second);
        assert_eq!(
            store
                .record_historian_report(PROJECT, "run-1", &first, &report, after_lease + 1)
                .unwrap(),
            HistorianRecordOutcome::Refused(HistorianReportRefusal::SupersededToken),
            "the replaced claimant's late report must not land"
        );

        assert_eq!(
            store
                .record_historian_report(PROJECT, "run-1", &second, &report, after_lease + 1)
                .unwrap(),
            HistorianRecordOutcome::Recorded
        );
        assert_eq!(
            store
                .record_historian_report(PROJECT, "run-1", &second, &report, after_lease + 2)
                .unwrap(),
            HistorianRecordOutcome::Refused(HistorianReportRefusal::AlreadyReported)
        );
    }

    #[test]
    fn a_report_for_a_run_whose_deadline_passed_is_not_stored() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(dir.path());
        queue_run(&store, "run-1", "ses", 1_000);
        let token = claim_token(&store, "run-1", "install-one", 1_000);
        let after_deadline = 1_000 + AWAIT_BUDGET_MS + 1;

        assert_eq!(
            store
                .record_historian_report(
                    PROJECT,
                    "run-1",
                    &token,
                    &HistorianRunReport::Output {
                        text: "<compartments/>".to_string(),
                        length_capped: false,
                    },
                    after_deadline,
                )
                .unwrap(),
            HistorianRecordOutcome::Refused(HistorianReportRefusal::RunExpired),
            "the module stopped waiting for this run, so there is nothing to publish into, and \
             the refusal has to say the run expired rather than that it never existed"
        );
        assert_eq!(
            store
                .load_parked_historian_run("ses")
                .unwrap()
                .and_then(|parked| parked.report),
            None
        );
    }

    #[test]
    fn a_run_taken_out_of_the_queue_by_a_restart_goes_back_on_offer_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(dir.path());
        queue_run(&store, "run-1", "ses", 1_000);
        // Parked through the call the restart path itself makes, so this is driven by
        // the writer rather than by a hand-written phase value that could drift from
        // it.
        assert!(store.park_historian_pending_run("run-1", 1_500).unwrap());
        assert!(
            store
                .list_pending_historian_runs(PROJECT, None, 2_000)
                .unwrap()
                .is_empty(),
            "a parked row is not on offer"
        );

        assert!(store
            .republish_parked_historian_run("run-1", 2_000)
            .unwrap());
        let offered = store
            .list_pending_historian_runs(PROJECT, None, 2_000)
            .unwrap();
        assert_eq!(offered.len(), 1);
        assert_eq!(offered[0].run_id, "run-1");
        assert_eq!(
            offered[0].chunk_fingerprint, "fp",
            "the same run keeps the chunk it already owns"
        );
        assert_eq!(offered[0].deadline_ms, 1_000 + AWAIT_BUDGET_MS);

        // Idempotent: a row that is already on offer is left exactly as it is.
        assert!(!store
            .republish_parked_historian_run("run-1", 2_000)
            .unwrap());
    }

    #[test]
    fn a_settled_run_is_never_put_back_on_offer() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(dir.path());

        // Answered: re-offering would buy a second completion for a settled question.
        queue_run(&store, "run-answered", "ses-answered", 1_000);
        let token = claim_token(&store, "run-answered", "install-one", 1_000);
        store
            .record_historian_report(
                PROJECT,
                "run-answered",
                &token,
                &HistorianRunReport::Output {
                    text: "<compartments/>".to_string(),
                    length_capped: false,
                },
                2_000,
            )
            .unwrap();
        assert!(!store
            .republish_parked_historian_run("run-answered", 2_000)
            .unwrap());

        // Past its own deadline: the module has stopped waiting for it.
        queue_run(&store, "run-expired", "ses-expired", 1_000);
        assert!(store
            .park_historian_pending_run("run-expired", 1_500)
            .unwrap());
        assert!(!store
            .republish_parked_historian_run("run-expired", 1_000 + AWAIT_BUDGET_MS + 1)
            .unwrap());

        // A claim nobody has given up on is not disturbed.
        queue_run(&store, "run-live", "ses-live", 1_000);
        let live_token = claim_token(&store, "run-live", "install-one", 1_000);
        assert!(!store
            .republish_parked_historian_run("run-live", 2_000)
            .unwrap());
        assert_eq!(
            store
                .historian_state("ses-live")
                .unwrap()
                .coordinator_token
                .as_deref(),
            Some(live_token.as_str())
        );
    }

    #[test]
    fn a_session_with_no_queued_run_is_not_parked_on_one() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(dir.path());
        assert_eq!(store.load_parked_historian_run("ses").unwrap(), None);
        queue_run(&store, "run-1", "ses", 1_000);
        store.finish_historian_pending_run("run-1").unwrap();
        assert_eq!(
            store.load_parked_historian_run("ses").unwrap(),
            None,
            "a session whose queue row is gone has nothing to adopt"
        );
    }

    #[test]
    fn a_run_whose_own_deadline_passed_is_never_offered_again() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(dir.path());
        queue_run(&store, "run-1", "ses", 1_000);
        let after_deadline = 1_000 + AWAIT_BUDGET_MS + 1;

        assert!(store
            .list_pending_historian_runs(PROJECT, None, after_deadline)
            .unwrap()
            .is_empty());
        assert_eq!(
            store
                .claim_historian_run(PROJECT, "run-1", "install-one", after_deadline)
                .unwrap(),
            HistorianClaimOutcome::Refused(HistorianClaimRefusal::NotPending)
        );
    }

    #[test]
    fn the_sweep_parks_a_claim_whose_lease_ran_out_and_leaves_a_live_one_alone() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(dir.path());
        queue_run(&store, "run-dead", "ses-dead", 1_000);
        queue_run(&store, "run-live", "ses-live", 1_000);
        store
            .claim_historian_run(PROJECT, "run-dead", "install-one", 1_000)
            .unwrap();
        store
            .claim_historian_run(PROJECT, "run-live", "install-two", 1_000)
            .unwrap();

        // One millisecond before either lease ends, nothing is swept.
        let lease_end = 1_000 + HISTORIAN_LEASE_CEILING_MS;
        assert_eq!(
            store.expire_historian_claims(lease_end - 1).unwrap(),
            HistorianSweepOutcome::default()
        );

        // The live claimant extends its lease; the dead one does not.
        let live_token = match store
            .claim_historian_run(PROJECT, "run-live", "install-three", lease_end - 1)
            .unwrap()
        {
            HistorianClaimOutcome::Refused(HistorianClaimRefusal::AlreadyClaimed) => store
                .historian_state("ses-live")
                .unwrap()
                .coordinator_token
                .expect("the live claim keeps its token"),
            other => panic!("a live lease must not be stealable: {other:?}"),
        };
        store
            .heartbeat_historian_run(PROJECT, "run-live", &live_token, lease_end - 1)
            .unwrap();

        assert_eq!(
            store.expire_historian_claims(lease_end).unwrap().reclaimed,
            vec!["run-dead".to_string()]
        );
        assert_eq!(
            store.historian_state("ses-dead").unwrap().state,
            HistorianPhase::Reclaiming
        );
        assert_eq!(
            store.historian_state("ses-live").unwrap().state,
            HistorianPhase::AwaitingProducer,
            "a claimant that keeps reporting is never stolen from"
        );
    }

    #[test]
    fn a_heartbeat_never_pushes_a_lease_past_the_run_itself() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(dir.path());
        queue_run(&store, "run-1", "ses", 1_000);
        let HistorianClaimOutcome::Claimed(claim) = store
            .claim_historian_run(PROJECT, "run-1", "install-one", 1_000)
            .unwrap()
        else {
            panic!("the first claimant must win");
        };
        let run_deadline_ms = 1_000 + AWAIT_BUDGET_MS;
        let late = run_deadline_ms - 1;
        assert_eq!(
            store
                .heartbeat_historian_run(PROJECT, "run-1", &claim.token, late)
                .unwrap(),
            HistorianHeartbeatOutcome::Extended {
                claim_deadline_ms: run_deadline_ms
            }
        );
    }

    #[test]
    fn finishing_a_run_removes_it_from_the_queue() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(dir.path());
        queue_run(&store, "run-1", "ses", 1_000);
        assert!(store.finish_historian_pending_run("run-1").unwrap());
        assert!(!store.finish_historian_pending_run("run-1").unwrap());
        assert!(store
            .list_pending_historian_runs(PROJECT, None, 2_000)
            .unwrap()
            .is_empty());
        assert_eq!(
            store
                .claim_historian_run(PROJECT, "run-1", "install-one", 2_000)
                .unwrap(),
            HistorianClaimOutcome::Refused(HistorianClaimRefusal::UnknownRun)
        );
    }

    #[test]
    fn a_run_can_only_be_queued_from_a_firing_session() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(dir.path());
        let loaded = store.load("ses").unwrap();
        store
            .commit(
                "ses",
                loaded.row_version,
                &CoreState::default(),
                &ModuleMeta::default(),
            )
            .unwrap();
        let error = store
            .publish_pending_historian_run(&NewHistorianPendingRun {
                run_id: "run-1".to_string(),
                session_id: "ses".to_string(),
                project_path: PROJECT.to_string(),
                firing_seq: 1,
                chunk_fingerprint: "fp".to_string(),
                system_prompt: "sys".to_string(),
                user_prompt: "user".to_string(),
                model_chain: vec!["test/model".to_string()],
                await_budget_ms: AWAIT_BUDGET_MS,
                historian_timeout_ms: None,
                now_ms: 1_000,
            })
            .expect_err("an idle session has no run to queue");
        assert!(error.to_string().contains("is not firing"), "{error}");
        assert!(store
            .list_pending_historian_runs(PROJECT, None, 2_000)
            .unwrap()
            .is_empty());
    }

    /// A run is only ever visible to the project that queued it, on every op in
    /// the lane. One module store serves every project on the machine and a claim
    /// hands back the folded transcript, so a caller in another project is answered
    /// as if the run did not exist rather than as if it were refused.
    #[test]
    fn a_run_is_only_reachable_from_the_project_that_queued_it() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(dir.path());
        queue_run_for_project(&store, "run-theirs", "ses-theirs", "git:other", 1_000);
        queue_run_for_project(&store, "run-ours", "ses-ours", PROJECT, 1_000);

        let ours = store
            .list_pending_historian_runs(PROJECT, None, 2_000)
            .unwrap();
        assert_eq!(
            ours.iter()
                .map(|run| run.run_id.as_str())
                .collect::<Vec<_>>(),
            vec!["run-ours"],
            "a poll must only see its own project's runs"
        );

        assert_eq!(
            store
                .claim_historian_run(PROJECT, "run-theirs", "install-one", 2_000)
                .unwrap(),
            HistorianClaimOutcome::Refused(HistorianClaimRefusal::UnknownRun),
            "claiming another project's run must not hand over its prompts"
        );

        // The control: the same call inside the owning project succeeds, so the
        // refusals above are about the project and not about the fixture.
        let HistorianClaimOutcome::Claimed(theirs) = store
            .claim_historian_run("git:other", "run-theirs", "install-one", 2_000)
            .unwrap()
        else {
            panic!("the owning project must be able to claim its own run");
        };

        assert_eq!(
            store
                .heartbeat_historian_run(PROJECT, "run-theirs", &theirs.token, 3_000)
                .unwrap(),
            HistorianHeartbeatOutcome::Refused(HistorianReportRefusal::UnknownRun),
            "a token from another project cannot extend a lease here"
        );
        assert_eq!(
            store
                .authorize_historian_report(PROJECT, "run-theirs", &theirs.token)
                .unwrap(),
            HistorianReportOutcome::Refused(HistorianReportRefusal::UnknownRun),
            "nor report against it"
        );
        assert!(matches!(
            store
                .authorize_historian_report("git:other", "run-theirs", &theirs.token)
                .unwrap(),
            HistorianReportOutcome::Authorized(_)
        ));
    }

    /// Past the run's own deadline the heartbeat refuses instead of handing back a
    /// lease that is already in the past. By then `pending` has stopped offering
    /// the run and `claim` refuses it, so an `ok` here would be the one answer
    /// still telling a claimant to keep paying for a completion nothing accepts.
    #[test]
    fn a_heartbeat_past_the_runs_own_deadline_is_refused_rather_than_extended() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(dir.path());
        queue_run(&store, "run-1", "ses", 1_000);
        let HistorianClaimOutcome::Claimed(claim) = store
            .claim_historian_run(PROJECT, "run-1", "install-one", 1_000)
            .unwrap()
        else {
            panic!("the first claimant must win");
        };
        let run_deadline_ms = 1_000 + AWAIT_BUDGET_MS;

        // One millisecond before the deadline the same beat is still accepted, so
        // the refusal below is about the deadline and not about the token.
        assert_eq!(
            store
                .heartbeat_historian_run(PROJECT, "run-1", &claim.token, run_deadline_ms - 1)
                .unwrap(),
            HistorianHeartbeatOutcome::Extended {
                claim_deadline_ms: run_deadline_ms
            }
        );
        for now_ms in [run_deadline_ms, run_deadline_ms + 1] {
            assert_eq!(
                store
                    .heartbeat_historian_run(PROJECT, "run-1", &claim.token, now_ms)
                    .unwrap(),
                HistorianHeartbeatOutcome::Refused(HistorianReportRefusal::RunExpired),
                "at {now_ms} the run is past its deadline and the claimant must stop"
            );
        }
    }

    /// A claimant whose lease has already lapsed keeps the run if its heartbeat
    /// reaches the store before a replacement's claim does.
    ///
    /// This is the documented convention, pinned here because it is the one
    /// ordering a claimant can be surprised by: the lapsed holder is not evicted on
    /// a clock, it is evicted by someone else arriving first. A beat inside the
    /// two-missed-beats window is a live claimant proving liveness, and taking the
    /// run from it would throw away a completion that is still being produced.
    #[test]
    fn a_heartbeat_revives_a_lapsed_lease_and_the_replacement_is_then_refused() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(dir.path());
        queue_run(&store, "run-1", "ses", 1_000);
        let HistorianClaimOutcome::Claimed(held) = store
            .claim_historian_run(PROJECT, "run-1", "install-one", 1_000)
            .unwrap()
        else {
            panic!("the first claimant must win");
        };

        // Past the lease, inside the run's own deadline: the two are different
        // clocks, and this window is the whole reason a re-claim exists.
        let lapsed_ms = 1_000 + HISTORIAN_LEASE_CEILING_MS + 1;
        assert_eq!(
            store
                .list_pending_historian_runs(PROJECT, None, lapsed_ms)
                .unwrap()
                .len(),
            1,
            "with the lease lapsed and no beat, the run is offerable again"
        );

        // The holder beats first.
        assert!(matches!(
            store
                .heartbeat_historian_run(PROJECT, "run-1", &held.token, lapsed_ms)
                .unwrap(),
            HistorianHeartbeatOutcome::Extended { .. }
        ));
        assert_eq!(
            store
                .claim_historian_run(PROJECT, "run-1", "install-two", lapsed_ms + 1)
                .unwrap(),
            HistorianClaimOutcome::Refused(HistorianClaimRefusal::AlreadyClaimed),
            "the revived claim is a live one, so the replacement loses the race"
        );
        let state = store.historian_state("ses").unwrap();
        assert_eq!(state.producer_attempt, 1, "no new attempt was minted");
        assert_eq!(
            state.coordinator_token.as_deref(),
            Some(held.token.as_str())
        );
    }

    /// A run whose module-side waiter is gone is parked: kept with its chunk
    /// fingerprint and prompts for a boot-time re-publication, never offered to a
    /// claimant, and deleted by the sweep once the run's own deadline passes.
    #[test]
    fn a_parked_run_is_never_offered_and_the_sweep_drops_it_at_the_deadline() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(dir.path());
        queue_run(&store, "run-parked", "ses", 1_000);
        assert_eq!(
            store
                .list_pending_historian_runs(PROJECT, None, 2_000)
                .unwrap()
                .len(),
            1,
            "the run is offerable before it is parked"
        );

        assert!(store
            .park_historian_pending_run("run-parked", 2_000)
            .unwrap());
        assert!(store
            .list_pending_historian_runs(PROJECT, None, 2_000)
            .unwrap()
            .is_empty());
        assert_eq!(
            store
                .claim_historian_run(PROJECT, "run-parked", "install-one", 2_000)
                .unwrap(),
            HistorianClaimOutcome::Refused(HistorianClaimRefusal::NotPending)
        );

        // What the row is kept FOR: the fingerprint and the prompt bytes a
        // re-publication would otherwise have to re-assemble.
        let (phase, fingerprint, prompt) = store
            .inner
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT phase, chunk_fingerprint, user_prompt
                       FROM mc_historian_pending_run WHERE run_id = 'run-parked'",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    },
                )
            })
            .unwrap();
        assert_eq!(
            (phase.as_str(), fingerprint.as_str(), prompt.as_str()),
            ("parked", "fp", "user")
        );

        let run_deadline_ms = 1_000 + AWAIT_BUDGET_MS;
        assert_eq!(
            store.expire_historian_claims(run_deadline_ms - 1).unwrap(),
            HistorianSweepOutcome::default(),
            "a parked run inside its own deadline is still adoptable"
        );
        assert_eq!(
            store.expire_historian_claims(run_deadline_ms).unwrap(),
            HistorianSweepOutcome {
                reclaimed: Vec::new(),
                dropped: vec!["run-parked".to_string()],
            }
        );
        let remaining: i64 = store
            .inner
            .with_conn(|conn| {
                conn.query_row("SELECT COUNT(*) FROM mc_historian_pending_run", [], |row| {
                    row.get(0)
                })
            })
            .unwrap();
        assert_eq!(remaining, 0, "the row does not outlive its own deadline");
    }

    /// `store_meta` promises the write landed. A row version that moved underneath
    /// it means it did not, and the caller has to hear about it rather than get a
    /// new row version for a row that was never updated.
    #[test]
    fn store_meta_refuses_a_write_that_touched_no_row() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(dir.path());
        let loaded = store.load("ses").unwrap();
        store
            .commit(
                "ses",
                loaded.row_version,
                &CoreState::default(),
                &ModuleMeta::default(),
            )
            .unwrap();

        let outcome = store.inner.with_conn_fenced(|tx| {
            let (row_version, meta) = load_meta(tx, "ses")?.expect("the session row exists");
            // The control: at the version the row actually holds, the write lands.
            let next = store_meta(tx, "ses", row_version, &meta)?;
            assert_eq!(next as i64, row_version + 1);
            Ok(store_meta(tx, "ses", row_version, &meta)
                .unwrap_err()
                .to_string())
        });
        let error = outcome.unwrap();
        assert!(
            error.contains("0 rows") || error.to_lowercase().contains("changed"),
            "the error has to say the update matched nothing: {error}"
        );
    }

    #[test]
    fn the_lease_is_the_await_budget_capped_at_the_ceiling() {
        assert_eq!(historian_lease_ms(60_000), 60_000);
        assert_eq!(
            historian_lease_ms(AWAIT_BUDGET_MS),
            HISTORIAN_LEASE_CEILING_MS,
            "the await budget outliving the ceiling is what leaves a run to re-claim"
        );
        assert_eq!(
            historian_lease_ms(0),
            1,
            "a zero lease would be instantly stale"
        );
    }
}
