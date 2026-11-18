//! Sending the outbox.
//!
//! A round claims up to [`super::BATCH`] outbox rows in one transaction:
//! each row's current replicated state becomes a message body ([`Body`]),
//! and the row is marked `sending`. The bodies are sealed in one vault
//! call, and each sealed envelope is published with the message id
//! `<global id>@<revision>`.
//! - An acknowledged publish marks the row `published` with the stream
//!   sequence it got. The row stays until the stream delivers the message
//!   back to this computer ([`super::apply`]): until then this computer's
//!   change is later in the stream than anything it receives for that row.
//! - An unconfirmed publish leaves the row `sending`; the next round sends
//!   it again under the same message id, so the hub stores it once.
//! - A change to the row meanwhile raises its revision and turns the row
//!   back to `pending` ([`super::schema`]), so the older send is never
//!   marked done and the newer state goes out next.
//! - An envelope over [`MAX_ENVELOPE_BYTES`] stays in the outbox as
//!   `too_large`, logged once; a row whose owner can't be named in a hub
//!   subject stays as `unaddressable`, logged once per owner. Either is
//!   tried again when the row changes.

use std::collections::HashSet;
use std::sync::{Mutex, PoisonError};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
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
            "ck-mc: replica: {kind} rows of owner {owner} stay on this computer: {reason}"
        );
    }
}

impl Replica {
    /// Send one batch of the outbox. Nothing is sent before this computer
    /// joined the stream, so its own rows can link to the facts others
    /// already published instead of duplicating them.
    pub async fn publish(&self) -> Result<PublishReport, String> {
        let mut report = PublishReport::default();
        if self.joined_at()?.is_none() {
            return Ok(report);
        }
        let (claimed, unaddressable) = self
            .db
            .with_connection(|conn| claim(conn, &self.box_id, BATCH))
            .map_err(|error| format!("claiming the outbox: {error}"))?;
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
        for (item, sealed) in claimed.iter().zip(sealed) {
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
                    "ck-mc: replica: {} at revision {} is {} bytes sealed, over the hub's {MAX_ENVELOPE_BYTES}; it stays on this computer",
                    item.body.global_id,
                    item.body.revision,
                    envelope.len()
                );
                self.db
                    .with_connection(|conn| set_state(conn, item, "too_large"))
                    .map_err(|error| error.to_string())?;
                report.too_large += 1;
                continue;
            }
            let id = wire::message_id(&item.body.global_id, item.body.revision);
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
                    report.unconfirmed += 1;
                    failure = Some(error);
                }
            }
        }
        match failure {
            Some(error) if report.sent == 0 => Err(format!("publishing: {error}")),
            _ => Ok(report),
        }
    }
}

/// Claim up to `limit` rows to send: `pending` ones and `sending` ones a
/// round before could not confirm. Returns the claimed rows and how many
/// were found unaddressable.
fn claim(
    conn: &mut Connection,
    box_id: &str,
    limit: usize,
) -> rusqlite::Result<(Vec<Claimed>, usize)> {
    type Row = (
        i64,
        String,
        i64,
        i64,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
        Option<i64>,
    );
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let rows: Vec<Row> = tx
        .prepare(
            "SELECT id, kind, local_id, base_revision, change, global_id, level, owner, actor, epoch
               FROM replica_outbox WHERE state IN ('pending', 'sending') ORDER BY id LIMIT ?1",
        )?
        .query_map([limit as i64], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
                row.get(8)?,
                row.get(9)?,
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut claimed = Vec::new();
    let mut unaddressable = 0;
    for (outbox_id, kind, local_id, base, change, global, level, owner, actor, epoch) in rows {
        let (global_id, revision, level, owner, snapshot) = if change == "delete" {
            let revision: i64 = tx.query_row(
                "SELECT revision FROM replica_outbox WHERE id = ?1",
                [outbox_id],
                |row| row.get(0),
            )?;
            let Some(global) = global else {
                tx.execute("DELETE FROM replica_outbox WHERE id = ?1", [outbox_id])?;
                continue;
            };
            (global, revision, level, owner.unwrap_or_default(), None)
        } else {
            let Some(current) = current(&tx, &kind, local_id)? else {
                // The row is gone without a delete to send, or moved to the
                // agent level, which never replicates.
                tx.execute("DELETE FROM replica_outbox WHERE id = ?1", [outbox_id])?;
                continue;
            };
            let global = match current.global_id {
                Some(global) => global,
                None => {
                    let global = wire::global_id(box_id, local_id);
                    snapshot::assign(&tx, &kind, local_id, &global)?;
                    global
                }
            };
            let snapshot = snapshot::read(&tx, &kind, box_id, local_id)?;
            (
                global,
                current.revision,
                current.level,
                current.owner,
                snapshot,
            )
        };
        let subject = match wire::subject(&kind, level.as_deref(), &owner) {
            Ok(subject) => subject,
            Err(reason) => {
                log_unaddressable(&kind, &owner, &reason);
                tx.execute(
                    "UPDATE replica_outbox SET state = 'unaddressable', revision = ?2 WHERE id = ?1",
                    params![outbox_id, revision],
                )?;
                unaddressable += 1;
                continue;
            }
        };
        tx.execute(
            "UPDATE replica_outbox SET state = 'sending', revision = ?2, global_id = ?3 WHERE id = ?1",
            params![outbox_id, revision, global_id],
        )?;
        claimed.push(Claimed {
            outbox_id,
            kind: kind.clone(),
            local_id,
            subject,
            body: Body {
                kind,
                global_id,
                revision,
                base_revision: base,
                change,
                writer: Writer {
                    box_id: box_id.to_owned(),
                    actor,
                    dreamer_epoch: epoch,
                },
                snapshot,
            },
        });
    }
    tx.commit()?;
    Ok((claimed, unaddressable))
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

/// Mark a claimed row `state`, unless it changed since it was claimed.
fn set_state(conn: &Connection, item: &Claimed, state: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE replica_outbox SET state = ?3 WHERE id = ?1 AND state = 'sending' AND revision = ?2",
        params![item.outbox_id, item.body.revision, state],
    )?;
    Ok(())
}

/// The stream acknowledged a claimed row at `seq`. `lost` is a duplicate
/// whose sequence this computer already applied without recognising the
/// message as its own: another computer's message took the same id first,
/// so this change never reached the stream, and it is queued again under a
/// new revision.
fn sent(conn: &mut Connection, item: &Claimed, seq: u64, lost: bool) -> rusqlite::Result<()> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if lost {
        let still_sending: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM replica_outbox
                                WHERE id = ?1 AND state = 'sending' AND revision = ?2)",
            params![item.outbox_id, item.body.revision],
            |row| row.get(0),
        )?;
        if still_sending {
            tx.execute("INSERT INTO replica_applying (applying) VALUES (1)", [])?;
            tx.execute(
                &format!(
                    "UPDATE {} SET revision = revision + 1 WHERE id = ?1",
                    table(&item.kind).name
                ),
                [item.local_id],
            )?;
            tx.execute(
                "UPDATE replica_outbox SET state = 'pending', revision = revision + 1 WHERE id = ?1",
                [item.outbox_id],
            )?;
            tx.execute("DELETE FROM replica_applying", [])?;
        }
        return tx.commit();
    }
    let marked = tx.execute(
        "UPDATE replica_outbox SET state = 'published', stream_seq = ?3
          WHERE id = ?1 AND state = 'sending' AND revision = ?2",
        params![item.outbox_id, item.body.revision, seq as i64],
    )?;
    if marked == 1 {
        // The newest sent revision is enough to know this computer's change
        // is still ahead in the stream.
        tx.execute(
            "DELETE FROM replica_outbox
              WHERE kind = ?1 AND local_id = ?2 AND state = 'published' AND id <> ?3",
            params![item.kind, item.local_id, item.outbox_id],
        )?;
    }
    tx.commit()
}
