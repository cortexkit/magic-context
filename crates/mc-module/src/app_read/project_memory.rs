//! Project memory, mural, primer and workspace reads.

use std::time::Instant;

use rusqlite::{params, OptionalExtension};
use serde_json::{json, Map, Value};
use sha2::Digest;
use subc_client_rs::HandlerOutcome;

use super::admission::AppCaller;
use super::{
    allow, cut_text, decode_cursor, digest_of, encode_cursor, index_unavailable, invalid,
    list_reply, named, opt_i64, opt_str, page_limit, prepare, row_reply, AppReadContext, Page,
    RANKED_TTL_MS,
};

const OP: &str = "project_memory.read";

pub fn read(
    caller: &AppCaller,
    ctx: &AppReadContext,
    params: &Map<String, Value>,
) -> HandlerOutcome {
    let _ = caller;
    if let Err(refusal) = allow(
        params,
        &[
            "section",
            "project",
            "workspace_id",
            "filters",
            "query",
            "limit",
            "cursor",
            "offset",
        ],
        "params",
    ) {
        return refusal;
    }
    let section = match params.get("section").and_then(Value::as_str) {
        Some(section) if !section.is_empty() => section,
        _ => return invalid("params.section", "type"),
    };
    let keys: &[&str] = match section {
        "memories" => &[
            "section",
            "project",
            "workspace_id",
            "filters",
            "query",
            "limit",
            "cursor",
        ],
        "memory_stats" => &["section", "project", "workspace_id"],
        "mural" => &["section", "project"],
        "mural_image" => &["section", "project", "offset"],
        "primers" => &["section", "project", "filters", "limit", "cursor"],
        "primer_candidates" => &["section", "project", "limit", "cursor"],
        "user_memories" => &["section", "filters", "limit", "cursor"],
        "user_memory_candidates" | "workspaces" => &["section", "limit", "cursor"],
        _ => return invalid("params.section", "unknown"),
    };
    if let Err(refusal) = allow(params, keys, "params") {
        return refusal;
    }
    if let Err(refusal) = opt_str(params, "cursor", "params") {
        return refusal;
    }
    if let Some(project) = params.get("project") {
        match project.as_str() {
            Some(project) if is_project_identity(project) => {}
            Some(_) => return invalid("params.project", "range"),
            None => return invalid("params.project", "type"),
        }
    }
    if section == "primers" || section == "user_memories" {
        if let Some(filters) = params.get("filters") {
            let object = match super::envelope::object(filters, "params.filters") {
                Ok(object) => object,
                Err(refusal) => return refusal,
            };
            if let Err(refusal) = allow(object, &["status"], "params.filters") {
                return refusal;
            }
        }
    }
    match section {
        "memories" => memories(ctx, params),
        "memory_stats" => memory_stats(ctx, params),
        "mural" => mural(ctx, params),
        "mural_image" => mural_image(ctx, params),
        "primers" => primers(ctx, params),
        "primer_candidates" => primer_candidates(ctx, params),
        "workspaces" => workspaces(ctx, params),
        "user_memories" => user_memories(ctx, params),
        "user_memory_candidates" => user_memory_candidates(ctx, params),
        _ => invalid("params.section", "unknown"),
    }
}

struct Scope {
    projects: Vec<String>,
    digest_project: String,
}

// Distinct project paths are a small catalog, so one progress-budgeted covering-index walk is acceptable until an indexed identity-to-legacy-path alias catalog replaces it.
// Source 0 is memory, 1 is a run, and 2 is scheduler state; the tags avoid a second read to identify scheduled projects.
pub(super) const PROJECT_PATHS_SQL: &str = "SELECT project_path, 0 AS source FROM memories INDEXED BY idx_memories_project_status_category \
    UNION SELECT project_path, 1 AS source FROM dream_runs INDEXED BY idx_dream_runs_project \
    UNION SELECT project_path, 2 AS source FROM task_schedule_state ORDER BY project_path, source";

pub(super) fn project_paths<'a>(
    ctx: &'a AppReadContext<'_>,
) -> Result<&'a [(String, u8)], HandlerOutcome> {
    ctx.cached_project_paths(|| {
        let started = Instant::now();
        if ctx.expired(started) {
            return Err(named(
                "read_budget_exceeded",
                "The project-path catalog exceeded its time budget.",
            ));
        }
        ctx.context(|conn| {
            ctx.note_sql(PROJECT_PATHS_SQL);
            let mut statement = prepare(conn, PROJECT_PATHS_SQL)?;
            let mut rows = statement.query([])?;
            let mut paths = Vec::new();
            while let Some(row) = rows.next()? {
                if ctx.expired(started) {
                    return Err(rusqlite::Error::SqliteFailure(
                        rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_INTERRUPT),
                        None,
                    ));
                }
                paths.push((row.get(0)?, row.get(1)?));
            }
            Ok(paths)
        })
    })
}

pub(super) fn is_project_identity(value: &str) -> bool {
    value.starts_with("git:") || value.starts_with("dir:") || value.starts_with("pj-")
}

pub(super) fn normalize_project_path(raw: &str) -> String {
    if is_project_identity(raw) {
        raw.to_string()
    } else {
        crate::project_identity::directory_fallback(std::path::Path::new(raw))
    }
}

pub(super) fn equivalent_paths(
    ctx: &AppReadContext,
    project: &str,
) -> Result<Vec<String>, HandlerOutcome> {
    Ok(equivalent_paths_in(project_paths(ctx)?, project))
}

pub(super) fn equivalent_paths_in(catalog: &[(String, u8)], project: &str) -> Vec<String> {
    let identity = normalize_project_path(project);
    let mut paths: Vec<_> = catalog
        .iter()
        .filter(|(path, _)| normalize_project_path(path) == identity)
        .map(|(path, _)| path.clone())
        .collect();
    paths.dedup();
    if paths.is_empty() {
        paths.push(project.to_string());
    }
    paths
}

fn filters(params: &Map<String, Value>) -> Result<(Vec<String>, Vec<String>), HandlerOutcome> {
    let Some(value) = params.get("filters") else {
        return Ok((Vec::new(), Vec::new()));
    };
    let object = super::envelope::object(value, "params.filters")?;
    allow(object, &["status", "category"], "params.filters")?;
    let status = match object.get("status") {
        None => Vec::new(),
        Some(value) => super::string_array(value, "params.filters.status")?,
    };
    let category = match object.get("category") {
        None => Vec::new(),
        Some(value) => super::string_array(value, "params.filters.category")?,
    };
    Ok((status, category))
}

fn project_scope(
    ctx: &AppReadContext,
    params: &Map<String, Value>,
    require_one: bool,
) -> Result<Scope, HandlerOutcome> {
    let project = opt_str(params, "project", "params")?;
    let workspace = opt_i64(params, "workspace_id", "params")?;
    if require_one && project.is_some() == workspace.is_some() {
        return Err(invalid("params.project", "combination"));
    }
    if let Some(project) = project {
        if !is_project_identity(&project) {
            return Err(invalid("params.project", "range"));
        }
        let projects = equivalent_paths(ctx, &project)?;
        let exists = ctx.context(|conn| conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM project_state WHERE project_path IN (SELECT value FROM json_each(?1)) UNION ALL SELECT 1 FROM memories WHERE project_path IN (SELECT value FROM json_each(?1)))",
            [json!(projects).to_string()], |row| row.get::<_, bool>(0),
        ))?;
        if !exists && ctx.identity_root(&project).is_none() {
            return Err(named(
                "project_not_found",
                "No stored project has that identity.",
            ));
        }
        return Ok(Scope {
            projects,
            digest_project: project,
        });
    }
    if let Some(workspace) = workspace {
        let members = ctx.context(|conn| {
            let exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM workspaces WHERE id = ?1)",
                [workspace],
                |row| row.get(0),
            )?;
            if !exists {
                return Ok(None);
            }
            let mut statement = prepare(
                conn,
                "SELECT project_path FROM workspace_members WHERE workspace_id = ?1 ORDER BY project_path",
            )?;
            let rows = statement.query_map([workspace], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>().map(Some)
        })?;
        let Some(members) = members else {
            return Err(named("workspace_not_found", "No workspace has that id."));
        };
        let mut projects = Vec::new();
        for member in members {
            projects.extend(equivalent_paths(ctx, &member)?);
        }
        projects.sort();
        projects.dedup();
        return Ok(Scope {
            projects,
            digest_project: format!("workspace:{workspace}"),
        });
    }
    Err(invalid("params.project", "type"))
}

fn memories(ctx: &AppReadContext, params: &Map<String, Value>) -> HandlerOutcome {
    let (status, category) = match filters(params) {
        Ok(filters) => filters,
        Err(refusal) => return refusal,
    };
    let query = match opt_str(params, "query", "params") {
        Ok(query) => query
            .map(|query| query.trim().to_string())
            .filter(|query| !query.is_empty()),
        Err(refusal) => return refusal,
    };
    if query.is_none() && status.is_empty() && category.is_empty() {
        return index_unavailable("memories", "idx_memories_project_updated");
    }
    let scope = match project_scope(ctx, params, true) {
        Ok(scope) => scope,
        Err(refusal) => return refusal,
    };
    let limit = match page_limit(params, 100, 200, "params.limit") {
        Ok(limit) => limit,
        Err(refusal) => return refusal,
    };
    let digest = digest_of(&[
        ("project", &json!(scope.digest_project)),
        ("members", &json!(scope.projects)),
        ("status", &json!(status)),
        ("category", &json!(category)),
        ("query", &json!(query)),
    ]);
    let ranked = query.as_ref().is_some_and(|query| {
        query.chars().count() >= 3
            && query
                .strip_prefix('#')
                .and_then(|id| id.parse::<i64>().ok())
                .is_none()
    });
    let cursor = match decode_cursor(
        params.get("cursor").and_then(Value::as_str),
        OP,
        "memories",
        &digest,
        ctx.now_ms(),
        ranked.then_some(RANKED_TTL_MS),
    ) {
        Ok(cursor) => cursor,
        Err(refusal) => return refusal,
    };
    let started = Instant::now();
    let outcome = ctx.context(|conn| {
        let version = scope_version(conn, &scope.projects)?;
        if let Some(query) = query
            .as_deref()
            .filter(|query| query.starts_with('#') && query[1..].parse::<i64>().is_ok())
        {
            let id: i64 = query[1..].parse().unwrap_or(0);
            ctx.note_sql(MEMORY_BY_ID_SQL);
            if let Some(row) = conn
                .query_row(MEMORY_BY_ID_SQL, params![id], memory_row)
                .optional()?
            {
                if scope
                    .projects
                    .iter()
                    .any(|project| row["project_path"] == *project)
                    && (status.is_empty() || status.iter().any(|value| row["status"] == *value))
                    && (category.is_empty()
                        || category.iter().any(|value| row["category"] == *value))
                {
                    let mut page = Page::new(ctx.row_budget());
                    page.try_push(row);
                    return Ok((page, true, None, None, version));
                }
            }
        }
        let sql = if ranked {
            MEMORY_FTS_SQL
        } else {
            MEMORY_FILTER_SQL
        };
        ctx.note_sql(sql);
        let projects = json!(scope.projects).to_string();
        let statuses = json!(status).to_string();
        let categories = json!(category).to_string();
        let like = query.clone().unwrap_or_default();
        let like = if !ranked && query.is_some() {
            format!("%{}%", like.replace(['%', '_'], ""))
        } else {
            like
        };
        let offset = cursor
            .as_ref()
            .and_then(|cursor| cursor.keys.first())
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or(0);
        let (updated, id) = cursor
            .as_ref()
            .map(|cursor| {
                (
                    cursor
                        .keys
                        .first()
                        .and_then(|value| value.parse::<i64>().ok()),
                    cursor
                        .keys
                        .get(1)
                        .and_then(|value| value.parse::<i64>().ok()),
                )
            })
            .unwrap_or((None, None));
        let mut statement = prepare(conn, sql)?;
        let mut rows = if ranked {
            statement.query(params![
                projects,
                query.unwrap_or_default(),
                statuses,
                categories,
                offset
            ])?
        } else {
            statement.query(params![
                projects,
                statuses,
                categories,
                if query.is_some() { Some(like) } else { None },
                updated,
                id
            ])?
        };
        let mut page = Page::new(ctx.row_budget());
        let mut last = None;
        let mut hit = false;
        let mut seen = 0i64;
        while let Some(row) = super::next_row(&mut rows, &mut hit)? {
            if ctx.expired(started) {
                hit = true;
                break;
            }
            let value = memory_row(row)?;
            seen += 1;
            let keys = if ranked {
                vec![(offset + seen).to_string()]
            } else {
                vec![
                    value["updated_at_ms"].as_i64().unwrap_or(0).to_string(),
                    value["id"].as_i64().unwrap_or(0).to_string(),
                ]
            };
            if page.len() >= limit || !page.try_push(value) {
                hit = true;
                break;
            }
            last = Some(keys);
        }
        Ok((
            page,
            !hit,
            last,
            ranked.then_some(
                cursor
                    .as_ref()
                    .and_then(|cursor| cursor.issued_at_ms)
                    .unwrap_or(ctx.now_ms()),
            ),
            version,
        ))
    });
    match outcome {
        Ok((page, complete, last, issued, version)) => finish(
            ctx, "memories", version, page, complete, last, &digest, issued,
        ),
        Err(refusal) => refusal,
    }
}

fn memory_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let content: String = row.get(4)?;
    let (text, truncated, bytes) = cut_text(&content, 16 * 1024);
    let mut value = json!({
        "id": row.get::<_, i64>(0)?,
        "revision": row.get::<_, i64>(1)?,
        "project_path": row.get::<_, String>(2)?,
        "category": row.get::<_, String>(3)?,
        "content": text,
        "content_truncated": truncated,
        "content_bytes": bytes,
        "normalized_hash": row.get::<_, String>(5)?,
        "source_session_id": row.get::<_, Option<String>>(6)?,
        "source_type": row.get::<_, Option<String>>(7)?,
        "seen_count": row.get::<_, Option<i64>>(8)?,
        "retrieval_count": row.get::<_, Option<i64>>(9)?,
        "first_seen_at_ms": row.get::<_, i64>(10)?,
        "created_at_ms": row.get::<_, i64>(11)?,
        "updated_at_ms": row.get::<_, i64>(12)?,
        "last_seen_at_ms": row.get::<_, i64>(13)?,
        "last_retrieved_at_ms": row.get::<_, Option<i64>>(14)?,
        "status": row.get::<_, Option<String>>(15)?,
        "expires_at_ms": row.get::<_, Option<i64>>(16)?,
        "verification_status": row.get::<_, Option<String>>(17)?,
        "verified_at_ms": row.get::<_, Option<i64>>(18)?,
        "superseded_by_memory_id": row.get::<_, Option<i64>>(19)?,
        "merged_from": row.get::<_, Option<String>>(20)?,
        "metadata_json": row.get::<_, Option<String>>(21)?,
        "importance": row.get::<_, Option<i64>>(22)?,
        "scope": row.get::<_, String>(23)?,
        "shareable": row.get::<_, i64>(24)? != 0,
        "has_embedding": row.get::<_, i64>(25)? != 0,
        "source_display_name": Value::Null,
    });
    super::cap_field(&mut value, "metadata_json", 16 * 1024, true);
    Ok(value)
}

const MEMORY_FILTER_SQL: &str = "SELECT m.id, m.revision, m.project_path, m.category, m.content, m.normalized_hash, \
     m.source_session_id, m.source_type, m.seen_count, m.retrieval_count, m.first_seen_at, m.created_at, \
     m.updated_at, m.last_seen_at, m.last_retrieved_at, m.status, m.expires_at, m.verification_status, \
     m.verified_at, m.superseded_by_memory_id, m.merged_from, m.metadata_json, m.importance, m.scope, \
     m.shareable, EXISTS(SELECT 1 FROM memory_embeddings e WHERE e.memory_id = m.id) \
     FROM memories m INDEXED BY idx_memories_project_status_category \
      WHERE m.project_path IN (SELECT value FROM json_each(?1)) \
        AND (json_array_length(?2) = 0 OR m.status IN (SELECT value FROM json_each(?2))) \
        AND (json_array_length(?3) = 0 OR m.category IN (SELECT value FROM json_each(?3))) \
       AND (?4 IS NULL OR m.content LIKE ?4) \
       AND (?5 IS NULL OR m.updated_at < ?5 OR (m.updated_at = ?5 AND m.id < ?6)) \
     ORDER BY m.updated_at DESC, m.id DESC";

const MEMORY_FTS_SQL: &str = "SELECT m.id, m.revision, m.project_path, m.category, m.content, m.normalized_hash, \
     m.source_session_id, m.source_type, m.seen_count, m.retrieval_count, m.first_seen_at, m.created_at, \
     m.updated_at, m.last_seen_at, m.last_retrieved_at, m.status, m.expires_at, m.verification_status, \
     m.verified_at, m.superseded_by_memory_id, m.merged_from, m.metadata_json, m.importance, m.scope, \
     m.shareable, EXISTS(SELECT 1 FROM memory_embeddings e WHERE e.memory_id = m.id) \
     FROM memories_fts f JOIN memories m ON m.id = f.rowid \
      WHERE m.project_path IN (SELECT value FROM json_each(?1)) AND memories_fts MATCH ?2 \
        AND (json_array_length(?3) = 0 OR m.status IN (SELECT value FROM json_each(?3))) \
        AND (json_array_length(?4) = 0 OR m.category IN (SELECT value FROM json_each(?4))) \
      ORDER BY rank, m.id LIMIT -1 OFFSET ?5";

const MEMORY_BY_ID_SQL: &str = "SELECT m.id, m.revision, m.project_path, m.category, m.content, m.normalized_hash, \
     m.source_session_id, m.source_type, m.seen_count, m.retrieval_count, m.first_seen_at, m.created_at, \
     m.updated_at, m.last_seen_at, m.last_retrieved_at, m.status, m.expires_at, m.verification_status, \
     m.verified_at, m.superseded_by_memory_id, m.merged_from, m.metadata_json, m.importance, m.scope, \
     m.shareable, EXISTS(SELECT 1 FROM memory_embeddings e WHERE e.memory_id = m.id) \
     FROM memories m WHERE m.id = ?1";

fn memory_stats(ctx: &AppReadContext, params: &Map<String, Value>) -> HandlerOutcome {
    let scope = match project_scope(ctx, params, true) {
        Ok(scope) => scope,
        Err(refusal) => return refusal,
    };
    let project = json!(scope.projects).to_string();
    let started = Instant::now();
    if ctx.expired(started) {
        return named(
            "read_budget_exceeded",
            "The memory read exceeded its time budget.",
        );
    }
    let outcome = ctx.context(|conn| {
        ctx.note_sql(STATS_SQL);
        let mut statement = prepare(conn, STATS_SQL)?;
        let mut rows = statement.query([&project])?;
        let mut by_status = Map::new();
        let mut by_category = Map::new();
        while let Some(row) = rows.next()? {
            let status: String = row.get(0)?;
            let category: String = row.get(1)?;
            let count: i64 = row.get(2)?;
            let slot = by_status.entry(status.clone()).or_insert(json!(0));
            *slot = json!(slot.as_i64().unwrap_or(0) + count);
            if status != "archived" {
                let slot = by_category.entry(category).or_insert(json!(0));
                *slot = json!(slot.as_i64().unwrap_or(0) + count);
            }
        }
        ctx.note_sql(EMBEDDED_SQL);
        let embedded: i64 = conn.query_row(EMBEDDED_SQL, [&project], |row| row.get(0))?;
        let version = scope_version(conn, &scope.projects)?;
        Ok((by_status, by_category, embedded, version))
    });
    match outcome {
        Ok((by_status, by_category, embedded, version)) => row_reply(
            OP,
            Some("memory_stats"),
            ctx.now_ms(),
            version,
            json!({
                "by_status": by_status,
                "by_category": by_category,
                "embedded": embedded,
            }),
        ),
        Err(refusal) => refusal,
    }
}

const STATS_SQL: &str = "SELECT status, category, COUNT(*) FROM memories INDEXED BY idx_memories_project_status_category WHERE project_path IN (SELECT value FROM json_each(?1)) GROUP BY status, category";
const EMBEDDED_SQL: &str = "SELECT COUNT(*) FROM memories m INDEXED BY idx_memories_project_status_category WHERE m.project_path IN (SELECT value FROM json_each(?1)) AND EXISTS(SELECT 1 FROM memory_embeddings e WHERE e.memory_id = m.id)";

fn scope_version(
    conn: &rusqlite::Connection,
    projects: &[String],
) -> rusqlite::Result<Option<String>> {
    let counters = projects
        .iter()
        .map(|project| Ok(json!([project, version_for(conn, project)?])))
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Some(format!(
        "pm1:{}",
        digest_of(&[("projects", &json!(counters))])
    )))
}

fn version_for(conn: &rusqlite::Connection, project: &str) -> rusqlite::Result<Option<String>> {
    let state = conn
        .query_row(
            "SELECT project_memory_epoch, project_user_profile_version FROM project_state WHERE project_path = ?1",
            [project],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()?;
    let mutation = conn
        .query_row(
            "SELECT MAX(id) FROM memory_mutation_log WHERE project_path = ?1",
            [project],
            |row| row.get::<_, Option<i64>>(0),
        )
        .optional()?
        .flatten();
    let (epoch, profile) = state.unwrap_or((0, 0));
    Ok(Some(format!("{epoch}:{profile}:{}", mutation.unwrap_or(0))))
}

fn mural(ctx: &AppReadContext, params: &Map<String, Value>) -> HandlerOutcome {
    let project = match opt_str(params, "project", "params") {
        Ok(Some(project)) => project,
        Ok(None) => return invalid("params.project", "type"),
        Err(refusal) => return refusal,
    };
    let started = Instant::now();
    if ctx.expired(started) {
        return named(
            "read_budget_exceeded",
            "The memory read exceeded its time budget.",
        );
    }
    let outcome = ctx.context(|conn| {
        ctx.note_sql(MURAL_SQL);
        let found = conn
            .query_row(MURAL_SQL, [&project], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, i64>(7)?,
                ))
            })
            .optional()?;
        let Some((project_path, rendered, model, width, height, content_hash, ids, bytes)) = found
        else {
            return Ok(None);
        };
        let hash = hash_image(ctx, conn, &project)?;
        Ok(Some(json!({
            "project": project_path,
            "rendered_at_ms": rendered,
            "model": model,
            "width": width,
            "height": height,
            "content_hash": content_hash,
            "image_bytes": bytes,
            "image_sha256": hash,
            "memory_ids": serde_json::from_str::<Value>(&ids).unwrap_or(json!([])),
        })))
    });
    match outcome {
        Ok(Some(row)) => {
            let version = row
                .get("content_hash")
                .and_then(Value::as_str)
                .map(str::to_string);
            row_reply(OP, Some("mural"), ctx.now_ms(), version, row)
        }
        Ok(None) => named("mural_not_found", "No mural is stored for that project."),
        Err(refusal) => refusal,
    }
}

const MURAL_SQL: &str = "SELECT project_path, rendered_at, model, width, height, content_hash, memory_ids_json, length(image) FROM mural_manifest WHERE project_path = ?1";

fn mural_image(ctx: &AppReadContext, params: &Map<String, Value>) -> HandlerOutcome {
    let project = match opt_str(params, "project", "params") {
        Ok(Some(project)) => project,
        Ok(None) => return invalid("params.project", "type"),
        Err(refusal) => return refusal,
    };
    let offset = match opt_i64(params, "offset", "params") {
        Ok(Some(offset)) if offset >= 0 => offset as usize,
        Ok(Some(_)) => return invalid("params.offset", "range"),
        Ok(None) => 0,
        Err(refusal) => return refusal,
    };
    let started = Instant::now();
    if ctx.expired(started) {
        return named(
            "read_budget_exceeded",
            "The memory read exceeded its time budget.",
        );
    }
    let outcome = ctx.context(|conn| {
        ctx.note_sql("SELECT length(image), content_hash FROM mural_manifest WHERE project_path = ?1");
        let found = conn
            .query_row(
                "SELECT length(image), content_hash FROM mural_manifest WHERE project_path = ?1",
                [&project],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        let Some((total, content_hash)) = found else {
            return Ok(None);
        };
        let total = usize::try_from(total).unwrap_or(0);
        if offset > total {
            return Ok(Some(json!({"invalid_offset": true, "total_bytes": total})));
        }
        let start = offset;
        let end = (start + 300 * 1024).min(total);
        let rowid: i64 = conn.query_row("SELECT rowid FROM mural_manifest WHERE project_path = ?1", [&project], |row| row.get(0))?;
        let blob = conn.blob_open(rusqlite::DatabaseName::Main, "mural_manifest", "image", rowid, true)?;
        let bytes: Vec<u8> = if end > start {
            let mut chunk = vec![0u8; end - start];
            blob.read_at_exact(&mut chunk, start)?;
            chunk
        } else {
            Vec::new()
        };
        let hash = hash_image(ctx, conn, &project)?;
        Ok(Some(json!({
            "offset": start,
            "bytes_base64": base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes),
            "total_bytes": total,
            "image_sha256": hash,
            "content_hash": content_hash,
        })))
    });
    match outcome {
        Ok(Some(row)) if row["invalid_offset"] == true => super::envelope::invalid_field(
            "params.offset",
            "range",
            row["total_bytes"].as_u64().map(|value| value as usize),
        ),
        Ok(Some(row)) => row_reply(OP, Some("mural_image"), ctx.now_ms(), None, row),
        Ok(None) => named("mural_not_found", "No mural is stored for that project."),
        Err(refusal) => refusal,
    }
}

fn hash_image(
    ctx: &AppReadContext,
    conn: &rusqlite::Connection,
    project: &str,
) -> rusqlite::Result<String> {
    let started = Instant::now();
    let rowid: i64 = conn.query_row(
        "SELECT rowid FROM mural_manifest WHERE project_path = ?1",
        [project],
        |row| row.get(0),
    )?;
    let blob = conn.blob_open(
        rusqlite::DatabaseName::Main,
        "mural_manifest",
        "image",
        rowid,
        true,
    )?;
    let total = blob.len();
    let mut hasher = sha2::Sha256::new();
    let mut start = 0usize;
    while start < total {
        if ctx.expired(started) {
            return Err(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_INTERRUPT),
                None,
            ));
        }
        let mut chunk = vec![0u8; (total - start).min(8192)];
        blob.read_at_exact(&mut chunk, start)?;
        hasher.update(&chunk);
        start += chunk.len().max(1);
        if chunk.is_empty() {
            break;
        }
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn primers(ctx: &AppReadContext, params: &Map<String, Value>) -> HandlerOutcome {
    keyed_page(
        ctx,
        params,
        "primers",
        100,
        200,
        PRIMERS_SQL,
        "idx_primers_project_status_observed",
        true,
    )
}

fn primer_candidates(ctx: &AppReadContext, params: &Map<String, Value>) -> HandlerOutcome {
    keyed_page(
        ctx,
        params,
        "primer_candidates",
        100,
        200,
        CANDIDATES_SQL,
        "idx_primer_candidates_project_time",
        false,
    )
}

const PRIMERS_SQL: &str = "SELECT id, project_path, question, answer, status, total_support, last_observed_at, answer_refreshed_at, source_candidate_ids, created_at, updated_at FROM primers WHERE project_path = ?1 AND (json_array_length(?2) = 0 OR status IN (SELECT value FROM json_each(?2))) AND (?3 IS NULL OR status > ?3 OR (status = ?3 AND COALESCE(last_observed_at, 0) < ?4) OR (status = ?3 AND COALESCE(last_observed_at, 0) = ?4 AND id > ?5)) ORDER BY status ASC, last_observed_at DESC, id ASC";
const CANDIDATES_SQL: &str = "SELECT id, project_path, question, session_id, source_compartment_start, source_compartment_end, source_message_time, created_at FROM primer_candidates WHERE project_path = ?1 AND (?2 IS NULL OR source_message_time < ?2 OR (source_message_time = ?2 AND id < ?3)) ORDER BY source_message_time DESC, id DESC";

#[allow(clippy::too_many_arguments)]
fn keyed_page(
    ctx: &AppReadContext,
    params: &Map<String, Value>,
    section: &str,
    default_limit: usize,
    max_limit: usize,
    sql: &str,
    _index: &str,
    primer: bool,
) -> HandlerOutcome {
    let (status, _) = match filters(params) {
        Ok(filters) => filters,
        Err(refusal) => return refusal,
    };
    let project = match opt_str(params, "project", "params") {
        Ok(Some(project)) => project,
        Ok(None) => return invalid("params.project", "type"),
        Err(refusal) => return refusal,
    };
    let limit = match page_limit(params, default_limit, max_limit, "params.limit") {
        Ok(limit) => limit,
        Err(refusal) => return refusal,
    };
    let digest = digest_of(&[("project", &json!(project)), ("status", &json!(status))]);
    let cursor = match decode_cursor(
        params.get("cursor").and_then(Value::as_str),
        OP,
        section,
        &digest,
        ctx.now_ms(),
        None,
    ) {
        Ok(cursor) => cursor,
        Err(refusal) => return refusal,
    };
    let started = Instant::now();
    let outcome = ctx.context(|conn| {
        ctx.note_sql(sql);
        let mut statement = prepare(conn, sql)?;
        let statuses = json!(status).to_string();
        let mut rows = if primer {
            let key_status = cursor
                .as_ref()
                .and_then(|cursor| cursor.keys.first().cloned());
            let observed = cursor
                .as_ref()
                .and_then(|cursor| cursor.keys.get(1))
                .and_then(|value| value.parse::<i64>().ok());
            let id = cursor
                .as_ref()
                .and_then(|cursor| cursor.keys.get(2))
                .and_then(|value| value.parse::<i64>().ok());
            statement.query(params![project, statuses, key_status, observed, id])?
        } else {
            let time = cursor
                .as_ref()
                .and_then(|cursor| cursor.keys.first())
                .and_then(|value| value.parse::<i64>().ok());
            let id = cursor
                .as_ref()
                .and_then(|cursor| cursor.keys.get(1))
                .and_then(|value| value.parse::<i64>().ok());
            statement.query(params![project, time, id])?
        };
        let mut page = Page::new(ctx.row_budget());
        let mut last = None;
        let mut hit = false;
        while let Some(row) = super::next_row(&mut rows, &mut hit)? {
            if ctx.expired(started) {
                hit = true;
                break;
            }
            let value = if primer {
                primer_row(row)?
            } else {
                candidate_row(row)?
            };
            let keys = if primer {
                vec![
                    value["status"].as_str().unwrap_or("").to_string(),
                    value["last_observed_at_ms"]
                        .as_i64()
                        .unwrap_or(0)
                        .to_string(),
                    value["id"].as_i64().unwrap_or(0).to_string(),
                ]
            } else {
                vec![
                    value["source_message_time_ms"]
                        .as_i64()
                        .unwrap_or(0)
                        .to_string(),
                    value["id"].as_i64().unwrap_or(0).to_string(),
                ]
            };
            if page.len() >= limit || !page.try_push(value) {
                hit = true;
                break;
            }
            last = Some(keys);
        }
        Ok((page, !hit, last))
    });
    match outcome {
        Ok((page, complete, last)) => {
            finish(ctx, section, None, page, complete, last, &digest, None)
        }
        Err(refusal) => refusal,
    }
}

fn primer_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let mut value = json!({
        "id": row.get::<_, i64>(0)?,
        "project_path": row.get::<_, String>(1)?,
        "question": row.get::<_, String>(2)?,
        "answer": row.get::<_, String>(3)?,
        "status": row.get::<_, String>(4)?,
        "total_support": row.get::<_, i64>(5)?,
        "last_observed_at_ms": row.get::<_, Option<i64>>(6)?,
        "answer_refreshed_at_ms": row.get::<_, Option<i64>>(7)?,
        "source_candidate_ids": row.get::<_, String>(8)?,
        "created_at_ms": row.get::<_, i64>(9)?,
        "updated_at_ms": row.get::<_, i64>(10)?,
    });
    super::cap_field(&mut value, "question", 16 * 1024, false);
    super::cap_field(&mut value, "answer", 16 * 1024, false);
    Ok(value)
}

fn candidate_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let mut value = json!({
        "id": row.get::<_, i64>(0)?,
        "project_path": row.get::<_, String>(1)?,
        "question": row.get::<_, String>(2)?,
        "session_id": row.get::<_, String>(3)?,
        "source_compartment_start": row.get::<_, Option<i64>>(4)?,
        "source_compartment_end": row.get::<_, Option<i64>>(5)?,
        "source_message_time_ms": row.get::<_, i64>(6)?,
        "created_at_ms": row.get::<_, i64>(7)?,
    });
    super::cap_field(&mut value, "question", 16 * 1024, false);
    Ok(value)
}

fn workspaces(ctx: &AppReadContext, params: &Map<String, Value>) -> HandlerOutcome {
    if let Err(refusal) = allow(params, &["section", "limit", "cursor"], "params") {
        return refusal;
    }
    let limit = match page_limit(params, 50, 100, "params.limit") {
        Ok(limit) => limit,
        Err(refusal) => return refusal,
    };
    let digest = digest_of(&[]);
    let cursor = match decode_cursor(
        params.get("cursor").and_then(Value::as_str),
        OP,
        "workspaces",
        &digest,
        ctx.now_ms(),
        None,
    ) {
        Ok(cursor) => cursor,
        Err(refusal) => return refusal,
    };
    let after = cursor.and_then(|cursor| cursor.keys.into_iter().next());
    let started = Instant::now();
    let outcome = ctx.context(|conn| {
        ctx.note_sql(WORKSPACES_SQL);
        let mut statement = prepare(conn, WORKSPACES_SQL)?;
        let mut rows = statement.query(params![after])?;
        let mut page = Page::new(ctx.row_budget());
        let mut last = None;
        let mut hit = false;
        while let Some(row) = super::next_row(&mut rows, &mut hit)? {
            if ctx.expired(started) {
                hit = true;
                break;
            }
            let id: i64 = row.get(0)?;
            let name: String = row.get(1)?;
            ctx.note_sql(MEMBERS_SQL);
            let mut members_stmt = prepare(conn, MEMBERS_SQL)?;
            let members = members_stmt.query_map([id], |member| {
                let project: String = member.get(0)?;
                ctx.note_sql(MEMBER_COUNT_SQL);
                let count: i64 = conn.query_row(MEMBER_COUNT_SQL, [&project], |row| row.get(0))?;
                Ok(json!({
                    "project_path": project,
                    "display_name": member.get::<_, String>(1)?,
                    "display_path": member.get::<_, String>(2)?,
                    "added_at_ms": member.get::<_, i64>(3)?,
                    "memory_count": count,
                }))
            })?;
            let members = members.collect::<Result<Vec<_>, _>>()?;
            let value = json!({
                "id": id,
                "name": name,
                "created_at_ms": row.get::<_, i64>(2)?,
                "updated_at_ms": row.get::<_, i64>(3)?,
                "share_categories": serde_json::from_str::<Value>(&row.get::<_, String>(4)?).unwrap_or(json!([])),
                "members": members,
            });
            if page.len() >= limit || !page.try_push(value) {
                hit = true;
                break;
            }
            last = Some(vec![name]);
        }
        Ok((page, !hit, last))
    });
    match outcome {
        Ok((page, complete, last)) => {
            finish(ctx, "workspaces", None, page, complete, last, &digest, None)
        }
        Err(refusal) => refusal,
    }
}

const WORKSPACES_SQL: &str = "SELECT id, name, created_at, updated_at, share_categories FROM workspaces WHERE (?1 IS NULL OR name > ?1) ORDER BY name ASC";
const MEMBERS_SQL: &str = "SELECT project_path, display_name, display_path, added_at FROM workspace_members WHERE workspace_id = ?1 ORDER BY display_name";
const MEMBER_COUNT_SQL: &str =
    "SELECT COUNT(*) FROM memories WHERE project_path = ?1 AND status IN ('active', 'permanent')";

fn user_memories(ctx: &AppReadContext, params: &Map<String, Value>) -> HandlerOutcome {
    let (status, _) = match filters(params) {
        Ok(filters) => filters,
        Err(refusal) => return refusal,
    };
    let limit = match page_limit(params, 100, 200, "params.limit") {
        Ok(limit) => limit,
        Err(refusal) => return refusal,
    };
    let digest = digest_of(&[("status", &json!(status))]);
    let cursor = match decode_cursor(
        params.get("cursor").and_then(Value::as_str),
        OP,
        "user_memories",
        &digest,
        ctx.now_ms(),
        None,
    ) {
        Ok(cursor) => cursor,
        Err(refusal) => return refusal,
    };
    let created = cursor
        .as_ref()
        .and_then(|cursor| cursor.keys.first())
        .and_then(|value| value.parse::<i64>().ok());
    let id = cursor
        .as_ref()
        .and_then(|cursor| cursor.keys.get(1))
        .and_then(|value| value.parse::<i64>().ok());
    let statuses = json!(status).to_string();
    let started = Instant::now();
    let outcome = ctx.context(|conn| {
        ctx.note_sql(USER_MEMORIES_SQL);
        let mut statement = prepare(conn, USER_MEMORIES_SQL)?;
        let mut rows = statement.query(params![statuses, created, id])?;
        let mut page = Page::new(ctx.row_budget());
        let mut last = None;
        let mut hit = false;
        while let Some(row) = super::next_row(&mut rows, &mut hit)? {
            if ctx.expired(started) {
                hit = true;
                break;
            }
            let memory_id: i64 = row.get(0)?;
            let content: String = row.get(1)?;
            let created_at: i64 = row.get(5)?;
            let (text, truncated, bytes) = cut_text(&content, 16 * 1024);
            let value = json!({
                "id": memory_id,
                "content": text,
                "content_truncated": truncated,
                "content_bytes": bytes,
                "status": row.get::<_, String>(2)?,
                "promoted_at_ms": row.get::<_, i64>(3)?,
                "source_candidate_ids": row.get::<_, Option<String>>(4)?,
                "created_at_ms": created_at,
                "updated_at_ms": row.get::<_, i64>(6)?,
            });
            if page.len() >= limit || !page.try_push(value) {
                hit = true;
                break;
            }
            last = Some(vec![created_at.to_string(), memory_id.to_string()]);
        }
        Ok((page, !hit, last))
    });
    match outcome {
        Ok((page, complete, last)) => finish(
            ctx,
            "user_memories",
            None,
            page,
            complete,
            last,
            &digest,
            None,
        ),
        Err(refusal) => refusal,
    }
}

// User memories are a curated profile list, so a progress-budgeted full sort is acceptable until idx_um_created(created_at DESC, id DESC) is available.
const USER_MEMORIES_SQL: &str = "SELECT id, content, status, promoted_at, source_candidate_ids, created_at, updated_at FROM user_memories INDEXED BY idx_um_status WHERE (json_array_length(?1) = 0 OR status IN (SELECT value FROM json_each(?1))) AND (?2 IS NULL OR created_at < ?2 OR (created_at = ?2 AND id < ?3)) ORDER BY created_at DESC, id DESC";

fn user_memory_candidates(ctx: &AppReadContext, params: &Map<String, Value>) -> HandlerOutcome {
    let limit = match page_limit(params, 100, 200, "params.limit") {
        Ok(limit) => limit,
        Err(refusal) => return refusal,
    };
    let digest = digest_of(&[]);
    let cursor = match decode_cursor(
        params.get("cursor").and_then(Value::as_str),
        OP,
        "user_memory_candidates",
        &digest,
        ctx.now_ms(),
        None,
    ) {
        Ok(cursor) => cursor,
        Err(refusal) => return refusal,
    };
    let created = cursor
        .as_ref()
        .and_then(|cursor| cursor.keys.first())
        .and_then(|value| value.parse::<i64>().ok());
    let id = cursor
        .as_ref()
        .and_then(|cursor| cursor.keys.get(1))
        .and_then(|value| value.parse::<i64>().ok());
    let started = Instant::now();
    let outcome = ctx.context(|conn| {
        ctx.note_sql(USER_CANDIDATES_SQL);
        let mut statement = prepare(conn, USER_CANDIDATES_SQL)?;
        let mut rows = statement.query(params![created, id])?;
        let mut page = Page::new(ctx.row_budget());
        let mut last = None;
        let mut hit = false;
        while let Some(row) = super::next_row(&mut rows, &mut hit)? {
            if ctx.expired(started) {
                hit = true;
                break;
            }
            let candidate_id: i64 = row.get(0)?;
            let created_at: i64 = row.get(4)?;
            let content: String = row.get(1)?;
            let (text, truncated, bytes) = cut_text(&content, 16 * 1024);
            let value = json!({
                "id": candidate_id,
                "content": text,
                "content_truncated": truncated,
                "content_bytes": bytes,
                "session_id": row.get::<_, String>(2)?,
                "source_compartment_start": row.get::<_, Option<i64>>(3)?,
                "source_compartment_end": row.get::<_, Option<i64>>(5)?,
                "created_at_ms": created_at,
            });
            if page.len() >= limit || !page.try_push(value) {
                hit = true;
                break;
            }
            last = Some(vec![created_at.to_string(), candidate_id.to_string()]);
        }
        Ok((page, !hit, last))
    });
    match outcome {
        Ok((page, complete, last)) => finish(
            ctx,
            "user_memory_candidates",
            None,
            page,
            complete,
            last,
            &digest,
            None,
        ),
        Err(refusal) => refusal,
    }
}

const USER_CANDIDATES_SQL: &str = "SELECT id, content, session_id, source_compartment_start, created_at, source_compartment_end FROM user_memory_candidates WHERE (?1 IS NULL OR created_at < ?1 OR (created_at = ?1 AND id < ?2)) ORDER BY created_at DESC, id DESC";

#[allow(clippy::too_many_arguments)]
fn finish(
    ctx: &AppReadContext,
    section: &str,
    version: Option<String>,
    page: Page,
    complete: bool,
    last: Option<Vec<String>>,
    digest: &str,
    issued: Option<i64>,
) -> HandlerOutcome {
    if !complete && page.len() == 0 {
        return named(
            "read_budget_exceeded",
            "The memory read exceeded its time budget before a row was available.",
        );
    }
    let next = if complete {
        None
    } else if let Some(keys) = last {
        match encode_cursor(OP, section, digest, &keys, issued) {
            Ok(cursor) => Some(cursor),
            Err(refusal) => return refusal,
        }
    } else {
        None
    };
    list_reply(
        OP,
        section,
        ctx.now_ms(),
        version,
        complete,
        page.rows(),
        next,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_read::tests_support::{apply_sql, explain, open_store, response};
    use std::sync::{Arc, Mutex};

    fn ready(dir: &std::path::Path) -> (AppReadContext<'static>, std::path::PathBuf) {
        let store = open_store(dir);
        let mut ctx = AppReadContext::for_test(store, 1_700_000_000_000);
        ctx.set_sql_log(Arc::new(Mutex::new(Vec::new())));
        (ctx, dir.join("context.db"))
    }

    fn caller() -> AppCaller {
        crate::app_read::tests_support::caller()
    }

    #[test]
    fn legacy_project_paths_match_dashboard_lexical_identity_cases() {
        let cases: Value = serde_json::from_str(include_str!(
            "../../testdata/app-read-g/legacy-project-paths.json"
        ))
        .unwrap();
        for case in cases.as_array().unwrap() {
            assert_eq!(
                normalize_project_path(case["input"].as_str().unwrap()),
                case["identity"]
            );
        }
        assert_ne!(
            normalize_project_path("/private/var/project"),
            normalize_project_path("/var/project")
        );
        assert_eq!(
            normalize_project_path("/private/var/project/"),
            normalize_project_path("/private/var/project")
        );
        let absolute = std::env::current_dir().unwrap().join("relative/project");
        let expected = format!(
            "dir:{}",
            &mc_store::md5_hex(&absolute.to_string_lossy())[..12]
        );
        assert_eq!(normalize_project_path("relative/project"), expected);
    }

    #[test]
    fn legacy_normalizer_and_its_dependencies_do_not_probe_files_or_write_sidecars() {
        fn body(source: &str, name: &str) -> syn::Block {
            syn::parse_file(source)
                .unwrap()
                .items
                .into_iter()
                .find_map(|item| match item {
                    syn::Item::Fn(item) if item.sig.ident == name => Some(*item.block),
                    _ => None,
                })
                .unwrap()
        }
        fn same(actual: syn::Block, expected: syn::Block) {
            let normalize = |tokens: String| tokens.replace("} ,", "}");
            assert_eq!(
                normalize(quote::quote!(#actual).to_string()),
                normalize(quote::quote!(#expected).to_string())
            );
        }
        same(
            body(include_str!("project_memory.rs"), "normalize_project_path"),
            syn::parse_quote!({
                if is_project_identity(raw) {
                    raw.to_string()
                } else {
                    crate::project_identity::directory_fallback(std::path::Path::new(raw))
                }
            }),
        );
        same(
            body(include_str!("project_memory.rs"), "is_project_identity"),
            syn::parse_quote!({
                value.starts_with("git:") || value.starts_with("dir:") || value.starts_with("pj-")
            }),
        );
        same(
            body(include_str!("../project_identity.rs"), "directory_fallback"),
            syn::parse_quote!({
                let canonical = node_path_resolve(directory);
                let hash = mc_store::md5_hex(&canonical.to_string_lossy());
                format!("dir:{}", &hash[..12])
            }),
        );
        same(
            body(include_str!("../project_identity.rs"), "node_path_resolve"),
            syn::parse_quote!({
                let absolute = if directory.is_absolute() {
                    directory.to_path_buf()
                } else {
                    std::env::current_dir()
                        .unwrap_or_else(|_| PathBuf::from("/"))
                        .join(directory)
                };
                let mut resolved = PathBuf::new();
                for component in absolute.components() {
                    match component {
                        Component::Prefix(prefix) => resolved.push(prefix.as_os_str()),
                        Component::RootDir => resolved.push(Component::RootDir.as_os_str()),
                        Component::CurDir => {}
                        Component::ParentDir => {
                            resolved.pop();
                        }
                        Component::Normal(part) => resolved.push(part),
                    }
                }
                if resolved.as_os_str().is_empty() {
                    resolved.push("/");
                }
                resolved
            }),
        );
        same(
            body(include_str!("../../../mc-store/src/lib.rs"), "md5_hex"),
            syn::parse_quote!({ format!("{:032x}", md5::compute(input.as_bytes())) }),
        );
    }

    #[test]
    fn legacy_alias_catalog_is_covering_cached_and_shared_with_dreamer_reconstruction() {
        let dir = tempfile::tempdir().unwrap();
        let (mut ctx, db) = ready(dir.path());
        let log = Arc::new(Mutex::new(Vec::new()));
        ctx.set_sql_log(log.clone());
        apply_sql(&db, "INSERT INTO memories(project_path,category,content,normalized_hash,first_seen_at,created_at,updated_at,last_seen_at,status) VALUES ('/work/api/','CONSTRAINTS','trailing alias','a',1,1,2,1,'active'),('/work/x/../api','CONSTRAINTS','parent alias','b',1,1,3,1,'active'); INSERT INTO dream_runs(project_path,started_at,finished_at,holder_id,tasks_json) VALUES ('/work/./api',1,10,'h','[]'); INSERT INTO task_schedule_state(project_path,task,schedule) VALUES ('/work/./api/','verify','0 3 * * *');");
        let params = json!({"section":"memories","project":"dir:e02ef1f35c06","filters":{"status":["active"]}});
        let reply = response(&read(&caller(), &ctx, params.as_object().unwrap()));
        assert_eq!(reply["rows"].as_array().unwrap().len(), 2);
        let paths = equivalent_paths(&ctx, "dir:e02ef1f35c06").unwrap();
        assert!(paths.contains(&"/work/./api".to_string()));
        assert!(paths.contains(&"/work/./api/".to_string()));
        let runs = response(&super::super::dreamer::read(
            &caller(),
            &ctx,
            json!({"section":"runs","project":"dir:e02ef1f35c06"})
                .as_object()
                .unwrap(),
        ));
        assert_eq!(runs["rows"].as_array().unwrap().len(), 1);
        let projects = response(&super::super::dreamer::read(
            &caller(),
            &ctx,
            json!({"section":"projects"}).as_object().unwrap(),
        ));
        assert_eq!(projects["rows"].as_array().unwrap().len(), 1);
        assert_eq!(projects["rows"][0]["project"], "dir:e02ef1f35c06");
        let changes = response(&super::super::dreamer::read(
            &caller(),
            &ctx,
            json!({"section":"run_changes","run_id":"1"})
                .as_object()
                .unwrap(),
        ));
        assert_eq!(changes["reconstructed"], true);
        assert_eq!(changes["rows"].as_array().unwrap().len(), 2);
        assert_eq!(
            log.lock()
                .unwrap()
                .iter()
                .filter(|sql| sql.as_str() == PROJECT_PATHS_SQL)
                .count(),
            1
        );
        let plan = explain(&db, PROJECT_PATHS_SQL);
        for table in ["memories", "dream_runs", "task_schedule_state"] {
            assert!(
                plan.lines()
                    .any(|line| line.contains(&format!("SCAN {table} "))
                        && line.contains("USING COVERING INDEX")),
                "{plan}"
            );
        }
        assert!(
            plan.contains("idx_memories_project_status_category"),
            "{plan}"
        );
        assert!(plan.contains("idx_dream_runs_project"), "{plan}");
    }

    #[test]
    fn interrupted_project_catalog_is_refused_without_caching_partial_aliases() {
        let dir = tempfile::tempdir().unwrap();
        let (mut ctx, db) = ready(dir.path());
        apply_sql(
            &db,
            include_str!("../../testdata/app-read-g/project-catalog.sql")
                .replace("__MEMORY_COUNT__", "3000")
                .as_str(),
        );
        ctx.set_budget(std::time::Duration::ZERO);
        assert!(
            matches!(project_paths(&ctx),Err(HandlerOutcome::Error {code,..}) if code=="read_budget_exceeded")
        );
        assert!(ctx.project_paths.get().is_none());
        let next = AppReadContext::for_test(Arc::clone(ctx.store.as_ref().unwrap()), 1);
        let complete = project_paths(&next).unwrap();
        assert_eq!(complete.len(), 60);
        assert_eq!(
            complete.first().unwrap(),
            &("/fixture/catalog/project-00".to_string(), 0)
        );
        assert_eq!(
            complete.last().unwrap(),
            &("/fixture/catalog/project-59".to_string(), 0)
        );
    }

    #[test]
    // This timing benchmark claims an idle-machine budget and must run alone, not under full-suite contention.
    #[ignore = "isolated project-catalog timing benchmark"]
    fn project_catalog_reports_latency_at_thirty_and_three_hundred_thousand_memories() {
        for count in [30_000, 300_000] {
            let dir = tempfile::tempdir().unwrap();
            let store = open_store(dir.path());
            let db = dir.path().join("context.db");
            apply_sql(
                &db,
                &include_str!("../../testdata/app-read-g/project-catalog.sql")
                    .replace("__MEMORY_COUNT__", &count.to_string()),
            );
            apply_sql(&db,"WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<5000) INSERT INTO dream_runs(project_path,started_at,finished_at,holder_id,tasks_json) SELECT printf('/fixture/catalog/project-%02d',x%60),x,x+1,'h','[]' FROM n; WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<719) INSERT INTO task_schedule_state(project_path,task) SELECT printf('/fixture/catalog/project-%02d',x/12),'task-'||(x%12) FROM n;");
            let mut times = Vec::new();
            for _ in 0..10 {
                let ctx = AppReadContext::for_test(Arc::clone(&store), 1);
                let started = Instant::now();
                let paths = project_paths(&ctx).unwrap();
                let elapsed = started.elapsed();
                assert_eq!(paths.len(), 180);
                assert!(
                    elapsed < std::time::Duration::from_millis(250),
                    "{count}: {elapsed:?}"
                );
                times.push(elapsed.as_micros());
            }
            times.sort();
            println!("PROJECT_CATALOG_LATENCY memories={count} distinct_paths=60 runs=5000 schedule_rows=720 samples=10 p50_us={} p90_us={}",times[4],times[8]);
        }
    }

    #[test]
    fn unknown_filter_is_refused_by_dotted_name() {
        let dir = tempfile::tempdir().unwrap();
        let (ctx, _) = ready(dir.path());
        let params = json!({"section": "memories", "project": "git:abc", "filters": {"statuss": ["active"]}});
        let outcome = read(&caller(), &ctx, params.as_object().unwrap());
        assert_eq!(
            crate::app_read::tests_support::detail_field(&outcome),
            json!({"field": "params.filters.statuss", "reason": "unknown"})
        );
    }

    #[test]
    fn unfiltered_memory_order_is_refused_until_its_index_exists() {
        let dir = tempfile::tempdir().unwrap();
        let (ctx, _) = ready(dir.path());
        let params = json!({"section": "memories", "project": "git:abc"});
        match read(&caller(), &ctx, params.as_object().unwrap()) {
            HandlerOutcome::ErrorWithDetail { code, detail, .. } => {
                assert_eq!(code, "app_op_unavailable");
                assert_eq!(detail["index"], "idx_memories_project_updated");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn filtered_memories_use_the_status_index_and_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let (ctx, db) = ready(dir.path());
        apply_sql(
            &db,
            "INSERT INTO memories(project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at, status)
             VALUES ('git:abc', 'CONSTRAINTS', 'one', 'h1', 1, 1, 30, 1, 'active'),
                    ('git:abc', 'CONSTRAINTS', 'two', 'h2', 1, 1, 20, 1, 'active'),
                    ('git:abc', 'CONSTRAINTS', 'old', 'h3', 1, 1, 10, 1, 'archived');",
        );
        let params = json!({"section": "memories", "project": "git:abc", "filters": {"status": ["active"]}, "limit": 1});
        let first = response(&read(&caller(), &ctx, params.as_object().unwrap()));
        assert_eq!(first["rows"][0]["content"], "one");
        assert_eq!(first["complete"], false);
        let mut next = params.clone();
        next["cursor"] = first["next_cursor"].clone();
        let second = response(&read(&caller(), &ctx, next.as_object().unwrap()));
        assert_eq!(second["rows"][0]["content"], "two");
        let plan = explain(&db, MEMORY_FILTER_SQL);
        assert!(
            plan.contains("idx_memories_project_status_category"),
            "{plan}"
        );
        assert!(plan.contains("SEARCH"), "{plan}");
    }

    #[test]
    fn user_memories_page_and_use_their_status_index() {
        let dir = tempfile::tempdir().unwrap();
        let (ctx, db) = ready(dir.path());
        apply_sql(
            &db,
            "INSERT INTO user_memories(content, status, promoted_at, created_at, updated_at)
             VALUES ('a', 'active', 1, 30, 30), ('b', 'active', 1, 20, 20), ('c', 'archived', 1, 40, 40);",
        );
        let params =
            json!({"section": "user_memories", "filters": {"status": ["active"]}, "limit": 1});
        let first = response(&read(&caller(), &ctx, params.as_object().unwrap()));
        assert_eq!(first["rows"][0]["content"], "a");
        let mut next = params.clone();
        next["cursor"] = first["next_cursor"].clone();
        let second = response(&read(&caller(), &ctx, next.as_object().unwrap()));
        assert_eq!(second["rows"][0]["content"], "b");
        let plan = explain(&db, USER_MEMORIES_SQL);
        assert!(plan.contains("idx_um_status"), "{plan}");
    }

    #[test]
    fn memory_filters_include_every_value_and_every_workspace_member() {
        let dir = tempfile::tempdir().unwrap();
        let (ctx, db) = ready(dir.path());
        apply_sql(&db, include_str!("../../testdata/app-read-g/lists.sql"));
        apply_sql(&db, "INSERT INTO memories(project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at, status) VALUES ('git:b','OTHER','needle second project','b',1,1,8,1,'permanent'), ('git:a','OTHER','needle excluded','c',1,1,9,1,'archived');");
        let params = json!({"section":"memories", "workspace_id":1, "filters":{"status":["active","permanent"], "category":["CONSTRAINTS","OTHER"]}});
        let reply = response(&read(&caller(), &ctx, params.as_object().unwrap()));
        assert_eq!(reply["rows"].as_array().unwrap().len(), 5);
        assert_eq!(reply["rows"][0]["project_path"], "git:b");
        let mut fts = params.clone();
        fts["query"] = json!("needle");
        let reply = response(&read(&caller(), &ctx, fts.as_object().unwrap()));
        assert_eq!(reply["rows"].as_array().unwrap().len(), 5);
        assert!(reply["rows"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["status"] != "archived"));
        let stats = response(&read(
            &caller(),
            &ctx,
            json!({"section":"memory_stats","workspace_id":1})
                .as_object()
                .unwrap(),
        ));
        assert_eq!(stats["row"]["by_status"]["active"], 4);
        assert_eq!(stats["row"]["by_status"]["permanent"], 1);
        assert_eq!(stats["row"]["by_category"]["OTHER"], 1);
        assert!(stats["version"].as_str().unwrap().starts_with("pm1:"));
    }

    #[test]
    fn oversized_memory_metadata_is_null_not_invalid_partial_json() {
        let dir = tempfile::tempdir().unwrap();
        let (ctx, db) = ready(dir.path());
        apply_sql(&db, include_str!("../../testdata/app-read-g/lists.sql"));
        let metadata = format!("{{\"note\":\"{}\"}}", "😀".repeat(5000));
        apply_sql(
            &db,
            &format!("UPDATE memories SET metadata_json = '{metadata}' WHERE id=1;"),
        );
        let reply = response(&read(
            &caller(),
            &ctx,
            json!({"section":"memories","project":"git:a","query":"#1"})
                .as_object()
                .unwrap(),
        ));
        let row = &reply["rows"][0];
        assert!(row["metadata_json"].is_null());
        assert_eq!(row["metadata_json_truncated"], true);
        assert_eq!(row["metadata_json_bytes"], metadata.len());
    }

    #[test]
    fn every_memory_list_stops_under_budget_and_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let (mut ctx, db) = ready(dir.path());
        apply_sql(&db, include_str!("../../testdata/app-read-g/lists.sql"));
        for (section, query, budget) in [
            ("memories", None, 12000),
            ("memories", Some("needle"), 12000),
            ("primers", None, 12000),
            ("primer_candidates", None, 350),
            ("workspaces", None, 600),
            ("user_memories", None, 12000),
            ("user_memory_candidates", None, 12000),
        ] {
            ctx.set_row_budget(budget);
            let mut params = json!({"section":section});
            if matches!(section, "memories" | "primers" | "primer_candidates") {
                params["project"] = json!("git:a");
            }
            if section == "memories" {
                params["filters"] = json!({"status":["active"]});
            }
            if let Some(query) = query {
                params["query"] = json!(query);
            }
            let mut found = Vec::new();
            for attempt in 0..8 {
                let reply = response(&read(&caller(), &ctx, params.as_object().unwrap()));
                let rows = reply["rows"].as_array().unwrap();
                assert!(!rows.is_empty(), "{section}: {reply}");
                assert!(
                    serde_json::to_vec(rows).unwrap().len() <= budget,
                    "{section}"
                );
                found.extend(rows.iter().map(|row| row["id"].as_i64().unwrap()));
                if attempt == 0 {
                    assert_eq!(reply["complete"], false, "{section}");
                }
                if reply["complete"] == true {
                    break;
                }
                params["cursor"] = reply["next_cursor"].clone();
                assert!(params["cursor"].is_string(), "{section}");
            }
            found.sort();
            assert_eq!(found, vec![1, 2, 3, 4], "{section}/{query:?}");
        }
        for (sql, index) in [
            (PRIMERS_SQL, "idx_primers_project_status_observed"),
            (CANDIDATES_SQL, "idx_primer_candidates_project_time"),
            (WORKSPACES_SQL, "sqlite_autoindex_workspaces"),
            (MEMBERS_SQL, "idx_workspace_member_name"),
            (MEMBER_COUNT_SQL, "idx_memories_project_status"),
            (USER_MEMORIES_SQL, "idx_um_status"),
            (USER_CANDIDATES_SQL, "idx_umc_created"),
            (STATS_SQL, "idx_memories_project_status_category"),
            (EMBEDDED_SQL, "idx_memories_project_status_category"),
            (MURAL_SQL, "sqlite_autoindex_mural_manifest"),
            (MEMORY_BY_ID_SQL, "INTEGER PRIMARY KEY"),
            (MEMORY_FTS_SQL, "VIRTUAL TABLE INDEX"),
        ] {
            let plan = explain(&db, sql);
            assert!(plan.contains(index), "{sql}: {plan}");
        }
    }

    #[test]
    fn ranked_cursor_is_bound_to_filters_and_expires_from_the_first_page() {
        let dir = tempfile::tempdir().unwrap();
        let (mut ctx, db) = ready(dir.path());
        apply_sql(&db, include_str!("../../testdata/app-read-g/lists.sql"));
        let mut params = json!({"section":"memories","project":"git:a","query":"needle","limit":1});
        let first = response(&read(&caller(), &ctx, params.as_object().unwrap()));
        params["cursor"] = first["next_cursor"].clone();
        params["filters"] = json!({"status":["archived"]});
        assert!(
            matches!(read(&caller(),&ctx,params.as_object().unwrap()),HandlerOutcome::Error {code,..} if code=="cursor_mismatch")
        );
        params.as_object_mut().unwrap().remove("filters");
        ctx.now_ms += RANKED_TTL_MS + 1;
        assert!(
            matches!(read(&caller(),&ctx,params.as_object().unwrap()),HandlerOutcome::ErrorWithDetail {code,..} if code=="cursor_expired")
        );
    }

    #[test]
    fn mural_chunks_reassemble_exactly_and_refuse_an_out_of_range_offset() {
        let dir = tempfile::tempdir().unwrap();
        let (ctx, db) = ready(dir.path());
        let image: Vec<u8> = (0..700_000).map(|n| (n % 251) as u8).collect();
        let hex: String = image.iter().map(|byte| format!("{byte:02x}")).collect();
        apply_sql(&db,&format!("INSERT INTO mural_manifest(project_path,image,content_hash,rendered_at) VALUES ('git:a',x'{hex}','hash',1);"));
        let manifest = response(&read(
            &caller(),
            &ctx,
            json!({"section":"mural","project":"git:a"})
                .as_object()
                .unwrap(),
        ));
        assert_eq!(manifest["row"]["image_bytes"], image.len());
        let mut actual = Vec::new();
        while actual.len() < image.len() {
            let reply = response(&read(
                &caller(),
                &ctx,
                json!({"section":"mural_image","project":"git:a","offset":actual.len()})
                    .as_object()
                    .unwrap(),
            ));
            let bytes = base64::Engine::decode(
                &base64::engine::general_purpose::STANDARD,
                reply["row"]["bytes_base64"].as_str().unwrap(),
            )
            .unwrap();
            assert_eq!(bytes.len(), (image.len() - actual.len()).min(300 * 1024));
            assert!(reply.to_string().len() < super::super::envelope::REPLY_LIMIT);
            assert_eq!(
                reply["row"]["image_sha256"],
                manifest["row"]["image_sha256"]
            );
            actual.extend(bytes);
        }
        assert_eq!(actual, image);
        let outcome = read(
            &caller(),
            &ctx,
            json!({"section":"mural_image","project":"git:a","offset":700001})
                .as_object()
                .unwrap(),
        );
        assert_eq!(
            crate::app_read::tests_support::detail_field(&outcome)["field"],
            "params.offset"
        );
    }

    #[test]
    fn curated_user_profile_sort_handles_five_thousand_rows_within_budget() {
        let dir = tempfile::tempdir().unwrap();
        let (ctx, db) = ready(dir.path());
        apply_sql(&db,"WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<5000) INSERT INTO user_memories(content,promoted_at,created_at,updated_at) SELECT 'curated profile item',x,x,x FROM n;");
        let started = Instant::now();
        let reply = response(&read(
            &caller(),
            &ctx,
            json!({"section":"user_memories","limit":200})
                .as_object()
                .unwrap(),
        ));
        let elapsed = started.elapsed();
        println!(
            "USER_PROFILE_5000 elapsed_us={} budget_us=250000",
            elapsed.as_micros()
        );
        assert!(
            elapsed < std::time::Duration::from_millis(250),
            "{elapsed:?}"
        );
        assert_eq!(reply["rows"].as_array().unwrap().len(), 200);
        assert_eq!(reply["rows"][0]["id"], 5000);
        assert!(reply["next_cursor"].is_string());
    }
}
