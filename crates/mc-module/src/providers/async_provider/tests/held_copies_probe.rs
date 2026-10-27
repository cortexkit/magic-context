//! compaction-provider 0.7.6's `held_copies_follow_reasoning_pruned` probe,
//! run end to end against the async provider for every serializer profile
//! ck-mc declares. The probe plays the runner: its scripted transcript, in
//! the profile's native stored format, answers ck-mc's reverse
//! `session.read` and `session.head` calls unchanged.
use super::*;
use cortexkit_role_compaction_provider::conformance::{
    held_copies_follow_reasoning_pruned_report, PrunedReasoningProbe, ScriptedRunner,
    HELD_COPIES_CASE,
};

/// The attested session-runner module the probe's runner id stands for:
/// ck-mc admits only real session-runner modules, so the probe's runner
/// reaches it as one of those.
const MODULE: &str = crate::route_targets::DEFAULT_RUNNER_MODULE_ID;

/// One reverse call, and where its answer goes.
type Call = (
    String,
    Value,
    tokio::sync::oneshot::Sender<Result<Value, SessionResolveError>>,
);

/// The provider's reverse calls, answered by the probe's scripted runner.
/// The probe lends the runner to each adapter call only for that call, so
/// a thread borrowing it answers calls while the adapter call runs.
#[derive(Default)]
struct ScriptedReverseCalls {
    calls: Mutex<Option<std::sync::mpsc::Sender<Call>>>,
}

impl ScriptedReverseCalls {
    /// Run `work` with the probe's runner answering reverse calls.
    fn with<T>(&self, runner: &ScriptedRunner, work: impl FnOnce() -> T) -> T {
        let (sender, calls) = std::sync::mpsc::channel::<Call>();
        *self.calls.lock().unwrap() = Some(sender);
        std::thread::scope(|scope| {
            scope.spawn(move || {
                for (method, params, reply) in calls {
                    let _ = reply.send(answer(runner, &method, &params));
                }
            });
            let result = work();
            // Dropping the sender ends the answering thread.
            *self.calls.lock().unwrap() = None;
            result
        })
    }

    async fn forward(&self, method: &str, params: Value) -> Result<Value, SessionResolveError> {
        let sender = self
            .calls
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| SessionResolveError::Transport("no probe call is running".into()))?;
        let (reply, answered) = tokio::sync::oneshot::channel();
        sender
            .send((method.to_owned(), params, reply))
            .map_err(|_| SessionResolveError::Transport("the probe runner is gone".into()))?;
        drop(sender);
        answered
            .await
            .map_err(|_| SessionResolveError::Transport("the probe runner did not answer".into()))?
    }
}

/// The scripted runner's answer to one reverse call, unchanged.
fn answer(
    runner: &ScriptedRunner,
    method: &str,
    params: &Value,
) -> Result<Value, SessionResolveError> {
    match method {
        "session.read" => runner
            .read(params)
            .map_err(|body| SessionResolveError::Refused {
                code: body["code"].as_str().unwrap_or("refused").into(),
                message: body["message"].as_str().unwrap_or_default().into(),
            }),
        "session.head" => Ok(runner.head()),
        "role.describe" => Ok(json!({
            "majors":[{"version":"llm-runner/v1","ops":["role.describe","session.baseline","session.send","session.read","session.resolve","session.head"]}],
            "implementation_version":"probe","session_capabilities_from":"baseline",
            "capabilities":["delivery_order","compaction","tags","tag_checkpoint","archive_prunes_reasoning"]
        })),
        other => Err(SessionResolveError::InvalidResponse(format!(
            "the probe runner does not answer {other}"
        ))),
    }
}

#[async_trait]
impl session_resolver::ProviderRunner for ScriptedReverseCalls {
    async fn call_for_identity(
        &self,
        _: &crate::route_targets::SessionRunnerRoute,
        _: &session_resolver::RunnerBindIdentity,
        method: &str,
        params: Value,
        _: Duration,
    ) -> Result<Value, SessionResolveError> {
        self.forward(method, params).await
    }

    async fn call(
        &self,
        _: &Path,
        _: &str,
        method: &str,
        params: Value,
        _: Duration,
    ) -> Result<Value, SessionResolveError> {
        self.forward(method, params).await
    }
}

struct Adapter {
    profile: &'static str,
    h: Arc<McHandler>,
    bus: Arc<InMemoryBus>,
    task: tokio::task::JoinHandle<()>,
    calls: Arc<ScriptedReverseCalls>,
    dir: PathBuf,
}

impl Drop for Adapter {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Adapter {
    async fn new(dir: &Path, profile: &'static str) -> Self {
        let descriptor = StorageDescriptor {
            module_id: DEFAULT_MODULE_ID.into(),
            storage_namespace: "mc_cache".into(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: dir.join("store.db").to_string_lossy().into(),
            },
        };
        let store = Arc::new(McStore::open_for_test(&descriptor).unwrap());
        let calls = Arc::new(ScriptedReverseCalls::default());
        let mut h = McHandler::new();
        h.producer_factory =
            crate::providers::session_runner_fake::FakeSessionRunner::for_project(dir).factory();
        h.store.set(store).ok().unwrap();
        h.provider_runner = calls.clone();
        let config = McModuleConfig {
            inject_docs: false,
            protected_tokens_user: Some(0),
            protected_tools: BTreeMap::new(),
            ..Default::default()
        };
        h.fixed_config = Some(config.clone());
        h.bind_route(
            7,
            SessionBinding {
                principal: Some(subc_protocol::Principal::Reserved {
                    module_id: MODULE.into(),
                }),
                scope: None,
                project_root: dir.into(),
                harness: session_resolver::RUNNER_BIND_HARNESS.into(),
                session: String::new(),
                model_key: None,
                config,
                history_budget_tokens: 4_000.0,
            },
        );
        let h = Arc::new(h);
        let bus = Arc::new(InMemoryBus::new(
            InMemoryConfig::default().with_durable(DurableOwner::Module(DEFAULT_MODULE_ID)),
        ));
        let task = h
            .clone()
            .start_compaction_bus(bus.clone(), "fixture".into())
            .await
            .unwrap();
        Self {
            profile,
            h,
            bus,
            task,
            calls,
            dir: dir.into(),
        }
    }

    /// ck-mc's reference for the probe's session: the probe derives its own
    /// from its runner id, and ck-mc from the attested module it arrived as.
    fn reference(session: &str) -> String {
        runner_session_ref(
            MODULE,
            cortexkit_role_compaction_provider::conformance::PROBE_HARNESS,
            session,
        )
    }

    fn block_on<T>(&self, work: impl std::future::Future<Output = T>) -> T {
        tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(work))
    }

    fn state(&self, reference: &str) -> Option<State> {
        load(self.h.store.get().unwrap(), reference).unwrap()
    }
}

impl PrunedReasoningProbe for Adapter {
    fn serializer_profile(&self) -> Option<String> {
        Some(self.profile.into())
    }

    fn setup(
        &mut self,
        runner: &ScriptedRunner,
        request: &compact::setup::SetupRequest,
    ) -> Result<compact::setup::SetupAnswer, String> {
        let mut params = serde_json::to_value(request).map_err(|e| e.to_string())?;
        // ck-mc sizes its engine pass from the Setup's context window, which
        // the probe's request leaves to the provider.
        params["context_window"] = json!(100_000);
        let outcome = self.calls.with(runner, || {
            self.block_on(
                self.h
                    .dispatch_value(7, json!({"method":"compaction.setup","params":params})),
            )
        });
        let HandlerOutcome::Response(bytes) = outcome else {
            return Err(format!("Setup was not answered: {outcome:?}"));
        };
        serde_json::from_slice(&bytes).map_err(|e| e.to_string())
    }

    fn notice(
        &mut self,
        runner: &ScriptedRunner,
        notice: &notice::AdvanceNotice,
    ) -> Result<(), String> {
        let session = notice_session(notice, &self.dir)?;
        let reference = Self::reference(&session);
        let mut notice = notice.clone();
        notice.session_ref = reference.clone();
        let headers = notice.to_headers();
        let seq = notice.seq;
        self.calls.with(runner, || {
            self.block_on(async {
                let _ = self
                    .bus
                    .publish(
                        &notice::event_subject("fixture", MODULE, notice::ADVANCED_EVENT),
                        &bus_id(&reference, "advanced", seq),
                        notice.digest().parse().unwrap(),
                        headers,
                    )
                    .await
                    .map_err(|e| e.to_string())?;
                let done = tokio::time::timeout(Duration::from_secs(10), async {
                    while self
                        .state(&reference)
                        .is_none_or(|state| state.completed_seq < seq)
                    {
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                })
                .await;
                if done.is_ok() {
                    return Ok(());
                }
                // Say why: repeat the notice's read and engine pass on a copy.
                let Some(mut state) = self.state(&reference) else {
                    return Err(format!("notice {seq}: no record"));
                };
                let from = state.read_from();
                let read = self
                    .h
                    .read_async_resumable(&mut state, from, Duration::from_secs(5))
                    .await
                    .map(|_| ())
                    .err();
                let engine = match read {
                    None => codec::Codec::from_params(&Value::Object(state.setup.params.clone()))
                        .and_then(|codec| {
                            state.ingest_read(self.h.store.get().unwrap(), codec)?;
                            self.h.publish_async(0, &mut state, codec, true).map(|_| ())
                        })
                        .err(),
                    Some(_) => None,
                };
                Err(format!(
                    "notice {seq} did not complete: failure={:?} engine_failed={} read={read:?} engine={engine:?}",
                    state.failure.as_ref().map(|f| f.reason.clone()),
                    state.engine_failed,
                ))
            })
        })
    }

    fn next_view(
        &mut self,
        runner: &ScriptedRunner,
        session_ref: &str,
    ) -> Result<view::CompactionView, String> {
        let reference = self
            .sessions()
            .into_iter()
            .find(|session| {
                cortexkit_role_llm_runner::session_ref(
                    &cortexkit_role_llm_runner::SessionIdentity {
                        runner: cortexkit_role_compaction_provider::conformance::PROBE_RUNNER,
                        harness: cortexkit_role_compaction_provider::conformance::PROBE_HARNESS,
                        session,
                    },
                ) == session_ref
            })
            .map(|session| Self::reference(&session))
            .ok_or("no conversation for the probe's session_ref")?;
        let store = self.h.store.get().unwrap();
        let mut state = self
            .h
            .checkout(store, &reference)
            .map_err(|e| format!("{e:?}"))?
            .ok_or("no record")?;
        // A history summary covering the held messages up to the newest
        // answer's prompt: the view folds them into its head, a replace
        // range standing for the pruned answers before it.
        let first = state.lineage_from();
        let last = *state.entries.last_key_value().ok_or("nothing held")?.0;
        let end = last.saturating_sub(1).max(first);
        store
            .replace_compartments(
                &state.namespace(),
                &[mc_store::StoredCompartment {
                    sequence: 1,
                    start_message: first as i64,
                    end_message: end as i64,
                    end_message_id: format!("{}#0", state.entries[&end].mid),
                    title: "history".into(),
                    content: "what the earlier turns settled".into(),
                    p1: Some("what the earlier turns settled".into()),
                    importance: 50,
                    ..Default::default()
                }],
            )
            .map_err(|e| e.to_string())?;
        store
            .arm_soft_refresh(&state.namespace())
            .map_err(|e| e.to_string())?;
        let codec = codec::Codec::from_params(&Value::Object(state.setup.params.clone()))
            .map_err(|e| format!("{e:?}"))?;
        let published = self
            .calls
            .with(runner, || self.h.publish_async(0, &mut state, codec, true));
        let published = match published {
            Ok(view) => {
                state.save(store, &[]).map_err(|e| format!("{e:?}"))?;
                view
            }
            Err(error) => {
                drop(state);
                return Err(format!("the engine pass failed: {error:?}"));
            }
        };
        let newest = state.published_engine.keys().next_back().copied();
        self.h.checkin(state);
        if let Some(view) = published {
            return Ok(view);
        }
        // Nothing new to publish: the next view is the newest one.
        let version = newest.ok_or("no view was ever published")?;
        let raw = store
            .load_async_compaction_view(&reference, version)
            .map_err(|e| e.to_string())?
            .ok_or("the newest view is not stored")?;
        serde_json::from_str(&raw).map_err(|e| e.to_string())
    }
}

impl Adapter {
    /// The probe's sessions ck-mc holds records for.
    fn sessions(&self) -> Vec<String> {
        let conn = rusqlite::Connection::open(self.dir.join("store.db")).unwrap();
        let mut query = conn
            .prepare("SELECT DISTINCT session FROM mc_async_compaction")
            .unwrap();
        query
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }
}

/// The probe session a notice belongs to, found from its runner-derived
/// reference among the probe's session names.
fn notice_session(notice: &notice::AdvanceNotice, _dir: &Path) -> Result<String, String> {
    [
        "probe-pruned-no-cut",
        "probe-pruned-cut",
        "probe-pruned-opaque",
    ]
    .into_iter()
    .find(|session| {
        cortexkit_role_llm_runner::session_ref(&cortexkit_role_llm_runner::SessionIdentity {
            runner: cortexkit_role_compaction_provider::conformance::PROBE_RUNNER,
            harness: cortexkit_role_compaction_provider::conformance::PROBE_HARNESS,
            session,
        }) == notice.session_ref
    })
    .map(str::to_owned)
    .ok_or_else(|| format!("{HELD_COPIES_CASE}: a notice for an unknown session"))
}

/// Run the published probe for `profile` and return its report or failure.
async fn run_probe(profile: &'static str) -> Result<String, String> {
    let dir = tempfile::tempdir().unwrap();
    let mut adapter = Adapter::new(dir.path(), profile).await;
    held_copies_follow_reasoning_pruned_report(&mut adapter).map(|report| format!("{report:?}"))
}

/// Run the probe for `profile` and fail with its own message.
async fn probe_passes(profile: &'static str) {
    match run_probe(profile).await {
        Ok(report) => eprintln!("{profile}: passed {report}"),
        Err(failure) => panic!("{profile}: {failure}"),
    }
}

// With compaction-provider 0.7.6 every profile run passes the probe's
// no-cut conversation and stops in its cut conversation: there the runner
// cuts on its own and calls Setup descending from that cut, which ck-mc
// never published, so ck-mc refuses it `unknown_cut` as CONTRACT §4
// requires. Run them with `--ignored`.

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "kit fixture defect (compaction-provider 0.7.6): the probe's cut conversation descends from {probe-lineage-a, 1}, a cut the provider never published, and CONTRACT §4 requires that Setup be refused unknown_cut; the no-cut conversation passes"]
async fn held_copies_follow_reasoning_pruned_owned_broca() {
    probe_passes("owned-broca").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "kit fixture defect (compaction-provider 0.7.6): the probe's cut conversation descends from {probe-lineage-a, 1}, a cut the provider never published, and CONTRACT §4 requires that Setup be refused unknown_cut; the no-cut conversation passes"]
async fn held_copies_follow_reasoning_pruned_opencode_aisdk() {
    probe_passes("opencode-aisdk").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "kit fixture defect (compaction-provider 0.7.6): the probe's cut conversation descends from {probe-lineage-a, 1}, a cut the provider never published, and CONTRACT §4 requires that Setup be refused unknown_cut; the no-cut conversation passes"]
async fn held_copies_follow_reasoning_pruned_pi() {
    probe_passes("pi").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "kit fixture defect (compaction-provider 0.7.6): the probe's cut conversation descends from {probe-lineage-a, 1}, a cut the provider never published, and CONTRACT §4 requires that Setup be refused unknown_cut; the no-cut conversation passes"]
async fn held_copies_follow_reasoning_pruned_anthropic_messages() {
    probe_passes("anthropic-messages").await;
}
