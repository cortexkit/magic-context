//! A replay of the `maintain-docs` task on a real project, for reading the
//! request it sends, every step of the model's work on it, and what the
//! module keeps of the answer, before the task runs on its own.
//!
//! Nothing here calls a provider, and nothing writes to the store or the
//! checkout it reads. The first ignored test plans the task on a copy of a
//! store and the project's checkout, as a run plans it, with a commit the
//! person names standing in for the commit the task last processed, and
//! writes the request as `<out>/maintain-docs/run-0/docs.request.json`: the
//! system and user text, the model settings, and the commits it reads
//! between. `packages/plugin/scripts/dreamer-replay/verify-run.ts` runs it
//! with read-only tools over the same checkout and writes
//! `docs.trajectory.json` beside it. The second applies a reply to a
//! throwaway copy of the replay's store with the task's own checks, and
//! prints each kept change, each dropped one with its reason, and the diff
//! of each document the proposal leads to.
//!
//! Paths come from the environment:
//! - `DOCS_REPLAY_STORE`: a copy of a `context.db`, opened read-only and
//!   copied to `<out>/store.db` (a store at an earlier schema is migrated
//!   there). A store, checkout or output folder inside the live data folder
//!   (`~/.local/share/cortexkit/`) is refused.
//! - `DOCS_REPLAY_CHECKOUT`: the project's git checkout; its main checkout
//!   is read, as a run reads it.
//! - `DOCS_REPLAY_PROJECT`: the project's id in the store.
//! - `DOCS_REPLAY_FROM_COMMIT`: the commit the change is read from, in place
//!   of the task's watermark.
//! - `DREAMER_REPLAY_OUT`: a new or empty folder for the output.
//! - `DREAMER_REPLAY_MODEL` (optional): the model the request names;
//!   `deepseek-flash` by default.
//! - `DOCS_REPLAY_REPLY` (second test, optional): the reply file. Without
//!   it the run's `docs.reply.json` or `docs.trajectory.json` is read.

use std::path::{Path, PathBuf};

use rusqlite::TransactionBehavior;
use serde_json::{json, Value};

use super::curate_replay_tests::{migrated_copy, refuse_live};
use super::reflect_replay_tests::refuse_live_path;
use super::run::TaskInput;
use super::store::{self, OwnerKey};
use super::task::{Batch, Owner, TaskContext};
use super::tasks::maintain_docs::{self, edits, DocsBatch, MaintainDocs, Planned, KIND};
use super::verify_replay_tests::{env, required, write_json, ANY_WINDOW};
use crate::context_db::ContextDb;
use crate::count::Counter;
use crate::memory_profile::{prompt_profile, Profile};
use crate::routing::{DREAM_DEMANDS, DREAM_OUTPUT_TOKENS};
use crate::summary::fit::Window;

/// The run's folder, and its request inside it.
const RUN: &str = "maintain-docs/run-0";
const REQUEST: &str = "docs.request.json";

fn read_json(path: &Path) -> Value {
    let text =
        std::fs::read_to_string(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

/// The profile's `swe:maintain-docs` declaration.
fn declaration(profile: &Profile) -> Value {
    profile.body["tasks"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|task| task["kind"] == KIND)
        .cloned()
        .expect("the bundled profile declares the docs task")
}

/// Plan the task on `db` for `project` in `checkout`, with `from` as the
/// commit it last processed. The project's pending proposals in the copy
/// are set aside first, so planning never judges one against the checkout
/// (which would remove its markdown copy there).
fn plan(db: &ContextDb, profile: &Profile, project: &str, checkout: &str, from: &str) -> Planned {
    let declaration = declaration(profile);
    let task = declaration["id"].as_str().unwrap_or(KIND).to_owned();
    db.with_connection(|conn| {
        store::ensure_schedule(conn, &OwnerKey::project(project), &task, "30 5 * * *", 0)?;
        maintain_docs::write_commit(conn, project, &task, from)?;
        conn.execute(
            "UPDATE docs_proposals SET status = 'stale' WHERE project = ?1 AND status = 'pending'",
            [project],
        )
        .map(drop)
    })
    .expect("prepare the store copy");
    let owner = Owner::Project {
        id: project.to_owned(),
        root: checkout.to_owned(),
    };
    MaintainDocs::default()
        .planned(&TaskContext {
            db,
            owner: &owner,
            profile,
            declaration: &declaration,
            workspace: None,
            guidance: None,
            branches: &[],
        })
        .unwrap_or_else(|error| panic!("planning the docs task: {error}"))
}

/// What the run sends, as the runner reads it.
fn request(batch: &DocsBatch, args: &Args, commit: &str) -> Value {
    let demand = DREAM_DEMANDS
        .iter()
        .find(|demand| demand.kind == KIND)
        .expect("the docs task has a routing demand");
    let window = Window {
        counter: Counter::for_model(None),
        context_window: ANY_WINDOW,
    };
    let user = batch
        .prompt(window, DREAM_OUTPUT_TOKENS)
        .expect("the request fits a window this large");
    let counter = Counter::for_model(None);
    json!({
        "task": "swe:maintain-docs",
        "kind": KIND,
        "batch": 0,
        "project": args.project,
        "checkout": batch.folder(),
        "fromCommit": args.from,
        "commit": commit,
        "model": args.model,
        // What the module asks the runner for: a reply of at most this many
        // tokens, at most this many model steps, and the reader tools in the
        // main checkout.
        "settings": {
            "maxOutputTokens": DREAM_OUTPUT_TOKENS,
            "maxSteps": demand.max_steps,
            "tools": "aft reader preset (read, grep, glob, and AFT's navigation tools)",
        },
        "messages": [
            {"role": "system", "content": batch.system()},
            {"role": "user", "content": user},
        ],
        "tokens": {
            "system": counter.count(batch.system()),
            "user": counter.count(&user),
            "counted": "the module's estimate for a model it has no vocabulary for",
        },
    })
}

/// What one replay plans.
struct Args {
    store: PathBuf,
    checkout: String,
    project: String,
    from: String,
    out: PathBuf,
    model: String,
}

impl Args {
    fn from_env() -> Self {
        Self {
            store: PathBuf::from(required("DOCS_REPLAY_STORE", "a copy of a context.db")),
            checkout: required("DOCS_REPLAY_CHECKOUT", "the project's git checkout"),
            project: required("DOCS_REPLAY_PROJECT", "the project's id in the store"),
            from: required(
                "DOCS_REPLAY_FROM_COMMIT",
                "the commit to read the change from",
            ),
            out: PathBuf::from(required(
                "DREAMER_REPLAY_OUT",
                "a new folder for the output",
            )),
            model: env("DREAMER_REPLAY_MODEL").unwrap_or_else(|| "deepseek-flash".into()),
        }
    }
}

/// Plan the run on a copy of the store and write its request, or why it
/// sends none; the manifest, which says which.
fn write_requests(args: &Args) -> Value {
    refuse_live(&args.store);
    refuse_live(Path::new(&args.checkout));
    refuse_live_path(&args.out);
    let out = &args.out;
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
    let planned = plan(&db, &profile, &args.project, &args.checkout, &args.from);
    let mut manifest = json!({
        "project": args.project,
        "checkout": args.checkout,
        "fromCommit": args.from,
        "store": {"source": args.store, "copy": "store.db", "schema": schema},
        "profile": {"name": profile.name, "version": profile.version, "digest": profile.digest},
        "model": args.model,
    });
    match planned {
        Planned::Skip(reason) => {
            println!("no request: {reason}");
            manifest["skipped"] = json!(reason);
        }
        Planned::Batch(batch) => {
            let commit = crate::dreamer::checkout::run_git_within(
                Path::new(batch.folder().expect("the run reads the main checkout")),
                &["rev-parse", "HEAD"],
                crate::dreamer::checkout::GIT_TIMEOUT,
            )
            .expect("the main checkout's commit")
            .trim()
            .to_owned();
            let path = out.join(RUN).join(REQUEST);
            write_json(&path, &request(&batch, args, &commit));
            println!("request written to {}", path.display());
            manifest["commit"] = json!(commit);
            manifest["request"] = json!(format!("{RUN}/{REQUEST}"));
        }
    }
    write_json(&out.join("manifest.json"), &manifest);
    manifest
}

#[test]
#[ignore = "builds a docs-upkeep replay request from a copy of a real store and a checkout; see the module documentation"]
fn docs_requests() {
    write_requests(&Args::from_env());
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

/// Apply the reply of the replay in `out` (from `reply`, or the run's own
/// reply files) to a throwaway copy of its store, and print and write the
/// report (`docs.apply.json`). `None` when the task refuses the reply as a
/// whole.
fn apply_reply(out: &Path, reply: Option<PathBuf>) -> Option<Value> {
    refuse_live_path(out);
    let manifest = read_json(&out.join("manifest.json"));
    let field = |name: &str| {
        manifest[name]
            .as_str()
            .unwrap_or_else(|| panic!("the manifest names no {name}"))
            .to_owned()
    };
    let (project, checkout, from) = (field("project"), field("checkout"), field("fromCommit"));
    let dir = out.join(RUN);
    let request = read_json(&dir.join(REQUEST));
    let reply = reply.unwrap_or_else(|| {
        ["docs.reply.json", "docs.trajectory.json"]
            .iter()
            .map(|name| dir.join(name))
            .find(|path| path.exists())
            .unwrap_or_else(|| panic!("{} holds no reply; set DOCS_REPLAY_REPLY", dir.display()))
    });
    let text = reply_text(&reply);
    // A throwaway copy: the replay's own store stays as the request saw it.
    let scratch = tempfile::tempdir().expect("a scratch folder");
    let copy = scratch.path().join("applied.db");
    migrated_copy(&out.join("store.db"), &copy);
    let db = ContextDb::open(&copy).expect("open the throwaway copy");
    let profile = prompt_profile(None).expect("the bundled profile");
    let Planned::Batch(batch) = plan(&db, &profile, &project, &checkout, &from) else {
        panic!("the copy plans no request now; the checkout moved since the replay");
    };
    let window = Window {
        counter: Counter::for_model(None),
        context_window: ANY_WINDOW,
    };
    assert_eq!(
        batch.prompt(window, DREAM_OUTPUT_TOKENS).as_deref(),
        request["messages"][1]["content"].as_str(),
        "the copy plans a different message than the one sent"
    );
    let answer = match edits::parse_answer(&text) {
        Ok(answer) => answer,
        Err(refusal) => {
            println!("the task refuses the reply as a whole: {refusal}");
            return None;
        }
    };
    // Only the transaction: the markdown copy and the notices that follow a
    // real run's are left out, so the checkout is never written.
    let applied = db
        .with_connection(|conn| -> Result<_, String> {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| error.to_string())?;
            let applied = batch.write(&tx, &answer, None, crate::memory_writes::now_ms())?;
            tx.commit().map_err(|error| error.to_string())?;
            Ok(applied)
        })
        .expect("applying the reply");
    let proposal = db
        .with_connection(|conn| crate::docs_proposals::pending_of(conn, &project))
        .expect("read the proposal");
    let mut kept = Vec::new();
    let mut diffs = Vec::new();
    if let Some(proposal) = &proposal {
        for change in &proposal.changes {
            println!(
                "KEPT {} {} {}\n        why: {}",
                change.file, change.action, change.heading, change.reason
            );
            kept.push(json!(change));
        }
        let body: Value = serde_json::from_str(&proposal.body).expect("the body is JSON");
        for document in body["documents"].as_array().into_iter().flatten() {
            println!("{}", document["diff"].as_str().unwrap_or_default());
            diffs.push(document.clone());
        }
    }
    for dropped in &applied.dropped {
        println!("DROPPED {dropped}");
    }
    let report = json!({
        "reply": reply,
        "proposed": applied.proposed,
        "kept": kept,
        "dropped": applied.dropped,
        "documents": diffs,
    });
    write_json(&dir.join("docs.apply.json"), &report);
    Some(report)
}

#[test]
#[ignore = "applies a docs-upkeep replay reply to a throwaway copy of the replay's store; see the module documentation"]
fn docs_apply() {
    apply_reply(
        &PathBuf::from(required(
            "DREAMER_REPLAY_OUT",
            "the folder docs_requests wrote",
        )),
        env("DOCS_REPLAY_REPLY").map(PathBuf::from),
    );
}

/// The harness on a fixture: a request from a named commit, and a reply
/// applied to a throwaway copy, with the store and checkout left alone.
#[test]
fn the_harness_writes_the_request_and_applies_a_reply_without_writing_the_store() {
    use super::tasks::maintain_docs::tests::{changed, replacement, Fixture, PROJECT};
    let fixture = Fixture::documented();
    changed(&fixture);
    let from = fixture.repo.git(&["rev-parse", "HEAD~1"]).trim().to_owned();
    // The watermark the store holds is not the one the replay reads from.
    fixture.record(&fixture.head());
    let store = fixture.db.path.clone();
    let before = std::fs::read(&store).unwrap();
    let out = tempfile::tempdir().unwrap();
    let args = Args {
        store: store.clone(),
        checkout: fixture.repo.path().to_str().unwrap().to_owned(),
        project: PROJECT.to_owned(),
        from: from.clone(),
        out: out.path().join("replay"),
        model: "deepseek-flash".into(),
    };
    let manifest = write_requests(&args);
    assert_eq!(manifest["request"], "maintain-docs/run-0/docs.request.json");
    assert_eq!(manifest["commit"], fixture.head());
    let request = read_json(&args.out.join(RUN).join(REQUEST));
    assert_eq!(request["kind"], "maintain-docs");
    assert_eq!(request["fromCommit"], from);
    assert_eq!(request["settings"]["maxSteps"], 60);
    assert!(request["messages"][1]["content"]
        .as_str()
        .unwrap()
        .contains("<code-changes>\nChanged files:\nsrc/parser.rs"));
    // A reply as verify-run.ts writes it.
    write_json(
        &args.out.join(RUN).join("docs.trajectory.json"),
        &json!({"final": {"text": format!("```json\n{}\n```", replacement()), "completeManifest": true}}),
    );
    let report = apply_reply(&args.out, None).unwrap();
    assert_eq!(report["proposed"], 1);
    assert_eq!(report["kept"][0]["heading"], "## Core");
    assert!(report["documents"][0]["diff"]
        .as_str()
        .unwrap()
        .contains("+The parser lives in src/parse/ now."));
    assert_eq!(
        std::fs::read(&store).unwrap(),
        before,
        "the source store was written"
    );
    assert!(
        !crate::docs_proposals::file::path(fixture.repo.path(), 1).exists(),
        "the replay writes nothing into the checkout"
    );
    assert_eq!(
        fixture.repo.git(&["status", "--porcelain"]).trim(),
        "",
        "the checkout is untouched"
    );
}
