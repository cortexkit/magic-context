//! What every page read shares: the caller's `limit`, the opaque keyset
//! cursor, the owner a memory read names, and a page that stops before its
//! reply outgrows the frame.
//!
//! A cursor names the read that made it, a digest of the read's filters and
//! the sort key of the last row it returned. The next page continues after
//! that row, so rows added or changed between two pages never shift the rows
//! after them. A cursor from another read, or from the same read with other
//! filters, could only continue a different list, so it is refused as
//! `bad_cursor` like one that doesn't decode.

use base64::Engine as _;
use rusqlite::types::Value as Sql;

use super::*;

/// Room kept in a page's reply for its envelope and `next` cursor, so a page
/// of rows that fits this budget always fits the frame.
const ENVELOPE_ROOM: usize = 8 * 1024;

pub(super) fn bad_cursor() -> Refusal {
    error(
        "bad_cursor",
        "The cursor is not one this read made with these filters.",
    )
}

pub(super) fn store_unavailable() -> Refusal {
    error("store_unavailable", "The memory store could not be read.")
}

/// A store error while reading: the store is there but the read failed.
pub(super) fn store_error(error: rusqlite::Error) -> Refusal {
    tracing::warn!("ck-mc: app read failed: {error}");
    store_unavailable()
}

pub(super) fn project_unknown() -> Refusal {
    error(
        "project_unknown",
        "No session of this project has been set up with Magic Context.",
    )
}

/// The caller's `limit`: 1 to `max`, `max` when absent.
pub(super) fn limit(p: &Map<String, Value>, max: usize) -> Result<usize, Refusal> {
    match p.get("limit") {
        None | Some(Value::Null) => Ok(max),
        Some(value) => value
            .as_u64()
            .filter(|limit| (1..=max as u64).contains(limit))
            .map(|limit| limit as usize)
            .ok_or_else(|| invalid("limit")),
    }
}

/// An optional string parameter, refused when present but not a string the
/// reads accept.
pub(super) fn optional<'a>(
    p: &'a Map<String, Value>,
    key: &str,
) -> Result<Option<&'a str>, Refusal> {
    match p.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(_) => string(p, key).map(Some),
    }
}

/// One cursor's identity: the read and the filters it pages through.
pub(super) struct Keyset {
    read: &'static str,
    filters: String,
}

impl Keyset {
    pub(super) fn new(read: &'static str, filters: &Value) -> Self {
        let digest = Sha256::digest(filters.to_string().as_bytes());
        Self {
            read,
            filters: format!("{:x}", digest)[..16].to_owned(),
        }
    }

    /// The cursor that continues after a row with this sort key.
    pub(super) fn cursor(&self, key: &[Sql]) -> String {
        let key: Vec<Value> = key
            .iter()
            .map(|value| match value {
                Sql::Null => Value::Null,
                Sql::Integer(number) => json!(number),
                Sql::Real(number) => json!(number),
                Sql::Text(text) => json!(text),
                Sql::Blob(_) => Value::Null,
            })
            .collect();
        let body = json!([self.read, self.filters, key]).to_string();
        format!(
            "mcc1.{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(body)
        )
    }

    /// The sort key a cursor continues after, which must have `shape`: one
    /// entry per key column, `'i'` for an integer and `'s'` for text. `None`
    /// when the caller sent no cursor.
    pub(super) fn after(
        &self,
        p: &Map<String, Value>,
        shape: &str,
    ) -> Result<Option<Vec<Sql>>, Refusal> {
        let text = match p.get("cursor") {
            None | Some(Value::Null) => return Ok(None),
            Some(value) => value.as_str().ok_or_else(bad_cursor)?,
        };
        let body = text
            .strip_prefix("mcc1.")
            .filter(|body| body.len() <= 4096)
            .and_then(|body| {
                base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .decode(body)
                    .ok()
            })
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .ok_or_else(bad_cursor)?;
        if body[0] != self.read || body[1] != self.filters.as_str() {
            return Err(bad_cursor());
        }
        let key = body[2].as_array().ok_or_else(bad_cursor)?;
        if key.len() != shape.len() || body.as_array().map(Vec::len) != Some(3) {
            return Err(bad_cursor());
        }
        key.iter()
            .zip(shape.chars())
            .map(|(value, kind)| match kind {
                'i' => value.as_i64().map(Sql::Integer),
                _ => value.as_str().map(|text| Sql::Text(text.to_owned())),
            })
            .collect::<Option<Vec<_>>>()
            .map(Some)
            .ok_or_else(bad_cursor)
    }
}

/// A page being filled: rows in read order, each with its sort key, stopped
/// at the caller's limit or before the reply would outgrow the frame.
pub(super) struct Page {
    limit: usize,
    rows: Vec<Value>,
    bytes: usize,
    last: Option<Vec<Sql>>,
    more: bool,
}

impl Page {
    pub(super) fn new(limit: usize) -> Self {
        Self {
            limit,
            rows: Vec::new(),
            bytes: 0,
            last: None,
            more: false,
        }
    }

    /// Add a row; `false` once the page is full, so the caller stops
    /// reading. A row the page has no room for marks that there is more.
    pub(super) fn push(&mut self, row: Value, key: Vec<Sql>) -> Result<bool, Refusal> {
        if self.rows.len() == self.limit {
            self.more = true;
            return Ok(false);
        }
        let size = row.to_string().len() + 1;
        if self.bytes + size > REPLY_BUDGET - ENVELOPE_ROOM {
            if self.rows.is_empty() {
                return Err(error(
                    "reply_too_large",
                    "One row of this read exceeds the frame budget.",
                ));
            }
            self.more = true;
            return Ok(false);
        }
        self.bytes += size;
        self.rows.push(row);
        self.last = Some(key);
        Ok(true)
    }

    /// The page's rows under `name`, with `next` when there is more.
    pub(super) fn finish(self, keyset: &Keyset, name: &str) -> Value {
        let mut reply = json!({ name: self.rows });
        if self.more {
            if let Some(last) = &self.last {
                reply["next"] = json!(keyset.cursor(last));
            }
        }
        reply
    }
}

/// The owner a memory read names: `{level, owner?}`. A project must be one
/// the module has seen a session of; the person's own memories have the
/// fixed owner `self`, which the caller may leave out.
pub(super) fn owner(
    p: &Map<String, Value>,
    known: impl Fn(&str) -> bool,
) -> Result<(String, String), Refusal> {
    let level = string(p, "level")?;
    let owner = optional(p, "owner")?;
    match level {
        "global" => match owner {
            None | Some("self") => Ok(("global".into(), "self".into())),
            Some(_) => Err(invalid("owner")),
        },
        "project" => {
            let owner = owner.ok_or_else(|| invalid("owner"))?;
            if !known(owner) {
                return Err(project_unknown());
            }
            Ok(("project".into(), owner.into()))
        }
        "workspace" => Ok((
            "workspace".into(),
            owner.ok_or_else(|| invalid("owner"))?.into(),
        )),
        _ => Err(invalid("level")),
    }
}

/// A positive integer id parameter.
pub(super) fn id(p: &Map<String, Value>, key: &str) -> Result<i64, Refusal> {
    p.get(key)
        .and_then(Value::as_i64)
        .filter(|id| *id > 0)
        .ok_or_else(|| invalid(key))
}

/// Insert `value` under `key` only when it is known, so a field ck-mc
/// doesn't know is absent rather than null.
pub(super) fn put(row: &mut Value, key: &str, value: Option<Value>) {
    if let Some(value) = value.filter(|value| !value.is_null()) {
        row[key] = value;
    }
}
