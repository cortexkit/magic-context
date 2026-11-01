//! Transaction boundaries and durable category progress for background curation.

use crate::{load_memory_full_tx, McStore, McStoreError, StoredMemoryFull};
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::Value;

#[derive(Debug)]
pub struct CurateMemory {
    pub memory: StoredMemoryFull,
    pub revision: i64,
    pub files: Vec<String>,
}

#[derive(Debug)]
pub struct CurateSnapshot {
    pub state: Option<String>,
    pub completed: Option<Value>,
    pub memories: Vec<CurateMemory>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum CurateEdit<T> {
    Applied(T),
    Stale(Vec<i64>),
}

fn done_key(run: &str) -> String {
    format!("rust:curate:done:{run}")
}

fn get(conn: &rusqlite::Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM dream_state WHERE key=?1", [key], |r| {
        r.get(0)
    })
    .optional()
}

fn set(tx: &Transaction<'_>, key: &str, value: &str) -> rusqlite::Result<()> {
    tx.execute("INSERT INTO dream_state(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key, value])?;
    Ok(())
}

/// An older memory action cannot decide how a future assessment combines across
/// sources. Refuse a merge rather than silently dropping opaque source data from
/// its canonical row. Capture full rows separately from the versioned canonical
/// undo snapshots, so this check still covers columns unknown to this binary.
fn require_lossless_merge_tx(
    tx: &Transaction<'_>,
    decision: &str,
    before: &[Value],
) -> rusqlite::Result<()> {
    let journal = tx.query_row("SELECT receipt_json FROM memory_journal WHERE decision_key=?1 AND operation='curate_merge'", [decision], |r| r.get::<_, String>(0)).optional()?;
    let Some(receipt) = journal else {
        return Ok(());
    };
    let parse =
        |raw: &str| serde_json::from_str::<Value>(raw).map_err(|_| rusqlite::Error::InvalidQuery);
    let receipt = parse(&receipt)?;
    let canonical = full_snapshot(
        tx,
        receipt["memoryId"]
            .as_i64()
            .ok_or(rusqlite::Error::InvalidQuery)?,
    )?;
    let canonical = canonical.as_object().ok_or(rusqlite::Error::InvalidQuery)?;
    let known = serde_json::to_value(StoredMemoryFull::default())
        .map_err(|_| rusqlite::Error::InvalidQuery)?;
    let compatible_metadata = |source: &Value, target: &Value| {
        if source.is_null() {
            return true;
        }
        match (
            source
                .as_str()
                .and_then(|v| serde_json::from_str::<Value>(v).ok()),
            target
                .as_str()
                .and_then(|v| serde_json::from_str::<Value>(v).ok()),
        ) {
            (Some(Value::Object(source)), Some(Value::Object(target))) => source
                .iter()
                .all(|(key, value)| value.is_null() || target.get(key) == Some(value)),
            (Some(Value::Object(source)), _) if source.is_empty() => true,
            _ => source == target,
        }
    };
    for source in before.iter().filter_map(Value::as_object) {
        for (column, value) in source {
            let understood = known.get(column).is_some()
                || matches!(
                    column.as_str(),
                    "revision" | "verify_result" | "verify_files_json" | "verify_commit"
                );
            let lost = if column == "metadata_json" {
                !compatible_metadata(value, canonical.get(column).unwrap_or(&Value::Null))
            } else {
                !understood && !value.is_null() && canonical.get(column) != Some(value)
            };
            if lost {
                return Err(rusqlite::Error::SqliteFailure(
                    rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT),
                    Some(format!(
                        "curate merge would discard opaque memory field {column}"
                    )),
                ));
            }
        }
    }
    Ok(())
}

fn full_snapshot(tx: &Transaction<'_>, id: i64) -> rusqlite::Result<Value> {
    let statement = tx.prepare("SELECT * FROM memories LIMIT 0")?;
    let fields = statement
        .column_names()
        .iter()
        .map(|name| {
            format!(
                "'{}',\"{}\"",
                name.replace('\'', "''"),
                name.replace('"', "\"\"")
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    let raw: Option<String> = tx
        .query_row(
            &format!("SELECT json_object({fields}) FROM memories WHERE id=?1"),
            [id],
            |r| r.get(0),
        )
        .optional()?;
    raw.map(|s| serde_json::from_str(&s).map_err(|_| rusqlite::Error::InvalidQuery))
        .transpose()
        .map(|v| v.unwrap_or(Value::Null))
}

impl McStore {
    /// Load content and revision heads from one snapshot. Only the owning project
    /// is visible here; workspace sharing is not a curation write permission.
    pub fn load_dream_curate(
        &self,
        project: &str,
        run: &str,
        now_ms: i64,
    ) -> Result<CurateSnapshot, McStoreError> {
        self.context_read(|conn| {
            let state = conn.query_row("SELECT last_checked_commit FROM task_schedule_state WHERE project_path=?1 AND task='curate'", [project], |r| r.get::<_, Option<String>>(0)).optional()?.flatten();
            let completed = get(conn, &done_key(run))?.map(|raw| serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)).transpose()?;
            let heads = conn.prepare("SELECT id,revision FROM memories WHERE project_path=?1 AND status IN ('active','permanent') AND (expires_at IS NULL OR expires_at>?2) ORDER BY category,updated_at DESC,id")?
                .query_map(params![project, now_ms], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
            let memories = heads.into_iter().map(|(id, revision)| {
                let memory = load_memory_full_tx(conn, id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)?;
                let files = conn.prepare("SELECT file_path FROM memory_verifications WHERE memory_id=?1 ORDER BY file_path")?
                    .query_map([id], |r| r.get(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(CurateMemory { memory, revision, files })
            }).collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(CurateSnapshot { state, completed, memories })
        })
    }

    /// Begin and success cursors are separate commits: a failed child keeps the
    /// active category so the next invocation resumes it rather than skipping it.
    /// A completed invocation also saves its result to suppress restart replay.
    pub fn save_dream_curate_progress(
        &self,
        project: &str,
        run: &str,
        state: &Value,
        completed: Option<&Value>,
        check_commit_fence: impl FnOnce(&Transaction<'_>) -> rusqlite::Result<()>,
    ) -> Result<(), McStoreError> {
        self.context_write(&["dream_state", "task_schedule_state"], |tx| {
            check_commit_fence(tx)?;
            if get(tx, &done_key(run))?.is_some() { return Ok(()); }
            tx.execute("INSERT INTO task_schedule_state(project_path,task,last_checked_commit) VALUES(?1,'curate',?2) ON CONFLICT(project_path,task) DO UPDATE SET last_checked_commit=excluded.last_checked_commit", params![project, state.to_string()])?;
            if let Some(result) = completed { set(tx, &done_key(run), &result.to_string())?; }
            Ok(())
        })
    }

    /// Compose the existing memory action, its history/undo receipt and embedding
    /// invalidations in one writer. Staleness refuses this invocation only. A saved
    /// action receipt bypasses CAS for replay, but the action still validates that
    /// the decision key belongs to exactly the same trusted request.
    pub fn commit_dream_curate<T>(
        &self,
        project: &str,
        decision_key: &str,
        expected: &[(i64, i64)],
        check_commit_fence: impl FnOnce(&Transaction<'_>) -> rusqlite::Result<()>,
        apply: impl FnOnce(&Transaction<'_>) -> rusqlite::Result<T>,
    ) -> Result<CurateEdit<T>, McStoreError> {
        self.context_write(&["memories", "memory_history", "memory_journal", "memory_decision_receipts", "memory_verifications", "memory_embeddings", "memory_successor_links", "memory_mutation_log"], |tx| {
            check_commit_fence(tx)?;
            if !crate::memory_lifecycle::authority::module_owns_memory(tx, project)? { return Err(rusqlite::Error::InvalidQuery); }
            let replay = tx.query_row("SELECT 1 FROM memory_decision_receipts WHERE decision_key=?1 AND project_path=?2", params![decision_key, project], |_| Ok(())).optional()?.is_some();
            if !replay {
                let mut stale = Vec::new();
                for &(id, revision) in expected {
                    let current = tx.query_row("SELECT revision FROM memories WHERE id=?1 AND project_path=?2 AND status IN ('active','permanent')", params![id, project], |r| r.get::<_, i64>(0)).optional()?;
                    if current != Some(revision) { stale.push(id); }
                }
                if !stale.is_empty() { return Ok(CurateEdit::Stale(stale)); }
            }
            let before = expected.iter().map(|(id, _)| full_snapshot(tx, *id)).collect::<rusqlite::Result<Vec<_>>>()?;
            let result = apply(tx)?;
            if !replay { require_lossless_merge_tx(tx, decision_key, &before)?; }
            Ok(CurateEdit::Applied(result))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> (tempfile::TempDir, McStore) {
        let root = std::env::temp_dir().join("magic-context/i5-5c");
        std::fs::create_dir_all(&root).unwrap();
        let dir = tempfile::Builder::new()
            .prefix("dream_curate-store-")
            .tempdir_in(root)
            .unwrap();
        let store = McStore::open_for_test(&cortexkit_store_types::StorageDescriptor {
            module_id: "magic-context".into(),
            storage_namespace: "mc_cache".into(),
            isolation: cortexkit_store_types::Isolation::Module,
            backend: cortexkit_store_types::StorageBackend::Sqlite {
                path: dir.path().join("store.db").to_string_lossy().into_owned(),
            },
        })
        .unwrap();
        (dir, store)
    }

    #[test]
    fn dream_curate_progress_preserves_schedule_and_unrelated_state() {
        let (_dir, store) = fixture();
        store.with_context_conn_for_test(|db| db.execute_batch("INSERT INTO task_schedule_state(project_path,task,last_run_at,next_due_at,last_checked_commit) VALUES('project','curate',7,9,'{\"unrelated\":true}');")).unwrap();
        let begin = json!({"unrelated":true,"curate":{"cursor":0,"activeCategory":"ARCHITECTURE"}});
        store
            .save_dream_curate_progress("project", "run", &begin, None, |_| Ok(()))
            .unwrap();
        assert_eq!(
            store.load_dream_curate("project", "run", 0).unwrap().state,
            Some(begin.to_string())
        );
        let success = json!({"unrelated":true,"curate":{"cursor":2}});
        store
            .save_dream_curate_progress(
                "project",
                "run",
                &success,
                Some(&json!({"ok":true})),
                |_| Ok(()),
            )
            .unwrap();
        store
            .save_dream_curate_progress("project", "run", &begin, None, |_| Ok(()))
            .unwrap();
        let snapshot = store.load_dream_curate("project", "run", 0).unwrap();
        assert_eq!(snapshot.state, Some(success.to_string()));
        assert_eq!(snapshot.completed, Some(json!({"ok":true})));
        store
            .with_context_read(|db| {
                assert_eq!(
                    db.query_row(
                        "SELECT last_run_at,next_due_at FROM task_schedule_state",
                        [],
                        |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
                    )?,
                    (7, 9)
                );
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn dream_curate_failed_progress_fence_leaves_no_cursor() {
        let (_dir, store) = fixture();
        assert!(store
            .save_dream_curate_progress(
                "project",
                "run",
                &json!({"curate":{"cursor":2}}),
                Some(&json!({})),
                |_| Err(rusqlite::Error::InvalidQuery)
            )
            .is_err());
        let snapshot = store.load_dream_curate("project", "run", 0).unwrap();
        assert!(snapshot.state.is_none());
        assert!(snapshot.completed.is_none());
    }

    #[test]
    fn dream_curate_missing_revision_refuses_applier_and_replay_still_checks_fence() {
        let (_dir, store) = fixture();
        // A receipt authorizes replay only after the live write fence succeeds.
        store.with_context_conn_for_test(|db| {
            db.execute("INSERT INTO memory_decision_receipts(decision_key,project_path,receipt_json,resolved_at) VALUES('decision','project','{}',1)", [])?;
            Ok(())
        }).unwrap();
        let stale = store
            .commit_dream_curate(
                "project",
                "new-decision",
                &[(99, 1)],
                |_| Ok(()),
                |_| -> rusqlite::Result<()> {
                    panic!("stale targets must not reach the memory applier")
                },
            )
            .unwrap();
        assert_eq!(stale, CurateEdit::Stale(vec![99]));
        assert!(store
            .commit_dream_curate(
                "project",
                "decision",
                &[(99, 1)],
                |_| Err(rusqlite::Error::InvalidQuery),
                |_| -> rusqlite::Result<()> { panic!("replay must not bypass the live fence") }
            )
            .is_err());
    }
}
