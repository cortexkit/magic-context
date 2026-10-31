//! Copy tool/search data between a host session and an engine namespace, or generations.
use crate::{move_inventory, McStore, McStoreError};
use rusqlite::{params, params_from_iter, types::Value, Connection, OptionalExtension};

pub const CARRY_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Carry,
    AlreadyConverted,
    NotCarried,
}

/// Explicit policy, independent of portable-move shipping: both keys remain in this database.
/// The schema guard checks every real table with a session_id column against
/// this list; discovering a new table never grants permission to copy it.
pub const TABLES: &[(&str, Decision, &str)] = &[
    (
        "notes",
        Decision::Carry,
        "Session notes read by tools; project-owned smart notes stay shared.",
    ),
    ("session_facts", Decision::Carry, "Session facts."),
    (
        "compartment_events",
        Decision::Carry,
        "History events, with compartment IDs rebound by sequence.",
    ),
    (
        "primer_candidates",
        Decision::Carry,
        "Session-addressed historian candidates.",
    ),
    (
        "user_memory_candidates",
        Decision::Carry,
        "Session-addressed historian candidates.",
    ),
    (
        "message_history_fts",
        Decision::Carry,
        "Raw-message search documents.",
    ),
    (
        "message_fts_rowid_map",
        Decision::Carry,
        "Rebuilt against copied FTS rowids, not source rowids.",
    ),
    (
        "message_history_index",
        Decision::Carry,
        "Raw-message index progress.",
    ),
    (
        "message_history_source",
        Decision::Carry,
        "Raw-message source identities.",
    ),
    (
        "session_projects",
        Decision::Carry,
        "Session project association.",
    ),
    (
        "subagent_invocations",
        Decision::Carry,
        "Session subagent telemetry.",
    ),
    (
        "historian_runs",
        Decision::Carry,
        "Session historian telemetry.",
    ),
    (
        "compartments",
        Decision::AlreadyConverted,
        "Manifest import or generation merge preserves summary coordinates.",
    ),
    (
        "compartment_chunk_embeddings",
        Decision::AlreadyConverted,
        "Copied with matched compartment IDs by copy_async_history_artifacts.",
    ),
    (
        "tags",
        Decision::AlreadyConverted,
        "Bound drops and frozen edits replace standalone tags.",
    ),
    (
        "pending_ops",
        Decision::AlreadyConverted,
        "Bound drops replace standalone pending operations.",
    ),
    (
        "source_contents",
        Decision::AlreadyConverted,
        "Frozen edits retain their proven source bytes.",
    ),
    (
        "session_meta",
        Decision::NotCarried,
        "The engine owns its own transform metadata.",
    ),
    (
        "session_meta_chunks",
        Decision::NotCarried,
        "Standalone metadata payload chunks are not engine state.",
    ),
    (
        "session_meta_collection_revisions",
        Decision::NotCarried,
        "Standalone metadata collection versions are not engine state.",
    ),
    (
        "transform_decisions",
        Decision::NotCarried,
        "The engine recomputes transform decisions.",
    ),
    (
        "temporal_decisions",
        Decision::NotCarried,
        "Standalone ordinal decisions do not bind engine entries.",
    ),
    (
        "session_replay_decisions",
        Decision::NotCarried,
        "Standalone replay decisions do not bind engine entries.",
    ),
    (
        "session_render_cache",
        Decision::NotCarried,
        "The engine renders and freezes its own view.",
    ),
    (
        "lkg_slots",
        Decision::NotCarried,
        "Standalone last-known-good requests are not engine views.",
    ),
    (
        "lkg_slot_chunks",
        Decision::NotCarried,
        "Standalone last-known-good payload chunks are not engine views.",
    ),
    (
        "lkg_served_markers",
        Decision::NotCarried,
        "Standalone served markers cannot certify an engine request.",
    ),
    (
        "compartment_state_lease",
        Decision::NotCarried,
        "A process-local writer lease must never be inherited.",
    ),
    (
        "tool_owner_backfill_state",
        Decision::NotCarried,
        "Standalone tag-owner backfill is replaced by runner identities.",
    ),
    (
        "compression_depth",
        Decision::NotCarried,
        "Standalone ordinal compression state is replaced by engine history.",
    ),
    (
        "recomp_compartments",
        Decision::NotCarried,
        "Uncommitted standalone recomp staging is not published history.",
    ),
    (
        "recomp_facts",
        Decision::NotCarried,
        "Uncommitted standalone recomp staging is not published facts.",
    ),
    (
        "m0_mutation_log",
        Decision::NotCarried,
        "Standalone render invalidations must not invalidate the engine cache.",
    ),
    (
        "compartment_history_versions",
        Decision::NotCarried,
        "Standalone history version stamps do not describe imported coordinates.",
    ),
    (
        "compartment_score_revisions",
        Decision::NotCarried,
        "Standalone score lineage is replaced by imported compartment scores.",
    ),
    (
        "compartment_score_selections",
        Decision::NotCarried,
        "Standalone score selections refer to standalone revision IDs.",
    ),
    (
        "plugin_messages",
        Decision::NotCarried,
        "Standalone plugin command delivery is not engine command delivery.",
    ),
    (
        "synapse_batch_ledger",
        Decision::NotCarried,
        "Embedding submission receipts belong to their original execution.",
    ),
    (
        "embedding_measurement_corpus",
        Decision::NotCarried,
        "Embedding benchmark samples retain their original provenance.",
    ),
    (
        "pending_session_cleanup",
        Decision::NotCarried,
        "A deletion request must not follow a live session into a new namespace.",
    ),
    (
        "host_runner_entries",
        Decision::NotCarried,
        "The runner remains authoritative for raw entries.",
    ),
    (
        "host_runner_ids",
        Decision::NotCarried,
        "The runner remains authoritative for message identities.",
    ),
    (
        "host_runner_views",
        Decision::NotCarried,
        "Standalone host views are not engine views.",
    ),
    (
        "host_runner_state",
        Decision::NotCarried,
        "Standalone host cursors are not engine cursors.",
    ),
    (
        "memory_check_attempts",
        Decision::NotCarried,
        "Standalone memory-check executions cannot be resumed by the engine.",
    ),
    (
        "memory_stage_attempts",
        Decision::NotCarried,
        "Standalone memory staging executions cannot be resumed by the engine.",
    ),
    (
        "memory_agent_fragments",
        Decision::NotCarried,
        "Standalone frozen memory fragments belong to their original served prefix.",
    ),
    (
        "memory_applied_rows",
        Decision::NotCarried,
        "Standalone memory application receipts certify only their original view.",
    ),
    (
        "memory_applied_snapshots",
        Decision::NotCarried,
        "Standalone applied memory snapshots certify only their original view.",
    ),
];

impl McStore {
    /// Copy, never rename, tool/search rows in one context transaction. Existing
    /// target keys win. A copied integer-ID row is a new row: identical source
    /// payloads may coalesce, and edits after the carry are not reconciled.
    /// Retries suppress identical payloads, not an immutable source-row identity.
    /// Callers must persist their carry version before serving tools. No render
    /// cache, metadata watermark, or refresh flag is changed by this operation.
    pub fn carry_session_data(&self, source: &str, target: &str) -> Result<usize, McStoreError> {
        if source == target {
            return Ok(0);
        }
        let tables = TABLES
            .iter()
            .filter(|(_, d, _)| *d == Decision::Carry)
            .map(|(table, _, _)| *table)
            .collect::<Vec<_>>();
        self.context_write(&tables, |tx| {
            let mut copied = 0;
            let mut ids = CarryIds::load(tx, source, target)?;
            for table in &tables {
                if *table == "message_history_fts" {
                    copied += carry_fts(tx, source, target)?;
                } else if *table != "message_fts_rowid_map" {
                    copied += carry_table(tx, table, source, target, &mut ids)?;
                }
            }
            Ok(copied)
        })
    }
}

#[derive(Default)]
struct CarryIds {
    compartments: std::collections::BTreeMap<i64, i64>,
    subagents: std::collections::BTreeMap<i64, i64>,
}

impl CarryIds {
    fn load(conn: &Connection, source: &str, target: &str) -> rusqlite::Result<Self> {
        Ok(Self {
            compartments: conn.prepare("SELECT s.id,t.id FROM compartments s JOIN compartments t ON t.session_id=?2 AND t.sequence=s.sequence WHERE s.session_id=?1")?
                .query_map(params![source,target], |row|Ok((row.get(0)?,row.get(1)?)))?.collect::<rusqlite::Result<_>>()?,
            ..Self::default()
        })
    }
}

fn carry_table(
    conn: &Connection,
    table: &str,
    source: &str,
    target: &str,
    ids: &mut CarryIds,
) -> rusqlite::Result<usize> {
    let inventory = move_inventory::TABLES
        .iter()
        .find(|entry| entry.store == move_inventory::Store::Context && entry.table == table)
        .ok_or(rusqlite::Error::InvalidQuery)?;
    let has_id = inventory.columns.contains(&"id");
    let columns = inventory
        .columns
        .iter()
        .copied()
        .filter(|column| *column != "id")
        .collect::<Vec<_>>();
    let names = columns
        .iter()
        .map(|c| format!("\"{c}\""))
        .collect::<Vec<_>>()
        .join(",");
    let predicate = if table == "notes" {
        " AND type='session'"
    } else {
        ""
    };
    let id_column = if has_id { "id" } else { "NULL" };
    let order = if has_id { " ORDER BY id" } else { "" };
    let rows = conn
        .prepare(&format!(
            "SELECT {id_column},{names} FROM \"{table}\" WHERE session_id=?1{predicate}{order}"
        ))?
        .query_map([source], |row| {
            Ok((
                row.get::<_, Option<i64>>(0)?,
                (0..columns.len())
                    .map(|i| row.get::<_, Value>(i + 1))
                    .collect::<rusqlite::Result<Vec<_>>>()?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let placeholders = (1..=columns.len())
        .map(|i| format!("?{i}"))
        .collect::<Vec<_>>()
        .join(",");
    let insert = format!("INSERT OR IGNORE INTO \"{table}\" ({names}) VALUES({placeholders})");
    let equal = columns
        .iter()
        .enumerate()
        .map(|(i, c)| format!("\"{c}\" IS ?{}", i + 1))
        .collect::<Vec<_>>()
        .join(" AND ");
    let find = format!("SELECT id FROM \"{table}\" WHERE {equal} LIMIT 1");
    let mut copied = 0;
    for (old_id, mut values) in rows {
        for (column, value) in columns.iter().zip(&mut values) {
            match *column {
                "session_id" => *value = Value::Text(target.to_owned()),
                "compartment_id" | "compartment_id_min" | "compartment_id_max" => {
                    if let Value::Integer(old) = value {
                        *value = ids
                            .compartments
                            .get(old)
                            .copied()
                            .map_or(Value::Null, Value::Integer);
                    }
                }
                "subagent_invocation_id" | "parent_invocation_id" => {
                    if let Value::Integer(old) = value {
                        if let Some(new) = ids.subagents.get(old) {
                            *value = Value::Integer(*new);
                        }
                    }
                }
                _ => {}
            }
        }
        let existing = if has_id {
            conn.query_row(&find, params_from_iter(&values), |row| row.get::<_, i64>(0))
                .optional()?
        } else {
            None
        };
        let new_id = if let Some(existing) = existing {
            Some(existing)
        } else {
            let changed = conn.execute(&insert, params_from_iter(&values))?;
            copied += changed;
            (changed > 0 && has_id).then(|| conn.last_insert_rowid())
        };
        if table == "subagent_invocations" {
            if let (Some(old), Some(new)) = (old_id, new_id) {
                ids.subagents.insert(old, new);
            }
        }
    }
    Ok(copied)
}

fn carry_fts(conn: &Connection, source: &str, target: &str) -> rusqlite::Result<usize> {
    // Scan each namespace once, not the entire virtual table once per message.
    // Keep only rowids in memory so a long session's raw text is never all loaded.
    let source_rows = conn.prepare("SELECT f.rowid,f.message_ordinal,m.message_time_ms FROM message_history_fts f LEFT JOIN message_fts_rowid_map m ON m.session_id=f.session_id AND m.fts_rowid=f.rowid WHERE f.session_id=?1 ORDER BY f.rowid")?
        .query_map([source], |row| Ok((row.get::<_,i64>(0)?,row.get::<_,i64>(1)?,row.get::<_,Option<i64>>(2)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if source_rows.is_empty() {
        return Ok(0);
    }
    let mut target_rows = conn.prepare("SELECT message_ordinal,min(rowid) FROM message_history_fts WHERE session_id=?1 GROUP BY message_ordinal")?
        .query_map([target], |row| Ok((row.get::<_,i64>(0)?,row.get::<_,i64>(1)?)))?
        .collect::<rusqlite::Result<std::collections::BTreeMap<_,_>>>()?;
    let mut copied = 0;
    for (source_rowid, ordinal, time) in source_rows {
        let target_rowid = match target_rows.get(&ordinal) {
            Some(rowid) => *rowid,
            None => {
                copied += conn.execute("INSERT INTO message_history_fts(session_id,message_ordinal,message_id,role,content) SELECT ?1,message_ordinal,message_id,role,content FROM message_history_fts WHERE rowid=?2",params![target,source_rowid])?;
                let rowid = conn.last_insert_rowid();
                target_rows.insert(ordinal, rowid);
                rowid
            }
        };
        copied += conn.execute("INSERT INTO message_fts_rowid_map(session_id,message_ordinal,fts_rowid,message_time_ms) VALUES(?1,?2,?3,?4) ON CONFLICT(session_id,message_ordinal) DO UPDATE SET fts_rowid=excluded.fts_rowid,message_time_ms=COALESCE(message_fts_rowid_map.message_time_ms,excluded.message_time_ms) WHERE message_fts_rowid_map.fts_rowid<>excluded.fts_rowid OR (message_fts_rowid_map.message_time_ms IS NULL AND excluded.message_time_ms IS NOT NULL)",params![target,ordinal,target_rowid,time])?;
    }
    Ok(copied)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
    use std::collections::BTreeSet;

    fn descriptor(dir: &std::path::Path) -> StorageDescriptor {
        StorageDescriptor {
            module_id: "session-carry-test".into(),
            storage_namespace: "mc_cache".into(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: dir.join("store.db").to_string_lossy().into(),
            },
        }
    }

    #[test]
    fn every_context_session_table_has_exactly_one_carry_decision() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
        store.with_context_read(|conn| {
            let actual = conn.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND EXISTS (SELECT 1 FROM pragma_table_info(sqlite_schema.name) WHERE name='session_id') ORDER BY name")?
                .query_map([], |r| r.get::<_,String>(0))?.collect::<rusqlite::Result<BTreeSet<_>>>()?;
            let decided = TABLES.iter().map(|(name,_,_)| name.to_string()).collect::<BTreeSet<_>>();
            assert_eq!(decided.len(), TABLES.len(), "duplicate carry decisions");
            assert_eq!(actual, decided, "every real session_id table requires a carry decision");
            Ok(())
        }).unwrap();
    }

    #[test]
    fn carry_session_data_copies_notes_facts_and_raw_search_idempotently() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
        store.with_context_conn_for_test(|conn| conn.execute_batch(
            "INSERT INTO notes(type,status,content,session_id,project_path,created_at,updated_at) VALUES('session','active','pre-move note','host','project',1,1),('project','pending','shared note','host','project',2,2);
             INSERT INTO session_facts(session_id,category,content,created_at,updated_at) VALUES('host','architecture','pre-move fact',1,1);
             INSERT INTO message_history_fts(session_id,message_ordinal,message_id,role,content) VALUES('host',7,'raw-seven','user','prehistoric narwhal');
             INSERT INTO message_fts_rowid_map(session_id,message_ordinal,fts_rowid,message_time_ms) VALUES('host',7,last_insert_rowid(),123);
             INSERT INTO message_history_index(session_id,last_indexed_ordinal,updated_at) VALUES('host',7,1);
             INSERT INTO message_history_source(session_id,message_id,message_ordinal,source_version,normalized_content_hash,role,updated_at) VALUES('host','raw-seven',7,'v1','hash','user',1);"
        )).unwrap();
        assert!(store.carry_session_data("host", "engine").unwrap() > 0);
        assert_eq!(store.carry_session_data("host", "engine").unwrap(), 0);
        assert_eq!(store.carry_session_data("host", "host").unwrap(), 0);
        store.with_context_read(|conn| {
            assert_eq!(conn.query_row("SELECT count(*) FROM notes WHERE session_id='engine' AND content='pre-move note'",[],|r|r.get::<_,i64>(0))?,1);
            assert_eq!(conn.query_row("SELECT count(*) FROM notes WHERE content='shared note'",[],|r|r.get::<_,i64>(0))?,1);
            assert_eq!(conn.query_row("SELECT count(*) FROM session_facts WHERE session_id='engine'",[],|r|r.get::<_,i64>(0))?,1);
            assert_eq!(conn.query_row("SELECT count(*) FROM message_history_fts f JOIN message_fts_rowid_map m ON m.fts_rowid=f.rowid AND m.session_id=f.session_id WHERE message_history_fts MATCH 'narwhal' AND f.session_id='engine' AND m.message_time_ms=123",[],|r|r.get::<_,i64>(0))?,1);
            assert_eq!(conn.query_row("SELECT count(*) FROM message_history_fts WHERE session_id='host'",[],|r|r.get::<_,i64>(0))?,1);
            assert_eq!(conn.query_row("SELECT count(*) FROM message_history_index WHERE session_id='engine' AND last_indexed_ordinal=7",[],|r|r.get::<_,i64>(0))?,1);
            assert_eq!(conn.query_row("SELECT count(*) FROM message_history_source WHERE session_id='engine' AND message_id='raw-seven'",[],|r|r.get::<_,i64>(0))?,1);
            Ok(())
        }).unwrap();
    }

    #[test]
    fn carry_session_data_preserves_targets_rebinds_ids_and_rolls_back_on_failure() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
        store.with_context_conn_for_test(|conn| conn.execute_batch(
            "INSERT INTO compartments(id,session_id,sequence,start_message,end_message,title,content,created_at) VALUES(11,'host',1,0,5,'source','source',1),(22,'engine',1,0,5,'target','target',1);
             INSERT INTO compartment_events(session_id,compartment_id,kind,created_at) VALUES('host',11,'decision',1);
             INSERT INTO subagent_invocations(id,session_id,harness,subagent,started_at,status) VALUES(101,'host','opencode','parent',1,'done');
             INSERT INTO subagent_invocations(id,session_id,harness,subagent,started_at,status,parent_invocation_id) VALUES(102,'host','opencode','child',2,'done',101);
             INSERT INTO historian_runs(session_id,subagent_invocation_id,run_kind,status,compartment_id_min,compartment_id_max,created_at) VALUES('host',102,'chunk','done',11,11,1);
             INSERT INTO primer_candidates(project_path,session_id,question,normalized_question,source_message_time,created_at) VALUES('project','host','question','question',1,1);
             INSERT INTO user_memory_candidates(session_id,content,created_at) VALUES('host','observation',1);
             INSERT INTO session_projects(session_id,project_path,updated_at) VALUES('host','project',1);
             INSERT INTO message_history_fts(session_id,message_ordinal,message_id,role,content) VALUES('host',7,'source','user','source words'),('engine',7,'target','user','target words');
             INSERT INTO message_history_source(session_id,message_id,message_ordinal,source_version,normalized_content_hash,role,updated_at) VALUES('host','source',7,'v1','hash','user',1);"
        )).unwrap();
        assert!(store.carry_session_data("host", "engine").unwrap() > 0);
        assert_eq!(store.carry_session_data("host", "engine").unwrap(), 0);
        store.with_context_read(|conn| {
            assert_eq!(conn.query_row("SELECT compartment_id FROM compartment_events WHERE session_id='engine'",[],|r|r.get::<_,i64>(0))?,22);
            assert_eq!(conn.query_row("SELECT count(*) FROM historian_runs h JOIN subagent_invocations c ON c.id=h.subagent_invocation_id JOIN subagent_invocations p ON p.id=c.parent_invocation_id WHERE h.session_id='engine' AND c.session_id='engine' AND p.session_id='engine' AND h.compartment_id_min=22 AND h.compartment_id_max=22",[],|r|r.get::<_,i64>(0))?,1);
            for table in ["primer_candidates","user_memory_candidates","session_projects"] {
                assert_eq!(conn.query_row(&format!("SELECT count(*) FROM {table} WHERE session_id='engine'"),[],|r|r.get::<_,i64>(0))?,1);
            }
            assert_eq!(conn.query_row("SELECT f.content FROM message_history_fts f JOIN message_fts_rowid_map m ON m.fts_rowid=f.rowid AND m.session_id=f.session_id WHERE f.session_id='engine'",[],|r|r.get::<_,String>(0))?,"target words");
            Ok(())
        }).unwrap();
        store.with_context_conn_for_test(|conn|conn.execute_batch("CREATE TRIGGER reject_carry BEFORE INSERT ON message_history_source WHEN NEW.session_id='broken' BEGIN SELECT RAISE(ABORT,'carry failure'); END")).unwrap();
        assert!(store.carry_session_data("host", "broken").is_err());
        store
            .with_context_read(|conn| {
                for table in [
                    "compartment_events",
                    "subagent_invocations",
                    "message_history_fts",
                    "message_fts_rowid_map",
                ] {
                    assert_eq!(
                        conn.query_row(
                            &format!("SELECT count(*) FROM {table} WHERE session_id='broken'"),
                            [],
                            |r| r.get::<_, i64>(0)
                        )?,
                        0
                    );
                }
                Ok(())
            })
            .unwrap();
    }
}
