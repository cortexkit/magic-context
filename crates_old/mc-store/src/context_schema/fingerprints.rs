//! Schema-only fingerprints include virtual/shadow tables, constraints, and migration identities.

use rusqlite::{types::ValueRef, Connection, Params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::OnceLock};

fn definition() -> &'static Value {
    static DEFINITION: OnceLock<Value> = OnceLock::new();
    DEFINITION.get_or_init(|| {
        serde_json::from_str(include_str!(
        "../../../../packages/plugin/src/features/magic-context/schema-fingerprint-definition.json"
    ))
        .expect("shared fingerprint definition")
    })
}

fn query(key: &str) -> &'static str {
    definition()[key].as_str().expect("fingerprint query")
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TableSnapshot {
    pub name: String,
    pub columns: Vec<Vec<Value>>,
    pub indexes: Vec<Vec<Value>>,
    pub foreign_keys: Vec<Vec<Value>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SchemaSnapshot {
    pub user_version: i64,
    pub migrations: Vec<Vec<Value>>,
    pub master: Vec<Vec<Value>>,
    pub tables: Vec<TableSnapshot>,
}

/// Normalize formatting and sort only outer table declarations, never nested expressions.
pub fn canonical_schema_sql(sql: &str, table: bool) -> String {
    let mut result = String::new();
    let mut chars = sql.chars().peekable();
    let mut quote = None;
    let mut space = false;
    let mut depth = 0;
    let mut prefix = String::new();
    let mut suffix = String::new();
    let mut parts = Vec::new();
    while let Some(ch) = chars.next() {
        if let Some(end) = quote {
            result.push(ch);
            if ch == end {
                if end != ']' && chars.peek() == Some(&end) {
                    result.push(chars.next().expect("peeked character"));
                } else {
                    quote = None;
                }
            }
        } else if ch.is_whitespace() {
            space = true;
        } else if ch == '-' && chars.peek() == Some(&'-') {
            for next in chars.by_ref() {
                if next == '\n' {
                    break;
                }
            }
            space = true;
        } else if ch == '/' && chars.peek() == Some(&'*') {
            chars.next();
            while let Some(next) = chars.next() {
                if next == '*' && chars.peek() == Some(&'/') {
                    chars.next();
                    break;
                }
            }
            space = true;
        } else {
            if space && !result.is_empty() && !result.ends_with(['(', ',']) && !"(),".contains(ch) {
                result.push(' ');
            }
            space = false;
            if table && ch == '(' {
                if depth == 0 {
                    prefix = format!("{result}(");
                    result.clear();
                    depth += 1;
                    continue;
                }
                depth += 1;
            } else if table && ch == ')' {
                depth -= 1;
                if depth == 0 {
                    parts.push(std::mem::take(&mut result));
                    suffix = ")".into();
                    continue;
                }
            } else if table && ch == ',' && depth == 1 {
                parts.push(std::mem::take(&mut result));
                continue;
            }
            result.push(ch);
            quote = match ch {
                '\'' | '"' | '`' => Some(ch),
                '[' => Some(']'),
                _ => None,
            };
        }
    }
    if prefix.is_empty() {
        result
    } else {
        parts.sort();
        format!(
            "{prefix}{}{suffix}{}",
            parts.join(","),
            if result.is_empty() {
                result
            } else {
                format!(" {result}")
            }
        )
    }
}

fn rows(
    connection: &Connection,
    sql: &str,
    params: impl Params,
) -> rusqlite::Result<Vec<Vec<Value>>> {
    let mut statement = connection.prepare(sql)?;
    let rows = statement.query_map(params, |row| {
        (0..row.as_ref().column_count())
            .map(|column| {
                Ok(match row.get_ref(column)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(value) => Value::from(value),
                    ValueRef::Real(value) => Value::from(value),
                    ValueRef::Text(value) => Value::from(String::from_utf8_lossy(value).as_ref()),
                    ValueRef::Blob(_) => return Err(rusqlite::Error::InvalidQuery),
                })
            })
            .collect()
    })?;
    rows.collect()
}

pub fn schema_snapshot(connection: &Connection) -> rusqlite::Result<SchemaSnapshot> {
    let mut master = rows(connection, query("master"), [])?;
    let mut tables = Vec::new();
    for object in &mut master {
        if let Some(sql) = object[3].as_str() {
            object[3] = Value::from(canonical_schema_sql(sql, object[0] == "table"));
        }
        if object[0] != "table" {
            continue;
        }
        let name = object[1].as_str().ok_or(rusqlite::Error::InvalidQuery)?;
        tables.push(table_snapshot(connection, name)?);
    }
    canonicalize_master(connection, &mut master, &tables)?;
    Ok(SchemaSnapshot {
        user_version: connection.query_row("PRAGMA user_version", [], |row| row.get(0))?,
        // Exclude applied_at because migration application times differ on every run.
        migrations: rows(connection, query("migrations"), [])?,
        master,
        tables,
    })
}

fn table_snapshot(connection: &Connection, name: &str) -> rusqlite::Result<TableSnapshot> {
    let mut indexes = rows(connection, query("indexes"), [name])?;
    for index in &mut indexes {
        let name = index[0].as_str().ok_or(rusqlite::Error::InvalidQuery)?;
        let columns = rows(connection, query("index_columns"), [name])?;
        if index[2] != "c" {
            index[0] = Value::from(format!(
                "{}:{}",
                index[2].as_str().unwrap_or_default(),
                serde_json::to_string(&columns).expect("index columns serialize")
            ));
        }
        index.push(serde_json::to_value(columns).expect("index columns serialize"));
    }
    indexes.sort_by(|a, b| a[0].as_str().cmp(&b[0].as_str()));
    let mut foreign_keys: BTreeMap<i64, Vec<Value>> = BTreeMap::new();
    for mut key in rows(connection, query("foreign_keys"), [name])? {
        let id = key
            .remove(0)
            .as_i64()
            .ok_or(rusqlite::Error::InvalidQuery)?;
        foreign_keys.entry(id).or_default().push(Value::Array(key));
    }
    let mut foreign_keys: Vec<Vec<Value>> = foreign_keys.into_values().collect();
    foreign_keys
        .sort_by_cached_key(|key| serde_json::to_string(key).expect("foreign key serializes"));
    Ok(TableSnapshot {
        name: name.to_owned(),
        columns: rows(connection, query("columns"), [name])?,
        indexes,
        foreign_keys,
    })
}

fn canonicalize_master(
    connection: &Connection,
    master: &mut [Vec<Value>],
    tables: &[TableSnapshot],
) -> rusqlite::Result<()> {
    for object in master
        .iter_mut()
        .filter(|object| object[0] == "index" && object[3].is_null())
    {
        if let Some(table) = tables.iter().find(|table| object[2] == table.name) {
            // SQLite numbers implicit indexes by declaration order. Match the
            // physical name to its semantic identity before discarding that order.
            let columns = serde_json::to_value(rows(
                connection,
                query("index_columns"),
                [object[1].as_str().ok_or(rusqlite::Error::InvalidQuery)?],
            )?)
            .expect("index columns serialize");
            if let Some(index) = table
                .indexes
                .iter()
                .find(|index| index[2] != "c" && index[4] == columns)
            {
                object[1] = index[0].clone();
            }
        }
    }
    master.sort_by(|a, b| {
        a[0].as_str()
            .cmp(&b[0].as_str())
            .then(a[1].as_str().cmp(&b[1].as_str()))
            .then(a[2].as_str().cmp(&b[2].as_str()))
    });
    Ok(())
}

/// Describe columns keyed by name, declarations, indexes, triggers and foreign keys
/// for the runtime write fence, without including unrelated tables or the ledger.
pub fn table_schema_description(
    connection: &Connection,
    name: &str,
) -> rusqlite::Result<Option<String>> {
    let mut master = rows(connection, "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name = ?1 ORDER BY type, name", [name])?;
    if !master.iter().any(|row| row[0] == "table") {
        return Ok(None);
    }
    for row in &mut master {
        if let Some(sql) = row[3].as_str() {
            row[3] = Value::from(canonical_schema_sql(sql, row[0] == "table"));
        }
    }
    let table = table_snapshot(connection, name)?;
    canonicalize_master(connection, &mut master, std::slice::from_ref(&table))?;
    let mut value = serde_json::json!({"master": master, "table": table});
    value.sort_all_objects();
    Ok(Some(
        serde_json::to_string(&value).expect("table schema serializes"),
    ))
}

/// Serialize through a JSON value so object keys have canonical ordering.
pub fn fingerprint(snapshot: &SchemaSnapshot) -> String {
    let mut canonical =
        serde_json::to_value(snapshot).expect("schema snapshot is JSON serializable");
    canonical.sort_all_objects();
    let encoded = serde_json::to_vec(&canonical).expect("schema JSON is serializable");
    format!("{:x}", Sha256::digest(encoded))
}
