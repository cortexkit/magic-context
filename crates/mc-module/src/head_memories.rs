//! The memories a session's history head may show: read from the store,
//! priced as the head renders them, and chosen by the one rendering function
//! ([`crate::memory_render::select`]). The head's fold, its memory-update
//! lines, the mural, the search's visible set and the simulation harness all
//! go through here, so they agree on what the head shows.
//!
//! The budget joins the two settings a person can set, the project memory
//! budget (`memory.injection_budget_tokens`) and the user profile's, into one
//! total that every level fills. Its shares were set by simulating every
//! project's head on a copy of the store
//! (`.cortexkit/internal-docs/designs/memory-profiles-spec/04-simulation-results.md`).

use std::collections::{BTreeMap, HashMap, HashSet};

use rusqlite::Connection;

use crate::context_db::StoredMemory;
use crate::count::Counter;
use crate::memory;
use crate::memory_profile::Profile;
use crate::memory_render::{select, Budget, Candidate, Decay, Level, Selection};

const DAY_MS: i64 = 86_400_000;
/// A drifting memory loses half its weight in this long since it was last
/// met again. The simulation could not tell 90 days from 180; the gentler
/// one drops less until verification confirms old memories again.
pub(crate) const HALF_LIFE_MS: i64 = 180 * DAY_MS;
/// A row the head may show: live, and not past its end. `?1` is the time the
/// head is rendered at.
pub(crate) const LIVE: &str =
    "status IN ('active', 'permanent') AND (expires_at IS NULL OR expires_at > ?1)";
/// The columns [`Row::read`] reads, in its order.
pub(crate) const ROW_COLUMNS: &str = "id, level, owner_id, category, origin_category, content,
    importance, status, authority, safety_critical, decay_class, last_seen_at, verified_at,
    expires_at, overrides_memory_id, source_project_id, superseded_by_memory_id,
    COALESCE(json_extract(metadata_json, '$.promoted_at'), created_at),
    COALESCE(json_extract(metadata_json, '$.user_memory_id'), id)";
/// The owner of the person's own global memories.
const SELF_OWNER: &str = "self";

/// One memory row, as the head reads it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Row {
    pub id: i64,
    pub level: String,
    pub owner: String,
    /// The profile category id.
    pub category: String,
    /// The tag the memory was written under, which a memory block groups by.
    pub tag: String,
    pub content: String,
    pub importance: Option<i64>,
    pub status: String,
    pub policy: bool,
    pub critical: bool,
    pub decay_class: Option<String>,
    pub last_seen_at: Option<i64>,
    pub verified_at: Option<i64>,
    pub expires_at: Option<i64>,
    pub overrides: Option<i64>,
    /// The project a workspace memory came from.
    pub source_project: Option<String>,
    pub superseded_by: Option<i64>,
    /// The order a user-profile line was learned in: its promotion time and
    /// old user-memory id, which a memory moved from the 0.49 user-memory
    /// table keeps in `metadata_json`. The profile block lists lines in it.
    pub learned: (Option<i64>, i64),
}

impl Row {
    pub(crate) fn read(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
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
            policy: row.get::<_, Option<String>>(8)?.as_deref() == Some("policy"),
            critical: row.get::<_, Option<i64>>(9)? == Some(1),
            decay_class: row.get(10)?,
            last_seen_at: row.get(11)?,
            verified_at: row.get(12)?,
            expires_at: row.get(13)?,
            overrides: row.get(14)?,
            source_project: row.get(15)?,
            superseded_by: row.get(16)?,
            learned: (row.get(17)?, row.get(18)?),
        })
    }

    /// `memory` as a row at `level`, owned by its project (or by `self` at
    /// the global level), its tag standing in for its profile category, for
    /// callers that hold the module's other memory shape.
    pub fn from_stored(level: &str, memory: &StoredMemory) -> Self {
        Self {
            id: memory.id,
            level: level.into(),
            owner: if level == "global" {
                SELF_OWNER.into()
            } else {
                memory.project_path.clone()
            },
            category: memory.category.clone(),
            tag: memory.category.clone(),
            content: memory.content.clone(),
            importance: memory.importance.map(i64::from),
            status: memory.status.clone(),
            policy: false,
            critical: false,
            decay_class: None,
            last_seen_at: memory.last_seen_at,
            verified_at: memory.verified_at,
            expires_at: memory.expires_at,
            overrides: None,
            source_project: None,
            superseded_by: memory.superseded_by_memory_id,
            learned: (None, memory.id),
        }
    }

    pub fn permanent(&self) -> bool {
        self.status == "permanent"
    }

    /// The last time the memory was genuinely met again: seen again by a
    /// summary or an agent's save, or confirmed by a verification.
    pub fn last_met(&self) -> Option<i64> {
        self.last_seen_at.into_iter().chain(self.verified_at).max()
    }

    pub(crate) fn level(&self) -> Option<Level> {
        match self.level.as_str() {
            "global" => Some(Level::Global),
            "workspace" => Some(Level::Workspace),
            "project" => Some(Level::Project),
            _ => None,
        }
    }

    /// The row as the head's project-block line renderer takes it.
    pub fn stored(&self) -> StoredMemory {
        StoredMemory {
            id: self.id,
            project_path: self.owner.clone(),
            category: self.tag.clone(),
            content: self.content.clone(),
            importance: self.importance.map(|value| value as i32),
            status: self.status.clone(),
            expires_at: self.expires_at,
            superseded_by_memory_id: self.superseded_by,
            last_seen_at: self.last_seen_at,
            verified_at: self.verified_at,
            ..StoredMemory::default()
        }
    }
}

/// The rows a head may show: the person's global memories, the project's
/// own, and its workspace's. `project` and `workspace` are Entorhinal's ids
/// for the session (its memory context); a session without one sees none
/// of that level's rows.
pub fn read_rows(
    conn: &Connection,
    project: Option<&str>,
    workspace: Option<&str>,
    now: i64,
) -> rusqlite::Result<Vec<Row>> {
    conn.prepare_cached(&format!(
        "SELECT {ROW_COLUMNS} FROM memories
          WHERE {LIVE} AND ((level = 'global' AND owner_id = '{SELF_OWNER}')
             OR (level = 'project' AND owner_id = ?2)
             OR (level = 'workspace' AND owner_id = ?3))
          ORDER BY id"
    ))?
    .query_map(rusqlite::params![now, project, workspace], Row::read)?
    .collect()
}

/// These memories' rows, whatever their status: the head reads them for
/// memories it shows that are no longer live, to say they were archived or
/// merged away.
pub fn rows_by_ids(conn: &Connection, ids: &[i64]) -> rusqlite::Result<Vec<Row>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    conn.prepare_cached(&format!(
        "SELECT {ROW_COLUMNS} FROM memories WHERE id IN (SELECT value FROM json_each(?1)) ORDER BY id"
    ))?
    .query_map([serde_json::to_string(ids).expect("ids serialize")], Row::read)?
    .collect()
}

/// Each category id's decay class in the profile a session with `context`
/// resolves, computed once per profile digest per process. A profile that
/// can't be resolved gives no classes, so every memory keeps full weight.
pub fn classes_for(
    context: Option<&crate::memory_profile::MemoryContext>,
) -> std::sync::Arc<HashMap<String, String>> {
    use std::sync::{Arc, Mutex, OnceLock};
    type Classes = Arc<HashMap<String, String>>;
    static CACHE: OnceLock<Mutex<HashMap<String, Classes>>> = OnceLock::new();
    let profile = match crate::memory_profile::prompt_profile(context) {
        Ok(profile) => profile,
        Err(refusal) => {
            tracing::warn!("ck-mc: the head ranks memories without decay classes: {refusal:?}");
            return Arc::default();
        }
    };
    let cache = CACHE.get_or_init(Default::default);
    let mut cache = cache
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    cache
        .entry(profile.digest.clone())
        .or_insert_with(|| Arc::new(decay_classes(&profile)))
        .clone()
}

/// Each category id's decay class in `profile`.
pub(crate) fn decay_classes(profile: &Profile) -> HashMap<String, String> {
    profile.body["categories"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|category| {
            Some((
                category["id"].as_str()?.to_owned(),
                category["decay_class"].as_str()?.to_owned(),
            ))
        })
        .collect()
}

/// A row's decay class: its own, or its category's. An unknown class keeps
/// full weight, as the rendering function treats a class it doesn't know.
pub(crate) fn decay(row: &Row, classes: &HashMap<String, String>) -> Decay {
    let class = row
        .decay_class
        .as_deref()
        .filter(|class| !class.is_empty())
        .or_else(|| classes.get(&row.category).map(String::as_str));
    Decay::named(class.unwrap_or_default())
}

/// The budget the head fills, from the two settings a person can set.
pub(crate) fn budget(memory_budget: u64, profile_budget: u64) -> Budget {
    let total = memory_budget + profile_budget;
    Budget {
        total_tokens: total,
        // Critical rules may take the whole budget, less what the user
        // profile needs for its minimum (`memory_render::select`).
        protected_tokens: total,
        level_minimum_tokens: BTreeMap::from([
            (Level::Global, profile_budget.min(total * 5 / 16)),
            (Level::Workspace, total / 8),
            (Level::Project, total * 3 / 8),
        ]),
        half_life_ms: HALF_LIFE_MS,
    }
}

/// The block a level's memories are shown in.
pub(crate) fn wrapper(level: Level) -> &'static str {
    match level {
        Level::Global => "user-profile",
        Level::Workspace => "workspace-memory",
        Level::Project => "project-memory",
        Level::Agent => "agent-memory",
    }
}

/// What showing `row` costs, counted as the head renders it: a project or
/// workspace line with its category tags and the block's wrapper, or a
/// user-profile bullet (plus four tokens for its share of the block's
/// newlines), which has no category tags.
fn priced(row: &Row, level: Level, counter: Counter) -> Candidate {
    let (line_tokens, category_tokens) = match level {
        Level::Global => (counter.count(&format!("- {}", row.content)) + 4, 0),
        _ => (
            counter.count(&(memory::render_line(&row.stored()) + "\n")),
            counter.count(&format!("<{0}>\n</{0}>\n", row.tag)),
        ),
    };
    let block = wrapper(level);
    Candidate {
        id: row.id,
        level,
        source_project: (level == Level::Workspace)
            .then(|| row.source_project.clone())
            .flatten(),
        category: row.tag.clone(),
        importance: row.importance,
        permanent: row.permanent(),
        policy: row.policy,
        safety_critical: row.critical,
        decay: Decay::Stable,
        last_met_ms: row.last_met(),
        expires_at_ms: row.expires_at,
        // The store records no resolution for an open-until-resolved memory.
        resolved: false,
        overrides: row.overrides,
        line_tokens,
        category_tokens,
        block_tokens: counter.count(&format!("<{block}>\n</{block}>")),
    }
}

/// The candidates `rows` give the rendering function. A row at a level the
/// head has no block for is left out.
pub(crate) fn candidates(
    rows: &[Row],
    classes: &HashMap<String, String>,
    counter: Counter,
) -> Vec<Candidate> {
    rows.iter()
        .filter_map(|row| {
            let level = row.level().filter(|level| *level != Level::Agent)?;
            Some(Candidate {
                decay: decay(row, classes),
                ..priced(row, level, counter)
            })
        })
        .collect()
}

/// The memories a head shows, chosen from `rows` at `now`.
pub(crate) fn choose(
    rows: &[Row],
    classes: &HashMap<String, String>,
    counter: Counter,
    budget: &Budget,
    now: i64,
) -> Selection {
    select(&candidates(rows, classes, counter), budget, now)
}

/// The memory blocks of `m[0]` for the rows `shown`, each empty when it has
/// nothing: the user profile (in the order its lines were learned, as the
/// 0.49 profile listed them), the workspace's memories and the project's,
/// each grouped by category. A workspace memory's line names no project:
/// it holds for every project in the workspace, whichever one it was
/// learned in.
pub struct Blocks {
    pub user_profile: String,
    pub workspace: String,
    pub project: String,
}

pub fn render(rows: &[Row], shown: &HashSet<i64>) -> Blocks {
    let at = |level: Level| -> Vec<&Row> {
        let mut rows: Vec<&Row> = rows
            .iter()
            .filter(|row| row.level() == Some(level) && shown.contains(&row.id))
            .collect();
        rows.sort_by_key(|row| (row.learned, row.id));
        rows
    };
    let profile: Vec<String> = at(Level::Global)
        .into_iter()
        .map(|row| row.content.clone())
        .collect();
    let block = |level: Level| -> String {
        let rows: Vec<StoredMemory> = at(level).into_iter().map(Row::stored).collect();
        memory::render_block(&rows, wrapper(level))
    };
    Blocks {
        user_profile: memory::render_profile(&profile, wrapper(Level::Global)),
        workspace: block(Level::Workspace),
        project: block(Level::Project),
    }
}

#[cfg(test)]
#[path = "head_memories_tests.rs"]
mod tests;
