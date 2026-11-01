use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use mc_module::parity_contract::*;
use mc_module::retrieval::embedding_provider::*;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

fn context() -> RequestContext {
    RequestContext {
        contract_version: PARITY_CONTRACT_VERSION,
        route: RouteIdentity::from_authenticated_route(
            StoreScope {
                project: ProjectId("fixture".into()),
                session: SessionId("session".into()),
                generation: Generation(7),
            },
            InputOrigin::Core,
        ),
        invocation: InvocationId("embedding-test".into()),
        config_generation: Generation(3),
        control: CallbackControl::new(chrono::Utc::now().timestamp_millis() + 60_000),
    }
}
fn config() -> OpenAiConfig {
    serde_json::from_value(
        json!({"endpoint":"http://127.0.0.1:1/v1", "model":"fixture", "dimensions":4}),
    )
    .unwrap()
}
fn provider(
    config: ResolvedEmbeddingConfig,
    transport: Option<Arc<dyn HttpTransport>>,
) -> (RemoteEmbeddingProvider, Arc<AtomicU64>) {
    let generation = Arc::new(AtomicU64::new(3));
    (
        RemoteEmbeddingProvider::new(config, transport, Generation(3), generation.clone()),
        generation,
    )
}
fn request(
    provider: &RemoteEmbeddingProvider,
    kind: EmbeddingInputKind,
    texts: &[String],
) -> EmbeddingRequest {
    EmbeddingRequest {
        identity: provider.identity().unwrap().clone(),
        kind,
        inputs: texts
            .iter()
            .enumerate()
            .map(|(index, text)| EmbeddingInput {
                source: Provenance {
                    origin: InputOrigin::Core,
                    source_id: index.to_string(),
                    source_revision: "v1".into(),
                    content_hash: ContentHash(format!("hash-{index}")),
                    generation: Generation(7),
                    observed_at_ms: 0,
                },
                text: text.clone(),
            })
            .collect(),
    }
}
fn single(provider: &RemoteEmbeddingProvider) -> EmbeddingRequest {
    request(provider, EmbeddingInputKind::Query, &["hello".into()])
}

// This fixture transport uses plaintext loopback TCP. A production HttpTransport
// must support HTTPS, refuse redirects, and abort in-flight IO when its returned
// future is dropped, as specified in the HttpTransport documentation.
struct LoopbackTransport;
impl HttpTransport for LoopbackTransport {
    fn send<'a>(
        &'a self,
        request: HttpRequest,
        _: &'a CallbackControl,
        timeout: Duration,
    ) -> HttpFuture<'a> {
        Box::pin(async move {
            assert!(timeout <= Duration::from_secs(30));
            let rest = request.url.strip_prefix("http://127.0.0.1:").unwrap();
            let (port, path) = rest.split_once('/').unwrap();
            let mut socket = TcpStream::connect(format!("127.0.0.1:{port}"))
                .await
                .unwrap();
            let mut wire = format!("{} /{} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\nContent-Length: {}\r\n", request.method, path, port, request.body.len());
            for (key, value) in request.headers {
                assert!(
                    ["content-type", "authorization"].contains(&key.as_str()),
                    "unexpected provider header: {key}"
                );
                wire.push_str(&format!("{key}: {value}\r\n"));
            }
            wire.push_str("\r\n");
            socket.write_all(wire.as_bytes()).await.unwrap();
            socket.write_all(&request.body).await.unwrap();
            let mut bytes = Vec::new();
            socket.read_to_end(&mut bytes).await.unwrap();
            let split = bytes
                .windows(4)
                .position(|bytes| bytes == b"\r\n\r\n")
                .unwrap();
            let header = std::str::from_utf8(&bytes[..split]).unwrap();
            let status = header.split_whitespace().nth(1).unwrap().parse().unwrap();
            Ok(HttpResponse {
                status,
                headers: vec![],
                body: bytes[split + 4..].to_vec(),
            })
        })
    }
}

#[tokio::test]
async fn requests_and_vectors_match_typescript_over_fake_http() {
    let mut cases: Value =
        serde_json::from_str(include_str!("../testdata/embedding_provider/cases.json")).unwrap();
    for case in cases.as_array_mut().unwrap() {
        for text in case["texts"].as_array_mut().unwrap() {
            if text == "long-ascii" {
                *text = json!("alpha beta gamma delta ".repeat(80));
            }
            if text == "long-unicode" {
                *text = json!("🌍 日本語 café e\u{301} \"quotes\" ".repeat(80));
            }
        }
    }
    let plan = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(plan.path(), serde_json::to_vec(&cases).unwrap()).unwrap();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut child = Command::new("bun")
        .arg("crates/mc-module/testdata/embedding_provider/capture.ts")
        .arg(plan.path())
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("Bun is required for the live differential fixture");
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    output.read_line(&mut line).unwrap();
    if line.is_empty() {
        let exit = child.wait_with_output().unwrap();
        panic!(
            "Bun fixture exited before handshake: {}",
            String::from_utf8_lossy(&exit.stderr)
        );
    }
    let ts: Value = serde_json::from_str(&line)
        .expect("Bun fixture must emit its loopback endpoint and results");
    let mut rust = Vec::new();
    for (index, case) in cases.as_array().unwrap().iter().enumerate() {
        let mut raw_config = case["config"].clone();
        raw_config["endpoint"] = json!(format!(
            " {}/// ",
            ts["results"][index]["endpoint"].as_str().unwrap()
        ));
        let config: OpenAiConfig = serde_json::from_value(raw_config).unwrap();
        let (provider, _) = provider(
            ResolvedEmbeddingConfig::OpenAiCompatible(config),
            Some(Arc::new(LoopbackTransport)),
        );
        assert_eq!(
            provider.identity().unwrap().fingerprint,
            ts["results"][index]["modelId"].as_str().unwrap(),
            "stored model_id case {index}"
        );
        let kind = if case["kind"] == "query" {
            EmbeddingInputKind::Query
        } else {
            EmbeddingInputKind::Passage
        };
        let texts: Vec<String> = serde_json::from_value(case["texts"].clone()).unwrap();
        let request = request(&provider, kind, &texts);
        let result = provider.embed_checked(&context(), &request).await;
        // TypeScript treats HTTP 429 as back-pressure: the query comes back with
        // no vectors and no failure class, and the endpoint enters a cooldown.
        // The Rust provider has no partial-null result, so it must return its
        // RateLimited error for exactly those cases.
        if ts["results"][index]["rateLimited"].as_bool().unwrap() {
            assert!(
                ts["results"][index]["failure"].is_null(),
                "a TypeScript rate limit is not a failure, case {index}"
            );
            assert_eq!(
                result.unwrap_err(),
                EmbeddingError::RateLimited,
                "rate limit case {index}"
            );
            rust.push(Value::Null);
            continue;
        }
        assert!(
            !matches!(result, Err(EmbeddingError::RateLimited)),
            "Rust rate limited a case TypeScript did not, case {index}"
        );
        if !ts["results"][index]["failure"].is_null() {
            let error = result.unwrap_err();
            assert_eq!(
                error.reason().code,
                ts["results"][index]["failure"].as_str().unwrap(),
                "error class case {index}"
            );
            assert_eq!(
                error.retryable(),
                ts["results"][index]["retryable"].as_bool().unwrap(),
                "retryability case {index}"
            );
            rust.push(Value::Null);
            continue;
        }
        let result = result.unwrap();
        assert_eq!(result.generation, Generation(3));
        for (input, vector) in request.inputs.iter().zip(&result.vectors) {
            assert_eq!(input.source, vector.source);
            assert_eq!(request.identity, vector.embedding);
        }
        rust.push(json!(result
            .vectors
            .into_iter()
            .map(|vector| vector.values)
            .collect::<Vec<_>>()));
    }
    child.stdin.take().unwrap().write_all(b"finish\n").unwrap();
    line.clear();
    output.read_line(&mut line).unwrap();
    let captures: Value = serde_json::from_str(&line).unwrap();
    let exit = child.wait_with_output().unwrap();
    assert!(
        exit.status.success(),
        "Bun fixture failed: {}",
        String::from_utf8_lossy(&exit.stderr)
    );
    let count = cases.as_array().unwrap().len();
    let captures = captures["requests"].as_array().unwrap();
    assert_eq!(
        captures.len(),
        count * 2,
        "Both providers must POST once per entire supplied batch"
    );
    for index in 0..count {
        assert_eq!(
            captures[index],
            captures[count + index],
            "method/path/provider headers/raw JSON body case {index}"
        );
        if rust[index].is_null() {
            assert!(ts["results"][index]["vectors"]
                .as_array()
                .unwrap()
                .iter()
                .all(Value::is_null));
            continue;
        }
        let expected: Vec<Vec<f32>> =
            serde_json::from_value(ts["results"][index]["vectors"].clone()).unwrap();
        let actual: Vec<Vec<f32>> = serde_json::from_value(rust[index].clone()).unwrap();
        assert_eq!(
            actual
                .iter()
                .flatten()
                .map(|v| v.to_bits())
                .collect::<Vec<_>>(),
            expected
                .iter()
                .flatten()
                .map(|v| v.to_bits())
                .collect::<Vec<_>>(),
            "float32 bytes (without L2 normalization) case {index}"
        );
    }
}

struct Scripted {
    response: Mutex<Option<HttpResponse>>,
    calls: AtomicUsize,
    delay: Duration,
    generation: Option<Arc<AtomicU64>>,
    transport_error: Option<EmbeddingError>,
    dropped: Arc<AtomicUsize>,
    timeout_ms: AtomicU64,
}
impl Scripted {
    fn response(status: u16, body: Value) -> Self {
        Self {
            response: Mutex::new(Some(HttpResponse {
                status,
                headers: vec![],
                body: serde_json::to_vec(&body).unwrap(),
            })),
            calls: AtomicUsize::new(0),
            delay: Duration::ZERO,
            generation: None,
            transport_error: None,
            dropped: Arc::new(AtomicUsize::new(0)),
            timeout_ms: AtomicU64::new(0),
        }
    }
}
struct DropFlag(Arc<AtomicUsize>);
impl Drop for DropFlag {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}
impl HttpTransport for Scripted {
    fn send<'a>(
        &'a self,
        _: HttpRequest,
        _: &'a CallbackControl,
        timeout: Duration,
    ) -> HttpFuture<'a> {
        Box::pin(async move {
            assert!(timeout <= Duration::from_secs(30));
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.timeout_ms
                .store(timeout.as_millis() as u64, Ordering::SeqCst);
            let _dropped = DropFlag(self.dropped.clone());
            tokio::time::sleep(self.delay).await;
            if let Some(generation) = &self.generation {
                generation.store(4, Ordering::Release);
            }
            if let Some(error) = self.transport_error {
                return Err(error);
            }
            Ok(self
                .response
                .lock()
                .unwrap()
                .take()
                .unwrap_or(HttpResponse {
                    status: 503,
                    headers: vec![],
                    body: vec![],
                }))
        })
    }
}

#[tokio::test]
async fn failures_are_typed_never_empty_success_and_not_retried() {
    let cases = [
        (503, json!({}), EmbeddingError::Http { status: 503 }),
        (429, json!({}), EmbeddingError::RateLimited),
        (400, json!({}), EmbeddingError::Http { status: 400 }),
        (307, json!({}), EmbeddingError::Http { status: 307 }),
        (200, json!({"data":[]}), EmbeddingError::EmptyResult),
        (200, json!({}), EmbeddingError::InvalidEnvelope),
        (
            200,
            json!({"model":"different", "data":[{"embedding":[1,2,3,4]}]}),
            EmbeddingError::SubstitutionRejected,
        ),
        (
            200,
            json!({"data":[{"embedding":[]}]}),
            EmbeddingError::InvalidVector,
        ),
        (
            200,
            json!({"data":[{"embedding":[1,2]}]}),
            EmbeddingError::InvalidVector,
        ),
        (
            200,
            json!({"data":[{"embedding":[1e100,2,3,4]}]}),
            EmbeddingError::InvalidVector,
        ),
        (
            200,
            json!({"data":[{"index":1,"embedding":[1,2,3,4]}]}),
            EmbeddingError::InvalidEnvelope,
        ),
    ];
    for (status, body, error) in cases {
        let transport = Arc::new(Scripted::response(status, body));
        let (provider, _) = provider(
            ResolvedEmbeddingConfig::OpenAiCompatible(config()),
            Some(transport.clone()),
        );
        assert_eq!(
            provider
                .embed_checked(&context(), &single(&provider))
                .await
                .unwrap_err(),
            error
        );
        assert_eq!(
            transport.calls.load(Ordering::SeqCst),
            1,
            "HTTP provider never retries a failed POST"
        );
        let result = provider.embed(&context(), &single(&provider)).await;
        assert!(matches!(result, CapabilityResult::Unavailable { .. }));
        assert!(serde_json::to_value(result).unwrap().get("value").is_none());
    }
}

#[tokio::test]
async fn cancellation_deadline_and_stale_completion_drop_the_post() {
    let mut scripted = Scripted::response(200, json!({"data":[{"embedding":[3,4,0,1]}]}));
    scripted.delay = Duration::from_secs(1);
    let transport = Arc::new(scripted);
    let (provider, generation) = provider(
        ResolvedEmbeddingConfig::OpenAiCompatible(config()),
        Some(transport.clone()),
    );
    let mut ctx = context();
    ctx.control.cancel();
    assert_eq!(
        provider
            .embed_checked(&ctx, &single(&provider))
            .await
            .unwrap_err(),
        EmbeddingError::Cancelled
    );
    assert_eq!(transport.calls.load(Ordering::SeqCst), 0);
    ctx.control = CallbackControl::new(chrono::Utc::now().timestamp_millis() + 20);
    assert_eq!(
        provider
            .embed_checked(&ctx, &single(&provider))
            .await
            .unwrap_err(),
        EmbeddingError::Timeout
    );
    assert_eq!(transport.dropped.load(Ordering::SeqCst), 1);
    let ctx = context();
    let cancel = ctx.control.clone();
    let cancellation = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(10)).await;
        cancel.cancel();
    });
    assert_eq!(
        provider
            .embed_checked(&ctx, &single(&provider))
            .await
            .unwrap_err(),
        EmbeddingError::Cancelled
    );
    cancellation.await.unwrap();
    assert_eq!(transport.dropped.load(Ordering::SeqCst), 2);
    assert_eq!(
        provider.availability(),
        Availability::Available,
        "caller abort/deadline never penalizes the endpoint"
    );
    generation.store(4, Ordering::Release);
    assert!(
        matches!(provider.availability(), Availability::Unavailable { reason } if reason.code == "stale_generation")
    );
    assert_eq!(
        provider
            .embed_checked(&context(), &single(&provider))
            .await
            .unwrap_err(),
        EmbeddingError::StaleGeneration
    );
}

#[tokio::test]
async fn generation_is_rechecked_after_the_response() {
    let generation = Arc::new(AtomicU64::new(3));
    let mut scripted = Scripted::response(200, json!({"data":[{"embedding":[3,4,0,1]}]}));
    scripted.generation = Some(generation.clone());
    let provider = RemoteEmbeddingProvider::new(
        ResolvedEmbeddingConfig::OpenAiCompatible(config()),
        Some(Arc::new(scripted)),
        Generation(3),
        generation,
    );
    assert_eq!(
        provider
            .embed_checked(&context(), &single(&provider))
            .await
            .unwrap_err(),
        EmbeddingError::StaleGeneration
    );
}

#[tokio::test]
async fn three_failures_open_the_circuit_without_retry() {
    let transport = Arc::new(Scripted::response(503, json!({})));
    let (provider, _) = provider(
        ResolvedEmbeddingConfig::OpenAiCompatible(config()),
        Some(transport.clone()),
    );
    for _ in 0..3 {
        assert_eq!(
            provider
                .embed_checked(&context(), &single(&provider))
                .await
                .unwrap_err(),
            EmbeddingError::Http { status: 503 }
        );
    }
    assert_eq!(
        provider
            .embed_checked(&context(), &single(&provider))
            .await
            .unwrap_err(),
        EmbeddingError::CircuitOpen
    );
    assert_eq!(transport.calls.load(Ordering::SeqCst), 3);
    assert!(
        matches!(provider.availability(), Availability::Unavailable { reason } if reason.code == "circuit_open")
    );
}

#[tokio::test]
async fn fences_reject_bad_identity_source_and_empty_input_before_io() {
    let transport = Arc::new(Scripted::response(200, json!({})));
    let (provider, _) = provider(
        ResolvedEmbeddingConfig::OpenAiCompatible(config()),
        Some(transport.clone()),
    );
    let mut req = single(&provider);
    req.identity.dimensions += 1;
    assert_eq!(
        provider.embed_checked(&context(), &req).await.unwrap_err(),
        EmbeddingError::IdentityMismatch
    );
    let mut req = single(&provider);
    req.inputs[0].source.generation = Generation(6);
    assert_eq!(
        provider.embed_checked(&context(), &req).await.unwrap_err(),
        EmbeddingError::StaleGeneration
    );
    let mut req = single(&provider);
    req.inputs.clear();
    assert_eq!(
        provider.embed_checked(&context(), &req).await.unwrap_err(),
        EmbeddingError::EmptyInput
    );
    let mut ctx = context();
    ctx.contract_version += 1;
    assert_eq!(
        provider
            .embed_checked(&ctx, &single(&provider))
            .await
            .unwrap_err(),
        EmbeddingError::ContractVersion
    );
    assert_eq!(transport.calls.load(Ordering::SeqCst), 0);
}

#[test]
fn unavailable_providers_and_metadata_endpoints_are_explicit() {
    for (config, code) in [
        (ResolvedEmbeddingConfig::Off, "embedding_off"),
        (
            ResolvedEmbeddingConfig::Local {
                model: "local".into(),
            },
            "local_unavailable",
        ),
        (
            ResolvedEmbeddingConfig::Synapse {
                identity: EmbeddingIdentity {
                    provider: "synapse".into(),
                    model: "model".into(),
                    dimensions: 4,
                    query_recipe: "query".into(),
                    passage_recipe: "passage".into(),
                    fingerprint: "certified".into(),
                    epoch: 1,
                },
            },
            "synapse_unavailable",
        ),
        (
            ResolvedEmbeddingConfig::OpenAiCompatible(config()),
            "transport_unavailable",
        ),
    ] {
        let (provider, _) = provider(config, None);
        assert!(
            matches!(provider.availability(), Availability::Unavailable { reason } if reason.code == code)
        );
    }
    for endpoint in [
        "http://169.254.169.254/v1",
        "http://0xa9fea9fe/v1",
        "http://2852039166/v1",
        "http://0251.0376.0251.0376/v1",
        "http://[::ffff:169.254.169.254]/v1",
        "http://[fe80::1]/v1",
        "http://[fd00:ec2:0:0:0:0:0:254]/v1",
        "http://metadata.google.internal/v1",
        "http://metadata.goog/v1",
        "not a URL",
        "http:///missing",
    ] {
        let mut cfg = config();
        cfg.endpoint = endpoint.into();
        let (provider, _) = provider(
            ResolvedEmbeddingConfig::OpenAiCompatible(cfg),
            Some(Arc::new(LoopbackTransport)),
        );
        assert!(
            matches!(provider.availability(), Availability::Unavailable { reason } if reason.code == "endpoint_blocked"),
            "{endpoint}"
        );
    }
}

#[test]
fn identity_has_no_secret_and_query_only_overrides_preserve_stored_model_id() {
    let mut cfg = config();
    cfg.model = "nomic-embed-text".into();
    cfg.api_key = Some("first-dummy".into());
    let (a, _) = provider(ResolvedEmbeddingConfig::OpenAiCompatible(cfg.clone()), None);
    cfg.api_key = Some("second-dummy".into());
    cfg.query_instruction = Some(QueryInstruction::Disabled(false));
    cfg.query_input_type = Some("query".into());
    let (b, _) = provider(ResolvedEmbeddingConfig::OpenAiCompatible(cfg.clone()), None);
    assert_eq!(
        a.identity().unwrap().fingerprint,
        b.identity().unwrap().fingerprint
    );
    assert_ne!(
        a.identity().unwrap().query_recipe,
        b.identity().unwrap().query_recipe
    );
    cfg.document_prefix = Some("".into());
    let (c, _) = provider(ResolvedEmbeddingConfig::OpenAiCompatible(cfg), None);
    assert_ne!(
        a.identity().unwrap().fingerprint,
        c.identity().unwrap().fingerprint
    );
    assert!(!serde_json::to_string(a.identity().unwrap())
        .unwrap()
        .contains("first-dummy"));
}

#[tokio::test]
async fn internal_timeout_is_thirty_seconds_and_penalizes_the_endpoint() {
    let mut scripted = Scripted::response(200, json!({}));
    scripted.transport_error = Some(EmbeddingError::Timeout);
    let transport = Arc::new(scripted);
    let (provider, _) = provider(
        ResolvedEmbeddingConfig::OpenAiCompatible(config()),
        Some(transport.clone()),
    );
    for _ in 0..3 {
        assert_eq!(
            provider
                .embed_checked(&context(), &single(&provider))
                .await
                .unwrap_err(),
            EmbeddingError::Timeout
        );
        assert_eq!(transport.timeout_ms.load(Ordering::SeqCst), 30_000);
    }
    assert_eq!(
        provider
            .embed_checked(&context(), &single(&provider))
            .await
            .unwrap_err(),
        EmbeddingError::CircuitOpen
    );
    assert_eq!(transport.calls.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn success_clears_the_failure_window() {
    let transport = Arc::new(Scripted::response(503, json!({})));
    let (provider, _) = provider(
        ResolvedEmbeddingConfig::OpenAiCompatible(config()),
        Some(transport.clone()),
    );
    let req = single(&provider);
    for _ in 0..2 {
        assert_eq!(
            provider.embed_checked(&context(), &req).await.unwrap_err(),
            EmbeddingError::Http { status: 503 }
        );
    }
    *transport.response.lock().unwrap() = Some(HttpResponse {
        status: 200,
        headers: vec![],
        body: serde_json::to_vec(&json!({"data":[{"embedding":[3,4,0,1]}]})).unwrap(),
    });
    assert!(provider.embed_checked(&context(), &req).await.is_ok());
    for _ in 0..2 {
        assert_eq!(
            provider.embed_checked(&context(), &req).await.unwrap_err(),
            EmbeddingError::Http { status: 503 }
        );
    }
    assert_eq!(provider.availability(), Availability::Available);
}

#[tokio::test]
async fn missing_slots_reject_partial_success() {
    let transport = Arc::new(Scripted::response(
        200,
        json!({"data":[{"index":0,"embedding":[3,4,0,1]}]}),
    ));
    let (provider, _) = provider(
        ResolvedEmbeddingConfig::OpenAiCompatible(config()),
        Some(transport),
    );
    let req = request(
        &provider,
        EmbeddingInputKind::Passage,
        &["one".into(), "two".into()],
    );
    assert_eq!(
        provider.embed_checked(&context(), &req).await.unwrap_err(),
        EmbeddingError::InvalidEnvelope
    );
    assert!(matches!(
        provider.embed(&context(), &req).await,
        CapabilityResult::Unavailable { .. }
    ));
}

/// One scripted reply: status, headers and JSON body.
type Reply = (u16, Vec<(String, String)>, Value);

/// Answers each POST with the next scripted response, then 503 once exhausted.
struct Sequence {
    responses: Mutex<std::collections::VecDeque<HttpResponse>>,
    calls: AtomicUsize,
}
impl Sequence {
    fn new(responses: Vec<Reply>) -> Self {
        Self {
            responses: Mutex::new(
                responses
                    .into_iter()
                    .map(|(status, headers, body)| HttpResponse {
                        status,
                        headers,
                        body: serde_json::to_vec(&body).unwrap(),
                    })
                    .collect(),
            ),
            calls: AtomicUsize::new(0),
        }
    }
}
impl HttpTransport for Sequence {
    fn send<'a>(&'a self, _: HttpRequest, _: &'a CallbackControl, _: Duration) -> HttpFuture<'a> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(self
                .responses
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(HttpResponse {
                    status: 503,
                    headers: vec![],
                    body: vec![],
                }))
        })
    }
}
fn retry_after(value: &str) -> Vec<(String, String)> {
    vec![("Retry-After".into(), value.into())]
}

#[tokio::test]
async fn query_rate_limit_is_back_pressure_not_a_circuit_failure() {
    let transport = Arc::new(Sequence::new(vec![
        (429, retry_after("0.05"), json!({})),
        (429, retry_after("0.05"), json!({})),
        (429, retry_after("0.05"), json!({})),
        (200, vec![], json!({"data":[{"embedding":[3,4,0,1]}]})),
    ]));
    let (provider, _) = provider(
        ResolvedEmbeddingConfig::OpenAiCompatible(config()),
        Some(transport.clone()),
    );
    let req = single(&provider);
    let error = provider.embed_checked(&context(), &req).await.unwrap_err();
    assert_eq!(error, EmbeddingError::RateLimited);
    assert_eq!(error.reason().code, "rate_limited");
    assert!(error.retryable());
    assert_eq!(
        provider.embed_checked(&context(), &req).await.unwrap_err(),
        EmbeddingError::RateLimited
    );
    assert_eq!(
        transport.calls.load(Ordering::SeqCst),
        1,
        "a query during the cooldown sends nothing"
    );
    for _ in 0..2 {
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert_eq!(
            provider.embed_checked(&context(), &req).await.unwrap_err(),
            EmbeddingError::RateLimited
        );
    }
    assert_eq!(
        provider.availability(),
        Availability::Available,
        "three 429s in a row never open the circuit"
    );
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert!(provider.embed_checked(&context(), &req).await.is_ok());
    assert_eq!(transport.calls.load(Ordering::SeqCst), 4);
}

#[tokio::test]
async fn passage_rate_limit_waits_out_the_cooldown_and_resends() {
    let transport = Arc::new(Sequence::new(vec![
        (429, retry_after("0.05"), json!({})),
        (429, retry_after("0.05"), json!({})),
        (200, vec![], json!({"data":[{"embedding":[3,4,0,1]}]})),
    ]));
    let (provider, _) = provider(
        ResolvedEmbeddingConfig::OpenAiCompatible(config()),
        Some(transport.clone()),
    );
    let req = request(&provider, EmbeddingInputKind::Passage, &["stored".into()]);
    let started = std::time::Instant::now();
    let result = provider.embed_checked(&context(), &req).await.unwrap();
    assert_eq!(result.vectors.len(), 1);
    assert_eq!(transport.calls.load(Ordering::SeqCst), 3);
    assert!(
        started.elapsed() >= Duration::from_millis(100),
        "each resend waited for its Retry-After"
    );
}

#[tokio::test]
async fn passage_cooldown_wait_ends_on_cancellation_and_deadline() {
    let transport = Arc::new(Sequence::new(vec![(429, retry_after("30"), json!({}))]));
    let (provider, _) = provider(
        ResolvedEmbeddingConfig::OpenAiCompatible(config()),
        Some(transport.clone()),
    );
    let req = request(&provider, EmbeddingInputKind::Passage, &["stored".into()]);
    let ctx = context();
    let cancel = ctx.control.clone();
    let cancellation = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        cancel.cancel();
    });
    assert_eq!(
        provider.embed_checked(&ctx, &req).await.unwrap_err(),
        EmbeddingError::Cancelled
    );
    cancellation.await.unwrap();
    let mut ctx = context();
    ctx.control = CallbackControl::new(chrono::Utc::now().timestamp_millis() + 50);
    assert_eq!(
        provider.embed_checked(&ctx, &req).await.unwrap_err(),
        EmbeddingError::Timeout
    );
    assert_eq!(
        transport.calls.load(Ordering::SeqCst),
        1,
        "nothing is resent while the cooldown runs"
    );
}
