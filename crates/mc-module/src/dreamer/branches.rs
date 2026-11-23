//! The lines of a project's repository, for the dreamer tasks that read its
//! code: which folder is the repository's main checkout, which folder a
//! project's tasks run in, which branches are live, what one commit holds,
//! and a temporary copy of one commit.
//!
//! A project is often worked on in several git worktrees at once, each on a
//! branch of its own, and its sessions run in any of them: a worker's
//! worktree may sit on an old base or hold half-finished edits. The tasks
//! that check memories against code read the main checkout instead, and a
//! repository can carry more than one live line (a release branch next to the
//! next version's), so a memory is checked against the line it was learned
//! on, or, when it names none, only confirmed while more than one line is
//! live.
//!
//! Every git command runs with a timeout and never takes git's index lock
//! ([`super::checkout::run_git_output`]); a command that fails or runs out of
//! time is an `Err`, and the callers then change nothing.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use super::checkout::{is_commit, run_git_output, run_git_within, GIT_TIMEOUT};

/// How long making a copy of one commit may take.
const COPY_TIMEOUT: Duration = Duration::from_secs(180);

/// The main checkout of the repository `folder` is in: the folder whose
/// `.git` holds the repository, which every linked worktree shares. A folder
/// in no git repository, a bare repository's worktree and a submodule are
/// returned as they are: none has a main checkout to read instead. `Err`
/// when git fails or runs out of time on a folder that is in a repository.
pub(crate) fn main_checkout(folder: &Path) -> Result<PathBuf, String> {
    // Git finds a repository through a `.git` entry in the folder or one
    // above it; without one there is nothing to ask.
    if !folder.ancestors().any(|dir| dir.join(".git").exists()) {
        return Ok(folder.to_owned());
    }
    let common = run_git_within(
        folder,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        GIT_TIMEOUT,
    )
    .map_err(|error| format!("finding the repository of {}: {error}", folder.display()))?;
    let common = PathBuf::from(common.trim());
    // A repository with a working tree keeps what its worktrees share in
    // `<main checkout>/.git`. Anywhere else (a bare repository, a
    // submodule's folder under its parent's `.git/modules`) there is no
    // main checkout.
    if common.file_name().and_then(|name| name.to_str()) != Some(".git") {
        return Ok(folder.to_owned());
    }
    match common.parent() {
        Some(main) if main.is_dir() => Ok(main.to_owned()),
        _ => Ok(folder.to_owned()),
    }
}

/// The folder a project's dreamer tasks run in, chosen from `roots`, the
/// folders its sessions were set up in, in the order of those sessions. Each
/// recorded folder that still exists stands for the main checkout of its
/// repository ([`main_checkout`]). Sessions also run in agents' task
/// checkouts, which may sit on an old base, hold half-finished edits, and
/// are deleted once their work is settled, so the folder of whichever
/// session comes first may be gone by the time a task runs.
///
/// The main checkouts are ordered so that the same folders always give the
/// same answer: one outside the CortexKit data root
/// ([`crate::storage_paths::cortexkit_data_root`]) before one inside it,
/// then by path. A folder git fails on or runs out of time on this time
/// stands for itself, after every folder whose main checkout was found.
/// When none of the recorded folders exists any more, the first is returned
/// as it is: a run checks that its folder exists before it starts, and
/// skips naming the folder that is gone. `None` only when `roots` is empty.
pub(crate) fn project_folder(roots: &[String]) -> Option<String> {
    project_folder_outside(
        roots,
        crate::storage_paths::cortexkit_data_root().as_deref(),
    )
}

/// [`project_folder`] with `data_root` as the CortexKit data root, compared
/// resolved as [`Refs::live_outside`] compares it. If the root is unknown,
/// no checkout is treated as internal.
fn project_folder_outside(roots: &[String], data_root: Option<&Path>) -> Option<String> {
    let real = |path: &Path| path.canonicalize().unwrap_or_else(|_| path.to_owned());
    let data_root = data_root.map(real);
    // Ordered by: git could not place the folder, the folder is inside the
    // data root, the folder's path. The first entry is the answer.
    let mut found: BTreeSet<(bool, bool, PathBuf)> = BTreeSet::new();
    for root in roots {
        let folder = Path::new(root);
        if !folder.is_dir() {
            continue;
        }
        let (unplaced, folder) = match main_checkout(folder) {
            Ok(main) => (false, main),
            Err(_) => (true, folder.to_owned()),
        };
        let inside = data_root
            .as_ref()
            .is_some_and(|root| real(&folder).starts_with(root));
        found.insert((unplaced, inside, folder));
    }
    match found.into_iter().next() {
        Some((_, _, folder)) => Some(folder.to_string_lossy().into_owned()),
        None => roots.first().cloned(),
    }
}

/// A live branch: the default branch, or a branch the person's
/// `dreamer.branches` setting names for the project.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LiveBranch {
    /// The branch's name.
    pub name: String,
    pub commit: String,
}

/// One worktree's HEAD.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Worktree {
    /// Its folder, as git lists it.
    path: PathBuf,
    /// Its branch; `None` when detached.
    branch: Option<String>,
    commit: String,
}

/// The repository's branches and worktrees, as two git commands listed
/// them at one moment.
#[derive(Clone, Debug, Default)]
pub(crate) struct Refs {
    /// Each local branch's newest commit, by name.
    heads: BTreeMap<String, String>,
    /// Each of origin's branches' newest commit, by name.
    origin: BTreeMap<String, String>,
    /// The branch origin's HEAD names, origin's default branch.
    origin_default: Option<String>,
    /// Each worktree's HEAD, the main checkout first.
    worktrees: Vec<Worktree>,
}

impl Refs {
    /// List the branches and worktrees of the repository at `repo`.
    pub(crate) fn read(repo: &Path) -> Result<Self, String> {
        let listed = run_git_within(
            repo,
            &[
                "for-each-ref",
                "--format=%(refname)%09%(objectname)%09%(symref)",
                "refs/heads/",
                "refs/remotes/origin/",
            ],
            GIT_TIMEOUT,
        )
        .map_err(|error| format!("listing the branches: {error}"))?;
        let mut refs = Self::default();
        for line in listed.lines() {
            let mut fields = line.split('\t');
            let (Some(name), Some(commit), symref) = (fields.next(), fields.next(), fields.next())
            else {
                continue;
            };
            if name == "refs/remotes/origin/HEAD" {
                refs.origin_default = symref
                    .and_then(|target| target.strip_prefix("refs/remotes/origin/"))
                    .filter(|target| !target.is_empty())
                    .map(str::to_owned);
            } else if let Some(branch) = name.strip_prefix("refs/heads/") {
                refs.heads.insert(branch.to_owned(), commit.to_owned());
            } else if let Some(branch) = name.strip_prefix("refs/remotes/origin/") {
                refs.origin.insert(branch.to_owned(), commit.to_owned());
            }
        }
        let listed = run_git_within(repo, &["worktree", "list", "--porcelain"], GIT_TIMEOUT)
            .map_err(|error| format!("listing the worktrees: {error}"))?;
        refs.worktrees = worktrees(&listed);
        Ok(refs)
    }

    /// The newest commit of local branch `branch`, when it exists.
    pub(crate) fn tip(&self, branch: &str) -> Option<&str> {
        self.heads.get(branch).map(String::as_str)
    }

    /// The default branch and its newest commit: the branch origin's HEAD
    /// names, else a local `main`, else a local `master`. The local branch
    /// of that name counts when there is one, since that is the line the
    /// person works on; otherwise origin's.
    pub(crate) fn default_branch(&self) -> Option<(String, String)> {
        if let Some(name) = &self.origin_default {
            if let Some(commit) = self.heads.get(name).or_else(|| self.origin.get(name)) {
                return Some((name.clone(), commit.clone()));
            }
        }
        ["main", "master"].iter().find_map(|name| {
            self.heads
                .get(*name)
                .map(|commit| ((*name).to_owned(), commit.clone()))
        })
    }

    /// The branch the main checkout has checked out; `None` when its HEAD
    /// is detached or there is no main checkout.
    pub(crate) fn main_branch(&self) -> Option<&str> {
        self.worktrees.first()?.branch.as_deref()
    }

    /// The live branches: the default branch first, then each branch of
    /// `named` (the project's `dreamer.branches` entry), local or else
    /// origin's, once per commit. A named branch git doesn't know is left
    /// out with a log line, and so is one the default branch already
    /// contains: it holds older code of the default branch's line. Which
    /// lines a project runs is the person's statement, never a guess from
    /// the worktrees that happen to exist: side checkouts come and go, and a
    /// line that has none is still run.
    /// `Err` when git fails or runs out of time on one of the checks.
    pub(crate) fn lines(&self, repo: &Path, named: &[String]) -> Result<Vec<LiveBranch>, String> {
        let Some((name, commit)) = self.default_branch() else {
            return Ok(Vec::new());
        };
        let default = LiveBranch { name, commit };
        let mut live = vec![default.clone()];
        for name in named {
            let Some(commit) = self.heads.get(name).or_else(|| self.origin.get(name)) else {
                tracing::info!(
                    "ck-mc: dreamer: live branch {name} is not a branch of {}; it is left out",
                    repo.display()
                );
                continue;
            };
            if live.iter().any(|seen| &seen.commit == commit)
                || contains(repo, &default.commit, commit)?
            {
                continue;
            }
            live.push(LiveBranch {
                name: name.clone(),
                commit: commit.clone(),
            });
        }
        Ok(live)
    }
}

/// Whether commit `ancestor` is in the history of commit `tip`.
fn contains(repo: &Path, tip: &str, ancestor: &str) -> Result<bool, String> {
    if !is_commit(tip) || !is_commit(ancestor) {
        return Err(format!("{ancestor} or {tip} is not a commit id"));
    }
    let output = run_git_output(
        repo,
        &["merge-base", "--is-ancestor", ancestor, tip],
        GIT_TIMEOUT,
    )?;
    match output.code {
        Some(0) => Ok(true),
        // `git merge-base --is-ancestor` exits 1 when it is not.
        Some(1) if output.stderr.trim().is_empty() => Ok(false),
        _ => Err(format!(
            "checking whether {} contains {}: {}",
            short(tip),
            short(ancestor),
            output.stderr.trim().chars().take(300).collect::<String>()
        )),
    }
}

/// The worktrees `git worktree list --porcelain` lists, in order, without a
/// bare repository's own entry, a worktree whose folder is gone, or one on a
/// branch with no commit yet.
fn worktrees(listed: &str) -> Vec<Worktree> {
    let mut found = Vec::new();
    for entry in listed.split("\n\n") {
        let mut path = None;
        let mut commit = None;
        let mut branch = None;
        let mut skip = false;
        for line in entry.lines() {
            if let Some(folder) = line.strip_prefix("worktree ") {
                path = Some(PathBuf::from(folder));
            } else if let Some(head) = line.strip_prefix("HEAD ") {
                commit = Some(head.trim().to_owned());
            } else if let Some(name) = line.strip_prefix("branch ") {
                branch = name.trim().strip_prefix("refs/heads/").map(str::to_owned);
            } else if line == "bare" || line.starts_with("prunable") {
                skip = true;
            }
        }
        match (path, commit) {
            (Some(path), Some(commit))
                if !skip && is_commit(&commit) && commit.bytes().any(|b| b != b'0') =>
            {
                found.push(Worktree {
                    path,
                    branch,
                    commit,
                });
            }
            _ => {}
        }
    }
    found
}

/// A commit id's first twelve characters, for messages.
pub(crate) fn short(commit: &str) -> &str {
    &commit[..commit.len().min(12)]
}

/// Every file of one commit with its blob id, as `git ls-tree -r` lists it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Tree {
    files: BTreeMap<String, String>,
}

impl Tree {
    /// List the files of `commit` in the repository at `repo`.
    pub(crate) fn read(repo: &Path, commit: &str) -> Result<Self, String> {
        if !is_commit(commit) {
            return Err(format!("{commit} is not a commit id"));
        }
        let listed = run_git_within(
            repo,
            &["ls-tree", "-r", "-z", "--full-tree", commit],
            GIT_TIMEOUT,
        )
        .map_err(|error| format!("listing the files of {}: {error}", short(commit)))?;
        let mut files = BTreeMap::new();
        for entry in listed.split('\0').filter(|entry| !entry.is_empty()) {
            // `<mode> <type> <object>\t<path>`
            let Some((head, path)) = entry.split_once('\t') else {
                continue;
            };
            if let Some(object) = head.split(' ').nth(2) {
                files.insert(path.to_owned(), object.to_owned());
            }
        }
        Ok(Self { files })
    }

    /// The blob id of the file at exactly `path`, when the commit holds one.
    pub(crate) fn blob(&self, path: &str) -> Option<&str> {
        self.files.get(path).map(String::as_str)
    }
}

/// The text of blob `object` in the repository at `repo`, read with git's
/// timeout.
pub(crate) fn read_blob(repo: &Path, object: &str) -> Result<String, String> {
    if !(object.len() == 40 || object.len() == 64)
        || !object.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(format!("{object} is not a blob id"));
    }
    run_git_within(repo, &["cat-file", "blob", object], GIT_TIMEOUT)
        .map_err(|error| format!("reading blob {}: {error}", short(object)))
}

/// Whether cited path `path` (cleaned) names `file` or a folder above it:
/// its parts appear in `file`'s parts in a row, as a whole or as an end of a
/// folder's path.
pub(crate) fn names(path: &str, file: &str) -> bool {
    let wanted: Vec<&str> = path.split('/').collect();
    let parts: Vec<&str> = file.split('/').collect();
    parts.windows(wanted.len()).any(|window| window == wanted)
}

/// A temporary folder holding the files of one commit, deleted when
/// dropped.
pub(crate) struct Copy {
    path: PathBuf,
}

impl Copy {
    /// Write the files of `commit` of the repository at `repo` into a new
    /// temporary folder, through `git archive`, which reads the commit and
    /// changes nothing in the repository.
    pub(crate) fn extract(repo: &Path, commit: &str) -> Result<Self, String> {
        if !is_commit(commit) {
            return Err(format!("{commit} is not a commit id"));
        }
        let copy = Self::create()?;
        copy.fill(repo, commit)
            .map_err(|error| format!("copying {}: {error}", short(commit)))?;
        Ok(copy)
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    /// A new empty folder under the system's temporary folder, readable by
    /// this user only: it holds the project's code.
    fn create() -> Result<Self, String> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let base = std::env::temp_dir();
        for _ in 0..16 {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or(0);
            let path = base.join(format!(
                "ck-mc-copy-{}-{stamp}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let mut builder = std::fs::DirBuilder::new();
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            match builder.create(&path) {
                Ok(()) => return Ok(Self { path }),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => {
                    return Err(format!(
                        "creating a folder under {}: {error}",
                        base.display()
                    ))
                }
            }
        }
        Err(format!("no free folder name under {}", base.display()))
    }

    /// Stream `git archive` of `commit` into `tar`, which unpacks it here.
    fn fill(&self, repo: &Path, commit: &str) -> Result<(), String> {
        let mut archive = Command::new("git");
        archive
            .args(["archive", "--format=tar", commit])
            .current_dir(repo)
            .env("GIT_OPTIONAL_LOCKS", "0")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut unpack = Command::new("tar");
        unpack
            .arg("-xf")
            .arg("-")
            .arg("-C")
            .arg(&self.path)
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            // No console window flashes on Windows (CREATE_NO_WINDOW).
            use std::os::windows::process::CommandExt;
            archive.creation_flags(0x0800_0000);
            unpack.creation_flags(0x0800_0000);
        }
        let mut archive = archive.spawn().map_err(|error| format!("git: {error}"))?;
        let stream = archive.stdout.take().expect("stdout is piped");
        let mut unpack = match unpack.stdin(Stdio::from(stream)).spawn() {
            Ok(unpack) => unpack,
            Err(error) => {
                let _ = archive.kill();
                let _ = archive.wait();
                return Err(format!("tar: {error}"));
            }
        };
        // Both error streams are drained while the two run, so neither can
        // stop on a full pipe.
        let drain = |child: &mut std::process::Child| {
            let stderr = child.stderr.take();
            std::thread::spawn(move || {
                let mut text = String::new();
                if let Some(mut stderr) = stderr {
                    let _ = stderr.read_to_string(&mut text);
                }
                text.trim().chars().take(300).collect::<String>()
            })
        };
        let archive_errors = drain(&mut archive);
        let unpack_errors = drain(&mut unpack);
        let deadline = Instant::now() + COPY_TIMEOUT;
        let mut archived = None;
        let mut unpacked = None;
        while archived.is_none() || unpacked.is_none() {
            if archived.is_none() {
                archived = archive
                    .try_wait()
                    .map_err(|error| format!("git: {error}"))?;
            }
            if unpacked.is_none() {
                unpacked = unpack.try_wait().map_err(|error| format!("tar: {error}"))?;
            }
            if Instant::now() >= deadline {
                for child in [&mut archive, &mut unpack] {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                return Err("git archive ran out of time".into());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let archive_errors = archive_errors.join().unwrap_or_default();
        let unpack_errors = unpack_errors.join().unwrap_or_default();
        if !archived.is_some_and(|status| status.success()) {
            return Err(format!("git archive failed: {archive_errors}"));
        }
        if !unpacked.is_some_and(|status| status.success()) {
            return Err(format!("tar failed: {unpack_errors}"));
        }
        Ok(())
    }
}

impl Drop for Copy {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_dir_all(&self.path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(
                    "ck-mc: dreamer: removing the copy {} failed: {error}",
                    self.path.display()
                );
            }
        }
    }
}

#[cfg(test)]
#[path = "branches_tests.rs"]
mod tests;
