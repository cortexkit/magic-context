//! Publishing the module's bus events: today one, `docs_proposal` v1, a
//! notice that a project has a new docs-upkeep proposal
//! ([`crate::docs_proposals`]).
//!
//! The daemon serves no call that publishes a module's event, so the module
//! publishes to the bus itself, as Plexus does: it opens a route to ck-bus
//! (`ckbus`, the NATS credential module) over subc, has it issue a NATS
//! credential, connects with it (ck-bus signs each connection nonce), and
//! renews it before it expires. Credential material is never logged, and
//! each credential's `Debug` leaves it out.
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

use std::collections::BTreeMap;
use std::fmt;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine as _;
use cortexkit_bus_naming::AccountNames;
use cortexkit_bus_nats::{ConnectConfig, NatsConnection};
use cortexkit_bus_trait::{BusError, ContentDigest, Headers, PublishReceipt, Stream};
use serde::Deserialize;
use serde_json::{json, Value};
use subc_client_rs::{CallOptions, ConsumerIdentity, ConsumerOptions, SubcConsumer};
use subc_protocol::{BindIdentity, RouteTarget};

use crate::context_db::ContextDb;
use crate::docs_proposals::{self as proposals, Proposal};

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
/// credentials and signs connection nonces.
pub struct CredentialRoute {
    consumer: SubcConsumer,
    identity: BindIdentity,
    principal: ConsumerIdentity,
}

impl CredentialRoute {
    /// Connect to the daemon at `path` as this module.
    pub async fn connect(path: &Path) -> Result<Self, String> {
        let nonce = subc_client_rs::launch_nonce()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "ck-mc launch nonce absent".to_string())?;
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
            principal: ConsumerIdentity {
                module_id: crate::MODULE_ID.into(),
                launch_nonce: nonce.value().to_owned(),
            },
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
                    consumer_identity: Some(self.principal.clone()),
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

/// A connection to the bus with the credential it was opened with.
pub(crate) struct BusSession {
    credential: Option<Credential>,
    account: AccountNames,
    publisher: Box<dyn EventPublisher>,
    route: Option<Arc<dyn CredentialProvider>>,
}

impl BusSession {
    /// A session over `publisher` in `account`, with no credential to renew.
    #[cfg(test)]
    pub(crate) fn fixed(account: AccountNames, publisher: Box<dyn EventPublisher>) -> Self {
        Self {
            credential: None,
            account,
            publisher,
            route: None,
        }
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
        publisher: Box::new(NatsEventPublisher {
            connection,
            stream_name,
        }),
        route: Some(route),
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

/// The module's publisher of `docs_proposal` notices, kept across the
/// dreamer's rounds.
pub struct DocsNotices {
    factory: Arc<dyn SessionFactory>,
    session: tokio::sync::Mutex<Option<BusSession>>,
    /// Whether the current outage was logged, so it is logged once.
    logged: AtomicBool,
}

impl DocsNotices {
    /// Notices published through ck-bus, reached over the daemon whose
    /// connection file is `path`.
    pub fn through_ckbus(path: PathBuf) -> Self {
        Self::with_factory(Arc::new(ProductionSessions { path }))
    }

    pub(crate) fn with_factory(factory: Arc<dyn SessionFactory>) -> Self {
        Self {
            factory,
            session: tokio::sync::Mutex::new(None),
            logged: AtomicBool::new(false),
        }
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
        let mut session = self.session.lock().await;
        let result = async {
            if session.is_none() {
                *session = Some(self.factory.open().await?);
            }
            let active = session.as_mut().expect("opened session");
            if active
                .credential
                .as_ref()
                .is_some_and(|credential| credential.exp - now_ms() / 1000 < RENEW_WITHIN_S)
            {
                self.factory.renew(active).await?;
            }
            publish_pending(db, &active.account, active.publisher.as_ref()).await
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
                *session = None;
                if !self.logged.swap(true, Ordering::Relaxed) {
                    tracing::warn!(
                        "ck-mc: bus: docs proposal notices wait unsent until the bus is reachable: {error}"
                    );
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "bus_tests.rs"]
pub(crate) mod tests;
