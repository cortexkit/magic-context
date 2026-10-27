//! Expand one summary without reading unrelated summary bodies.
#![cfg_attr(not(test), expect(dead_code, reason = "consumed by app read dispatch"))]

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use subc_client_rs::HandlerOutcome;

use super::{admission::AppCaller, context_states, envelope, locator, version};

pub(crate) const EXISTS: &str = "SELECT 1 FROM compartments WHERE id=?1 AND session_id=?2";
pub(crate) const DETAIL: &str = "SELECT sequence,start_message,end_message,start_message_id,end_message_id,title,content,p1,p2,p3,p4,importance,episode_type,legacy,created_at FROM compartments WHERE id=?1 AND session_id=?2";
pub(crate) const ORDINAL_ID: &str = "SELECT message_id FROM message_history_source WHERE session_id=?1 AND message_ordinal=?2 LIMIT 1";
pub(crate) const ORDINAL_TIME: &str =
    "SELECT message_time_ms FROM message_fts_rowid_map WHERE session_id=?1 AND message_ordinal=?2";
pub(crate) const RUN_FACTS: &str = "SELECT facts_by_category_json FROM historian_runs WHERE session_id=?1 AND compartment_id_min<=?2 AND compartment_id_max>=?2 ORDER BY created_at DESC LIMIT 1";

pub(crate) fn boundary_id(
    context: &Connection,
    key: &str,
    ordinal: i64,
    recorded: Option<String>,
) -> rusqlite::Result<Option<String>> {
    if recorded.as_ref().is_some_and(|id| !id.is_empty()) {
        return Ok(recorded);
    }
    context
        .query_row(ORDINAL_ID, params![key, ordinal], |r| r.get(0))
        .optional()
}

/// Budgets count JSON escaping, while the reported original length is UTF-8 bytes.
fn bounded_text(text: &str, limit: usize) -> (String, bool) {
    let mut escaped_bytes = 2;
    for (offset, character) in text.char_indices() {
        let width = match character {
            '"' | '\\' | '\u{8}' | '\t' | '\n' | '\u{c}' | '\r' => 2,
            '\u{0}'..='\u{1f}' => 6,
            _ => character.len_utf8(),
        };
        if escaped_bytes + width > limit {
            return (text[..offset].to_owned(), true);
        }
        escaped_bytes += width;
    }
    (text.to_owned(), false)
}

pub(crate) fn compartment(
    context: &Connection,
    store: &Connection,
    _caller: &AppCaller,
    params: &Value,
) -> HandlerOutcome {
    match read(context, store, params) {
        Ok(fields) => envelope::reply(
            "context.compartment",
            context_states::now_ms(),
            fields.as_object().expect("reply object").clone(),
        ),
        Err(error) => error,
    }
}

fn read(context: &Connection, store: &Connection, input: &Value) -> Result<Value, HandlerOutcome> {
    let p = envelope::object(input, "params")?;
    envelope::refuse_unknown(p, &["session", "compartment_id", "if_version"], "params")?;
    let session =
        locator::SessionRef::parse(p.get("session").unwrap_or(&Value::Null), "params.session")?;
    let id = p
        .get("compartment_id")
        .and_then(Value::as_str)
        .ok_or_else(|| envelope::invalid_field("params.compartment_id", "type", None))?;
    let numeric_id = id
        .parse::<i64>()
        .ok()
        .filter(|n| *n > 0)
        .ok_or_else(|| envelope::invalid_field("params.compartment_id", "range", None))?;
    let if_version = context_states::if_version(p)?;
    let budget = context_states::ReadBudget::new(context, store);
    let _context_snapshot = context_states::snapshot(context)?;
    let _store_snapshot = context_states::snapshot(store)?;
    let target = locator::locate(context, store, &session)?;
    let version = version::session_version(
        context,
        store,
        &target,
        version::VersionRequest::Compartment(id),
    )
    .map_err(context_states::query_error)?;
    let key = target.context_session_id();
    // Check ownership and existence even on conditional reads: a deleted or
    // foreign summary must not be mistaken for an unchanged one.
    let exists = context
        .query_row(EXISTS, params![numeric_id, key], |r| r.get::<_, i64>(0))
        .optional()
        .map_err(context_states::query_error)?
        .is_some();
    if !exists {
        return Err(locator::refusal(
            "compartment_not_found",
            "The summary no longer exists in this session.",
            Value::Null,
        ));
    }
    if if_version == Some(version.as_str()) {
        return Ok(json!({"state":"unchanged", "version":version}));
    }
    let row = context
        .query_row(DETAIL, params![numeric_id, key], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, String>(6)?,
                [
                    r.get::<_, Option<String>>(7)?,
                    r.get(8)?,
                    r.get(9)?,
                    r.get(10)?,
                ],
                r.get::<_, i64>(11)?,
                r.get::<_, Option<String>>(12)?,
                r.get::<_, bool>(13)?,
                r.get::<_, i64>(14)?,
            ))
        })
        .optional()
        .map_err(context_states::query_error)?
        .ok_or_else(|| {
            locator::refusal(
                "compartment_not_found",
                "The summary no longer exists in this session.",
                Value::Null,
            )
        })?;
    let (
        ordinal,
        first,
        last,
        first_id,
        last_id,
        title,
        summary,
        tiers,
        importance,
        episode,
        legacy,
        created,
    ) = row;
    let first_id =
        boundary_id(context, key, first, first_id).map_err(context_states::query_error)?;
    let last_id = boundary_id(context, key, last, last_id).map_err(context_states::query_error)?;
    let at = |ordinal| {
        context
            .query_row(ORDINAL_TIME, params![key, ordinal], |r| {
                r.get::<_, Option<i64>>(0)
            })
            .optional()
            .map(Option::flatten)
            .map_err(context_states::query_error)
    };
    let facts: Option<Option<String>> = context
        .query_row(RUN_FACTS, params![key, numeric_id], |r| r.get(0))
        .optional()
        .map_err(context_states::query_error)?;
    let counts = facts
        .flatten()
        .map(|s| serde_json::from_str::<Value>(&s))
        .transpose()
        .map_err(locator::store_error)?
        .unwrap_or_else(|| json!({}));
    let (markdown, truncated) = bounded_text(&summary, 192 * 1024);
    let mut tier_values = json!({});
    let mut tier_truncated = json!({});
    let mut tier_bytes = json!({});
    for (name, tier) in ["p1", "p2", "p3", "p4"].into_iter().zip(tiers) {
        let (value, truncated) = tier
            .as_deref()
            .map(|text| bounded_text(text, 48 * 1024))
            .map(|(text, cut)| (json!(text), cut))
            .unwrap_or((Value::Null, false));
        tier_values[name] = value;
        tier_truncated[name] = json!(truncated);
        tier_bytes[name] = json!(tier.as_ref().map(String::len));
    }
    budget.check()?;
    Ok(json!({"state":"ready", "version":version, "compartment":{
        "compartment_id":numeric_id.to_string(), "ordinal":ordinal, "title":title,
        "summary_markdown":markdown, "summary_markdown_truncated":truncated, "summary_markdown_bytes":summary.len(),
        "first_message_id":first_id, "last_message_id":last_id,
        "first_message_ordinal":first, "last_message_ordinal":last,
        "message_count":last - first + 1, "first_at_ms":at(first)?, "last_at_ms":at(last)?,
        "importance":importance, "episode_type":episode, "legacy":legacy, "created_at_ms":created,
        "tiers":tier_values, "tiers_truncated":tier_truncated, "tiers_bytes":tier_bytes,
        "facts":{"attribution":"historian_run", "by_category":counts, "session_facts_cursor":null}
    }}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_read_test_store::TestStores;

    fn caller() -> AppCaller {
        super::super::admission::admit(
            &super::super::admission::tests::phone_bind(),
            crate::DEFAULT_MODULE_ID,
            true,
        )
        .unwrap()
    }
    fn request(id: &str) -> Value {
        json!({"session":{"runner":"opencode","harness":"opencode","session":"s"},"compartment_id":id})
    }
    fn response(outcome: HandlerOutcome) -> Value {
        match outcome {
            HandlerOutcome::Response(bytes) => {
                assert!(bytes.len() <= envelope::REPLY_LIMIT);
                serde_json::from_slice(&bytes).unwrap()
            }
            other => panic!("{other:?}"),
        }
    }
    fn fixture() -> TestStores {
        let stores = TestStores::new();
        stores.context_sql(include_str!("../../testdata/app-read-d/states.sql"));
        stores.context_sql("UPDATE compartments SET p1='tier one',p2='tier two',p3='tier three',p4='tier four',importance=72,episode_type='implementation' WHERE id=1; INSERT INTO message_fts_rowid_map(session_id,message_ordinal,fts_rowid,message_time_ms) VALUES('s',2,1,100),('s',3,2,200); INSERT INTO historian_runs(session_id,run_kind,status,compartment_id_min,compartment_id_max,facts_by_category_json,created_at) VALUES('s','historian','completed',1,1,'{\"DECISION\":2,\"CONSTRAINT\":1}',300);");
        stores
    }
    #[test]
    fn expands_summary_range_dates_tiers_and_historian_counts() {
        let stores = fixture();
        let reply = response(compartment(
            &stores.context,
            &stores.store,
            &caller(),
            &request("1"),
        ));
        let c = &reply["compartment"];
        assert_eq!(c["compartment_id"], "1");
        assert_eq!(c["ordinal"], 1);
        assert_eq!(c["title"], "A summary");
        assert_eq!(c["summary_markdown"], "Stored prose");
        assert_eq!(c["summary_markdown_bytes"], 12);
        assert_eq!(c["summary_markdown_truncated"], false);
        assert_eq!(c["first_message_id"], "old-first");
        assert_eq!(c["last_message_id"], "summarized");
        assert_eq!(c["first_message_ordinal"], 2);
        assert_eq!(c["last_message_ordinal"], 3);
        assert_eq!(c["message_count"], 2);
        assert_eq!(c["first_at_ms"], 100);
        assert_eq!(c["last_at_ms"], 200);
        assert_eq!(c["importance"], 72);
        assert_eq!(c["episode_type"], "implementation");
        assert_eq!(c["legacy"], false);
        assert_eq!(c["created_at_ms"], 20);
        assert_eq!(
            c["tiers"],
            json!({"p1":"tier one","p2":"tier two","p3":"tier three","p4":"tier four"})
        );
        assert_eq!(
            c["tiers_truncated"],
            json!({"p1":false,"p2":false,"p3":false,"p4":false})
        );
        assert_eq!(
            c["facts"],
            json!({"attribution":"historian_run","by_category":{"DECISION":2,"CONSTRAINT":1},"session_facts_cursor":null})
        );
        let mut p = request("1");
        p["if_version"] = reply["version"].clone();
        let unchanged = response(compartment(&stores.context, &stores.store, &caller(), &p));
        assert_eq!(unchanged["state"], "unchanged");
        assert_eq!(unchanged.as_object().unwrap().len(), 5);
        stores.context_sql("UPDATE compartments SET title='revised' WHERE id=1;");
        assert_eq!(
            response(compartment(&stores.context, &stores.store, &caller(), &p))["state"],
            "ready"
        );
    }
    #[test]
    fn foreign_or_deleted_ids_refuse_and_legacy_nulls_are_preserved() {
        let stores = TestStores::new();
        stores.standalone("s", "opencode");
        stores.standalone("foreign", "opencode");
        stores.context_sql("INSERT INTO compartments(session_id,sequence,start_message,end_message,title,content,created_at,legacy) VALUES('s',1,2,3,'legacy','summary',1,1),('foreign',1,2,3,'foreign','summary',1,0);");
        let reply = response(compartment(
            &stores.context,
            &stores.store,
            &caller(),
            &request("1"),
        ));
        let c = &reply["compartment"];
        for field in [
            "first_message_id",
            "last_message_id",
            "first_at_ms",
            "last_at_ms",
            "episode_type",
        ] {
            assert!(c[field].is_null(), "{field}");
        }
        assert_eq!(c["tiers"], json!({"p1":null,"p2":null,"p3":null,"p4":null}));
        assert_eq!(c["legacy"], true);
        for id in ["2", "999"] {
            assert!(
                matches!(compartment(&stores.context,&stores.store,&caller(),&request(id)),HandlerOutcome::ErrorWithDetail {code,..} if code=="compartment_not_found")
            );
        }
        let mut p = request("1");
        p["if_version"] = reply["version"].clone();
        stores.context_sql("DELETE FROM compartments WHERE id=1;");
        assert!(
            matches!(compartment(&stores.context,&stores.store,&caller(),&p),HandlerOutcome::ErrorWithDetail {code,..} if code=="compartment_not_found")
        );
        p["session"]["session"] = json!("unknown");
        assert!(
            matches!(compartment(&stores.context,&stores.store,&caller(),&p),HandlerOutcome::ErrorWithDetail {code,..} if code=="session_not_found")
        );
    }
    #[test]
    fn escaped_text_caps_keep_unicode_valid_and_reply_below_budget() {
        let controls = "\0\u{8}\t\n\u{c}\r\"\\é🦀";
        for cap in 2..40 {
            let (prefix, cut) = bounded_text(controls, cap);
            assert!(serde_json::to_vec(&prefix).unwrap().len() <= cap);
            assert_eq!(cut, prefix.len() < controls.len());
            if let Some(next) = controls[prefix.len()..].chars().next() {
                assert!(
                    serde_json::to_vec(&format!("{prefix}{next}"))
                        .unwrap()
                        .len()
                        > cap
                );
            }
        }
        let stores = fixture();
        let text = "\n🦀\"".repeat(40_000);
        let quote = text.replace('\'', "''");
        stores.context_sql(&format!("UPDATE compartments SET content='{quote}',p1='{quote}',p2='{quote}',p3='{quote}',p4='{quote}' WHERE id=1;"));
        let started = std::time::Instant::now();
        let reply = response(compartment(
            &stores.context,
            &stores.store,
            &caller(),
            &request("1"),
        ));
        let elapsed = started.elapsed();
        println!("compartment unicode cap elapsed_us={}", elapsed.as_micros());
        assert!(
            elapsed < std::time::Duration::from_millis(250),
            "Unicode-cap reply took {elapsed:?}"
        );
        assert!(serde_json::to_vec(&reply).unwrap().len() < envelope::ROW_BUDGET);
        let c = &reply["compartment"];
        assert_eq!(c["summary_markdown_truncated"], true);
        assert_eq!(c["summary_markdown_bytes"], text.len());
        assert!(
            serde_json::to_vec(c["summary_markdown"].as_str().unwrap())
                .unwrap()
                .len()
                <= 192 * 1024
        );
        for name in ["p1", "p2", "p3", "p4"] {
            assert_eq!(c["tiers_truncated"][name], true);
            assert_eq!(c["tiers_bytes"][name], text.len());
            assert!(
                serde_json::to_vec(c["tiers"][name].as_str().unwrap())
                    .unwrap()
                    .len()
                    <= 48 * 1024
            );
        }
    }
    #[test]
    fn compartment_params_reject_nested_unknowns_and_bad_ids() {
        let stores = TestStores::new();
        let mut p = request("1");
        p["session"]["extra"] = json!(true);
        assert!(
            matches!(compartment(&stores.context,&stores.store,&caller(),&p),HandlerOutcome::ErrorWithDetail {code,detail,..} if code=="invalid_params" && detail["field"]=="params.session.extra")
        );
        for id in ["", "-1", "0", "not-an-id"] {
            assert!(
                matches!(compartment(&stores.context,&stores.store,&caller(),&request(id)),HandlerOutcome::ErrorWithDetail {code,..} if code=="invalid_params")
            );
        }
        let mut p = request("1");
        p["extra"] = json!(true);
        assert!(
            matches!(compartment(&stores.context,&stores.store,&caller(),&p),HandlerOutcome::ErrorWithDetail {detail,..} if detail["field"]=="params.extra")
        );
    }
    #[test]
    fn every_compartment_query_has_an_indexed_search_plan() {
        let stores = fixture();
        TestStores::indexed(&stores.context, EXISTS, &[&1, &"s"]);
        TestStores::indexed(&stores.context, DETAIL, &[&1, &"s"]);
        TestStores::indexed(&stores.context, ORDINAL_ID, &[&"s", &2]);
        TestStores::indexed(&stores.context, ORDINAL_TIME, &[&"s", &2]);
        TestStores::indexed(&stores.context, RUN_FACTS, &[&"s", &1]);
    }
}

#[cfg(test)]
mod async_tests {
    use super::*;
    use crate::app_read_test_store::TestStores;

    #[test]
    fn mode3_summary_uses_namespace_and_remains_readable_during_resync() {
        let stores = TestStores::new();
        let namespace = stores.async_session("runner", "pi", "s", 7, true);
        stores.context_sql(&format!("INSERT INTO compartments(session_id,sequence,start_message,end_message,start_message_id,end_message_id,title,content,created_at) VALUES('{namespace}',1,1,2,'m1','m2','async title','async summary',10);"));
        let caller = super::super::admission::admit(
            &super::super::admission::tests::phone_bind(),
            crate::DEFAULT_MODULE_ID,
            true,
        )
        .unwrap();
        let input = json!({"session":{"runner":"runner","harness":"pi","session":"s"},"compartment_id":"1"});
        match compartment(&stores.context, &stores.store, &caller, &input) {
            HandlerOutcome::Response(bytes) => {
                let reply: Value = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(reply["compartment"]["title"], "async title");
                assert_eq!(reply["compartment"]["first_message_id"], "m1");
            }
            other => panic!("{other:?}"),
        }
    }
}
