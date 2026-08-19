//! Store-backed ctx_memory tool primitives.
//!
//! This module is intentionally route/identity agnostic: callers pass the already-resolved
//! project (and, for the session-aware search helper, session) that the daemon bound. Shared
//! visibility is read-only for primary agents; facade mutations require project ownership,
//! which the store rechecks inside the mutation transaction.

use std::collections::{BTreeSet, HashMap};

use mc_store::{
    McStore, McStoreError, StoredCompartmentSearchRow, StoredMemoryFull, StoredMemorySearchRow,
    StoredNoteSearchRow,
};

pub use mc_store::FOREIGN_VISIBLE_SQL;

#[derive(Debug)]
pub enum MemoryToolError {
    Store(McStoreError),
    EmptyContent,
    EmptyMerge,
    DuplicateSourceId {
        id: i64,
    },
    NotFound {
        id: i64,
    },
    Inactive {
        id: i64,
        status: String,
    },
    Superseded {
        id: i64,
        superseded_by: i64,
    },
    CrossCategoryMerge {
        categories: Vec<String>,
    },
    /// Cap on the `get` op's per-call id list (matches the plugin/pi twins). Returning a
    /// dedicated error lets the facade translate it into a clear user-facing message
    /// instead of papering over the difference with a generic "not found".
    TooManyIds {
        requested: usize,
        max: usize,
    },
    /// A `get` call with no ids is an input error distinct from merge validation, so the
    /// message names the read action instead of talking about merge sources.
    EmptyGet,
}

impl std::fmt::Display for MemoryToolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MemoryToolError::Store(e) => write!(f, "store: {e}"),
            MemoryToolError::EmptyContent => write!(f, "memory content is required"),
            MemoryToolError::EmptyMerge => write!(f, "merge requires at least one source memory"),
            MemoryToolError::DuplicateSourceId { id } => {
                write!(f, "duplicate source memory id {id}")
            }
            MemoryToolError::NotFound { id } => write!(f, "memory {id} was not found"),
            MemoryToolError::Inactive { id, status } => {
                write!(f, "memory {id} is not mutable in status {status}")
            }
            MemoryToolError::Superseded { id, superseded_by } => {
                write!(f, "memory {id} was superseded by {superseded_by}")
            }
            MemoryToolError::CrossCategoryMerge { categories } => write!(
                f,
                "cannot merge memories from different categories ({})",
                categories.join(", ")
            ),
            MemoryToolError::TooManyIds { requested, max } => write!(
                f,
                "'ids' must contain at most {max} memory IDs when action is 'get' (got {requested})"
            ),
            MemoryToolError::EmptyGet => {
                write!(
                    f,
                    "'ids' must contain at least one memory ID when action is 'get'"
                )
            }
        }
    }
}

impl std::error::Error for MemoryToolError {}
impl From<McStoreError> for MemoryToolError {
    fn from(e: McStoreError) -> Self {
        MemoryToolError::Store(e)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemorySearchSourceKind {
    Memory,
    CompartmentTitle,
    CompartmentBody,
    Note,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemorySearchResult {
    pub source_kind: MemorySearchSourceKind,
    /// Use the record's primary identifier: memory row id for memory results,
    /// compartment sequence for compartment results, and note id for note results.
    pub id: i64,
    pub snippet: String,
    pub category: Option<String>,
    pub sequence: Option<i64>,
    pub title: Option<String>,
    pub note_status: Option<String>,
    pub surface_condition: Option<String>,
}

#[derive(Debug)]
struct RankedSearchResult {
    result: MemorySearchResult,
    rank: u8,
    recency: i64,
}

/// Update an owned, primary (active/permanent and not superseded) memory.
pub fn update_memory(
    store: &McStore,
    project_path: &str,
    id: i64,
    content: &str,
    now_ms: i64,
) -> Result<StoredMemoryFull, MemoryToolError> {
    let content = content.trim();
    if content.is_empty() {
        return Err(MemoryToolError::EmptyContent);
    }
    let memory = load_owned_memory(store, project_path, id)?;
    ensure_primary_mutable(&memory)?;
    store
        .update_memory_content(project_path, id, content, now_ms)?
        .ok_or(MemoryToolError::NotFound { id })
}

/// Cap on the `get` op's per-call id list. Mirrors the plugin/pi twins so the same
/// user-facing "got 21 ids" error is produced regardless of which harness dispatches
/// the action.
pub const GET_MAX_IDS: usize = 20;

/// Read memories by id through the project's workspace-visibility scope.
///
/// Returns memories in the caller's id order; ids that are not visible to the project
/// (missing, hard-deleted, or foreign to a non-shared category) are absent from the
/// returned vector. The facade wrapper translates those misses into the per-id
/// "not found or not visible" message — sharing one wording between not-found and
/// not-visible avoids an existence oracle for foreign memories (the same discipline
/// the plugin layer follows).
///
/// Any status is readable: active, permanent, AND archived. A primary agent may
/// need to surface an archived memory to the user when they reference it by id
/// from <project-memory>'s history or a prior transcript.
pub fn get_memories(
    store: &McStore,
    project_path: &str,
    ids: &[i64],
) -> Result<Vec<StoredMemoryFull>, MemoryToolError> {
    if ids.is_empty() {
        return Err(MemoryToolError::EmptyGet);
    }
    if ids.len() > GET_MAX_IDS {
        return Err(MemoryToolError::TooManyIds {
            requested: ids.len(),
            max: GET_MAX_IDS,
        });
    }
    // Dedupe while preserving first-seen order so the per-id report maps 1:1 to the
    // caller's id list even when the same id is passed twice.
    let mut seen = BTreeSet::new();
    let mut unique_ids: Vec<i64> = Vec::with_capacity(ids.len());
    for id in ids {
        if seen.insert(*id) {
            unique_ids.push(*id);
        }
    }
    let by_id: HashMap<i64, StoredMemoryFull> =
        store.get_visible_memories_by_ids(project_path, &unique_ids)?;
    let mut ordered: Vec<StoredMemoryFull> = Vec::with_capacity(unique_ids.len());
    for id in &unique_ids {
        if let Some(memory) = by_id.get(id) {
            ordered.push(memory.clone());
        }
    }
    Ok(ordered)
}

/// Archive a visible memory. Re-archiving an already archived, non-superseded row is a
/// no-op success and returns `Ok(false)` so callers can avoid reporting a new mutation.
pub fn archive_memory(
    store: &McStore,
    project_path: &str,
    id: i64,
    reason: Option<&str>,
    now_ms: i64,
) -> Result<bool, MemoryToolError> {
    let memory = load_owned_memory(store, project_path, id)?;
    ensure_not_superseded(&memory)?;
    if memory.status == "archived" {
        return Ok(false);
    }
    ensure_active_or_permanent(&memory)?;
    store
        .archive_memory(project_path, id, reason, now_ms)?
        .ok_or(MemoryToolError::NotFound { id })?;
    Ok(true)
}

/// Archive a batch only after every owned row passes validation. The store repeats these
/// checks while locked and commits the batch atomically.
pub fn archive_memories(
    store: &McStore,
    project_path: &str,
    ids: &[i64],
    reason: Option<&str>,
    now_ms: i64,
) -> Result<Vec<i64>, MemoryToolError> {
    let Some(first_id) = ids.first().copied() else {
        return Err(MemoryToolError::EmptyMerge);
    };
    for id in ids {
        let memory = load_owned_memory(store, project_path, *id)?;
        ensure_not_superseded(&memory)?;
        if memory.status != "archived" {
            ensure_active_or_permanent(&memory)?;
        }
    }
    store
        .archive_memories(project_path, ids, reason, now_ms)?
        .ok_or(MemoryToolError::NotFound { id: first_id })
}

/// Merge owned, primary source memories into an owned, primary target. The target and
/// every source must share exactly one category; cross-category merges are rejected before
/// any store mutation so a miscategorization cannot silently destroy a distinct fact.
pub fn merge_memories(
    store: &McStore,
    project_path: &str,
    target_id: i64,
    source_ids: &[i64],
    merged_content: &str,
    now_ms: i64,
) -> Result<StoredMemoryFull, MemoryToolError> {
    let merged_content = merged_content.trim();
    if merged_content.is_empty() {
        return Err(MemoryToolError::EmptyContent);
    }
    if source_ids.is_empty() {
        return Err(MemoryToolError::EmptyMerge);
    }

    let mut seen = BTreeSet::new();
    for id in source_ids {
        if *id == target_id || !seen.insert(*id) {
            return Err(MemoryToolError::DuplicateSourceId { id: *id });
        }
    }

    let target = load_owned_memory(store, project_path, target_id)?;
    ensure_primary_mutable(&target)?;
    let mut rows = vec![target.clone()];
    for source_id in source_ids {
        let source = load_owned_memory(store, project_path, *source_id)?;
        ensure_primary_mutable(&source)?;
        rows.push(source);
    }

    let mut categories: Vec<String> = rows.iter().map(|m| m.category.clone()).collect();
    categories.sort();
    categories.dedup();
    if categories.len() > 1 {
        return Err(MemoryToolError::CrossCategoryMerge { categories });
    }

    store
        .merge_memories(project_path, target_id, source_ids, merged_content, now_ms)?
        .ok_or(MemoryToolError::NotFound { id: target_id })
}

/// Convenience wrapper for the identity-independent unit where the project key also names
/// the test session. Production routing should call
/// [`search_memories_and_compartments_for_session`] with the resolved session id.
pub fn search_memories_and_compartments(
    store: &McStore,
    project_path: &str,
    query: &str,
    limit: usize,
) -> Result<Vec<MemorySearchResult>, MemoryToolError> {
    search_memories_and_compartments_for_session(
        store,
        project_path,
        project_path,
        query,
        limit,
        true,
    )
}

/// Keyword search over visible project memories and the resolved session's compartments.
/// Ranking is intentionally simple and honest: memory content substring hits first, then
/// compartment-title hits, then compartment body/tier-text hits; recency breaks ties.
pub fn search_memories_and_compartments_for_session(
    store: &McStore,
    project_path: &str,
    session_id: &str,
    query: &str,
    limit: usize,
    include_memories: bool,
) -> Result<Vec<MemorySearchResult>, MemoryToolError> {
    let query = query.trim();
    if query.is_empty() || limit == 0 {
        return Ok(Vec::new());
    }

    let mut ranked = Vec::new();
    if include_memories {
        for memory in store.search_visible_memory_contents(project_path, query)? {
            if first_match(&memory.content, query).is_some() {
                ranked.push(memory_search_hit(memory, query));
            }
        }
    }
    for compartment in store.search_compartments_like(session_id, query)? {
        if let Some(hit) = compartment_search_hit(compartment, query) {
            ranked.push(hit);
        }
    }
    for note in store.search_notes_like(project_path, session_id, query)? {
        if first_match(&note.content, query).is_some()
            || note
                .surface_condition
                .as_deref()
                .is_some_and(|condition| first_match(condition, query).is_some())
        {
            ranked.push(note_search_hit(note, query));
        }
    }

    ranked.sort_by(|left, right| {
        left.rank
            .cmp(&right.rank)
            .then_with(|| right.recency.cmp(&left.recency))
            .then_with(|| left.result.id.cmp(&right.result.id))
    });
    ranked.truncate(limit);
    Ok(ranked.into_iter().map(|r| r.result).collect())
}

fn load_owned_memory(
    store: &McStore,
    project_path: &str,
    id: i64,
) -> Result<StoredMemoryFull, MemoryToolError> {
    let memory = store
        .get_memory_full(id)?
        .filter(|memory| memory.project_path == project_path)
        .ok_or(MemoryToolError::NotFound { id })?;
    Ok(memory)
}

fn ensure_primary_mutable(memory: &StoredMemoryFull) -> Result<(), MemoryToolError> {
    ensure_not_superseded(memory)?;
    ensure_active_or_permanent(memory)
}

fn ensure_not_superseded(memory: &StoredMemoryFull) -> Result<(), MemoryToolError> {
    if let Some(superseded_by) = memory.superseded_by_memory_id {
        return Err(MemoryToolError::Superseded {
            id: memory.id,
            superseded_by,
        });
    }
    Ok(())
}

fn ensure_active_or_permanent(memory: &StoredMemoryFull) -> Result<(), MemoryToolError> {
    if matches!(memory.status.as_str(), "active" | "permanent") {
        Ok(())
    } else {
        Err(MemoryToolError::Inactive {
            id: memory.id,
            status: memory.status.clone(),
        })
    }
}

fn memory_search_hit(memory: StoredMemorySearchRow, query: &str) -> RankedSearchResult {
    RankedSearchResult {
        recency: memory.updated_at,
        rank: 0,
        result: MemorySearchResult {
            source_kind: MemorySearchSourceKind::Memory,
            id: memory.id,
            snippet: snippet_around_match(&memory.content, query),
            category: Some(memory.category),
            sequence: None,
            title: None,
            note_status: None,
            surface_condition: None,
        },
    }
}

fn note_search_hit(note: StoredNoteSearchRow, query: &str) -> RankedSearchResult {
    let matched_text = if first_match(&note.content, query).is_some() {
        note.content.as_str()
    } else {
        note.surface_condition
            .as_deref()
            .unwrap_or(note.content.as_str())
    };
    RankedSearchResult {
        rank: 1,
        recency: note.updated_at_ms,
        result: MemorySearchResult {
            source_kind: MemorySearchSourceKind::Note,
            id: note.id,
            snippet: snippet_around_match(matched_text, query),
            category: None,
            sequence: None,
            title: None,
            note_status: Some(note.status),
            surface_condition: note.surface_condition,
        },
    }
}

fn compartment_search_hit(
    compartment: StoredCompartmentSearchRow,
    query: &str,
) -> Option<RankedSearchResult> {
    if first_match(&compartment.title, query).is_some() {
        return Some(RankedSearchResult {
            rank: 1,
            recency: compartment.sequence,
            result: MemorySearchResult {
                source_kind: MemorySearchSourceKind::CompartmentTitle,
                id: compartment.sequence,
                snippet: snippet_around_match(&compartment.title, query),
                category: None,
                sequence: Some(compartment.sequence),
                title: Some(compartment.title),
                note_status: None,
                surface_condition: None,
            },
        });
    }

    let body = compartment_body_text(&compartment);
    first_match(&body, query).map(|_| RankedSearchResult {
        rank: 2,
        recency: compartment.sequence,
        result: MemorySearchResult {
            source_kind: MemorySearchSourceKind::CompartmentBody,
            id: compartment.sequence,
            snippet: snippet_around_match(&body, query),
            category: None,
            sequence: Some(compartment.sequence),
            title: Some(compartment.title),
            note_status: None,
            surface_condition: None,
        },
    })
}

fn compartment_body_text(compartment: &StoredCompartmentSearchRow) -> String {
    let mut parts = Vec::new();
    push_unique_text(&mut parts, &compartment.content);
    for tier in [
        &compartment.p1,
        &compartment.p2,
        &compartment.p3,
        &compartment.p4,
    ] {
        if let Some(text) = tier.as_deref() {
            push_unique_text(&mut parts, text);
        }
    }
    parts.join("\n")
}

fn push_unique_text(parts: &mut Vec<String>, text: &str) {
    if !text.is_empty() && !parts.iter().any(|part| part == text) {
        parts.push(text.to_string());
    }
}

fn first_match(text: &str, query: &str) -> Option<usize> {
    text.to_lowercase().find(&query.to_lowercase())
}

fn snippet_around_match(text: &str, query: &str) -> String {
    const CONTEXT: usize = 100;
    const MAX_CHARS: usize = 200;

    let Some(hit) = first_match(text, query) else {
        return text.chars().take(MAX_CHARS).collect();
    };
    let query_len = query.len();
    let mut start = hit.saturating_sub(CONTEXT);
    while start > 0 && !text.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = (hit + query_len + CONTEXT).min(text.len());
    while end < text.len() && !text.is_char_boundary(end) {
        end += 1;
    }

    let snippet: String = text[start..end].chars().take(MAX_CHARS).collect();
    let prefix = if start > 0 { "…" } else { "" };
    let suffix = if end < text.len() { "…" } else { "" };
    format!("{prefix}{}{suffix}", snippet.trim())
}

#[cfg(test)]
mod tests {
    use super::*;
    use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
    use mc_store::{InsertMemoryInput, StoredCompartment};

    fn descriptor(dir: &std::path::Path) -> StorageDescriptor {
        StorageDescriptor {
            module_id: "magic-context-test".to_string(),
            storage_namespace: "mc_cache".to_string(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: dir.join("store.db").to_string_lossy().to_string(),
            },
        }
    }

    fn store(dir: &std::path::Path) -> McStore {
        McStore::open(&descriptor(dir)).unwrap()
    }

    fn input<'a>(
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
            source_message_id: None,
            source_type: Some("tool"),
            importance: Some(50),
            expires_at: None,
            metadata_json: None,
            now_ms: now,
        }
    }

    fn insert(store: &McStore, project: &str, category: &str, content: &str, now: i64) -> i64 {
        store
            .insert_memory(input(project, category, content, now))
            .unwrap()
    }

    fn workspace(store: &McStore, own: &str, foreign: &str) {
        store
            .seed_workspace_member("ws", own, "[\"CONSTRAINTS\"]")
            .unwrap();
        store
            .seed_workspace_member("ws", foreign, "[\"CONSTRAINTS\"]")
            .unwrap();
    }

    fn comp(seq: i64, title: &str, content: &str, p2: Option<&str>) -> StoredCompartment {
        StoredCompartment {
            sequence: seq,
            start_message: seq,
            end_message: seq,
            start_message_id: format!("m{seq}"),
            end_message_id: format!("m{seq}"),
            title: title.to_string(),
            content: content.to_string(),
            p1: Some(content.to_string()),
            p2: p2.map(str::to_string),
            created_at: seq,
            ..Default::default()
        }
    }

    #[test]
    fn foreign_unshared_mutation_denied_for_update_merge_and_archive() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let own = "git:own";
        let foreign = "git:foreign";
        workspace(&store, own, foreign);
        let foreign_private = insert(&store, foreign, "PREFERENCES", "private fact", 1);
        let own_private = insert(&store, own, "PREFERENCES", "own fact", 1);

        assert!(matches!(
            update_memory(&store, own, foreign_private, "edited", 2),
            Err(MemoryToolError::NotFound { id }) if id == foreign_private
        ));
        assert!(matches!(
            archive_memory(&store, own, foreign_private, None, 2),
            Err(MemoryToolError::NotFound { id }) if id == foreign_private
        ));
        assert!(matches!(
            merge_memories(&store, own, foreign_private, &[own_private], "merged", 2),
            Err(MemoryToolError::NotFound { id }) if id == foreign_private
        ));
    }

    #[test]
    fn foreign_shared_mutation_rejected_for_update_merge_and_archive() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let own = "git:own";
        let foreign = "git:foreign";
        workspace(&store, own, foreign);
        let updatable = insert(&store, foreign, "CONSTRAINTS", "shared update", 1);
        let archivable = insert(&store, foreign, "CONSTRAINTS", "shared archive", 1);
        let target = insert(&store, foreign, "CONSTRAINTS", "shared target", 1);
        let source = insert(&store, foreign, "CONSTRAINTS", "shared source", 1);

        assert!(matches!(
            update_memory(&store, own, updatable, "shared edited", 2),
            Err(MemoryToolError::NotFound { id }) if id == updatable
        ));
        assert!(matches!(
            archive_memory(&store, own, archivable, Some("old"), 2),
            Err(MemoryToolError::NotFound { id }) if id == archivable
        ));
        assert!(matches!(
            merge_memories(&store, own, target, &[source], "shared merged", 2),
            Err(MemoryToolError::NotFound { id }) if id == target
        ));
        assert_eq!(
            store.get_memory_full(updatable).unwrap().unwrap().content,
            "shared update"
        );
        assert_eq!(
            store.get_memory_full(archivable).unwrap().unwrap().status,
            "active"
        );
        assert_eq!(
            store
                .get_memory_full(source)
                .unwrap()
                .unwrap()
                .superseded_by_memory_id,
            None
        );
    }

    #[test]
    fn merge_duplicate_content_returns_specific_error_without_partial_lineage() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let project = "git:proj";
        let target = insert(&store, project, "CONSTRAINTS", "target", 1);
        let source = insert(&store, project, "CONSTRAINTS", "canonical", 1);

        let error = merge_memories(&store, project, target, &[source], "canonical", 2)
            .unwrap_err()
            .to_string();
        assert!(error.contains(&format!("memory content already exists as ID {source}")));
        assert_eq!(
            store.get_memory_full(target).unwrap().unwrap().content,
            "target"
        );
        let source_row = store.get_memory_full(source).unwrap().unwrap();
        assert_eq!(source_row.status, "active");
        assert_eq!(source_row.superseded_by_memory_id, None);
    }

    #[test]
    fn cross_category_merge_rejected_before_store_mutation() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let project = "git:proj";
        let target = insert(&store, project, "CONSTRAINTS", "constraint", 1);
        let source = insert(&store, project, "PREFERENCES", "preference", 1);
        let before = store
            .max_memory_mutation_id(&[project.to_string()])
            .unwrap();

        assert!(matches!(
            merge_memories(&store, project, target, &[source], "merged", 2),
            Err(MemoryToolError::CrossCategoryMerge { categories })
                if categories == vec!["CONSTRAINTS".to_string(), "PREFERENCES".to_string()]
        ));
        assert_eq!(
            store
                .max_memory_mutation_id(&[project.to_string()])
                .unwrap(),
            before
        );
    }

    #[test]
    fn superseded_row_mutations_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let project = "git:proj";
        let target = insert(&store, project, "CONSTRAINTS", "target", 1);
        let source = insert(&store, project, "CONSTRAINTS", "source", 1);
        let extra = insert(&store, project, "CONSTRAINTS", "extra", 1);
        merge_memories(&store, project, target, &[source], "merged", 2).unwrap();

        assert!(matches!(
            update_memory(&store, project, source, "edit", 3),
            Err(MemoryToolError::Superseded { id, superseded_by })
                if id == source && superseded_by == target
        ));
        assert!(matches!(
            archive_memory(&store, project, source, None, 3),
            Err(MemoryToolError::Superseded { id, superseded_by })
                if id == source && superseded_by == target
        ));
        assert!(matches!(
            merge_memories(&store, project, source, &[extra], "again", 3),
            Err(MemoryToolError::Superseded { id, superseded_by })
                if id == source && superseded_by == target
        ));
    }

    #[test]
    fn archive_is_idempotent_for_already_archived_rows() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let project = "git:proj";
        let id = insert(&store, project, "CONSTRAINTS", "old", 1);
        assert!(archive_memory(&store, project, id, None, 2).unwrap());
        let after_first = store
            .max_memory_mutation_id(&[project.to_string()])
            .unwrap();

        assert!(!archive_memory(&store, project, id, Some("again"), 3).unwrap());
        assert_eq!(
            store
                .max_memory_mutation_id(&[project.to_string()])
                .unwrap(),
            after_first
        );
    }

    #[test]
    fn batch_archive_rolls_back_when_any_id_is_not_owned() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let own = "git:own";
        let foreign = "git:foreign";
        let own_id = insert(&store, own, "CONSTRAINTS", "owned", 1);
        let foreign_id = insert(&store, foreign, "CONSTRAINTS", "foreign", 1);

        assert!(matches!(
            archive_memories(&store, own, &[own_id, foreign_id], None, 2),
            Err(MemoryToolError::NotFound { id }) if id == foreign_id
        ));
        assert_eq!(
            store.get_memory_full(own_id).unwrap().unwrap().status,
            "active"
        );
        assert_eq!(
            store.get_memory_full(foreign_id).unwrap().unwrap().status,
            "active"
        );
    }

    #[test]
    fn keyword_search_ranks_limits_and_filters_workspace_visibility() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let own = "git:own";
        let foreign = "git:foreign";
        workspace(&store, own, foreign);
        let memory_id = insert(
            &store,
            own,
            "CONSTRAINTS",
            "memory has Needle in content",
            10,
        );
        let foreign_private = insert(&store, foreign, "PREFERENCES", "Needle secret", 20);
        store
            .replace_compartments(
                own,
                &[
                    comp(1, "Needle title", "ordinary body", None),
                    comp(
                        2,
                        "ordinary title",
                        "ordinary body",
                        Some("tier text has Needle"),
                    ),
                ],
            )
            .unwrap();

        let results = search_memories_and_compartments(&store, own, "needle", 10).unwrap();
        assert_eq!(
            results.len(),
            3,
            "foreign unshared memory must be excluded: {results:?}"
        );
        assert_eq!(results[0].source_kind, MemorySearchSourceKind::Memory);
        assert_eq!(results[0].id, memory_id);
        assert_eq!(
            results[1].source_kind,
            MemorySearchSourceKind::CompartmentTitle
        );
        assert_eq!(results[1].sequence, Some(1));
        assert_eq!(
            results[2].source_kind,
            MemorySearchSourceKind::CompartmentBody
        );
        assert_eq!(results[2].sequence, Some(2));
        assert!(results.iter().all(
            |result| result.source_kind != MemorySearchSourceKind::Memory
                || result.id != foreign_private
        ));
        assert!(results[0].snippet.len() <= 203);

        let limited = search_memories_and_compartments(&store, own, "needle", 2).unwrap();
        assert_eq!(limited.len(), 2);
        assert_eq!(limited[0].source_kind, MemorySearchSourceKind::Memory);
        assert_eq!(
            limited[1].source_kind,
            MemorySearchSourceKind::CompartmentTitle
        );
    }

    #[test]
    fn get_memories_returns_own_project_hits_in_call_order() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let own = "git:own";
        let first = insert(&store, own, "CONSTRAINTS", "own first", 1);
        let second = insert(&store, own, "CONSTRAINTS", "own second", 2);

        let fetched = get_memories(&store, own, &[second, first]).unwrap();
        assert_eq!(fetched.len(), 2);
        assert_eq!(fetched[0].id, second);
        assert_eq!(fetched[1].id, first);
        assert_eq!(fetched[0].content, "own second");
    }

    #[test]
    fn get_memories_surfaces_archived_rows_with_status_label() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let own = "git:own";
        let memory = insert(&store, own, "KNOWN_ISSUES", "retired issue", 1);
        store
            .archive_memory(own, memory, Some("superseded"), 2)
            .unwrap();

        let fetched = get_memories(&store, own, &[memory]).unwrap();
        assert_eq!(fetched.len(), 1);
        assert_eq!(fetched[0].status, "archived");
        assert_eq!(fetched[0].content, "retired issue");
    }

    #[test]
    fn get_memories_skips_foreign_non_shared_category_rows() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let own = "git:own";
        let foreign = "git:foreign";
        // Workspace shares only CONSTRAINTS; the foreign ARCHITECTURE row is
        // off-limits and must not be returned (no existence oracle: callers
        // see the id as "not visible" via the tool layer's per-id report).
        workspace(&store, own, foreign);
        let foreign_hidden = insert(&store, foreign, "ARCHITECTURE", "hidden", 1);

        let fetched = get_memories(&store, own, &[foreign_hidden]).unwrap();
        assert!(
            fetched.is_empty(),
            "foreign non-shared memory leaked: {fetched:?}"
        );
    }

    #[test]
    fn get_memories_returns_foreign_shared_category_rows() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let own = "git:own";
        let foreign = "git:foreign";
        workspace(&store, own, foreign);
        let foreign_shared = insert(&store, foreign, "CONSTRAINTS", "shared", 1);
        // Foreign visibility is fail-closed: a workspace neighbor's memory is readable
        // only once classification marks it shareable with a workspace-eligible scope.
        store
            .set_memory_sharing_for_test(foreign_shared, "project", true)
            .unwrap();

        let fetched = get_memories(&store, own, &[foreign_shared]).unwrap();
        assert_eq!(fetched.len(), 1);
        assert_eq!(fetched[0].id, foreign_shared);
        assert_eq!(fetched[0].content, "shared");
    }

    #[test]
    fn get_memories_rejects_more_than_the_per_call_cap() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let own = "git:own";
        let ids: Vec<i64> = (1..=(GET_MAX_IDS as i64) + 1).collect();
        let error = get_memories(&store, own, &ids).unwrap_err().to_string();
        assert!(error.contains("at most 20"), "got: {error}");
    }

    #[test]
    fn get_memories_rejects_an_empty_id_list() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let own = "git:own";
        assert!(matches!(
            get_memories(&store, own, &[]),
            Err(MemoryToolError::EmptyGet)
        ));
    }
}
