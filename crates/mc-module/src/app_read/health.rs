//! Store health without counting rows.

use std::sync::Mutex;
use std::time::Instant;

use rusqlite::OptionalExtension;
use serde_json::{json, Map, Value};
use subc_client_rs::HandlerOutcome;

use super::admission::AppCaller;
use super::{allow, named, prepare, row_reply, AppReadContext};

const OP: &str = "store.health";
const CACHE_MS: i64 = 30_000;

struct Cached {
    key: String,
    at_ms: i64,
    row: Value,
}

fn cache() -> &'static Mutex<Option<Cached>> {
    static CACHE: Mutex<Option<Cached>> = Mutex::new(None);
    &CACHE
}

pub fn read(
    caller: &AppCaller,
    ctx: &AppReadContext,
    params: &Map<String, Value>,
) -> HandlerOutcome {
    let _ = caller;
    if let Err(refusal) = allow(params, &[], "params") {
        return refusal;
    }
    let started = Instant::now();
    if ctx.expired(started) {
        return named(
            "read_budget_exceeded",
            "The health read exceeded its time budget.",
        );
    }
    let paths = match (ctx.context(database_path), ctx.store_db(database_path)) {
        (Ok(context_path), Ok(store_path)) => (context_path, store_path),
        (Err(refusal), _) => return refusal,
        (_, Err(error)) => return error,
    };
    let key = format!("{}|{}", paths.0, paths.1);
    if let Some(hit) = cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .as_ref()
    {
        if hit.key == key && ctx.now_ms().saturating_sub(hit.at_ms) < CACHE_MS {
            return row_reply(OP, None, ctx.now_ms(), None, hit.row.clone());
        }
    }
    let context_part = match ctx.context(|conn| {
        let health = database_health(ctx, conn, "context_db", &paths.0)?;
        let state = single_store_state(conn)?;
        Ok((health, state))
    }) {
        Ok(part) => part,
        Err(refusal) => return refusal,
    };
    let store_health = match ctx.store_db(|conn| database_health(ctx, conn, "store_db", &paths.1)) {
        Ok(health) => health,
        Err(error) => return error,
    };
    let row = json!({
        "single_store_state": context_part.1,
        "databases": [context_part.0, store_health],
    });
    *cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Cached {
        key,
        at_ms: ctx.now_ms(),
        row: row.clone(),
    });
    row_reply(OP, None, ctx.now_ms(), None, row)
}

fn database_path(conn: &rusqlite::Connection) -> rusqlite::Result<String> {
    conn.query_row(
        "SELECT file FROM pragma_database_list WHERE name = 'main'",
        [],
        |row| row.get(0),
    )
}

fn single_store_state(conn: &rusqlite::Connection) -> rusqlite::Result<Option<String>> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'single_store_state')",
        [],
        |row| row.get(0),
    )?;
    if !exists {
        return Ok(None);
    }
    conn.query_row(
        "SELECT state FROM single_store_state WHERE id = 1",
        [],
        |row| row.get(0),
    )
    .optional()
}

fn database_health(
    ctx: &AppReadContext,
    conn: &rusqlite::Connection,
    name: &str,
    path: &str,
) -> rusqlite::Result<Value> {
    ctx.note_sql("PRAGMA page_size");
    ctx.note_sql("PRAGMA page_count");
    ctx.note_sql("PRAGMA freelist_count");
    let page_size: i64 = conn.query_row("PRAGMA page_size", [], |row| row.get(0))?;
    let page_count: i64 = conn.query_row("PRAGMA page_count", [], |row| row.get(0))?;
    let freelist_count: i64 = conn.query_row("PRAGMA freelist_count", [], |row| row.get(0))?;
    let schema_version = schema_version(ctx, conn)?;
    let rows = table_estimates(ctx, conn)?;
    let file = std::path::Path::new(path);
    Ok(json!({
        "name": name,
        "path": path,
        "bytes": file_len(file),
        "wal_bytes": file_len(&wal_path(file)),
        "shm_bytes": file_len(&shm_path(file)),
        "page_size": page_size,
        "page_count": page_count,
        "freelist_count": freelist_count,
        "schema_version": schema_version,
        "rows": rows,
    }))
}

fn schema_version(
    ctx: &AppReadContext,
    conn: &rusqlite::Connection,
) -> rusqlite::Result<Option<i64>> {
    for table in ["schema_migrations", "cortexkit_migrations"] {
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
            [table],
            |row| row.get(0),
        )?;
        if !exists {
            continue;
        }
        let sql = format!("SELECT MAX(version) FROM {table}");
        ctx.note_sql(&sql);
        return conn.query_row(&sql, [], |row| row.get(0));
    }
    Ok(None)
}

fn table_estimates(
    ctx: &AppReadContext,
    conn: &rusqlite::Connection,
) -> rusqlite::Result<Vec<Value>> {
    ctx.note_sql(TABLES_SQL);
    let mut statement = prepare(conn, TABLES_SQL)?;
    let names = statement.query_map([], |row| row.get::<_, String>(0))?;
    let mut estimates = Vec::new();
    for name in names {
        let name = name?;
        if name.starts_with("sqlite_") {
            continue;
        }
        let sql: String = conn.query_row(
            "SELECT sql FROM sqlite_master WHERE name = ?1",
            [&name],
            |row| row.get(0),
        )?;
        if sql.to_ascii_uppercase().contains("WITHOUT ROWID") {
            estimates.push(json!({"table": name, "rows": null, "method": "not_estimated"}));
            continue;
        }
        ctx.note_sql(SEQUENCE_SQL);
        let sequence = conn
            .query_row(SEQUENCE_SQL, [&name], |row| row.get::<_, Option<i64>>(0))
            .optional()?
            .flatten();
        if let Some(rows) = sequence {
            estimates.push(json!({"table": name, "rows": rows, "method": "sqlite_sequence"}));
            continue;
        }
        let max_sql = format!("SELECT MAX(rowid) FROM \"{name}\"");
        ctx.note_sql(&max_sql);
        let max: Option<i64> = conn.query_row(&max_sql, [], |row| row.get(0))?;
        estimates.push(json!({
            "table": name,
            "rows": max.unwrap_or(0),
            "method": "max_rowid",
        }));
    }
    Ok(estimates)
}

const TABLES_SQL: &str = "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name";
const SEQUENCE_SQL: &str = "SELECT seq FROM sqlite_sequence WHERE name = ?1";

fn file_len(path: &std::path::Path) -> u64 {
    std::fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0)
}

fn wal_path(path: &std::path::Path) -> std::path::PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push("-wal");
    std::path::PathBuf::from(name)
}

fn shm_path(path: &std::path::Path) -> std::path::PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push("-shm");
    std::path::PathBuf::from(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_read::tests_support::{explain, open_store, response};
    use std::time::Duration;

    #[test]
    fn health_plans_do_not_count_rows() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(dir.path());
        let mut ctx = AppReadContext::for_test(store, 1_700_000_000_000);
        let log = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        ctx.set_sql_log(std::sync::Arc::clone(&log));
        let reply = response(&read(
            &crate::app_read::tests_support::caller(),
            &ctx,
            serde_json::json!({}).as_object().unwrap(),
        ));
        assert!(reply["row"]["databases"].as_array().unwrap().len() == 2);
        let sql = log.lock().unwrap().clone();
        assert!(sql.iter().any(|query| query.contains("MAX(rowid)")));
        assert!(
            sql.iter()
                .all(|query| !query.to_ascii_uppercase().contains("COUNT(*)")),
            "{sql:?}"
        );
        let db = dir.path().join("context.db");
        for query in [TABLES_SQL, SEQUENCE_SQL, "SELECT MAX(rowid) FROM memories"] {
            let plan = explain(&db, query);
            assert!(
                !plan.to_ascii_uppercase().contains("COUNT"),
                "{query}: {plan}"
            );
        }
        let methods: Vec<_> = reply["row"]["databases"][0]["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["method"].as_str().unwrap_or(""))
            .collect();
        assert!(methods.iter().any(|method| *method == "max_rowid"
            || *method == "sqlite_sequence"
            || *method == "not_estimated"));
    }

    #[test]
    fn health_is_cached_for_thirty_seconds() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(dir.path());
        let ctx = AppReadContext::for_test(std::sync::Arc::clone(&store), 1_000);
        let first = response(&read(
            &crate::app_read::tests_support::caller(),
            &ctx,
            serde_json::json!({}).as_object().unwrap(),
        ));
        let again = AppReadContext::for_test(store, 2_000);
        let second = response(&read(
            &crate::app_read::tests_support::caller(),
            &again,
            serde_json::json!({}).as_object().unwrap(),
        ));
        assert_eq!(
            first["row"]["databases"][0]["page_count"],
            second["row"]["databases"][0]["page_count"]
        );
    }

    #[test]
    fn a_zero_budget_refuses_health() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(dir.path());
        let mut ctx = AppReadContext::for_test(store, 1);
        ctx.set_budget(Duration::ZERO);
        match read(
            &crate::app_read::tests_support::caller(),
            &ctx,
            serde_json::json!({}).as_object().unwrap(),
        ) {
            HandlerOutcome::Error { code, .. } => assert_eq!(code, "read_budget_exceeded"),
            other => panic!("{other:?}"),
        }
    }
}
