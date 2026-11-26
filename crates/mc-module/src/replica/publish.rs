//! Sending the outbox.
//!
//! A round claims up to [`super::BATCH`] outbox rows in one transaction:
//! each row's message body ([`Body`]) is fixed then, its snapshot stored
//! with the row (`frozen`) unless a dreamer's change list fixed it already
//! ([`super::name_writer`]), and the row is marked `sending`. The bodies are
//! sealed in one vault call, and each sealed envelope is published with the
//! message id `<global id>@<revision>/<store id>`, the store id being the
//! one the row was first claimed under.
//! - An acknowledged publish marks the row `published` with the stream
//!   sequence it got. The row stays until the stream delivers the message
//!   back to this computer ([`super::apply`]): until then this computer's
//!   change is later in the stream than anything it receives for that row.
//! - A duplicate acknowledgement names this computer's own message: the
//!   same message id is only ever this store's same message. One at a
//!   sequence this computer has read already needs nothing more.
//! - The first unconfirmed publish ends the round: the hub may be taking
//!   the connection but not answering, and each publish would wait for its
//!   own timeout. Its row and the rest stay `sending`, and the next round
//!   sends each again, carrying the same message under the same id, so the
//!   hub stores it once.
//! - A change to a row meanwhile raises its revision once and is a new
//!   outbox row ([`super::schema`]): the message being sent stays as it was.
//! - An envelope over [`MAX_ENVELOPE_BYTES`] stays in the outbox as
//!   `too_large`, logged once; a row whose owner can't be named in a hub
//!   subject stays as `unaddressable`, logged once per owner. Either is
//!   tried again when the row changes. If this computer passed over another
//!   computer's change of the row for it, that change is applied now, as
//!   this one can't reach the others ([`super::apply`]).
//! - Each claimed row records the subject it is sent under with its global
//!   id. A tombstone goes to that subject, where the other computers hold
//!   the row, whatever owner the row had here when it was deleted; the
//!   tombstone of a row never sent anywhere is dropped, as no other
//!   computer holds the row. Rows that can't be sent wait in a state of
//!   their own, so no number of them keeps a claim from later changes.

use std::collections::HashSet;
use std::sync::{Mutex, PoisonError};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{Map, Value};
use zeroize::Zeroizing;

use super::seal::SealInput;
use super::wire::{self, Body, Envelope, Writer, MAX_ENVELOPE_BYTES};
use super::{snapshot, table, Replica, BATCH};

/// What one round of sending did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PublishReport {
    pub sent: usize,
    pub unconfirmed: usize,
    pub too_large: usize,
    pub unaddressable: usize,
}

/// One claimed outbox row, ready to seal.
struct Claimed {
    outbox_id: i64,
    kind: String,
    local_id: i64,
    subject: String,
    body: Body,
}

/// Owners already logged as unaddressable by this process.
static UNADDRESSABLE_LOGGED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn log_unaddressable(kind: &str, owner: &str, reason: &str) {
    let mut logged = UNADDRESSABLE_LOGGED
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    if logged
        .get_or_insert_with(HashSet::new)
        .insert(format!("{kind}:{owner}"))
    {
        tracing::warn!(
            %kind,
            %owner,
            %reason,
            "ck-mc: replica: rows of this kind stay on this computer"
        );
    }
}

impl Replica {
    /// Send one batch of the outbox. Nothing is sent before this computer
    /// joined the stream, so its rows meet the facts others already
    /// published first, nor after a start before the engine read the stream
    /// to its end ([`Replica::catch_up`]).
    pub async fn publish(&self) -> Result<PublishReport, String> {
        let mut report = PublishReport::default();
        if self.joined_at()?.is_none() {
            return Ok(report);
        }
        self.catch_up().await?;
        let (claimed, unaddressable, changes) = self
            .db
            .with_connection(|conn| claim(conn, &self.box_id, BATCH))
            .map_err(|error| format!("claiming the outbox: {error}"))?;
        for change in changes {
            self.db.changed(change);
        }
        report.unaddressable = unaddressable;
        if claimed.is_empty() {
            return Ok(report);
        }
        let inputs: Vec<SealInput> = claimed
            .iter()
            .map(|item| SealInput {
                aad: wire::aad(&item.body.global_id, item.body.revision, &item.subject),
                plaintext: Zeroizing::new(item.body.to_bytes()),
            })
            .collect();
        let sealed = self
            .sealer
            .seal_batch(&inputs)
            .await
            .map_err(|error| format!("sealing: {error}"))?;
        drop(inputs);
        let mut failure = None;
        for (index, (item, sealed)) in claimed.iter().zip(sealed).enumerate() {
            let envelope = Envelope {
                global_id: item.body.global_id.clone(),
                revision: item.body.revision,
                epoch: sealed.epoch,
                nonce: sealed.nonce,
                ciphertext: sealed.ciphertext,
            }
            .to_bytes();
            if envelope.len() > MAX_ENVELOPE_BYTES {
                tracing::warn!(
                    global_id = %item.body.global_id,
                    revision = %item.body.revision,
                    bytes = %envelope.len(),
                    max_bytes = %MAX_ENVELOPE_BYTES,
                    "ck-mc: replica: the sealed envelope is over the hub's size limit; it stays on this computer"
                );
                let changes = self
                    .db
                    .with_connection(|conn| unsendable(conn, item, "too_large"))
                    .map_err(|error| error.to_string())?;
                for change in changes {
                    self.db.changed(change);
                }
                report.too_large += 1;
                continue;
            }
            let id = wire::message_id(
                &item.body.global_id,
                item.body.revision,
                &item.body.writer.store_id,
            );
            match self.hub.publish(&item.subject, &id, envelope).await {
                Ok(ack) => {
                    let position = self.position()?;
                    self.db
                        .with_connection(|conn| {
                            sent(conn, item, ack.seq, ack.duplicate && ack.seq <= position)
                        })
                        .map_err(|error| error.to_string())?;
                    report.sent += 1;
                }
                Err(error) => {
                    report.unconfirmed += claimed.len() - index;
                    failure = Some(error);
                    break;
                }
            }
        }
        match failure {
            Some(error) if report.sent == 0 => Err(format!("publishing: {error}")),
            _ => Ok(report),
        }
    }
}

/// One outbox row as the claim reads it.
struct Waiting {
    outbox_id: i64,
    kind: String,
    local_id: i64,
    revision: i64,
    base: i64,
    change: String,
    global: Option<String>,
    level: Option<String>,
    owner: Option<String>,
    actor: String,
    epoch: Option<i64>,
    sender: Option<String>,
    frozen: Option<String>,
}

/// Claim up to `limit` rows to send: `pending` ones and `sending` ones a
/// round before could not confirm. Returns the claimed rows and how many
/// were found unaddressable.
fn claim(
    conn: &mut Connection,
    box_id: &str,
    limit: usize,
) -> rusqlite::Result<(Vec<Claimed>, usize, Vec<crate::app_read::Change>)> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut changes = Vec::new();
    // Read in the claim's own transaction: an apply may have given the
    // store a new one.
    let store_id = super::store_id(&tx)?;
    let rows: Vec<Waiting> = tx
        .prepare(
            "SELECT id, kind, local_id, revision, base_revision, change, global_id, level, owner,
                    actor, epoch, sender, frozen
               FROM replica_outbox WHERE state IN ('pending', 'sending') ORDER BY id LIMIT ?1",
        )?
        .query_map([limit as i64], |row| {
            Ok(Waiting {
                outbox_id: row.get(0)?,
                kind: row.get(1)?,
                local_id: row.get(2)?,
                revision: row.get(3)?,
                base: row.get(4)?,
                change: row.get(5)?,
                global: row.get(6)?,
                level: row.get(7)?,
                owner: row.get(8)?,
                actor: row.get(9)?,
                epoch: row.get(10)?,
                sender: row.get(11)?,
                frozen: row.get(12)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut claimed = Vec::new();
    let mut unaddressable = 0;
    for row in rows {
        let outbox_id = row.outbox_id;
        let fixed = match &row.frozen {
            Some(frozen) => {
                let Some(global) = row.global.clone() else {
                    tx.execute("DELETE FROM replica_outbox WHERE id = ?1", [outbox_id])?;
                    continue;
                };
                if row.change == "delete" && !sent_somewhere(&tx, &global)? {
                    // Never sent anywhere: no other computer holds the row,
                    // so its tombstone has nothing to delete. Without it,
                    // nothing comes back to decide the facts it held here.
                    tx.execute("DELETE FROM replica_outbox WHERE id = ?1", [outbox_id])?;
                    if row.kind == super::schema::MEMORIES.kind {
                        changes.extend(super::apply::unsent_survivor_gone(&tx, row.local_id)?);
                    }
                    continue;
                }
                Some(Frozen {
                    global_id: global,
                    revision: row.revision,
                    level: row.level.clone(),
                    owner: row.owner.clone().unwrap_or_default(),
                    snapshot: serde_json::from_str::<Option<Map<String, Value>>>(frozen)
                        .ok()
                        .flatten(),
                })
            }
            None => None,
        };
        let fixed = match fixed {
            Some(fixed) => fixed,
            None => {
                let Some(current) = current(&tx, &row.kind, row.local_id)? else {
                    // The row is gone without a delete to send, or moved to
                    // the agent level, which never replicates.
                    tx.execute("DELETE FROM replica_outbox WHERE id = ?1", [outbox_id])?;
                    continue;
                };
                // Check the subject before anything is fixed: an owner the
                // hub can't name keeps the row waiting, read afresh when it
                // changes.
                if let Err(reason) =
                    wire::subject(&row.kind, current.level.as_deref(), &current.owner)
                {
                    log_unaddressable(&row.kind, &current.owner, &reason);
                    tx.execute(
                        "UPDATE replica_outbox SET revision = ?2 WHERE id = ?1",
                        params![outbox_id, current.revision],
                    )?;
                    changes.extend(set_unsendable(
                        &tx,
                        outbox_id,
                        &row.kind,
                        row.local_id,
                        "unaddressable",
                        box_id,
                    )?);
                    unaddressable += 1;
                    continue;
                }
                match fix(&tx, outbox_id, &row.kind, row.local_id, &store_id, true)? {
                    Some(fixed) => fixed,
                    None => {
                        tx.execute("DELETE FROM replica_outbox WHERE id = ?1", [outbox_id])?;
                        continue;
                    }
                }
            }
        };
        let subject = match wire::subject(&row.kind, fixed.level.as_deref(), &fixed.owner) {
            Ok(subject) => subject,
            Err(reason) if row.change == "delete" => {
                // A tombstone goes to the subject its row was last sent
                // under, so this is never expected; it waits out of every
                // claim's way all the same.
                log_unaddressable(&row.kind, &fixed.owner, &reason);
                tx.execute(
                    "UPDATE replica_outbox SET state = 'unaddressable' WHERE id = ?1",
                    [outbox_id],
                )?;
                unaddressable += 1;
                continue;
            }
            Err(reason) => {
                log_unaddressable(&row.kind, &fixed.owner, &reason);
                changes.extend(set_unsendable(
                    &tx,
                    outbox_id,
                    &row.kind,
                    row.local_id,
                    "unaddressable",
                    box_id,
                )?);
                unaddressable += 1;
                continue;
            }
        };
        let sender = row.sender.clone().unwrap_or_else(|| store_id.clone());
        tx.execute(
            "UPDATE replica_outbox SET state = 'sending', sender = ?2 WHERE id = ?1",
            params![outbox_id, sender],
        )?;
        if row.change != "delete" {
            // The row may be in the stream under this subject from now on,
            // so its tombstone goes there.
            tx.execute(
                "UPDATE replica_ids SET subject = ?2, level = ?3, owner = ?4 WHERE global_id = ?1",
                params![fixed.global_id, subject, fixed.level, fixed.owner],
            )?;
        }
        claimed.push(Claimed {
            outbox_id,
            kind: row.kind.clone(),
            local_id: row.local_id,
            subject,
            body: Body {
                kind: row.kind,
                global_id: fixed.global_id,
                revision: fixed.revision,
                base_revision: row.base,
                change: row.change,
                writer: Writer {
                    box_id: box_id.to_owned(),
                    store_id: sender,
                    actor: row.actor,
                    dreamer_epoch: row.epoch,
                },
                snapshot: fixed.snapshot,
            },
        });
    }
    tx.commit()?;
    Ok((claimed, unaddressable, changes))
}

/// Whether row `global` was ever sent to the stream, by this computer or
/// another: a subject is recorded for it ([`super::schema`]).
fn sent_somewhere(tx: &Connection, global: &str) -> rusqlite::Result<bool> {
    tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM replica_ids WHERE global_id = ?1 AND subject IS NOT NULL)",
        [global],
        |row| row.get(0),
    )
}

/// A message's fixed content: the row's global id and revision, the level
/// and owner its subject names, and its snapshot (none for a delete).
struct Frozen {
    global_id: String,
    revision: i64,
    level: Option<String>,
    owner: String,
    snapshot: Option<Map<String, Value>>,
}

/// Fix outbox row `outbox_id`'s message to row `local_id` of `kind` as it
/// stands now, storing its snapshot with the outbox row, its revision, and
/// the global id, level and owner it is sent under. A row never sent gets
/// its global id now when `assign`; otherwise it is left as it is and
/// `None` returned, as it is when the row is gone or at the agent level.
fn fix(
    tx: &Connection,
    outbox_id: i64,
    kind: &str,
    local_id: i64,
    store_id: &str,
    assign: bool,
) -> rusqlite::Result<Option<Frozen>> {
    let Some(current) = current(tx, kind, local_id)? else {
        return Ok(None);
    };
    let global = match current.global_id {
        Some(global) => global,
        None if assign => {
            let global = wire::global_id(store_id, kind, local_id);
            snapshot::assign(tx, kind, local_id, &global)?;
            global
        }
        None => return Ok(None),
    };
    let snapshot = snapshot::read(tx, kind, store_id, local_id)?;
    tx.execute(
        "UPDATE replica_outbox SET frozen = ?2, revision = ?3, global_id = ?4, level = ?5, owner = ?6
          WHERE id = ?1",
        params![
            outbox_id,
            serde_json::to_string(&snapshot).expect("a snapshot serializes"),
            current.revision,
            global,
            current.level,
            current.owner
        ],
    )?;
    Ok(Some(Frozen {
        global_id: global,
        revision: current.revision,
        level: current.level,
        owner: current.owner,
        snapshot,
    }))
}

/// Freeze outbox row `outbox_id`, a change of row `local_id` of `kind`
/// that was sent once before, as the row stands now
/// ([`super::name_writer`]). From here on it carries this snapshot, and a
/// further change of the row is an outbox row of its own.
pub(crate) fn freeze(
    tx: &Connection,
    outbox_id: i64,
    kind: &str,
    local_id: i64,
    store_id: &str,
) -> rusqlite::Result<()> {
    fix(tx, outbox_id, kind, local_id, store_id, false)?;
    Ok(())
}

/// Queue row `local_id` of `kind`, sent before, to be sent to a stream
/// made anew at `revision`, as the row stands now ([`super::same_stream`]).
/// Its message is fixed as it is queued, at that revision, so it is not
/// sent at the row's own revision as an unfixed change would be, and a
/// further change of the row is an outbox row of its own. Its sender is
/// fixed when it is first claimed, as for any change. Returns whether it
/// was queued: a row gone, never sent or at the agent level is not.
pub(crate) fn queue_again(
    tx: &Connection,
    kind: &str,
    local_id: i64,
    revision: i64,
    store_id: &str,
) -> rusqlite::Result<bool> {
    let Some(Current {
        global_id: Some(global),
        level,
        owner,
        ..
    }) = current(tx, kind, local_id)?
    else {
        return Ok(false);
    };
    let snapshot = snapshot::read(tx, kind, store_id, local_id)?;
    tx.execute(
        "INSERT INTO replica_outbox
             (kind, local_id, revision, base_revision, change, created_at, actor,
              global_id, level, owner, frozen)
         VALUES (?1, ?2, ?3, 0, 'create', ?4, 'ck-mc', ?5, ?6, ?7, ?8)",
        params![
            kind,
            local_id,
            revision,
            crate::memory_writes::now_ms(),
            global,
            level,
            owner,
            serde_json::to_string(&snapshot).expect("a snapshot serializes")
        ],
    )?;
    Ok(true)
}

/// A row's global id, revision, and the level and owner its subject names.
struct Current {
    global_id: Option<String>,
    revision: i64,
    level: Option<String>,
    owner: String,
}

fn current(conn: &Connection, kind: &str, id: i64) -> rusqlite::Result<Option<Current>> {
    let (level, owner) = match kind {
        "memory" => ("level", "owner_id"),
        "primer" => ("NULL", "project_path"),
        _ => ("NULL", "'all'"),
    };
    let found = conn
        .query_row(
            &format!(
                "SELECT global_id, revision, {level}, {owner} FROM {} WHERE id = ?1",
                table(kind).name
            ),
            [id],
            |row| {
                Ok(Current {
                    global_id: row.get(0)?,
                    revision: row.get(1)?,
                    level: row.get(2)?,
                    owner: row.get(3)?,
                })
            },
        )
        .optional()?;
    Ok(found.filter(|current| current.level.as_deref() != Some("agent")))
}

/// A claimed row's message can't be sent: it is over the size the hub
/// takes. The row waits as `state` ([`set_unsendable`]).
fn unsendable(
    conn: &mut Connection,
    item: &Claimed,
    state: &str,
) -> rusqlite::Result<Vec<crate::app_read::Change>> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let changes = set_unsendable(
        &tx,
        item.outbox_id,
        &item.kind,
        item.local_id,
        state,
        &item.body.writer.box_id,
    )?;
    tx.commit()?;
    Ok(changes)
}

/// Outbox row `outbox_id`, a change of row `local_id` of `kind`, can't be
/// sent (`state` says why). It waits for the next change of its row, read
/// afresh then, unless a later change of the row waits already, which
/// replaces it. If this computer passed over another computer's change of
/// the row for one of its own that can't be sent, that change applies now
/// ([`super::apply::reconcile_after_send`]); the changes it makes are
/// returned, to be reported.
fn set_unsendable(
    tx: &Connection,
    outbox_id: i64,
    kind: &str,
    local_id: i64,
    state: &str,
    box_id: &str,
) -> rusqlite::Result<Vec<crate::app_read::Change>> {
    let later: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM replica_outbox
                        WHERE kind = ?1 AND local_id = ?2 AND id <> ?3
                          AND state <> 'published' AND frozen IS NULL)",
        params![kind, local_id, outbox_id],
        |row| row.get(0),
    )?;
    if later {
        tx.execute(
            "DELETE FROM replica_outbox WHERE id = ?1 AND change <> 'delete'",
            [outbox_id],
        )?;
    } else {
        tx.execute(
            "UPDATE replica_outbox SET state = ?2, frozen = NULL WHERE id = ?1 AND change <> 'delete'",
            params![outbox_id, state],
        )?;
    }
    super::apply::reconcile_after_send(tx, box_id, kind, local_id)
}

/// The stream acknowledged a claimed row at `seq`. `passed` is a duplicate
/// at a sequence this computer has read already: a message id is only ever
/// this store's own same message, so it is in the stream and was applied
/// or settled when it was read, and the row needs nothing more.
fn sent(conn: &mut Connection, item: &Claimed, seq: u64, passed: bool) -> rusqlite::Result<()> {
    if passed {
        conn.execute(
            "DELETE FROM replica_outbox WHERE id = ?1 AND state = 'sending'",
            [item.outbox_id],
        )?;
        return Ok(());
    }
    conn.execute(
        "UPDATE replica_outbox SET state = 'published', stream_seq = ?2
          WHERE id = ?1 AND state = 'sending'",
        params![item.outbox_id, seq as i64],
    )?;
    Ok(())
}
