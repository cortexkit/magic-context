//! A replay of the `refresh-primers` task on a copy of a real store and a
//! checkout of the project, for reading every request, and every step of
//! the model's work on it, before the task is switched on.
//!
//! Nothing here calls a provider or writes to the store it reads. The
//! ignored test below copies the store it is given through a read-only
//! connection, brings the copy to this build's schema, runs the task's
//! promotion on the copy (by question text, as a run without an embedding
//! provider does), and writes one request per primer the run would refresh
//! as `refresh-primers/primer-<n>/refresh.request.json`: the system and
//! user text, the model settings and the step bound the module's plan gives
//! the run, and the primer. `packages/plugin/scripts/dreamer-replay/verify-run.ts`
//! sends one request with read-only tools over a checkout and writes the
//! whole trajectory beside it (`refresh.trajectory.json`).
//!
//! Paths come from the environment:
//! - `DREAMER_REPLAY_STORE`: a copy of a `context.db`. A path inside the live
//!   data folder (`~/.local/share/cortexkit/`) is refused, and the copy is
//!   opened read-only.
//! - `DREAMER_REPLAY_CHECKOUT`: a checkout of the project, which the
//!   requests name for the runner. A path inside the live data folder is
//!   refused.
//! - `DREAMER_REPLAY_PROJECT`: the project's id, as its primers name it.
//! - `DREAMER_REPLAY_OUT`: a new folder for the output: `store.db` (the
//!   migrated, promoted copy), `manifest.json` and `refresh-primers/`.
//! - `DREAMER_REPLAY_MODEL` (optional): the model a request names;
//!   `deepseek-flash` by default.
//! - `PRIMER_REPLAY_LIMIT` (optional): how many stale primers to write, in
//!   the run's order. Without it, the run's own [`PER_RUN`].

use std::path::PathBuf;

use serde_json::{json, Value};

use super::curate_replay_tests::{migrated_copy, refuse_live};
use super::reflect_replay_tests::refuse_live_path;
use super::task::{Owner, TaskContext};
use super::tasks::refresh_primers::{RefreshBatch, RefreshPrimers, KIND, PER_RUN};
use super::verify_replay_tests::{env, required, write_json, ANY_WINDOW};
use crate::context_db::ContextDb;
use crate::context_migrations::SCHEMA_VERSION;
use crate::count::Counter;
use crate::memory_profile::prompt_profile;
use crate::routing::{DREAM_DEMANDS, DREAM_OUTPUT_TOKENS};
use crate::summary::fit::Window;

/// Each primer's request, inside its `primer-<n>` folder.
const REQUEST: &str = "refresh.request.json";

/// What one replay plans.
struct Args {
    store: PathBuf,
    checkout: String,
    project: String,
    out: PathBuf,
    model: String,
    limit: usize,
}

impl Args {
    fn from_env() -> Self {
        Self {
            store: PathBuf::from(required("DREAMER_REPLAY_STORE", "a copy of a context.db")),
            checkout: required("DREAMER_REPLAY_CHECKOUT", "a checkout of the project"),
            project: required("DREAMER_REPLAY_PROJECT", "the project's id in the store"),
            out: PathBuf::from(required(
                "DREAMER_REPLAY_OUT",
                "a new folder for the output",
            )),
            model: env("DREAMER_REPLAY_MODEL").unwrap_or_else(|| "deepseek-flash".into()),
            limit: env("PRIMER_REPLAY_LIMIT").map_or(PER_RUN, |value| {
                value
                    .parse::<usize>()
                    .expect("PRIMER_REPLAY_LIMIT is a count of primers")
            }),
        }
    }
}

/// What the child session that refreshes one primer is sent, as the runner
/// reads it.
fn request(batch: &RefreshBatch, index: usize, task: &str, args: &Args) -> Value {
    let demand = DREAM_DEMANDS
        .iter()
        .find(|demand| demand.kind == KIND)
        .expect("refresh-primers has a routing demand");
    let window = Window {
        counter: Counter::for_model(None),
        context_window: ANY_WINDOW,
    };
    let user = crate::dreamer::run::TaskInput::prompt(batch, window, DREAM_OUTPUT_TOKENS)
        .expect("a primer's message fits a window this large");
    let system = crate::dreamer::run::TaskInput::system(batch);
    let counter = Counter::for_model(None);
    let primer = &batch.primer;
    json!({
        "task": task,
        "kind": KIND,
        "batch": index,
        "project": args.project,
        "checkout": args.checkout,
        "model": args.model,
        // What the module asks the runner for: a reply of at most this many
        // tokens, at most this many model steps, and AFT's read-only reader
        // tools in the project's folder.
        "settings": {
            "maxOutputTokens": DREAM_OUTPUT_TOKENS,
            "maxSteps": demand.max_steps,
            "tools": "aft reader preset (read, grep, glob, and AFT's navigation tools)",
        },
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "primer": {
            "id": primer.id,
            "question": primer.question,
            "answer": primer.answer,
            "answerRefreshedAt": primer.answer_refreshed_at,
            "lastObservedAt": primer.last_observed_at,
            "support": primer.support,
            "sources": primer.sources,
        },
        "tokens": {
            "system": counter.count(system),
            "user": counter.count(&user),
            "counted": "the module's estimate for a model it has no vocabulary for",
        },
    })
}

/// Promote on a copy of the store and write a request per primer the run
/// would refresh; the manifest, written last, lists them.
fn write_requests(args: &Args) -> Value {
    let out = &args.out;
    refuse_live(&args.store);
    refuse_live_path(out);
    refuse_live_path(std::path::Path::new(&args.checkout));
    assert!(
        !out.exists()
            || std::fs::read_dir(out)
                .expect("read the output folder")
                .next()
                .is_none(),
        "{} is not empty; write a replay to a new folder",
        out.display()
    );
    std::fs::create_dir_all(out).expect("create the output folder");
    let copy = out.join("store.db");
    let schema = migrated_copy(&args.store, &copy);
    let db = ContextDb::open(&copy).expect("open the store copy");
    let profile = prompt_profile(None).expect("the bundled profile");
    let declaration = profile.body["tasks"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|task| task["kind"] == KIND)
        .cloned()
        .unwrap_or_else(|| panic!("the bundled profile declares no {KIND} task"));
    let task = declaration["id"].as_str().unwrap_or(KIND).to_owned();
    let owner = Owner::Project {
        id: args.project.clone(),
        root: args.checkout.clone(),
    };
    let context = TaskContext {
        db: &db,
        owner: &owner,
        profile: &profile,
        declaration: &declaration,
        workspace: None,
        guidance: None,
    };
    let promoted = RefreshPrimers
        .promote_by_text(&context)
        .unwrap_or_else(|error| panic!("promoting: {error}"));
    let batches = RefreshPrimers
        .refresh_up_to(&context, args.limit)
        .unwrap_or_else(|error| panic!("planning {task}: {error}"));
    let mut written = Vec::new();
    for (index, batch) in batches.iter().enumerate() {
        let path = out.join(KIND).join(format!("primer-{index}")).join(REQUEST);
        write_json(&path, &request(batch, index, &task, args));
        written.push(json!({
            "batch": index,
            "request": format!("{KIND}/primer-{index}/{REQUEST}"),
            "primer": batch.primer.id,
            "question": batch.primer.question,
        }));
    }
    println!(
        "{task}: {} candidates, {} promoted, {} updated; {} requests written to {}",
        promoted.candidates,
        promoted.promoted,
        promoted.updated,
        written.len(),
        out.join(KIND).display()
    );
    let manifest = json!({
        "project": args.project,
        "checkout": args.checkout,
        "store": {"source": args.store, "schema": schema, "migratedTo": SCHEMA_VERSION, "copy": "store.db"},
        "profile": {"name": profile.name, "version": profile.version, "digest": profile.digest},
        "model": args.model,
        "task": task,
        "promotion": {
            "candidates": promoted.candidates,
            "promoted": promoted.promoted,
            "updated": promoted.updated,
        },
        "primers": written,
    });
    write_json(&out.join("manifest.json"), &manifest);
    manifest
}

#[test]
#[ignore = "plans refresh-primers replay requests from a store copy and a checkout; see packages/plugin/scripts/dreamer-replay/README.md"]
fn primer_requests() {
    write_requests(&Args::from_env());
}

/// The harness on a fixture: a question asked on two days a week apart
/// becomes a primer on the copy, and its request is written.
#[test]
fn the_harness_promotes_on_the_copy_and_writes_each_primers_request() {
    use super::tasks::refresh_primers::promote::tests::insert_candidate;
    use super::tasks::refresh_primers::promote::Candidate;
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("context.db");
    let db = ContextDb::create_for_tests(&source).unwrap();
    let now = crate::summary::run::now_ms();
    let day = 24 * 60 * 60 * 1000;
    db.with_connection(|conn| {
        for (id, days) in [(1, 20), (2, 10)] {
            insert_candidate(
                conn,
                &Candidate {
                    id,
                    project: "pj-replay".into(),
                    harness: "opencode".into(),
                    session: format!("ses-{id}"),
                    question: "How does the lease expire".into(),
                    normalized: "how does the lease expire".into(),
                    compartment_start: Some(1),
                    compartment_end: Some(2),
                    start_message_id: "a".into(),
                    end_message_id: "b".into(),
                    source_time: now - days * day,
                    embedding: None,
                    model: None,
                },
            );
        }
    });
    drop(db);
    let before = std::fs::read(&source).unwrap();
    let checkout = dir.path().join("checkout");
    std::fs::create_dir_all(&checkout).unwrap();
    let args = Args {
        store: source.clone(),
        checkout: checkout.to_str().unwrap().to_owned(),
        project: "pj-replay".into(),
        out: dir.path().join("replay"),
        model: "deepseek-flash".into(),
        limit: PER_RUN,
    };
    let manifest = write_requests(&args);
    assert_eq!(
        std::fs::read(&source).unwrap(),
        before,
        "the source store was written"
    );
    assert_eq!(manifest["promotion"]["promoted"], 1);
    let request: Value = serde_json::from_str(
        &std::fs::read_to_string(
            args.out
                .join("refresh-primers/primer-0/refresh.request.json"),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(request["kind"], "refresh-primers");
    assert_eq!(request["settings"]["maxSteps"], 40);
    assert_eq!(request["primer"]["question"], "How does the lease expire?");
    let user = request["messages"][1]["content"].as_str().unwrap();
    assert!(user.contains("<current-answer>\nnone yet\n</current-answer>"));
    assert!(user.contains("not what is true now.\nnone\n</orientation>"));
}
