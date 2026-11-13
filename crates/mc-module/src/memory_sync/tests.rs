use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use rusqlite::params;
use serde_json::{json, Value};

use super::engram::{Engram, Heads};
use super::*;
use crate::memory_levels::{Actor, OriginProfile, Owner};

const ACCOUNT: &str = "11111111111111111111111111111111";
const DEVICE: &str = "22222222222222222222222222222222";
const NOW: i64 = 1_792_108_800_000;

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("testdata/memory-op-v1")
            .join(name),
    )
    .unwrap()
}

/// A vector's create event. The vectors name single ordinals; an event
/// carries ranges, so each becomes a one-message range.
fn event(name: &str) -> CreateEvent {
    let raw: Value = serde_json::from_slice(&fixture(&format!("{name}.event.json"))).unwrap();
    let text = |key: &str| raw[key].as_str().map(str::to_owned);
    CreateEvent {
        kind: match raw["kind"].as_str() {
            Some("Create") => CreateKind::Create,
            _ => CreateKind::MergeSurvivor,
        },
        actor: match raw["actor"].as_str() {
            Some("main_agent") => Actor::MainAgent,
            _ => Actor::Historian,
        },
        session_id: text("session_id"),
        ordinals: raw["ordinals"]
            .as_array()
            .unwrap()
            .iter()
            .map(|ordinal| {
                let ordinal = ordinal.as_u64().unwrap();
                (ordinal, ordinal)
            })
            .collect(),
        memory_id: raw["memory_id"].as_i64().unwrap(),
        writer_project_id: text("writer_project_id"),
        owner: serde_json::from_value(raw["owner"].clone()).unwrap(),
        category_tag: text("category_tag").unwrap(),
        effective_category_id: text("effective_category_id"),
        importance: raw["importance"].as_i64(),
        expires_at: raw["expires_at"].as_i64(),
        content: text("content").unwrap(),
        origin_profile: serde_json::from_value(raw["origin_profile"].clone()).unwrap(),
        snapshot_digest: text("snapshot_digest"),
    }
}

#[test]
fn section8_serialization_oracle() {
    let actual = jcs::canonicalize(&fixture("section8.json")).unwrap();
    assert_eq!(actual, fixture("section8.jcs"));
    assert_eq!(
        jcs::digest(&actual),
        String::from_utf8(fixture("section8.sha256"))
            .unwrap()
            .trim()
    );
}

#[test]
fn fixture_checksums() {
    for line in String::from_utf8(fixture("SHA256SUMS")).unwrap().lines() {
        let (hash, path) = line.split_once("  ").unwrap();
        assert_eq!(jcs::digest(&fixture(path)), hash, "{path}");
    }
}

/// Each vector maps to exactly the bytes the card's mapper produced, so
/// Engram reads ck-mc's ops as it read the card's.
fn vector(name: &str) {
    let output = op::map(&event(name), ACCOUNT, DEVICE, 42, (NOW, 0)).unwrap();
    assert_eq!(
        String::from_utf8(output.clone()).unwrap(),
        String::from_utf8(fixture(&format!("{name}.jcs"))).unwrap(),
        "{name}"
    );
    assert_eq!(
        jcs::digest(&output),
        String::from_utf8(fixture(&format!("{name}.sha256")))
            .unwrap()
            .trim()
    );
    let project: crate::memory_context::ProjectContext =
        serde_json::from_slice(&fixture("context-project.json")).unwrap();
    assert_eq!(
        crate::memory_context::snapshot_digest(&project),
        event(name).snapshot_digest.unwrap()
    );
}

#[test]
fn op_vectors() {
    // The card's dreamer vectors (`dreamer`, `known-issues`) have no
    // counterpart: the new ck-mc has no dreamer writes yet.
    for name in [
        "main-known",
        "main-unknown",
        "historian",
        "expiring",
        "null-importance",
    ] {
        vector(name);
    }
}

#[test]
fn ordinals_merge_into_ranges() {
    let mut create = event("historian");
    create.ordinals = vec![(20, 22), (12, 14), (15, 15), (40, 41)];
    let output = op::map(&create, ACCOUNT, DEVICE, 42, (NOW, 0)).unwrap();
    let value: Value = serde_json::from_slice(&output).unwrap();
    assert_eq!(
        value["provenance"]["ordinals"],
        json!([[12, 15], [20, 22], [40, 41]])
    );
    create.ordinals = vec![(5, 4)];
    assert_eq!(
        op::map(&create, ACCOUNT, DEVICE, 42, (NOW, 0)),
        Err("op_unmappable")
    );
}

#[test]
fn strict_json_refuses_duplicates_surrogates_floats() {
    for raw in [
        r#"{"a":1,"a":2}"#,
        r#"{"x":"\ud800"}"#,
        r#"{"x":1.0}"#,
        r#"{"x":9007199254740992}"#,
    ] {
        assert!(jcs::canonicalize(raw.as_bytes()).is_err(), "{raw}");
    }
    assert_eq!(
        jcs::canonicalize(br#"{"z":1,"a":2}"#).unwrap(),
        br#"{"a":2,"z":1}"#
    );
}

fn scratch(name: &str) -> PathBuf {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!(
        "ck-mc-sync-{name}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn database(name: &str) -> ContextDb {
    ContextDb::create_for_tests(&scratch(name).join("context.db")).unwrap()
}

fn heads(head: i64) -> Heads {
    Heads {
        account: ACCOUNT.into(),
        device: DEVICE.into(),
        head,
    }
}

fn enroll(db: &ContextDb) {
    transaction(db, &mut |conn| account::refresh(conn, &Ok(heads(0)))).unwrap();
}

/// Insert a memory row and queue its create, in one transaction.
fn create(db: &ContextDb, content: &str, kind: CreateKind) -> i64 {
    let mut id = 0;
    transaction(db, &mut |conn| {
        conn.execute(
            "INSERT INTO memories (level, owner_id, category, origin_category, content, normalized_hash, first_seen_at,
                 created_at, updated_at, last_seen_at, status, source_type)
             VALUES ('project', 'pj-a', 'swe:naming', 'NAMING', ?1, ?1, 1, 1, 1, 1, 'active', 'agent')",
            [content],
        )?;
        id = conn.last_insert_rowid();
        queue(
            conn,
            &CreateEvent {
                kind,
                memory_id: id,
                content: content.to_owned(),
                ..event("main-known")
            },
            NOW,
        )
    })
    .unwrap();
    id
}

fn counts(db: &ContextDb) -> [i64; 2] {
    db.with_connection(|conn| {
        ["memory_ops", "memory_outbox"].map(|table| {
            conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap()
        })
    })
}

#[test]
fn a_create_queues_only_on_an_enrolled_account() {
    let db = database("enrolled");
    // No account cached yet: nothing queued, the write still lands.
    create(&db, "first", CreateKind::Create);
    assert_eq!(counts(&db), [0, 0]);
    enroll(&db);
    create(&db, "second", CreateKind::Create);
    assert_eq!(counts(&db), [1, 1]);
    // A merge survivor is never synced.
    create(&db, "third", CreateKind::MergeSurvivor);
    assert_eq!(counts(&db), [1, 1]);
    let state = db
        .with_connection(|conn| ledger::sync_state(conn, DEVICE))
        .unwrap()
        .unwrap();
    assert_eq!(state.next_local_id, 2);
    assert_eq!((state.hlc_wall_ms, state.hlc_logical), (NOW, 0));
    // Revoked enrollment queues nothing more.
    transaction(&db, &mut |conn| {
        account::refresh(conn, &Err("key_unavailable".into()))
    })
    .unwrap();
    create(&db, "fourth", CreateKind::Create);
    assert_eq!(counts(&db), [1, 1]);
}

#[derive(Default)]
struct FakeState {
    head: i64,
    entries: BTreeMap<i64, Vec<u8>>,
}

#[derive(Clone, Default)]
struct Fake {
    state: Arc<Mutex<FakeState>>,
}

impl Engram for Fake {
    async fn heads(&self) -> Result<Heads, String> {
        Ok(heads(self.state.lock().unwrap().head))
    }

    async fn append(&self, seq: i64, bytes: &[u8]) -> Result<i64, String> {
        let mut state = self.state.lock().unwrap();
        if let Some(existing) = state.entries.get(&seq) {
            return if existing == bytes {
                Ok(seq)
            } else {
                Err("seq_reused".into())
            };
        }
        if seq != state.head + 1 {
            return Err("seq_moved".into());
        }
        state.entries.insert(seq, bytes.to_vec());
        state.head = seq;
        Ok(seq)
    }
}

#[tokio::test]
async fn a_cycle_appends_queued_ops_in_order() {
    let db = database("drain");
    enroll(&db);
    create(&db, "first", CreateKind::Create);
    create(&db, "second", CreateKind::Create);
    let fake = Fake::default();
    fake.state.lock().unwrap().head = 7;
    cycle(&fake, &db, "holder").await.unwrap();
    let state = fake.state.lock().unwrap();
    assert_eq!(state.entries.keys().copied().collect::<Vec<_>>(), [8, 9]);
    let first: Value = serde_json::from_slice(&state.entries[&8]).unwrap();
    assert_eq!(first["payload"]["snapshot"]["content"], "first");
    drop(state);
    let appended: Vec<Option<i64>> = db.with_connection(|conn| {
        conn.prepare("SELECT appended_seq FROM memory_outbox ORDER BY local_id")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    });
    assert_eq!(appended, [Some(8), Some(9)]);
    assert_eq!(scheduling_state(&db).unwrap(), (false, false));
}

#[test]
fn a_failed_sync_write_fails_the_memory_write() {
    let db = database("atomic");
    enroll(&db);
    // A broken outbox makes the queue step fail, which must take the memory
    // row down with it.
    db.with_connection(|conn| conn.execute_batch("DROP TABLE memory_outbox"))
        .unwrap();
    let result = transaction(&db, &mut |conn| {
        conn.execute(
            "INSERT INTO memories (level, owner_id, category, origin_category, content, normalized_hash, first_seen_at,
                 created_at, updated_at, last_seen_at, status, source_type)
             VALUES ('project', 'pj-a', 'swe:naming', 'NAMING', 'x', 'h', 1, 1, 1, 1, 'active', 'agent')",
            [],
        )?;
        let id = conn.last_insert_rowid();
        queue(
            conn,
            &CreateEvent {
                memory_id: id,
                ..event("main-known")
            },
            NOW,
        )
    });
    assert!(result.is_err());
    let memories: i64 = db.with_connection(|conn| {
        conn.query_row("SELECT count(*) FROM memories", params![], |row| row.get(0))
            .unwrap()
    });
    assert_eq!(memories, 0);
}

#[test]
fn owner_and_profile_shape_eligibility() {
    let mut create = event("main-known");
    assert!(op::eligible(&create));
    create.origin_profile = None;
    assert!(!op::eligible(&create));
    let mut create = event("main-known");
    create.owner = Some(Owner {
        kind: "workspace".into(),
        id: "ws".into(),
    });
    assert_eq!(
        op::map(&create, ACCOUNT, DEVICE, 1, (NOW, 0)),
        Err("op_unmappable")
    );
    let mut create = event("main-known");
    create.origin_profile = Some(OriginProfile {
        name: String::new(),
        version: "1".into(),
        digest: "d".into(),
    });
    assert_eq!(
        op::map(&create, ACCOUNT, DEVICE, 1, (NOW, 0)),
        Err("op_unmappable")
    );
}
