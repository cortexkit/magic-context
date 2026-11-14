//! A replay of the `lift-workspace` task on a copy of a real store: the
//! requests a run would send for one project, and later a report of what
//! the replies would move, for a person to read before the lift runs for
//! real.
//!
//! Nothing here calls a provider or Entorhinal, or writes to the store it
//! reads. [`lift_requests`] copies the store it is given through a read-only
//! connection, brings the copy to this build's schema with the module's own
//! migrations, and plans one project's run exactly as the engine plans it
//! (the bundled memory profile, the task's declaration, the workspace's name
//! and projects), with the workspace given as JSON instead of read from
//! Entorhinal. It writes each batch's request the way a run would send it.
//! `.cortexkit/scripts/summary-replay/send.ts` sends the requests and writes
//! each reply beside its request. [`lift_apply_report`] then copies the
//! migrated store again, checks that the copy plans the very requests that
//! were sent, reads each reply with the task's own parser, applies the
//! accepted ones with the task's own checks and writes, and writes the
//! report: every memory that would move, quoted in full with the model's
//! reason, and every refused move with why.
//!
//! Paths and values come from the environment:
//! - `LIFT_REPLAY_STORE`: a copy of a `context.db`. A path inside the live
//!   data folder (`~/.local/share/cortexkit/`) is refused, and the copy is
//!   opened read-only. Only the first test reads it.
//! - `LIFT_REPLAY_PROJECT_NAME` (optional): the project's name among the
//!   workspace's projects, which the message then shows as the project;
//!   without it the message shows the project's id.
//! - `LIFT_REPLAY_PROJECT`: the project's id, as its memories name their
//!   owner. Only the first test reads it.
//! - `LIFT_REPLAY_WORKSPACE`: the workspace as JSON, `{"id": "…", "name":
//!   "CortexKit", "projects": ["magic-context", "subc", …]}`: the id its
//!   memories name as their owner, its display name and its projects' names.
//!   Only the first test reads it.
//! - `LIFT_REPLAY_BATCHES` (optional): write only this many batches, from
//!   the first. Without it every batch is written.
//! - `DREAMER_REPLAY_OUT`: the output folder, new for the first test. It
//!   holds `store.db` (the migrated copy), `applied.db` (the second test's
//!   copy with the replies applied) and `lift-workspace/`: `manifest.json`,
//!   one `batch-<n>/lift.request.json` per batch (the sender writes
//!   `lift.reply.json` beside it) and `report.md`.

use std::path::{Path, PathBuf};

use cortexkit_role_compaction::setup::ModelRef;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::curate_replay_tests::{migrated_copy, refuse_live};
use super::run::{child_session, TaskInput, TaskReply};
use super::task::{Owner, TaskContext};
use super::tasks::lift_workspace::{
    validate_manifest, LiftBatch, LiftWorkspace, Placed, Pool, BATCH_SIZE, KIND,
};
use crate::context_db::ContextDb;
use crate::context_migrations::SCHEMA_VERSION;
use crate::count::Counter;
use crate::memory_profile::{prompt_profile, Profile};
use crate::routing::{dream_consumer, DREAM_DEMANDS, DREAM_OUTPUT_TOKENS};
use crate::summary::fit::Window;
use crate::workspace_members::{Member, WorkspaceMembers};

/// The task's id in the bundled profile.
const TASK_ID: &str = "swe:lift-workspace";
/// The folder under the output folder that holds the task's files.
const FOLDER: &str = "lift-workspace";
const STORE: &str = "store.db";
const APPLIED: &str = "applied.db";
const MANIFEST: &str = "manifest.json";
const REPORT: &str = "report.md";
/// Each batch's request and reply, inside its `batch-<n>` folder. The sender
/// reads only files named `*.request.json` and writes the reply beside the
/// request as `*.reply.json`.
const REQUEST: &str = "lift.request.json";
const REPLY: &str = "lift.reply.json";
/// A window large enough for any batch. A batch offers its whole message or
/// nothing, so asking with this window gives the message the batch would
/// send to every model that can take it.
const ANY_WINDOW: u64 = 10_000_000;

fn env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

/// Give `project`'s id to the workspace member called `name`. A run names
/// the project by the name the workspace lists for its id, and the
/// workspace JSON lists names only; without a name the message shows the id.
fn name_project(workspace: &mut WorkspaceMembers, project: &str, name: Option<&str>) {
    let Some(name) = name else {
        return;
    };
    let member = workspace
        .members
        .iter_mut()
        .find(|member| member.name == name)
        .expect("LIFT_REPLAY_PROJECT_NAME is one of the workspace's projects");
    member.project_id = project.to_owned();
}

fn required(name: &str, what: &str) -> String {
    env(name).unwrap_or_else(|| panic!("set {name} to {what}"))
}

fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).expect("JSON serializes") + "\n"
}

fn write_file(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().expect("a file has a folder")).expect("create folder");
    std::fs::write(path, text).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
}

fn read_json(path: &Path) -> Value {
    let text =
        std::fs::read_to_string(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

fn batch_dir(out: &Path, index: usize) -> PathBuf {
    out.join(FOLDER).join(format!("batch-{index}"))
}

/// The workspace `LIFT_REPLAY_WORKSPACE` (or the manifest) describes.
fn workspace_of(value: &Value) -> WorkspaceMembers {
    let text = |key: &str| {
        value[key]
            .as_str()
            .unwrap_or_else(|| panic!("the workspace JSON needs a string {key:?}"))
            .to_owned()
    };
    let projects: Vec<String> = value["projects"]
        .as_array()
        .expect("the workspace JSON needs a list \"projects\" of project names")
        .iter()
        .map(|name| {
            name.as_str()
                .expect("each project name is a string")
                .to_owned()
        })
        .collect();
    WorkspaceMembers {
        workspace_id: text("id"),
        name: text("name"),
        members: projects
            .into_iter()
            .map(|name| Member {
                // Only the names reach the message; the run needs no ids.
                project_id: String::new(),
                name,
            })
            .collect(),
    }
}

fn declaration(profile: &Profile) -> Value {
    let declaration = profile.body["tasks"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|task| task["id"] == TASK_ID)
        .cloned()
        .unwrap_or_else(|| panic!("the bundled profile declares no {TASK_ID}"));
    assert_eq!(declaration["kind"], KIND, "{TASK_ID} is not a lift task");
    declaration
}

/// Plan `project`'s run into `workspace` on `db`, as the engine plans it.
fn plan(db: &ContextDb, project: &str, workspace: &WorkspaceMembers) -> (Pool, Vec<LiftBatch>) {
    let profile = prompt_profile(None).expect("the bundled profile");
    let declaration = declaration(&profile);
    let owner = Owner::Project {
        id: project.to_owned(),
        // The lift reads no project files.
        root: "/no-project-folder".into(),
    };
    LiftWorkspace
        .plan_batches(
            &TaskContext {
                db,
                owner: &owner,
                profile: &profile,
                declaration: &declaration,
                workspace: Some(workspace),
            },
            workspace,
        )
        .expect("planning the lift run")
}

fn message(batch: &LiftBatch) -> String {
    let window = Window {
        counter: Counter::for_model(None),
        context_window: ANY_WINDOW,
    };
    batch
        .prompt(window, DREAM_OUTPUT_TOKENS)
        .expect("a lift batch fits a window this large")
}

fn settings() -> Value {
    let demand = DREAM_DEMANDS
        .iter()
        .find(|demand| demand.kind == KIND)
        .expect("the lift has a routing demand");
    json!({
        "consumer": dream_consumer(KIND),
        "iq": demand.iq,
        "contextWindow": demand.context_window,
        "readsCode": demand.reads_code,
        "maxSteps": demand.max_steps,
        "maxOutputTokens": DREAM_OUTPUT_TOKENS,
        "tools": [],
        "cacheTtl": "short",
    })
}

#[test]
#[ignore = "builds workspace lift replay requests from a copy of a real store; see the module documentation"]
fn lift_requests() {
    let store = PathBuf::from(required(
        "LIFT_REPLAY_STORE",
        "a copy of a context.db (never the live one)",
    ));
    let project = required("LIFT_REPLAY_PROJECT", "the project's id");
    let workspace_json: Value = serde_json::from_str(&required(
        "LIFT_REPLAY_WORKSPACE",
        r#"{"id": "<workspace id>", "name": "<display name>", "projects": ["<project name>", …]}"#,
    ))
    .expect("LIFT_REPLAY_WORKSPACE is JSON");
    let mut workspace = workspace_of(&workspace_json);
    let project_name = env("LIFT_REPLAY_PROJECT_NAME");
    name_project(&mut workspace, &project, project_name.as_deref());
    assert!(
        workspace.members.len() >= 2,
        "a workspace of fewer than two projects gets no lift run"
    );
    let limit = env("LIFT_REPLAY_BATCHES").map(|count| {
        count
            .parse::<usize>()
            .expect("LIFT_REPLAY_BATCHES is a number of batches")
    });
    let out = PathBuf::from(required(
        "DREAMER_REPLAY_OUT",
        "a new folder for the replay's output",
    ));
    refuse_live(&store);
    let copy = out.join(STORE);
    assert!(
        !copy.exists(),
        "{} already holds a replay; write a new one to a fresh DREAMER_REPLAY_OUT",
        out.display()
    );
    std::fs::create_dir_all(&out).expect("create the output folder");
    let bytes =
        std::fs::read(&store).unwrap_or_else(|error| panic!("{}: {error}", store.display()));
    let digest: String = Sha256::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    drop(bytes);
    let schema = migrated_copy(&store, &copy);
    let db = ContextDb::open(&copy).expect("open the migrated copy");

    let (pool, batches) = plan(&db, &project, &workspace);
    let written = limit.unwrap_or(batches.len()).min(batches.len());
    let counter = Counter::for_model(None);
    let settings = settings();
    let mut listed = Vec::new();
    for (index, batch) in batches.iter().take(written).enumerate() {
        let system = batch.system().to_owned();
        let user = message(batch);
        write_file(
            &batch_dir(&out, index).join(REQUEST),
            &pretty(&json!({
                "task": TASK_ID,
                "batch": index,
                "settings": settings,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
            })),
        );
        let (system_tokens, user_tokens) = (counter.count(&system), counter.count(&user));
        println!(
            "batch {index}: {} memories, system ~{system_tokens} tokens, user ~{user_tokens} tokens",
            batch.read.len()
        );
        listed.push(json!({
            "batch": index,
            "request": format!("batch-{index}/{REQUEST}"),
            "reply": format!("batch-{index}/{REPLY}"),
            "memories": batch
                .read
                .iter()
                .map(|(id, revision)| json!({"id": id, "readRevision": revision}))
                .collect::<Vec<_>>(),
            "systemTokens": system_tokens,
            "userTokens": user_tokens,
        }));
    }
    let profile = prompt_profile(None).expect("the bundled profile");
    write_file(
        &out.join(FOLDER).join(MANIFEST),
        &pretty(&json!({
            "project": project,
            "projectName": project_name,
            "workspace": workspace_json,
            "store": {"file": store, "sha256": digest, "schema": schema, "migratedTo": SCHEMA_VERSION},
            "copy": STORE,
            "profile": {"name": profile.name, "version": profile.version, "digest": profile.digest},
            "task": TASK_ID,
            "kind": KIND,
            "batchSize": BATCH_SIZE,
            "settings": settings,
            "tokenCounts": "the module's estimate for a model it has no vocabulary for",
            "sentMemories": pool.sent.len(),
            "personWritten": pool.person,
            "plannedBatches": batches.len(),
            "batches": listed,
        })),
    );
    println!(
        "{project}: {} memories to place in {} batches ({written} written), {} left out as person-written; written to {}",
        pool.sent.len(),
        batches.len(),
        pool.person.len(),
        out.join(FOLDER).display()
    );
}

/// What became of one batch's reply.
#[derive(Default)]
struct Outcome {
    /// Why the reply was not applied: there is none yet, the send failed,
    /// the reply hit its output limit, or the task's parser refused it.
    refused: Option<String>,
    /// What applying the reply did.
    placed: Option<Placed>,
}

/// Use `index`'s reply, if the sender wrote one, as the engine uses a
/// reply: one cut off at its output limit or refused by the batch's
/// `accepts` counts as a failed model and is never applied; an accepted one
/// is applied in its own transaction.
fn apply_batch(db: &ContextDb, out: &Path, index: usize, batch: &LiftBatch, run: i64) -> Outcome {
    let path = batch_dir(out, index).join(REPLY);
    if !path.exists() {
        return Outcome {
            refused: Some("no reply yet".into()),
            placed: None,
        };
    }
    let record = read_json(&path);
    let refused = |why: String| Outcome {
        refused: Some(why),
        placed: None,
    };
    if record["ok"] != json!(true) {
        return refused(format!(
            "the send failed: {}",
            record["error"].as_str().unwrap_or("no error recorded")
        ));
    }
    if record["finishReason"] == json!("length") {
        return refused(
            "the reply hit its output limit; the engine fails the model before the task reads the reply"
                .into(),
        );
    }
    let text = record["body"]["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    if let Err(refusal) = batch.accepts(&text) {
        return refused(format!("the task refused the reply: {refusal}"));
    }
    let reply = TaskReply {
        text,
        model: ModelRef::new(
            "replay",
            record["sent"]["model"].as_str().unwrap_or_default(),
        ),
        runner: "replay".into(),
        // The child the engine's first attempt at this batch would run in.
        child: child_session(&format!("{run}.{index}"), 0, 0),
        usage: None,
    };
    // The batch's own apply, which reads the manifest and places what it
    // says; the report needs the moves and refusals it found, so the two
    // steps run here as apply runs them.
    let placed = db.with_connection(|conn| {
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        let verdicts = validate_manifest(&reply.text, &batch.ids())?;
        let placed = batch
            .place(&tx, &verdicts, run)
            .map_err(|error| error.to_string())?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok::<_, String>(placed)
    });
    match placed {
        Ok(placed) => Outcome {
            refused: None,
            placed: Some(placed),
        },
        Err(error) => refused(format!("applying the reply failed: {error}")),
    }
}

/// The text and tag of memory `id`, as the store holds them.
fn memory(db: &ContextDb, id: i64) -> (String, String) {
    db.with_connection(|conn| {
        conn.query_row(
            "SELECT origin_category, content FROM memories WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
    })
    .expect("read a memory")
    .unwrap_or_else(|| ("?".into(), "(the memory is gone)".into()))
}

/// `text` as a Markdown quote, line for line.
fn quote(text: &str) -> String {
    text.lines()
        .map(|line| format!("> {line}"))
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
#[ignore = "applies workspace lift replay replies to a copy of the replay's store; see the module documentation"]
fn lift_apply_report() {
    let out = PathBuf::from(required(
        "DREAMER_REPLAY_OUT",
        "the folder lift_requests wrote",
    ));
    let manifest = read_json(&out.join(FOLDER).join(MANIFEST));
    let project = manifest["project"]
        .as_str()
        .expect("the manifest names the project")
        .to_owned();
    let mut workspace = workspace_of(&manifest["workspace"]);
    name_project(&mut workspace, &project, manifest["projectName"].as_str());
    let source = out.join(STORE);
    assert!(
        source.exists(),
        "{} is missing; run lift_requests first",
        source.display()
    );
    let applied_path = out.join(APPLIED);
    for suffix in ["", "-wal", "-shm"] {
        let mut name = applied_path.as_os_str().to_owned();
        name.push(suffix);
        let path = PathBuf::from(name);
        if path.exists() {
            std::fs::remove_file(&path)
                .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        }
    }
    Connection::open(&source)
        .expect("open the replay store")
        .execute(
            "VACUUM INTO ?1",
            [applied_path
                .to_str()
                .expect("the output folder's path is UTF-8")],
        )
        .expect("copy the replay store");
    let db = ContextDb::open(&applied_path).expect("open the store copy");

    // The copy must plan the very requests that were sent: a reply answers
    // the request it was given, and applying it to another batch would pair
    // it with memories it never saw.
    let (pool, batches) = plan(&db, &project, &workspace);
    let listed = manifest["batches"]
        .as_array()
        .expect("the manifest lists the batches");
    assert_eq!(
        manifest["plannedBatches"].as_u64(),
        Some(batches.len() as u64),
        "the store plans a different run than the manifest lists"
    );
    for (index, (batch, listed)) in batches.iter().zip(listed).enumerate() {
        let read: Vec<(i64, i64)> = listed["memories"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|memory| {
                (
                    memory["id"].as_i64().unwrap_or_default(),
                    memory["readRevision"].as_i64().unwrap_or_default(),
                )
            })
            .collect();
        assert_eq!(
            batch.read, read,
            "batch {index} reads other memories than the manifest lists"
        );
        let request = read_json(&batch_dir(&out, index).join(REQUEST));
        assert_eq!(
            request["messages"],
            json!([
                {"role": "system", "content": batch.system()},
                {"role": "user", "content": message(batch)},
            ]),
            "batch {index}'s request is not the one the store plans"
        );
    }
    // The run the engine's next run on this store would be.
    let run: i64 = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT COALESCE(MAX(id), 0) + 1 FROM dream_task_runs",
                [],
                |row| row.get(0),
            )
        })
        .expect("read the store's runs");
    let outcomes: Vec<Outcome> = batches
        .iter()
        .take(listed.len())
        .enumerate()
        .map(|(index, batch)| apply_batch(&db, &out, index, batch, run))
        .collect();

    let mut moved = Vec::new();
    let mut refused = Vec::new();
    for (index, outcome) in outcomes.iter().enumerate() {
        if let Some(placed) = &outcome.placed {
            moved.extend(placed.moved.iter().map(|(id, reason)| (index, *id, reason)));
            refused.extend(placed.refused.iter().map(|(id, why)| (index, *id, why)));
        }
    }
    let applied_batches = outcomes
        .iter()
        .filter(|outcome| outcome.placed.is_some())
        .count();
    let placed_memories: usize = outcomes
        .iter()
        .zip(&batches)
        .filter(|(outcome, _)| outcome.placed.is_some())
        .map(|(_, batch)| batch.read.len())
        .sum();
    let names: Vec<&str> = workspace
        .members
        .iter()
        .map(|member| member.name.as_str())
        .collect();
    let mut report = format!(
        "# Workspace lift replay: {project}\n\n\
         Workspace **{}** (`{}`), {} projects: {}.\n\n\
         The store is a copy of `{}`, migrated to schema {}; the replies were applied to `{APPLIED}` as run {run}.\n\n\
         - Memories to place: {} in {} batches of up to {BATCH_SIZE}; {} batches written, {applied_batches} with an accepted reply ({placed_memories} memories placed).\n\
         - Left out as written or edited by the person: {}.\n\
         - Would move to the workspace: **{}**. Refused moves: {}. Every other placed memory stays with the project.\n",
        workspace.name,
        workspace.workspace_id,
        names.len(),
        names.join(", "),
        manifest["store"]["file"].as_str().unwrap_or_default(),
        SCHEMA_VERSION,
        pool.sent.len(),
        batches.len(),
        listed.len(),
        if pool.person.is_empty() {
            "none".to_owned()
        } else {
            pool.person
                .iter()
                .map(i64::to_string)
                .collect::<Vec<_>>()
                .join(", ")
        },
        moved.len(),
        refused.len(),
    );
    report.push_str(&format!(
        "\n## Would move to the workspace ({})\n",
        moved.len()
    ));
    if moved.is_empty() {
        report.push_str("\nNone.\n");
    }
    for (index, id, reason) in &moved {
        let (tag, content) = memory(&db, *id);
        report.push_str(&format!(
            "\n### Memory {id} · {tag} (batch {index})\n\n{}\n\nReason: {reason}\n",
            quote(&content)
        ));
    }
    report.push_str(&format!("\n## Refused moves ({})\n", refused.len()));
    if refused.is_empty() {
        report.push_str("\nNone.\n");
    }
    for (index, id, why) in &refused {
        let (tag, content) = memory(&db, *id);
        report.push_str(&format!(
            "\n### Memory {id} · {tag} (batch {index})\n\n{}\n\nRefused: {why}\n",
            quote(&content)
        ));
    }
    report.push_str(
        "\n## Batches\n\n| Batch | Memories | Moves | Refused | Reply |\n|---|---|---|---|---|\n",
    );
    for (index, (outcome, batch)) in outcomes.iter().zip(&batches).enumerate() {
        let (moves, refusals, status) = match (&outcome.placed, &outcome.refused) {
            (Some(placed), _) => (
                placed.moved.len().to_string(),
                placed.refused.len().to_string(),
                "applied".to_owned(),
            ),
            (None, Some(why)) => ("–".into(), "–".into(), why.replace('|', "\\|")),
            (None, None) => ("–".into(), "–".into(), "not applied".into()),
        };
        report.push_str(&format!(
            "| {index} | {} | {moves} | {refusals} | {status} |\n",
            batch.read.len()
        ));
    }
    write_file(&out.join(FOLDER).join(REPORT), &report);
    println!(
        "{applied_batches} of {} batches applied: {} would move, {} refused; report written to {}",
        outcomes.len(),
        moved.len(),
        refused.len(),
        out.join(FOLDER).join(REPORT).display()
    );
}
