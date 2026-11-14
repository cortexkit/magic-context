//! One legacy key's pool of project rows, moved to the one project that
//! claims its folder, or copied to every project that does, in bounded
//! batches ([`BATCH`]), each in its own transaction.

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
    /// The keys and their project belong to different workspaces, and a
    /// project can be in only one. The 0.49 merge refused these too.
    Workspaces(BTreeSet<i64>),
}

/// Tables a contested key's rows are copied from: knowledge about the
/// project, which each project the folder belongs to should have. The
/// embedding bookkeeping goes with the copied memory vectors, so each
/// project's copies count as embedded; a commit's copy takes the commit's
/// vectors along for the same reason. Notes are copied only when they are
/// not a session's own.
const COPIED: &[&str] = &[
    "embedding_identity_active",
    "embedding_registrations",
    "git_commits",
    "memory_embedding_watermarks",
    "memory_journal",
    "notes",
    "primers",
    "project_key_files",
    "project_key_files_version",
    "retrospective_processed_windows",
];

/// Left under a contested key: one session's state, mappings and caches
/// (a session ran in one folder, and no row says which project's folder
/// that was), per-project caches each project builds for itself, workspace
/// membership (a project is in one workspace, under a unique display
/// name). The copy leaves every table outside [`COPIED`]; this list names
/// the ones sorted on purpose, and a test fails when a table is in no list.
#[cfg(test)]
pub(super) const LEFT: &[&str] = &[
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

/// The tables a contested key's rows are copied from.
#[cfg(test)]
pub(super) fn contested_tables() -> &'static [&'static str] {
    COPIED
}

/// Which of a table's rows count as knowledge: a session's own notes don't.
fn knowledge_filter(table: &str) -> &'static str {
    if table == "notes" {
        "type IS NOT 'session'"
    } else {
        "1"
    }
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

/// After a batch of rows reaches a project: the 0.49 merge's alias record
/// for the old key (`v22_identity_rekey_map`, which workspace reads follow)
/// when the key goes to one project, and a fresh git sweep for each
/// project. Every batch writes both, so a pool cut short by a restart still
/// has them; a batch that finds nothing left writes neither.
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
    // hasn't shown appear in the head's second message on the next rebuild
    // the session is already allowed to make. A change made outside a
    // session must never cause a prompt rebuild of its own, so nothing here
    // asks for one.
    Ok(())
}

/// How many source rows one transaction handles at most: memories and rows
/// of other tables alike, each with what hangs off it, for every target. A
/// pool's transaction holds the shared `context.db` connection, which every
/// live session's notices and views wait on, so a large pool is settled in
/// batches of this size, each in its own transaction. On Linux a batch of
/// copied memories holds the connection for tens of milliseconds, where a
/// whole pool of 5,000 held it for about 1.4 s (`pool_size_tests`).
pub(crate) const BATCH: usize = 100;

fn add(done: &mut BTreeMap<String, Rows>, to: &str, table: &str, count: u64) {
    if count > 0 {
        *done
            .entry(to.to_owned())
            .or_default()
            .entry(table.to_owned())
            .or_default() += count;
    }
}

/// What one pool's batches carry from one to the next within a round, so a
/// batch costs the same however far along the pool is: the project-keyed
/// tables, what each target held of its own, and each extra target's
/// copies. It is read from the store at the round's first batch and dropped
/// when the pool is settled, held or fails, so no batch trusts what a failed
/// (rolled back) batch left in it.
#[derive(Default)]
pub(crate) struct Progress {
    tables: Option<Vec<Table>>,
    own: BTreeMap<String, std::sync::Arc<memories::Own>>,
    copies: BTreeMap<String, memories::Copies>,
}

impl Progress {
    fn tables(&mut self, conn: &Connection) -> rusqlite::Result<Vec<Table>> {
        if self.tables.is_none() {
            self.tables = Some(store::discover(conn)?);
        }
        Ok(self.tables.clone().unwrap_or_default())
    }

    fn own(
        &mut self,
        conn: &Connection,
        from: &str,
        to: &str,
    ) -> rusqlite::Result<std::sync::Arc<memories::Own>> {
        if !self.own.contains_key(to) {
            let own = memories::Own::load(conn, from, to)?;
            self.own.insert(to.to_owned(), std::sync::Arc::new(own));
        }
        Ok(std::sync::Arc::clone(&self.own[to]))
    }

    fn copies(
        &mut self,
        conn: &Connection,
        from: &str,
        to: &str,
    ) -> rusqlite::Result<&mut memories::Copies> {
        if !self.copies.contains_key(to) {
            let loaded = memories::Copies::load(conn, from, to)?;
            self.copies.insert(to.to_owned(), loaded);
        }
        Ok(self.copies.get_mut(to).expect("loaded above"))
    }
}

/// One batch of moving the rows of `from` to `to`, whose folders belong to
/// `to` alone: at most `limit` rows, in one transaction. `group` holds every
/// legacy key moving to `to`; all of them and `to` must share one workspace,
/// since membership moves too. `Nothing` means nothing is left. A batch
/// moves whole rows, so the next one, in this process or after a restart,
/// starts where it ended.
pub(crate) fn move_step(
    conn: &mut Connection,
    progress: &mut Progress,
    from: &str,
    to: &str,
    group: &BTreeSet<String>,
    now: i64,
    limit: usize,
) -> rusqlite::Result<Outcome> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut members: BTreeSet<&str> = group.iter().map(String::as_str).collect();
    members.insert(from);
    members.insert(to);
    let found = workspaces(&tx, &members)?;
    if found.len() > 1 {
        return Ok(Outcome::Held(Held::Workspaces(found)));
    }
    let mut done = BTreeMap::new();
    let mut left = limit;
    let sources = memories::batch(&tx, from, left)?;
    if !sources.is_empty() {
        let own = progress.own(&tx, from, to)?;
        memories::move_some(&tx, from, to, &sources, &own, now)?;
        add(&mut done, to, "memories", sources.len() as u64);
        left -= sources.len();
    }
    for table in &progress.tables(&tx)? {
        if left == 0 {
            break;
        }
        let rows = store::batch(&tx, table, "1", from, left)?;
        for row in &rows {
            store::move_row(&tx, table, row, from, to, now)?;
        }
        add(&mut done, to, &table.name, rows.len() as u64);
        left -= rows.len();
    }
    if done.is_empty() {
        return Ok(Outcome::Nothing);
    }
    after_rows(&tx, from, Some(to), &[to], now)?;
    tx.commit()?;
    Ok(Outcome::Done(done))
}

/// One batch of copying the knowledge rows of `from` to every one of
/// `targets`, which all claim the key's folders: at most `limit` source
/// rows, in one transaction. The originals move to the first target by id,
/// keeping their ids (sync records and the rows left behind name them);
/// every other target gets its own copies with new ids. A source is copied
/// and moved in the same batch, so it is never copied twice. Rows of one
/// session stay under the key. A project registered later gets nothing: the
/// pool is copied once, to the projects that claim the key when it is.
pub(crate) fn copy_step(
    conn: &mut Connection,
    progress: &mut Progress,
    from: &str,
    targets: &BTreeSet<String>,
    now: i64,
    limit: usize,
) -> rusqlite::Result<Outcome> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut ordered = targets.iter();
    let Some(first) = ordered.next() else {
        return Ok(Outcome::Nothing);
    };
    let extras: Vec<&String> = ordered.collect();
    let mut done: BTreeMap<String, Rows> = BTreeMap::new();
    let mut left = limit;
    let sources = memories::batch(&tx, from, left)?;
    if !sources.is_empty() {
        let ids: Vec<i64> = sources.iter().filter_map(|row| row.int("id")).collect();
        for to in &extras {
            let own = progress.own(&tx, from, to)?;
            // Read before this batch's copies exist, which `record` adds.
            let copies = progress.copies(&tx, from, to)?;
            let (copied, made) = memories::copy_some(&tx, from, to, &sources, &own, now)?;
            copies.record(&tx, &made)?;
            let linked = memories::copy_links(&tx, from, to, &ids, &copies.map, now)?;
            for (table, count) in copied.into_iter().chain(linked) {
                add(&mut done, to, &table, count);
            }
        }
        let own = progress.own(&tx, from, first)?;
        memories::move_some(&tx, from, first, &sources, &own, now)?;
        add(&mut done, first, "memories", sources.len() as u64);
        left -= sources.len();
    }
    let tables = progress.tables(&tx)?;
    let knowledge: Vec<&Table> = tables
        .iter()
        .filter(|table| COPIED.contains(&table.name.as_str()))
        .collect();
    for table in &knowledge {
        if left == 0 {
            break;
        }
        let rows = store::batch(&tx, table, knowledge_filter(&table.name), from, left)?;
        if rows.is_empty() {
            continue;
        }
        let vectors = if table.name == "git_commits" {
            commit_vectors(&tx)?
        } else {
            None
        };
        for to in &extras {
            // Memories come first, so a copied watermark can name the
            // copies every memory batch before it made.
            let ids = if table.name == "memory_embedding_watermarks" {
                progress.copies(&tx, from, to)?.map.clone()
            } else {
                BTreeMap::new()
            };
            for row in &rows {
                let adjusted = copy_adjustments(&table.name, row, to, &ids);
                store::copy_row(&tx, table, row, from, to, now, adjusted)?;
                if let Some(vectors) = &vectors {
                    let copied = copy_commit_vectors(&tx, vectors, row, from, to, now)?;
                    add(&mut done, to, &vectors.name, copied);
                }
            }
            add(&mut done, to, &table.name, rows.len() as u64);
        }
        // A moved commit's vectors follow it through their foreign key.
        for row in &rows {
            store::move_row(&tx, table, row, from, first, now)?;
        }
        add(&mut done, first, &table.name, rows.len() as u64);
        left -= rows.len();
    }
    if done.is_empty() {
        return Ok(Outcome::Nothing);
    }
    let reached: Vec<&str> = targets.iter().map(String::as_str).collect();
    after_rows(&tx, from, None, &reached, now)?;
    tx.commit()?;
    Ok(Outcome::Done(done))
}

/// The table of commit vectors, when the store has one.
fn commit_vectors(conn: &Connection) -> rusqlite::Result<Option<Table>> {
    if !store::table_exists(conn, "git_commit_embeddings")? {
        return Ok(None);
    }
    store::shape(conn, "git_commit_embeddings", "project_path", None).map(Some)
}

/// Copy the vectors of `commit`, a commit of `from`, to `to`'s row of the
/// same commit, which the copy just made or `to` already had. A vector `to`
/// already has for a model stays as it is. Returns the vectors copied.
fn copy_commit_vectors(
    conn: &Connection,
    vectors: &Table,
    commit: &Row,
    from: &str,
    to: &str,
    now: i64,
) -> rusqlite::Result<u64> {
    let sha = commit.get("sha");
    let mut copied = 0;
    for vector in store::rows(
        conn,
        vectors,
        "project_path = ? AND sha = ?",
        &[Value::Text(from.to_owned()), sha.clone()],
    )? {
        let held = conn
            .prepare_cached(
                "SELECT 1 FROM git_commit_embeddings
                  WHERE project_path = ?1 AND sha = ?2 AND model_id = ?3",
            )?
            .exists(params![to, sha, vector.get("model_id")])?;
        if held {
            continue;
        }
        let key = store::row_key(vectors, &vector);
        let made = store::insert_copy(
            conn,
            vectors,
            &vector,
            &[("project_path", Value::Text(to.to_owned()))],
        )?;
        store::log(
            conn,
            from,
            to,
            &vectors.name,
            &key,
            "copied",
            Some(&made),
            now,
        )?;
        copied += 1;
    }
    Ok(copied)
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
