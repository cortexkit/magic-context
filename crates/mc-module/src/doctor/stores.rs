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
use crate::replica::OUTBOX_BACKLOG;
use crate::storage_paths::{CONTEXT_DB, SESSION_DB};

use super::files::{child_dir, regular_file, DataDir};
use super::{code, count, evidence, finding, path_evidence};

const HOUR_MS: i64 = 60 * 60 * 1000;

pub(super) fn check(data: &DataDir, unix_ms: i64, findings: &mut Vec<Finding>) {
    let mut unreadable = Vec::new();
    let mut in_use = Vec::new();
    let context_header = header(data, CONTEXT_DB);
    let sessions_header = header(data, SESSION_DB);
    let sessions_busy = data.has_sidecar(SESSION_DB);
    let mut context_busy = data.has_sidecar(CONTEXT_DB);
    match context_header {
        Ok(Some(_)) if !context_busy => {
            let path = data.path.join(CONTEXT_DB);
            let conn = immutable(&path);
            // A writer may have started since the first observation. Even in
            // that race the connection cannot write a WAL read mark or lock.
            context_busy = data.has_sidecar(CONTEXT_DB);
            if !context_busy {
                match conn.and_then(|conn| {
                    let found = live_schema_version(&conn)?;
                    if let Some(finding) = context_version(found) {
                        findings.push(finding);
                    } else if !sessions_busy {
                        sharing(&conn, unix_ms, findings)?;
                    }
                    Ok(())
                }) {
                    Ok(()) => (),
                    Err(_) => record_unreadable(data, &mut unreadable, "context", CONTEXT_DB),
                }
            }
        }
        Err(_) => record_unreadable(data, &mut unreadable, "context", CONTEXT_DB),
        _ => (),
    }
    if context_busy {
        in_use.push(code("context_store", "context"));
    }
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
    if sessions_busy {
        in_use.push(code("sessions_store", "sessions"));
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
            "Magic Context skipped checks that require closed stores because SQLite sidecar files are present.",
            in_use,
        ));
    }
    let path = journal::path(Path::new(CONTEXT_DB));
    if check_journal(data, &path).is_err() {
        findings.push(finding(
            "moves.journal_unreadable",
            Severity::Error,
            "Magic Context cannot read its session-move journal and will refuse to serve sessions.",
            vec![path_evidence("path", data, &path)],
        ));
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
    file.read_exact(&mut header)?;
    if !header.starts_with(b"SQLite format 3\0") {
        return Err(io::ErrorKind::InvalidData.into());
    }
    Ok(Some(u32::from_be_bytes(
        header[60..64].try_into().expect("four version bytes"),
    )))
}

fn immutable(path: &Path) -> rusqlite::Result<Connection> {
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

fn check_journal(data: &DataDir, path: &Path) -> Result<(), ()> {
    let Some(folder) =
        child_dir(&data.fd, path.parent().expect("journal parent").as_os_str()).map_err(|_| ())?
    else {
        return Ok(());
    };
    let Some(mut file) =
        regular_file(&folder, path.file_name().expect("journal filename")).map_err(|_| ())?
    else {
        return Ok(());
    };
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(|_| ())?;
    journal::parse(&bytes).map_err(|_| ())?;
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
    let unsent: u64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM replica_outbox WHERE state IN {OUTBOX_BACKLOG}"),
        [],
        |row| row.get(0),
    )?;
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
    if unsent > 0 {
        findings.push(finding(
            "sharing.unsent",
            Severity::Info,
            "Magic Context has changes queued for the other computers.",
            vec![count("count", unsent)],
        ));
    }
    Ok(())
}
