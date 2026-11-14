//! A replay of one `classify-memories` run on a real project's memories,
//! for reading every request and every reply by hand before the dreamer is
//! switched on.
//!
//! Nothing here calls a provider. The two ignored tests below write the
//! exact messages the task would send, and later apply the replies a model
//! gave to them, as the engine applies an accepted reply.
//! `.cortexkit/scripts/summary-replay/send.ts` sends the requests, and
//! `.cortexkit/scripts/dreamer-replay/README.md` has the commands.
//!
//! - [`classify_requests`] builds a store from a `sqlite3 -json` export of
//!   one project's `memories` rows, taken from a store at the plugin's last
//!   schema: the rows go in unchanged and the module's own migrations bring
//!   the store to the schema this build reads. It then picks an evenly
//!   spread sample of the project's classified live memories and resets each
//!   to what a newly written memory holds: unclassified, with the
//!   importance, scope, shareability and safety-critical mark the module's
//!   memory writer gives a new memory. A real run only ever classifies
//!   memories that were never classified, so this is what the model is shown.
//!   It writes `$OUT/store.db`, `$OUT/sample.json` (each sampled memory's
//!   values before the reset, which the plugin's 0.49.x dreamer gave it when
//!   it last classified the memory, and the values it was reset to),
//!   one `$OUT/batch-<n>/classify.request.json` per batch, and
//!   `$OUT/manifest.json`.
//! - [`classify_apply`] copies `$OUT/store.db` to `$OUT/applied.db`, applies
//!   each `$OUT/batch-<n>/classify.reply.json` the sender wrote to the copy,
//!   and writes `$OUT/report.md`. Working on a fresh copy each time keeps
//!   `store.db` as the requests were planned on, so the apply can run again
//!   after more replies arrive.
//!
//! Paths come from the environment: `DREAMER_REPLAY_CORPUS` (the export, or
//! a folder holding it as `memories.json`; only the first test reads it),
//! `DREAMER_REPLAY_OUT` (required by both), and optionally
//! `DREAMER_REPLAY_SAMPLE`, how many memories to mark unclassified (100 by
//! default: one full batch).

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};

use cortexkit_role_compaction::setup::ModelRef;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use super::run::{child_session, TaskReply};
use super::task::{Applied, Batch, Owner, Task, TaskContext};
use super::tasks::classify::{
    live_memories, parse_manifest, plan, Classification, Classify, Plan, BATCH_SIZE, KIND,
};
use crate::context_db::{live_schema_version, ContextDb};
use crate::context_migrations::{
    frozen_category_id, upgrade, PLUGIN_SCHEMA_VERSION, SCHEMA_VERSION,
};
use crate::count::Counter;
use crate::memory_levels::NewRow;
use crate::memory_profile::{prompt_profile, Profile};
use crate::memory_writes::insert_memory;
use crate::routing::DREAM_OUTPUT_TOKENS;
use crate::summary::fit::Window;

/// The plugin's schema at its last version, the one the export was taken
/// at; the same file the migration tests build their stores from.
const PLUGIN_SCHEMA: &str = include_str!("../../testdata/context-schema.sql");
/// The task's id in the bundled profile.
const TASK_ID: &str = "swe:classify-memories";
/// The run every batch is applied as. The engine names a run by its row in
/// the store's dreamer runs, and a fresh store's first run is row 1, so the
/// undo history records the decisions the engine's first run would record.
const RUN: i64 = 1;
/// How many classified memories are marked unclassified when
/// `DREAMER_REPLAY_SAMPLE` is not set: one full batch.
const DEFAULT_SAMPLE: usize = 100;
/// How much of a memory's text the report shows.
const EXCERPT_CHARS: usize = 160;
/// A window large enough for any batch. A classify batch offers its whole
/// message or nothing, so asking with this window gives the message the
/// batch would send to every model that can take it.
const ANY_WINDOW: u64 = 10_000_000;
/// The importance a memory without one is ranked at, as the task shows it.
const UNSET_IMPORTANCE: i64 = 50;
/// A change in importance larger than this counts as a big change.
const BIG_IMPORTANCE_CHANGE: i64 = 20;

const STORE: &str = "store.db";
const APPLIED: &str = "applied.db";
const MANIFEST: &str = "manifest.json";
const SAMPLE: &str = "sample.json";
const REPORT: &str = "report.md";
/// Each batch's request and reply, inside its `batch-<n>` folder. The sender
/// reads only files named `*.request.json` and writes the reply beside the
/// request as `*.reply.json`.
const REQUEST: &str = "classify.request.json";
const REPLY: &str = "classify.reply.json";

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn out_dir() -> PathBuf {
    env_path("DREAMER_REPLAY_OUT").expect("set DREAMER_REPLAY_OUT to the replay's output folder")
}

fn corpus_file() -> PathBuf {
    let path = env_path("DREAMER_REPLAY_CORPUS").expect(
        "set DREAMER_REPLAY_CORPUS to the memory export, or the folder holding memories.json",
    );
    if path.is_dir() {
        path.join("memories.json")
    } else {
        path
    }
}

fn sample_size() -> usize {
    std::env::var("DREAMER_REPLAY_SAMPLE")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map_or(DEFAULT_SAMPLE, |value| {
            value
                .trim()
                .parse()
                .expect("DREAMER_REPLAY_SAMPLE is a count of memories")
        })
}

fn batch_dir(out: &Path, index: usize) -> PathBuf {
    out.join(format!("batch-{index}"))
}

fn read_json(path: &Path) -> Value {
    let text =
        std::fs::read_to_string(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).expect("JSON serializes") + "\n"
}

fn write_file(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().expect("a file has a folder")).expect("create folder");
    std::fs::write(path, text).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
}

/// A value of the export as SQLite stores it. `sqlite3 -json` writes
/// integers, reals, text and null; nothing else can come from a row.
fn sql_value(value: &Value) -> rusqlite::types::Value {
    use rusqlite::types::Value as Sql;
    match value {
        Value::Null => Sql::Null,
        Value::Bool(flag) => Sql::Integer(i64::from(*flag)),
        Value::Number(number) => number.as_i64().map_or_else(
            || Sql::Real(number.as_f64().expect("a JSON number is a float")),
            Sql::Integer,
        ),
        Value::String(text) => Sql::Text(text.clone()),
        other => panic!("the export holds {other} where a column value belongs"),
    }
}

/// The one project the export's rows belong to.
fn project_of(rows: &[Map<String, Value>]) -> String {
    let projects: BTreeSet<&str> = rows
        .iter()
        .map(|row| {
            row.get("project_path")
                .and_then(Value::as_str)
                .expect("every exported row names its project_path")
        })
        .collect();
    assert_eq!(
        projects.len(),
        1,
        "the export must hold one project's memories; it holds {projects:?}"
    );
    projects.into_iter().next().expect("one project").to_owned()
}

/// Create `path` as a store at the plugin's last schema holding `rows`
/// exactly as exported, then bring it to this build's schema with the
/// module's own migrations, as the module migrates a person's store when it
/// first opens it.
fn build_store(path: &Path, rows: &[Map<String, Value>]) {
    let mut conn = Connection::open(path).expect("create the replay store");
    conn.execute_batch(&PLUGIN_SCHEMA.replace(":applied_at", "0"))
        .expect("the plugin's schema");
    // The plugin's hosts run with foreign keys on, and the migration must
    // not cascade-delete through them; the migration tests run it the same
    // way.
    conn.execute_batch("PRAGMA foreign_keys=ON")
        .expect("foreign keys on");
    assert_eq!(
        live_schema_version(&conn).expect("schema version"),
        i64::from(PLUGIN_SCHEMA_VERSION)
    );
    let columns: HashSet<String> = conn
        .prepare("SELECT name FROM pragma_table_info('memories')")
        .expect("memories columns")
        .query_map([], |row| row.get(0))
        .expect("memories columns")
        .collect::<rusqlite::Result<_>>()
        .expect("memories columns");
    let tx = conn.transaction().expect("insert transaction");
    for row in rows {
        for key in row.keys() {
            assert!(
                columns.contains(key),
                "the export's column {key} is not a column of the plugin's memories table"
            );
        }
        let names: Vec<String> = row.keys().map(|key| format!("\"{key}\"")).collect();
        let marks: Vec<String> = (1..=row.len()).map(|at| format!("?{at}")).collect();
        tx.execute(
            &format!(
                "INSERT INTO memories ({}) VALUES ({})",
                names.join(", "),
                marks.join(", ")
            ),
            rusqlite::params_from_iter(row.values().map(sql_value)),
        )
        .unwrap_or_else(|error| panic!("inserting memory {}: {error}", row["id"]));
    }
    tx.commit().expect("insert the exported rows");
    let found = live_schema_version(&conn).expect("schema version");
    assert_eq!(
        upgrade(&mut conn, found).expect("the module's migrations"),
        i64::from(SCHEMA_VERSION)
    );
}

/// Copy the replay's store to `to`, replacing an earlier copy.
fn fresh_copy(from: &Path, to: &Path) {
    assert!(
        from.exists(),
        "{} is missing; run classify_requests first",
        from.display()
    );
    for suffix in ["", "-wal", "-shm"] {
        let mut name = to.as_os_str().to_owned();
        name.push(suffix);
        let path = PathBuf::from(name);
        if path.exists() {
            std::fs::remove_file(&path)
                .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        }
    }
    let conn = Connection::open(from).expect("open the replay store");
    conn.execute(
        "VACUUM INTO ?1",
        [to.to_str().expect("the output folder's path is UTF-8")],
    )
    .expect("copy the replay store");
}

/// A memory's classification fields as the store holds them.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Fields {
    importance: Option<i64>,
    scope: String,
    shareable: bool,
    safety_critical: Option<bool>,
    classified_at: Option<i64>,
    revision: i64,
}

impl Fields {
    fn read(conn: &Connection, id: i64) -> Self {
        conn.query_row(
            "SELECT importance, scope, shareable, safety_critical, classified_at, revision
               FROM memories WHERE id = ?1",
            [id],
            |row| {
                Ok(Self {
                    importance: row.get(0)?,
                    scope: row.get(1)?,
                    shareable: row.get::<_, i64>(2)? != 0,
                    safety_critical: row.get::<_, Option<i64>>(3)?.map(|flag| flag != 0),
                    classified_at: row.get(4)?,
                    revision: row.get(5)?,
                })
            },
        )
        .unwrap_or_else(|error| panic!("reading memory {id}: {error}"))
    }

    fn to_json(&self, id: i64, category: &str) -> Value {
        json!({
            "id": id,
            "category": category,
            "importance": self.importance,
            "scope": self.scope,
            "shareable": self.shareable,
            "safety_critical": self.safety_critical,
            "classified_at": self.classified_at,
            "revision": self.revision,
        })
    }

    fn from_json(value: &Value) -> Self {
        Self {
            importance: value["importance"].as_i64(),
            scope: value["scope"].as_str().unwrap_or_default().to_owned(),
            shareable: value["shareable"].as_bool().unwrap_or(false),
            safety_critical: value["safety_critical"].as_bool(),
            classified_at: value["classified_at"].as_i64(),
            revision: value["revision"].as_i64().unwrap_or_default(),
        }
    }
}

/// Every memory's fields, by id.
fn read_fields(db: &ContextDb, ids: &[i64]) -> HashMap<i64, Fields> {
    db.with_connection(|conn| {
        ids.iter()
            .map(|id| (*id, Fields::read(conn, *id)))
            .collect()
    })
}

/// The classification fields a newly written project memory holds. A probe
/// memory is written through the module's own writer, as the summarizer's
/// publish step writes a new fact (no importance of its own, the historian
/// as source), its fields are read, and the transaction is rolled back, so
/// the reset follows the writer and the table's defaults wherever they go.
fn new_memory_fields(db: &ContextDb, project: &str) -> Fields {
    db.with_connection(|conn| {
        let tx = conn.transaction().expect("probe transaction");
        let tag = "PROJECT_RULES";
        let row = NewRow {
            level: "project".into(),
            owner_id: project.to_owned(),
            category_id: frozen_category_id(tag).to_owned(),
            origin_profile: None,
            source_ordinals_json: None,
        };
        let memory = insert_memory(
            &tx,
            &row,
            project,
            tag,
            "A probe written only to read what a new memory holds; never committed.",
            "",
            "historian",
            None,
        )
        .expect("writing a probe memory");
        // Dropping the transaction without committing removes the probe.
        Fields::read(&tx, memory.id)
    })
}

/// Run `body` with the context the engine builds for a classify run of
/// `project`: the bundled profile, its `swe:classify-memories` declaration,
/// and the project as owner.
fn with_context<T>(db: &ContextDb, project: &str, body: impl FnOnce(&TaskContext<'_>) -> T) -> T {
    let profile = prompt_profile(None).expect("the bundled profile");
    let declaration = declaration(&profile);
    // Classify never reads the project's folder, and the folder never
    // reaches a prompt (the project is named by its id), so any path does.
    let owner = Owner::Project {
        id: project.to_owned(),
        root: format!("/replay/{project}"),
    };
    body(&TaskContext {
        db,
        owner: &owner,
        profile: &profile,
        declaration: &declaration,
        workspace: None,
    })
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
        "{TASK_ID} is not a classify task"
    );
    declaration
}

/// One batch of the run, with each memory it classifies and the revision
/// it read that memory at.
struct Planned {
    batch: Box<dyn Batch>,
    read: Vec<(i64, i64)>,
}

/// The run's plan and its batches, as the engine gets them from the task.
///
/// A batch keeps the memories it read to itself, so they are worked out
/// here from the same plan the task makes from the same rows. Each batch
/// must then accept a reply that names exactly those memories, which is the
/// check that the two agree.
fn plan_run(db: &ContextDb, project: &str) -> (Plan, Vec<Planned>) {
    let live = db
        .with_connection(|conn| live_memories(conn, project))
        .expect("reading the project's live memories");
    let plan = plan(&live);
    let revisions: HashMap<i64, i64> = live
        .iter()
        .map(|memory| (memory.id, memory.revision))
        .collect();
    let batches = with_context(db, project, |context| Classify.batches(context))
        .expect("planning the classify run");
    let reads: Vec<Vec<(i64, i64)>> = plan
        .targets
        .chunks(BATCH_SIZE)
        .map(|chunk| chunk.iter().map(|id| (*id, revisions[id])).collect())
        .collect();
    assert_eq!(
        batches.len(),
        reads.len(),
        "the task planned a different number of batches than its plan's targets fill"
    );
    let planned: Vec<Planned> = batches
        .into_iter()
        .zip(reads)
        .map(|(batch, read)| Planned { batch, read })
        .collect();
    for (index, planned) in planned.iter().enumerate() {
        let entries: String = planned
            .read
            .iter()
            .map(|(id, _)| format!("<memory id=\"{id}\" importance=\"{UNSET_IMPORTANCE}\"/>\n"))
            .collect();
        if let Err(refusal) = planned
            .batch
            .accepts(&format!("<classify>\n{entries}</classify>"))
        {
            panic!("batch {index} classifies other memories than the plan names: {refusal}");
        }
    }
    (plan, planned)
}

/// The message `batch` sends.
fn message(batch: &dyn Batch) -> String {
    let window = Window {
        counter: Counter::for_model(None),
        context_window: ANY_WINDOW,
    };
    batch
        .prompt(window, DREAM_OUTPUT_TOKENS)
        .expect("a classify batch fits a window this large")
}

/// Positions `count` picks spread evenly over `len` items: the middle of
/// each of `count` equal slices, so the first and last items of a long list
/// are not favoured and no position repeats.
fn spread(len: usize, count: usize) -> Vec<usize> {
    let count = count.min(len);
    (0..count)
        .map(|pick| (2 * pick + 1) * len / (2 * count))
        .collect()
}

#[test]
#[ignore = "builds classify replay requests from a local memory export; see .cortexkit/scripts/dreamer-replay/README.md"]
fn classify_requests() {
    let out = out_dir();
    let corpus = corpus_file();
    let wanted = sample_size();
    let store = out.join(STORE);
    assert!(
        !store.exists() && !out.join(MANIFEST).exists(),
        "{} already holds a replay; write a new one to a fresh DREAMER_REPLAY_OUT",
        out.display()
    );
    std::fs::create_dir_all(&out).expect("create the output folder");

    let bytes =
        std::fs::read(&corpus).unwrap_or_else(|error| panic!("{}: {error}", corpus.display()));
    let digest: String = Sha256::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let rows: Vec<Map<String, Value>> = serde_json::from_slice(&bytes)
        .unwrap_or_else(|error| panic!("{}: {error}", corpus.display()));
    let project = project_of(&rows);
    build_store(&store, &rows);
    let db = ContextDb::open(&store).expect("open the migrated store");

    // The sample: classified live memories, evenly spread over their id
    // order. A memory the summarizer still owes a score is left out, as the
    // task leaves it out of its run.
    let live = db
        .with_connection(|conn| live_memories(conn, &project))
        .expect("reading the project's live memories");
    let classified: Vec<_> = live
        .iter()
        .filter(|memory| memory.classified && !memory.open_item)
        .collect();
    let sampled: Vec<_> = spread(classified.len(), wanted)
        .into_iter()
        .map(|at| classified[at])
        .collect();
    // Live memories the export already holds unclassified are in the run
    // too, as they would be in a real one.
    let unclassified: Vec<_> = live
        .iter()
        .filter(|memory| !memory.classified && !memory.open_item)
        .collect();
    let sampled_ids: Vec<i64> = sampled.iter().map(|memory| memory.id).collect();
    let unclassified_ids: Vec<i64> = unclassified.iter().map(|memory| memory.id).collect();
    let prior = read_fields(&db, &sampled_ids);
    let prior_unclassified = read_fields(&db, &unclassified_ids);
    let reset = new_memory_fields(&db, &project);
    assert_eq!(
        reset.classified_at, None,
        "a newly written memory must be unclassified, or classify would never see it"
    );
    db.with_connection(|conn| {
        let tx = conn.transaction()?;
        for id in &sampled_ids {
            tx.execute(
                "UPDATE memories SET classified_at = NULL, importance = ?2, scope = ?3, shareable = ?4,
                        safety_critical = ?5
                  WHERE id = ?1",
                params![
                    id,
                    reset.importance,
                    reset.scope,
                    reset.shareable,
                    reset.safety_critical
                ],
            )?;
        }
        tx.commit()
    })
    .expect("resetting the sample to new memories");
    // Only the classification fields moved, the revision included: a changed
    // revision would make the task's writes look stale against what it read.
    for (id, fields) in read_fields(&db, &sampled_ids) {
        assert_eq!(
            fields,
            Fields {
                revision: prior[&id].revision,
                ..reset.clone()
            },
            "memory {id} was not reset to a new memory's values"
        );
    }

    let (plan, planned) = plan_run(&db, &project);
    let targets: HashSet<i64> = plan.targets.iter().copied().collect();
    for id in sampled_ids.iter().chain(&unclassified_ids) {
        assert!(targets.contains(id), "memory {id} is not in the run");
    }
    assert_eq!(targets.len(), sampled_ids.len() + unclassified_ids.len());

    let counter = Counter::for_model(None);
    let mut listed = Vec::new();
    for (index, planned) in planned.iter().enumerate() {
        let system = planned.batch.system().to_owned();
        let user = message(planned.batch.as_ref());
        let path = batch_dir(&out, index).join(REQUEST);
        write_file(
            &path,
            &pretty(&json!({
                "task": TASK_ID,
                "batch": index,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
            })),
        );
        let (system_tokens, user_tokens) = (counter.count(&system), counter.count(&user));
        println!(
            "batch {index}: {} memories, system {} chars / ~{system_tokens} tokens, user {} chars / ~{user_tokens} tokens",
            planned.read.len(),
            system.chars().count(),
            user.chars().count()
        );
        listed.push(json!({
            "batch": index,
            "request": format!("batch-{index}/{REQUEST}"),
            "reply": format!("batch-{index}/{REPLY}"),
            "memories": planned
                .read
                .iter()
                .map(|(id, revision)| json!({"id": id, "readRevision": revision}))
                .collect::<Vec<_>>(),
            "systemChars": system.chars().count(),
            "userChars": user.chars().count(),
            "systemTokens": system_tokens,
            "userTokens": user_tokens,
        }));
    }
    let profile = prompt_profile(None).expect("the bundled profile");
    // What every sampled memory was reset to, and what the model is shown as
    // its current values.
    let reset_json = json!({
        "importance": reset.importance,
        "scope": reset.scope,
        "shareable": reset.shareable,
        "safety_critical": reset.safety_critical,
    });
    write_file(
        &out.join(MANIFEST),
        &pretty(&json!({
            "project": project,
            "corpus": {"file": corpus, "sha256": digest, "rows": rows.len()},
            "store": STORE,
            "schema": {"exportedAt": PLUGIN_SCHEMA_VERSION, "migratedTo": SCHEMA_VERSION},
            "profile": {"name": profile.name, "version": profile.version, "digest": profile.digest},
            "task": TASK_ID,
            "kind": KIND,
            "run": RUN,
            "outputTokens": DREAM_OUTPUT_TOKENS,
            "tokenCounts": "the module's estimate for a model it has no vocabulary for",
            "liveMemories": live.len(),
            "stage": plan.stage,
            "targets": plan.targets.len(),
            "anchors": plan.anchors,
            "sampleResetTo": reset_json,
            "batches": listed,
        })),
    );
    let category = |id: i64| {
        live.iter()
            .find(|memory| memory.id == id)
            .map(|memory| memory.category.clone())
            .unwrap_or_default()
    };
    write_file(
        &out.join(SAMPLE),
        &pretty(&json!({
            "project": project,
            "requested": wanted,
            "classifiedLive": classified.len(),
            "picked": "the middle of each of `requested` equal slices of the classified live memories in id order",
            "resetTo": reset_json,
            "sampled": sampled_ids
                .iter()
                .map(|id| prior[id].to_json(*id, &category(*id)))
                .collect::<Vec<_>>(),
            "alreadyUnclassified": unclassified_ids
                .iter()
                .map(|id| prior_unclassified[id].to_json(*id, &category(*id)))
                .collect::<Vec<_>>(),
        })),
    );
    println!(
        "{project}: {} live memories; {} sampled, {} already unclassified; {} batches written to {}",
        live.len(),
        sampled_ids.len(),
        unclassified_ids.len(),
        planned.len(),
        out.display()
    );
}

/// What became of one batch's reply.
#[derive(Default)]
struct BatchOutcome {
    /// The reply file the sender wrote, when there is one.
    record: Option<Value>,
    /// Why the reply was not applied: the send failed, the reply hit its
    /// output limit, or the batch's `accepts` refused it.
    refused: Option<String>,
    /// What the reply proposes for each memory, as far as its manifest
    /// reads; the parse error when it doesn't read at all.
    proposals: HashMap<i64, Classification>,
    parse_error: Option<String>,
    /// What applying the reply did.
    applied: Option<Applied>,
    /// The decisions the apply recorded in the store's journal.
    decisions: Vec<String>,
}

impl BatchOutcome {
    fn was_applied(&self) -> bool {
        self.applied.is_some()
    }
}

/// Use `index`'s reply, if the sender wrote one, as the engine uses a
/// reply: a reply cut off at its output limit or refused by the batch's
/// `accepts` counts as a failed model and is never applied; an accepted one
/// is applied in its own transaction.
fn apply_batch(db: &ContextDb, out: &Path, index: usize, planned: &Planned) -> BatchOutcome {
    let path = batch_dir(out, index).join(REPLY);
    let mut outcome = BatchOutcome::default();
    if !path.exists() {
        return outcome;
    }
    let record = read_json(&path);
    outcome.record = Some(record.clone());
    if record["ok"] != json!(true) {
        outcome.refused = Some(format!(
            "the send failed: {}",
            record["error"].as_str().unwrap_or("no error recorded")
        ));
        return outcome;
    }
    let text = record["body"]["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    match parse_manifest(&text) {
        Ok(found) => {
            outcome.proposals = found.into_iter().map(|entry| (entry.id, entry)).collect();
        }
        Err(error) => outcome.parse_error = Some(error),
    }
    if record["finishReason"] == json!("length") {
        outcome.refused = Some(
            "the reply hit its output limit; the engine fails the model before the task reads the reply"
                .into(),
        );
        return outcome;
    }
    if let Err(refusal) = planned.batch.accepts(&text) {
        outcome.refused = Some(format!("`accepts` refused the reply: {refusal}"));
        return outcome;
    }
    let reply = TaskReply {
        text,
        model: ModelRef::new(
            "replay",
            record["sent"]["model"].as_str().unwrap_or_default(),
        ),
        runner: "replay".into(),
        // The child the engine's first attempt at this batch would run in.
        child: child_session(&format!("{RUN}.{index}"), 0, 0),
        usage: None,
    };
    let applied = db.with_connection(|conn| {
        let last: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(id), 0) FROM memory_journal",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        let applied = planned.batch.apply(&tx, &reply, RUN)?;
        tx.commit().map_err(|error| error.to_string())?;
        let mut statement = conn
            .prepare("SELECT decision_key FROM memory_journal WHERE id > ?1 ORDER BY id")
            .map_err(|error| error.to_string())?;
        let decisions = statement
            .query_map([last], |row| row.get(0))
            .map_err(|error| error.to_string())?
            .collect::<rusqlite::Result<Vec<String>>>()
            .map_err(|error| error.to_string())?;
        Ok::<_, String>((applied, decisions))
    });
    match applied {
        Ok((applied, decisions)) => {
            outcome.applied = Some(applied);
            outcome.decisions = decisions;
        }
        Err(error) => outcome.refused = Some(format!("applying the reply failed: {error}")),
    }
    outcome
}

#[test]
#[ignore = "applies classify replay replies to a copy of the replay's store; see .cortexkit/scripts/dreamer-replay/README.md"]
fn classify_apply() {
    let out = out_dir();
    let manifest = read_json(&out.join(MANIFEST));
    let sample = read_json(&out.join(SAMPLE));
    let project = manifest["project"]
        .as_str()
        .expect("the manifest names the project")
        .to_owned();
    let applied_path = out.join(APPLIED);
    fresh_copy(&out.join(STORE), &applied_path);
    let db = ContextDb::open(&applied_path).expect("open the store copy");

    // The copy must plan the very requests that were sent: a reply answers
    // the request it was given, and applying it to another batch would pair
    // it with memories it never saw.
    let (_, planned) = plan_run(&db, &project);
    let listed = manifest["batches"]
        .as_array()
        .expect("the manifest lists the batches");
    assert_eq!(
        listed.len(),
        planned.len(),
        "the store plans a different run than the manifest lists"
    );
    for (index, (planned, listed)) in planned.iter().zip(listed).enumerate() {
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
            planned.read, read,
            "batch {index} reads other memories than the manifest lists"
        );
        let request = read_json(&batch_dir(&out, index).join(REQUEST));
        assert_eq!(
            request["messages"],
            json!([
                {"role": "system", "content": planned.batch.system()},
                {"role": "user", "content": message(planned.batch.as_ref())},
            ]),
            "batch {index}'s request is not the one the store plans"
        );
    }

    let targets: Vec<i64> = planned
        .iter()
        .flat_map(|planned| planned.read.iter().map(|(id, _)| *id))
        .collect();
    let before = read_fields(&db, &targets);
    let outcomes: Vec<BatchOutcome> = planned
        .iter()
        .enumerate()
        .map(|(index, planned)| apply_batch(&db, &out, index, planned))
        .collect();
    let after = read_fields(&db, &targets);
    let report = Report {
        project: &project,
        planned: &planned,
        outcomes: &outcomes,
        before: &before,
        after: &after,
        db: &db,
    }
    .render(&sample);
    write_file(&out.join(REPORT), &report);
    println!(
        "{} of {} batches applied; report written to {}",
        outcomes
            .iter()
            .filter(|outcome| outcome.was_applied())
            .count(),
        outcomes.len(),
        out.join(REPORT).display()
    );
}

/// What `report.md` is written from.
struct Report<'a> {
    project: &'a str,
    planned: &'a [Planned],
    outcomes: &'a [BatchOutcome],
    /// Each memory of the run before the replies were applied, and after.
    before: &'a HashMap<i64, Fields>,
    after: &'a HashMap<i64, Fields>,
    db: &'a ContextDb,
}

/// How many memories changed in each way the report totals.
#[derive(Default)]
struct Tally {
    importance: usize,
    scope: usize,
    shareable: usize,
    critical: usize,
}

impl Tally {
    /// Count the change from `prior` to what `importance`, `scope`,
    /// `shareable` and `critical` say; a field that is `None` was not
    /// proposed and changes nothing.
    fn count(
        &mut self,
        prior: &Fields,
        importance: Option<i64>,
        scope: Option<&str>,
        shareable: Option<bool>,
        critical: Option<bool>,
    ) {
        let was = prior.importance.unwrap_or(UNSET_IMPORTANCE);
        if importance.is_some_and(|score| (score - was).abs() > BIG_IMPORTANCE_CHANGE) {
            self.importance += 1;
        }
        if scope.is_some_and(|scope| scope != prior.scope) {
            self.scope += 1;
        }
        if shareable.is_some_and(|flag| flag != prior.shareable) {
            self.shareable += 1;
        }
        if critical == Some(true) && prior.safety_critical != Some(true) {
            self.critical += 1;
        }
    }
}

/// A markdown table cell holding `text` on one line.
fn cell(text: &str) -> String {
    text.replace(['\r', '\n'], " ").replace('|', "\\|")
}

fn excerpt(text: &str) -> String {
    let mut short: String = text.chars().take(EXCERPT_CHARS).collect();
    if text.chars().count() > EXCERPT_CHARS {
        short.push('…');
    }
    cell(&short)
}

fn flag(value: Option<bool>) -> &'static str {
    match value {
        Some(true) => "1",
        Some(false) => "0",
        None => "∅",
    }
}

/// A memory's stored fields: importance, scope, shareable, safety-critical.
fn show_fields(fields: &Fields) -> String {
    format!(
        "{} · {} · share {} · crit {}",
        fields
            .importance
            .map_or_else(|| "∅".to_owned(), |score| score.to_string()),
        fields.scope,
        flag(Some(fields.shareable)),
        flag(fields.safety_critical)
    )
}

/// What a reply proposes for the two fields the task reads, importance and
/// safety-critical; `–` for a field it leaves out.
fn show_proposal(proposal: &Classification) -> String {
    let omitted = |value: Option<String>| value.unwrap_or_else(|| "–".to_owned());
    format!(
        "{} · crit {}",
        omitted(proposal.importance.map(|score| score.to_string())),
        omitted(
            proposal
                .safety_critical
                .map(|value| flag(Some(value)).to_owned())
        )
    )
}

/// Whether a dropped proposal's reason is about memory `id`.
fn about(reason: &str, id: i64) -> bool {
    reason.starts_with(&format!("memory {id} ")) || reason.starts_with(&format!("memory {id}:"))
}

impl Report<'_> {
    fn render(&self, sample: &Value) -> String {
        let mut lines = vec![
            format!("# Classify replay: {}", self.project),
            String::new(),
            format!(
                "Each accepted reply was applied to `{APPLIED}`, a fresh copy of `{STORE}`, in its own transaction, as run {RUN} of the engine applies it. \
                 *Prior* is the memory as the export holds it, which is what the 0.49 dreamer decided; *model* is what the reply proposes; *written* is the row afterwards."
            ),
            String::new(),
            format!(
                "Before the run, each sampled memory was reset to what a newly written memory holds ({}, unclassified), \
                 because a real run only classifies memories that were never classified. The pool shows the model only each memory's id, category and text.",
                show_fields(&Fields::from_json(&sample["resetTo"]))
            ),
            String::new(),
            "Fields: importance · scope · shareable · safety-critical. The *model* column shows only importance · safety-critical, the two fields the task reads. `∅`: unset in the store. `–`: the reply leaves the field out, so the memory keeps its value.".into(),
            String::new(),
            "## Batches".into(),
            String::new(),
            "| batch | memories | model | finish | tokens in / out | seconds | outcome |".into(),
            "|---|---|---|---|---|---|---|".into(),
        ];
        for (index, (planned, outcome)) in self.planned.iter().zip(self.outcomes).enumerate() {
            let record = outcome.record.as_ref();
            let field = |pointer: &str| {
                record
                    .and_then(|record| record.pointer(pointer))
                    .filter(|value| !value.is_null())
                    .map_or_else(
                        || "–".to_owned(),
                        |value| {
                            value
                                .as_str()
                                .map_or_else(|| value.to_string(), str::to_owned)
                        },
                    )
            };
            let seconds = record.map_or_else(
                || "–".to_owned(),
                |record| {
                    let ms: i64 = record["attempts"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|attempt| attempt["elapsedMs"].as_i64())
                        .sum();
                    format!("{:.1}", ms as f64 / 1000.0)
                },
            );
            let state = match (&outcome.applied, &outcome.refused) {
                (Some(applied), _) => format!(
                    "applied: {} proposed, {} applied, {} dropped",
                    applied.proposed,
                    applied.applied,
                    applied.dropped.len()
                ),
                (None, Some(_)) => "not applied (see below)".into(),
                (None, None) => "no reply yet".into(),
            };
            lines.push(format!(
                "| {index} | {} | {} | {} | {} / {} | {seconds} | {state} |",
                planned.read.len(),
                cell(&field("/sent/model")),
                field("/finishReason"),
                field("/usage/prompt_tokens"),
                field("/usage/completion_tokens"),
            ));
        }
        for (index, outcome) in self.outcomes.iter().enumerate() {
            if outcome.record.is_none() {
                continue;
            }
            lines.push(String::new());
            lines.push(format!("### Batch {index}"));
            lines.push(String::new());
            if let Some(refused) = &outcome.refused {
                lines.push(format!("- Not applied: {}", cell(refused)));
            }
            if let Some(error) = &outcome.parse_error {
                lines.push(format!(
                    "- The reply's manifest does not read: {}",
                    cell(error)
                ));
            }
            for decision in &outcome.decisions {
                lines.push(format!("- Recorded as decision `{decision}`"));
            }
            match &outcome.applied {
                Some(applied) if applied.dropped.is_empty() => {
                    lines.push("- No proposal was dropped.".into());
                }
                Some(applied) => {
                    lines.push(format!("- Dropped proposals ({}):", applied.dropped.len()));
                    for reason in &applied.dropped {
                        lines.push(format!("  - {}", cell(reason)));
                    }
                }
                None => {}
            }
        }

        let in_batch: HashMap<i64, usize> = self
            .planned
            .iter()
            .enumerate()
            .flat_map(|(index, planned)| planned.read.iter().map(move |(id, _)| (*id, index)))
            .collect();
        let group = |key: &str| -> Vec<(i64, Fields)> {
            sample[key]
                .as_array()
                .into_iter()
                .flatten()
                .map(|entry| {
                    (
                        entry["id"].as_i64().unwrap_or_default(),
                        Fields::from_json(entry),
                    )
                })
                .collect()
        };
        let sampled = group("sampled");
        let unclassified = group("alreadyUnclassified");

        let (mut proposed, mut written, mut counted) = (Tally::default(), Tally::default(), 0);
        for (id, prior) in &sampled {
            let outcome = &self.outcomes[in_batch[id]];
            if !outcome.was_applied() {
                continue;
            }
            counted += 1;
            if let Some(proposal) = outcome.proposals.get(id) {
                proposed.count(
                    prior,
                    proposal.importance,
                    None,
                    None,
                    proposal.safety_critical,
                );
            }
            let now = &self.after[id];
            written.count(
                prior,
                now.importance,
                Some(now.scope.as_str()),
                Some(now.shareable),
                now.safety_critical,
            );
        }
        lines.extend([
            String::new(),
            "## Totals".into(),
            String::new(),
            format!(
                "Over the {counted} of {} sampled memories whose batch was applied, against their prior values. \
                 An unset importance counts as {UNSET_IMPORTANCE}, as the task ranks it. \
                 *Written* can differ from *proposed* by the task's own rules: a safety-critical memory's importance is raised to its floor. \
                 The task writes neither scope nor shareability, so a sampled memory keeps the scope and shareability it was reset to.",
                sampled.len()
            ),
            String::new(),
            "| change | proposed by the model | written |".into(),
            "|---|---|---|".into(),
            format!(
                "| importance moved by more than {BIG_IMPORTANCE_CHANGE} points | {} | {} |",
                proposed.importance, written.importance
            ),
            format!("| scope flipped | – | {} |", written.scope),
            format!("| shareable flipped | – | {} |", written.shareable),
            format!("| became safety-critical | {} | {} |", proposed.critical, written.critical),
        ]);

        lines.extend([
            String::new(),
            format!("## Sampled memories ({})", sampled.len()),
            String::new(),
            "Classified by the 0.49 dreamer, then reset to a new memory's values for this run."
                .into(),
        ]);
        self.memory_table(&mut lines, &sampled, &in_batch);
        lines.extend([
            String::new(),
            format!("## Memories the export already holds unclassified ({})", unclassified.len()),
            String::new(),
            "The run classifies these too, as a real one would; their prior values are not a dreamer's decision.".into(),
        ]);
        self.memory_table(&mut lines, &unclassified, &in_batch);
        lines.join("\n") + "\n"
    }

    fn memory_table(
        &self,
        lines: &mut Vec<String>,
        memories: &[(i64, Fields)],
        in_batch: &HashMap<i64, usize>,
    ) {
        lines.push(String::new());
        lines.push("| id | batch | category | text | prior | model | written | outcome |".into());
        lines.push("|---|---|---|---|---|---|---|---|".into());
        for (id, prior) in memories {
            let batch = in_batch[id];
            let outcome = &self.outcomes[batch];
            let (category, content): (String, String) = self
                .db
                .with_connection(|conn| {
                    conn.query_row(
                        "SELECT origin_category, content FROM memories WHERE id = ?1",
                        [id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()
                })
                .expect("reading a memory's text")
                .unwrap_or_default();
            let model = match (&outcome.record, outcome.proposals.get(id)) {
                (None, _) => "no reply yet".to_owned(),
                (Some(_), Some(proposal)) => show_proposal(proposal),
                (Some(_), None) if outcome.parse_error.is_some() => "unreadable reply".to_owned(),
                (Some(_), None) => "not in the reply".to_owned(),
            };
            let (written, note) = match &outcome.applied {
                None if outcome.record.is_none() => ("–".to_owned(), "no reply yet".to_owned()),
                None => (
                    "–".to_owned(),
                    format!("not applied: batch {batch}'s reply was not used"),
                ),
                Some(applied) => {
                    let (was, now) = (&self.before[id], &self.after[id]);
                    let mut note = if now.revision != was.revision {
                        format!("written, revision {} → {}", was.revision, now.revision)
                    } else if now.classified_at.is_some() {
                        "kept the values it was sent with; marked classified".to_owned()
                    } else {
                        "not written".to_owned()
                    };
                    for reason in applied.dropped.iter().filter(|reason| about(reason, *id)) {
                        note.push_str("; dropped: ");
                        note.push_str(reason);
                    }
                    (show_fields(now), note)
                }
            };
            lines.push(format!(
                "| {id} | {batch} | {} | {} | {} | {model} | {written} | {} |",
                cell(&category),
                excerpt(&content),
                show_fields(prior),
                cell(&note)
            ));
        }
    }
}
