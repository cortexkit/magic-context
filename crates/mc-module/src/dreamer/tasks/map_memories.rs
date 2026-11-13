//! The `map-memories` task: find the repository files that back each live
//! project memory, so that when a commit changes a file, verify knows which
//! memories to check again.
//!
//! Ported from the 0.49.x Rust module kept for reference in `crates_old/`
//! (`mc-module/src/dream_tasks/classify.rs`, `dream_dispatch/classify_host.rs`
//! and `mc-store/src/dream_memory.rs`), with the identifier search the 0.49
//! plugin added (`seedIdentifierCandidates` in `map-memories-prompt.ts`).
//!
//! A run sends every live memory of the project that has no mapping yet,
//! then up to twenty memories marked file-independent by the model whose own
//! text names a file that exists, twenty memories per message. Before a
//! message goes out the module lists each memory's likely files: the paths
//! its text names that the checkout tracks, and for a memory naming none, the
//! files where a bounded literal search finds the code names it mentions. The
//! model reads the checkout with AFT's read-only tools ([`super::super::plan`])
//! and answers with one `<mappings>` manifest.
//!
//! The manifest is checked one entry at a time. An id the batch didn't send,
//! or a memory changed since the batch read it, is dropped with its reason.
//! Each file must be tracked by git, exist, and stay inside the checkout once
//! its links are resolved. `independent="true"` is stored as the
//! file-independent mark (one row with an empty path). An entry whose files
//! all fail, or that maps a directive-shaped project rule to files, is stored
//! as file-independent too, marked `host_rejected_fallback`, so the memory is
//! not sent again on every run. A memory the reply leaves out stays unmapped.
//!
//! A mapping is not part of what a memory says: writing one leaves the
//! memory's row and revision alone and keeps no undo-history row. Each
//! message's writes are recorded as one journal entry keyed by the run,
//! holding every mapped memory's rows before and after, so undoing the run
//! puts the old mappings back ([`crate::memory_writes::person::undo_run`]).

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Value};

use super::classify::{attribute, body, describe_shape, re};
use crate::dreamer::run::{TaskInput, TaskReply};
use crate::dreamer::task::{task_prompts, Applied, Batch, Owner, Task, TaskContext};
use crate::memory_profile::Profile;
use crate::memory_writes::now_ms;
use crate::summary::fit::Window;

/// The kind memory profiles name.
pub(crate) const KIND: &str = "map-memories";
/// Magic Context's frame that the task's message fills with the memories.
const INPUT_FRAME: &str = "dreamer/map-memories.input";
/// Who the journal names as the decider.
const WRITER: &str = "dreamer:map-memories";
/// The operation the journal records.
pub(crate) const OPERATION: &str = "map";
/// At most this many memories go in one message.
pub(crate) const BATCH_SIZE: usize = 20;
/// At most this many memories already marked file-independent are sent
/// again in one run (see [`select`]).
pub(crate) const MAX_REPAIRS: usize = 20;
/// The origin of a mapping the model chose.
pub(crate) const MAPPER: &str = "mapper";
/// The origin of a file-independent mark the module wrote in place of files
/// it refused.
pub(crate) const REJECTED: &str = "host_rejected_fallback";
/// The category whose directive-shaped memories never map to files.
const PROJECT_RULES: &str = "swe:project-rules";
/// The extensions a path the memory names must end in when the profile
/// gives none (`map_extensions`).
const DEFAULT_EXTENSIONS: [&str; 14] = [
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "rs", "go", "py", "json", "jsonc", "sql", "toml", "sh",
];
/// How many likely files one memory gets when the profile doesn't say
/// (`seed_paths_per_memory`).
const DEFAULT_SEEDS: usize = 3;
/// How many code names of one memory the literal search looks for.
const NAMES_PER_MEMORY: usize = 3;
/// How long the literal search may take, and how much it may print, before
/// its result is ignored.
const SEARCH_TIMEOUT: Duration = Duration::from_secs(2);
const SEARCH_MAX_OUTPUT: usize = 256 * 1024;
/// How long listing the checkout's tracked files may take, and how much it
/// may print.
const LIST_TIMEOUT: Duration = Duration::from_secs(30);
const LIST_MAX_OUTPUT: usize = 64 * 1024 * 1024;

/// One live project memory as the task reads it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Memory {
    pub id: i64,
    /// The tag it was written under (`origin_category`), which the message
    /// shows.
    pub tag: String,
    /// Its profile category (`swe:project-rules`).
    pub category: String,
    pub content: String,
    pub revision: i64,
    /// Its mapping rows as (path, origin), by path. Empty when unmapped; the
    /// file-independent mark is the row with the empty path.
    pub mapping: Vec<(String, String)>,
}

/// `project`'s live memories with their mappings, by id.
pub(crate) fn live_memories(conn: &Connection, project: &str) -> rusqlite::Result<Vec<Memory>> {
    let mut memories: Vec<Memory> = conn
        .prepare(
            "SELECT id, origin_category, category, content, revision FROM memories
              WHERE level = 'project' AND owner_id = ?1 AND status IN ('active', 'permanent')
              ORDER BY id",
        )?
        .query_map(params![project], |row| {
            Ok(Memory {
                id: row.get(0)?,
                tag: row.get(1)?,
                category: row.get(2)?,
                content: row.get(3)?,
                revision: row.get(4)?,
                mapping: Vec::new(),
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut mappings: HashMap<i64, Vec<(String, String)>> = HashMap::new();
    let mut statement = conn.prepare(
        "SELECT v.memory_id, v.file_path, v.mapping_origin FROM memory_verifications v
           JOIN memories m ON m.id = v.memory_id
          WHERE m.level = 'project' AND m.owner_id = ?1 AND m.status IN ('active', 'permanent')
          ORDER BY v.memory_id, v.file_path",
    )?;
    let rows = statement.query_map(params![project], |row| {
        Ok((row.get::<_, i64>(0)?, row.get(1)?, row.get(2)?))
    })?;
    for row in rows {
        let (id, path, origin) = row?;
        mappings.entry(id).or_default().push((path, origin));
    }
    for memory in &mut memories {
        memory.mapping = mappings.remove(&memory.id).unwrap_or_default();
    }
    Ok(memories)
}

/// One memory as a message shows it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Input {
    pub id: i64,
    pub tag: String,
    pub content: String,
    /// Its likely files, confirmed to be tracked files of the checkout.
    pub candidates: Vec<String>,
}

impl Input {
    fn of(memory: &Memory, candidates: Vec<String>) -> Self {
        Self {
            id: memory.id,
            tag: memory.tag.clone(),
            content: memory.content.clone(),
            candidates,
        }
    }
}

/// What a run maps, in order: every memory with no mapping, then up to
/// [`MAX_REPAIRS`] memories whose only mapping is a file-independent mark
/// the model chose although their text names a file that exists. A silent
/// parse miss in an older dreamer stored such marks for memories with real
/// files, and a memory marked file-independent is never verified against
/// code. A mark the module wrote in place of refused files is a decision,
/// not a miss, and is left alone. `candidates` gives a memory's likely files
/// from the paths its text names.
pub(crate) fn select(
    live: &[Memory],
    mut candidates: impl FnMut(&Memory) -> Vec<String>,
) -> Vec<Input> {
    let mut inputs: Vec<Input> = live
        .iter()
        .filter(|memory| memory.mapping.is_empty())
        .map(|memory| Input::of(memory, candidates(memory)))
        .collect();
    let mut repairs = 0;
    for memory in live {
        if repairs >= MAX_REPAIRS {
            break;
        }
        let marked = memory.mapping.iter().any(|(path, _)| path.is_empty());
        let files = memory.mapping.iter().any(|(path, _)| !path.is_empty());
        let origin = memory.mapping.first().map(|(_, origin)| origin.as_str());
        if !marked || files || origin == Some(REJECTED) {
            continue;
        }
        let found = candidates(memory);
        if !found.is_empty() {
            inputs.push(Input::of(memory, found));
            repairs += 1;
        }
    }
    inputs
}

/// The extensions a likely file may have, from the profile's `map_extensions`.
pub(crate) fn extensions(declaration: &Value) -> Vec<String> {
    let given: Vec<String> = declaration["settings"]["map_extensions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    if given.is_empty() {
        DEFAULT_EXTENSIONS
            .iter()
            .map(|ext| (*ext).to_owned())
            .collect()
    } else {
        given
    }
}

/// How many likely files one memory gets, from the profile's
/// `seed_paths_per_memory`.
pub(crate) fn seeds(declaration: &Value) -> usize {
    declaration["settings"]["seed_paths_per_memory"]
        .as_u64()
        .and_then(|seeds| usize::try_from(seeds).ok())
        .filter(|seeds| *seeds > 0)
        .unwrap_or(DEFAULT_SEEDS)
}

/// The pattern of a repository-relative path with one of `extensions`, as a
/// memory names it: at least one folder, optionally in backticks.
fn path_pattern(extensions: &[String]) -> Regex {
    // The longest extension is tried first, so `a/b.tsx` reads as itself
    // and not as `a/b.ts` followed by an `x`.
    let mut sorted: Vec<String> = extensions.iter().map(|ext| regex::escape(ext)).collect();
    sorted.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
    re(&format!(
        r"`?((?:[A-Za-z0-9_.-]+/)+[A-Za-z0-9_.-]+\.(?:{}))`?",
        sorted.join("|")
    ))
}

/// The paths `content` names that `exists` confirms, in the order named,
/// each once, at most `cap`. A path that climbs with `..` is never one.
pub(crate) fn candidate_paths(
    content: &str,
    pattern: &Regex,
    cap: usize,
    mut exists: impl FnMut(&str) -> bool,
) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for named in pattern.captures_iter(content) {
        let path = &named[1];
        if !path.contains("..") && !found.iter().any(|seen| seen == path) && exists(path) {
            found.push(path.to_owned());
        }
        if found.len() >= cap {
            break;
        }
    }
    found
}

/// The code names a memory mentions, for the literal search: up to
/// [`NAMES_PER_MEMORY`] distinct words that look like a type
/// (`ContextDb`), a camel-case name (`renderM0`) or a snake-case name
/// (`run_git`), in the order they appear.
pub(crate) fn code_names(content: &str) -> Vec<String> {
    let pattern = re(
        r"\b(?:[A-Z][A-Za-z0-9_]{3,}|[a-z][a-z0-9]*[A-Z][A-Za-z0-9_]*|[a-z][a-z0-9]*_[A-Za-z0-9_]{2,})\b",
    );
    let mut names: Vec<String> = Vec::new();
    for found in pattern.find_iter(content) {
        if !names.iter().any(|name| name == found.as_str()) {
            names.push(found.as_str().to_owned());
        }
    }
    names.truncate(NAMES_PER_MEMORY);
    names
}

/// Give each input with no likely file the files where `search` finds the
/// code names it mentions, at most `cap` each. `search` runs once for the
/// whole batch with every name, and answers its matching lines as (path,
/// line text), or `None` when the search failed. A file ranks by how many
/// of the memory's names one of its lines holds, then by path; `exists`
/// confirms each.
pub(crate) fn seed_code_names(
    inputs: &mut [Input],
    cap: usize,
    search: impl FnOnce(&[String]) -> Option<Vec<(String, String)>>,
    mut exists: impl FnMut(&str) -> bool,
) {
    let names: Vec<(usize, Vec<String>)> = inputs
        .iter()
        .enumerate()
        .filter(|(_, input)| input.candidates.is_empty())
        .map(|(index, input)| (index, code_names(&input.content)))
        .filter(|(_, names)| !names.is_empty())
        .collect();
    let mut terms: Vec<String> = Vec::new();
    for name in names.iter().flat_map(|(_, names)| names) {
        if !terms.contains(name) {
            terms.push(name.clone());
        }
    }
    if terms.is_empty() {
        return;
    }
    let Some(lines) = search(&terms) else {
        return;
    };
    for (index, names) in names {
        let mut scores: HashMap<&str, usize> = HashMap::new();
        for (path, text) in &lines {
            let score = names
                .iter()
                .filter(|name| text.contains(name.as_str()))
                .count();
            if score > 0 {
                let best = scores.entry(path.as_str()).or_default();
                *best = (*best).max(score);
            }
        }
        let mut ranked: Vec<(&str, usize)> = scores.into_iter().collect();
        ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
        inputs[index].candidates = ranked
            .into_iter()
            .map(|(path, _)| path)
            .filter(|path| exists(path))
            .take(cap)
            .map(str::to_owned)
            .collect();
    }
}

/// Why a file a reply names is not recorded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Refused {
    Untracked,
    Missing,
    Outside,
    NotAFile,
}

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Untracked => "is not a file git tracks in the checkout",
            Self::Missing => "is not in the checkout",
            Self::Outside => "leads outside the checkout once its links are resolved",
            Self::NotAFile => "is not a file",
        })
    }
}

/// The project's checkout as one run sees it: its folder with links
/// resolved, and the paths git tracked there when the run began.
pub(crate) struct Checkout {
    pub root: PathBuf,
    pub tracked: HashSet<String>,
}

impl Checkout {
    /// Read the checkout at `root`. Refused when the folder can't be
    /// resolved or git can't list what it tracks.
    pub(crate) fn open(root: &Path) -> Result<Self, String> {
        let root = root
            .canonicalize()
            .map_err(|error| format!("the project folder {}: {error}", root.display()))?;
        let listed = run_git(
            &root,
            &["ls-files", "-z", "--cached"],
            LIST_TIMEOUT,
            LIST_MAX_OUTPUT,
        )
        .map_err(|error| {
            format!(
                "listing the files git tracks in {}: {error}",
                root.display()
            )
        })?;
        let tracked = listed
            .split(|byte| *byte == 0)
            .filter_map(|bytes| std::str::from_utf8(bytes).ok())
            .filter(|path| !path.is_empty())
            .map(str::to_owned)
            .collect();
        Ok(Self { root, tracked })
    }

    /// `path` as the mapping records it, when it names a file git tracks
    /// that exists and, with its links resolved, stays inside the checkout.
    /// A leading `./` and backslashes are accepted.
    pub(crate) fn file(&self, path: &str) -> Result<String, Refused> {
        let path = path.replace('\\', "/");
        let path = path.strip_prefix("./").unwrap_or(&path);
        if !self.tracked.contains(path) {
            return Err(Refused::Untracked);
        }
        let resolved = self
            .root
            .join(path)
            .canonicalize()
            .map_err(|_| Refused::Missing)?;
        if !resolved.starts_with(&self.root) {
            return Err(Refused::Outside);
        }
        if !resolved.is_file() {
            return Err(Refused::NotAFile);
        }
        Ok(path.to_owned())
    }

    /// The tracked files with one of `extensions` whose lines hold any of
    /// `terms` as written, as (path, line text). `None` when git fails, runs
    /// past [`SEARCH_TIMEOUT`] or prints more than [`SEARCH_MAX_OUTPUT`]:
    /// the memories then keep only the paths they name.
    pub(crate) fn search(
        &self,
        terms: &[String],
        extensions: &[String],
    ) -> Option<Vec<(String, String)>> {
        let mut args: Vec<String> = [
            "-c",
            "core.quotePath=false",
            "grep",
            "--no-color",
            "-n",
            "-I",
            "-F",
        ]
        .iter()
        .map(|arg| (*arg).to_owned())
        .collect();
        for term in terms {
            args.push("-e".into());
            args.push(term.clone());
        }
        args.push("--".into());
        args.extend(extensions.iter().map(|ext| format!("*.{ext}")));
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let output = match run_git(&self.root, &args, SEARCH_TIMEOUT, SEARCH_MAX_OUTPUT) {
            Ok(output) => output,
            // `git grep` exits 1 when nothing matched.
            Err(GitError::Exit(1)) => Vec::new(),
            Err(_) => return None,
        };
        let line = re(r"^([^:]+):\d+:(.*)$");
        Some(
            String::from_utf8_lossy(&output)
                .lines()
                .filter_map(|text| {
                    line.captures(text)
                        .map(|found| (found[1].to_owned(), found[2].to_owned()))
                })
                .collect(),
        )
    }
}

/// Why git gave no output.
#[derive(Debug)]
enum GitError {
    Start(String),
    TimedOut,
    TooLong,
    /// It ended with this exit code, or `-1` when killed by a signal.
    Exit(i32),
}

impl std::fmt::Display for GitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Start(error) => write!(f, "git: {error}"),
            Self::TimedOut => f.write_str("git ran too long"),
            Self::TooLong => f.write_str("git printed too much"),
            Self::Exit(code) => write!(f, "git exited {code}"),
        }
    }
}

/// Run git with `args` in `root` and return what it printed. Git is killed
/// past `timeout`; more than `max_output` bytes is a failure.
fn run_git(
    root: &Path,
    args: &[&str],
    timeout: Duration,
    max_output: usize,
) -> Result<Vec<u8>, GitError> {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        // No console window flashes on Windows (CREATE_NO_WINDOW).
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command
        .spawn()
        .map_err(|error| GitError::Start(error.to_string()))?;
    let mut stdout = child.stdout.take().expect("stdout is piped");
    // The output is drained while git runs, so a long listing can't block
    // it. Only the first `max_output` bytes are kept; the rest is read and
    // counted as too much.
    let reader = std::thread::spawn(move || {
        let mut kept = Vec::new();
        let mut too_long = false;
        let mut chunk = [0_u8; 64 * 1024];
        loop {
            match stdout.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    let room = max_output.saturating_sub(kept.len());
                    kept.extend_from_slice(&chunk[..read.min(room)]);
                    too_long |= read > room;
                }
            }
        }
        (kept, too_long)
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(GitError::Start(error.to_string()));
            }
        }
    };
    let (output, too_long) = reader.join().unwrap_or_default();
    match status {
        None => Err(GitError::TimedOut),
        Some(_) if too_long => Err(GitError::TooLong),
        Some(status) if !status.success() => Err(GitError::Exit(status.code().unwrap_or(-1))),
        Some(_) => Ok(output),
    }
}

/// The text that fills the task's input frame: each memory in the frame's
/// own shape, its likely files on a line of their own when it has any.
pub(crate) fn input(inputs: &[Input]) -> String {
    let entries: Vec<String> = inputs
        .iter()
        .map(|input| {
            let seeds = if input.candidates.is_empty() {
                String::new()
            } else {
                format!(
                    "\nLikely files (candidate paths, confirmed to exist): {}",
                    input.candidates.join(", ")
                )
            };
            format!("[{}] {}\n{}{seeds}", input.id, input.tag, input.content)
        })
        .collect();
    format!("<memories>\n{}\n</memories>", entries.join("\n\n"))
}

/// One memory's mapping as a reply proposes it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Mapping {
    pub id: i64,
    /// The files, as the reply names them. Empty when `independent`.
    pub files: Vec<String>,
    /// Marked file-independent, with no files named.
    pub independent: bool,
}

/// Read a reply's `<mappings>` manifest. The reply must hold the whole
/// manifest, opening and closing tag; each entry needs a numeric id and
/// either files (a `files` attribute, or nested `<file path="…"/>`) or
/// `independent="true"`. Named files win over the mark.
pub(crate) fn parse_manifest(text: &str) -> Result<Vec<Mapping>, String> {
    let body = body(text, "mappings")?;
    let mut found = Vec::new();
    // The attributes end at the first `/>` or `>`, so a self-closed entry
    // never runs on to a later entry's `</memory>`.
    for entry in re(r"(?is)<memory\b([^>]*?)(?:/>|>(.*?)</memory>)").captures_iter(&body) {
        let attributes = &entry[1];
        let id = attribute(attributes, "id", "[0-9]+", false)
            .and_then(|value| value.parse().ok())
            .ok_or("mappings manifest entry missing numeric id")?;
        let independent = attribute(attributes, "independent", "true|1", true).is_some();
        let mut files: Vec<String> = attribute(attributes, "files", r#"[^"]*"#, false)
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|file| !file.is_empty())
            .map(str::to_owned)
            .collect();
        if files.is_empty() {
            let nested = entry.get(2).map_or("", |inner| inner.as_str());
            for file in re(r"(?i)<file\b([^>]*)/?>").captures_iter(nested) {
                if let Some(path) = attribute(&file[1], "path", r#"[^"]+"#, false) {
                    if !path.trim().is_empty() {
                        files.push(path.trim().to_owned());
                    }
                }
            }
        }
        if !independent && files.is_empty() {
            return Err(format!(
                "mappings manifest entry {id} has neither files nor independent=\"true\""
            ));
        }
        found.push(Mapping {
            id,
            independent: independent && files.is_empty(),
            files,
        });
    }
    if found.is_empty() && !body.trim().is_empty() {
        return Err(describe_shape(text, "mappings"));
    }
    Ok(found)
}

/// A reply's manifest when it maps no memory of `expected` twice. An id
/// outside `expected` is left for the apply step to drop; an id the reply
/// leaves out stays unmapped, so a closed empty manifest is a valid answer
/// for a batch where nothing could be decided.
pub(crate) fn validate_manifest(text: &str, expected: &[i64]) -> Result<Vec<Mapping>, String> {
    let found = parse_manifest(text)?;
    let mut seen = HashSet::new();
    for entry in found.iter().filter(|entry| expected.contains(&entry.id)) {
        if !seen.insert(entry.id) {
            return Err(format!(
                "mappings manifest contains duplicate id {}",
                entry.id
            ));
        }
    }
    Ok(found)
}

/// Whether a project rule reads as a workflow directive: a modal tied to a
/// person (`you must`, `agents should`), a behavioural `when` clause, a
/// workflow imperative, or a statement of who decides. File names in such a
/// rule are things to act on, not code that backs it, so it never maps to
/// files. A declarative claim about code ("binds use spread args") is not
/// one.
pub(crate) fn directive_shaped_rule(category: &str, content: &str) -> bool {
    if category != PROJECT_RULES {
        return false;
    }
    let text = content.trim();
    if text.is_empty() {
        return false;
    }
    [
        r"(?:^|[.!?]\s+|\n\s*)(?:[-*]\s+|\d+[.)]\s+)?(?:you\s+|we\s+)?(?:must(?:\s+not)?|never|always|do\s+not|don't|shall\s+not)\b",
        r"\b(?:you|we|agents?|masons?|workers?|operators?|users?|maintainers?)\s+(?:must(?:\s+not)?|should(?:\s+not)?|need\s+to|shall(?:\s+not)?|cannot|can't|may\s+not)\b",
        r"\bwhen\s+(?:you(?:'re|\s+are)?|we(?:'re|\s+are)?|told|asked|requested|working|debugging|reviewing|checking|verifying|investigating|using|running|editing|changing)\b",
        r"(?:^|[.!?]\s+|\n\s*)(?:[-*]\s+|\d+[.)]\s+)?(?:please\s+)?(?:run|use|check|ask|avoid|prefer|ensure|keep|follow|brief|report|inspect|search|open|read|review|validate|confirm|delegate|stop|start|remember)\b",
        r"\b(?:the\s+)?(?:user|operator|maintainer|owner)\s+(?:decides|chooses|approves|has\s+(?:the\s+)?final\s+say)\b",
    ]
    .iter()
    .any(|pattern| re(&format!("(?i){pattern}")).is_match(text))
}

/// The task kind.
pub(crate) struct MapMemories;

/// What every batch of one run shares: the profile its message renders
/// from, and the checkout its files are checked against.
pub(crate) struct Run {
    profile: Profile,
    task_id: String,
    project: String,
    checkout: Checkout,
    extensions: Vec<String>,
    seeds: usize,
}

impl MapMemories {
    /// The run's batches for the context's owner, in order.
    pub(crate) fn plan_batches(&self, context: &TaskContext<'_>) -> Result<Vec<MapBatch>, String> {
        let Owner::Project { id: project, root } = context.owner;
        let live = context
            .db
            .with_connection(|conn| live_memories(conn, project))
            .map_err(|error| format!("reading the memories of {project}: {error}"))?;
        let checkout = Checkout::open(Path::new(root))?;
        let extensions = extensions(context.declaration);
        let seeds = seeds(context.declaration);
        let pattern = path_pattern(&extensions);
        let inputs = select(&live, |memory| {
            candidate_paths(&memory.content, &pattern, seeds, |path| {
                checkout.file(path).is_ok()
            })
        });
        let shared = Arc::new(Run {
            profile: context.profile.clone(),
            task_id: context.task_id().to_owned(),
            project: project.clone(),
            checkout,
            extensions,
            seeds,
        });
        let by_id: HashMap<i64, &Memory> = live.iter().map(|memory| (memory.id, memory)).collect();
        inputs
            .chunks(BATCH_SIZE)
            .enumerate()
            .map(|(index, chunk)| {
                // Rendered now with the paths the memories name, which
                // checks the profile's documents; the literal search for
                // code names runs when the message is first asked for, so
                // a run that stops early never searches for the batches it
                // doesn't send.
                let (system, message) = shared.render(chunk)?;
                Ok(MapBatch {
                    index,
                    run: Arc::clone(&shared),
                    system,
                    named: message,
                    inputs: chunk.to_vec(),
                    message: OnceLock::new(),
                    read: chunk
                        .iter()
                        .map(|input| {
                            let memory = by_id[&input.id];
                            Seen {
                                id: memory.id,
                                revision: memory.revision,
                                category: memory.category.clone(),
                                content: memory.content.clone(),
                            }
                        })
                        .collect(),
                })
            })
            .collect()
    }
}

impl Run {
    /// The system prompt and message for `inputs`.
    fn render(&self, inputs: &[Input]) -> Result<(String, String), String> {
        let text = input(inputs);
        task_prompts(
            &self.profile,
            &self.task_id,
            "user",
            &[(INPUT_FRAME, text.as_str())],
            &[("projectIdentity", self.project.as_str())],
        )
    }
}

impl Task for MapMemories {
    fn kind(&self) -> &'static str {
        KIND
    }

    fn batches(&self, context: &TaskContext<'_>) -> Result<Vec<Box<dyn Batch>>, String> {
        Ok(self
            .plan_batches(context)?
            .into_iter()
            .map(|batch| Box::new(batch) as Box<dyn Batch>)
            .collect())
    }
}

/// A memory as the batch read it.
#[derive(Clone, Debug)]
struct Seen {
    id: i64,
    revision: i64,
    category: String,
    content: String,
}

/// One message of a map run.
pub(crate) struct MapBatch {
    /// Its place in the run, which names its journal entry.
    index: usize,
    run: Arc<Run>,
    system: String,
    /// The message with only the paths the memories name.
    named: String,
    inputs: Vec<Input>,
    /// The message as sent, with the code-name search's files added; made
    /// once, on first use.
    message: OnceLock<String>,
    read: Vec<Seen>,
}

impl MapBatch {
    fn ids(&self) -> Vec<i64> {
        self.read.iter().map(|memory| memory.id).collect()
    }

    /// The message this batch sends.
    pub(crate) fn message(&self) -> &str {
        self.message.get_or_init(|| {
            let mut inputs = self.inputs.clone();
            let checkout = &self.run.checkout;
            seed_code_names(
                &mut inputs,
                self.run.seeds,
                |terms| checkout.search(terms, &self.run.extensions),
                |path| checkout.file(path).is_ok(),
            );
            if inputs == self.inputs {
                return self.named.clone();
            }
            // The documents rendered once already, so this can't fail; the
            // message without the searched files stands in if it does.
            self.run
                .render(&inputs)
                .map(|(_, message)| message)
                .unwrap_or_else(|_| self.named.clone())
        })
    }

    /// The journal entry this batch's writes are recorded under.
    fn decision_key(&self, run: i64) -> String {
        format!("dream-run:{run}:{KIND}:{}", self.index)
    }
}

impl TaskInput for MapBatch {
    fn system(&self) -> &str {
        &self.system
    }

    fn prompt(&self, window: Window, output_tokens: u64) -> Option<String> {
        let message = self.message();
        window
            .admits(output_tokens, &self.system, message)
            .then(|| message.to_owned())
    }

    fn accepts(&self, reply: &str) -> Result<(), String> {
        validate_manifest(reply, &self.ids()).map(|_| ())
    }
}

impl Batch for MapBatch {
    fn apply(&self, tx: &Transaction<'_>, reply: &TaskReply, run: i64) -> Result<Applied, String> {
        let proposals = validate_manifest(&reply.text, &self.ids())?;
        self.write(tx, &proposals, run)
            .map_err(|error| format!("writing mappings: {error}"))
    }
}

/// One row of a memory's mapping, as `memory_verifications` holds it. The
/// file-independent mark is the row with the empty path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MappingRow {
    pub file_path: String,
    pub mapping_origin: String,
    /// When verify last checked the memory against the file; 0 when mapped
    /// and not yet checked.
    pub verified_at: i64,
    pub mapped_at: i64,
}

/// Memory `id`'s mapping rows, by path.
pub(crate) fn mapping_rows(conn: &Connection, id: i64) -> rusqlite::Result<Vec<MappingRow>> {
    conn.prepare_cached(
        "SELECT file_path, mapping_origin, verified_at, mapped_at FROM memory_verifications
          WHERE memory_id = ?1 ORDER BY file_path",
    )?
    .query_map(params![id], |row| {
        Ok(MappingRow {
            file_path: row.get(0)?,
            mapping_origin: row.get(1)?,
            verified_at: row.get(2)?,
            mapped_at: row.get(3)?,
        })
    })?
    .collect()
}

/// Replace memory `id`'s mapping with `rows`; none leaves it unmapped.
pub(crate) fn put_mapping(conn: &Connection, id: i64, rows: &[MappingRow]) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM memory_verifications WHERE memory_id = ?1",
        params![id],
    )?;
    for row in rows {
        conn.execute(
            "INSERT INTO memory_verifications(memory_id, file_path, verified_at, mapped_at, mapping_origin)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, row.file_path, row.verified_at, row.mapped_at, row.mapping_origin],
        )?;
    }
    Ok(())
}

/// Whether two mappings name the same files with the same origins. When
/// verify last checked them doesn't count.
pub(crate) fn same_mapping(a: &[MappingRow], b: &[MappingRow]) -> bool {
    let key = |rows: &[MappingRow]| {
        let mut key: Vec<(String, String)> = rows
            .iter()
            .map(|row| (row.file_path.clone(), row.mapping_origin.clone()))
            .collect();
        key.sort();
        key
    };
    key(a) == key(b)
}

/// A mapping as the journal records it.
pub(crate) fn mapping_json(rows: &[MappingRow]) -> Value {
    Value::Array(
        rows.iter()
            .map(|row| {
                json!({
                    "filePath": row.file_path,
                    "mappingOrigin": row.mapping_origin,
                    "verifiedAt": row.verified_at,
                    "mappedAt": row.mapped_at,
                })
            })
            .collect(),
    )
}

/// A mapping the journal recorded; `None` when `value` isn't one.
pub(crate) fn mapping_of_json(value: &Value) -> Option<Vec<MappingRow>> {
    value
        .as_array()?
        .iter()
        .map(|row| {
            Some(MappingRow {
                file_path: row["filePath"].as_str()?.to_owned(),
                mapping_origin: row["mappingOrigin"].as_str()?.to_owned(),
                verified_at: row["verifiedAt"].as_i64()?,
                mapped_at: row["mappedAt"].as_i64()?,
            })
        })
        .collect()
}

impl MapBatch {
    /// The files and origin `proposal` records for `seen`, each refusal
    /// added to `dropped` with why.
    fn decide(
        &self,
        proposal: &Mapping,
        seen: &Seen,
        dropped: &mut Vec<String>,
    ) -> (Vec<String>, &'static str) {
        let id = proposal.id;
        if proposal.independent {
            return (Vec::new(), MAPPER);
        }
        if directive_shaped_rule(&seen.category, &seen.content) {
            dropped.push(format!(
                "memory {id}: a directive-shaped project rule names files to act on, not code that backs it; recorded as file-independent ({REJECTED}) instead of {}",
                proposal.files.join(", ")
            ));
            return (Vec::new(), REJECTED);
        }
        let mut files: Vec<String> = Vec::new();
        for file in &proposal.files {
            match self.run.checkout.file(file) {
                Ok(path) => {
                    if !files.contains(&path) {
                        files.push(path);
                    }
                }
                Err(why) => dropped.push(format!("memory {id}: {file} {why}")),
            }
        }
        if files.is_empty() {
            dropped.push(format!(
                "memory {id}: none of its files passed the checks; recorded as file-independent ({REJECTED})"
            ));
            return (Vec::new(), REJECTED);
        }
        files.sort();
        (files, MAPPER)
    }

    /// Write what `proposals` change, in `tx`. A memory counts as applied
    /// when its mapping was written; one whose mapping already names what
    /// its proposal says is left alone, and counts as neither applied nor
    /// dropped.
    fn write(
        &self,
        tx: &Transaction<'_>,
        proposals: &[Mapping],
        run: i64,
    ) -> rusqlite::Result<Applied> {
        let now = now_ms();
        let project = &self.run.project;
        let mut applied = Applied {
            proposed: proposals.len(),
            ..Applied::default()
        };
        let mut changes: Vec<(i64, Vec<MappingRow>, Vec<MappingRow>)> = Vec::new();
        for proposal in proposals {
            let id = proposal.id;
            let Some(seen) = self.read.iter().find(|memory| memory.id == id) else {
                applied
                    .dropped
                    .push(format!("memory {id} is not one this batch sent"));
                continue;
            };
            let current: Option<(bool, i64)> = tx
                .query_row(
                    "SELECT level = 'project' AND owner_id = ?2 AND status IN ('active', 'permanent'), revision
                       FROM memories WHERE id = ?1",
                    params![id, project],
                    |row| Ok((row.get::<_, Option<bool>>(0)?.unwrap_or(false), row.get(1)?)),
                )
                .optional()?;
            match current {
                Some((true, revision)) if revision == seen.revision => {}
                Some((true, revision)) => {
                    applied.dropped.push(format!(
                        "memory {id} changed after the batch read it (revision {}, now {revision})",
                        seen.revision
                    ));
                    continue;
                }
                _ => {
                    applied.dropped.push(format!(
                        "memory {id} is no longer a live memory of the project"
                    ));
                    continue;
                }
            }
            let (files, origin) = self.decide(proposal, seen, &mut applied.dropped);
            let paths = if files.is_empty() {
                vec![String::new()]
            } else {
                files
            };
            let wanted: Vec<MappingRow> = paths
                .into_iter()
                .map(|file_path| MappingRow {
                    file_path,
                    mapping_origin: origin.to_owned(),
                    verified_at: 0,
                    mapped_at: now,
                })
                .collect();
            let before = mapping_rows(tx, id)?;
            if same_mapping(&before, &wanted) {
                continue;
            }
            put_mapping(tx, id, &wanted)?;
            changes.push((id, before, wanted));
            applied.applied += 1;
        }
        if !changes.is_empty() {
            record_mappings(tx, project, &self.decision_key(run), &changes, now)?;
        }
        Ok(applied)
    }
}

/// Record mapping writes as one journal entry under `key`: each memory's
/// mapping before and after, in both snapshot columns, where undoing a
/// dreamer run reads them. The entry has no memory rows, so the run's page
/// counts no memory written for it.
pub(crate) fn record_mappings(
    tx: &Transaction<'_>,
    project: &str,
    key: &str,
    changes: &[(i64, Vec<MappingRow>, Vec<MappingRow>)],
    now: i64,
) -> rusqlite::Result<()> {
    let ids: Vec<i64> = changes.iter().map(|(id, _, _)| *id).collect();
    let written: Vec<Value> = changes
        .iter()
        .map(|(id, before, after)| {
            json!({
                "memoryId": id,
                "before": mapping_json(before),
                "after": mapping_json(after),
            })
        })
        .collect();
    let decision = json!({
        "version": 1,
        "decisionKey": key,
        "projectPath": project,
        "writer": WRITER,
        "operation": OPERATION,
        "reason": KIND,
        "appliedAt": now,
        "mappings": written,
    });
    tx.execute(
        "INSERT INTO memory_journal(project_path, decision_key, operation, receipt_json, applied_at,
                                    before_json, after_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![
            project,
            key,
            OPERATION,
            json!({"state": "applied", "reason": OPERATION, "memoryIds": ids}).to_string(),
            now,
            crate::memory_writes::history_json(&decision)
        ],
    )?;
    Ok(())
}

#[cfg(test)]
#[path = "map_memories_tests.rs"]
mod tests;
