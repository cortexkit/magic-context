//! Session lists and the one-row session diagnostics.

use std::time::Instant;

use rusqlite::{params, OptionalExtension};
use serde_json::{json, Map, Value};
use subc_client_rs::HandlerOutcome;

use super::admission::AppCaller;
use super::{
    allow, cut_text, decode_cursor, digest_of, encode_cursor, index_unavailable, invalid,
    list_reply, migrated, named, named_detail, page_limit, prepare, row_reply, session_ref,
    AppReadContext, Page, SessionRef,
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
    let if_version = match super::opt_str(params, "if_version", "params") {
        Ok(value) => value,
        Err(refusal) => return refusal,
    };
    if let Err(refusal) = super::opt_str(params, "cursor", "params") {
        return refusal;
    }
    if let Err(refusal) = page_limit(params, 100, 500, "params.limit") {
        return refusal;
    }
    if matches!(section.as_str(), "compartments" | "facts") {
        if session.session.starts_with("mc-provider:") && section == "facts" {
            return index_unavailable("facts", "idx_memories_source_session");
        }
        if let Err(refusal) = locate(ctx, &session, false, &section) {
            return refusal;
        }
        let version = match ctx.context(|conn| session_version(conn, &session, &section)) {
            Ok(version) => version,
            Err(refusal) => return refusal,
        };
        if version.is_some() && version == if_version {
            return super::envelope::reply(
                OP,
                ctx.now_ms(),
                json!({
                    "state": "unchanged", "version": version,
                })
                .as_object()
                .unwrap()
                .clone(),
            );
        }
    }
    match section.as_str() {
        "compartments" => compartments(ctx, &session, params),
        "facts" => facts(ctx, &session, params),
        "notes" => notes(ctx, &session, params),
        "meta" => meta(ctx, &session),
        "token_breakdown" => token_breakdown(ctx, &session),
        "subagents" => subagents(ctx, &session, params),
        "subagent_totals" => subagent_totals(ctx, &session, params),
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
    section: &str,
) -> Result<Located, HandlerOutcome> {
    if session.session.starts_with("mc-provider:") || session.runner != session.harness {
        return Err(index_unavailable(
            section,
            "idx_mc_async_compaction_session",
        ));
    }
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
        Some(_) | None if unmanaged_ok && session.runner == session.harness => {
            Ok(Located::Unmanaged)
        }
        Some(_) | None => Err(index_unavailable(
            section,
            "idx_mc_async_compaction_session",
        )),
    }
}

fn compartments(
    ctx: &AppReadContext,
    session: &SessionRef,
    params: &Map<String, Value>,
) -> HandlerOutcome {
    if let Err(refusal) = locate(ctx, session, false, "compartments") {
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
        let version = session_version(conn, session, "compartments")?;
        ctx.note_sql(COMPARTMENTS_SQL);
        let mut statement = prepare(conn, COMPARTMENTS_SQL)?;
        let mut rows = statement.query(params![session_id, after])?;
        let mut page = Page::new(ctx.row_budget());
        let mut last_sequence = None;
        let mut hit_limit = false;
        while let Some(row) = super::next_row(&mut rows, &mut hit_limit)? {
            if ctx.expired(started) {
                hit_limit = true;
                break;
            }
            let sequence: i64 = row.get(0)?;
            let mut value = json!({
                "compartment_id": row.get::<_, i64>(1)?.to_string(),
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
            super::cap_field(&mut value, "title", 4 * 1024, false);
            if page.len() >= limit || !page.try_push(value) {
                hit_limit = true;
                break;
            }
            last_sequence = Some(sequence.to_string());
        }
        Ok((page, !hit_limit, last_sequence, version))
    });
    match outcome {
        Ok((page, complete, last, version)) => emit_page(
            ctx,
            "compartments",
            version,
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
      LENGTH(CAST(content AS BLOB)), CASE WHEN p1 IS NOT NULL OR p2 IS NOT NULL OR p3 IS NOT NULL OR p4 IS NOT NULL THEN 1 ELSE 0 END \
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
    if let Err(refusal) = locate(ctx, session, false, "facts") {
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
        let version = session_version(conn, session, "facts")?;
        ctx.note_sql(FACTS_SQL);
        let mut statement = prepare(conn, FACTS_SQL)?;
        let mut rows = statement.query(params![session_id, category, created_at, id])?;
        let mut page = Page::new(ctx.row_budget());
        let mut last = None;
        let mut hit_limit = false;
        while let Some(row) = super::next_row(&mut rows, &mut hit_limit)? {
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

fn session_version(
    conn: &rusqlite::Connection,
    session: &SessionRef,
    section: &str,
) -> rusqlite::Result<Option<String>> {
    let counters = if section == "compartments" {
        conn.query_row(
            "SELECT generation, version, rewrite_version FROM compartment_history_versions WHERE session_id = ?1",
            [&session.session],
            |row| Ok(json!([row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?])),
        ).optional()?
    } else {
        facts_version(conn, &session.session)?.map(|value| json!(value))
    };
    Ok(counters.map(|counters| {
        format!(
            "sd1:{}",
            digest_of(&[
                ("section", &json!(section)),
                ("runner", &json!(session.runner)),
                ("harness", &json!(session.harness)),
                ("session", &json!(session.session)),
                ("counters", &counters),
            ])
        )
    }))
}

fn notes(
    ctx: &AppReadContext,
    session: &SessionRef,
    params: &Map<String, Value>,
) -> HandlerOutcome {
    if let Err(refusal) = locate(ctx, session, false, "notes") {
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
        while let Some(row) = super::next_row(&mut rows, &mut hit_limit)? {
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
    if let Err(refusal) = locate(ctx, session, false, "meta") {
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
        Ok(None) => index_unavailable("meta", "idx_mc_async_compaction_session"),
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
    match locate(ctx, session, true, "token_breakdown") {
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
                    row.get::<_, Option<i64>>(11)?,
                ))
            })
            .optional()?;
        let Some((at_ms, last_input, memory_count)) = row else {
            return Ok(None);
        };
        let limit = column_i64(conn, &session_id, "last_usage_context_limit")?;
        let system_tokens = column_i64(conn, &session_id, "system_prompt_tokens")?;
        let overflow_limit = column_i64(conn, &session_id, "detected_context_limit")?;
        let summary_bytes: i64 = conn.query_row(
            "SELECT COALESCE(SUM(LENGTH(CAST(title AS BLOB)) + LENGTH(CAST(content AS BLOB)) + 24), 0) FROM compartments WHERE session_id = ?1",
            [&session_id],
            |row| row.get(0),
        )?;
        let m0 = render_cache(conn, &session_id, "cached_m0_bytes")?;
        let m1 = render_cache(conn, &session_id, "cached_m1_bytes")?;
        let history_tokens = match m0.as_deref().and_then(|text| wrapped_bytes(text, "session-history")) {
            Some(bytes) => bytes.div_ceil(4) as i64 + m1.as_deref().and_then(|text| wrapped_bytes(text, "new-compartments")).unwrap_or(0).div_ceil(4) as i64,
            None => (summary_bytes + 3) / 4,
        };
        let memory = render_cache(conn, &session_id, "memory_block_cache")?.map(|text| text.len().div_ceil(4) as i64).unwrap_or(0);
        let step_ref: Option<String> = conn.query_row(
            "SELECT message_id FROM transform_decisions WHERE session_id = ?1 AND harness = ?2 AND ts_ms = ?3 ORDER BY message_id LIMIT 1",
            params![session_id, session.harness, at_ms], |row| row.get(0),
        ).optional()?;
        Ok(Some((
            at_ms,
            last_input,
            memory_count,
            limit,
            system_tokens,
            history_tokens, memory, overflow_limit, step_ref,
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
        memory_count,
        limit,
        system_tokens,
        history,
        memory,
        overflow_limit,
        step_ref,
    ) = row;
    let system = system_tokens.unwrap_or(0);
    let estimated: i64 = system + history + memory;
    let provider = last_input.filter(|value| *value > 0);
    let (total_tokens, total_source) = match provider {
        Some(tokens) => (Some(tokens), Some("provider")),
        None => (Some(estimated), Some("estimate")),
    };
    let parts = json!([
        {"part": "system_prompt", "tokens": system_tokens, "estimate": system_tokens.is_none()},
        {"part": "tool_definitions", "tokens": null, "estimate": true},
        {"part": "memory", "tokens": memory, "count": memory_count, "estimate": true},
        {"part": "project_docs", "tokens": null, "estimate": true},
        {"part": "user_profile", "tokens": null, "estimate": true},
        {"part": "history_summaries", "tokens": history, "estimate": true},
        {"part": "history_raw", "tokens": null, "estimate": true},
        {"part": "tool_calls_results", "tokens": null, "estimate": true},
        {"part": "last_user_message", "tokens": null, "estimate": true},
    ]);
    let unattributed = total_tokens.map(|total| total.saturating_sub(estimated));
    let window = if limit.unwrap_or(0) > 0 {
        json!({"tokens": limit, "source": "usage"})
    } else if overflow_limit.unwrap_or(0) > 0 {
        json!({"tokens": overflow_limit, "source": "overflow"})
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
            "estimation_source": "legacy_estimate",
            "as_of": {"step_ref": step_ref, "at_ms": at_ms},
            "total": {"tokens": total_tokens, "source": total_source},
            "context_window": window,
            "parts": parts,
            "unattributed": unattributed,
        }),
    )
}

fn render_cache(
    conn: &rusqlite::Connection,
    session: &str,
    key: &str,
) -> rusqlite::Result<Option<String>> {
    let inline: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('session_meta') WHERE name = ?1)",
        [key],
        |row| row.get(0),
    )?;
    let value = if inline {
        conn.query_row(
            &format!("SELECT {key} FROM session_meta WHERE session_id = ?1"),
            [session],
            |row| row.get::<_, rusqlite::types::Value>(0),
        )
        .optional()?
    } else {
        conn.query_row(
            "SELECT value FROM session_render_cache WHERE session_id = ?1 AND cache_key = ?2",
            params![session, key],
            |row| row.get::<_, rusqlite::types::Value>(0),
        )
        .optional()?
    };
    Ok(match value {
        Some(rusqlite::types::Value::Text(value)) => Some(value),
        Some(rusqlite::types::Value::Blob(bytes)) => String::from_utf8(bytes).ok(),
        _ => None,
    })
}

fn wrapped_bytes(text: &str, tag: &str) -> Option<usize> {
    let opening = format!("<{tag}>");
    let closing = format!("</{tag}>");
    let start = text.find(&opening)?;
    let end = text[start..].find(&closing)? + start + closing.len();
    Some(end - start)
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
    if let Err(refusal) = locate(ctx, session, false, "subagents") {
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
        while let Some(row) = super::next_row(&mut rows, &mut hit_limit)? {
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

fn subagent_totals(
    ctx: &AppReadContext,
    session: &SessionRef,
    params: &Map<String, Value>,
) -> HandlerOutcome {
    if let Err(refusal) = locate(ctx, session, false, "subagent_totals") {
        return refusal;
    }
    let started = Instant::now();
    let digest = digest_of(&[("session", &json!(session.session))]);
    let cursor = match decode_cursor(
        opt_cursor(params),
        OP,
        "subagent_totals",
        &digest,
        ctx.now_ms(),
        None,
    ) {
        Ok(cursor) => cursor,
        Err(refusal) => return refusal,
    };
    let after = cursor.and_then(|cursor| cursor.keys.into_iter().next());
    let session_id = session.session.clone();
    let outcome = ctx.context(|conn| {
        ctx.note_sql(TOTALS_SQL);
        let mut statement = prepare(conn, TOTALS_SQL)?;
        let mut rows = statement.query(params![session_id, after])?;
        let mut page = Page::new(ctx.row_budget());
        let mut hit_limit = false;
        let mut last = None;
        while let Some(row) = super::next_row(&mut rows, &mut hit_limit)? {
            if ctx.expired(started) {
                hit_limit = true;
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
            let subagent = value["subagent"].as_str().unwrap().to_string();
            if !page.try_push(value) {
                hit_limit = true;
                break;
            }
            last = Some(vec![subagent]);
        }
        Ok((page, !hit_limit, last))
    });
    match outcome {
        Ok((page, complete, last)) => {
            emit_page(ctx, "subagent_totals", None, page, complete, last, &digest)
        }
        Err(refusal) => refusal,
    }
}

const TOTALS_SQL: &str = "SELECT subagent, COUNT(*), COALESCE(SUM(input_tokens), 0), \
     COALESCE(SUM(output_tokens), 0), COALESCE(SUM(cache_read_tokens), 0), \
     COALESCE(SUM(cache_write_tokens), 0) FROM subagent_invocations \
      WHERE session_id = ?1 AND (?2 IS NULL OR subagent > ?2) GROUP BY subagent ORDER BY subagent";

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

    fn ctx(dir: &std::path::Path) -> (AppReadContext<'static>, std::path::PathBuf) {
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
        if super::super::tests::isolated(
            "app_read::session_data::tests::meta_reads_the_serving_store_not_the_path_resolver",
        ) {
            return;
        }
        let served = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let resolver = other.path().join("cortexkit").join("magic-context");
        std::fs::create_dir_all(&resolver).unwrap();
        let (ctx, served_db) = ctx(served.path());
        apply_sql(
            &served_db,
            "INSERT INTO session_meta(session_id, harness, last_input_tokens) VALUES ('ses', 'opencode', 11);",
        );
        let alternate = open_store(&resolver);
        apply_sql(
            &resolver.join("context.db"),
            "INSERT INTO session_meta(session_id, harness, last_input_tokens) VALUES ('ses', 'opencode', 22);",
        );
        assert_eq!(
            alternate
                .with_context_read(|conn| conn.query_row(
                    "SELECT last_input_tokens FROM session_meta WHERE session_id = 'ses'",
                    [],
                    |row| row.get::<_, i64>(0),
                ))
                .unwrap(),
            22
        );
        std::env::set_var("MAGIC_CONTEXT_TEST_DATA_DIR", other.path());
        std::env::set_var("XDG_DATA_HOME", other.path());
        std::env::remove_var("MAGIC_CONTEXT_STORAGE_DIR");
        assert_eq!(
            crate::host_store::resolve_context_db_path(),
            resolver.join("context.db")
        );
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

    #[test]
    fn every_session_list_stops_under_budget_and_resumes_without_gaps() {
        let dir = tempfile::tempdir().unwrap();
        let (mut ctx, db) = ctx(dir.path());
        apply_sql(&db, include_str!("../../testdata/app-read-g/lists.sql"));
        for (section, id, budget, expected) in [
            ("compartments", "ordinal", 650, vec![4, 3, 2, 1]),
            ("facts", "fact_id", 12000, vec![4, 3, 2, 1]),
            ("notes", "note_id", 12000, vec![4, 3, 2, 1]),
            ("subagents", "id", 6000, vec![4, 3, 2, 1]),
            ("subagent_totals", "subagent", 300, vec![1, 2, 3, 4]),
        ] {
            ctx.set_row_budget(budget);
            let mut params = json!({"section": section, "session": session()});
            let mut found = Vec::new();
            for attempt in 0..8 {
                let reply = response(&read(&caller(), &ctx, params.as_object().unwrap()));
                let rows = reply["rows"].as_array().unwrap();
                assert!(!rows.is_empty(), "{section}: {reply}");
                assert!(
                    serde_json::to_vec(rows).unwrap().len() <= budget,
                    "{section}"
                );
                for row in rows {
                    found.push(if id == "subagent" {
                        row[id]
                            .as_str()
                            .unwrap()
                            .trim_start_matches("agent-")
                            .parse()
                            .unwrap()
                    } else {
                        row[id].as_i64().unwrap()
                    });
                    if section == "compartments" {
                        assert!(row["compartment_id"].is_string());
                        assert_eq!(row["summary_bytes"], 6);
                    }
                }
                if attempt == 0 {
                    assert_eq!(reply["complete"], false, "{section}");
                }
                if reply["complete"] == true {
                    assert!(reply["next_cursor"].is_null());
                    break;
                }
                assert!(reply["next_cursor"].is_string(), "{section}");
                params["cursor"] = reply["next_cursor"].clone();
            }
            assert_eq!(found, expected, "{section}");
        }
    }

    #[test]
    fn compartment_versions_echo_and_change_with_summary_edits() {
        let dir = tempfile::tempdir().unwrap();
        let (ctx, db) = ctx(dir.path());
        apply_sql(&db, include_str!("../../testdata/app-read-g/lists.sql"));
        let mut params = json!({"section": "compartments", "session": session()});
        let first = response(&read(&caller(), &ctx, params.as_object().unwrap()));
        params["if_version"] = first["version"].clone();
        let same = response(&read(&caller(), &ctx, params.as_object().unwrap()));
        assert_eq!(same["state"], "unchanged");
        assert!(same.get("rows").is_none());
        apply_sql(
            &db,
            "UPDATE compartments SET title = 'edited' WHERE session_id = 'ses' AND sequence = 4;",
        );
        let changed = response(&read(&caller(), &ctx, params.as_object().unwrap()));
        assert_ne!(changed["version"], first["version"]);
        assert_eq!(changed["rows"][0]["title"], "edited");
    }

    #[test]
    fn facts_without_an_authoritative_counter_always_return_in_full() {
        let dir = tempfile::tempdir().unwrap();
        let (ctx, db) = ctx(dir.path());
        apply_sql(&db, include_str!("../../testdata/app-read-g/lists.sql"));
        let reply = response(&read(
            &caller(),
            &ctx,
            json!({"section":"facts","session":session(),"if_version":"old-facts-version"})
                .as_object()
                .unwrap(),
        ));
        assert!(reply["version"].is_null());
        assert!(reply.get("state").is_none());
        assert_eq!(reply["rows"].as_array().unwrap().len(), 4);
    }
}
