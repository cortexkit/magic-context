//! API keys read from the CortexKit vault (claustrum).
//!
//! A secret setting in the user's configuration file (`embedding.api_key`,
//! `rerank.api_key`) may name a vault credential instead of holding the key,
//! as `"{vault:apikey:voyage}"`. ck-mc then reads the key with a scoped read
//! (`credential.get_scoped`) under its own principal, over the SDK consumer it
//! already holds, and keeps it in memory only:
//!
//! - The first read happens when ck-mc starts (or when the setting first
//!   names the credential), and the key is read again every five minutes, so
//!   a key rotated in place is picked up. The vault's change watch is not
//!   used: it stays silent when a static key is rotated in place.
//! - When the provider answers 401, the key is read again at once and the
//!   request is sent once more. When the provider refuses that key too, ck-mc
//!   reports its record version to the vault (`report_auth_failure`), which
//!   marks the credential `needs_reauth` for the person to see, and sends
//!   that version no more; the five-minute reads pick up the next one.
//! - A vault that cannot answer (a transient error, or `unknown_module` while
//!   the vault module is not up) is read again with backoff, and the key read
//!   before keeps serving. With no key yet, a request that needs one fails the
//!   way a timed-out request does: no vector for that call, and search answers
//!   from words. Nothing about the embedding identity, the stored vectors or
//!   the index changes, because the setting still names a key.
//! - A refusal (an unknown credential id, a missing read grant, a revoked
//!   credential) is a configuration problem: ck-mc stops sending the key,
//!   logs the problem once each time it changes, and keeps checking at the
//!   five-minute pace.
//!
//! The key's text is never written to a store, a log line, an error message
//! or `Debug` output, and it lives in buffers that are wiped when dropped.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use cortexkit_claustrum_client::{
    ClaustrumCredentialResolver, CredentialErrorClass, CredentialResolver, CredentialResolverError,
    ResolvedCredential,
};
use zeroize::Zeroizing;

/// A secret's text, wiped from memory when dropped.
pub type Secret = Zeroizing<String>;

/// How often a held key is read again, and how long to wait before reading
/// again after the vault could not answer: `retry_first`, doubling up to
/// `retry_longest`.
#[derive(Clone, Copy, Debug)]
pub struct Timing {
    pub refresh: Duration,
    pub retry_first: Duration,
    pub retry_longest: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            refresh: Duration::from_secs(5 * 60),
            retry_first: Duration::from_secs(1),
            retry_longest: Duration::from_secs(60),
        }
    }
}

/// One credential as the vault served it.
pub struct Credential {
    pub secret: Secret,
    /// The vault's record version of this value.
    pub version: String,
}

impl std::fmt::Debug for Credential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credential")
            .field("version", &self.version)
            .finish_non_exhaustive()
    }
}

/// Whether a failed read is worth trying again soon.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadErrorKind {
    /// The vault could not answer now (not reachable, not up yet, busy).
    Unavailable,
    /// The vault refused the read; the person has to change the
    /// configuration, the grant or the credential.
    Refused,
}

/// Why a vault read failed: a stable code, and a description that is safe
/// to log (the vault's own error text, never the credential's value).
#[derive(Clone, Debug)]
pub struct ReadError {
    pub kind: ReadErrorKind,
    code: String,
    detail: String,
}

impl ReadError {
    pub fn unavailable(code: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            kind: ReadErrorKind::Unavailable,
            code: code.into(),
            detail: detail.into(),
        }
    }

    pub fn refused(code: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            kind: ReadErrorKind::Refused,
            code: code.into(),
            detail: detail.into(),
        }
    }

    /// The same problem as `other`, for logging each problem once: the
    /// description may differ between two reads that fail the same way.
    fn same_problem(&self, other: &Self) -> bool {
        self.kind == other.kind && self.code == other.code
    }
}

impl std::fmt::Display for ReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.detail)
    }
}

/// Where keys are read: the vault over ck-mc's consumer ([`Claustrum`]),
/// or a stand-in in tests.
#[async_trait::async_trait]
pub trait Source: Send + Sync {
    /// Read the credential `credential_id` under ck-mc's own principal.
    async fn read(&self, credential_id: &str) -> Result<Credential, ReadError>;

    /// Tell the vault the provider refused `version` of `credential_id`
    /// with HTTP `status`.
    async fn report_auth_failure(
        &self,
        credential_id: &str,
        version: &str,
        status: u16,
    ) -> Result<(), ReadError>;
}

/// The vault credentials ck-mc's settings name, each held once for the
/// whole process. Settings build their providers again for every session
/// and pass, so the keys live here rather than in a provider.
pub struct Vault {
    source: Option<Arc<dyn Source>>,
    timing: Timing,
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    keys: HashMap<String, Arc<HeldKey>>,
    /// Set by [`Vault::start`]: the runtime the reads run on. Until then a
    /// named key is only recorded.
    runtime: Option<tokio::runtime::Handle>,
}

impl Vault {
    pub fn new(source: Arc<dyn Source>) -> Arc<Self> {
        Self::with_timing(source, Timing::default())
    }

    pub fn with_timing(source: Arc<dyn Source>, timing: Timing) -> Arc<Self> {
        Arc::new(Self {
            source: Some(source),
            timing,
            inner: Mutex::default(),
        })
    }

    /// No vault to read from (an offline command, a test that needs none):
    /// a named key is never read, so a request that needs it fails as one
    /// with no key yet does.
    pub fn none() -> Arc<Self> {
        Arc::new(Self {
            source: None,
            timing: Timing::default(),
            inner: Mutex::default(),
        })
    }

    /// Start reading: every key named so far is read now, and a key named
    /// later as soon as it is named. Call it inside the runtime, after ck-mc
    /// has registered with the daemon, because the consumer the reads go
    /// over is bound with a claim minted on that registration.
    pub fn start(&self) {
        if self.source.is_none() {
            return;
        }
        let mut inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        if inner.runtime.is_some() {
            return;
        }
        let runtime = tokio::runtime::Handle::current();
        for key in inner.keys.values() {
            spawn_reads(&runtime, Arc::clone(key), self.timing);
        }
        inner.runtime = Some(runtime);
    }

    /// The key held for `credential_id`, recorded the first time it is
    /// named (and read from then on, once the vault has started).
    pub(crate) fn key(&self, credential_id: &str) -> Arc<HeldKey> {
        let mut inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(key) = inner.keys.get(credential_id) {
            return Arc::clone(key);
        }
        let key = Arc::new(HeldKey {
            id: credential_id.to_owned(),
            source: self.source.clone(),
            state: Mutex::default(),
            reading: tokio::sync::Mutex::new(()),
        });
        if let Some(runtime) = &inner.runtime {
            spawn_reads(runtime, Arc::clone(&key), self.timing);
        }
        inner
            .keys
            .insert(credential_id.to_owned(), Arc::clone(&key));
        key
    }
}

/// Read `key` now, then again every `timing.refresh`, or sooner with backoff
/// while the vault cannot answer. The task lives as long as the process.
fn spawn_reads(runtime: &tokio::runtime::Handle, key: Arc<HeldKey>, timing: Timing) {
    runtime.spawn(async move {
        let mut retry = timing.retry_first;
        loop {
            let wait = match key.read().await {
                Err(error) if error.kind == ReadErrorKind::Unavailable => {
                    let wait = retry;
                    retry = (retry * 2).min(timing.retry_longest);
                    wait
                }
                _ => {
                    retry = timing.retry_first;
                    timing.refresh
                }
            };
            tokio::time::sleep(wait).await;
        }
    });
}

/// One vault credential a setting names, and what ck-mc holds of it.
pub struct HeldKey {
    id: String,
    source: Option<Arc<dyn Source>>,
    state: Mutex<KeyState>,
    /// One read at a time: a scheduled read and the read after a 401 wait
    /// for each other rather than both asking the vault.
    reading: tokio::sync::Mutex<()>,
}

impl std::fmt::Debug for HeldKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HeldKey")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

#[derive(Default)]
struct KeyState {
    held: Option<Credential>,
    /// The problem logged last, so each is logged once until it changes.
    problem: Option<ReadError>,
    /// The record version the provider refused twice and the vault was told
    /// about; it is not sent again.
    refused_version: Option<String>,
}

impl HeldKey {
    /// The credential id the setting names.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// The key to send now, or `None` while ck-mc holds none it may send:
    /// not read yet, refused by the vault, or a version the provider refused.
    pub(crate) fn current(&self) -> Option<KeyInUse> {
        let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        let held = state.held.as_ref()?;
        if state.refused_version.as_deref() == Some(held.version.as_str()) {
            return None;
        }
        Some(KeyInUse {
            secret: held.secret.clone(),
            version: Some(held.version.clone()),
        })
    }

    /// Read the credential from the vault now and keep what the vault says.
    async fn read(&self) -> Result<(), ReadError> {
        let _one_read = self.reading.lock().await;
        self.read_now().await
    }

    /// Read again after the provider refused `used`, unless another request
    /// already did since `used` was taken, so that the key held now differs.
    async fn read_after_refusal(&self, used: &KeyInUse) {
        let _one_read = self.reading.lock().await;
        let unchanged = {
            let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            state.held.as_ref().map(|held| held.version.as_str()) == used.version.as_deref()
        };
        if unchanged {
            let _ = self.read_now().await;
        }
    }

    async fn read_now(&self) -> Result<(), ReadError> {
        let result = match &self.source {
            Some(source) => source.read(&self.id).await,
            None => Err(ReadError::unavailable(
                "no_vault",
                "ck-mc has no vault connection in this process",
            )),
        };
        self.keep(result)
    }

    fn keep(&self, result: Result<Credential, ReadError>) -> Result<(), ReadError> {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        match result {
            Ok(credential) => {
                let new_version = state
                    .held
                    .as_ref()
                    .is_none_or(|held| held.version != credential.version);
                if state.problem.take().is_some() || new_version {
                    tracing::info!(
                        "ck-mc: read the API key {} from the vault, record version {}",
                        self.id,
                        credential.version
                    );
                }
                state.held = Some(credential);
                Ok(())
            }
            Err(error) => {
                // A refusal withdraws the key: the grant may have been
                // revoked on purpose. An unreachable vault does not.
                if error.kind == ReadErrorKind::Refused {
                    state.held = None;
                }
                let logged = state
                    .problem
                    .as_ref()
                    .is_some_and(|problem| problem.same_problem(&error));
                if !logged {
                    log_problem(&self.id, &error, state.held.is_some());
                    state.problem = Some(error.clone());
                }
                Err(error)
            }
        }
    }

    /// The provider refused `used`, a key read again after a first refusal.
    /// Tell the vault, once for each record version, and read once more in
    /// case it already holds a newer one; a version that did not move stays
    /// unsent until a later read finds another.
    async fn report_refused(&self, used: &KeyInUse) {
        let Some(version) = used.version.as_deref() else {
            return;
        };
        {
            let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            if state.refused_version.as_deref() == Some(version) {
                return;
            }
            state.refused_version = Some(version.to_owned());
        }
        tracing::warn!(
            "ck-mc: the provider refused the API key {} at record version {version} again after a fresh read; ck-mc reports it to the vault, which marks it for renewal, and sends that version no more",
            self.id
        );
        if let Some(source) = &self.source {
            if let Err(error) = source.report_auth_failure(&self.id, version, 401).await {
                tracing::warn!(
                    "ck-mc: the vault did not take the report on the API key {} ({error})",
                    self.id
                );
            }
        }
        let _ = self.read().await;
    }
}

fn log_problem(id: &str, error: &ReadError, holding: bool) {
    match (error.kind, holding) {
        (ReadErrorKind::Unavailable, true) => tracing::warn!(
            "ck-mc: the vault could not be read for the API key {id} ({error}); the key read before keeps serving while ck-mc tries again"
        ),
        (ReadErrorKind::Unavailable, false) => tracing::warn!(
            "ck-mc: the vault could not be read for the API key {id} ({error}); requests that need the key fail as timed-out requests do until ck-mc reads it, and it keeps trying"
        ),
        (ReadErrorKind::Refused, _) => tracing::warn!(
            "ck-mc: the vault refused to serve the API key {id} ({error}); check the credential id and that magic-context holds a read grant for it. Requests that need the key fail until then"
        ),
    }
}

/// The key one request sends, and the vault record version it came from
/// (none for a key written in the configuration file).
#[derive(Clone)]
pub(crate) struct KeyInUse {
    secret: Secret,
    version: Option<String>,
}

impl KeyInUse {
    /// The vault record version this key came from.
    #[cfg(test)]
    pub(crate) fn version(&self) -> Option<&str> {
        self.version.as_deref()
    }

    /// The `authorization` header value carrying the key as a bearer token,
    /// marked sensitive so the HTTP client never prints it. `None` when the
    /// key cannot be a header value.
    pub(crate) fn authorization(&self) -> Option<reqwest::header::HeaderValue> {
        let bearer = Zeroizing::new(format!("Bearer {}", self.secret.as_str()));
        let mut value = reqwest::header::HeaderValue::from_str(&bearer).ok()?;
        value.set_sensitive(true);
        Some(value)
    }
}

/// A secret setting's value: text from the configuration file, or a vault
/// credential the user's file names (see [`crate::config`] for which file may
/// name one).
#[derive(Clone)]
pub enum ApiKey {
    /// Written in the configuration file, or expanded there from `{env:}`
    /// or `{file:}`.
    Text(Secret),
    /// `{vault:<credential id>}` in the user's file.
    Vault(Arc<HeldKey>),
}

impl ApiKey {
    /// The key to send now; `None` while a vault key has no value ck-mc may
    /// send.
    pub(crate) fn current(&self) -> Option<KeyInUse> {
        match self {
            Self::Text(text) => Some(KeyInUse {
                secret: text.clone(),
                version: None,
            }),
            Self::Vault(held) => held.current(),
        }
    }
}

impl PartialEq for ApiKey {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Text(a), Self::Text(b)) => a == b,
            (Self::Vault(a), Self::Vault(b)) => a.id == b.id,
            _ => false,
        }
    }
}

impl Eq for ApiKey {}

impl std::fmt::Debug for ApiKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Text(_) => f.write_str("Text(..)"),
            Self::Vault(held) => f.debug_tuple("Vault").field(&held.id).finish(),
        }
    }
}

/// How one send of a request carrying a key ended, as its caller reads the
/// answer.
pub(crate) enum Sent<T> {
    Answered(T),
    /// HTTP 401.
    Unauthorized,
}

/// How a request carrying a key ended.
pub(crate) enum Keyed<T> {
    Answered(T),
    /// A vault key with no value ck-mc may send; nothing was sent.
    NoKey,
    /// The provider refused the key (twice, for a vault key).
    Unauthorized,
}

/// Send a request carrying `key` (no key: without one). When the provider
/// answers 401 to a vault key, read the key again at once and send the
/// request once more; when it refuses the fresh key too, report that version
/// to the vault.
pub(crate) async fn send_with_key<T, F, Fut>(key: Option<&ApiKey>, mut send: F) -> Keyed<T>
where
    F: FnMut(Option<KeyInUse>) -> Fut,
    Fut: Future<Output = Sent<T>>,
{
    let first = match key.map(ApiKey::current) {
        None => None,
        Some(None) => return Keyed::NoKey,
        Some(used) => used,
    };
    match send(first.clone()).await {
        Sent::Answered(answer) => return Keyed::Answered(answer),
        Sent::Unauthorized => {}
    }
    let (Some(ApiKey::Vault(held)), Some(used)) = (key, first) else {
        return Keyed::Unauthorized;
    };
    held.read_after_refusal(&used).await;
    let Some(fresh) = held.current() else {
        return Keyed::Unauthorized;
    };
    match send(Some(fresh.clone())).await {
        Sent::Answered(answer) => Keyed::Answered(answer),
        Sent::Unauthorized => {
            held.report_refused(&fresh).await;
            Keyed::Unauthorized
        }
    }
}

/// The vault itself, read with scoped reads over ck-mc's own consumer, as a
/// module reading under its own principal (`reserved:magic-context`) with an
/// exact read grant for each credential.
pub struct Claustrum {
    consumer: crate::transport::SharedConsumer,
    resolver: tokio::sync::OnceCell<ClaustrumCredentialResolver>,
}

impl Claustrum {
    pub fn over(consumer: crate::transport::SharedConsumer) -> Self {
        Self {
            consumer,
            resolver: tokio::sync::OnceCell::new(),
        }
    }

    async fn resolver(&self) -> Result<&ClaustrumCredentialResolver, ReadError> {
        self.resolver
            .get_or_try_init(|| async {
                let consumer = self.consumer.get().await.map_err(|error| {
                    ReadError::unavailable("connect", format!("daemon connection: {error}"))
                })?;
                Ok(ClaustrumCredentialResolver::with_consumer(Arc::clone(
                    consumer,
                )))
            })
            .await
    }
}

#[async_trait::async_trait]
impl Source for Claustrum {
    async fn read(&self, credential_id: &str) -> Result<Credential, ReadError> {
        let credential = self
            .resolver()
            .await?
            .get_scoped(credential_id)
            .await
            .map_err(|error| classify(&error))?;
        decode(&credential)
    }

    async fn report_auth_failure(
        &self,
        credential_id: &str,
        version: &str,
        status: u16,
    ) -> Result<(), ReadError> {
        let version = version.parse::<u64>().map_err(|_| {
            ReadError::refused("record_version", "the record version is not a number")
        })?;
        self.resolver()
            .await?
            .report_auth_failure(credential_id, version, status)
            .await
            .map(|_| ())
            .map_err(|error| classify(&error))
    }
}

/// Sort a vault error: what a later read may cure (the vault not reachable
/// or not up, which includes `unknown_module`, or busy) against a refusal
/// the person has to fix. The description is the client's own text, which
/// never carries a credential's value.
fn classify(error: &CredentialResolverError) -> ReadError {
    match error.class {
        CredentialErrorClass::Transient
        | CredentialErrorClass::Transport
        | CredentialErrorClass::Unavailable
        | CredentialErrorClass::InvalidResponse => {
            ReadError::unavailable(error.code(), error.to_string())
        }
        _ => ReadError::refused(error.code(), error.to_string()),
    }
}

/// A served credential as an API key: its bytes as text, without the
/// whitespace a pasted key often ends with.
fn decode(credential: &ResolvedCredential) -> Result<Credential, ReadError> {
    let text = std::str::from_utf8(credential.expose())
        .map_err(|_| ReadError::refused("not_text", "the credential is not text"))?
        .trim();
    if text.is_empty() {
        return Err(ReadError::refused("empty", "the credential is empty"));
    }
    Ok(Credential {
        secret: Zeroizing::new(text.to_owned()),
        version: credential.record_version.clone(),
    })
}
