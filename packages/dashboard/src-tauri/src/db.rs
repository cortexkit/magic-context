use rusqlite::Connection;
use serde::Serialize;
use std::path::PathBuf;

pub fn resolve_db_path() -> Option<PathBuf> {
    // The magic-context plugin uses ~/.local/share/opencode/... on macOS and Linux
    // (XDG-style), and %APPDATA%/opencode/... on Windows.
    let data_dir = if cfg!(target_os = "windows") {
        dirs::data_dir()?
    } else {
        // XDG_DATA_HOME or ~/.local/share (matches plugin behavior)
        std::env::var("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                dirs::home_dir()
                    .unwrap_or_default()
                    .join(".local")
                    .join("share")
            })
    };
    let db_path = data_dir
        .join("opencode")
        .join("storage")
        .join("plugin")
        .join("magic-context")
        .join("context.db");
    if db_path.exists() {
        Some(db_path)
    } else {
        None
    }
}

/// Opens a read-only connection to the database in WAL mode.
pub fn open_readonly(path: &PathBuf) -> Result<Connection, rusqlite::Error> {
    let conn = Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    // WAL mode is inherited from the plugin's read-write connection — no need to set it here.
    // busy_timeout is connection-local and safe on read-only connections.
    conn.pragma_update(None, "busy_timeout", 5000)?;
    Ok(conn)
}

/// Opens a read-write connection for write operations (memory edits, queue entries).
pub fn open_readwrite(path: &PathBuf) -> Result<Connection, rusqlite::Error> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "busy_timeout", 5000)?;
    Ok(conn)
}

// ── Memory types ──────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct Memory {
    pub id: i64,
    pub project_path: String,
    pub category: String,
    pub content: String,
    pub normalized_hash: String,
    pub source_session_id: Option<String>,
    pub source_type: String,
    pub seen_count: i64,
    pub retrieval_count: i64,
    pub first_seen_at: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_seen_at: i64,
    pub last_retrieved_at: Option<i64>,
    pub status: String,
    pub expires_at: Option<i64>,
    pub verification_status: String,
    pub verified_at: Option<i64>,
    pub superseded_by_memory_id: Option<i64>,
    pub merged_from: Option<String>,
    pub metadata_json: Option<String>,
    pub has_embedding: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct MemoryStats {
    pub total: i64,
    pub active: i64,
    pub permanent: i64,
    pub archived: i64,
    pub with_embeddings: i64,
    pub categories: Vec<CategoryCount>,
}

#[derive(Debug, Serialize, Clone)]
pub struct CategoryCount {
    pub category: String,
    pub count: i64,
}

// ── Session types ──────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct SessionSummary {
    pub session_id: String,
    pub title: Option<String>,
    pub project_identity: Option<String>,
    pub compartment_count: i64,
    pub fact_count: i64,
    pub note_count: i64,
    pub first_compartment_start: Option<i64>,
    pub last_compartment_end: Option<i64>,
    pub last_response_time: Option<i64>,
    pub last_context_percentage: Option<f64>,
    pub is_subagent: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct Compartment {
    pub id: i64,
    pub session_id: String,
    pub sequence: i64,
    pub start_message: i64,
    pub end_message: i64,
    pub title: String,
    pub content: String,
    pub created_at: i64,
}

#[derive(Debug, Serialize, Clone)]
pub struct SessionFact {
    pub id: i64,
    pub session_id: String,
    pub category: String,
    pub content: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize, Clone)]
pub struct SessionNote {
    pub id: i64,
    pub session_id: String,
    pub content: String,
    pub created_at: i64,
}

#[derive(Debug, Serialize, Clone)]
pub struct SessionMetaRow {
    pub session_id: String,
    pub last_response_time: Option<i64>,
    pub cache_ttl: Option<String>,
    pub counter: i64,
    pub last_nudge_tokens: i64,
    pub last_nudge_band: String,
    pub is_subagent: bool,
    pub last_context_percentage: f64,
    pub last_input_tokens: i64,
    pub times_execute_threshold_reached: i64,
    pub compartment_in_progress: bool,
    pub system_prompt_hash: String,
    pub memory_block_count: i64,
}

// ── Dreamer types ──────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct DreamQueueEntry {
    pub id: i64,
    pub project_path: String,
    pub reason: String,
    pub enqueued_at: i64,
    pub started_at: Option<i64>,
    pub retry_count: i64,
}

#[derive(Debug, Serialize, Clone)]
pub struct DreamStateEntry {
    pub key: String,
    pub value: String,
}

// ── Context Token Breakdown ───────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct ContextTokenBreakdown {
    pub total_input_tokens: i64,
    pub system_prompt_tokens: i64,
    pub compartment_tokens: i64,
    pub fact_tokens: i64,
    pub memory_tokens: i64,
    pub conversation_tokens: i64, // total - compartments - facts - memories - system_prompt
    pub compartment_count: i64,
    pub fact_count: i64,
    pub memory_count: i64,
}

/// Estimate tokens using ~4 chars per token (CHARS_PER_TOKEN_ESTIMATE = 4)
fn estimate_tokens(chars: i64) -> i64 {
    (chars + 3) / 4 // Round up
}

/// XML overhead for compartments (approximate: <compartment title="...">...</compartment>)
const COMPARTMENT_XML_OVERHEAD: i64 = 50;

pub fn get_context_token_breakdown(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<ContextTokenBreakdown>, rusqlite::Error> {
    // Get total input tokens and system prompt tokens from session_meta
    let (total_input_tokens, system_prompt_tokens): (i64, i64) = conn
        .query_row(
            "SELECT COALESCE(last_input_tokens, 0), COALESCE(system_prompt_tokens, 0) FROM session_meta WHERE session_id = ?1",
            [session_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap_or((0, 0));

    // If no input tokens recorded, return None (no data available)
    if total_input_tokens == 0 {
        return Ok(None);
    }

    // Get compartment content length and count
    let (compartment_chars, compartment_count): (i64, i64) = conn
        .query_row(
            "SELECT COALESCE(SUM(LENGTH(title) + LENGTH(content) + ?2), 0), COUNT(*) 
             FROM compartments WHERE session_id = ?1",
            rusqlite::params![session_id, COMPARTMENT_XML_OVERHEAD],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap_or((0, 0));

    // Get fact content length and count
    let (fact_chars, fact_count): (i64, i64) = conn
        .query_row(
            "SELECT COALESCE(SUM(LENGTH(category) + LENGTH(content) + 20), 0), COUNT(*) 
             FROM session_facts WHERE session_id = ?1",
            [session_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap_or((0, 0));

    // Get memory block cache (rendered XML) and count from session_meta
    let (memory_cache_str, memory_count): (Option<String>, i64) = conn
        .query_row(
            "SELECT memory_block_cache, COALESCE(memory_block_count, 0) FROM session_meta WHERE session_id = ?1",
            [session_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap_or((None, 0));

    let memory_chars = memory_cache_str
        .as_ref()
        .filter(|s| !s.is_empty())
        .map(|s| s.len() as i64)
        .unwrap_or(0);

    // Estimate tokens
    let compartment_tokens = estimate_tokens(compartment_chars);
    let fact_tokens = estimate_tokens(fact_chars);
    let memory_tokens = estimate_tokens(memory_chars);

    // Conversation tokens = total - all known sections
    let known_tokens = system_prompt_tokens + compartment_tokens + fact_tokens + memory_tokens;
    let conversation_tokens = if total_input_tokens > known_tokens {
        total_input_tokens - known_tokens
    } else {
        0
    };

    Ok(Some(ContextTokenBreakdown {
        total_input_tokens,
        system_prompt_tokens,
        compartment_tokens,
        fact_tokens,
        memory_tokens,
        conversation_tokens,
        compartment_count,
        fact_count,
        memory_count,
    }))
}

// ── Database health ───────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct DbHealth {
    pub exists: bool,
    pub path: String,
    pub size_bytes: u64,
    pub wal_size_bytes: u64,
    pub table_counts: Vec<TableCount>,
}

#[derive(Debug, Serialize, Clone)]
pub struct TableCount {
    pub table_name: String,
    pub row_count: i64,
}

// ── Helpers ───────────────────────────────────────────────────

/// Compute a normalized hash matching the plugin's dedup logic:
/// lowercase → trim whitespace → hash as hex string.
/// Uses std::hash for portability (no SHA crate in deps); the exact
/// hash algorithm doesn't matter as long as it's consistent within
/// the dashboard. The plugin uses its own Bun-based hash path.
/// Match the plugin's `computeNormalizedHash`: lowercase → collapse whitespace → trim → MD5 hex.
fn normalize_hash(content: &str) -> String {
    let normalized = content.to_lowercase();
    // Collapse all whitespace runs into a single space (mirrors JS /\s+/g → " ")
    let normalized: String = normalized.split_whitespace().collect::<Vec<_>>().join(" ");
    let digest = md5::compute(normalized.as_bytes());
    format!("{:032x}", digest)
}

// ── Project resolution ────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct ProjectInfo {
    pub identity: String,
    pub label: String,        // friendly name (directory basename or identity)
    pub path: Option<String>, // resolved filesystem path, if found
}

pub fn get_projects(conn: &Connection) -> Result<Vec<ProjectInfo>, rusqlite::Error> {
    let mut stmt =
        conn.prepare("SELECT DISTINCT project_path FROM memories ORDER BY project_path")?;
    let identities: Vec<String> = stmt
        .query_map([], |row| row.get(0))?
        .collect::<Result<Vec<_>, _>>()?;

    // Resolve git:HASH identities via OpenCode's project table
    let hash_to_project = resolve_from_opencode_db(&identities);

    let projects = identities
        .into_iter()
        .map(|id| {
            let (label, path) = if let Some((name, worktree)) = hash_to_project.get(&id) {
                let display = if name.is_empty() {
                    // Use directory basename as label
                    std::path::Path::new(worktree)
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| worktree.clone())
                } else {
                    name.clone()
                };
                (display, Some(worktree.clone()))
            } else if id.starts_with("git:") {
                let short = &id[4..std::cmp::min(id.len(), 14)];
                (format!("git:{short}…"), None)
            } else {
                (id.clone(), None)
            };
            ProjectInfo {
                identity: id,
                label,
                path,
            }
        })
        .collect();

    Ok(projects)
}

/// Look up project names and worktrees from OpenCode's own database.
/// OpenCode stores projects with `id` = git root commit hash and `worktree` = directory path.
fn resolve_from_opencode_db(
    identities: &[String],
) -> std::collections::HashMap<String, (String, String)> {
    use std::collections::HashMap;

    let mut result = HashMap::new();

    // Find the opencode.db path (same parent as our plugin storage)
    let opencode_db = {
        let data_dir = if cfg!(target_os = "windows") {
            match dirs::data_dir() {
                Some(d) => d,
                None => return result,
            }
        } else {
            std::env::var("XDG_DATA_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|_| {
                    dirs::home_dir()
                        .unwrap_or_default()
                        .join(".local")
                        .join("share")
                })
        };
        data_dir.join("opencode").join("opencode.db")
    };

    if !opencode_db.exists() {
        return result;
    }

    let conn = match Connection::open_with_flags(
        &opencode_db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(c) => c,
        Err(_) => return result,
    };

    // Query all projects — the table is small
    let mut stmt = match conn.prepare("SELECT id, name, worktree FROM project") {
        Ok(s) => s,
        Err(_) => return result,
    };

    let rows = match stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, String>(2)?,
        ))
    }) {
        Ok(r) => r,
        Err(_) => return result,
    };

    // Build a hash → (name, worktree) map
    let mut oc_projects: HashMap<String, (String, String)> = HashMap::new();
    for row in rows.flatten() {
        let (id, name, worktree) = row;
        oc_projects.insert(id, (name.unwrap_or_default(), worktree));
    }

    // Match our git:HASH identities against opencode project IDs
    for identity in identities {
        if let Some(hash) = identity.strip_prefix("git:") {
            if let Some((name, worktree)) = oc_projects.get(hash) {
                result.insert(identity.clone(), (name.clone(), worktree.clone()));
            }
        }
    }

    result
}

// ── Query implementations ─────────────────────────────────────

pub fn get_memories(
    conn: &Connection,
    project_filter: Option<&str>,
    status_filter: Option<&str>,
    category_filter: Option<&str>,
    search_query: Option<&str>,
    limit: i64,
    offset: i64,
) -> Result<Vec<Memory>, rusqlite::Error> {
    let raw_search = search_query.unwrap_or("").trim().to_string();
    let has_search = !raw_search.is_empty();

    // Sanitize search query for FTS5: wrap each token in double quotes so
    // special characters (/, -, etc.) are treated as literals, matching the
    // plugin's sanitizeFtsQuery() approach.
    let sanitized_fts = if has_search {
        let tokens: Vec<String> = raw_search
            .split_whitespace()
            .filter(|t| !t.is_empty())
            .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
            .collect();
        if tokens.is_empty() {
            String::new()
        } else {
            tokens.join(" ")
        }
    } else {
        String::new()
    };
    let use_fts = !sanitized_fts.is_empty();
    // For very short queries (< 3 chars) or if FTS sanitization produces nothing,
    // fall back to LIKE which handles partial matches better
    let use_like_fallback = has_search && (!use_fts || raw_search.len() < 3);
    let like_pattern = format!("%{}%", raw_search.replace('%', "\\%").replace('_', "\\_"));

    // Build WHERE clauses and params dynamically
    let mut conditions = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if use_fts && !use_like_fallback {
        params.push(Box::new(sanitized_fts.clone()));
        // FTS match uses the first param
    } else if has_search {
        params.push(Box::new(like_pattern.clone()));
        // LIKE uses the first param
    }

    if let Some(p) = project_filter {
        params.push(Box::new(p.to_string()));
        conditions.push(format!("m.project_path = ?{}", params.len()));
    }
    if let Some(s) = status_filter {
        params.push(Box::new(s.to_string()));
        conditions.push(format!("m.status = ?{}", params.len()));
    }
    if let Some(c) = category_filter {
        params.push(Box::new(c.to_string()));
        conditions.push(format!("m.category = ?{}", params.len()));
    }

    let where_extra = if conditions.is_empty() {
        String::new()
    } else {
        format!("AND {}", conditions.join(" AND "))
    };

    // Add limit and offset
    let limit_idx = params.len() + 1;
    let offset_idx = params.len() + 2;
    params.push(Box::new(limit));
    params.push(Box::new(offset));

    let sql = if use_fts && !use_like_fallback {
        // FTS5 search with sanitized query
        format!(
            "SELECT m.id, m.project_path, m.category, m.content, m.normalized_hash,
                    m.source_session_id, m.source_type, m.seen_count, m.retrieval_count,
                    m.first_seen_at, m.created_at, m.updated_at, m.last_seen_at,
                    m.last_retrieved_at, m.status, m.expires_at, m.verification_status,
                    m.verified_at, m.superseded_by_memory_id, m.merged_from, m.metadata_json,
                    (CASE WHEN me.memory_id IS NOT NULL THEN 1 ELSE 0 END) as has_embedding
             FROM memories m
             LEFT JOIN memory_embeddings me ON me.memory_id = m.id
             INNER JOIN memories_fts ON memories_fts.rowid = m.id
             WHERE memories_fts MATCH ?1
             {}
             ORDER BY rank
             LIMIT ?{} OFFSET ?{}",
            where_extra, limit_idx, offset_idx,
        )
    } else if has_search {
        // LIKE fallback for short queries or special-character-heavy input
        format!(
            "SELECT m.id, m.project_path, m.category, m.content, m.normalized_hash,
                    m.source_session_id, m.source_type, m.seen_count, m.retrieval_count,
                    m.first_seen_at, m.created_at, m.updated_at, m.last_seen_at,
                    m.last_retrieved_at, m.status, m.expires_at, m.verification_status,
                    m.verified_at, m.superseded_by_memory_id, m.merged_from, m.metadata_json,
                    (CASE WHEN me.memory_id IS NOT NULL THEN 1 ELSE 0 END) as has_embedding
             FROM memories m
             LEFT JOIN memory_embeddings me ON me.memory_id = m.id
             WHERE (m.content LIKE ?1 ESCAPE '\\' OR m.category LIKE ?1 ESCAPE '\\')
             {}
             ORDER BY m.updated_at DESC
             LIMIT ?{} OFFSET ?{}",
            where_extra, limit_idx, offset_idx,
        )
    } else {
        format!(
            "SELECT m.id, m.project_path, m.category, m.content, m.normalized_hash,
                    m.source_session_id, m.source_type, m.seen_count, m.retrieval_count,
                    m.first_seen_at, m.created_at, m.updated_at, m.last_seen_at,
                    m.last_retrieved_at, m.status, m.expires_at, m.verification_status,
                    m.verified_at, m.superseded_by_memory_id, m.merged_from, m.metadata_json,
                    (CASE WHEN me.memory_id IS NOT NULL THEN 1 ELSE 0 END) as has_embedding
             FROM memories m
             LEFT JOIN memory_embeddings me ON me.memory_id = m.id
             WHERE 1=1
             {}
             ORDER BY m.updated_at DESC
             LIMIT ?{} OFFSET ?{}",
            where_extra, limit_idx, offset_idx,
        )
    };

    // Try FTS first; if it fails (e.g. malformed query despite sanitization), fall back to LIKE
    let result = {
        let mut stmt = conn.prepare(&sql)?;
        let param_refs: Vec<&dyn rusqlite::types::ToSql> =
            params.iter().map(|p| p.as_ref()).collect();
        let rows = stmt.query_map(param_refs.as_slice(), map_memory_row)?;
        rows.collect::<Result<Vec<_>, _>>()
    };

    match result {
        Ok(memories) if !memories.is_empty() || !use_fts => Ok(memories),
        Ok(_empty) if use_fts && !use_like_fallback => {
            // FTS returned nothing — retry with LIKE for better partial matching
            let like_sql = format!(
                "SELECT m.id, m.project_path, m.category, m.content, m.normalized_hash,
                        m.source_session_id, m.source_type, m.seen_count, m.retrieval_count,
                        m.first_seen_at, m.created_at, m.updated_at, m.last_seen_at,
                        m.last_retrieved_at, m.status, m.expires_at, m.verification_status,
                        m.verified_at, m.superseded_by_memory_id, m.merged_from, m.metadata_json,
                        (CASE WHEN me.memory_id IS NOT NULL THEN 1 ELSE 0 END) as has_embedding
                 FROM memories m
                 LEFT JOIN memory_embeddings me ON me.memory_id = m.id
                 WHERE (m.content LIKE ?1 ESCAPE '\\' OR m.category LIKE ?1 ESCAPE '\\')
                 {}
                 ORDER BY m.updated_at DESC
                 LIMIT ?{} OFFSET ?{}",
                where_extra, limit_idx, offset_idx,
            );
            // Rebuild params with LIKE pattern instead of FTS query
            let mut like_params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
            like_params.push(Box::new(like_pattern));
            // Re-add filter params
            if let Some(p) = project_filter {
                like_params.push(Box::new(p.to_string()));
            }
            if let Some(s) = status_filter {
                like_params.push(Box::new(s.to_string()));
            }
            if let Some(c) = category_filter {
                like_params.push(Box::new(c.to_string()));
            }
            like_params.push(Box::new(limit));
            like_params.push(Box::new(offset));

            let mut stmt = conn.prepare(&like_sql)?;
            let param_refs: Vec<&dyn rusqlite::types::ToSql> =
                like_params.iter().map(|p| p.as_ref()).collect();
            let rows = stmt.query_map(param_refs.as_slice(), map_memory_row)?;
            rows.collect()
        }
        Err(e) if use_fts => {
            // FTS query failed — fall back to LIKE
            eprintln!("FTS search failed, falling back to LIKE: {}", e);
            let like_sql = format!(
                "SELECT m.id, m.project_path, m.category, m.content, m.normalized_hash,
                        m.source_session_id, m.source_type, m.seen_count, m.retrieval_count,
                        m.first_seen_at, m.created_at, m.updated_at, m.last_seen_at,
                        m.last_retrieved_at, m.status, m.expires_at, m.verification_status,
                        m.verified_at, m.superseded_by_memory_id, m.merged_from, m.metadata_json,
                        (CASE WHEN me.memory_id IS NOT NULL THEN 1 ELSE 0 END) as has_embedding
                 FROM memories m
                 LEFT JOIN memory_embeddings me ON me.memory_id = m.id
                 WHERE (m.content LIKE ?1 ESCAPE '\\' OR m.category LIKE ?1 ESCAPE '\\')
                 {}
                 ORDER BY m.updated_at DESC
                 LIMIT ?{} OFFSET ?{}",
                where_extra, limit_idx, offset_idx,
            );
            let mut like_params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
            like_params.push(Box::new(like_pattern));
            if let Some(p) = project_filter {
                like_params.push(Box::new(p.to_string()));
            }
            if let Some(s) = status_filter {
                like_params.push(Box::new(s.to_string()));
            }
            if let Some(c) = category_filter {
                like_params.push(Box::new(c.to_string()));
            }
            like_params.push(Box::new(limit));
            like_params.push(Box::new(offset));

            let mut stmt = conn.prepare(&like_sql)?;
            let param_refs: Vec<&dyn rusqlite::types::ToSql> =
                like_params.iter().map(|p| p.as_ref()).collect();
            let rows = stmt.query_map(param_refs.as_slice(), map_memory_row)?;
            rows.collect()
        }
        other => other,
    }
}

fn map_memory_row(row: &rusqlite::Row<'_>) -> Result<Memory, rusqlite::Error> {
    Ok(Memory {
        id: row.get(0)?,
        project_path: row.get(1)?,
        category: row.get(2)?,
        content: row.get(3)?,
        normalized_hash: row.get(4)?,
        source_session_id: row.get(5)?,
        source_type: row.get(6)?,
        seen_count: row.get(7)?,
        retrieval_count: row.get(8)?,
        first_seen_at: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        last_seen_at: row.get(12)?,
        last_retrieved_at: row.get(13)?,
        status: row.get(14)?,
        expires_at: row.get(15)?,
        verification_status: row.get(16)?,
        verified_at: row.get(17)?,
        superseded_by_memory_id: row.get(18)?,
        merged_from: row.get(19)?,
        metadata_json: row.get(20)?,
        has_embedding: row.get::<_, i64>(21)? != 0,
    })
}

pub fn get_memory_stats(
    conn: &Connection,
    project_filter: Option<&str>,
) -> Result<MemoryStats, rusqlite::Error> {
    let project_clause = if project_filter.is_some() {
        "WHERE project_path = ?1"
    } else {
        ""
    };
    let project_and = if project_filter.is_some() {
        "AND project_path = ?1"
    } else {
        ""
    };

    let total: i64 = if let Some(p) = project_filter {
        conn.query_row(
            &format!("SELECT COUNT(*) FROM memories {}", project_clause),
            [p],
            |r| r.get(0),
        )?
    } else {
        conn.query_row("SELECT COUNT(*) FROM memories", [], |r| r.get(0))?
    };
    let active: i64 = if let Some(p) = project_filter {
        conn.query_row(
            &format!(
                "SELECT COUNT(*) FROM memories WHERE status = 'active' {}",
                project_and
            ),
            [p],
            |r| r.get(0),
        )?
    } else {
        conn.query_row(
            "SELECT COUNT(*) FROM memories WHERE status = 'active'",
            [],
            |r| r.get(0),
        )?
    };
    let permanent: i64 = if let Some(p) = project_filter {
        conn.query_row(
            &format!(
                "SELECT COUNT(*) FROM memories WHERE status = 'permanent' {}",
                project_and
            ),
            [p],
            |r| r.get(0),
        )?
    } else {
        conn.query_row(
            "SELECT COUNT(*) FROM memories WHERE status = 'permanent'",
            [],
            |r| r.get(0),
        )?
    };
    let archived: i64 = if let Some(p) = project_filter {
        conn.query_row(
            &format!(
                "SELECT COUNT(*) FROM memories WHERE status = 'archived' {}",
                project_and
            ),
            [p],
            |r| r.get(0),
        )?
    } else {
        conn.query_row(
            "SELECT COUNT(*) FROM memories WHERE status = 'archived'",
            [],
            |r| r.get(0),
        )?
    };
    let with_embeddings: i64 = if let Some(p) = project_filter {
        conn.query_row(
            "SELECT COUNT(*) FROM memory_embeddings me JOIN memories m ON me.memory_id = m.id WHERE m.project_path = ?1",
            [p], |r| r.get(0),
        )?
    } else {
        conn.query_row("SELECT COUNT(*) FROM memory_embeddings", [], |r| r.get(0))?
    };

    let cat_sql = if project_filter.is_some() {
        "SELECT category, COUNT(*) as cnt FROM memories WHERE status != 'archived' AND project_path = ?1 GROUP BY category ORDER BY cnt DESC"
    } else {
        "SELECT category, COUNT(*) as cnt FROM memories WHERE status != 'archived' GROUP BY category ORDER BY cnt DESC"
    };
    let mut stmt = conn.prepare(cat_sql)?;
    let categories: Vec<CategoryCount> = if let Some(p) = project_filter {
        stmt.query_map([p], |row| {
            Ok(CategoryCount {
                category: row.get(0)?,
                count: row.get(1)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?
    } else {
        stmt.query_map([], |row| {
            Ok(CategoryCount {
                category: row.get(0)?,
                count: row.get(1)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?
    };

    Ok(MemoryStats {
        total,
        active,
        permanent,
        archived,
        with_embeddings,
        categories,
    })
}

pub fn update_memory_status(
    conn: &Connection,
    memory_id: i64,
    new_status: &str,
) -> Result<(), rusqlite::Error> {
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "UPDATE memories SET status = ?1, updated_at = ?2 WHERE id = ?3",
        rusqlite::params![new_status, now, memory_id],
    )?;
    Ok(())
}

pub fn update_memory_content(
    conn: &Connection,
    memory_id: i64,
    new_content: &str,
) -> Result<(), rusqlite::Error> {
    let now = chrono::Utc::now().timestamp_millis();
    let new_hash = normalize_hash(new_content);
    conn.execute(
        "UPDATE memories SET content = ?1, normalized_hash = ?2, updated_at = ?3 WHERE id = ?4",
        rusqlite::params![new_content, new_hash, now, memory_id],
    )?;
    // Delete stale embedding since content changed
    conn.execute(
        "DELETE FROM memory_embeddings WHERE memory_id = ?1",
        rusqlite::params![memory_id],
    )?;
    Ok(())
}

pub fn delete_memory(conn: &Connection, memory_id: i64) -> Result<(), rusqlite::Error> {
    conn.execute(
        "DELETE FROM memories WHERE id = ?1",
        rusqlite::params![memory_id],
    )?;
    Ok(())
}

// ── Session queries ─────────────────────────────────────────

pub fn get_sessions(conn: &Connection) -> Result<Vec<SessionSummary>, rusqlite::Error> {
    let sql = "
        WITH comp_stats AS (
            SELECT session_id,
                   COUNT(*) AS cnt,
                   MIN(start_message) AS first_start,
                   MAX(end_message) AS last_end
            FROM compartments GROUP BY session_id
        ),
        fact_stats AS (
            SELECT session_id, COUNT(*) AS cnt FROM session_facts GROUP BY session_id
        ),
        note_stats AS (
            SELECT session_id, COUNT(*) AS cnt FROM session_notes GROUP BY session_id
        )
        SELECT
            sm.session_id,
            COALESCE(cs.cnt, 0),
            COALESCE(fs.cnt, 0),
            COALESCE(ns.cnt, 0),
            cs.first_start,
            cs.last_end,
            sm.last_response_time,
            sm.last_context_percentage,
            sm.is_subagent
        FROM session_meta sm
        LEFT JOIN comp_stats cs ON cs.session_id = sm.session_id
        LEFT JOIN fact_stats fs ON fs.session_id = sm.session_id
        LEFT JOIN note_stats ns ON ns.session_id = sm.session_id
        ORDER BY sm.last_response_time DESC NULLS LAST
    ";
    let mut stmt = conn.prepare(sql)?;
    let mut sessions: Vec<SessionSummary> = stmt
        .query_map([], |row| {
            Ok(SessionSummary {
                session_id: row.get(0)?,
                title: None,
                project_identity: None,
                compartment_count: row.get(1)?,
                fact_count: row.get(2)?,
                note_count: row.get(3)?,
                first_compartment_start: row.get(4)?,
                last_compartment_end: row.get(5)?,
                last_response_time: row.get(6)?,
                last_context_percentage: row.get(7)?,
                is_subagent: row.get::<_, i64>(8)? != 0,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    // Resolve session titles and project IDs from OpenCode's DB
    let session_info = resolve_session_info(&sessions);
    for session in &mut sessions {
        if let Some(info) = session_info.get(&session.session_id) {
            session.title = Some(info.0.clone());
            if !info.1.is_empty() {
                session.project_identity = Some(format!("git:{}", info.1));
            }
        }
    }

    Ok(sessions)
}

/// Look up session titles and project IDs from OpenCode's database.
/// Returns HashMap<session_id, (title, project_id)>.
fn resolve_session_info(
    sessions: &[SessionSummary],
) -> std::collections::HashMap<String, (String, String)> {
    use std::collections::HashMap;

    let mut result = HashMap::new();
    if sessions.is_empty() {
        return result;
    }

    let opencode_db = {
        let data_dir = if cfg!(target_os = "windows") {
            match dirs::data_dir() {
                Some(d) => d,
                None => return result,
            }
        } else {
            std::env::var("XDG_DATA_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|_| {
                    dirs::home_dir()
                        .unwrap_or_default()
                        .join(".local")
                        .join("share")
                })
        };
        data_dir.join("opencode").join("opencode.db")
    };

    if !opencode_db.exists() {
        return result;
    }

    let conn = match Connection::open_with_flags(
        &opencode_db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(c) => c,
        Err(_) => return result,
    };

    let mut stmt = match conn.prepare("SELECT id, title, project_id FROM session") {
        Ok(s) => s,
        Err(_) => return result,
    };

    if let Ok(rows) = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    }) {
        for row in rows.flatten() {
            result.insert(row.0, (row.1, row.2));
        }
    }

    result
}

pub fn get_compartments(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<Compartment>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, session_id, sequence, start_message, end_message, title, content, created_at
         FROM compartments WHERE session_id = ?1 ORDER BY sequence DESC",
    )?;
    let rows = stmt.query_map(rusqlite::params![session_id], |row| {
        Ok(Compartment {
            id: row.get(0)?,
            session_id: row.get(1)?,
            sequence: row.get(2)?,
            start_message: row.get(3)?,
            end_message: row.get(4)?,
            title: row.get(5)?,
            content: row.get(6)?,
            created_at: row.get(7)?,
        })
    })?;
    rows.collect()
}

pub fn get_session_facts(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<SessionFact>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, session_id, category, content, created_at, updated_at
         FROM session_facts WHERE session_id = ?1 ORDER BY category, created_at DESC",
    )?;
    let rows = stmt.query_map(rusqlite::params![session_id], |row| {
        Ok(SessionFact {
            id: row.get(0)?,
            session_id: row.get(1)?,
            category: row.get(2)?,
            content: row.get(3)?,
            created_at: row.get(4)?,
            updated_at: row.get(5)?,
        })
    })?;
    rows.collect()
}

pub fn get_session_notes(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<SessionNote>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, session_id, content, created_at
         FROM session_notes WHERE session_id = ?1 ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map(rusqlite::params![session_id], |row| {
        Ok(SessionNote {
            id: row.get(0)?,
            session_id: row.get(1)?,
            content: row.get(2)?,
            created_at: row.get(3)?,
        })
    })?;
    rows.collect()
}

pub fn get_session_meta(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<SessionMetaRow>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT session_id, last_response_time, cache_ttl, counter, last_nudge_tokens,
                last_nudge_band, is_subagent, last_context_percentage, last_input_tokens,
                times_execute_threshold_reached, compartment_in_progress, system_prompt_hash,
                memory_block_count
         FROM session_meta WHERE session_id = ?1",
    )?;
    let mut rows = stmt.query_map(rusqlite::params![session_id], |row| {
        Ok(SessionMetaRow {
            session_id: row.get(0)?,
            last_response_time: row.get(1)?,
            cache_ttl: row.get(2)?,
            counter: row.get(3)?,
            last_nudge_tokens: row.get(4)?,
            last_nudge_band: row.get::<_, String>(5)?,
            is_subagent: row.get::<_, i64>(6)? != 0,
            last_context_percentage: row.get(7)?,
            last_input_tokens: row.get(8)?,
            times_execute_threshold_reached: row.get(9)?,
            compartment_in_progress: row.get::<_, i64>(10)? != 0,
            system_prompt_hash: row.get(11)?,
            memory_block_count: row.get(12)?,
        })
    })?;
    match rows.next() {
        Some(Ok(row)) => Ok(Some(row)),
        Some(Err(e)) => Err(e),
        None => Ok(None),
    }
}

// ── Dreamer queries ─────────────────────────────────────────

pub fn get_dream_queue(conn: &Connection) -> Result<Vec<DreamQueueEntry>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, project_path, reason, enqueued_at, started_at, retry_count
         FROM dream_queue ORDER BY enqueued_at DESC LIMIT 50",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(DreamQueueEntry {
            id: row.get(0)?,
            project_path: row.get(1)?,
            reason: row.get(2)?,
            enqueued_at: row.get(3)?,
            started_at: row.get(4)?,
            retry_count: row.get(5)?,
        })
    })?;
    rows.collect()
}

pub fn get_dream_state(conn: &Connection) -> Result<Vec<DreamStateEntry>, rusqlite::Error> {
    let mut stmt = conn.prepare("SELECT key, value FROM dream_state")?;
    let rows = stmt.query_map([], |row| {
        Ok(DreamStateEntry {
            key: row.get(0)?,
            value: row.get(1)?,
        })
    })?;
    rows.collect()
}

pub fn enqueue_dream(
    conn: &Connection,
    project_path: &str,
    reason: &str,
) -> Result<i64, rusqlite::Error> {
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "INSERT INTO dream_queue (project_path, reason, enqueued_at) VALUES (?1, ?2, ?3)",
        rusqlite::params![project_path, reason, now],
    )?;
    Ok(conn.last_insert_rowid())
}

// ── Database health ───────────────────────────────────────

pub fn get_db_health(db_path: &PathBuf) -> DbHealth {
    let exists = db_path.exists();
    let size_bytes = if exists {
        std::fs::metadata(db_path).map(|m| m.len()).unwrap_or(0)
    } else {
        0
    };

    let wal_path = db_path.with_extension("db-wal");
    let wal_size_bytes = if wal_path.exists() {
        std::fs::metadata(&wal_path).map(|m| m.len()).unwrap_or(0)
    } else {
        0
    };

    let mut table_counts = Vec::new();
    if exists {
        if let Ok(conn) = open_readonly(db_path) {
            let tables = [
                "memories",
                "compartments",
                "session_facts",
                "session_notes",
                "session_meta",
                "tags",
                "pending_ops",
                "dream_queue",
                "dream_state",
            ];
            for table in &tables {
                let count: i64 = conn
                    .query_row(&format!("SELECT COUNT(*) FROM {}", table), [], |r| r.get(0))
                    .unwrap_or(0);
                table_counts.push(TableCount {
                    table_name: table.to_string(),
                    row_count: count,
                });
            }
        }
    }

    DbHealth {
        exists,
        path: db_path.to_string_lossy().to_string(),
        size_bytes,
        wal_size_bytes,
        table_counts,
    }
}
