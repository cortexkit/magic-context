use super::*;
use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
use std::path::Path;

fn wal_bytes(path: &Path) -> u64 {
    let mut name = path.as_os_str().to_owned();
    name.push("-wal");
    std::fs::metadata(name).map_or(0, |meta| meta.len())
}

fn open(path: &Path) -> McStore {
    McStore::open_for_test(&StorageDescriptor {
        module_id: "magic-context".into(),
        storage_namespace: crate::NS.into(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: path.to_string_lossy().into(),
        },
    })
    .unwrap()
}
fn seed(store: &McStore) {
    store.execute_tag_sql_for_test("CREATE TABLE wal_probe(id INTEGER PRIMARY KEY, payload BLOB); INSERT INTO wal_probe VALUES(0,x'00')").unwrap();
}
#[test]
fn startup_primes_restarted_wal_without_changing_schema_or_sync_policy() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store.db");
    {
        let store = open(&path);
        seed(&store);
        store
            .execute_tag_sql_for_test("PRAGMA user_version=42")
            .unwrap();
    }
    let store = open(&path);
    assert_eq!(wal_bytes(&path), 0, "closed seed starts with an empty WAL");
    // Establish the lease's fence epoch, then empty the WAL. Otherwise the fence
    // advance itself could hide a missing page-one write in the startup prime.
    store.inner.with_conn_fenced(|_| Ok(())).unwrap();
    store
        .inner
        .with_conn(|conn| {
            conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
                row.get::<_, i64>(0)
            })
        })
        .unwrap();
    assert_eq!(wal_bytes(&path), 0);
    let state = || {
        store
            .inner
            .with_conn(|conn| {
                let schema = conn
                    .prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name")?
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, Option<String>>(3)?,
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                let version: u32 =
                    conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
                let sync: u32 = conn.pragma_query_value(None, "synchronous", |row| row.get(0))?;
                let schema_version: u32 =
                    conn.pragma_query_value(None, "schema_version", |row| row.get(0))?;
                let rows: u64 = conn.query_row(
                    "SELECT count(*) FROM wal_probe WHERE id=0 AND payload=x'00'",
                    [],
                    |row| row.get(0),
                )?;
                Ok((schema, version, sync, schema_version, rows))
            })
            .unwrap()
    };
    let before = state();
    assert_eq!((before.1, before.2, before.4), (42, 1, 1));
    store.prime_wal_for_serving().unwrap();
    assert!(
        wal_bytes(&path) > 32,
        "startup must commit a WAL frame before serving"
    );
    assert_eq!(
        state(),
        before,
        "priming changes no logical state or durability policy"
    );
}
