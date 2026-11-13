//! A simulation of which learned memories a session's head would show under
//! the rendering function in `memory_render`, next to what the head shows
//! today, over a copy of a real store. Its output is what the function's
//! open parameters are chosen from: the half-life of drifting memories, each
//! level's minimum share and the protected slice for safety-critical rules.
//!
//! [`simulate`] is ignored, so it runs only when asked. It reads its inputs
//! from the environment:
//! - `MEMORY_SIM_STORE`: the store copy, a `context.db` at the plugin's last
//!   schema or later. It is only ever read: the file, and its `-wal` when
//!   there is one, is copied to `$MEMORY_SIM_OUT/store.db`, and the module
//!   opens that copy, migrating it to the schema this build reads.
//! - `MEMORY_SIM_OUT`: the output folder. It must be missing or empty, and it
//!   is the only place anything is written.
//! - `MEMORY_SIM_GRID`: a JSON file holding a list of parameter sets, each
//!   `{"name", "half_life_days", "protected_tokens",
//!   "minimum": {"global", "workspace", "project"}}`.
//! - `MEMORY_SIM_MODEL` (optional): the `provider/model` the heads run on.
//!   The head counts tokens in that model's vocabulary; unset, the counts
//!   use the module's estimate, as a head does for a model it has no
//!   vocabulary for.
//! - `MEMORY_SIM_NOW_MS` (optional): when the heads are rendered, in ms since
//!   the epoch; the current time when unset.
//!
//! ```text
//! MEMORY_SIM_STORE=… MEMORY_SIM_OUT=… MEMORY_SIM_GRID=… \
//!   cargo test --locked -p mc-module --lib memory_render_sim_tests::simulate -- --ignored --exact
//! ```
//!
//! For each project with live project memories it works out today's head
//! (the project block and the user profile, through the head's own trims at
//! today's default budgets) and, for each parameter set, the new selection
//! from the rows the head would see at the new schema. It writes
//! `report.md` and `results.json`: per project and parameter set, the
//! counts shown before and after, the memories that leave and arrive, the
//! safety-critical or permanent memories not shown, and each level's tokens
//! against its minimum; then one summary table per parameter set.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::context_db::{ContextDb, StoredMemory, FRESH_SCHEMA};
use crate::context_migrations::SCHEMA_VERSION;
use crate::count::Counter;
use crate::memory;
use crate::memory_profile::prompt_profile;
use crate::memory_render::{level_tokens, select, Budget, Candidate, Decay, Level, Selection};
use crate::memory_writes::{self, Writer};
use crate::pass::Settings;
use crate::summary::head;
use crate::workspace::Workspace;

const DAY_MS: f64 = 86_400_000.0;
/// How much of a memory's text the report shows.
const EXCERPT_CHARS: usize = 120;
const STORE: &str = "store.db";
const REPORT: &str = "report.md";
const RESULTS: &str = "results.json";
/// The levels simulated, in the order a head shows them. Agent memories are
/// left out: no writer creates them yet, and the head has no agent block.
const LEVELS: [Level; 3] = [Level::Global, Level::Workspace, Level::Project];
/// A row the head may show: live, and not past its end. `?1` is the time
/// the head is rendered at. Today's head reads with the same condition.
const LIVE: &str = "status IN ('active', 'permanent') AND (expires_at IS NULL OR expires_at > ?1)";
/// The columns [`Row::read`] reads, in its order.
const ROW_COLUMNS: &str = "id, level, owner_id, category, origin_category, content, importance,
    status, authority, safety_critical, decay_class, last_seen_at, verified_at, expires_at,
    overrides_memory_id, source_project_id";
/// Why a candidate field is the same for every row: the store keeps nothing
/// it could be read from.
const FIELDS_WITHOUT_SOURCE: [(&str, &str); 1] = [(
    "resolved",
    "no column records that an open-until-resolved memory was resolved, so none is hidden for it",
)];

/// The total token budget the rendering function fills, from today's two
/// separate head budgets: the project memory block's
/// (`memory.injection_budget_tokens`) and the user profile's. The function
/// fills every level from one total, so it gets both together; the user
/// profile becomes its global level. Change this function (and
/// [`COMBINATION`]) to simulate another split.
fn combined_total(memory_budget: u64, profile_budget: u64) -> u64 {
    memory_budget + profile_budget
}

/// How [`combined_total`] combines the budgets, for the report.
const COMBINATION: &str = "project memory budget + user profile budget";

/// One parameter set of the grid.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Params {
    name: String,
    half_life_days: f64,
    protected_tokens: u64,
    minimum: Minimum,
}

/// Each level's minimum share, in tokens.
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Minimum {
    global: u64,
    workspace: u64,
    project: u64,
}

impl Params {
    fn minimum(&self, level: Level) -> u64 {
        match level {
            Level::Global => self.minimum.global,
            Level::Workspace => self.minimum.workspace,
            Level::Project => self.minimum.project,
            Level::Agent => 0,
        }
    }

    fn budget(&self, total_tokens: u64) -> Budget {
        Budget {
            total_tokens,
            protected_tokens: self.protected_tokens,
            level_minimum_tokens: LEVELS
                .iter()
                .map(|level| (*level, self.minimum(*level)))
                .collect(),
            half_life_ms: (self.half_life_days * DAY_MS).round() as i64,
        }
    }
}

/// What one simulation runs on.
struct Inputs {
    store: PathBuf,
    out: PathBuf,
    grid: Vec<Params>,
    /// The `provider/model` whose vocabulary the head counts in; `None`
    /// counts with the module's estimate.
    model: Option<String>,
    now_ms: i64,
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn env_text(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}

impl Inputs {
    fn from_env() -> Self {
        let grid_file = env_path("MEMORY_SIM_GRID")
            .expect("set MEMORY_SIM_GRID to the JSON file listing the parameter sets");
        let grid = std::fs::read_to_string(&grid_file)
            .unwrap_or_else(|error| panic!("{}: {error}", grid_file.display()));
        Self {
            store: env_path("MEMORY_SIM_STORE")
                .expect("set MEMORY_SIM_STORE to the store copy (a context.db)"),
            out: env_path("MEMORY_SIM_OUT")
                .expect("set MEMORY_SIM_OUT to a new, empty output folder"),
            grid: serde_json::from_str(&grid)
                .unwrap_or_else(|error| panic!("{}: {error}", grid_file.display())),
            model: env_text("MEMORY_SIM_MODEL"),
            now_ms: env_text("MEMORY_SIM_NOW_MS").map_or_else(now_ms, |value| {
                value
                    .parse()
                    .expect("MEMORY_SIM_NOW_MS is a time in ms since the epoch")
            }),
        }
    }
}

#[test]
#[ignore = "simulates memory rendering over the store copy MEMORY_SIM_STORE names; see the module comment"]
fn simulate() {
    let inputs = Inputs::from_env();
    let results = run(&inputs).unwrap_or_else(|error| panic!("{error}"));
    println!(
        "{} projects under {} parameter sets; report written to {}",
        results["projects"].as_array().map_or(0, Vec::len),
        inputs.grid.len(),
        inputs.out.join(REPORT).display()
    );
}

/// Run the simulation: copy and open the store, work out every project's
/// head today and under each parameter set, and write the report and the
/// results into the output folder. Returns the results as written.
fn run(inputs: &Inputs) -> Result<Value, String> {
    check_grid(&inputs.grid)?;
    refuse_live(&inputs.store, "MEMORY_SIM_STORE")?;
    refuse_live(&inputs.out, "MEMORY_SIM_OUT")?;
    prepare_out(&inputs.out)?;
    let db = open_copy(&inputs.store, &inputs.out)?;

    // Today's budgets are the defaults unless `MEMORY_SIM_MEMORY_BUDGET`
    // stands in for a configured `memory.injection_budget_tokens`, so a
    // simulation can also show what a head with that setting gets.
    let settings = Settings::default();
    let memory_budget = match env_text("MEMORY_SIM_MEMORY_BUDGET") {
        Some(text) => text
            .parse::<u64>()
            .map_err(|error| format!("MEMORY_SIM_MEMORY_BUDGET {text:?}: {error}"))?,
        None => settings.memory_budget_tokens,
    };
    let budgets = Budgets {
        memory: memory_budget,
        profile: settings.profile_budget_tokens,
    };
    let counter = Counter::for_model(inputs.model.as_deref());
    let (profile_today, profile_active) = profile_today(&db, budgets.profile, counter)?;
    let context = Context {
        counter,
        classes: decay_classes()?,
        now: inputs.now_ms,
        budgets,
        profile_today,
        profile_active,
    };
    let projects = project_owners(&db, inputs.now_ms)?
        .iter()
        .map(|owner| build_project(&db, owner, &context))
        .collect::<Result<Vec<_>, _>>()?;
    let total = combined_total(budgets.memory, budgets.profile);
    let runs: Vec<Vec<Run>> = projects
        .iter()
        .map(|project| {
            inputs
                .grid
                .iter()
                .map(|params| run_params(project, params, total, inputs.now_ms))
                .collect()
        })
        .collect();
    let sim = Simulation {
        inputs,
        context: &context,
        total,
        projects: &projects,
        runs: &runs,
    };
    let results = sim.results();
    write(
        &inputs.out.join(RESULTS),
        &(serde_json::to_string_pretty(&results).map_err(|error| error.to_string())? + "\n"),
    )?;
    write(&inputs.out.join(REPORT), &sim.report())?;
    Ok(results)
}

fn check_grid(grid: &[Params]) -> Result<(), String> {
    if grid.is_empty() {
        return Err("the grid lists no parameter sets".into());
    }
    let mut names = HashSet::new();
    for params in grid {
        if !names.insert(params.name.as_str()) {
            return Err(format!("the grid names {:?} twice", params.name));
        }
        if !params.half_life_days.is_finite() || params.half_life_days < 0.0 {
            return Err(format!(
                "{:?}: half_life_days must be a number of days, 0 or more",
                params.name
            ));
        }
    }
    Ok(())
}

fn write(path: &Path, text: &str) -> Result<(), String> {
    std::fs::write(path, text).map_err(|error| format!("{}: {error}", path.display()))
}

/// `path` made absolute with every link resolved, for the parts of it that
/// exist; the missing rest is appended as given.
fn resolve(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir().map_or_else(|_| path.to_owned(), |dir| dir.join(path))
    };
    let mut existing = absolute.as_path();
    let mut missing = Vec::new();
    while !existing.exists() {
        match (existing.parent(), existing.file_name()) {
            (Some(parent), Some(name)) => {
                missing.push(name.to_owned());
                existing = parent;
            }
            _ => break,
        }
    }
    let mut resolved = existing
        .canonicalize()
        .unwrap_or_else(|_| existing.to_owned());
    for name in missing.iter().rev() {
        resolved.push(name);
    }
    resolved
}

/// Refuse a path inside the folders that hold the live stores and settings,
/// so a mistyped variable can never point the simulation at a store in use.
fn refuse_live(path: &Path, variable: &str) -> Result<(), String> {
    let Some(home) = env_path("HOME") else {
        return Ok(());
    };
    let path = resolve(path);
    for live in [
        ".local/share/opencode",
        ".local/share/cortexkit/magic-context",
        ".config",
    ] {
        let live = resolve(&home.join(live));
        if path.starts_with(&live) {
            return Err(format!(
                "{variable} {} is inside {}, which holds live stores or settings; give a copy elsewhere",
                path.display(),
                live.display()
            ));
        }
    }
    Ok(())
}

fn prepare_out(out: &Path) -> Result<(), String> {
    if out.exists() {
        let mut entries =
            std::fs::read_dir(out).map_err(|error| format!("{}: {error}", out.display()))?;
        if entries.next().is_some() {
            return Err(format!(
                "{} is not empty; write each simulation to a new folder",
                out.display()
            ));
        }
    }
    std::fs::create_dir_all(out).map_err(|error| format!("{}: {error}", out.display()))
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// Copy the store, with its write-ahead log when it has one, into the
/// output folder, and open the copy, which migrates it to this build's
/// schema. SQLite would write beside any store it opens, even read-only
/// (a shared-memory file for a store in WAL mode), so the store given is
/// only ever read as a file.
fn open_copy(store: &Path, out: &Path) -> Result<ContextDb, String> {
    if !store.is_file() {
        return Err(format!("{} is not a file", store.display()));
    }
    let copy = out.join(STORE);
    std::fs::copy(store, &copy).map_err(|error| format!("{}: {error}", store.display()))?;
    let wal = with_suffix(store, "-wal");
    if wal.is_file() {
        std::fs::copy(&wal, with_suffix(&copy, "-wal"))
            .map_err(|error| format!("{}: {error}", wal.display()))?;
    }
    ContextDb::open(&copy)
}

/// Today's two head budgets, in tokens.
#[derive(Clone, Copy, Debug)]
struct Budgets {
    /// The project memory block's.
    memory: u64,
    /// The user profile's.
    profile: u64,
}

/// What every project's simulation shares.
struct Context {
    counter: Counter,
    /// Each category id's decay class in the bundled coding profile.
    classes: HashMap<String, String>,
    now: i64,
    budgets: Budgets,
    /// The global memories today's user profile shows, in its order. The
    /// profile is the person's, the same in every project.
    profile_today: Vec<i64>,
    /// The active global memories the profile is trimmed from.
    profile_active: usize,
}

/// One memory row, as the simulation reads it.
#[derive(Clone, Debug)]
struct Row {
    id: i64,
    level: String,
    owner: String,
    /// The profile category id.
    category: String,
    /// The tag the memory was written under, which the head's project block
    /// groups by.
    tag: String,
    content: String,
    importance: Option<i64>,
    status: String,
    policy: bool,
    critical: bool,
    decay_class: Option<String>,
    last_seen_at: Option<i64>,
    verified_at: Option<i64>,
    expires_at: Option<i64>,
    overrides: Option<i64>,
    source_project: Option<String>,
}

impl Row {
    fn read(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            level: row.get(1)?,
            owner: row.get(2)?,
            category: row.get(3)?,
            tag: row.get(4)?,
            content: row.get(5)?,
            importance: row.get(6)?,
            status: row
                .get::<_, Option<String>>(7)?
                .unwrap_or_else(|| "active".into()),
            policy: row.get::<_, String>(8)? == "policy",
            critical: row.get::<_, Option<i64>>(9)? == Some(1),
            decay_class: row.get(10)?,
            last_seen_at: row.get(11)?,
            verified_at: row.get(12)?,
            expires_at: row.get(13)?,
            overrides: row.get(14)?,
            source_project: row.get(15)?,
        })
    }

    fn permanent(&self) -> bool {
        self.status == "permanent"
    }

    /// The last time the memory was genuinely met again: seen again by a
    /// summary or an agent's save, or confirmed by a verification.
    fn last_met(&self) -> Option<i64> {
        self.last_seen_at.into_iter().chain(self.verified_at).max()
    }

    fn level(&self) -> Option<Level> {
        match self.level.as_str() {
            "global" => Some(Level::Global),
            "workspace" => Some(Level::Workspace),
            "project" => Some(Level::Project),
            _ => None,
        }
    }

    /// The row as the head's line renderer takes it.
    fn stored(&self) -> StoredMemory {
        StoredMemory {
            id: self.id,
            project_path: self.owner.clone(),
            category: self.tag.clone(),
            content: self.content.clone(),
            importance: self.importance.map(|value| value as i32),
            status: self.status.clone(),
            expires_at: self.expires_at,
            last_seen_at: self.last_seen_at,
            verified_at: self.verified_at,
            ..StoredMemory::default()
        }
    }
}

fn rows_where(
    conn: &Connection,
    condition: &str,
    binds: &[&dyn rusqlite::ToSql],
) -> rusqlite::Result<Vec<Row>> {
    conn.prepare(&format!(
        "SELECT {ROW_COLUMNS} FROM memories WHERE {condition} ORDER BY id"
    ))?
    .query_map(binds, Row::read)?
    .collect()
}

/// Where a candidate's decay class came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum DecaySource {
    /// The row's own `decay_class`.
    Row,
    /// Its category's class in the bundled coding profile.
    Category,
    /// Neither: a category the profile doesn't declare.
    Unknown,
}

impl DecaySource {
    fn name(self) -> &'static str {
        match self {
            Self::Row => "row",
            Self::Category => "category",
            Self::Unknown => "unknown",
        }
    }
}

/// A candidate's decay class, as named, and where it came from.
#[derive(Clone, Debug)]
struct DecayClass {
    class: Option<String>,
    source: DecaySource,
}

impl DecayClass {
    fn of(row: &Row, classes: &HashMap<String, String>) -> Self {
        if let Some(class) = row.decay_class.as_deref().filter(|class| !class.is_empty()) {
            return Self {
                class: Some(class.to_owned()),
                source: DecaySource::Row,
            };
        }
        match classes.get(&row.category) {
            Some(class) => Self {
                class: Some(class.clone()),
                source: DecaySource::Category,
            },
            None => Self {
                class: None,
                source: DecaySource::Unknown,
            },
        }
    }

    /// An unknown class keeps full weight, as the function treats a class
    /// it doesn't know.
    fn decay(&self) -> Decay {
        Decay::named(self.class.as_deref().unwrap_or_default())
    }
}

/// Each category id's decay class in the bundled coding profile.
fn decay_classes() -> Result<HashMap<String, String>, String> {
    let profile = prompt_profile(None).map_err(|error| format!("{error:?}"))?;
    Ok(profile.body["categories"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|category| {
            Some((
                category["id"].as_str()?.to_owned(),
                category["decay_class"].as_str()?.to_owned(),
            ))
        })
        .collect())
}

/// The block a level's memories are shown in.
fn wrapper(level: Level) -> &'static str {
    match level {
        Level::Global => "user-profile",
        Level::Workspace => "workspace-memory",
        Level::Project => "project-memory",
        Level::Agent => "agent-memory",
    }
}

/// The head's escaping of text inside a block.
fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// A memory's line in a project or workspace block: `#id: fact`, or, for a
/// memory from a sibling project, `#id [sibling]: fact`, as the head's
/// workspace lines show it.
fn memory_line(row: &Row, label: Option<&str>) -> String {
    match label {
        Some(name) => format!("#{} [{}]: {}", row.id, escape(name), escape(&row.content)),
        None => memory::render_line(&row.stored()),
    }
}

/// What showing a row costs at `level`, counted as the head counts it today:
/// `trim_to_budget`'s line, category tags and wrapper for a memory block,
/// `trim_profile`'s line cost for the user profile (a bullet and four
/// tokens for its share of the block's newlines). The profile has no
/// category tags; its wrapper is charged like any block's, which today's
/// profile trim leaves out.
fn priced(row: &Row, level: Level, label: Option<&str>, counter: Counter) -> Candidate {
    let (line_tokens, category_tokens) = match level {
        Level::Global => (counter.count(&format!("- {}", row.content)) + 4, 0),
        _ => (
            counter.count(&(memory_line(row, label) + "\n")),
            counter.count(&format!("<{0}>\n</{0}>\n", row.tag)),
        ),
    };
    let block = wrapper(level);
    Candidate {
        id: row.id,
        level,
        source_project: if level == Level::Workspace {
            row.source_project.clone()
        } else {
            None
        },
        category: row.tag.clone(),
        importance: row.importance,
        permanent: row.permanent(),
        policy: row.policy,
        safety_critical: row.critical,
        decay: Decay::Stable,
        last_met_ms: row.last_met(),
        expires_at_ms: row.expires_at,
        // The store keeps no resolution (see `FIELDS_WITHOUT_SOURCE`).
        resolved: false,
        overrides: row.overrides,
        line_tokens,
        category_tokens,
        block_tokens: counter.count(&format!("<{block}>\n</{block}>")),
    }
}

/// The global memories today's user profile shows, by id, in its order:
/// the active global memories the head reads, trimmed by the head's own
/// profile trim at today's budget. Also how many it was trimmed from.
fn profile_today(
    db: &ContextDb,
    budget: u64,
    counter: Counter,
) -> Result<(Vec<i64>, usize), String> {
    // The head reads the profile's text only; this reads the same rows in
    // the same order with their ids, and checks the text is the head's.
    let rows: Vec<(i64, String)> = db
        .with_connection(|conn| {
            conn.prepare(
                "SELECT id, content FROM memories WHERE level = 'global' AND status = 'active'
                  ORDER BY COALESCE(json_extract(metadata_json, '$.promoted_at'), created_at) ASC,
                           COALESCE(json_extract(metadata_json, '$.user_memory_id'), id) ASC",
            )?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<_>>()
        })
        .map_err(|error| format!("reading the user profile: {error}"))?;
    let (profile, _) = db.user_profile()?;
    if rows.iter().map(|(_, content)| content).ne(profile.iter()) {
        return Err("the user profile reads differently here than the head reads it".into());
    }
    let active = profile.len();
    let mut kept = memory::trim_profile(profile, budget, counter)
        .into_iter()
        .peekable();
    // The trim keeps lines in their order, so walking both in step names
    // each kept line's row. Of two equal lines the trim can't drop the first
    // and keep the second: they cost the same and the budget left only
    // shrinks.
    let ids = rows
        .into_iter()
        .filter_map(|(id, content)| {
            (kept.peek() == Some(&content)).then(|| {
                kept.next();
                id
            })
        })
        .collect();
    if kept.next().is_some() {
        return Err("a profile line the head keeps matches no global memory".into());
    }
    Ok((ids, active))
}

/// Every project with live project memories.
fn project_owners(db: &ContextDb, now: i64) -> Result<Vec<String>, String> {
    db.with_connection(|conn| {
        conn.prepare(&format!(
            "SELECT DISTINCT owner_id FROM memories WHERE level = 'project' AND {LIVE}
              ORDER BY owner_id"
        ))?
        .query_map([now], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()
    })
    .map_err(|error| format!("listing projects: {error}"))
}

/// The workspaces `project` belongs to, as the owner ids of their memories.
fn workspace_ids(conn: &Connection, project: &str) -> rusqlite::Result<Vec<String>> {
    let members: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspace_members')",
        [],
        |row| row.get(0),
    )?;
    if !members {
        return Ok(Vec::new());
    }
    conn.prepare(
        "SELECT CAST(workspace_id AS TEXT) FROM workspace_members WHERE project_path = ?1",
    )?
    .query_map([project], |row| row.get(0))?
    .collect()
}

/// One project's head: what it shows today and the candidates the new
/// selection chooses from.
struct Project {
    owner: String,
    /// The project's name in its workspace, when it is in one.
    name: Option<String>,
    workspaced: bool,
    candidates: Vec<Candidate>,
    /// Every row the report may name: the candidates and today's rows.
    rows: HashMap<i64, Row>,
    /// What each of those rows costs in the block it is shown in.
    priced: HashMap<i64, Candidate>,
    /// Rows today's head shows that are not candidates, with why.
    not_candidates: HashMap<i64, String>,
    decay: HashMap<i64, DecayClass>,
    /// Candidates the function hides whatever the budget, with why.
    hidden: HashMap<i64, String>,
    /// Today's user profile lines, then today's project block, by id.
    today: Vec<i64>,
    today_profile: usize,
    /// The project memories today's head reads, before its trim.
    today_readable: usize,
}

fn build_project(db: &ContextDb, owner: &str, context: &Context) -> Result<Project, String> {
    let (now, counter) = (context.now, context.counter);
    db.with_connection(|conn| {
        // Today's project block, read and trimmed as the head's fold does it.
        // The fold always has a workspace (one member when the project is in
        // none), and that trim falls back to `trim_to_budget` for a project
        // with no siblings.
        let workspace = Workspace::resolve(conn, owner)?;
        let readable = workspace.memories(conn, now)?;
        let today_readable = readable.len();
        let today_block: Vec<i64> =
            memory::trim_workspace_to_budget(readable, context.budgets.memory, &workspace, counter)
                .iter()
                .map(|memory| memory.id)
                .collect();

        let workspaces =
            serde_json::to_string(&workspace_ids(conn, owner)?).expect("a list of ids serializes");
        let candidate_rows = rows_where(
            conn,
            &format!(
                "{LIVE} AND ((level = 'project' AND owner_id = ?2)
                    OR (level = 'global' AND owner_id = 'self')
                    OR (level = 'workspace' AND owner_id IN (SELECT value FROM json_each(?3))))"
            ),
            &[&now, &owner, &workspaces],
        )?;
        let mut project = Project {
            owner: owner.to_owned(),
            name: workspace.names.get(owner).cloned(),
            workspaced: workspace.is_workspaced(),
            candidates: Vec::new(),
            rows: HashMap::new(),
            priced: HashMap::new(),
            not_candidates: HashMap::new(),
            decay: HashMap::new(),
            hidden: HashMap::new(),
            today: context
                .profile_today
                .iter()
                .chain(&today_block)
                .copied()
                .collect(),
            today_profile: context.profile_today.len(),
            today_readable,
        };
        for row in candidate_rows {
            let Some(level) = row.level() else { continue };
            let label = row
                .source_project
                .as_deref()
                .filter(|_| level == Level::Workspace)
                .and_then(|source| workspace.source_name(source));
            let decay = DecayClass::of(&row, &context.classes);
            let candidate = Candidate {
                decay: decay.decay(),
                ..priced(&row, level, label, counter)
            };
            project.decay.insert(row.id, decay);
            project.priced.insert(row.id, candidate.clone());
            project.candidates.push(candidate);
            project.rows.insert(row.id, row);
        }

        // Rows today's head shows that the new one doesn't read: a sibling
        // project's memories, which today's head shows in the project block
        // when the project is in a workspace.
        let others: Vec<i64> = project
            .today
            .iter()
            .copied()
            .filter(|id| !project.rows.contains_key(id))
            .collect();
        let ids = serde_json::to_string(&others).expect("a list of ids serializes");
        for row in rows_where(conn, "id IN (SELECT value FROM json_each(?1))", &[&ids])? {
            let (level, label, why) = match row.level.as_str() {
                "global" => (
                    Level::Global,
                    None,
                    format!("a global memory owned by {:?}, not `self`", row.owner),
                ),
                _ if row.owner != owner => (
                    Level::Project,
                    workspace.source_name(&row.owner),
                    format!(
                        "a sibling project's memory ({}), shown through today's workspace",
                        workspace
                            .names
                            .get(&row.owner)
                            .map_or(row.owner.as_str(), String::as_str)
                    ),
                ),
                _ => (
                    Level::Project,
                    None,
                    "not among the rows the new head reads".to_owned(),
                ),
            };
            project
                .priced
                .insert(row.id, priced(&row, level, label, counter));
            project.not_candidates.insert(row.id, why);
            project.rows.insert(row.id, row);
        }
        project.hidden = hidden(&project.candidates, now);
        Ok::<_, rusqlite::Error>(project)
    })
    .map_err(|error| format!("project {owner}: {error}"))
}

/// The candidates the function hides at `now` whatever the budget, with
/// why: a bounded memory past its end, a resolved one, and one another
/// visible memory overrides. The same rules as the function's own.
fn hidden(candidates: &[Candidate], now: i64) -> HashMap<i64, String> {
    let mut hidden = HashMap::new();
    for candidate in candidates {
        match candidate.decay {
            Decay::Bounded if candidate.expires_at_ms.is_some_and(|end| now >= end) => {
                hidden.insert(candidate.id, "its validity has ended".to_owned());
            }
            Decay::OpenUntilResolved if candidate.resolved => {
                hidden.insert(candidate.id, "resolved".to_owned());
            }
            _ => {}
        }
    }
    let live: HashSet<i64> = candidates
        .iter()
        .map(|candidate| candidate.id)
        .filter(|id| !hidden.contains_key(id))
        .collect();
    for candidate in candidates.iter().filter(|c| live.contains(&c.id)) {
        if let Some(target) = candidate.overrides.filter(|target| live.contains(target)) {
            hidden
                .entry(target)
                .or_insert_with(|| format!("overridden by #{}", candidate.id));
        }
    }
    hidden
}

/// What a level's shown memories use.
#[derive(Clone, Copy, Debug, Default)]
struct Usage {
    shown: usize,
    /// The memories' own lines.
    line_tokens: u64,
    /// The lines with their category tags and the level's block wrapper.
    tokens: u64,
}

/// What `shown` uses at each level, each category's tags and each block's
/// wrapper paid once, as the function pays them.
fn usage(priced: &HashMap<i64, Candidate>, shown: &[i64]) -> BTreeMap<Level, Usage> {
    let mut usage: BTreeMap<Level, Usage> = BTreeMap::new();
    let mut categories = HashSet::new();
    for id in shown {
        let candidate = &priced[id];
        let level = usage.entry(candidate.level).or_default();
        if level.shown == 0 {
            level.tokens += candidate.block_tokens;
        }
        if categories.insert((candidate.level, candidate.category.as_str())) {
            level.tokens += candidate.category_tokens;
        }
        level.shown += 1;
        level.line_tokens += candidate.line_tokens;
        level.tokens += candidate.line_tokens;
    }
    usage
}

impl Project {
    /// Safety-critical or permanent candidates not in `shown`, leaving out
    /// those the function hides by design.
    fn missing(&self, shown: &HashSet<i64>) -> Vec<i64> {
        self.candidates
            .iter()
            .filter(|c| {
                (c.safety_critical || c.permanent)
                    && !self.hidden.contains_key(&c.id)
                    && !shown.contains(&c.id)
            })
            .map(|c| c.id)
            .collect()
    }

    fn today_usage(&self) -> BTreeMap<Level, Usage> {
        usage(&self.priced, &self.today)
    }

    fn candidates_at(&self, level: Level) -> usize {
        self.candidates.iter().filter(|c| c.level == level).count()
    }

    /// Why a memory today's head shows is not in a new selection.
    fn why_left(&self, id: i64) -> &str {
        self.not_candidates
            .get(&id)
            .or_else(|| self.hidden.get(&id))
            .map_or("not chosen within the budget", String::as_str)
    }

    fn label(&self) -> String {
        match &self.name {
            Some(name) => format!("{name} (`{}`)", self.owner),
            None => format!("`{}`", self.owner),
        }
    }
}

/// One project's head under one parameter set.
struct Run<'a> {
    params: &'a Params,
    selection: Selection,
    /// Shown today, not now, in today's order.
    left: Vec<i64>,
    /// Shown now, not today, in rank order.
    arrived: Vec<i64>,
    /// Safety-critical or permanent memories not shown.
    missing: Vec<i64>,
    usage: BTreeMap<Level, Usage>,
}

fn run_params<'a>(project: &Project, params: &'a Params, total: u64, now: i64) -> Run<'a> {
    let selection = select(&project.candidates, &params.budget(total), now);
    let shown: HashSet<i64> = selection.ids.iter().copied().collect();
    let today: HashSet<i64> = project.today.iter().copied().collect();
    let usage = usage(&project.priced, &selection.ids);
    // The report's costs must be the ones the function admitted by.
    assert_eq!(
        usage.values().map(|level| level.tokens).sum::<u64>(),
        selection.tokens,
        "project {}: the levels' tokens don't add up to the selection's",
        project.owner
    );
    let lines = level_tokens(&project.candidates, &selection);
    for (level, used) in &usage {
        assert_eq!(
            lines.get(level).copied().unwrap_or_default(),
            used.line_tokens,
            "project {}: {level:?} line tokens differ from the function's count",
            project.owner
        );
    }
    Run {
        params,
        left: project
            .today
            .iter()
            .copied()
            .filter(|id| !shown.contains(id))
            .collect(),
        arrived: selection
            .ids
            .iter()
            .copied()
            .filter(|id| !today.contains(id))
            .collect(),
        missing: project.missing(&shown),
        usage,
        selection,
    }
}

fn level_name(level: Level) -> &'static str {
    match level {
        Level::Global => "global",
        Level::Workspace => "workspace",
        Level::Project => "project",
        Level::Agent => "agent",
    }
}

/// The start of `text`, for naming a memory in the report.
fn excerpt(text: &str) -> String {
    let mut short: String = text.chars().take(EXCERPT_CHARS).collect();
    if text.chars().count() > EXCERPT_CHARS {
        short.push('…');
    }
    short
}

/// A markdown table cell holding `text` on one line.
fn cell(text: &str) -> String {
    text.replace(['\r', '\n'], " ").replace('|', "\\|")
}

fn yes(flag: bool) -> &'static str {
    if flag {
        "yes"
    } else {
        "no"
    }
}

/// `used / minimum` for a summary cell.
fn against(used: Option<&Usage>, minimum: u64) -> String {
    format!("{} / {minimum}", used.map_or(0, |used| used.tokens))
}

/// Everything the report and the results are written from.
struct Simulation<'a> {
    inputs: &'a Inputs,
    context: &'a Context,
    total: u64,
    projects: &'a [Project],
    /// Each project's runs, in grid order.
    runs: &'a [Vec<Run<'a>>],
}

impl Simulation<'_> {
    fn counter_name(&self) -> String {
        match (self.inputs.model.as_deref(), self.context.counter.family()) {
            (Some(model), Some(family)) => format!("{model}, in its own vocabulary ({family:?})"),
            (Some(model), None) => {
                format!("{model}, with the module's estimate (no vocabulary for this model)")
            }
            (None, _) => "the module's estimate (MEMORY_SIM_MODEL unset)".to_owned(),
        }
    }

    /// Every project's run of the parameter set at `at`, with its project.
    fn runs_at(&self, at: usize) -> Vec<(&Project, &Run<'_>)> {
        self.projects
            .iter()
            .zip(self.runs)
            .map(|(project, runs)| (project, &runs[at]))
            .collect()
    }

    fn results(&self) -> Value {
        json!({
            "store": {
                "source": self.inputs.store.display().to_string(),
                "copy": STORE,
                "schema": SCHEMA_VERSION,
            },
            "nowMs": self.context.now,
            "model": self.inputs.model,
            "counter": self.counter_name(),
            "budgets": {
                "memory": self.context.budgets.memory,
                "profile": self.context.budgets.profile,
                "total": self.total,
                "combination": COMBINATION,
            },
            "fieldsWithoutSource": FIELDS_WITHOUT_SOURCE
                .iter()
                .map(|(field, why)| json!({"field": field, "why": why}))
                .collect::<Vec<_>>(),
            "grid": self.inputs.grid,
            "todayProfile": {
                "ids": self.context.profile_today,
                "activeGlobal": self.context.profile_active,
            },
            "projects": self
                .projects
                .iter()
                .zip(self.runs)
                .map(|(project, runs)| self.project_results(project, runs))
                .collect::<Vec<_>>(),
            "summary": self
                .inputs
                .grid
                .iter()
                .enumerate()
                .map(|(at, params)| {
                    json!({
                        "params": params.name,
                        "projects": self
                            .runs_at(at)
                            .into_iter()
                            .map(|(project, run)| json!({
                                "owner": project.owner,
                                "name": project.name,
                                "todayShown": project.today.len(),
                                "newShown": run.selection.ids.len(),
                                "left": run.left.len(),
                                "arrived": run.arrived.len(),
                                "criticalOrPermanentNotShown": run.missing.len(),
                                "tokens": run.selection.tokens,
                                "levels": levels_json(&run.usage, Some(run.params)),
                            }))
                            .collect::<Vec<_>>(),
                    })
                })
                .collect::<Vec<_>>(),
        })
    }

    fn project_results(&self, project: &Project, runs: &[Run<'_>]) -> Value {
        let mut decay_sources: BTreeMap<&str, usize> = BTreeMap::new();
        for decay in project.decay.values() {
            *decay_sources.entry(decay.source.name()).or_default() += 1;
        }
        let today: HashSet<i64> = project.today.iter().copied().collect();
        let memories = |ids: &[i64], why: bool| {
            ids.iter()
                .map(|id| memory_json(project, *id, why.then(|| project.why_left(*id))))
                .collect::<Vec<_>>()
        };
        json!({
            "owner": project.owner,
            "name": project.name,
            "workspaced": project.workspaced,
            "candidates": LEVELS
                .iter()
                .map(|level| (level_name(*level).to_owned(), json!(project.candidates_at(*level))))
                .collect::<serde_json::Map<_, _>>(),
            "decaySources": decay_sources,
            "hidden": project
                .hidden
                .iter()
                .map(|(id, why)| json!({"id": id, "why": why}))
                .collect::<Vec<_>>(),
            "today": {
                "ids": project.today,
                "profile": project.today_profile,
                "projectBlock": project.today.len() - project.today_profile,
                "projectReadable": project.today_readable,
                "levels": levels_json(&project.today_usage(), None),
                "criticalOrPermanentNotShown": memories(&project.missing(&today), false),
            },
            "runs": runs
                .iter()
                .map(|run| json!({
                    "params": run.params.name,
                    "ids": run.selection.ids,
                    "tokens": run.selection.tokens,
                    "total": self.total,
                    "levels": levels_json(&run.usage, Some(run.params)),
                    "criticalOrPermanentNotShown": memories(&run.missing, false),
                    "left": memories(&run.left, true),
                    "arrived": memories(&run.arrived, false),
                }))
                .collect::<Vec<_>>(),
        })
    }
}

fn levels_json(usage: &BTreeMap<Level, Usage>, params: Option<&Params>) -> Value {
    LEVELS
        .iter()
        .map(|level| {
            let used = usage.get(level).copied().unwrap_or_default();
            (
                level_name(*level).to_owned(),
                json!({
                    "shown": used.shown,
                    "tokens": used.tokens,
                    "lineTokens": used.line_tokens,
                    "minimum": params.map(|params| params.minimum(*level)),
                }),
            )
        })
        .collect::<serde_json::Map<_, _>>()
        .into()
}

/// The level a memory is shown at; a sibling project's memory, which only
/// today's head shows, is marked as one.
fn shown_level(project: &Project, id: i64) -> String {
    let level = project.priced[&id].level;
    if level == Level::Project && project.rows[&id].owner != project.owner {
        return "project (sibling)".to_owned();
    }
    level_name(level).to_owned()
}

fn memory_json(project: &Project, id: i64, why: Option<&str>) -> Value {
    let row = &project.rows[&id];
    json!({
        "id": id,
        "level": shown_level(project, id),
        "category": row.category,
        "tag": row.tag,
        "importance": row.importance,
        "permanent": row.permanent(),
        "critical": row.critical,
        "policy": row.policy,
        "decay": project.decay.get(&id).and_then(|decay| decay.class.clone()),
        "lineTokens": project.priced[&id].line_tokens,
        "text": excerpt(&row.content),
        "why": why,
    })
}

const MEMORY_HEADER: &str =
    "| id | level | category | importance | permanent | critical | decay | text |";
const MEMORY_RULE: &str = "|---|---|---|---|---|---|---|---|";

/// A memory's row in the report's memory tables, `why` as an extra cell.
fn memory_cells(project: &Project, id: i64, why: Option<&str>) -> String {
    let row = &project.rows[&id];
    let mut cells = format!(
        "| #{id} | {} | {} | {} | {} | {} | {} | {} |",
        shown_level(project, id),
        cell(&row.category),
        row.importance
            .map_or_else(|| "∅".to_owned(), |value| value.to_string()),
        yes(row.permanent()),
        yes(row.critical),
        project
            .decay
            .get(&id)
            .and_then(|decay| decay.class.as_deref())
            .unwrap_or("–"),
        cell(&excerpt(&row.content)),
    );
    if let Some(why) = why {
        cells.push_str(&format!(" {} |", cell(why)));
    }
    cells
}

impl Simulation<'_> {
    fn report(&self) -> String {
        let budgets = self.context.budgets;
        let mut lines = vec![
            "# Memory rendering simulation".to_owned(),
            String::new(),
            format!(
                "- Store: `{}`, copied to `{STORE}` in this folder and opened at schema {SCHEMA_VERSION}.",
                self.inputs.store.display()
            ),
            format!("- Heads rendered at {} ms since the epoch.", self.context.now),
            format!("- Token counter: {}.", self.counter_name()),
            format!(
                "- Today's budgets: {} tokens for the project memory block (the default of `memory.injection_budget_tokens`), {} for the user profile.",
                budgets.memory, budgets.profile
            ),
            format!(
                "- The new selection fills {} tokens: {COMBINATION}.",
                self.total
            ),
            format!(
                "- Today's user profile shows {} of the {} active global memories, the same in every project.",
                self.context.profile_today.len(),
                self.context.profile_active
            ),
            String::new(),
            "## Parameter sets".to_owned(),
            String::new(),
            "| name | half-life (days) | protected slice | global minimum | workspace minimum | project minimum |".to_owned(),
            "|---|---|---|---|---|---|".to_owned(),
        ];
        for params in &self.inputs.grid {
            lines.push(format!(
                "| `{}` | {} | {} | {} | {} | {} |",
                cell(&params.name),
                params.half_life_days,
                params.protected_tokens,
                params.minimum.global,
                params.minimum.workspace,
                params.minimum.project
            ));
        }
        lines.extend(
            [
                "",
                "## How the candidates are built",
                "",
                "- Rows: the project's own live project memories, the live global memories (owner `self`), and the live workspace memories of the project's workspace. Live means active or permanent and not past `expires_at`, the condition today's head reads with. A sibling project's memory that today's head shows through a workspace is not a candidate; it is listed as leaving, with why.",
                "- Costs, in the counter above: a project or workspace memory's line is `memory::render_line` and a newline (a workspace memory from a sibling project carries that project's name, as today's workspace lines do); its category tags are `<TAG>` and `</TAG>` for the tag it was written under, which today's project block groups by; each level's block wrapper (`<project-memory>`, `<workspace-memory>`, `<user-profile>`) is paid once. A global memory's line costs what `memory::trim_profile` charges for it (`- text`, plus 4), with no category tags; its wrapper is charged, which today's profile trim leaves out.",
                "- Decay: the row's `decay_class`, else its category's in the bundled coding profile. A category the profile doesn't declare (the global memories' `mc:user-unsorted`, `mc:unmapped`) keeps full weight.",
                "- Last met: the later of `last_seen_at` and `verified_at`. Permanent: `status = 'permanent'`. Policy: `authority = 'policy'`. Critical: `safety_critical = 1`. Importance as stored (unset counts as 50). Overrides: `overrides_memory_id`. End of validity: `expires_at`.",
                "- Not applied: visibility by profile or agent (every candidate counts as visible) and agent memories.",
                "- *Critical or permanent not shown* counts candidates the function could show; one an override hides, or past its validity, is listed under its project as hidden instead.",
                "- Tokens per level are the level's lines, category tags and wrapper; *lines* is the lines alone (`memory_render::level_tokens`).",
            ]
            .map(str::to_owned),
        );
        for (field, why) in FIELDS_WITHOUT_SOURCE {
            lines.push(format!(
                "- Left out of the choice, as the store has no source for it: `{field}`: {why}."
            ));
        }

        lines.extend(["", "## Critical or permanent memories not shown", ""].map(str::to_owned));
        let mut missing = Vec::new();
        for (at, params) in self.inputs.grid.iter().enumerate() {
            for (project, run) in self.runs_at(at) {
                for id in &run.missing {
                    missing.push(format!(
                        "| {} | `{}` {}",
                        project.label(),
                        cell(&params.name),
                        memory_cells(project, *id, None)
                    ));
                }
            }
        }
        if missing.is_empty() {
            lines.push("None, under any parameter set.".to_owned());
        } else {
            lines.push(format!(
                "{} under the parameter sets below; each should be 0.",
                missing.len()
            ));
            lines.push(String::new());
            lines.push(format!("| project | parameter set {MEMORY_HEADER}"));
            lines.push(format!("|---|---{MEMORY_RULE}"));
            lines.extend(missing);
        }

        lines.extend(["", "## Summary"].map(str::to_owned));
        for (at, params) in self.inputs.grid.iter().enumerate() {
            lines.extend([
                String::new(),
                format!("### `{}`", cell(&params.name)),
                String::new(),
                "| project | candidates (global / workspace / project) | shown today | shown now (global / workspace / project) | left | arrived | critical or permanent not shown | tokens / total | global / minimum | workspace / minimum | project / minimum |".to_owned(),
                "|---|---|---|---|---|---|---|---|---|---|---|".to_owned(),
            ]);
            for (project, run) in self.runs_at(at) {
                let shown = |level: Level| run.usage.get(&level).map_or(0, |used| used.shown);
                lines.push(format!(
                    "| {} | {} / {} / {} | {} | {} / {} / {} | {} | {} | {} | {} / {} | {} | {} | {} |",
                    project.label(),
                    project.candidates_at(Level::Global),
                    project.candidates_at(Level::Workspace),
                    project.candidates_at(Level::Project),
                    project.today.len(),
                    shown(Level::Global),
                    shown(Level::Workspace),
                    shown(Level::Project),
                    run.left.len(),
                    run.arrived.len(),
                    run.missing.len(),
                    run.selection.tokens,
                    self.total,
                    against(run.usage.get(&Level::Global), params.minimum.global),
                    against(run.usage.get(&Level::Workspace), params.minimum.workspace),
                    against(run.usage.get(&Level::Project), params.minimum.project),
                ));
            }
        }

        lines.extend(["", "## Projects"].map(str::to_owned));
        for (project, runs) in self.projects.iter().zip(self.runs) {
            self.project_report(&mut lines, project, runs);
        }
        lines.join("\n") + "\n"
    }

    fn project_report(&self, lines: &mut Vec<String>, project: &Project, runs: &[Run<'_>]) {
        let mut sources: BTreeMap<DecaySource, usize> = BTreeMap::new();
        for decay in project.decay.values() {
            *sources.entry(decay.source).or_default() += 1;
        }
        let today: HashSet<i64> = project.today.iter().copied().collect();
        let today_missing = project.missing(&today);
        let today_usage = project.today_usage();
        lines.extend([
            String::new(),
            format!("### {}", project.label()),
            String::new(),
            format!(
                "- Candidates: {} global, {} workspace, {} project. In a workspace with siblings: {}.",
                project.candidates_at(Level::Global),
                project.candidates_at(Level::Workspace),
                project.candidates_at(Level::Project),
                yes(project.workspaced)
            ),
            format!(
                "- Decay class from the row: {}; from the category: {}; unknown, full weight: {}.",
                sources.get(&DecaySource::Row).copied().unwrap_or_default(),
                sources.get(&DecaySource::Category).copied().unwrap_or_default(),
                sources.get(&DecaySource::Unknown).copied().unwrap_or_default()
            ),
            format!(
                "- Today: {} shown, {} user profile lines and {} of the {} project memories the head reads; {} critical or permanent candidates not shown.",
                project.today.len(),
                project.today_profile,
                project.today.len() - project.today_profile,
                project.today_readable,
                today_missing.len()
            ),
        ]);
        let mut hidden: Vec<(&i64, &String)> = project.hidden.iter().collect();
        hidden.sort();
        for (id, why) in hidden {
            lines.push(format!(
                "- Hidden whatever the budget: #{id}, {}.",
                cell(why)
            ));
        }
        if !today_missing.is_empty() {
            lines.extend([
                String::new(),
                "Critical or permanent candidates today's head doesn't show:".to_owned(),
                String::new(),
                MEMORY_HEADER.to_owned(),
                MEMORY_RULE.to_owned(),
            ]);
            lines.extend(
                today_missing
                    .iter()
                    .map(|id| memory_cells(project, *id, None)),
            );
        }
        for run in runs {
            let params = run.params;
            lines.extend([
                String::new(),
                format!("#### {} under `{}`", project.label(), cell(&params.name)),
                String::new(),
                format!(
                    "**Critical or permanent memories not shown: {}**",
                    run.missing.len()
                ),
            ]);
            if !run.missing.is_empty() {
                lines.extend([
                    String::new(),
                    MEMORY_HEADER.to_owned(),
                    MEMORY_RULE.to_owned(),
                ]);
                lines.extend(
                    run.missing
                        .iter()
                        .map(|id| memory_cells(project, *id, None)),
                );
            }
            lines.extend([
                String::new(),
                format!(
                    "Shown: {} today, {} now ({} left, {} arrived). Tokens: {} of {}.",
                    project.today.len(),
                    run.selection.ids.len(),
                    run.left.len(),
                    run.arrived.len(),
                    run.selection.tokens,
                    self.total
                ),
                String::new(),
                "| level | shown today | tokens today | shown now | tokens now | lines now | minimum |"
                    .to_owned(),
                "|---|---|---|---|---|---|---|".to_owned(),
            ]);
            for level in LEVELS {
                let before = today_usage.get(&level).copied().unwrap_or_default();
                let after = run.usage.get(&level).copied().unwrap_or_default();
                lines.push(format!(
                    "| {} | {} | {} | {} | {} | {} | {} |",
                    level_name(level),
                    before.shown,
                    before.tokens,
                    after.shown,
                    after.tokens,
                    after.line_tokens,
                    params.minimum(level)
                ));
            }
            lines.extend([
                String::new(),
                format!("Left ({}):", run.left.len()),
                String::new(),
            ]);
            if !run.left.is_empty() {
                lines.push(format!("{MEMORY_HEADER} why |"));
                lines.push(format!("{MEMORY_RULE}---|"));
                lines.extend(
                    run.left
                        .iter()
                        .map(|id| memory_cells(project, *id, Some(project.why_left(*id)))),
                );
                lines.push(String::new());
            }
            lines.extend([format!("Arrived ({}):", run.arrived.len())]);
            if !run.arrived.is_empty() {
                lines.extend([
                    String::new(),
                    MEMORY_HEADER.to_owned(),
                    MEMORY_RULE.to_owned(),
                ]);
                lines.extend(
                    run.arrived
                        .iter()
                        .map(|id| memory_cells(project, *id, None)),
                );
            }
        }
    }
}

// The harness's own tests, on synthetic stores built through the module's
// writers and migrations. They never read a real store.

/// A new scratch folder for one test.
fn scratch(name: &str) -> PathBuf {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!(
        "ck-mc-render-sim-{name}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create the scratch folder");
    dir
}

/// A store at the plugin's last schema holding `profile` as the person's
/// user memories, opened by the module, which migrates it: the user
/// memories become global memories owned by `self`, as in a real store.
fn synthetic_store(path: &Path, profile: &[String]) -> ContextDb {
    let conn = Connection::open(path).expect("create the store");
    conn.execute_batch(&FRESH_SCHEMA.replace(":applied_at", "0"))
        .expect("the plugin's schema");
    for (at, content) in profile.iter().enumerate() {
        conn.execute(
            "INSERT INTO user_memories (content, status, promoted_at, created_at, updated_at)
             VALUES (?1, 'active', ?2, ?2, ?2)",
            params![content, 1_000 + at as i64],
        )
        .expect("a user memory");
    }
    drop(conn);
    ContextDb::open(path).expect("the module opens and migrates the store")
}

/// Save a project memory as an agent saves one through `ctx_memory`.
fn save(db: &ContextDb, project: &str, tag: &str, content: &str) -> i64 {
    let writer = Writer {
        harness: "opencode",
        session: "ses-render-sim",
        project,
        authority: None,
    };
    db.with_connection(|conn| memory_writes::save(conn, &writer, tag, content))
        .expect("save a memory")
        .memory_id
        .expect("the saved memory's id")
}

/// Set a memory's importance and safety-critical mark, as the dreamer's
/// classify-memories task (the background job that scores memories) writes
/// them.
fn classify(db: &ContextDb, id: i64, importance: i64, critical: bool) {
    db.with_connection(|conn| {
        conn.execute(
            "UPDATE memories SET importance = ?2, safety_critical = ?3 WHERE id = ?1",
            params![id, importance, critical],
        )
    })
    .expect("classify a memory");
}

fn sql(db: &ContextDb, statements: &str) {
    db.with_connection(|conn| conn.execute_batch(statements))
        .expect("update the synthetic store");
}

/// About a hundred tokens of text after `lead`, different for each lead.
fn long_text(lead: &str) -> String {
    format!(
        "{lead}: {}",
        "keep the cached prefix byte identical between passes and fold only on a rebuild; "
            .repeat(5)
    )
}

fn grid() -> Vec<Params> {
    vec![
        Params {
            name: "short".into(),
            half_life_days: 14.0,
            protected_tokens: 500,
            minimum: Minimum {
                global: 200,
                workspace: 300,
                project: 1000,
            },
        },
        Params {
            name: "long".into(),
            half_life_days: 90.0,
            protected_tokens: 0,
            minimum: Minimum {
                global: 0,
                workspace: 0,
                project: 0,
            },
        },
    ]
}

fn ids(value: &Value) -> Vec<i64> {
    value
        .as_array()
        .expect("a list")
        .iter()
        .map(|entry| entry["id"].as_i64().or(entry.as_i64()).expect("an id"))
        .collect()
}

#[test]
fn the_harness_runs_end_to_end_and_writes_only_its_output_folder() {
    let dir = scratch("end-to-end");
    let store = dir.join("context.db");
    let db = synthetic_store(
        &store,
        &["Prefers short answers".into(), "Works in Rust".into()],
    );
    let alpha = [
        save(&db, "pj-alpha", "CONSTRAINTS", "Never push to main"),
        save(
            &db,
            "pj-alpha",
            "ARCHITECTURE",
            "One pure function picks the head's memories",
        ),
        save(&db, "pj-alpha", "NAMING", "Workers are called masons"),
    ];
    let beta = save(
        &db,
        "pj-beta",
        "CONSTRAINTS",
        "Run builds on the build server",
    );
    // Today's head shows this one in pj-alpha too: pj-beta shares its
    // constraints with the workspace.
    let shared_today = save(
        &db,
        "pj-beta",
        "CONSTRAINTS",
        "Never commit generated archives",
    );
    // A workspace memory, which only the new head reads.
    let workspace_memory = save(
        &db,
        "pj-beta",
        "CONSTRAINTS",
        "Commit messages close no issues",
    );
    sql(
        &db,
        &format!(
            "UPDATE memories SET status = 'permanent' WHERE id = {permanent};
             UPDATE memories SET shareable = 1 WHERE id = {shared_today};
             UPDATE memories SET level = 'workspace', owner_id = '1' WHERE id = {workspace_memory};
             INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (1, 'ck', 0, 0);
             INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                  VALUES (1, 'pj-alpha', 'Alpha', '/alpha', 0), (1, 'pj-beta', 'Beta', '/beta', 0);",
            permanent = alpha[0]
        ),
    );
    drop(db);
    let before = std::fs::read(&store).expect("read the store");
    let out = dir.join("out");
    let inputs = Inputs {
        store: store.clone(),
        out: out.clone(),
        grid: grid(),
        model: None,
        now_ms: now_ms(),
    };
    let results = run(&inputs).expect("the simulation runs");

    // The store is byte for byte as it was, and nothing was written beside it.
    assert_eq!(std::fs::read(&store).expect("read the store"), before);
    for suffix in ["-wal", "-shm", "-journal"] {
        assert!(
            !with_suffix(&store, suffix).exists(),
            "{suffix} beside the store"
        );
    }
    for file in [REPORT, RESULTS, STORE] {
        assert!(out.join(file).is_file(), "{file} is written");
    }
    let written: Value = serde_json::from_str(
        &std::fs::read_to_string(out.join(RESULTS)).expect("read results.json"),
    )
    .expect("results.json is JSON");
    assert_eq!(written, results);

    let projects = results["projects"].as_array().expect("projects");
    let owners: Vec<&str> = projects
        .iter()
        .map(|project| project["owner"].as_str().expect("an owner"))
        .collect();
    assert_eq!(owners, ["pj-alpha", "pj-beta"]);
    assert_eq!(
        projects[0]["candidates"],
        json!({"global": 2, "workspace": 1, "project": 3})
    );
    assert_eq!(
        projects[1]["candidates"],
        json!({"global": 2, "workspace": 1, "project": 2})
    );
    // Today pj-alpha shows the profile, its own memories and pj-beta's
    // shared one; pj-beta shows the profile and its own two.
    assert_eq!(projects[0]["today"]["profile"], 2);
    assert_eq!(projects[0]["today"]["projectBlock"], 4);
    assert_eq!(projects[1]["today"]["projectBlock"], 2);
    for (project, own) in [(&projects[0], 3), (&projects[1], 2)] {
        let runs = project["runs"].as_array().expect("runs");
        assert_eq!(runs.len(), 2);
        for run in runs {
            // Everything fits the budget: every candidate is shown.
            assert_eq!(ids(&run["ids"]).len(), 2 + 1 + own);
            assert_eq!(run["criticalOrPermanentNotShown"], json!([]));
            assert_eq!(ids(&run["arrived"]), [workspace_memory]);
            assert_eq!(run["arrived"][0]["level"], "workspace");
            assert_eq!(run["levels"]["workspace"]["shown"], 1);
        }
    }
    let left = &projects[0]["runs"][0]["left"];
    assert_eq!(ids(left), [shared_today]);
    assert_eq!(left[0]["level"], "project (sibling)");
    assert!(left[0]["why"]
        .as_str()
        .expect("why it left")
        .contains("sibling project's memory (Beta)"));
    assert_eq!(projects[1]["runs"][0]["left"], json!([]));
    assert!(ids(&projects[1]["today"]["ids"]).contains(&beta));

    let summary = results["summary"].as_array().expect("summary");
    assert_eq!(summary.len(), 2);
    assert!(summary
        .iter()
        .all(|params| params["projects"].as_array().map(Vec::len) == Some(2)));
    let report = std::fs::read_to_string(out.join(REPORT)).expect("read report.md");
    for heading in ["## Summary", "### `short`", "### `long`", "## Projects"] {
        assert!(report.contains(heading), "report.md has {heading}");
    }
    assert!(report.contains("None, under any parameter set."));

    // A second run never writes over the first.
    let again = run(&inputs).expect_err("the output folder is no longer empty");
    assert!(again.contains("is not empty"), "{again}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn today_is_the_selection_the_heads_fold_shows() {
    let dir = scratch("today");
    let store = dir.join("context.db");
    // More profile lines and project memories than today's budgets hold.
    let profile: Vec<String> = (0..80)
        .map(|at| long_text(&format!("Prefers {at:02}")))
        .collect();
    let db = synthetic_store(&store, &profile);
    let tags = [
        "PROJECT_RULES",
        "ARCHITECTURE",
        "CONSTRAINTS",
        "CONFIG_VALUES",
        "NAMING",
    ];
    let mut saved = Vec::new();
    for at in 0..90 {
        let id = save(
            &db,
            "pj-big",
            tags[at % tags.len()],
            &long_text(&format!("Fact {at:03}")),
        );
        classify(&db, id, (at as i64 * 37) % 100, false);
        saved.push(id);
    }
    // The head shows permanent memories first, whatever their importance.
    let permanent = saved[5];
    sql(
        &db,
        &format!("UPDATE memories SET status = 'permanent', importance = 0 WHERE id = {permanent}"),
    );
    drop(db);
    let now = now_ms();
    let results = run(&Inputs {
        store: store.clone(),
        out: dir.join("out"),
        grid: grid(),
        model: None,
        now_ms: now,
    })
    .expect("the simulation runs");
    let today = &results["projects"][0]["today"];
    let profile_count = today["profile"].as_u64().expect("a count") as usize;
    let today_ids = ids(&today["ids"]);
    let (profile_ids, block_ids) = today_ids.split_at(profile_count);

    // The head itself, folded from the same store.
    let db = ContextDb::open(&store).expect("open the store");
    let settings = Settings::default();
    let (workspace, memories) = db
        .with_connection(|conn| {
            let workspace = Workspace::resolve(conn, "pj-big")?;
            let memories = workspace.memories(conn, now)?;
            Ok::<_, rusqlite::Error>((workspace, memories))
        })
        .expect("read the head's memories");
    let (profile_lines, profile_max_id) = db.user_profile().expect("read the profile");
    let baseline = head::fold(
        &head::Inputs {
            counter: Counter::for_model(None),
            summaries: &[],
            docs: "",
            profile: &profile_lines,
            profile_max_id,
            memories: &memories,
            workspace: Some(&workspace),
            gone: &[],
            history_budget_tokens: 0,
            history_local_budget_tokens: 0,
            memory_budget_tokens: settings.memory_budget_tokens,
            profile_budget_tokens: settings.profile_budget_tokens,
        },
        None,
    );
    let mut block: Vec<i64> = block_ids.to_vec();
    block.sort_unstable();
    assert_eq!(baseline.shown_ids(), block);
    assert!(block.contains(&permanent));
    // The budget left memories out, so the match is a real choice.
    assert!(
        !block.is_empty() && block.len() < saved.len(),
        "{}",
        block.len()
    );

    let contents: HashMap<i64, String> = db
        .memories_by_ids(profile_ids)
        .expect("read the profile rows")
        .into_iter()
        .map(|memory| (memory.id, memory.content))
        .collect();
    let shown_profile: Vec<String> = profile_ids.iter().map(|id| contents[id].clone()).collect();
    assert!(!shown_profile.is_empty() && shown_profile.len() < profile.len());
    assert!(
        baseline
            .m0
            .contains(&memory::render_profile(&shown_profile, "user-profile")),
        "the head's profile block is not the one the simulation counts as today's"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_critical_memory_that_does_not_fit_is_reported_missing() {
    let dir = scratch("critical");
    let store = dir.join("context.db");
    let db = synthetic_store(&store, &[]);
    // Far more important memories than the budget holds.
    for at in 0..150 {
        let id = save(
            &db,
            "pj-crit",
            "ARCHITECTURE",
            &long_text(&format!("Fact {at:03}")),
        );
        classify(&db, id, 90, false);
    }
    let critical = save(
        &db,
        "pj-crit",
        "CONSTRAINTS",
        &long_text("Never delete the store").repeat(3),
    );
    classify(&db, critical, 1, true);
    drop(db);
    let zero = Minimum {
        global: 0,
        workspace: 0,
        project: 0,
    };
    let grid = vec![
        Params {
            name: "no-slice".into(),
            half_life_days: 30.0,
            protected_tokens: 0,
            minimum: zero,
        },
        Params {
            name: "slice".into(),
            half_life_days: 30.0,
            protected_tokens: 2000,
            minimum: zero,
        },
    ];
    let out = dir.join("out");
    let results = run(&Inputs {
        store,
        out: out.clone(),
        grid,
        model: None,
        now_ms: now_ms(),
    })
    .expect("the simulation runs");
    let runs = &results["projects"][0]["runs"];
    assert!(
        ids(&runs[0]["ids"]).len() < 150,
        "the budget must not hold every memory"
    );
    assert_eq!(ids(&runs[0]["criticalOrPermanentNotShown"]), [critical]);
    assert_eq!(runs[0]["criticalOrPermanentNotShown"][0]["critical"], true);
    assert_eq!(
        results["summary"][0]["projects"][0]["criticalOrPermanentNotShown"],
        1
    );
    // With a protected slice it is shown, and nothing is missing.
    assert_eq!(runs[1]["criticalOrPermanentNotShown"], json!([]));
    assert!(ids(&runs[1]["ids"]).contains(&critical));
    assert_eq!(
        results["summary"][1]["projects"][0]["criticalOrPermanentNotShown"],
        0
    );

    // The report names it before its summary, and first in its run.
    let report = std::fs::read_to_string(out.join(REPORT)).expect("read report.md");
    let named = report
        .find(&format!("| #{critical} |"))
        .expect("the report names the memory");
    assert!(
        report
            .find("## Critical or permanent memories not shown")
            .expect("the section")
            < named
    );
    assert!(named < report.find("## Summary").expect("the summary"));
    let section = &report[report.find("under `no-slice`").expect("the run's section")..];
    assert!(
        section
            .find("**Critical or permanent memories not shown: 1**")
            .expect("the count")
            < section.find("Left (").expect("the left list")
    );
    let _ = std::fs::remove_dir_all(&dir);
}
