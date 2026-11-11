//! The snapshot of a session's moved rows, its fingerprint, the collision
//! check and the install plan, on real `context.db` stores in temporary
//! folders.

use std::path::Path;

use cortexkit_role_compaction::read::SessionRef;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};

use super::install;
use super::moved::{self, MOVED};
use super::snapshot::{self, Header, Rows, Snapshot};
use crate::context_db::{ContextDb, SCHEMA_VERSION};

const HARNESS: &str = "pi";
const SESSION: &str = "s1";
const PROJECT: &str = "git:proj";

fn session() -> SessionRef {
    SessionRef::new("thalamus-harness", HARNESS, SESSION)
}

fn store(dir: &Path, name: &str) -> Connection {
    let path = dir.join(name);
    drop(ContextDb::create_for_tests(&path).unwrap());
    let conn = Connection::open(&path).unwrap();
    // As `ContextDb::open` leaves them: no cascade ever runs.
    conn.execute_batch("PRAGMA foreign_keys = OFF").unwrap();
    conn
}

fn id(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |row| row.get(0)).unwrap()
}

fn stage_key(publication: &str, attempt: i64, stage: &str) -> String {
    json!([PROJECT, publication, attempt, stage]).to_string()
}

/// A committed (or, with no `order`, uncommitted) publication of `session`
/// with its first turn's stage row.
fn publication(conn: &Connection, id: &str, session: &str, order: Option<i64>, state: &str) {
    conn.execute(
        "INSERT INTO memory_publications(publication_id, project_path, source_session_id, commit_order, committed_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, PROJECT, session, order, order.map(|order| order * 10)],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO memory_stage_attempts(stage_key, project_path, publication_id, run_attempt, stage,
            session_id, harness, child_session_id, carrier, state, classification_watermark, request_json, started_at)
         VALUES (?1, ?2, ?3, 1, 'turn_one', ?4, ?5, 'child', 'runner', ?6, 7, '{}', 1)",
        params![stage_key(id, 1, "turn_one"), PROJECT, id, session, HARNESS, state],
    )
    .unwrap();
}

fn fact(
    conn: &Connection,
    publication: &str,
    index: i64,
    compartment: Option<i64>,
    state: &str,
    reserved: Option<&str>,
) -> i64 {
    conn.execute(
        "INSERT INTO memory_pending_facts(project_path, publication_id, fact_index, compartment_id, category,
            content, anchor_known, state, fact_attempts, reason, reserved_stage_key, mapping_json, matched_memory_id)
         VALUES (?1, ?2, ?3, ?4, 'Decisions', ?5, 1, ?6, 1, 'why', ?7, '{}', 55)",
        params![
            PROJECT,
            publication,
            index,
            compartment,
            format!("fact {publication} {index}"),
            state,
            reserved
        ],
    )
    .unwrap();
    conn.last_insert_rowid()
}

fn block(conn: &Connection, publication: &str, start: i64, end: i64) -> i64 {
    conn.execute(
        "INSERT INTO memory_fact_blocks(publication_id, source_session_id, start_ordinal, end_ordinal, role, parts_json, joined_text)
         VALUES (?1, ?2, ?3, ?4, 'user', '[\"text\"]', 'text')",
        params![publication, SESSION, start, end],
    )
    .unwrap();
    conn.last_insert_rowid()
}

fn link(conn: &Connection, fact: i64, block: i64) {
    conn.execute(
        "INSERT INTO memory_fact_block_links(fact_id, block_id) VALUES (?1, ?2)",
        params![fact, block],
    )
    .unwrap();
}

fn compartment(conn: &Connection, session: &str, harness: &str, sequence: i64) -> i64 {
    conn.execute(
        "INSERT INTO compartments(session_id, sequence, start_message, end_message, start_message_id, end_message_id,
            title, content, p1, importance, p1_embedding, p1_embedding_model_id, created_at, harness)
         VALUES (?1, ?2, ?3, ?4, 'm-a', 'm-b', ?5, 'content', 'p1', 60, x'0102', 'model-a', 100, ?6)",
        params![
            session,
            sequence,
            sequence * 10,
            sequence * 10 + 9,
            format!("summary {sequence}"),
            harness
        ],
    )
    .unwrap();
    conn.last_insert_rowid()
}

fn chunk(conn: &Connection, compartment: i64, session: &str) {
    conn.execute(
        "INSERT INTO compartment_chunk_embeddings(compartment_id, session_id, project_path, harness, start_ordinal,
            end_ordinal, chunk_hash, model_id, dims, vector, created_at)
         VALUES (?1, ?2, ?3, ?4, 1, 2, 'hash', 'model-a', 2, x'0102', 1)",
        params![compartment, session, PROJECT, HARNESS],
    )
    .unwrap();
}

/// The session's rows on its original machine: three summaries with
/// events, scores and facts, notes, its project link, and publications in
/// every state the move tells apart. Another session of the project has a
/// publication too.
fn seed(conn: &Connection) {
    let c1 = compartment(conn, SESSION, HARNESS, 1);
    let c2 = compartment(conn, SESSION, HARNESS, 2);
    let c3 = compartment(conn, SESSION, HARNESS, 3);
    conn.execute_batch(&format!(
        "INSERT INTO compartment_events(session_id, compartment_id, kind, at_compartment, fields_json, created_at, harness) VALUES
            ('{SESSION}', {c2}, 'causal_incident', 2, '{{\"a\":1}}', 1, '{HARNESS}'),
            ('{SESSION}', NULL, 'trajectory_correction', 1, '{{}}', 2, '{HARNESS}'),
            ('{SESSION}', 424242, 'causal_incident', 3, '{{}}', 3, '{HARNESS}');
         INSERT INTO compartment_score_revisions(compartment_id, session_id, source_identity, old_importance, new_importance,
            rubric_version, prompt_hash, model, seed_ids, job_id, batch_id, attempt_id, completed_at, reason) VALUES
            ({c1}, '{SESSION}', 'src-a', 50, 70, 1, 'ph', 'm', '[]', 'job-1', 'batch-1', 'attempt-1', 5, 'clearer'),
            ({c2}, '{SESSION}', 'src-a', 50, 40, 1, 'ph', 'm', '[]', 'job-1', 'batch-1', 'attempt-1', 5, 'minor');
         INSERT INTO session_facts(session_id, category, content, created_at, updated_at, harness) VALUES
            ('{SESSION}', 'Decisions', 'session fact', 1, 2, '{HARNESS}');
         INSERT INTO notes(type, status, content, session_id, project_path, created_at, updated_at, harness, anchor_ordinal) VALUES
            ('session', 'active', 'session note', '{SESSION}', '{PROJECT}', 1, 1, '{HARNESS}', 5),
            ('smart', 'pending', 'smart note', '{SESSION}', '{PROJECT}', 1, 1, '{HARNESS}', NULL);
         INSERT INTO session_projects(session_id, harness, project_path, updated_at) VALUES
            ('{SESSION}', '{HARNESS}', '{PROJECT}', 1);"
    ))
    .unwrap();
    let r1 = id(
        conn,
        &format!("SELECT id FROM compartment_score_revisions WHERE compartment_id = {c1}"),
    );
    conn.execute_batch(&format!(
        "INSERT INTO compartment_score_selections(session_id, compartment_id, sequence, revision_id, origin, job_id, batch_id, attempt_id) VALUES
            ('{SESSION}', {c1}, 1, {r1}, 'publication', 'job-1', 'batch-1', 'attempt-1'),
            ('{SESSION}', {c2}, 2, NULL, 'undo', NULL, NULL, NULL),
            ('{SESSION}', {c3}, 3, 777777, 'publication', 'job-2', 'batch-2', 'attempt-2');"
    ))
    .unwrap();
    // Committed with waiting facts: carried, its final facts as history.
    publication(conn, "pub-1", SESSION, Some(1), "published");
    conn.execute(
        "INSERT INTO memory_stage_attempts(stage_key, project_path, publication_id, run_attempt, stage,
            session_id, harness, carrier, state, request_json, started_at)
         VALUES (?1, ?2, 'pub-1', 2, 'turn_one', ?3, ?4, 'runner', 'superseded', '{}', 1),
                (?5, ?2, 'pub-1', 1, 'turn_two', ?3, ?4, 'runner', 'revoked', '{}', 2)",
        params![
            stage_key("pub-1", 2, "turn_one"),
            PROJECT,
            SESSION,
            HARNESS,
            stage_key("pub-1", 1, "turn_two")
        ],
    )
    .unwrap();
    let b1 = block(conn, "pub-1", 1, 3);
    let b2 = block(conn, "pub-1", 4, 6);
    let f0 = fact(conn, "pub-1", 0, Some(c1), "retryable", None);
    let f1 = fact(
        conn,
        "pub-1",
        1,
        Some(c2),
        "in_flight",
        Some("agent-data:cut-old"),
    );
    let f2 = fact(conn, "pub-1", 2, Some(c1), "applied", None);
    fact(conn, "pub-1", 3, None, "covered", None);
    fact(conn, "pub-1", 4, Some(c3), "decided_pending", None);
    // Its summary was rewritten away: carried with no summary.
    let f5 = fact(conn, "pub-1", 5, Some(999_999), "retryable", None);
    link(conn, f0, b1);
    link(conn, f1, b2);
    link(conn, f2, b1);
    link(conn, f5, b2);
    // Committed with no waiting fact: stays behind.
    publication(conn, "pub-2", SESSION, Some(2), "published");
    fact(conn, "pub-2", 0, Some(c1), "applied", None);
    // Never committed: stays behind and is counted.
    publication(conn, "pub-3", SESSION, None, "sending");
    // Committed with a waiting fact: carried as the second.
    publication(conn, "pub-4", SESSION, Some(4), "published");
    let b4 = block(conn, "pub-4", 7, 8);
    let f4 = fact(conn, "pub-4", 0, Some(c3), "retryable", None);
    link(conn, f4, b4);
    // Another session of the project.
    publication(conn, "pub-other", "s2", Some(3), "published");
    fact(conn, "pub-other", 0, None, "retryable", None);
    compartment(conn, "s2", HARNESS, 1);
}

fn rows(encoded: &snapshot::Encoded, table: &str) -> Vec<Map<String, Value>> {
    snapshot::decode(&encoded.bytes)
        .unwrap()
        .rows
        .table(table)
        .to_vec()
}

fn column(rows: &[Map<String, Value>], name: &str) -> Vec<Value> {
    rows.iter().map(|row| row[name].clone()).collect()
}

fn read(conn: &mut Connection) -> snapshot::Encoded {
    snapshot::read(conn, &session()).unwrap()
}

/// Reserve the session's retryable facts under `cut`, as `prepare` does.
fn reserve(conn: &Connection, cut: &str) {
    conn.execute(
        &format!(
            "UPDATE memory_pending_facts SET state = 'in_flight', reserved_stage_key = ?3
             WHERE state = 'retryable' AND publication_id IN ({})",
            moved::publications()
        ),
        params![SESSION, HARNESS, moved::reservation(cut)],
    )
    .unwrap();
}

#[test]
fn a_snapshot_is_the_same_bytes_every_time_and_names_rows_by_natural_keys() {
    let dir = tempfile::tempdir().unwrap();
    let mut conn = store(dir.path(), "context.db");
    seed(&conn);
    let first = read(&mut conn);
    let second = read(&mut conn);
    assert_eq!(first.bytes, second.bytes);

    let header_length = u32::from_be_bytes(first.bytes[..4].try_into().unwrap()) as usize;
    let header_bytes = &first.bytes[4..4 + header_length];
    assert_eq!(header_bytes, serde_jcs::to_vec(&first.header).unwrap());
    let header: Header = serde_json::from_slice(header_bytes).unwrap();
    assert_eq!(header, first.header);
    assert_eq!(header.format, "mc-agent-data-session/1");
    assert_eq!(
        (
            header.runner.as_str(),
            header.harness.as_str(),
            header.session.as_str()
        ),
        ("thalamus-harness", HARNESS, SESSION)
    );
    assert_eq!(header.project.as_deref(), Some(PROJECT));
    assert_eq!(header.schema_version, i64::from(SCHEMA_VERSION));
    assert_eq!(
        header.body_sha256,
        snapshot::sha256_hex(&first.bytes[4 + header_length..])
    );
    assert_eq!(
        header.dropped,
        [
            (snapshot::DANGLING_REFERENCE.to_owned(), 1),
            (snapshot::UNCOMMITTED_PUBLICATION.to_owned(), 1)
        ]
        .into()
    );
    let counts: Vec<(&str, u64)> = MOVED
        .iter()
        .map(|table| (table.name, header.rows[table.name]))
        .collect();
    assert_eq!(
        counts,
        [
            ("compartments", 3),
            ("compartment_events", 3),
            ("compartment_score_revisions", 2),
            ("compartment_score_selections", 2),
            ("session_facts", 1),
            ("notes", 1),
            ("session_projects", 1),
            ("memory_publications", 2),
            ("memory_fact_blocks", 3),
            ("memory_pending_facts", 7),
            ("memory_fact_block_links", 5),
            ("memory_stage_attempts", 2),
        ]
    );

    // No row carries an id, a session key, a blob or what the receiver
    // assigns; references are natural keys.
    let compartments = rows(&first, "compartments");
    for absent in [
        "id",
        "session_id",
        "harness",
        "p1_embedding",
        "p1_embedding_model_id",
    ] {
        assert!(
            compartments.iter().all(|row| !row.contains_key(absent)),
            "{absent}"
        );
    }
    assert_eq!(
        column(&compartments, "sequence"),
        [json!(1), json!(2), json!(3)]
    );
    assert_eq!(
        column(&rows(&first, "compartment_events"), "compartment_id"),
        [json!(2), Value::Null, Value::Null]
    );
    assert_eq!(
        column(
            &rows(&first, "compartment_score_revisions"),
            "compartment_id"
        ),
        [json!(1), json!(2)]
    );
    // The selection whose revision is missing requires it, so it stays
    // behind; the undo selection needs none.
    let selections = rows(&first, "compartment_score_selections");
    assert_eq!(
        column(&selections, "revision_id"),
        [json!([1, "src-a", 1]), Value::Null]
    );
    assert_eq!(column(&selections, "compartment_id"), [json!(1), json!(2)]);
    let publications = rows(&first, "memory_publications");
    assert_eq!(
        column(&publications, "publication_id"),
        [json!("pub-1"), json!("pub-4")]
    );
    assert_eq!(column(&publications, "commit_order"), [json!(1), json!(2)]);
    let facts = rows(&first, "memory_pending_facts");
    assert_eq!(
        column(&facts, "state"),
        [
            "retryable",
            "retryable",
            "applied",
            "covered",
            "decided_pending",
            "retryable",
            "retryable"
        ]
        .map(|state| json!(state))
    );
    assert_eq!(
        column(&facts, "compartment_id"),
        [
            json!(1),
            json!(2),
            json!(1),
            Value::Null,
            json!(3),
            Value::Null,
            json!(3)
        ]
    );
    for absent in ["id", "reserved_stage_key", "matched_memory_id"] {
        assert!(
            facts.iter().all(|row| !row.contains_key(absent)),
            "{absent}"
        );
    }
    let links = rows(&first, "memory_fact_block_links");
    assert_eq!(
        links[0],
        json!({"fact_id": ["pub-1", 0], "block_id": ["pub-1", 1, 3]})
            .as_object()
            .unwrap()
            .clone()
    );
    let stages = rows(&first, "memory_stage_attempts");
    assert_eq!(
        column(&stages, "stage_key"),
        [
            json!(stage_key("pub-1", 1, "turn_one")),
            json!(stage_key("pub-4", 1, "turn_one"))
        ]
    );
    assert!(stages
        .iter()
        .all(|row| !row.contains_key("classification_watermark")));
}

#[test]
fn a_session_with_no_rows_reads_an_empty_body() {
    let dir = tempfile::tempdir().unwrap();
    let mut conn = store(dir.path(), "context.db");
    let encoded = read(&mut conn);
    let decoded = snapshot::decode(&encoded.bytes).unwrap();
    assert_eq!(decoded.rows.count(), 0);
    assert!(decoded.header.rows.values().all(|count| *count == 0));
    assert_eq!(decoded.header.project, None);
    assert!(decoded.header.dropped.is_empty());
    assert_eq!(
        encoded.bytes.len(),
        4 + serde_jcs::to_vec(&encoded.header).unwrap().len()
    );
}

#[test]
fn the_fingerprint_reads_a_moves_reservation_as_waiting() {
    let dir = tempfile::tempdir().unwrap();
    let mut conn = store(dir.path(), "context.db");
    seed(&conn);
    let before = snapshot::fingerprint(&conn, HARNESS, SESSION).unwrap();
    assert_eq!(before.digest, read(&mut conn).header.body_sha256);
    reserve(&conn, "cut-1");
    assert_eq!(
        id(
            &conn,
            "SELECT COUNT(*) FROM memory_pending_facts WHERE reserved_stage_key = 'agent-data:cut-1'"
        ),
        3
    );
    assert_eq!(
        snapshot::fingerprint(&conn, HARNESS, SESSION).unwrap(),
        before
    );

    // A second-turn send's reservation is not a move's: the fact is in
    // flight, and the publication's other waiting fact keeps it carried.
    conn.execute(
        "UPDATE memory_pending_facts SET reserved_stage_key = 'stage-x'
         WHERE publication_id = 'pub-1' AND fact_index = 0",
        [],
    )
    .unwrap();
    let after = snapshot::fingerprint(&conn, HARNESS, SESSION).unwrap();
    assert_ne!(after.digest, before.digest);
    assert_eq!(after.rows, before.rows);
}

/// Install `encoded` into `conn` under `cut`.
fn install(conn: &mut Connection, encoded: &snapshot::Encoded, cut: &str) {
    let decoded = snapshot::decode(&encoded.bytes).unwrap();
    install::stage(conn, &decoded, cut).unwrap();
    let key = install::key(cut, HARNESS, SESSION);
    let state: String = conn
        .query_row(
            "SELECT json_extract(value, '$.state') FROM schema_migrations_meta WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(state, "done");
}

#[test]
fn an_install_writes_rows_that_encode_to_the_same_body() {
    let dir = tempfile::tempdir().unwrap();
    let mut source = store(dir.path(), "source.db");
    seed(&source);
    reserve(&source, "cut-1");
    let encoded = read(&mut source);

    // The receiver's own backlog already uses the source's commit orders,
    // and it has no rescore rows.
    let mut receiver = store(dir.path(), "receiver.db");
    publication(&receiver, "pub-b1", "s9", Some(1), "published");
    publication(&receiver, "pub-b2", "s9", Some(2), "published");
    fact(&receiver, "pub-b1", 0, None, "retryable", None);
    install(&mut receiver, &encoded, "cut-1");

    let installed = snapshot::fingerprint(&receiver, HARNESS, SESSION).unwrap();
    assert_eq!(installed.digest, encoded.header.body_sha256);
    // The same body; only the header's dropped counts are the source's own.
    let again = snapshot::decode(&read(&mut receiver).bytes).unwrap();
    let sent = snapshot::decode(&encoded.bytes).unwrap();
    assert_eq!(again.rows.tables, sent.rows.tables);
    assert_eq!(again.header.rows, sent.header.rows);
    assert_eq!(again.header.project, sent.header.project);

    // Appended after the receiver's own publications, in rank order.
    let orders: Vec<(String, i64)> = receiver
        .prepare(
            "SELECT publication_id, commit_order FROM memory_publications ORDER BY commit_order",
        )
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        orders,
        [
            ("pub-b1".to_owned(), 1),
            ("pub-b2".to_owned(), 2),
            ("pub-1".to_owned(), 3),
            ("pub-4".to_owned(), 4)
        ]
    );
    // Waiting facts are held under the cut; final facts keep their states.
    type Fact = (String, i64, String, Option<String>, Option<i64>);
    let facts: Vec<Fact> = receiver
        .prepare(
            "SELECT publication_id, fact_index, state, reserved_stage_key, matched_memory_id
             FROM memory_pending_facts WHERE publication_id IN ('pub-1', 'pub-4') ORDER BY id",
        )
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let held = Some("agent-data:cut-1".to_owned());
    assert_eq!(
        facts,
        [
            (
                "pub-1".to_owned(),
                0,
                "in_flight".to_owned(),
                held.clone(),
                None
            ),
            (
                "pub-1".to_owned(),
                1,
                "in_flight".to_owned(),
                held.clone(),
                None
            ),
            ("pub-1".to_owned(), 2, "applied".to_owned(), None, None),
            ("pub-1".to_owned(), 3, "covered".to_owned(), None, None),
            (
                "pub-1".to_owned(),
                4,
                "decided_pending".to_owned(),
                None,
                None
            ),
            (
                "pub-1".to_owned(),
                5,
                "in_flight".to_owned(),
                held.clone(),
                None
            ),
            ("pub-4".to_owned(), 0, "in_flight".to_owned(), held, None),
        ]
    );
    // References resolve to the receiver's own rows.
    assert_eq!(
        id(
            &receiver,
            "SELECT COUNT(*) FROM memory_fact_block_links l
             JOIN memory_pending_facts f ON f.id = l.fact_id
             JOIN memory_fact_blocks b ON b.id = l.block_id AND b.publication_id = f.publication_id"
        ),
        5
    );
    assert_eq!(
        id(
            &receiver,
            "SELECT COUNT(*) FROM compartment_score_selections s
             JOIN compartment_score_revisions r ON r.id = s.revision_id AND r.compartment_id = s.compartment_id
             JOIN compartments c ON c.id = s.compartment_id AND c.sequence = 1"
        ),
        1
    );
    assert_eq!(
        id(
            &receiver,
            "SELECT COUNT(*) FROM compartments WHERE p1_embedding IS NULL AND p1_embedding_model_id IS NULL"
        ),
        3
    );
    assert_eq!(
        id(
            &receiver,
            "SELECT COUNT(*) FROM memory_stage_attempts WHERE classification_watermark IS NULL AND publication_id IN ('pub-1', 'pub-4')"
        ),
        2
    );
    // The receiver's own rows are untouched.
    assert_eq!(
        id(
            &receiver,
            "SELECT COUNT(*) FROM memory_pending_facts WHERE publication_id = 'pub-b1' AND state = 'retryable'"
        ),
        1
    );
}

#[test]
fn a_move_back_replaces_the_hidden_rows_and_drops_a_decided_publication() {
    let dir = tempfile::tempdir().unwrap();
    // The original machine, released: its facts stay reserved under the
    // first cut, and its summaries have search vectors.
    let mut original = store(dir.path(), "original.db");
    seed(&original);
    reserve(&original, "cut-1");
    let first = read(&mut original);
    let c1 = id(
        &original,
        "SELECT id FROM compartments WHERE session_id = 's1' AND sequence = 1",
    );
    chunk(&original, c1, SESSION);
    let other = id(
        &original,
        "SELECT id FROM compartments WHERE session_id = 's2'",
    );
    chunk(&original, other, "s2");

    // The destination installs it, activates (its facts become retryable),
    // summarizes once more and decides every fact of pub-4.
    let mut destination = store(dir.path(), "destination.db");
    install(&mut destination, &first, "cut-1");
    destination
        .execute_batch(
            "UPDATE memory_pending_facts SET state = 'retryable', reserved_stage_key = NULL
                WHERE reserved_stage_key = 'agent-data:cut-1';
             UPDATE memory_pending_facts SET state = 'applied' WHERE publication_id = 'pub-4';",
        )
        .unwrap();
    compartment(&destination, SESSION, HARNESS, 4);
    reserve(&destination, "cut-2");
    let back = read(&mut destination);
    assert_eq!(back.header.rows["memory_publications"], 1);

    let incoming = snapshot::decode(&back.bytes).unwrap();
    let local = snapshot::local(&mut original, &incoming).unwrap();
    assert_eq!(local.colliding, 0, "the hidden copy is the session's own");
    assert_eq!(local.fingerprint.digest, first.header.body_sha256);
    install(&mut original, &back, "cut-2");

    assert_eq!(
        snapshot::fingerprint(&original, HARNESS, SESSION)
            .unwrap()
            .digest,
        back.header.body_sha256
    );
    for table in [
        "memory_publications",
        "memory_fact_blocks",
        "memory_pending_facts",
    ] {
        assert_eq!(
            id(
                &original,
                &format!("SELECT COUNT(*) FROM {table} WHERE publication_id = 'pub-4'")
            ),
            0,
            "{table}"
        );
    }
    assert_eq!(
        id(
            &original,
            "SELECT COUNT(*) FROM memory_stage_attempts WHERE publication_id = 'pub-4'"
        ),
        0
    );
    assert_eq!(
        id(&original, "SELECT COUNT(*) FROM memory_fact_block_links"),
        4,
        "pub-1's four links; pub-4's went with it"
    );
    // Search vectors of the deleted summaries go; the other session's stay.
    assert_eq!(
        id(
            &original,
            "SELECT COUNT(*) FROM compartment_chunk_embeddings WHERE session_id = 's1'"
        ),
        0
    );
    assert_eq!(
        id(
            &original,
            "SELECT COUNT(*) FROM compartment_chunk_embeddings WHERE session_id = 's2'"
        ),
        1
    );
    // Rows outside the selection are untouched: the smart note, the
    // uncommitted and the decided publications, and the second turn's row.
    assert_eq!(
        id(
            &original,
            "SELECT COUNT(*) FROM notes WHERE session_id = 's1' AND type = 'smart'"
        ),
        1
    );
    assert_eq!(
        id(
            &original,
            "SELECT COUNT(*) FROM memory_publications WHERE publication_id IN ('pub-2', 'pub-3', 'pub-other')"
        ),
        3
    );
    assert_eq!(
        id(
            &original,
            "SELECT COUNT(*) FROM memory_stage_attempts WHERE publication_id = 'pub-1' AND state <> 'published'"
        ),
        2
    );
    assert_eq!(
        id(
            &original,
            "SELECT COUNT(*) FROM compartments WHERE session_id = 's1'"
        ),
        4
    );
}

#[test]
fn an_empty_snapshot_clears_the_sessions_rows() {
    let dir = tempfile::tempdir().unwrap();
    let mut empty = store(dir.path(), "empty.db");
    let encoded = read(&mut empty);
    let mut receiver = store(dir.path(), "receiver.db");
    seed(&receiver);
    reserve(&receiver, "cut-1");
    install(&mut receiver, &encoded, "cut-2");
    let left = snapshot::fingerprint(&receiver, HARNESS, SESSION).unwrap();
    assert_eq!(left.rows, 0);
    assert_eq!(left.digest, encoded.header.body_sha256);
}

#[test]
fn the_install_plan_deletes_children_first_then_inserts_parents_first() {
    let dir = tempfile::tempdir().unwrap();
    let mut source = store(dir.path(), "source.db");
    seed(&source);
    let encoded = read(&mut source);
    let receiver = store(dir.path(), "receiver.db");
    seed(&receiver);
    reserve(&receiver, "cut-1");
    let c1 = id(
        &receiver,
        "SELECT id FROM compartments WHERE session_id = 's1' AND sequence = 1",
    );
    chunk(&receiver, c1, SESSION);
    let incoming = snapshot::decode(&encoded.bytes).unwrap();
    let steps = install::steps(&receiver, &incoming, "cut-2").unwrap();

    let mut phases: Vec<&str> = Vec::new();
    for step in &steps {
        if phases.last() != Some(&step.phase.as_str()) {
            phases.push(&step.phase);
        }
    }
    let mut expected: Vec<String> = MOVED
        .iter()
        .rev()
        .flat_map(|table| {
            let mut names = Vec::new();
            if table.name == "compartments" {
                names.push("agent_data/delete/compartment_chunk_embeddings".to_owned());
            }
            names.push(format!("agent_data/delete/{}", table.name));
            names
        })
        .collect();
    expected.extend(
        MOVED
            .iter()
            .map(|table| format!("agent_data/insert/{}", table.name)),
    );
    assert_eq!(phases, expected);

    // Every delete stays inside the session's selection: one row each.
    let deletes = |table: &str| {
        steps
            .iter()
            .filter(|step| step.phase == format!("agent_data/delete/{table}"))
            .count()
    };
    assert_eq!(deletes("compartments"), 3);
    assert_eq!(deletes("compartment_chunk_embeddings"), 1);
    assert_eq!(deletes("notes"), 1, "the smart note stays");
    assert_eq!(deletes("memory_publications"), 2, "pub-1 and pub-4");
    assert_eq!(deletes("memory_pending_facts"), 7);
    assert_eq!(
        deletes("memory_stage_attempts"),
        2,
        "the published first turns"
    );

    // A publication takes the next place in the receiver's backlog, and a
    // reference is a subquery on the receiver's rows for the session.
    let publication = steps
        .iter()
        .find(|step| step.phase == "agent_data/insert/memory_publications")
        .unwrap();
    assert!(publication
        .sql
        .contains("(SELECT COALESCE(MAX(commit_order), 0) + 1 FROM memory_publications)"));
    let selection = steps
        .iter()
        .find(|step| step.phase == "agent_data/insert/compartment_score_selections")
        .unwrap();
    assert!(selection.sql.contains(
        "(SELECT \"id\" FROM \"compartment_score_revisions\" WHERE \"session_id\" = ? AND \"compartment_id\" = (SELECT \"id\" FROM \"compartments\" WHERE \"session_id\" = ? AND \"harness\" = ? AND \"sequence\" = ?)"
    ), "{}", selection.sql);
}

fn with_rows(encoded: &snapshot::Encoded, edit: impl FnOnce(&mut Rows)) -> Vec<u8> {
    let mut rows = snapshot::decode(&encoded.bytes).unwrap().rows;
    edit(&mut rows);
    snapshot::encode(&session(), encoded.header.schema_version, &rows).bytes
}

fn table_mut<'a>(rows: &'a mut Rows, name: &str) -> &'a mut Vec<Map<String, Value>> {
    let index = MOVED.iter().position(|table| table.name == name).unwrap();
    &mut rows.tables[index]
}

#[track_caller]
fn refused(bytes: &[u8], expected: &str) {
    let error = snapshot::decode(bytes).unwrap_err();
    assert!(error.contains(expected), "{error}");
}

#[test]
fn decode_refuses_a_snapshot_this_build_cannot_install() {
    let dir = tempfile::tempdir().unwrap();
    let mut conn = store(dir.path(), "context.db");
    seed(&conn);
    let encoded = read(&mut conn);
    assert!(snapshot::decode(&encoded.bytes).is_ok());

    // A selection a rescore published must name its revision.
    refused(
        &with_rows(&encoded, |rows| {
            table_mut(rows, "compartment_score_selections")[0]
                .insert("revision_id".into(), Value::Null);
        }),
        "compartment_score_selections",
    );
    // A reference must name a row the snapshot carries.
    refused(
        &with_rows(&encoded, |rows| {
            table_mut(rows, "compartment_events")[0].insert("compartment_id".into(), json!(9));
        }),
        "compartment_events row's compartment_id names a compartments row",
    );
    // Only the moved columns, and no fact held by a second turn.
    refused(
        &with_rows(&encoded, |rows| {
            table_mut(rows, "notes")[0].insert("id".into(), json!(1));
        }),
        "a notes row carries columns",
    );
    refused(
        &with_rows(&encoded, |rows| {
            table_mut(rows, "memory_pending_facts")[0].insert("state".into(), json!("in_flight"));
        }),
        "memory_pending_facts row's state",
    );
    // Two summaries under one sequence.
    refused(
        &with_rows(&encoded, |rows| {
            let copy = table_mut(rows, "compartments")[0].clone();
            table_mut(rows, "compartments").push(copy);
        }),
        "two compartments rows",
    );
    // Another format, or a body whose bytes changed.
    let mut header = encoded.header.clone();
    header.format = "mc-agent-data-session/2".into();
    let header_bytes = serde_jcs::to_vec(&header).unwrap();
    let length = u32::from_be_bytes(encoded.bytes[..4].try_into().unwrap()) as usize;
    let mut other = (header_bytes.len() as u32).to_be_bytes().to_vec();
    other.extend(header_bytes);
    other.extend(&encoded.bytes[4 + length..]);
    refused(&other, "format");
    let mut changed = encoded.bytes.clone();
    let last = changed.len() - 2;
    changed[last] ^= 1;
    refused(&changed, "digest");
}

#[test]
fn rows_outside_the_selection_that_hold_an_installed_key_are_local() {
    let dir = tempfile::tempdir().unwrap();
    let mut source = store(dir.path(), "source.db");
    seed(&source);
    let incoming = snapshot::decode(&read(&mut source).bytes).unwrap();

    let mut receiver = store(dir.path(), "receiver.db");
    let empty = snapshot::local(&mut receiver, &incoming).unwrap();
    assert!(!empty.any());

    // Another harness's summary under the same session id and sequence.
    compartment(&receiver, SESSION, "opencode", 2);
    // Another harness's summary at a sequence the snapshot does not carry.
    compartment(&receiver, SESSION, "opencode", 9);
    // A publication id already present, outside the session's selection.
    publication(&receiver, "pub-4", "s7", Some(1), "published");
    let local = snapshot::local(&mut receiver, &incoming).unwrap();
    assert_eq!(local.fingerprint.rows, 0);
    assert_eq!(
        local.colliding, 3,
        "the summary, the publication and its first turn's stage key"
    );
    assert!(local.any());
    assert!(receiver
        .query_row(
            "SELECT 1 FROM compartments WHERE harness = 'opencode' AND sequence = 9",
            [],
            |row| row.get::<_, i64>(0)
        )
        .optional()
        .unwrap()
        .is_some());
}

#[test]
fn check_store_refuses_a_null_the_store_requires() {
    let dir = tempfile::tempdir().unwrap();
    let mut conn = store(dir.path(), "context.db");
    seed(&conn);
    let encoded = read(&mut conn);
    let mut incoming: Snapshot = snapshot::decode(&encoded.bytes).unwrap();
    assert!(install::check_store(&conn, &incoming).is_ok());
    table_mut(&mut incoming.rows, "compartments")[0].insert("title".into(), Value::Null);
    let error = install::check_store(&conn, &incoming).unwrap_err();
    assert!(
        error.contains("compartments") && error.contains("title"),
        "{error}"
    );
}
