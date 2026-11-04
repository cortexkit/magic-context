//! Bounded project upkeep for the module's own session-history vectors.

use super::*;
use crate::chunk_embedding::{self, FtsRow, Window};

const COMPARTMENTS_PER_RUN: i64 = 10;
const VECTOR_BATCH: usize = 16;

#[derive(Debug, PartialEq, Eq)]
struct Source {
    id: i64,
    harness: String,
    session: String,
    start: i64,
    end: i64,
    title: String,
    p1: String,
    content: String,
    rows: Vec<FtsRow>,
}

fn source(conn: &Connection, id: i64) -> rusqlite::Result<Option<Source>> {
    let mut source = conn
        .query_row(
            "SELECT id, harness, session_id, start_message, end_message, title,
                COALESCE(p1, ''), content FROM compartments WHERE id = ?1",
            [id],
            |row| {
                Ok(Source {
                    id: row.get(0)?,
                    harness: row.get(1)?,
                    session: row.get(2)?,
                    start: row.get(3)?,
                    end: row.get(4)?,
                    title: row.get(5)?,
                    p1: row.get(6)?,
                    content: row.get(7)?,
                    rows: Vec::new(),
                })
            },
        )
        .optional()?;
    if let Some(source) = &mut source {
        if !mapped(conn, &source.session, source.start, source.end)? {
            return Ok(None);
        }
        let mut statement = conn.prepare_cached(
            "SELECT map.message_ordinal, fts.role, fts.content
             FROM message_fts_rowid_map AS map CROSS JOIN message_history_fts AS fts
               ON fts.rowid = map.fts_rowid
             WHERE map.session_id = ?1 AND map.message_ordinal BETWEEN ?2 AND ?3
               AND fts.role IN ('user', 'assistant') ORDER BY map.message_ordinal ASC",
        )?;
        source.rows = statement
            .query_map(params![source.session, source.start, source.end], |row| {
                Ok(FtsRow {
                    ordinal: row.get(0)?,
                    role: row.get(1)?,
                    content: row.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
    }
    Ok(source)
}

fn mapped(conn: &Connection, session: &str, start: i64, end: i64) -> rusqlite::Result<bool> {
    if end < start {
        return Ok(true);
    }
    let complete: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM message_fts_rowid_map_backfill_state WHERE id = 1 AND completed = 1)",
        [], |row| row.get(0),
    )?;
    if complete {
        return Ok(true);
    }
    let empty_hash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    let (count, expected, mapped): (i64, i64, i64) = conn.query_row(
        "SELECT COUNT(DISTINCT source.message_ordinal),
                COUNT(DISTINCT CASE WHEN source.role IN ('user', 'assistant') AND source.normalized_content_hash != ?1 THEN source.message_ordinal END),
                COUNT(DISTINCT CASE WHEN source.role IN ('user', 'assistant') AND source.normalized_content_hash != ?1 AND map.fts_rowid IS NOT NULL THEN source.message_ordinal END)
         FROM message_history_source source LEFT JOIN message_fts_rowid_map map
           ON map.session_id = source.session_id AND map.message_ordinal = source.message_ordinal
         WHERE source.session_id = ?2 AND source.message_ordinal BETWEEN ?3 AND ?4",
        params![empty_hash, session, start, end], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    Ok(count == end - start + 1 && expected == mapped)
}

fn current(
    conn: &Connection,
    source: &Source,
    project: &str,
    model: &str,
    windows: &[Window],
) -> rusqlite::Result<bool> {
    let mut statement = conn.prepare_cached(
        "SELECT window_index, chunk_hash FROM compartment_chunk_embeddings
         WHERE compartment_id = ?1 AND model_id = ?2 AND project_path = ?3 ORDER BY window_index",
    )?;
    let rows = statement
        .query_map(params![source.id, model, project], |row| {
            Ok((row.get::<_, usize>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows.len() == windows.len()
        && rows
            .iter()
            .zip(windows)
            .all(|((index, hash), w)| *index == w.window_index && hash == &w.chunk_hash))
}

pub(super) async fn embed(
    db: &ContextDb,
    project: &str,
    provider: &Provider,
    clock: &(impl Fn() -> i64 + Sync),
    owned: &(impl Fn() -> Vec<(String, String)> + Sync),
) -> usize {
    let scope = owned();
    if scope.is_empty() {
        return 0;
    }
    let cursor_key = format!("ck_mc_chunk_cursor:{project}");
    let candidates = db.with_connection(|conn| -> rusqlite::Result<Vec<i64>> {
        let cursor: i64 = conn.query_row("SELECT CAST(value AS INTEGER) FROM schema_migrations_meta WHERE key = ?1", [&cursor_key], |r| r.get(0)).optional()?.unwrap_or(0);
        let scope = serde_json::to_string(&scope).expect("session scope serializes");
        let mut statement = conn.prepare_cached(
            "SELECT c.id FROM compartments c WHERE c.id > ?1 AND EXISTS (
                SELECT 1 FROM json_each(?2) scope WHERE c.harness = json_extract(scope.value, '$[0]')
                AND c.session_id = json_extract(scope.value, '$[1]')) ORDER BY c.id LIMIT ?3",
        )?;
        let mut ids = statement.query_map(params![cursor, scope, COMPARTMENTS_PER_RUN], |r| r.get(0))?.collect::<rusqlite::Result<Vec<i64>>>()?;
        if ids.is_empty() && cursor != 0 {
            ids = statement.query_map(params![0, scope, COMPARTMENTS_PER_RUN], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        }
        Ok(ids)
    });
    let Ok(candidates) = candidates else {
        return 0;
    };
    let model = provider.chunk_model_id();
    let deadline = Instant::now() + COMMIT_DRAIN_DEADLINE;
    let mut saved = 0;
    for id in candidates {
        if Instant::now() >= deadline {
            break;
        }
        // Rotate even past current or not-yet-mapped compartments, so an old
        // unmapped span cannot starve newer summaries or later repairs.
        let _ = db.with_connection(|conn| conn.execute(
            "INSERT INTO schema_migrations_meta(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![cursor_key, id.to_string()],
        ));
        let read = db.with_connection(|conn| source(conn, id));
        let Ok(Some(snapshot)) = read else {
            continue;
        };
        let raw = chunk_embedding::canonical_text(&snapshot.rows);
        let text = if raw.is_empty() {
            chunk_embedding::summary_fallback(&snapshot.title, &snapshot.p1, &snapshot.content)
        } else {
            raw
        };
        let Some(windows) = chunk_embedding::windows(
            &text,
            snapshot.start,
            snapshot.end,
            provider.chunk_max_input_tokens(),
        ) else {
            continue;
        };
        if !windows.is_empty()
            && !db
                .with_connection(|conn| current(conn, &snapshot, project, &model, &windows))
                .unwrap_or(true)
        {
            let mut vectors = Vec::new();
            for batch in windows.chunks(VECTOR_BATCH) {
                if Instant::now() >= deadline
                    || !owned().contains(&(snapshot.harness.clone(), snapshot.session.clone()))
                {
                    break;
                }
                let texts = batch.iter().map(|w| w.text.clone()).collect::<Vec<_>>();
                let Some(batch) = provider.embed_documents(&texts).await else {
                    break;
                };
                let Some(batch) = batch.into_iter().collect::<Option<Vec<_>>>() else {
                    break;
                };
                vectors.extend(batch);
            }
            if vectors.len() != windows.len() {
                break;
            }
            match save(
                db,
                project,
                &model,
                &snapshot,
                &windows,
                &vectors,
                clock(),
                owned,
            ) {
                Ok(count) => saved += count,
                Err(error) => {
                    tracing::warn!(
                        "ck-mc: upkeep could not save history vectors for {project}: {error}"
                    );
                    break;
                }
            }
        }
    }
    saved
}

#[allow(clippy::too_many_arguments)]
fn save(
    db: &ContextDb,
    project: &str,
    model: &str,
    snapshot: &Source,
    windows: &[Window],
    vectors: &[Vec<f32>],
    now: i64,
    owned: &(impl Fn() -> Vec<(String, String)> + Sync),
) -> rusqlite::Result<usize> {
    // Each transaction writes at most one request's worth of rows. No HTTP or
    // tokenization runs under the write lock. An interrupted replacement has a
    // different window count or hash set and is repaired by the next upkeep pass.
    let valid = |conn: &Connection| -> rusqlite::Result<bool> {
        Ok(
            owned().contains(&(snapshot.harness.clone(), snapshot.session.clone()))
                && source(conn, snapshot.id)?.as_ref() == Some(snapshot),
        )
    };
    for (batch, vectors) in windows
        .chunks(VECTOR_BATCH)
        .zip(vectors.chunks(VECTOR_BATCH))
    {
        let written = db.with_connection(|conn| -> rusqlite::Result<bool> {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if !valid(&tx)? {
                return Ok(false);
            }
            if batch[0].window_index == 0 && current(&tx, snapshot, project, model, windows)? {
                return Ok(false);
            }
            tx.execute(
                "DELETE FROM compartment_chunk_embeddings WHERE compartment_id = ?1 AND model_id = ?2
                   AND window_index BETWEEN ?3 AND ?4",
                params![snapshot.id, model, batch[0].window_index as i64, batch.last().unwrap().window_index as i64],
            )?;
            let blobs: Vec<_> = vectors.iter().map(|v| encode(v)).collect();
            for ((w, vector), blob) in batch.iter().zip(vectors).zip(blobs) {
                tx.execute(
                    "INSERT INTO compartment_chunk_embeddings
                     (compartment_id, session_id, project_path, harness, window_index, start_ordinal, end_ordinal, chunk_hash, model_id, dims, vector, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                    params![snapshot.id, snapshot.session, project, snapshot.harness, w.window_index as i64,
                        w.start_ordinal, w.end_ordinal, w.chunk_hash, model, vector.len() as i64, blob, now],
                )?;
            }
            tx.commit()?;
            Ok(true)
        })?;
        if !written {
            return Ok(0);
        }
    }
    loop {
        let deleted = db.with_connection(|conn| -> rusqlite::Result<Option<usize>> {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if !valid(&tx)? { return Ok(None); }
            let count = tx.execute(
                "DELETE FROM compartment_chunk_embeddings WHERE id IN (
                   SELECT id FROM compartment_chunk_embeddings WHERE compartment_id = ?1 AND model_id = ?2
                     AND window_index >= ?3 LIMIT ?4)",
                params![snapshot.id, model, windows.len() as i64, VECTOR_BATCH as i64],
            )?;
            tx.commit()?;
            Ok(Some(count))
        })?;
        match deleted {
            Some(VECTOR_BATCH) => continue,
            Some(_) => return Ok(windows.len()),
            None => return Ok(0),
        }
    }
}

#[cfg(test)]
mod tests;
