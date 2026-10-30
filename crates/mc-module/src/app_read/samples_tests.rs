//! Recorded app-read exchanges for the Alfonso phone (CKIOS) and desktop
//! (CKDESK) decoders.
//!
//! Unary samples are produced by the real handlers through the real dispatch
//! path: a `Direct` bind with no scope is admitted by `admission::admit`
//! (with `app_read.allow_direct` on, as the local desktop binds), then the
//! request bytes go through `app_read::handle` exactly as the daemon would
//! deliver them. The files only record what the handlers served; nothing in
//! them is hand-written. Watch notices/refusals come from the live subscription
//! hub; the daemon subscription tests separately check their StreamData framing.
//!
//! Layout: `testdata/app-read-samples/<op>/<case>.json` plus `SHA256SUMS`
//! (`sha256sum` format, sorted by path) and a `README.md` that lists each
//! case. Each sample file holds one object:
//!
//! - successes: `{"name", "request": {"method", "params"}, "response": {...}}`
//!   where `response` is the served reply body, decoded and re-encoded with
//!   sorted keys;
//! - refusals: `{"name", "request": {...}, "refusal": {"code", "message",
//!   "detail"}}` where `detail` is `null` for plain `Error` refusals (error
//!   frames carry no bytes, so the code, message and detail are recorded
//!   instead).
//!
//! Regeneration: `MC_REGENERATE_APP_READ_SAMPLES=1 cargo test -p mc-module
//! app_read::samples_tests` rewrites the samples and `SHA256SUMS` from the
//! live handlers. The ordinary run fails if any served bytes differ, so the
//! samples cannot drift from the handlers.
//!
//! The generation seed behind compartment versions is pinned in fixture setup
//! (production defaults it to `randomblob(16)`), and two served fields are
//! normalized before comparison; the README says so: `as_of_ms` is wall-clock time on the context/search/cache_why lanes
//! (the serving context's fixed clock only stamps the session, memory,
//! dreamer, health and config lanes), so it is pinned to the fixture clock;
//! `store.health` database `path` values name the throwaway directory, so
//! they are replaced with `<context_db>`/`<store_db>`. Everything else is
//! byte-exact.
//!
//! The fixture clock is fixed (`NOW_MS`) and every id is fixed, so output is
//! identical on every platform. SQLite is bundled, so FTS ranking and file
//! sizes do not vary between machines either.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};
use subc_client_rs::{HandlerOutcome, RouteBindRequest, RouteHandle};
use subc_protocol::{BindIdentity, Principal};

use super::admission::{self, AppCaller};
use super::tests_support::{apply_sql, open_store};
use super::{handle, AppReadContext, APP_READ_METHODS};

/// Fixture clock. Stamps every reply whose handler uses the serving context.
const NOW_MS: i64 = 1_700_000_000_000;
/// Rewrite the samples instead of comparing them.
const REGENERATE_ENV: &str = "MC_REGENERATE_APP_READ_SAMPLES";
/// Directory holding the samples, relative to the crate root.
const SAMPLE_DIR: &str = "testdata/app-read-samples";

/// What one `handle()` call served.
enum Served {
    Reply(Value),
    Refusal {
        code: String,
        message: String,
        detail: Value,
    },
}

/// One recorded exchange: where it lives, what was asked, what was served.
struct Record {
    name: &'static str,
    file: &'static str,
    method: &'static str,
    params: Value,
    served: Served,
}

/// Admit a `Direct` caller with no scope, the desktop shape the lane allows
/// while `app_read.allow_direct` is on.
fn direct_caller() -> AppCaller {
    let request = RouteBindRequest::new(
        RouteHandle::detached(1, 1),
        crate::route_targets::app_read_target_for_test(crate::DEFAULT_MODULE_ID),
        BindIdentity::new(PathBuf::from("caller-chosen"), "desktop", "ignored-session"),
    )
    .with_principal(Principal::Direct);
    assert!(request.scope.is_none(), "samples bind carries no scope");
    admission::admit(&request, crate::DEFAULT_MODULE_ID, true).expect("direct app bind")
}

/// Send one request through the real dispatch and decode what was served.
fn serve(ctx: &AppReadContext, caller: &AppCaller, method: &str, params: &Value) -> Served {
    let body = serde_json::to_vec(&json!({"method": method, "params": params}))
        .expect("sample request serializes");
    match handle(caller, true, &body, ctx) {
        HandlerOutcome::Response(bytes) => {
            Served::Reply(serde_json::from_slice(&bytes).expect("served reply is JSON"))
        }
        HandlerOutcome::Error { code, message } => Served::Refusal {
            code,
            message,
            detail: Value::Null,
        },
        HandlerOutcome::ErrorWithDetail {
            code,
            message,
            detail,
        } => Served::Refusal {
            code,
            message,
            detail,
        },
        HandlerOutcome::Streamed => panic!("app reads never stream"),
    }
}

/// Pin the documented volatile fields to fixture values.
fn normalize(method: &str, served: &mut Served) {
    let Served::Reply(reply) = served else {
        return;
    };
    if let Some(as_of_ms) = reply.get_mut("as_of_ms") {
        *as_of_ms = json!(NOW_MS);
    }
    if method == "store.health" {
        if let Some(databases) = reply
            .pointer_mut("/row/databases")
            .and_then(Value::as_array_mut)
        {
            for database in databases {
                let placeholder =
                    if database.get("name").and_then(Value::as_str) == Some("context_db") {
                        "<context_db>"
                    } else {
                        "<store_db>"
                    };
                database["path"] = json!(placeholder);
            }
        }
    }
}

/// Re-encode with sorted keys and a trailing newline, so file bytes are
/// stable regardless of the handlers' map insertion order.
fn canonical(value: &Value) -> Vec<u8> {
    fn sorted(value: &Value) -> Value {
        match value {
            Value::Object(object) => object
                .iter()
                .map(|(key, item)| (key.clone(), sorted(item)))
                .collect::<BTreeMap<_, _>>()
                .into_iter()
                .collect::<Map<String, Value>>()
                .into(),
            Value::Array(items) => items.iter().map(sorted).collect(),
            _ => value.clone(),
        }
    }
    let mut bytes = serde_json::to_vec_pretty(&sorted(value)).expect("sample serializes");
    bytes.push(b'\n');
    bytes
}

/// File bytes for one record: the exchange plus its name.
fn clone_served(served: &Served) -> Served {
    match served {
        Served::Reply(reply) => Served::Reply(reply.clone()),
        Served::Refusal {
            code,
            message,
            detail,
        } => Served::Refusal {
            code: code.clone(),
            message: message.clone(),
            detail: detail.clone(),
        },
    }
}

fn sample_bytes(record: &Record) -> Vec<u8> {
    let mut served = clone_served(&record.served);
    normalize(record.method, &mut served);
    let value = match &served {
        Served::Reply(response) => json!({
            "name": record.name,
            "request": {"method": record.method, "params": record.params},
            "response": response,
        }),
        Served::Refusal {
            code,
            message,
            detail,
        } => json!({
            "name": record.name,
            "request": {"method": record.method, "params": record.params},
            "refusal": {"code": code, "message": message, "detail": detail},
        }),
    };
    canonical(&value)
}

/// Throwaway serving store with fixture SQL applied, then one dispatch.
fn dispatch(
    context_sql: &str,
    store_sql: &str,
    configure: impl FnOnce(&Path, &mut AppReadContext),
    method: &'static str,
    params: Value,
) -> (Value, Served) {
    let dir = tempfile::tempdir().expect("sample store dir");
    let store = open_store(dir.path());
    let context_db = dir.path().join("context.db");
    let store_db = dir.path().join("store.db");
    if !context_sql.is_empty() {
        apply_sql(&context_db, context_sql);
    }
    if !store_sql.is_empty() {
        apply_sql(&store_db, store_sql);
    }
    let mut ctx = AppReadContext::for_test(store, NOW_MS);
    configure(dir.path(), &mut ctx);
    let caller = direct_caller();
    let served = serve(&ctx, &caller, method, &params);
    (params, served)
}

/// Shorthand for cases that need no config files or identity roots.
fn plain(
    name: &'static str,
    file: &'static str,
    method: &'static str,
    context_sql: &str,
    store_sql: &str,
    params: Value,
) -> Record {
    let (_, served) = dispatch(context_sql, store_sql, |_, _| {}, method, params.clone());
    Record {
        name,
        file,
        method,
        params,
        served,
    }
}
/// Shared standalone OpenCode page: every state, every outside reason the
/// locator can produce for a managed session, plus stamped and dropped parts.
fn states_matrix_sql() -> String {
    include_str!("../../testdata/app-read-d/states.sql").to_string()
}

fn opencode_session(session: &str) -> Value {
    json!({"runner": "opencode", "harness": "opencode", "session": session})
}

fn states_records() -> Vec<Record> {
    let base = format!("{}{}", states_matrix_sql(), PIN_GENERATION);
    let mut records = vec![plain(
        "matrix-standalone",
        "context.states/matrix-standalone.json",
        "context.states",
        &base,
        "",
        json!({
            "session": opencode_session("s"),
            "message_ids": ["raw", "all", "summarized", "before", "missing",
                "compacted", "zero", "partial", "owner", "stamp", "file"],
        }),
    )];
    // Legacy Pi addresses: positional text ordinals, content-derived drift
    // keys, and file parts all in one page. Nothing is placed, so every
    // message stays raw and reports its drops.
    records.push(plain(
        "part-refs-pi",
        "context.states/part-refs-pi.json",
        "context.states",
        "INSERT INTO session_meta(session_id,harness) VALUES('s','pi'); \
         INSERT INTO tags(session_id,message_id,type,status,tag_number,byte_size,token_count,drop_mode) VALUES \
         ('s','m:p2','message','dropped',1,10,3,'full'), \
         ('s','m:mc-text-v1:vector:content:o1','message','dropped',2,20,6,'skeleton_real'), \
         ('s','m:file4','file','dropped',3,30,9,'full');",
        "",
        json!({
            "session": {"runner": "pi", "harness": "pi", "session": "s"},
            "message_ids": ["m"],
        }),
    ));
    // Mode-3 addresses are the runner's opaque part keys. One part is a
    // frozen whole-part drop, another a queued agent stamp.
    records.push(mode3_parts_record());
    // One message per split side: end, start and middle boundaries each keep
    // the raw prefix/suffix the compartment does not cover.
    records.push(plain(
        "split-sides",
        "context.states/split-sides.json",
        "context.states",
        &format!("INSERT INTO session_meta(session_id,harness) VALUES('s','opencode'); \
         INSERT INTO message_history_source(session_id,message_id,message_ordinal,source_version,normalized_content_hash,role,updated_at) VALUES \
         ('s','end',20,'v','h','assistant',1),('s','start',21,'v','h','assistant',1),('s','middle',23,'v','h','assistant',1); \
         INSERT INTO compartments(session_id,sequence,start_message,end_message,start_block_index,end_block_index,title,content,created_at) VALUES \
         ('s',1,19,20,NULL,2,'end','summary',1),('s',2,21,22,3,NULL,'start','summary',2),('s',3,23,23,2,3,'middle','summary',3); \
         INSERT INTO tags(session_id,message_id,type,status,tag_number) VALUES \
         ('s','end:p0','message','active',1),('s','end:p1','message','active',2),('s','end:p2','message','active',3), \
         ('s','end:p3','message','active',4),('s','end:p4','message','active',5),('s','end:p5','message','active',6), \
         ('s','start:p0','message','active',7),('s','start:p1','message','active',8),('s','start:p2','message','active',9), \
         ('s','start:p3','message','active',10),('s','start:p4','message','active',11),('s','start:p5','message','active',12), \
         ('s','middle:p0','message','active',13),('s','middle:p1','message','active',14),('s','middle:p2','message','active',15), \
         ('s','middle:p3','message','active',16),('s','middle:p4','message','active',17),('s','middle:p5','message','active',18); {PIN_GENERATION}"),
        "",
        json!({
            "session": opencode_session("s"),
            "message_ids": ["end", "start", "middle"],
        }),
    ));
    // A conditional read that matches the served version answers without
    // reading rows. The stored request embeds the served version, which is a
    // deterministic digest of indexed counters.
    {
        let dir = tempfile::tempdir().expect("sample store dir");
        let store = open_store(dir.path());
        let context_db = dir.path().join("context.db");
        apply_sql(&context_db, &base);
        let ctx = AppReadContext::for_test(store, NOW_MS);
        let caller = direct_caller();
        let params = json!({"session": opencode_session("s"), "message_ids": ["raw"]});
        let ready = match serve(&ctx, &caller, "context.states", &params) {
            Served::Reply(reply) => reply,
            Served::Refusal { code, .. } => panic!("ready states refused: {code}"),
        };
        let version = ready["version"].clone();
        let params = json!({
            "session": opencode_session("s"),
            "message_ids": ["raw"],
            "if_version": version,
        });
        records.push(Record {
            name: "unchanged",
            file: "context.states/unchanged.json",
            method: "context.states",
            params: params.clone(),
            served: serve(&ctx, &caller, "context.states", &params),
        });
    }
    // No session record at all, but the runner names its own harness, so the
    // page reports the transcript was never managed instead of refusing.
    records.push(plain(
        "never-managed",
        "context.states/never-managed.json",
        "context.states",
        "",
        "",
        json!({
            "session": opencode_session("unknown"),
            "message_ids": ["m"],
        }),
    ));
    // A runner that is not the harness can never fall back to the unmanaged
    // page: an unknown session is refused.
    records.push(plain(
        "refusal-unknown-session",
        "context.states/refusal-unknown-session.json",
        "context.states",
        "INSERT INTO session_meta(session_id,harness) VALUES('elsewhere','pi');",
        "",
        json!({
            "session": {"runner": "other", "harness": "pi", "session": "missing"},
            "message_ids": ["m"],
        }),
    ));
    records.push(plain(
        "refusal-too-many-ids",
        "context.states/refusal-too-many-ids.json",
        "context.states",
        &base,
        "",
        json!({
            "session": opencode_session("s"),
            "message_ids": (0..101).map(|n| format!("m{n}")).collect::<Vec<_>>(),
        }),
    ));
    records.push(plain(
        "refusal-bad-if-version",
        "context.states/refusal-bad-if-version.json",
        "context.states",
        &base,
        "",
        json!({
            "session": opencode_session("s"),
            "message_ids": ["raw"],
            "if_version": 42,
        }),
    ));
    records.push(plain(
        "refusal-resyncing",
        "context.states/refusal-resyncing.json",
        "context.states",
        "",
        &async_record_sql("runner", "pi", "s", 1, true),
        json!({
            "session": {"runner": "runner", "harness": "pi", "session": "s"},
            "message_ids": ["m"],
        }),
    ));
    records
}

/// Build the mode-3 conversation rows the locator and the held-transcript
/// readers use, with the same `Key` derivation the handlers resolve.
fn async_key(runner: &str, harness: &str, session: &str) -> crate::providers::Key {
    crate::providers::Key {
        runner: runner.into(),
        harness: harness.into(),
        session: session.into(),
    }
}

fn async_record_sql(
    runner: &str,
    harness: &str,
    session: &str,
    generation: u64,
    resync: bool,
) -> String {
    let key = async_key(runner, harness, session);
    let state = json!({
        "key": key,
        "runner_module": runner,
        "generation": generation,
        "resync": resync,
        "frozen_edits_version": null,
        "applied": null,
    })
    .to_string()
    .replace('\'', "''");
    format!(
        "INSERT INTO mc_async_compaction(session_ref,conversation_key,session,state_json) VALUES('{}','{}','{}','{}');",
        key.reference(),
        key.store_key().conversation_key(),
        session,
        state
    )
}

/// Mode-3 parts keyed by runner part key: a frozen drop and a queued stamp.
fn mode3_parts_record() -> Record {
    let key = async_key("runner", "pi", "s");
    let reference = key.reference();
    let namespace = format!("{}:async:1", key.engine_key());
    let baseline = include_str!("../../testdata/app-read-d/frozen-edits.json").replace('\'', "''");
    let store_sql = format!(
        "{} \
         INSERT INTO mc_async_compaction_entries(session_ref,session,ordinal,entry_json,index_json,mid) VALUES \
         ('{reference}','s',3,'{{\"ordinal\":3,\"mid\":\"m3\",\"bytes\":\"[]\"}}','[[\"§9§\",\"prt_3b\",\"digest-b\"],[\"§4§\",\"prt_3a\",\"digest-a\"]]','m3'); \
         INSERT INTO mc_tags(session_id,tag_number,block_id,kind,token_count,created_at_ms,source_bytes) VALUES \
         ('{namespace}',4,'m3#0','message',10,1,X'616263'),('{namespace}',9,'m3#2','tool_result',20,1,X''); \
         INSERT INTO mc_async_compaction_baselines(session_ref,session,slot,view_json) VALUES('{reference}','s','frozen_edits','{baseline}'); \
         UPDATE mc_async_compaction SET state_json=json_set(state_json,'$.frozen_edits_version',1); \
         INSERT INTO pending_agent_drops(session_id,target_id,queued_at) VALUES('{namespace}','m3#0',123);",
        async_record_sql("runner", "pi", "s", 1, false)
    );
    plain(
        "part-refs-mode3",
        "context.states/part-refs-mode3.json",
        "context.states",
        "",
        &store_sql,
        json!({
            "session": {"runner": "runner", "harness": "pi", "session": "s"},
            "message_ids": ["m3"],
        }),
    )
}

fn compartment_sql() -> String {
    format!(
        "{} \
         UPDATE compartments SET p1='tier one',p2='tier two',p3='tier three',p4='tier four',importance=72,episode_type='implementation' WHERE id=1; \
         INSERT INTO message_fts_rowid_map(session_id,message_ordinal,fts_rowid,message_time_ms) VALUES('s',2,1,100),('s',3,2,200); \
         INSERT INTO historian_runs(session_id,run_kind,status,compartment_id_min,compartment_id_max,facts_by_category_json,created_at) \
         VALUES('s','historian','completed',1,1,'{{\"DECISION\":2,\"CONSTRAINT\":1}}',300); {PIN_GENERATION} ",
        states_matrix_sql()
    )
}

fn compartment_records() -> Vec<Record> {
    vec![
        plain(
            "ready",
            "context.compartment/ready.json",
            "context.compartment",
            &compartment_sql(),
            "",
            json!({"session": opencode_session("s"), "compartment_id": "1"}),
        ),
        plain(
            "missing",
            "context.compartment/missing.json",
            "context.compartment",
            &compartment_sql(),
            "",
            json!({"session": opencode_session("s"), "compartment_id": "999"}),
        ),
    ]
}

/// Session `s` with three matching messages, the first two summarized.
fn search_messages_sql(with_project: bool) -> String {
    let project = if with_project {
        "INSERT INTO session_projects VALUES('s','pi','git:project',1);"
    } else {
        ""
    };
    format!(
        "INSERT INTO session_meta(session_id,harness) VALUES('s','pi'); {project} \
         INSERT INTO compartments(session_id,sequence,start_message,end_message,title,content,created_at) \
         VALUES('s',1,1,2,'title','summary',10); \
         INSERT INTO message_history_fts(session_id,message_ordinal,message_id,role,content) VALUES \
         ('s',1,'m1','assistant','the needle in the haystack'), \
         ('s',2,'m2','assistant','another needle here'), \
         ('s',3,'m3','user','a needle far from any summary'); \
         INSERT INTO message_fts_rowid_map(session_id,message_ordinal,fts_rowid,message_time_ms) \
         SELECT 's',message_ordinal,rowid,10 FROM message_history_fts WHERE session_id='s';"
    )
}

fn search_records() -> Vec<Record> {
    vec![
        plain(
            "refusal-session-not-found",
            "context.search/refusal-session-not-found.json",
            "context.search",
            "",
            "",
            json!({
                "query": "needle",
                "scope": {"session": {"runner": "pi", "harness": "pi", "session": "unmanaged"}},
                "sources": ["message"],
            }),
        ),
        plain(
            "hits",
            "context.search/hits.json",
            "context.search",
            &search_messages_sql(true),
            "",
            json!({
                "query": "needle",
                "scope": {"session": {"runner": "pi", "harness": "pi", "session": "s"}},
            }),
        ),
        plain(
            "no-hits",
            "context.search/no-hits.json",
            "context.search",
            &search_messages_sql(true),
            "",
            json!({
                "query": "zz-no-such-term",
                "scope": {"session": {"runner": "pi", "harness": "pi", "session": "s"}},
                "sources": ["message"],
            }),
        ),
        // No `session_projects` row names a project, so the project lanes
        // report unavailable instead of serving project sources.
        plain(
            "project-lanes-unavailable",
            "context.search/project-lanes-unavailable.json",
            "context.search",
            &search_messages_sql(false),
            "",
            json!({
                "query": "needle",
                "scope": {"session": {"runner": "pi", "harness": "pi", "session": "s"}},
            }),
        ),
    ]
}
fn cache_why_records() -> Vec<Record> {
    vec![
        // Standalone decisions join by the host assistant message id and
        // carry retention, limits and error fields alongside.
        plain(
            "standalone-producers",
            "context.cache_why/standalone-producers.json",
            "context.cache_why",
            "INSERT INTO session_meta(session_id,harness) VALUES('s','pi'); \
             UPDATE session_meta SET last_usage_context_limit=200000,detected_context_limit=128000, \
             detected_context_limit_model_key='model/a',detected_context_limit_provenance='model', \
             cache_ttl='5m',last_transform_error='failed'; \
             INSERT INTO transform_decisions(session_id,harness,message_id,ts_ms,decision,materialized,materialize_reason, \
             system_hash_prev,system_hash_new,m0_tool_set_hash_prev,m0_tool_set_hash_new,m0_model_key_prev,m0_model_key_new, \
             emergency,dropped_tokens,dropped_count,input_tokens) VALUES \
             ('s','pi','host-assistant',100,'execute',1,'ttl_idle','old','new','tools','tools','model/a','model/b',1,12000,4,83000), \
             ('s','pi','other-message',90,'execute',1,'system_hash','old','new','tools','tools','model/a','model/b',0,10,1,100);",
            "",
            json!({
                "session": {"runner": "pi", "harness": "pi", "session": "s"},
                "producers": [
                    {"producer_ref": "host-assistant", "at_ms": 999},
                    {"producer_ref": "older-than-retention", "at_ms": 50},
                    {"producer_ref": "no-such-step", "at_ms": 100},
                ],
            }),
        ),
        // Mode-3 reasons are scheduler windows only: the join is unavailable
        // and no runner step id is ever invented.
        plain(
            "mode3-window",
            "context.cache_why/mode3-window.json",
            "context.cache_why",
            "",
            &mode3_window_sql(),
            json!({
                "session": {"runner": "runner", "harness": "pi", "session": "s"},
                "window": {},
                "limit": 100,
            }),
        ),
    ]
}

fn mode3_window_sql() -> String {
    let namespace = format!("{}:async:1", async_key("runner", "pi", "s").engine_key());
    format!(
        "{} \
         INSERT INTO mc_cache_state(session_id,row_version,core_state,meta) VALUES \
         ('{namespace}',1,'{{}}','{{\"last_usage\":{{\"context_limit_tokens\":200000}}, \
         \"cache_ttl_policy\":{{\"value\":\"5m\",\"source\":\"session\",\"model_key\":null}}}}'); \
         INSERT INTO mc_pass_trace_history(session_id,kind,slot,seq,entry) VALUES \
         ('{namespace}','scheduler',2,2,'{{\"timestamp_ms\":101,\"producer_ref\":\"step-request\", \
         \"scheduler_decision\":\"Defer\",\"canonical_decision\":\"defer\", \
         \"defer_reason\":\"mid_turn_boundary\",\"drain_latch_active\":false, \
         \"identity_delta\":[\"system_hash\"]}}'), \
         ('{namespace}','scheduler',1,1,'{{\"timestamp_ms\":100,\"scheduler_decision\":\"Execute\", \
         \"drain_latch_active\":false}}');",
        async_record_sql("runner", "pi", "s", 1, false),
    )
}

fn session_data_records() -> Vec<Record> {
    vec![
        // The session row plus its compartment and queued-stamp counts. The
        // states page fixture holds one compartment and two queued drops; the
        // one inside the summarized message is not a listed stamp, so the
        // count is 1, as the states pages sum to.
        plain(
            "meta",
            "session_data.read/meta.json",
            "session_data.read",
            &states_matrix_sql(),
            "",
            json!({
                "session": opencode_session("s"),
                "section": "meta",
            }),
        ),
        // The pass recorded a provider-reported input total.
        plain(
            "token-breakdown-provider",
            "session_data.read/token-breakdown-provider.json",
            "session_data.read",
            "INSERT INTO session_meta(session_id,harness,last_input_tokens,total_input_tokens,new_work_tokens) \
             VALUES('ses','opencode',80,80,10);",
            "",
            json!({
                "session": opencode_session("ses"),
                "section": "token_breakdown",
            }),
        ),
        // Host counts were saved before the provider response completed.
        plain(
            "token-breakdown-host-pass",
            "session_data.read/token-breakdown-host-pass.json",
            "session_data.read",
            "INSERT INTO session_meta(session_id,harness,last_response_time,last_input_tokens,system_prompt_tokens,total_input_tokens,new_work_tokens) \
             VALUES('host','opencode',1700000000200,649000,18000,649000,0); \
             CREATE TABLE IF NOT EXISTS session_render_cache(session_id TEXT, cache_key TEXT, value BLOB, PRIMARY KEY(session_id,cache_key)) WITHOUT ROWID; \
             INSERT INTO session_render_cache VALUES('host','host_token_breakdown', \
             '{\"version\":1,\"measured_at\":1700000000000,\"tolerance\":{\"ratio\":0.01,\"tokens\":500},\"last_user_message_in_history_raw\":true,\"parts\":{\"tool_definitions\":27000,\"project_docs\":21000,\"user_profile\":3000,\"history_raw\":76000,\"tool_calls_results\":481000,\"last_user_message\":0}}');",
            "",
            json!({"session": opencode_session("host"), "section": "token_breakdown"}),
        ),
        // No provider total was recorded, so the legacy estimate stands in.
        plain(
            "token-breakdown-estimate",
            "session_data.read/token-breakdown-estimate.json",
            "session_data.read",
            "INSERT INTO session_meta(session_id,harness,last_input_tokens,total_input_tokens,new_work_tokens) \
             VALUES('est','opencode',0,0,15);",
            "",
            json!({
                "session": {"runner": "opencode", "harness": "opencode", "session": "est"},
                "section": "token_breakdown",
            }),
        ),
        // The session names no managed record, so nothing is attributed.
        plain(
            "token-breakdown-unmanaged",
            "session_data.read/token-breakdown-unmanaged.json",
            "session_data.read",
            "",
            "",
            json!({
                "session": {"runner": "opencode", "harness": "opencode", "session": "missing"},
                "section": "token_breakdown",
            }),
        ),
        // A mode-3 session's breakdown lives behind the async index, which
        // this lane does not serve: the refusal is the recorded sample.
        plain(
            "token-breakdown-mode3-unavailable",
            "session_data.read/token-breakdown-mode3-unavailable.json",
            "session_data.read",
            "",
            &async_record_sql("runner", "opencode", "s", 1, false),
            json!({
                "session": {"runner": "runner", "harness": "opencode", "session": "s"},
                "section": "token_breakdown",
            }),
        ),
    ]
}

fn project_memory_records() -> Vec<Record> {
    vec![plain(
        "memories",
        "project_memory.read/memories.json",
        "project_memory.read",
        include_str!("../../testdata/app-read-g/lists.sql"),
        "",
        json!({
            "section": "memories",
            "project": "git:a",
            "filters": {"status": ["active"]},
        }),
    )]
}

fn dreamer_records() -> Vec<Record> {
    vec![plain(
        "schedule",
        "dreamer.read/schedule.json",
        "dreamer.read",
        include_str!("../../testdata/app-read-g/lists.sql"),
        "",
        json!({"section": "schedule"}),
    )]
}

fn health_records() -> Vec<Record> {
    vec![plain(
        "healthy",
        "store.health/healthy.json",
        "store.health",
        "",
        "",
        json!({}),
    )]
}

/// Copy the config fixtures beside the store and point the context at them,
/// so no machine-local config or environment leaks into the sample.
fn with_config_files(dir: &Path, ctx: &mut AppReadContext) {
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("testdata/app-read-g/config");
    let user = dir.join("user.json");
    let root = dir.join("project");
    let project = root.join(".cortexkit/magic-context.json");
    std::fs::create_dir_all(project.parent().expect("project config dir"))
        .expect("project config dir");
    std::fs::copy(fixture.join("user.json"), &user).expect("user fixture");
    std::fs::copy(fixture.join("project.json"), &project).expect("project fixture");
    ctx.set_config_files(user, Some(project));
    ctx.set_identity_root("git:fixture", root);
}

fn config_records() -> Vec<Record> {
    let (_, served) = dispatch(
        "",
        "",
        with_config_files,
        "config.read",
        json!({"project": "git:fixture"}),
    );
    let read = Record {
        name: "effective",
        file: "config.read/effective.json",
        method: "config.read",
        params: json!({"project": "git:fixture"}),
        served,
    };
    // With no embedding configured there is no endpoint to probe, so the
    // refusal names the disabled lane. The empty user layer keeps the
    // machine's own config out of the sample.
    let (_, refused) = dispatch(
        "",
        "",
        |dir, ctx| {
            let user = dir.join("user.json");
            std::fs::write(&user, "{}").expect("empty user config");
            ctx.set_config_files(user, None);
        },
        "config.embedding_probe",
        json!({}),
    );
    let probe = Record {
        name: "disabled",
        file: "config.embedding_probe/disabled.json",
        method: "config.embedding_probe",
        params: json!({}),
        served: refused,
    };
    vec![read, probe]
}

/// Every recorded exchange, in file order.
fn all_records() -> Vec<Record> {
    let mut records = Vec::new();
    records.extend(states_records());
    records.extend(compartment_records());
    records.extend(search_records());
    records.extend(cache_why_records());
    records.extend(session_data_records());
    records.extend(project_memory_records());
    records.extend(dreamer_records());
    records.extend(health_records());
    records.extend(config_records());
    for (name, params, result) in super::watch::samples() {
        let (file, served) = match result {
            Ok(value) => (
                if name == "resync" {
                    "context.watch/resync.json"
                } else {
                    "context.watch/changes.json"
                },
                Served::Reply(value),
            ),
            Err(HandlerOutcome::ErrorWithDetail {
                code,
                message,
                detail,
            }) => (
                "context.watch/refusal.json",
                Served::Refusal {
                    code,
                    message,
                    detail,
                },
            ),
            Err(other) => panic!("unexpected watch refusal {other:?}"),
        };
        records.push(Record {
            name,
            file,
            method: super::watch::METHOD,
            params,
            served,
        });
    }
    records
}
fn sample_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(SAMPLE_DIR)
}

fn hex_digest(bytes: &[u8]) -> String {
    use sha2::Digest;
    format!("{:x}", sha2::Sha256::digest(bytes))
}

/// Regenerate every sample from the live handlers and rewrite the directory.
fn regenerate(records: &[Record]) {
    let root = sample_root();
    let mut sums = Vec::new();
    for record in records {
        let bytes = sample_bytes(record);
        let path = root.join(record.file);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("sample dir");
        }
        std::fs::write(&path, &bytes).expect("sample file");
        sums.push(format!("{}  {}", hex_digest(&bytes), record.file));
    }
    sums.sort();
    sums.push(String::new());
    std::fs::write(root.join("SHA256SUMS"), sums.join("\n")).expect("SHA256SUMS");
}

/// The samples match the handlers byte for byte, and `SHA256SUMS` lists
/// exactly the files present with their digests. With
/// `MC_REGENERATE_APP_READ_SAMPLES=1` the files are rewritten instead.
#[test]
fn app_read_samples_match_handlers() {
    let records = all_records();
    if std::env::var_os(REGENERATE_ENV).is_some() {
        regenerate(&records);
        return;
    }
    let root = sample_root();
    for record in &records {
        let expected = sample_bytes(record);
        let path = root.join(record.file);
        let actual = std::fs::read(&path).unwrap_or_else(|_| {
            panic!(
                "missing sample {}: regenerate with {REGENERATE_ENV}=1",
                record.file
            )
        });
        if actual != expected {
            let wanted: Value = serde_json::from_slice(&expected).expect("sample is JSON");
            let got: Value = serde_json::from_slice(&actual).expect("served is JSON");
            panic!(
                "sample {} drifted from its handler: {} (regenerate with {REGENERATE_ENV}=1)",
                record.file,
                first_difference("", &got, &wanted).unwrap_or_default()
            );
        }
        if record.method == super::watch::METHOD {
            if let Served::Reply(notice) = &record.served {
                let exchange: Value = serde_json::from_slice(&actual).expect("watch sample JSON");
                assert_eq!(
                    &exchange["response"], notice,
                    "watch samples must not invent wire fields"
                );
            }
        }
        assert!(
            expected.len() <= super::envelope::REPLY_LIMIT,
            "sample {} exceeds the reply budget",
            record.file
        );
    }
    // No extra or missing files: the directory holds exactly the records.
    let mut listed: Vec<String> = records.iter().map(|r| r.file.to_string()).collect();
    listed.sort();
    listed.dedup();
    assert_eq!(
        listed.len(),
        records.len(),
        "two records share a sample file"
    );
    let mut on_disk = Vec::new();
    for op in std::fs::read_dir(&root).expect("sample root") {
        let op = op.expect("op dir").path();
        if op
            .file_name()
            .is_some_and(|name| name == "SHA256SUMS" || name == "README.md")
        {
            continue;
        }
        for case in std::fs::read_dir(&op).expect("op dir") {
            let case = case.expect("case file").path();
            on_disk.push(
                case.strip_prefix(&root)
                    .expect("sample path")
                    .to_string_lossy()
                    .replace('\\', "/"),
            );
        }
    }
    on_disk.sort();
    assert_eq!(on_disk, listed, "sample directory holds unlisted files");
    let sums = std::fs::read_to_string(root.join("SHA256SUMS")).expect("SHA256SUMS");
    let mut expected_sums: Vec<String> = records
        .iter()
        .map(|record| {
            let bytes = std::fs::read(root.join(record.file)).expect("sample file");
            format!("{}  {}", hex_digest(&bytes), record.file)
        })
        .collect();
    expected_sums.sort();
    expected_sums.push(String::new());
    assert_eq!(
        sums,
        expected_sums.join("\n"),
        "SHA256SUMS does not match the samples"
    );
}

/// The README lists every sample file, and every app method has at least one
/// sample, so a new op cannot ship without a recorded exchange.
#[test]
fn app_read_samples_readme_covers_every_method() {
    let records = all_records();
    let readme = std::fs::read_to_string(sample_root().join("README.md")).expect("samples README");
    for record in &records {
        assert!(
            readme.contains(record.file),
            "README does not list {}",
            record.file
        );
    }
    for method in APP_READ_METHODS {
        assert!(
            records.iter().any(|record| record.method == *method),
            "no sample covers {method}"
        );
    }
}

/// First JSON path where two values differ, for drift diagnosis.
fn first_difference(path: &str, expected: &Value, actual: &Value) -> Option<String> {
    if expected == actual {
        return None;
    }
    match (expected, actual) {
        (Value::Object(expected), Value::Object(actual)) => {
            for (key, value) in expected {
                let at = if path.is_empty() {
                    key.clone()
                } else {
                    format!("{path}.{key}")
                };
                match actual.get(key) {
                    Some(other) => {
                        if let Some(difference) = first_difference(&at, value, other) {
                            return Some(difference);
                        }
                    }
                    None => return Some(format!("{at}: missing in served reply")),
                }
            }
            for key in actual.keys() {
                if !expected.contains_key(key) {
                    let at = if path.is_empty() {
                        key.clone()
                    } else {
                        format!("{path}.{key}")
                    };
                    return Some(format!("{at}: missing in sample file"));
                }
            }
            Some(format!("{path}: objects differ"))
        }
        (Value::Array(expected), Value::Array(actual)) if expected.len() == actual.len() => {
            for (index, (wanted, got)) in expected.iter().zip(actual).enumerate() {
                if let Some(difference) = first_difference(&format!("{path}[{index}]"), wanted, got)
                {
                    return Some(difference);
                }
            }
            Some(format!("{path}: arrays differ"))
        }
        _ => Some(format!(
            "{path}: sample {} served {}",
            truncate(expected),
            truncate(actual)
        )),
    }
}

fn truncate(value: &Value) -> String {
    let text = serde_json::to_string(value).unwrap_or_default();
    if text.len() > 200 {
        format!("{}…", &text[..200])
    } else {
        text
    }
}

/// The compartment generation seed is random in production
/// (`randomblob(16)` default). Samples pin it so versions are byte-stable;
/// the handlers still digest the stored row exactly as served.
const PIN_GENERATION: &str =
    "UPDATE compartment_history_versions SET generation='0123456789abcdef0123456789abcdef' WHERE session_id='s';";
