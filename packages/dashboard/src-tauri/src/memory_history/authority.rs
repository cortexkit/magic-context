use rusqlite::Connection;

fn table_exists(conn: &Connection, table: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = ?1)",
        [table],
        |row| row.get(0),
    )
}

// Missing marker tables count as empty; missing single_store_state is not migrated.
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

pub(super) fn module_owns_memory(conn: &Connection, project_path: &str) -> rusqlite::Result<bool> {
    let predicate = predicate_sql(
        "?1",
        table_exists(conn, "authority_managed")?,
        table_exists(conn, "authority_repair_pending")?,
        table_exists(conn, "single_store_state")?,
    );
    conn.query_row(&format!("SELECT {predicate}"), [project_path], |row| {
        row.get(0)
    })
}
