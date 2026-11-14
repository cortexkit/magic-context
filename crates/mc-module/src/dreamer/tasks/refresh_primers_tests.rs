use cortexkit_role_compaction::setup::ModelRef;

use super::promote::tests::{insert_candidate, insert_primer};
use super::promote::Candidate;
use super::*;
use crate::context_db::ContextDb;
use crate::memory_profile::prompt_profile;

const PROJECT: &str = "pj-primers";
const DAY: i64 = 24 * 60 * 60 * 1000;

fn primer(id: i64) -> Primer {
    Primer {
        id,
        project: PROJECT.into(),
        question: format!("How does part {id} work?"),
        embedding: None,
        model: None,
        answer: "It works.".into(),
        support: 2,
        last_observed_at: Some(100),
        answer_refreshed_at: Some(200),
        sources: Vec::new(),
        created_at: 50,
        updated_at: 200,
    }
}

fn candidate(id: i64, time: i64) -> Candidate {
    Candidate {
        id,
        project: PROJECT.into(),
        harness: "opencode".into(),
        session: "ses-1".into(),
        question: "How do leases expire".into(),
        normalized: "how do leases expire".into(),
        compartment_start: Some(10),
        compartment_end: Some(20),
        start_message_id: format!("m{id}a"),
        end_message_id: format!("m{id}b"),
        source_time: time,
        embedding: None,
        model: None,
    }
}

struct Store {
    dir: tempfile::TempDir,
    db: ContextDb,
}

fn store() -> Store {
    let dir = tempfile::tempdir().unwrap();
    let db = ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
    std::fs::create_dir_all(dir.path().join("project")).unwrap();
    Store { dir, db }
}

impl Store {
    fn compartment(&self, session: &str, start: i64, title: &str, p1: Option<&str>, content: &str) {
        self.db.with_connection(|conn| {
            conn.execute(
                "INSERT INTO compartments(session_id, sequence, start_message, end_message, title, content, p1, created_at, harness)
                 VALUES (?1, ?2, ?2, ?2, ?3, ?4, ?5, 1, 'opencode')",
                params![session, start, title, content, p1],
            )
            .unwrap();
        });
    }

    fn with_context<T>(&self, body: impl FnOnce(&TaskContext<'_>) -> T) -> T {
        let profile = prompt_profile(None).unwrap();
        let declaration = profile.body["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|task| task["kind"] == KIND)
            .unwrap()
            .clone();
        let owner = Owner::Project {
            id: PROJECT.into(),
            root: self.dir.path().join("project").to_str().unwrap().to_owned(),
        };
        body(&TaskContext {
            db: &self.db,
            owner: &owner,
            profile: &profile,
            declaration: &declaration,
            workspace: None,
            guidance: None,
        })
    }

    fn plan(&self) -> Vec<RefreshBatch> {
        self.with_context(|context| RefreshPrimers.plan_batches(context).unwrap())
    }

    fn write(&self, batch: &RefreshBatch, answer: &str, steps: Option<u64>, now: i64) -> Applied {
        self.db.with_connection(|conn| {
            let tx = conn.transaction().unwrap();
            let applied = batch.write(&tx, answer, steps, now).unwrap();
            tx.commit().unwrap();
            applied
        })
    }

    fn stored(&self, id: i64) -> (String, Option<i64>, i64) {
        self.db
            .with_connection(|conn| {
                conn.query_row(
                    "SELECT answer, answer_refreshed_at, updated_at FROM primers WHERE id = ?1",
                    [id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
            })
            .unwrap()
    }
}

// --- Which primers a run refreshes ---

#[test]
fn a_run_refreshes_stale_primers_least_recently_refreshed_first_at_most_five() {
    let primers = vec![
        // Fresh: answered and not asked again since.
        primer(1),
        // Asked again since its refresh.
        Primer {
            last_observed_at: Some(300),
            answer_refreshed_at: Some(250),
            ..primer(2)
        },
        // An empty answer, refreshed at 400.
        Primer {
            answer: "  ".into(),
            answer_refreshed_at: Some(400),
            last_observed_at: Some(10),
            ..primer(3)
        },
        // Never refreshed: before every refreshed one, then by observation.
        Primer {
            answer_refreshed_at: None,
            last_observed_at: Some(90),
            ..primer(4)
        },
        Primer {
            answer_refreshed_at: None,
            last_observed_at: None,
            created_at: 40,
            ..primer(5)
        },
        Primer {
            answer_refreshed_at: None,
            last_observed_at: Some(90),
            ..primer(6)
        },
        Primer {
            answer: String::new(),
            answer_refreshed_at: Some(500),
            ..primer(7)
        },
    ];
    assert!(!stale(&primers[0]));
    let chosen: Vec<i64> = select(&primers, PER_RUN)
        .iter()
        .map(|primer| primer.id)
        .collect();
    assert_eq!(chosen, vec![5, 4, 6, 2, 3]);
}

// --- The message ---

#[test]
fn the_orientation_is_the_newest_source_candidates_summary() {
    let store = store();
    store.db.with_connection(|conn| {
        insert_candidate(conn, &candidate(1, 1_000));
        insert_candidate(
            conn,
            &Candidate {
                compartment_start: Some(30),
                session: "ses-2".into(),
                ..candidate(2, 5_000)
            },
        );
        // Newer, but recorded under another project: never read.
        insert_candidate(
            conn,
            &Candidate {
                project: "pj-other".into(),
                compartment_start: Some(40),
                ..candidate(3, 9_000)
            },
        );
    });
    store.compartment("ses-1", 10, "Old work", Some("The old summary."), "old");
    store.compartment(
        "ses-2",
        30,
        "Lease work",
        Some("  "),
        "Leases expire after the heartbeat stops.",
    );
    store.compartment("ses-1", 40, "Other project", Some("Not this one."), "x");
    let with_sources = |sources: Vec<i64>| Primer {
        sources,
        ..primer(1)
    };
    store.db.with_connection(|conn| {
        assert_eq!(
            orientation(conn, &with_sources(vec![1, 2, 3])).unwrap(),
            Some("Lease work\nLeases expire after the heartbeat stops.".into()),
            "the newest candidate of the project; its text when its P1 is empty"
        );
        assert_eq!(
            orientation(conn, &with_sources(vec![1])).unwrap(),
            Some("Old work\nThe old summary.".into())
        );
        // A pruned candidate, or one whose summary is gone, orients nothing.
        assert_eq!(orientation(conn, &with_sources(vec![99])).unwrap(), None);
        conn.execute("DELETE FROM compartments WHERE title = 'Lease work'", [])
            .unwrap();
        assert_eq!(orientation(conn, &with_sources(vec![2])).unwrap(), None);
    });
}

#[test]
fn the_message_fills_the_input_frame_byte_for_byte() {
    let store = store();
    store.db.with_connection(|conn| {
        insert_candidate(conn, &candidate(1, now_ms() - 3 * DAY));
        insert_primer(
            conn,
            &Primer {
                answer: String::new(),
                answer_refreshed_at: None,
                question: "How do leases expire?".into(),
                sources: vec![1],
                ..primer(1)
            },
            "active",
        );
    });
    store.compartment(
        "ses-1",
        10,
        "Lease work",
        Some("Leases expire after the heartbeat stops."),
        "x",
    );
    let batches = store.plan();
    assert_eq!(batches.len(), 1);
    assert_eq!(
        batches[0].message(),
        "## Refresh the answer to a standing question\n\n**Project:** pj-primers\n\n<question>\nHow do leases expire?\n</question>\n\n<current-answer>\nnone yet\n</current-answer>\n\n<orientation>\nThe summary of the work in which this question last came up. It shows where to look, not what is true now.\nLease work\nLeases expire after the heartbeat stops.\n</orientation>"
    );
    assert!(batches[0]
        .system
        .contains("{\"answer\": \"How it works now, as markdown text.\"}"));
    // An answered primer shows its answer; without a summary, none.
    let text = input(
        &Primer {
            answer: " It works. ".into(),
            ..primer(2)
        },
        None,
    );
    assert!(text.contains("<current-answer>\nIt works.\n</current-answer>"));
    assert!(text.ends_with("not what is true now.\nnone\n</orientation>"));
}

// --- The reply ---

#[test]
fn the_answer_is_read_from_the_object_with_or_without_a_fence() {
    assert_eq!(
        parse_answer("{\"answer\": \"  It works.  \"}").unwrap(),
        "It works."
    );
    assert_eq!(
        parse_answer("Here it is:\n```json\n{\"answer\": \"Fenced.\"}\n```").unwrap(),
        "Fenced."
    );
    assert_eq!(
        parse_answer("{\"answer\": \"Call it:\\n```rust\\nrun()\\n```\"}").unwrap(),
        "Call it:\n```rust\nrun()\n```",
        "a fence inside the answer is part of it"
    );
    assert_eq!(parse_answer("{\"answer\": \"\"}").unwrap(), "");
    assert_eq!(parse_answer("{\"answer\": 4}").unwrap(), "");
    assert!(parse_answer("I could not find it.").is_err());
    assert!(parse_answer("{not json}").is_err());
}

#[test]
fn the_stored_answer_stays_without_a_tool_call_or_an_answer_and_when_too_long() {
    let store = store();
    store
        .db
        .with_connection(|conn| insert_primer(conn, &primer(1), "active"));
    let batch = RefreshBatch {
        primer: primer(1),
        system: String::new(),
        message: String::new(),
        allowed: true,
    };
    let kept = |steps: Option<u64>, answer: &str, reason: &str| {
        let applied = store.write(&batch, answer, steps, 900);
        assert_eq!(
            (applied.proposed, applied.applied, applied.dropped.clone()),
            (
                1,
                0,
                vec![format!("primer 1: {reason}; the stored answer stays")]
            )
        );
        assert_eq!(store.stored(1), ("It works.".into(), Some(200), 200));
    };
    kept(
        Some(1),
        "It works differently now.",
        "the run made no tool call",
    );
    kept(
        None,
        "It works differently now.",
        "the runner reported no step count, so no tool call is proven",
    );
    kept(Some(4), "", "the answer is empty");
    let refused = RefreshBatch {
        allowed: false,
        primer: primer(1),
        system: String::new(),
        message: String::new(),
    };
    let applied = store.write(&refused, "It works differently now.", Some(4), 900);
    assert_eq!(
        applied.dropped,
        vec![
            "primer 1: the task's declaration does not allow set-primer-answer; the stored answer stays"
                .to_owned()
        ]
    );
    kept(
        Some(4),
        &"x".repeat(MAX_ANSWER + 1),
        "the answer is longer than 20000 characters (20001)",
    );
    let applied = store.write(&batch, "It works differently now.", Some(4), 900);
    assert_eq!((applied.applied, applied.dropped.len()), (1, 0));
    assert_eq!(
        store.stored(1),
        ("It works differently now.".into(), Some(900), 900)
    );
}

#[test]
fn a_primer_changed_after_the_run_read_it_is_not_overwritten() {
    let store = store();
    store.db.with_connection(|conn| {
        insert_primer(conn, &primer(1), "active");
        conn.execute("UPDATE primers SET updated_at = 300 WHERE id = 1", [])
            .unwrap();
    });
    let batch = RefreshBatch {
        primer: primer(1),
        system: String::new(),
        message: String::new(),
        allowed: true,
    };
    let applied = store.write(&batch, "A new answer.", Some(3), 900);
    assert_eq!(
        applied.dropped,
        vec!["primer 1: it changed after the run read it".to_owned()]
    );
    assert_eq!(store.stored(1).0, "It works.");
}

#[test]
fn an_accepted_reply_holds_a_json_object_and_apply_uses_the_runs_steps() {
    let store = store();
    store
        .db
        .with_connection(|conn| insert_primer(conn, &primer(1), "active"));
    let batch = RefreshBatch {
        primer: primer(1),
        system: String::new(),
        message: String::new(),
        allowed: true,
    };
    assert!(batch.accepts("I could not read the code.").is_err());
    assert!(batch.accepts("{\"answer\": \"\"}").is_ok());
    let reply = |steps: Option<u64>| TaskReply {
        text: "{\"answer\": \"Read from the code.\"}".into(),
        model: ModelRef::new("p", "m"),
        runner: "r".into(),
        child: "mc-dream:3.0:0.0".into(),
        usage: None,
        steps,
    };
    let applied = store.db.with_connection(|conn| {
        let tx = conn.transaction().unwrap();
        let applied = batch.apply(&tx, &reply(Some(1)), 3).unwrap();
        tx.commit().unwrap();
        applied
    });
    assert_eq!(applied.applied, 0);
    let applied = store.db.with_connection(|conn| {
        let tx = conn.transaction().unwrap();
        let applied = batch.apply(&tx, &reply(Some(5)), 3).unwrap();
        tx.commit().unwrap();
        applied
    });
    assert_eq!(applied.applied, 1);
    assert_eq!(store.stored(1).0, "Read from the code.");
}

// --- A whole run ---

#[test]
fn a_run_promotes_first_then_refreshes_what_it_promoted() {
    let store = store();
    let now = now_ms();
    store.db.with_connection(|conn| {
        insert_candidate(conn, &candidate(1, now - 20 * DAY));
        insert_candidate(conn, &candidate(2, now - 10 * DAY));
    });
    let batches = store.plan();
    assert_eq!(batches.len(), 1, "the new primer has no answer yet");
    assert!(
        batches[0].allowed,
        "the bundled declaration allows writing answers"
    );
    assert_eq!(batches[0].primer.question, "How do leases expire?");
    assert_eq!(batches[0].primer.sources, vec![1, 2]);
}

#[test]
fn a_run_with_nothing_to_refresh_still_promotes_and_sends_nothing() {
    let store = store();
    let now = now_ms();
    store.db.with_connection(|conn| {
        insert_candidate(conn, &candidate(1, now - 20 * DAY));
        insert_candidate(conn, &candidate(2, now - 10 * DAY));
        // Answered after it was last observed: fresh.
        insert_primer(
            conn,
            &Primer {
                question: "How do leases expire?".into(),
                sources: vec![1],
                last_observed_at: Some(now - 20 * DAY),
                answer_refreshed_at: Some(now - 15 * DAY),
                ..primer(1)
            },
            "active",
        );
    });
    // The second candidate is a new observation of the primer: its support
    // grows, and it is stale again.
    let batches = store.plan();
    assert_eq!(batches.len(), 1);
    let (support, observed): (i64, i64) = store
        .db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT total_support, last_observed_at FROM primers WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .unwrap();
    assert_eq!((support, observed), (2, now - 10 * DAY));
    // Once refreshed after that, nothing is left to send, and no primer is
    // promoted twice.
    store.db.with_connection(|conn| {
        conn.execute(
            "UPDATE primers SET answer_refreshed_at = ?1 WHERE id = 1",
            [now],
        )
        .unwrap();
    });
    assert!(store.plan().is_empty());
    let primers: i64 = store
        .db
        .with_connection(|conn| {
            conn.query_row("SELECT count(*) FROM primers", [], |row| row.get(0))
        })
        .unwrap();
    assert_eq!(primers, 1);
}
