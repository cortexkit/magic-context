//! Project-keyed tables of `context.db`, read and changed row by row: which
//! tables there are, the key each row is logged under, and re-keying or
//! copying one row with the 0.49 merge's collision rule.

use std::collections::BTreeSet;

use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};

/// The columns that key a row by project. `project_path` and
/// `project_identity` are the ones the 0.49 merge re-keyed; `project_id` is
/// the module's own (`memory_observations`). `memories` is keyed by `level`
/// and `owner_id` and is handled on its own (see the `memories` module).
pub(super) const PROJECT_COLUMNS: &[&str] = &["project_path", "project_identity", "project_id"];

/// Full-text tables, their shadow tables and their rowid maps mirror another
/// table through triggers, so they follow when that table changes.
const DERIVED_SUFFIXES: &[&str] = &[
    "_fts",
    "_fts_data",
    "_fts_idx",
    "_fts_content",
    "_fts_docsize",
    "_fts_config",
    "_fts_rowid_map",
];

/// Project-keyed tables whose rows hang off a row of another project-keyed
/// table through a foreign key that cascades on update and delete. They
/// are never handled on their own: re-keying the parent re-keys them, a
/// parent deleted on a collision takes them along, and a copied parent
/// copies them (`pool::copy_step`). Handled alone, a child re-keyed before
/// its parent would name a parent that doesn't exist yet.
const FOLLOW_THEIR_PARENT: &[&str] = &["git_commit_embeddings"];

/// Project-keyed tables whose rows never move. A rescore snapshot is
/// immutable: a trigger refuses any change to its project. Released 0.49
/// stores have none; only development builds wrote them.
const NEVER_MOVED: &[&str] = &["rescore_snapshots"];

/// When a re-keyed row collides with the target's own row, the target keeps
/// its row and takes the larger of these progress columns, as the 0.49
/// merge did. Columns a table no longer has are skipped.
const MAXIMUM_COLUMNS: &[(&str, &[&str])] = &[
    ("retrospective_processed_windows", &["processed_at"]),
    ("embedding_identity_active", &["last_active_at"]),
    (
        "memory_embedding_watermarks",
        &["written_memory_id", "embedded_memory_id", "updated_at"],
    ),
    (
        "project_state",
        &[
            "project_memory_epoch",
            "project_user_profile_version",
            "updated_at",
        ],
    ),
    ("project_key_files_version", &["version"]),
];

pub(super) fn quoted(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// The SQL that picks the 0.49 legacy keys out of a project column: the
/// `git:` and `dir:` forms, as index ranges (`;` follows `:`).
pub(super) fn legacy_range(column: &str) -> String {
    let column = quoted(column);
    format!(
        "(({column} >= 'git:' AND {column} < 'git;') OR ({column} >= 'dir:' AND {column} < 'dir;'))"
    )
}

/// One project-keyed table.
#[derive(Debug, Clone)]
pub(super) struct Table {
    pub name: String,
    /// The column that names the project.
    pub column: String,
    pub columns: Vec<String>,
    /// Primary-key columns in key order; empty when the table has only a
    /// rowid.
    pub keys: Vec<String>,
    /// The primary key is the rowid itself, which a copy leaves to SQLite.
    pub rowid_key: bool,
    /// Full (not partial, not expression) unique indexes that include
    /// `column`: the ones a re-key can collide on.
    pub unique: Vec<Vec<String>>,
}

impl Table {
    pub(super) fn has(&self, column: &str) -> bool {
        self.columns.iter().any(|known| known == column)
    }
}

/// Every table with a project column, by name, without the derived,
/// never-moved and parent-following ones.
pub(super) fn discover(conn: &Connection) -> rusqlite::Result<Vec<Table>> {
    let candidates: Vec<(String, Option<String>)> = conn
        .prepare(
            "SELECT name, sql FROM sqlite_master
              WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut tables = Vec::new();
    for (name, sql) in candidates {
        let derived = sql
            .as_deref()
            .is_some_and(|sql| sql.to_uppercase().contains("VIRTUAL TABLE"))
            || DERIVED_SUFFIXES.iter().any(|suffix| name.ends_with(suffix));
        if derived
            || NEVER_MOVED.contains(&name.as_str())
            || FOLLOW_THEIR_PARENT.contains(&name.as_str())
        {
            continue;
        }
        let columns = column_names(conn, &name)?;
        let Some(column) = PROJECT_COLUMNS
            .iter()
            .find(|candidate| columns.iter().any(|known| known == *candidate))
        else {
            continue;
        };
        tables.push(shape(conn, &name, column, sql.as_deref())?);
    }
    Ok(tables)
}

fn column_names(conn: &Connection, table: &str) -> rusqlite::Result<Vec<String>> {
    conn.prepare(&format!("PRAGMA table_info({})", quoted(table)))?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect()
}

pub(super) fn shape(
    conn: &Connection,
    name: &str,
    column: &str,
    sql: Option<&str>,
) -> rusqlite::Result<Table> {
    let mut info: Vec<(String, String, i64)> = conn
        .prepare(&format!("PRAGMA table_info({})", quoted(name)))?
        .query_map([], |row| Ok((row.get(1)?, row.get(2)?, row.get(5)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let columns = info.iter().map(|(name, _, _)| name.clone()).collect();
    info.retain(|(_, _, pk)| *pk > 0);
    info.sort_by_key(|(_, _, pk)| *pk);
    let without_rowid = sql.is_some_and(|sql| sql.to_uppercase().contains("WITHOUT ROWID"));
    let rowid_key = !without_rowid && info.len() == 1 && info[0].1.eq_ignore_ascii_case("INTEGER");
    let keys = info.into_iter().map(|(name, _, _)| name).collect();
    let indexes: Vec<(String, bool, bool)> = conn
        .prepare(&format!("PRAGMA index_list({})", quoted(name)))?
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)? == 1,
                row.get::<_, i64>(4)? == 1,
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut unique = Vec::new();
    for (index, is_unique, partial) in indexes {
        // A partial index holds only some rows, so a lookup on its columns
        // alone could report a collision that isn't one and delete a row.
        // None of the project-keyed tables has one.
        if !is_unique || partial {
            continue;
        }
        let members: Vec<Option<String>> = conn
            .prepare(&format!("PRAGMA index_info({})", quoted(&index)))?
            .query_map([], |row| row.get(2))?
            .collect::<rusqlite::Result<_>>()?;
        // An expression index can't be matched column by column.
        let Some(members) = members.into_iter().collect::<Option<Vec<String>>>() else {
            continue;
        };
        if members.iter().any(|member| member == column) && !unique.contains(&members) {
            unique.push(members);
        }
    }
    Ok(Table {
        name: name.to_owned(),
        column: column.to_owned(),
        columns,
        keys,
        rowid_key,
        unique,
    })
}

/// One row, column by column.
#[derive(Debug, Clone, Default)]
pub(super) struct Row(pub Vec<(String, Value)>);

impl Row {
    pub(super) fn get(&self, column: &str) -> &Value {
        self.0
            .iter()
            .find(|(name, _)| name == column)
            .map_or(&Value::Null, |(_, value)| value)
    }

    pub(super) fn int(&self, column: &str) -> Option<i64> {
        match self.get(column) {
            Value::Integer(value) => Some(*value),
            Value::Real(value) => Some(*value as i64),
            _ => None,
        }
    }

    pub(super) fn text(&self, column: &str) -> Option<&str> {
        match self.get(column) {
            Value::Text(value) => Some(value),
            _ => None,
        }
    }

    pub(super) fn set(&mut self, column: &str, value: Value) {
        match self.0.iter_mut().find(|(name, _)| name == column) {
            Some(slot) => slot.1 = value,
            None => self.0.push((column.to_owned(), value)),
        }
    }
}

fn read_row(row: &rusqlite::Row, names: &[String]) -> rusqlite::Result<Row> {
    names
        .iter()
        .enumerate()
        .map(|(index, name)| Ok((name.clone(), row.get::<_, Value>(index)?)))
        .collect::<rusqlite::Result<_>>()
        .map(Row)
}

/// The rows of `table` matching `filter`, a SQL condition over `params`.
/// A table keyed only by its rowid also gets a `rowid` column. Statements
/// are cached: a pool runs the same few thousands of times.
pub(super) fn rows(
    conn: &Connection,
    table: &Table,
    filter: &str,
    params: &[Value],
) -> rusqlite::Result<Vec<Row>> {
    let rowid = if table.keys.is_empty() { "rowid, " } else { "" };
    let mut statement = conn.prepare_cached(&format!(
        "SELECT {rowid}* FROM {} WHERE {filter}",
        quoted(&table.name)
    ))?;
    let names: Vec<String> = statement
        .column_names()
        .into_iter()
        .map(str::to_owned)
        .collect();
    let found = statement
        .query_map(params_from_iter(params.iter()), |row| read_row(row, &names))?
        .collect();
    found
}

/// Run one statement through the connection's statement cache.
pub(super) fn run(
    conn: &Connection,
    sql: &str,
    params: impl rusqlite::Params,
) -> rusqlite::Result<usize> {
    conn.prepare_cached(sql)?.execute(params)
}

/// The next `limit` rows of `table` keyed `from` that `filter` selects, in
/// rowid order.
pub(super) fn batch(
    conn: &Connection,
    table: &Table,
    filter: &str,
    from: &str,
    limit: usize,
) -> rusqlite::Result<Vec<Row>> {
    rows(
        conn,
        table,
        &format!(
            "{} = ? AND ({filter}) ORDER BY rowid LIMIT ?",
            quoted(&table.column)
        ),
        &[Value::Text(from.to_owned()), Value::Integer(limit as i64)],
    )
}

fn value_text(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Integer(value) => value.to_string(),
        Value::Real(value) => value.to_string(),
        Value::Text(value) => value.clone(),
        Value::Blob(bytes) => bytes.iter().map(|byte| format!("{byte:02x}")).collect(),
    }
}

fn value_json(value: &Value) -> serde_json::Value {
    match value {
        Value::Null => serde_json::Value::Null,
        Value::Integer(value) => serde_json::Value::from(*value),
        Value::Real(value) => serde_json::Value::from(*value),
        _ => serde_json::Value::String(value_text(value)),
    }
}

/// The key a row is logged under, as the 0.49 merge wrote it: a single key
/// column's value, several as a JSON array, or the rowid.
pub(super) fn row_key(table: &Table, row: &Row) -> String {
    match table.keys.as_slice() {
        [] => value_text(row.get("rowid")),
        [key] => value_text(row.get(key)),
        keys => serde_json::Value::Array(keys.iter().map(|key| value_json(row.get(key))).collect())
            .to_string(),
    }
}

/// `WHERE` text and values that select exactly `row`.
fn predicate(table: &Table, row: &Row) -> (String, Vec<Value>) {
    if table.keys.is_empty() {
        return ("rowid = ?".to_owned(), vec![row.get("rowid").clone()]);
    }
    (
        table
            .keys
            .iter()
            .map(|key| format!("{} = ?", quoted(key)))
            .collect::<Vec<_>>()
            .join(" AND "),
        table.keys.iter().map(|key| row.get(key).clone()).collect(),
    )
}

/// One row of `identity_merge_log`. `action` is `rekeyed`,
/// `collision_deleted` or `superseded` (as the 0.49 merge wrote them), or
/// `copied` or `copy_merged` for a copy into a second project.
#[allow(clippy::too_many_arguments)]
pub(super) fn log(
    conn: &Connection,
    from: &str,
    to: &str,
    table: &str,
    row_id: &str,
    action: &str,
    target_row_id: Option<&str>,
    now: i64,
) -> rusqlite::Result<()> {
    run(
        conn,
        "INSERT INTO identity_merge_log
             (from_identity, to_identity, table_name, row_id, action, target_row_id, merged_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![from, to, table, row_id, action, target_row_id, now],
    )?;
    Ok(())
}

/// The row of `to` that `row` would collide with once it names `to`: one
/// with the same values in a unique index that includes the project column.
fn collision(
    conn: &Connection,
    table: &Table,
    row: &Row,
    to: &str,
) -> rusqlite::Result<Option<Row>> {
    for columns in &table.unique {
        let filter = columns
            .iter()
            .map(|column| format!("{} = ?", quoted(column)))
            .collect::<Vec<_>>()
            .join(" AND ");
        let values: Vec<Value> = columns
            .iter()
            .map(|column| {
                if *column == table.column {
                    Value::Text(to.to_owned())
                } else {
                    row.get(column).clone()
                }
            })
            .collect();
        let found = rows(conn, table, &format!("{filter} LIMIT 1"), &values)?;
        if let Some(found) = found.into_iter().next() {
            if row_key(table, &found) != row_key(table, row) {
                return Ok(Some(found));
            }
        }
    }
    Ok(None)
}

/// On a collision the target keeps its row and takes the larger progress
/// values the source row had ([`MAXIMUM_COLUMNS`]).
fn keep_maximums(
    conn: &Connection,
    table: &Table,
    source: &Row,
    target: &Row,
) -> rusqlite::Result<()> {
    let Some((_, columns)) = MAXIMUM_COLUMNS.iter().find(|(name, _)| *name == table.name) else {
        return Ok(());
    };
    let columns: Vec<&str> = columns
        .iter()
        .copied()
        .filter(|column| table.has(column))
        .collect();
    if columns.is_empty() {
        return Ok(());
    }
    let (filter, mut values) = predicate(table, target);
    let mut assigned: Vec<Value> = columns
        .iter()
        .map(|column| match (source.int(column), target.int(column)) {
            (Some(left), Some(right)) => Value::Integer(left.max(right)),
            (Some(value), None) | (None, Some(value)) => Value::Integer(value),
            (None, None) => Value::Null,
        })
        .collect();
    assigned.append(&mut values);
    run(
        conn,
        &format!(
            "UPDATE {} SET {} WHERE {filter}",
            quoted(&table.name),
            columns
                .iter()
                .map(|column| format!("{} = ?", quoted(column)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        params_from_iter(assigned),
    )?;
    Ok(())
}

/// Re-key one row of `table` from `from` to `to`, the 0.49 merge's
/// `rekeyGenericRow`: a row that would collide with one `to` already has is
/// deleted after the target takes its progress values; any other row is
/// re-keyed. Either way the row no longer names `from`.
pub(super) fn move_row(
    conn: &Connection,
    table: &Table,
    row: &Row,
    from: &str,
    to: &str,
    now: i64,
) -> rusqlite::Result<()> {
    let name = quoted(&table.name);
    let column = quoted(&table.column);
    let key = row_key(table, row);
    let (selected, values) = predicate(table, row);
    if let Some(target) = collision(conn, table, row, to)? {
        keep_maximums(conn, table, row, &target)?;
        run(
            conn,
            &format!("DELETE FROM {name} WHERE {selected}"),
            params_from_iter(values),
        )?;
        log(
            conn,
            from,
            to,
            &table.name,
            &key,
            "collision_deleted",
            Some(&row_key(table, &target)),
            now,
        )
    } else {
        let mut bound = vec![Value::Text(to.to_owned())];
        bound.extend(values);
        bound.push(Value::Text(from.to_owned()));
        run(
            conn,
            &format!("UPDATE {name} SET {column} = ? WHERE {selected} AND {column} = ?"),
            params_from_iter(bound),
        )?;
        log(conn, from, to, &table.name, &key, "rekeyed", None, now)
    }
}

/// Insert a copy of `row` with `overrides` applied, and return the copy's
/// key. A table keyed by its rowid gets a new one.
pub(super) fn insert_copy(
    conn: &Connection,
    table: &Table,
    row: &Row,
    overrides: &[(&str, Value)],
) -> rusqlite::Result<String> {
    let mut copy = row.clone();
    for (column, value) in overrides {
        copy.set(column, value.clone());
    }
    let columns: Vec<&String> = table
        .columns
        .iter()
        .filter(|column| !(table.rowid_key && table.keys.first() == Some(*column)))
        .collect();
    run(
        conn,
        &format!(
            "INSERT INTO {} ({}) VALUES ({})",
            quoted(&table.name),
            columns
                .iter()
                .map(|column| quoted(column))
                .collect::<Vec<_>>()
                .join(", "),
            vec!["?"; columns.len()].join(", ")
        ),
        params_from_iter(columns.iter().map(|column| copy.get(column).clone())),
    )?;
    if table.rowid_key {
        Ok(conn.last_insert_rowid().to_string())
    } else {
        Ok(row_key(table, &copy))
    }
}

/// Copy one row of `table` keyed `from` to `to`, with `overrides` applied
/// besides its project. A copy that would collide with a row `to` already
/// has is not made; the target row takes the copy's progress values
/// instead (`copy_merged`).
pub(super) fn copy_row<'a>(
    conn: &Connection,
    table: &'a Table,
    row: &Row,
    from: &str,
    to: &str,
    now: i64,
    mut overrides: Vec<(&'a str, Value)>,
) -> rusqlite::Result<()> {
    let key = row_key(table, row);
    overrides.push((table.column.as_str(), Value::Text(to.to_owned())));
    let mut planned = row.clone();
    for (name, value) in &overrides {
        planned.set(name, value.clone());
    }
    if let Some(target) = collision(conn, table, &planned, to)? {
        keep_maximums(conn, table, &planned, &target)?;
        log(
            conn,
            from,
            to,
            &table.name,
            &key,
            "copy_merged",
            Some(&row_key(table, &target)),
            now,
        )
    } else {
        let copied = insert_copy(conn, table, row, &overrides)?;
        log(
            conn,
            from,
            to,
            &table.name,
            &key,
            "copied",
            Some(&copied),
            now,
        )
    }
}

/// Every 0.49 legacy key that still has rows in a table this move handles.
pub(crate) fn keys_with_rows(conn: &Connection) -> rusqlite::Result<BTreeSet<String>> {
    let mut keys: BTreeSet<String> = conn
        .prepare(&format!(
            "SELECT DISTINCT owner_id FROM memories WHERE level = 'project' AND {}",
            legacy_range("owner_id")
        ))?
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for table in discover(conn)? {
        let found: Vec<String> = conn
            .prepare(&format!(
                "SELECT DISTINCT {column} FROM {name} WHERE {range}",
                column = quoted(&table.column),
                name = quoted(&table.name),
                range = legacy_range(&table.column)
            ))?
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        keys.extend(found);
    }
    Ok(keys)
}

/// Whether a table exists.
pub(super) fn table_exists(conn: &Connection, name: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [name],
        |_| Ok(()),
    )
    .optional()
    .map(|found| found.is_some())
}
