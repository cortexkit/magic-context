//! `attribution.read {after?, limit?}` on ck-mc's management surface:
//! Astrocyte reads every attribution fact in one stable order, from the
//! start on its first run or after it missed events, and page by page.
//!
//! Only the daemon-attested `reserved:astrocyte` is admitted. Any other
//! caller is refused `caller_not_admitted`, the refusal ck-mc gives an
//! unadmitted user command, before the request's params are read.
//!
//! The reply is `{"result": {facts, next, through}}`. `facts` are the stored
//! fact objects in the order they were recorded. `after`, `next` and
//! `through` are opaque cursors (a fact's place in that order, as a string):
//! `next` is the cursor to pass as `after` for the following page, or null
//! when this page reached the newest fact; `through` is the cursor of the
//! newest fact stored when the read ran, or null while there is none. A page
//! holds `limit` facts at most: 100 unless asked, never more than 500.
//!
//! The read runs in one read transaction on a read-only connection, the way
//! `ctx_search` reads, so a long page never holds up the connection every
//! writer uses, and `facts`, `next` and `through` describe one snapshot.

use rusqlite::{params, Connection};
use serde_json::{json, Map, Value};
use subc_protocol::{ErrorBody, Principal};

use crate::context_db::ContextDb;

/// The read's method name.
pub(crate) const METHOD: &str = "attribution.read";
/// The one module admitted to the read.
pub(crate) const READER: &str = "astrocyte";
/// The page size when the request names none.
pub(crate) const DEFAULT_LIMIT: u64 = 100;
/// The largest page; a larger `limit` is cut to it.
pub(crate) const MAX_LIMIT: u64 = 500;
/// The refusal code of a caller the read doesn't admit, as an unadmitted
/// user command is refused.
pub(crate) const CALLER_NOT_ADMITTED: &str = "caller_not_admitted";

/// Whether `body` is a request for this read. A body that isn't JSON, or
/// names another method, is not.
pub(crate) fn requested(body: &[u8]) -> bool {
    serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|request| {
            request
                .get("method")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .is_some_and(|method| method == METHOD)
}

/// Admit the daemon-attested `reserved:astrocyte` and refuse every other
/// caller.
pub(crate) fn admit(principal: &Principal) -> Result<(), ErrorBody> {
    if matches!(principal, Principal::Reserved { module_id } if module_id == READER) {
        Ok(())
    } else {
        Err(ErrorBody::new(CALLER_NOT_ADMITTED, "caller not admitted"))
    }
}

fn invalid(field: &str) -> ErrorBody {
    ErrorBody::new("invalid_params", format!("Invalid {field}."))
        .with_detail(json!({"field": field}))
}

fn unavailable() -> ErrorBody {
    ErrorBody::new("store_unavailable", "The memory store could not be read.")
}

/// What one read asks for.
#[derive(Debug, PartialEq, Eq)]
struct Page {
    /// The place after which the page starts; 0 reads from the first fact.
    after: i64,
    limit: u64,
}

/// The request's params: an object with at most `after` and `limit`, or
/// none at all.
fn page_of(request: &Value) -> Result<Page, ErrorBody> {
    let empty = Map::new();
    let params = match request.get("params") {
        None | Some(Value::Null) => &empty,
        Some(Value::Object(params)) => params,
        Some(_) => return Err(invalid("params")),
    };
    if let Some(unknown) = params
        .keys()
        .find(|key| !matches!(key.as_str(), "after" | "limit"))
    {
        return Err(invalid(&format!("params.{unknown}")));
    }
    let after = match params.get("after") {
        None | Some(Value::Null) => 0,
        Some(Value::String(cursor))
            if !cursor.is_empty() && cursor.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            cursor.parse::<i64>().map_err(|_| invalid("params.after"))?
        }
        Some(_) => return Err(invalid("params.after")),
    };
    let limit = match params.get("limit") {
        None | Some(Value::Null) => DEFAULT_LIMIT,
        Some(limit) => limit
            .as_u64()
            .filter(|limit| *limit > 0)
            .ok_or_else(|| invalid("params.limit"))?
            .min(MAX_LIMIT),
    };
    Ok(Page { after, limit })
}

/// One admitted read of `body`: the page in the management envelope,
/// `{"result": {facts, next, through}}`.
pub(crate) fn handle(db: Option<&ContextDb>, body: &[u8]) -> Result<Value, ErrorBody> {
    let request: Value = serde_json::from_slice(body).map_err(|_| invalid("request"))?;
    let page = page_of(&request)?;
    let db = db.ok_or_else(unavailable)?;
    let result = db
        .with_search_reader(|conn, _| read(conn, &page))
        .map_err(|error| {
            tracing::warn!(method = %METHOD, %error, "ck-mc: attribution method failed");
            unavailable()
        })?;
    Ok(json!({ "result": result }))
}

/// The page `page` asks for, read on `conn` in the caller's transaction.
fn read(conn: &Connection, page: &Page) -> Result<Value, String> {
    let through: Option<i64> = conn
        .query_row("SELECT MAX(seq) FROM attribution_facts", [], |row| {
            row.get(0)
        })
        .map_err(|error| error.to_string())?;
    let rows: Vec<(i64, String)> = conn
        .prepare_cached(
            "SELECT seq, body FROM attribution_facts WHERE seq > ?1 ORDER BY seq LIMIT ?2",
        )
        .and_then(|mut statement| {
            statement
                .query_map(
                    params![page.after, i64::try_from(page.limit).unwrap_or(i64::MAX)],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?
                .collect()
        })
        .map_err(|error| error.to_string())?;
    let last = rows.last().map(|(seq, _)| *seq);
    let facts = rows
        .into_iter()
        .map(|(seq, body)| {
            serde_json::from_str::<Value>(&body)
                .map_err(|error| format!("the fact at {seq} is not JSON: {error}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let next = last.filter(|last| through.is_some_and(|through| *last < through));
    Ok(json!({
        "facts": facts,
        "next": next.map(|seq| seq.to_string()),
        "through": through.map(|seq| seq.to_string()),
    }))
}
