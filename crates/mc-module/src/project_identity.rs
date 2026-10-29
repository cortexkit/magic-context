//! The project identity a directory is known by in `context.db`.
//!
//! Memories, notes and every other project-scoped row are keyed by an identity, not by a
//! path: a registered `pj-` pin takes precedence, otherwise `git:<root commit>` for a
//! git checkout with history, or `dir:<md5 prefix of the path>`. The host computes it in TypeScript
//! (`packages/plugin/src/features/magic-context/memory/project-identity.ts`,
//! `resolveProjectIdentityForSession` with `allowHomeProject` off), and the module has to
//! compute exactly the same value for a route whose session the host never recorded, such
//! as a Claude Code session. This is a port of that function; the golden vectors in the
//! tests below were produced by running it.
//!
//! Standalone compatibility: missing and non-directory paths retain the Rust refusal
//! shipped in v0.49.2. Existing directories that cannot be listed retain legacy git/dir
//! resolution, but cannot use registered pins or the registry. TypeScript's missing-path
//! fallback is intentionally unchanged; adopting it here would change standalone Rust.
//!
//! Inside a checkout, only a repository with no commits yet gets a `dir:` identity. When
//! git itself fails (no git binary, a timeout, an ownership refusal, broken metadata) the
//! last `git:` identity known for the directory or an ancestor within the same repository
//! is reused, and otherwise resolution fails with `git_identity_unavailable`, as the host
//! pauses memory features in that case. A `dir:` answer there would key memories under an
//! identity no host computes for that checkout.

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};

use mc_store::private_permissions::write_file_atomic as write_private_file_atomic;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

#[path = "project_pin_writer.rs"]
pub(crate) mod pin_writer;

pub use pin_writer::shutdown as shutdown_pin_writes;

/// How long `git rev-list` may take before the probe counts as a transient failure.
const GIT_TIMEOUT: Duration = Duration::from_secs(5);

/// How long a `dir:` answer is trusted before the directory is probed again, so a repository
/// initialized later is picked up. A `git:` answer never changes and is kept for good.
const DIRECTORY_REVALIDATE_AFTER: Duration = Duration::from_secs(5 * 60);

#[cfg(test)]
thread_local! {
    static GIT_PROBES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Why no identity could be computed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectIdentityError {
    /// The session runs in the user's home directory, or in a checkout whose repository
    /// root is the home directory. The host does not treat either as a project.
    HomeDirectory { directory: String },
    /// The directory cannot be read as a directory (missing, not a directory, no access).
    Unreadable { directory: String, reason: String },
    /// The directory is inside a git checkout, git could not report its root commit for a
    /// reason other than "no commits yet", and no earlier identity for it is known.
    GitUnavailable { directory: String },
}

impl ProjectIdentityError {
    /// The stable code a refusal carries.
    pub fn code(&self) -> &'static str {
        match self {
            Self::HomeDirectory { .. } => "project_identity_home_directory",
            Self::Unreadable { .. } => "project_identity_unreadable",
            // The host's own error class for the same condition.
            Self::GitUnavailable { .. } => "git_identity_unavailable",
        }
    }
}

impl std::fmt::Display for ProjectIdentityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::HomeDirectory { directory } => write!(
                f,
                "{directory} is the home directory (or a checkout rooted there), which Magic Context does not treat as a project"
            ),
            Self::Unreadable { directory, reason } => {
                write!(f, "cannot read project directory {directory}: {reason}")
            }
            Self::GitUnavailable { directory } => write!(
                f,
                "git identity resolution for {directory} is temporarily unavailable; memory features are paused until git access recovers"
            ),
        }
    }
}

impl std::error::Error for ProjectIdentityError {}

/// Node's `path.resolve` for one argument: absolute against the current directory, with
/// `.` and `..` folded lexically and no trailing separator. Symlinks are not followed.
fn node_path_resolve(directory: &Path) -> PathBuf {
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

/// The `dir:` identity: the first 12 hex digits of the MD5 of the resolved path's UTF-8.
pub fn directory_fallback(directory: &Path) -> String {
    let canonical = node_path_resolve(directory);
    let hash = mc_store::md5_hex(&canonical.to_string_lossy());
    format!("dir:{}", &hash[..12])
}

fn realpath(path: &Path) -> Option<PathBuf> {
    std::fs::canonicalize(path).ok()
}

/// The nearest ancestor (the directory itself included) holding a `.git` entry, resolved
/// through symlinks. A `.git` file counts, which is how worktrees and submodules look.
fn git_root_in_ancestor_chain(start: &Path) -> Option<PathBuf> {
    let mut current = start.to_path_buf();
    loop {
        if current.join(".git").exists() {
            return Some(realpath(&current).unwrap_or_else(|| node_path_resolve(&current)));
        }
        let parent = current.parent()?.to_path_buf();
        if parent == current {
            return None;
        }
        current = parent;
    }
}

fn git_root_directory(canonical: &Path) -> Option<PathBuf> {
    if let Some(root) = git_root_in_ancestor_chain(canonical) {
        return Some(root);
    }
    let real = realpath(canonical)?;
    if real == canonical {
        None
    } else {
        git_root_in_ancestor_chain(&real)
    }
}

/// Run git in `cwd` with the probe's locale and timeout. `None` when git cannot be
/// started, cannot be waited on, or runs past [`GIT_TIMEOUT`].
fn run_git(cwd: &Path, args: &[&str]) -> Option<std::process::Output> {
    #[cfg(test)]
    GIT_PROBES.with(|probes| probes.set(probes.get() + 1));
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
            Ok(None) if started.elapsed() >= GIT_TIMEOUT => {
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

/// The root-commit hash of the checkout at `canonical`, or `None` when git cannot give one
/// (no commits, no git binary, a timeout, ownership refusal). With several roots (merged
/// unrelated histories) the lexicographically smallest is taken, as the host does, so the
/// answer does not depend on git's traversal order.
fn git_root_commit(canonical: &Path) -> Option<String> {
    let output = run_git(canonical, &["rev-list", "--max-parents=0", "HEAD"])?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
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

/// Environment variables that move or limit where git looks for the repository. With any
/// of them set, the `.git` found by walking up may not be the one git uses.
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

/// A metadata file's text: `Ok(None)` when it does not exist, `Err` when it cannot be read.
fn read_metadata_text(file: &Path) -> Result<Option<String>, ()> {
    match std::fs::read(file) {
        Ok(bytes) => String::from_utf8(bytes).map(Some).map_err(|_| ()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(()),
    }
}

/// Drop one trailing line ending, as git does when it reads these one-line files.
fn strip_line_ending(text: &str) -> &str {
    text.strip_suffix("\r\n")
        .or_else(|| text.strip_suffix('\n'))
        .unwrap_or(text)
}

/// A branch name git itself would accept after `refs/heads/`. Anything stranger is left to
/// git (reftable repositories, for instance, point HEAD at `refs/heads/.invalid`).
fn is_plain_branch_name(name: &str) -> bool {
    if name.is_empty() || name.ends_with('/') || name.ends_with('.') {
        return false;
    }
    if name.contains("..") || name.contains("//") || name.contains("@{") {
        return false;
    }
    // Git refuses control characters, spaces, DEL and these punctuation marks in ref names.
    if name
        .chars()
        .any(|c| (c as u32) <= 0x20 || c == '\u{7f}' || "~^:?*[\\".contains(c))
    {
        return false;
    }
    name.split('/')
        .all(|component| !component.starts_with('.') && !component.ends_with(".lock"))
}

/// The nearest `.git` at or above `start`: a `.git` directory as is, or the directory a
/// `.git` file (linked worktrees, submodules) names on its single `gitdir: <path>` line.
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

/// Whether `packed-refs` text lists `reference`; `None` when it has a line this reader
/// does not understand.
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

/// Whether the repository around `directory` (already its real path) has an unborn HEAD,
/// read from its metadata files without starting git. The host's `isUnbornHeadInLayout`
/// (`packages/plugin/src/features/magic-context/memory/unborn-head.ts`) applies the same
/// rules, and `testdata/unborn-head-parity.json` holds the cases both must agree on.
/// `true` only for the plain layout `git init` leaves: HEAD names a branch under
/// `refs/heads/` that has no loose ref file and no `packed-refs` line. Anything unusual (a
/// detached HEAD, reftable or other configured ref storage, unreadable or malformed files)
/// is `false`, which leaves the question to git.
fn unborn_head_in_layout(directory: &Path) -> bool {
    let Some(git_directory) = find_git_directory(directory) else {
        return false;
    };
    // Linked worktrees keep HEAD in their own git directory and share branches, objects
    // and configuration through the directory named in `commondir`.
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

    // Git only accepts a directory as a repository when it has HEAD, objects and refs.
    if entry_kind(&git_directory.join("HEAD")) != EntryKind::File
        || entry_kind(&common_directory.join("objects")) != EntryKind::Directory
        || entry_kind(&common_directory.join("refs")) != EntryKind::Directory
    {
        return false;
    }

    // Branches stored somewhere other than loose files and packed-refs cannot be read here.
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

    // Any entry at the branch's loose ref path (a commit id, or something unexpected) is
    // left to git. Both directories are checked because per-worktree refs live beside HEAD.
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

/// Whether `directory` sits in a repository with no commits yet, decided from the
/// metadata files alone; `false` means "ask git". Asking git first made a slow git start
/// (a timeout) pause memory for a freshly initialized repository instead of giving it
/// its directory identity.
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

/// Whether `canonical` is a readable repository whose HEAD has no commit yet, the one git
/// failure the host answers with a `dir:` identity. The host's test (`hasUnbornHead`):
/// `git rev-parse --git-dir` succeeds, and `git rev-parse --verify --quiet HEAD` exits 1
/// with nothing on stderr. Any other failure (no git, a timeout, an ownership refusal,
/// broken metadata) is not "no commits".
fn has_unborn_head(canonical: &Path) -> bool {
    if !run_git(canonical, &["rev-parse", "--git-dir"])
        .is_some_and(|output| output.status.success())
    {
        return false;
    }
    run_git(canonical, &["rev-parse", "--verify", "--quiet", "HEAD"])
        .is_some_and(|output| output.status.code() == Some(1) && output.stderr.is_empty())
}

/// The host's `projectDirectoryKey`: the spelling a directory is filed under in the
/// remembered-identity sidecars. A Windows-shaped path (drive letter or UNC) has its
/// separators unified, its long-path prefix dropped, `.` and `..` folded, its trailing
/// separator removed and its case lowered; any other path is resolved like Node's
/// `path.resolve`.
pub fn project_directory_key(directory: &Path) -> String {
    let raw = directory.to_string_lossy();
    let slashed = raw.replace('\\', "/");
    let slashed = if slashed.len() >= 8 && slashed[..8].eq_ignore_ascii_case("//?/UNC/") {
        format!("//{}", &slashed[8..])
    } else if let Some(rest) = slashed.strip_prefix("//?/") {
        rest.to_string()
    } else {
        slashed
    };
    let bytes = slashed.as_bytes();
    let drive =
        bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/';
    if drive || slashed.starts_with("//") {
        let (prefix, rest) = if drive {
            (slashed[..3].to_string(), &slashed[3..])
        } else {
            ("//".to_string(), &slashed[2..])
        };
        let mut parts: Vec<&str> = Vec::new();
        for part in rest.split('/') {
            match part {
                "" | "." => {}
                ".." => {
                    parts.pop();
                }
                other => parts.push(other),
            }
        }
        let joined = format!("{prefix}{}", parts.join("/"));
        return joined.trim_end_matches('/').to_lowercase();
    }
    node_path_resolve(directory).to_string_lossy().into_owned()
}

pub(crate) fn log_once(key: String, message: &str) {
    static LOGGED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    if LOGGED
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(key.clone())
    {
        tracing::warn!(value = key, "{message}");
    }
}

/// Registered project ids use the wire grammar, excluding path-derived implicit ids.
pub fn is_project_pin(identity: &str) -> bool {
    identity.strip_prefix("pj-").is_some_and(|suffix| {
        !suffix.is_empty()
            && !suffix.starts_with("implicit1-")
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    })
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdentityRecord {
    directory: String,
    identity: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    git_common_dir: Option<String>,
}

fn sidecar_path(sidecar_dir: &Path, directory: &Path) -> PathBuf {
    use sha2::{Digest, Sha256};
    let key = project_directory_key(directory);
    sidecar_dir.join(format!("{:x}.json", Sha256::digest(key.as_bytes())))
}

fn read_record_file(file: &Path) -> Option<IdentityRecord> {
    let record: IdentityRecord = serde_json::from_slice(&std::fs::read(file).ok()?).ok()?;
    if record.identity.starts_with("pj-implicit1-") {
        log_once(
            format!("implicit-sidecar:{}:{}", record.directory, record.identity),
            "Ignoring an implicit project identity sidecar",
        );
        return None;
    }
    Some(record)
}

fn read_record(sidecar_dir: &Path, directory: &Path) -> Option<IdentityRecord> {
    let record = read_record_file(&sidecar_path(sidecar_dir, directory))?;
    (record.directory == project_directory_key(directory)).then_some(record)
}

/// Legacy records remain a fallback only; a project pin has separate precedence.
fn read_remembered_git_identity(sidecar_dir: &Path, directory: &Path) -> Option<String> {
    let identity = read_record(sidecar_dir, directory)?.identity;
    let hash = identity.strip_prefix("git:")?;
    ((7..=64).contains(&hash.len())
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
    .then_some(identity)
}

/// Record `identity` as the one last resolved through git for exactly `directory`, in the
/// host's sidecar format, so a later process that cannot run git (or finds the checkout
/// gone) reuses it instead of starting a new pool. Written to a temporary file and renamed
/// so a reader never sees half a record. Best effort: a read-only storage directory must
/// not turn a successful probe into a failure.
fn remember_git_identity(
    writer: &pin_writer::PinWriter,
    sidecar_dir: &Path,
    directory: &Path,
    identity: &str,
) {
    let key = project_directory_key(directory);
    let destination = sidecar_path(sidecar_dir, directory);
    if writer.lookup(&destination).is_some()
        || read_record(sidecar_dir, directory)
            .is_some_and(|record| is_project_pin(&record.identity))
    {
        return;
    }
    if read_remembered_git_identity(sidecar_dir, directory).as_deref() == Some(identity) {
        return;
    }
    let record = serde_json::json!({ "directory": key, "identity": identity }).to_string();
    let private = crate::config::private_storage_permissions_enabled();
    let _ = write_private_file_atomic(&destination, record.as_bytes(), private);
}

/// Git layout discovered without spawning git. A separate git dir or submodule is not
/// a linked worktree: only a gitdir containing `commondir` marks a linked worktree.
#[derive(Debug, Clone)]
pub struct GitCheckout {
    pub root: PathBuf,
    pub git_common_dir: String,
    pub worktree: bool,
}

pub fn git_checkout(directory: &Path) -> Option<GitCheckout> {
    let root = git_root_directory(directory)?;
    let (common_dir, worktree) = git_common_path(&root)?;
    Some(GitCheckout {
        root,
        git_common_dir: project_directory_key(&std::fs::canonicalize(common_dir).ok()?),
        worktree,
    })
}

fn git_common_path(root: &Path) -> Option<(PathBuf, bool)> {
    let dot_git = root.join(".git");
    if dot_git.is_dir() {
        return Some((dot_git, false));
    }
    let contents = std::fs::read_to_string(dot_git).ok()?;
    let target = contents.trim().strip_prefix("gitdir:")?.trim();
    if target.is_empty() {
        return None;
    }
    let git_dir = root.join(target);
    let common_file = git_dir.join("commondir");
    if common_file.exists() {
        let common = std::fs::read_to_string(common_file).ok()?;
        if common.trim().is_empty() {
            return None;
        }
        Some((git_dir.join(common.trim()), true))
    } else {
        Some((git_dir, false))
    }
}

// A broken or unreadable common-dir target still marks a linked worktree. Detect it
// before canonicalization so unavailable metadata can never authorize a project pin.
fn is_linked_worktree(directory: &Path) -> bool {
    let detect = || -> Option<bool> {
        let root = git_root_directory(directory)?;
        let contents = std::fs::read_to_string(root.join(".git")).ok()?;
        let target = contents.trim().strip_prefix("gitdir:")?.trim();
        Some(!target.is_empty() && root.join(target).join("commondir").exists())
    };
    detect().unwrap_or(false)
}

/// Where the host keeps its remembered-identity sidecars: `project-identities/` beside the
/// `context.db` both processes resolve. Unit tests read and write none, so a test can
/// never touch the real storage directory.
fn default_sidecar_dir() -> Option<PathBuf> {
    if cfg!(test) {
        return None;
    }
    crate::host_store::resolve_context_db_path()
        .parent()
        .map(|storage| storage.join("project-identities"))
}

/// The key a route's history is filed under while its project identity is unavailable.
/// It names no project (no host computes it), so nothing project-scoped is shared under
/// it; it is stable per directory so the route's queued historian runs stay findable.
pub fn unavailable_project_key(directory: &Path) -> String {
    let directory_identity = directory_fallback(directory);
    format!(
        "unresolved:{}",
        directory_identity.trim_start_matches("dir:")
    )
}

#[derive(Clone)]
struct Cached {
    outcome: Result<String, ProjectIdentityError>,
    /// `None` for a `git:` identity, which never changes.
    revalidate_at: Option<Instant>,
}

/// Resolves and remembers identities for the life of the process.
pub struct ProjectIdentityResolver {
    cache: Mutex<HashMap<PathBuf, Cached>>,
    /// The last `git:` identity seen per resolved path, reused when a later git probe
    /// fails transiently so one checkout does not flap between two identities.
    last_git: Mutex<HashMap<PathBuf, String>>,
    /// The host's remembered-identity sidecar directory. `None` reads no sidecars.
    sidecar_dir: Option<PathBuf>,
    pin_writer: Arc<pin_writer::PinWriter>,
}

impl Default for ProjectIdentityResolver {
    fn default() -> Self {
        Self {
            cache: Mutex::default(),
            last_git: Mutex::default(),
            sidecar_dir: None,
            pin_writer: pin_writer::process_writer(),
        }
    }
}

impl ProjectIdentityResolver {
    pub fn new() -> Self {
        Self {
            sidecar_dir: default_sidecar_dir(),
            ..Self::default()
        }
    }

    /// A resolver reading the host's remembered identities from `sidecar_dir`.
    #[cfg(test)]
    pub(crate) fn with_sidecar_dir(sidecar_dir: PathBuf) -> Self {
        Self {
            sidecar_dir: Some(sidecar_dir),
            ..Self::default()
        }
    }

    #[cfg(test)]
    pub(crate) fn with_pin_writer(
        sidecar_dir: PathBuf,
        pin_writer: Arc<pin_writer::PinWriter>,
    ) -> Self {
        Self {
            sidecar_dir: Some(sidecar_dir),
            pin_writer,
            ..Self::default()
        }
    }

    #[cfg(test)]
    pub(crate) fn flush_pins(&self) {
        assert!(self.pin_writer.flush(Duration::from_secs(10)));
    }

    fn remembered(&self, directory: &Path) -> Option<String> {
        read_remembered_git_identity(self.sidecar_dir.as_deref()?, directory)
    }

    /// Refuse home projects and missing or unreadable directories before reading pins
    /// or contacting Entorhinal.
    pub fn eligible_directory(&self, directory: &Path) -> Result<PathBuf, ProjectIdentityError> {
        self.eligible_directory_with_home(directory, crate::config::user_home_dir().as_deref())
    }

    fn eligible_directory_with_home(
        &self,
        directory: &Path,
        home: Option<&Path>,
    ) -> Result<PathBuf, ProjectIdentityError> {
        let resolved = self.legacy_directory_with_home(directory, home)?;
        std::fs::read_dir(&resolved).map_err(|error| ProjectIdentityError::Unreadable {
            directory: resolved.display().to_string(),
            reason: error.to_string(),
        })?;
        Ok(resolved)
    }

    fn legacy_directory_with_home(
        &self,
        directory: &Path,
        home: Option<&Path>,
    ) -> Result<PathBuf, ProjectIdentityError> {
        let resolved = node_path_resolve(directory);
        let display = resolved.display().to_string();
        let canonical_directory = realpath(&resolved).unwrap_or_else(|| resolved.clone());
        if let Some(home) = home {
            let canonical_home = realpath(home).unwrap_or_else(|| home.to_path_buf());
            let inherits_home =
                git_root_directory(&canonical_directory).is_some_and(|root| root == canonical_home);
            if canonical_directory == canonical_home || inherits_home {
                return Err(ProjectIdentityError::HomeDirectory { directory: display });
            }
        }
        match std::fs::metadata(&resolved) {
            Ok(metadata) if metadata.is_dir() => Ok(resolved),
            Ok(_) => Err(ProjectIdentityError::Unreadable {
                directory: display,
                reason: "not a directory".to_string(),
            }),
            Err(error) => Err(ProjectIdentityError::Unreadable {
                directory: display,
                reason: error.to_string(),
            }),
        }
    }

    /// An exact pin is authoritative even when the process cached an older git answer.
    /// Callers must check local eligibility first.
    pub fn pinned_identity(&self, directory: &Path) -> Option<String> {
        let sidecars = self.sidecar_dir.as_deref()?;
        let record = self
            .pin_writer
            .lookup(&sidecar_path(sidecars, directory))
            .or_else(|| read_record(sidecars, directory))?;
        is_project_pin(&record.identity).then_some(record.identity)
    }

    /// A pin found through a shared git common directory is used only for this session;
    /// it must not be saved as a pin for the queried directory.
    pub fn common_dir_pin(&self, directory: &Path) -> Option<String> {
        let common = git_checkout(directory)?.git_common_dir;
        let sidecars = self.sidecar_dir.as_deref()?;
        let mut records = self.pin_writer.records(sidecars);
        let mut identities = HashSet::new();
        for entry in std::fs::read_dir(sidecars).into_iter().flatten().flatten() {
            if entry
                .path()
                .extension()
                .is_none_or(|extension| extension != "json")
            {
                continue;
            }
            if let Some(record) = read_record_file(&entry.path()) {
                records.entry(record.directory.clone()).or_insert(record);
            }
        }
        for record in records.into_values() {
            if record.git_common_dir.as_deref() == Some(&common) && is_project_pin(&record.identity)
            {
                identities.insert(record.identity);
            }
        }
        if identities.len() == 1 {
            identities.into_iter().next()
        } else {
            if identities.len() > 1 {
                log_once(
                    format!("common-dir-conflict:{common}"),
                    "Conflicting project pins share a git common directory; using fallback",
                );
            }
            None
        }
    }

    /// Persist only a live registered answer, never a worktree or an existing pin.
    /// A nested registration authorizes its own directory, not its checkout's parent.
    pub(crate) fn pin_live_answer(
        &self,
        directory: &Path,
        identity: &str,
        canonical_root: Option<&Path>,
    ) {
        if !is_project_pin(identity) {
            return;
        }
        let checkout = git_checkout(directory);
        if is_linked_worktree(directory) {
            return;
        }
        let Some(sidecar_dir) = self.sidecar_dir.as_deref() else {
            return;
        };
        let write = |destination: &Path| {
            if self.pinned_identity(destination).is_some() {
                return;
            }
            let record = IdentityRecord {
                directory: project_directory_key(destination),
                identity: identity.to_string(),
                git_common_dir: checkout
                    .as_ref()
                    .map(|checkout| checkout.git_common_dir.clone()),
            };
            let private = crate::config::private_storage_permissions_enabled();
            self.pin_writer.publish(sidecar_dir, record, private);
        };
        write(directory);
        if let Some(checkout) = checkout.as_ref() {
            let answer_root = canonical_root.and_then(realpath);
            let checkout_root = realpath(&checkout.root);
            if answer_root
                .zip(checkout_root)
                .is_some_and(|(answer, root)| {
                    project_directory_key(&answer) == project_directory_key(&root)
                })
            {
                write(&checkout.root);
            }
        }
    }

    /// The `git:` identity last known for `canonical` or an ancestor in the same
    /// repository, from this process or the host's sidecars. The walk stops at the first
    /// directory holding its own `.git`: a nested repository is a different project, and
    /// borrowing the outer repository's identity would put its memories in the wrong pool.
    fn nearest_known_git_identity(&self, canonical: &Path) -> Option<String> {
        let walk = |start: &Path| {
            let last = self
                .last_git
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();
            let mut current = Some(start);
            while let Some(path) = current {
                if let Some(identity) = last.get(path).cloned().or_else(|| self.remembered(path)) {
                    return Some(identity);
                }
                if path.join(".git").exists() {
                    return None;
                }
                current = path.parent();
            }
            None
        };
        walk(canonical).or_else(|| {
            let real = realpath(canonical)?;
            (real != canonical).then(|| walk(&real)).flatten()
        })
    }

    /// The identity of `directory`, as the host's `resolveProjectIdentityForSession`
    /// computes it.
    pub fn resolve(&self, directory: &Path) -> Result<String, ProjectIdentityError> {
        let resolved =
            self.legacy_directory_with_home(directory, crate::config::user_home_dir().as_deref())?;
        if let Some(pin) = std::fs::read_dir(&resolved)
            .ok()
            .and_then(|_| self.pinned_identity(&resolved))
        {
            return Ok(pin);
        }
        if let Some(cached) = self
            .cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&resolved)
            .cloned()
        {
            let fresh = cached
                .revalidate_at
                .is_none_or(|revalidate_at| Instant::now() < revalidate_at);
            // A `dir:` answer is only good while no repository has appeared around the
            // directory; the host re-resolves it as soon as one has, so the first commit
            // moves the project to its `git:` identity without waiting out the window.
            let stale_directory = cached
                .outcome
                .as_ref()
                .is_ok_and(|identity| identity.starts_with("dir:"))
                && git_root_directory(&resolved).is_some();
            if fresh && !stale_directory {
                return cached.outcome;
            }
        }
        let outcome = self.resolve_uncached(&resolved);
        // A refusal for a missing or home directory is not remembered: it costs no git
        // probe to repeat. A git failure is, so a broken or slow git is probed again only
        // after the same window the host waits before retrying.
        let remembered = match &outcome {
            Ok(_) | Err(ProjectIdentityError::GitUnavailable { .. }) => true,
            Err(_) => false,
        };
        if remembered {
            let revalidate_at = (!outcome
                .as_ref()
                .is_ok_and(|identity| identity.starts_with("git:")))
            .then(|| Instant::now() + DIRECTORY_REVALIDATE_AFTER);
            self.cache
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .insert(
                    resolved,
                    Cached {
                        outcome: outcome.clone(),
                        revalidate_at,
                    },
                );
        }
        outcome
    }

    fn resolve_uncached(&self, resolved: &Path) -> Result<String, ProjectIdentityError> {
        if git_root_directory(resolved).is_none() {
            // No checkout here (any more). A directory the host once resolved through git
            // keeps that identity, as the host keeps it; only this exact path's record
            // counts, so a plain folder never borrows an ancestor repository's pool.
            return Ok(self
                .remembered(resolved)
                .unwrap_or_else(|| directory_fallback(resolved)));
        }
        if unborn_head_on_disk(resolved) {
            // Recognized from the metadata files before any git process starts, so a slow
            // git cannot turn a fresh repository into an unavailable identity. The answer
            // matches the `has_unborn_head` branch below.
            return Ok(directory_fallback(resolved));
        }
        if let Some(root) = git_root_commit(resolved) {
            let identity = format!("git:{root}");
            self.last_git
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .insert(resolved.to_path_buf(), identity.clone());
            // Remember it across restarts, as the host does, for this path and for the
            // checkout root it belongs to.
            if let Some(sidecar_dir) = self.sidecar_dir.as_deref() {
                remember_git_identity(&self.pin_writer, sidecar_dir, resolved, &identity);
                if let Some(root) = git_root_directory(resolved).filter(|root| root != resolved) {
                    remember_git_identity(&self.pin_writer, sidecar_dir, &root, &identity);
                }
            }
            return Ok(identity);
        }
        if has_unborn_head(resolved) {
            // A repository with no commits yet has no root commit to name it by. The
            // directory hash stands in until the first commit, which the cache check above
            // picks up. This repository is its own project even when it sits inside
            // another checkout, so no outer identity is consulted.
            return Ok(directory_fallback(resolved));
        }
        // git failed for another reason: missing, timed out, refused the repository's
        // ownership, or found its metadata broken. Reuse the identity last known for this
        // repository, and otherwise refuse as the host does; a `dir:` identity here would
        // file memories under a key no host uses for this checkout.
        self.nearest_known_git_identity(resolved).ok_or_else(|| {
            ProjectIdentityError::GitUnavailable {
                directory: resolved.display().to_string(),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `(input, identity)` pairs printed by the host's `resolveProjectIdentity` for paths that
    /// do not exist, which is its `dir:` fallback of the resolved path.
    #[cfg(not(windows))]
    const DIRECTORY_GOLDEN: &[(&str, &str)] = &[
        ("/work/api", "dir:e02ef1f35c06"),
        ("/work/api/", "dir:e02ef1f35c06"),
        ("/work/./x/../api", "dir:e02ef1f35c06"),
        ("/tmp/n\u{e4}me dir", "dir:93e3ea277593"),
        ("/", "dir:6666cd76f969"),
    ];

    #[cfg(windows)]
    const DIRECTORY_GOLDEN: &[(&str, &str)] = &[
        (r"C:\work\api", "dir:7f55d5fe53ba"),
        (r"C:\work\api\", "dir:7f55d5fe53ba"),
        (r"C:\work\.\x\..\api", "dir:7f55d5fe53ba"),
        (r"C:\tmp\näme dir", "dir:ae8c0f4fb42c"),
        (r"C:\", "dir:2f158c4731d7"),
    ];

    /// The root commit the host's `resolveProjectIdentityForSession` resolves for the fixed
    /// repository built in the checkout test, from the repository, a subdirectory, a trailing
    /// slash, a worktree and a symlink alike.
    const GOLDEN_ROOT_COMMIT: &str = "5dd1e9f0bd6f4800131f7c6887d174ffceac99d6";

    /// Values printed by the host's own function (see the module documentation) for the
    /// same inputs. A change on either side that alters them splits every project's
    /// memories between the host and the module.
    #[test]
    fn directory_identities_match_the_hosts_golden_vectors() {
        for (directory, expected) in DIRECTORY_GOLDEN {
            assert_eq!(
                directory_fallback(Path::new(directory)),
                *expected,
                "dir identity of {directory}"
            );
        }
    }

    fn git(cwd: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env("GIT_AUTHOR_NAME", "golden")
            .env("GIT_AUTHOR_EMAIL", "golden@example.invalid")
            .env("GIT_COMMITTER_NAME", "golden")
            .env("GIT_COMMITTER_EMAIL", "golden@example.invalid")
            .env("GIT_AUTHOR_DATE", "2001-01-01T00:00:00Z")
            .env("GIT_COMMITTER_DATE", "2001-01-01T00:00:00Z")
            .env(
                "GIT_CONFIG_GLOBAL",
                if cfg!(windows) { "NUL" } else { "/dev/null" },
            )
            .env("GIT_CONFIG_NOSYSTEM", "1")
            // Config injected through the environment (a shell or agent tool setting
            // core.hooksPath this way) would otherwise change the golden commit.
            .env("GIT_CONFIG_COUNT", "0")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("git runs");
        assert!(status.success(), "git {args:?}");
    }

    /// A fixed repository (fixed author, dates and content) has a fixed root commit, so the
    /// host's answer for it is a golden value too. Every spelling of a place inside the
    /// checkout (a worktree, a subdirectory, a trailing slash, a symlink) resolves to it.
    #[cfg(unix)]
    #[test]
    fn a_checkout_resolves_to_the_hosts_root_commit_identity_from_every_spelling() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(repo.join("sub")).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("README"), "golden\n").unwrap();
        git(&repo, &["add", "README"]);
        git(&repo, &["commit", "-q", "-m", "golden root"]);
        let worktree = dir.path().join("worktree");
        git(
            &repo,
            &[
                "worktree",
                "add",
                "-q",
                worktree.to_str().unwrap(),
                "-b",
                "wt",
            ],
        );
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&repo, &link).unwrap();

        let resolver = ProjectIdentityResolver::new();
        let expected = format!("git:{GOLDEN_ROOT_COMMIT}");
        for place in [
            repo.clone(),
            repo.join("sub"),
            PathBuf::from(format!("{}/", repo.display())),
            worktree,
            link,
        ] {
            assert_eq!(resolver.resolve(&place).unwrap(), expected, "{place:?}");
        }
    }

    #[test]
    fn a_directory_without_git_resolves_to_its_path_hash_and_a_missing_one_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let plain = dir.path().join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        let resolver = ProjectIdentityResolver::new();
        assert_eq!(
            resolver.resolve(&plain).unwrap(),
            directory_fallback(&plain)
        );
        let gone = dir.path().join("gone");
        assert!(matches!(
            resolver.resolve(&gone),
            Err(ProjectIdentityError::Unreadable { .. })
        ));
    }
    fn committed_repo(path: &Path) {
        std::fs::create_dir_all(path).unwrap();
        git(path, &["init", "-q", "-b", "main"]);
        std::fs::write(path.join("README"), "golden\n").unwrap();
        git(path, &["add", "README"]);
        git(path, &["commit", "-q", "-m", "golden root"]);
    }

    /// A nested repository with no commits yet is its own project. Resolving the outer
    /// checkout first used to leave its identity behind for the nested one to borrow.
    #[test]
    fn a_new_nested_repository_does_not_take_the_outer_repositorys_identity() {
        let dir = tempfile::tempdir().unwrap();
        let outer = dir.path().join("outer");
        committed_repo(&outer);
        let nested = outer.join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        git(&nested, &["init", "-q", "-b", "main"]);

        let resolver = ProjectIdentityResolver::default();
        assert_eq!(
            resolver.resolve(&outer).unwrap(),
            format!("git:{GOLDEN_ROOT_COMMIT}")
        );
        let nested_identity = resolver.resolve(&nested).unwrap();
        assert_eq!(nested_identity, directory_fallback(&nested));
        // The answer must not depend on what this process resolved before.
        assert_eq!(
            ProjectIdentityResolver::default().resolve(&nested).unwrap(),
            nested_identity
        );
    }

    /// A checkout git cannot read is not a plain directory: the host pauses memory there
    /// rather than inventing a `dir:` identity, and so does the module.
    #[test]
    fn a_checkout_git_cannot_read_is_refused_not_given_a_directory_identity() {
        let dir = tempfile::tempdir().unwrap();
        let broken = dir.path().join("broken");
        std::fs::create_dir_all(&broken).unwrap();
        std::fs::write(broken.join(".git"), "gitdir: /nonexistent/for/this/test\n").unwrap();
        let error = ProjectIdentityResolver::default()
            .resolve(&broken)
            .unwrap_err();
        assert!(
            matches!(error, ProjectIdentityError::GitUnavailable { .. }),
            "{error:?}"
        );
        assert_eq!(error.code(), "git_identity_unavailable");
    }

    /// A broken nested checkout inside a known repository is still a different project:
    /// the outer identity is not borrowed across the nested `.git`.
    #[test]
    fn a_broken_nested_checkout_does_not_borrow_the_outer_identity() {
        let dir = tempfile::tempdir().unwrap();
        let outer = dir.path().join("outer");
        committed_repo(&outer);
        let nested = outer.join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join(".git"), "gitdir: /nonexistent/for/this/test\n").unwrap();
        let resolver = ProjectIdentityResolver::default();
        resolver.resolve(&outer).unwrap();
        assert!(matches!(
            resolver.resolve(&nested),
            Err(ProjectIdentityError::GitUnavailable { .. })
        ));
    }

    /// When git fails for a directory inside a repository this process already resolved,
    /// the repository's identity is reused so its memory pool does not split.
    #[test]
    fn a_git_failure_inside_a_known_repository_reuses_its_identity() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        committed_repo(&repo);
        std::fs::create_dir_all(repo.join("sub")).unwrap();
        let resolver = ProjectIdentityResolver::default();
        let expected = format!("git:{GOLDEN_ROOT_COMMIT}");
        assert_eq!(resolver.resolve(&repo).unwrap(), expected);
        std::fs::write(repo.join(".git").join("HEAD"), "garbage\n").unwrap();
        assert_eq!(resolver.resolve(&repo.join("sub")).unwrap(), expected);
    }

    /// A folder whose git metadata is gone (a removed linked worktree) keeps the identity
    /// the host remembered for that exact path.
    #[test]
    fn a_directory_without_git_reads_the_hosts_remembered_identity_for_that_path() {
        use sha2::{Digest, Sha256};
        let dir = tempfile::tempdir().unwrap();
        let sidecars = dir.path().join("project-identities");
        std::fs::create_dir_all(&sidecars).unwrap();
        let folder = dir.path().join("former-worktree");
        std::fs::create_dir_all(folder.join("child")).unwrap();
        let key = project_directory_key(&folder);
        std::fs::write(
            sidecars.join(format!("{:x}.json", Sha256::digest(key.as_bytes()))),
            serde_json::json!({ "directory": key, "identity": "git:abcdef1234567" }).to_string(),
        )
        .unwrap();
        let resolver = ProjectIdentityResolver::with_sidecar_dir(sidecars);
        assert_eq!(resolver.resolve(&folder).unwrap(), "git:abcdef1234567");
        // Only the exact path's record counts.
        let child = folder.join("child");
        assert_eq!(
            resolver.resolve(&child).unwrap(),
            directory_fallback(&child)
        );
    }

    /// A successful probe is remembered in the host's sidecar format, so a later process
    /// whose git fails reuses the identity instead of pausing or splitting the pool.
    #[test]
    fn a_resolved_checkout_is_remembered_for_the_next_process() {
        let dir = tempfile::tempdir().unwrap();
        let sidecars = dir.path().join("project-identities");
        let repo = dir.path().join("repo");
        committed_repo(&repo);
        std::fs::create_dir_all(repo.join("sub")).unwrap();
        let expected = format!("git:{GOLDEN_ROOT_COMMIT}");
        let first = ProjectIdentityResolver::with_sidecar_dir(sidecars.clone());
        assert_eq!(first.resolve(&repo.join("sub")).unwrap(), expected);
        assert_eq!(
            read_remembered_git_identity(&sidecars, &repo.join("sub")).as_deref(),
            Some(expected.as_str())
        );
        // A fresh process whose git now fails still finds the identity.
        std::fs::write(repo.join(".git").join("HEAD"), "garbage\n").unwrap();
        let second = ProjectIdentityResolver::with_sidecar_dir(sidecars);
        assert_eq!(second.resolve(&repo.join("sub")).unwrap(), expected);
    }

    /// Checks this module's unborn-HEAD reading against the repository layouts in
    /// `testdata/unborn-head-parity.json`, which the host's TypeScript check
    /// (`isUnbornHeadInLayout`) is tested on too. Both must call the same layouts unborn;
    /// otherwise a fresh repository would get a `dir:` identity from one side and a
    /// `git:` identity or a refusal from the other.
    #[test]
    fn the_unborn_head_check_matches_the_hosts_parity_cases() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../testdata/unborn-head-parity.json"))
                .unwrap();
        let cases = fixture["cases"].as_array().unwrap();
        assert!(cases.len() > 10, "parity cases present");
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let dir = tempfile::tempdir().unwrap();
            let root = realpath(dir.path()).unwrap();
            for (key, text) in case["entries"].as_object().unwrap() {
                let mut target = root.clone();
                target.extend(key.split('/').filter(|part| !part.is_empty()));
                if key.ends_with('/') {
                    std::fs::create_dir_all(&target).unwrap();
                    continue;
                }
                std::fs::create_dir_all(target.parent().unwrap()).unwrap();
                let text = text
                    .as_str()
                    .unwrap_or_default()
                    .replace("{root}", &root.to_string_lossy());
                std::fs::write(&target, text).unwrap();
            }
            let mut probe = root.clone();
            probe.extend(case["probe"].as_str().unwrap().split('/'));
            assert_eq!(
                unborn_head_in_layout(&probe),
                case["unborn"].as_bool().unwrap(),
                "{name}"
            );
        }
    }

    /// A fresh `git init` is read as unborn from its files on disk. Once the first commit
    /// exists, the files no longer say unborn, so the identity is resolved through git and
    /// named by the root commit.
    #[test]
    fn a_fresh_repository_is_read_as_unborn_until_its_first_commit() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        assert!(unborn_head_on_disk(&repo));
        let resolver = ProjectIdentityResolver::default();
        assert_eq!(resolver.resolve(&repo).unwrap(), directory_fallback(&repo));
        std::fs::write(repo.join("README"), "golden\n").unwrap();
        git(&repo, &["add", "README"]);
        git(&repo, &["commit", "-q", "-m", "golden root"]);
        assert!(!unborn_head_on_disk(&repo));
        assert_eq!(
            resolver.resolve(&repo).unwrap(),
            format!("git:{GOLDEN_ROOT_COMMIT}")
        );
        // A branch held only in packed-refs is born.
        git(&repo, &["pack-refs", "--all"]);
        assert!(!repo.join(".git/refs/heads/main").exists());
        assert!(!unborn_head_on_disk(&repo));
    }

    #[test]
    fn directory_keys_follow_the_hosts_spelling_rules() {
        #[cfg(not(windows))]
        {
            assert_eq!(project_directory_key(Path::new("/work/api/")), "/work/api");
            assert_eq!(
                project_directory_key(Path::new("/work/./x/../api")),
                "/work/api"
            );
        }
        assert_eq!(
            project_directory_key(Path::new("C:\\Users\\Me\\Repo\\")),
            "c:/users/me/repo"
        );
        assert_eq!(
            project_directory_key(Path::new("\\\\?\\C:\\Repo")),
            "c:/repo"
        );
        assert_eq!(
            project_directory_key(Path::new("\\\\?\\UNC\\Server\\Share\\x")),
            "//server/share/x"
        );
    }
}

#[cfg(test)]
mod pin_tests {
    use super::*;
    use crate::entorhinal_resolve::{decode_reply, resolve_with_attempt, ResolveAnswer};
    use serde_json::Value;
    use std::io::Write;
    use std::sync::Arc;

    const PARITY: &str = include_str!("../../../test-vectors/project-identity-parity.json");
    const RESOLVE: &str = include_str!("../../../test-vectors/project-resolve-v1/resolve.json");

    fn git_input(cwd: &Path, args: &[&str], input: &[u8]) -> String {
        let mut child = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env(
                "GIT_CONFIG_GLOBAL",
                if cfg!(windows) { "NUL" } else { "/dev/null" },
            )
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_COUNT", "0")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(input).unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_string()
    }

    fn substitute(value: &mut Value, replacements: &serde_json::Map<String, Value>) {
        match value {
            Value::String(string) => {
                if let Some(replacement) = replacements.get(string) {
                    *string = replacement.as_str().unwrap().to_string();
                }
            }
            Value::Array(values) => values
                .iter_mut()
                .for_each(|value| substitute(value, replacements)),
            Value::Object(values) => values
                .values_mut()
                .for_each(|value| substitute(value, replacements)),
            _ => {}
        }
    }

    fn relocate(value: &mut Value, root: &Path) {
        #[cfg(windows)]
        let native_root = root.to_str().unwrap().replace('\\', "/");
        // Windows sidecar records contain case-folded directory keys, not the
        // filesystem's original mixed-case spelling.
        #[cfg(windows)]
        let root_binding = native_root
            .strip_prefix("//?/")
            .unwrap_or(&native_root)
            .to_lowercase();
        #[cfg(windows)]
        let root = Path::new(&root_binding);
        match value {
            Value::String(string) => *string = string.replace("<fixture>", root.to_str().unwrap()),
            Value::Array(values) => values.iter_mut().for_each(|value| relocate(value, root)),
            Value::Object(values) => values.values_mut().for_each(|value| relocate(value, root)),
            _ => {}
        }
    }

    fn setup_fixture(table: &Value, fixture: &Value) {
        for repository in fixture["repositories"].as_array().unwrap() {
            let root = Path::new(repository["root"].as_str().unwrap());
            let git_dir = repository["gitDir"].as_str().unwrap();
            std::fs::create_dir_all(root).unwrap();
            match repository["kind"].as_str().unwrap() {
                "worktree" => {
                    let main = Path::new(repository["mainRoot"].as_str().unwrap());
                    git_input(
                        main,
                        &[
                            "worktree",
                            "add",
                            "--detach",
                            root.to_str().unwrap(),
                            "HEAD",
                        ],
                        b"",
                    );
                    continue;
                }
                "main" => {
                    git_input(root, &["init", "-q", "-b", "main"], b"");
                }
                "separate" | "submodule" => {
                    std::fs::create_dir_all(Path::new(git_dir).parent().unwrap()).unwrap();
                    git_input(
                        root,
                        &["init", "-q", "-b", "main", "--separate-git-dir", git_dir],
                        b"",
                    );
                }
                other => panic!("unknown repository kind {other}"),
            }
            git_input(root, &["hash-object", "-w", "-t", "tree", "--stdin"], b"");
            let commit = git_input(
                root,
                &["hash-object", "-w", "-t", "commit", "--stdin"],
                table["gitCommit"].as_str().unwrap().as_bytes(),
            );
            assert_eq!(commit, table["gitRootCommit"].as_str().unwrap());
            git_input(root, &["update-ref", "HEAD", &commit], b"");
        }
        for directory in fixture["directories"].as_array().unwrap() {
            std::fs::create_dir_all(directory.as_str().unwrap()).unwrap();
        }
    }

    #[derive(Clone)]
    struct LogCapture(Arc<Mutex<Vec<u8>>>);
    impl Write for LogCapture {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn sidecar_bytes(sidecars: &Path) -> HashMap<PathBuf, Vec<u8>> {
        std::fs::read_dir(sidecars)
            .unwrap()
            .map(|entry| {
                let file = entry.unwrap().path();
                let bytes = std::fs::read(&file).unwrap();
                (file, bytes)
            })
            .collect()
    }

    async fn parity_case(name: &str) {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        let mut table: Value = serde_json::from_str(PARITY).unwrap();
        relocate(&mut table, &root);
        let case = table["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|case| case["name"] == name)
            .unwrap();
        let fixture = &table["fixtures"][case["fixture"].as_str().unwrap()];
        setup_fixture(&table, fixture);
        let sidecars = root.join("project-identities");
        std::fs::create_dir(&sidecars).unwrap();
        for record in case["sidecars"].as_array().unwrap() {
            let directory = Path::new(record["directory"].as_str().unwrap());
            std::fs::write(
                sidecar_path(&sidecars, directory),
                serde_json::to_vec_pretty(record).unwrap(),
            )
            .unwrap();
        }
        let before = sidecar_bytes(&sidecars);
        let resolver = ProjectIdentityResolver::with_sidecar_dir(sidecars.clone());
        let directory = Path::new(case["directory"].as_str().unwrap());
        let calls = std::cell::Cell::new(0);
        let logs = LogCapture(Arc::default());
        let sink = logs.clone();
        let subscriber = tracing_subscriber::fmt()
            .without_time()
            .with_ansi(false)
            .with_max_level(tracing::Level::WARN)
            .with_writer(move || sink.clone())
            .finish();
        let _subscriber = tracing::subscriber::set_default(subscriber);
        let attempt = async {
            calls.set(calls.get() + 1);
            match case["answer"].as_str() {
                Some("absent") => ResolveAnswer::Absent,
                Some("not_answering") => ResolveAnswer::NotAnswering,
                _ => {
                    let recipe = &case["answer"];
                    assert_eq!(recipe["file"], "resolve.json");
                    let vectors: Value = serde_json::from_str(RESOLVE).unwrap();
                    let mut vector =
                        vectors[recipe["caseIndex"].as_u64().unwrap() as usize].clone();
                    substitute(&mut vector, recipe["replaceStrings"].as_object().unwrap());
                    if let Some(mutations) = recipe["mutations"].as_array() {
                        for mutation in mutations {
                            let path = mutation["path"].as_array().unwrap();
                            let mut destination = &mut vector;
                            for key in &path[..path.len() - 1] {
                                destination = &mut destination[key.as_str().unwrap()];
                            }
                            destination[path.last().unwrap().as_str().unwrap()] =
                                mutation["value"].clone();
                        }
                    }
                    decode_reply(&serde_json::to_vec(&vector["reply"]).unwrap())
                }
            }
        };
        GIT_PROBES.with(|probes| probes.set(0));
        let eligibility = resolver
            .eligible_directory_with_home(directory, fixture["home"].as_str().map(Path::new));
        let result = match eligibility {
            Ok(_) => resolve_with_attempt(&resolver, directory, attempt).await,
            Err(error) => Err(error),
        };
        let expected = &case["expected"];
        if expected["identity"].is_null() {
            assert!(
                matches!(result, Err(ProjectIdentityError::HomeDirectory { .. })),
                "{name}: {result:?}"
            );
        } else {
            assert_eq!(
                result.unwrap(),
                expected["identity"].as_str().unwrap(),
                "{name}"
            );
        }
        let expected_calls = expected["resolveCalls"].as_u64().unwrap_or_else(|| {
            if case["answer"] == "absent" {
                0
            } else {
                1
            }
        });
        // An absent endpoint makes no resolve call, even though its future is polled.
        assert_eq!(
            if case["answer"] == "absent" {
                0
            } else {
                calls.get()
            },
            expected_calls,
            "{name}: resolve calls"
        );
        if let Some(expected_probes) = expected["gitProbeCalls"].as_u64() {
            assert_eq!(
                GIT_PROBES.with(|probes| probes.get()),
                expected_probes as usize,
                "{name}: git probes"
            );
        }
        let common = result_common_dir(&resolver, directory, expected["identity"].is_null());
        assert_eq!(common, expected["gitCommonDir"], "{name}: common dir");
        resolver.flush_pins();
        let after = sidecar_bytes(&sidecars);
        let mut writes: Vec<Value> = after
            .iter()
            .filter(|(file, bytes)| before.get(*file) != Some(*bytes))
            .map(|(_, bytes)| serde_json::from_slice(bytes).unwrap())
            .collect();
        let mut wanted = expected["sidecarWrites"].as_array().unwrap().clone();
        writes.sort_by_key(Value::to_string);
        wanted.sort_by_key(Value::to_string);
        assert_eq!(writes, wanted, "{name}: writes");
        for (file, bytes) in &before {
            if !writes.iter().any(|record| {
                sidecar_path(&sidecars, Path::new(record["directory"].as_str().unwrap())) == *file
            }) {
                assert_eq!(after.get(file), Some(bytes), "{name}: unchanged sidecar");
            }
        }
        let log_text = String::from_utf8(logs.0.lock().unwrap().clone()).unwrap();
        for (field, message) in [
            (
                "ignoredImplicitSidecarLogs",
                "Ignoring an implicit project identity sidecar",
            ),
            ("commonDirConflictLogs", "Conflicting project pins"),
        ] {
            if let Some(count) = expected[field].as_u64() {
                assert_eq!(
                    log_text.matches(message).count(),
                    count as usize,
                    "{name}: {log_text}"
                );
            }
        }
        if let Some(count) = expected["resolveLogs"].as_u64() {
            assert_eq!(
                log_text
                    .lines()
                    .filter(|line| line.contains("Entorhinal"))
                    .count(),
                count as usize,
                "{name}: {log_text}"
            );
        }
    }

    fn result_common_dir(
        resolver: &ProjectIdentityResolver,
        directory: &Path,
        refused: bool,
    ) -> Value {
        if refused {
            return Value::Null;
        }
        resolver
            .sidecar_dir
            .as_deref()
            .and_then(|sidecars| read_record(sidecars, directory))
            .and_then(|record| record.git_common_dir)
            .or_else(|| git_checkout(directory).map(|checkout| checkout.git_common_dir))
            .map(Value::String)
            .unwrap_or(Value::Null)
    }

    macro_rules! parity_tests {
        ($($test:ident => $name:literal),+ $(,)?) => { $(
            #[tokio::test]
            async fn $test() { parity_case($name).await; }
        )+ };
    }

    parity_tests! {
        registered_root => "registered-root",
        registered_subfolder => "registered-subfolder",
        registered_linked_worktree => "registered-linked-worktree",
        unregistered_checkout => "unregistered-checkout",
        implicit_sidecar_is_ignored => "implicit-sidecar-is-ignored",
        nested_registration_without_parent_pin => "nested-registration-without-parent-pin",
        nested_registration_with_parent_pin => "nested-registration-with-parent-pin",
        common_dir_main => "common-dir-main",
        common_dir_separate_main => "common-dir-separate-main",
        common_dir_separate_linked_worktree => "common-dir-separate-linked-worktree",
        common_dir_submodule => "common-dir-submodule",
        single_common_dir_pin_not_answering => "single-common-dir-pin-not-answering",
        single_common_dir_pin_implicit_worktree => "single-common-dir-pin-implicit-worktree",
        single_common_dir_pin_implicit_subfolder => "single-common-dir-pin-implicit-subfolder",
        single_common_dir_pin_not_answering_subfolder => "single-common-dir-pin-not-answering-subfolder",
        conflicting_common_dir_pins => "conflicting-common-dir-pins",
        duplicate_common_dir_pins_same_identity => "duplicate-common-dir-pins-same-identity",
        pin_is_total_over_registered_answer => "pin-is-total-over-registered-answer",
        pin_is_total_over_implicit_answer => "pin-is-total-over-implicit-answer",
        gone_registered_root_is_accepted => "gone-registered-root-is-accepted",
        tolerant_reader_unknown_via => "tolerant-reader-unknown-via",
        tolerant_reader_extra_field => "tolerant-reader-extra-field",
        tolerant_reader_decode_failure => "tolerant-reader-decode-failure",
        error_invalid_params => "error-invalid-params",
        error_storage_unavailable => "error-storage-unavailable",
        legacy_git_record_replaced_by_live_project_pin => "legacy-git-record-replaced-by-live-project-pin",
        pj_pin_preserves_sidecar_bytes => "pj-pin-preserves-sidecar-bytes",
        walk_subfolder_canonical_root_equals_checkout => "walk-subfolder-canonical-root-equals-checkout",
        walk_subfolder_canonical_root_differs_from_checkout => "walk-subfolder-canonical-root-differs-from-checkout",
        home_directory_refused_before_resolve => "home-directory-refused-before-resolve",
    }

    #[test]
    fn legacy_git_write_never_replaces_a_project_pin() {
        let temp = tempfile::tempdir().unwrap();
        let resolver = ProjectIdentityResolver::with_sidecar_dir(temp.path().join("sidecars"));
        let directory = temp.path().join("repo");
        std::fs::create_dir(&directory).unwrap();
        resolver.pin_live_answer(&directory, "pj-A", Some(&directory));
        resolver.flush_pins();
        let sidecars = resolver.sidecar_dir.as_deref().unwrap();
        let before = sidecar_bytes(sidecars);
        remember_git_identity(
            &resolver.pin_writer,
            sidecars,
            &directory,
            "git:123456789abcdef",
        );
        assert_eq!(sidecar_bytes(sidecars), before);
    }

    #[test]
    fn project_pin_grammar_rejects_implicit_and_non_ascii_values() {
        for valid in ["pj-A", "pj-a_Z-09", "pj--"] {
            assert!(is_project_pin(valid));
        }
        for invalid in ["pj-", "pj-implicit1-abc", "pj-A.b", "pj-ä", "git:1234567"] {
            assert!(!is_project_pin(invalid));
        }
    }

    #[test]
    fn pins_override_cached_git_and_reclones_without_probes() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("repo");
        let mut table: Value = serde_json::from_str(PARITY).unwrap();
        relocate(&mut table, temp.path());
        setup_fixture(&table, &table["fixtures"]["main"]);
        let resolver = ProjectIdentityResolver::with_sidecar_dir(temp.path().join("sidecars"));
        assert!(resolver.resolve(&directory).unwrap().starts_with("git:"));
        resolver.pin_live_answer(&directory, "pj-stable", Some(&directory));
        std::fs::remove_dir_all(directory.join(".git")).unwrap();
        git_input(&directory, &["init", "-q", "-b", "replacement"], b"");
        GIT_PROBES.with(|probes| probes.set(0));
        assert_eq!(resolver.resolve(&directory).unwrap(), "pj-stable");
        resolver.flush_pins();
        let restarted = ProjectIdentityResolver::with_sidecar_dir(temp.path().join("sidecars"));
        assert_eq!(restarted.resolve(&directory).unwrap(), "pj-stable");
        assert_eq!(GIT_PROBES.with(|probes| probes.get()), 0);
    }

    #[test]
    fn implicit_ids_are_never_persisted() {
        let temp = tempfile::tempdir().unwrap();
        let sidecars = temp.path().join("sidecars");
        let resolver = ProjectIdentityResolver::with_sidecar_dir(sidecars.clone());
        let vectors: Value = serde_json::from_str(RESOLVE).unwrap();
        let implicit = vectors[3]["reply"]["result"]["projectId"].as_str().unwrap();
        resolver.pin_live_answer(temp.path(), implicit, Some(temp.path()));
        assert!(!sidecars.exists());
    }

    #[test]
    fn a_worktree_with_unavailable_common_metadata_is_never_pinned() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("worktree");
        let metadata = temp.path().join("worktree-metadata");
        std::fs::create_dir(&directory).unwrap();
        std::fs::create_dir(&metadata).unwrap();
        std::fs::write(directory.join(".git"), "gitdir: ../worktree-metadata\n").unwrap();
        let sidecars = temp.path().join("sidecars");
        let resolver = ProjectIdentityResolver::with_sidecar_dir(sidecars.clone());
        for contents in ["../missing", ""] {
            std::fs::write(metadata.join("commondir"), contents).unwrap();
            assert!(git_checkout(&directory).is_none());
            resolver.pin_live_answer(&directory, "pj-A", Some(&directory));
            assert!(!sidecars.exists());
        }
    }

    #[cfg(unix)]
    #[test]
    fn common_dir_follows_symlinks_without_git_probes() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("repo");
        let metadata = temp.path().join("metadata");
        std::fs::create_dir(&directory).unwrap();
        std::fs::create_dir(&metadata).unwrap();
        std::os::unix::fs::symlink(&metadata, temp.path().join("alias")).unwrap();
        std::fs::write(directory.join(".git"), "gitdir: ../alias\n").unwrap();
        GIT_PROBES.with(|probes| probes.set(0));
        let checkout = git_checkout(&directory).unwrap();
        assert_eq!(
            checkout.git_common_dir,
            project_directory_key(&std::fs::canonicalize(metadata).unwrap())
        );
        assert!(!checkout.worktree);
        assert_eq!(GIT_PROBES.with(|probes| probes.get()), 0);
    }

    #[cfg(unix)]
    #[test]
    fn root_pin_requires_equal_canonical_spellings_and_preserves_existing_pins() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("repo");
        std::fs::create_dir_all(directory.join(".git")).unwrap();
        let child = directory.join("sub");
        std::fs::create_dir(&child).unwrap();
        let alias = temp.path().join("alias");
        std::os::unix::fs::symlink(&directory, &alias).unwrap();
        let sidecars = temp.path().join("sidecars");
        let resolver = ProjectIdentityResolver::with_sidecar_dir(sidecars.clone());
        resolver.pin_live_answer(&child, "pj-B", Some(&alias));
        assert_eq!(
            resolver.pinned_identity(&directory).as_deref(),
            Some("pj-B")
        );
        resolver.flush_pins();
        let before = std::fs::read(sidecar_path(&sidecars, &directory)).unwrap();
        resolver.pin_live_answer(&child, "pj-C", Some(&alias));
        assert_eq!(
            std::fs::read(sidecar_path(&sidecars, &directory)).unwrap(),
            before
        );
    }
}
