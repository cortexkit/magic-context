//! The store → m1 delta producer for bust arms, in TWO tiers (the
//! compose-on-opportunity discipline):
//!
//!  - [`m1_revision_signal`] is the CHEAP per-pass read: split in-session and external
//!    fingerprints run EVERY pass to tell the classifier whether work is pending and whether
//!    a render-config HARD is due, WITHOUT composing the body. In-session changes are allowed
//!    to remain pending so ordinary turns replay frozen bytes; external workspace changes stay
//!    eager-HARD.
//!  - [`compose_m1_from_store`] is the EXPENSIVE bust-only read: it composes the actual m1
//!    delta body (memory-updates + new-compartments + new-memories) from the store and
//!    reports whether a newly-published compartment EXTENDS coverage (so the bust must
//!    advance the boundary anchor). Runs ONLY on a bust opportunity — never on a defer (a
//!    defer replays the frozen m1 verbatim; re-composing from the now-possibly-mutated store
//!    on a defer would change bytes on a defer, violating the deferred-work invariant).

use std::collections::HashSet;
use std::hash::{Hash, Hasher};
use std::time::Instant;

use mc_store::RenderedCompartmentCoverage;
use mc_store::{McStore, McStoreError, ModuleMeta, StoredMemory};

use crate::compartment_coverage::{partition_by_folded_seq, resolve_coverage, CoverageGap};
use crate::decay_render::DecayRenderCompartment;
use crate::m0_compose::{trim_memories_to_budget, trim_user_profile_to_budget};
use crate::memory_render::{
    assemble_m1, render_memory_block, render_memory_updates, render_new_compartments,
    render_user_profile_block, workspace_source_names, M1_PLACEHOLDER,
};
use crate::stable_hash::StableSipHasher13;

const MAX_MERGE_REPLACEMENTS_PER_DELTA: usize = 10;

/// Why composing the SOFT m1 from the store failed.
#[derive(Debug)]
pub enum M1ComposeError {
    Store(McStoreError),
    /// Stored compartment ranges overlap or otherwise fail strict ordering.
    CoverageGap(CoverageGap),
}

impl std::fmt::Display for M1ComposeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            M1ComposeError::Store(e) => write!(f, "store: {e}"),
            M1ComposeError::CoverageGap(g) => write!(f, "{g}"),
        }
    }
}
impl std::error::Error for M1ComposeError {}
impl From<McStoreError> for M1ComposeError {
    fn from(e: McStoreError) -> Self {
        M1ComposeError::Store(e)
    }
}

/// The in-session m1 revision. Only inputs that m1 actually renders belong here: a watermark
/// that moves without changing m1 bytes would still count as pending m1 work, and at
/// execute-band usage pending work is enough to open a cache bust.
///
/// Smart notes are not rendered into m1, so the note status watermark is deliberately
/// absent. Its old slot in the v2 digest is hashed as a constant zero, which keeps every
/// session that never had a note status change on exactly the digest it already stored.
fn in_session_revision(
    max_memory_id: i64,
    max_memory_mutation_id: i64,
    max_compartment_seq: i64,
    user_profile_version: u64,
) -> u64 {
    digest_in_session_inputs(
        max_memory_id,
        max_memory_mutation_id,
        max_compartment_seq,
        0,
        user_profile_version,
    )
}

/// The digest older builds stored in `ModuleMeta::m1_revision`, which also hashed the note
/// status watermark. It exists only so a stored value from those builds can be recognised
/// as equivalent to the current revision; see
/// [`M1RevisionSignal::equivalent_applied_revision`].
fn in_session_revision_with_note_status(
    max_memory_id: i64,
    max_memory_mutation_id: i64,
    max_compartment_seq: i64,
    note_status_version: i64,
    user_profile_version: u64,
) -> u64 {
    digest_in_session_inputs(
        max_memory_id,
        max_memory_mutation_id,
        max_compartment_seq,
        note_status_version,
        user_profile_version,
    )
}

fn digest_in_session_inputs(
    max_memory_id: i64,
    max_memory_mutation_id: i64,
    max_compartment_seq: i64,
    note_status_version: i64,
    user_profile_version: u64,
) -> u64 {
    let mut in_session = StableSipHasher13::new();
    // Preserve the old digest format when both new inputs are zero, so sessions created
    // before these inputs existed do not appear changed solely because the signal gained fields.
    if note_status_version == 0 && user_profile_version == 0 {
        "mc-m1-rev-v1".hash(&mut in_session);
        max_memory_id.hash(&mut in_session);
        max_memory_mutation_id.hash(&mut in_session);
        max_compartment_seq.hash(&mut in_session);
    } else {
        "mc-m1-in-session-v2".hash(&mut in_session);
        max_memory_id.hash(&mut in_session);
        max_memory_mutation_id.hash(&mut in_session);
        max_compartment_seq.hash(&mut in_session);
        note_status_version.hash(&mut in_session);
        user_profile_version.hash(&mut in_session);
    }
    in_session.finish() | 1
}

/// The cheap per-pass revision signal, split into two lanes:
///
/// * `revision` is the IN-SESSION lane. Memory inserts/updates, the mutation log,
///   profile-version lines, and ordinary compartment publication all become pending work.
///   Note status changes do not: m1 renders nothing about notes. A mismatch is intentionally deferred until an independent render.
/// * `external_revision` is the EXTERNAL lane. Workspace membership/visibility changes,
///   the project memory epoch and the session's m0 mutation-log head all remain
///   eager-HARD because they change the m0 baseline.
///
/// This table is the ordering contract for the module's bust opportunity gate:
///
/// | input | lane | no independent render | independent render |
/// | memory/profile/compartment signal | in-session | defer, preserve frozen bytes | fold in HARD/SOFT |
/// | workspace fingerprint | external | HARD | HARD |
/// | project memory epoch | external | HARD on next pass | HARD |
/// | flush/refresh, Force/Emergency, first reduction | opportunity | fold pending delta | fold pending delta |
///
/// The signal only identifies pending work; it never authorizes a bust by itself. This is the
/// deferred-work invariant: a provider cache must not be invalidated merely because a store
/// watermark moved between ordinary turns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct M1RevisionSignal {
    /// Applied-revision comparison for the in-session lane.
    pub revision: u64,
    /// External workspace lane; changes route to HARD, never SOFT.
    pub external_revision: u64,
    pub history_revision: u64,
    /// Highest compartment sequence read while computing `revision`.
    pub max_compartment_seq: i64,
    pub max_memory_id: i64,
    pub max_memory_mutation_id: i64,
    /// Read for [`Self::legacy_note_revision`] only; it does not feed `revision`.
    pub note_status_version: i64,
    pub user_profile_version: u64,
    /// The digest an older build would have stored for these same inputs, when it differs
    /// from `revision` (that is, when the note status watermark is non-zero).
    pub legacy_note_revision: Option<u64>,
}

impl M1RevisionSignal {
    /// The applied revision a pass should compare `revision` against.
    ///
    /// Builds that still hashed the note status watermark stored a digest that differs from
    /// `revision` whenever a project has any note status history. Comparing it directly would
    /// report pending m1 work that renders nothing, and at execute-band usage that alone opens
    /// a cache bust. When the stored value equals the old digest of the current store inputs,
    /// nothing m1 renders has moved since it was applied, so it is equivalent to `revision`.
    /// Any other stored value is returned unchanged and keeps its ordinary meaning.
    pub fn equivalent_applied_revision(&self, applied: u64) -> u64 {
        if self.legacy_note_revision == Some(applied) {
            self.revision
        } else {
            applied
        }
    }
}

pub fn m1_revision_signal(
    store: &McStore,
    project_path: &str,
    session_id: &str,
) -> Result<u64, McStoreError> {
    Ok(m1_revision_signal_parts(store, project_path, session_id)?.revision)
}

pub fn m1_revision_signal_parts(
    store: &McStore,
    project_path: &str,
    session_id: &str,
) -> Result<M1RevisionSignal, McStoreError> {
    m1_revision_signal_parts_for_pass(store, project_path, project_path, session_id, 0, true, 0)
}

/// Query-family timings for the lightweight per-pass m1 revision signal.
#[derive(Debug, Clone, Copy, Default)]
pub struct M1RevisionReadTimings {
    pub memories_ms: f64,
    pub notes_ms: f64,
}

/// Read both signal lanes for a transform pass. The extra context is supplied by the
/// already-loaded transform route so profile changes are covered without rendering.
pub fn m1_revision_signal_parts_for_pass(
    store: &McStore,
    project_path: &str,
    note_project_path: &str,
    session_id: &str,
    user_profile_version: u64,
    memory_enabled: bool,
    now_ms: i64,
) -> Result<M1RevisionSignal, McStoreError> {
    m1_revision_signal_parts_for_pass_timed(
        store,
        project_path,
        note_project_path,
        session_id,
        user_profile_version,
        memory_enabled,
        now_ms,
        None,
    )
}

/// The timed variant keeps the established revision bytes while exposing the memory and note
/// query families that every transform pass reads before its scheduler decision.
#[allow(clippy::too_many_arguments)]
pub fn m1_revision_signal_parts_for_pass_timed(
    store: &McStore,
    project_path: &str,
    note_project_path: &str,
    session_id: &str,
    user_profile_version: u64,
    memory_enabled: bool,
    now_ms: i64,
    timings: Option<&mut M1RevisionReadTimings>,
) -> Result<M1RevisionSignal, McStoreError> {
    let snapshot_started_at = Instant::now();
    let snapshot = store.load_m1_revision_snapshot(
        project_path,
        note_project_path,
        session_id,
        memory_enabled,
        now_ms,
    )?;
    let snapshot_ms = snapshot_started_at.elapsed().as_secs_f64() * 1_000.0;
    if let Some(timings) = timings {
        // The store deliberately keeps these reads in one transaction, so report the complete
        // snapshot cost under the existing memory family rather than timing fictitious subreads.
        timings.memories_ms += snapshot_ms;
    }

    let max_memory_id = snapshot.max_memory_id;
    let max_memory_mutation_id = snapshot.max_memory_mutation_id;
    let max_compartment_seq = snapshot.max_compartment_seq;
    let note_status_version = snapshot.note_status_version;
    let revision = in_session_revision(
        max_memory_id,
        max_memory_mutation_id,
        max_compartment_seq,
        user_profile_version,
    );
    let legacy_note_revision = (note_status_version != 0).then(|| {
        in_session_revision_with_note_status(
            max_memory_id,
            max_memory_mutation_id,
            max_compartment_seq,
            note_status_version,
            user_profile_version,
        )
    });

    let workspace_fingerprint =
        store.workspace_fingerprint_for_membership(snapshot.membership.as_ref());
    let mut external = StableSipHasher13::new();
    "mc-m1-external-v2".hash(&mut external);
    workspace_fingerprint.hash(&mut external);
    // Both are baseline changes a host makes in context.db: an identity or workspace move
    // bumps the project's memory epoch, and an in-place compartment rewrite (a recomp, a
    // revert) appends to the session's m0 mutation log. Either one needs the next pass to
    // rebuild m0, which is what a changed external revision asks for.
    snapshot.project_memory_epoch.hash(&mut external);
    snapshot.m0_mutation_head.hash(&mut external);
    // External SQL repairs can bypass m0_mutation_log. Their update counter makes
    // changed summary text rebuild the frozen m0 prompt prefix even if coordinates
    // and text lengths are unchanged. Migration-seeded histories also validate once.
    if let Some(revision) = &snapshot.compartment_history_revision {
        revision.hash(&mut external);
    }

    Ok(M1RevisionSignal {
        revision,
        external_revision: external.finish() | 1,
        history_revision: if snapshot.compartment_history_revision.is_none()
            && snapshot.m0_mutation_head == 0
        {
            0
        } else {
            let mut history = StableSipHasher13::new();
            snapshot.compartment_history_revision.hash(&mut history);
            snapshot.m0_mutation_head.hash(&mut history);
            history.finish() | 1
        },
        max_compartment_seq,
        max_memory_id,
        max_memory_mutation_id,
        note_status_version,
        user_profile_version,
        legacy_note_revision,
    })
}

/// The composed m1 delta: its body, and, when a newly-published compartment extends the
/// m0+m1 coverage, the new coverage anchor the SOFT must advance to (boundary id +
/// ordinal). `new_coverage` is None when only memory deltas ride (the boundary stays put,
/// the `new_boundary_id=None` SOFT path). The REVISION is NOT here — it is the cheap
/// [`m1_revision_signal`] the caller reads every pass; the body is the placeholder when
/// empty. (Keeping the revision out avoids two sources of "did m1 change".)
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct M1Composition {
    pub body: String,
    /// Number of memory corrections represented in the m1 body, for the pressure backstop.
    pub memory_update_count: usize,
    pub new_coverage: Option<(String, u64)>,
    /// Coverage of the compartment delta composed into these bytes, independent of applied meta.
    pub rendered_coverage: RenderedCompartmentCoverage,
    /// True only when the pending profile version produced a non-empty, budgeted block.
    pub profile_rendered: bool,
}

/// EXPENSIVE bust-only: compose the m1 delta body from the store against the watermarks
/// the last HARD froze in `meta`. `now_ms` is the frozen expiry cutoff (same as the m0
/// compose). Reads compartments + memories; never call on a defer. `_note_project_path`
/// is accepted for call-site stability only: ready smart notes are not rendered into m1.
///
/// Every id m1 renders, and every id in `meta.rendered_memory_ids`, is a `context.db`
/// memory id, whatever the harness.
#[allow(clippy::too_many_arguments)]
pub fn compose_m1_from_store(
    store: &McStore,
    project_path: &str,
    _note_project_path: &str,
    session_id: &str,
    meta: &ModuleMeta,
    now_ms: i64,
    memory_enabled: bool,
    memory_budget_tokens: f64,
    user_profile_budget_tokens: f64,
    temporal_awareness: bool,
    estimate_tokens: impl Fn(&str) -> usize + Copy,
) -> Result<M1Composition, M1ComposeError> {
    // --- new compartments (seq past the folded watermark) at P1 + coverage extension ---
    // Store-only ordering deliberately allows sparse ordinal gaps; transform has
    // the live array and rejects any coverage advance that would trim present,
    // uncovered input.
    let compartments = store.load_compartments(session_id)?;
    let coverage = resolve_coverage(&compartments).map_err(M1ComposeError::CoverageGap)?;
    let (_folded, new_comps) = partition_by_folded_seq(&compartments, meta.folded_compartment_seq);
    let new_comp_decay: Vec<DecayRenderCompartment> = new_comps
        .iter()
        .map(|c| {
            let mut rendered = DecayRenderCompartment::from(*c);
            if !temporal_awareness {
                rendered.start_date = None;
                rendered.end_date = None;
            }
            rendered
        })
        .collect();
    let new_comp_refs: Vec<&DecayRenderCompartment> = new_comp_decay.iter().collect();
    let new_compartments_block = render_new_compartments(&new_comp_refs);
    let rendered_coverage =
        new_comps
            .last()
            .map_or_else(RenderedCompartmentCoverage::default, |last| {
                RenderedCompartmentCoverage::from_coverage(
                    last.sequence,
                    Some(last.end_message.max(0) as u64),
                )
            });

    // a new compartment EXTENDS coverage when the full set's coverage end is past what
    // m0+m1 currently cover (meta.coverage_ordinal). Then the SOFT advances the anchor.
    let new_coverage = match &coverage {
        Some(c) if Some(c.coverage_end_ordinal) > meta.coverage_ordinal => {
            Some((c.boundary_id.clone(), c.coverage_end_ordinal))
        }
        _ => None,
    };

    let (mutations, memory_updates_block, new_memories_block) = if memory_enabled {
        // Resolve membership from the calling project. The sorted union's first member is not
        // necessarily the caller, so using it as `own_identity` would hide own private categories.
        let membership = store.resolve_workspace_membership(project_path)?;
        let paths = membership
            .as_ref()
            .map(|workspace| workspace.union_identities.clone())
            .unwrap_or_else(|| vec![project_path.to_string()]);

        // Rendered ids are context.db ids, the same ids the mutation log targets.
        let baseline_module_ids = meta.rendered_memory_ids.clone();

        // --- memory-updates (corrections to in-m0 memories, past the cursor) ---
        // The store also returns visibility-transition markers for rows omitted from m0 and
        // resolves supersede chains to their terminal target.
        let pending_mutations = store.memory_mutations_for_render(
            &paths,
            meta.memory_mutation_cursor,
            &baseline_module_ids,
        )?;
        let baseline_ids: HashSet<i64> = baseline_module_ids.iter().copied().collect();

        // Read through the exact m0 visibility, lifecycle, and frozen-expiry predicate. Existing
        // merge targets and newly-visible rows may be below the folded numeric watermark.
        let eligible_memories =
            load_render_eligible_memories(store, membership.as_ref(), project_path, now_ms)?;
        let eligible_ids: HashSet<i64> = eligible_memories.iter().map(|memory| memory.id).collect();
        let mut forced_ids = pending_mutations
            .iter()
            .filter_map(|mutation| {
                if mutation.mutation_type == "superseded" {
                    mutation.superseded_by_id
                } else if mutation.visibility_changed
                    && !baseline_ids.contains(&mutation.target_memory_id)
                {
                    Some(mutation.target_memory_id)
                } else {
                    None
                }
            })
            .filter(|id| !baseline_ids.contains(id) && eligible_ids.contains(id))
            .collect::<Vec<_>>();
        forced_ids.sort_unstable();
        forced_ids.dedup();
        if forced_ids.len() > MAX_MERGE_REPLACEMENTS_PER_DELTA {
            tracing::warn!(
                "mc-module: m1 forced-memory cap exceeded session={} memories={} cap={}",
                session_id,
                forced_ids.len(),
                MAX_MERGE_REPLACEMENTS_PER_DELTA
            );
            forced_ids.truncate(MAX_MERGE_REPLACEMENTS_PER_DELTA);
        }
        let forced_ids: HashSet<i64> = forced_ids.into_iter().collect();

        // Numeric additions are limited to 25% of the m1 memory budget. Terminal merge
        // replacements and visibility grants correct the rendered baseline, so they are emitted
        // outside that additive limit and only once.
        let additive_candidates = eligible_memories
            .iter()
            .filter(|memory| memory.id > meta.max_memory_id)
            .filter(|memory| !forced_ids.contains(&memory.id))
            .cloned()
            .collect();
        let source_name_by_id = membership
            .as_ref()
            .map(|workspace| workspace_source_names(&eligible_memories, workspace))
            .unwrap_or_default();
        let mut delta_memories = trim_memories_to_budget(
            additive_candidates,
            None,
            &source_name_by_id,
            (memory_budget_tokens.max(1.0) * 0.25).floor().max(1.0),
            estimate_tokens,
        );
        delta_memories.extend(
            eligible_memories
                .iter()
                .filter(|memory| forced_ids.contains(&memory.id))
                .cloned(),
        );

        let mut resolvable_ids: HashSet<i64> =
            baseline_ids.intersection(&eligible_ids).copied().collect();
        resolvable_ids.extend(delta_memories.iter().map(|memory| memory.id));
        let mutations = pending_mutations
            .into_iter()
            .filter_map(|mut mutation| {
                if !baseline_ids.contains(&mutation.target_memory_id) {
                    return None;
                }
                if mutation.mutation_type == "superseded" {
                    return Some(mutation);
                }
                if !eligible_ids.contains(&mutation.target_memory_id) {
                    mutation.mutation_type = "delete".to_string();
                    mutation.new_content = None;
                    return Some(mutation);
                }
                if mutation.visibility_changed && mutation.new_content.is_none() {
                    return None;
                }
                Some(mutation)
            })
            .collect::<Vec<_>>();
        let memory_updates_block = render_memory_updates(&mutations, &resolvable_ids);
        let new_memories_block =
            render_memory_block(&delta_memories, "new-memories", &source_name_by_id);
        (mutations, memory_updates_block, new_memories_block)
    } else {
        (Vec::new(), String::new(), String::new())
    };

    // Profile rows and their version arrive together through state sync. Render the block only
    // after a version change, and leave the applied version behind when trimming leaves no body
    // to send; that makes the next real render consume the pending delta instead of losing it.
    let (new_user_profile_block, profile_rendered) =
        if memory_enabled && meta.user_profile_version != meta.m1_user_profile_version {
            let profile_rows = store.load_active_user_memories()?;
            // Allocate one quarter of the baseline profile budget to profile deltas, matching
            // the quarter-budget allocation used for memory deltas.
            let profile_delta_budget = (user_profile_budget_tokens.max(1.0) * 0.25)
                .floor()
                .max(1.0);
            let profile =
                trim_user_profile_to_budget(profile_rows, profile_delta_budget, estimate_tokens);
            let block = render_user_profile_block(&profile, "new-user-profile");
            let rendered = !block.is_empty();
            (block, rendered)
        } else {
            (String::new(), false)
        };

    // Ready smart notes are deliberately absent from m1. They reach the agent the
    // same way in every transform mode: the host's deferred-notes reminder, then
    // `ctx_note read`, both of which show the ids the agent can act on.
    let body = assemble_m1(
        &memory_updates_block,
        &new_compartments_block,
        &new_memories_block,
        &new_user_profile_block,
        M1_PLACEHOLDER,
    );

    Ok(M1Composition {
        rendered_coverage,
        body,
        memory_update_count: mutations.len(),
        new_coverage,
        profile_rendered,
    })
}

/// Load the full render-eligible memory pool through m0's established predicates. The caller
/// partitions this one snapshot into additive memories and merge-replacement corrections.
/// `membership` is resolved from the calling project, so own-vs-foreign visibility cannot drift
/// to whichever workspace member happens to sort first.
fn load_render_eligible_memories(
    store: &McStore,
    membership: Option<&mc_store::WorkspaceMembership>,
    project_path: &str,
    now_ms: i64,
) -> Result<Vec<StoredMemory>, McStoreError> {
    Ok(store
        .load_memory_render_snapshot(project_path, membership, now_ms)?
        .memories)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{descriptor, FixtureBuilder};
    use mc_store::{InsertMemoryInput, ModuleStateSyncRequest, StoredCompartment};

    fn no_estimate(_: &str) -> usize {
        0
    }

    fn comp(seq: i64, start: i64, end: i64, end_id: &str) -> StoredCompartment {
        StoredCompartment {
            sequence: seq,
            start_message: start,
            end_message: end,
            end_message_id: end_id.to_string(),
            title: format!("C{seq}"),
            content: format!("b{seq}"),
            p1: Some(format!("P1-{seq}")),
            importance: 50,
            ..Default::default()
        }
    }

    fn meta_after_hard(
        folded_seq: i64,
        coverage: Option<u64>,
        max_mem: i64,
        cursor: i64,
        manifest: Vec<i64>,
    ) -> ModuleMeta {
        ModuleMeta {
            initialized: true,
            folded_compartment_seq: folded_seq,
            coverage_ordinal: coverage,
            max_memory_id: max_mem,
            memory_mutation_cursor: cursor,
            rendered_memory_ids: manifest,
            ..Default::default()
        }
    }

    fn insert_input<'a>(
        project: &'a str,
        category: &'a str,
        content: &'a str,
        now: i64,
    ) -> InsertMemoryInput<'a> {
        InsertMemoryInput {
            project_path: project,
            route_project_root: None,
            category,
            content,
            source_session_id: None,
            source_type: Some("tool"),
            importance: Some(70),
            expires_at: None,
            metadata_json: None,
            now_ms: now,
        }
    }

    fn seed_user_profile(store: &McStore, profile: &[String]) {
        store.seed_user_profile_for_test(profile, 2).unwrap();
        store
            .apply_authority_state_sync(ModuleStateSyncRequest {
                resolved_compartment_boundaries: &[],
                session_id: "ses",
                project_path: "git:proj",
                shadow_generation: 0,
                expected_shadow_seq: 0,
                seed_boundary_id: None,
                drop_seeds: &[],
                drop_seed_skipped: 0,
                pending_agent_drops: &[],
                pending_agent_drops_skipped: 0,
                user_hint_seeds: &[],
                auto_search_hint_skipped: 0,
                note_nudge_anchors: None,
                todo_synthetic_anchor: None,
                todo_synthetic_anchor_present: false,
                emergency_latches: None,
                pending_compaction_marker: None,
                deferred_execute_state: None,
                channel2_nudge_state: None,
                strip_seeds: &[],
                strip_seed_skipped: 0,
                reasoning_cleared_through_tag: None,
                last_todo_state: None,
                acked_watermarks: serde_json::json!({}),
            })
            .unwrap();
    }

    fn profile_delta_meta() -> ModuleMeta {
        ModuleMeta {
            initialized: true,
            user_profile_version: 2,
            m1_user_profile_version: 1,
            ..Default::default()
        }
    }

    #[test]
    fn revision_signal_is_stable_and_moves_on_change() {
        let fixture = FixtureBuilder::store();
        let store = &fixture.store;
        let p = "git:proj";
        let s0 = m1_revision_signal(store, p, "ses").unwrap();
        let s1 = m1_revision_signal(store, p, "ses").unwrap();
        assert_eq!(s0, s1, "stable store → stable signal");
        assert_ne!(s0, 0, "a computed signal is never the empty marker 0");

        // publish a compartment → the signal moves
        store
            .replace_compartments("ses", &[comp(1, 1, 9, "m9")])
            .unwrap();
        let s2 = m1_revision_signal(store, p, "ses").unwrap();
        assert_ne!(s1, s2, "new compartment → signal moves");
    }

    #[test]
    fn note_status_is_not_an_m1_revision_input_and_note_free_digests_are_unchanged() {
        // Sessions with no note status history must keep the digest older builds stored.
        for profile_version in [0, 3] {
            assert_eq!(
                in_session_revision(4, 5, 6, profile_version),
                in_session_revision_with_note_status(4, 5, 6, 0, profile_version)
            );
        }

        let fixture = FixtureBuilder::store();
        let store = &fixture.store;
        let before =
            m1_revision_signal_parts_for_pass(store, "git:proj", "git:proj", "ses", 1, true, 0)
                .unwrap();
        assert_eq!(before.legacy_note_revision, None);
        store
            .insert_note(mc_store::NoteInput {
                project_path: "git:proj",
                route_project_root: None,
                session_id: "ses",
                content: "a note",
                surface_condition: None,
                anchor_block_id: None,
                now_ms: 1,
            })
            .unwrap();
        store
            .dismiss_note("git:proj", "ses", 1, None, 2)
            .unwrap()
            .expect("note dismissed");
        let after =
            m1_revision_signal_parts_for_pass(store, "git:proj", "git:proj", "ses", 1, true, 0)
                .unwrap();
        assert!(after.note_status_version > before.note_status_version);
        assert_eq!(after.revision, before.revision);
        let legacy = after.legacy_note_revision.expect("older digest differs");
        assert_ne!(legacy, after.revision);
        assert_eq!(after.equivalent_applied_revision(legacy), after.revision);
        assert_eq!(after.equivalent_applied_revision(7), 7);
    }

    #[test]
    fn profile_version_moves_the_in_session_revision_signal() {
        let fixture = FixtureBuilder::store();
        let store = &fixture.store;
        let before =
            m1_revision_signal_parts_for_pass(store, "git:proj", "git:proj", "ses", 1, true, 0)
                .unwrap();
        let after =
            m1_revision_signal_parts_for_pass(store, "git:proj", "git:proj", "ses", 2, true, 0)
                .unwrap();

        assert_ne!(before.revision, after.revision);
        assert_eq!(after.user_profile_version, 2);
    }

    #[test]
    fn profile_delta_uses_the_quarter_budget_boundary() {
        let exact_dir = tempfile::tempdir().unwrap();
        let exact_store = McStore::open_for_test(&descriptor(exact_dir.path())).unwrap();
        seed_user_profile(&exact_store, &["exact-quarter".to_string()]);
        let exact = compose_m1_from_store(
            &exact_store,
            "git:proj",
            "git:proj",
            "ses",
            &profile_delta_meta(),
            0,
            true,
            8_000.0,
            100.0,
            true,
            |_| 21,
        )
        .unwrap();
        assert!(exact.body.contains("- exact-quarter"), "{}", exact.body);
        assert!(exact.profile_rendered);

        let over_dir = tempfile::tempdir().unwrap();
        let over_store = McStore::open_for_test(&descriptor(over_dir.path())).unwrap();
        seed_user_profile(&over_store, &["one-token-over".to_string()]);
        let over = compose_m1_from_store(
            &over_store,
            "git:proj",
            "git:proj",
            "ses",
            &profile_delta_meta(),
            0,
            true,
            8_000.0,
            100.0,
            true,
            |_| 22,
        )
        .unwrap();
        assert_eq!(over.body, M1_PLACEHOLDER);
        assert!(!over.profile_rendered);

        let empty_dir = tempfile::tempdir().unwrap();
        let empty_store = McStore::open_for_test(&descriptor(empty_dir.path())).unwrap();
        seed_user_profile(&empty_store, &["too-large".to_string()]);
        let empty = compose_m1_from_store(
            &empty_store,
            "git:proj",
            "git:proj",
            "ses",
            &profile_delta_meta(),
            0,
            true,
            8_000.0,
            1.0,
            true,
            |_| 1,
        )
        .unwrap();
        assert_eq!(empty.body, M1_PLACEHOLDER);
        assert!(!empty.profile_rendered);
    }

    #[test]
    fn disabled_memory_inputs_do_not_move_revision_but_compartments_still_do() {
        let fixture = FixtureBuilder::store();
        let store = &fixture.store;
        let project = "git:proj";
        let foreign = "git:foreign";
        store
            .seed_workspace_member("ws", project, "[\"CONSTRAINTS\"]")
            .unwrap();
        store
            .seed_workspace_member("ws", foreign, "[\"CONSTRAINTS\"]")
            .unwrap();
        let before =
            m1_revision_signal_parts_for_pass(store, project, project, "ses", 0, false, 0).unwrap();

        let memory = store
            .insert_memory(insert_input(project, "CONSTRAINTS", "private rule", 1))
            .unwrap();
        store
            .update_memory_content(project, memory, "changed private rule", None, 2)
            .unwrap();
        let foreign_memory = store
            .insert_memory(insert_input(
                foreign,
                "CONSTRAINTS",
                "shared private rule",
                3,
            ))
            .unwrap();
        store
            .update_memory_content(foreign, foreign_memory, "changed shared rule", None, 4)
            .unwrap();
        let after_memory =
            m1_revision_signal_parts_for_pass(store, project, project, "ses", 0, false, 0).unwrap();
        assert_eq!(after_memory.revision, before.revision);
        assert_eq!(after_memory.max_memory_id, 0);
        assert_eq!(after_memory.max_memory_mutation_id, 0);
        let enabled_after_memory =
            m1_revision_signal_parts_for_pass(store, project, project, "ses", 0, true, 0).unwrap();
        assert_ne!(enabled_after_memory.revision, before.revision);

        store
            .replace_compartments("ses", &[comp(1, 1, 9, "m9")])
            .unwrap();
        let after_compartment =
            m1_revision_signal_parts_for_pass(store, project, project, "ses", 0, false, 0).unwrap();
        assert_ne!(after_compartment.revision, after_memory.revision);
    }

    #[test]
    fn disabled_memory_lane_renders_no_additions_or_corrections() {
        let fixture = FixtureBuilder::store();
        let store = &fixture.store;
        let project = "git:proj";
        let foreign = "git:foreign";
        store
            .seed_workspace_member("ws", project, "[\"CONSTRAINTS\"]")
            .unwrap();
        store
            .seed_workspace_member("ws", foreign, "[\"CONSTRAINTS\"]")
            .unwrap();
        let baseline = store
            .insert_memory(insert_input(
                project,
                "CONSTRAINTS",
                "baseline private rule",
                1,
            ))
            .unwrap();
        let folded_max = store.max_memory_id(&[project.to_string()]).unwrap();
        let folded_cursor = store
            .max_memory_mutation_id(&[project.to_string()])
            .unwrap();
        store
            .update_memory_content(project, baseline, "corrected private rule", None, 2)
            .unwrap();
        store
            .insert_memory(insert_input(project, "ARCHITECTURE", "new private rule", 3))
            .unwrap();
        store
            .insert_memory(insert_input(foreign, "CONSTRAINTS", "new shared rule", 4))
            .unwrap();

        seed_user_profile(store, &["profile delta must stay hidden".to_string()]);
        let mut meta = meta_after_hard(0, None, folded_max, folded_cursor, vec![baseline]);
        meta.user_profile_version = 2;
        meta.m1_user_profile_version = 1;
        let m1 = compose_m1_from_store(
            store,
            project,
            project,
            "ses",
            &meta,
            0,
            false,
            8_000.0,
            4_000.0,
            true,
            no_estimate,
        )
        .unwrap();

        assert_eq!(m1.body, M1_PLACEHOLDER);
        assert_eq!(m1.memory_update_count, 0);
        assert!(!m1.body.contains("private rule"));
        assert!(!m1.body.contains("shared rule"));
        assert!(!m1.body.contains("<new-user-profile>"));
        assert!(!m1.body.contains("profile delta must stay hidden"));
    }

    #[test]
    fn empty_delta_is_the_placeholder_body() {
        let fixture = FixtureBuilder::store();
        let store = &fixture.store;
        // a HARD folded everything (folded_seq covers all, no new memories/mutations)
        let meta = meta_after_hard(5, Some(50), 100, 9, vec![1, 2]);
        let m1 = compose_m1_from_store(
            store,
            "git:proj",
            "git:proj",
            "ses",
            &meta,
            0,
            true,
            8_000.0,
            4_000.0,
            true,
            no_estimate,
        )
        .unwrap();
        assert_eq!(m1.body, M1_PLACEHOLDER, "no delta → the placeholder body");
        assert_eq!(m1.new_coverage, None);
    }

    #[test]
    fn new_compartment_rides_m1_and_extends_coverage() {
        let fixture = FixtureBuilder::store();
        let store = &fixture.store;
        // m0 folded C1 (covers ord 1-10, folded_seq=1, coverage=10). C2 (11-20) publishes.
        store
            .replace_compartments("ses", &[comp(1, 1, 10, "m10"), comp(2, 11, 20, "m20")])
            .unwrap();
        let meta = meta_after_hard(1, Some(10), 0, 0, vec![]);
        let m1 = compose_m1_from_store(
            store,
            "git:proj",
            "git:proj",
            "ses",
            &meta,
            0,
            true,
            8_000.0,
            4_000.0,
            true,
            no_estimate,
        )
        .unwrap();

        // C2 rides m1 at P1, and coverage extends 10 → 20 (the SOFT advances the anchor)
        assert!(m1.body.contains("<new-compartments>"), "{}", m1.body);
        assert!(m1.body.contains("## 11-20 · C2") && !m1.body.contains("## 1-10 · C1"));
        assert!(m1.body.contains("P1-2"), "rides at P1: {}", m1.body);
        assert_eq!(m1.new_coverage, Some(("m20".to_string(), 20)));
    }

    #[test]
    fn memory_only_delta_does_not_extend_coverage() {
        let fixture = FixtureBuilder::store();
        let store = &fixture.store;
        // one folded compartment; a NEW memory (id 5) past the folded max (0).
        store
            .replace_compartments("ses", &[comp(1, 1, 10, "m10")])
            .unwrap();
        store
            .seed_memory(5, "git:proj", "ARCHITECTURE", "new mem", 70)
            .unwrap();
        // meta: folded_seq=1, coverage=10 (matches the only compartment), folded max_mem=0
        let meta = meta_after_hard(1, Some(10), 0, 0, vec![]);
        let m1 = compose_m1_from_store(
            store,
            "git:proj",
            "git:proj",
            "ses",
            &meta,
            0,
            true,
            8_000.0,
            4_000.0,
            true,
            no_estimate,
        )
        .unwrap();

        assert!(m1.body.contains("<new-memories>"), "{}", m1.body);
        assert!(m1.body.contains("new mem"));
        // no new compartment → coverage does NOT extend (the None-boundary SOFT path)
        assert_eq!(
            m1.new_coverage, None,
            "memory-only delta keeps the boundary put"
        );
    }

    #[test]
    fn interleaved_memory_deltas_match_the_typescript_byte_fixture_and_next_hard_fold() {
        let fixture = FixtureBuilder::store();
        let store = &fixture.store;
        let project = "git:proj";
        let initial_ids = [
            store
                .insert_memory(insert_input(project, "CONFIG_VALUES", "original alpha", 1))
                .unwrap(),
            store
                .insert_memory(insert_input(project, "CONSTRAINTS", "archive beta", 1))
                .unwrap(),
            store
                .insert_memory(insert_input(
                    project,
                    "CONSTRAINTS",
                    "merge source gamma",
                    1,
                ))
                .unwrap(),
            store
                .insert_memory(insert_input(
                    project,
                    "CONSTRAINTS",
                    "merge target delta",
                    1,
                ))
                .unwrap(),
        ];
        assert_eq!(initial_ids, [1, 2, 3, 4]);
        let hard = crate::m0_compose::compose_m0_from_store(
            store,
            &crate::m0_compose::M0ComposeInputs {
                score_selector: mc_store::ScoreSelector::Base,
                session_id: "ses",
                project_path: project,
                project_directory: fixture.dir.path().to_str().unwrap(),
                now_ms: 1,
                history_budget_tokens: 60_000.0,
                covered_system_messages: &[],
                memory_enabled: true,
                memory_budget_tokens: 8_000.0,
                user_profile_budget_tokens: 4_000.0,
                inject_docs: false,
                temporal_awareness: true,
                mural: None,
            },
            no_estimate,
        )
        .unwrap();
        assert_eq!(hard.rendered_memory_ids, initial_ids);
        let meta = meta_after_hard(
            hard.folded_compartment_seq,
            hard.coverage_ordinal,
            hard.max_memory_id,
            hard.memory_mutation_cursor,
            hard.rendered_memory_ids.clone(),
        );

        store
            .update_memory_content(
                project,
                initial_ids[0],
                "updated <alpha> & stable",
                Some("CONSTRAINTS"),
                10,
            )
            .unwrap();
        store
            .archive_memory(project, initial_ids[1], None, 11)
            .unwrap();
        let first = compose_m1_from_store(
            store,
            project,
            project,
            "ses",
            &meta,
            1,
            true,
            8_000.0,
            4_000.0,
            true,
            no_estimate,
        )
        .unwrap();

        let late_source = store
            .insert_memory(insert_input(
                project,
                "CONSTRAINTS",
                "late merge source epsilon",
                20,
            ))
            .unwrap();
        assert!(late_source > hard.max_memory_id);
        store
            .merge_memories(
                project,
                initial_ids[3],
                &[initial_ids[2], late_source],
                "merged <delta> & sources",
                30,
            )
            .unwrap();
        let second = compose_m1_from_store(
            store,
            project,
            project,
            "ses",
            &meta,
            1,
            true,
            8_000.0,
            4_000.0,
            true,
            no_estimate,
        )
        .unwrap();
        let reconciled = crate::m0_compose::compose_m0_from_store(
            store,
            &crate::m0_compose::M0ComposeInputs {
                score_selector: mc_store::ScoreSelector::Base,
                session_id: "ses",
                project_path: project,
                project_directory: fixture.dir.path().to_str().unwrap(),
                now_ms: 30,
                history_budget_tokens: 60_000.0,
                covered_system_messages: &[],
                memory_enabled: true,
                memory_budget_tokens: 8_000.0,
                user_profile_budget_tokens: 4_000.0,
                inject_docs: false,
                temporal_awareness: true,
                mural: None,
            },
            no_estimate,
        )
        .unwrap();
        let reconciled_meta = meta_after_hard(
            reconciled.folded_compartment_seq,
            reconciled.coverage_ordinal,
            reconciled.max_memory_id,
            reconciled.memory_mutation_cursor,
            reconciled.rendered_memory_ids.clone(),
        );
        let post_hard = compose_m1_from_store(
            store,
            project,
            project,
            "ses",
            &reconciled_meta,
            30,
            true,
            8_000.0,
            4_000.0,
            true,
            no_estimate,
        )
        .unwrap();

        let expected: serde_json::Value =
            serde_json::from_str(include_str!("../testdata/memory-update-delta-parity.json"))
                .unwrap();
        let xml_block = |text: &str, tag: &str| {
            let start_tag = format!("<{tag}>");
            let end_tag = format!("</{tag}>");
            let start = text.find(&start_tag).unwrap();
            let end = text[start..].find(&end_tag).unwrap() + start + end_tag.len();
            text[start..end].to_string()
        };
        assert_eq!(
            xml_block(&first.body, "memory-updates"),
            expected["first_delta"].as_str().unwrap()
        );
        assert_eq!(
            xml_block(&second.body, "memory-updates"),
            expected["second_delta"].as_str().unwrap()
        );
        assert_eq!(
            xml_block(&reconciled.m0_bytes, "project-memory"),
            expected["reconciled_m0"].as_str().unwrap()
        );
        assert_eq!(post_hard.body, crate::memory_render::M1_PLACEHOLDER);
    }

    #[test]
    fn public_memory_ports_drive_m1_revision_and_delta_blocks() {
        let project = "git:proj";

        for case in ["update", "archive", "merge"] {
            let dir = tempfile::tempdir().unwrap();
            let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
            store
                .replace_compartments("ses", &[comp(1, 1, 10, "m10")])
                .unwrap();
            let target = store
                .insert_memory(insert_input(project, "CONSTRAINTS", "original", 1))
                .unwrap();
            let merge_source = (case == "merge").then(|| {
                store
                    .insert_memory(insert_input(project, "CONSTRAINTS", "duplicate", 1))
                    .unwrap()
            });
            let mut manifest = vec![target];
            if let Some(source) = merge_source {
                manifest.push(source);
            }
            let max_mem = store.max_memory_id(&[project.to_string()]).unwrap();
            let cursor = store
                .max_memory_mutation_id(&[project.to_string()])
                .unwrap();
            let before_signal = m1_revision_signal(&store, project, "ses").unwrap();

            match case {
                "update" => {
                    store
                        .update_memory_content(project, target, "corrected", None, 2)
                        .unwrap();
                }
                "archive" => {
                    store
                        .archive_memory(project, target, Some("obsolete"), 2)
                        .unwrap();
                }
                "merge" => {
                    store
                        .merge_memories(project, target, &[merge_source.unwrap()], "merged", 2)
                        .unwrap();
                }
                _ => unreachable!(),
            }

            let after_signal = m1_revision_signal(&store, project, "ses").unwrap();
            assert_ne!(
                before_signal, after_signal,
                "{case} must move the m1 signal"
            );
            let meta = meta_after_hard(1, Some(10), max_mem, cursor, manifest);
            let m1 = compose_m1_from_store(
                &store,
                project,
                project,
                "ses",
                &meta,
                0,
                true,
                8_000.0,
                4_000.0,
                true,
                no_estimate,
            )
            .unwrap();
            assert!(m1.body.contains("<memory-updates>"), "{case}: {}", m1.body);
            assert_eq!(
                m1.new_coverage, None,
                "memory-only mutations do not extend coverage"
            );
        }
    }

    #[test]
    fn merge_replacement_omitted_from_m0_renders_with_lineage_and_one_revision_change() {
        let fixture = FixtureBuilder::store();
        let store = &fixture.store;
        let project = "git:proj";
        store
            .replace_compartments("ses", &[comp(1, 1, 10, "m10")])
            .unwrap();
        let source = store
            .insert_memory(insert_input(project, "CONSTRAINTS", "source fact", 1))
            .unwrap();
        let target = store
            .insert_memory(insert_input(project, "CONSTRAINTS", "trimmed target", 1))
            .unwrap();
        let folded_max = store.max_memory_id(&[project.to_string()]).unwrap();
        let folded_cursor = store
            .max_memory_mutation_id(&[project.to_string()])
            .unwrap();
        let before = m1_revision_signal(store, project, "ses").unwrap();

        store
            .merge_memories(project, target, &[source], "merged correction", 2)
            .unwrap();

        let after = m1_revision_signal(store, project, "ses").unwrap();
        assert_ne!(before, after, "the atomic merge must move the m1 revision");
        assert_eq!(
            after,
            m1_revision_signal(store, project, "ses").unwrap(),
            "the merge moves the revision once rather than creating a live render input"
        );
        let meta = meta_after_hard(1, Some(10), folded_max, folded_cursor, vec![source]);
        let first = compose_m1_from_store(
            store,
            project,
            project,
            "ses",
            &meta,
            0,
            true,
            8_000.0,
            4_000.0,
            true,
            no_estimate,
        )
        .unwrap();
        let replay = compose_m1_from_store(
            store,
            project,
            project,
            "ses",
            &meta,
            0,
            true,
            8_000.0,
            4_000.0,
            true,
            no_estimate,
        )
        .unwrap();

        assert!(
            first
                .body
                .contains(&format!("<superseded id=\"{source}\" by=\"{target}\"/>")),
            "{}",
            first.body
        );
        assert!(first.body.contains("merged correction"), "{}", first.body);
        assert!(
            !first.body.contains(&format!("<removed id=\"{source}\"/>")),
            "{}",
            first.body
        );
        assert_eq!(
            first.body, replay.body,
            "the frozen-cutoff compose is deterministic"
        );
    }

    #[test]
    fn merge_replacement_newer_than_folded_max_is_deduplicated_from_additions() {
        let fixture = FixtureBuilder::store();
        let store = &fixture.store;
        let project = "git:proj";
        let source = store
            .insert_memory(insert_input(project, "CONSTRAINTS", "source fact", 1))
            .unwrap();
        let folded_cursor = store
            .max_memory_mutation_id(&[project.to_string()])
            .unwrap();
        let target = store
            .insert_memory(insert_input(project, "CONSTRAINTS", "new target", 2))
            .unwrap();
        store
            .merge_memories(project, target, &[source], "deduplicated correction", 3)
            .unwrap();

        let meta = meta_after_hard(0, None, source, folded_cursor, vec![source]);
        let m1 = compose_m1_from_store(
            store,
            project,
            project,
            "ses",
            &meta,
            0,
            true,
            8_000.0,
            4_000.0,
            true,
            no_estimate,
        )
        .unwrap();
        assert_eq!(
            m1.body.matches("deduplicated correction").count(),
            1,
            "a replacement that is also newer than the watermark must render once: {}",
            m1.body
        );
        assert!(
            m1.body
                .contains(&format!("<superseded id=\"{source}\" by=\"{target}\"/>")),
            "{}",
            m1.body
        );
    }

    #[test]
    fn workspace_merge_replacement_uses_calling_projects_visibility() {
        let fixture = FixtureBuilder::store();
        let store = &fixture.store;
        let foreign = "git:aaa-foreign";
        let own = "git:zzz-own";
        store
            .seed_workspace_member("ws", foreign, "[\"CONSTRAINTS\"]")
            .unwrap();
        store
            .seed_workspace_member("ws", own, "[\"CONSTRAINTS\"]")
            .unwrap();
        store
            .replace_compartments("ses", &[comp(1, 1, 10, "m10")])
            .unwrap();
        let source = store
            .insert_memory(insert_input(own, "ARCHITECTURE", "own source", 1))
            .unwrap();
        let target = store
            .insert_memory(insert_input(own, "ARCHITECTURE", "own trimmed target", 1))
            .unwrap();
        let paths = vec![foreign.to_string(), own.to_string()];
        let folded_max = store.max_memory_id(&paths).unwrap();
        let folded_cursor = store.max_memory_mutation_id(&paths).unwrap();

        store
            .merge_memories(own, target, &[source], "own workspace correction", 2)
            .unwrap();

        let meta = meta_after_hard(1, Some(10), folded_max, folded_cursor, vec![source]);
        let m1 = compose_m1_from_store(
            store,
            own,
            own,
            "ses",
            &meta,
            0,
            true,
            8_000.0,
            4_000.0,
            true,
            no_estimate,
        )
        .unwrap();
        assert!(m1.body.contains("own workspace correction"), "{}", m1.body);
        assert!(
            m1.body
                .contains(&format!("<superseded id=\"{source}\" by=\"{target}\"/>")),
            "{}",
            m1.body
        );
    }

    #[test]
    fn workspace_replacement_chain_crosses_an_invisible_intermediate() {
        let fixture = FixtureBuilder::store();
        let store = &fixture.store;
        let own = "git:workspace-chain-own";
        let foreign = "git:workspace-chain-foreign";
        store
            .seed_workspace_member("workspace-chain", own, "[\"CONSTRAINTS\"]")
            .unwrap();
        store
            .seed_workspace_member("workspace-chain", foreign, "[\"CONSTRAINTS\"]")
            .unwrap();
        let source = store
            .insert_memory(insert_input(
                foreign,
                "CONSTRAINTS",
                "foreign chain source",
                1,
            ))
            .unwrap();
        let middle = store
            .insert_memory(insert_input(
                foreign,
                "CONSTRAINTS",
                "foreign private middle",
                1,
            ))
            .unwrap();
        let terminal = store
            .insert_memory(insert_input(foreign, "CONSTRAINTS", "foreign terminal", 1))
            .unwrap();
        store
            .set_memory_sharing_for_test(source, "project", true)
            .unwrap();
        store
            .set_memory_sharing_for_test(terminal, "project", true)
            .unwrap();
        let membership = store.resolve_workspace_membership(own).unwrap().unwrap();
        let baseline = store
            .load_memory_render_snapshot(own, Some(&membership), 0)
            .unwrap();
        let cursor = baseline.revision.mutation_cursor;
        store
            .merge_memories(foreign, middle, &[source], "foreign middle merged", 2)
            .unwrap();
        store
            .merge_memories(foreign, terminal, &[middle], "foreign terminal merged", 3)
            .unwrap();
        store
            .set_memory_sharing_for_test(terminal, "project", true)
            .unwrap();

        let m1 = compose_m1_from_store(
            store,
            own,
            own,
            "ses",
            &meta_after_hard(0, None, terminal, cursor, vec![source]),
            0,
            true,
            8_000.0,
            4_000.0,
            true,
            no_estimate,
        )
        .unwrap();
        assert!(
            m1.body
                .contains(&format!("<superseded id=\"{source}\" by=\"{terminal}\"/>")),
            "{}",
            m1.body
        );
        assert!(m1.body.contains("foreign terminal merged"), "{}", m1.body);
        assert!(!m1.body.contains("foreign middle merged"), "{}", m1.body);
    }

    #[test]
    fn replacement_chains_resolve_to_terminal_and_cycles_degrade_to_removal() {
        let fixture = FixtureBuilder::store();
        let store = &fixture.store;
        let project = "git:replacement-chain";
        let source = store
            .insert_memory(insert_input(project, "CONSTRAINTS", "chain source", 1))
            .unwrap();
        let middle = store
            .insert_memory(insert_input(project, "CONSTRAINTS", "chain middle", 1))
            .unwrap();
        let terminal = store
            .insert_memory(insert_input(project, "CONSTRAINTS", "chain terminal", 1))
            .unwrap();
        let folded_cursor = store
            .max_memory_mutation_id(&[project.to_string()])
            .unwrap();
        store
            .merge_memories(project, middle, &[source], "middle merged", 2)
            .unwrap();
        store
            .merge_memories(project, terminal, &[middle], "terminal merged", 3)
            .unwrap();
        let chain = compose_m1_from_store(
            store,
            project,
            project,
            "ses",
            &meta_after_hard(0, None, terminal, folded_cursor, vec![source]),
            0,
            true,
            8_000.0,
            4_000.0,
            true,
            no_estimate,
        )
        .unwrap();
        assert!(
            chain
                .body
                .contains(&format!("<superseded id=\"{source}\" by=\"{terminal}\"/>")),
            "{}",
            chain.body
        );
        assert_eq!(chain.body.matches("terminal merged").count(), 1);
        assert!(!chain.body.contains("middle merged"), "{}", chain.body);

        let cycle_dir = tempfile::tempdir().unwrap();
        let cycle_store = McStore::open_for_test(&descriptor(cycle_dir.path())).unwrap();
        let cycle_source = cycle_store
            .insert_memory(insert_input(project, "CONSTRAINTS", "cycle source", 1))
            .unwrap();
        let cycle_target = cycle_store
            .insert_memory(insert_input(project, "CONSTRAINTS", "cycle target", 1))
            .unwrap();
        cycle_store
            .seed_superseded_mutation(project, cycle_source, cycle_target)
            .unwrap();
        cycle_store
            .seed_superseded_mutation(project, cycle_target, cycle_source)
            .unwrap();
        let cycle = compose_m1_from_store(
            &cycle_store,
            project,
            project,
            "ses",
            &meta_after_hard(0, None, cycle_target, 0, vec![cycle_source]),
            0,
            true,
            8_000.0,
            4_000.0,
            true,
            no_estimate,
        )
        .unwrap();
        assert!(
            cycle
                .body
                .contains(&format!("<removed id=\"{cycle_source}\"/>")),
            "{}",
            cycle.body
        );
        assert!(!cycle.body.contains("<superseded"), "{}", cycle.body);
    }

    #[test]
    fn archived_replacement_terminal_degrades_source_to_removal() {
        let fixture = FixtureBuilder::store();
        let store = &fixture.store;
        let project = "git:archived-terminal";
        let source = store
            .insert_memory(insert_input(project, "CONSTRAINTS", "source", 1))
            .unwrap();
        let target = store
            .insert_memory(insert_input(project, "CONSTRAINTS", "target", 1))
            .unwrap();
        let cursor = store
            .max_memory_mutation_id(&[project.to_string()])
            .unwrap();
        store
            .merge_memories(project, target, &[source], "merged target", 2)
            .unwrap();
        store.archive_memory(project, target, None, 3).unwrap();
        let m1 = compose_m1_from_store(
            store,
            project,
            project,
            "ses",
            &meta_after_hard(0, None, target, cursor, vec![source]),
            0,
            true,
            8_000.0,
            4_000.0,
            true,
            no_estimate,
        )
        .unwrap();
        assert!(
            m1.body.contains(&format!("<removed id=\"{source}\"/>")),
            "{}",
            m1.body
        );
        assert!(!m1.body.contains("merged target"), "{}", m1.body);
    }

    #[test]
    fn classification_visibility_grant_and_revoke_render_on_m1() {
        let fixture = FixtureBuilder::store();
        let store = &fixture.store;
        let own = "git:visibility-own";
        let foreign = "git:visibility-foreign";
        store
            .seed_workspace_member("visibility-ws", own, "[\"CONSTRAINTS\"]")
            .unwrap();
        store
            .seed_workspace_member("visibility-ws", foreign, "[\"CONSTRAINTS\"]")
            .unwrap();
        let foreign_id = store
            .insert_memory(insert_input(foreign, "CONSTRAINTS", "foreign below max", 1))
            .unwrap();
        let own_id = store
            .insert_memory(insert_input(own, "ARCHITECTURE", "own high watermark", 1))
            .unwrap();
        let membership = store.resolve_workspace_membership(own).unwrap().unwrap();
        let baseline = store
            .load_memory_render_snapshot(own, Some(&membership), 100)
            .unwrap();
        assert_eq!(baseline.revision.max_memory_id, own_id);
        assert_eq!(
            baseline
                .memories
                .iter()
                .map(|memory| memory.id)
                .collect::<Vec<_>>(),
            vec![own_id]
        );
        let content_hash = store
            .get_memory_full(foreign_id)
            .unwrap()
            .unwrap()
            .normalized_hash;
        store
            .set_memory_classification(
                foreign,
                &[mc_store::ClassificationUpdate {
                    memory_id: foreign_id,
                    content_hash_at_prompt: content_hash.clone(),
                    importance: None,
                    scope: Some("project".to_string()),
                    shareable: Some(true),
                }],
                101,
            )
            .unwrap();
        let grant_cursor = store
            .max_memory_mutation_id(&membership.union_identities)
            .unwrap();
        let grant = compose_m1_from_store(
            store,
            own,
            own,
            "ses",
            &meta_after_hard(0, None, own_id, 0, vec![own_id]),
            100,
            true,
            8_000.0,
            4_000.0,
            true,
            no_estimate,
        )
        .unwrap();
        assert!(grant.body.contains("foreign below max"), "{}", grant.body);
        assert_eq!(grant.body.matches("foreign below max").count(), 1);

        store
            .set_memory_classification(
                foreign,
                &[mc_store::ClassificationUpdate {
                    memory_id: foreign_id,
                    content_hash_at_prompt: content_hash,
                    importance: None,
                    scope: None,
                    shareable: Some(false),
                }],
                102,
            )
            .unwrap();
        let revoke = compose_m1_from_store(
            store,
            own,
            own,
            "ses",
            &meta_after_hard(0, None, own_id, grant_cursor, vec![foreign_id, own_id]),
            100,
            true,
            8_000.0,
            4_000.0,
            true,
            no_estimate,
        )
        .unwrap();
        assert!(
            revoke
                .body
                .contains(&format!("<removed id=\"{foreign_id}\"/>")),
            "{}",
            revoke.body
        );
        assert!(
            !revoke.body.contains("foreign below max"),
            "{}",
            revoke.body
        );
    }

    #[test]
    fn public_insert_renders_new_memories_without_mutation_log() {
        let fixture = FixtureBuilder::store();
        let store = &fixture.store;
        let project = "git:proj";
        store
            .replace_compartments("ses", &[comp(1, 1, 10, "m10")])
            .unwrap();
        let before_signal = m1_revision_signal(store, project, "ses").unwrap();
        let cursor = store
            .max_memory_mutation_id(&[project.to_string()])
            .unwrap();

        store
            .insert_memory(insert_input(project, "CONSTRAINTS", "brand new", 1))
            .unwrap();
        let after_signal = m1_revision_signal(store, project, "ses").unwrap();
        assert_ne!(before_signal, after_signal, "insert moves max_memory_id");
        assert_eq!(
            store
                .max_memory_mutation_id(&[project.to_string()])
                .unwrap(),
            cursor,
            "additive inserts do not write the mutation log"
        );
        let meta = meta_after_hard(1, Some(10), 0, cursor, vec![]);
        let m1 = compose_m1_from_store(
            store,
            project,
            project,
            "ses",
            &meta,
            0,
            true,
            8_000.0,
            4_000.0,
            true,
            no_estimate,
        )
        .unwrap();
        assert!(m1.body.contains("<new-memories>"), "{}", m1.body);
        assert!(m1.body.contains("brand new"), "{}", m1.body);
    }

    #[test]
    fn new_own_memory_rides_m1_when_project_is_not_first_in_workspace() {
        // Regression: the calling project sorts SECOND in the workspace union (the union is
        // sorted ASC), and adds a NEW own memory in a NON-SHARED category. The new-memories
        // read must resolve own-visibility from the CALLING project, not the union's first
        // member — else this own memory is wrongly treated as foreign and filtered out
        // while the digest still advanced, leaving a silently stale m1.
        let fixture = FixtureBuilder::store();
        let store = &fixture.store;
        let own = "git:zzz-own"; // sorts AFTER the foreign member
        let foreign = "git:aaa-foreign";
        // a workspace sharing ONLY CONSTRAINTS; the new memory is ARCHITECTURE (non-shared)
        store
            .seed_workspace_member("ws", own, "[\"CONSTRAINTS\"]")
            .unwrap();
        store
            .seed_workspace_member("ws", foreign, "[\"CONSTRAINTS\"]")
            .unwrap();
        store
            .replace_compartments("ses", &[comp(1, 1, 10, "m10")])
            .unwrap();
        // a new OWN memory id 5, ARCHITECTURE (NOT a shared category), past the folded max
        store
            .seed_memory(5, own, "ARCHITECTURE", "own arch rule", 70)
            .unwrap();

        let meta = meta_after_hard(1, Some(10), 0, 0, vec![]);
        let m1 = compose_m1_from_store(
            store,
            own,
            own,
            "ses",
            &meta,
            0,
            true,
            8_000.0,
            4_000.0,
            true,
            no_estimate,
        )
        .unwrap();
        assert!(
            m1.body.contains("own arch rule"),
            "the calling project's own non-shared new memory must ride m1 even when it is \
             not the union's first member: {}",
            m1.body
        );
        // the digest detects it too (MAX(id) over the union, no visibility filter), so the
        // body now AGREES with what the digest moved on — no silent stale m1.
        let before = {
            let s = McStore::open_for_test(&descriptor(&fixture.dir.path().join("probe"))).unwrap();
            s.seed_workspace_member("ws", own, "[\"CONSTRAINTS\"]")
                .unwrap();
            s.seed_workspace_member("ws", foreign, "[\"CONSTRAINTS\"]")
                .unwrap();
            m1_revision_signal(&s, own, "ses").unwrap()
        };
        assert_ne!(
            before,
            m1_revision_signal(store, own, "ses").unwrap(),
            "the new memory advances the digest"
        );
    }
}
