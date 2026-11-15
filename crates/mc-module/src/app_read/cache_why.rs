//! `context.cache_why {session, views}`: ck-mc's record of why it built each
//! of the views a session's requests rendered under.
//!
//! The runner reports, with each step, the version of the view the request
//! was rendered with. When two consecutive steps of a session name different
//! versions, an app asks here for ck-mc's record of each: what caused the
//! view, what it dropped, whether it folded the history head, and how far
//! the runner took it. A version ck-mc has no record of, because another
//! provider built it, no such view existed, or its record has expired, is
//! listed as missing.

use super::*;
use crate::store::{VIEW_DECISION_RETENTION_DAYS, VIEW_DECISION_RETENTION_MS};
use std::collections::BTreeSet;

/// The most view versions one request may name.
const MAX_VIEWS: usize = 100;

/// Record fields kept in the store but not served: `producer_ref` is always
/// null, and `decision` is always `publish`.
const NOT_SERVED: [&str; 2] = ["producer_ref", "decision"];

/// The reply fields for the requested `views`. `kept` is what the session
/// holds in memory, its newest records, which may be newer than the stored
/// rows; any other version is looked up in the store. A record made more
/// than the retention period before `now_ms` counts as missing, even while
/// memory still holds it, so a version reads the same before and after the
/// store deletes it.
pub(super) fn views(
    store: Option<&Connection>,
    key: &SessionRef,
    kept: &[Value],
    views: &Value,
    now_ms: u64,
) -> Result<Value, Refusal> {
    let requested = versions(views)?;
    let since = now_ms.saturating_sub(VIEW_DECISION_RETENTION_MS);
    let current = |record: &Value| record["at_ms"].as_u64().is_some_and(|at| at >= since);
    let unreadable = |_| {
        error(
            "store_unavailable",
            "The session's view decisions could not be read.",
        )
    };
    let mut decisions = Vec::new();
    let mut missing = Vec::new();
    for version in requested {
        let record = match kept
            .iter()
            .rev()
            .find(|record| record["view_version"] == version)
        {
            Some(record) => Some(record.clone()),
            None => match store {
                Some(conn) => {
                    crate::store::view_decision(conn, key, version).map_err(unreadable)?
                }
                None => None,
            },
        };
        match record.filter(current) {
            Some(mut record) => {
                if let Some(fields) = record.as_object_mut() {
                    for field in NOT_SERVED {
                        fields.remove(field);
                    }
                }
                decisions.push(record);
            }
            None => missing.push(version),
        }
    }
    let in_memory = kept
        .iter()
        .filter_map(|record| record["at_ms"].as_u64())
        .filter(|at| *at >= since)
        .min();
    let stored = match store {
        Some(conn) => {
            crate::store::oldest_view_decision_at(conn, key, since).map_err(unreadable)?
        }
        None => None,
    };
    let oldest = in_memory.into_iter().chain(stored).min();
    Ok(json!({
        "state": "ready",
        "decisions": decisions,
        "missing": missing,
        "retention": {"days": VIEW_DECISION_RETENTION_DAYS, "oldest_at_ms": oldest},
    }))
}

/// The requested versions in ascending order: 1 to [`MAX_VIEWS`] distinct
/// non-negative integers.
fn versions(views: &Value) -> Result<BTreeSet<u64>, Refusal> {
    let list = views
        .as_array()
        .filter(|list| (1..=MAX_VIEWS).contains(&list.len()))
        .ok_or_else(|| invalid("views"))?;
    let mut versions = BTreeSet::new();
    for version in list {
        let version = version.as_u64().ok_or_else(|| invalid("views"))?;
        if !versions.insert(version) {
            return Err(invalid("views"));
        }
    }
    Ok(versions)
}
