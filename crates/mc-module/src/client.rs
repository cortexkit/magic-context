//! The calls ck-mc makes to a session's runner. The real module makes them
//! through the subc daemon, the CortexKit module bus that routes calls
//! between module processes ([`crate::transport`]); tests make them in
//! process.

use std::future::Future;

use cortexkit_role_compaction::read::{ReadPage, ReadRequest, SessionRef};
use cortexkit_role_compaction::view::{AppliedViewAnswer, ApplyViewAnswer, ApplyViewRequest};
use cortexkit_role_llm_runner::run::{RunResult, RunResultRequest, RunStatus, RunStatusRequest};
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
#[derive(Clone, PartialEq, Eq)]
pub struct ClientError {
    pub message: String,
    /// The refusal's code, when the runner or the daemon refused the call or
    /// its route by name.
    pub code: Option<String>,
    /// The refusal's `detail`, when the runner's error body carried one.
    pub detail: Option<serde_json::Value>,
    /// The request may have left ck-mc, but no answer came back: its
    /// deadline passed, the connection or route ended after it was sent, or
    /// the client could not prove it stayed unsent. The runner may have
    /// received it and acted on it, so a caller must not treat it as a call
    /// that never happened.
    pub outcome_unknown: bool,
}

impl ClientError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: None,
            detail: None,
            outcome_unknown: false,
        }
    }

    pub fn refused(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: Some(code.into()),
            detail: None,
            outcome_unknown: false,
        }
    }

    /// A request that was sent but got no answer (see `outcome_unknown`).
    pub fn unanswered(message: impl Into<String>) -> Self {
        Self {
            outcome_unknown: true,
            ..Self::new(message)
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

impl std::fmt::Debug for ClientError {
    /// Leaves `detail` out: errors are logged and shown to the apps in this
    /// form, which predates the field and should not grow with it.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClientError")
            .field("message", &self.message)
            .field("code", &self.code)
            .finish()
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
    /// The waits on ck-mc's child runs and the reader that wakes them
    /// ([`crate::run_ends`]). Without one, a wait reads its run every
    /// [`crate::run_ends::FAST_POLL`].
    fn run_ends(&self) -> Option<&crate::run_ends::RunEnds> {
        None
    }
    /// Whether this session's runner marks notices carrying the person's words.
    /// Discovery failure leaves automatic notice reclaim disabled.
    fn notice_keep(&self, _session: &SessionRef) -> impl Future<Output = bool> + Send {
        async { false }
    }
    /// Whether the runner explicitly admits clearing system-note reminders.
    fn turn_system_cleared(&self, _session: &SessionRef) -> impl Future<Output = bool> + Send {
        async { false }
    }
    /// The delivery order of a clock note for this session's runner, or
    /// `None` when the runner does not render datetime templates and so gets
    /// no note ([`crate::clock_note`]). Discovery failure sends none.
    fn clock_note_delivery(
        &self,
        _session: &SessionRef,
    ) -> impl Future<Output = Option<Vec<cortexkit_role_llm_runner::delivery_order::Mode>>> + Send
    {
        async { None }
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
    /// Whether this child runner declares sampling temperature support.
    /// Older or undiscoverable runners keep their own sampling defaults.
    fn child_temperature(&self, _child: &Child) -> impl Future<Output = bool> + Send {
        async { false }
    }
    /// Whether this child runner admits a send with a fetch plan. Older or
    /// undiscoverable runners get no plan, so a task that needs tools can't
    /// run there.
    fn child_plans(&self, _child: &Child) -> impl Future<Output = bool> + Send {
        async { false }
    }
    /// The modules the daemon lists as ready tool providers (they claim
    /// `tool-provider/v1` in their manifest), by module id. A client that
    /// can't ask the daemon lists none, so no code-reading task runs.
    fn tool_providers(&self) -> impl Future<Output = Result<Vec<String>, ClientError>> + Send {
        async { Ok(Vec::new()) }
    }
    /// Module `provider`'s `tool.catalog` answer in the child's project
    /// folder, for `preset` or, with `None`, for a request without one
    /// (whose answer lists the presets the provider serves). Fetched under
    /// the same scope the runner will fetch the plan's tool item under, so
    /// the plan's composition lists exactly what the runner will get.
    fn tool_catalog(
        &self,
        _child: &Child,
        _provider: &str,
        _preset: Option<&str>,
    ) -> impl Future<
        Output = Result<cortexkit_role_tool_provider::catalog::CatalogAnswer, ClientError>,
    > + Send {
        async { Err(ClientError::new("no code-reading tools")) }
    }
    /// What this child runner allows a `retention_policy` to ask for, when it
    /// declares the `session_retention` group. Older or undiscoverable
    /// runners receive no new send member.
    fn child_session_retention(
        &self,
        _child: &Child,
    ) -> impl Future<Output = Option<crate::runner_capabilities::SessionRetention>> + Send {
        async { None }
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
    /// `run.status` on the child's route, to read an account pause's resume time.
    /// An older runner or an unavailable read leaves the run error's timing in use.
    fn child_status(
        &self,
        _child: &Child,
        _request: RunStatusRequest,
    ) -> impl Future<Output = Result<RunStatus, ClientError>> + Send {
        async { Err(ClientError::new("run.status unavailable")) }
    }
    /// `run.cancel` of `run_id` on the child's route, when the child's runner
    /// declares the `run_cancel` group. `Ok(false)` when it does not, so
    /// nothing was asked.
    fn cancel_child_run(
        &self,
        _child: &Child,
        _run_id: &str,
    ) -> impl Future<Output = Result<bool, ClientError>> + Send {
        async { Ok(false) }
    }
    /// Withdraw a queued child submission that has not started. A runner
    /// without `retract` cannot confirm withdrawal.
    fn retract_child_send(
        &self,
        _child: &Child,
        _submission_id: &str,
    ) -> impl Future<Output = Result<bool, ClientError>> + Send {
        async { Ok(false) }
    }
    /// Add a continuation's usage to a decision already settled by its
    /// first turn. Clients without routing do not send these reports.
    fn report_child_usage(
        &self,
        _request: cortexkit_role_routing::report::ReportRequest,
    ) -> impl Future<Output = ()> + Send {
        async {}
    }
    /// One call to a Synapse module's management surface on the session's
    /// behalf, for `ctx_search`'s rerank (`models.list`, `rerank.score`),
    /// within [`crate::search::rerank::SYNAPSE_DEADLINE`]. `module` is the
    /// module id the settings name ([`crate::search::rerank::Reranker`]),
    /// and no other module is called in its place. The answer is the
    /// reply's JSON; an error is a fixed reason for the log, such as the
    /// module's refusal code. Without Synapse every search keeps its
    /// ordinary ranking, which is the default here.
    fn synapse_call(
        &self,
        _session: &SessionRef,
        _module: &str,
        _method: &str,
        _params: serde_json::Value,
    ) -> impl Future<Output = Result<serde_json::Value, String>> + Send {
        async { Err("missing_synapse".to_owned()) }
    }
    /// One call to a Synapse module's management surface for embeddings
    /// (`models.list`, `embed.query`, `embed.batch`, `embed.result`), on no
    /// session's behalf: upkeep embeds outside any session. The answer must
    /// arrive within `timeout`. `module` is the module id the settings name
    /// ([`crate::embedding::synapse`]); no other module is called in its
    /// place. The answer is the reply's JSON; a refusal carries the module's
    /// code and, for a transient one such as `model_loading`, how long to
    /// wait. Without Synapse no lane serves and search uses words only,
    /// which is the default here.
    fn synapse_embedding_call(
        &self,
        _module: &str,
        _method: &str,
        _params: serde_json::Value,
        _timeout: std::time::Duration,
    ) -> impl Future<Output = Result<serde_json::Value, crate::embedding::synapse::Refusal>> + Send
    {
        async { Err(crate::embedding::synapse::Refusal::new("missing_synapse")) }
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
    /// Where the dreamer opens its role lease watches
    /// ([`crate::dreamer::lease`]): on this module's own route to
    /// Entorhinal's management surface. Without Entorhinal no watch opens,
    /// so no dreamer run starts, which is the default here.
    fn role_leases(&self) -> std::sync::Arc<dyn crate::dreamer::lease::RoleLeases> {
        std::sync::Arc::new(crate::dreamer::lease::NoEntorhinal)
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
    /// One call to the management surface of core (the `prefrontal` module)
    /// under this module's own principal, given at
    /// most `deadline`: `persona.workspace_document`, for the workspace
    /// guidance the curate tasks show. The answer is the reply's JSON. A
    /// refusal carries core's code; a missing prefrontal module is
    /// `unknown_module`, and one that can't be reached or answers no JSON is
    /// `unavailable`. Without a daemon core is not installed, which is the
    /// default here.
    fn core_call(
        &self,
        _method: &str,
        _params: serde_json::Value,
        _deadline: std::time::Duration,
    ) -> impl Future<Output = Result<serde_json::Value, CoreRefusal>> + Send {
        async { Err(CoreRefusal::not_installed()) }
    }
}

/// Core refused a call, or could not be reached: `unknown_module` when
/// prefrontal is not installed, `unavailable` for any other
/// failure to get an answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CoreRefusal {
    pub code: String,
    pub message: String,
    pub detail: Option<serde_json::Value>,
}

impl CoreRefusal {
    pub fn not_installed() -> Self {
        Self {
            code: "unknown_module".to_owned(),
            message: "core is not installed as prefrontal".to_owned(),
            detail: None,
        }
    }

    pub fn unavailable(message: impl Into<String>) -> Self {
        Self {
            code: "unavailable".to_owned(),
            message: message.into(),
            detail: None,
        }
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
