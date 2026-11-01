//! Modules authenticate to the bus through ck-bus; the signing seed never
//! leaves the issuer. Reconnects obtain a fresh credential, not a local fallback.
//!
//! Credential lifetime: every user JWT ck-bus signs carries `exp` 15 minutes
//! after issue (ck-bus requirement R16, `ck-bus-module.md`). ck-mc renews it
//! through `ckbus.credential_renew {credential_public}`, which re-signs the same
//! key with a fresh `exp`, once 70% of the remaining lifetime has passed. The
//! renewed JWT is handed to the connection's auth callback. nats-server ends the
//! connection at the old JWT's `exp` ("User Authentication Expired"), async-nats
//! reconnects at once, and that reconnect presents the renewed JWT. The key, the
//! inbox prefix and the durable consumer all stay the same, so the notice reader
//! keeps its cursor and the durable keeps every unacknowledged notice.
//!
//! An expired JWT is never presented: the auth callback refuses locally, and
//! reconnect attempts are spaced by [`reconnect_delay`]. A renewal ck-bus
//! refuses by name, or one still failing when the JWT expires, retires the
//! link: the reader stops at a delivery boundary and the bootstrap loop fetches
//! a fresh credential with backoff, reporting a named [`LinkState`].
use super::*;
use crate::route_targets::{RegisteredRoute, RouteTargetConfig};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use cortexkit_bus_trait::{
    BusError, BusResult, ContentDigest, DurableOwner, Headers, PublishReceipt, Stream,
    StreamCursor, StreamDelivery,
};
use subc_client_rs::{CallError, CallOptions, ConsumerIdentity, ConsumerOptions, SubcConsumer};
use subc_protocol::BindIdentity;
use tokio::sync::watch;
use tokio::time::Instant as Clock;

#[cfg(test)]
mod live_tests;
#[cfg(test)]
mod tests;

/// ck-bus's op that issues a new key (and supersedes the module's previous one).
const CREDENTIAL_OP: &str = "ckbus.credential";
/// ck-bus's op that re-signs the held key with a fresh `exp`.
const CREDENTIAL_RENEW_OP: &str = "ckbus.credential_renew";
/// ck-bus's op that signs a nats-server connect nonce with the held key.
const NONCE_SIGN_OP: &str = "ckbus.nonce_sign";
/// ck-bus refusals that mean the held key can never be renewed again, so only
/// a fresh `ckbus.credential` helps.
const RENEWAL_DEAD_ENDS: [&str; 3] = [
    "ckbus_credential_superseded",
    "ckbus_credential_revoked",
    "ckbus_generation_not_live",
];

/// Renew once this share (in tenths) of the JWT's remaining lifetime has passed.
const RENEW_AFTER_TENTHS: u32 = 7;
/// A renewal must move expiry at least this far forward to count. ck-bus's
/// renewals move it by minutes; `exp` itself is in whole seconds.
const RENEWAL_MIN_EXTENSION: Duration = Duration::from_millis(500);
/// Backoff between failed renewal attempts.
const RENEW_RETRY_FIRST: Duration = Duration::from_secs(1);
const RENEW_RETRY_MAX: Duration = Duration::from_secs(30);
/// Backoff between failed bootstrap attempts (credential fetch or connect).
const BOOTSTRAP_RETRY_FIRST: Duration = Duration::from_secs(1);
const BOOTSTRAP_RETRY_MAX: Duration = Duration::from_secs(30);
/// A link that served at least this long before failing starts the bootstrap
/// backoff over; one that failed sooner keeps backing off.
const STABLE_LINK: Duration = Duration::from_secs(60);
/// Spacing of nats-server reconnect attempts after the first. The first is
/// immediate: nats-server disconnects a client when its JWT reaches its `exp`
/// (expiry) claim, and the reconnect that follows a renewal should cost nothing.
const RECONNECT_FLOOR: Duration = Duration::from_millis(250);
const RECONNECT_MAX: Duration = Duration::from_secs(5);
/// Reconnect attempts before the client gives up and the reader fails over
/// to a fresh bootstrap: about five minutes at [`RECONNECT_MAX`].
const RECONNECT_ATTEMPTS: usize = 60;
/// How long the reader waits for a renewal before reporting an empty pull
/// while its credential is expired.
const EXPIRED_WAIT: Duration = Duration::from_secs(1);

/// Delay before nats-server reconnect attempt `attempt` (counted from 1 and
/// reset by every successful connect). The library default retries within
/// milliseconds; with an unusable credential that is a tight loop.
pub(crate) fn reconnect_delay(attempt: usize) -> Duration {
    if attempt <= 1 {
        return Duration::ZERO;
    }
    let doublings = u32::try_from(attempt - 2).unwrap_or(u32::MAX).min(16);
    RECONNECT_FLOOR
        .saturating_mul(1 << doublings)
        .min(RECONNECT_MAX)
}

/// A ck-bus op that produced no answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum IssuerError {
    /// ck-bus answered with a named refusal (its Error frame code).
    Refused { code: String, message: String },
    /// ck-bus could not be reached, or its answer could not be read.
    Unreachable(String),
}

impl std::fmt::Display for IssuerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Refused { code, message } => write!(f, "{code}: {message}"),
            Self::Unreachable(reason) => write!(f, "ck-bus unreachable: {reason}"),
        }
    }
}

/// ck-bus's issuance ops as ck-mc calls them: the subc route in production,
/// a fake in tests.
#[async_trait]
pub(crate) trait Issuer: Send + Sync + 'static {
    async fn op(&self, method: &str, params: Value) -> Result<Value, IssuerError>;
}

struct SubcIssuer {
    consumer: SubcConsumer,
    identity: ConsumerIdentity,
}

impl SubcIssuer {
    async fn connect(connection: PathBuf) -> Result<Self, String> {
        let identity = ConsumerIdentity {
            module_id: std::env::var("SUBC_MODULE_ID").map_err(|e| e.to_string())?,
            launch_nonce: subc_client_rs::launch_nonce()
                .map_err(|e| e.to_string())?
                .ok_or("module launch identity unavailable")?
                .value()
                .to_string(),
        };
        let consumer = SubcConsumer::connect(&connection, ConsumerOptions::default())
            .await
            .map_err(|e| e.to_string())?;
        Ok(Self { consumer, identity })
    }
}

#[async_trait]
impl Issuer for SubcIssuer {
    async fn op(&self, method: &str, params: Value) -> Result<Value, IssuerError> {
        let body = serde_json::to_vec(&json!({"method":method,"params":params}))
            .map_err(|e| IssuerError::Unreachable(e.to_string()))?;
        let bytes = self
            .consumer
            .call(
                RouteTargetConfig::default()
                    .target(RegisteredRoute::CompactionBus)
                    .expect("compaction bus route is registered"),
                BindIdentity::new("runner", "async-compaction-bus"),
                body,
                CallOptions {
                    timeout: Duration::from_secs(5),
                    consumer_identity: Some(self.identity.clone()),
                    ..Default::default()
                },
            )
            .await
            .map_err(|error| match error {
                CallError::Module(body) => IssuerError::Refused {
                    code: body.code,
                    message: body.message,
                },
                other => IssuerError::Unreachable(other.to_string()),
            })?;
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|e| IssuerError::Unreachable(e.to_string()))?;
        Ok(value.get("result").cloned().unwrap_or(value))
    }
}

/// The `exp` of a credential answer, in seconds since the Unix epoch: the
/// answer's own `exp` member, or the JWT's `exp` claim when an older ck-bus
/// omits the member.
fn answer_exp(answer: &Value) -> Result<i64, String> {
    if let Some(exp) = answer["exp"].as_i64() {
        return Ok(exp);
    }
    let jwt = answer["jwt"].as_str().ok_or("credential missing jwt")?;
    let claims = jwt
        .split('.')
        .nth(1)
        .ok_or("credential jwt has no claims segment")?;
    let claims = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(claims.trim_end_matches('='))
        .map_err(|e| format!("credential jwt claims: {e}"))?;
    serde_json::from_slice::<Value>(&claims).map_err(|e| format!("credential jwt claims: {e}"))?
        ["exp"]
        .as_i64()
        .ok_or_else(|| "credential carries no exp".to_string())
}

/// How long until `exp` (seconds since the Unix epoch), on the tokio clock.
fn deadline(exp: i64) -> Clock {
    let exp = std::time::UNIX_EPOCH + Duration::from_secs(u64::try_from(exp).unwrap_or(0));
    Clock::now()
        + exp
            .duration_since(std::time::SystemTime::now())
            .unwrap_or_default()
}

struct Presented {
    jwt: String,
    expires: Clock,
    renew_at: Clock,
}

impl Presented {
    fn new(jwt: String, exp: i64) -> Self {
        let now = Clock::now();
        let expires = deadline(exp);
        let renew_at = now + expires.saturating_duration_since(now) * RENEW_AFTER_TENTHS / 10;
        Self {
            jwt,
            expires,
            renew_at,
        }
    }
}

/// The credential a connection presents: one key for its whole life, and the
/// JWT renewal last handed over. Every connect, reconnects included, reads it.
pub(crate) struct HeldCredential {
    public: String,
    presented: Mutex<Presented>,
    retired: Mutex<Option<String>>,
    changed: Notify,
    /// Connect attempts that asked for auth, so tests can bound the reconnect rate.
    #[cfg(test)]
    auth_attempts: std::sync::atomic::AtomicUsize,
}

impl HeldCredential {
    pub(crate) fn new(public: String, jwt: String, exp: i64) -> Self {
        Self {
            public,
            presented: Mutex::new(Presented::new(jwt, exp)),
            retired: Mutex::new(None),
            changed: Notify::new(),
            #[cfg(test)]
            auth_attempts: Default::default(),
        }
    }

    pub(crate) fn public(&self) -> &str {
        &self.public
    }

    pub(crate) fn jwt(&self) -> String {
        self.presented.lock().expect("held credential").jwt.clone()
    }

    fn renew_at(&self) -> Clock {
        self.presented.lock().expect("held credential").renew_at
    }

    fn expires(&self) -> Clock {
        self.presented.lock().expect("held credential").expires
    }

    pub(crate) fn is_expired(&self) -> bool {
        Clock::now() >= self.expires()
    }

    fn replace(&self, jwt: String, exp: i64) {
        *self.presented.lock().expect("held credential") = Presented::new(jwt, exp);
        self.changed.notify_waiters();
    }

    /// Stops this credential for good: the reader ends at its next delivery
    /// boundary and the bootstrap loop fetches a fresh credential.
    pub(crate) fn retire(&self, reason: String) {
        self.retired
            .lock()
            .expect("held credential")
            .get_or_insert(reason);
        self.changed.notify_waiters();
    }

    pub(crate) fn retired(&self) -> Option<String> {
        self.retired.lock().expect("held credential").clone()
    }

    /// The auth for one connect: the current JWT and the nonce signed by
    /// ck-bus. Refused locally, without asking ck-bus to sign, once the JWT
    /// has expired or the credential is retired, since nats-server would
    /// refuse it anyway.
    pub(crate) async fn auth(
        &self,
        issuer: &dyn Issuer,
        nonce: &[u8],
    ) -> Result<async_nats::Auth, String> {
        #[cfg(test)]
        self.auth_attempts
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if let Some(reason) = self.retired() {
            return Err(format!("bus credential retired: {reason}"));
        }
        if self.is_expired() {
            return Err("bus credential expired; waiting for its renewal".into());
        }
        let jwt = self.jwt();
        let answer = issuer
            .op(
                NONCE_SIGN_OP,
                json!({"nonce_b64":STANDARD.encode(nonce),"credential_public":self.public}),
            )
            .await
            .map_err(|e| e.to_string())?;
        let signature = STANDARD
            .decode(
                answer["signature_b64"]
                    .as_str()
                    .ok_or("signature missing")?,
            )
            .map_err(|e| e.to_string())?;
        let mut auth = async_nats::Auth::new();
        auth.jwt = Some(jwt);
        auth.signature = Some(signature);
        Ok(auth)
    }

    /// Waits until the JWT is replaced or the credential retired, or `limit`.
    async fn changed_within(&self, limit: Duration) {
        let _ = tokio::time::timeout(limit, self.changed.notified()).await;
    }
}

/// What the bus link is doing, named so a log line or a refusal can say it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LinkState {
    /// No bootstrap has finished yet.
    Starting,
    /// Fetching a credential, connecting, or attaching the durable reader.
    Attaching,
    /// Connected, with a credential not yet due for renewal or renewed in time.
    Connected,
    /// Due for renewal, and renewal attempts are failing; the connection still
    /// runs on its current JWT.
    Renewing,
    /// The JWT expired before a renewal succeeded; the link is being replaced.
    CredentialExpired,
    /// ck-bus refused renewal by name; the link is being replaced.
    Reissuing,
    /// A bootstrap (credential fetch or nats-server connect) failed.
    CkbusUnreachable,
}

impl LinkState {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Attaching => "attaching",
            Self::Connected => "connected",
            Self::Renewing => "renewing",
            Self::CredentialExpired => "credential_expired",
            Self::Reissuing => "reissuing",
            Self::CkbusUnreachable => "ckbus_unreachable",
        }
    }
}

struct LinkReport {
    state: LinkState,
    since: Clock,
    attempts: u32,
    last_error: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct LinkSnapshot {
    state: &'static str,
    attempts: u32,
    last_error: Option<String>,
}

/// The bus link's current [`LinkState`], how long it has held, how many
/// attempts it has seen, and the last error.
pub(crate) struct LinkStatus {
    report: Mutex<LinkReport>,
    changed: watch::Sender<LinkState>,
}

impl Default for LinkStatus {
    fn default() -> Self {
        let (changed, _) = watch::channel(LinkState::Starting);
        Self {
            report: Mutex::new(LinkReport {
                state: LinkState::Starting,
                since: Clock::now(),
                attempts: 0,
                last_error: None,
            }),
            changed,
        }
    }
}

impl LinkStatus {
    pub(crate) fn set(&self, state: LinkState, attempts: u32, last_error: Option<String>) {
        let mut report = self.report.lock().expect("bus link status");
        if report.state != state {
            report.state = state;
            report.since = Clock::now();
        }
        report.attempts = attempts;
        report.last_error = last_error;
        self.changed.send_replace(state);
    }

    /// Wait only while an authenticated attach is actively making progress.
    /// Failed attempts are already on the supervisor's backoff and must not
    /// make every Setup wait through another retry interval.
    pub(crate) async fn wait_for_attach(&self, limit: Duration) {
        let mut changed = self.changed.subscribe();
        if *changed.borrow_and_update() != LinkState::Attaching {
            return;
        }
        let _ = tokio::time::timeout(limit, async {
            while changed.changed().await.is_ok() {
                if *changed.borrow_and_update() != LinkState::Attaching {
                    break;
                }
            }
        })
        .await;
    }

    #[cfg(test)]
    pub(crate) fn state(&self) -> LinkState {
        self.report.lock().expect("bus link status").state
    }

    pub(crate) fn snapshot(&self) -> LinkSnapshot {
        let report = self.report.lock().expect("bus link status");
        LinkSnapshot {
            state: report.state.name(),
            attempts: report.attempts,
            last_error: report.last_error.clone(),
        }
    }

    /// One readable line, e.g. `ckbus_unreachable for 95s after 6 attempts:
    /// ck-bus unreachable: ...`.
    pub(crate) fn describe(&self) -> String {
        let report = self.report.lock().expect("bus link status");
        let mut line = format!(
            "{} for {}s",
            report.state.name(),
            report.since.elapsed().as_secs()
        );
        if report.attempts > 0 {
            line.push_str(&format!(" after {} attempts", report.attempts));
        }
        if let Some(error) = &report.last_error {
            line.push_str(&format!(": {error}"));
        }
        line
    }
}

/// Renews `credential` before each `exp` until it is retired. Failed attempts
/// back off from [`RENEW_RETRY_FIRST`] to [`RENEW_RETRY_MAX`], one log line
/// each, and one attempt always falls at `exp`; if that one fails too the
/// credential is retired, as it is at once on a refusal in
/// [`RENEWAL_DEAD_ENDS`].
pub(crate) async fn renew_until_retired(
    credential: Arc<HeldCredential>,
    issuer: Arc<dyn Issuer>,
    status: Arc<LinkStatus>,
) {
    loop {
        tokio::time::sleep_until(credential.renew_at()).await;
        if credential.retired().is_some() {
            return;
        }
        let mut attempt = 0_u32;
        let mut retry = RENEW_RETRY_FIRST;
        loop {
            attempt += 1;
            let answer = issuer
                .op(
                    CREDENTIAL_RENEW_OP,
                    json!({"credential_public":credential.public()}),
                )
                .await
                .and_then(|answer| {
                    let renewed = answer["credential_public"].as_str();
                    if renewed.is_some_and(|key| key != credential.public()) {
                        return Err(IssuerError::Refused {
                            code: "ckbus_credential_superseded".into(),
                            message: "renewal answered for another key".into(),
                        });
                    }
                    let jwt = answer["jwt"].as_str().map(str::to_owned).ok_or_else(|| {
                        IssuerError::Unreachable("renewal answer missing jwt".into())
                    })?;
                    let exp = answer_exp(&answer).map_err(IssuerError::Unreachable)?;
                    // A renewal that does not move `exp` forward leaves the next
                    // renewal due at once; retrying it without backoff would be
                    // a tight loop against ck-bus.
                    if deadline(exp) < credential.expires() + RENEWAL_MIN_EXTENSION {
                        return Err(IssuerError::Unreachable(format!(
                            "renewal answered exp {exp}, no later than the held credential's"
                        )));
                    }
                    Ok((jwt, exp))
                });
            match answer {
                Ok((jwt, exp)) => {
                    credential.replace(jwt, exp);
                    status.set(LinkState::Connected, 0, None);
                    tracing::info!(
                        attempt,
                        exp,
                        credential_public = credential.public(),
                        "bus credential renewed"
                    );
                    break;
                }
                Err(IssuerError::Refused { code, message })
                    if RENEWAL_DEAD_ENDS.contains(&code.as_str()) =>
                {
                    let error = format!("{code}: {message}");
                    status.set(LinkState::Reissuing, attempt, Some(error.clone()));
                    tracing::warn!(
                        attempt,
                        %error,
                        "bus credential renewal refused; fetching a fresh credential"
                    );
                    credential.retire(error);
                    return;
                }
                Err(error) => {
                    let error = error.to_string();
                    if credential.is_expired() {
                        status.set(LinkState::CredentialExpired, attempt, Some(error.clone()));
                        tracing::warn!(
                            attempt,
                            %error,
                            "bus credential expired before renewal succeeded; fetching a fresh credential"
                        );
                        credential.retire(format!("expired before renewal: {error}"));
                        return;
                    }
                    let wait =
                        retry.min(credential.expires().saturating_duration_since(Clock::now()));
                    status.set(LinkState::Renewing, attempt, Some(error.clone()));
                    tracing::warn!(
                        attempt,
                        retry_in_ms = wait.as_millis() as u64,
                        %error,
                        "bus credential renewal failed"
                    );
                    tokio::time::sleep(wait).await;
                    retry = (retry * 2).min(RENEW_RETRY_MAX);
                }
            }
        }
    }
}

/// One authenticated nats-server connection and the credential it presents.
pub(crate) struct Link {
    pub(crate) bus: Arc<cortexkit_bus_nats::NatsConnection>,
    pub(crate) account: String,
    pub(crate) credential: Arc<HeldCredential>,
}

impl Link {
    /// Fetches a fresh credential and connects with it.
    pub(crate) async fn connect(issuer: Arc<dyn Issuer>) -> Result<Self, String> {
        let answer = issuer
            .op(CREDENTIAL_OP, json!({}))
            .await
            .map_err(|e| e.to_string())?;
        let field = |name: &str| {
            answer[name]
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| format!("credential missing {name}"))
        };
        let public = field("credential_public")?;
        let server = field("server_url")?;
        let account = field("acct")?;
        let credential = Arc::new(HeldCredential::new(
            public.clone(),
            field("jwt")?,
            answer_exp(&answer)?,
        ));
        let config = cortexkit_bus_nats::ConnectConfig::new(&public).map_err(|e| e.to_string())?;
        let held = credential.clone();
        let options = async_nats::ConnectOptions::with_auth_callback(move |nonce| {
            let held = held.clone();
            let issuer = issuer.clone();
            // The library needs a `Sync` future; the task handle is one.
            let task = tokio::spawn(async move { held.auth(issuer.as_ref(), &nonce).await });
            async move {
                task.await
                    .map_err(async_nats::AuthError::new)?
                    .map_err(async_nats::AuthError::new)
            }
        })
        .connection_timeout(Duration::from_secs(5))
        .reconnect_delay_callback(reconnect_delay)
        .max_reconnects(RECONNECT_ATTEMPTS);
        let bus = cortexkit_bus_nats::NatsConnection::connect(server, options, config)
            .await
            .map_err(|e| e.to_string())?;
        Ok(Self {
            bus: Arc::new(bus),
            account,
            credential,
        })
    }
}

/// A stream whose cursors stop once the link's credential is retired, so the
/// reader hands over to a fresh bootstrap at a delivery boundary. Its cursors
/// also skip pulling while the credential is expired, since a pull queued on a
/// client that cannot connect would only be replayed stale once it does.
pub(crate) struct LinkStream<S> {
    inner: S,
    credential: Arc<HeldCredential>,
}

impl<S> LinkStream<S> {
    pub(crate) fn new(inner: S, credential: Arc<HeldCredential>) -> Self {
        Self { inner, credential }
    }
}

fn retired_error(reason: &str) -> BusError {
    BusError::unavailable(format!("bus credential retired: {reason}"))
}

#[async_trait]
impl<S: Stream> Stream for LinkStream<S>
where
    S::Cursor: 'static,
{
    type Cursor = LinkCursor<S::Cursor>;

    async fn publish(
        &self,
        subject: &str,
        id: &str,
        digest: ContentDigest,
        headers: Headers,
    ) -> BusResult<PublishReceipt> {
        if let Some(reason) = self.credential.retired() {
            return Err(retired_error(&reason));
        }
        self.inner.publish(subject, id, digest, headers).await
    }

    async fn consumer(&self, owner: DurableOwner<'_>) -> BusResult<Self::Cursor> {
        Ok(LinkCursor {
            inner: self.inner.consumer(owner).await?,
            credential: self.credential.clone(),
        })
    }
}

pub(crate) struct LinkCursor<C> {
    inner: C,
    credential: Arc<HeldCredential>,
}

#[async_trait]
impl<C: StreamCursor> StreamCursor for LinkCursor<C> {
    async fn next(&mut self) -> BusResult<Option<StreamDelivery>> {
        if let Some(reason) = self.credential.retired() {
            return Err(retired_error(&reason));
        }
        if self.credential.is_expired() {
            self.credential.changed_within(EXPIRED_WAIT).await;
            return Ok(None);
        }
        self.inner.next().await
    }
    async fn ack(&mut self) -> BusResult<()> {
        self.inner.ack().await
    }
    async fn nak(&mut self, delay: Duration) -> BusResult<()> {
        self.inner.nak(delay).await
    }
    async fn term(&mut self, reason: Option<&str>) -> BusResult<()> {
        self.inner.term(reason).await
    }
    async fn in_progress(&mut self) -> BusResult<()> {
        self.inner.in_progress().await
    }
}

/// Runs `attach` until the process ends: each call bootstraps one link and
/// resolves when its reader stops. Failures back off from
/// [`BOOTSTRAP_RETRY_FIRST`] to [`BOOTSTRAP_RETRY_MAX`] with one log line per
/// attempt naming the link state; a link that served [`STABLE_LINK`] or longer
/// starts the backoff over.
pub(crate) async fn supervise<F, Fut>(status: Arc<LinkStatus>, mut attach: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<Duration, String>>,
{
    // Consecutive bootstraps since the last link that served long enough.
    let mut attempt = 0_u32;
    let mut retry = BOOTSTRAP_RETRY_FIRST;
    loop {
        attempt += 1;
        status.set(LinkState::Attaching, attempt, None);
        let (stable, error) = match attach().await {
            Ok(served) => {
                let error = format!("the bus reader stopped after {}s", served.as_secs());
                status.set(LinkState::CkbusUnreachable, attempt, Some(error.clone()));
                (served >= STABLE_LINK, error)
            }
            Err(error) => {
                status.set(LinkState::CkbusUnreachable, attempt, Some(error.clone()));
                (false, error)
            }
        };
        if stable {
            retry = BOOTSTRAP_RETRY_FIRST;
        }
        tracing::warn!(
            attempt,
            state = %status.describe(),
            retry_in_ms = retry.as_millis() as u64,
            %error,
            "async compaction bus link down; retrying authenticated bootstrap"
        );
        tokio::time::sleep(retry).await;
        retry = (retry * 2).min(BOOTSTRAP_RETRY_MAX);
        if stable {
            attempt = 0;
        }
    }
}

impl McHandler {
    pub(crate) fn async_bus_health(&self) -> Value {
        let runtime = &self.provider_store.async_runtime;
        if runtime
            .connection_file
            .lock()
            .expect("bus connection file")
            .is_none()
        {
            Value::Null
        } else {
            json!(runtime.bus_link.snapshot())
        }
    }

    pub(crate) fn start_async_compaction_background(&self) {
        let runtime = &self.provider_store.async_runtime;
        let Some(connection) = runtime
            .connection_file
            .lock()
            .expect("bus connection file")
            .clone()
        else {
            return;
        };
        if runtime.bootstrapped.set(()).is_err() {
            return;
        }
        let status = runtime.bus_link.clone();
        status.set(LinkState::Attaching, 1, None);
        let handler = self.provider_historian_worker();
        tokio::spawn(supervise(status.clone(), move || {
            let connection = connection.clone();
            let handler = handler.clone();
            let status = status.clone();
            async move {
                let issuer: Arc<dyn Issuer> = Arc::new(SubcIssuer::connect(connection).await?);
                let link = Link::connect(issuer.clone()).await?;
                let names = cortexkit_bus_naming::AccountNames::derive(&link.account)
                    .map_err(|e| e.to_string())?;
                let stream = Arc::new(LinkStream::new(
                    link.bus.stream(names.streams().event.clone()),
                    link.credential.clone(),
                ));
                let task = handler
                    .start_compaction_bus(stream, link.account.clone())
                    .await?;
                let attempt = status.snapshot().attempts;
                status.set(LinkState::Connected, 0, None);
                tracing::info!(attempt, "async compaction bus link connected");
                let started = Clock::now();
                let renewal = tokio::spawn(renew_until_retired(
                    link.credential.clone(),
                    issuer,
                    status.clone(),
                ));
                let ended = task.await;
                renewal.abort();
                // Stop the reconnect loop of a connection whose credential is
                // dead, and say why the reader stopped.
                link.credential.retire("the bus reader stopped".into());
                ended.map_err(|e| e.to_string())?;
                Ok(started.elapsed())
            }
        }));
    }
}
