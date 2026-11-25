use std::fmt::Write;
use std::path::Path;
use std::time::{Duration, Instant};

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};

use crate::search;

pub(super) fn open(path: &Path) -> Result<Connection, String> {
    let path = path.to_str().ok_or("store path must be UTF-8")?;
    // An immutable SQLite backup needs no writable sidecars. Refuse a loose
    // copy with a write-ahead log rather than silently missing its rows.
    if Path::new(&format!("{path}-wal")).symlink_metadata().is_ok() {
        return Err("store has a WAL sidecar; supply a standalone SQLite backup".into());
    }
    let escaped = path
        .replace('%', "%25")
        .replace('?', "%3f")
        .replace('#', "%23");
    let conn = Connection::open_with_flags(
        format!("file:{escaped}?immutable=1"),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|e| format!("opening the frozen store read-only: {e}"))?;
    let version = crate::context_db::live_schema_version(&conn)
        .map_err(|e| format!("frozen store schema: {e}"))?;
    if version != i64::from(crate::context_db::SCHEMA_VERSION) {
        return Err(format!(
            "frozen store schema is {version}; this build reads {}",
            crate::context_db::SCHEMA_VERSION
        ));
    }
    Ok(conn)
}

pub(super) fn memories(conn: &Connection, project: &str, ids: &[i64]) -> Result<String, String> {
    let mut memory = conn
        .prepare(
            "SELECT category, created_at, source_type, importance, verified_at, content
           FROM memories WHERE id = ?1 AND level = 'project' AND owner_id = ?2",
        )
        .map_err(|e| format!("reading frozen memories: {e}"))?;
    let mut links = conn.prepare(
        "SELECT DISTINCT file_path FROM memory_verifications WHERE memory_id = ?1 ORDER BY file_path",
    ).map_err(|e| format!("reading frozen file links: {e}"))?;
    let mut text = String::new();
    for &id in ids {
        let row = memory
            .query_row(params![id, project], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })
            .optional()
            .map_err(|e| format!("reading memory {id}: {e}"))?;
        let (category, created, writer, importance, confirmed, content) = row.ok_or_else(|| {
            format!("the frozen store contains no memory {id} of project {project:?}")
        })?;
        let files = links
            .query_map([id], |row| row.get::<_, String>(0))
            .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>())
            .map_err(|e| format!("reading files for memory {id}: {e}"))?;
        let writer = match writer.as_deref() {
            Some("historian") => "summarizer",
            Some(writer) => writer,
            None => "unknown",
        };
        writeln!(text, "### Memory {id}\nCategory: {category}\nCreated: {}\nWriter: {writer}\nImportance: {}\nLast confirmed: {}\nLinked files: {}\n\n{content}\n",
            date(created), importance.map_or_else(|| "unset".into(), |n| n.to_string()),
            confirmed.map_or_else(|| "none".into(), date),
            if files.is_empty() { "none".into() } else { files.join(", ") },
        ).expect("a string is writable");
    }
    Ok(text)
}

fn date(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).map_or_else(|| ms.to_string(), |dt| dt.to_rfc3339())
}

pub(super) fn search(
    conn: &Connection,
    project: &str,
    history: &search::lab::History,
    input: Value,
    semantic: Option<search::sources::Semantic<'_>>,
) -> Result<String, String> {
    const SOURCES: [&str; 3] = ["memory", "message", "git_commit"];
    let mut input = input;
    let object = input
        .as_object_mut()
        .ok_or("memory_search expects an object")?;
    match object.get("sources") {
        None => {
            object.insert("sources".into(), json!(SOURCES));
        }
        Some(Value::Array(sources))
            if sources
                .iter()
                .all(|source| source.as_str().is_some_and(|s| SOURCES.contains(&s))) => {}
        _ => {
            return Err(
                "memory_search sources are memory, message (including summaries), and git_commit"
                    .into(),
            )
        }
    }
    history.search(conn, project, &input, semantic)
}

pub(super) const SEARCH_LIMIT: Duration = Duration::from_secs(20);
pub(super) const SEARCH_TIMED_OUT: &str = "memory_search timed out; narrow the query";

pub(super) fn search_with_limit<T>(
    conn: &Connection,
    limit: Duration,
    work: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    if limit.is_zero() {
        return Err(SEARCH_TIMED_OUT.into());
    }
    let deadline = Instant::now() + limit;
    conn.progress_handler(1000, Some(move || Instant::now() >= deadline));
    let answer = work(conn);
    conn.progress_handler(0, None::<fn() -> bool>);
    // Some of the memory and history searches skip a failing database read.
    // A deadline is a tool error even if the interrupted search returned no hits.
    if Instant::now() >= deadline {
        Err(SEARCH_TIMED_OUT.into())
    } else {
        answer
    }
}

#[cfg(test)]
#[test]
fn lab_search_interrupts_sql_and_keeps_the_connection_usable() {
    let conn = Connection::open_in_memory().unwrap();
    let result = search_with_limit(&conn, std::time::Duration::from_millis(5), |conn| {
        conn.query_row("WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM n WHERE x<4000000) SELECT sum(x) FROM n", [], |row| row.get::<_, i64>(0)).map_err(|e| e.to_string())
    });
    assert_eq!(
        result,
        Err("memory_search timed out; narrow the query".into())
    );
    let value = conn
        .query_row("SELECT 7", [], |row| row.get::<_, i64>(0))
        .unwrap();
    assert_eq!(value, 7);
}
