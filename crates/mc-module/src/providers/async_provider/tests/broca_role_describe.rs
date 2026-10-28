use super::super::*;
use cortexkit_role_llm_runner::describe::check_describe;

#[path = "broca_role_describe_dream.rs"]
mod dream;
#[path = "broca_role_describe_historian.rs"]
mod historian;

#[derive(Clone)]
pub(crate) struct LogWriter(pub Arc<Mutex<Vec<u8>>>);

impl std::io::Write for LogWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

pub(crate) fn capture_logs() -> (impl tracing::Subscriber + Send + Sync, LogWriter) {
    let logs = LogWriter(Arc::new(Mutex::new(Vec::new())));
    let writer = logs.clone();
    let subscriber = tracing_subscriber::fmt()
        .without_time()
        .with_ansi(false)
        .with_writer(move || writer.clone())
        .finish();
    (subscriber, logs)
}

pub(crate) fn captures() -> Vec<(&'static str, bool, Value)> {
    [
        (
            "writer before",
            true,
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/testdata/broca-role-describe-0.3.261/role_describe.before.json"
            )),
        ),
        (
            "writer after",
            true,
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/testdata/broca-role-describe-0.3.261/role_describe.after.json"
            )),
        ),
        (
            "reader before",
            false,
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/testdata/broca-role-describe-0.3.261/role_describe_reader.before.json"
            )),
        ),
        (
            "reader after",
            false,
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/testdata/broca-role-describe-0.3.261/role_describe_reader.after.json"
            )),
        ),
    ]
    .into_iter()
    .map(|(name, writer, bytes)| (name, writer, serde_json::from_str(bytes).unwrap()))
    .collect()
}

pub(crate) struct DescribedRunner {
    pub answer: Value,
    pub inner: Arc<dyn session_resolver::ProviderRunner>,
    pub describes: std::sync::atomic::AtomicUsize,
}

impl DescribedRunner {
    pub fn new(answer: Value, inner: Arc<dyn session_resolver::ProviderRunner>) -> Arc<Self> {
        Arc::new(Self {
            answer,
            inner,
            describes: Default::default(),
        })
    }

    fn describe(&self) -> Result<Value, SessionResolveError> {
        self.describes
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        session_resolver::read_runner_reply(json!({"result": self.answer}))
    }
}

#[async_trait]
impl session_resolver::ProviderRunner for DescribedRunner {
    async fn call_for_identity(
        &self,
        route: &crate::route_targets::SessionRunnerRoute,
        identity: &session_resolver::RunnerBindIdentity,
        method: &str,
        params: Value,
        budget: Duration,
    ) -> Result<Value, SessionResolveError> {
        if method == "role.describe" {
            self.describe()
        } else {
            self.inner
                .call_for_identity(route, identity, method, params, budget)
                .await
        }
    }

    async fn call(
        &self,
        project: &Path,
        session: &str,
        method: &str,
        params: Value,
        budget: Duration,
    ) -> Result<Value, SessionResolveError> {
        if method == "role.describe" {
            self.describe()
        } else {
            self.inner
                .call(project, session, method, params, budget)
                .await
        }
    }
}

#[test]
fn broca_role_describe_envelope_and_typed_groups() {
    for (name, writer, answer) in captures() {
        let read = session_resolver::read_runner_reply(json!({"result": answer})).unwrap();
        assert_eq!(read, answer, "{name}");
        let description = check_describe(&read).unwrap_or_else(|e| panic!("{name}: {e:?}"));
        for group in [
            "tag_checkpoint",
            "compaction",
            "retention",
            "ordered_hook_phases",
            "model_view",
        ] {
            assert_eq!(description.declares(group), writer, "{name}: {group}");
        }
        for group in [
            "run_ops",
            "run_status",
            "run_usage",
            "streaming",
            "no_tools",
            "max_steps",
            "delivery_order",
            "queue",
            "plans",
            "run_cancel",
            "retract",
            "input_token_cap",
        ] {
            assert!(description.declares(group), "{name}: {group}");
        }
        assert!(!description.declares("max_output_tokens"), "{name}");
        assert_eq!(
            description.declares("host_history"),
            name.ends_with("after"),
            "{name}"
        );
        assert_eq!(
            description.declares("history_display"),
            name.ends_with("after"),
            "{name}"
        );
        assert_eq!(
            description.declares("output_refs"),
            name.ends_with("after"),
            "{name}"
        );
    }
}

#[test]
fn broca_role_describe_ops_and_groups_are_extensible_not_closed_enums() {
    for (name, _, mut answer) in captures() {
        answer["capabilities"]
            .as_array_mut()
            .unwrap()
            .push(json!("future_group_probe"));
        answer["majors"][0]["ops"]
            .as_array_mut()
            .unwrap()
            .push(json!("future.operation_probe"));
        answer["future_top_level_probe"] = json!({"enabled": true});
        let description = check_describe(&answer).unwrap_or_else(|e| panic!("{name}: {e:?}"));
        assert!(description.declares("future_group_probe"), "{name}");
    }
}

#[test]
fn broca_role_describe_follow_capabilities() {
    for (name, _, answer) in captures() {
        let follow = crate::runner_follow::FollowCapabilities::from_describe(&answer);
        assert!(
            follow.run_ops && follow.run_status && follow.streaming && follow.run_usage,
            "{name}"
        );
        assert_eq!(follow.missing(), None, "{name}");
    }
}

#[test]
fn broca_role_describe_run_limits() {
    use crate::runner_limits::RunnerLimits;
    for (name, _, answer) in captures() {
        let limits = RunnerLimits::from_describe(&answer);
        assert_eq!(
            limits,
            RunnerLimits {
                max_steps: true,
                max_output_tokens: false,
                no_tools: true
            },
            "{name}"
        );
        limits.require_historian().unwrap();
        let mut chain = vec!["opencode/zen".into(), "provider/model".into()];
        limits.historian_chain(name, &mut chain).unwrap();
        assert_eq!(chain, ["provider/model"], "{name}");
        let mut model_limits = BTreeMap::new();
        limits
            .fit_limits(&chain, &mut model_limits, Some(100_000), 32_000)
            .unwrap();
        assert_eq!(model_limits["provider/model"].input, Some(68_000), "{name}");
        assert!(
            limits
                .historian_chain(name, &mut vec!["opencode/zen".into()])
                .is_err(),
            "{name}"
        );
    }
}

#[tokio::test]
async fn broca_role_describe_setup_checkpoint() {
    use crate::offline_move::{self, tests as fixture};
    for (name, writer, answer) in captures() {
        let dir = tempfile::tempdir().unwrap();
        let session = fixture::fixture_session();
        // The move's apply step needs the marker on the selected cut message
        // before it writes.
        let paths = fixture::write_moved_session_stores(dir.path());
        offline_move::run(&paths, &session, false, &fixture::NoHolders, None).unwrap();
        let mut served = None;
        let (rig, result) = Rig::try_setup_with_model(
            dir.path(),
            "broca",
            ("runner", &session),
            ("opencode", &session),
            "fixture",
            json!({"serializer_profile":"opencode-aisdk"}),
            |h| {
                let runner = DescribedRunner::new(answer, h.provider_runner.clone());
                h.provider_runner = runner.clone();
                served = Some(runner);
            },
        )
        .await;
        assert_eq!(
            served
                .unwrap()
                .describes
                .load(std::sync::atomic::Ordering::Relaxed),
            1,
            "{name}"
        );
        if writer {
            assert_eq!(result["answer"], "ready", "{name}: {result}");
            assert_eq!(
                result["checkpoint"]["tag_checkpoint"], 20,
                "{name}: {result}"
            );
        } else {
            assert_eq!(
                result["code"], "tag_checkpoint_unsupported",
                "{name}: {result}"
            );
            let decoded: contract::setup::SetupAnswer =
                serde_json::from_value(result.clone()).unwrap();
            assert_eq!(decoded.retryable(), Some(false), "{name}: {result}");
            assert!(
                load_head(rig.h.store.get().unwrap(), &rig.reference)
                    .unwrap()
                    .is_none(),
                "{name}"
            );
        }
    }
}

struct ReminderRunner {
    description: Mutex<Value>,
    sends: Mutex<Vec<Value>>,
    refuse: bool,
}

#[async_trait]
impl session_resolver::ProviderRunner for ReminderRunner {
    async fn call_for_identity(
        &self,
        route: &crate::route_targets::SessionRunnerRoute,
        identity: &session_resolver::RunnerBindIdentity,
        method: &str,
        params: Value,
        budget: Duration,
    ) -> Result<Value, SessionResolveError> {
        self.call(
            &identity.project_root,
            route.parent_session(),
            method,
            params,
            budget,
        )
        .await
    }

    async fn call(
        &self,
        _: &Path,
        _: &str,
        method: &str,
        params: Value,
        _: Duration,
    ) -> Result<Value, SessionResolveError> {
        match method {
            "role.describe" => session_resolver::read_runner_reply(
                json!({"result": self.description.lock().unwrap().clone()}),
            ),
            "session.send" => {
                self.sends.lock().unwrap().push(params);
                if self.refuse {
                    Err(SessionResolveError::Refused {
                        code: cortexkit_role_llm_runner::errors::DELIVERY_UNSUPPORTED.into(),
                        message: "delivery modes unavailable".into(),
                    })
                } else {
                    Ok(json!({"state":"pending","submission_id":"reminder"}))
                }
            }
            _ => panic!("unexpected reminder operation: {method}"),
        }
    }
}

fn reminder_conditions() -> crate::runner_reminders::ReminderConditions<'static> {
    crate::runner_reminders::ReminderConditions {
        notice_id: "notice",
        now_ms: 10_000,
        real_user_turn_count: 1,
        baseline: None,
        newest_tool_tag: None,
        hints: &|| Ok(Default::default()),
        drops_applied: false,
        baseline_refreshed: false,
        hard_fold_coverage_advanced: false,
        user_message_id: Some("user-mid"),
        temporal_enabled: true,
        gap_ms: Some(7_260_000),
        ready_search_hint: Some("ready search result"),
    }
}

#[tokio::test]
async fn broca_role_describe_reminder_delivery_modes() {
    use crate::runner_reminders::{send_due_reminders, ReminderState};
    let mut control = None;
    for (name, _, description) in captures() {
        let runner = ReminderRunner {
            description: Mutex::new(description),
            sends: Mutex::new(Vec::new()),
            refuse: false,
        };
        let mut state = ReminderState::default();
        let outcome = send_due_reminders(
            &runner,
            Path::new("/fixture"),
            "session",
            &mut state,
            &reminder_conditions(),
        )
        .await;
        assert!(outcome.errors.is_empty(), "{name}: {outcome:?}");
        assert_eq!(outcome.issued.len(), 2, "{name}: {outcome:?}");
        for request in &outcome.issued {
            assert_eq!(
                request["delivery"],
                json!(["tool_result", "steer"]),
                "{name}: {request}"
            );
        }
        if let Some(expected) = &control {
            assert_eq!(&outcome.issued, expected, "{name}");
        } else {
            control = Some(outcome.issued);
        }
    }
}

#[tokio::test]
async fn broca_role_describe_upgrade_retries_refused_reminder_list_once() {
    use crate::runner_reminders::{send_due_reminders, ReminderState};
    let all = captures();
    let (pairs, _) = all.as_chunks::<2>();
    for pair in pairs {
        let runner = ReminderRunner {
            description: Mutex::new(pair[0].2.clone()),
            sends: Mutex::new(Vec::new()),
            refuse: true,
        };
        let mut state = ReminderState::default();
        for (description, expected_count) in [
            (&pair[0].2, 1),
            (&pair[0].2, 1),
            (&pair[1].2, 2),
            (&pair[1].2, 2),
        ] {
            *runner.description.lock().unwrap() = description.clone();
            let outcome = send_due_reminders(
                &runner,
                Path::new("/fixture"),
                "session",
                &mut state,
                &reminder_conditions(),
            )
            .await;
            assert!(
                outcome.issued.is_empty(),
                "no refused delivery is recorded as sent"
            );
            assert_eq!(
                runner.sends.lock().unwrap().len(),
                expected_count,
                "{}: {outcome:?}",
                pair[0].0
            );
        }
    }
}
