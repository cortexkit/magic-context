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
        let db = Arc::new(ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap());
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
