//! Dreamer schedule, state, project, run and change reads.

use std::time::Instant;

use rusqlite::{params, OptionalExtension};
use serde_json::{json, Map, Value};
use subc_client_rs::HandlerOutcome;

use super::admission::AppCaller;
use super::{
    allow, cut_text, decode_cursor, digest_of, encode_cursor, invalid, list_reply, named, opt_i64,
    opt_str, page_limit, prepare, AppReadContext, Page,
};

const OP: &str = "dreamer.read";
const TASKS: [&str; 12] = [
    "map-memories",
    "verify",
    "verify-broad",
    "curate",
    "compress-cues",
    "classify-memories",
    "retrospective",
    "maintain-docs",
    "evaluate-smart-notes",
    "review-user-memories",
    "promote-primers",
    "refresh-primers",
];

pub fn read(
    caller: &AppCaller,
    ctx: &AppReadContext,
    params: &Map<String, Value>,
) -> HandlerOutcome {
    let _ = caller;
    if let Err(refusal) = allow(
        params,
        &["section", "project", "cursor", "limit", "run_id"],
        "params",
    ) {
        return refusal;
    }
    let section = match params.get("section").and_then(Value::as_str) {
        Some(section) if !section.is_empty() => section,
        _ => return invalid("params.section", "type"),
    };
    match section {
        "schedule" => schedule(ctx, params),
        "state" => state(ctx, params),
        "projects" => projects(ctx, params),
        "runs" => runs(ctx, params),
        "run_changes" => run_changes(ctx, params),
        _ => invalid("params.section", "unknown"),
    }
}

fn default_schedule(task: &str) -> &'static str {
    match task {
        "map-memories" => "0 2 * * *",
        "verify" => "0 3 * * *",
        "verify-broad" => "0 4 * * 0",
        "curate" => "0 4 * * 0",
        "compress-cues" => "0 4 * * *",
        "classify-memories" => "0 6 * * *",
        "retrospective" => "0 5 * * *",
        "maintain-docs" => "",
        "evaluate-smart-notes" => "0 3 * * *",
        "review-user-memories" => "0 3 * * *",
        "promote-primers" => "0 3 * * *",
        "refresh-primers" => "0 3 * * *",
        _ => "",
    }
}

fn schedule(ctx: &AppReadContext, params: &Map<String, Value>) -> HandlerOutcome {
    let project = match opt_str(params, "project", "params") {
        Ok(project) => project,
        Err(refusal) => return refusal,
    };
    let limit = match page_limit(params, 200, 500, "params.limit") {
        Ok(limit) => limit,
        Err(refusal) => return refusal,
    };
    let digest = digest_of(&[("project", &json!(project))]);
    let cursor = match decode_cursor(
        params.get("cursor").and_then(Value::as_str),
        OP,
        "schedule",
        &digest,
        ctx.now_ms(),
        None,
    ) {
        Ok(cursor) => cursor,
        Err(refusal) => return refusal,
    };
    let after_project = cursor
        .as_ref()
        .and_then(|cursor| cursor.keys.first().cloned());
    let after_task = cursor
        .as_ref()
        .and_then(|cursor| cursor.keys.get(1).cloned());
    let started = Instant::now();
    let outcome = ctx.context(|conn| {
        ctx.note_sql(SCHEDULE_SQL);
        let mut statement = prepare(conn, SCHEDULE_SQL)?;
        let lower_project = after_project.unwrap_or_default();
        let lower_task = after_task.unwrap_or_default();
        let mut rows = statement.query(params![lower_project, lower_task])?;
        let mut page = Page::new(ctx.row_budget());
        let mut last = None;
        let mut hit = false;
        while let Some(row) = rows.next()? {
            if ctx.expired(started) {
                hit = true;
                break;
            }
            let project_path: String = row.get(0)?;
            let task: String = row.get(1)?;
            if let Some(only) = project.as_deref() {
                if project_path != only {
                    continue;
                }
            }
            let value = json!({
                "project_path": project_path,
                "task": task,
                "last_run_at_ms": row.get::<_, Option<i64>>(2)?,
                "next_due_at_ms": row.get::<_, Option<i64>>(3)?,
                "schedule": row.get::<_, Option<String>>(4)?,
                "last_status": row.get::<_, Option<String>>(5)?,
                "last_error": row.get::<_, Option<String>>(6)?,
                "retry_count": row.get::<_, i64>(7)?,
            });
            if page.len() >= limit || !page.try_push(value) {
                hit = true;
                break;
            }
            last = Some(vec![project_path, task]);
        }
        Ok((page, !hit, last))
    });
    match outcome {
        Ok((page, complete, last)) => finish(ctx, "schedule", page, complete, last, &digest),
        Err(refusal) => refusal,
    }
}

const SCHEDULE_SQL: &str = "SELECT project_path, task, last_run_at, next_due_at, schedule, last_status, last_error, retry_count \
     FROM task_schedule_state \
     WHERE project_path > ?1 OR (project_path = ?1 AND task > ?2) \
     ORDER BY project_path ASC, task ASC";

fn state(ctx: &AppReadContext, params: &Map<String, Value>) -> HandlerOutcome {
    let limit = match page_limit(params, 200, 500, "params.limit") {
        Ok(limit) => limit,
        Err(refusal) => return refusal,
    };
    let digest = digest_of(&[]);
    let cursor = match decode_cursor(
        params.get("cursor").and_then(Value::as_str),
        OP,
        "state",
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
        ctx.note_sql(STATE_SQL);
        let mut statement = prepare(conn, STATE_SQL)?;
        let mut rows = statement.query(params![after])?;
        let mut page = Page::new(ctx.row_budget());
        let mut last = None;
        let mut hit = false;
        while let Some(row) = rows.next()? {
            if ctx.expired(started) {
                hit = true;
                break;
            }
            let key: String = row.get(0)?;
            let value_text: String = row.get(1)?;
            let (text, truncated, bytes) = cut_text(&value_text, 8 * 1024);
            let value = json!({
                "key": key,
                "value": text,
                "value_truncated": truncated,
                "value_bytes": bytes,
            });
            if page.len() >= limit || !page.try_push(value) {
                hit = true;
                break;
            }
            last = Some(vec![key]);
        }
        Ok((page, !hit, last))
    });
    match outcome {
        Ok((page, complete, last)) => finish(ctx, "state", page, complete, last, &digest),
        Err(refusal) => refusal,
    }
}

const STATE_SQL: &str =
    "SELECT key, value FROM dream_state WHERE (?1 IS NULL OR key > ?1) ORDER BY key ASC";

fn projects(ctx: &AppReadContext, params: &Map<String, Value>) -> HandlerOutcome {
    let limit = match page_limit(params, 50, 100, "params.limit") {
        Ok(limit) => limit,
        Err(refusal) => return refusal,
    };
    let digest = digest_of(&[]);
    let cursor = match decode_cursor(
        params.get("cursor").and_then(Value::as_str),
        OP,
        "projects",
        &digest,
        ctx.now_ms(),
        None,
    ) {
        Ok(cursor) => cursor,
        Err(refusal) => return refusal,
    };
    let after = cursor.and_then(|cursor| cursor.keys.into_iter().next());
    let schedules = crate::app_read::config::dream_schedules(ctx);
    let started = Instant::now();
    let outcome = ctx.context(|conn| {
        ctx.note_sql(PROJECTS_SQL);
        let mut statement = prepare(conn, PROJECTS_SQL)?;
        let mut rows = statement.query(params![after])?;
        let mut page = Page::new(ctx.row_budget());
        let mut last = None;
        let mut hit = false;
        let mut current: Option<String> = None;
        let mut bucket: Vec<Value> = Vec::new();
        let flush = |page: &mut Page, project: String, tasks: Vec<Value>, limit: usize| -> bool {
            let value = json!({"project": project, "tasks": tasks});
            page.len() >= limit || !page.try_push(value)
        };
        while let Some(row) = rows.next()? {
            if ctx.expired(started) {
                hit = true;
                break;
            }
            let project: String = row.get(0)?;
            if current.as_ref() != Some(&project) {
                if let Some(previous) = current.take() {
                    if flush(
                        &mut page,
                        previous.clone(),
                        std::mem::take(&mut bucket),
                        limit,
                    ) {
                        hit = true;
                        last = Some(vec![previous]);
                        break;
                    }
                    last = Some(vec![previous]);
                }
                current = Some(project.clone());
                bucket = tasks_for(conn, &project, &schedules)?;
            }
        }
        if !hit {
            if let Some(project) = current {
                if flush(&mut page, project.clone(), bucket, limit) {
                    hit = true;
                }
                last = Some(vec![project]);
            }
        }
        Ok((page, !hit, last))
    });
    match outcome {
        Ok((page, complete, last)) => finish(ctx, "projects", page, complete, last, &digest),
        Err(refusal) => refusal,
    }
}

fn tasks_for(
    conn: &rusqlite::Connection,
    project: &str,
    schedules: &Map<String, Value>,
) -> rusqlite::Result<Vec<Value>> {
    let mut statement = prepare(
        conn,
        "SELECT task, schedule, last_run_at, next_due_at, last_status, last_error, retry_count FROM task_schedule_state WHERE project_path = ?1",
    )?;
    let rows = statement.query_map([project], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, Option<i64>>(2)?,
            row.get::<_, Option<i64>>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, Option<String>>(5)?,
            row.get::<_, i64>(6)?,
        ))
    })?;
    let stored: std::collections::HashMap<_, _> = rows
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .map(|row| (row.0.clone(), row))
        .collect();
    Ok(TASKS
        .iter()
        .map(|task| {
            let effective = schedules
                .get(*task)
                .and_then(Value::as_str)
                .unwrap_or_else(|| default_schedule(task))
                .to_string();
            let row = stored.get(*task);
            let next_due = row.and_then(|row| {
                if row.1.as_deref() == Some(effective.as_str()) {
                    row.3
                } else {
                    None
                }
            });
            json!({
                "task": task,
                "schedule": effective,
                "last_run_at_ms": row.and_then(|row| row.2),
                "next_due_at_ms": next_due,
                "last_status": row.and_then(|row| row.4.clone()),
                "last_error": row.and_then(|row| row.5.clone()),
                "retry_count": row.map(|row| row.6).unwrap_or(0),
            })
        })
        .collect())
}

const PROJECTS_SQL: &str = "SELECT DISTINCT project_path FROM task_schedule_state WHERE (?1 IS NULL OR project_path > ?1) ORDER BY project_path ASC";

fn runs(ctx: &AppReadContext, params: &Map<String, Value>) -> HandlerOutcome {
    let project = match opt_str(params, "project", "params") {
        Ok(project) => project,
        Err(refusal) => return refusal,
    };
    let limit = match page_limit(params, 20, 50, "params.limit") {
        Ok(limit) => limit,
        Err(refusal) => return refusal,
    };
    let digest = digest_of(&[("project", &json!(project))]);
    let cursor = match decode_cursor(
        params.get("cursor").and_then(Value::as_str),
        OP,
        "runs",
        &digest,
        ctx.now_ms(),
        None,
    ) {
        Ok(cursor) => cursor,
        Err(refusal) => return refusal,
    };
    let finished = cursor
        .as_ref()
        .and_then(|cursor| cursor.keys.first())
        .and_then(|value| value.parse::<i64>().ok());
    let id = cursor
        .as_ref()
        .and_then(|cursor| cursor.keys.get(1))
        .and_then(|value| value.parse::<i64>().ok());
    let Some(project) = project else {
        return invalid("params.project", "combination");
    };
    let started = Instant::now();
    let outcome = ctx.context(|conn| {
        ctx.note_sql(RUNS_SQL);
        let mut statement = prepare(conn, RUNS_SQL)?;
        let mut rows = statement.query(params![project, finished, id])?;
        let mut page = Page::new(ctx.row_budget());
        let mut last = None;
        let mut hit = false;
        while let Some(row) = rows.next()? {
            if ctx.expired(started) {
                hit = true;
                break;
            }
            let run_id: i64 = row.get(0)?;
            let finished_at: i64 = row.get(3)?;
            let started_at: i64 = row.get(2)?;
            let parent: Option<String> = row.get(8)?;
            let tasks: String = row.get(5)?;
            let (tasks, truncated, bytes) = cut_text(&tasks, 32 * 1024);
            ctx.note_sql(RUN_TOKENS_SQL);
            let mut tokens = prepare(conn, RUN_TOKENS_SQL)?;
            let token_rows = tokens.query_map(
                params!["dreamer", started_at, finished_at, parent],
                |token| {
                    Ok(json!({
                        "task": token.get::<_, Option<String>>(0)?,
                        "input_tokens": token.get::<_, i64>(1)?,
                        "output_tokens": token.get::<_, i64>(2)?,
                        "cache_read_tokens": token.get::<_, i64>(3)?,
                        "cache_write_tokens": token.get::<_, i64>(4)?,
                    }))
                },
            )?;
            let value = json!({
                "run_id": run_id,
                "project": row.get::<_, String>(1)?,
                "started_at_ms": started_at,
                "finished_at_ms": finished_at,
                "holder_id": row.get::<_, String>(4)?,
                "tasks": tasks,
                "tasks_truncated": truncated,
                "tasks_bytes": bytes,
                "tasks_succeeded": row.get::<_, i64>(6)?,
                "tasks_failed": row.get::<_, i64>(7)?,
                "parent_session_id": parent,
                "token_totals": token_rows.collect::<Result<Vec<_>, _>>()?,
            });
            if page.len() >= limit || !page.try_push(value) {
                hit = true;
                break;
            }
            last = Some(vec![finished_at.to_string(), run_id.to_string()]);
        }
        Ok((page, !hit, last))
    });
    match outcome {
        Ok((page, complete, last)) => finish(ctx, "runs", page, complete, last, &digest),
        Err(refusal) => refusal,
    }
}

const RUNS_SQL: &str = "SELECT id, project_path, started_at, finished_at, holder_id, tasks_json, tasks_succeeded, tasks_failed, parent_session_id \
     FROM dream_runs WHERE project_path = ?1 \
       AND (?2 IS NULL OR finished_at < ?2 OR (finished_at = ?2 AND id < ?3)) \
     ORDER BY finished_at DESC, id DESC";
const RUN_TOKENS_SQL: &str =
    "SELECT task, COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0), \
     COALESCE(SUM(cache_read_tokens), 0), COALESCE(SUM(cache_write_tokens), 0) \
     FROM subagent_invocations WHERE subagent = ?1 AND started_at >= ?2 AND started_at <= ?3 \
       AND (?4 IS NULL OR session_id = ?4) GROUP BY task";

fn run_changes(ctx: &AppReadContext, params: &Map<String, Value>) -> HandlerOutcome {
    let run_id = match opt_i64(params, "run_id", "params") {
        Ok(Some(id)) => id,
        Ok(None) => return invalid("params.run_id", "type"),
        Err(refusal) => return refusal,
    };
    let limit = match page_limit(params, 200, 200, "params.limit") {
        Ok(limit) => limit,
        Err(refusal) => return refusal,
    };
    let digest = digest_of(&[("run_id", &json!(run_id))]);
    let cursor = match decode_cursor(
        params.get("cursor").and_then(Value::as_str),
        OP,
        "run_changes",
        &digest,
        ctx.now_ms(),
        None,
    ) {
        Ok(cursor) => cursor,
        Err(refusal) => return refusal,
    };
    let after = cursor
        .and_then(|cursor| cursor.keys.into_iter().next())
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    let started = Instant::now();
    let outcome = ctx.context(|conn| {
        ctx.note_sql(RUN_CHANGES_SQL);
        let found = conn
            .query_row(RUN_CHANGES_SQL, [run_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })
            .optional()?;
        let Some((project, started_at, finished_at, changes)) = found else {
            return Ok(None);
        };
        let (changes, reconstructed) = match changes.as_deref().and_then(parse_changes) {
            Some(changes) => (changes, false),
            None => (reconstruct(conn, &project, started_at, finished_at)?, true),
        };
        Ok(Some((changes, reconstructed)))
    });
    let (changes, reconstructed) = match outcome {
        Ok(Some(row)) => row,
        Ok(None) => return named("dream_run_not_found", "No dream run has that id."),
        Err(refusal) => return refusal,
    };
    let mut page = Page::new(ctx.row_budget());
    let mut next_index = None;
    for (index, change) in changes.into_iter().enumerate().skip(after) {
        if ctx.expired(started) || page.len() >= limit || !page.try_push(change) {
            next_index = Some(index);
            break;
        }
    }
    let complete = next_index.is_none();
    let cursor = next_index.and_then(|index| {
        encode_cursor(OP, "run_changes", &digest, &[index.to_string()], None).ok()
    });
    let mut reply = list_reply(
        OP,
        "run_changes",
        ctx.now_ms(),
        None,
        complete,
        page.rows(),
        cursor,
    );
    if let HandlerOutcome::Response(bytes) = &mut reply {
        if let Ok(mut value) = serde_json::from_slice::<Value>(bytes) {
            value["reconstructed"] = json!(reconstructed);
            *bytes = serde_json::to_vec(&value).unwrap_or_default();
        }
    }
    reply
}

const RUN_CHANGES_SQL: &str = "SELECT project_path, started_at, finished_at, memory_changes_json FROM dream_runs WHERE id = ?1";

fn parse_changes(raw: &str) -> Option<Vec<Value>> {
    let value: Value = serde_json::from_str(raw).ok()?;
    if value.get("writtenIds").is_none()
        && value.get("archivedIds").is_none()
        && value.get("mergedIds").is_none()
    {
        return None;
    }
    let mut changes = Vec::new();
    for (kind, key) in [
        ("written", "writtenIds"),
        ("archived", "archivedIds"),
        ("merged", "mergedIds"),
    ] {
        if let Some(ids) = value.get(key).and_then(Value::as_array) {
            for id in ids {
                changes.push(json!({"change": kind, "id": id, "category": null, "content": null, "status": null}));
            }
        }
    }
    Some(changes)
}

fn reconstruct(
    conn: &rusqlite::Connection,
    project: &str,
    started_at: i64,
    finished_at: i64,
) -> rusqlite::Result<Vec<Value>> {
    let mut statement = prepare(
        conn,
        "SELECT id, category, content, status, created_at, updated_at, superseded_by_memory_id FROM memories WHERE project_path = ?1 AND status >= '' AND ((created_at >= ?2 AND created_at <= ?3) OR (updated_at >= ?2 AND updated_at <= ?3))",
    )?;
    let rows = statement.query_map(params![project, started_at, finished_at], |row| {
        let created: i64 = row.get(4)?;
        let updated: i64 = row.get(5)?;
        let superseded: Option<i64> = row.get(6)?;
        let status: String = row.get(3)?;
        let kind = if superseded.is_some() && updated >= started_at && updated <= finished_at {
            "merged"
        } else if status == "archived" && updated >= started_at && updated <= finished_at {
            "archived"
        } else if created >= started_at && created <= finished_at {
            "written"
        } else {
            ""
        };
        let content: String = row.get(2)?;
        let (text, truncated, bytes) = cut_text(&content, 4 * 1024);
        Ok(json!({
            "change": kind,
            "id": row.get::<_, i64>(0)?,
            "category": row.get::<_, String>(1)?,
            "content": text,
            "content_truncated": truncated,
            "content_bytes": bytes,
            "status": status,
        }))
    })?;
    rows.filter(|row| {
        row.as_ref()
            .map(|value| value["change"] != "")
            .unwrap_or(true)
    })
    .collect()
}

fn finish(
    ctx: &AppReadContext,
    section: &str,
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
    list_reply(OP, section, ctx.now_ms(), None, complete, page.rows(), next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_read::tests_support::{apply_sql, explain, open_store, response};

    fn ready(dir: &std::path::Path) -> (AppReadContext, std::path::PathBuf) {
        let store = open_store(dir);
        (
            AppReadContext::for_test(store, 1_700_000_000_000),
            dir.join("context.db"),
        )
    }

    fn caller() -> AppCaller {
        crate::app_read::tests_support::caller()
    }

    #[test]
    fn schedule_pages_on_the_primary_key_and_the_cursor_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let (ctx, db) = ready(dir.path());
        apply_sql(
            &db,
            "INSERT INTO task_schedule_state(project_path, task, schedule) VALUES
             ('git:a', 'curate', '0 4 * * 0'),
             ('git:a', 'verify', '0 3 * * *'),
             ('git:b', 'verify', '0 3 * * *');",
        );
        let params = json!({"section": "schedule", "limit": 2});
        let first = response(&read(&caller(), &ctx, params.as_object().unwrap()));
        assert_eq!(first["rows"].as_array().unwrap().len(), 2);
        assert_eq!(first["complete"], false);
        let mut next = params.clone();
        next["cursor"] = first["next_cursor"].clone();
        let second = response(&read(&caller(), &ctx, next.as_object().unwrap()));
        assert_eq!(second["rows"][0]["project_path"], "git:b");
        let plan = explain(&db, SCHEDULE_SQL);
        assert!(
            plan.contains("SEARCH") || plan.contains("USING INDEX") || plan.contains("PRIMARY KEY"),
            "{plan}"
        );
        assert!(!plan.contains("SCAN task_schedule_state"), "{plan}");
    }

    #[test]
    fn unknown_section_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let (ctx, _) = ready(dir.path());
        let outcome = read(
            &caller(),
            &ctx,
            json!({"section": "nope"}).as_object().unwrap(),
        );
        assert_eq!(
            crate::app_read::tests_support::detail_field(&outcome)["field"],
            "params.section"
        );
    }

    #[test]
    fn runs_use_the_project_index() {
        let dir = tempfile::tempdir().unwrap();
        let (ctx, db) = ready(dir.path());
        apply_sql(
            &db,
            "INSERT INTO dream_runs(project_path, started_at, finished_at, holder_id, tasks_json)
             VALUES ('git:a', 1, 10, 'h', '[]'), ('git:a', 2, 20, 'h', '[]');",
        );
        let reply = response(&read(
            &caller(),
            &ctx,
            json!({"section": "runs", "project": "git:a", "limit": 1})
                .as_object()
                .unwrap(),
        ));
        assert_eq!(reply["rows"][0]["finished_at_ms"], 20);
        assert_eq!(reply["complete"], false);
        let plan = explain(&db, RUNS_SQL);
        assert!(plan.contains("idx_dream_runs_project"), "{plan}");
    }
}
