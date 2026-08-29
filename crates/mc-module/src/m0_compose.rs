//! The store → m0 byte producer for the HARD branch: read a session's durable state
//! (compartments, memories or the workspace union, user-profile, project-docs) and
//! compose the frozen m0 baseline bytes plus the watermarks the HARD persists.
//!
//! This is the BYTE producer only — it does not classify or decide HARD-vs-SOFT (that's
//! `apply_once`, which feeds these bytes into the cache core). It is pure given the store
//! contents + `now_ms` + `budget`: same inputs → same bytes, the property the frozen-m0
//! cache depends on. The expiry cutoff (`now_ms`) is passed in (frozen at the HARD by the
//! caller, never read here from a live clock) so a later defer replays identical bytes.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use mc_store::{McStore, McStoreError, MemoryRevision};
use sha2::{Digest, Sha256};

use crate::compartment_coverage::{resolve_coverage, CoverageGap};
use crate::decay_render::{extract_m0_block, DecayRenderCompartment};
use crate::memory_render::{render_m0, render_memory_line, workspace_source_names, M0Inputs};
use crate::project_docs::read_project_docs_canonical;

pub(crate) const MEMORY_MURAL_BLOCK: &str =
    "<memory-mural>\nThe project memory mural image follows.\n</memory-mural>";

/// Why composing the HARD m0 from the store failed.
#[derive(Debug)]
pub enum M0ComposeError {
    /// A store read failed.
    Store(McStoreError),
    /// The stored compartment ranges overlap or otherwise fail strict ordering.
    CoverageGap(CoverageGap),
}

impl std::fmt::Display for M0ComposeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            M0ComposeError::Store(e) => write!(f, "store: {e}"),
            M0ComposeError::CoverageGap(g) => write!(f, "{g}"),
        }
    }
}
impl std::error::Error for M0ComposeError {}
impl From<McStoreError> for M0ComposeError {
    fn from(e: McStoreError) -> Self {
        M0ComposeError::Store(e)
    }
}

/// The composed m0 baseline: its frozen bytes plus the watermarks the HARD persists into
/// [`mc_store::ModuleMeta`] atomically with those bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct M0Composition {
    /// The frozen m0 baseline bytes (docs + profile + decayed compartments + memories).
    pub m0_bytes: String,
    /// Optional image block appended after the m0 text block on the OpenCode wire.
    pub mural: Option<M0MuralBlock>,
    /// The last raw message id covered by m0 — the cache/revert anchor. Empty when the
    /// session has no compartments (nothing summarized → no covered prefix → the whole
    /// live array is the tail).
    pub boundary_id: String,
    /// The last covered ordinal (the m0 coverage end / tail-trim point). None when there
    /// are no compartments.
    pub coverage_ordinal: Option<u64>,
    /// The FIRST covered ordinal (the leading edge of m0 coverage = the first compartment's
    /// start). None when there are no compartments. The caller fails loud if any live item
    /// sits BELOW this — it would be covered by no compartment yet trimmed as covered (a
    /// silent leading-gap drop).
    pub first_covered_ordinal: Option<u64>,
    /// The highest compartment sequence folded into m0 (advances only on a HARD).
    pub folded_compartment_seq: i64,
    /// The memory ids actually rendered into m0 (the supersede manifest), after the
    /// deterministic budget trim.
    pub rendered_memory_ids: Vec<i64>,
    /// The mutation-log cursor as of this HARD (corrections at/below it are folded in).
    pub memory_mutation_cursor: i64,
    /// The highest memory id folded into m0.
    pub max_memory_id: i64,
    /// Source revision captured in the same SQLite snapshot as the rendered rows.
    pub memory_revision: MemoryRevision,
    /// The canonical project-docs hash, a SNAPSHOT MARKER persisted with the bytes (NOT a
    /// HARD trigger — see `M0ContentEpoch`). Records which docs version is in m0 so the
    /// next natural HARD re-reads current docs.
    pub docs_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct M0MuralInput {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub supports_vision: bool,
    #[serde(default)]
    pub data_url: Option<String>,
    #[serde(default, alias = "content_epoch")]
    pub content_hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct M0MuralBlock {
    pub data_url: String,
    pub content_hash: String,
}

/// The fixed expiry/budget inputs for an m0 compose, threaded from the caller so the
/// HARD freezes them (a defer replays the same bytes, never re-reading a live clock or
/// config).
pub struct M0ComposeInputs<'a> {
    pub session_id: &'a str,
    /// The project the store reads key off (resolved from the route binding, never the
    /// request body).
    pub project_path: &'a str,
    /// The project directory on disk, for reading ARCHITECTURE.md / STRUCTURE.md.
    pub project_directory: &'a str,
    /// The expiry cutoff, FROZEN at the HARD (a memory expiring after this still renders;
    /// a later defer uses the same cutoff → identical bytes).
    pub now_ms: i64,
    /// The history budget in tokens selected for this frozen render decision. The decay
    /// renderer fits the compartments to it; under a loose budget the render is estimator-independent.
    pub history_budget_tokens: f64,
    /// System-role content that is no longer in the live tail because the current fold
    /// covers its ordinal. Passing it explicitly keeps m0 composition deterministic and
    /// replayable.
    pub covered_system_messages: &'a [String],
    /// Disabled memory removes both project memories and the user-profile memory block.
    pub memory_enabled: bool,
    /// Maximum token estimate for the grouped project-memory block.
    pub memory_budget_tokens: f64,
    /// Maximum token estimate for the user-profile block.
    pub user_profile_budget_tokens: f64,
    /// Whether the TypeScript materializer would include the project-docs block.
    pub inject_docs: bool,
    /// Gate temporal heading dates at render time, including rows persisted by a prior pass.
    pub temporal_awareness: bool,
    /// OpenCode-only image bytes already resolved and capability-gated by the host.
    pub mural: Option<&'a M0MuralInput>,
}

pub(crate) fn resolved_mural(input: Option<&M0MuralInput>) -> Option<M0MuralBlock> {
    let input = input?;
    if !input.enabled || !input.supports_vision {
        return None;
    }
    let data_url = input
        .data_url
        .as_deref()
        .filter(|value| !value.is_empty())?
        .to_string();
    let content_hash = input
        .content_hash
        .as_deref()
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("{:x}", Sha256::digest(data_url.as_bytes())));
    Some(M0MuralBlock {
        data_url,
        content_hash,
    })
}

fn memory_selection_order(
    left: &mc_store::StoredMemory,
    right: &mc_store::StoredMemory,
) -> Ordering {
    let left_permanent = left.status == "permanent";
    let right_permanent = right.status == "permanent";
    if left_permanent != right_permanent {
        return right_permanent.cmp(&left_permanent);
    }
    right
        .importance
        .unwrap_or(i32::MIN)
        .cmp(&left.importance.unwrap_or(i32::MIN))
        .then_with(|| left.id.cmp(&right.id))
}

fn memory_candidate_cost(
    memory: &mc_store::StoredMemory,
    categories: &HashSet<String>,
    source_names: &HashMap<i64, String>,
    estimate_tokens: impl Fn(&str) -> usize + Copy,
) -> f64 {
    let line = render_memory_line(memory, source_names.get(&memory.id).map(String::as_str));
    let mut total = estimate_tokens(&(line + "\n"));
    if !categories.contains(&memory.category) {
        total += estimate_tokens(&format!("<{}>\n</{}>\n", memory.category, memory.category));
    }
    total as f64
}

#[allow(clippy::too_many_arguments)]
fn admit_memory(
    memory: mc_store::StoredMemory,
    member_used: &mut f64,
    selected: &mut Vec<mc_store::StoredMemory>,
    selected_ids: &mut HashSet<i64>,
    categories: &mut HashSet<String>,
    used: &mut f64,
    budget: f64,
    source_names: &HashMap<i64, String>,
    estimate_tokens: impl Fn(&str) -> usize + Copy,
) -> bool {
    if selected_ids.contains(&memory.id) {
        return false;
    }
    let candidate_cost = memory_candidate_cost(&memory, categories, source_names, estimate_tokens);
    if *used + candidate_cost > budget {
        return false;
    }
    *used += candidate_cost;
    *member_used += candidate_cost;
    categories.insert(memory.category.clone());
    selected_ids.insert(memory.id);
    selected.push(memory);
    true
}

/// Select the same grouped-block candidates as TypeScript: permanent memories first,
/// then importance descending and id (the durable recency tie-break) ascending. Workspace
/// renders additionally reserve an equal floor for each member before filling leftovers.
pub(crate) fn trim_memories_to_budget(
    memories: Vec<mc_store::StoredMemory>,
    membership: Option<&mc_store::WorkspaceMembership>,
    source_names: &HashMap<i64, String>,
    budget_tokens: f64,
    estimate_tokens: impl Fn(&str) -> usize + Copy,
) -> Vec<mc_store::StoredMemory> {
    let budget = budget_tokens.max(1.0);
    let wrapper_cost = estimate_tokens("<project-memory>\n</project-memory>");
    let mut selected = Vec::new();
    let mut selected_ids = HashSet::new();
    let mut used = wrapper_cost as f64;
    let mut categories = HashSet::<String>::new();

    let mut ordered = memories;
    ordered.sort_by(memory_selection_order);
    if let Some(workspace) = membership {
        for memory in ordered.iter().filter(|memory| memory.status == "permanent") {
            let mut ignored = 0.0;
            admit_memory(
                memory.clone(),
                &mut ignored,
                &mut selected,
                &mut selected_ids,
                &mut categories,
                &mut used,
                budget,
                source_names,
                estimate_tokens,
            );
        }
        let floor = (budget - used).max(0.0) / workspace.union_identities.len().max(1) as f64;
        for identity in &workspace.union_identities {
            let mut member_used = 0.0;
            for memory in ordered
                .iter()
                .filter(|memory| memory.project_path == *identity && memory.status != "permanent")
            {
                let candidate_cost =
                    memory_candidate_cost(memory, &categories, source_names, estimate_tokens);
                if member_used + candidate_cost > floor {
                    continue;
                }
                admit_memory(
                    memory.clone(),
                    &mut member_used,
                    &mut selected,
                    &mut selected_ids,
                    &mut categories,
                    &mut used,
                    budget,
                    source_names,
                    estimate_tokens,
                );
            }
        }
        for memory in ordered {
            let mut ignored = 0.0;
            admit_memory(
                memory,
                &mut ignored,
                &mut selected,
                &mut selected_ids,
                &mut categories,
                &mut used,
                budget,
                source_names,
                estimate_tokens,
            );
        }
    } else {
        for memory in ordered {
            let mut ignored = 0.0;
            admit_memory(
                memory,
                &mut ignored,
                &mut selected,
                &mut selected_ids,
                &mut categories,
                &mut used,
                budget,
                source_names,
                estimate_tokens,
            );
        }
    }
    selected
}

pub(crate) fn trim_user_profile_to_budget(
    profile: Vec<String>,
    budget_tokens: f64,
    estimate_tokens: impl Fn(&str) -> usize + Copy,
) -> Vec<String> {
    let mut used = 0usize;
    profile
        .into_iter()
        .filter(|content| {
            let cost = estimate_tokens(&format!("- {content}")) + 4;
            if (used + cost) as f64 > budget_tokens.max(1.0) {
                return false;
            }
            used += cost;
            true
        })
        .collect()
}

/// Count only the rendered `<session-history>` slice, matching the history budget's scope.
fn history_slice_tokens(m0_text: &str, estimate_tokens: impl Fn(&str) -> usize) -> usize {
    extract_m0_block(m0_text, "session-history").map_or(0, |slice| estimate_tokens(&slice))
}

/// Render m0 and, when the history slice overshoots, tighten decay pressure at most three times.
/// The capped final render is retained even when its history still exceeds the slack threshold.
fn render_m0_with_decay_pressure_retry(
    inputs: &M0Inputs<'_>,
    estimate_tokens: impl Fn(&str) -> usize + Copy,
) -> String {
    let render = |decay_pressure_multiplier| {
        render_m0(
            &M0Inputs {
                project_docs: inputs.project_docs,
                user_profile: inputs.user_profile,
                covered_system_messages: inputs.covered_system_messages,
                compartments: inputs.compartments,
                memories: inputs.memories,
                source_name_by_id: inputs.source_name_by_id,
                history_budget_tokens: inputs.history_budget_tokens,
                decay_pressure_multiplier,
            },
            estimate_tokens,
        )
    };
    let mut decay_pressure_multiplier = 1.0;
    let mut m0_bytes = render(decay_pressure_multiplier);
    let mut attempts = 0;
    while inputs.history_budget_tokens > 0.0
        && history_slice_tokens(&m0_bytes, estimate_tokens) as f64
            > inputs.history_budget_tokens * 1.05
        && attempts < 3
    {
        decay_pressure_multiplier *= 1.15;
        m0_bytes = render(decay_pressure_multiplier);
        attempts += 1;
    }
    m0_bytes
}

/// Read the store and compose the HARD m0 bytes + watermarks. `estimate_tokens` is the
/// token estimator used for every injection budget and the history fit.
pub fn compose_m0_from_store(
    store: &McStore,
    inputs: &M0ComposeInputs<'_>,
    estimate_tokens: impl Fn(&str) -> usize + Copy,
) -> Result<M0Composition, M0ComposeError> {
    // --- compartments: the session history, coverage anchor, and folded watermark ---
    let compartments = store.load_compartments(inputs.session_id)?;
    // Store-pure coverage checks enforce strict ordering without assuming integer
    // contiguity: consumer producers may retire ordinal numbers permanently. The
    // transform layer has the live array and fails loud if a present message below
    // the coverage end is not covered by any compartment.
    let coverage = resolve_coverage(&compartments).map_err(M0ComposeError::CoverageGap)?;
    let (boundary_id, coverage_ordinal, first_covered_ordinal, folded_compartment_seq) =
        match &coverage {
            Some(c) => (
                c.boundary_id.clone(),
                Some(c.coverage_end_ordinal),
                Some(c.first_covered_ordinal),
                c.max_sequence,
            ),
            // no compartments → nothing summarized → no covered prefix
            None => (String::new(), None, None, 0),
        };

    // --- memories: rows and watermarks share one SQLite snapshot ---
    let membership = store.resolve_workspace_membership(inputs.project_path)?;
    let snapshot = if inputs.memory_enabled {
        store.load_memory_render_snapshot(
            inputs.project_path,
            membership.as_ref(),
            inputs.now_ms,
        )?
    } else {
        mc_store::MemoryRenderSnapshot {
            memories: Vec::new(),
            revision: MemoryRevision::default(),
        }
    };
    let source_name_by_id = membership
        .as_ref()
        .map(|value| workspace_source_names(&snapshot.memories, value))
        .unwrap_or_else(HashMap::new);
    let selected_memories = trim_memories_to_budget(
        snapshot.memories,
        membership.as_ref(),
        &source_name_by_id,
        inputs.memory_budget_tokens,
        estimate_tokens,
    );
    let rendered_memory_ids: Vec<i64> = selected_memories.iter().map(|memory| memory.id).collect();
    let max_memory_id = snapshot.revision.max_memory_id;
    let memory_mutation_cursor = snapshot.revision.mutation_cursor;

    // --- user-profile + project-docs ---
    let user_profile = if inputs.memory_enabled {
        store.load_active_user_memories()?
    } else {
        Vec::new()
    };
    let user_profile = trim_user_profile_to_budget(
        user_profile,
        inputs.user_profile_budget_tokens,
        estimate_tokens,
    );
    let docs = if inputs.inject_docs {
        read_project_docs_canonical(inputs.project_directory)
    } else {
        crate::project_docs::ProjectDocs::default()
    };

    // Compose m0 through the shared renderer after the project/profile budgets have selected
    // their candidates. History keeps its existing decay-pressure fit in this same render.
    let decay_compartments: Vec<DecayRenderCompartment> = compartments
        .iter()
        .map(|compartment| {
            let mut rendered = DecayRenderCompartment::from(compartment);
            if !inputs.temporal_awareness {
                rendered.start_date = None;
                rendered.end_date = None;
            }
            rendered
        })
        .collect();
    let mural = inputs
        .memory_enabled
        .then(|| resolved_mural(inputs.mural))
        .flatten();
    let mut m0_bytes = render_m0_with_decay_pressure_retry(
        &M0Inputs {
            project_docs: &docs.rendered_block,
            user_profile: &user_profile,
            covered_system_messages: inputs.covered_system_messages,
            compartments: &decay_compartments,
            memories: &selected_memories,
            source_name_by_id: &source_name_by_id,
            history_budget_tokens: inputs.history_budget_tokens,
            decay_pressure_multiplier: 1.0,
        },
        estimate_tokens,
    );
    if mural.is_some() {
        m0_bytes.push_str("\n\n");
        m0_bytes.push_str(MEMORY_MURAL_BLOCK);
    }

    Ok(M0Composition {
        m0_bytes,
        mural,
        boundary_id,
        coverage_ordinal,
        first_covered_ordinal,
        folded_compartment_seq,
        rendered_memory_ids,
        memory_mutation_cursor,
        max_memory_id,
        memory_revision: snapshot.revision,
        docs_hash: docs.canonical_hash,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::FixtureBuilder;
    use mc_store::{InsertMemoryInput, ModuleMeta, ModuleStateSyncRequest, StoredCompartment};

    fn no_estimate(_: &str) -> usize {
        0
    }

    fn seed_user_profile(store: &McStore, profile: &[String]) {
        store
            .apply_authority_state_sync(ModuleStateSyncRequest {
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
                compartments: &[],
                memories: &[],
                memory_mutations: &[],
                user_profile: profile,
                user_profile_present: true,
                workspace: None,
                workspace_present: false,
                last_todo_state: None,
                project_memory_epoch: None,
                user_profile_version: Some(1),
                acked_watermarks: serde_json::json!({}),
            })
            .unwrap();
    }

    fn comp(seq: i64, start: i64, end: i64, end_id: &str) -> StoredCompartment {
        StoredCompartment {
            sequence: seq,
            start_message: start,
            end_message: end,
            end_message_id: end_id.to_string(),
            title: format!("C{seq}"),
            content: format!("body{seq}"),
            p1: Some(format!("P1 of {seq}")),
            importance: 50,
            ..Default::default()
        }
    }

    #[test]
    fn mural_requires_enabled_vision_and_data_url() {
        let enabled = M0MuralInput {
            enabled: true,
            supports_vision: true,
            data_url: Some("data:image/png;base64,cG5n".to_string()),
            content_hash: Some("mural-epoch-a".to_string()),
        };
        assert_eq!(
            resolved_mural(Some(&enabled)),
            Some(M0MuralBlock {
                data_url: "data:image/png;base64,cG5n".to_string(),
                content_hash: "mural-epoch-a".to_string(),
            })
        );

        for disabled in [
            M0MuralInput {
                enabled: false,
                ..enabled.clone()
            },
            M0MuralInput {
                supports_vision: false,
                ..enabled.clone()
            },
            M0MuralInput {
                data_url: None,
                ..enabled.clone()
            },
        ] {
            assert!(resolved_mural(Some(&disabled)).is_none());
        }
    }

    #[test]
    fn composes_m0_from_compartments_with_coverage_anchor() {
        let fixture = FixtureBuilder::store();
        let dir = &fixture.dir;
        let store = &fixture.store;
        let project = "git:proj";
        let project_dir = dir.path().join("repo");
        std::fs::create_dir_all(&project_dir).unwrap();

        store
            .replace_compartments("ses_a", &[comp(1, 1, 10, "m10"), comp(2, 11, 20, "m20")])
            .unwrap();

        let inputs = M0ComposeInputs {
            session_id: "ses_a",
            project_path: project,
            project_directory: project_dir.to_str().unwrap(),
            now_ms: 0,
            history_budget_tokens: 60_000.0,
            covered_system_messages: &[],
            memory_enabled: true,
            memory_budget_tokens: 8_000.0,
            user_profile_budget_tokens: 4_000.0,
            inject_docs: true,
            temporal_awareness: true,
            mural: None,
        };
        let m0 = compose_m0_from_store(&store, &inputs, no_estimate).unwrap();

        // coverage anchors at the LAST compartment (the m0+m1 coverage end)
        assert_eq!(m0.boundary_id, "m20");
        assert_eq!(m0.coverage_ordinal, Some(20));
        assert_eq!(m0.folded_compartment_seq, 2);
        // Both compartments render as headings inside the stable session-history block.
        assert!(m0.m0_bytes.contains("<session-history>"), "{}", m0.m0_bytes);
        assert!(m0.m0_bytes.contains("## 1-10 · C1\nP1 of 1"));
        assert!(m0.m0_bytes.contains("## 11-20 · C2\nP1 of 2"));
        assert!(!m0.m0_bytes.contains("<compartment"));
    }

    #[test]
    fn disabled_docs_render_empty_block_and_hash_without_reading_files() {
        let fixture = FixtureBuilder::store();
        let dir = &fixture.dir;
        let store = &fixture.store;
        std::fs::write(dir.path().join("ARCHITECTURE.md"), "secret docs").unwrap();
        let inputs = M0ComposeInputs {
            session_id: "docs-off",
            project_path: "git:docs-off",
            project_directory: dir.path().to_str().unwrap(),
            now_ms: 0,
            history_budget_tokens: 60_000.0,
            covered_system_messages: &[],
            memory_enabled: true,
            memory_budget_tokens: 8_000.0,
            user_profile_budget_tokens: 4_000.0,
            inject_docs: false,
            temporal_awareness: true,
            mural: None,
        };
        let composed = compose_m0_from_store(&store, &inputs, no_estimate).unwrap();
        assert!(!composed.m0_bytes.contains("secret docs"));
        assert!(!composed.m0_bytes.contains("<project-docs>"));
        assert!(composed.docs_hash.is_empty());
    }

    #[test]
    fn no_compartments_yields_empty_boundary_and_placeholder_history() {
        let fixture = FixtureBuilder::store();
        let dir = &fixture.dir;
        let store = &fixture.store;
        let project_dir = dir.path().join("repo");
        std::fs::create_dir_all(&project_dir).unwrap();

        let inputs = M0ComposeInputs {
            session_id: "ses_empty",
            project_path: "git:proj",
            project_directory: project_dir.to_str().unwrap(),
            now_ms: 0,
            history_budget_tokens: 60_000.0,
            covered_system_messages: &[],
            memory_enabled: true,
            memory_budget_tokens: 8_000.0,
            user_profile_budget_tokens: 4_000.0,
            inject_docs: true,
            temporal_awareness: true,
            mural: None,
        };
        let m0 = compose_m0_from_store(&store, &inputs, no_estimate).unwrap();

        // nothing summarized → no covered prefix → empty anchor, the whole array is tail
        assert_eq!(m0.boundary_id, "");
        assert_eq!(m0.coverage_ordinal, None);
        assert_eq!(m0.folded_compartment_seq, 0);
        assert!(m0.rendered_memory_ids.is_empty());
    }

    #[test]
    fn memory_disabled_omits_memory_blocks_and_watermarks() {
        let fixture = FixtureBuilder::store();
        let dir = &fixture.dir;
        let store = &fixture.store;
        store
            .insert_memory(InsertMemoryInput {
                project_path: "git:proj",
                route_project_root: None,
                category: "CONSTRAINTS",
                content: "must stay hidden",
                source_session_id: None,
                source_type: Some("agent"),
                importance: Some(50),
                expires_at: None,
                metadata_json: None,
                now_ms: 1,
            })
            .unwrap();
        seed_user_profile(store, &["profile must stay hidden".to_string()]);
        let mural = M0MuralInput {
            enabled: true,
            supports_vision: true,
            data_url: Some("data:image/png;base64,cHJvZmlsZS1tdXJhbA==".to_string()),
            content_hash: Some("memory-off-mural".to_string()),
        };
        let inputs = M0ComposeInputs {
            session_id: "ses",
            project_path: "git:proj",
            project_directory: dir.path().to_str().unwrap(),
            now_ms: 2,
            history_budget_tokens: 60_000.0,
            covered_system_messages: &[],
            memory_enabled: false,
            memory_budget_tokens: 8_000.0,
            user_profile_budget_tokens: 4_000.0,
            inject_docs: true,
            temporal_awareness: true,
            mural: Some(&mural),
        };

        let composed = compose_m0_from_store(&store, &inputs, no_estimate).unwrap();
        assert!(!composed.m0_bytes.contains("must stay hidden"));
        assert!(!composed.m0_bytes.contains("<project-memory>"));
        assert!(!composed.m0_bytes.contains("<user-profile>"));
        assert!(!composed.m0_bytes.contains("profile must stay hidden"));
        assert!(!composed.m0_bytes.contains(MEMORY_MURAL_BLOCK));
        assert!(composed.mural.is_none());
        assert!(composed.rendered_memory_ids.is_empty());
        assert_eq!(composed.max_memory_id, 0);
        assert_eq!(composed.memory_mutation_cursor, 0);
    }

    #[test]
    fn sparse_coordinate_gap_composes_store_pure() {
        let fixture = FixtureBuilder::store();
        let dir = &fixture.dir;
        let store = &fixture.store;
        let project_dir = dir.path().join("repo");
        std::fs::create_dir_all(&project_dir).unwrap();

        // Store-only composition cannot tell whether 11-19 are retired ordinals
        // or present uncovered messages, so sparse coordinate gaps compose here.
        store
            .replace_compartments("ses_gap", &[comp(1, 1, 10, "m10"), comp(2, 20, 30, "m30")])
            .unwrap();
        let inputs = M0ComposeInputs {
            session_id: "ses_gap",
            project_path: "git:proj",
            project_directory: project_dir.to_str().unwrap(),
            now_ms: 0,
            history_budget_tokens: 60_000.0,
            covered_system_messages: &[],
            memory_enabled: true,
            memory_budget_tokens: 8_000.0,
            user_profile_budget_tokens: 4_000.0,
            inject_docs: true,
            temporal_awareness: true,
            mural: None,
        };
        let composed = compose_m0_from_store(&store, &inputs, no_estimate).unwrap();
        assert_eq!(composed.coverage_ordinal, Some(30));
        assert_eq!(composed.boundary_id, "m30");
    }

    fn pressure_compartments() -> Vec<StoredCompartment> {
        (1..=40).map(pressure_comp).collect()
    }

    fn pressure_comp(seq: i64) -> StoredCompartment {
        StoredCompartment {
            sequence: seq,
            start_message: seq,
            end_message: seq,
            end_message_id: format!("m{seq}"),
            title: format!("Pressure {seq}"),
            content: format!("legacy {seq}"),
            p1: Some(format!("P1 {seq} {}", "full ".repeat(40))),
            p2: Some(format!("P2 {seq} {}", "medium ".repeat(12))),
            p3: Some(format!("P3 {seq} {}", "brief ".repeat(4))),
            p4: Some(format!("P4 {seq}")),
            importance: 50,
            ..Default::default()
        }
    }

    #[test]
    fn retries_decay_pressure_when_history_slice_over_budget() {
        use std::cell::Cell;

        let fixture = FixtureBuilder::store();
        let store = &fixture.store;
        let project_dir = fixture.dir.path().join("repo");
        std::fs::create_dir_all(&project_dir).unwrap();
        let compartments = pressure_compartments();
        store
            .replace_compartments("pressure", &compartments)
            .unwrap();
        let inputs = M0ComposeInputs {
            session_id: "pressure",
            project_path: "git:pressure",
            project_directory: project_dir.to_str().unwrap(),
            now_ms: 0,
            history_budget_tokens: 300.0,
            covered_system_messages: &[],
            memory_enabled: false,
            memory_budget_tokens: 0.0,
            user_profile_budget_tokens: 0.0,
            inject_docs: false,
            temporal_awareness: true,
            mural: None,
        };
        let decay_compartments = compartments
            .iter()
            .map(DecayRenderCompartment::from)
            .collect::<Vec<_>>();
        let baseline = render_m0(
            &M0Inputs {
                project_docs: "",
                user_profile: &[],
                covered_system_messages: &[],
                compartments: &decay_compartments,
                memories: &[],
                source_name_by_id: &HashMap::new(),
                history_budget_tokens: inputs.history_budget_tokens,
                decay_pressure_multiplier: 1.0,
            },
            no_estimate,
        );
        let history_measurements = Cell::new(0usize);
        let estimator = |text: &str| {
            if text.starts_with("<session-history>") {
                history_measurements.set(history_measurements.get() + 1);
                1_000
            } else {
                0
            }
        };

        let composed = compose_m0_from_store(store, &inputs, estimator).unwrap();

        assert_eq!(
            history_measurements.get(),
            4,
            "one initial render plus the three bounded retries"
        );
        assert!(
            composed.m0_bytes.len() < baseline.len(),
            "retry pressure must select lower tiers than the initial render"
        );
    }

    fn pressure_render_compartments() -> Vec<DecayRenderCompartment> {
        let stored = pressure_compartments();
        stored.iter().map(DecayRenderCompartment::from).collect()
    }

    #[test]
    fn exact_history_slack_boundary_does_not_retry() {
        use std::cell::Cell;

        let compartments = pressure_render_compartments();
        let source_names = HashMap::new();
        let inputs = M0Inputs {
            project_docs: "",
            user_profile: &[],
            covered_system_messages: &[],
            compartments: &compartments,
            memories: &[],
            source_name_by_id: &source_names,
            history_budget_tokens: 300.0,
            decay_pressure_multiplier: 1.0,
        };
        let baseline = render_m0(&inputs, no_estimate);
        let history_measurements = Cell::new(0usize);
        let estimator = |text: &str| {
            if text.starts_with("<session-history>") {
                history_measurements.set(history_measurements.get() + 1);
                315
            } else {
                0
            }
        };

        let rendered = render_m0_with_decay_pressure_retry(&inputs, estimator);

        assert_eq!(history_measurements.get(), 1, "315 is exactly 1.05 × 300");
        assert_eq!(
            rendered, baseline,
            "the retry gate is strictly greater-than"
        );
    }

    #[test]
    fn zero_history_budget_skips_retry_measurement() {
        let compartments = pressure_render_compartments();
        let source_names = HashMap::new();
        let inputs = M0Inputs {
            project_docs: "",
            user_profile: &[],
            covered_system_messages: &[],
            compartments: &compartments,
            memories: &[],
            source_name_by_id: &source_names,
            history_budget_tokens: 0.0,
            decay_pressure_multiplier: 1.0,
        };
        let baseline = render_m0(&inputs, no_estimate);

        let rendered = render_m0_with_decay_pressure_retry(&inputs, |_| {
            panic!("zero budget must not measure the history slice")
        });

        assert_eq!(rendered, baseline);
    }

    #[test]
    fn retry_fixture_requires_two_pressure_bumps() {
        use std::cell::Cell;

        let compartments = pressure_render_compartments();
        let source_names = HashMap::new();
        let inputs = M0Inputs {
            project_docs: "",
            user_profile: &[],
            covered_system_messages: &[],
            compartments: &compartments,
            memories: &[],
            source_name_by_id: &source_names,
            history_budget_tokens: 300.0,
            decay_pressure_multiplier: 1.0,
        };
        let history_measurements = Cell::new(0usize);
        let estimator = |text: &str| {
            if text.starts_with("<session-history>") {
                let measurement = history_measurements.get() + 1;
                history_measurements.set(measurement);
                if measurement <= 2 {
                    1_000
                } else {
                    0
                }
            } else {
                0
            }
        };

        let rendered = render_m0_with_decay_pressure_retry(&inputs, estimator);
        let expected = render_m0(
            &M0Inputs {
                decay_pressure_multiplier: 1.15 * 1.15,
                ..inputs
            },
            no_estimate,
        );

        assert_eq!(
            history_measurements.get(),
            3,
            "the fixture must take two retries"
        );
        assert_eq!(rendered, expected, "each retry multiplies pressure by 1.15");
    }

    #[test]
    fn ts_retry_fixture_converges_to_the_same_tier_demotions() {
        #[derive(serde::Deserialize)]
        struct RetryFixture {
            budget: f64,
            attempts: usize,
            tier_counts: [usize; 5],
            m0_sha256: String,
        }

        let fixture: RetryFixture =
            serde_json::from_str(include_str!("../testdata/m0-decay-pressure-retry.json"))
                .expect("parse TS m0 retry fixture");
        let compartments = pressure_render_compartments();
        let source_names = HashMap::new();
        let inputs = M0Inputs {
            project_docs: "",
            user_profile: &[],
            covered_system_messages: &[],
            compartments: &compartments,
            memories: &[],
            source_name_by_id: &source_names,
            history_budget_tokens: fixture.budget,
            decay_pressure_multiplier: 1.0,
        };
        let history_measurements = std::cell::Cell::new(0usize);
        let estimator = |text: &str| {
            if text.starts_with("<session-history>") {
                history_measurements.set(history_measurements.get() + 1);
            }
            mc_tokenizer::estimate_tokens(text)
        };

        let rendered = render_m0_with_decay_pressure_retry(&inputs, estimator);
        let history = extract_m0_block(&rendered, "session-history").expect("history slice");
        let body = history
            .strip_prefix("<session-history>\n")
            .and_then(|value| value.strip_suffix("\n</session-history>"))
            .unwrap_or("");
        let sections = if body.is_empty() {
            Vec::new()
        } else {
            body.split("\n\n").collect::<Vec<_>>()
        };
        let mut tier_counts = [0usize; 5];
        for compartment in &compartments {
            let heading = format!(
                "## {}-{}",
                compartment.start_message, compartment.end_message
            );
            let section = sections
                .iter()
                .find(|section| section.starts_with(&heading))
                .copied();
            let tier = (1..=5u8)
                .find(|tier| {
                    crate::decay_render::render_compartment_at_tier(compartment, *tier).as_str()
                        == section.unwrap_or("")
                })
                .unwrap_or(5);
            tier_counts[tier as usize - 1] += 1;
        }

        assert_eq!(
            history_measurements.get(),
            fixture.attempts + 1,
            "the TS fixture's history slice must drive the same retry count"
        );
        assert_eq!(tier_counts, fixture.tier_counts);
        use sha2::{Digest, Sha256};
        let hash = Sha256::digest(rendered.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        assert_eq!(
            hash, fixture.m0_sha256,
            "m0 bytes drift from the TS fixture"
        );
    }

    #[test]
    fn determinism_same_inputs_same_bytes() {
        let fixture = FixtureBuilder::store();
        let dir = &fixture.dir;
        let store = &fixture.store;
        let project_dir = dir.path().join("repo");
        std::fs::create_dir_all(&project_dir).unwrap();
        store
            .replace_compartments("ses_d", &[comp(1, 1, 10, "m10")])
            .unwrap();
        let _ = ModuleMeta::default(); // (meta unused by the byte producer)
        let inputs = M0ComposeInputs {
            session_id: "ses_d",
            project_path: "git:proj",
            project_directory: project_dir.to_str().unwrap(),
            now_ms: 1000,
            history_budget_tokens: 60_000.0,
            covered_system_messages: &[],
            memory_enabled: true,
            memory_budget_tokens: 8_000.0,
            user_profile_budget_tokens: 4_000.0,
            inject_docs: true,
            temporal_awareness: true,
            mural: None,
        };
        let a = compose_m0_from_store(&store, &inputs, no_estimate).unwrap();
        let b = compose_m0_from_store(&store, &inputs, no_estimate).unwrap();
        assert_eq!(
            a.m0_bytes, b.m0_bytes,
            "same store + inputs → identical m0 bytes"
        );
    }
}
