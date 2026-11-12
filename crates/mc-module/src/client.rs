//! The calls ck-mc makes to a session's runner. The real module makes them
//! through the subc daemon, the CortexKit module bus that routes calls
//! between module processes ([`crate::transport`]); tests make them in
//! process.

use std::future::Future;

use cortexkit_role_compaction::read::{ReadPage, ReadRequest, SessionRef};
use cortexkit_role_compaction::view::{AppliedViewAnswer, ApplyViewAnswer, ApplyViewRequest};
use cortexkit_role_llm_runner::run::{RunResult, RunResultRequest};
use cortexkit_role_llm_runner::send::{SendReply, SendRequest};

/// A child session of ck-mc's own on a session's runner, where a summarizer
/// run happens. The route to it is opened under ck-mc's child scope for the
/// session's project folder ([`crate::child_scopes`]); the runner creates the
/// child in that folder on its first send.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Child {
    /// The child's runner and harness are its parent's.
    pub session: SessionRef,
    /// The parent session's project folder. A real runner refuses a child
    /// without one.
    pub project_root: Option<String>,
}

/// A call to the runner that got no answer, or a refusal.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClientError {
    pub message: String,
    /// The refusal's code, when the runner or the daemon refused the call or
    /// its route by name.
    pub code: Option<String>,
}

impl ClientError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: None,
        }
    }

    pub fn refused(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: Some(code.into()),
        }
    }

    /// The runner no longer lets ck-mc act as this session's compaction
    /// provider: its plan names another provider or none, or it holds no such
    /// session. Whatever the reason, ck-mc stops working on the session until
    /// the runner's next Setup.
    pub fn not_permitted(&self) -> bool {
        self.code.as_deref()
            == Some(cortexkit_role_compaction::wire::codes::COMPACTION_NOT_PERMITTED)
    }
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.code {
            Some(code) => write!(f, "{code}: {}", self.message),
            None => f.write_str(&self.message),
        }
    }
}

/// Each call concerns one session: the transport sends it on a route bound to
/// that session, so the request itself never names it.
pub trait RunnerClient: Send + Sync + 'static {
    /// Setup can signal a runner restart without a consumer reconnect.
    fn runner_setup(&self, _runner: &str) {}
    /// Whether this session's runner marks notices carrying the person's words.
    /// Discovery failure leaves automatic notice reclaim disabled.
    fn notice_keep(&self, _session: &SessionRef) -> impl Future<Output = bool> + Send {
        async { false }
    }
    /// Whether the runner explicitly admits clearing system-note reminders.
    fn turn_system_cleared(&self, _session: &SessionRef) -> impl Future<Output = bool> + Send {
        async { false }
    }
    /// Whether the runner on this scoped child route accepts cache requests.
    /// An unknown or unavailable declaration leaves the runner's defaults in use.
    fn child_cache_policy(&self, _child: &Child) -> impl Future<Output = bool> + Send {
        async { false }
    }
    /// Whether this child runner accepts a storage/backup/cost class label.
    /// Older or undiscoverable runners receive no new send member.
    fn child_session_class(&self, _child: &Child) -> impl Future<Output = bool> + Send {
        async { false }
    }
    /// `session.read`.
    fn read(
        &self,
        session: &SessionRef,
        request: ReadRequest,
    ) -> impl Future<Output = Result<ReadPage, ClientError>> + Send;
    /// `session.apply_view`.
    fn apply_view(
        &self,
        session: &SessionRef,
        request: ApplyViewRequest,
    ) -> impl Future<Output = Result<ApplyViewAnswer, ClientError>> + Send;
    /// `session.applied_view`.
    fn applied_view(
        &self,
        session: &SessionRef,
    ) -> impl Future<Output = Result<AppliedViewAnswer, ClientError>> + Send;
    /// `session.send`, llm-runner's, on the session's own route: a reminder.
    fn send(
        &self,
        session: &SessionRef,
        request: SendRequest,
    ) -> impl Future<Output = Result<SendReply, ClientError>> + Send;
    /// `session.send` on a child's route: it starts a summarizer run.
    fn send_child(
        &self,
        child: &Child,
        request: SendRequest,
    ) -> impl Future<Output = Result<SendReply, ClientError>> + Send;
    /// `run.result` on the child's route the run started on.
    fn child_result(
        &self,
        child: &Child,
        request: RunResultRequest,
    ) -> impl Future<Output = Result<RunResult, ClientError>> + Send;
    /// One call to the Synapse module's management surface on the session's
    /// behalf, for `ctx_search`'s rerank (`models.list`, `rerank.score`),
    /// within [`crate::search::rerank::SYNAPSE_DEADLINE`]. The answer is the
    /// reply's JSON; an error is a fixed reason for the log, such as the
    /// module's refusal code. Without Synapse every search keeps its
    /// ordinary ranking, which is the default here.
    fn synapse_call(
        &self,
        _session: &SessionRef,
        _method: &str,
        _params: serde_json::Value,
    ) -> impl Future<Output = Result<serde_json::Value, String>> + Send {
        async { Err("missing_synapse".to_owned()) }
    }
    /// One read from Entorhinal's management surface on the session's behalf
    /// (`context.project`, `context.session`), for the session's memory context.
    /// `body` is the whole serialized request. The answer is the reply's bytes;
    /// `Err` carries a refusal as `(code, message, detail)`, and
    /// `None` means Entorhinal did not answer. Without Entorhinal no read
    /// answers, which is the default here.
    fn entorhinal_call(
        &self,
        _session: &SessionRef,
        _body: Vec<u8>,
    ) -> impl Future<Output = Option<Result<Vec<u8>, EntorhinalRefusal>>> + Send {
        async { None }
    }
    /// One call to Engram's device-stream service (`stream.heads`,
    /// `stream.append`), for syncing new memories. The answer
    /// is the reply's JSON; an error is a fixed reason such as the service's
    /// refusal code. Without Engram nothing syncs, which is the default here.
    fn engram_call(
        &self,
        _method: &str,
        _params: serde_json::Value,
    ) -> impl Future<Output = Result<serde_json::Value, String>> + Send {
        async { Err("unavailable".to_owned()) }
    }
    /// The ids of the modules that would answer a route for `capability`
    /// now: in the daemon's catalog with the claim, ready, and verified by
    /// their launch nonce ([`crate::agent_data::service::ready_participants`]),
    /// for a move's `describe`. An error is a reason for the log. Without a
    /// daemon the catalog cannot be read, which is the default here.
    fn ready_participants(
        &self,
        _capability: &str,
    ) -> impl Future<Output = Result<Vec<String>, String>> + Send {
        async { Err("no catalog".to_owned()) }
    }
    /// One call to Engram's session door (`session.offsets`,
    /// `session.cover`, `session.admit`, `session.digest`, `session.read`),
    /// for a move's `prepare` and `export`, given at most `deadline`. The
    /// answer is the reply's `result`; a refusal carries Engram's code and
    /// detail. Without Engram the door is unavailable, which is the default
    /// here.
    fn door_call(
        &self,
        _method: &str,
        _params: serde_json::Value,
        _deadline: std::time::Duration,
    ) -> impl Future<Output = Result<serde_json::Value, DoorRefusal>> + Send {
        async { Err(DoorRefusal::unavailable("no session door")) }
    }
    /// The stream this module writes on Engram's session door: its own
    /// principal, `reserved:<module id>`, which the door derives from the
    /// route's attested caller.
    fn door_stream(&self) -> String {
        format!("reserved:{}", crate::MODULE_ID)
    }
}

/// Engram's session door refused a call, or could not be reached
/// (`unavailable`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DoorRefusal {
    pub code: String,
    pub message: String,
    pub detail: Option<serde_json::Value>,
}

impl DoorRefusal {
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self {
            code: "unavailable".to_owned(),
            message: message.into(),
            detail: None,
        }
    }
}

/// Entorhinal's refusal of a context read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntorhinalRefusal {
    pub code: String,
    pub message: String,
    pub detail: Option<serde_json::Value>,
}
