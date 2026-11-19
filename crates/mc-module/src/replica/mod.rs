//! Memories shared across the user's computers.
//!
//! Every computer the user pairs keeps its own `context.db`. The memories
//! a person or an agent would miss on another computer (project, workspace
//! and global memories, observations and primers) travel between them
//! through one stream on the user's hub, `HUB_MEMORY` ([`hub`]):
//! - **Capture** happens in the store ([`schema`]): triggers on each
//!   replicated table write an outbox row for each changed row and raise
//!   its revision once per change, whichever of the many writers changed it.
//! - **Publish** ([`publish`]) drains the outbox in batches. Each message is
//!   a full snapshot of the row ([`snapshot`]), sealed by the vault under
//!   the fleet epoch key ([`seal`]), and sent with the message id
//!   `<global id>@<revision>/<store id>`, so a retry is stored once and two
//!   computers' changes at one revision are both stored ([`wire`]).
//! - **Follow** ([`apply`]) reads the stream in order, opens each message
//!   and applies it in one transaction that stores the stream position.
//!   The stream's order decides between computers, the same on every one:
//!   of a row's messages, the highest revision, and of equal ones the later
//!   message. A message this computer's vault can't open yet holds the
//!   stream until it can ([`epochs`]). An apply writes no outbox row.
//! - **Join** ([`Replica::join`]): the first time a computer follows the
//!   stream it applies everyone else's history, then publishes every row of
//!   its own that has no global id yet.
//! - **Catch up** ([`Replica::catch_up`]): after every start, the engine
//!   reads the stream to its end before it sends anything, from the start
//!   of a stream made anew since it last read. Every new consumer on the
//!   hub checks the stream's identity again ([`Replica::check_stream`]),
//!   so a stream made anew under a running engine is noticed too.
//!
//! A row's global id is `<store id>.<table letter><local id>` of the store
//! that first published it ([`wire::global_id`]), given when the row is
//! first sent; the local id agents see keeps naming the same row on each
//! computer. The store id is 32 random hex characters kept in
//! `replica_state`, made anew when the store first joins the stream, so
//! neither a store made anew nor a copy of a store that never joined reuses
//! an id another store sent. A store that may have been copied or restored
//! takes a new store id before it sends again ([`Replica::catch_up`],
//! [`apply`]): when it runs on another computer than the one it last ran
//! on, or when the stream holds a message sent under its store id that it
//! doesn't know, whichever computer sent it. The box id is the computer's
//! machine id, read from the bus client ([`box_id`]); it names the writer
//! of each message, and without one nothing publishes and the outbox waits.
//!
//! This module is the engine. The live hub ([`nats`]) implements
//! [`hub::Hub`] over JetStream in the hub's domain, and the replica task
//! ([`live`]) runs the engine's rounds on it in production, in a build with
//! the `memory-replica` feature ([`FEATURE`]). Without the feature, or
//! while ck-bus can't give ck-mc the hub, a computer runs as before, its
//! outbox kept to one row per changed row.

pub mod apply;
pub mod epochs;
pub mod hub;
pub mod live;
pub mod nats;
pub mod publish;
pub mod schema;
pub mod seal;
pub mod snapshot;
pub mod wire;

#[cfg(test)]
mod capture_tests;
#[cfg(test)]
mod entorhinal_epoch_samples_tests;
#[cfg(test)]
mod epochs_tests;
#[cfg(test)]
mod exchange_tests;
#[cfg(test)]
mod fence_tests;
#[cfg(test)]
mod fuzz_tests;
#[cfg(test)]
mod live_tests;
#[cfg(test)]
mod nats_tests;
#[cfg(test)]
mod order_tests;
#[cfg(test)]
mod review_witness_2_tests;
#[cfg(test)]
mod review_witness_3_tests;
#[cfg(test)]
mod review_witness_tests;
#[cfg(test)]
mod samples_tests;
#[cfg(test)]
mod schema_tests;
#[cfg(test)]
mod seal_client_tests;
#[cfg(test)]
pub(crate) mod test_support;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection, OptionalExtension};

use crate::context_db::ContextDb;
use hub::Hub;
use seal::Sealer;

/// Whether this build shares memories with the user's other computers: the
/// `memory-replica` Cargo feature, off by default, as the `agent-data`
/// feature is for moves ([`crate::agent_data::FEATURE`]). Without it ck-mc
/// never starts the replica task and never contacts the hub, whatever its
/// environment says; the capture triggers still record every change in the
/// outbox. Switching sharing on is the owner's step, made by building with
/// the feature.
pub const FEATURE: bool = cfg!(feature = "memory-replica");

/// [`FEATURE`], said in the log at start, so an operator can see why
/// memories are or aren't shared.
pub fn switch_from_build() -> bool {
    if FEATURE {
        tracing::info!(
            "ck-mc: shared memories are on: this build follows and publishes the hub's memory stream"
        );
    } else {
        tracing::info!("ck-mc: shared memories are off: this build was made without the memory-replica feature, so it never contacts the hub; changes wait in the outbox");
    }
    FEATURE
}

/// The replicated table of `kind`.
pub(crate) fn table(kind: &str) -> &'static schema::Table {
    match kind {
        "observation" => &schema::OBSERVATIONS,
        "primer" => &schema::PRIMERS,
        _ => &schema::MEMORIES,
    }
}

/// This computer's box id, as ck-bus supplies it on the module's bus
/// account. Modules never derive it themselves.
pub fn box_id(client: &cortexkit_bus_client::BusClient) -> Option<String> {
    client.box_id().map(|id| id.as_str().to_owned())
}

/// Name the writer of the changes `tx` makes from here until
/// [`unname_writer`], so their outbox rows say who made them. Only the
/// dreamer's change lists name themselves: every other change is recorded
/// as its row's source type (a create) or `ck-mc`. `epochs` are the
/// generations of the dreamer leases the run holds, by role
/// ([`crate::dreamer::lease::role`]). Each captured change carries the
/// epoch of its own row's role ([`schema`]), and none when the run doesn't
/// hold that role; a receiver skips a dreamer change older than the fence
/// of the row it changes ([`apply`]).
///
/// A run that names epochs first freezes every change of another writer
/// still waiting to be sent for a row of a role it holds: that change goes
/// out as its own message, with the row as it stands now, and the run's
/// change of the row becomes a message of its own at the next revision. A
/// receiver that fences the run's change then still applies the other
/// writer's, and a run's stale change never travels inside a message that
/// carries no epoch. A run without epochs (no lease, or a build without
/// `memory-replica`) writes changes no receiver fences, so they join the
/// waiting ones as any change does.
pub(crate) fn name_writer(
    tx: &Connection,
    actor: &str,
    run_id: Option<i64>,
    epochs: &[(String, i64)],
) -> rusqlite::Result<()> {
    tx.execute("DELETE FROM replica_writer", [])?;
    if epochs.is_empty() {
        tx.execute(
            "INSERT INTO replica_writer (actor, run_id) VALUES (?1, ?2)",
            params![actor, run_id],
        )?;
    }
    for (role, epoch) in epochs {
        tx.execute(
            "INSERT INTO replica_writer (actor, run_id, role, epoch) VALUES (?1, ?2, ?3, ?4)",
            params![actor, run_id, role, epoch],
        )?;
        freeze_waiting(tx, Some((actor, role, *epoch)))?;
    }
    Ok(())
}

/// End [`name_writer`]'s naming, before the transaction commits, so no
/// other writer is ever named by it. The changes a run that named epochs
/// made are frozen as they stand, so a change another writer makes before
/// they are sent becomes a message of its own. That later message carries
/// the run's change too, as the row stood when that writer changed it:
/// the writer changed the row it saw, and its message is not fenced.
pub(crate) fn unname_writer(tx: &Connection) -> rusqlite::Result<()> {
    let epochs: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM replica_writer WHERE epoch IS NOT NULL)",
        [],
        |row| row.get(0),
    )?;
    if epochs {
        freeze_waiting(tx, None)?;
    }
    tx.execute("DELETE FROM replica_writer", [])?;
    Ok(())
}

/// Freeze the outbox rows waiting to be sent for rows already sent once:
/// with `Some((actor, role, epoch))`, those of rows of `role` written by
/// another actor or under another epoch; with `None`, those that carry an
/// epoch (a run's own changes). A row never sent travels as a create, and
/// no receiver holds an earlier change of it to fence it by, so its
/// changes stay joined.
fn freeze_waiting(tx: &Connection, other_than: Option<(&str, &str, i64)>) -> rusqlite::Result<()> {
    let mut waiting: Vec<(i64, String, i64)> = Vec::new();
    for table in schema::TABLES {
        let role = schema::row_role(table, "t");
        let (condition, values): (String, Vec<rusqlite::types::Value>) = match other_than {
            Some((actor, role_held, epoch)) => (
                format!("{role} = ?1 AND NOT (o.actor = ?2 AND o.epoch IS ?3)"),
                vec![
                    role_held.to_owned().into(),
                    actor.to_owned().into(),
                    epoch.into(),
                ],
            ),
            None => ("o.epoch IS NOT NULL".to_owned(), Vec::new()),
        };
        let mut statement = tx.prepare(&format!(
            "SELECT o.id, o.kind, o.local_id FROM replica_outbox o JOIN {name} t ON t.id = o.local_id
              WHERE o.kind = '{kind}' AND o.state = 'pending' AND o.frozen IS NULL
                AND o.change <> 'delete' AND t.global_id IS NOT NULL AND {condition}",
            name = table.name,
            kind = table.kind,
        ))?;
        let rows = statement.query_map(rusqlite::params_from_iter(values), |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?;
        for row in rows {
            waiting.push(row?);
        }
    }
    if waiting.is_empty() {
        return Ok(());
    }
    let store = store_id(tx)?;
    for (outbox_id, kind, local_id) in waiting {
        publish::freeze(tx, outbox_id, &kind, local_id, &store)?;
    }
    Ok(())
}

/// How many messages one round reads or sends.
pub const BATCH: usize = seal::MAX_BATCH;

/// The engine of one computer: its store, the hub's stream, the vault's
/// sealing, and its box id.
pub struct Replica {
    pub(crate) db: Arc<ContextDb>,
    pub(crate) hub: Arc<dyn Hub>,
    pub(crate) sealer: Arc<dyn Sealer>,
    pub(crate) box_id: String,
    /// The hub's fleet epoch record (which sealing key generation is the
    /// hub's current one, and the highest this computer's vault holds), as
    /// Entorhinal reports it. A hold of the stream at a message the vault
    /// won't open names it in its reason; the vault's own refusal decides
    /// whether the message is held or skipped ([`epochs`]).
    pub(crate) epochs: Arc<dyn epochs::FleetEpochs>,
    /// Whether this engine read the stream to its end since it started
    /// ([`Replica::catch_up`]); nothing is sent before it has.
    caught_up: AtomicBool,
    /// Why the stream is held at a message that may open later, as last
    /// logged, so each hold is logged once.
    pub(crate) held: Mutex<Option<String>>,
}

impl Replica {
    pub fn new(
        db: Arc<ContextDb>,
        hub: Arc<dyn Hub>,
        sealer: Arc<dyn Sealer>,
        box_id: String,
    ) -> Self {
        Self {
            db,
            hub,
            sealer,
            box_id,
            epochs: Arc::new(epochs::UnknownEpochs),
            caught_up: AtomicBool::new(false),
            held: Mutex::new(None),
        }
    }

    /// The engine reading the fleet epoch record from `epochs`, in place of
    /// a record whose members are all unknown.
    pub fn with_epochs(mut self, epochs: Arc<dyn epochs::FleetEpochs>) -> Self {
        self.epochs = epochs;
        self
    }

    /// When this computer joined the stream, if it has.
    pub fn joined_at(&self) -> Result<Option<i64>, String> {
        self.db
            .with_connection(|conn| {
                conn.query_row(
                    "SELECT joined_at FROM replica_state WHERE id = 1",
                    [],
                    |row| row.get(0),
                )
                .optional()
                .map(Option::flatten)
            })
            .map_err(|error| error.to_string())
    }

    /// Join the stream, once: apply everyone else's history up to the
    /// stream's newest message, then queue a create for every row of this
    /// computer that has no global id yet, archived rows included, so undo
    /// and restore work everywhere. A row of this computer that holds a fact
    /// the history carried under a lower global id is archived here
    /// ([`apply`]); it is still sent, as it stands, and every computer
    /// archives it the same way.
    pub async fn join(&self) -> Result<(), String> {
        self.catch_up().await?;
        if self.joined_at()?.is_some() {
            return Ok(());
        }
        let queued = self
            .db
            .with_connection(|conn| queue_unsent(conn, &self.box_id));
        let queued = queued.map_err(|error| error.to_string())?;
        let at = self.position()?;
        tracing::info!("ck-mc: replica: joined the memory stream at {at}; {queued} rows queued");
        Ok(())
    }

    /// Read the stream to its end, once per start of the engine, before
    /// anything is sent. A store that never joined the stream takes a new
    /// store id first, and so does a store copied to this computer from
    /// another one; a store restored to an earlier state takes one when this
    /// reading finds a message it doesn't know sent under its store id
    /// ([`apply`]): either way, no global id a copy of the store may have
    /// sent is ever sent again for another row. A stream made anew since the
    /// position was stored is read from its start ([`same_stream`]), and so
    /// is one found made anew while the engine runs, which reads it to its
    /// end again before it sends.
    pub async fn catch_up(&self) -> Result<(), String> {
        if self.caught_up.load(Ordering::SeqCst) {
            return Ok(());
        }
        self.db
            .with_connection(|conn| moved_here(conn, &self.box_id))
            .map_err(|error| error.to_string())?;
        let last = self.check_stream().await?.last_seq;
        while self.position()? < last {
            if self.follow().await? == 0 {
                break;
            }
        }
        if self.position()? < last {
            return Err("the stream could not all be read".into());
        }
        self.caught_up.store(true, Ordering::SeqCst);
        Ok(())
    }

    /// Check that the stored position belongs to the stream the hub holds
    /// now, and start the stream over if it doesn't ([`same_stream`]).
    /// Returns the stream's information. The message stored at the
    /// position is read again, so a stream made anew with the creation time
    /// of the old one (restored from a backup of the hub) is told apart too,
    /// once other computers have sent past the position. The engine runs
    /// this whenever it reads from a new consumer, since a hub that lost its
    /// storage only ends the consumer the engine reads.
    pub(crate) async fn check_stream(&self) -> Result<hub::StreamInfo, String> {
        let info = self.hub.info().await.map_err(|error| error.to_string())?;
        let position = self.position()?;
        let stored = if position > 0 && info.last_seq >= position {
            Some(
                self.hub
                    .get(position)
                    .await
                    .map_err(|error| format!("reading message {position} again: {error}"))?,
            )
        } else {
            None
        };
        let anew = self
            .db
            .with_connection(|conn| same_stream(conn, &info, position, stored.as_ref()))
            .map_err(|error| error.to_string())?;
        if anew {
            // The new stream is read to its end before anything is sent.
            self.caught_up.store(false, Ordering::SeqCst);
        }
        Ok(info)
    }

    /// The stream position applied so far.
    pub fn position(&self) -> Result<u64, String> {
        self.db
            .with_connection(|conn| {
                conn.query_row(
                    "SELECT stream_seq FROM replica_state WHERE id = 1",
                    [],
                    |row| row.get::<_, i64>(0),
                )
            })
            .map(|seq| seq.max(0) as u64)
            .map_err(|error| error.to_string())
    }

    /// One round: join (once), read what arrived, send what changed.
    /// Returns how many messages it read and sent. The replica task
    /// ([`live`]) runs rounds while the hub is reachable.
    pub async fn round(&self) -> Result<usize, String> {
        self.join().await?;
        let arrived = self.follow().await?;
        let sent = self.publish().await?;
        Ok(arrived + sent.sent)
    }
}

/// The id this store's global ids are formed under.
pub(crate) fn store_id(conn: &Connection) -> rusqlite::Result<String> {
    conn.query_row(
        "SELECT store_id FROM replica_state WHERE id = 1",
        [],
        |row| row.get(0),
    )
}

/// Give this store a new store id, so the global ids it forms from now on
/// are new everywhere. Rows already sent keep their ids.
pub(crate) fn new_store_id(conn: &Connection, why: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE replica_state SET store_id = lower(hex(randomblob(16))) WHERE id = 1",
        [],
    )?;
    tracing::info!("ck-mc: replica: this store takes a new store id: {why}");
    Ok(())
}

/// A store that never joined the stream, or that last ran on another
/// computer, takes a new store id, and records this computer's box id. A
/// store that never joined may be a copy of another store that never
/// joined (a backup restored, the folder copied, before either computer
/// joined): the box id is recorded only from here on, so nothing told the
/// two apart, and both held the store id the migration gave them.
fn moved_here(conn: &mut Connection, box_id: &str) -> rusqlite::Result<()> {
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let recorded: Option<String> =
        tx.query_row("SELECT box_id FROM replica_state WHERE id = 1", [], |row| {
            row.get(0)
        })?;
    let why = match recorded.as_deref() {
        None => Some("it joins the stream for the first time"),
        Some(recorded) if recorded != box_id => Some("it last ran on another computer"),
        Some(_) => None,
    };
    if let Some(why) = why {
        new_store_id(&tx, why)?;
        tx.execute(
            "UPDATE replica_state SET box_id = ?1 WHERE id = 1",
            [box_id],
        )?;
    }
    tx.commit()
}

/// Whether the stored position belongs to the stream `info` describes, and
/// if not, start over on the stream as it is now. `stored` is the message
/// the hub holds at position `checked`, if it was read. A stream made anew
/// (the hub's storage lost, the stream made again, or restored from a
/// backup of the hub) has another creation time, ends before the stored
/// position, or holds no message, or another message, at that position
/// than the one this store read there. Then [`start_over`] runs. A
/// position stored before the creation time was recorded is checked by the
/// rest alone, and one stored without a message id by the creation time
/// and whether the stream still holds a message there. Returns whether the
/// stream was made anew.
fn same_stream(
    conn: &mut Connection,
    info: &hub::StreamInfo,
    checked: u64,
    stored: Option<&Option<hub::HubMessage>>,
) -> rusqlite::Result<bool> {
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let (position, message_id, created): (i64, Option<String>, Option<String>) = tx.query_row(
        "SELECT stream_seq, stream_message_id, stream_created FROM replica_state WHERE id = 1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    let why = if (info.last_seq as i64) < position {
        Some("it ends before the position this store had read to".to_owned())
    } else if let Some(created) = created
        .as_deref()
        .filter(|created| *created != info.created)
    {
        Some(format!("it was created {}, not {created}", info.created))
    } else {
        match stored.filter(|_| position > 0 && checked as i64 == position) {
            Some(None) => {
                Some("it holds no message at the position this store had read to".to_owned())
            }
            Some(Some(found))
                if message_id
                    .as_deref()
                    .is_some_and(|id| found.message_id.as_deref() != Some(id)) =>
            {
                Some("it holds another message at the position this store had read to".to_owned())
            }
            _ => None,
        }
    };
    if let Some(why) = &why {
        tracing::warn!(
            "ck-mc: replica: the hub's memory stream was made anew ({why}; created {}, last message {}, this store had read to {position}); it is read from its start, and every row is sent again",
            info.created,
            info.last_seq
        );
        start_over(&tx)?;
    }
    tx.execute(
        "UPDATE replica_state SET stream_created = ?1 WHERE id = 1",
        [&info.created],
    )?;
    tx.commit()?;
    Ok(why.is_some())
}

/// Start over on a stream made anew. The position goes back to 0, so the
/// new stream is read from its start; what this store learned from the old
/// stream goes (each row's deciding message, fences, passed arrivals, rows
/// to read again, the senders applied, and sends waiting to come back); and
/// every replicated row is queued again, with every deleted row's
/// tombstone, so the new stream holds every row and every delete for the
/// computers that join it.
///
/// - The store takes a new store id first, so every message it sends to
///   the new stream has a message id it never used before: none of them
///   can be answered as a duplicate of, or skipped as a copy of, a
///   message it sent to the old stream, which a stream restored from a
///   backup of the hub may still hold.
/// - A row's waiting changes, sent or not, collapse into the one change
///   queued for it, which carries the row as it stands now and is fixed
///   as it is queued. It goes at the revision the old stream decided the
///   row at, or above it for a change of this computer's own the old
///   stream never brought back ([`apply::resend_revision`]); the row's
///   revision rises to it if it is below. A `raised` revision stays
///   `raised`: a later change of the row is sent at it.
/// - A deleted row's tombstone goes one revision above everything this
///   computer sent or queued for the row, so no own change of the row that
///   comes back can settle it away, and to the subject the row was last
///   sent under. A row never sent anywhere needs none.
fn start_over(tx: &Connection) -> rusqlite::Result<()> {
    tx.execute("INSERT INTO replica_applying (applying) VALUES (1)", [])?;
    new_store_id(
        tx,
        "the hub's memory stream was made anew, so no message id it sent to the old stream is used again",
    )?;
    let store = store_id(tx)?;
    let now = crate::memory_writes::now_ms();
    // Each deleted row's tombstone goes to the new stream too, so a
    // computer that still holds the row (it missed the delete) or joins the
    // new stream deletes it: deletes are final everywhere.
    type Deleted = (String, String, i64, i64, Option<String>, Option<String>);
    let deleted: Vec<Deleted> = tx
        .prepare(
            "SELECT r.kind, r.global_id, COALESCE(r.local_id, 0),
                    MAX(COALESCE(r.revision, 0),
                        COALESCE((SELECT MAX(o.revision) FROM replica_outbox o
                                   WHERE o.global_id = r.global_id), 0)) + 1,
                    r.level, r.owner
               FROM replica_ids r
              WHERE r.deleted_at IS NOT NULL AND r.subject IS NOT NULL",
        )?
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    for (kind, global, local, revision, level, owner) in deleted {
        tx.execute("DELETE FROM replica_outbox WHERE global_id = ?1", [&global])?;
        tx.execute(
            "INSERT INTO replica_outbox
                 (kind, local_id, revision, base_revision, change, created_at, actor,
                  global_id, level, owner, frozen)
             VALUES (?1, ?2, ?3, ?4, 'delete', ?5, 'ck-mc', ?6, ?7, ?8, 'null')",
            params![
                kind,
                local,
                revision,
                revision - 1,
                now,
                global,
                level,
                owner
            ],
        )?;
    }
    for table in schema::TABLES {
        let agent = if table.kind == "memory" {
            " AND level <> 'agent'"
        } else {
            ""
        };
        let rows: Vec<(i64, String, i64)> = tx
            .prepare(&format!(
                "SELECT id, global_id, revision FROM {} WHERE global_id IS NOT NULL{agent} ORDER BY id",
                table.name
            ))?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<rusqlite::Result<_>>()?;
        for (local, global, own_revision) in rows {
            let revision = apply::resend_revision(tx, table, local, &global)?;
            tx.execute(
                "DELETE FROM replica_outbox
                  WHERE kind = ?1 AND local_id = ?2 AND state <> 'raised' AND change <> 'delete'",
                params![table.kind, local],
            )?;
            if revision > own_revision {
                raise_to(tx, table, local, revision)?;
            }
            publish::queue_again(tx, table.kind, local, revision, &store)?;
        }
    }
    tx.execute_batch(
        "UPDATE replica_state
            SET stream_seq = 0, stream_message_id = NULL,
                held_epoch = NULL, held_since = NULL, held_why = NULL
          WHERE id = 1;
         UPDATE replica_ids SET revision = NULL, seq = NULL, written = NULL, undone = NULL;
         DELETE FROM replica_fences;
         DELETE FROM replica_passed;
         DELETE FROM replica_restore;
         DELETE FROM replica_applied;
         DELETE FROM replica_outbox WHERE state = 'published';
         DELETE FROM replica_applying;",
    )
}

/// Raise row `local` of `table` to `revision`, with a memory's clause
/// evidence, which readers look up at the row's current revision, under
/// the apply marker the caller holds, so nothing is captured.
fn raise_to(
    tx: &Connection,
    table: &schema::Table,
    local: i64,
    revision: i64,
) -> rusqlite::Result<()> {
    if table.kind == "memory" {
        tx.execute(
            &schema::carry_evidence("?1", "m.revision", "?2", "m.revision < ?2"),
            params![local, revision],
        )?;
    }
    tx.execute(
        &format!(
            "UPDATE {} SET revision = ?2 WHERE id = ?1 AND revision < ?2",
            table.name
        ),
        params![local, revision],
    )?;
    Ok(())
}

/// A hold of the memory stream at a message sealed under a fleet epoch
/// this computer's vault doesn't hold: nothing is sent while it lasts
/// ([`apply`]), so the person must see it and get the epoch's key to the
/// vault.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EpochHold {
    /// The epoch the stream waits for.
    pub epoch: u64,
    /// When the stream was first held for it, in milliseconds since the
    /// Unix epoch.
    pub since: i64,
    /// Why, as the engine logged it.
    pub why: String,
}

/// The hold of the memory stream for a fleet epoch, as the store records
/// it, for a health report to show; `None` while the stream isn't held for
/// one.
pub fn hold_status(conn: &Connection) -> rusqlite::Result<Option<EpochHold>> {
    conn.query_row(
        "SELECT held_epoch, held_since, held_why FROM replica_state
          WHERE id = 1 AND held_epoch IS NOT NULL",
        [],
        |row| {
            Ok(EpochHold {
                epoch: row.get::<_, i64>(0)?.max(0) as u64,
                since: row.get::<_, Option<i64>>(1)?.unwrap_or_default(),
                why: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
            })
        },
    )
    .optional()
}

/// Record that the stream is held for fleet epoch `epoch`, for `why`.
/// Returns whether this is a new hold: the stream wasn't held for that
/// epoch already. A hold for the same epoch keeps the time it began. The
/// hold ends when a message is next applied ([`apply`]).
pub(crate) fn record_hold(conn: &Connection, epoch: u64, why: &str) -> rusqlite::Result<bool> {
    let changed = conn.execute(
        "UPDATE replica_state SET held_epoch = ?1, held_since = ?2, held_why = ?3
          WHERE id = 1 AND held_epoch IS NOT ?1",
        params![epoch as i64, crate::memory_writes::now_ms(), why],
    )?;
    Ok(changed > 0)
}

/// Queue a create for every row of this computer that was never sent, and
/// mark the computer joined. Returns how many rows were queued.
fn queue_unsent(conn: &mut Connection, box_id: &str) -> rusqlite::Result<usize> {
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let now = crate::memory_writes::now_ms();
    let mut queued = 0;
    for table in schema::TABLES {
        let agent = if table.kind == "memory" {
            " AND level <> 'agent'"
        } else {
            ""
        };
        let actor = if table.kind == "memory" {
            "COALESCE(source_type, 'ck-mc')"
        } else {
            "'ck-mc'"
        };
        queued += tx.execute(
            &format!(
                "INSERT OR IGNORE INTO replica_outbox
                     (kind, local_id, revision, base_revision, change, created_at, actor)
                 SELECT '{kind}', id, revision, 0, 'create', ?1, {actor}
                   FROM {name} WHERE global_id IS NULL{agent} ORDER BY id",
                kind = table.kind,
                name = table.name,
            ),
            [now],
        )?;
    }
    tx.execute(
        "UPDATE replica_state SET joined_at = ?1, box_id = ?2 WHERE id = 1",
        params![now, box_id],
    )?;
    tx.commit()?;
    Ok(queued)
}
