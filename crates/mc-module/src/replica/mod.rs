//! Memories shared across the user's computers.
//!
//! Every computer the user pairs keeps its own `context.db`. The memories
//! a person or an agent would miss on another computer (project, workspace
//! and global memories, observations and primers) travel between them
//! through one stream on the user's hub, `HUB_MEMORY` ([`hub`]):
//! - **Capture** happens in the store ([`schema`]): triggers on each
//!   replicated table write one `replica_outbox` row per changed row and
//!   raise its revision, whichever of the many writers changed it.
//! - **Publish** ([`publish`]) drains the outbox in batches. Each message is
//!   a full snapshot of the row ([`snapshot`]), sealed by the vault under
//!   the fleet epoch key ([`seal`]), and sent with the message id
//!   `<global id>@<revision>`, so a retry is stored once ([`wire`]).
//! - **Follow** ([`apply`]) reads the stream in order, opens each message
//!   and applies it in one transaction that stores the stream position.
//!   Stream order decides between computers: every computer applies the
//!   same messages in the same order. An apply writes no outbox row.
//! - **Join** ([`Replica::join`]): the first time a computer follows the
//!   stream it applies everyone else's history, then publishes every row of
//!   its own that has no global id yet.
//!
//! A row's global id is `<box id>.<local id>` of the computer that first
//! published it ([`wire::global_id`]); the local id agents see keeps naming
//! the same row on each computer. The box id is the computer's machine id,
//! read from the bus client ([`box_id`]); without one nothing publishes and
//! the outbox waits.
//!
//! This module is the engine. The live hub connection (JetStream on the
//! hub's domain, the durable consumer named for the box id) implements
//! [`hub::Hub`] and runs [`Replica::run`] once ck-bus grants modules the
//! hub; until then a computer runs as before, its outbox kept to one row
//! per changed row.

pub mod apply;
pub mod hub;
pub mod publish;
pub mod schema;
pub mod seal;
pub mod snapshot;
pub mod wire;

#[cfg(test)]
mod capture_tests;
#[cfg(test)]
mod exchange_tests;
#[cfg(test)]
mod samples_tests;
#[cfg(test)]
mod schema_tests;
#[cfg(test)]
pub(crate) mod test_support;

use std::sync::Arc;
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};

use crate::context_db::ContextDb;
use hub::Hub;
use seal::Sealer;

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
/// as its row's source type (a create) or `ck-mc`. `epoch` is the epoch of
/// the dreamer lease the run held. Once that lease exists, a receiver will
/// skip a dreamer change whose epoch is older than the newest lease epoch it
/// knows for that owner; until then the epoch is null.
pub(crate) fn name_writer(
    tx: &Connection,
    actor: &str,
    run_id: Option<i64>,
    epoch: Option<i64>,
) -> rusqlite::Result<()> {
    tx.execute("DELETE FROM replica_writer", [])?;
    tx.execute(
        "INSERT INTO replica_writer (actor, run_id, epoch) VALUES (?1, ?2, ?3)",
        params![actor, run_id, epoch],
    )?;
    Ok(())
}

/// End [`name_writer`]'s naming, before the transaction commits, so no
/// other writer is ever named by it.
pub(crate) fn unname_writer(tx: &Connection) -> rusqlite::Result<()> {
    tx.execute("DELETE FROM replica_writer", [])?;
    Ok(())
}

/// How many messages one round reads or sends.
pub const BATCH: usize = seal::MAX_BATCH;

/// How long the engine waits between rounds when there is nothing to do.
const IDLE: Duration = Duration::from_secs(30);

/// The engine of one computer: its store, the hub's stream, the vault's
/// sealing, and its box id.
pub struct Replica {
    pub(crate) db: Arc<ContextDb>,
    pub(crate) hub: Arc<dyn Hub>,
    pub(crate) sealer: Arc<dyn Sealer>,
    pub(crate) box_id: String,
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
        }
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
    /// and restore work everywhere. A row of this computer that matches a
    /// fact the history carried was linked to it while the history applied
    /// ([`apply`]), and is sent under that fact's id instead.
    pub async fn join(&self) -> Result<(), String> {
        if self.joined_at()?.is_some() {
            return Ok(());
        }
        let last = self
            .hub
            .last_seq()
            .await
            .map_err(|error| error.to_string())?;
        while self.position()? < last {
            if self.follow().await? == 0 {
                break;
            }
        }
        if self.position()? < last {
            return Err("the stream's history could not all be read".into());
        }
        let queued = self
            .db
            .with_connection(|conn| queue_unsent(conn, &self.box_id));
        let queued = queued.map_err(|error| error.to_string())?;
        tracing::info!("ck-mc: replica: joined the memory stream at {last}; {queued} rows queued");
        Ok(())
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

    /// Follow and publish until `stop` is notified: join first, then read
    /// what arrived and send what changed, waiting `IDLE` (or a `wake`)
    /// between rounds that found nothing. A failed round is logged once per
    /// distinct reason and tried again on the next.
    pub async fn run(self, wake: Arc<tokio::sync::Notify>) {
        let mut reported: Option<String> = None;
        loop {
            let round = async {
                self.join().await?;
                let arrived = self.follow().await?;
                let sent = self.publish().await?;
                Ok::<_, String>(arrived + sent.sent)
            }
            .await;
            let busy = match round {
                Ok(done) => {
                    reported = None;
                    done > 0
                }
                Err(error) => {
                    if reported.as_deref() != Some(error.as_str()) {
                        tracing::warn!("ck-mc: replica: {error}");
                        reported = Some(error);
                    }
                    false
                }
            };
            if !busy {
                let _ = tokio::time::timeout(IDLE, wake.notified()).await;
            }
        }
    }
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
