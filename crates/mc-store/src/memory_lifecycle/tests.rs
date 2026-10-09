use rusqlite::{params, Connection};
use serde_json::{json, Value};

use super::applier::{
    apply_memory_admission_tx, read_receipt, AdmissionOperation, AdmissionRequest, ApplierReceipt,
    ReceiptState, ADMISSION_TABLES, AUTHORITY_ELSEWHERE,
};
use super::authority::{
    install_module_memory_authority_guard, is_authority_refusal, module_owns_memory,
};
use super::constants::*;
use super::text::*;
use crate::single_store_domain::CONTEXT_SCHEMA_SNAPSHOT;

const GOLDENS: &str = include_str!("text_goldens.json");

// In this host-versus-Broca routing memory, the trailing gap statement must be clause four.
// Source: docs/reports/historian-merge-turn-trial-v6-sonnet.md:71 (#17639).
const GAP_MEMORY: &str = "Rust transform mode must not require Broca (or any other CK module) to be running: every module under CK/subc stays decoupled unless coupling is necessary. Historian and dreamer completions in rust mode run by default in the same harness as the parent session (the host runs the prompt, e.g. OpenCode/Pi child session or the v2 child carrier), and route to the Broca runner only when the user configures it (Ufuk ruling, 2026-09-17). Today `crates/mc-module/src/historian_producer.rs` opens a route straight to `broca` (DEFAULT_RUNNER_MODULE_ID) — that is the gap to close with a host-runner default.";

/// Every case of the shared goldens whose Rust output differs from the expected value
/// the TypeScript reference produced, named so a failure says which rule diverged.
fn golden_mismatches(goldens: &Value) -> Vec<String> {
    let mut mismatches = Vec::new();
    let mut check = |section: &str, index: usize, actual: Value, expected: &Value| {
        if &actual != expected {
            mismatches.push(format!(
                "{section}[{index}]: rust {actual} != expected {expected}"
            ));
        }
    };
    let text = |case: &Value, field: &str| case[field].as_str().unwrap().to_string();
    let offset = |case: &Value, field: &str| case[field].as_u64().unwrap() as usize;
    for (index, case) in goldens["split"].as_array().unwrap().iter().enumerate() {
        let actual = serde_json::to_value(split_memory_clauses(&text(case, "input"))).unwrap();
        check("split", index, actual, &case["expected"]);
    }
    for (index, case) in goldens["normalize"].as_array().unwrap().iter().enumerate() {
        let actual = json!(normalize_lifecycle_text(&text(case, "input")));
        check("normalize", index, actual, &case["expected"]);
    }
    for (index, case) in goldens["tokens"].as_array().unwrap().iter().enumerate() {
        let actual = json!(scan_concrete_tokens(&text(case, "input")));
        check("tokens", index, actual, &case["expected"]);
    }
    for (index, case) in goldens["markers"].as_array().unwrap().iter().enumerate() {
        let actual = json!(has_evidence_marker(&text(case, "input")));
        check("markers", index, actual, &case["expected"]);
    }
    for (index, case) in goldens["windows"].as_array().unwrap().iter().enumerate() {
        let actual = json!(extract_evidence_window(
            &text(case, "part"),
            offset(case, "start"),
            offset(case, "end"),
        ));
        check("windows", index, actual, &case["expected"]);
    }
    let blocks: Vec<EvidenceBlock> =
        serde_json::from_value(goldens["match"]["blocks"].clone()).unwrap();
    for (index, case) in goldens["match"]["cases"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        let actual = serde_json::to_value(match_fact_evidence(
            &blocks,
            case["ordinal"].as_i64().unwrap(),
            &text(case, "excerpt"),
        ))
        .unwrap();
        check("match", index, actual, &case["expected"]);
    }
    mismatches
}

#[test]
fn named_constants_and_lists_are_fixed() {
    assert_eq!(
        [
            LEXICAL_SLOT_COUNT,
            NEIGHBOUR_SHORTLIST_CAP,
            NARROW_CHECK_WINDOW_MAX,
            KEPT_CHECK_INPUT_MAX,
            NARROW_CHECK_CALL_CEILING,
            RETRY_BACKLOG_PER_RUN,
        ],
        [2, 12, 1200, 48000, 8, 8]
    );
    assert_eq!(
        [MAX_STAGE2_ATTEMPTS, EXCERPT_BEFORE, EXCERPT_AFTER],
        [3, 2, 4]
    );
    assert_eq!(CLAUSE_ABBREVIATIONS, ["e.g.", "i.e.", "etc.", "vs."]);
    assert_eq!(
        CONCRETE_UNITS.join(" "),
        "KiB MiB GiB TiB KB MB GB TB byte bytes ns us µs ms s sec secs millisecond milliseconds second seconds m min mins minute minutes h hour hours d day days w week weeks token tokens percent %"
    );
    assert_eq!(
        EVIDENCE_MARKERS,
        [
            " / ",
            "[N]",
            "[N-M]",
            "Messages N-M:",
            "...[truncated]",
            "[… tokens truncated by Magic Context to fit the historian window …]",
            "…",
            "… +N more",
            "[dropped]",
            "[dropped §",
            "[truncated §",
            "<!-- +",
        ]
    );
}

#[test]
fn text_goldens_match_the_typescript_reference() {
    let goldens: Value = serde_json::from_str(GOLDENS).unwrap();
    for section in ["split", "normalize", "tokens", "markers", "windows"] {
        assert!(
            !goldens[section].as_array().unwrap().is_empty(),
            "{section} goldens are present"
        );
    }
    assert!(!goldens["match"]["cases"].as_array().unwrap().is_empty());
    let mismatches = golden_mismatches(&goldens);
    assert!(mismatches.is_empty(), "{mismatches:#?}");
}

#[test]
fn a_golden_expecting_different_output_fails() {
    let goldens: Value = serde_json::from_str(GOLDENS).unwrap();
    for (section, pointer) in [
        ("split", "/split/0/expected/3/text"),
        ("normalize", "/normalize/1/expected"),
        ("tokens", "/tokens/0/expected/2"),
        ("markers", "/markers/0/expected"),
        ("windows", "/windows/2/expected"),
        ("match", "/match/cases/0/expected/window"),
    ] {
        let mut altered = goldens.clone();
        let slot = altered.pointer_mut(pointer).unwrap();
        *slot = match slot {
            Value::Bool(value) => json!(!*value),
            Value::String(value) => json!(format!("{value}x")),
            _ => panic!("unexpected golden shape at {pointer}"),
        };
        let mismatches = golden_mismatches(&altered);
        assert_eq!(mismatches.len(), 1, "{section}: {mismatches:#?}");
        assert!(mismatches[0].starts_with(section), "{mismatches:#?}");
    }
}

#[test]
fn v6_17639_yields_four_clauses_with_c4_the_gap() {
    let clauses = split_memory_clauses(GAP_MEMORY);
    assert_eq!(clauses.len(), 4);
    assert_eq!(
        clauses[3].text,
        "that is the gap to close with a host-runner default."
    );
    assert!(clauses[1].text.contains("e.g. OpenCode/Pi"));
    assert_eq!(
        clauses
            .iter()
            .map(|clause| clause.text.as_str())
            .collect::<String>(),
        GAP_MEMORY
    );
}

#[test]
fn token_and_whitespace_goldens_hold_their_fixed_values() {
    assert_eq!(scan_concrete_tokens("164 KiB"), ["164 KiB"]);
    assert!(!scan_concrete_tokens("164 KiB").contains(&"64 KiB".to_string()));
    assert_eq!(
        scan_concrete_tokens("keep >512 KiB and 64 KiB"),
        [">512 KiB", "64 KiB"]
    );
    assert_eq!(
        normalize_lifecycle_text("\u{FEFF} A \u{180E}"),
        "\u{FEFF} A \u{180E}"
    );
    assert_eq!(
        normalize_lifecycle_text("\u{0085} A\t\u{00a0}B\u{3000} "),
        "A B"
    );
    // A cut that would start on the low half of a surrogate pair drops the pair.
    let astral = format!("{}😀{}", "x".repeat(800), "y".repeat(1199));
    assert_eq!(
        extract_evidence_window(&astral, 1999, 2001).as_deref(),
        Some("y".repeat(1199).as_str())
    );
    assert_eq!(extract_evidence_window(&"x".repeat(2000), 0, 1201), None);
}

// ── Applier ────────────────────────────────────────────────────────────────

const PROJECT: &str = "git:project";
const OTHER: &str = "git:other";

/// A `context.db` from the schema snapshot. `migrated` sets `single_store_state`. The
/// privileged-writer row is armed, as the module's write transactions arm it, so the
/// file's own guard triggers let a managed project's writes through.
fn context_db(migrated: bool) -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(CONTEXT_SCHEMA_SNAPSHOT).unwrap();
    conn.execute(
        "INSERT INTO context_privilege_state(id, enabled) VALUES (1, 1)",
        [],
    )
    .unwrap();
    if migrated {
        conn.execute(
            "INSERT INTO single_store_state(id, state, migrated_at, migrated_by, report_json)
             VALUES (1, 'migrated', 0, 'test', '{}')",
            [],
        )
        .unwrap();
    }
    conn
}

fn mark_managed(conn: &Connection, project: &str) {
    conn.execute(
        "INSERT INTO authority_managed(project_path, context_store_uuid, marked_at) VALUES (?1, 'test', 1)",
        [project],
    )
    .unwrap();
}

fn admit(
    conn: &Connection,
    key: &str,
    operation: AdmissionOperation,
    category: &str,
    content: &str,
    edit: impl FnOnce(&mut AdmissionRequest<'_>),
) -> ApplierReceipt {
    let mut request = AdmissionRequest::new(key, operation, PROJECT, category, content, 1_000);
    edit(&mut request);
    apply_memory_admission_tx(conn, &request).unwrap()
}

fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |row| row.get(0)).unwrap()
}

fn seen_count(conn: &Connection, id: i64) -> i64 {
    conn.query_row(
        "SELECT seen_count FROM memories WHERE id = ?1",
        [id],
        |row| row.get(0),
    )
    .unwrap()
}

#[test]
fn admission_inserts_once_and_a_retried_key_returns_the_recorded_receipt() {
    let conn = context_db(true);
    let first = admit(
        &conn,
        "k1",
        AdmissionOperation::New,
        "CONSTRAINTS",
        "Use Rust",
        |_| {},
    );
    assert_eq!(first.state, ReceiptState::Applied);
    assert_eq!(first.reason, "inserted");
    assert_eq!(first.inserted, Some(true));
    let id = first.memory_id.unwrap();
    let retried = admit(
        &conn,
        "k1",
        AdmissionOperation::New,
        "CONSTRAINTS",
        "Use Rust",
        |_| {},
    );
    assert_eq!(retried, first);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM memories"), 1);
    assert_eq!(seen_count(&conn, id), 1);
    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM memory_journal"),
        1,
        "an applied admission is journalled once"
    );
    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM memory_mutation_log"),
        0,
        "admission writes no mutation-log row"
    );
    let row: (String, i64, String, String) = conn
        .query_row(
            "SELECT source_type, importance, status, verification_status FROM memories WHERE id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(
        row,
        (
            "historian".to_string(),
            50,
            "active".to_string(),
            "unverified".to_string()
        )
    );
    let stored = read_receipt(&conn, "k1").unwrap().unwrap();
    assert_eq!(stored, first);
    let json: String = conn
        .query_row(
            "SELECT receipt_json FROM memory_decision_receipts WHERE decision_key = 'k1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        json,
        format!(
            r#"{{"state":"applied","reason":"inserted","memoryId":{id},"inserted":true,"adoptionClass":null}}"#
        ),
        "receipts use the TypeScript applier's JSON shape"
    );
}

#[test]
fn a_live_same_category_match_bumps_seen_count_once_and_inserts_nothing() {
    let conn = context_db(true);
    let id = admit(
        &conn,
        "a",
        AdmissionOperation::New,
        "CONSTRAINTS",
        "Use Rust",
        |_| {},
    )
    .memory_id
    .unwrap();
    let again = admit(
        &conn,
        "b",
        AdmissionOperation::New,
        "CONSTRAINTS",
        "  use   RUST ",
        |_| {},
    );
    assert_eq!(
        (
            again.state,
            again.reason.as_str(),
            again.memory_id,
            again.inserted
        ),
        (ReceiptState::Applied, "live_match", Some(id), Some(false))
    );
    assert_eq!(seen_count(&conn, id), 2);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM memories"), 1);
}

#[test]
fn archived_and_cross_category_matches_write_nothing_and_stay_pending() {
    let conn = context_db(true);
    let archived = admit(
        &conn,
        "a",
        AdmissionOperation::New,
        "CONSTRAINTS",
        "Old rule",
        |_| {},
    )
    .memory_id
    .unwrap();
    conn.execute(
        "UPDATE memories SET status = 'archived' WHERE id = ?1",
        [archived],
    )
    .unwrap();
    let receipt = admit(
        &conn,
        "b",
        AdmissionOperation::New,
        "CONSTRAINTS",
        "Old rule",
        |_| {},
    );
    assert_eq!(
        (receipt.state, receipt.reason.as_str(), receipt.memory_id),
        (
            ReceiptState::DecidedPending,
            "archived_match",
            Some(archived)
        )
    );
    assert_eq!(
        seen_count(&conn, archived),
        1,
        "the archived row is not revived"
    );

    let live = admit(
        &conn,
        "c",
        AdmissionOperation::New,
        "ARCHITECTURE",
        "Exact text",
        |_| {},
    )
    .memory_id
    .unwrap();
    let cross = admit(
        &conn,
        "d",
        AdmissionOperation::New,
        "CONSTRAINTS",
        "Exact text",
        |_| {},
    );
    assert_eq!(
        (cross.state, cross.reason.as_str(), cross.memory_id),
        (
            ReceiptState::DecidedPending,
            "cross_category_match",
            Some(live)
        )
    );
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM memories"), 2);
    assert_eq!(seen_count(&conn, live), 1);
    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM memory_journal"),
        2,
        "only the two inserts are journalled"
    );
}

#[test]
fn conflicts_link_once_and_a_self_conflict_writes_nothing() {
    let conn = context_db(true);
    let target = admit(
        &conn,
        "t",
        AdmissionOperation::New,
        "CONSTRAINTS",
        "TTL is five minutes",
        |_| {},
    )
    .memory_id
    .unwrap();
    let conflict = admit(
        &conn,
        "c",
        AdmissionOperation::Conflict,
        "CONSTRAINTS",
        "TTL is ten minutes",
        |request| request.conflict_target_id = Some(target),
    );
    let inserted = conflict.applied_memory_id().unwrap();
    assert_ne!(inserted, target);
    let link: (i64, i64) = conn
        .query_row(
            "SELECT left_id, right_id FROM memory_conflict_links",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(link, (target.min(inserted), target.max(inserted)));
    let self_conflict = admit(
        &conn,
        "s",
        AdmissionOperation::Conflict,
        "CONSTRAINTS",
        "TTL is five minutes",
        |request| request.conflict_target_id = Some(target),
    );
    assert_eq!(
        (self_conflict.state, self_conflict.reason.as_str()),
        (ReceiptState::DecidedPending, "self_conflict")
    );
    assert_eq!(seen_count(&conn, target), 1);
    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM memory_conflict_links"),
        1
    );
}

#[test]
fn disabled_memory_and_auto_promote_off_admit_nothing_but_agent_saves_still_apply() {
    let conn = context_db(true);
    let disabled = admit(
        &conn,
        "d",
        AdmissionOperation::AgentSave,
        "CONSTRAINTS",
        "x",
        |request| request.memory_enabled = Some(false),
    );
    assert_eq!(disabled.reason, "memory_disabled");
    let paused = admit(
        &conn,
        "p",
        AdmissionOperation::New,
        "CONSTRAINTS",
        "x",
        |request| request.auto_promote = Some(false),
    );
    assert_eq!(
        (paused.state, paused.reason.as_str()),
        (ReceiptState::DecidedPending, "auto_promote_disabled")
    );
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM memories"), 0);
    let saved = admit(
        &conn,
        "s",
        AdmissionOperation::AgentSave,
        "CONSTRAINTS",
        "x",
        |request| request.auto_promote = Some(false),
    );
    assert!(saved.is_applied());
    let source: String = conn
        .query_row("SELECT source_type FROM memories", [], |row| row.get(0))
        .unwrap();
    assert_eq!(source, "agent");
}

#[test]
fn a_resolved_fact_records_its_state_on_the_pending_fact_row() {
    let conn = context_db(true);
    conn.execute_batch(
        "INSERT INTO memory_publications(publication_id, project_path, source_session_id) VALUES ('pub', 'git:project', 'ses');
         INSERT INTO memory_pending_facts(id, project_path, publication_id, fact_index, category, content, state, reserved_stage_key)
         VALUES (7, 'git:project', 'pub', 0, 'CONSTRAINTS', 'Fact', 'in_flight', 'stage');",
    )
    .unwrap();
    let receipt = admit(
        &conn,
        "f",
        AdmissionOperation::New,
        "CONSTRAINTS",
        "Fact",
        |request| request.fact_id = Some(7),
    );
    let row: (String, String, Option<i64>, Option<String>) = conn
        .query_row(
            "SELECT state, reason, matched_memory_id, reserved_stage_key FROM memory_pending_facts WHERE id = 7",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(
        row,
        (
            "applied".to_string(),
            "inserted".to_string(),
            receipt.memory_id,
            None
        )
    );
}

#[test]
fn the_module_never_writes_memories_for_a_ts_owned_project() {
    // Legacy authority armed: a marked project is the module's, an unmarked one is not.
    let conn = context_db(true);
    mark_managed(&conn, OTHER);
    let refused = admit(
        &conn,
        "r",
        AdmissionOperation::New,
        "CONSTRAINTS",
        "Rule",
        |_| {},
    );
    assert_eq!(
        (refused.state, refused.reason.as_str(), refused.memory_id),
        (ReceiptState::Retryable, AUTHORITY_ELSEWHERE, None)
    );
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM memories"), 0);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM memory_journal"), 0);
    mark_managed(&conn, PROJECT);
    assert!(admit(
        &conn,
        "w",
        AdmissionOperation::New,
        "CONSTRAINTS",
        "Rule",
        |_| {}
    )
    .is_applied());
}

#[test]
fn ownership_follows_the_markers_while_armed_and_the_migration_state_otherwise() {
    let migrated = context_db(true);
    assert!(module_owns_memory(&migrated, PROJECT).unwrap());
    mark_managed(&migrated, OTHER);
    assert!(!module_owns_memory(&migrated, PROJECT).unwrap());
    assert!(module_owns_memory(&migrated, OTHER).unwrap());

    let repair = context_db(true);
    repair
        .execute(
            "INSERT INTO authority_repair_pending(project_path, started_at) VALUES (?1, 1)",
            [OTHER],
        )
        .unwrap();
    assert!(!module_owns_memory(&repair, PROJECT).unwrap());
    assert!(module_owns_memory(&repair, OTHER).unwrap());

    // Empty markers but no recorded single-store migration: not the module's.
    let unmigrated = context_db(false);
    assert!(!module_owns_memory(&unmigrated, PROJECT).unwrap());
    unmigrated
        .execute(
            "INSERT INTO single_store_state(id, state) VALUES (1, 'required')",
            [],
        )
        .unwrap();
    assert!(!module_owns_memory(&unmigrated, PROJECT).unwrap());
    let refused = admit(
        &unmigrated,
        "u",
        AdmissionOperation::AgentSave,
        "CONSTRAINTS",
        "Rule",
        |_| {},
    );
    assert_eq!(refused.reason, AUTHORITY_ELSEWHERE);
    assert_eq!(count(&unmigrated, "SELECT COUNT(*) FROM memories"), 0);
}

#[test]
fn the_connection_guard_aborts_any_memory_write_for_a_project_the_module_does_not_own() {
    let conn = context_db(true);
    conn.execute(
        "INSERT INTO memories(project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at)
         VALUES (?1, 'CONSTRAINTS', 'theirs', 'h1', 1, 1, 1, 1)",
        [PROJECT],
    )
    .unwrap();
    mark_managed(&conn, OTHER);
    install_module_memory_authority_guard(&conn).unwrap();
    let insert = conn.execute(
        "INSERT INTO memories(project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at)
         VALUES (?1, 'CONSTRAINTS', 'mine', 'h2', 1, 1, 1, 1)",
        [PROJECT],
    );
    assert!(is_authority_refusal(&insert.unwrap_err()));
    let update = conn.execute(
        "UPDATE memories SET content = 'changed' WHERE project_path = ?1",
        [PROJECT],
    );
    assert!(is_authority_refusal(&update.unwrap_err()));
    let delete = conn.execute("DELETE FROM memories WHERE project_path = ?1", [PROJECT]);
    assert!(is_authority_refusal(&delete.unwrap_err()));
    // Moving a module row into a TypeScript-owned project is refused too.
    conn.execute(
        "INSERT INTO memories(project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at)
         VALUES (?1, 'CONSTRAINTS', 'module row', 'h3', 1, 1, 1, 1)",
        [OTHER],
    )
    .unwrap();
    let moved = conn.execute(
        "UPDATE memories SET project_path = ?1 WHERE project_path = ?2",
        params![PROJECT, OTHER],
    );
    assert!(is_authority_refusal(&moved.unwrap_err()));
    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM memories"),
        2,
        "only the module-owned insert landed"
    );
}

#[test]
fn every_table_an_admission_writes_is_declared_for_the_schema_fence() {
    let conn = context_db(true);
    conn.execute_batch(
        "CREATE TEMP TABLE written(name TEXT PRIMARY KEY);
         INSERT INTO memory_publications(publication_id, project_path, source_session_id) VALUES ('pub', 'git:project', 'ses');
         INSERT INTO memory_pending_facts(id, project_path, publication_id, fact_index, category, content)
         VALUES (1, 'git:project', 'pub', 0, 'CONSTRAINTS', 'Fact');",
    )
    .unwrap();
    let tables: Vec<String> = conn
        .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table'
              AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%'
              AND name NOT LIKE '%_fts_%'",
        )
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    for table in &tables {
        for event in ["INSERT", "UPDATE", "DELETE"] {
            conn.execute_batch(&format!(
                "CREATE TEMP TRIGGER \"spy_{table}_{event}\" AFTER {event} ON main.\"{table}\"
                 BEGIN INSERT OR IGNORE INTO written(name) VALUES ('{table}'); END;"
            ))
            .unwrap();
        }
    }
    let target = admit(
        &conn,
        "t",
        AdmissionOperation::New,
        "CONSTRAINTS",
        "Fact",
        |request| request.fact_id = Some(1),
    )
    .memory_id
    .unwrap();
    admit(
        &conn,
        "c",
        AdmissionOperation::Conflict,
        "CONSTRAINTS",
        "Other fact",
        |request| request.conflict_target_id = Some(target),
    );
    admit(
        &conn,
        "s",
        AdmissionOperation::AgentSave,
        "CONSTRAINTS",
        "Saved",
        |request| {
            request.source_session_id = Some("ses");
            request.classification_anchor = Some(super::applier::ClassificationAnchor {
                tool_call_part_id: "part",
                save_ordinal: 3,
            });
        },
    );
    admit(
        &conn,
        "l",
        AdmissionOperation::New,
        "CONSTRAINTS",
        "Fact",
        |_| {},
    );
    let written: Vec<String> = conn
        .prepare("SELECT name FROM temp.written ORDER BY name")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    for name in [
        "memories",
        "memory_decision_receipts",
        "memory_journal",
        "memory_pending_facts",
        "memory_conflict_links",
        "memory_classification_items",
    ] {
        assert!(
            written.contains(&name.to_string()),
            "{name} written: {written:?}"
        );
    }
    let undeclared: Vec<&String> = written
        .iter()
        .filter(|name| !ADMISSION_TABLES.contains(&name.as_str()))
        .collect();
    assert!(undeclared.is_empty(), "undeclared writes: {undeclared:?}");
}

// ── Store writers routed through the applier ───────────────────────────────

fn open_store(dir: &std::path::Path) -> crate::McStore {
    use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
    crate::McStore::open_for_test(&StorageDescriptor {
        module_id: "magic-context-test".to_string(),
        storage_namespace: "mc_cache".to_string(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: dir.join("store.db").to_string_lossy().to_string(),
        },
    })
    .unwrap()
}

fn store_input<'a>(project: &'a str, content: &'a str) -> crate::InsertMemoryInput<'a> {
    crate::InsertMemoryInput {
        project_path: project,
        route_project_root: None,
        category: "CONSTRAINTS",
        content,
        source_session_id: None,
        source_type: Some("agent"),
        importance: Some(50),
        expires_at: None,
        metadata_json: None,
        now_ms: 5,
    }
}

fn store_count(store: &crate::McStore, sql: &str) -> i64 {
    store
        .with_context_conn_for_test(|tx| tx.query_row(sql, [], |row| row.get(0)))
        .unwrap()
}

#[test]
fn store_inserts_go_through_the_applier_and_record_a_receipt() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path());
    let id = store
        .insert_memory(store_input(PROJECT, "Use Rust"))
        .unwrap();
    let again = store
        .insert_memory(store_input(PROJECT, "  use   RUST "))
        .unwrap();
    assert_eq!(again, id, "a live normalized match is seen again");
    assert_eq!(
        store_count(&store, "SELECT COUNT(*) FROM memory_decision_receipts"),
        2
    );
    assert_eq!(
        store_count(&store, "SELECT COUNT(*) FROM memory_journal"),
        2
    );
    let watermark = store_count(
        &store,
        "SELECT COALESCE(MAX(written_memory_id), 0) FROM memory_embedding_watermarks",
    );
    assert_eq!(watermark, id, "the insert moved the embedding watermark");
    store
        .with_context_conn_for_test(|tx| {
            tx.execute(
                "UPDATE memories SET status = 'archived' WHERE id = ?1",
                [id],
            )
        })
        .unwrap();
    let error = store
        .insert_memory(store_input(PROJECT, "Use Rust"))
        .unwrap_err();
    assert!(error.to_string().contains("archived_match"), "{error}");
    assert_eq!(store_count(&store, "SELECT COUNT(*) FROM memories"), 1);
    assert_eq!(
        store_count(&store, "SELECT seen_count FROM memories"),
        2,
        "the archived row is not revived by a later insert"
    );
}

#[test]
fn store_writers_write_no_memory_for_a_ts_owned_project() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path());
    store
        .with_context_conn_for_test(|tx| {
            tx.execute(
                "INSERT INTO authority_managed(project_path, context_store_uuid, marked_at) VALUES (?1, 'test', 1)",
                [OTHER],
            )
        })
        .unwrap();

    let error = store
        .insert_memory(store_input(PROJECT, "Use Rust"))
        .unwrap_err();
    assert!(error.to_string().contains(AUTHORITY_ELSEWHERE), "{error}");
    let receipt_state: String = store
        .with_context_conn_for_test(|tx| {
            tx.query_row(
                "SELECT json_extract(receipt_json, '$.state') FROM memory_decision_receipts",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert_eq!(receipt_state, "retryable", "the refusal's receipt commits");

    let promoted = store
        .promote_facts(
            PROJECT,
            &[crate::FactCandidate {
                category: "CONSTRAINTS".to_string(),
                content: "Historian fact".to_string(),
                importance: None,
                expires_at: None,
                source_session_id: None,
            }],
        )
        .unwrap();
    assert!(promoted.is_empty());

    // A memory write that does not go through the applier is refused by the connection
    // guard on the store's own `context.db` writer.
    let raw = store.with_context_conn_for_test(|tx| {
        tx.execute(
            "INSERT INTO memories(project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at)
             VALUES (?1, 'CONSTRAINTS', 'raw', 'h', 1, 1, 1, 1)",
            [PROJECT],
        )
    });
    assert!(
        raw.unwrap_err()
            .to_string()
            .contains(super::authority::MODULE_MEMORY_AUTHORITY_ELSEWHERE),
        "the guard names its refusal"
    );
    assert_eq!(store_count(&store, "SELECT COUNT(*) FROM memories"), 0);
}
