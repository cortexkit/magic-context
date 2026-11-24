//! The module's connection to the bus ([`Bus`]), and its `docs_proposal` v1
//! notices, which say that a project has a new docs-upkeep proposal
//! ([`crate::docs_proposals`]). The same connection carries the
//! `memory_changed` wakes ([`crate::memory_changed`]), the watch on
//! Entorhinal's change markers ([`crate::entorhinal_changes`]) and the
//! reader of the runners' run-end events ([`crate::run_ends`]).
//!
//! The daemon serves no call that publishes a module's event, so the module
//! publishes to the bus itself: it opens a route to ck-bus
//! (`ckbus`, the NATS credential module) through the CortexKit daemon, has it issue a NATS
//! credential, connects with it (ck-bus signs each connection nonce), and
//! renews it before it expires. Credential material is never logged, and
//! each credential's `Debug` leaves it out. ck-bus keeps one live credential
//! per module: issuing a second revokes the first and closes its
//! connections. So everything in the module that uses the bus shares the
//! one session [`Bus`] holds rather than opening its own.
//!
//! A notice carries no body. Its subject is
//! `ck.<account>.event.magic-context.docs_proposal.v1`, its message id the
//! event key, its digest the SHA-256 of the body `events_get` serves, and its
//! headers exactly the ones the manifest's declaration lists (`event_key`,
//! `project_id`). The proposal's row is the outbox: `published_at` stays null
//! until the bus acknowledged the notice, and the dreamer's minute tick
//! publishes every pending row still unsent ([`DocsNotices::publish`]). A row
//! that stops being pending before it is sent is never sent. The bus being
//! down, or ck-bus not installed, is logged once and leaves the rows unsent;
//! nothing else fails.
//!
//! A runner's run-end event carries no body on the bus either; it names its
//! session in a `session_ref` header, which is all the reader needs. The
//! reader uses a checked JetStream cursor on the shared session's connection.
//! It verifies the durable and subject before decoding and acknowledges one
//! event at a time ([`spawn_run_end_reader`]).
//!
//! The `attribution_fact` v1 event is the one ck-mc event with a body: its
//! payload is the fact ([`crate::attribution`]), which Astrocyte reads off
//! the bus. `cortexkit-bus-nats` publishes headers only, so it is published
//! with async-nats directly on the shared session's connection, as a
//! JetStream publish whose acknowledgement is awaited, with the headers that
//! library would write: `Nats-Msg-Id` (the fact id, so a fact sent again is
//! the same message) and `Ck-Content-Digest` (the payload's SHA-256 as
//! lowercase hex). The fact's row is its outbox, as a proposal's is: a new
//! fact wakes the publisher right after its commit, and the dreamer's minute
//! tick publishes any still unsent ([`AttributionEvents`]).

use std::collections::BTreeMap;
use std::fmt;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine as _;
use cortexkit_bus_naming::AccountNames;
use cortexkit_bus_nats::{ConnectConfig, NatsConnection, NatsStreamCursor, Pulled};
use cortexkit_bus_trait::{
    BusError, ContentDigest, DurableOwner, Headers, PublishReceipt, Register, RegisterWatch,
    Stream, StreamCursor,
};
use serde::Deserialize;
use serde_json::{json, Value};
use subc_client_rs::{CallOptions, ConsumerOptions, SubcConsumer};
use subc_protocol::{BindIdentity, RouteTarget};

use crate::attribution;
use crate::context_db::ContextDb;
use crate::docs_proposals::{self as proposals, Proposal};
use crate::run_ends::{self, RunEnds};

/// The module ck-bus runs as.
const CKBUS: &str = "ckbus";
/// The most pending notices one round publishes.
const BATCH: usize = 50;
/// A credential this close to its expiry, in seconds, is renewed first.
const RENEW_WITHIN_S: i64 = 300;

fn zeroizing_string<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<zeroize::Zeroizing<String>, D::Error> {
    String::deserialize(deserializer).map(zeroize::Zeroizing::new)
}

fn now_ms() -> i64 {
    crate::memory_writes::now_ms()
}

/// A NATS credential ck-bus issued through the daemon. Its secret parts
/// (`jwt`, `credential_public`) are left out of `Debug`.
#[derive(Clone, Deserialize)]
pub struct Credential {
    #[serde(deserialize_with = "zeroizing_string")]
    pub jwt: zeroize::Zeroizing<String>,
    pub exp: i64,
    pub acct: String,
    pub account_public: String,
    pub inbox_prefix: String,
    pub server_url: String,
    pub credential_public: String,
    pub user_jwt_id: String,
    pub spawn_generation: u64,
    pub credential_epoch: u64,
}

impl fmt::Debug for Credential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Credential")
            .field("acct", &self.acct)
            .field("account_public", &self.account_public)
            .field("server_url", &self.server_url)
            .field("user_jwt_id", &self.user_jwt_id)
            .field("spawn_generation", &self.spawn_generation)
            .field("credential_epoch", &self.credential_epoch)
            .field("exp", &self.exp)
            .finish_non_exhaustive()
    }
}

impl Credential {
    /// Refuse a credential for an invalid account or key, another inbox, a
    /// server that isn't on this machine's loopback, or one already expired.
    pub fn validate(&self) -> Result<(), String> {
        AccountNames::derive(&self.acct).map_err(|_| "ckbus_invalid_account")?;
        let config =
            ConnectConfig::new(&self.credential_public).map_err(|_| "ckbus_invalid_key")?;
        if config.inbox_prefix() != self.inbox_prefix {
            return Err("ckbus inbox prefix mismatch".into());
        }
        let address = self
            .server_url
            .parse::<async_nats::ServerAddr>()
            .map_err(|_| "ckbus_invalid_server_url")?;
        let is_local = address.scheme() == "nats"
            && address.username().is_none()
            && address.password().is_none()
            && matches!(address.host(), "127.0.0.1" | "localhost" | "::1");
        if !is_local {
            return Err("ckbus server must be local loopback".into());
        }
        if self.exp <= now_ms() / 1000 {
            return Err("expired ckbus credential".into());
        }
        Ok(())
    }

    fn apply(&mut self, renew: Renewal) -> Result<(), String> {
        if renew.credential_public != self.credential_public
            || renew.spawn_generation != self.spawn_generation
            || renew.credential_epoch != self.credential_epoch
            || renew.exp <= self.exp
        {
            return Err("ckbus renewal identity or expiry mismatch".into());
        }
        self.jwt = renew.jwt;
        self.exp = renew.exp;
        self.user_jwt_id = renew.user_jwt_id;
        Ok(())
    }
}

/// A renewed credential's new parts. Its token is left out of `Debug`.
#[derive(Deserialize)]
pub(crate) struct Renewal {
    #[serde(deserialize_with = "zeroizing_string")]
    jwt: zeroize::Zeroizing<String>,
    exp: i64,
    credential_public: String,
    user_jwt_id: String,
    spawn_generation: u64,
    credential_epoch: u64,
}

impl fmt::Debug for Renewal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Renewal")
            .field("exp", &self.exp)
            .finish_non_exhaustive()
    }
}

/// Only these refusal codes from ck-bus leave this module: a peer's message
/// or an unknown code could hold credential data.
fn trusted_refusal_code(code: Option<&str>) -> &'static str {
    match code {
        Some("ckbus_credential_superseded") => "ckbus_credential_superseded",
        Some("ckbus_credential_revoked") => "ckbus_credential_revoked",
        Some("ckbus_generation_not_live") => "ckbus_generation_not_live",
        _ => "ckbus_refused",
    }
}

fn credential_result(value: Value) -> Result<Value, String> {
    if let Some(error) = value.get("error") {
        let code = trusted_refusal_code(error.get("code").and_then(Value::as_str));
        return Err(code.into());
    }
    value
        .get("result")
        .cloned()
        .ok_or_else(|| "ckbus_missing_result".into())
}

/// Whether ck-bus no longer renews the credential and a new one is needed.
fn fresh_required(error: &str) -> bool {
    error.contains("ckbus_credential_superseded")
        || error.contains("ckbus_credential_revoked")
        || error.contains("ckbus_generation_not_live")
}

/// The route to ck-bus's management surface, which issues and renews
/// credentials and signs connection nonces. ck-bus issues a credential only
/// to the module the daemon attests on the route, and the SDK's connection
/// carries that attestation: a self claim when ck-mc registered over the
/// daemon's registration channel, its launch nonce when it dialled the
/// daemon. The call itself names no caller.
pub struct CredentialRoute {
    consumer: SubcConsumer,
    identity: BindIdentity,
}

impl CredentialRoute {
    /// Connect to the daemon at `path` as this module.
    pub async fn connect(path: &Path) -> Result<Self, String> {
        let consumer = tokio::time::timeout(
            Duration::from_secs(2),
            SubcConsumer::connect(path, ConsumerOptions::default()),
        )
        .await
        .map_err(|_| "ckbus route connect timeout".to_string())?
        .map_err(|error| error.to_string())?;
        Ok(Self {
            consumer,
            identity: BindIdentity::new(crate::MODULE_ID, "bus"),
        })
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let body = serde_json::to_vec(&json!({"method": method, "params": params}))
            .map_err(|_| "ckbus_request_encode_failed")?;
        let reply = self
            .consumer
            .call(
                RouteTarget::ManagementSurface {
                    module_id: CKBUS.into(),
                },
                self.identity.clone(),
                body,
                CallOptions {
                    timeout: Duration::from_secs(2),
                    ..Default::default()
                },
            )
            .await
            .map_err(|error| trusted_refusal_code(error.code()).to_string())?;
        let value: Value = serde_json::from_slice(&reply).map_err(|_| "ckbus_invalid_json")?;
        credential_result(value)
    }

    pub async fn issue(&self) -> Result<Credential, String> {
        let credential: Credential =
            serde_json::from_value(self.call("ckbus.credential", json!({})).await?)
                .map_err(|_| "ckbus_invalid_credential")?;
        credential.validate()?;
        Ok(credential)
    }

    pub async fn sign(&self, key: &str, nonce: &[u8]) -> Result<Vec<u8>, String> {
        let value = self
            .call(
                "ckbus.nonce_sign",
                json!({
                    "credential_public": key,
                    "nonce_b64": base64::engine::general_purpose::STANDARD.encode(nonce),
                }),
            )
            .await?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(
                value["signature_b64"]
                    .as_str()
                    .ok_or_else(|| "ckbus signature absent".to_string())?,
            )
            .map_err(|_| "ckbus_invalid_signature")?;
        if bytes.len() != 64 {
            return Err("ckbus signature must be 64 bytes".into());
        }
        Ok(bytes)
    }
}

type SignFuture<'a> = std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<Vec<u8>, String>> + Send + Sync + 'a>,
>;

/// What signs a connection nonce for a credential's key.
trait NonceSigner: Send + Sync {
    fn sign<'a>(&'a self, key: &'a str, nonce: &'a [u8]) -> SignFuture<'a>;
}

impl NonceSigner for CredentialRoute {
    fn sign<'a>(&'a self, key: &'a str, nonce: &'a [u8]) -> SignFuture<'a> {
        // The consumer's call future is Send but not Sync, and NATS needs its
        // auth future to be both: lock it only while polling, so cancelling
        // still drops it.
        let future = Mutex::new(Box::pin(CredentialRoute::sign(self, key, nonce)));
        Box::pin(std::future::poll_fn(move |cx| {
            future
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .as_mut()
                .poll(cx)
        }))
    }
}

#[async_trait]
#[allow(clippy::double_must_use)]
trait CredentialProvider: NonceSigner {
    async fn issue(&self) -> Result<Credential, String>;
    async fn renewal(&self, credential: &Credential) -> Result<Renewal, String>;
}

#[async_trait]
impl CredentialProvider for CredentialRoute {
    async fn issue(&self) -> Result<Credential, String> {
        CredentialRoute::issue(self).await
    }
    async fn renewal(&self, credential: &Credential) -> Result<Renewal, String> {
        let value = self
            .call(
                "ckbus.credential_renew",
                json!({"credential_public": credential.credential_public}),
            )
            .await?;
        serde_json::from_value(value).map_err(|_| "ckbus_invalid_renewal".into())
    }
}

async fn renew_credential(
    provider: &(impl CredentialProvider + ?Sized),
    credential: &mut Credential,
) -> Result<(), String> {
    match provider.renewal(credential).await {
        Ok(renewal) => credential.apply(renewal)?,
        Err(error) if fresh_required(&error) => *credential = provider.issue().await?,
        Err(error) => return Err(error),
    }
    credential.validate()
}

async fn connect_with_signer(
    route: Arc<dyn NonceSigner>,
    credential: &Credential,
) -> Result<(NatsConnection, AccountNames), String> {
    credential.validate()?;
    let key = credential.credential_public.clone();
    let jwt = credential.jwt.clone();
    let auth_error = Arc::new(Mutex::new(None::<String>));
    let callback_error = auth_error.clone();
    let options = async_nats::ConnectOptions::with_auth_callback(move |nonce| {
        let route = route.clone();
        let key = key.clone();
        let jwt = jwt.clone();
        let callback_error = callback_error.clone();
        async move {
            let mut last = String::new();
            for attempt in 0..=3 {
                match route.sign(&key, &nonce).await {
                    Ok(signature) => {
                        let mut auth = async_nats::Auth::new();
                        auth.jwt = Some(jwt.to_string());
                        auth.signature = Some(signature);
                        return Ok(auth);
                    }
                    Err(error) => {
                        last = error;
                        *callback_error.lock().unwrap() = Some(last.clone());
                        if fresh_required(&last) {
                            break;
                        }
                        if attempt < 3 {
                            tokio::time::sleep(Duration::from_millis(100)).await;
                        }
                    }
                }
            }
            *callback_error.lock().unwrap() = Some(last.clone());
            Err(async_nats::AuthError::new(last))
        }
    })
    // One reconnect at most; after that a lost connection is rebuilt by the
    // next round with a fresh session and credential.
    .max_reconnects(1)
    .ignore_discovered_servers()
    // Four nonce-sign calls can each take two seconds, plus retry spacing.
    .connection_timeout(Duration::from_secs(10));
    let connection = NatsConnection::connect(
        &credential.server_url,
        options,
        ConnectConfig::new(&credential.credential_public).map_err(|e| e.to_string())?,
    )
    .await
    .map_err(|_| {
        auth_error
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| "nats_connect_failed".into())
    })?;
    let account = AccountNames::derive(&credential.acct).map_err(|e| e.to_string())?;
    Ok((connection, account))
}

/// What publishes a notice on the bus.
#[async_trait]
#[allow(clippy::double_must_use)]
pub trait EventPublisher: Send + Sync {
    async fn publish(
        &self,
        subject: &str,
        id: &str,
        digest: ContentDigest,
        headers: Headers,
    ) -> Result<PublishReceipt, String>;
}

/// The JetStream publisher of `cortexkit-bus-nats`.
pub struct NatsEventPublisher {
    pub connection: NatsConnection,
    pub stream_name: String,
}

#[async_trait]
impl EventPublisher for NatsEventPublisher {
    async fn publish(
        &self,
        subject: &str,
        id: &str,
        digest: ContentDigest,
        headers: Headers,
    ) -> Result<PublishReceipt, String> {
        self.connection
            .stream(&self.stream_name)
            .publish(subject, id, digest, headers)
            .await
            .map_err(|error| {
                match error {
                    BusError::Denied { .. } | BusError::Absent { .. } => "nats_publish_refused",
                    BusError::Clamped { .. } => "nats_publish_clamped",
                    BusError::Unavailable {
                        exhausted_limit: Some(_),
                        ..
                    } => "nats_publish_capacity",
                    _ => "nats_publish_failed",
                }
                .into()
            })
    }
}

/// What publishes an event that carries a body: one JetStream publish of
/// `body` on `subject` with exactly `headers`, returning once the stream
/// acknowledged it. Whether the stream already held a message with the same
/// `Nats-Msg-Id`.
#[async_trait]
#[allow(clippy::double_must_use)]
pub(crate) trait PayloadPublisher: Send + Sync {
    async fn publish(&self, subject: &str, headers: &Headers, body: &[u8]) -> Result<bool, String>;
}

/// The JetStream publish of async-nats on the session's own connection.
struct NatsPayloadPublisher(async_nats::Client);

#[async_trait]
impl PayloadPublisher for NatsPayloadPublisher {
    async fn publish(&self, subject: &str, headers: &Headers, body: &[u8]) -> Result<bool, String> {
        let mut map = async_nats::HeaderMap::new();
        for (name, value) in headers {
            map.insert(name.as_str(), value.as_str());
        }
        // Only fixed codes leave: a NATS error can name the subject.
        let ack = async_nats::jetstream::new(self.0.clone())
            .publish_with_headers(subject.to_owned(), map, body.to_vec().into())
            .await
            .map_err(|_| "nats_publish_failed".to_owned())?
            .await
            .map_err(|_| "nats_publish_unacknowledged".to_owned())?;
        Ok(ack.duplicate)
    }
}

/// One notice, ready for the bus.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Notice {
    pub subject: String,
    /// The bus's message id, which it deduplicates by: the event key.
    pub id: String,
    pub digest: ContentDigest,
    pub headers: Headers,
}

/// The headers of `proposal`'s notice: exactly the names the event's
/// declaration lists, so a notice never carries a label the manifest doesn't
/// promise. A header without a value is left out, never sent empty.
pub(crate) fn notice_headers(proposal: &Proposal) -> Result<Headers, String> {
    let declaration = proposals::event_declaration();
    let mut headers = BTreeMap::new();
    for name in &declaration.headers {
        let value = match name.as_str() {
            "event_key" => proposal.event_key(),
            "project_id" => proposal.project.clone(),
            other => {
                return Err(format!(
                    "event_header_unmapped: {} declares header {other} with no publisher mapping",
                    declaration.name
                ))
            }
        };
        if value.is_empty() {
            continue;
        }
        if value.chars().any(char::is_control) {
            return Err("header_invalid".into());
        }
        headers.insert(name.clone(), value);
    }
    Ok(headers)
}

/// The notice of `proposal` in `account`.
pub(crate) fn notice(account: &AccountNames, proposal: &Proposal) -> Result<Notice, String> {
    let subject = account
        .event_subject(
            crate::MODULE_ID,
            proposals::EVENT_NAME,
            proposals::EVENT_VERSION,
        )
        .map_err(|error| format!("event_subject: {error}"))?;
    Ok(Notice {
        subject,
        id: proposal.event_key(),
        digest: ContentDigest::of_bytes(proposal.body.as_bytes()),
        headers: notice_headers(proposal)?,
    })
}

/// Publish the notice of every pending proposal not yet on the bus, oldest
/// first, at most [`BATCH`]; how many went out. Each proposal is checked
/// against its documents first, and one no longer pending is not sent. The
/// first failed publish ends the round; the rows sent before it stay sent.
pub(crate) async fn publish_pending(
    db: &ContextDb,
    account: &AccountNames,
    publisher: &(impl EventPublisher + ?Sized),
) -> Result<usize, String> {
    let rows = db
        .with_connection(|conn| proposals::unpublished(conn, BATCH))
        .map_err(|error| format!("reading unsent notices: {error}"))?;
    let mut published = 0;
    for row in rows {
        let row = proposals::refresh(db, row)
            .map_err(|error| format!("checking proposal before its notice: {error}"))?;
        if row.status != proposals::PENDING {
            continue;
        }
        let notice = notice(account, &row)?;
        let receipt = publisher
            .publish(&notice.subject, &notice.id, notice.digest, notice.headers)
            .await?;
        if receipt.duplicate() {
            // Sent before a crash kept its row from being marked: the bus
            // holds the one message already.
            tracing::debug!(
                "ck-mc: bus: docs proposal {} notice was already on the bus",
                row.id
            );
        }
        db.with_connection(|conn| proposals::mark_published(conn, row.id, now_ms()))
            .map_err(|error| format!("recording proposal {}'s notice: {error}", row.id))?;
        published += 1;
    }
    Ok(published)
}

/// What opens a watch on one key of another module's KV bucket.
#[async_trait]
#[allow(clippy::double_must_use)]
pub(crate) trait Registers: Send + Sync {
    /// Watch `key` of the bucket named `bucket`. The watch first delivers
    /// the key's current value, then each change.
    async fn watch(&self, bucket: &str, key: &str) -> Result<Box<dyn RegisterWatch>, String>;
}

/// The KV buckets of a NATS connection.
struct NatsRegisters(NatsConnection);

#[async_trait]
impl Registers for NatsRegisters {
    async fn watch(&self, bucket: &str, key: &str) -> Result<Box<dyn RegisterWatch>, String> {
        // Only fixed codes leave: a bus error can name subjects and buckets.
        let refused = |error: BusError| -> String {
            match error {
                BusError::Denied { .. } | BusError::Absent { .. } => "nats_watch_refused",
                _ => "nats_watch_failed",
            }
            .into()
        };
        let register = self.0.register(bucket).await.map_err(refused)?;
        let watch = register.watch(key).await.map_err(refused)?;
        Ok(Box::new(watch))
    }
}

/// A session with no KV buckets, for tests that only publish.
#[cfg(test)]
struct NoRegisters;

#[cfg(test)]
#[async_trait]
impl Registers for NoRegisters {
    async fn watch(&self, _: &str, _: &str) -> Result<Box<dyn RegisterWatch>, String> {
        Err("register_absent".into())
    }
}

/// A connection to the bus with the credential it was opened with.
pub(crate) struct BusSession {
    credential: Option<Credential>,
    pub(crate) account: AccountNames,
    pub(crate) publisher: Box<dyn EventPublisher>,
    registers: Box<dyn Registers>,
    route: Option<Arc<dyn CredentialProvider>>,
    /// The NATS connection itself, for the run-end reader; a test's session
    /// has none.
    connection: Option<NatsConnection>,
    /// What publishes an event with a payload (the attribution facts); a
    /// test's session has one only when the test gives it.
    payloads: Option<Box<dyn PayloadPublisher>>,
}

impl BusSession {
    /// A session over `publisher` in `account`, with no credential to renew
    /// and no KV buckets.
    #[cfg(test)]
    pub(crate) fn fixed(account: AccountNames, publisher: Box<dyn EventPublisher>) -> Self {
        Self {
            credential: None,
            account,
            publisher,
            registers: Box::new(NoRegisters),
            route: None,
            connection: None,
            payloads: None,
        }
    }

    /// The same session, with `payloads` publishing its events with a body.
    #[cfg(test)]
    pub(crate) fn with_payloads(mut self, payloads: Box<dyn PayloadPublisher>) -> Self {
        self.payloads = Some(payloads);
        self
    }

    /// The same session, with `registers` as its KV buckets.
    #[cfg(test)]
    pub(crate) fn with_registers(mut self, registers: Box<dyn Registers>) -> Self {
        self.registers = registers;
        self
    }

    /// Watch `key` of the bucket `name` that the module `owner` writes, by
    /// the bucket's name in this session's account.
    pub(crate) async fn watch(
        &self,
        owner: &str,
        name: &str,
        key: &str,
    ) -> Result<Box<dyn RegisterWatch>, String> {
        let bucket = self
            .account
            .module_bucket_name(owner, name)
            .map_err(|error| format!("bucket_name: {error}"))?;
        self.registers.watch(&bucket, key).await
    }
}

/// Where sessions come from: ck-bus over the daemon, or a test's bus.
#[async_trait]
#[allow(clippy::double_must_use)]
pub(crate) trait SessionFactory: Send + Sync {
    async fn open(&self) -> Result<BusSession, String>;
    async fn renew(&self, session: &mut BusSession) -> Result<(), String>;
}

/// Sessions from ck-bus, through the daemon at `path`.
struct ProductionSessions {
    path: PathBuf,
}

async fn build_session(
    route: Arc<dyn CredentialProvider>,
    credential: Credential,
) -> Result<BusSession, String> {
    let signer: Arc<dyn NonceSigner> = Arc::new(ProviderSigner(route.clone()));
    let (connection, account) = connect_with_signer(signer, &credential).await?;
    let stream_name = account.streams().event.clone();
    Ok(BusSession {
        credential: Some(credential),
        account,
        registers: Box::new(NatsRegisters(connection.clone())),
        publisher: Box::new(NatsEventPublisher {
            connection: connection.clone(),
            stream_name,
        }),
        route: Some(route),
        payloads: Some(Box::new(NatsPayloadPublisher(connection.client()))),
        connection: Some(connection),
    })
}

/// A credential provider's nonce signing, as the signer a connection needs.
struct ProviderSigner(Arc<dyn CredentialProvider>);

impl NonceSigner for ProviderSigner {
    fn sign<'a>(&'a self, key: &'a str, nonce: &'a [u8]) -> SignFuture<'a> {
        self.0.sign(key, nonce)
    }
}

#[async_trait]
impl SessionFactory for ProductionSessions {
    async fn open(&self) -> Result<BusSession, String> {
        let route = Arc::new(CredentialRoute::connect(&self.path).await?);
        let credential = route.issue().await?;
        build_session(route, credential).await
    }

    async fn renew(&self, session: &mut BusSession) -> Result<(), String> {
        let route = session.route.as_ref().ok_or("ckbus_route_absent")?.clone();
        let mut credential = session
            .credential
            .clone()
            .ok_or("ckbus_credential_absent")?;
        renew_credential(route.as_ref(), &mut credential).await?;
        // The auth callback holds the credential it was built with, so a
        // renewal opens a new connection rather than updating the old one.
        *session = build_session(route, credential).await?;
        Ok(())
    }
}

/// The box id a bus account `box_<box id>` names.
pub(crate) fn box_of_account(account: &str) -> Result<String, String> {
    account
        .strip_prefix("box_")
        .and_then(|id| cortexkit_bus_naming::federation::BoxId::parse(id).ok())
        .map(|id| id.as_str().to_owned())
        .ok_or_else(|| format!("the bus account {account} names no box"))
}

/// The module's one connection to the bus, shared by everything that
/// publishes, watches or reads: the docs-proposal notices ([`DocsNotices`]),
/// the memory wakes ([`crate::memory_changed`]), the watch on Entorhinal's
/// changes ([`crate::entorhinal_changes`]) and the run-end reader
/// ([`spawn_run_end_reader`]). It is opened when first needed and renewed
/// before its credential expires.
pub struct Bus {
    factory: Arc<dyn SessionFactory>,
    session: tokio::sync::Mutex<Option<BusSession>>,
    /// Whether a session was opened and has not been discarded. The health
    /// hook must not wait for a publisher holding the session across I/O.
    connected: AtomicBool,
    /// Advances each time the session gets a new connection, opened or
    /// renewed, so the run-end reader can tell that it is bound on an older
    /// one.
    generation: AtomicU64,
}

/// The bus's open session, held until dropped.
pub(crate) struct SessionGuard<'a>(
    tokio::sync::MutexGuard<'a, Option<BusSession>>,
    &'a AtomicBool,
);

impl std::ops::Deref for SessionGuard<'_> {
    type Target = BusSession;

    fn deref(&self) -> &BusSession {
        self.0.as_ref().expect("a guard holds an open session")
    }
}

impl SessionGuard<'_> {
    /// Drop the session after a failure on it, so the next user opens a
    /// fresh one.
    pub(crate) fn discard(mut self) {
        *self.0 = None;
        self.1.store(false, Ordering::Relaxed);
    }
}

impl Bus {
    /// The bus through ck-bus, reached over the daemon whose connection file
    /// is `path`.
    pub fn through_ckbus(path: PathBuf) -> Self {
        Self::with_factory(Arc::new(ProductionSessions { path }))
    }

    pub(crate) fn with_factory(factory: Arc<dyn SessionFactory>) -> Self {
        Self {
            factory,
            session: tokio::sync::Mutex::new(None),
            connected: AtomicBool::new(false),
            generation: AtomicU64::new(0),
        }
    }

    pub(crate) fn is_connected(&self) -> bool {
        self.connected.load(Ordering::Relaxed)
    }

    /// The open session: opened first when there is none, and renewed when
    /// its credential is about to expire. A failure leaves no session, so
    /// the next caller starts a fresh one.
    pub(crate) async fn session(&self) -> Result<SessionGuard<'_>, String> {
        let mut session = self.session.lock().await;
        let ready = async {
            // Whether the session got a new connection: opened, or renewed,
            // since a renewal opens a new connection too.
            let mut connected = false;
            if session.is_none() {
                *session = Some(self.factory.open().await?);
                connected = true;
            }
            let active = session.as_mut().expect("opened session");
            if active
                .credential
                .as_ref()
                .is_some_and(|credential| credential.exp - now_ms() / 1000 < RENEW_WITHIN_S)
            {
                self.factory.renew(active).await?;
                connected = true;
            }
            if connected {
                self.generation.fetch_add(1, Ordering::SeqCst);
            }
            Ok::<(), String>(())
        }
        .await;
        match ready {
            Ok(()) => {
                self.connected.store(true, Ordering::Relaxed);
                Ok(SessionGuard(session, &self.connected))
            }
            Err(error) => {
                *session = None;
                self.connected.store(false, Ordering::Relaxed);
                Err(error)
            }
        }
    }

    /// This computer's box id, as ck-bus names it in the module's bus
    /// account (`box_<box id>`); modules never derive it themselves. It
    /// names this computer as the writer of the memories it shares
    /// ([`crate::replica`]).
    pub(crate) async fn box_id(&self) -> Result<String, String> {
        let session = self.session().await?;
        box_of_account(session.account.account())
    }

    /// Capture the generation while the connection is still locked.
    pub(crate) async fn session_with_generation(&self) -> Result<(SessionGuard<'_>, u64), String> {
        let session = self.session().await?;
        Ok((session, self.generation.load(Ordering::SeqCst)))
    }

    /// Drop the session after a reader found its connection lost,
    /// unless it got a new connection after `generation`, which another user
    /// may already be using.
    pub(crate) async fn forget(&self, generation: u64) {
        let mut session = self.session.lock().await;
        if self.generation.load(Ordering::SeqCst) == generation {
            *session = None;
            self.connected.store(false, Ordering::Relaxed);
        }
    }
}

/// The module's publisher of `docs_proposal` notices, kept across the
/// dreamer's rounds.
pub struct DocsNotices {
    bus: Arc<Bus>,
    /// Whether the current outage was logged, so it is logged once.
    logged: AtomicBool,
}

impl DocsNotices {
    /// Notices published through `bus`.
    pub fn over(bus: Arc<Bus>) -> Self {
        Self {
            bus,
            logged: AtomicBool::new(false),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_factory(factory: Arc<dyn SessionFactory>) -> Self {
        Self::over(Arc::new(Bus::with_factory(factory)))
    }

    /// One round: publish every pending proposal's unsent notice, opening or
    /// renewing the session first. A failure drops the session, so the next
    /// round starts a fresh one, and is logged once until a round succeeds.
    pub async fn publish(&self, db: &ContextDb) {
        let has_work = db
            .with_connection(|conn| proposals::unpublished(conn, 1))
            .map(|rows| !rows.is_empty())
            .unwrap_or(false);
        if !has_work {
            return;
        }
        let result = async {
            let session = self.bus.session().await?;
            let published = publish_pending(db, &session.account, session.publisher.as_ref()).await;
            if published.is_err() {
                session.discard();
            }
            published
        }
        .await;
        match result {
            Ok(published) => {
                if published > 0 {
                    tracing::info!("ck-mc: bus: {published} docs proposal notice(s) published");
                }
                self.logged.store(false, Ordering::Relaxed);
            }
            Err(error) => {
                if !self.logged.swap(true, Ordering::Relaxed) {
                    tracing::warn!(
                        "ck-mc: bus: docs proposal notices wait unsent until the bus is reachable: {error}"
                    );
                }
            }
        }
    }
}

/// The headers an attribution fact's event carries: the bus's message id,
/// which is the fact id, and the SHA-256 of the payload as lowercase hex.
pub(crate) fn fact_headers(fact_id: &str, body: &str) -> Headers {
    BTreeMap::from([
        ("Nats-Msg-Id".to_owned(), fact_id.to_owned()),
        (
            "Ck-Content-Digest".to_owned(),
            ContentDigest::of_bytes(body.as_bytes()).to_string(),
        ),
    ])
}

/// The subject of the attribution facts' events in `account`.
pub(crate) fn fact_subject(account: &AccountNames) -> Result<String, String> {
    account
        .event_subject(
            crate::MODULE_ID,
            attribution::EVENT_NAME,
            attribution::EVENT_VERSION,
        )
        .map_err(|error| format!("event_subject: {error}"))
}

/// Publish the event of every fact not yet on the bus, oldest first, at
/// most [`BATCH`]; how many went out. Each is marked once the stream
/// acknowledged it. The first failed publish ends the round; the facts sent
/// before it stay sent.
pub(crate) async fn publish_unsent_facts(
    db: &ContextDb,
    account: &AccountNames,
    publisher: &dyn PayloadPublisher,
) -> Result<usize, String> {
    let rows = db
        .with_connection(|conn| attribution::unpublished(conn, BATCH))
        .map_err(|error| format!("reading unsent attribution facts: {error}"))?;
    if rows.is_empty() {
        return Ok(0);
    }
    let subject = fact_subject(account)?;
    let mut published = 0;
    for row in rows {
        let headers = fact_headers(&row.fact_id, &row.body);
        let duplicate = publisher
            .publish(&subject, &headers, row.body.as_bytes())
            .await?;
        if duplicate {
            // Sent before a crash kept its row from being marked: the bus
            // holds the one message already.
            tracing::debug!(
                "ck-mc: bus: attribution fact {} was already on the bus",
                row.fact_id
            );
        }
        db.with_connection(|conn| attribution::mark_published(conn, row.seq, now_ms()))
            .map_err(|error| format!("recording fact {}'s event: {error}", row.fact_id))?;
        published += 1;
    }
    Ok(published)
}

/// The module's publisher of `attribution_fact` events, woken after each
/// commit that stores a fact and called again on the dreamer's minute tick.
pub struct AttributionEvents {
    bus: Arc<Bus>,
    /// Whether the current outage was logged, so it is logged once.
    logged: AtomicBool,
    /// Serializes rounds, so the wake and the minute tick never send one
    /// fact twice at once.
    round: tokio::sync::Mutex<()>,
}

impl AttributionEvents {
    /// Events published through `bus`.
    pub fn over(bus: Arc<Bus>) -> Self {
        Self {
            bus,
            logged: AtomicBool::new(false),
            round: tokio::sync::Mutex::new(()),
        }
    }

    /// Publish every unsent fact's event, a batch at a time, opening or
    /// renewing the session first. A failure drops the session, so the next
    /// round starts a fresh one, leaves the rest unsent, and is logged once
    /// until a round gets through.
    pub async fn publish(&self, db: &ContextDb) {
        let _round = self.round.lock().await;
        let has_work = db
            .with_connection(|conn| attribution::unpublished(conn, 1))
            .map(|rows| !rows.is_empty())
            .unwrap_or(false);
        if !has_work {
            return;
        }
        let result = async {
            let mut total = 0;
            loop {
                // Let consumers of runner completion events and other
                // publishers use the connection between batches.
                let session = self.bus.session().await?;
                let Some(payloads) = session.payloads.as_deref() else {
                    return Err("nats_connection_absent".to_owned());
                };
                match publish_unsent_facts(db, &session.account, payloads).await {
                    Ok(published) => {
                        total += published;
                        if published < BATCH {
                            return Ok(total);
                        }
                    }
                    Err(error) => {
                        session.discard();
                        return Err(error);
                    }
                }
            }
        }
        .await;
        match result {
            Ok(published) => {
                if published > 0 {
                    tracing::debug!("ck-mc: bus: {published} attribution fact event(s) published");
                }
                self.logged.store(false, Ordering::Relaxed);
            }
            Err(error) => {
                if !self.logged.swap(true, Ordering::Relaxed) {
                    tracing::warn!(
                        "ck-mc: bus: attribution fact events wait unsent until the bus is reachable: {error}"
                    );
                }
            }
        }
    }
}

/// Publish the attribution facts' events each time `wake` is signalled,
/// which a commit that stores a fact does, for as long as the process runs.
/// A signal that arrives during a round starts another one after it.
pub(crate) async fn run_attribution_events(
    events: Arc<AttributionEvents>,
    db: Arc<ContextDb>,
    wake: Arc<tokio::sync::Notify>,
) {
    loop {
        wake.notified().await;
        events.publish(&db).await;
    }
}

/// Read the run-end events of ck-mc's child runs over `bus`, the process's
/// one bus session, and wake the waits in `ends` ([`crate::run_ends`]), for
/// as long as the process runs.
pub fn spawn_run_end_reader(bus: Arc<Bus>, ends: Arc<RunEnds>) {
    tokio::spawn(run_ends::read(ends, Arc::new(RunEndDurable { bus })));
}

/// The run-end durable, bound over the bus's connection.
pub(crate) struct RunEndDurable {
    pub(crate) bus: Arc<Bus>,
}

#[async_trait]
impl run_ends::Durable for RunEndDurable {
    async fn bind(&self) -> Result<Box<dyn run_ends::Cursor>, String> {
        Ok(Box::new(RunEndCursor {
            bus: self.bus.clone(),
            binding: bind_run_ends(&self.bus).await?,
        }))
    }
}

struct RunEndBinding {
    generation: u64,
    connection: NatsConnection,
    cursor: NatsStreamCursor,
    subjects: run_ends::RunEndSubjects,
}

/// Keep the expected subjects with their connection so a rebind also
/// updates the account against which we check deliveries.
async fn bind_run_ends(bus: &Bus) -> Result<RunEndBinding, String> {
    let (generation, connection, account) = {
        let session = bus.session().await?;
        let active: &BusSession = &session;
        let connection = active.connection.clone().ok_or("nats_connection_absent")?;
        (
            bus.generation.load(Ordering::SeqCst),
            connection,
            active.account.clone(),
        )
    };
    // The cursor adds `m_` to this token, addressing the existing suffixed
    // durable rather than ck-mc's separate compaction consumer.
    let owner = run_ends::DURABLE
        .strip_prefix("m_")
        .expect("module durable");
    let cursor = connection
        .stream(&account.streams().event)
        .consumer(DurableOwner::Module(owner))
        .await
        .map_err(|error| match error {
            BusError::Denied { .. } => "nats_consumer_refused",
            _ => "nats_consumer_bind_failed",
        })?;
    Ok(RunEndBinding {
        generation,
        connection,
        cursor,
        subjects: run_ends::RunEndSubjects::new(&account),
    })
}

/// The run-end durable, bound on one connection of the bus's session.
struct RunEndCursor {
    bus: Arc<Bus>,
    binding: RunEndBinding,
}

#[async_trait]
impl run_ends::Cursor for RunEndCursor {
    fn subjects(&self) -> &run_ends::RunEndSubjects {
        &self.binding.subjects
    }

    async fn next(&mut self) -> Result<Option<run_ends::Delivery>, String> {
        // Opening the session renews its credential when that is due, which
        // moves the session to a new connection; the durable is then bound
        // again on that one.
        let current = {
            let _session = self.bus.session().await?;
            self.bus.generation.load(Ordering::SeqCst)
        };
        if current != self.binding.generation {
            self.binding = bind_run_ends(&self.bus).await?;
        }
        let pulled = self.pull().await;
        if pulled.is_err()
            && self.binding.connection.client().connection_state()
                != async_nats::connection::State::Connected
        {
            // A lost connection is not reconnected: the next use of the bus
            // opens a new session.
            self.bus.forget(self.binding.generation).await;
        }
        pulled
    }

    async fn ack(&mut self) -> Result<(), String> {
        self.binding
            .cursor
            .ack()
            .await
            .map_err(|_| "nats_ack_failed".to_owned())
    }
}

impl RunEndCursor {
    /// Pull a delivery, using the shared connection's request timeout.
    async fn pull(&mut self) -> Result<Option<run_ends::Delivery>, String> {
        loop {
            let pulled = self
                .binding
                .cursor
                .next_or_undecodable()
                .await
                .map_err(|_| "nats_pull_failed".to_owned())?;
            match pulled {
                None => return Ok(None),
                Some(Pulled::Delivery(delivery)) => {
                    return Ok(Some(run_ends::Delivery {
                        id: Some(delivery.message.id),
                        subject: delivery.message.subject,
                        headers: delivery.message.headers,
                    }));
                }
                // The cursor has already checked that this message came from
                // our own durable, but its bus headers (message id, content
                // digest) can't be decoded, so no wait can match it. Left
                // unsettled, the server would deliver it again after every
                // ack wait; terminating it stops that, and the next pull
                // moves on. A summary or dreamer run it might have woken still
                // finishes waiting, because the run-end reader also checks
                // every waiting run every 15 seconds without an event.
                Some(Pulled::Undecodable(undecodable)) => {
                    tracing::warn!(
                        "ck-mc: run ends: terminating undecodable event {} on {} (delivered {} time(s)): {}",
                        undecodable.stream_seq,
                        undecodable.subject,
                        undecodable.delivery_count,
                        undecodable.error
                    );
                    self.binding
                        .cursor
                        .term(Some("undecodable bus headers"))
                        .await
                        .map_err(|_| "nats_term_failed".to_owned())?;
                }
                // `Pulled` may grow variants this build doesn't know. Hand
                // such a message back for redelivery a minute later rather
                // than settle it for good, and report the pull as failed.
                Some(_) => {
                    let _ = self.binding.cursor.nak(Duration::from_secs(60)).await;
                    return Err("nats_pull_unrecognized".to_owned());
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "bus_tests.rs"]
pub(crate) mod tests;
