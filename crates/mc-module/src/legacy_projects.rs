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
//! 2. A key one project claims moves to it whole, in one transaction, with
//!    the 0.49 merge's rules ([`pool::move_pool`]). Several keys can move
//!    into one project when it has several folders.
//! 3. A key several projects claim (two clones of one repository with
//!    different origins) is copied: every project gets the knowledge rows,
//!    the first by id keeps the originals, and a session's own rows stay
//!    under the key ([`pool::copy_pool`]). A project registered after its key
//!    was moved or copied gets nothing from it; that is accepted.
//!
//! It runs once Entorhinal first answers after start, and again whenever its
//! `generation` or `incarnation` changes. Without an answer nothing moves.
//! A store with nothing under a 0.49 key costs one read per round and no
//! git call. Running sessions learn of moved memories as of any change made
//! outside them: the next view they are allowed to rebuild shows them.

mod key;
mod memories;
mod pool;
mod store;

#[cfg(test)]
mod pool_tests;
#[cfg(test)]
mod round_tests;

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use cortexkit_project_identity::{
    EnumerateParams, EnumerateReply, Outcome, RefKind, Request, RootIdentity,
};
use cortexkit_role_compaction::read::SessionRef;

use crate::client::RunnerClient;
use crate::context_db::ContextDb;

/// How often Entorhinal is asked whether its projects changed.
const POLL: Duration = Duration::from_secs(15);

/// How long one `enumerate` may take.
const ENUMERATE_DEADLINE: Duration = Duration::from_secs(2);

/// The bind identity `enumerate` is asked under. It concerns no session.
fn identity() -> SessionRef {
    SessionRef::new(crate::MODULE_ID, "magic-context", "legacy-projects")
}

/// Ask Entorhinal for every project. `None` when it doesn't answer, refuses,
/// or answers something that doesn't decode.
async fn enumerate<C: RunnerClient>(client: &C) -> Option<EnumerateReply> {
    let request = Request::new("enumerate", EnumerateParams::new(None));
    let body = serde_json::to_vec(&request).expect("an enumerate request is JSON");
    let bytes = match tokio::time::timeout(
        ENUMERATE_DEADLINE,
        client.entorhinal_call(&identity(), body),
    )
    .await
    {
        Ok(Some(Ok(bytes))) => bytes,
        _ => return None,
    };
    match serde_json::from_slice::<Outcome<EnumerateReply>>(&bytes) {
        Ok(Outcome::Success(success)) => Some(success.result),
        _ => None,
    }
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

    /// Plan the pools and settle each in its own transaction.
    fn apply(&mut self, db: &ContextDb, roots: &[(String, PathBuf)], now: i64) -> Report {
        let mut report = Report {
            complete: true,
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
        for (key, projects) in &pools {
            // One project takes the whole pool; several each get a copy.
            let outcome = db.with_connection(|conn| match projects.first() {
                Some(project) if projects.len() == 1 => {
                    pool::move_pool(conn, key, project, &groups[project.as_str()], now)
                }
                _ => pool::copy_pool(conn, key, projects, now),
            });
            match &outcome {
                Ok(pool::Outcome::Done(done)) => {
                    let to = done.keys().cloned().collect::<Vec<_>>().join(", ");
                    let rows = described(done);
                    if projects.len() == 1 {
                        tracing::info!(
                            "ck-mc: legacy project rows moved from {key} to {to}: {rows}"
                        );
                    } else {
                        tracing::info!(
                            "ck-mc: legacy project rows copied from {key} to {to}: {rows}"
                        );
                    }
                }
                Ok(pool::Outcome::Held(why)) => {
                    let why = match why {
                        pool::Held::RustManaged(guarded) => {
                            format!(
                                "{guarded} is still guarded for the removed Rust transform mode"
                            )
                        }
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
                        tracing::info!(
                            "ck-mc: legacy project rows under {key} held for {to}: {why}"
                        );
                    }
                }
                Ok(pool::Outcome::Nothing) => {}
                Err(error) => {
                    tracing::warn!("ck-mc: moving legacy project rows from {key} failed; retrying later: {error}");
                    report.complete = false;
                }
            }
            if let Ok(outcome) = outcome {
                report.pools.insert(key.clone(), outcome);
            }
        }
        report
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

/// One round: ask Entorhinal, and when its answer is new, settle every pool.
/// `None` when Entorhinal didn't answer or nothing changed since the last
/// round that settled everything.
pub(crate) async fn round<C: RunnerClient>(
    client: &C,
    db: &Arc<ContextDb>,
    mover: &mut Mover,
) -> Option<Report> {
    let reply = enumerate(client).await?;
    let stamp = (reply.generation, reply.incarnation.clone());
    if mover.seen.as_ref() == Some(&stamp) {
        return None;
    }
    let roots = bound_roots(&reply);
    let db = Arc::clone(db);
    let mut taken = std::mem::take(mover);
    // Git calls and the moves block, so they run off the async workers.
    let (taken, report) = tokio::task::spawn_blocking(move || {
        let report = taken.apply(&db, &roots, now_ms());
        (taken, report)
    })
    .await
    .ok()?;
    *mover = taken;
    if report.complete {
        mover.seen = Some(stamp);
    }
    Some(report)
}

/// Rounds for as long as the module runs, the first at once.
pub(crate) async fn run<C: RunnerClient>(client: &C, db: Arc<ContextDb>) {
    let mut mover = Mover::default();
    loop {
        round(client, &db, &mut mover).await;
        tokio::time::sleep(POLL).await;
    }
}
