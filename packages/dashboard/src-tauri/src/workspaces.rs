//! Workspace CRUD and schema-readiness for migration v35+.

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use crate::db::{self, ProjectRow};
use crate::project_identity::{basename, normalize_stored_project_path};

pub const WORKSPACE_SCHEMA_VERSION: i64 = 35;

// Parity assertion: keep this value equal to FORK_MIGRATION_VERSION_FLOOR in
// packages/plugin/src/features/magic-context/migrations.ts, the TypeScript source of truth.
const FORK_MIGRATION_VERSION_FLOOR: i64 = 10_000;

const SHARE_CATEGORY_ORDER: [&str; 5] = [
    "PROJECT_RULES",
    "ARCHITECTURE",
    "CONSTRAINTS",
    "CONFIG_VALUES",
    "NAMING",
];

static WORKSPACE_READY_CACHE: OnceLock<Mutex<Option<bool>>> = OnceLock::new();

pub fn clear_workspace_schema_ready_cache_for_tests() {
    if let Some(m) = WORKSPACE_READY_CACHE.get() {
        if let Ok(mut g) = m.lock() {
            *g = None;
        }
    }
}

fn workspace_ready_cache() -> &'static Mutex<Option<bool>> {
    WORKSPACE_READY_CACHE.get_or_init(|| Mutex::new(None))
}

pub fn workspace_schema_ready(conn: &Connection) -> Result<bool, rusqlite::Error> {
    // Only a `true` verdict is cached: schemas never un-migrate, but a `false`
    // verdict can flip the moment a v35 plugin process migrates the shared DB
    // while the dashboard stays open — so not-ready must re-probe every call
    // (sqlite_master + schema version + column lookups, negligible).
    if let Ok(guard) = workspace_ready_cache().lock() {
        if *guard == Some(true) {
            return Ok(true);
        }
    }
    let ready = compute_workspace_schema_ready(conn)?;
    if ready {
        if let Ok(mut guard) = workspace_ready_cache().lock() {
            *guard = Some(true);
        }
    }
    Ok(ready)
}

fn compute_workspace_schema_ready(conn: &Connection) -> Result<bool, rusqlite::Error> {
    let has_migrations: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
        [],
        |row| row.get(0),
    )?;
    if has_migrations == 0 {
        return Ok(false);
    }
    let has_workspaces: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'",
        [],
        |row| row.get(0),
    )?;
    if has_workspaces == 0 {
        return Ok(false);
    }
    let has_workspace_members: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'workspace_members'",
        [],
        |row| row.get(0),
    )?;
    if has_workspace_members == 0 {
        return Ok(false);
    }
    if !workspace_share_categories_column_exists(conn)? {
        return Ok(false);
    }
    let max_version: i64 = conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations WHERE version < ?1",
        [FORK_MIGRATION_VERSION_FLOOR],
        |row| row.get(0),
    )?;
    Ok(max_version >= WORKSPACE_SCHEMA_VERSION)
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceMemberView {
    pub project_path: String,
    pub display_name: String,
    pub display_path: String,
    pub memory_count: i64,
    pub added_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceListItem {
    pub id: i64,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub share_categories: Vec<String>,
    pub members: Vec<WorkspaceMemberView>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceSummary {
    pub id: i64,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WorkspaceMemberChange {
    pub project_path: String,
    pub display_name: String,
    pub display_path: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WorkspaceDisplayNameChange {
    pub project_path: String,
    pub display_name: String,
}

#[derive(Debug, Clone)]
struct MemberState {
    display_name: String,
    display_path: String,
    added_at: i64,
}

pub fn list_workspaces(conn: &Connection) -> Result<Vec<WorkspaceListItem>, rusqlite::Error> {
    if !workspace_schema_ready(conn)? {
        return Ok(Vec::new());
    }
    let mut stmt = conn.prepare(
        "SELECT id, name, created_at, updated_at, share_categories FROM workspaces ORDER BY name ASC",
    )?;
    let rows: Vec<(i64, String, i64, i64, Option<String>)> = stmt
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut out = Vec::with_capacity(rows.len());
    for (id, name, created_at, updated_at, share_categories_raw) in rows {
        let members = list_workspace_members(conn, id)?;
        out.push(WorkspaceListItem {
            id,
            name,
            created_at,
            updated_at,
            share_categories: normalize_stored_share_categories(share_categories_raw.as_deref()),
            members,
        });
    }
    Ok(out)
}

pub fn list_workspace_summaries(
    conn: &Connection,
) -> Result<Vec<WorkspaceSummary>, rusqlite::Error> {
    if !workspace_schema_ready(conn)? {
        return Ok(Vec::new());
    }
    let mut stmt = conn.prepare("SELECT id, name FROM workspaces ORDER BY name ASC")?;
    let rows = stmt.query_map([], |row| {
        Ok(WorkspaceSummary {
            id: row.get(0)?,
            name: row.get(1)?,
        })
    })?;
    rows.collect()
}

fn list_workspace_members(
    conn: &Connection,
    workspace_id: i64,
) -> Result<Vec<WorkspaceMemberView>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT project_path, display_name, display_path, added_at
         FROM workspace_members WHERE workspace_id = ?1 ORDER BY display_name ASC",
    )?;
    let raw: Vec<(String, String, String, i64)> = stmt
        .query_map(params![workspace_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut members = Vec::with_capacity(raw.len());
    for (project_path, display_name, display_path, added_at) in raw {
        let count = db::count_memories_matching_identity(conn, &project_path)?;
        members.push(WorkspaceMemberView {
            project_path,
            display_name,
            display_path,
            memory_count: count,
            added_at,
        });
    }
    Ok(members)
}

pub fn workspace_member_identities(
    conn: &Connection,
    workspace_id: i64,
) -> Result<HashSet<String>, rusqlite::Error> {
    if !workspace_schema_ready(conn)? {
        return Ok(HashSet::new());
    }
    let mut stmt =
        conn.prepare("SELECT project_path FROM workspace_members WHERE workspace_id = ?1")?;
    let rows = stmt.query_map(params![workspace_id], |row| row.get(0))?;
    rows.collect()
}

pub fn workspace_member_identities_for_project(
    conn: &Connection,
    identity: &str,
) -> Result<HashSet<String>, rusqlite::Error> {
    if identity.is_empty() || !workspace_schema_ready(conn)? {
        let mut s = HashSet::new();
        if !identity.is_empty() {
            s.insert(identity.to_string());
        }
        return Ok(s);
    }
    let workspace_id: Option<i64> = conn
        .query_row(
            "SELECT workspace_id FROM workspace_members WHERE project_path = ?1",
            params![identity],
            |row| row.get(0),
        )
        .optional()?;
    let Some(ws_id) = workspace_id else {
        let mut s = HashSet::new();
        s.insert(identity.to_string());
        return Ok(s);
    };
    workspace_member_identities(conn, ws_id)
}

pub fn display_name_for_memory_in_workspace(
    conn: &Connection,
    workspace_id: i64,
    memory_project_path: &str,
) -> Result<Option<String>, rusqlite::Error> {
    if !workspace_schema_ready(conn)? {
        return Ok(None);
    }
    let memory_identity = normalize_stored_project_path(memory_project_path);
    let mut stmt = conn.prepare(
        "SELECT display_name, project_path FROM workspace_members WHERE workspace_id = ?1",
    )?;
    let rows: Vec<(String, String)> = stmt
        .query_map(params![workspace_id], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    for (display_name, member_path) in rows {
        if normalize_stored_project_path(&member_path) == memory_identity
            || member_path == memory_project_path
        {
            return Ok(Some(display_name));
        }
    }
    Ok(None)
}

pub fn resolve_workspace_filter_paths(
    conn: &Connection,
    workspace_id: i64,
) -> Result<Vec<String>, rusqlite::Error> {
    if !workspace_schema_ready(conn)? {
        return Ok(Vec::new());
    }
    let identities = workspace_member_identities(conn, workspace_id)?;
    let mut paths = HashSet::new();
    for identity in identities {
        let resolved = db::resolve_paths_for_memory_filter(conn, &identity)?;
        for p in resolved {
            paths.insert(p);
        }
    }
    let mut v: Vec<String> = paths.into_iter().collect();
    v.sort();
    Ok(v)
}

pub fn workspace_member_identities_union(
    old_members: &HashSet<String>,
    new_members: &HashSet<String>,
) -> HashSet<String> {
    old_members.union(new_members).cloned().collect()
}

pub fn bump_epochs_for_identities(
    tx: &Transaction<'_>,
    identities: &HashSet<String>,
) -> Result<(), rusqlite::Error> {
    for identity in identities {
        db::bump_project_memory_epoch_for_identity_pub(tx, identity)?;
    }
    Ok(())
}

pub fn bump_epochs_for_workspace_mutation(
    tx: &Transaction<'_>,
    old_members: &HashSet<String>,
    new_members: &HashSet<String>,
) -> Result<(), rusqlite::Error> {
    let union = workspace_member_identities_union(old_members, new_members);
    bump_epochs_for_identities(tx, &union)
}

pub fn bump_epochs_for_memory_identity(
    tx: &Transaction<'_>,
    conn: &Connection,
    identity: &str,
) -> Result<(), rusqlite::Error> {
    let set = workspace_member_identities_for_project(conn, identity)?;
    bump_epochs_for_identities(tx, &set)
}

pub fn workspace_member_picker_rows(conn: &Connection) -> Result<Vec<ProjectRow>, rusqlite::Error> {
    if !workspace_schema_ready(conn)? {
        return Ok(Vec::new());
    }
    let mut stmt =
        conn.prepare("SELECT project_path, display_name, display_path FROM workspace_members")?;
    let rows: Vec<(String, String, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows
        .into_iter()
        .map(|(identity, display_name, display_path)| ProjectRow {
            identity: identity.clone(),
            display_name: if display_name.is_empty() {
                basename(&display_path)
            } else {
                display_name
            },
            primary_path: display_path,
            harnesses: Vec::new(),
            session_count: 0,
        })
        .collect())
}

pub fn extra_workspace_member_identities(
    conn: &Connection,
) -> Result<HashSet<String>, rusqlite::Error> {
    if !workspace_schema_ready(conn)? {
        return Ok(HashSet::new());
    }
    let mut stmt = conn.prepare("SELECT DISTINCT project_path FROM workspace_members")?;
    let rows = stmt.query_map([], |row| row.get(0))?;
    rows.collect()
}

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn sqlite_error(code: i32, message: impl Into<String>) -> rusqlite::Error {
    rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(code), Some(message.into()))
}

fn constraint_error(message: impl Into<String>) -> rusqlite::Error {
    sqlite_error(rusqlite::ffi::SQLITE_CONSTRAINT, message)
}

fn not_found_error(message: impl Into<String>) -> rusqlite::Error {
    sqlite_error(rusqlite::ffi::SQLITE_NOTFOUND, message)
}

fn validate_display_name(name: &str) -> Result<(), rusqlite::Error> {
    if name.trim().is_empty() {
        return Err(constraint_error("Display name cannot be empty."));
    }
    Ok(())
}

fn workspace_share_categories_column_exists(conn: &Connection) -> Result<bool, rusqlite::Error> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('workspaces') WHERE name = 'share_categories'",
        [],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

fn workspace_share_categories_column_exists_tx(
    tx: &Transaction<'_>,
) -> Result<bool, rusqlite::Error> {
    let count: i64 = tx.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('workspaces') WHERE name = 'share_categories'",
        [],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

fn canonical_all_share_categories() -> Vec<String> {
    SHARE_CATEGORY_ORDER
        .iter()
        .map(|s| (*s).to_string())
        .collect()
}

fn normalize_share_categories(categories: Vec<String>) -> Result<Vec<String>, rusqlite::Error> {
    let mut seen = HashSet::new();
    for category in categories {
        if !SHARE_CATEGORY_ORDER.contains(&category.as_str()) {
            return Err(constraint_error(format!(
                "Unknown workspace share category \"{}\".",
                category
            )));
        }
        seen.insert(category);
    }
    Ok(SHARE_CATEGORY_ORDER
        .iter()
        .filter(|category| seen.contains(**category))
        .map(|category| (*category).to_string())
        .collect())
}

fn normalize_stored_share_categories(raw: Option<&str>) -> Vec<String> {
    // NULL or invalid historical values fail open to all categories; post-v35
    // dashboard writes still validate and store a canonical JSON array.
    let Some(raw) = raw else {
        return canonical_all_share_categories();
    };
    let Ok(parsed) = serde_json::from_str::<Vec<String>>(raw) else {
        return canonical_all_share_categories();
    };
    normalize_share_categories(parsed).unwrap_or_else(|_| canonical_all_share_categories())
}

fn share_categories_json(categories: &[String]) -> Result<String, rusqlite::Error> {
    serde_json::to_string(categories).map_err(|e| {
        sqlite_error(
            rusqlite::ffi::SQLITE_ERROR,
            format!("Failed to serialize workspace share categories: {e}"),
        )
    })
}

fn members_of_workspace(
    tx: &Transaction<'_>,
    workspace_id: i64,
) -> Result<HashSet<String>, rusqlite::Error> {
    let mut stmt =
        tx.prepare("SELECT project_path FROM workspace_members WHERE workspace_id = ?1")?;
    let rows = stmt.query_map(params![workspace_id], |row| row.get(0))?;
    rows.collect()
}

fn member_map_of_workspace(
    tx: &Transaction<'_>,
    workspace_id: i64,
) -> Result<BTreeMap<String, MemberState>, rusqlite::Error> {
    let mut stmt = tx.prepare(
        "SELECT project_path, display_name, display_path, added_at
         FROM workspace_members WHERE workspace_id = ?1",
    )?;
    let rows = stmt.query_map(params![workspace_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            MemberState {
                display_name: row.get(1)?,
                display_path: row.get(2)?,
                added_at: row.get(3)?,
            },
        ))
    })?;
    rows.collect()
}

fn workspace_metadata(
    tx: &Transaction<'_>,
    workspace_id: i64,
    has_share_categories: bool,
) -> Result<(String, Vec<String>), rusqlite::Error> {
    if has_share_categories {
        let row: Option<(String, Option<String>)> = tx
            .query_row(
                "SELECT name, share_categories FROM workspaces WHERE id = ?1",
                params![workspace_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((name, share_categories)) = row else {
            return Err(not_found_error("Workspace not found."));
        };
        return Ok((
            name,
            normalize_stored_share_categories(share_categories.as_deref()),
        ));
    }

    let row: Option<String> = tx
        .query_row(
            "SELECT name FROM workspaces WHERE id = ?1",
            params![workspace_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(name) = row else {
        return Err(not_found_error("Workspace not found."));
    };
    Ok((name, canonical_all_share_categories()))
}

fn validate_unique_display_names(
    final_members: &BTreeMap<String, MemberState>,
) -> Result<(), rusqlite::Error> {
    let mut by_name: HashMap<String, String> = HashMap::new();
    for (identity, member) in final_members {
        validate_display_name(&member.display_name)?;
        if let Some(existing_identity) =
            by_name.insert(member.display_name.clone(), identity.clone())
        {
            return Err(constraint_error(format!(
                "Display name \"{}\" is already used by both {} and {} in this workspace.",
                member.display_name, existing_identity, identity
            )));
        }
    }
    Ok(())
}

fn workspace_not_ready_error() -> rusqlite::Error {
    rusqlite::Error::SqliteFailure(
        rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_ERROR),
        Some("Workspaces are not available until the Magic Context plugin is updated.".to_string()),
    )
}

pub fn create_workspace(conn: &mut Connection, name: &str) -> Result<i64, rusqlite::Error> {
    if !workspace_schema_ready(conn)? {
        return Err(workspace_not_ready_error());
    }
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(constraint_error("Workspace name cannot be empty."));
    }
    let now = now_millis();
    let tx = crate::writer_diagnostics::begin(conn, concat!(file!(), ":", line!()))?;
    tx.execute(
        "INSERT INTO workspaces (name, created_at, updated_at) VALUES (?1, ?2, ?2)",
        params![trimmed, now],
    )?;
    let id = tx.last_insert_rowid();
    tx.commit()?;
    Ok(id)
}

pub fn rename_workspace(
    conn: &mut Connection,
    workspace_id: i64,
    new_name: &str,
) -> Result<(), rusqlite::Error> {
    if !workspace_schema_ready(conn)? {
        return Err(workspace_not_ready_error());
    }
    let trimmed = new_name.trim();
    if trimmed.is_empty() {
        return Err(constraint_error("Workspace name cannot be empty."));
    }
    let now = now_millis();
    let tx = crate::writer_diagnostics::begin(conn, concat!(file!(), ":", line!()))?;
    // No epoch bump: the workspace NAME is not rendered into m[0]/m[1] (only
    // member `display_name` affects the `source=` attribution), so renaming the
    // workspace must not force a hard m[0] re-fold in every member session.
    tx.execute(
        "UPDATE workspaces SET name = ?1, updated_at = ?2 WHERE id = ?3",
        params![trimmed, now, workspace_id],
    )?;
    tx.commit()?;
    Ok(())
}

pub fn delete_workspace(conn: &mut Connection, workspace_id: i64) -> Result<(), rusqlite::Error> {
    if !workspace_schema_ready(conn)? {
        return Err(workspace_not_ready_error());
    }
    let tx = crate::writer_diagnostics::begin(conn, concat!(file!(), ":", line!()))?;
    let old_members = members_of_workspace(&tx, workspace_id)?;
    tx.execute(
        "DELETE FROM workspaces WHERE id = ?1",
        params![workspace_id],
    )?;
    bump_epochs_for_workspace_mutation(&tx, &old_members, &HashSet::new())?;
    tx.commit()?;
    Ok(())
}

pub fn apply_workspace_changes(
    conn: &mut Connection,
    workspace_id: i64,
    rename: Option<String>,
    add_members: Vec<WorkspaceMemberChange>,
    remove_members: Vec<String>,
    set_display_names: Vec<WorkspaceDisplayNameChange>,
    share_categories: Option<Vec<String>>,
) -> Result<(), rusqlite::Error> {
    if !workspace_schema_ready(conn)? {
        return Err(workspace_not_ready_error());
    }

    // None means "this save does not speak for the categories": a membership
    // change must not carry a copy read earlier, or a category disabled in
    // another window in between would be turned back on.
    let normalized_share_categories = share_categories
        .map(normalize_share_categories)
        .transpose()?;
    let rename = rename
        .map(|name| name.trim().to_string())
        .map(|name| {
            if name.is_empty() {
                Err(constraint_error("Workspace name cannot be empty."))
            } else {
                Ok(name)
            }
        })
        .transpose()?;

    let now = now_millis();
    let tx = crate::writer_diagnostics::begin(conn, concat!(file!(), ":", line!()))?;
    let has_share_categories = workspace_share_categories_column_exists_tx(&tx)?;
    let (current_name, old_share_categories) =
        workspace_metadata(&tx, workspace_id, has_share_categories)?;
    let old_members = member_map_of_workspace(&tx, workspace_id)?;
    let old_member_ids: HashSet<String> = old_members.keys().cloned().collect();

    let mut remove_set = HashSet::new();
    for project_path in remove_members {
        let identity = normalize_stored_project_path(&project_path);
        remove_set.insert(identity);
    }

    let mut add_map: BTreeMap<String, WorkspaceMemberChange> = BTreeMap::new();
    for member in add_members {
        let identity = normalize_stored_project_path(&member.project_path);
        if is_user_home_workspace_member(&identity, &member.display_path) {
            return Err(constraint_error(
                "The home directory cannot be added to a workspace. Home sessions are intentionally isolated from workspace memory sharing.",
            ));
        }
        validate_display_name(&member.display_name)?;
        if add_map.insert(identity.clone(), member).is_some() {
            return Err(constraint_error(format!(
                "Project {} appears more than once in the staged additions.",
                identity
            )));
        }
    }

    for identity in add_map.keys() {
        if remove_set.contains(identity) {
            return Err(constraint_error(format!(
                "Project {} cannot be both added and removed in one save.",
                identity
            )));
        }
    }

    let mut final_members = old_members.clone();
    for identity in &remove_set {
        if !old_members.contains_key(identity) {
            return Err(not_found_error("Workspace member not found."));
        }
        final_members.remove(identity);
    }

    for (identity, member) in &add_map {
        let existing_ws: Option<i64> = tx
            .query_row(
                "SELECT workspace_id FROM workspace_members WHERE project_path = ?1",
                params![identity],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(other_workspace_id) = existing_ws {
            if other_workspace_id != workspace_id {
                return Err(constraint_error(
                    "This project already belongs to another workspace.",
                ));
            }
            return Err(constraint_error(
                "This project is already a member of this workspace.",
            ));
        }
        if final_members.contains_key(identity) {
            return Err(constraint_error(
                "This project is already a member of this workspace.",
            ));
        }
        final_members.insert(
            identity.clone(),
            MemberState {
                display_name: member.display_name.clone(),
                display_path: member.display_path.clone(),
                added_at: now,
            },
        );
    }

    let mut staged_display_names = BTreeMap::new();
    for change in set_display_names {
        let identity = normalize_stored_project_path(&change.project_path);
        validate_display_name(&change.display_name)?;
        staged_display_names.insert(identity, change.display_name);
    }
    for (identity, display_name) in staged_display_names {
        let Some(member) = final_members.get_mut(&identity) else {
            return Err(not_found_error("Workspace member not found."));
        };
        member.display_name = display_name;
    }

    // All validation is against the fully staged member map. This lets one Save
    // reuse display names freed by removals and avoids the old per-action false
    // positives while still preserving the final uniqueness invariant.
    validate_unique_display_names(&final_members)?;

    let new_member_ids: HashSet<String> = final_members.keys().cloned().collect();
    let membership_changed = old_member_ids != new_member_ids;
    let display_names_changed = final_members.iter().any(|(identity, member)| {
        old_members
            .get(identity)
            .map(|old| old.display_name != member.display_name)
            .unwrap_or(false)
    });
    let share_categories_changed = match &normalized_share_categories {
        Some(categories) => has_share_categories && &old_share_categories != categories,
        None => false,
    };

    if rename.as_deref() != Some(current_name.as_str()) {
        if let Some(name) = &rename {
            tx.execute(
                "UPDATE workspaces SET name = ?1 WHERE id = ?2",
                params![name, workspace_id],
            )?;
        }
    }

    for identity in &remove_set {
        tx.execute(
            "DELETE FROM workspace_members WHERE workspace_id = ?1 AND project_path = ?2",
            params![workspace_id, identity],
        )?;
    }

    let changed_existing_display_names: Vec<(String, String)> = final_members
        .iter()
        .filter_map(|(identity, member)| {
            old_members.get(identity).and_then(|old| {
                if old.display_name != member.display_name {
                    Some((identity.clone(), member.display_name.clone()))
                } else {
                    None
                }
            })
        })
        .collect();
    let mut occupied_names: HashSet<String> = final_members
        .values()
        .map(|member| member.display_name.clone())
        .collect();
    for (idx, (identity, _)) in changed_existing_display_names.iter().enumerate() {
        let temp_name = temporary_display_name(workspace_id, now, idx, &mut occupied_names);
        tx.execute(
            "UPDATE workspace_members SET display_name = ?1
             WHERE workspace_id = ?2 AND project_path = ?3",
            params![temp_name, workspace_id, identity],
        )?;
    }

    for (identity, member) in &final_members {
        if old_members.contains_key(identity) {
            continue;
        }
        tx.execute(
            "INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                workspace_id,
                identity,
                member.display_name,
                member.display_path,
                member.added_at
            ],
        )?;
    }

    for (identity, display_name) in changed_existing_display_names {
        let updated = tx.execute(
            "UPDATE workspace_members SET display_name = ?1
             WHERE workspace_id = ?2 AND project_path = ?3",
            params![display_name, workspace_id, identity],
        )?;
        if updated == 0 {
            return Err(not_found_error("Workspace member not found."));
        }
    }

    if let (true, Some(categories)) = (has_share_categories, &normalized_share_categories) {
        tx.execute(
            "UPDATE workspaces SET share_categories = ?1 WHERE id = ?2",
            params![share_categories_json(categories)?, workspace_id],
        )?;
    }

    tx.execute(
        "UPDATE workspaces SET updated_at = ?1 WHERE id = ?2",
        params![now, workspace_id],
    )?;

    if membership_changed || display_names_changed || share_categories_changed {
        // A single fan-out over old∪new is the cache invariant: membership,
        // attribution names, and sharing changes each need one fold opportunity,
        // but rename-only/no-op Saves must not churn member epochs.
        bump_epochs_for_workspace_mutation(&tx, &old_member_ids, &new_member_ids)?;
    }

    tx.commit()?;
    Ok(())
}

/// The home directory as the membership check sees it: its canonical path and
/// the `dir:<hash>` project identity it carries. Computed once per caller that
/// tests many projects (the Projects grid does), since resolving it costs two
/// filesystem calls.
pub(crate) struct HomeProject {
    canonical: PathBuf,
    identity: String,
}

impl HomeProject {
    pub(crate) fn resolve() -> Option<Self> {
        let canonical = fs::canonicalize(dirs::home_dir()?).ok()?;
        let digest = format!("{:x}", md5::compute(canonical.to_string_lossy().as_bytes()));
        Some(Self {
            identity: format!("dir:{}", &digest[..12]),
            canonical,
        })
    }

    /// A project is the home directory when either its identity is home's or its
    /// directory canonicalizes to home (the two can disagree: an identity alone
    /// cannot tell a symlinked home apart, and a card may carry no path at all).
    pub(crate) fn matches(&self, identity: &str, display_path: &str) -> bool {
        if identity == self.identity {
            return true;
        }
        fs::canonicalize(Path::new(display_path))
            .map(|canonical_display| canonical_display == self.canonical)
            .unwrap_or(false)
    }
}

fn is_user_home_workspace_member(identity: &str, display_path: &str) -> bool {
    HomeProject::resolve().is_some_and(|home| home.matches(identity, display_path))
}

fn temporary_display_name(
    workspace_id: i64,
    now: i64,
    index: usize,
    occupied: &mut HashSet<String>,
) -> String {
    for attempt in 0usize.. {
        let candidate = format!("__magic_context_tmp_{workspace_id}_{now}_{index}_{attempt}");
        if occupied.insert(candidate.clone()) {
            return candidate;
        }
    }
    unreachable!("unbounded temp-name loop must return")
}
