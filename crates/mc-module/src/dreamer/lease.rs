//! One dreamer per owner across the user's computers: the role lease.
//!
//! Once memories replicate between a user's computers, two of them must
//! never run the dreamer for the same memories at once, or their curates
//! would fight. Entorhinal arbitrates one role per owner, named for the
//! owner ([`role`]): `dreamer.<project id>`, `dreamer.<workspace id>` and
//! `dreamer.global`. A run asks for its owner's role and acts only while
//! Entorhinal says this computer holds it.
//!
//! - **The watch.** `role.lease {role}` is a watch on ck-mc's own route to
//!   Entorhinal's management surface; each request is sent as
//!   `{"method": op, "params": request}`. Every notice it sends is
//!   `{holding, gen, issued_at_ms, valid_for_ms, seq, handback?}` ([`Notice`]),
//!   and every one, `holding: false` included, is acknowledged with
//!   `role.lease.ack {role, seq}` on the same route within [`ACK_DEADLINE`].
//!   Closing the watch releases the role, so a run holds it only while the
//!   run lasts ([`Lease::close`]).
//! - **One code path everywhere.** On a single computer, and on a fleet
//!   without the hub, Entorhinal grants every `dreamer.*` role at once,
//!   locally, at `gen` 1, renewed every 20 seconds. Only the hub arbitrates.
//!   So ck-mc always asks, and on a single computer the answer is always
//!   yes.
//! - **Taking a role on the hub.** There the first notice for a role this
//!   computer doesn't hold yet says `holding: false`, and it is pending:
//!   once it is acknowledged, Entorhinal asks the hub, and the next notice
//!   holds with a new generation. A run keeps the watch open and waits up
//!   to [`TAKE_DEADLINE`] for that notice; closing the watch on the first
//!   notice would end the request before the hub saw it.
//! - **The acting window.** A holder may act until `issued_at_ms +
//!   valid_for_ms`, read on the operating system's monotonic clock in
//!   milliseconds, the clock Entorhinal stamps notices with ([`monotonic_ms`]).
//!   A notice that arrives late therefore grants less time, never more. A
//!   run starts a paid batch only while that deadline is at least
//!   [`MARGIN_MS`] ahead ([`Lease::standing`]).
//! - **Handback.** `handback: true` means another computer asked for the
//!   role. The run finishes the batch in flight; at that safe point, before
//!   it starts anything else, it offers the role with `role.lease.yield
//!   {role, gen}` on the watch's route. `yielded: true` means the next
//!   generation is written to the computer that asked: the run stops at
//!   once, whatever its deadline, records itself as handed back, and closes
//!   the watch. `yielded: false` means that computer withdrew its request:
//!   the run keeps the role and goes on, still within its deadline, and the
//!   next notice renews the window without `handback`.
//!
//! The live client is the transport's ([`crate::transport`]); tests drive
//! the same [`Lease`] with a double fed Entorhinal's published samples
//! (`testdata/role-lease-v1.5`).
//!
//! The lease matters only once memories replicate, so the dreamer uses it
//! only in a build with the `memory-replica` feature ([`ENABLED`]). Without
//! it a run opens no watch and journals no lease, and runs as it did
//! before leases existed.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use futures_util::FutureExt as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot, watch};

use super::store::OwnerKey;

/// Entorhinal's watch of one role's lease.
pub const LEASE_OP: &str = "role.lease";

/// Whether dreamer runs take their owners' role leases: only in a build
/// with the `memory-replica` feature, where memories travel between the
/// user's computers and two of them could otherwise run one owner's
/// dreamer at once.
pub const ENABLED: bool = cfg!(feature = "memory-replica");
/// The acknowledgement of one notice of that watch.
pub const ACK_OP: &str = "role.lease.ack";
/// A holder's offer of the role to the computer that asked for it.
pub const YIELD_OP: &str = "role.lease.yield";

/// How long a run waits for its role's first notice before it is skipped
/// as unanswered. Entorhinal answers a locally granted role at once; on the
/// hub the first notice follows one round trip to it. Ten seconds leaves a
/// slow link several round trips, and is short next to the engine's
/// one-minute round, so an Entorhinal that never answers holds a run back
/// for at most that long, once per due slot.
pub const FIRST_NOTICE: Duration = Duration::from_secs(10);

/// How long a run waits, after a first notice that doesn't hold the role,
/// for one that does. On the hub that first notice is pending, not a
/// refusal: Entorhinal writes the take to the hub only once the notice is
/// acknowledged, and the next notice holds. That takes about a second for
/// a vacant role, up to 60 seconds while another computer recorded as the
/// role's preferred home is given its chance, and up to one 45-second lease
/// if another computer held the role and its lease has to lapse first.
pub const TAKE_DEADLINE: Duration = Duration::from_secs(90);

/// Entorhinal's bound on acknowledging a notice.
pub const ACK_DEADLINE: Duration = Duration::from_secs(5);
/// Warn before acknowledgement latency reaches the deadline.
const SLOW_ACK_MS: u64 = 2_000;

/// How long a run waits for the answer to its yield. Settling the
/// hand-over takes Entorhinal one write on the hub, so this is the same
/// bound as the first notice's. A yield without an answer in time is
/// unsettled: the run stops rather than act without knowing whether it
/// still holds the role.
pub const YIELD_DEADLINE: Duration = Duration::from_secs(10);

/// How far ahead of the acting deadline a batch must start, in
/// milliseconds. It covers what happens between the check and the batch's
/// send (the journal write, routing's choice of a model), with room to
/// spare. A holder is renewed every 20 seconds with a 45-second window, so
/// its deadline is always at least 25 seconds ahead: ten seconds of margin
/// never stops a holder whose renewals arrive, and a holder whose renewals
/// stopped starts nothing in the last ten seconds of its window.
pub const MARGIN_MS: u64 = 10_000;

/// The role of `owner`'s dreamer: `dreamer.global` for the person's own
/// memories, `dreamer.<owner id>` for a project's or a workspace's. The
/// replica's capture triggers ([`crate::replica::schema`]) and its
/// receivers ([`crate::replica::apply`]) name a changed row's role by the
/// same rule.
pub fn role(owner: &OwnerKey) -> String {
    match owner.level.as_str() {
        "global" => "dreamer.global".to_owned(),
        _ => format!("dreamer.{}", owner.owner_id),
    }
}

/// One notice of a role's watch.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Notice {
    /// Whether this computer may act for the role.
    pub holding: bool,
    /// The role's ownership generation. Entorhinal raises it each time the
    /// role changes hands, so a newer holder's changes carry a larger one.
    pub gen: u64,
    /// When Entorhinal issued the notice, on its monotonic clock.
    pub issued_at_ms: u64,
    /// How long after `issued_at_ms` the holder may act.
    pub valid_for_ms: u64,
    /// The notice's sequence number, which its acknowledgement names.
    pub seq: u64,
    /// Another computer asked for the role.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub handback: bool,
}

impl Notice {
    /// The end of the acting window, on the monotonic clock: fixed by when
    /// Entorhinal issued the notice, not by when it arrived.
    pub fn deadline_ms(&self) -> u64 {
        self.issued_at_ms.saturating_add(self.valid_for_ms)
    }
}

/// Entorhinal refused a request, or could not be reached (`unavailable`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LeaseError {
    pub code: String,
    pub message: String,
}

impl LeaseError {
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self {
            code: "unavailable".to_owned(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for LeaseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

/// Where a run opens its roles' watches.
#[async_trait]
pub trait RoleLeases: Send + Sync {
    /// Open the `role.lease {role}` watch.
    async fn watch(&self, role: &str) -> Result<Watch, LeaseError>;
}

/// One open watch: its notices, and the route it was opened on, which its
/// acknowledgements and yields must use. Dropping the notices closes the
/// watch, which releases the role.
pub struct Watch {
    pub notices: Box<dyn Notices>,
    pub route: Arc<dyn LeaseRoute>,
}

/// The notices of one watch, in order.
#[async_trait]
pub trait Notices: Send {
    /// The next notice; `Some(Err)` when the watch ended on a refusal, and
    /// `None` once it has ended. Dropping the future before it is ready
    /// loses nothing: the notice it would have returned comes from the next
    /// call.
    async fn next(&mut self) -> Option<Result<Notice, LeaseError>>;
}

/// Requests on the route a watch was opened on.
#[async_trait]
pub trait LeaseRoute: Send + Sync {
    /// `role.lease.ack {role, seq}`: acknowledge the notice numbered `seq`.
    async fn ack(&self, seq: u64) -> Result<(), LeaseError>;

    /// `role.lease.yield {role, gen}`: offer the role, held at `gen`, to the
    /// computer that asked for it. `true` when it is handed over, `false`
    /// when that computer withdrew its request.
    async fn yield_role(&self, gen: u64) -> Result<bool, LeaseError>;
}

/// A process that can't reach Entorhinal: every watch is refused, so no
/// run starts. The module's client supplies the live one.
pub struct NoEntorhinal;

#[async_trait]
impl RoleLeases for NoEntorhinal {
    async fn watch(&self, _: &str) -> Result<Watch, LeaseError> {
        Err(LeaseError::unavailable(
            "this process has no route to Entorhinal",
        ))
    }
}

/// `{"method": op, "params": params}`, the frame of every request on
/// Entorhinal's management route.
fn request(op: &str, params: Value) -> Vec<u8> {
    serde_json::to_vec(&json!({"method": op, "params": params})).expect("a request is JSON")
}

/// The body that opens `role`'s watch.
pub fn watch_request(role: &str) -> Vec<u8> {
    request(LEASE_OP, json!({"role": role}))
}

/// The body that acknowledges notice `seq` of `role`'s watch.
pub fn ack_request(role: &str, seq: u64) -> Vec<u8> {
    request(ACK_OP, json!({"role": role, "seq": seq}))
}

/// The body that offers `role`, held at `gen`, to the computer that asked.
pub fn yield_request(role: &str, gen: u64) -> Vec<u8> {
    request(YIELD_OP, json!({"role": role, "gen": gen}))
}

/// One event the watch delivered, as its `StreamData` body.
pub fn decode_notice(bytes: &[u8]) -> Result<Notice, LeaseError> {
    serde_json::from_slice(bytes).map_err(|error| {
        LeaseError::unavailable(format!("a lease notice that doesn't decode: {error}"))
    })
}

/// The answer to an acknowledgement: `{"result": {"acknowledged": true}}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AckAnswer {
    pub result: AckResult,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AckResult {
    pub acknowledged: bool,
}

/// The answer to a yield: `{"result": {"yielded": <bool>}}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct YieldAnswer {
    pub result: YieldResult,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct YieldResult {
    pub yielded: bool,
}

/// Whether `bytes` acknowledge the notice.
pub fn decode_ack(bytes: &[u8]) -> Result<(), LeaseError> {
    match serde_json::from_slice::<AckAnswer>(bytes) {
        Ok(answer) if answer.result.acknowledged => Ok(()),
        Ok(_) => Err(LeaseError::unavailable(
            "Entorhinal did not acknowledge the notice",
        )),
        Err(error) => Err(LeaseError::unavailable(format!(
            "an acknowledgement answer that doesn't decode: {error}"
        ))),
    }
}

/// Whether `bytes` say the role was handed over.
pub fn decode_yield(bytes: &[u8]) -> Result<bool, LeaseError> {
    serde_json::from_slice::<YieldAnswer>(bytes)
        .map(|answer| answer.result.yielded)
        .map_err(|error| {
            LeaseError::unavailable(format!("a yield answer that doesn't decode: {error}"))
        })
}

/// The monotonic clock a run reads its acting window on, in milliseconds.
/// Tests replace it ([`super::engine::Engine::with_clock`]).
pub type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;

/// The operating system's monotonic clock, the one Entorhinal stamps its
/// notices with: `CLOCK_MONOTONIC` through `clock_gettime` on Linux and
/// macOS, `GetTickCount64` on Windows, in milliseconds. Never wall time,
/// which can step, and never `std::time::Instant`, which on macOS reads
/// another clock that stops while the computer sleeps. A clock that can't
/// be read answers the end of time, so every acting window counts as
/// lapsed and nothing is written.
pub fn monotonic_ms() -> u64 {
    #[cfg(unix)]
    {
        match nix::time::clock_gettime(nix::time::ClockId::CLOCK_MONOTONIC) {
            Ok(now) => (now.tv_sec() as u64)
                .saturating_mul(1_000)
                .saturating_add(now.tv_nsec() as u64 / 1_000_000),
            Err(_) => u64::MAX,
        }
    }
    #[cfg(windows)]
    {
        // SAFETY: GetTickCount64 takes no arguments and only reads the
        // system's tick count.
        unsafe { windows_sys::Win32::System::SystemInformation::GetTickCount64() }
    }
}

/// [`monotonic_ms`] as a [`Clock`].
pub fn system_clock() -> Clock {
    Arc::new(monotonic_ms)
}

/// What a run's watch has told it so far.
#[derive(Clone, Debug, Default)]
struct State {
    /// The newest notice.
    notice: Option<Notice>,
    /// Why the watch ended, once it has. The newest notice's window still
    /// holds until its deadline: an ended watch only means no renewal
    /// comes.
    ended: Option<String>,
}

/// Where a run stands with one role at a safe point, between batches.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Standing {
    /// The run holds the role at `gen`, with at least [`MARGIN_MS`] of its
    /// acting window left.
    Acting { gen: u64 },
    /// The role is handed over to the computer that asked for it: the run
    /// starts nothing more.
    HandedBack,
    /// The run may not act for the role: why.
    Lost(String),
}

/// A run's hold on one role: the open watch, read and acknowledged in the
/// background while the run works. Closing it ([`Lease::close`]) closes the
/// watch and so releases the role.
pub struct Lease {
    role: String,
    route: Arc<dyn LeaseRoute>,
    runtime: super::runtime::OnRuntime,
    state: watch::Receiver<State>,
    /// Asks the reader to take every notice the watch already delivered
    /// before answering ([`Lease::settle`]).
    settle: mpsc::UnboundedSender<oneshot::Sender<()>>,
    reader: Option<tokio::task::JoinHandle<()>>,
    /// The handback notice a yield was answered `false` for: that request
    /// was withdrawn, so the notice no longer asks for the role.
    declined: std::sync::Mutex<Option<u64>>,
    /// The role was handed over: the run may not act for it again.
    handed_over: std::sync::atomic::AtomicBool,
}

impl Lease {
    /// Open `role`'s watch and wait up to [`FIRST_NOTICE`] for its first
    /// notice, then, when it doesn't hold the role, up to [`TAKE_DEADLINE`]
    /// for one that does. `Err` says why the run may not act for the role:
    /// Entorhinal refused or didn't answer, this computer wasn't given the
    /// role, the notice leaves less than the margin of its window, or it
    /// asked for the role and the run, with nothing in flight yet, handed
    /// it over. The watch is closed then.
    pub async fn open(leases: &dyn RoleLeases, role: &str, clock: &Clock) -> Result<Lease, String> {
        Self::open_watch(leases, role, clock, Default::default()).await
    }

    pub(crate) async fn open_on(
        runtime: super::runtime::OnRuntime,
        leases: Arc<dyn RoleLeases>,
        role: String,
        clock: Clock,
    ) -> Result<Lease, String> {
        let reader_runtime = runtime.clone();
        runtime
            .run(async move { Self::open_watch(&*leases, &role, &clock, reader_runtime).await })
            .await
            .map_err(|error| format!("opening the lease on the module runtime: {error}"))?
    }

    async fn open_watch(
        leases: &dyn RoleLeases,
        role: &str,
        clock: &Clock,
        runtime: super::runtime::OnRuntime,
    ) -> Result<Lease, String> {
        let Watch { notices, route } = leases
            .watch(role)
            .await
            .map_err(|error| format!("Entorhinal refused the {role} lease ({error})"))?;
        let (state_tx, state) = watch::channel(State::default());
        let (settle, settles) = mpsc::unbounded_channel();
        let reader = tokio::spawn(read(
            notices,
            Arc::clone(&route),
            role.to_owned(),
            state_tx,
            settles,
        ));
        let mut lease = Lease {
            role: role.to_owned(),
            route,
            runtime,
            state,
            settle,
            reader: Some(reader),
            declined: std::sync::Mutex::new(None),
            handed_over: std::sync::atomic::AtomicBool::new(false),
        };
        // The wait's answer borrows the state, which the reader can't
        // change while it is held: it ends with this statement.
        let answered = matches!(
            tokio::time::timeout(
                FIRST_NOTICE,
                lease
                    .state
                    .wait_for(|state| state.notice.is_some() || state.ended.is_some()),
            )
            .await,
            Ok(Ok(_))
        );
        let standing = if !answered {
            Standing::Lost(format!(
                "Entorhinal did not answer for {role} within {} seconds",
                FIRST_NOTICE.as_secs()
            ))
        } else if !lease.taken().await {
            Standing::Lost(format!(
                "this computer was not given {role} within {} seconds of asking",
                TAKE_DEADLINE.as_secs()
            ))
        } else {
            lease.standing(clock).await
        };
        match standing {
            Standing::Acting { .. } => Ok(lease),
            Standing::HandedBack => {
                lease.close().await;
                Err(format!(
                    "{role} was handed over to another computer that asked for it"
                ))
            }
            Standing::Lost(reason) => {
                lease.close().await;
                Err(reason)
            }
        }
    }

    pub fn role(&self) -> &str {
        &self.role
    }

    /// After the first notice: wait up to [`TAKE_DEADLINE`] for a notice
    /// that holds the role, or for the watch to end. `false` when neither
    /// came in time. A notice that doesn't hold is acknowledged by the
    /// reader as it arrives, which is what lets Entorhinal take the role.
    async fn taken(&mut self) -> bool {
        // The wait's answer borrows the state, which the reader can't
        // change while it is held: it ends with this statement.
        matches!(
            tokio::time::timeout(
                TAKE_DEADLINE,
                self.state.wait_for(|state| {
                    state.ended.is_some()
                        || state.notice.as_ref().is_some_and(|notice| notice.holding)
                }),
            )
            .await,
            Ok(Ok(_))
        )
    }

    /// Where the run stands with the role now, by `clock`, once every
    /// notice the watch already delivered is taken. Ask it only at a safe
    /// point, with no batch in flight: when the newest notice asks for the
    /// role, this is where the run offers it ([`YIELD_OP`]).
    pub async fn standing(&self, clock: &Clock) -> Standing {
        if self.handed_over.load(std::sync::atomic::Ordering::SeqCst) {
            return Standing::HandedBack;
        }
        self.settle().await;
        let notice = match self.window(clock) {
            Ok(notice) => notice,
            Err(lost) => return lost,
        };
        let asked =
            notice.handback && *self.declined.lock().expect("lease yields") != Some(notice.seq);
        if !asked {
            return Standing::Acting { gen: notice.gen };
        }
        let role = &self.role;
        let route = Arc::clone(&self.route);
        let answered =
            self.runtime
                .run(async move {
                    tokio::time::timeout(YIELD_DEADLINE, route.yield_role(notice.gen)).await
                })
                .await;
        match answered {
            Ok(Ok(Ok(true))) => {
                self.handed_over
                    .store(true, std::sync::atomic::Ordering::SeqCst);
                Standing::HandedBack
            }
            // The other computer withdrew its request: the run keeps the
            // role, within the same deadline, until a renewal extends it.
            Ok(Ok(Ok(false))) => {
                *self.declined.lock().expect("lease yields") = Some(notice.seq);
                self.settle().await;
                match self.window(clock) {
                    Ok(notice) => Standing::Acting { gen: notice.gen },
                    Err(lost) => lost,
                }
            }
            // Whether the role was handed over is unknown, so the run acts
            // no more for it.
            Ok(Ok(Err(error))) => {
                Standing::Lost(format!("the yield of {role} was not settled ({error})"))
            }
            Ok(Err(_)) => Standing::Lost(format!(
                "the yield of {role} got no answer within {} seconds",
                YIELD_DEADLINE.as_secs()
            )),
            Err(error) => Standing::Lost(format!("the yield of {role} was interrupted ({error})")),
        }
    }

    /// The newest notice, when it lets the run act now by `clock`: this
    /// computer holds the role and at least [`MARGIN_MS`] of the window is
    /// left. Otherwise why not.
    fn window(&self, clock: &Clock) -> Result<Notice, Standing> {
        let state = self.state.borrow().clone();
        let role = &self.role;
        let Some(notice) = state.notice else {
            return Err(Standing::Lost(match state.ended {
                Some(why) => format!("the {role} watch ended before any notice ({why})"),
                None => format!("no notice for {role} yet"),
            }));
        };
        if !notice.holding {
            return Err(Standing::Lost(format!(
                "this computer does not hold {role}"
            )));
        }
        let now = clock();
        let deadline = notice.deadline_ms();
        if now.saturating_add(MARGIN_MS) > deadline {
            return Err(Standing::Lost(format!(
                "the {role} acting window ends at {deadline} ms on the monotonic clock, \
                 less than {MARGIN_MS} ms after now ({now} ms)"
            )));
        }
        Ok(notice)
    }

    /// Wait until the reader has taken every notice the watch already
    /// delivered, so a check sees a notice that arrived while a batch ran.
    async fn settle(&self) {
        let (done, taken) = oneshot::channel();
        if self.settle.send(done).is_ok() {
            let _ = taken.await;
        }
    }

    /// Take every notice the watch delivered so far, before
    /// [`Lease::still_acting`] checks the window.
    pub async fn refresh(&self) {
        self.settle().await;
    }

    /// Whether a batch sent under generation `gen` may still be committed
    /// now by `clock`: the role was not handed over, and the newest notice
    /// taken holds it at that generation with at least [`MARGIN_MS`] of its
    /// window left. A model's answer can take longer than the window that
    /// was left when the batch was sent, so the dreamer checks again right
    /// before it commits, and discards the batch otherwise. Call
    /// [`Lease::refresh`] first. `Err` says why not.
    pub fn still_acting(&self, clock: &Clock, gen: u64) -> Result<(), String> {
        let role = &self.role;
        if self.handed_over.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(format!("{role} was handed over to another computer"));
        }
        match self.window(clock) {
            Ok(notice) if notice.gen == gen => Ok(()),
            Ok(notice) => Err(format!(
                "{role} is held at generation {} now, not at {gen}, the one the batch was sent under",
                notice.gen
            )),
            Err(Standing::Lost(why)) => Err(why),
            Err(Standing::HandedBack) => Err(format!("{role} was handed over to another computer")),
            Err(Standing::Acting { .. }) => Ok(()),
        }
    }

    /// Close the watch, which releases the role, and wait until it is
    /// closed.
    pub async fn close(mut self) {
        if let Some(reader) = self.reader.take() {
            reader.abort();
            let _ = reader.await;
        }
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        if let Some(reader) = self.reader.take() {
            reader.abort();
        }
    }
}

/// Read `notices` until the watch ends, acknowledging each on `route`
/// within [`ACK_DEADLINE`] and keeping the newest in `state`; answer each
/// settle request once every notice already delivered is taken. The
/// notices are dropped, which closes the watch, when it ends or the lease
/// is closed.
async fn read(
    notices: Box<dyn Notices>,
    route: Arc<dyn LeaseRoute>,
    role: String,
    state: watch::Sender<State>,
    mut settles: mpsc::UnboundedReceiver<oneshot::Sender<()>>,
) {
    let mut open = Some(notices);
    loop {
        let Some(notices) = open.as_mut() else {
            match settles.recv().await {
                Some(done) => {
                    let _ = done.send(());
                    continue;
                }
                None => return,
            }
        };
        tokio::select! {
            next = notices.next() => {
                if !take(&*route, &role, &state, next).await {
                    open = None;
                }
            }
            settle = settles.recv() => {
                let Some(done) = settle else { return };
                while let Some(notices) = open.as_mut() {
                    let Some(next) = notices.next().now_or_never() else { break };
                    if !take(&*route, &role, &state, next).await {
                        open = None;
                    }
                }
                let _ = done.send(());
            }
        }
    }
}

/// Take one event of the watch into `state`, acknowledging a notice on
/// `route`. `false` once the watch has ended.
async fn take(
    route: &dyn LeaseRoute,
    role: &str,
    state: &watch::Sender<State>,
    next: Option<Result<Notice, LeaseError>>,
) -> bool {
    match next {
        Some(Ok(notice)) => {
            let seq = notice.seq;
            let issued_at_ms = notice.issued_at_ms;
            state.send_modify(|state| state.notice = Some(notice));
            // Every notice is acknowledged, `holding: false` included.
            let ack_send_age_ms = monotonic_ms().saturating_sub(issued_at_ms);
            let ack = tokio::time::timeout(ACK_DEADLINE, route.ack(seq)).await;
            // Measure from issue, not receipt: the provider's deadline also
            // counts time spent waiting for this reader to run.
            let ack_latency_ms = monotonic_ms().saturating_sub(issued_at_ms);
            tracing::info!(
                role,
                seq,
                issued_at_ms,
                ack_send_age_ms,
                ack_latency_ms,
                acknowledged = matches!(&ack, Ok(Ok(()))),
                "ck-mc: dreamer: role lease notice acknowledgement"
            );
            match ack {
                Ok(Ok(())) if ack_latency_ms > SLOW_ACK_MS => tracing::warn!(
                    role,
                    seq,
                    ack_latency_ms,
                    "ck-mc: dreamer: slow role lease notice acknowledgement"
                ),
                Ok(Ok(())) => {}
                Ok(Err(error)) => tracing::warn!(
                    ack_latency_ms,
                    %role,
                    %seq,
                    %error,
                    "ck-mc: dreamer: acknowledging a role notice failed"
                ),
                Err(_) => tracing::warn!(
                    ack_latency_ms,
                    %role,
                    %seq,
                    timeout_secs = %ACK_DEADLINE.as_secs(),
                    "ck-mc: dreamer: acknowledging a role notice took longer than the deadline"
                ),
            }
            true
        }
        Some(Err(error)) => {
            state.send_modify(|state| state.ended = Some(error.to_string()));
            false
        }
        None => {
            state.send_modify(|state| state.ended = Some("the watch ended".to_owned()));
            false
        }
    }
}

#[cfg(test)]
#[path = "lease_tests.rs"]
mod tests;
