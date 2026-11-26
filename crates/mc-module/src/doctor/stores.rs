use std::ffi::OsStr;
use std::fmt::Write as _;
use std::io::{self, Read};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

use cortexkit_doctor::{Evidence, EvidenceValue, Finding, Severity};
use rusqlite::{Connection, OpenFlags, OptionalExtension};

use crate::agent_data::journal;
use crate::context_db::{self, live_schema_version};
use crate::context_migrations::RELEASED_PLUGIN_VERSION;
use crate::replica::local_only_outbox_count;
use crate::storage_paths::{CONTEXT_DB, SESSION_DB};

use super::files::{child_dir, regular_file, sidecar, DataDir, Sidecars};
use super::{code, count, evidence, finding, path_evidence, Budget, WIRE_MAX_INTEGER};

const HOUR_MS: i64 = 60 * 60 * 1000;

#[derive(Default)]
pub(super) struct StoreScan {
    timed_out: bool,
    lookup_failed: u64,
    journal_bytes: Option<u64>,
}

impl StoreScan {
    pub(super) fn evidence(self) -> Vec<Evidence> {
        let mut details = Vec::new();
        if self.timed_out || self.lookup_failed > 0 || self.journal_bytes.is_some() {
            details.push(code("stores_phase", "stores"));
            if self.timed_out {
                details.push(evidence("stores_timed_out", EvidenceValue::Bool(true)));
            }
            if self.lookup_failed > 0 {
                details.push(count("stores_open_failed_count", self.lookup_failed));
            }
            if let Some(bytes) = self.journal_bytes {
                details.push(code("journal_reason", "journal_size_limit"));
                details.push(evidence(
                    "journal_bytes",
                    EvidenceValue::Bytes(bytes.min(WIRE_MAX_INTEGER)),
                ));
            }
        }
        details
    }

    fn expired(&mut self, budget: &Budget) -> bool {
        self.timed_out |= budget.expired();
        self.timed_out
    }
}

pub(super) fn check(
    data: &DataDir,
    unix_ms: i64,
    budget: &Budget,
    findings: &mut Vec<Finding>,
) -> StoreScan {
    check_with_open(data, unix_ms, budget, findings, immutable)
}

pub(super) fn check_with_open(
    data: &DataDir,
    unix_ms: i64,
    budget: &Budget,
    findings: &mut Vec<Finding>,
    open: impl FnOnce(&Path) -> rusqlite::Result<Connection>,
) -> StoreScan {
    let mut scan = StoreScan::default();
    if scan.expired(budget) {
        return scan;
    }
    let mut unreadable = Vec::new();
    let mut in_use = Vec::new();
    let sessions_header = header(data, SESSION_DB);
    match sessions_header {
        Ok(Some(found)) if found > crate::store::SCHEMA_VERSION => {
            findings.push(finding(
                "store.sessions.too_new",
                Severity::Error,
                "The session-state store is newer than this version of Magic Context can read.",
                versions(
                    i64::from(found),
                    "supported_version",
                    i64::from(crate::store::SCHEMA_VERSION),
                ),
            ));
        }
        Err(_) => record_unreadable(data, &mut unreadable, "sessions", SESSION_DB),
        _ => (),
    }
    if !scan.expired(budget) {
        let sessions = data.sidecars(SESSION_DB);
        sidecar_evidence(
            data,
            SESSION_DB,
            "sessions",
            &sessions,
            &mut in_use,
            &mut scan,
        );
        if sessions.present.contains(&"wal") {
            in_use.push(evidence(
                "sessions_version_may_be_stale",
                EvidenceValue::Bool(true),
            ));
        }
        if !scan.expired(budget) {
            let mut context = data.sidecars(CONTEXT_DB);
            if context.clear() && !scan.expired(budget) {
                match header(data, CONTEXT_DB) {
                    Ok(Some(_)) if !scan.expired(budget) => {
                        let conn = open(&data.path.join(CONTEXT_DB));
                        // Skip SQL if a writer appeared after the first probe.
                        // Immutable mode prevents writes, not a torn read of a live store.
                        if !scan.expired(budget) {
                            context = data.sidecars(CONTEXT_DB);
                            if context.clear() && !scan.expired(budget) {
                                match conn.and_then(|conn| {
                                    read_context(&conn, budget, unix_ms, sessions.clear(), findings)
                                }) {
                                    Ok(()) => (),
                                    Err(_) if scan.expired(budget) => (),
                                    Err(_) => record_unreadable(
                                        data,
                                        &mut unreadable,
                                        "context",
                                        CONTEXT_DB,
                                    ),
                                }
                            }
                        }
                    }
                    Err(_) => record_unreadable(data, &mut unreadable, "context", CONTEXT_DB),
                    _ => (),
                }
            }
            sidecar_evidence(
                data,
                CONTEXT_DB,
                "context",
                &context,
                &mut in_use,
                &mut scan,
            );
        }
    }
    if !unreadable.is_empty() {
        findings.push(finding(
            "store.unreadable",
            Severity::Error,
            "Magic Context could not read a store as SQLite.",
            unreadable,
        ));
    }
    if !in_use.is_empty() {
        findings.push(finding(
            "store.in_use",
            Severity::Info,
            "A store is open in another program or was not closed cleanly; the session-state version read from disk may be older than the running version.",
            in_use,
        ));
    }
    let path = journal::path(Path::new(CONTEXT_DB));
    if !scan.expired(budget) {
        match check_journal(data, &path, budget) {
            Ok(()) => (),
            Err(JournalError::TooLarge(bytes)) => scan.journal_bytes = Some(bytes),
            Err(JournalError::TimedOut) => scan.timed_out = true,
            Err(JournalError::Unreadable) => findings.push(finding(
                "moves.journal_unreadable",
                Severity::Error,
                "Magic Context cannot read its session-move journal and will refuse to serve sessions.",
                vec![path_evidence("path", data, &path)],
            )),
        }
    }
    scan.expired(budget);
    scan
}

fn sidecar_evidence(
    data: &DataDir,
    db: &str,
    key: &str,
    sidecars: &Sidecars,
    details: &mut Vec<Evidence>,
    scan: &mut StoreScan,
) {
    scan.lookup_failed += sidecars.lookup_failed;
    if !sidecars.present.is_empty() {
        details.push(code(&format!("{key}_store"), key));
        for suffix in &sidecars.present {
            details.push(path_evidence(
                &format!("{key}_{suffix}"),
                data,
                Path::new(&sidecar(db, suffix)),
            ));
        }
    }
}

fn read_context(
    conn: &Connection,
    budget: &Budget,
    unix_ms: i64,
    sessions_closed: bool,
    findings: &mut Vec<Finding>,
) -> rusqlite::Result<()> {
    attach_progress_handler(conn, budget);
    let found = live_schema_version(conn)?;
    if let Some(finding) = context_version(found) {
        findings.push(finding);
    } else if sessions_closed && !budget.expired() {
        // A session-store sidecar means the module may still be running, so
        // report sharing state only when neither store has signs of an active writer.
        sharing(conn, unix_ms, findings)?;
    }
    Ok(())
}

pub(super) fn attach_progress_handler(conn: &Connection, budget: &Budget) {
    if budget.limits.is_some() {
        let budget = budget.clone();
        conn.progress_handler(1000, Some(move || budget.expired()));
    }
}

fn record_unreadable(data: &DataDir, details: &mut Vec<Evidence>, key: &str, db: &str) {
    details.push(code(&format!("{key}_store"), key));
    details.push(path_evidence(&format!("{key}_path"), data, Path::new(db)));
}

pub(super) fn header(data: &DataDir, db: &str) -> io::Result<Option<u32>> {
    let Some(mut file) = regular_file(&data.fd, OsStr::new(db))? else {
        return Ok(None);
    };
    let mut header = [0; 100];
    // SQLite treats a zero-length file as empty, not as a malformed header.
    if file.read(&mut header[..1])? == 0 {
        return Ok(None);
    }
    file.read_exact(&mut header[1..])?;
    if !header.starts_with(b"SQLite format 3\0") {
        return Err(io::ErrorKind::InvalidData.into());
    }
    Ok(Some(u32::from_be_bytes(
        header[60..64].try_into().expect("four version bytes"),
    )))
}

pub(super) fn immutable(path: &Path) -> rusqlite::Result<Connection> {
    let mut uri = String::from("file:");
    for byte in path.as_os_str().as_bytes() {
        if byte.is_ascii_alphanumeric() || b"/._-~".contains(byte) {
            uri.push(char::from(*byte));
        } else {
            write!(uri, "%{byte:02X}").expect("writing a String cannot fail");
        }
    }
    uri.push_str("?immutable=1");
    Connection::open_with_flags(
        uri,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
}

fn context_version(found: i64) -> Option<Finding> {
    // This store tracks versions in the migration ledger, not user_version.
    // Use the same query as the serving opener, and the same oldest and
    // newest versions it accepts.
    let supported = i64::from(context_db::SCHEMA_VERSION);
    let (id, severity, summary, name, fence) = if found > supported {
        (
            "store.context.too_new",
            Severity::Error,
            "The context store is newer than this version of Magic Context can read.",
            "supported_version",
            supported,
        )
    } else if found < RELEASED_PLUGIN_VERSION {
        (
            "store.context.too_old",
            Severity::Error,
            "The context store must be opened by Magic Context 0.49 before it can be upgraded.",
            "oldest_supported_version",
            RELEASED_PLUGIN_VERSION,
        )
    } else if found < supported {
        (
            "store.context.upgrade_pending",
            Severity::Info,
            "Magic Context will upgrade the context store the next time it starts.",
            "current_version",
            supported,
        )
    } else {
        return None;
    };
    Some(finding(id, severity, summary, versions(found, name, fence)))
}

fn versions(found: i64, name: &str, fence: i64) -> Vec<Evidence> {
    let version = |key, value: i64| evidence(key, EvidenceValue::Version(value.to_string()));
    vec![version("found_version", found), version(name, fence)]
}

enum JournalError {
    TooLarge(u64),
    TimedOut,
    Unreadable,
}

fn check_journal(data: &DataDir, path: &Path, budget: &Budget) -> Result<(), JournalError> {
    let Some(folder) = child_dir(&data.fd, path.parent().expect("journal parent").as_os_str())
        .map_err(|_| JournalError::Unreadable)?
    else {
        return Ok(());
    };
    let Some(file) = regular_file(&folder, path.file_name().expect("journal filename"))
        .map_err(|_| JournalError::Unreadable)?
    else {
        return Ok(());
    };
    let len = file.metadata().map_err(|_| JournalError::Unreadable)?.len();
    let limit = budget.journal_limit();
    if limit.is_some_and(|limit| len > limit) {
        return Err(JournalError::TooLarge(len));
    }
    // Also bound the read if the file grows after the size observation.
    let mut limited = (&file).take(limit.map_or(u64::MAX, |limit| limit + 1));
    let mut bytes = Vec::with_capacity(len.min(64 * 1024) as usize);
    let mut buffer = [0; 8192];
    loop {
        if budget.expired() {
            return Err(JournalError::TimedOut);
        }
        match limited.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => bytes.extend_from_slice(&buffer[..n]),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return Err(JournalError::Unreadable),
        }
    }
    if limit.is_some_and(|limit| bytes.len() as u64 > limit) {
        let observed = bytes.len() as u64;
        let len = file
            .metadata()
            .map_or(observed, |meta| meta.len().max(observed));
        return Err(JournalError::TooLarge(len));
    }
    if budget.expired() {
        return Err(JournalError::TimedOut);
    }
    journal::parse(&bytes).map_err(|_| JournalError::Unreadable)?;
    Ok(())
}

fn sharing(conn: &Connection, unix_ms: i64, findings: &mut Vec<Finding>) -> rusqlite::Result<()> {
    let hold: Option<(u64, i64)> = conn
        .query_row(
            "SELECT held_epoch, held_since FROM replica_state
          WHERE id = 1 AND held_epoch >= 0 AND held_since > 0",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((epoch, since)) = hold {
        let age = unix_ms.saturating_sub(since);
        if age > HOUR_MS {
            findings.push(finding(
                "sharing.held",
                Severity::Warning,
                "Memory sharing has been held for more than an hour because a key is missing.",
                vec![
                    evidence(
                        "hours_held",
                        EvidenceValue::Ratio(age as f64 / HOUR_MS as f64),
                    ),
                    count("key_number", epoch),
                ],
            ));
        }
    }
    let joined: bool = conn.query_row(
        "SELECT joined_at IS NOT NULL FROM replica_state WHERE id = 1",
        [],
        |row| row.get(0),
    )?;
    if !joined {
        return Ok(());
    }
    const SENDABLE: &str = "('pending', 'sending')";
    let unsent: u64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM replica_outbox WHERE state IN {SENDABLE}"),
        [],
        |row| row.get(0),
    )?;
    let sendable = unsent - local_only_outbox_count(conn, SENDABLE)?;
    if sendable > 0 {
        findings.push(finding(
            "sharing.unsent",
            Severity::Info,
            "Magic Context has changes queued for the other computers.",
            vec![count("count", sendable)],
        ));
    }
    Ok(())
}
