//! Embeddings from a Synapse module: the provider behind `embedding.provider`
//! `synapse`, `local` and unset.
//!
//! Synapse serves each embedding model on one lane per GPU backend:
//! `<model>-ane` and `<model>-metal` on Apple, `<model>-cuda` and
//! `<model>-vulkan` on Linux and Windows. Each lane has its own fingerprint,
//! and vectors from two lanes live in different spaces. So ck-mc uses one
//! lane: from `models.list`, the first of the model's lanes whose
//! `serving_admission` is `enabled`, in that order, and it pins that lane's
//! fingerprint. The gate is `serving_admission`, not `certified`, for the
//! reason the reranker gives ([`crate::search::rerank::pin`]).
//!
//! The lane is part of the vectors' identity: `synapse:v1:` and the SHA-256
//! of the stable JSON of `{fingerprint, model}`, the formula 0.49 used, with
//! the lane's catalog id as the model. Another lane is another identity, so
//! upkeep embeds everything again in the background, and two lanes' vectors
//! are never compared with each other.
//!
//! Every request names the lane and its fingerprint (`required_fingerprint`),
//! and a reply that carries another fingerprint is refused. Queries get the
//! Qwen3 instruction ([`QUERY_INSTRUCTION`]); documents are sent as they are,
//! since Synapse adds no prefix of its own. Each input is cut to fit the
//! lane's token limit before it is sent: Synapse refuses a longer input
//! (`sequence_too_long`) instead of cutting it.
//!
//! When no lane serves (no Synapse module, no supported GPU, the model not
//! downloaded, or no lane of the model admits requests), search uses words
//! only. The cause is logged once, and again when it changes, with what fixes
//! it. ck-mc never downloads a model. While no lane serves, the catalog is
//! listed again at most once a minute.
//!
//! One [`Link`] carries a process's calls to Synapse (the module makes it
//! over its runner client) and keeps the lane chosen for each module and
//! model. A [`Synapse`] provider is resolved from the settings for each pass,
//! search, upkeep round or dreamer run. It keeps the first lane it learns of
//! for its whole life, so the id it reads and writes vectors under is always
//! the id of the lane that made them.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::Duration;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::time::Instant;

use crate::client::RunnerClient;

/// The model a Synapse provider embeds with when `embedding.model` names
/// none, or names one the module's catalog doesn't list. Synapse's own
/// default is a different model, so every request names the model.
pub const DEFAULT_MODEL: &str = "qwen3-embedding-0.6b";
/// A model's lane suffixes, in the order ck-mc prefers them.
pub const LANE_ORDER: [&str; 4] = ["ane", "metal", "cuda", "vulkan"];
/// What a search query is prefixed with, for both Synapse embedding models.
/// Stored documents get no prefix.
pub const QUERY_INSTRUCTION: &str = "Instruct: Given a question about a software project, retrieve the saved memories and conversation history that answer it\nQuery: ";
/// While no lane serves, the catalog is listed at most this often.
const RELIST_AFTER: Duration = Duration::from_secs(60);
/// The longest one `models.list` call may take.
const CATALOG_DEADLINE: Duration = Duration::from_secs(5);
/// A lane's input limit when its catalog row names none: both Synapse
/// embedding models take 8,192 tokens.
const DEFAULT_MAX_TOKENS: u64 = 8_192;
/// Tokens of the limit left for the start and end tokens the model adds.
const SPECIAL_TOKENS: u64 = 16;
/// Texts per `embed.batch` call when the lane's row recommends no number.
const DEFAULT_BATCH: usize = 16;
const MAX_BATCH: usize = 64;
/// How long a `model_loading` refusal that names no wait is waited out.
const LOADING_WAIT: Duration = Duration::from_millis(250);
/// How long to wait before asking `embed.result` again after an empty page.
const EMPTY_PAGE_WAIT: Duration = Duration::from_millis(50);
/// The id a provider with no serving lane reports. Nothing is stored under
/// it, since such a provider embeds nothing, so a search with it finds no
/// vectors.
const PENDING: &str = "synapse:v1:pending";
/// Refusals that mean the pinned lane no longer serves the fingerprint it
/// was pinned with, so the lanes are listed again.
const LANE_GONE: [&str; 7] = [
    "substitution_rejected",
    "fingerprint_mismatch",
    "migration_required",
    "not_certified",
    "probe_required",
    "remote_identity_drift",
    "remote_deployment_changed",
];

/// A Synapse call that got no usable answer: the module's refusal code, or a
/// fixed one such as `missing_synapse` when ck-mc couldn't reach the module,
/// and how long to wait before trying again when the refusal says so.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub code: String,
    pub retry_after: Option<Duration>,
}

impl Refusal {
    pub fn new(code: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            retry_after: None,
        }
    }

    /// A refusal whose error `detail` may carry `retry_after_ms`.
    pub fn from_detail(code: impl Into<String>, detail: Option<&Value>) -> Self {
        Self {
            code: code.into(),
            retry_after: detail.and_then(retry_after),
        }
    }
}

fn retry_after(value: &Value) -> Option<Duration> {
    value
        .get("retry_after_ms")
        .and_then(Value::as_u64)
        .map(Duration::from_millis)
}

type Answer = Pin<Box<dyn Future<Output = Result<Value, Refusal>> + Send>>;

/// How a [`Link`] reaches Synapse.
trait Call: Send + Sync {
    fn call(&self, module: &str, method: &'static str, params: Value, timeout: Duration) -> Answer;
}

/// Synapse through the runner client's
/// [`RunnerClient::synapse_embedding_call`].
struct Client<C>(Arc<C>);

impl<C: RunnerClient + Send + Sync + 'static> Call for Client<C> {
    fn call(&self, module: &str, method: &'static str, params: Value, timeout: Duration) -> Answer {
        let (client, module) = (Arc::clone(&self.0), module.to_owned());
        Box::pin(async move {
            client
                .synapse_embedding_call(&module, method, params, timeout)
                .await
        })
    }
}

/// A process's calls to Synapse for embeddings, and the lane chosen for each
/// module and model.
pub struct Link {
    call: Box<dyn Call>,
    choices: Mutex<HashMap<(String, String), Choice>>,
    /// Failures already logged, by method and code, so a module that fails
    /// the same way again doesn't log on every search.
    logged: Mutex<HashSet<String>>,
}

/// What ck-mc knows of one module's lanes for one configured model.
#[derive(Default)]
struct Choice {
    /// The lane in use, while it serves.
    lane: Option<Lane>,
    /// When the catalog was last listed, or a lane last stopped serving.
    listed: Option<Instant>,
    /// Why no lane serves, as last logged.
    cause: Option<Cause>,
    /// The identity of the lane pinned last, so a new lane is logged once.
    last: Option<String>,
    /// Whether the log says that the configured model isn't in the catalog.
    ignored_logged: bool,
}

impl Link {
    /// A link that calls Synapse through `client`.
    pub fn over<C: RunnerClient + Send + Sync + 'static>(client: Arc<C>) -> Arc<Self> {
        Arc::new(Self {
            call: Box::new(Client(client)),
            choices: Mutex::default(),
            logged: Mutex::default(),
        })
    }

    fn with_choice<T>(&self, module: &str, model: &str, f: impl FnOnce(&mut Choice) -> T) -> T {
        let mut choices = self.choices.lock().unwrap_or_else(PoisonError::into_inner);
        f(choices
            .entry((module.to_owned(), model.to_owned()))
            .or_default())
    }

    /// The lane `module` serves `model` on now, without asking it.
    fn pinned(&self, module: &str, model: &str) -> Option<Lane> {
        self.with_choice(module, model, |choice| choice.lane.clone())
    }

    /// The lane `module` serves `model` on: the pinned one, or the first
    /// admitted lane the catalog lists, unless the catalog was listed less
    /// than a minute ago.
    async fn lane(self: &Arc<Self>, module: &str, model: &str) -> Option<Lane> {
        let list = self.with_choice(module, model, |choice| {
            if let Some(lane) = &choice.lane {
                return Err(Some(lane.clone()));
            }
            if choice.listed.is_some_and(|at| at.elapsed() < RELIST_AFTER) {
                return Err(None);
            }
            choice.listed = Some(Instant::now());
            Ok(())
        });
        if let Err(known) = list {
            return known;
        }
        let link = Arc::clone(self);
        let (module, model) = (module.to_owned(), model.to_owned());
        let listing = async move { link.list(&module, &model).await };
        // Spawned, so that a caller that stops waiting (an automatic search
        // with a short budget) doesn't lose an answer the next minute of
        // searches depends on.
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => runtime.spawn(listing).await.ok().flatten(),
            Err(_) => listing.await,
        }
    }

    /// List the catalog and pin `model`'s lane, or record why none serves.
    async fn list(&self, module: &str, model: &str) -> Option<Lane> {
        let answer = self
            .call
            .call(module, "models.list", json!({}), CATALOG_DEADLINE)
            .await
            .and_then(body);
        let (chosen, ignored) = match answer {
            Ok(catalog) => choose(&catalog, model),
            Err(refusal) => match Cause::of(&refusal.code, model) {
                Some(cause) => (Err(cause), false),
                None => {
                    self.note_failure("models.list", &refusal.code);
                    return None;
                }
            },
        };
        self.with_choice(module, model, |choice| {
            if ignored && !std::mem::replace(&mut choice.ignored_logged, true) {
                tracing::info!(
                    ?model,
                    %module,
                    fallback_model = %DEFAULT_MODEL,
                    "ck-mc: embedding.model is not an embedding model listed by the Synapse module; using the default instead"
                );
            }
            match chosen {
                Ok(lane) => {
                    let identity = lane.identity();
                    match choice.last.replace(identity.clone()) {
                        Some(last) if last != identity => tracing::info!(
                            lane_id = %lane.id,
                            %module,
                            "ck-mc: embeddings switched to a Synapse lane; vectors from the previous lane are set aside and upkeep embeds again in the background"
                        ),
                        Some(_) => {}
                        None => tracing::info!(
                            lane_id = %lane.id,
                            %module,
                            "ck-mc: embeddings use a Synapse lane"
                        ),
                    }
                    choice.lane = Some(lane.clone());
                    Some(lane)
                }
                Err(cause) => {
                    choice.record(module, cause);
                    None
                }
            }
        })
    }

    /// Stop using `lane`, which refused with `code` or answered for another
    /// fingerprint. With a `cause`, no lane serves until the catalog is listed
    /// again a minute from now.
    fn forget(&self, module: &str, model: &str, lane: &Lane, code: &str, cause: Option<Cause>) {
        self.with_choice(module, model, |choice| {
            let pinned = choice.lane.as_ref() == Some(lane);
            if pinned {
                choice.lane = None;
            }
            match cause {
                Some(cause) => {
                    choice.listed = Some(Instant::now());
                    choice.record(module, cause);
                }
                None if pinned => tracing::info!(
                    lane_id = %lane.id,
                    %module,
                    %code,
                    "ck-mc: a Synapse lane no longer serves its fingerprint; listing the module's lanes again"
                ),
                None => {}
            }
        });
    }

    /// Record that `lane` answered. A cause logged before is over, which
    /// is logged once.
    fn served(&self, module: &str, model: &str, lane: &Lane) {
        self.with_choice(module, model, |choice| {
            if choice.cause.take().is_some() {
                tracing::info!(
                    lane_id = %lane.id,
                    %module,
                    "ck-mc: semantic search is on again: a Synapse lane is serving"
                );
            }
        });
    }

    /// Log a failure that leaves the lane in use, once for each method and
    /// code.
    fn note_failure(&self, method: &str, code: &str) {
        let key = format!("{method}:{code}");
        if self
            .logged
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(key)
        {
            tracing::warn!(
                %method,
                %code,
                "ck-mc: a Synapse method for embeddings failed; that request falls back to words only"
            );
        }
    }

    /// One call on `lane`, waiting out `model_loading` until `deadline`. A
    /// reply is returned only when it comes from the lane's fingerprint.
    async fn send(
        &self,
        module: &str,
        model: &str,
        lane: &Lane,
        method: &'static str,
        params: &Value,
        deadline: Instant,
    ) -> Result<Value, Failure> {
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(Failure::TimedOut);
            }
            let answer = self
                .call
                .call(module, method, params.clone(), left)
                .await
                .and_then(body);
            let refusal = match answer {
                Ok(reply) if lane.made(&reply) => {
                    self.served(module, model, lane);
                    return Ok(reply);
                }
                Ok(_) => {
                    tracing::warn!(
                        %method,
                        lane_id = %lane.id,
                        "ck-mc: a Synapse reply had a different fingerprint than the lane's; the vectors are refused"
                    );
                    self.forget(module, model, lane, "fingerprint_mismatch", None);
                    return Err(Failure::Failed);
                }
                Err(refusal) => refusal,
            };
            if refusal.code == "model_loading" {
                tokio::time::sleep(refusal.retry_after.unwrap_or(LOADING_WAIT).min(left)).await;
                continue;
            }
            let cause = Cause::of(&refusal.code, &lane.model);
            let unavailable = cause.is_some();
            if unavailable || LANE_GONE.contains(&refusal.code.as_str()) {
                self.forget(module, model, lane, &refusal.code, cause);
            } else {
                self.note_failure(method, &refusal.code);
            }
            return Err(if unavailable {
                Failure::Unavailable
            } else if refusal.code == "deadline_exceeded" {
                Failure::TimedOut
            } else {
                Failure::Failed
            });
        }
    }

    /// Every row of batch job `job`'s results, page by page.
    async fn results(
        &self,
        module: &str,
        model: &str,
        lane: &Lane,
        job: &str,
        key: &str,
        deadline: Instant,
    ) -> Result<Vec<Value>, Failure> {
        let mut cursor = Value::Null;
        let mut found = Vec::new();
        loop {
            let mut params = json!({"job_id": job, "cursor": cursor, "request_key": key});
            lane.constrain(&mut params);
            let page = self
                .send(module, model, lane, "embed.result", &params, deadline)
                .await?;
            let rows = rows(&page).cloned().unwrap_or_default();
            let empty = rows.is_empty();
            found.extend(rows);
            let next = page
                .get("next_cursor")
                .or_else(|| page.get("cursor"))
                .filter(|next| !next.is_null())
                .cloned();
            let done = page["done"] == true || page["complete"] == true;
            match next {
                Some(next) if !done => {
                    if empty {
                        tokio::time::sleep(EMPTY_PAGE_WAIT).await;
                    }
                    cursor = next;
                }
                _ => return Ok(found),
            }
        }
    }
}

/// Why no lane serves.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Cause {
    /// No Synapse module by that id answers, or ck-mc can't reach the daemon.
    NoModule,
    /// `backend_unavailable`: Synapse supports no GPU on this machine.
    NoBackend,
    /// `model_not_installed`: the model was never downloaded.
    NotInstalled(String),
    /// The catalog lists no lane of the model that admits requests.
    NoLane(String),
}

impl Cause {
    /// The cause a refusal `code` names, for `model`; `None` for a refusal
    /// that leaves the lane in use, such as a deadline.
    fn of(code: &str, model: &str) -> Option<Self> {
        match code {
            "unknown_module" | "missing_synapse" => Some(Self::NoModule),
            "backend_unavailable" => Some(Self::NoBackend),
            "model_not_installed" => Some(Self::NotInstalled(model.to_owned())),
            _ => None,
        }
    }

    /// Log the cause with what fixes it.
    fn log(&self, module: &str) {
        let size = |model: &str| {
            if model == DEFAULT_MODEL {
                " (about 1.2 GB)"
            } else {
                ""
            }
        };
        match self {
            Self::NoModule => tracing::info!(
                %module,
                "ck-mc: semantic search is off: the Synapse module does not answer, so search uses words only. To embed without Synapse, set an HTTP endpoint in `embedding` (provider \"openai-compatible\")"
            ),
            Self::NoBackend => tracing::info!(
                %module,
                "ck-mc: semantic search is off: the Synapse module has no supported GPU on this machine (backend_unavailable), so search uses words only. To embed without Synapse, set an HTTP endpoint in `embedding` (provider \"openai-compatible\")"
            ),
            Self::NotInstalled(model) => tracing::info!(
                %module,
                %model,
                download_size = %size(model),
                "ck-mc: semantic search is off: the Synapse module has not downloaded the model (model_not_installed), so search uses words only. Download the model with `ck-synapse-opctl models download`"
            ),
            Self::NoLane(model) => tracing::info!(
                %module,
                %model,
                download_size = %size(model),
                "ck-mc: semantic search is off: the Synapse module lists no lane for the model that admits requests, so search uses words only. Download the model with `ck-synapse-opctl models download`, or set an HTTP endpoint in `embedding` (provider \"openai-compatible\")"
            ),
        }
    }
}

impl Choice {
    /// Make `cause` the reason no lane serves, logging it when it changed.
    fn record(&mut self, module: &str, cause: Cause) {
        if self.cause.as_ref() != Some(&cause) {
            cause.log(module);
            self.cause = Some(cause);
        }
    }
}

/// One lane of a model, as the catalog lists it.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Lane {
    /// The lane's id in the catalog, such as `qwen3-embedding-0.6b-ane`.
    id: String,
    /// The model the lane serves, such as `qwen3-embedding-0.6b`.
    model: String,
    fingerprint: String,
    /// The catalog's table epoch, sent as `required_epoch` when known.
    table_epoch: Option<i64>,
    /// The most input tokens the lane takes.
    max_tokens: u64,
    /// Texts per `embed.batch` call.
    batch: usize,
}

impl Lane {
    /// The lane in catalog `row`, when the row admits requests and names
    /// exactly one fingerprint.
    fn admitted(row: &Value, id: &str, model: &str, envelope_epoch: Option<i64>) -> Option<Self> {
        if row["serving_admission"].as_str() != Some("enabled") {
            return None;
        }
        let fingerprint = match row.get("fingerprints").and_then(Value::as_array) {
            Some(fingerprints) => match fingerprints.as_slice() {
                [only] => only.as_str()?,
                _ => return None,
            },
            None => row["fingerprint"].as_str()?,
        };
        if fingerprint.is_empty()
            || fingerprint
                .chars()
                .any(|ch| ch.is_whitespace() || ch.is_control())
        {
            return None;
        }
        let batch = match &row["recommended_batch"] {
            Value::Object(policy) => policy.get("rows").and_then(crate::config::integer),
            value => crate::config::integer(value),
        };
        Some(Self {
            id: id.to_owned(),
            model: model.to_owned(),
            fingerprint: fingerprint.to_owned(),
            table_epoch: row["table_epoch"].as_i64().or(envelope_epoch),
            max_tokens: crate::config::integer(&row["max_tokens"])
                .filter(|tokens| *tokens > SPECIAL_TOKENS)
                .unwrap_or(DEFAULT_MAX_TOKENS),
            batch: batch.map_or(DEFAULT_BATCH, |rows| {
                rows.clamp(1, MAX_BATCH as u64) as usize
            }),
        })
    }

    fn identity(&self) -> String {
        identity(&self.id, &self.fingerprint)
    }

    /// The most bytes one input may have. Both models' tokenizers are
    /// byte-level, so every token covers at least one byte, and an input of
    /// this many bytes stays within the lane's limit whatever its text.
    fn input_bytes(&self) -> usize {
        self.max_tokens.saturating_sub(SPECIAL_TOKENS).max(1) as usize
    }

    /// Name the lane, its fingerprint and its table epoch in a request.
    fn constrain(&self, params: &mut Value) {
        params["model"] = json!(self.id);
        params["required_fingerprint"] = json!(self.fingerprint);
        if let Some(epoch) = self.table_epoch {
            params["required_epoch"] = json!(epoch);
        }
        params["allow_equivalent"] = json!(false);
    }

    /// Whether `reply` comes from this lane: every fingerprint and table
    /// epoch it names, at the top or on a vector row, is the lane's, and
    /// every vector row is covered by a fingerprint.
    fn made(&self, reply: &Value) -> bool {
        fn named(value: &Value) -> Option<&str> {
            value
                .get("fingerprint")
                .or_else(|| value.get("served_fingerprint"))
                .and_then(Value::as_str)
        }
        let epoch = |value: &Value| match (
            value.get("table_epoch").and_then(Value::as_i64),
            self.table_epoch,
        ) {
            (Some(served), Some(pinned)) => served == pinned,
            _ => true,
        };
        let envelope = named(reply);
        if envelope.is_some_and(|served| served != self.fingerprint) || !epoch(reply) {
            return false;
        }
        rows(reply).is_none_or(|rows| {
            rows.iter()
                .all(|row| named(row).or(envelope) == Some(self.fingerprint.as_str()) && epoch(row))
        })
    }
}

/// A lane's vector identity, by 0.49's formula: `synapse:v1:` and the
/// SHA-256 of the stable JSON (keys sorted) of `{model, fingerprint}`.
fn identity(model: &str, fingerprint: &str) -> String {
    let stable = format!(
        "{{\"fingerprint\":{},\"model\":{}}}",
        json!(fingerprint),
        json!(model)
    );
    format!("synapse:v1:{:x}", Sha256::digest(stable.as_bytes()))
}

/// The lane of `configured` to use from a `models.list` body, or why none
/// serves, and whether `configured` was set aside because the catalog
/// doesn't list it (the default model is used in its place).
fn choose(catalog: &Value, configured: &str) -> (Result<Lane, Cause>, bool) {
    let rows = catalog["models"]
        .as_array()
        .or_else(|| catalog["entries"].as_array())
        .map_or(&[][..], Vec::as_slice);
    let id = |row: &Value| {
        row.get("model_id")
            .or_else(|| row.get("model"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    // The model's lane rows, in the order lanes are preferred.
    let lanes = |model: &str| -> Vec<(String, &Value)> {
        let mut found = Vec::new();
        for suffix in LANE_ORDER {
            let lane = format!("{model}-{suffix}");
            for row in rows.iter().filter(|row| id(row) == lane) {
                found.push((lane.clone(), row));
            }
        }
        found
    };
    let (model, ignored) = if lanes(configured).is_empty() {
        (DEFAULT_MODEL, configured != DEFAULT_MODEL)
    } else {
        (configured, false)
    };
    let candidates = lanes(model);
    let epoch = catalog["table_epoch"].as_i64();
    if let Some(lane) = candidates
        .iter()
        .find_map(|(lane, row)| Lane::admitted(row, lane, model, epoch))
    {
        return (Ok(lane), ignored);
    }
    // A lane row may say why it doesn't serve.
    let says = |code: &str| {
        candidates.iter().any(|(_, row)| {
            ["serving_admission", "status", "reason"]
                .iter()
                .any(|key| row[key] == code)
        })
    };
    let cause = if says("model_not_installed") {
        Cause::NotInstalled(model.to_owned())
    } else if says("backend_unavailable") {
        Cause::NoBackend
    } else {
        Cause::NoLane(model.to_owned())
    };
    (Err(cause), ignored)
}

/// A reply's body: its `result` member when it has one, with any `payload`
/// object's members added. A body carrying an `error` is that refusal.
fn body(reply: Value) -> Result<Value, Refusal> {
    let mut reply = reply;
    let mut body = match reply.get_mut("result") {
        Some(result) => result.take(),
        None => reply,
    };
    if let Some(error) = body.get("error") {
        let code = error["code"].as_str().unwrap_or("synapse_error");
        return Err(Refusal {
            code: code.to_owned(),
            retry_after: retry_after(error).or_else(|| error.get("detail").and_then(retry_after)),
        });
    }
    let Value::Object(members) = &mut body else {
        return Err(Refusal::new("validation"));
    };
    if let Some(Value::Object(payload)) = members.remove("payload") {
        members.extend(payload);
    }
    Ok(body)
}

/// A reply's vector rows: `vectors`, `items` or `results`.
fn rows(reply: &Value) -> Option<&Vec<Value>> {
    ["vectors", "items", "results"]
        .iter()
        .find_map(|key| reply.get(*key).and_then(Value::as_array))
}

/// A row's vector, when it is a non-empty list of finite numbers.
fn vector(row: &Value) -> Option<Vec<f32>> {
    let values = row
        .get("vector")
        .or_else(|| row.get("embedding"))?
        .as_array()?;
    let vector: Vec<f32> = values
        .iter()
        .map(|value| value.as_f64().map(|value| value as f32))
        .collect::<Option<_>>()?;
    (!vector.is_empty() && vector.iter().all(|value| value.is_finite())).then_some(vector)
}

/// Cut `input` to at most `limit` bytes at a character boundary, keeping
/// its start.
fn cap_bytes(input: &mut String, limit: usize) {
    if input.len() > limit {
        let mut end = limit;
        while end > 0 && !input.is_char_boundary(end) {
            end -= 1;
        }
        input.truncate(end);
    }
}

fn sha256_hex(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

/// JSON with every object's keys in sorted order, as 0.49's `stableJson`.
fn stable(value: &Value) -> String {
    match value {
        Value::Object(members) => {
            let mut keys: Vec<&String> = members.keys().collect();
            keys.sort();
            let members: Vec<String> = keys
                .into_iter()
                .map(|key| format!("{}:{}", json!(key), stable(&members[key])))
                .collect();
            format!("{{{}}}", members.join(","))
        }
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(stable).collect::<Vec<_>>().join(",")
        ),
        other => other.to_string(),
    }
}

/// The idempotency key of one `embed.batch` page, as 0.49 derived it.
fn request_key(lane: &Lane, ids: &[String], hashes: &[String]) -> String {
    let mut request = json!({
        "op": "embed.batch",
        "ids": ids,
        "content_sha256": hashes,
    });
    lane.constrain(&mut request);
    sha256_hex(&stable(&request))
}

/// How an embedding request ended without vectors.
enum Failure {
    /// No lane serves.
    Unavailable,
    TimedOut,
    Failed,
    /// An answer with no usable vector.
    Unusable,
}

impl Failure {
    fn word(&self) -> &'static str {
        match self {
            Self::Unavailable => "unavailable",
            Self::TimedOut => "timeout",
            Self::Failed => "failed",
            Self::Unusable => "unusable",
        }
    }
}

/// A Synapse embedding provider, as the settings name it.
#[derive(Clone)]
pub struct Synapse {
    /// The Synapse module id: `synapse`, or the user's `embedding.module`.
    module: String,
    /// The model `embedding.model` names, or [`DEFAULT_MODEL`].
    model: String,
    /// `embedding.max_input_tokens`: the size history is chunked to.
    max_input_tokens: Option<u64>,
    /// `None` outside the module, where nothing is embedded.
    link: Option<Arc<Link>>,
    /// The lane this provider uses for its life, set the first time it
    /// learns of one; `Some(None)` when no lane served then, so it embeds
    /// nothing.
    bound: Arc<OnceLock<Option<Lane>>>,
    fetch_timeout: Duration,
    query_timeout: Duration,
}

impl std::fmt::Debug for Synapse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Synapse")
            .field("module", &self.module)
            .field("model", &self.model)
            .finish_non_exhaustive()
    }
}

impl Synapse {
    pub(crate) fn new(
        module: String,
        model: String,
        max_input_tokens: Option<u64>,
        fetch_timeout: Duration,
        query_timeout: Duration,
    ) -> Self {
        Self {
            module,
            model,
            max_input_tokens,
            link: None,
            bound: Arc::default(),
            fetch_timeout,
            query_timeout,
        }
    }

    pub fn module(&self) -> &str {
        &self.module
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    /// This provider, calling Synapse through `link`.
    pub(crate) fn with_link(mut self, link: Arc<Link>) -> Self {
        self.link = Some(link);
        self.bound = Arc::default();
        self
    }

    /// A copy that learns its lane afresh.
    pub(crate) fn unbound(&self) -> Self {
        Self {
            bound: Arc::default(),
            ..self.clone()
        }
    }

    #[cfg(test)]
    pub(crate) fn with_timeouts(mut self, fetch: Duration, query: Duration) -> Self {
        self.fetch_timeout = fetch;
        self.query_timeout = query;
        self
    }

    /// The bound lane, binding this provider now to the lane pinned now when
    /// it has none.
    fn bound_now(&self) -> Option<&Lane> {
        self.bound
            .get_or_init(|| {
                self.link
                    .as_ref()
                    .and_then(|link| link.pinned(&self.module, &self.model))
            })
            .as_ref()
    }

    /// The bound lane, listing the catalog first when this provider has none.
    async fn bound_lane(&self) -> Option<(Arc<Link>, Lane)> {
        let link = self.link.as_ref()?;
        match self.bound.get() {
            Some(Some(lane)) => return Some((Arc::clone(link), lane.clone())),
            Some(None) => {
                // This provider embeds nothing, but the catalog is listed for
                // the providers resolved after it.
                link.lane(&self.module, &self.model).await;
                return None;
            }
            None => {}
        }
        let lane = link.lane(&self.module, &self.model).await;
        self.bound
            .get_or_init(|| lane)
            .clone()
            .map(|lane| (Arc::clone(link), lane))
    }

    /// Learn the lane before the first id is read, so a run that reads ids
    /// before it embeds uses one lane throughout. `false` when no lane serves.
    pub(crate) async fn prepare(&self) -> bool {
        self.bound_lane().await.is_some()
    }

    /// The id this provider's vectors are stored under.
    pub(crate) fn model_id(&self) -> String {
        self.bound_now()
            .map_or_else(|| PENDING.to_owned(), Lane::identity)
    }

    /// [`Self::model_id`], or `None` while no lane serves.
    pub(crate) fn serving_model_id(&self) -> Option<String> {
        self.bound_now().map(Lane::identity)
    }

    /// The size history is chunked to: `embedding.max_input_tokens` or the
    /// default, at most what fits the lane. Chunks are sized at about four
    /// bytes a token and must stay within [`Lane::input_bytes`].
    pub(crate) fn chunk_max_input_tokens(&self) -> u64 {
        let limit = self
            .bound_now()
            .map_or(DEFAULT_MAX_TOKENS, |lane| lane.max_tokens);
        let fits = (limit.saturating_sub(SPECIAL_TOKENS) / 4).max(1);
        self.max_input_tokens
            .unwrap_or(super::DEFAULT_CHUNK_MAX_INPUT_TOKENS)
            .min(fits)
    }

    pub(crate) fn fetch_timeout(&self) -> Duration {
        self.fetch_timeout
    }

    pub(crate) fn query_timeout(&self) -> Duration {
        self.query_timeout
    }

    /// Embed a search query, with [`QUERY_INSTRUCTION`] in front, within
    /// `timeout`, and a word on how it ended (as
    /// [`super::Provider::embed_search_query_traced`]).
    pub(crate) async fn query(
        &self,
        query: &str,
        timeout: Duration,
    ) -> (Option<Vec<f32>>, &'static str) {
        let deadline = Instant::now() + timeout;
        let work = async {
            let (link, lane) = self.bound_lane().await.ok_or(Failure::Unavailable)?;
            let mut text = format!(
                "{QUERY_INSTRUCTION}{}",
                if query.trim().is_empty() { " " } else { query }
            );
            cap_bytes(&mut text, lane.input_bytes());
            let mut params = json!({
                "id": "query",
                "text": text,
                "purpose": "query",
                "deadline_ms": timeout.as_millis() as u64,
            });
            lane.constrain(&mut params);
            let reply = link
                .send(
                    &self.module,
                    &self.model,
                    &lane,
                    "embed.query",
                    &params,
                    deadline,
                )
                .await?;
            let rows = rows(&reply).ok_or(Failure::Unusable)?;
            let row = match rows.as_slice() {
                [only] => only,
                _ => rows
                    .iter()
                    .find(|row| row["id"] == "query")
                    .ok_or(Failure::Unusable)?,
            };
            vector(row).ok_or(Failure::Unusable)
        };
        match tokio::time::timeout(timeout, work).await {
            Ok(Ok(vector)) => (Some(vector), "ok"),
            Ok(Err(failure)) => (None, failure.word()),
            Err(_) => (None, "timeout"),
        }
    }

    /// Embed stored texts as they are, one slot per text in order: `None`
    /// when a request failed, a `None` slot when only that text's vector
    /// came back unusable.
    pub(crate) async fn documents(&self, texts: &[String]) -> Option<Vec<Option<Vec<f32>>>> {
        if texts.is_empty() {
            return Some(Vec::new());
        }
        let deadline = Instant::now() + self.fetch_timeout;
        let work = async {
            let (link, lane) = self.bound_lane().await.ok_or(Failure::Unavailable)?;
            let inputs: Vec<String> = texts
                .iter()
                .map(|text| {
                    let mut input = if text.trim().is_empty() { " " } else { text }.to_owned();
                    cap_bytes(&mut input, lane.input_bytes());
                    input
                })
                .collect();
            let mut slots: Vec<Option<Vec<f32>>> = vec![None; inputs.len()];
            for (page, texts) in inputs.chunks(lane.batch).enumerate() {
                let start = page * lane.batch;
                let ids: Vec<String> = (start..start + texts.len())
                    .map(|index| format!("item:{index}"))
                    .collect();
                let hashes: Vec<String> = texts.iter().map(|text| sha256_hex(text)).collect();
                let key = request_key(&lane, &ids, &hashes);
                let items: Vec<Value> = ids
                    .iter()
                    .zip(texts)
                    .zip(&hashes)
                    .map(|((id, text), hash)| json!({"id": id, "text": text, "content_sha256": hash}))
                    .collect();
                let mut params = json!({"items": items, "request_key": key, "purpose": "passage"});
                lane.constrain(&mut params);
                let reply = link
                    .send(
                        &self.module,
                        &self.model,
                        &lane,
                        "embed.batch",
                        &params,
                        deadline,
                    )
                    .await?;
                let found = match reply["job_id"].as_str() {
                    Some(job) => {
                        link.results(&self.module, &self.model, &lane, job, &key, deadline)
                            .await?
                    }
                    None => rows(&reply).cloned().ok_or(Failure::Unusable)?,
                };
                for row in found {
                    let index = row["id"]
                        .as_str()
                        .and_then(|id| ids.iter().position(|known| known == id))
                        .ok_or(Failure::Unusable)?;
                    slots[start + index] = vector(&row);
                }
            }
            // One lane gives one width; a reply mixing widths is not used.
            let mut widths = slots.iter().flatten().map(Vec::len);
            let first = widths.next();
            if widths.any(|width| Some(width) != first) {
                return Err(Failure::Unusable);
            }
            Ok(slots)
        };
        match tokio::time::timeout(self.fetch_timeout, work).await {
            Ok(Ok(slots)) => Some(slots),
            _ => None,
        }
    }
}

#[cfg(test)]
#[path = "synapse_tests.rs"]
mod tests;
