//! A replay of the `reflect-events` task on a copy of a real store: the
//! requests a run would send for one project, and then what one reply would
//! write, for a person to read before the task runs for real.
//!
//! Nothing here calls a provider or writes to the store it reads.
//! [`reflect_requests`] copies the store it is given through a read-only
//! connection, brings the copy to this build's schema with the module's own
//! migrations, and plans the project's run exactly as the engine plans it
//! (the bundled memory profile and the task's declaration), finding each
//! group's existing memories by words, as a run without an embedding
//! provider does. It writes each message as
//! `reflect/batch-<n>/reflect.request.json`: the system and user text, the
//! model settings, the groups and the existing memories it shows.
//! `.cortexkit/scripts/summary-replay/send.ts` or
//! `packages/plugin/scripts/dreamer-replay/verify-run.ts` sends a request and
//! writes the reply beside it.
//!
//! [`reflect_apply`] then copies the replay's store again to a throwaway
//! copy, plans the same run there at the same time, checks that the batch's
//! message is the one that was sent, and applies one reply with the task's
//! own checks and writes. It prints, and writes beside the request as
//! `reflect.apply.json`, every learning written and every one dropped, with
//! why.
//!
//! Paths and values come from the environment:
//! - `REFLECT_REPLAY_STORE`: a copy of a `context.db`. A path inside the live
//!   data folder (`~/.local/share/cortexkit/`) is refused, and the copy is
//!   opened read-only. Only the first test reads it.
//! - `REFLECT_REPLAY_PROJECT`: the project's id, as `session_projects` names
//!   it. Only the first test reads it.
//! - `REFLECT_REPLAY_SINCE_EVENT` (optional): treat events up to this id as
//!   read by an earlier run (the task's watermark). Without it the copy's
//!   own watermark counts, and none means every event is new.
//! - `DREAMER_REPLAY_MODEL` (optional): the model a request names;
//!   `deepseek-flash` by default.
//! - `DREAMER_REPLAY_BATCHES` (optional): write only this many messages.
//! - `DREAMER_REPLAY_OUT`: the output folder, new for the first test. It
//!   holds `store.db` (the migrated copy), `manifest.json` and `reflect/`,
//!   one `batch-<n>/reflect.request.json` per message.
//! - `REFLECT_REPLAY_BATCH` (second test): the batch whose reply to apply.
//! - `REFLECT_REPLAY_REPLY` (second test, optional): the reply file. Without
//!   it the batch's `reflect.reply.json` (as `send.ts` writes it) or
//!   `reflect.trajectory.json` (as `verify-run.ts` writes it) is read; a file
//!   that is neither is read as the reply's text.

use std::path::{Path, PathBuf};

use rusqlite::TransactionBehavior;
use serde_json::{json, Value};

use super::curate_replay_tests::{migrated_copy, refuse_live};
use super::run::child_session;
use super::store::{ensure_schedule, OwnerKey};
use super::task::{Owner, TaskContext};
use super::tasks::reflect_events::learnings::parse_learnings;
use super::tasks::reflect_events::{ReflectBatch, ReflectEvents, KIND};
use super::verify_replay_tests::{env, required, write_json, ANY_WINDOW};
use crate::context_db::ContextDb;
use crate::context_migrations::SCHEMA_VERSION;
use crate::count::Counter;
use crate::memory_profile::{prompt_profile, Profile};
use crate::routing::{dream_consumer, DREAM_DEMANDS, DREAM_OUTPUT_TOKENS};
use crate::summary::fit::Window;

/// The folder the requests go in, and each message's request inside its
/// `batch-<n>` folder there.
const FOLDER: &str = "reflect";
const REQUEST: &str = "reflect.request.json";
/// The run id the apply step writes under, which no engine run uses.
const REPLAY_RUN: i64 = 0;

/// Refuse a path inside the live data folder, whether or not it exists yet.
pub(super) fn refuse_live_path(path: &Path) {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .expect("a working folder")
            .join(path)
    };
    let mut existing = absolute.as_path();
    while !existing.exists() {
        existing = existing.parent().expect("the root exists");
    }
    refuse_live(existing);
}

fn read_json(path: &Path) -> Value {
    let text =
        std::fs::read_to_string(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

fn batch_dir(out: &Path, index: usize) -> PathBuf {
    out.join(FOLDER).join(format!("batch-{index}"))
}

fn declaration(profile: &Profile) -> Value {
    profile.body["tasks"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|task| task["kind"] == KIND)
        .cloned()
        .unwrap_or_else(|| panic!("the bundled profile declares no {KIND} task"))
}

/// The run's messages for `project` on `db` at `now`, as the engine plans
/// them without an embedding provider.
fn plan(db: &ContextDb, profile: &Profile, project: &str, now: i64) -> Vec<ReflectBatch> {
    let declaration = declaration(profile);
    let owner = Owner::Project {
        id: project.to_owned(),
        root: String::new(),
    };
    let context = TaskContext {
        db,
        owner: &owner,
        profile,
        declaration: &declaration,
        workspace: None,
        guidance: None,
        branches: &[],
    };
    let prepared = ReflectEvents
        .prepare(&context, now)
        .unwrap_or_else(|error| panic!("planning the reflect run: {error}"));
    ReflectEvents
        .finish(&context, prepared, &[], None, now)
        .unwrap_or_else(|error| panic!("planning the reflect run: {error}"))
}

fn message(batch: &ReflectBatch) -> String {
    let window = Window {
        counter: Counter::for_model(None),
        context_window: ANY_WINDOW,
    };
    crate::dreamer::run::TaskInput::prompt(batch, window, DREAM_OUTPUT_TOKENS)
        .expect("a reflect message fits a window this large")
}

/// What one message sends, as the senders read it.
fn request(batch: &ReflectBatch, index: usize, task: &str, project: &str, model: &str) -> Value {
    let demand = DREAM_DEMANDS
        .iter()
        .find(|demand| demand.kind == KIND)
        .expect("reflect has a routing demand");
    let system = crate::dreamer::run::TaskInput::system(batch);
    let user = message(batch);
    let counter = Counter::for_model(None);
    json!({
        "task": task,
        "kind": KIND,
        "batch": index,
        "project": project,
        "model": model,
        "settings": {
            "consumer": dream_consumer(KIND),
            "iq": demand.iq,
            "contextWindow": demand.context_window,
            "readsCode": demand.reads_code,
            "maxSteps": demand.max_steps,
            "maxOutputTokens": DREAM_OUTPUT_TOKENS,
            "tools": [],
            "cacheTtl": "short",
        },
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "groups": batch.groups,
        "existingMemories": batch.existing,
        "watermark": batch.watermark(),
        "tokens": {
            "system": counter.count(system),
            "user": counter.count(&user),
            "counted": "the module's estimate for a model it has no vocabulary for",
        },
    })
}

/// What one replay plans: where from, where to, and how much.
struct RequestArgs {
    store: PathBuf,
    project: String,
    out: PathBuf,
    model: String,
    limit: Option<usize>,
    since: Option<i64>,
}

impl RequestArgs {
    fn from_env() -> Self {
        Self {
            store: PathBuf::from(required(
                "REFLECT_REPLAY_STORE",
                "a copy of a context.db (never the live one)",
            )),
            project: required("REFLECT_REPLAY_PROJECT", "the project's id"),
            out: PathBuf::from(required(
                "DREAMER_REPLAY_OUT",
                "a new folder for the replay's output",
            )),
            model: env("DREAMER_REPLAY_MODEL").unwrap_or_else(|| "deepseek-flash".into()),
            limit: env("DREAMER_REPLAY_BATCHES").map(|value| {
                value
                    .parse::<usize>()
                    .expect("DREAMER_REPLAY_BATCHES is a count of messages")
            }),
            since: env("REFLECT_REPLAY_SINCE_EVENT").map(|value| {
                value
                    .parse::<i64>()
                    .expect("REFLECT_REPLAY_SINCE_EVENT is an event id")
            }),
        }
    }
}

/// Plan the project's run on a migrated copy of the store and write its
/// requests and the manifest that lists them.
fn write_requests(args: &RequestArgs) -> Value {
    let RequestArgs {
        store,
        project,
        out,
        model,
        limit,
        since,
    } = args;
    refuse_live(store);
    refuse_live_path(out);
    let copy = out.join("store.db");
    assert!(
        !copy.exists(),
        "{} already holds a replay; write a new one to a fresh DREAMER_REPLAY_OUT",
        out.display()
    );
    std::fs::create_dir_all(out).expect("create the output folder");
    let schema = migrated_copy(store, &copy);
    let db = ContextDb::open(&copy).expect("open the migrated copy");
    let profile = prompt_profile(None).expect("the bundled profile");
    let task = declaration(&profile)["id"]
        .as_str()
        .unwrap_or(KIND)
        .to_owned();
    let now = crate::summary::run::now_ms();
    db.with_connection(|conn| {
        // A run's watermark lives on its schedule row.
        ensure_schedule(conn, &OwnerKey::project(project), &task, "0 5 * * *", now)?;
        if let Some(since) = since {
            conn.execute(
                "UPDATE dream_schedules SET watermark_json = ?3
                  WHERE level = 'project' AND owner_id = ?1 AND task = ?2",
                rusqlite::params![project, task, json!({"event": since}).to_string()],
            )?;
        }
        Ok::<_, rusqlite::Error>(())
    })
    .expect("set the copy's watermark");
    let batches = plan(&db, &profile, project, now);
    let mut listed = Vec::new();
    for (index, batch) in batches.iter().enumerate().take(limit.unwrap_or(usize::MAX)) {
        let path = batch_dir(out, index).join(REQUEST);
        let request = request(batch, index, &task, project, model);
        write_json(&path, &request);
        println!(
            "batch {index}: {} groups, {} existing memories, user ~{} tokens",
            batch.groups.len(),
            batch.existing.len(),
            request["tokens"]["user"]
        );
        listed.push(json!({
            "batch": index,
            "request": format!("{FOLDER}/batch-{index}/{REQUEST}"),
            "groups": batch.groups,
        }));
    }
    let manifest = json!({
        "project": project,
        "store": {"source": store, "schema": schema, "migratedTo": SCHEMA_VERSION, "copy": "store.db"},
        "profile": {"name": profile.name, "version": profile.version, "digest": profile.digest},
        "task": task,
        "model": model,
        "plannedAt": now,
        "sinceEvent": since,
        "planned": batches.len(),
        "batches": listed,
    });
    write_json(&out.join("manifest.json"), &manifest);
    println!(
        "{project}: {} messages planned, {} written to {}",
        batches.len(),
        listed.len(),
        out.display()
    );
    manifest
}

#[test]
#[ignore = "builds reflect replay requests from a copy of a real store; see the module documentation"]
fn reflect_requests() {
    write_requests(&RequestArgs::from_env());
}

/// The text of a reply file: a `send.ts` reply record, a `verify-run.ts`
/// trajectory, or the reply's text itself.
fn reply_text(path: &Path) -> String {
    let text =
        std::fs::read_to_string(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    let Ok(record) = serde_json::from_str::<Value>(&text) else {
        return text;
    };
    if let Some(content) = record["body"]["choices"][0]["message"]["content"].as_str() {
        return content.to_owned();
    }
    if let Some(text) = record["final"]["text"].as_str() {
        return text.to_owned();
    }
    text
}

/// Which reply of a replay to apply.
struct ApplyArgs {
    out: PathBuf,
    index: usize,
    reply: Option<PathBuf>,
}

impl ApplyArgs {
    fn from_env() -> Self {
        Self {
            out: PathBuf::from(required(
                "DREAMER_REPLAY_OUT",
                "the folder reflect_requests wrote",
            )),
            index: required("REFLECT_REPLAY_BATCH", "the batch whose reply to apply")
                .parse()
                .expect("REFLECT_REPLAY_BATCH is a batch number"),
            reply: env("REFLECT_REPLAY_REPLY").map(PathBuf::from),
        }
    }
}

/// Apply one reply of the replay in `args.out` to a throwaway copy of its
/// store, and print and write the report. `None` when the task refuses the
/// reply as a whole.
fn apply_reply(args: &ApplyArgs) -> Option<Value> {
    let ApplyArgs { out, index, reply } = args;
    refuse_live_path(out);
    let manifest = read_json(&out.join("manifest.json"));
    let project = manifest["project"]
        .as_str()
        .expect("the manifest names the project");
    let now = manifest["plannedAt"]
        .as_i64()
        .expect("the manifest names its time");
    let dir = batch_dir(out, *index);
    let request = read_json(&dir.join(REQUEST));
    let reply = reply.clone().unwrap_or_else(|| {
        ["reflect.reply.json", "reflect.trajectory.json"]
            .iter()
            .map(|name| dir.join(name))
            .find(|path| path.exists())
            .unwrap_or_else(|| panic!("{} holds no reply; set REFLECT_REPLAY_REPLY", dir.display()))
    });
    let text = reply_text(&reply);
    // A throwaway copy: the replay's own store stays as the requests saw it.
    let scratch = tempfile::tempdir().expect("a scratch folder");
    let copy = scratch.path().join("applied.db");
    migrated_copy(&out.join("store.db"), &copy);
    let db = ContextDb::open(&copy).expect("open the throwaway copy");
    let profile = prompt_profile(None).expect("the bundled profile");
    let batches = plan(&db, &profile, project, now);
    let batch = batches
        .get(*index)
        .unwrap_or_else(|| panic!("the copy plans only {} messages", batches.len()));
    assert_eq!(
        message(batch),
        request["messages"][1]["content"]
            .as_str()
            .unwrap_or_default(),
        "the copy plans a different message than the one sent"
    );
    let entries = match parse_learnings(&text) {
        Ok(entries) => entries,
        Err(refusal) => {
            println!("the task refuses the reply as a whole: {refusal}");
            return None;
        }
    };
    let child = child_session(&format!("{REPLAY_RUN}.{index}"), 0, 0);
    let written = db
        .with_connection(|conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let written = batch.write(&tx, &entries, &child, REPLAY_RUN)?;
            tx.commit()?;
            Ok::<_, rusqlite::Error>(written)
        })
        .expect("applying the reply");
    let mut learnings = Vec::new();
    for (number, (entry, refusal)) in entries.iter().zip(&written.refusals).enumerate() {
        let (route, category, events, text) = match entry {
            Ok(learning) => (
                learning.route.clone(),
                learning.category.clone(),
                learning
                    .events
                    .iter()
                    .map(|id| format!("e{id}"))
                    .collect::<Vec<_>>(),
                learning.text.clone(),
            ),
            Err(_) => (String::new(), String::new(), Vec::new(), String::new()),
        };
        match refusal {
            None => println!("WRITTEN {route} {category} [{}]: {text}", events.join(",")),
            Some(why) => println!(
                "DROPPED {route} {category} [{}]: {text}\n        why: {why}",
                events.join(",")
            ),
        }
        learnings.push(json!({
            "learning": number + 1,
            "route": route,
            "category": category,
            "events": events,
            "text": text,
            "dropped": refusal,
        }));
    }
    println!("written: {}", written.written.join(", "));
    let report = json!({
        "reply": reply,
        "proposed": written.applied.proposed,
        "applied": written.applied.applied,
        "written": written.written,
        "learnings": learnings,
    });
    write_json(&dir.join("reflect.apply.json"), &report);
    Some(report)
}

#[test]
#[ignore = "applies one reflect replay reply to a throwaway copy of the replay's store; see the module documentation"]
fn reflect_apply() {
    apply_reply(&ApplyArgs::from_env());
}

/// The harness on a fixture: the requests of a store with one group worth
/// sending, and a reply applied to a throwaway copy.
#[test]
fn the_harness_writes_requests_and_applies_a_reply_to_a_copy() {
    use super::tasks::reflect_events::tests::{store, Stored, PROJECT};
    let fixture = store();
    let event = |id: i64, session: &'static str, days_ago: i64| Stored {
        id,
        session,
        kind: "causal_incident",
        key: "environment",
        summary: "The sandbox blocked a write outside the worktree",
        days_ago,
    };
    fixture.events(&[event(1, "ses-a", 2), event(2, "ses-b", 1)]);
    let source = fixture.db.path.clone();
    let before = std::fs::read(&source).unwrap();
    let out = tempfile::tempdir().unwrap();
    let replay = out.path().join("replay");
    let manifest = write_requests(&RequestArgs {
        store: source.clone(),
        project: PROJECT.into(),
        out: replay.clone(),
        model: "deepseek-flash".into(),
        limit: None,
        since: None,
    });
    assert_eq!(manifest["planned"], 1);
    assert_eq!(
        std::fs::read(&source).unwrap(),
        before,
        "the source store was written"
    );
    let request = read_json(&batch_dir(&replay, 0).join(REQUEST));
    assert_eq!(request["kind"], KIND);
    assert_eq!(request["settings"]["maxSteps"], 1);
    assert_eq!(request["groups"][0]["events"], json!([2, 1]));
    let user = request["messages"][1]["content"].as_str().unwrap();
    assert!(user.contains("<group kind=\"incident\" affected_surface=\"environment\" days=\"2\">"));
    std::fs::write(
        batch_dir(&replay, 0).join("reflect.reply.json"),
        json!({"ok": true, "body": {"choices": [{"message": {"content":
            "<learnings>\n<learning route=\"memory\" category=\"CONSTRAINTS\" events=\"e1,e2\">Write only inside the worktree; the sandbox refuses every other path.</learning>\n<learning route=\"memory\" category=\"CONSTRAINTS\" events=\"e1\">One day only.</learning>\n</learnings>"
        }}]}})
        .to_string(),
    )
    .unwrap();
    let store_before = std::fs::read(replay.join("store.db")).unwrap();
    let report = apply_reply(&ApplyArgs {
        out: replay.clone(),
        index: 0,
        reply: None,
    })
    .expect("the reply holds a list");
    assert_eq!(
        std::fs::read(replay.join("store.db")).unwrap(),
        store_before,
        "the replay's store was written"
    );
    assert_eq!(
        report,
        read_json(&batch_dir(&replay, 0).join("reflect.apply.json"))
    );
    assert_eq!(report["applied"], 1);
    assert_eq!(report["learnings"][0]["dropped"], Value::Null);
    assert_eq!(
        report["learnings"][1]["dropped"],
        "the cited events come from 1 day(s), fewer than 2"
    );
}
