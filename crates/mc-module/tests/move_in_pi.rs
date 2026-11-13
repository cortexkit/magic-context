//! Synthetic Pi move-in coverage for a branch that lost a numbered message.

use cortexkit_role_compaction::read::{Cursor, SessionRef};
use cortexkit_role_compaction::rules::{EditCost, ProviderRules, SignedParts};
use cortexkit_role_compaction::setup::ModelRef;
use mc_module::context_db::ContextDb;
use mc_module::move_in::{move_in, MoveRequest, Moved};
use mc_module::move_renumber::{renumber, HostMessage, Numbering, PiRow};
use mc_module::pass::Settings;
use mc_module::store::Store;
use rusqlite::{params, Connection};
use serde_json::{json, Value};

struct Fixture {
    dir: std::path::PathBuf,
    conn: Connection,
    request: MoveRequest,
}

impl Fixture {
    fn new(name: &str, source: bool) -> Self {
        let dir =
            std::env::temp_dir().join(format!("ck-mc-move-in-pi-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        ContextDb::create_for_tests(&dir.join("context.db")).unwrap();
        let conn = Connection::open(dir.join("context.db")).unwrap();
        let row = |mid: &str, entry: u64, role: &str| HostMessage {
            source_entry: None,
            mid: mid.into(),
            entry: Some(entry),
            finished_summary: false,
            added: false,
            pi: Some(PiRow {
                kind: "message".into(),
                role: Some(role.into()),
                has_tool_call_id: role == "toolResult",
            }),
        };
        // The plugin saw an assistant at #4, between u3 and u5. The branch
        // no longer reaches it. The tool result becomes synth-user-t6 in the
        // plugin numbering, and remains a separate runner entry.
        let messages = vec![
            row("u1", 1, "user"),
            row("a2", 2, "assistant"),
            row("u3", 3, "user"),
            row("u5", 4, "user"),
            row("t6", 5, "toolResult"),
            row("a7", 6, "assistant"),
            row("u8", 7, "user"),
            row("a9", 8, "assistant"),
        ];
        for (seq, start, end, start_id, end_id) in [
            (1, 1, 2, "u1", "a2"),
            (2, 3, 6, "u3", "synth-user-t6"),
            (3, 7, 9, "a7", "a9"),
        ] {
            conn.execute(
                "INSERT INTO compartments (session_id, sequence, start_message, end_message,
                    start_message_id, end_message_id, title, content, p1, created_at, harness)
                 VALUES ('s1', ?1, ?2, ?3, ?4, ?5, ?6, 'history', 'history', 1, 'pi')",
                params![seq, start, end, start_id, end_id, format!("Summary {seq}")],
            )
            .unwrap();
        }
        conn.execute_batch(
            "INSERT INTO message_history_source (session_id, message_id, message_ordinal, source_version,
                normalized_content_hash, role, harness, updated_at)
             VALUES ('s1', 'u3', 3, 'v', 'h', 'user', 'pi', 1),
                    ('s1', 'u5', 3, 'v', 'h', 'user', 'pi', 1),
                    ('s1', 'synth-user-t6', 6, 'v', 'h', 'user', 'pi', 1),
                    ('s1', 'a7', 7, 'v', 'h', 'assistant', 'pi', 1),
                    ('s1', 'old-numbering', 2, 'v', 'h', 'assistant', 'pi', 1);
             INSERT INTO notes (type, content, session_id, created_at, updated_at, harness, anchor_ordinal)
             VALUES ('session', 'before', 's1', 1, 1, 'pi', 3),
                    ('session', 'at loss', 's1', 1, 1, 'pi', 4),
                    ('session', 'after', 's1', 1, 1, 'pi', 7);
             INSERT INTO memory_publications (publication_id, project_path, source_session_id)
             VALUES ('pub', '/p', 's1');
             INSERT INTO memory_fact_blocks (publication_id, source_session_id, start_ordinal,
                end_ordinal, role, parts_json, joined_text)
             VALUES ('pub', 's1', 1, 2, 'user', '[]', 'before'),
                    ('pub', 's1', 3, 4, 'user', '[]', 'straddles'),
                    ('pub', 's1', 7, 9, 'user', '[]', 'after');
             INSERT INTO compartment_events (session_id, compartment_id, kind, at_compartment, created_at, harness)
             SELECT 's1', id, 'discovery', sequence, 1, 'pi' FROM compartments;
             INSERT INTO memory_observations (content, session_id, source_start_ordinal, source_end_ordinal, created_at)
             VALUES ('likes tests', 's1', 3, 4, 1);
             INSERT INTO memories (level, owner_id, category, origin_category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at, status, metadata_json)
             VALUES ('global', 'self', 'mc:user-unsorted', 'USER_MEMORY', 'likes tests', 'likes tests', 1, 1, 1, 1, 'active',
                 json_object('promoted_at', 1, 'source_candidate_provenance', '[{\"session_id\":\"s1\",\"source_compartment_start\":3,\"source_compartment_end\":4}]'));
             INSERT INTO primer_candidates (project_path, harness, session_id, question, normalized_question,
                 source_compartment_start, source_compartment_end, source_start_message_id, source_end_message_id, source_message_time, created_at)
             VALUES ('/p', 'pi', 's1', 'q', 'q', 7, 9, 'a7', 'a9', 1, 1);"
        ).unwrap();
        if source {
            conn.execute_batch(
                "INSERT INTO message_history_source (session_id, message_id, message_ordinal, source_version,
                    normalized_content_hash, role, harness, updated_at)
                 VALUES ('s1', 'vanished-assistant', 4, 'v', 'h', 'assistant', 'pi', 1),
                        -- ANTAUTH's store holds an id-less system row at the
                        -- vanished message's number; it must not count.
                        ('s1', '', 4, 'v', 'h', 'system', 'pi', 1);"
            ).unwrap();
        }
        let request = MoveRequest {
            session: SessionRef::new("mock-runner", "pi", "s1"),
            preset: "head".into(),
            project: None,
            model: ModelRef::new("test", "model"),
            context_window: 100_000,
            output_reserve: 1000,
            rules: ProviderRules::new(SignedParts::None, EditCost::Suffix),
            newest: Cursor::new(8, "a9", "d"),
            now: 1,
            messages: Some(messages),
            source_harness: None,
            source_session: None,
            source_runner_entries: false,
            tag_floor: None,
            before_newest: None,
        };
        Self { dir, conn, request }
    }

    fn run(&self) -> Result<Moved, String> {
        move_in(
            ContextDb::open(&self.dir.join("context.db")).unwrap(),
            &Store::open(&self.dir.join("mode3.db")).unwrap(),
            &Settings::default().into(),
            &self.request,
        )
    }

    fn strings(&self, sql: &str) -> Vec<String> {
        self.conn
            .prepare(sql)
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    fn ranges(&self) -> Vec<String> {
        self.strings(
            "SELECT start_message || '-' || end_message FROM compartments ORDER BY sequence",
        )
    }

    fn assert_mapped(&self, exact: bool) {
        assert_eq!(self.ranges(), ["1-2", "3-5", "6-8"]);
        assert_eq!(self.strings("SELECT start_message_id || ':' || end_message_id FROM compartments ORDER BY sequence"),
            ["u1:a2", "u3:synth-user-t6", "a7:a9"]);
        assert_eq!(
            self.strings("SELECT anchor_ordinal || '' FROM notes ORDER BY id"),
            if exact {
                ["3", "3", "6"]
            } else {
                ["3", "4", "6"]
            }
        );
        assert_eq!(
            self.strings(
                "SELECT start_ordinal || '-' || end_ordinal FROM memory_fact_blocks ORDER BY id"
            ),
            if exact {
                ["1-2", "3-3", "6-8"]
            } else {
                ["1-2", "3-4", "6-8"]
            }
        );
        // Events point to summary rows, not message numbers; their durable
        // references must follow those summaries' newly mapped ranges.
        assert_eq!(self.strings("SELECT e.at_compartment || ':' || c.start_message || '-' || c.end_message FROM compartment_events e JOIN compartments c ON c.id = e.compartment_id ORDER BY e.id"),
            ["1:1-2", "2:3-5", "3:6-8"]);
        assert_eq!(
            self.strings(
                "SELECT source_start_ordinal || '-' || source_end_ordinal FROM memory_observations"
            ),
            [if exact { "3-3" } else { "3-4" }]
        );
        let provenance: Value = serde_json::from_str(
            &self.strings("SELECT json_extract(metadata_json, '$.source_candidate_provenance') FROM memories WHERE level = 'global'")[0],
        )
        .unwrap();
        assert_eq!(provenance[0]["source_compartment_start"], 3);
        assert_eq!(
            provenance[0]["source_compartment_end"],
            if exact { 3 } else { 4 }
        );
        assert_eq!(self.strings("SELECT source_compartment_start || '-' || source_compartment_end FROM primer_candidates"), ["6-8"]);
        // u5 deliberately had a stale ordinal shared with u3. Its id, not
        // that ordinal or the fallback slot, must select its runner entry.
        assert_eq!(self.strings("SELECT message_id || ':' || message_ordinal FROM message_history_source ORDER BY message_ordinal"),
            ["u3:3", "u5:4", "synth-user-t6:5", "a7:6"]);
    }

    fn assert_refused_unchanged(&self, detail: &str) {
        let before = self.strings("SELECT sequence || ':' || start_message || '-' || end_message || ':' || start_message_id || ':' || end_message_id FROM compartments ORDER BY sequence");
        let error = self.run().unwrap_err();
        assert!(error.starts_with("ordinal_unanchored:"), "{error}");
        assert!(error.contains(detail), "{error}");
        assert_eq!(self.strings("SELECT sequence || ':' || start_message || '-' || end_message || ':' || start_message_id || ':' || end_message_id FROM compartments ORDER BY sequence"), before);
        assert!(self
            .strings("SELECT key FROM schema_migrations_meta WHERE key LIKE 'mode3_%'")
            .is_empty());
        assert_eq!(
            self.strings("SELECT anchor_ordinal || '' FROM notes ORDER BY id"),
            ["3", "4", "7"]
        );
        assert!(Store::open(&self.dir.join("mode3.db"))
            .unwrap()
            .load(&self.request.session)
            .is_none());
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn move_in_pi_places_an_internal_loss_at_its_indexed_ordinal() {
    let fixture = Fixture::new("exact", true);
    let moved = fixture.run().unwrap();
    fixture.assert_mapped(true);
    assert!(serde_json::to_value(moved)
        .unwrap()
        .get("warnings")
        .is_none());
}

#[test]
fn move_in_pi_reports_an_internal_loss_placed_before_the_summary_end() {
    let fixture = Fixture::new("fallback", false);
    let moved = fixture.run().unwrap();
    fixture.assert_mapped(false);
    let output = serde_json::to_value(moved).unwrap();
    let warnings = output["warnings"].as_array().unwrap();
    assert_eq!(warnings.len(), 1);
    let warning = warnings[0].as_str().unwrap();
    assert!(warning.contains("summary 2 of s1"), "{warning}");
    assert!(
        warning.contains("placed 1 unreachable slots just before its end at 6"),
        "{warning}"
    );
}

#[test]
fn move_in_pi_refuses_a_decreasing_offset_without_writes() {
    let fixture = Fixture::new("decrease", true);
    fixture
        .conn
        .execute(
            "UPDATE compartments SET end_message = 8 WHERE sequence = 3",
            [],
        )
        .unwrap();
    fixture.assert_refused_unchanged("offset decreases");
}

#[test]
fn move_in_pi_refuses_a_summary_id_not_on_the_branch_without_writes() {
    let fixture = Fixture::new("missing-id", true);
    fixture
        .conn
        .execute(
            "UPDATE compartments SET start_message_id = 'not-on-branch' WHERE sequence = 2",
            [],
        )
        .unwrap();
    fixture.assert_refused_unchanged("not-on-branch");
}

#[test]
fn move_in_pi_accepts_a_vanished_interior_endpoint_only_with_an_exact_slot() {
    for source in [true, false] {
        let fixture = Fixture::new(
            if source {
                "endpoint-exact"
            } else {
                "endpoint-unknown"
            },
            source,
        );
        fixture.conn.execute_batch(
            "UPDATE compartments SET end_message = 4, end_message_id = 'vanished-assistant' WHERE sequence = 2;
             UPDATE compartments SET start_message = 5, start_message_id = 'u5' WHERE sequence = 3;"
        ).unwrap();
        if source {
            let moved = fixture.run().unwrap();
            assert_eq!(fixture.ranges(), ["1-2", "3-3", "4-8"]);
            assert!(serde_json::to_value(moved)
                .unwrap()
                .get("warnings")
                .is_none());
        } else {
            fixture.assert_refused_unchanged("missing summary endpoint");
        }
    }
}

#[test]
fn move_in_pi_places_a_loss_between_summaries_in_the_gap() {
    let fixture = Fixture::new("gap", false);
    fixture
        .conn
        .execute_batch(
            "UPDATE compartments SET end_message = 3, end_message_id = 'u3' WHERE sequence = 2;
         UPDATE compartments SET start_message = 5, start_message_id = 'u5' WHERE sequence = 3;",
        )
        .unwrap();
    let moved = fixture.run().unwrap();
    assert_eq!(fixture.ranges(), ["1-2", "3-3", "4-8"]);
    assert_eq!(
        fixture.strings("SELECT anchor_ordinal || '' FROM notes ORDER BY id"),
        ["3", "3", "6"]
    );
    assert!(serde_json::to_value(moved)
        .unwrap()
        .get("warnings")
        .is_none());
}

#[test]
fn move_in_pi_does_not_treat_ambiguous_source_rows_as_exact_slots() {
    let fixture = Fixture::new("ambiguous", true);
    fixture.conn.execute_batch(
        "INSERT INTO message_history_source (session_id, message_id, message_ordinal, source_version,
            normalized_content_hash, role, harness, updated_at)
         VALUES ('s1', 'another-old-id', 4, 'v', 'h', 'assistant', 'pi', 1);"
    ).unwrap();
    let moved = fixture.run().unwrap();
    fixture.assert_mapped(false);
    assert_eq!(
        serde_json::to_value(moved).unwrap()["warnings"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn move_in_pi_keeps_fallback_warnings_when_retrying_after_renumber() {
    let mut fixture = Fixture::new("retry", false);
    let numbering = Numbering::pi(
        fixture.request.messages.as_ref().unwrap(),
        &fixture.request.newest,
    )
    .unwrap()
    .align_pi(&fixture.conn, "pi", "s1")
    .unwrap();
    renumber(&mut fixture.conn, "pi", "s1", &numbering).unwrap();
    let before = fixture.ranges();
    let moved = fixture.run().unwrap();
    assert_eq!(fixture.ranges(), before);
    assert_eq!(
        serde_json::to_value(moved).unwrap()["warnings"],
        json!(numbering.alignment_warnings())
    );
}

#[test]
fn move_in_pi_maps_a_run_of_two_vanished_messages() {
    let fixture = Fixture::new("two-slots", true);
    fixture.conn.execute_batch(
        "UPDATE compartments SET end_message = 7 WHERE sequence = 2;
         UPDATE compartments SET start_message = 8, end_message = 10 WHERE sequence = 3;
         UPDATE notes SET anchor_ordinal = 8 WHERE content = 'after';
         UPDATE memory_fact_blocks SET start_ordinal = 8, end_ordinal = 10 WHERE joined_text = 'after';
         UPDATE primer_candidates SET source_compartment_start = 8, source_compartment_end = 10;
         UPDATE message_history_source SET message_ordinal = 7 WHERE message_id = 'synth-user-t6';
         UPDATE message_history_source SET message_ordinal = 8 WHERE message_id = 'a7';
         INSERT INTO message_history_source (session_id, message_id, message_ordinal, source_version,
             normalized_content_hash, role, harness, updated_at)
         VALUES ('s1', 'second-vanished-assistant', 5, 'v', 'h', 'assistant', 'pi', 1);"
    ).unwrap();
    let moved = fixture.run().unwrap();
    fixture.assert_mapped(true);
    assert!(serde_json::to_value(moved)
        .unwrap()
        .get("warnings")
        .is_none());
}

#[test]
fn move_in_pi_refuses_fractional_coordinates_without_writes() {
    let fixture = Fixture::new("fractional", true);
    fixture
        .conn
        .execute(
            "UPDATE compartments SET end_message = 8.5 WHERE sequence = 3",
            [],
        )
        .unwrap();
    fixture.assert_refused_unchanged("summaries of s1");
}
