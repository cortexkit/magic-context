use super::*;
use cortexkit_role_tool_provider::user_command;
use subc_protocol::scope::{ScopeAttributes, ScopeKind, ScopeStamp};

fn stamp() -> ScopeStamp {
    ScopeStamp::new(
        subc_protocol::Principal::Reserved {
            module_id: "prefrontal-core".into(),
        },
        "person-session",
        1,
        ScopeKind::Head,
    )
    .with_owner_authorized(true)
}
fn attest(rig: &Rig, scope: Option<ScopeStamp>) {
    let mut binding = rig.h.facade_binding(7).unwrap();
    binding.scope = scope;
    rig.h.bind_route(7, binding);
}
async fn invoke(rig: &Rig, key: &str, command: &str, input: &str) -> HandlerOutcome {
    rig.h.dispatch_value(7, json!({"name":"user_command.invoke","call_key":key,"arguments":{"command":command,"input":input}})).await
}
async fn pull(rig: &Rig) -> Value {
    response(
        rig.h
            .dispatch_value(7, json!({"name":"late_results","arguments":{"since":null}}))
            .await,
    )
}
async fn terminal(rig: &Rig) -> Value {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let reply = pull(rig).await;
            if reply["entries"]
                .as_array()
                .unwrap()
                .iter()
                .any(|entry| entry["kind"] == "result")
            {
                return reply;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("command settled")
}
fn refusal(outcome: HandlerOutcome) -> (String, Value) {
    match outcome {
        HandlerOutcome::ErrorWithDetail { code, detail, .. } => (code, detail),
        other => panic!("expected named refusal: {other:?}"),
    }
}
async fn ready(dir: &Path) -> Rig {
    let rig = Rig::new(dir).await;
    rig.fill(40);
    rig.notice(1, 1000, None).await;
    // Finish the notice's historian evaluation before measuring command writes.
    tokio::time::timeout(Duration::from_secs(10), async {
        while rig
            .h
            .provider_store
            .async_runtime
            .historian_inflight
            .load(std::sync::atomic::Ordering::SeqCst)
            != 0
        {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .expect("notice historian settled");
    attest(&rig, Some(stamp()));
    rig
}
fn pending_history(rig: &Rig) {
    rig.h
        .store
        .get()
        .unwrap()
        .replace_compartments(
            &rig.state().namespace(),
            &[mc_store::StoredCompartment {
                sequence: 1,
                start_message: 0,
                end_message: 9,
                end_message_id: "m9#0".into(),
                title: "history".into(),
                content: "user-command history".into(),
                p1: Some("user-command history".into()),
                importance: 50,
                ..Default::default()
            }],
        )
        .unwrap();
}

#[tokio::test]
async fn person_admission_refuses_run_flow_and_unscoped_invokes() {
    let dir = tempfile::tempdir().unwrap();
    let rig = ready(dir.path()).await;
    assert!(user_command::admitted(Some(
        &crate::compatible_wire(stamp()).unwrap()
    )));
    let flow = stamp().with_attributes(ScopeAttributes::new().with_flow_id(Some("flow".into())));
    // The role's own admission still refuses a flow scope...
    assert!(!user_command::admitted(Some(
        &crate::compatible_wire(&flow).unwrap()
    )));
    // ...but a flow-scoped route never reaches it: the dispatcher's flow fence
    // refuses every method but the flow ops first.
    attest(&rig, Some(flow));
    match invoke(&rig, "admit", "ctx-status", "").await {
        HandlerOutcome::Error { code, .. } => assert_eq!(code, "flow_route_not_admitted"),
        other => panic!("expected the flow fence's refusal: {other:?}"),
    }
    for scope in [
        Some(
            stamp().with_attributes(
                ScopeAttributes::new()
                    .with_agent_id(Some("agent".into()))
                    .with_run_id(Some("run".into())),
            ),
        ),
        None,
    ] {
        attest(&rig, scope);
        assert_eq!(
            refusal(invoke(&rig, "admit", "ctx-status", "").await).0,
            "user_command_not_admitted"
        );
    }
    attest(&rig, Some(stamp()));
    assert_eq!(
        response(invoke(&rig, "plain", "ctx-status", "").await)["state"],
        "done"
    );
}

#[tokio::test]
async fn declared_status_is_read_only_and_resolves_async_before_every_harness() {
    let dir = tempfile::tempdir().unwrap();
    let rig = ready(dir.path()).await;
    rig.queue(&[103]).await;
    let store = rig.h.store.get().unwrap();
    let before = store.load_meta(&rig.state().namespace()).unwrap();
    for harness in ["runner", "opencode", "opencode2", "claude-code", "pi"] {
        let mut binding = rig.h.facade_binding(7).unwrap();
        binding.harness = harness.into();
        rig.h.bind_route(7, binding);
        let reply = response(invoke(&rig, harness, "ctx-status", " \t").await);
        assert_eq!(reply["state"], "done");
        let text = reply["text"].as_str().unwrap();
        for fact in [
            "1000 / 100000 estimated tokens (1.0%)",
            "Queued drops: 1",
            "Rebuild:",
            "Cache expiry: runner-owned",
            "History:",
        ] {
            assert!(text.contains(fact), "{text}");
        }
    }
    assert_eq!(
        store
            .load_meta(&rig.state().namespace())
            .unwrap()
            .row_version,
        before.row_version
    );
    assert_eq!(rig.pending_targets().len(), 1);
    assert_eq!(
        rig.resolver
            .calls
            .load(std::sync::atomic::Ordering::Relaxed),
        0
    );
}

#[tokio::test]
async fn call_key_returns_first_reply_without_dispatching_changed_command() {
    let dir = tempfile::tempdir().unwrap();
    let rig = ready(dir.path()).await;
    let first = response(invoke(&rig, "replay", "ctx-status", "").await);
    pending_history(&rig);
    let before = rig.newest();
    let replay = response(invoke(&rig, "replay", "ctx-flush", "").await);
    assert_eq!(replay, first);
    assert_eq!(rig.newest(), before);
    assert!(pull(&rig).await["entries"].as_array().unwrap().is_empty());
    let restarted = McHandler::new();
    restarted
        .store
        .set(Arc::clone(rig.h.store.get().unwrap()))
        .ok()
        .unwrap();
    restarted.bind_route(7, rig.h.facade_binding(7).unwrap());
    assert_eq!(response(restarted.dispatch_value(7, json!({"name":"user_command.invoke","call_key":"replay","arguments":{"command":"ctx-flush","input":""}})).await), first);
}

#[tokio::test]
async fn user_flush_publishes_once_under_shared_permission_and_nothing_when_idle() {
    let dir = tempfile::tempdir().unwrap();
    let rig = ready(dir.path()).await;
    rig.queue(&[103]).await;
    let store = rig.h.store.get().unwrap();
    assert!(
        !store
            .load_meta(&rig.state().namespace())
            .unwrap()
            .meta
            .soft_refresh_pending
    );
    let before = rig.newest().unwrap_or(0);
    assert_eq!(
        response(invoke(&rig, "flush", "ctx-flush", "").await)["state"],
        "accepted"
    );
    let result = terminal(&rig).await;
    let final_reply = &result["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["kind"] == "result")
        .unwrap()["result"];
    assert_eq!(final_reply["state"], "done", "{result}");
    assert_eq!(rig.newest(), Some(before + 1));
    assert!(rig.pending_targets().is_empty());
    let meta = store.load_meta(&rig.state().namespace()).unwrap().meta;
    assert!(!meta.soft_refresh_pending);
    let idle = response(invoke(&rig, "idle", "ctx-flush", "").await);
    assert_eq!(idle["state"], "done");
    assert!(idle["text"].as_str().unwrap().contains("Nothing to flush"));
    assert_eq!(rig.newest(), Some(before + 1));
}

#[tokio::test]
async fn flush_applies_pending_history_in_published_view() {
    let dir = tempfile::tempdir().unwrap();
    let rig = ready(dir.path()).await;
    pending_history(&rig);
    let before = rig.newest().unwrap_or(0);
    assert_eq!(
        response(invoke(&rig, "history", "ctx-flush", "").await)["state"],
        "accepted"
    );
    let result = terminal(&rig).await;
    assert_eq!(
        result["entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["kind"] == "result")
            .unwrap()["result"]["state"],
        "done"
    );
    assert_eq!(rig.newest(), Some(before + 1));
    assert_eq!(
        rig.h
            .store
            .get()
            .unwrap()
            .load_meta(&rig.state().namespace())
            .unwrap()
            .meta
            .coverage_ordinal,
        Some(9)
    );
    let view = rig.get(before + 1).await;
    assert!(String::from_utf8(rig.render(&view))
        .unwrap()
        .contains("user-command history"));
}

#[tokio::test]
async fn long_command_reports_progress_then_one_result_and_acknowledges() {
    let dir = tempfile::tempdir().unwrap();
    let rig = ready(dir.path()).await;
    rig.queue(&[103]).await;
    let reply = response(
        tokio::time::timeout(
            Duration::from_secs(5),
            invoke(&rig, "long", "ctx-flush", ""),
        )
        .await
        .expect("prompt command admission"),
    );
    assert_eq!(reply["state"], "accepted");
    assert!(reply["job"].as_str().unwrap().starts_with("ctx-flush-"));
    let held = rig.h.provider_serial.lock_for(&rig.state().key).await;
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(6)).await;
        drop(held);
    })
    .await
    .unwrap();
    let late = terminal(&rig).await;
    let entries = late["entries"].as_array().unwrap();
    assert_eq!(
        entries
            .iter()
            .map(|entry| entry["kind"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["progress", "result"]
    );
    assert!(entries[0]["text"]
        .as_str()
        .unwrap()
        .contains("user-permitted"));
    assert_eq!(entries[1]["result"]["state"], "done");
    assert_eq!(response(invoke(&rig, "long", "ctx-flush", "").await), reply);
    assert_eq!(pull(&rig).await, late);
    assert_eq!(
        response(
            rig.h
                .dispatch_value(
                    7,
                    json!({"name":"late_results.ack","arguments":{"through":late["cursor"]}})
                )
                .await
        )["ok"],
        true
    );
    assert!(pull(&rig).await["entries"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn non_async_worker_unknown_and_bad_arguments_are_named_refusals() {
    let dir = tempfile::tempdir().unwrap();
    let rig = ready(dir.path()).await;
    assert_eq!(
        refusal(invoke(&rig, "unknown", "ctx-dream", "").await),
        (
            "unknown_user_command".into(),
            json!({"command":"ctx-dream"})
        )
    );
    assert_eq!(
        refusal(invoke(&rig, "bad", "ctx-status", "extra").await).1["field"],
        "input"
    );
    assert_eq!(
        refusal(invoke(&rig, "bad-wrapup", "ctx-wrapup", "keep-0").await).1["field"],
        "keep"
    );
    attest(
        &rig,
        Some(ScopeStamp::new(
            stamp().owner,
            "worker",
            1,
            ScopeKind::Worker,
        )),
    );
    assert_eq!(
        refusal(invoke(&rig, "worker", "ctx-status", "").await).0,
        "no_person"
    );
    attest(&rig, Some(stamp()));
    let mut binding = rig.h.facade_binding(7).unwrap();
    binding.session = "not-compacting".into();
    rig.h.bind_route(7, binding);
    assert_eq!(
        refusal(invoke(&rig, "other", "ctx-status", "").await).0,
        "async_compaction_required"
    );
}

fn save_receipt_ledger(rig: &Rig, ledger: Value) {
    let mut state = rig.state();
    state.commands = serde_json::from_value(ledger).unwrap();
    state.save(rig.h.store.get().unwrap(), &[]).unwrap();
    rig.h.checkin(state);
}

fn seed_receipts(rig: &Rig, oldest_ms: u64, interrupted: bool) -> String {
    let binding = rig.h.facade_binding(7).unwrap();
    let scope = binding.scope.as_ref().unwrap();
    let who = json!([
        scope.owner,
        scope.scope_ref,
        scope.scope_epoch,
        binding.principal.as_ref().unwrap()
    ])
    .to_string();
    let calls: serde_json::Map<String, Value> = (0..1024).map(|n| {
        let key = format!("receipt-{n:04}");
        (key, json!({
            "first": {"state":if interrupted {"accepted"} else {"done"}, "text":format!("first reply {n}"), "job":if interrupted {Some(format!("old-job-{n}"))} else {None}},
            "incarnation":"previous-process", "terminal":!interrupted, "created_at_ms":oldest_ms+n,
        }))
    }).collect();
    save_receipt_ledger(rig, json!({(who):{"calls":calls,"entries":[],"head":0}}));
    "receipt-0000".into()
}

fn saved_receipts(rig: &Rig) -> serde_json::Map<String, Value> {
    let ledger = serde_json::to_value(&rig.state().commands).unwrap();
    ledger
        .as_object()
        .unwrap()
        .values()
        .flat_map(|log| log["calls"].as_object().unwrap().clone())
        .collect()
}

#[tokio::test]
async fn old_receipts_are_evicted_before_admitting_a_new_command() {
    let dir = tempfile::tempdir().unwrap();
    let rig = ready(dir.path()).await;
    let oldest = seed_receipts(&rig, now_ms() as u64 - 25 * 60 * 60 * 1000, false);
    assert_eq!(saved_receipts(&rig).len(), 1024);
    let reply = response(invoke(&rig, "new-after-expiry", "ctx-status", "").await);
    assert_eq!(reply["state"], "done");
    let saved = saved_receipts(&rig);
    assert!(!saved.contains_key(&oldest));
    assert_eq!(saved.len(), 1);
    assert!(saved.contains_key("new-after-expiry"));
}

#[tokio::test]
async fn fresh_receipts_still_refuse_at_capacity() {
    let dir = tempfile::tempdir().unwrap();
    let rig = ready(dir.path()).await;
    seed_receipts(&rig, now_ms() as u64 - 60 * 1000, false);
    let (code, detail) = refusal(invoke(&rig, "new-at-capacity", "ctx-status", "").await);
    assert_eq!(code, "user_command_capacity");
    assert_eq!(detail["command"], "ctx-status");
    let saved = saved_receipts(&rig);
    assert_eq!(saved.len(), 1024);
    assert!(!saved.contains_key("new-at-capacity"));
}

#[tokio::test]
async fn replay_within_twenty_four_hours_returns_its_first_reply() {
    let dir = tempfile::tempdir().unwrap();
    let rig = ready(dir.path()).await;
    let first = response(invoke(&rig, "recent-replay", "ctx-status", "").await);
    let mut ledger = serde_json::to_value(&rig.state().commands).unwrap();
    for log in ledger.as_object_mut().unwrap().values_mut() {
        log["calls"]["recent-replay"]["created_at_ms"] =
            json!(now_ms() as u64 - 23 * 60 * 60 * 1000);
    }
    save_receipt_ledger(&rig, ledger);
    pending_history(&rig);
    let before = rig.newest();
    assert_eq!(
        response(invoke(&rig, "recent-replay", "ctx-flush", "").await),
        first
    );
    assert_eq!(rig.newest(), before);
    assert_eq!(saved_receipts(&rig).len(), 1);
}

#[tokio::test]
async fn interrupted_failed_receipts_expire_without_resetting_their_age() {
    let dir = tempfile::tempdir().unwrap();
    let rig = ready(dir.path()).await;
    let oldest = seed_receipts(&rig, now_ms() as u64 - 25 * 60 * 60 * 1000, true);
    let before = saved_receipts(&rig)[&oldest]["created_at_ms"].clone();
    let late = pull(&rig).await;
    assert_eq!(late["entries"][0]["result"]["state"], "failed");
    let settled = saved_receipts(&rig);
    assert!(settled.values().all(|receipt| receipt["terminal"] == true));
    assert_eq!(settled[&oldest]["created_at_ms"], before);
    assert_eq!(
        response(invoke(&rig, "new-after-interruption", "ctx-status", "").await)["state"],
        "done"
    );
    let saved = saved_receipts(&rig);
    assert!(!saved.contains_key(&oldest));
    assert_eq!(saved.len(), 1);
}

#[tokio::test]
async fn attributed_scope_bridge_preserves_metadata_and_refuses_future_constraints() {
    let dir = tempfile::tempdir().unwrap();
    let rig = ready(dir.path()).await;
    let scoped = stamp()
        .with_project_id(Some("pj-wire-bridge".into()))
        .with_workdir(Some(dir.path().to_string_lossy().into_owned()))
        .with_attributes(ScopeAttributes::new().with_on_behalf_of_agent(Some("agent-7".into())));
    let role_scope = crate::compatible_wire(&scoped).unwrap();
    assert!(user_command::admitted(Some(&role_scope)));
    assert_eq!(role_scope.project_id, scoped.project_id);
    assert_eq!(role_scope.workdir, scoped.workdir);
    assert_eq!(
        serde_json::to_value(&role_scope).unwrap(),
        serde_json::to_value(&scoped).unwrap()
    );
    attest(&rig, Some(scoped.clone()));
    assert_eq!(
        response(invoke(&rig, "attributed", "ctx-status", "").await)["state"],
        "done"
    );

    let mut project_scope = scoped.clone();
    project_scope.kind = ScopeKind::Ephemeral;
    attest(&rig, Some(project_scope));
    assert_eq!(
        refusal(invoke(&rig, "project-only", "ctx-status", "").await).0,
        "no_person"
    );

    // An added authority constraint in a later SDK must fail closed, not panic.
    let mut future = serde_json::to_value(scoped).unwrap();
    future["attributes"]["future_constraint"] = json!(true);
    let (code, detail) =
        refusal(super::super::user_commands::command_scope_admitted(Some(future)).unwrap_err());
    assert_eq!(code, "internal_error");
    assert_eq!(
        detail,
        json!({"code":"wire_record_incompatible", "record":"scope_stamp"})
    );
}

#[test]
fn scope_bridge_refuses_fields_the_older_stamp_decoder_would_drop() {
    let mut future = serde_json::to_value(
        stamp()
            .with_project_id(Some("pj-wire-bridge".into()))
            .with_workdir(Some("/throwaway-project".into())),
    )
    .unwrap();
    future["future_constraint"] = json!(true);
    let older_scope = serde_json::from_value(future.clone()).unwrap();
    assert!(user_command::admitted(Some(&older_scope)));
    let older_wire = serde_json::to_value(older_scope).unwrap();
    assert_eq!(older_wire["project_id"], "pj-wire-bridge");
    assert_eq!(older_wire["workdir"], "/throwaway-project");
    assert!(older_wire.get("future_constraint").is_none());
    let (code, detail) =
        refusal(super::super::user_commands::command_scope_admitted(Some(future)).unwrap_err());
    assert_eq!(code, "internal_error");
    assert_eq!(detail["code"], "wire_record_incompatible");
}
