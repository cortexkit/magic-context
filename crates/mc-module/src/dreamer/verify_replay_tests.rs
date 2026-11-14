//! A replay of the `verify` and `verify-broad` tasks on a real project, for
//! reading every request, and every step of the model's work on it, before
//! the tasks are switched on.
//!
//! Nothing here calls a provider. The ignored test below plans each task on
//! a copy of a store and the project's checkout, exactly as a run plans it,
//! and writes each batch's request as `<out>/<kind>/batch-<n>/verify.request.json`:
//! the system and user text the module sends, the model settings it sends
//! them with, and the memories the batch read. The runner in
//! `packages/plugin/scripts/dreamer-replay/` sends one request with
//! read-only tools over the same checkout and writes the whole trajectory
//! beside it.
//!
//! Paths come from the environment:
//! - `DREAMER_REPLAY_STORE`: a copy of a `context.db`. It is read, never
//!   written: the test copies it to `<out>/store.db` and plans on that copy
//!   (a store at the plugin's last schema is migrated there).
//! - `DREAMER_REPLAY_CHECKOUT`: the project's git checkout.
//! - `DREAMER_REPLAY_PROJECT`: the project's id in the store (`owner_id`).
//! - `DREAMER_REPLAY_OUT`: a new or empty folder for the output.
//! - `DREAMER_REPLAY_KINDS` (optional): the kinds to plan, comma-separated;
//!   both by default.
//! - `DREAMER_REPLAY_MODEL` (optional): the model the request names for the
//!   runner; `deepseek-flash` by default.
//! - `DREAMER_REPLAY_BATCHES` (optional): write at most this many batches
//!   per kind.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};

use super::task::{Owner, TaskContext};
use super::tasks::verify::{Verify, VerifyBatch, VERIFY, VERIFY_BROAD};
use crate::context_db::ContextDb;
use crate::count::Counter;
use crate::memory_profile::prompt_profile;
use crate::routing::{DREAM_DEMANDS, DREAM_OUTPUT_TOKENS};
use crate::summary::fit::Window;

/// Each batch's request, inside its `batch-<n>` folder.
const REQUEST: &str = "verify.request.json";
/// A window large enough for any batch, so the message written is the one
/// every model that can take it is sent.
pub(super) const ANY_WINDOW: u64 = 10_000_000;

pub(super) fn env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

pub(super) fn required(name: &str, what: &str) -> String {
    env(name).unwrap_or_else(|| panic!("set {name} to {what}"))
}

pub(super) fn write_json(path: &Path, value: &Value) {
    std::fs::create_dir_all(path.parent().expect("a file has a folder")).expect("create folder");
    let text = serde_json::to_string_pretty(value).expect("JSON serializes") + "\n";
    std::fs::write(path, text).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
}

/// Copy the store at `from` to `to` through a read-only connection.
fn copy_store(from: &Path, to: &Path) {
    let source = Connection::open_with_flags(from, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .unwrap_or_else(|error| panic!("{}: {error}", from.display()));
    source
        .execute(
            "VACUUM INTO ?1",
            [to.to_str().expect("the output folder's path is UTF-8")],
        )
        .unwrap_or_else(|error| panic!("copying {}: {error}", from.display()));
}

/// What one batch sends, as the runner reads it.
fn request(
    batch: &VerifyBatch,
    index: usize,
    task: &str,
    kind: &str,
    project: &str,
    checkout: &str,
    model: &str,
) -> Value {
    let demand = DREAM_DEMANDS
        .iter()
        .find(|demand| demand.kind == kind)
        .expect("each verify kind has a routing demand");
    let window = Window {
        counter: Counter::for_model(None),
        context_window: ANY_WINDOW,
    };
    let user = crate::dreamer::run::TaskInput::prompt(batch, window, DREAM_OUTPUT_TOKENS)
        .expect("a verify batch fits a window this large");
    let system = crate::dreamer::run::TaskInput::system(batch);
    let counter = Counter::for_model(None);
    json!({
        "task": task,
        "kind": kind,
        "batch": index,
        "project": project,
        "checkout": checkout,
        "commit": batch.commit(),
        "model": model,
        // What the module asks the runner for: a reply of at most this many
        // tokens (less when the model's own limit is lower), at most this
        // many model steps, and AFT's read-only reader tools in the
        // project's folder.
        "settings": {
            "maxOutputTokens": DREAM_OUTPUT_TOKENS,
            "maxSteps": demand.max_steps,
            "tools": "aft reader preset (read, grep, glob, and AFT's navigation tools)",
        },
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "memories": batch
            .read()
            .iter()
            .map(|read| json!({"id": read.id, "readRevision": read.revision, "files": read.files}))
            .collect::<Vec<_>>(),
        "diff": batch.has_diff(),
        "search": batch.search().map(|search| json!({
            "names": search.names,
            "filesRead": search.files,
            "cut": search.cut,
            "elapsedMs": search.elapsed_ms,
        })),
        "tokens": {
            "system": counter.count(system),
            "user": counter.count(&user),
            "counted": "the module's estimate for a model it has no vocabulary for",
        },
    })
}

/// What one replay plans: where from, where to, and how much.
struct Args {
    store: PathBuf,
    checkout: String,
    project: String,
    out: PathBuf,
    kinds: Vec<String>,
    model: String,
    limit: Option<usize>,
}

impl Args {
    fn from_env() -> Self {
        Self {
            store: PathBuf::from(required("DREAMER_REPLAY_STORE", "a copy of a context.db")),
            checkout: required("DREAMER_REPLAY_CHECKOUT", "the project's git checkout"),
            project: required("DREAMER_REPLAY_PROJECT", "the project's id in the store"),
            out: PathBuf::from(required(
                "DREAMER_REPLAY_OUT",
                "a new folder for the output",
            )),
            kinds: env("DREAMER_REPLAY_KINDS").map_or_else(
                || vec![VERIFY.to_owned(), VERIFY_BROAD.to_owned()],
                |value| {
                    value
                        .split(',')
                        .map(|kind| kind.trim().to_owned())
                        .collect()
                },
            ),
            model: env("DREAMER_REPLAY_MODEL").unwrap_or_else(|| "deepseek-flash".into()),
            limit: env("DREAMER_REPLAY_BATCHES").map(|value| {
                value
                    .parse::<usize>()
                    .expect("DREAMER_REPLAY_BATCHES is a count of batches")
            }),
        }
    }
}

/// Plan each kind on a copy of the store and write its requests; the
/// manifest written last, which lists them.
fn write_requests(args: &Args) -> Value {
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
    copy_store(&args.store, &copy);
    let db = ContextDb::open(&copy).expect("open the store copy");
    let profile = prompt_profile(None).expect("the bundled profile");
    let owner = Owner::Project {
        id: args.project.clone(),
        root: args.checkout.clone(),
    };
    let mut listed = Vec::new();
    for kind in &args.kinds {
        let broad = match kind.as_str() {
            VERIFY => false,
            VERIFY_BROAD => true,
            other => panic!("{other} is not a verify kind"),
        };
        let declaration = profile.body["tasks"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|task| task["kind"] == kind.as_str())
            .cloned()
            .unwrap_or_else(|| panic!("the bundled profile declares no {kind} task"));
        let task = declaration["id"].as_str().unwrap_or(kind).to_owned();
        let batches = Verify { broad }
            .plan_batches(&TaskContext {
                db: &db,
                owner: &owner,
                profile: &profile,
                declaration: &declaration,
                workspace: None,
            })
            .unwrap_or_else(|error| panic!("planning {task}: {error}"));
        let planned = batches.len();
        let mut written = Vec::new();
        for (index, batch) in batches
            .iter()
            .enumerate()
            .take(args.limit.unwrap_or(usize::MAX))
        {
            let path = out.join(kind).join(format!("batch-{index}")).join(REQUEST);
            write_json(
                &path,
                &request(
                    batch,
                    index,
                    &task,
                    kind,
                    &args.project,
                    &args.checkout,
                    &args.model,
                ),
            );
            written.push(json!({
                "batch": index,
                "request": format!("{kind}/batch-{index}/{REQUEST}"),
                "memories": batch.read().iter().map(|read| read.id).collect::<Vec<_>>(),
                "diff": batch.has_diff(),
            }));
        }
        println!(
            "{task}: {planned} batches planned, {} written to {}",
            written.len(),
            out.join(kind).display()
        );
        listed.push(json!({"task": task, "kind": kind, "planned": planned, "batches": written}));
    }
    let manifest = json!({
        "project": args.project,
        "checkout": args.checkout,
        "store": {"source": args.store, "copy": "store.db"},
        "profile": {"name": profile.name, "version": profile.version, "digest": profile.digest},
        "model": args.model,
        "tasks": listed,
    });
    write_json(&out.join("manifest.json"), &manifest);
    manifest
}

#[test]
#[ignore = "plans verify replay requests from a store copy and a checkout; see packages/plugin/scripts/dreamer-replay/README.md"]
fn verify_requests() {
    write_requests(&Args::from_env());
}

/// The harness on a fixture: a store with a mapped memory changed since
/// its verification and an unmapped one, next to a checkout. Run with
/// `--nocapture` to see a whole request.
#[test]
fn the_harness_writes_each_batchs_request_and_leaves_the_store_alone() {
    use super::tasks::verify::tests::{row, Fixture, Row, PROJECT};
    let fixture = Fixture::new(&[
        ("src/timer.rs", "pub fn start_dream_timer() {}\n"),
        ("src/live.rs", "fn live_function() {}\n"),
    ]);
    let first = fixture.repo.git(&["rev-parse", "HEAD"]).trim().to_owned();
    fixture
        .repo
        .write(&[("src/timer.rs", "pub fn start_dream_timer(every: u64) {}\n")]);
    fixture.repo.commit("the timer takes its interval");
    fixture.insert(&[
        Row {
            files: vec!["src/timer.rs"],
            verified: Some((1_000, Some(first))),
            ..row(1, "`start_dream_timer` in src/timer.rs takes no arguments.")
        },
        row(
            2,
            "`legacy_dream_queue` in src/queue.rs orders dream tasks.",
        ),
    ]);
    let store = fixture.db.path.clone();
    let before = std::fs::read(&store).unwrap();
    let out = tempfile::tempdir().unwrap();
    let args = Args {
        store: store.clone(),
        checkout: fixture.repo.path().to_str().unwrap().to_owned(),
        project: PROJECT.to_owned(),
        out: out.path().join("replay"),
        kinds: vec![VERIFY.to_owned(), VERIFY_BROAD.to_owned()],
        model: "deepseek-flash".into(),
        limit: None,
    };
    let manifest = write_requests(&args);
    assert_eq!(
        std::fs::read(&store).unwrap(),
        before,
        "the source store was written"
    );
    assert_eq!(manifest["tasks"][0]["planned"], 1);
    assert_eq!(manifest["tasks"][1]["planned"], 1);
    let read = |path: &str| -> Value {
        serde_json::from_str(&std::fs::read_to_string(args.out.join(path)).unwrap()).unwrap()
    };
    let diff = read("verify/batch-0/verify.request.json");
    assert_eq!(
        (diff["diff"].clone(), diff["memories"][0]["id"].clone()),
        (json!(true), json!(1))
    );
    assert!(diff["messages"][1]["content"]
        .as_str()
        .unwrap()
        .contains("+pub fn start_dream_timer(every: u64) {}"));
    let broad = read("verify-broad/batch-0/verify.request.json");
    assert_eq!(broad["settings"]["maxSteps"], 60);
    assert_eq!(broad["model"], "deepseek-flash");
    assert_eq!(broad["memories"][0]["id"], 2, "everything it cites is gone");
    let user = broad["messages"][1]["content"].as_str().unwrap();
    assert!(user
        .contains("Not found by a plain search of the checkout: legacy_dream_queue, src/queue.rs"));
    println!("{}", serde_json::to_string_pretty(&broad).unwrap());
}
