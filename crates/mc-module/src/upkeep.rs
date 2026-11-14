//! Project upkeep: the background work a project needs while its sessions run
//! under ck-mc, as the standalone plugin's maintenance timer does it
//! (`dream-timer.ts`, `runProjectMaintenance`):
//!
//! - one batch of the project's active memories that have no vector for the
//!   configured embedding model, so `ctx_search` and the memory hint find
//!   them by meaning;
//! - when `memory.git_commit_indexing.enabled`, a sweep of new commits on the
//!   project's HEAD into `git_commits` (the `ctx_search` commit source), then
//!   their vectors.
//!
//! Both write `context.db`, which the standalone plugin writes too. Vectors are
//! saved under the model id the plugin uses for memories and commits, so each
//! side reads the other's. A git sweep takes the plugin's own per-project lease
//! and cooldown (`git_sweep_coordinator`, `sweep-coordinator.ts`), so one
//! process sweeps a project at a time, whichever it is. A memory batch needs no
//! lease: a vector is saved only while the memory still has the text it was
//! computed from, so a duplicate run costs one request and changes nothing.
//!
//! History chunks use the plugin's canonical raw conversation and windows,
//! but only for sessions the module currently owns in this project.
//! The plugin's scheduled model tasks (verifying, curating and classifying
//! memories) remain separate.
//!
//! The database lock is never held across a request or a git run: rows are
//! read, the lock released, the slow work done, and the results written in a
//! fresh transaction that re-checks what it depends on.

use std::collections::HashSet;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

use crate::context_db::ContextDb;
use crate::embedding::{encode, Provider};

/// How often a project's upkeep runs: the plugin's maintenance cadence.
pub const INTERVAL: Duration = Duration::from_secs(15 * 60);
/// How long after start the first run waits, so a restart's Setups and their
/// first reads are not competing with upkeep writes.
pub const BOOT_QUIET: Duration = Duration::from_secs(30);
/// A project with no Setup or notice for this long gets no more upkeep, so a
/// project nobody works in stops costing embedding requests and git runs.
pub const PROJECT_TTL_MS: i64 = 60 * 60_000;

/// Memories embedded per run (`embedUnembeddedMemoriesForProject`).
const MEMORY_BATCH: usize = 10;
/// Commits embedded per request, and the most one sweep embeds
/// (`COMMIT_DRAIN_BATCH_SIZE`, `COMMIT_DRAIN_MAX_PER_SWEEP`).
const COMMIT_BATCH: usize = 16;
const COMMIT_DRAIN_MAX: usize = 500;
/// The longest one sweep spends embedding commits
/// (`GIT_COMMIT_BACKLOG_DRAIN_MAX_MS`).
const COMMIT_DRAIN_DEADLINE: Duration = Duration::from_secs(5 * 60);

/// The shared lease's timing, from `sweep-coordinator.ts`. A successful sweep
/// starts a ten-minute cooldown for every process; a lease is crash recovery
/// and is renewed after each embedding batch, well inside its five minutes.
const SWEEP_COOLDOWN_MS: i64 = 10 * 60_000;
const LEASE_TTL_MS: i64 = 5 * 60_000;
/// A folder that is not a repository, or has no commits yet, is probed again
/// after a day instead of failing the same way every run.
const NON_INDEXABLE_REPROBE_MS: i64 = 24 * 60 * 60_000;

/// `git log`'s time limit and the most output it may produce
/// (`git-log-reader.ts`).
const GIT_TIMEOUT: Duration = Duration::from_secs(10);
const GIT_MAX_OUTPUT: usize = 32 * 1024 * 1024;
const RECORD_SEPARATOR: char = '\u{1e}';
const FIELD_SEPARATOR: char = '\u{1f}';
const DAY_MS: i64 = 86_400_000;

/// What one project's upkeep does, from its configuration.
#[derive(Clone, Debug, Default)]
pub struct Plan {
    /// `memory.enabled`: embed the project's memories.
    pub memory: bool,
    /// The configured remote embedding provider; without one no vectors are
    /// computed, and search uses its word lanes.
    pub embedding: Option<Provider>,
    /// Commit indexing, when `memory.git_commit_indexing.enabled`.
    pub git: Option<GitIndexing>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GitIndexing {
    pub since_days: u64,
    pub max_commits: u64,
}

impl Plan {
    pub fn from_settings(settings: &crate::pass::Settings) -> Self {
        Self {
            memory: settings.memory_enabled,
            embedding: settings.embedding.clone(),
            git: settings.git_commits_enabled.then_some(GitIndexing {
                since_days: settings.git_since_days,
                max_commits: settings.git_max_commits,
            }),
        }
    }
}

/// What one run did, for its log line and tests.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Report {
    pub memories_embedded: usize,
    pub chunks_embedded: usize,
    pub sweep: Option<Sweep>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Sweep {
    /// Another process holds the project's lease.
    LeaseHeld,
    /// A sweep finished less than ten minutes ago, here or elsewhere.
    Cooldown,
    /// The folder has no commits to index; probed again in a day.
    Parked,
    Indexed {
        scanned: usize,
        inserted: usize,
        updated: usize,
        evicted: usize,
        embedded: usize,
    },
    /// Git or the database failed; the lease is released without a cooldown,
    /// so the next run tries again.
    Failed(String),
}

/// One upkeep run for a project. `clock` gives the time in milliseconds; the
/// lease and cooldown are compared against the times other processes write,
/// so production passes the wall clock.
pub async fn run_project(
    db: &ContextDb,
    project: &str,
    root: &Path,
    plan: &Plan,
    clock: &(impl Fn() -> i64 + Sync),
) -> Report {
    run_project_scoped(db, project, root, plan, clock, &Vec::new).await
}

/// `owned` is read again inside every chunk write transaction, so a session
/// moved to another project while the provider ran cannot leave misfiled rows.
pub(crate) async fn run_project_scoped(
    db: &ContextDb,
    project: &str,
    root: &Path,
    plan: &Plan,
    clock: &(impl Fn() -> i64 + Sync),
    owned: &(impl Fn() -> Vec<(String, String)> + Sync),
) -> Report {
    let mut report = Report::default();
    if let (true, Some(provider)) = (plan.memory, &plan.embedding) {
        report.memories_embedded = embed_memories(db, project, provider).await;
    }
    if let Some(provider) = &plan.embedding {
        report.chunks_embedded = chunks::embed(db, project, provider, clock, owned).await;
    }
    if let Some(git) = plan.git.filter(|_| !missing_root(project, root)) {
        report.sweep =
            Some(sweep_commits(db, project, root, git, plan.embedding.as_ref(), clock).await);
    }
    report
}

mod chunks;

fn missing_root(project: &str, root: &Path) -> bool {
    // Removed worktrees can remain active until their last session expires.
    // Only a missing path is quiet: permission and other filesystem errors
    // still reach git's ordinary warning path.
    let missing =
        matches!(root.metadata(), Err(error) if error.kind() == std::io::ErrorKind::NotFound);
    static MISSING: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    let mut projects = MISSING
        .get_or_init(Mutex::default)
        .lock()
        .expect("missing roots");
    if missing {
        if projects.insert(project.to_owned()) {
            tracing::info!(
                "ck-mc: skipping commit sweep for {project}: project root is missing ({})",
                root.display()
            );
        }
    } else {
        // Remember only the current absence: a restored root can be swept
        // normally, and a later removal gets one new notice.
        projects.remove(project);
    }
    missing
}

/// Embed one batch of the project's active memories that have no vector for
/// the provider's model. Returns how many vectors were saved.
async fn embed_memories(db: &ContextDb, project: &str, provider: &Provider) -> usize {
    let model_id = provider.model_id();
    let rows = db.with_connection(|conn| -> rusqlite::Result<Vec<(i64, String, String)>> {
        let mut statement = conn.prepare(
            "SELECT m.id, m.content, m.normalized_hash FROM memories m \
             LEFT JOIN memory_embeddings me ON m.id = me.memory_id AND me.model_id = ?1 \
             WHERE m.level = 'project' AND m.owner_id = ?2 AND m.status = 'active' AND me.memory_id IS NULL LIMIT ?3",
        )?;
        let rows = statement
            .query_map(params![model_id, project, MEMORY_BATCH as i64], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?
            .collect();
        rows
    });
    let rows = match rows {
        Ok(rows) if !rows.is_empty() => rows,
        Ok(_) => return 0,
        Err(error) => {
            tracing::warn!("ck-mc: upkeep could not read memories for {project}: {error}");
            return 0;
        }
    };
    let texts: Vec<String> = rows.iter().map(|(_, text, _)| text.clone()).collect();
    let Some(vectors) = provider.embed_documents(&texts).await else {
        return 0;
    };
    let saved = db.with_connection(|conn| -> rusqlite::Result<usize> {
        let transaction = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut saved = 0;
        {
            // The plugin's hash-guarded save: a memory edited while its vector
            // was computed keeps no vector, and gets one on a later run.
            let mut statement = transaction.prepare(
                "INSERT INTO memory_embeddings (memory_id, embedding, model_id) \
                 SELECT ?1, ?2, ?3 FROM memories WHERE id = ?1 AND normalized_hash = ?4 \
                 ON CONFLICT(memory_id, model_id) DO UPDATE SET embedding = excluded.embedding",
            )?;
            for ((id, _, hash), vector) in rows.iter().zip(vectors) {
                if let Some(vector) = vector {
                    saved += statement.execute(params![id, encode(&vector), model_id, hash])?;
                }
            }
        }
        transaction.commit()?;
        Ok(saved)
    });
    saved.unwrap_or_else(|error| {
        tracing::warn!("ck-mc: upkeep could not save memory vectors for {project}: {error}");
        0
    })
}

/// Index the project's new commits and embed what has no vector yet, under
/// the shared lease (`sweepGitCommits`).
async fn sweep_commits(
    db: &ContextDb,
    project: &str,
    root: &Path,
    git: GitIndexing,
    embedding: Option<&Provider>,
    clock: &(impl Fn() -> i64 + Sync),
) -> Sweep {
    let holder = format!(
        "ck-mc-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_nanos())
    );
    match db.with_connection(|conn| acquire_lease(conn, project, &holder, clock())) {
        Ok(Lease::Acquired) => {}
        Ok(Lease::Held) => return Sweep::LeaseHeld,
        Ok(Lease::Cooldown) => return Sweep::Cooldown,
        Err(error) => return Sweep::Failed(error.to_string()),
    }
    // A project known only by its folder path has no repository identity.
    if project.starts_with("dir:") {
        return park(db, project, &holder, clock);
    }
    let latest = db.with_connection(|conn| {
        conn.query_row(
            "SELECT sha FROM git_commits WHERE project_path = ?1 \
             ORDER BY committed_at DESC, sha DESC LIMIT 1",
            params![project],
            |row| row.get::<_, String>(0),
        )
        .optional()
    });
    let latest = match latest {
        Ok(latest) => latest,
        Err(error) => return fail(db, project, &holder, error.to_string()),
    };
    let since_ms = clock() - git.since_days as i64 * DAY_MS;
    let root_owned = root.to_owned();
    let max = git.max_commits;
    let read = tokio::task::spawn_blocking(move || {
        read_commits(&root_owned, since_ms, max, latest.as_deref())
    })
    .await
    .unwrap_or_else(|error| Err(GitFailure::Transient(error.to_string())));
    let commits = match read {
        Ok(commits) => commits,
        Err(GitFailure::NotARepo | GitFailure::NoHead) => return park(db, project, &holder, clock),
        Err(GitFailure::Transient(message)) => return fail(db, project, &holder, message),
    };
    let scanned = commits.len();
    let stored = db.with_connection(|conn| store_commits(conn, project, &commits, max, clock()));
    let (inserted, updated, evicted) = match stored {
        Ok(counts) => counts,
        Err(error) => return fail(db, project, &holder, error.to_string()),
    };
    let embedded = match embedding {
        Some(provider) => embed_commits(db, project, &holder, provider, clock).await,
        None => 0,
    };
    let marked = db.with_connection(|conn| mark_swept(conn, project, &holder, clock()));
    if !matches!(marked, Ok(true)) {
        // The lease lapsed while this sweep ran: the work stays, but the
        // cooldown is not advanced for a sweep another process may now run.
        let _ = db.with_connection(|conn| release_lease(conn, project, &holder));
    }
    Sweep::Indexed {
        scanned,
        inserted,
        updated,
        evicted,
        embedded,
    }
}

fn park(db: &ContextDb, project: &str, holder: &str, clock: &(impl Fn() -> i64 + Sync)) -> Sweep {
    let parked = db.with_connection(|conn| park_lease(conn, project, holder, clock()));
    if !matches!(parked, Ok(true)) {
        let _ = db.with_connection(|conn| release_lease(conn, project, holder));
    }
    Sweep::Parked
}

fn fail(db: &ContextDb, project: &str, holder: &str, message: String) -> Sweep {
    let _ = db.with_connection(|conn| release_lease(conn, project, holder));
    tracing::warn!("ck-mc: commit sweep failed for {project}: {message}");
    Sweep::Failed(message)
}

/// Embed the project's commits that have no vector, newest first, in batches,
/// renewing the lease after each. Stops at the cap, the deadline, a lost
/// lease, a failed request or a short batch.
async fn embed_commits(
    db: &ContextDb,
    project: &str,
    holder: &str,
    provider: &Provider,
    clock: &(impl Fn() -> i64 + Sync),
) -> usize {
    let model_id = provider.model_id();
    let deadline = Instant::now() + COMMIT_DRAIN_DEADLINE;
    let mut total = 0;
    while total < COMMIT_DRAIN_MAX && Instant::now() < deadline {
        let rows = db.with_connection(|conn| -> rusqlite::Result<Vec<(String, String)>> {
            let mut statement = conn.prepare(
                "SELECT c.sha, c.message FROM git_commits c \
                 LEFT JOIN git_commit_embeddings e \
                     ON e.project_path = c.project_path AND e.sha = c.sha AND e.model_id = ?1 \
                 WHERE c.project_path = ?2 AND e.sha IS NULL \
                 ORDER BY c.committed_at DESC LIMIT ?3",
            )?;
            let rows = statement
                .query_map(params![model_id, project, COMMIT_BATCH as i64], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })?
                .collect();
            rows
        });
        let Ok(rows) = rows else { break };
        if rows.is_empty() {
            break;
        }
        let texts: Vec<String> = rows.iter().map(|(_, message)| message.clone()).collect();
        let Some(vectors) = provider.embed_documents(&texts).await else {
            break;
        };
        let now = clock();
        let saved = db.with_connection(|conn| -> rusqlite::Result<usize> {
            let transaction = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let mut saved = 0;
            {
                let mut statement = transaction.prepare(
                    "INSERT INTO git_commit_embeddings (project_path, sha, embedding, model_id, created_at) \
                     VALUES (?1, ?2, ?3, ?4, ?5) \
                     ON CONFLICT(project_path, sha, model_id) DO UPDATE SET \
                     embedding = excluded.embedding, created_at = excluded.created_at",
                )?;
                for ((sha, _), vector) in rows.iter().zip(vectors) {
                    if let Some(vector) = vector {
                        saved += statement.execute(params![
                            project,
                            sha,
                            encode(&vector),
                            model_id,
                            now
                        ])?;
                    }
                }
            }
            transaction.commit()?;
            Ok(saved)
        });
        let Ok(saved) = saved else { break };
        total += saved;
        let renewed = db.with_connection(|conn| renew_lease(conn, project, holder, clock()));
        if saved == 0 || !matches!(renewed, Ok(true)) || rows.len() < COMMIT_BATCH {
            break;
        }
    }
    total
}

/// Upsert `commits` and evict the oldest past `max`, in one transaction.
/// Returns how many were inserted, updated (message changed) and evicted.
fn store_commits(
    conn: &mut Connection,
    project: &str,
    commits: &[Commit],
    max: u64,
    now: i64,
) -> rusqlite::Result<(usize, usize, usize)> {
    let transaction = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let (mut inserted, mut updated) = (0, 0);
    {
        let mut existing: std::collections::HashSet<String> = transaction
            .prepare("SELECT sha FROM git_commits WHERE project_path = ?1")?
            .query_map(params![project], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        // The plugin's upsert, per project: an unchanged message is skipped
        // by the WHERE clause, so only real changes count and fire the search
        // index's triggers. A commit another project already indexed gets a
        // row of this project's own.
        let mut statement = transaction.prepare(
            "INSERT INTO git_commits (sha, project_path, short_sha, message, author, committed_at, indexed_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
             ON CONFLICT(project_path, sha) DO UPDATE SET \
                 short_sha = excluded.short_sha, \
                 message = excluded.message, author = excluded.author, \
                 committed_at = excluded.committed_at, indexed_at = excluded.indexed_at \
             WHERE git_commits.message != excluded.message",
        )?;
        for commit in commits {
            let changes = statement.execute(params![
                commit.sha,
                project,
                &commit.sha[..7],
                commit.message,
                commit.author,
                commit.committed_at_ms,
                now
            ])?;
            if changes > 0 {
                if existing.contains(&commit.sha) {
                    updated += 1;
                } else {
                    inserted += 1;
                    existing.insert(commit.sha.clone());
                }
            }
        }
    }
    let count = |transaction: &rusqlite::Transaction| -> rusqlite::Result<usize> {
        transaction.query_row(
            "SELECT COUNT(*) FROM git_commits WHERE project_path = ?1",
            params![project],
            |row| row.get::<_, i64>(0).map(|count| count as usize),
        )
    };
    let before = count(&transaction)?;
    let mut evicted = 0;
    if before as u64 > max {
        transaction.execute(
            "DELETE FROM git_commits WHERE rowid IN (\
                 SELECT rowid FROM git_commits WHERE project_path = ?1 \
                 ORDER BY committed_at DESC, sha DESC LIMIT -1 OFFSET ?2)",
            params![project, max as i64],
        )?;
        evicted = before - count(&transaction)?;
    }
    transaction.commit()?;
    Ok((inserted, updated, evicted))
}

enum Lease {
    Acquired,
    Held,
    Cooldown,
}

/// `acquireGitSweepLease`: refused while another holder's lease is live or a
/// sweep finished less than the cooldown ago.
fn acquire_lease(
    conn: &mut Connection,
    project: &str,
    holder: &str,
    now: i64,
) -> rusqlite::Result<Lease> {
    let transaction = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let row: Option<(Option<String>, Option<i64>, Option<i64>)> = transaction
        .query_row(
            "SELECT lease_holder, lease_expires_at, last_swept_at \
             FROM git_sweep_coordinator WHERE project_path = ?1",
            params![project],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    if let Some((holder_now, expires, swept)) = row {
        if holder_now.is_some() && expires.is_some_and(|expires| expires > now) {
            return Ok(Lease::Held);
        }
        if swept.is_some_and(|swept| swept + SWEEP_COOLDOWN_MS > now) {
            return Ok(Lease::Cooldown);
        }
    }
    transaction.execute(
        "INSERT INTO git_sweep_coordinator (project_path, lease_holder, lease_expires_at, last_swept_at) \
         VALUES (?1, ?2, ?3, NULL) \
         ON CONFLICT(project_path) DO UPDATE SET \
             lease_holder = excluded.lease_holder, lease_expires_at = excluded.lease_expires_at",
        params![project, holder, now + LEASE_TTL_MS],
    )?;
    transaction.commit()?;
    Ok(Lease::Acquired)
}

/// Extend this holder's live lease; `false` when it lapsed or was taken.
fn renew_lease(
    conn: &mut Connection,
    project: &str,
    holder: &str,
    now: i64,
) -> rusqlite::Result<bool> {
    owned_update(
        conn,
        "UPDATE git_sweep_coordinator SET lease_expires_at = ?1 \
         WHERE project_path = ?2 AND lease_holder = ?3 AND lease_expires_at > ?4",
        params![now + LEASE_TTL_MS, project, holder, now],
    )
}

/// Release this holder's live lease and start the cooldown.
fn mark_swept(
    conn: &mut Connection,
    project: &str,
    holder: &str,
    now: i64,
) -> rusqlite::Result<bool> {
    owned_update(
        conn,
        "UPDATE git_sweep_coordinator SET lease_holder = NULL, lease_expires_at = NULL, last_swept_at = ?1 \
         WHERE project_path = ?2 AND lease_holder = ?3 AND lease_expires_at > ?4",
        params![now, project, holder, now],
    )
}

/// Release this holder's live lease with a cooldown that ends a day from now
/// (`parkGitSweepNonIndexable`: the sweep time is future-dated so the usual
/// cooldown arithmetic gives the long re-probe).
fn park_lease(
    conn: &mut Connection,
    project: &str,
    holder: &str,
    now: i64,
) -> rusqlite::Result<bool> {
    owned_update(
        conn,
        "UPDATE git_sweep_coordinator SET lease_holder = NULL, lease_expires_at = NULL, last_swept_at = ?1 \
         WHERE project_path = ?2 AND lease_holder = ?3 AND lease_expires_at > ?4",
        params![now + NON_INDEXABLE_REPROBE_MS - SWEEP_COOLDOWN_MS, project, holder, now],
    )
}

/// Release this holder's lease without touching the cooldown.
fn release_lease(conn: &mut Connection, project: &str, holder: &str) -> rusqlite::Result<bool> {
    owned_update(
        conn,
        "UPDATE git_sweep_coordinator SET lease_holder = NULL, lease_expires_at = NULL \
         WHERE project_path = ?1 AND lease_holder = ?2",
        params![project, holder],
    )
}

fn owned_update(
    conn: &mut Connection,
    sql: &str,
    params: impl rusqlite::Params,
) -> rusqlite::Result<bool> {
    let transaction = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let changed = transaction.execute(sql, params)? == 1;
    transaction.commit()?;
    Ok(changed)
}

/// One commit as `git log` printed it.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Commit {
    sha: String,
    /// Subject, then a blank line and the body when there is one.
    message: String,
    author: Option<String>,
    committed_at_ms: i64,
}

#[derive(Debug, PartialEq, Eq)]
enum GitFailure {
    NotARepo,
    NoHead,
    /// Git is missing, timed out or failed some other way: tried again on the
    /// next run.
    Transient(String),
}

/// `git log` on HEAD without merges, newest first, at most `max` commits, no
/// older than `since_ms`, and without history reachable from `exclude` (the
/// newest commit already indexed). A date cutoff alone would miss a merged
/// branch's commits dated before the last sweep. An excluded commit that no
/// longer exists bounds nothing, so the read is repeated without it.
fn read_commits(
    root: &Path,
    since_ms: i64,
    max: u64,
    exclude: Option<&str>,
) -> Result<Vec<Commit>, GitFailure> {
    let exclude = exclude.filter(|sha| is_object_name(sha));
    let mut args = vec!["log".to_owned(), "HEAD".to_owned()];
    if let Some(sha) = exclude {
        args.push(format!("^{sha}"));
    }
    args.extend([
        "--no-merges".to_owned(),
        format!("--max-count={max}"),
        format!("--format=%H{FIELD_SEPARATOR}%s{FIELD_SEPARATOR}%ae{FIELD_SEPARATOR}%ct{FIELD_SEPARATOR}%b{RECORD_SEPARATOR}"),
    ]);
    if since_ms > 0 {
        args.push(format!("--since={}", iso_8601(since_ms)));
    }
    // With nothing after it, `--` makes every argument above a revision, so a
    // worktree file named like one cannot make git's reading ambiguous.
    args.push("--".to_owned());
    match run_git(root, &args) {
        Ok(stdout) => Ok(parse_log(&stdout)),
        Err(message) if exclude.is_some() && message.contains("bad object") => {
            read_commits(root, since_ms, max, None)
        }
        Err(message) => Err(classify(message)),
    }
}

/// `classifyGitLogFailure`.
fn classify(message: String) -> GitFailure {
    if message.contains("not a git repository") {
        GitFailure::NotARepo
    } else if message.contains("unknown revision or path not in the working tree")
        || message.contains("does not have any commits yet")
        || message.contains("bad revision")
    {
        GitFailure::NoHead
    } else {
        GitFailure::Transient(message.chars().take(500).collect())
    }
}

/// Run git in `root` and return its standard output, or its error text. Git
/// is killed past [`GIT_TIMEOUT`]; output past [`GIT_MAX_OUTPUT`] is a
/// failure, as the plugin's buffer limit makes it.
fn run_git(root: &Path, args: &[String]) -> Result<String, String> {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        // No console window flashes on Windows (CREATE_NO_WINDOW).
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn().map_err(|error| format!("git: {error}"))?;
    let mut stdout = child.stdout.take().expect("stdout is piped");
    let mut stderr = child.stderr.take().expect("stderr is piped");
    // Both pipes are drained while git runs, so a large log cannot block it.
    let out = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.read_to_end(&mut bytes);
        bytes
    });
    let err = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stderr.read_to_end(&mut bytes);
        bytes
    });
    let deadline = Instant::now() + GIT_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Err(error) => return Err(format!("git: {error}")),
        }
    };
    let stdout = out.join().unwrap_or_default();
    let stderr = String::from_utf8_lossy(&err.join().unwrap_or_default()).into_owned();
    match status {
        None => Err("git log timed out".to_owned()),
        Some(status) if !status.success() => Err(stderr),
        Some(_) if stdout.len() > GIT_MAX_OUTPUT => Err("git log printed too much".to_owned()),
        Some(_) => Ok(String::from_utf8_lossy(&stdout).into_owned()),
    }
}

/// `parseGitLogOutput`: records end at the record separator; a body may hold
/// further field separators, so only the first four split.
fn parse_log(stdout: &str) -> Vec<Commit> {
    let mut commits = Vec::new();
    for record in stdout.split(RECORD_SEPARATOR) {
        let record = record.trim_start();
        if record.is_empty() {
            continue;
        }
        let fields: Vec<&str> = record.splitn(5, FIELD_SEPARATOR).collect();
        let [sha, subject, author, time, body] = fields[..] else {
            continue;
        };
        let (sha, subject, author, body) = (sha.trim(), subject.trim(), author.trim(), body.trim());
        let Some(seconds) = time
            .trim()
            .parse::<i64>()
            .ok()
            .filter(|seconds| *seconds > 0)
        else {
            continue;
        };
        if !is_object_name(sha) {
            continue;
        }
        commits.push(Commit {
            sha: sha.to_owned(),
            message: if body.is_empty() {
                subject.to_owned()
            } else {
                format!("{subject}\n\n{body}")
            },
            author: (!author.is_empty()).then(|| author.to_owned()),
            committed_at_ms: seconds * 1000,
        });
    }
    commits
}

/// A full object name: 40 hex digits, or 64 in a SHA-256 repository.
fn is_object_name(sha: &str) -> bool {
    matches!(sha.len(), 40 | 64)
        && sha
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// `Date.toISOString()` for a time in milliseconds, which `git log --since`
/// reads.
fn iso_8601(ms: i64) -> String {
    let (days, rest) = (ms.div_euclid(DAY_MS), ms.rem_euclid(DAY_MS));
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3_600_000,
        rest / 60_000 % 60,
        rest / 1000 % 60,
        rest % 1000
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
    use std::sync::Arc;

    fn scratch(name: &str) -> std::path::PathBuf {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "ck-mc-upkeep-{name}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn database(dir: &Path) -> ContextDb {
        ContextDb::create_for_tests(&dir.join("context.db")).unwrap()
    }

    fn git(repo: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(["-c", "user.name=Test", "-c", "user.email=test@example.com"])
            .args(["-c", "commit.gpgsign=false"])
            .args(args)
            .current_dir(repo)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?}");
    }

    fn repository(dir: &Path, subjects: &[&str]) -> std::path::PathBuf {
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q"]);
        for subject in subjects {
            git(&repo, &["commit", "-q", "--allow-empty", "-m", subject]);
        }
        repo
    }

    /// An embeddings endpoint answering one vector per input, counting
    /// requests and the inputs they carried.
    async fn endpoint() -> (String, Arc<AtomicUsize>, Arc<AtomicUsize>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (requests, inputs) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
        let (request_count, input_count) = (Arc::clone(&requests), Arc::clone(&inputs));
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut raw = Vec::new();
                let mut chunk = [0u8; 8192];
                let body = loop {
                    let read = socket.read(&mut chunk).await.unwrap_or(0);
                    if read == 0 {
                        break None;
                    }
                    raw.extend_from_slice(&chunk[..read]);
                    let text = String::from_utf8_lossy(&raw).into_owned();
                    let Some(end) = text.find("\r\n\r\n") else {
                        continue;
                    };
                    let length = text[..end]
                        .lines()
                        .find_map(|line| {
                            line.to_lowercase()
                                .strip_prefix("content-length:")
                                .map(str::to_owned)
                        })
                        .and_then(|value| value.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    if raw.len() >= end + 4 + length {
                        break Some(text[end + 4..].to_owned());
                    }
                };
                let Some(body) = body else { continue };
                let request: serde_json::Value = serde_json::from_str(&body).unwrap();
                let count = request["input"].as_array().map_or(0, Vec::len);
                request_count.fetch_add(1, Ordering::SeqCst);
                input_count.fetch_add(count, Ordering::SeqCst);
                let data: Vec<_> = (0..count)
                    .map(|index| serde_json::json!({"index": index, "embedding": [1.0, index as f64]}))
                    .collect();
                let body = serde_json::json!({"model": "mock-embed", "data": data}).to_string();
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });
        (format!("http://{address}"), requests, inputs)
    }

    fn add_memory(db: &ContextDb, project: &str, content: &str, status: &str) -> i64 {
        db.with_connection(|conn| {
            conn.execute(
                "INSERT INTO memories (level, owner_id, category, origin_category, content, normalized_hash, status, \
                 first_seen_at, created_at, updated_at, last_seen_at) \
                 VALUES ('project', ?1, 'swe:architecture', 'ARCHITECTURE', ?2, ?3, ?4, 1, 1, 1, 1)",
                params![project, content, format!("hash:{content}"), status],
            )
            .unwrap();
            conn.last_insert_rowid()
        })
    }

    fn count(db: &ContextDb, sql: &str) -> i64 {
        db.with_connection(|conn| conn.query_row(sql, [], |row| row.get(0)).unwrap())
    }

    const PROJECT: &str = "pj-upkeep";

    #[tokio::test]
    async fn missing_root_is_quiet_until_the_folder_returns() {
        let dir = scratch("missing-root");
        let db = database(&dir);
        let root = dir.join("repo");
        let project = format!("pj-missing-{}", dir.display());
        let plan = Plan {
            git: Some(GitIndexing {
                since_days: 3650,
                max_commits: 2000,
            }),
            ..Plan::default()
        };
        let logs = crate::test_log::capture();
        let skip = format!("ck-mc: skipping commit sweep for {project}: project root is missing");
        let now = 1_800_000_000_000;
        for _ in 0..3 {
            let report = run_project(&db, &project, &root, &plan, &|| now).await;
            assert_eq!(report, Report::default(), "missing roots must not run git");
        }
        assert_eq!(logs.count(&skip), 1, "{}", logs.text());
        assert_eq!(logs.count("INFO"), 1, "{}", logs.text());
        assert_eq!(logs.count("WARN"), 0, "{}", logs.text());
        assert_eq!(count(&db, "SELECT COUNT(*) FROM git_sweep_coordinator"), 0);

        repository(&dir, &["restored"]);
        let report = run_project(&db, &project, &root, &plan, &|| now).await;
        assert!(
            matches!(report.sweep, Some(Sweep::Indexed { inserted: 1, .. })),
            "{report:?}"
        );
        std::fs::remove_dir_all(&root).unwrap();
        for _ in 0..2 {
            assert_eq!(
                run_project(&db, &project, &root, &plan, &|| now).await,
                Report::default()
            );
        }
        assert_eq!(logs.count(&skip), 2, "{}", logs.text());
        assert_eq!(logs.count("INFO"), 2, "{}", logs.text());
        assert_eq!(logs.count("WARN"), 0, "{}", logs.text());
    }

    #[tokio::test]
    async fn existing_root_with_a_git_error_still_warns() {
        let dir = scratch("git-error");
        let db = database(&dir);
        let root = repository(&dir, &["first"]);
        std::fs::write(root.join(".git/config"), "[invalid config").unwrap();
        let plan = Plan {
            git: Some(GitIndexing {
                since_days: 3650,
                max_commits: 2000,
            }),
            ..Plan::default()
        };
        let logs = crate::test_log::capture();
        let report = run_project(&db, "pj-git-error", &root, &plan, &|| 1).await;
        assert!(matches!(report.sweep, Some(Sweep::Failed(_))), "{report:?}");
        assert_eq!(
            logs.count("ck-mc: commit sweep failed for pj-git-error:"),
            1,
            "{}",
            logs.text()
        );
        assert_eq!(logs.count("WARN"), 1, "{}", logs.text());
        assert_eq!(logs.count("INFO"), 0, "{}", logs.text());
    }

    #[tokio::test]
    async fn active_memories_get_vectors_under_the_plugins_model_id() {
        let dir = scratch("memories");
        let db = database(&dir);
        let (url, requests, _) = endpoint().await;
        let provider = Provider::for_test(&url, "mock-embed");
        let first = add_memory(&db, PROJECT, "The store is SQLite.", "active");
        add_memory(&db, PROJECT, "Old rule.", "archived");
        add_memory(&db, "pj-other", "Another project's rule.", "active");
        let plan = Plan {
            memory: true,
            embedding: Some(provider.clone()),
            git: None,
        };
        let report = run_project(&db, PROJECT, &dir, &plan, &|| 1_000).await;
        assert_eq!(report.memories_embedded, 1);
        let model: String = db.with_connection(|conn| {
            conn.query_row(
                "SELECT model_id FROM memory_embeddings WHERE memory_id = ?1",
                params![first],
                |row| row.get(0),
            )
            .unwrap()
        });
        assert_eq!(model, provider.model_id());
        // Nothing is left to embed, so the next run sends nothing.
        let again = run_project(&db, PROJECT, &dir, &plan, &|| 1_000).await;
        assert_eq!(again.memories_embedded, 0);
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        // Memory switched off embeds nothing.
        let second = add_memory(&db, PROJECT, "A new rule.", "active");
        let off = Plan {
            memory: false,
            ..plan
        };
        assert_eq!(
            run_project(&db, PROJECT, &dir, &off, &|| 1_000).await,
            Report::default()
        );
        assert_eq!(
            count(
                &db,
                &format!("SELECT COUNT(*) FROM memory_embeddings WHERE memory_id = {second}")
            ),
            0
        );
    }

    #[tokio::test]
    async fn a_memory_edited_while_its_vector_was_computed_keeps_none() {
        let dir = scratch("edited");
        let db = database(&dir);
        let (url, _, _) = endpoint().await;
        let id = add_memory(&db, PROJECT, "Before.", "active");
        let rows = [(id, "Before.".to_owned(), "hash:Before.".to_owned())];
        // The memory changes between the read and the save.
        db.with_connection(|conn| {
            conn.execute(
                "UPDATE memories SET content = 'After.', normalized_hash = 'hash:After.' WHERE id = ?1",
                params![id],
            )
            .unwrap()
        });
        let provider = Provider::for_test(&url, "mock-embed");
        let vectors = provider
            .embed_documents(&[rows[0].1.clone()])
            .await
            .unwrap();
        let saved = db.with_connection(|conn| {
            conn.execute(
                "INSERT INTO memory_embeddings (memory_id, embedding, model_id) \
                 SELECT ?1, ?2, ?3 FROM memories WHERE id = ?1 AND normalized_hash = ?4 \
                 ON CONFLICT(memory_id, model_id) DO UPDATE SET embedding = excluded.embedding",
                params![
                    id,
                    encode(vectors[0].as_ref().unwrap()),
                    provider.model_id(),
                    rows[0].2
                ],
            )
            .unwrap()
        });
        assert_eq!(saved, 0);
        // The next run embeds the new text.
        let plan = Plan {
            memory: true,
            embedding: Some(provider),
            git: None,
        };
        assert_eq!(
            run_project(&db, PROJECT, &dir, &plan, &|| 1)
                .await
                .memories_embedded,
            1
        );
    }

    #[tokio::test]
    async fn a_sweep_indexes_new_commits_once_per_cooldown_and_then_only_new_ones() {
        let dir = scratch("sweep");
        let db = database(&dir);
        let repo = repository(&dir, &["first", "second", "third"]);
        let now = Arc::new(AtomicI64::new(1_800_000_000_000));
        let clock = {
            let now = Arc::clone(&now);
            move || now.load(Ordering::SeqCst)
        };
        let plan = Plan {
            memory: false,
            embedding: None,
            git: Some(GitIndexing {
                since_days: 3650,
                max_commits: 2000,
            }),
        };
        let report = run_project(&db, PROJECT, &repo, &plan, &clock).await;
        assert!(
            matches!(
                report.sweep,
                Some(Sweep::Indexed {
                    scanned: 3,
                    inserted: 3,
                    updated: 0,
                    evicted: 0,
                    embedded: 0
                })
            ),
            "{report:?}"
        );
        // The commit search index picked them up through its triggers.
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM git_commits_fts WHERE git_commits_fts MATCH 'second'"
            ),
            1
        );
        // Within the cooldown nothing runs, here or in any other process.
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "fourth"]);
        now.fetch_add(SWEEP_COOLDOWN_MS - 1, Ordering::SeqCst);
        assert_eq!(
            run_project(&db, PROJECT, &repo, &plan, &clock).await.sweep,
            Some(Sweep::Cooldown)
        );
        // After it, only the new commit is stored. (The read skips history
        // reachable from the newest indexed commit; commits made within one
        // second tie on time, so which of them counts as newest falls to the
        // sha, as in the plugin, and a few known ones may be read again. The
        // upsert skips them.)
        now.fetch_add(1, Ordering::SeqCst);
        let report = run_project(&db, PROJECT, &repo, &plan, &clock).await;
        assert!(
            matches!(
                report.sweep,
                Some(Sweep::Indexed {
                    inserted: 1,
                    updated: 0,
                    ..
                })
            ),
            "{report:?}"
        );
        let message: String = db.with_connection(|conn| {
            conn.query_row(
                "SELECT message FROM git_commits ORDER BY committed_at DESC, rowid DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap()
        });
        assert_eq!(message, "fourth");
    }

    #[tokio::test]
    async fn another_processs_live_lease_is_left_alone() {
        let dir = scratch("lease");
        let db = database(&dir);
        let repo = repository(&dir, &["only"]);
        let now = 1_800_000_000_000;
        db.with_connection(|conn| {
            conn.execute(
                "INSERT INTO git_sweep_coordinator (project_path, lease_holder, lease_expires_at, last_swept_at) \
                 VALUES (?1, 'plugin-process', ?2, NULL)",
                params![PROJECT, now + 1],
            )
            .unwrap()
        });
        let plan = Plan {
            memory: false,
            embedding: None,
            git: Some(GitIndexing {
                since_days: 3650,
                max_commits: 2000,
            }),
        };
        assert_eq!(
            run_project(&db, PROJECT, &repo, &plan, &|| now).await.sweep,
            Some(Sweep::LeaseHeld)
        );
        assert_eq!(count(&db, "SELECT COUNT(*) FROM git_commits"), 0);
        // A lapsed lease is taken over.
        let report = run_project(&db, PROJECT, &repo, &plan, &|| now + 1).await;
        assert!(
            matches!(report.sweep, Some(Sweep::Indexed { inserted: 1, .. })),
            "{report:?}"
        );
    }

    #[tokio::test]
    async fn a_folder_without_commits_is_parked_for_a_day() {
        let dir = scratch("parked");
        let db = database(&dir);
        let plain = dir.join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        let plan = Plan {
            memory: false,
            embedding: None,
            git: Some(GitIndexing {
                since_days: 365,
                max_commits: 2000,
            }),
        };
        let now = 1_800_000_000_000;
        assert_eq!(
            run_project(&db, PROJECT, &plain, &plan, &|| now)
                .await
                .sweep,
            Some(Sweep::Parked)
        );
        let swept = count(&db, "SELECT last_swept_at FROM git_sweep_coordinator");
        assert_eq!(swept, now + NON_INDEXABLE_REPROBE_MS - SWEEP_COOLDOWN_MS);
        let later = now + NON_INDEXABLE_REPROBE_MS - 1;
        assert_eq!(
            run_project(&db, PROJECT, &plain, &plan, &|| later)
                .await
                .sweep,
            Some(Sweep::Cooldown)
        );
    }

    #[tokio::test]
    async fn commits_get_vectors_and_a_lowered_cap_evicts_the_oldest() {
        let dir = scratch("cap");
        let db = database(&dir);
        let repo = repository(&dir, &["one", "two", "three"]);
        let (url, requests, inputs) = endpoint().await;
        let provider = Provider::for_test(&url, "mock-embed");
        let mut plan = Plan {
            memory: false,
            embedding: Some(provider.clone()),
            git: Some(GitIndexing {
                since_days: 3650,
                max_commits: 3,
            }),
        };
        let now = 1_800_000_000_000;
        let report = run_project(&db, PROJECT, &repo, &plan, &|| now).await;
        assert!(
            matches!(
                report.sweep,
                Some(Sweep::Indexed {
                    inserted: 3,
                    evicted: 0,
                    embedded: 3,
                    ..
                })
            ),
            "{report:?}"
        );
        assert_eq!(
            count(
                &db,
                &format!(
                    "SELECT COUNT(*) FROM git_commit_embeddings WHERE model_id = '{}'",
                    provider.model_id()
                )
            ),
            3
        );
        // All three went in one request.
        assert_eq!(
            (
                requests.load(Ordering::SeqCst),
                inputs.load(Ordering::SeqCst)
            ),
            (1, 3)
        );
        // A lower cap evicts on the next sweep even with nothing new to read.
        // The three commits share one second, so the order falls to the sha,
        // as in the plugin.
        let newest_two: Vec<String> = db.with_connection(|conn| {
            let mut statement = conn
                .prepare("SELECT sha FROM git_commits ORDER BY committed_at DESC, sha DESC LIMIT 2")
                .unwrap();
            let rows = statement
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            rows
        });
        plan.git = Some(GitIndexing {
            since_days: 3650,
            max_commits: 2,
        });
        let later = now + SWEEP_COOLDOWN_MS;
        let report = run_project(&db, PROJECT, &repo, &plan, &|| later).await;
        assert!(
            matches!(
                report.sweep,
                Some(Sweep::Indexed {
                    inserted: 0,
                    evicted: 1,
                    ..
                })
            ),
            "{report:?}"
        );
        let kept: Vec<String> = db.with_connection(|conn| {
            let mut statement = conn
                .prepare("SELECT sha FROM git_commits ORDER BY committed_at DESC, sha DESC")
                .unwrap();
            let rows = statement
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            rows
        });
        assert_eq!(kept, newest_two);
    }

    /// Two projects can be clones of one repository (a fork, or a clone
    /// without an origin). Each project's sweep stores the shared commits
    /// as its own, with their vectors, and `ctx_search`'s commit source
    /// finds them in each, by words and by meaning.
    #[tokio::test]
    async fn two_projects_sharing_history_each_index_and_find_the_commits() {
        let dir = scratch("shared");
        let db = database(&dir);
        let repo = repository(
            &dir,
            &["Fix the zebra parser crash", "Add the release checklist"],
        );
        let (url, _, _) = endpoint().await;
        let provider = Provider::for_test(&url, "mock-embed");
        let plan = Plan {
            memory: false,
            embedding: Some(provider.clone()),
            git: Some(GitIndexing {
                since_days: 3650,
                max_commits: 2000,
            }),
        };
        let now = 1_800_000_000_000;
        let projects = [PROJECT, "pj-upkeep-fork"];
        for project in projects {
            let report = run_project(&db, project, &repo, &plan, &|| now).await;
            assert!(
                matches!(
                    report.sweep,
                    Some(Sweep::Indexed {
                        inserted: 2,
                        embedded: 2,
                        ..
                    })
                ),
                "{project}: {report:?}"
            );
        }
        let model_id = provider.model_id();
        let seen = std::collections::BTreeMap::new();
        for project in projects {
            for (query, semantic, lane) in [
                // Only stemming matches "zebras crashes", so the hit comes
                // from the project's own full-text entry.
                ("zebras crashes", None, "match=fts"),
                (
                    "unrelated words",
                    Some(crate::search::sources::Semantic {
                        vector: &[1.0, 0.0],
                        model_id: &model_id,
                        chunk_model_id: "",
                    }),
                    "match=semantic",
                ),
            ] {
                let scope = crate::search::Scope {
                    harness: "mock",
                    session: "ses-shared",
                    project: Some(project),
                    cutoff: i64::MAX,
                    visible_messages: None,
                    seen: &seen,
                    memory_enabled: false,
                    git_commits_enabled: true,
                    git_repository: Some(true),
                    semantic,
                };
                let input = serde_json::json!({"query": query, "sources": ["git_commit"]});
                let output = db
                    .with_connection(|conn| crate::search::run(conn, &scope, &input))
                    .unwrap();
                assert!(
                    output.contains("[git_commit]")
                        && output.contains(lane)
                        && output.contains("Fix the zebra parser crash"),
                    "{project}, {query}: {output}"
                );
            }
        }
    }

    #[test]
    fn the_log_parser_keeps_a_body_with_separators_and_skips_broken_records() {
        let sha = "a".repeat(40);
        let out = format!(
            "{sha}\u{1f}Subject\u{1f}me@example.com\u{1f}1700000000\u{1f}Body\u{1f}more\u{1e}\n\
             nothex\u{1f}Bad\u{1f}x\u{1f}1700000000\u{1f}\u{1e}\n\
             {sha}\u{1f}No time\u{1f}x\u{1f}0\u{1f}\u{1e}\n"
        );
        assert_eq!(
            parse_log(&out),
            vec![Commit {
                sha,
                message: "Subject\n\nBody\u{1f}more".to_owned(),
                author: Some("me@example.com".to_owned()),
                committed_at_ms: 1_700_000_000_000,
            }]
        );
    }

    #[test]
    fn times_print_as_javascript_iso_strings() {
        assert_eq!(iso_8601(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_8601(1_700_000_000_123), "2023-11-14T22:13:20.123Z");
        assert_eq!(iso_8601(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }
}
