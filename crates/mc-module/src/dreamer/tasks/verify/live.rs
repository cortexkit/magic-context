//! The check a verify change to a memory without a line of its own must pass
//! before it is written.
//!
//! Such a memory, every memory written before lines were recorded among
//! them, may have been learned on any live branch. Its batch read the main
//! checkout, whose branch may not be that one, so a rewrite or an archive of
//! it is applied only where the branch can't matter:
//! - a rewrite, or an archive because the code contradicts it: every file
//!   the verdict names, every file the memory is mapped to and every path its
//!   text cites ([`super::cites`]) is the same blob on every live branch, or
//!   absent from all of them, and none has an uncommitted change in the main
//!   checkout;
//! - an archive because its subject is gone: besides the history proof the
//!   archive already needs, every path and code name the memory cites is
//!   absent from every live branch;
//! - a confirmation: each span of lines it cites ([`super::spans`]) is in its
//!   file on every live branch, anywhere in the file; otherwise it counts as
//!   a skip, because [`LINES_DIFFER`]. A later `verify` run checks the stored
//!   spans of such a memory the same way before it asks a model.
//!
//! The live branches are the default branch and the head of every worktree
//! that has commits the default branch doesn't contain ([`Refs::live_in`]).
//! With one live branch every check passes, so a project on
//! a single line behaves as it did before lines were recorded. The branches
//! are read once per batch, when its reply is accepted; a git command that
//! fails or runs out of time refuses the change, and the memory stays.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use super::cites::Cite;
use super::spans::{find_lines, Cited};
use crate::dreamer::branches::{
    holds_any, names, read_blob, uncommitted, LiveBranch, Refs, Tree,
};
use crate::dreamer::checkout::clean_path;

/// The start of the reason a confirmation counts as a skip when its cited
/// lines are not the same on every live branch.
pub(crate) const LINES_DIFFER: &str = "the lines differ between live branches";

/// The repository's live branches as one batch read them.
pub(crate) struct Live {
    branches: Vec<LiveBranch>,
    /// Each live branch's files, in the order of `branches`; empty when
    /// there is only one.
    trees: Vec<Tree>,
    /// The main checkout's uncommitted paths; empty when there is only one
    /// live branch.
    uncommitted: BTreeSet<String>,
}

impl Live {
    fn read(repo: &Path) -> Result<Self, String> {
        let branches = Refs::read(repo)?.live_in(repo)?;
        if branches.len() < 2 {
            return Ok(Self {
                branches,
                trees: Vec::new(),
                uncommitted: BTreeSet::new(),
            });
        }
        let trees = branches
            .iter()
            .map(|branch| Tree::read(repo, &branch.commit))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            branches,
            trees,
            uncommitted: uncommitted(repo)?,
        })
    }

    /// Whether the repository has one live branch or none, so every check
    /// passes.
    fn single(&self) -> bool {
        self.branches.len() < 2
    }
}

/// One batch's live-branch check.
pub(crate) struct Gate {
    /// The main checkout, where git runs.
    repo: PathBuf,
    /// How long one search of a branch for code names may run.
    timeout: Duration,
    live: OnceLock<Result<Live, String>>,
    /// Each subject-gone archive's answer, by memory: why it may not apply,
    /// or `None` when it may.
    present: Mutex<HashMap<i64, Option<String>>>,
    /// The text of each file the confirmation check read, by blob id.
    blobs: Mutex<HashMap<String, Result<String, String>>>,
}

impl Gate {
    pub(crate) fn new(repo: &Path, timeout: Duration) -> Self {
        Self {
            repo: repo.to_owned(),
            timeout,
            live: OnceLock::new(),
            present: Mutex::default(),
            blobs: Mutex::default(),
        }
    }

    /// The live branches, read on first use.
    fn live(&self) -> Result<&Live, String> {
        self.live
            .get_or_init(|| Live::read(&self.repo))
            .as_ref()
            .map_err(|why| format!("the live branches could not be read: {why}"))
    }

    /// Read the live branches now, so the write that checks against them
    /// finds them read.
    pub(crate) fn warm(&self) {
        let _ = self.live();
    }

    /// Why a rewrite or a contradiction archive whose evidence is `paths`
    /// may not be applied; `None` when it may.
    pub(crate) fn differs(&self, paths: &[String]) -> Option<String> {
        let live = match self.live() {
            Ok(live) => live,
            Err(why) => return Some(why),
        };
        if live.single() {
            return None;
        }
        let mut seen = BTreeSet::new();
        for path in paths {
            let Some(path) = clean_path(path) else {
                continue;
            };
            if !seen.insert(path.clone()) {
                continue;
            }
            let first = live.trees[0].matching(&path);
            for (branch, tree) in live.branches.iter().zip(&live.trees).skip(1) {
                if tree.matching(&path) != first {
                    return Some(format!(
                        "{path} differs between live branches {} and {}",
                        live.branches[0].name, branch.name
                    ));
                }
            }
            if let Some(changed) = live.uncommitted.iter().find(|file| names(&path, file)) {
                return Some(format!(
                    "{changed} has an uncommitted change in the main checkout"
                ));
            }
        }
        None
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

    /// Why archiving memory `id`, whose subject `cites` names, as gone may
    /// not be applied: one of its paths or code names is still on a live
    /// branch, or that can't be told. `None` when it may.
    pub(crate) fn still_present(&self, id: i64, cites: &[Cite]) -> Option<String> {
        if let Some(known) = self.present.lock().expect("live answers").get(&id) {
            return known.clone();
        }
        let answer = match self.live() {
            Ok(live) => self.search(live, cites),
            Err(why) => Some(why),
        };
        self.present
            .lock()
            .expect("live answers")
            .insert(id, answer.clone());
        answer
    }

    fn search(&self, live: &Live, cites: &[Cite]) -> Option<String> {
        if live.single() {
            return None;
        }
        let names: Vec<&str> = cites
            .iter()
            .filter_map(|cite| match cite {
                Cite::Name(name) => Some(name.as_str()),
                Cite::Path(_) => None,
            })
            .collect();
        for (branch, tree) in live.branches.iter().zip(&live.trees) {
            for cite in cites {
                let found = match cite {
                    Cite::Path(path) => !tree.matching(path).is_empty(),
                    // A name in a file's path counts as in the checkout's
                    // own search.
                    Cite::Name(name) => tree.paths().any(|file| file.contains(name.as_str())),
                };
                if found {
                    return Some(format!(
                        "{} is still on live branch {}",
                        cite.text(),
                        branch.name
                    ));
                }
            }
            match holds_any(&self.repo, &branch.commit, &names, self.timeout) {
                Ok(false) => {}
                Ok(true) => {
                    return Some(format!(
                        "a code name it cites ({}) is still on live branch {}",
                        names.join(", "),
                        branch.name
                    ))
                }
                Err(why) => {
                    return Some(format!(
                        "searching live branch {} failed: {why}",
                        branch.name
                    ))
                }
            }
        }
        None
    }
}
