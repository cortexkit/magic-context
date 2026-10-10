//! Measures what one Cache-tab live refresh costs, poll by poll, against the
//! real stores on this machine (every reader the dashboard uses is read-only).
//!
//!   cargo run --release --bin bench_cache_poll -- --harness broca --polls 10
//!   cargo run --release --bin bench_cache_poll -- --harness opencode --polls 10
//!   cargo run --release --bin bench_cache_poll -- --harness all --dump out.json
//!
//! `--events <session id>` prints one session's event window as JSON.
//! `--dump` instead writes one listing and the full event window of every
//! listed session as JSON, so two builds can be compared for identical output.
//!
//! The loop mirrors `reconcile` in CacheDiagnostics.tsx: list sessions
//! (limit 50, managed only, subagents hidden), keep a window for the ten most
//! recent sessions (full load the first time, an incremental `since` fetch
//! whenever a session's listed activity moves), once per interval.
//!
//! Every SQLite file access in the process goes through a counting VFS
//! registered as the default before any connection opens, so the report gives
//! the bytes SQLite actually read and wrote per poll, split into database,
//! write-ahead log and temporary (sort spill) files. Broca WAL bytes come from
//! the reader's own counter. CPU is this process's user + system time.

use std::collections::HashMap;
use std::ffi::{c_char, c_int, c_void, CString};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use magic_context_dashboard_lib::broca_wal;
use magic_context_dashboard_lib::db::{self, Harness};
use rusqlite::ffi;

static DB_READ: AtomicU64 = AtomicU64::new(0);
static WAL_READ: AtomicU64 = AtomicU64::new(0);
static TEMP_READ: AtomicU64 = AtomicU64::new(0);
static TEMP_WRITE: AtomicU64 = AtomicU64::new(0);
static OTHER_WRITE: AtomicU64 = AtomicU64::new(0);
static OPENS: AtomicU64 = AtomicU64::new(0);

static mut REAL_VFS: *mut ffi::sqlite3_vfs = std::ptr::null_mut();

#[repr(C)]
struct ShimFile {
    base: ffi::sqlite3_file,
    real: *mut ffi::sqlite3_file,
    flags: c_int,
}

const TEMP_FLAGS: c_int = ffi::SQLITE_OPEN_TEMP_DB
    | ffi::SQLITE_OPEN_TEMP_JOURNAL
    | ffi::SQLITE_OPEN_TRANSIENT_DB
    | ffi::SQLITE_OPEN_SUBJOURNAL;

unsafe fn real(
    file: *mut ffi::sqlite3_file,
) -> (*mut ffi::sqlite3_file, &'static ffi::sqlite3_io_methods) {
    let shim = file as *mut ShimFile;
    let real = (*shim).real;
    (real, &*(*real).pMethods)
}

unsafe extern "C" fn x_close(file: *mut ffi::sqlite3_file) -> c_int {
    let (r, m) = real(file);
    m.xClose.unwrap()(r)
}
unsafe extern "C" fn x_read(
    file: *mut ffi::sqlite3_file,
    buf: *mut c_void,
    amt: c_int,
    off: i64,
) -> c_int {
    let flags = (*(file as *mut ShimFile)).flags;
    let counter = if flags & ffi::SQLITE_OPEN_WAL != 0 {
        &WAL_READ
    } else if flags & TEMP_FLAGS != 0 {
        &TEMP_READ
    } else {
        &DB_READ
    };
    counter.fetch_add(amt as u64, Ordering::Relaxed);
    let (r, m) = real(file);
    m.xRead.unwrap()(r, buf, amt, off)
}
unsafe extern "C" fn x_write(
    file: *mut ffi::sqlite3_file,
    buf: *const c_void,
    amt: c_int,
    off: i64,
) -> c_int {
    let flags = (*(file as *mut ShimFile)).flags;
    if flags & TEMP_FLAGS != 0 {
        TEMP_WRITE.fetch_add(amt as u64, Ordering::Relaxed);
    } else {
        OTHER_WRITE.fetch_add(amt as u64, Ordering::Relaxed);
    }
    let (r, m) = real(file);
    m.xWrite.unwrap()(r, buf, amt, off)
}
unsafe extern "C" fn x_truncate(file: *mut ffi::sqlite3_file, size: i64) -> c_int {
    let (r, m) = real(file);
    m.xTruncate.unwrap()(r, size)
}
unsafe extern "C" fn x_sync(file: *mut ffi::sqlite3_file, flags: c_int) -> c_int {
    let (r, m) = real(file);
    m.xSync.unwrap()(r, flags)
}
unsafe extern "C" fn x_file_size(file: *mut ffi::sqlite3_file, size: *mut i64) -> c_int {
    let (r, m) = real(file);
    m.xFileSize.unwrap()(r, size)
}
unsafe extern "C" fn x_lock(file: *mut ffi::sqlite3_file, level: c_int) -> c_int {
    let (r, m) = real(file);
    m.xLock.unwrap()(r, level)
}
unsafe extern "C" fn x_unlock(file: *mut ffi::sqlite3_file, level: c_int) -> c_int {
    let (r, m) = real(file);
    m.xUnlock.unwrap()(r, level)
}
unsafe extern "C" fn x_check_reserved(file: *mut ffi::sqlite3_file, out: *mut c_int) -> c_int {
    let (r, m) = real(file);
    m.xCheckReservedLock.unwrap()(r, out)
}
unsafe extern "C" fn x_file_control(
    file: *mut ffi::sqlite3_file,
    op: c_int,
    arg: *mut c_void,
) -> c_int {
    let (r, m) = real(file);
    m.xFileControl.unwrap()(r, op, arg)
}
unsafe extern "C" fn x_sector_size(file: *mut ffi::sqlite3_file) -> c_int {
    let (r, m) = real(file);
    m.xSectorSize.unwrap()(r)
}
unsafe extern "C" fn x_device(file: *mut ffi::sqlite3_file) -> c_int {
    let (r, m) = real(file);
    m.xDeviceCharacteristics.unwrap()(r)
}
unsafe extern "C" fn x_shm_map(
    file: *mut ffi::sqlite3_file,
    pg: c_int,
    sz: c_int,
    extend: c_int,
    out: *mut *mut c_void,
) -> c_int {
    let (r, m) = real(file);
    match m.xShmMap {
        Some(f) => f(r, pg, sz, extend, out),
        None => ffi::SQLITE_IOERR,
    }
}
unsafe extern "C" fn x_shm_lock(
    file: *mut ffi::sqlite3_file,
    off: c_int,
    n: c_int,
    flags: c_int,
) -> c_int {
    let (r, m) = real(file);
    match m.xShmLock {
        Some(f) => f(r, off, n, flags),
        None => ffi::SQLITE_IOERR,
    }
}
unsafe extern "C" fn x_shm_barrier(file: *mut ffi::sqlite3_file) {
    let (r, m) = real(file);
    if let Some(f) = m.xShmBarrier {
        f(r)
    }
}
unsafe extern "C" fn x_shm_unmap(file: *mut ffi::sqlite3_file, delete: c_int) -> c_int {
    let (r, m) = real(file);
    match m.xShmUnmap {
        Some(f) => f(r, delete),
        None => ffi::SQLITE_OK,
    }
}
unsafe extern "C" fn x_fetch(
    file: *mut ffi::sqlite3_file,
    off: i64,
    amt: c_int,
    out: *mut *mut c_void,
) -> c_int {
    // Refuse memory-mapped reads so every page read goes through x_read and is counted.
    let _ = (file, off, amt);
    *out = std::ptr::null_mut();
    ffi::SQLITE_OK
}
unsafe extern "C" fn x_unfetch(file: *mut ffi::sqlite3_file, off: i64, p: *mut c_void) -> c_int {
    let (r, m) = real(file);
    match m.xUnfetch {
        Some(f) if !p.is_null() => f(r, off, p),
        _ => ffi::SQLITE_OK,
    }
}

static METHODS: ffi::sqlite3_io_methods = ffi::sqlite3_io_methods {
    iVersion: 3,
    xClose: Some(x_close),
    xRead: Some(x_read),
    xWrite: Some(x_write),
    xTruncate: Some(x_truncate),
    xSync: Some(x_sync),
    xFileSize: Some(x_file_size),
    xLock: Some(x_lock),
    xUnlock: Some(x_unlock),
    xCheckReservedLock: Some(x_check_reserved),
    xFileControl: Some(x_file_control),
    xSectorSize: Some(x_sector_size),
    xDeviceCharacteristics: Some(x_device),
    xShmMap: Some(x_shm_map),
    xShmLock: Some(x_shm_lock),
    xShmBarrier: Some(x_shm_barrier),
    xShmUnmap: Some(x_shm_unmap),
    xFetch: Some(x_fetch),
    xUnfetch: Some(x_unfetch),
};

unsafe extern "C" fn x_open(
    _vfs: *mut ffi::sqlite3_vfs,
    name: *const c_char,
    file: *mut ffi::sqlite3_file,
    flags: c_int,
    out_flags: *mut c_int,
) -> c_int {
    OPENS.fetch_add(1, Ordering::Relaxed);
    let shim = file as *mut ShimFile;
    let real_file =
        (file as *mut u8).add(std::mem::size_of::<ShimFile>()) as *mut ffi::sqlite3_file;
    (*real_file).pMethods = std::ptr::null();
    let rc = (*REAL_VFS).xOpen.unwrap()(REAL_VFS, name, real_file, flags, out_flags);
    if (*real_file).pMethods.is_null() {
        (*shim).base.pMethods = std::ptr::null();
    } else {
        (*shim).base.pMethods = &METHODS;
        (*shim).real = real_file;
        (*shim).flags = flags;
    }
    rc
}

fn install_counting_vfs() {
    unsafe {
        let real_vfs = ffi::sqlite3_vfs_find(std::ptr::null());
        assert!(!real_vfs.is_null());
        REAL_VFS = real_vfs;
        let mut vfs: ffi::sqlite3_vfs = std::ptr::read(real_vfs);
        vfs.szOsFile = (std::mem::size_of::<ShimFile>() as c_int) + (*real_vfs).szOsFile;
        vfs.zName = CString::new("counting").unwrap().into_raw();
        vfs.pNext = std::ptr::null_mut();
        vfs.xOpen = Some(x_open);
        let leaked = Box::into_raw(Box::new(vfs));
        assert_eq!(ffi::sqlite3_vfs_register(leaked, 1), ffi::SQLITE_OK);
    }
}

#[derive(Clone, Copy, Default)]
struct Snapshot {
    cpu_us: u64,
    db_read: u64,
    wal_read: u64,
    temp_read: u64,
    temp_write: u64,
    broca_wal_read: u64,
    opens: u64,
}

/// Process CPU time (user + system) in microseconds. `getrusage` exists only on
/// Unix; the release build compiles this benchmark binary on Windows too, where
/// the CPU column reads 0 and the I/O counters still work.
#[cfg(unix)]
fn process_cpu_us() -> u64 {
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) };
    let tv = |t: libc::timeval| t.tv_sec as u64 * 1_000_000 + t.tv_usec as u64;
    tv(usage.ru_utime) + tv(usage.ru_stime)
}

#[cfg(not(unix))]
fn process_cpu_us() -> u64 {
    0
}

fn snapshot() -> Snapshot {
    Snapshot {
        cpu_us: process_cpu_us(),
        db_read: DB_READ.load(Ordering::Relaxed),
        wal_read: WAL_READ.load(Ordering::Relaxed),
        temp_read: TEMP_READ.load(Ordering::Relaxed),
        temp_write: TEMP_WRITE.load(Ordering::Relaxed),
        broca_wal_read: broca_wal::bytes_read_total(),
        opens: OPENS.load(Ordering::Relaxed),
    }
}

fn mb(bytes: u64) -> f64 {
    bytes as f64 / 1_048_576.0
}

struct Window {
    last_seen: i64,
    last_activity_ms: i64,
}

fn main() {
    install_counting_vfs();
    let args: Vec<String> = std::env::args().collect();
    let arg = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1).cloned())
    };
    let harness: Option<Harness> = match arg("--harness").as_deref() {
        None | Some("all") => None,
        Some(name) => Some(name.parse().expect("harness")),
    };
    if let Some(session) = arg("--events") {
        // One session's event window exactly as the Cache tab receives it.
        let harness = harness.unwrap_or(Harness::Broca);
        let limit = arg("--limit").map_or(1000, |n| n.parse().expect("limit"));
        let events = db::get_session_cache_events(harness, &session, Some(limit), None);
        println!("{}", serde_json::to_string(&events).unwrap());
        return;
    }
    if let Some(path) = arg("--dump") {
        let sessions = db::get_session_cache_stats_from_db(50, false, true, harness);
        let windows: Vec<_> = sessions
            .iter()
            .map(|row| {
                serde_json::json!({
                    "harness": row.harness,
                    "session_id": row.session_id,
                    "events": db::get_session_cache_events(row.harness, &row.session_id, Some(200), None),
                })
            })
            .collect();
        let dump = serde_json::json!({"sessions": sessions, "windows": windows});
        std::fs::write(&path, serde_json::to_string_pretty(&dump).unwrap()).unwrap();
        return;
    }
    let polls: usize = arg("--polls").map_or(10, |n| n.parse().expect("polls"));
    let interval =
        Duration::from_millis(arg("--interval-ms").map_or(1000, |n| n.parse().expect("interval")));
    let mut windows: HashMap<(Harness, String), Window> = HashMap::new();
    println!("poll,wall_ms,cpu_ms,db_read_mb,sqlite_wal_read_mb,temp_read_mb,temp_write_mb,broca_wal_read_mb,sqlite_opens,listed,fetched");
    let mut totals = Snapshot::default();
    for poll in 0..polls {
        let started = Instant::now();
        let before = snapshot();
        let sessions = db::get_session_cache_stats_from_db(50, false, true, harness);
        let recent: Vec<_> = sessions
            .iter()
            .filter(|s| {
                !matches!(
                    s.harness,
                    Harness::ClaudeCode | Harness::Codex | Harness::Broca
                ) || s.managed
            })
            .filter(|s| !s.is_subagent)
            .take(10)
            .collect();
        let mut fetched = 0;
        for row in &recent {
            let key = (row.harness, row.session_id.clone());
            match windows.get_mut(&key) {
                None => {
                    let events =
                        db::get_session_cache_events(row.harness, &row.session_id, Some(200), None);
                    windows.insert(
                        key,
                        Window {
                            last_seen: events.last().map_or(0, |e| e.timestamp),
                            last_activity_ms: row.last_activity_ms,
                        },
                    );
                    fetched += 1;
                }
                Some(win) if row.last_activity_ms > win.last_activity_ms => {
                    let since = (win.last_seen > 0).then_some(win.last_seen);
                    let events =
                        db::get_session_cache_events(row.harness, &row.session_id, None, since);
                    if let Some(last) = events.last() {
                        win.last_seen = win.last_seen.max(last.timestamp);
                    }
                    win.last_activity_ms = row.last_activity_ms;
                    fetched += 1;
                }
                Some(_) => {}
            }
        }
        let after = snapshot();
        let wall = started.elapsed();
        let d = |f: fn(&Snapshot) -> u64| f(&after) - f(&before);
        println!(
            "{poll},{:.1},{:.1},{:.2},{:.2},{:.2},{:.2},{:.2},{},{},{}",
            wall.as_secs_f64() * 1000.0,
            d(|s| s.cpu_us) as f64 / 1000.0,
            mb(d(|s| s.db_read)),
            mb(d(|s| s.wal_read)),
            mb(d(|s| s.temp_read)),
            mb(d(|s| s.temp_write)),
            mb(d(|s| s.broca_wal_read)),
            d(|s| s.opens),
            sessions.len(),
            fetched,
        );
        if poll > 0 {
            totals.cpu_us += d(|s| s.cpu_us);
            totals.db_read += d(|s| s.db_read);
            totals.wal_read += d(|s| s.wal_read);
            totals.temp_read += d(|s| s.temp_read);
            totals.temp_write += d(|s| s.temp_write);
            totals.broca_wal_read += d(|s| s.broca_wal_read);
        }
        if poll + 1 < polls {
            std::thread::sleep(interval.saturating_sub(wall));
        }
    }
    if polls > 1 {
        let n = (polls - 1) as f64;
        println!(
            "steady-state mean over polls 1..{}: cpu {:.1} ms, db read {:.2} MB, sqlite wal read {:.2} MB, temp read {:.2} MB, temp write {:.2} MB, broca wal read {:.2} MB",
            polls - 1,
            totals.cpu_us as f64 / 1000.0 / n,
            mb(totals.db_read) / n,
            mb(totals.wal_read) / n,
            mb(totals.temp_read) / n,
            mb(totals.temp_write) / n,
            mb(totals.broca_wal_read) / n,
        );
    }
}
