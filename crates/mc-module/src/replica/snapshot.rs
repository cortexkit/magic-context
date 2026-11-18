//! A row's replicated state as a message snapshot, and back.
//!
//! The snapshot holds each replicated column by name ([`super::schema`]).
//! Columns that name another memory carry that memory's global id instead
//! of its local one: `merged_from` (a list), `superseded_by_memory_id` and
//! `overrides_memory_id`. A memory's snapshot also carries the rows of its
//! child tables: `files` (its file mappings), `supersedes` (the memories it
//! replaced) and `conflicts` (the memories it contradicts, where it is the
//! newer end). `metadata_json` travels as an object without the keys that
//! name this computer's state ([`LOCAL_METADATA_KEYS`]).

use rusqlite::types::Value as Sql;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};

use super::schema::{Table, MEMORIES};

/// Keys writers put in a memory's `metadata_json` that name this computer's
/// state. They are left out of a snapshot, and an arrival keeps this
/// computer's own values for them. Every other key travels:
/// - `archive_reason`, `promoted_at`, `identity_merge_original_hash`, the
///   verify task's `dreamerVerifiedAt`, `dreamerVerifiedCommit`,
///   `dreamerCheckedAt` and `dreamerVerifiedSpans` (a confirmation's cited
///   lines, by project-relative path), and the reflect task's `source`.
pub(crate) const LOCAL_METADATA_KEYS: [&str; 6] = [
    // The id the row had in the user-memory table migration 106 removed.
    "user_memory_id",
    // Ids of observations or primer candidates on this computer.
    "source_candidate_ids",
    // The sessions and message ordinals the memory came from.
    "source_candidate_provenance",
    // The 0.49 identity key (a project path) a legacy merge came from.
    "identity_merge_review",
    // The reflect task's run id and the event ids it rests on.
    "run",
    "events",
];

/// Memory columns whose value is another memory's local id.
pub(crate) const LINK_COLUMNS: [&str; 2] = ["superseded_by_memory_id", "overrides_memory_id"];

/// A row's replicated columns, read as JSON values.
pub(crate) fn columns(
    conn: &Connection,
    table: &Table,
    id: i64,
) -> rusqlite::Result<Option<Map<String, Value>>> {
    let sql = format!(
        "SELECT {} FROM {} WHERE id = ?1",
        table.replicated.join(", "),
        table.name
    );
    conn.query_row(&sql, [id], |row| {
        let mut map = Map::new();
        for (index, column) in table.replicated.iter().enumerate() {
            map.insert((*column).to_owned(), to_json(row.get::<_, Sql>(index)?));
        }
        Ok(map)
    })
    .optional()
}

fn to_json(value: Sql) -> Value {
    match value {
        Sql::Null => Value::Null,
        Sql::Integer(number) => json!(number),
        Sql::Real(number) => json!(number),
        Sql::Text(text) => Value::String(text),
        Sql::Blob(bytes) => Value::String(super::wire::encode(&bytes)),
    }
}

/// A snapshot value as SQL, for a column that holds a plain value.
pub(crate) fn to_sql(value: &Value) -> Sql {
    match value {
        Value::Null => Sql::Null,
        Value::Bool(flag) => Sql::Integer(i64::from(*flag)),
        Value::Number(number) => match number.as_i64() {
            Some(integer) => Sql::Integer(integer),
            None => Sql::Real(number.as_f64().unwrap_or_default()),
        },
        Value::String(text) => Sql::Text(text.clone()),
        other => Sql::Text(other.to_string()),
    }
}

/// `metadata` without this computer's keys, as the object a snapshot
/// carries. Text that isn't a JSON object travels as it is.
pub(crate) fn shared_metadata(metadata: &Value) -> Value {
    let Some(text) = metadata.as_str() else {
        return Value::Null;
    };
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(mut object)) => {
            for key in LOCAL_METADATA_KEYS {
                object.remove(key);
            }
            Value::Object(object)
        }
        _ => Value::String(text.to_owned()),
    }
}

/// The metadata an arrival leaves on a row: the arriving keys, plus this
/// computer's own values for its local keys.
pub(crate) fn merged_metadata(arriving: &Value, local: Option<&str>) -> Option<String> {
    let mut merged = match arriving {
        Value::Object(object) => object.clone(),
        Value::String(text) => return Some(text.clone()),
        _ => Map::new(),
    };
    let local: Map<String, Value> = local
        .and_then(|text| serde_json::from_str(text).ok())
        .unwrap_or_default();
    for key in LOCAL_METADATA_KEYS {
        match local.get(key) {
            Some(value) => {
                merged.insert(key.to_owned(), value.clone());
            }
            None => {
                merged.remove(key);
            }
        }
    }
    if merged.is_empty() && arriving.is_null() {
        return None;
    }
    Some(Value::Object(merged).to_string())
}

/// The global id of local memory `id`, for a link that names it: the id it
/// was sent or arrived under, or, for a row never sent, the id it gets
/// (`<box id>.<local id>`), with the row queued so the id it is named by
/// reaches the other computers too. `None` for a memory that doesn't exist
/// or doesn't replicate.
pub(crate) fn link_target(
    conn: &Connection,
    box_id: &str,
    id: i64,
) -> rusqlite::Result<Option<String>> {
    let found: Option<(Option<String>, String, i64)> = conn
        .query_row(
            "SELECT global_id, level, revision FROM memories WHERE id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((global, level, revision)) = found else {
        return Ok(None);
    };
    if level == "agent" {
        return Ok(None);
    }
    if let Some(global) = global {
        return Ok(Some(global));
    }
    let global = super::wire::global_id(box_id, MEMORIES.kind, id);
    assign(conn, MEMORIES.kind, id, &global)?;
    conn.execute(
        "INSERT OR IGNORE INTO replica_outbox
             (kind, local_id, revision, base_revision, change, created_at, actor)
         VALUES ('memory', ?1, ?2, 0, 'create', ?3, 'ck-mc')",
        params![id, revision, crate::memory_writes::now_ms()],
    )?;
    Ok(Some(global))
}

/// Give local row `id` the global id it is sent under. The column is not
/// replicated, so no capture trigger fires.
pub(crate) fn assign(conn: &Connection, kind: &str, id: i64, global: &str) -> rusqlite::Result<()> {
    let table = super::table(kind);
    conn.execute(
        &format!(
            "UPDATE {} SET global_id = ?2 WHERE id = ?1 AND global_id IS NULL",
            table.name
        ),
        params![id, global],
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO replica_ids (kind, global_id, local_id) VALUES (?1, ?2, ?3)",
        params![kind, global, id],
    )?;
    Ok(())
}

/// The snapshot of local row `id` of `kind`, as it is now. `None` when the
/// row is gone.
pub(crate) fn read(
    conn: &Connection,
    kind: &str,
    box_id: &str,
    id: i64,
) -> rusqlite::Result<Option<Map<String, Value>>> {
    let table = super::table(kind);
    let Some(mut snapshot) = columns(conn, table, id)? else {
        return Ok(None);
    };
    if kind != MEMORIES.kind {
        return Ok(Some(snapshot));
    }
    for column in LINK_COLUMNS {
        let target = match snapshot[column].as_i64() {
            Some(target) => link_target(conn, box_id, target)?,
            None => None,
        };
        snapshot.insert(column.to_owned(), json!(target));
    }
    let merged = snapshot["merged_from"].as_str().map(str::to_owned);
    let merged = match merged {
        None => Value::Null,
        Some(text) => {
            let ids: Vec<i64> = serde_json::from_str::<Vec<Value>>(&text)
                .unwrap_or_default()
                .iter()
                .filter_map(Value::as_i64)
                .collect();
            let mut globals = Vec::new();
            for source in ids {
                if let Some(global) = link_target(conn, box_id, source)? {
                    globals.push(Value::String(global));
                }
            }
            Value::Array(globals)
        }
    };
    snapshot.insert("merged_from".into(), merged);
    let metadata = shared_metadata(&snapshot["metadata_json"]);
    snapshot.insert("metadata_json".into(), metadata);

    let mut files = Vec::new();
    let mut statement = conn.prepare_cached(
        "SELECT file_path, verified_at, mapped_at, mapping_origin FROM memory_verifications
          WHERE memory_id = ?1 ORDER BY file_path",
    )?;
    let rows = statement.query_map([id], |row| {
        Ok(json!({
            "file_path": row.get::<_, String>(0)?,
            "verified_at": row.get::<_, i64>(1)?,
            "mapped_at": row.get::<_, i64>(2)?,
            "mapping_origin": row.get::<_, String>(3)?,
        }))
    })?;
    for row in rows {
        files.push(row?);
    }
    snapshot.insert("files".into(), Value::Array(files));

    for (key, sql, end) in [
        (
            "supersedes",
            "SELECT source_id, decision_key FROM memory_successor_links
              WHERE successor_id = ?1 ORDER BY source_id",
            "source",
        ),
        (
            "conflicts",
            "SELECT left_id, decision_key FROM memory_conflict_links
              WHERE right_id = ?1 ORDER BY left_id",
            "other",
        ),
    ] {
        let links: Vec<(i64, String)> = conn
            .prepare_cached(sql)?
            .query_map([id], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let mut carried = Vec::new();
        for (other, decision_key) in links {
            if let Some(global) = link_target(conn, box_id, other)? {
                carried.push(json!({end: global, "decision_key": decision_key}));
            }
        }
        snapshot.insert(key.to_owned(), Value::Array(carried));
    }
    Ok(Some(snapshot))
}
