//! The bus link's renewal, backoff and expiry rules, on tokio's paused clock
//! and an in-memory bus. `live_tests` runs the same link against nats-server.
use super::*;
use cortexkit_bus_inmemory::{InMemoryBus, InMemoryConfig};
use std::collections::VecDeque;

const MODULE: &str = "ckmc-fixture";

fn health_handler() -> (McHandler, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = McStore::open_for_test(&dev_descriptor_at(dir.path().to_str().unwrap())).unwrap();
    let handler = McHandler::new();
    handler.store.set(Arc::new(store)).ok().unwrap();
    (handler, dir)
}

async fn assert_bus_health(handler: &McHandler, expected: Value) {
    let report = <McHandler as ModuleHandler>::health(handler).await;
    assert_eq!(
        report.metrics.unwrap().get("async_bus"),
        Some(&expected),
        "SDK health"
    );
    for method in ["health", "status", "diagnostics"] {
        for session_id in [None, Some("health-session")] {
            let mut request = json!({"method": method});
            if let Some(session_id) = session_id {
                request["session_id"] = json!(session_id);
            }
            let outcome = handler.dispatch_value(7, request).await;
            let HandlerOutcome::Response(bytes) = outcome else {
                panic!("expected {method} response, got {outcome:?}");
            };
            let answer: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(answer.get("async_bus"), Some(&expected), "{method}");
        }
    }
}

#[tokio::test]
async fn health_reports_attaching_then_connected_as_the_bus_link_changes() {
    let (handler, _dir) = health_handler();
    let runtime = &handler.provider_store.async_runtime;
    *runtime.connection_file.lock().unwrap() = Some(PathBuf::from("unused-test-connection"));

    runtime
        .bus_link
        .set(LinkState::Attaching, 3, Some("connection refused".into()));
    assert_bus_health(
        &handler,
        json!({"state": "attaching", "attempts": 3, "last_error": "connection refused"}),
    )
    .await;

    runtime.bus_link.set(LinkState::Connected, 0, None);
    assert_bus_health(
        &handler,
        json!({"state": "connected", "attempts": 0, "last_error": null}),
    )
    .await;
}

#[tokio::test]
async fn health_reports_null_without_a_bus_runtime() {
    let (handler, _dir) = health_handler();
    assert_bus_health(&handler, Value::Null).await;
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

/// A ck-bus double. Renewals answer from `renewals` in order, then with
/// `fallback`; every op is recorded with the paused clock's time.
struct FakeIssuer {
    renewals: Mutex<VecDeque<Result<Value, IssuerError>>>,
    fallback: Box<dyn Fn(usize) -> Result<Value, IssuerError> + Send + Sync>,
    calls: Mutex<Vec<(String, Value, Clock)>>,
}

impl FakeIssuer {
    fn new(fallback: impl Fn(usize) -> Result<Value, IssuerError> + Send + Sync + 'static) -> Self {
        Self {
            renewals: Mutex::new(VecDeque::new()),
            fallback: Box::new(fallback),
            calls: Mutex::new(Vec::new()),
        }
    }
    /// Renews every time, for another `lifetime_s` from now.
    fn renewing(lifetime_s: i64) -> Self {
        Self::new(move |n| {
            Ok(
                json!({"jwt":format!("renewed-{n}"),"exp":unix_now() + lifetime_s,"credential_public":"UKEY"}),
            )
        })
    }
    fn calls(&self, method: &str) -> Vec<(Value, Clock)> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(m, ..)| m == method)
            .map(|(_, params, at)| (params.clone(), *at))
            .collect()
    }
}

#[async_trait]
impl Issuer for FakeIssuer {
    async fn op(&self, method: &str, params: Value) -> Result<Value, IssuerError> {
        let n = {
            let mut calls = self.calls.lock().unwrap();
            calls.push((method.to_string(), params.clone(), Clock::now()));
            calls.iter().filter(|(m, ..)| m == method).count()
        };
        // A loop calling ck-bus without waiting keeps the paused clock from
        // ever advancing; stop it here so the test fails instead of hanging.
        assert!(
            n <= 200,
            "{n} {method} calls without the clock moving: a tight loop"
        );
        match method {
            NONCE_SIGN_OP => Ok(json!({"signature_b64":STANDARD.encode(b"signed")})),
            CREDENTIAL_RENEW_OP => {
                let scripted = self.renewals.lock().unwrap().pop_front();
                scripted.unwrap_or_else(|| (self.fallback)(n))
            }
            other => panic!("unexpected op {other}"),
        }
    }
}

fn unreachable_issuer() -> FakeIssuer {
    FakeIssuer::new(|n| {
        // A loop that renews without waiting would reach this many attempts
        // within one instant of the paused clock; end it so the test fails
        // on the attempt count instead of hanging.
        if n >= 50 {
            return Err(IssuerError::Refused {
                code: "ckbus_credential_revoked".into(),
                message: "tight loop guard".into(),
            });
        }
        Err(IssuerError::Unreachable("route closed".into()))
    })
}

/// Captures this thread's log lines, which on a current-thread runtime
/// include every task the test spawns.
struct Logs(Arc<Mutex<Vec<u8>>>);
impl std::io::Write for Logs {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn capture_logs() -> (Arc<Mutex<Vec<u8>>>, tracing::subscriber::DefaultGuard) {
    let logs = Arc::new(Mutex::new(Vec::new()));
    let writer = logs.clone();
    let guard = tracing::subscriber::set_default(
        tracing_subscriber::fmt()
            .without_time()
            .with_ansi(false)
            .with_writer(move || Logs(writer.clone()))
            .finish(),
    );
    (logs, guard)
}
fn lines_with(logs: &Mutex<Vec<u8>>, needle: &str) -> usize {
    String::from_utf8_lossy(&logs.lock().unwrap())
        .lines()
        .filter(|line| line.contains(needle))
        .count()
}

async fn advance_to(start: Clock, at: Duration) {
    tokio::time::sleep_until(start + at).await;
    // Let woken tasks run their step before the test looks.
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_short_lived_credential_is_renewed_at_seventy_percent_of_its_lifetime() {
    let start = Clock::now();
    let issuer = Arc::new(FakeIssuer::renewing(100));
    let credential = Arc::new(HeldCredential::new(
        "UKEY".into(),
        "issued".into(),
        unix_now() + 100,
    ));
    let status = Arc::new(LinkStatus::default());
    let renewal = tokio::spawn(renew_until_retired(
        credential.clone(),
        issuer.clone(),
        status.clone(),
    ));

    advance_to(start, Duration::from_secs(68)).await;
    assert!(
        issuer.calls(CREDENTIAL_RENEW_OP).is_empty(),
        "renewed too early"
    );
    assert_eq!(credential.jwt(), "issued");

    advance_to(start, Duration::from_secs(71)).await;
    let renewals = issuer.calls(CREDENTIAL_RENEW_OP);
    assert_eq!(renewals.len(), 1, "one renewal by 70% of the lifetime");
    assert_eq!(renewals[0].0, json!({"credential_public":"UKEY"}));
    assert_eq!(
        credential.jwt(),
        "renewed-1",
        "the next connect presents the renewed JWT"
    );
    assert_eq!(status.state(), LinkState::Connected);

    // Past the first JWT's `exp`, the renewed one is still valid, and the
    // next renewal falls at 70% of the renewed lifetime.
    advance_to(start, Duration::from_secs(105)).await;
    assert!(
        !credential.is_expired(),
        "the renewed JWT outlives the first exp"
    );
    assert!(credential.retired().is_none());
    advance_to(start, Duration::from_secs(142)).await;
    assert_eq!(issuer.calls(CREDENTIAL_RENEW_OP).len(), 2);
    assert_eq!(credential.jwt(), "renewed-2");
    renewal.abort();
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn failed_renewals_back_off_with_one_log_line_each_then_retire_at_expiry() {
    let (logs, _guard) = capture_logs();
    let start = Clock::now();
    let issuer = Arc::new(unreachable_issuer());
    let credential = Arc::new(HeldCredential::new(
        "UKEY".into(),
        "issued".into(),
        unix_now() + 100,
    ));
    let status = Arc::new(LinkStatus::default());
    let renewal = tokio::spawn(renew_until_retired(
        credential.clone(),
        issuer.clone(),
        status.clone(),
    ));

    advance_to(start, Duration::from_secs(80)).await;
    assert_eq!(status.state(), LinkState::Renewing);
    assert!(
        status.describe().starts_with("renewing for "),
        "{}",
        status.describe()
    );
    advance_to(start, Duration::from_secs(101)).await;
    assert!(
        renewal.is_finished(),
        "a credential that expired unrenewed stops renewing"
    );

    let at: Vec<Duration> = issuer
        .calls(CREDENTIAL_RENEW_OP)
        .iter()
        .map(|(_, at)| *at - start)
        .collect();
    // Renewal starts at ~70 s, retries after 1, 2, 4 and 8 s, then once more
    // at `exp` (~100 s), where the 16 s backoff is cut short.
    assert_eq!(at.len(), 6, "attempts at {at:?}");
    let gaps: Vec<Duration> = at.windows(2).map(|w| w[1] - w[0]).collect();
    for (gap, expected) in gaps.iter().zip([1, 2, 4, 8]) {
        assert_eq!(*gap, Duration::from_secs(expected), "gaps {gaps:?}");
    }
    assert!(
        at[5] >= Duration::from_secs(99),
        "the last attempt falls at exp: {at:?}"
    );

    assert_eq!(lines_with(&logs, "bus credential renewal failed"), 5);
    assert_eq!(
        lines_with(&logs, "bus credential expired before renewal succeeded"),
        1
    );
    assert_eq!(status.state(), LinkState::CredentialExpired);
    let reason = credential.retired().expect("retired at expiry");
    assert!(reason.contains("expired before renewal"), "{reason}");
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_renewal_refused_by_name_retires_the_link_at_a_delivery_boundary() {
    let start = Clock::now();
    let issuer = Arc::new(FakeIssuer::new(|_| {
        Err(IssuerError::Refused {
            code: "ckbus_credential_superseded".into(),
            message: "UKEY is not the current credential".into(),
        })
    }));
    let credential = Arc::new(HeldCredential::new(
        "UKEY".into(),
        "issued".into(),
        unix_now() + 100,
    ));
    let bus = InMemoryBus::new(
        InMemoryConfig::default()
            .with_durable(DurableOwner::Module(MODULE))
            .with_stream_ack_wait(Duration::from_secs(600)),
    );
    for id in ["n1", "n2"] {
        let _receipt = bus
            .publish(
                "ev.x",
                id,
                ContentDigest::of_bytes(id.as_bytes()),
                Headers::new(),
            )
            .await
            .unwrap();
    }
    let stream = LinkStream::new(bus, credential.clone());
    let mut cursor = stream.consumer(DurableOwner::Module(MODULE)).await.unwrap();
    let first = cursor.next().await.unwrap().expect("n1 delivered");
    assert_eq!(first.message.id, "n1");

    let status = Arc::new(LinkStatus::default());
    let renewal = tokio::spawn(renew_until_retired(
        credential.clone(),
        issuer.clone(),
        status.clone(),
    ));
    advance_to(start, Duration::from_secs(75)).await;
    assert!(renewal.is_finished());
    assert_eq!(
        issuer.calls(CREDENTIAL_RENEW_OP).len(),
        1,
        "a named refusal is not retried"
    );
    assert_eq!(status.state(), LinkState::Reissuing);

    // The delivery in flight still settles; only the next pull stops.
    cursor.ack().await.unwrap();
    let error = cursor.next().await.expect_err("the reader stops");
    assert!(
        error.to_string().contains("ckbus_credential_superseded"),
        "{error}"
    );
    assert!(stream
        .publish("ev.x", "n3", ContentDigest::of_bytes(b"n3"), Headers::new())
        .await
        .is_err());
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn an_expired_credential_is_never_signed_and_its_reader_does_not_pull() {
    let issuer = FakeIssuer::renewing(100);
    let live = HeldCredential::new("UKEY".into(), "issued".into(), unix_now() + 100);
    let auth = live.auth(&issuer, b"nonce").await.unwrap();
    assert_eq!(auth.jwt.as_deref(), Some("issued"));
    assert_eq!(auth.signature.as_deref(), Some(&b"signed"[..]));
    assert_eq!(
        issuer.calls(NONCE_SIGN_OP)[0].0,
        json!({"nonce_b64":STANDARD.encode(b"nonce"),"credential_public":"UKEY"})
    );

    let expired = Arc::new(HeldCredential::new(
        "UKEY".into(),
        "stale".into(),
        unix_now() - 1,
    ));
    let error = expired
        .auth(&issuer, b"nonce")
        .await
        .err()
        .expect("refused");
    assert!(error.contains("expired"), "{error}");
    assert_eq!(
        issuer.calls(NONCE_SIGN_OP).len(),
        1,
        "no signature for an expired JWT"
    );

    let bus =
        InMemoryBus::new(InMemoryConfig::default().with_durable(DurableOwner::Module(MODULE)));
    let _receipt = bus
        .publish("ev.x", "n1", ContentDigest::of_bytes(b"n1"), Headers::new())
        .await
        .unwrap();
    let stream = LinkStream::new(bus, expired.clone());
    let mut cursor = stream.consumer(DurableOwner::Module(MODULE)).await.unwrap();
    assert!(
        cursor.next().await.unwrap().is_none(),
        "no pull while expired"
    );
    expired.replace("renewed".into(), unix_now() + 100);
    let delivery = cursor.next().await.unwrap().expect("pulled once renewed");
    assert_eq!(delivery.message.id, "n1");
}

#[test]
fn reconnect_attempts_are_spaced_and_bounded() {
    assert_eq!(
        reconnect_delay(1),
        Duration::ZERO,
        "the reconnect forced at exp is immediate"
    );
    let delays: Vec<Duration> = (2..=RECONNECT_ATTEMPTS).map(reconnect_delay).collect();
    assert!(delays
        .iter()
        .all(|d| *d >= RECONNECT_FLOOR && *d <= RECONNECT_MAX));
    assert!(delays.windows(2).all(|w| w[0] <= w[1]));
    // Within ten seconds of losing the connection, at most a handful of attempts.
    let mut elapsed = Duration::ZERO;
    let attempts = (1..)
        .take_while(|attempt| {
            elapsed += reconnect_delay(*attempt);
            elapsed <= Duration::from_secs(10)
        })
        .count();
    assert!(attempts <= 8, "{attempts} attempts in 10 s");
    let total: Duration = delays.iter().sum();
    assert!(
        total >= Duration::from_secs(240),
        "the client gives up only after {total:?}"
    );
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn bootstrap_failures_back_off_and_name_ckbus_unreachable() {
    let (logs, _guard) = capture_logs();
    let start = Clock::now();
    let status = Arc::new(LinkStatus::default());
    let calls = Arc::new(Mutex::new(Vec::new()));
    let seen = calls.clone();
    let supervisor = tokio::spawn(supervise(status.clone(), move || {
        seen.lock().unwrap().push(Clock::now());
        async { Err::<Duration, _>("ck-bus unreachable: route closed".to_string()) }
    }));
    advance_to(start, Duration::from_secs(120)).await;
    supervisor.abort();

    let at: Vec<u64> = calls
        .lock()
        .unwrap()
        .iter()
        .map(|at| (*at - start).as_secs())
        .collect();
    // 1, 2, 4, 8, 16, then 30 s apart.
    assert_eq!(at, vec![0, 1, 3, 7, 15, 31, 61, 91]);
    assert_eq!(
        lines_with(&logs, "async compaction bus link down"),
        at.len()
    );
    assert_eq!(status.state(), LinkState::CkbusUnreachable);
    let described = status.describe();
    assert!(
        described.starts_with("ckbus_unreachable for ") && described.contains("after 8 attempts"),
        "{described}"
    );
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_link_that_served_long_enough_starts_the_backoff_over() {
    let start = Clock::now();
    let status = Arc::new(LinkStatus::default());
    let calls = Arc::new(Mutex::new(Vec::new()));
    let seen = calls.clone();
    let supervisor = tokio::spawn(supervise(status.clone(), move || {
        let n = {
            let mut seen = seen.lock().unwrap();
            seen.push(Clock::now());
            seen.len()
        };
        async move {
            match n {
                1..=3 => Err("ck-bus unreachable".to_string()),
                4 => {
                    tokio::time::sleep(STABLE_LINK).await;
                    Ok(STABLE_LINK)
                }
                _ => Err("ck-bus unreachable".to_string()),
            }
        }
    }));
    advance_to(start, Duration::from_secs(80)).await;
    supervisor.abort();
    let at: Vec<u64> = calls
        .lock()
        .unwrap()
        .iter()
        .map(|at| (*at - start).as_secs())
        .collect();
    // Fails at 0, 1, 3; serves from 7 to 67; retried 1 s later, then 2 s.
    assert_eq!(at, vec![0, 1, 3, 7, 68, 70, 74]);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_renewal_that_does_not_extend_exp_backs_off_like_a_failure() {
    let start = Clock::now();
    let exp = unix_now() + 100;
    // The same expiry instant as the held JWT. The paused clock moves while
    // the wall clock does not, so "the same instant" is `exp` less the
    // paused time elapsed.
    let issuer = Arc::new(FakeIssuer::new(move |n| {
        let same = exp - (Clock::now() - start).as_secs_f64().ceil() as i64;
        Ok(json!({"jwt":format!("same-exp-{n}"),"exp":same,"credential_public":"UKEY"}))
    }));
    let credential = Arc::new(HeldCredential::new("UKEY".into(), "issued".into(), exp));
    let status = Arc::new(LinkStatus::default());
    let renewal = tokio::spawn(renew_until_retired(
        credential.clone(),
        issuer.clone(),
        status.clone(),
    ));
    advance_to(start, Duration::from_secs(101)).await;
    assert!(renewal.is_finished());
    assert_eq!(
        issuer.calls(CREDENTIAL_RENEW_OP).len(),
        6,
        "backed off, not retried at once"
    );
    assert_eq!(
        credential.jwt(),
        "issued",
        "a non-extending JWT is not adopted"
    );
    assert_eq!(status.state(), LinkState::CredentialExpired);
}
