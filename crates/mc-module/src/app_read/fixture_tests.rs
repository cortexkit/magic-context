//! A store with every kind of row the owner reads show, at fixed times, for
//! the read tests and the v13 samples. Its history rows are written by the
//! writers' own history function, in each writer's decision key and journal
//! shape, so attribution is read from exactly what the writers record.

use super::*;
use crate::memory_writes::{history_json, history_snapshot, record_history, History};
use rusqlite::TransactionBehavior;

pub(super) const PROJECT: &str = "pj-sample";
/// A project with sessions but nothing else: every page of it is empty.
pub(super) const EMPTY: &str = "pj-empty";
/// A second project whose dreamer schedules show the forms the first one's
/// don't.
pub(super) const FORMS: &str = "pj-forms";
pub(super) const ZONE: &str = "Europe/Istanbul";
pub(super) const T: i64 = 1_700_000_000_000;
/// A time no test runs after, for rows that must stay in the future.
pub(super) const FUTURE: i64 = 4_102_444_800_000;

pub(super) fn head() -> SessionRef {
    SessionRef::new("thalamus-harness", "opencode2", "s")
}

pub(super) fn worker() -> SessionRef {
    SessionRef::new("thalamus-harness", "opencode2", "s-worker")
}

pub(super) struct Fixture {
    pub dir: tempfile::TempDir,
}

impl Fixture {
    pub fn context(&self) -> Connection {
        Connection::open(self.dir.path().join("context.db")).unwrap()
    }

    /// A replica reading this fixture's stores, as the app-read thread opens
    /// them, with the module's settings attached and the time zone fixed.
    pub fn replica(&self) -> Replica {
        let mut replica = super::tests::replica(None);
        replica.snapshots.clear();
        replica.store = Some(
            Connection::open_with_flags(
                self.dir.path().join("mode3.db"),
                OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .unwrap(),
        );
        replica.context = Some(
            Connection::open_with_flags(
                self.dir.path().join("context.db"),
                OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .unwrap(),
        );
        replica.load();
        replica.apps.zone = || Some(ZONE.into());
        let settings = crate::pass::Settings {
            memory_enabled: true,
            embedding: Some(crate::embedding::Provider::for_test(
                "http://127.0.0.1:9/v1",
                "sample-embed",
            )),
            ..Default::default()
        };
        replica.apps.attached = Some(sessions::Attachment {
            config: Arc::new(settings.into()),
            dreamer: None,
        });
        // The folder a Setup in this process would have named.
        replica.session_seen(head(), PROJECT.into(), "/work/sample".into(), "head".into());
        replica
    }

    pub fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        drop(
            crate::context_db::ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap(),
        );
        let store = crate::store::Store::open(&dir.path().join("mode3.db")).unwrap();
        let sessions = [
            (head(), "head", PROJECT, T + 9_000_000),
            (worker(), "worker", PROJECT, T + 8_000_000),
            (
                SessionRef::new("thalamus-harness", "opencode2", "s-empty"),
                "head",
                EMPTY,
                T,
            ),
            (
                SessionRef::new("thalamus-harness", "opencode2", "s-forms"),
                "head",
                FORMS,
                T,
            ),
            (
                SessionRef::new("thalamus-harness", "pi", "s-reader"),
                "reader",
                PROJECT,
                T + 7_000_000,
            ),
        ];
        for (key, preset, _, at) in &sessions {
            store
                .save(
                    key,
                    &crate::store::Durable {
                        preset: Some((*preset).into()),
                        ..Default::default()
                    },
                )
                .unwrap();
            if *at > T {
                store
                    .save_app_index(
                        key,
                        &[IndexRow {
                            mid: "m1".into(),
                            ordinal: 1,
                            at_ms: *at as u64,
                        }],
                        None,
                    )
                    .unwrap();
            }
        }
        drop(store);
        let mode3 = Connection::open(dir.path().join("mode3.db")).unwrap();
        for (key, _, project, _) in &sessions {
            mode3
                .execute(
                    "INSERT INTO memory_contexts (runner, harness, session, context) VALUES (?1, ?2, ?3, ?4)",
                    params![key.runner, key.harness, key.session, json!({"project_id": project}).to_string()],
                )
                .unwrap();
        }
        let fixture = Self { dir };
        let mut conn = fixture.context();
        memories(&mut conn);
        dreamer(&conn);
        notes(&conn);
        facts(&conn);
        fixture
    }
}

fn insert(
    conn: &Connection,
    id: i64,
    level: &str,
    owner: &str,
    origin: &str,
    content: &str,
    at: i64,
) {
    conn.execute(
        "INSERT INTO memories (id, level, owner_id, category, origin_category, content,
             normalized_hash, importance, source_project_id, source_session_id, source_type,
             seen_count, retrieval_count, first_seen_at, created_at, updated_at, last_seen_at,
             status, verification_status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 50, ?8, 's', 'historian', 1, 0, ?9, ?9, ?9, ?9,
                 'active', 'unverified')",
        params![
            id,
            level,
            owner,
            crate::context_migrations::frozen_category_id(origin),
            origin,
            content,
            crate::memory_writes::normalized_hash(content),
            if level == "global" {
                None
            } else {
                Some(PROJECT)
            },
            at,
        ],
    )
    .unwrap();
}

/// Change memory `id` with `change` and record it as `writer` records a
/// decision: history rows from the writers' own function, then the journal
/// row holding the whole decision.
#[allow(clippy::too_many_arguments)]
fn change(
    conn: &mut Connection,
    ids: &[i64],
    key: &str,
    writer: &str,
    operation: &str,
    reason: &str,
    at: i64,
    change: &str,
) {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    let before: Vec<Option<Value>> = ids
        .iter()
        .map(|id| history_snapshot(&tx, *id).unwrap())
        .collect();
    tx.execute_batch(change).unwrap();
    let after: Vec<Option<Value>> = ids
        .iter()
        .map(|id| history_snapshot(&tx, *id).unwrap())
        .collect();
    let decision = record_history(
        &tx,
        &History {
            key,
            project: PROJECT,
            writer,
            operation,
            reason,
            now: at,
            before: &before,
            after: &after,
            source_ids: ids,
            survivor_id: None,
            evidence: json!([]),
        },
    )
    .unwrap();
    tx.execute(
        "INSERT INTO memory_journal(project_path, decision_key, operation, receipt_json, applied_at, before_json, after_json)
         VALUES (?1, ?2, ?3, '{}', ?4, ?5, ?5)",
        params![PROJECT, key, operation, at, history_json(&decision)],
    )
    .unwrap();
    tx.commit().unwrap();
}

fn memories(conn: &mut Connection) {
    let rows = [
        (
            1,
            "PROJECT_RULES",
            "Run the release script from the repository root.",
        ),
        (
            2,
            "ARCHITECTURE",
            "The head is rebuilt only when the cache is already lost.",
        ),
        (
            3,
            "CONSTRAINTS",
            "The provider caps a request at 200 000 tokens.",
        ),
        (4, "NAMING", "Call the long-lived agent the head."),
        (
            5,
            "CONFIG_VALUES",
            "The execute threshold defaults to 65 percent.",
        ),
        (
            6,
            "CONFIG_VALUES",
            "The execute threshold defaults to 65% of the usable window.",
        ),
        (7, "PROJECT_RULES", "Never push to main without a review."),
        (
            8,
            "ARCHITECTURE",
            "Summaries are rendered by a deterministic renderer.",
        ),
    ];
    for (id, origin, content) in rows {
        insert(conn, id, "project", PROJECT, origin, content, T + id * 1000);
    }
    conn.execute_batch(&format!(
        "UPDATE memories SET importance = 90, source_type = 'agent', seen_count = 3,
             retrieval_count = 7, mural_cue = 'release from root' WHERE id = 1;
         UPDATE memories SET status = 'permanent', sensitive = 1, safety_critical = 1,
             importance = 95 WHERE id = 7;
         UPDATE memories SET expires_at = {FUTURE}, shareable = 1 WHERE id = 2;
         INSERT INTO memory_embeddings (memory_id, embedding, model_id) VALUES (1, x'00', '{model}');",
        model = crate::embedding::Provider::for_test("http://127.0.0.1:9/v1", "sample-embed").model_id()
    ))
    .unwrap();
    // One history entry from each writer.
    change(
        conn,
        &[1],
        "ck-mc:4242:1700000100000:0",
        "ctx_memory",
        "update",
        "ctx_memory_update",
        T + 100_000,
        "UPDATE memories SET content = 'Run the release script from the repository root, never from a package.',
             revision = revision + 1, updated_at = 1700000100000 WHERE id = 1",
    );
    change(
        conn,
        &[2],
        &json!([PROJECT, 3, 0, 0, [[2, 1]], "[\"pj-sample\",\"pub-1\",0,\"turn_two\"]"]).to_string(),
        "historian",
        "edit",
        "edit",
        T + 200_000,
        "UPDATE memories SET content = 'The head is rebuilt only when the provider cache is already lost.',
             revision = revision + 1, updated_at = 1700000200000 WHERE id = 2",
    );
    change(
        conn,
        &[3],
        "dream-run:2:classify-memories:0",
        "dreamer:classify-memories",
        "classify",
        "classify-memories",
        T + 3_690_000,
        "UPDATE memories SET importance = 80, safety_critical = 0, classified_at = 1700003690000,
             revision = revision + 1, updated_at = 1700003690000 WHERE id = 3",
    );
    change(
        conn,
        &[4],
        &json!(["memory-edit", PROJECT, "op-1"]).to_string(),
        "dashboard_edit",
        "edit",
        "dashboard_edit",
        T + 300_000,
        "UPDATE memories SET content = 'Call the long-lived agent the head, never the main agent.',
             revision = revision + 1, updated_at = 1700000300000 WHERE id = 4",
    );
    // An agent merge: 5 is archived into 6, which keeps both ids.
    change(
        conn,
        &[5, 6],
        "ck-mc:4242:1700000400000:1",
        "ctx_memory",
        "merge",
        "duplicate threshold",
        T + 400_000,
        "UPDATE memories SET status = 'archived', superseded_by_memory_id = 6,
             revision = revision + 1, updated_at = 1700000400000 WHERE id = 5;
         UPDATE memories SET merged_from = '[5,6]', revision = revision + 1,
             updated_at = 1700000400000 WHERE id = 6",
    );
    // The plugin's dreamer (Magic Context 0.49 and earlier) archived 8 in
    // its verify task, which recorded no run.
    change(
        conn,
        &[8],
        "verify:8:1",
        "verify",
        "archive",
        "the renderer moved",
        T + 500_000,
        "UPDATE memories SET status = 'archived', revision = revision + 1,
             updated_at = 1700000500000 WHERE id = 8",
    );
    // The person's own memories, and what summaries noticed about them.
    insert(
        conn,
        20,
        "global",
        "self",
        "USER_PREFERENCES",
        "Prefers short answers.",
        T + 20_000,
    );
    insert(
        conn,
        21,
        "global",
        "self",
        "USER_DIRECTIVES",
        "Works in Istanbul.",
        T + 21_000,
    );
    conn.execute_batch(
        "UPDATE memories SET category = 'base:preferences', sensitive = 1, source_type = 'user-review'
           WHERE id = 21;
         UPDATE memories SET category = 'base:preferences', source_type = 'user-review',
             source_project_id = 'pj-sample' WHERE id = 20;
         INSERT INTO memory_observations (id, content, proposed_category, session_id, project_id, created_at)
           VALUES (1, 'Asks for one question per message.', 'base:communication', 's', 'pj-sample', 1700000600000),
                  (2, 'Reviews diffs before merging.', 'swe:engineering-practice', 's', 'pj-sample', 1700000700000),
                  (3, 'Uses a Mac.', NULL, 's', NULL, 1700000800000);
         INSERT INTO memory_observations (id, content, session_id, created_at, consumed_at)
           VALUES (4, 'Already reviewed.', 's', 1700000500000, 1700000900000);",
    )
    .unwrap();
}

fn dreamer(conn: &Connection) {
    let batches = json!([
        {"model": "anthropic/claude-haiku-4-5", "runner": "thalamus-harness", "child": "ck-dream-2.0", "input_tokens": 3000, "output_tokens": 500},
        {"model": "openai/gpt-5-mini", "runner": "thalamus-harness", "child": "ck-dream-2.1", "input_tokens": 2400, "output_tokens": 300}
    ]);
    let dropped = json!([
        "memory 4 changed after the batch read it (revision 1, now 2)",
        "memory 7: shareable=true is not written; ck-mc has no check for sensitive memory text, so the dreamer never makes a memory shareable"
    ]);
    conn.execute_batch(&format!(
        "INSERT INTO dream_schedules (level, owner_id, task, schedule, next_due_at, last_run_at,
             last_status, last_error, failures)
           VALUES ('project', '{PROJECT}', 'swe:classify-memories', '0 6 * * *', {FUTURE},
                   1700003690000, 'applied', NULL, 0),
                  ('project', '{PROJECT}', 'swe:compress-cues', '15 */2 * * *', 1700010000000,
                   1700000060000, 'failed', 'provider returned 500', 1),
                  ('project', '{FORMS}', 'swe:classify-memories', '0 * * * *', {FUTURE}, NULL, NULL, NULL, 0),
                  ('project', '{FORMS}', 'swe:compress-cues', '30 4 * * 1-5', {FUTURE}, NULL, NULL, NULL, 0);
         INSERT INTO dream_locks (level, owner_id, holder, task, acquired_at, expires_at)
           VALUES ('project', '{PROJECT}', 'ck-mc:4242', 'swe:classify-memories', 1700007200000, {FUTURE});
         INSERT INTO dream_task_runs (id, task, kind, level, owner_id, profile, started_at, ended_at,
             outcome, failure_class, error, input_tokens, output_tokens, proposed, applied,
             dropped_json, batches_json)
           VALUES (1, 'swe:compress-cues', 'compress-cues', 'project', '{PROJECT}', 'memory-swe',
                   1700000000000, 1700000060000, 'failed', 'model', 'provider returned 500', 0, 0,
                   0, 0, NULL, NULL),
                  (2, 'swe:classify-memories', 'classify-memories', 'project', '{PROJECT}',
                   'memory-swe', 1700003600000, 1700003690000, 'applied', NULL, NULL, 5400, 800,
                   3, 1, '{dropped}', '{batches}'),
                  (3, 'swe:classify-memories', 'classify-memories', 'project', '{PROJECT}',
                   'memory-swe', 1700007200000, NULL, NULL, NULL, NULL, 0, 0, 0, 0, NULL, NULL);",
        dropped = dropped.to_string().replace('\'', "''"),
        batches = batches,
    ))
    .unwrap();
}

fn notes(conn: &Connection) {
    conn.execute_batch(&format!(
        "INSERT INTO notes (id, type, status, content, session_id, harness, project_path, created_at, updated_at)
           VALUES (1, 'session', 'active', 'Check the migration on a copy first.', 's', 'opencode2', '{PROJECT}', 1700000000000, 1700000000000),
                  (2, 'session', 'dismissed', 'Old reminder.', 's', 'opencode2', '{PROJECT}', 1700000100000, 1700000150000);
         INSERT INTO notes (id, type, status, content, project_path, surface_condition, created_at, updated_at)
           VALUES (3, 'smart', 'pending', 'Re-run the replay once the fix merges.', '{PROJECT}', 'the replay fix is merged to main', 1700000200000, 1700000200000);
         INSERT INTO notes (id, type, status, content, project_path, surface_condition, ready_reason, ready_at, created_at, updated_at)
           VALUES (4, 'smart', 'ready', 'Bump the pinned host.', '{PROJECT}', 'a new host release is out', 'host 1.4.2 was released', 1700000400000, 1700000300000, 1700000400000);"
    ))
    .unwrap();
}

fn facts(conn: &Connection) {
    conn.execute_batch(&format!(
        "INSERT INTO memory_publications (publication_id, project_path, source_session_id)
           VALUES ('pub-1', '{PROJECT}', 's');
         INSERT INTO memory_pending_facts (id, project_path, publication_id, fact_index, category, content, state, fact_attempts, reason)
           VALUES (1, '{PROJECT}', 'pub-1', 0, 'CONSTRAINTS', 'The runner retries a refused view once.', 'retryable', 1, 'cas_loss'),
                  (2, '{PROJECT}', 'pub-1', 1, 'NAMING', 'Views are numbered per session.', 'in_flight', 0, NULL),
                  (3, '{PROJECT}', 'pub-1', 2, 'ARCHITECTURE', 'Moves freeze the session first.', 'decided_pending', 2, 'needs_review'),
                  (4, '{PROJECT}', 'pub-1', 3, 'ARCHITECTURE', 'Already a memory.', 'covered', 1, NULL);"
    ))
    .unwrap();
}
