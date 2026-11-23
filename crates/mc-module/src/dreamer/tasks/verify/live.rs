//! The checks a verify verdict on a memory without a line of its own must
//! pass while the repository has more than one live branch.
//!
//! Such a memory, every memory written before lines were recorded among
//! them, may have been learned on any live branch. Its batch read the main
//! checkout, whose branch may not be that one, so while more than one live
//! branch exists the memory is only ever confirmed:
//! - a rewrite or an archive of it is never applied, whatever the reply
//!   says ([`OLDER_MEMORY`]): the code the batch read may not be the code
//!   the memory describes, and the archive proofs that do apply
//!   ([`super::apply`]) read that code alone;
//! - a confirmation stands only when each span of lines it cites
//!   ([`super::spans`]) is in its file on every live branch, anywhere in the
//!   file; otherwise it counts as a skip, because [`LINES_DIFFER`]. A later
//!   `verify` run checks the stored spans of such a memory the same way
//!   before it asks a model;
//! - a memory every file of whose mapping differs between live branches
//!   ([`Gate::all_differ`]) is not sent to a model at all: a confirmation
//!   from lines of those files is almost always refused, so the model's work
//!   would be spent for nothing. It stays as it is, not marked checked, and
//!   a later run plans it again.
//!
//! The live branches are the default branch and the branches the person's
//! `dreamer.branches` setting names for the project ([`Refs::lines`]): the
//! lines people run, such as a release line kept beside the main one. Which
//! lines exist is the person's statement, never a guess from the worktrees
//! that happen to exist: side checkouts come and go, and stale ones made old
//! memories unsendable for nothing, while a line with no checkout still runs.
//! With one live branch every check passes, so a project on a single line
//! behaves as it did before lines were recorded. The branches are read once
//! when a run is planned and once per batch, when its reply is accepted; a
//! git command that fails or runs out of time refuses the change, and the
//! memory stays.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use super::spans::{find_lines, Cited};
use crate::dreamer::branches::{read_blob, LiveBranch, Refs, Tree};

/// The start of the reason a confirmation counts as a skip when its cited
/// lines are not the same on every live branch.
pub(crate) const LINES_DIFFER: &str = "the lines differ between live branches";

/// The start of the reason a rewrite or an archive of a memory without a
/// line of its own is refused while the repository has more than one live
/// branch.
pub(crate) const OLDER_MEMORY: &str = "older memory: only confirmed while branches differ";

/// The repository's live branches as a run's planning or one batch read
/// them.
pub(crate) struct Live {
    branches: Vec<LiveBranch>,
    /// Each live branch's files, in the order of `branches`; empty when
    /// there is only one.
    trees: Vec<Tree>,
}

impl Live {
    fn read(repo: &Path, named: &[String]) -> Result<Self, String> {
        let branches = Refs::read(repo)?.lines(repo, named)?;
        if branches.len() < 2 {
            return Ok(Self {
                branches,
                trees: Vec::new(),
            });
        }
        let trees = branches
            .iter()
            .map(|branch| Tree::read(repo, &branch.commit))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self { branches, trees })
    }

    /// Whether the repository has one live branch or none, so every check
    /// passes.
    fn single(&self) -> bool {
        self.branches.len() < 2
    }
}

/// The live-branch checks of one run's planning or of one batch.
pub(crate) struct Gate {
    /// The main checkout, where git runs.
    repo: PathBuf,
    /// The project's live branches besides its default branch, as the
    /// person's setting names them.
    named: Vec<String>,
    live: OnceLock<Result<Live, String>>,
    /// The text of each file the confirmation check read, by blob id.
    blobs: Mutex<HashMap<String, Result<String, String>>>,
}

impl Gate {
    pub(crate) fn new(repo: &Path, named: &[String]) -> Self {
        Self {
            repo: repo.to_owned(),
            named: named.to_vec(),
            live: OnceLock::new(),
            blobs: Mutex::default(),
        }
    }

    /// The live branches, read on first use.
    fn live(&self) -> Result<&Live, String> {
        self.live
            .get_or_init(|| Live::read(&self.repo, &self.named))
            .as_ref()
            .map_err(|why| format!("the live branches could not be read: {why}"))
    }

    /// Read the live branches now, so the write that checks against them
    /// finds them read.
    pub(crate) fn warm(&self) {
        let _ = self.live();
    }

    /// Why a rewrite or an archive of a memory without a line of its own
    /// may not be applied: the repository has more than one live branch, or
    /// its live branches could not be read. `None` with one live branch,
    /// where the checks every memory passes decide alone.
    pub(crate) fn refuses_changes(&self) -> Option<String> {
        let live = match self.live() {
            Ok(live) => live,
            Err(why) => {
                return Some(format!(
                    "{OLDER_MEMORY}, and whether they do is unknown: {why}"
                ))
            }
        };
        if live.single() {
            return None;
        }
        let names: Vec<&str> = live
            .branches
            .iter()
            .map(|branch| branch.name.as_str())
            .collect();
        Some(format!(
            "{OLDER_MEMORY} (live branches: {})",
            names.join(", ")
        ))
    }

    /// Whether every one of `files`, paths from the top of the main
    /// checkout, differs between live branches: its blob is not the same on
    /// all of them, or it is on some and not on others. A file on none of
    /// them does not differ. `false` when `files` is empty, with one live
    /// branch, and when the branches could not be read, so that a memory is
    /// left out of a run only when its mapping is known to differ.
    pub(crate) fn all_differ(&self, files: &[String]) -> bool {
        if files.is_empty() {
            return false;
        }
        let Ok(live) = self.live() else {
            return false;
        };
        if live.single() {
            return false;
        }
        files.iter().all(|file| {
            let first = live.trees[0].blob(file);
            live.trees[1..].iter().any(|tree| tree.blob(file) != first)
        })
    }

    /// Why a confirmation citing `spans` may not stand for a memory without
    /// a line of its own: some span's lines are not in its file on some live
    /// branch (the file may have moved them), or a branch could not be read.
    /// `None` when every live branch holds every span, or there is only one.
    pub(crate) fn lines_differ(&self, spans: &[Cited]) -> Option<String> {
        let live = match self.live() {
            Ok(live) => live,
            Err(why) => return Some(why),
        };
        if live.single() {
            return None;
        }
        for span in spans {
            for (branch, tree) in live.branches.iter().zip(&live.trees) {
                let held = match tree.blob(&span.path) {
                    None => false,
                    Some(object) => match self.blob(object) {
                        Ok(text) => find_lines(&text, &span.text).is_some(),
                        Err(why) => {
                            return Some(format!(
                                "reading {} on live branch {} failed: {why}",
                                span.path, branch.name
                            ))
                        }
                    },
                };
                if !held {
                    return Some(format!(
                        "{LINES_DIFFER} ({} is not on live branch {})",
                        span.label(),
                        branch.name
                    ));
                }
            }
        }
        None
    }

    /// The text of blob `object`, read once per batch.
    fn blob(&self, object: &str) -> Result<String, String> {
        if let Some(known) = self.blobs.lock().expect("live blobs").get(object) {
            return known.clone();
        }
        let text = read_blob(&self.repo, object);
        self.blobs
            .lock()
            .expect("live blobs")
            .insert(object.to_owned(), text.clone());
        text
    }
}
