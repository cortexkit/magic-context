use std::{fs, path::Path, process::Command, sync::OnceLock};

use mc_store::{
    context_schema::{fingerprints::schema_snapshot, BOOTSTRAP, BOOTSTRAP_VERSION},
    parity_schema_manifest::{
        unavailable_stores, Availability, CapabilityResult, ContextSchemaReport,
        ContextSchemaRequest, ContextSchemaStore, Generation, ParityStoreApi,
    },
};
use rusqlite::Connection;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tempfile::TempDir;

fn request(path: &Path) -> ContextSchemaRequest {
    ContextSchemaRequest {
        database_path: path.to_str().unwrap().to_owned(),
        expected_schema_version: BOOTSTRAP_VERSION,
        writer_generation: Generation(1),
    }
}

fn install(path: &Path) -> ContextSchemaReport {
    let api = ParityStoreApi {
        context_schema: &BOOTSTRAP,
        ..unavailable_stores()
    };
    assert_eq!(api.context_schema.availability(), Availability::Available);
    match api.context_schema.bootstrap(&request(path)) {
        CapabilityResult::Available { value } => value,
        other => panic!("bootstrap failed: {other:?}"),
    }
}

fn golden() -> &'static Value {
    static GOLDEN: OnceLock<Value> = OnceLock::new();
    GOLDEN.get_or_init(|| {
        let temporary = TempDir::new().unwrap();
        let output = temporary.path().join("typescript.json");
        let script =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/context_schema/generate.ts");
        let result = Command::new("bun")
            .arg(&script)
            .arg(&output)
            .output()
            .expect("Bun is required: this differential test must run the real TypeScript chain");
        assert!(
            result.status.success(),
            "TypeScript generator failed: {}\n{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        println!("{}", String::from_utf8_lossy(&result.stdout).trim());
        serde_json::from_slice(&fs::read(output).unwrap()).unwrap()
    })
}

fn digest(value: &Value) -> String {
    let mut canonical = value.clone();
    canonical.sort_all_objects();
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&canonical).unwrap())
    )
}

#[test]
fn fresh_bootstrap_matches_typescript_fingerprint() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("rust/context.db");
    let report = install(&path);
    let connection = Connection::open(&path).unwrap();
    let actual = serde_json::to_value(schema_snapshot(&connection).unwrap()).unwrap();
    let expected = &golden()["snapshot"];
    if actual != *expected {
        for section in ["master", "tables", "migrations"] {
            let left = actual[section].as_array().unwrap();
            let right = expected[section].as_array().unwrap();
            for extra in left.iter().filter(|row| !right.contains(row)).take(3) {
                eprintln!("extra/different {section}: {extra}");
            }
            for missing in right.iter().filter(|row| !left.contains(row)).take(3) {
                eprintln!("missing/different {section}: {missing}");
            }
        }
    }
    // The expectation is produced from TypeScript, not from the Rust schema asset.
    assert_eq!(
        digest(&actual),
        digest(expected),
        "Rust schema differs from real TypeScript migrations"
    );
    assert_eq!(report.schema_fingerprint.0, digest(expected));
    assert_eq!(actual, *expected);
}

#[test]
fn bootstrap_fence_matches_typescript_and_installed_ledger() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("context.db");
    let report = install(&path);
    assert_eq!(
        golden()["fence"].as_u64().unwrap(),
        u64::from(BOOTSTRAP_VERSION)
    );
    let found: u32 = Connection::open(path)
        .unwrap()
        .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(found, BOOTSTRAP_VERSION);
    assert_eq!(report.schema_version, found);
}

#[test]
fn bootstrap_preserves_typescript_seed_rows() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("context.db");
    install(&path);
    let connection = Connection::open(path).unwrap();
    for seed in golden()["seeds"].as_array().unwrap() {
        let name = seed["name"].as_str().unwrap();
        let columns = seed["columns"].as_array().unwrap();
        let sql = format!("SELECT * FROM '{}'", name.replace('\'', "''"));
        let mut statement = connection.prepare(&sql).unwrap();
        let actual = statement
            .query_map([], |row| {
                (0..columns.len())
                    .map(|index| {
                        let value = row.get_ref(columns[index].as_str().unwrap())?;
                        Ok(if columns[index] == "activated_at" {
                            assert!(value.as_i64().unwrap() > 0);
                            Value::from(":applied_at")
                        } else {
                            match value {
                                rusqlite::types::ValueRef::Null => Value::Null,
                                rusqlite::types::ValueRef::Integer(value) => Value::from(value),
                                rusqlite::types::ValueRef::Text(value) => {
                                    Value::from(std::str::from_utf8(value).unwrap())
                                }
                                other => panic!("unexpected seed type: {other:?}"),
                            }
                        })
                    })
                    .collect::<rusqlite::Result<Vec<Value>>>()
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(
            serde_json::to_value(actual).unwrap(),
            seed["rows"],
            "seed {name}"
        );
    }
}

#[test]
fn nonempty_mismatched_versions_are_refused_without_mutation() {
    for version in [0, BOOTSTRAP_VERSION - 1, BOOTSTRAP_VERSION + 1, 10_001] {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("context.db");
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch("CREATE TABLE keep_me (value TEXT); INSERT INTO keep_me VALUES ('preserved');
            CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT, applied_at INTEGER);").unwrap();
        if version != 0 {
            connection
                .execute(
                    "INSERT INTO schema_migrations VALUES (?1, 'existing', 0)",
                    [version],
                )
                .unwrap();
        }
        drop(connection);
        let before = fs::read(&path).unwrap();
        match BOOTSTRAP.bootstrap(&request(&path)) {
            CapabilityResult::Unavailable { reason } => {
                let found = if version >= 10_000 { 0 } else { version };
                assert_eq!(reason.code, "schema_version_mismatch");
                assert!(
                    reason.message.contains(&format!("found {found}")),
                    "{reason:?}"
                );
                assert!(
                    reason
                        .message
                        .contains(&format!("expected {BOOTSTRAP_VERSION}")),
                    "{reason:?}"
                );
            }
            other => panic!("unexpected admission: {other:?}"),
        }
        assert_eq!(fs::read(path).unwrap(), before);
    }
}

#[test]
fn unversioned_nonempty_database_is_refused() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("context.db");
    Connection::open(&path)
        .unwrap()
        .execute_batch("CREATE TABLE existing (id INTEGER)")
        .unwrap();
    assert!(
        matches!(BOOTSTRAP.bootstrap(&request(&path)), CapabilityResult::Unavailable { reason }
        if reason.code == "schema_version_mismatch" && reason.message.contains("found 0"))
    );
}

#[test]
fn caller_cannot_select_a_different_fence() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("not-created/context.db");
    let mut request = request(&path);
    request.expected_schema_version += 1;
    assert!(
        matches!(BOOTSTRAP.bootstrap(&request), CapabilityResult::Unavailable { reason }
        if reason.code == "schema_version_mismatch")
    );
    assert!(!path.parent().unwrap().exists());
}

#[test]
fn current_host_rejects_caller_selected_older_fence() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("context.db");
    install(&path);
    let before = fs::read(&path).unwrap();
    let mut previous = request(&path);
    previous.expected_schema_version = BOOTSTRAP_VERSION - 1;
    assert!(
        matches!(BOOTSTRAP.bootstrap(&previous), CapabilityResult::Unavailable { reason }
        if reason.code == "schema_version_mismatch")
    );
    assert_eq!(fs::read(&path).unwrap(), before);
    assert_eq!(install(&path).schema_version, BOOTSTRAP_VERSION);
}

#[test]
fn current_database_is_idempotent_and_keeps_data() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("context.db");
    let first = install(&path);
    Connection::open(&path)
        .unwrap()
        .execute(
            "INSERT INTO schema_migrations_meta (key, value) VALUES ('keep', 'data')",
            [],
        )
        .unwrap();
    let before = fs::read(&path).unwrap();
    assert_eq!(install(&path), first);
    assert_eq!(fs::read(path).unwrap(), before);
}

#[test]
fn bootstrap_completes_empty_fts_but_preserves_pending_legacy_work() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("context.db");
    install(&path);
    let connection = Connection::open(&path).unwrap();
    let completed = || {
        connection
            .query_row(
                "SELECT completed FROM message_fts_rowid_map_backfill_state WHERE id = 1",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap()
    };
    assert_eq!(completed(), 1);
    connection
        .execute_batch(
            "INSERT INTO message_history_fts
                 (session_id, message_ordinal, message_id, role, content)
             VALUES ('legacy', 1, 'm1', 'user', 'legacy text');
             UPDATE message_fts_rowid_map_backfill_state SET completed = 0 WHERE id = 1;",
        )
        .unwrap();
    install(&path);
    assert_eq!(completed(), 0);
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM message_history_fts", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        1
    );
}

#[test]
fn concurrent_bootstraps_install_once() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("context.db");
    std::thread::scope(|scope| {
        let first = scope.spawn(|| install(&path));
        let second = scope.spawn(|| install(&path));
        assert_eq!(first.join().unwrap(), second.join().unwrap());
    });
    let count: i64 = Connection::open(path)
        .unwrap()
        .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(
        count as usize,
        golden()["snapshot"]["migrations"].as_array().unwrap().len()
    );
}

#[test]
#[cfg(unix)]
fn bootstrap_files_and_directories_are_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("first/second/context.db");
    install(&path);
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    for directory in [
        path.parent().unwrap(),
        path.parent().unwrap().parent().unwrap(),
    ] {
        assert_eq!(
            fs::metadata(directory).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
    fs::set_permissions(&path, fs::Permissions::from_mode(0o666)).unwrap();
    fs::set_permissions(path.parent().unwrap(), fs::Permissions::from_mode(0o777)).unwrap();
    install(&path);
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        fs::metadata(path.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
}

#[test]
#[cfg(unix)]
fn symlink_database_is_refused_without_touching_target() {
    let temp = TempDir::new().unwrap();
    let target = temp.path().join("target.db");
    fs::write(&target, "keep").unwrap();
    let path = temp.path().join("link.db");
    std::os::unix::fs::symlink(&target, &path).unwrap();
    assert!(
        matches!(BOOTSTRAP.bootstrap(&request(&path)), CapabilityResult::Unavailable { reason }
        if reason.code == "unsafe_database_path")
    );
    assert_eq!(fs::read_to_string(target).unwrap(), "keep");
}
