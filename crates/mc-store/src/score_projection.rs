//! Read-only views of `/ctx-rescore` score overrides for compartments.
//!
//! The host writes rescored importance into two context.db sidecar tables:
//! `compartment_score_revisions` (one row per scored answer) and
//! `compartment_score_selections` (an append-only, per-session sequence that
//! picks which revision is active for each compartment; a row without a
//! revision is an undo back to the original score). The module only reads
//! them and never writes `compartments.importance`, so boundary fingerprints,
//! history revisions and other writes keep using the original rows.
//!
//! A published score is recorded but stays pending: it reaches the cached m0
//! only when a rebuild that is already happening for another reason commits, and
//! never requests a rebuild itself. That commit stores the selection sequence it
//! rendered (the score watermark) with the bytes in `ModuleMeta`. See
//! `docs/designs/compartment-rescore.md`.

use std::collections::HashMap;

use rusqlite::{params, Connection};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::{McStore, McStoreError, StoredCompartment};

pub const RESCORE_RUBRIC_VERSION: i64 = 1;

/// Which score view to read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScoreSelector {
    /// Original historian scores only; score tables are not read.
    Base,
    /// The selections at or below this sequence: reproduces a view already
    /// committed with m0.
    AtWatermark(i64),
    /// Every selection published so far, including pending ones.
    Latest,
}

/// Scores are keyed by sequence only within this snapshot's session. They must be
/// applied to render copies, never to the base rows returned alongside them.
/// `watermark` is the highest selection sequence the view covers (zero for
/// original scores).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompartmentScoreSnapshot {
    pub compartments: Vec<StoredCompartment>,
    pub importance_by_sequence: HashMap<i64, i32>,
    pub watermark: i64,
}

impl CompartmentScoreSnapshot {
    pub fn base(compartments: Vec<StoredCompartment>) -> Self {
        Self {
            compartments,
            importance_by_sequence: HashMap::new(),
            watermark: 0,
        }
    }
}

/// The compartment content a score was produced for. A revision applies only
/// while its stored `source_identity` still matches this hash, so a score never
/// lands on a compartment that was edited, recompacted or given a different
/// original score after it was scored.
/// The hash uses the host's original message IDs and block indices, not IDs or
/// dates resolved by the module, and its field framing (byte-length-prefixed
/// UTF-8 strings) matches the TypeScript writer.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Source {
    id: i64,
    session_id: String,
    created_at: i64,
    title: String,
    episode_type: Option<String>,
    legacy: i64,
    content: String,
    p1: Option<String>,
    p2: Option<String>,
    p3: Option<String>,
    p4: Option<String>,
    sequence: i64,
    start_message: i64,
    end_message: i64,
    start_message_id: String,
    end_message_id: String,
    start_block_index: Option<i64>,
    end_block_index: Option<i64>,
    importance: i64,
}

impl Source {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            session_id: row.get(1)?,
            created_at: row.get(2)?,
            title: row.get(3)?,
            episode_type: row.get(4)?,
            legacy: row.get(5)?,
            content: row.get(6)?,
            p1: row.get(7)?,
            p2: row.get(8)?,
            p3: row.get(9)?,
            p4: row.get(10)?,
            sequence: row.get(11)?,
            start_message: row.get(12)?,
            end_message: row.get(13)?,
            start_message_id: row.get::<_, Option<String>>(14)?.unwrap_or_default(),
            end_message_id: row.get::<_, Option<String>>(15)?.unwrap_or_default(),
            start_block_index: row.get(16)?,
            end_block_index: row.get(17)?,
            importance: row.get(18)?,
        })
    }

    fn identity(&self) -> String {
        fn integer(hash: &mut Sha256, value: i64) {
            hash.update(format!("I{value};"));
        }
        fn optional_integer(hash: &mut Sha256, value: Option<i64>) {
            match value {
                Some(value) => integer(hash, value),
                None => hash.update(b"N;"),
            }
        }
        fn string(hash: &mut Sha256, value: Option<&str>) {
            match value {
                Some(value) => {
                    hash.update(format!("S{}:", value.len()));
                    hash.update(value.as_bytes());
                    hash.update(b";");
                }
                None => hash.update(b"N;"),
            }
        }
        let mut hash = Sha256::new();
        hash.update(b"mc-rescore-source-v1\0");
        integer(&mut hash, self.id);
        string(&mut hash, Some(&self.session_id));
        integer(&mut hash, self.created_at);
        string(&mut hash, Some(&self.title));
        string(&mut hash, self.episode_type.as_deref());
        integer(&mut hash, self.legacy);
        string(
            &mut hash,
            (self.legacy != 0).then_some(self.content.as_str()),
        );
        for tier in [&self.p1, &self.p2, &self.p3, &self.p4] {
            string(
                &mut hash,
                if self.legacy == 0 {
                    tier.as_deref()
                } else {
                    None
                },
            );
        }
        integer(&mut hash, self.sequence);
        integer(&mut hash, self.start_message);
        integer(&mut hash, self.end_message);
        string(&mut hash, Some(&self.start_message_id));
        string(&mut hash, Some(&self.end_message_id));
        optional_integer(&mut hash, self.start_block_index);
        optional_integer(&mut hash, self.end_block_index);
        integer(&mut hash, self.importance);
        format!("{:x}", hash.finalize())
    }
}

pub(crate) fn score_view_tx(
    conn: &Connection,
    session_id: &str,
    selector: ScoreSelector,
) -> rusqlite::Result<(HashMap<i64, i32>, i64)> {
    if selector == ScoreSelector::Base {
        return Ok((HashMap::new(), 0));
    }
    // Hosts without score tables render original scores at watermark zero.
    // The module only reads these tables; it does not own their writes or fingerprints.
    let table_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'
         AND name IN ('compartment_score_revisions', 'compartment_score_selections')",
        [],
        |row| row.get(0),
    )?;
    if table_count != 2 {
        return Ok((HashMap::new(), 0));
    }
    let watermark = match selector {
        ScoreSelector::Base => unreachable!(),
        ScoreSelector::AtWatermark(value) => value.max(0),
        ScoreSelector::Latest => conn.query_row(
            "SELECT COALESCE(MAX(sequence), 0) FROM compartment_score_selections WHERE session_id = ?1",
            [session_id],
            |row| row.get(0),
        )?,
    };
    let mut stmt = conn.prepare(
        "SELECT c.id, c.session_id, c.created_at, c.title, c.episode_type,
                COALESCE(c.legacy, 0), c.content, c.p1, c.p2, c.p3, c.p4,
                c.sequence, c.start_message, c.end_message, c.start_message_id,
                c.end_message_id, c.start_block_index, c.end_block_index,
                COALESCE(c.importance, 50), r.source_identity, r.new_importance
         FROM compartments c
         JOIN compartment_score_selections s ON s.session_id = c.session_id
             AND s.compartment_id = c.id
             AND s.sequence = (SELECT MAX(active.sequence) FROM compartment_score_selections active
                 WHERE active.session_id = c.session_id AND active.compartment_id = c.id
                     AND active.sequence <= ?2)
         JOIN compartment_score_revisions r ON r.id = s.revision_id
             AND r.session_id = c.session_id AND r.compartment_id = c.id
         WHERE c.session_id = ?1",
    )?;
    let mut scores = HashMap::new();
    let rows = stmt.query_map(params![session_id, watermark], |row| {
        Ok((
            Source::from_row(row)?,
            row.get::<_, String>(19)?,
            row.get::<_, i32>(20)?,
        ))
    })?;
    for row in rows {
        let (source, identity, importance) = row?;
        if source.identity() == identity && (1..=100).contains(&importance) {
            scores.insert(source.sequence, importance);
        }
    }
    Ok((scores, watermark))
}

impl McStore {
    /// Base rows, selected revisions and the highest selection sequence share
    /// one context.db read transaction. Scores published after that read stay
    /// pending until a later rebuild, required for some other reason, reads them.
    pub fn load_compartment_score_snapshot(
        &self,
        session_id: &str,
        selector: ScoreSelector,
    ) -> Result<CompartmentScoreSnapshot, McStoreError> {
        let mut snapshot = self.context_read(|conn| {
            let compartments = self.load_raw_context_compartments_tx(conn, session_id)?;
            let (importance_by_sequence, watermark) = score_view_tx(conn, session_id, selector)?;
            Ok(CompartmentScoreSnapshot {
                compartments,
                importance_by_sequence,
                watermark,
            })
        })?;
        #[cfg(any(test, feature = "test-support"))]
        {
            let hook = self.after_score_snapshot_hook.lock().unwrap().take();
            if let Some(hook) = hook {
                hook();
            }
        }
        self.apply_compartment_dates(session_id, &mut snapshot.compartments)?;
        Ok(snapshot)
    }

    /// Run a test hook once, after the score snapshot is read and before the
    /// caller commits rendered bytes, so a test can publish a competing score in
    /// that window. Only test builds contain the hook.
    #[cfg(any(test, feature = "test-support"))]
    pub fn after_score_snapshot_for_test(&self, hook: impl FnOnce() + Send + 'static) {
        *self.after_score_snapshot_hook.lock().unwrap() = Some(Box::new(hook));
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn install_score_schema_for_test(&self) -> Result<(), McStoreError> {
        let migration = include_str!("../../../packages/plugin/src/features/magic-context/migration-v98-compartment-rescore.ts");
        let sql = migration
            .split("db.exec(`")
            .nth(1)
            .unwrap()
            .split("`);")
            .next()
            .unwrap();
        self.with_context_conn_for_test(|tx| tx.execute_batch(sql))
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn publish_score_for_test(
        &self,
        session_id: &str,
        sequence: i64,
        importance: i32,
    ) -> Result<i64, McStoreError> {
        self.with_context_conn_for_test(|tx| {
            let source = tx.query_row(
                "SELECT id, session_id, created_at, title, episode_type, COALESCE(legacy, 0),
                        content, p1, p2, p3, p4, sequence, start_message, end_message,
                        start_message_id, end_message_id, start_block_index, end_block_index,
                        COALESCE(importance, 50)
                 FROM compartments WHERE session_id = ?1 AND sequence = ?2",
                params![session_id, sequence], Source::from_row,
            )?;
            tx.execute(
                "INSERT INTO compartment_score_revisions
                 (compartment_id, session_id, source_identity, old_importance, new_importance,
                  rubric_version, prompt_hash, model, seed_ids, job_id, batch_id, attempt_id, completed_at, reason)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'hash', 'model', '[]', 'job', 'batch', ?7, 0, 'reason')",
                params![source.id, session_id, source.identity(), source.importance, importance, RESCORE_RUBRIC_VERSION, sequence.to_string()],
            )?;
            let revision_id = tx.last_insert_rowid();
            tx.execute(
                "INSERT INTO compartment_score_selections
                 (session_id, compartment_id, sequence, revision_id, origin, job_id, batch_id, attempt_id)
                 SELECT ?1, ?2, COALESCE(MAX(sequence), 0) + 1, ?3, 'publication', 'job', 'batch', ?4
                 FROM compartment_score_selections WHERE session_id = ?1",
                params![session_id, source.id, revision_id, sequence.to_string()],
            )?;
            Ok(revision_id)
        })
    }
}

#[cfg(test)]
mod tests;
