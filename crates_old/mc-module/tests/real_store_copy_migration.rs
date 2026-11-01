//! Apply this build's mc-store chain to a copy of a real store and prove it lands intact.
//!
//! Synthetic fixtures only carry the rows a test author thought of. A store that has
//! lived through months of sessions carries everything else, so the migrations that
//! ship in a restart window are also run against a copy of one before that window.
//!
//! The test is inert unless `MC_REAL_STORE_COPY` names a `store.db` copy. It never
//! touches that file: it copies it next to itself (`<name>.migrate-<pid>.db`),
//! migrates the copy through the production `McStore::open`, and reports the time,
//! the versions applied and `PRAGMA quick_check`. Make the copy with
//! `sqlite3 -readonly <live store.db> "VACUUM INTO '<throwaway path>'"` so the
//! live store is never opened for write.

use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
use mc_store::{McStore, LATEST_MIGRATION_VERSION};
use rusqlite::Connection;
use std::path::PathBuf;
use std::time::Instant;

fn descriptor(path: &std::path::Path) -> StorageDescriptor {
    StorageDescriptor {
        module_id: "mc-module-real-store-copy".to_string(),
        storage_namespace: "mc_cache".to_string(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: path.to_string_lossy().to_string(),
        },
    }
}

fn recorded_versions(path: &std::path::Path) -> Vec<i64> {
    let conn = Connection::open(path).unwrap();
    let mut statement = conn
        .prepare("SELECT version FROM cortexkit_schema_version WHERE namespace = 'mc_cache' ORDER BY version")
        .unwrap();
    let rows = statement
        .query_map([], |row| row.get::<_, i64>(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    rows
}

#[test]
fn a_copy_of_a_real_store_migrates_to_this_build_and_passes_quick_check() {
    let Some(source) = std::env::var_os("MC_REAL_STORE_COPY").map(PathBuf::from) else {
        eprintln!("MC_REAL_STORE_COPY unset; nothing to migrate");
        return;
    };
    let working = source.with_extension(format!("migrate-{}.db", std::process::id()));
    std::fs::copy(&source, &working).unwrap();
    // The copy keeps the live writer's fence epoch, while this process opens it at
    // epoch one. Reset only that lease field (as the e2e harness does for a seeded
    // store) so the open is not refused as a stale writer.
    Connection::open(&working)
        .unwrap()
        .execute("UPDATE cortexkit_fence SET epoch = 0 WHERE id = 0", [])
        .unwrap();

    let before = recorded_versions(&working);
    let started = Instant::now();
    let store = McStore::open_for_test(&descriptor(&working)).unwrap();
    let elapsed = started.elapsed();
    drop(store);
    let after = recorded_versions(&working);
    let applied: Vec<i64> = after
        .iter()
        .copied()
        .filter(|v| !before.contains(v))
        .collect();

    let conn = Connection::open(&working).unwrap();
    let quick_check: String = conn
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .unwrap();
    let pending_rows: i64 = conn
        .query_row("SELECT COUNT(*) FROM mc_historian_pending_run", [], |row| {
            row.get(0)
        })
        .unwrap();
    let single_store: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(single_store), 0) FROM mc_privilege_state",
            [],
            |row| row.get(0),
        )
        .unwrap();
    eprintln!(
        "real store copy: before max={:?} applied={applied:?} elapsed_ms={} quick_check={quick_check} pending_runs={pending_rows} single_store={single_store} working={}",
        before.last(),
        elapsed.as_millis(),
        working.display()
    );
    assert_eq!(
        after.last().copied(),
        Some(i64::from(LATEST_MIGRATION_VERSION))
    );
    assert_eq!(quick_check, "ok");
    assert_eq!(
        single_store, 0,
        "no migration may set the single-store marker"
    );
    // A second open is a no-op on an already-migrated store.
    let started = Instant::now();
    drop(McStore::open_for_test(&descriptor(&working)).unwrap());
    eprintln!(
        "real store copy: reopen elapsed_ms={}",
        started.elapsed().as_millis()
    );
    if std::env::var_os("MC_REAL_STORE_KEEP").is_none() {
        std::fs::remove_file(&working).ok();
    }
}
