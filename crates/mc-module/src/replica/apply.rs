//! Following the stream: opening each message and applying it.
//!
//! Messages apply in stream order, each in its own transaction that also
//! stores the message's stream sequence, so a restart resumes after the
//! last applied one. The transaction first puts the row of
//! `replica_applying` in place, which keeps every capture trigger quiet:
//! an applied arrival is never sent again ([`super::schema`]).
//!
//! - A message that can't be opened, decoded or validated is recorded in
//!   `replica_rejects` with its sequence and reason, and skipped: one bad
//!   message never stops the stream. A message that fails for this
//!   computer's own reasons (the store busy or full, the vault unable to
//!   open it for now, as under an epoch this computer's vault doesn't hold
//!   yet, [`super::epochs`]) is never skipped: the round ends before it,
//!   and it is read again on a later one.
//! - This computer's own messages come back too. One its outbox still
//!   waits for (the same global id, revision and sending store id) settles
//!   that outbox row. One sent under this store's id that the outbox
//!   doesn't know was sent by a copy of this store, or an earlier or later
//!   state of it (a store restored from a copy); the store takes a new id,
//!   so no id that copy may have sent is sent again for another row, and
//!   the message applies like anyone else's.
//! - The stream's order decides a row's state, the same on every computer:
//!   of the messages for one global id, the one with the highest revision,
//!   and of equal revisions the later one in the stream, is the row
//!   (`replica_ids.revision`, `seq`). An arrival that is the row's new
//!   winner replaces its replicated fields; replaced text goes to
//!   `memory_history`, where the dreamer's curate task, which tidies an
//!   owner's memories, sees it. One that isn't changes nothing.
//! - A change of this computer's own not yet back from the stream may win
//!   over an arrival: it does when its revision is at least the arrival's,
//!   since it lands later, unless it is a dreamer change the stream fences.
//!   The arrival is then passed over and kept (`replica_passed`), as it is
//!   what every other computer holds meanwhile. When the own change can no
//!   longer win, the row is brought to what every other computer holds
//!   ([`reconcile`]). An arrival that beats every own change applies, and
//!   the own changes still waiting to be sent go: their text stays in the
//!   history.
//! - One global id names one row. When two live memories hold one fact (the
//!   same level, owner, category and normalized text, the store's unique
//!   key), the one with the lower global id stays live and the other is
//!   archived, superseded by it. Every computer derives this from the ids
//!   alone, so it is written under the apply marker and never sent
//!   (`replica_derived`), and decided again whenever either row changes. A
//!   row never sent yet loses to any sent one until it is sent.
//! - Links map through `replica_ids`. A link to a global id not seen yet
//!   waits in `replica_pending_links` and is made when the id arrives.
//! - A delete removes the row the way the person's delete does, and marks
//!   its global id deleted, whatever this computer's own changes of it:
//!   deletes are final everywhere. Any later message for a deleted id is
//!   skipped.
//! - A dreamer change is fenced by the row it changes: it is recorded and
//!   skipped when the stream already holds a change of that row, for the
//!   same role, under a newer lease generation ([`fenced`]). Its computer had
//!   lost the role. The fence is read from the stream alone, so every
//!   computer decides the same for each message.
//! - An applied change is reported like a local write of its kind
//!   ([`ContextDb::changed`]), so the apps reload and the memory-changed
//!   wake goes out, and heads show it as an ordinary memory delta. It never
//!   changes `project_memory_epoch`.

use rusqlite::types::Value as Sql;
use rusqlite::{
    params, params_from_iter, Connection, OptionalExtension, Transaction, TransactionBehavior,
};
use serde_json::{json, Map, Value};

use super::epochs::{unopened, EpochStatus, Unopened, INVALID_PARAMS};
use super::hub::HubMessage;
use super::schema::{Table, MEMORIES, OBSERVATIONS};
use super::seal::{OpenInput, Opened};
use super::snapshot::{merged_metadata, to_sql, LINK_COLUMNS};
use super::wire::{self, Body, Envelope};
use super::{table, Replica, BATCH};
use crate::app_read::Change;
use crate::memory_writes::now_ms;

/// What opening one message gave.
enum Opening {
    /// Its body, and the epoch it was sealed under.
    Body(Body, u64),
    /// It can never be applied, for this reason: recorded and skipped.
    Skip(String),
    /// It may open later: the round ends before it.
    Hold { why: String, alert: bool },
}

impl Replica {
    /// Read and apply the next messages after this computer's position.
    /// Returns how many were read. A round that can't apply a message for
    /// this computer's own reasons stops before it, with the position
    /// after the last message applied, to read it again. Rows to read again
    /// from the stream ([`reconcile`]) are read first.
    pub async fn follow(&self) -> Result<usize, String> {
        self.restore().await?;
        let after = self.position()?;
        let messages = self
            .hub
            .fetch(after, BATCH)
            .await
            .map_err(|error| format!("reading the stream: {error}"))?;
        if messages.is_empty() {
            return Ok(0);
        }
        let openings = self.open(&messages).await?;
        for (message, opening) in messages.iter().zip(openings) {
            let (body, epoch) = match opening {
                Opening::Body(body, epoch) => (Ok(body), Some(epoch)),
                Opening::Skip(reason) => (Err(reason), None),
                Opening::Hold { why, alert } => {
                    return Err(self.hold(&format!("opening {}: {why}", message.seq), alert))
                }
            };
            let changes = self
                .db
                .with_connection(|conn| apply_message(conn, &self.box_id, message, body, epoch))
                .map_err(|error| format!("applying {}: {error}", message.seq))?;
            self.release();
            for change in changes {
                self.db.changed(change);
            }
            if let Err(error) = self.hub.ack(message.seq).await {
                tracing::debug!(
                    "ck-mc: replica: acknowledging {} failed: {error}",
                    message.seq
                );
            }
        }
        Ok(messages.len())
    }

    /// Hold the stream at a message that may open later: log `why` once,
    /// at error level when `alert`, and return it as the round's error. The
    /// replica task reads it again after its backoff, or at once when the
    /// epoch record changes ([`super::live`]).
    fn hold(&self, why: &str, alert: bool) -> String {
        let mut held = self
            .held
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if held.as_deref() != Some(why) {
            if alert {
                tracing::error!("ck-mc: replica: the memory stream is held: {why}");
            } else {
                tracing::info!("ck-mc: replica: the memory stream is held: {why}");
            }
            *held = Some(why.to_owned());
        }
        why.to_owned()
    }

    /// A message applied: a later hold is logged again.
    fn release(&self) {
        self.held
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
    }

    /// Open `messages` in one vault call, and say for each what it gave.
    /// A refused call holds the stream.
    async fn open(&self, messages: &[HubMessage]) -> Result<Vec<Opening>, String> {
        let envelopes: Vec<Result<Envelope, String>> = messages
            .iter()
            .map(|message| {
                serde_json::from_slice::<Envelope>(&message.payload)
                    .map_err(|_| "not a sealed envelope".to_owned())
            })
            .collect();
        let inputs: Vec<OpenInput> = messages
            .iter()
            .zip(&envelopes)
            .filter_map(|(message, envelope)| {
                let envelope = envelope.as_ref().ok()?;
                Some(OpenInput {
                    epoch: envelope.epoch,
                    nonce: envelope.nonce.clone(),
                    ciphertext: envelope.ciphertext.clone(),
                    aad: wire::aad(&envelope.global_id, envelope.revision, &message.subject),
                })
            })
            .collect();
        let opened = if inputs.is_empty() {
            Vec::new()
        } else {
            match self.sealer.open_batch(&inputs).await {
                Ok(opened) => opened,
                Err(error) => {
                    return Err(self.hold(
                        &format!("opening: the vault refused the call: {error}"),
                        error.code == INVALID_PARAMS,
                    ))
                }
            }
        };
        // An epoch the vault opened any message of in this same call is one
        // it holds, as much as one it opened before.
        let opened_now: std::collections::HashSet<u64> = inputs
            .iter()
            .zip(&opened)
            .filter(|(_, opened)| matches!(opened, Opened::Plaintext(_)))
            .map(|(input, _)| input.epoch)
            .collect();
        let mut opened = opened.into_iter();
        let mut status: Option<EpochStatus> = None;
        let mut openings = Vec::with_capacity(messages.len());
        for (message, envelope) in messages.iter().zip(envelopes) {
            let envelope = match envelope {
                Err(reason) => {
                    openings.push(Opening::Skip(reason));
                    continue;
                }
                Ok(envelope) => envelope,
            };
            openings.push(match opened.next() {
                Some(Opened::Plaintext(bytes)) => match decode(&bytes, &envelope, &message.subject)
                {
                    Ok(body) => Opening::Body(body, envelope.epoch),
                    Err(reason) => Opening::Skip(reason),
                },
                Some(Opened::Refused { code, .. }) if code == super::seal::ENVELOPE_INVALID => {
                    // Decided here without the vault: the envelope holds
                    // nothing the vault ever sealed.
                    Opening::Skip(format!("not opened: {code}"))
                }
                Some(Opened::Refused { code, class }) => {
                    let status = match status {
                        Some(status) => status,
                        None => *status.insert(self.epochs.status().await),
                    };
                    let seen = opened_now.contains(&envelope.epoch)
                        || self
                            .db
                            .with_connection(|conn| opened_before(conn, envelope.epoch))
                            .map_err(|error| error.to_string())?;
                    match unopened(&code, &class, envelope.epoch, seen, status) {
                        Unopened::Skip(reason) => Opening::Skip(reason),
                        Unopened::Hold { why, alert } => Opening::Hold { why, alert },
                    }
                }
                None => Opening::Hold {
                    why: "the vault gave no answer for it".into(),
                    alert: false,
                },
            });
        }
        Ok(openings)
    }

    /// Read again, by sequence, each message queued to be read again
    /// ([`reconcile`]), and apply it if it still decides its row.
    async fn restore(&self) -> Result<(), String> {
        let queued: Vec<(String, u64)> = self
            .db
            .with_connection(|conn| {
                conn.prepare("SELECT global_id, seq FROM replica_restore ORDER BY seq")?
                    .query_map([], |row| Ok((row.get(0)?, row.get::<_, i64>(1)? as u64)))?
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .map_err(|error| error.to_string())?;
        for (global, seq) in queued {
            let message = self
                .hub
                .get(seq)
                .await
                .map_err(|error| format!("reading message {seq} again: {error}"))?;
            let opening = match &message {
                None => Opening::Skip(format!(
                    "the hub no longer holds message {seq}, which decides {global} on every computer; this computer keeps the row as it is"
                )),
                Some(message) => self
                    .open(std::slice::from_ref(message))
                    .await?
                    .pop()
                    .expect("one opening per message"),
            };
            let changes = match (message, opening) {
                (_, Opening::Hold { why, alert }) => {
                    return Err(self.hold(&format!("opening {seq} again: {why}"), alert))
                }
                (Some(message), Opening::Body(body, epoch)) if body.global_id == global => self
                    .db
                    .with_connection(|conn| {
                        restore_message(conn, &self.box_id, &message, &body, Some(epoch))
                    })
                    .map_err(|error| format!("applying {seq} again: {error}"))?,
                (_, opening) => {
                    let why = match opening {
                        Opening::Skip(why) => why,
                        _ => format!("message {seq} names another row than {global}"),
                    };
                    tracing::error!("ck-mc: replica: reading {global} again: {why}");
                    self.db
                        .with_connection(|conn| {
                            conn.execute(
                                "DELETE FROM replica_restore WHERE global_id = ?1 AND seq = ?2",
                                params![global, seq as i64],
                            )
                        })
                        .map_err(|error| error.to_string())?;
                    Vec::new()
                }
            };
            for change in changes {
                self.db.changed(change);
            }
        }
        Ok(())
    }
}

/// Whether this computer has opened a message sealed under `epoch`.
fn opened_before(conn: &Connection, epoch: u64) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM replica_epochs WHERE epoch = ?1)",
        [epoch as i64],
        |row| row.get(0),
    )
}

/// The body of an opened message, checked against the envelope and the
/// subject it came on, with a snapshot this store can hold.
fn decode(bytes: &[u8], envelope: &Envelope, subject: &str) -> Result<Body, String> {
    let body: Body = serde_json::from_slice(bytes).map_err(|_| "not a message body".to_owned())?;
    if body.global_id != envelope.global_id || body.revision != envelope.revision {
        return Err("the body names another message".into());
    }
    if !matches!(body.kind.as_str(), "memory" | "observation" | "primer") {
        return Err(format!("unknown kind {}", body.kind));
    }
    let subject_kind = subject.split('.').nth(3).unwrap_or_default();
    let expected = match subject_kind {
        "project" | "workspace" | "global" => "memory",
        other => other,
    };
    if body.kind != expected {
        return Err(format!("a {} body on a {subject_kind} subject", body.kind));
    }
    if body.change == "delete" {
        return Ok(body);
    }
    let Some(snapshot) = body.snapshot.as_ref() else {
        return Err("no snapshot".into());
    };
    validate(&body.kind, snapshot)?;
    // The snapshot's level and owner must be the ones its subject names, so
    // a row never lands under an owner the stream didn't file it under.
    let text = |column: &str| snapshot.get(column).and_then(Value::as_str);
    let (level, owner) = match body.kind.as_str() {
        "memory" => (text("level"), text("owner_id").unwrap_or_default()),
        "primer" => (None, text("project_path").unwrap_or_default()),
        _ => (None, "all"),
    };
    let named = wire::subject(&body.kind, level, owner)?;
    if named != subject {
        return Err(format!(
            "the snapshot belongs on {named}, not on the subject it came on"
        ));
    }
    Ok(body)
}

/// A memory level a snapshot may carry: agent-level memories never travel.
const LEVELS: [&str; 3] = ["project", "workspace", "global"];

/// Whether `snapshot` holds every value the store requires of a row of
/// `kind`, as its `NOT NULL` and `CHECK` constraints say, so a valid
/// message never breaks those constraints when it is applied.
fn validate(kind: &str, snapshot: &Map<String, Value>) -> Result<(), String> {
    let present = |column: &str| snapshot.get(column).is_some_and(|value| !value.is_null());
    let text = |column: &str| -> Result<(), String> {
        match snapshot.get(column) {
            Some(Value::String(_)) => Ok(()),
            _ => Err(format!("the snapshot's {column} is not text")),
        }
    };
    let number = |column: &str| -> Result<(), String> {
        match snapshot.get(column) {
            Some(Value::Number(_)) => Ok(()),
            _ => Err(format!("the snapshot's {column} is not a number")),
        }
    };
    // Columns with a default that may be left out, never sent as null.
    let not_null = |columns: &[&str]| -> Result<(), String> {
        match columns
            .iter()
            .find(|column| snapshot.get(**column).is_some_and(Value::is_null))
        {
            Some(column) => Err(format!("the snapshot's {column} is null")),
            None => Ok(()),
        }
    };
    let one_of = |column: &str, allowed: &[&str], nullable: bool| -> Result<(), String> {
        match snapshot.get(column) {
            None => Ok(()),
            Some(Value::Null) if nullable => Ok(()),
            Some(Value::String(value)) if allowed.contains(&value.as_str()) => Ok(()),
            Some(Value::Number(value)) if allowed.contains(&value.to_string().as_str()) => Ok(()),
            Some(_) => Err(format!("the snapshot's {column} is not one of {allowed:?}")),
        }
    };
    let array = |column: &str| -> Result<(), String> {
        match snapshot.get(column) {
            None | Some(Value::Null) | Some(Value::Array(_)) => Ok(()),
            Some(_) => Err(format!("the snapshot's {column} is not a list")),
        }
    };
    match kind {
        "memory" => {
            for column in [
                "owner_id",
                "category",
                "origin_category",
                "content",
                "normalized_hash",
            ] {
                text(column)?;
            }
            for column in ["first_seen_at", "created_at"] {
                number(column)?;
            }
            one_of("level", &LEVELS, false)?;
            if !present("level") {
                return Err("the snapshot has no level".into());
            }
            not_null(&["scope", "shareable", "mural_cue_rejection_count"])?;
            one_of("authority", &["learned", "policy"], false)?;
            one_of("epistemic", &["confirmed", "claimed"], true)?;
            one_of("sensitive", &["0", "1"], false)?;
            one_of("safety_critical", &["0", "1"], true)?;
            for column in LINK_COLUMNS {
                match snapshot.get(column) {
                    None | Some(Value::Null) | Some(Value::String(_)) => {}
                    Some(_) => return Err(format!("the snapshot's {column} is not a global id")),
                }
            }
            for column in ["merged_from", "files", "supersedes", "conflicts"] {
                array(column)?;
            }
        }
        "observation" => {
            text("content")?;
            number("created_at")?;
        }
        _ => {
            text("project_path")?;
            text("question")?;
            number("created_at")?;
            not_null(&["answer", "total_support"])?;
            one_of("status", &["active", "archived"], false)?;
        }
    }
    Ok(())
}

/// What applying one message did.
enum Applied {
    /// Changes to report once the transaction commits.
    Changed(Vec<Change>),
    /// Recorded and skipped, with the reason.
    Skipped(String),
}

/// Apply one message in its own transaction, or record why it was skipped;
/// either way the stream position moves past it. A store error leaves the
/// position where it was: the transaction rolls back, nothing of the
/// message stays, and it is read again on the next round. `epoch` is the
/// fleet epoch the message opened under, recorded as one this computer's
/// vault holds.
fn apply_message(
    conn: &mut Connection,
    box_id: &str,
    message: &HubMessage,
    body: Result<Body, String>,
    epoch: Option<u64>,
) -> rusqlite::Result<Vec<Change>> {
    let global = body.as_ref().ok().map(|body| body.global_id.clone());
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute("INSERT INTO replica_applying (applying) VALUES (1)", [])?;
    if let Some(epoch) = epoch {
        tx.execute(
            "INSERT OR IGNORE INTO replica_epochs (epoch) VALUES (?1)",
            [epoch as i64],
        )?;
    }
    let applied = match &body {
        Ok(body) => apply_body(&tx, box_id, message.seq, &message.subject, body)?,
        Err(reason) => Applied::Skipped(reason.clone()),
    };
    let changes = match applied {
        Applied::Changed(changes) => changes,
        Applied::Skipped(reason) => {
            reject(&tx, message, global.as_deref(), &reason)?;
            Vec::new()
        }
    };
    advance(&tx, message.seq)?;
    tx.execute("DELETE FROM replica_applying", [])?;
    tx.commit()?;
    Ok(changes)
}

/// Apply `body`, read again from the stream at `message.seq` because this
/// computer's own change of its row can no longer win ([`reconcile`]), if
/// that message still decides the row: it was not fenced when it was
/// applied first, so the fence doesn't decide again, and the row's order
/// and this computer's own changes do, as for any arrival.
fn restore_message(
    conn: &mut Connection,
    box_id: &str,
    message: &HubMessage,
    body: &Body,
    epoch: Option<u64>,
) -> rusqlite::Result<Vec<Change>> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute("INSERT INTO replica_applying (applying) VALUES (1)", [])?;
    if let Some(epoch) = epoch {
        tx.execute(
            "INSERT OR IGNORE INTO replica_epochs (epoch) VALUES (?1)",
            [epoch as i64],
        )?;
    }
    let queued = tx.execute(
        "DELETE FROM replica_restore WHERE global_id = ?1 AND seq = ?2",
        params![body.global_id, message.seq as i64],
    )?;
    let mut changes = Vec::new();
    if queued > 0 {
        let table = table(&body.kind);
        if let Some(found) = known(&tx, &body.global_id)? {
            let local = match found.local {
                Some(local) if exists(&tx, table, local)? => Some(local),
                _ => None,
            };
            if let (None, Some(local), Some(winner)) = (found.deleted_at, local, found.seq) {
                if winner == message.seq as i64 && body.change != "delete" {
                    changes = arrive(&tx, box_id, table, local, message.seq, body)?;
                }
            }
        }
    }
    tx.execute("DELETE FROM replica_applying", [])?;
    tx.commit()?;
    Ok(changes)
}

fn reject(
    tx: &Connection,
    message: &HubMessage,
    global: Option<&str>,
    reason: &str,
) -> rusqlite::Result<()> {
    tracing::info!(
        "ck-mc: replica: stream message {} skipped: {reason}",
        message.seq
    );
    tx.execute(
        "INSERT INTO replica_rejects (stream_seq, subject, global_id, reason, recorded_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            message.seq as i64,
            message.subject,
            global,
            reason,
            now_ms()
        ],
    )?;
    Ok(())
}

fn advance(tx: &Connection, seq: u64) -> rusqlite::Result<()> {
    tx.execute(
        "UPDATE replica_state SET stream_seq = MAX(stream_seq, ?1) WHERE id = 1",
        [seq as i64],
    )?;
    Ok(())
}

/// What this store knows of a global id: its local row, when it was
/// deleted, and the revision and stream sequence of the message that
/// decides its state.
struct Known {
    local: Option<i64>,
    deleted_at: Option<i64>,
    revision: Option<i64>,
    seq: Option<i64>,
    written: Option<i64>,
    undone: Option<i64>,
}

fn known(tx: &Connection, global: &str) -> rusqlite::Result<Option<Known>> {
    tx.query_row(
        "SELECT local_id, deleted_at, revision, seq, written, undone FROM replica_ids
          WHERE global_id = ?1",
        [global],
        |row| {
            Ok(Known {
                local: row.get(0)?,
                deleted_at: row.get(1)?,
                revision: row.get(2)?,
                seq: row.get(3)?,
                written: row.get(4)?,
                undone: row.get(5)?,
            })
        },
    )
    .optional()
}

/// Record that the content of the message deciding `global`'s row is
/// written to the row now, over every outbox row up to `outbox`: those of
/// this computer's own changes are under it. `None` is an arrival written
/// over all of them, which undoes nothing of this computer's; `Some` is this
/// computer's own change, at that outbox row, that decides the row now.
fn written(tx: &Connection, global: &str, outbox: Option<i64>) -> rusqlite::Result<()> {
    tx.execute(
        "UPDATE replica_ids
            SET written = COALESCE(?2, (SELECT COALESCE(MAX(id), 0) FROM replica_outbox)),
                undone = CASE WHEN ?2 IS NULL THEN NULL ELSE undone END
          WHERE global_id = ?1",
        params![global, outbox],
    )?;
    Ok(())
}

fn exists(tx: &Connection, table: &Table, id: i64) -> rusqlite::Result<bool> {
    tx.query_row(
        &format!("SELECT EXISTS(SELECT 1 FROM {} WHERE id = ?1)", table.name),
        [id],
        |row| row.get(0),
    )
}

/// Whether this computer's outbox waits for its own message `body`: a row
/// sent or being sent for the same global id at that revision, under the
/// store id the message names.
fn own_known(tx: &Connection, body: &Body) -> rusqlite::Result<bool> {
    tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM replica_outbox
                        WHERE global_id = ?1 AND revision = ?2 AND sender = ?3
                          AND state IN ('sending', 'published'))",
        params![body.global_id, body.revision, body.writer.store_id],
        |row| row.get(0),
    )
}

/// Record that the message at `seq` (of `revision`) decides `global`'s row.
fn decides(tx: &Connection, global: &str, revision: i64, seq: u64) -> rusqlite::Result<()> {
    tx.execute(
        "UPDATE replica_ids SET revision = ?2, seq = ?3 WHERE global_id = ?1",
        params![global, revision, seq as i64],
    )?;
    Ok(())
}

fn apply_body(
    tx: &Transaction,
    box_id: &str,
    seq: u64,
    subject: &str,
    body: &Body,
) -> rusqlite::Result<Applied> {
    let table = table(&body.kind);
    let own = body.writer.box_id == box_id && own_known(tx, body)?;
    if !own && body.writer.store_id == super::store_id(tx)? {
        super::new_store_id(
            tx,
            "the stream holds a message sent under this store's id that this store doesn't know; a copy of the store, or an earlier or later state of it, sent it",
        )?;
    }
    let found = known(tx, &body.global_id)?;
    let local = match found.as_ref().and_then(|found| found.local) {
        Some(local) if exists(tx, table, local)? => Some(local),
        _ => None,
    };
    if found
        .as_ref()
        .is_some_and(|found| found.deleted_at.is_some())
        || (own && body.change == "delete")
    {
        // Deleted here: no change brings the row back.
        if own {
            settle_own(tx, body)?;
        }
        return Ok(Applied::Changed(Vec::new()));
    }
    if body.change == "delete" {
        return tombstone(tx, table, body, subject, local).map(Applied::Changed);
    }
    let fence = fenced(tx, subject, body)?;
    let winner = fence.is_none()
        && found
            .as_ref()
            .and_then(|found| found.revision)
            .is_none_or(|revision| body.revision >= revision);
    if own {
        // This computer's own change is in the stream now. If it doesn't
        // decide its row (fenced, or a later revision is in the stream), its
        // row is brought to what every other computer holds before the
        // outbox rows that waited for it are settled.
        let mut changes = Vec::new();
        if winner {
            decides(tx, &body.global_id, body.revision, seq)?;
            // The row shows this change, or a later one of this computer's
            // written over it.
            let own_row: Option<i64> = tx.query_row(
                "SELECT MAX(id) FROM replica_outbox
                  WHERE global_id = ?1 AND revision = ?2 AND sender = ?3
                    AND state IN ('sending', 'published')",
                params![body.global_id, body.revision, body.writer.store_id],
                |row| row.get(0),
            )?;
            written(tx, &body.global_id, Some(own_row.unwrap_or(0)))?;
            for done in ["replica_passed", "replica_restore"] {
                tx.execute(
                    &format!("DELETE FROM {done} WHERE global_id = ?1"),
                    [&body.global_id],
                )?;
            }
        }
        if let Some(local) = local {
            changes.extend(reconcile(tx, box_id, table, local)?);
        }
        settle_own(tx, body)?;
        changes.extend(settled(tx, table, body)?);
        changes.dedup();
        return Ok(Applied::Changed(changes));
    }
    if let Some(reason) = fence {
        return Ok(Applied::Skipped(reason));
    }
    let Some(local) = local else {
        if !winner {
            return Ok(Applied::Changed(Vec::new()));
        }
        let snapshot = body.snapshot.as_ref().expect("checked when decoded");
        let local = insert(tx, table, body, snapshot)?;
        decides(tx, &body.global_id, body.revision, seq)?;
        written(tx, &body.global_id, None)?;
        let mut changes = Vec::new();
        if table.kind == MEMORIES.kind {
            children(tx, local, snapshot)?;
            journal(tx, local, body, seq, "replica_apply")?;
        }
        resolve_pending(tx, &body.global_id, local)?;
        changes.extend(owner_change(tx, table, local)?);
        return Ok(Applied::Changed(changes));
    };
    if !winner {
        // A message the row's deciding one beats changes nothing, but it may
        // have fenced a change of this computer's own.
        return reconcile(tx, box_id, table, local).map(Applied::Changed);
    }
    decides(tx, &body.global_id, body.revision, seq)?;
    arrive(tx, box_id, table, local, seq, body).map(Applied::Changed)
}

/// The outbox rows that waited for this computer's own message `body` to
/// come back are settled.
fn settle_own(tx: &Connection, body: &Body) -> rusqlite::Result<()> {
    tx.execute(
        "DELETE FROM replica_outbox
          WHERE global_id = ?1 AND state IN ('sending', 'published') AND revision <= ?2",
        params![body.global_id, body.revision],
    )?;
    Ok(())
}

/// An arrival at `seq` that decides row `local` now, by the stream's
/// order. A change of this computer's own that will still win once it
/// lands passes it over, and it is kept for when that change can no longer
/// win: it is what every other computer holds meanwhile. Otherwise it
/// applies, and this computer's own changes still waiting to be sent go
/// (their text stays in the history).
fn arrive(
    tx: &Connection,
    box_id: &str,
    table: &Table,
    local: i64,
    seq: u64,
    body: &Body,
) -> rusqlite::Result<Vec<Change>> {
    if own_change_ahead(tx, table, local, body)? {
        tx.execute(
            "INSERT OR REPLACE INTO replica_passed (global_id, seq, revision, body)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                body.global_id,
                seq as i64,
                body.revision,
                serde_json::to_string(body).expect("a body serializes")
            ],
        )?;
        return reconcile(tx, box_id, table, local);
    }
    let changes = apply_snapshot(tx, table, local, body, seq, FROM_ANOTHER)?;
    tx.execute(
        "DELETE FROM replica_outbox
          WHERE kind = ?1 AND local_id = ?2 AND state NOT IN ('sending', 'published')
            AND change <> 'delete'",
        params![table.kind, local],
    )?;
    written(tx, &body.global_id, None)?;
    for done in ["replica_passed", "replica_restore"] {
        tx.execute(
            &format!("DELETE FROM {done} WHERE global_id = ?1"),
            [&body.global_id],
        )?;
    }
    Ok(changes)
}

/// Why a history row says its text was replaced: by an arrival from
/// another computer.
const FROM_ANOTHER: &str = "superseded by a change from another computer";

/// Why a history row says its text was replaced: this computer's own
/// change, which the other computers never apply, was undone.
const UNDONE: &str = "a change of this computer's that no other computer applies was undone";

/// Write `body`'s snapshot over row `local`, as an arrival does, with `why`
/// for the history row of any text it replaces.
fn apply_snapshot(
    tx: &Connection,
    table: &Table,
    local: i64,
    body: &Body,
    seq: u64,
    why: &str,
) -> rusqlite::Result<Vec<Change>> {
    let snapshot = body.snapshot.as_ref().expect("checked when decoded");
    let mut changes = Vec::new();
    changes.extend(owner_change(tx, table, local)?);
    update(tx, table, local, body, snapshot, why)?;
    if table.kind == MEMORIES.kind {
        children(tx, local, snapshot)?;
        journal(tx, local, body, seq, "replica_apply")?;
    }
    resolve_pending(tx, &body.global_id, local)?;
    changes.extend(owner_change(tx, table, local)?);
    changes.dedup();
    Ok(changes)
}

/// The dreamer role a change on `subject` belongs to: a project's or a
/// workspace's memories and a project's primers are their owner's
/// (`dreamer.<owner>`), global memories and observations the person's
/// (`dreamer.global`). The capture triggers name a row's role by the same
/// rule ([`super::schema`]), and [`decode`] has checked that a snapshot's
/// owner is the one its subject names.
fn subject_role(subject: &str) -> Option<String> {
    let mut parts = subject.splitn(5, '.');
    let kind = parts.nth(3)?;
    let owner = parts.next()?;
    Some(match kind {
        "global" | "observation" => "dreamer.global".to_owned(),
        _ => format!("dreamer.{owner}"),
    })
}

/// The level and owner a subject names, as a deleted row keeps them for
/// its tombstone ([`super::publish`] forms the subject from them again):
/// a memory's level and owner, a primer's project, nothing for an
/// observation.
fn subject_owner(subject: &str) -> (Option<String>, Option<String>) {
    let mut parts = subject.splitn(5, '.');
    let (Some(kind), Some(owner)) = (parts.nth(3), parts.next()) else {
        return (None, None);
    };
    match kind {
        "project" | "workspace" | "global" => (Some(kind.to_owned()), Some(owner.to_owned())),
        "primer" => (None, Some(owner.to_owned())),
        _ => (None, None),
    }
}

/// The dreamer role of row `local` as it stands here, by the same rule.
fn local_role(tx: &Connection, table: &Table, local: i64) -> rusqlite::Result<Option<String>> {
    let sql = match table.kind {
        "memory" => {
            "SELECT CASE WHEN level = 'global' THEN 'dreamer.global' ELSE 'dreamer.' || owner_id END
               FROM memories WHERE id = ?1"
        }
        "primer" => "SELECT 'dreamer.' || project_path FROM primers WHERE id = ?1",
        _ => "SELECT 'dreamer.global' FROM memory_observations WHERE id = ?1",
    };
    tx.query_row(sql, [local], |row| row.get(0)).optional()
}

/// The newest lease generation the stream holds a change of `global`
/// under, for `role`.
fn fence_of(tx: &Connection, global: &str, role: &str) -> rusqlite::Result<Option<i64>> {
    tx.query_row(
        "SELECT epoch FROM replica_fences WHERE global_id = ?1 AND role = ?2",
        params![global, role],
        |row| row.get(0),
    )
    .optional()
}

/// Why `body` is skipped as a dreamer change older than its row's fence,
/// if it is. Otherwise its epoch raises the row's fence for the changes
/// after it.
///
/// A dreamer change carries the generation of the lease its run held for
/// the row's role, and Entorhinal raises a role's generation each time the
/// role changes hands, so a change under an older generation than one the
/// stream already holds a change of the same row under was written by a
/// computer that had lost the role. The fence is read from the stream
/// alone (`replica_fences`), never from this computer's own leases, so
/// every computer at the same position decides the same. A change without
/// an epoch is never fenced: no dreamer wrote it under a lease of its role.
fn fenced(tx: &Connection, subject: &str, body: &Body) -> rusqlite::Result<Option<String>> {
    let Some(epoch) = body.writer.dreamer_epoch else {
        return Ok(None);
    };
    if body.writer.actor != "dreamer" {
        return Ok(None);
    }
    let Some(role) = subject_role(subject) else {
        return Ok(None);
    };
    if let Some(fence) = fence_of(tx, &body.global_id, &role)?.filter(|fence| epoch < *fence) {
        return Ok(Some(format!(
            "a dreamer change written under generation {epoch} of {role}, older than generation {fence} the stream holds a change of this row under"
        )));
    }
    tx.execute(
        "INSERT INTO replica_fences (global_id, role, epoch) VALUES (?1, ?2, ?3)
         ON CONFLICT (global_id, role) DO UPDATE SET epoch = MAX(epoch, excluded.epoch)",
        params![body.global_id, role, epoch],
    )?;
    Ok(None)
}

/// This computer's own message `body` came back. A memory that has its
/// global id in the stream now may win or lose a fact it shares with
/// another row, so that fact is decided again ([`settle_fact`]).
fn settled(tx: &Connection, table: &Table, body: &Body) -> rusqlite::Result<Vec<Change>> {
    if table.kind != MEMORIES.kind {
        return Ok(Vec::new());
    }
    let Some(Known {
        local: Some(local), ..
    }) = known(tx, &body.global_id)?
    else {
        return Ok(Vec::new());
    };
    let mut moved = survivor_gone(tx, local)?;
    if let Some(fact) = fact_of(tx, local)? {
        moved |= settle_fact(tx, &fact)?;
    }
    Ok(if moved {
        owner_change(tx, table, local)?.into_iter().collect()
    } else {
        Vec::new()
    })
}

/// One change of this computer's own of a row, still to come back from
/// the stream.
struct Own {
    id: i64,
    state: String,
    revision: i64,
    epoch: Option<i64>,
    frozen: Option<String>,
    actor: String,
}

/// This computer's own changes of row `local`, oldest first: sent or not,
/// deletes and raised revisions left out. A `published` one stored before
/// the stream position would have come back already, so it never counts.
fn own_changes(tx: &Connection, table: &Table, local: i64) -> rusqlite::Result<Vec<Own>> {
    tx.prepare_cached(
        "SELECT id, state, revision, epoch, frozen, actor FROM replica_outbox
          WHERE kind = ?1 AND local_id = ?2 AND change <> 'delete' AND state <> 'raised'
            AND NOT (state = 'published'
                     AND stream_seq <= (SELECT stream_seq FROM replica_state WHERE id = 1))
          ORDER BY id",
    )?
    .query_map(params![table.kind, local], |row| {
        Ok(Own {
            id: row.get(0)?,
            state: row.get(1)?,
            revision: row.get(2)?,
            epoch: row.get(3)?,
            frozen: row.get(4)?,
            actor: row.get(5)?,
        })
    })?
    .collect()
}

/// Whether own change `own` of a row can still decide it once it lands,
/// with the row decided at `revision` so far and fenced at `fence` for the
/// row's role: it can be sent, its revision is at least the deciding one
/// (it lands later, so an equal one wins too), and it is not a dreamer
/// change older than the fence.
fn can_win(own: &Own, revision: i64, fence: Option<i64>) -> bool {
    matches!(own.state.as_str(), "pending" | "sending" | "published")
        && own.revision >= revision
        && !own
            .epoch
            .is_some_and(|epoch| fence.is_some_and(|fence| epoch < fence))
}

/// Whether this computer has a change of row `local` that will still
/// decide it once it lands, over `body`, which decides it now. `body`'s
/// epoch, if any, is already in the row's fence, so an own dreamer change
/// under an older generation never holds it back.
fn own_change_ahead(
    tx: &Connection,
    table: &Table,
    local: i64,
    body: &Body,
) -> rusqlite::Result<bool> {
    let fence = match local_role(tx, table, local)? {
        Some(role) => fence_of(tx, &body.global_id, &role)?,
        None => None,
    };
    Ok(own_changes(tx, table, local)?
        .iter()
        .any(|own| can_win(own, body.revision, fence)))
}

/// After the stream's deciding message or fence for row `local` moved, or
/// one of this computer's own changes of it turned out impossible to send:
/// bring the row to what it will end as on every computer.
///
/// An own change that can no longer win goes (one sent or being sent stays
/// until it comes back, and is settled then). A change that can't be sent
/// loses too when this computer passed over another computer's change for
/// it. The row then shows the newest own change that can still win: a
/// frozen one's snapshot when a newer one went. With none left, it shows
/// what decides it on every computer: the passed-over arrival kept for it
/// (`replica_passed`), or, when the own change was written over an arrival
/// applied here before, that arrival read again from the stream
/// (`replica_restore`, [`Replica::restore`]).
fn reconcile(
    tx: &Connection,
    box_id: &str,
    table: &Table,
    local: i64,
) -> rusqlite::Result<Vec<Change>> {
    let Some(global) = tx
        .query_row(
            &format!("SELECT global_id FROM {} WHERE id = ?1", table.name),
            [local],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten()
    else {
        return Ok(Vec::new());
    };
    let found = known(tx, &global)?;
    let revision = found.as_ref().and_then(|found| found.revision).unwrap_or(0);
    let undone = found.as_ref().and_then(|found| found.undone).unwrap_or(0);
    let fence = match local_role(tx, table, local)? {
        Some(role) => fence_of(tx, &global, &role)?,
        None => None,
    };
    let passed: Option<(i64, String)> = tx
        .query_row(
            "SELECT seq, body FROM replica_passed WHERE global_id = ?1",
            [&global],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let owns = own_changes(tx, table, local)?;
    let lost = |own: &Own| {
        !can_win(own, revision, fence)
            && (matches!(own.state.as_str(), "pending" | "sending" | "published")
                || passed.is_some())
    };
    let Some(newest_lost) = owns.iter().filter(|own| lost(own)).map(|own| own.id).max() else {
        return Ok(Vec::new());
    };
    let target = owns
        .iter()
        .filter(|own| can_win(own, revision, fence))
        .max_by_key(|own| own.id);
    for own in owns.iter().filter(|own| lost(own)) {
        if !matches!(own.state.as_str(), "sending" | "published") {
            tx.execute("DELETE FROM replica_outbox WHERE id = ?1", [own.id])?;
        }
    }
    match target {
        // Newer than every change that went, or every one that went was
        // undone already: the row shows it.
        Some(target) if target.id > newest_lost || undone >= newest_lost => Ok(Vec::new()),
        Some(target) => {
            let snapshot = target
                .frozen
                .as_deref()
                .and_then(|frozen| serde_json::from_str::<Option<Map<String, Value>>>(frozen).ok())
                .flatten();
            let Some(snapshot) = snapshot else {
                return Ok(Vec::new());
            };
            let undone_body = Body {
                kind: table.kind.to_owned(),
                global_id: global,
                revision: target.revision,
                base_revision: target.revision,
                change: "update".into(),
                writer: wire::Writer {
                    box_id: box_id.to_owned(),
                    store_id: super::store_id(tx)?,
                    actor: target.actor.clone(),
                    dreamer_epoch: target.epoch,
                },
                snapshot: Some(snapshot),
            };
            let changes = apply_snapshot(tx, table, local, &undone_body, 0, UNDONE)?;
            tx.execute(
                "UPDATE replica_ids SET undone = ?2 WHERE global_id = ?1",
                params![undone_body.global_id, newest_lost],
            )?;
            Ok(changes)
        }
        None => match passed {
            Some((seq, text)) => {
                tx.execute("DELETE FROM replica_passed WHERE global_id = ?1", [&global])?;
                let Ok(body) = serde_json::from_str::<Body>(&text) else {
                    return Ok(Vec::new());
                };
                let changes = apply_snapshot(tx, table, local, &body, seq as u64, FROM_ANOTHER)?;
                written(tx, &global, None)?;
                Ok(changes)
            }
            None => {
                // Only a change written over the deciding message's content
                // hides it; one that message was written over shows it
                // already.
                let under = found.as_ref().and_then(|found| found.written).unwrap_or(0);
                let seq = found.as_ref().and_then(|found| found.seq);
                if let (Some(seq), true) = (seq, newest_lost > under.max(undone)) {
                    tx.execute(
                        "INSERT OR REPLACE INTO replica_restore (global_id, seq) VALUES (?1, ?2)",
                        params![global, seq],
                    )?;
                }
                Ok(Vec::new())
            }
        },
    }
}

/// [`reconcile`] for row `local_id` of `kind` after one of this computer's
/// own changes of it turned out impossible to send ([`super::publish`]),
/// under the apply marker, so the capture triggers stay quiet.
pub(crate) fn reconcile_after_send(
    tx: &Connection,
    box_id: &str,
    kind: &str,
    local_id: i64,
) -> rusqlite::Result<Vec<Change>> {
    tx.execute("INSERT INTO replica_applying (applying) VALUES (1)", [])?;
    let changes = reconcile(tx, box_id, table(kind), local_id)?;
    tx.execute("DELETE FROM replica_applying", [])?;
    Ok(changes)
}

/// The change notice for row `local`'s owner, as a local write of its kind
/// reports it.
fn owner_change(tx: &Connection, table: &Table, local: i64) -> rusqlite::Result<Option<Change>> {
    match table.kind {
        "memory" => tx
            .query_row(
                "SELECT level, owner_id FROM memories WHERE id = ?1",
                [local],
                |row| {
                    Ok(Change::Memories {
                        level: row.get(0)?,
                        owner: row.get(1)?,
                    })
                },
            )
            .optional(),
        "observation" => Ok(Some(Change::global_memories())),
        _ => tx
            .query_row(
                "SELECT project_path FROM primers WHERE id = ?1",
                [local],
                |row| Ok(Change::project_memories(&row.get::<_, String>(0)?)),
            )
            .optional(),
    }
}

/// Columns a snapshot carries as plain values.
fn plain(table: &Table) -> Vec<&'static str> {
    table
        .replicated
        .iter()
        .copied()
        .filter(|column| {
            !(table.kind == MEMORIES.kind
                && (LINK_COLUMNS.contains(column)
                    || matches!(*column, "merged_from" | "metadata_json")))
        })
        .collect()
}

/// The local id of memory `global`, if it is here.
fn local_memory(tx: &Connection, global: &str) -> rusqlite::Result<Option<i64>> {
    tx.query_row(
        "SELECT r.local_id FROM replica_ids r JOIN memories m ON m.id = r.local_id
          WHERE r.global_id = ?1 AND r.kind = 'memory' AND r.deleted_at IS NULL",
        [global],
        |row| row.get(0),
    )
    .optional()
}

fn pend(
    tx: &Connection,
    local: i64,
    field: &str,
    target: &str,
    detail: Option<&str>,
) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT OR IGNORE INTO replica_pending_links (kind, local_id, field, target_global_id, detail)
         VALUES ('memory', ?1, ?2, ?3, ?4)",
        params![local, field, target, detail],
    )?;
    Ok(())
}

/// A memory snapshot's links as local ids: the ones here now, with the
/// rest recorded as pending for row `local`.
struct Links {
    superseded_by: Option<i64>,
    overrides: Option<i64>,
    merged_from: Option<String>,
}

fn links(tx: &Connection, local: i64, snapshot: &Map<String, Value>) -> rusqlite::Result<Links> {
    tx.execute(
        "DELETE FROM replica_pending_links WHERE kind = 'memory' AND local_id = ?1",
        [local],
    )?;
    let single = |column: &str| -> rusqlite::Result<Option<i64>> {
        let Some(target) = snapshot.get(column).and_then(Value::as_str) else {
            return Ok(None);
        };
        let found = local_memory(tx, target)?;
        if found.is_none() {
            pend(tx, local, column, target, None)?;
        }
        Ok(found)
    };
    let superseded_by = single(LINK_COLUMNS[0])?;
    let overrides = single(LINK_COLUMNS[1])?;
    let merged_from = match snapshot.get("merged_from").and_then(Value::as_array) {
        None => None,
        Some(sources) => {
            let mut ids = Vec::new();
            for source in sources.iter().filter_map(Value::as_str) {
                match local_memory(tx, source)? {
                    Some(id) => ids.push(id),
                    None => pend(tx, local, "merged_from", source, None)?,
                }
            }
            ids.sort_unstable();
            ids.dedup();
            Some(serde_json::to_string(&ids).expect("ids serialize"))
        }
    };
    Ok(Links {
        superseded_by,
        overrides,
        merged_from,
    })
}

/// Whether a status keeps a memory live, as the store's unique key counts
/// it ([`crate::context_migrations::LIVE`]).
fn is_live(status: Option<&str>) -> bool {
    matches!(status, None | Some("active" | "permanent"))
}

/// The status column's value a memory snapshot is written with. A live
/// snapshot is written archived at first, so two live rows never hold one
/// fact even for a moment, and [`settle_fact`] then decides which stays.
fn written_status(table: &Table, snapshot: &Map<String, Value>) -> Option<Sql> {
    if table.kind != MEMORIES.kind {
        return None;
    }
    let status = snapshot.get("status").and_then(Value::as_str);
    is_live(status).then(|| Sql::Text("archived".into()))
}

/// After a memory snapshot was written: its own status and successor, as
/// the snapshot gave them, are kept aside while it is written archived
/// ([`written_status`]), for [`settle_fact`] to put back or keep aside.
fn keep_own_state(
    tx: &Connection,
    local: i64,
    snapshot: &Map<String, Value>,
) -> rusqlite::Result<()> {
    let status = snapshot.get("status").and_then(Value::as_str);
    if is_live(status) {
        tx.execute(
            "INSERT INTO replica_derived (local_id, survivor, status, superseded_by)
             SELECT id, NULL, ?2, superseded_by_memory_id FROM memories WHERE id = ?1
             ON CONFLICT (local_id) DO UPDATE SET
                 survivor = NULL, status = excluded.status, superseded_by = excluded.superseded_by",
            params![local, status],
        )?;
    } else {
        tx.execute("DELETE FROM replica_derived WHERE local_id = ?1", [local])?;
    }
    Ok(())
}

/// A new row for an arrival. Read counters start as for a fresh row, and
/// an observation's session is empty: both are this computer's own.
fn insert(
    tx: &Connection,
    table: &Table,
    body: &Body,
    snapshot: &Map<String, Value>,
) -> rusqlite::Result<i64> {
    let now = now_ms();
    let mut columns: Vec<String> = Vec::new();
    let mut values: Vec<Sql> = Vec::new();
    let status = written_status(table, snapshot);
    for column in plain(table) {
        if let Some(value) = snapshot.get(column) {
            columns.push(column.to_owned());
            values.push(match (&status, column) {
                (Some(status), "status") => status.clone(),
                _ => to_sql(value),
            });
        }
    }
    if status.is_some() && !snapshot.contains_key("status") {
        columns.push("status".into());
        values.push(Sql::Text("archived".into()));
    }
    let extra: &[(&str, Sql)] = match table.kind {
        "memory" => &[
            ("last_seen_at", Sql::Integer(now)),
            ("updated_at", Sql::Integer(now)),
        ],
        "observation" => &[("session_id", Sql::Text(String::new()))],
        _ => &[("updated_at", Sql::Integer(now))],
    };
    for (column, value) in extra {
        columns.push((*column).to_owned());
        values.push(value.clone());
    }
    columns.push("global_id".into());
    values.push(Sql::Text(body.global_id.clone()));
    columns.push("revision".into());
    values.push(Sql::Integer(body.revision.max(1)));
    if table.kind == MEMORIES.kind {
        columns.push("metadata_json".into());
        values.push(
            match merged_metadata(snapshot.get("metadata_json").unwrap_or(&Value::Null), None) {
                Some(text) => Sql::Text(text),
                None => Sql::Null,
            },
        );
    }
    tx.execute(
        &format!(
            "INSERT INTO {} ({}) VALUES ({})",
            table.name,
            columns.join(", "),
            vec!["?"; columns.len()].join(", ")
        ),
        params_from_iter(values),
    )?;
    let local = tx.last_insert_rowid();
    tx.execute(
        "INSERT OR REPLACE INTO replica_ids (kind, global_id, local_id) VALUES (?1, ?2, ?3)",
        params![table.kind, body.global_id, local],
    )?;
    if table.kind == MEMORIES.kind {
        set_links(tx, local, snapshot)?;
        keep_own_state(tx, local, snapshot)?;
        if let Some(fact) = fact_of(tx, local)? {
            settle_fact(tx, &fact)?;
        }
    }
    Ok(local)
}

fn set_links(tx: &Connection, local: i64, snapshot: &Map<String, Value>) -> rusqlite::Result<()> {
    let links = links(tx, local, snapshot)?;
    tx.execute(
        "UPDATE memories SET superseded_by_memory_id = ?2, overrides_memory_id = ?3, merged_from = ?4
          WHERE id = ?1",
        params![local, links.superseded_by, links.overrides, links.merged_from],
    )?;
    Ok(())
}

/// Replace row `local`'s replicated fields with an arrival's. Its revision
/// rises past both its own and the message's, so a later change of this
/// computer's own is never sent under a revision already in the stream;
/// a memory's clause evidence goes with it when its text stays.
fn update(
    tx: &Connection,
    table: &Table,
    local: i64,
    body: &Body,
    snapshot: &Map<String, Value>,
    why: &str,
) -> rusqlite::Result<()> {
    let memory = table.kind == MEMORIES.kind;
    let before = if memory {
        crate::memory_writes::history_snapshot(tx, local)?
    } else {
        None
    };
    let fact_before = if memory { fact_of(tx, local)? } else { None };
    let (text_column, old_text, old_question, metadata, old_revision): (
        &str,
        Option<String>,
        Option<String>,
        Option<String>,
        i64,
    ) = match table.kind {
        "memory" => tx.query_row(
            "SELECT content, metadata_json, revision FROM memories WHERE id = ?1",
            [local],
            |row| Ok(("content", row.get(0)?, None, row.get(1)?, row.get(2)?)),
        )?,
        "observation" => tx.query_row(
            "SELECT content, revision FROM memory_observations WHERE id = ?1",
            [local],
            |row| Ok(("content", row.get(0)?, None, None, row.get(1)?)),
        )?,
        _ => tx.query_row(
            "SELECT answer, question, revision FROM primers WHERE id = ?1",
            [local],
            |row| Ok(("answer", row.get(0)?, row.get(1)?, None, row.get(2)?)),
        )?,
    };
    let status = written_status(table, snapshot);
    let mut sets: Vec<String> = Vec::new();
    let mut values: Vec<Sql> = Vec::new();
    for column in plain(table) {
        if let Some(value) = snapshot.get(column) {
            values.push(match (&status, column) {
                (Some(status), "status") => status.clone(),
                _ => to_sql(value),
            });
            sets.push(format!("{column} = ?{}", values.len()));
        }
    }
    if let (Some(status), false) = (&status, snapshot.contains_key("status")) {
        values.push(status.clone());
        sets.push(format!("status = ?{}", values.len()));
    }
    values.push(Sql::Integer(body.revision));
    sets.push(format!("revision = MAX(revision + 1, ?{})", values.len()));
    if table.kind != OBSERVATIONS.kind {
        values.push(Sql::Integer(now_ms()));
        sets.push(format!("updated_at = ?{}", values.len()));
    }
    if memory {
        values.push(
            match merged_metadata(
                snapshot.get("metadata_json").unwrap_or(&Value::Null),
                metadata.as_deref(),
            ) {
                Some(text) => Sql::Text(text),
                None => Sql::Null,
            },
        );
        sets.push(format!("metadata_json = ?{}", values.len()));
    }
    values.push(Sql::Integer(local));
    tx.execute(
        &format!(
            "UPDATE {} SET {} WHERE id = ?{}",
            table.name,
            sets.join(", "),
            values.len()
        ),
        params_from_iter(values),
    )?;
    let new_text = snapshot.get(text_column).and_then(Value::as_str);
    let text_changed = new_text.is_some() && new_text != old_text.as_deref();
    match table.kind {
        "memory" => {
            if !text_changed {
                tx.execute(
                    &super::schema::carry_evidence("?1", "?2", "m.revision", "1"),
                    params![local, old_revision],
                )?;
            }
            set_links(tx, local, snapshot)?;
            keep_own_state(tx, local, snapshot)?;
            let fact = fact_of(tx, local)?;
            if let Some(fact) = &fact {
                settle_fact(tx, fact)?;
            }
            if let Some(old) = fact_before.filter(|old| Some(old) != fact.as_ref()) {
                settle_fact(tx, &old)?;
            }
            if text_changed {
                tx.execute(
                    "DELETE FROM memory_embeddings WHERE memory_id = ?1",
                    [local],
                )?;
                let after = crate::memory_writes::history_snapshot(tx, local)?;
                superseded(
                    tx,
                    local,
                    body,
                    before,
                    after,
                    old_text.unwrap_or_default(),
                    why,
                )?;
            }
        }
        "primer" => {
            let question = snapshot.get("question").and_then(Value::as_str);
            if question.is_some() && question != old_question.as_deref() {
                // The question's vector was made from the old text.
                tx.execute(
                    "UPDATE primers SET question_embedding = NULL, question_embedding_model_id = NULL
                      WHERE id = ?1",
                    [local],
                )?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// Record the text an arrival replaced as a superseded revision of the
/// memory's history, with `why` as its reason.
fn superseded(
    tx: &Connection,
    local: i64,
    body: &Body,
    before: Option<Value>,
    after: Option<Value>,
    previous: String,
    why: &str,
) -> rusqlite::Result<()> {
    let revision = before
        .as_ref()
        .and_then(|before| before["revision"].as_i64())
        .unwrap_or(0);
    let after_text = after
        .as_ref()
        .and_then(|after| after["content"].as_str())
        .unwrap_or_default()
        .to_owned();
    tx.execute(
        "INSERT OR IGNORE INTO memory_history(memory_id, revision, previous_text, after_text,
             before_json, after_json, applied_at, reason, evidence_json, source_ids_json, decision_key)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?10, ?8, '[]', ?9)",
        params![
            local,
            revision,
            previous,
            after_text,
            crate::memory_writes::history_json(&json!({"version": 1, "snapshot": before})),
            crate::memory_writes::history_json(&json!({"version": 1, "snapshot": after})),
            now_ms(),
            crate::memory_writes::history_json(&json!({
                "globalId": body.global_id,
                "revision": body.revision,
                "boxId": body.writer.box_id,
            })),
            decision_key(body),
            why,
        ],
    )?;
    Ok(())
}

fn decision_key(body: &Body) -> String {
    format!("replica:{}@{}", body.global_id, body.revision)
}

/// A text-free journal entry for an applied memory arrival, so the change
/// counts as a memory write for the memory-changed wake's revision.
fn journal(
    tx: &Connection,
    local: i64,
    body: &Body,
    seq: u64,
    operation: &str,
) -> rusqlite::Result<()> {
    let owner: Option<String> = tx
        .query_row(
            "SELECT owner_id FROM memories WHERE id = ?1",
            [local],
            |row| row.get(0),
        )
        .optional()?;
    journal_for(
        tx,
        owner.as_deref().unwrap_or_default(),
        local,
        body,
        seq,
        operation,
    )
}

fn journal_for(
    tx: &Connection,
    owner: &str,
    local: i64,
    body: &Body,
    seq: u64,
    operation: &str,
) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT OR IGNORE INTO memory_journal (project_path, decision_key, operation, receipt_json, applied_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            owner,
            format!("{}:{seq}", decision_key(body)),
            operation,
            json!({
                "state": "applied",
                "from": "another computer",
                "boxId": body.writer.box_id,
                "globalId": body.global_id,
                "revision": body.revision,
                "change": body.change,
                "memoryId": local,
            })
            .to_string(),
            now_ms(),
        ],
    )?;
    Ok(())
}

/// A memory snapshot's child rows: its file mappings and the memories it
/// replaced replace this computer's; its conflicts are added.
fn children(tx: &Connection, local: i64, snapshot: &Map<String, Value>) -> rusqlite::Result<()> {
    if let Some(files) = snapshot.get("files").and_then(Value::as_array) {
        tx.execute(
            "DELETE FROM memory_verifications WHERE memory_id = ?1",
            [local],
        )?;
        for file in files {
            tx.execute(
                "INSERT OR REPLACE INTO memory_verifications
                     (memory_id, file_path, verified_at, mapped_at, mapping_origin)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    local,
                    file["file_path"].as_str().unwrap_or_default(),
                    file["verified_at"].as_i64().unwrap_or(0),
                    file["mapped_at"].as_i64().unwrap_or(0),
                    file["mapping_origin"].as_str().unwrap_or("mapper"),
                ],
            )?;
        }
    }
    if let Some(sources) = snapshot.get("supersedes").and_then(Value::as_array) {
        tx.execute(
            "DELETE FROM memory_successor_links WHERE successor_id = ?1",
            [local],
        )?;
        for link in sources {
            let (Some(source), key) = (link["source"].as_str(), link["decision_key"].as_str())
            else {
                continue;
            };
            let key = key.unwrap_or_default();
            match local_memory(tx, source)? {
                Some(source) => successor(tx, source, local, key)?,
                None => pend(tx, local, "supersedes", source, Some(key))?,
            }
        }
    }
    if let Some(conflicts) = snapshot.get("conflicts").and_then(Value::as_array) {
        for link in conflicts {
            let (Some(other), key) = (link["other"].as_str(), link["decision_key"].as_str()) else {
                continue;
            };
            let key = key.unwrap_or_default();
            match local_memory(tx, other)? {
                Some(other) => conflict(tx, local, other, key)?,
                None => pend(tx, local, "conflicts", other, Some(key))?,
            }
        }
    }
    Ok(())
}

fn successor(tx: &Connection, source: i64, successor: i64, key: &str) -> rusqlite::Result<()> {
    if source != successor {
        tx.execute(
            "INSERT OR IGNORE INTO memory_successor_links (source_id, successor_id, decision_key)
             VALUES (?1, ?2, ?3)",
            params![source, successor, key],
        )?;
    }
    Ok(())
}

fn conflict(tx: &Connection, one: i64, other: i64, key: &str) -> rusqlite::Result<()> {
    if one != other {
        tx.execute(
            "INSERT OR IGNORE INTO memory_conflict_links (left_id, right_id, decision_key)
             VALUES (?1, ?2, ?3)",
            params![one.min(other), one.max(other), key],
        )?;
    }
    Ok(())
}

/// Make the links that waited for `global`, now that it names `target`. A
/// memory archived because another holds its fact keeps the successor it
/// waited for aside, as its own, until it is live again.
fn resolve_pending(tx: &Connection, global: &str, target: i64) -> rusqlite::Result<()> {
    let waiting: Vec<(i64, String, Option<String>)> = tx
        .prepare(
            "SELECT local_id, field, detail FROM replica_pending_links
              WHERE target_global_id = ?1 AND kind = 'memory'",
        )?
        .query_map([global], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (local, field, detail) in waiting {
        if !exists(tx, &MEMORIES, local)? || !exists(tx, &MEMORIES, target)? {
            continue;
        }
        let key = detail.as_deref().unwrap_or_default();
        match field.as_str() {
            "superseded_by_memory_id" => {
                let aside = tx.execute(
                    "UPDATE replica_derived SET superseded_by = ?2 WHERE local_id = ?1",
                    params![local, target],
                )?;
                if aside == 0 {
                    tx.execute(
                        "UPDATE memories SET superseded_by_memory_id = ?2 WHERE id = ?1",
                        params![local, target],
                    )?;
                }
            }
            "overrides_memory_id" => {
                tx.execute(
                    "UPDATE memories SET overrides_memory_id = ?2 WHERE id = ?1",
                    params![local, target],
                )?;
            }
            "merged_from" => {
                let merged: Option<String> = tx.query_row(
                    "SELECT merged_from FROM memories WHERE id = ?1",
                    [local],
                    |row| row.get(0),
                )?;
                let mut ids: Vec<i64> = merged
                    .as_deref()
                    .and_then(|text| serde_json::from_str::<Vec<Value>>(text).ok())
                    .unwrap_or_default()
                    .iter()
                    .filter_map(Value::as_i64)
                    .collect();
                ids.push(target);
                ids.sort_unstable();
                ids.dedup();
                tx.execute(
                    "UPDATE memories SET merged_from = ?2 WHERE id = ?1",
                    params![local, serde_json::to_string(&ids).expect("ids serialize")],
                )?;
            }
            "supersedes" => successor(tx, target, local, key)?,
            "conflicts" => conflict(tx, local, target, key)?,
            _ => {}
        }
    }
    tx.execute(
        "DELETE FROM replica_pending_links WHERE target_global_id = ?1 AND kind = 'memory'",
        [global],
    )?;
    Ok(())
}

/// Delete row `local` for a tombstone, as the person's delete does, and
/// mark its global id deleted. This computer's own sends of the row stay in
/// the outbox until the stream delivers them back, so it knows them.
fn tombstone(
    tx: &Transaction,
    table: &Table,
    body: &Body,
    subject: &str,
    local: Option<i64>,
) -> rusqlite::Result<Vec<Change>> {
    let now = now_ms();
    let (level, owner) = subject_owner(subject);
    let mut changes = Vec::new();
    if let Some(local) = local {
        changes.extend(owner_change(tx, table, local)?);
        match table.kind {
            "memory" => {
                let owner: String = tx.query_row(
                    "SELECT owner_id FROM memories WHERE id = ?1",
                    [local],
                    |row| row.get(0),
                )?;
                let fact = fact_of(tx, local)?;
                crate::memory_writes::person::purge(tx, local)?;
                tx.execute("DELETE FROM replica_derived WHERE local_id = ?1", [local])?;
                survivor_gone(tx, local)?;
                if let Some(fact) = fact {
                    settle_fact(tx, &fact)?;
                }
                journal_for(tx, &owner, local, body, 0, "replica_delete")?;
            }
            _ => {
                tx.execute(
                    &format!("DELETE FROM {} WHERE id = ?1", table.name),
                    [local],
                )?;
            }
        }
        tx.execute(
            "DELETE FROM replica_outbox
              WHERE kind = ?1 AND local_id = ?2 AND state NOT IN ('sending', 'published')",
            params![table.kind, local],
        )?;
        tx.execute(
            "DELETE FROM replica_pending_links WHERE kind = ?1 AND local_id = ?2",
            params![table.kind, local],
        )?;
    }
    tx.execute(
        "INSERT INTO replica_ids (kind, global_id, local_id, deleted_at, level, owner)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (global_id) DO UPDATE SET deleted_at = excluded.deleted_at,
             level = excluded.level, owner = excluded.owner",
        params![table.kind, body.global_id, local, now, level, owner],
    )?;
    tx.execute(
        "DELETE FROM replica_pending_links WHERE target_global_id = ?1",
        [&body.global_id],
    )?;
    for gone in ["replica_passed", "replica_restore", "replica_fences"] {
        tx.execute(
            &format!("DELETE FROM {gone} WHERE global_id = ?1"),
            [&body.global_id],
        )?;
    }
    Ok(changes)
}

/// The fact a memory holds, as the store's unique key counts it: its
/// level, owner, category and normalized text.
#[derive(Debug, PartialEq, Eq)]
struct Fact {
    level: String,
    owner: String,
    category: String,
    hash: String,
}

fn fact_of(tx: &Connection, local: i64) -> rusqlite::Result<Option<Fact>> {
    tx.query_row(
        "SELECT level, owner_id, category, normalized_hash FROM memories WHERE id = ?1",
        [local],
        |row| {
            Ok(Fact {
                level: row.get(0)?,
                owner: row.get(1)?,
                category: row.get(2)?,
                hash: row.get(3)?,
            })
        },
    )
    .optional()
}

/// One memory holding a fact, live by its own state.
struct Holder {
    id: i64,
    global: Option<String>,
    /// Live as the row stands, not archived here for another row.
    live_here: bool,
    /// Archived here for another row, its own state kept aside.
    aside: bool,
}

/// Leave one live memory for `fact`: of the memories whose own state holds
/// it live, the one with the lowest global id; a memory never sent loses to
/// any sent one (once sent, its own message coming back decides again,
/// [`settled`]). The others are archived, superseded by it, with their own
/// state kept aside to be sent and put back if the fact frees up. Every
/// computer derives the same from the ids, so nothing of it is sent.
/// Losers are archived before the survivor is made live, so the store's
/// unique key never sees two. Returns whether anything changed.
fn settle_fact(tx: &Connection, fact: &Fact) -> rusqlite::Result<bool> {
    // Each memory holding the fact: its id, global id and status, whether
    // its own state is kept aside, and that own status.
    type Row = (i64, Option<String>, Option<String>, bool, Option<String>);
    let rows: Vec<Row> = tx
        .prepare(
            "SELECT m.id, m.global_id, m.status, d.local_id IS NOT NULL, d.status
               FROM memories m LEFT JOIN replica_derived d ON d.local_id = m.id
              WHERE m.level = ?1 AND m.owner_id = ?2 AND m.category = ?3 AND m.normalized_hash = ?4
              ORDER BY m.id",
        )?
        .query_map(
            params![fact.level, fact.owner, fact.category, fact.hash],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )?
        .collect::<rusqlite::Result<_>>()?;
    let mut changed = false;
    let mut holders = Vec::new();
    for (id, global, status, aside, own_status) in rows {
        let own = if aside {
            own_status.as_deref()
        } else {
            status.as_deref()
        };
        if is_live(own) {
            holders.push(Holder {
                id,
                global,
                live_here: !aside && is_live(status.as_deref()),
                aside,
            });
        } else if aside {
            // Its own state no longer holds the fact: nothing to keep aside.
            changed |= put_back(tx, id)?;
        }
    }
    let survivor = holders
        .iter()
        .filter(|holder| holder.global.is_some())
        .min_by(|a, b| a.global.cmp(&b.global))
        .or_else(|| holders.iter().find(|holder| holder.live_here))
        .or_else(|| holders.first())
        .map(|holder| holder.id);
    let Some(survivor) = survivor else {
        return Ok(changed);
    };
    for holder in holders.iter().filter(|holder| holder.id != survivor) {
        changed |= set_aside(tx, holder.id, survivor)?;
    }
    if holders
        .iter()
        .any(|holder| holder.id == survivor && holder.aside)
    {
        changed |= put_back(tx, survivor)?;
    }
    Ok(changed)
}

/// Archive memory `id` for `survivor`, keeping its own state aside.
fn set_aside(tx: &Connection, id: i64, survivor: i64) -> rusqlite::Result<bool> {
    tx.execute(
        "INSERT INTO replica_derived (local_id, survivor, status, superseded_by)
         SELECT id, ?2, status, superseded_by_memory_id FROM memories WHERE id = ?1
         ON CONFLICT (local_id) DO UPDATE SET survivor = excluded.survivor",
        params![id, survivor],
    )?;
    let changed = tx.execute(
        "UPDATE memories SET status = 'archived', superseded_by_memory_id = ?2
          WHERE id = ?1 AND (status IS NOT 'archived' OR superseded_by_memory_id IS NOT ?2)",
        params![id, survivor],
    )?;
    Ok(changed > 0)
}

/// Give memory `id` back its own status and successor.
fn put_back(tx: &Connection, id: i64) -> rusqlite::Result<bool> {
    let changed = tx.execute(
        "UPDATE memories
            SET status = (SELECT status FROM replica_derived WHERE local_id = ?1),
                superseded_by_memory_id =
                    (SELECT superseded_by FROM replica_derived WHERE local_id = ?1)
          WHERE id = ?1 AND EXISTS (SELECT 1 FROM replica_derived WHERE local_id = ?1)",
        [id],
    )?;
    tx.execute("DELETE FROM replica_derived WHERE local_id = ?1", [id])?;
    Ok(changed > 0)
}

/// Memory `local` is gone or holds another fact now: the facts of the
/// memories archived for it are decided again. Returns whether anything
/// changed.
fn survivor_gone(tx: &Connection, local: i64) -> rusqlite::Result<bool> {
    let aside: Vec<i64> = tx
        .prepare("SELECT local_id FROM replica_derived WHERE survivor = ?1")?
        .query_map([local], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut changed = false;
    for id in aside {
        if let Some(fact) = fact_of(tx, id)? {
            changed |= settle_fact(tx, &fact)?;
        }
    }
    Ok(changed)
}
