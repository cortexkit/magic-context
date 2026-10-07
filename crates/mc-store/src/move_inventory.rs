//! Schema-pinned move inventory, generated from fresh context/store migration heads.
//!
//! New schema objects must be reviewed here before any exporter reads row data.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

pub const INVENTORY_VERSION: u32 = 2;
pub const CONTEXT_SCHEMA_VERSION: u32 = 95;
pub const STORE_SCHEMA_VERSION: u32 = 64;
pub const GLOBAL_USER_PROFILE_PROJECT_PATH: &str = "__global__";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Store {
    #[serde(rename = "context.db")]
    Context,
    #[serde(rename = "store.db")]
    Module,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Class {
    Ship,
    Rebuild,
    LocalReset,
    Deny,
    NotSession,
}

/// A predicate binds the host session id only, never a single harness value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowSelector {
    None,
    Predicate(&'static str),
    /// FTS internals have no independently session-addressable rows. Ownership
    /// and destination-populated checks go through this virtual parent instead.
    ShadowOf(&'static str),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyPolicy {
    /// The complete primary key includes the session coordinate.
    Preserve,
    /// A store-wide key is preserved, but a collision refuses before installation.
    /// Remapping requires a served-byte proof, including JSON references; none is
    /// assumed from an integer column or AUTOINCREMENT alone.
    PreserveOrRefuseCollision,
}

/// Selectors for the not-shipped render closure. Resolved identities, categories,
/// and the fingerprint come from resolveModuleWorkspaceContext, not a new resolver.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RenderInput {
    ProjectState,
    Memories,
    MemoryMutations,
    Workspace,
    WorkspaceMembers,
    IdentityAliases,
    UserProfile,
}

#[derive(Debug, Clone, Copy)]
pub struct TableInventory {
    pub store: Store,
    pub table: &'static str,
    pub class: Class,
    pub rows: RowSelector,
    /// PRAGMA table_xinfo order, including virtual-table hidden columns.
    pub columns: &'static [&'static str],
    pub deny_columns: &'static [&'static str],
    /// Primary-key order, not column order or host message-id order.
    pub primary_key: &'static [&'static str],
    pub key_policy: Option<KeyPolicy>,
    pub render_input: Option<RenderInput>,
}

impl TableInventory {
    pub fn shipped_columns(&self) -> Vec<&'static str> {
        if self.class != Class::Ship {
            return Vec::new();
        }
        self.columns
            .iter()
            .copied()
            .filter(|column| !self.deny_columns.contains(column))
            .collect()
    }
}

macro_rules! table {
    ($store:ident, $table:literal, $class:ident, $rows:expr, $keys:expr, $columns:expr, $deny:expr, $policy:expr, $render:expr) => {
        TableInventory {
            store: Store::$store,
            table: $table,
            class: Class::$class,
            rows: $rows,
            primary_key: $keys,
            columns: $columns,
            deny_columns: $deny,
            key_policy: $policy,
            render_input: $render,
        }
    };
}

/// Stable table order for the v1 stream; each store half is filtered from this
/// explicit list. Schema discovery is validation only and never grants shipping.
pub const TABLES: &[TableInventory] = &[
    table!(
        Module,
        "mc_move_tag_epochs",
        NotSession,
        RowSelector::None,
        &["session_id"],
        &["session_id", "generation"],
        &[],
        None,
        None
    ),
    table!(
        Module,
        "cortexkit_fence",
        NotSession,
        RowSelector::None,
        &["id"],
        &["id", "epoch"],
        &[],
        None,
        None
    ),
    table!(
        Module,
        "mc_move_fences",
        NotSession,
        RowSelector::None,
        &["session_id"],
        &["session_id", "cut_id", "phase"],
        &[],
        None,
        None
    ),
    table!(
        Module,
        "mc_move_cuts",
        NotSession,
        RowSelector::None,
        &["cut_id"],
        &[
            "cut_id",
            "session_id",
            "binding",
            "manifest_digest",
            "state",
            "result",
            "file_path",
            "discard_table"
        ],
        &[],
        None,
        None
    ),
    table!(
        Module,
        "mc_move_installs",
        NotSession,
        RowSelector::None,
        &["cut_id"],
        &[
            "cut_id",
            "session_id",
            "manifest_digest",
            "table_index",
            "file_offset",
            "rows_remaining",
            "last_source_key",
            "complete",
            "prior_generation",
            "shipped_generation",
            "tag_count",
            "max_tag_number"
        ],
        &[],
        None,
        None
    ),
    table!(
        Module,
        "mc_move_key_map",
        NotSession,
        RowSelector::None,
        &["cut_id", "table_name", "source_key"],
        &["cut_id", "table_name", "source_key", "destination_key"],
        &[],
        None,
        None
    ),
    // BEGIN FRESH-MIGRATION CENSUS
    // context.db: 106 tables observed after fresh migration.
    table!(
        Context,
        "authority_capture_bounds",
        NotSession,
        RowSelector::None,
        &["project_path", "domain"],
        &[
            "project_path",
            "domain",
            "max_rowid",
            "data_version",
            "captured_at",
            "mutation_epoch"
        ],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "authority_managed",
        NotSession,
        RowSelector::None,
        &["project_path"],
        &["project_path", "context_store_uuid", "marked_at"],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "authority_repair_pending",
        NotSession,
        RowSelector::None,
        &["project_path"],
        &["project_path", "started_at"],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "compartment_chunk_embeddings",
        Rebuild,
        RowSelector::Predicate("session_id = ?1"),
        &["id"],
        &[
            "id",
            "compartment_id",
            "session_id",
            "project_path",
            "harness",
            "window_index",
            "start_ordinal",
            "end_ordinal",
            "chunk_hash",
            "model_id",
            "dims",
            "vector",
            "created_at"
        ],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "compartment_events",
        Ship,
        RowSelector::Predicate("session_id = ?1"),
        &["id"],
        &[
            "id",
            "session_id",
            "compartment_id",
            "kind",
            "at_compartment",
            "fields_json",
            "created_at",
            "harness"
        ],
        &[],
        Some(KeyPolicy::PreserveOrRefuseCollision),
        None
    ),
    table!(
        Context,
        "compartment_history_versions",
        Ship,
        RowSelector::Predicate("session_id = ?1"),
        &["session_id"],
        &[
            "session_id",
            "generation",
            "version",
            "rewrite_version",
            "seeded"
        ],
        &[],
        Some(KeyPolicy::Preserve),
        None
    ),
    table!(
        Context,
        "compartment_state_lease",
        LocalReset,
        RowSelector::Predicate("session_id = ?1"),
        &["session_id"],
        &[
            "session_id",
            "holder_id",
            "owner_pid",
            "acquired_at",
            "expires_at"
        ],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "compartments",
        Ship,
        RowSelector::Predicate("session_id = ?1"),
        &["id"],
        &[
            "id",
            "session_id",
            "sequence",
            "start_message",
            "end_message",
            "start_message_id",
            "end_message_id",
            "start_block_index",
            "end_block_index",
            "title",
            "content",
            "p1",
            "p2",
            "p3",
            "p4",
            "importance",
            "episode_type",
            "p1_embedding",
            "p1_embedding_model_id",
            "legacy",
            "created_at",
            "harness",
            "rebase_status"
        ],
        &[],
        Some(KeyPolicy::PreserveOrRefuseCollision),
        None
    ),
    table!(
        Context,
        "compression_depth",
        Ship,
        RowSelector::Predicate("session_id = ?1"),
        &["session_id", "message_ordinal"],
        &["session_id", "message_ordinal", "depth", "harness"],
        &[],
        Some(KeyPolicy::Preserve),
        None
    ),
    table!(
        Context,
        "context_privilege_state",
        NotSession,
        RowSelector::None,
        &["id"],
        &["id", "enabled"],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "context_store_meta",
        NotSession,
        RowSelector::None,
        &["key"],
        &["key", "value"],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "domain_mutation_epoch",
        NotSession,
        RowSelector::None,
        &["project_path", "domain"],
        &["project_path", "domain", "epoch"],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "dream_queue",
        NotSession,
        RowSelector::None,
        &["id"],
        &[
            "id",
            "project_path",
            "reason",
            "enqueued_at",
            "started_at",
            "retry_count"
        ],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "dream_runs",
        NotSession,
        RowSelector::None,
        &["id"],
        &[
            "id",
            "project_path",
            "started_at",
            "finished_at",
            "holder_id",
            "tasks_json",
            "tasks_succeeded",
            "tasks_failed",
            "smart_notes_surfaced",
            "smart_notes_pending",
            "memory_changes_json",
            "parent_session_id"
        ],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "dream_state",
        NotSession,
        RowSelector::None,
        &["key"],
        &["key", "value"],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "embedding_identity_active",
        NotSession,
        RowSelector::None,
        &["project_path", "scope", "model_id"],
        &["project_path", "scope", "model_id", "last_active_at"],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "embedding_measurement_corpus",
        LocalReset,
        RowSelector::Predicate("session_id = ?1"),
        &["id"],
        &[
            "id",
            "session_id",
            "project_path",
            "dedup_key",
            "cohort_key",
            "query_text_hash",
            "primary_result_ids_json",
            "shadow_result_ids_json",
            "primary_latency_ms",
            "shadow_latency_ms",
            "primary_failed",
            "shadow_failed",
            "primary_model_id",
            "shadow_model_id",
            "primary_fingerprint",
            "shadow_fingerprint",
            "primary_epoch",
            "shadow_epoch",
            "corpus_hash",
            "coverage_json",
            "created_at"
        ],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "embedding_registrations",
        NotSession,
        RowSelector::None,
        &["project_path"],
        &[
            "project_path",
            "provider_identity",
            "model_id",
            "chunk_model_id",
            "fingerprint",
            "table_epoch",
            "dims",
            "provenance_json",
            "generation",
            "updated_at"
        ],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "git_commit_embeddings",
        NotSession,
        RowSelector::None,
        &["sha", "model_id"],
        &["sha", "embedding", "model_id", "created_at"],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "git_commit_fts_rowid_map",
        NotSession,
        RowSelector::None,
        &["fts_rowid"],
        &["fts_rowid", "sha"],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "git_commits",
        NotSession,
        RowSelector::None,
        &["sha"],
        &[
            "sha",
            "project_path",
            "short_sha",
            "message",
            "author",
            "committed_at",
            "indexed_at"
        ],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "git_commits_fts",
        NotSession,
        RowSelector::None,
        &[],
        &["sha", "project_path", "message", "git_commits_fts", "rank"],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "git_commits_fts_config",
        NotSession,
        RowSelector::None,
        &["k"],
        &["k", "v"],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "git_commits_fts_content",
        NotSession,
        RowSelector::None,
        &["id"],
        &["id", "c0", "c1", "c2"],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "git_commits_fts_data",
        NotSession,
        RowSelector::None,
        &["id"],
        &["id", "block"],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "git_commits_fts_docsize",
        NotSession,
        RowSelector::None,
        &["id"],
        &["id", "sz"],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "git_commits_fts_idx",
        NotSession,
        RowSelector::None,
        &["segid", "term"],
        &["segid", "term", "pgno"],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "git_sweep_coordinator",
        NotSession,
        RowSelector::None,
        &["project_path"],
        &[
            "project_path",
            "lease_holder",
            "lease_expires_at",
            "last_swept_at"
        ],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "historian_runs",
        Ship,
        RowSelector::Predicate("session_id = ?1"),
        &["id"],
        &[
            "id",
            "session_id",
            "harness",
            "subagent_invocation_id",
            "run_kind",
            "status",
            "failure_reason",
            "chunk_start_ordinal",
            "chunk_end_ordinal",
            "unprocessed_from",
            "compartments_produced",
            "compartment_id_min",
            "compartment_id_max",
            "facts_emitted",
            "facts_by_category_json",
            "events_emitted",
            "importance_min",
            "importance_max",
            "importance_avg",
            "discarded_last",
            "legacy",
            "created_at"
        ],
        &[],
        Some(KeyPolicy::PreserveOrRefuseCollision),
        None
    ),
    table!(
        Context,
        "identity_merge_log",
        NotSession,
        RowSelector::None,
        &["id"],
        &[
            "id",
            "from_identity",
            "to_identity",
            "table_name",
            "row_id",
            "action",
            "target_row_id",
            "merged_at"
        ],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "lkg_slot_chunks",
        Ship,
        RowSelector::Predicate("session_id = ?1"),
        &["session_id", "chunk"],
        &["session_id", "chunk", "hash", "body"],
        &[],
        Some(KeyPolicy::Preserve),
        None
    ),
    table!(
        Context,
        "lkg_slots",
        Ship,
        RowSelector::Predicate("session_id = ?1"),
        &["session_id"],
        &[
            "session_id",
            "json_prefix_chars",
            "json_prefix_chunks",
            "json_prefix_hash",
            "input_id_seq",
            "input_content_digests",
            "input_content_signatures",
            "last_input_message_id",
            "model_key",
            "provider_key",
            "captured_at",
            "row_version",
            "capture_sequence"
        ],
        &[],
        Some(KeyPolicy::Preserve),
        None
    ),
    table!(
        Context,
        "m0_mutation_log",
        Ship,
        RowSelector::Predicate("session_id = ?1"),
        &["id"],
        &[
            "id",
            "session_id",
            "mutation_type",
            "target_id",
            "queued_at"
        ],
        &[],
        Some(KeyPolicy::PreserveOrRefuseCollision),
        None
    ),
    table!(
        Context,
        "memories",
        NotSession,
        RowSelector::None,
        &["id"],
        &[
            "id",
            "project_path",
            "category",
            "content",
            "normalized_hash",
            "importance",
            "scope",
            "shareable",
            "source_session_id",
            "source_type",
            "seen_count",
            "retrieval_count",
            "first_seen_at",
            "created_at",
            "updated_at",
            "last_seen_at",
            "last_retrieved_at",
            "status",
            "expires_at",
            "verification_status",
            "verified_at",
            "classified_at",
            "superseded_by_memory_id",
            "merged_from",
            "metadata_json",
            "mural_cue",
            "mural_cue_hash",
            "mural_cue_at",
            "mural_cue_rejection_count"
        ],
        &[],
        None,
        Some(RenderInput::Memories)
    ),
    table!(
        Context,
        "memories_fts",
        NotSession,
        RowSelector::None,
        &[],
        &["content", "category", "memories_fts", "rank"],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "memories_fts_config",
        NotSession,
        RowSelector::None,
        &["k"],
        &["k", "v"],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "memories_fts_data",
        NotSession,
        RowSelector::None,
        &["id"],
        &["id", "block"],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "memories_fts_docsize",
        NotSession,
        RowSelector::None,
        &["id"],
        &["id", "sz"],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "memories_fts_idx",
        NotSession,
        RowSelector::None,
        &["segid", "term"],
        &["segid", "term", "pgno"],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "memory_embedding_watermarks",
        NotSession,
        RowSelector::None,
        &["project_path"],
        &[
            "project_path",
            "written_memory_id",
            "embedded_memory_id",
            "updated_at"
        ],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "memory_embeddings",
        NotSession,
        RowSelector::None,
        &["memory_id", "model_id"],
        &["memory_id", "embedding", "model_id"],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "memory_mutation_log",
        NotSession,
        RowSelector::None,
        &["id"],
        &[
            "id",
            "project_path",
            "mutation_type",
            "target_memory_id",
            "superseded_by_id",
            "category",
            "new_content",
            "queued_at"
        ],
        &[],
        None,
        Some(RenderInput::MemoryMutations)
    ),
    table!(
        Context,
        "memory_verifications",
        NotSession,
        RowSelector::None,
        &["memory_id", "file_path"],
        &[
            "memory_id",
            "file_path",
            "verified_at",
            "mapped_at",
            "mapping_origin"
        ],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "message_fts_rowid_map",
        Rebuild,
        RowSelector::Predicate("session_id = ?1"),
        &["session_id", "message_ordinal"],
        &[
            "session_id",
            "message_ordinal",
            "fts_rowid",
            "message_time_ms"
        ],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "message_fts_rowid_map_backfill_state",
        NotSession,
        RowSelector::None,
        &["id"],
        &["id", "watermark_rowid", "completed", "updated_at"],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "message_history_fts",
        Rebuild,
        RowSelector::Predicate("session_id = ?1"),
        &[],
        &[
            "session_id",
            "message_ordinal",
            "message_id",
            "role",
            "content",
            "message_history_fts",
            "rank"
        ],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "message_history_fts_config",
        Rebuild,
        RowSelector::ShadowOf("message_history_fts"),
        &["k"],
        &["k", "v"],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "message_history_fts_content",
        Rebuild,
        RowSelector::ShadowOf("message_history_fts"),
        &["id"],
        &["id", "c0", "c1", "c2", "c3", "c4"],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "message_history_fts_data",
        Rebuild,
        RowSelector::ShadowOf("message_history_fts"),
        &["id"],
        &["id", "block"],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "message_history_fts_docsize",
        Rebuild,
        RowSelector::ShadowOf("message_history_fts"),
        &["id"],
        &["id", "sz"],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "message_history_fts_idx",
        Rebuild,
        RowSelector::ShadowOf("message_history_fts"),
        &["segid", "term"],
        &["segid", "term", "pgno"],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "message_history_index",
        Rebuild,
        RowSelector::Predicate("session_id = ?1"),
        &["session_id"],
        &[
            "session_id",
            "last_indexed_ordinal",
            "dirty_floor_ordinal",
            "updated_at",
            "harness"
        ],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "message_history_orphan_sweep",
        NotSession,
        RowSelector::None,
        &["harness"],
        &["harness", "cursor_session_id", "last_swept_at"],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "message_history_source",
        Rebuild,
        RowSelector::Predicate("session_id = ?1"),
        &["session_id", "message_id"],
        &[
            "session_id",
            "message_id",
            "message_ordinal",
            "source_version",
            "normalized_content_hash",
            "role",
            "harness",
            "updated_at"
        ],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "message_time_backfill_state",
        NotSession,
        RowSelector::None,
        &["id"],
        &[
            "id",
            "cursor_session_id",
            "cursor_ordinal",
            "completed",
            "updated_at"
        ],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "migration_pending",
        NotSession,
        RowSelector::None,
        &["migration_key"],
        &[
            "migration_key",
            "source_session_id",
            "target_harness",
            "pi_session_id",
            "final_path",
            "stage_path",
            "content_sha256",
            "phase",
            "created_at"
        ],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "mirror_cursors",
        NotSession,
        RowSelector::None,
        &["domain"],
        &["domain", "cursor", "updated_at"],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "mirror_identity",
        NotSession,
        RowSelector::None,
        &["domain", "module_project", "module_row_id"],
        &[
            "domain",
            "module_project",
            "module_row_id",
            "context_row_id"
        ],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "mirror_live_memory_rows",
        NotSession,
        RowSelector::None,
        &["module_project", "module_row_id"],
        &[
            "module_project",
            "module_row_id",
            "category",
            "normalized_hash",
            "full_row_snapshot"
        ],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "mirror_live_staging",
        NotSession,
        RowSelector::None,
        &["generation", "module_project", "module_row_id"],
        &[
            "generation",
            "module_project",
            "module_row_id",
            "category",
            "normalized_hash",
            "full_row_snapshot"
        ],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "mirror_note_revisions",
        NotSession,
        RowSelector::None,
        &["module_project", "module_row_id"],
        &[
            "module_project",
            "module_row_id",
            "context_row_id",
            "status_version"
        ],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "mirror_pending_references",
        NotSession,
        RowSelector::None,
        &["domain", "module_project", "module_row_id"],
        &[
            "domain",
            "module_project",
            "module_row_id",
            "target_module_row_id"
        ],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "mirror_resnapshot_state",
        NotSession,
        RowSelector::None,
        &["domain"],
        &["domain", "status", "updated_at", "generation"],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "mural_manifest",
        NotSession,
        RowSelector::None,
        &["project_path"],
        &[
            "project_path",
            "image",
            "content_hash",
            "rendered_at",
            "model",
            "memory_ids_json",
            "width",
            "height"
        ],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "notes",
        Ship,
        RowSelector::Predicate("session_id = ?1 AND type = 'session'"),
        &["id"],
        &[
            "id",
            "type",
            "status",
            "content",
            "session_id",
            "project_path",
            "surface_condition",
            "created_at",
            "updated_at",
            "last_checked_at",
            "ready_at",
            "ready_reason",
            "compiled_provider",
            "compiled_config",
            "compiled_at",
            "compile_status",
            "harness",
            "anchor_ordinal",
            "compiled_check",
            "manifest_json",
            "check_hash",
            "check_cron",
            "check_version",
            "check_status",
            "check_failure_count",
            "check_network_failure_count",
            "check_quarantined_until",
            "check_next_due_at",
            "check_compiled_at",
            "check_false_since_at",
            "check_last_liveness_at",
            "policy_version",
            "anchor_block_id"
        ],
        &[],
        Some(KeyPolicy::PreserveOrRefuseCollision),
        None
    ),
    table!(
        Context,
        "pending_ops",
        Ship,
        RowSelector::Predicate("session_id = ?1"),
        &["id"],
        &[
            "id",
            "session_id",
            "tag_id",
            "operation",
            "queued_at",
            "harness"
        ],
        &[],
        Some(KeyPolicy::PreserveOrRefuseCollision),
        None
    ),
    table!(
        Context,
        "pending_session_cleanup",
        LocalReset,
        RowSelector::Predicate("session_id = ?1"),
        &["session_id"],
        &["session_id", "harness", "requested_at", "last_attempt_at"],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "plugin_messages",
        Ship,
        RowSelector::Predicate("session_id = ?1"),
        &["id"],
        &[
            "id",
            "direction",
            "type",
            "payload",
            "session_id",
            "created_at",
            "consumed_at"
        ],
        &[],
        Some(KeyPolicy::PreserveOrRefuseCollision),
        None
    ),
    table!(
        Context,
        "primer_candidates",
        LocalReset,
        RowSelector::Predicate("session_id = ?1"),
        &["id"],
        &[
            "id",
            "project_path",
            "harness",
            "session_id",
            "question",
            "normalized_question",
            "source_compartment_start",
            "source_compartment_end",
            "source_start_message_id",
            "source_end_message_id",
            "source_message_time",
            "question_embedding",
            "question_embedding_model_id",
            "created_at"
        ],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "primers",
        NotSession,
        RowSelector::None,
        &["id"],
        &[
            "id",
            "project_path",
            "question",
            "question_embedding",
            "question_embedding_model_id",
            "answer",
            "status",
            "total_support",
            "last_observed_at",
            "answer_refreshed_at",
            "source_candidate_ids",
            "source_candidate_provenance",
            "created_at",
            "updated_at"
        ],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "primers_fts",
        NotSession,
        RowSelector::None,
        &[],
        &["question", "answer", "project_path", "primers_fts", "rank"],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "primers_fts_config",
        NotSession,
        RowSelector::None,
        &["k"],
        &["k", "v"],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "primers_fts_data",
        NotSession,
        RowSelector::None,
        &["id"],
        &["id", "block"],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "primers_fts_docsize",
        NotSession,
        RowSelector::None,
        &["id"],
        &["id", "sz"],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "primers_fts_idx",
        NotSession,
        RowSelector::None,
        &["segid", "term"],
        &["segid", "term", "pgno"],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "project_key_files",
        NotSession,
        RowSelector::None,
        &["project_path", "path"],
        &[
            "project_path",
            "path",
            "content",
            "content_hash",
            "local_token_estimate",
            "generated_at",
            "generated_by_model",
            "generation_config_hash",
            "stale_reason"
        ],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "project_key_files_version",
        NotSession,
        RowSelector::None,
        &["project_path"],
        &["project_path", "version"],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "project_state",
        NotSession,
        RowSelector::None,
        &["project_path"],
        &[
            "project_path",
            "project_memory_epoch",
            "project_user_profile_version",
            "updated_at"
        ],
        &[],
        None,
        Some(RenderInput::ProjectState)
    ),
    table!(
        Context,
        "recomp_compartments",
        Ship,
        RowSelector::Predicate("session_id = ?1"),
        &["id"],
        &[
            "id",
            "session_id",
            "sequence",
            "start_message",
            "end_message",
            "start_message_id",
            "end_message_id",
            "start_block_index",
            "end_block_index",
            "title",
            "content",
            "p1",
            "p2",
            "p3",
            "p4",
            "importance",
            "episode_type",
            "pass_number",
            "created_at",
            "harness",
            "rebase_status"
        ],
        &[],
        Some(KeyPolicy::PreserveOrRefuseCollision),
        None
    ),
    table!(
        Context,
        "recomp_facts",
        Ship,
        RowSelector::Predicate("session_id = ?1"),
        &["id"],
        &[
            "id",
            "session_id",
            "category",
            "content",
            "pass_number",
            "created_at",
            "harness"
        ],
        &[],
        Some(KeyPolicy::PreserveOrRefuseCollision),
        None
    ),
    table!(
        Context,
        "retrospective_processed_windows",
        NotSession,
        RowSelector::None,
        &["project_path", "window_key"],
        &["project_path", "window_key", "processed_at"],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "schema_migrations",
        NotSession,
        RowSelector::None,
        &["version"],
        &["version", "description", "applied_at"],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "schema_migrations_meta",
        NotSession,
        RowSelector::None,
        &["key"],
        &["key", "value"],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "session_facts",
        Ship,
        RowSelector::Predicate("session_id = ?1"),
        &["id"],
        &[
            "id",
            "session_id",
            "category",
            "content",
            "created_at",
            "updated_at",
            "harness"
        ],
        &[],
        Some(KeyPolicy::PreserveOrRefuseCollision),
        None
    ),
    table!(
        Context,
        "session_meta",
        Ship,
        RowSelector::Predicate("session_id = ?1"),
        &["session_id"],
        &[
            "session_id",
            "harness",
            "last_response_time",
            "cache_ttl",
            "counter",
            "tags_version",
            "last_nudge_tokens",
            "last_nudge_band",
            "last_nudge_undropped",
            "last_nudge_level",
            "channel2_nudge_state",
            "channel2_nudge_claimed_at",
            "channel2_nudge_claim_token",
            "last_emergency_input_sample",
            "last_transform_error",
            "nudge_anchor_message_id",
            "nudge_anchor_text",
            "sticky_turn_reminder_text",
            "sticky_turn_reminder_message_id",
            "note_nudge_trigger_pending",
            "note_nudge_trigger_message_id",
            "note_nudge_sticky_text",
            "note_nudge_sticky_message_id",
            "note_nudge_anchors",
            "auto_search_hint_decisions",
            "last_todo_state",
            "todo_permission_denied",
            "todo_synthetic_call_id",
            "todo_synthetic_anchor_message_id",
            "todo_synthetic_state_json",
            "is_subagent",
            "last_context_percentage",
            "last_input_tokens",
            "detected_context_limit_provenance",
            "observed_safe_input_tokens",
            "cache_alert_sent",
            "times_execute_threshold_reached",
            "compartment_in_progress",
            "historian_failure_count",
            "historian_last_error",
            "historian_last_failure_at",
            "system_prompt_hash",
            "memory_block_cache",
            "memory_block_count",
            "memory_block_ids",
            "pending_compaction_marker_state",
            "compaction_marker_target_end_message_id",
            "pending_pi_compaction_marker_state",
            "new_work_tokens",
            "total_input_tokens",
            "deferred_execute_state",
            "cached_m0_bytes",
            "cached_m0_project_memory_epoch",
            "cached_m0_workspace_fingerprint",
            "cached_m0_project_user_profile_version",
            "cached_m0_max_compartment_seq",
            "cached_m0_max_memory_id",
            "cached_m0_max_mutation_id",
            "cached_m0_max_memory_mutation_id",
            "cached_m0_project_docs_hash",
            "cached_m1_bytes",
            "last_observed_model_key",
            "last_usage_context_limit",
            "prior_boundary_ordinal",
            "protected_tokens_effective",
            "protected_tokens_pre_snapshot",
            "protected_tail_policy_version",
            "protected_tail_drain_window_started_at",
            "protected_tail_drain_tokens",
            "recovery_no_eligible_head_count",
            "force_emergency_bypass_window_start",
            "force_emergency_bypass_used",
            "emergency_drain_active",
            "historian_drain_failure_at",
            "wrapup_in_progress_state",
            "compaction_mode_record",
            "cached_m0_materialized_at",
            "cached_m0_session_facts_version",
            "cached_m0_upgrade_state",
            "cached_m0_system_hash",
            "cached_m0_tool_set_hash",
            "cached_m0_model_key",
            "cached_m0_project_identity",
            "cached_m0_last_baseline_end_message_id",
            "thinking_binding_recovery_target",
            "upgrade_reminded_at",
            "pi_stable_id_scheme",
            "note_last_read_at",
            "cleared_reasoning_through_tag",
            "tool_reclaim_watermark",
            "stripped_placeholder_ids",
            "stale_reduce_stripped_ids",
            "processed_image_stripped_ids",
            "merged_reasoning_stripped_ids",
            "trailing_blank_decisions",
            "system_prompt_tokens",
            "compaction_marker_state",
            "key_files",
            "conversation_tokens",
            "tool_call_tokens",
            "recomp_partial_range_start",
            "recomp_partial_range_end",
            "detected_context_limit",
            "detected_context_limit_model_key",
            "needs_emergency_recovery",
            "emergency_recovery_origin",
            "upgrade_reminder_last_sent_at",
            "upgrade_reminder_count",
            "cached_m0_mural_data_url",
            "cached_m0_mural_hash",
            "coordinate_generation",
            "coordinate_rebase_notice"
        ],
        &[],
        Some(KeyPolicy::Preserve),
        None
    ),
    table!(
        Context,
        "session_projects",
        Ship,
        RowSelector::Predicate("session_id = ?1"),
        &["session_id", "harness"],
        &["session_id", "harness", "project_path", "updated_at"],
        &[],
        Some(KeyPolicy::Preserve),
        None
    ),
    table!(
        Context,
        "session_replay_decisions",
        Ship,
        RowSelector::Predicate("session_id = ?1"),
        &["session_id", "message_id"],
        &["session_id", "message_id", "decision"],
        &[],
        Some(KeyPolicy::Preserve),
        None
    ),
    table!(
        Context,
        "shadow_embedding_registrations",
        NotSession,
        RowSelector::None,
        &["project_path", "scope", "model_id"],
        &[
            "project_path",
            "scope",
            "model_id",
            "generation",
            "fingerprint",
            "table_epoch",
            "dims",
            "provenance_json",
            "updated_at"
        ],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "single_store_state",
        NotSession,
        RowSelector::None,
        &["id"],
        &[
            "id",
            "state",
            "migrated_at",
            "migrated_by",
            "backup_dir",
            "report_json"
        ],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "source_contents",
        Ship,
        RowSelector::Predicate("session_id = ?1"),
        &["session_id", "tag_id"],
        &["tag_id", "session_id", "content", "created_at", "harness"],
        &[],
        Some(KeyPolicy::Preserve),
        None
    ),
    table!(
        Context,
        "sqlite_sequence",
        NotSession,
        RowSelector::None,
        &[],
        &["name", "seq"],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "sqlite_stat1",
        NotSession,
        RowSelector::None,
        &[],
        &["tbl", "idx", "stat"],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "subagent_invocations",
        Ship,
        RowSelector::Predicate("session_id = ?1"),
        &["id"],
        &[
            "id",
            "session_id",
            "harness",
            "subagent",
            "task",
            "provider_id",
            "model_id",
            "started_at",
            "ended_at",
            "status",
            "input_tokens",
            "output_tokens",
            "cache_read_tokens",
            "cache_write_tokens",
            "error",
            "parent_invocation_id"
        ],
        &[],
        Some(KeyPolicy::PreserveOrRefuseCollision),
        None
    ),
    table!(
        Context,
        "synapse_batch_ledger",
        LocalReset,
        RowSelector::Predicate("session_id = ?1"),
        &["id"],
        &[
            "id",
            "session_id",
            "project_path",
            "scope",
            "manifest_json",
            "request_key",
            "job_id",
            "cursor",
            "status",
            "created_at",
            "updated_at"
        ],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "tags",
        Ship,
        RowSelector::Predicate("session_id = ?1"),
        &["id"],
        &[
            "id",
            "session_id",
            "message_id",
            "type",
            "status",
            "byte_size",
            "tag_number",
            "harness",
            "entry_fingerprint",
            "token_count",
            "input_token_count",
            "reasoning_token_count",
            "reasoning_byte_size",
            "drop_mode",
            "tool_name",
            "input_byte_size",
            "caveman_depth",
            "tool_owner_message_id"
        ],
        &[],
        Some(KeyPolicy::PreserveOrRefuseCollision),
        None
    ),
    table!(
        Context,
        "task_schedule_state",
        NotSession,
        RowSelector::None,
        &["project_path", "task"],
        &[
            "project_path",
            "task",
            "last_run_at",
            "next_due_at",
            "schedule",
            "last_status",
            "last_error",
            "last_checked_commit",
            "last_broad_run_at",
            "retrospective_watermark_ms",
            "retry_count"
        ],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "temporal_decisions",
        Ship,
        RowSelector::Predicate("session_id = ?1"),
        &["session_id", "message_id"],
        &["session_id", "message_id", "marker"],
        &[],
        Some(KeyPolicy::Preserve),
        None
    ),
    table!(
        Context,
        "tool_definition_measurements",
        NotSession,
        RowSelector::None,
        &["provider_id", "model_id", "agent_name", "tool_id"],
        &[
            "provider_id",
            "model_id",
            "agent_name",
            "tool_id",
            "token_count",
            "recorded_at"
        ],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "tool_owner_backfill_state",
        Ship,
        RowSelector::Predicate("session_id = ?1"),
        &["session_id"],
        &[
            "session_id",
            "status",
            "started_at",
            "lease_expires_at",
            "completed_at",
            "last_error"
        ],
        &[],
        Some(KeyPolicy::Preserve),
        None
    ),
    table!(
        Context,
        "transform_decisions",
        Ship,
        RowSelector::Predicate("session_id = ?1"),
        &["session_id", "harness", "message_id"],
        &[
            "session_id",
            "harness",
            "message_id",
            "ts_ms",
            "decision",
            "materialized",
            "materialize_reason",
            "system_hash_prev",
            "system_hash_new",
            "m0_tool_set_hash_prev",
            "m0_tool_set_hash_new",
            "m0_model_key_prev",
            "m0_model_key_new",
            "emergency",
            "dropped_tokens",
            "dropped_count",
            "input_tokens"
        ],
        &[],
        Some(KeyPolicy::Preserve),
        None
    ),
    table!(
        Context,
        "user_memories",
        NotSession,
        RowSelector::None,
        &["id"],
        &[
            "id",
            "content",
            "status",
            "promoted_at",
            "source_candidate_ids",
            "source_candidate_provenance",
            "created_at",
            "updated_at"
        ],
        &[],
        None,
        Some(RenderInput::UserProfile)
    ),
    table!(
        Context,
        "user_memory_candidates",
        LocalReset,
        RowSelector::Predicate("session_id = ?1"),
        &["id"],
        &[
            "id",
            "content",
            "session_id",
            "source_compartment_start",
            "source_compartment_end",
            "created_at"
        ],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "v22_backfill_failures",
        NotSession,
        RowSelector::None,
        &["id"],
        &[
            "id",
            "table_name",
            "row_id",
            "raw_project_path",
            "error_class",
            "error_message",
            "failed_at"
        ],
        &[],
        None,
        None
    ),
    table!(
        Context,
        "v22_identity_rekey_map",
        NotSession,
        RowSelector::None,
        &["old_project_path"],
        &["old_project_path", "new_project_path", "rekeyed_at"],
        &[],
        None,
        Some(RenderInput::IdentityAliases)
    ),
    table!(
        Context,
        "workspace_members",
        NotSession,
        RowSelector::None,
        &["workspace_id", "project_path"],
        &[
            "workspace_id",
            "project_path",
            "display_name",
            "display_path",
            "added_at"
        ],
        &[],
        None,
        Some(RenderInput::WorkspaceMembers)
    ),
    table!(
        Context,
        "workspaces",
        NotSession,
        RowSelector::None,
        &["id"],
        &["id", "name", "created_at", "updated_at", "share_categories"],
        &[],
        None,
        Some(RenderInput::Workspace)
    ),
    // store.db: 32 tables observed after fresh migration.
    table!(
        Module,
        "mc_tags",
        Ship,
        RowSelector::Predicate("session_id = ?1"),
        &["session_id", "tag_number"],
        &[
            "session_id",
            "tag_number",
            "block_id",
            "kind",
            "token_count",
            "created_at_ms",
            "source_bytes"
        ],
        &[],
        Some(KeyPolicy::Preserve),
        None
    ),
    table!(
        Module,
        "cortexkit_schema_version",
        NotSession,
        RowSelector::None,
        &["namespace", "version"],
        &["namespace", "version", "applied_at_unix"],
        &[],
        None,
        None
    ),
    table!(
        Module,
        "mc_block_identities",
        Ship,
        RowSelector::Predicate("session_id = ?1"),
        &["session_id", "mid"],
        &["session_id", "mid", "identities"],
        &[],
        Some(KeyPolicy::Preserve),
        None
    ),
    table!(
        Module,
        "mc_cache_frozen_chunks",
        Ship,
        RowSelector::Predicate("session_id = ?1"),
        &["session_id", "chunk"],
        &["session_id", "chunk", "body"],
        &[],
        Some(KeyPolicy::Preserve),
        None
    ),
    table!(
        Module,
        "mc_cache_sections",
        Ship,
        RowSelector::Predicate("session_id = ?1"),
        &["session_id", "section"],
        &["session_id", "section", "body"],
        &[],
        Some(KeyPolicy::Preserve),
        None
    ),
    table!(
        Module,
        "mc_cache_state",
        Ship,
        RowSelector::Predicate("session_id = ?1"),
        &["session_id"],
        &[
            "session_id",
            "row_version",
            "core_state",
            "meta",
            "last_activity_at",
            "section_index"
        ],
        &[],
        Some(KeyPolicy::Preserve),
        None
    ),
    table!(
        Module,
        "mc_cache_state_digest",
        LocalReset,
        RowSelector::Predicate("session_id = ?1"),
        &["session_id"],
        &["session_id", "row_version", "row_state_fingerprint"],
        &[],
        None,
        None
    ),
    table!(
        Module,
        "mc_channel1_appends",
        Ship,
        RowSelector::Predicate("session_id = ?1"),
        &["session_id", "block_id"],
        &["session_id", "block_id", "reminder_text", "fired_at_ms"],
        &[],
        Some(KeyPolicy::Preserve),
        None
    ),
    table!(
        Module,
        "mc_chunk_transcripts",
        Ship,
        RowSelector::Predicate("session_id = ?1"),
        &["session_id", "compartment_seq"],
        &[
            "session_id",
            "compartment_seq",
            "start_ordinal",
            "end_ordinal",
            "transcript_deflate",
            "created_at_ms",
            "raw_messages_deflate"
        ],
        &[],
        Some(KeyPolicy::Preserve),
        None
    ),
    table!(
        Module,
        "mc_compartment_dates",
        Ship,
        RowSelector::Predicate("session_id = ?1"),
        &["session_id", "sequence"],
        &[
            "session_id",
            "sequence",
            "start_message_id",
            "end_message_id",
            "start_date",
            "end_date"
        ],
        &[],
        Some(KeyPolicy::Preserve),
        None
    ),
    table!(
        Module,
        "mc_dream_task_commands",
        LocalReset,
        RowSelector::Predicate("session_id = ?1"),
        &["session_id", "command_id"],
        &["session_id", "command_id", "response_json", "created_at"],
        &[],
        None,
        None
    ),
    table!(
        Module,
        "mc_facade_mutation_ledger",
        Ship,
        RowSelector::Predicate("identity_scope = ?1"),
        &["identity_scope", "tool", "action", "command_id"],
        &[
            "identity_scope",
            "tool",
            "action",
            "command_id",
            "response_json",
            "created_at_ms"
        ],
        &[],
        Some(KeyPolicy::Preserve),
        None
    ),
    table!(
        Module,
        "mc_historian_pending_run",
        LocalReset,
        RowSelector::Predicate("session_id = ?1"),
        &["run_id"],
        &[
            "run_id",
            "session_id",
            "project_path",
            "firing_seq",
            "chunk_fingerprint",
            "phase",
            "attempt",
            "claimant_instance_id",
            "coordinator_token",
            "claim_deadline_ms",
            "lease_ms",
            "deadline_ms",
            "system_prompt",
            "user_prompt",
            "model_chain",
            "await_budget_ms",
            "historian_timeout_ms",
            "created_at_ms",
            "updated_at_ms",
            "report_kind",
            "report_text",
            "report_length_capped",
            "report_error_code",
            "report_error_message",
            "reported_at_ms"
        ],
        &[],
        None,
        None
    ),
    table!(
        Module,
        "mc_historian_side_channel_outbox",
        Ship,
        RowSelector::Predicate("session_id = ?1"),
        &[
            "session_id",
            "firing_seq",
            "kind",
            "source_start",
            "source_end",
            "item_index"
        ],
        &[
            "session_id",
            "firing_seq",
            "kind",
            "source_start",
            "source_end",
            "item_index",
            "payload_json",
            "attempt_count",
            "next_attempt_at_ms",
            "last_attempt_at_ms",
            "last_error",
            "delivered_at_ms",
            "created_at_ms"
        ],
        &[],
        Some(KeyPolicy::Preserve),
        None
    ),
    table!(
        Module,
        "mc_overlay_frontiers",
        Ship,
        RowSelector::Predicate("session_id = ?1"),
        &["session_id"],
        &["session_id", "max_seen_ordinal"],
        &[],
        Some(KeyPolicy::Preserve),
        None
    ),
    table!(
        Module,
        "mc_pass_trace",
        Ship,
        RowSelector::Predicate("session_id = ?1"),
        &["session_id"],
        &[
            "session_id",
            "last_received_at_ms",
            "last_completed_at_ms",
            "last_reject_error",
            "last_reject_at_ms",
            "reject_count",
            "receive_count",
            "first_divergence",
            "last_divergence",
            "last_publish_duration_us",
            "max_publish_duration_us",
            "publish_sample_count",
            "scheduler_next_seq",
            "interesting_next_seq",
            "request_next_seq"
        ],
        &[],
        Some(KeyPolicy::Preserve),
        None
    ),
    table!(
        Module,
        "mc_pass_trace_history",
        Ship,
        RowSelector::Predicate("session_id = ?1"),
        &["session_id", "kind", "slot"],
        &["session_id", "kind", "slot", "seq", "entry"],
        &[],
        Some(KeyPolicy::Preserve),
        None
    ),
    table!(
        Module,
        "mc_privilege_state",
        NotSession,
        RowSelector::None,
        &["id"],
        &[
            "id",
            "facade_authority_domain",
            "facade_authority_route",
            "note_caller_project",
            "single_store",
            "single_store_set_at_ms",
            "single_store_set_by"
        ],
        &[],
        None,
        None
    ),
    table!(
        Module,
        "mc_project_mural_artifacts",
        NotSession,
        RowSelector::None,
        &["project_path"],
        &["project_path", "data_url", "content_hash", "updated_at"],
        &[],
        None,
        None
    ),
    table!(
        Module,
        "mc_recomp_commands",
        Ship,
        RowSelector::Predicate("session_id = ?1"),
        &["session_id", "command_id"],
        &["session_id", "command_id", "disposition", "created_at"],
        &[],
        Some(KeyPolicy::Preserve),
        None
    ),
    table!(
        Module,
        "mc_reduce_command_ledger",
        Ship,
        RowSelector::Predicate("session_id = ?1"),
        &["session_id", "command_id"],
        &[
            "session_id",
            "command_id",
            "queued_at_ms",
            "first_applied_at_ms",
            "disposition"
        ],
        &[],
        Some(KeyPolicy::Preserve),
        None
    ),
    table!(
        Module,
        "mc_served_output_fingerprints",
        Ship,
        RowSelector::Predicate("session_id = ?1"),
        &["session_id", "position"],
        &[
            "session_id",
            "position",
            "block_id",
            "content_hash",
            "serialized_len"
        ],
        &[],
        Some(KeyPolicy::Preserve),
        None
    ),
    table!(
        Module,
        "mc_single_store_pending_publish",
        LocalReset,
        RowSelector::Predicate("session_id = ?1"),
        &["session_id"],
        &["session_id", "publish_json", "created_at"],
        &[],
        None,
        None
    ),
    table!(
        Module,
        "mc_state_imports",
        Ship,
        RowSelector::Predicate("session_id = ?1"),
        &["session_id"],
        &[
            "session_id",
            "import_id",
            "imported_count",
            "completed_at_ms"
        ],
        &[],
        Some(KeyPolicy::Preserve),
        None
    ),
    table!(
        Module,
        "mc_tag_cache_generations",
        Ship,
        RowSelector::Predicate("session_id = ?1"),
        &["session_id"],
        &["session_id", "generation", "tag_count", "max_tag_number"],
        &[],
        Some(KeyPolicy::Preserve),
        None
    ),
    table!(
        Module,
        "mc_temporal_marks",
        Ship,
        RowSelector::Predicate("session_id = ?1"),
        &["session_id", "block_id"],
        &["session_id", "block_id", "marker_text", "created_at"],
        &[],
        Some(KeyPolicy::Preserve),
        None
    ),
    table!(
        Module,
        "mc_transform_session_roots",
        Ship,
        RowSelector::Predicate("session_id = ?1"),
        &["session_id", "project_root"],
        &["session_id", "project_root", "observed_at"],
        &[],
        Some(KeyPolicy::Preserve),
        None
    ),
    table!(
        Module,
        "mc_user_hints",
        Ship,
        RowSelector::Predicate("session_id = ?1"),
        &["session_id", "block_id"],
        &["session_id", "block_id", "hint_text", "created_at"],
        &[],
        Some(KeyPolicy::Preserve),
        None
    ),
    table!(
        Module,
        "mc_wrapup_commands",
        Ship,
        RowSelector::Predicate("session_id = ?1"),
        &["session_id", "command_id"],
        &[
            "session_id",
            "command_id",
            "disposition",
            "rounds",
            "summary",
            "created_at"
        ],
        &[],
        Some(KeyPolicy::Preserve),
        None
    ),
    table!(
        Module,
        "pending_agent_drops",
        Ship,
        RowSelector::Predicate("session_id = ?1"),
        &["id"],
        &["id", "session_id", "target_id", "queued_at", "command_id"],
        &[],
        Some(KeyPolicy::PreserveOrRefuseCollision),
        None
    ),
    table!(
        Module,
        "shadow_divergences",
        Ship,
        RowSelector::Predicate("session_id = ?1"),
        &["id"],
        &[
            "id",
            "session_id",
            "pass_seq",
            "class",
            "first_mid",
            "first_block",
            "first_field",
            "ts_prefix",
            "rs_prefix",
            "normalizations",
            "ts_decision",
            "rs_decision",
            "state_hash",
            "created_at",
            "first_diff_offset",
            "ts_window",
            "rs_window"
        ],
        &[],
        Some(KeyPolicy::PreserveOrRefuseCollision),
        None
    ),
    table!(
        Module,
        "sqlite_sequence",
        NotSession,
        RowSelector::None,
        &[],
        &["name", "seq"],
        &[],
        None,
        None
    ),
    // END FRESH-MIGRATION CENSUS
];

pub fn tables(store: Store) -> impl Iterator<Item = &'static TableInventory> {
    TABLES.iter().filter(move |entry| entry.store == store)
}

pub fn entry(store: Store, table: &str) -> Option<&'static TableInventory> {
    tables(store).find(|entry| entry.table == table)
}

/// SQLite owns this namespace, including optional ANALYZE outputs. These tables
/// are always not_session and are never read for a snapshot or render digest.
pub fn is_sqlite_internal(table: &str) -> bool {
    table.to_ascii_lowercase().starts_with("sqlite_")
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InventoryUnclassified {
    pub store: Store,
    pub table: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<String>,
}

#[derive(Debug)]
pub enum InventoryError {
    Unclassified(InventoryUnclassified),
    Sqlite(rusqlite::Error),
}

impl std::fmt::Display for InventoryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unclassified(detail) => write!(
                f,
                "inventory_unclassified {}",
                serde_json::to_string(detail).expect("inventory detail is serializable")
            ),
            Self::Sqlite(error) => write!(f, "inventory schema read failed: {error}"),
        }
    }
}
impl std::error::Error for InventoryError {}
impl From<rusqlite::Error> for InventoryError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Sqlite(value)
    }
}

fn quoted(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

/// Call on both capture read transactions before reading rows or admitting any
/// record. The caller checks schema versions separately. table_xinfo is needed:
/// table_info alone hides virtual/generated columns from the drift fence.
pub fn validate_schema(conn: &Connection, store: Store) -> Result<(), InventoryError> {
    let names = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for table in names {
        if is_sqlite_internal(&table) {
            continue;
        }
        let definition = entry(store, &table).ok_or_else(|| {
            InventoryError::Unclassified(InventoryUnclassified {
                store,
                table: table.clone(),
                column: None,
            })
        })?;
        let columns = conn
            .prepare(&format!("PRAGMA table_xinfo({})", quoted(&table)))?
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for column in columns {
            if !definition.columns.contains(&column.as_str()) {
                return Err(InventoryError::Unclassified(InventoryUnclassified {
                    store,
                    table,
                    column: Some(column),
                }));
            }
        }
    }
    Ok(())
}

/// The host resolves these using the same pass inputs as loadModuleWatermarks.
/// No rows in this closure ship as session state; they are only digest inputs.
#[derive(Debug)]
pub struct RenderScope<'a> {
    pub project_path: Option<&'a str>,
    pub canonical_identities: &'a [String],
    pub expanded_identities: &'a [String],
    pub own_identities: &'a [String],
    pub share_categories: Option<&'a [String]>,
    pub workspace_fingerprint: Option<&'a str>,
    pub expiry_cutoff_ms: i64,
}

impl RenderInput {
    /// Named parameters use JSON arrays to avoid variable placeholder counts.
    /// Mutation rows intentionally have no category/status filter: the watermark
    /// includes every mutation under expandedIdentities, including visibility loss.
    pub fn predicate(self) -> &'static str {
        match self {
            Self::ProjectState =>
                "project_path = :project OR project_path = :global OR project_path IN (SELECT value FROM json_each(:canonical))",
            Self::Memories =>
                "project_path IN (SELECT value FROM json_each(:expanded)) AND status IN ('active','permanent') AND (expires_at IS NULL OR expires_at > :now_ms) AND (:categories IS NULL OR project_path IN (SELECT value FROM json_each(:own)) OR (category IN (SELECT value FROM json_each(:categories)) AND shareable = 1 AND scope IN ('project','ecosystem','universe')))",
            Self::MemoryMutations =>
                "project_path IN (SELECT value FROM json_each(:expanded))",
            Self::Workspace =>
                "id IN (SELECT workspace_id FROM workspace_members WHERE project_path = :project)",
            Self::WorkspaceMembers =>
                "workspace_id IN (SELECT workspace_id FROM workspace_members WHERE project_path = :project)",
            Self::IdentityAliases =>
                "new_project_path IN (SELECT value FROM json_each(:canonical))",
            Self::UserProfile => "status = 'active'",
        }
    }
}

/// Return stable ordered rowids for a digest reader. All current render-input
/// tables have rowids; a future WITHOUT ROWID input needs an explicit selector.
/// The digest encoder must also include scope.workspace_fingerprint (including
/// the distinction between null/no workspace and a fingerprint).
pub fn render_input_rowids(
    conn: &Connection,
    definition: &TableInventory,
    scope: &RenderScope<'_>,
) -> rusqlite::Result<Vec<i64>> {
    let Some(selector) = definition.render_input else {
        return Ok(Vec::new());
    };
    let sql = format!(
        "WITH scope AS (SELECT :project, :global, :canonical, :expanded, :own, :categories, :now_ms) SELECT rowid FROM {} WHERE {} ORDER BY {}",
        quoted(definition.table),
        selector.predicate(),
        definition.primary_key.iter().map(|key| quoted(key)).collect::<Vec<_>>().join(", "),
    );
    let canonical = serde_json::to_string(scope.canonical_identities).unwrap();
    let expanded = serde_json::to_string(scope.expanded_identities).unwrap();
    let own = serde_json::to_string(scope.own_identities).unwrap();
    let categories = scope
        .share_categories
        .map(|value| serde_json::to_string(value).unwrap());
    conn.prepare(&sql)?
        .query_map(
            rusqlite::named_params! {
                ":project": scope.project_path,
                ":global": GLOBAL_USER_PROFILE_PROJECT_PATH,
                ":canonical": canonical,
                ":expanded": expanded,
                ":own": own,
                ":categories": categories,
                ":now_ms": scope.expiry_cutoff_ms,
            },
            |row| row.get(0),
        )?
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
    use rusqlite::params;
    use std::collections::BTreeSet;
    use std::path::PathBuf;
    use std::process::Command;

    /// The repository root: the migration scripts below run the TypeScript
    /// schema from `packages/plugin`, two levels above this crate.
    fn root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .canonicalize()
            .unwrap()
    }

    // Each test runs the real migration chains in a throwaway root, not a copy
    // of the inventory or a schema reconstructed from its column list.
    fn fresh_stores() -> (tempfile::TempDir, Connection, Connection) {
        let root = root();
        let dir = tempfile::tempdir_in(root.join("target")).unwrap();
        let script = r#"
            import { Database } from './packages/plugin/src/shared/sqlite';
            import { initializeDatabase, LATEST_SUPPORTED_VERSION } from './packages/plugin/src/features/magic-context/storage-db';
            import { runMigrations } from './packages/plugin/src/features/magic-context/migrations';
            const db = new Database(process.env.MOVE_TEST_CONTEXT);
            initializeDatabase(db); runMigrations(db);
            if (LATEST_SUPPORTED_VERSION !== 95 || db.prepare('SELECT MAX(version) AS v FROM schema_migrations WHERE version < 10000').get().v !== 95) throw new Error('update the schema-pinned inventory');
            db.close();
        "#;
        let output = Command::new("bun")
            .current_dir(&root)
            .args(["-e", script])
            .env("MOVE_TEST_CONTEXT", dir.path().join("context.db"))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        drop(
            crate::McStore::open(&StorageDescriptor {
                module_id: "magic-context".into(),
                storage_namespace: "mc_cache".into(),
                isolation: Isolation::Module,
                backend: StorageBackend::Sqlite {
                    path: dir.path().join("store.db").to_string_lossy().into_owned(),
                },
            })
            .unwrap(),
        );
        assert_eq!(crate::LATEST_MIGRATION_VERSION, STORE_SCHEMA_VERSION);
        let context = Connection::open(dir.path().join("context.db")).unwrap();
        let module = Connection::open(dir.path().join("store.db")).unwrap();
        (dir, context, module)
    }

    #[test]
    fn fresh_migrations_classify_every_table_column_and_primary_key() {
        let (_dir, context, module) = fresh_stores();
        for (store, conn) in [(Store::Context, &context), (Store::Module, &module)] {
            validate_schema(conn, store).unwrap();
            let actual: BTreeSet<String> = conn
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
                .unwrap()
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            let expected: BTreeSet<String> =
                tables(store).map(|item| item.table.to_owned()).collect();
            assert_eq!(
                expected.len(),
                tables(store).count(),
                "duplicate inventory entry"
            );
            assert_eq!(actual, expected);
            for definition in tables(store) {
                let columns: Vec<(String, i64)> = conn
                    .prepare(&format!("PRAGMA table_xinfo({})", quoted(definition.table)))
                    .unwrap()
                    .query_map([], |row| Ok((row.get(1)?, row.get(5)?)))
                    .unwrap()
                    .collect::<Result<_, _>>()
                    .unwrap();
                assert_eq!(
                    columns
                        .iter()
                        .map(|(column, _)| column.as_str())
                        .collect::<Vec<_>>(),
                    definition.columns,
                    "{}",
                    definition.table
                );
                let mut keys: Vec<_> = columns.iter().filter(|(_, index)| *index > 0).collect();
                keys.sort_by_key(|(_, index)| *index);
                assert_eq!(
                    keys.iter()
                        .map(|(column, _)| column.as_str())
                        .collect::<Vec<_>>(),
                    definition.primary_key
                );
                assert!(definition
                    .deny_columns
                    .iter()
                    .all(|column| definition.columns.contains(column)));
                assert_eq!(
                    definition.key_policy.is_some(),
                    definition.class == Class::Ship
                );
                if definition.class == Class::Ship {
                    assert!(matches!(definition.rows, RowSelector::Predicate(_)));
                    assert!(!definition.primary_key.is_empty());
                }
                if definition.render_input.is_some() {
                    assert_eq!(definition.class, Class::NotSession);
                }
                if definition.class != Class::Ship {
                    assert!(definition.shipped_columns().is_empty());
                }
            }
        }
        for dropped in [
            "mc_compartments",
            "mc_compartment_events",
            "mc_notes",
            "mc_memories",
            "mc_workspace_members",
            "mc_project_state",
        ] {
            assert!(entry(Store::Module, dropped).is_none());
        }
    }

    fn assert_unclassified(conn: &Connection, store: Store, table: &str, column: Option<&str>) {
        match validate_schema(conn, store).expect_err("schema drift must refuse before admission") {
            InventoryError::Unclassified(detail) => assert_eq!(
                detail,
                InventoryUnclassified {
                    store,
                    table: table.to_owned(),
                    column: column.map(str::to_owned),
                }
            ),
            error => panic!("unexpected error: {error}"),
        }
    }

    #[test]
    fn a2_context_new_table_with_session_id_refuses() {
        let (_dir, context, _module) = fresh_stores();
        context
            .execute_batch("CREATE TABLE a2_context_session_probe (session_id TEXT, secret TEXT)")
            .unwrap();
        assert_unclassified(&context, Store::Context, "a2_context_session_probe", None);
    }

    #[test]
    fn a2_module_new_table_with_session_id_refuses() {
        let (_dir, _context, module) = fresh_stores();
        module
            .execute_batch("CREATE TABLE a2_module_session_probe (session_id TEXT, secret TEXT)")
            .unwrap();
        assert_unclassified(&module, Store::Module, "a2_module_session_probe", None);
    }

    #[test]
    fn a2_context_new_table_without_session_id_refuses() {
        let (_dir, context, _module) = fresh_stores();
        context
            .execute_batch("CREATE TABLE a2_context_global_probe (secret TEXT)")
            .unwrap();
        assert_unclassified(&context, Store::Context, "a2_context_global_probe", None);
    }

    #[test]
    fn a2_module_new_table_without_session_id_refuses() {
        let (_dir, _context, module) = fresh_stores();
        module
            .execute_batch("CREATE TABLE a2_module_global_probe (secret TEXT)")
            .unwrap();
        assert_unclassified(&module, Store::Module, "a2_module_global_probe", None);
    }

    #[test]
    fn a2_context_new_shipped_column_refuses() {
        let (_dir, context, _module) = fresh_stores();
        context
            .execute_batch("ALTER TABLE tags ADD COLUMN future_secret TEXT")
            .unwrap();
        assert_unclassified(&context, Store::Context, "tags", Some("future_secret"));
    }

    #[test]
    fn a2_module_new_shipped_column_refuses() {
        let (_dir, _context, module) = fresh_stores();
        module
            .execute_batch("ALTER TABLE mc_tags ADD COLUMN future_secret TEXT")
            .unwrap();
        assert_unclassified(&module, Store::Module, "mc_tags", Some("future_secret"));
    }

    #[test]
    fn excluded_tables_and_generated_columns_still_have_a_drift_fence() {
        let (_dir, context, module) = fresh_stores();
        context
            .execute_batch("ALTER TABLE project_state ADD COLUMN secret TEXT")
            .unwrap();
        assert_unclassified(&context, Store::Context, "project_state", Some("secret"));
        module.execute_batch("ALTER TABLE mc_cache_state ADD COLUMN generated_secret TEXT GENERATED ALWAYS AS (session_id) VIRTUAL").unwrap();
        assert_unclassified(
            &module,
            Store::Module,
            "mc_cache_state",
            Some("generated_secret"),
        );
    }

    #[test]
    fn analyze_and_sqlite_internal_tables_do_not_trip_drift() {
        let (_dir, context, module) = fresh_stores();
        for (store, conn) in [(Store::Context, context), (Store::Module, module)] {
            conn.execute_batch("ANALYZE").unwrap();
            assert!(conn
                .query_row(
                    "SELECT 1 FROM sqlite_master WHERE name = 'sqlite_stat1'",
                    [],
                    |_| Ok(())
                )
                .is_ok());
            validate_schema(&conn, store).unwrap();
            for definition in tables(store).filter(|item| is_sqlite_internal(item.table)) {
                assert_eq!(definition.class, Class::NotSession);
            }
        }
        assert!(is_sqlite_internal("sqlite_stat4"));
        assert!(is_sqlite_internal("sqlite_future_internal"));
        assert!(!is_sqlite_internal("sqliteXsecret"));
    }

    #[test]
    fn session_classes_and_row_predicates_preserve_all_harnesses_not_smart_notes() {
        let (_dir, context, module) = fresh_stores();
        let script = r#"
            import { SESSION_SCOPED_TABLES } from './packages/plugin/src/features/magic-context/storage-session-tables';
            console.log(JSON.stringify(SESSION_SCOPED_TABLES.map(row => row.table)));
        "#;
        let output = Command::new("bun")
            .current_dir(root())
            .args(["-e", script])
            .output()
            .unwrap();
        assert!(output.status.success());
        let session_tables: Vec<String> = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(session_tables.len(), 34);
        for table in session_tables {
            assert!(matches!(
                entry(Store::Context, &table).unwrap().class,
                Class::Ship | Class::Rebuild | Class::LocalReset
            ));
        }
        context.execute_batch("INSERT INTO session_projects VALUES ('s','opencode','git:a',0), ('s','opencode:rust','git:a',0), ('other','pi','git:a',0);
            INSERT INTO notes (id,type,status,content,session_id,project_path,created_at,updated_at) VALUES
            (1,'session','active','session','s','git:a',0,0), (2,'smart','active','smart','s','git:a',0,0), (3,'session','active','other','other','git:a',0,0)").unwrap();
        for (table, expected) in [("session_projects", 2), ("notes", 1)] {
            let RowSelector::Predicate(predicate) = entry(Store::Context, table).unwrap().rows
            else {
                panic!("missing predicate")
            };
            let count: i64 = context
                .query_row(
                    &format!("SELECT COUNT(*) FROM {} WHERE {predicate}", quoted(table)),
                    ["s"],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(count, expected);
        }
        assert_eq!(
            entry(Store::Module, "shadow_divergences").unwrap().class,
            Class::Ship
        );
        assert_eq!(
            entry(Store::Module, "mc_historian_side_channel_outbox")
                .unwrap()
                .class,
            Class::Ship
        );
        let ledger = entry(Store::Module, "mc_facade_mutation_ledger").unwrap();
        assert_eq!(ledger.class, Class::Ship);
        module.execute_batch("INSERT INTO mc_facade_mutation_ledger VALUES ('s','ctx_memory','write','c',X'01',0), ('other','ctx_memory','write','c',X'02',0)").unwrap();
        let RowSelector::Predicate(predicate) = ledger.rows else {
            panic!("missing ledger predicate")
        };
        assert_eq!(
            module
                .query_row(
                    &format!("SELECT COUNT(*) FROM mc_facade_mutation_ledger WHERE {predicate}"),
                    ["s"],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        for table in ["mc_privilege_state", "mc_project_mural_artifacts"] {
            assert_eq!(
                entry(Store::Module, table).unwrap().class,
                Class::NotSession
            );
        }
        assert!(entry(Store::Context, "credential").is_none());
        assert!(entry(Store::Module, "credential").is_none());
    }

    #[test]
    fn render_selectors_cover_workspace_aliases_mutations_and_global_profile() {
        let (_dir, context, _module) = fresh_stores();
        context.execute_batch("INSERT INTO workspaces VALUES (1,'shared',0,0,'[\"architecture\"]'), (2,'unrelated',0,0,'[]');
            INSERT INTO workspace_members VALUES (1,'git:own','own','/own',0), (1,'git:member','member','/member',0), (2,'git:other','other','/other',0);
            INSERT INTO v22_identity_rekey_map VALUES ('dir:alias','git:own',0), ('dir:other','git:other',0);
            INSERT INTO project_state VALUES ('git:own',1,0,0), ('git:member',2,0,0), ('__global__',0,3,0), ('git:other',4,0,0);
            INSERT INTO user_memories (id,content,status,promoted_at,created_at,updated_at) VALUES (1,'global profile','active',0,0,0), (2,'inactive profile','archived',0,0,0)").unwrap();
        let seeds = [
            (1, "git:own", "unshared", "private", 0, "active", None),
            (2, "dir:alias", "unshared", "private", 0, "permanent", None),
            (
                3,
                "git:member",
                "architecture",
                "ecosystem",
                1,
                "active",
                None,
            ),
            (4, "git:member", "other", "project", 1, "active", None),
            (
                5,
                "git:member",
                "architecture",
                "project",
                0,
                "active",
                None,
            ),
            (
                6,
                "git:member",
                "architecture",
                "private",
                1,
                "active",
                None,
            ),
            (7, "git:own", "architecture", "project", 1, "archived", None),
            (
                8,
                "git:member",
                "architecture",
                "project",
                1,
                "active",
                Some(100),
            ),
            (9, "git:other", "architecture", "project", 1, "active", None),
        ];
        for (id, project, category, scope, shareable, status, expires) in seeds {
            context.execute("INSERT INTO memories (id,project_path,category,content,normalized_hash,scope,shareable,status,expires_at,first_seen_at,created_at,updated_at,last_seen_at) VALUES (?1,?2,?3,?4,?4,?5,?6,?7,?8,0,0,0,0)", params![id,project,category,format!("sentinel-{id}"),scope,shareable,status,expires]).unwrap();
            context.execute("INSERT INTO memory_mutation_log (id,project_path,mutation_type,target_memory_id,category,queued_at) VALUES (?1,?2,'update',?1,?3,0)", params![id,project,category]).unwrap();
        }
        let canonical = vec!["git:own".into(), "git:member".into()];
        let expanded = vec!["git:own".into(), "dir:alias".into(), "git:member".into()];
        let own = vec!["git:own".into(), "dir:alias".into()];
        let categories = vec!["architecture".into()];
        let mut scope = RenderScope {
            project_path: Some("git:own"),
            canonical_identities: &canonical,
            expanded_identities: &expanded,
            own_identities: &own,
            share_categories: Some(&categories),
            workspace_fingerprint: Some("resolved-by-host"),
            expiry_cutoff_ms: 100,
        };
        let selected = |table: &str, scope: &RenderScope<'_>| {
            render_input_rowids(&context, entry(Store::Context, table).unwrap(), scope).unwrap()
        };
        assert_eq!(selected("memories", &scope), [1, 2, 3]);
        // Mutation high-watermarks include hidden and expired transitions too.
        assert_eq!(
            selected("memory_mutation_log", &scope),
            [1, 2, 3, 4, 5, 6, 7, 8]
        );
        // project_state rows are ordered by their text PK, not insertion rowid.
        assert_eq!(selected("project_state", &scope), [3, 2, 1]);
        assert_eq!(selected("workspaces", &scope), [1]);
        assert_eq!(selected("workspace_members", &scope), [2, 1]);
        assert_eq!(selected("v22_identity_rekey_map", &scope), [1]);
        assert_eq!(selected("user_memories", &scope), [1]);
        assert!(selected("primers", &scope).is_empty());
        scope.share_categories = Some(&[]);
        assert_eq!(selected("memories", &scope), [1, 2]);
        scope.share_categories = None;
        assert_eq!(selected("memories", &scope), [1, 2, 3, 4, 5, 6]);
        let empty = vec![];
        scope.project_path = None;
        scope.canonical_identities = &empty;
        scope.expanded_identities = &empty;
        scope.own_identities = &empty;
        scope.workspace_fingerprint = None;
        assert!(selected("memories", &scope).is_empty());
        assert!(selected("memory_mutation_log", &scope).is_empty());
        assert!(selected("workspaces", &scope).is_empty());
        assert_eq!(selected("project_state", &scope), [3]);
        assert_eq!(selected("user_memories", &scope), [1]);
    }
}
