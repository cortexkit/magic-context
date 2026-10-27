use super::*;
use std::cell::Cell;
use std::marker::PhantomData;
use std::rc::Rc;

thread_local! {
    static DIFFERENTIALS_DISABLED: Cell<bool> = const { Cell::new(false) };
    static FIXED_NOW_MS: Cell<Option<i64>> = const { Cell::new(None) };
}

pub(super) fn fixed_now_ms() -> Option<i64> {
    FIXED_NOW_MS.get()
}

/// The fixed clock as a guard other test modules can hold.
pub(super) fn fixed_clock() -> impl Drop {
    FixedClock::new()
}

struct FixedClock {
    previous: Option<i64>,
    _thread_bound: PhantomData<Rc<()>>,
}

impl FixedClock {
    fn new() -> Self {
        Self {
            previous: FIXED_NOW_MS.replace(Some(1_791_072_000_000)),
            _thread_bound: PhantomData,
        }
    }
}

impl Drop for FixedClock {
    fn drop(&mut self) {
        FIXED_NOW_MS.set(self.previous);
    }
}

pub(super) fn differentials_disabled() -> bool {
    DIFFERENTIALS_DISABLED.get()
}

// The guard is thread-bound so concurrent tests keep their full references,
// and unwinding restores the prior setting.
struct DifferentialOverride {
    previous: bool,
    _thread_bound: PhantomData<Rc<()>>,
}

impl DifferentialOverride {
    fn new(references: bool) -> Self {
        Self {
            previous: DIFFERENTIALS_DISABLED.replace(!references),
            _thread_bound: PhantomData,
        }
    }
}

impl Drop for DifferentialOverride {
    fn drop(&mut self) {
        DIFFERENTIALS_DISABLED.set(self.previous);
    }
}

fn references_enabled(value: Option<&str>) -> bool {
    match value {
        None | Some("on") => true,
        Some("off") => false,
        Some(other) => panic!("MC_PER_PASS_REFERENCES must be on or off, got {other:?}"),
    }
}

#[test]
fn per_pass_differential_override_is_scoped_and_thread_local() {
    let predicates = crate::transform::prefix_projection_differential_enabled;
    assert!(predicates());
    {
        let _off = DifferentialOverride::new(false);
        assert!(!predicates());
        // The test default remains on on a separate worker thread.
        assert!(std::thread::spawn(predicates).join().unwrap());
        {
            let _on = DifferentialOverride::new(true);
            assert!(predicates());
        }
        assert!(!predicates());
    }
    assert!(predicates());
    let unwind = std::panic::catch_unwind(|| {
        let _off = DifferentialOverride::new(false);
        assert!(!predicates());
        panic!("exercise scope cleanup");
    });
    assert!(unwind.is_err());
    assert!(predicates());
}

#[test]
fn per_pass_reference_mode_defaults_on_and_rejects_unknown_values() {
    assert!(references_enabled(None));
    assert!(references_enabled(Some("on")));
    assert!(!references_enabled(Some("off")));
    assert!(std::panic::catch_unwind(|| references_enabled(Some("0"))).is_err());
}

// Only this store-clock bookkeeping column is excluded. Module-owned timestamps
// are frozen by FixedClock, including timestamps embedded in trace JSON. Keep
// unknown columns: they might feed a decision or a later served response.
const PERSISTED_BOOKKEEPING_EXCLUSIONS: &[(&str, &str)] = &[("mc_cache_state", "last_activity_at")];

#[test]
fn fixed_profile_clock_is_scoped_and_thread_local() {
    assert_eq!(fixed_now_ms(), None);
    {
        let _clock = FixedClock::new();
        assert_eq!(crate::now_ms(), 1_791_072_000_000);
        assert_eq!(std::thread::spawn(fixed_now_ms).join().unwrap(), None);
    }
    assert_eq!(fixed_now_ms(), None);
    let unwind = std::panic::catch_unwind(|| {
        let _clock = FixedClock::new();
        panic!("exercise clock cleanup");
    });
    assert!(unwind.is_err());
    assert_eq!(fixed_now_ms(), None);
}

#[test]
fn persisted_profile_digest_checks_raw_rows_and_only_named_bookkeeping_is_ignored() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store.db");
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TABLE mc_cache_state (session_id TEXT, core_state TEXT, last_activity_at INTEGER);
         CREATE TABLE mc_pass_trace_history (session_id TEXT, entry TEXT);
         INSERT INTO mc_cache_state VALUES ('s', '{\"n\":1}', 1);
         INSERT INTO mc_pass_trace_history VALUES ('s', 'received');",
    )
    .unwrap();
    let before = persisted_bytes_digest(&path, "s");
    conn.execute("UPDATE mc_cache_state SET last_activity_at=2", [])
        .unwrap();
    assert_eq!(before, persisted_bytes_digest(&path, "s"));
    conn.execute("UPDATE mc_cache_state SET core_state='{\"n\":1.0}'", [])
        .unwrap();
    let raw_change = persisted_bytes_digest(&path, "s");
    assert_ne!(
        before, raw_change,
        "logically equal JSON is not byte-identical"
    );
    conn.execute("UPDATE mc_pass_trace_history SET entry='completed'", [])
        .unwrap();
    assert_ne!(
        raw_change,
        persisted_bytes_digest(&path, "s"),
        "trace contents are compared too"
    );
}

// Hash actual stored JSON strings, chunk bodies and row values without decoding
// or re-encoding them. Physical SQLite pages/WAL layout are not row-state bytes.
fn persisted_bytes_digest(path: &Path, session: &str) -> String {
    let conn =
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
    let tables = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let mut hash = Sha256::new();
    let field = |hash: &mut Sha256, bytes: &[u8]| {
        hash.update((bytes.len() as u64).to_le_bytes());
        hash.update(bytes);
    };
    for table in tables {
        let quoted = format!("\"{}\"", table.replace('"', "\"\""));
        let columns = conn
            .prepare(&format!("PRAGMA table_info({quoted})"))
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        if !columns.iter().any(|column| column == "session_id") {
            continue;
        }
        let columns: Vec<_> = columns
            .into_iter()
            .filter(|column| {
                !PERSISTED_BOOKKEEPING_EXCLUSIONS.contains(&(table.as_str(), column.as_str()))
            })
            .collect();
        field(&mut hash, table.as_bytes());
        for column in &columns {
            field(&mut hash, column.as_bytes());
        }
        let selection = columns
            .iter()
            .map(|column| format!("\"{}\"", column.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(",");
        let ordering = (1..=columns.len())
            .map(|i| i.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let mut query = conn
            .prepare(&format!(
                "SELECT {selection} FROM {quoted} WHERE session_id=?1 ORDER BY {ordering}"
            ))
            .unwrap();
        let mut rows = query.query([session]).unwrap();
        while let Some(row) = rows.next().unwrap() {
            hash.update(b"R");
            for column in 0..columns.len() {
                use rusqlite::types::ValueRef;
                match row.get_ref(column).unwrap() {
                    ValueRef::Null => hash.update(b"N"),
                    ValueRef::Integer(value) => {
                        hash.update(b"I");
                        hash.update(value.to_le_bytes());
                    }
                    ValueRef::Real(value) => {
                        hash.update(b"F");
                        hash.update(value.to_bits().to_le_bytes());
                    }
                    ValueRef::Text(value) => {
                        hash.update(b"T");
                        field(&mut hash, value);
                    }
                    ValueRef::Blob(value) => {
                        hash.update(b"B");
                        field(&mut hash, value);
                    }
                }
            }
        }
    }
    format!("{:x}", hash.finalize())
}
