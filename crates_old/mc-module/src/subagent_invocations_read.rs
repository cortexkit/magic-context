//! `subagent_invocations.read`: a read-only management query over the
//! `subagent_invocations` table in `context.db`.
//!
//! basal flows cannot open SQLite, so the subagent failure sentinel flow
//! (`scripts/flows/mc-subagent-failure-sentinel`) reads the rows it judges
//! through this op. It answers the two queries the sentinel needs:
//!
//! - `after_cursor`: rows that ended after a `(ended_at, id)` cursor and no
//!   later than a settle bound, oldest first, at most 500;
//! - `window`: rows that ended inside `(after, until]`, newest first, at most
//!   5,000, optionally continuing below a `before` cursor.
//!
//! basal refuses any host result over 512 KiB, so each reply also stops once its
//! rows pass [`PAGE_BUDGET_BYTES`]. Every reply says whether another matching
//! row exists past its last row (`more`); the caller continues from that row
//! with a smaller `limit`. A reply always carries at least one row when one
//! matches, and an error text longer than [`ERROR_MAX_BYTES`] is cut so that a
//! single row can never exceed the cap.
//!
//! The op only reads, through the module's query-only context reader. Unknown
//! arguments are refused by name with `invalid_params`.
//!
//! Only Magic Context's own flows may call it. [`authorize_caller`] checks the
//! daemon-stamped route identity, never a request argument: the carrier must be
//! `reserved:basal`, the scope must be an owner-authorized
//! `reserved:prefrontal-core` scope for a flow (`flow_id` present, call mode
//! `flow`), and the flow's author (`agent_id`) must be [`MC_AGENT_ID`].

use rusqlite::{params, Connection, Row};
use serde_json::{json, Map, Value};
use subc_protocol::call_mode::{derive_call_mode, CallMode};
use subc_protocol::scope::ScopeStamp;
use subc_protocol::Principal;

/// The management op name, declared as a query in the module manifest.
pub(crate) const METHOD: &str = "subagent_invocations.read";
/// Most rows an `after_cursor` reply may hold.
pub(crate) const AFTER_CURSOR_LIMIT: u32 = 500;
/// Most rows a `window` reply may hold.
pub(crate) const WINDOW_LIMIT: u32 = 5_000;
/// A reply stops adding rows once their JSON reaches this many bytes, well
/// under basal's 512 KiB result cap.
pub(crate) const PAGE_BUDGET_BYTES: usize = 256 * 1024;
/// The longest error text a row carries, in UTF-8 bytes.
pub(crate) const ERROR_MAX_BYTES: usize = 32 * 1024;

/// The prefrontal agent id of MC, the agent that authors the subagent failure
/// sentinel flow. basal stamps a flow's author as the scope's `agent_id`, so
/// only flows MC installed may read the rows. Change it here if MC's agent is
/// ever recreated under a new id.
pub(crate) const MC_AGENT_ID: &str = "agent_b613e5cf2ee55b8c";
/// The module that carries every flow's calls to other modules.
const FLOW_CARRIER: &str = "basal";
/// The module that owns flow scopes and is authorized to set their attributes.
const FLOW_SCOPE_OWNER: &str = "prefrontal-core";

fn reserved(principal: &Principal, module: &str) -> bool {
    matches!(principal, Principal::Reserved { module_id } if module_id == module)
}

/// Admits a route only when the daemon stamped it as one of MC's own flows.
/// Every refusal names the field that failed. With only `flow-scopes/v1`
/// declared the daemon sends no explicit call mode, so the mode is derived
/// from the stamp exactly as the SDK derives it for the bind.
pub(crate) fn authorize_caller(
    principal: Option<&Principal>,
    scope: Option<&ScopeStamp>,
) -> Result<(), String> {
    if !principal.is_some_and(|principal| reserved(principal, FLOW_CARRIER)) {
        return Err(format!(
            "{METHOD} needs the flow carrier reserved:{FLOW_CARRIER}, got {principal:?}"
        ));
    }
    let Some(scope) = scope else {
        return Err(format!("{METHOD} needs a daemon scope stamp"));
    };
    if !reserved(&scope.owner, FLOW_SCOPE_OWNER) {
        return Err(format!(
            "{METHOD} needs a scope owned by reserved:{FLOW_SCOPE_OWNER}, got {:?}",
            scope.owner
        ));
    }
    if !scope.owner_authorized {
        return Err(format!("{METHOD} needs an owner_authorized scope"));
    }
    if scope.attributes.flow_id.is_none() {
        return Err(format!("{METHOD} needs a scope with `flow_id`"));
    }
    let mode = derive_call_mode(Some(scope));
    if mode != CallMode::Flow {
        return Err(format!("{METHOD} needs call mode `flow`, got {mode:?}"));
    }
    match scope.attributes.agent_id.as_deref() {
        Some(MC_AGENT_ID) => Ok(()),
        other => Err(format!(
            "{METHOD} needs `agent_id` {MC_AGENT_ID}, got {other:?}"
        )),
    }
}

const FIELDS: &str =
    "id, session_id, subagent, task, started_at, ended_at, status, error, parent_invocation_id";

/// The management surface that serves [`METHOD`]. basal grants a flow only ops
/// its module marks as query or mutate, and reaches management ops on this
/// surface; the subagent failure sentinel flow reads its rows here.
pub(crate) fn management_role() -> subc_protocol::manifest::ProviderRole {
    use subc_protocol::manifest::{
        Concurrency, ManagementOperation, ManagementOperationKind, ProviderRole,
    };
    ProviderRole::ManagementSurface {
        operations: vec![ManagementOperation {
            name: METHOD.to_string(),
            kind: ManagementOperationKind::Query,
            description: Some(
                "Read finished subagent invocations after a cursor or inside a time window, in bounded pages"
                    .to_string(),
            ),
        }],
        config_schema: json!({ "type": "object" }),
        observability: Vec::new(),
        identity_scope: Vec::new(),
        concurrency: Concurrency::ModuleManaged,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Cursor {
    pub ended_at: i64,
    pub id: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ReadQuery {
    AfterCursor {
        cursor: Cursor,
        settled_before: i64,
        limit: u32,
    },
    Window {
        after: i64,
        until: i64,
        before: Option<Cursor>,
        limit: u32,
    },
}

fn object<'a>(value: &'a Value, what: &str) -> Result<&'a Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| format!("{what} must be an object"))
}

fn refuse_unknown(fields: &Map<String, Value>, allowed: &[&str], what: &str) -> Result<(), String> {
    match fields.keys().find(|key| !allowed.contains(&key.as_str())) {
        Some(key) => Err(format!("unknown argument `{key}` in {what}")),
        None => Ok(()),
    }
}

fn integer(fields: &Map<String, Value>, key: &str, what: &str) -> Result<i64, String> {
    match fields.get(key) {
        None => Err(format!("{what} needs `{key}`")),
        Some(value) => value
            .as_i64()
            .ok_or_else(|| format!("`{key}` in {what} must be an integer")),
    }
}

fn cursor(value: &Value, what: &str) -> Result<Cursor, String> {
    let fields = object(value, what)?;
    refuse_unknown(fields, &["ended_at", "id"], what)?;
    Ok(Cursor {
        ended_at: integer(fields, "ended_at", what)?,
        id: integer(fields, "id", what)?,
    })
}

fn limit(fields: &Map<String, Value>, max: u32) -> Result<u32, String> {
    match fields.get("limit") {
        None => Ok(max),
        Some(value) => value
            .as_u64()
            .filter(|limit| (1..=u64::from(max)).contains(limit))
            .map(|limit| limit as u32)
            .ok_or_else(|| format!("`limit` must be an integer from 1 to {max}")),
    }
}

/// Decodes the op's `params`. Every message names the argument at fault.
pub(crate) fn parse(params: &Value) -> Result<ReadQuery, String> {
    let fields = object(params, "params")?;
    match fields.get("query").and_then(Value::as_str) {
        Some("after_cursor") => {
            refuse_unknown(
                fields,
                &["query", "cursor", "settled_before", "limit"],
                "an after_cursor query",
            )?;
            let at = fields
                .get("cursor")
                .ok_or("an after_cursor query needs `cursor`")?;
            Ok(ReadQuery::AfterCursor {
                cursor: cursor(at, "`cursor`")?,
                settled_before: integer(fields, "settled_before", "an after_cursor query")?,
                limit: limit(fields, AFTER_CURSOR_LIMIT)?,
            })
        }
        Some("window") => {
            refuse_unknown(
                fields,
                &["query", "after", "until", "before", "limit"],
                "a window query",
            )?;
            Ok(ReadQuery::Window {
                after: integer(fields, "after", "a window query")?,
                until: integer(fields, "until", "a window query")?,
                before: fields
                    .get("before")
                    .map(|value| cursor(value, "`before`"))
                    .transpose()?,
                limit: limit(fields, WINDOW_LIMIT)?,
            })
        }
        Some(other) => Err(format!(
            "unknown query `{other}`; expected `after_cursor` or `window`"
        )),
        None => Err("params need `query`: `after_cursor` or `window`".to_string()),
    }
}

fn cut_error(mut text: String) -> String {
    if text.len() > ERROR_MAX_BYTES {
        let mut end = ERROR_MAX_BYTES;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }
    text
}

fn row_json(row: &Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_, i64>(0)?,
        "session_id": row.get::<_, String>(1)?,
        "subagent": row.get::<_, String>(2)?,
        "task": row.get::<_, Option<String>>(3)?,
        "started_at": row.get::<_, i64>(4)?,
        "ended_at": row.get::<_, i64>(5)?,
        "status": row.get::<_, String>(6)?,
        "error": row.get::<_, Option<String>>(7)?.map(cut_error),
        "parent_invocation_id": row.get::<_, Option<i64>>(8)?,
    }))
}

/// Runs `query` on a `context.db` connection and returns `{rows, more}`.
pub(crate) fn run(conn: &Connection, query: &ReadQuery) -> rusqlite::Result<Value> {
    // The statements fetch one row past the limit, which tells whether more match.
    match query {
        ReadQuery::AfterCursor {
            cursor,
            settled_before,
            limit,
        } => {
            let mut statement = conn.prepare(&format!(
                "SELECT {FIELDS} FROM subagent_invocations \
                 WHERE ended_at IS NOT NULL AND ended_at <= ?1 \
                 AND (ended_at > ?2 OR (ended_at = ?2 AND id > ?3)) \
                 ORDER BY ended_at, id LIMIT ?4"
            ))?;
            let rows = statement.query(params![
                settled_before,
                cursor.ended_at,
                cursor.id,
                i64::from(*limit) + 1
            ])?;
            page(rows, *limit)
        }
        ReadQuery::Window {
            after,
            until,
            before,
            limit,
        } => {
            // Without `before`, a cursor just past `until` admits every row up to it.
            let before = before.unwrap_or(Cursor {
                ended_at: until.saturating_add(1),
                id: i64::MIN,
            });
            let mut statement = conn.prepare(&format!(
                "SELECT {FIELDS} FROM subagent_invocations \
                 WHERE ended_at > ?1 AND ended_at <= ?2 \
                 AND (ended_at < ?3 OR (ended_at = ?3 AND id < ?4)) \
                 ORDER BY ended_at DESC, id DESC LIMIT ?5"
            ))?;
            let rows = statement.query(params![
                after,
                until,
                before.ended_at,
                before.id,
                i64::from(*limit) + 1
            ])?;
            page(rows, *limit)
        }
    }
}

/// Takes rows until `limit` or the byte budget, always at least one, and
/// reports whether a matching row was left behind.
fn page(mut rows: rusqlite::Rows<'_>, limit: u32) -> rusqlite::Result<Value> {
    let mut kept = Vec::new();
    let mut bytes = 0usize;
    let mut more = false;
    while let Some(row) = rows.next()? {
        if kept.len() == limit as usize || (!kept.is_empty() && bytes >= PAGE_BUDGET_BYTES) {
            more = true;
            break;
        }
        let value = row_json(row)?;
        bytes += value.to_string().len();
        kept.push(value);
    }
    Ok(json!({ "rows": kept, "more": more }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCHEMA: &str = include_str!("../tests/fixtures/context-db-schema.sql");

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn
    }

    fn insert(conn: &Connection, ended_at: Option<i64>, error: Option<&str>) -> i64 {
        conn.execute(
            "INSERT INTO subagent_invocations (session_id, harness, subagent, task, started_at, ended_at, status, error, parent_invocation_id) \
             VALUES ('ses', 'opencode', 'historian', 'fallback', 1, ?1, 'failed', ?2, 7)",
            params![ended_at, error],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    fn ids(reply: &Value) -> Vec<i64> {
        reply["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["id"].as_i64().unwrap())
            .collect()
    }

    fn after(ended_at: i64, id: i64, settled_before: i64) -> ReadQuery {
        ReadQuery::AfterCursor {
            cursor: Cursor { ended_at, id },
            settled_before,
            limit: AFTER_CURSOR_LIMIT,
        }
    }

    fn window(after: i64, until: i64, before: Option<Cursor>) -> ReadQuery {
        ReadQuery::Window {
            after,
            until,
            before,
            limit: WINDOW_LIMIT,
        }
    }

    // A query-only connection refuses every write, so a passing read proves the op wrote nothing.
    fn read_only(conn: &Connection, query: &ReadQuery) -> Value {
        conn.pragma_update(None, "query_only", "ON").unwrap();
        let reply = run(conn, query).unwrap();
        conn.pragma_update(None, "query_only", "OFF").unwrap();
        reply
    }

    #[test]
    fn rows_carry_every_field_the_sentinel_reads() {
        let conn = db();
        insert(&conn, Some(100), Some("boom"));
        let reply = read_only(&conn, &after(0, 0, 1_000));
        assert_eq!(
            reply,
            json!({"rows": [{
                "id": 1, "session_id": "ses", "subagent": "historian", "task": "fallback",
                "started_at": 1, "ended_at": 100, "status": "failed", "error": "boom",
                "parent_invocation_id": 7
            }], "more": false})
        );
    }

    #[test]
    fn after_cursor_resumes_equal_timestamps_by_id_and_stops_at_the_settle_bound() {
        let conn = db();
        let first = insert(&conn, Some(100), None);
        let second = insert(&conn, Some(100), None);
        let third = insert(&conn, Some(200), None);
        let unsettled = insert(&conn, Some(301), None);
        insert(&conn, None, None);
        assert_eq!(
            ids(&read_only(&conn, &after(100, first, 300))),
            vec![second, third]
        );
        assert_eq!(
            ids(&read_only(&conn, &after(0, 0, 301))),
            vec![first, second, third, unsettled]
        );
    }

    #[test]
    fn after_cursor_holds_500_rows_and_says_more_remain() {
        let conn = db();
        for _ in 0..501 {
            insert(&conn, Some(100), None);
        }
        let reply = read_only(&conn, &after(0, 0, 100));
        assert_eq!(reply["rows"].as_array().unwrap().len(), 500);
        assert_eq!(reply["more"], json!(true));
        let rest = read_only(&conn, &after(100, 500, 100));
        assert_eq!(ids(&rest), vec![501]);
        assert_eq!(rest["more"], json!(false));
    }

    #[test]
    fn window_is_newest_first_inside_after_exclusive_until_inclusive() {
        let conn = db();
        insert(&conn, Some(100), None);
        let inside = insert(&conn, Some(101), None);
        let edge = insert(&conn, Some(200), None);
        insert(&conn, Some(201), None);
        let reply = read_only(&conn, &window(100, 200, None));
        assert_eq!(ids(&reply), vec![edge, inside]);
        assert_eq!(reply["more"], json!(false));
    }

    #[test]
    fn window_pages_through_5001_rows_below_before_cursors() {
        let conn = db();
        for _ in 0..5_001 {
            insert(&conn, Some(150), None);
        }
        // About 160 bytes a row: the byte budget, not the 5,000 limit, ends each page.
        let mut seen = Vec::new();
        let mut before = None;
        loop {
            let reply = read_only(&conn, &window(100, 200, before));
            let page = ids(&reply);
            assert!(!page.is_empty() && page.len() < 5_000);
            let last = *page.last().unwrap();
            seen.extend(page);
            if reply["more"] == json!(false) {
                break;
            }
            before = Some(Cursor {
                ended_at: 150,
                id: last,
            });
        }
        assert_eq!(seen, (1..=5_001).rev().collect::<Vec<_>>());
    }

    #[test]
    fn a_limit_ends_a_page_and_says_more_remain() {
        let conn = db();
        for _ in 0..5 {
            insert(&conn, Some(150), None);
        }
        let query = ReadQuery::Window {
            after: 100,
            until: 200,
            before: None,
            limit: 3,
        };
        let reply = read_only(&conn, &query);
        assert_eq!(ids(&reply), vec![5, 4, 3]);
        assert_eq!(reply["more"], json!(true));
        let query = ReadQuery::Window {
            after: 100,
            until: 200,
            before: Some(Cursor {
                ended_at: 150,
                id: 3,
            }),
            limit: 2,
        };
        let reply = read_only(&conn, &query);
        assert_eq!(ids(&reply), vec![2, 1]);
        assert_eq!(reply["more"], json!(false));
    }

    #[test]
    fn a_reply_stops_at_the_byte_budget_and_the_next_page_continues() {
        let conn = db();
        let long = "x".repeat(ERROR_MAX_BYTES);
        for _ in 0..12 {
            insert(&conn, Some(150), Some(&long));
        }
        let first = read_only(&conn, &window(100, 200, None));
        let first_ids = ids(&first);
        assert!(first_ids.len() < 12, "the budget must cut the page");
        assert!(first.to_string().len() < 512 * 1024);
        assert_eq!(first["more"], json!(true));
        let last = *first_ids.last().unwrap();
        let second = read_only(
            &conn,
            &window(
                100,
                200,
                Some(Cursor {
                    ended_at: 150,
                    id: last,
                }),
            ),
        );
        let mut all = first_ids;
        all.extend(ids(&second));
        assert_eq!(all, (1..=12).rev().collect::<Vec<_>>());
        assert_eq!(second["more"], json!(false));
    }

    #[test]
    fn a_long_error_is_cut_on_a_character_boundary() {
        let conn = db();
        let long = format!("x{}", "é".repeat(ERROR_MAX_BYTES));
        insert(&conn, Some(100), Some(&long));
        let reply = read_only(&conn, &after(0, 0, 100));
        let error = reply["rows"][0]["error"].as_str().unwrap();
        assert!(error.len() <= ERROR_MAX_BYTES && error.len() >= ERROR_MAX_BYTES - 1);
        assert!(long.starts_with(error));
    }

    #[test]
    fn parse_accepts_both_queries_with_optional_limit_and_before() {
        assert_eq!(
            parse(
                &json!({"query": "after_cursor", "cursor": {"ended_at": 5, "id": 2}, "settled_before": 9})
            ),
            Ok(after(5, 2, 9))
        );
        assert_eq!(
            parse(
                &json!({"query": "window", "after": 1, "until": 9, "before": {"ended_at": 4, "id": 3}, "limit": 7})
            ),
            Ok(ReadQuery::Window {
                after: 1,
                until: 9,
                before: Some(Cursor { ended_at: 4, id: 3 }),
                limit: 7
            })
        );
    }

    #[test]
    fn parse_refuses_unknown_arguments_by_name() {
        let refused = |params: Value| parse(&params).unwrap_err();
        assert!(
            refused(json!({"query": "window", "after": 1, "until": 2, "since": 0}))
                .contains("unknown argument `since`")
        );
        assert!(refused(json!({"query": "after_cursor", "cursor": {"ended_at": 1, "id": 1}, "settled_before": 2, "until": 3}))
            .contains("unknown argument `until`"));
        assert!(refused(json!({"query": "after_cursor", "cursor": {"ended_at": 1, "id": 1, "row": 2}, "settled_before": 2}))
            .contains("unknown argument `row`"));
        assert!(refused(
            json!({"query": "window", "after": 1, "until": 2, "before": {"ended_at": 1, "at": 1}})
        )
        .contains("unknown argument `at`"));
        assert!(refused(json!({"query": "everything"})).contains("unknown query `everything`"));
    }

    #[test]
    fn parse_refuses_missing_or_malformed_values() {
        let refused = |params: Value| parse(&params).unwrap_err();
        assert!(refused(json!(null)).contains("params must be an object"));
        assert!(refused(json!({})).contains("`query`"));
        assert!(refused(json!({"query": "window", "until": 2})).contains("`after`"));
        assert!(refused(json!({"query": "window", "after": 1.5, "until": 2})).contains("`after`"));
        assert!(
            refused(json!({"query": "after_cursor", "settled_before": 2})).contains("`cursor`")
        );
        assert!(
            refused(json!({"query": "window", "after": 1, "until": 2, "limit": 5_001}))
                .contains("`limit`")
        );
        assert!(refused(json!({"query": "after_cursor", "cursor": {"ended_at": 1, "id": 1}, "settled_before": 2, "limit": 0})).contains("`limit`"));
    }
}
