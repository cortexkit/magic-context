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
use crate::summary::two_pass::turn_one;
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

#[derive(Clone)]
pub struct Session {
    command_answers: Arc<Vec<crate::store::CommandAnswer>>,
    app: crate::app_read::SessionState,
    app_projection: app_projection::Projection,
    app_decisions: Vec<Value>,
    app_decisions_revision: u64,
    app_decisions_dirty: bool,
    app_cause: String,
    key: SessionRef,
    features: Features,
    preset: crate::catalog::Preset,
    reminder_counter: u64,
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
    /// The `ctx_reduce` reminders' cadence.
    nudges: crate::nudges::State,
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
    /// reports the view before it as applied until then, so every request it
    /// renders after accepting carries this view; a reading under an older
    /// view measured a request sent before the runner took it
    /// ([`Session::judge_reading`]).
    ///
    /// Not saved. After ck-mc restarts it can't tell whether the runner
    /// still holds the view (it may never have received a ride's answer
    /// saved just before it went out), so the view counts again only once
    /// Setup offers it again and the runner's answer says it holds it.
    #[serde(skip)]
    accepted: bool,
    /// The one reading under an older view that this accepted view excused:
    /// its prompt size and the view it named. A session has one step in
    /// flight at a time, and an accepted view takes force at the runner's
    /// next step, so at most one measured request can follow acceptance
    /// under an older view: the one already in flight. A second, different
    /// one means the runner rendered a request after accepting the view
    /// without it ([`Session::judge_reading`]). Not saved, like `accepted`.
    #[serde(skip)]
    excused: Option<(u64, u64)>,
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

/// A session's summaries, oldest first (in sequence order), with a revision
/// that every change moves on. Values derived from the summaries are kept
/// against the revision they were derived at, instead of being derived again
/// on every step or compared summary by summary. Changes go through the
/// methods below, so none can leave the revision behind.
#[derive(Clone, Debug, Default)]
pub(crate) struct Summaries {
    list: Vec<StoredCompartment>,
    revision: u64,
}

impl Summaries {
    pub(crate) fn revision(&self) -> u64 {
        self.revision
    }

    pub(crate) fn replace(&mut self, list: Vec<StoredCompartment>) {
        self.list = list;
        self.revision += 1;
    }

    pub(crate) fn truncate(&mut self, len: usize) {
        self.list.truncate(len);
        self.revision += 1;
    }

    pub(crate) fn extend(&mut self, summaries: impl IntoIterator<Item = StoredCompartment>) {
        self.list.extend(summaries);
        self.revision += 1;
    }

    #[cfg(test)]
    pub(crate) fn push(&mut self, summary: StoredCompartment) {
        self.extend([summary]);
    }

    /// Edit the summaries in place.
    #[cfg(test)]
    pub(crate) fn edit(&mut self) -> &mut Vec<StoredCompartment> {
        self.revision += 1;
        &mut self.list
    }
}

impl std::ops::Deref for Summaries {
    type Target = [StoredCompartment];
    fn deref(&self) -> &[StoredCompartment] {
        &self.list
    }
}

/// [`head::newer_summaries`] as the last view build computed it, and what it
/// was computed from.
#[derive(Clone)]
struct HeadSummaries {
    /// The baseline items it was computed from. A baseline holding these, or
    /// the items it returned, gives the same result again.
    from: head::SummaryItems,
    through_sequence: i64,
    summaries_revision: u64,
    /// The model whose tokenizer counted the newer summaries.
    model: String,
    newer: head::NewerSummaries,
}

impl HeadSummaries {
    /// [`head::newer_summaries`] for `base`: kept in `cache` from an earlier
    /// call with the same summaries, model and baseline items, or computed
    /// now and kept there.
    fn for_base(
        cache: &mut Option<Self>,
        base: &Baseline,
        summaries: &Summaries,
        model: &str,
        counter: crate::count::Counter,
    ) -> head::NewerSummaries {
        if let Some(kept) = cache.as_ref().filter(|kept| {
            (kept.from.same(&base.summary_items) || kept.newer.items().same(&base.summary_items))
                && kept.through_sequence == base.through_sequence
                && kept.summaries_revision == summaries.revision()
                && kept.model == model
        }) {
            return kept.newer.clone();
        }
        let newer = head::newer_summaries(base, summaries, counter);
        *cache = Some(Self {
            from: base.summary_items.clone(),
            through_sequence: base.through_sequence,
            summaries_revision: summaries.revision(),
            model: model.to_owned(),
            newer: newer.clone(),
        });
        newer
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

impl Session {
    fn counter(&self) -> crate::count::Counter {
        crate::count::Counter::for_model(Some(&format!(
            "{}/{}",
            self.conditions.model.provider, self.conditions.model.model
        )))
    }

    pub(crate) fn publish_app(&mut self, app: &crate::app_read::AppRead, checkpoint: bool) {
        self.app_publish_update(app, checkpoint);
    }
    pub fn new(
        route: &Route,
        request: &SetupRequest,
        features: Features,
        db: Option<Arc<ContextDb>>,
    ) -> Self {
        Self {
            command_answers: Default::default(),
            app: Default::default(),
            app_projection: Default::default(),
            app_decisions: Vec::new(),
            app_decisions_revision: 0,
            app_decisions_dirty: false,
            app_cause: "publication".into(),
            db,
            project: route.project.clone(),
            workdir: folder_of(route),
            key: route.session.clone(),
            features,
            preset: crate::catalog::Preset::parse(&request.preset)
                .unwrap_or(crate::catalog::Preset::Head),
            reminder_counter: 0,
            conditions: conditions_of(request),
            limits: crate::reads::Limits::from_setup(request.limits.as_ref()),
            window_over_budget: false,
            warned_no_prompt: false,
            notes: Default::default(),
            surface_tokens: (None, None),
            threshold: (
                crate::pass::Settings::default().execute_threshold_percentage,
                "default",
            ),
            index: Index::default(),
            view_validation: Default::default(),
            search_dirty_from: None,
            search_reconcile_from: None,
            scan_counts: crate::summary::chunk::CountCache::default(),
            index_ready: true,
            transcript_behind: None,
            suspended: false,
            child_harness: request.child_harness.clone(),
            view_anchor: request.view_anchor == Some(true),
            latest: None,
            version: 0,
            newest_applied: 0,
            reading_stale: false,
            ignored_reading: None,
            prompt_views_untrusted: false,
            spent_reading: None,
            queued: BTreeSet::new(),
            reclaim_bookmark: 0,
            next_reclaim_bookmark: None,
            notice_reclaim_bookmark: 0,
            notice_keep: false,
            next_notice_reclaim_bookmark: None,
            emergency_latched: false,
            next_latch: false,
            next_rearm: false,
            summary_unshown: false,
            latest_unknown: false,
            next_keep: None,
            failed_parts: BTreeSet::new(),
            keep_requested: false,
            pending_keep: None,
            seq: 0,
            summaries: Summaries::default(),
            head_summaries: None,
            baseline: None,
            next_baseline: None,
            next_flush: false,
            caveman: lanes::CavemanState::default(),
            next_caveman: None,
            next_covered: Vec::new(),
            refused_once: BTreeSet::new(),
            transcript_retry: None,
            summarizing: false,
            account_wait: None,
            run_start: None,
            last_served_ms: 0,
            fold_due: false,
            head_stale: false,
            nudges: crate::nudges::State::default(),
            cut: None,
            pruned_turns: 0,
            tools_only: false,
            no_progress: None,
            floor_lifted_for: None,
            floor_pending_for: None,
            drain: Default::default(),
            reservation: None,
            image_outputs: std::collections::BTreeMap::new(),
            memory_context: None,
            authority: None,
            unconfirmed: Vec::new(),
            store: None,
            mural_image: None,
            move_floor: None,
            move_floor_held: false,
            signed_floor: None,
            disproved_floor: None,
            statement_seq: None,
            statement_epoch: None,
            statement_late: false,
            late_statements: 0,
            runner_reads: RunnerReads::default(),
        }
    }

    /// Save the session's state here before each view it hands over.
    pub fn set_store(&mut self, store: Option<Arc<crate::store::Store>>) {
        if let Some(store) = &store {
            self.app_decisions = store.app_decisions(&self.key);
            self.app_decisions_revision += 1;
        }
        self.store = store;
    }

    /// Whether the session's memory context is known yet.
    pub fn has_memory_context(&self) -> bool {
        self.memory_context.is_some()
    }

    /// Take the session's memory context. It never changes afterwards.
    pub fn set_memory_context(&mut self, context: crate::memory_profile::MemoryContext) {
        if self.memory_context.is_none() {
            self.authority = crate::memory_levels::Authority::from_context(&context);
            self.memory_context = Some(context);
        }
    }

    /// Whether the summarizer may read and admit memories: configured, and
    /// the session's memory profile was not refused. A refused profile keeps
    /// existing memories in the head.
    fn memory_admissions(&self, settings: &Settings) -> bool {
        settings.memory_enabled
            && !self.memory_context.as_ref().is_some_and(|context| {
                matches!(
                    context.profile.state.as_str(),
                    "unresolved" | "conflict" | "blocked" | "unavailable"
                )
            })
    }

    /// A session that only calls tools: a runner offers it `ctx_search`,
    /// `ctx_memory` and `ctx_note` without having Magic Context compact it, so
    /// it never had a Setup. Its tools read the project from the route; it has
    /// no transcript, views or summaries.
    pub fn tools_only(route: &Route, db: Option<Arc<ContextDb>>) -> Self {
        let request = SetupRequest::new(
            String::new(),
            cortexkit_role_compaction::setup::ModelRef::new(String::new(), String::new()),
            0,
            0,
            cortexkit_role_compaction::rules::ProviderRules::new(
                cortexkit_role_compaction::rules::SignedParts::None,
                cortexkit_role_compaction::rules::EditCost::Suffix,
            ),
            Vec::new(),
            0,
        );
        let mut session = Self::new(route, &request, Features::NONE, db);
        session.tools_only = true;
        session
    }

    /// Whether Magic Context compacts this session, including state restored
    /// before this process receives Setup, rather than only serving its tools.
    pub fn compacting(&self) -> bool {
        !self.tools_only
    }

    pub fn key(&self) -> &SessionRef {
        &self.key
    }

    /// Use the same preset and configuration policy as the runner's catalog.
    pub(crate) fn serves_tool(&self, name: &str, config: &crate::catalog::CatalogConfig) -> bool {
        if self.tools_only && matches!(name, "ctx_reduce" | "ctx_expand" | "ctx_keep") {
            return true; // These calls retain their explanatory tools-only refusal.
        }
        let mut config = config.clone();
        // A disabled memory tool has its own explanatory refusal. Preset
        // membership is still checked before that refusal is returned.
        if name == "ctx_memory" {
            config.memory_enabled = true;
        }
        crate::catalog::served_tools(
            self.preset,
            !self.tools_only,
            &serde_json::Map::new(),
            &config,
        )
        .iter()
        .any(|tool| tool.name == name)
    }

    /// What the session's settings depend on: its project folder, its model
    /// as `provider/model`, and its usable window.
    pub fn config_inputs(&self) -> (Option<&str>, String, u64) {
        let model = &self.conditions.model;
        (
            self.workdir.as_deref(),
            format!("{}/{}", model.provider, model.model),
            crate::pass::usable_window(&self.conditions),
        )
    }

    /// What must survive a restart.
    pub fn durable(&self) -> crate::store::Durable {
        let _timing = crate::notice_cost_timing::span("session.durable");
        crate::store::Durable {
            command_answers: self.command_answers_for_save(),
            app: self.app.clone(),
            compaction: (!self.tools_only).then(|| (self.features, self.conditions.clone())),
            preset: (!self.tools_only).then(|| self.preset.as_str().to_owned()),
            pending_keep: self.pending_keep.clone(),
            head_stale: self.head_stale,
            reminder_counter: self.reminder_counter,
            version: self.version,
            newest_applied: self.newest_applied,
            reading_stale: self.reading_stale,
            ignored_reading: self.ignored_reading,
            prompt_views_untrusted: self.prompt_views_untrusted,
            spent_reading: self.spent_reading,
            notes: self.notes.clone(),
            queued: self.queued.clone(),
            reclaim_bookmark: self.reclaim_bookmark,
            notice_reclaim_bookmark: self.notice_reclaim_bookmark,
            emergency_latched: self.emergency_latched,
            keep_requested: self.keep_requested,
            baseline: self.baseline.clone(),
            nudges: self.nudges.clone(),
            cut: self.cut,
            pruned_turns: self.pruned_turns,
            caveman: self.caveman.clone(),
            drain: self.drain.clone(),
            no_progress: self.no_progress.clone(),
            floor_lifted_for: self.floor_lifted_for.clone(),
            floor_pending_for: self.floor_pending_for.clone(),
            unconfirmed: self.unconfirmed.clone(),
            summary_unshown: self.summary_unshown,
            move_floor: self.move_floor.clone(),
            signed_floor: self.signed_floor.clone(),
        }
    }

    /// Take back what a previous ck-mc process saved for the session.
    pub fn restore(&mut self, durable: crate::store::Durable) {
        self.command_answers = durable.command_answers;
        self.app = durable.app.clone();
        self.tools_only = false;
        if let Some(preset) = durable
            .preset
            .as_deref()
            .and_then(crate::catalog::Preset::parse)
        {
            self.preset = preset;
        }
        if let Some((features, conditions)) = durable.compaction {
            self.features = features;
            self.conditions = conditions;
        }
        self.pending_keep = durable.pending_keep;
        self.head_stale = durable.head_stale;
        self.reminder_counter = durable.reminder_counter;
        self.version = durable.version;
        self.newest_applied = durable.newest_applied;
        self.reading_stale = durable.reading_stale;
        self.ignored_reading = durable.ignored_reading;
        self.prompt_views_untrusted = durable.prompt_views_untrusted;
        self.spent_reading = durable.spent_reading;
        self.notes = durable.notes;
        self.queued = durable.queued;
        self.reclaim_bookmark = durable.reclaim_bookmark;
        self.notice_reclaim_bookmark = durable.notice_reclaim_bookmark;
        self.emergency_latched = durable.emergency_latched;
        self.keep_requested = durable.keep_requested;
        self.baseline = durable.baseline;
        self.nudges = durable.nudges;
        self.cut = durable.cut;
        self.pruned_turns = durable.pruned_turns;
        self.caveman = durable.caveman;
        self.drain = durable.drain;
        self.no_progress = durable.no_progress;
        self.floor_lifted_for = durable.floor_lifted_for;
        self.floor_pending_for = durable.floor_pending_for;
        self.unconfirmed = durable.unconfirmed;
        // Whether the runner still holds a view it accepted before the
        // restart is unknown until Setup offers the view again (see
        // `Unconfirmed::accepted`).
        for pending in &mut self.unconfirmed {
            pending.accepted = false;
            pending.excused = None;
        }
        // Like refused_once, the retry guard survives in an unconfirmed
        // view's rollback snapshot, not in a separate store column.
        self.transcript_retry = self
            .unconfirmed
            .last()
            .and_then(|pending| pending.before.transcript_retry);
        self.summary_unshown = durable.summary_unshown;
        self.move_floor = durable.move_floor;
        self.signed_floor = durable.signed_floor;
        // A view handed over before the restart is the one ck-mc expects
        // the runner to show; Setup settles it.
        self.latest = self.unconfirmed.last().map(|pending| pending.view.clone());
        // Views are cumulative, and ck-mc doesn't store the confirmed one:
        // it reads it back from the runner (`session.applied_view`). Until
        // that read succeeds no view is built, or the next one would carry
        // none of the earlier edits and every dropped part would come back.
        self.latest_unknown = self.latest.is_none() && self.version > 0;
        self.distrust_state_ahead_of_summaries();
        // The first read after a restart starts at the cut: nothing before
        // it is visible to the model.
        self.index = Index::starting_at(self.cut.unwrap_or(1));
        self.index_ready = false;
    }

    /// Restore the transcript for a tool that arrived before the runner's
    /// first notice. This does not count as Setup in the current process.
    pub async fn restore_for_tools<C: RunnerClient>(&mut self, client: &C) {
        self.index_ready = self.read_until(client, None, true).await;
    }

    /// `mode3.db` and `context.db` are backed up separately, and a restore
    /// can pair this store with an older `context.db` (a night whose
    /// `context.db` capture failed keeps the previous one). Restored state
    /// may then cut, or show in `m[0]`, summaries `context.db` no longer
    /// has; those messages would be neither summarized nor shown. ck-mc
    /// trusts `context.db`: reading starts where its summaries end, `m[0]` is
    /// rendered again, views not yet confirmed are dropped, and the next view
    /// moves the cut back, so the summarizer covers those messages again.
    fn distrust_state_ahead_of_summaries(&mut self) {
        let covered = self.summarized_through();
        let cut_ahead = self
            .cut
            .is_some_and(|cut| covered.is_none_or(|covered| cut > covered));
        // A baseline folded before any summary records -1, the same value
        // as no summaries in context.db: that pair is consistent, not ahead.
        let last_sequence = self.summaries.last().map_or(-1, |summary| summary.sequence);
        let head_ahead = self
            .baseline
            .as_ref()
            .is_some_and(|baseline| baseline.through_sequence > last_sequence);
        if !cut_ahead && !head_ahead {
            return;
        }
        tracing::info!(
            "ck-mc: session {}: saved state is ahead of context.db's summaries (cut {:?}, summaries through {covered:?}); rebuilding from context.db",
            self.key.session, self.cut
        );
        if cut_ahead {
            self.cut = covered;
        }
        if head_ahead {
            self.baseline = None;
        }
        self.unconfirmed.clear();
        self.latest = None;
        self.head_stale = true;
    }

    /// Load the summaries `context.db` already holds for the session, such as
    /// those of a session moved in from a standalone host.
    pub fn load_summaries(&mut self) {
        let Some(db) = &self.db else {
            return;
        };
        match db.compartments(&self.key.harness, &self.key.session) {
            Ok(summaries) => {
                self.summaries.replace(summaries);
                self.app_projection.summaries_dirty = true;
            }
            Err(error) => tracing::warn!(
                "ck-mc: session {}: loading summaries failed: {error}",
                self.key.session
            ),
        }
    }

    /// Setup: take the conditions, and make sure ck-mc's view matches the one
    /// the runner applies (after a restart of either side it may not).
    ///
    /// A new session with a head gets its first view right away, before its
    /// first request: nothing is cached yet, so it costs nothing, and the
    /// model sees its memories and docs from the first step.
    ///
    /// Its end is logged with what it cost: a slow first step can wait on
    /// Setup's reads from the runner, and the line that opens Setup says
    /// nothing about them.
    pub async fn setup<C: RunnerClient>(
        &mut self,
        client: &C,
        settings: &Settings,
        route: &Route,
        request: &SetupRequest,
        features: Features,
    ) {
        let started = std::time::Instant::now();
        let before = self.runner_reads.counts();
        let late = std::mem::take(&mut self.late_statements);
        self.set_up(client, settings, route, request, features)
            .await;
        let read = self.runner_reads.since(before);
        tracing::info!(
            "ck-mc: session {}: setup done in {} ms: {} transcript reads returned {} entries; applied view read back: {}; {late} notices or rides built before one already taken arrived since the previous Setup",
            self.key.session,
            started.elapsed().as_millis(),
            read.reads,
            read.entries,
            read.read_back()
        );
    }

    /// What [`Session::setup`] does, with every early return.
    async fn set_up<C: RunnerClient>(
        &mut self,
        client: &C,
        settings: &Settings,
        route: &Route,
        request: &SetupRequest,
        features: Features,
    ) {
        let statement_epoch = request
            .statement_epoch
            .as_deref()
            .map(|epoch| epoch.chars().take(8).collect::<String>())
            .unwrap_or_else(|| "none".into());
        let statement_stamp = request
            .statement_seq
            .map(|stamp| stamp.to_string())
            .unwrap_or_else(|| "none".into());
        tracing::info!(
            "ck-mc: session {}: setup ({}, preset {}, model {}/{}, window {}, reserve {}, applied view {:?}, statement epoch {}, stamp {})",
            self.key.session,
            self.key.harness,
            request.preset,
            request.model.provider,
            request.model.model,
            request.context_window,
            request.output_reserve,
            request.applied_view.as_ref().map(|view| view.version),
            statement_epoch,
            statement_stamp
        );
        self.features = features;
        self.preset = crate::catalog::Preset::parse(&request.preset).expect("validated preset");
        self.tools_only = false;
        self.suspended = false;
        self.conditions = conditions_of(request);
        self.limits = crate::reads::Limits::from_setup(request.limits.as_ref());
        // Setup states the session as it is now: its epoch and stamp replace
        // the held ones, even when the stamp is lower than one taken before
        // (a runner restored from a backup). Without them, statements are
        // taken in arrival order again.
        self.statement_seq = request.statement_seq;
        self.statement_epoch = request.statement_epoch.clone();
        self.statement_late = false;
        // Setup is the runner's statement afresh: a floor a refusal showed
        // it contradicting is taken again if this Setup names it.
        self.disproved_floor = None;
        // Setup carries no reading, so none is stale. A runner that named
        // views it had already replaced is trusted again: Setup starts its
        // reports afresh.
        self.reading_stale = false;
        self.ignored_reading = None;
        self.prompt_views_untrusted = false;
        self.child_harness = request.child_harness.clone();
        self.view_anchor = request.view_anchor == Some(true);
        self.notice_keep = false;
        self.notice_keep = client.notice_keep(&self.key).await;
        self.project = route.project.clone();
        self.workdir = folder_of(route);
        self.seq = 0;
        // Before anything is offered, settled or read: a transcript that no
        // longer holds the summaries' history holds the session here, with
        // its state as it was.
        let check = self.check_summaries(client).await;
        let forget_from = match check {
            SummaryCheck::Behind { failed } => {
                self.hold_transcript_behind(failed, request.newest.as_ref());
                return;
            }
            // A failed read proves nothing, so a held session stays held.
            SummaryCheck::ReadFailed if self.transcript_behind.is_some() => return,
            SummaryCheck::ReadFailed => None,
            SummaryCheck::Whole { forget_from } => {
                self.release_transcript_hold();
                Some(forget_from)
            }
        };
        self.app_resume_head();
        self.settle_unconfirmed(request.applied_view.as_ref(), &[]);
        // Before anything is offered: a view offered again must meet the
        // floor too.
        self.load_move_floor(client).await;
        self.offer_unconfirmed_again(client).await;
        let Some(forget_from) = forget_from else {
            self.index_ready = false;
            return;
        };
        if let Some(ordinal) = forget_from {
            self.invalidate_transcript_from(ordinal);
        }
        let force = !self.index_ready || !self.index.entries().is_empty();
        let after = self.index.base().checked_sub(1).filter(|n| *n > 0);
        self.index_ready = self
            .read_until_from(client, request.newest.as_ref(), force, after)
            .await;
        if !self.index_ready {
            return;
        }
        // The floor names an entry, so it is taken once the read holds it.
        self.take_signed_floor();
        // A process can stop after the runner changed an older tool result but
        // before the background dirty mark was committed. On Setup, reconcile
        // the raw entries loaded from the summary cut through the newest row,
        // as well as the durable archive boundary. Nothing before that cut can
        // still carry a mutable raw tool result.
        self.search_reconcile_from = Some(self.index.base());
        // After the read, so the cut message of the view the runner applies
        // is in the index.
        if self.runner_differs(request.applied_view.as_ref()) {
            self.adopt_runner_view(client).await;
        }
        self.settle_spent_reading(request.applied_view.as_ref());
        if let Some(view) = &self.latest {
            self.view_validation.prime(self.index.entries(), view);
        }
        self.app_projection.head_read.ready = !self.latest_unknown;
        if self.features.summarizer && self.latest.is_none() && request.newest.is_none() {
            let (view, _) = self.build_now(client, settings).await;
            if let Some(view) = view {
                self.publish(client, view).await;
            }
        }
    }

    /// Handle a notice. Returns a summarizer run for the worker to start, when
    /// one is due. After the pass, the `ctx_reduce` reminders read what the
    /// model now sees.
    pub async fn notice<C: RunnerClient>(
        &mut self,
        client: &C,
        settings: &Settings,
        notice: NoticeRequest,
    ) -> Option<run::Request> {
        // Whether the notice belongs to the session as ck-mc holds it comes
        // first, before anything in it is taken, the notice number included.
        let Some(standing) = self.standing(&notice.conditions) else {
            self.log_foreign("notice", &notice.conditions);
            return None;
        };
        // Not newer than the last notice handled since Setup (compaction contract N5). Setup sets
        // the count to 0 and a runner's first notice after it is 1, so this
        // also ignores a notice numbered 0.
        if notice.seq <= self.seq || self.suspended {
            return None;
        }
        // A held session does nothing else until its summaries pass the
        // check again.
        let stated = StatedView::of(standing, notice.applied_view.as_ref());
        if self.transcript_behind.is_some()
            && !self
                .resume_if_transcript_whole(client, stated, notice.newest.as_ref())
                .await
        {
            return None;
        }
        let version = self.latest.as_ref().map(|view| view.version);
        let cut = self.cut_ordinal();
        let summary = self.handle_notice(client, settings, notice, standing).await;
        if !self.index_ready {
            return summary;
        }
        let rebuilt = self.latest.as_ref().map(|view| view.version) != version;
        let cut_moved = self.cut_ordinal() > cut;
        self.remind(client, settings, rebuilt, cut_moved).await;
        summary
    }

    async fn handle_notice<C: RunnerClient>(
        &mut self,
        client: &C,
        settings: &Settings,
        notice: NoticeRequest,
        standing: Standing,
    ) -> Option<run::Request> {
        self.seq = notice.seq;
        let previous = reading_of(&self.conditions);
        let previous_notes = self.notes.measured;
        let was_stale = self.reading_stale;
        self.take_conditions("notice", standing, &notice.conditions);
        if standing == Standing::Current {
            self.notes.notice(
                notice.conditions.notes_tokens,
                notice.token_family.as_deref(),
            );
            self.surface_tokens = (
                notice.conditions.system_tokens,
                notice.conditions.tools_tokens,
            );
        }
        let stated = StatedView::of(standing, notice.applied_view.as_ref());
        self.threshold = (
            settings.execute_threshold_percentage,
            settings.execute_threshold_source,
        );
        self.warn_if_prompt_size_missing(&notice.entries);
        // What the runner says about the views it took comes first: a
        // rollback restores the state before the events below change it.
        let refused: Vec<_> = notice
            .events
            .iter()
            .filter_map(|event| match event {
                Event::ViewRefused { version, refusal } => {
                    // A runner can take a view and refuse it later, at the
                    // step it would first serve it. The reason is the only
                    // record of why the view's work was undone.
                    tracing::warn!(
                        "ck-mc: session {}: runner refused view {version} at a step boundary: {refusal:?}",
                        self.key.session
                    );
                    Some((*version, refusal.clone()))
                }
                _ => None,
            })
            .collect();
        self.settle_stated(stated, &refused);
        let judged = self.judged_view(stated);
        match standing {
            Standing::Current => self.judge_reading(previous, judged.as_ref()),
            Standing::Older { .. } => self.judge_held_reading(was_stale, judged.as_ref()),
        }
        if self.reading_stale {
            // The apps keep the last current reading; its notes attribution
            // must stay with it while the newest notice's pending count advances.
            self.notes.measured = previous_notes;
        }
        for event in &notice.events {
            match event {
                Event::TranscriptChanged { from_ordinal } => {
                    self.search_dirty_from = Some(
                        self.search_dirty_from
                            .map_or(*from_ordinal, |old| old.min(*from_ordinal)),
                    );
                    if !self
                        .reconcile_reverted_summaries(client, *from_ordinal)
                        .await
                    {
                        self.index_ready = false;
                        return None;
                    }
                    if self
                        .summaries
                        .last()
                        .is_some_and(|summary| summary.end_message as u64 >= *from_ordinal)
                    {
                        // A summary on the replacement branch already covers
                        // the change; the delayed event must not erase it or
                        // its search rows.
                        continue;
                    }
                    self.app_projection.revert(*from_ordinal);
                    self.index.truncate(*from_ordinal);
                    self.clamp_bookmark_to_held();
                    if self.cut.is_some_and(|cut| *from_ordinal <= cut) {
                        // The undo reached the cut message or before it, and
                        // the summaries of what it removed are gone. The next
                        // view cuts at the last summary left; the index is
                        // read again from there.
                        self.cut = self.summarized_through();
                        self.index = Index::starting_at(self.cut.unwrap_or(1));
                    }
                }
                Event::ViewRefused { .. } => {}
                Event::MarkerWritten { .. } => {}
                // An event the contract may add later: its reach is unknown,
                // so the index is read again from the cut, the oldest message
                // the model still sees (compaction contract W1.5).
                other => {
                    tracing::info!(
                        "ck-mc: session {}: unknown notice event {other:?}; reading the transcript again",
                        self.key.session
                    );
                    self.index = Index::starting_at(self.cut.unwrap_or(1));
                }
            }
        }
        // A notice leaves its entries out when they are too large (compaction contract W5.2), and
        // then a change to an older message is not in it either: read from
        // the oldest entry that may have changed.
        let omitted = notice.entries.is_empty();
        let changed_from = if omitted {
            self.index.changeable_from()
        } else {
            notice
                .entries
                .first()
                .filter(|e| self.index.cursor().is_some_and(|c| e.ordinal <= c.ordinal))
                .map(|e| e.ordinal)
        };
        if let Some(from) = changed_from
            .into_iter()
            .chain(notice.entries.first().map(|entry| entry.ordinal))
            .min()
        {
            self.search_reconcile_from =
                Some(self.search_reconcile_from.map_or(from, |old| old.min(from)));
        }
        // No newest entry: the transcript is empty, and the read empties the
        // index.
        let extended = self
            .index
            .extend_counted(notice.entries, notice.token_family.as_deref());
        if extended == Extend::Diverged {
            self.app_projection.revert(self.index.base());
        }
        if extended == Extend::Diverged || !self.index_ready {
            let held_before: Vec<(u64, String)> = self
                .index
                .entries()
                .iter()
                .map(|entry| (entry.ordinal, entry.mid.clone()))
                .collect();
            self.index = Index::starting_at(self.cut.unwrap_or(1));
            self.index_ready = self.read_until(client, notice.newest.as_ref(), true).await;
            // A read that held the session keeps its state as it was.
            if extended == Extend::Diverged && self.transcript_behind.is_none() {
                // A change with no event: clamp to what the new transcript
                // still shares with the old one.
                let shared = self
                    .index
                    .entries()
                    .iter()
                    .take_while(|entry| {
                        held_before
                            .iter()
                            .any(|(ordinal, mid)| *ordinal == entry.ordinal && *mid == entry.mid)
                    })
                    .count();
                self.clamp_bookmark_to(shared);
            }
        } else if extended == Extend::Gap || !self.index.ends_at(notice.newest.as_ref()) {
            self.index_ready = self.sync(client, notice.newest.as_ref()).await;
        } else if let Some(newest) = notice.newest.as_ref().filter(|_| omitted) {
            self.index_ready = self.sync_from_changeable(client, newest).await;
        }
        if !self.index_ready {
            return None;
        }
        self.log_window_budget();
        self.take_signed_floor();
        // A view the runner applies that ck-mc does not expect (it lost one,
        // or restored an older one) is taken as ck-mc's own. After the read,
        // so the view's cut message is in the index.
        if self.runner_differs(self.judged_view(stated).as_ref()) {
            self.adopt_runner_view(client).await;
            // The reading was judged before ck-mc knew its own newest view.
            let judged = self.judged_view(stated);
            match standing {
                Standing::Current => {
                    if self.judge_spent_reading_after_adoption(previous, judged.as_ref()) {
                        self.notes.measured = previous_notes;
                    }
                }
                Standing::Older { .. } => self.judge_held_reading(was_stale, judged.as_ref()),
            }
        }
        self.forget_missing();
        // A stale reading changes no pressure state: the emergency latch and
        // the `ctx_keep` request stay as the last current reading left them.
        // Released on a reading that says nothing about usage, the latch would
        // let the next reading in the force band take a second emergency
        // batch right after the view that took the first. A late statement
        // brought no reading, so it changes none either.
        if !self.reading_stale && standing == Standing::Current {
            if !pass::in_force_band(&self.conditions, settings) {
                self.emergency_latched = false;
            }
            let execute = pass::at_execute(&self.conditions, settings);
            if !execute {
                self.keep_requested = false;
            }
        }
        // A `ctx_keep` waits while the summaries stop short of the move floor:
        // no view can land it then, and the pass below must still be free to
        // start the summary that reaches the floor again.
        let short_of_move_floor = self.short_of_move_floor();
        if let Some(kept) = self
            .pending_keep
            .take_if(|_| !self.latest_unknown && !short_of_move_floor)
        {
            let (view, _) = self.build(settings, None, false, Some(&kept));
            if let Some(view) = view {
                self.publish(client, view).await;
            }
            self.keep_requested = false;
            return None;
        }
        let decision = self.decide_notice(settings);
        if decision.rebuild {
            let (view, freed) = self.build_now(client, settings).await;
            if let Some(view) = view {
                self.publish(client, view).await;
            }
            if !decision.head_stale {
                self.ask_for_keep_if_short(client, settings, freed).await;
            }
        }
        decision.summary
    }

    /// One permission for the history refresh and every mutation lane. Summary
    /// admission runs first, so a run started here also holds the queued work.
    fn decide_notice(&mut self, settings: &Settings) -> NoticePass {
        let _timing = crate::notice_cost_timing::span("notice.decision");
        let summary = self.summary_due(settings);
        NoticePass {
            summary,
            rebuild: self.rebuild_permitted(settings),
            head_stale: self.head_stale,
        }
    }

    /// Whether the session's own state lets this pass rebuild: a stale head,
    /// or an execute pass with no summary on its way (or in the force band)
    /// and no signed-thinking hold. A notice asks this after admitting a
    /// summary run; a ride whose causes only say the provider forgot its
    /// cache asks it too, but never starts a summary.
    fn rebuild_permitted(&mut self, settings: &Settings) -> bool {
        let (hold, execute, force) = {
            let pressure = self.pressure();
            (
                pass::signed_thinking_hold(
                    self.index.entries(),
                    &pressure,
                    settings,
                    self.signed_floor(),
                ),
                pass::at_execute(&pressure, settings),
                pass::in_force_band(&pressure, settings),
            )
        };
        // A stale reading can't say whether usage is under the hold's cap.
        // When the turn holds heavy signed thinking, a fold waits for a
        // current reading, as the hold would make it wait.
        let fold_held = hold
            || (self.reading_stale
                && pass::heavy_signed_turn(
                    self.index.entries(),
                    &self.conditions,
                    self.signed_floor(),
                ));
        // A fold for a settings or window change waits out a heavy-thinking
        // turn, as an execute pass does: re-rendering `m[0]` then would drop
        // the signed thinking the model just paid for. The change is found
        // again on the next pass. A head made stale by an undo or a restore
        // can't wait: it shows history that no longer holds.
        if !fold_held && self.head_shape_changed(settings) {
            self.fold_due = true;
            self.head_stale = true;
        }
        self.head_stale || (execute && (force || !self.summary_on_its_way()) && !hold)
    }

    /// Judge the reading the conditions just taken carry, once the notice's
    /// or ride's `applied_view` is settled. A reading whose `last_prompt_view`
    /// is older than the view the runner applies, or is 0 (no view) once one
    /// is applied, measured bytes the runner no longer sends: a runner takes
    /// a view while a request is in flight, and that request's size arrives
    /// after the new view went out. Acting on it would build a second view
    /// for pressure the first one already relieved, and rewrite the cache
    /// again for nothing. A reading with no view version is judged only
    /// against the prompt sizes the newest view was built on or ignored
    /// ([`Session::judge_spent_reading`]): the runner could not tie it to a
    /// request, and a repeat of such a size is a measurement from before the
    /// view. So is every reading while the runner's view versions are
    /// disregarded (`prompt_views_untrusted`, below).
    ///
    /// A reading older than a view the runner accepted from ck-mc but does
    /// not apply yet is stale for the same reason ([`Session::newest_accepted`]):
    /// the runner keeps an accepted view pending until its next step and
    /// reports the view before it as applied until then, but every request it
    /// renders from then on carries the accepted view. A session has one step
    /// in flight at a time, so only the request already in flight when the
    /// runner accepted can be measured under the older view: the accepted
    /// views excuse one such measurement, and its repeats. A second,
    /// different one shows the runner rendered a later request without the
    /// view it accepted. ck-mc then stops counting the accepted views, warns
    /// once, and judges this reading and later ones by the applied view
    /// alone; the views stay unconfirmed until the runner applies or refuses
    /// them, or Setup offers them again.
    ///
    /// Repeats of the reading last ignored stay ignored. A different reading
    /// older than the same applied view means the runner named a replaced
    /// view for a request it sent later; from then until the next Setup its
    /// view versions are disregarded (`prompt_views_untrusted`): its readings
    /// are judged as if they named no view, and that reading counts. A
    /// reading stale only against an accepted view is never part of that
    /// check: the view a reading names is right there, and only the runner's
    /// applying of accepted views can be at fault.
    ///
    /// The stored conditions keep the last reading that was current, not the
    /// stale one, so the apps keep showing the usage they showed rather than
    /// the larger size from before the newest view, and a restart restores a
    /// reading that was current when it came. Pressure decisions read neither
    /// until a reading under the current view arrives ([`Session::pressure`]).
    fn judge_reading(
        &mut self,
        previous: (Option<u64>, Option<u64>),
        applied_view: Option<&AppliedView>,
    ) {
        self.reading_stale = false;
        if let Some(tokens) = self.unversioned_reading() {
            self.judge_spent_reading(previous, tokens, applied_view);
            return;
        }
        let (Some(tokens), Some(view)) = reading_of(&self.conditions) else {
            return;
        };
        let applied = self.newest_applied;
        let accepted = self.newest_accepted(applied_view);
        if view >= applied.max(accepted) {
            return;
        }
        if view >= applied && !self.excuse_in_flight(tokens, view, accepted) {
            // Judged by the applied view alone, which the reading is not
            // older than.
            return;
        }
        if view < applied {
            if let Some((ignored_tokens, ignored_view, _)) = self
                .ignored_reading
                .filter(|ignored| ignored.2 == applied && (ignored.0, ignored.1) != (tokens, view))
            {
                self.prompt_views_untrusted = true;
                self.ignored_reading = None;
                tracing::warn!(
                    "ck-mc: session {}: a second stale reading under applied view {applied}: {tokens} tokens from view {view}, after {ignored_tokens} tokens from view {ignored_view}; the runner names views it already replaced, so readings count whatever view they name until the next Setup",
                    self.key.session
                );
                return;
            }
            self.ignored_reading = Some((tokens, view, applied));
        }
        self.reading_stale = true;
        self.note_older_reading(tokens, view);
        let accepted_note = if accepted > applied {
            format!(", accepted {accepted}")
        } else {
            String::new()
        };
        tracing::info!(
            "ck-mc: session {}: ignoring a prompt of {tokens} tokens: reading from view {view}, newest applied {applied}{accepted_note}; waiting for a reading under the current view",
            self.key.session
        );
        (
            self.conditions.last_prompt_tokens,
            self.conditions.last_prompt_view,
        ) = previous;
    }

    /// Excuse a reading under an older view than the newest accepted one
    /// (`accepted`) as the request in flight when the runner accepted: the
    /// accepted views record it, and a repeat of it is excused again. A
    /// different reading after one was excused stops every accepted view
    /// counting, and returns false.
    fn excuse_in_flight(&mut self, tokens: u64, view: u64, accepted: u64) -> bool {
        let reading = (tokens, view);
        let earlier = self
            .unconfirmed
            .iter()
            .filter(|pending| pending.accepted)
            .find_map(|pending| pending.excused.filter(|excused| *excused != reading));
        let Some((earlier_tokens, earlier_view)) = earlier else {
            for pending in self
                .unconfirmed
                .iter_mut()
                .filter(|pending| pending.accepted)
            {
                pending.excused = Some(reading);
            }
            return true;
        };
        for pending in &mut self.unconfirmed {
            pending.accepted = false;
        }
        tracing::warn!(
            "ck-mc: session {}: runner accepted view {accepted} but measured a later request without it ({tokens} tokens from view {view}, after {earlier_tokens} tokens from view {earlier_view}); counting readings against the applied view {}",
            self.key.session,
            self.newest_applied
        );
        false
    }

    /// The newest view the runner accepted from ck-mc and still holds
    /// without applying it yet: 0 when there is none. A view leaves the
    /// unconfirmed list the moment the runner refuses it or ck-mc rolls it
    /// back, so it stops counting at once; it also stops counting once a
    /// reading shows the runner rendered a request without it
    /// ([`Session::excuse_in_flight`]). None counts while the runner
    /// applies a view ck-mc doesn't expect (`applied_view`, the one the
    /// notice or ride reports): a runner whose state went back no longer
    /// holds what it accepted, and measures under the view it applies.
    fn newest_accepted(&self, applied_view: Option<&AppliedView>) -> u64 {
        if self.runner_differs(applied_view) {
            return 0;
        }
        self.unconfirmed
            .iter()
            .filter(|pending| pending.accepted)
            .map(|pending| pending.view.version)
            .max()
            .unwrap_or(0)
    }

    /// The conditions every pressure decision reads: the execute threshold,
    /// the force band, the summary trigger's pressure, the signed-thinking
    /// hold's cap and the emergency drop's prompt size. After a stale reading
    /// they carry no reading at all, exactly as conditions without
    /// `last_prompt_tokens` do.
    fn pressure(&self) -> std::borrow::Cow<'_, Conditions> {
        if !self.reading_stale {
            return std::borrow::Cow::Borrowed(&self.conditions);
        }
        let mut conditions = self.conditions.clone();
        conditions.last_prompt_tokens = None;
        conditions.last_prompt_view = None;
        std::borrow::Cow::Owned(conditions)
    }

    /// A summarizer run to start now, if one is due: the session has a
    /// summarizer, none is running, and the history it may read is worth a
    /// run at this usage.
    fn summary_due(&mut self, settings: &Settings) -> Option<run::Request> {
        let threshold = settings.execute_threshold_percentage;
        let usage = pass::usage(&self.pressure()).unwrap_or(0.0) * 100.0;
        let prompt = self
            .index
            .entries()
            .iter()
            .rev()
            .find(|entry| trigger::is_meaningful_user(entry))
            .map(|entry| (entry.ordinal, entry.mid.clone()));
        // A stale reading says nothing about usage, so it doesn't clear the
        // mark: the mark waits for a reading under the current view. A late
        // statement brought no reading, so its pass leaves the mark too.
        let reading_new = !self.reading_stale && !self.statement_late;
        if (usage < threshold && reading_new)
            || self
                .floor_pending_for
                .as_ref()
                .is_some_and(|mark| Some(mark) != prompt.as_ref())
        {
            self.floor_pending_for = None;
        }
        if !self.features.summarizer || self.summarizing {
            return None;
        }
        let memory_enabled = self.memory_admissions(settings) && self.project.is_some();
        let window = pass::usable_window(&self.conditions);
        let force = pass::in_force_band(&self.pressure(), settings);
        let from = self.summarized_through().map_or(1, |ordinal| ordinal + 1);
        let tail = trigger::protected_tail_tokens(window, threshold, usage);
        let entries = self.index.entries();
        let budget = trigger::trigger_budget(window, threshold);
        let cap = trigger::per_run_cap(window, threshold, usage);
        let quota = crate::summary::drain::Usage {
            now: self.clock(),
            percentage: usage,
            threshold,
            force,
            usable: ((window as f64 * threshold / 100.0).round() as u64).max(1),
            per_run_cap: cap,
        };
        // At or over the threshold, a pass that starts no summary logs why, so
        // a session that stays over the threshold without summarizing can be
        // explained from the log.
        let at_threshold = usage >= threshold;
        let session = self.key.session.clone();
        let held = |why: std::fmt::Arguments<'_>| {
            if at_threshold {
                tracing::info!(
                    "ck-mc: session {session}: no summary at {usage:.0}% (threshold {threshold:.0}%): {why}"
                );
            }
        };
        if self.drain.exhausted(&quota) {
            held(format_args!(
                "the drain quota is spent ({} tokens this window)",
                self.drain.spent
            ));
            return None;
        }
        // The trigger uses the session model; a routed summarizer gets its own
        // counter when the run starts. Only estimated counts need scaling.
        let model = &self.conditions.model;
        let counter =
            crate::count::Counter::for_model(Some(&format!("{}/{}", model.provider, model.model)));
        let calibration = counter.calibration();
        let ratio = calibration
            .prose_ratio
            .max(calibration.tools_ratio)
            .max(1.0);
        let scan_lines = (trigger::scan_budget(budget) as f64 / ratio).floor() as u64;
        let bounded = |tail_tokens: u64, lift: bool| {
            let until = trigger::tail_start(entries, entry_tokens, from, tail_tokens, lift);
            trigger::cap_run(entries, entry_removed_tokens, from, until, cap)
        };
        let after_drops = force
            .then(|| self.usage_after_drops(settings, usage))
            .flatten();
        let mut scan_at = |until: u64| -> Option<trigger::Scan> {
            let low = entries.partition_point(|entry| entry.ordinal < from);
            let high = entries.partition_point(|entry| entry.ordinal < until);
            let readable = &entries[low..high.max(low)];
            let chunk = self.scan_counts.build(readable, scan_lines, counter)?;
            Some(trigger::Scan {
                tokens: (chunk.token_estimate as f64 * ratio).ceil() as u64,
                has_more: chunk.has_more,
                commit_clusters: chunk.commit_clusters,
                messages: chunk.messages,
                raw_tokens: readable.iter().map(entry_tokens).sum(),
                removed_tokens: readable.iter().map(entry_removed_tokens).sum(),
            })
        };
        let pressure = trigger::Pressure {
            usage,
            threshold,
            force,
            usable_window: window,
            // Drops land only on a pass allowed to rebuild. A head whose
            // summary is still to come is allowed one in the force band, so
            // the usage after its drops counts there.
            after_drops,
        };
        let mut decide = |until: u64| {
            trigger::decide(
                &pressure,
                scan_at(until).as_ref(),
                budget,
                settings.commit_clusters,
            )
        };
        // Consume the mark before inspecting the lifted head. A head that has
        // shrunk cannot re-arm the same mark on this evaluation. A pass after
        // a stale reading leaves the mark for the next current one, since
        // lifting the floor is for a pass at the threshold.
        let taken_mark = if reading_new {
            self.floor_pending_for.take()
        } else {
            None
        };
        let lift_floor = taken_mark.is_some();
        let mut until = bounded(tail, force || lift_floor);
        let mut decision = decide(until);
        if decision.is_none() && force {
            // Too little to read in the force band: the protected tail shrinks
            // to a half, or a quarter from 95% (the plugin's emergency tail
            // scale).
            let scale = if usage >= 95.0 { 0.25 } else { 0.5 };
            until = bounded((tail as f64 * scale) as u64, true);
            decision = decide(until);
        }
        if decision.is_none() {
            let prompt_ordinal = prompt.as_ref().map(|(ordinal, _)| *ordinal);
            // At the threshold, a long turn's history after the person's
            // newest prompt cannot be summarized while that prompt stays raw.
            // Mark only when lifting that floor exposes a meaningful head;
            // the next notice may lift it once, while queued work waits for it.
            if !force
                && !lift_floor
                && usage >= threshold
                && prompt.is_some()
                && prompt.as_ref().map(|(_, mid)| mid) != self.floor_lifted_for.as_ref()
            {
                let lifted = bounded(tail, true);
                if lifted > until && decide(lifted).is_some() {
                    self.floor_pending_for = prompt;
                }
            }
            let lifted = bounded(tail, true);
            let weights: Vec<(u64, u64)> = entries
                .iter()
                .filter(|entry| entry.ordinal >= from)
                .take(4)
                .map(|entry| (entry.ordinal, entry_tokens(entry)))
                .collect();
            held(format_args!(
                "nothing to summarize: messages {from}..{until} (unfloored {lifted}), protected tail {tail} tokens, per-run cap {cap}, trigger budget {budget}, after drops {after_drops:?}, floor mark {}, prompt {:?}, first weights {weights:?}",
                self.floor_pending_for.is_some(),
                prompt_ordinal
            ));
            return None;
        }
        if self.waits_for_new_history(force) {
            held(format_args!(
                "the last run made no progress; waiting for new history"
            ));
            return None;
        }
        let Some(admitted) = self.account_wait_admits(usage) else {
            // The floor's lift is for the run after the wait.
            if lift_floor {
                self.floor_pending_for = taken_mark;
            }
            return None;
        };
        let requested: u64 = self
            .index
            .entries()
            .iter()
            .filter(|entry| entry.ordinal >= from && entry.ordinal < until)
            .map(entry_removed_tokens)
            .sum();
        let Some(reservation) = self.drain.reserve(&quota, requested) else {
            tracing::info!(
                "ck-mc: session {}: summary skipped: drain budget spent ({} tokens this window)",
                self.key.session,
                self.drain.spent
            );
            return None;
        };
        self.reservation = Some(reservation);
        self.summarizing = true;
        tracing::info!(
            "ck-mc: session {}: summary started over messages {from}..{until} (~{requested} tokens)",
            self.key.session
        );
        self.note_account_run(admitted, usage);
        self.run_start = Some(RunStart {
            lift: lift_floor.then(|| SpentLift {
                mark: taken_mark,
                lifted_before: self.floor_lifted_for.clone(),
            }),
            emergency: usage >= 95.0,
        });
        // The lift is spent only by a run that actually starts.
        if lift_floor {
            self.floor_lifted_for = prompt.map(|(_, mid)| mid);
        }
        Some(run::Request {
            limits: self.limits,
            session: self.key.clone(),
            // Retries, repairs and turn two belong to one summary attempt;
            // keep them on one harness even if Setup changes during the run.
            child_harness: self.child_harness.clone(),
            from,
            until,
            project_root: self.workdir.clone(),
            project: self.project.as_ref().map(|project| project.id.clone()),
            two_pass: settings.turn_two && !settings.editor_pass,
            summaries: self.summaries.to_vec(),
            language: settings.language.clone(),
            memories: self.historian_memories(memory_enabled),
            memory_enabled,
            auto_promote: settings.auto_promote,
            emergency: force,
        })
    }

    /// The session's clock for the drain quota: when the runner wrote the
    /// newest message, which a notice follows at once. Decisions then follow
    /// the transcript alone, as every other decision here does; the wall
    /// clock is used only before the first message.
    fn clock(&self) -> i64 {
        self.index
            .entries()
            .last()
            .map(|entry| entry.written_at as i64)
            .filter(|written| *written > 0)
            .unwrap_or_else(|| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |elapsed| elapsed.as_millis() as i64)
            })
    }

    /// Usage once this pass's drops land: the model's queued drops and the
    /// reasoning over its budget, as a share of the transcript the model
    /// sees, applied to the reported usage (`compartment-trigger.ts`,
    /// `estimateProjectedPostDropPercentage`). `None` when nothing would go.
    fn usage_after_drops(&self, settings: &Settings, usage: f64) -> Option<f64> {
        let edited = lanes::Edited::of(self.latest.as_ref(), &self.index, self.cut);
        let context = lanes::Context {
            index: &self.index,
            edited: &edited,
            protected_tools: &settings.protected_tools,
            keep_first_message: self.features.keep_first_message,
            signed_floor: self.signed_floor(),
        };
        // Only queued drops this pass can land count: one in the protected
        // tail waits for it to move on, as `build` does and as the plugin
        // credits only eligible pending drops.
        let usable = pass::usable_window(&self.conditions);
        let floor = settings
            .protected_tokens
            .unwrap_or_else(|| lanes::default_protected_tokens(usable));
        let cutoff = lanes::protected_cutoff(&context, floor);
        let mut wanted: Vec<(lanes::PartKey, lanes::Shape)> = self
            .queued
            .iter()
            .filter(|key| !lanes::in_protected_tail(&context, key, cutoff))
            .map(|key| (key.clone(), lanes::Shape::Requested))
            .collect();
        let model = &self.conditions.model;
        wanted.extend(lanes::reasoning_over_budget(
            &context,
            settings.keep_reasoning_tokens,
            model.provider.contains("anthropic") || model.model.contains("claude"),
        ));
        let (_, covered) = lanes::drop_ops(&context, &wanted);
        let freed = freed_tokens(&context, &covered);
        let total: u64 = self
            .index
            .entries()
            .iter()
            .flat_map(|entry| entry.parts.iter().map(move |part| (entry, part)))
            .filter(|(entry, part)| !edited.covers(&entry.mid, &part.id))
            .filter(|(entry, part)| !lanes::stripped_by_floor(context.signed_floor, entry, part))
            .map(|(_, part)| tokens::part(part))
            .sum();
        (freed > 0 && total > 0).then(|| {
            let remaining = total.saturating_sub(freed) as f64;
            let projected = usage * (1.0 - (freed as f64 / total as f64).min(1.0));
            let window = usable as f64;
            if window == 0.0 {
                return projected;
            }
            // Keep the transcript-ratio projection, but don't let notes added
            // since the measured request make the drops look sufficient.
            let fixed = (projected * window / 100.0 - remaining).max(0.0);
            projected + (self.notes.fixed_part(fixed) - fixed) / window * 100.0
        })
    }

    /// Whether a run would read the same history a run before it failed to
    /// summarize, as the plugin's `historian-history-wait.ts`: it waits for a
    /// newer message, so a failing summary does not pay for the same input on
    /// every pass. In the force band it may try once more.
    fn waits_for_new_history(&mut self, force: bool) -> bool {
        let Some((newest, retried)) = &mut self.no_progress else {
            return false;
        };
        let current = self.index.entries().last().map(|entry| entry.mid.as_str());
        if current != Some(newest.as_str()) {
            self.no_progress = None;
            return false;
        }
        if force && !*retried {
            *retried = true;
            return false;
        }
        true
    }

    /// A run published nothing: wait for newer history before the next.
    fn record_no_progress(&mut self, settings: &Settings) {
        let Some(newest) = self.index.entries().last().map(|entry| entry.mid.clone()) else {
            return;
        };
        let force = pass::in_force_band(&self.pressure(), settings);
        let retried = match &self.no_progress {
            Some((previous, retried)) if *previous == newest => *retried || force,
            _ => force,
        };
        self.no_progress = Some((newest, retried));
    }

    /// Whether the account wait lets the run due now start, and how. `None`
    /// holds it back; the first run held back in a wait is logged, later
    /// ones are not. From 95% usage, where a primary session's turns wait
    /// for its summary, one run per newest message may start inside the
    /// wait: the account may have recovered, and the alternative is a
    /// refused turn. A refused try leaves nothing to retry until a newer
    /// message arrives.
    fn account_wait_admits(&mut self, usage: f64) -> Option<AccountAdmit> {
        let now = crate::summary::account_wait::now_ms();
        let newest = self.index.entries().last().map(|entry| entry.mid.clone());
        let session = &self.key.session;
        let Some(waiting) = &mut self.account_wait else {
            return Some(AccountAdmit::NoWait);
        };
        if !waiting.holds(now) {
            return Some(AccountAdmit::AfterWait);
        }
        if usage >= 95.0 && newest.is_some() && waiting.emergency_at != newest {
            return Some(AccountAdmit::Emergency(newest));
        }
        if !waiting.skip_logged {
            waiting.skip_logged = true;
            tracing::info!(
                "ck-mc: session {session}: summary skipped at {usage:.0}%: summaries wait for the account until {} ms since the epoch ({} after the {}); no summary run starts before then",
                waiting.refusal.until_ms,
                waiting.refusal.code,
                waiting.refusal.send.name()
            );
        }
        None
    }

    /// A run [`Session::account_wait_admits`] let through has started.
    fn note_account_run(&mut self, admitted: AccountAdmit, usage: f64) {
        let session = &self.key.session;
        match admitted {
            AccountAdmit::NoWait => {}
            AccountAdmit::AfterWait => {
                if let Some(waiting) = self.account_wait.take() {
                    tracing::info!(
                        "ck-mc: session {session}: the first summary run after the account wait started (the wait ran until {} ms since the epoch)",
                        waiting.refusal.until_ms
                    );
                }
            }
            AccountAdmit::Emergency(newest) => {
                if let Some(waiting) = &mut self.account_wait {
                    waiting.emergency_at = newest;
                    tracing::info!(
                        "ck-mc: session {session}: summary run started at {usage:.0}% inside the account wait (until {} ms since the epoch): one try for this history",
                        waiting.refusal.until_ms
                    );
                }
            }
        }
    }

    /// The runner held a summarizer send back until an account has room:
    /// no summary run starts for this session before the time it named. A
    /// try at emergency usage that met it again keeps its mark, so the next
    /// such try waits for newer history.
    pub(crate) fn account_refused(&mut self, wait: crate::summary::account_wait::AccountWait) {
        self.account_refused_at(wait, None);
    }

    /// [`Session::account_refused`] for a run that met the wait with
    /// `emergency_at` as its history: a run started at emergency usage,
    /// which asks again only once newer history arrives. A refusal received
    /// before the session's last served run is ignored: a second turn's wait
    /// can arrive after a later first turn found the accounts open again.
    fn account_refused_at(
        &mut self,
        wait: crate::summary::account_wait::AccountWait,
        emergency_at: Option<String>,
    ) {
        if wait.at_ms < self.last_served_ms {
            return;
        }
        let emergency_at = emergency_at.or_else(|| {
            self.account_wait
                .take()
                .and_then(|waiting| waiting.emergency_at)
        });
        let seconds = (wait.until_ms - crate::summary::account_wait::now_ms()).max(0) / 1000;
        tracing::info!(
            "ck-mc: session {}: summaries wait for the account until {} ms since the epoch (in {seconds} s): the runner refused the {} with {}",
            self.key.session,
            wait.until_ms,
            wait.send.name(),
            wait.code
        );
        self.account_wait = Some(crate::summary::account_wait::Waiting::new(
            wait,
            emergency_at,
        ));
    }

    /// The session's summaries wait for an account right now.
    fn summaries_wait_for_account(&self) -> bool {
        self.account_wait
            .as_ref()
            .is_some_and(|waiting| waiting.holds(crate::summary::account_wait::now_ms()))
    }

    /// The project's memories for the summarizer's `<project-memory>` block;
    /// none with memory off.
    fn historian_memories(&self, memory_enabled: bool) -> Vec<StoredMemory> {
        let (Some(db), Some(project), true) = (&self.db, &self.project, memory_enabled) else {
            return Vec::new();
        };
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_millis() as i64);
        db.project_memories(&project.id, now).unwrap_or_default()
    }

    /// After a revert removed messages from `ordinal` on, forget the summaries
    /// that cover any of them, as the standalone plugin does when its host
    /// reverts. If the history head showed one of them, it is rendered again
    /// from the summaries that remain.
    fn forget_summaries_from(&mut self, ordinal: u64) {
        let Some(first) = self
            .summaries
            .iter()
            .position(|summary| summary.end_message as u64 >= ordinal)
        else {
            return;
        };
        let sequence = self.summaries[first].sequence;
        let shown = self.baseline.is_some()
            || self
                .latest
                .as_ref()
                .is_some_and(|view| view.edits.iter().any(|edit| head::is_head(&edit.op)));
        if let Some(db) = &self.db {
            if let Err(error) =
                db.delete_compartments_from(&self.key.harness, &self.key.session, sequence)
            {
                tracing::warn!(
                    "ck-mc: session {}: deleting reverted summaries failed: {error}",
                    self.key.session
                );
            }
        }
        self.summaries.truncate(first);
        self.app_projection.summaries_dirty = true;
        // `m[0]` is rendered again only when it shows a forgotten summary;
        // one shown only in `m[1]` leaves with an `m[1]` refresh, and `m[0]`
        // stays cached.
        if self
            .baseline
            .as_ref()
            .is_none_or(|baseline| sequence <= baseline.through_sequence)
        {
            self.baseline = None;
        }
        self.head_stale |= shown;
    }

    /// A runner-reported revert (`TranscriptChanged`). The notice may be
    /// acknowledged before its revert runs, or arrive after a read already
    /// saw the replacement branch, so the summary endpoints are validated
    /// against the current transcript rather than deleted by a stale event.
    /// Every summary from `from` on whose last message is gone is forgotten.
    async fn reconcile_reverted_summaries<C: RunnerClient>(
        &mut self,
        client: &C,
        from: u64,
    ) -> bool {
        let Some(walk) = self.walk_summaries(client, from, true, None).await else {
            return false;
        };
        if let Some(ordinal) = walk.invalid_from {
            self.invalidate_transcript_from(ordinal);
        }
        true
    }

    /// The check made when no revert was reported: at Setup, and before each
    /// notice and ride while the session is held. Walks from the newest
    /// summary as a reported revert does, and permits forgetting the
    /// summaries that failed only while there are at most
    /// [`IMPLICIT_FORGET_LIMIT`] of them. It reads at most one message more
    /// than that limit.
    async fn check_summaries<C: RunnerClient>(&self, client: &C) -> SummaryCheck {
        let Some(walk) = self
            .walk_summaries(client, 1, false, Some(IMPLICIT_FORGET_LIMIT + 1))
            .await
        else {
            return SummaryCheck::ReadFailed;
        };
        if walk.failed <= IMPLICIT_FORGET_LIMIT {
            SummaryCheck::Whole {
                forget_from: walk.invalid_from,
            }
        } else {
            SummaryCheck::Behind {
                failed: walk.failed,
            }
        }
    }

    /// Walk the summaries that cover `from` or later, newest first, reading
    /// from the runner, by id, the message each one ends on. The walk stops
    /// at the first summary whose message is still there at its position,
    /// or after `give_up_after` summaries failed. Without a reported revert
    /// (`explicit_revert` false), a summary that lacks that message's id
    /// (older rows may) also stops it: missing metadata alone is not
    /// evidence of a revert. `None` when a read failed.
    async fn walk_summaries<C: RunnerClient>(
        &self,
        client: &C,
        from: u64,
        explicit_revert: bool,
        give_up_after: Option<usize>,
    ) -> Option<SummaryWalk> {
        let mut walk = SummaryWalk {
            invalid_from: None,
            failed: 0,
        };
        for summary in self
            .summaries
            .iter()
            .rev()
            .filter(|summary| summary.end_message as u64 >= from)
        {
            if give_up_after.is_some_and(|limit| walk.failed >= limit) {
                break;
            }
            if summary.end_message_id.is_empty() {
                if !explicit_revert {
                    break;
                }
                walk.invalid_from = Some(summary.start_message as u64);
                walk.failed += 1;
                continue;
            }
            let read = crate::reads::named_detail(
                client,
                &self.key,
                vec![summary.end_message_id.clone()],
                self.limits,
                Detail::Compact,
                |mids| Select::Mids { mids },
            )
            .await;
            self.count_read(read.as_ref().ok().map(Vec::len));
            let entries = match read {
                Ok(entries) => entries,
                Err(error) => {
                    if !error.message.starts_with("runner fault:") {
                        tracing::warn!(
                            "ck-mc: session {}: reconciling summaries failed: {error:?}",
                            self.key.session
                        );
                    }
                    return None;
                }
            };
            if entries.iter().any(|entry| {
                entry.mid == summary.end_message_id && entry.ordinal == summary.end_message as u64
            }) {
                break;
            }
            walk.invalid_from = Some(summary.start_message as u64);
            walk.failed += 1;
        }
        Some(walk)
    }

    /// Hold the session: the transcript does not hold the messages its
    /// summaries end on, and no reported revert explains it. Nothing is
    /// forgotten, and the state stays as it is; see `transcript_behind` for
    /// what a held session does. Logged once per hold, when it begins.
    fn hold_transcript_behind(&mut self, failed: usize, runner_newest: Option<&Cursor>) {
        self.index_ready = false;
        if let Some(checks) = &mut self.transcript_behind {
            *checks += 1;
            return;
        }
        self.transcript_behind = Some(1);
        let (end, end_id) = self.summaries.last().map_or((0, ""), |summary| {
            (summary.end_message, summary.end_message_id.as_str())
        });
        let runner = runner_newest.map_or_else(
            || "not named".to_owned(),
            |cursor| format!("entry {} ({})", cursor.ordinal, cursor.mid),
        );
        tracing::error!(
            "ck-mc: session {}: transcript_behind_summaries: {failed} of {} summaries end on messages the transcript no longer holds at their position, and the runner reported no revert (the check stops after {}); the newest summary ends at message {end} ({end_id}); the runner's newest entry: {runner}. Nothing is forgotten; the session reads, builds and summarizes nothing until a check finds those messages again",
            self.key.session,
            self.summaries.len(),
            IMPLICIT_FORGET_LIMIT + 1
        );
    }

    /// A check passed: a held session resumes. Logged under the same name
    /// as the hold, so the log shows where each hold ends.
    fn release_transcript_hold(&mut self) {
        if let Some(checks) = self.transcript_behind.take() {
            tracing::info!(
                "ck-mc: session {}: transcript_behind_summaries: the transcript holds the summaries' messages again after {checks} failed checks; the session resumes",
                self.key.session
            );
        }
    }

    /// A notice or ride for a held session checks the summaries again first.
    /// When the check passes, the session leaves the hold and does what
    /// Setup skipped while it was held: views are settled and offered again,
    /// and the summaries a missed revert reached are forgotten. The index is
    /// left not ready, so the caller reads the transcript again from the
    /// cut. Returns whether the session resumed.
    async fn resume_if_transcript_whole<C: RunnerClient>(
        &mut self,
        client: &C,
        applied: StatedView<'_>,
        runner_newest: Option<&Cursor>,
    ) -> bool {
        let forget_from = match self.check_summaries(client).await {
            SummaryCheck::Whole { forget_from } => forget_from,
            SummaryCheck::Behind { failed } => {
                self.hold_transcript_behind(failed, runner_newest);
                return false;
            }
            SummaryCheck::ReadFailed => return false,
        };
        self.release_transcript_hold();
        self.settle_stated(applied, &[]);
        self.load_move_floor(client).await;
        self.offer_unconfirmed_again(client).await;
        if let Some(ordinal) = forget_from {
            self.invalidate_transcript_from(ordinal);
        }
        // Changes the background indexer may have missed while the session
        // was held are reconciled from the cut, as after a Setup.
        let base = self.cut.unwrap_or(1);
        self.search_reconcile_from =
            Some(self.search_reconcile_from.map_or(base, |old| old.min(base)));
        true
    }

    /// A ride for a held session: check the summaries again, and once they
    /// pass, read the transcript now. A ride itself builds only from what
    /// the index holds, and the session resumes in this pass.
    pub async fn before_ride<C: RunnerClient>(&mut self, client: &C, ride: &RideRequest) {
        // Whether the ride belongs to the session as ck-mc holds it comes
        // first, before anything in it is taken. A ride from another epoch
        // is logged by `ride`, which sees it next.
        let Some(standing) = self.standing(&ride.conditions) else {
            return;
        };
        if self.transcript_behind.is_none() || self.suspended {
            return;
        }
        let stated = StatedView::of(standing, ride.applied_view.as_ref());
        if !self.resume_if_transcript_whole(client, stated, None).await {
            return;
        }
        self.index = Index::starting_at(self.cut.unwrap_or(1));
        self.index_ready = self.read_until(client, None, true).await;
        if self.index_ready && self.runner_differs(self.judged_view(stated).as_ref()) {
            self.adopt_runner_view(client).await;
        }
    }

    fn invalidate_transcript_from(&mut self, ordinal: u64) {
        self.forget_summaries_from(ordinal);
        self.index.truncate(ordinal);
        self.app_projection.revert(ordinal);
        if self.cut.is_some_and(|cut| ordinal <= cut) {
            self.cut = self.summarized_through();
            self.index = Index::starting_at(self.cut.unwrap_or(1));
        }
        self.search_dirty_from = Some(
            self.search_dirty_from
                .map_or(ordinal, |old| old.min(ordinal)),
        );
    }

    /// The id of the last message a summary covers.
    pub fn last_summary_end(&self) -> Option<String> {
        self.summaries
            .last()
            .map(|summary| summary.end_message_id.clone())
    }

    pub fn last_summary_ordinal(&self) -> Option<u64> {
        self.summarized_through()
    }

    /// The last ordinal a summary covers. Summaries name messages by
    /// ordinal, which counts from 1.
    fn summarized_through(&self) -> Option<u64> {
        self.summaries
            .last()
            .map(|summary| summary.end_message as u64)
    }

    /// A summarizer run ended. New summaries are stored, and when usage is at
    /// the execute threshold the view that shows them is built now: the pass
    /// that held its work for this summary is waiting on it.
    ///
    /// Returns the conversation the two-pass historian's second turn
    /// continues, once its first turn's summaries and candidates are stored.
    pub async fn summary_finished<C: RunnerClient>(
        &mut self,
        client: &C,
        settings: &Settings,
        result: Result<Option<run::Summarized>, run::SummaryError>,
        now_ms: i64,
    ) -> Option<run::Continuation> {
        self.summarizing = false;
        let reservation = self.reservation.take();
        let started = self.run_start.take();
        let (validated, publication, continuation) = match result {
            Ok(Some(summarized)) => {
                // The runner served the summarizer, so whatever account wait
                // an earlier send met is over, and an older one that arrives
                // late is stale.
                self.account_wait = None;
                self.last_served_ms = crate::summary::account_wait::now_ms();
                (
                    summarized.validated,
                    summarized.publication,
                    summarized.continuation,
                )
            }
            Ok(None) => {
                if let Some(reservation) = reservation {
                    self.drain.release(reservation);
                }
                self.record_no_progress(settings);
                return None;
            }
            // The runner held the send back until an account has room. That
            // is no failure: nothing reached a model, so the reservation goes
            // back, and no failure, backoff or error is recorded. The session
            // waits for the time the runner named instead.
            Err(run::SummaryError::AccountWait(wait)) => {
                if let Some(reservation) = reservation {
                    self.drain.release(reservation);
                }
                let mut emergency_at = None;
                if let Some(started) = started {
                    // A floor lift the run spent comes back for the run after
                    // the wait, as when the wait holds a run back before it
                    // starts.
                    if let Some(lift) = started.lift {
                        self.floor_pending_for = lift.mark;
                        self.floor_lifted_for = lift.lifted_before;
                    }
                    // A run started at emergency usage was that history's
                    // one try.
                    if started.emergency {
                        emergency_at = self.index.entries().last().map(|entry| entry.mid.clone());
                    }
                }
                self.account_refused_at(wait, emergency_at);
                return None;
            }
            // The summarizer failed: the reservation stays spent, so a broken
            // summarizer does not run again on every pass. The wait for new
            // history is only for a run that published nothing (the plugin's
            // `historian-history-wait.ts`): a provider that recovers may run
            // again on the same history while the quota lasts.
            Err(run::SummaryError::Failed(error)) => {
                self.app.failures += 1;
                self.app.last_error = Some(error.clone());
                tracing::warn!(
                    "ck-mc: session {}: summary failed: {error}",
                    self.key.session
                );
                let now = self.clock();
                self.drain.record_failure(now);
                return None;
            }
        };
        // A revert during the run may have removed what it summarized.
        let present = |mid: &str| self.index.entries().iter().any(|entry| entry.mid == mid);
        if validated.compartments.is_empty()
            || !validated.compartments.iter().all(|summary| {
                present(&summary.end_message_id) && present(&summary.start_message_id)
            })
        {
            if let Some(reservation) = reservation {
                self.drain.release(reservation);
            }
            self.record_no_progress(settings);
            return None;
        }
        // On the two-pass lane the facts are candidates for the second
        // turn, stored with the publication; they never become memories here.
        let two_pass = publication
            .as_ref()
            .is_some_and(|publication| publication.send.lane == turn_one::Lane::Enabled);
        if let Some(db) = &self.db {
            // Facts become memories of the session's project, with memory and
            // auto-promotion on; the validator already left them out otherwise.
            let facts: Vec<(String, String)> = validated
                .facts
                .iter()
                .map(|fact| (fact.category.clone(), fact.content.clone()))
                .collect();
            let promote = self
                .project
                .as_ref()
                .filter(|_| {
                    !two_pass
                        && self.memory_admissions(settings)
                        && settings.auto_promote
                        && !facts.is_empty()
                })
                .map(|project| crate::context_db::Promotion {
                    project: project.id.as_str(),
                    facts: facts.as_slice(),
                    authority: self.authority.as_ref(),
                });
            // The plugin stores one primer candidate per run, the first.
            let primer = match (&self.project, validated.primer_candidates.first()) {
                (Some(project), Some(candidate)) => {
                    let origin = candidate.origin_compartment_index;
                    let source = origin
                        .and_then(|at| at.checked_sub(1))
                        .and_then(|index| validated.compartments.get(index as usize))
                        .or(validated.compartments.first());
                    let source_time = source
                        .and_then(|summary| {
                            self.index
                                .entries()
                                .iter()
                                .find(|entry| entry.mid == summary.start_message_id)
                        })
                        .map_or(now_ms, |entry| entry.written_at as i64);
                    Some(crate::context_db::PrimerSource {
                        project: project.id.clone(),
                        question: candidate.question.clone(),
                        origin,
                        source_time,
                    })
                }
                _ => None,
            };
            let recall = crate::context_db::Recall {
                events: validated.events.clone(),
                primer,
            };
            if let Err(error) = db.publish_summaries(
                &self.key.harness,
                &self.key.session,
                &validated.compartments,
                promote,
                publication.as_ref(),
                &recall,
                now_ms,
            ) {
                self.app.failures += 1;
                self.app.last_error = Some(error.clone());
                tracing::warn!(
                    "ck-mc: session {}: storing summaries failed: {error}",
                    self.key.session
                );
                self.record_no_progress(settings);
                return None;
            }
        }
        self.no_progress = None;
        self.app_projection.summaries_dirty = true;
        self.summaries
            .extend(validated.compartments.iter().map(|compartment| {
                let mut stored = StoredCompartment::from(compartment);
                stored.created_at = now_ms;
                stored
            }));
        if !validated.compartments.is_empty() {
            self.summary_unshown = true;
            tracing::info!(
                "ck-mc: session {}: {} summaries published, through message {}",
                self.key.session,
                validated.compartments.len(),
                validated
                    .compartments
                    .last()
                    .map_or(0, |compartment| compartment.end_message)
            );
        }
        // The signed-thinking hold applies here as on a notice: the summary
        // lands on the next pass the hold lets through.
        let execute = {
            let pressure = self.pressure();
            pass::at_execute(&pressure, settings)
                && !pass::signed_thinking_hold(
                    self.index.entries(),
                    &pressure,
                    settings,
                    self.signed_floor(),
                )
        };
        if execute {
            let (view, _) = self.build_now(client, settings).await;
            if let Some(view) = view {
                self.publish(client, view).await;
            }
        }
        continuation.filter(|_| two_pass && self.db.is_some())
    }

    /// The second turn a two-pass summary's first turn calls for.
    pub fn turn_two_job(
        &self,
        settings: &Settings,
        continuation: run::Continuation,
    ) -> Option<crate::summary::two_pass::turn_two::Job> {
        Some(crate::summary::two_pass::turn_two::Job {
            owner: self.key.clone(),
            project: self.project.as_ref()?.id.clone(),
            project_root: self.workdir.clone(),
            continuation,
            memory_enabled: self.memory_admissions(settings),
            auto_promote: settings.auto_promote,
            embedding: settings.embedding.clone(),
            authority: self.authority.clone(),
        })
    }

    /// The ordinal the latest view's cut reaches: messages up to it are
    /// replaced by the history head.
    fn cut_ordinal(&self) -> Option<u64> {
        self.cut
    }

    /// Take `view`'s cut as the applied one, and forget the index before it.
    /// A cut message the index does not hold (a view adopted after a restart)
    /// leaves the known cut as it is.
    fn apply_cut(&mut self, view: &View) {
        let through = view.edits.iter().find_map(|edit| match &edit.op {
            EditOp::Cut { through } => Some(through),
            _ => None,
        });
        let Some(ordinal) = through.and_then(|through| {
            self.index
                .entries()
                .iter()
                .find(|entry| &entry.mid == through)
                .map(|entry| entry.ordinal)
        }) else {
            return;
        };
        // A cut ends where a summary ends. A runner's cut past the summaries
        // `context.db` holds comes from state newer than it (see
        // `distrust_state_ahead_of_summaries`): the index keeps those
        // messages, and the next view moves the cut back.
        if self
            .summarized_through()
            .is_none_or(|covered| ordinal > covered)
        {
            self.head_stale = true;
            return;
        }
        self.cut = Some(ordinal);
        let gone = self.index.prune_before(ordinal);
        self.app_persist_cut(&gone);
        self.pruned_turns += crate::nudges::person_turns(&gone);
    }

    /// Send the `ctx_reduce` reminders this pass calls for (see
    /// [`crate::nudges`]), measured on what the model sees now.
    async fn remind<C: RunnerClient>(
        &mut self,
        client: &C,
        settings: &Settings,
        rebuilt: bool,
        cut_moved: bool,
    ) {
        if self.index.entries().is_empty() {
            return;
        }
        let edited = lanes::Edited::of(self.latest.as_ref(), &self.index, None);
        let context = lanes::Context {
            index: &self.index,
            edited: &edited,
            protected_tools: &settings.protected_tools,
            keep_first_message: self.features.keep_first_message,
            signed_floor: self.signed_floor(),
        };
        let floor = settings.protected_tokens.unwrap_or_else(|| {
            lanes::default_protected_tokens(pass::usable_window(&self.conditions))
        });
        let protected_from = lanes::protected_cutoff(&context, floor);
        let measurement = crate::nudges::measure(&context, protected_from, &self.queued);
        let turns = self.pruned_turns + crate::nudges::person_turns(self.index.entries());
        let reminders = self.nudges.decide(&measurement, rebuilt, turns, cut_moved);
        let sends = [
            (reminders.tool_result, crate::nudges::REMINDER_KIND),
            (reminders.ceiling, crate::nudges::CEILING_KIND),
        ];
        for (template, kind) in sends {
            let Some(template) = template else {
                continue;
            };
            if kind == crate::nudges::CEILING_KIND {
                self.nudges.ceiling_sent = false;
            }
            let Some(send_id) = self.next_reminder_id(kind) else {
                continue;
            };
            let request = self.reminder(client, send_id, template, kind).await;
            if let Err(error) = client.send(&self.key, request).await {
                tracing::warn!(
                    "ck-mc: session {}: session.send failed: {error:?}",
                    self.key.session
                );
            } else if kind == crate::nudges::CEILING_KIND {
                self.nudges.ceiling_sent = true;
            }
        }
    }

    /// ck-mc measures usage only from the conditions' `last_prompt_tokens`.
    /// A runner that leaves it out while its steps report usage keeps the
    /// session below every threshold for good, so say so once per session.
    fn warn_if_prompt_size_missing(&mut self, entries: &[cortexkit_role_compaction::read::Entry]) {
        if self.warned_no_prompt || self.conditions.last_prompt_tokens.is_some() {
            return;
        }
        let reported = entries
            .iter()
            .rev()
            .find_map(|entry| entry.usage.as_ref().and_then(|usage| usage.prompt_tokens));
        if let Some(prompt) = reported {
            self.warned_no_prompt = true;
            tracing::warn!(
                "ck-mc: session {}: the runner's conditions carry no last_prompt_tokens, though its steps report usage ({prompt} prompt tokens); no threshold can be reached",
                self.key.session
            );
        }
    }

    /// Reserve the id before delivery: a crash after sending must not let a
    /// restarted process reuse an id the runner already accepted.
    /// The namespace keeps new ids distinct from persisted runner keys that
    /// used notice numbers or view versions instead of a counter.
    fn next_reminder_id(&mut self, kind: &str) -> Option<String> {
        self.reminder_counter = self.reminder_counter.checked_add(1)?;
        if let Some(store) = &self.store {
            if let Err(error) = store.save(&self.key, &self.durable()) {
                tracing::warn!("ck-mc: {error}");
                return None;
            }
        }
        Some(format!("{kind}:counter:{}", self.reminder_counter))
    }

    /// After a pass at the execute threshold, a session with `ctx_keep` whose
    /// lanes freed (or lined up) less than `keep_min_recovery_percentage` of
    /// the usable window is asked, once per stay over the threshold, to call `ctx_keep`.
    /// The request goes as a notice message: the model has to act on it, and
    /// no tool result may come before the context runs out.
    async fn ask_for_keep_if_short<C: RunnerClient>(
        &mut self,
        client: &C,
        settings: &Settings,
        freed: u64,
    ) {
        let usable = pass::usable_window(&self.conditions);
        // A setting of 100 asks on every such pass.
        let every_pass = settings.keep_min_recovery_percentage >= 100.0;
        if !self.features.ctx_keep
            || (self.keep_requested && !every_pass)
            || usable == 0
            || freed as f64 >= usable as f64 * settings.keep_min_recovery_percentage / 100.0
        {
            return;
        }
        let usage = pass::usage(&self.pressure()).unwrap_or(0.0) * 100.0;
        // One request per stay over the threshold, with a durable send id
        // independent of the view version that crossed it.
        let Some(send_id) = self.next_reminder_id(KEEP_KIND) else {
            return;
        };
        let request = self
            .reminder(
                client,
                send_id,
                crate::nudges::keep_request(usage, freed),
                KEEP_KIND,
            )
            .await;
        match client.send(&self.key, request).await {
            Ok(_) => self.keep_requested = true,
            Err(error) => tracing::warn!(
                "ck-mc: session {}: session.send failed: {error:?}",
                self.key.session
            ),
        }
    }

    /// Resolve delivery at send time through the runner-connection describe
    /// cache; Setup and reconnect can withdraw support between sends.
    async fn reminder<C: RunnerClient>(
        &self,
        client: &C,
        send_id: String,
        template: TemplateUse,
        kind: &str,
    ) -> SendRequest {
        let cleared = client.turn_system_cleared(&self.key).await;
        SendRequest::template(
            send_id,
            &DeliveryOrder::new(crate::nudges::delivery(&template.id, cleared))
                .with_dedupe_key(kind)
                .with_template(template),
        )
    }

    /// The runner's soft budget is diagnostic only. Count the compact index's
    /// JSON bytes only at a crossing, never on an unchanged notice.
    fn log_window_budget(&mut self) {
        let flagged = self.conditions.window_over_budget == Some(true);
        if flagged && !self.window_over_budget {
            let bytes = serde_json::to_vec(self.index.entries()).map_or(0, |bytes| bytes.len());
            tracing::info!(
                "ck-mc: session {}: window_over_budget: {} entries, {} known compact JSON bytes; stated budget entries {:?}, bytes {:?} (None means no bound stated)",
                self.key.session, self.index.entries().len(), bytes,
                self.limits.window_entries, self.limits.window_bytes
            );
            if self.limits.window_entries.is_none() && self.limits.window_bytes.is_none() {
                tracing::warn!("ck-mc: session {}: runner fault: window_over_budget without a stated window budget", self.key.session);
            }
        }
        self.window_over_budget = flagged;
    }

    /// A ride: the runner is about to send a request whose bytes before the
    /// conversation change anyway, or that would not fit, or whose cache the
    /// provider forgot. The first two land everything held now; the last
    /// lands only what the pass would land on a notice, as does a soft window
    /// budget signal (see [`pass::RideCauseKind`]).
    pub fn ride(&mut self, settings: &Settings, ride: &RideRequest) -> Option<View> {
        // Whether the ride belongs to the session as ck-mc holds it comes
        // first, before anything in it is taken.
        let Some(standing) = self.standing(&ride.conditions) else {
            self.log_foreign("ride", &ride.conditions);
            return None;
        };
        if !self.index_ready || self.suspended {
            return None;
        }
        let previous = reading_of(&self.conditions);
        let was_stale = self.reading_stale;
        self.take_conditions("ride", standing, &ride.conditions);
        let stated = StatedView::of(standing, ride.applied_view.as_ref());
        self.take_signed_floor();
        // A late ride's own reading was not taken, so it is not named as
        // the last prompt.
        let last_prompt = match standing {
            Standing::Current => format!("{:?}", ride.conditions.last_prompt_tokens),
            Standing::Older { .. } => "late, reading ignored".to_owned(),
        };
        tracing::info!(
            "ck-mc: session {}: ride {:?}, request {:?} tokens, last prompt {last_prompt}, applied view {:?}",
            self.key.session,
            ride.causes,
            ride.request_tokens,
            ride.applied_view.as_ref().map(|view| view.version),
        );
        self.settle_stated(stated, &[]);
        // An over-limit ride still lands on a stale reading: it acts on the
        // runner's own estimate of the request it is about to send.
        let judged = self.judged_view(stated);
        match standing {
            Standing::Current => self.judge_reading(previous, judged.as_ref()),
            Standing::Older { .. } => self.judge_held_reading(was_stale, judged.as_ref()),
        }
        let over_limit = ride
            .has(RideCause::OverLimit)
            .then_some(ride.request_tokens.unwrap_or(0));
        // Only a cause that changes the request's bytes before the
        // conversation folds the head for free. A forgotten cache (expiry, a
        // chain reset, a tier or account switch, an unknown cause) adds
        // nothing to any ride, whatever it comes with: `[over_limit,
        // chain_reset]` is `[over_limit]`. Re-rendering `m[0]` there would
        // invalidate every signed thinking block, and the request fits
        // without it.
        let prefix_changes = ride
            .causes
            .iter()
            .any(|cause| pass::ride_cause_kind(cause) == pass::RideCauseKind::PrefixChanges);
        let permitted = if over_limit.is_some() || prefix_changes {
            // A settings change `m[0]` depends on folds in the same rewrite,
            // as on a notice.
            if prefix_changes || self.head_shape_changed(settings) {
                self.fold_due = true;
            }
            true
        } else {
            // Cache-state and soft-budget signals add no permission: the pass
            // rebuilds only if a notice with these conditions would.
            self.rebuild_permitted(settings)
        };
        if !permitted {
            tracing::info!(
                "ck-mc: session {}: ride {:?} adds no rebuild permission; the current view stays",
                self.key.session,
                ride.causes,
            );
            return None;
        }
        // A `ctx_keep` waiting for the next notice lands in this rewrite. On a
        // ride that answers nothing it stays waiting for that notice.
        let kept = self.pending_keep.take_if(|_| !self.latest_unknown);
        let view = self
            .build(settings, over_limit, prefix_changes, kept.as_ref())
            .0?;
        // The size limit holds for a view in a ride's answer as for a pushed
        // one (compaction contract V5); an oversized one is answered as nothing.
        if self.refuse_oversized(&view) {
            return None;
        }
        self.accept(view.clone());
        // The runner takes a ride's view with the answer, so this is where it
        // is accepted; it logs the same line as a pushed view. An answer that
        // never reaches the runner rolls the view back
        // ([`Session::ride_undelivered`]).
        self.runner_holds(view.version);
        self.log_view_accepted(&view);
        Some(view)
    }

    /// A `ctx_*` tool call.
    pub async fn tool<C: RunnerClient>(
        &mut self,
        client: &C,
        settings: &Settings,
        name: &str,
        input: &Value,
    ) -> Result<String, String> {
        self.tool_unbounded(client, settings, name, input)
            .await
            .map(crate::tool_output::bounded)
            .map_err(crate::tool_output::bounded)
    }

    async fn tool_unbounded<C: RunnerClient>(
        &mut self,
        client: &C,
        settings: &Settings,
        name: &str,
        input: &Value,
    ) -> Result<String, String> {
        if !self.tools_only && !self.index_ready && matches!(name, "ctx_reduce" | "ctx_keep") {
            return Err("transcript catch-up is incomplete; retry after the next notice".into());
        }
        match name {
            // The tools that act on the transcript need a session Magic Context
            // compacts; the catalog never offers them to any other.
            "ctx_reduce" | "ctx_expand" | "ctx_keep" if self.tools_only => Err(format!(
                "{name} works only in a session Magic Context compacts."
            )),
            "ctx_reduce" => self.ctx_reduce(client, input).await,
            "ctx_keep" if self.features.ctx_keep => self.ctx_keep(settings, input),
            "ctx_memory" => {
                let db = self
                    .db
                    .as_ref()
                    .ok_or("ctx_memory needs the context store")?;
                let project = self
                    .project
                    .as_ref()
                    .ok_or("Error: Could not resolve project identity for memory action: the session has no project.")?;
                let who = crate::memory_writes::Writer {
                    harness: &self.key.harness,
                    session: &self.key.session,
                    project: &project.id,
                    authority: self.authority.as_ref(),
                };
                db.with_connection(|conn| crate::memory_tool::run(conn, &who, input))
            }
            "ctx_search" => {
                let db = self
                    .db
                    .as_ref()
                    .ok_or("ctx_search needs the context store")?;
                let empty = std::collections::BTreeMap::new();
                let mut scope = self.search_scope(settings, &empty);
                if let Some(answer) =
                    db.with_connection(|conn| crate::search::by_ids(conn, &scope, input))
                {
                    return answer;
                }
                // Embedded once, before the store is touched, so the request
                // to the endpoint never holds the connection.
                let query = input.get("query").and_then(Value::as_str).unwrap_or("");
                let embedded = match &settings.embedding {
                    Some(provider)
                        if crate::search::needs_embedding(
                            input,
                            settings.memory_enabled,
                            settings.git_commits_enabled,
                        ) =>
                    {
                        provider
                            .embed_search_query(query.trim())
                            .await
                            .map(|vector| (vector, provider.model_id(), provider.chunk_model_id()))
                    }
                    _ => None,
                };
                scope.semantic = embedded.as_ref().map(|(vector, model_id, chunk_model_id)| {
                    crate::search::sources::Semantic {
                        vector,
                        model_id,
                        chunk_model_id,
                    }
                });
                self.search_reranked(client, settings, db, &scope, input)
                    .await
            }
            "ctx_note" => {
                let db = self.db.as_ref().ok_or("ctx_note needs the context store")?;
                let scope = crate::context_db::NoteScope {
                    harness: self.key.harness.clone(),
                    session: self.key.session.clone(),
                    project: self.project.as_ref().map(|project| project.id.clone()),
                };
                let anchor = self.index.entries().last().map(|entry| entry.ordinal);
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |elapsed| elapsed.as_millis() as i64);
                crate::notes::run(db, &scope, input, anchor, now)
            }
            "ctx_expand" => {
                let last_summarized = self
                    .summaries
                    .last()
                    .and_then(|summary| u64::try_from(summary.end_message).ok());
                crate::expand::run(
                    client,
                    &self.key,
                    self.limits,
                    input,
                    last_summarized,
                    self.counter(),
                )
                .await
            }
            other => Err(format!("unknown tool {other}")),
        }
    }

    /// An explicit `ctx_search`, reranked when its query reads as prose and a
    /// reranker is configured (see [`crate::search::rerank`]). The store is
    /// not held while the reranker scores, and any failure keeps the ordinary
    /// ranking.
    async fn search_reranked<C: RunnerClient>(
        &self,
        client: &C,
        settings: &Settings,
        db: &ContextDb,
        scope: &crate::search::Scope<'_>,
        input: &Value,
    ) -> Result<String, String> {
        use crate::search::rerank::{self, Reranker, Skipped};
        let query = input
            .get("query")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let prose = settings.rerank != Reranker::Off && rerank::is_prose_query(query);
        // Synapse's model is pinned before any lane is read, so a missing
        // Synapse costs no extra retrieval.
        let mut pinned = None;
        if prose && settings.rerank == Reranker::Synapse {
            match rerank::pin_synapse(client.synapse_call(
                &self.key,
                "models.list",
                serde_json::json!({}),
            ))
            .await
            {
                Ok(pin) => pinned = Some(pin),
                Err(Skipped(reason)) => rerank::log_fallback(&reason),
            }
        }
        let pool = match (&settings.rerank, &pinned) {
            (Reranker::Synapse, Some(_)) => Some(rerank::POOL),
            (Reranker::Remote(remote), _) if prose => Some(remote.top_n),
            _ => None,
        };
        let mut prepared =
            db.with_connection(|conn| crate::search::prepare(conn, scope, input, pool))?;
        let mut skipped_note = None;
        if !prepared.candidates().is_empty() {
            let texts = prepared.candidates().to_vec();
            let scored = match (&settings.rerank, &pinned) {
                (Reranker::Synapse, Some(pin)) => client
                    .synapse_call(
                        &self.key,
                        "rerank.score",
                        rerank::score_request(pin, prepared.query(), &texts),
                    )
                    .await
                    .map_err(Skipped)
                    .and_then(|reply| rerank::scores(reply, pin, texts.len())),
                (Reranker::Remote(remote), _) => {
                    rerank::remote_scores(remote, prepared.query(), &texts).await
                }
                _ => Err(Skipped("validation".into())),
            };
            match scored {
                Ok(scores) => prepared.reorder(&scores),
                Err(Skipped(reason)) => {
                    rerank::log_fallback(&reason);
                    // Only a hosted reranker's skip is shown to the model, as
                    // the plugin does.
                    if matches!(settings.rerank, Reranker::Remote(_)) {
                        skipped_note = Some(rerank::skipped_line(&reason));
                    }
                }
            }
        }
        let mut answer = db.with_connection(|conn| crate::search::finish(conn, scope, prepared));
        if let Some(line) = skipped_note {
            answer.push('\n');
            answer.push_str(&line);
        }
        Ok(answer)
    }

    /// What a search may read for this session: messages up to the last
    /// summary (later ones are in the model's view), and memories other than
    /// those the history head shows in full. The head is the two messages a
    /// view inserts at the start of the request: the baseline of summaries,
    /// docs and memories, and what changed since that baseline.
    fn search_scope<'a>(
        &'a self,
        settings: &Settings,
        empty: &'a std::collections::BTreeMap<i64, String>,
    ) -> crate::search::Scope<'a> {
        let root = self
            .project
            .as_ref()
            .map(|project| std::path::Path::new(&project.root));
        crate::search::Scope {
            harness: &self.key.harness,
            session: &self.key.session,
            project: self.project.as_ref().map(|project| project.id.as_str()),
            cutoff: self
                .summaries
                .last()
                .map_or(i64::MAX, |summary| summary.end_message),
            visible_messages: (self.summaries.is_empty() && !self.tools_only).then(|| {
                let edited = lanes::Edited::of(self.latest.as_ref(), &self.index, self.cut);
                self.index
                    .entries()
                    .iter()
                    .filter(|entry| {
                        entry
                            .parts
                            .iter()
                            .any(|part| !edited.covers(&entry.mid, &part.id))
                    })
                    .map(|entry| entry.ordinal as i64)
                    .collect()
            }),
            seen: self
                .baseline
                .as_ref()
                .map_or(empty, |baseline| &baseline.seen),
            memory_enabled: settings.memory_enabled,
            git_commits_enabled: settings.git_commits_enabled,
            git_repository: root.map(|root| root.join(".git").exists()),
            semantic: None,
        }
    }

    /// The `pre_user` hook: what goes before and after a person's message as
    /// the runner stores it. A message that is only reminders or notices is
    /// not a person's, and gets nothing.
    pub async fn pre_user(
        &self,
        settings: &Settings,
        text: &str,
        now_ms: u64,
    ) -> crate::pre_user::Addition {
        let mut answer = crate::pre_user::Addition::default();
        if !crate::search::text::is_meaningful_user_text(text) {
            return answer;
        }
        if self.features.time_marker && settings.temporal_awareness {
            // The gap runs from the newest message the session holds, the one
            // this message follows, to now, when the message is written. A
            // message the host finished counts from when it finished.
            if let Some(previous) = self.index.entries().last() {
                let since = previous.completed_at.unwrap_or(previous.written_at);
                answer.prepend = crate::pre_user::time_marker(now_ms.saturating_sub(since));
            }
        }
        let auto = &settings.auto_search;
        let prompt = crate::pre_user::prompt_text(text);
        if !self.features.auto_memory
            || !auto.enabled
            || crate::pre_user::has_hint(text)
            || crate::search::text::utf16_len(&prompt) < auto.min_prompt_chars
        {
            return answer;
        }
        let Some(db) = &self.db else {
            return answer;
        };
        let started = std::time::Instant::now();
        let deadline = std::time::Duration::from_millis(crate::pre_user::AUTO_SEARCH_TIMEOUT_MS);
        let search = async {
            let embedded = match &settings.embedding {
                Some(provider) => tokio::time::timeout(
                    std::time::Duration::from_millis(200),
                    provider.embed_query(&prompt),
                )
                .await
                .ok()
                .flatten()
                .map(|vector| (vector, provider.model_id(), provider.chunk_model_id())),
                None => None,
            };
            let empty = std::collections::BTreeMap::new();
            let scope = self.search_scope(settings, &empty);
            let cutoff = scope.cutoff;
            let visible_messages = scope.visible_messages;
            let seen = scope.seen.clone();
            let key = self.key.clone();
            let project = self.project.clone();
            let (memory_enabled, git_commits_enabled, git_repository) = (
                scope.memory_enabled,
                scope.git_commits_enabled,
                scope.git_repository,
            );
            let (db, prompt) = (db.clone(), prompt.clone());
            // SQLite and its connection mutex are synchronous. Keep both off
            // the session worker so the deadline can expire during the read.
            tokio::task::spawn_blocking(move || {
                let scope = crate::search::Scope {
                    harness: &key.harness,
                    session: &key.session,
                    project: project.as_ref().map(|project| project.id.as_str()),
                    cutoff,
                    visible_messages,
                    seen: &seen,
                    memory_enabled,
                    git_commits_enabled,
                    git_repository,
                    semantic: embedded.as_ref().map(|(vector, model_id, chunk_model_id)| {
                        crate::search::sources::Semantic {
                            vector,
                            model_id,
                            chunk_model_id,
                        }
                    }),
                };
                db.with_connection(|conn| crate::search::auto_hits(conn, &scope, &prompt))
            })
            .await
            .unwrap_or_default()
        };
        let Ok(hits) = tokio::time::timeout(deadline, search).await else {
            tracing::info!(
                "ck-mc: session {}: memory search took too long; the message has no hint",
                self.key.session
            );
            return answer;
        };
        if started.elapsed() >= deadline {
            return answer;
        }
        answer.append =
            crate::search::build_hint(hits, auto.score_threshold, &prompt, now_ms as i64)
                .map(|hint| format!("\n\n{hint}"));
        answer
    }

    /// `ctx_keep`: the model names what it still needs, in order of
    /// importance. Tags are kept in that order up to `keep_max_percentage`
    /// of the usable window; the rest are named in the answer rather than
    /// refused, since a refusal would only cost another turn.
    fn ctx_keep(&mut self, settings: &Settings, input: &Value) -> Result<String, String> {
        let spec = input.get("tags").and_then(Value::as_str).ok_or(
            "ctx_keep needs `tags`, the tags to keep, most important first, such as \"12,3-5\"",
        )?;
        if input
            .get("note")
            .and_then(Value::as_str)
            .is_none_or(|note| note.trim().is_empty())
        {
            return Err(
                "ctx_keep needs `note`: a few lines on where you are and what comes next".into(),
            );
        }
        let tags = reduce::parse_tags_in_order(spec)?;
        let cap = (pass::usable_window(&self.conditions) as f64 * settings.keep_max_percentage
            / 100.0) as u64;
        let mut kept = BTreeSet::new();
        let (mut kept_tags, mut over, mut missing) = (Vec::new(), Vec::new(), Vec::new());
        let mut used = 0;
        for tag in tags {
            let Some((entry, part)) = self.index.find_tag(tag) else {
                missing.push(tag);
                continue;
            };
            let cost = tokens::part(part);
            if used + cost > cap {
                over.push(tag);
                continue;
            }
            used += cost;
            kept.insert((entry.mid.clone(), part.id.clone()));
            kept_tags.push(tag);
        }
        let mut answer = if kept_tags.is_empty() {
            "Keeping only your task and the newest items.".to_owned()
        } else {
            format!(
                "Keeping {} (about {used} tokens), with your task and the newest items.",
                list(&kept_tags)
            )
        };
        answer.push_str(" Messages from the person also stay. Everything else before this call is removed before your next step.");
        if !over.is_empty() {
            answer.push_str(&format!(
                " Not kept, over the limit of {cap} tokens: {}.",
                list(&over)
            ));
        }
        if !missing.is_empty() {
            answer.push_str(&format!(" Not found: {}.", list(&missing)));
        }
        self.pending_keep = Some(kept);
        Ok(answer)
    }

    async fn ctx_reduce<C: RunnerClient>(
        &mut self,
        client: &C,
        input: &Value,
    ) -> Result<String, String> {
        let Some(spec) = input
            .get("drop")
            .and_then(Value::as_str)
            .filter(|spec| !spec.is_empty())
        else {
            return Ok("Error: 'drop' must be provided as a string of tag numbers, for example {\"drop\": \"3-5,8\"}.".into());
        };
        let tags = match reduce::parse_tags(spec) {
            Ok(tags) => tags,
            Err(error) => return Ok(format!("Error: Invalid range syntax. {error}")),
        };
        // The bounded live index no longer holds compacted tags. Ask the raw
        // transcript for missing handles before classifying them as unknown.
        let missing: Vec<_> = tags
            .iter()
            .copied()
            .filter(|tag| self.index.find_tag(*tag).is_none())
            .collect();
        let archived = if missing.is_empty() {
            Vec::new()
        } else {
            crate::reads::by_tags(client, &self.key, missing, self.limits).await?
        };
        let find = |tag: u64| {
            self.index.find_tag(tag).or_else(|| {
                archived.iter().find_map(|entry| {
                    entry
                        .parts
                        .iter()
                        .find(|part| part.tag == Some(tag))
                        .map(|part| (entry, part))
                })
            })
        };
        let unknown: Vec<_> = tags
            .iter()
            .copied()
            .filter(|tag| find(*tag).is_none())
            .collect();
        if !unknown.is_empty() {
            return Ok(format!(
                "Error: Unknown tag(s) {}. Check available tags in conversation.",
                list(&unknown)
            ));
        }
        let mut self_stamps = 0;
        let mut skipped = Vec::new();
        let mut conflicts = Vec::new();
        let mut selected = Vec::new();
        for tag in tags {
            let (entry, part) = find(tag).expect("all tags resolved");
            if matches!(&part.body, PartBody::Tool(tool) if tool.name.eq_ignore_ascii_case("ctx_reduce"))
            {
                self_stamps += 1;
            } else if entry.role == cortexkit_role_compaction::read::Role::Assistant
                && matches!(&part.body, PartBody::Text { text } if text.trim().is_empty())
            {
                skipped.push(format!("§{tag}§ is provider framing, nothing to reclaim"));
            } else if self.cut.is_some_and(|cut| entry.ordinal <= cut) {
                conflicts.push(format!("§{tag}§ is from before compaction"));
            } else {
                selected.push((entry.mid.clone(), part.id.clone()));
            }
        }
        if !conflicts.is_empty() {
            return Ok(format!(
                "Error: Conflicting operations — {}.",
                conflicts.join("; ")
            ));
        }
        let first_mid = self.index.entries().first().map(|entry| entry.mid.clone());
        let edited = lanes::Edited::of(self.latest.as_ref(), &self.index, self.cut);
        let stamped = selected.len();
        let mut added = false;
        for (mid, part) in selected {
            if (self.features.keep_first_message && Some(&mid) == first_mid.as_ref())
                || edited.covers(&mid, &part)
            {
                continue;
            }
            let key = (mid, part);
            if self.queued.insert(key.clone()) {
                self.app_projection.dirty.insert(key.0.clone());
                self.app.stamps.insert(key, crate::app_read::now_ms());
                added = true;
            }
        }
        if added {
            self.nudges.reduced();
        }
        let mut answer = reduce::reply(stamped, self_stamps);
        if !skipped.is_empty() {
            if !answer.is_empty() {
                answer.push(' ');
            }
            answer.push_str(&format!("Skipped: {}.", skipped.join("; ")));
        }
        if answer.is_empty() {
            answer =
                "All requested tags were already queued or processed. No new action is needed."
                    .into();
        }
        Ok(answer)
    }

    fn summary_on_its_way(&self) -> bool {
        // A floor mark promises a summary on the next notice, which an
        // account wait would not start: the drops it holds land now instead.
        self.features.summarizer
            && (self.summarizing
                || (self.floor_pending_for.is_some() && !self.summaries_wait_for_account()))
    }

    /// The history head, and the cut when the newest summary's last message
    /// is still in the transcript. Only presets with a summarizer have a
    /// head. A due fold renders `m[0]` again from everything current.
    fn history_ops(&mut self, settings: &Settings, flush: bool) -> (Vec<EditOp>, Option<u64>) {
        let _timing = crate::notice_cost_timing::span("build.history_ops");
        if !self.features.summarizer {
            return (Vec::new(), None);
        }
        let mut ops = self.render_head_for(settings, flush);
        // A head kept as the latest view shows it (a read it needs failed,
        // see `head_as_shown`, which leaves no next baseline) carries no
        // newer summary. The cut then stays where that view has it: moving
        // it would hide messages whose summary the head does not show.
        let held = self.next_baseline.is_none();
        let through = if held {
            self.latest.as_ref().and_then(|view| {
                view.edits.iter().find_map(|edit| match &edit.op {
                    EditOp::Cut { through } => Some(through.clone()),
                    _ => None,
                })
            })
        } else {
            self.summaries
                .last()
                .map(|last| last.end_message_id.clone())
        };
        let cut = through.and_then(|through| {
            let entries = self.index.entries();
            let end = entries.iter().position(|entry| entry.mid == through)?;
            // A tool still running can't be cut (compaction contract W6.5),
            // yet the summarizer reads past a call left running long ago, as
            // the plugin does. The cut then stops before it, so views keep
            // landing; the summary may repeat what those messages still show
            // until the runner finishes or fails the call.
            let running = entries[..=end].iter().position(|entry| {
                entry.parts.iter().any(|part| match &part.body {
                    PartBody::Tool(tool) => !crate::neutral::is_finished(&tool.status),
                    _ => false,
                })
            });
            let Some(running) = running else {
                // The message the request ends on is never cut, so the
                // request always ends with a message the runner shows as it
                // is (compaction contract rule PR6; runners refuse such a
                // view). That is the newest message that has parts: one with
                // none, such as a tool-results message whose results ride
                // inside the calls, renders nothing. Summaries normally end
                // before it anyway; a session moved in fully summarized is
                // the exception, until a newer message arrives.
                let last = entries
                    .iter()
                    .rposition(|entry| !entry.parts.is_empty())
                    .unwrap_or(entries.len() - 1);
                if end >= last {
                    let before = last.checked_sub(1)?;
                    return Some((entries[before].ordinal, entries[before].mid.clone()));
                }
                return Some((entries[end].ordinal, through));
            };
            tracing::info!(
                "ck-mc: session {}: the cut stops before message {}, whose tool call is still running",
                self.key.session, entries[running].ordinal
            );
            // With nothing held before the running call, no new cut: the
            // view carries the cut the runner has now.
            let before = running.checked_sub(1)?;
            Some((entries[before].ordinal, entries[before].mid.clone()))
        });
        if let Some((_, through)) = &cut {
            ops.push(EditOp::Cut {
                through: through.clone(),
            });
        }
        (ops, cut.map(|(ordinal, _)| ordinal))
    }

    /// The history head's edits: `m[0]` (kept unless a fold is due) and
    /// `m[1]` with what changed since. The baseline they set counts once the
    /// runner takes the view.
    ///
    /// When memories cannot be read, the head stays as the latest view shows
    /// it: an empty read would otherwise state every shown memory as removed,
    /// and the next good read as updated again.
    fn render_head(&mut self, settings: &Settings) -> Vec<EditOp> {
        self.render_head_for(settings, false)
    }

    fn render_head_for(&mut self, settings: &Settings, flush: bool) -> Vec<EditOp> {
        let _timing = crate::notice_cost_timing::span("head.render");
        // A manual flush refreshes only the delta. A missing baseline waits
        // for the normal first render, which is the path allowed to create it.
        if flush && self.baseline.is_none() {
            return self.head_as_shown("a flush cannot create a baseline");
        }
        let docs = self
            .project
            .as_ref()
            .map(|project| {
                crate::project_docs::read_project_docs_canonical(&project.root).rendered_block
            })
            .unwrap_or_default();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_millis() as i64);
        let shape = self.head_shape(settings);
        // With memory off, the history head shows no memories and no user
        // profile, as the standalone plugin's does. The user profile is the
        // person's, read whatever the session's project.
        let mut memories = Vec::new();
        let mut workspace = None;
        let (mut profile, mut profile_max_id) = (Vec::new(), 0);
        if let (Some(db), true) = (&self.db, shape.memory_enabled) {
            if let Some(project) = &self.project {
                match db.with_connection(|conn| {
                    let resolved = crate::workspace::Workspace::resolve(conn, &project.id)?;
                    let read = resolved.memories(conn, now, true)?;
                    Ok::<_, rusqlite::Error>((resolved, read))
                }) {
                    Ok((resolved, read)) => {
                        workspace = Some(resolved);
                        memories = read;
                    }
                    Err(error) => return self.head_as_shown(&format!("reading memories: {error}")),
                }
            }
            match db.user_profile() {
                Ok(read) => (profile, profile_max_id) = read,
                Err(error) => return self.head_as_shown(&format!("reading the profile: {error}")),
            }
        }
        let model_key = format!(
            "{}/{}",
            self.conditions.model.provider, self.conditions.model.model
        );
        // Put back below; a head that stays as shown leaves it unset, so the
        // next build computes it again.
        let mut head_summaries = self.head_summaries.take();
        let history_budget_tokens = shape.history_budget_tokens;
        let fold_inputs = head::Inputs {
            counter: crate::count::Counter::for_model(Some(&model_key)),
            summaries: &self.summaries,
            docs: &docs,
            profile: &profile,
            profile_max_id,
            memories: &memories,
            workspace: workspace.as_ref(),
            gone: &[],
            history_budget_tokens,
            history_local_budget_tokens: crate::summary::render::history_local_budget(
                history_budget_tokens as f64,
                Some(&model_key),
            ) as u64,
            memory_budget_tokens: settings.memory_budget_tokens,
            profile_budget_tokens: settings.profile_budget_tokens,
        };
        let active: std::collections::HashSet<i64> =
            memories.iter().map(|memory| memory.id).collect();
        // Shown memories that left the active set get their rows, which say
        // whether they were archived or merged.
        let gone_from = |base: &Baseline| -> Result<Vec<StoredMemory>, String> {
            let missing: Vec<i64> = base
                .shown_ids()
                .into_iter()
                .filter(|id| !active.contains(id))
                .collect();
            match &self.db {
                Some(db) => db.memories_by_ids(&missing),
                None => Ok(Vec::new()),
            }
        };
        // A fold draws the mural afresh; between folds `m[0]` keeps the one
        // it was folded with, as in the plugin.
        let mut drawn: Option<Option<crate::mural::Mural>> = None;
        let mut folded = |inputs: &head::Inputs| {
            let mural =
                drawn.get_or_insert_with(|| self.draw_mural(settings, shape.memory_enabled, now));
            let mut base = head::fold(
                inputs,
                mural.as_ref().map(|mural| mural.content_hash.as_str()),
            );
            base.shape = Some(shape.clone());
            base
        };
        let mut fresh_fold = true;
        let mut base = match (&self.baseline, self.fold_due && !flush) {
            (Some(baseline), false) => {
                fresh_fold = false;
                baseline.as_ref().clone()
            }
            _ => folded(&fold_inputs),
        };
        let gone = match gone_from(&base) {
            Ok(gone) => gone,
            Err(error) => return self.head_as_shown(&format!("reading memory rows: {error}")),
        };
        let newer = HeadSummaries::for_base(
            &mut head_summaries,
            &base,
            &self.summaries,
            &model_key,
            fold_inputs.counter,
        );
        let (mut m1, mut next, pressure) = head::delta_with(
            &base,
            &head::Inputs {
                gone: &gone,
                ..fold_inputs
            },
            &newer,
        );
        if !flush
            && self.baseline.is_some()
            && !self.fold_due
            && head::needs_refold(&base, pressure, history_budget_tokens, fold_inputs.counter)
        {
            base = folded(&fold_inputs);
            fresh_fold = true;
            let newer = HeadSummaries::for_base(
                &mut head_summaries,
                &base,
                &self.summaries,
                &model_key,
                fold_inputs.counter,
            );
            // A fresh fold shows every current memory, so none is gone.
            (m1, next, _) = head::delta_with(&base, &fold_inputs, &newer);
        }
        self.head_summaries = head_summaries;
        if let Some(Some(mural)) = drawn {
            self.keep_mural(mural);
        }
        let image = next.mural.as_deref().and_then(|hash| self.mural_png(hash));
        let mut ops = head::head_ops(&next.m0, &m1, image);
        // Between folds `m[0]` is exactly what the runner last applied. That
        // is normally what the baseline renders, but not after ck-mc adopted
        // a newer view from the runner (its own saved state was older, as
        // after a restore): re-rendering the older baseline would rewrite
        // the cached prefix from its start. The older baseline still drives
        // `m[1]`, which may then repeat what `m[0]` shows until the next fold.
        if !fresh_fold {
            if let Some(shown) = self.latest.as_ref().and_then(|view| {
                view.edits.iter().find_map(|edit| match &edit.op {
                    EditOp::Insert { message, .. } if message.id == head::M0_ID => {
                        Some(edit.op.clone())
                    }
                    _ => None,
                })
            }) {
                if let Some(m0) = ops.iter_mut().find(
                    |op| matches!(op, EditOp::Insert { message, .. } if message.id == head::M0_ID),
                ) {
                    *m0 = shown;
                }
            }
        }
        self.next_baseline = Some(match &self.baseline {
            Some(held) if held.as_ref() == &next => held.clone(),
            _ => Arc::new(next),
        });
        ops
    }

    /// The memory mural for a fold, or `None` when it is off, the model
    /// doesn't read images, or there is nothing worth drawing. It shows the
    /// project's own memories that the head's memory budget leaves out, as
    /// the plugin's `resolveMuralForM0` does. A failure to draw is logged and
    /// leaves the mural out of this fold.
    fn draw_mural(
        &self,
        settings: &Settings,
        memory_enabled: bool,
        now: i64,
    ) -> Option<crate::mural::Mural> {
        if !settings.mural_enabled
            || !memory_enabled
            || self.conditions.accepts_images != Some(true)
        {
            return None;
        }
        let (db, project) = (self.db.as_ref()?, self.project.as_ref()?);
        let drawn = db
            .project_memories(&project.id, now)
            .map_err(|error| error.to_string())
            .and_then(|memories| {
                db.with_connection(|conn| {
                    crate::mural::ensure(
                        conn,
                        &project.id,
                        &memories,
                        settings.memory_budget_tokens,
                        now,
                        self.counter(),
                    )
                })
                .map_err(|error| error.to_string())
            });
        drawn.unwrap_or_else(|error| {
            tracing::warn!(
                "ck-mc: session {}: the memory mural was left out of this fold: {error}",
                self.key.session
            );
            None
        })
    }

    /// Keep a newly drawn mural: in memory for the views that repeat `m[0]`,
    /// and in the store for after a restart.
    fn keep_mural(&mut self, mural: crate::mural::Mural) {
        use base64::Engine as _;
        if let Some(store) = &self.store {
            if let Err(error) = store.save_head_mural(&self.key, &mural.content_hash, &mural.png) {
                tracing::warn!("ck-mc: {error}");
            }
        }
        let data = base64::engine::general_purpose::STANDARD.encode(&mural.png);
        self.mural_image = Some((mural.content_hash, data));
    }

    /// The image for the mural with checksum `hash`, as a view carries it.
    /// After a restart it comes from the store, so `m[0]` keeps its bytes.
    fn mural_png(&mut self, hash: &str) -> Option<InsertedImage> {
        use base64::Engine as _;
        if self
            .mural_image
            .as_ref()
            .is_none_or(|(kept, _)| kept != hash)
        {
            let png = self
                .store
                .as_ref()
                .and_then(|store| store.head_mural(&self.key, hash));
            let Some(png) = png else {
                tracing::info!(
                    "ck-mc: session {}: the mural image m[0] shows is gone; m[0] goes without it",
                    self.key.session
                );
                return None;
            };
            let data = base64::engine::general_purpose::STANDARD.encode(&png);
            self.mural_image = Some((hash.to_owned(), data));
        }
        let (_, data) = self.mural_image.as_ref()?;
        Some(InsertedImage::new("image/png", data.clone()))
    }

    /// The history head as the latest view shows it, after a read the head
    /// needs failed: nothing about it changes on this pass.
    /// The held entries with the full output of each tool part whose output
    /// `ops` replace, when ck-mc read it (the answered-images lane does).
    /// The index holds tool output in compact form, so the view checks could
    /// otherwise allow only the part's own number in the replacement and
    /// refuse any other tag its original text quotes (`foreign_tag`), as the
    /// runner, which checks against the full text, would not. `None` when no
    /// op replaces such an output.
    fn with_replaced_outputs(
        &self,
        ops: &[EditOp],
    ) -> Option<Vec<cortexkit_role_compaction::read::Entry>> {
        let wanted: BTreeSet<lanes::PartKey> = ops
            .iter()
            .filter_map(|op| match op {
                EditOp::Replace {
                    mid, part, field, ..
                } if field == "output" => Some((mid.clone(), part.clone())),
                _ => None,
            })
            .filter(|key| self.image_outputs.contains_key(key))
            .collect();
        if wanted.is_empty() {
            return None;
        }
        let mut entries = self.index.entries().to_vec();
        for entry in &mut entries {
            for part in &mut entry.parts {
                let key = (entry.mid.clone(), part.id.clone());
                if let (true, PartBody::Tool(tool)) = (wanted.contains(&key), &mut part.body) {
                    tool.output = self.image_outputs.get(&key).cloned();
                }
            }
        }
        Some(entries)
    }

    /// After an undo, removed numbers go to new parts (compaction contract
    /// T4), so the age-sweep bookmark can't stay above the highest number
    /// still held: a new output under it would count as far behind at once.
    fn clamp_bookmark_to_held(&mut self) {
        self.clamp_bookmark_to(self.index.entries().len());
    }

    /// Clamp the bookmark to the highest number among the first `count`
    /// held entries.
    fn clamp_bookmark_to(&mut self, count: usize) {
        let held = self.index.entries()[..count]
            .iter()
            .flat_map(|entry| entry.parts.iter())
            .filter_map(|part| part.tag)
            .max()
            .unwrap_or(0);
        self.reclaim_bookmark = self.reclaim_bookmark.min(held);
        self.notice_reclaim_bookmark = self.notice_reclaim_bookmark.min(held);
    }

    /// Whether the history head and cut in `history` differ from the latest
    /// view's only in `m[1]`.
    fn only_m1_changes(&self, history: &[EditOp]) -> bool {
        let Some(latest) = &self.latest else {
            return false;
        };
        let shown = |wanted: &EditOp| latest.edits.iter().any(|edit| edit.op == *wanted);
        let mut m1_changed = false;
        for op in history {
            match op {
                EditOp::Insert { message, .. } if message.id == head::M1_ID => {
                    m1_changed |= !shown(op);
                }
                _ if !shown(op) => return false,
                _ => {}
            }
        }
        m1_changed
    }

    fn head_as_shown(&mut self, why: &str) -> Vec<EditOp> {
        tracing::info!(
            "ck-mc: session {}: history head kept as shown, {why}",
            self.key.session
        );
        self.next_baseline = None;
        self.latest
            .as_ref()
            .map(|view| {
                view.edits
                    .iter()
                    .filter(|edit| head::is_head(&edit.op))
                    .map(|edit| edit.op.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The settings the history head's baseline (`m[0]`) is rendered under,
    /// as they are now.
    fn head_shape(&self, settings: &Settings) -> head::Shape {
        head::Shape {
            memory_enabled: settings.memory_enabled,
            memory_budget_tokens: settings.memory_budget_tokens,
            history_budget_tokens: (crate::pass::usable_window(&self.conditions) as f64
                * settings.execute_threshold_percentage
                / 100.0
                * settings.history_budget_percentage) as u64,
            history_budget_percentage_bp: Some(
                (settings.history_budget_percentage * 10_000.0).round() as u64,
            ),
        }
    }

    /// Whether the baseline was rendered under different settings than these. A
    /// baseline from before the shape was recorded counts as unchanged.
    fn head_shape_changed(&self, settings: &Settings) -> bool {
        self.baseline
            .as_ref()
            .and_then(|baseline| baseline.shape.as_ref())
            .is_some_and(|shape| shape.requires_fold(&self.head_shape(settings)))
    }

    /// The first view of a moved session: the history head and a cut through
    /// at most `cut` (ordinal, message id). The caller keeps the newest entry
    /// visible; summary coverage can shorten that cut further, so unsummarized
    /// entries never disappear. The session records the view as current; the
    /// runner's move tool installs it before Setup.
    pub fn first_view_after_move(
        &mut self,
        settings: &Settings,
        cut: Option<(u64, &str)>,
    ) -> Result<View, String> {
        let covered = self.last_summary_ordinal().zip(self.last_summary_end());
        let cut = cut.and_then(|cut| {
            covered.as_ref().map(|(ordinal, mid)| {
                if cut.0 > *ordinal {
                    (*ordinal, mid.as_str())
                } else {
                    cut
                }
            })
        });
        self.fold_due = true;
        let mut ops = self.render_head(settings);
        if self.next_baseline.is_none() || !ops.iter().any(head::is_head) {
            return Err(
                "history_head_unavailable: cannot render the moved session's history head".into(),
            );
        }
        if let Some((_, mid)) = cut {
            ops.push(EditOp::Cut {
                through: mid.to_string(),
            });
        }
        let version = self.version + 1;
        let view = View::seal(
            version,
            ops.into_iter()
                .map(|op| cortexkit_role_compaction::view::Edit::new(version, op))
                .collect(),
        );
        self.app_capture_head(&view);
        if let Some(next) = self.next_baseline.take() {
            self.baseline = Some(next);
            self.fold_due = false;
        }
        self.version = version;
        self.cut = cut.map(|(ordinal, _)| ordinal);
        self.set_move_floor(cut);
        self.index = Index::starting_at(self.cut.unwrap_or(1));
        self.latest = Some(view.clone());
        Ok(view)
    }

    /// A spent emergency batch waits for another rewrite, but an over-limit
    /// request must reclaim even when the pressure episode is already spent.
    fn emergency_drop_allowed(&self, settings: &Settings, over_limit: bool, priced: bool) -> bool {
        over_limit
            || (pass::in_force_band(&self.pressure(), settings)
                && (priced || !self.emergency_latched))
    }

    /// A pass with permission to rebuild: every lane adds the parts it wants
    /// gone, and one view carries them. `None` when no lane has work.
    ///
    /// A view that fails ck-mc's own checks is a bug in a lane. It is logged
    /// and the work it held is dropped, so the same failure does not repeat
    /// on every pass.
    ///
    /// `over_limit` is set when the runner asked for a view because its next
    /// request would not fit, and carries its estimate of that request. The
    /// emergency drop then runs whatever the usage, and the protections that
    /// can yield do. `prefix_changes` is set on a ride whose request's bytes
    /// before the conversation change anyway, so the cache is lost whether or
    /// not a view follows.
    ///
    /// Also returns roughly how many tokens the new edits free, plus what the
    /// age sweep has lined up for the next pass.
    fn build(
        &mut self,
        settings: &Settings,
        over_limit: Option<u64>,
        prefix_changes: bool,
        keep: Option<&BTreeSet<lanes::PartKey>>,
    ) -> (Option<View>, u64) {
        self.build_for(settings, over_limit, prefix_changes, keep, false)
    }

    fn build_for(
        &mut self,
        settings: &Settings,
        over_limit: Option<u64>,
        prefix_changes: bool,
        keep: Option<&BTreeSet<lanes::PartKey>>,
        flush: bool,
    ) -> (Option<View>, u64) {
        self.next_flush = flush;
        let _timing = crate::notice_cost_timing::span("build.total");
        if !self.index_ready {
            return (None, 0);
        }
        if self.latest_unknown {
            tracing::info!(
                "ck-mc: session {}: no view until the runner's applied view is read back",
                self.key.session
            );
            return (None, 0);
        }
        // A moved session whose summaries stop short of its move floor can
        // build no view the runner may take: each would cut where the
        // summaries end, before the floor. A `ctx_keep` this pass carried
        // waits for a view that can land it.
        if self.short_of_move_floor() {
            if let Some(kept) = keep {
                self.pending_keep = Some(kept.clone());
            }
            self.hold_below_move_floor("a cut where the summaries end");
            return (None, 0);
        }
        self.next_keep = keep.cloned();
        self.app_cause = if over_limit.is_some() {
            "over_limit"
        } else if prefix_changes {
            "cache_lost"
        } else if self.head_stale {
            "history_changed"
        } else if self.summary_on_its_way()
            || self.summaries.last().is_some_and(|s| {
                self.baseline
                    .as_ref()
                    .is_none_or(|b| s.sequence > b.through_sequence)
            })
        {
            "history_refresh"
        } else {
            "execute"
        }
        .into();
        let (history, cut) = self.history_ops(settings, flush);
        let lanes_timing = crate::notice_cost_timing::span("build.lanes");
        let edited = lanes::Edited::of(self.latest.as_ref(), &self.index, cut);
        let (context, usable, cutoff) = Self::lane_context(
            &self.index,
            &edited,
            settings,
            &self.conditions,
            self.features.keep_first_message,
            self.signed_floor(),
        );
        // A part two lanes want keeps the first lane's shape, so the order
        // here decides it: the model's own request first, then the lanes
        // that keep a call, then the rest. A requested part in the protected
        // tail waits until it leaves the tail, as in the plugin
        // (`pendingDropVeto`).
        let mut wanted: Vec<(lanes::PartKey, lanes::Shape)> = self
            .queued
            .iter()
            .filter(|key| !lanes::in_protected_tail(&context, key, cutoff))
            .map(|key| (key.clone(), lanes::Shape::Requested))
            .collect();
        if let Some(kept) = keep {
            wanted.extend(lanes::keep_drops(&context, kept, cutoff));
        }
        let injected = lanes::injected_text(&context, cutoff);
        // Parts whose only edit is a stripped injection: caveman may compress
        // them on this pass, starting from the stripped text.
        let stripped_only: Vec<lanes::PartKey> = injected
            .iter()
            .map(|(key, _)| key.clone())
            .filter(|key| !wanted.iter().any(|(earlier, _)| earlier == key))
            .collect();
        wanted.extend(injected);
        wanted.extend(lanes::superseded_edits(
            &context,
            cutoff,
            self.reclaim_bookmark,
        ));
        wanted.extend(lanes::spent_control_plane(&context, cutoff));
        wanted.extend(lanes::duplicate_lookups(&context, cutoff));
        // An unmarked notice may carry the person's words. Without notice_keep,
        // sweeping notices could drop them, so neither select nor bookmark them.
        let notice_reclaim_bookmark = if self.notice_keep {
            self.notice_reclaim_bookmark
        } else {
            0
        };
        wanted.extend(lanes::age_sweep(
            &context,
            self.reclaim_bookmark,
            notice_reclaim_bookmark,
            cutoff,
        ));
        let model = &self.conditions.model;
        let anthropic = model.provider.contains("anthropic") || model.model.contains("claude");
        wanted.extend(lanes::reasoning_over_budget(
            &context,
            settings.keep_reasoning_tokens,
            anthropic,
        ));
        wanted.retain(|(key, _)| !self.failed_parts.contains(key));
        // On a `ctx_keep` pass the parts the model chose stay whole: the
        // other lanes still land, but none of them takes a kept part.
        let kept = |key: &lanes::PartKey| keep.is_some_and(|kept| kept.contains(key));
        wanted.retain(|(key, _)| !kept(key));
        let (mut ops, mut covered) = lanes::drop_ops(&context, &wanted);
        // Another rewrite on this pass: a lane edit, a history head or cut
        // that changes, or a ride whose request's prefix changes anyway.
        let head_changes = history.iter().any(|op| {
            !self
                .latest
                .as_ref()
                .is_some_and(|view| view.edits.iter().any(|edit| edit.op == *op))
        });
        let priced = !ops.is_empty() || head_changes || prefix_changes;
        self.next_latch = false;
        if self.emergency_drop_allowed(settings, over_limit.is_some(), priced) {
            let queued_for_emergency: Vec<_> = wanted
                .iter()
                .filter(|(_, shape)| *shape == lanes::Shape::Requested)
                .cloned()
                .collect();
            let (queued_ops, queued_covered) = lanes::drop_ops(&context, &queued_for_emergency);
            // The provider reading still includes queued reductions landing
            // on this pass. The TypeScript reference plans before routine
            // reasoning cleanup, so that lane's removals do not get credit.
            let removed_tokens = if queued_ops.is_empty() {
                0
            } else {
                let (before, _) =
                    self.served_costs(self.latest.iter().flat_map(|v| &v.edits).map(|e| &e.op));
                let (after, _) = self.served_costs(
                    self.latest
                        .iter()
                        .flat_map(|v| &v.edits)
                        .map(|e| &e.op)
                        .chain(queued_ops.iter()),
                );
                before
                    .iter()
                    .map(|(key, old)| old.saturating_sub(after.get(key).copied().unwrap_or(0)))
                    .sum()
            };
            let emergency = lanes::Emergency {
                prompt_tokens: self.pressure().last_prompt_tokens.unwrap_or(0),
                request_tokens: over_limit,
                notes: self.notes.clone(),
                ceiling_tokens: (usable as f64 * settings.execute_threshold_percentage / 100.0)
                    as u64,
                over_limit: over_limit.is_some(),
                priced,
                removed_tokens,
            };
            let emergency_edited = edited.including(&queued_covered);
            let emergency_context = lanes::Context {
                edited: &emergency_edited,
                ..context
            };
            let mut selected = lanes::emergency_drop(&emergency_context, cutoff, &emergency);
            selected.retain(|(key, _)| !kept(key));
            if !selected.is_empty() {
                // An over-limit request drops calls whole, whatever shape an
                // earlier lane asked for.
                if over_limit.is_some() {
                    let whole: BTreeSet<&lanes::PartKey> =
                        selected.iter().map(|(key, _)| key).collect();
                    wanted.retain(|(key, _)| !whole.contains(key));
                }
                wanted.extend(selected);
                (ops, covered) = lanes::drop_ops(&context, &wanted);
                // The batch counts once the runner takes the view.
                self.next_latch = true;
            }
        }
        // A rewrite with no batch rearms the emergency lane, so outputs that
        // become droppable later can still form one (the plugin keeps the
        // episode armed on such a pass). A changed prefix loses the cache
        // whether or not a view follows; a lane edit or head change counts
        // once taken.
        self.next_rearm = false;
        if priced && !self.next_latch {
            if prefix_changes {
                self.emergency_latched = false;
            } else {
                self.next_rearm = true;
            }
        }
        // Answered images go once content at least as new has been dropped,
        // by an earlier view or by this pass.
        // Parts set aside after a view failed ck-mc's own checks stay out of
        // every automatic lane, so the failure doesn't repeat each pass.
        let image_skip: Vec<lanes::PartKey> = covered
            .iter()
            .chain(keep.into_iter().flatten())
            .chain(self.failed_parts.iter())
            .cloned()
            .collect();
        let images = lanes::Images {
            outputs: &self.image_outputs,
            watermark: edited
                .watermark(&self.index)
                .max(lanes::ops_watermark(&self.index, &ops)),
            cutoff,
            over_limit: over_limit.is_some(),
            skip: &image_skip,
        };
        let (image_ops, image_parts) = lanes::answered_images(&context, &images);
        let caveman_skip: Vec<lanes::PartKey> = covered
            .iter()
            .filter(|key| !stripped_only.contains(key))
            .cloned()
            .chain(keep.into_iter().flatten().cloned())
            .chain(self.failed_parts.iter().cloned())
            .collect();
        ops.extend(image_ops);
        covered.extend(image_parts);
        // Caveman text replaces any other text edit of the same part this
        // pass made (a stripped injection): it starts from the stripped text.
        self.next_caveman = None;
        if let (true, Some(caveman)) = (self.features.caveman, settings.caveman.as_ref()) {
            let (texts, next) =
                lanes::caveman(&context, caveman, &self.caveman, cutoff, &caveman_skip);
            for ((mid, part_id), text) in texts {
                let Some((_, part)) = self.index.find(&mid, &part_id) else {
                    continue;
                };
                ops.retain(|op| {
                    !matches!(op, EditOp::Replace { mid: m, part: p, field, .. }
                        if *m == mid && *p == part_id && field == "text")
                });
                ops.push(EditOp::Replace {
                    mid,
                    part: part_id,
                    field: "text".into(),
                    value: serde_json::json!(text),
                    expect: part.digest.clone(),
                });
            }
            self.next_caveman = Some(next);
        }
        let bookmark = lanes::far_behind_bookmark(&context, usable);
        let notice_bookmark = if self.notice_keep {
            lanes::notice_far_behind_bookmark(&context, usable)
        } else {
            0
        };
        // The age sweep only drops on the pass after the one that sees an
        // output far behind, so the first pass over the threshold frees
        // little by design. What it has lined up for the next pass counts as
        // relief too, or every session would be asked for ctx_keep on its
        // first crossing.
        let lined_up: Vec<lanes::PartKey> = lanes::age_sweep(
            &context,
            bookmark.max(self.reclaim_bookmark),
            notice_bookmark.max(notice_reclaim_bookmark),
            cutoff,
        )
        .into_iter()
        .map(|(key, _)| key)
        .filter(|key| !covered.contains(key))
        .collect();
        let freed = freed_tokens(&context, &covered) + freed_tokens(&context, &lined_up);
        self.next_reclaim_bookmark = Some(self.reclaim_bookmark.max(bookmark));
        self.next_notice_reclaim_bookmark = self
            .notice_keep
            .then_some(self.notice_reclaim_bookmark.max(notice_bookmark));
        // A pass whose lanes have no new edit publishes nothing (PD12). A
        // memory another writer saved changes only `m[1]`: it waits for a
        // pass that rewrites anyway, as the plugin's history refresh rides a
        // rewrite and never starts one.
        let history = if !flush
            && ops.is_empty()
            && !prefix_changes
            && over_limit.is_none()
            && keep.is_none()
            && !self.summary_unshown
            && !self.head_stale
            && self.only_m1_changes(&history)
        {
            self.head_as_shown(
                "only memories in m[1] changed; they wait for a pass that rewrites anyway",
            )
        } else {
            history
        };
        ops.extend(history);
        drop(lanes_timing);
        (self.seal(ops, &covered), freed)
    }

    /// Commands and rebuilds use the same tail boundary, so queued work is
    /// reported as ready only after it leaves the recent protected tail.
    fn lane_context<'a>(
        index: &'a Index,
        edited: &'a lanes::Edited,
        settings: &'a Settings,
        conditions: &Conditions,
        keep_first_message: bool,
        signed_floor: Option<u64>,
    ) -> (lanes::Context<'a>, u64, Option<u64>) {
        let context = lanes::Context {
            index,
            edited,
            protected_tools: &settings.protected_tools,
            keep_first_message,
            signed_floor,
        };
        let usable = pass::usable_window(conditions);
        let floor = settings
            .protected_tokens
            .unwrap_or_else(|| lanes::default_protected_tokens(usable));
        let cutoff = lanes::protected_cutoff(&context, floor);
        (context, usable, cutoff)
    }

    /// Turn a pass's edits into the next view, and forget the queued drops
    /// it covers.
    fn seal(&mut self, ops: Vec<EditOp>, covered: &[lanes::PartKey]) -> Option<View> {
        let _timing = crate::notice_cost_timing::span("build.seal");
        let version = self.version + 1;
        let retire = retired_history(self.summaries.is_empty(), &ops);
        let full = self.with_replaced_outputs(&ops);
        let built = view_builder::next_view_cached(
            self.latest.as_ref(),
            full.as_deref().unwrap_or(self.index.entries()),
            ops,
            view_builder::ViewPolicy {
                rules: &self.conditions.rules,
                version,
                built_through: self
                    .index
                    .cursor()
                    .filter(|_| self.view_anchor)
                    .map(|cursor| cursor.mid.clone()),
                new_signed: (self.view_anchor
                    && cortexkit_compaction_view::rules::is_bound_signed_model(
                        &self.conditions.model.model,
                    ))
                .then(|| "strip".into()),
                signed_floor: self.signed_floor.clone(),
            },
            retire,
            &mut self.view_validation,
        );
        match built {
            Ok(Some(view)) => {
                // A moved session's view must cut at or after its move floor
                // (see `move_floor`). One that doesn't stays here, and the
                // runner keeps serving the view it has.
                if let Some(why) = self.move_floor_breach(&view) {
                    self.discard_held_view();
                    self.hold_below_move_floor(&why);
                    return None;
                }
                self.release_move_floor_hold();
                self.version = version;
                self.next_covered = covered.to_vec();
                Some(view)
            }
            // Nothing new to land: what the pass covered was covered already.
            // The head it rendered is the one shown, so a due fold is done:
            // left pending, it would rewrite `m[0]` on a later pass whose
            // cache is still warm.
            Ok(None) => {
                self.commit_bookmark();
                let flush = std::mem::take(&mut self.next_flush);
                self.forget_queued(covered);
                if let Some(next) = self.next_baseline.take() {
                    self.baseline = Some(next);
                    if !flush {
                        self.fold_due = false;
                    }
                }
                if let Some(next) = self.next_caveman.take() {
                    self.caveman = next;
                }
                None
            }
            // A lane's bug. Its work is forgotten, queued drops and the parts
            // automatic lanes chose alike, so the same failure does not repeat
            // on every pass.
            Err(refusal) => {
                self.commit_bookmark();
                self.forget_queued(covered);
                self.failed_parts.extend(covered.iter().cloned());
                self.next_latch = false;
                self.next_rearm = false;
                tracing::warn!(
                    "ck-mc: session {}: no valid view: {refusal:?}",
                    self.key.session
                );
                None
            }
        }
    }

    /// Tests only: the next view with `ops` added, without ck-mc's checks.
    /// For fixtures that need a view's effect on what ck-mc records, not its
    /// validity: the pinned app-read samples show a dropped part in the
    /// newest message, which [`Session::seal`] now refuses, and their bytes
    /// must not change.
    #[cfg(test)]
    pub(crate) fn seal_unchecked(&mut self, ops: Vec<EditOp>) -> View {
        let version = self.version + 1;
        self.version = version;
        let mut edits = self
            .latest
            .as_ref()
            .map(|view| view.edits.clone())
            .unwrap_or_default();
        edits.extend(
            ops.into_iter()
                .map(|op| cortexkit_role_compaction::view::Edit::new(version, op)),
        );
        View::seal(version, edits)
    }

    /// Whether `view` is over the size limit (compaction contract V5). Views name edits, never
    /// copies, so one this large is a bug in the code that built it. It is
    /// not sent, the runner keeps the view it has, and the queued drops it
    /// carried are forgotten, as for any view that fails ck-mc's own checks.
    fn refuse_oversized(&mut self, view: &View) -> bool {
        let _timing = crate::notice_cost_timing::span("publish.size_check");
        let size = self.view_validation.encoded_size(view);
        if size <= MAX_VIEW_BYTES {
            return false;
        }
        self.next_baseline = None;
        self.next_caveman = None;
        self.next_latch = false;
        self.next_rearm = false;
        let covered = std::mem::take(&mut self.next_covered);
        self.forget_queued(&covered);
        // As after a view that fails ck-mc's own checks: its parts are set
        // aside, so the same oversized view isn't built again on every pass.
        self.failed_parts.extend(covered.iter().cloned());
        tracing::info!(
            "ck-mc: session {}: view {} not sent: view_too_large ({size} bytes, limit {MAX_VIEW_BYTES})",
            self.key.session, view.version
        );
        true
    }

    /// The cache-bust analyzer parses this line to tell which request first
    /// carried a rebuilt view and how far its cut reached, so keep its shape:
    /// `cut through <message id>` or `no cut`.
    fn log_view_accepted(&self, view: &View) {
        let cut = view
            .edits
            .iter()
            .find_map(|edit| match &edit.op {
                EditOp::Cut { through } => Some(format!("cut through {through}")),
                _ => None,
            })
            .unwrap_or_else(|| "no cut".to_string());
        tracing::info!(
            "ck-mc: session {}: view {} accepted ({} edits, {cut})",
            self.key.session,
            view.version,
            view.edits.len()
        );
    }

    /// Hand `view` to the runner. It is accepted first, as unconfirmed, and
    /// the session's state saved, so that whatever happens to the call, a
    /// restarted ck-mc knows the view may be in the runner's hands. A view
    /// the runner refuses, or a call that fails, puts the state back.
    async fn publish<C: RunnerClient>(&mut self, client: &C, view: View) -> bool {
        self.publish_recorded(client, view).await.0
    }

    async fn publish_recorded<C: RunnerClient>(
        &mut self,
        client: &C,
        view: View,
    ) -> (bool, Option<crate::store::Durable>) {
        if self.suspended || self.transcript_behind.is_some() || self.refuse_oversized(&view) {
            return (false, None);
        }
        self.accept(view.clone());
        let durable = self.durable();
        if let Err(error) = self.save_state(&durable) {
            tracing::warn!("ck-mc: {error}");
            self.roll_back(view.version, false, None);
            return (false, None);
        }
        let request = ApplyViewRequest::new(view.clone());
        match client.apply_view(&self.key, request).await {
            Ok(ApplyViewAnswer::Accepted) => {
                self.runner_holds(view.version);
                self.log_view_accepted(&view);
                self.app_view_status(view.version, "accepted");
                return (true, Some(durable));
            }
            Ok(ApplyViewAnswer::Refused { refusal }) => {
                tracing::warn!(
                    "ck-mc: session {}: runner refused view {}: {refusal:?}",
                    self.key.session,
                    view.version
                );
                // The runner holds a newer view than ck-mc knows (one handed
                // over before a crash): the next view must be newer still,
                // and the drops this one carried were not at fault.
                let stale = match &refusal {
                    ViewRefusal::StaleVersion { latest, .. } => {
                        self.version = self.version.max(*latest);
                        true
                    }
                    _ => false,
                };
                // A signed part ck-mc kept only because of a signed floor the
                // runner did not apply: the floor, not the drops the view
                // carried, was at fault. They stay queued, with no refusal
                // counted against them; the apps still show the view as
                // refused.
                let floor_at_fault = self.judge_floor_refusal(&view.edits, view.version, &refusal);
                self.roll_back(
                    view.version,
                    !stale && !floor_at_fault,
                    refusal_part(&refusal),
                );
                if floor_at_fault {
                    self.app_view_status(view.version, "refused");
                }
                self.reset_transcript_retry();
            }
            // An answer the contract may add later leaves the outcome
            // unknown (compaction contract W1.5): the view is not sent again,
            // and ck-mc takes whatever view the runner applies.
            Ok(other) => {
                tracing::info!(
                    "ck-mc: session {}: unknown answer to view {}: {other:?}",
                    self.key.session,
                    view.version
                );
                self.roll_back(view.version, false, None);
                self.adopt_runner_view(client).await;
                let delivered = self.newest_applied == view.version
                    && self
                        .latest
                        .as_ref()
                        .is_some_and(|held| held.checksum == view.checksum);
                return (delivered, Some(durable));
            }
            Err(error) => {
                self.runner_call_failed("session.apply_view", &error);
                self.roll_back(view.version, false, None);
            }
        }
        (false, Some(durable))
    }

    /// A view handed over before ck-mc restarted that the runner does not
    /// report applying: it may never have arrived, so it is offered again.
    /// A runner that already holds it refuses it as not newer, which
    /// confirms nothing but loses nothing; any other refusal rolls it back.
    async fn offer_unconfirmed_again<C: RunnerClient>(&mut self, client: &C) {
        // A runner that set up again may have restarted and lost a view it
        // had accepted. Its answer to this offer says again whether it holds
        // the view, and its readings are judged afresh from here.
        for pending in &mut self.unconfirmed {
            pending.accepted = false;
            pending.excused = None;
        }
        let Some(view) = self.unconfirmed.last().map(|pending| pending.view.clone()) else {
            return;
        };
        let oldest = self.unconfirmed[0].view.version;
        // An older ck-mc saved views without their policy members
        // (`built_through`, `new_signed`), which their checksum covers. Such
        // a view can't be repaired, since nothing else records the message
        // it was built through, and the runner would refuse it for its
        // checksum. It goes back as undelivered: its parts did nothing
        // wrong, so the rebuild may carry them again.
        if !view.verify() {
            let why = if view.built_through.is_none() && view.new_signed.is_none() {
                "saved without its policy members"
            } else {
                "no longer matches its checksum as saved"
            };
            tracing::warn!(
                "ck-mc: session {}: view {} {why}; rebuilding instead of offering it again",
                self.key.session,
                view.version
            );
            self.roll_back(oldest, false, None);
            return;
        }
        // Saved by a build from before the move floor was known, a view may
        // cut before it. Such a view is not offered again: ck-mc puts back
        // what accepting it changed, as when its fate is unknown, and takes
        // whatever view the runner reports applying.
        if let Some(why) = self.move_floor_breach_placed(client, &view).await {
            self.hold_below_move_floor(&why);
            self.roll_back(oldest, false, None);
            return;
        }
        match client
            .apply_view(&self.key, ApplyViewRequest::new(view.clone()))
            .await
        {
            Ok(ApplyViewAnswer::Accepted) => {
                self.runner_holds(view.version);
                self.app_view_status(view.version, "accepted");
            }
            // Refused as not newer than the view the runner holds: it holds
            // this one.
            Ok(ApplyViewAnswer::Refused {
                refusal: ViewRefusal::StaleVersion { latest, .. },
            }) if latest == view.version => {
                self.runner_holds(view.version);
                self.reset_transcript_retry();
            }
            Ok(ApplyViewAnswer::Refused { refusal }) => {
                tracing::warn!(
                    "ck-mc: session {}: runner refused view {} offered again: {refusal:?} ({})",
                    self.key.session,
                    view.version,
                    policy_members(&view)
                );
                // As for a view refused when first handed over: a signed
                // part kept only because of a floor puts the fault on the
                // floor, not on the drops. After a restart the index is
                // still empty here, so nothing is placed and the usual
                // penalty applies.
                let floor_at_fault = self.judge_floor_refusal(&view.edits, view.version, &refusal);
                self.roll_back(oldest, !floor_at_fault, None);
                if floor_at_fault {
                    self.app_view_status(oldest, "refused");
                }
                self.reset_transcript_retry();
            }
            Ok(other) => {
                tracing::info!(
                    "ck-mc: session {}: unknown answer to view {} offered again: {other:?}",
                    self.key.session,
                    view.version
                );
                self.roll_back(oldest, false, None);
            }
            Err(error) => {
                self.runner_call_failed(&format!("offering view {} again", view.version), &error);
                self.roll_back(oldest, false, None);
            }
        }
    }

    /// Save the session's state now, where a store is set.
    fn save(&self) -> Result<(), String> {
        self.save_state(&self.durable())
    }

    fn save_state(&self, durable: &crate::store::Durable) -> Result<(), String> {
        if let Some(store) = &self.store {
            store.save(&self.key, durable)?;
            if self.app_decisions_dirty {
                if let Err(error) = store.save_app_decisions(&self.key, &self.app_decisions) {
                    tracing::warn!("ck-mc: {error}");
                }
            }
        }
        Ok(())
    }

    /// Forget queued drops that landed or can never land.
    fn forget_queued(&mut self, parts: &[lanes::PartKey]) {
        for part in parts {
            self.app_projection.dirty.insert(part.0.clone());
            self.queued.remove(part);
            self.refused_once.remove(part);
            self.app_prune_stamps([part.clone()]);
        }
    }

    /// The runner did not take a view: its queued drops stay queued for the
    /// next one, except those blamed by a refused view already once. When a
    /// refusal names a culprit, the other drops did not cause the failure.
    fn keep_refused_drops(&mut self, culprit: Option<&lanes::PartKey>) {
        for part in std::mem::take(&mut self.next_covered) {
            if culprit.is_some_and(|culprit| *culprit != part) {
                continue;
            }
            if !self.queued.contains(&part) {
                continue;
            }
            if self.refused_once.insert(part.clone()) {
                continue;
            }
            tracing::warn!(
                "ck-mc: session {}: queued drop of {}/{} forgotten after a second refused view",
                self.key.session,
                part.0,
                part.1
            );
            self.queued.remove(&part);
            self.app_projection.dirty.insert(part.0.clone());
            self.app_prune_stamps([part.clone()]);
            self.refused_once.remove(&part);
        }
    }

    /// Take `view` as the one the runner shows, unconfirmed until a notice
    /// reports it applied (see [`Unconfirmed`]).
    /// Move the age-sweep bookmark to where the last build left it.
    fn commit_bookmark(&mut self) {
        if let Some(bookmark) = self.next_reclaim_bookmark.take() {
            self.reclaim_bookmark = self.reclaim_bookmark.max(bookmark);
        }
        if let Some(bookmark) = self.next_notice_reclaim_bookmark.take() {
            self.notice_reclaim_bookmark = self.notice_reclaim_bookmark.max(bookmark);
        }
    }

    fn accept(&mut self, view: View) {
        let flush = std::mem::take(&mut self.next_flush);
        let _timing = crate::notice_cost_timing::span("publish.accept");
        self.app_record_view(&view);
        let covered = std::mem::take(&mut self.next_covered);
        let before = Before {
            head_stale: self.head_stale,
            latest: self.latest.clone(),
            queued: self.queued.clone(),
            refused_once: self.refused_once.clone(),
            transcript_retry: self.transcript_retry,
            emergency_latched: self.emergency_latched,
            baseline: self.baseline.clone(),
            fold_due: self.fold_due,
            caveman: self.caveman.clone(),
            cut: self.cut,
            pruned_turns: self.pruned_turns,
            reclaim_bookmark: Some(self.reclaim_bookmark),
            notice_reclaim_bookmark: Some(self.notice_reclaim_bookmark),
            summary_unshown: self.summary_unshown,
            pending_keep: self.next_keep.take(),
            spent_reading: self.spent_reading,
        };
        self.commit_bookmark();
        self.unconfirmed.push(Unconfirmed {
            view: view.clone(),
            covered: covered.clone(),
            before,
            built_through: self.index.cursor().map(|cursor| cursor.ordinal),
            accepted: false,
            excused: None,
        });
        self.forget_queued(&covered);
        if std::mem::take(&mut self.next_latch) {
            self.emergency_latched = true;
        } else if std::mem::take(&mut self.next_rearm) {
            self.emergency_latched = false;
        }
        if let Some(next) = self.next_baseline.take() {
            self.head_stale = false;
            self.baseline = Some(next);
            if !flush {
                self.fold_due = false;
            }
            self.summary_unshown = false;
        }
        if let Some(next) = self.next_caveman.take() {
            self.caveman = next;
        }
        self.version = self.version.max(view.version);
        self.spend_reading(view.version);
        self.apply_cut(&view);
        self.latest = Some(view);
    }

    /// The runner said it holds the unconfirmed view `version` (see
    /// [`Unconfirmed::accepted`]).
    fn runner_holds(&mut self, version: u64) {
        if let Some(pending) = self
            .unconfirmed
            .iter_mut()
            .find(|pending| pending.view.version == version)
        {
            pending.accepted = true;
        }
    }

    /// Settle the unconfirmed views against what the runner reports: each
    /// one it applies (or a later one it applies) is confirmed, and one it
    /// refused is rolled back with every view built on it.
    fn settle_unconfirmed(
        &mut self,
        applied: Option<&AppliedView>,
        refused: &[(u64, ViewRefusal)],
    ) {
        // The runner reports the view it applies now, and none when the field
        // is absent. Taken as it stands, not as a maximum: a runner whose
        // state went back, or that stopped applying any view, measures its
        // requests under what it applies now.
        self.newest_applied = applied.map_or(0, |applied| applied.version);
        self.app_confirm_head(self.newest_applied);
        if let Some(applied) = applied {
            // Views are cumulative: applying a view applies every edit of the
            // unconfirmed ones before it.
            if let Some(at) = self
                .unconfirmed
                .iter()
                .position(|pending| same(applied, &pending.view))
            {
                let stamp_keys: Vec<_> = self
                    .unconfirmed
                    .first()
                    .into_iter()
                    .flat_map(|first| first.before.queued.iter().cloned())
                    .collect();
                if let Some(first) = self.unconfirmed.first() {
                    self.app_projection
                        .dirty
                        .extend(first.before.queued.iter().map(|key| key.0.clone()));
                }
                let versions: Vec<_> = self.unconfirmed[..=at]
                    .iter()
                    .map(|pending| pending.view.version)
                    .collect();
                for version in versions {
                    self.app_view_status(version, "applied");
                }
                self.unconfirmed.drain(..=at);
                self.reset_transcript_retry();
                self.app_prune_stamps(stamp_keys);
                if let Some(first) = self.unconfirmed.first() {
                    self.app_projection
                        .dirty
                        .extend(first.before.queued.iter().map(|key| key.0.clone()));
                }
            }
        }
        self.settle_refused(refused);
    }

    /// Roll back the oldest unconfirmed view the runner refused at a step
    /// boundary, with every view built on it.
    fn settle_refused(&mut self, refused: &[(u64, ViewRefusal)]) {
        if let Some((version, refusal)) = refused
            .iter()
            .filter(|(version, _)| {
                self.unconfirmed
                    .iter()
                    .any(|pending| pending.view.version == *version)
            })
            .min_by_key(|(version, _)| *version)
        {
            let moved =
                TranscriptRefusal::of(refusal).or_else(|| self.new_signed_part(*version, refusal));
            // A signed part the view knew, kept only because of a signed
            // floor the runner did not apply: the floor was at fault, not
            // the drops, and the retry pays no penalty.
            let kept = match moved {
                Some(_) => None,
                None => self
                    .unconfirmed
                    .iter()
                    .find(|pending| pending.view.version == *version)
                    .and_then(|pending| self.kept_for_a_floor(&pending.view.edits, refusal)),
            };
            if kept == Some(true) {
                self.disprove_floor(*version, refusal);
            }
            let floor_at_fault = kept.is_some();
            // FinalTurnRemoved depends on the newest entry; UnknownMessage
            // can follow a revert. Neither blames a drop when an accepted
            // view first loses that race. Only its immediate retry pays the
            // usual refusal penalty if the same reason repeats. A new signed
            // part never pays it: the part did not exist when ck-mc built
            // the view, so no repeat can be ck-mc's own fault.
            let guard = !floor_at_fault
                && match moved {
                    None => true,
                    Some(TranscriptRefusal::NewSignedPart) => false,
                    Some(kind) => self.transcript_retry == Some((kind, *version)),
                };
            self.roll_back(*version, guard, refusal_part(refusal));
            // Retrying skips drop penalties, not the refusal status shown
            // in the apps' view history.
            self.app_view_status(*version, "refused");
            self.reset_transcript_retry();
            self.transcript_retry = moved
                .filter(|kind| *kind != TranscriptRefusal::NewSignedPart)
                .map(|kind| (kind, self.version + 1));
        }
    }

    /// Whether `refusal` names a signed part in an entry newer than any the
    /// index held when view `version` was built. A part ck-mc cannot place
    /// counts as new: every entry the view knew stays indexed until a
    /// confirmed view changes which entries the index holds.
    fn new_signed_part(&self, version: u64, refusal: &ViewRefusal) -> Option<TranscriptRefusal> {
        let ViewRefusal::Rule(RuleBreak::SignedPartInvalid { mid, .. }) = refusal else {
            return None;
        };
        let through = self
            .unconfirmed
            .iter()
            .find(|pending| pending.view.version == version)?
            .built_through?;
        match self.index.ordinal_of(mid) {
            Some(ordinal) if ordinal <= through => None,
            _ => Some(TranscriptRefusal::NewSignedPart),
        }
    }

    fn reset_transcript_retry(&mut self) {
        self.transcript_retry = None;
        // A later rollback must not resurrect a guard reset by an applied
        // view or a different refusal.
        for pending in &mut self.unconfirmed {
            pending.before.transcript_retry = None;
        }
    }

    /// Put back what accepting the view `version`, and every view built on
    /// it, changed. Its queued drops are queued again, except one that a
    /// refused view already blamed once: a drop the runner keeps refusing
    /// must not make every later pass build a view it refuses.
    fn roll_back(&mut self, version: u64, refused: bool, culprit: Option<lanes::PartKey>) {
        if let Some(record) = self
            .app_decisions
            .iter_mut()
            .find(|r| r["view_version"] == version)
        {
            let status = if refused { "refused" } else { "undelivered" };
            if record["status"] != status {
                record["status"] = serde_json::json!(status);
                self.app_decisions_revision += 1;
                self.app_decisions_dirty = true;
            }
        }
        let Some(at) = self
            .unconfirmed
            .iter()
            .position(|pending| pending.view.version == version)
        else {
            return;
        };
        let undone = self.unconfirmed.split_off(at);
        let first = &undone[0];
        let before = first.before.clone();
        self.app_projection.dirty.extend(
            self.queued
                .iter()
                .chain(&before.queued)
                .map(|key| key.0.clone()),
        );
        let covered: Vec<lanes::PartKey> = undone
            .iter()
            .flat_map(|pending| pending.covered.iter().cloned())
            .collect();
        let cut_moved = self.cut != before.cut;
        self.latest = before.latest;
        // A view saved by an older ck-mc may lack the policy members its
        // checksum covers. It can't stand for the view the runner applies:
        // the next view would differ from it in policy alone and be built
        // for nothing. Read the runner's own copy back before building.
        if self.latest.as_ref().is_some_and(|view| !view.verify()) {
            self.latest_unknown = true;
        }
        self.queued = before.queued;
        self.refused_once = before.refused_once;
        self.transcript_retry = before.transcript_retry;
        self.emergency_latched = before.emergency_latched;
        self.summary_unshown |= before.summary_unshown;
        if before.pending_keep.is_some() {
            self.pending_keep = before.pending_keep;
        }
        self.spent_reading = before.spent_reading;
        self.baseline = before.baseline;
        self.app_projection.head_read.offered = None;
        self.fold_due = before.fold_due;
        self.head_stale |= undone.iter().any(|pending| pending.before.head_stale);
        self.caveman = before.caveman;
        self.cut = before.cut;
        self.pruned_turns = before.pruned_turns;
        if let Some(bookmark) = before.reclaim_bookmark {
            self.reclaim_bookmark = bookmark;
        }
        if let Some(bookmark) = before.notice_reclaim_bookmark {
            self.notice_reclaim_bookmark = bookmark;
        }
        if cut_moved {
            // The index already forgot what the cut removed; read it again
            // from the cut the runner still shows.
            self.index = Index::starting_at(self.cut.unwrap_or(1));
            self.index_ready = false;
        }
        if refused {
            // A refusal that names the part at fault sets aside only that
            // part; one that names none sets aside every automatic part the
            // view carried, so the same view is not built again.
            let at_fault: Vec<lanes::PartKey> = match &culprit {
                Some(part) => covered.iter().filter(|key| *key == part).cloned().collect(),
                None => covered.clone(),
            };
            self.failed_parts.extend(
                at_fault
                    .into_iter()
                    .filter(|part| !self.queued.contains(part)),
            );
            self.next_covered = covered;
            self.keep_refused_drops(culprit.as_ref());
        }
    }

    /// A ride's view whose answer never reached the runner (its deadline
    /// passed): the runner never had it.
    pub fn ride_undelivered(&mut self, version: u64) {
        self.roll_back(version, false, None);
    }

    /// Whether the runner applies a view ck-mc does not expect: neither its
    /// latest nor, while views wait for confirmation, the one before them.
    fn runner_differs(&self, applied: Option<&AppliedView>) -> bool {
        // After a restart ck-mc must read the view back before building.
        if self.latest_unknown {
            return true;
        }
        let expected = |view: Option<&View>| match (applied, view) {
            (Some(applied), Some(view)) => same(applied, view),
            (None, None) => true,
            _ => false,
        };
        let waiting = self
            .unconfirmed
            .first()
            .map(|pending| pending.before.latest.as_ref());
        !(expected(self.latest.as_ref()) || waiting.is_some_and(expected))
    }

    /// Take the view the runner applies as ck-mc's own: after a refusal, or
    /// when ck-mc's copy is missing or older (for example after a restore).
    async fn adopt_runner_view<C: RunnerClient>(&mut self, client: &C) {
        self.runner_reads
            .applied_view
            .fetch_add(1, Ordering::Relaxed);
        match client.applied_view(&self.key).await {
            Ok(answer) => {
                self.keep_spent_reading_for(&answer);
                // The runner's own answer is what it applies now. It replaces
                // the newest version rather than raising it: a runner whose
                // state went back (a restore) measures under the view it
                // applies, and a higher remembered version would make every
                // reading it sends look stale.
                self.newest_applied = answer.view.as_ref().map_or(0, |view| view.version);
                // The runner's view now stands for itself.
                self.unconfirmed.clear();
                if let Some(view) = &answer.view {
                    self.reset_transcript_retry();
                    self.version = self.version.max(view.version);
                    // A different provider owns its cut and edits. Only its
                    // version is a floor for our whole replacement.
                    if answer
                        .applied_by
                        .as_deref()
                        .is_some_and(|id| id != crate::MODULE_ID)
                    {
                        self.latest = None;
                        self.latest_unknown = false;
                        self.app_adopt_head();
                        return;
                    }
                    self.apply_cut(view);
                }
                self.latest = answer.view;
                self.latest_unknown = false;
                self.app_adopt_head();
            }
            Err(error) => {
                self.runner_reads
                    .applied_view_failed
                    .fetch_add(1, Ordering::Relaxed);
                self.runner_call_failed("session.applied_view", &error);
            }
        }
    }

    /// Log a failed call to the runner's compaction ops. A
    /// `compaction_not_permitted` refusal suspends the session (see
    /// `suspended`); any other failure leaves it to the next notice.
    fn runner_call_failed(&mut self, what: &str, error: &crate::client::ClientError) {
        tracing::warn!(
            "ck-mc: session {}: {what} failed: {error}",
            self.key.session
        );
        if error.not_permitted() && !self.suspended {
            tracing::warn!(
                "ck-mc: session {}: the runner refused ck-mc as its compaction provider; suspended until its next Setup",
                self.key.session
            );
            self.suspended = true;
            self.index_ready = false;
        }
    }

    /// Bring the index up to `newest` with reads, from the index's own newest
    /// entry on (which may have changed since). If the transcript diverged
    /// from the index, read it all again.
    /// Read from the oldest held entry that may still change, even though
    /// the index already ends where the runner's transcript does.
    async fn sync_from_changeable<C: RunnerClient>(&mut self, client: &C, newest: &Cursor) -> bool {
        if self.index.changeable_from().is_some() {
            return self.read_until(client, Some(newest), true).await;
        }
        true
    }

    async fn sync<C: RunnerClient>(&mut self, client: &C, newest: Option<&Cursor>) -> bool {
        let force = !self.index_ready
            || self
                .cut
                .is_some_and(|cut| newest.map_or(0, |cursor| cursor.ordinal) < cut);
        self.read_until(client, newest, force).await
    }

    /// Read until the index ends at `newest`; with `force`, read at least
    /// once.
    async fn read_until<C: RunnerClient>(
        &mut self,
        client: &C,
        newest: Option<&Cursor>,
        force: bool,
    ) -> bool {
        self.read_until_from(client, newest, force, self.index.read_after())
            .await
    }

    /// Count one transcript read ck-mc made to the runner and the entries it
    /// returned (`None` when it failed), for Setup's closing log line. A
    /// read of messages by id that the `reads` helpers split into several
    /// requests counts once.
    fn count_read(&self, entries: Option<usize>) {
        self.runner_reads.reads.fetch_add(1, Ordering::Relaxed);
        if let Some(entries) = entries {
            self.runner_reads
                .entries
                .fetch_add(entries as u64, Ordering::Relaxed);
        }
    }

    async fn read_until_from<C: RunnerClient>(
        &mut self,
        client: &C,
        newest: Option<&Cursor>,
        mut force: bool,
        mut after: Option<u64>,
    ) -> bool {
        let mut rebuilt = false;
        loop {
            if !std::mem::take(&mut force) && self.index.ends_at(newest) {
                return true;
            }
            let request = self.limits.after(after, None, Detail::Compact);
            let page = client.read(&self.key, request).await;
            self.count_read(page.as_ref().ok().map(|page| page.entries.len()));
            let page = match page {
                Ok(page) => page,
                Err(error) => {
                    self.runner_call_failed("session.entries", &error);
                    return false;
                }
            };
            let runner_newest = page.head.newest.as_ref().map_or(0, |cursor| cursor.ordinal);
            if crate::reads::check_page(&self.key, after, &page).is_err() {
                return false;
            }
            if self.cut.is_some_and(|cut| runner_newest < cut) {
                if rebuilt {
                    tracing::info!(
                        "ck-mc: session {}: transcript keeps changing under a read (runner's newest {:?} is before the cut {:?})",
                        self.key.session,
                        page.head.newest,
                        self.cut
                    );
                    return false;
                }
                // The transcript ends before the cut, and no revert was
                // reported: the inference is that a revert removed every
                // message after the runner's newest entry. It may forget the
                // summaries that end after that entry only within the bound
                // Setup's check keeps (see `IMPLICIT_FORGET_LIMIT`); past it,
                // they would all fail that check too, and the session is
                // held instead. No read is needed to count them.
                let past = self
                    .summaries
                    .iter()
                    .filter(|summary| summary.end_message as u64 > runner_newest)
                    .count();
                if past > IMPLICIT_FORGET_LIMIT {
                    self.hold_transcript_behind(past, page.head.newest.as_ref());
                    return false;
                }
                self.invalidate_transcript_from(runner_newest + 1);
                self.restart_index(&mut rebuilt, &mut after);
                continue;
            }
            // Which ordinals this page carried, for the give-up log below.
            let page_span = (
                page.entries.first().map(|entry| entry.ordinal),
                page.entries.last().map(|entry| entry.ordinal),
            );
            let read_from = after;
            match self
                .index
                .extend_counted(page.entries, page.token_family.as_deref())
            {
                Extend::Continued => match page.next_after {
                    Some(next) => after = Some(next),
                    None => {
                        if !self.index.ends_at(page.head.newest.as_ref()) {
                            if !rebuilt {
                                self.restart_index(&mut rebuilt, &mut after);
                                continue;
                            }
                            tracing::info!(
                                "ck-mc: session {}: transcript keeps changing under a read (the last page ends at {:?}, but its head says {:?})",
                                self.key.session,
                                self.index.cursor(),
                                page.head.newest
                            );
                            return false;
                        }
                        return true;
                    }
                },
                Extend::Gap | Extend::Diverged if !rebuilt => {
                    self.restart_index(&mut rebuilt, &mut after)
                }
                outcome @ (Extend::Gap | Extend::Diverged) => {
                    tracing::info!(
                        "ck-mc: session {}: transcript keeps changing under a read ({:?} in the page after {:?}, ordinals {:?}..{:?}; index ends at {:?})",
                        self.key.session,
                        outcome,
                        read_from,
                        page_span.0,
                        page_span.1,
                        self.index.cursor()
                    );
                    return false;
                }
            }
        }
    }

    /// Read the index again from the cut, the oldest message the model still
    /// sees.
    fn restart_index(&mut self, rebuilt: &mut bool, after: &mut Option<u64>) {
        self.index = Index::starting_at(self.cut.unwrap_or(1));
        *rebuilt = true;
        *after = self.index.read_after();
    }

    /// Record work for the independent search indexer. Its durable watermark
    /// handles ordinary catch-up, including sessions moved from the standalone
    /// plugin with an unfinished search index. The earliest replacement ordinal
    /// invalidates rows from an undone branch before the reader continues.
    pub(crate) fn search_mark(&mut self) -> crate::search::background::Mark {
        crate::search::background::Mark {
            limits: self.limits,
            newest: self.index.cursor(),
            from: self.search_dirty_from.take(),
            reconcile: self.search_reconcile_from.take(),
            base: self.index.base(),
            entries: self.index.snapshot(),
            is_subagent: !self.features.summarizer,
        }
    }

    pub(crate) fn search_enabled(&self) -> bool {
        // Tools can also be served to plugin hosts; only runner compaction
        // sessions may refresh the plugin's shared last-response metadata.
        self.compacting() && !self.suspended && self.index_ready
    }

    fn forget_missing(&mut self) {
        let index = &self.index;
        let mut removed = Vec::new();
        self.queued.retain(|key| {
            let keep = index.find(&key.0, &key.1).is_some();
            if !keep {
                removed.push(key.clone());
            }
            keep
        });
        self.image_outputs
            .retain(|(mid, part), _| index.find(mid, part).is_some());
        self.caveman.retain_present(index);
        // A keep whose parts have all left the transcript is forgotten. A
        // keep that named nothing keepable from the start still stands: the
        // model was told everything else goes, so its view must still land.
        if let Some(kept) = &mut self.pending_keep {
            let had_parts = !kept.is_empty();
            kept.retain(|(mid, part)| index.find(mid, part).is_some());
            if had_parts && kept.is_empty() {
                self.pending_keep = None;
            }
        }
        self.app_prune_stamps(removed);
    }

    /// Read in full the tool results with images whose output the
    /// answered-images lane may need and ck-mc has not read yet, then build.
    /// Only a pass on a notice reads, since it may wait on the runner; a ride
    /// must answer before the runner's request, so it builds with what it
    /// has, and a result whose text is missing waits for a later rebuild.
    async fn build_now<C: RunnerClient>(
        &mut self,
        client: &C,
        settings: &Settings,
    ) -> (Option<View>, u64) {
        // `build` makes no view from an index that is not ready (a held
        // session's included), so nothing is read for one.
        if !self.index_ready {
            return (None, 0);
        }
        let edited = lanes::Edited::of(self.latest.as_ref(), &self.index, None);
        let wanted: Vec<lanes::PartKey> = lanes::image_results(&self.index, &edited)
            .into_iter()
            .filter(|key| !self.image_outputs.contains_key(key))
            .collect();
        if !wanted.is_empty() {
            let mids: Vec<String> = wanted
                .iter()
                .map(|(mid, _)| mid.clone())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect();
            let read = crate::reads::named(client, &self.key, mids, self.limits, |mids| {
                Select::Mids { mids }
            })
            .await;
            self.count_read(read.as_ref().ok().map(Vec::len));
            match read {
                Ok(entries) => {
                    for entry in entries {
                        for part in entry.parts {
                            let key = (entry.mid.clone(), part.id.clone());
                            // Only text read from the part the index holds.
                            let same = self
                                .index
                                .find(&key.0, &key.1)
                                .is_some_and(|(_, held)| held.digest == part.digest);
                            if let (PartBody::Tool(tool), true, true) =
                                (part.body, same, wanted.contains(&key))
                            {
                                if let Some(output) = tool.output {
                                    self.image_outputs.insert(key, output);
                                }
                            }
                        }
                    }
                }
                // The reader already logged a runner fault once for this read.
                Err(error) if error.message.starts_with("runner fault:") => {}
                Err(error) => tracing::warn!(
                    "ck-mc: session {}: reading tool results with images failed: {error:?}",
                    self.key.session
                ),
            }
        }
        self.build(settings, None, false, None)
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

mod user_commands;
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
