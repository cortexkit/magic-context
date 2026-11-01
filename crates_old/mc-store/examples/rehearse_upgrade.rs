//! Offline entrypoints for the upgrade rehearsal; all writes are confined to its temporary root.
use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
use mc_store::context_schema::{
    fingerprints::{fingerprint, schema_snapshot, SchemaSnapshot, TableSnapshot},
    migrations_legacy::upgrade,
    BOOTSTRAP, BOOTSTRAP_VERSION,
};
use mc_store::parity_schema_manifest::{
    CapabilityResult, ContextSchemaRequest, ContextSchemaStore, Generation,
};
use rusqlite::{types::ValueRef, Connection};
use serde_json::{json, Value};
use std::{
    error::Error,
    fs,
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

fn rows(db: &Connection, sql: &str) -> rusqlite::Result<Vec<Vec<Value>>> {
    let mut statement = db.prepare(sql)?;
    let result = statement
        .query_map([], |row| {
            (0..row.as_ref().column_count())
                .map(|i| {
                    Ok(match row.get_ref(i)? {
                        ValueRef::Null => Value::Null,
                        ValueRef::Integer(v) => json!(v),
                        ValueRef::Real(v) => json!(v),
                        ValueRef::Text(v) => json!(String::from_utf8_lossy(v)),
                        ValueRef::Blob(_) => return Err(rusqlite::Error::InvalidQuery),
                    })
                })
                .collect()
        })?
        .collect();
    result
}

// Store migrations have a namespace/version ledger rather than context's description ledger.
// Their SQL comes from one Rust chain, so retain the exact DDL in this structural snapshot.
fn store_snapshot(db: &Connection) -> rusqlite::Result<SchemaSnapshot> {
    let master = rows(
        db,
        "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name",
    )?;
    let mut tables = Vec::new();
    for object in &master {
        if object[0] != "table" {
            continue;
        }
        let name = object[1].as_str().ok_or(rusqlite::Error::InvalidQuery)?;
        let quoted = format!("'{}'", name.replace('\'', "''"));
        let mut indexes: Vec<Vec<Value>> = rows(db, &format!("PRAGMA index_list({quoted})"))?
            .into_iter()
            .map(|r| r.into_iter().skip(1).collect())
            .collect();
        indexes.sort_by(|a, b| a[0].as_str().cmp(&b[0].as_str()));
        tables.push(TableSnapshot {
            name: name.into(),
            columns: rows(db, &format!("PRAGMA table_info({quoted})"))?,
            indexes,
            foreign_keys: rows(db, &format!("PRAGMA foreign_key_list({quoted})"))?,
        });
    }
    Ok(SchemaSnapshot {
        user_version: db.query_row("PRAGMA user_version", [], |r| r.get(0))?,
        migrations: rows(
            db,
            "SELECT namespace,version FROM cortexkit_schema_version ORDER BY namespace",
        )?,
        master,
        tables,
    })
}

fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = std::env::args().collect();
    let root = PathBuf::from(&args[2]).canonicalize()?;
    if !root.starts_with(std::env::temp_dir().join("magic-context").canonicalize()?) {
        return Err("root must be under $TMPDIR/magic-context".into());
    }
    let context = root.join("context.db");
    match args[1].as_str() {
        "context" => {
            let mut db = Connection::open(&context)?;
            if let Ok(target) = std::env::var("REHEARSAL_CRASH_VERSION") {
                let target: i64 = target.parse()?;
                let marker = root.join("crash-ready");
                // An update hook runs after the ledger INSERT but before its transaction commits.
                db.update_hook(Some(move |_: rusqlite::hooks::Action, _: &str, table: &str, rowid: i64| {
                    if table == "schema_migrations" && rowid == target {
                        fs::write(&marker, format!("context.db migration {target} ledger inserted, transaction uncommitted")).expect("crash marker");
                        loop { std::thread::park_timeout(Duration::from_secs(60)); }
                    }
                }));
            }
            upgrade(&mut db, 1_800_000_000_000)?;
        }
        "fresh-context" => {
            match BOOTSTRAP.bootstrap(&ContextSchemaRequest {
                database_path: context.to_string_lossy().into_owned(),
                expected_schema_version: BOOTSTRAP_VERSION,
                writer_generation: Generation(1),
            }) {
                CapabilityResult::Available { .. } => (),
                other => return Err(format!("bootstrap: {other:?}").into()),
            }
        }
        "store" => {
            let descriptor = StorageDescriptor {
                module_id: "magic-context".into(),
                storage_namespace: "mc_cache".into(),
                isolation: Isolation::Module,
                backend: StorageBackend::Sqlite {
                    path: root.join("store.db").to_string_lossy().into_owned(),
                },
            };
            let started = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis();
            drop(mc_store::McStore::open(&descriptor)?);
            let finished = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis();
            println!(
                "REHEARSAL_OPEN {}",
                json!({"startedAtMs": started, "finishedAtMs": finished})
            );
        }
        "fingerprint" => {
            let db = Connection::open(&context)?;
            let snapshot = schema_snapshot(&db)?;
            let store = Connection::open(root.join("store.db"))?;
            let store_schema = store_snapshot(&store)?;
            println!(
                "{}",
                json!({ "context": fingerprint(&snapshot), "store": fingerprint(&store_schema), "context_schema": snapshot, "store_schema": store_schema, "context_version": BOOTSTRAP_VERSION, "store_version": mc_store::LATEST_MIGRATION_VERSION })
            );
        }
        other => return Err(format!("unknown operation {other}").into()),
    }
    Ok(())
}
