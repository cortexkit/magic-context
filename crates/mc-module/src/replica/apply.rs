//! Following the stream: opening each message and applying it.
//!
//! Messages apply in stream order, each in its own transaction that also
//! stores the message's stream sequence, so a restart resumes after the
//! last applied one. The transaction first puts the row of
//! `replica_applying` in place, which keeps every capture trigger quiet:
//! an applied arrival is never sent again ([`super::schema`]).
//!
//! - A message that can't be opened, decoded or applied is recorded in
//!   `replica_rejects` with its sequence and reason, and skipped: one bad
//!   message never stops the stream.
//! - This computer's own messages come back too. They only advance the
//!   position, and settle the outbox rows waiting for them.
//! - An unknown global id is a new row, unless a live row of the same owner
//!   and text is here already: the same fact written on two computers. The
//!   id is then linked to that row, and nothing else changes.
//! - A known global id's snapshot replaces the row's replicated fields,
//!   even when it was based on an older revision than this computer's:
//!   stream order decides, the same on every computer. Replaced text goes
//!   to `memory_history`, where the dreamer's curate sees it. The one
//!   exception is a row with a change of this computer's own that the
//!   stream hasn't delivered back yet: that change is later in the stream,
//!   so it is the one every computer ends with, and the arrival is skipped.
//! - Links map through `replica_ids`. A link to a global id not seen yet
//!   waits in `replica_pending_links` and is made when the id arrives.
//! - A delete removes the row the way the person's delete does, and marks
//!   its global ids deleted, so a late snapshot never brings it back.
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

impl Replica {
    /// Read and apply the next messages after this computer's position.
    /// Returns how many were read. A vault that can't open anything at all
    /// leaves the position where it was, to try again.
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
            let body = envelope.and_then(|envelope| match opened.next() {
                Some(Opened::Plaintext(bytes)) => decode(&bytes, &envelope, &message.subject),
                Some(Opened::Refused { code, .. }) => Err(format!("not opened: {code}")),
                None => Err("not opened".into()),
            });
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
/// subject it came on.
fn decode(bytes: &[u8], envelope: &Envelope, subject: &str) -> Result<Body, String> {
    let body: Body = serde_json::from_slice(bytes).map_err(|_| "not a message body".to_owned())?;
    if body.global_id != envelope.global_id || body.revision != envelope.revision {
        return Err("the body names another message".into());
    }
    let subject_kind = subject.split('.').nth(3).unwrap_or_default();
    let expected = match subject_kind {
        "project" | "workspace" | "global" => "memory",
        other => other,
    };
    if body.kind != expected {
        return Err(format!("a {} body on a {subject_kind} subject", body.kind));
    }
    if body.change != "delete" && body.snapshot.is_none() {
        return Err("no snapshot".into());
    }
    Ok(body)
}

/// What applying one message did.
enum Applied {
    /// Changes to report once the transaction commits.
    Changed(Vec<Change>),
    /// Recorded and skipped, with the reason.
    Skipped(String),
}

/// Apply one message in its own transaction, or record why it was skipped.
/// Either way the stream position moves past it.
fn apply_message(
    conn: &mut Connection,
    box_id: &str,
    message: &HubMessage,
    body: Result<Body, String>,
) -> rusqlite::Result<Vec<Change>> {
    let global = body.as_ref().ok().map(|body| body.global_id.clone());
    let applied = (|| -> rusqlite::Result<Vec<Change>> {
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
    })();
    match applied {
        Ok(changes) => Ok(changes),
        // The transaction rolled back: nothing of the message stayed.
        Err(error) => {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            reject(
                &tx,
                message,
                global.as_deref(),
                &format!("not applied: {error}"),
            )?;
            advance(&tx, message.seq)?;
            tx.commit()?;
            Ok(Vec::new())
        }
    }
}

fn reject(
    tx: &Transaction,
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

fn advance(tx: &Transaction, seq: u64) -> rusqlite::Result<()> {
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

fn apply_body(tx: &Transaction, box_id: &str, seq: u64, body: &Body) -> rusqlite::Result<Applied> {
    if body.writer.box_id == box_id {
        // This computer's own change is in the stream now: the rows that
        // waited for it are settled.
        tx.execute(
            "DELETE FROM replica_outbox
              WHERE global_id = ?1 AND state IN ('sending', 'published') AND revision <= ?2",
            params![body.global_id, body.revision],
        )?;
        return Ok(Applied::Changed(Vec::new()));
    }
    if !matches!(body.kind.as_str(), "memory" | "observation" | "primer") {
        return Ok(Applied::Skipped(format!("unknown kind {}", body.kind)));
    }
    let table = table(&body.kind);
    let known = known(tx, &body.global_id)?;
    if let Some((_, Some(_))) = known {
        return Ok(if body.change == "delete" {
            Applied::Changed(Vec::new())
        } else {
            Applied::Skipped("the row was deleted".into())
        });
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
        None => match same_fact(tx, table, snapshot)? {
            Some(local) => {
                link(tx, table, &body.global_id, local, body.revision)?;
                resolve_pending(tx, &body.global_id, local)?;
                return Ok(Applied::Changed(Vec::new()));
            }
            None => insert(tx, table, body, snapshot)?,
        },
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

/// Whether this computer has a change of row `local` the stream hasn't
/// delivered back before `seq`: one not sent yet, being sent, or sent and
/// stored later than `seq`. Rows left behind by the stream's order (a send
/// another computer's message took the id of, a row that can't be sent) go.
fn own_change_ahead(
    tx: &Transaction,
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

/// A new row for an arrival. Read counters start as for a fresh row, and
/// an observation's session is empty: both are this computer's own.
fn insert(
    tx: &Transaction,
    table: &Table,
    body: &Body,
    snapshot: &Map<String, Value>,
) -> rusqlite::Result<i64> {
    let now = now_ms();
    let mut columns: Vec<String> = Vec::new();
    let mut values: Vec<Sql> = Vec::new();
    for column in plain(table) {
        if let Some(value) = snapshot.get(column) {
            columns.push(column.to_owned());
            values.push(to_sql(value));
        }
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
/// computer's own is never sent under a revision already in the stream.
fn update(
    tx: &Transaction,
    table: &Table,
    local: i64,
    body: &Body,
    snapshot: &Map<String, Value>,
) -> rusqlite::Result<()> {
    let before = if table.kind == MEMORIES.kind {
        crate::memory_writes::history_snapshot(tx, local)?
    } else {
        None
    };
    let (text_column, old_text, old_question, metadata): (
        &str,
        Option<String>,
        Option<String>,
        Option<String>,
    ) = match table.kind {
        "memory" => tx.query_row(
            "SELECT content, metadata_json FROM memories WHERE id = ?1",
            [local],
            |row| Ok(("content", row.get(0)?, None, row.get(1)?)),
        )?,
        "observation" => tx.query_row(
            "SELECT content FROM memory_observations WHERE id = ?1",
            [local],
            |row| Ok(("content", row.get(0)?, None, None)),
        )?,
        _ => tx.query_row(
            "SELECT answer, question FROM primers WHERE id = ?1",
            [local],
            |row| Ok(("answer", row.get(0)?, row.get(1)?, None)),
        )?,
    };
    let mut sets: Vec<String> = Vec::new();
    let mut values: Vec<Sql> = Vec::new();
    for column in plain(table) {
        if let Some(value) = snapshot.get(column) {
            values.push(to_sql(value));
            sets.push(format!("{column} = ?{}", values.len()));
        }
    }
    values.push(Sql::Integer(body.revision));
    sets.push(format!("revision = MAX(revision + 1, ?{})", values.len()));
    if table.kind != OBSERVATIONS.kind {
        values.push(Sql::Integer(now_ms()));
        sets.push(format!("updated_at = ?{}", values.len()));
    }
    if table.kind == MEMORIES.kind {
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
            set_links(tx, local, snapshot)?;
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
    tx: &Transaction,
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

/// Make the links that waited for `global`, now that it names `target`.
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
            "superseded_by_memory_id" | "overrides_memory_id" => {
                tx.execute(
                    &format!("UPDATE memories SET {field} = ?2 WHERE id = ?1"),
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

/// A live row here holding the fact an unknown global id's snapshot holds:
/// the same owner and text (for a primer, its normalized question).
fn same_fact(
    tx: &Connection,
    table: &Table,
    snapshot: &Map<String, Value>,
) -> rusqlite::Result<Option<i64>> {
    let text = |column: &str| snapshot.get(column).and_then(Value::as_str);
    match table.kind {
        "memory" => {
            let live = matches!(text("status"), None | Some("active" | "permanent"));
            let (Some(level), Some(owner), Some(content)) =
                (text("level"), text("owner_id"), text("content"))
            else {
                return Ok(None);
            };
            if !live {
                return Ok(None);
            }
            let hash = crate::memory_writes::normalized_hash(content);
            tx.query_row(
                &format!(
                    "SELECT id FROM memories
                      WHERE level = ?1 AND owner_id = ?2 AND normalized_hash = ?3 AND {}
                      ORDER BY id LIMIT 1",
                    crate::context_migrations::LIVE
                ),
                params![level, owner, hash],
                |row| row.get(0),
            )
            .optional()
        }
        "observation" => {
            let Some(content) = text("content") else {
                return Ok(None);
            };
            tx.query_row(
                "SELECT id FROM memory_observations WHERE content = ?1 ORDER BY id LIMIT 1",
                [content],
                |row| row.get(0),
            )
            .optional()
        }
        _ => {
            let (Some(project), Some(question)) = (text("project_path"), text("question")) else {
                return Ok(None);
            };
            if text("status").is_some_and(|status| status != "active") {
                return Ok(None);
            }
            let wanted = crate::context_db::normalize_primer_question(question);
            let rows: Vec<(i64, String)> = tx
                .prepare(
                    "SELECT id, question FROM primers
                      WHERE project_path = ?1 AND status = 'active' ORDER BY id",
                )?
                .query_map([project], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?;
            Ok(rows
                .into_iter()
                .find(|(_, question)| {
                    crate::context_db::normalize_primer_question(question) == wanted
                })
                .map(|(id, _)| id))
        }
    }
}

/// Link `global` to row `local`, the same fact this computer holds. A row
/// of this computer's that was never sent takes that id, so its own later
/// changes reach the computers that know the fact by it, under a revision
/// past the ones the stream already holds for it.
fn link(
    tx: &Connection,
    table: &Table,
    global: &str,
    local: i64,
    revision: i64,
) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT OR REPLACE INTO replica_ids (kind, global_id, local_id) VALUES (?1, ?2, ?3)",
        params![table.kind, global, local],
    )?;
    let adopted = tx.execute(
        &format!(
            "UPDATE {} SET global_id = ?2, revision = MAX(revision, ?3)
              WHERE id = ?1 AND global_id IS NULL",
            table.name
        ),
        params![local, global, revision],
    )?;
    if adopted == 1 {
        // The fact is in the stream already: this computer's create of it
        // would only duplicate it.
        tx.execute(
            "DELETE FROM replica_outbox
              WHERE kind = ?1 AND local_id = ?2 AND change = 'create'
                AND state IN ('pending', 'too_large', 'unaddressable')",
            params![table.kind, local],
        )?;
    }
    Ok(())
}

/// Delete row `local` for a tombstone, as the person's delete does, and
/// mark every global id that names it deleted.
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
                crate::memory_writes::person::purge(tx, local)?;
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
            "UPDATE replica_ids SET deleted_at = ?3 WHERE kind = ?1 AND local_id = ?2",
            params![table.kind, local, now],
        )?;
        tx.execute(
            "DELETE FROM replica_outbox WHERE kind = ?1 AND local_id = ?2",
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
