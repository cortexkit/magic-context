//! A project's checkout, as the code-reading dreamer tasks see it: the files
//! git tracks, the commit it is at, what changed since an earlier commit,
//! and a bounded literal search over the tracked files.
//!
//! The verify tasks use it twice. Before a batch is sent, the module looks
//! up each path and code name a memory cites, so the model is told which
//! ones a plain search did not find. When a reply archives a memory because
//! everything it cites is gone, the module looks the name the reply gives up
//! again before anything is written, and asks git whether the checked-out
//! history ever held it: a name that was never here was not removed.
//!
//! Git runs with a timeout and a cap on what it prints, as the upkeep's
//! commit indexer runs it, and never with an external diff or text
//! conversion driver.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

/// How long one git command may run before it is killed.
const GIT_TIMEOUT: Duration = Duration::from_secs(30);
/// Output past this many bytes is a failure, not a truncated answer.
const GIT_MAX_OUTPUT: usize = 64 * 1024 * 1024;

/// How far one literal search may go before it stops and says so.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Limits {
    pub max_files: usize,
    pub max_time: Duration,
}

/// The search the verify tasks run: far more files than a large repository
/// holds, and a few seconds, which reading every file of one takes.
pub(crate) const SEARCH_LIMITS: Limits = Limits {
    max_files: 50_000,
    max_time: Duration::from_secs(10),
};

/// What one literal search found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Search {
    /// For each name searched, in order, whether some tracked file holds it
    /// or some tracked path contains it.
    pub found: Vec<bool>,
    /// Tracked files read.
    pub files: usize,
    /// A limit stopped the search before every file was read, or a file
    /// could not be read. A name not found then may still be in the
    /// checkout, so nothing may be concluded from its absence.
    pub cut: bool,
    pub elapsed_ms: u64,
}

/// A project's checkout at the moment it was opened.
pub(crate) struct Checkout {
    /// The folder, canonical, so a resolved file can be checked to be
    /// inside it.
    root: PathBuf,
    /// Every path git tracks, relative to the root, with `/` separators.
    tracked: BTreeSet<String>,
    /// The names at the top of the checkout (see [`Checkout::top_level`]).
    top_level: BTreeSet<String>,
    head: Option<String>,
    /// Every tracked file and folder under each name it can be cited by,
    /// built on first use (see [`Checkout::has_path`]).
    cited_paths: OnceLock<HashSet<String>>,
}

impl Checkout {
    /// Read the checkout at `root`. Fails when the folder is missing or git
    /// can't list its tracked files.
    pub(crate) fn open(root: &Path) -> Result<Self, String> {
        let root = root
            .canonicalize()
            .map_err(|error| format!("the project folder {}: {error}", root.display()))?;
        let listed = run_git(&root, &["ls-files", "-z", "--cached"]).map_err(|error| {
            format!(
                "listing the files git tracks in {}: {error}",
                root.display()
            )
        })?;
        let tracked: BTreeSet<String> = listed
            .split('\0')
            .filter(|path| !path.is_empty())
            .map(str::to_owned)
            .collect();
        // `.cortexkit` holds the project's local notes, which git may ignore
        // in part or in whole, and memories cite paths inside it.
        let top_level = tracked
            .iter()
            .filter_map(|path| path.split('/').next())
            .chain([".cortexkit"])
            .map(str::to_owned)
            .collect();
        let head = run_git(&root, &["rev-parse", "HEAD"])
            .ok()
            .map(|text| text.trim().to_owned())
            .filter(|text| is_commit(text));
        Ok(Self {
            root,
            tracked,
            top_level,
            head,
            cited_paths: OnceLock::new(),
        })
    }

    /// The commit checked out when the checkout was opened, when there is
    /// one.
    pub(crate) fn head(&self) -> Option<&str> {
        self.head.as_deref()
    }

    /// The files and folders at the top of the checkout: the first part of
    /// every tracked path, and `.cortexkit`.
    pub(crate) fn top_level(&self) -> &BTreeSet<String> {
        &self.top_level
    }

    /// `relative` as a tracked file path, when it names a tracked file that
    /// exists inside the checkout. A tracked symlink that leads outside it
    /// does not count.
    pub(crate) fn tracked_file(&self, relative: &str) -> Option<String> {
        let path = relative.trim().replace('\\', "/");
        let path = path.strip_prefix("./").unwrap_or(&path);
        if !self.tracked.contains(path) {
            return None;
        }
        let resolved = self.root.join(path).canonicalize().ok()?;
        (resolved.starts_with(&self.root) && resolved.is_file()).then(|| path.to_owned())
    }

    /// Whether `cited` names a tracked file or a folder holding tracked
    /// files. A path counts when it is the whole path from the root or its
    /// end, cut at a `/`: memories often cite `dreamer/task.rs` for
    /// `crates/mc-module/src/dreamer/task.rs`. `None` when `cited` holds no
    /// path at all.
    pub(crate) fn has_path(&self, cited: &str) -> Option<bool> {
        let path = clean_path(cited)?;
        let known = self.cited_paths.get_or_init(|| {
            let mut known = HashSet::new();
            for file in &self.tracked {
                let parts: Vec<&str> = file.split('/').collect();
                // Every tail of the file's path, and every tail of each
                // folder above it.
                for end in 1..=parts.len() {
                    for start in 0..end {
                        known.insert(parts[start..end].join("/"));
                    }
                }
            }
            known
        });
        Some(known.contains(&path))
    }

    /// Whether some commit of the checked-out history touched a file at the
    /// path `cited` or under it, the path matched whole or by its end as
    /// [`Checkout::has_path`] matches it. `Err` when `cited` holds no path,
    /// or git fails or runs longer than `timeout`.
    pub(crate) fn path_in_history(&self, cited: &str, timeout: Duration) -> Result<bool, String> {
        let path = clean_path(cited).ok_or_else(|| format!("{cited} is not a path"))?;
        // A glob pathspec, so the path is matched under any folder; the
        // characters a glob reads are escaped to stand for themselves.
        let mut escaped = String::with_capacity(path.len());
        for ch in path.chars() {
            if matches!(ch, '*' | '?' | '[' | '\\') {
                escaped.push('\\');
            }
            escaped.push(ch);
        }
        let itself = format!(":(glob)**/{escaped}");
        let inside = format!(":(glob)**/{escaped}/**");
        run_git_within(
            &self.root,
            &["log", "--format=%H", "-1", "--", &itself, &inside],
            timeout,
        )
        .map(|listed| names_a_commit(&listed))
    }

    /// Whether some commit of the checked-out history added or removed
    /// `text` as literal text in a file (git's pickaxe, `git log -S`).
    /// `Err` when git fails or runs longer than `timeout`.
    pub(crate) fn text_in_history(&self, text: &str, timeout: Duration) -> Result<bool, String> {
        let pickaxe = format!("-S{text}");
        run_git_within(
            &self.root,
            &[
                "log",
                &pickaxe,
                "--no-ext-diff",
                "--no-textconv",
                "--format=%H",
                "-1",
            ],
            timeout,
        )
        .map(|listed| names_a_commit(&listed))
    }

    /// Look for each of `names` as literal bytes in the tracked paths and in
    /// every tracked file, stopping once all are found or a limit is
    /// reached. A name shorter than four bytes always counts as found: it is
    /// too short to say anything by its absence.
    pub(crate) fn search(&self, names: &[&str], limits: &Limits) -> Search {
        let started = Instant::now();
        let mut matcher = Matcher::new(names);
        let mut cut = false;
        let mut files = 0;
        let paths: String = self
            .tracked
            .iter()
            .map(|path| format!("{path}\n"))
            .collect();
        matcher.scan(paths.as_bytes());
        for path in &self.tracked {
            if matcher.remaining == 0 {
                break;
            }
            if files >= limits.max_files || started.elapsed() >= limits.max_time {
                cut = true;
                break;
            }
            files += 1;
            let full = self.root.join(path);
            // A tracked symlink may lead outside the checkout, and a
            // submodule is a folder: neither is read.
            match std::fs::symlink_metadata(&full) {
                Ok(metadata) if metadata.is_file() => {}
                Ok(_) => continue,
                // Deleted from the working tree but still in the index.
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => {
                    cut = true;
                    continue;
                }
            }
            match std::fs::read(&full) {
                Ok(bytes) => matcher.scan(&bytes),
                Err(_) => cut = true,
            }
        }
        Search {
            found: matcher.found,
            files,
            cut,
            elapsed_ms: started.elapsed().as_millis() as u64,
        }
    }

    /// The tracked files that differ between `commit` and the working tree,
    /// uncommitted changes included. `None` when git can't tell, for
    /// example because the commit is gone.
    pub(crate) fn changed_since(&self, commit: &str) -> Option<BTreeSet<String>> {
        if !is_commit(commit) {
            return None;
        }
        let listed = run_git(
            &self.root,
            &["diff", "--name-only", "--no-renames", "-z", commit, "--"],
        )
        .ok()?;
        Some(
            listed
                .split('\0')
                .filter(|path| !path.is_empty())
                .map(str::to_owned)
                .collect(),
        )
    }

    /// The tracked files with uncommitted changes.
    pub(crate) fn uncommitted(&self) -> Option<BTreeSet<String>> {
        self.changed_since(self.head()?)
    }

    /// When the last commit touching `file` was made, in milliseconds.
    pub(crate) fn last_commit_ms(&self, file: &str) -> Option<i64> {
        run_git(&self.root, &["log", "-1", "--format=%ct", "--", file])
            .ok()?
            .trim()
            .parse::<i64>()
            .ok()
            .map(|seconds| seconds.saturating_mul(1_000))
    }

    /// `file`'s changes from `base` to the working tree, as a unified diff.
    pub(crate) fn diff(&self, base: &str, file: &str) -> Option<String> {
        if !is_commit(base) {
            return None;
        }
        run_git(
            &self.root,
            &[
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                base,
                "--",
                file,
            ],
        )
        .ok()
    }
}

/// `cited` as a path relative to some folder: `/` separators, without a
/// leading `./`, a trailing `/`, or a line reference (`:12`, `#L12`).
/// `None` when nothing is left, or when it starts at the filesystem's root
/// or the home folder, which a checkout's paths never do.
pub(crate) fn clean_path(cited: &str) -> Option<String> {
    let mut path = cited.trim().replace('\\', "/");
    if path.starts_with('/') || path.starts_with('~') || path.contains("://") {
        return None;
    }
    if let Some(at) = path.find("#L") {
        path.truncate(at);
    }
    // `file.rs:12` or `file.rs:12:4`.
    while let Some((head, tail)) = path.rsplit_once(':') {
        if tail.is_empty() || !tail.bytes().all(|byte| byte.is_ascii_digit()) {
            break;
        }
        path = head.to_owned();
    }
    while let Some(rest) = path.strip_prefix("./") {
        path = rest.to_owned();
    }
    let path = path.trim_end_matches('/').to_owned();
    (!path.is_empty() && !path.split('/').any(|part| part.is_empty() || part == ".."))
        .then_some(path)
}

fn is_commit(text: &str) -> bool {
    text.len() == 40 && text.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Whether `git log --format=%H` printed a commit id.
fn names_a_commit(listed: &str) -> bool {
    listed.lines().any(|line| {
        let line = line.trim();
        !line.is_empty() && line.bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

/// Finds which of many names occur in a text, each at most once. Every
/// position of the text is compared with the names that start with the same
/// four bytes, so names that overlap each other in the text are all found.
struct Matcher<'a> {
    names: Vec<&'a [u8]>,
    /// The names by their first four bytes.
    by_prefix: HashMap<u32, Vec<usize>>,
    /// One bit for each pair of first two bytes some name starts with, so
    /// most positions are passed over without a map lookup.
    pairs: Vec<u64>,
    found: Vec<bool>,
    remaining: usize,
}

impl<'a> Matcher<'a> {
    fn new(names: &[&'a str]) -> Self {
        let mut matcher = Self {
            names: names.iter().map(|name| name.as_bytes()).collect(),
            by_prefix: HashMap::new(),
            pairs: vec![0; 1024],
            found: vec![false; names.len()],
            remaining: 0,
        };
        for (index, name) in matcher.names.iter().enumerate() {
            if name.len() < 4 {
                matcher.found[index] = true;
                continue;
            }
            matcher
                .by_prefix
                .entry(u32::from_le_bytes([name[0], name[1], name[2], name[3]]))
                .or_default()
                .push(index);
            let pair = usize::from(name[0]) | (usize::from(name[1]) << 8);
            matcher.pairs[pair >> 6] |= 1 << (pair & 63);
            matcher.remaining += 1;
        }
        matcher
    }

    fn scan(&mut self, text: &[u8]) {
        if self.remaining == 0 || text.len() < 4 {
            return;
        }
        for at in 0..=text.len() - 4 {
            let pair = usize::from(text[at]) | (usize::from(text[at + 1]) << 8);
            if self.pairs[pair >> 6] & (1 << (pair & 63)) == 0 {
                continue;
            }
            let key = u32::from_le_bytes([text[at], text[at + 1], text[at + 2], text[at + 3]]);
            let Some(candidates) = self.by_prefix.get(&key) else {
                continue;
            };
            for &index in candidates {
                if !self.found[index] && text[at..].starts_with(self.names[index]) {
                    self.found[index] = true;
                    self.remaining -= 1;
                    if self.remaining == 0 {
                        return;
                    }
                }
            }
        }
    }
}

/// Run git in `root` and return what it prints, or why it failed, killing
/// it after [`GIT_TIMEOUT`].
fn run_git(root: &Path, args: &[&str]) -> Result<String, String> {
    run_git_within(root, args, GIT_TIMEOUT)
}

/// [`run_git`], killing git after `timeout`.
fn run_git_within(root: &Path, args: &[&str], timeout: Duration) -> Result<String, String> {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(root)
        // A read must not take git's index lock, which a person's own git
        // command in the same checkout would then find held.
        .env("GIT_OPTIONAL_LOCKS", "0")
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
    // Both pipes are drained while git runs, so a long answer can't block it.
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
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(5)),
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
        None => Err(format!("git {} timed out", args.first().unwrap_or(&""))),
        Some(status) if !status.success() => Err(stderr.trim().chars().take(500).collect()),
        Some(_) if stdout.len() > GIT_MAX_OUTPUT => Err(format!(
            "git {} printed too much",
            args.first().unwrap_or(&"")
        )),
        Some(_) => Ok(String::from_utf8_lossy(&stdout).into_owned()),
    }
}

#[cfg(test)]
#[path = "checkout_tests.rs"]
pub(crate) mod tests;
