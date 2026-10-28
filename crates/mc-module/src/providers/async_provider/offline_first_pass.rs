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
//! The last save of that run stores [`OfflineFirstPass`] on the record with an
//! entry input proof over every held entry. The proof covers the entry's
//! ordinal, the runner's served content digest, the digest of its whole served
//! form, and each part's key, tag and served digest. Page boundaries are not
//! part of it. The same save also persists the certificate, its input proof
//! and the published view.
//!
//! While the marker is on the record, rides answer nothing and its views are
//! not announced. The first live notice then checks it once
//! (`settle_offline_first_pass`):
//! - **adopt:** the transcript the runner serves now, and every other input of
//!   the pass, match what was proven. The marker is cleared and the notice
//!   continues on the stored state, so its certificate is used as on any
//!   later notice;
//! - **discard:** anything differs. The record is replaced by a fresh one, set
//!   up by the same code a first Setup runs, in the next generation (an empty
//!   engine namespace). The old record's held entries, published engine forms
//!   and native edits are deleted in the same save. The notice then runs the
//!   ordinary first pass.
//!
//! A live Setup that differs from the one the run was prepared under discards
//! the same way (`setup_mismatch`, called from `async_setup`), and so does a
//! live runner whose `role.describe` differs from the one the run read
//! (`describe_mismatch`, at that Setup and again at the first notice).
use super::*;
use std::path::PathBuf;

/// Version of the [`OfflineFirstPass`] marker's shape. Version 2 proves the
/// runner's served digests and records the runner's `role.describe`.
const MARKER_VERSION: u32 = 2;
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

/// Stored on a record `ck-mc offline first-pass` prepared, until the first
/// live notice adopts or discards it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub(crate) struct OfflineFirstPass {
    pub version: u32,
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

/// A digest over the held entries `0..count` of one lineage.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub(crate) struct EntryInputProof {
    pub lineage: String,
    pub count: u64,
    pub digest: String,
}

fn framed(hash: &mut Sha256, bytes: &[u8]) {
    hash.update((bytes.len() as u64).to_le_bytes());
    hash.update(bytes);
}

impl EntryInputProof {
    /// The proof over the held entries `0..count` (every held entry for
    /// `None`), or `None` when those ordinals are not all held. Each entry
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
        count: Option<u64>,
        codec: codec::Codec,
    ) -> Result<Option<Self>, HandlerOutcome> {
        let count = match count {
            Some(count) => count,
            None => entries.last_key_value().map_or(0, |(last, _)| last + 1),
        };
        let mut hash = Sha256::new();
        framed(&mut hash, b"mc-offline-entry-proof/v2");
        framed(&mut hash, lineage.as_bytes());
        for ordinal in 0..count {
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
            count,
            digest: hex(&hash.finalize()),
        }))
    }
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
    let offline = state.offline_first_pass.as_ref()?;
    if offline.version != MARKER_VERSION {
        return Some("marker_version_differs");
    }
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
}

/// One exported page: its first and last ordinals and its line.
pub(crate) struct ServedPage {
    pub first: u64,
    pub last: u64,
    pub line: String,
}

impl PagesRunner {
    pub(crate) fn new(pages: Vec<ServedPage>, describe: Value) -> Self {
        Self { pages, describe }
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
            // Exported first-pass pages describe an uncut lineage. No pre-cut
            // facts may be inferred from their first page's position.
            return Ok(json!({"first_ordinal":0}));
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

    /// Read the whole transcript again from ordinal 0 through the ordinary
    /// read, beside the held entries, and return the proof of the served
    /// entries `0..count`, or `None` when the runner no longer serves all of
    /// them. The held entries and the record are left as they were.
    async fn served_entry_proof(
        &self,
        state: &mut State,
        lineage: &str,
        count: u64,
        budget: Duration,
    ) -> Result<Option<EntryInputProof>, HandlerOutcome> {
        let held = std::mem::take(&mut state.entries);
        let cadence = state.reminder_cadence.take();
        let held_lineage = state.lineage.clone();
        let read = self.read_async(state, 0, budget).await;
        let served = std::mem::replace(&mut state.entries, held);
        state.reminder_cadence = cadence;
        state.lineage = held_lineage;
        read?;
        let codec = codec::Codec::from_params(&Value::Object(state.setup.params.clone()))?;
        EntryInputProof::of(&served, lineage, Some(count), codec)
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
        let Some(offline) = state.offline_first_pass.clone() else {
            return Ok(state);
        };
        let reason = match &offline.proof {
            None => Some("offline_run_incomplete"),
            Some(_) if offline.version != MARKER_VERSION => Some("marker_version_differs"),
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
                    .served_entry_proof(&mut state, &proof.lineage, proof.count, VERIFY_READ_BUDGET)
                    .await?;
                (served.as_ref() != Some(proof)).then_some("entries_differ")
            }
        };
        let reference = state.reference();
        let Some(reason) = reason else {
            state.offline_first_pass = None;
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
            generation,
        )?;
        if fresh.initial["initial"] != state.initial["initial"] {
            tracing::warn!(session_ref = %reference, "offline_first_pass_discarded: the rebuilt setup view differs from the one the runner holds");
        }
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
    /// [`PagesRunner`]. A rerun on a record this command already prepared
    /// writes nothing: it answers `Unchanged` when the proof, Setup and inputs
    /// are the same, and refuses `offline_state_differs` otherwise.
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
        if load_head(store, &reference).map_err(interrupted)?.is_some() {
            return self
                .offline_rerun(store, &key, &reference, &setup_digest, &describe_digest)
                .await;
        }
        let answer = self
            .async_setup(
                OFFLINE_CHANNEL,
                &binding,
                &serde_json::to_value(request)
                    .map_err(|e| OfflineError::Interrupted(e.to_string()))?,
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
        // The marker goes in before the pass: a run stopped before its last
        // save leaves a record the live check discards rather than adopts.
        state.offline_first_pass = Some(OfflineFirstPass {
            version: MARKER_VERSION,
            setup: setup_digest,
            describe: Some(describe_digest),
            inputs: None,
            proof: None,
        });
        state.save(store, &[]).map_err(interrupted)?;
        let codec = codec::Codec::from_params(&Value::Object(state.setup.params.clone()))
            .map_err(interrupted)?;
        match self
            .read_async_resumable(&mut state, 0, OFFLINE_READ_BUDGET)
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
        self.advance_async_policy(&mut state, &notice, codec)
            .map_err(interrupted)?;
        self.publish_async(0, &mut state, codec, false)
            .map_err(interrupted)?;
        state.engine_failed = false;
        let proof = EntryInputProof::of(&state.entries, &lineage, None, codec)
            .map_err(interrupted)?
            .ok_or_else(|| {
                OfflineError::Refused(
                    "pages_not_chained",
                    "the held entries do not start at ordinal 0".into(),
                )
            })?;
        let inputs = self.offline_inputs_digest(&state).map_err(interrupted)?;
        if let Some(offline) = &mut state.offline_first_pass {
            offline.inputs = Some(inputs);
            offline.proof = Some(proof.clone());
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
    /// prepared it from the same pages, Setup and inputs; otherwise refused by
    /// name. Nothing is written either way.
    async fn offline_rerun(
        &self,
        store: &McStore,
        key: &Key,
        reference: &str,
        setup_digest: &str,
        describe_digest: &str,
    ) -> Result<OfflineOutcome, OfflineError> {
        let _serial = self.provider_serial.lock_for(key).await;
        let mut state = self
            .checkout(store, reference)
            .map_err(interrupted)?
            .ok_or_else(|| OfflineError::Interrupted("the record disappeared".into()))?;
        let Some(offline) = state.offline_first_pass.clone() else {
            return Err(OfflineError::Refused(
                "async_record_exists",
                "ck-mc already holds a live record for this session; its first pass is not offline work any more".into(),
            ));
        };
        let Some(proof) = offline.proof.clone() else {
            return Err(OfflineError::Refused(
                "offline_run_incomplete",
                "an earlier run stopped before its last save; restore the window's backups and run again, or start the apps and let the first live read run the ordinary first pass".into(),
            ));
        };
        if offline.setup != setup_digest {
            return Err(OfflineError::Refused(
                "offline_state_differs",
                "the stored first pass was prepared under another Setup".into(),
            ));
        }
        if offline.describe.as_deref() != Some(describe_digest) {
            return Err(OfflineError::Refused(
                "offline_state_differs",
                "the stored first pass was prepared against another runner_describe".into(),
            ));
        }
        let served = self
            .served_entry_proof(&mut state, &proof.lineage, proof.count, OFFLINE_READ_BUDGET)
            .await
            .map_err(interrupted)?;
        if served.as_ref() != Some(&proof) {
            return Err(OfflineError::Refused(
                "offline_state_differs",
                "the stored first pass was prepared from other pages".into(),
            ));
        }
        let inputs = self.offline_inputs_digest(&state).map_err(interrupted)?;
        if offline.inputs.as_deref() != Some(inputs.as_str()) {
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
        Ok(OfflineOutcome::Unchanged(report))
    }
}
