#![cfg(unix)]

use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use cortexkit_doctor::{runner, CheckOutput};
use mc_module::{context_db::ContextDb, store::Store};
use nix::fcntl::{Flock, FlockArg};
use rusqlite::Connection;
use sha2::{Digest, Sha256};

const PROGRAM: &str = env!("CARGO_BIN_EXE_ck-mc");

struct Homes {
    root: tempfile::TempDir,
    xdg_data: PathBuf,
    xdg_config: PathBuf,
    data: PathBuf,
}

impl Homes {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let xdg_data = root.path().join("data");
        let xdg_config = root.path().join("config");
        let data = xdg_data.join("cortexkit/magic-context");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir(&xdg_config).unwrap();
        Self {
            root,
            xdg_data,
            xdg_config,
            data,
        }
    }

    fn options(&self) -> runner::Options {
        runner::Options::new()
            .with_data_home(&self.xdg_data)
            .with_config_home(&self.xdg_config)
    }

    fn check(&self) -> CheckOutput {
        runner::check(PROGRAM, &self.options()).unwrap()
    }

    fn command(&self) -> Command {
        let mut cmd = Command::new(PROGRAM);
        cmd.env_clear()
            .env("XDG_DATA_HOME", &self.xdg_data)
            .env("XDG_CONFIG_HOME", &self.xdg_config);
        cmd
    }

    fn context(&self) -> PathBuf {
        self.data.join("context.db")
    }
}

fn snapshot(path: &Path) -> BTreeMap<PathBuf, (u32, [u8; 32])> {
    fn walk(path: &Path, files: &mut BTreeMap<PathBuf, (u32, [u8; 32])>) {
        let meta = fs::symlink_metadata(path).unwrap();
        let hash = if meta.is_dir() {
            [0; 32]
        } else {
            assert!(meta.is_file(), "unexpected test fixture type: {path:?}");
            let mut digest = Sha256::new();
            std::io::copy(&mut File::open(path).unwrap(), &mut digest).unwrap();
            digest.finalize().into()
        };
        assert!(files
            .insert(path.to_owned(), (meta.permissions().mode(), hash))
            .is_none());
        if meta.is_dir() {
            for entry in fs::read_dir(path).unwrap() {
                walk(&entry.unwrap().path(), files);
            }
        }
    }
    let mut files = BTreeMap::new();
    walk(path, &mut files);
    files
}

#[test]
fn live_wal_and_shm_are_unchanged_and_an_exclusive_session_lock_does_not_block_check() {
    let h = Homes::new();
    fs::write(h.xdg_config.join("untouched"), b"config bytes").unwrap();
    drop(ContextDb::create_for_tests(&h.context()).unwrap());
    drop(Store::open(&h.data.join("sessions.db")).unwrap());
    let lock = Flock::lock(
        File::open(h.data.join("sessions.db.lock")).unwrap(),
        FlockArg::LockExclusiveNonblock,
    )
    .unwrap();
    let writer = Connection::open(h.context()).unwrap();
    writer.execute_batch("PRAGMA journal_mode=WAL;
        UPDATE replica_state SET held_epoch=8, held_since=1, held_why='PRIVATE_WAL_CANARY' WHERE id=1;
        INSERT INTO replica_outbox(kind, local_id, revision, base_revision, change, created_at, actor)
          VALUES ('memory', 1, 1, 0, 'create', 0, 'PRIVATE_WAL_CANARY');").unwrap();
    let reader = Connection::open(h.context()).unwrap();
    reader.execute_batch("BEGIN").unwrap();
    assert_eq!(
        reader
            .query_row("SELECT held_epoch FROM replica_state", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        8
    );
    assert!(h.data.join("context.db-wal").is_file());
    assert!(h.data.join("context.db-shm").is_file());
    let before = snapshot(h.root.path());
    let findings = h.check();
    assert!(findings
        .findings()
        .iter()
        .any(|f| f.id().as_str() == "store.in_use"));
    assert!(!findings
        .findings()
        .iter()
        .any(|f| f.id().as_str().starts_with("sharing.")
            || f.id().as_str().starts_with("store.context.")));
    assert_eq!(before, snapshot(h.root.path()));
    assert!(!serde_json::to_string(&findings)
        .unwrap()
        .contains("PRIVATE_WAL_CANARY"));
    drop((reader, writer, lock));
}

#[test]
fn doctor_does_not_initialize_a_fresh_install_or_consult_store_overrides() {
    let h = Homes::new();
    let outside = h.root.path().join("outside.db");
    fs::write(&outside, b"not a store").unwrap();
    let before = snapshot(h.root.path());
    let output = h
        .command()
        .env("MAGIC_CONTEXT_DB", outside)
        .args(["doctor", "check", "--json"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    assert!(CheckOutput::decode(&output.stdout)
        .unwrap()
        .findings()
        .is_empty());
    let output = h.command().args(["doctor", "manifest"]).output().unwrap();
    assert!(output.status.success(), "{output:?}");
    assert_eq!(output.stdout, mc_module::doctor::MANIFEST.as_bytes());
    let output = h.command().args(["doctor", "check"]).output().unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
    assert_eq!(before, snapshot(h.root.path()));
}

#[test]
fn startup_schema_refusals_leave_no_sidecars_for_the_next_doctor_check() {
    for (too_new, id) in [
        (true, "store.context.too_new"),
        (false, "store.context.too_old"),
    ] {
        let h = Homes::new();
        drop(ContextDb::create_for_tests(&h.context()).unwrap());
        let conn = Connection::open(h.context()).unwrap();
        if too_new {
            conn.execute("INSERT INTO schema_migrations(version, description, applied_at) VALUES (?1, 'future schema', 0)", [mc_module::context_db::SCHEMA_VERSION + 1]).unwrap();
        } else {
            // The serving opener rejects a ledger with no migrations, which
            // reports version zero regardless of the rest of the fixture.
            conn.execute("DELETE FROM schema_migrations", []).unwrap();
        }
        drop(conn);
        let output = h
            .command()
            .args(["--subc", "missing-connection.json"])
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(!output.status.success(), "{output:?}");
        assert!(
            stderr.contains(if too_new {
                "this ck-mc reads version"
            } else {
                "is older than the last Magic Context plugin"
            }),
            "{stderr}"
        );
        assert!(!h.data.join("context.db-wal").exists());
        assert!(!h.data.join("context.db-shm").exists());
        assert!(!h.data.join("sessions.db").exists());
        let findings = h.check();
        assert!(findings
            .findings()
            .iter()
            .any(|finding| finding.id().as_str() == id));
        assert!(!findings
            .findings()
            .iter()
            .any(|finding| finding.id().as_str() == "store.in_use"));
    }
}

#[test]
fn sparse_twelve_gigabyte_store_with_thirty_thousand_files_is_quick() {
    let h = Homes::new();
    drop(ContextDb::create_for_tests(&h.context()).unwrap());
    let store = OpenOptions::new().write(true).open(h.context()).unwrap();
    store.set_len(12_000_000_000).unwrap();
    fs::set_permissions(h.context(), fs::Permissions::from_mode(0o600)).unwrap();
    drop(store);
    for name in ["backups", "specimens", "logs"] {
        let dir = h.data.join(name);
        fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
        for index in 0..10_000 {
            OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(dir.join(index.to_string()))
                .unwrap();
        }
    }
    let start = Instant::now();
    let findings = h.check();
    let elapsed = start.elapsed();
    println!("doctor check: {elapsed:?} including spawn; 12 GB sparse context store, 30,000 files");
    assert!(
        elapsed < Duration::from_secs(5),
        "doctor check took {elapsed:?}"
    );
    assert!(findings.findings().is_empty(), "{findings:?}");
}
