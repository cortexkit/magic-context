//! The watch on Entorhinal's change markers: each new `registry` value reads
//! every set-up session's workspace again and wakes a legacy project round;
//! a bus that is down or a watch that ends changes nothing until the watch
//! comes back, and then catches up.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cortexkit_bus_trait::Register;
use cortexkit_role_compaction::read::{Head, ReadPage, ReadRequest, SessionRef};
use cortexkit_role_compaction::rules::{EditCost, ProviderRules, SignedParts};
use cortexkit_role_compaction::setup::{ModelRef, SetupRequest};
use cortexkit_role_compaction::view::{AppliedViewAnswer, ApplyViewAnswer, ApplyViewRequest};
use cortexkit_role_llm_runner::run::{RunResult, RunResultRequest};
use cortexkit_role_llm_runner::send::{SendReply, SendRequest};

use super::*;
use crate::bus::tests::TestBus;
use crate::client::{Child, ClientError, EntorhinalRefusal, RunnerClient};
use crate::module::Module;
use crate::pass::Settings;
use crate::route::{Project, Route};
use crate::routing::Router;

/// A runner whose transcript is empty and which takes every view. Entorhinal
/// answers nothing, and each request to it is counted by method, in a count
/// the client's clones share.
#[derive(Clone, Default)]
pub(crate) struct Client {
    asked: Arc<Mutex<BTreeMap<String, usize>>>,
}

impl Client {
    /// How often Entorhinal was asked `method`.
    pub(crate) fn asked(&self, method: &str) -> usize {
        self.asked
            .lock()
            .unwrap()
            .get(method)
            .copied()
            .unwrap_or_default()
    }
}

impl RunnerClient for Client {
    async fn read(&self, _: &SessionRef, _: ReadRequest) -> Result<ReadPage, ClientError> {
        Ok(ReadPage::new(vec![], Head::new()))
    }

    async fn apply_view(
        &self,
        _: &SessionRef,
        _: ApplyViewRequest,
    ) -> Result<ApplyViewAnswer, ClientError> {
        Ok(ApplyViewAnswer::Accepted)
    }

    async fn applied_view(&self, _: &SessionRef) -> Result<AppliedViewAnswer, ClientError> {
        Ok(AppliedViewAnswer::default())
    }

    async fn send(&self, _: &SessionRef, _: SendRequest) -> Result<SendReply, ClientError> {
        Err(ClientError::new("no reminders here"))
    }

    async fn send_child(&self, _: &Child, _: SendRequest) -> Result<SendReply, ClientError> {
        Err(ClientError::new("no summarizer here"))
    }

    async fn child_result(&self, _: &Child, _: RunResultRequest) -> Result<RunResult, ClientError> {
        Err(ClientError::new("no summarizer here"))
    }

    async fn entorhinal_call(
        &self,
        _: &SessionRef,
        body: Vec<u8>,
    ) -> Option<Result<Vec<u8>, EntorhinalRefusal>> {
        let request: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let method = request["method"].as_str().unwrap_or_default().to_owned();
        *self.asked.lock().unwrap().entry(method).or_default() += 1;
        None
    }
}

impl Router for Client {
    async fn select(
        &self,
        _: cortexkit_role_routing::select::SelectRequest,
    ) -> Result<cortexkit_role_routing::select::SelectAnswer, crate::routing::RouteError> {
        unreachable!("a worker preset runs no summarizer")
    }

    async fn report(&self, _: cortexkit_role_routing::report::ReportRequest) {}
}

/// Set up `session` of `project` in `folder`, as a worker.
fn setup(module: &Module<Client>, session: &str, project: &str, folder: &str) {
    let route = Route {
        session: SessionRef::new("runner", "mock", session),
        project: Some(Project {
            id: project.to_owned(),
            root: folder.to_owned(),
        }),
        workdir: Some(folder.to_owned()),
        agent_id: None,
    };
    let request = SetupRequest::new(
        "worker",
        ModelRef::new("test", "model"),
        100_000,
        1000,
        ProviderRules::new(SignedParts::None, EditCost::Suffix),
        vec![],
        1,
    );
    module.setup(route, request).unwrap();
}

/// Wait until Entorhinal was asked `method` `count` times.
async fn asked(client: &Client, method: &str, count: usize) {
    for _ in 0..500 {
        if client.asked(method) >= count {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!(
        "Entorhinal was asked {method} {} times, not {count}",
        client.asked(method)
    );
}

fn marker(generation: u64) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({"generation": generation, "incarnation": "inc-1"}))
        .unwrap()
}

#[tokio::test]
async fn a_registry_change_reads_each_folder_again_and_wakes_a_legacy_round() {
    let client = Client::default();
    let module = Module::new(client.clone(), Settings::default(), None, None);
    setup(&module, "s1", "pj-a", "/work/a");
    setup(&module, "s2", "pj-a", "/work/a");
    setup(&module, "s3", "pj-b", "/work/b");
    // Each Setup read the session's memory context, workspace included.
    asked(&client, "context.project", 3).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let before = client.asked("context.project");
    // Swallow the wake the Setups' new project ids left.
    while module.legacy_wake().woken(Duration::from_millis(50)).await {}

    let test_bus = TestBus::new();
    test_bus.kv.put(KEY, marker(7)).await.unwrap();
    let _watch = module.spawn_entorhinal_follow(test_bus.bus());
    // One read per folder, not per session, and one legacy round.
    asked(&client, "context.project", before + 2).await;
    assert!(
        module.legacy_wake().woken(Duration::from_secs(1)).await,
        "a registry change wakes a legacy project round"
    );
    assert!(module.entorhinal_watch_up());
    assert_eq!(
        *test_bus.watched.lock().unwrap(),
        ["CK_BOX_TEST_ENTORHINAL_CHANGES"]
    );
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(client.asked("context.project"), before + 2);

    // A new value reads again; the same value put again doesn't.
    test_bus.kv.put(KEY, marker(8)).await.unwrap();
    asked(&client, "context.project", before + 4).await;
    test_bus.kv.put(KEY, marker(8)).await.unwrap();
    test_bus.kv.put("other", marker(9)).await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(client.asked("context.project"), before + 4);
}

/// Count the changes the marker watch reports, with the watch's state.
fn follow(test_bus: &Arc<TestBus>) -> (MarkerTask, Arc<AtomicUsize>, Arc<WatchState>) {
    let changes = Arc::new(AtomicUsize::new(0));
    let state = Arc::new(WatchState::default());
    let bus = test_bus.bus();
    let watch = spawn_marker(bus, Arc::clone(&state), KEY, {
        let changes = Arc::clone(&changes);
        move || {
            changes.fetch_add(1, Ordering::SeqCst);
        }
    });
    (watch, changes, state)
}

#[tokio::test(start_paused = true)]
async fn without_the_bus_nothing_is_read_again_until_the_watch_comes_back_and_catches_up() {
    let test_bus = TestBus::new();
    test_bus.kv.put(KEY, marker(1)).await.unwrap();
    test_bus
        .down
        .store(true, std::sync::atomic::Ordering::Relaxed);
    let (_watch, changes, state) = follow(&test_bus);
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert!(!state.is_up());
    assert_eq!(changes.load(Ordering::SeqCst), 0, "no watch, no reads");
    // Tried again after 5 s, then 10 s, ...
    tokio::time::sleep(Duration::from_secs(30)).await;
    assert!(!state.is_up());
    assert_eq!(changes.load(Ordering::SeqCst), 0);

    test_bus
        .down
        .store(false, std::sync::atomic::Ordering::Relaxed);
    // The next try is at most 20 s away.
    tokio::time::sleep(Duration::from_secs(21)).await;
    assert!(state.is_up());
    assert_eq!(
        changes.load(Ordering::SeqCst),
        1,
        "the value it starts with counts as a change"
    );

    // The watch ends; a change while it is down is caught when it comes
    // back, 5 s later, since a watch that came up starts its pauses over.
    test_bus
        .down
        .store(true, std::sync::atomic::Ordering::Relaxed);
    test_bus.cut_watches();
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert!(!state.is_up());
    test_bus.kv.put(KEY, marker(2)).await.unwrap();
    test_bus
        .down
        .store(false, std::sync::atomic::Ordering::Relaxed);
    tokio::time::sleep(Duration::from_secs(5)).await;
    assert!(state.is_up());
    assert_eq!(changes.load(Ordering::SeqCst), 2);
    // A watch that comes back to the value it last saw reads nothing again.
    test_bus.cut_watches();
    tokio::time::sleep(Duration::from_secs(6)).await;
    assert!(state.is_up());
    assert_eq!(changes.load(Ordering::SeqCst), 2);
}

#[tokio::test(start_paused = true)]
async fn bucket_reset_reopens_the_watch_and_reads_the_new_snapshot() {
    let test_bus = TestBus::new();
    test_bus.kv.put(KEY, marker(1)).await.unwrap();
    let (_watch, changes, state) = follow(&test_bus);
    tokio::time::sleep(Duration::from_millis(1)).await;
    assert!(state.is_up());
    assert_eq!(changes.load(Ordering::SeqCst), 1);

    test_bus.reset_watches();
    tokio::time::sleep(Duration::from_millis(1)).await;
    assert!(!state.is_up());
    test_bus.kv.put(KEY, marker(2)).await.unwrap();
    tokio::time::sleep(RETRY_FIRST - Duration::from_millis(100)).await;
    assert_eq!(test_bus.watched.lock().unwrap().len(), 1);
    assert_eq!(changes.load(Ordering::SeqCst), 1);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(test_bus.watched.lock().unwrap().len(), 2);
    assert!(state.is_up());
    assert_eq!(changes.load(Ordering::SeqCst), 2);
}

#[tokio::test(start_paused = true)]
async fn a_panicked_marker_watch_reopens_after_backoff() {
    let test_bus = TestBus::new();
    let module = Module::new(Client::default(), Settings::default(), None, None);
    let _watch = module.spawn_entorhinal_follow(test_bus.bus());
    tokio::time::sleep(Duration::from_millis(1)).await;
    assert!(module.entorhinal_watch_up());

    test_bus.panic_watches();
    tokio::time::sleep(RETRY_FIRST - Duration::from_millis(100)).await;
    assert_eq!(
        test_bus.watched.lock().unwrap().len(),
        1,
        "do not reopen early"
    );
    test_bus.kv.put(KEY, marker(1)).await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        test_bus.watched.lock().unwrap().len(),
        2,
        "reopen after backoff"
    );
    assert!(module.legacy_wake().woken(Duration::from_millis(1)).await);
}

#[tokio::test(start_paused = true)]
async fn stopping_a_marker_watch_prevents_it_from_reopening() {
    for cut_before_stop in [false, true] {
        let test_bus = TestBus::new();
        let module = Module::new(Client::default(), Settings::default(), None, None);
        let watch = module.spawn_entorhinal_follow(test_bus.bus());
        tokio::time::sleep(Duration::from_millis(1)).await;
        assert!(module.entorhinal_watch_up());

        if cut_before_stop {
            test_bus.cut_watches();
            tokio::time::sleep(Duration::from_millis(1)).await;
            assert!(!module.entorhinal_watch_up());
        }
        drop(watch);
        tokio::time::sleep(Duration::from_millis(1)).await;
        test_bus.cut_watches();
        tokio::time::sleep(RETRY_FIRST + Duration::from_secs(1)).await;
        assert_eq!(
            test_bus.watched.lock().unwrap().len(),
            1,
            "stop prevents reopening (already in backoff: {cut_before_stop})"
        );
    }
}

#[tokio::test(start_paused = true)]
async fn a_panicked_marker_watch_is_down_during_backoff() {
    let test_bus = TestBus::new();
    let module = Module::new(Client::default(), Settings::default(), None, None);
    let _watch = module.spawn_entorhinal_follow(test_bus.bus());
    tokio::time::sleep(Duration::from_millis(1)).await;
    assert!(module.entorhinal_watch_up());

    test_bus.panic_watches();
    tokio::time::sleep(RETRY_FIRST / 2).await;
    assert!(
        !module.entorhinal_watch_up(),
        "panicked watch must read down"
    );
}

#[test]
fn a_replacement_snapshot_observes_a_new_revision_of_the_same_value() {
    let state = WatchState::default();
    let entry = |revision| {
        Some(cortexkit_bus_trait::RegisterEntry {
            key: KEY.to_owned(),
            value: marker(1),
            revision: cortexkit_bus_trait::Revision(revision),
        })
    };
    assert!(state.observe(entry(1), true));
    assert!(
        !state.observe(entry(2), false),
        "an identical live put does not reread"
    );
    assert!(
        !state.observe(entry(2), true),
        "a handoff with no gap does not reread"
    );
    assert!(
        state.observe(entry(4), true),
        "the value may have changed and returned"
    );
}

#[test]
fn deleting_the_marker_then_putting_its_old_value_requests_two_rereads() {
    let state = WatchState::default();
    let count = AtomicUsize::new(0);
    let event = |event| {
        observe(&state, KEY, event, &|| {
            count.fetch_add(1, Ordering::SeqCst);
        });
        count.load(Ordering::SeqCst)
    };
    let put = |revision| {
        WatchEvent::Update(RegisterUpdate::Put(RegisterEntry {
            key: KEY.to_owned(),
            value: marker(1),
            revision: Revision(revision),
        }))
    };
    let delete = |key: &str, revision| {
        WatchEvent::Update(RegisterUpdate::Delete(cortexkit_bus_trait::Tombstone {
            key: key.to_owned(),
            revision: Revision(revision),
        }))
    };
    assert_eq!(event(put(1)), 1);
    assert_eq!(event(delete("other", 2)), 1);
    assert_eq!(event(delete(KEY, 3)), 2);
    assert_eq!(event(delete(KEY, 4)), 2);
    assert_eq!(event(put(5)), 3);
    assert_eq!(event(put(6)), 3);
}

#[test]
fn a_put_after_an_empty_snapshot_is_a_reread_even_if_the_value_returns() {
    let state = WatchState::default();
    let empty = || WatchEvent::Snapshot {
        entries: Vec::new(),
        revision: Revision(0),
    };
    let put = |revision| {
        WatchEvent::Update(RegisterUpdate::Put(RegisterEntry {
            key: KEY.to_owned(),
            value: marker(1),
            revision: Revision(revision),
        }))
    };
    let count = AtomicUsize::new(0);
    let event = |event| {
        observe(&state, KEY, event, &|| {
            count.fetch_add(1, Ordering::SeqCst);
        });
        count.load(Ordering::SeqCst)
    };
    assert_eq!(event(empty()), 0);
    assert_eq!(event(put(1)), 1);
    assert_eq!(event(empty()), 2);
    assert_eq!(event(empty()), 2);
    assert_eq!(event(put(2)), 3);
}

#[tokio::test(start_paused = true)]
async fn a_new_session_ends_marker_backoff_without_waiting_for_the_timer() {
    let test_bus = TestBus::new();
    test_bus.kv.put(KEY, marker(1)).await.unwrap();
    let bus = test_bus.bus();
    let state = Arc::new(WatchState::default());
    let callback = Arc::new(tokio::sync::Notify::new());
    let _watch = spawn_marker(bus.clone(), state.clone(), KEY, {
        let callback = callback.clone();
        move || callback.notify_one()
    });
    callback.notified().await;
    test_bus.down.store(true, Ordering::Relaxed);
    test_bus.cut_watches();
    tokio::time::sleep(Duration::from_secs(30)).await;
    assert!(!state.is_up());
    assert_eq!(test_bus.watched.lock().unwrap().len(), 1);

    test_bus.kv.put(KEY, marker(2)).await.unwrap();
    test_bus.down.store(false, Ordering::Relaxed);
    let resumed = tokio::time::Instant::now();
    drop(bus.session().await.unwrap());
    tokio::time::timeout(Duration::from_millis(1), callback.notified())
        .await
        .expect("the watch follows the live session before its timer");
    assert_eq!(tokio::time::Instant::now(), resumed);
    assert!(state.is_up());
}

#[tokio::test(start_paused = true)]
async fn a_slow_handoff_warns_once_even_while_the_snapshot_is_pending() {
    let log = crate::test_log::capture();
    let (release, snapshot) = oneshot::channel::<()>();
    let handoff = tokio::spawn(trace_handoff(KEY, Instant::now(), snapshot));
    let warning = "marker watch handoff is taking longer than expected";
    tokio::time::sleep(SLOW_HANDOFF - Duration::from_millis(1)).await;
    assert_eq!(log.count(warning), 0);
    tokio::time::sleep(Duration::from_millis(2)).await;
    assert_eq!(log.count(warning), 1);
    assert!(
        log.text()
            .lines()
            .any(|line| line.trim_start().starts_with("WARN")
                && line.contains(warning)
                && line.contains("elapsed_ms=5000")),
        "{}",
        log.text()
    );
    assert!(!handoff.is_finished());
    tokio::time::sleep(SLOW_HANDOFF).await;
    release.send(()).unwrap();
    handoff.await.unwrap().unwrap();
    assert_eq!(log.count(warning), 1);
}

#[tokio::test(start_paused = true)]
async fn an_ended_marker_forgets_the_current_session_before_sleeping() {
    let test_bus = TestBus::new();
    test_bus.kv.put(KEY, marker(1)).await.unwrap();
    let bus = test_bus.bus();
    let state = Arc::new(WatchState::default());
    let callback = Arc::new(tokio::sync::Notify::new());
    let _watch = spawn_marker(bus.clone(), state.clone(), KEY, {
        let callback = callback.clone();
        move || callback.notify_one()
    });
    callback.notified().await;
    assert!(state.is_up());
    test_bus.cut_watches();
    tokio::time::sleep(Duration::from_millis(1)).await;
    assert!(!state.is_up());
    assert!(
        !bus.is_connected(),
        "the marker must forget the failed current session"
    );
    assert!(bus.generations().borrow().is_none());
    assert_eq!(
        test_bus.opened.load(Ordering::Relaxed),
        1,
        "marker is backing off"
    );
}
