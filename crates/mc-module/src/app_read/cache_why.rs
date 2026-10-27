//! Standalone reasons join by assistant-message id. Async reasons are window-only:
//! preparing a view does not identify the runner step that later used it.
#![cfg_attr(not(test), allow(dead_code))]

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use subc_client_rs::HandlerOutcome;

use super::{admission::AppCaller, envelope, locator};
use locator::{SessionRef, SessionSource};

const META: &str = "SELECT last_usage_context_limit,detected_context_limit,detected_context_limit_model_key,detected_context_limit_provenance,cache_ttl,last_transform_error FROM session_meta WHERE session_id=?1";
const FLOOR: &str = "SELECT MIN(ts_ms) FROM transform_decisions WHERE session_id=?1 AND harness=?2";
const COLUMNS: &str = "message_id,ts_ms,decision,materialized,materialize_reason,system_hash_prev,system_hash_new,m0_tool_set_hash_prev,m0_tool_set_hash_new,m0_model_key_prev,m0_model_key_new,emergency,dropped_tokens,dropped_count,input_tokens";
const HISTORY: &str = "SELECT seq,entry FROM mc_pass_trace_history WHERE session_id=?1 AND kind='scheduler' ORDER BY seq DESC LIMIT 256";
const CACHE_META: &str = "SELECT meta FROM mc_cache_state WHERE session_id=?1";
const ERROR: &str =
    "SELECT last_reject_error,last_reject_at_ms FROM mc_pass_trace WHERE session_id=?1";
const CURSOR_ROW: &str =
    "SELECT session_id,harness,ts_ms,message_id FROM transform_decisions WHERE rowid=?1";

fn decision_sql(producer: bool) -> String {
    if producer {
        format!("SELECT {COLUMNS} FROM transform_decisions WHERE session_id=?1 AND harness=?2 AND message_id=?3")
    } else {
        format!("SELECT {COLUMNS},rowid FROM transform_decisions WHERE session_id=?1 AND harness=?2 AND ts_ms>=?3 AND ts_ms<=?4 AND (?5 IS NULL OR (ts_ms,message_id)<(?5,?6)) ORDER BY ts_ms DESC,message_id DESC LIMIT ?7")
    }
}

#[derive(Clone)]
struct Producer {
    reference: String,
    at_ms: Option<i64>,
}

struct Request {
    session: SessionRef,
    producers: Option<Vec<Producer>>,
    from: Option<i64>,
    to: Option<i64>,
    limit: usize,
    after: Option<Cursor>,
    digest: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    op: String,
    digest: String,
    source: String,
    at: i64,
    // Standalone resolves rowid back to the assistant id; the scheduler ring uses seq.
    key: String,
    hash: Option<String>,
}

fn id_hash(id: &str) -> String {
    URL_SAFE_NO_PAD.encode(&Sha256::digest(id.as_bytes())[..16])
}

fn time(value: Option<&Value>, field: &str) -> Result<Option<i64>, HandlerOutcome> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_i64()
            .map(Some)
            .ok_or_else(|| envelope::invalid_field(field, "type", None)),
    }
}

fn cursor_error(code: &str) -> HandlerOutcome {
    locator::refusal(
        code,
        "The cache decision cursor is invalid for this read.",
        Value::Null,
    )
}

impl Request {
    fn parse(p: &Map<String, Value>) -> Result<Self, HandlerOutcome> {
        envelope::refuse_unknown(
            p,
            &["session", "producers", "window", "limit", "cursor"],
            "params",
        )?;
        let session =
            SessionRef::parse(p.get("session").unwrap_or(&Value::Null), "params.session")?;
        let producers = p.get("producers").filter(|v| !v.is_null());
        let window = p.get("window").filter(|v| !v.is_null());
        if producers.is_some() == window.is_some() {
            return Err(envelope::invalid_field("params", "exclusive", None));
        }
        let producers = producers
            .map(|value| {
                let list = value
                    .as_array()
                    .ok_or_else(|| envelope::invalid_field("params.producers", "type", None))?;
                if list.is_empty() || list.len() > 100 {
                    return Err(envelope::invalid_field(
                        "params.producers",
                        "range",
                        Some(100),
                    ));
                }
                list.iter()
                    .enumerate()
                    .map(|(i, value)| {
                        let path = format!("params.producers.{i}");
                        let object = envelope::object(value, &path)?;
                        envelope::refuse_unknown(object, &["producer_ref", "at_ms"], &path)?;
                        let reference = object
                            .get("producer_ref")
                            .and_then(Value::as_str)
                            .ok_or_else(|| {
                                envelope::invalid_field(
                                    &format!("{path}.producer_ref"),
                                    "type",
                                    None,
                                )
                            })?;
                        if reference.is_empty() || reference.len() > 512 || reference.contains('\0')
                        {
                            return Err(envelope::invalid_field(
                                &format!("{path}.producer_ref"),
                                "range",
                                Some(512),
                            ));
                        }
                        Ok(Producer {
                            reference: reference.into(),
                            at_ms: time(object.get("at_ms"), &format!("{path}.at_ms"))?,
                        })
                    })
                    .collect::<Result<Vec<_>, HandlerOutcome>>()
            })
            .transpose()?;
        let (from, to) = if let Some(window) = window {
            let window = envelope::object(window, "params.window")?;
            envelope::refuse_unknown(window, &["from_ms", "to_ms"], "params.window")?;
            (
                time(window.get("from_ms"), "params.window.from_ms")?,
                time(window.get("to_ms"), "params.window.to_ms")?,
            )
        } else {
            (None, None)
        };
        if from.zip(to).is_some_and(|(a, b)| a > b) {
            return Err(envelope::invalid_field("params.window", "range", None));
        }
        let limit = match p.get("limit") {
            None | Some(Value::Null) => 100,
            Some(v) => {
                if !v.is_u64() && !v.is_i64() {
                    return Err(envelope::invalid_field("params.limit", "type", None));
                }
                v.as_u64()
                    .filter(|n| (1..=200).contains(n))
                    .ok_or_else(|| envelope::invalid_field("params.limit", "range", Some(200)))?
                    as usize
            }
        };
        if producers.is_some()
            && ["limit", "cursor"]
                .iter()
                .any(|key| p.get(*key).is_some_and(|v| !v.is_null()))
        {
            return Err(envelope::invalid_field(
                "params.producers",
                "exclusive",
                None,
            ));
        }
        let digest = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&json!(["context.cache_why", session, from, to])).unwrap()
            )
        );
        let after = match p.get("cursor") {
            None | Some(Value::Null) => None,
            Some(v) => {
                let text = v
                    .as_str()
                    .filter(|s| s.len() <= 512)
                    .ok_or_else(|| cursor_error("cursor_invalid"))?;
                let bytes = URL_SAFE_NO_PAD
                    .decode(text)
                    .map_err(|_| cursor_error("cursor_invalid"))?;
                let cursor: Cursor =
                    serde_json::from_slice(&bytes).map_err(|_| cursor_error("cursor_invalid"))?;
                if cursor.op != "context.cache_why" || cursor.digest != digest {
                    return Err(cursor_error("cursor_mismatch"));
                }
                Some(cursor)
            }
        };
        Ok(Self {
            session,
            producers,
            from,
            to,
            limit,
            after,
            digest,
        })
    }
}

fn canonical(harness: &str, raw: Option<&str>, materialized: bool) -> Option<String> {
    let raw = raw.unwrap_or("").trim();
    let reason = match raw {
        "" => return materialized.then(|| "pressure_refold".into()),
        "model_key" => "model_change",
        "pressure" => "pressure_refold",
        "project_memory_change" if harness == "pi" => "project_memory_epoch",
        "pending_mutations" if harness == "pi" => "max_mutation_id",
        "renderer_upgrade" if harness == "pi" => "upgrade_state",
        "cache_invalid" if harness == "pi" => "cached_m1_missing",
        "drift" if harness == "pi" => "pressure_refold",
        "system_hash"
        | "model_change"
        | "project_memory_epoch"
        | "ttl_idle"
        | "explicit_flush"
        | "user_flush"
        | "fit_retry"
        | "pending_materialization"
        | "variant_change"
        | "recomp"
        | "boundary_repair"
        | "host_history_change"
        | "thinking_hold"
        | "mutation_drift"
        | "max_mutation_id"
        | "first_render"
        | "pressure_refold"
        | "upgrade_state"
        | "cached_m1_missing"
        | "project_change"
        | "compartment_render_epoch"
        | "m1_delta"
        | "ttl_expiry"
        | "epoch_change"
        | "coverage_fold"
        | "profile_transition"
        | "host_compaction"
        | "tag_identity_repair" => raw,
        _ => return None,
    };
    Some(reason.into())
}

fn cause(harness: &str, raw: Option<&str>, materialized: bool) -> (Value, Value) {
    if let Some(released) = raw.and_then(|s| s.strip_prefix("lkg_frozen_release:")) {
        let (release, reason) = released
            .split_once(";materialize_reason=")
            .map(|(release, reason)| (release, Some(reason)))
            .unwrap_or((released, None));
        return (
            json!(canonical(harness, reason, materialized)),
            json!({"lkg_frozen_release":release}),
        );
    }
    (json!(canonical(harness, raw, materialized)), Value::Null)
}

fn standalone_row(row: &Row<'_>, harness: &str) -> rusqlite::Result<Value> {
    let materialized: bool = row.get(3)?;
    let raw: Option<String> = row.get(4)?;
    let (cause, detail) = cause(harness, raw.as_deref(), materialized);
    let a: Option<String> = row.get(5)?;
    let b: Option<String> = row.get(6)?;
    let c: Option<String> = row.get(7)?;
    let d: Option<String> = row.get(8)?;
    let prev: Option<String> = row.get(9)?;
    let new: Option<String> = row.get(10)?;
    let changed = |a: &Option<String>, b: &Option<String>| {
        if a.is_none() && b.is_none() {
            Value::Null
        } else {
            json!(a != b)
        }
    };
    Ok(
        json!({"producer_ref":row.get::<_,String>(0)?,"at_ms":row.get::<_,i64>(1)?,"decision":row.get::<_,String>(2)?,"materialized":materialized,"cause":cause,"cause_detail":detail,"emergency":row.get::<_,bool>(11)?,"dropped_tokens":row.get::<_,i64>(12)?,"dropped_count":row.get::<_,i64>(13)?,"input_tokens":row.get::<_,i64>(14)?,"changes":{"system_prompt":if materialized { changed(&a,&b) } else { Value::Null },"model":if prev.is_none() && new.is_none() { Value::Null } else {json!({"prev":prev,"new":new})},"tool_set":changed(&c,&d)},"identity_delta":[]}),
    )
}

fn ttl(value: &Value, source: Value, model: Value) -> Value {
    if value.is_null() {
        return Value::Null;
    }
    let ms = value
        .as_str()
        .and_then(|s| crate::scheduler::parse_cache_ttl(s).ok())
        .map(|n| if n == u64::MAX { json!(-1) } else { json!(n) })
        .unwrap_or(Value::Null);
    json!({"value":value,"ms":ms,"source":source,"model_key":model})
}

fn fields() -> Map<String, Value> {
    json!({"session_kind":null,"managed":{"value":false,"by":null},"context_limit":null,"cache_ttl":null,"last_transform_error":null,"retention":null,"producer_ref_kind":null,"join":null,"join_reason":null,"decisions":[],"missing":null,"next_cursor":null}).as_object().unwrap().clone()
}

/// The app caller has already passed route admission. Read transactions cover
/// routing and data together; an enclosing query-only snapshot is reused.
pub(crate) fn cache_why(
    context: &Connection,
    store: &Connection,
    _caller: &AppCaller,
    params: &Map<String, Value>,
) -> HandlerOutcome {
    let result = (|| {
        let request = Request::parse(params)?;
        let _context_snapshot = if context.is_autocommit() {
            Some(
                context
                    .unchecked_transaction()
                    .map_err(locator::store_error)?,
            )
        } else {
            None
        };
        let _store_snapshot = if store.is_autocommit() {
            Some(
                store
                    .unchecked_transaction()
                    .map_err(locator::store_error)?,
            )
        } else {
            None
        };
        let target = match locator::locate(context, store, &request.session) {
            Ok(target) => target,
            Err(HandlerOutcome::ErrorWithDetail { code, .. }) if code == "session_not_found" => {
                return Ok(fields())
            }
            Err(error) => return Err(error),
        };
        let mut fields = fields();
        let mut rows: Vec<(i64, String, Value)> = Vec::new();
        let source = match &target.source {
            SessionSource::Standalone => "standalone".to_owned(),
            SessionSource::Async { namespace, .. } => namespace.clone(),
        };
        if request
            .after
            .as_ref()
            .is_some_and(|cursor| cursor.source != source)
        {
            return Err(cursor_error("cursor_mismatch"));
        }
        let floor;
        let max_rows;
        match target.source {
            SessionSource::Standalone => {
                fields["session_kind"] = json!("standalone");
                fields["managed"] = json!({"value":true,"by":"plugin"});
                fields["producer_ref_kind"] = json!("assistant_message_id");
                fields["join"] = json!("available");
                let (usage, detected, model, source, cache_ttl, error) = context
                    .query_row(META, [&request.session.session], |r| {
                        Ok((
                            r.get::<_, Option<i64>>(0)?,
                            r.get::<_, Option<i64>>(1)?,
                            r.get::<_, Option<String>>(2)?,
                            r.get::<_, String>(3)?,
                            r.get::<_, Option<String>>(4)?,
                            r.get::<_, Option<String>>(5)?,
                        ))
                    })
                    .map_err(locator::store_error)?;
                fields["context_limit"] = if let Some(tokens) = usage.filter(|n| *n > 0) {
                    json!({"tokens":tokens,"source":"usage","model_key":model})
                } else if let Some(tokens) = detected.filter(|n| *n > 0) {
                    json!({"tokens":tokens,"source":source,"model_key":model})
                } else {
                    Value::Null
                };
                fields["cache_ttl"] = ttl(&json!(cache_ttl), json!("session"), Value::Null);
                fields["last_transform_error"] = json!({"text":error,"at_ms":null});
                floor = context
                    .query_row(
                        FLOOR,
                        params![request.session.session, request.session.harness],
                        |r| r.get::<_, Option<i64>>(0),
                    )
                    .map_err(locator::store_error)?;
                max_rows = 2000;
                if let Some(producers) = &request.producers {
                    let sql = decision_sql(true);
                    let mut statement = context.prepare(&sql).map_err(locator::store_error)?;
                    for producer in producers {
                        if let Some(row) = statement
                            .query_row(
                                params![
                                    request.session.session,
                                    request.session.harness,
                                    producer.reference
                                ],
                                |r| standalone_row(r, &request.session.harness),
                            )
                            .optional()
                            .map_err(locator::store_error)?
                        {
                            rows.push((
                                row["at_ms"].as_i64().unwrap(),
                                producer.reference.clone(),
                                row,
                            ));
                        }
                    }
                } else {
                    let sql = decision_sql(false);
                    let mut statement = context.prepare(&sql).map_err(locator::store_error)?;
                    let after_at = request.after.as_ref().map(|c| c.at);
                    let after_key = if let Some(cursor) = &request.after {
                        let rowid: i64 = cursor
                            .key
                            .parse()
                            .map_err(|_| cursor_error("cursor_invalid"))?;
                        let row: Option<(String, String, i64, String)> = context
                            .query_row(CURSOR_ROW, [rowid], |r| {
                                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
                            })
                            .optional()
                            .map_err(locator::store_error)?;
                        let (session, harness, at, id) =
                            row.ok_or_else(|| cursor_error("cursor_invalid"))?;
                        if session != request.session.session
                            || harness != request.session.harness
                            || at != cursor.at
                            || cursor.hash.as_deref() != Some(&id_hash(&id))
                        {
                            return Err(cursor_error("cursor_invalid"));
                        }
                        Some(id)
                    } else {
                        None
                    };
                    rows = statement
                        .query_map(
                            params![
                                request.session.session,
                                request.session.harness,
                                request.from.unwrap_or(i64::MIN),
                                request.to.unwrap_or(i64::MAX),
                                after_at,
                                after_key,
                                request.limit as i64 + 1
                            ],
                            |r| {
                                let row = standalone_row(r, &request.session.harness)?;
                                Ok((r.get(1)?, r.get::<_, i64>(15)?.to_string(), row))
                            },
                        )
                        .map_err(locator::store_error)?
                        .collect::<rusqlite::Result<_>>()
                        .map_err(locator::store_error)?;
                }
            }
            SessionSource::Async { namespace, .. } => {
                fields["session_kind"] = json!("mode3");
                fields["managed"] = json!({"value":true,"by":"ck_mc"});
                fields["join"] = json!("unavailable");
                fields["join_reason"] = json!("runner_step_identity_not_recorded");
                let meta: Option<String> = store
                    .query_row(CACHE_META, [&namespace], |r| r.get(0))
                    .optional()
                    .map_err(locator::store_error)?;
                if let Some(meta) = meta {
                    let meta: Value = serde_json::from_str(&meta).map_err(locator::store_error)?;
                    if meta["last_usage"]["context_limit_tokens"]
                        .as_u64()
                        .is_some_and(|n| n > 0)
                    {
                        fields["context_limit"] = json!({"tokens":meta["last_usage"]["context_limit_tokens"],"source":"usage","model_key":meta["cache_ttl_policy"]["model_key"]});
                    }
                    fields["cache_ttl"] = ttl(
                        &meta["cache_ttl_policy"]["value"],
                        meta["cache_ttl_policy"]["source"].clone(),
                        meta["cache_ttl_policy"]["model_key"].clone(),
                    );
                }
                let error: Option<(Option<String>, Option<i64>)> = store
                    .query_row(ERROR, [&namespace], |r| Ok((r.get(0)?, r.get(1)?)))
                    .optional()
                    .map_err(locator::store_error)?;
                fields["last_transform_error"] = match error {
                    Some((text, at)) => json!({"text":text,"at_ms":at}),
                    None => json!({"text":null,"at_ms":null}),
                };
                let mut statement = store.prepare(HISTORY).map_err(locator::store_error)?;
                let history = statement
                    .query_map([&namespace], |r| {
                        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
                    })
                    .map_err(locator::store_error)?
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(locator::store_error)?;
                let history = history
                    .into_iter()
                    .map(|(seq, entry)| {
                        serde_json::from_str::<mc_store::PassSchedulerObservation>(&entry)
                            .map(|entry| (seq, entry))
                    })
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(locator::store_error)?;
                floor = history.iter().map(|(_, row)| row.timestamp_ms).min();
                max_rows = 256;
                let after = request
                    .after
                    .as_ref()
                    .map(|cursor| {
                        cursor
                            .key
                            .parse::<i64>()
                            .map(|seq| (cursor.at, seq))
                            .map_err(|_| cursor_error("cursor_invalid"))
                    })
                    .transpose()?;
                for (seq, entry) in history {
                    // Async views are prepared from notices, not a runner step.
                    // No stored identity can safely join their reasons to usage.
                    let matches = if request.producers.is_some() {
                        false
                    } else {
                        entry.timestamp_ms >= request.from.unwrap_or(i64::MIN)
                            && entry.timestamp_ms <= request.to.unwrap_or(i64::MAX)
                    };
                    if !matches {
                        continue;
                    }
                    let key = seq.to_string();
                    if after.is_some_and(|after| (entry.timestamp_ms, seq) >= after) {
                        continue;
                    }
                    let decision = entry
                        .canonical_decision
                        .as_deref()
                        .unwrap_or(&entry.scheduler_decision);
                    let cause = if decision.eq_ignore_ascii_case("defer") {
                        json!(entry.defer_reason)
                    } else {
                        Value::Null
                    };
                    let row = json!({"producer_ref":null,"at_ms":entry.timestamp_ms,"decision":decision,"materialized":null,"cause":cause,"cause_detail":null,"emergency":entry.scheduler_decision=="Emergency95","dropped_tokens":null,"dropped_count":null,"input_tokens":null,"changes":{"system_prompt":null,"model":null,"tool_set":null},"identity_delta":entry.identity_delta});
                    rows.push((entry.timestamp_ms, key, row));
                }
                rows.sort_by(|a, b| {
                    b.0.cmp(&a.0).then_with(|| {
                        b.1.parse::<i64>()
                            .unwrap()
                            .cmp(&a.1.parse::<i64>().unwrap())
                    })
                });
            }
        }
        fields["retention"] = json!({"oldest_retained_at_ms":floor,"max_rows":max_rows});
        let missing = request.producers.as_ref().map(|producers| producers.iter().filter(|p| !rows.iter().any(|(_,_,r)| r["producer_ref"].as_str()==Some(&p.reference))).map(|p| json!({"producer_ref":p.reference,"reason":if p.at_ms.zip(floor).is_some_and(|(at,floor)| at < floor) { "not_retained" } else { "no_decision" }})).collect::<Vec<_>>()).unwrap_or_default();
        fields["missing"] = json!(missing);
        let mut decisions = Vec::new();
        let mut used = 0;
        let mut last = None;
        for (at, key, row) in rows {
            let bytes = serde_json::to_vec(&row).unwrap().len();
            if request.producers.is_none()
                && (decisions.len() == request.limit
                    || (!decisions.is_empty() && used + bytes > envelope::ROW_BUDGET))
            {
                if let Some((at, key)) = last {
                    let cursor = Cursor {
                        op: "context.cache_why".into(),
                        digest: request.digest.clone(),
                        source: source.clone(),
                        at,
                        key,
                        hash: decisions
                            .last()
                            .and_then(|row: &Value| row["producer_ref"].as_str())
                            .map(id_hash),
                    };
                    fields["next_cursor"] =
                        json!(URL_SAFE_NO_PAD.encode(serde_json::to_vec(&cursor).unwrap()));
                }
                break;
            }
            used += bytes;
            decisions.push(row);
            last = Some((at, key));
        }
        fields["decisions"] = json!(decisions);
        Ok(fields)
    })();
    match result {
        Ok(fields) => envelope::reply(
            "context.cache_why",
            chrono::Utc::now().timestamp_millis(),
            fields,
        ),
        Err(error) => error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_read_test_store::TestStores;

    fn call(db: &TestStores, params: Value) -> HandlerOutcome {
        let caller = super::super::admission::admit(
            &super::super::admission::tests::phone_bind(),
            crate::DEFAULT_MODULE_ID,
            true,
        )
        .unwrap();
        cache_why(&db.context, &db.store, &caller, params.as_object().unwrap())
    }

    fn value(outcome: HandlerOutcome) -> Value {
        match outcome {
            HandlerOutcome::Response(bytes) => serde_json::from_slice(&bytes).unwrap(),
            other => panic!("expected response: {other:?}"),
        }
    }

    fn code(outcome: HandlerOutcome) -> (String, Value) {
        match outcome {
            HandlerOutcome::ErrorWithDetail { code, detail, .. } => (code, detail),
            other => panic!("expected refusal: {other:?}"),
        }
    }

    fn session() -> Value {
        json!({"runner":"pi","harness":"pi","session":"s"})
    }
    fn window(limit: usize) -> Value {
        json!({"session":session(),"window":{},"limit":limit})
    }
    fn seed(db: &TestStores, id: &str, at: i64, reason: &str) {
        db.context_sql(&format!("INSERT INTO transform_decisions(session_id,harness,message_id,ts_ms,decision,materialized,materialize_reason,system_hash_prev,system_hash_new,m0_tool_set_hash_prev,m0_tool_set_hash_new,m0_model_key_prev,m0_model_key_new,emergency,dropped_tokens,dropped_count,input_tokens) VALUES('s','pi','{}',{at},'execute',1,'{}','old','new','tools','tools','model/a','model/b',1,12000,4,83000)", id.replace('\'', "''"),reason.replace('\'', "''")));
    }

    #[test]
    fn join_key_is_the_host_assistant_id_not_the_step_time() {
        let db = TestStores::new();
        db.standalone("s", "pi");
        seed(&db, "host-assistant", 100, "ttl_idle");
        db.context_sql("INSERT INTO transform_decisions(session_id,harness,message_id,ts_ms,decision) VALUES('other','pi','other-session',100,'execute'),('s','opencode','other-harness',100,'execute')");
        let reply = value(call(
            &db,
            json!({"session":session(),"producers":[{"producer_ref":"host-assistant","at_ms":999},{"producer_ref":"not-the-assistant","at_ms":100},{"producer_ref":"other-session"},{"producer_ref":"other-harness"}]}),
        ));
        assert_eq!(reply["producer_ref_kind"], "assistant_message_id");
        assert_eq!(reply["decisions"].as_array().unwrap().len(), 1);
        let row = &reply["decisions"][0];
        assert_eq!(row["producer_ref"], "host-assistant");
        assert_eq!(row["at_ms"], 100);
        assert_eq!(
            row["changes"],
            json!({"system_prompt":true,"model":{"prev":"model/a","new":"model/b"},"tool_set":false})
        );
        assert_eq!(row["dropped_tokens"], 12000);
        assert_eq!(row["dropped_count"], 4);
        assert_eq!(row["input_tokens"], 83000);
        assert_eq!(reply["missing"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn missing_rows_distinguish_retention_floor_from_no_decision() {
        let db = TestStores::new();
        db.standalone("s", "pi");
        seed(&db, "retained", 100, "ttl_idle");
        let reply = value(call(
            &db,
            json!({"session":session(),"producers":[{"producer_ref":"old","at_ms":99},{"producer_ref":"at-floor","at_ms":100},{"producer_ref":"new","at_ms":101},{"producer_ref":"unknown-time"}]}),
        ));
        assert_eq!(
            reply["retention"],
            json!({"oldest_retained_at_ms":100,"max_rows":2000})
        );
        assert_eq!(
            reply["missing"],
            json!([{"producer_ref":"old","reason":"not_retained"},{"producer_ref":"at-floor","reason":"no_decision"},{"producer_ref":"new","reason":"no_decision"},{"producer_ref":"unknown-time","reason":"no_decision"}])
        );
        db.context_sql("DELETE FROM transform_decisions");
        let reply = value(call(
            &db,
            json!({"session":session(),"producers":[{"producer_ref":"old","at_ms":0}]}),
        ));
        assert_eq!(reply["retention"]["oldest_retained_at_ms"], Value::Null);
        assert_eq!(reply["missing"][0]["reason"], "no_decision");
    }

    #[test]
    fn canonical_causes_match_the_materializer_vocabulary() {
        for reason in [
            "system_hash",
            "model_change",
            "project_memory_epoch",
            "ttl_idle",
            "explicit_flush",
            "user_flush",
            "fit_retry",
            "pending_materialization",
            "variant_change",
            "recomp",
            "boundary_repair",
            "host_history_change",
            "thinking_hold",
            "mutation_drift",
            "max_mutation_id",
            "first_render",
            "pressure_refold",
            "upgrade_state",
            "cached_m1_missing",
            "project_change",
            "compartment_render_epoch",
            "m1_delta",
            "ttl_expiry",
            "epoch_change",
            "coverage_fold",
            "profile_transition",
            "host_compaction",
            "tag_identity_repair",
        ] {
            assert_eq!(
                canonical("pi", Some(reason), false).as_deref(),
                Some(reason)
            );
        }
        for (alias, expected) in [
            ("project_memory_change", "project_memory_epoch"),
            ("pending_mutations", "max_mutation_id"),
            ("renderer_upgrade", "upgrade_state"),
            ("cache_invalid", "cached_m1_missing"),
            ("drift", "pressure_refold"),
            ("model_key", "model_change"),
            ("pressure", "pressure_refold"),
        ] {
            assert_eq!(
                canonical("pi", Some(alias), false).as_deref(),
                Some(expected)
            );
        }
        assert_eq!(canonical("opencode", Some("drift"), true), None);
        assert_eq!(canonical("pi", Some("unknown"), true), None);
        assert_eq!(
            canonical("pi", None, true).as_deref(),
            Some("pressure_refold")
        );
        assert_eq!(canonical("pi", None, false), None);
    }

    #[test]
    fn lkg_frozen_release_splits_canonical_cause_from_release_detail() {
        let db = TestStores::new();
        db.standalone("s", "pi");
        seed(
            &db,
            "host-assistant",
            100,
            "lkg_frozen_release:ttl_expired;materialize_reason=model_key",
        );
        let reply = value(call(&db, window(100)));
        assert_eq!(reply["decisions"][0]["cause"], "model_change");
        assert_eq!(
            reply["decisions"][0]["cause_detail"],
            json!({"lkg_frozen_release":"ttl_expired"})
        );
        assert_eq!(
            cause("pi", Some("lkg_frozen_release:explicit_flush"), false),
            (Value::Null, json!({"lkg_frozen_release":"explicit_flush"}))
        );
    }

    #[test]
    fn unknown_keys_are_refused_at_every_parameter_object_depth() {
        let db = TestStores::new();
        for (params, field) in [
            (
                json!({"session":session(),"window":{},"unknown":1}),
                "params.unknown",
            ),
            (
                json!({"session":{"runner":"pi","harness":"pi","session":"s","unknown":1},"window":{}}),
                "params.session.unknown",
            ),
            (
                json!({"session":session(),"window":{"unknown":1}}),
                "params.window.unknown",
            ),
            (
                json!({"session":session(),"producers":[{"producer_ref":"x","unknown":1}]}),
                "params.producers.0.unknown",
            ),
        ] {
            let (name, detail) = code(call(&db, params));
            assert_eq!(name, "invalid_params");
            assert_eq!(detail, json!({"field":field,"reason":"unknown"}));
        }
    }

    #[test]
    fn request_bounds_and_exclusive_modes_are_enforced() {
        let db = TestStores::new();
        for params in [
            json!({"session":session()}),
            json!({"session":session(),"producers":[],"window":{}}),
            json!({"session":session(),"producers":[]}),
            json!({"session":session(),"producers":vec![json!({"producer_ref":"x"});101]}),
            json!({"session":session(),"window":{},"limit":201}),
            json!({"session":session(),"window":{"from_ms":2,"to_ms":1}}),
            json!({"session":session(),"window":{"from_ms":1.5}}),
            json!({"session":session(),"producers":[{"producer_ref":""}]}),
            json!({"session":session(),"producers":[{"producer_ref":"x","at_ms":"now"}]}),
            json!({"session":session(),"producers":[{"producer_ref":"x"}],"limit":10}),
        ] {
            assert_eq!(code(call(&db, params)).0, "invalid_params");
        }
    }

    #[test]
    fn window_is_inclusive_newest_first_and_cursor_is_filter_bound() {
        let db = TestStores::new();
        db.standalone("s", "pi");
        for (id, at) in [("a", 100), ("b", 100), ("c", 101), ("excluded", 99)] {
            seed(&db, id, at, "ttl_idle");
        }
        let mut params =
            json!({"session":session(),"window":{"from_ms":100,"to_ms":101},"limit":2});
        let first = value(call(&db, params.clone()));
        assert_eq!(
            first["decisions"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| r["producer_ref"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["c", "b"]
        );
        params["cursor"] = first["next_cursor"].clone();
        let second = value(call(&db, params.clone()));
        assert_eq!(second["decisions"][0]["producer_ref"], "a");
        assert!(second["next_cursor"].is_null());
        params["window"]["from_ms"] = json!(99);
        assert_eq!(code(call(&db, params.clone())).0, "cursor_mismatch");
        params["cursor"] = json!("not-base64!");
        assert_eq!(code(call(&db, params)).0, "cursor_invalid");
    }

    #[test]
    fn maximum_message_id_has_a_bounded_cursor_that_pages() {
        let db = TestStores::new();
        db.standalone("s", "pi");
        seed(&db, &"x".repeat(512), 2, "ttl_idle");
        seed(&db, "older", 1, "ttl_idle");
        let mut params = window(1);
        let first = value(call(&db, params.clone()));
        assert!(first["next_cursor"].as_str().unwrap().len() < 512);
        params["cursor"] = first["next_cursor"].clone();
        assert_eq!(
            value(call(&db, params))["decisions"][0]["producer_ref"],
            "older"
        );
    }

    #[test]
    fn deleted_cursor_position_is_invalid() {
        let db = TestStores::new();
        db.standalone("s", "pi");
        seed(&db, "newest", 2, "ttl_idle");
        seed(&db, "older", 1, "ttl_idle");
        let mut params = window(1);
        params["cursor"] = value(call(&db, params.clone()))["next_cursor"].clone();
        db.context_sql("DELETE FROM transform_decisions WHERE message_id='newest'");
        assert_eq!(code(call(&db, params)).0, "cursor_invalid");
    }

    #[test]
    fn reused_rowid_cursor_position_is_invalid() {
        let db = TestStores::new();
        db.standalone("s", "pi");
        seed(&db, "newest", 2, "ttl_idle");
        seed(&db, "older", 1, "ttl_idle");
        let mut params = window(1);
        params["cursor"] = value(call(&db, params.clone()))["next_cursor"].clone();
        db.context_sql("DELETE FROM transform_decisions WHERE message_id='newest'; INSERT INTO transform_decisions(rowid,session_id,harness,message_id,ts_ms,decision) VALUES(1,'s','pi','replacement',2,'execute')");
        assert_eq!(code(call(&db, params)).0, "cursor_invalid");
    }

    #[test]
    fn unmanaged_sessions_return_a_nullable_success_not_a_refusal() {
        let db = TestStores::new();
        let reply = value(call(&db, window(100)));
        assert_eq!(reply["managed"], json!({"value":false,"by":null}));
        assert_eq!(reply["decisions"], json!([]));
        for field in [
            "session_kind",
            "context_limit",
            "cache_ttl",
            "retention",
            "last_transform_error",
            "producer_ref_kind",
            "missing",
            "next_cursor",
        ] {
            assert!(reply[field].is_null(), "{field}");
        }
    }

    #[test]
    fn session_fields_use_usage_then_detected_limit_and_ttl_parser() {
        let db = TestStores::new();
        db.standalone("s", "pi");
        db.context_sql("UPDATE session_meta SET last_usage_context_limit=200000,detected_context_limit=128000,detected_context_limit_model_key='model/a',detected_context_limit_provenance='model',cache_ttl='never',last_transform_error='failed'");
        let first = value(call(&db, window(100)));
        assert_eq!(first["context_limit"]["tokens"], 200000);
        assert_eq!(first["context_limit"]["source"], "usage");
        assert_eq!(first["cache_ttl"]["ms"], -1);
        assert_eq!(
            first["last_transform_error"],
            json!({"text":"failed","at_ms":null})
        );
        db.context_sql("UPDATE session_meta SET last_usage_context_limit=0,cache_ttl='5m'");
        let second = value(call(&db, window(100)));
        assert_eq!(second["context_limit"]["tokens"], 128000);
        assert_eq!(second["cache_ttl"]["ms"], 300000);
    }

    #[test]
    fn mode3_reasons_are_window_only_and_never_invent_a_step_id() {
        let db = TestStores::new();
        let namespace = db.async_session("runner", "pi", "s", 1, true);
        for (seq, entry) in [
            (
                1,
                json!({"timestamp_ms":100,"scheduler_decision":"Execute","drain_latch_active":false}),
            ),
            (
                2,
                json!({"timestamp_ms":101,"producer_ref":"step-request","scheduler_decision":"Defer","canonical_decision":"defer","defer_reason":"mid_turn_boundary","drain_latch_active":false,"identity_delta":["system_hash"]}),
            ),
        ] {
            db.store_sql(&format!("INSERT INTO mc_pass_trace_history(session_id,kind,slot,seq,entry) VALUES('{}','scheduler',{seq},{seq},'{}')",namespace.replace('\'', "''"),entry.to_string().replace('\'', "''")));
        }
        let session = json!({"runner":"runner","harness":"pi","session":"s"});
        let reply = value(call(
            &db,
            json!({"session":session,"producers":[{"producer_ref":"step-request"},{"producer_ref":"missing","at_ms":99}]}),
        ));
        assert!(reply["producer_ref_kind"].is_null());
        assert_eq!(reply["join"], "unavailable");
        assert_eq!(reply["join_reason"], "runner_step_identity_not_recorded");
        assert_eq!(
            reply["retention"],
            json!({"oldest_retained_at_ms":100,"max_rows":256})
        );
        assert_eq!(reply["decisions"], json!([]));
        assert_eq!(reply["missing"][0]["reason"], "no_decision");
        assert_eq!(reply["missing"][1]["reason"], "not_retained");
        let mut params = json!({"session":session,"window":{},"limit":1});
        let first = value(call(&db, params.clone()));
        assert_eq!(first["join"], "unavailable");
        assert!(first["producer_ref_kind"].is_null());
        assert!(first["decisions"][0]["producer_ref"].is_null());
        assert_eq!(first["decisions"][0]["cause"], "mid_turn_boundary");
        assert_eq!(
            first["decisions"][0]["identity_delta"],
            json!(["system_hash"])
        );
        let cursor: Cursor = serde_json::from_slice(
            &URL_SAFE_NO_PAD
                .decode(first["next_cursor"].as_str().unwrap())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(cursor.key, "2");
        params["cursor"] = first["next_cursor"].clone();
        let second = value(call(&db, params));
        assert_eq!(second["decisions"][0]["producer_ref"], Value::Null);
        assert_eq!(second["decisions"][0]["decision"], "Execute");
    }

    #[test]
    fn every_cache_why_query_uses_an_index() {
        let db = TestStores::new();
        let indexed_sort =
            |conn: &Connection, sql: &str, args: &[&dyn rusqlite::ToSql], index: &str| {
                let plans = conn
                    .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
                    .unwrap()
                    .query_map(args, |r| r.get::<_, String>(3))
                    .unwrap()
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .unwrap();
                // The retention index orders timestamps, not equal-time message ids.
                // Sorting that indexed result is allowed; a table scan is not.
                assert!(
                    plans
                        .iter()
                        .any(|p| p.contains("SEARCH") && p.contains(index)),
                    "{sql}: {plans:?}"
                );
                assert!(
                    plans.iter().all(|p| !p.contains("SCAN")),
                    "{sql}: {plans:?}"
                );
            };
        TestStores::indexed(&db.context, META, &[&"s"]);
        indexed_sort(
            &db.context,
            FLOOR,
            &[&"s", &"pi"],
            "idx_transform_decisions_retention (session_id=? AND harness=?",
        );
        TestStores::indexed(&db.context, &decision_sql(true), &[&"s", &"pi", &"id"]);
        indexed_sort(
            &db.context,
            &decision_sql(false),
            &[&"s", &"pi", &0i64, &100i64, &100i64, &"id", &101i64],
            "idx_transform_decisions_retention (session_id=? AND harness=?",
        );
        TestStores::indexed(&db.context, CURSOR_ROW, &[&1i64]);
        indexed_sort(
            &db.store,
            HISTORY,
            &[&"namespace"],
            "sqlite_autoindex_mc_pass_trace_history_1 (session_id=? AND kind=?",
        );
        for sql in [CACHE_META, ERROR] {
            TestStores::indexed(&db.store, sql, &[&"namespace"]);
        }
    }

    #[test]
    fn read_snapshots_are_reused_and_owned_snapshots_leave_no_transaction() {
        let db = TestStores::new();
        db.standalone("s", "pi");
        db.context_sql("PRAGMA query_only=ON");
        db.store_sql("PRAGMA query_only=ON");
        value(call(&db, window(100)));
        assert!(db.context.is_autocommit() && db.store.is_autocommit());
        let _context = db.context.unchecked_transaction().unwrap();
        let _store = db.store.unchecked_transaction().unwrap();
        value(call(&db, window(100)));
        assert!(!db.context.is_autocommit() && !db.store.is_autocommit());
    }
}
