//! A runner move keeps the source's durable view available for rollback, but
//! reuses none of its cached edits: destination part identities are different.

use super::*;
use crate::move_batches::{self, Plan};
use crate::move_renumber::Numbering;
use serde_json::{json, Value};

pub(super) fn move_in(
    db: ContextDb,
    store: &Store,
    config: &Config,
    request: &MoveRequest,
) -> Result<Moved, String> {
    let target = &request.session;
    let source = request.source_harness.as_deref().unwrap_or(&target.harness);
    let session_id = request.source_session.as_deref().unwrap_or(&target.session);
    let features = preset::features(&request.preset)
        .ok_or_else(|| format!("unknown preset `{}`", request.preset))?;
    let messages = request
        .messages
        .as_deref()
        .ok_or("invalid_messages: runner moves require messages with source_entry")?;
    let numbering = Numbering::runner(messages, &request.newest)?;
    let progress_key = format!("mode3_runner_move:{source}:{session_id}");
    let from_fence = fence_key(source, session_id);
    let to_fence = fence_key(&target.harness, &target.session);
    let progress = db.with_connection(|conn| {
        check_fences(conn, &from_fence, &to_fence, source, session_id)?;
        if let Some(record) = move_batches::record(conn, &progress_key)? {
            if record["checksum"] != numbering.checksum()
                || record["target"] != serde_json::to_value(target).map_err(|e| e.to_string())? {
                return Err("renumber_conflict: source runner already has a move with a different transcript or destination".into());
            }
            crate::move_renumber::check_plan_endpoints(conn, &record, &numbering, source, session_id, Some((&target.harness, &target.session)))?;
            if move_batches::resume(conn, &progress_key)? {
                return Ok(record);
            }
        }
        if store.has_rows(target).map_err(|e|format!("state_read_failed: {e}"))? {
            return Err("target_exists: destination already has runner state".into());
        }
        let plan = Plan::default();
        // Validate every coordinate and destination before staging the first
        // batch, so named refusals leave both databases unchanged.
        let mut record = crate::move_renumber::plan_renumber(conn, source, session_id, &numbering, &plan, Some((&target.harness, &target.session)))?;
        plan_rekey(conn, &plan, source, session_id, &target.harness, &target.session)?;
        let last: Option<i64> = conn.query_row(
            "SELECT end_message FROM compartments WHERE session_id=?1 AND harness=?2 ORDER BY sequence DESC LIMIT 1",
            params![session_id, source], |row| row.get(0),
        ).optional().map_err(|e| e.to_string())?;
        record["cut"] = json!(last.and_then(|end| numbering.cut(end)));
        record["target"] = serde_json::to_value(target).map_err(|e| e.to_string())?;
        plan.stage(conn, &progress_key, record.clone())?;
        Ok::<_, String>(record)
    })?;

    let setup = SetupRequest::new(
        request.preset.clone(),
        request.model.clone(),
        request.context_window,
        request.output_reserve,
        request.rules.clone(),
        Vec::new(),
        request.now,
    )
    .with_newest(request.newest.clone());
    let route = Route {
        session: target.clone(),
        project: request.project.clone(),
        workdir: request.project.as_ref().map(|p| p.root.clone()),
        agent_id: None,
    };
    let db = Arc::new(db);
    let mut session = Session::new(&route, &setup, features, Some(Arc::clone(&db)));
    session.load_summaries();
    let settings = config.resolve(
        request.project.as_ref().map(|p| p.root.as_str()),
        &format!("{}/{}", request.model.provider, request.model.model),
        request
            .context_window
            .saturating_sub(request.output_reserve),
    );
    let cut: Option<(u64, String)> =
        serde_json::from_value(progress["cut"].clone()).map_err(|e| e.to_string())?;
    let view = session
        .first_view_after_move(&settings, cut.as_ref().map(|(n, mid)| (*n, mid.as_str())))?;
    let cut_mid = view.edits.iter().find_map(|edit| match &edit.op {
        cortexkit_role_compaction::view::EditOp::Cut { through } => Some(through.as_str()),
        _ => None,
    });
    let tag_checkpoint = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT COALESCE(MAX(tag_number),0) FROM tags WHERE session_id=?1 AND harness=?2",
                params![target.session, target.harness],
                |row| row.get::<_, i64>(0),
            )
            .map(|n| n.max(0) as u64)
            .map_err(|e| e.to_string())
        })?
        .max(request.tag_floor.unwrap_or(0));
    // Save only the destination key. Source views, pending requests to drop
    // parts and tag state remain untouched so a rollback can restore them.
    store
        .save(target, &session.durable())
        .map_err(|e| format!("state_save_failed: {e}"))?;
    let fence = json!({
        "version": 3, "session": target.session, "harness": target.harness,
        "runner": target.runner, "state": "moved", "source_runner_entries": true,
        "source_harness": source, "source_session": session_id,
        "tag_checkpoint": tag_checkpoint, "cut": cut_mid,
        "view_version": view.version, "view_checksum": view.checksum, "moved_at": request.now,
    });
    db.with_connection(|conn| {
        // The original plugin fence is deliberately not removed. Updating the
        // source-runner fence records its outgoing move and prevents a repeat.
        check_fences(conn, &from_fence, &to_fence, source, session_id)?;
        verify_source(
            conn,
            source,
            session_id,
            &target.harness,
            &target.session,
            &progress,
        )?;
        move_batches::transaction(conn, "fence", |tx| {
            for key in [&from_fence, &to_fence] {
                tx.execute(
                    "INSERT OR REPLACE INTO schema_migrations_meta(key,value) VALUES (?1,?2)",
                    params![key, fence.to_string()],
                )
                .map_err(|e| e.to_string())?;
            }
            Ok(())
        })
    })?;
    Ok(Moved {
        view,
        tag_checkpoint,
        warnings: Vec::new(),
        source_state_kept: Some(true),
    })
}

/// Include tables without a harness (such as the FTS rowid map) and cited
/// fact/publication rows, which use source_session_id instead of session_id.
fn tables(conn: &Connection) -> Result<Vec<(String, String, bool)>, String> {
    conn.prepare("SELECT m.name, p.name,
        EXISTS(SELECT 1 FROM pragma_table_info(m.name) WHERE name='harness')
        FROM sqlite_master m JOIN pragma_table_info(m.name) p
        WHERE m.type='table' AND p.name IN ('session_id','source_session_id') ORDER BY m.name,p.name")
        .and_then(|mut s| s.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect())
        .map_err(|e| e.to_string())
}

fn plan_rekey(
    conn: &Connection,
    plan: &Plan,
    from: &str,
    source: &str,
    to: &str,
    target: &str,
) -> Result<(), String> {
    for (table, column, harness) in tables(conn)? {
        if !harness && source == target {
            continue;
        }
        let quoted = move_batches::quoted(&table);
        let target_filter = if harness {
            format!("{column}=?1 AND harness=?2")
        } else {
            format!("{column}=?1 AND ?2 IS NOT NULL")
        };
        let exists: bool = conn
            .query_row(
                &format!("SELECT EXISTS(SELECT 1 FROM {quoted} WHERE {target_filter})"),
                params![target, to],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if exists {
            return Err(format!(
                "target_exists: {table} already holds rows under {to}/{target}"
            ));
        }
        // These tables are deleted and rebuilt by renumbering, so their new
        // rows already use the destination key. Old rowids cannot re-key them.
        if matches!(
            table.as_str(),
            "compression_depth"
                | "message_fts_rowid_map"
                | "session_meta"
                | "compartment_history_versions"
        ) {
            continue;
        }
        let without_rowid: bool = conn
            .query_row(
                "SELECT wr FROM pragma_table_list WHERE name=?1",
                params![table],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if without_rowid {
            plan_keyed_table(
                conn,
                plan,
                &table,
                &column,
                harness,
                (from, source),
                (to, target),
            )?;
            continue;
        }
        let rows: Vec<i64> = if harness {
            move_batches::harness_rows(conn, &table, source)?
                .into_iter()
                .filter_map(|(id, h)| (h == from).then_some(id))
                .collect()
        } else {
            conn.prepare(&format!("SELECT rowid FROM {quoted} WHERE {column}=?1"))
                .and_then(|mut s| s.query_map(params![source], |r| r.get(0))?.collect())
                .map_err(|e| e.to_string())?
        };
        plan.phase(&format!("rekey/{table}"));
        for id in rows {
            if harness {
                plan.execute(
                    &format!("UPDATE {quoted} SET {column}=?1,harness=?2 WHERE rowid=?3"),
                    params![target, to, id],
                )
            } else {
                plan.execute(
                    &format!("UPDATE {quoted} SET {column}=?1 WHERE rowid=?2"),
                    params![target, id],
                )
            }
            .map_err(|e| e.to_string())?;
        }
    }
    // Summary and tag updates can create or advance these singleton rows.
    // Move them last, after those triggers have run, including a row that did
    // not exist during discovery. Destination rows here can only be generated
    // by our updates: the preflight above rejected any pre-existing target.
    plan.phase("rekey/trigger_metadata");
    if source != target {
        for table in ["compartment_history_versions", "session_meta"] {
            plan.execute(&format!("DELETE FROM {table} WHERE session_id=?1 AND EXISTS(SELECT 1 FROM {table} WHERE session_id=?2)"),params![target,source]).map_err(|e|e.to_string())?;
            let harness = if table == "session_meta" {
                ",harness=?3"
            } else {
                ""
            };
            let sql = format!("UPDATE {table} SET session_id=?1{harness} WHERE session_id=?2");
            if table == "session_meta" {
                plan.execute(&sql, params![target, source, to])
            } else {
                plan.execute(&sql, params![target, source])
            }
            .map_err(|e| e.to_string())?;
        }
    } else {
        plan.execute(
            "UPDATE session_meta SET harness=?1 WHERE session_id=?2",
            params![to, target],
        )
        .map_err(|e| e.to_string())?;
    }
    let skipped: Vec<String> = conn
        .prepare("SELECT key FROM schema_migrations_meta WHERE key LIKE 'message_index_skip:%'")
        .and_then(|mut s| s.query_map([], |r| r.get(0))?.collect())
        .map_err(|e| e.to_string())?;
    for key in skipped {
        if let Some(Ok(Value::Array(names))) = key
            .strip_prefix("message_index_skip:")
            .map(serde_json::from_str::<Value>)
        {
            if source != target && names.first().and_then(Value::as_str) == Some(target) {
                return Err("target_exists: destination has skipped search rows".into());
            }
        }
    }
    for table in ["user_memories", "primers"] {
        let rows: Vec<String> = conn.prepare(&format!("SELECT source_candidate_provenance FROM {table} WHERE source_candidate_provenance LIKE '%' || ?1 || '%'"))
            .and_then(|mut s|s.query_map(params![target],|r|r.get(0))?.collect()).map_err(|e|e.to_string())?;
        for text in rows {
            let Ok(Value::Array(sources)) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            if sources.iter().any(|row| {
                row["session_id"].as_str() == Some(target)
                    && row
                        .get("harness")
                        .and_then(Value::as_str)
                        .map_or(source != target, |h| h == to)
            }) {
                return Err(format!(
                    "target_exists: {table} already cites the destination"
                ));
            }
        }
    }
    Ok(())
}

fn plan_keyed_table(
    conn: &Connection,
    plan: &Plan,
    table: &str,
    column: &str,
    harness: bool,
    source: (&str, &str),
    target: (&str, &str),
) -> Result<(), String> {
    let keys: Vec<String> = conn
        .prepare("SELECT name FROM pragma_table_info(?1) WHERE pk>0 ORDER BY pk")
        .and_then(|mut s| s.query_map(params![table], |r| r.get(0))?.collect())
        .map_err(|e| e.to_string())?;
    let filter = if harness {
        format!("{column}=?1 AND harness=?2")
    } else {
        format!("{column}=?1 AND ?2 IS NOT NULL")
    };
    let quoted = move_batches::quoted(table);
    let names = keys
        .iter()
        .map(|key| move_batches::quoted(key))
        .collect::<Vec<_>>()
        .join(",");
    let rows: Vec<Vec<rusqlite::types::Value>> = conn
        .prepare(&format!("SELECT {names} FROM {quoted} WHERE {filter}"))
        .and_then(|mut s| {
            s.query_map(params![source.1, source.0], |r| {
                (0..keys.len()).map(|i| r.get(i)).collect()
            })?
            .collect()
        })
        .map_err(|e| e.to_string())?;
    let offset = if harness { 3 } else { 2 };
    let predicates = keys
        .iter()
        .enumerate()
        .map(|(i, key)| format!("{}=?{}", move_batches::quoted(key), offset + i))
        .collect::<Vec<_>>()
        .join(" AND ");
    let update = if harness {
        format!("{column}=?1,harness=?2")
    } else {
        format!("{column}=?1")
    };
    plan.phase(&format!("rekey/{table}"));
    for row in rows {
        let mut args = vec![rusqlite::types::Value::Text(target.1.into())];
        if harness {
            args.push(rusqlite::types::Value::Text(target.0.into()));
        }
        args.extend(row);
        let bound: Vec<&dyn rusqlite::ToSql> =
            args.iter().map(|v| v as &dyn rusqlite::ToSql).collect();
        plan.execute(
            &format!("UPDATE {quoted} SET {update} WHERE {predicates}"),
            &bound,
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn verify_source(
    conn: &Connection,
    from: &str,
    source: &str,
    to: &str,
    target: &str,
    progress: &Value,
) -> Result<(), String> {
    for (table, column, harness) in tables(conn)? {
        if !harness && source == target {
            continue;
        }
        let filter = if harness {
            format!("{column}=?1 AND harness=?2")
        } else {
            format!("{column}=?1 AND ?2 IS NOT NULL")
        };
        let count: usize = conn
            .query_row(
                &format!(
                    "SELECT count(*) FROM {} WHERE {filter}",
                    move_batches::quoted(&table)
                ),
                params![source, from],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if count > 0 {
            return Err(source_changed(source, &table, count));
        }
    }
    let found: u64 = conn
        .query_row(
            "SELECT count(*) FROM message_history_source WHERE session_id=?1 AND harness=?2",
            params![target, to],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if progress["source_rows"]
        .as_u64()
        .is_some_and(|expected| expected != found)
    {
        return Err(source_changed(source, "message_history_source", 1));
    }
    let found = move_batches::message_rows(conn, target)
        .map_err(|e| e.to_string())?
        .len() as u64;
    if progress["search_rows"]
        .as_u64()
        .is_some_and(|expected| expected != found)
    {
        return Err(source_changed(source, "message_history_fts", 1));
    }
    Ok(())
}

fn check_fences(
    conn: &Connection,
    from: &str,
    to: &str,
    harness: &str,
    session: &str,
) -> Result<(), String> {
    let source = move_batches::record(conn, from)?;
    let incoming = source.as_ref().is_none_or(|record| {
        record["state"] == "moved"
            && record["harness"] == harness
            && record["session"] == session
            && record["source_runner_entries"] != true
    });
    if !incoming || move_batches::record(conn, to)?.is_some() {
        return Err(format!("session_already_moved: {session} already has an outgoing move or the destination was moved"));
    }
    Ok(())
}
