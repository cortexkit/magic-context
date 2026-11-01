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

use crate::memory_render::MEMORY_CATEGORY_ORDER;

pub use mc_store::FOREIGN_VISIBLE_SQL;

#[path = "retrieval/compartments.rs"]
pub mod compartments;
#[path = "retrieval/hybrid.rs"]
pub mod hybrid;

#[derive(Debug)]
pub enum MemoryToolError {
    Store(McStoreError),
    EmptyContent,
    InvalidCategory {
        category: String,
    },
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
            MemoryToolError::InvalidCategory { .. } => write!(
                f,
                "category must be one of {}",
                MEMORY_CATEGORY_ORDER.join(", ")
            ),
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
    /// Integer hundredths keep sorting and rendered `score=N.NN` deterministic.
    pub score_hundredths: i64,
    pub category: Option<String>,
    pub sequence: Option<i64>,
    pub title: Option<String>,
    pub start_ordinal: Option<i64>,
    pub end_ordinal: Option<i64>,
    pub note_status: Option<String>,
    pub surface_condition: Option<String>,
    pub note_created_at_ms: Option<i64>,
    pub note_anchor_ordinal: Option<i64>,
    pub note_session_id: Option<String>,
    pub source_project_path: Option<String>,
}

#[derive(Debug)]
struct RankedSearchResult {
    result: MemorySearchResult,
    rank: u8,
    recency: i64,
}

#[derive(Debug, Clone, Copy)]
pub struct MemorySearchOptions<'a> {
    pub limit: usize,
    pub include_memories: bool,
    pub include_messages: bool,
    pub include_notes: bool,
    pub excluded_memory_ids: &'a BTreeSet<i64>,
    pub from_ms: Option<i64>,
    pub to_ms: Option<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MemorySearchDiagnostics {
    pub suppressed_visible_memory_ids: Vec<i64>,
    pub source_availability:
        std::collections::BTreeMap<String, crate::parity_contract::Availability>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemorySearchOutcome {
    pub results: Vec<MemorySearchResult>,
    pub diagnostics: MemorySearchDiagnostics,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryIdSearchOutcome {
    pub results: Option<Vec<MemorySearchResult>>,
    pub diagnostics: MemorySearchDiagnostics,
}

pub(crate) fn validate_update_category(
    category: Option<&str>,
) -> Result<Option<&str>, MemoryToolError> {
    let Some(category) = category.map(str::trim) else {
        return Ok(None);
    };
    if !MEMORY_CATEGORY_ORDER.contains(&category) {
        return Err(MemoryToolError::InvalidCategory {
            category: category.to_string(),
        });
    }
    Ok(Some(category))
}

/// Update an owned, primary (active/permanent and not superseded) memory.
pub fn update_memory(
    store: &McStore,
    project_path: &str,
    id: i64,
    content: &str,
    category: Option<&str>,
    now_ms: i64,
) -> Result<StoredMemoryFull, MemoryToolError> {
    let content = content.trim();
    if content.is_empty() {
        return Err(MemoryToolError::EmptyContent);
    }
    let category = validate_update_category(category)?;
    let memory = load_owned_memory(store, project_path, id)?;
    ensure_primary_mutable(&memory)?;
    store
        .update_memory_content(project_path, id, content, category, now_ms)?
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

/// Keyword search over the corpora the module store actually owns: visible project memories,
/// durable compartment summaries, and notes. The facade layer maps compartments to the shared
/// `message` source vocabulary; raw message, Primer, and git-commit indexes do not exist here.
pub fn search_memories_and_compartments_for_session(
    store: &McStore,
    project_path: &str,
    session_id: &str,
    query: &str,
    limit: usize,
    include_memories: bool,
) -> Result<Vec<MemorySearchResult>, MemoryToolError> {
    let excluded_memory_ids = BTreeSet::new();
    search_available_corpora_for_session(
        store,
        project_path,
        session_id,
        query,
        MemorySearchOptions {
            limit,
            include_memories,
            include_messages: true,
            include_notes: true,
            excluded_memory_ids: &excluded_memory_ids,
            from_ms: None,
            to_ms: None,
        },
    )
}

pub fn search_available_corpora_for_session(
    store: &McStore,
    project_path: &str,
    session_id: &str,
    query: &str,
    options: MemorySearchOptions<'_>,
) -> Result<Vec<MemorySearchResult>, MemoryToolError> {
    Ok(search_available_corpora_for_session_with_diagnostics(
        store,
        project_path,
        session_id,
        query,
        options,
    )?
    .results)
}

pub fn search_available_corpora_for_session_with_diagnostics(
    store: &McStore,
    project_path: &str,
    session_id: &str,
    query: &str,
    options: MemorySearchOptions<'_>,
) -> Result<MemorySearchOutcome, MemoryToolError> {
    let query = query.trim();
    if query.is_empty() || options.limit == 0 {
        return Ok(MemorySearchOutcome {
            results: Vec::new(),
            diagnostics: MemorySearchDiagnostics {
                source_availability: legacy_search_availability(options),
                ..Default::default()
            },
        });
    }

    let in_range = |timestamp: i64| {
        options.from_ms.is_none_or(|from| timestamp >= from)
            && options.to_ms.is_none_or(|to| timestamp <= to)
    };
    let mut ranked = Vec::new();
    let mut suppressed_visible_memory_ids = Vec::new();
    if options.include_memories {
        for memory in store.search_visible_memory_contents_in_range(
            project_path,
            query,
            options.from_ms,
            options.to_ms,
        )? {
            if !in_range(memory.created_at) {
                continue;
            }
            if first_match(&memory.content, query).is_none() {
                continue;
            }
            if options.excluded_memory_ids.contains(&memory.id) {
                suppressed_visible_memory_ids.push(memory.id);
                continue;
            }
            ranked.push(memory_search_hit(memory, query));
        }
    }
    if options.include_messages {
        for compartment in store.search_compartments_like_in_range(
            session_id,
            query,
            options.from_ms,
            options.to_ms,
        )? {
            if !in_range(compartment.created_at) {
                continue;
            }
            if let Some(hit) = compartment_search_hit(compartment, query) {
                ranked.push(hit);
            }
        }
    }
    if options.include_notes {
        for note in store.search_notes_like_in_range(
            project_path,
            session_id,
            query,
            options.from_ms,
            options.to_ms,
        )? {
            if !in_range(note.created_at_ms) {
                continue;
            }
            if let Some(hit) = note_search_hit(note, query) {
                ranked.push(hit);
            }
        }
    }

    ranked.sort_by(|left, right| {
        right
            .result
            .score_hundredths
            .cmp(&left.result.score_hundredths)
            .then_with(|| left.rank.cmp(&right.rank))
            .then_with(|| right.recency.cmp(&left.recency))
            .then_with(|| left.result.id.cmp(&right.result.id))
    });
    ranked.truncate(options.limit);
    suppressed_visible_memory_ids.sort_unstable();
    Ok(MemorySearchOutcome {
        results: ranked.into_iter().map(|ranked| ranked.result).collect(),
        diagnostics: MemorySearchDiagnostics {
            suppressed_visible_memory_ids,
            source_availability: legacy_search_availability(options),
        },
    })
}

/// Resolve a whole-query memory-id list through the same visibility rules as keyword search,
/// excluding memories already rendered in the current prompt. `None` means no id resolved, so
/// the caller should fall through to lexical search.
pub fn resolve_memory_ids_for_search(
    store: &McStore,
    project_path: &str,
    ids: &[i64],
    limit: usize,
    excluded_memory_ids: &BTreeSet<i64>,
) -> Result<Option<Vec<MemorySearchResult>>, MemoryToolError> {
    Ok(resolve_memory_ids_for_search_with_diagnostics(
        store,
        project_path,
        ids,
        limit,
        excluded_memory_ids,
        None,
        None,
    )?
    .results)
}

pub fn resolve_memory_ids_for_search_with_diagnostics(
    store: &McStore,
    project_path: &str,
    ids: &[i64],
    limit: usize,
    excluded_memory_ids: &BTreeSet<i64>,
    from_ms: Option<i64>,
    to_ms: Option<i64>,
) -> Result<MemoryIdSearchOutcome, MemoryToolError> {
    if ids.is_empty() || limit == 0 {
        return Ok(MemoryIdSearchOutcome {
            results: None,
            diagnostics: MemorySearchDiagnostics::default(),
        });
    }
    let visible = store.get_visible_memories_by_ids(project_path, ids)?;
    let mut results = Vec::new();
    let mut suppressed_visible_memory_ids = Vec::new();
    let mut seen = BTreeSet::new();
    for id in ids {
        if !seen.insert(*id) {
            continue;
        }
        let Some(memory) = visible.get(id) else {
            continue;
        };
        if !matches!(memory.status.as_str(), "active" | "permanent")
            || memory.superseded_by_memory_id.is_some()
        {
            continue;
        }
        if from_ms.is_some_and(|from| memory.created_at < from)
            || to_ms.is_some_and(|to| memory.created_at > to)
        {
            continue;
        }
        if excluded_memory_ids.contains(id) {
            suppressed_visible_memory_ids.push(*id);
            continue;
        }
        let rank = i64::try_from(results.len()).unwrap_or(i64::MAX);
        results.push(MemorySearchResult {
            source_kind: MemorySearchSourceKind::Memory,
            id: memory.id,
            snippet: preview_text(&memory.content),
            score_hundredths: (100 - rank).max(0),
            category: Some(memory.category.clone()),
            sequence: None,
            title: None,
            start_ordinal: None,
            end_ordinal: None,
            note_status: None,
            surface_condition: None,
            note_created_at_ms: None,
            note_anchor_ordinal: None,
            note_session_id: None,
            source_project_path: Some(memory.project_path.clone()),
        });
        if results.len() >= limit {
            break;
        }
    }
    suppressed_visible_memory_ids.sort_unstable();
    Ok(MemoryIdSearchOutcome {
        results: (!results.is_empty()).then_some(results),
        diagnostics: MemorySearchDiagnostics {
            suppressed_visible_memory_ids,
            source_availability: std::collections::BTreeMap::new(),
        },
    })
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
            score_hundredths: 100,
            category: Some(memory.category),
            sequence: None,
            title: None,
            start_ordinal: None,
            end_ordinal: None,
            note_status: None,
            surface_condition: None,
            note_created_at_ms: None,
            note_anchor_ordinal: None,
            note_session_id: None,
            source_project_path: Some(memory.project_path),
        },
    }
}

fn tokenize_keyword_needle(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let push_current = |tokens: &mut Vec<String>, current: &mut String| {
        if current.len() > 1
            && current.chars().any(|ch| ch.is_ascii_alphanumeric())
            && !tokens.contains(current)
        {
            tokens.push(std::mem::take(current));
        } else {
            current.clear();
        }
    };
    for ch in text.to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '/' | '.' | '_' | ':' | '-') {
            current.push(ch);
        } else if !current.is_empty() {
            push_current(&mut tokens, &mut current);
        }
    }
    if !current.is_empty() {
        push_current(&mut tokens, &mut current);
    }
    tokens
}

fn raw_note_keyword_score(text: &str, query: &str) -> Option<f64> {
    let normalized_query = query.trim().to_lowercase();
    if normalized_query.is_empty() {
        return None;
    }
    let normalized_text = text.to_lowercase();
    let query_tokens = tokenize_keyword_needle(&normalized_query);
    let note_tokens: BTreeSet<String> = tokenize_keyword_needle(&normalized_text)
        .into_iter()
        .collect();
    let exact = normalized_text.contains(&normalized_query);
    let matched_tokens = query_tokens
        .iter()
        .filter(|token| note_tokens.contains(*token))
        .count();
    if !exact && matched_tokens == 0 {
        return None;
    }
    let matched_unique_tokens = query_tokens
        .iter()
        .filter(|token| note_tokens.contains(*token))
        .collect::<BTreeSet<_>>()
        .len();
    let coverage = if query_tokens.is_empty() {
        0.0
    } else {
        matched_tokens as f64 / query_tokens.len() as f64
    };
    let density = if note_tokens.is_empty() {
        0.0
    } else {
        matched_unique_tokens as f64 / note_tokens.len() as f64
    };
    let exact_phrase =
        exact && (query_tokens.len() > 1 || normalized_text.trim() == normalized_query);
    let all_tokens = query_tokens.len() > 1 && matched_tokens == query_tokens.len();
    Some(
        (if exact_phrase { 2.0 } else { 0.0 })
            + coverage * density
            + if all_tokens { 0.5 * density } else { 0.0 },
    )
}

fn note_search_hit(note: StoredNoteSearchRow, query: &str) -> Option<RankedSearchResult> {
    const MAX_NOTE_KEYWORD_SCORE: f64 = 3.5;
    const SINGLE_SOURCE_SCORE_HUNDREDTHS: f64 = 80.0;

    let mut search_text = note.content.clone();
    if let Some(condition) = note.surface_condition.as_deref() {
        search_text.push('\n');
        search_text.push_str(condition);
    }
    let raw_score = raw_note_keyword_score(&search_text, query)?;
    let score_hundredths = ((raw_score / MAX_NOTE_KEYWORD_SCORE) * SINGLE_SOURCE_SCORE_HUNDREDTHS)
        .clamp(0.0, SINGLE_SOURCE_SCORE_HUNDREDTHS)
        .round()
        .max(1.0) as i64;
    let matched_text = if raw_note_keyword_score(&note.content, query).is_some() {
        note.content.as_str()
    } else {
        note.surface_condition
            .as_deref()
            .unwrap_or(note.content.as_str())
    };
    Some(RankedSearchResult {
        rank: 1,
        recency: note.updated_at_ms,
        result: MemorySearchResult {
            source_kind: MemorySearchSourceKind::Note,
            id: note.id,
            snippet: snippet_around_match(matched_text, query),
            score_hundredths,
            category: None,
            sequence: None,
            title: None,
            start_ordinal: None,
            end_ordinal: None,
            note_status: Some(note.status),
            surface_condition: note.surface_condition,
            note_created_at_ms: Some(note.created_at_ms),
            note_anchor_ordinal: note.anchor_ordinal,
            note_session_id: Some(note.session_id),
            source_project_path: None,
        },
    })
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
                score_hundredths: 95,
                category: None,
                sequence: Some(compartment.sequence),
                title: Some(compartment.title),
                start_ordinal: Some(compartment.start_ordinal),
                end_ordinal: Some(compartment.end_ordinal),
                note_status: None,
                surface_condition: None,
                note_created_at_ms: None,
                note_anchor_ordinal: None,
                note_session_id: None,
                source_project_path: None,
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
            score_hundredths: 90,
            category: None,
            sequence: Some(compartment.sequence),
            title: Some(compartment.title),
            start_ordinal: Some(compartment.start_ordinal),
            end_ordinal: Some(compartment.end_ordinal),
            note_status: None,
            surface_condition: None,
            note_created_at_ms: None,
            note_anchor_ordinal: None,
            note_session_id: None,
            source_project_path: None,
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

/// The byte range in `text` of the first case-insensitive occurrence of `query`.
///
/// Matching runs on the lowercased text, whose byte offsets are not the original's: some
/// characters change length when lowercased (`İ` grows from two bytes to three, the
/// Kelvin sign shrinks from three to one). Each lowercased byte is therefore mapped back
/// to the original character it came from, so the range always lands on the matched text.
fn first_match(text: &str, query: &str) -> Option<(usize, usize)> {
    let lowered = text.to_lowercase();
    let hit = lowered.find(&query.to_lowercase())?;
    let hit_end = hit + query.to_lowercase().len();
    // `str::to_lowercase` lowercases character by character (its one context rule, the
    // final sigma, never changes a length), so walking the characters reproduces its
    // offsets.
    let mut lowered_at = 0;
    let mut start = None;
    for (original_at, ch) in text.char_indices() {
        let next = lowered_at + ch.to_lowercase().map(char::len_utf8).sum::<usize>();
        if start.is_none() && hit < next {
            start = Some(original_at);
        }
        if hit_end <= next {
            return Some((start.unwrap_or(original_at), original_at + ch.len_utf8()));
        }
        lowered_at = next;
    }
    start.map(|start| (start, text.len()))
}

fn preview_text(text: &str) -> String {
    const LIMIT: usize = 220;
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.chars().count() <= LIMIT {
        return normalized;
    }
    let mut preview = normalized
        .chars()
        .take(LIMIT - 1)
        .collect::<String>()
        .trim_end()
        .to_string();
    preview.push('…');
    preview
}

fn snippet_around_match(text: &str, query: &str) -> String {
    const CONTEXT: usize = 100;
    const MAX_CHARS: usize = 200;

    let Some((hit, hit_end)) = first_match(text, query) else {
        return text.chars().take(MAX_CHARS).collect();
    };
    let mut start = hit.saturating_sub(CONTEXT);
    while start > 0 && !text.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = (hit_end + CONTEXT).min(text.len());
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
    use mc_store::{InsertMemoryInput, NoteInput, StoredCompartment};

    /// Characters that change length when lowercased must not move the snippet off the
    /// match: `İ` grows, the Kelvin sign shrinks.
    #[test]
    fn snippets_stay_on_the_match_when_lowercasing_changes_lengths() {
        for filler in ["\u{130}", "\u{212a}"] {
            let text = format!("{}needle{}", filler.repeat(150), "x".repeat(10));
            let snippet = snippet_around_match(&text, "NEEDLE");
            assert!(snippet.contains("needle"), "{filler:?}: {snippet:?}");
            let (start, end) = first_match(&text, "needle").unwrap();
            assert_eq!(&text[start..end], "needle", "{filler:?}");
        }
        // A match that starts inside a character's lowercase expansion covers that character.
        let (start, end) = first_match("a\u{130}b", "i").unwrap();
        assert_eq!(&"a\u{130}b"[start..end], "\u{130}");
    }

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
        McStore::open_for_test(&descriptor(dir)).unwrap()
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

    fn insert_note(
        store: &McStore,
        project: &str,
        session_id: &str,
        content: &str,
        now_ms: i64,
    ) -> i64 {
        store
            .insert_note(NoteInput {
                project_path: project,
                route_project_root: None,
                session_id,
                content,
                surface_condition: None,
                anchor_block_id: None,
                now_ms,
            })
            .unwrap()
            .id
    }

    fn workspace(store: &McStore, own: &str, foreign: &str) {
        store
            .seed_workspace_member("ws", own, "[\"CONSTRAINTS\"]")
            .unwrap();
        store
            .seed_workspace_member("ws", foreign, "[\"CONSTRAINTS\"]")
            .unwrap();
    }

    #[test]
    fn update_recategorizes_and_omitted_category_preserves_current_value() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let project = "git:proj";
        let recategorized = insert(&store, project, "CONFIG_VALUES", "old config", 1);
        let unchanged = insert(&store, project, "NAMING", "old name", 1);

        let updated = update_memory(
            &store,
            project,
            recategorized,
            "new constraint",
            Some("CONSTRAINTS"),
            2,
        )
        .unwrap();
        let preserved = update_memory(&store, project, unchanged, "new name", None, 3).unwrap();

        assert_eq!(updated.category, "CONSTRAINTS");
        assert_eq!(updated.content, "new constraint");
        assert_eq!(preserved.category, "NAMING");
        assert_eq!(preserved.content, "new name");
    }

    #[test]
    fn update_rejects_invalid_category_with_typescript_error_text() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let project = "git:proj";
        let id = insert(&store, project, "CONFIG_VALUES", "old config", 1);

        let error = update_memory(&store, project, id, "new config", Some("NOT_A_CATEGORY"), 2)
            .unwrap_err();

        assert!(matches!(error, MemoryToolError::InvalidCategory { .. }));
        assert_eq!(
            error.to_string(),
            "category must be one of PROJECT_RULES, ARCHITECTURE, CONSTRAINTS, CONFIG_VALUES, NAMING"
        );
        assert_eq!(
            store.get_memory_full(id).unwrap().unwrap().content,
            "old config"
        );
    }

    #[test]
    fn update_recategorize_duplicate_returns_typed_error_without_mutation() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let project = "git:proj";
        let duplicate = insert(&store, project, "CONSTRAINTS", "timeout=5s", 1);
        let target = insert(&store, project, "CONFIG_VALUES", "cache ttl", 1);

        let error = update_memory(
            &store,
            project,
            target,
            "timeout=5s",
            Some("CONSTRAINTS"),
            2,
        )
        .unwrap_err();

        assert!(matches!(
            error,
            MemoryToolError::Store(McStoreError::MemoryDuplicateContent { id }) if id == duplicate
        ));
        let target = store.get_memory_full(target).unwrap().unwrap();
        assert_eq!(target.category, "CONFIG_VALUES");
        assert_eq!(target.content, "cache ttl");
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
            update_memory(&store, own, foreign_private, "edited", None, 2),
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
            update_memory(&store, own, updatable, "shared edited", None, 2),
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
            update_memory(&store, project, source, "edit", None, 3),
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
    fn dated_search_filters_memories_notes_and_compartment_summaries_before_ranking() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let project = "git:dated";
        let session_id = "session-dated";
        let outside_memory = insert(
            &store,
            project,
            "CONSTRAINTS",
            "dated needle outside",
            1_000,
        );
        let inside_memory = insert(&store, project, "CONSTRAINTS", "dated needle inside", 3_000);
        let outside_note = insert_note(
            &store,
            project,
            session_id,
            "dated needle outside note",
            1_000,
        );
        let inside_note = insert_note(
            &store,
            project,
            session_id,
            "dated needle inside note",
            3_000,
        );
        let mut outside_compartment = comp(1, "dated needle outside compartment", "body", None);
        outside_compartment.created_at = 1_000;
        let mut inside_compartment = comp(2, "dated needle inside compartment", "body", None);
        inside_compartment.created_at = 3_000;
        store
            .replace_compartments(session_id, &[outside_compartment, inside_compartment])
            .unwrap();

        let excluded = BTreeSet::new();
        let outcome = search_available_corpora_for_session_with_diagnostics(
            &store,
            project,
            session_id,
            "dated needle",
            MemorySearchOptions {
                limit: 20,
                include_memories: true,
                include_messages: true,
                include_notes: true,
                excluded_memory_ids: &excluded,
                from_ms: Some(2_000),
                to_ms: Some(4_000),
            },
        )
        .unwrap();

        assert!(outcome
            .results
            .iter()
            .any(|result| result.id == inside_memory));
        assert!(!outcome
            .results
            .iter()
            .any(|result| result.id == outside_memory));
        assert!(outcome
            .results
            .iter()
            .any(|result| result.id == inside_note));
        assert!(!outcome
            .results
            .iter()
            .any(|result| result.id == outside_note));
        assert!(outcome
            .results
            .iter()
            .any(|result| result.sequence == Some(2)));
        assert!(!outcome
            .results
            .iter()
            .any(|result| result.sequence == Some(1)));
    }

    #[test]
    fn note_search_excludes_dismissed_rows_and_scores_keyword_relevance() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let project = "git:own";
        let session_id = "session-notes";
        let dense = insert_note(
            &store,
            project,
            session_id,
            "needle semantic calibration decision",
            10,
        );
        let weak = insert_note(
            &store,
            project,
            session_id,
            "A long unrelated reminder with background context and one needle token",
            20,
        );
        let dismissed = insert_note(
            &store,
            project,
            session_id,
            "needle semantic calibration decision dismissed",
            30,
        );
        store
            .dismiss_note(project, session_id, dismissed, None, 40)
            .unwrap()
            .unwrap();

        let excluded = BTreeSet::new();
        let outcome = search_available_corpora_for_session_with_diagnostics(
            &store,
            project,
            session_id,
            "needle semantic calibration decision",
            MemorySearchOptions {
                limit: 10,
                include_memories: false,
                include_messages: false,
                include_notes: true,
                excluded_memory_ids: &excluded,
                from_ms: None,
                to_ms: None,
            },
        )
        .unwrap();

        assert_eq!(
            outcome
                .results
                .iter()
                .map(|result| result.id)
                .collect::<Vec<_>>(),
            vec![dense, weak]
        );
        assert_eq!(outcome.results[0].score_hundredths, 80);
        assert_eq!(outcome.results[1].score_hundredths, 1);
        assert!(!outcome.results.iter().any(|result| result.id == dismissed));
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

fn legacy_search_availability(
    options: MemorySearchOptions<'_>,
) -> std::collections::BTreeMap<String, crate::parity_contract::Availability> {
    use crate::parity_contract::{Availability, CapabilityReason};
    let mut components = std::collections::BTreeMap::new();
    if options.include_memories {
        components.insert(
            "memory".into(),
            Availability::Degraded {
                reason: CapabilityReason {
                    code: "literal_only".into(),
                    message: "Legacy memory search has no BM25 ranking or stored vectors".into(),
                },
            },
        );
    }
    if options.include_messages {
        components.insert(
            "compartment".into(),
            Availability::Degraded {
                reason: CapabilityReason {
                    code: "literal_only".into(),
                    message: "Legacy compartment search has no chunk vectors".into(),
                },
            },
        );
        components.insert(
            "raw_message".into(),
            mc_store::parity_schema_manifest::unavailable("raw_message"),
        );
    }
    components
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SearchSource {
    Memory,
    Message,
    GitCommit,
    Primer,
    Note,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct SupportedSearchOptions {
    pub limit: Option<f64>,
    pub dates: hybrid::DateBounds,
    pub sources: Option<Vec<SearchSource>>,
    pub memory_enabled: bool,
    pub embedding_enabled: bool,
    pub max_message_ordinal: Option<i64>,
}

impl Default for SupportedSearchOptions {
    fn default() -> Self {
        Self {
            limit: None,
            dates: Default::default(),
            sources: None,
            memory_enabled: true,
            embedding_enabled: true,
            max_message_ordinal: None,
        }
    }
}

impl SupportedSearchOptions {
    pub fn limit(&self) -> usize {
        self.limit
            .filter(|v| v.is_finite())
            .unwrap_or(10.0)
            .floor()
            .clamp(1.0, 25.0) as usize
    }
    fn has(&self, source: SearchSource) -> bool {
        self.sources
            .as_ref()
            .is_none_or(|sources| sources.contains(&source))
    }
}

#[derive(Debug, Clone)]
pub struct SearchQueryVector {
    pub identity: crate::parity_contract::EmbeddingIdentity,
    pub values: Vec<f32>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SupportedSearchOutcome {
    pub results: Vec<hybrid::SearchHit>,
    pub diagnostics: hybrid::RetrievalDiagnostics,
}

/// Rank memory and semantic compressed-history lanes. Raw archive fusion,
/// literal probes and prose reranking are deliberately separate consumers.
/// A caller may reuse one certified query vector across these two lanes.
pub fn search_retrieval_inputs(
    store: &dyn hybrid::RetrievalInputStore,
    scope: &crate::parity_contract::StoreScope,
    query: &str,
    options: &SupportedSearchOptions,
    query_vector: Option<&SearchQueryVector>,
) -> SupportedSearchOutcome {
    use hybrid::{RetrievalDiagnostics, SearchHit};
    let mut outcome = SupportedSearchOutcome {
        results: Vec::new(),
        diagnostics: RetrievalDiagnostics::default(),
    };
    let query = hybrid::trim_query(query);
    let diagnostics = &mut outcome.diagnostics;
    for (source, name) in [
        (SearchSource::Message, "raw_message"),
        (SearchSource::GitCommit, "git_commit"),
        (SearchSource::Primer, "primer"),
        (SearchSource::Note, "note"),
    ] {
        if options.has(source) {
            diagnostics.components.insert(
                name.into(),
                mc_store::parity_schema_manifest::unavailable(name),
            );
        }
    }
    if query.is_empty() {
        return outcome;
    }
    let limit = options.limit();
    let tier_limit = (limit * 3).max(10);
    let query_vector = query_vector.filter(|v| {
        options.embedding_enabled
            && v.identity.model != "off"
            && v.values.len() == v.identity.dimensions as usize
            && !v.values.is_empty()
            && v.values.iter().all(|v| v.is_finite())
    });
    if options.embedding_enabled && query_vector.is_none() {
        diagnostics.components.insert(
            "query_embedding".into(),
            mc_store::parity_schema_manifest::unavailable("query_embedding"),
        );
    }
    if options.has(SearchSource::Memory) && options.memory_enabled {
        let memories = diagnostics.take(
            "memory_rows",
            store.read_search_memories(scope, options.dates),
        );
        let visible = diagnostics.take("visibility", store.read_visible_memory_ids(scope));
        let fts = diagnostics
            .take(
                "memory_fts",
                store.search_memory_fts(scope, query, options.dates, hybrid::FTS_CANDIDATE_LIMIT),
            )
            .unwrap_or_default();
        if let (Some(memories), Some(visible)) = (memories, visible) {
            let vectors = query_vector
                .and_then(|query| {
                    diagnostics.take(
                        "memory_vectors",
                        store.read_memory_vectors(
                            scope,
                            &memories.iter().map(|m| m.id).collect::<Vec<_>>(),
                            &query.identity,
                        ),
                    )
                })
                .unwrap_or_default();
            let (hits, suppressed) = hybrid::rank_memories(
                &memories,
                &fts,
                &vectors,
                query_vector.map(|q| (&q.identity, q.values.as_slice())),
                &visible,
                options.dates,
                tier_limit,
            );
            diagnostics.suppressed_visible_memory_ids = suppressed;
            outcome
                .results
                .extend(hits.into_iter().map(SearchHit::Memory));
        }
    }
    if options.has(SearchSource::Message) && options.embedding_enabled {
        if let Some(query) = query_vector {
            if let Some(chunks) = diagnostics.take(
                "compartment_vectors",
                store.read_compartment_chunks(scope, options.dates, &query.identity),
            ) {
                outcome.results.extend(
                    compartments::rank_compartments(
                        &chunks,
                        scope,
                        &query.identity,
                        &query.values,
                        options.dates,
                        options.max_message_ordinal,
                        tier_limit,
                    )
                    .into_iter()
                    .map(SearchHit::Compartment),
                );
            }
        } else {
            diagnostics.components.insert(
                "compartment_vectors".into(),
                mc_store::parity_schema_manifest::unavailable("query_embedding"),
            );
        }
    }
    hybrid::sort_supported_hits(&mut outcome.results);
    outcome.results.truncate(limit);
    outcome
}

/// Fetch exactly one query embedding through the provider contract. Failure or
/// stale generation retains FTS recall and explicitly diagnoses degraded semantics.
pub async fn search_retrieval_inputs_with_provider(
    store: &dyn hybrid::RetrievalInputStore,
    provider: &dyn crate::parity_contract::EmbeddingProvider,
    context: &crate::parity_contract::RequestContext,
    query: &str,
    options: &SupportedSearchOptions,
    identity: &crate::parity_contract::EmbeddingIdentity,
) -> SupportedSearchOutcome {
    use crate::parity_contract::*;
    let scope = context.route.scope();
    let query = hybrid::trim_query(query);
    let needs_embedding = options.embedding_enabled
        && identity.model != "off"
        && !query.is_empty()
        && ((options.has(SearchSource::Memory) && options.memory_enabled)
            || options.has(SearchSource::Message));
    let mut captured = None;
    let mut availability = None;
    if needs_embedding && !context.control.is_cancelled() {
        let request = EmbeddingRequest {
            identity: identity.clone(),
            kind: EmbeddingInputKind::Query,
            inputs: vec![EmbeddingInput {
                text: query.into(),
                source: Provenance {
                    origin: InputOrigin::Core,
                    source_id: context.invocation.0.clone(),
                    source_revision: "query".into(),
                    content_hash: ContentHash(format!(
                        "{:x}",
                        <sha2::Sha256 as sha2::Digest>::digest(query.as_bytes())
                    )),
                    generation: scope.generation,
                    observed_at_ms: chrono::Utc::now().timestamp_millis(),
                },
            }],
        };
        let reply = provider.embed(context, &request).await;
        availability = Some(reply.availability());
        let value = match reply {
            CapabilityResult::Available { value } | CapabilityResult::Degraded { value, .. } => {
                Some(value)
            }
            CapabilityResult::Unavailable { .. } => None,
        };
        if let Some(value) = value {
            if value.identity == *identity
                && value.generation == context.config_generation
                && value.vectors.len() == 1
                && value.vectors[0].embedding == *identity
                && value.vectors[0].values.len() == identity.dimensions as usize
                && !value.vectors[0].values.is_empty()
                && value.vectors[0].values.iter().all(|v| v.is_finite())
            {
                captured = Some(SearchQueryVector {
                    identity: identity.clone(),
                    values: value.vectors[0].values.clone(),
                });
            } else {
                availability = Some(Availability::Degraded { reason: CapabilityReason {
                    code: "stale_or_invalid_embedding".into(), message: "Query vector does not match the request model, dimensions or generation".into(),
                }});
            }
        }
    }
    if context.control.is_cancelled() {
        return SupportedSearchOutcome {
            results: Vec::new(),
            diagnostics: hybrid::RetrievalDiagnostics {
                suppressed_visible_memory_ids: Vec::new(),
                components: std::collections::BTreeMap::from([(
                    "query_embedding".into(),
                    Availability::Unavailable {
                        reason: CapabilityReason {
                            code: "cancelled".into(),
                            message: "Search was cancelled".into(),
                        },
                    },
                )]),
            },
        };
    }
    let mut outcome = search_retrieval_inputs(store, scope, query, options, captured.as_ref());
    if let Some(availability) = availability {
        outcome
            .diagnostics
            .components
            .insert("query_embedding".into(), availability);
    }
    outcome
}
