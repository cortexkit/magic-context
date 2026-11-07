//! Offline changes to the runner namespace of existing mode3.db sessions.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use rusqlite::{params, Connection, OpenFlags, TransactionBehavior};
use serde::Serialize;

use crate::store::{lock_store, SCHEMA_VERSION};

mod process_check;

pub const HELP: &str = "Usage: ck-mc rekey-runner --from <module> --to <module> --harness <h> --session <id> [--session <id> ...] [--dry-run]

Re-key existing sessions in mode3.db without migrating either database.
ck-mc must be stopped, with automatic restarts disabled: this command refuses a
store held open by another process.
Linux checks /proc for open files; macOS requires lsof. MAGIC_CONTEXT_MODE3_STORE
overrides the store path, as for move-in. context.db (MAGIC_CONTEXT_DB) is checked read-only:
summary_in_flight means historian stage attempts must finish before re-keying.
--dry-run reports the same row counts without writes.";

#[derive(Clone, Debug)]
pub struct Request {
    pub from: String,
    pub to: String,
    pub harness: String,
    pub sessions: Vec<String>,
    pub dry_run: bool,
}

impl Request {
    pub fn parse(args: impl IntoIterator<Item = String>) -> Result<Self, String> {
        let mut args = args.into_iter();
        let (mut from, mut to, mut harness) = (None, None, None);
        let mut sessions = Vec::new();
        let mut dry_run = false;
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--dry-run" => dry_run = true,
                "--from" | "--to" | "--harness" | "--session" => {
                    let value = args
                        .next()
                        .filter(|value| !value.starts_with("--"))
                        .ok_or_else(|| format!("invalid_arguments: {arg} needs a value"))?;
                    let slot = match arg.as_str() {
                        "--from" => &mut from,
                        "--to" => &mut to,
                        "--harness" => &mut harness,
                        _ => {
                            sessions.push(value);
                            continue;
                        }
                    };
                    if slot.replace(value).is_some() {
                        return Err(format!("invalid_arguments: repeated {arg}"));
                    }
                }
                _ => return Err(format!("invalid_arguments: unknown argument {arg}")),
            }
        }
        let request = Self {
            from: from.ok_or("invalid_arguments: missing --from")?,
            to: to.ok_or("invalid_arguments: missing --to")?,
            harness: harness.ok_or("invalid_arguments: missing --harness")?,
            sessions,
            dry_run,
        };
        request.validate()?;
        Ok(request)
    }

    fn validate(&self) -> Result<(), String> {
        if self.from == self.to {
            return Err("same_runner: --from and --to must differ".into());
        }
        if self.from.is_empty()
            || self.to.is_empty()
            || self.harness.is_empty()
            || self.sessions.is_empty()
            || self.sessions.iter().any(String::is_empty)
        {
            return Err(
                "invalid_arguments: nonempty runners, harness and sessions are required".into(),
            );
        }
        Ok(())
    }
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct Summary {
    pub from: String,
    pub to: String,
    pub harness: String,
    pub sessions: Vec<String>,
    pub sessions_rekeyed: usize,
    pub rows_per_table: BTreeMap<String, u64>,
    pub dry_run: bool,
}

fn quoted(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn session_tables(connection: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut tables = connection.prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name",
    )?;
    let names = tables
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut result = Vec::new();
    for name in names {
        let mut columns = connection.prepare("SELECT name FROM pragma_table_info(?1)")?;
        let columns = columns
            .query_map([&name], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<BTreeSet<_>>>()?;
        if ["runner", "harness", "session"]
            .iter()
            .all(|column| columns.contains(*column))
        {
            result.push(name);
        }
    }
    Ok(result)
}

fn refuse_in_flight(context_path: &Path, request: &Request) -> Result<(), String> {
    if !context_path
        .try_exists()
        .map_err(|error| format!("context_check_failed: {error}"))?
    {
        return Ok(());
    }
    // Open no ContextDb: its startup path performs writes. A read-only raw
    // connection is enough to reject child routes that still name the old runner.
    let connection = Connection::open_with_flags(context_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("context_check_failed: {error}"))?;
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='memory_stage_attempts')",
        [], |row| row.get(0),
    ).map_err(|error| format!("context_check_failed: {error}"))?;
    if !exists {
        return Ok(());
    }
    for session in &request.sessions {
        // Completed attempts retain their historical carrier. Unknown states
        // are refused too, so a future resumable state cannot slip past this guard.
        let count: u64 = connection
            .query_row(
                "SELECT count(*) FROM memory_stage_attempts
             WHERE carrier=?1 AND harness=?2 AND session_id=?3
               AND (state IS NULL OR state NOT IN ('published','superseded','resolved','revoked',
                                 'envelope_failed','expired','transport_failed',
                                 'parse_failed','counter_reset'))",
                params![format!("ck-mc:{}", request.from), request.harness, session],
                |row| row.get(0),
            )
            .map_err(|error| format!("context_check_failed: {error}"))?;
        if count > 0 {
            return Err(format!("summary_in_flight: {}/{session} has {count} unfinished historian stage attempt(s) for {}; let them finish before re-keying", request.harness, request.from));
        }
    }
    Ok(())
}

pub fn rekey_runner(
    path: &Path,
    context_path: &Path,
    request: &Request,
) -> Result<Summary, String> {
    rekey_with_check(
        path,
        context_path,
        request,
        process_check::refuse_open_store,
    )
}

fn rekey_with_check(
    path: &Path,
    context_path: &Path,
    request: &Request,
    check: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<Summary, String> {
    request.validate()?;
    let path = path
        .canonicalize()
        .map_err(|error| format!("store_open: {}: {error}", path.display()))?;
    let _lease = lock_store(&path, true)?;
    check(&path)?;
    refuse_in_flight(context_path, request)?;
    // Store::open migrates and creates tables. Offline rekeys must instead
    // reject every other schema version without modifying the store.
    let mut connection = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|error| format!("store_open: {error}"))?;
    connection
        .busy_timeout(std::time::Duration::ZERO)
        .map_err(|error| error.to_string())?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("store_in_use: {error}"))?;
    let version: u32 = tx
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if version != SCHEMA_VERSION {
        return Err(format!(
            "schema_mismatch: store has schema {version}; expected {SCHEMA_VERSION}"
        ));
    }
    let tables = session_tables(&tx).map_err(|error| error.to_string())?;
    let sessions: Vec<_> = request
        .sessions
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let mut rows_per_table: BTreeMap<_, u64> =
        tables.iter().map(|table| (table.clone(), 0)).collect();
    for session in &sessions {
        let mut source_rows = 0;
        for table in &tables {
            let sql = format!(
                "SELECT count(*) FROM {} WHERE runner=?1 AND harness=?2 AND session=?3",
                quoted(table)
            );
            let count: u64 = tx
                .query_row(
                    &sql,
                    params![request.from, request.harness, session],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())?;
            let target: u64 = tx
                .query_row(&sql, params![request.to, request.harness, session], |row| {
                    row.get(0)
                })
                .map_err(|error| error.to_string())?;
            if target > 0 {
                return Err(format!(
                    "target_exists: {}/{session} already has runner {} in {table}",
                    request.harness, request.to
                ));
            }
            source_rows += count;
            *rows_per_table.get_mut(table).expect("discovered table") += count;
        }
        if source_rows == 0 {
            return Err(format!(
                "session_unknown: {}/{session} has no rows for {}",
                request.harness, request.from
            ));
        }
    }
    if !request.dry_run {
        for session in &sessions {
            for table in &tables {
                tx.execute(
                    &format!(
                        "UPDATE {} SET runner=?1 WHERE runner=?2 AND harness=?3 AND session=?4",
                        quoted(table)
                    ),
                    params![request.to, request.from, request.harness, session],
                )
                .map_err(|error| error.to_string())?;
            }
        }
        tx.commit().map_err(|error| error.to_string())?;
    } else {
        tx.rollback().map_err(|error| error.to_string())?;
    }
    Ok(Summary {
        from: request.from.clone(),
        to: request.to.clone(),
        harness: request.harness.clone(),
        sessions_rekeyed: sessions.len(),
        sessions,
        rows_per_table,
        dry_run: request.dry_run,
    })
}

#[cfg(test)]
mod tests;
