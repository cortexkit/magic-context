//! A replay of the `map-memories` task on a real project, for reading every
//! request, and every step of the model's work on it, before the task is
//! switched on.
//!
//! Nothing here calls a provider or writes to the store it reads. The
//! ignored test below copies the store it is given, brings the copy to this
//! build's schema, and plans the task on the copy and the project's checkout
//! exactly as a run plans it: the bundled memory profile, its
//! `swe:map-memories` declaration, and the module's own search of the
//! checkout for each memory's likely files. It writes each batch's request
//! as `<out>/map-memories/batch-<n>/map.request.json`: the system and user
//! text the batch sends, the model settings it sends them with, the memories
//! it read, and the likely files its message lists for each. The runner in
//! `packages/plugin/scripts/dreamer-replay/` sends one request with
//! read-only tools over the same checkout and writes the whole trajectory
//! beside it.
//!
//! Paths come from the environment, as for the verify replay
//! ([`super::verify_replay_tests`]):
//! - `DREAMER_REPLAY_STORE`: a copy of a `context.db`. It is opened
//!   read-only and copied to `<out>/store.db`, where it is brought to this
//!   build's schema and planned on.
//! - `DREAMER_REPLAY_CHECKOUT`: the project's git checkout.
//! - `DREAMER_REPLAY_PROJECT`: the project's id in the store (`owner_id`).
//! - `DREAMER_REPLAY_OUT`: a new or empty folder for the output.
//! - `DREAMER_REPLAY_MODEL` (optional): the model the request names for the
//!   runner; `deepseek-flash` by default.
//! - `DREAMER_REPLAY_BATCHES` (optional): write at most this many batches.
//!
//! None of the three paths may lie inside the live data folder
//! (`~/.local/share/cortexkit/`).

use std::path::{Component, Path, PathBuf};

use serde_json::{json, Value};

use super::checkout::Checkout;
use super::curate_replay_tests::migrated_copy;
use super::run::TaskInput;
use super::task::{Owner, TaskContext};
use super::tasks::map_memories::{MapBatch, MapMemories, KIND};
use super::verify_replay_tests::{env, required, write_json, ANY_WINDOW};
use crate::context_db::ContextDb;
use crate::context_migrations::SCHEMA_VERSION;
use crate::count::Counter;
use crate::memory_profile::{prompt_profile, Profile};
use crate::routing::{DreamDemand, DREAM_DEMANDS, DREAM_OUTPUT_TOKENS};
use crate::summary::fit::Window;

/// The map task's id in the bundled profile.
const TASK_ID: &str = "swe:map-memories";
/// Each batch's request, inside its `batch-<n>` folder.
const REQUEST: &str = "map.request.json";

fn demand() -> &'static DreamDemand {
    DREAM_DEMANDS
        .iter()
        .find(|demand| demand.kind == KIND)
        .expect("the map task has a routing demand")
}

/// `path` made absolute with its links resolved as far as it exists; the
/// part that doesn't exist yet is read as written, `..` included.
fn real_path(path: &Path) -> PathBuf {
    let absolute =
        std::path::absolute(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    let mut real = PathBuf::new();
    let mut exists = true;
    for part in absolute.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                real.pop();
            }
            other => real.push(other),
        }
        if exists {
            match real.canonicalize() {
                Ok(found) => real = found,
                Err(_) => exists = false,
            }
        }
    }
    real
}

/// The live data folder, `~/.local/share/cortexkit/`, when there is a home.
fn live_folder() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share/cortexkit"))
}

/// Refuse `path` when it lies inside `live`, the live data folder: the
/// replay reads a copy of a store and the project's checkout, and writes to
/// a folder of its own, never to or from a live store.
fn refuse_live(path: &Path, what: &str, live: &Path) {
    let live = real_path(live);
    let real = real_path(path);
    assert!(
        !real.starts_with(&live),
        "{what} {} is inside the live data folder {}; use a copy elsewhere",
        path.display(),
        live.display()
    );
}

/// The profile's `swe:map-memories` declaration.
fn declaration(profile: &Profile) -> Value {
    let declaration = profile.body["tasks"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|task| task["id"] == TASK_ID)
        .cloned()
        .unwrap_or_else(|| panic!("the profile declares no {TASK_ID} task"));
    assert_eq!(declaration["kind"], KIND, "{TASK_ID} is not a map task");
    declaration
}

/// What one batch sends, as the runner reads it. The text is the batch's
/// own, asked for the way a run asks for it, with a window that takes any
/// batch.
fn request(batch: &MapBatch, index: usize, args: &Args, commit: Option<&str>) -> Value {
    let window = Window {
        counter: Counter::for_model(None),
        context_window: ANY_WINDOW,
    };
    let user = TaskInput::prompt(batch, window, DREAM_OUTPUT_TOKENS)
        .expect("a map batch fits a window this large");
    let system = TaskInput::system(batch);
    let read = batch.read();
    let memories: Vec<Value> = batch
        .sent_inputs()
        .iter()
        .zip(batch.named_inputs())
        .map(|(sent, named)| {
            let revision = read
                .iter()
                .find(|(id, _)| *id == sent.id)
                .map(|(_, revision)| *revision)
                .expect("the batch read each memory it sends");
            // A memory naming no tracked file gets the files the search
            // for its code names found; one that names some keeps those.
            let from = if sent.candidates.is_empty() {
                Value::Null
            } else if sent.candidates == named.candidates {
                json!("the paths its text names")
            } else {
                json!("a search of the checkout for the code names its text mentions")
            };
            json!({
                "id": sent.id,
                "readRevision": revision,
                "candidates": sent.candidates,
                "candidatesFrom": from,
            })
        })
        .collect();
    let counter = Counter::for_model(None);
    json!({
        "task": TASK_ID,
        "kind": KIND,
        "batch": index,
        "project": args.project,
        "checkout": args.checkout,
        "commit": commit,
        "model": args.model,
        // What the module asks the runner for: a reply of at most this many
        // tokens (less when the model's own limit is lower), at most this
        // many model steps, and the read-only code tools (read, grep, glob
        // and code navigation) confined to the project's folder.
        "settings": {
            "maxOutputTokens": DREAM_OUTPUT_TOKENS,
            "maxSteps": demand().max_steps,
            "tools": "aft reader preset (read, grep, glob, and AFT's navigation tools)",
        },
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "memories": memories,
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
    model: String,
    limit: Option<usize>,
    /// The live data folder no path may lie in.
    live: Option<PathBuf>,
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
            model: env("DREAMER_REPLAY_MODEL").unwrap_or_else(|| "deepseek-flash".into()),
            limit: env("DREAMER_REPLAY_BATCHES").map(|value| {
                value
                    .parse::<usize>()
                    .expect("DREAMER_REPLAY_BATCHES is a count of batches")
            }),
            live: live_folder(),
        }
    }
}

/// Plan the task on a copy of the store and write its requests; the
/// manifest written last, which lists them.
fn write_requests(args: &Args) -> Value {
    if let Some(live) = &args.live {
        refuse_live(&args.store, "the store", live);
        refuse_live(Path::new(&args.checkout), "the checkout", live);
        refuse_live(&args.out, "the output folder", live);
    }
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
    let declaration = declaration(&profile);
    let owner = Owner::Project {
        id: args.project.clone(),
        root: args.checkout.clone(),
    };
    // The commit the checkout is at, so a trajectory can be read against
    // the code the model was shown. The plan itself reads git's index and
    // the files as they are.
    let commit = Checkout::open(Path::new(&args.checkout))
        .ok()
        .and_then(|checkout| checkout.head().map(str::to_owned));
    let batches = MapMemories
        .plan_batches(&TaskContext {
            db: &db,
            owner: &owner,
            profile: &profile,
            declaration: &declaration,
            workspace: None,
        })
        .unwrap_or_else(|error| panic!("planning {TASK_ID}: {error}"));
    let planned = batches.len();
    let mut written = Vec::new();
    for (index, batch) in batches
        .iter()
        .enumerate()
        .take(args.limit.unwrap_or(usize::MAX))
    {
        let path = format!("{KIND}/batch-{index}/{REQUEST}");
        write_json(
            &out.join(&path),
            &request(batch, index, args, commit.as_deref()),
        );
        written.push(json!({
            "batch": index,
            "request": path,
            "memories": batch.read().iter().map(|(id, _)| *id).collect::<Vec<_>>(),
        }));
    }
    println!(
        "{TASK_ID}: {planned} batches planned, {} written to {}",
        written.len(),
        out.join(KIND).display()
    );
    let manifest = json!({
        "project": args.project,
        "checkout": args.checkout,
        "commit": commit,
        "store": {"source": args.store, "copy": "store.db", "schema": schema, "migratedTo": SCHEMA_VERSION},
        "profile": {"name": profile.name, "version": profile.version, "digest": profile.digest},
        "model": args.model,
        "tasks": [{"task": TASK_ID, "kind": KIND, "planned": planned, "batches": written}],
    });
    write_json(&out.join("manifest.json"), &manifest);
    manifest
}

#[test]
#[ignore = "plans map-memories replay requests from a store copy and a checkout; see packages/plugin/scripts/dreamer-replay/README.md"]
fn map_requests() {
    write_requests(&Args::from_env());
}

/// A store with two unmapped memories, one naming its file and one only a
/// code name, and a memory mapped already, next to a checkout of the files.
fn fixture() -> super::tasks::verify::tests::Fixture {
    use super::tasks::verify::tests::{row, Fixture, Row};
    let fixture = Fixture::new(&[
        ("src/view.rs", "pub fn build_view() {}\n"),
        ("src/head.rs", "pub fn render_head() { build_view(); }\n"),
    ]);
    fixture.insert(&[
        row(1, "Views are built in `src/view.rs`."),
        row(2, "`render_head` draws the page header."),
        Row {
            files: vec!["src/view.rs"],
            ..row(3, "build_view returns the view.")
        },
    ]);
    fixture
}

/// A replay of `fixture` into `<dir>/replay`, refusing paths in a live data
/// folder of the test's own under `dir`.
fn args(fixture: &super::tasks::verify::tests::Fixture, dir: &Path) -> Args {
    Args {
        store: fixture.db.path.clone(),
        checkout: fixture.repo.path().to_str().unwrap().to_owned(),
        project: super::tasks::verify::tests::PROJECT.to_owned(),
        out: dir.join("replay"),
        model: "deepseek-flash".into(),
        limit: None,
        live: Some(dir.join("home/.local/share/cortexkit")),
    }
}

/// Batch `index`'s request in the replay at `out`.
fn read_request(out: &Path, index: usize) -> Value {
    let path = out.join(KIND).join(format!("batch-{index}")).join(REQUEST);
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// Run with `--nocapture` to see a whole request.
#[test]
fn the_harness_writes_each_batchs_request_and_leaves_the_store_alone() {
    let fixture = fixture();
    let store = fixture.db.path.clone();
    let before = std::fs::read(&store).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let args = args(&fixture, dir.path());
    let manifest = write_requests(&args);
    assert_eq!(
        std::fs::read(&store).unwrap(),
        before,
        "the source store was written"
    );
    let head = fixture.repo.git(&["rev-parse", "HEAD"]).trim().to_owned();
    assert_eq!(manifest["commit"], head);
    assert_eq!(manifest["store"]["migratedTo"], SCHEMA_VERSION);
    let task = &manifest["tasks"][0];
    assert_eq!(
        (&task["task"], &task["planned"]),
        (&json!(TASK_ID), &json!(1))
    );
    assert_eq!(
        task["batches"][0],
        json!({"batch": 0, "request": "map-memories/batch-0/map.request.json", "memories": [1, 2]})
    );

    let request = read_request(&args.out, 0);
    assert_eq!(
        (&request["kind"], &request["commit"], &request["model"]),
        (&json!(KIND), &json!(head), &json!("deepseek-flash"))
    );
    assert_eq!(request["settings"]["maxSteps"], 60);
    assert_eq!(request["settings"]["maxOutputTokens"], DREAM_OUTPUT_TOKENS);
    let revision = |id: i64| -> i64 {
        fixture
            .db
            .with_connection(|conn| {
                conn.query_row("SELECT revision FROM memories WHERE id = ?1", [id], |row| {
                    row.get(0)
                })
            })
            .unwrap()
    };
    // The first memory names its file; the second names none, so the
    // module's search for `render_head` finds it.
    assert_eq!(
        request["memories"],
        json!([
            {"id": 1, "readRevision": revision(1), "candidates": ["src/view.rs"],
             "candidatesFrom": "the paths its text names"},
            {"id": 2, "readRevision": revision(2), "candidates": ["src/head.rs"],
             "candidatesFrom": "a search of the checkout for the code names its text mentions"},
        ])
    );
    let user = request["messages"][1]["content"].as_str().unwrap();
    assert!(user.contains(
        "[2] ARCHITECTURE\n`render_head` draws the page header.\nLikely files (candidate paths, confirmed to exist): src/head.rs"
    ), "{user}");
    assert!(request["messages"][0]["content"]
        .as_str()
        .unwrap()
        .starts_with("You are a memory mapper"));
    println!("{}", serde_json::to_string_pretty(&request).unwrap());

    // A second replay into the same folder is refused.
    let refused = std::panic::catch_unwind(|| write_requests(&args)).unwrap_err();
    assert!(
        refused
            .downcast_ref::<String>()
            .is_some_and(|message| message.contains("is not empty")),
        "{refused:?}"
    );
}

/// The request is what a run of the batch sends: a batch planned the way
/// the engine plans it, run through a scripted runner, sends the request's
/// system text, message and settings.
#[tokio::test(start_paused = true)]
async fn a_request_holds_the_text_and_settings_a_run_sends() {
    use super::run::tests::{Client, Ends};
    use super::run::{run, TaskRun};
    let fixture = fixture();
    let dir = tempfile::tempdir().unwrap();
    let args = args(&fixture, dir.path());
    write_requests(&args);
    let request = read_request(&args.out, 0);

    let task = super::tasks()
        .into_iter()
        .find(|task| task.kind() == KIND)
        .expect("the module runs the map task");
    let owner = Owner::Project {
        id: args.project.clone(),
        root: args.checkout.clone(),
    };
    let declaration = declaration(&fixture.profile);
    let batches = task
        .batches(&TaskContext {
            db: &fixture.db,
            owner: &owner,
            profile: &fixture.profile,
            declaration: &declaration,
            workspace: None,
        })
        .unwrap();
    let mut client = Client::new(&["p/a"], &[Ends::Reply("<mappings>\n</mappings>")]);
    client.plans = vec!["ra"];
    client.catalog = Ok(vec![
        ("read", &["code.read/v1"]),
        ("grep", &[]),
        ("glob", &[]),
    ]);
    let job = TaskRun {
        demand: demand(),
        run_id: "1.0",
        project_root: &args.checkout,
    };
    run(&client, &job, batches[0].as_ref()).await.unwrap();

    let sends = client.sends.lock().unwrap();
    assert_eq!(sends.len(), 1);
    let (_, sent) = &sends[0];
    assert_eq!(
        sent.prompt.as_deref(),
        request["messages"][1]["content"].as_str()
    );
    let plan = sent.plan.as_ref().expect("a code-reading run's plan");
    assert_eq!(
        plan["system_text_items"][0]["params"]["text"],
        request["messages"][0]["content"]
    );
    assert_eq!(
        sent.runner_params["stop_when"]["max_steps"],
        request["settings"]["maxSteps"]
    );
    assert_eq!(
        sent.runner_params["generation"]["max_output_tokens"],
        request["settings"]["maxOutputTokens"]
    );
}

/// A store, checkout or output folder inside the live data folder is
/// refused before anything is read or written, however the path reaches
/// it; a folder beside it is not.
#[test]
fn a_path_inside_the_live_data_folder_is_refused_before_anything_is_written() {
    let fixture = fixture();
    let dir = tempfile::tempdir().unwrap();
    let base = args(&fixture, dir.path());
    let live = base.live.clone().unwrap();
    std::fs::create_dir_all(&live).unwrap();
    let refusal = |args: Args| -> String {
        let error = std::panic::catch_unwind(|| write_requests(&args)).unwrap_err();
        assert!(!args.out.exists(), "{} was written", args.out.display());
        error.downcast_ref::<String>().cloned().unwrap_or_default()
    };
    let store = refusal(Args {
        store: live.join("context.db"),
        ..args(&fixture, dir.path())
    });
    assert!(store.starts_with("the store "), "{store}");
    // Through a folder that doesn't exist yet and climbs back with `..`.
    let out = refusal(Args {
        out: dir
            .path()
            .join("not-yet/../home/.local/share/cortexkit/replay"),
        ..args(&fixture, dir.path())
    });
    assert!(out.starts_with("the output folder "), "{out}");
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&live, dir.path().join("link")).unwrap();
        let checkout = refusal(Args {
            checkout: dir.path().join("link/project").display().to_string(),
            ..args(&fixture, dir.path())
        });
        assert!(checkout.starts_with("the checkout "), "{checkout}");
    }
    // A folder whose name only starts like the live folder's is not inside
    // it.
    refuse_live(
        &dir.path().join("home/.local/share/cortexkit-copy/replay"),
        "the output folder",
        &live,
    );
}
