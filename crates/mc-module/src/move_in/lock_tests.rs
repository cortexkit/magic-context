use super::*;
use crate::move_renumber::{renumber, HostMessage, Numbering};
use std::cell::RefCell;
use std::time::{Duration, Instant};

#[path = "writer_tests.rs"]
mod writer;

pub(crate) type CheckpointSample = (Duration, i64, i64, i64, i64);

thread_local! {
    static SAMPLES: RefCell<Vec<(String, Duration)>> = const { RefCell::new(Vec::new()) };
    static CRASH_AFTER: RefCell<Option<usize>> = const { RefCell::new(None) };
    static CRASH_PHASE: RefCell<Option<&'static str>> = const { RefCell::new(None) };
    static VERBOSE: RefCell<Option<(String,Instant)>> = const { RefCell::new(None) };
    static CHECKPOINT_TARGET: RefCell<Option<i64>> = const { RefCell::new(None) };
    static CHECKPOINTS: RefCell<Vec<CheckpointSample>> = const { RefCell::new(Vec::new()) };
}

pub(crate) fn checkpoint_target(default: i64) -> i64 {
    CHECKPOINT_TARGET.with_borrow(|target| target.unwrap_or(default))
}

pub(crate) fn checkpoint_sample(
    _phase: &str,
    duration: Duration,
    frames: i64,
    log: i64,
    copied: i64,
    busy: i64,
) {
    CHECKPOINTS.with_borrow_mut(|samples| samples.push((duration, frames, log, copied, busy)));
}

pub(crate) fn checkpoint_samples() -> Vec<CheckpointSample> {
    CHECKPOINTS.with_borrow_mut(std::mem::take)
}

fn checkpoint_report(mapped: bool, target: i64, phase: &str) {
    let samples = checkpoint_samples();
    let count = samples.len();
    let total: Duration = samples.iter().map(|s| s.0).sum();
    let longest = samples.iter().map(|s| s.0).max().unwrap_or_default();
    let frames: i64 = samples.iter().map(|s| s.1).sum();
    let max_frames = samples.iter().map(|s| s.1).max().unwrap_or_default();
    let positive: Vec<_> = samples.iter().filter(|s| s.1 > 0).collect();
    let average = if positive.is_empty() {
        0.0
    } else {
        frames as f64 / positive.len() as f64
    };
    let backlog = samples
        .iter()
        .map(|s| (s.2 - s.3).max(0))
        .max()
        .unwrap_or_default();
    let busy = samples.iter().filter(|s| s.4 != 0 || s.2 < 0).count();
    eprintln!("MOVE_CHECKPOINT mapped={mapped} target={target} phase={phase} count={count} total={:.3}ms max={:.3}ms frames_mean_positive={average:.1} frames_max={max_frames} backlog_max={backlog} unavailable={busy}",
        total.as_secs_f64()*1000.0, longest.as_secs_f64()*1000.0);
}

pub(crate) fn after_commit(phase: &str) -> Result<(), String> {
    if CRASH_PHASE.with_borrow_mut(|wanted| {
        if *wanted == Some(phase) {
            *wanted = None;
            true
        } else {
            false
        }
    }) {
        return Err("simulated process exit after commit".into());
    }
    CRASH_AFTER.with_borrow_mut(|remaining| {
        if let Some(left) = remaining {
            if *left == 0 {
                *remaining = None;
                return Err("simulated process exit after commit".into());
            }
            *left -= 1;
        }
        Ok(())
    })
}

pub(crate) struct Measure(String, Instant);

impl Measure {
    pub(crate) fn new(label: &str) -> Self {
        VERBOSE.with_borrow_mut(|state| {
            if let Some((phase, started)) = state {
                if phase != label {
                    eprintln!(
                        "MOVE_PHASE {phase} wall={:.3}s; entering {label}",
                        started.elapsed().as_secs_f64()
                    );
                    *phase = label.into();
                    *started = Instant::now();
                }
            }
        });
        Self(label.into(), Instant::now())
    }
}

impl Drop for Measure {
    fn drop(&mut self) {
        SAMPLES.with_borrow_mut(|samples| samples.push((self.0.clone(), self.1.elapsed())));
    }
}

fn samples() -> Vec<(String, Duration)> {
    SAMPLES.with_borrow_mut(std::mem::take)
}

fn messages(n: usize) -> Vec<HostMessage> {
    let mut messages = vec![
        HostMessage {
            mid: "opener".into(),
            entry: None,
            finished_summary: false,
            added: false,
            pi: None,
        },
        HostMessage {
            mid: "summary".into(),
            entry: None,
            finished_summary: true,
            added: false,
            pi: None,
        },
    ];
    messages.extend((1..=n).map(|i| HostMessage {
        mid: format!("m{i}"),
        entry: Some(i as u64),
        finished_summary: false,
        added: false,
        pi: None,
    }));
    messages
}

fn fixture(path: &std::path::Path, n: usize, others: usize) -> (ContextDb, Numbering) {
    let db = ContextDb::create_for_tests(path).unwrap();
    db.with_connection(|conn| {
        conn.execute_batch(&format!(
            "CREATE TEMP TABLE numbers AS WITH RECURSIVE n(i) AS
               (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i < {n}) SELECT i FROM n;
             BEGIN;
             INSERT INTO tags(session_id, message_id, type, tag_number, byte_size)
               SELECT 'moving', 'm'||i, 'text', i, 512 FROM numbers;
             INSERT INTO source_contents(session_id, tag_id, content, created_at)
               SELECT 'moving', i, 'A tool result with useful source context', 1 FROM numbers;
             INSERT INTO pending_ops(session_id, tag_id, operation, queued_at)
               SELECT 'moving', i, 'drop', 1 FROM numbers;
             INSERT INTO compartments(session_id, sequence, start_message, end_message,
               start_message_id, end_message_id, title, content, p1, created_at)
               SELECT 'moving', i, i+1, MIN(i+100, {n}+1), 'm'||i, 'm'||MIN(i+99, {n}),
                 'Summary', 'Investigated the parser and repaired its error handling', 'Parser repaired', 1
               FROM numbers WHERE (i-1)%100=0;
             INSERT INTO compartment_chunk_embeddings(compartment_id, session_id, project_path,
               start_ordinal, end_ordinal, chunk_hash, model_id, dims, vector, created_at)
               SELECT id, session_id, '/fixture', start_message, end_message, 'hash', 'model', 4,
                 zeroblob(16), 1 FROM compartments;
             INSERT INTO memory_publications(publication_id, project_path, source_session_id)
               VALUES ('pub', '/fixture', 'moving');
             INSERT INTO memory_fact_blocks(publication_id, source_session_id, start_ordinal,
               end_ordinal, role, parts_json, joined_text)
               SELECT 'pub', 'moving', i+1, i+1, 'user', '[]', 'Fix the parser' FROM numbers;
             INSERT INTO notes(content, session_id, anchor_ordinal, created_at, updated_at)
               SELECT 'Remember the parser', 'moving', i+1, 1, 1 FROM numbers WHERE i%100=0;
             INSERT INTO compression_depth(session_id, message_ordinal, depth)
               SELECT 'moving', i+1, 1 FROM numbers;
             INSERT INTO user_memory_candidates(content, session_id, source_compartment_start,
               source_compartment_end, created_at)
               SELECT 'Prefer explicit types', 'moving', i+1, i+1, 1 FROM numbers WHERE i%100=0;
             INSERT INTO user_memories(content, promoted_at, source_candidate_provenance, created_at, updated_at)
               SELECT 'Prefer explicit types', 1, json_array(json_object('session_id', 'moving',
                 'source_compartment_start', i+1, 'source_compartment_end', i+1)), 1, 1
               FROM numbers WHERE i%100=0;
             INSERT INTO primer_candidates(project_path, harness, session_id, question, normalized_question,
               source_compartment_start, source_compartment_end, source_start_message_id,
               source_end_message_id, source_message_time, created_at)
               SELECT '/fixture', 'opencode', 'moving', 'How does the parser work?', 'parser '||i,
                 i+1, i+1, 'm'||i, 'm'||i, 1, 1 FROM numbers WHERE i%100=0;
             INSERT INTO primers(project_path, question, source_candidate_provenance,
               created_at, updated_at)
               SELECT '/fixture', 'How does the parser work?',
                 json_array(json_object('session_id', 'moving', 'harness', 'opencode',
                 'source_compartment_start', i+1, 'source_compartment_end', i+1)), 1, 1
               FROM numbers WHERE i%100=0;
             INSERT INTO message_history_source(session_id, message_id, message_ordinal, source_version,
               normalized_content_hash, role, updated_at)
               SELECT 'moving', 'm'||i, i+1, 'v', 'hash', 'user', 1 FROM numbers;
             INSERT INTO message_history_fts(rowid, session_id, message_id, message_ordinal, role, content)
               SELECT i, 'moving', 'm'||i, i+1, 'user',
                 'Investigated the parser implementation, tested error handling and fixed the regression '||i FROM numbers;
             INSERT INTO message_fts_rowid_map(session_id, message_ordinal, fts_rowid, message_time_ms)
               SELECT 'moving', i+1, i, i*1000 FROM numbers;
             INSERT INTO message_history_index(session_id, last_indexed_ordinal, dirty_floor_ordinal, updated_at)
               VALUES ('moving', {n}+1, 2, 1);
             INSERT INTO schema_migrations_meta(key, value)
               SELECT 'message_index_skip:'||json_array('moving', 'm'||i), json_object('ordinal', i+1)
               FROM numbers WHERE i%100=0;
             COMMIT;
             DROP TABLE numbers;
             CREATE TEMP TABLE numbers AS WITH RECURSIVE n(i) AS
               (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i < {others}) SELECT i FROM n;
             BEGIN;
             INSERT INTO message_history_fts(rowid, session_id, message_id, message_ordinal, role, content)
               SELECT {n}+i, 'other-'||(i%200), 'other-message-'||i, i, 'assistant',
                 'Source context for another session, with a distinct search document and parser details '||i
               FROM numbers WHERE i <= {others};
             INSERT INTO message_fts_rowid_map(session_id, message_ordinal, fts_rowid, message_time_ms)
               SELECT 'other-'||(i%200), i, {n}+i, i*1000 FROM numbers WHERE i <= {others};
             INSERT INTO tags(session_id, message_id, type, tag_number)
               SELECT 'other-'||(i%200), 'other-message-'||i, 'text', i FROM numbers WHERE i <= MIN({others},10000);
             UPDATE message_fts_rowid_map_backfill_state SET completed=0 WHERE id=1;
             COMMIT;
             DROP TABLE numbers;"
        ))?;
        Ok::<_, rusqlite::Error>(())
    }).unwrap();
    let numbering = Numbering::opencode(
        &messages(n),
        &Cursor::new(n as u64, format!("m{n}"), "digest"),
    )
    .unwrap();
    (db, numbering)
}

#[test]
#[ignore = "127,000-message lock measurement with 2,000,000 unrelated search rows"]
fn large_move_lock_measurement() {
    let target: i64 = std::env::var("MC_MOVE_CHECKPOINT_PAGES")
        .ok()
        .map(|v| v.parse().unwrap())
        .unwrap_or(16_000);
    assert!([1000, 4000, 16_000].contains(&target));
    CHECKPOINT_TARGET.with_borrow_mut(|pages| *pages = Some(target));
    let variants: Vec<bool> = std::env::var("MC_MOVE_FTS_MAPPED")
        .ok()
        .map(|v| vec![v.parse().unwrap()])
        .unwrap_or_else(|| vec![false, true]);
    for mapped in variants {
        let dir = tempfile::tempdir().unwrap();
        let (db, _) = fixture(&dir.path().join("context.db"), 127_000, 2_000_000);
        if mapped {
            db.with_connection(|conn| conn.execute("INSERT OR REPLACE INTO message_fts_rowid_map_backfill_state(id,completed) VALUES(1,1)",[]).unwrap());
        }
        let writer = writer::Writer::start(&dir.path().join("context.db"));
        std::thread::sleep(Duration::from_secs(1));
        writer.phase("renumber");
        samples();
        CHECKPOINTS.with_borrow_mut(Vec::clear);
        eprintln!("MOVE_CONFIGURATION mapped={mapped} checkpoint_target={target}");
        VERBOSE.with_borrow_mut(|state| *state = Some(("planning".into(), Instant::now())));
        let started = Instant::now();
        let mut holds = Vec::new();
        db.with_connection(|conn| {
            let phase = Instant::now();
            let numbering = Numbering::opencode(
                &messages(127_000),
                &Cursor::new(127_000, "m127000", "digest"),
            )
            .unwrap();
            renumber(conn, "opencode", "moving", &numbering).unwrap();
            checkpoint_report(mapped, target, "renumber");
            eprintln!(
                "MOVE_PHASE renumber wall={:.3}s",
                phase.elapsed().as_secs_f64()
            );
            holds.extend(samples().into_iter().map(|(name, elapsed)| {
                (
                    if name.starts_with("renumber/") {
                        name
                    } else {
                        format!("renumber/{name}")
                    },
                    elapsed,
                )
            }));
            writer.phase("rekey");
            let phase = Instant::now();
            rekey(conn, "moving", "opencode", "opencode2").unwrap();
            checkpoint_report(mapped, target, "rekey");
            eprintln!(
                "MOVE_PHASE rekey wall={:.3}s",
                phase.elapsed().as_secs_f64()
            );
            holds.extend(samples().into_iter().map(|(name, elapsed)| {
                (
                    if name.starts_with("rekey/") {
                        name
                    } else {
                        format!("rekey/{name}")
                    },
                    elapsed,
                )
            }));
        });
        // Resume through the real command to measure view/state work and its
        // final validation/fence as well as the two separately timed rewrites.
        drop(db);
        let phase = Instant::now();
        writer.phase("view-state-verify-fence");
        run(dir.path(), &request(127_000)).unwrap();
        checkpoint_report(mapped, target, "view-state-verify-fence");
        eprintln!(
            "MOVE_PHASE view/state/verify/fence wall={:.3}s",
            phase.elapsed().as_secs_f64()
        );
        holds.extend(samples());
        VERBOSE.with_borrow_mut(|state| *state = None);
        let mut groups = std::collections::BTreeMap::<String, (usize, Duration, Duration)>::new();
        for (phase, elapsed) in holds {
            let group = groups.entry(phase).or_default();
            group.0 += 1;
            group.1 += elapsed;
            group.2 = group.2.max(elapsed);
        }
        eprintln!(
            "MOVE_LOCK mapped={mapped} end-to-end={:.3}s",
            started.elapsed().as_secs_f64()
        );
        for (phase, (count, total, max)) in &groups {
            eprintln!(
                "MOVE_LOCK mapped={mapped} {phase}: count={count} total={:.3}ms max={:.3}ms",
                total.as_secs_f64() * 1000.0,
                max.as_secs_f64() * 1000.0
            );
        }
        writer.phase("idle-after");
        // Match the moving window's duration instead of comparing its maximum
        // against only a handful of idle commits on the same database.
        std::thread::sleep(started.elapsed());
        writer::report(
            writer.finish(),
            &format!("large-mapped-{mapped}-pages-{target}"),
            false,
        );
        for (phase, (_, _, longest)) in groups {
            assert!(
                longest <= Duration::from_millis(100),
                "mapped={mapped} {phase}: {longest:?}"
            );
        }
    }
}

fn request(n: usize) -> MoveRequest {
    MoveRequest {
        session: SessionRef::new("mock-runner", "opencode2", "moving"),
        preset: "head".into(),
        project: None,
        model: ModelRef::new("test", "model"),
        context_window: 1_000_000,
        output_reserve: 1000,
        rules: ProviderRules::new(
            cortexkit_role_compaction::rules::SignedParts::None,
            cortexkit_role_compaction::rules::EditCost::Suffix,
        ),
        newest: Cursor::new(n as u64, format!("m{n}"), "digest"),
        now: 1,
        messages: Some(messages(n)),
        source_harness: Some("opencode".into()),
        before_newest: None,
    }
}

fn run(dir: &std::path::Path, request: &MoveRequest) -> Result<Moved, String> {
    move_in(
        ContextDb::open(&dir.join("context.db")).unwrap(),
        &Store::open(&dir.join("mode3.db")).unwrap(),
        &crate::pass::Settings::default().into(),
        request,
    )
}

fn snapshot(path: &std::path::Path) -> Vec<(String, Vec<String>)> {
    let conn = Connection::open(path).unwrap();
    [
        "tags",
        "source_contents",
        "pending_ops",
        "compartments",
        "compartment_chunk_embeddings",
        "memory_fact_blocks",
        "notes",
        "compression_depth",
        "user_memory_candidates",
        "user_memories",
        "primer_candidates",
        "primers",
        "message_history_source",
        "message_history_fts",
        "message_fts_rowid_map",
        "message_history_index",
    ]
    .into_iter()
    .map(|table| {
        let mut statement = conn
            .prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))
            .unwrap();
        let columns = statement.column_count();
        let rows = statement
            .query_map([], |row| {
                Ok((0..columns)
                    .map(|i| format!("{:?}", row.get_ref(i).unwrap()))
                    .collect::<Vec<_>>()
                    .join("|"))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        (table.into(), rows)
    })
    .collect()
}

#[test]
fn crash_resume_at_every_transaction_boundary() {
    let expected_dir = tempfile::tempdir().unwrap();
    // Each fact's destination is the preceding fact's original range. More
    // than two batches force parking and placement across commit boundaries.
    let n = 65;
    let (db, _) = fixture(&expected_dir.path().join("context.db"), n, 200);
    drop(db);
    samples();
    run(expected_dir.path(), &request(n)).unwrap();
    let boundaries = samples().len();
    let expected = snapshot(&expected_dir.path().join("context.db"));
    assert!(boundaries > 30);
    for boundary in 0..boundaries {
        let dir = tempfile::tempdir().unwrap();
        let (db, _) = fixture(&dir.path().join("context.db"), n, 200);
        drop(db);
        CRASH_AFTER.with_borrow_mut(|crash| *crash = Some(boundary));
        let error = run(dir.path(), &request(n)).unwrap_err();
        assert_eq!(
            error, "simulated process exit after commit",
            "boundary {boundary}"
        );
        CRASH_AFTER.with_borrow_mut(|crash| *crash = None);
        // Opening both stores anew discards every in-memory plan and cursor.
        let resumed = run(dir.path(), &request(n));
        if boundary + 1 == boundaries {
            assert!(resumed.unwrap_err().starts_with("session_already_moved:"));
        } else {
            resumed.unwrap_or_else(|e| panic!("boundary {boundary}: {e}"));
        }
        assert_eq!(
            snapshot(&dir.path().join("context.db")),
            expected,
            "boundary {boundary}"
        );
        let conn = Connection::open(dir.path().join("context.db")).unwrap();
        let unfinished: usize = conn
            .query_row(
                "SELECT count(*) FROM schema_migrations_meta WHERE key LIKE 'mode3_batch:%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(unfinished, 0, "boundary {boundary}");
    }
    eprintln!("crash/resume verified at {boundaries} transaction boundaries");
}

#[test]
fn every_move_write_transaction_stays_within_100ms() {
    let dir = tempfile::tempdir().unwrap();
    let (db, _) = fixture(&dir.path().join("context.db"), 2_000, 20_000);
    drop(db);
    let writer = writer::Writer::start(&dir.path().join("context.db"));
    std::thread::sleep(Duration::from_millis(150));
    writer.phase("move");
    let moving = Instant::now();
    samples();
    run(dir.path(), &request(2_000)).unwrap();
    let moving = moving.elapsed();
    writer.phase("idle-after");
    std::thread::sleep(moving.max(Duration::from_millis(150)));
    writer::report(writer.finish(), "medium", true);
    let samples = samples();
    assert!(samples.iter().any(|(phase, _)| phase == "fence"));
    assert!(samples.iter().any(|(phase, _)| phase == "stage/batch"));
    for (phase, elapsed) in &samples {
        assert!(
            *elapsed <= Duration::from_millis(100),
            "{phase} held the write lock for {elapsed:?}"
        );
    }
    eprintln!(
        "{} measured write transactions; max {:?}",
        samples.len(),
        samples.iter().map(|(_, d)| d).max().unwrap()
    );
}

#[test]
fn mover_keeps_its_automatic_checkpoint_policy() {
    let dir = tempfile::tempdir().unwrap();
    let db = ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
    db.with_connection(|conn| {
        for pages in [1000, 256] {
            conn.pragma_update(None,"wal_autocheckpoint",pages).unwrap();
            crate::move_batches::transaction(conn,"checkpoint-policy",|tx| {
                let actual: i64 = tx.query_row("PRAGMA wal_autocheckpoint",[],|row|row.get(0)).map_err(|e|e.to_string())?;
                assert_eq!(actual,pages,"the mover must not transfer checkpoint work to other connections");
                tx.execute("INSERT OR REPLACE INTO schema_migrations_meta(key,value) VALUES ('checkpoint-probe','1')",[]).map_err(|e|e.to_string())?;
                Ok(())
            }).unwrap();
        }
    });
}

#[test]
fn rekey_includes_virtual_tables_and_rejects_unowned_mixed_harnesses() {
    let dir = tempfile::tempdir().unwrap();
    let db = ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
    db.with_connection(|conn| {
        conn.execute_batch("CREATE VIRTUAL TABLE future_fts USING fts5(session_id UNINDEXED,harness UNINDEXED,body);
            INSERT INTO future_fts(session_id,harness,body) VALUES ('moving','opencode','first'),('moving','opencode2','second');").unwrap();
        assert!(rekey(conn,"moving","opencode","opencode2").unwrap_err().starts_with("harness_conflict:"));
        conn.execute("DELETE FROM future_fts WHERE rowid=2",[]).unwrap();
        rekey(conn,"moving","opencode","opencode2").unwrap();
        assert_eq!(conn.query_row("SELECT harness FROM future_fts WHERE rowid=1",[],|r|r.get::<_,String>(0)).unwrap(),"opencode2");
        conn.execute("INSERT INTO future_fts(session_id,harness,body) VALUES ('moving','opencode','late')",[]).unwrap();
        let error = verify_source_unchanged(conn,"moving","opencode","opencode2").unwrap_err();
        assert!(error.starts_with("move_source_changed: moving: 1 rows appeared or changed in future_fts"),"{error}");
    });
}

#[test]
fn unmapped_legacy_search_rows_are_discovered_without_a_predicate_scan() {
    let dir = tempfile::tempdir().unwrap();
    let (db, numbering) = fixture(&dir.path().join("context.db"), 65, 200);
    db.with_connection(|conn| {
        conn.execute("DELETE FROM message_fts_rowid_map WHERE session_id='moving' AND message_ordinal=66",[]).unwrap();
        renumber(conn,"opencode","moving",&numbering).unwrap();
        assert_eq!(conn.query_row("SELECT message_ordinal FROM message_history_fts WHERE rowid=65",[],|r|r.get::<_,i64>(0)).unwrap(),65);
        // Virtual-table rowid constraints must be selected even on the
        // compatibility path; session_id is deliberately UNINDEXED.
        let detail: String = conn.query_row("EXPLAIN QUERY PLAN SELECT rowid,session_id,message_id FROM message_history_fts WHERE rowid>0 ORDER BY rowid LIMIT 512",[],|r|r.get(3)).unwrap();
        assert!(detail.contains('>'), "{detail}");
    });
}

#[test]
fn fts_metadata_fast_path_and_public_fallback_preserve_search_and_integrity() {
    for public in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let (db, numbering) = fixture(&dir.path().join("context.db"), 65, 200);
        db.with_connection(|conn| {
            if public {
                conn.execute_batch("CREATE TEMP TABLE saved AS SELECT rowid,* FROM message_history_fts;
                    DROP TABLE message_history_fts;
                    CREATE VIRTUAL TABLE message_history_fts USING fts5(session_id UNINDEXED,message_ordinal,message_id UNINDEXED,role,content);
                    INSERT INTO message_history_fts(rowid,session_id,message_ordinal,message_id,role,content) SELECT * FROM saved;
                    DROP TABLE saved;").unwrap();
            }
            let update = crate::move_batches::ordinal_update(conn).unwrap();
            assert_eq!(update.contains("_content"), !public);
            let other_before = crate::search::messages::app_page(conn,"other-1","parser",0,500);
            renumber(conn,"opencode","moving",&numbering).unwrap();
            conn.execute("INSERT INTO message_history_fts(message_history_fts) VALUES('integrity-check')",[]).unwrap();
            let hits = crate::search::messages::app_page(conn,"moving","parser",0,100);
            assert_eq!(hits.len(),65);
            for hit in hits {
                let expected = hit.message_id.strip_prefix('m').unwrap().parse::<i64>().unwrap();
                assert_eq!(hit.number,expected,"{hit:?}");
            }
            let plain: Vec<i64> = conn.prepare("SELECT message_ordinal FROM message_history_fts WHERE message_history_fts MATCH 'parser' AND session_id='moving' ORDER BY CAST(message_ordinal AS INTEGER)").unwrap()
                .query_map([],|r| r.get(0)).unwrap().collect::<Result<_,_>>().unwrap();
            assert_eq!(plain,(1..=65).collect::<Vec<_>>());
            let other_after = crate::search::messages::app_page(conn,"other-1","parser",0,500);
            assert_eq!(other_after,other_before);
        });
    }
}

#[test]
fn pi_resume_keeps_original_alignment_after_summaries_commit() {
    let dir = tempfile::tempdir().unwrap();
    let db = ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
    db.with_connection(|conn| conn.execute_batch("INSERT INTO compartments(session_id,sequence,start_message,end_message,start_message_id,end_message_id,title,content,p1,created_at,harness)
        VALUES ('moving',1,1,2,'u1','a2','before','before','before',1,'pi'),
               ('moving',2,3,6,'u3','synth-user-t6','middle','middle','middle',1,'pi'),
               ('moving',3,7,9,'a7','a9','after','after','after',1,'pi');").unwrap());
    drop(db);
    let mut request = request(8);
    request.session.harness = "pi".into();
    request.source_harness = None;
    request.newest = Cursor::new(8, "a9", "digest");
    request.messages = Some(
        [
            ("u1", "user"),
            ("a2", "assistant"),
            ("u3", "user"),
            ("u5", "user"),
            ("t6", "toolResult"),
            ("a7", "assistant"),
            ("u8", "user"),
            ("a9", "assistant"),
        ]
        .into_iter()
        .enumerate()
        .map(|(i, (mid, role))| HostMessage {
            mid: mid.into(),
            entry: Some(i as u64 + 1),
            finished_summary: false,
            added: false,
            pi: Some(crate::move_renumber::PiRow {
                kind: "message".into(),
                role: Some(role.into()),
                has_tool_call_id: role == "toolResult",
            }),
        })
        .collect(),
    );
    CRASH_PHASE.with_borrow_mut(|phase| *phase = Some("renumber/compartments"));
    assert_eq!(
        run(dir.path(), &request).unwrap_err(),
        "simulated process exit after commit"
    );
    let moved = run(dir.path(), &request).unwrap();
    assert!(!moved.warnings.is_empty());
    let conn = Connection::open(dir.path().join("context.db")).unwrap();
    let ranges: Vec<(i64, i64)> = conn
        .prepare("SELECT start_message,end_message FROM compartments ORDER BY sequence")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(ranges, [(1, 2), (3, 5), (6, 8)]);
}
