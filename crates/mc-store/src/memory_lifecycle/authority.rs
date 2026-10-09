//! Which side may write a project's memories: the TypeScript host or this module.
//!
//! The TypeScript applier (`tsOwnsMemory` in
//! `packages/plugin/src/features/magic-context/memory/lifecycle-applier.ts`) and the
//! `context.db` guard triggers treat a project as module-owned when it has a row in
//! `authority_managed` or `authority_repair_pending`. Those markers belong to the legacy
//! two-store hand-over, and the single-store migration empties both tables. The module
//! therefore decides ownership in two regimes:
//!
//! - **Legacy authority armed** (either marker table holds any row): only a marked project
//!   is module-owned. An unmarked project is TypeScript-owned, and the module writes none of
//!   its memories.
//! - **Single store** (both marker tables absent or empty): `context.db` is the only copy
//!   and the module is the writer the host routes to, but only when `context.db` itself
//!   records `single_store_state = 'migrated'`. Anything else is refused. The module only
//!   attaches migrated stores today; the check is repeated here so that a later change to
//!   how stores are attached cannot silently widen the module's write authority.
//!
//! Every module memory write passes this one predicate: the applier asks it before
//! writing and records `authority_elsewhere` when it fails, and
//! [`install_module_memory_authority_guard`] puts the same predicate on the module's
//! `context.db` connection as temporary triggers, so a memory write that bypasses the
//! applier aborts instead of landing.

use rusqlite::Connection;

/// The SQLite error message the connection guard raises.
pub const MODULE_MEMORY_AUTHORITY_ELSEWHERE: &str = "module_memory_authority_elsewhere";

fn table_exists(conn: &Connection, table: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = ?1)",
        [table],
        |row| row.get(0),
    )
}

/// The ownership predicate as an SQL expression over `project`, given which of the
/// tables it reads exist. A missing marker table counts as empty; a missing
/// `single_store_state` counts as not migrated.
fn predicate_sql(
    project: &str,
    managed: bool,
    repair_pending: bool,
    single_store_state: bool,
) -> String {
    let mut marked = Vec::new();
    let mut armed = Vec::new();
    if managed {
        marked.push(format!(
            "EXISTS(SELECT 1 FROM main.authority_managed WHERE project_path = {project})"
        ));
        armed.push("EXISTS(SELECT 1 FROM main.authority_managed)".to_string());
    }
    if repair_pending {
        marked.push(format!(
            "EXISTS(SELECT 1 FROM main.authority_repair_pending WHERE project_path = {project})"
        ));
        armed.push("EXISTS(SELECT 1 FROM main.authority_repair_pending)".to_string());
    }
    let migrated = if single_store_state {
        "EXISTS(SELECT 1 FROM main.single_store_state WHERE id = 1 AND state = 'migrated')"
    } else {
        "0"
    };
    let marked = if marked.is_empty() {
        "0".to_string()
    } else {
        marked.join(" OR ")
    };
    let unarmed = if armed.is_empty() {
        "1".to_string()
    } else {
        format!("NOT ({})", armed.join(" OR "))
    };
    format!("(({marked}) OR (({unarmed}) AND {migrated}))")
}

fn current_predicate(conn: &Connection, project: &str) -> rusqlite::Result<String> {
    Ok(predicate_sql(
        project,
        table_exists(conn, "authority_managed")?,
        table_exists(conn, "authority_repair_pending")?,
        table_exists(conn, "single_store_state")?,
    ))
}

/// Whether the module is the memory authority for `project_path` in this `context.db`.
pub fn module_owns_memory(conn: &Connection, project_path: &str) -> rusqlite::Result<bool> {
    let predicate = current_predicate(conn, "?1")?;
    conn.query_row(&format!("SELECT {predicate}"), [project_path], |row| {
        row.get::<_, bool>(0)
    })
}

/// Install the ownership predicate on `conn` as temporary triggers on `memories`.
///
/// Temporary triggers live only on this connection: they are not stored in the file, so
/// the host never sees them and the schema fingerprints do not change. A memory insert,
/// update or delete for a project the module does not own aborts with
/// [`MODULE_MEMORY_AUTHORITY_ELSEWHERE`]. A database without a `memories` table gets no
/// guard, because there is nothing to protect.
pub fn install_module_memory_authority_guard(conn: &Connection) -> rusqlite::Result<()> {
    if !table_exists(conn, "memories")? {
        return Ok(());
    }
    let owns_new = current_predicate(conn, "NEW.project_path")?;
    let owns_old = current_predicate(conn, "OLD.project_path")?;
    let raise = format!("SELECT RAISE(ABORT, '{MODULE_MEMORY_AUTHORITY_ELSEWHERE}')");
    conn.execute_batch(&format!(
        "DROP TRIGGER IF EXISTS temp.module_memory_authority_insert;
         DROP TRIGGER IF EXISTS temp.module_memory_authority_update;
         DROP TRIGGER IF EXISTS temp.module_memory_authority_delete;
         CREATE TEMP TRIGGER module_memory_authority_insert BEFORE INSERT ON main.memories
           WHEN NOT {owns_new} BEGIN {raise}; END;
         CREATE TEMP TRIGGER module_memory_authority_update BEFORE UPDATE ON main.memories
           WHEN NOT ({owns_old} AND {owns_new}) BEGIN {raise}; END;
         CREATE TEMP TRIGGER module_memory_authority_delete BEFORE DELETE ON main.memories
           WHEN NOT {owns_old} BEGIN {raise}; END;"
    ))
}

/// Whether `error` is the connection guard's refusal.
pub fn is_authority_refusal(error: &rusqlite::Error) -> bool {
    error
        .to_string()
        .contains(MODULE_MEMORY_AUTHORITY_ELSEWHERE)
}
