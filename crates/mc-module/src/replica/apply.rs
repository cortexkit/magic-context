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
//!   open anything for now) ends the round instead, and is read again on
//!   the next one.
//! - This computer's own messages come back too. One it knows, because its
//!   outbox still waits for it, only advances the position and settles the
//!   outbox. One it doesn't know was sent by an earlier or later state of
//!   this store (a store made anew, or restored from a copy), and is
//!   applied like anyone else's; when it was formed under this store's
//!   current store id, the store takes a new one, so no id that state may
//!   have sent is sent again for another row.
//! - An unknown global id is a new row; a known one's snapshot replaces the
//!   row's replicated fields, even when it was based on an older revision
//!   than this computer's: stream order decides, the same on every
//!   computer. Replaced text goes to `memory_history`, where the dreamer's
//!   curate task, which tidies an owner's memories, sees it. The one
//!   exception is a row with a change of this computer's own that the
//!   stream hasn't delivered back yet: that change is later in the stream,
//!   so it is the one every computer ends with, and the arrival is skipped.
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
//!   its global id deleted, so a late snapshot never brings it back. Any
//!   arrival for a deleted id is skipped.
//! - An applied change is reported like a local write of its kind
//!   ([`ContextDb::changed`]), so the apps reload and the memory-changed
//!   wake goes out, and heads show it as an ordinary memory delta. It never
//!   changes `project_memory_epoch`.

use rusqlite::types::Value as Sql;
use rusqlite::{
    params, params_from_iter, Connection, OptionalExtension, Transaction, TransactionBehavior,
};
use serde_json::{json, Map, Value};

use super::hub::HubMessage;
use super::schema::{Table, MEMORIES, OBSERVATIONS};
use super::seal::{OpenInput, Opened};
use super::snapshot::{merged_metadata, to_sql, LINK_COLUMNS};
use super::wire::{self, Body, Envelope};
use super::{table, Replica, BATCH};
use crate::app_read::Change;
use crate::memory_writes::now_ms;

/// The vault's refusal class for an item that can never open as it is.
/// Any other class (`transient`, `auth_required`, `context_overflow`, or a
/// class this build doesn't know) is a condition of the vault or of this
/// computer, so the message is read again later.
const FINAL_REFUSAL: &str = "permanent";

impl Replica {
    /// Read and apply the next messages after this computer's position.
    /// Returns how many were read. A round that can't apply a message for
    /// this computer's own reasons stops before it, with the position
    /// after the last message applied, to read it again.
    pub async fn follow(&self) -> Result<usize, String> {
        let after = self.position()?;
        let messages = self
            .hub
            .fetch(after, BATCH)
            .await
            .map_err(|error| format!("reading the stream: {error}"))?;
        if messages.is_empty() {
            return Ok(0);
        }
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
            self.sealer
                .open_batch(&inputs)
                .await
                .map_err(|error| format!("opening: {error}"))?
        };
        let mut opened = opened.into_iter();
        for (message, envelope) in messages.iter().zip(envelopes) {
            let body = match envelope {
                Err(reason) => Err(reason),
                Ok(envelope) => match opened.next() {
                    Some(Opened::Plaintext(bytes)) => decode(&bytes, &envelope, &message.subject),
                    Some(Opened::Refused { code, class }) if class == FINAL_REFUSAL => {
                        Err(format!("not opened: {code}"))
                    }
                    Some(Opened::Refused { code, class }) => {
                        return Err(format!(
                        "opening {}: the vault answered {code} ({class}); it is read again later",
                        message.seq
                    ))
                    }
                    None => return Err(format!("opening {}: no answer for it", message.seq)),
                },
            };
            let changes = self
                .db
                .with_connection(|conn| apply_message(conn, &self.box_id, message, body))
                .map_err(|error| format!("applying {}: {error}", message.seq))?;
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
/// `kind`, as its `NOT NULL` and `CHECK` constraints say, so applying a
/// valid message never fails on the message's account.
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
/// message stays, and it is read again on the next round.
fn apply_message(
    conn: &mut Connection,
    box_id: &str,
    message: &HubMessage,
    body: Result<Body, String>,
) -> rusqlite::Result<Vec<Change>> {
    let global = body.as_ref().ok().map(|body| body.global_id.clone());
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute("INSERT INTO replica_applying (applying) VALUES (1)", [])?;
    let applied = match &body {
        Ok(body) => apply_body(&tx, box_id, message.seq, body)?,
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

/// A global id's local row, and when it was deleted.
fn known(tx: &Connection, global: &str) -> rusqlite::Result<Option<(Option<i64>, Option<i64>)>> {
    tx.query_row(
        "SELECT local_id, deleted_at FROM replica_ids WHERE global_id = ?1",
        [global],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
}

fn exists(tx: &Connection, table: &Table, id: i64) -> rusqlite::Result<bool> {
    tx.query_row(
        &format!("SELECT EXISTS(SELECT 1 FROM {} WHERE id = ?1)", table.name),
        [id],
        |row| row.get(0),
    )
}

/// Whether this computer's outbox still waits for its own message `body`:
/// a row for the same global id at that revision or a later one, sent,
/// being sent or changed again since.
fn own_known(tx: &Connection, body: &Body) -> rusqlite::Result<bool> {
    tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM replica_outbox WHERE global_id = ?1 AND revision >= ?2)",
        params![body.global_id, body.revision],
        |row| row.get(0),
    )
}

fn apply_body(tx: &Transaction, box_id: &str, seq: u64, body: &Body) -> rusqlite::Result<Applied> {
    let table = table(&body.kind);
    if body.writer.box_id == box_id {
        if own_known(tx, body)? {
            // This computer's own change is in the stream now: the rows that
            // waited for it are settled.
            tx.execute(
                "DELETE FROM replica_outbox
                  WHERE global_id = ?1 AND state IN ('sending', 'published') AND revision <= ?2",
                params![body.global_id, body.revision],
            )?;
            return settled(tx, table, body).map(Applied::Changed);
        }
        if wire::store_of(&body.global_id) == super::store_id(tx)? {
            super::new_store_id(
                tx,
                "the stream holds a message an earlier or later state of this store sent",
            )?;
        }
    }
    let known = known(tx, &body.global_id)?;
    if let Some((_, Some(_))) = known {
        // Deleted here: no change brings the row back.
        return Ok(Applied::Changed(Vec::new()));
    }
    let local = match known {
        Some((Some(local), _)) if exists(tx, table, local)? => Some(local),
        _ => None,
    };
    if body.change == "delete" {
        return tombstone(tx, table, body, local).map(Applied::Changed);
    }
    let snapshot = body.snapshot.as_ref().expect("checked when decoded");
    let mut changes = Vec::new();
    let local = match local {
        Some(local) => {
            if own_change_ahead(tx, table, local, seq)? {
                return Ok(Applied::Changed(Vec::new()));
            }
            changes.extend(owner_change(tx, table, local)?);
            update(tx, table, local, body, snapshot)?;
            local
        }
        None => insert(tx, table, body, snapshot)?,
    };
    if table.kind == MEMORIES.kind {
        children(tx, local, snapshot)?;
        journal(tx, local, body, seq, "replica_apply")?;
    }
    resolve_pending(tx, &body.global_id, local)?;
    changes.extend(owner_change(tx, table, local)?);
    changes.dedup();
    Ok(Applied::Changed(changes))
}

/// This computer's own message `body` came back. A memory that has its
/// global id in the stream now may win or lose a fact it shares with
/// another row, so that fact is decided again ([`settle_fact`]).
fn settled(tx: &Connection, table: &Table, body: &Body) -> rusqlite::Result<Vec<Change>> {
    if table.kind != MEMORIES.kind {
        return Ok(Vec::new());
    }
    let Some((Some(local), _)) = known(tx, &body.global_id)? else {
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

/// Whether this computer has a change of row `local` the stream hasn't
/// delivered back before `seq`: one not sent yet, being sent, or sent and
/// stored later than `seq`. A `raised` row is a revision raised with
/// nothing replicated changed, so it holds nothing back; it goes, with the
/// rows left behind by the stream's order (a send another computer's
/// message took the id of, a row that can't be sent).
fn own_change_ahead(
    tx: &Connection,
    table: &Table,
    local: i64,
    seq: u64,
) -> rusqlite::Result<bool> {
    let rows: Vec<(i64, String, Option<i64>)> = tx
        .prepare(
            "SELECT id, state, stream_seq FROM replica_outbox WHERE kind = ?1 AND local_id = ?2",
        )?
        .query_map(params![table.kind, local], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut ahead = false;
    for (id, state, stored) in rows {
        match state.as_str() {
            "pending" | "sending" => ahead = true,
            "published" if stored.is_some_and(|stored| stored > seq as i64) => ahead = true,
            _ => {
                tx.execute("DELETE FROM replica_outbox WHERE id = ?1", [id])?;
            }
        }
    }
    Ok(ahead)
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
                superseded(tx, local, body, before, after, old_text.unwrap_or_default())?;
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
/// memory's history.
fn superseded(
    tx: &Connection,
    local: i64,
    body: &Body,
    before: Option<Value>,
    after: Option<Value>,
    previous: String,
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
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'superseded by a change from another computer', ?8, '[]', ?9)",
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
    local: Option<i64>,
) -> rusqlite::Result<Vec<Change>> {
    let now = now_ms();
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
        "INSERT INTO replica_ids (kind, global_id, local_id, deleted_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (global_id) DO UPDATE SET deleted_at = excluded.deleted_at",
        params![table.kind, body.global_id, local, now],
    )?;
    tx.execute(
        "DELETE FROM replica_pending_links WHERE target_global_id = ?1",
        [&body.global_id],
    )?;
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
