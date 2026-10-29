use super::engram::{Engram, Heads};
use super::*;
use mc_store::memory_levels::{Actor, CreateKind};
use rusqlite::params;
use serde_json::{json, Value};
use std::collections::{BTreeMap, VecDeque};
use std::path::PathBuf;

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
fn event(name: &str) -> CreateEvent {
    serde_json::from_slice(&fixture(&format!("{name}.event.json"))).unwrap()
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

fn vector(name: &str) {
    let output = op::map(&event(name), ACCOUNT, DEVICE, 42, (NOW, 0)).unwrap();
    assert_eq!(output, fixture(&format!("{name}.jcs")), "{name}");
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
    let v: Value = serde_json::from_slice(&output).unwrap();
    assert_eq!(
        v["provenance"]["authority_snapshot"],
        "681ccc5fbabb8bf738ddd6e1b9d5a4f1a4bd2ab700f568d46e1d388be6e4640e"
    );
    assert_eq!(v["op_id"], v["memory_id"]);
    assert_eq!(v["op_id"], v["revision"]["result"]);
    assert_eq!(v["revision"]["parents"], json!([]));
    assert_eq!(v["delivery"], "A");
}
#[test]
fn main_known_vector() {
    vector("main-known");
}
#[test]
fn main_unknown_vector() {
    vector("main-unknown");
}
#[test]
fn historian_vector() {
    vector("historian");
}
#[test]
fn dreamer_vector() {
    vector("dreamer");
}
#[test]
fn expiring_vector() {
    vector("expiring");
}
#[test]
fn known_issues_vector() {
    vector("known-issues");
}
#[test]
fn null_importance_vector() {
    vector("null-importance");
}

#[test]
fn strict_json_refuses_duplicates_surrogates_floats() {
    for raw in [
        r#"{"a":1,"a":2}"#,
        r#"{"x":"\ud800"}"#,
        r#"{"x":"\udfff"}"#,
        r#"{"x":1.0}"#,
        r#"{"x":1e1}"#,
        r#"{"x":9007199254740992}"#,
    ] {
        assert!(jcs::canonicalize(raw.as_bytes()).is_err(), "{raw}");
    }
    assert_eq!(
        jcs::canonicalize(br#"{"z":1,"a":2}"#).unwrap(),
        br#"{"a":2,"z":1}"#
    );
    assert_eq!(
        jcs::canonicalize("{\"😀\":1,\"\u{e000}\":2}".as_bytes()).unwrap(),
        "{\"😀\":1,\"\u{e000}\":2}".as_bytes()
    );
}

struct Db {
    conn: Mutex<Connection>,
}
impl Db {
    fn open(path: &std::path::Path) -> Self {
        Self {
            conn: Mutex::new(Connection::open(path).unwrap()),
        }
    }
    fn new(path: &std::path::Path) -> Self {
        let db = Self::open(path);
        let schema = include_str!("../../../mc-store/testdata/context_schema/schema.sql");
        let sync = schema
            .split("CREATE TABLE memory_ops (")
            .nth(1)
            .unwrap()
            .split("CREATE TABLE schema_migrations")
            .next()
            .unwrap();
        db.conn.lock().unwrap().execute_batch(&format!("CREATE TABLE memories(id INTEGER PRIMARY KEY,content TEXT); CREATE TABLE memory_placement(memory_id INTEGER PRIMARY KEY); CREATE TABLE prompt_state(m0 BLOB,m1 BLOB,epoch INTEGER,folds INTEGER); INSERT INTO prompt_state VALUES(x'1234',x'5678',9,0); CREATE TABLE memory_ops ({sync}")).unwrap();
        db
    }
    fn tx(&self, f: &mut dyn FnMut(&Connection) -> rusqlite::Result<()>) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        f(&tx).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }
    fn ready(&self) {
        self.tx(&mut |c| account::refresh(c, &Ok(heads(0))))
            .unwrap();
    }
    fn create(&self, id: i64, e: &CreateEvent) -> Result<Option<&'static str>, String> {
        let mut reason = None;
        self.tx(&mut |c| {
            c.execute("INSERT INTO memories VALUES(?1,?2)", params![id, e.content])?;
            c.execute("INSERT INTO memory_placement VALUES(?1)", [id])?;
            reason = queue(
                c,
                &CreateEvent {
                    memory_id: id,
                    ..e.clone()
                },
                NOW,
            )?;
            Ok(())
        })?;
        Ok(reason)
    }
    fn counts(&self) -> [i64; 4] {
        let c = self.conn.lock().unwrap();
        [
            "memories",
            "memory_placement",
            "memory_ops",
            "memory_outbox",
        ]
        .map(|t| {
            c.query_row(&format!("SELECT count(*) FROM {t}"), [], |r| r.get(0))
                .unwrap()
        })
    }
    fn state(&self) -> ledger::SyncState {
        ledger::sync_state(&self.conn.lock().unwrap(), DEVICE)
            .unwrap()
            .unwrap()
    }
    fn ops(&self) -> Vec<ledger::QueuedOp> {
        ledger::queued_ops(&self.conn.lock().unwrap(), ACCOUNT, DEVICE).unwrap()
    }
    async fn drain(&self, fake: &Fake) -> Result<(), String> {
        outbox::drain(fake, |f| self.tx(f), "first", NOW).await
    }
}
fn heads(head: i64) -> Heads {
    Heads {
        account: ACCOUNT.into(),
        device: DEVICE.into(),
        head,
    }
}

#[derive(Default)]
struct FakeState {
    head: i64,
    entries: BTreeMap<i64, Vec<u8>>,
    sends: Vec<(i64, Vec<u8>)>,
    heads: usize,
    heads_times: Vec<tokio::time::Instant>,
    append_times: Vec<tokio::time::Instant>,
    errors: VecDeque<String>,
    heads_errors: VecDeque<String>,
    heads_error: Option<String>,
    lose_ack: bool,
}
#[derive(Clone, Default)]
struct Fake {
    state: Arc<Mutex<FakeState>>,
}
impl Fake {
    fn fail(&self, error: &str) {
        self.state.lock().unwrap().errors.push_back(error.into());
    }
}
impl Engram for Fake {
    async fn heads(&self) -> Result<Heads, String> {
        let mut s = self.state.lock().unwrap();
        s.heads += 1;
        s.heads_times.push(tokio::time::Instant::now());
        if let Some(error) = &s.heads_error {
            return Err(error.clone());
        }
        if let Some(error) = s.heads_errors.pop_front() {
            return Err(error);
        }
        Ok(heads(s.head))
    }
    async fn append(&self, seq: i64, bytes: &[u8]) -> Result<i64, String> {
        let mut s = self.state.lock().unwrap();
        s.sends.push((seq, bytes.to_vec()));
        s.append_times.push(tokio::time::Instant::now());
        if let Some(error) = s.errors.pop_front() {
            return Err(error);
        }
        if let Some(existing) = s.entries.get(&seq) {
            return if existing == bytes {
                Ok(seq)
            } else {
                Err("seq_reused".into())
            };
        }
        if seq != s.head + 1 {
            return Err("seq_moved".into());
        }
        s.entries.insert(seq, bytes.to_vec());
        s.head = seq;
        if std::mem::take(&mut s.lose_ack) {
            Err("timeout".into())
        } else {
            Ok(seq)
        }
    }
}

#[tokio::test]
async fn activation_no_setting_appends_after_commit() {
    let t = tempfile::tempdir().unwrap();
    let db = Db::new(&t.path().join("context.db"));
    db.ready();
    assert_eq!(db.create(1, &event("main-known")).unwrap(), None);
    assert_eq!(db.counts(), [1, 1, 1, 1]);
    let fake = Fake::default();
    db.drain(&fake).await.unwrap();
    assert_eq!(fake.state.lock().unwrap().head, 1);
    assert!(db.ops().is_empty());
}

#[tokio::test]
async fn lost_ack_reuses_identical_id_and_bytes() {
    let t = tempfile::tempdir().unwrap();
    let p = t.path().join("context.db");
    let db = Db::new(&p);
    db.ready();
    db.create(1, &event("main-known")).unwrap();
    let before = db.ops();
    let fake = Fake::default();
    fake.state.lock().unwrap().lose_ack = true;
    assert_eq!(db.drain(&fake).await.unwrap_err(), "timeout");
    drop(db);
    let db = Db::open(&p);
    db.drain(&fake).await.unwrap();
    let s = fake.state.lock().unwrap();
    assert_eq!(s.sends.len(), 2);
    assert_eq!(s.sends[0], s.sends[1]);
    assert_eq!(s.sends[0].1, before[0].canonical);
    assert_eq!(s.head, 1);
    assert_eq!(db.state().next_local_id, 2);
}

#[tokio::test]
async fn crash_before_ack_resends_recorded_batch_without_heads() {
    let t = tempfile::tempdir().unwrap();
    let p = t.path().join("context.db");
    let db = Db::new(&p);
    db.ready();
    db.create(1, &event("main-known")).unwrap();
    let bytes = db.ops()[0].canonical.clone();
    let fake = Fake::default();
    fake.append(1, &bytes).await.unwrap();
    db.tx(&mut |c| {
        c.execute("UPDATE memory_outbox SET pending_seq=1", [])?;
        Ok(())
    })
    .unwrap();
    db.create(2, &event("dreamer")).unwrap();
    drop(db);
    let db = Db::open(&p);
    db.drain(&fake).await.unwrap();
    let s = fake.state.lock().unwrap();
    assert_eq!(s.sends[1], (1, bytes));
    assert_eq!(s.heads, 1, "only the later, never-sent op may read heads");
    assert_eq!(s.head, 2);
}

#[tokio::test]
async fn second_drainer_cannot_send_under_lease() {
    let t = tempfile::tempdir().unwrap();
    let db = Db::new(&t.path().join("context.db"));
    db.ready();
    db.create(1, &event("dreamer")).unwrap();
    db.tx(&mut |c| {
        assert!(outbox::claim(c, DEVICE, "other", NOW)?);
        Ok(())
    })
    .unwrap();
    let fake = Fake::default();
    db.drain(&fake).await.unwrap();
    assert!(fake.state.lock().unwrap().sends.is_empty());
}

#[tokio::test]
async fn seq_moved_rereads_heads_without_reminting() {
    let t = tempfile::tempdir().unwrap();
    let db = Db::new(&t.path().join("context.db"));
    db.ready();
    db.create(1, &event("dreamer")).unwrap();
    let fake = Fake::default();
    fake.fail("seq_moved");
    db.drain(&fake).await.unwrap();
    let s = fake.state.lock().unwrap();
    assert_eq!(s.heads, 2);
    assert_eq!(s.sends.len(), 2);
    assert_eq!(s.sends[0].1, s.sends[1].1);
    assert_eq!(db.state().next_local_id, 2);
}

#[tokio::test]
async fn retryable_refusals_keep_outbox_across_restart() {
    for error in [
        "unavailable",
        "timeout",
        "storage_ceiling_exceeded",
        "verify_failed",
        "control_head_stale",
    ] {
        let t = tempfile::tempdir().unwrap();
        let p = t.path().join("context.db");
        let db = Db::new(&p);
        db.ready();
        db.create(1, &event("dreamer")).unwrap();
        let before = db.ops();
        let fake = Fake::default();
        fake.fail(error);
        assert_eq!(db.drain(&fake).await.unwrap_err(), error);
        drop(db);
        let db = Db::open(&p);
        assert_eq!(db.ops()[0].canonical, before[0].canonical);
        assert_eq!(db.ops()[0].last_error.as_deref(), Some(error));
        db.drain(&fake).await.unwrap();
        assert!(db.ops().is_empty());
    }
}

#[tokio::test]
async fn seq_reused_terminal_survives_restart_and_later_op_reads_fresh_head() {
    let t = tempfile::tempdir().unwrap();
    let p = t.path().join("context.db");
    let db = Db::new(&p);
    db.ready();
    db.create(1, &event("dreamer")).unwrap();
    let fake = Fake::default();
    fake.fail("seq_reused");
    db.drain(&fake).await.unwrap();
    drop(db);
    let db = Db::open(&p);
    let terminal = db.ops()[0].clone();
    assert_eq!(terminal.last_error.as_deref(), Some("seq_reused"));
    assert_eq!(terminal.pending_seq, None);
    db.create(2, &event("main-known")).unwrap();
    db.drain(&fake).await.unwrap();
    let s = fake.state.lock().unwrap();
    assert_eq!(s.heads, 2);
    assert_eq!(s.sends.len(), 2);
    assert_ne!(s.sends[0].1, s.sends[1].1);
    assert_eq!(db.state().next_local_id, 3);
    assert_eq!(db.ops(), vec![terminal]);
}

#[test]
fn eligibility_controls_emit_zero_ops() {
    for control in [
        "merge",
        "null_project",
        "not_answering",
        "degraded",
        "dedup",
    ] {
        let t = tempfile::tempdir().unwrap();
        let p = t.path().join("context.db");
        let db = Db::new(&p);
        db.ready();
        let mut e = event("main-known");
        match control {
            "merge" => e.kind = CreateKind::MergeSurvivor,
            "null_project" => e.writer_project_id = None,
            "not_answering" => e.snapshot_digest = None,
            "degraded" => e.origin_profile = None,
            _ => {}
        }
        if control == "dedup" { /* Store admission tests cover reuse bypassing MemoryWriter::created. */
        } else {
            let reason = if control == "null_project" {
                "owner_unknown"
            } else {
                "not_eligible"
            };
            assert_eq!(db.create(1, &e).unwrap(), Some(reason));
        }
        assert_eq!(db.counts()[2..], [0, 0]);
        assert_eq!(db.state().next_local_id, 1);
        drop(db);
        assert_eq!(Db::open(&p).counts()[2..], [0, 0]);
    }
}

#[test]
fn validation_refusals_commit_only_memory_and_placement_after_restart() {
    for control in ["missing_category", "missing_source", "text_cap", "op_cap"] {
        let t = tempfile::tempdir().unwrap();
        let p = t.path().join("context.db");
        let db = Db::new(&p);
        db.ready();
        let before = db.state();
        let mut e = event("main-known");
        let expected = match control {
            "missing_category" => {
                e.effective_category_id = None;
                "op_unmappable"
            }
            "missing_source" => {
                e.session_id = None;
                "op_unmappable"
            }
            "text_cap" => {
                e.content = "x".repeat(op::TEXT_CAP + 1);
                "text_too_large"
            }
            _ => {
                e.origin_profile.as_mut().unwrap().name = "x".repeat(op::OP_CAP);
                "op_too_large"
            }
        };
        assert_eq!(db.create(1, &e).unwrap(), Some(expected));
        drop(db);
        let db = Db::open(&p);
        assert_eq!(db.counts(), [1, 1, 0, 0]);
        assert_eq!(db.state(), before);
    }
}

#[test]
fn timeout_unknown_is_not_not_enrolled() {
    let t = tempfile::tempdir().unwrap();
    let p = t.path().join("context.db");
    let db = Db::new(&p);
    db.tx(&mut |c| account::refresh(c, &Err("timeout".into())))
        .unwrap();
    assert_eq!(db.create(1, &event("main-known")).unwrap(), Some("unknown"));
    drop(db);
    let db = Db::open(&p);
    assert_eq!(account::cached(&db.conn.lock().unwrap()).unwrap(), None);
    assert_eq!(db.counts(), [1, 1, 0, 0]);
}

#[tokio::test]
async fn not_enrolled_writes_normally_and_never_appends() {
    let t = tempfile::tempdir().unwrap();
    let p = t.path().join("context.db");
    let db = Db::new(&p);
    db.tx(&mut |c| account::refresh(c, &Err("key_unavailable".into())))
        .unwrap();
    assert_eq!(
        db.create(1, &event("dreamer")).unwrap(),
        Some("not_enrolled")
    );
    drop(db);
    let db = Db::open(&p);
    let fake = Fake::default();
    db.drain(&fake).await.unwrap();
    assert_eq!(db.counts(), [1, 1, 0, 0]);
    assert_eq!(
        account::cached(&db.conn.lock().unwrap())
            .unwrap()
            .unwrap()
            .state,
        "not_enrolled"
    );
    assert!(fake.state.lock().unwrap().sends.is_empty());
}

#[tokio::test]
async fn offline_enrolled_survives_restart_and_queues() {
    let t = tempfile::tempdir().unwrap();
    let p = t.path().join("context.db");
    let db = Db::new(&p);
    db.ready();
    drop(db);
    let db = Db::open(&p);
    db.tx(&mut |c| account::refresh(c, &Err("unavailable".into())))
        .unwrap();
    assert_eq!(db.state().enrollment_state, "enrolled");
    assert_eq!(db.create(1, &event("dreamer")).unwrap(), None);
    let fake = Fake::default();
    db.drain(&fake).await.unwrap();
    assert_eq!(fake.state.lock().unwrap().head, 1);
}

#[tokio::test]
async fn credential_invalid_holds_outbox_and_is_not_not_enrolled() {
    let t = tempfile::tempdir().unwrap();
    let p = t.path().join("context.db");
    let db = Db::new(&p);
    db.ready();
    db.create(1, &event("dreamer")).unwrap();
    let bytes = db.ops()[0].canonical.clone();
    db.tx(&mut |c| account::refresh(c, &Err("not_member".into())))
        .unwrap();
    drop(db);
    let db = Db::open(&p);
    assert_eq!(db.state().enrollment_state, "credential_invalid");
    assert_eq!(
        db.create(2, &event("main-known")).unwrap(),
        Some("credential_invalid")
    );
    let fake = Fake::default();
    db.drain(&fake).await.unwrap();
    assert!(fake.state.lock().unwrap().sends.is_empty());
    assert_eq!(db.ops()[0].canonical, bytes);
    db.ready();
    db.drain(&fake).await.unwrap();
    assert_eq!(fake.state.lock().unwrap().head, 1);
}

#[tokio::test]
async fn atomic_create_rollback_and_postcommit_restart() {
    for cut in ["memory", "placement", "ledger"] {
        let t = tempfile::tempdir().unwrap();
        let p = t.path().join("context.db");
        let db = Db::new(&p);
        db.ready();
        let before = db.state();
        if cut == "ledger" {
            db.conn.lock().unwrap().execute_batch("CREATE TRIGGER fail_outbox BEFORE INSERT ON memory_outbox BEGIN SELECT RAISE(ABORT,'after ledger'); END;").unwrap();
        }
        assert!(db
            .tx(&mut |c| {
                c.execute("INSERT INTO memories VALUES(1,'text')", [])?;
                if cut == "memory" {
                    return Err(rusqlite::Error::InvalidQuery);
                }
                c.execute("INSERT INTO memory_placement VALUES(1)", [])?;
                if cut == "placement" {
                    return Err(rusqlite::Error::InvalidQuery);
                }
                queue(c, &event("main-known"), NOW)?;
                Ok(())
            })
            .is_err());
        drop(db);
        let db = Db::open(&p);
        assert_eq!(db.counts(), [0, 0, 0, 0]);
        assert_eq!(db.state(), before);
    }
    let t = tempfile::tempdir().unwrap();
    let p = t.path().join("context.db");
    let db = Db::new(&p);
    db.ready();
    db.create(1, &event("dreamer")).unwrap();
    let bytes = db.ops()[0].canonical.clone();
    drop(db);
    let db = Db::open(&p);
    let fake = Fake::default();
    db.drain(&fake).await.unwrap();
    assert_eq!(fake.state.lock().unwrap().sends[0].1, bytes);
    assert_eq!(db.counts(), [1, 1, 1, 1]);
}

#[test]
fn drainer_cannot_observe_uncommitted_op() {
    let t = tempfile::tempdir().unwrap();
    let p = t.path().join("context.db");
    let db = Db::new(&p);
    db.ready();
    let other = Connection::open(&p).unwrap();
    db.tx(&mut |c| {
        queue(c, &event("main-known"), NOW)?;
        assert!(ledger::queued_ops(&other, ACCOUNT, DEVICE)?.is_empty());
        Ok(())
    })
    .unwrap();
    assert_eq!(
        ledger::queued_ops(&other, ACCOUNT, DEVICE).unwrap().len(),
        1
    );
}

#[test]
fn hlc_never_regresses_and_exhaustion_refuses() {
    assert_eq!(hlc::next(9, 10, 4), Some((10, 5)));
    assert_eq!(hlc::next(11, 10, 4), Some((11, 0)));
    assert_eq!(hlc::next(9, 10, u32::MAX as i64), Some((11, 0)));
    assert_eq!(hlc::next(0, i64::MAX, u32::MAX as i64), None);
    let t = tempfile::tempdir().unwrap();
    let p = t.path().join("context.db");
    let db = Db::new(&p);
    db.ready();
    db.create(1, &event("dreamer")).unwrap();
    let first = db.state();
    drop(db);
    let db = Db::open(&p);
    db.tx(&mut |c| {
        queue(c, &event("dreamer"), NOW - 100)?;
        Ok(())
    })
    .unwrap();
    let second = db.state();
    assert_eq!(second.next_local_id, first.next_local_id + 1);
    assert_eq!(second.hlc_wall_ms, first.hlc_wall_ms);
    assert!(second.hlc_logical > first.hlc_logical);
}

#[tokio::test]
async fn real_store_restart_retains_lease_pending_ack_and_served_bytes() {
    let t = tempfile::tempdir().unwrap();
    let descriptor = crate::test_support::descriptor(t.path());
    let store = mc_store::McStore::open_for_test(&descriptor).unwrap();
    let core = mc_core::CoreState {
        frozen_units: [("m0", "frozen project memory"), ("m1", "frozen delta")]
            .into_iter()
            .map(|(key, text)| mc_core::FrozenUnit {
                key: key.into(),
                kind: key.into(),
                frozen_payload: text.into(),
                durability_class: mc_core::DurabilityClass::Lineage,
                reset_rule: String::new(),
            })
            .collect(),
        ..Default::default()
    };
    let meta = mc_store::ModuleMeta {
        folded_compartment_seq: 9,
        memory_mutation_cursor: 7,
        max_memory_id: 42,
        ..Default::default()
    };
    store.commit("sync-session", None, &core, &meta).unwrap();
    let snapshot = |s: &mc_store::McStore| {
        let loaded = s.load("sync-session").unwrap();
        (
            serde_json::to_vec(&loaded.core).unwrap(),
            serde_json::to_vec(&loaded.meta).unwrap(),
            loaded.row_version,
            s.max_memory_mutation_id(&[]).unwrap(),
        )
    };
    let before = snapshot(&store);
    store
        .with_memory_sync_write(|c| {
            account::refresh(c, &Ok(heads(0)))?;
            queue(c, &event("dreamer"), NOW)?;
            assert!(outbox::claim(c, DEVICE, "crashed", NOW)?);
            c.execute("UPDATE memory_outbox SET pending_seq=1", [])?;
            Ok(())
        })
        .unwrap();
    let bytes = store
        .with_context_read(|c| Ok(ledger::queued_ops(c, ACCOUNT, DEVICE)?[0].canonical.clone()))
        .unwrap();
    drop(store);
    let store = mc_store::McStore::open_for_test(&descriptor).unwrap();
    assert_eq!(snapshot(&store), before);
    let state = store
        .with_context_read(|c| ledger::sync_state(c, DEVICE))
        .unwrap()
        .unwrap();
    assert_eq!(state.drainer_holder.as_deref(), Some("crashed"));
    assert_eq!(
        store
            .with_context_read(|c| Ok(ledger::queued_ops(c, ACCOUNT, DEVICE)?[0].pending_seq))
            .unwrap(),
        Some(1)
    );
    let fake = Fake::default();
    fake.append(1, &bytes).await.unwrap();
    let tx = |f: &mut dyn FnMut(&Connection) -> rusqlite::Result<()>| {
        store
            .with_memory_sync_write(|c| f(c))
            .map_err(|e| e.to_string())
    };
    outbox::drain(&fake, tx, "restart", NOW).await.unwrap();
    assert_eq!(
        fake.state.lock().unwrap().sends.len(),
        1,
        "lease survives reopen"
    );
    outbox::drain(&fake, tx, "restart", NOW + 60_001)
        .await
        .unwrap();
    assert_eq!(fake.state.lock().unwrap().heads, 0);
    assert_eq!(snapshot(&store), before);
    for error in ["seq_reused", "unavailable"] {
        store
            .with_memory_sync_write(|c| {
                queue(c, &event("dreamer"), NOW)?;
                Ok(())
            })
            .unwrap();
        fake.fail(error);
        let _ = outbox::drain(&fake, tx, "restart", NOW + 60_001).await;
        assert_eq!(snapshot(&store), before);
    }
    drop(store);
    let store = mc_store::McStore::open_for_test(&descriptor).unwrap();
    assert_eq!(snapshot(&store), before);
    store
        .with_context_read(|c| {
            let ack: i64 = c.query_row(
                "SELECT appended_seq FROM memory_outbox WHERE local_id=1",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(ack, 1);
            let queued = ledger::queued_ops(c, ACCOUNT, DEVICE)?;
            assert_eq!(queued.len(), 2);
            assert_eq!(queued[0].last_error.as_deref(), Some("seq_reused"));
            assert_eq!(queued[1].last_error.as_deref(), Some("unavailable"));
            Ok(())
        })
        .unwrap();
}

#[test]
fn wire_shapes_and_single_entry_batch_caps() {
    assert_eq!(
        engram::append_request(8, b"\0\xff{}"),
        json!({"seq":8,"entries":["00ff7b7d"]})
    );
    let h=engram::decode_heads(&json!({"account":ACCOUNT,"device":DEVICE,"devices":[{"device":DEVICE,"head":7,"self":true}]})).unwrap();
    assert_eq!(h.head, 7);
    assert!(
        engram::decode_heads(&json!({"account":ACCOUNT,"device":DEVICE,"devices":[]})).is_err()
    );
    let request = engram::append_request(1, &vec![42; op::OP_CAP]);
    assert_eq!(request["entries"].as_array().unwrap().len(), 1);
    assert_eq!(
        request["entries"][0].as_str().unwrap().len(),
        op::OP_CAP * 2
    );
    assert!(request["entries"][0].as_str().unwrap().len() / 2 < 1_048_576);
}

#[test]
fn caller_actor_cannot_override_host_event_actor() {
    let mut input: Value = serde_json::from_slice(&fixture("main-known.event.json")).unwrap();
    input["caller_actor"] = json!("dreamer");
    let e: CreateEvent = serde_json::from_value(input).unwrap();
    assert_eq!(e.actor, Actor::MainAgent);
    let bytes = op::map(&e, ACCOUNT, DEVICE, 42, (NOW, 0)).unwrap();
    assert_eq!(bytes, fixture("main-known.jcs"));
}

fn real_store(path: &std::path::Path) -> (Arc<mc_store::McStore>, Arc<Service>) {
    let store =
        Arc::new(mc_store::McStore::open_for_test(&crate::test_support::descriptor(path)).unwrap());
    let e = event("main-known");
    let mut meta = store.load_meta("session-example").unwrap();
    meta.meta.memory_context = Some(
        json!({"project_id":e.writer_project_id,"profile":{"name":"@cortexkit/memory-swe","version":"1.0.0","digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","state":"resolved","parity":true},"snapshot_digest":e.snapshot_digest,"category_ids":{"NAMING":"swe:naming","KNOWN_ISSUES":"swe:constraints"}}),
    );
    store
        .commit_meta("session-example", meta.row_version, &meta.meta)
        .unwrap();
    let service = Service::new(None, "magic-context".into());
    service.install(&store);
    (store, service)
}

fn admit_real(
    store: &mc_store::McStore,
    key: &str,
) -> Result<mc_store::memory_lifecycle::applier::ApplierReceipt, mc_store::McStoreError> {
    use mc_store::memory_lifecycle::applier::{AdmissionOperation, AdmissionRequest};
    let mut request = AdmissionRequest::new(
        key,
        AdmissionOperation::AgentSave,
        "project-path",
        "NAMING",
        "exact memory content",
        NOW,
    );
    request.source_session_id = Some("session-example");
    store.admit_memory(&request)
}

#[tokio::test]
async fn production_hook_activation_and_dedup_emit_once() {
    let t = tempfile::tempdir().unwrap();
    let (store, service) = real_store(t.path());
    let fake = Fake::default();
    service.cycle_with(&fake, &store, "test").await.unwrap();
    let id = admit_real(&store, "first").unwrap().memory_id;
    assert!(fake.state.lock().unwrap().sends.is_empty());
    let duplicate = admit_real(&store, "second").unwrap();
    assert_eq!(duplicate.memory_id, id);
    assert_eq!(duplicate.inserted, Some(false));
    store
        .with_context_read(|c| {
            assert_eq!(ledger::queued_ops(c, ACCOUNT, DEVICE)?.len(), 1);
            assert_eq!(ledger::sync_state(c, DEVICE)?.unwrap().next_local_id, 2);
            Ok(())
        })
        .unwrap();
    service.cycle_with(&fake, &store, "test").await.unwrap();
    assert_eq!(fake.state.lock().unwrap().head, 1);
}

#[test]
fn production_hook_atomic_failure_rolls_back_all_rows_and_allocator() {
    for table in ["memory_placement", "memory_ops", "memory_outbox"] {
        let t = tempfile::tempdir().unwrap();
        let (store, _service) = real_store(t.path());
        store
            .with_memory_sync_write(|c| account::refresh(c, &Ok(heads(0))))
            .unwrap();
        store.with_context_conn_for_test(|c|c.execute_batch(&format!("CREATE TRIGGER fail_create BEFORE INSERT ON {table} BEGIN SELECT RAISE(ABORT,'injected create failure'); END;"))).unwrap();
        assert!(admit_real(&store, "atomic").is_err(), "{table}");
        drop(store);
        let reopened =
            mc_store::McStore::open_for_test(&crate::test_support::descriptor(t.path())).unwrap();
        reopened
            .with_context_read(|c| {
                for table in [
                    "memories",
                    "memory_placement",
                    "memory_ops",
                    "memory_outbox",
                ] {
                    let n: i64 =
                        c.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))?;
                    assert_eq!(n, 0, "{table}");
                }
                let s = ledger::sync_state(c, DEVICE)?.unwrap();
                assert_eq!((s.next_local_id, s.hlc_wall_ms, s.hlc_logical), (1, 0, 0));
                Ok(())
            })
            .unwrap();
    }
}

#[tokio::test]
async fn cycle_uncertain_batch_skips_heads_refresh_and_preserves_snapshot() {
    let t = tempfile::tempdir().unwrap();
    let (store, service) = real_store(t.path());
    let fake = Fake::default();
    service.cycle_with(&fake, &store, "test").await.unwrap();
    admit_real(&store, "first").unwrap();
    fake.state.lock().unwrap().lose_ack = true;
    assert_eq!(
        service.cycle_with(&fake, &store, "test").await.unwrap_err(),
        "timeout"
    );
    let count = fake.state.lock().unwrap().heads;
    service.cycle_with(&fake, &store, "test").await.unwrap();
    let s = fake.state.lock().unwrap();
    assert_eq!(s.heads, count);
    assert_eq!(s.sends[0], s.sends[1]);
}

#[tokio::test]
async fn cycle_heads_refusals_drive_cached_states_and_status() {
    for (error, expected) in [
        ("timeout", "unknown"),
        ("key_unavailable", "not_enrolled"),
        ("not_member", "credential_invalid"),
    ] {
        let t = tempfile::tempdir().unwrap();
        let (store, service) = real_store(t.path());
        let fake = Fake::default();
        fake.state
            .lock()
            .unwrap()
            .heads_errors
            .push_back(error.into());
        assert_eq!(
            service.cycle_with(&fake, &store, "test").await.unwrap_err(),
            error
        );
        admit_real(&store, "first").unwrap();
        assert_eq!(service.status(&store)["state"], expected);
        assert_eq!(service.status(&store)["queued"], 0);
        assert!(fake.state.lock().unwrap().sends.is_empty());
    }
}

#[test]
fn production_unknown_owner_reports_no_authority_and_null_project() {
    for missing in ["no-authority", "null-project"] {
        let t = tempfile::tempdir().unwrap();
        let (store, service) = real_store(t.path());
        store
            .with_memory_sync_write(|c| account::refresh(c, &Ok(heads(0))))
            .unwrap();
        let mut meta = store.load_meta("session-example").unwrap();
        if missing == "no-authority" {
            meta.meta.memory_context = None;
        } else {
            meta.meta.memory_context.as_mut().unwrap()["project_id"] = Value::Null;
        }
        store
            .commit_meta("session-example", meta.row_version, &meta.meta)
            .unwrap();
        let captured = Arc::new(Mutex::new(Vec::new()));
        let capture = captured.clone();
        let sync_hook = hook(service.status.clone());
        store.set_memory_create_hook(Some(Arc::new(move |c, e| {
            capture.lock().unwrap().push(e.clone());
            sync_hook(c, e)
        })));
        let id = admit_real(&store, missing).unwrap().memory_id.unwrap();
        let events = captured.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].memory_id, id);
        assert!(events[0].owner.is_none());
        assert!(events[0].origin_profile.is_none());
        assert!(events[0].snapshot_digest.is_none());
        drop(events);
        store
            .with_context_read(|c| {
                for table in ["memory_placement", "memory_ops", "memory_outbox"] {
                    let n: i64 =
                        c.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))?;
                    assert_eq!(n, 0);
                }
                assert_eq!(ledger::sync_state(c, DEVICE)?.unwrap().next_local_id, 1);
                Ok(())
            })
            .unwrap();
        let status = service.status(&store);
        assert_eq!(status["unreplicated_since_start"]["owner_unknown"], 1);
        assert!(status["last_status"]
            .as_str()
            .unwrap()
            .contains(&format!("unreplicated create {id}: owner_unknown")));
        assert_eq!(status["owner_unknown_memory_ids"], json!([id]));
        drop(store);
        let store =
            mc_store::McStore::open_for_test(&crate::test_support::descriptor(t.path())).unwrap();
        assert_eq!(
            Service::new(None, "magic-context".into()).status(&store)["owner_unknown_memory_ids"],
            json!([id])
        );
    }
}

fn spawn_fake_service(
    service: &Arc<Service>,
    store: &Arc<mc_store::McStore>,
    fake: &Fake,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(Service::run(
        Arc::downgrade(service),
        Arc::downgrade(store),
        fake.clone(),
    ))
}

async fn settle_service() {
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }
}

async fn elapse_service(duration: std::time::Duration) {
    tokio::time::advance(duration).await;
    settle_service().await;
}

#[tokio::test(start_paused = true)]
async fn enrolled_idle_refreshes_heads_at_most_every_fifteen_minutes() {
    use std::time::Duration;
    let directory = tempfile::tempdir().unwrap();
    let (store, service) = real_store(directory.path());
    let fake = Fake::default();
    let worker = spawn_fake_service(&service, &store, &fake);
    settle_service().await;
    assert_eq!(fake.state.lock().unwrap().heads, 1);
    for expected in 2..=4 {
        elapse_service(Duration::from_secs(900) - Duration::from_millis(1)).await;
        assert_eq!(fake.state.lock().unwrap().heads, expected - 1);
        elapse_service(Duration::from_millis(1)).await;
        assert_eq!(fake.state.lock().unwrap().heads, expected);
    }
    let times = fake.state.lock().unwrap().heads_times.clone();
    for pair in times.windows(2) {
        assert_eq!(pair[1] - pair[0], Duration::from_secs(900));
    }
    worker.abort();
    let _ = worker.await;
}

#[tokio::test(start_paused = true)]
async fn unreachable_heads_back_off_to_thirty_minutes() {
    use std::time::Duration;
    for error in ["unavailable", "timeout"] {
        let directory = tempfile::tempdir().unwrap();
        let (store, service) = real_store(directory.path());
        let fake = Fake::default();
        fake.state.lock().unwrap().heads_error = Some(error.into());
        let worker = spawn_fake_service(&service, &store, &fake);
        settle_service().await;
        for delay in [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 1800, 1800] {
            let before = fake.state.lock().unwrap().heads;
            elapse_service(Duration::from_secs(delay) - Duration::from_millis(1)).await;
            assert_eq!(fake.state.lock().unwrap().heads, before, "{error}: {delay}");
            elapse_service(Duration::from_millis(1)).await;
            let state = fake.state.lock().unwrap();
            assert_eq!(state.heads, before + 1, "{error}: {delay}");
            assert_eq!(
                state.heads_times[before] - state.heads_times[before - 1],
                Duration::from_secs(delay)
            );
        }
        worker.abort();
        let _ = worker.await;
    }
}

#[tokio::test(start_paused = true)]
async fn inactive_accounts_refresh_at_thirty_minutes() {
    use std::time::Duration;
    for (error, state) in [
        ("key_unavailable", "not_enrolled"),
        ("not_member", "credential_invalid"),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let (store, service) = real_store(directory.path());
        let fake = Fake::default();
        fake.state.lock().unwrap().heads_error = Some(error.into());
        let worker = spawn_fake_service(&service, &store, &fake);
        settle_service().await;
        assert_eq!(service.status(&store)["state"], state);
        assert_eq!(fake.state.lock().unwrap().heads, 1);
        elapse_service(Duration::from_secs(1800) - Duration::from_millis(1)).await;
        assert_eq!(fake.state.lock().unwrap().heads, 1);
        elapse_service(Duration::from_millis(1)).await;
        assert_eq!(fake.state.lock().unwrap().heads, 2);
        worker.abort();
        let _ = worker.await;
    }
}

#[tokio::test(start_paused = true)]
async fn queued_create_wakes_long_backoff_and_appends_within_one_second() {
    use std::time::Duration;
    let directory = tempfile::tempdir().unwrap();
    let (store, service) = real_store(directory.path());
    store
        .with_memory_sync_write(|c| account::refresh(c, &Ok(heads(0))))
        .unwrap();
    let fake = Fake::default();
    fake.state.lock().unwrap().heads_error = Some("unavailable".into());
    let worker = spawn_fake_service(&service, &store, &fake);
    settle_service().await;
    for delay in [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024] {
        elapse_service(Duration::from_secs(delay)).await;
    }
    assert_eq!(fake.state.lock().unwrap().heads, 12);
    fake.state.lock().unwrap().heads_error = None;
    let queued_at = tokio::time::Instant::now();
    admit_real(&store, "wake-during-backoff").unwrap();
    settle_service().await;
    elapse_service(Duration::from_secs(1)).await;
    {
        let state = fake.state.lock().unwrap();
        assert_eq!(state.sends.len(), 1);
        assert!(state.append_times[0] - queued_at <= Duration::from_secs(1));
    }
    worker.abort();
    let _ = worker.await;
}

#[tokio::test(start_paused = true)]
async fn uncertain_batch_retries_without_another_create_notification() {
    use std::time::Duration;
    let directory = tempfile::tempdir().unwrap();
    let (store, service) = real_store(directory.path());
    let fake = Fake::default();
    let worker = spawn_fake_service(&service, &store, &fake);
    settle_service().await;
    fake.state.lock().unwrap().lose_ack = true;
    admit_real(&store, "uncertain-wake").unwrap();
    settle_service().await;
    assert_eq!(fake.state.lock().unwrap().sends.len(), 1);
    let heads_before_retry = fake.state.lock().unwrap().heads;
    elapse_service(Duration::from_secs(2)).await;
    {
        let state = fake.state.lock().unwrap();
        assert_eq!(state.sends.len(), 2);
        assert_eq!(state.sends[0], state.sends[1]);
        assert_eq!(state.heads, heads_before_retry);
    }
    worker.abort();
    let _ = worker.await;
}
