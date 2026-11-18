//! What the replica tests share: a sealer that seals and opens as the vault
//! does, and stores that exchange messages through one in-memory hub.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use serde::Serialize;
use zeroize::Zeroizing;

use super::hub::InMemoryHub;
use super::seal::{OpenInput, Opened, SealError, SealInput, Sealed, Sealer};
use super::wire::{decode, encode};
use super::Replica;
use crate::context_db::ContextDb;

/// The domain the vault binds Magic Context's seals to, chosen from the
/// attested caller.
pub(crate) const MAGIC_CONTEXT_DOMAIN: &str = "ck-fleet-epoch-aad/magic-context/v1";

/// The AEAD additional data the vault seals a caller's `aad` with: RFC 8785
/// `{"aad": <caller aad, base64url>, "epoch": e, "v": <caller domain>}`.
pub(crate) fn vault_aad(caller_aad: &[u8], epoch: u64, domain: &str) -> Vec<u8> {
    #[derive(Serialize)]
    struct Record<'a> {
        aad: String,
        epoch: u64,
        v: &'a str,
    }
    serde_jcs::to_vec(&Record {
        aad: encode(caller_aad),
        epoch,
        v: domain,
    })
    .unwrap()
}

/// Seals and opens as the vault does, under one epoch key held in the test:
/// XChaCha20-Poly1305 with the vault's additional data, a fresh 24-byte
/// nonce for each item, and the vault's per-item refusal for an item that
/// won't open.
pub(crate) struct TestSealer {
    key: [u8; 32],
    epoch: u64,
    domain: &'static str,
}

/// Every test sealer draws from one counter, so no two seals under the
/// shared test key ever use the same nonce.
static NONCES: AtomicU64 = AtomicU64::new(1);

impl TestSealer {
    pub(crate) fn new(key: [u8; 32], epoch: u64) -> Arc<Self> {
        Arc::new(Self::with_domain(key, epoch, MAGIC_CONTEXT_DOMAIN))
    }

    pub(crate) fn with_domain(key: [u8; 32], epoch: u64, domain: &'static str) -> Self {
        Self { key, epoch, domain }
    }

    fn cipher(&self) -> XChaCha20Poly1305 {
        XChaCha20Poly1305::new((&self.key).into())
    }

    /// Open one item, as `fleet.epoch_open` does.
    pub(crate) fn open_one(&self, item: &OpenInput) -> Opened {
        let refused = || Opened::Refused {
            code: "fleet_epoch_open_failed".into(),
            class: "permanent".into(),
        };
        let (Ok(nonce), Ok(ciphertext)) = (decode(&item.nonce), decode(&item.ciphertext)) else {
            return refused();
        };
        if nonce.len() != 24 || item.epoch != self.epoch {
            return refused();
        }
        let aad = vault_aad(&item.aad, item.epoch, self.domain);
        match self.cipher().decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: &aad,
            },
        ) {
            Ok(plaintext) => Opened::Plaintext(Zeroizing::new(plaintext)),
            Err(_) => refused(),
        }
    }
}

#[async_trait]
impl Sealer for TestSealer {
    async fn seal_batch(&self, items: &[SealInput]) -> Result<Vec<Sealed>, SealError> {
        items
            .iter()
            .map(|item| {
                let mut nonce = [0u8; 24];
                nonce[..8].copy_from_slice(&NONCES.fetch_add(1, Ordering::Relaxed).to_be_bytes());
                let aad = vault_aad(&item.aad, self.epoch, self.domain);
                let ciphertext = self
                    .cipher()
                    .encrypt(
                        XNonce::from_slice(&nonce),
                        Payload {
                            msg: &item.plaintext,
                            aad: &aad,
                        },
                    )
                    .map_err(|_| SealError {
                        code: "store_error".into(),
                        transient: true,
                    })?;
                Ok(Sealed {
                    epoch: self.epoch,
                    nonce: encode(&nonce),
                    ciphertext: encode(&ciphertext),
                })
            })
            .collect()
    }

    async fn open_batch(&self, items: &[OpenInput]) -> Result<Vec<Opened>, SealError> {
        Ok(items.iter().map(|item| self.open_one(item)).collect())
    }
}

/// The epoch key every computer of a test's user holds.
pub(crate) const KEY: [u8; 32] = [0x31; 32];

/// A box id for computer `n` of a test.
pub(crate) fn box_of(n: u8) -> String {
    format!("{n:x}").repeat(32)
}

/// One computer of a test: a fresh store and its replica engine on the
/// shared hub.
pub(crate) struct Computer {
    pub db: Arc<ContextDb>,
    pub replica: Replica,
    _dir: tempfile::TempDir,
}

impl Computer {
    pub(crate) fn new(hub: &Arc<InMemoryHub>, n: u8) -> Self {
        let dir = tempfile::tempdir().unwrap();
        drop(ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap());
        Self::open(hub, n, dir)
    }

    /// Computer `n` running on the store in `dir`, which holds a
    /// `context.db` already: a store copied or restored there.
    pub(crate) fn open(hub: &Arc<InMemoryHub>, n: u8, dir: tempfile::TempDir) -> Self {
        let db = Arc::new(ContextDb::open(&dir.path().join("context.db")).unwrap());
        let replica = Replica::new(
            Arc::clone(&db),
            Arc::clone(hub) as Arc<dyn super::hub::Hub>,
            TestSealer::new(KEY, 1),
            box_of(n),
        );
        Self {
            db,
            replica,
            _dir: dir,
        }
    }

    /// A copy of the store as it is now, in a folder of its own, as a
    /// backup takes it.
    pub(crate) fn copy(&self) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("context.db");
        self.db.with_connection(|conn| {
            conn.execute("VACUUM INTO ?1", [target.to_str().unwrap()])
                .unwrap()
        });
        dir
    }

    /// The id this store's global ids are formed under.
    pub(crate) fn store_id(&self) -> String {
        self.db
            .with_connection(|conn| super::store_id(conn))
            .unwrap()
    }

    /// The live memories' texts, in order.
    pub(crate) fn live(&self) -> Vec<String> {
        self.texts(&format!(
            "SELECT content FROM memories WHERE {} ORDER BY content",
            crate::context_migrations::LIVE
        ))
    }

    /// Run `sql` on the store, as a writer outside the engine would.
    pub(crate) fn execute(&self, sql: &str) {
        self.db
            .with_connection(|conn| conn.execute_batch(sql))
            .unwrap();
    }

    pub(crate) fn value<T: rusqlite::types::FromSql>(&self, sql: &str) -> T {
        self.db
            .with_connection(|conn| conn.query_row(sql, [], |row| row.get(0)))
            .unwrap()
    }

    pub(crate) fn texts(&self, sql: &str) -> Vec<String> {
        self.db.with_connection(|conn| {
            conn.prepare(sql)
                .unwrap()
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap()
        })
    }

    /// Follow the stream until nothing new arrives.
    pub(crate) async fn follow_all(&self) {
        while self.replica.follow().await.unwrap() > 0 {}
    }

    /// Send the outbox until it has nothing left to send.
    pub(crate) async fn publish_all(&self) {
        loop {
            let report = self.replica.publish().await.unwrap();
            if report.sent == 0 {
                break;
            }
        }
    }

    /// Join, then exchange until this computer and the stream agree.
    pub(crate) async fn sync(&self) {
        self.replica.join().await.unwrap();
        self.publish_all().await;
        self.follow_all().await;
    }
}

/// Insert a project memory as a writer would, returning its id.
pub(crate) fn memory(computer: &Computer, owner: &str, content: &str) -> i64 {
    computer.db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO memories (level, owner_id, category, origin_category, content,
                 normalized_hash, first_seen_at, created_at, updated_at, last_seen_at)
             VALUES ('project', ?1, 'swe:architecture', 'ARCHITECTURE', ?2, ?3, 1, 1, 1, 1)",
            rusqlite::params![
                owner,
                content,
                crate::memory_writes::normalized_hash(content)
            ],
        )
        .unwrap();
        conn.last_insert_rowid()
    })
}

/// Treat every replicated row in the store as sent: give each the global id
/// it would be sent under and empty the outbox. A writer's change of such a
/// row then raises its revision and queues it, as it would on a computer
/// that follows the hub.
pub(crate) fn mark_sent(conn: &rusqlite::Connection) {
    for table in super::schema::TABLES {
        let letter = match table.kind {
            "observation" => "o",
            "primer" => "p",
            _ => "m",
        };
        conn.execute(
            &format!(
                "UPDATE {} SET global_id = 'sent.{letter}' || id WHERE global_id IS NULL",
                table.name
            ),
            [],
        )
        .unwrap();
    }
    conn.execute("DELETE FROM replica_outbox", []).unwrap();
}

/// Each replicated row's revision, keyed `kind:id`.
pub(crate) fn revisions(conn: &rusqlite::Connection) -> std::collections::BTreeMap<String, i64> {
    let mut found = std::collections::BTreeMap::new();
    for table in super::schema::TABLES {
        let rows: Vec<(i64, i64)> = conn
            .prepare(&format!("SELECT id, revision FROM {}", table.name))
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        for (id, revision) in rows {
            found.insert(format!("{}:{id}", table.kind), revision);
        }
    }
    found
}

/// The outbox rows that would be sent, one `kind:id change` line per row,
/// in order. A `raised` row is a revision raised with nothing replicated
/// changed, which is never sent by itself.
pub(crate) fn queued(conn: &rusqlite::Connection) -> Vec<String> {
    conn.prepare(
        "SELECT kind || ':' || local_id || ' ' || change FROM replica_outbox
          WHERE state <> 'raised' ORDER BY kind, local_id",
    )
    .unwrap()
    .query_map([], |row| row.get(0))
    .unwrap()
    .collect::<rusqlite::Result<_>>()
    .unwrap()
}

/// The writer under test, run after [`mark_sent`] with `before` the
/// revisions then, changed exactly the rows `expected` names (`kind:id
/// change`), each once: one outbox row each, and each existing row's
/// revision one higher than before.
pub(crate) fn assert_captured(
    conn: &rusqlite::Connection,
    before: &std::collections::BTreeMap<String, i64>,
    expected: &[&str],
) {
    let mut expected: Vec<String> = expected.iter().map(|line| (*line).to_owned()).collect();
    expected.sort();
    let mut found = queued(conn);
    found.sort();
    assert_eq!(found, expected, "the outbox holds one row per changed row");
    let after = revisions(conn);
    for line in &expected {
        let row = line.split(' ').next().unwrap();
        let change = line.split(' ').nth(1).unwrap();
        let outbox: i64 = conn
            .query_row(
                "SELECT revision FROM replica_outbox WHERE kind || ':' || local_id = ?1",
                [row],
                |found| found.get(0),
            )
            .unwrap();
        match (before.get(row), after.get(row)) {
            (Some(old), Some(new)) => {
                assert_eq!(*new, old + 1, "{row}: one change raises the revision once");
                assert_eq!(outbox, *new, "{row}: the outbox names the new revision");
            }
            (None, Some(new)) => assert_eq!(outbox, *new, "{row}: a new row"),
            (_, None) => assert_eq!(change, "delete", "{row}: only a delete leaves no row"),
        }
    }
    for (row, old) in before {
        if !expected
            .iter()
            .any(|line| line.split(' ').next() == Some(row.as_str()))
        {
            let now = after.get(row).copied();
            assert!(
                now == Some(*old) || now.is_some_and(|now| held(conn, row, now)),
                "{row} did not change"
            );
        }
    }
}

/// Every replicated row's revision and replicated state, keyed `kind:id`:
/// its replicated columns, and for a memory the child rows its snapshot
/// carries. Read straight from the tables, not through the capture, so a
/// writer test can tell which rows really changed.
pub(crate) fn state(
    conn: &rusqlite::Connection,
) -> std::collections::BTreeMap<String, (i64, String)> {
    let mut found = std::collections::BTreeMap::new();
    for table in super::schema::TABLES {
        let ids: Vec<i64> = conn
            .prepare(&format!("SELECT id FROM {}", table.name))
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        for id in ids {
            let mut values = super::snapshot::columns(conn, table, id).unwrap().unwrap();
            if let Some(metadata) = values.get("metadata_json").cloned() {
                values.insert(
                    "metadata_json".into(),
                    super::snapshot::shared_metadata(&metadata),
                );
            }
            if table.kind == "memory" {
                for child in &super::schema::CHILDREN {
                    let rows: Vec<String> = conn
                        .prepare(&format!(
                            "SELECT {} FROM {} WHERE {} = ?1 ORDER BY 1",
                            child
                                .replicated
                                .iter()
                                .map(|column| format!("quote({column})"))
                                .collect::<Vec<_>>()
                                .join(" || '|' || "),
                            child.name,
                            child.owner
                        ))
                        .unwrap()
                        .query_map([id], |row| row.get(0))
                        .unwrap()
                        .collect::<rusqlite::Result<_>>()
                        .unwrap();
                    values.insert(child.name.to_owned(), serde_json::json!(rows));
                }
            }
            if table.kind == "memory" {
                let level = values["level"].as_str().unwrap_or_default();
                if level == "agent" {
                    continue;
                }
            }
            let revision: i64 = conn
                .query_row(
                    &format!("SELECT revision FROM {} WHERE id = ?1", table.name),
                    [id],
                    |row| row.get(0),
                )
                .unwrap();
            found.insert(
                format!("{}:{id}", table.kind),
                (revision, serde_json::Value::Object(values).to_string()),
            );
        }
    }
    found
}

/// The writer under test, run after [`mark_sent`] with `before` the
/// [`state`] then, queued exactly the rows whose replicated state it
/// changed, one outbox row each, and raised each changed row's revision
/// once. Returns the changed rows, `kind:id`.
pub(crate) fn assert_changes_captured(
    conn: &rusqlite::Connection,
    before: &std::collections::BTreeMap<String, (i64, String)>,
) -> Vec<String> {
    let after = state(conn);
    let mut changed: Vec<String> = after
        .iter()
        .filter(|(row, (_, values))| before.get(*row).map(|(_, old)| old) != Some(values))
        .map(|(row, _)| row.clone())
        .collect();
    changed.extend(
        before
            .keys()
            .filter(|row| !after.contains_key(*row))
            .cloned(),
    );
    changed.sort();
    let mut queued: Vec<String> = queued(conn)
        .iter()
        .map(|line| line.split(' ').next().unwrap().to_owned())
        .collect();
    queued.sort();
    assert_eq!(
        queued, changed,
        "one outbox row for each row whose replicated state changed"
    );
    for row in &changed {
        if let (Some((old, _)), Some((new, _))) = (before.get(row), after.get(row)) {
            assert_eq!(*new, old + 1, "{row}: one change raises the revision once");
        }
    }
    for (row, (old, _)) in before {
        if !changed.contains(row) {
            let now = after.get(row).map(|(revision, _)| *revision);
            assert!(
                now == Some(*old) || now.is_some_and(|now| held(conn, row, now)),
                "{row}: a row whose replicated state is unchanged keeps its revision, or holds a raised one that is never sent"
            );
        }
    }
    changed
}

/// Whether row `row` (`kind:id`) holds revision `revision` as `raised`: a
/// revision raised with nothing replicated changed, never sent by itself.
fn held(conn: &rusqlite::Connection, row: &str, revision: i64) -> bool {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM replica_outbox
                        WHERE kind || ':' || local_id = ?1 AND state = 'raised' AND revision = ?2)",
        rusqlite::params![row, revision],
        |found| found.get(0),
    )
    .unwrap()
}
