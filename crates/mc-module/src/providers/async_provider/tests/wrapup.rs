use super::super::wrapup::{AsyncWrapupAdmission, AsyncWrapupTarget};
use super::*;
use crate::providers::session_runner_fake::FakeSessionRunner;

async fn fixture(dir: &Path) -> (Rig, Arc<FakeSessionRunner>) {
    let child = FakeSessionRunner::for_project(dir);
    let factory = child.factory();
    let rig = Rig::configured(
        dir,
        "broca",
        "broca",
        "s",
        "broca",
        json!({"serializer_profile":"opencode-aisdk"}),
        move |handler| {
            handler.producer_factory = factory;
            handler
                .fixed_config
                .as_mut()
                .unwrap()
                .rust_background_enabled = true;
            let mut binding = handler.facade_binding(7).unwrap();
            binding.config.rust_background_enabled = true;
            handler.bind_route(7, binding);
            handler
                .store
                .get()
                .unwrap()
                .set_route_identity_for_test(&dir.to_string_lossy(), "git:wrapup-fixture");
            handler.provider_historian_budget =
                super::super::super::historian_budget::Budget::new(1, 128);
            handler.fixed_historian_settings = Some(json!({"historian":{"broca":{
                "model":"fixture/main", "fallback_models":["fixture/backup"]
            }}}));
        },
    )
    .await;
    (rig, child)
}

impl Rig {
    /// Call the lower-level admission method to check refusal statuses directly.
    async fn wrapup_command(&self, command: &str) -> AsyncWrapupAdmission {
        assert_eq!(command, "/ctx-wrapup");
        self.h
            .request_async_wrapup(
                &self.h.facade_binding(7).unwrap(),
                &AsyncWrapupTarget {
                    reference: self.reference.clone(),
                    lineage: "L".into(),
                },
                20,
            )
            .await
            .unwrap()
    }

    /// Invoke a provider user command with a binding marked owner-authorized for a person session.
    async fn user_command(&self, key: &str, command: &str, input: &str) -> Value {
        let mut binding = self.h.facade_binding(7).unwrap();
        binding.scope = Some(
            subc_protocol::scope::ScopeStamp::new(
                subc_protocol::Principal::Reserved {
                    module_id: "prefrontal-core".into(),
                },
                "person-session",
                1,
                subc_protocol::scope::ScopeKind::Head,
            )
            .with_owner_authorized(true),
        );
        self.h.bind_route(7, binding);
        response(
            self.h
                .dispatch_value(
                    7,
                    json!({
                        "name":"user_command.invoke",
                        "call_key":key,
                        "arguments":{"command":command,"input":input}
                    }),
                )
                .await,
        )
    }

    async fn user_wrapup_command(&self, key: &str, input: &str) -> Value {
        self.user_command(key, "ctx-wrapup", input).await
    }

    async fn user_wrapup_late_results(&self) -> Value {
        response(
            self.h
                .dispatch_value(7, json!({"name":"late_results","arguments":{"since":null}}))
                .await,
        )
    }

    async fn user_wrapup_terminal(&self) -> Value {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let late = self.user_wrapup_late_results().await;
                if late["entries"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|entry| entry["kind"] == "result")
                {
                    return late;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("user wrapup command result arrived")
    }

    async fn user_command_terminal(&self, key: &str) -> Value {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let late = self.user_wrapup_late_results().await;
                if late["entries"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|entry| entry["kind"] == "result" && entry["call_key"] == key)
                {
                    return late;
                }
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .expect("user command result arrived")
    }

    fn narrative(&self, count: u64) {
        *self.runner.entries.lock().unwrap() = (0..count).map(|n| {
            ReadMessage::new(n, format!("m{n}"), json!({
                "info":{"id":format!("m{n}"),"role":"user","time":{"created":1}},
                "parts":[{"id":format!("p{n}"),"type":"text","text":format!("narrative message {n} with substantive user intent")}]
            })).with_tags(vec![tags::PartTag::tagged("0",format!("§{}§",100+n*3))])
        }).collect();
    }

    async fn historian_evaluation_done(&self) {
        tokio::time::timeout(Duration::from_secs(10), async {
            while self
                .h
                .provider_store
                .async_runtime
                .historian_inflight
                .load(std::sync::atomic::Ordering::SeqCst)
                != 0
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("initial autonomous evaluation finished");
    }

    async fn wrapup_done(&self) {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if self.h.wrapup_sessions.lock().unwrap().is_empty() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("wrapup background drive finished");
    }
}

#[tokio::test]
async fn async_wrapup_command_runs_child_and_defers_identical_bytes_until_permitted_view() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, child) = fixture(dir.path()).await;
    rig.narrative(45);
    rig.notice(1, 1_000, None).await;
    rig.historian_evaluation_done().await;
    let before = rig
        .ride("ttl_expired")
        .await
        .expect("initial permitted view");
    rig.notice(2, 1_000, Some(before.view_version)).await;
    let before_bytes = serde_json::to_vec(&rig.get(before.view_version).await).unwrap();
    let before_render = rig.render(&before);

    let accepted = tokio::time::timeout(
        Duration::from_secs(1),
        rig.user_wrapup_command("wrapup", "keep-20"),
    )
    .await
    .expect("command admission does not await the child");
    assert_eq!(accepted["state"], "accepted");
    assert!(accepted["job"].as_str().unwrap().starts_with("ctx-wrapup-"));
    let progress = rig.user_wrapup_late_results().await;
    assert_eq!(
        progress["entries"][0]["kind"], "progress",
        "the accepted command publishes progress through late results"
    );
    assert!(progress["entries"][0]["text"]
        .as_str()
        .unwrap()
        .contains("wrapup"));
    let send = tokio::time::timeout(Duration::from_secs(10), child.next_unfinished())
        .await
        .expect("summarizer child started");
    assert_eq!(send.route.module_id(), "broca");
    assert_eq!(send.route.parent_session(), "s");
    assert_eq!(send.model, "fixture/main");
    assert!(
        send.system.contains("compartment"),
        "the shared historian system prompt is used"
    );
    assert!(send.prompt.contains("narrative message 0"));
    assert!(
        !send.prompt.contains("narrative message 25"),
        "the raw tail is not sent for summarization"
    );
    assert_eq!(
        rig.wrapup_command("/ctx-wrapup").await,
        AsyncWrapupAdmission::AlreadyRunning
    );
    let output = r#"<output><compartments>
      <compartment start="0" end="10" title="first" episode_type="feature" importance="60"><p1>wrapup durable history</p1><p2>first</p2><p3>first</p3><p4 /></compartment>
      <compartment start="11" end="24" title="last" episode_type="feature" importance="60"><p1>final history</p1><p2>last</p2><p3>last</p3><p4 /></compartment>
      </compartments><facts><PROJECT_RULES>* [at_compartment=1] Keep wrapup memory durable
* Unanchored final chunk memory must be suppressed</PROJECT_RULES></facts>
      <meta><messages_processed>0-24</messages_processed><unprocessed_from>25</unprocessed_from></meta></output>"#.to_string();
    child.finish(&send.run_id, output);
    rig.wrapup_done().await;
    let late = rig.user_wrapup_terminal().await;
    let entries = late["entries"].as_array().unwrap();
    assert_eq!(
        entries
            .iter()
            .map(|entry| entry["kind"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["progress", "result"]
    );
    assert_eq!(entries[1]["result"]["state"], "done");
    let namespace = rig.state().namespace();
    let compartments = rig
        .h
        .store
        .get()
        .unwrap()
        .load_compartments(&namespace)
        .unwrap();
    assert_eq!(compartments.iter().map(|c| c.end_message).max(), Some(24));
    assert_eq!(child.fixed_connects(), 0, "never use the configured runner");
    assert!(!child.connects().is_empty());
    let memories = rig
        .h
        .store
        .get()
        .unwrap()
        .load_active_memories("git:wrapup-fixture", 0)
        .unwrap();
    assert!(
        memories
            .iter()
            .any(|memory| memory.content.contains("Keep wrapup memory durable")),
        "wrapup uses the shared memory extraction and promotion path"
    );
    assert!(
        !memories
            .iter()
            .any(|memory| memory.content.contains("Unanchored final chunk")),
        "final weak-tail extraction is filtered exactly as standalone"
    );

    rig.notice(3, 1_000, Some(before.view_version)).await;
    assert_eq!(
        rig.newest(),
        Some(before.view_version),
        "defer cannot rebuild history"
    );
    assert_eq!(
        serde_json::to_vec(&rig.get(before.view_version).await).unwrap(),
        before_bytes
    );
    assert_eq!(
        rig.render(&rig.get(before.view_version).await),
        before_render
    );

    let after = rig
        .ride("ttl_expired")
        .await
        .expect("a permitted pass materializes history");
    assert!(after.view_version > before.view_version);
    let after_bytes = rig.render(&after);
    assert!(String::from_utf8_lossy(&after_bytes).contains("wrapup durable history"));
    let before_messages: Vec<Value> = serde_json::from_slice(&before_render).unwrap();
    let after_messages: Vec<Value> = serde_json::from_slice(&after_bytes).unwrap();
    assert_eq!(
        &after_messages[after_messages.len() - 20..],
        &before_messages[before_messages.len() - 20..],
        "the newest twenty messages remain byte-equivalent raw messages"
    );
    assert_eq!(
        after_messages[after_messages.len() - 20]["info"]["id"],
        "m25"
    );
    assert_eq!(child.sends().len(), 1);

    rig.queue(&[103]).await;
    let flush = rig.user_command("flush-broca", "ctx-flush", "").await;
    assert_eq!(flush["state"], "accepted");
    let flush_late = rig.user_command_terminal("flush-broca").await;
    let flush_entries = flush_late["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["call_key"] == "flush-broca")
        .collect::<Vec<_>>();
    assert_eq!(
        flush_entries
            .iter()
            .map(|entry| entry["kind"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["progress", "result"]
    );
    assert_eq!(flush_entries[1]["result"]["state"], "done");
    assert!(flush_entries[1]["result"]["text"]
        .as_str()
        .unwrap()
        .contains("Flushed queued drops"));
    assert!(rig.pending_targets().is_empty());
}

#[tokio::test]
async fn async_wrapup_refuses_unknown_conversation_and_retired_lineage() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, child) = fixture(dir.path()).await;
    let binding = rig.h.facade_binding(7).unwrap();
    for target in [
        AsyncWrapupTarget {
            reference: "unknown".into(),
            lineage: "L".into(),
        },
        AsyncWrapupTarget {
            reference: rig.reference.clone(),
            lineage: "retired".into(),
        },
    ] {
        assert_eq!(
            rig.h
                .request_async_wrapup(&binding, &target, 20)
                .await
                .unwrap(),
            AsyncWrapupAdmission::UnknownConversation
        );
    }
    assert!(child.sends().is_empty());
    assert!(rig.h.wrapup_sessions.lock().unwrap().is_empty());
}

#[tokio::test]
async fn async_wrapup_refuses_another_runner() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, child) = fixture(dir.path()).await;
    let mut binding = rig.h.facade_binding(7).unwrap();
    binding.principal = Some(subc_protocol::Principal::Reserved {
        module_id: "another-runner".into(),
    });
    let result = rig
        .h
        .request_async_wrapup(
            &binding,
            &AsyncWrapupTarget {
                reference: rig.reference.clone(),
                lineage: "L".into(),
            },
            20,
        )
        .await;
    let error = result.expect_err("another runner must not drive the owner's conversation");
    assert!(format!("{error:?}").contains("owned by another runner"));
    assert!(child.sends().is_empty());
    assert!(rig.h.wrapup_sessions.lock().unwrap().is_empty());
}

/// The conversation is the attested runner's, keyed without the folder
/// (compaction-provider contract §1): its owner reaches it through any
/// spelling of the project folder. Another runner stays refused (above).
#[tokio::test]
async fn async_wrapup_admits_the_owner_runner_from_another_folder_spelling() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, _child) = fixture(dir.path()).await;
    let mut binding = rig.h.facade_binding(7).unwrap();
    binding.project_root = dir.path().join("other");
    assert_eq!(
        rig.h
            .request_async_wrapup(
                &binding,
                &AsyncWrapupTarget {
                    reference: rig.reference.clone(),
                    lineage: "L".into()
                },
                20
            )
            .await
            .unwrap(),
        AsyncWrapupAdmission::Accepted
    );
}

#[tokio::test]
async fn async_wrapup_refuses_ceiling_and_releases_admission_for_retry() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, child) = fixture(dir.path()).await;
    let held = rig.h.provider_historian_budget.acquire(0).await;
    assert_eq!(
        rig.wrapup_command("/ctx-wrapup").await,
        AsyncWrapupAdmission::Ceiling
    );
    assert!(rig.h.wrapup_sessions.lock().unwrap().is_empty());
    assert!(child.sends().is_empty());
    drop(held);
    assert_eq!(
        rig.wrapup_command("/ctx-wrapup").await,
        AsyncWrapupAdmission::Accepted
    );
    rig.wrapup_done().await;
    assert_eq!(rig.h.provider_historian_budget.stats()["active"], 0);
}

#[tokio::test]
async fn async_wrapup_drains_partial_chunks_without_moving_the_raw_tail() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, child) = fixture(dir.path()).await;
    rig.narrative(45);
    rig.notice(1, 1_000, None).await;
    rig.historian_evaluation_done().await;
    assert_eq!(
        rig.wrapup_command("/ctx-wrapup").await,
        AsyncWrapupAdmission::Accepted
    );
    let first = tokio::time::timeout(Duration::from_secs(10), child.next_unfinished())
        .await
        .unwrap();
    let output = r#"<output><compartments>
      <compartment start="0" end="5" title="first" episode_type="feature" importance="60"><p1>first history</p1><p2>first</p2><p3>first</p3><p4 /></compartment>
      <compartment start="6" end="10" title="second" episode_type="feature" importance="60"><p1>second history</p1><p2>second</p2><p3>second</p3><p4 /></compartment>
      </compartments><meta><messages_processed>0-10</messages_processed><unprocessed_from>11</unprocessed_from></meta></output>"#;
    child.finish(&first.run_id, output.into());
    let second = tokio::time::timeout(Duration::from_secs(10), child.next_unfinished())
        .await
        .unwrap();
    assert_ne!(first.run_id, second.run_id);
    assert!(!second.prompt.contains("narrative message 25"));
    child.finish(
        &second.run_id,
        crate::tests::historian_output_for_prompt(&second.prompt),
    );
    rig.wrapup_done().await;
    let compartments = rig
        .h
        .store
        .get()
        .unwrap()
        .load_compartments(&rig.state().namespace())
        .unwrap();
    assert_eq!(child.sends().len(), 2);
    assert_eq!(compartments.iter().map(|c| c.end_message).max(), Some(24));
}

#[tokio::test]
async fn async_wrapup_validates_output_and_tries_the_configured_fallback() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, child) = fixture(dir.path()).await;
    rig.narrative(45);
    rig.notice(1, 1_000, None).await;
    rig.historian_evaluation_done().await;
    assert_eq!(
        rig.wrapup_command("/ctx-wrapup").await,
        AsyncWrapupAdmission::Accepted
    );
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            tokio::select! {
                send = child.next_unfinished() => child.finish(&send.run_id, "invalid historian output".into()),
                _ = rig.wrapup_done() => break,
            }
        }
    }).await.expect("invalid outputs terminate the model chain");
    let models: Vec<_> = child
        .sends()
        .iter()
        .map(|send| send.model.clone())
        .collect();
    assert_eq!(models, ["fixture/main", "fixture/backup"]);
    assert!(rig
        .h
        .store
        .get()
        .unwrap()
        .load_compartments(&rig.state().namespace())
        .unwrap()
        .is_empty());
    assert_eq!(rig.newest(), None, "invalid summaries cannot become a view");
}

#[tokio::test]
async fn async_wrapup_does_not_bless_conflicting_source_identities() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, child) = fixture(dir.path()).await;
    rig.narrative(45);
    rig.notice(1, 1_000, None).await;
    rig.historian_evaluation_done().await;
    let namespace = rig.state().namespace();
    let store = rig.h.store.get().unwrap();
    let mut loaded = store.load(&namespace).unwrap();
    loaded
        .meta
        .block_identity_by_mid
        .insert("m0".into(), Vec::new());
    store
        .commit(&namespace, loaded.row_version, &loaded.core, &loaded.meta)
        .unwrap();
    assert_eq!(
        rig.wrapup_command("/ctx-wrapup").await,
        AsyncWrapupAdmission::Accepted
    );
    tokio::time::timeout(Duration::from_secs(10), async {
        tokio::select! {
            send = child.next_unfinished() => {
                child.finish(&send.run_id, crate::tests::historian_output_for_prompt(&send.prompt));
                rig.wrapup_done().await;
            }
            _ = rig.wrapup_done() => {}
        }
    })
    .await
    .expect("conflicting sources terminate without overwriting their identity");
    assert!(
        child.sends().is_empty(),
        "a conflicting source is refused before model work"
    );
    assert!(store.load(&namespace).unwrap().meta.block_identity_by_mid["m0"].is_empty());
    assert!(store.load_compartments(&namespace).unwrap().is_empty());
}

#[tokio::test]
async fn async_wrapup_refuses_an_already_running_historian() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, child) = fixture(dir.path()).await;
    let LiveHistorianSessionClaim::Acquired(held) = rig
        .h
        .try_claim_live_historian_session(&rig.state().namespace())
    else {
        panic!("a new conversation has no active historian");
    };
    assert_eq!(
        rig.wrapup_command("/ctx-wrapup").await,
        AsyncWrapupAdmission::AlreadyRunning
    );
    assert!(child.sends().is_empty());
    assert!(rig.h.wrapup_sessions.lock().unwrap().is_empty());
    assert_eq!(rig.h.provider_historian_budget.stats()["active"], 0);
    drop(held);
}

/// A person's `/ctx-wrapup` must not fail because another call on the same
/// conversation happens to hold the conversation lock when the summary is
/// published. Here a held lock stands in for a `late_results` poll or an
/// advance notice that is still running: both take that lock, and a host polls
/// `late_results` while it shows the wrapup's progress. The publication fence
/// waits for the lock instead of refusing, because neither the lineage nor the
/// generation changed.
#[tokio::test]
async fn stack26_wrapup_publication_survives_a_concurrent_conversation_call() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, child) = fixture(dir.path()).await;
    rig.narrative(45);
    rig.notice(1, 1_000, None).await;
    rig.historian_evaluation_done().await;
    let before = rig
        .ride("ttl_expired")
        .await
        .expect("initial permitted view");
    rig.notice(2, 1_000, Some(before.view_version)).await;
    let accepted = rig.user_wrapup_command("wrapup", "keep-20").await;
    assert_eq!(accepted["state"], "accepted");
    let send = tokio::time::timeout(Duration::from_secs(10), child.next_unfinished())
        .await
        .expect("summarizer child started");
    let generation = rig.state().generation;
    // Another call on this conversation holds its lock while the summary lands.
    let held = rig.h.provider_serial.lock_for(&rig.state().key).await;
    child.finish(
        &send.run_id,
        r#"<output><compartments>
      <compartment start="0" end="24" title="history" episode_type="feature" importance="60"><p1>wrapup durable history</p1><p2>history</p2><p3>history</p3><p4 /></compartment>
      </compartments><meta><messages_processed>0-24</messages_processed><unprocessed_from>25</unprocessed_from></meta></output>"#
            .to_string(),
    );
    // Give the drive time to reach the publication fence, then release the lock.
    let _ = tokio::time::timeout(Duration::from_secs(3), async {
        while !rig.h.wrapup_sessions.lock().unwrap().is_empty() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    drop(held);
    let late = rig.user_wrapup_terminal().await;
    let result = late["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["kind"] == "result")
        .unwrap()
        .clone();
    assert_eq!(
        rig.state().generation,
        generation,
        "the lineage did not change"
    );
    assert_eq!(
        result["result"]["state"], "done",
        "a briefly held conversation lock failed the wrapup: {}",
        result["result"]["text"]
    );
}

/// The same fixture for an OpenCode session served by ck-mc's async lane (no
/// standalone plugin involved): admitted under the OpenCode session runner and
/// set up with harness `opencode`, the harness whose setup checks for standalone
/// plugin state.
async fn opencode_fixture(dir: &Path) -> (Rig, Arc<FakeSessionRunner>) {
    opencode_fixture_with(dir, |_| {}).await
}

async fn opencode_fixture_with(
    dir: &Path,
    configure: impl FnOnce(&mut McHandler),
) -> (Rig, Arc<FakeSessionRunner>) {
    let child = FakeSessionRunner::for_project(dir);
    let factory = child.factory();
    let rig = Rig::configured(
        dir,
        "thalamus-harness",
        "runner",
        "s",
        "opencode",
        json!({"serializer_profile":"opencode-aisdk"}),
        move |handler| {
            handler.producer_factory = factory;
            handler
                .fixed_config
                .as_mut()
                .unwrap()
                .rust_background_enabled = true;
            let mut binding = handler.facade_binding(7).unwrap();
            binding.config.rust_background_enabled = true;
            handler.bind_route(7, binding);
            handler
                .store
                .get()
                .unwrap()
                .set_route_identity_for_test(&dir.to_string_lossy(), "git:wrapup-fixture");
            handler.provider_historian_budget =
                super::super::super::historian_budget::Budget::new(1, 128);
            handler.fixed_historian_settings = Some(json!({"historian":{"opencode":{
                "model":"fixture/main", "fallback_models":["fixture/backup"]
            }}}));
            configure(handler);
        },
    )
    .await;
    (rig, child)
}

async fn held_autonomous_historian(
    dir: &Path,
    conflicting_mid: Option<&str>,
) -> (
    Rig,
    Arc<FakeSessionRunner>,
    crate::providers::session_runner_fake::FakeSend,
) {
    let (rig, child) = opencode_fixture(dir).await;
    rig.narrative(2);
    rig.notice(1, 1_000, None).await;
    rig.historian_evaluation_done().await;
    rig.narrative(45);
    {
        let mut entries = rig.runner.entries.lock().unwrap();
        for entry in entries.iter_mut().skip(2) {
            entry.message["parts"][0]["text"] = json!(format!(
                "narrative message {} with substantive user intent {}",
                entry.ordinal,
                "durable history details ".repeat(500)
            ));
        }
        let mid = "m2_thalamus_v1_s";
        entries[2].mid = mid.into();
        entries[2].message["info"]["id"] = json!(mid);
    }
    if let Some(mid) = conflicting_mid {
        let store = rig.h.store.get().unwrap();
        let namespace = rig.state().namespace();
        let mut loaded = store.load(&namespace).unwrap();
        loaded
            .meta
            .block_identity_by_mid
            .insert(mid.into(), Vec::new());
        store
            .commit(&namespace, loaded.row_version, &loaded.core, &loaded.meta)
            .unwrap();
    }
    rig.notice(2, 50_000, None).await;
    let send = tokio::time::timeout(Duration::from_secs(10), child.next_unfinished())
        .await
        .expect("autonomous summarizer child started");
    (rig, child, send)
}

#[tokio::test]
async fn autonomous_historian_publishes_unchanged_messages_before_the_first_view() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, child, send) = held_autonomous_historian(dir.path(), None).await;
    assert_eq!(rig.newest(), None, "no view has recorded source identities");
    let before = rig.state();
    let namespace = before.namespace();
    let store = rig.h.store.get().unwrap();
    let identities_before = store.load(&namespace).unwrap().meta.block_identity_by_mid;
    assert_eq!(before.entries.len(), 45);

    // No further notice-triggered publication or parent write may populate
    // identities while the child is held: publication must work from the
    // already ingested messages.
    child.finish(
        &send.run_id,
        crate::tests::historian_output_for_prompt(&send.prompt),
    );
    rig.historian_evaluation_done().await;
    let after = rig.state();
    assert_eq!(
        before
            .entries
            .iter()
            .map(|(n, entry)| (n, entry.raw()))
            .collect::<Vec<_>>(),
        after
            .entries
            .iter()
            .map(|(n, entry)| (n, entry.raw()))
            .collect::<Vec<_>>()
    );
    assert!(
        !store.load_compartments(&namespace).unwrap().is_empty(),
        "unchanged held messages must pass the publication fence before the first view ({} identity rows before release)",
        identities_before.len()
    );
}

#[tokio::test]
async fn autonomous_historian_preserves_a_conflicting_selected_identity_for_the_fence() {
    let dir = tempfile::tempdir().unwrap();
    let mid = "m2_thalamus_v1_s";
    let (rig, child, send) = held_autonomous_historian(dir.path(), Some(mid)).await;
    let namespace = rig.state().namespace();
    let store = rig.h.store.get().unwrap();
    let held = store.load(&namespace).unwrap();
    assert!(held.meta.block_identity_by_mid[mid].is_empty());
    assert!(held
        .meta
        .historian
        .selected_range_identities
        .iter()
        .any(|selected| selected.mid == mid));
    child.finish(
        &send.run_id,
        crate::tests::historian_output_for_prompt(&send.prompt),
    );
    rig.historian_evaluation_done().await;
    assert!(store.load_compartments(&namespace).unwrap().is_empty());
    let failure = store
        .load_meta(&namespace)
        .unwrap()
        .meta
        .historian
        .last_failure
        .unwrap();
    assert_eq!(
        failure,
        format!("publish rejected: selected historian message {mid} changed after firing")
    );
}

#[tokio::test]
async fn autonomous_historian_publishes_a_refit_expanded_range_with_missing_identities() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, child) = opencode_fixture_with(dir.path(), |handler| {
        let config = handler.fixed_config.as_mut().unwrap();
        config.historian_context_limit_tokens = 1_000_000;
        config.historian_context_limit_known = true;
    })
    .await;
    rig.narrative(400);
    for entry in rig.runner.entries.lock().unwrap().iter_mut() {
        entry.message["info"]["role"] = json!(if entry.ordinal % 2 == 0 {
            "user"
        } else {
            "assistant"
        });
        entry.message["parts"][0]["text"] = json!(format!(
            "narrative message {} {}",
            entry.ordinal,
            "durable history details ".repeat(500)
        ));
    }
    let store = rig.h.store.get().unwrap();
    let mut state = rig.state();
    let namespace = state.namespace();
    let serial = rig.h.provider_serial.lock_for(&state.key).await;
    rig.h
        .read_async(&mut state, 0, Duration::from_secs(10))
        .await
        .unwrap();
    state.resync = false;
    state
        .ingest_read(store, codec::Codec::OpencodeAiSdk)
        .unwrap();
    let loaded = store.load(&namespace).unwrap();
    assert!(loaded.meta.block_identity_by_mid.is_empty());
    if loaded.row_version.is_none() {
        store
            .commit(&namespace, None, &loaded.core, &loaded.meta)
            .unwrap();
    }
    let fence = Arc::new(AsyncHistoryFence {
        reference: rig.reference.clone(),
        generation: state.generation,
        key: state.key.clone(),
        serial: Arc::clone(&rig.h.provider_serial),
    });
    let mut parsed = rig.h.async_historian_request(&state).unwrap();
    parsed.usage = Some(mc_store::ModuleUsage {
        current_total_input_tokens: 500_000,
        context_limit_tokens: 1_000_000,
        ..Default::default()
    });
    parsed.historian_model_chain = Some(vec!["opencode/small".into(), "fixture/main".into()]);
    let config = rig.h.fixed_config.as_ref().unwrap();
    let fixed_prompt = crate::historian_prompt::build_compartment_agent_prompt(
        &crate::historian_prompt::CompartmentPromptInputs {
            seed_examples: "",
            session_references: "",
            project_memory: "",
            input_source: "Messages 0-399:\n\n",
            memory_enabled: config.memory_enabled,
            user_observations_requested: config.user_observations_requested,
            extraction_free: false,
        },
    );
    // Leave room for fixed instructions and a small source chunk. A window too
    // small for the instructions uses oversize admission instead of shrinking.
    let small_mass =
        crate::decision_calibration::DecisionCalibration::for_model(Some("opencode/small"))
            .provider_mass(
                crate::decision_calibration::LocalMass {
                    system: mc_tokenizer::estimate_tokens(
                        crate::historian_prompt::HISTORIAN_SYSTEM_PROMPT,
                    ) as f64,
                    prose: (mc_tokenizer::estimate_tokens(&fixed_prompt) + 5_000) as f64,
                    tools: 0.0,
                },
                true,
            );
    let small_input = (small_mass / 0.97).ceil() as usize + 1;
    parsed.historian_model_limits = serde_json::from_value(json!({
        "opencode/small":{"context":small_input + 8_000,"input":small_input,"output":8_000},
        "fixture/main":{"context":1_000_000,"output":32_000}
    }))
    .unwrap();
    let projection = fence
        .prepare_input(
            store,
            historian_tail::InputWindow::default().through(Some(399)),
            codec::Codec::OpencodeAiSdk,
            &mut parsed,
            &state.reminder_echoes,
            None,
        )
        .unwrap();
    let mut timings = HistorianTriggerTimings::default();
    let prepared = rig.h.prepare_historian_fire(
        Arc::clone(store),
        &parsed,
        &rig.h.async_binding(&state),
        &dir.path().to_string_lossy(),
        &projection,
        HistorianPrepareContext {
            rust_background_enabled: Some(true),
            now: now_ms(),
            publication_fence: Some(fence),
            tag_snapshot: None,
            async_coverage: Some(None),
            reclaim_ride_available: false,
            runner_lane: true,
            timings: &mut timings,
        },
    );
    let PreparedHistorianAction::FireReady(prepared) = prepared else {
        panic!("expected initial firing")
    };
    assert_eq!(prepared.task.firing.model_chain[0], "opencode/small");
    assert_eq!(
        prepared.task.firing.model_limits["opencode/small"].input,
        Some(small_input)
    );
    let initial = prepared.task.firing.selected_range_identities.clone();
    drop(serial);
    let firing = tokio::spawn(McHandler::execute_historian_firing_task(
        Arc::clone(&rig.h.producer_factory),
        prepared.task,
    ));
    let send = tokio::time::timeout(Duration::from_secs(10), child.next_unfinished())
        .await
        .unwrap();
    assert_eq!(send.model, "fixture/main");
    let refitted = store
        .load_meta(&namespace)
        .unwrap()
        .meta
        .historian
        .selected_range_identities;
    assert!(
        refitted.len() > initial.len(),
        "runtime Zen removal must expand the selected range: {} vs {}",
        refitted.len(),
        initial.len()
    );
    assert!(refitted
        .iter()
        .any(|selected| !initial.iter().any(|old| old.mid == selected.mid)));
    child.finish(
        &send.run_id,
        crate::tests::historian_output_for_prompt(&send.prompt),
    );
    firing.await.unwrap().unwrap();
    assert!(!store.load_compartments(&namespace).unwrap().is_empty());
}

/// Rows `crate::offline_move::has_standalone_state` would count for session `s`.
fn raw_session_rows(rig: &Rig) -> Vec<(String, i64)> {
    rig.h
        .store
        .get()
        .unwrap()
        .with_context_read(|conn| {
            ["session_meta", "tags", "compartments", "pending_ops"]
                .iter()
                .map(|table| {
                    conn.query_row(
                        &format!("SELECT COUNT(*) FROM {table} WHERE session_id='s'"),
                        [],
                        |row| row.get(0),
                    )
                    .map(|count| ((*table).to_owned(), count))
                })
                .collect()
        })
        .unwrap()
}

/// A fresh OpenCode session served by ck-mc's async lane goes through setup,
/// notices, a real historian publish, `ctx_reduce`, a module restart and setup
/// again, and never writes the rows keyed by the raw session id that
/// `has_standalone_state` counts as standalone plugin state.
#[tokio::test]
async fn a_fresh_mode3_opencode_session_is_never_refused_as_standalone_state() {
    let dir = tempfile::tempdir().unwrap();
    let (mut rig, child) = opencode_fixture(dir.path()).await;
    rig.narrative(45);
    rig.notice(1, 1_000, None).await;
    rig.historian_evaluation_done().await;
    let accepted = rig.user_wrapup_command("wrapup", "keep-20").await;
    assert_eq!(accepted["state"], "accepted", "{accepted}");
    let send = tokio::time::timeout(Duration::from_secs(10), child.next_unfinished())
        .await
        .expect("summarizer child started");
    let output = r#"<output><compartments>
      <compartment start="0" end="10" title="first" episode_type="feature" importance="60"><p1>first history</p1><p2>first</p2><p3>first</p3><p4 /></compartment>
      <compartment start="11" end="24" title="last" episode_type="feature" importance="60"><p1>final history</p1><p2>last</p2><p3>last</p3><p4 /></compartment>
      </compartments><facts></facts>
      <meta><messages_processed>0-24</messages_processed><unprocessed_from>25</unprocessed_from></meta></output>"#.to_string();
    child.finish(&send.run_id, output);
    rig.wrapup_done().await;
    let namespace = rig.state().namespace();
    let store = rig.h.store.get().unwrap();
    assert!(
        !store.load_compartments(&namespace).unwrap().is_empty(),
        "the historian published under the async namespace"
    );
    let reduced = rig.tool(7, "ctx_reduce", json!({"drop":"190"})).await;
    assert_ne!(reduced["isError"], true, "{reduced}");
    rig.notice(2, 1_000, None).await;
    let fence = |rig: &Rig| {
        rig.h
            .store
            .get()
            .unwrap()
            .with_context_read(|conn| crate::offline_move::has_standalone_state(conn, "s"))
            .unwrap()
    };
    assert!(!fence(&rig), "{:?}", raw_session_rows(&rig));
    assert!(raw_session_rows(&rig).iter().all(|(_, count)| *count == 0));

    // A restart, then setup again from the restarted module.
    rig.task.abort();
    let _ = (&mut rig.task).await;
    drop(rig);
    let (restarted, _) = opencode_fixture(dir.path()).await;
    let again = restarted
        .op("compaction.setup", {
            let mut request = setup_request("s", "again");
            request["params"] = json!({"serializer_profile":"opencode-aisdk"});
            request
        })
        .await;
    assert_eq!(again["answer"], "ready", "{again}");
    // The runner outlives the module restart and still serves the session.
    restarted.narrative(45);
    restarted.notice(3, 1_000, None).await;
    assert!(!fence(&restarted), "{:?}", raw_session_rows(&restarted));
}

/// Waiting for the conversation lock must not weaken the fence: when the
/// conversation is reset while the summary waits, its generation changes and
/// the publication is refused with a reason naming that change.
#[tokio::test]
async fn wrapup_publication_waiting_for_the_lock_still_refuses_a_changed_generation() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, child) = fixture(dir.path()).await;
    rig.narrative(45);
    rig.notice(1, 1_000, None).await;
    rig.historian_evaluation_done().await;
    let before = rig
        .ride("ttl_expired")
        .await
        .expect("initial permitted view");
    rig.notice(2, 1_000, Some(before.view_version)).await;
    let accepted = rig.user_wrapup_command("wrapup", "keep-20").await;
    assert_eq!(accepted["state"], "accepted");
    let send = tokio::time::timeout(Duration::from_secs(10), child.next_unfinished())
        .await
        .expect("summarizer child started");
    let generation = rig.state().generation;
    let held = rig.h.provider_serial.lock_for(&rig.state().key).await;
    // Reset the conversation while holding the lock, as happens in production
    // when the runner reports that it lost its state.
    let store = rig.h.store.get().unwrap();
    let mut state = rig.h.checkout(store, &rig.reference).unwrap().unwrap();
    state.reset(store).unwrap();
    rig.h.checkin(state);
    child.finish(
        &send.run_id,
        r#"<output><compartments>
      <compartment start="0" end="24" title="history" episode_type="feature" importance="60"><p1>wrapup durable history</p1><p2>history</p2><p3>history</p3><p4 /></compartment>
      </compartments><meta><messages_processed>0-24</messages_processed><unprocessed_from>25</unprocessed_from></meta></output>"#
            .to_string(),
    );
    // Keep the lock held for a while after the summary lands: the wrapup must
    // still be running then, waiting for the lock instead of having given up.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        !rig.h.wrapup_sessions.lock().unwrap().is_empty(),
        "the publication waits for the held lock"
    );
    drop(held);
    let late = rig.user_wrapup_terminal().await;
    let result = late["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["kind"] == "result")
        .unwrap()
        .clone();
    assert_ne!(
        rig.state().generation,
        generation,
        "the reset moved the lineage"
    );
    assert_ne!(result["result"]["state"], "done");
    let text = result["result"]["text"].as_str().unwrap();
    assert!(
        text.contains(&format!(
            "lineage changed (generation {generation} to {})",
            generation + 1
        )),
        "the refusal names the changed generation: {text}"
    );
    assert!(
        rig.h
            .store
            .get()
            .unwrap()
            .load_compartments(&rig.state().namespace())
            .unwrap()
            .is_empty(),
        "nothing was published under the old lineage"
    );
}
