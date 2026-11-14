//! A replay of the `curate-workspace` task on a copy of a real store: the
//! requests a run would send for one workspace, and later a report of what
//! the replies would change, for a person to read before the task runs for
//! real.
//!
//! Nothing here calls a provider or Entorhinal, or writes to the store it
//! reads. [`curate_workspace_requests`] copies the store it is given through
//! a read-only connection, brings the copy to this build's schema with the
//! module's own migrations, and plans one workspace's run exactly as the
//! engine plans it (the bundled memory profile, the task's declaration, the
//! person's memories the head shows every session, the workspace's name and
//! projects), with the workspace given as JSON instead of read from
//! Entorhinal. It writes each part's request the way a run would send it.
//! `.cortexkit/scripts/summary-replay/send.ts` sends the requests and writes
//! each reply beside its request. [`curate_workspace_apply_report`] then
//! copies the migrated store again, checks that the copy plans the very
//! requests that were sent, reads each reply with the task's own parser,
//! applies the accepted ones with the task's own checks and writes, and
//! writes the report: every change written, quoted in full with its
//! reason, and every refused change with why.
//!
//! The input store may be the workspace lift replay's `applied.db`
//! ([`super::lift_replay_tests`]): the store as it would be after the lift,
//! which is the store this task would curate next. Both replays may share
//! one output folder; this one writes only under `curate-workspace/`.
//!
//! Paths and values come from the environment:
//! - `CURATE_WORKSPACE_REPLAY_STORE`: a copy of a `context.db`, or a lift
//!   replay's `applied.db`. A path inside the live data folder
//!   (`~/.local/share/cortexkit/`) is refused, and the copy is opened
//!   read-only. Only the first test reads it.
//! - `CURATE_WORKSPACE_REPLAY_WORKSPACE`: the workspace as JSON, `{"id":
//!   "…", "name": "CortexKit", "projects": ["magic-context", "subc", …]}`:
//!   the id its memories name as their owner, its display name and its
//!   projects' names. Only the first test reads it.
//! - `CURATE_WORKSPACE_REPLAY_CATEGORY` (optional): curate only this
//!   category, by profile id (`swe:naming`) or tag (`NAMING`). Without it
//!   every category the task declares is planned, as a run plans them.
//! - `CURATE_WORKSPACE_REPLAY_BATCHES` (optional): write only this many
//!   batches, from the first. Without it every batch is written.
//! - `DREAMER_REPLAY_OUT`: the output folder. It gets `curate-workspace/`,
//!   new for the first test, holding `store.db` (the migrated copy),
//!   `applied.db` (the second test's copy with the replies applied),
//!   `manifest.json`, one `batch-<n>/curate.request.json` per batch (the
//!   sender writes `curate.reply.json` beside it) and `report.md`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use cortexkit_role_compaction::setup::ModelRef;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::curate_replay_tests::{migrated_copy, refuse_live};
use super::run::{child_session, TaskInput, TaskReply};
use super::task::{Owner, TaskContext};
use super::tasks::curate::{parse_list, pool, Change, CurateBatch, Scope, Written};
use super::tasks::curate_workspace::{CurateWorkspace, KIND};
use crate::context_db::ContextDb;
use crate::context_migrations::SCHEMA_VERSION;
use crate::count::Counter;
use crate::memory_profile::{prompt_profile, Profile};
use crate::routing::{dream_consumer, DREAM_DEMANDS, DREAM_OUTPUT_TOKENS};
use crate::summary::fit::Window;
use crate::workspace_members::{Member, WorkspaceMembers};

/// The task's id in the bundled profile.
const TASK_ID: &str = "swe:curate-workspace";
/// The folder under the output folder that holds every file of this replay.
const FOLDER: &str = "curate-workspace";
const STORE: &str = "store.db";
const APPLIED: &str = "applied.db";
const MANIFEST: &str = "manifest.json";
const REPORT: &str = "report.md";
/// Each batch's request and reply, inside its `batch-<n>` folder. The sender
/// reads only files named `*.request.json` and writes the reply beside the
/// request as `*.reply.json`.
const REQUEST: &str = "curate.request.json";
const REPLY: &str = "curate.reply.json";
/// A window large enough for any part. A part offers its whole message or
/// nothing, so asking with this window gives the message the part would
/// send to every model that can take it.
const ANY_WINDOW: u64 = 10_000_000;

fn env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
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

fn folder(out: &Path) -> PathBuf {
    out.join(FOLDER)
}

fn batch_dir(out: &Path, index: usize) -> PathBuf {
    folder(out).join(format!("batch-{index}"))
}

/// The workspace `CURATE_WORKSPACE_REPLAY_WORKSPACE` (or the manifest)
/// describes.
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
    assert_eq!(
        declaration["kind"], KIND,
        "{TASK_ID} is not a workspace curate task"
    );
    declaration
}

/// Plan `workspace`'s run on `db`, as the engine plans it, from its first
/// part; `only` keeps one category.
fn plan(db: &ContextDb, workspace: &WorkspaceMembers, only: Option<&str>) -> Vec<CurateBatch> {
    let profile = prompt_profile(None).expect("the bundled profile");
    let declaration = declaration(&profile);
    let owner = Owner::Workspace {
        id: workspace.workspace_id.clone(),
    };
    CurateWorkspace
        .plan_batches(
            &TaskContext {
                db,
                owner: &owner,
                profile: &profile,
                declaration: &declaration,
                workspace: Some(workspace),
            },
            None,
            only,
        )
        .expect("planning the workspace curate run")
}

fn message(batch: &CurateBatch) -> String {
    let window = Window {
        counter: Counter::for_model(None),
        context_window: ANY_WINDOW,
    };
    batch
        .prompt(window, DREAM_OUTPUT_TOKENS)
        .expect("a curate part fits a window this large")
}

fn settings() -> Value {
    let demand = DREAM_DEMANDS
        .iter()
        .find(|demand| demand.kind == KIND)
        .expect("workspace curate has a routing demand");
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
#[ignore = "builds workspace curate replay requests from a copy of a real store; see the module documentation"]
fn curate_workspace_requests() {
    let store = PathBuf::from(required(
        "CURATE_WORKSPACE_REPLAY_STORE",
        "a copy of a context.db or a lift replay's applied.db (never the live one)",
    ));
    let workspace: Value = serde_json::from_str(&required(
        "CURATE_WORKSPACE_REPLAY_WORKSPACE",
        r#"{"id": "<workspace id>", "name": "<display name>", "projects": ["<project name>", …]}"#,
    ))
    .expect("CURATE_WORKSPACE_REPLAY_WORKSPACE is JSON");
    let only = env("CURATE_WORKSPACE_REPLAY_CATEGORY");
    let limit = env("CURATE_WORKSPACE_REPLAY_BATCHES").map(|count| {
        count
            .parse::<usize>()
            .expect("CURATE_WORKSPACE_REPLAY_BATCHES is a number of batches")
    });
    let out = PathBuf::from(required(
        "DREAMER_REPLAY_OUT",
        "a folder for the replay's output",
    ));
    write_requests(&store, &workspace, only, limit, &out);
}

/// Copy `store` into `out`, plan the run of the workspace `workspace_json`
/// describes (`only` one category, when named) and write its first `limit`
/// requests (every one without it) and the manifest.
fn write_requests(
    store: &Path,
    workspace_json: &Value,
    only: Option<String>,
    limit: Option<usize>,
    out: &Path,
) {
    let workspace = workspace_of(workspace_json);
    assert!(
        workspace.members.len() >= 2,
        "a workspace of fewer than two projects shares no memories and gets no run"
    );
    refuse_live(store);
    let copy = folder(out).join(STORE);
    assert!(
        !copy.exists(),
        "{} already holds a replay; write a new one to a fresh DREAMER_REPLAY_OUT",
        folder(out).display()
    );
    std::fs::create_dir_all(folder(out)).expect("create the output folder");
    let bytes = std::fs::read(store).unwrap_or_else(|error| panic!("{}: {error}", store.display()));
    let digest: String = Sha256::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    drop(bytes);
    let schema = migrated_copy(store, &copy);
    let db = ContextDb::open(&copy).expect("open the migrated copy");

    let batches = plan(&db, &workspace, only.as_deref());
    let written = limit.unwrap_or(batches.len()).min(batches.len());
    let counter = Counter::for_model(None);
    let settings = settings();
    let mut listed = Vec::new();
    for (index, batch) in batches.iter().take(written).enumerate() {
        let system = batch.system().to_owned();
        let user = message(batch);
        write_file(
            &batch_dir(out, index).join(REQUEST),
            &pretty(&json!({
                "task": TASK_ID,
                "workspace": workspace.workspace_id,
                "category": batch.category.id,
                "part": batch.part.0,
                "parts": batch.part.1,
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
            "batch {index}: {} part {} of {}, {} memories, system ~{system_tokens} tokens, user ~{user_tokens} tokens",
            batch.category.tag,
            batch.part.0,
            batch.part.1,
            batch.read.len()
        );
        listed.push(json!({
            "batch": index,
            "category": {"id": batch.category.id, "tag": batch.category.tag},
            "part": batch.part.0,
            "parts": batch.part.1,
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
    let scope = Scope::workspace(&workspace.workspace_id);
    let now = crate::summary::run::now_ms();
    let live: Vec<Value> = super::tasks::curate::categories(&profile, &declaration(&profile))
        .into_iter()
        .filter(|category| {
            only.as_deref()
                .is_none_or(|only| category.id == only || category.tag == only)
        })
        .map(|category| {
            let memories = db
                .with_connection(|conn| pool(conn, &scope, &category.id, now))
                .expect("reading the workspace's memories");
            json!({
                "category": category.id,
                "live": memories.len(),
                "protected": memories
                    .iter()
                    .filter(|memory| memory.protected)
                    .map(|memory| memory.id)
                    .collect::<Vec<_>>(),
            })
        })
        .collect();
    write_file(
        &folder(out).join(MANIFEST),
        &pretty(&json!({
            "workspace": workspace_json,
            "store": {"file": store, "sha256": digest, "schema": schema, "migratedTo": SCHEMA_VERSION},
            "copy": STORE,
            "profile": {"name": profile.name, "version": profile.version, "digest": profile.digest},
            "task": TASK_ID,
            "kind": KIND,
            "category": only,
            "settings": settings,
            "tokenCounts": "the module's estimate for a model it has no vocabulary for",
            "categories": live,
            "plannedBatches": batches.len(),
            "batches": listed,
        })),
    );
    println!(
        "workspace {}: {} batches planned ({written} written) to {}",
        workspace.workspace_id,
        batches.len(),
        folder(out).display()
    );
}

/// What became of one batch's reply.
#[derive(Default)]
struct Outcome {
    /// Why the reply was not applied: there is none yet, the send failed,
    /// the reply hit its output limit, or the task's parser refused it.
    refused: Option<String>,
    /// Each entry of the reply's list, in order, with why it was dropped
    /// (`None` when it was written).
    entries: Vec<(Result<Change, String>, Option<String>)>,
    /// The tag and text of every memory the list names, as the store held
    /// them before the reply was applied.
    texts: HashMap<i64, (String, String)>,
}

/// The tag and text of memory `id`, as `conn` holds it.
fn text_of(conn: &Connection, id: i64) -> rusqlite::Result<(String, String)> {
    Ok(conn
        .query_row(
            "SELECT origin_category, content FROM memories WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .unwrap_or_else(|| ("?".into(), "(no such memory)".into())))
}

/// Use `index`'s reply, if the sender wrote one, as the engine uses a
/// reply: one cut off at its output limit or refused by the batch's
/// `accepts` counts as a failed model and is never applied; an accepted one
/// is applied in its own transaction, by the batch's own checks and writes.
fn apply_batch(db: &ContextDb, out: &Path, index: usize, batch: &CurateBatch, run: i64) -> Outcome {
    let path = batch_dir(out, index).join(REPLY);
    let refused = |why: String| Outcome {
        refused: Some(why),
        ..Outcome::default()
    };
    if !path.exists() {
        return refused("no reply yet".into());
    }
    let record = read_json(&path);
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
    let entries = match parse_list(&reply.text) {
        Ok(entries) => entries,
        Err(refusal) => return refused(format!("the task refused the reply: {refusal}")),
    };
    // The batch's own write, which checks each change and writes the ones
    // that pass; the report needs each change's fate, so it runs here as
    // the batch's apply runs it.
    let applied = db.with_connection(|conn| {
        let mut texts = HashMap::new();
        for change in entries.iter().flatten() {
            let mut ids = change.ids();
            if let Change::Archive { of: Some(of), .. } = change {
                ids.push(*of);
            }
            for id in ids {
                texts.insert(id, text_of(conn, id).map_err(|error| error.to_string())?);
            }
        }
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        let written: Written = batch
            .write(&tx, &entries, &reply.child, run)
            .map_err(|error| error.to_string())?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok::<_, String>((texts, written))
    });
    match applied {
        Ok((texts, written)) => Outcome {
            refused: None,
            entries: entries.into_iter().zip(written.refusals).collect(),
            texts,
        },
        Err(error) => refused(format!("applying the reply failed: {error}")),
    }
}

/// `text` as a Markdown quote, line for line.
fn quote(text: &str) -> String {
    text.lines()
        .map(|line| format!("> {line}"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Memory `id` as the report quotes it: its id, tag and text.
fn quoted(texts: &HashMap<i64, (String, String)>, id: i64) -> String {
    let (tag, content) = texts
        .get(&id)
        .cloned()
        .unwrap_or_else(|| ("?".into(), "(not read)".into()));
    format!("Memory {id} · {tag}:\n\n{}", quote(&content))
}

/// One change of a reply, in full: what it names, the text it writes, and
/// its reason.
fn described(change: &Change, texts: &HashMap<i64, (String, String)>) -> String {
    match change {
        Change::Merge { ids, text } => format!(
            "{}\n\nMerged text:\n\n{}\n\nReason: they state the same fact or rule (a merge gives no other reason).",
            ids.iter()
                .map(|id| quoted(texts, *id))
                .collect::<Vec<_>>()
                .join("\n\n"),
            quote(text)
        ),
        Change::Shorten { id, text } => format!(
            "{}\n\nShorter text:\n\n{}\n\nReason: a shorter text for the same fact (a shorten gives no other reason).",
            quoted(texts, *id),
            quote(text)
        ),
        Change::Split { id, parts } => format!(
            "{}\n\nParts:\n\n{}\n\nReason: it states several separate facts (a split gives no other reason).",
            quoted(texts, *id),
            parts
                .iter()
                .enumerate()
                .map(|(index, part)| format!("Part {}:\n\n{}", index + 1, quote(part)))
                .collect::<Vec<_>>()
                .join("\n\n")
        ),
        Change::Archive {
            id,
            reason,
            of,
            quote: quoted_line,
            why,
        } => {
            let mut text = format!("{}\n\nReason: {reason}", quoted(texts, *id));
            if let Some(why) = why {
                text.push_str(&format!(": {why}"));
            }
            if let Some(line) = quoted_line {
                text.push_str(&format!("; quotes \"{line}\""));
            }
            if let Some(of) = of {
                text.push_str(&format!(", of:\n\n{}", quoted(texts, *of)));
            }
            text
        }
    }
}

/// The heading of one change: its kind and the memories it names.
fn heading(change: &Change) -> String {
    let ids: Vec<String> = change.ids().iter().map(i64::to_string).collect();
    format!("{} {}", change.action(), ids.join(", "))
}

#[test]
#[ignore = "applies workspace curate replay replies to a copy of the replay's store; see the module documentation"]
fn curate_workspace_apply_report() {
    let out = PathBuf::from(required(
        "DREAMER_REPLAY_OUT",
        "the folder curate_workspace_requests wrote",
    ));
    apply_report(&out);
}

/// Apply the replies beside the requests in `out` to a fresh copy of the
/// replay's store, and write the report.
fn apply_report(out: &Path) {
    let manifest = read_json(&folder(out).join(MANIFEST));
    let workspace = workspace_of(&manifest["workspace"]);
    let only = manifest["category"].as_str().map(str::to_owned);
    let source = folder(out).join(STORE);
    assert!(
        source.exists(),
        "{} is missing; run curate_workspace_requests first",
        source.display()
    );
    let applied_path = folder(out).join(APPLIED);
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
    let batches = plan(&db, &workspace, only.as_deref());
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
        let request = read_json(&batch_dir(out, index).join(REQUEST));
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
        .map(|(index, batch)| apply_batch(&db, out, index, batch, run))
        .collect();

    let mut written = Vec::new();
    let mut refused = Vec::new();
    for ((index, outcome), batch) in outcomes.iter().enumerate().zip(&batches) {
        let at = format!(
            "{} part {} of {}, batch {index}",
            batch.category.tag, batch.part.0, batch.part.1
        );
        for (number, (entry, refusal)) in outcome.entries.iter().enumerate() {
            match (entry, refusal) {
                (Ok(change), None) => written.push(format!(
                    "\n### {} ({at})\n\n{}\n",
                    heading(change),
                    described(change, &outcome.texts)
                )),
                (Ok(change), Some(why)) => refused.push(format!(
                    "\n### {} ({at})\n\n{}\n\nRefused: {why}\n",
                    heading(change),
                    described(change, &outcome.texts)
                )),
                (Err(_), why) => refused.push(format!(
                    "\n### Change {} ({at})\n\nThe list's entry could not be read.\n\nRefused: {}\n",
                    number + 1,
                    why.as_deref().unwrap_or("unreadable")
                )),
            }
        }
    }
    let accepted = outcomes
        .iter()
        .filter(|outcome| outcome.refused.is_none())
        .count();
    let names: Vec<&str> = workspace
        .members
        .iter()
        .map(|member| member.name.as_str())
        .collect();
    let mut report = format!(
        "# Workspace curate replay: {}\n\n\
         Workspace **{}** (`{}`), {} projects: {}.\n\n\
         The store is a copy of `{}`, migrated to schema {}; the replies were applied to `{FOLDER}/{APPLIED}` as run {run}.\n\n\
         - Batches: {} planned, {} written, {accepted} with an accepted reply.\n\
         - Changes written: **{}**. Changes refused: {}. Every memory no change names stays as it is.\n\
         - A merge, shorten or split carries no reason beyond its kind; an archive names its own.\n",
        workspace.name,
        workspace.name,
        workspace.workspace_id,
        names.len(),
        names.join(", "),
        manifest["store"]["file"].as_str().unwrap_or_default(),
        SCHEMA_VERSION,
        batches.len(),
        listed.len(),
        written.len(),
        refused.len(),
    );
    report.push_str(&format!("\n## Changes written ({})\n", written.len()));
    if written.is_empty() {
        report.push_str("\nNone.\n");
    }
    for change in &written {
        report.push_str(change);
    }
    report.push_str(&format!("\n## Changes refused ({})\n", refused.len()));
    if refused.is_empty() {
        report.push_str("\nNone.\n");
    }
    for change in &refused {
        report.push_str(change);
    }
    report.push_str(
        "\n## Batches\n\n| Batch | Category | Part | Memories | Written | Refused | Reply |\n|---|---|---|---|---|---|---|\n",
    );
    for (index, (outcome, batch)) in outcomes.iter().zip(&batches).enumerate() {
        let (writes, refusals, status) = match &outcome.refused {
            None => (
                outcome
                    .entries
                    .iter()
                    .filter(|(_, refusal)| refusal.is_none())
                    .count()
                    .to_string(),
                outcome
                    .entries
                    .iter()
                    .filter(|(_, refusal)| refusal.is_some())
                    .count()
                    .to_string(),
                "applied".to_owned(),
            ),
            Some(why) => ("–".into(), "–".into(), why.replace('|', "\\|")),
        };
        report.push_str(&format!(
            "| {index} | {} | {} of {} | {} | {writes} | {refusals} | {status} |\n",
            batch.category.tag,
            batch.part.0,
            batch.part.1,
            batch.read.len()
        ));
    }
    write_file(&folder(out).join(REPORT), &report);
    println!(
        "{accepted} of {} batches applied: {} changes written, {} refused; report written to {}",
        outcomes.len(),
        written.len(),
        refused.len(),
        folder(out).join(REPORT).display()
    );
}

/// The harness end to end on a small store named as the workspace lift's
/// replay names its output, with replies written the way the sender writes
/// them: the report quotes the written change with its reason and the
/// refused one with why.
#[test]
fn the_replay_reads_a_lift_replays_store_and_reports_every_change() {
    use super::tasks::curate_workspace::tests::{insert, personal, rule};
    let dir = tempfile::tempdir().unwrap();
    let lift_output = dir.path().join("applied.db");
    {
        let db = ContextDb::create_for_tests(&lift_output).unwrap();
        insert(
            &db,
            &[
                rule(1, "Run `cargo fmt --all` before every commit."),
                rule(2, "Before committing, run `cargo fmt --all`."),
                rule(3, "Never commit a secret."),
                personal(30, "Always answer the person in English."),
            ],
        );
    }
    let out = dir.path().join("replay");
    let workspace = json!({
        "id": super::tasks::curate_workspace::tests::WORKSPACE,
        "name": "CortexKit",
        "projects": ["subc", "magic-context"],
    });
    write_requests(&lift_output, &workspace, None, None, &out);
    let manifest = read_json(&folder(&out).join(MANIFEST));
    assert_eq!(manifest["plannedBatches"], 1);
    let request = read_json(&batch_dir(&out, 0).join(REQUEST));
    let user = request["messages"][1]["content"].as_str().unwrap();
    assert!(user.contains("**Workspace:** CortexKit, with 2 projects: magic-context, subc"));
    assert!(user.contains("[30] COMMUNICATION: Always answer the person in English."));

    write_file(
        &batch_dir(&out, 0).join(REPLY),
        &pretty(&json!({
            "ok": true,
            "finishReason": "stop",
            "sent": {"model": "m"},
            "body": {"choices": [{"message": {"content":
                "<curate>\n<archive id=\"2\" reason=\"duplicate\" of=\"1\"/>\n<archive id=\"3\" reason=\"duplicate\" quote=\"Never commit a secret to the repository.\"/>\n</curate>"
            }}]},
        })),
    );
    apply_report(&out);
    let report = std::fs::read_to_string(folder(&out).join(REPORT)).unwrap();
    assert!(
        report.contains("Changes written: **1**. Changes refused: 1."),
        "{report}"
    );
    assert!(report.contains(
        "### archive 2 (PROJECT_RULES part 1 of 1, batch 0)\n\nMemory 2 · PROJECT_RULES:\n\n> Before committing, run `cargo fmt --all`.\n\nReason: duplicate, of:\n\nMemory 1 · PROJECT_RULES:\n\n> Run `cargo fmt --all` before every commit.\n"
    ), "{report}");
    assert!(
        report.contains("Refused: a workspace has no documents to quote"),
        "{report}"
    );
    // The replay's own copy took the change; the input store did not.
    let status = |path: &Path| -> String {
        Connection::open(path)
            .unwrap()
            .query_row("SELECT status FROM memories WHERE id = 2", [], |row| {
                row.get(0)
            })
            .unwrap()
    };
    assert_eq!(status(&folder(&out).join(APPLIED)), "archived");
    assert_eq!(status(&lift_output), "active");
}
