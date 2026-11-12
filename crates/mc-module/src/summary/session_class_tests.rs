use super::*;
use crate::client::ClientError;
use cortexkit_role_compaction::read::{ReadPage, ReadRequest};
use cortexkit_role_compaction::view::{AppliedViewAnswer, ApplyViewAnswer, ApplyViewRequest};
use cortexkit_role_llm_runner::send::SendReply;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

pub(crate) struct Client {
    pub declares: bool,
    pub temperature: bool,
    pub refuse_temperature: bool,
    pub sends: Mutex<Vec<(Child, SendRequest)>>,
    discoveries: AtomicUsize,
}

impl Client {
    pub fn new(declares: bool) -> Self {
        Self {
            declares,
            temperature: true,
            refuse_temperature: false,
            sends: Mutex::new(vec![]),
            discoveries: AtomicUsize::new(0),
        }
    }
}

impl RunnerClient for Client {
    async fn child_temperature(&self, _: &Child) -> bool {
        self.temperature
    }
    async fn child_session_class(&self, _: &Child) -> bool {
        self.discoveries.fetch_add(1, Ordering::SeqCst);
        self.declares
    }
    async fn read(&self, _: &SessionRef, _: ReadRequest) -> Result<ReadPage, ClientError> {
        unreachable!()
    }
    async fn apply_view(
        &self,
        _: &SessionRef,
        _: ApplyViewRequest,
    ) -> Result<ApplyViewAnswer, ClientError> {
        unreachable!()
    }
    async fn applied_view(&self, _: &SessionRef) -> Result<AppliedViewAnswer, ClientError> {
        unreachable!()
    }
    async fn send(&self, _: &SessionRef, _: SendRequest) -> Result<SendReply, ClientError> {
        unreachable!()
    }
    async fn send_child(
        &self,
        child: &Child,
        request: SendRequest,
    ) -> Result<SendReply, ClientError> {
        self.sends.lock().unwrap().push((child.clone(), request));
        if self.refuse_temperature && self.sends.lock().unwrap().len() == 1 {
            return Err(ClientError::refused(
                "invalid_params",
                "generation.temperature refused",
            ));
        }
        let mut reply = SendReply::new(states::ACTIVE);
        reply.run_id = Some("run".into());
        Ok(reply)
    }
    async fn child_result(&self, _: &Child, _: RunResultRequest) -> Result<RunResult, ClientError> {
        Ok(RunResult::new("run", states::COMPLETED))
    }
}

fn child() -> Child {
    Child {
        session: SessionRef::new("session-class-test", "mock", "summary-child"),
        project_root: Some("/project".into()),
    }
}

#[tokio::test]
async fn creating_summary_send_is_labelled_only_for_a_declaring_runner() {
    let model = ModelRef::new("provider", "model");
    for declares in [true, false] {
        let client = Client::new(declares);
        let how = Model {
            model: &model,
            decision_id: "decision",
            output_tokens: 1000,
            system: "system",
            deadline: tokio::time::Instant::now() + Duration::from_secs(1),
            continuation: false,
            creates_child: true,
            cache_ttl: cortexkit_role_llm_runner::cache::Ttl::None,
            send: SendKind::TurnOne,
        };
        send_and_wait(&client, &child(), "first", "prompt", &how, &mut None)
            .await
            .unwrap();
        let sends = client.sends.lock().unwrap();
        let request = &sends[0].1;
        assert_eq!(
            request.session_class.as_deref(),
            declares.then_some("summary")
        );
        if !declares {
            // Pin the legacy bytes independently of the new request builder.
            assert_eq!(
                serde_json::to_string(request).unwrap(),
                include_str!("../../testdata/summary-creating-send-0.8.36.json").trim_end()
            );
        }
    }
}

#[tokio::test]
async fn later_send_in_the_same_child_has_no_label_or_discovery() {
    let client = Client::new(true);
    let model = ModelRef::new("provider", "model");
    let mut how = Model {
        model: &model,
        decision_id: "decision",
        output_tokens: 1000,
        system: "system",
        deadline: tokio::time::Instant::now() + Duration::from_secs(1),
        continuation: false,
        creates_child: true,
        cache_ttl: cortexkit_role_llm_runner::cache::Ttl::None,
        send: SendKind::TurnOne,
    };
    send_and_wait(&client, &child(), "first", "prompt", &how, &mut None)
        .await
        .unwrap();
    how.continuation = true;
    how.creates_child = false;
    send_and_wait(&client, &child(), "second", "follow-up", &how, &mut None)
        .await
        .unwrap();
    let sends = client.sends.lock().unwrap();
    assert_eq!(sends[0].1.session_class.as_deref(), Some("summary"));
    assert_eq!(sends[1].1.session_class, None);
    assert_eq!(client.discoveries.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn turn_one_call_sets_creating_send_label() {
    let client = Client::new(true);
    let target = Target {
        model: ModelRef::new("provider", "model"),
        decision_id: "decision".into(),
        output_tokens: 1000,
    };
    let window = fit::Window {
        context_window: 100_000,
        counter: crate::count::Counter::for_model(None),
    };
    let call_on = Call {
        target: &target,
        child_harness: "pi",
        window,
        system: "system",
        repair: false,
        deadline: tokio::time::Instant::now() + Duration::from_secs(1),
        lane: Lane::Enabled,
    };
    call(&client, &child(), "first", "prompt", &call_on, &mut None)
        .await
        .unwrap();
    assert_eq!(
        client.sends.lock().unwrap()[0].1.session_class.as_deref(),
        Some("summary")
    );
}
