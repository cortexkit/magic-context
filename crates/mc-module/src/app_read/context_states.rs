//! Bounded transcript-page state reads over the caller's store snapshots.
#![cfg_attr(not(test), expect(dead_code, reason = "consumed by app read dispatch"))]

use super::{
    admission::AppCaller,
    compartment, envelope,
    locator::{self, LocatedSession, SessionSource},
    part_ref, version,
};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use subc_client_rs::HandlerOutcome;

pub(crate) const PLACEMENT: &str =
    "SELECT message_ordinal FROM message_history_source WHERE session_id=?1 AND message_id=?2";
// This overlap query temporarily visits one session's compartment rows through
// its session/sequence unique index, without loading summary bodies or tiers.
// Installing idx_compartments_session_end on (session_id, end_message) will
// replace that session-sized read with a range lookup.
pub(crate) const OVERLAP: &str = "SELECT id,sequence,start_message,end_message,start_message_id,end_message_id,start_block_index,end_block_index FROM compartments WHERE session_id=?1 AND end_message>=?2 AND start_message<=?3 ORDER BY sequence";
pub(crate) const FIRST: &str =
    "SELECT start_message FROM compartments WHERE session_id=?1 ORDER BY sequence LIMIT 1";
pub(crate) const TEXT_TAGS: &str = "SELECT tag_number,message_id,type,status,byte_size,token_count,input_byte_size,input_token_count,drop_mode,tool_name FROM tags WHERE session_id=?1 AND message_id>=?2 AND message_id<?3 AND type IN ('message','file')";
const TOOL_TAGS: &str = "SELECT tag_number,message_id,type,status,byte_size,token_count,input_byte_size,input_token_count,drop_mode,tool_name,tool_owner_message_id FROM tags WHERE session_id=?1 AND type='tool' AND tool_owner_message_id";
pub(crate) const STAMP: &str = "SELECT queued_at FROM pending_ops WHERE session_id=?1 AND tag_id=?2 AND operation='drop' ORDER BY id LIMIT 1";
// Force the mid index: MIN(ordinal) otherwise filters a session-sized primary-key prefix by mid.
pub(crate) const ASYNC_PLACEMENT: &str =
    "SELECT ordinal,index_json FROM mc_async_compaction_entries WHERE session_ref=?1 AND mid=?2 AND ordinal=(SELECT MIN(ordinal) FROM mc_async_compaction_entries INDEXED BY idx_mc_async_compaction_entries_mid WHERE session_ref=?1 AND mid=?2)";
pub(crate) const ASYNC_TAGS: &str = "SELECT tag_number,block_id,kind,token_count,length(source_bytes) FROM mc_tags WHERE session_id=?1 AND block_id>=?2 AND block_id<?3";
pub(crate) const FROZEN: &str = "SELECT view_json FROM mc_async_compaction_baselines WHERE session_ref=?1 AND slot='frozen_edits'";
pub(crate) const QUEUED: &str =
    "SELECT target_id,queued_at FROM pending_agent_drops WHERE session_id=?1 ORDER BY queued_at,id";
pub(crate) const VIEWS: &str = "SELECT view_json FROM mc_async_compaction_views WHERE session_ref=?1 AND version>?2 ORDER BY version DESC LIMIT 1";

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

pub(crate) fn if_version(p: &Map<String, Value>) -> Result<Option<&str>, HandlerOutcome> {
    p.get("if_version")
        .map(|value| {
            value
                .as_str()
                .ok_or_else(|| envelope::invalid_field("params.if_version", "type", None))
        })
        .transpose()
}

/// Reuse an enclosing read transaction, or hold a deferred one until the reply
/// data and its version have both been read. Dropping it never changes data.
pub(crate) fn snapshot(connection: &Connection) -> Result<Option<Transaction<'_>>, HandlerOutcome> {
    if connection.is_autocommit() {
        connection
            .unchecked_transaction()
            .map(Some)
            .map_err(query_error)
    } else {
        Ok(None)
    }
}

struct Request {
    session: locator::SessionRef,
    ids: Vec<String>,
    if_version: Option<String>,
}

impl Request {
    fn parse(input: &Value) -> Result<Self, HandlerOutcome> {
        let p = envelope::object(input, "params")?;
        envelope::refuse_unknown(p, &["session", "message_ids", "if_version"], "params")?;
        let session =
            locator::SessionRef::parse(p.get("session").unwrap_or(&Value::Null), "params.session")?;
        let ids = p
            .get("message_ids")
            .and_then(Value::as_array)
            .ok_or_else(|| envelope::invalid_field("params.message_ids", "type", None))?;
        if ids.is_empty() || ids.len() > 100 {
            return Err(envelope::invalid_field(
                "params.message_ids",
                "range",
                Some(100),
            ));
        }
        let mut seen = HashSet::new();
        let ids = ids
            .iter()
            .enumerate()
            .map(|(i, value)| {
                let path = format!("params.message_ids.{i}");
                let id = value
                    .as_str()
                    .ok_or_else(|| envelope::invalid_field(&path, "type", None))?;
                if id.is_empty() || id.len() > 512 || id.contains('\0') {
                    return Err(envelope::invalid_field(&path, "range", Some(512)));
                }
                if !seen.insert(id) {
                    return Err(envelope::invalid_field(
                        "params.message_ids",
                        "duplicate",
                        None,
                    ));
                }
                Ok(id.to_owned())
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            session,
            ids,
            if_version: if_version(p)?.map(str::to_owned),
        })
    }
}

#[derive(Debug)]
struct Summary {
    id: i64,
    sequence: i64,
    first: i64,
    last: i64,
    first_id: Option<String>,
    last_id: Option<String>,
    start_block: Option<usize>,
    end_block: Option<usize>,
}

struct Part {
    reference: Value,
    kind: String,
    size: Value,
    dropped: bool,
    drop_mode: Option<String>,
    stamp: Option<(Option<i64>, &'static str)>,
    index: Option<usize>,
}

struct TagRow {
    tag_id: i64,
    tag_key: String,
    kind: String,
    status: String,
    size: Value,
    drop_mode: Option<String>,
    tool_name: Option<String>,
    owner: Option<String>,
}

fn tool_tags_sql(count: usize) -> String {
    let placeholders = (2..=count + 1)
        .map(|n| format!("?{n}"))
        .collect::<Vec<_>>()
        .join(",");
    format!("{TOOL_TAGS} IN ({placeholders})")
}

fn page_tools(
    context: &Connection,
    key: &str,
    ids: &[String],
) -> Result<HashMap<String, Vec<TagRow>>, HandlerOutcome> {
    let mut grouped: HashMap<String, Vec<TagRow>> = HashMap::new();
    let mut statement = context
        .prepare(&tool_tags_sql(ids.len()))
        .map_err(query_error)?;
    let args = std::iter::once(key).chain(ids.iter().map(String::as_str));
    for row in statement
        .query_map(rusqlite::params_from_iter(args), tag_row)
        .map_err(query_error)?
    {
        let row = row.map_err(query_error)?;
        if let Some(owner) = row.owner.clone() {
            grouped.entry(owner).or_default().push(row);
        }
    }
    Ok(grouped)
}

fn tag_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<TagRow> {
    let kind: String = r.get(2)?;
    let size = json!({"bytes":r.get::<_, Option<i64>>(4)?, "tokens":r.get::<_, Option<i64>>(5)?, "input_bytes":if kind == "tool" { r.get::<_, Option<i64>>(6)? } else { None }, "input_tokens":if kind == "tool" { r.get::<_, Option<i64>>(7)? } else { None }});
    Ok(TagRow {
        tag_id: r.get(0)?,
        tag_key: r.get(1)?,
        kind,
        status: r.get(3)?,
        size,
        drop_mode: r.get(8)?,
        tool_name: r.get(9)?,
        owner: if r.as_ref().column_count() > 10 {
            r.get(10)?
        } else {
            None
        },
    })
}

fn standalone_parts(
    context: &Connection,
    target: &LocatedSession,
    mid: &str,
    mut tags: Vec<TagRow>,
) -> Result<(Vec<Part>, bool), HandlerOutcome> {
    let key = target.context_session_id();
    tags.extend(
        context
            .prepare(TEXT_TAGS)
            .map_err(query_error)?
            .query_map(params![key, format!("{mid}:"), format!("{mid};")], tag_row)
            .map_err(query_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(query_error)?,
    );
    let mut parts = Vec::new();
    let mut compacted = false;
    for TagRow {
        tag_id,
        tag_key,
        kind,
        status,
        size,
        drop_mode,
        tool_name,
        ..
    } in tags
    {
        if status == "compacted" {
            compacted = true;
            continue;
        }
        if status != "active" && status != "dropped" {
            continue;
        }
        let reference = if kind == "tool" {
            Some(json!({"call_id":tag_key}))
        } else {
            part_ref::standalone_part_ref(&target.session.harness, &tag_key)
        };
        let Some(reference) = reference else {
            return Err(locator::store_error("unrecognized stored part address"));
        };
        let stamp = if status == "active" {
            context
                .query_row(STAMP, params![key, tag_id], |r| r.get::<_, Option<i64>>(0))
                .optional()
                .map_err(query_error)?
                .map(|time| (time, "queued"))
        } else {
            None
        };
        let index = reference
            .get("part_index")
            .or_else(|| reference.get("text_ordinal"))
            .and_then(Value::as_u64)
            .map(|n| n as usize);
        parts.push(Part {
            reference,
            kind: if kind == "tool" {
                tool_name.unwrap_or_else(|| "tool".into())
            } else if kind == "file" {
                "file".into()
            } else {
                "text".into()
            },
            size,
            dropped: status == "dropped",
            drop_mode,
            stamp,
            index,
        });
    }
    Ok((parts, compacted))
}

pub(crate) fn context_states(
    context: &Connection,
    store: &Connection,
    _caller: &AppCaller,
    params: &Value,
) -> HandlerOutcome {
    match read(context, store, params) {
        Ok(fields) => envelope::reply(
            "context.states",
            now_ms(),
            fields.as_object().expect("reply object").clone(),
        ),
        Err(error) => error,
    }
}

fn empty_message(
    mid: &str,
    state: &str,
    reason: Option<&str>,
    compartment: Option<i64>,
    split: Value,
) -> Value {
    json!({"message_id":mid,"state":state,"compartment_id":compartment.map(|id| id.to_string()),"outside_reason":reason,"split":split,"parts":{"tagged":0,"dropped":0,"stamped":0},"dropped_parts":[],"stamped_parts":[]})
}

fn raw_message(mid: &str, parts: Vec<Part>, split: Value) -> Value {
    let dropped: Vec<_> = parts.iter().filter(|p| p.dropped).map(|p| json!({"part_ref":p.reference,"kind":p.kind,"size":p.size,"drop_mode":p.drop_mode,"dropped_at_ms":null,"dropped_at_source":"not_recorded"})).collect();
    let stamped: Vec<_> = parts.iter().filter(|p| !p.dropped).filter_map(|p| p.stamp.map(|(time,stage)| json!({"part_ref":p.reference,"kind":p.kind,"size":p.size,"stamped_at_ms":time,"stamped_at_source":if time.is_some() { "recorded" } else { "not_recorded" },"stage":stage}))).collect();
    let state = if !parts.is_empty() && dropped.len() == parts.len() {
        "dropped"
    } else {
        "raw"
    };
    let mut message = empty_message(mid, state, None, None, split);
    message["parts"] =
        json!({"tagged":parts.len(),"dropped":dropped.len(),"stamped":stamped.len()});
    message["dropped_parts"] = json!(dropped);
    message["stamped_parts"] = json!(stamped);
    message
}

fn read(context: &Connection, store: &Connection, input: &Value) -> Result<Value, HandlerOutcome> {
    let request = Request::parse(input)?;
    let budget = ReadBudget::new(context, store);
    let _context_snapshot = snapshot(context)?;
    let _store_snapshot = snapshot(store)?;
    let (target, unmanaged) = match locator::locate(context, store, &request.session) {
        Ok(target) => (target, false),
        // Transcript existence belongs to the runner. For a standalone session
        // without a Magic Context session record, the page says it was never managed.
        Err(HandlerOutcome::ErrorWithDetail { code, .. })
            if code == "session_not_found" && request.session.runner == request.session.harness =>
        {
            (
                LocatedSession {
                    session: request.session.clone(),
                    source: SessionSource::Standalone,
                },
                true,
            )
        }
        Err(error) => return Err(error),
    };
    target.require_held_transcript()?;
    let mut version = version::session_version(
        context,
        store,
        &target,
        version::VersionRequest::States(&request.ids),
    )
    .map_err(query_error)?;
    if unmanaged {
        use sha2::Digest;
        version = format!(
            "cs1:{:x}",
            sha2::Sha256::digest(format!("never_managed:{version}"))
        );
    }
    if request.if_version.as_deref() == Some(version.as_str()) {
        return Ok(json!({"state":"unchanged","version":version}));
    }
    if unmanaged {
        return Ok(
            json!({"state":"ready","version":version,"session_kind":"standalone","moved_from_standalone":false,"messages":request.ids.iter().map(|mid| empty_message(mid,"outside",Some("never_managed"),None,Value::Null)).collect::<Vec<_>>(),"compartments":[]}),
        );
    }
    let key = target.context_session_id();
    let managed = context
        .query_row(locator::STANDALONE_LOOKUP, [key], |r| r.get::<_, String>(0))
        .optional()
        .map_err(query_error)?
        .is_some();
    let mut placements = HashMap::new();
    let mut indexes = HashMap::new();
    for mid in &request.ids {
        let placed = match &target.source {
            SessionSource::Standalone => context
                .query_row(PLACEMENT, params![key, mid], |r| r.get(0))
                .optional()
                .map_err(query_error)?,
            SessionSource::Async { reference, .. } => {
                let row: Option<(i64, String)> = store
                    .query_row(ASYNC_PLACEMENT, params![reference, mid], |r| {
                        Ok((r.get(0)?, r.get(1)?))
                    })
                    .optional()
                    .map_err(query_error)?;
                if let Some((ordinal, index)) = row {
                    indexes.insert(mid.clone(), index);
                    Some(ordinal)
                } else {
                    None
                }
            }
        };
        if let Some(ordinal) = placed {
            placements.insert(mid.clone(), ordinal);
        }
    }
    let first: Option<i64> = context
        .query_row(FIRST, [key], |r| r.get(0))
        .optional()
        .map_err(query_error)?;
    let mut summaries = Vec::new();
    if let (Some(lo), Some(hi)) = (placements.values().min(), placements.values().max()) {
        summaries = context
            .prepare(OVERLAP)
            .map_err(query_error)?
            .query_map(params![key, lo, hi], |r| {
                Ok(Summary {
                    id: r.get(0)?,
                    sequence: r.get(1)?,
                    first: r.get(2)?,
                    last: r.get(3)?,
                    first_id: r.get(4)?,
                    last_id: r.get(5)?,
                    start_block: r.get(6)?,
                    end_block: r.get(7)?,
                })
            })
            .map_err(query_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(query_error)?;
    }
    let async_state = match &target.source {
        SessionSource::Async { reference, .. } => Some(AsyncState::load(store, reference, key)?),
        _ => None,
    };
    let mut tool_tags = if matches!(target.source, SessionSource::Standalone) {
        page_tools(context, key, &request.ids)?
    } else {
        HashMap::new()
    };
    let mut touched = BTreeMap::new();
    let mut messages = Vec::new();
    for mid in &request.ids {
        let ordinal = placements.get(mid).copied();
        let covered: Vec<_> = summaries
            .iter()
            .filter(|s| ordinal.is_some_and(|o| o >= s.first && o <= s.last))
            .collect();
        for s in &covered {
            touched.insert(s.sequence, *s);
        }
        let (mut parts, compacted) = match &async_state {
            Some(state) => (
                state.parts(store, key, mid, ordinal, indexes.get(mid))?,
                false,
            ),
            None => standalone_parts(
                context,
                &target,
                mid,
                tool_tags.remove(mid).unwrap_or_default(),
            )?,
        };
        let (fully_covered, split) = coverage(&target, ordinal, &covered, &mut parts)?;
        let message = if fully_covered {
            empty_message(
                mid,
                "summarized",
                None,
                covered.first().map(|s| s.id),
                Value::Null,
            )
        } else if ordinal.zip(first).is_some_and(|(o, f)| o < f) {
            empty_message(
                mid,
                "outside",
                Some("before_first_compartment"),
                None,
                Value::Null,
            )
        } else if !parts.is_empty() || !split.is_null() {
            raw_message(mid, parts, split)
        } else if compacted {
            empty_message(mid, "summarized", None, None, Value::Null)
        } else if ordinal.is_some() {
            raw_message(mid, parts, Value::Null)
        } else {
            empty_message(
                mid,
                "outside",
                Some(if managed {
                    "not_indexed"
                } else {
                    "never_managed"
                }),
                None,
                Value::Null,
            )
        };
        messages.push(message);
    }
    let compartments = touched.values().map(|s| Ok(json!({"compartment_id":s.id.to_string(),"ordinal":s.sequence,"first_message_id":compartment::boundary_id(context,key,s.first,s.first_id.clone()).map_err(query_error)?,"last_message_id":compartment::boundary_id(context,key,s.last,s.last_id.clone()).map_err(query_error)?}))).collect::<Result<Vec<Value>,HandlerOutcome>>()?;
    let (kind, moved) = match target.source {
        SessionSource::Standalone => ("standalone", false),
        SessionSource::Async {
            moved_from_standalone,
            ..
        } => ("mode3", moved_from_standalone),
    };
    budget.check()?;
    Ok(
        json!({"state":"ready","version":version,"session_kind":kind,"moved_from_standalone":moved,"messages":messages,"compartments":compartments}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_read_test_store::TestStores;

    pub(super) fn caller() -> AppCaller {
        super::super::admission::admit(
            &super::super::admission::tests::phone_bind(),
            crate::DEFAULT_MODULE_ID,
            true,
        )
        .unwrap()
    }

    pub(super) fn response(outcome: HandlerOutcome) -> Value {
        match outcome {
            HandlerOutcome::Response(bytes) => {
                assert!(bytes.len() <= envelope::REPLY_LIMIT);
                serde_json::from_slice(&bytes).unwrap()
            }
            other => panic!("expected reply: {other:?}"),
        }
    }

    fn request(ids: &[&str]) -> Value {
        json!({"session":{"runner":"opencode","harness":"opencode","session":"s"},"message_ids":ids})
    }

    fn fixture() -> TestStores {
        let stores = TestStores::new();
        stores.context_sql(include_str!("../../testdata/app-read-d/states.sql"));
        stores
    }

    #[test]
    fn state_matrix_and_legacy_summary_boundaries() {
        let stores = fixture();
        let ids = [
            "raw",
            "all",
            "summarized",
            "before",
            "missing",
            "compacted",
            "zero",
        ];
        let reply = response(context_states(
            &stores.context,
            &stores.store,
            &caller(),
            &request(&ids),
        ));
        assert_eq!(reply["session_kind"], "standalone");
        assert_eq!(
            reply["messages"]
                .as_array()
                .unwrap()
                .iter()
                .map(|m| m["message_id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ids
        );
        let messages = &reply["messages"];
        assert_eq!(messages[0]["state"], "raw");
        assert_eq!(
            messages[0]["parts"],
            json!({"tagged":1,"dropped":0,"stamped":0})
        );
        assert_eq!(messages[1]["state"], "dropped");
        assert_eq!(messages[1]["parts"]["dropped"], 2);
        assert_eq!(messages[2]["state"], "summarized");
        assert_eq!(messages[2]["stamped_parts"], json!([]));
        assert_eq!(messages[3]["outside_reason"], "before_first_compartment");
        assert_eq!(messages[4]["outside_reason"], "not_indexed");
        assert_eq!(messages[5]["state"], "summarized");
        assert!(messages[5]["compartment_id"].is_null());
        assert_eq!(messages[6]["state"], "raw");
        assert_eq!(messages[6]["parts"]["tagged"], 0);
        assert_eq!(
            reply["compartments"],
            json!([{"compartment_id":"1","ordinal":1,"first_message_id":"old-first","last_message_id":"summarized"}])
        );
        let serialized = reply.to_string();
        assert!(!serialized.contains("tag_number"));
        assert!(!serialized.contains("tag_id"));
    }

    #[test]
    fn one_dropped_part_keeps_message_raw() {
        let stores = fixture();
        let reply = response(context_states(
            &stores.context,
            &stores.store,
            &caller(),
            &request(&["partial"]),
        ));
        let message = &reply["messages"][0];
        assert_eq!(message["state"], "raw");
        assert_eq!(
            message["parts"],
            json!({"tagged":2,"dropped":1,"stamped":0})
        );
        assert_eq!(
            message["dropped_parts"],
            json!([{"part_ref":{"part_index":4},"kind":"text","dropped_at_ms":null,"dropped_at_source":"not_recorded","size":{"bytes":14,"tokens":null,"input_bytes":null,"input_tokens":null},"drop_mode":"full"}])
        );
    }

    #[test]
    fn tool_drops_belong_to_owner_and_file_drops_use_stored_index() {
        let stores = fixture();
        let reply = response(context_states(
            &stores.context,
            &stores.store,
            &caller(),
            &request(&["owner", "call_123", "file"]),
        ));
        assert_eq!(
            reply["messages"][0]["dropped_parts"],
            json!([{"part_ref":{"call_id":"call_123"},"kind":"bash","dropped_at_ms":null,"dropped_at_source":"not_recorded","size":{"bytes":300,"tokens":75,"input_bytes":50,"input_tokens":12},"drop_mode":"skeleton_real"}])
        );
        assert_eq!(reply["messages"][1]["outside_reason"], "not_indexed");
        assert_eq!(
            reply["messages"][2]["dropped_parts"][0]["part_ref"],
            json!({"part_index":5})
        );
        assert_eq!(reply["messages"][2]["dropped_parts"][0]["kind"], "file");
    }

    #[test]
    fn stamps_stay_raw_then_move_to_dropped_and_disappear_when_summarized() {
        let stores = fixture();
        let p = request(&["stamp"]);
        let initial = response(context_states(
            &stores.context,
            &stores.store,
            &caller(),
            &p,
        ));
        let m = &initial["messages"][0];
        assert_eq!(m["state"], "raw");
        assert_eq!(m["parts"], json!({"tagged":1,"dropped":0,"stamped":1}));
        assert_eq!(m["stamped_parts"][0]["stamped_at_ms"], 123);
        assert_eq!(m["stamped_parts"][0]["stage"], "queued");
        assert_eq!(m["stamped_parts"][0]["size"]["bytes"], 64);
        stores.context_sql("UPDATE tags SET status='dropped' WHERE id=10; DELETE FROM pending_ops WHERE tag_id=10;");
        let applied = response(context_states(
            &stores.context,
            &stores.store,
            &caller(),
            &p,
        ));
        assert_ne!(initial["version"], applied["version"]);
        assert_eq!(applied["messages"][0]["state"], "dropped");
        assert_eq!(applied["messages"][0]["stamped_parts"], json!([]));
        assert_eq!(
            applied["messages"][0]["dropped_parts"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        stores.context_sql("UPDATE tags SET status='active' WHERE id=10; INSERT INTO pending_ops(session_id,tag_id,operation,queued_at) VALUES('s',10,'drop',200); INSERT INTO compartments(session_id,sequence,start_message,end_message,title,content,created_at) VALUES('s',2,11,11,'title','summary',300);");
        let summarized = response(context_states(
            &stores.context,
            &stores.store,
            &caller(),
            &p,
        ));
        assert_eq!(summarized["messages"][0]["state"], "summarized");
        assert_eq!(summarized["messages"][0]["stamped_parts"], json!([]));
    }

    #[test]
    fn never_managed_standalone_and_async_namespaces() {
        let stores = TestStores::new();
        let p = request(&["unknown"]);
        let reply = response(context_states(
            &stores.context,
            &stores.store,
            &caller(),
            &p,
        ));
        assert_eq!(reply["messages"][0]["outside_reason"], "never_managed");
        assert_eq!(reply["compartments"], json!([]));
        assert_eq!(reply["messages"][0]["stamped_parts"], json!([]));
        stores.async_session("opencode", "opencode", "s", 1, false);
        let reply = response(context_states(
            &stores.context,
            &stores.store,
            &caller(),
            &p,
        ));
        assert_eq!(reply["messages"][0]["outside_reason"], "never_managed");
        let stores = fixture();
        let p = json!({"session":{"runner":"pi","harness":"pi","session":"s"},"message_ids":["raw","summarized"]});
        let reply = response(context_states(
            &stores.context,
            &stores.store,
            &caller(),
            &p,
        ));
        assert!(reply["messages"]
            .as_array()
            .unwrap()
            .iter()
            .all(|m| m["outside_reason"] == "never_managed"));
        assert_eq!(reply["compartments"], json!([]));
    }

    #[test]
    fn ambiguous_reference_is_not_a_never_managed_page() {
        let stores = TestStores::new();
        stores.async_session("runner-a", "opencode", "s", 1, false);
        stores.async_session("runner-b", "opencode", "s", 1, false);
        assert!(
            matches!(context_states(&stores.context,&stores.store,&caller(),&request(&["m"])), HandlerOutcome::ErrorWithDetail {code,..} if code == "session_ambiguous")
        );
    }

    #[test]
    fn conditional_round_trip_skips_page_data_and_stamp_changes_version() {
        let stores = fixture();
        let mut p = request(&["raw"]);
        let ready = response(context_states(
            &stores.context,
            &stores.store,
            &caller(),
            &p,
        ));
        p["if_version"] = ready["version"].clone();
        // Removing a data table distinguishes an unchanged short circuit from
        // an accidental full page read that happens to return the same values.
        stores.context_sql("DROP TABLE message_history_source;");
        let unchanged = response(context_states(
            &stores.context,
            &stores.store,
            &caller(),
            &p,
        ));
        assert_eq!(unchanged.as_object().unwrap().len(), 5);
        assert_eq!(unchanged["state"], "unchanged");
        assert_eq!(unchanged["version"], ready["version"]);
        let stores = fixture();
        let a = response(context_states(
            &stores.context,
            &stores.store,
            &caller(),
            &request(&["raw"]),
        ));
        stores.context_sql("INSERT INTO pending_ops(session_id,tag_id,operation,queued_at) VALUES('s',1,'drop',200);");
        let b = response(context_states(
            &stores.context,
            &stores.store,
            &caller(),
            &request(&["raw"]),
        ));
        assert_ne!(a["version"], b["version"]);
        assert_eq!(b["messages"][0]["parts"]["stamped"], 1);
    }

    #[test]
    fn message_id_limits_and_nested_unknown_keys() {
        let stores = fixture();
        let mut p = request(&["m"]);
        p["message_ids"] = json!((0..100).map(|i| format!("m{i}")).collect::<Vec<_>>());
        assert_eq!(
            response(context_states(
                &stores.context,
                &stores.store,
                &caller(),
                &p
            ))["messages"]
                .as_array()
                .unwrap()
                .len(),
            100
        );
        p["message_ids"].as_array_mut().unwrap().push(json!("101"));
        assert!(
            matches!(context_states(&stores.context,&stores.store,&caller(),&p), HandlerOutcome::ErrorWithDetail {code,detail,..} if code=="invalid_params" && detail["limit"]==100)
        );
        for ids in [
            json!([]),
            json!(["m", "m"]),
            json!([""]),
            json!(["x".repeat(513)]),
            json!([1]),
        ] {
            p["message_ids"] = ids;
            assert!(
                matches!(context_states(&stores.context,&stores.store,&caller(),&p),HandlerOutcome::ErrorWithDetail {code,..} if code=="invalid_params")
            );
        }
        let mut p = request(&["m"]);
        p["if_version"] = json!(true);
        assert!(
            matches!(context_states(&stores.context,&stores.store,&caller(),&p),HandlerOutcome::ErrorWithDetail {detail,..} if detail["field"]=="params.if_version" && detail["reason"]=="type")
        );
        p["if_version"] = json!("");
        assert_eq!(
            response(context_states(
                &stores.context,
                &stores.store,
                &caller(),
                &p
            ))["state"],
            "ready"
        );
        let mut p = request(&["m"]);
        p["session"]["extra"] = json!(true);
        assert!(
            matches!(context_states(&stores.context,&stores.store,&caller(),&p),HandlerOutcome::ErrorWithDetail {detail,..} if detail["field"]=="params.session.extra" && detail["reason"]=="unknown")
        );
        let mut p = request(&["m"]);
        p["extra"] = json!(true);
        assert!(
            matches!(context_states(&stores.context,&stores.store,&caller(),&p),HandlerOutcome::ErrorWithDetail {detail,..} if detail["field"]=="params.extra")
        );
    }

    #[test]
    fn complete_states_reply_enforces_512_kib_escaped_cap() {
        let stores = fixture();
        stores.context_sql(&format!(
            "UPDATE tags SET tool_name='{}' WHERE id=6;",
            "\n".repeat(envelope::REPLY_LIMIT / 2)
        ));
        assert!(
            matches!(context_states(&stores.context,&stores.store,&caller(),&request(&["owner"])), HandlerOutcome::ErrorWithDetail {code,detail,..} if code=="reply_too_large" && detail["bytes"].as_u64().unwrap()>envelope::REPLY_LIMIT as u64)
        );
    }

    #[test]
    fn every_states_query_has_an_indexed_search_plan() {
        let stores = fixture();
        let c = &stores.context;
        TestStores::indexed(c, PLACEMENT, &[&"s", &"raw"]);
        TestStores::indexed(c, OVERLAP, &[&"s", &2, &11]);
        let plan: String = c
            .query_row(
                &format!("EXPLAIN QUERY PLAN {OVERLAP}"),
                params!["s", 2, 11],
                |r| r.get(3),
            )
            .unwrap();
        assert!(
            plan.contains("SEARCH compartments USING INDEX sqlite_autoindex_compartments_1"),
            "{plan}"
        );
        TestStores::indexed(c, FIRST, &[&"s"]);
        TestStores::indexed(c, TEXT_TAGS, &[&"s", &"m:", &"m;"]);
        for count in 1..=100 {
            let ids = vec!["owner".to_owned(); count];
            let args = std::iter::once("s".to_owned())
                .chain(ids)
                .collect::<Vec<_>>();
            let refs = args
                .iter()
                .map(|s| s as &dyn rusqlite::ToSql)
                .collect::<Vec<_>>();
            TestStores::indexed(c, &tool_tags_sql(count), &refs);
        }
        TestStores::indexed(c, STAMP, &[&"s", &10]);
        let placement_plans = stores
            .store
            .prepare(&format!("EXPLAIN QUERY PLAN {ASYNC_PLACEMENT}"))
            .unwrap()
            .query_map(["ref", "m"], |r| r.get::<_, String>(3))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert!(
            placement_plans.iter().all(|p| !p.contains("SCAN")
                && (p.contains("SUBQUERY") || (p.contains("SEARCH") && p.contains("USING INDEX")))),
            "{placement_plans:?}"
        );
        assert!(
            placement_plans
                .iter()
                .any(|p| p.contains("idx_mc_async_compaction_entries_mid") && p.contains("mid=?")),
            "{placement_plans:?}"
        );
        assert_eq!(
            placement_plans
                .iter()
                .filter(|p| p.contains("SEARCH"))
                .count(),
            2
        );
        TestStores::indexed(&stores.store, ASYNC_TAGS, &[&"key", &"m#", &"m$"]);
        TestStores::indexed(&stores.store, FROZEN, &[&"ref"]);
        TestStores::indexed(&stores.store, QUEUED, &[&"key"]);
        TestStores::indexed(&stores.store, VIEWS, &[&"ref", &0]);
    }

    #[test]
    fn page_read_timings_for_small_and_large_compartment_sessions() {
        for count in [50, 2000] {
            let stores = TestStores::new();
            stores.standalone("s", "opencode");
            let mut sql = String::new();
            for n in 1..=count {
                sql.push_str(&format!("INSERT INTO compartments(session_id,sequence,start_message,end_message,title,content,created_at) VALUES('s',{n},{},{},'title','summary',1);",n*10,n*10+9));
            }
            for n in 0..100 {
                sql.push_str(&format!("INSERT INTO message_history_source(session_id,message_id,message_ordinal,source_version,normalized_content_hash,role,updated_at) VALUES('s','m{n}',{},'v','h','user',1);",count*10-90+n));
            }
            stores.context_sql(&sql);
            let mut p = request(&["m"]);
            p["message_ids"] = json!((0..100).map(|n| format!("m{n}")).collect::<Vec<_>>());
            let mut times = Vec::new();
            for iteration in 0..110 {
                let start = std::time::Instant::now();
                let reply = response(context_states(
                    &stores.context,
                    &stores.store,
                    &caller(),
                    &p,
                ));
                assert_eq!(reply["messages"].as_array().unwrap().len(), 100);
                if iteration >= 10 {
                    times.push(start.elapsed().as_micros());
                }
            }
            times.sort_unstable();
            println!(
                "states timing compartments={count} messages=100 samples=100 p50_us={} p90_us={}",
                times[49], times[89]
            );
        }
    }
}

#[derive(Clone, Deserialize)]
struct FrozenPart {
    mid: String,
    part: String,
    digest: String,
    bytes: Option<String>,
}

type FrozenMap = HashSet<(String, String, String)>;
struct FrozenCache {
    database: String,
    reference: String,
    version: u64,
    drops: std::sync::Arc<FrozenMap>,
}
static FROZEN_CACHE: std::sync::Mutex<Option<FrozenCache>> = std::sync::Mutex::new(None);

fn frozen_drops(
    store: &Connection,
    reference: &str,
    version: Option<u64>,
) -> Result<std::sync::Arc<FrozenMap>, HandlerOutcome> {
    let database = store.path().unwrap_or_default();
    // A versioned baseline is immutable. Include the database path so separate
    // stores with the same runner reference cannot share cached edits. Keep one
    // bounded entry; in-memory databases and unversioned baselines bypass it.
    let cacheable = !database.is_empty() && version.is_some();
    if cacheable {
        if let Some(hit) = FROZEN_CACHE
            .lock()
            .expect("frozen cache lock")
            .as_ref()
            .filter(|c| {
                c.database == database && c.reference == reference && Some(c.version) == version
            })
        {
            return Ok(hit.drops.clone());
        }
    }
    let text: Option<String> = store
        .query_row(FROZEN, [reference], |r| r.get(0))
        .optional()
        .map_err(query_error)?;
    let parts: Vec<FrozenPart> =
        serde_json::from_str(text.as_deref().unwrap_or("[]")).map_err(locator::store_error)?;
    let drops = std::sync::Arc::new(
        parts
            .into_iter()
            .filter(|p| p.bytes.is_none())
            .map(|p| (p.mid, p.part, p.digest))
            .collect(),
    );
    if cacheable && text.as_ref().is_none_or(|s| s.len() <= 8 * 1024 * 1024) {
        *FROZEN_CACHE.lock().expect("frozen cache lock") = Some(FrozenCache {
            database: database.into(),
            reference: reference.into(),
            version: version.expect("versioned baseline"),
            drops: std::sync::Arc::clone(&drops),
        });
    }
    Ok(drops)
}

#[derive(Deserialize)]
struct PublishedView {
    #[serde(default)]
    ranges: Vec<PublishedRange>,
}
#[derive(Deserialize)]
struct PublishedRange {
    #[serde(default)]
    edits: Vec<PublishedEdit>,
}
#[derive(Deserialize)]
struct PublishedEdit {
    ordinal: i64,
    mid: String,
    part: String,
    #[serde(default)]
    drop: bool,
}

struct AsyncState {
    dropped: std::sync::Arc<FrozenMap>,
    queued: HashMap<String, Option<i64>>,
    published: HashSet<(i64, String, String)>,
}

impl AsyncState {
    fn load(store: &Connection, reference: &str, key: &str) -> Result<Self, HandlerOutcome> {
        let (_, text): (u64, String) = store
            .query_row(version::ASYNC_RECORD, [reference], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .map_err(query_error)?;
        let header: locator::AsyncHeader =
            serde_json::from_str(&text).map_err(locator::store_error)?;
        let dropped = frozen_drops(store, reference, header.frozen_edits_version)?;
        let mut queued = HashMap::new();
        let mut statement = store.prepare(QUEUED).map_err(query_error)?;
        for row in statement
            .query_map([key], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?))
            })
            .map_err(query_error)?
        {
            let (target, time) = row.map_err(query_error)?;
            queued.entry(target).or_insert(time);
        }
        let text: Option<String> = store
            .query_row(
                VIEWS,
                params![reference, header.applied.unwrap_or(0)],
                |r| r.get(0),
            )
            .optional()
            .map_err(query_error)?;
        let mut published = HashSet::new();
        if let Some(text) = text {
            let view: PublishedView = serde_json::from_str(&text).map_err(locator::store_error)?;
            for edit in view
                .ranges
                .into_iter()
                .flat_map(|r| r.edits)
                .filter(|e| e.drop)
            {
                published.insert((edit.ordinal, edit.mid, edit.part));
            }
        }
        Ok(Self {
            dropped,
            queued,
            published,
        })
    }

    fn parts(
        &self,
        store: &Connection,
        key: &str,
        mid: &str,
        ordinal: Option<i64>,
        index: Option<&String>,
    ) -> Result<Vec<Part>, HandlerOutcome> {
        // Without a current transcript index entry there is no part address.
        // An undo must not leave queued stamps visible on a removed message.
        let Some(index) = index else {
            return Ok(Vec::new());
        };
        let triples: Vec<[String; 3]> =
            serde_json::from_str(index).map_err(locator::store_error)?;
        let by_tag: HashMap<_, _> = triples
            .iter()
            .enumerate()
            .map(|(n, t)| (t[0].as_str(), (n, t)))
            .collect();
        let mut statement = store.prepare(ASYNC_TAGS).map_err(query_error)?;
        let tags = statement
            .query_map(params![key, format!("{mid}#"), format!("{mid}$")], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<i64>>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            })
            .map_err(query_error)?;
        let mut parts = Vec::new();
        for tag in tags {
            let (number, block, kind, tokens, bytes) = tag.map_err(query_error)?;
            let runner_tag = format!("§{number}§");
            let (position, triple) = by_tag
                .get(runner_tag.as_str())
                .copied()
                .or_else(|| by_tag.get(number.to_string().as_str()).copied())
                .ok_or_else(|| locator::store_error("tag has no runner part address"))?;
            let part_key = &triple[1];
            let dropped = self
                .dropped
                .contains(&(mid.into(), part_key.clone(), triple[2].clone()));
            let queued = self.queued.get(&block);
            let published = ordinal.is_some_and(|ordinal| {
                self.published
                    .contains(&(ordinal, mid.into(), part_key.clone()))
            });
            // Published edits do not say why a part was dropped. Require a
            // matching queued agent-drop target before showing a published
            // stamp; after that target is deleted, its stamp is invisible
            // until the runner acknowledges the drop.
            let stamp = if dropped {
                None
            } else if published && queued.is_some() {
                Some((queued.copied().flatten(), "published"))
            } else {
                queued.map(|time| (*time, "queued"))
            };
            let index = block
                .rsplit_once('#')
                .and_then(|(_, s)| s.parse::<usize>().ok())
                .unwrap_or(position);
            parts.push(Part { reference:json!({"part_key":part_key}),kind:if kind=="message" { "text".into() } else { "tool".into() },size:json!({"bytes":if bytes>0 { Some(bytes) } else { None },"tokens":tokens,"input_bytes":null,"input_tokens":null}),dropped,drop_mode:None,stamp,index:Some(index) });
        }
        Ok(parts)
    }
}

/// Both SQLite virtual machines share one deadline for the entire read.
pub(crate) struct ReadBudget<'a> {
    context: &'a Connection,
    store: &'a Connection,
    deadline: std::time::Instant,
}
impl<'a> ReadBudget<'a> {
    pub(crate) fn new(context: &'a Connection, store: &'a Connection) -> Self {
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(250);
        context.progress_handler(1000, Some(move || std::time::Instant::now() >= deadline));
        store.progress_handler(1000, Some(move || std::time::Instant::now() >= deadline));
        Self {
            context,
            store,
            deadline,
        }
    }
    pub(crate) fn check(&self) -> Result<(), HandlerOutcome> {
        if std::time::Instant::now() >= self.deadline {
            Err(budget_error())
        } else {
            Ok(())
        }
    }
}
impl Drop for ReadBudget<'_> {
    fn drop(&mut self) {
        self.context.progress_handler(0, None::<fn() -> bool>);
        self.store.progress_handler(0, None::<fn() -> bool>);
    }
}
fn budget_error() -> HandlerOutcome {
    locator::refusal(
        "read_budget_exceeded",
        "The session read exceeded its time budget.",
        Value::Null,
    )
}
pub(crate) fn query_error(error: rusqlite::Error) -> HandlerOutcome {
    if matches!(&error,rusqlite::Error::SqliteFailure(e,_) if e.code==rusqlite::ErrorCode::OperationInterrupted)
    {
        budget_error()
    } else {
        locator::store_error(error)
    }
}

fn coverage(
    target: &LocatedSession,
    ordinal: Option<i64>,
    summaries: &[&Summary],
    parts: &mut Vec<Part>,
) -> Result<(bool, Value), HandlerOutcome> {
    if summaries.is_empty() {
        return Ok((false, Value::Null));
    }
    let mut intervals: Vec<_> = summaries
        .iter()
        .map(|s| {
            (
                if ordinal == Some(s.first) {
                    s.start_block.unwrap_or(0)
                } else {
                    0
                },
                if ordinal == Some(s.last) {
                    s.end_block.unwrap_or(usize::MAX)
                } else {
                    usize::MAX
                },
            )
        })
        .collect();
    intervals.sort_unstable();
    let (from, mut through) = intervals[0];
    for (next_from, next_through) in intervals.into_iter().skip(1) {
        if next_from > through.saturating_add(1) {
            return Err(locator::store_error(
                "disjoint summary intervals within a message",
            ));
        }
        through = through.max(next_through);
    }
    if from == 0 && through == usize::MAX {
        return Ok((true, Value::Null));
    }
    let reference = |index| -> Result<Value, HandlerOutcome> {
        if let Some(part) = parts.iter().find(|p| p.index == Some(index)) {
            return Ok(part.reference.clone());
        }
        match target.source {
            SessionSource::Standalone => Ok(if target.session.harness == "pi" {
                json!({"text_ordinal":index})
            } else {
                json!({"part_index":index})
            }),
            SessionSource::Async { .. } => Err(locator::store_error(
                "summary boundary has no runner part address",
            )),
        }
    };
    let mut split = json!({"compartment_id":summaries[0].id.to_string(),"side":if from==0 { "end" } else if through==usize::MAX { "start" } else { "middle" }});
    if from > 0 {
        split["from"] = reference(from)?;
    }
    if through < usize::MAX {
        split["through"] = reference(through)?;
    }
    parts.retain(|p| p.index.is_none_or(|i| i < from || i > through));
    Ok((false, split))
}

#[cfg(test)]
mod boundary_tests {
    use super::*;
    use crate::app_read_test_store::TestStores;

    fn page(bounds: &str) -> Value {
        let stores = TestStores::new();
        stores.standalone("s", "opencode");
        let mut sql = "INSERT INTO message_history_source(session_id,message_id,message_ordinal,source_version,normalized_content_hash,role,updated_at) VALUES('s','m',20,'v','h','user',1);".to_owned();
        for n in 0..6 {
            sql.push_str(&format!("INSERT INTO tags(session_id,message_id,type,status,tag_number) VALUES('s','m:p{n}','message','active',{});",n+1));
        }
        sql.push_str(bounds);
        stores.context_sql(&sql);
        let p = json!({"session":{"runner":"opencode","harness":"opencode","session":"s"},"message_ids":["m"]});
        tests::response(context_states(
            &stores.context,
            &stores.store,
            &tests::caller(),
            &p,
        ))
    }
    #[test]
    fn end_boundary_summarizes_prefix_only() {
        let reply=page("INSERT INTO compartments(session_id,sequence,start_message,end_message,end_block_index,title,content,created_at) VALUES('s',1,19,20,2,'end','summary',1);");
        assert_eq!(
            reply["messages"][0]["split"],
            json!({"compartment_id":"1","side":"end","through":{"part_index":2}})
        );
        assert_eq!(reply["messages"][0]["parts"]["tagged"], 3);
    }
    #[test]
    fn start_boundary_summarizes_suffix_only() {
        let reply=page("INSERT INTO compartments(session_id,sequence,start_message,end_message,start_block_index,title,content,created_at) VALUES('s',1,20,21,3,'start','summary',1);");
        assert_eq!(
            reply["messages"][0]["split"],
            json!({"compartment_id":"1","side":"start","from":{"part_index":3}})
        );
        assert_eq!(reply["messages"][0]["parts"]["tagged"], 3);
    }
    #[test]
    fn middle_boundary_leaves_prefix_and_suffix_raw() {
        let reply=page("INSERT INTO compartments(session_id,sequence,start_message,end_message,start_block_index,end_block_index,title,content,created_at) VALUES('s',1,20,20,2,3,'middle','summary',1);");
        assert_eq!(
            reply["messages"][0]["split"],
            json!({"compartment_id":"1","side":"middle","from":{"part_index":2},"through":{"part_index":3}})
        );
        assert_eq!(reply["messages"][0]["parts"]["tagged"], 4);
    }
    #[test]
    fn meeting_summaries_cover_the_message_and_list_both() {
        let reply=page("INSERT INTO compartments(session_id,sequence,start_message,end_message,end_block_index,title,content,created_at) VALUES('s',1,19,20,2,'first','summary',1); INSERT INTO compartments(session_id,sequence,start_message,end_message,start_block_index,title,content,created_at) VALUES('s',2,20,21,3,'second','summary',1);");
        assert_eq!(reply["messages"][0]["state"], "summarized");
        assert!(reply["messages"][0]["split"].is_null());
        assert_eq!(reply["compartments"].as_array().unwrap().len(), 2);
    }
}

#[cfg(test)]
mod async_tests {
    use super::*;
    use crate::app_read_test_store::TestStores;

    fn setup() -> (TestStores, String, String) {
        let stores = TestStores::new();
        let namespace = stores.async_session("runner", "pi", "s", 1, false);
        let key = crate::providers::Key {
            runner: "runner".into(),
            harness: "pi".into(),
            session: "s".into(),
        };
        let reference = key.reference();
        // Keep the runner tags sparse and out of array order: part positions
        // and engine tag numbers are not interchangeable identifiers.
        stores.store_sql(&format!("INSERT INTO mc_async_compaction_entries(session_ref,session,ordinal,entry_json,index_json,mid) VALUES('{reference}','s',3,'{{\"ordinal\":3,\"mid\":\"m3\",\"bytes\":\"[]\"}}','[[\"§9§\",\"prt_3b\",\"digest-b\"],[\"§4§\",\"prt_3a\",\"digest-a\"]]','m3'); INSERT INTO mc_tags(session_id,tag_number,block_id,kind,token_count,created_at_ms,source_bytes) VALUES('{namespace}',4,'m3#0','message',10,1,X'616263'),('{namespace}',9,'m3#2','tool_result',20,1,X'');"));
        (stores, namespace, reference)
    }
    fn request() -> Value {
        json!({"session":{"runner":"runner","harness":"pi","session":"s"},"message_ids":["m3"]})
    }
    fn page(stores: &TestStores) -> Value {
        tests::response(context_states(
            &stores.context,
            &stores.store,
            &tests::caller(),
            &request(),
        ))
    }

    #[test]
    fn mode3_frozen_part_drop_uses_part_key_and_current_digest() {
        let (stores, _, reference) = setup();
        let baseline =
            include_str!("../../testdata/app-read-d/frozen-edits.json").replace('\'', "''");
        stores.store_sql(&format!("INSERT INTO mc_async_compaction_baselines(session_ref,session,slot,view_json) VALUES('{reference}','s','frozen_edits','{baseline}'); UPDATE mc_async_compaction SET state_json=json_set(state_json,'$.frozen_edits_version',1);"));
        let reply = page(&stores);
        assert_eq!(reply["session_kind"], "mode3");
        assert_eq!(
            reply["messages"][0]["parts"],
            json!({"tagged":2,"dropped":1,"stamped":0})
        );
        assert_eq!(
            reply["messages"][0]["dropped_parts"],
            json!([{"part_ref":{"part_key":"prt_3b"},"kind":"tool","size":{"bytes":null,"tokens":20,"input_bytes":null,"input_tokens":null},"drop_mode":null,"dropped_at_ms":null,"dropped_at_source":"not_recorded"}])
        );
        // Changing frozen_edits_version invalidates the cached edits.
        stores.store_sql("UPDATE mc_async_compaction SET state_json=json_set(state_json,'$.frozen_edits_version',2); UPDATE mc_async_compaction_baselines SET view_json='[]';");
        assert_eq!(page(&stores)["messages"][0]["parts"]["dropped"], 0);
    }

    #[test]
    fn mode3_queue_publish_acknowledgement_moves_stamp_to_drop() {
        let (stores, namespace, reference) = setup();
        stores.store_sql(&format!("INSERT INTO pending_agent_drops(session_id,target_id,queued_at) VALUES('{namespace}','m3#2',123);"));
        let queued = page(&stores);
        assert_eq!(queued["messages"][0]["state"], "raw");
        assert_eq!(
            queued["messages"][0]["stamped_parts"][0]["part_ref"],
            json!({"part_key":"prt_3b"})
        );
        assert_eq!(queued["messages"][0]["stamped_parts"][0]["stage"], "queued");
        assert_eq!(
            queued["messages"][0]["stamped_parts"][0]["stamped_at_ms"],
            123
        );
        let vector: Value = serde_json::from_str(include_str!(
            "../../testdata/compaction-provider-v1/async.json"
        ))
        .unwrap();
        let view = vector["views"]
            .as_array()
            .and_then(|v| v.iter().find(|v| v["view"]["view_version"] == 3))
            .expect("published part-edit fixture")["view"]
            .to_string()
            .replace('\'', "''");
        stores.store_sql(&format!("INSERT INTO mc_async_compaction_views(session_ref,session,version,view_json) VALUES('{reference}','s',3,'{view}');"));
        let published = page(&stores);
        assert_ne!(queued["version"], published["version"]);
        assert_eq!(published["messages"][0]["parts"]["dropped"], 0);
        assert_eq!(
            published["messages"][0]["stamped_parts"][0]["stage"],
            "published"
        );
        stores.store_sql("DELETE FROM pending_agent_drops;");
        let consumed = page(&stores);
        assert_eq!(consumed["messages"][0]["stamped_parts"], json!([]));
        assert_eq!(consumed["messages"][0]["dropped_parts"], json!([]));
        stores.store_sql(&format!("INSERT INTO mc_async_compaction_baselines(session_ref,session,slot,view_json) VALUES('{reference}','s','frozen_edits','[{{\"mid\":\"m3\",\"part\":\"prt_3b\",\"digest\":\"digest-b\",\"bytes\":null}}]'); UPDATE mc_async_compaction SET state_json=json_set(state_json,'$.applied',3,'$.frozen_edits_version',1);"));
        let applied = page(&stores);
        assert_ne!(published["version"], applied["version"]);
        assert_eq!(applied["messages"][0]["stamped_parts"], json!([]));
        assert_eq!(
            applied["messages"][0]["dropped_parts"][0]["part_ref"],
            json!({"part_key":"prt_3b"})
        );
    }
    #[test]
    fn automatic_unacknowledged_drop_is_not_an_agent_stamp() {
        let (stores, _, reference) = setup();
        stores.store_sql(&format!("INSERT INTO mc_async_compaction_views(session_ref,session,version,view_json) VALUES('{reference}','s',1,'{{\"ranges\":[{{\"kind\":\"keep\",\"edits\":[{{\"ordinal\":3,\"mid\":\"m3\",\"part\":\"prt_3b\",\"drop\":true}}]}}]}}');"));
        let reply = page(&stores);
        assert_eq!(reply["messages"][0]["stamped_parts"], json!([]));
        assert_eq!(reply["messages"][0]["dropped_parts"], json!([]));
    }

    #[test]
    fn mode3_summarized_messages_hide_stamps_and_resync_refuses() {
        let (stores, namespace, _) = setup();
        stores.store_sql(&format!("INSERT INTO pending_agent_drops(session_id,target_id,queued_at) VALUES('{namespace}','m3#2',123);"));
        stores.context_sql(&format!("INSERT INTO compartments(session_id,sequence,start_message,end_message,start_message_id,end_message_id,title,content,created_at) VALUES('{namespace}',1,3,3,'m3','m3','title','summary',1);"));
        let reply = page(&stores);
        assert_eq!(reply["messages"][0]["state"], "summarized");
        assert_eq!(reply["messages"][0]["stamped_parts"], json!([]));
        stores.store_sql("UPDATE mc_async_compaction SET state_json=json_set(state_json,'$.resync',json('true'));");
        assert!(
            matches!(context_states(&stores.context,&stores.store,&tests::caller(),&request()),HandlerOutcome::ErrorWithDetail {code,..} if code=="session_resyncing")
        );
    }
}

#[cfg(test)]
mod address_tests {
    use super::*;
    use crate::app_read_test_store::TestStores;

    #[test]
    fn legacy_pi_message_retains_positional_content_and_file_addresses() {
        let stores = TestStores::new();
        stores.standalone("s", "pi");
        stores.context_sql("INSERT INTO tags(session_id,message_id,type,status,tag_number,byte_size) VALUES('s','m:p2','message','dropped',1,10),('s','m:mc-text-v1:vector:content:o1','message','dropped',2,20),('s','m:file4','file','dropped',3,30);");
        let p = json!({"session":{"runner":"pi","harness":"pi","session":"s"},"message_ids":["m"]});
        let reply = tests::response(context_states(
            &stores.context,
            &stores.store,
            &tests::caller(),
            &p,
        ));
        let references: Vec<_> = reply["messages"][0]["dropped_parts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["part_ref"].clone())
            .collect();
        assert!(references.contains(&json!({"text_ordinal":2})));
        assert!(references.contains(&json!({"content_key":"mc-text-v1:vector:content:o1"})));
        assert!(references.contains(&json!({"part_index":4})));
        assert_eq!(reply["messages"][0]["parts"]["dropped"], 3);
    }
    #[test]
    fn stamp_tag_id_is_the_tag_number_not_the_tags_row_id() {
        let stores = TestStores::new();
        stores.standalone("s", "opencode");
        stores.context_sql("INSERT INTO tags(id,session_id,message_id,type,status,tag_number) VALUES(700,'s','m:p2','message','active',42); INSERT INTO pending_ops(session_id,tag_id,operation,queued_at) VALUES('s',42,'drop',123);");
        let p = json!({"session":{"runner":"opencode","harness":"opencode","session":"s"},"message_ids":["m"]});
        let reply = tests::response(context_states(
            &stores.context,
            &stores.store,
            &tests::caller(),
            &p,
        ));
        assert_eq!(reply["messages"][0]["parts"]["stamped"], 1);
        assert_eq!(
            reply["messages"][0]["stamped_parts"][0]["stamped_at_ms"],
            123
        );
    }
}
