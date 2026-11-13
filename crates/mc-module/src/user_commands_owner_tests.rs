//! The person's commands on memories, observations, the dreamer and notes,
//! through the module's real command entry point (`commands.preview` and
//! `commands.run` from Occipital), on a `context.db` at the module's schema
//! and a `mode3.db` that keeps their answers.

use super::*;
use crate::context_db::ContextDb;
use crate::memory_writes::{history_json, history_snapshot, record_history, History};
use cortexkit_role_user_commands as wire;
use rusqlite::{params, Connection};
use serde_json::json;
use std::collections::BTreeMap;
use std::sync::Arc;

const PROJECT: &str = "pj-owner";
const OTHER: &str = "pj-other";

fn occipital() -> subc_protocol::Principal {
    subc_protocol::Principal::Reserved {
        module_id: "occipital".into(),
    }
}

fn project() -> Value {
    json!({"kind": "project", "project_id": PROJECT})
}

fn computer() -> Value {
    json!({"kind": "computer"})
}

fn caller() -> Value {
    json!({"app": "desktop", "admission": "operator_app"})
}

/// A module with `context.db` and `mode3.db` in a folder of its own, and one
/// session of [`PROJECT`] set up, so the app reads (and these commands) know
/// the project.
struct Owner {
    dir: tempfile::TempDir,
    module: crate::module::Module<Client>,
}

impl Owner {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
        Self::open(dir)
    }

    fn open(dir: tempfile::TempDir) -> Self {
        let db = ContextDb::open(&dir.path().join("context.db")).unwrap();
        let store = crate::store::Store::open(&dir.path().join("mode3.db")).unwrap();
        let module = crate::module::Module::new(
            Client::default(),
            Settings::default(),
            Some(db),
            Some(store),
        );
        module.app_read().session_seen(
            &SessionRef::new("test", "mock", "s1"),
            &crate::route::Project {
                id: PROJECT.into(),
                root: dir.path().display().to_string(),
            },
            "head",
        );
        Self { dir, module }
    }

    /// Stop this module and start another on the same stores, as a restart
    /// of the module process does.
    fn restart(self) -> Self {
        let Owner { dir, module } = self;
        drop(module);
        Self::open(dir)
    }

    fn conn(&self) -> Connection {
        Connection::open(self.dir.path().join("context.db")).unwrap()
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value, wire::ErrorBody> {
        let body = serde_json::to_vec(&json!({"method": method, "params": params})).unwrap();
        self.module.command_request(&occipital(), &body).await
    }

    async fn preview(
        &self,
        id: &str,
        subject: Value,
        args: Value,
    ) -> Result<Value, wire::ErrorBody> {
        self.call(
            "commands.preview",
            json!({"id": id, "subject": subject, "args": args, "caller": caller()}),
        )
        .await
    }

    async fn run(
        &self,
        id: &str,
        subject: Value,
        args: Value,
        version: &str,
        request_id: &str,
    ) -> Result<Value, wire::ErrorBody> {
        self.call(
            "commands.run",
            json!({
                "id": id, "subject": subject, "args": args, "caller": caller(),
                "preview_version": version, "request_id": request_id,
            }),
        )
        .await
    }

    /// Preview a command that must be available, then run it.
    async fn apply(
        &self,
        id: &str,
        subject: Value,
        args: Value,
        request_id: &str,
    ) -> (Value, Value) {
        let preview = self
            .preview(id, subject.clone(), args.clone())
            .await
            .unwrap();
        assert_eq!(preview["available"], true, "{id}: {preview}");
        let version = preview["version"].as_str().unwrap().to_owned();
        let answer = self
            .run(id, subject, args, &version, request_id)
            .await
            .unwrap();
        (preview, answer)
    }

    async fn memory_get(&self, id: i64) -> Value {
        self.module
            .app_request("memories.get", json!({"id": id}))
            .await
            .unwrap()["memory"]
            .clone()
    }
}

/// Insert a live memory as a writer would have left it.
fn memory(
    conn: &Connection,
    level: &str,
    owner: &str,
    category: (&str, &str),
    content: &str,
) -> i64 {
    conn.execute(
        "INSERT INTO memories(level, owner_id, category, origin_category, content, normalized_hash,
                              importance, status, first_seen_at, created_at, updated_at, last_seen_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 50, 'active', 1, 1, 1, 1)",
        params![
            level,
            owner,
            category.0,
            category.1,
            content,
            crate::memory_writes::normalized_hash(content)
        ],
    )
    .unwrap();
    conn.last_insert_rowid()
}

const ARCHITECTURE: (&str, &str) = ("swe:architecture", "ARCHITECTURE");
const PREFERENCES: (&str, &str) = ("base:preferences", "PREFERENCES");

fn row(conn: &Connection, id: i64) -> Option<(String, String, Option<i64>, String, i64)> {
    use rusqlite::OptionalExtension;
    conn.query_row(
        "SELECT content, category, importance, status, revision FROM memories WHERE id = ?1",
        [id],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        },
    )
    .optional()
    .unwrap()
}

fn count(conn: &Connection, sql: &str, id: i64) -> i64 {
    conn.query_row(sql, [id], |row| row.get(0)).unwrap()
}

/// An agent's own update of a project memory, through its writer.
fn agent_update(conn: &mut Connection, id: i64, content: &str) {
    let revision: i64 = conn
        .query_row("SELECT revision FROM memories WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .unwrap();
    crate::memory_writes::mutate(
        conn,
        &crate::memory_writes::Writer {
            harness: "mock",
            session: "s1",
            project: PROJECT,
            authority: None,
        },
        &crate::memory_writes::Change {
            operation: crate::memory_writes::Operation::Update,
            targets: &[(id, revision)],
            content: Some(content),
            category: None,
            reason: None,
        },
    )
    .unwrap();
}

/// A finished dreamer run of the project that raised each memory's
/// importance to 95, recorded the way the dreamer's tasks record theirs: one
/// history decision keyed by the run, and its journal entry.
fn dream_run(conn: &mut Connection, ids: &[i64]) -> i64 {
    conn.execute(
        "INSERT INTO dream_task_runs(task, kind, level, owner_id, profile, started_at, ended_at, outcome, proposed, applied)
         VALUES ('swe:classify-memories', 'classify-memories', 'project', ?1, '@cortexkit/memory-swe', 10, 20, 'applied', ?2, ?2)",
        params![PROJECT, ids.len() as i64],
    )
    .unwrap();
    let run = conn.last_insert_rowid();
    let tx = conn.transaction().unwrap();
    let (mut before, mut after) = (Vec::new(), Vec::new());
    for id in ids {
        before.push(history_snapshot(&tx, *id).unwrap());
        tx.execute(
            "UPDATE memories SET importance = 95, revision = revision + 1 WHERE id = ?1",
            [id],
        )
        .unwrap();
        after.push(history_snapshot(&tx, *id).unwrap());
    }
    let key = format!("dream-run:{run}:0");
    let decision = record_history(
        &tx,
        &History {
            key: &key,
            project: PROJECT,
            writer: "dreamer",
            operation: "classify",
            reason: "classify-memories",
            now: 20,
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
         VALUES (?1, ?2, 'classify', '{}', 20, ?3, ?3)",
        params![PROJECT, key, history_json(&decision)],
    )
    .unwrap();
    tx.commit().unwrap();
    run
}

#[tokio::test]
async fn describe_declares_every_owner_command_with_its_subject_kind_and_effect() {
    let owner = Owner::new();
    let described: wire::DescribeReply =
        serde_json::from_value(owner.call("commands.describe", json!({})).await.unwrap()).unwrap();
    described.check().unwrap();
    let ids: Vec<&str> = described
        .commands
        .iter()
        .map(|command| command.id.as_str())
        .collect();
    let mut expected = vec!["flush", "status", "wrapup"];
    let per_level: Vec<String> = ["global", "workspace", "project", "agent"]
        .iter()
        .flat_map(|level| {
            ["edit", "archive", "restore", "delete", "undo"]
                .iter()
                .map(move |verb| format!("{level}_memory_{verb}"))
        })
        .collect();
    expected.extend(per_level.iter().map(String::as_str));
    expected.extend([
        "observation_promote",
        "observation_dismiss",
        "dreamer_run_now",
        "dreamer_undo_run",
        "note_edit",
        "note_dismiss",
        "note_delete",
    ]);
    assert_eq!(ids, expected);
    for command in &described.commands {
        let destroys = command.effects == ["destroys"];
        assert_eq!(
            destroys,
            command.id.ends_with("_delete"),
            "{}: {:?}",
            command.id,
            command.effects
        );
        let kind = match command.id.split('_').next().unwrap() {
            "flush" | "status" | "wrapup" => wire::SubjectKind::Session,
            "global" | "observation" => wire::SubjectKind::Computer,
            "workspace" => wire::SubjectKind::Workspace,
            "agent" => wire::SubjectKind::Agent,
            _ => wire::SubjectKind::Project,
        };
        assert_eq!(command.subject, kind, "{}", command.id);
    }
    // Each level's edit offers `keep` first, then only the categories that
    // level may hold, in profile order.
    let edit = described
        .commands
        .iter()
        .find(|command| command.id == "global_memory_edit")
        .unwrap();
    let category = edit.args.iter().find(|arg| arg.key == "category").unwrap();
    let values: Vec<&str> = category
        .options
        .as_ref()
        .unwrap()
        .iter()
        .map(|option| option.value.as_str())
        .collect();
    assert_eq!(
        values,
        [
            "keep",
            "base:communication",
            "base:preferences",
            "base:boundaries",
            "base:working-style",
            "base:identity",
            "swe:engineering-practice",
            "swe:dev-environment"
        ]
    );
    // A command no build declares is still refused by name.
    let refused = owner
        .preview("project_memory_shred", project(), json!({"ids": "1"}))
        .await
        .unwrap_err();
    assert_eq!(refused.code, wire::UNKNOWN_COMMAND);
}

#[tokio::test]
async fn edit_records_a_person_history_entry_and_undo_restores_the_row() {
    let owner = Owner::new();
    let conn = owner.conn();
    let id = memory(
        &conn,
        "project",
        PROJECT,
        ARCHITECTURE,
        "Views are immutable.",
    );
    let args = json!({"id": id, "content": "Views are immutable once offered.", "category": "swe:constraints", "importance": 70});
    let (preview, answer) = owner
        .apply("project_memory_edit", project(), args, "edit-1")
        .await;
    assert_eq!(preview["table"]["rows"][2]["cells"][1]["value"], 2.0);
    assert_eq!(answer["outcome"], "applied");
    assert_eq!(
        row(&conn, id).unwrap(),
        (
            "Views are immutable once offered.".into(),
            "swe:constraints".into(),
            Some(70),
            "active".into(),
            2
        )
    );
    let tag: String = conn
        .query_row(
            "SELECT origin_category FROM memories WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(tag, "CONSTRAINTS");
    let read = owner.memory_get(id).await;
    assert_eq!(read["history"][0]["writer"], "person");
    assert_eq!(read["history"][0]["revision"], 2);
    assert_eq!(read["history"][0]["before"], "Views are immutable.");
    // A preview with nothing to change says so.
    let same = owner
        .preview(
            "project_memory_edit",
            project(),
            json!({"id": id, "content": "Views are immutable once offered.", "category": "keep"}),
        )
        .await
        .unwrap();
    assert_eq!(same["reason"], "no_change");

    let (_, undone) = owner
        .apply(
            "project_memory_undo",
            project(),
            json!({"id": id, "revision": 2}),
            "undo-1",
        )
        .await;
    assert_eq!(undone["outcome"], "applied");
    assert_eq!(
        row(&conn, id).unwrap(),
        (
            "Views are immutable.".into(),
            "swe:architecture".into(),
            Some(50),
            "active".into(),
            3
        )
    );
    let read = owner.memory_get(id).await;
    assert_eq!(read["history"][0]["writer"], "person");
    assert_eq!(read["history"][0]["after"], "Views are immutable.");
    let unknown = owner
        .preview(
            "project_memory_undo",
            project(),
            json!({"id": id, "revision": 9}),
        )
        .await
        .unwrap();
    assert_eq!(unknown["reason"], "history_not_found");
}

#[tokio::test]
async fn archive_and_restore_count_what_they_skip_and_round_trip() {
    let owner = Owner::new();
    let conn = owner.conn();
    let a = memory(&conn, "project", PROJECT, ARCHITECTURE, "First rule.");
    let b = memory(&conn, "project", PROJECT, ARCHITECTURE, "Second rule.");
    conn.execute("UPDATE memories SET status = 'archived' WHERE id = ?1", [b])
        .unwrap();
    let ids = json!({"ids": format!("{a}, {b}")});
    let (preview, answer) = owner
        .apply(
            "project_memory_archive",
            project(),
            ids.clone(),
            "archive-1",
        )
        .await;
    assert_eq!(preview["facts"][0]["value"], 1.0);
    assert_eq!(preview["facts"][1]["label"], "Already archived");
    assert_eq!(preview["facts"][1]["value"], 1.0);
    assert_eq!(answer["facts"][0]["value"], 1.0);
    assert_eq!(row(&conn, a).unwrap().3, "archived");
    let again = owner
        .preview("project_memory_archive", project(), ids.clone())
        .await
        .unwrap();
    assert_eq!(again["reason"], "nothing_to_change");
    let (preview, _) = owner
        .apply("project_memory_restore", project(), ids, "restore-1")
        .await;
    assert_eq!(preview["facts"][0]["value"], 2.0);
    assert_eq!(row(&conn, a).unwrap().3, "active");
    assert_eq!(row(&conn, b).unwrap().3, "active");
    assert_eq!(owner.memory_get(a).await["history"][0]["writer"], "person");
}

#[tokio::test]
async fn subjects_must_hold_the_rows_they_name() {
    let owner = Owner::new();
    let conn = owner.conn();
    let mine = memory(&conn, "project", PROJECT, ARCHITECTURE, "Mine.");
    let theirs = memory(&conn, "project", OTHER, ARCHITECTURE, "Theirs.");
    let global = memory(
        &conn,
        "global",
        "self",
        PREFERENCES,
        "Prefers short replies.",
    );
    let unknown = owner
        .preview(
            "project_memory_archive",
            json!({"kind": "project", "project_id": "pj-never-seen"}),
            json!({"ids": mine.to_string()}),
        )
        .await
        .unwrap_err();
    assert_eq!(unknown.code, wire::UNKNOWN_SUBJECT);
    let refused = owner
        .preview(
            "agent_memory_archive",
            json!({"kind": "agent", "agent_id": "ag-none"}),
            json!({"ids": "1"}),
        )
        .await
        .unwrap_err();
    assert_eq!(refused.code, wire::UNKNOWN_SUBJECT);
    let refused = owner
        .preview(
            "project_memory_archive",
            project(),
            json!({"ids": format!("{mine},{theirs},{global}")}),
        )
        .await
        .unwrap_err();
    assert_eq!(refused.code, wire::INVALID_PARAMS);
    assert_eq!(
        refused.detail.as_ref().unwrap()["ids"],
        json!([theirs, global])
    );
    assert!(
        refused.message.contains(&theirs.to_string()),
        "{}",
        refused.message
    );
    let refused = owner
        .run(
            "project_memory_delete",
            project(),
            json!({"ids": theirs.to_string()}),
            "any",
            "delete-theirs",
        )
        .await
        .unwrap_err();
    assert_eq!(refused.code, wire::INVALID_PARAMS);
    assert!(row(&conn, theirs).is_some());
    // The person's own memories are the computer's.
    let (_, answer) = owner
        .apply(
            "global_memory_archive",
            computer(),
            json!({"ids": global.to_string()}),
            "g1",
        )
        .await;
    assert_eq!(answer["outcome"], "applied");
    // A workspace or agent is known by its memories.
    let workspace = memory(&conn, "workspace", "ws-1", ARCHITECTURE, "Shared rule.");
    let (_, answer) = owner
        .apply(
            "workspace_memory_archive",
            json!({"kind": "workspace", "workspace_id": "ws-1"}),
            json!({"ids": workspace.to_string()}),
            "w1",
        )
        .await;
    assert_eq!(answer["outcome"], "applied");
    // A category the level may not hold is refused before the person confirms.
    let refused = owner
        .preview(
            "project_memory_edit",
            project(),
            json!({"id": mine, "category": "base:identity"}),
        )
        .await
        .unwrap_err();
    assert_eq!(refused.code, wire::INVALID_PARAMS);
    // Ids are a comma-separated list of 1 to 200 distinct positive ids.
    for ids in [
        "",
        "0",
        "1,1",
        "a",
        &(1..=201)
            .map(|n| n.to_string())
            .collect::<Vec<_>>()
            .join(","),
    ] {
        let refused = owner
            .preview("project_memory_archive", project(), json!({"ids": ids}))
            .await
            .unwrap_err();
        assert_eq!(
            refused.detail.as_ref().unwrap()["field"],
            "args.ids",
            "{ids}"
        );
    }
}

#[tokio::test]
async fn a_preview_moves_only_with_its_rows_and_a_stale_run_changes_nothing() {
    let owner = Owner::new();
    let mut conn = owner.conn();
    let target = memory(&conn, "project", PROJECT, ARCHITECTURE, "Target.");
    let bystander = memory(&conn, "project", PROJECT, ARCHITECTURE, "Bystander.");
    let args = json!({"ids": target.to_string()});
    let first = owner
        .preview("project_memory_archive", project(), args.clone())
        .await
        .unwrap();
    agent_update(&mut conn, bystander, "Bystander, edited.");
    conn.execute(
        "UPDATE memories SET seen_count = 9, retrieval_count = 4, last_seen_at = 99 WHERE id = ?1",
        [target],
    )
    .unwrap();
    let second = owner
        .preview("project_memory_archive", project(), args.clone())
        .await
        .unwrap();
    assert_eq!(first["version"], second["version"]);
    agent_update(&mut conn, target, "Target, edited.");
    let third = owner
        .preview("project_memory_archive", project(), args.clone())
        .await
        .unwrap();
    assert_ne!(first["version"], third["version"]);
    let stale = owner
        .run(
            "project_memory_archive",
            project(),
            args,
            first["version"].as_str().unwrap(),
            "stale-1",
        )
        .await
        .unwrap();
    assert_eq!(stale["outcome"], "preview_stale");
    assert_eq!(row(&conn, target).unwrap().3, "active");
}

#[tokio::test]
async fn a_retried_request_after_a_restart_replays_its_answer_without_acting_again() {
    let owner = Owner::new();
    let conn = owner.conn();
    let id = memory(&conn, "project", PROJECT, ARCHITECTURE, "Replayed.");
    let args = json!({"id": id, "importance": 80});
    let preview = owner
        .preview("project_memory_edit", project(), args.clone())
        .await
        .unwrap();
    let version = preview["version"].as_str().unwrap().to_owned();
    let first = owner
        .run(
            "project_memory_edit",
            project(),
            args.clone(),
            &version,
            "once-1",
        )
        .await
        .unwrap();
    assert_eq!(first["outcome"], "applied");
    drop(conn);
    let owner = owner.restart();
    let conn = owner.conn();
    let again = owner
        .run(
            "project_memory_edit",
            project(),
            args.clone(),
            &version,
            "once-1",
        )
        .await
        .unwrap();
    assert_eq!(again, first);
    assert_eq!(row(&conn, id).unwrap().4, 2, "the edit ran once");
    assert_eq!(
        count(
            &conn,
            "SELECT COUNT(*) FROM memory_history WHERE memory_id = ?1",
            id
        ),
        1
    );
    // A new request id with the old preview is a new run, refused as stale.
    let fresh = owner
        .run(
            "project_memory_edit",
            project(),
            args.clone(),
            &version,
            "once-2",
        )
        .await
        .unwrap();
    assert_eq!(fresh["outcome"], "preview_stale");
    // The same id with another body is a conflict.
    let conflict = owner
        .run(
            "project_memory_edit",
            project(),
            json!({"id": id, "importance": 81}),
            &version,
            "once-1",
        )
        .await
        .unwrap();
    assert_eq!(conflict["outcome"], "request_conflict");
    // The same id on another subject is a different run.
    let global = memory(
        &conn,
        "global",
        "self",
        PREFERENCES,
        "Prefers short replies.",
    );
    let (_, other) = owner
        .apply(
            "global_memory_archive",
            computer(),
            json!({"ids": global.to_string()}),
            "once-1",
        )
        .await;
    assert_eq!(other["outcome"], "applied");
    // Answers older than a day are gone.
    let store = Connection::open(owner.dir.path().join("mode3.db")).unwrap();
    store
        .execute(
            "UPDATE owner_command_answers SET stored_at = stored_at - 86400001",
            [],
        )
        .unwrap();
    let expired = owner
        .run("project_memory_edit", project(), args, &version, "once-1")
        .await
        .unwrap();
    assert_eq!(expired["outcome"], "preview_stale");
}

#[tokio::test]
async fn delete_removes_the_memory_and_everything_derived_from_its_text() {
    let owner = Owner::new();
    let mut conn = owner.conn();
    let id = memory(
        &conn,
        "project",
        PROJECT,
        ARCHITECTURE,
        "Secret marker zebra.",
    );
    let kept = memory(&conn, "project", PROJECT, ARCHITECTURE, "Kept marker.");
    agent_update(&mut conn, id, "Secret marker zebra, revised.");
    let run = dream_run(&mut conn, &[id, kept]);
    conn.execute(
        "INSERT INTO memory_embeddings(memory_id, embedding, model_id) VALUES (?1, x'00', 'model')",
        [id],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO memory_clause_evidence(memory_id, revision, clause_ordinal, text_hash, evidence_json)
         VALUES (?1, 3, 0, 'h', '{\"quote\":\"Secret marker zebra\"}')",
        [id],
    )
    .unwrap();
    assert_eq!(
        count(
            &conn,
            "SELECT COUNT(*) FROM memories_fts WHERE memories_fts MATCH 'zebra' AND ?1 > 0",
            1
        ),
        1
    );
    let (preview, answer) = owner
        .apply(
            "project_memory_delete",
            project(),
            json!({"ids": id.to_string()}),
            "delete-1",
        )
        .await;
    assert_eq!(preview["facts"][1]["label"], "History entries");
    assert_eq!(preview["facts"][1]["value"], 2.0);
    assert_eq!(answer["facts"][0]["value"], 1.0);
    assert!(row(&conn, id).is_none());
    for table in [
        "memory_history",
        "memory_embeddings",
        "memory_clause_evidence",
        "memory_classification_items",
        "memory_applied_rows",
    ] {
        assert_eq!(
            count(
                &conn,
                &format!("SELECT COUNT(*) FROM {table} WHERE memory_id = ?1"),
                id
            ),
            0,
            "{table}"
        );
    }
    assert_eq!(
        count(
            &conn,
            "SELECT COUNT(*) FROM memories_fts WHERE memories_fts MATCH 'zebra' AND ?1 > 0",
            1
        ),
        0
    );
    let leaks: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM memory_journal
              WHERE instr(COALESCE(before_json, '') || COALESCE(after_json, '') || receipt_json, 'zebra') > 0",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(leaks, 0, "no journal row keeps the deleted text");
    // The dreamer run still names the memory it changed, by id only.
    let read = owner
        .module
        .app_request("dreamer.run", json!({"id": run}))
        .await
        .unwrap();
    assert_eq!(read["run"]["changed_memory_ids"], json!([id, kept]));
    assert_eq!(read["run"]["changes"]["written"], 2);
    assert!(row(&conn, kept).is_some());
    let gone = owner
        .module
        .app_request("memories.get", json!({"id": id}))
        .await;
    assert_eq!(gone.unwrap_err().code, "memory_not_found");
}

#[tokio::test]
async fn undo_run_reverts_the_run_and_names_a_memory_changed_after_it() {
    let owner = Owner::new();
    let mut conn = owner.conn();
    let a = memory(&conn, "project", PROJECT, ARCHITECTURE, "Run changed me.");
    let b = memory(
        &conn,
        "project",
        PROJECT,
        ARCHITECTURE,
        "Run changed me too.",
    );
    let run = dream_run(&mut conn, &[a, b]);
    agent_update(&mut conn, b, "Then an agent changed me.");
    let args = json!({"run_id": run});
    let (preview, answer) = owner
        .apply("dreamer_undo_run", project(), args.clone(), "undo-run-1")
        .await;
    assert_eq!(preview["facts"][0]["value"], 1.0);
    assert_eq!(preview["facts"][1]["value"], 1.0);
    assert_eq!(
        preview["table"]["rows"][1],
        json!({"label": format!("Memory {b} changed after the run"), "cells": [{"state": "stale"}]})
    );
    assert_eq!(answer["outcome"], "applied");
    assert_eq!(
        answer["facts"][2]["label"],
        format!("Memory {b} changed after the run")
    );
    assert_eq!(answer["facts"][2]["state"], "stale");
    assert_eq!(row(&conn, a).unwrap().2, Some(50));
    assert_eq!(row(&conn, a).unwrap().4, 3);
    let b_now = row(&conn, b).unwrap();
    assert_eq!(b_now.0, "Then an agent changed me.");
    assert_eq!(b_now.2, Some(95));
    assert_eq!(owner.memory_get(a).await["history"][0]["writer"], "person");
    let again = owner
        .preview("dreamer_undo_run", project(), args)
        .await
        .unwrap();
    assert_eq!(again["reason"], "nothing_to_undo");
    let other = owner
        .preview("dreamer_undo_run", project(), json!({"run_id": run + 10}))
        .await
        .unwrap_err();
    assert_eq!(other.detail.unwrap()["ids"], json!([run + 10]));
}

#[tokio::test]
async fn observations_promote_to_a_global_memory_or_leave_review() {
    let owner = Owner::new();
    let conn = owner.conn();
    for content in ["Likes terse answers.", "Works late.", "Uses vim."] {
        conn.execute(
            "INSERT INTO memory_observations(content, proposed_category, session_id, project_id, created_at)
             VALUES (?1, 'base:preferences', 's1', ?2, 5)",
            params![content, PROJECT],
        )
        .unwrap();
    }
    let (_, answer) = owner
        .apply(
            "observation_promote",
            computer(),
            json!({"id": 1, "category": "base:preferences"}),
            "promote-1",
        )
        .await;
    let memory_id = answer["facts"][1]["value"].as_f64().unwrap() as i64;
    let (content, category, _, status, _) = row(&conn, memory_id).unwrap();
    assert_eq!(
        (content.as_str(), category.as_str(), status.as_str()),
        ("Likes terse answers.", "base:preferences", "active")
    );
    let read = owner.memory_get(memory_id).await;
    assert_eq!(read["level"], "global");
    assert_eq!(read["history"][0]["writer"], "person");
    let again = owner
        .preview(
            "observation_promote",
            computer(),
            json!({"id": 1, "category": "base:preferences"}),
        )
        .await
        .unwrap();
    assert_eq!(again["reason"], "already_reviewed");
    let (preview, answer) = owner
        .apply(
            "observation_dismiss",
            computer(),
            json!({"ids": "1,2,3"}),
            "dismiss-1",
        )
        .await;
    assert_eq!(preview["facts"][0]["value"], 2.0);
    assert_eq!(answer["facts"][0]["value"], 2.0);
    let pending: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM memory_observations WHERE consumed_at IS NULL",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(pending, 0);
    let missing = owner
        .preview("observation_dismiss", computer(), json!({"ids": "9"}))
        .await
        .unwrap_err();
    assert_eq!(missing.detail.unwrap()["ids"], json!([9]));
}

fn note(conn: &Connection, project: &str, content: &str) -> i64 {
    conn.execute(
        "INSERT INTO notes(type, status, content, session_id, harness, project_path, created_at, updated_at)
         VALUES ('session', 'active', ?1, 's1', 'mock', ?2, 5, 5)",
        params![content, project],
    )
    .unwrap();
    conn.last_insert_rowid()
}

#[tokio::test]
async fn notes_are_edited_dismissed_and_deleted_within_their_project() {
    let owner = Owner::new();
    let conn = owner.conn();
    let a = note(&conn, PROJECT, "Check the fold.");
    let b = note(&conn, PROJECT, "Ask about caching.");
    let theirs = note(&conn, OTHER, "Not this project's.");
    owner
        .apply(
            "note_edit",
            project(),
            json!({"id": a, "content": "Check the fold twice."}),
            "n1",
        )
        .await;
    let text: String = conn
        .query_row("SELECT content FROM notes WHERE id = ?1", [a], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(text, "Check the fold twice.");
    owner
        .apply(
            "note_dismiss",
            project(),
            json!({"ids": format!("{a},{b}")}),
            "n2",
        )
        .await;
    let dismissed: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM notes WHERE status = 'dismissed'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(dismissed, 2);
    owner
        .apply(
            "note_delete",
            project(),
            json!({"ids": b.to_string()}),
            "n3",
        )
        .await;
    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM notes WHERE id = ?1", b),
        0
    );
    let refused = owner
        .preview("note_delete", project(), json!({"ids": theirs.to_string()}))
        .await
        .unwrap_err();
    assert_eq!(refused.detail.unwrap()["ids"], json!([theirs]));
}

/// Show the module's dreamer the project, as a session's Setup does, with
/// its schedule rows at a fixed due time so previews don't follow the clock.
fn dreamer_sees_the_project(owner: &Owner) {
    let db = ContextDb::open(&owner.dir.path().join("context.db")).unwrap();
    let engine = owner
        .module
        .dreamer_engine()
        .expect("a dreamer with context.db");
    engine.see_project(
        &db,
        PROJECT,
        &owner.dir.path().display().to_string(),
        Arc::new(crate::memory_profile::bundled_swe().unwrap()),
        &crate::dreamer::engine::Settings::default(),
        1,
    );
    owner
        .conn()
        .execute(
            "UPDATE dream_schedules SET next_due_at = 4102444800000 WHERE owner_id = ?1",
            [PROJECT],
        )
        .unwrap();
}

/// Wait for a dreamer run started in the background to end.
async fn run_ended(conn: &Connection, run: i64) -> String {
    for _ in 0..200 {
        let outcome: Option<String> = conn
            .query_row(
                "SELECT outcome FROM dream_task_runs WHERE id = ?1 AND ended_at IS NOT NULL",
                [run],
                |row| row.get(0),
            )
            .unwrap_or(None);
        if let Some(outcome) = outcome {
            return outcome;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    panic!("dreamer run {run} did not end");
}

/// Wait until the project's lock is released.
async fn unlocked(conn: &Connection) {
    for _ in 0..200 {
        let held: i64 = conn
            .query_row("SELECT COUNT(*) FROM dream_locks", [], |row| row.get(0))
            .unwrap();
        if held == 0 {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    panic!("the project's lock was not released");
}

#[tokio::test]
async fn dreamer_run_now_starts_a_counted_run_unless_the_lock_is_held() {
    let owner = Owner::new();
    let conn = owner.conn();
    let args = json!({"task": "classify-memories"});
    let unseen = owner
        .preview("dreamer_run_now", project(), args.clone())
        .await
        .unwrap();
    assert_eq!(unseen["reason"], "project_not_seen");
    dreamer_sees_the_project(&owner);
    conn.execute(
        "INSERT INTO dream_locks(level, owner_id, holder, task, acquired_at, expires_at)
         VALUES ('project', ?1, 'ck-mc:other', 'swe:curate', 1, 4102444800000)",
        [PROJECT],
    )
    .unwrap();
    let locked = owner
        .preview("dreamer_run_now", project(), args.clone())
        .await
        .unwrap();
    assert_eq!(locked["available"], false);
    assert_eq!(locked["reason"], "locked");
    conn.execute("DELETE FROM dream_locks", []).unwrap();
    let (preview, answer) = owner
        .apply("dreamer_run_now", project(), args.clone(), "now-1")
        .await;
    assert_ne!(preview["version"], locked["version"]);
    assert_eq!(answer["outcome"], "started");
    let run = answer["facts"][0]["value"].as_f64().unwrap() as i64;
    // No memory needs classifying, so the run has nothing to do; it settles
    // the task's schedule as a scheduled run would.
    assert_eq!(run_ended(&conn, run).await, "nothing_to_do");
    unlocked(&conn).await;
    let (status, last_run_at, failures): (String, Option<i64>, i64) = conn
        .query_row(
            "SELECT last_status, last_run_at, failures FROM dream_schedules
              WHERE owner_id = ?1 AND task = 'swe:classify-memories'",
            [PROJECT],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(status, "nothing_to_do");
    assert!(last_run_at.is_some());
    assert_eq!(failures, 0);
    // The old preview names the run that is now done: a repeat is stale.
    let stale = owner
        .run(
            "dreamer_run_now",
            project(),
            args,
            preview["version"].as_str().unwrap(),
            "now-2",
        )
        .await
        .unwrap();
    assert_eq!(stale["outcome"], "preview_stale");
}

/// The wire bodies apps can build against, from these handlers on a
/// synthetic store. Regenerate with `MC_UPDATE_USER_COMMAND_SAMPLES=1`.
#[tokio::test]
async fn owner_commands_record_real_handler_samples() {
    use sha2::{Digest, Sha256};
    let owner = Owner::new();
    let mut conn = owner.conn();
    let edit = memory(
        &conn,
        "project",
        PROJECT,
        ARCHITECTURE,
        "Views are immutable once offered.",
    );
    let archive = memory(
        &conn,
        "project",
        PROJECT,
        ARCHITECTURE,
        "The cut moves only on a rebuild.",
    );
    let restore = memory(
        &conn,
        "project",
        PROJECT,
        ARCHITECTURE,
        "Folds re-tier summaries.",
    );
    conn.execute(
        "UPDATE memories SET status = 'archived' WHERE id = ?1",
        [restore],
    )
    .unwrap();
    let delete = memory(
        &conn,
        "project",
        PROJECT,
        ARCHITECTURE,
        "The 0.49 transform ran in the host.",
    );
    let undo = memory(
        &conn,
        "project",
        PROJECT,
        ARCHITECTURE,
        "Summaries publish without a rebuild.",
    );
    agent_update(
        &mut conn,
        undo,
        "Summaries publish without forcing a rebuild.",
    );
    let global = memory(
        &conn,
        "global",
        "self",
        PREFERENCES,
        "Prefers short answers.",
    );
    let workspace = memory(&conn, "workspace", "ws-1", ARCHITECTURE, "Shared rule.");
    let agent = memory(
        &conn,
        "agent",
        "ag-1",
        ("base:communication", "COMMUNICATION"),
        "Answers in English.",
    );
    let restored = memory(
        &conn,
        "project",
        PROJECT,
        ARCHITECTURE,
        "Classified by the dreamer.",
    );
    let left = memory(
        &conn,
        "project",
        PROJECT,
        ARCHITECTURE,
        "Classified, then edited.",
    );
    let run = dream_run(&mut conn, &[restored, left]);
    agent_update(&mut conn, left, "Classified, then edited by an agent.");
    for content in ["Likes terse answers.", "Works late."] {
        conn.execute(
            "INSERT INTO memory_observations(content, proposed_category, session_id, project_id, created_at)
             VALUES (?1, 'base:preferences', 's1', ?2, 5)",
            params![content, PROJECT],
        )
        .unwrap();
    }
    let note_edit = note(&conn, PROJECT, "Check the fold.");
    let note_dismiss = note(&conn, PROJECT, "Ask about caching.");
    let note_delete = note(&conn, PROJECT, "Old reminder.");

    let mut samples: BTreeMap<String, Value> = BTreeMap::new();
    samples.insert(
        "describe.json".into(),
        owner.call("commands.describe", json!({})).await.unwrap(),
    );
    let cases: Vec<(&str, Value, Value)> = vec![
        (
            "project_memory_edit",
            project(),
            json!({"id": edit, "content": "Views are immutable once the runner has them.", "importance": 80}),
        ),
        (
            "project_memory_archive",
            project(),
            json!({"ids": archive.to_string()}),
        ),
        (
            "project_memory_restore",
            project(),
            json!({"ids": restore.to_string()}),
        ),
        (
            "project_memory_delete",
            project(),
            json!({"ids": delete.to_string()}),
        ),
        (
            "project_memory_undo",
            project(),
            json!({"id": undo, "revision": 2}),
        ),
        (
            "global_memory_edit",
            computer(),
            json!({"id": global, "category": "base:communication"}),
        ),
        (
            "workspace_memory_archive",
            json!({"kind": "workspace", "workspace_id": "ws-1"}),
            json!({"ids": workspace.to_string()}),
        ),
        (
            "agent_memory_delete",
            json!({"kind": "agent", "agent_id": "ag-1"}),
            json!({"ids": agent.to_string()}),
        ),
        (
            "observation_promote",
            computer(),
            json!({"id": 1, "category": "base:preferences"}),
        ),
        ("observation_dismiss", computer(), json!({"ids": "2"})),
        ("dreamer_undo_run", project(), json!({"run_id": run})),
        (
            "note_edit",
            project(),
            json!({"id": note_edit, "content": "Check the fold twice."}),
        ),
        (
            "note_dismiss",
            project(),
            json!({"ids": note_dismiss.to_string()}),
        ),
        (
            "note_delete",
            project(),
            json!({"ids": note_delete.to_string()}),
        ),
    ];
    for (id, subject, args) in cases {
        let name = id.replace('_', "-");
        let (preview, answer) = owner
            .apply(id, subject, args, &format!("sample-{name}"))
            .await;
        samples.insert(format!("{name}-preview.json"), preview);
        samples.insert(format!("{name}-run.json"), answer);
    }
    dreamer_sees_the_project(&owner);
    conn.execute(
        "INSERT INTO dream_locks(level, owner_id, holder, task, acquired_at, expires_at)
         VALUES ('project', ?1, 'ck-mc:other', 'swe:curate', 1, 4102444800000)",
        [PROJECT],
    )
    .unwrap();
    let task = json!({"task": "classify-memories"});
    samples.insert(
        "dreamer-run-now-preview-locked.json".into(),
        owner
            .preview("dreamer_run_now", project(), task.clone())
            .await
            .unwrap(),
    );
    conn.execute("DELETE FROM dream_locks", []).unwrap();
    let (preview, answer) = owner
        .apply("dreamer_run_now", project(), task, "sample-dreamer-run-now")
        .await;
    let started = answer["facts"][0]["value"].as_f64().unwrap() as i64;
    run_ended(&conn, started).await;
    unlocked(&conn).await;
    samples.insert("dreamer-run-now-preview.json".into(), preview);
    samples.insert("dreamer-run-now-run.json".into(), answer);
    let to_value = |error: wire::ErrorBody| serde_json::to_value(error).unwrap();
    samples.insert(
        "unknown-subject.json".into(),
        to_value(
            owner
                .preview(
                    "project_memory_archive",
                    json!({"kind": "project", "project_id": "pj-never-seen"}),
                    json!({"ids": archive.to_string()}),
                )
                .await
                .unwrap_err(),
        ),
    );
    samples.insert(
        "not-in-subject.json".into(),
        to_value(
            owner
                .preview(
                    "workspace_memory_archive",
                    json!({"kind": "workspace", "workspace_id": "ws-1"}),
                    json!({"ids": format!("{workspace},{edit}")}),
                )
                .await
                .unwrap_err(),
        ),
    );
    let stale_args = json!({"ids": archive.to_string()});
    let old = owner
        .preview("project_memory_restore", project(), stale_args.clone())
        .await
        .unwrap();
    owner
        .apply(
            "project_memory_restore",
            project(),
            stale_args.clone(),
            "sample-restore-again",
        )
        .await;
    samples.insert(
        "preview-stale.json".into(),
        owner
            .run(
                "project_memory_restore",
                project(),
                stale_args,
                old["version"].as_str().unwrap(),
                "sample-stale",
            )
            .await
            .unwrap(),
    );
    let dir = std::env::var_os("MC_USER_COMMAND_SAMPLES_V2_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("testdata/mc-user-commands-samples-v2")
        });
    let update = std::env::var_os("MC_UPDATE_USER_COMMAND_SAMPLES").is_some();
    if update {
        std::fs::create_dir_all(&dir).unwrap();
    }
    let mut sums = String::new();
    for (name, body) in &samples {
        let bytes = format!("{}\n", serde_json::to_string_pretty(body).unwrap());
        sums.push_str(&format!("{:x}  {name}\n", Sha256::digest(bytes.as_bytes())));
        if update {
            std::fs::write(dir.join(name), &bytes).unwrap();
        }
        assert_eq!(
            std::fs::read_to_string(dir.join(name)).unwrap_or_default(),
            bytes,
            "{name}"
        );
    }
    if update {
        std::fs::write(dir.join("SHA256SUMS"), &sums).unwrap();
    }
    assert_eq!(
        std::fs::read_to_string(dir.join("SHA256SUMS")).unwrap_or_default(),
        sums
    );
}
