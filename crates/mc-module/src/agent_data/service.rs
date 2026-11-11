//! The `agent-data` internal service: how Entorhinal's requests reach the
//! participant, and the rules every op shares.
//!
//! Every request takes the same steps, in this order:
//!
//! 1. Admission. Only the caller the daemon stamped as `reserved:entorhinal`
//!    is served. Any other caller is refused `caller_forbidden` before its
//!    body is parsed, so it learns nothing about the request or about what
//!    this machine holds.
//! 2. Decoding, with the contract crate's own types only. A request that
//!    does not decode is refused `invalid_request` before any state is read.
//! 3. For the six ops that change state: the op runs under its cut's lock;
//!    a repeat of a request already answered gets the first reply's bytes
//!    back, and another request under the same `(cutId, op)` is refused
//!    `id_reused`. Only then do the step machine and the one-ref-set rule
//!    decide whether the op may run, and the reply is made durable, with
//!    its receipt, before the lock is let go.
//!
//! The reads (`describe`, `busy`, `status`) are answered afresh every time.
//! Every refusal is checked against the codes its op may use, so a code the
//! contract does not allow for an op never leaves this module.

use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use contract::describe::{sync_class, DescribeReply, Store};
use contract::errors::{may_refuse, Detail, ErrorBody, InvalidStateDetail, RefusalCode};
use contract::idempotency::{self, Repeat};
use contract::request::Request;
use contract::status::StatusReply;
use contract::step::{self, Step, StepRefusal};
use contract::{EmptyReply, Op};
use cortexkit_role_agent_data as contract;
use cortexkit_role_compaction::read::SessionRef;
use serde::Serialize;
use serde_json::Value;

use super::journal::{Contents, Cut, Journal, Receipt};
use crate::client::EntorhinalRefusal;

/// The stores `describe` declares, each with its sync class: the session's
/// own history (summaries, notes and waiting facts), its machine-local state
/// in `mode3.db`, the project memories every agent of a project shares, and
/// the search indexes, which each machine rebuilds for itself.
const STORES: &[(&str, &str)] = &[
    ("session-history", sync_class::AGENT),
    ("session-state", sync_class::MACHINE_LOCAL),
    ("project-memory", sync_class::SHARED_MERGED),
    ("indexes", sync_class::MACHINE_LOCAL),
];

/// How long `describe` waits for the daemon's catalog. A catalog that does
/// not answer in time counts as one that could not be read.
const CATALOG_BUDGET: Duration = Duration::from_secs(5);

/// What the service needs from the module it runs in. The module itself
/// ([`crate::module::Module`]) is the one real host; tests use stand-ins.
pub trait Host: Send + Sync {
    /// The move journal and its gate.
    fn journal(&self) -> &Journal;
    /// Whether a summarizer run, or a second summarizer turn one started,
    /// is in flight for the session in this process.
    fn historian_running(&self, session: &SessionRef) -> bool;
    /// Ask the session's worker whether a view it offered the runner is
    /// still unconfirmed, waiting at most `budget` for its answer.
    fn probe(&self, session: &SessionRef, budget: Duration) -> impl Future<Output = Probe> + Send;
    /// Where `context.db` is, when the module has one.
    fn context_db(&self) -> Option<PathBuf>;
    /// The module ids the daemon's catalog lists for `capability`.
    fn resolve_providers(
        &self,
        capability: &str,
    ) -> impl Future<Output = Result<Vec<String>, String>> + Send;
    /// One request to Entorhinal's management surface: its reply's bytes,
    /// its refusal, or `None` when Entorhinal did not answer.
    fn entorhinal(
        &self,
        body: Vec<u8>,
    ) -> impl Future<Output = Option<Result<Vec<u8>, EntorhinalRefusal>>> + Send;
}

/// What a session's worker answered when asked about its views.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Probe {
    /// The session has no worker in this process, so nothing of it runs.
    NoWorker,
    Answered {
        view_unconfirmed: bool,
    },
    /// The worker did not answer within the budget.
    NoAnswer,
}

/// A state-changing op that succeeded: the reply to send and record, and
/// any further journal change to make in the same write as its receipt.
pub(crate) struct Done {
    pub reply: Vec<u8>,
    pub edit: Box<dyn FnOnce(&mut Contents) + Send>,
}

impl Done {
    pub fn reply<T: Serialize>(reply: &T) -> Self {
        Self {
            reply: canonical(reply),
            edit: Box::new(|_| {}),
        }
    }
}

/// The service. One per module; it holds the per-cut op locks.
pub struct Service {
    /// Whether this build serves moves at all ([`super::switch`]).
    enabled: bool,
    locks: CutLocks,
}

impl Service {
    pub fn new(enabled: bool) -> Self {
        Self {
            enabled,
            locks: CutLocks::default(),
        }
    }

    /// Whether the manifest declares the service and its requests are
    /// served.
    pub fn enabled(&self) -> bool {
        self.enabled
    }

    /// Answer one request from `caller`, the principal the daemon stamped
    /// on the route (`reserved:<module id>`), with the reply's bytes or the
    /// contract's refusal.
    pub async fn handle<H: Host>(
        &self,
        host: &H,
        caller: &str,
        body: &[u8],
    ) -> Result<Vec<u8>, ErrorBody> {
        if !contract::caller_admitted(caller) {
            return Err(ErrorBody::new(
                RefusalCode::CallerForbidden,
                format!("Only {} may call agent-data.", contract::ADMITTED_CALLER),
            ));
        }
        // The transport binds no agent-data route while moves are off; this
        // keeps a request that reaches the service anyway from running.
        if !self.enabled {
            return Err(ErrorBody::new(
                RefusalCode::Unavailable,
                "agent-data moves are off in this build of ck-mc.",
            ));
        }
        let request = decode(body)?;
        let op = request.op();
        let answer = match &request {
            Request::Describe(_) => describe(host).await,
            Request::Busy(busy) => super::busy::busy(host, &busy.refs).await,
            Request::Status(status) => status_reply(host.journal(), status.cut_id.as_str()),
            Request::Diverged(_) => Err(not_served_yet(op)),
            _ => {
                self.keyed(host.journal(), &request, |cut| run(&request, cut))
                    .await
            }
        };
        answer.map_err(|refusal| allowed(op, refusal))
    }

    /// Run a state-changing op under its cut's lock. The lock is taken
    /// before the receipt is looked up and held until the reply and its
    /// receipt are durable, so a second request for the cut, a repeat of
    /// this one included, waits and then replays the receipt or runs
    /// against the state this one left. `run` is given the cut's record as
    /// it stands, and only runs for a first request the step machine and the
    /// one-ref-set rule allow. A refusal records nothing, so the same
    /// request is decided afresh next time.
    pub(crate) async fn keyed<F, Fut>(
        &self,
        journal: &Journal,
        request: &Request,
        run: F,
    ) -> Result<Vec<u8>, ErrorBody>
    where
        F: FnOnce(Option<Cut>) -> Fut,
        Fut: Future<Output = Result<Done, ErrorBody>>,
    {
        let (cut_id, op) = idempotency::key(request).expect("a state-changing op carries a cutId");
        let cut_id = cut_id.as_str().to_owned();
        let refs = request
            .refs()
            .expect("every state-changing op carries refs")
            .clone();
        let _lock = self.locks.lock(&cut_id).await;
        let contents = journal.contents().ok_or_else(journal_unreadable)?;
        let record = contents.cuts.get(&cut_id).cloned();
        if let Some(receipt) = record
            .as_ref()
            .and_then(|cut| cut.receipts.get(op.method()))
        {
            match idempotency::compare(&recorded_request(op, receipt)?, request) {
                Repeat::Replay => return Ok(receipt.reply.clone().into_bytes()),
                Repeat::Reused => {
                    return Err(ErrorBody::new(
                        RefusalCode::IdReused,
                        format!(
                            "Cut {cut_id} already answered {} for another request.",
                            op.method()
                        ),
                    ))
                }
                Repeat::NewKey | Repeat::Exempt => {}
            }
        }
        let current = record.as_ref().map_or(Step::None, |cut| cut.step);
        let next = step::advance(op, current).map_err(|refusal| step_refused(&cut_id, refusal))?;
        step::check_ref_set(
            op,
            current,
            record.as_ref().and_then(|cut| cut.refs.as_ref()),
            &refs,
        )
        .map_err(|detail| {
            ErrorBody::with_typed_detail(
                Detail::InvalidState(detail),
                format!("Cut {cut_id} started with another set of refs; every later op must name the same set."),
            )
        })?;
        let Done { reply, edit } = run(record).await?;
        let receipt = receipt(request, &reply);
        // Only the first op of a side fixes the ref set: `prepare` on the
        // source, `import` on the receiver. An abort of a cut never seen
        // here has no set.
        let starts = matches!(op, Op::Prepare | Op::Import);
        journal
            .change(move |contents| {
                let cut = contents.cuts.entry(cut_id).or_default();
                cut.step = next;
                if starts {
                    cut.refs = Some(refs);
                }
                cut.receipts.insert(op.method().to_owned(), receipt);
                edit(contents);
            })
            .map_err(|error| {
                ErrorBody::new(
                    RefusalCode::Unavailable,
                    format!(
                        "The reply could not be recorded ({error}); send the same request again."
                    ),
                )
            })?;
        Ok(reply)
    }
}

/// What a state-changing op does once the step machine allows it. Only an
/// abort of a cut this machine never saw is served so far: it touches no
/// data and only records the cut aborted, so a delayed `prepare` or
/// `import` for that cut is refused afterwards.
async fn run(request: &Request, cut: Option<Cut>) -> Result<Done, ErrorBody> {
    match request {
        Request::Abort(_) if cut.is_none_or(|cut| cut.step == Step::None) => {
            Ok(Done::reply(&EmptyReply::new()))
        }
        _ => Err(not_served_yet(request.op())),
    }
}

/// The refusal for an op this build does not carry out yet. `unavailable`
/// records nothing, so the driver may send the same request again later.
fn not_served_yet(op: Op) -> ErrorBody {
    ErrorBody::new(
        RefusalCode::Unavailable,
        format!("{} is not served by this build of ck-mc yet.", op.method()),
    )
}

/// `{"method": ..., "params": ...}`, decoded with the contract's types.
/// Absent params are an empty object, which only `describe` accepts.
fn decode(body: &[u8]) -> Result<Request, ErrorBody> {
    let invalid = |message: &str| ErrorBody::new(RefusalCode::InvalidRequest, message);
    let value: Value =
        serde_json::from_slice(body).map_err(|_| invalid("The request is not JSON."))?;
    let envelope = value
        .as_object()
        .ok_or_else(|| invalid("The request is not a JSON object."))?;
    if envelope
        .keys()
        .any(|key| key != "method" && key != "params")
    {
        return Err(invalid(
            "The request has a member other than method and params.",
        ));
    }
    let method = envelope
        .get("method")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("The request names no method."))?;
    let params = envelope
        .get("params")
        .cloned()
        .unwrap_or_else(|| Value::Object(Default::default()));
    Request::decode(method, &params)
}

/// A refusal the op may give, or `unavailable` naming the one it may not,
/// so a slip in this module never puts a code on the wire that the driver
/// would read wrongly for this op.
fn allowed(op: Op, refusal: ErrorBody) -> ErrorBody {
    if may_refuse(op, &refusal.code) {
        return refusal;
    }
    tracing::warn!(
        "ck-mc: agent-data {} produced {} ({}), which the contract does not allow for it; answering unavailable",
        op.method(),
        refusal.code.as_str(),
        refusal.message
    );
    ErrorBody::new(
        RefusalCode::Unavailable,
        format!(
            "{} failed: {} ({})",
            op.method(),
            refusal.message,
            refusal.code.as_str()
        ),
    )
}

/// `describe`. The kinds are computed on every call from the catalog: a
/// kind is declared only while the module that owns it lists
/// `agent-data/v1`, because Entorhinal lets a move go ahead once some
/// participant covers every ref, and a session moved by Magic Context alone
/// would arrive without its transcript. When the catalog cannot be read,
/// nothing is declared, for the same reason.
async fn describe<H: Host>(host: &H) -> Result<Vec<u8>, ErrorBody> {
    let providers = match tokio::time::timeout(
        CATALOG_BUDGET,
        host.resolve_providers(contract::PROVIDES),
    )
    .await
    {
        Ok(Ok(providers)) => providers,
        Ok(Err(error)) => {
            tracing::warn!(
                    "ck-mc: agent-data describe declares no ref kinds: the daemon's catalog could not be read ({error})"
                );
            Vec::new()
        }
        Err(_) => {
            tracing::warn!(
                    "ck-mc: agent-data describe declares no ref kinds: the daemon's catalog did not answer in time"
                );
            Vec::new()
        }
    };
    let ref_kinds = super::resolve::REF_KINDS
        .iter()
        .filter(|(_, owner)| providers.iter().any(|provider| provider == owner))
        .map(|(kind, _)| (*kind).to_owned())
        .collect();
    let stores = STORES
        .iter()
        .map(|(name, class)| Store::new(*name, *class))
        .collect();
    Ok(canonical(&DescribeReply::new(ref_kinds, stores, false)))
}

/// `status`: the step the cut has reached here, `none` for a cut never seen.
fn status_reply(journal: &Journal, cut: &str) -> Result<Vec<u8>, ErrorBody> {
    let contents = journal.contents().ok_or_else(journal_unreadable)?;
    let step = contents.cuts.get(cut).map_or(Step::None, |cut| cut.step);
    Ok(canonical(&StatusReply::new(step)))
}

pub(crate) fn journal_unreadable() -> ErrorBody {
    ErrorBody::new(
        RefusalCode::Unavailable,
        "The agent-data move journal cannot be read, so no move step runs until it is repaired or restored.",
    )
}

fn step_refused(cut: &str, refusal: StepRefusal) -> ErrorBody {
    match refusal {
        StepRefusal::CutUnknown => ErrorBody::new(
            RefusalCode::CutUnknown,
            format!("Cut {cut} has no earlier step on this machine."),
        ),
        StepRefusal::InvalidState { step } => ErrorBody::with_typed_detail(
            Detail::InvalidState(InvalidStateDetail::new(step)),
            format!(
                "Cut {cut} is {} here, so this op is out of order.",
                step.as_str()
            ),
        ),
    }
}

/// The receipt of a request and the reply it got. The request is kept with
/// its refs sorted, as canonical JSON, so a repeat is compared with it the
/// way the contract compares requests.
pub(crate) fn receipt(request: &Request, reply: &[u8]) -> Receipt {
    Receipt {
        request: String::from_utf8(canonical(&request.with_sorted_refs().params()))
            .expect("canonical JSON is UTF-8"),
        reply: String::from_utf8(reply.to_vec()).expect("replies are JSON text"),
    }
}

fn recorded_request(op: Op, receipt: &Receipt) -> Result<Request, ErrorBody> {
    serde_json::from_str::<Value>(&receipt.request)
        .ok()
        .and_then(|params| Request::decode(op.method(), &params).ok())
        .ok_or_else(|| {
            ErrorBody::new(
                RefusalCode::Unavailable,
                format!(
                    "The recorded request for {} cannot be read back.",
                    op.method()
                ),
            )
        })
}

/// RFC 8785 canonical JSON: the same reply always has the same bytes.
pub(crate) fn canonical<T: Serialize + ?Sized>(value: &T) -> Vec<u8> {
    serde_jcs::to_vec(value).expect("replies serialize")
}

/// One async lock per cut. Ops on one cut run one at a time, across door,
/// catalog and Entorhinal calls too; ops on different cuts never wait for
/// each other. A lock nobody holds or waits for is dropped the next time a
/// lock is taken.
#[derive(Default)]
struct CutLocks(Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>);

impl CutLocks {
    async fn lock(&self, cut: &str) -> tokio::sync::OwnedMutexGuard<()> {
        let lock = {
            let mut locks = self.0.lock().expect("agent-data cut locks");
            locks.retain(|_, lock| Arc::strong_count(lock) > 1);
            Arc::clone(locks.entry(cut.to_owned()).or_default())
        };
        lock.lock_owned().await
    }
}
