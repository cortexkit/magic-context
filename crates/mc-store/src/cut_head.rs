//! An engine namespace's state as a whole, for a conversation whose lineage
//! descends from a cut: the folded head it already served (frozen m0, m1,
//! history and mural units, coverage and boundary, the tail-hygiene baseline
//! and the m1 revisions) plus the per-message rows of the messages it keeps.
//! The caller filters out the messages below the cut before adopting it, so
//! what is carried is bounded by the history budget, the frozen units and the
//! window, never by the session's length.
use crate::{
    BlockIdentity, McStore, McStoreError, ModuleMeta, SectionsCommit, ServedBlockFingerprint,
    TransformCommit, TransformOverlayBatch,
};
use cortexkit_cache_core::CoreState;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// One message-keyed overlay row: block id, text, creation time.
pub type OverlayRow = (String, String, i64);

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct NamespaceHead {
    pub core: CoreState,
    /// The meta blob. Its row-stored members are the fields below.
    pub meta: ModuleMeta,
    pub identities: BTreeMap<String, Vec<BlockIdentity>>,
    pub served: Vec<ServedBlockFingerprint>,
    pub temporal_marks: Vec<OverlayRow>,
    pub user_hints: Vec<OverlayRow>,
    pub channel1_appends: Vec<OverlayRow>,
    pub overlay_frontier: Option<i64>,
    /// Queued `ctx_reduce` drops: target block id, queued at ms.
    pub pending_drops: Vec<(String, i64)>,
    /// Tag numbers whose drop the engine already consumed, with the session
    /// each row names.
    pub consumed_tags: Vec<(i64, String)>,
}

impl NamespaceHead {
    /// Keep only what belongs to messages `keep` accepts (by message id).
    /// Frozen units are filtered by the caller, which knows their key forms.
    pub fn retain_messages(&mut self, keep: impl Fn(&str) -> bool) {
        let block = |id: &str| keep(id.split_once('#').map_or(id, |(mid, _)| mid));
        self.identities.retain(|mid, _| keep(mid));
        self.temporal_marks.retain(|row| block(&row.0));
        self.user_hints.retain(|row| block(&row.0));
        self.channel1_appends.retain(|row| block(&row.0));
        self.pending_drops.retain(|row| block(&row.0));
        let meta = &mut self.meta;
        for set in [
            &mut meta.protected_tool_block_ids,
            &mut meta.pending_tag_block_ids,
            &mut meta.pending_user_hint_block_ids,
        ] {
            set.retain(|id| block(id));
        }
        meta.reclassified_synthetic_mids.retain(|mid| keep(mid));
    }
}

impl McStore {
    /// Immutable history snapshots retain these existing version columns, even
    /// after their temporary namespace is reclaimed: generation, source version,
    /// rewrite version, and the seeded flag.
    pub fn compartment_history_identity(
        &self,
        namespace: &str,
    ) -> Result<Option<(String, i64, i64, bool)>, McStoreError> {
        use rusqlite::OptionalExtension;
        self.context_read(|conn| {
            conn.query_row("SELECT generation,version,rewrite_version,seeded FROM compartment_history_versions WHERE session_id=?1",
                [namespace], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).optional()
        })
    }

    /// Restore the identity of materialized immutable compartments without
    /// depending on the continued existence of the old staging namespace.
    pub fn set_compartment_history_identity(
        &self,
        namespace: &str,
        identity: &(String, i64, i64, bool),
    ) -> Result<(), McStoreError> {
        self.context_write(&["compartment_history_versions"], |tx| {
            tx.execute("INSERT INTO compartment_history_versions(session_id,generation,version,rewrite_version,seeded) VALUES(?1,?2,?3,?4,?5)
                ON CONFLICT(session_id) DO UPDATE SET generation=excluded.generation,version=excluded.version,rewrite_version=excluded.rewrite_version,seeded=excluded.seeded",
                params![namespace,identity.0,identity.1,identity.2,identity.3])?;
            Ok(())
        })?;
        Ok(())
    }

    /// Delete an unreferenced window stage. The caller keeps its durable intent
    /// until both stores have been cleaned, so interrupted deletion is retryable.
    pub fn discard_staged_namespace(
        &self,
        namespace: &str,
        project: &str,
    ) -> Result<(), McStoreError> {
        self.delete_session(namespace, project)?;
        self.context_write(
            &["compartment_history_versions", "compartment_state_lease"],
            |tx| {
                for table in ["compartment_history_versions", "compartment_state_lease"] {
                    tx.execute(
                        &format!("DELETE FROM {table} WHERE session_id=?1"),
                        [namespace],
                    )?;
                }
                Ok(())
            },
        )?;
        Ok(())
    }

    /// Copied history preserves its source identity so adopting the same
    /// compartments does not look like a new history rewrite.
    pub fn adopt_compartment_history_identity(
        &self,
        source: &str,
        target: &str,
    ) -> Result<(), McStoreError> {
        self.context_write(&["compartment_history_versions"], |tx| {
            tx.execute("UPDATE compartment_history_versions SET (generation, version, rewrite_version, seeded) =
                (SELECT generation, version, rewrite_version, seeded FROM compartment_history_versions WHERE session_id=?1)
                WHERE session_id=?2 AND EXISTS(SELECT 1 FROM compartment_history_versions WHERE session_id=?1)", params![source,target])?;
            Ok(())
        })?;
        Ok(())
    }

    /// The namespace's whole state, or `None` for a namespace never written.
    pub fn load_namespace_head(
        &self,
        namespace: &str,
    ) -> Result<Option<NamespaceHead>, McStoreError> {
        let loaded = self.load(namespace)?;
        if loaded.row_version.is_none() {
            return Ok(None);
        }
        let rows = |sql: &str| -> Result<Vec<OverlayRow>, McStoreError> {
            Ok(self.inner.with_conn(|conn| {
                conn.prepare(sql)?
                    .query_map([namespace], |row| {
                        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()
            })?)
        };
        let temporal_marks = rows(
            "SELECT block_id, marker_text, created_at FROM mc_temporal_marks WHERE session_id=?1 ORDER BY block_id",
        )?;
        let user_hints = rows(
            "SELECT block_id, hint_text, created_at FROM mc_user_hints WHERE session_id=?1 ORDER BY block_id",
        )?;
        let channel1_appends = rows(
            "SELECT block_id, reminder_text, fired_at_ms FROM mc_channel1_appends WHERE session_id=?1 ORDER BY block_id",
        )?;
        let (overlay_frontier, consumed_tags) = self.inner.with_conn(|conn| {
            let frontier = conn
                .query_row(
                    "SELECT max_seen_ordinal FROM mc_overlay_frontiers WHERE session_id=?1",
                    [namespace],
                    |row| row.get(0),
                )
                .ok();
            let consumed = conn
                .prepare("SELECT tag_number, session FROM mc_provider_consumed_tags_v1 WHERE engine_namespace=?1 ORDER BY tag_number")?
                .query_map([namespace], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<rusqlite::Result<Vec<(i64, String)>>>()?;
            Ok::<_, rusqlite::Error>((frontier, consumed))
        })?;
        let pending_drops = self
            .load_pending_agent_drops(namespace)?
            .into_iter()
            .map(|drop| (drop.target_id, drop.queued_at_ms))
            .collect();
        let mut meta = loaded.meta;
        let identities = std::mem::take(&mut meta.block_identity_by_mid);
        let served = std::mem::take(&mut meta.served_output_fingerprint);
        Ok(Some(NamespaceHead {
            core: loaded.core,
            meta,
            identities,
            served,
            temporal_marks,
            user_hints,
            channel1_appends,
            overlay_frontier,
            pending_drops,
            consumed_tags,
        }))
    }

    /// Make `head` this namespace's state, replacing what it held. The
    /// namespace's compartments are left as they are.
    pub fn adopt_namespace_head(
        &self,
        namespace: &str,
        head: &NamespaceHead,
    ) -> Result<(), McStoreError> {
        let expected = self.load_meta(namespace)?.row_version;
        let mut meta = head.meta.clone();
        meta.block_identity_by_mid = head.identities.clone();
        meta.served_output_fingerprint = head.served.clone();
        self.commit_transform_scoped(
            namespace,
            TransformCommit {
                expected,
                core: &head.core,
                meta: &meta,
                sections: SectionsCommit::default(),
                consumed_drop_ids: &[],
                first_applied_command_ids: &[],
                memory_revision: None,
                compartment_max_seq: None,
                project_root: None,
                first_divergence: None,
                scheduler_observation: None,
                scheduler_request_observed_at_ms: None,
                scheduler_full_array_fingerprint: None,
                scheduler_eligible_supersession_count: None,
                scheduler_withheld_by_tag_window: None,
                scheduler_withheld_by_exempt_message: None,
                scheduler_applied_supersession_count: None,
                scheduler_applied_reductions: false,
                overlays: TransformOverlayBatch::default(),
            },
            None,
            false,
            Some(head),
            None,
        )?;
        Ok(())
    }
}

impl NamespaceHead {
    pub(crate) fn write_overlays_tx(
        &self,
        conn: &rusqlite::Transaction<'_>,
        namespace: &str,
    ) -> rusqlite::Result<()> {
        #[cfg(test)]
        if FAIL_ADOPTION_BEFORE_OVERLAYS.with(|flag| flag.replace(false)) {
            return Err(rusqlite::Error::InvalidQuery);
        }
        #[cfg(test)]
        if CRASH_ADOPTION_BEFORE_OVERLAYS.with(|flag| flag.get()) {
            std::process::abort();
        }
        for table in [
            "mc_temporal_marks",
            "mc_user_hints",
            "mc_channel1_appends",
            "mc_overlay_frontiers",
            "pending_agent_drops",
        ] {
            conn.execute(
                &format!("DELETE FROM {table} WHERE session_id=?1"),
                [namespace],
            )?;
        }
        conn.execute(
            "DELETE FROM mc_provider_consumed_tags_v1 WHERE engine_namespace=?1",
            [namespace],
        )?;
        for (table, text) in [
            ("mc_temporal_marks", "marker_text, created_at"),
            ("mc_user_hints", "hint_text, created_at"),
            ("mc_channel1_appends", "reminder_text, fired_at_ms"),
        ] {
            let rows = match table {
                "mc_temporal_marks" => &self.temporal_marks,
                "mc_user_hints" => &self.user_hints,
                _ => &self.channel1_appends,
            };
            let mut insert = conn.prepare(&format!(
                "INSERT INTO {table} (session_id, block_id, {text}) VALUES (?1, ?2, ?3, ?4)"
            ))?;
            for (block, body, at) in rows {
                insert.execute(params![namespace, block, body, at])?;
            }
        }
        if let Some(frontier) = self.overlay_frontier {
            conn.execute(
                "INSERT INTO mc_overlay_frontiers (session_id, max_seen_ordinal) VALUES (?1, ?2)",
                params![namespace, frontier],
            )?;
        }
        for (target, queued) in &self.pending_drops {
            conn.execute(
                    "INSERT INTO pending_agent_drops (session_id, target_id, queued_at) VALUES (?1, ?2, ?3)",
                    params![namespace, target, queued],
                )?;
        }
        for (tag, session) in &self.consumed_tags {
            conn.execute(
                    "INSERT OR IGNORE INTO mc_provider_consumed_tags_v1 (engine_namespace, tag_number, session) VALUES (?1, ?2, ?3)",
                    params![namespace, tag, session],
                )?;
        }
        Ok(())
    }
}

#[cfg(test)]
thread_local! {
    static FAIL_ADOPTION_BEFORE_OVERLAYS: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static CRASH_ADOPTION_BEFORE_OVERLAYS: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open(dir: &std::path::Path) -> McStore {
        McStore::open_for_test(&cortexkit_store_types::StorageDescriptor {
            module_id: "magic-context-test".into(),
            storage_namespace: "mc_cache".into(),
            isolation: cortexkit_store_types::Isolation::Module,
            backend: cortexkit_store_types::StorageBackend::Sqlite {
                path: dir.join("store.db").to_string_lossy().into(),
            },
        })
        .unwrap()
    }

    #[test]
    #[cfg(unix)]
    fn adoption_crash_between_cache_and_overlays_is_atomic() {
        use std::os::unix::process::ExitStatusExt;
        let dir = tempfile::tempdir().unwrap();
        let store = open(dir.path());
        store
            .adopt_namespace_head("s", &NamespaceHead::default())
            .unwrap();
        let before = store.load_namespace_head("s").unwrap().unwrap();
        drop(store);
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "cut_head::tests::adoption_crash_worker",
                "--ignored",
                "--nocapture",
            ])
            .env("MC_TEST_ADOPTION_ROOT", dir.path())
            .status()
            .unwrap();
        assert_eq!(
            status.signal(),
            Some(6),
            "the child must abort at the write boundary, not fail an assertion"
        );
        let store = open(dir.path());
        assert_eq!(store.load_namespace_head("s").unwrap().unwrap(), before);
    }

    #[test]
    #[ignore = "crash helper; invoked only by adoption_crash_between_cache_and_overlays_is_atomic"]
    fn adoption_crash_worker() {
        let root =
            std::env::var_os("MC_TEST_ADOPTION_ROOT").expect("parent supplies a private store");
        let store = open(std::path::Path::new(&root));
        let mut head = store.load_namespace_head("s").unwrap().unwrap();
        head.core.boundary_id = "new head".into();
        head.temporal_marks
            .push(("m#0".into(), "new mark".into(), 1));
        CRASH_ADOPTION_BEFORE_OVERLAYS.with(|flag| flag.set(true));
        store.adopt_namespace_head("s", &head).unwrap();
        panic!("the crash point did not execute");
    }

    #[test]
    fn adoption_failure_between_cache_and_overlays_rolls_back() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open_for_test(&cortexkit_store_types::StorageDescriptor {
            module_id: "magic-context-test".into(),
            storage_namespace: "mc_cache".into(),
            isolation: cortexkit_store_types::Isolation::Module,
            backend: cortexkit_store_types::StorageBackend::Sqlite {
                path: dir.path().join("store.db").to_string_lossy().into(),
            },
        })
        .unwrap();
        let original = NamespaceHead::default();
        store.adopt_namespace_head("s", &original).unwrap();
        let before = store.load_namespace_head("s").unwrap().unwrap();
        let version = store.load_meta("s").unwrap().row_version;
        let mut replacement = before.clone();
        replacement.core.boundary_id = "new-head".into();
        replacement
            .temporal_marks
            .push(("m#0".into(), "new mark".into(), 1));
        FAIL_ADOPTION_BEFORE_OVERLAYS.with(|flag| flag.set(true));
        assert!(store.adopt_namespace_head("s", &replacement).is_err());
        assert_eq!(store.load_namespace_head("s").unwrap().unwrap(), before);
        assert_eq!(store.load_meta("s").unwrap().row_version, version);
        store.adopt_namespace_head("s", &replacement).unwrap();
        assert_eq!(
            store.load_namespace_head("s").unwrap().unwrap(),
            replacement
        );
    }
}
