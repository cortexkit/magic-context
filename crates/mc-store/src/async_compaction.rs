//! Async cursors and view versions are independent of the compatibility record.
//! A legacy record save must never reset a notice-driven reader's progress.
use crate::{McStore, McStoreError, McTagRow};
use rusqlite::{params, OptionalExtension};

/// Write accounting for one async conversation, compiled only for sibling-crate
/// tests. It lets a test prove that a notice's write set does not grow with the
/// held transcript, and lets a benchmark report write-transaction time.
#[cfg(feature = "test-support")]
pub mod write_meter {
    use std::collections::BTreeMap;
    use std::sync::Mutex;
    use std::time::Instant;

    /// Totals since the meter was armed for a conversation. `bytes` counts the
    /// text/blob cells written; `rows` counts rows inserted, updated or deleted;
    /// `nanos` is the wall time of the fenced write calls, including waiting
    /// for the writer connection and the write lock; `held_nanos` is the time
    /// the write lock was held, from the first statement through COMMIT.
    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
    pub struct AsyncWriteStats {
        pub transactions: u64,
        pub rows: u64,
        pub bytes: u64,
        pub nanos: u64,
        pub held_nanos: u64,
    }

    static METERS: Mutex<BTreeMap<String, AsyncWriteStats>> = Mutex::new(BTreeMap::new());

    /// Start (or restart) counting writes for `session_ref`.
    pub fn arm(session_ref: &str) {
        METERS
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(session_ref.into(), AsyncWriteStats::default());
    }

    /// The totals for an armed conversation; `None` when it is not armed.
    pub fn read(session_ref: &str) -> Option<AsyncWriteStats> {
        METERS
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(session_ref)
            .copied()
    }

    pub(crate) fn record(
        session_ref: &str,
        started: Instant,
        held: Instant,
        rows: u64,
        bytes: u64,
    ) {
        let mut meters = METERS.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(stats) = meters.get_mut(session_ref) {
            stats.transactions += 1;
            stats.rows += rows;
            stats.bytes += bytes;
            stats.nanos += started.elapsed().as_nanos() as u64;
            stats.held_nanos += held.elapsed().as_nanos() as u64;
        }
    }
}

/// Wrap a fenced-write callback so it also reports when it started, that is,
/// once the IMMEDIATE transaction holds the write lock.
fn held<T>(
    write: impl FnOnce(&rusqlite::Transaction<'_>) -> rusqlite::Result<(T, u64, u64)>,
) -> impl FnOnce(&rusqlite::Transaction<'_>) -> rusqlite::Result<(T, u64, u64, std::time::Instant)>
{
    move |conn| {
        let started = std::time::Instant::now();
        write(conn).map(|(value, rows, bytes)| (value, rows, bytes, started))
    }
}

/// Records one fenced write for the test meter; compiles to nothing otherwise.
macro_rules! metered {
    ($session_ref:expr, $write:expr) => {{
        #[cfg(feature = "test-support")]
        let started = std::time::Instant::now();
        let result = $write;
        #[cfg(feature = "test-support")]
        if let Ok((_, rows, bytes, held)) = &result {
            write_meter::record($session_ref, started, *held, *rows, *bytes);
        }
        result.map(|(value, ..)| value)
    }};
}

fn cut_history_roots(
    conn: &rusqlite::Connection,
    reference: &str,
) -> rusqlite::Result<Vec<String>> {
    let mut roots = conn.prepare("SELECT view_json FROM mc_async_compaction_baselines WHERE session_ref=?1 AND slot GLOB 'published-cut-root:*'
        UNION ALL SELECT CASE WHEN json_valid(view_json) THEN json_quote(json_extract(view_json,'$.recovery_history_ref.root')) ELSE 'null' END
        FROM mc_async_compaction_baselines WHERE session_ref=?1 AND slot GLOB 'cut:*'")?
        .query_map([reference], |row| row.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
    roots.sort();
    Ok(roots)
}

// Decode only the root pointer, without allocating the archived window fields.
#[derive(serde::Deserialize)]
struct CutArchiveRoot {
    #[serde(default)]
    recovery_history_ref: Option<CutArchiveRootId>,
}

#[derive(serde::Deserialize)]
struct CutArchiveRootId {
    root: Option<String>,
}

#[derive(serde::Deserialize)]
struct CutSeedAlias {
    #[serde(default)]
    seed_suffix: Option<String>,
}

#[derive(serde::Deserialize)]
struct CutCandidateLookup {
    key: String,
    first_ordinal: u64,
    mid: String,
    digest: String,
    #[serde(default)]
    legacy_seed_suffix: Option<String>,
}

fn cut_candidates(
    conn: &rusqlite::Connection,
    reference: &str,
    first: u64,
) -> rusqlite::Result<Vec<String>> {
    conn.prepare(
        "SELECT view_json FROM mc_async_compaction_baselines WHERE session_ref=?1 AND slot GLOB ?2",
    )?
    .query_map(
        params![reference, format!("published-cut-candidate:{first:020}:*")],
        |row| row.get(0),
    )?
    .collect()
}

fn cut_history_objects(
    conn: &rusqlite::Connection,
    reference: &str,
    root: Option<&str>,
) -> rusqlite::Result<Option<Vec<(String, String)>>> {
    let mut pending = root
        .into_iter()
        .map(|id| format!("cut-history:{id}"))
        .collect::<Vec<_>>();
    let mut seen = std::collections::BTreeSet::new();
    let mut objects = Vec::new();
    while let Some(slot) = pending.pop() {
        if !seen.insert(slot.clone()) {
            continue;
        }
        let Some(raw) = conn.query_row("SELECT view_json FROM mc_async_compaction_baselines WHERE session_ref=?1 AND slot=?2",
            params![reference,slot], |row| row.get::<_, String>(0)).optional()? else { return Ok(None) };
        if slot.starts_with("cut-history:b:") {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(children) = value.get("Branch").and_then(|value| value.as_array()) {
                    for id in children.iter().filter_map(|value| value.as_str()) {
                        pending.push(format!("cut-history:{id}"));
                    }
                }
            }
        }
        objects.push((slot, raw));
    }
    Ok(Some(objects))
}

fn cut_bundle(
    conn: &rusqlite::Connection,
    reference: &str,
    key: &str,
) -> rusqlite::Result<Option<AsyncCutBundle>> {
    let metadata = conn
        .query_row(
            "SELECT view_json FROM mc_async_compaction_baselines WHERE session_ref=?1 AND slot=?2",
            params![reference, format!("published-cut-meta:{key}")],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let suffix = metadata
        .as_ref()
        .and_then(|raw| serde_json::from_str::<CutSeedAlias>(raw).ok())
        .and_then(|alias| alias.seed_suffix)
        .unwrap_or_else(|| key.to_owned());
    let seed = conn
        .query_row(
            "SELECT view_json FROM mc_async_compaction_baselines WHERE session_ref=?1 AND slot=?2",
            params![reference, format!("published-cut:{suffix}")],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let Some(seed) = seed else { return Ok(None) };
    let root = serde_json::from_str::<CutArchiveRoot>(&seed)
        .ok()
        .and_then(|value| value.recovery_history_ref)
        .and_then(|value| value.root);
    let Some(history_objects) = cut_history_objects(conn, reference, root.as_deref())? else {
        return Ok(None);
    };
    Ok(Some(AsyncCutBundle {
        metadata,
        seed,
        history_objects,
    }))
}

impl McStore {
    /// Thin candidate identities, never full seeds or rendered heads.
    pub fn load_async_cut_candidates(
        &self,
        reference: &str,
        first: u64,
    ) -> Result<Vec<String>, McStoreError> {
        self.inner
            .with_read(|conn| cut_candidates(conn, reference, first))
            .map_err(Into::into)
    }

    /// A head without a publishing lineage is usable only when exactly one
    /// retained target matches its ordinal, message id and digest.
    pub fn load_async_cut_bundle_for_head(
        &self,
        reference: &str,
        first: u64,
        mid: &str,
        digest: &str,
    ) -> Result<Option<AsyncCutBundle>, McStoreError> {
        self.inner.with_read(|conn| {
            let snapshot = if conn.is_autocommit() { Some(conn.unchecked_transaction()?) } else { None };
            let mut selected = Vec::new();
            let mut legacy_covered = false;
            let legacy_suffix = first.to_string();
            for raw in cut_candidates(conn, reference, first)? {
                let Ok(candidate) = serde_json::from_str::<CutCandidateLookup>(&raw) else { return Ok(None) };
                legacy_covered |= candidate.legacy_seed_suffix.as_deref() == Some(legacy_suffix.as_str());
                if candidate.first_ordinal == first && candidate.mid == mid && candidate.digest == digest {
                    selected.push(candidate.key);
                }
            }
            if !legacy_covered {
                #[derive(serde::Deserialize)]
                struct Identity { first_ordinal: u64, cut_mid: String, cut_digest: String }
                let raw = conn.query_row("SELECT view_json FROM mc_async_compaction_baselines WHERE session_ref=?1 AND slot=?2",
                    params![reference,format!("published-cut:{first}")], |row| row.get::<_, String>(0)).optional()?;
                if let Some(raw) = raw {
                    let Ok(identity) = serde_json::from_str::<Identity>(&raw) else { return Ok(None) };
                    if identity.first_ordinal == first && identity.cut_mid == mid && identity.cut_digest == digest {
                        selected.push(first.to_string());
                    }
                }
            }
            if selected.len() != 1 { return Ok(None); }
            let bundle = cut_bundle(conn, reference, &selected[0])?;
            if let Some(snapshot) = snapshot { snapshot.commit()?; }
            Ok(bundle)
        }).map_err(Into::into)
    }

    /// Read a selected lineage/ordinal target and its immutable history in one
    /// snapshot, including legacy numeric payloads referenced by its descriptor.
    pub fn load_async_cut_bundle(
        &self,
        reference: &str,
        key: &str,
    ) -> Result<Option<AsyncCutBundle>, McStoreError> {
        self.inner
            .with_read(|conn| {
                let snapshot = if conn.is_autocommit() {
                    Some(conn.unchecked_transaction()?)
                } else {
                    None
                };
                let bundle = cut_bundle(conn, reference, key)?;
                if let Some(snapshot) = snapshot {
                    snapshot.commit()?;
                }
                Ok(bundle)
            })
            .map_err(Into::into)
    }

    /// Recovery of active cut facts needs only the selected immutable graph,
    /// also under a reader snapshot rather than one transaction per object.
    pub fn load_async_cut_history_objects(
        &self,
        reference: &str,
        root: Option<&str>,
    ) -> Result<Option<Vec<(String, String)>>, McStoreError> {
        self.inner
            .with_read(|conn| {
                let snapshot = if conn.is_autocommit() {
                    Some(conn.unchecked_transaction()?)
                } else {
                    None
                };
                let objects = cut_history_objects(conn, reference, root)?;
                if let Some(snapshot) = snapshot {
                    snapshot.commit()?;
                }
                Ok(objects)
            })
            .map_err(Into::into)
    }

    /// Read one kept baseline without hydrating the session's transcript.
    pub fn load_async_compaction_baseline(
        &self,
        reference: &str,
        slot: &str,
    ) -> Result<Option<String>, McStoreError> {
        Ok(self.inner.with_conn(|conn| {
            conn.query_row(
            "SELECT view_json FROM mc_async_compaction_baselines WHERE session_ref=?1 AND slot=?2",
            params![reference, slot], |row| row.get(0),
        ).optional()
        })?)
    }
    /// Historical native edits are read only when a lineage restarts before
    /// its cuts. Ordinary conversation loads exclude these archive rows.
    pub fn load_async_undo_edits(&self, session_ref: &str) -> Result<Vec<String>, McStoreError> {
        self.inner.with_read(|conn| {
            conn.prepare("SELECT view_json FROM mc_async_compaction_baselines WHERE session_ref=?1 AND slot GLOB 'undo-native-edits:*' ORDER BY slot")?
                .query_map([session_ref], |row| row.get(0))?
                .collect::<rusqlite::Result<Vec<String>>>()
        }).map_err(Into::into)
    }

    /// Re-anchor only the edits of the current live window. Archive lookup is
    /// keyed by message id, so an old cut does not scan the session's history.
    pub fn load_async_undo_edits_for_messages(
        &self,
        session_ref: &str,
        mids: &[String],
    ) -> Result<Vec<String>, McStoreError> {
        let mids =
            serde_json::to_string(mids).map_err(|error| McStoreError::Serde(error.to_string()))?;
        self.inner.with_read(|conn| {
            conn.prepare("SELECT b.view_json FROM json_each(?2) AS wanted CROSS JOIN mc_async_compaction_baselines b ON b.session_ref=?1 AND b.slot='undo-native-edits:mid:'||wanted.value")?
                .query_map(params![session_ref, mids], |row| row.get(0))?
                .collect::<rusqlite::Result<Vec<String>>>()
        }).map_err(Into::into)
    }

    /// Start counting this conversation's async-table writes (test builds only).
    #[cfg(feature = "test-support")]
    pub fn arm_async_write_meter(&self, session_ref: &str) {
        write_meter::arm(session_ref);
    }
    /// Writes counted since [`Self::arm_async_write_meter`] (test builds only).
    #[cfg(feature = "test-support")]
    pub fn async_write_stats(&self, session_ref: &str) -> Option<write_meter::AsyncWriteStats> {
        write_meter::read(session_ref)
    }
    pub fn clear_async_compaction_drops(&self, namespace: &str) -> Result<usize, McStoreError> {
        self.inner
            .with_conn_fenced(|conn| {
                conn.execute(
                    "DELETE FROM pending_agent_drops WHERE session_id=?1",
                    [namespace],
                )
            })
            .map_err(Into::into)
    }

    /// Delete an engine namespace's per-message rows for the messages `mids`,
    /// in one transaction: their tag rows (and the consumed marks of those
    /// tags), block identities, temporal marks, user hints, Channel-1
    /// appends and queued drops. For a cut: the messages below it never
    /// render again. Frozen units live in the cache state and are pruned
    /// through a cache-state commit. Returns the number of queued drops
    /// removed.
    pub fn prune_namespace_messages(
        &self,
        namespace: &str,
        mids: &[String],
    ) -> Result<usize, McStoreError> {
        if mids.is_empty() {
            return Ok(0);
        }
        let mids =
            serde_json::to_string(mids).map_err(|error| McStoreError::Serde(error.to_string()))?;
        // A block id is `mid#index`; a few tables key whole messages by mid.
        const MID: &str = "CASE WHEN instr(block_id,'#')>0 THEN substr(block_id,1,instr(block_id,'#')-1) ELSE block_id END";
        self.inner
            .with_conn_fenced(|conn| {
                conn.execute(
                    &format!("DELETE FROM mc_provider_consumed_tags_v1 WHERE engine_namespace=?1 AND tag_number IN
                        (SELECT tag_number FROM mc_tags WHERE session_id=?1 AND {MID} IN (SELECT value FROM json_each(?2)))"),
                    params![namespace, mids],
                )?;
                for table in ["mc_tags", "mc_temporal_marks", "mc_user_hints", "mc_channel1_appends"] {
                    conn.execute(
                        &format!("DELETE FROM {table} WHERE session_id=?1 AND {MID} IN (SELECT value FROM json_each(?2))"),
                        params![namespace, mids],
                    )?;
                }
                conn.execute(
                    "DELETE FROM mc_block_identities WHERE session_id=?1 AND mid IN (SELECT value FROM json_each(?2))",
                    params![namespace, mids],
                )?;
                let drops = conn.execute(
                    &format!("DELETE FROM pending_agent_drops WHERE session_id=?1 AND {} IN (SELECT value FROM json_each(?2))", MID.replace("block_id", "target_id")),
                    params![namespace, mids],
                )?;
                Ok(drops)
            })
            .map_err(Into::into)
    }
    /// Copy source-validated history artifacts without invoking an embedding model.
    /// The caller retains its resync intent until this idempotent copy completes.
    pub fn copy_async_history_artifacts(
        &self,
        source: &str,
        target: &str,
        sequences: &[(i64, i64)],
    ) -> Result<usize, McStoreError> {
        self.resume_pending_context_write(source)?;
        self.resume_pending_context_write(target)?;
        let (copied,mapped)=self.context_write(&["compartments","compartment_chunk_embeddings"],|conn| {
            let mut copied=0;
            let mut mapped=Vec::new();
            for (old_sequence,new_sequence) in sequences {
                let ids:Option<(i64,i64,i64)>=conn.query_row("SELECT old.id,new.id,new.start_message-old.start_message FROM compartments old JOIN compartments new
                    ON new.session_id=?2 AND new.sequence=?4 WHERE old.session_id=?1 AND old.sequence=?3
                    AND old.content=new.content AND old.p1 IS new.p1 AND old.p2 IS new.p2 AND old.p3 IS new.p3 AND old.p4 IS new.p4",
                    params![source,target,old_sequence,new_sequence],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional()?;
                let Some((old_id,new_id,shift))=ids else {continue;};
                mapped.push((*old_sequence,*new_sequence,shift));
                conn.execute("UPDATE compartments SET p1_embedding=(SELECT p1_embedding FROM compartments WHERE id=?1),p1_embedding_model_id=(SELECT p1_embedding_model_id FROM compartments WHERE id=?1) WHERE id=?2",params![old_id,new_id])?;
                copied+=conn.execute("INSERT INTO compartment_chunk_embeddings(compartment_id,session_id,project_path,harness,window_index,start_ordinal,end_ordinal,chunk_hash,model_id,dims,vector,created_at)
                    SELECT ?2,?3,project_path,harness,window_index,start_ordinal+?4,end_ordinal+?4,chunk_hash,model_id,dims,vector,created_at FROM compartment_chunk_embeddings WHERE compartment_id=?1
                    ON CONFLICT(compartment_id,model_id,window_index) DO UPDATE SET session_id=excluded.session_id,project_path=excluded.project_path,harness=excluded.harness,start_ordinal=excluded.start_ordinal,end_ordinal=excluded.end_ordinal,chunk_hash=excluded.chunk_hash,dims=excluded.dims,vector=excluded.vector,created_at=excluded.created_at",
                    params![old_id,new_id,target,shift])?;
            }
            Ok((copied,mapped))
        })?;
        self.inner.with_conn_fenced(|conn| {
            for (old_sequence,new_sequence,shift) in mapped {
                conn.execute("INSERT INTO mc_chunk_transcripts(session_id,compartment_seq,start_ordinal,end_ordinal,transcript_deflate,created_at_ms) SELECT ?2,?4,start_ordinal+?5,end_ordinal+?5,transcript_deflate,created_at_ms FROM mc_chunk_transcripts WHERE session_id=?1 AND compartment_seq=?3
                    ON CONFLICT(session_id,compartment_seq) DO UPDATE SET start_ordinal=excluded.start_ordinal,end_ordinal=excluded.end_ordinal,transcript_deflate=excluded.transcript_deflate,created_at_ms=excluded.created_at_ms",params![source,target,old_sequence,new_sequence,shift])?;
            }
            Ok(())
        })?;
        Ok(copied)
    }
    pub fn retire_unannounced_async_views(&self, session_ref: &str) -> Result<(), McStoreError> {
        metered!(session_ref, self.inner.with_conn_fenced(held(|conn|conn.execute("UPDATE mc_async_compaction_views SET announced=-1 WHERE session_ref=?1 AND announced=0",[session_ref]).map(|rows|((),rows as u64,0)))).map_err(McStoreError::from))
    }

    /// A failed cut stage must not announce a view with no saved adoption seed.
    pub fn retire_unannounced_async_view(
        &self,
        reference: &str,
        version: u64,
    ) -> Result<(), McStoreError> {
        self.inner.with_conn_fenced(|tx| {
            tx.execute("UPDATE mc_async_compaction_views SET announced=-1 WHERE session_ref=?1 AND version=?2 AND announced=0", params![reference, version])?;
            Ok(())
        })?;
        Ok(())
    }
    /// The records of every conversation `runner` holds for `session`, whatever
    /// its harness. A runner conversation's key starts with its runner module
    /// id, never a project folder.
    pub fn async_compaction_for_session(
        &self,
        runner: &str,
        session: &str,
    ) -> Result<Vec<String>, McStoreError> {
        self.inner.with_conn(|conn| {
            let mut query=conn.prepare("SELECT state_json FROM mc_async_compaction WHERE session=?2 AND json_extract(conversation_key,'$[0]')=?1")?;
            let rows=query.query_map(params![runner,session],|row|row.get(0))?;
            rows.collect()
        }).map_err(Into::into)
    }

    /// Read only the project metadata saved in serialized compaction state, not its potentially large
    /// serialized compaction state. Multiple conversations remain ambiguous.
    pub fn async_compaction_projects_for_session(
        &self,
        runner: Option<&str>,
        session: &str,
    ) -> Result<Vec<(String, Option<String>)>, McStoreError> {
        self.inner.with_conn(|conn| {
            let mut query = conn.prepare("SELECT json_extract(state_json,'$.runner_identity.project_root'), json_extract(state_json,'$.dream_target.project') FROM mc_async_compaction WHERE session=?1 AND (?2 IS NULL OR json_extract(conversation_key,'$[0]')=?2) AND json_type(state_json,'$.runner_identity.project_root')='text'")?;
            let rows = query.query_map(params![session, runner], |row| Ok((row.get(0)?, row.get(1)?)))?;
            rows.collect()
        }).map_err(Into::into)
    }
    /// The records of every conversation held for `session`, whatever its
    /// runner or harness. The caller decides which of them it may reach.
    pub fn async_compaction_records_for_session(
        &self,
        session: &str,
    ) -> Result<Vec<String>, McStoreError> {
        self.inner
            .with_conn(|conn| {
                let mut query =
                    conn.prepare("SELECT state_json FROM mc_async_compaction WHERE session=?1")?;
                let rows = query.query_map([session], |row| row.get(0))?;
                rows.collect()
            })
            .map_err(Into::into)
    }
    pub fn load_async_compaction(&self, session_ref: &str) -> Result<Option<String>, McStoreError> {
        self.inner
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT state_json FROM mc_async_compaction WHERE session_ref=?1",
                    [session_ref],
                    |row| row.get(0),
                )
                .optional()
            })
            .map_err(Into::into)
    }

    pub fn async_compaction_for_key(&self, key: &str) -> Result<bool, McStoreError> {
        self.inner
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM mc_async_compaction WHERE conversation_key=?1)",
                    [key],
                    |row| row.get(0),
                )
            })
            .map_err(Into::into)
    }

    /// Begin one atomic save of an async conversation: the small record plus
    /// only the row changes the caller adds. Nothing is written until
    /// [`AsyncCompactionSave::commit`].
    pub fn async_compaction_save<'a>(
        &'a self,
        session_ref: &'a str,
        key: &'a str,
        session: &'a str,
        state: &'a str,
    ) -> AsyncCompactionSave<'a> {
        AsyncCompactionSave {
            store: self,
            session_ref,
            key,
            session,
            state,
            namespace: "",
            tags: &[],
            forget_tags_of: Vec::new(),
            truncate_entries: None,
            truncate_below: None,
            entries: Vec::new(),
            replaced_entries: Vec::new(),
            baselines: Vec::new(),
            immutable_baselines: Vec::new(),
            active_cut_slot: None,
            clear_engine_views: false,
            retain_views_from: None,
        }
    }

    /// Small root references and object names for publication-time archive GC.
    /// This index never reads archived seed or compartment payloads.
    pub fn async_cut_history_index(
        &self,
        reference: &str,
    ) -> Result<(Vec<String>, Vec<String>), McStoreError> {
        self.inner.with_read(|conn| {
            let roots = cut_history_roots(conn, reference)?;
            let objects = conn.prepare("SELECT slot FROM mc_async_compaction_baselines WHERE session_ref=?1 AND slot GLOB 'cut-history:*'")?
                .query_map([reference], |row| row.get(0))?.collect::<rusqlite::Result<_>>()?;
            Ok((roots, objects))
        }).map_err(Into::into)
    }

    /// Reclaim only archive objects whose roots have already been replaced
    /// durably. The caller completes reachability marking before any deletion.
    /// Return false if a root changed under the writer fence, leaving all
    /// objects intact so a later publication can retry with the new roots.
    pub fn discard_async_cut_history_objects(
        &self,
        reference: &str,
        slots: &[String],
        expected_roots: &[String],
    ) -> Result<bool, McStoreError> {
        metered!(reference, self.inner.with_conn_fenced(held(|conn| {
            if cut_history_roots(conn, reference)? != expected_roots { return Ok((false, 0, 0)); }
            let mut rows = 0;
            let mut delete = conn.prepare_cached("DELETE FROM mc_async_compaction_baselines WHERE session_ref=?1 AND slot=?2 AND slot GLOB 'cut-history:*'")?;
            for slot in slots { rows += delete.execute(params![reference, slot])? as u64; }
            Ok((true, rows, 0))
        }))).map_err(Into::into)
    }

    /// Hot record, entries and engine baselines in one reader snapshot, so a
    /// long transcript never holds the writer. Cold cut/undo archives are
    /// excluded and fetched by identity only when recovery selects them.
    pub fn load_async_compaction_rows(
        &self,
        session_ref: &str,
    ) -> Result<Option<AsyncCompactionRows>, McStoreError> {
        self.inner
            .with_read(|conn| {
                let Some(state) = conn
                    .query_row(
                        "SELECT state_json FROM mc_async_compaction WHERE session_ref=?1",
                        [session_ref],
                        |row| row.get(0),
                    )
                    .optional()?
                else {
                    return Ok(None);
                };
                let entries = conn
                    .prepare("SELECT ordinal,entry_json,index_json FROM mc_async_compaction_entries WHERE session_ref=?1 ORDER BY ordinal")?
                    .query_map([session_ref], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
                    .collect::<rusqlite::Result<_>>()?;
                let engine_views = conn
                    .prepare("SELECT version,engine_json FROM mc_async_compaction_views WHERE session_ref=?1 AND engine_json IS NOT NULL ORDER BY version")?
                    .query_map([session_ref], |row| Ok((row.get(0)?, row.get(1)?)))?
                    .collect::<rusqlite::Result<_>>()?;
                // Equality probes use the existing (session_ref, slot) key.
                // Excluding archive prefixes would still visit every cold key.
                let baselines = conn
                    .prepare("SELECT slot,view_json FROM mc_async_compaction_baselines WHERE session_ref=?1 AND slot IN ('applied','produced','frozen_edits','retired_native_edits','pending-cut-stage')")?
                    .query_map([session_ref], |row| Ok((row.get(0)?, row.get(1)?)))?
                    .collect::<rusqlite::Result<_>>()?;
                Ok(Some(AsyncCompactionRows {
                    state,
                    entries,
                    engine_views,
                    baselines,
                }))
            })
            .map_err(Into::into)
    }

    /// When the runner wrote the newest held entry (its `written_at`, ms), read
    /// from that one row. `None` when nothing is held or it carries no time.
    pub fn newest_async_entry_written_at(
        &self,
        session_ref: &str,
    ) -> Result<Option<u64>, McStoreError> {
        self.inner
            .with_read(|conn| {
                let entry: Option<String> = conn
                    .query_row(
                        "SELECT entry_json FROM mc_async_compaction_entries WHERE session_ref=?1 ORDER BY ordinal DESC LIMIT 1",
                        [session_ref],
                        |row| row.get(0),
                    )
                    .optional()?;
                Ok(entry
                    .and_then(|entry| serde_json::from_str::<serde_json::Value>(&entry).ok())
                    .and_then(|entry| entry.get("written_at").and_then(serde_json::Value::as_u64)))
            })
            .map_err(Into::into)
    }

    /// The stored entries of a conversation through `through` (inclusive),
    /// `(ordinal, entry_json)` in ordinal order, read from a reader
    /// connection: for background work that needs the whole held transcript
    /// without the in-memory copy.
    pub fn load_async_compaction_entries(
        &self,
        session_ref: &str,
        through: u64,
    ) -> Result<Vec<(u64, String)>, McStoreError> {
        self.load_async_compaction_entries_range(session_ref, 0, through)
    }

    /// Read an inclusive ordinal window without loading covered entry payloads.
    pub fn load_async_compaction_entries_range(
        &self,
        session_ref: &str,
        from: u64,
        through: u64,
    ) -> Result<Vec<(u64, String)>, McStoreError> {
        self.inner
            .with_read(|conn| {
                conn.prepare("SELECT ordinal,entry_json FROM mc_async_compaction_entries WHERE session_ref=?1 AND ordinal>=?2 AND ordinal<=?3 ORDER BY ordinal")?
                    .query_map(params![session_ref, from, through], |row| Ok((row.get(0)?, row.get(1)?)))?
                    .collect::<rusqlite::Result<_>>()
            })
            .map_err(Into::into)
    }

    /// Reserve before building a view. A crash skips the reservation, never reuses it.
    pub fn reserve_async_compaction_version(
        &self,
        session_ref: &str,
        applied: u64,
    ) -> Result<u64, McStoreError> {
        metered!(
            session_ref,
            self.inner
                .with_conn_fenced(held(|conn| {
                    conn.query_row(
                        "UPDATE mc_async_compaction SET version_high_water=max(version_high_water,?2)+1
                WHERE session_ref=?1 RETURNING version_high_water",
                        params![session_ref, applied],
                        |row| row.get(0),
                    )
                    .map(|version| (version, 1, 0))
                }))
                .map_err(McStoreError::from)
        )
    }

    pub fn save_async_compaction_view(
        &self,
        session_ref: &str,
        version: u64,
        view: &str,
        engine: &str,
    ) -> Result<(), McStoreError> {
        metered!(
            session_ref,
            self.inner
                .with_conn_fenced(held(|conn| {
                    conn.execute(
            "INSERT INTO mc_async_compaction_views(session_ref,session,version,view_json,engine_json) SELECT ?1,session,?2,?3,?4 FROM mc_async_compaction WHERE session_ref=?1",
            params![session_ref,version,view,engine],
        ).map(|rows| ((), rows as u64, (view.len() + engine.len()) as u64))
                }))
                .map_err(McStoreError::from)
        )
    }

    /// Remove a deferred cut from its still-private view. Once announced, the
    /// version is immutable and this update must refuse rather than rewrite it.
    pub fn revise_unannounced_async_compaction_view(
        &self,
        reference: &str,
        version: u64,
        view: &str,
    ) -> Result<(), McStoreError> {
        let changed = metered!(reference, self.inner.with_conn_fenced(held(|conn| {
            let rows = conn.execute("UPDATE mc_async_compaction_views SET view_json=?3 WHERE session_ref=?1 AND version=?2 AND announced=0", params![reference, version, view])?;
            Ok((rows, rows as u64, if rows > 0 { view.len() as u64 } else { 0 }))
        })).map_err(McStoreError::from))?;
        if changed != 1 {
            return Err(McStoreError::Serde(
                "async view is missing or already announced".into(),
            ));
        }
        Ok(())
    }

    pub fn load_async_compaction_view(
        &self,
        session_ref: &str,
        version: u64,
    ) -> Result<Option<String>, McStoreError> {
        self.inner
            .with_conn(|conn| {
                conn.query_row(
            "SELECT view_json FROM mc_async_compaction_views WHERE session_ref=?1 AND version=?2",
            params![session_ref,version], |row| row.get(0),
        ).optional()
            })
            .map_err(Into::into)
    }

    /// The conversation's retained views: `(version, view_json, engine_json,
    /// announced)` in version order, and its version high-water.
    #[allow(clippy::type_complexity)]
    pub fn load_async_compaction_views(
        &self,
        session_ref: &str,
    ) -> Result<(Vec<(u64, String, Option<String>, bool)>, u64), McStoreError> {
        self.inner
            .with_read(|conn| {
                let views = conn
                    .prepare("SELECT version,view_json,engine_json,announced FROM mc_async_compaction_views WHERE session_ref=?1 ORDER BY version")?
                    .query_map([session_ref], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get::<_, i64>(3)? != 0)))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                let high = conn
                    .query_row(
                        "SELECT version_high_water FROM mc_async_compaction WHERE session_ref=?1",
                        [session_ref],
                        |row| row.get(0),
                    )
                    .optional()?
                    .unwrap_or(0);
                Ok((views, high))
            })
            .map_err(Into::into)
    }

    /// Store views a conversation keeps from the lineage it descends from,
    /// with their announcement state, and raise its version high-water to at
    /// least `high`. The conversation's record must exist.
    pub fn adopt_async_compaction_views(
        &self,
        session_ref: &str,
        views: &[(u64, String, Option<String>, bool)],
        high: u64,
    ) -> Result<(), McStoreError> {
        self.inner
            .with_conn_fenced(|conn| {
                for (version, view, engine, announced) in views {
                    conn.execute(
                        "INSERT OR REPLACE INTO mc_async_compaction_views(session_ref,session,version,view_json,engine_json,announced)
                            SELECT ?1,session,?2,?3,?4,?5 FROM mc_async_compaction WHERE session_ref=?1",
                        params![session_ref, version, view, engine, *announced as i64],
                    )?;
                }
                conn.execute(
                    "UPDATE mc_async_compaction SET version_high_water=max(version_high_water,?2) WHERE session_ref=?1",
                    params![session_ref, high],
                )?;
                Ok(())
            })
            .map_err(Into::into)
    }

    pub fn pending_async_compaction_views(
        &self,
    ) -> Result<Vec<(String, u64, String)>, McStoreError> {
        self.inner.with_conn(|conn| {
            let mut query = conn.prepare("SELECT session_ref,version,view_json FROM mc_async_compaction_views WHERE announced=0 ORDER BY session_ref,version")?;
            let rows = query.query_map([], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)))?;
            rows.collect()
        }).map_err(Into::into)
    }

    pub fn mark_async_compaction_announced(
        &self,
        session_ref: &str,
        version: u64,
    ) -> Result<(), McStoreError> {
        metered!(
            session_ref,
            self.inner
                .with_conn_fenced(held(|conn| {
                    conn.execute(
            "UPDATE mc_async_compaction_views SET announced=1 WHERE session_ref=?1 AND version=?2",
            params![session_ref,version],
        ).map(|rows| ((), rows as u64, 0))
                }))
                .map_err(McStoreError::from)
        )
    }
}

/// A selected cut's descriptor, full seed and immutable history, owned by the
/// caller after the reader snapshot ends and old archive nodes may be reclaimed.
pub struct AsyncCutBundle {
    pub metadata: Option<String>,
    pub seed: String,
    pub history_objects: Vec<(String, String)>,
}

/// The hot rows of one async conversation, as read by
/// [`McStore::load_async_compaction_rows`].
pub struct AsyncCompactionRows {
    pub state: String,
    /// `(ordinal, entry_json, index_json)` in ordinal order.
    pub entries: Vec<(u64, String, String)>,
    /// `(version, engine_json)` for published views still usable as an
    /// engine baseline, in version order.
    pub engine_views: Vec<(u64, String)>,
    /// `(slot, view_json)` for hot baselines outside the published views.
    /// Cut facts and cold cut/history/undo archives use named point reads.
    pub baselines: Vec<(String, String)>,
}

/// One pending atomic save; see [`McStore::async_compaction_save`].
pub struct AsyncCompactionSave<'a> {
    store: &'a McStore,
    session_ref: &'a str,
    key: &'a str,
    session: &'a str,
    state: &'a str,
    namespace: &'a str,
    tags: &'a [McTagRow],
    forget_tags_of: Vec<String>,
    truncate_entries: Option<Option<u64>>,
    truncate_below: Option<u64>,
    entries: Vec<(u64, String, String)>,
    replaced_entries: Vec<(u64, String, String)>,
    baselines: Vec<(String, Option<String>)>,
    immutable_baselines: Vec<(String, String)>,
    active_cut_slot: Option<Option<String>>,
    clear_engine_views: bool,
    retain_views_from: Option<u64>,
}

impl<'a> AsyncCompactionSave<'a> {
    /// Runner tag rows to import into the engine namespace's tag table.
    pub fn tags(&mut self, namespace: &'a str, tags: &'a [McTagRow]) -> &mut Self {
        self.namespace = namespace;
        self.tags = tags;
        self
    }

    /// Forget the namespace's tag rows of these message ids, and their
    /// consumed marks, before this save's new rows are imported. A tag number
    /// names a part only within one lineage: after a cut, the new lineage may
    /// show the same number on another part, which must not find the old row.
    pub fn forget_tags_of(&mut self, mids: Vec<String>) -> &mut Self {
        self.forget_tags_of.extend(mids);
        self
    }

    /// Delete held entries after `through` (all entries for `None`) before
    /// appending. Several calls keep the earliest cut.
    pub fn truncate_entries(&mut self, through: Option<u64>) -> &mut Self {
        self.truncate_entries = Some(match (self.truncate_entries, through) {
            (Some(None), _) | (_, None) => None,
            (Some(Some(held)), Some(through)) => Some(held.min(through)),
            (None, Some(through)) => Some(through),
        });
        self
    }

    /// Delete held entries before `first` (the rows below a cut). Several
    /// calls keep the latest cut.
    pub fn truncate_below(&mut self, first: u64) -> &mut Self {
        self.truncate_below = Some(self.truncate_below.map_or(first, |held| held.max(first)));
        self
    }

    /// Append one new held entry. An ordinal that is already stored is an
    /// error, never an overwrite: held entries are immutable.
    pub fn append_entry(
        &mut self,
        ordinal: u64,
        entry_json: String,
        index_json: String,
    ) -> &mut Self {
        self.entries.push((ordinal, entry_json, index_json));
        self
    }

    /// Rewrite one already stored held entry in place. Held entries are
    /// otherwise immutable; the only rewrite the runner contract allows is
    /// a re-read that differs from the stored copy in archive-pruned
    /// reasoning alone (llm-runner `archive_prunes_reasoning`), whose
    /// identities, ordering and write-time digests do not move. Rewriting an
    /// ordinal that is not stored is an error, never an insert.
    pub fn replace_entry(
        &mut self,
        ordinal: u64,
        entry_json: String,
        index_json: String,
    ) -> &mut Self {
        self.replaced_entries
            .push((ordinal, entry_json, index_json));
        self
    }

    /// Store (`Some`) or remove (`None`) the baseline kept in `slot`.
    pub fn baseline(&mut self, slot: impl Into<String>, view_json: Option<String>) -> &mut Self {
        self.baselines.push((slot.into(), view_json));
        self
    }

    /// Store an immutable, identity-addressed archive object only once. Reusing
    /// an existing identity writes neither its payload nor another WAL copy.
    pub fn immutable_baseline(&mut self, slot: impl Into<String>, value: String) -> &mut Self {
        self.immutable_baselines.push((slot.into(), value));
        self
    }

    /// Active cut facts are a cache, not retained undo targets. Keep at most
    /// the current facts row; immutable published seeds have separate slots.
    pub fn retain_cut_facts(&mut self, first: Option<u64>) -> &mut Self {
        self.active_cut_slot = Some(first.map(|first| format!("cut:{first}")));
        self
    }

    /// Forget every published view's engine form; their immutable runner
    /// views stay retrievable.
    pub fn clear_engine_views(&mut self) -> &mut Self {
        self.clear_engine_views = true;
        self
    }

    /// Record that versions below `floor` are no longer needed and delete
    /// them, except the newest version, in this same transaction.
    pub fn retain_views_from(&mut self, floor: u64) -> &mut Self {
        self.retain_views_from = Some(floor);
        self
    }

    pub fn commit(&self) -> Result<(), McStoreError> {
        let Self {
            store,
            session_ref,
            key,
            session,
            state,
            namespace,
            tags,
            ref forget_tags_of,
            truncate_entries,
            truncate_below,
            ref entries,
            ref replaced_entries,
            ref baselines,
            ref immutable_baselines,
            ref active_cut_slot,
            clear_engine_views,
            retain_views_from,
        } = *self;
        metered!(session_ref, store.inner.with_conn_fenced(held(|conn| {
            let mut rows = conn.execute("INSERT INTO mc_async_compaction(session_ref,conversation_key,session,state_json) VALUES(?1,?2,?3,?4)
                ON CONFLICT(session_ref) DO UPDATE SET state_json=excluded.state_json",
                params![session_ref,key,session,state])? as u64;
            let mut bytes = state.len();
            if let Some(active) = active_cut_slot {
                rows += conn.execute("DELETE FROM mc_async_compaction_baselines WHERE session_ref=?1 AND slot GLOB 'cut:*' AND (?2 IS NULL OR slot<>?2)",
                    params![session_ref, active])? as u64;
            }
            if let Some(through) = truncate_entries {
                rows += conn.execute(
                    "DELETE FROM mc_async_compaction_entries WHERE session_ref=?1 AND ordinal>?2",
                    params![session_ref, through.map_or(-1, |n| n as i64)],
                )? as u64;
            }
            if let Some(first) = truncate_below {
                rows += conn.execute(
                    "DELETE FROM mc_async_compaction_entries WHERE session_ref=?1 AND ordinal<?2",
                    params![session_ref, first as i64],
                )? as u64;
            }
            if !entries.is_empty() {
                let mut insert = conn.prepare_cached("INSERT INTO mc_async_compaction_entries(session_ref,session,ordinal,entry_json,index_json,mid) VALUES(?1,?2,?3,?4,?5,CASE WHEN json_valid(?4) THEN json_extract(?4,'$.mid') END)")?;
                for (ordinal, entry, index) in entries {
                    rows += insert.execute(params![session_ref, session, ordinal, entry, index])? as u64;
                    bytes += entry.len() + index.len();
                }
            }
            if !replaced_entries.is_empty() {
                let mut update = conn.prepare_cached("UPDATE mc_async_compaction_entries SET entry_json=?3, index_json=?4 WHERE session_ref=?1 AND ordinal=?2")?;
                for (ordinal, entry, index) in replaced_entries {
                    let updated = update.execute(params![session_ref, ordinal, entry, index])?;
                    if updated != 1 {
                        // A replaced entry must already be stored: refusing here
                        // keeps the whole save atomic instead of inserting a row.
                        return Err(rusqlite::Error::QueryReturnedNoRows);
                    }
                    rows += updated as u64;
                    bytes += entry.len() + index.len();
                }
            }
            for (slot, value) in immutable_baselines {
                let inserted = conn.execute(
                    "INSERT OR IGNORE INTO mc_async_compaction_baselines(session_ref,session,slot,view_json) VALUES(?1,?2,?3,?4)",
                    params![session_ref, session, slot, value],
                )? as u64;
                rows += inserted;
                if inserted != 0 { bytes += value.len(); }
            }
            for (slot, view) in baselines {
                rows += match view {
                    Some(view) => {
                        bytes += view.len();
                        conn.execute("INSERT INTO mc_async_compaction_baselines(session_ref,session,slot,view_json) VALUES(?1,?2,?3,?4)
                            ON CONFLICT(session_ref,slot) DO UPDATE SET view_json=excluded.view_json",
                            params![session_ref, session, slot, view])?
                    }
                    None => conn.execute(
                        "DELETE FROM mc_async_compaction_baselines WHERE session_ref=?1 AND slot=?2",
                        params![session_ref, slot],
                    )?,
                } as u64;
            }
            if clear_engine_views {
                rows += conn.execute(
                    "UPDATE mc_async_compaction_views SET engine_json=NULL WHERE session_ref=?1 AND engine_json IS NOT NULL",
                    [session_ref],
                )? as u64;
            }
            if let Some(floor) = retain_views_from {
                rows += conn.execute(
                    "DELETE FROM mc_async_compaction_views WHERE session_ref=?1 AND version<?2
                        AND version<(SELECT max(version) FROM mc_async_compaction_views WHERE session_ref=?1)",
                    params![session_ref, floor],
                )? as u64;
            }
            for mid in forget_tags_of {
                let prefix = format!("{mid}#");
                rows += conn.execute(
                    "DELETE FROM mc_provider_consumed_tags_v1 WHERE engine_namespace=?1 AND tag_number IN
                        (SELECT tag_number FROM mc_tags WHERE session_id=?1 AND substr(block_id,1,length(?2))=?2)",
                    params![namespace, prefix],
                )? as u64;
                rows += conn.execute(
                    "DELETE FROM mc_tags WHERE session_id=?1 AND substr(block_id,1,length(?2))=?2",
                    params![namespace, prefix],
                )? as u64;
            }
            crate::provider_log::insert_tags_tx(conn, namespace, tags)?;
            rows += tags.len() as u64;
            bytes += tags.iter().map(|t| t.source_bytes.len() + t.block_id.len()).sum::<usize>();
            Ok(((), rows, bytes as u64))
        })).map_err(McStoreError::from))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
    use std::time::Instant;

    #[test]
    fn final_ordinary_load_work_is_independent_of_retained_cut_count() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&StorageDescriptor {
            module_id: "magic-context".into(),
            storage_namespace: "mc_cache".into(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: dir.path().join("store.db").to_string_lossy().into_owned(),
            },
        })
        .unwrap();
        // Extract the actual loader statement so a query fix cannot leave a
        // copied, obsolete SQL string masquerading as a production witness.
        let source = include_str!("async_compaction.rs");
        let loader = source
            .split_once("pub fn load_async_compaction_rows(")
            .unwrap()
            .1;
        let query = loader
            .lines()
            .find_map(|line| {
                line.trim()
                    .strip_prefix(".prepare(\"SELECT slot,view_json")
                    .and_then(|rest| rest.strip_suffix("\")?"))
                    .map(|rest| format!("SELECT slot,view_json{rest}"))
            })
            .unwrap();
        let mut measurements = Vec::new();
        for cuts in [8, 128, 512] {
            let mut save = store.async_compaction_save("ref", "key", "session", "{}");
            save.baseline("frozen_edits", Some("live".into()));
            for first in 0..cuts {
                for prefix in [
                    "published-cut",
                    "published-cut-meta",
                    "published-cut-candidate",
                    "published-cut-root",
                    "cut-history",
                ] {
                    save.baseline(
                        format!("{prefix}:{first:020}:branch"),
                        Some("archive".repeat(128)),
                    );
                }
            }
            save.commit().unwrap();
            assert_eq!(
                store
                    .load_async_compaction_rows("ref")
                    .unwrap()
                    .unwrap()
                    .baselines,
                vec![("frozen_edits".into(), "live".into())]
            );
            let steps = store.inner.with_read(|conn| {
                let plan = conn.prepare(&format!("EXPLAIN QUERY PLAN {query}"))?
                    .query_map(["ref"], |row| row.get::<_, String>(3))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                let mut stmt = conn.prepare(&query)?;
                let rows = stmt.query_map(["ref"], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                assert_eq!(rows, vec!["frozen_edits"]);
                let steps = stmt.get_status(rusqlite::StatementStatus::VmStep);
                eprintln!("FINAL ordinary-load cuts={cuts} archive_rows={} hot_rows={} vm_steps={steps} plan={plan:?}", cuts * 5, rows.len());
                Ok(steps)
            }).unwrap();
            measurements.push(steps);
        }
        assert!(measurements[2] <= measurements[0] * 2 + 100,
            "ordinary load still walks retained cuts: VM steps {measurements:?} for 8/128/512 cuts with identical returned hot rows");
    }

    #[test]
    fn undo_edit_archives_are_not_hydrated_on_ordinary_loads() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&StorageDescriptor {
            module_id: "magic-context".into(),
            storage_namespace: "mc_cache".into(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: dir.path().join("store.db").to_string_lossy().into_owned(),
            },
        })
        .unwrap();
        let mut save = store.async_compaction_save("ref", "key", "session", "{}");
        save.baseline("frozen_edits", Some("live".into()));
        save.baseline("undo-native-edits:1:2", Some("archived".into()));
        save.commit().unwrap();
        let rows = store.load_async_compaction_rows("ref").unwrap().unwrap();
        assert_eq!(rows.baselines, vec![("frozen_edits".into(), "live".into())]);
        assert_eq!(
            store.load_async_undo_edits("ref").unwrap(),
            vec!["archived"]
        );
        assert!(store.load_async_undo_edits("another").unwrap().is_empty());
    }

    #[test]
    fn cut_archives_are_point_loaded_and_shared_objects_are_immutable() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&StorageDescriptor {
            module_id: "magic-context".into(),
            storage_namespace: "mc_cache".into(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: dir.path().join("store.db").to_string_lossy().into_owned(),
            },
        })
        .unwrap();
        let mut save = store.async_compaction_save("ref", "key", "session", "{}");
        save.baseline("frozen_edits", Some("live".into()));
        for slot in [
            "cut:100",
            "published-cut:100",
            "published-cut-meta:100",
            "published-cut-root:100",
            "undo-native-edits:mid:m1",
        ] {
            save.baseline(slot, Some("lazy".into()));
        }
        save.immutable_baseline("cut-history:identity", "original".into());
        save.commit().unwrap();
        let mut save = store.async_compaction_save("ref", "key", "session", "{}");
        save.immutable_baseline("cut-history:identity", "replacement".into());
        save.commit().unwrap();
        assert_eq!(
            store
                .load_async_compaction_rows("ref")
                .unwrap()
                .unwrap()
                .baselines,
            vec![("frozen_edits".into(), "live".into())]
        );
        assert_eq!(
            store
                .load_async_compaction_baseline("ref", "cut-history:identity")
                .unwrap()
                .as_deref(),
            Some("original")
        );
        assert_eq!(
            store
                .load_async_compaction_baseline("ref", "published-cut:100")
                .unwrap()
                .as_deref(),
            Some("lazy")
        );
        assert_eq!(
            store
                .load_async_compaction_baseline("ref", "cut:100")
                .unwrap()
                .as_deref(),
            Some("lazy")
        );
        let mut save = store.async_compaction_save("ref", "key", "session", "{}");
        save.baseline("cut:200", Some("current".into()));
        save.retain_cut_facts(Some(200));
        save.commit().unwrap();
        assert!(store
            .load_async_compaction_baseline("ref", "cut:100")
            .unwrap()
            .is_none());
        assert_eq!(
            store
                .load_async_compaction_baseline("ref", "cut:200")
                .unwrap()
                .as_deref(),
            Some("current")
        );
        let mut save = store.async_compaction_save("ref", "key", "session", "{}");
        save.retain_cut_facts(None);
        save.commit().unwrap();
        assert!(store
            .load_async_compaction_baseline("ref", "cut:200")
            .unwrap()
            .is_none());
    }

    #[test]
    fn cut_history_snapshots_own_payloads_and_gc_rechecks_roots() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&StorageDescriptor {
            module_id: "magic-context".into(),
            storage_namespace: "mc_cache".into(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: dir.path().join("store.db").to_string_lossy().into_owned(),
            },
        })
        .unwrap();
        let mut save = store.async_compaction_save("ref", "key", "session", "{}");
        save.baseline("published-cut-meta:100", Some(r#"{"version":1}"#.into()));
        save.baseline(
            "published-cut:100",
            Some(r#"{"recovery_history_ref":{"root":"c:old"},"marker":"old"}"#.into()),
        );
        save.baseline("published-cut-root:100", Some(r#""c:old""#.into()));
        save.immutable_baseline(
            "cut-history:c:old",
            r#"{"Compartment":{"content":"old"}}"#.into(),
        );
        save.commit().unwrap();
        let selected = store.load_async_cut_bundle("ref", "100").unwrap().unwrap();
        assert_eq!(selected.metadata.as_deref(), Some(r#"{"version":1}"#));
        assert_eq!(selected.history_objects.len(), 1);
        let (roots, objects) = store.async_cut_history_index("ref").unwrap();
        assert_eq!(roots, vec![r#""c:old""#.to_owned()]);
        assert_eq!(objects, vec!["cut-history:c:old".to_owned()]);
        let mut save = store.async_compaction_save("ref", "key", "session", "{}");
        save.baseline("published-cut-meta:100", Some(r#"{"version":2}"#.into()));
        save.baseline(
            "published-cut:100",
            Some(r#"{"recovery_history_ref":{"root":"c:new"},"marker":"new"}"#.into()),
        );
        save.baseline("published-cut-root:100", Some(r#""c:new""#.into()));
        save.immutable_baseline(
            "cut-history:c:new",
            r#"{"Compartment":{"content":"new"}}"#.into(),
        );
        save.commit().unwrap();
        assert!(!store
            .discard_async_cut_history_objects("ref", &objects, &roots)
            .unwrap());
        assert!(store
            .load_async_compaction_baseline("ref", "cut-history:c:old")
            .unwrap()
            .is_some());
        let (current_roots, _) = store.async_cut_history_index("ref").unwrap();
        assert!(store
            .discard_async_cut_history_objects("ref", &objects, &current_roots)
            .unwrap());
        assert!(store
            .load_async_compaction_baseline("ref", "cut-history:c:old")
            .unwrap()
            .is_none());
        assert!(selected.seed.contains(r#""marker":"old""#));
        assert_eq!(
            selected.history_objects[0].1,
            r#"{"Compartment":{"content":"old"}}"#
        );
        let latest = store.load_async_cut_bundle("ref", "100").unwrap().unwrap();
        assert_eq!(latest.metadata.as_deref(), Some(r#"{"version":2}"#));
        assert_eq!(latest.history_objects[0].0, "cut-history:c:new");
    }

    #[test]
    fn only_an_unannounced_view_can_drop_a_deferred_cut() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&StorageDescriptor {
            module_id: "magic-context".into(),
            storage_namespace: "mc_cache".into(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: dir.path().join("store.db").to_string_lossy().into_owned(),
            },
        })
        .unwrap();
        store
            .async_compaction_save("ref", "key", "session", "{}")
            .commit()
            .unwrap();
        store
            .save_async_compaction_view("ref", 1, "with-cut", "engine")
            .unwrap();
        store
            .revise_unannounced_async_compaction_view("ref", 1, "without-cut")
            .unwrap();
        assert_eq!(
            store
                .load_async_compaction_view("ref", 1)
                .unwrap()
                .as_deref(),
            Some("without-cut")
        );
        store.mark_async_compaction_announced("ref", 1).unwrap();
        assert!(store
            .revise_unannounced_async_compaction_view("ref", 1, "rewritten")
            .is_err());
        assert_eq!(
            store
                .load_async_compaction_view("ref", 1)
                .unwrap()
                .as_deref(),
            Some("without-cut")
        );
    }

    #[test]
    fn final_f03_active_cut_root_change_prevents_archive_deletion() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&StorageDescriptor {
            module_id: "magic-context".into(),
            storage_namespace: "mc_cache".into(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: dir.path().join("store.db").to_string_lossy().into_owned(),
            },
        })
        .unwrap();
        let mut save = store.async_compaction_save("ref", "key", "session", "{}");
        save.baseline(
            "cut:100",
            Some(r#"{"recovery_history_ref":{"root":"c:old"}}"#.into()),
        );
        save.immutable_baseline("cut-history:c:old", "old payload".into());
        save.commit().unwrap();
        let (roots, objects) = store.async_cut_history_index("ref").unwrap();
        assert_eq!(objects, vec!["cut-history:c:old".to_owned()]);
        // After taking the root snapshot, change only cut:100 from c:old to c:new.
        let mut save = store.async_compaction_save("ref", "key", "session", "{}");
        save.baseline(
            "cut:100",
            Some(r#"{"recovery_history_ref":{"root":"c:new"}}"#.into()),
        );
        save.immutable_baseline("cut-history:c:new", "new payload".into());
        save.commit().unwrap();
        assert!(!store
            .discard_async_cut_history_objects("ref", &objects, &roots)
            .unwrap());
        assert!(store
            .load_async_compaction_baseline("ref", "cut-history:c:old")
            .unwrap()
            .is_some());
        let (current_roots, _) = store.async_cut_history_index("ref").unwrap();
        assert!(store
            .discard_async_cut_history_objects("ref", &objects, &current_roots)
            .unwrap());
        assert!(store
            .load_async_compaction_baseline("ref", "cut-history:c:old")
            .unwrap()
            .is_none());
    }

    #[test]
    fn undo_edit_lookup_reads_only_requested_message_archives() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&StorageDescriptor {
            module_id: "magic-context".into(),
            storage_namespace: "mc_cache".into(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: dir.path().join("store.db").to_string_lossy().into_owned(),
            },
        })
        .unwrap();
        let mut save = store.async_compaction_save("ref", "key", "session", "{}");
        save.baseline("undo-native-edits:mid:closed", Some("closed-prefix".into()));
        save.baseline("undo-native-edits:mid:live", Some("live-window".into()));
        save.commit().unwrap();
        assert_eq!(
            store
                .load_async_undo_edits_for_messages("ref", &["live".into()])
                .unwrap(),
            vec!["live-window"]
        );
        assert!(store
            .load_async_undo_edits_for_messages("ref", &["missing".into()])
            .unwrap()
            .is_empty());
        assert!(store
            .load_async_undo_edits_for_messages("other", &["live".into()])
            .unwrap()
            .is_empty());
    }

    fn entry(n: u64) -> (String, String) {
        let output = if n % 997 == 3 {
            "large spent tool output line\n".repeat(7_000)
        } else if n % 101 == 7 {
            "medium spent tool output line\n".repeat(1_100)
        } else {
            "spent tool output line\n".repeat(52)
        };
        let entry = serde_json::json!({"ordinal":n,"mid":format!("m{n}"),"message":{"info":{"id":format!("m{n}"),"role":"assistant"},"parts":[{"id":format!("p{n}"),"type":"tool","state":{"output":output}}]}});
        let index = serde_json::json!([[format!("§{}§", 100 + n * 2), "0", "0".repeat(64)]]);
        (entry.to_string(), index.to_string())
    }

    fn tag(namespace_tag: u64) -> McTagRow {
        McTagRow {
            tag_number: namespace_tag as i64,
            block_id: format!("m{namespace_tag}#0"),
            kind: "tool_result".into(),
            token_count: 300,
            created_at_ms: 1,
            source_bytes: "spent tool output line\n".repeat(52).into_bytes().into(),
        }
    }

    /// Time one ordinary notice's write transaction (small record, four new
    /// entries with their tag rows, retention) against a conversation of
    /// 1k-150k stored entries, without the provider's engine in the process.
    /// Sizes come from `MC_ASYNC_STORE_SIZES`.
    #[test]
    #[ignore = "write-transaction scaling benchmark; run explicitly with --ignored --nocapture"]
    fn notice_write_transaction_scaling_benchmark() {
        let sizes = std::env::var("MC_ASYNC_STORE_SIZES")
            .unwrap_or_else(|_| "1000,10000,50000,150000".into())
            .split(',')
            .map(|size| size.trim().parse::<u64>().unwrap())
            .collect::<Vec<_>>();
        println!("| stored entries | median notice write tx ms | p90 ms | store.db bytes |");
        println!("|---:|---:|---:|---:|");
        for size in sizes {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("store.db");
            let store = McStore::open(&StorageDescriptor {
                module_id: "magic-context".into(),
                storage_namespace: "mc_cache".into(),
                isolation: Isolation::Module,
                backend: StorageBackend::Sqlite {
                    path: path.to_string_lossy().into_owned(),
                },
            })
            .unwrap();
            let state = "{\"record\":\"".to_string() + &"x".repeat(5_800) + "\"}";
            let key = "[\"project\",\"s\",\"opencode\"]";
            for chunk in (0..size).collect::<Vec<_>>().chunks(5_000) {
                let tags = chunk.iter().map(|n| tag(100 + n * 2)).collect::<Vec<_>>();
                let mut save = store.async_compaction_save("ref", key, "s", &state);
                save.tags("engine", &tags);
                for n in chunk {
                    let (entry, index) = entry(*n);
                    save.append_entry(*n, entry, index);
                }
                save.commit().unwrap();
            }
            let view = "v".repeat(size as usize * 1_200);
            store
                .save_async_compaction_view("ref", 1, &view, &view)
                .unwrap();
            let mut times = Vec::new();
            for notice in 0..25u64 {
                let first = size + notice * 4;
                let tags = (first..first + 4)
                    .map(|n| tag(100 + n * 2))
                    .collect::<Vec<_>>();
                let mut save = store.async_compaction_save("ref", key, "s", &state);
                save.tags("engine", &tags).retain_views_from(1);
                for n in first..first + 4 {
                    let (entry, index) = entry(n);
                    save.append_entry(n, entry, index);
                }
                let started = Instant::now();
                save.commit().unwrap();
                times.push(started.elapsed().as_secs_f64() * 1e3);
            }
            times.sort_by(f64::total_cmp);
            let bytes = std::fs::metadata(&path).unwrap().len();
            println!(
                "| {size} | {:.3} | {:.3} | {bytes} |",
                times[times.len() / 2],
                times[times.len() * 9 / 10]
            );
        }
    }

    /// Held entries are append-only except for one rewrite: a stored row
    /// replaced in place (a re-read whose only change is reasoning the runner
    /// pruned at rest). Replacing a row that is not stored refuses the whole
    /// save rather than inserting it.
    #[test]
    fn replace_entry_rewrites_only_a_stored_row() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open(&StorageDescriptor {
            module_id: "magic-context".into(),
            storage_namespace: "mc_cache".into(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: dir.path().join("store.db").to_string_lossy().into_owned(),
            },
        })
        .unwrap();
        let mut save = store.async_compaction_save("ref", "key", "session", "{}");
        save.append_entry(0, "original-0".into(), "[]".into());
        save.append_entry(1, "original-1".into(), "[]".into());
        save.commit().unwrap();
        let mut save = store.async_compaction_save("ref", "key", "session", "{\"n\":1}");
        save.replace_entry(1, "pruned-1".into(), "[]".into());
        save.commit().unwrap();
        assert_eq!(
            store.load_async_compaction_entries("ref", 9).unwrap(),
            vec![(0, "original-0".into()), (1, "pruned-1".into())]
        );
        let mut save = store.async_compaction_save("ref", "key", "session", "{\"n\":2}");
        save.append_entry(2, "appended-2".into(), "[]".into());
        save.replace_entry(5, "never-stored".into(), "[]".into());
        assert!(save.commit().is_err());
        assert_eq!(
            store.load_async_compaction_entries("ref", 9).unwrap(),
            vec![(0, "original-0".into()), (1, "pruned-1".into())],
            "the refused save wrote nothing"
        );
        assert_eq!(
            store.load_async_compaction("ref").unwrap().as_deref(),
            Some("{\"n\":1}")
        );
    }
}
