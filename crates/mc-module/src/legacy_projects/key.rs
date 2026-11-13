//! The key the 0.49 plugin filed a folder's project rows under.
//!
//! The plugin computed it in `resolveProjectIdentityStrict` and
//! `directoryFallback` (`packages/plugin/src/features/magic-context/memory/project-identity.ts`):
//! - a folder inside a git checkout with history: `git:` and the smallest of
//!   the root commits `git rev-list --max-parents=0 HEAD` prints there;
//! - a folder outside any checkout, or in a repository with no commits yet:
//!   `dir:` and the first 12 hex digits of the MD5 of the folder's path,
//!   resolved as Node's `path.resolve` does (absolute and normalized, with
//!   symlinks left as they are).
//!
//! The functions here are ported from the 0.49 Rust module's copy of the same
//! rules (`crates_old/mc-module/src/project_identity.rs`), which tested them
//! against values the plugin printed. Pins, remembered identities and the
//! plugin's caches are left out: a pinned folder already had a `pj-` id.

use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// How long one git call may run: the plugin's own timeout (`GIT_TIMEOUT_MS`).
pub(crate) const GIT_TIMEOUT: Duration = Duration::from_secs(5);

/// What a folder's key needs before it is known.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Probe {
    /// Known without running git: a `dir:` key.
    Known(String),
    /// The folder is inside a checkout that may have history: only git can
    /// say whether its key is `git:` or `dir:` ([`with_git`]).
    NeedsGit,
}

/// The folder's key, when it can be had without running git.
pub(crate) fn without_git(folder: &Path) -> Probe {
    let resolved = node_path_resolve(folder);
    if git_root_directory(&resolved).is_none() || unborn_head_on_disk(&resolved) {
        Probe::Known(directory_key(folder))
    } else {
        Probe::NeedsGit
    }
}

/// The key of a folder inside a checkout, from git. `Err` says why git gave
/// none: it could not start, ran past `timeout`, refused the repository, or
/// printed no root commit. The plugin paused memory for such a folder rather
/// than guess, so it has no key here either.
pub(crate) fn with_git(folder: &Path, timeout: Duration) -> Result<String, String> {
    let resolved = node_path_resolve(folder);
    let output = run_git(&resolved, &["rev-list", "--max-parents=0", "HEAD"], timeout)
        .ok_or_else(|| format!("git did not finish within {} ms", timeout.as_millis()))?;
    if output.status.success() {
        return smallest_root_commit(&String::from_utf8_lossy(&output.stdout))
            .map(|commit| format!("git:{commit}"))
            .ok_or_else(|| "git printed no root commit".to_owned());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).to_lowercase();
    // The plugin's `classifyGitError`: these messages mean "no root commit",
    // and a repository whose HEAD has no commit yet keeps its `dir:` key.
    let no_root = [
        "not a git repository",
        "does not have any commits yet",
        "ambiguous argument 'head'",
        "unknown revision or path",
    ]
    .iter()
    .any(|marker| stderr.contains(marker));
    if no_root && has_unborn_head(&resolved, timeout) {
        return Ok(directory_key(folder));
    }
    Err(format!("git rev-list failed: {}", stderr.trim()))
}

/// With several roots (unrelated histories merged), the lexicographically
/// smallest, as the plugin takes, so the key doesn't depend on git's order.
fn smallest_root_commit(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .map(|line| line.trim().chars().take(64).collect::<String>())
        .filter(|line| {
            (7..=64).contains(&line.len())
                && line
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
        .min()
}

/// Node's `path.resolve` for one argument: absolute against the current
/// directory, with `.` and `..` folded lexically and no trailing separator.
/// Symlinks are not followed.
pub(crate) fn node_path_resolve(directory: &Path) -> PathBuf {
    let absolute = if directory.is_absolute() {
        directory.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("/"))
            .join(directory)
    };
    let mut resolved = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::Prefix(prefix) => resolved.push(prefix.as_os_str()),
            Component::RootDir => resolved.push(Component::RootDir.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                resolved.pop();
            }
            Component::Normal(part) => resolved.push(part),
        }
    }
    if resolved.as_os_str().is_empty() {
        resolved.push("/");
    }
    resolved
}

/// The `dir:` key: the first 12 hex digits of the MD5 of the resolved path's
/// UTF-8.
pub(crate) fn directory_key(directory: &Path) -> String {
    let resolved = node_path_resolve(directory);
    let hash = format!("{:x}", md5::compute(resolved.to_string_lossy().as_bytes()));
    format!("dir:{}", &hash[..12])
}

fn realpath(path: &Path) -> Option<PathBuf> {
    std::fs::canonicalize(path).ok()
}

/// The nearest ancestor (the folder itself included) holding a `.git` entry.
/// A `.git` file counts: that is how worktrees and submodules look.
fn git_root_in_ancestor_chain(start: &Path) -> Option<PathBuf> {
    let mut current = start.to_path_buf();
    loop {
        if current.join(".git").exists() {
            return Some(current);
        }
        let parent = current.parent()?.to_path_buf();
        if parent == current {
            return None;
        }
        current = parent;
    }
}

/// The plugin's `hasGitDir`: a `.git` above the folder as spelled, or above
/// its real path.
fn git_root_directory(resolved: &Path) -> Option<PathBuf> {
    if let Some(root) = git_root_in_ancestor_chain(resolved) {
        return Some(root);
    }
    let real = realpath(resolved)?;
    if real == resolved {
        None
    } else {
        git_root_in_ancestor_chain(&real)
    }
}

/// Run git in `cwd` with the plugin's locale. `None` when git can't be
/// started or waited on, or runs past `timeout` (it is then killed).
fn run_git(cwd: &Path, args: &[&str], timeout: Duration) -> Option<std::process::Output> {
    let mut child = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(5)),
            Err(_) => return None,
        }
    }
    child.wait_with_output().ok()
}

/// The plugin's `hasUnbornHead`: `git rev-parse --git-dir` succeeds and
/// `git rev-parse --verify --quiet HEAD` exits 1 with nothing on stderr. Any
/// other failure is not "no commits".
fn has_unborn_head(resolved: &Path, timeout: Duration) -> bool {
    if !run_git(resolved, &["rev-parse", "--git-dir"], timeout)
        .is_some_and(|output| output.status.success())
    {
        return false;
    }
    run_git(
        resolved,
        &["rev-parse", "--verify", "--quiet", "HEAD"],
        timeout,
    )
    .is_some_and(|output| output.status.code() == Some(1) && output.stderr.is_empty())
}

/// Environment variables that move or limit where git looks for the
/// repository. With any of them set, the `.git` found by walking up may not
/// be the one git uses.
const GIT_LOCATION_ENV_VARS: &[&str] = &[
    "GIT_DIR",
    "GIT_COMMON_DIR",
    "GIT_WORK_TREE",
    "GIT_CEILING_DIRECTORIES",
];

/// What one metadata path holds, following symlinks.
#[derive(PartialEq, Eq)]
enum EntryKind {
    File,
    Directory,
    Other,
    Missing,
    Error,
}

fn entry_kind(entry: &Path) -> EntryKind {
    match std::fs::metadata(entry) {
        Ok(metadata) if metadata.is_file() => EntryKind::File,
        Ok(metadata) if metadata.is_dir() => EntryKind::Directory,
        Ok(_) => EntryKind::Other,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => EntryKind::Missing,
        Err(_) => EntryKind::Error,
    }
}

/// A metadata file's text: `Ok(None)` when it does not exist, `Err` when it
/// cannot be read.
fn read_metadata_text(file: &Path) -> Result<Option<String>, ()> {
    match std::fs::read(file) {
        Ok(bytes) => String::from_utf8(bytes).map(Some).map_err(|_| ()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(()),
    }
}

/// Drop one trailing line ending, as git does when it reads these one-line
/// files.
fn strip_line_ending(text: &str) -> &str {
    text.strip_suffix("\r\n")
        .or_else(|| text.strip_suffix('\n'))
        .unwrap_or(text)
}

/// A branch name git itself would accept after `refs/heads/`. Anything
/// stranger is left to git (reftable repositories, for instance, point HEAD
/// at `refs/heads/.invalid`).
fn is_plain_branch_name(name: &str) -> bool {
    if name.is_empty() || name.ends_with('/') || name.ends_with('.') {
        return false;
    }
    if name.contains("..") || name.contains("//") || name.contains("@{") {
        return false;
    }
    // Git refuses control characters, spaces, DEL and these punctuation marks
    // in ref names.
    if name
        .chars()
        .any(|c| (c as u32) <= 0x20 || c == '\u{7f}' || "~^:?*[\\".contains(c))
    {
        return false;
    }
    name.split('/')
        .all(|component| !component.starts_with('.') && !component.ends_with(".lock"))
}

/// The nearest `.git` at or above `start`: a `.git` directory as is, or the
/// directory a `.git` file (linked worktrees, submodules) names on its single
/// `gitdir: <path>` line.
fn find_git_directory(start: &Path) -> Option<PathBuf> {
    let mut current = start.to_path_buf();
    loop {
        let dot_git = current.join(".git");
        match entry_kind(&dot_git) {
            EntryKind::Directory => return Some(dot_git),
            EntryKind::File => {
                let text = read_metadata_text(&dot_git).ok()??;
                let value = strip_line_ending(&text).strip_prefix("gitdir: ")?;
                if value.is_empty() || value.contains(['\n', '\r']) {
                    return None;
                }
                return Some(node_path_resolve(&current.join(value)));
            }
            EntryKind::Missing => {}
            EntryKind::Other | EntryKind::Error => return None,
        }
        let parent = current.parent()?.to_path_buf();
        if parent == current {
            return None;
        }
        current = parent;
    }
}

/// Whether `packed-refs` text lists `reference`; `None` when it has a line
/// this reader does not understand.
fn packed_refs_list(text: &str, reference: &str) -> Option<bool> {
    for raw_line in text.split('\n') {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        if line.is_empty() || line.starts_with('#') || line.starts_with('^') {
            continue;
        }
        let (hash, name) = line.split_once(' ')?;
        let hash_ok = (40..=64).contains(&hash.len())
            && hash
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
        if !hash_ok || name.is_empty() || name.chars().any(char::is_whitespace) {
            return None;
        }
        if name == reference {
            return Some(true);
        }
    }
    Some(false)
}

/// Whether the repository around `directory` (already its real path) has an
/// unborn HEAD, read from its metadata files without starting git: the
/// plugin's `isUnbornHeadInLayout` (`memory/unborn-head.ts`). `true` only for
/// the plain layout `git init` leaves: HEAD names a branch under
/// `refs/heads/` that has no loose ref file and no `packed-refs` line.
/// Anything unusual is `false`, which leaves the question to git.
fn unborn_head_in_layout(directory: &Path) -> bool {
    let Some(git_directory) = find_git_directory(directory) else {
        return false;
    };
    // Linked worktrees keep HEAD in their own git directory and share
    // branches, objects and configuration through the one `commondir` names.
    let common_directory = match read_metadata_text(&git_directory.join("commondir")) {
        Ok(Some(text)) => {
            let value = strip_line_ending(&text);
            if value.is_empty() || value.contains('\n') {
                return false;
            }
            node_path_resolve(&git_directory.join(value))
        }
        Ok(None) => git_directory.clone(),
        Err(()) => return false,
    };
    // Git only accepts a directory as a repository when it has HEAD, objects
    // and refs.
    if entry_kind(&git_directory.join("HEAD")) != EntryKind::File
        || entry_kind(&common_directory.join("objects")) != EntryKind::Directory
        || entry_kind(&common_directory.join("refs")) != EntryKind::Directory
    {
        return false;
    }
    // Branches stored other than as loose files and packed-refs can't be read
    // here.
    if entry_kind(&common_directory.join("reftable")) != EntryKind::Missing {
        return false;
    }
    match read_metadata_text(&common_directory.join("config")) {
        Ok(Some(text)) if text.to_ascii_lowercase().contains("refstorage") => return false,
        Ok(_) => {}
        Err(()) => return false,
    }
    let Ok(Some(head)) = read_metadata_text(&git_directory.join("HEAD")) else {
        return false;
    };
    let Some(reference) = head.trim_end().strip_prefix("ref: ") else {
        return false;
    };
    let Some(branch) = reference.strip_prefix("refs/heads/") else {
        return false;
    };
    if !is_plain_branch_name(branch) {
        return false;
    }
    // Any entry at the branch's loose ref path is left to git. Both
    // directories are checked because per-worktree refs live beside HEAD.
    for base in [&common_directory, &git_directory] {
        let mut loose = base.clone();
        loose.extend(reference.split('/'));
        if entry_kind(&loose) != EntryKind::Missing {
            return false;
        }
    }
    match read_metadata_text(&common_directory.join("packed-refs")) {
        Ok(Some(text)) => packed_refs_list(&text, reference) == Some(false),
        Ok(None) => true,
        Err(()) => false,
    }
}

/// Whether `directory` sits in a repository with no commits yet, decided
/// from the metadata files alone; `false` means "ask git".
fn unborn_head_on_disk(directory: &Path) -> bool {
    if GIT_LOCATION_ENV_VARS
        .iter()
        .any(|name| std::env::var_os(name).is_some_and(|value| !value.is_empty()))
    {
        return false;
    }
    // Git discovers the repository from the physical working directory.
    realpath(directory).is_some_and(|real| unborn_head_in_layout(&real))
}

#[cfg(test)]
#[path = "key_tests.rs"]
pub(super) mod tests;
