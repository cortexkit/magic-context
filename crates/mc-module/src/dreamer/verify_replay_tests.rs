//! A replay of the `verify` and `verify-broad` tasks on a real project, for
//! reading every request, and every step of the model's work on it, before
//! the tasks are switched on.
//!
//! Nothing here calls a provider. The ignored test below plans each task on
//! a copy of a store and the project's checkout, exactly as a run plans it,
//! and writes each batch's request as `<out>/<kind>/batch-<n>/verify.request.json`:
//! the system and user text the module sends, the model settings it sends
//! them with, and the memories the batch read. Planning writes to the copy
//! what a run's planning writes: a confirmed memory whose cited lines are
//! unchanged is recorded there as confirmed at the checkout's commit, and
//! gets no request. The runner in
//! `packages/plugin/scripts/dreamer-replay/` sends one request with
//! read-only tools over the same checkout and writes the whole trajectory
//! beside it.
//!
//! A second ignored test, [`verify_apply`], reads the replies the runner
//! saved (each batch's `verify.trajectory.json`, its final message) and
//! decides every verdict the way the module's write decides it, without
//! writing anything: the module's manifest parse, then every check the write
//! runs, in a transaction on `<out>/store.db` (opened read-only) that is
//! rolled back. For a confirmation those are the cited lines read with git
//! at the batch's commit, the checks that they hold every name that looks
//! like code and every number the memory states and that a `derive`'s
//! arithmetic holds from numbers they hold, and the live-branch check for a
//! memory without a line of its own ([`super::tasks::verify`]). For every
//! verdict they are the gates before a write: the memory unchanged and in a
//! covered category, a protected memory never archived, the update and
//! archive rules, and the live-branch gate on a rewrite or archive of a
//! memory without a line of its own. It writes one report,
//! `<out>/verify.apply.json`: each memory's verdict and outcome
//! (`confirmed`, `skipped`, `update` or `archive`, the outcome a run would
//! write), with why a skip is one (a refused update or archive is a skip
//! with the gate's reason, and the model's own reason kept beside it), the
//! cites and derive the reply gave, and totals per outcome and per kind of
//! skip. Verdicts are decided one by one against the store copy as planned,
//! so an earlier verdict's write in the same reply (which a run applies
//! first) is not seen by a later one. The live branches are read as they are
//! when it runs. A request written before requests carried each memory's
//! text and line takes the text from the store copy and counts the memory as
//! having no line of its own.
//!
//! Paths come from the environment, and a path inside the live data folder
//! (`~/.local/share/cortexkit/`) is refused:
//! - `DREAMER_REPLAY_STORE`: a copy of a `context.db`. It is read, never
//!   written: the test copies it to `<out>/store.db` and plans on that copy
//!   (a store at the plugin's last schema is migrated there).
//! - `DREAMER_REPLAY_CHECKOUT`: the project's git checkout.
//! - `DREAMER_REPLAY_PROJECT`: the project's id in the store (`owner_id`).
//! - `DREAMER_REPLAY_OUT`: a new or empty folder for the output; for the
//!   apply step, the folder the requests were written to.
//! - `DREAMER_REPLAY_KINDS` (optional): the kinds to plan or apply,
//!   comma-separated; both by default.
//! - `DREAMER_REPLAY_MODEL` (optional): the model the request names for the
//!   runner; `deepseek-flash` by default.
//! - `DREAMER_REPLAY_BATCHES` (optional): write at most this many batches
//!   per kind.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};

use super::branches::main_checkout;
use super::checkout::Checkout;
use super::reflect_replay_tests::refuse_live_path;
use super::task::{Owner, TaskContext};
use super::tasks::verify::manifest::{parse_manifest, Decision};
use super::tasks::verify::tests::replay_batch;
use super::tasks::verify::{Decided, Read, Verify, VerifyBatch, VERIFY, VERIFY_BROAD};
use crate::context_db::ContextDb;
use crate::count::Counter;
use crate::memory_profile::prompt_profile;
use crate::memory_writes::get_memory;
use crate::routing::{DREAM_DEMANDS, DREAM_OUTPUT_TOKENS};
use crate::summary::fit::Window;

/// Each batch's request, inside its `batch-<n>` folder.
const REQUEST: &str = "verify.request.json";
/// Each batch's reply, as `verify-run.ts` writes it beside the request.
const TRAJECTORY: &str = "verify.trajectory.json";
/// The apply step's report, in the output folder.
const REPORT: &str = "verify.apply.json";
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
            .map(|read| json!({
                "id": read.id,
                "readRevision": read.revision,
                "files": read.files,
                "content": read.content,
                "lined": read.lined,
            }))
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
            kinds: kinds_from_env(),
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
    refuse_live_path(out);
    refuse_live_path(&args.store);
    refuse_live_path(Path::new(&args.checkout));
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
                guidance: None,
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

/// What the apply step reads: the replay's folder and the kinds in it.
struct ApplyArgs {
    out: PathBuf,
    kinds: Vec<String>,
}

impl ApplyArgs {
    fn from_env() -> Self {
        Self {
            out: PathBuf::from(required(
                "DREAMER_REPLAY_OUT",
                "the folder the requests were written to",
            )),
            kinds: kinds_from_env(),
        }
    }
}

fn kinds_from_env() -> Vec<String> {
    env("DREAMER_REPLAY_KINDS").map_or_else(
        || vec![VERIFY.to_owned(), VERIFY_BROAD.to_owned()],
        |value| {
            value
                .split(',')
                .map(|kind| kind.trim().to_owned())
                .collect()
        },
    )
}

fn read_json(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    Some(serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display())))
}

/// The `batch-<n>` folders of `kind` the request step wrote, by `n`.
fn batch_folders(out: &Path, kind: &str) -> Vec<(usize, PathBuf)> {
    let Ok(entries) = std::fs::read_dir(out.join(kind)) else {
        return Vec::new();
    };
    let mut folders: Vec<(usize, PathBuf)> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let index = name.strip_prefix("batch-")?.parse::<usize>().ok()?;
            Some((index, entry.path()))
        })
        .collect();
    folders.sort();
    folders
}

/// Which check made a verdict a skip, read from its reason, so the report
/// can count skips by kind: a confirmation's cited-lines checks, and the
/// gates every update, archive and verdict passes before it is written.
fn check_of(reason: &str) -> &'static str {
    if reason.starts_with("the lines differ between live branches") {
        "lines differ between live branches"
    } else if reason.contains("so it changes only where every live branch agrees") {
        "rewrite or archive where live branches differ"
    } else if reason.contains("is protected") {
        "protected memory"
    } else if reason.contains("behavioural directive") {
        "directive rule"
    } else if reason.contains("the update's text") || reason.contains("drops more than half") {
        "update text refused"
    } else if reason.contains("missing=")
        || reason.contains("is still in the checkout")
        || reason.contains("was never in this repository")
        || reason.contains("is gone is undecided")
        || reason.contains("needs the code's evidence")
    {
        "archive evidence refused"
    } else if reason.contains("changed after the batch read it")
        || reason.contains("no longer a live memory")
        || reason.contains("does not cover")
        || reason.contains("does not declare")
        || reason.contains("is not in this batch")
    {
        "memory changed or out of scope"
    } else if reason.contains("needs cites") {
        "no cites"
    } else if reason.contains("is not path:start-end") || reason.contains("names no lines") {
        "malformed cites"
    } else if reason.contains("more than 150 lines") || reason.contains("more than 16 spans") {
        "cites over their limit"
    } else if reason.contains("is not a file at") {
        "cited file not at the commit"
    } else if reason.contains("runs past the end of the file") {
        "span past the end of its file"
    } else if reason.contains("which the memory names, is in none of the cited lines") {
        "name not in the cited lines"
    } else if reason.starts_with("the number ") {
        "number not in the cited lines"
    } else if reason.starts_with("derive") {
        "derive refused"
    } else {
        "cited lines unreadable"
    }
}

/// The store copy at `path`, opened so nothing can be written to it or
/// beside it: read-only and immutable, which also keeps SQLite from creating
/// the write-ahead log's side files.
fn open_store_copy(path: &Path) -> Connection {
    refuse_live_path(path);
    assert!(path.is_file(), "{} is not a store copy", path.display());
    let mut uri = String::from("file:");
    for ch in path
        .to_str()
        .expect("the store copy's path is UTF-8")
        .chars()
    {
        match ch {
            '%' => uri.push_str("%25"),
            '?' => uri.push_str("%3f"),
            '#' => uri.push_str("%23"),
            _ => uri.push(ch),
        }
    }
    uri.push_str("?immutable=1");
    Connection::open_with_flags(
        &uri,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

/// The code a batch read: the main checkout when it is still at `commit`,
/// otherwise a temporary copy of `commit`.
fn checkout_at(main: &Path, commit: Option<&str>) -> Arc<Checkout> {
    let current =
        Checkout::open(main).unwrap_or_else(|error| panic!("{}: {error}", main.display()));
    match commit {
        Some(commit) if current.head() != Some(commit) => Arc::new(
            Checkout::open_copy(main, commit)
                .unwrap_or_else(|error| panic!("copying {commit}: {error}")),
        ),
        _ => Arc::new(current),
    }
}

/// Check every saved reply's verdicts as the module checks them, write the
/// report and return it. Nothing is written anywhere else: each batch's
/// checks run in a transaction on the read-only store copy that is rolled
/// back.
fn apply_replies(args: &ApplyArgs) -> Value {
    let out = &args.out;
    refuse_live_path(out);
    let profile = prompt_profile(None).expect("the bundled profile");
    let mut store = open_store_copy(&out.join("store.db"));
    let mut checkouts: HashMap<(PathBuf, Option<String>), Arc<Checkout>> = HashMap::new();
    let mut batches = Vec::new();
    let mut memories = Vec::new();
    let mut outcomes: BTreeMap<&str, usize> = ["confirmed", "skipped", "update", "archive"]
        .into_iter()
        .map(|outcome| (outcome, 0))
        .collect();
    let mut skips: BTreeMap<&str, usize> = BTreeMap::new();
    let (mut undecided_total, mut refused, mut unanswered) = (0, 0, 0);
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
        for (index, folder) in batch_folders(out, kind) {
            let Some(request) = read_json(&folder.join(REQUEST)) else {
                continue;
            };
            let ids: Vec<i64> = request["memories"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|memory| memory["id"].as_i64())
                .collect();
            let mut entry = json!({
                "kind": kind,
                "batch": index,
                "request": format!("{kind}/batch-{index}/{REQUEST}"),
                "commit": request["commit"],
            });
            let reply = read_json(&folder.join(TRAJECTORY))
                .and_then(|trajectory| trajectory["final"]["text"].as_str().map(str::to_owned));
            let Some(reply) = reply else {
                entry["status"] = json!("no reply");
                entry["undecided"] = json!(ids);
                undecided_total += ids.len();
                unanswered += 1;
                batches.push(entry);
                continue;
            };
            // The module's own parse: a reply it refuses decides nothing.
            let verdicts = match parse_manifest(&reply, &ids) {
                Ok(verdicts) => verdicts,
                Err(why) => {
                    entry["status"] = json!("refused");
                    entry["error"] = json!(why);
                    entry["undecided"] = json!(ids);
                    undecided_total += ids.len();
                    refused += 1;
                    batches.push(entry);
                    continue;
                }
            };
            let checkout_path = request["checkout"]
                .as_str()
                .unwrap_or_else(|| panic!("{} names no checkout", folder.display()));
            refuse_live_path(Path::new(checkout_path));
            let main = main_checkout(Path::new(checkout_path))
                .unwrap_or_else(|error| panic!("{checkout_path}: {error}"));
            let commit = request["commit"].as_str().map(str::to_owned);
            let checkout = Arc::clone(
                checkouts
                    .entry((main.clone(), commit.clone()))
                    .or_insert_with(|| checkout_at(&main, commit.as_deref())),
            );
            // Read-only: the store copy refuses any write, and the
            // transaction only lets the checks read as the write would.
            let tx = store
                .transaction()
                .expect("a read transaction on the store copy");
            let read: Vec<Read> = request["memories"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|memory| {
                    let id = memory["id"].as_i64().expect("a memory id");
                    let content = match memory["content"].as_str() {
                        Some(content) => content.to_owned(),
                        None => {
                            get_memory(&tx, id)
                                .expect("read the store copy")
                                .unwrap_or_else(|| panic!("memory {id} is not in the store copy"))
                                .content
                        }
                    };
                    Read {
                        id,
                        revision: memory["readRevision"].as_i64().unwrap_or_default(),
                        files: memory["files"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(|file| file.as_str().map(str::to_owned))
                            .collect(),
                        content,
                        lined: memory["lined"].as_bool().unwrap_or(false),
                    }
                })
                .collect();
            let project = request["project"].as_str().unwrap_or_default();
            let batch = replay_batch(&declaration, broad, project, read, checkout, &main);
            for verdict in &verdicts {
                let mut memory = json!({"kind": kind, "batch": index, "id": verdict.id});
                let name = match verdict.decision {
                    Decision::Verified => "verified",
                    Decision::Update => "update",
                    Decision::Archive => "archive",
                    Decision::Skip => "skip",
                };
                if verdict.decision == Decision::Update {
                    memory["content"] = json!(verdict.content);
                }
                if let Some(missing) = &verdict.missing {
                    memory["missing"] = json!(missing);
                }
                if verdict.decision != Decision::Verified && !verdict.reason.trim().is_empty() {
                    memory["reason"] = json!(verdict.reason);
                }
                // The write's own decision, every gate included.
                let refusal = match batch.decide(&tx, verdict).expect("read the store copy") {
                    Decided::Refused(reason) => {
                        let prefix = format!("memory {}: ", verdict.id);
                        Some(reason.strip_prefix(&prefix).unwrap_or(&reason).to_owned())
                    }
                    Decided::Skipped(_, why) => Some(why),
                    Decided::Write(..) if verdict.decision == Decision::Skip => {
                        *skips.entry("skipped by the model").or_default() += 1;
                        memory["check"] = json!("skipped by the model");
                        None
                    }
                    Decided::Write(..) => None,
                };
                let outcome = match (refusal, verdict.decision) {
                    (Some(why), _) => {
                        let check = check_of(&why);
                        *skips.entry(check).or_default() += 1;
                        // The model's own reason gives way to the gate's.
                        if let Some(proposed) = memory.get("reason").cloned() {
                            memory["modelReason"] = proposed;
                        }
                        memory["reason"] = json!(why);
                        memory["check"] = json!(check);
                        "skipped"
                    }
                    (None, Decision::Verified) => "confirmed",
                    (None, Decision::Update) => "update",
                    (None, Decision::Archive) => "archive",
                    (None, Decision::Skip) => "skipped",
                };
                memory["verdict"] = json!(name);
                memory["outcome"] = json!(outcome);
                if let Some(cites) = &verdict.cites {
                    memory["cites"] = json!(cites);
                }
                if let Some(derive) = &verdict.derive {
                    memory["derive"] = json!(derive);
                }
                *outcomes.entry(outcome).or_default() += 1;
                memories.push(memory);
            }
            tx.rollback().expect("end the read transaction");
            let undecided: Vec<i64> = ids
                .iter()
                .copied()
                .filter(|id| !verdicts.iter().any(|verdict| verdict.id == *id))
                .collect();
            undecided_total += undecided.len();
            entry["status"] = json!("read");
            entry["verdicts"] = json!(verdicts.len());
            entry["undecided"] = json!(undecided);
            batches.push(entry);
        }
    }
    let report = json!({
        "out": out,
        "kinds": args.kinds,
        "totals": {
            "outcomes": outcomes,
            "skipReasons": skips,
            "undecided": undecided_total,
            "batches": {
                "read": batches.len() - refused - unanswered,
                "refused": refused,
                "noReply": unanswered,
            },
        },
        "batches": batches,
        "memories": memories,
    });
    write_json(&out.join(REPORT), &report);
    report
}

#[test]
#[ignore = "checks the verdicts of saved verify replay replies against a checkout; see the module documentation"]
fn verify_apply() {
    let report = apply_replies(&ApplyArgs::from_env());
    println!(
        "{}",
        serde_json::to_string_pretty(&report["totals"]).unwrap()
    );
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
            spans: vec![("src/timer.rs", 1, 1, "pub fn start_dream_timer() {}")],
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
    assert!(diff["messages"][1]["content"]
        .as_str()
        .unwrap()
        .contains("Confirmed from: src/timer.rs:1-1"));
    let broad = read("verify-broad/batch-0/verify.request.json");
    assert_eq!(broad["settings"]["maxSteps"], 60);
    assert_eq!(broad["model"], "deepseek-flash");
    assert_eq!(broad["memories"][0]["id"], 2, "everything it cites is gone");
    let user = broad["messages"][1]["content"].as_str().unwrap();
    assert!(user
        .contains("Not found by a plain search of the checkout: legacy_dream_queue, src/queue.rs"));
    println!("{}", serde_json::to_string_pretty(&broad).unwrap());
}

/// The apply step on a fixture with two live branches: a broad batch of
/// five memories whose saved reply confirms two (one from lines that state
/// it, one from lines that miss a name it states), rewrites two (one in a
/// file the live branches agree on, one in a file they don't) and archives
/// a protected one. The report shows what a run would write, every gate
/// included, and nothing is written but the report.
#[test]
fn the_apply_step_decides_each_saved_verdict_as_the_write_would_and_writes_only_its_report() {
    use super::tasks::verify::tests::{row, Fixture, PROJECT};
    use crate::dreamer::checkout::tests::commit_at;
    let fixture = Fixture::on(
        "master",
        &[
            ("src/live.rs", "fn live_function() {}\n"),
            ("src/other.rs", "fn other_function() {}\n"),
        ],
    );
    // A second live branch, whose src/other.rs differs from master's.
    let (_outer, worktree) = fixture.repo.worktree("feature");
    commit_at(
        &worktree,
        &[("src/other.rs", "fn other_function(x: u8) {}\n")],
        "feature",
    );
    fixture.insert(&[
        row(1, "`live_function` in src/live.rs takes no arguments."),
        row(2, "`live_function` calls `helper_function`."),
        row(
            3,
            "`other_function` in src/other.rs takes no arguments at all.",
        ),
        row(4, "`live_function` lives in src/live.rs."),
        row(5, "`live_function` never panics."),
    ]);
    fixture.execute("UPDATE memories SET safety_critical = 1 WHERE id = 5");
    let out = tempfile::tempdir().unwrap();
    let args = Args {
        store: fixture.db.path.clone(),
        checkout: fixture.repo.path().to_str().unwrap().to_owned(),
        project: PROJECT.to_owned(),
        out: out.path().join("replay"),
        kinds: vec![VERIFY_BROAD.to_owned()],
        model: "deepseek-flash".into(),
        limit: None,
    };
    write_requests(&args);
    let request: Value = serde_json::from_str(
        &std::fs::read_to_string(args.out.join("verify-broad/batch-0").join(REQUEST)).unwrap(),
    )
    .unwrap();
    assert_eq!(request["memories"].as_array().unwrap().len(), 5);
    assert_eq!(
        request["memories"][0]["content"],
        "`live_function` in src/live.rs takes no arguments."
    );
    assert_eq!(request["memories"][0]["lined"], false);
    // The reply as `verify-run.ts` saves it: the final message's text.
    let reply = r#"<verify>
<verified id="1" files="src/live.rs" cites="src/live.rs:1-1"/>
<verified id="2" files="src/live.rs" cites="src/live.rs:1-1"/>
<update id="3" files="src/other.rs">`other_function` in src/other.rs takes one byte argument.</update>
<update id="4" files="src/live.rs">`live_function` lives in src/live.rs and takes no arguments.</update>
<archive id="5" reason="it can panic now"/>
</verify>"#;
    write_json(
        &args.out.join("verify-broad/batch-0").join(TRAJECTORY),
        &json!({"stopReason": "final", "final": {"text": reply, "completeManifest": true}}),
    );
    let files = |dir: &Path| -> Vec<(String, Vec<u8>)> {
        let mut found: Vec<(String, Vec<u8>)> = walk(dir)
            .into_iter()
            .map(|path| {
                let bytes = std::fs::read(&path).unwrap();
                (path.strip_prefix(dir).unwrap().display().to_string(), bytes)
            })
            .collect();
        found.sort();
        found
    };
    let before = files(&args.out);
    let report = apply_replies(&ApplyArgs {
        out: args.out.clone(),
        kinds: vec![VERIFY_BROAD.to_owned()],
    });
    // Every file the replay had is as it was, the store copy included, and
    // the report is the one file added.
    let after: Vec<(String, Vec<u8>)> = files(&args.out)
        .into_iter()
        .filter(|(path, _)| path != REPORT)
        .collect();
    assert_eq!(after, before);
    assert_eq!(read_json(&args.out.join(REPORT)).as_ref(), Some(&report));
    assert_eq!(
        report["memories"],
        json!([
            {"kind": "verify-broad", "batch": 0, "id": 1, "verdict": "verified", "outcome": "confirmed",
             "cites": "src/live.rs:1-1"},
            {"kind": "verify-broad", "batch": 0, "id": 2, "verdict": "verified", "outcome": "skipped",
             "reason": "helper_function, which the memory names, is in none of the cited lines",
             "check": "name not in the cited lines", "cites": "src/live.rs:1-1"},
            {"kind": "verify-broad", "batch": 0, "id": 3, "verdict": "update", "outcome": "skipped",
             "content": "`other_function` in src/other.rs takes one byte argument.",
             "reason": "src/other.rs differs between live branches master and feature; it names no git line of its own, so it changes only where every live branch agrees",
             "check": "rewrite or archive where live branches differ"},
            {"kind": "verify-broad", "batch": 0, "id": 4, "verdict": "update", "outcome": "update",
             "content": "`live_function` lives in src/live.rs and takes no arguments."},
            {"kind": "verify-broad", "batch": 0, "id": 5, "verdict": "archive", "outcome": "skipped",
             "modelReason": "it can panic now",
             "reason": "memory 5 is protected (safety-critical, permanent, a policy, or the person's own) and is never archived",
             "check": "protected memory"},
        ])
    );
    assert_eq!(
        report["totals"],
        json!({
            "outcomes": {"confirmed": 1, "skipped": 3, "update": 1, "archive": 0},
            "skipReasons": {
                "name not in the cited lines": 1,
                "rewrite or archive where live branches differ": 1,
                "protected memory": 1,
            },
            "undecided": 0,
            "batches": {"read": 1, "refused": 0, "noReply": 0},
        })
    );
    assert_eq!(report["batches"][0]["status"], "read");
    // The memories' rows are unchanged: none was confirmed, rewritten,
    // archived or checked.
    for id in 1..=5 {
        let (status, content, revision, verified_at, metadata, _) = fixture.memory(id);
        assert_eq!(
            (status.as_str(), revision, verified_at, metadata),
            ("active", 1, None, Value::Null),
            "{content}"
        );
    }
}

/// Every file under `dir`.
fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            files.extend(walk(&path));
        } else {
            files.push(path);
        }
    }
    files
}
