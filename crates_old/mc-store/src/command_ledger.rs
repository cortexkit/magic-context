//! Session-scoped UI commands and their bounded, acknowledged event stream.
//! The command record and its store-local effect commit in the same transaction.

use crate::{cache_codec, McStore, McStoreError};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

// Leave half of the 1 MiB UI reply budget for envelopes and derived fields,
// and reject larger raw cache blobs before allocating or decoding their JSON.
const OPS_SNAPSHOT_BLOB_MAX_BYTES: usize = 512 * 1024;

pub const EVENT_RETENTION: i64 = 256;
pub const EVENT_PAGE_LIMIT: usize = 64;

fn initialize(tx: &Connection) -> rusqlite::Result<()> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS mc_ops_commands (
          session_id TEXT NOT NULL, command_id TEXT NOT NULL, job_id TEXT NOT NULL,
          parameters TEXT NOT NULL, job TEXT NOT NULL,
          project_identity TEXT NOT NULL,
          PRIMARY KEY(project_identity, session_id, command_id), UNIQUE(project_identity, session_id, job_id));
         CREATE TABLE IF NOT EXISTS mc_ops_stream (
          session_id TEXT NOT NULL UNIQUE, sequence INTEGER NOT NULL, acked INTEGER NOT NULL, active_command TEXT,
          project_identity TEXT NOT NULL, PRIMARY KEY(project_identity,session_id));
         CREATE TABLE IF NOT EXISTS mc_ops_events (
          session_id TEXT NOT NULL, sequence INTEGER NOT NULL, event TEXT NOT NULL,
          project_identity TEXT NOT NULL, PRIMARY KEY(project_identity, session_id, sequence));
         CREATE TRIGGER IF NOT EXISTS mc_ops_retire AFTER DELETE ON mc_cache_state BEGIN
          DELETE FROM mc_ops_commands WHERE session_id=OLD.session_id;
          DELETE FROM mc_ops_events WHERE session_id=OLD.session_id;
          DELETE FROM mc_ops_stream WHERE session_id=OLD.session_id;
         END;",
    )
}

fn exists(conn: &Connection) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='mc_ops_commands')",
        [],
        |r| r.get(0),
    )
}

fn decode(text: String) -> rusqlite::Result<Value> {
    serde_json::from_str(&text).map_err(crate::serde_to_sql_error)
}

fn job_id(project: &str, session: &str, command: &str) -> String {
    let mut hash = Sha256::new();
    hash.update((project.len() as u64).to_be_bytes());
    hash.update(project.as_bytes());
    hash.update((session.len() as u64).to_be_bytes());
    hash.update(session.as_bytes());
    hash.update(command.as_bytes());
    format!("ops-{:x}", hash.finalize())
}

fn scope_matches(conn: &Connection, project: &str, session: &str) -> rusqlite::Result<bool> {
    if !exists(conn)? {
        return Ok(true);
    }
    // Older ledgers identify sessions but not their projects. Refuse them rather
    // than expose retained jobs to a project that may not own them.
    let scoped: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('mc_ops_stream') WHERE name='project_identity')",[],|r| r.get(0))?;
    if !scoped {
        return Ok(false);
    }
    let owner = conn
        .query_row(
            "SELECT project_identity FROM mc_ops_stream WHERE session_id=?1",
            [session],
            |r| r.get::<_, String>(0),
        )
        .optional()?;
    Ok(owner.is_none_or(|owner| owner == project))
}

fn require_scope(conn: &Connection, project: &str, session: &str) -> rusqlite::Result<()> {
    if scope_matches(conn, project, session)? {
        Ok(())
    } else {
        Err(rusqlite::Error::InvalidQuery)
    }
}

pub(crate) struct FlushProgress {
    project: String,
    command: String,
    job: Value,
    targets: std::collections::HashSet<String>,
    frozen_before: std::collections::HashSet<String>,
}

fn frozen_drop_targets(
    tx: &Connection,
    session: &str,
) -> rusqlite::Result<std::collections::HashSet<String>> {
    tx.prepare(
        "SELECT substr(json_extract(unit.value,'$.key'),5)
           FROM mc_cache_frozen_chunks AS chunks, json_each(chunks.body) AS unit
          WHERE chunks.session_id=?1 AND json_extract(unit.value,'$.key') LIKE 'red:%'",
    )?
    .query_map([session], |row| row.get(0))?
    .collect()
}

/// Snapshot the active flush before the accepted transform changes frozen units.
/// A flush snapshots target ids, which need not share the flush command's id.
/// Queued rows can be retired without applying a reduction, so their count alone
/// cannot be used as an applied-effect count.
pub(crate) fn prepare_flush_progress_tx(
    tx: &Connection,
    session: &str,
) -> rusqlite::Result<Option<FlushProgress>> {
    if !exists(tx)? {
        return Ok(None);
    }
    let scoped: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('mc_ops_stream') WHERE name='project_identity')", [], |r| r.get(0))?;
    if !scoped {
        return Ok(None);
    }
    let row = tx
        .query_row(
            "SELECT c.project_identity,c.command_id,c.job FROM mc_ops_commands c
         JOIN mc_ops_stream s ON s.session_id=c.session_id
           AND s.project_identity=c.project_identity AND s.active_command=c.command_id
         WHERE c.session_id=?1 AND json_extract(c.job,'$.state')='armed'",
            [session],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    decode(r.get(2)?)?,
                ))
            },
        )
        .optional()?;
    let Some((project, command, job)) = row else {
        return Ok(None);
    };
    let targets: std::collections::HashSet<String> = job["result"]["queued_drops"]
        ["target_tag_ids"]
        .as_array()
        .ok_or(rusqlite::Error::InvalidQuery)?
        .iter()
        .map(|v| {
            v.as_str()
                .map(str::to_owned)
                .ok_or(rusqlite::Error::InvalidQuery)
        })
        .collect::<rusqlite::Result<_>>()?;
    if targets.len() > 512 {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let frozen_before = if targets.is_empty() {
        Default::default()
    } else {
        frozen_drop_targets(tx, session)?
    };
    Ok(Some(FlushProgress {
        project,
        command,
        job,
        targets,
        frozen_before,
    }))
}

/// Called after the successful cache CAS and queue consumption, in that same
/// transaction. Count only newly frozen snapshot targets; already-frozen or
/// obsolete queue entries are not new effects. A partial flush remains armed.
pub(crate) fn finish_flush_progress_tx(
    tx: &Connection,
    session: &str,
    progress: Option<FlushProgress>,
    refresh_pending: bool,
    now: i64,
) -> rusqlite::Result<()> {
    let Some(mut progress) = progress else {
        return Ok(());
    };
    let frozen_after = if progress.targets.is_empty() {
        Default::default()
    } else {
        frozen_drop_targets(tx, session)?
    };
    let applied = progress
        .targets
        .iter()
        .filter(|target| {
            !progress.frozen_before.contains(*target) && frozen_after.contains(*target)
        })
        .count() as u64;
    let mut remaining = 0;
    for target in &progress.targets {
        let pending: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM pending_agent_drops WHERE session_id=?1 AND target_id=?2)",
            params![session, target],
            |r| r.get(0),
        )?;
        if pending {
            remaining += 1;
        }
    }
    let result = &mut progress.job["result"];
    let total = result["queued_drops"]["applied_count"]
        .as_u64()
        .unwrap_or(0)
        .checked_add(applied)
        .ok_or(rusqlite::Error::InvalidQuery)?;
    result["queued_drops"]["applied_count"] = json!(total);
    result["queued_drops"]["remaining_count"] = json!(remaining);
    result["soft_refresh_pending"] = json!(refresh_pending);
    let complete = remaining == 0 && !refresh_pending;
    if complete {
        result["queued_drops"]["state"] = json!("drained");
        progress.job["state"] = json!("drained");
        progress.job["completed_at_ms"] = json!(now);
    }
    tx.execute("UPDATE mc_ops_commands SET job=?4 WHERE project_identity=?1 AND session_id=?2 AND command_id=?3", params![progress.project,session,progress.command,progress.job.to_string()])?;
    // Retained events carry the same current job snapshot. Do not allocate a new
    // sequence here: transform completion must not overflow the acknowledged
    // stream's admission bound or discard an unacknowledged event.
    tx.execute("UPDATE mc_ops_events SET event=json_set(event,'$.job',json(?4)) WHERE project_identity=?1 AND session_id=?2 AND json_extract(event,'$.command_id')=?3",params![progress.project,session,progress.command,progress.job.to_string()])?;
    Ok(())
}

impl McStore {
    fn ops_project(&self, session: &str) -> Result<String, McStoreError> {
        self.session_project_identity(session)?
            .filter(|p| !p.is_empty())
            .ok_or_else(|| McStoreError::Serde("ops_project_unbound".into()))
    }

    pub fn ops_check_project(&self, project: &str, session: &str) -> Result<bool, McStoreError> {
        if self.ops_project(session)? != project {
            return Ok(false);
        }
        Ok(self
            .inner
            .with_conn(|conn| scope_matches(conn, project, session))?)
    }

    fn require_ops_project(&self, project: &str, session: &str) -> Result<(), McStoreError> {
        if self.ops_check_project(project, session)? {
            Ok(())
        } else {
            Err(McStoreError::Serde("ops_project_mismatch".into()))
        }
    }
    /// Read only small cache fields and a capped compartment-count projection.
    /// Counts over the scan bound are unknown rather than truncated truth.
    pub fn ops_snapshot(&self, session: &str) -> Result<Value, McStoreError> {
        self.ops_snapshot_in_project(&self.ops_project(session)?, session)
    }

    pub fn ops_snapshot_in_project(
        &self,
        project: &str,
        session: &str,
    ) -> Result<Value, McStoreError> {
        self.require_ops_project(project, session)?;
        let count = self.context_read(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM (SELECT 1 FROM compartments WHERE session_id=?1 LIMIT 4097)",
                [session],
                |r| r.get::<_, i64>(0),
            )
        })?;
        let row = self.inner.with_conn(|conn| {
            require_scope(conn, project, session)?;
            cache_codec::read_small_row_bounded(conn, session, OPS_SNAPSHOT_BLOB_MAX_BYTES)
        })?;
        let (version, meta, boundary) = match row {
            cache_codec::BoundedSmallRow::Oversized => {
                return Ok(json!({"error":"ui_snapshot_too_large"}))
            }
            cache_codec::BoundedSmallRow::Missing => (None, crate::ModuleMeta::default(), false),
            cache_codec::BoundedSmallRow::Present(row) => {
                let meta = cache_codec::decode_small_meta(&row.meta)
                    .map_err(|e| McStoreError::Serde(e.to_string()))?;
                let core = cache_codec::decode_small_core(&row.core_state)
                    .map_err(|e| McStoreError::Serde(e.to_string()))?;
                (Some(row.row_version), meta, !core.boundary_id.is_empty())
            }
        };
        // Only these diagnostic fields belong in UI replies. The durable
        // historian record also contains a secret claim token and producer
        // inputs that the UI must never receive.
        let public_meta = json!({
            "coverage_ordinal":meta.coverage_ordinal,"last_usage":meta.last_usage,
            "last_todo_state":meta.last_todo_state,"cache_ttl_policy":meta.cache_ttl_policy,
            "protected_tokens_effective":meta.protected_tokens_effective,
            "historian":{"phase":meta.historian.state,"consecutive_publish_failures":meta.historian.consecutive_publish_failures}
        });
        Ok(
            json!({"row_version":version,"meta":public_meta,"boundary_present":boundary,"compartment_count":if count <= 4096 { Some(count) } else { None }}),
        )
    }

    pub fn ops_flush(
        &self,
        session: &str,
        command: &str,
        compaction: bool,
        now: i64,
    ) -> Result<Value, McStoreError> {
        self.ops_flush_in_project(
            &self.ops_project(session)?,
            session,
            command,
            compaction,
            now,
        )
    }

    pub fn ops_flush_in_project(
        &self,
        project: &str,
        session: &str,
        command: &str,
        compaction: bool,
        now: i64,
    ) -> Result<Value, McStoreError> {
        self.ops_flush_parameters_in_project(
            project,
            session,
            command,
            compaction,
            now,
            "{\"method\":\"mc.flush\"}",
        )
    }

    #[cfg(test)]
    fn ops_flush_parameters(
        &self,
        session: &str,
        command: &str,
        compaction: bool,
        now: i64,
        parameters: &str,
    ) -> Result<Value, McStoreError> {
        self.ops_flush_parameters_in_project(
            &self.ops_project(session)?,
            session,
            command,
            compaction,
            now,
            parameters,
        )
    }

    fn ops_flush_parameters_in_project(
        &self,
        project: &str,
        session: &str,
        command: &str,
        compaction: bool,
        now: i64,
        parameters: &str,
    ) -> Result<Value, McStoreError> {
        self.require_ops_project(project, session)?;
        Ok(self.inner.with_conn_fenced(|tx| {
            crate::move_store::check_writer(tx,session)?;
            require_scope(tx,project,session)?;
            let has_ledger = exists(tx)?;
            let existing = if has_ledger { tx.query_row("SELECT parameters,job FROM mc_ops_commands WHERE session_id=?1 AND command_id=?2", params![session,command], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional()? } else { None };
            if let Some((prior,job)) = existing {
                return if prior == parameters { decode(job) } else { Ok(json!({"error":"command_parameter_mismatch"})) };
            }
            let (sequence,acked,active) = if has_ledger { tx.query_row("SELECT sequence,acked,active_command FROM mc_ops_stream WHERE session_id=?1", [session], |r| Ok((r.get::<_,i64>(0)?,r.get::<_,i64>(1)?,r.get::<_,Option<String>>(2)?))).optional()?.unwrap_or((0,0,None)) } else { (0,0,None) };
            if sequence - acked >= EVENT_RETENTION { return Ok(json!({"error":"event_backlog_full"})); }
            let targets = {
                let mut stmt = tx.prepare("SELECT target_id FROM pending_agent_drops WHERE session_id=?1 ORDER BY target_id LIMIT 513")?;
                let rows = stmt.query_map([session], |r| r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
                rows
            };
            if targets.len() > 512 || targets.iter().any(|v| v.len() > 256) || serde_json::to_vec(&targets).map_err(crate::serde_to_sql_error)?.len() > 256 * 1024 { return Ok(json!({"error":"flush_queue_too_large"})); }
            initialize(tx)?;
            let row = cache_codec::read_small_row(tx,session)?;
            let mut meta = row.as_ref().map(|row| cache_codec::decode_small_meta(&row.meta)).transpose().map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?.unwrap_or_default();
            if compaction { meta.soft_refresh_pending = true; }
            if let Some(row) = row {
                let encoded = cache_codec::encode_small_meta(&meta).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
                let encoded = cache_codec::preserve_native_marker(encoded,&row.meta)?;
                if encoded != row.meta {
                    tx.execute("UPDATE mc_cache_state SET meta=?2,row_version=row_version+1,last_activity_at=?3 WHERE session_id=?1",params![session,encoded,now])?;
                    crate::advance_row_state_digest_tx(tx,session,row.row_version as i64,row.row_version as i64 + 1)?;
                }
            } else {
                crate::write_cache_state_tx(tx,session,1,&crate::CoreState::default(),&meta,None,now)?;
            }
            if compaction {
                if let Some(active) = active {
                    tx.execute("UPDATE mc_ops_commands SET job=json_set(job,'$.state','superseded') WHERE session_id=?1 AND command_id=?2 AND json_extract(job,'$.state')='armed'",params![session,active])?;
                    tx.execute("UPDATE mc_ops_events SET event=json_set(event,'$.currentness.current',json('false')) WHERE session_id=?1 AND json_extract(event,'$.command_id')=?2",params![session,active])?;
                }
            }
            let mut result = json!({"queued_drops":{"state":"pending","count":targets.len(),"target_tag_ids":targets},"soft_refresh_pending":meta.soft_refresh_pending,"bridge_refresh_obligations":if compaction { vec!["materialization","history","system"] } else {vec![]},"history_rebuilt":false});
            if !compaction { result["reason"] = json!("compaction_off"); }
            let id = job_id(project,session,command);
            let job = json!({"v":1,"project_identity":project,"session_id":session,"command_id":command,"job_id":id,"state":if compaction {"armed"} else {"no_op"},"result":result,"created_at_ms":now});
            let inserted = tx.execute("INSERT OR IGNORE INTO mc_ops_commands(session_id,command_id,job_id,parameters,job,project_identity) VALUES(?1,?2,?3,?4,?5,?6)",params![session,command,id,parameters,job.to_string(),project])?;
            if inserted != 1 { return Err(rusqlite::Error::InvalidQuery); }
            let event = json!({"v":1,"event_id":format!("{id}:{}",sequence+1),"sequence":sequence+1,"project_identity":project,"session_id":session,"command_id":command,"job_id":id,"kind":if compaction {"job.armed"} else {"job.terminal"},"invalidates":["mc.read_sidebar","mc.read_status"],"currentness":{"policy":"current_until_withdrawn","current":true},"job":job});
            if event.to_string().len() > 512 * 1024 { return Err(rusqlite::Error::InvalidQuery); }
            tx.execute("INSERT INTO mc_ops_events(session_id,sequence,event,project_identity) VALUES(?1,?2,?3,?4)",params![session,sequence+1,event.to_string(),project])?;
            tx.execute("INSERT INTO mc_ops_stream(session_id,sequence,acked,active_command,project_identity) VALUES(?1,?2,0,?3,?4) ON CONFLICT(session_id) DO UPDATE SET sequence=excluded.sequence,active_command=COALESCE(excluded.active_command,active_command)",params![session,sequence+1,if compaction {Some(command)} else {None},project])?;
            Ok(job)
        })?)
    }

    pub fn ops_jobs(&self, session: &str) -> Result<Vec<Value>, McStoreError> {
        self.ops_jobs_in_project(&self.ops_project(session)?, session)
    }

    pub fn ops_jobs_in_project(
        &self,
        project: &str,
        session: &str,
    ) -> Result<Vec<Value>, McStoreError> {
        self.require_ops_project(project, session)?;
        Ok(self.inner.with_conn(|conn| {
            require_scope(conn,project,session)?;
            if !exists(conn)? { return Ok(Vec::new()); }
            let text = conn.query_row("SELECT c.job FROM mc_ops_stream s JOIN mc_ops_commands c ON c.session_id=s.session_id AND c.command_id=s.active_command WHERE s.session_id=?1",[session],|r| r.get::<_,String>(0)).optional()?;
            text.map(decode).transpose().map(|v| v.into_iter().collect())
        })?)
    }

    pub fn ops_job(
        &self,
        session: &str,
        command: Option<&str>,
        job: Option<&str>,
    ) -> Result<Option<Value>, McStoreError> {
        self.ops_job_in_project(&self.ops_project(session)?, session, command, job)
    }

    pub fn ops_job_in_project(
        &self,
        project: &str,
        session: &str,
        command: Option<&str>,
        job: Option<&str>,
    ) -> Result<Option<Value>, McStoreError> {
        self.require_ops_project(project, session)?;
        Ok(self.inner.with_conn(|conn| {
            require_scope(conn,project,session)?;
            if !exists(conn)? { return Ok(None); }
            let text = match (command,job) {
                (Some(command),job) => conn.query_row("SELECT job FROM mc_ops_commands WHERE session_id=?1 AND command_id=?2 AND (?3 IS NULL OR job_id=?3)", params![session,command,job], |r| r.get::<_,String>(0)).optional()?,
                (None,Some(job)) => conn.query_row("SELECT job FROM mc_ops_commands WHERE session_id=?1 AND job_id=?2", params![session,job], |r| r.get::<_,String>(0)).optional()?,
                (None,None) => None,
            };
            text.map(decode).transpose()
        })?)
    }

    /// Acknowledgement means the module durably spooled the events, not that a
    /// host displayed them. Unacknowledged terminal notices are never evicted.
    pub fn ops_events(&self, session: &str, ack: i64, limit: usize) -> Result<Value, McStoreError> {
        self.ops_events_in_project(&self.ops_project(session)?, session, ack, limit)
    }

    pub fn ops_events_in_project(
        &self,
        project: &str,
        session: &str,
        ack: i64,
        limit: usize,
    ) -> Result<Value, McStoreError> {
        self.require_ops_project(project, session)?;
        Ok(self.inner.with_conn_fenced(|tx| {
            require_scope(tx,project,session)?;
            if !exists(tx)? {
                return Ok(if ack == 0 { event_page(0,0,Vec::new(),false) } else { json!({"error":"invalid_ack"}) });
            }
            let (sequence, prior_ack) = tx.query_row("SELECT sequence,acked FROM mc_ops_stream WHERE session_id=?1", [session], |r| Ok((r.get::<_,i64>(0)?,r.get::<_,i64>(1)?))).optional()?.unwrap_or((0,0));
            if ack > sequence { return Ok(json!({"error":"invalid_ack"})); }
            if ack < prior_ack { return Ok(json!({"error":"resync_required","acked_position":prior_ack,"through_sequence":sequence})); }
            let mut stmt = tx.prepare("SELECT event FROM mc_ops_events WHERE session_id=?1 AND sequence>?2 ORDER BY sequence LIMIT ?3")?;
            let events = stmt.query_map(params![session,ack,limit as i64], |r| decode(r.get(0)?))?.collect::<rusqlite::Result<Vec<_>>>()?;
            drop(stmt);
            // A count bound alone can exceed the bridge's 1 MiB reply ceiling
            // when many jobs carry large pending-drop snapshots. Leave room for
            // the page envelope and resume after the last event actually sent.
            let mut bytes = 0;
            let events = events.into_iter().take_while(|event| {
                bytes += event.to_string().len();
                bytes <= 512 * 1024
            }).collect::<Vec<_>>();
            tx.execute("UPDATE mc_ops_stream SET acked=?2 WHERE session_id=?1", params![session,ack])?;
            tx.execute("DELETE FROM mc_ops_events WHERE session_id=?1 AND sequence<=?2", params![session,ack])?;
            let next = events.last().and_then(|v| v["sequence"].as_i64()).unwrap_or(ack);
            Ok(event_page(sequence,next,events,next < sequence))
        })?)
    }

    pub fn ops_currentness(&self, session: &str, id: &str) -> Result<bool, McStoreError> {
        self.ops_currentness_in_project(&self.ops_project(session)?, session, id)
    }

    pub fn ops_currentness_in_project(
        &self,
        project: &str,
        session: &str,
        id: &str,
    ) -> Result<bool, McStoreError> {
        self.require_ops_project(project, session)?;
        Ok(self.inner.with_conn(|conn| {
            require_scope(conn,project,session)?;
            if !exists(conn)? { return Ok(false); }
            conn.query_row("SELECT EXISTS(SELECT 1 FROM mc_ops_events WHERE session_id=?1 AND json_extract(event,'$.currentness.current')=1 AND json_extract(event,'$.event_id')=?2)", params![session,id], |r| r.get(0))
        })?)
    }
}

fn event_page(sequence: i64, next: i64, events: Vec<Value>, more: bool) -> Value {
    json!({"v":1,"events":events,"through_sequence":sequence,"next_position":next,"has_more":more,"retention_bound":EVENT_RETENTION,"page_limit":EVENT_PAGE_LIMIT,"emits_push":false,"currentness":{"policy":"current_until_withdrawn","current":true}})
}

#[cfg(test)]
mod tests {
    use super::*;
    use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};

    pub(super) fn fixture() -> (McStore, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open_for_test(&StorageDescriptor {
            module_id: "magic-context".into(),
            storage_namespace: "mc".into(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: dir.path().join("store.db").to_string_lossy().into_owned(),
            },
        })
        .unwrap();
        store.with_context_conn_for_test(|conn| {
            for session in ["a","b","other-session"] {
                conn.execute("INSERT INTO session_projects(session_id,harness,project_path,updated_at) VALUES(?1,'opencode','project-a',1)",[session])?;
            }
            Ok(())
        }).unwrap();
        (store, dir)
    }

    #[test]
    fn ops_ledger_replays_once_survives_restart_and_rejects_parameter_mismatch() {
        let (store, dir) = fixture();
        let first = store.ops_flush("a", "one", true, 1).unwrap();
        let version = store.load_meta("a").unwrap().row_version;
        assert_eq!(store.ops_flush("a", "one", true, 2).unwrap(), first);
        assert_eq!(store.load_meta("a").unwrap().row_version, version);
        assert_eq!(
            store
                .ops_flush_parameters("a", "one", true, 3, "different")
                .unwrap()["error"],
            "command_parameter_mismatch"
        );
        assert_eq!(
            store.ops_job("a", Some("one"), None).unwrap(),
            Some(first.clone())
        );
        assert!(store.ops_job("b", Some("one"), None).unwrap().is_none());
        drop(store);
        let store = McStore::open_for_test(&StorageDescriptor {
            module_id: "magic-context".into(),
            storage_namespace: "mc".into(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: dir.path().join("store.db").to_string_lossy().into_owned(),
            },
        })
        .unwrap();
        assert_eq!(store.ops_flush("a", "one", true, 4).unwrap(), first);
        assert_eq!(
            store.ops_events("a", 0, 64).unwrap()["events"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn ops_ledger_rolls_back_refresh_if_job_insert_fails() {
        let (store, _dir) = fixture();
        store.inner.with_conn_fenced(|tx| {
            initialize(tx)?;
            tx.execute_batch("CREATE TRIGGER fail_ops_job BEFORE INSERT ON mc_ops_commands BEGIN SELECT RAISE(ABORT,'job failure'); END;")
        }).unwrap();
        assert!(store.ops_flush("a", "one", true, 1).is_err());
        assert!(!store.load_meta("a").unwrap().meta.soft_refresh_pending);
        assert!(store.ops_job("a", Some("one"), None).unwrap().is_none());
    }

    #[test]
    fn ops_event_retention_refuses_admission_instead_of_losing_unacked_outcomes() {
        let (store, _dir) = fixture();
        for id in 0..EVENT_RETENTION {
            store.ops_flush("a", &id.to_string(), true, id).unwrap();
        }
        assert_eq!(
            store.ops_flush("a", "overflow", true, 300).unwrap()["error"],
            "event_backlog_full"
        );
        assert!(store
            .ops_job("a", Some("overflow"), None)
            .unwrap()
            .is_none());
        let page = store.ops_events("a", 0, 64).unwrap();
        assert_eq!(page["events"].as_array().unwrap().len(), 64);
        assert_eq!(page["has_more"], true);
        store.ops_events("a", 64, 64).unwrap();
        assert!(store
            .ops_flush("a", "overflow", true, 301)
            .unwrap()
            .get("error")
            .is_none());
        assert_eq!(
            store.ops_events("a", 0, 64).unwrap()["error"],
            "resync_required"
        );
    }

    #[test]
    fn ops_jobs_retire_with_session_without_touching_other_sessions() {
        let (store, _dir) = fixture();
        store.ops_flush("a", "one", true, 1).unwrap();
        let other = store.ops_flush("b", "one", true, 1).unwrap();
        store.delete_session("a", "project-a").unwrap();
        assert!(store.ops_job("a", Some("one"), None).unwrap().is_none());
        assert_eq!(store.ops_job("b", Some("one"), None).unwrap(), Some(other));
    }

    #[test]
    fn ops_event_pages_are_byte_bounded_without_skipping_events() {
        let (store, _dir) = fixture();
        let targets = (0..512)
            .map(|id| format!("{id:04}{}", "x".repeat(252)))
            .collect::<Vec<_>>();
        store.append_pending_agent_drops("a", &targets, 1).unwrap();
        for id in 0..8 {
            store.ops_flush("a", &id.to_string(), true, id).unwrap();
        }
        let mut ack = 0;
        let mut seen = Vec::new();
        while ack < 8 {
            let page = store.ops_events("a", ack, 64).unwrap();
            assert!(page.to_string().len() < 1024 * 1024);
            for event in page["events"].as_array().unwrap() {
                seen.push(event["sequence"].as_i64().unwrap());
            }
            let next = page["next_position"].as_i64().unwrap();
            assert!(next > ack);
            ack = next;
        }
        assert_eq!(seen, (1..=8).collect::<Vec<_>>());
    }

    mod review {
        use super::*;
        include!("command_ledger_review_tests.rs");
    }
}

#[cfg(test)]
#[path = "command_ledger_flush_tests.rs"]
mod flush_tests;

#[cfg(test)]
mod repair_tests {
    use super::*;

    #[test]
    fn convenience_apis_require_canonical_project_without_creating_state() {
        let (store, _dir) = super::tests::fixture();
        assert!(store.ops_flush("unbound", "one", true, 1).is_err());
        assert!(store.ops_job("unbound", Some("one"), None).is_err());
        assert!(store.ops_events("unbound", 0, 64).is_err());
        assert!(store.ops_currentness("unbound", "unknown").is_err());
        assert!(!store.inner.with_conn(exists).unwrap());
        assert!(store.load_meta("unbound").unwrap().row_version.is_none());
    }

    #[test]
    fn project_scope_is_checked_inside_each_ledger_api() {
        let (store, _dir) = super::tests::fixture();
        let original = store.ops_flush("a", "one", true, 1).unwrap();
        store
            .with_context_conn_for_test(|conn| {
                conn.execute(
                    "UPDATE session_projects SET project_path='project-b' WHERE session_id='a'",
                    [],
                )
                .map(|_| ())
            })
            .unwrap();
        assert!(store
            .ops_flush_in_project("project-b", "a", "one", true, 2)
            .is_err());
        assert!(store
            .ops_job_in_project("project-b", "a", Some("one"), None)
            .is_err());
        assert!(store.ops_jobs_in_project("project-b", "a").is_err());
        assert!(store
            .ops_events_in_project("project-b", "a", 0, 64)
            .is_err());
        assert!(store
            .ops_currentness_in_project("project-b", "a", "unknown")
            .is_err());
        store
            .with_context_conn_for_test(|conn| {
                conn.execute(
                    "UPDATE session_projects SET project_path='project-a' WHERE session_id='a'",
                    [],
                )
                .map(|_| ())
            })
            .unwrap();
        assert_eq!(
            store.ops_job("a", Some("one"), None).unwrap(),
            Some(original)
        );
        assert_eq!(
            store.ops_events("a", 0, 64).unwrap()["events"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn old_session_only_ledger_is_not_adopted_by_a_project() {
        let (store, _dir) = super::tests::fixture();
        store.inner.with_conn(|conn| conn.execute_batch("CREATE TABLE mc_ops_commands(session_id TEXT,command_id TEXT,job TEXT); CREATE TABLE mc_ops_stream(session_id TEXT,sequence INTEGER,acked INTEGER); INSERT INTO mc_ops_commands VALUES('a','old','{\"private\":true}');")).unwrap();
        assert!(!store.ops_check_project("project-a", "a").unwrap());
        assert!(store.ops_job("a", Some("old"), None).is_err());
        assert!(store.ops_flush("a", "old", true, 1).is_err());
        assert_eq!(
            store
                .inner
                .with_conn(
                    |conn| conn.query_row("SELECT count(*) FROM mc_ops_commands", [], |r| r
                        .get::<_, i64>(0))
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn lazy_inventory_validates_present_tables_and_rejects_unknown_names() {
        use crate::move_inventory::{self, Class, RowSelector, Store};
        let (store, _dir) = super::tests::fixture();
        store
            .inner
            .with_conn(|conn| {
                move_inventory::validate_schema(conn, Store::Module).unwrap();
                Ok(())
            })
            .unwrap();
        store.ops_flush("a", "one", true, 1).unwrap();
        store
            .inner
            .with_conn(|conn| {
                move_inventory::validate_schema(conn, Store::Module).unwrap();
                for name in ["mc_ops_commands", "mc_ops_events", "mc_ops_stream"] {
                    let entry = move_inventory::entry(Store::Module, name).unwrap();
                    assert_eq!(entry.class, Class::LocalReset);
                    assert_eq!(entry.rows, RowSelector::None);
                    let schema = conn
                        .prepare(&format!("PRAGMA table_info({name})"))?
                        .query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, i64>(5)?)))?
                        .collect::<rusqlite::Result<Vec<_>>>()?;
                    assert_eq!(
                        schema
                            .iter()
                            .map(|(name, _)| name.as_str())
                            .collect::<Vec<_>>(),
                        entry.columns
                    );
                    let mut keys = schema
                        .iter()
                        .filter(|(_, order)| *order > 0)
                        .map(|(name, order)| (*order, name.as_str()))
                        .collect::<Vec<_>>();
                    keys.sort();
                    assert_eq!(
                        keys.into_iter().map(|(_, name)| name).collect::<Vec<_>>(),
                        entry.primary_key
                    );
                }
                conn.execute_batch("CREATE TABLE mc_ops_unknown_lazy(session_id TEXT)")?;
                let failure = move_inventory::validate_schema(conn, Store::Module).unwrap_err();
                assert!(failure.to_string().contains("mc_ops_unknown_lazy"));
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn move_payload_excludes_local_ui_ledger_but_preserves_refresh_arm() {
        let (store, dir) = super::tests::fixture();
        store.ops_flush("a", "local-ui-job", true, 1).unwrap();
        let mut conn = Connection::open(dir.path().join("store.db")).unwrap();
        let mut bytes = Vec::new();
        crate::move_snapshot::capture_half(
            &mut conn,
            crate::move_inventory::Store::Module,
            "a",
            &mut bytes,
        )
        .unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("mc_ops_"));
        let mut input = std::io::Cursor::new(bytes);
        let mut refresh = None;
        for table in crate::move_snapshot::ship_tables(crate::move_inventory::Store::Module) {
            for _ in 0..crate::move_snapshot::read_section(&mut input, table).unwrap() {
                let row = crate::move_snapshot::read_row(&mut input, table).unwrap();
                if table.table == "mc_cache_state" {
                    let index = table
                        .shipped_columns()
                        .iter()
                        .position(|c| *c == "meta")
                        .unwrap();
                    let rusqlite::types::Value::Text(meta) = &row[index] else {
                        panic!("missing meta")
                    };
                    refresh = Some(
                        serde_json::from_str::<Value>(meta).unwrap()["soft_refresh_pending"]
                            .clone(),
                    );
                }
            }
        }
        assert_eq!(refresh, Some(json!(true)));
    }
}
