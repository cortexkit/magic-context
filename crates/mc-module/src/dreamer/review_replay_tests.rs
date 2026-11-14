//! A replay of the global review's request on a copy of a real store, for
//! reading the request by hand before the task is switched on.
//!
//! Nothing here calls a provider or writes to the store it reads. The
//! ignored test below copies the store it is given, brings the copy to this
//! build's schema with the module's own migrations, and plans the review
//! exactly as a run plans it: the bundled memory profile, its
//! `review-user-memories` declaration (`base:review-user-memories`, with the
//! coding profile's categories), the person's own memories, and the
//! observations waiting for review after those older than 30 days have left
//! it. That decay is a write, so it lands on the copy only. Each part's
//! request is written the way a run would send it: the system prompt, the
//! message, and the model settings the run asks routing and the runner for.
//! `.cortexkit/scripts/summary-replay/send.ts` sends the requests and writes
//! each reply beside its request.
//!
//! Paths come from the environment:
//! - `REVIEW_REPLAY_STORE`: a copy of a `context.db`. A path inside the live
//!   data folder (`~/.local/share/cortexkit/`) is refused, and the copy is
//!   opened read-only.
//! - `DREAMER_REPLAY_OUT`: a new folder for the output: `store.db` (the
//!   migrated copy), `manifest.json`, and one `part-<n>/review.request.json`
//!   per part.

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OpenFlags};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::run::TaskInput;
use super::task::{Owner, TaskContext};
use super::tasks::review_user_memories::{ReviewUserMemories, KIND, OBSERVATION_TTL_MS};
use crate::context_db::{live_schema_version, ContextDb};
use crate::context_migrations::{upgrade, SCHEMA_VERSION};
use crate::count::Counter;
use crate::memory_profile::prompt_profile;
use crate::routing::{dream_consumer, DREAM_DEMANDS, DREAM_OUTPUT_TOKENS};
use crate::summary::fit::Window;

/// The file the sender reads; it writes the reply beside it as
/// `review.reply.json`.
const REQUEST: &str = "review.request.json";
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

/// The live data folder of the person running the replay, when `HOME` names
/// one.
fn live_folder() -> Option<PathBuf> {
    let live = PathBuf::from(std::env::var_os("HOME")?).join(".local/share/cortexkit");
    Some(live.canonicalize().unwrap_or(live))
}

/// Refuse a store inside `live`: the replay reads copies only.
fn refuse_live(store: &Path, live: Option<&Path>) {
    let resolved = store
        .canonicalize()
        .unwrap_or_else(|error| panic!("{}: {error}", store.display()));
    if let Some(live) = live {
        assert!(
            !resolved.starts_with(live),
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

/// The ids a query over the copy returns, in order.
fn ids(db: &ContextDb, sql: &str, args: &[&dyn rusqlite::ToSql]) -> Vec<i64> {
    db.with_connection(|conn| {
        conn.prepare(sql)?
            .query_map(args, |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<i64>>>()
    })
    .expect("reading the copy")
}

/// Copy `store` into the new folder `out`, plan the review on the copy and
/// write its requests; the manifest written last, which lists them.
fn write_requests(store: &Path, out: &Path) -> Value {
    let copy = out.join("store.db");
    assert!(
        !copy.exists(),
        "{} already holds a replay; write a new one to a fresh DREAMER_REPLAY_OUT",
        out.display()
    );
    std::fs::create_dir_all(out).expect("create the output folder");
    let bytes = std::fs::read(store).unwrap_or_else(|error| panic!("{}: {error}", store.display()));
    let digest: String = Sha256::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    drop(bytes);
    let schema = migrated_copy(store, &copy);
    let db = ContextDb::open(&copy).expect("open the migrated copy");

    let profile = prompt_profile(None).expect("the bundled profile");
    let declaration = profile.body["tasks"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|task| task["kind"] == KIND)
        .cloned()
        .unwrap_or_else(|| panic!("the bundled profile declares no {KIND} task"));
    let task = declaration["id"].as_str().unwrap_or(KIND).to_owned();

    // What the run's decay will take out of review, and what waits, read
    // from the copy before the plan writes to it.
    let now = crate::summary::run::now_ms();
    let decaying = ids(
        &db,
        "SELECT id FROM memory_observations
          WHERE consumed_at IS NULL AND created_at < ?1 ORDER BY id",
        &[&(now - OBSERVATION_TTL_MS)],
    );
    let live = ids(
        &db,
        "SELECT id FROM memories
          WHERE level = 'global' AND owner_id = 'self'
            AND (status IS NULL OR status IN ('active', 'permanent'))
            AND superseded_by_memory_id IS NULL
          ORDER BY id",
        &[],
    );
    let batches = ReviewUserMemories
        .plan_batches(&TaskContext {
            db: &db,
            owner: &Owner::Global,
            profile: &profile,
            declaration: &declaration,
            workspace: None,
        })
        .unwrap_or_else(|error| panic!("planning {task}: {error}"));
    let pending = ids(
        &db,
        "SELECT id FROM memory_observations WHERE consumed_at IS NULL ORDER BY id",
        &[],
    );

    let demand = DREAM_DEMANDS
        .iter()
        .find(|demand| demand.kind == KIND)
        .expect("the review has a routing demand");
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
    let parts = batches.len();
    let mut listed = Vec::new();
    for (index, batch) in batches.iter().enumerate() {
        let number = index + 1;
        let system = batch.system().to_owned();
        let user = batch
            .prompt(window, DREAM_OUTPUT_TOKENS)
            .expect("a review part fits a window this large");
        let request = format!("part-{number}/{REQUEST}");
        write_file(
            &out.join(&request),
            &pretty(&json!({
                "task": task,
                "owner": {"level": "global", "id": "self"},
                "part": number,
                "parts": parts,
                "settings": settings,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
            })),
        );
        let (system_tokens, user_tokens) = (counter.count(&system), counter.count(&user));
        println!(
            "part {number} of {parts}: {} memories ({} protected, {} unsorted), {} observations, system ~{system_tokens} tokens, user ~{user_tokens} tokens",
            batch.memories.len(),
            batch.protected.len(),
            batch.unsorted.len(),
            batch.candidates.len()
        );
        let mut protected: Vec<i64> = batch.protected.iter().copied().collect();
        protected.sort_unstable();
        listed.push(json!({
            "part": number,
            "request": request,
            "memories": batch
                .memories
                .iter()
                .map(|(id, revision)| json!({"id": id, "readRevision": revision}))
                .collect::<Vec<_>>(),
            "observations": batch.candidates,
            "protected": protected,
            "unsorted": batch.unsorted,
            "promotionThreshold": batch.threshold,
            "systemTokens": system_tokens,
            "userTokens": user_tokens,
        }));
    }
    let manifest = json!({
        "owner": {"level": "global", "id": "self"},
        "store": {"file": store, "sha256": digest, "schema": schema, "migratedTo": SCHEMA_VERSION},
        "copy": "store.db",
        "profile": {"name": profile.name, "version": profile.version, "digest": profile.digest},
        "task": task,
        "settings": settings,
        "liveMemories": live,
        "decayedInCopy": decaying,
        "pendingObservations": pending,
        "tokenCounts": "the module's estimate for a model it has no vocabulary for",
        "parts": listed,
    });
    write_file(&out.join("manifest.json"), &pretty(&manifest));
    println!(
        "{task}: {} live memories, {} observations waiting ({} decayed in the copy), {parts} part(s) written to {}",
        live.len(),
        pending.len(),
        decaying.len(),
        out.display()
    );
    manifest
}

#[test]
#[ignore = "builds the global review's replay request from a copy of a real store; see the module documentation"]
fn review_requests() {
    let store = PathBuf::from(required(
        "REVIEW_REPLAY_STORE",
        "a copy of a context.db (never the live one)",
    ));
    let out = PathBuf::from(required(
        "DREAMER_REPLAY_OUT",
        "a new folder for the replay's output",
    ));
    refuse_live(&store, live_folder().as_deref());
    write_requests(&store, &out);
}

#[test]
#[should_panic(expected = "is inside the live data folder")]
fn a_store_inside_the_live_data_folder_is_refused() {
    let live = tempfile::tempdir().unwrap();
    let store = live.path().join("magic-context/context.db");
    std::fs::create_dir_all(store.parent().unwrap()).unwrap();
    std::fs::write(&store, b"").unwrap();
    refuse_live(&store, Some(&live.path().canonicalize().unwrap()));
}

/// The harness on a fixture store: a filed memory, an unsorted line, one the
/// person wrote, and observations of which one has waited 31 days. Run with
/// `--nocapture` to see the whole request.
#[test]
fn the_harness_writes_the_request_and_leaves_the_store_alone() {
    let dir = tempfile::tempdir().unwrap();
    let store = dir.path().join("context.db");
    let day = 24 * 60 * 60 * 1000;
    let now = crate::summary::run::now_ms();
    {
        let db = ContextDb::create_for_tests(&store).unwrap();
        db.with_connection(|conn| {
            for (id, category, tag, content, source) in [
                (1, "base:communication", "COMMUNICATION", "Prefers concise answers", "historian"),
                (2, "mc:user-unsorted", "USER_MEMORY", "Expects changes to be tested", "user-review"),
                (3, "base:boundaries", "BOUNDARIES", "Asks before pushing", "person"),
            ] {
                conn.execute(
                    "INSERT INTO memories(id, level, owner_id, category, origin_category, content, normalized_hash,
                                          source_type, status, first_seen_at, created_at, updated_at, last_seen_at)
                     VALUES (?1, 'global', 'self', ?2, ?3, ?4, ?5, ?6, 'active', 0, 0, 0, 0)",
                    params![id, category, tag, content, crate::memory_writes::normalized_hash(content), source],
                )?;
            }
            for (id, content, age) in [
                (101, "Asked for a shorter reply", 31 * day),
                (102, "Wanted the summary in one line", day),
                (103, "Cut the explanation short", day - 1),
            ] {
                conn.execute(
                    "INSERT INTO memory_observations(id, content, proposed_category, session_id, created_at)
                     VALUES (?1, ?2, 'COMMUNICATION', 'ses_replay', ?3)",
                    params![id, content, now - age],
                )?;
            }
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
    }
    let before = std::fs::read(&store).unwrap();
    let out = dir.path().join("replay");
    let manifest = write_requests(&store, &out);

    // The given store is untouched: the decay lands on the copy only.
    assert_eq!(
        std::fs::read(&store).unwrap(),
        before,
        "the source store was written"
    );
    let source = Connection::open_with_flags(&store, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let waiting: i64 = source
        .query_row(
            "SELECT COUNT(*) FROM memory_observations WHERE consumed_at IS NULL",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(waiting, 3);

    assert_eq!(manifest["task"], "base:review-user-memories");
    assert_eq!(manifest["store"]["schema"], json!(SCHEMA_VERSION));
    assert_eq!(manifest["decayedInCopy"], json!([101]));
    assert_eq!(manifest["pendingObservations"], json!([102, 103]));
    let part = &manifest["parts"][0];
    assert_eq!(part["request"], "part-1/review.request.json");
    assert_eq!(part["observations"], json!([102, 103]));
    assert_eq!(part["protected"], json!([3]));
    assert_eq!(part["unsorted"], json!([2]));
    assert_eq!(
        part["memories"],
        json!([
            {"id": 1, "readRevision": 1},
            {"id": 2, "readRevision": 1},
            {"id": 3, "readRevision": 1}
        ])
    );
    let request: Value = serde_json::from_str(
        &std::fs::read_to_string(out.join("part-1/review.request.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        (
            request["part"].clone(),
            request["parts"].clone(),
            request["settings"]["consumer"].clone()
        ),
        (
            json!(1),
            json!(1),
            json!("magic-context.dream.review-user-memories")
        )
    );
    assert_eq!(request["messages"][0]["role"], "system");
    let user = request["messages"][1]["content"].as_str().unwrap();
    assert!(user.contains("- Memory #2 [UNSORTED]: \"Expects changes to be tested\""));
    assert!(user.contains("- Memory #3 [BOUNDARIES, protected]: \"Asks before pushing\""));
    assert!(user.contains("- Candidate #102 [session ses_replay, proposed COMMUNICATION]"));
    assert!(!user.contains("Asked for a shorter reply"));
    println!("{}", serde_json::to_string_pretty(&request).unwrap());
}
