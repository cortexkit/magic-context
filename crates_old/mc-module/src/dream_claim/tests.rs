//! `dream.ownership`, `dream.run` and `dreamer.run_task` against the published
//! list, on a real handler and store. Publication is fed by the fixture's config
//! and wiring, never by a request field. A Host claimant can no longer be
//! declared: its `dream.child.*` routes are retired.

use super::*;
use crate::dream_dispatch::ownership::Wiring;
use crate::historian_runner::HistorianRunnerKind;
use crate::{McModuleConfig, SessionBinding};
use mc_store::McStore;
use std::sync::Arc;

/// Channel 7: a plugin route. Channel 9: an attested harness route of the same
/// project.
const PLUGIN: u16 = 7;
const HARNESS: u16 = 9;

struct Route {
    _root: tempfile::TempDir,
    handler: McHandler,
}

fn attested(mut binding: SessionBinding) -> SessionBinding {
    binding.session = "harness-session".into();
    binding.principal = Some(subc_protocol::Principal::Reserved {
        module_id: "thalamus-harness".into(),
    });
    binding.scope = Some(
        subc_protocol::scope::ScopeStamp::new(
            subc_protocol::Principal::Reserved {
                module_id: "prefrontal-core".into(),
            },
            "harness-session",
            1,
            subc_protocol::scope::ScopeKind::Head,
        )
        .with_owner_authorized(true),
    );
    binding
}

/// A handler over a fresh store whose plugin route runs `harness`. With
/// `broca`, the user configured Broca as the dreamer runner and this build wired
/// a Broca transport; otherwise the runner is the harness default (Host).
fn route(harness: &str, activated: bool, broca: bool) -> Route {
    let base = std::env::temp_dir().join("magic-context/i5-stage-d");
    std::fs::create_dir_all(&base).unwrap();
    let root = tempfile::tempdir_in(base).unwrap();
    let directory = root.path().canonicalize().unwrap();
    let store =
        Arc::new(McStore::open(&crate::dev_descriptor_at(root.path().to_str().unwrap())).unwrap());
    let context_path = root.path().join("context.db");
    rusqlite::Connection::open(&context_path)
        .unwrap()
        .execute_batch(
            &include_str!("../../../mc-store/testdata/context_schema/schema.sql")
                .replace(":applied_at", "1"),
        )
        .unwrap();
    store.install_context_domain(Arc::new(
        mc_store::SqliteContextDomain::open(&context_path).unwrap(),
    ));
    let mut handler = McHandler::new();
    assert!(handler.store.set(store).is_ok());
    handler.fixed_config = Some(McModuleConfig {
        rust_background_enabled: activated,
        dreamer_runner: broca.then_some(HistorianRunnerKind::Broca),
        ..Default::default()
    });
    let mut settings = json!({"dreamer": {"tasks": {}}});
    // Models resolve under the harness's own key; OpenCode 2 reads OpenCode's.
    let key = if harness == "opencode2" {
        "opencode"
    } else {
        harness
    };
    settings["dreamer"][key] = json!({"model": "anthropic/claude-sonnet-4-5"});
    handler.fixed_dream_settings = Some(settings);
    handler.dream_wiring = Some(Wiring {
        broca,
        ..Wiring::production()
    });
    let plugin = SessionBinding {
        principal: None,
        scope: None,
        project_root: directory,
        harness: harness.into(),
        session: "parent".into(),
        model_key: None,
        config: McModuleConfig::default(),
        history_budget_tokens: 1000.0,
    };
    handler.bind_route(HARNESS, attested(plugin.clone()));
    handler.bind_route(PLUGIN, plugin);
    Route {
        _root: root,
        handler,
    }
}

async fn call(handler: &McHandler, channel: u16, request: Value) -> Value {
    match Box::pin(handler.dispatch_value(channel, request)).await {
        HandlerOutcome::Response(bytes) => serde_json::from_slice(&bytes).unwrap(),
        HandlerOutcome::Error { code, message } => json!({"error": code, "message": message}),
        other => panic!("unexpected outcome {other:?}"),
    }
}

async fn read(handler: &McHandler, channel: u16) -> Value {
    call(
        handler,
        channel,
        json!({"v": 1, "method": "dream.ownership"}),
    )
    .await
}

fn published(body: &Value) -> Vec<String> {
    body["published"]
        .as_array()
        .unwrap_or_else(|| panic!("no published list in {body}"))
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect()
}

/// The memory-only operational tasks: a production Broca wiring cannot know that
/// Broca admits AFT's read tools, so the file-reading tasks stay with TypeScript.
const BROCA_PUBLISHED: [&str; 3] = ["curate", "classify-memories", "review-user-memories"];

/// A claimant declaration, or its withdrawal, is refused by name on every lane:
/// accepting one would publish tasks whose children nobody could claim.
#[tokio::test]
async fn a_claimant_declaration_is_refused_as_a_retired_route() {
    let r = route("opencode2", true, false);
    let declaration = json!({"capabilities": {"tools": ["ctx_memory"]}, "agents": {}});
    for channel in [HARNESS, PLUGIN] {
        for claimant in [declaration.clone(), Value::Null] {
            let answer = call(
                &r.handler,
                channel,
                json!({"v": 1, "method": "dream.ownership", "claimant": claimant}),
            )
            .await;
            assert_eq!(answer["error"], "transform_route_retired", "{channel}");
            assert_eq!(answer["message"], "dream.ownership claimant", "{channel}");
        }
    }
    let answer = read(&r.handler, PLUGIN).await;
    assert_eq!(answer["claimant_declared"], false);
    assert_eq!(published(&answer), Vec::<String>::new());
}

/// The harness-default Host runner has no carrier without a claimant, so
/// nothing is published and every task stays with TypeScript.
#[tokio::test]
async fn the_host_runner_publishes_nothing() {
    let r = route("opencode2", true, false);
    for channel in [HARNESS, PLUGIN] {
        let answer = read(&r.handler, channel).await;
        assert_eq!(answer["activated"], true);
        assert_eq!(answer["runner"]["kind"], "host");
        assert_eq!(published(&answer), Vec::<String>::new());
    }
}

/// A configured and wired Broca runner gets the memory-only operational tasks;
/// with the switch off nothing is published.
#[tokio::test]
async fn a_configured_broca_runner_publishes_and_the_switch_off_publishes_nothing() {
    let on = route("opencode2", true, true);
    for channel in [HARNESS, PLUGIN] {
        assert_eq!(
            published(&read(&on.handler, channel).await),
            BROCA_PUBLISHED
        );
    }
    let off = route("opencode2", false, true);
    let answer = read(&off.handler, PLUGIN).await;
    assert_eq!(answer["activated"], false);
    assert_eq!(published(&answer), Vec::<String>::new());
}

#[tokio::test]
async fn ownership_and_run_task_keep_the_served_project_on_the_bound_channel() {
    let r = route("opencode2", true, true);
    let store = r.handler.store.get().unwrap();
    store.with_context_conn_for_test(|db| {
        db.execute_batch("INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES ('parent', 'opencode2', 'pj-original', 1), ('harness-session', 'opencode2', 'pj-original', 1)")
    }).unwrap();
    let original = read(&r.handler, PLUGIN).await;
    assert!(!published(&original).is_empty());

    // A host-row update cannot move an already-served channel into a different
    // project. A fresh channel adopts the newly recorded key, which no store row
    // backs, so `dreamer.run_task` refuses it as invalid.
    store
        .with_context_conn_for_test(|db| {
            db.execute(
                "UPDATE session_projects SET project_path='pj-next' WHERE session_id='parent'",
                [],
            )
        })
        .unwrap();
    r.handler
        .bind_route(8, r.handler.facade_binding(PLUGIN).unwrap());
    assert_eq!(
        published(&read(&r.handler, PLUGIN).await),
        published(&original)
    );
    let curate = json!({"v":1,"method":"dreamer.run_task","session_id":"parent","task":"curate"});
    assert_eq!(
        call(&r.handler, PLUGIN, curate.clone()).await["error"],
        "rust_scheduler_owns_task"
    );
}

#[tokio::test]
async fn ownership_route_refuses_bad_versions_and_foreign_lanes() {
    let r = route("opencode2", true, false);
    let answer = call(
        &r.handler,
        PLUGIN,
        json!({"v": 2, "method": "dream.ownership"}),
    )
    .await;
    assert_eq!(answer["error"], "bad_request");
    let foreign = route("claude-code", true, false);
    assert_eq!(
        read(&foreign.handler, PLUGIN).await["error"],
        "host_lane_requires_plugin"
    );
}

/// A plugin route keeps running every unpublished task exactly as with the
/// switch off; only a published task is refused with `rust_scheduler_owns_task`.
#[tokio::test]
async fn run_task_on_a_plugin_route_refuses_only_published_tasks() {
    for broca in [false, true] {
        let r = route("opencode2", true, broca);
        // The classify route's own name is not a canonical task, so publication
        // never claims it.
        let legacy = call(
            &r.handler,
            PLUGIN,
            json!({"v": 1, "method": "dreamer.run_task", "session_id": "parent",
                "task": "classify", "command_id": "c1",
                "payload": {"prompt_body": "p", "items": []}}),
        )
        .await;
        assert_eq!(legacy["error"], "model_chain_missing", "{broca}");
        let curate = json!({"v": 1, "method": "dreamer.run_task", "session_id": "parent",
            "task": "curate"});
        assert_eq!(
            call(&r.handler, PLUGIN, curate).await["error"],
            if broca {
                "rust_scheduler_owns_task"
            } else {
                "invalid_params"
            },
            "{broca}"
        );
    }
}

/// `dream.run` refuses a task Rust does not publish, so it stays with TypeScript.
#[tokio::test]
async fn dream_run_refuses_an_unpublished_task() {
    let r = route("opencode2", true, false);
    let answer = call(
        &r.handler,
        PLUGIN,
        json!({"v": 1, "method": "dream.run", "task": "curate", "command_id": "c1"}),
    )
    .await;
    assert_eq!(answer, json!({"ok": false, "refusal": "not_published"}));
}
