//! Session lists and the one-row session diagnostics.

use std::time::Instant;

use rusqlite::{params, OptionalExtension};
use serde_json::{json, Map, Value};
use subc_client_rs::HandlerOutcome;

use super::admission::AppCaller;
use super::{
    allow, cut_text, decode_cursor, digest_of, encode_cursor, index_unavailable, invalid,
    list_reply, migrated, named, named_detail, opt_i64, page_limit, prepare, row_reply,
    session_ref, AppReadContext, Page, SessionRef,
};

const OP: &str = "session_data.read";

pub fn read(
    caller: &AppCaller,
    ctx: &AppReadContext,
    params: &Map<String, Value>,
) -> HandlerOutcome {
    let _ = caller;
    if let Err(refusal) = allow(
        params,
        &["session", "section", "limit", "cursor", "if_version"],
        "params",
    ) {
        return refusal;
    }
    let session = match params.get("session") {
        Some(value) => match session_ref(value, "params.session") {
            Ok(session) => session,
            Err(refusal) => return refusal,
        },
        None => return invalid("params.session", "type"),
    };
    let section = match req_section(params) {
        Ok(section) => section,
        Err(refusal) => return refusal,
    };
    if let Err(refusal) = opt_i64(params, "if_version", "params") {
        return refusal;
    }
    match section.as_str() {
        "compartments" => compartments(ctx, &session, params),
        "facts" => facts(ctx, &session, params),
        "notes" => notes(ctx, &session, params),
        "meta" => meta(ctx, &session),
        "token_breakdown" => token_breakdown(ctx, &session),
        "subagents" => subagents(ctx, &session, params),
        "subagent_totals" => subagent_totals(ctx, &session),
        _ => invalid("params.section", "unknown"),
    }
}

fn req_section(params: &Map<String, Value>) -> Result<String, HandlerOutcome> {
    match params.get("section").and_then(Value::as_str) {
        Some(section) if !section.is_empty() => Ok(section.to_string()),
        Some(_) => Err(invalid("params.section", "type")),
        None => Err(invalid("params.section", "type")),
    }
}

enum Located {
    Standalone,
    Unmanaged,
}

fn locate(
    ctx: &AppReadContext,
    session: &SessionRef,
    unmanaged_ok: bool,
) -> Result<Located, HandlerOutcome> {
    let started = Instant::now();
    if ctx.expired(started) {
        return Err(named(
            "read_budget_exceeded",
            "The session read exceeded its time budget.",
        ));
    }
    let harness = session.harness.clone();
    let session_id = session.session.clone();
    let found = ctx.context(|conn| {
        if !migrated(conn)? {
            return Ok(Err("migration"));
        }
        let row = conn
            .query_row(
                "SELECT harness FROM session_meta WHERE session_id = ?1",
                [&session_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        Ok(Ok(row))
    })?;
    let found = match found {
        Ok(row) => row,
        Err(_) => {
            return Err(named(
                "single_store_migration_required",
                "The single-store migration has not finished.",
            ))
        }
    };
    match found {
        Some(stored) if stored == harness => {
            if session.runner != session.harness {
                return Err(named_detail(
                    "session_runner_mismatch",
                    "The session reference names a different runner than the stored session.",
                    json!({"runner": stored}),
                ));
            }
            Ok(Located::Standalone)
        }
        Some(_) | None if unmanaged_ok => Ok(Located::Unmanaged),
        Some(_) | None => Err(index_unavailable(
            "locator",
            "idx_mc_async_compaction_session",
        )),
    }
}

fn compartments(
    ctx: &AppReadContext,
    session: &SessionRef,
    params: &Map<String, Value>,
) -> HandlerOutcome {
    if let Err(refusal) = locate(ctx, session, false) {
        return refusal;
    }
    let limit = match page_limit(params, 100, 200, "params.limit") {
        Ok(limit) => limit,
        Err(refusal) => return refusal,
    };
    let digest = digest_of(&[("session", &json!(session.session))]);
    let cursor = match decode_cursor(
        opt_cursor(params),
        OP,
        "compartments",
        &digest,
        ctx.now_ms(),
        None,
    ) {
        Ok(cursor) => cursor,
        Err(refusal) => return refusal,
    };
    let after = cursor
        .as_ref()
        .and_then(|cursor| cursor.keys.first().cloned());
    let started = Instant::now();
    let session_id = session.session.clone();
    let outcome = ctx.context(|conn| {
        ctx.note_sql(COMPARTMENTS_SQL);
        let mut statement = prepare(conn, COMPARTMENTS_SQL)?;
        let mut rows = statement.query(params![session_id, after])?;
        let mut page = Page::new(ctx.row_budget());
        let mut last_sequence = None;
        let mut complete = true;
        while let Some(row) = rows.next()? {
            if ctx.expired(started) {
                complete = false;
                break;
            }
            let sequence: i64 = row.get(0)?;
            let value = json!({
                "compartment_id": row.get::<_, i64>(1)?,
                "ordinal": sequence,
                "title": row.get::<_, String>(2)?,
                "first_message_id": empty_as_null(row.get(3)?),
                "last_message_id": empty_as_null(row.get(4)?),
                "first_message_ordinal": row.get::<_, i64>(5)?,
                "last_message_ordinal": row.get::<_, i64>(6)?,
                "importance": row.get::<_, i64>(7)?,
                "episode_type": row.get::<_, Option<String>>(8)?,
                "legacy": row.get::<_, i64>(9)? != 0,
                "created_at_ms": row.get::<_, i64>(10)?,
                "summary_bytes": row.get::<_, i64>(11)?,
                "has_tiers": row.get::<_, i64>(12)? != 0,
            });
            if page.len() >= limit || !page.try_push(value) {
                complete = page.len() < limit && !page.stopped_for_budget() || page.len() >= limit;
                if page.len() >= limit || page.stopped_for_budget() {
                    complete = false;
                }
                break;
            }
            last_sequence = Some(sequence.to_string());
        }
        let version = conn
            .query_row(
                "SELECT version FROM compartment_history_versions WHERE session_id = ?1",
                [&session_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        Ok((page, complete, last_sequence, version))
    });
    match outcome {
        Ok((page, complete, last, version)) => emit_page(
            ctx,
            "compartments",
            version.map(|version| version.to_string()),
            page,
            complete,
            last.map(|sequence| vec![sequence]),
            &digest,
        ),
        Err(refusal) => refusal,
    }
}

const COMPARTMENTS_SQL: &str = "SELECT sequence, id, title, start_message_id, end_message_id, \
     start_message, end_message, importance, episode_type, legacy, created_at, \
     LENGTH(content), CASE WHEN p2 IS NOT NULL OR p3 IS NOT NULL OR p4 IS NOT NULL THEN 1 ELSE 0 END \
     FROM compartments WHERE session_id = ?1 AND (?2 IS NULL OR sequence < ?2) \
     ORDER BY sequence DESC";

fn facts(
    ctx: &AppReadContext,
    session: &SessionRef,
    params: &Map<String, Value>,
) -> HandlerOutcome {
    if session.session.starts_with("mc-provider:") {
        return index_unavailable("facts", "idx_memories_source_session");
    }
    if let Err(refusal) = locate(ctx, session, false) {
        return refusal;
    }
    let limit = match page_limit(params, 200, 500, "params.limit") {
        Ok(limit) => limit,
        Err(refusal) => return refusal,
    };
    let digest = digest_of(&[("session", &json!(session.session))]);
    let cursor = match decode_cursor(opt_cursor(params), OP, "facts", &digest, ctx.now_ms(), None) {
        Ok(cursor) => cursor,
        Err(refusal) => return refusal,
    };
    let (category, created_at, id) = cursor_triple(cursor.as_ref());
    let started = Instant::now();
    let session_id = session.session.clone();
    let outcome = ctx.context(|conn| {
        ctx.note_sql(FACTS_SQL);
        let mut statement = prepare(conn, FACTS_SQL)?;
        let mut rows = statement.query(params![session_id, category, created_at, id])?;
        let mut page = Page::new(ctx.row_budget());
        let mut last = None;
        let mut hit_limit = false;
        while let Some(row) = rows.next()? {
            if ctx.expired(started) {
                hit_limit = true;
                break;
            }
            let fact_id: i64 = row.get(0)?;
            let category: String = row.get(1)?;
            let content: String = row.get(2)?;
            let created: i64 = row.get(3)?;
            let (text, truncated, bytes) = cut_text(&content, 8 * 1024);
            let value = json!({
                "fact_id": fact_id,
                "category": category,
                "content": text,
                "content_truncated": truncated,
                "content_bytes": bytes,
                "created_at_ms": created,
                "updated_at_ms": row.get::<_, i64>(4)?,
            });
            if page.len() >= limit || !page.try_push(value) {
                hit_limit = true;
                break;
            }
            last = Some(vec![category, created.to_string(), fact_id.to_string()]);
        }
        let version = facts_version(conn, &session_id)?;
        Ok((page, !hit_limit, last, version))
    });
    match outcome {
        Ok((page, complete, last, version)) => {
            emit_page(ctx, "facts", version, page, complete, last, &digest)
        }
        Err(refusal) => refusal,
    }
}

const FACTS_SQL: &str = "SELECT id, category, content, created_at, updated_at FROM session_facts \
     WHERE session_id = ?1 AND (?2 IS NULL OR category > ?2 OR (category = ?2 AND created_at < ?3) \
        OR (category = ?2 AND created_at = ?3 AND id < ?4)) \
     ORDER BY category ASC, created_at DESC, id DESC";

fn facts_version(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> rusqlite::Result<Option<String>> {
    let has: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('session_meta') WHERE name = 'session_facts_version')",
        [],
        |row| row.get(0),
    )?;
    if !has {
        return Ok(None);
    }
    conn.query_row(
        "SELECT session_facts_version FROM session_meta WHERE session_id = ?1",
        [session_id],
        |row| row.get::<_, Option<i64>>(0),
    )
    .optional()
    .map(|row| row.flatten().map(|version| version.to_string()))
}

fn notes(
    ctx: &AppReadContext,
    session: &SessionRef,
    params: &Map<String, Value>,
) -> HandlerOutcome {
    if let Err(refusal) = locate(ctx, session, false) {
        return refusal;
    }
    let limit = match page_limit(params, 100, 200, "params.limit") {
        Ok(limit) => limit,
        Err(refusal) => return refusal,
    };
    let digest = digest_of(&[
        ("session", &json!(session.session)),
        ("status", &json!("active")),
    ]);
    let cursor = match decode_cursor(opt_cursor(params), OP, "notes", &digest, ctx.now_ms(), None) {
        Ok(cursor) => cursor,
        Err(refusal) => return refusal,
    };
    let (created_at, id) = cursor_pair(cursor.as_ref());
    let started = Instant::now();
    let session_id = session.session.clone();
    let outcome = ctx.context(|conn| {
        ctx.note_sql(NOTES_SQL);
        let mut statement = prepare(conn, NOTES_SQL)?;
        let mut rows = statement.query(params![session_id, created_at, id])?;
        let mut page = Page::new(ctx.row_budget());
        let mut last = None;
        let mut hit_limit = false;
        while let Some(row) = rows.next()? {
            if ctx.expired(started) {
                hit_limit = true;
                break;
            }
            let note_id: i64 = row.get(0)?;
            let content: String = row.get(1)?;
            let created: i64 = row.get(3)?;
            let (text, truncated, bytes) = cut_text(&content, 16 * 1024);
            let value = json!({
                "note_id": note_id,
                "content": text,
                "content_truncated": truncated,
                "content_bytes": bytes,
                "status": row.get::<_, String>(2)?,
                "created_at_ms": created,
                "updated_at_ms": row.get::<_, i64>(4)?,
            });
            if page.len() >= limit || !page.try_push(value) {
                hit_limit = true;
                break;
            }
            last = Some(vec![created.to_string(), note_id.to_string()]);
        }
        Ok((page, !hit_limit, last))
    });
    match outcome {
        Ok((page, complete, last)) => emit_page(ctx, "notes", None, page, complete, last, &digest),
        Err(refusal) => refusal,
    }
}

const NOTES_SQL: &str = "SELECT id, content, status, created_at, updated_at FROM notes INDEXED BY idx_notes_session_status \
     WHERE session_id = ?1 AND status = 'active' AND type = 'session' \
       AND (?2 IS NULL OR created_at < ?2 OR (created_at = ?2 AND id < ?3)) \
     ORDER BY created_at DESC, id DESC";

fn meta(ctx: &AppReadContext, session: &SessionRef) -> HandlerOutcome {
    if let Err(refusal) = locate(ctx, session, false) {
        return refusal;
    }
    let started = Instant::now();
    if ctx.expired(started) {
        return named(
            "read_budget_exceeded",
            "The session read exceeded its time budget.",
        );
    }
    let session_id = session.session.clone();
    let outcome = ctx.context(|conn| {
        ctx.note_sql(META_SQL);
        conn.query_row(META_SQL, [&session_id], |row| {
            Ok(json!({
                "session_id": row.get::<_, String>(0)?,
                "last_response_time_ms": row.get::<_, Option<i64>>(1)?,
                "cache_ttl": empty_as_null(row.get(2)?),
                "counter": row.get::<_, Option<i64>>(3)?,
                "last_nudge_tokens": row.get::<_, Option<i64>>(4)?,
                "last_nudge_band": empty_as_null(row.get(5)?),
                "is_subagent": row.get::<_, Option<i64>>(6)?.unwrap_or(0) != 0,
                "last_context_percentage": row.get::<_, Option<f64>>(7)?,
                "last_input_tokens": row.get::<_, Option<i64>>(8)?,
                "compartment_in_progress": row.get::<_, Option<i64>>(9)?.unwrap_or(0) != 0,
                "system_prompt_hash": empty_as_null(row.get(10)?),
                "memory_block_count": row.get::<_, Option<i64>>(11)?,
                "new_work_tokens": row.get::<_, i64>(12)?,
                "total_input_tokens": row.get::<_, i64>(13)?,
                "historian_failure_count": row.get::<_, Option<i64>>(14)?,
                "historian_last_error": row.get::<_, Option<String>>(15)?,
            }))
        })
        .optional()
    });
    match outcome {
        Ok(Some(row)) => row_reply(OP, Some("meta"), ctx.now_ms(), None, row),
        Ok(None) => index_unavailable("locator", "idx_mc_async_compaction_session"),
        Err(refusal) => refusal,
    }
}

const META_SQL: &str =
    "SELECT session_id, last_response_time, cache_ttl, counter, last_nudge_tokens, \
     last_nudge_band, is_subagent, last_context_percentage, last_input_tokens, \
     compartment_in_progress, system_prompt_hash, memory_block_count, new_work_tokens, \
     total_input_tokens, historian_failure_count, historian_last_error \
     FROM session_meta WHERE session_id = ?1";

fn token_breakdown(ctx: &AppReadContext, session: &SessionRef) -> HandlerOutcome {
    match locate(ctx, session, true) {
        Ok(Located::Unmanaged) => row_reply(
            OP,
            Some("token_breakdown"),
            ctx.now_ms(),
            None,
            unmanaged_breakdown(),
        ),
        Ok(Located::Standalone) => managed_breakdown(ctx, session),
        Err(refusal) => refusal,
    }
}

fn unmanaged_breakdown() -> Value {
    json!({
        "managed": {"value": false},
        "as_of": {"step_ref": null, "at_ms": null},
        "total": null,
        "context_window": null,
        "parts": [],
        "unattributed": null,
    })
}

fn managed_breakdown(ctx: &AppReadContext, session: &SessionRef) -> HandlerOutcome {
    let started = Instant::now();
    if ctx.expired(started) {
        return named(
            "read_budget_exceeded",
            "The session read exceeded its time budget.",
        );
    }
    let session_id = session.session.clone();
    let outcome = ctx.context(|conn| {
        ctx.note_sql(META_SQL);
        let row = conn
            .query_row(META_SQL, [&session_id], |row| {
                Ok((
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<i64>>(8)?,
                    row.get::<_, i64>(12)?,
                    row.get::<_, i64>(13)?,
                    row.get::<_, Option<i64>>(11)?,
                ))
            })
            .optional()?;
        let Some((at_ms, last_input, new_work, total_input, memory_count)) = row else {
            return Ok(None);
        };
        let limit = column_i64(conn, &session_id, "last_usage_context_limit")?;
        let system_tokens = column_i64(conn, &session_id, "system_prompt_tokens")?;
        let summary_bytes: i64 = conn.query_row(
            "SELECT COALESCE(SUM(LENGTH(title) + LENGTH(content)), 0) FROM compartments WHERE session_id = ?1",
            [&session_id],
            |row| row.get(0),
        )?;
        ctx.note_sql("SELECT COALESCE(SUM(LENGTH(title) + LENGTH(content)), 0) FROM compartments WHERE session_id = ?1");
        Ok(Some((
            at_ms,
            last_input,
            new_work,
            total_input,
            memory_count,
            limit,
            system_tokens,
            summary_bytes,
        )))
    });
    let row = match outcome {
        Ok(Some(row)) => row,
        Ok(None) => return unmanaged_breakdown_reply(ctx),
        Err(refusal) => return refusal,
    };
    let (
        at_ms,
        last_input,
        new_work,
        total_input,
        memory_count,
        limit,
        system_tokens,
        summary_bytes,
    ) = row;
    let provider = last_input
        .filter(|value| *value > 0)
        .or_else(|| (total_input > 0).then_some(total_input));
    let (total_tokens, total_source) = match provider {
        Some(tokens) => (Some(tokens), Some("provider")),
        None => (Some(new_work), Some("estimate")),
    };
    let system = system_tokens.unwrap_or(0);
    let history = summary_bytes / 4;
    let memory = memory_count.unwrap_or(0).saturating_mul(32);
    let parts = json!([
        {"part": "system_prompt", "tokens": system, "estimate": system_tokens.is_none()},
        {"part": "tool_definitions", "tokens": null, "estimate": true},
        {"part": "memory", "tokens": memory, "count": memory_count, "estimate": true},
        {"part": "project_docs", "tokens": null, "estimate": true},
        {"part": "user_profile", "tokens": null, "estimate": true},
        {"part": "history_summaries", "tokens": history, "estimate": true},
        {"part": "history_raw", "tokens": null, "estimate": true},
        {"part": "tool_calls_results", "tokens": null, "estimate": true},
        {"part": "last_user_message", "tokens": null, "estimate": true},
    ]);
    let estimated: i64 = system + history + memory;
    let unattributed = total_tokens.map(|total| total.saturating_sub(estimated));
    let window = if limit.unwrap_or(0) > 0 {
        json!({"tokens": limit, "source": "usage"})
    } else {
        json!({"tokens": null, "source": null})
    };
    row_reply(
        OP,
        Some("token_breakdown"),
        ctx.now_ms(),
        None,
        json!({
            "managed": {"value": true},
            "as_of": {"step_ref": null, "at_ms": at_ms},
            "total": {"tokens": total_tokens, "source": total_source},
            "context_window": window,
            "parts": parts,
            "unattributed": unattributed,
        }),
    )
}

fn unmanaged_breakdown_reply(ctx: &AppReadContext) -> HandlerOutcome {
    row_reply(
        OP,
        Some("token_breakdown"),
        ctx.now_ms(),
        None,
        unmanaged_breakdown(),
    )
}

fn column_i64(
    conn: &rusqlite::Connection,
    session_id: &str,
    column: &str,
) -> rusqlite::Result<Option<i64>> {
    let has: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('session_meta') WHERE name = ?1)",
        [column],
        |row| row.get(0),
    )?;
    if !has {
        return Ok(None);
    }
    let sql = format!("SELECT {column} FROM session_meta WHERE session_id = ?1");
    conn.query_row(&sql, [session_id], |row| row.get(0))
}

fn subagents(
    ctx: &AppReadContext,
    session: &SessionRef,
    params: &Map<String, Value>,
) -> HandlerOutcome {
    if let Err(refusal) = locate(ctx, session, false) {
        return refusal;
    }
    let limit = match page_limit(params, 100, 200, "params.limit") {
        Ok(limit) => limit,
        Err(refusal) => return refusal,
    };
    let digest = digest_of(&[("session", &json!(session.session))]);
    let cursor = match decode_cursor(
        opt_cursor(params),
        OP,
        "subagents",
        &digest,
        ctx.now_ms(),
        None,
    ) {
        Ok(cursor) => cursor,
        Err(refusal) => return refusal,
    };
    let (started_at, id) = cursor_pair(cursor.as_ref());
    let started = Instant::now();
    let session_id = session.session.clone();
    let outcome = ctx.context(|conn| {
        ctx.note_sql(SUBAGENTS_SQL);
        let mut statement = prepare(conn, SUBAGENTS_SQL)?;
        let mut rows = statement.query(params![session_id, started_at, id])?;
        let mut page = Page::new(ctx.row_budget());
        let mut last = None;
        let mut hit_limit = false;
        while let Some(row) = rows.next()? {
            if ctx.expired(started) {
                hit_limit = true;
                break;
            }
            let invocation_id: i64 = row.get(0)?;
            let started_ms: i64 = row.get(5)?;
            let (task, task_truncated, task_bytes) = cut_text(
                &row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                4 * 1024,
            );
            let (error, error_truncated, error_bytes) = cut_text(
                &row.get::<_, Option<String>>(11)?.unwrap_or_default(),
                4 * 1024,
            );
            let value = json!({
                "id": invocation_id,
                "subagent": row.get::<_, String>(1)?,
                "task": task,
                "task_truncated": task_truncated,
                "task_bytes": task_bytes,
                "provider_id": row.get::<_, Option<String>>(3)?,
                "model_id": row.get::<_, Option<String>>(4)?,
                "started_at_ms": started_ms,
                "ended_at_ms": row.get::<_, Option<i64>>(6)?,
                "status": row.get::<_, String>(7)?,
                "input_tokens": row.get::<_, i64>(8)?,
                "output_tokens": row.get::<_, i64>(9)?,
                "cache_read_tokens": row.get::<_, i64>(10)?,
                "cache_write_tokens": row.get::<_, i64>(12)?,
                "error": if error.is_empty() { Value::Null } else { json!(error) },
                "error_truncated": error_truncated,
                "error_bytes": error_bytes,
                "parent_invocation_id": row.get::<_, Option<i64>>(13)?,
            });
            if page.len() >= limit || !page.try_push(value) {
                hit_limit = true;
                break;
            }
            last = Some(vec![started_ms.to_string(), invocation_id.to_string()]);
        }
        Ok((page, !hit_limit, last))
    });
    match outcome {
        Ok((page, complete, last)) => {
            emit_page(ctx, "subagents", None, page, complete, last, &digest)
        }
        Err(refusal) => refusal,
    }
}

const SUBAGENTS_SQL: &str =
    "SELECT id, subagent, task, provider_id, model_id, started_at, ended_at, \
     status, input_tokens, output_tokens, cache_read_tokens, error, cache_write_tokens, \
     parent_invocation_id FROM subagent_invocations \
     WHERE session_id = ?1 AND (?2 IS NULL OR started_at < ?2 OR (started_at = ?2 AND id < ?3)) \
     ORDER BY started_at DESC, id DESC";

fn subagent_totals(ctx: &AppReadContext, session: &SessionRef) -> HandlerOutcome {
    if let Err(refusal) = locate(ctx, session, false) {
        return refusal;
    }
    let started = Instant::now();
    let session_id = session.session.clone();
    let outcome = ctx.context(|conn| {
        ctx.note_sql(TOTALS_SQL);
        let mut statement = prepare(conn, TOTALS_SQL)?;
        let mut rows = statement.query([&session_id])?;
        let mut page = Page::new(ctx.row_budget());
        let mut complete = true;
        while let Some(row) = rows.next()? {
            if ctx.expired(started) {
                complete = false;
                break;
            }
            let value = json!({
                "subagent": row.get::<_, String>(0)?,
                "count": row.get::<_, i64>(1)?,
                "input_tokens": row.get::<_, i64>(2)?,
                "output_tokens": row.get::<_, i64>(3)?,
                "cache_read_tokens": row.get::<_, i64>(4)?,
                "cache_write_tokens": row.get::<_, i64>(5)?,
            });
            if !page.try_push(value) {
                complete = false;
                break;
            }
        }
        Ok((page, complete))
    });
    match outcome {
        Ok((page, complete)) => list_reply(
            OP,
            "subagent_totals",
            ctx.now_ms(),
            None,
            complete && !page.stopped_for_budget(),
            page.rows(),
            None,
        ),
        Err(refusal) => refusal,
    }
}

const TOTALS_SQL: &str = "SELECT subagent, COUNT(*), COALESCE(SUM(input_tokens), 0), \
     COALESCE(SUM(output_tokens), 0), COALESCE(SUM(cache_read_tokens), 0), \
     COALESCE(SUM(cache_write_tokens), 0) FROM subagent_invocations \
     WHERE session_id = ?1 GROUP BY subagent ORDER BY subagent";

fn emit_page(
    ctx: &AppReadContext,
    section: &str,
    version: Option<String>,
    page: Page,
    complete: bool,
    last: Option<Vec<String>>,
    digest: &str,
) -> HandlerOutcome {
    let next = if complete {
        None
    } else if let Some(keys) = last {
        match encode_cursor(OP, section, digest, &keys, None) {
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

fn opt_cursor(params: &Map<String, Value>) -> Option<&str> {
    params.get("cursor").and_then(Value::as_str)
}

fn cursor_pair(cursor: Option<&super::Cursor>) -> (Option<i64>, Option<i64>) {
    let Some(cursor) = cursor else {
        return (None, None);
    };
    (
        cursor.keys.first().and_then(|value| value.parse().ok()),
        cursor.keys.get(1).and_then(|value| value.parse().ok()),
    )
}

fn cursor_triple(cursor: Option<&super::Cursor>) -> (Option<String>, Option<i64>, Option<i64>) {
    let Some(cursor) = cursor else {
        return (None, None, None);
    };
    (
        cursor.keys.first().cloned(),
        cursor.keys.get(1).and_then(|value| value.parse().ok()),
        cursor.keys.get(2).and_then(|value| value.parse().ok()),
    )
}

fn empty_as_null(value: Option<String>) -> Value {
    match value {
        Some(text) if !text.is_empty() => json!(text),
        _ => Value::Null,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_read::tests_support::{apply_sql, explain, open_store, response};
    use serde_json::json;
    use std::time::Duration;

    fn ctx(dir: &std::path::Path) -> (AppReadContext, std::path::PathBuf) {
        let store = open_store(dir);
        let context_db = dir.join("context.db");
        let mut ctx = AppReadContext::for_test(store, 1_700_000_000_000);
        ctx.set_sql_log(std::sync::Arc::new(std::sync::Mutex::new(Vec::new())));
        (ctx, context_db)
    }

    fn session() -> Value {
        json!({"runner": "opencode", "harness": "opencode", "session": "ses"})
    }

    fn caller() -> AppCaller {
        crate::app_read::tests_support::caller()
    }

    #[test]
    fn nested_unknown_session_key_is_refused_by_dotted_name() {
        let dir = tempfile::tempdir().unwrap();
        let (ctx, _) = ctx(dir.path());
        let params = json!({"session": {"runner": "opencode", "harness": "opencode", "session": "ses", "extra": 1}, "section": "meta"});
        let outcome = read(&caller(), &ctx, params.as_object().unwrap());
        assert_eq!(
            crate::app_read::detail_field(&outcome),
            json!({"field": "params.session.extra", "reason": "unknown"})
        );
    }

    #[test]
    fn compartments_page_under_budget_and_the_cursor_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let (mut ctx, db) = ctx(dir.path());
        apply_sql(
            &db,
            "INSERT INTO session_meta(session_id, harness) VALUES ('ses', 'opencode');
             INSERT INTO compartments(session_id, sequence, start_message, end_message, title, content, created_at, harness)
             VALUES ('ses', 3, 1, 2, 'c', 'x', 30, 'opencode'),
                    ('ses', 2, 1, 2, 'b', 'x', 20, 'opencode'),
                    ('ses', 1, 1, 2, 'a', 'x', 10, 'opencode');",
        );
        ctx.set_row_budget(180);
        let params = json!({"session": session(), "section": "compartments", "limit": 10});
        let first = response(&read(&caller(), &ctx, params.as_object().unwrap()));
        assert_eq!(first["complete"], false);
        assert!(!first["rows"].as_array().unwrap().is_empty());
        assert!(first["next_cursor"].is_string());
        let mut next = params.clone();
        next["cursor"] = first["next_cursor"].clone();
        let second = response(&read(&caller(), &ctx, next.as_object().unwrap()));
        assert_ne!(second["rows"][0]["ordinal"], first["rows"][0]["ordinal"]);
        let plan = explain(&db, COMPARTMENTS_SQL);
        assert!(
            plan.contains("USING INDEX") && plan.contains("compartments"),
            "{plan}"
        );
        assert!(!plan.contains("SCAN compartments"), "{plan}");
    }

    #[test]
    fn facts_use_the_session_index_and_resume_by_category() {
        let dir = tempfile::tempdir().unwrap();
        let (ctx, db) = ctx(dir.path());
        apply_sql(
            &db,
            "INSERT INTO session_meta(session_id, harness) VALUES ('ses', 'opencode');
             INSERT INTO session_facts(session_id, category, content, created_at, updated_at, harness)
             VALUES ('ses', 'a', 'one', 20, 20, 'opencode'),
                    ('ses', 'a', 'two', 10, 10, 'opencode'),
                    ('ses', 'b', 'three', 30, 30, 'opencode');",
        );
        let params = json!({"session": session(), "section": "facts", "limit": 1});
        let first = response(&read(&caller(), &ctx, params.as_object().unwrap()));
        assert_eq!(first["rows"][0]["category"], "a");
        assert_eq!(first["complete"], false);
        let mut next = params.clone();
        next["cursor"] = first["next_cursor"].clone();
        let second = response(&read(&caller(), &ctx, next.as_object().unwrap()));
        assert_eq!(second["rows"][0]["content"], "two");
        let plan = explain(&db, FACTS_SQL);
        assert!(plan.contains("idx_session_facts_session"), "{plan}");
        assert!(plan.contains("SEARCH"), "{plan}");
    }

    #[test]
    fn mode3_facts_are_refused_without_scanning_memories() {
        let dir = tempfile::tempdir().unwrap();
        let (ctx, _) = ctx(dir.path());
        let params = json!({
            "session": {"runner": "opencode", "harness": "opencode", "session": "mc-provider:abc:async:1"},
            "section": "facts"
        });
        let outcome = read(&caller(), &ctx, params.as_object().unwrap());
        match outcome {
            HandlerOutcome::ErrorWithDetail { code, detail, .. } => {
                assert_eq!(code, "app_op_unavailable");
                assert_eq!(detail["index"], "idx_memories_source_session");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_missing_session_does_not_scan_for_mode3() {
        let dir = tempfile::tempdir().unwrap();
        let (ctx, _) = ctx(dir.path());
        let params = json!({"session": session(), "section": "meta"});
        let outcome = read(&caller(), &ctx, params.as_object().unwrap());
        match outcome {
            HandlerOutcome::ErrorWithDetail { code, detail, .. } => {
                assert_eq!(code, "app_op_unavailable");
                assert_eq!(detail["index"], "idx_mc_async_compaction_session");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn notes_exclude_smart_notes_and_use_the_status_index() {
        let dir = tempfile::tempdir().unwrap();
        let (ctx, db) = ctx(dir.path());
        apply_sql(
            &db,
            "INSERT INTO session_meta(session_id, harness) VALUES ('ses', 'opencode');
             INSERT INTO notes(type, status, content, session_id, created_at, updated_at, harness)
             VALUES ('session', 'active', 'keep', 'ses', 2, 2, 'opencode'),
                    ('smart', 'active', 'hide', 'ses', 3, 3, 'opencode'),
                    ('session', 'dismissed', 'gone', 'ses', 4, 4, 'opencode');",
        );
        let params = json!({"session": session(), "section": "notes"});
        let reply = response(&read(&caller(), &ctx, params.as_object().unwrap()));
        assert_eq!(reply["rows"].as_array().unwrap().len(), 1);
        assert_eq!(reply["rows"][0]["content"], "keep");
        let plan = explain(&db, NOTES_SQL);
        assert!(plan.contains("idx_notes_session_status"), "{plan}");
    }

    #[test]
    fn subagents_resume_and_use_the_started_index() {
        let dir = tempfile::tempdir().unwrap();
        let (ctx, db) = ctx(dir.path());
        apply_sql(
            &db,
            "INSERT INTO session_meta(session_id, harness) VALUES ('ses', 'opencode');
             INSERT INTO subagent_invocations(session_id, harness, subagent, task, started_at, status)
             VALUES ('ses', 'opencode', 'a', 'one', 30, 'done'),
                    ('ses', 'opencode', 'b', 'two', 20, 'done'),
                    ('ses', 'opencode', 'c', 'three', 10, 'done');",
        );
        let params = json!({"session": session(), "section": "subagents", "limit": 2});
        let first = response(&read(&caller(), &ctx, params.as_object().unwrap()));
        assert_eq!(first["rows"].as_array().unwrap().len(), 2);
        let mut next = params.clone();
        next["cursor"] = first["next_cursor"].clone();
        let second = response(&read(&caller(), &ctx, next.as_object().unwrap()));
        assert_eq!(second["rows"][0]["task"], "three");
        assert_eq!(second["complete"], true);
        let plan = explain(&db, SUBAGENTS_SQL);
        assert!(plan.contains("idx_sai_session_started"), "{plan}");
    }

    #[test]
    fn subagent_totals_group_on_the_session_index() {
        let dir = tempfile::tempdir().unwrap();
        let (ctx, db) = ctx(dir.path());
        apply_sql(
            &db,
            "INSERT INTO session_meta(session_id, harness) VALUES ('ses', 'opencode');
             INSERT INTO subagent_invocations(session_id, harness, subagent, started_at, status, input_tokens, output_tokens)
             VALUES ('ses', 'opencode', 'a', 1, 'done', 4, 1),
                    ('ses', 'opencode', 'a', 2, 'done', 6, 1);",
        );
        let params = json!({"session": session(), "section": "subagent_totals"});
        let reply = response(&read(&caller(), &ctx, params.as_object().unwrap()));
        assert_eq!(reply["rows"][0]["count"], 2);
        assert_eq!(reply["rows"][0]["input_tokens"], 10);
        let plan = explain(&db, TOTALS_SQL);
        assert!(plan.contains("idx_sai_session_started"), "{plan}");
    }

    #[test]
    fn token_breakdown_covers_provider_estimate_and_unmanaged() {
        let dir = tempfile::tempdir().unwrap();
        let (ctx, db) = ctx(dir.path());
        apply_sql(
            &db,
            "INSERT INTO session_meta(session_id, harness, last_input_tokens, total_input_tokens, new_work_tokens)
             VALUES ('ses', 'opencode', 80, 80, 10),
                    ('est', 'opencode', 0, 0, 15);",
        );
        let provider = response(&read(
            &caller(),
            &ctx,
            json!({"session": session(), "section": "token_breakdown"})
                .as_object()
                .unwrap(),
        ));
        assert_eq!(provider["row"]["total"]["source"], "provider");
        assert_eq!(provider["row"]["total"]["tokens"], 80);
        assert!(provider["row"]["unattributed"].is_number());
        let estimated = response(&read(
            &caller(),
            &ctx,
            json!({"session": {"runner": "opencode", "harness": "opencode", "session": "est"}, "section": "token_breakdown"})
                .as_object()
                .unwrap(),
        ));
        assert_eq!(estimated["row"]["total"]["source"], "estimate");
        let unmanaged = response(&read(
            &caller(),
            &ctx,
            json!({"session": {"runner": "opencode", "harness": "opencode", "session": "missing"}, "section": "token_breakdown"})
                .as_object()
                .unwrap(),
        ));
        assert_eq!(unmanaged["row"]["managed"]["value"], false);
        assert!(unmanaged["row"]["parts"].as_array().unwrap().is_empty());
        assert!(unmanaged["row"]["total"].is_null());
    }

    #[test]
    fn a_zero_budget_refuses_the_single_row_meta_read() {
        let dir = tempfile::tempdir().unwrap();
        let (mut ctx, db) = ctx(dir.path());
        apply_sql(
            &db,
            "INSERT INTO session_meta(session_id, harness) VALUES ('ses', 'opencode');",
        );
        ctx.set_budget(Duration::ZERO);
        let outcome = read(
            &caller(),
            &ctx,
            json!({"session": session(), "section": "meta"})
                .as_object()
                .unwrap(),
        );
        match outcome {
            HandlerOutcome::Error { code, .. } => assert_eq!(code, "read_budget_exceeded"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn meta_reads_the_serving_store_not_the_path_resolver() {
        let served = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let resolver = other.path().join("cortexkit").join("magic-context");
        std::fs::create_dir_all(&resolver).unwrap();
        let (ctx, served_db) = ctx(served.path());
        apply_sql(
            &served_db,
            "INSERT INTO session_meta(session_id, harness, last_input_tokens) VALUES ('ses', 'opencode', 11);",
        );
        std::fs::copy(&served_db, resolver.join("context.db")).unwrap();
        apply_sql(
            &resolver.join("context.db"),
            "UPDATE session_meta SET last_input_tokens = 22 WHERE session_id = 'ses';",
        );
        std::env::set_var("MAGIC_CONTEXT_TEST_DATA_DIR", other.path());
        let reply = response(&read(
            &caller(),
            &ctx,
            json!({"session": session(), "section": "meta"})
                .as_object()
                .unwrap(),
        ));
        std::env::remove_var("MAGIC_CONTEXT_TEST_DATA_DIR");
        assert_eq!(reply["row"]["last_input_tokens"], 11);
    }
}
