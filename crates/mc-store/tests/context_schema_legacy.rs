use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{Barrier, OnceLock},
};

use mc_store::context_schema::fingerprints::{fingerprint, schema_snapshot};
use rusqlite::{types::ValueRef, Connection};
use serde_json::{json, Value};
use tempfile::TempDir;

use mc_store::context_schema::migrations_legacy::{upgrade, UpgradeError};

fn throwaway() -> TempDir {
    let root = std::env::temp_dir().join("magic-context/bg_48144117908c2836");
    fs::create_dir_all(&root).unwrap();
    tempfile::Builder::new()
        .prefix("legacy-")
        .tempdir_in(root)
        .unwrap()
}

fn fixtures() -> &'static TempDir {
    static FIXTURES: OnceLock<TempDir> = OnceLock::new();
    FIXTURES.get_or_init(|| {
        let temporary = throwaway();
        let script = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("testdata/context_schema_legacy/generate.ts");
        let result = Command::new("bun")
            .arg(script)
            .arg(temporary.path())
            .output()
            .expect("Bun is required to execute the real TypeScript migration chain");
        assert!(
            result.status.success(),
            "TypeScript fixture generation failed:\n{}\n{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        println!("{}", String::from_utf8_lossy(&result.stdout).trim());
        temporary
    })
}

fn copy_fixture(version: u32, temp: &TempDir) -> PathBuf {
    let destination = temp.path().join("context.db");
    fs::copy(
        fixtures().path().join(format!("v{version}.db")),
        &destination,
    )
    .unwrap();
    destination
}

fn expected(version: u32) -> Value {
    serde_json::from_slice(&fs::read(fixtures().path().join(format!("v{version}.json"))).unwrap())
        .unwrap()
}

fn data(db: &Connection, starting_version: u32) -> Value {
    let mut statement = db.prepare("PRAGMA table_list").unwrap();
    let tables = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    let mut tables: Vec<_> = tables
        .into_iter()
        .filter(|(schema, name, kind)| {
            schema == "main" && kind != "shadow" && !name.starts_with("sqlite_schema")
        })
        .collect();
    tables.sort_by(|a, b| a.1.cmp(&b.1));
    Value::Array(tables.into_iter().map(|(_,name,_)| {
        let quoted = name.replace('\'', "''");
        let mut statement = db.prepare(&format!("PRAGMA table_info('{quoted}')")).unwrap();
        let columns = statement.query_map([], |row| row.get::<_, String>(1)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
        let mut statement = db.prepare(&format!("SELECT * FROM '{quoted}'")).unwrap();
        let mut rows = statement.query_map([], |row| columns.iter().map(|column| {
            let value = row.get_ref(column.as_str())?;
            if name == "schema_migrations" && column == "applied_at" { return Ok(json!(":clock")); }
            if name == "compartment_history_versions" && column == "generation" && starting_version < 93 {
                let generation = value.as_str().unwrap();
                assert_eq!(generation.len(), 32);
                assert!(generation.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
                return Ok(json!(":random-generation"));
            }
            Ok(match value {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(value) => json!(value),
                ValueRef::Real(value) if value.fract() == 0.0 => json!(value as i64),
                ValueRef::Real(value) => json!(value),
                ValueRef::Text(value) => json!(std::str::from_utf8(value).unwrap()),
                ValueRef::Blob(value) => json!({"blob": value.iter().map(|byte| format!("{byte:02x}")).collect::<String>()}),
            })
        }).collect::<rusqlite::Result<Vec<Value>>>()).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
        rows.sort_by_cached_key(|row| serde_json::to_string(row).unwrap());
        json!({"name": name, "columns": columns, "rows": rows})
    }).collect())
}

fn compare(db: &Connection, version: u32, golden: &Value) {
    let actual = serde_json::to_value(schema_snapshot(db).unwrap()).unwrap();
    let expected = &golden["snapshot"];
    if actual != *expected {
        for section in ["master", "tables", "migrations"] {
            let left = actual[section].as_array().unwrap();
            let right = expected[section].as_array().unwrap();
            for extra in left.iter().filter(|row| !right.contains(row)).take(2) {
                eprintln!("v{version} different {section}: {extra}");
            }
            for missing in right.iter().filter(|row| !left.contains(row)).take(2) {
                eprintln!("v{version} expected {section}: {missing}");
            }
        }
    }
    assert!(
        actual == *expected,
        "v{version}: schema differs from TypeScript"
    );
    let actual_data = data(db, version);
    if actual_data != golden["data"] {
        for (actual, expected) in actual_data
            .as_array()
            .unwrap()
            .iter()
            .zip(golden["data"].as_array().unwrap())
        {
            if actual != expected {
                eprintln!("v{version} data differs in {}", actual["name"]);
            }
        }
    }
    assert!(
        actual_data == golden["data"],
        "v{version}: rows differ from TypeScript"
    );
}

#[test]
fn populated_versions_87_through_current_match_typescript() {
    for version in 87..=mc_store::context_schema::BOOTSTRAP_VERSION {
        let temp = throwaway();
        let path = copy_fixture(version, &temp);
        let golden = expected(version);
        let mut db = Connection::open(path).unwrap();
        db.pragma_update(None, "foreign_keys", true).unwrap();
        let report = upgrade(&mut db, golden["now"].as_i64().unwrap()).unwrap();
        assert_eq!(
            report.schema_version,
            mc_store::context_schema::BOOTSTRAP_VERSION
        );
        assert_eq!(
            report.schema_fingerprint.0,
            fingerprint(&schema_snapshot(&db).unwrap())
        );
        compare(&db, version, &golden);
        println!("Compared populated v{version}: schema fingerprint, all ordinary/virtual rows and blob bytes");
    }
}

#[test]
fn failed_step_rolls_back_ddl_data_and_ledger_but_keeps_prior_steps() {
    let temp = throwaway();
    let path = copy_fixture(93, &temp);
    let mut db = Connection::open(path).unwrap();
    db.execute_batch("CREATE TRIGGER reject_v95 BEFORE INSERT ON schema_migrations WHEN NEW.version=95 BEGIN SELECT RAISE(ABORT,'intentional ledger failure'); END").unwrap();
    let error = upgrade(&mut db, expected(93)["now"].as_i64().unwrap()).unwrap_err();
    assert!(error.to_string().contains("intentional ledger failure"));
    let version: u32 = db
        .query_row(
            "SELECT MAX(version) FROM schema_migrations WHERE version<10000",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(version, 94);
    let temporal: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='temporal_decisions')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!temporal, "v95 DDL must roll back with its ledger insert");
    let blob: String = db.query_row("SELECT merged_reasoning_stripped_ids FROM session_meta WHERE session_id='session-main'", [], |row| row.get(0)).unwrap();
    assert!(
        blob.contains("temporal-message-v1:"),
        "v95 data movement must roll back"
    );
    let chunks: i64 = db
        .query_row("SELECT COUNT(*) FROM lkg_slot_chunks", [], |row| row.get(0))
        .unwrap();
    assert!(
        chunks > 1,
        "v94 must remain committed, matching TypeScript per-step atomicity"
    );
    db.execute_batch("DROP TRIGGER reject_v95").unwrap();
    upgrade(&mut db, expected(93)["now"].as_i64().unwrap()).unwrap();
    compare(&db, 93, &expected(93));
}

#[test]
fn concurrent_startup_serializes_and_does_not_duplicate_migrations() {
    let temp = throwaway();
    let path = copy_fixture(87, &temp);
    let barrier = Barrier::new(3);
    let now = expected(87)["now"].as_i64().unwrap();
    std::thread::scope(|scope| {
        let handles: Vec<_> = (0..3)
            .map(|_| {
                scope.spawn(|| {
                    let mut db = Connection::open(&path).unwrap();
                    barrier.wait();
                    upgrade(&mut db, now).unwrap()
                })
            })
            .collect();
        let reports: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        assert!(reports.windows(2).all(|pair| pair[0] == pair[1]));
    });
    compare(&Connection::open(path).unwrap(), 87, &expected(87));
}

#[test]
fn unsupported_upstream_versions_are_refused_byte_for_byte() {
    for version in [0, 86, mc_store::context_schema::BOOTSTRAP_VERSION + 1, 9999] {
        let temp = throwaway();
        let path = copy_fixture(mc_store::context_schema::BOOTSTRAP_VERSION, &temp);
        let db = Connection::open(&path).unwrap();
        db.execute("DELETE FROM schema_migrations WHERE version<10000", [])
            .unwrap();
        db.execute(
            "INSERT INTO schema_migrations VALUES (?1,'unsupported fixture',123)",
            [version],
        )
        .unwrap();
        db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").unwrap();
        drop(db);
        let before = fs::read(&path).unwrap();
        let mut db = Connection::open(&path).unwrap();
        assert!(
            matches!(upgrade(&mut db, 1_800_000_000_000), Err(UpgradeError::UnsupportedVersion(found)) if found == i64::from(version))
        );
        drop(db);
        assert_eq!(fs::read(path).unwrap(), before);
    }
}

#[test]
fn current_store_is_read_only_even_while_a_writer_holds_the_lock() {
    let temp = throwaway();
    let current = mc_store::context_schema::BOOTSTRAP_VERSION;
    let path = copy_fixture(current, &temp);
    let holder = Connection::open(&path).unwrap();
    holder.execute_batch("BEGIN IMMEDIATE").unwrap();
    let before = fs::read(&path).unwrap();
    let mut db = Connection::open(&path).unwrap();
    upgrade(&mut db, 1_800_000_000_000).unwrap();
    compare(&db, current, &expected(current));
    assert_eq!(fs::read(path).unwrap(), before);
    holder.execute_batch("ROLLBACK").unwrap();
}

#[test]
fn initializer_supplied_columns_are_not_added_twice() {
    let temp = throwaway();
    let path = copy_fixture(87, &temp);
    let mut db = Connection::open(path).unwrap();
    let plans: Value =
        serde_json::from_str(include_str!("../testdata/context_schema_legacy/steps.json")).unwrap();
    for sql in plans[0]["sql"].as_array().unwrap() {
        db.execute_batch(sql.as_str().unwrap()).unwrap();
    }
    upgrade(&mut db, expected(87)["now"].as_i64().unwrap()).unwrap();
    compare(&db, 87, &expected(87));
}

#[test]
fn prerelease_git_map_is_verified_without_replacing_its_rows() {
    let plans: Value =
        serde_json::from_str(include_str!("../testdata/context_schema_legacy/steps.json")).unwrap();
    let ddl = plans
        .as_array()
        .unwrap()
        .iter()
        .find(|step| step["version"] == 95)
        .unwrap()["sql"]
        .as_array()
        .unwrap()
        .iter()
        .find_map(|sql| {
            sql.as_str()
                .filter(|sql| sql.starts_with("CREATE TABLE git_commit_fts_rowid_map"))
        })
        .unwrap();
    for corrupt in [false, true] {
        let temp = throwaway();
        let path = copy_fixture(94, &temp);
        let mut db = Connection::open(path).unwrap();
        db.execute_batch(ddl).unwrap();
        db.execute_batch("INSERT INTO git_commit_fts_rowid_map(fts_rowid,sha) SELECT rowid,sha FROM git_commits_fts").unwrap();
        if corrupt {
            db.execute("UPDATE git_commit_fts_rowid_map SET sha='wrong-sha'", [])
                .unwrap();
        }
        let before = data(&db, 94);
        let result = upgrade(&mut db, expected(94)["now"].as_i64().unwrap());
        if corrupt {
            assert!(result
                .unwrap_err()
                .to_string()
                .contains("git FTS rowid inventory differs"));
            assert_eq!(
                data(&db, 94),
                before,
                "failed verification must preserve the map and all other rows"
            );
        } else {
            result.unwrap();
            compare(&db, 94, &expected(94));
        }
    }
}
