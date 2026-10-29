//! The offline first pass of a moved session, and its adoption on the first
//! live notice.
//!
//! `ck-mc offline first-pass` (see `crate::offline_first_pass`) runs while
//! ck-mc and the runner are stopped. It serves THALAMUS's exported pages
//! through [`PagesRunner`] and drives the ordinary lane end to end: Setup
//! (`async_setup`), the read (`read_async_resumable`), `ingest_read` with the
//! moved-session binding, `advance_async_policy`, and `publish_async`, which
//! runs the engine's first pass and its commit. Nothing here writes engine
//! state of its own.
//!
//! Before Setup's first save, [`OfflineFirstPass`] marks the record `preparing`.
//! The proof commit marks it `prepared` and stores the published view as the
//! live lineage's Setup answer. The proof covers every held entry's
//! ordinal, the runner's served content digest, the digest of its whole served
//! form, and each part's key, tag and served digest. Page boundaries are not
//! part of it. The view row is written before this final record commit, but
//! cannot be announced or adopted until the proof commit completes.
//!
//! While preparation is unadopted, `compaction.ride` answers nothing and views are
//! not announced. The first live notice then checks it once
//! (`settle_offline_first_pass`):
//! - **adopt:** the transcript the runner serves now, and every other input of
//!   the pass, match what was proven. The marker becomes `adopted` and the notice
//!   continues on the stored state, so its certificate is used as on any
//!   later notice;
//! - **discard:** anything differs. The record is replaced by a fresh one, set
//!   up by the same code a first Setup runs, in the next generation (an empty
//!   engine namespace). The old record's held entries, published engine forms
//!   and native edits are deleted in the same save. The notice then runs the
//!   ordinary first pass. The fresh record is also `adopted` and keeps the
//!   prepared Setup answer the runner already holds.
//!
//! A moved session's first live Setup refuses if its preparation is missing,
//! incomplete, or differs in Setup or runner `role.describe`. Once a notice
//! commits adoption, later Setups and notices never consult the preparation
//! gate, including after provider restarts or generation changes.
use super::*;
use crate::offline_move::MoveRecord;
use std::path::PathBuf;

/// Version 3 proves the retained interval starting at the move checkpoint,
/// rather than requiring a zero-origin transcript.
pub(super) const MARKER_VERSION: u32 = 3;
/// The time the one verification read of an offline-prepared record may take.
/// It reads the whole transcript once, so it gets far more than a notice's
/// read budget; a runner that cannot serve it in time leaves the notice to be
/// retried.
const VERIFY_READ_BUDGET: Duration = Duration::from_secs(600);
/// The offline run reads pages from a local file, so its read has no
/// practical deadline.
const OFFLINE_READ_BUDGET: Duration = Duration::from_secs(24 * 3600);
/// The route channel the offline run binds its Setup to.
const OFFLINE_CHANNEL: u16 = 1;

#[cfg(test)]
thread_local! {
    pub(super) static INTERRUPT_PREPARATION: std::cell::Cell<Option<&'static str>> = const { std::cell::Cell::new(None) };
}

#[cfg(test)]
pub(super) fn interrupt_preparation(
    stage: &str,
    state: &mut State,
    store: &McStore,
) -> Result<(), HandlerOutcome> {
    if INTERRUPT_PREPARATION.with(|flag| {
        if flag.get() == Some(stage) {
            flag.set(None);
            true
        } else {
            false
        }
    }) {
        // Preserve the durable boundary so reopening the command exercises
        // recovery from an incomplete record, without an in-memory resident copy.
        state.save(store, &[])?;
        return Err(transient(format!(
            "interrupted offline preparation at {stage}"
        )));
    }
    Ok(())
}

/// Durable preparation and adoption provenance on the provider record.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub(crate) struct OfflineFirstPass {
    pub version: u32,
    #[serde(default)]
    pub state: PreparationState,
    /// A successful bind is replayed once per generation, not on every read:
    /// replaying a retired queued drop would put it back in the pending queue.
    #[serde(default)]
    pub bound_generation: Option<u64>,
    /// Digest of the Setup request and route identity the run used; see
    /// [`setup_identity_digest`].
    pub setup: String,
    /// Digest of the runner's `role.describe` answer the run was prepared
    /// against; see [`runner_describe_digest`]. A marker without it is never
    /// adopted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub describe: Option<String>,
    /// Digest of every other input the pass read; see `offline_inputs_digest`.
    /// Written with `proof`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inputs: Option<String>,
    /// The entries the pass ran on. Absent while the run is under way: a
    /// record whose run never reached its last save is discarded, never
    /// adopted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proof: Option<EntryInputProof>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PreparationState {
    #[default]
    Preparing,
    Prepared,
    Adopted,
}

pub(super) fn adopted(state: &State) -> bool {
    state
        .offline_first_pass
        .as_ref()
        .is_some_and(|offline| offline.state == PreparationState::Adopted)
}

pub(super) fn prepared(state: &State) -> bool {
    !state.is_importing_stage()
        && state.offline_first_pass.as_ref().is_some_and(|offline| {
            offline.state == PreparationState::Prepared
                && offline.proof.is_some()
                && offline.inputs.is_some()
        })
}

pub(super) fn unprepared() -> HandlerOutcome {
    error(
        "moved_session_unprepared",
        "Run `ck-mc offline first-pass` before the moved session's first live adoption.",
    )
}

/// A digest over the held entries `[origin, end)` of one lineage.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub(crate) struct EntryInputProof {
    pub lineage: String,
    #[serde(default)]
    pub origin: u64,
    pub count: u64,
    #[serde(default)]
    pub end: u64,
    pub digest: String,
}

fn framed(hash: &mut Sha256, bytes: &[u8]) {
    hash.update((bytes.len() as u64).to_le_bytes());
    hash.update(bytes);
}

impl EntryInputProof {
    /// The proof over the held entries `[origin, end)` (through the last held
    /// entry for `None`), or `None` when those ordinals are not all held. Each entry
    /// adds its ordinal, mid, the runner's served content digest, the SHA-256
    /// of its whole served form (which also covers role, timestamps and
    /// attributions), and for every part its key, its tag (empty when
    /// untagged) and the runner's served digest of that part. The digests are
    /// the ones the runner served (`digest`, `part_digests`), never recomputed
    /// here: an entry without them fails as `served_digest_missing`, as the
    /// live read refuses it. The offline run and the live check both compute
    /// the proof from `HeldEntry`s built by `HeldEntry::from_read`, the same
    /// decode a live read uses.
    pub(super) fn of(
        entries: &held_entries::HeldEntries,
        lineage: &str,
        origin: u64,
        end: Option<u64>,
        codec: codec::Codec,
    ) -> Result<Option<Self>, HandlerOutcome> {
        let end = match end {
            Some(end) => end,
            None => entries
                .last_key_value()
                .map_or(origin, |(last, _)| last + 1),
        };
        let Some(count) = end.checked_sub(origin) else {
            return Ok(None);
        };
        let mut hash = Sha256::new();
        framed(&mut hash, b"mc-offline-entry-proof/v3");
        framed(&mut hash, lineage.as_bytes());
        hash.update(origin.to_le_bytes());
        hash.update(count.to_le_bytes());
        hash.update(end.to_le_bytes());
        for ordinal in origin..end {
            let Some(held) = entries.get(&ordinal) else {
                return Ok(None);
            };
            let entry = held.read()?;
            // Strict: an entry held from an inline read has no served digest,
            // and the proof never hashes one in the runner's place.
            check_served_identity(&entry, codec)?;
            hash.update(ordinal.to_le_bytes());
            framed(&mut hash, entry.mid.as_bytes());
            framed(&mut hash, served_digest(&entry)?.as_bytes());
            hash.update(held.input_digest);
            let native = parts(&entry.message)?;
            hash.update((native.len() as u64).to_le_bytes());
            hash.update((entry.tags.len() as u64).to_le_bytes());
            for row in &entry.tags {
                framed(&mut hash, row.part.as_bytes());
                framed(&mut hash, row.tag.as_deref().unwrap_or("").as_bytes());
                framed(&mut hash, served_part_digest(&entry, &row.part)?.as_bytes());
            }
        }
        Ok(Some(Self {
            lineage: lineage.to_owned(),
            origin,
            count,
            end,
            digest: hex(&hash.finalize()),
        }))
    }
}

/// Old marker shapes deserialize so live callers can refuse them by name and
/// the offline command can replace them without reading entries before the move
/// checkpoint.
pub(super) fn proof_version_matches(state: &State) -> bool {
    if adopted(state) {
        return true;
    }
    state.offline_first_pass.as_ref().is_none_or(|offline| {
        offline.version == MARKER_VERSION
            && offline.proof.as_ref().is_none_or(|proof| {
                proof.origin == proof_origin(state)
                    && proof.origin.checked_add(proof.count) == Some(proof.end)
            })
    })
}

fn proof_origin(state: &State) -> u64 {
    state
        .standalone_move
        .as_ref()
        .map_or(state.lineage_first_ordinal, |moved| moved.message_count)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Digest of a Setup request and the attested runner it arrives from. The
/// request is compared as canonical JSON (RFC 8785) without `request_id` and
/// `now`, which differ on every call; everything else, including `params`,
/// `composition`, `preset`, `model`, `context_window` and `lineage_id`, must
/// be equal. The route's project folder is left out: it is route metadata,
/// and a live Setup that arrives on another spelling of the same folder is
/// the same conversation.
pub(crate) fn setup_identity_digest(
    request: &compact::setup::SetupRequest,
    runner_module: &str,
) -> Result<String, HandlerOutcome> {
    let mut value = serde_json::to_value(request).map_err(transient)?;
    if let Value::Object(fields) = &mut value {
        fields.remove("request_id");
        fields.remove("now");
    }
    let canonical = serde_jcs::to_string(&value).map_err(transient)?;
    let mut hash = Sha256::new();
    framed(&mut hash, b"mc-offline-setup/v1");
    framed(&mut hash, runner_module.as_bytes());
    framed(&mut hash, canonical.as_bytes());
    Ok(hex(&hash.finalize()))
}

/// Digest of a runner's `role.describe` answer, as RFC 8785 canonical JSON
/// (the same canonical form the Setup comparison uses).
pub(crate) fn runner_describe_digest(describe: &Value) -> Result<String, HandlerOutcome> {
    let canonical = serde_jcs::to_string(describe).map_err(transient)?;
    let mut hash = Sha256::new();
    framed(&mut hash, b"mc-offline-runner-describe/v1");
    framed(&mut hash, canonical.as_bytes());
    Ok(hex(&hash.finalize()))
}

/// `runner_describe_differs` when `describe`, the live runner's
/// `role.describe` answer, is not the one an offline-prepared record was
/// prepared against (or the record names none); `None` when it is, or when
/// the record was not prepared offline.
pub(super) fn describe_mismatch(state: &State, describe: &Value) -> Option<&'static str> {
    if adopted(state) {
        return None;
    }
    let offline = state.offline_first_pass.as_ref()?;
    match (&offline.describe, runner_describe_digest(describe)) {
        (Some(prepared), Ok(live)) if *prepared == live => None,
        _ => Some("runner_describe_differs"),
    }
}

/// Why a live Setup discards an offline-prepared record, or `None` when the
/// record was not prepared offline or the Setup is the one it was prepared
/// under.
pub(super) fn setup_mismatch(
    state: &State,
    binding: &SessionBinding,
    request: &compact::setup::SetupRequest,
) -> Option<&'static str> {
    if adopted(state) {
        return None;
    }
    let offline = state.offline_first_pass.as_ref()?;
    let Some(module) = super::records::attested_runner(binding) else {
        return Some("setup_differs");
    };
    match setup_identity_digest(request, module) {
        Ok(digest) if digest == offline.setup => None,
        _ => Some("setup_differs"),
    }
}

/// The one log line a discarded offline first pass leaves.
pub(super) fn log_discard(reference: &str, reason: &str) {
    tracing::warn!(
        session_ref = %reference,
        reason,
        "offline_first_pass_discarded: the stored first pass does not match; the ordinary first pass runs"
    );
}

impl AsyncRecord {
    /// Make the next save of a record that replaces a discarded one delete what
    /// the discarded record left in this reference's rows: held entries,
    /// published engine forms and both native-edit baselines. The engine
    /// namespace is new (the generation moved), so the old one is not read
    /// again.
    pub(super) fn forget_discarded_rows(&mut self) {
        self.journal.truncate = Some(None);
        self.journal.clear_published = true;
        self.frozen_edits.dirty = true;
        self.retired_frozen.dirty = true;
    }
}

/// A runner that serves exported `session.read` pages. Each page is kept as
/// the line it came from and decoded again when served, so the read sees
/// exactly the `ReadPage` the export holds. A read that starts inside a page
/// is answered from that page's later messages, with the page's own
/// `next_from_ordinal`. `role.describe` is answered with the runner's own
/// answer from the `--setup` file, verbatim.
pub(crate) struct PagesRunner {
    pages: Vec<ServedPage>,
    describe: Value,
    head: Value,
}

/// One exported page: its first and last ordinals and its line.
pub(crate) struct ServedPage {
    pub first: u64,
    pub last: u64,
    pub line: String,
}

impl PagesRunner {
    pub(crate) fn new(pages: Vec<ServedPage>, describe: Value) -> Self {
        Self {
            pages,
            describe,
            head: json!({"first_ordinal":0}),
        }
    }

    pub(crate) fn with_move_record(mut self, record: &MoveRecord) -> Self {
        self.head = json!({
                "first_ordinal": record.message_count,
                "cut": record.head_cut,
                "lineage_id": self.pages.first().and_then(|page| serde_json::from_str::<Value>(&page.line).ok()).and_then(|page| page["lineage_id"].as_str().map(str::to_owned)),
        });
        self
    }
}

#[async_trait]
impl session_resolver::ProviderRunner for PagesRunner {
    async fn call_for_identity(
        &self,
        _route: &crate::route_targets::SessionRunnerRoute,
        identity: &session_resolver::RunnerBindIdentity,
        method: &str,
        params: Value,
        budget: Duration,
    ) -> Result<Value, SessionResolveError> {
        self.call(
            &identity.project_root,
            &identity.session,
            method,
            params,
            budget,
        )
        .await
    }

    async fn call(
        &self,
        _: &Path,
        _: &str,
        method: &str,
        params: Value,
        _: Duration,
    ) -> Result<Value, SessionResolveError> {
        if method == "role.describe" {
            return Ok(self.describe.clone());
        }
        if method == "session.head" {
            return Ok(self.head.clone());
        }
        if method != "session.read" {
            return Err(SessionResolveError::InvalidResponse(format!(
                "the offline first pass serves session.read and role.describe only, not {method}"
            )));
        }
        // The export holds descriptors-mode pages, so only a descriptors-mode
        // read may be answered from it.
        if params["media"] != "descriptors" {
            return Err(SessionResolveError::InvalidResponse(
                "the offline pages answer descriptors-mode reads only".into(),
            ));
        }
        let from = params["from_ordinal"].as_u64().ok_or_else(|| {
            SessionResolveError::InvalidResponse("offline reads are range reads".into())
        })?;
        let Some(served) = self
            .pages
            .iter()
            .find(|page| page.first <= from && from <= page.last)
        else {
            return Err(SessionResolveError::InvalidResponse(format!(
                "no exported page holds ordinal {from}"
            )));
        };
        let mut page: cortexkit_role_llm_runner::read::ReadPage =
            serde_json::from_str(&served.line)
                .map_err(|error| SessionResolveError::InvalidResponse(error.to_string()))?;
        if params["lineage_id"]
            .as_str()
            .is_some_and(|held| Some(held) != page.lineage_id.as_deref())
        {
            return Err(SessionResolveError::InvalidResponse(
                "lineage_changed".into(),
            ));
        }
        page.messages.retain(|message| message.ordinal >= from);
        serde_json::to_value(&page)
            .map_err(|error| SessionResolveError::InvalidResponse(error.to_string()))
    }
}

/// The offline run publishes nothing; Setup only needs a publisher to exist.
struct NullPublisher;

#[async_trait]
impl Publisher for NullPublisher {
    async fn publish(&self, _: &notice::ViewReady) -> Result<(), HandlerOutcome> {
        Ok(())
    }
}

/// The identity a moved session will be set up under live: the route's
/// project root and runner module, and the exact Setup request the runner
/// will send.
#[derive(Clone, Debug)]
pub(crate) struct OfflineSetup {
    pub project_root: PathBuf,
    pub runner_module: String,
    /// The runner's `role.describe` answer the export came with.
    pub runner_describe: Value,
    pub request: compact::setup::SetupRequest,
}

/// What one offline run did.
#[derive(Debug)]
pub(crate) enum OfflineOutcome {
    /// The first pass ran and its state was stored with its proof.
    Prepared(OfflineReport),
    /// A rerun found the same proof, Setup and inputs; nothing was written.
    Unchanged(OfflineReport),
}

#[derive(Debug)]
pub(crate) struct OfflineReport {
    pub reference: String,
    pub generation: u64,
    pub proof: EntryInputProof,
    pub published_views: usize,
    pub certified: bool,
}

/// Why an offline run stopped.
#[derive(Debug)]
pub(crate) enum OfflineError {
    /// A named refusal; nothing of this run was adopted.
    Refused(&'static str, String),
    /// A write or read failed part-way; see the CLI for what that leaves.
    Interrupted(String),
}

fn interrupted(error: HandlerOutcome) -> OfflineError {
    match error {
        HandlerOutcome::Error { code, message }
        | HandlerOutcome::ErrorWithDetail { code, message, .. }
            if code == PROTOCOL_ERROR || code == "invalid_params" =>
        {
            OfflineError::Refused("first_pass_refused", format!("{code}: {message}"))
        }
        other => OfflineError::Interrupted(format!("{other:?}")),
    }
}

/// A workspace membership as text with a fixed order: its display-name map
/// has no order of its own, so it is sorted first.
fn membership_text(membership: Option<&mc_store::WorkspaceMembership>) -> String {
    membership.map_or_else(
        || "none".to_owned(),
        |membership| {
            let names = membership
                .display_name_by_path
                .iter()
                .collect::<BTreeMap<_, _>>();
            format!(
                "{:?}|{:?}|{:?}|{names:?}",
                membership.union_identities, membership.own_identity, membership.share_categories
            )
        },
    )
}

impl McHandler {
    /// Digest of everything the first pass reads that is neither the held
    /// transcript nor the Setup request, as the store and filesystem hold it
    /// now. The offline run records it after its pass; the live check
    /// recomputes it, so any change in between discards the stored pass. The
    /// inputs are:
    /// - the effective configuration of the project root (its `Debug` form;
    ///   every map in it is ordered);
    /// - the route's project identity and whether its memory is paused;
    /// - the project docs' canonical hash when `inject_docs` is on;
    /// - the m1 revision snapshot: workspace membership, compartment sequence,
    ///   note status, project memory epoch, m0 mutation head, history revision
    ///   and the user profile version;
    /// - the memory render snapshot (rows, revisions, watermark), without its
    ///   expiry cutoff, which is the reading time;
    /// - the active user profile rows;
    /// - the namespace's queued agent drops.
    fn offline_inputs_digest(&self, state: &State) -> Result<String, HandlerOutcome> {
        let store = self
            .store
            .get()
            .ok_or_else(|| transient("store unavailable"))?;
        let binding = self.async_binding(state);
        let route = self.route_project(0, store, &binding)?;
        let namespace = state.namespace();
        let now = now_ms();
        let mut hash = Sha256::new();
        let mut field = |name: &str, value: &str| {
            framed(&mut hash, name.as_bytes());
            framed(&mut hash, value.as_bytes());
        };
        field("mc-offline-inputs", "v1");
        field("config", &format!("{:?}", binding.config));
        field(
            "route",
            &format!("{:?}|{:?}", route.key, route.memory_paused),
        );
        let docs = if binding.config.inject_docs {
            crate::project_docs::read_project_docs_canonical(
                &binding.project_root.to_string_lossy(),
            )
            .canonical_hash
        } else {
            "off".to_owned()
        };
        field("project_docs", &docs);
        let m1 = store
            .load_m1_revision_snapshot(
                &route.key,
                &route.key,
                &namespace,
                binding.config.memory_enabled,
                now,
            )
            .map_err(transient)?;
        field("membership", &membership_text(m1.membership.as_ref()));
        field(
            "m1_revision",
            &format!(
                "{}|{}|{}|{}|{:?}|{}",
                m1.max_compartment_seq,
                m1.note_status_version,
                m1.project_memory_epoch,
                m1.m0_mutation_head,
                m1.compartment_history_revision,
                m1.user_profile_version
            ),
        );
        let mut memory = store
            .load_memory_render_snapshot(&route.key, m1.membership.as_ref(), now)
            .map_err(transient)?;
        memory.revision.expiry_cutoff_ms = 0;
        field(
            "memories",
            &format!(
                "{:?}|{:?}|{:?}|{}",
                memory.memories, memory.revision, memory.revisions, memory.fragment_watermark
            ),
        );
        field(
            "user_profile",
            &format!(
                "{:?}",
                store.load_active_user_memories().map_err(transient)?
            ),
        );
        let drops = store
            .load_pending_agent_drops(&namespace)
            .map_err(transient)?
            .into_iter()
            .map(|drop| (drop.target_id, drop.queued_at_ms))
            .collect::<Vec<_>>();
        field("pending_drops", &format!("{drops:?}"));
        Ok(hex(&hash.finalize()))
    }

    /// Read the retained transcript again from the checkpoint through the ordinary
    /// read, beside the held entries, and return the proof of the served
    /// entries `[origin, end)`, or `None` when the runner no longer serves all of
    /// them. The held entries and the record are left as they were.
    async fn served_entry_proof(
        &self,
        state: &mut State,
        lineage: &str,
        origin: u64,
        end: u64,
        budget: Duration,
    ) -> Result<Option<EntryInputProof>, HandlerOutcome> {
        let held = std::mem::take(&mut state.entries);
        let cadence = state.reminder_cadence.take();
        let held_lineage = state.lineage.clone();
        let read = self.read_async(state, origin, budget).await;
        let served = std::mem::replace(&mut state.entries, held);
        state.reminder_cadence = cadence;
        state.lineage = held_lineage;
        read?;
        let codec = codec::Codec::from_params(&Value::Object(state.setup.params.clone()))?;
        EntryInputProof::of(&served, lineage, origin, Some(end), codec)
    }

    /// Adopt or discard an offline-prepared record on its first live notice;
    /// see the module documentation. Returns the record the notice continues
    /// with.
    pub(super) async fn settle_offline_first_pass(
        &self,
        mut state: State,
        store: &McStore,
        headers: &BTreeMap<String, String>,
    ) -> Result<State, HandlerOutcome> {
        if adopted(&state) {
            return Ok(state);
        }
        if state.standalone_move.is_some() && !prepared(&state) {
            return Err(unprepared());
        }
        let Some(offline) = state.offline_first_pass.clone() else {
            return Ok(state);
        };
        if !proof_version_matches(&state) {
            return Err(error(
                "offline_proof_version",
                "rerun `ck-mc offline first-pass` before live adoption",
            ));
        }
        let reason = match &offline.proof {
            None => Some("offline_run_incomplete"),
            Some(proof)
                if headers
                    .get("lineage_id")
                    .is_some_and(|lineage| *lineage != proof.lineage) =>
            {
                Some("lineage_differs")
            }
            Some(_) if offline.inputs != Some(self.offline_inputs_digest(&state)?) => {
                Some("inputs_differ")
            }
            // Checked at Setup too; checked again here so adoption never
            // depends on a Setup having arrived first.
            Some(_)
                if describe_mismatch(
                    &state,
                    &self
                        .runner_describe(&state.runner()?, &state.runner_identity())
                        .await?,
                )
                .is_some() =>
            {
                Some("runner_describe_differs")
            }
            Some(proof) => {
                let served = self
                    .served_entry_proof(
                        &mut state,
                        &proof.lineage,
                        proof.origin,
                        proof.end,
                        VERIFY_READ_BUDGET,
                    )
                    .await?;
                (served.as_ref() != Some(proof)).then_some("entries_differ")
            }
        };
        let reference = state.reference();
        let Some(reason) = reason else {
            if let Some(marker) = &mut state.offline_first_pass {
                marker.state = PreparationState::Adopted;
            }
            tracing::info!(session_ref = %reference, entries = offline.proof.as_ref().map_or(0, |proof| proof.count), "offline_first_pass_adopted");
            return Ok(state);
        };
        log_discard(&reference, reason);
        let moved = match moved_session::setup_fence(
            store,
            &state.setup.harness,
            &state.setup.session,
            &state.setup.request_id,
        )? {
            moved_session::Fence::Moved(record) => Some(*record),
            moved_session::Fence::Fresh => None,
            moved_session::Fence::Refuse(answer) => {
                return Err(error(
                    PROTOCOL_ERROR,
                    format!("offline first pass discarded, and setup refuses: {answer}"),
                ))
            }
        };
        let binding = self.async_binding(&state);
        let generation = state
            .generation
            .checked_add(1)
            .ok_or_else(|| transient("async generation exhausted"))?;
        let mut fresh = self.new_async_record(
            0,
            &binding,
            &state.setup,
            state.key.clone(),
            moved,
            RecordStart {
                generation,
                preparation: None,
            },
        )?;
        // The runner already holds the prepared Setup bytes. Reconciliation
        // may publish a new view, but cannot rewrite that lineage's answer.
        fresh.initial = state.initial.clone();
        let mut adopted = offline;
        adopted.state = PreparationState::Adopted;
        fresh.offline_first_pass = Some(adopted);
        fresh.forget_discarded_rows();
        self.resident_cache().forget(&reference);
        fresh.save(store, &[])?;
        store
            .retire_unannounced_async_views(&reference)
            .map_err(transient)?;
        Ok(fresh)
    }

    /// Run the moved session's first pass offline, through the ordinary lane,
    /// against the pages `self.provider_runner` serves, and store it with its
    /// proof. The handler must have its store open; its runner must be a
    /// [`PagesRunner`]. A rerun on a compatible proof writes nothing: it answers
    /// `Unchanged` when the proof, Setup, runner description and inputs match.
    /// An incomplete or incompatible unadopted moved-session preparation is
    /// restarted in a fresh generation; a notice's durable adoption cannot be replaced.
    pub(crate) async fn offline_first_pass(
        &self,
        setup: &OfflineSetup,
    ) -> Result<OfflineOutcome, OfflineError> {
        let store = self
            .store
            .get()
            .ok_or_else(|| OfflineError::Interrupted("store unavailable".into()))?;
        {
            let mut publisher = self
                .provider_store
                .async_runtime
                .publisher
                .lock()
                .expect("async publisher");
            if publisher.is_none() {
                *publisher = Some(Arc::new(NullPublisher));
            }
        }
        let request = &setup.request;
        let binding = SessionBinding {
            principal: Some(subc_protocol::Principal::Reserved {
                module_id: setup.runner_module.clone(),
            }),
            scope: None,
            project_root: setup.project_root.clone(),
            harness: request.harness.clone(),
            session: request.session.clone(),
            model_key: None,
            config: self.effective_config(&setup.project_root),
            history_budget_tokens: 4_000.0,
        };
        self.bind_route(OFFLINE_CHANNEL, binding.clone());
        let key = Key::new(&binding, &request.session, &request.harness).map_err(interrupted)?;
        let reference = key.reference();
        let setup_digest =
            setup_identity_digest(request, &setup.runner_module).map_err(interrupted)?;
        let describe_digest =
            runner_describe_digest(&setup.runner_describe).map_err(interrupted)?;
        let marker = OfflineFirstPass {
            version: MARKER_VERSION,
            state: PreparationState::Preparing,
            bound_generation: None,
            setup: setup_digest.clone(),
            describe: Some(describe_digest.clone()),
            inputs: None,
            proof: None,
        };
        if let Some(old) = load_head(store, &reference).map_err(interrupted)? {
            if proof_version_matches(&old) {
                if let Some(outcome) = self
                    .offline_rerun(store, &key, &reference, &setup_digest, &describe_digest)
                    .await?
                {
                    return Ok(outcome);
                }
            }
            // Only the provider's unadopted preparation is replaced. Re-import
            // and re-bind in a fresh namespace, leaving the move record intact.
            let _serial = self.provider_serial.lock_for(&key).await;
            let moved =
                match moved_session::setup_fence(
                    store,
                    &request.harness,
                    &request.session,
                    &request.request_id,
                )
                .map_err(interrupted)?
                {
                    moved_session::Fence::Moved(record) => Some(*record),
                    _ => return Err(OfflineError::Refused(
                        "session_not_moved",
                        "rerun `ck-mc offline first-pass` with the authoritative move checkpoint"
                            .into(),
                    )),
                };
            let generation = old
                .generation
                .checked_add(1)
                .ok_or_else(|| OfflineError::Interrupted("async generation exhausted".into()))?;
            // Validate the runner before replacing a preparation. An unsupported
            // description must not leave a new partial record behind.
            if let Some(refusal) = self
                .refuse_checkpoint_unsupported(
                    moved.as_ref().map(moved_session::checkpoint).as_ref(),
                    CheckpointSource::StandaloneMove,
                    &old.runner().map_err(interrupted)?,
                    &old.runner_identity(),
                    &request.request_id,
                    Some(setup.runner_describe.clone()),
                )
                .await
                .map_err(interrupted)?
            {
                return Err(OfflineError::Refused(
                    "setup_refused",
                    format!("Setup answered {refusal:?}"),
                ));
            }
            let mut fresh = self
                .new_async_record(
                    OFFLINE_CHANNEL,
                    &binding,
                    request,
                    key.clone(),
                    moved,
                    RecordStart {
                        generation,
                        preparation: Some(marker.clone()),
                    },
                )
                .map_err(interrupted)?;
            fresh.forget_discarded_rows();
            self.resident_cache().forget(&reference);
            fresh.save(store, &[]).map_err(interrupted)?;
            store
                .retire_unannounced_async_views(&reference)
                .map_err(|e| OfflineError::Interrupted(e.to_string()))?;
        }
        let answer = self
            .async_setup_inner(
                OFFLINE_CHANNEL,
                &binding,
                &serde_json::to_value(request)
                    .map_err(|e| OfflineError::Interrupted(e.to_string()))?,
                Some(marker),
            )
            .await
            .map_err(interrupted)?;
        let answer: Value = serde_json::from_slice(&answer)
            .map_err(|e| OfflineError::Interrupted(e.to_string()))?;
        if answer["code"] == contract::errors::refuse_codes::TAG_CHECKPOINT_UNSUPPORTED {
            return Err(OfflineError::Refused(
                contract::errors::refuse_codes::TAG_CHECKPOINT_UNSUPPORTED,
                format!(
                    "the runner_describe does not declare tag_checkpoint; Setup answered {answer}"
                ),
            ));
        }
        if answer["answer"] != "ready" {
            return Err(OfflineError::Refused(
                "setup_refused",
                format!("Setup answered {answer}"),
            ));
        }
        let _serial = self.provider_serial.lock_for(&key).await;
        let mut state = self
            .checkout(store, &reference)
            .map_err(interrupted)?
            .ok_or_else(|| OfflineError::Interrupted("the record Setup made is gone".into()))?;
        #[cfg(test)]
        interrupt_preparation("after_setup", &mut state, store).map_err(interrupted)?;
        let codec = codec::Codec::from_params(&Value::Object(state.setup.params.clone()))
            .map_err(interrupted)?;
        let origin = proof_origin(&state);
        match self
            .read_async_resumable(&mut state, origin, OFFLINE_READ_BUDGET)
            .await
            .map_err(interrupted)?
        {
            ReadProgress::Complete => {}
            // `parse_pages` refuses a page without a lineage, so the export
            // cannot serve the runner's page for a session it never wrote.
            ReadProgress::NeverWritten => {
                return Err(OfflineError::Refused(
                    "pages_not_chained",
                    "the pages name no lineage".into(),
                ))
            }
            ReadProgress::Incomplete { next } => {
                return Err(OfflineError::Interrupted(format!(
                    "the page read stopped at ordinal {next}"
                )))
            }
        }
        let (last_ordinal, last) = state
            .entries
            .last_key_value()
            .map(|(ordinal, entry)| Ok::<_, HandlerOutcome>((*ordinal, entry.read()?)))
            .transpose()
            .map_err(interrupted)?
            .ok_or_else(|| {
                OfflineError::Refused("pages_not_chained", "no entry was read".into())
            })?;
        let lineage = state.lineage.clone().unwrap_or_default();
        // The conditions of the pass: the Setup's model and window, and no
        // measured usage yet. The first live notice replaces them.
        let notice = notice::AdvanceNotice::new(
            &reference,
            1,
            lineage.clone(),
            last_ordinal,
            served_digest(&last).map_err(interrupted)?,
            0,
            request.model.clone(),
        );
        let notice = match request.context_window {
            Some(window) => notice.with_window(window),
            None => notice,
        };
        let mut headers = notice.to_headers();
        headers.insert("lineage_id".into(), lineage.clone());
        state.conditions = Some(headers);
        state.ingest_read(store, codec).map_err(interrupted)?;
        #[cfg(test)]
        interrupt_preparation("after_binding", &mut state, store).map_err(interrupted)?;
        self.advance_async_policy(&mut state, &notice, codec)
            .map_err(interrupted)?;
        let view = self
            .publish_async(0, &mut state, codec, false)
            .map_err(interrupted)?;
        if view.is_none() && state.standalone_move.is_some() {
            return Err(OfflineError::Interrupted(
                "the pass produced no prepared view".into(),
            ));
        }
        state.engine_failed = false;
        let proof = EntryInputProof::of(&state.entries, &lineage, origin, None, codec)
            .map_err(interrupted)?
            .ok_or_else(|| {
                OfflineError::Refused(
                    "pages_not_chained",
                    format!("the held entries do not cover the retained interval from {origin}"),
                )
            })?;
        let inputs = self.offline_inputs_digest(&state).map_err(interrupted)?;
        if let Some(offline) = &mut state.offline_first_pass {
            offline.state = PreparationState::Prepared;
            offline.inputs = Some(inputs);
            offline.proof = Some(proof.clone());
        }
        // Store the exact published view as the live lineage's Setup answer.
        // Only this proof commit may replace the offline head insertion.
        if let Some(view) = view {
            let held = state
                .entries
                .iter()
                .map(|(ordinal, entry)| (*ordinal, Arc::clone(entry)))
                .collect();
            let mut replacement = Vec::<Value>::new();
            for range in &view.ranges {
                match range {
                    view::ViewRange::Replace { bytes, .. } => {
                        replacement.extend(
                            serde_json::from_str::<Vec<Value>>(bytes)
                                .map_err(|e| OfflineError::Interrupted(e.to_string()))?,
                        );
                    }
                    view::ViewRange::Keep { from, to, .. } if from < to => {
                        replacement.extend(
                            cut_runtime::render_retained_rows(&held, &view, *from, *to - 1)
                                .map_err(interrupted)?,
                        );
                    }
                    view::ViewRange::Keep { .. } => {}
                    _ => {
                        return Err(OfflineError::Interrupted(
                            "unknown prepared view range".into(),
                        ))
                    }
                }
            }
            state.initial["initial"]["range"] = json!({"from":origin,"to":proof.end});
            state.initial["initial"]["replacement"] = json!(replacement);
        }
        // The commit point: the record, its certificate and its proof in one
        // save.
        state.save(store, &[]).map_err(interrupted)?;
        let report = OfflineReport {
            reference,
            generation: state.generation,
            proof,
            published_views: state.published_engine.len(),
            certified: state.logical_prefix.is_some(),
        };
        self.checkin(state);
        Ok(OfflineOutcome::Prepared(report))
    }

    /// A rerun on a record that already exists: unchanged when this command
    /// prepared it from the same pages, Setup, runner description and inputs.
    /// `None` asks the command to restart an unadopted moved-session preparation.
    /// This check writes nothing; non-moved live records retain their refusal behaviour.
    async fn offline_rerun(
        &self,
        store: &McStore,
        key: &Key,
        reference: &str,
        setup_digest: &str,
        describe_digest: &str,
    ) -> Result<Option<OfflineOutcome>, OfflineError> {
        let _serial = self.provider_serial.lock_for(key).await;
        let mut state = self
            .checkout(store, reference)
            .map_err(interrupted)?
            .ok_or_else(|| OfflineError::Interrupted("the record disappeared".into()))?;
        let Some(offline) = state.offline_first_pass.clone() else {
            if state.standalone_move.is_some() {
                return Ok(None);
            }
            return Err(OfflineError::Refused(
                "async_record_exists",
                "ck-mc already holds a live record for this session; its first pass is not offline work any more".into(),
            ));
        };
        if offline.state == PreparationState::Adopted {
            return Err(OfflineError::Refused(
                "offline_already_adopted",
                "a live notice already adopted this session; offline preparation cannot replace it"
                    .into(),
            ));
        }
        let restartable = state.standalone_move.is_some();
        if restartable && offline.state == PreparationState::Preparing {
            return Ok(None);
        }
        let Some(proof) = offline.proof.clone() else {
            if restartable {
                return Ok(None);
            }
            return Err(OfflineError::Refused(
                "offline_run_incomplete",
                "an earlier run stopped before its last save; restore the window's backups and rerun `ck-mc offline first-pass`".into(),
            ));
        };
        if offline.setup != setup_digest {
            if restartable {
                return Ok(None);
            }
            return Err(OfflineError::Refused(
                "offline_state_differs",
                "the stored first pass was prepared under another Setup".into(),
            ));
        }
        if offline.describe.as_deref() != Some(describe_digest) {
            if restartable {
                return Ok(None);
            }
            return Err(OfflineError::Refused(
                "offline_state_differs",
                "the stored first pass was prepared against another runner_describe".into(),
            ));
        }
        let served = self
            .served_entry_proof(
                &mut state,
                &proof.lineage,
                proof.origin,
                proof.end,
                OFFLINE_READ_BUDGET,
            )
            .await
            .map_err(interrupted)?;
        if served.as_ref() != Some(&proof) {
            if restartable {
                return Ok(None);
            }
            return Err(OfflineError::Refused(
                "offline_state_differs",
                "the stored first pass was prepared from other pages".into(),
            ));
        }
        let inputs = self.offline_inputs_digest(&state).map_err(interrupted)?;
        if offline.inputs.as_deref() != Some(inputs.as_str()) {
            if restartable {
                return Ok(None);
            }
            return Err(OfflineError::Refused(
                "offline_state_differs",
                "the configuration or store inputs changed since the stored first pass".into(),
            ));
        }
        let report = OfflineReport {
            reference: reference.to_owned(),
            generation: state.generation,
            proof,
            published_views: state.published_engine.len(),
            certified: state.logical_prefix.is_some(),
        };
        // The resident copy was only read; the store still holds its record.
        self.checkin(state);
        Ok(Some(OfflineOutcome::Unchanged(report)))
    }
}
