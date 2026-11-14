use super::*;
use crate::client::ClientError;
use crate::runner_capabilities::SessionRetention;
use cortexkit_role_compaction::read::{ReadPage, ReadRequest};
use cortexkit_role_compaction::view::{AppliedViewAnswer, ApplyViewAnswer, ApplyViewRequest};
use cortexkit_role_llm_runner::send::SendReply;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

pub(crate) struct Client {
    pub declares: bool,
    pub temperature: bool,
    pub refuse_temperature: bool,
    /// Declares `session_retention` with these limits when set.
    pub retention: Option<SessionRetention>,
    pub sends: Mutex<Vec<(Child, SendRequest)>>,
    /// The text every run ends with; none when unset.
    pub reply: Option<String>,
    /// Entorhinal's answer to every read, as the reply's JSON; none when
    /// unset, as without Entorhinal.
    pub entorhinal: Option<serde_json::Value>,
    /// The Entorhinal reads asked, as their request JSON.
    pub entorhinal_calls: Mutex<Vec<serde_json::Value>>,
    discoveries: AtomicUsize,
}

impl Client {
    pub fn new(declares: bool) -> Self {
        Self {
            declares,
            temperature: true,
            refuse_temperature: false,
            retention: None,
            sends: Mutex::new(vec![]),
            reply: None,
            entorhinal: None,
            entorhinal_calls: Mutex::new(vec![]),
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
    async fn child_session_retention(&self, _: &Child) -> Option<SessionRetention> {
        self.retention
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
        let mut result = RunResult::new("run", states::COMPLETED);
        if let Some(text) = &self.reply {
            result.final_message = Some(
                serde_json::from_value(
                    serde_json::json!({"ordinal": 2, "mid": "m2", "text": text}),
                )
                .expect("a final message"),
            );
        }
        Ok(result)
    }
    async fn entorhinal_call(
        &self,
        _: &SessionRef,
        body: Vec<u8>,
    ) -> Option<Result<Vec<u8>, crate::client::EntorhinalRefusal>> {
        self.entorhinal_calls
            .lock()
            .unwrap()
            .push(serde_json::from_slice(&body).expect("a JSON request"));
        let reply = self.entorhinal.as_ref()?;
        Some(Ok(serde_json::to_vec(reply).expect("a JSON reply")))
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
            keep_child: false,
            cache_ttl: cortexkit_role_llm_runner::cache::Ttl::None,
            plan: None,
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
        keep_child: false,
        cache_ttl: cortexkit_role_llm_runner::cache::Ttl::None,
        plan: None,
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
        prompts: &crate::summary::prompts::SummaryPrompts::bundled(),
        keep_child: false,
        target: &target,
        child_harness: "pi",
        window,
        system: "system",
        deadline: tokio::time::Instant::now() + Duration::from_secs(1),
    };
    call(&client, &child(), "first", "prompt", &call_on, &mut None)
        .await
        .unwrap();
    assert_eq!(
        client.sends.lock().unwrap()[0].1.session_class.as_deref(),
        Some("summary")
    );
}
