use super::*;
use cortexkit_role_compaction::read::{ReadPage, ReadRequest};
use cortexkit_role_compaction::view::{AppliedViewAnswer, ApplyViewAnswer, ApplyViewRequest};
use cortexkit_role_llm_runner::run::{RunResult, RunResultRequest};
use cortexkit_role_llm_runner::send::{SendReply, SendRequest};
use mc_module::child_scopes::ChildScopes;
use mc_module::client::{Child, ClientError, RunnerClient};
use mc_module::context_db::ContextDb;
use mc_module::pass::Settings;
use mc_module::route::Route;
use mc_module::session::Session;
use mc_module::transport::SubcRunnerClient;
use std::sync::{Arc, Mutex};

struct CountedTransport {
    inner: SubcRunnerClient,
    calls: AtomicU64,
    refusals: Mutex<Vec<String>>,
}

macro_rules! forward {
    ($($method:ident($($arg:ident: $ty:ty),*) -> $reply:ty;)*) => {
        $(async fn $method(&self, $($arg: $ty),*) -> Result<$reply, ClientError> {
            self.inner.$method($($arg),*).await
        })*
    };
}

impl RunnerClient for CountedTransport {
    forward! {
        read(session: &SessionRef, request: ReadRequest) -> ReadPage;
        apply_view(session: &SessionRef, request: ApplyViewRequest) -> ApplyViewAnswer;
        applied_view(session: &SessionRef) -> AppliedViewAnswer;
        send(session: &SessionRef, request: SendRequest) -> SendReply;
        send_child(child: &Child, request: SendRequest) -> SendReply;
        child_result(child: &Child, request: RunResultRequest) -> RunResult;
    }

    async fn synapse_call(
        &self,
        session: &SessionRef,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let result = self.inner.synapse_call(session, method, params).await;
        if let Err(reason) = &result {
            self.refusals.lock().unwrap().push(reason.clone());
        }
        result
    }
}

/// The real SDK reports route-open refusals as NotSent rather than Module.
/// Count calls around the real transport, not around the catalog cache, so a
/// cached fallback cannot be mistaken for a second request to the daemon.
#[tokio::test]
#[ignore = "needs the throwaway subc daemon; run scripts/wire-gate.sh"]
async fn unknown_synapse_route_is_remembered_across_search_sessions() {
    let stack = start_stack();
    let consumer = SubcConsumer::connect(&stack.connection_file, ConsumerOptions::default())
        .await
        .unwrap();
    let error = consumer
        .call(
            RouteTarget::ManagementSurface {
                module_id: "synapse".into(),
            },
            BindIdentity::new("magic-context", "probe"),
            wire::encode("models.list", &json!({})),
            CallOptions {
                timeout: mc_module::search::rerank::SYNAPSE_DEADLINE,
                ..CallOptions::default()
            },
        )
        .await
        .unwrap_err();
    assert_eq!(
        error.route_open_refusal().map(|body| body.code.as_str()),
        Some("unknown_module"),
        "{error:?}"
    );

    let client = CountedTransport {
        inner: SubcRunnerClient::new(
            stack.connection_file.clone(),
            Arc::new(ChildScopes::new(PROVIDER)),
        ),
        calls: AtomicU64::new(0),
        refusals: Mutex::new(Vec::new()),
    };
    let db =
        Arc::new(ContextDb::create_for_tests(&stack._root.0.join("search-context.db")).unwrap());
    let session = |id| {
        Session::tools_only(
            &Route {
                session: SessionRef::new(RUNNER, "mock", id),
                project: None,
                workdir: None,
                agent_id: None,
            },
            Some(db.clone()),
        )
    };
    let mut first = session("search-one");
    let input = json!({"query": "how does the summarizer pick its model"});
    let mut settings = Settings {
        rerank: mc_module::search::rerank::Reranker::Off,
        ..Settings::default()
    };
    let ordinary = first
        .tool(&client, &settings, "ctx_search", &input)
        .await
        .unwrap();
    settings.rerank = mc_module::search::rerank::Reranker::Synapse;
    let started = Instant::now();
    let answer = first
        .tool(&client, &settings, "ctx_search", &input)
        .await
        .unwrap();
    assert_eq!(answer, ordinary);
    assert_eq!(*client.refusals.lock().unwrap(), ["unknown_module"]);
    assert_eq!(client.calls.load(Ordering::SeqCst), 1);
    let answer = session("search-two")
        .tool(&client, &settings, "ctx_search", &input)
        .await
        .unwrap();
    assert!(started.elapsed() < Duration::from_secs(30));
    assert_eq!(answer, ordinary);
    assert_eq!(client.calls.load(Ordering::SeqCst), 1);
}
