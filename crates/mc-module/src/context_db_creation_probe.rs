use std::path::Path;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rusqlite::Connection;

use super::{
    initialize_fresh_schema, initialize_schema_statement_by_statement, live_schema_version,
    ContextDb, FRESH_SCHEMA, SCHEMA_VERSION,
};

#[derive(Clone, Copy)]
enum Setup {
    StatementByStatement,
    OneTransaction,
    WalNormalFirst,
}

fn millis(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1_000.0
}

fn check_version(db: &ContextDb) {
    assert_eq!(
        db.with_connection(|connection| live_schema_version(connection).unwrap()),
        i64::from(SCHEMA_VERSION)
    );
}

fn time_schema(dir: &Path, label: &str, schema: &str, setup: Setup) {
    let path = dir.join(format!("{label}.db"));
    let start = Instant::now();
    let mut db = Connection::open(&path).unwrap();
    if let Setup::WalNormalFirst = setup {
        let mode: String = db
            .query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
        db.pragma_update(None, "synchronous", "NORMAL").unwrap();
    }
    let mode: String = db
        .pragma_query_value(None, "journal_mode", |row| row.get(0))
        .unwrap();
    let synchronous: u32 = db
        .pragma_query_value(None, "synchronous", |row| row.get(0))
        .unwrap();
    if let Setup::WalNormalFirst = setup {
        assert_eq!(synchronous, 1, "WAL-first must time NORMAL synchronous");
    }
    let schema_start = Instant::now();
    match setup {
        Setup::StatementByStatement => initialize_schema_statement_by_statement(&db, schema),
        Setup::OneTransaction => initialize_fresh_schema(&mut db, schema),
        Setup::WalNormalFirst => db.execute_batch(schema),
    }
    .unwrap();
    let schema_time = schema_start.elapsed();
    eprintln!(
        "sqlite-create {label} journal={mode} synchronous={synchronous} schema_ms={:.3}",
        millis(schema_time)
    );
    drop(db);
    let reopen_start = Instant::now();
    let opened = ContextDb::open(&path).unwrap();
    eprintln!(
        "sqlite-create {label} reopen_ms={:.3} replay_total_ms={:.3}",
        millis(reopen_start.elapsed()),
        millis(start.elapsed())
    );
    check_version(&opened);
}

#[test]
#[ignore = "explicit measurement of how the bundled SQLite creates throwaway stores"]
fn fresh_store_creation_timing() {
    let dir = tempfile::tempdir().unwrap();
    eprintln!(
        "sqlite-create arch={} sqlite={} temp_fs={}",
        std::env::consts::ARCH,
        rusqlite::version(),
        filesystem(dir.path())
    );
    let start = Instant::now();
    let db = ContextDb::create(&dir.path().join("production.db")).unwrap();
    eprintln!(
        "sqlite-create production total_ms={:.3}",
        millis(start.elapsed())
    );
    check_version(&db);
    drop(db);

    // Replay the same schema on separate files so the real creation path can
    // be timed unmodified. The replays do not repeat its hard-link publication.
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let schema = FRESH_SCHEMA.replace(":applied_at", &now.to_string());
    time_schema(
        dir.path(),
        "statement-by-statement",
        &schema,
        Setup::StatementByStatement,
    );
    time_schema(
        dir.path(),
        "one-transaction",
        &schema,
        Setup::OneTransaction,
    );
    time_schema(
        dir.path(),
        "wal-normal-first",
        &schema,
        Setup::WalNormalFirst,
    );
}

#[cfg(windows)]
fn filesystem(path: &Path) -> String {
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;
    use windows_sys::Win32::Storage::FileSystem::{GetVolumeInformationW, GetVolumePathNameW};

    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut volume = vec![0u16; 32_768];
    // SAFETY: The input has a NUL terminator and the output holds the stated
    // number of UTF-16 units. Both buffers live until the call returns.
    #[allow(unsafe_code)]
    let found =
        unsafe { GetVolumePathNameW(path.as_ptr(), volume.as_mut_ptr(), volume.len() as u32) };
    assert_ne!(
        found,
        0,
        "GetVolumePathNameW: {}",
        std::io::Error::last_os_error()
    );
    let mut filesystem = [0u16; 256];
    // SAFETY: On success the first call supplied a NUL-terminated volume
    // path. The only requested output is a buffer of the stated length; the
    // unused output pointers may be null.
    #[allow(unsafe_code)]
    let found = unsafe {
        GetVolumeInformationW(
            volume.as_ptr(),
            ptr::null_mut(),
            0,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            filesystem.as_mut_ptr(),
            filesystem.len() as u32,
        )
    };
    assert_ne!(
        found,
        0,
        "GetVolumeInformationW: {}",
        std::io::Error::last_os_error()
    );
    let len = filesystem.iter().position(|&unit| unit == 0).unwrap();
    String::from_utf16(&filesystem[..len]).unwrap()
}

#[cfg(not(windows))]
fn filesystem(_path: &Path) -> &'static str {
    "not measured on this platform"
}
