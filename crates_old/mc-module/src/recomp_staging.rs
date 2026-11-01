//! Stage a resumable rebuild of compressed session history from raw messages.
//!
//! A ready result has not replaced the history visible to callers. The backend
//! exposes only staging storage and the existing session mutation lease: it cannot
//! publish compartments, write project memory, or invalidate cached prompts. Model
//! calls run between these bounded methods, with no storage transaction held.
#![allow(dead_code)] // Remove when a persistent backend connects this currently unexposed entry.

use std::{collections::BTreeMap, ops::Range};

use serde::{Deserialize, Serialize};

use crate::historian_validate::{validate_stored_compartments, StoredCompartmentRange};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompartmentInput {
    pub sequence: u64,
    pub start_message: u64,
    pub end_message: u64,
    pub start_message_id: String,
    pub end_message_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_block_index: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_block_index: Option<u64>,
    pub title: String,
    pub content: String,
    pub p1: Option<String>,
    pub p2: Option<String>,
    pub p3: Option<String>,
    pub p4: Option<String>,
    #[serde(
        default = "default_importance",
        deserialize_with = "importance_or_default"
    )]
    pub importance: i32,
    pub episode_type: Option<String>,
}

fn default_importance() -> i32 {
    50
}

fn importance_or_default<'de, D: serde::Deserializer<'de>>(d: D) -> Result<i32, D::Error> {
    Ok(Option::<i32>::deserialize(d)?.unwrap_or_else(default_importance))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StagedFact {
    pub category: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StagedCompartment {
    pub compartment: CompartmentInput,
    pub pass_number: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StagingRows {
    pub compartments: BTreeMap<u64, StagedCompartment>,
    pub facts: Vec<StagedFact>,
}

impl StagingRows {
    /// Sequence is the upsert key; omitted compartments survive a subsequent save.
    /// Facts, unlike compartments, are the historian's complete replacement list.
    pub fn save_pass(
        &mut self,
        pass: u64,
        compartments: &[CompartmentInput],
        facts: &[StagedFact],
    ) {
        for compartment in compartments {
            self.compartments.insert(
                compartment.sequence,
                StagedCompartment {
                    compartment: compartment.clone(),
                    pass_number: pass,
                },
            );
        }
        self.facts = facts.to_vec();
    }

    pub fn snapshot(&self) -> Option<StagingSnapshot> {
        let last = self.compartments.last_key_value()?.1;
        Some(StagingSnapshot {
            compartments: self
                .compartments
                .values()
                .map(|r| r.compartment.clone())
                .collect(),
            facts: self.facts.clone(),
            pass_count: self
                .compartments
                .values()
                .map(|r| r.pass_number)
                .max()
                .unwrap_or(0),
            // The TypeScript resume cursor uses the last sequence's raw message end,
            // not the largest message number among all staged compartments.
            last_end_message: last.compartment.end_message,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StagingSnapshot {
    pub compartments: Vec<CompartmentInput>,
    pub facts: Vec<StagedFact>,
    pub pass_count: u64,
    pub last_end_message: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StagingScope {
    pub harness: String,
    pub session_id: String,
}

/// The adapter must scope every operation by both harness and session. `update`
/// commits all staging rows and facts atomically, or leaves them unchanged on error.
/// Lease methods reuse compartment_state_lease, the per-session lock shared with
/// wrapup and incremental history writers, including its TTL, dead-owner reclaim
/// and renewal. A historian run's claim token is not this shared exclusion.
/// No store transaction or connection lock may remain held after a method returns.
pub trait DurableStagingBackend {
    type Error;
    fn load(&mut self, scope: &StagingScope) -> Result<StagingRows, Self::Error>;
    fn update<F>(&mut self, scope: &StagingScope, change: F) -> Result<(), Self::Error>
    where
        F: FnOnce(&mut StagingRows);
    fn wrapup_in_progress(&mut self, scope: &StagingScope) -> Result<bool, Self::Error>;
    fn acquire_lease(&mut self, scope: &StagingScope, holder: &str) -> Result<bool, Self::Error>;
    fn owns_lease(&mut self, scope: &StagingScope, holder: &str) -> Result<bool, Self::Error>;
    fn release_lease(&mut self, scope: &StagingScope, holder: &str);
}

#[derive(Debug, PartialEq, Eq)]
pub enum StagingError<E> {
    Backend(E),
    LeaseLost,
    NoForwardProgress,
    InvalidCompartments(String),
    Empty,
}

#[derive(Debug, PartialEq, Eq)]
pub enum NotStarted {
    Wrapup,
    AlreadyRunning,
    LeaseBusy,
    OrdinalsWarming,
    NoRawHistory,
}

#[derive(Debug, Clone, Copy)]
pub struct RawHistory {
    pub ordinals_ready: bool,
    pub message_count: u64,
    pub protected_tail_start: u64,
}

struct Lease<'a, B: DurableStagingBackend> {
    backend: &'a mut B,
    scope: StagingScope,
    holder: String,
}

impl<B: DurableStagingBackend> Drop for Lease<'_, B> {
    fn drop(&mut self) {
        self.backend.release_lease(&self.scope, &self.holder);
    }
}

pub struct RecompStager<'a, B: DurableStagingBackend> {
    lease: Lease<'a, B>,
    candidates: StagingSnapshot,
    offset: u64,
    protected_tail_start: u64,
    resumed: bool,
}

/// Contains no facts: rebuilding old history must not overwrite project memories
/// that the user or memory maintenance may have edited since the original history.
/// Candidates remain staged even after this result; the caller has not published.
#[derive(Debug, PartialEq, Eq)]
pub struct ReadyRecomp {
    pub compartments: Vec<CompartmentInput>,
    pub pass_count: u64,
    pub last_end_message: u64,
    pub resumed: bool,
}

impl<'a, B: DurableStagingBackend> RecompStager<'a, B> {
    pub fn begin(
        backend: &'a mut B,
        scope: StagingScope,
        holder: String,
        already_running: bool,
        raw: RawHistory,
    ) -> Result<Result<Self, NotStarted>, StagingError<B::Error>> {
        if backend
            .wrapup_in_progress(&scope)
            .map_err(StagingError::Backend)?
        {
            return Ok(Err(NotStarted::Wrapup));
        }
        if already_running {
            return Ok(Err(NotStarted::AlreadyRunning));
        }
        if !backend
            .acquire_lease(&scope, &holder)
            .map_err(StagingError::Backend)?
        {
            return Ok(Err(NotStarted::LeaseBusy));
        }
        let lease = Lease {
            backend,
            scope,
            holder,
        };
        // The wrapup orchestrator sets its marker before waiting for the lease.
        // Recheck after acquisition to close the race with the first marker read.
        if lease
            .backend
            .wrapup_in_progress(&lease.scope)
            .map_err(StagingError::Backend)?
        {
            return Ok(Err(NotStarted::Wrapup));
        }
        if !raw.ordinals_ready {
            return Ok(Err(NotStarted::OrdinalsWarming));
        }
        if raw.message_count == 0 {
            return Ok(Err(NotStarted::NoRawHistory));
        }
        let saved = lease
            .backend
            .load(&lease.scope)
            .map_err(StagingError::Backend)?
            .snapshot();
        let resumed = saved.is_some();
        let offset = saved
            .as_ref()
            .map_or(1, |s| s.last_end_message.saturating_add(1));
        let candidates = saved.unwrap_or(StagingSnapshot {
            compartments: Vec::new(),
            facts: Vec::new(),
            pass_count: 0,
            last_end_message: 0,
        });
        Ok(Ok(Self {
            lease,
            candidates,
            offset,
            resumed,
            protected_tail_start: raw
                .protected_tail_start
                .min(raw.message_count.saturating_add(1)),
        }))
    }

    pub fn snapshot(&self) -> &StagingSnapshot {
        &self.candidates
    }

    pub fn next_range(&self) -> Option<Range<u64>> {
        (self.offset < self.protected_tail_start).then_some(self.offset..self.protected_tail_start)
    }

    /// Called only after a validated historian pass. The caller does any model
    /// work outside the backend, and supplies the raw chunk end for empty output.
    pub fn save_validated_pass(
        &mut self,
        compartments: Vec<CompartmentInput>,
        facts: Vec<StagedFact>,
        chunk_end: u64,
    ) -> Result<(), StagingError<B::Error>> {
        let next_offset = compartments
            .last()
            .map_or(chunk_end, |c| c.end_message)
            .saturating_add(1);
        let mut next = self.candidates.clone();
        next.compartments.extend(compartments);
        next.facts = facts;
        next.pass_count += 1;
        next.last_end_message = next.compartments.last().map_or(0, |c| c.end_message);
        self.persist(&next)?;
        self.candidates = next;
        if next_offset <= self.offset {
            return Err(StagingError::NoForwardProgress);
        }
        self.offset = next_offset;
        Ok(())
    }

    fn persist(&mut self, next: &StagingSnapshot) -> Result<(), StagingError<B::Error>> {
        self.lease
            .backend
            .update(&self.lease.scope, |rows| {
                rows.save_pass(next.pass_count, &next.compartments, &next.facts);
            })
            .map_err(StagingError::Backend)
    }

    /// Validate the merged candidate set and leave it durable for a future publisher.
    /// Unlike the TypeScript recomp runner, this component never promotes staged
    /// rows to served history. Dropping an interrupted run also preserves staging.
    pub fn finish(mut self) -> Result<ReadyRecomp, StagingError<B::Error>> {
        let ranges: Vec<_> = self
            .candidates
            .compartments
            .iter()
            .map(|c| StoredCompartmentRange {
                start_message: c.start_message,
                end_message: c.end_message,
            })
            .collect();
        if let Some(reason) = validate_stored_compartments(&ranges) {
            self.lease
                .backend
                .update(&self.lease.scope, |rows| *rows = StagingRows::default())
                .map_err(StagingError::Backend)?;
            return Err(StagingError::InvalidCompartments(reason));
        }
        self.persist(&self.candidates.clone())?;
        if !self
            .lease
            .backend
            .owns_lease(&self.lease.scope, &self.lease.holder)
            .map_err(StagingError::Backend)?
        {
            return Err(StagingError::LeaseLost);
        }
        if self.candidates.compartments.is_empty() {
            return Err(StagingError::Empty);
        }
        Ok(ReadyRecomp {
            compartments: self.candidates.compartments.clone(),
            pass_count: self.candidates.pass_count,
            last_end_message: self.candidates.last_end_message,
            resumed: self.resumed,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, path::Path, rc::Rc};

    use rusqlite::{params, Connection, OptionalExtension};
    use serde_json::{json, Value};

    #[derive(Default)]
    struct Controls {
        wrapup: bool,
        wrapup_after_acquire: bool,
        holder: Option<String>,
        fail_update: bool,
        fail_load: bool,
        acquisitions: usize,
        releases: usize,
    }

    // A file-backed adapter exercises commit, rollback and reopen without adding a
    // production table. A production adapter must provide this contract in mc-store.
    struct TestBackend {
        conn: Connection,
        controls: Rc<RefCell<Controls>>,
    }

    impl TestBackend {
        fn open(path: &Path) -> Self {
            let conn = Connection::open(path).unwrap();
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS staging(harness TEXT, session TEXT, body TEXT,
                   PRIMARY KEY(harness,session));
                 CREATE TABLE IF NOT EXISTS served_state(body TEXT);
                 INSERT INTO served_state SELECT 'compartments,memory,cache-epoch'
                   WHERE NOT EXISTS(SELECT 1 FROM served_state);",
            )
            .unwrap();
            Self {
                conn,
                controls: Rc::default(),
            }
        }

        fn served(&self) -> String {
            self.conn
                .query_row("SELECT body FROM served_state", [], |r| r.get(0))
                .unwrap()
        }
    }

    impl DurableStagingBackend for TestBackend {
        type Error = rusqlite::Error;

        fn load(&mut self, scope: &StagingScope) -> rusqlite::Result<StagingRows> {
            if self.controls.borrow().fail_load {
                return Err(rusqlite::Error::InvalidQuery);
            }
            let body: Option<String> = self
                .conn
                .query_row(
                    "SELECT body FROM staging WHERE harness=?1 AND session=?2",
                    params![scope.harness, scope.session_id],
                    |r| r.get(0),
                )
                .optional()?;
            Ok(body
                .map(|s| serde_json::from_str(&s).unwrap())
                .unwrap_or_default())
        }

        fn update<F>(&mut self, scope: &StagingScope, change: F) -> rusqlite::Result<()>
        where
            F: FnOnce(&mut StagingRows),
        {
            let tx = self
                .conn
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let body: Option<String> = tx
                .query_row(
                    "SELECT body FROM staging WHERE harness=?1 AND session=?2",
                    params![scope.harness, scope.session_id],
                    |r| r.get(0),
                )
                .optional()?;
            let mut rows = body
                .map(|s| serde_json::from_str(&s).unwrap())
                .unwrap_or_default();
            change(&mut rows);
            tx.execute(
                "INSERT OR REPLACE INTO staging VALUES (?1,?2,?3)",
                params![
                    scope.harness,
                    scope.session_id,
                    serde_json::to_string(&rows).unwrap()
                ],
            )?;
            if self.controls.borrow().fail_update {
                return Err(rusqlite::Error::InvalidQuery);
            }
            tx.commit()
        }

        fn wrapup_in_progress(&mut self, _: &StagingScope) -> rusqlite::Result<bool> {
            Ok(self.controls.borrow().wrapup)
        }
        fn acquire_lease(&mut self, _: &StagingScope, holder: &str) -> rusqlite::Result<bool> {
            let mut c = self.controls.borrow_mut();
            c.acquisitions += 1;
            if c.holder.is_some() {
                return Ok(false);
            }
            c.holder = Some(holder.into());
            c.wrapup |= c.wrapup_after_acquire;
            Ok(true)
        }
        fn owns_lease(&mut self, _: &StagingScope, holder: &str) -> rusqlite::Result<bool> {
            Ok(self.controls.borrow().holder.as_deref() == Some(holder))
        }
        fn release_lease(&mut self, _: &StagingScope, holder: &str) {
            let mut c = self.controls.borrow_mut();
            c.releases += 1;
            if c.holder.as_deref() == Some(holder) {
                c.holder = None;
            }
        }
    }

    fn scope(session: &str) -> StagingScope {
        StagingScope {
            harness: "fixture".into(),
            session_id: session.into(),
        }
    }

    fn raw() -> RawHistory {
        RawHistory {
            ordinals_ready: true,
            message_count: 20,
            protected_tail_start: 16,
        }
    }

    fn start(backend: &mut TestBackend) -> RecompStager<'_, TestBackend> {
        RecompStager::begin(backend, scope("a"), "rust-recomp".into(), false, raw())
            .unwrap()
            .ok()
            .unwrap()
    }

    fn compartment(sequence: u64, start: u64, end: u64) -> CompartmentInput {
        serde_json::from_value(json!({
            "sequence": sequence, "startMessage": start, "endMessage": end,
            "startMessageId": format!("m{start}"), "endMessageId": format!("m{end}"),
            "title": format!("part {sequence}"), "content": format!("body {sequence}")
        }))
        .unwrap()
    }

    fn facts(text: &str) -> Vec<StagedFact> {
        vec![StagedFact {
            category: "knowledge".into(),
            content: text.into(),
        }]
    }

    // Recorded by executing saveRecompStagingPass/getRecompStaging/clearRecompStaging
    // from the TypeScript staging implementation, which defines ordering, upserts
    // and fact replacement, at commit 282d9c08bce490346583a3b8c145c402499f980f.
    // Full oracle JSON SHA-256:
    // 7028bbcc42f04740b861fc259f23157a67203a8a7211eb2166b7200a2761aa50.
    // Optional fields and row order are compared, not reconstructed from Rust output.
    const FIRST: &str = r#"{"compartments":[{"sequence":1,"startMessage":1,"endMessage":7,"startMessageId":"m1","endMessageId":"m7","title":"part 1","content":"body 1","p1":null,"p2":null,"p3":null,"p4":null,"importance":50,"episodeType":null},{"sequence":2,"startMessage":8,"endMessage":9,"startMessageId":"m8","endMessageId":"m9","startBlockIndex":0,"endBlockIndex":2,"title":"part 2","content":"body 2","p1":"tier one","p2":null,"p3":null,"p4":"tier four","importance":91,"episodeType":"coding"}],"facts":[{"category":"knowledge","content":"first"}],"passCount":2,"lastEndMessage":9}"#;
    const REPLACED: &str = r#"{"compartments":[{"sequence":1,"startMessage":1,"endMessage":6,"startMessageId":"m1","endMessageId":"m6","title":"part 1","content":"replacement","p1":null,"p2":null,"p3":null,"p4":null,"importance":50,"episodeType":null},{"sequence":2,"startMessage":8,"endMessage":9,"startMessageId":"m8","endMessageId":"m9","startBlockIndex":0,"endBlockIndex":2,"title":"part 2","content":"body 2","p1":"tier one","p2":null,"p3":null,"p4":"tier four","importance":91,"episodeType":"coding"}],"facts":[{"category":"knowledge","content":"latest"}],"passCount":4,"lastEndMessage":9}"#;

    #[test]
    fn staging_values_match_pinned_typescript_oracle() {
        let dir = tempfile::tempdir().unwrap();
        let mut backend = TestBackend::open(&dir.path().join("staging.db"));
        let mut rich = compartment(2, 8, 9);
        rich.start_block_index = Some(0);
        rich.end_block_index = Some(2);
        rich.p1 = Some("tier one".into());
        rich.p4 = Some("tier four".into());
        rich.importance = 91;
        rich.episode_type = Some("coding".into());
        backend
            .update(&scope("a"), |s| {
                s.save_pass(2, &[rich, compartment(1, 1, 7)], &facts("first"))
            })
            .unwrap();
        let expected: Value = serde_json::from_str(FIRST).unwrap();
        assert_eq!(
            serde_json::to_value(backend.load(&scope("a")).unwrap().snapshot()).unwrap(),
            expected
        );
        backend
            .update(&scope("b"), |s| {
                s.save_pass(99, &[compartment(1, 1, 3)], &facts("foreign"))
            })
            .unwrap();
        assert_eq!(
            serde_json::to_value(backend.load(&scope("a")).unwrap().snapshot()).unwrap(),
            expected
        );
        let mut replacement = compartment(1, 1, 6);
        replacement.content = "replacement".into();
        backend
            .update(&scope("a"), |s| {
                s.save_pass(4, &[replacement], &facts("latest"))
            })
            .unwrap();
        let mut expected: Value = serde_json::from_str(REPLACED).unwrap();
        assert_eq!(
            serde_json::to_value(backend.load(&scope("a")).unwrap().snapshot()).unwrap(),
            expected
        );
        backend
            .update(&scope("a"), |s| s.save_pass(3, &[], &[]))
            .unwrap();
        expected["facts"] = json!([]);
        assert_eq!(
            serde_json::to_value(backend.load(&scope("a")).unwrap().snapshot()).unwrap(),
            expected
        );
        backend
            .update(&scope("a"), |s| *s = StagingRows::default())
            .unwrap();
        assert!(backend.load(&scope("a")).unwrap().snapshot().is_none());
        assert_eq!(
            backend
                .load(&scope("b"))
                .unwrap()
                .snapshot()
                .unwrap()
                .pass_count,
            99
        );
        let foreign_harness = StagingScope {
            harness: "other".into(),
            session_id: "b".into(),
        };
        assert!(backend.load(&foreign_harness).unwrap().snapshot().is_none());
    }

    #[test]
    fn resume_after_reopen_keeps_passes_facts_and_protected_tail() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("staging.db");
        {
            let mut backend = TestBackend::open(&path);
            let mut run = start(&mut backend);
            assert_eq!(run.next_range(), Some(1..16));
            run.save_validated_pass(vec![compartment(1, 1, 5)], facts("first"), 9)
                .unwrap();
            assert_eq!(run.next_range(), Some(6..16));
            run.save_validated_pass(vec![compartment(2, 6, 10)], facts("latest"), 12)
                .unwrap();
            // Drop without finishing, then reopen the file to check durable resume.
        }
        let mut backend = TestBackend::open(&path);
        let before = "compartments,memory,cache-epoch";
        assert_eq!(backend.served(), before);
        let mut run = start(&mut backend);
        assert!(run.resumed);
        assert_eq!(run.next_range(), Some(11..16));
        assert_eq!(run.snapshot().pass_count, 2);
        assert_eq!(run.snapshot().facts, facts("latest"));
        run.save_validated_pass(vec![compartment(3, 11, 15)], vec![], 15)
            .unwrap();
        assert_eq!(run.next_range(), None);
        let ready = run.finish().unwrap();
        assert_eq!(
            (
                ready.compartments.len(),
                ready.pass_count,
                ready.last_end_message
            ),
            (3, 3, 15)
        );
        assert!(ready.resumed);
        assert_eq!(backend.served(), before);
        assert_eq!(
            backend
                .load(&scope("a"))
                .unwrap()
                .snapshot()
                .unwrap()
                .compartments,
            ready.compartments
        );
        assert!(backend.controls.borrow().holder.is_none());
    }

    #[test]
    fn admission_matches_ts_skip_defer_and_lease_marker_race() {
        for case in 0..7 {
            let dir = tempfile::tempdir().unwrap();
            let mut backend = TestBackend::open(&dir.path().join("staging.db"));
            let before = backend.served();
            let mut input = raw();
            match case {
                0 => backend.controls.borrow_mut().wrapup = true,
                2 => backend.controls.borrow_mut().holder = Some("ts-wrapup".into()),
                3 => backend.controls.borrow_mut().wrapup_after_acquire = true,
                4 => input.ordinals_ready = false,
                5 => input.message_count = 0,
                6 => backend.controls.borrow_mut().fail_load = true,
                _ => {}
            }
            {
                let result =
                    RecompStager::begin(&mut backend, scope("a"), "rust".into(), case == 1, input);
                if case == 6 {
                    assert!(matches!(result, Err(StagingError::Backend(_))));
                } else {
                    let reason = result.unwrap().err().unwrap();
                    let expected = match case {
                        0 | 3 => NotStarted::Wrapup,
                        1 => NotStarted::AlreadyRunning,
                        2 => NotStarted::LeaseBusy,
                        4 => NotStarted::OrdinalsWarming,
                        _ => NotStarted::NoRawHistory,
                    };
                    assert_eq!(reason, expected, "admission case {case}");
                }
            }
            assert_eq!(backend.served(), before);
            assert_eq!(
                backend
                    .conn
                    .query_row("SELECT count(*) FROM staging", [], |r| r.get::<_, u64>(0))
                    .unwrap(),
                0
            );
            let c = backend.controls.borrow();
            assert_eq!(c.acquisitions, usize::from(case >= 2));
            assert_eq!(c.releases, usize::from(case >= 3));
            assert_eq!(
                c.holder.as_deref(),
                if case == 2 { Some("ts-wrapup") } else { None }
            );
        }
    }

    #[test]
    fn failed_pass_transaction_preserves_resume_and_served_state() {
        let dir = tempfile::tempdir().unwrap();
        let mut backend = TestBackend::open(&dir.path().join("staging.db"));
        let before = backend.served();
        let controls = backend.controls.clone();
        let mut run = start(&mut backend);
        run.save_validated_pass(vec![compartment(1, 1, 5)], facts("first"), 5)
            .unwrap();
        controls.borrow_mut().fail_update = true;
        assert!(matches!(
            run.save_validated_pass(vec![compartment(2, 6, 10)], facts("lost"), 10),
            Err(StagingError::Backend(_))
        ));
        assert_eq!(run.snapshot().facts, facts("first"));
        assert_eq!(run.next_range(), Some(6..16));
        drop(run);
        controls.borrow_mut().fail_update = false;
        assert_eq!(
            backend.load(&scope("a")).unwrap().snapshot().unwrap().facts,
            facts("first")
        );
        assert_eq!(backend.served(), before);
    }

    #[test]
    fn lease_loss_keeps_staging_and_does_not_release_the_new_holder() {
        let dir = tempfile::tempdir().unwrap();
        let mut backend = TestBackend::open(&dir.path().join("staging.db"));
        let before = backend.served();
        let controls = backend.controls.clone();
        let mut run = start(&mut backend);
        run.save_validated_pass(vec![compartment(1, 1, 5)], facts("first"), 5)
            .unwrap();
        controls.borrow_mut().holder = Some("ts-recomp".into());
        assert_eq!(run.finish(), Err(StagingError::LeaseLost));
        assert_eq!(controls.borrow().holder.as_deref(), Some("ts-recomp"));
        assert_eq!(
            backend
                .load(&scope("a"))
                .unwrap()
                .snapshot()
                .unwrap()
                .last_end_message,
            5
        );
        assert_eq!(backend.served(), before);
    }

    #[test]
    fn invalid_merged_ranges_clear_staging_only() {
        let dir = tempfile::tempdir().unwrap();
        let mut backend = TestBackend::open(&dir.path().join("staging.db"));
        let before = backend.served();
        let mut run = start(&mut backend);
        run.save_validated_pass(vec![compartment(1, 1, 5)], facts("first"), 5)
            .unwrap();
        run.save_validated_pass(vec![compartment(2, 5, 10)], facts("latest"), 10)
            .unwrap();
        assert!(matches!(
            run.finish(),
            Err(StagingError::InvalidCompartments(_))
        ));
        assert!(backend.load(&scope("a")).unwrap().snapshot().is_none());
        assert_eq!(backend.served(), before);
    }

    #[test]
    fn empty_pass_advances_by_chunk_and_facts_alone_are_not_resumable() {
        let dir = tempfile::tempdir().unwrap();
        let mut backend = TestBackend::open(&dir.path().join("staging.db"));
        let mut run = start(&mut backend);
        run.save_validated_pass(vec![], facts("ignored"), 4)
            .unwrap();
        assert_eq!(run.next_range(), Some(5..16));
        assert_eq!(run.finish(), Err(StagingError::Empty));
        assert!(!start(&mut backend).resumed);
    }

    #[test]
    fn no_progress_is_reported_and_raw_count_bounds_the_range() {
        let dir = tempfile::tempdir().unwrap();
        let mut backend = TestBackend::open(&dir.path().join("staging.db"));
        let input = RawHistory {
            message_count: 3,
            ..raw()
        };
        let mut run = RecompStager::begin(&mut backend, scope("a"), "rust".into(), false, input)
            .unwrap()
            .ok()
            .unwrap();
        assert_eq!(run.next_range(), Some(1..4));
        run.save_validated_pass(vec![], vec![], 2).unwrap();
        assert_eq!(run.next_range(), Some(3..4));
        assert_eq!(
            run.save_validated_pass(vec![], vec![], 2),
            Err(StagingError::NoForwardProgress)
        );
        assert_eq!(run.next_range(), Some(3..4));
    }
}
