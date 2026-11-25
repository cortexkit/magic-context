use std::fmt::Write;
use std::path::Path;

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
