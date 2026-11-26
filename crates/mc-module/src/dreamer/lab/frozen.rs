use std::collections::{BTreeMap, HashMap};
use std::fmt::Write;
use std::path::Path;
use std::time::{Duration, Instant};

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};

use crate::search::lab::{Origin, Timeline};

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

pub(super) struct Memories {
    pub text: String,
    pub origins: BTreeMap<i64, Origin>,
}

pub(super) fn memories(conn: &Connection, project: &str, ids: &[i64]) -> Result<Memories, String> {
    let mut memory = conn
        .prepare(
            "SELECT category, created_at, source_type, importance, verified_at, content,
                    source_session_id, source_ordinals_json
           FROM memories WHERE id = ?1 AND level = 'project' AND owner_id = ?2",
        )
        .map_err(|e| format!("reading frozen memories: {e}"))?;
    let mut links = conn.prepare(
        "SELECT DISTINCT file_path FROM memory_verifications WHERE memory_id = ?1 ORDER BY file_path",
    ).map_err(|e| format!("reading frozen file links: {e}"))?;
    let mut text = String::new();
    let mut timelines = HashMap::new();
    let mut origins = BTreeMap::new();
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
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                ))
            })
            .optional()
            .map_err(|e| format!("reading memory {id}: {e}"))?;
        let (category, created, writer, importance, confirmed, content, session, ordinals) = row
            .ok_or_else(|| {
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
        writeln!(text, "### Memory {id}\nCategory: {category}\nCreated: {}\nWriter: {writer}\nImportance: {}\nLast confirmed: {}\nLinked files: {}",
            date(created), importance.map_or_else(|| "unset".into(), |n| n.to_string()),
            confirmed.map_or_else(|| "none".into(), date),
            if files.is_empty() { "none".into() } else { files.join(", ") },
        ).expect("a string is writable");
        if let Some(session) = session {
            let timeline = match timelines.entry(session) {
                std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
                std::collections::hash_map::Entry::Vacant(entry) => {
                    let timeline = Timeline::load(conn, project, entry.key())?;
                    entry.insert(timeline)
                }
            };
            let spans = ordinals
                .as_deref()
                .and_then(|json| serde_json::from_str::<Vec<(i64, i64)>>(json).ok())
                .unwrap_or_default();
            if let Some(origin) = timeline
                .as_ref()
                .and_then(|timeline| timeline.origin(&spans, created))
            {
                writeln!(text, "origin: {}", origin.label()).expect("a string is writable");
                origins.insert(id, origin);
            }
        }
        writeln!(text, "\n{content}\n").expect("a string is writable");
    }
    Ok(Memories { text, origins })
}

fn date(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).map_or_else(|| ms.to_string(), |dt| dt.to_rfc3339())
}

pub(super) const SEARCH_LIMIT: Duration = Duration::from_secs(20);

pub(super) fn search_with_limit<T>(
    conn: &Connection,
    limit: Duration,
    timed_out: &str,
    work: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    if limit.is_zero() {
        return Err(timed_out.into());
    }
    let deadline = Instant::now() + limit;
    conn.progress_handler(1000, Some(move || Instant::now() >= deadline));
    let answer = work(conn);
    conn.progress_handler(0, None::<fn() -> bool>);
    // Some of the memory and history searches skip a failing database read.
    // A deadline is a tool error even if the interrupted search returned no hits.
    if Instant::now() >= deadline {
        Err(timed_out.into())
    } else {
        answer
    }
}

#[cfg(test)]
#[test]
fn lab_search_interrupts_sql_and_keeps_the_connection_usable() {
    let conn = Connection::open_in_memory().unwrap();
    let result = search_with_limit(
        &conn,
        std::time::Duration::from_millis(5),
        "memory_search timed out; narrow the query",
        |conn| {
            conn.query_row("WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM n WHERE x<4000000) SELECT sum(x) FROM n", [], |row| row.get::<_, i64>(0)).map_err(|e| e.to_string())
        },
    );
    assert_eq!(
        result,
        Err("memory_search timed out; narrow the query".into())
    );
    let value = conn
        .query_row("SELECT 7", [], |row| row.get::<_, i64>(0))
        .unwrap();
    assert_eq!(value, 7);
}
