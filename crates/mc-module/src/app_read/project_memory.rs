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
        if project.is_empty() || project.contains('\\') || project.starts_with('/') {
            return Err(invalid("params.project", "range"));
        }
        return Ok(Scope {
            projects: vec![project.clone()],
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
        return Ok(Scope {
            projects: members,
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
        Ok(query) => query,
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
        ("status", &json!(status)),
        ("category", &json!(category)),
        ("query", &json!(query)),
    ]);
    let ranked = query
        .as_ref()
        .is_some_and(|query| query.chars().count() >= 3 && !query.starts_with('#'));
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
                {
                    let mut page = Page::new(ctx.row_budget());
                    page.try_push(row);
                    return Ok((page, true, None, Some(0)));
                }
            }
        }
        let sql = if ranked {
            MEMORY_FTS_SQL
        } else {
            MEMORY_FILTER_SQL
        };
        ctx.note_sql(sql);
        let project = scope.projects.first().cloned().unwrap_or_default();
        let status_one = status.first().cloned();
        let category_one = category.first().cloned();
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
                project,
                query.unwrap_or_default(),
                offset,
                limit as i64 + 1
            ])?
        } else {
            statement.query(params![
                project,
                status_one,
                category_one,
                if query.is_some() { Some(like) } else { None },
                updated,
                id
            ])?
        };
        let mut page = Page::new(ctx.row_budget());
        let mut last = None;
        let mut hit = false;
        let mut seen = 0i64;
        while let Some(row) = rows.next()? {
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
        Ok((page, !hit, last, ranked.then_some(ctx.now_ms())))
    });
    match outcome {
        Ok((page, complete, last, issued)) => {
            finish(ctx, "memories", None, page, complete, last, &digest, issued)
        }
        Err(refusal) => refusal,
    }
}

fn memory_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let content: String = row.get(4)?;
    let (text, truncated, bytes) = cut_text(&content, 16 * 1024);
    Ok(json!({
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
    }))
}

const MEMORY_FILTER_SQL: &str = "SELECT m.id, m.revision, m.project_path, m.category, m.content, m.normalized_hash, \
     m.source_session_id, m.source_type, m.seen_count, m.retrieval_count, m.first_seen_at, m.created_at, \
     m.updated_at, m.last_seen_at, m.last_retrieved_at, m.status, m.expires_at, m.verification_status, \
     m.verified_at, m.superseded_by_memory_id, m.merged_from, m.metadata_json, m.importance, m.scope, \
     m.shareable, EXISTS(SELECT 1 FROM memory_embeddings e WHERE e.memory_id = m.id) \
     FROM memories m INDEXED BY idx_memories_project_status_category \
     WHERE m.project_path = ?1 AND (?2 IS NULL OR m.status = ?2) AND (?3 IS NULL OR m.category = ?3) \
       AND (?4 IS NULL OR m.content LIKE ?4) \
       AND (?5 IS NULL OR m.updated_at < ?5 OR (m.updated_at = ?5 AND m.id < ?6)) \
     ORDER BY m.updated_at DESC, m.id DESC";

const MEMORY_FTS_SQL: &str = "SELECT m.id, m.revision, m.project_path, m.category, m.content, m.normalized_hash, \
     m.source_session_id, m.source_type, m.seen_count, m.retrieval_count, m.first_seen_at, m.created_at, \
     m.updated_at, m.last_seen_at, m.last_retrieved_at, m.status, m.expires_at, m.verification_status, \
     m.verified_at, m.superseded_by_memory_id, m.merged_from, m.metadata_json, m.importance, m.scope, \
     m.shareable, EXISTS(SELECT 1 FROM memory_embeddings e WHERE e.memory_id = m.id) \
     FROM memories_fts f JOIN memories m ON m.id = f.rowid \
     WHERE m.project_path = ?1 AND memories_fts MATCH ?2 \
     ORDER BY rank LIMIT -1 OFFSET ?3";

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
    let project = scope.projects.first().cloned().unwrap_or_default();
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
        let version = version_for(conn, &project)?;
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

const STATS_SQL: &str = "SELECT status, category, COUNT(*) FROM memories WHERE project_path = ?1 GROUP BY status, category";
const EMBEDDED_SQL: &str = "SELECT COUNT(*) FROM memories m WHERE m.project_path = ?1 AND EXISTS(SELECT 1 FROM memory_embeddings e WHERE e.memory_id = m.id)";

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
    Ok(state.map(|(epoch, profile)| format!("{epoch}:{profile}:{}", mutation.unwrap_or(0))))
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
        let hash = hash_image(conn, &project, usize::try_from(bytes).unwrap_or(0))?;
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
        let start = offset.min(total);
        let end = (start + 300 * 1024).min(total);
        ctx.note_sql("SELECT substr(image, ?1, ?2) FROM mural_manifest WHERE project_path = ?3");
        let bytes: Vec<u8> = if end > start {
            conn.query_row(
                "SELECT substr(image, ?1, ?2) FROM mural_manifest WHERE project_path = ?3",
                params![start as i64 + 1, (end - start) as i64, project],
                |row| row.get(0),
            )?
        } else {
            Vec::new()
        };
        let hash = hash_image(conn, &project, total)?;
        Ok(Some(json!({
            "offset": start,
            "bytes_base64": base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes),
            "total_bytes": total,
            "image_sha256": hash,
            "content_hash": content_hash,
        })))
    });
    match outcome {
        Ok(Some(row)) => row_reply(OP, Some("mural_image"), ctx.now_ms(), None, row),
        Ok(None) => named("mural_not_found", "No mural is stored for that project."),
        Err(refusal) => refusal,
    }
}

fn hash_image(
    conn: &rusqlite::Connection,
    project: &str,
    total: usize,
) -> rusqlite::Result<String> {
    let mut hasher = sha2::Sha256::new();
    let mut start = 0usize;
    while start < total {
        let len = (total - start).min(8192) as i64;
        let chunk: Vec<u8> = conn.query_row(
            "SELECT substr(image, ?1, ?2) FROM mural_manifest WHERE project_path = ?3",
            params![start as i64 + 1, len, project],
            |row| row.get(0),
        )?;
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

const PRIMERS_SQL: &str = "SELECT id, project_path, question, answer, status, total_support, last_observed_at, answer_refreshed_at, source_candidate_ids, created_at, updated_at FROM primers WHERE project_path = ?1 AND (?2 IS NULL OR status = ?2) AND (?3 IS NULL OR status > ?3 OR (status = ?3 AND COALESCE(last_observed_at, 0) < ?4) OR (status = ?3 AND COALESCE(last_observed_at, 0) = ?4 AND id > ?5)) ORDER BY status ASC, last_observed_at DESC, id ASC";
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
        let status_one = status.first().cloned();
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
            statement.query(params![project, status_one, key_status, observed, id])?
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
        while let Some(row) = rows.next()? {
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
    Ok(json!({
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
    }))
}

fn candidate_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_, i64>(0)?,
        "project_path": row.get::<_, String>(1)?,
        "question": row.get::<_, String>(2)?,
        "session_id": row.get::<_, String>(3)?,
        "source_compartment_start": row.get::<_, Option<i64>>(4)?,
        "source_compartment_end": row.get::<_, Option<i64>>(5)?,
        "source_message_time_ms": row.get::<_, i64>(6)?,
        "created_at_ms": row.get::<_, i64>(7)?,
    }))
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
        while let Some(row) = rows.next()? {
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
    let status_one = status.first().cloned();
    let started = Instant::now();
    let outcome = ctx.context(|conn| {
        ctx.note_sql(USER_MEMORIES_SQL);
        let mut statement = prepare(conn, USER_MEMORIES_SQL)?;
        let mut rows = statement.query(params![status_one, created, id])?;
        let mut page = Page::new(ctx.row_budget());
        let mut last = None;
        let mut hit = false;
        while let Some(row) = rows.next()? {
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

const USER_MEMORIES_SQL: &str = "SELECT id, content, status, promoted_at, source_candidate_ids, created_at, updated_at FROM user_memories WHERE (?1 IS NULL OR status = ?1) AND status >= '' AND (?2 IS NULL OR created_at < ?2 OR (created_at = ?2 AND id < ?3)) ORDER BY created_at DESC, id DESC";

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
        while let Some(row) = rows.next()? {
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

    fn ready(dir: &std::path::Path) -> (AppReadContext, std::path::PathBuf) {
        let store = open_store(dir);
        let mut ctx = AppReadContext::for_test(store, 1_700_000_000_000);
        ctx.set_sql_log(Arc::new(Mutex::new(Vec::new())));
        (ctx, dir.join("context.db"))
    }

    fn caller() -> AppCaller {
        crate::app_read::tests_support::caller()
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
}
