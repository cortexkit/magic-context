//! Host ordinals and module block IDs cached for rendering shared compartments.
//! The summaries and their stored raw IDs remain in context.db and are never rewritten here.
use crate::{CompartmentBoundary, McStore, McStoreError, StoredCompartment};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Split the module's `<raw-message-id>#<block-index>` into the shared table's two columns.
pub fn canonical_boundary_parts(id: &str) -> rusqlite::Result<(&str, Option<i64>)> {
    match crate::split_flat_block_id(id) {
        Some((raw, block)) => Ok((
            raw,
            Some(i64::try_from(block).map_err(|_| {
                rusqlite::Error::InvalidParameterName(
                    "compartment block index exceeds SQLite INTEGER".into(),
                )
            })?),
        )),
        None => Ok((id, None)),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolvedContextBoundary {
    pub sequence: i64,
    pub source_start_message: i64,
    pub source_end_message: i64,
    pub source_start_message_id: String,
    pub source_end_message_id: String,
    #[serde(default)]
    pub source_start_block_index: Option<i64>,
    #[serde(default)]
    pub source_end_block_index: Option<i64>,
    #[serde(default)]
    pub source_row_identity: String,
    pub start_message: i64,
    pub end_message: i64,
    pub start_message_id: String,
    pub end_message_id: String,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
}

/// Hash the complete compartment row: changing its summary without moving its
/// message boundaries must still invalidate cached host-to-module coordinates.
fn row_identity(row: &StoredCompartment) -> Result<String, McStoreError> {
    let bytes = serde_json::to_vec(row).map_err(|error| McStoreError::Serde(error.to_string()))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

impl ResolvedContextBoundary {
    pub(crate) fn preserves_source_ids(&self) -> bool {
        [
            (
                &self.source_start_message_id,
                self.source_start_block_index,
                &self.start_message_id,
            ),
            (
                &self.source_end_message_id,
                self.source_end_block_index,
                &self.end_message_id,
            ),
        ]
        .into_iter()
        .all(|(source, source_index, resolved)| {
            crate::split_flat_block_id(resolved).is_some_and(|(mid, block)| {
                // Older shared rows can omit an endpoint ID entirely. The host
                // then resolves a real message from its proven ordinal range;
                // there is no source ID to preserve, but an explicit block index
                // still forbids substitution. Row matching retains the empty
                // source identity so cache reuse cannot mask a later repair.
                (mid == source || (source.is_empty() && source_index.is_none()))
                    && source_index.is_none_or(|index| i64::try_from(block) == Ok(index))
            })
        })
    }

    pub(crate) fn matches(&self, row: &StoredCompartment) -> bool {
        self.sequence == row.sequence
            && self.source_start_message == row.start_message
            && self.source_end_message == row.end_message
            && matches_canonical_id(
                &self.source_start_message_id,
                self.source_start_block_index,
                &row.start_message_id,
            )
            && matches_canonical_id(
                &self.source_end_message_id,
                self.source_end_block_index,
                &row.end_message_id,
            )
    }

    pub(crate) fn bind_to_row(&mut self, row: &StoredCompartment) -> Result<(), McStoreError> {
        self.source_row_identity = row_identity(row)?;
        Ok(())
    }

    pub(crate) fn identifies(&self, row: &StoredCompartment) -> Result<bool, McStoreError> {
        Ok(!self.source_row_identity.is_empty()
            && self.matches(row)
            && self.source_row_identity == row_identity(row)?)
    }

    pub(crate) fn apply(&self, row: &mut StoredCompartment) {
        row.start_message = self.start_message;
        row.end_message = self.end_message;
        row.start_message_id.clone_from(&self.start_message_id);
        row.end_message_id.clone_from(&self.end_message_id);
        row.start_date.clone_from(&self.start_date);
        row.end_date.clone_from(&self.end_date);
    }

    pub(crate) fn matches_boundary(&self, row: &CompartmentBoundary) -> bool {
        self.sequence == row.sequence
            && self.source_start_message == row.start_message
            && self.source_end_message == row.end_message
            && matches_canonical_id(
                &self.source_end_message_id,
                self.source_end_block_index,
                &row.end_message_id,
            )
    }
}

fn matches_canonical_id(raw: &str, index: Option<i64>, module_id: &str) -> bool {
    match index {
        Some(index) => crate::split_flat_block_id(module_id)
            .is_some_and(|(mid, block)| mid == raw && i64::try_from(block) == Ok(index)),
        None => raw == module_id,
    }
}

#[derive(Default)]
pub(crate) struct BoundaryValidationCache {
    entries: std::collections::VecDeque<BoundaryValidationEntry>,
}
impl BoundaryValidationCache {
    pub(crate) fn invalidate_session(&mut self, session: &str) {
        self.entries.retain(|entry| entry.session != session);
    }
}

struct BoundaryValidationEntry {
    session: String,
    /// The digest of the boundary section the coordinates were read from, as recorded in
    /// `section_index.b.h`. It identifies the stored coordinates without reading them.
    source_digest: String,
    domain: std::sync::Arc<dyn crate::ContextDomain>,
    revision: (String, i64, i64, bool),
    valid: Vec<ResolvedContextBoundary>,
}

impl McStore {
    /// Whether every shared row has exact block indices or matching cached host
    /// coordinates, so reconnecting need not scan the raw messages again.
    pub fn context_boundaries_resolved(
        &self,
        session: &str,
        cached: &[ResolvedContextBoundary],
    ) -> Result<bool, McStoreError> {
        for row in self.load_raw_context_compartments(session)? {
            // Fully indexed rows need no host-coordinate overlay. Every other
            // row requires the fingerprint of this exact shared row, including
            // its summary, before a stored coordinate may be reused.
            if crate::split_flat_block_id(&row.start_message_id).is_some()
                && crate::split_flat_block_id(&row.end_message_id).is_some()
            {
                continue;
            }
            let mut matched = false;
            for boundary in cached
                .iter()
                .filter(|boundary| boundary.sequence == row.sequence)
            {
                if boundary.identifies(&row)? {
                    matched = true;
                    break;
                }
            }
            if !matched {
                return Ok(false);
            }
        }
        Ok(true)
    }

    pub(crate) fn compartment_history_revision_tx(
        conn: &rusqlite::Connection,
        session: &str,
    ) -> rusqlite::Result<Option<(String, i64, i64, bool)>> {
        let has_revision_table: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='compartment_history_versions')",
            [], |row| row.get(0),
        )?;
        if !has_revision_table {
            return Ok(None);
        }
        conn.query_row(
            "SELECT generation, version, rewrite_version, seeded FROM compartment_history_versions WHERE session_id=?1",
            params![session],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
    }

    /// Read the boundary index entry and the body it vouches for in one read transaction, so
    /// a commit landing between the two reads cannot pair a new body with an old digest.
    fn read_boundary_body_consistently(
        &self,
        session: &str,
    ) -> Result<Option<(String, u128)>, McStoreError> {
        Ok(self.inner.with_conn(|conn| {
            let transaction = conn.unchecked_transaction()?;
            let read = match crate::cache_codec::boundary_index_entry(&transaction, session)? {
                Some((sv, Some(entry))) => crate::cache_codec::read_verified_boundary_body(
                    &transaction,
                    session,
                    sv,
                    &entry,
                )?,
                _ => None,
            };
            transaction.commit()?;
            Ok(read)
        })?)
    }

    pub(crate) fn cached_context_boundaries(
        &self,
        session: &str,
    ) -> Result<Vec<ResolvedContextBoundary>, McStoreError> {
        // Only the small row's index is read here: the boundaries have their own section row,
        // and its digest identifies the stored coordinates without reading them. The body is
        // read only when the validation below is not already cached for that digest.
        let entry = self
            .inner
            .with_conn(|conn| crate::cache_codec::boundary_index_entry(conn, session))?;
        let Some((_, Some(entry))) = entry else {
            return Ok(Vec::new());
        };
        // A migrated row has no digest until its first codec commit; key it on the hash of
        // the body, which is what a codec writer would record for the same bytes.
        let mut prefetched = None;
        let mut source_digest = match entry.h.clone() {
            Some(digest) => digest,
            None => {
                let Some((body, digest)) = self.read_boundary_body_consistently(session)? else {
                    return Ok(Vec::new());
                };
                prefetched = Some(body);
                crate::cache_codec::digest_hex(digest)
            }
        };
        let mut cache = self
            .context_boundary_cache
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let domain = self.context_domain()?;
        // Cache the validation of host coordinates against canonical compartment rows.
        // Triggers increment only this session's counter for any row change, atomically
        // with the data. Its random generation distinguishes recreated counters after
        // cleanup. Other tables/sessions must not force us to reread summary bodies.
        // Snapshot the counter and bodies together. Persisted store.db coordinate JSON
        // is a separate key because the host can replace it without changing context.db.
        let (revision, rows, hit) = self.context_read(|conn| {
            // Older schemas lack the mutation counter: validate against actual bodies
            // every time rather than reusing a possibly outdated coordinate validation.
            let revision = Self::compartment_history_revision_tx(conn, session)?;
            let hit = revision.as_ref().and_then(|revision| {
                cache.entries.iter().position(|entry| {
                    entry.session == session
                        && entry.source_digest == source_digest
                        && std::sync::Arc::ptr_eq(&entry.domain, &domain)
                        && &entry.revision == revision
                })
            });
            if hit.is_some() {
                return Ok((revision, Vec::new(), hit));
            }
            let rows = self.load_raw_context_compartments_tx(conn, session)?;
            Ok((revision, rows, None))
        })?;
        tracing::debug!(target: "magic-context.perf", session, cache_hit = hit.is_some(), "mc-boundary-validation-cache");
        if let Some(index) = hit {
            let entry = cache.entries.remove(index).expect("cache hit index");
            let valid = entry.valid.clone();
            cache.entries.push_back(entry);
            return Ok(valid);
        }
        let json = match prefetched {
            Some(body) => body,
            None => {
                match self.read_boundary_body_consistently(session)? {
                    // If a commit landed between the two reads, the cache entry is keyed on
                    // the digest of the bytes actually validated, not on the older index.
                    Some((body, digest)) => {
                        source_digest = crate::cache_codec::digest_hex(digest);
                        body
                    }
                    None => return Ok(Vec::new()),
                }
            }
        };
        let cached: Vec<ResolvedContextBoundary> =
            serde_json::from_str(&json).map_err(|error| McStoreError::Serde(error.to_string()))?;
        let mut by_sequence = std::collections::HashMap::new();
        for row in &rows {
            by_sequence.entry(row.sequence).or_insert(row);
        }
        let mut valid = Vec::new();
        for boundary in cached {
            if let Some(row) = by_sequence.get(&boundary.sequence) {
                if boundary.identifies(row)? {
                    valid.push(boundary);
                }
            }
        }
        if let Some(revision) = revision {
            cache.entries.retain(|entry| entry.session != session);
            // Keep only validated coordinates, not summary bodies; bound interleaved sessions.
            if cache.entries.len() >= 8 {
                cache.entries.pop_front();
            }
            cache.entries.push_back(BoundaryValidationEntry {
                session: session.into(),
                source_digest,
                domain,
                revision,
                valid: valid.clone(),
            });
        }
        Ok(valid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::single_store_domain::{ContextDomain, SqliteContextDomain};
    use crate::ModuleStateSyncRequest;
    use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
    use rusqlite::{Connection, Transaction};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    };

    struct RewriteAfterSnapshot {
        inner: SqliteContextDomain,
        writer: Mutex<Connection>,
        fired: AtomicBool,
    }

    impl ContextDomain for RewriteAfterSnapshot {
        fn read(
            &self,
            callback: &mut dyn FnMut(&Connection) -> rusqlite::Result<()>,
        ) -> Result<(), McStoreError> {
            self.inner.read(callback)?;
            if !self.fired.swap(true, Ordering::SeqCst) {
                self.writer.lock().unwrap().execute_batch("BEGIN IMMEDIATE; UPDATE compartments SET end_message=3, end_message_id='m2' WHERE session_id='raw'; COMMIT;").unwrap();
            }
            Ok(())
        }
        fn write(
            &self,
            tables: &[&str],
            callback: &mut dyn FnMut(&Transaction<'_>) -> rusqlite::Result<()>,
        ) -> Result<(), McStoreError> {
            self.inner.write(tables, callback)
        }
    }

    fn install_snapshot_race(store: &McStore, dir: &std::path::Path) {
        let path = dir.join("context.db");
        store.install_context_domain(Arc::new(RewriteAfterSnapshot {
            inner: SqliteContextDomain::open(&path).unwrap(),
            writer: Mutex::new(Connection::open(&path).unwrap()),
            fired: AtomicBool::new(false),
        }));
    }

    fn descriptor(path: &std::path::Path) -> StorageDescriptor {
        StorageDescriptor {
            module_id: "magic-context".into(),
            storage_namespace: "magic-context".into(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: path.join("store.db").to_string_lossy().into_owned(),
            },
        }
    }
    fn boundary() -> ResolvedContextBoundary {
        ResolvedContextBoundary {
            sequence: 0,
            source_start_message: 2,
            source_end_message: 5,
            source_start_message_id: "m1".into(),
            source_end_message_id: "m4".into(),
            source_start_block_index: None,
            source_end_block_index: None,
            source_row_identity: String::new(),
            start_message: 1,
            end_message: 4,
            start_message_id: "m1#0".into(),
            end_message_id: "m4#0".into(),
            start_date: Some("1970-01-01".into()),
            end_date: Some("1970-01-01".into()),
        }
    }
    fn request(rows: &[ResolvedContextBoundary], seq: u64) -> ModuleStateSyncRequest<'_> {
        ModuleStateSyncRequest {
            resolved_compartment_boundaries: rows,
            session_id: "raw",
            project_path: "project",
            shadow_generation: 0,
            expected_shadow_seq: seq,
            seed_boundary_id: Some("m4#0"),
            drop_seeds: &[],
            drop_seed_skipped: 0,
            pending_agent_drops: &[],
            pending_agent_drops_skipped: 0,
            user_hint_seeds: &[],
            auto_search_hint_skipped: 0,
            note_nudge_anchors: None,
            todo_synthetic_anchor: None,
            todo_synthetic_anchor_present: false,
            emergency_latches: None,
            pending_compaction_marker: None,
            deferred_execute_state: None,
            channel2_nudge_state: None,
            strip_seeds: &[],
            strip_seed_skipped: 0,
            reasoning_cleared_through_tag: None,
            last_todo_state: None,
            acked_watermarks: serde_json::json!({}),
        }
    }
    fn seed(store: &McStore) {
        store.with_context_conn_for_test(|conn| conn.execute_batch("INSERT INTO compartments(session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, created_at) VALUES ('raw', 0, 2, 5, 'm1', 'm4', 'summary', 'body', 1)")).unwrap();
    }
    #[test]
    fn stable_boundary_validation_reads_bodies_once_and_reloads_external_publications() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
        seed(&store);
        store
            .apply_authority_state_sync(request(&[boundary()], 0))
            .unwrap();
        let expected = store.cached_context_boundaries("raw").unwrap();
        let before = store
            .compartment_payload_query_count
            .load(Ordering::Relaxed);
        for _ in 0..12 {
            assert_eq!(store.cached_context_boundaries("raw").unwrap(), expected);
            assert_eq!(store.max_compartment_end_ordinal("raw").unwrap(), 4);
        }
        assert_eq!(
            store
                .compartment_payload_query_count
                .load(Ordering::Relaxed),
            before,
            "stable passes must not reload summary bodies"
        );
        let writer = Connection::open(dir.path().join("context.db")).unwrap();
        // A direct same-count, same-sequence repair bypasses semantic revision logs.
        writer
            .execute(
                "UPDATE compartments SET content='updated body' WHERE session_id='raw'",
                [],
            )
            .unwrap();
        assert!(store.cached_context_boundaries("raw").unwrap().is_empty());
        assert_eq!(store.max_compartment_end_ordinal("raw").unwrap(), 5);
        assert_eq!(
            store.load_compartments("raw").unwrap()[0].content,
            "updated body"
        );
        writer.execute_batch("INSERT INTO compartments(session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, created_at) VALUES ('raw', 1, 6, 9, 'm5', 'm8', 'later', 'published elsewhere', 2)").unwrap();
        assert_eq!(store.max_compartment_end_ordinal("raw").unwrap(), 9);
    }

    #[test]
    fn unrelated_context_commits_from_host_and_module_writer_keep_validation_cached() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
        seed(&store);
        store
            .apply_authority_state_sync(request(&[boundary()], 0))
            .unwrap();
        let expected = store.cached_context_boundaries("raw").unwrap();
        let before = store
            .compartment_payload_query_count
            .load(Ordering::Relaxed);
        let host = Connection::open(dir.path().join("context.db")).unwrap();
        host.execute_batch("INSERT INTO session_meta(session_id,counter) VALUES ('raw',0)")
            .unwrap();
        for pass in 0..12 {
            host.execute(
                "UPDATE session_meta SET counter=?1 WHERE session_id='raw'",
                [pass],
            )
            .unwrap();
            store
                .with_context_conn_for_test(|conn| {
                    conn.execute(
                        "UPDATE session_meta SET last_response_time=?1 WHERE session_id='raw'",
                        [pass],
                    )?;
                    Ok(())
                })
                .unwrap();
            host.execute_batch("INSERT INTO compartments(session_id,sequence,start_message,end_message,title,content,created_at) VALUES ('other',0,1,4,'other','body',1) ON CONFLICT(session_id,sequence) DO UPDATE SET content='BODY'").unwrap();
            assert_eq!(store.cached_context_boundaries("raw").unwrap(), expected);
            assert_eq!(store.max_compartment_end_ordinal("raw").unwrap(), 4);
        }
        assert_eq!(
            store
                .compartment_payload_query_count
                .load(Ordering::Relaxed),
            before,
            "unrelated commits must not reload this session's bodies"
        );
    }

    #[test]
    fn recreated_revision_generation_and_v92_fallback_do_not_reuse_old_validation() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
        seed(&store);
        store
            .apply_authority_state_sync(request(&[boundary()], 0))
            .unwrap();
        assert_eq!(store.cached_context_boundaries("raw").unwrap().len(), 1);
        let host = Connection::open(dir.path().join("context.db")).unwrap();
        let old: (String, i64) = host.query_row("SELECT generation,version FROM compartment_history_versions WHERE session_id='raw'", [], |row| Ok((row.get(0)?,row.get(1)?))).unwrap();
        // Session cleanup removes counters. Reusing a session id must not reuse its cache.
        host.execute_batch("DELETE FROM compartments WHERE session_id='raw'; DELETE FROM compartment_history_versions WHERE session_id='raw'; INSERT INTO compartments(session_id,sequence,start_message,end_message,start_message_id,end_message_id,title,content,created_at) VALUES ('raw',0,1,5,'m0','m4','raw title','updated body',1)").unwrap();
        let new: (String, i64) = host.query_row("SELECT generation,version FROM compartment_history_versions WHERE session_id='raw'", [], |row| Ok((row.get(0)?,row.get(1)?))).unwrap();
        assert_eq!(new.1, old.1);
        assert_ne!(new.0, old.0);
        assert!(store.cached_context_boundaries("raw").unwrap().is_empty());
        host.execute_batch("DROP TRIGGER compartment_history_ai; DROP TRIGGER compartment_history_au; DROP TRIGGER compartment_history_ad; DROP TABLE compartment_history_versions").unwrap();
        let before = store
            .compartment_payload_query_count
            .load(Ordering::Relaxed);
        for _ in 0..3 {
            assert!(store.cached_context_boundaries("raw").unwrap().is_empty());
        }
        assert_eq!(
            store
                .compartment_payload_query_count
                .load(Ordering::Relaxed),
            before + 3,
            "v92 without triggers must use exact uncached validation"
        );
    }

    #[test]
    fn boundary_validation_reloads_when_only_cached_coordinates_change() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
        seed(&store);
        store
            .apply_authority_state_sync(request(&[boundary()], 0))
            .unwrap();
        assert_eq!(store.max_compartment_end_ordinal("raw").unwrap(), 4);
        // The coordinates live in their own section row; a direct edit goes through the
        // codec so the section digest the validation cache keys on changes with them.
        let rewrite = |edit: &dyn Fn(&mut Vec<ResolvedContextBoundary>)| {
            let loaded = store.load("raw").unwrap();
            let mut meta = loaded.meta.clone();
            edit(&mut meta.resolved_compartment_boundaries);
            store
                .commit("raw", loaded.row_version, &loaded.core, &meta)
                .unwrap();
        };
        rewrite(&|boundaries| boundaries[0].end_message = 3);
        assert_eq!(store.max_compartment_end_ordinal("raw").unwrap(), 3);
        // Preserve the earlier coordinate if legacy metadata repeats a sequence.
        rewrite(&|boundaries| {
            let mut repeated = boundaries[0].clone();
            repeated.end_message = 7;
            boundaries.push(repeated);
        });
        assert_eq!(store.max_compartment_end_ordinal("raw").unwrap(), 3);
    }

    #[test]
    #[ignore = "set MC_PLANNING_CLONE to an APFS clone root under the system temporary directory"]
    fn cloned_boundary_validation_profile() {
        let root =
            std::path::PathBuf::from(std::env::var_os("MC_PLANNING_CLONE").expect("clone root"));
        let root = root.canonicalize().unwrap();
        assert!(root.starts_with(
            std::env::temp_dir()
                .canonicalize()
                .unwrap()
                .join("magic-context/perf-planning")
        ));
        let store = McStore::open(&descriptor(&root.join("data/cortexkit/magic-context"))).unwrap();
        store.install_context_domain(Arc::new(
            SqliteContextDomain::open(&root.join("data/cortexkit/magic-context/context.db"))
                .unwrap(),
        ));
        let output = std::process::Command::new("lsof")
            .args(["-p", &std::process::id().to_string()])
            .output()
            .unwrap();
        assert!(output.status.success());
        for line in String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter(|line| line.contains(".db"))
        {
            assert!(
                line.contains(root.to_str().unwrap()),
                "non-clone database opened: {line}"
            );
            println!("boundary-profile-lsof {line}");
        }
        println!(
            "profile pid={} clone={}",
            std::process::id(),
            root.display()
        );
        for session in [
            "ses_227ce5788ffeRPA9THoPLOQreO",
            "ses_313660571ffeZTsf4koSJwk50Q",
        ] {
            let mut samples = Vec::new();
            for pass in 0..13 {
                let started = std::time::Instant::now();
                let first = store.cached_context_boundaries(session).unwrap();
                let end = store.max_compartment_end_ordinal(session).unwrap();
                let second = store.cached_context_boundaries(session).unwrap();
                assert_eq!(first, second);
                samples.push(started.elapsed().as_secs_f64() * 1000.0);
                println!(
                    "boundary-profile session={session} pass={pass} ms={:.3} rows={} end={end}",
                    samples[pass],
                    first.len()
                );
            }
            samples.remove(0);
            samples.sort_by(f64::total_cmp);
            println!(
                "boundary-profile session={session} warm_median_ms={:.3}",
                (samples[5] + samples[6]) / 2.0
            );
        }
    }

    #[test]
    fn echoed_materialized_boundary_is_retained_when_a_newer_compartment_exists() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
        seed(&store);
        let first = [boundary()];
        store
            .apply_authority_state_sync(request(&first, 0))
            .unwrap();
        let (meta, materialized, _) = store.load_state_sync_inventory("raw", true).unwrap();
        assert!(meta.initialized);
        assert_eq!(materialized, "m4#0");

        // A newer compartment is published but not folded yet; the host echoes the
        // module's own boundary, which now lags the newest compartment.
        store
            .with_context_conn_for_test(|conn| conn.execute_batch(
                "INSERT INTO compartments(session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, created_at) VALUES ('raw', 1, 6, 9, 'm5', 'm8', 'later', 'body', 2)",
            ))
            .unwrap();
        let mut newer = boundary();
        newer.sequence = 1;
        newer.source_start_message = 6;
        newer.source_end_message = 9;
        newer.source_start_message_id = "m5".into();
        newer.source_end_message_id = "m8".into();
        newer.start_message = 5;
        newer.end_message = 8;
        newer.start_message_id = "m5#0".into();
        newer.end_message_id = "m8#0".into();
        let rows = [boundary(), newer];
        let (meta, _, _) = store.load_state_sync_inventory("raw", true).unwrap();
        store
            .apply_authority_state_sync(request(&rows, meta.shadow_seq))
            .unwrap();
        let (_, retained, _) = store.load_state_sync_inventory("raw", true).unwrap();
        assert_eq!(retained, "m4#0");

        // A declared boundary that is neither the materialized one nor the newest
        // compartment is still refused.
        let (meta, _, _) = store.load_state_sync_inventory("raw", true).unwrap();
        let mut stale = request(&rows, meta.shadow_seq);
        stale.seed_boundary_id = Some("m1#0");
        assert!(matches!(
            store.apply_authority_state_sync(stale),
            Err(crate::ModuleStateSyncError::InvalidSeedBoundary { .. })
        ));
    }

    #[test]
    fn empty_legacy_source_id_accepts_host_resolution_without_rewriting_shared_row() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
        seed(&store);
        store
            .with_context_conn_for_test(|conn| {
                conn.execute_batch(
            "UPDATE compartments SET start_message_id='', end_block_index=3 WHERE session_id='raw'"
        )
            })
            .unwrap();
        let mut resolved = boundary();
        resolved.source_start_message_id.clear();
        resolved.source_end_block_index = Some(3);
        resolved.end_message_id = "m4#3".into();
        let rows = [resolved];
        let mut sync = request(&rows, 0);
        sync.seed_boundary_id = None;
        store.apply_authority_state_sync(sync).unwrap();
        let raw = store.load_raw_context_compartments("raw").unwrap();
        assert_eq!(raw[0].start_message_id, "");
        assert_eq!(raw[0].end_message_id, "m4#3");
        let rendered = store.load_compartments("raw").unwrap();
        assert_eq!(rendered[0].start_message_id, "m1#0");
        assert_eq!(rendered[0].end_message_id, "m4#3");
        assert!(store
            .context_boundaries_resolved("raw", &store.cached_context_boundaries("raw").unwrap())
            .unwrap());
        store
            .with_context_conn_for_test(|conn| {
                conn.execute_batch(
                    "UPDATE compartments SET start_message_id='repaired' WHERE session_id='raw'",
                )
            })
            .unwrap();
        assert!(!store
            .context_boundaries_resolved("raw", &store.cached_context_boundaries("raw").unwrap())
            .unwrap());
    }

    #[test]
    fn empty_source_resolution_requires_unindexed_source_and_valid_flat_id() {
        let mut resolved = boundary();
        resolved.source_start_message_id.clear();
        assert!(resolved.preserves_source_ids());
        resolved.source_start_block_index = Some(0);
        assert!(!resolved.preserves_source_ids());
        resolved.source_start_block_index = None;
        resolved.start_message_id = "#0".into();
        assert!(!resolved.preserves_source_ids());
        resolved.start_message_id = "m1#0".into();
        resolved.source_start_message_id = "known".into();
        assert!(!resolved.preserves_source_ids());
    }

    #[test]
    fn cache_coordinates_survive_restart_without_rewriting_shared_rows() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
        seed(&store);
        assert!(!store.context_boundaries_resolved("raw", &[]).unwrap());
        store
            .apply_authority_state_sync(request(&[boundary()], 0))
            .unwrap();
        let rows = store.load_compartments("raw").unwrap();
        assert_eq!((rows[0].start_message, rows[0].end_message), (1, 4));
        assert_eq!(rows[0].end_message_id, "m4#0");
        let raw = store.load_raw_context_compartments("raw").unwrap();
        assert_eq!((raw[0].start_message, raw[0].end_message), (2, 5));
        assert_eq!(raw[0].end_message_id, "m4");
        drop(store);
        let reopened = McStore::open_for_test(&descriptor(dir.path())).unwrap();
        assert_eq!(
            reopened.load_compartments("raw").unwrap()[0].end_message_id,
            "m4#0"
        );
        assert!(reopened
            .context_boundaries_resolved("raw", &reopened.cached_context_boundaries("raw").unwrap())
            .unwrap());
        // On reconnect the host omits compartment coordinates already cached here.
        reopened
            .apply_authority_state_sync(request(&[], 1))
            .unwrap();
        assert_eq!(
            reopened.load_compartments("raw").unwrap()[0].end_message_id,
            "m4#0"
        );
    }
    #[test]
    fn a_host_recompaction_can_shorten_shared_coverage_without_rewriting_ids() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
        seed(&store);
        store
            .apply_authority_state_sync(request(&[boundary()], 0))
            .unwrap();
        store.with_context_conn_for_test(|conn| conn.execute_batch("UPDATE compartments SET end_message_id='m2', end_message=3 WHERE session_id='raw'")).unwrap();
        let mut shortened = boundary();
        shortened.source_end_message_id = "m2".into();
        shortened.source_end_message = 3;
        shortened.end_message = 2;
        shortened.end_message_id = "m2#0".into();
        let rows = [shortened];
        let mut update = request(&rows, 1);
        update.seed_boundary_id = Some("m2#0");
        store.apply_authority_state_sync(update).unwrap();
        let state = store.load("raw").unwrap();
        assert_eq!(state.meta.coverage_ordinal, Some(2));
        assert!(state.meta.bootstrap_seed_fold_pending);
        assert_eq!(
            store.load_raw_context_compartments("raw").unwrap()[0].end_message_id,
            "m2"
        );
    }

    #[test]
    fn module_publication_keeps_shared_ids_raw_and_roundtrips_block_indices() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
        seed(&store);
        let mut row = store.load_compartments("raw").unwrap().remove(0);
        row.start_message_id = "m1#1".into();
        row.end_message_id = "m4#2".into();
        store
            .with_context_conn_for_test(|conn| {
                conn.execute_batch("DELETE FROM compartments WHERE session_id='raw'")
            })
            .unwrap();
        store.append_compartments_now("raw", &[row]).unwrap();
        let stored: (String, String, Option<i64>, Option<i64>) = store.with_context_conn_for_test(|conn| conn.query_row("SELECT start_message_id, end_message_id, start_block_index, end_block_index FROM compartments WHERE session_id='raw'", [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))).unwrap();
        assert_eq!(stored, ("m1".into(), "m4".into(), Some(1), Some(2)));
        let read = store.load_compartments("raw").unwrap();
        assert_eq!(read[0].start_message_id, "m1#1");
        assert_eq!(read[0].end_message_id, "m4#2");
        assert!(store.context_boundaries_resolved("raw", &[]).unwrap());
    }

    #[test]
    fn snapshot_then_host_rewrite_must_not_commit_stale_coordinates() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
        seed(&store);
        install_snapshot_race(&store, dir.path());
        let outcome = store.apply_authority_state_sync(request(&[boundary()], 0));
        assert_eq!(
            store.load_raw_context_compartments("raw").unwrap()[0].end_message_id,
            "m2"
        );
        let cached = store.cached_context_boundaries("raw").unwrap();
        assert!(
            outcome.is_err() || cached.is_empty(),
            "stale snapshot committed to store.db: {cached:?}"
        );
    }

    #[test]
    fn a_row_rewritten_during_state_sync_is_reported_as_an_invalid_seed_boundary() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
        seed(&store);
        install_snapshot_race(&store, dir.path());
        // The error is the host's cue to recover: its pass fails, and on the next
        // one the stale sequence draws an authority-seq mismatch, which makes the
        // host adopt the durable sequence and re-seed every boundary coordinate,
        // the rewritten row's included. Reporting success instead would ack
        // watermarks captured before the rewrite and skip that re-seed.
        let outcome = store.apply_authority_state_sync(request(&[boundary()], 0));
        assert!(
            matches!(
                outcome,
                Err(crate::ModuleStateSyncError::InvalidSeedBoundary { .. })
            ),
            "{outcome:?}"
        );
    }

    #[test]
    fn rewrite_between_module_passes_invalidates_overlay_and_recovers_once() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
        seed(&store);
        store
            .apply_authority_state_sync(request(&[boundary()], 0))
            .unwrap();
        store.with_context_conn_for_test(|tx| tx.execute_batch("UPDATE compartments SET end_message=3, end_message_id='m2' WHERE session_id='raw'")).unwrap();
        assert_eq!(
            store.load_compartments("raw").unwrap()[0].end_message_id,
            "m2"
        );
        assert!(store.apply_authority_state_sync(request(&[], 1)).is_err());
        let mut changed = boundary();
        changed.source_end_message = 3;
        changed.source_end_message_id = "m2".into();
        changed.end_message = 2;
        changed.end_message_id = "m2#0".into();
        let rows = [changed];
        let mut update = request(&rows, 1);
        update.seed_boundary_id = Some("m2#0");
        store.apply_authority_state_sync(update).unwrap();
        assert_eq!(
            store.load_compartments("raw").unwrap()[0].end_message_id,
            "m2#0"
        );
        let mut defer = request(&[], 2);
        defer.seed_boundary_id = Some("m2#0");
        store.apply_authority_state_sync(defer).unwrap();
        assert_eq!(
            store.load_compartments("raw").unwrap()[0].end_message_id,
            "m2#0"
        );
    }

    #[test]
    fn host_rewrite_before_snapshot_is_rejected_and_next_pass_adopts_new_row() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
        seed(&store);
        store.with_context_conn_for_test(|tx| tx.execute_batch("UPDATE compartments SET end_message=3, end_message_id='m2' WHERE session_id='raw'")).unwrap();
        assert!(store
            .apply_authority_state_sync(request(&[boundary()], 0))
            .unwrap_err()
            .to_string()
            .contains("snapshot changed"));
        let mut updated = boundary();
        updated.source_end_message = 3;
        updated.source_end_message_id = "m2".into();
        updated.end_message = 2;
        updated.end_message_id = "m2#0".into();
        let rows = [updated];
        let mut sync = request(&rows, 0);
        sync.seed_boundary_id = Some("m2#0");
        store.apply_authority_state_sync(sync).unwrap();
        assert_eq!(
            store.load_compartments("raw").unwrap()[0].end_message_id,
            "m2#0"
        );
        store
            .apply_authority_state_sync({
                let mut next = request(&[], 1);
                next.seed_boundary_id = Some("m2#0");
                next
            })
            .unwrap();
        assert_eq!(
            store.load_compartments("raw").unwrap()[0].end_message_id,
            "m2#0"
        );
    }

    #[test]
    fn same_count_rewrite_and_reconnect_do_not_serve_old_coordinates() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
        seed(&store);
        store
            .apply_authority_state_sync(request(&[boundary()], 0))
            .unwrap();
        store.with_context_conn_for_test(|conn| conn.execute_batch(
            "UPDATE compartments SET start_message=3, start_message_id='m2', end_message=5, end_message_id='m4' WHERE session_id='raw'"
        )).unwrap();
        assert!(!store
            .context_boundaries_resolved("raw", &store.cached_context_boundaries("raw").unwrap())
            .unwrap());
        let served = store.load_compartments("raw").unwrap();
        assert_eq!(
            (served[0].start_message, served[0].start_message_id.as_str()),
            (3, "m2")
        );
        let mut replacement = boundary();
        replacement.source_start_message = 3;
        replacement.source_start_message_id = "m2".into();
        replacement.start_message = 2;
        replacement.start_message_id = "m2#0".into();
        store
            .apply_authority_state_sync(request(&[replacement], 1))
            .unwrap();
        assert_eq!(
            store.load_compartments("raw").unwrap()[0].start_message_id,
            "m2#0"
        );
        drop(store);
        let reopened = McStore::open_for_test(&descriptor(dir.path())).unwrap();
        reopened
            .apply_authority_state_sync(request(&[], 2))
            .unwrap();
        assert_eq!(
            reopened.load_compartments("raw").unwrap()[0].start_message_id,
            "m2#0"
        );
    }

    #[test]
    fn coordinate_rebase_to_an_indexed_end_invalidates_old_overlay() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
        seed(&store);
        store
            .apply_authority_state_sync(request(&[boundary()], 0))
            .unwrap();
        store
            .with_context_conn_for_test(|conn| {
                conn.execute_batch(
                    "UPDATE compartments SET end_block_index=1 WHERE session_id='raw'",
                )
            })
            .unwrap();
        let cached = store.cached_context_boundaries("raw").unwrap();
        assert!(cached.is_empty());
        assert!(!store
            .context_boundaries_resolved("raw", &[boundary()])
            .unwrap());
        let served = store.load_compartments("raw").unwrap();
        assert_eq!(served[0].end_message_id, "m4#1");
        assert_eq!(served[0].end_message, 5);
        assert!(store
            .apply_authority_state_sync(request(&[boundary()], 1))
            .unwrap_err()
            .to_string()
            .contains("snapshot changed"));
    }

    #[test]
    fn same_coordinates_with_rewritten_content_invalidate_cached_row_identity() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
        seed(&store);
        store
            .apply_authority_state_sync(request(&[boundary()], 0))
            .unwrap();
        let previously_cached = store.cached_context_boundaries("raw").unwrap();
        store
            .with_context_conn_for_test(|conn| {
                conn.execute_batch(
                    "UPDATE compartments SET content='rewritten summary' WHERE session_id='raw'",
                )
            })
            .unwrap();
        assert!(!store
            .context_boundaries_resolved("raw", &previously_cached)
            .unwrap());
        assert!(store.cached_context_boundaries("raw").unwrap().is_empty());
        assert_eq!(
            store.load_compartments("raw").unwrap()[0].content,
            "rewritten summary"
        );
        assert_eq!(
            store.load_compartments("raw").unwrap()[0].end_message_id,
            "m4"
        );
    }

    #[test]
    fn removed_tail_never_reappears_from_coordinate_cache() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
        seed(&store);
        store
            .apply_authority_state_sync(request(&[boundary()], 0))
            .unwrap();
        store
            .with_context_conn_for_test(|conn| {
                conn.execute_batch("DELETE FROM compartments WHERE session_id='raw'")
            })
            .unwrap();
        assert!(store.load_compartments("raw").unwrap().is_empty());
        assert!(store
            .load_raw_context_compartments("raw")
            .unwrap()
            .is_empty());
        assert!(store
            .context_boundaries_resolved("raw", &store.cached_context_boundaries("raw").unwrap())
            .unwrap());
    }

    #[test]
    fn changed_shared_boundaries_do_not_reuse_or_adopt_stale_cache_coordinates() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
        seed(&store);
        store
            .apply_authority_state_sync(request(&[boundary()], 0))
            .unwrap();
        store
            .with_context_conn_for_test(|conn| {
                conn.execute_batch(
                    "UPDATE compartments SET end_message_id='m5' WHERE session_id='raw'",
                )
            })
            .unwrap();
        assert_eq!(
            store.load_compartments("raw").unwrap()[0].end_message_id,
            "m5"
        );
        assert!(!store
            .context_boundaries_resolved("raw", &store.cached_context_boundaries("raw").unwrap())
            .unwrap());
        assert!(store
            .apply_authority_state_sync(request(&[boundary()], 1))
            .unwrap_err()
            .to_string()
            .contains("snapshot changed"));
        assert_eq!(store.load("raw").unwrap().meta.shadow_seq, 1);
    }
}
