use std::path::PathBuf;

use cortexkit_role_compaction::setup::ModelRef;
use serde_json::{json, Value};

use super::*;
use crate::context_db::ContextDb;
use crate::context_migrations::frozen_category_id;
use crate::dreamer::store;
use crate::memory_profile::prompt_profile;
use crate::memory_writes::person::{self, OwnerRef};

pub(crate) const PROJECT: &str = "pj-reflect";
const TASK: &str = "swe:reflect-patterns";
const RUN: i64 = 11;
const CHILD: &str = "mc-dream:11.0:0.0";
/// The fixtures' clock.
const NOW: i64 = 1_800_000_000_000;

/// A temporary store at the module's schema.
pub(crate) struct Store {
    _dir: tempfile::TempDir,
    pub db: ContextDb,
    root: PathBuf,
}

/// One stored event as the fixtures write it.
pub(crate) struct Stored<'a> {
    pub id: i64,
    pub session: &'a str,
    pub kind: &'a str,
    /// The grouping field's value: the surface or the correction source.
    pub key: &'a str,
    pub summary: &'a str,
    pub days_ago: i64,
}

pub(crate) fn store() -> Store {
    let dir = tempfile::tempdir().unwrap();
    let db = ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
    let root = dir.path().join("project");
    std::fs::create_dir_all(&root).unwrap();
    db.with_connection(|conn| {
        store::ensure_schedule(conn, &OwnerKey::project(PROJECT), TASK, "0 5 * * *", NOW).unwrap();
        conn.execute_batch(
            "INSERT INTO session_projects(session_id, harness, project_path, updated_at) VALUES
                 ('ses-a', 'opencode', 'pj-reflect', 1),
                 ('ses-b', 'opencode', 'pj-reflect', 1),
                 ('ses-c', 'pi', 'pj-reflect', 1),
                 ('ses-x', 'opencode', 'pj-other', 1);",
        )
        .unwrap();
    });
    Store {
        _dir: dir,
        db,
        root,
    }
}

impl Store {
    pub(crate) fn events(&self, events: &[Stored<'_>]) {
        self.db.with_connection(|conn| {
            for event in events {
                let fields = if event.kind == "causal_incident" {
                    json!({
                        "summary": event.summary,
                        "affected_surface": event.key,
                        "symptom": "the run vanished",
                        "cause_summary": "a config write",
                        "disposition": "workaround",
                        "evidence": "the host log",
                    })
                } else {
                    json!({
                        "summary": event.summary,
                        "before_strategy": "guessed the schema",
                        "correction_source": event.key,
                        "correction_signal": "read the migration first",
                        "after_strategy": "read the migration",
                        "evidence": "the session",
                    })
                };
                let harness = if event.session == "ses-c" { "pi" } else { "opencode" };
                conn.execute(
                    "INSERT INTO compartment_events(id, session_id, compartment_id, kind, at_compartment, fields_json, created_at, harness)
                     VALUES (?1, ?2, NULL, ?3, 1, ?4, ?5, ?6)",
                    params![
                        event.id,
                        event.session,
                        event.kind,
                        fields.to_string(),
                        NOW - event.days_ago * DAY_MS,
                        harness
                    ],
                )
                .unwrap();
            }
        });
    }

    pub(crate) fn memory(&self, id: i64, level: &str, owner: &str, tag: &str, content: &str) {
        self.db.with_connection(|conn| {
            conn.execute(
                "INSERT INTO memories(id, level, owner_id, category, origin_category, content, normalized_hash,
                                      importance, status, first_seen_at, created_at, updated_at, last_seen_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 50, 'active', 0, 0, 0, 0)",
                params![id, level, owner, frozen_category_id(tag), tag, content, normalized_hash(content)],
            )
            .unwrap();
        });
    }

    pub(crate) fn watermark(&self) -> Option<Value> {
        self.db
            .with_connection(|conn| store::schedule_of(conn, &OwnerKey::project(PROJECT), TASK))
            .unwrap()
            .unwrap()
            .watermark
    }

    pub(crate) fn set_watermark(&self, event: i64) {
        self.db
            .with_connection(|conn| write_watermark(conn, PROJECT, TASK, event))
            .unwrap();
    }

    fn value<T: rusqlite::types::FromSql>(&self, sql: &str) -> T {
        self.db
            .with_connection(|conn| conn.query_row(sql, [], |row| row.get(0)))
            .unwrap()
    }

    /// Plan the run at the fixtures' clock, with `vectors` for its groups.
    fn plan_with(
        &self,
        declaration: Option<Value>,
        vectors: &[Option<Vec<f32>>],
        model: Option<&str>,
    ) -> Vec<ReflectBatch> {
        with_context(self, declaration, |context| {
            let prepared = ReflectEvents.prepare(context, NOW).unwrap();
            ReflectEvents
                .finish(context, prepared, vectors, model, NOW)
                .unwrap()
        })
    }

    fn plan(&self) -> Vec<ReflectBatch> {
        self.plan_with(None, &[], None)
    }

    fn write(&self, batch: &ReflectBatch, reply: &str) -> Written {
        self.db.with_connection(|conn| {
            let tx = conn.transaction().unwrap();
            let entries = parse_learnings(reply).unwrap();
            let written = batch.write(&tx, &entries, CHILD, RUN).unwrap();
            tx.commit().unwrap();
            written
        })
    }
}

pub(crate) fn declaration() -> Value {
    let profile = prompt_profile(None).unwrap();
    profile.body["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|task| task["kind"] == KIND)
        .unwrap()
        .clone()
}

fn with_context<T>(
    store: &Store,
    declaration: Option<Value>,
    body: impl FnOnce(&TaskContext<'_>) -> T,
) -> T {
    let profile = prompt_profile(None).unwrap();
    let declaration = declaration.unwrap_or_else(self::declaration);
    let owner = Owner::Project {
        id: PROJECT.into(),
        root: store.root.to_str().unwrap().to_owned(),
    };
    body(&TaskContext {
        db: &store.db,
        owner: &owner,
        profile: &profile,
        declaration: &declaration,
        workspace: None,
        guidance: None,
        branches: &[],
    })
}

fn reply(text: &str) -> TaskReply {
    TaskReply {
        text: text.into(),
        model: ModelRef::new("p", "m"),
        runner: "r".into(),
        child: CHILD.into(),
        usage: None,
        steps: None,
    }
}

fn incident<'a>(
    id: i64,
    session: &'a str,
    surface: &'a str,
    summary: &'a str,
    days_ago: i64,
) -> Stored<'a> {
    Stored {
        id,
        session,
        kind: "causal_incident",
        key: surface,
        summary,
        days_ago,
    }
}

fn correction<'a>(
    id: i64,
    session: &'a str,
    source: &'a str,
    summary: &'a str,
    days_ago: i64,
) -> Stored<'a> {
    Stored {
        id,
        session,
        kind: "trajectory_correction",
        key: source,
        summary,
        days_ago,
    }
}

/// The project's events most tests read: three older host incidents and two
/// new ones, each on a day of its own, a new correction alone in its group,
/// and a new incident of another project. The watermark is at the third
/// event.
fn fixture() -> Store {
    let store = store();
    store.events(&[
        incident(
            1,
            "ses-a",
            "host_integration",
            "The host restarted the runner during a build",
            20,
        ),
        incident(
            2,
            "ses-b",
            "host_integration",
            "The host restarted the runner after an update",
            15,
        ),
        incident(
            3,
            "ses-a",
            "host_integration",
            "The host restarted the runner twice",
            10,
        ),
        incident(
            4,
            "ses-b",
            "host_integration",
            "The host restarted the runner again",
            2,
        ),
        incident(
            5,
            "ses-a",
            "host_integration",
            "The host restarted the runner mid-run",
            1,
        ),
        correction(
            6,
            "ses-a",
            "user",
            "Read the migration before guessing the schema",
            1,
        ),
        incident(
            7,
            "ses-x",
            "host_integration",
            "The host restarted another project's runner",
            1,
        ),
    ]);
    store.memory(
        1,
        "project",
        PROJECT,
        "CONSTRAINTS",
        "The host restarts the runner on every config change.",
    );
    store.memory(
        2,
        "project",
        PROJECT,
        "NAMING",
        "Names use kebab case for files.",
    );
    store.set_watermark(3);
    store
}

// --- What a run reads and groups ---

#[test]
fn the_profile_declares_both_event_kinds_with_their_grouping_fields() {
    let profile = prompt_profile(None).unwrap();
    let kinds = event_kinds(&profile, &declaration());
    let summary: Vec<(&str, &str, &str)> = kinds
        .iter()
        .map(|kind| (kind.tag.as_str(), kind.label.as_str(), kind.key.as_str()))
        .collect();
    assert_eq!(
        summary,
        vec![
            ("causal_incident", "incident", "affected_surface"),
            ("trajectory_correction", "correction", "correction_source"),
        ]
    );
    assert_eq!(&kinds[0].fields[..2], ["summary", "affected_surface"]);
    assert_eq!(min_proof(&declaration()), 2);
}

#[test]
fn a_group_is_sent_with_a_new_event_and_events_from_enough_days() {
    let store = fixture();
    let groups = with_context(&store, None, |context| {
        ReflectEvents.prepare(context, NOW).unwrap().groups
    });
    // The correction has one event, so one day, and the other project's
    // incident is not this project's.
    assert_eq!(groups.len(), 1);
    let group = &groups[0];
    assert_eq!(group.value, "host_integration");
    assert_eq!(
        group
            .events
            .iter()
            .map(|event| event.id)
            .collect::<Vec<_>>(),
        vec![5, 4, 3, 2, 1],
        "new events newest first, then older ones newest first"
    );
    assert_eq!(group.new, HashSet::from([4, 5]));
    assert_eq!(group.days(), 5);
}

#[test]
fn older_events_count_towards_the_days_but_a_group_needs_a_new_one() {
    let kinds = event_kinds(&prompt_profile(None).unwrap(), &declaration());
    let event = |id: i64, value: &str, days: i64| Event {
        id,
        kind: "causal_incident".into(),
        fields: BTreeMap::from([("affected_surface".into(), value.into())]),
        created_at: NOW - days * DAY_MS,
    };
    let since = NOW - WINDOW_DAYS * DAY_MS;
    let events = vec![
        // One new event, and an older one on another day.
        event(10, "environment", 1),
        event(3, "environment", 30),
        // Only older events, on two days.
        event(2, "provider_sdk", 30),
        event(1, "provider_sdk", 40),
        // A new event and an older one on the same day: one day.
        event(13, "tool_protocol", 1),
        event(4, "tool_protocol", 1),
        // A new event, and the only other one too old to show.
        event(11, "ui", 1),
        event(0, "ui", WINDOW_DAYS + 1),
        // New, on two days, but older than the window: a first run finds
        // every stored event new, and these are months old.
        event(14, "model_behavior", WINDOW_DAYS + 1),
        event(15, "model_behavior", WINDOW_DAYS + 2),
        // No grouping field.
        Event {
            fields: BTreeMap::new(),
            ..event(12, "", 1)
        },
    ];
    let sent = groups(&kinds, &events, 5, since, 2);
    assert_eq!(
        sent.iter()
            .map(|group| group.value.as_str())
            .collect::<Vec<_>>(),
        vec!["environment"]
    );
    assert_eq!(sent[0].new, HashSet::from([10]));
    // With a proof count of one, one day is enough.
    let one = groups(&kinds, &events, 5, since, 1);
    assert_eq!(
        one.iter()
            .map(|group| group.value.as_str())
            .collect::<Vec<_>>(),
        vec!["environment", "tool_protocol", "ui"]
    );
    assert_eq!(one[2].events.len(), 1, "the too-old event is not shown");
}

#[test]
fn a_group_shows_at_most_thirty_events_new_ones_first() {
    let kinds = event_kinds(&prompt_profile(None).unwrap(), &declaration());
    let event = |id: i64, days: i64| Event {
        id,
        kind: "causal_incident".into(),
        fields: BTreeMap::from([("affected_surface".into(), "environment".into())]),
        created_at: NOW - days * DAY_MS,
    };
    let since = NOW - WINDOW_DAYS * DAY_MS;
    // 35 new events: the 30 newest are shown.
    let many: Vec<Event> = (100..135).map(|id| event(id, 140 - id)).collect();
    let shown = &groups(&kinds, &many, 99, since, 2)[0];
    assert_eq!(shown.events.len(), GROUP_EVENTS);
    assert_eq!(shown.events.first().unwrap().id, 134);
    assert_eq!(shown.events.last().unwrap().id, 105);
    // 25 new events and 10 older ones: the 5 newest older ones fill it.
    let mixed: Vec<Event> = (1..=35).map(|id| event(id, 40 - id)).collect();
    let shown = &groups(&kinds, &mixed, 10, since, 2)[0];
    assert_eq!(shown.events.len(), GROUP_EVENTS);
    assert_eq!(shown.new.len(), 25);
    assert_eq!(
        shown.events[25..]
            .iter()
            .map(|event| event.id)
            .collect::<Vec<_>>(),
        vec![10, 9, 8, 7, 6]
    );
}

// --- The message ---

#[test]
fn the_message_fills_the_input_frame_byte_for_byte() {
    let store = fixture();
    let batches = store.plan();
    assert_eq!(batches.len(), 1);
    let event = |id: i64, day: &str, new: &str, summary: &str| {
        format!(
            "<event id=\"e{id}\" day=\"{day}\" new=\"{new}\">\nsummary: {summary}\naffected_surface: host_integration\nsymptom: the run vanished\ncause_summary: a config write\ndisposition: workaround\nevidence: the host log\n</event>"
        )
    };
    let expected = format!(
        "## Find the patterns in this project's events\n\n**Project:** pj-reflect\n\nEvents marked `new=\"yes\"` arrived since the last run. The other events in a group are older events of the same kind, shown so that a pattern can span a long time.\n\n<existing-memories>\nMemories that already exist on these subjects. Do not write them again.\n[1] CONSTRAINTS: The host restarts the runner on every config change.\n</existing-memories>\n\n<group kind=\"incident\" affected_surface=\"host_integration\" days=\"5\">\n{}\n{}\n{}\n{}\n{}\n</group>",
        event(5, "d1", "yes", "The host restarted the runner mid-run"),
        event(4, "d2", "yes", "The host restarted the runner again"),
        event(3, "d3", "no", "The host restarted the runner twice"),
        event(2, "d4", "no", "The host restarted the runner after an update"),
        event(1, "d5", "no", "The host restarted the runner during a build"),
    );
    assert_eq!(batches[0].message(), expected);
    // The system prompt is the profile's, with its output contract.
    assert!(batches[0].system.contains("<learnings>"));
    assert!(!batches[0].system.contains('⟦'));
    assert_eq!(batches[0].existing, vec![1]);
}

#[test]
fn an_empty_existing_block_is_left_out_and_aliases_restart_per_message() {
    let store = store();
    store.events(&[
        correction(1, "ses-b", "self_review", "Checked the lock order twice", 3),
        correction(2, "ses-c", "self_review", "Checked the lock order again", 2),
    ]);
    let batches = store.plan();
    let message = batches[0].message();
    assert!(!message.contains("<existing-memories>"));
    assert!(message.contains(
        "<group kind=\"correction\" correction_source=\"self_review\" days=\"2\">\n<event id=\"e2\" day=\"d1\" new=\"yes\">\nsummary: Checked the lock order again\nbefore_strategy: guessed the schema\ncorrection_source: self_review\ncorrection_signal: read the migration first\nafter_strategy: read the migration\nevidence: the session\n</event>"
    ));
    assert!(
        !message.contains("ses-"),
        "real session ids never reach the model"
    );
}

#[test]
fn existing_memories_come_by_meaning_when_vectors_exist_and_by_words_otherwise() {
    let store = fixture();
    store.memory(
        3,
        "project",
        PROJECT,
        "CONSTRAINTS",
        "Caches stay warm between sessions.",
    );
    store.memory(
        4,
        "workspace",
        "ws-1",
        "CONSTRAINTS",
        "Workspace memories are not this project's.",
    );
    store.db.with_connection(|conn| {
        for (id, vector) in [(2, [1.0f32, 0.0]), (3, [0.6, 0.8]), (1, [0.0, 1.0])] {
            conn.execute(
                "INSERT INTO memory_embeddings(memory_id, embedding, model_id) VALUES (?1, ?2, 'model-a')",
                params![id, crate::embedding::encode(&vector)],
            )
            .unwrap();
        }
    });
    // By meaning: the closest vectors first, whatever their words.
    let batches = store.plan_with(None, &[Some(vec![1.0, 0.1])], Some("model-a"));
    assert_eq!(batches[0].existing, vec![2, 3, 1]);
    // Vectors of another model don't count: by words.
    let batches = store.plan_with(None, &[Some(vec![1.0, 0.1])], Some("model-b"));
    assert_eq!(batches[0].existing, vec![1]);
    // Without a query vector: by words. A workspace's memory is shown only
    // when the run is given the project's workspace.
    assert_eq!(store.plan()[0].existing, vec![1]);
}

// --- The checks ---

fn learning(route: &str, category: &str, events: &str, text: &str) -> String {
    format!(
        "<learning route=\"{route}\" category=\"{category}\" events=\"{events}\">{text}</learning>"
    )
}

fn learnings(items: &[String]) -> String {
    format!("<learnings>\n{}\n</learnings>", items.join("\n"))
}

#[test]
fn every_check_drops_a_learning_that_fails_it_with_its_reason() {
    let store = fixture();
    let batch = store.plan().remove(0);
    let good = "Plan for the host to restart the runner whenever its config changes.";
    let cases: Vec<(String, &str)> = vec![
        (
            learning("note", "CONSTRAINTS", "e4,e5", good),
            "note is not a route (memory or observation)",
        ),
        (
            learning("memory", "COMMUNICATION", "e4,e5", good),
            "COMMUNICATION is not a project category",
        ),
        (
            learning("observation", "CONSTRAINTS", "e4,e5", good),
            "CONSTRAINTS is not a user category",
        ),
        (
            learning("memory", "", "e4,e5", good),
            "(none) is not a project category",
        ),
        (
            learning("memory", "CONSTRAINTS", "e5,e6", good),
            "e6 is not an event of this message",
        ),
        (
            learning("memory", "CONSTRAINTS", "e5", good),
            "the cited events come from 1 day(s), fewer than 2",
        ),
        (
            learning("memory", "CONSTRAINTS", "e1,e2", good),
            "no cited event is new",
        ),
        (
            learning(
                "memory",
                "CONSTRAINTS",
                "e4,e5",
                "The host restarts &quot;on purpose&quot; on config changes.",
            ),
            "the text holds a quotation mark (\")",
        ),
        (
            learning(
                "memory",
                "CONSTRAINTS",
                "e4,e5",
                "Since 2026-11-02 the host restarts on config changes.",
            ),
            "the text holds a date (2026-11-02)",
        ),
        (
            learning(
                "memory",
                "CONSTRAINTS",
                "e4,e5",
                "Stop doing restarts by hand, the host restarts itself.",
            ),
            "the text keeps a frustration phrase (Stop doing)",
        ),
        (
            learning(
                "memory",
                "CONSTRAINTS",
                "e4,e5",
                "Expect that the host restarted the runner mid-run on config changes.",
            ),
            "the text copies a run of words from the events it cites",
        ),
        (
            learning(
                "memory",
                "CONSTRAINTS",
                "e4,e5",
                &"x".repeat(MAX_CONTENT + 1),
            ),
            "the text is longer than 20000 characters (20001)",
        ),
        (
            learning(
                "memory",
                "CONSTRAINTS",
                "e4,e5",
                "The host restarts the runner on every config change.",
            ),
            "it repeats live memory 1",
        ),
        (learning("memory", "constraints", "e4,e5", good), ""),
        (
            learning("memory", "swe:constraints", "e4,e5", good),
            "it repeats an earlier learning of this list",
        ),
    ];
    let reply = learnings(
        &cases
            .iter()
            .map(|(learning, _)| learning.clone())
            .collect::<Vec<_>>(),
    );
    let written = store.write(&batch, &reply);
    let expected: Vec<Option<String>> = cases
        .iter()
        .map(|(_, reason)| (!reason.is_empty()).then(|| reason.to_string()))
        .collect();
    assert_eq!(written.refusals, expected);
    assert_eq!(written.applied.proposed, cases.len());
    assert_eq!(written.applied.applied, 1);
    assert_eq!(written.applied.dropped.len(), cases.len() - 1);
    assert_eq!(
        written.applied.dropped[0],
        "learning 1 (note CONSTRAINTS, e4,e5): note is not a route (memory or observation)"
    );
}

#[test]
fn events_of_two_sessions_on_one_day_count_as_one_day() {
    // What counts is the days the events happened on, not their sessions: an
    // agent that works with the person for weeks keeps its whole history in
    // one session, and two sessions can share a day.
    let store = store();
    store.events(&[
        correction(1, "ses-b", "self_review", "Checked the lock order twice", 3),
        correction(2, "ses-c", "self_review", "Checked the lock order again", 1),
        correction(3, "ses-b", "self_review", "Checked it once more", 1),
    ]);
    let batch = store.plan().remove(0);
    let written = store.write(
        &batch,
        &learnings(&[
            learning(
                "memory",
                "CONSTRAINTS",
                "e2,e3",
                "Confirm which locks a change takes before editing it.",
            ),
            learning(
                "memory",
                "CONSTRAINTS",
                "e1,e3",
                "Read the lock order before a change that takes locks.",
            ),
        ]),
    );
    assert_eq!(
        written.refusals,
        vec![
            Some("the cited events come from 1 day(s), fewer than 2".into()),
            None
        ]
    );
}

#[test]
fn a_learning_the_declaration_does_not_allow_is_dropped() {
    let store = fixture();
    let mut declaration = declaration();
    declaration["actions"] = json!(["write-memory"]);
    let batch = store.plan_with(Some(declaration), &[], None).remove(0);
    let written = store.write(
        &batch,
        &learnings(&[learning(
            "observation",
            "COMMUNICATION",
            "e4,e5",
            "Wants a host restart announced before it happens.",
        )]),
    );
    assert_eq!(
        written.refusals,
        vec![Some(
            "the task's declaration does not allow write-observation-candidate".into()
        )]
    );
}

#[test]
fn an_unreadable_learning_is_dropped_and_the_others_still_apply() {
    let store = fixture();
    let batch = store.plan().remove(0);
    let reply = format!(
        "<learnings>\n<learning route=\"memory\" category=\"NAMING\" events=\"ex\">Bad id.</learning>\n{}\n</learnings>",
        learning("memory", "CONSTRAINTS", "e4,e5", "Plan for the host to restart the runner whenever its config changes.")
    );
    let written = store.write(&batch, &reply);
    assert_eq!(
        written.refusals,
        vec![Some("ex is not an event id".into()), None]
    );
}

// --- What a learning writes ---

#[test]
fn a_memory_is_a_project_memory_naming_the_run_and_its_events_and_the_run_can_undo_it() {
    let store = fixture();
    let batch = store.plan().remove(0);
    let text = "Plan for the host to restart the runner whenever its config changes.";
    let written = store.write(
        &batch,
        &learnings(&[learning("memory", "CONSTRAINTS", "e4,e5", text)]),
    );
    assert_eq!(written.applied.applied, 1);
    let id: i64 = store.value("SELECT max(id) FROM memories");
    assert_eq!(written.written, vec![format!("memory {id}")]);
    let row: (String, String, String, String, String, String, String, String) = store
        .db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT level, owner_id, category, origin_category, content, source_type, source_session_id, metadata_json
                   FROM memories WHERE id = ?1",
                [id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                    ))
                },
            )
        })
        .unwrap();
    assert_eq!(
        (
            &row.0[..],
            &row.1[..],
            &row.2[..],
            &row.3[..],
            &row.4[..],
            &row.5[..],
            &row.6[..]
        ),
        (
            "project",
            PROJECT,
            "swe:constraints",
            "CONSTRAINTS",
            text,
            "dreamer",
            CHILD
        )
    );
    let metadata: Value = serde_json::from_str(&row.7).unwrap();
    assert_eq!(
        metadata,
        json!({"source": "reflect-events", "run": RUN, "events": [4, 5]})
    );
    let origin: String = store.value(&format!(
        "SELECT origin_profile FROM memories WHERE id = {id}"
    ));
    assert_eq!(origin, "@cortexkit/memory-swe");
    // One history decision and one journal row name the run.
    let key: String = store
        .value("SELECT decision_key FROM memory_journal WHERE decision_key LIKE 'dream-run:%'");
    assert_eq!(key, format!("dream-run:{RUN}:reflect-events:0:0"));
    let history: i64 = store.value(&format!(
        "SELECT count(*) FROM memory_history WHERE memory_id = {id}"
    ));
    assert_eq!(history, 1);
    // Undoing the run archives what it wrote.
    let owner = OwnerRef {
        level: "project".into(),
        owner_id: PROJECT.into(),
    };
    store.db.with_connection(|conn| {
        let plan = person::plan_run_undo(conn, &owner, RUN).unwrap();
        assert!(plan.left.is_empty(), "{:?}", plan.left);
        person::undo_run(conn, &owner, RUN, &plan).unwrap();
    });
    let status: String = store.value(&format!("SELECT status FROM memories WHERE id = {id}"));
    assert_eq!(status, "archived");
}

#[test]
fn an_observation_joins_the_queue_the_global_review_reads() {
    let store = fixture();
    let batch = store.plan().remove(0);
    let text = "Wants a host restart announced before it happens.";
    let written = store.write(
        &batch,
        &learnings(&[learning("observation", "communication", "e4,e5", text)]),
    );
    assert_eq!(written.applied.applied, 1);
    let memories: i64 = store.value("SELECT count(*) FROM memories");
    assert_eq!(memories, 2, "an observation is not a memory");
    let row: (String, String, String, String, String, Option<i64>) = store
        .db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT content, proposed_category, session_id, project_id, origin_profile, consumed_at
                   FROM memory_observations",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
            )
        })
        .unwrap();
    assert_eq!(
        row,
        (
            text.into(),
            "COMMUNICATION".into(),
            CHILD.into(),
            PROJECT.into(),
            "@cortexkit/memory-swe".into(),
            None
        )
    );
    let pending = store
        .db
        .with_connection(|conn| {
            crate::dreamer::tasks::review_user_memories::pending_candidates(conn)
        })
        .unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].content, text);
    // An observation that repeats a live memory of the person is dropped.
    store.memory(9, "global", "", "COMMUNICATION", "Prefers short answers.");
    // The write above moved the watermark; read the same events again.
    store.set_watermark(3);
    let batch = store.plan().remove(0);
    let written = store.write(
        &batch,
        &learnings(&[learning(
            "observation",
            "COMMUNICATION",
            "e4,e5",
            "Prefers short answers.",
        )]),
    );
    assert_eq!(
        written.refusals,
        vec![Some("it repeats live memory 9".into())]
    );
}

// --- The watermark ---

#[test]
fn reflect_watermarks_preserve_the_legacy_event_id_with_or_without_a_resume() {
    assert_eq!(
        Watermark::read(json!({"event": 4})),
        Watermark {
            event: 4,
            resume: None
        }
    );
    let value = json!({"event": 4, "resume": {"through": 20, "done": [["incident", "ui"]]}});
    assert_eq!(value["event"].as_i64(), Some(4));
    assert_eq!(
        Watermark::read(value),
        Watermark {
            event: 4,
            resume: Some(Resume {
                through: 20,
                done: [("incident".to_owned(), "ui".to_owned())].into(),
            })
        }
    );
}

#[test]
fn a_reflect_run_that_stops_after_each_batch_reaches_the_end_without_resending_groups() {
    let store = store();
    let long = "x ".repeat(700);
    let mut stored = Vec::new();
    let surfaces = ["ui", "provider_sdk", "tool_protocol", "environment"];
    let summaries: Vec<String> = (0..120)
        .map(|index| format!("event {index} {long}"))
        .collect();
    for (index, summary) in summaries.iter().enumerate() {
        // Each surface gets every fourth event, on two days in turn.
        let day = 1 + (index as i64 / 4) % 2;
        stored.push(incident(
            index as i64 + 1,
            "ses-a",
            surfaces[index % 4],
            summary,
            day,
        ));
    }
    store.events(&stored);
    let batches = store.plan();
    assert!(batches.len() >= 2, "the groups need more than one message");
    assert_eq!(store.watermark(), None, "planning moves nothing");
    let planned = batches.len();
    let mut read = Vec::new();
    for _ in 0..planned {
        let batch = store.plan().remove(0);
        for group in &batch.groups {
            let value = group["value"].as_str().unwrap().to_owned();
            assert!(!read.contains(&value), "resent event group {value}");
            read.push(value);
        }
        store.write(&batch, "<learnings></learnings>");
    }
    assert_eq!(read.len(), 4);
    assert_eq!(store.watermark(), Some(json!({"event": 120})));
    // The next run has nothing new to send.
    assert!(store.plan().is_empty());
}

#[test]
fn a_run_without_a_group_worth_sending_moves_the_watermark_and_sends_nothing() {
    let store = fixture();
    // Only the correction, alone on its day, is new.
    store.set_watermark(5);
    assert!(store.plan().is_empty());
    assert_eq!(store.watermark(), Some(json!({"event": 6})));
    // Nothing new at all: nothing is sent and nothing moves.
    assert!(store.plan().is_empty());
    assert_eq!(store.watermark(), Some(json!({"event": 6})));
}

#[test]
fn an_accepted_reply_needs_a_complete_list() {
    let store = fixture();
    let batch = store.plan().remove(0);
    assert!(batch.accepts("<learnings></learnings>").is_ok());
    assert!(batch.accepts("I found no pattern.").is_err());
    let applied = store.db.with_connection(|conn| {
        let tx = conn.transaction().unwrap();
        let applied = batch
            .apply(
                &tx,
                &reply(&learnings(&[learning(
                    "memory",
                    "CONSTRAINTS",
                    "e4,e5",
                    "Plan for the host to restart the runner whenever its config changes.",
                )])),
                RUN,
            )
            .unwrap();
        tx.commit().unwrap();
        applied
    });
    assert_eq!((applied.proposed, applied.applied), (1, 1));
    assert_eq!(store.watermark(), Some(json!({"event": 6})));
}

/// A learning is captured for the user's other computers, as a memory or
/// as an observation, one outbox row each, named as the dreamer's when the
/// engine names it ([`crate::replica`]).
#[test]
fn a_learning_queues_one_outbox_row_for_what_it_writes() {
    use crate::replica::test_support::{assert_changes_captured, mark_sent, state};
    for (kind, category, text, expected) in [
        (
            "memory",
            "CONSTRAINTS",
            "Plan for the host to restart the runner whenever its config changes.",
            "memory:",
        ),
        (
            "observation",
            "communication",
            "Wants a host restart announced before it happens.",
            "observation:",
        ),
    ] {
        let store = fixture();
        let batch = store.plan().remove(0);
        let before = store.db.with_connection(|conn| {
            mark_sent(conn);
            state(conn)
        });
        let written = store.write(
            &batch,
            &learnings(&[learning(kind, category, "e4,e5", text)]),
        );
        assert_eq!(written.applied.applied, 1);
        let changed = store
            .db
            .with_connection(|conn| assert_changes_captured(conn, &before));
        assert_eq!(changed.len(), 1, "{changed:?}");
        assert!(changed[0].starts_with(expected), "{changed:?}");
    }
}
