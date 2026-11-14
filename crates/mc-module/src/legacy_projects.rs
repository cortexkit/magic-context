//! Moving the project rows the 0.49 plugin left behind to the project ids
//! Entorhinal assigns.
//!
//! The 0.49 plugin keyed everything a project owns (memories, notes,
//! primers, commits and the rest) by a key it computed from the folder:
//! `git:<root commit>` in a checkout with history, `dir:<path hash>`
//! otherwise ([`key`]). The module keys the same rows by the `pj-` id
//! Entorhinal assigns, which runners stamp on every session. Rows under a
//! 0.49 key would be read by no session, so they are moved here:
//!
//! 1. Entorhinal's `enumerate` lists every project with the folders bound to
//!    it. Each bound folder's 0.49 key is computed, and the keys that still
//!    have rows in the store make pools: one key, the projects claiming it.
//! 2. A key one project claims moves to it whole, with the 0.49 merge's
//!    rules ([`pool::move_step`]). Several keys can move into one project
//!    when it has several folders.
//! 3. A key several projects claim (two clones of one repository with
//!    different origins) is copied: every project gets the knowledge rows,
//!    the first by id keeps the originals, and a session's own rows stay
//!    under the key ([`pool::copy_step`]). A project registered after its key
//!    was moved or copied gets nothing from it; that is accepted.
//!
//! A pool is settled in bounded batches ([`pool::BATCH`]), each in its own
//! transaction, because a transaction holds the `context.db` connection
//! every session shares.
//!
//! Rounds are few ([`run`]): one after start, retried with a growing pause
//! until Entorhinal answers; one when a Setup names a project id this process
//! hasn't seen ([`Wake`]); and one an hour. A round acts only when
//! Entorhinal's `generation` or `incarnation` is new, or the last round
//! failed in the store. Once the store has no row under a 0.49 key, no more
//! rounds run in this process. Without an answer nothing moves. Running
//! sessions learn of moved memories as of any change made outside them: the
//! next view they are allowed to rebuild shows them.

mod key;
mod memories;
mod pool;
mod store;

#[cfg(test)]
mod pool_size_tests;
#[cfg(test)]
mod pool_tests;
#[cfg(test)]
mod round_tests;
#[cfg(test)]
mod setup_wake_tests;

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cortexkit_project_identity::{EnumerateReply, RefKind, RootIdentity};
use cortexkit_role_compaction::read::SessionRef;
use tokio::sync::Notify;

use crate::client::RunnerClient;
use crate::context_db::ContextDb;

/// The first pause before asking again when Entorhinal gave no answer, or a
/// round failed in the store; each further try waits twice as long, up to
/// [`RETRY_CAP`].
const RETRY_FIRST: Duration = Duration::from_secs(5);
const RETRY_CAP: Duration = Duration::from_secs(5 * 60);

/// A round runs at least this often while 0.49 rows are left, in case
/// Entorhinal's projects changed without a Setup naming a new one.
const BACKSTOP: Duration = Duration::from_secs(60 * 60);

/// The pause between two batches of one pool, so sessions waiting for the
/// shared connection get it before the next batch takes it again.
const BETWEEN_BATCHES: Duration = Duration::from_millis(20);

/// The bind identity `enumerate` is asked under. It concerns no session.
fn identity() -> SessionRef {
    SessionRef::new(crate::MODULE_ID, "magic-context", "legacy-projects")
}

/// Ask Entorhinal for every project. `None` when it doesn't answer, refuses,
/// or answers something that doesn't decode.
async fn enumerate<C: RunnerClient>(client: &C) -> Option<EnumerateReply> {
    crate::workspace_members::enumerate(client, &identity(), None).await
}

/// Each local project's bound folders, as `(project id, folder)`. Only a
/// bound folder belongs to its project for certain; a linked worktree is not
/// listed, and its 0.49 key was its main checkout's anyway.
fn bound_roots(reply: &EnumerateReply) -> Vec<(String, PathBuf)> {
    let mut roots = Vec::new();
    for project in &reply.projects {
        // A remote reference names another machine's folders.
        if project.ref_kind != RefKind::Local || !project.project_id.starts_with("pj-") {
            continue;
        }
        for record in project.root_records.iter().flatten() {
            if record.identity == RootIdentity::Bound {
                roots.push((project.project_id.clone(), PathBuf::from(&record.root)));
            }
        }
    }
    roots.sort();
    roots.dedup();
    roots
}

/// What one round did with each pool, for the tests.
#[derive(Debug, Default)]
pub(crate) struct Report {
    pub pools: BTreeMap<String, pool::Outcome>,
    /// Every pool was settled; a pool that failed is tried again next round.
    pub complete: bool,
    /// The store still has rows under a 0.49 key after the round.
    pub left: bool,
}

/// What the rounds remember between them.
#[derive(Default)]
pub(crate) struct Mover {
    /// The `generation` and `incarnation` of the last answer fully handled.
    seen: Option<(i64, String)>,
    /// `git:` keys already computed, by folder: a root commit never changes.
    git_keys: HashMap<PathBuf, String>,
    /// Lines logged once per process.
    said: HashSet<String>,
}

impl Mover {
    fn once(&mut self, line: String) -> bool {
        self.said.insert(line)
    }

    /// The pools: each 0.49 key that has rows, with the projects whose bound
    /// folders give it. A folder's git call that fails is skipped, said once.
    fn plan(
        &mut self,
        with_rows: &BTreeSet<String>,
        roots: &[(String, PathBuf)],
    ) -> BTreeMap<String, BTreeSet<String>> {
        let mut pools: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        if with_rows.is_empty() {
            return pools;
        }
        let any_git = with_rows.iter().any(|key| key.starts_with("git:"));
        for (project, root) in roots {
            if !root.is_dir() {
                let folder_path = root.display().to_string();
                if self.once(format!("missing:{folder_path}")) {
                    tracing::info!(
                        "ck-mc: no legacy project key for {folder_path}: not a folder on this machine"
                    );
                }
                continue;
            }
            let found = match key::without_git(root) {
                key::Probe::Known(found) => found,
                key::Probe::NeedsGit => {
                    if let Some(found) = self.git_keys.get(root) {
                        found.clone()
                    } else if !any_git && !with_rows.contains(&key::directory_key(root)) {
                        // No `git:` key has rows, and only an empty
                        // repository would give this folder its `dir:` key.
                        continue;
                    } else {
                        match key::with_git(root, key::GIT_TIMEOUT) {
                            Ok(found) => {
                                if found.starts_with("git:") {
                                    self.git_keys.insert(root.clone(), found.clone());
                                }
                                found
                            }
                            Err(why) => {
                                let folder_path = root.display().to_string();
                                if self.once(format!("git:{folder_path}")) {
                                    tracing::warn!("ck-mc: no legacy project key for {folder_path}; its rows stay where they are: {why}");
                                }
                                continue;
                            }
                        }
                    }
                }
            };
            if with_rows.contains(&found) {
                pools.entry(found).or_default().insert(project.clone());
            }
        }
        pools
    }

    /// Plan the pools and settle each, a batch at a time.
    fn apply(&mut self, db: &ContextDb, roots: &[(String, PathBuf)], now: i64) -> Report {
        let mut report = Report {
            complete: true,
            left: true,
            ..Report::default()
        };
        // The keys are read first and the git calls made without holding the
        // store, which sessions share.
        let with_rows = match db.with_connection(|conn| store::keys_with_rows(conn)) {
            Ok(keys) => keys,
            Err(error) => {
                tracing::warn!(
                    "ck-mc: reading legacy project keys failed; retrying later: {error}"
                );
                report.complete = false;
                return report;
            }
        };
        let pools = self.plan(&with_rows, roots);
        let mut groups: BTreeMap<&str, BTreeSet<String>> = BTreeMap::new();
        for (key, projects) in &pools {
            if let (Some(project), 1) = (projects.first(), projects.len()) {
                groups.entry(project).or_default().insert(key.clone());
            }
        }
        let none = BTreeSet::new();
        for (key, projects) in &pools {
            let group = projects
                .first()
                .and_then(|project| groups.get(project.as_str()))
                .unwrap_or(&none);
            let settled = settle(db, key, projects, group, now);
            if !settled.done.is_empty() {
                let to = settled.done.keys().cloned().collect::<Vec<_>>().join(", ");
                let rows = described(&settled.done);
                if projects.len() == 1 {
                    tracing::info!("ck-mc: legacy project rows moved from {key} to {to}: {rows}");
                } else {
                    tracing::info!("ck-mc: legacy project rows copied from {key} to {to}: {rows}");
                }
            }
            if let Some(why) = &settled.held {
                let why = match why {
                    pool::Held::Workspaces(ids) => format!(
                        "its projects are in different workspaces ({})",
                        ids.iter()
                            .map(i64::to_string)
                            .collect::<Vec<_>>()
                            .join(", ")
                    ),
                };
                if self.once(format!("held:{key}:{why}")) {
                    let to = projects.iter().cloned().collect::<Vec<_>>().join(", ");
                    tracing::info!("ck-mc: legacy project rows under {key} held for {to}: {why}");
                }
            }
            if let Some(error) = &settled.failed {
                tracing::warn!(
                    "ck-mc: moving legacy project rows from {key} failed; retrying later: {error}"
                );
                report.complete = false;
            }
            let outcome = match (settled.done.is_empty(), settled.held) {
                (false, _) => pool::Outcome::Done(settled.done),
                (true, Some(held)) => pool::Outcome::Held(held),
                (true, None) => pool::Outcome::Nothing,
            };
            report.pools.insert(key.clone(), outcome);
        }
        report.left = match db.with_connection(|conn| store::keys_with_rows(conn)) {
            Ok(keys) => !keys.is_empty(),
            Err(_) => true,
        };
        report
    }
}

/// What settling one pool came to.
#[derive(Default)]
struct Settled {
    /// Rows changed, per project, over every batch.
    done: BTreeMap<String, pool::Rows>,
    held: Option<pool::Held>,
    failed: Option<rusqlite::Error>,
}

/// Settle one pool a batch at a time, until nothing is left, it is held, or
/// a batch fails. The connection is let go between batches.
fn settle(
    db: &ContextDb,
    key: &str,
    projects: &BTreeSet<String>,
    group: &BTreeSet<String>,
    now: i64,
) -> Settled {
    let mut settled = Settled::default();
    let mut progress = pool::Progress::default();
    loop {
        let step = db.with_connection(|conn| match projects.first() {
            Some(project) if projects.len() == 1 => {
                pool::move_step(conn, &mut progress, key, project, group, now, pool::BATCH)
            }
            _ => pool::copy_step(conn, &mut progress, key, projects, now, pool::BATCH),
        });
        match step {
            Ok(pool::Outcome::Done(batch)) => {
                for (project, rows) in batch {
                    let total = settled.done.entry(project).or_default();
                    for (table, count) in rows {
                        *total.entry(table).or_default() += count;
                    }
                }
                std::thread::sleep(BETWEEN_BATCHES);
            }
            Ok(pool::Outcome::Nothing) => return settled,
            Ok(pool::Outcome::Held(held)) => {
                settled.held = Some(held);
                return settled;
            }
            Err(error) => {
                settled.failed = Some(error);
                return settled;
            }
        }
    }
}

/// `pj-a (memories=3, notes=1); pj-b (memories=3)`.
fn described(done: &BTreeMap<String, pool::Rows>) -> String {
    done.iter()
        .map(|(project, rows)| {
            let rows = rows
                .iter()
                .map(|(table, count)| format!("{table}={count}"))
                .collect::<Vec<_>>()
                .join(", ");
            format!("{project} ({rows})")
        })
        .collect::<Vec<_>>()
        .join("; ")
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}

/// What one round came to.
#[derive(Debug)]
pub(crate) enum Round {
    /// The store has no row under a 0.49 key, so Entorhinal wasn't asked.
    Finished,
    /// Entorhinal didn't answer, or the store couldn't be read.
    Retry,
    /// Entorhinal's answer is the one the last complete round handled.
    Unchanged,
    /// The pools were settled as far as they could be.
    Settled(Report),
}

/// One round: when the store still has rows under a 0.49 key, ask
/// Entorhinal, and when its answer is new, settle every pool.
pub(crate) async fn round<C: RunnerClient>(
    client: &C,
    db: &Arc<ContextDb>,
    mover: &mut Mover,
) -> Round {
    match db.with_connection(|conn| store::keys_with_rows(conn)) {
        Ok(keys) if keys.is_empty() => return Round::Finished,
        Ok(_) => {}
        Err(_) => return Round::Retry,
    }
    let Some(reply) = enumerate(client).await else {
        return Round::Retry;
    };
    let stamp = (reply.generation, reply.incarnation.clone());
    if mover.seen.as_ref() == Some(&stamp) {
        return Round::Unchanged;
    }
    let roots = bound_roots(&reply);
    let db = Arc::clone(db);
    let mut taken = std::mem::take(mover);
    // Git calls and the moves block, so they run off the async workers.
    let Ok((taken, report)) = tokio::task::spawn_blocking(move || {
        let report = taken.apply(&db, &roots, now_ms());
        (taken, report)
    })
    .await
    else {
        return Round::Retry;
    };
    *mover = taken;
    if report.complete {
        mover.seen = Some(stamp);
    }
    Round::Settled(report)
}

/// Wakes the rounds when a Setup names a project id this process hasn't
/// seen: a new project may be the one a 0.49 folder now belongs to.
#[derive(Default)]
pub struct Wake {
    known: Mutex<HashSet<String>>,
    notify: Notify,
}

impl Wake {
    /// A Setup stamped `project` on its route.
    pub(crate) fn saw(&self, project: &str) {
        if project.starts_with("pj-")
            && self
                .known
                .lock()
                .expect("known projects")
                .insert(project.to_owned())
        {
            self.notify.notify_one();
        }
    }
}

/// Rounds while the store has rows under a 0.49 key: the first at once,
/// retried with a growing pause until Entorhinal answers, then one an hour
/// and one whenever `wake` sees a new project id. A round that failed in the
/// store is retried like an unanswered one.
pub(crate) async fn run<C: RunnerClient>(client: &C, db: Arc<ContextDb>, wake: Arc<Wake>) {
    let mut mover = Mover::default();
    let mut retry = RETRY_FIRST;
    loop {
        let pause = match round(client, &db, &mut mover).await {
            Round::Finished => break,
            Round::Settled(report) if !report.left => break,
            Round::Retry => backoff(&mut retry),
            Round::Settled(report) if !report.complete => backoff(&mut retry),
            Round::Settled(_) | Round::Unchanged => {
                retry = RETRY_FIRST;
                BACKSTOP
            }
        };
        tokio::select! {
            () = tokio::time::sleep(pause) => {}
            () = wake.notify.notified() => {}
        }
    }
    tracing::info!(
        "ck-mc: no legacy project rows are left; no more legacy project rounds this run"
    );
}

/// The pause before the next try, and the one after it.
fn backoff(retry: &mut Duration) -> Duration {
    let pause = *retry;
    *retry = (*retry * 2).min(RETRY_CAP);
    pause
}
