//! One legacy key's pool of project rows, moved to the one project that
//! claims its folder, or copied to every project that does, in one
//! transaction.

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::types::Value;
use rusqlite::{params, Connection, TransactionBehavior};

use super::memories;
use super::store::{self, Row, Table};

/// Rows changed per table.
pub(crate) type Rows = BTreeMap<String, u64>;

/// What became of a pool.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Outcome {
    /// Rows changed, per project they went to.
    Done(BTreeMap<String, Rows>),
    /// Nothing was left to move: the pool was moved or copied before.
    Nothing,
    /// The pool was left as it is.
    Held(Held),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Held {
    /// The key or a project is still guarded for the removed Rust
    /// transform mode (`authority_managed`, `authority_repair_pending`),
    /// whose triggers refuse note writes. The 0.49 merge refused these too.
    RustManaged(String),
    /// The keys and their project belong to different workspaces, and a
    /// project can be in only one. The 0.49 merge refused these too.
    Workspaces(BTreeSet<i64>),
}

/// Tables a contested key's rows are copied from: knowledge about the
/// project, which each project the folder belongs to should have. The
/// embedding bookkeeping goes with the copied memory vectors, so each
/// project's copies count as embedded. Notes are copied only when they are
/// not a session's own.
const COPIED: &[&str] = &[
    "embedding_identity_active",
    "embedding_registrations",
    "memory_embedding_watermarks",
    "memory_journal",
    "notes",
    "primers",
    "project_key_files",
    "project_key_files_version",
    "retrospective_processed_windows",
];

/// Moved to the first project of a contested key and not copied: a commit's
/// sha is its table's primary key, so it can't belong to two projects. The
/// other projects can't hold those commits until the schema allows it.
const FIRST_ONLY: &[&str] = &["git_commits"];

/// Left under a contested key: one session's state, mappings and caches
/// (a session ran in one folder, and no row says which project's folder
/// that was), per-project caches each project builds for itself, workspace
/// membership (a project is in one workspace, under a unique display name),
/// and the removed Rust transform mode's bookkeeping. The copy leaves every
/// table outside [`COPIED`] and [`FIRST_ONLY`]; this list names the ones
/// sorted on purpose, and a test fails when a table is in no list.
#[cfg(test)]
pub(super) const LEFT: &[&str] = &[
    "authority_capture_bounds",
    "authority_managed",
    "authority_repair_pending",
    "compartment_chunk_embeddings",
    "domain_mutation_epoch",
    "embedding_measurement_corpus",
    "git_sweep_coordinator",
    "memory_activity_ledger",
    "memory_agent_fragments",
    "memory_applied_rows",
    "memory_applied_snapshots",
    "memory_classification_items",
    "memory_decision_receipts",
    "memory_observations",
    "memory_pending_facts",
    "memory_publications",
    "memory_stage_attempts",
    "memory_tool_proposals",
    "mural_manifest",
    "primer_candidates",
    "project_state",
    "rescore_jobs",
    "session_projects",
    "shadow_embedding_registrations",
    "synapse_batch_ledger",
    "workspace_members",
];

/// The tables a contested key's rows are copied from and moved from.
#[cfg(test)]
pub(super) fn contested_tables() -> (&'static [&'static str], &'static [&'static str]) {
    (COPIED, FIRST_ONLY)
}

/// Which of a table's rows count as knowledge: a session's own notes don't.
fn knowledge_filter(table: &str) -> &'static str {
    if table == "notes" {
        "type IS NOT 'session'"
    } else {
        "1"
    }
}

fn rust_managed(conn: &Connection, keys: &[&str]) -> rusqlite::Result<Option<String>> {
    for table in ["authority_managed", "authority_repair_pending"] {
        if !store::table_exists(conn, table)? {
            continue;
        }
        for key in keys {
            let found: bool = conn.query_row(
                &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE project_path = ?1)"),
                [key],
                |row| row.get(0),
            )?;
            if found {
                return Ok(Some((*key).to_owned()));
            }
        }
    }
    Ok(None)
}

fn workspaces(conn: &Connection, keys: &BTreeSet<&str>) -> rusqlite::Result<BTreeSet<i64>> {
    if !store::table_exists(conn, "workspace_members")? {
        return Ok(BTreeSet::new());
    }
    conn.prepare(
        "SELECT DISTINCT workspace_id FROM workspace_members
          WHERE project_path IN (SELECT value FROM json_each(?1))",
    )?
    .query_map(
        [serde_json::to_string(keys).expect("keys serialize")],
        |row| row.get(0),
    )?
    .collect()
}

/// After rows reach a project: the 0.49 merge's alias record for the old key
/// (`v22_identity_rekey_map`, which workspace reads follow), when the key
/// went to one project, and a fresh git sweep for each project.
fn after_rows(
    conn: &Connection,
    from: &str,
    single: Option<&str>,
    targets: &[&str],
    now: i64,
) -> rusqlite::Result<()> {
    if let Some(to) = single {
        if store::table_exists(conn, "v22_identity_rekey_map")? {
            conn.execute(
                "INSERT INTO v22_identity_rekey_map (old_project_path, new_project_path, rekeyed_at)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(old_project_path) DO UPDATE SET
                     new_project_path = excluded.new_project_path,
                     rekeyed_at = excluded.rekeyed_at",
                params![from, to, now],
            )?;
        }
    }
    if store::table_exists(conn, "git_sweep_coordinator")? {
        for to in targets {
            conn.execute(
                "UPDATE git_sweep_coordinator
                    SET lease_holder = NULL, lease_expires_at = NULL, last_swept_at = NULL
                  WHERE project_path = ?1",
                [to],
            )?;
        }
    }
    // Sessions of these projects are not told. Each view a session builds
    // reads its project's memories again, and the history head compares
    // them with what it already shows (`summary::head::delta`): memories it
    // hasn't shown appear in `m[1]`, the head's second message, on the next
    // pass that already has permission to rebuild. A change made outside a
    // session never forces a rebuild of its own, so nothing here marks a
    // fold or bumps a memory epoch.
    Ok(())
}

/// Move every row of `from` to `to`: the key's folders belong to `to` alone.
/// `group` holds every legacy key moving to `to`; all of them and `to` must
/// share one workspace, since membership moves too.
pub(crate) fn move_pool(
    conn: &mut Connection,
    from: &str,
    to: &str,
    group: &BTreeSet<String>,
    now: i64,
) -> rusqlite::Result<Outcome> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if let Some(key) = rust_managed(&tx, &[from, to])? {
        return Ok(Outcome::Held(Held::RustManaged(key)));
    }
    let mut members: BTreeSet<&str> = group.iter().map(String::as_str).collect();
    members.insert(from);
    members.insert(to);
    let found = workspaces(&tx, &members)?;
    if found.len() > 1 {
        return Ok(Outcome::Held(Held::Workspaces(found)));
    }
    let mut rows = Rows::new();
    let moved = memories::move_all(&tx, from, to, now)?;
    if moved > 0 {
        rows.insert("memories".into(), moved);
    }
    for table in store::discover(&tx)? {
        let changed = store::move_rows(&tx, &table, "1", from, to, now)?;
        if changed > 0 {
            rows.insert(table.name.clone(), changed);
        }
    }
    if rows.is_empty() {
        return Ok(Outcome::Nothing);
    }
    after_rows(&tx, from, Some(to), &[to], now)?;
    tx.commit()?;
    Ok(Outcome::Done(BTreeMap::from([(to.to_owned(), rows)])))
}

/// Copy the knowledge rows of `from` to every one of `targets`, which all
/// claim the key's folders. The originals move to the first target by id,
/// keeping their ids (sync records and the rows left behind name them);
/// every other target gets its own copies with new ids. Rows of one session
/// stay under the key. A project registered later gets nothing: the pool is
/// copied once, to the projects that claim the key when it is.
pub(crate) fn copy_pool(
    conn: &mut Connection,
    from: &str,
    targets: &BTreeSet<String>,
    now: i64,
) -> rusqlite::Result<Outcome> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut keys: Vec<&str> = vec![from];
    keys.extend(targets.iter().map(String::as_str));
    if let Some(key) = rust_managed(&tx, &keys)? {
        return Ok(Outcome::Held(Held::RustManaged(key)));
    }
    let mut ordered = targets.iter();
    let Some(first) = ordered.next() else {
        return Ok(Outcome::Nothing);
    };
    let tables: Vec<Table> = store::discover(&tx)?;
    let named = |list: &[&str]| -> Vec<&Table> {
        tables
            .iter()
            .filter(|table| list.contains(&table.name.as_str()))
            .collect()
    };
    let mut done: BTreeMap<String, Rows> = BTreeMap::new();
    for to in ordered {
        let copied = memories::copy_all(&tx, from, to, now)?;
        let mut rows = copied.rows;
        for table in named(COPIED) {
            let ids = &copied.ids;
            let changed = store::copy_rows(
                &tx,
                table,
                knowledge_filter(&table.name),
                from,
                to,
                now,
                |row: &Row| copy_adjustments(&table.name, row, to, ids),
            )?;
            if changed > 0 {
                *rows.entry(table.name.clone()).or_default() += changed;
            }
        }
        rows.retain(|_, count| *count > 0);
        if !rows.is_empty() {
            done.insert(to.clone(), rows);
        }
    }
    let mut rows = Rows::new();
    let moved = memories::move_all(&tx, from, first, now)?;
    if moved > 0 {
        rows.insert("memories".into(), moved);
    }
    for table in named(COPIED).into_iter().chain(named(FIRST_ONLY)) {
        let changed =
            store::move_rows(&tx, table, knowledge_filter(&table.name), from, first, now)?;
        if changed > 0 {
            rows.insert(table.name.clone(), changed);
        }
    }
    if !rows.is_empty() {
        done.insert(first.clone(), rows);
    }
    if done.is_empty() {
        return Ok(Outcome::Nothing);
    }
    let reached: Vec<&str> = done.keys().map(String::as_str).collect();
    after_rows(&tx, from, None, &reached, now)?;
    tx.commit()?;
    Ok(Outcome::Done(done))
}

/// What a copied row changes besides its project, so the copy stays valid
/// beside the original: a journal entry's decision key is unique, and an
/// embedding watermark names memory ids, which are the copies' now.
fn copy_adjustments(
    table: &str,
    row: &Row,
    to: &str,
    ids: &BTreeMap<i64, i64>,
) -> Vec<(&'static str, Value)> {
    match table {
        "memory_journal" => vec![(
            "decision_key",
            Value::Text(format!(
                "{}@{to}",
                row.text("decision_key").unwrap_or_default()
            )),
        )],
        "memory_embedding_watermarks" => ["written_memory_id", "embedded_memory_id"]
            .into_iter()
            .map(|column| {
                // Every memory up to the watermark is covered, so the copy's
                // watermark is the newest copy of a memory up to it.
                let value = match row.int(column) {
                    Some(mark) => Value::Integer(
                        ids.range(..=mark)
                            .map(|(_, copy)| *copy)
                            .max()
                            .unwrap_or(mark),
                    ),
                    None => Value::Null,
                };
                (column, value)
            })
            .collect(),
        _ => Vec::new(),
    }
}
