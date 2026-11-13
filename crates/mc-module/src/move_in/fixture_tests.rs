//! Shared synthetic store for structural tests and the opt-in timing example.

use super::{
    ContextDb, Cursor, HostMessage, ModelRef, MoveRequest, Numbering, ProviderRules, SessionRef,
};

pub(super) fn messages(n: usize) -> Vec<HostMessage> {
    let mut messages = vec![
        HostMessage {
            mid: "opener".into(),
            source_entry: None,
            entry: None,
            finished_summary: false,
            added: false,
            pi: None,
        },
        HostMessage {
            mid: "summary".into(),
            source_entry: None,
            entry: None,
            finished_summary: true,
            added: false,
            pi: None,
        },
    ];
    messages.extend((1..=n).map(|i| HostMessage {
        source_entry: None,
        mid: format!("m{i}"),
        entry: Some(i as u64),
        finished_summary: false,
        added: false,
        pi: None,
    }));
    messages
}

pub(super) fn fixture(path: &std::path::Path, n: usize, others: usize) -> (ContextDb, Numbering) {
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
             INSERT INTO memory_observations(content, session_id, source_start_ordinal,
               source_end_ordinal, created_at)
               SELECT 'Prefer explicit types', 'moving', i+1, i+1, 1 FROM numbers WHERE i%100=0;
             INSERT INTO memories(level, owner_id, category, origin_category, content, normalized_hash,
               first_seen_at, created_at, updated_at, last_seen_at, status, metadata_json)
               SELECT 'global', 'self', 'mc:user-unsorted', 'USER_MEMORY', 'Prefer explicit types', 'h' || i,
                 1, 1, 1, 1, 'active', json_object('promoted_at', 1, 'source_candidate_provenance',
                 json_array(json_object('session_id', 'moving', 'source_compartment_start', i+1,
                 'source_compartment_end', i+1)))
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

pub(super) fn request(n: usize) -> MoveRequest {
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
        source_session: None,
        source_runner_entries: false,
        tag_floor: None,
    }
}
