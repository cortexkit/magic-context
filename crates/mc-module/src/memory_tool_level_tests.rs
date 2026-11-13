//! `ctx_memory`'s `level` argument: where a write goes, and which memories a
//! session may change by id.

use serde_json::{json, Value};

use super::*;
use crate::memory_context::ContextAnswer;
use crate::memory_levels::Authority;
use crate::memory_profile::MemoryContext;

/// The session's project, as its memories name it.
const PROJECT: &str = "pj-a";
/// The workspace Entorhinal's recorded answer puts the project in.
const WORKSPACE: &str = "served-workspace";
/// Entorhinal's id for the project in that answer.
const PROJECT_ID: &str = "served-project";

fn database() -> (tempfile::TempDir, Connection) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("context.db");
    drop(crate::context_db::ContextDb::create_for_tests(&path).unwrap());
    let conn = Connection::open(path).unwrap();
    (dir, conn)
}

/// The memory context Entorhinal's recorded answer gives a project in a
/// workspace with no domain: the bundled coding profile.
fn context() -> MemoryContext {
    let records: Vec<Value> = serde_json::from_str(include_str!(
        "../testdata/entorhinal-memory-context-v1/context-project.json"
    ))
    .unwrap();
    let mut result = records[0]["reply"]["result"].clone();
    result["domain"] = Value::Null;
    let project = serde_json::from_value(result).unwrap();
    crate::memory_profile::resolve(
        &ContextAnswer::Answer(project),
        &ContextAnswer::NotAnswering,
        &[],
    )
}

fn authority() -> Authority {
    let authority = Authority::from_context(&context()).unwrap();
    assert_eq!(authority.workspace_id.as_deref(), Some(WORKSPACE));
    assert_eq!(authority.project_id.as_deref(), Some(PROJECT_ID));
    authority
}

fn writer(authority: Option<&Authority>) -> Writer<'_> {
    Writer {
        harness: "mode3",
        session: "s1",
        project: PROJECT,
        authority,
    }
}

fn write(content: &str, category: &str, level: Option<&str>) -> Value {
    let mut input = json!({"action": "write", "content": content, "category": category, "ids": []});
    if let Some(level) = level {
        input["level"] = json!(level);
    }
    input
}

fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |row| row.get(0)).unwrap()
}

fn id_of(conn: &Connection, content: &str) -> i64 {
    conn.query_row(
        "SELECT id FROM memories WHERE content = ?1",
        [content],
        |row| row.get(0),
    )
    .unwrap()
}

/// Where a memory is filed: level, owner, source project, category id, tag
/// and status.
fn placed(conn: &Connection, id: i64) -> (String, String, Option<String>, String, String, String) {
    conn.query_row(
        "SELECT level, owner_id, source_project_id, category, origin_category, status
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
            ))
        },
    )
    .unwrap()
}

fn workspace_changed(workspace: &str) -> Change {
    Change::Memories {
        level: "workspace".into(),
        owner: workspace.into(),
    }
}

/// A write with no level, an empty one or `project` is the write the tool
/// always made, even for a session whose project is in a workspace.
#[test]
fn a_write_without_a_level_is_the_project_write_it_always_was() {
    let (_dir, mut conn) = database();
    let authority = authority();
    let who = writer(Some(&authority));
    for (n, level) in [None, Some(""), Some("project")].into_iter().enumerate() {
        let content = format!("Views are numbered from one ({n}).");
        let input = write(&content, "NAMING", level);
        let reply = call(&mut conn, &who, &input, Some(7)).unwrap();
        let id = id_of(&conn, &content);
        assert_eq!(reply.text, format!("Saved memory [ID: {id}] in NAMING."));
        assert_eq!(reply.changed, vec![Change::project_memories(PROJECT)]);
        assert_eq!(
            placed(&conn, id),
            (
                "project".into(),
                PROJECT.into(),
                Some(PROJECT.into()),
                "swe:naming".into(),
                "NAMING".into(),
                "active".into()
            )
        );
        let again = call(&mut conn, &who, &input, Some(7)).unwrap();
        assert_eq!(
            again.text,
            format!("Memory already exists [ID: {id}] in NAMING (seen count incremented).")
        );
        assert_eq!(run(&mut conn, &who, &input).unwrap(), again.text);
    }
    assert_eq!(count(&conn, "SELECT count(*) FROM memories"), 3);
    assert_eq!(count(&conn, "SELECT count(*) FROM memory_observations"), 0);
}

/// The profile's `allowed_levels` reach the writer through its memory
/// context.
#[test]
fn the_profile_decides_which_categories_may_be_filed_at_the_workspace() {
    let authority = authority();
    assert!(authority.allows("swe:naming", "workspace"));
    assert!(authority.allows("swe:constraints", "project"));
    assert!(!authority.allows("base:identity", "workspace"));
    assert!(authority.allows("base:identity", "global"));
    assert!(!authority.allows("mc:unmapped", "workspace"));
}

/// A workspace write is owned by the session's workspace, names the
/// session's project as its source, and is read by the head as one of the
/// workspace's memories.
#[test]
fn a_workspace_write_belongs_to_the_workspace_and_names_its_project() {
    let (_dir, mut conn) = database();
    let authority = authority();
    let who = writer(Some(&authority));
    let content = "Every member pins the same Rust toolchain.";
    let input = write(content, "CONSTRAINTS", Some("workspace"));
    let reply = call(&mut conn, &who, &input, None).unwrap();
    let id = id_of(&conn, content);
    assert_eq!(
        reply.text,
        format!("Saved workspace memory [ID: {id}] in CONSTRAINTS.")
    );
    assert_eq!(reply.changed, vec![workspace_changed(WORKSPACE)]);
    assert_eq!(
        placed(&conn, id),
        (
            "workspace".into(),
            WORKSPACE.into(),
            Some(PROJECT.into()),
            "swe:constraints".into(),
            "CONSTRAINTS".into(),
            "active".into()
        )
    );
    // The same text again is the same workspace memory, journaled like a
    // project save.
    let again = call(&mut conn, &who, &input, None).unwrap();
    assert_eq!(
        again.text,
        format!(
            "Workspace memory already exists [ID: {id}] in CONSTRAINTS (seen count incremented)."
        )
    );
    assert_eq!(
        count(
            &conn,
            "SELECT count(*) FROM memory_journal WHERE operation = 'agent_save'"
        ),
        2
    );
    // The project's own memories are another owner's: the same text there
    // is a new project memory.
    call(&mut conn, &who, &write(content, "CONSTRAINTS", None), None).unwrap();
    assert_eq!(
        count(
            &conn,
            "SELECT count(*) FROM memories WHERE level = 'project' AND owner_id = 'pj-a'"
        ),
        1
    );
    let rows = crate::head_memories::read_rows(
        &conn,
        Some(PROJECT),
        Some(WORKSPACE),
        memory_writes::now_ms(),
    )
    .unwrap();
    let row = rows.iter().find(|row| row.id == id).unwrap();
    assert_eq!(row.level, "workspace");
    assert_eq!(row.source_project.as_deref(), Some(PROJECT));
}

/// A workspace write needs the session's workspace and project, and a
/// category the session's profile allows there; a refusal saves nothing.
#[test]
fn a_workspace_write_is_refused_without_a_workspace_a_project_or_an_allowed_category() {
    let (_dir, mut conn) = database();
    let input = write("Every member builds offline.", "NAMING", Some("workspace"));

    let mut alone = authority();
    alone.workspace_id = None;
    let no_workspace = "Error: This session's project is in no workspace; memory was not saved.";
    assert_eq!(
        call(&mut conn, &writer(Some(&alone)), &input, None).unwrap_err(),
        no_workspace
    );
    // A session with no memory context knows no workspace either.
    assert_eq!(
        call(&mut conn, &writer(None), &input, None).unwrap_err(),
        no_workspace
    );

    let no_project = "Error: A workspace memory needs the session's project, and this session has none; memory was not saved.";
    let authority = authority();
    let nameless = Writer {
        project: "",
        ..writer(Some(&authority))
    };
    assert_eq!(
        call(&mut conn, &nameless, &input, None).unwrap_err(),
        no_project
    );
    let mut unnamed = authority.clone();
    unnamed.project_id = None;
    assert_eq!(
        call(&mut conn, &writer(Some(&unnamed)), &input, None).unwrap_err(),
        no_project
    );

    // A profile whose naming category stays at the project level.
    let mut narrow = authority.clone();
    narrow
        .category_levels
        .insert("swe:naming".into(), vec!["project".into()]);
    assert_eq!(
        call(&mut conn, &writer(Some(&narrow)), &input, None).unwrap_err(),
        "Error: This session's memory profile does not allow NAMING memories at the workspace level."
    );

    let mut agent = input.clone();
    agent["level"] = json!("agent");
    assert_eq!(
        call(&mut conn, &writer(Some(&authority)), &agent, None).unwrap_err(),
        "Error: Unknown memory level 'agent'. Use project, workspace or global."
    );
    assert_eq!(count(&conn, "SELECT count(*) FROM memories"), 0);
    assert_eq!(
        count(&conn, "SELECT count(*) FROM memory_decision_receipts"),
        0
    );
}

/// A global write saves no memory: the fact waits for the user-profile
/// review as an observation from this session, at the message the session
/// had reached.
#[test]
fn a_global_write_is_passed_to_the_review_and_saves_no_memory() {
    let (_dir, mut conn) = database();
    let authority = authority();
    let who = writer(Some(&authority));
    let content = "Prefers short answers.";
    let reply = call(
        &mut conn,
        &who,
        &write(content, "USER_PREFERENCES", Some("global")),
        Some(42),
    )
    .unwrap();
    assert_eq!(
        reply.text,
        "Not saved as a memory: global memories are written only by the review that keeps the user profile. The fact was passed to that review."
    );
    assert_eq!(reply.changed, vec![Change::global_memories()]);
    assert_eq!(count(&conn, "SELECT count(*) FROM memories"), 0);
    type Observation = (
        i64,
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<i64>,
        Option<i64>,
    );
    let observation: Observation = conn
        .query_row(
            "SELECT id, content, proposed_category, session_id, project_id, workspace_id,
                    origin_profile, source_start_ordinal, source_end_ordinal, consumed_at
               FROM memory_observations",
            [],
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
                    row.get(8)?,
                    row.get(9)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(
        observation,
        (
            observation.0,
            content.to_owned(),
            "USER_PREFERENCES".to_owned(),
            "s1".to_owned(),
            Some(PROJECT_ID.to_owned()),
            Some(WORKSPACE.to_owned()),
            Some("@cortexkit/memory-swe".to_owned()),
            Some(42),
            Some(42),
            None
        )
    );
    // The review takes it like any pending observation.
    let pending = memory_writes::person::pending_observations(&conn, &[observation.0]).unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].content, content);
}

/// Update, merge, archive and get take the ids of the session's workspace
/// memories as they take its project's, with the same undo history.
#[test]
fn edits_reach_the_sessions_own_workspace_memories() {
    let (_dir, mut conn) = database();
    let authority = authority();
    let who = writer(Some(&authority));
    let save = |conn: &mut Connection, content: &str| {
        call(
            conn,
            &who,
            &write(content, "CONSTRAINTS", Some("workspace")),
            None,
        )
        .unwrap();
        id_of(conn, content)
    };
    let first = save(&mut conn, "Members share one lockfile policy.");
    let second = save(&mut conn, "Members build offline.");
    let third = save(&mut conn, "Members never fetch at build time.");

    let updated = call(
        &mut conn,
        &who,
        &json!({"action": "update", "ids": [first], "content": "Members share one lockfile policy, checked in CI.", "category": "CONSTRAINTS"}),
        None,
    )
    .unwrap();
    assert_eq!(
        updated.text,
        format!("Updated memory [ID: {first}] in CONSTRAINTS.")
    );
    assert_eq!(updated.changed, vec![workspace_changed(WORKSPACE)]);
    assert_eq!(placed(&conn, first).0, "workspace");
    // The undo history records the change, at the workspace.
    let after: String = conn
        .query_row(
            "SELECT after_json FROM memory_history WHERE memory_id = ?1",
            [first],
            |row| row.get(0),
        )
        .unwrap();
    let after: Value = serde_json::from_str(&after).unwrap();
    assert_eq!(after["snapshot"]["level"], "workspace");
    assert_eq!(after["snapshot"]["projectPath"], WORKSPACE);

    let merged = call(
        &mut conn,
        &who,
        &json!({"action": "merge", "ids": [second, third], "content": "Members build offline and never fetch at build time.", "category": "CONSTRAINTS"}),
        None,
    )
    .unwrap();
    assert!(
        merged.text.starts_with(&format!(
            "Merged memories [{second}, {third}] into canonical memory [ID: "
        )),
        "{}",
        merged.text
    );
    assert_eq!(merged.changed, vec![workspace_changed(WORKSPACE)]);
    let survivor = id_of(
        &conn,
        "Members build offline and never fetch at build time.",
    );
    assert_eq!(
        placed(&conn, survivor),
        (
            "workspace".into(),
            WORKSPACE.into(),
            Some(PROJECT.into()),
            "swe:constraints".into(),
            "CONSTRAINTS".into(),
            "active".into()
        )
    );

    let got = call(
        &mut conn,
        &who,
        &json!({"action": "get", "ids": [survivor]}),
        None,
    )
    .unwrap();
    assert!(
        got.text
            .contains("Members build offline and never fetch at build time."),
        "{}",
        got.text
    );
    assert!(got.changed.is_empty());

    let archived = call(
        &mut conn,
        &who,
        &json!({"action": "archive", "ids": [first]}),
        None,
    )
    .unwrap();
    assert_eq!(archived.text, format!("Archived memory [ID: {first}]."));
    assert_eq!(archived.changed, vec![workspace_changed(WORKSPACE)]);
    assert_eq!(placed(&conn, first).5, "archived");
}

/// Another workspace's memories are not the session's to read or change,
/// and a global memory is refused with the note a global write gets.
#[test]
fn edits_on_another_workspaces_or_a_global_memory_are_refused() {
    let (_dir, mut conn) = database();
    let authority = authority();
    let who = writer(Some(&authority));
    let mut elsewhere = authority.clone();
    elsewhere.workspace_id = Some("ws-other".into());
    call(
        &mut conn,
        &writer(Some(&elsewhere)),
        &write(
            "Their members ship weekly.",
            "CONSTRAINTS",
            Some("workspace"),
        ),
        None,
    )
    .unwrap();
    let theirs = id_of(&conn, "Their members ship weekly.");
    assert_eq!(placed(&conn, theirs).1, "ws-other");
    call(
        &mut conn,
        &who,
        &write("Ours ship daily.", "CONSTRAINTS", Some("workspace")),
        None,
    )
    .unwrap();
    let ours = id_of(&conn, "Ours ship daily.");

    for (input, refusal) in [
        (
            json!({"action": "update", "ids": [theirs], "content": "Changed.", "category": "CONSTRAINTS"}),
            format!("Error: Memory with ID {theirs} was not found."),
        ),
        (
            json!({"action": "archive", "ids": [theirs]}),
            format!("Error: Memory with ID {theirs} was not found."),
        ),
        (
            json!({"action": "merge", "ids": [ours, theirs], "content": "Everyone ships.", "category": "CONSTRAINTS"}),
            "Error: One or more source memories were not found.".to_owned(),
        ),
    ] {
        assert_eq!(call(&mut conn, &who, &input, None).unwrap_err(), refusal);
    }
    let got = call(
        &mut conn,
        &who,
        &json!({"action": "get", "ids": [theirs]}),
        None,
    )
    .unwrap();
    assert_eq!(
        got.text,
        format!("id {theirs}: not found or not visible from this project")
    );

    // A memory about the person, at the global level.
    call(
        &mut conn,
        &who,
        &write("Likes terse replies.", "USER_PREFERENCES", None),
        None,
    )
    .unwrap();
    let global = id_of(&conn, "Likes terse replies.");
    conn.execute(
        "UPDATE memories SET level = 'global', owner_id = 'self' WHERE id = ?1",
        [global],
    )
    .unwrap();
    let note = format!(
        "Error: Memory with ID {global} is a global memory, and global memories are written only by the review that keeps the user profile."
    );
    for input in [
        json!({"action": "update", "ids": [global], "content": "Likes long replies.", "category": "USER_PREFERENCES"}),
        json!({"action": "archive", "ids": [global]}),
        json!({"action": "merge", "ids": [global, ours], "content": "Merged.", "category": "CONSTRAINTS"}),
    ] {
        assert_eq!(call(&mut conn, &who, &input, None).unwrap_err(), note);
    }
    // Nothing changed.
    assert_eq!(placed(&conn, theirs).5, "active");
    assert_eq!(placed(&conn, ours).5, "active");
    assert_eq!(placed(&conn, global).5, "active");
    assert_eq!(count(&conn, "SELECT count(*) FROM memory_history"), 0);
}
