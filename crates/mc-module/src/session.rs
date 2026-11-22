//! One session's state, and everything that happens to it. A session's jobs
//! run one at a time on its own worker ([`crate::module`]), so nothing here
//! needs a lock.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use cortexkit_role_compaction::notice::{Conditions, Event, NoticeRequest};
use cortexkit_role_compaction::part::PartBody;
#[cfg(test)]
use cortexkit_role_compaction::read::ReadRequest;
use cortexkit_role_compaction::read::{Cursor, Detail, Select, SessionRef};
use cortexkit_role_compaction::ride::{RideCause, RideRequest};
use cortexkit_role_compaction::rules::RuleBreak;
use cortexkit_role_compaction::setup::SetupRequest;
use cortexkit_role_compaction::view::{
    AppliedView, ApplyViewAnswer, ApplyViewRequest, EditOp, InsertedImage, View, ViewRefusal,
    MAX_VIEW_BYTES,
};
use cortexkit_role_llm_runner::delivery_order::{DeliveryOrder, TemplateUse};
use cortexkit_role_llm_runner::send::SendRequest;
use serde_json::Value;

use crate::client::RunnerClient;
use crate::context_db::{ContextDb, StoredCompartment, StoredMemory};
use crate::index::{Extend, Index};
use crate::lanes;
use crate::pass::{self, Settings};
use crate::preset::Features;
use crate::reduce;
use crate::route::{Project, Route};
use crate::summary::head::{self, Baseline};
use crate::summary::run;
use crate::summary::trigger;
use crate::tokens;
use crate::view_builder;

/// How many of the newest summaries ck-mc may forget when the transcript no
/// longer holds the messages they end on and the runner reported no revert.
///
/// A revert ck-mc did not hear about (its notice was lost, or came while
/// ck-mc was down) looks, from ck-mc's side, exactly like a transcript that
/// lost its history to a runner fault that replaced or truncated it; only
/// the runner can say which happened. The summaries are the only compacted
/// record of that history. This bound limits what the inference can
/// destroy to the newest three summaries, which the session can summarize
/// again if their messages turn out to exist. A session that would lose
/// more is held instead: it forgets nothing until a later check finds the
/// messages again ([`Session::hold_transcript_behind`]).
const IMPLICIT_FORGET_LIMIT: usize = 3;

/// How many views offered in a row because the runner lost ck-mc's view may
/// end refused or dropped, with no new message since each was built, before
/// ck-mc stops forcing them (see `Session::lost_view_offers`).
const LOST_VIEW_OFFERS: u32 = 2;

#[derive(Clone)]
pub struct Session {
    command_answers: Arc<Vec<crate::store::CommandAnswer>>,
    wrapup_target: Option<wrapup::Target>,
    app: crate::app_read::SessionState,
    app_projection: app_projection::Projection,
    app_decisions: Vec<Value>,
    app_decisions_revision: u64,
    /// Decision records changed since they were last written to the store,
    /// by view version.
    app_decisions_unsaved: std::collections::BTreeMap<u64, crate::store::DecisionWrite>,
    app_cause: String,
    key: SessionRef,
    features: Features,
    preset: crate::catalog::Preset,
    reminder_counter: u64,
    render_failed: render_failed::State,
    conditions: Conditions,
    limits: crate::reads::Limits,
    window_over_budget: bool,
    child_harness: Option<String>,
    /// Only runners that opt in can verify the policy members in a view's checksum.
    view_anchor: bool,
    /// Whether this session already logged that its runner's conditions
    /// leave out the prompt size while its steps report usage.
    warned_no_prompt: bool,
    /// The execute threshold the newest pass ran under, and which setting
    /// decided it, for the apps' session metadata.
    pub(crate) threshold: (f64, &'static str),
    /// Fresh surface counts from the newest notice. Rides omit these counts
    /// and must not clear them.
    pub(crate) surface_tokens: (
        Option<cortexkit_role_compaction::tokens::SurfaceTokens>,
        Option<cortexkit_role_compaction::tokens::SurfaceTokens>,
    ),
    pub(crate) notes: crate::prompt_notes::Notes,
    index: Index,
    view_validation: crate::view_builder::ValidationCache,
    search_dirty_from: Option<u64>,
    search_reconcile_from: Option<u64>,
    scan_counts: crate::summary::chunk::CountCache,
    due_window: crate::summary::due::Window,
    #[cfg(any(test, feature = "notice-cost-timing"))]
    legacy_summary_scan: bool,
    /// No view may use an index left partial by an unsuccessful catch-up.
    index_ready: bool,
    /// Set while the session is held because its transcript does not hold
    /// the messages its summaries end on, and no revert was reported (see
    /// [`IMPLICIT_FORGET_LIMIT`]): how many checks have failed since the
    /// hold began. A held session reads no transcript, builds, offers and
    /// publishes no view, starts no summary and sends no reminder; every
    /// Setup, notice and ride first checks the summaries again, and the
    /// first check that passes resumes it. Not saved: Setup checks again
    /// after a restart.
    transcript_behind: Option<u64>,
    /// The runner refused ck-mc as this session's compaction provider
    /// (`compaction_not_permitted`: its plan names another provider or none,
    /// or it no longer holds the session). ck-mc keeps the session's state but
    /// does no work on it, publishes nothing and answers rides with nothing,
    /// until the runner's next Setup for the session.
    suspended: bool,
    /// The newest view the runner accepted (or took with a ride answer). The
    /// next view carries its edits forward.
    latest: Option<View>,
    /// The highest version ck-mc has built for the session, accepted or not,
    /// so a version number is never used twice.
    version: u64,
    /// The view version the runner last reported applying: a notice's, a
    /// ride's or Setup's `applied_view`, or the view read back with
    /// `session.applied_view`. 0 when it reports none. A view the runner
    /// accepted but has not applied yet is not counted here; the reading's
    /// judgement weighs it separately ([`Session::newest_accepted`]).
    newest_applied: u64,
    /// The newest reading the runner sent (`last_prompt_tokens`) measured a
    /// request rendered with an older view than `newest_applied`, or than a
    /// view the runner accepted and will render next. A runner can take a
    /// view while a request is in flight; that request's size arrives after
    /// the new view went out, and says nothing about the requests the new
    /// view makes. A reading that names no view is stale when it repeats a
    /// size from before the newest view: the one that view was built on, or
    /// one ignored as older than it (see the `spent_reading` module). Until
    /// a current reading arrives, every pressure decision treats usage as
    /// unknown ([`Session::pressure`]).
    reading_stale: bool,
    /// The stale reading last ignored that was older than `newest_applied`:
    /// its prompt size, the view version it named, and the `newest_applied`
    /// it was judged against. With one request in flight, a runner sends at
    /// most one distinct such reading per view it applies, repeated in that
    /// request's notices.
    ignored_reading: Option<(u64, u64, u64)>,
    /// The runner sent a second, different reading older than the view it
    /// still applies: it named a view it had already replaced for a request
    /// it sent later. Its view versions can't be trusted, and ignoring every
    /// such reading would switch off every pressure decision for good, so
    /// until the next Setup readings are judged as if they named no view.
    prompt_views_untrusted: bool,
    /// The prompt sizes from before the newest view: the one it was built on,
    /// and one ignored as older than it. A reading that names no view is
    /// judged against them (see the `spent_reading` module).
    spent_reading: Option<SpentReading>,
    /// Parts the model asked to drop, held for the next view.
    queued: BTreeSet<(String, String)>,
    /// The age sweep's bookmark from the previous pass with permission to
    /// rebuild: tool outputs at or below it were already far behind then.
    reclaim_bookmark: u64,
    notice_keep: bool,
    notice_reclaim_bookmark: u64,
    /// The bookmark a built view moves `reclaim_bookmark` to once the
    /// runner takes it (or once the pass ends without a view), so an undone
    /// view puts the bookmark back with everything else it changed.
    next_reclaim_bookmark: Option<u64>,
    next_notice_reclaim_bookmark: Option<u64>,
    /// An emergency batch landed during this stay in the force band. Another
    /// one waits until usage leaves the band, or a pass rewrites anyway, so
    /// the band never trickles one rewrite per pass.
    emergency_latched: bool,
    /// Set when the pass being built selected an emergency batch; it latches
    /// only once the runner takes the view.
    next_latch: bool,
    /// Set when the pass being built rewrites anyway (a lane edit, a head or
    /// cut that changes) but selected no emergency batch: once the runner
    /// takes the view, a later batch no longer waits for another rewrite.
    next_rearm: bool,
    /// A summary was published that no view the runner took shows yet: the
    /// next view refreshes the head for it even when nothing else changes.
    summary_unshown: bool,
    /// After a restart, until the view the runner applies is read back:
    /// ck-mc doesn't know which edits the next view must carry.
    latest_unknown: bool,
    /// Retry an unresolved view read without polling the runner every step.
    adoption_retry: Option<(tokio::time::Instant, u8)>,
    /// Summaries a head render found missing from `context.db`; the next
    /// build reads the session's summaries from there again
    /// ([`Session::reload_changed_summaries`]).
    summaries_missing: Option<Vec<i64>>,
    /// The `ctx_keep` the pass being built carries out. If the runner
    /// refuses that view or never gets it, the keep waits again: the model
    /// was told everything else goes.
    next_keep: Option<BTreeSet<lanes::PartKey>>,
    /// Parts whose edits once made a view fail ck-mc's own checks. Automatic
    /// lanes leave them alone, so the same failing view is not rebuilt on
    /// every pass.
    failed_parts: BTreeSet<lanes::PartKey>,
    /// The model was asked to call `ctx_keep` during this stay over the
    /// execute threshold; it is not asked again until usage falls below it.
    keep_requested: bool,
    /// What a `ctx_keep` call asked to keep. The next notice builds the view
    /// that keeps only that, whatever the usage: the model asked for it.
    pending_keep: Option<BTreeSet<lanes::PartKey>>,
    /// The highest notice number handled.
    seq: u64,
    /// The session's summaries, oldest first.
    summaries: Summaries,
    /// Resuming a session freed while quiet could not read its summaries
    /// from `context.db` again, so it holds only the newest. Nothing runs on
    /// it until a read succeeds ([`Session::summaries_ready`]).
    summaries_unread: bool,
    /// What newer summaries add to the history head, kept from the last view
    /// build until the summaries or the baseline's summary items change.
    head_summaries: Option<HeadSummaries>,
    /// What the head's baseline (`m[0]`, see the crate docs) holds; `None`
    /// until the first summary reaches a view.
    /// Immutable between accepted views: saved-state comparisons and snapshots
    /// share it instead of copying the full history on every quiet notice.
    baseline: Option<Arc<Baseline>>,
    /// A summarizer run is in progress.
    summarizing: bool,
    /// A validated answer waiting for the context store to accept it.
    pending_publication: Option<Box<summarizer::PendingPublication>>,
    /// The runner held a summarizer send back until an account has room:
    /// no summary run starts before the time it named. Kept in memory only.
    account_wait: Option<crate::summary::account_wait::Waiting>,
    /// What the summary run in flight changed when it started, so a run the
    /// runner refuses for an account can give it back.
    run_start: Option<RunStart>,
    /// When a summary run of this session was last served, in milliseconds
    /// since the Unix epoch: an account refusal older than that is stale.
    last_served_ms: i64,
    /// The next view re-renders the baseline (`m[0]`), because the
    /// request's prefix changes anyway or `m[0]`'s settings changed.
    fold_due: bool,
    /// Where summaries and memories are kept; absent only in tests.
    db: Option<Arc<ContextDb>>,
    project: Option<Project>,
    /// The scope's folder, which may be stamped without a project id (see
    /// [`Route::workdir`]): configuration and the summarizer's child sessions
    /// use it even when the session has no project.
    workdir: Option<String>,
    /// The agent the session works for, from its route's scope
    /// ([`Route::agent_id`]): its summaries' attribution facts name it.
    agent_id: Option<String>,
    /// The baseline a view being published was built on; it replaces
    /// `baseline` once the runner takes the view.
    next_baseline: Option<Arc<Baseline>>,
    /// A delta-only flush cannot discharge a pending baseline fold.
    next_flush: bool,
    /// How far each compressed text part is compressed, as the applied view
    /// shows it.
    caveman: lanes::CavemanState,
    /// The caveman state of the view being handed over, which counts once
    /// the runner takes it.
    next_caveman: Option<lanes::CavemanState>,
    /// The parts the view being handed over drops. Queued drops among them
    /// are forgotten once the runner takes it; a refused view leaves them
    /// queued for the next one.
    next_covered: Vec<lanes::PartKey>,
    /// Queued drops a refused view already carried once. A second refusal
    /// carrying one forgets it, so a drop the runner keeps refusing cannot
    /// make every later pass build a view it refuses.
    refused_once: BTreeSet<lanes::PartKey>,
    /// A runner may refuse an accepted view when the transcript moves before
    /// it serves it. Allow one rebuild, but guard against the same reason on
    /// the very next built version so a faulty view cannot loop every pass.
    transcript_retry: Option<(TranscriptRefusal, u64)>,
    /// A revert removed summaries the head shows. The next notice rebuilds
    /// the head whatever the usage: the model must not keep seeing history
    /// that was undone.
    head_stale: bool,
    /// The runner applied a view of ck-mc's that cuts, or a move installed
    /// the session's first view, so the host may hold a compaction marker:
    /// written at an applied view's cut, after which the host no longer loads
    /// the messages before it. Such a session takes no step while the runner
    /// applies no view, so ck-mc offers one whatever the usage when the
    /// runner loses its view. Never cleared.
    marker_possible: bool,
    /// The runner lost ck-mc's view in a session where `marker_possible`
    /// holds: it refused or dropped it, and applies none. While ck-mc holds
    /// no view of its own, a notice builds and offers one whatever the usage,
    /// within the bound `lost_view_offers` keeps. Cleared when the runner
    /// reports applying a view of ck-mc's.
    lost_view_due: bool,
    /// How many views offered because the runner lost ck-mc's view ended
    /// refused or dropped in a row, each with no new message since it was
    /// built. At [`LOST_VIEW_OFFERS`] notices force no more until the
    /// transcript grows; the next Setup may force one more. Not saved: a
    /// restart starts counting again.
    lost_view_offers: u32,
    /// The newest view offered because the runner lost ck-mc's view, kept
    /// until the transcript grows past the message it was built through.
    lost_view_offer: Option<LostViewOffer>,
    /// The `ctx_reduce` reminders' cadence.
    nudges: crate::nudges::State,
    /// When the session last got a clock note, and whether its plan refused
    /// one ([`crate::clock_note`]).
    clock_note: crate::clock_note::State,
    /// The ordinal of the last message the applied view cuts. The index
    /// starts there: what comes before is replaced by summaries.
    cut: Option<u64>,
    /// Messages a person wrote that the index no longer holds, so the
    /// reminders' turn count keeps counting them.
    pruned_turns: u64,
    /// The session never had a Setup: Magic Context serves its tools only
    /// ([`Session::tools_only`]).
    tools_only: bool,
    /// After a summarizer run that published nothing: the newest message at
    /// that moment, and whether the force band's one retry was used. The
    /// same history is not run again until a newer message arrives
    /// ([`Session::waits_for_new_history`]).
    no_progress: Option<(String, bool)>,
    /// The newest prompt a run has already summarized past once at the
    /// execute threshold ([`Session::summary_due`]).
    floor_lifted_for: Option<String>,
    /// A meaningful prompt whose floor may be lifted on the next notice only.
    floor_pending_for: Option<(u64, String)>,
    /// How much history the summarizer may still read in the drain quota's
    /// current ten-minute window.
    drain: crate::summary::drain::Drain,
    /// The raw tokens the run in progress reserved.
    reservation: Option<crate::summary::drain::Reservation>,
    /// The output text of tool results with answered images, read in full
    /// once, so the answered-images lane can keep the text and mark each
    /// removed image ([`lanes::image_results`]).
    image_outputs: std::collections::BTreeMap<lanes::PartKey, cortexkit_role_compaction::Text>,
    /// The session's memory context, fixed at its first Setup, or at its
    /// first `ctx_memory` call if that comes first, and what its writes
    /// record from it.
    memory_context: Option<crate::memory_profile::MemoryContext>,
    authority: Option<crate::memory_levels::Authority>,
    /// The decay classes of the memory profile `memory_context` resolves,
    /// which a fold ranks memories by; read once, and again when the
    /// context is set.
    head_classes: Option<Arc<std::collections::HashMap<String, String>>>,
    /// Views the runner took but has not yet confirmed it applies, oldest
    /// first, each with the state its acceptance replaced.
    unconfirmed: Vec<Unconfirmed>,
    /// Where the session's state is saved before a view leaves ck-mc, so a
    /// crash never leaves the runner holding a view ck-mc has forgotten.
    store: Option<Arc<crate::store::Store>>,
    /// The mural image `m[0]` last carried: its checksum and the PNG in
    /// base64, as the view sends it. Every view repeats `m[0]` byte for byte
    /// until the next fold, so the image is kept, not drawn again.
    mural_image: Option<(String, String)>,
    /// For a session moved onto its runner, the entry its first view there
    /// cut through. No view ck-mc publishes cuts before it, or goes without
    /// a cut ([`move_floor`]).
    move_floor: Option<MoveFloor>,
    /// A pass held its view back because the view could not meet the move
    /// floor, and no view has met it since: the hold is logged only once.
    move_floor_held: bool,
    /// The entry a `cut_before_numbers` refusal named as the last one the
    /// runner serves without part numbers ([`numbers_unknown`]). Not saved:
    /// after a restart the read that fills the index finds those entries
    /// marked again.
    numbers_refused: Option<MoveFloor>,
    /// A pass held its view back because it could not cut through the
    /// history without part numbers: the hold is logged only once.
    numbers_floor_held: bool,
    /// The numbers floor whose entries, and later history outside the
    /// protected tail, render nothing a summary would keep: the cut may pass
    /// them without a summary ([`numbers_unknown`]). Not saved: after a
    /// restart the same finding is made again.
    numbers_covered: Option<MoveFloor>,
    /// A session without a summarizer whose view the runner refused
    /// `cut_before_numbers`: it can never cut, so it builds no view until
    /// the next Setup.
    numbers_views_held: bool,
    /// The running tool call last logged as keeping the cut before the
    /// numbers floor, so the line is written once per call.
    numbers_running_logged: Option<String>,
    /// Tag numbers the runner refused as `numbers_unknown`. The refusal is
    /// permanent for the session, so ck-mc never asks for them again.
    numbers_unknown_tags: BTreeSet<u64>,
    /// The newest unconfirmed view waits to be offered again on the next
    /// notice: one offered again after a restart waits because the runner
    /// couldn't place its cut yet (`transient`), and one whose
    /// `session.apply_view` got no answer ([`Unconfirmed::answer_lost`])
    /// waits for the runner's next report.
    reoffer_pending: bool,
    /// The entry id of the runner's signed floor, as ck-mc last took it
    /// (see the `signed_floor` module). The runner strips signed reasoning at or before it.
    signed_floor: Option<String>,
    /// A floor a refusal showed the runner does not apply, while the
    /// runner's conditions keep naming it. Not saved.
    disproved_floor: Option<signed_floor::Disproved>,
    /// The highest `statement_seq` stamp ck-mc took from the runner's
    /// statements for this session, or the latest Setup's (see the
    /// `statement_order` module). Not saved.
    statement_seq: Option<u64>,
    /// The statement epoch the newest Setup this worker handled named
    /// (`None` when it named none). Checked against every notice and ride
    /// in queue order (see the `statement_order` module). Not saved.
    statement_epoch: Option<String>,
    /// The newest notice or ride was built before a statement ck-mc already
    /// took (see the `statement_order` module): it brought no reading, so
    /// its pass leaves the pressure state as the last reading left it. Not
    /// saved.
    statement_late: bool,
    /// How many such late notices and rides arrived since the last Setup,
    /// which reports the count in its closing log line. Not saved.
    late_statements: u64,
    /// The reads this session made to its runner, for Setup's log line.
    /// Not saved.
    runner_reads: RunnerReads,
}

/// A view the runner took (an `apply_view` it accepted, or a ride's answer)
/// and has not yet reported applying. The runner can still refuse it at a
/// step boundary (a `view_refused` event), and then ck-mc puts back what
/// accepting it changed: the queued drops it carried, the emergency latch,
/// the baseline, the caveman levels and the cut.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Unconfirmed {
    #[serde(serialize_with = "crate::store_text::view")]
    pub view: View,
    /// The queued drops the view carried.
    covered: Vec<lanes::PartKey>,
    /// Queued parts hidden by the cut, not by an individual edit. Refusing
    /// the cut restores these parts without blaming their queued drops.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    cut_covered: Vec<lanes::PartKey>,
    before: Before,
    /// The ordinal of the newest entry the index held when the view was
    /// built. A refusal naming a part beyond it names an entry the view
    /// could not have known.
    #[serde(default)]
    built_through: Option<u64>,
    /// The runner said it holds the view: it answered `session.apply_view`
    /// with an acceptance, or the view went out as a ride's answer. Until
    /// then ck-mc has only handed it over, and the call may have failed.
    /// The runner keeps an accepted view pending until its next step and
    /// reports the view before it as applied until then. A view it accepts
    /// between a tool's answer and the request that follows takes force one
    /// request late, so at most one request it renders after accepting goes
    /// out without this view, and every later one carries it; a reading
    /// under an older view measured a request sent before the runner took
    /// it ([`Session::judge_reading`]).
    ///
    /// Not saved. After ck-mc restarts it can't tell whether the runner
    /// still holds the view (it may never have received a ride's answer
    /// saved just before it went out), so the view counts again only once
    /// Setup offers it again and the runner's answer says it holds it.
    #[serde(skip)]
    accepted: bool,
    /// The readings under an older view that this accepted view excused, at
    /// most two different ones: each one's prompt size and the view it
    /// named. Two measured requests can follow acceptance
    /// under an older view: the one already in flight when the runner
    /// accepted (a session has one step in flight at a time), and the one
    /// request a runner may render before it takes a view it accepted
    /// between a tool's answer and that request. A runner takes an accepted
    /// view one request late at most, never two, so a third, different
    /// reading means the runner rendered a request after accepting the view
    /// without it ([`Session::judge_reading`]). Not saved, like `accepted`.
    #[serde(skip)]
    excused: Vec<(u64, u64)>,
    /// ck-mc handed the view over with `session.apply_view`, but no answer
    /// came back (the call's deadline passed, the connection dropped after
    /// the request was sent, or the client could not prove it stayed
    /// unsent): the runner may hold the view or may never have received it.
    /// Its acceptance line was not logged then. It is logged once the runner
    /// says it took the view: when an offer again is answered, or when the
    /// runner reports applying the view or a later one. Saved, so a view
    /// confirmed after ck-mc restarts still gets its line; left out of the
    /// saved text while unset, so other views save as before.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    answer_lost: bool,
    /// When ck-mc first handed the view over, in milliseconds since the Unix
    /// epoch (wall clock); set together with `answer_lost`, and kept when an
    /// offer again loses its answer too. A line logged on confirmation comes
    /// with a later notice, often after the step that first rendered the
    /// view, so it states this time. The cache-bust watcher
    /// (`packages/plugin/scripts/cache-bust-runner-views.ts`), which matches
    /// accepted views to prompt-cache rewrites, places the view by it rather
    /// than by the line's own time. Saved like `answer_lost`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    handed_over_ms: Option<i64>,
}

/// The state a view's acceptance replaced.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
struct Before {
    #[serde(default)]
    head_stale: bool,
    #[serde(serialize_with = "crate::store_text::optional_view")]
    latest: Option<View>,
    queued: BTreeSet<lanes::PartKey>,
    refused_once: BTreeSet<lanes::PartKey>,
    #[serde(default)]
    transcript_retry: Option<(TranscriptRefusal, u64)>,
    emergency_latched: bool,
    baseline: Option<Arc<Baseline>>,
    fold_due: bool,
    caveman: lanes::CavemanState,
    cut: Option<u64>,
    pruned_turns: u64,
    #[serde(default)]
    reclaim_bookmark: Option<u64>,
    #[serde(default)]
    notice_reclaim_bookmark: Option<u64>,
    #[serde(default)]
    summary_unshown: bool,
    #[serde(default)]
    pending_keep: Option<BTreeSet<lanes::PartKey>>,
    /// Left out of the saved text while there is none, so rows saved before
    /// it existed and rows of runners that send no reading don't change.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    spent_reading: Option<SpentReading>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    render_recovery: Option<(bool, Option<u64>)>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
enum TranscriptRefusal {
    FinalTurnRemoved,
    UnknownMessage,
    /// A signed part in an entry the index did not hold when the view was
    /// built. With a signed-thinking model in a tool loop, a request is in
    /// flight while ck-mc builds a view; its reply arrives with signed
    /// thinking that the view's earlier edits invalidate, and the view could
    /// not name it. That refusal is the race's, never a drop's, so it is not
    /// bounded like the others: every retry names a newer entry.
    NewSignedPart,
}

impl TranscriptRefusal {
    fn of(refusal: &ViewRefusal) -> Option<Self> {
        match refusal {
            ViewRefusal::Rule(RuleBreak::FinalTurnRemoved { .. }) => Some(Self::FinalTurnRemoved),
            ViewRefusal::UnknownMessage { .. } => Some(Self::UnknownMessage),
            _ => None,
        }
    }
}

/// Admission for a notice, before any lane selects work or publishes a view.
struct NoticePass {
    summary: Option<run::Request>,
    rebuild: bool,
    head_stale: bool,
    /// The rebuild is forced because the runner lost ck-mc's view.
    lost_view: bool,
}

/// A view offered because the runner lost ck-mc's view (see
/// `Session::lost_view_due`).
#[derive(Clone, Copy, Debug)]
struct LostViewOffer {
    version: u64,
    /// The newest message ordinal the index held when the view was built.
    through: u64,
    /// Whether the view's refusal or drop was counted already.
    ended: bool,
}

/// Running counts of the reads a session made to its runner, so Setup can
/// log what it read ([`Session::setup`]) without any work of its own.
/// Atomic only because some reads go through a shared borrow of the
/// session; a session's jobs still run one at a time.
#[derive(Default)]
struct RunnerReads {
    /// Transcript reads ck-mc started, failed ones included. A read of
    /// messages by id that the `reads` helpers split into several requests
    /// counts once.
    reads: AtomicU64,
    /// Entries those reads returned.
    entries: AtomicU64,
    /// `session.applied_view` calls.
    applied_view: AtomicU64,
    /// Those of them that failed.
    applied_view_failed: AtomicU64,
}

impl Clone for RunnerReads {
    fn clone(&self) -> Self {
        let Self {
            reads,
            entries,
            applied_view,
            applied_view_failed,
        } = self;
        Self {
            reads: AtomicU64::new(reads.load(Ordering::Relaxed)),
            entries: AtomicU64::new(entries.load(Ordering::Relaxed)),
            applied_view: AtomicU64::new(applied_view.load(Ordering::Relaxed)),
            applied_view_failed: AtomicU64::new(applied_view_failed.load(Ordering::Relaxed)),
        }
    }
}

/// What [`RunnerReads`] counted over some stretch, such as one Setup.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct ReadCounts {
    reads: u64,
    entries: u64,
    applied_view: u64,
    applied_view_failed: u64,
}

impl ReadCounts {
    /// Whether the runner's applied view was read back: `failed` when a
    /// call was made and failed, so a failed read is never reported as one
    /// that happened.
    fn read_back(&self) -> &'static str {
        if self.applied_view_failed > 0 {
            "failed"
        } else if self.applied_view > 0 {
            "yes"
        } else {
            "no"
        }
    }
}

impl RunnerReads {
    fn counts(&self) -> ReadCounts {
        let load = |counter: &AtomicU64| counter.load(Ordering::Relaxed);
        ReadCounts {
            reads: load(&self.reads),
            entries: load(&self.entries),
            applied_view: load(&self.applied_view),
            applied_view_failed: load(&self.applied_view_failed),
        }
    }

    /// What was counted since `before`, an earlier [`Self::counts`].
    fn since(&self, before: ReadCounts) -> ReadCounts {
        let now = self.counts();
        ReadCounts {
            reads: now.reads.saturating_sub(before.reads),
            entries: now.entries.saturating_sub(before.entries),
            applied_view: now.applied_view.saturating_sub(before.applied_view),
            applied_view_failed: now
                .applied_view_failed
                .saturating_sub(before.applied_view_failed),
        }
    }
}

/// What walking the summaries from the newest found, reading from the runner
/// the message each one ends on ([`Session::walk_summaries`]).
struct SummaryWalk {
    /// Forget the summaries that cover this ordinal or later ones.
    invalid_from: Option<u64>,
    /// How many summaries failed the check before the walk stopped.
    failed: usize,
}

/// The check every Setup makes, and every notice and ride of a held session,
/// when no revert was reported ([`Session::check_summaries`]).
enum SummaryCheck {
    /// A read failed, so nothing is known.
    ReadFailed,
    /// At most [`IMPLICIT_FORGET_LIMIT`] summaries failed. They cover the
    /// messages from `forget_from` on, which a revert ck-mc did not hear
    /// about may have removed, and may be forgotten.
    Whole { forget_from: Option<u64> },
    /// More summaries failed than may be forgotten on that inference.
    Behind { failed: usize },
}

/// What a summary run changed when it started ([`Session::summary_due`]).
#[derive(Clone)]
struct RunStart {
    /// The floor lift the run spent, if it spent one.
    lift: Option<SpentLift>,
    /// The run started at 95% usage or above.
    emergency: bool,
}

/// A floor lift a summary run spent when it started.
#[derive(Clone)]
struct SpentLift {
    /// The floor mark the run took.
    mark: Option<(u64, String)>,
    /// The prompt the floor was lifted for before the run.
    lifted_before: Option<String>,
}

/// How the account wait lets a summary run start
/// ([`Session::account_wait_admits`]).
enum AccountAdmit {
    /// The session waits for no account.
    NoWait,
    /// The wait's time has passed: this is the first run after it.
    AfterWait,
    /// Inside the wait at emergency usage: one try for the history that
    /// ends on this message.
    Emergency(Option<String>),
}

pub(crate) use crate::summary::index::{Summaries, SummaryIndex, UnreadSummaries};

/// [`head::newer_summaries`] as the last view build computed it, and what it
/// was computed from.
#[derive(Clone)]
struct HeadSummaries {
    /// The baseline items it was computed from. A baseline holding these, or
    /// the items it returned, gives the same result again.
    from: head::SummaryItems,
    /// The days the baseline it was computed from recorded for `m[1]`.
    from_days: Option<head::NewerDays>,
    through_sequence: i64,
    summaries_revision: u64,
    /// The model whose tokenizer counted the newer summaries.
    model: String,
    newer: head::NewerSummaries,
}

impl HeadSummaries {
    /// [`head::newer_summaries`] for `base`: kept in `cache` from an earlier
    /// call with the same summaries, model and baseline items and days, or
    /// computed now from the summaries `store` names and kept there. When
    /// `m[1]` heads them with new days ([`head::newer_days_due`]), `date`
    /// fills those days in first. `Err` when their rows can't be read.
    fn for_base(
        cache: &mut Option<Self>,
        base: &Baseline,
        summaries: &Summaries,
        store: Option<(&ContextDb, &str, &str)>,
        model: &str,
        counter: crate::count::Counter,
        date: impl FnOnce(&mut [StoredCompartment]),
    ) -> Result<head::NewerSummaries, UnreadSummaries> {
        if let Some(kept) = cache.as_ref().filter(|kept| {
            ((kept.from.same(&base.summary_items) && kept.from_days == base.newer_days)
                || (kept.newer.items().same(&base.summary_items)
                    && kept.newer.days() == base.newer_days.as_ref()))
                && kept.through_sequence == base.through_sequence
                && kept.summaries_revision == summaries.revision()
                && kept.model == model
        }) {
            return Ok(kept.newer.clone());
        }
        // Held in memory, unless no baseline the session keeps needed them.
        let newer_rows = summaries
            .rows_after(base.through_sequence, store)
            .map_err(UnreadSummaries::Failed)?;
        if !newer_rows.missing.is_empty() {
            return Err(UnreadSummaries::Missing(newer_rows.missing));
        }
        let newer = if head::newer_days_due(base, &newer_rows.found) {
            let mut rows: Vec<StoredCompartment> = newer_rows
                .found
                .iter()
                .map(|row| StoredCompartment::clone(row))
                .collect();
            date(&mut rows);
            head::newer_summaries(base, &rows, counter)
        } else {
            head::newer_summaries(base, &newer_rows.found, counter)
        };
        *cache = Some(Self {
            from: base.summary_items.clone(),
            from_days: base.newer_days.clone(),
            through_sequence: base.through_sequence,
            summaries_revision: summaries.revision(),
            model: model.to_owned(),
            newer: newer.clone(),
        });
        Ok(newer)
    }
}

/// The policy members a view carries, as a log line names them.
fn policy_members(view: &View) -> String {
    format!(
        "built_through {}, new_signed {}",
        if view.built_through.is_some() {
            "present"
        } else {
            "absent"
        },
        view.new_signed.as_deref().unwrap_or("absent")
    )
}

/// Whether the runner reports applying `view`.
fn same(applied: &AppliedView, view: &View) -> bool {
    applied.version == view.version && applied.checksum == view.checksum
}

/// A session freed while quiet ([`Session::quiet_carry`]): the session
/// itself, without what [`Session::resume_quiet`] reads again from the
/// stores or builds again. Its worker may stop meanwhile; this is all the
/// module keeps of the session.
pub(crate) struct QuietCarry(Box<Session>);

impl QuietCarry {
    /// The session's settings inputs, as [`Session::config_inputs`].
    pub(crate) fn config_inputs(&self) -> (Option<&str>, String, u64) {
        self.0.config_inputs()
    }

    pub(crate) fn config_project_id(&self) -> Option<&str> {
        self.0.config_project_id()
    }

    /// [`Session::pre_user`] on the freed session, which answers it as the
    /// resumed one would, so a person's message need not wait for a resume.
    /// Its memory search stops at the newest summary or, before the first,
    /// hides what the transcript and the view show
    /// ([`Session::search_scope`]): all kept.
    pub(crate) async fn pre_user(
        &self,
        settings: &Settings,
        text: &str,
        now_ms: u64,
    ) -> crate::pre_user::Addition {
        self.0.pre_user(settings, text, now_ms).await
    }

    /// [`Session::follow_workspace`] on the freed session, which keeps its
    /// memory context whole.
    pub(crate) fn follow_workspace(
        &mut self,
        project: Option<&str>,
        workspace: Option<String>,
    ) -> bool {
        self.0.follow_workspace(project, workspace)
    }
}

/// The borrowed form of a query embedding and the model ids it is compared
/// under.
fn semantic(
    (vector, model_id, chunk_model_id): &(Vec<f32>, String, String),
) -> crate::search::sources::Semantic<'_> {
    crate::search::sources::Semantic {
        vector,
        model_id,
        chunk_model_id,
    }
}

/// Run synchronous store work on Tokio's blocking pool and wait for it.
/// SQLite and the connection locks block, so a call waiting for a
/// connection on the session worker would hold one of the runtime's worker
/// threads, and every task scheduled on it would wait too. The session's
/// worker still waits for the answer, so its jobs keep their order. A panic
/// in `work` carries on here, as it would have inline.
async fn on_blocking_thread<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> T {
    match tokio::task::spawn_blocking(work).await {
        Ok(value) => value,
        Err(error) if error.is_panic() => std::panic::resume_unwind(error.into_panic()),
        Err(error) => panic!("ck-mc: a store read was cancelled: {error}"),
    }
}

/// The route's folder. A folder stamped without a project id gives a session
/// with no project: reductions, summaries and session notes work, while
/// memories, project notes, commit search and upkeep stay off until a later
/// Setup's scope names the project. That is said once per Setup.
fn folder_of(route: &Route) -> Option<String> {
    if route.project.is_none() {
        if let Some(folder) = &route.workdir {
            tracing::info!(
                "ck-mc: session {} has a folder but no project id ({folder}); \
                 project memories and upkeep are off for it",
                route.session.session
            );
        }
    }
    route
        .project
        .as_ref()
        .map(|project| project.root.clone())
        .or_else(|| route.workdir.clone())
}

/// A reading as conditions carry it: the prompt size and the view version
/// of the request it measured.
fn reading_of(conditions: &Conditions) -> (Option<u64>, Option<u64>) {
    (conditions.last_prompt_tokens, conditions.last_prompt_view)
}

fn conditions_of(request: &SetupRequest) -> Conditions {
    let mut conditions = Conditions::new(
        request.model.clone(),
        request.context_window,
        request.output_reserve,
        request.rules.clone(),
    );
    conditions.accepts_images = request.accepts_images;
    conditions.signed_floor = request.signed_floor.clone();
    conditions
}

fn list(tags: &[u64]) -> String {
    tags.iter()
        .map(|tag| format!("§{tag}§"))
        .collect::<Vec<_>>()
        .join(", ")
}

pub use crate::nudges::KEEP_KIND;

/// Roughly what dropping `covered` frees: the parts not already changed by
/// an earlier view.
fn freed_tokens(context: &lanes::Context, covered: &[lanes::PartKey]) -> u64 {
    covered
        .iter()
        .filter(|(mid, part)| !context.edited.covers(mid, part))
        .filter_map(|(mid, part)| context.index.find(mid, part))
        .map(|(_, part)| tokens::part(part))
        .sum()
}

/// A message's estimated size for the summarizer's boundary.
fn entry_tokens(entry: &cortexkit_role_compaction::read::Entry) -> u64 {
    entry.parts.iter().map(tokens::part).sum()
}

/// What summarizing a message removes from the model's view: its text and
/// tool calls (see [`tokens::removed_by_summary`]).
fn entry_removed_tokens(entry: &cortexkit_role_compaction::read::Entry) -> u64 {
    entry.parts.iter().map(tokens::removed_by_summary).sum()
}

#[cfg(test)]
mod summary_weight_tests {
    use super::*;
    use cortexkit_role_compaction::part::{Part, PartBody};
    use cortexkit_role_compaction::read::{Entry, Role};
    use cortexkit_role_compaction::rules::{EditCost, ProviderRules, SignedParts};
    use cortexkit_role_compaction::setup::ModelRef;
    use cortexkit_role_compaction::tokens::PartTokens;

    fn fixture(output_tokens: u64) -> Session {
        let route = Route {
            session: SessionRef::new("test", "mock", "summary-weight"),
            project: None,
            workdir: None,
            agent_id: None,
        };
        let request = SetupRequest::new(
            "summary-weight-test",
            ModelRef::new("test", "model"),
            100_000,
            0,
            ProviderRules::new(SignedParts::None, EditCost::Suffix),
            Vec::new(),
            1,
        );
        // A session with a summarizer, the only feature these tests need.
        let features = crate::preset::Features {
            summarizer: true,
            ..crate::preset::Features::NONE
        };
        let mut session = Session::new(&route, &request, features, None);
        session.conditions.last_prompt_tokens = Some(64_000);
        let mut text = Part::new(
            "text",
            PartBody::Text {
                text: "seed".into(),
            },
        );
        text.tokens = Some(PartTokens::count(1));
        let tool = |output| {
            let mut part: Part = serde_json::from_value(serde_json::json!({
                "id": "tool", "kind": "tool", "call_id": "read", "name": "read",
                "input": {"path": "a"}, "status": "completed", "digest": "d",
                "output_bytes": output * 4,
            }))
            .unwrap();
            part.tokens = Some(PartTokens::tool(8, output));
            part
        };
        session.index.extend_counted(
            vec![
                Entry::new(1, "seed", Role::Assistant, 1, vec![text]),
                Entry::new(2, "large", Role::Assistant, 2, vec![tool(output_tokens)]),
                Entry::new(3, "tail", Role::Assistant, 3, vec![tool(8_000)]),
            ],
            Some("test"),
        );
        session
    }

    #[test]
    fn summary_cap_and_drain_admit_a_small_head_followed_by_large_tool_output() {
        let mut session = fixture(30_000);
        let request = session
            .summary_due(&Settings::default())
            .expect("meaningful head");
        assert_eq!((request.from, request.until), (1, 3));
        assert_eq!(session.drain.spent, 9);
        assert_eq!(session.reservation.unwrap().tokens, 9);
    }

    #[test]
    fn summary_tail_and_meaningful_threshold_still_use_full_size() {
        let settings = Settings::default();
        let mut below = fixture(5_990);
        assert!(
            below.summary_due(&settings).is_none(),
            "5,999 raw tokens are not meaningful"
        );
        let mut at = fixture(5_991);
        let request = at
            .summary_due(&settings)
            .expect("6,000 raw tokens are meaningful");
        // The last tool's 8,000 output tokens protect it even though its call is tiny.
        assert_eq!(request.until, 3);
        assert_eq!(at.drain.spent, 9);
    }

    fn counted_head(reserve: u64, text_tokens: u64, input_tokens: u64) -> Session {
        let mut session = fixture(30_000);
        session.conditions.output_reserve = reserve;
        session.conditions.last_prompt_tokens =
            Some(pass::usable_window(&session.conditions) * 9 / 10);
        let mut entries = session.index.entries().to_vec();
        entries[0].parts[0].tokens = Some(PartTokens::count(text_tokens));
        entries[1].parts[0].tokens = Some(PartTokens::tool(input_tokens, 30_000));
        session.index = Index::default();
        session.index.extend_counted(entries, Some("test"));
        session
    }

    #[test]
    fn near_limit_summary_minimum_counts_text_and_input_not_tool_output() {
        for (reserve, text, input, runs) in [
            (0, 1, 8, false),
            (0, 1_991, 8, false),
            (0, 1_992, 8, true),
            (0, 1, 1_999, true),
            (20_000, 1_591, 8, false),
            (20_000, 1_592, 8, true),
        ] {
            let mut session = counted_head(reserve, text, input);
            let request = session.summary_due(&Settings::default());
            assert_eq!(
                request.is_some(),
                runs,
                "reserve {reserve}, text {text}, input {input}"
            );
            if let Some(request) = request {
                assert_eq!((request.from, request.until), (1, 3));
                assert_eq!(session.reservation.unwrap().tokens, text + input);
            } else {
                assert!(!session.summarizing);
                assert!(session.reservation.is_none());
                assert_eq!(session.drain.spent, 0);
            }
        }
    }

    #[test]
    fn near_limit_summary_minimum_follows_the_configured_force_band() {
        for (threshold, usage, runs) in [
            (65.0, 84.99, true),
            (65.0, 85.0, false),
            (90.0, 91.99, true),
            (90.0, 92.0, false),
        ] {
            let mut session = counted_head(0, 1, 8);
            session.conditions.last_prompt_tokens = Some((usage * 1_000.0) as u64);
            let settings = Settings {
                execute_threshold_percentage: threshold,
                ..Settings::default()
            };
            assert_eq!(
                session.summary_due(&settings).is_some(),
                runs,
                "threshold {threshold}, usage {usage}"
            );
        }
    }

    #[test]
    fn near_limit_summary_minimum_also_checks_the_scaled_emergency_tail() {
        for (input, runs) in [(998, false), (999, true)] {
            let mut session = counted_head(0, 1_001, input);
            let mut entries = session.index.entries().to_vec();
            entries[1].parts[0].tokens = Some(PartTokens::tool(input, 2_000));
            entries[2].parts[0].tokens = Some(PartTokens::tool(8, 3_000));
            session.index = Index::default();
            session.index.extend_counted(entries, Some("test"));
            let request = session.summary_due(&Settings::default());
            assert_eq!(request.is_some(), runs, "input {input}");
            if let Some(request) = request {
                assert_eq!((request.from, request.until), (1, 3));
            }
        }
    }

    #[test]
    fn near_limit_summary_minimum_never_blocks_95_percent_or_a_shrunken_window() {
        for prompt in [95_000, 110_000] {
            let mut session = counted_head(0, 1, 8);
            session.conditions.last_prompt_tokens = Some(prompt);
            assert!(session.summary_due(&Settings::default()).is_some());
        }
        let mut session = counted_head(0, 1, 8);
        assert!(session.summary_due(&Settings::default()).is_none());
        session.conditions.context_window = 90_000;
        assert!(session.summary_due(&Settings::default()).is_some());
    }
}

/// Whether `view` cuts the session's earlier messages.
fn cuts(view: &View) -> bool {
    view.edits
        .iter()
        .any(|edit| matches!(edit.op, EditOp::Cut { .. }))
}

/// Whether `answer` says the runner holds the view `version` it was offered:
/// it accepted the view, or refused it as not newer than that same version.
fn holds_offered(answer: &ApplyViewAnswer, version: u64) -> bool {
    match answer {
        ApplyViewAnswer::Accepted => true,
        ApplyViewAnswer::Refused {
            refusal: ViewRefusal::StaleVersion { latest, .. },
        } => *latest == version,
        _ => false,
    }
}

/// The part a runner's view refusal names as at fault, if it names one.
fn refusal_part(refusal: &ViewRefusal) -> Option<lanes::PartKey> {
    // SignedPartInvalid names the signed part these edits would invalidate,
    // not a dropped part. Excluding it from later drops would not repair the
    // offending view, so the refusal cannot single out one dropped culprit.
    match refusal {
        ViewRefusal::UnknownPart { mid, part }
        | ViewRefusal::StalePart { mid, part }
        | ViewRefusal::BadField { mid, part, .. }
        | ViewRefusal::Conflict { mid, part }
        | ViewRefusal::RunningTool { mid, part }
        | ViewRefusal::ForeignTag { mid, part, .. } => Some((mid.clone(), part.clone())),
        _ => None,
    }
}

/// Which of the previous view's history edits (the history head's two
/// messages and the cut) leave the next view. When an undo takes away a
/// session's last summary, the cut goes and so does a head this pass no
/// longer renders. A head this pass renders again stays as it was, with the
/// version that introduced it: the head also carries project docs and
/// memories, so a session with no summaries yet still shows one. Retiring
/// and re-adding it on every pass would give it a newer version each time,
/// which publishes a view on every execute pass and, under signed thinking,
/// makes every later thinking block look invalid.
fn retired_history(no_summaries: bool, ops: &[EditOp]) -> impl Fn(&EditOp) -> bool {
    let rendered: Vec<EditOp> = ops
        .iter()
        .filter(|op| head::is_head(op) || matches!(op, EditOp::Cut { .. }))
        .cloned()
        .collect();
    move |op| {
        no_summaries
            && (head::is_head(op) || matches!(op, EditOp::Cut { .. }))
            && !rendered.contains(op)
    }
}

#[cfg(test)]
mod retired_history_tests {
    use super::*;
    use cortexkit_role_compaction::view::{Edit, InsertAt, InsertedMessage};

    fn head_insert(id: &str, text: &str) -> EditOp {
        EditOp::Insert {
            at: InsertAt::Start,
            message: InsertedMessage::new(
                id,
                cortexkit_role_compaction::read::Role::User,
                vec![text.to_owned()],
            ),
        }
    }

    #[test]
    fn a_head_rendered_again_without_summaries_keeps_its_version() {
        let m0 = head_insert(head::M0_ID, "<project-docs>One crate.</project-docs>");
        let m1 = head_insert(head::M1_ID, "<session-history-since>(no new content)");
        let previous = View::seal(1, vec![Edit::new(1, m0.clone()), Edit::new(1, m1.clone())]);
        let ops = vec![m0.clone(), m1.clone()];
        let retire = retired_history(true, &ops);
        let next = view_builder::next_view(
            Some(&previous),
            &[],
            ops,
            &cortexkit_role_compaction::rules::ProviderRules::new(
                cortexkit_role_compaction::rules::SignedParts::None,
                cortexkit_role_compaction::rules::EditCost::Suffix,
            ),
            2,
            retire,
        )
        .unwrap();
        assert!(next.is_none(), "an unchanged head must publish nothing");
    }

    #[test]
    fn a_head_or_cut_no_longer_rendered_leaves_once_the_summaries_are_gone() {
        let m0 = head_insert(head::M0_ID, "<session-history>…");
        let cut = EditOp::Cut {
            through: "m9".into(),
        };
        let retire = retired_history(true, &[]);
        assert!(retire(&m0) && retire(&cut));
        // With summaries, nothing is retired here; a newer head replaces the
        // old one through the view builder.
        let retire = retired_history(false, &[]);
        assert!(!retire(&m0) && !retire(&cut));
    }
}

#[cfg(test)]
#[path = "lifecycle_tests.rs"]
mod lifecycle_tests;

#[cfg(test)]
#[path = "workspace_follow_tests.rs"]
mod workspace_follow_tests;

#[cfg(test)]
#[path = "session_attribution_tests.rs"]
mod session_attribution_tests;

#[path = "spent_reading.rs"]
mod spent_reading;
pub use spent_reading::SpentReading;

#[path = "app_read/projection.rs"]
mod app_projection;

#[path = "move_floor.rs"]
mod move_floor;
pub use move_floor::MoveFloor;

#[path = "signed_floor.rs"]
mod signed_floor;

#[path = "statement_order.rs"]
mod statement_order;

mod clock_note;
mod history_head;
mod lifecycle;
mod notices;
mod numbers_unknown;
mod pressure;
mod publish;
mod reads;
mod recent;
mod reminders;
pub(crate) mod render_failed;
mod summaries;
mod summarizer;
mod tools;
mod user_commands;
mod views;
pub(crate) mod wrapup;
pub(crate) use statement_order::epoch_admits;
use statement_order::{Standing, StatedView};

#[cfg(test)]
mod config_tests {
    use super::*;

    #[test]
    fn history_budget_uses_output_reserved_window() {
        use cortexkit_role_compaction::rules::{EditCost, ProviderRules, SignedParts};
        use cortexkit_role_compaction::setup::ModelRef;
        let route = Route {
            session: SessionRef::new("runner", "test", "budget"),
            project: None,
            workdir: None,
            agent_id: None,
        };
        let request = SetupRequest::new(
            "config-test",
            ModelRef::new("test", "model"),
            200_000,
            32_000,
            ProviderRules::new(SignedParts::None, EditCost::Suffix),
            Vec::new(),
            0,
        );
        let session = Session::new(&route, &request, crate::preset::Features::NONE, None);
        assert_eq!(
            session
                .head_shape(&Settings::default())
                .history_budget_tokens,
            16_380
        );
        let settings = crate::config::resolve_for_test(
            serde_json::json!({"execute_threshold_tokens": {"default": 84000}}),
            serde_json::json!({}),
            "test/model",
            168_000,
        );
        assert_eq!(session.head_shape(&settings).history_budget_tokens, 12_600);
    }
}

#[cfg(test)]
#[path = "../tests/support/agent_surface.rs"]
mod agent_surface_tests;
