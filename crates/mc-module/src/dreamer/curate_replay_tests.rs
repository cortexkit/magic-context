//! A replay of the `curate` task's requests on a copy of a real store, for
//! reading every request by hand before the task is switched on.
//!
//! Nothing here calls a provider or writes to the store it reads. The
//! ignored test below copies the store it is given, brings the copy to this
//! build's schema with the module's own migrations, plans one category of
//! one project exactly as a run plans it (the bundled memory profile, the
//! task's declaration, the head's own choice of the memories every session
//! sees, the project documents in the project's folder), and writes each
//! part's request the way a run would send it: the system prompt, the
//! message, and the model settings the run asks routing and the runner for.
//! `.cortexkit/scripts/summary-replay/send.ts` sends the requests and writes
//! each reply beside its request.
//!
//! Paths come from the environment:
//! - `CURATE_REPLAY_STORE`: a copy of a `context.db`. A path inside the live
//!   data folder (`~/.local/share/cortexkit/`) is refused, and the copy is
//!   opened read-only.
//! - `CURATE_REPLAY_PROJECT`: the project's id, as its memories name their
//!   owner.
//! - `CURATE_REPLAY_CATEGORY`: the category, by profile id (`swe:naming`) or
//!   tag (`NAMING`).
//! - `CURATE_REPLAY_ROOT` (optional): the project's folder, whose
//!   `ARCHITECTURE.md` and `STRUCTURE.md` the head shows every session.
//!   Without it the requests have no project documents.
//! - `DREAMER_REPLAY_OUT`: a new folder for the output: `store.db` (the
//!   migrated copy), `manifest.json`, and one
//!   `<tag>/part-<n>/curate.request.json` per part.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::task::{Owner, TaskContext};
use super::tasks::curate::{categories, live_memories, Curate, KIND};
use crate::context_db::{live_schema_version, ContextDb};
use crate::context_migrations::{upgrade, SCHEMA_VERSION};
use crate::count::Counter;
use crate::memory_profile::prompt_profile;
use crate::routing::{dream_consumer, DREAM_DEMANDS, DREAM_OUTPUT_TOKENS};
use crate::summary::fit::Window;

/// The task's id in the bundled profile.
const TASK_ID: &str = "swe:curate";
/// The file the sender reads; it writes the reply beside it as
/// `curate.reply.json`.
const REQUEST: &str = "curate.request.json";
/// A window large enough for any part. A part offers its whole message or
/// nothing, so asking with this window gives the message every model that
/// can take it is sent.
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

/// Refuse a store inside the live data folder: the replay reads copies only.
fn refuse_live(store: &Path) {
    let resolved = store
        .canonicalize()
        .unwrap_or_else(|error| panic!("{}: {error}", store.display()));
    if let Some(home) = std::env::var_os("HOME") {
        let live = PathBuf::from(home).join(".local/share/cortexkit");
        let live = live.canonicalize().unwrap_or(live);
        assert!(
            !resolved.starts_with(&live),
            "{} is inside the live data folder {}; copy the store elsewhere first",
            resolved.display(),
            live.display()
        );
    }
}

/// Copy `from` to `to` through a read-only connection, then bring the copy
/// to this build's schema. Returns the schema the source had.
fn migrated_copy(from: &Path, to: &Path) -> i64 {
    let source = Connection::open_with_flags(
        from,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .unwrap_or_else(|error| panic!("{}: {error}", from.display()));
    source
        .execute(
            "VACUUM INTO ?1",
            [to.to_str().expect("the output folder's path is UTF-8")],
        )
        .expect("copy the store");
    drop(source);
    let mut copy = Connection::open(to).expect("open the copy");
    let found = live_schema_version(&copy).expect("schema version");
    if found < i64::from(SCHEMA_VERSION) {
        assert_eq!(
            upgrade(&mut copy, found).expect("the module's migrations"),
            i64::from(SCHEMA_VERSION)
        );
    }
    found
}

#[test]
#[ignore = "builds curate replay requests from a copy of a real store; see the module documentation"]
fn curate_requests() {
    let store = PathBuf::from(required(
        "CURATE_REPLAY_STORE",
        "a copy of a context.db (never the live one)",
    ));
    let project = required("CURATE_REPLAY_PROJECT", "the project's id");
    let category = required(
        "CURATE_REPLAY_CATEGORY",
        "a category id (swe:naming) or tag (NAMING)",
    );
    let root = env("CURATE_REPLAY_ROOT");
    let out = PathBuf::from(required(
        "DREAMER_REPLAY_OUT",
        "a new folder for the replay's output",
    ));
    refuse_live(&store);
    let copy = out.join("store.db");
    assert!(
        !copy.exists(),
        "{} already holds a replay; write a new one to a fresh DREAMER_REPLAY_OUT",
        out.display()
    );
    std::fs::create_dir_all(&out).expect("create the output folder");
    let bytes = std::fs::read(&store).unwrap_or_else(|error| panic!("{}: {error}", store.display()));
    let digest: String = Sha256::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    drop(bytes);
    let schema = migrated_copy(&store, &copy);
    let db = ContextDb::open(&copy).expect("open the migrated copy");

    let profile = prompt_profile(None).expect("the bundled profile");
    let declaration = profile.body["tasks"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|task| task["id"] == TASK_ID)
        .cloned()
        .unwrap_or_else(|| panic!("the bundled profile declares no {TASK_ID}"));
    assert_eq!(declaration["kind"], KIND, "{TASK_ID} is not a curate task");
    let chosen = categories(&profile, &declaration)
        .into_iter()
        .find(|known| known.id == category || known.tag == category)
        .unwrap_or_else(|| panic!("{TASK_ID} doesn't curate a category {category}"));
    // A missing folder stands in for no folder: its documents read as none.
    let folder = root
        .clone()
        .unwrap_or_else(|| out.join("no-project-folder").to_string_lossy().into_owned());
    let owner = Owner::Project {
        id: project.clone(),
        root: folder,
    };
    let context = TaskContext {
        db: &db,
        owner: &owner,
        profile: &profile,
        declaration: &declaration,
    };
    let live = db
        .with_connection(|conn| live_memories(conn, &project, &chosen.id, crate::summary::run::now_ms()))
        .expect("reading the category's memories");
    // A run curates the category from its first part.
    let batches = Curate
        .plan_batches(&context, None, Some(&chosen.id))
        .expect("planning the curate run");

    let demand = DREAM_DEMANDS
        .iter()
        .find(|demand| demand.kind == KIND)
        .expect("curate has a routing demand");
    let settings = json!({
        "consumer": dream_consumer(KIND),
        "iq": demand.iq,
        "contextWindow": demand.context_window,
        "readsCode": demand.reads_code,
        "maxSteps": demand.max_steps,
        "maxOutputTokens": DREAM_OUTPUT_TOKENS,
        "tools": [],
        "cacheTtl": "short",
    });
    let window = Window {
        counter: Counter::for_model(None),
        context_window: ANY_WINDOW,
    };
    let counter = Counter::for_model(None);
    let mut listed = Vec::new();
    for batch in &batches {
        let (number, count) = batch.part;
        let system = crate::dreamer::run::TaskInput::system(batch).to_owned();
        let user = crate::dreamer::run::TaskInput::prompt(batch, window, DREAM_OUTPUT_TOKENS)
            .expect("a curate part fits a window this large");
        let request = format!("{}/part-{number}/{REQUEST}", chosen.tag);
        write_file(
            &out.join(&request),
            &pretty(&json!({
                "task": TASK_ID,
                "project": project,
                "category": chosen.id,
                "part": number,
                "parts": count,
                "settings": settings,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
            })),
        );
        let (system_tokens, user_tokens) = (counter.count(&system), counter.count(&user));
        println!(
            "{} part {number} of {count}: {} memories, system ~{system_tokens} tokens, user ~{user_tokens} tokens",
            chosen.tag,
            batch.read.len()
        );
        listed.push(json!({
            "part": number,
            "request": request,
            "memories": batch
                .read
                .iter()
                .map(|(id, revision)| json!({"id": id, "readRevision": revision}))
                .collect::<Vec<_>>(),
            "systemTokens": system_tokens,
            "userTokens": user_tokens,
        }));
    }
    write_file(
        &out.join("manifest.json"),
        &pretty(&json!({
            "project": project,
            "store": {"file": store, "sha256": digest, "schema": schema, "migratedTo": SCHEMA_VERSION},
            "copy": "store.db",
            "projectFolder": root,
            "profile": {"name": profile.name, "version": profile.version, "digest": profile.digest},
            "task": TASK_ID,
            "category": {"id": chosen.id, "tag": chosen.tag},
            "liveMemories": live.len(),
            "protected": live.iter().filter(|memory| memory.protected).map(|memory| memory.id).collect::<Vec<_>>(),
            "settings": settings,
            "tokenCounts": "the module's estimate for a model it has no vocabulary for",
            "parts": listed,
        })),
    );
    println!(
        "{project} {}: {} live memories in {} parts written to {}",
        chosen.tag,
        live.len(),
        batches.len(),
        out.display()
    );
}
