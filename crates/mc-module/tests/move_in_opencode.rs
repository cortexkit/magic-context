//! OpenCode 1 to OpenCode 2 move-in: a session ending in assistant steps that
//! ended with no content (OpenCode 2's conversion drops them), and a refusal
//! that must leave the stored session as it was.

use cortexkit_role_compaction::read::{Cursor, SessionRef};
use cortexkit_role_compaction::rules::{EditCost, ProviderRules, SignedParts};
use cortexkit_role_compaction::setup::ModelRef;
use mc_module::context_db::ContextDb;
use mc_module::move_in::{move_in, MoveRequest, Moved};
use mc_module::move_renumber::HostMessage;
use mc_module::pass::Settings;
use mc_module::store::Store;
use rusqlite::{params, Connection};

struct Fixture {
    dir: std::path::PathBuf,
    conn: Connection,
    request: MoveRequest,
}

impl Fixture {
    /// Four messages the runner has (entries 1-4), then two empty assistant
    /// steps it doesn't. The plugin's newest summary ends at `summary_end`.
    fn new(name: &str, summary_end: (i64, &str)) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "ck-mc-move-in-opencode-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        ContextDb::create_for_tests(&dir.join("context.db")).unwrap();
        let conn = Connection::open(dir.join("context.db")).unwrap();
        let row = |mid: &str, entry: Option<u64>| HostMessage {
            mid: mid.into(),
            entry,
            finished_summary: false,
            added: false,
            pi: None,
        };
        let messages = vec![
            row("u1", Some(1)),
            row("a2", Some(2)),
            row("u3", Some(3)),
            row("u4", Some(4)),
            row("dead5", None),
            row("dead6", None),
        ];
        for (seq, start, end, start_id, end_id) in [
            (1, 1, 2, "u1", "a2"),
            (2, 3, summary_end.0, "u3", summary_end.1),
        ] {
            conn.execute(
                "INSERT INTO compartments (session_id, sequence, start_message, end_message,
                    start_message_id, end_message_id, title, content, p1, created_at, harness)
                 VALUES ('s1', ?1, ?2, ?3, ?4, ?5, ?6, 'history', 'history', 1, 'opencode')",
                params![seq, start, end, start_id, end_id, format!("Summary {seq}")],
            )
            .unwrap();
        }
        let request = MoveRequest {
            session: SessionRef::new("mock-runner", "opencode2", "s1"),
            preset: "head".into(),
            project: None,
            model: ModelRef::new("test", "model"),
            context_window: 100_000,
            output_reserve: 1000,
            rules: ProviderRules::new(SignedParts::None, EditCost::Suffix),
            newest: Cursor::new(4, "u4", "d"),
            now: 1,
            messages: Some(messages),
            source_harness: Some("opencode".into()),
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
}

#[test]
fn a_summary_ending_on_a_dropped_last_step_moves_in_at_the_newest_entry() {
    let fixture = Fixture::new("dropped-tail", (6, "dead6"));
    fixture.run().unwrap();
    assert_eq!(
        fixture.strings(
            "SELECT harness || ' ' || start_message || '-' || end_message FROM compartments ORDER BY sequence"
        ),
        ["opencode2 1-2", "opencode2 3-4"]
    );
}

#[test]
fn a_session_not_fully_summarized_refuses_before_writing_anything() {
    let fixture = Fixture::new("short", (3, "u3"));
    let refused = fixture.run().unwrap_err();
    assert!(refused.starts_with("session_not_summarized:"), "{refused}");
    // No renumbering record, no re-keyed rows, no move fence.
    assert!(fixture
        .strings("SELECT key FROM schema_migrations_meta WHERE key LIKE 'mode3_%s1'")
        .is_empty());
    assert_eq!(
        fixture.strings(
            "SELECT harness || ' ' || start_message || '-' || end_message FROM compartments ORDER BY sequence"
        ),
        ["opencode 1-2", "opencode 3-3"]
    );
}
