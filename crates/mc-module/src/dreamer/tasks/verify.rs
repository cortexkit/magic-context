//! The `verify` and `verify-broad` tasks: check project memories against the
//! project's code, and keep, correct or archive each.
//!
//! Ported from the 0.49.x Rust module kept for reference in `crates_old/`
//! (`mc-module/src/dream_tasks/verify.rs`, its host
//! `dream_dispatch/verify_host.rs`, and `mc-store/src/dream_verify.rs`).
//!
//! - `verify` checks the memories mapped to files (`memory_verifications`)
//!   whose files changed since the memory was last verified: since its
//!   verified commit when it has one, otherwise since its verification
//!   time. Memories verified before and memories never verified go in
//!   separate batches. A batch of verified memories whose commits git can
//!   still diff is shown the diff of each file since then, bounded as 0.49
//!   bounded it; any other batch is checked by reading the files.
//! - `verify-broad` checks every live memory of the task's categories,
//!   mapped or not, least recently checked first.
//!
//! Before a batch without a diff is built, the module picks the paths and
//! code names each memory cites ([`cites`]) and looks each up in the
//! checkout, and the batch lists the ones a plain search did not find. A
//! memory none of whose citations was found goes first in a broad run. When
//! the search reached its limit, nothing is listed and nobody goes first:
//! an unfinished search proves no absence.
//!
//! A batch holds twenty memories. The model reads code with the read-only
//! tools and answers with one `<verify>` manifest ([`manifest`]); each
//! verdict is checked and written on its own ([`apply`]).

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection, Transaction};
use serde_json::Value;

use crate::dreamer::checkout::{Checkout, Limits, SEARCH_LIMITS};
use crate::dreamer::run::{TaskInput, TaskReply};
use crate::dreamer::task::{document_prompts, Applied, Batch, Owner, Task, TaskContext};
use crate::memory_writes::table_exists;
use crate::summary::fit::Window;

mod apply;
pub(crate) mod cites;
pub(crate) mod manifest;

use cites::Cite;
use manifest::{parse_manifest, Decision};

/// The kinds memory profiles name.
pub(crate) const VERIFY: &str = "verify";
pub(crate) const VERIFY_BROAD: &str = "verify-broad";
/// Magic Context's frame for memories checked by reading code.
const INPUT_FRAME: &str = "dreamer/verify.input";
/// Its frame for memories shown with the diff of their files.
const DIFF_FRAME: &str = "dreamer/verify.input.with-diff";
/// At most this many memories go in one message.
pub(crate) const BATCH_SIZE: usize = 20;
/// Above this many UTF-16 units of diff in one batch, each file shows its
/// changed line ranges instead (0.49's bound).
const DIFF_BOUND: usize = 36_000;

/// One live project memory as the task reads it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Memory {
    pub id: i64,
    /// The tag it was written under (`origin_category`), which the model is
    /// shown.
    pub tag: String,
    /// Its category id, which the task's declaration names.
    pub category: String,
    pub content: String,
    pub revision: i64,
    /// The files it is mapped to.
    pub files: Vec<String>,
    /// When it was last verified, in milliseconds; 0 when never.
    pub verified_at: i64,
    /// The commit it was verified at, when that verification recorded one.
    pub verified_commit: Option<String>,
    /// When a verify task last decided anything about it, a skip included.
    pub checked_at: i64,
}

/// The project's live memories in `categories`, unexpired, in the order the
/// plugin's verifier read them: by tag, most recently updated first.
pub(crate) fn live_memories(
    conn: &Connection,
    project: &str,
    categories: &[String],
    now: i64,
) -> rusqlite::Result<Vec<Memory>> {
    let mut mappings: HashMap<i64, Vec<(String, i64)>> = HashMap::new();
    if table_exists(conn, "memory_verifications")? {
        let mut statement = conn.prepare(
            "SELECT v.memory_id, v.file_path, v.verified_at
               FROM memory_verifications v JOIN memories m ON m.id = v.memory_id
              WHERE m.level = 'project' AND m.owner_id = ?1
              ORDER BY v.memory_id, v.file_path",
        )?;
        let rows = statement.query_map(params![project], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?;
        for row in rows {
            let (id, file, at) = row?;
            mappings.entry(id).or_default().push((file, at));
        }
    }
    let mut statement = conn.prepare(
        "SELECT id, origin_category, category, content, revision, COALESCE(verified_at, 0), metadata_json
           FROM memories
          WHERE level = 'project' AND owner_id = ?1 AND status IN ('active', 'permanent')
            AND superseded_by_memory_id IS NULL AND (expires_at IS NULL OR expires_at > ?2)
          ORDER BY origin_category, updated_at DESC, id",
    )?;
    let rows = statement.query_map(params![project, now], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, i64>(5)?,
            row.get::<_, Option<String>>(6)?,
        ))
    })?;
    let mut memories = Vec::new();
    for row in rows {
        let (id, tag, category, content, revision, column_verified_at, metadata) = row?;
        if !categories.contains(&category) {
            continue;
        }
        let mapped = mappings.remove(&id).unwrap_or_default();
        // A row with an empty path marks a verification without files.
        let files: Vec<String> = mapped
            .iter()
            .filter(|(file, _)| !file.is_empty())
            .map(|(file, _)| file.clone())
            .collect();
        let verified_at = mapped
            .iter()
            .map(|(_, at)| *at)
            .max()
            .unwrap_or(0)
            .max(column_verified_at);
        let metadata: Value = metadata
            .as_deref()
            .and_then(|text| serde_json::from_str(text).ok())
            .unwrap_or(Value::Null);
        // The commit counts only when it was stamped by the verification
        // the memory's time comes from, as the plugin's verifier read it.
        let verified_commit = (verified_at > 0
            && metadata["dreamerVerifiedAt"].as_i64() == Some(verified_at))
        .then(|| metadata["dreamerVerifiedCommit"].as_str())
        .flatten()
        .filter(|commit| commit.len() == 40 && commit.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .map(str::to_owned);
        let checked_at = metadata["dreamerCheckedAt"]
            .as_i64()
            .unwrap_or(0)
            .max(verified_at);
        memories.push(Memory {
            id,
            tag,
            category,
            content,
            revision,
            files,
            verified_at,
            verified_commit,
            checked_at,
        });
    }
    Ok(memories)
}

/// What git says about the mapped files: what changed since each verified
/// commit, when each file was last committed, and which files are gone.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Changes {
    /// The files changed since each commit, uncommitted changes included. A
    /// commit git couldn't diff against is absent.
    pub since: HashMap<String, BTreeSet<String>>,
    /// Each file's last commit time, for memories verified without a
    /// recorded commit. A file git gave no time for is absent.
    pub committed_at: HashMap<String, i64>,
    /// Files with uncommitted changes; `None` when git couldn't tell.
    pub uncommitted: Option<BTreeSet<String>>,
    /// Mapped files the checkout no longer tracks.
    pub missing: BTreeSet<String>,
}

impl Changes {
    fn read(checkout: &Checkout, mapped: &[&Memory]) -> Self {
        let mut changes = Self::default();
        for memory in mapped {
            for file in &memory.files {
                if checkout.tracked_file(file).is_none() {
                    changes.missing.insert(file.clone());
                }
            }
        }
        let commits: BTreeSet<&str> = mapped
            .iter()
            .filter(|memory| memory.verified_at > 0)
            .filter_map(|memory| memory.verified_commit.as_deref())
            .collect();
        for commit in commits {
            if let Some(files) = checkout.changed_since(commit) {
                changes.since.insert(commit.to_owned(), files);
            }
        }
        let undated: BTreeSet<&str> = mapped
            .iter()
            .filter(|memory| memory.verified_at > 0 && memory.verified_commit.is_none())
            .flat_map(|memory| memory.files.iter().map(String::as_str))
            .collect();
        if !undated.is_empty() {
            changes.uncommitted = checkout.uncommitted();
            for file in undated {
                if let Some(at) = checkout.last_commit_ms(file) {
                    changes.committed_at.insert(file.to_owned(), at);
                }
            }
        }
        changes
    }
}

/// Whether the `verify` task checks `memory`: it is mapped, and it was never
/// verified, or one of its files is gone or changed since its verification.
/// When git can't tell, it is checked.
pub(crate) fn changed(memory: &Memory, changes: &Changes) -> bool {
    if memory.files.is_empty() {
        return false;
    }
    if memory.verified_at == 0
        || memory
            .files
            .iter()
            .any(|file| changes.missing.contains(file))
    {
        return true;
    }
    if let Some(commit) = &memory.verified_commit {
        return changes
            .since
            .get(commit)
            .is_none_or(|files| memory.files.iter().any(|file| files.contains(file)));
    }
    let Some(uncommitted) = &changes.uncommitted else {
        return true;
    };
    // The plugin's rule: a file committed within a second before the
    // verification may postdate what the verifier read.
    memory.files.iter().any(|file| {
        uncommitted.contains(file)
            || changes
                .committed_at
                .get(file)
                .is_none_or(|at| *at >= memory.verified_at - 1_000)
    })
}

/// The order of a broad run: memories none of whose citations was found
/// first, then the least recently checked, then by id.
pub(crate) fn broad_order<'a>(pool: &'a [Memory], gone: &HashSet<i64>) -> Vec<&'a Memory> {
    let mut ordered: Vec<&Memory> = pool.iter().collect();
    ordered.sort_by_key(|memory| (!gone.contains(&memory.id), memory.checked_at, memory.id));
    ordered
}

/// What the plain search found for some memories' citations.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Lookup {
    /// Each memory's citations the search did not find, in the order cited.
    pub not_found: HashMap<i64, Vec<String>>,
    /// Memories that cite something and none of whose citations was found.
    pub gone: HashSet<i64>,
    /// Distinct code names searched for, and tracked files read.
    pub names: usize,
    pub files: usize,
    /// The search stopped at a limit; nothing above is filled.
    pub cut: bool,
    pub elapsed_ms: u64,
}

/// Look up every citation of `memories` in the checkout: a path among the
/// tracked files and folders, a code name as literal text in the tracked
/// paths and files.
pub(crate) fn look_up(checkout: &Checkout, memories: &[&Memory], limits: &Limits) -> Lookup {
    let cited: Vec<(i64, Vec<Cite>)> = memories
        .iter()
        .map(|memory| (memory.id, cites::cites(&memory.content)))
        .collect();
    let mut names: Vec<&str> = Vec::new();
    let mut slots: HashMap<&str, usize> = HashMap::new();
    for (_, cites) in &cited {
        for cite in cites {
            if let Cite::Name(name) = cite {
                slots.entry(name.as_str()).or_insert_with(|| {
                    names.push(name.as_str());
                    names.len() - 1
                });
            }
        }
    }
    let search = checkout.search(&names, limits);
    let mut lookup = Lookup {
        names: names.len(),
        files: search.files,
        cut: search.cut,
        elapsed_ms: search.elapsed_ms,
        ..Lookup::default()
    };
    if search.cut {
        return lookup;
    }
    for (id, cites) in &cited {
        let missing: Vec<String> = cites
            .iter()
            .filter(|cite| match cite {
                Cite::Path(path) => checkout.has_path(path) == Some(false),
                Cite::Name(name) => !search.found[slots[name.as_str()]],
            })
            .map(|cite| cite.text().to_owned())
            .collect();
        if !cites.is_empty() && missing.len() == cites.len() {
            lookup.gone.insert(*id);
        }
        if !missing.is_empty() {
            lookup.not_found.insert(*id, missing);
        }
    }
    lookup
}

/// One memory in the input frames' shape.
fn entry(memory: &Memory, not_found: &[String]) -> String {
    let files = if memory.files.is_empty() {
        "(none mapped)".to_owned()
    } else {
        memory.files.join(", ")
    };
    let mut text = format!(
        "[{}] {}\nContent: {}\nBacking files: {files}",
        memory.id, memory.tag, memory.content
    );
    if !not_found.is_empty() {
        text.push_str("\nNot found by a plain search of the checkout: ");
        text.push_str(&not_found.join(", "));
    }
    text
}

/// The text that fills [`INPUT_FRAME`].
pub(crate) fn input(memories: &[&Memory], lookup: &Lookup) -> String {
    let entries: Vec<String> = memories
        .iter()
        .map(|memory| {
            entry(
                memory,
                lookup
                    .not_found
                    .get(&memory.id)
                    .map_or(&[][..], Vec::as_slice),
            )
        })
        .collect();
    format!("<memories>\n{}\n</memories>", entries.join("\n\n"))
}

/// One file's part of a batch's diff evidence.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct EvidenceFile {
    pub path: String,
    pub text: String,
    pub memory_ids: Vec<i64>,
}

/// A batch's diff evidence: `diff`, or `ranges` once the diffs are too long.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Evidence {
    pub mode: &'static str,
    pub files: Vec<EvidenceFile>,
}

/// Bound `files`' diffs as 0.49 bounded them: above [`DIFF_BOUND`] UTF-16
/// units in all, each file shows only its change counts and hunk headers.
pub(crate) fn bounded_evidence(mut files: Vec<EvidenceFile>) -> Evidence {
    let ranges = files
        .iter()
        .map(|file| file.text.encode_utf16().count())
        .sum::<usize>()
        > DIFF_BOUND;
    if ranges {
        for file in &mut files {
            let lines: Vec<&str> = file.text.split('\n').collect();
            let headers = lines
                .iter()
                .copied()
                .filter(|line| {
                    [
                        "@@",
                        "diff --git",
                        "rename ",
                        "deleted file mode",
                        "new file mode",
                        "RENAMED",
                        "DELETED",
                        "Uncommitted changes:",
                    ]
                    .iter()
                    .any(|prefix| line.starts_with(prefix))
                })
                .collect::<Vec<_>>()
                .join("\n");
            let added = lines
                .iter()
                .filter(|line| line.starts_with('+') && !line.starts_with("+++"))
                .count();
            let removed = lines
                .iter()
                .filter(|line| line.starts_with('-') && !line.starts_with("---"))
                .count();
            file.text = format!(
                "Changed lines: +{added}/-{removed}.\n{headers}\nRead only these changed line ranges if they may affect the claim."
            );
        }
    }
    Evidence {
        mode: if ranges { "ranges" } else { "diff" },
        files,
    }
}

/// The diff of each file of `batch` since the earliest verification of a
/// memory mapped to it. `None` when one of those has no commit or git can't
/// diff it: the batch is then checked by reading the files.
fn evidence(checkout: &Checkout, batch: &[&Memory]) -> Option<Evidence> {
    checkout.head()?;
    let mut by_file: BTreeMap<&str, Vec<&Memory>> = BTreeMap::new();
    for memory in batch {
        for file in &memory.files {
            by_file.entry(file.as_str()).or_default().push(memory);
        }
    }
    let mut files = Vec::new();
    for (path, memories) in by_file {
        let earliest = memories.iter().min_by_key(|memory| memory.verified_at)?;
        let text = checkout.diff(earliest.verified_commit.as_deref()?, path)?;
        files.push(EvidenceFile {
            path: path.to_owned(),
            text,
            memory_ids: memories.iter().map(|memory| memory.id).collect(),
        });
    }
    Some(bounded_evidence(files))
}

/// The text that fills [`DIFF_FRAME`].
pub(crate) fn diff_input(memories: &[&Memory], evidence: &Evidence) -> String {
    let entries: Vec<String> = memories.iter().map(|memory| entry(memory, &[])).collect();
    let files: Vec<String> = evidence
        .files
        .iter()
        .map(|file| {
            let ids: Vec<String> = file.memory_ids.iter().map(i64::to_string).collect();
            format!(
                "File: {} (memories: {})\n{}",
                file.path,
                ids.join(", "),
                file.text
            )
        })
        .collect();
    format!(
        "<memories>\n{}\n</memories>\n\n<changed-files mode=\"{}\">\n{}\n</changed-files>",
        entries.join("\n\n"),
        evidence.mode,
        files.join("\n\n")
    )
}

/// What the task's profile declaration allows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Declared {
    /// The task's id (`swe:verify`).
    pub task: String,
    pub kind: &'static str,
    pub actions: Vec<String>,
    pub categories: Vec<String>,
}

impl Declared {
    fn of(declaration: &Value, kind: &'static str) -> Self {
        let list = |key: &str| -> Vec<String> {
            declaration[key]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        };
        Self {
            task: declaration["id"].as_str().unwrap_or(kind).to_owned(),
            kind,
            actions: list("actions"),
            categories: list("categories"),
        }
    }
}

/// The task kind: `verify` when `broad` is false, `verify-broad` when true.
pub(crate) struct Verify {
    pub broad: bool,
}

/// One planned message: its memories, and their diff when it has one.
struct Planned<'a> {
    memories: Vec<&'a Memory>,
    evidence: Option<Evidence>,
}

impl Verify {
    /// The run's batches for the context's owner, in order.
    pub(crate) fn plan_batches(
        &self,
        context: &TaskContext<'_>,
    ) -> Result<Vec<VerifyBatch>, String> {
        let Owner::Project { id: project, root } = context.owner;
        let declared = Arc::new(Declared::of(context.declaration, self.kind()));
        let document = |key: &str| context.declaration["prompts"][key].as_str();
        let system = document("system")
            .ok_or_else(|| format!("{} declares no system prompt", declared.task))?;
        let pool = context
            .db
            .with_connection(|conn| {
                live_memories(
                    conn,
                    project,
                    &declared.categories,
                    crate::memory_writes::now_ms(),
                )
            })
            .map_err(|error| format!("reading the memories of {project}: {error}"))?;
        let candidates: Vec<&Memory> = pool
            .iter()
            .filter(|memory| self.broad || !memory.files.is_empty())
            .collect();
        if candidates.is_empty() {
            return Ok(Vec::new());
        }
        let checkout = Arc::new(Checkout::open(Path::new(root))?);
        let mut plans: Vec<Planned<'_>> = Vec::new();
        let lookup;
        if self.broad {
            lookup = look_up(&checkout, &candidates, &SEARCH_LIMITS);
            for chunk in broad_order(&pool, &lookup.gone).chunks(BATCH_SIZE) {
                plans.push(Planned {
                    memories: chunk.to_vec(),
                    evidence: None,
                });
            }
        } else {
            let changes = Changes::read(&checkout, &candidates);
            let selected: Vec<&Memory> = candidates
                .into_iter()
                .filter(|memory| changed(memory, &changes))
                .collect();
            let (verified, never): (Vec<&Memory>, Vec<&Memory>) = selected
                .into_iter()
                .partition(|memory| memory.verified_at > 0);
            for chunk in verified.chunks(BATCH_SIZE) {
                plans.push(Planned {
                    memories: chunk.to_vec(),
                    evidence: evidence(&checkout, chunk),
                });
            }
            for chunk in never.chunks(BATCH_SIZE) {
                plans.push(Planned {
                    memories: chunk.to_vec(),
                    evidence: None,
                });
            }
            let read: Vec<&Memory> = plans
                .iter()
                .filter(|plan| plan.evidence.is_none())
                .flat_map(|plan| plan.memories.iter().copied())
                .collect();
            lookup = if read.is_empty() {
                Lookup::default()
            } else {
                look_up(&checkout, &read, &SEARCH_LIMITS)
            };
        }
        if lookup.cut {
            tracing::warn!(
                "ck-mc: dreamer: {} for {project}: the plain search stopped after {} of the checkout's files; no citation is listed as not found",
                declared.task,
                lookup.files
            );
        }
        // `verify` checks memories without a diff under its other message.
        let read_document = if self.broad {
            document("user")
        } else {
            document("user_without_diff")
        };
        plans
            .into_iter()
            .enumerate()
            .map(|(index, plan)| {
                let (frame, user, text) = match &plan.evidence {
                    Some(evidence) => (
                        DIFF_FRAME,
                        document("user"),
                        diff_input(&plan.memories, evidence),
                    ),
                    None => (INPUT_FRAME, read_document, input(&plan.memories, &lookup)),
                };
                let user = user.ok_or_else(|| {
                    format!(
                        "{} declares no prompt for memories {} a diff",
                        declared.task,
                        if plan.evidence.is_some() {
                            "with"
                        } else {
                            "without"
                        }
                    )
                })?;
                let (system, message) = document_prompts(
                    context.profile,
                    system,
                    user,
                    &[(frame, text.as_str())],
                    &[("projectIdentity", project.as_str())],
                )?;
                Ok(VerifyBatch {
                    declared: Arc::clone(&declared),
                    index,
                    project: project.clone(),
                    system,
                    message,
                    read: plan
                        .memories
                        .iter()
                        .map(|memory| Read {
                            id: memory.id,
                            revision: memory.revision,
                            files: memory.files.clone(),
                            content: memory.content.clone(),
                        })
                        .collect(),
                    diff: plan.evidence.is_some(),
                    search: plan.evidence.is_none().then_some(SearchRecord {
                        names: lookup.names,
                        files: lookup.files,
                        cut: lookup.cut,
                        elapsed_ms: lookup.elapsed_ms,
                    }),
                    checkout: Arc::clone(&checkout),
                    absence: Mutex::default(),
                })
            })
            .collect()
    }
}

impl Task for Verify {
    fn kind(&self) -> &'static str {
        if self.broad {
            VERIFY_BROAD
        } else {
            VERIFY
        }
    }

    fn batches(&self, context: &TaskContext<'_>) -> Result<Vec<Box<dyn Batch>>, String> {
        Ok(self
            .plan_batches(context)?
            .into_iter()
            .map(|batch| Box::new(batch) as Box<dyn Batch>)
            .collect())
    }
}

/// A memory a batch sends, as it read it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Read {
    pub id: i64,
    pub revision: i64,
    /// The files it was mapped to.
    pub files: Vec<String>,
    /// Its text as the batch sent it.
    pub content: String,
}

/// The plain search behind a batch's `Not found` lines.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SearchRecord {
    pub names: usize,
    pub files: usize,
    pub cut: bool,
    pub elapsed_ms: u64,
}

/// Whether a path or code name a reply calls missing is gone.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Absence {
    Absent,
    Present,
    /// The module can't tell, and why.
    Undecided(String),
}

/// Whether what `cite` names is in the checkout: a path among the tracked
/// files and folders, a code name as literal text, searching no further than
/// `limits`.
fn look_for(checkout: &Checkout, cite: &Cite, limits: &Limits) -> Absence {
    let missing = match cite {
        Cite::Path(path) => {
            return match checkout.has_path(path) {
                Some(true) => Absence::Present,
                Some(false) => Absence::Absent,
                None => Absence::Undecided(format!("{path} is not a path inside the checkout")),
            };
        }
        Cite::Name(name) => name.as_str(),
    };
    let search = checkout.search(&[missing], limits);
    if search.found[0] {
        Absence::Present
    } else if search.cut {
        Absence::Undecided(format!(
            "the search for {missing} stopped after {} files, before it read every tracked file",
            search.files
        ))
    } else {
        Absence::Absent
    }
}

/// One message of a verify run.
pub(crate) struct VerifyBatch {
    declared: Arc<Declared>,
    /// Its place in the run, which names its decisions in the undo history.
    index: usize,
    project: String,
    system: String,
    message: String,
    read: Vec<Read>,
    /// Whether the message carries the diff of its memories' files, and
    /// the search behind its `Not found` lines. Only the replay harness
    /// reads them.
    #[cfg_attr(not(test), allow(dead_code))]
    diff: bool,
    #[cfg_attr(not(test), allow(dead_code))]
    search: Option<SearchRecord>,
    checkout: Arc<Checkout>,
    /// What each `missing` a reply names was found to be. The lookup runs
    /// when the reply is accepted, before the store's write lock is taken,
    /// and the write reads the answer from here.
    absence: Mutex<HashMap<Cite, Absence>>,
}

impl VerifyBatch {
    #[cfg(test)]
    pub(crate) fn read(&self) -> &[Read] {
        &self.read
    }

    #[cfg(test)]
    pub(crate) fn has_diff(&self) -> bool {
        self.diff
    }

    #[cfg(test)]
    pub(crate) fn search(&self) -> Option<SearchRecord> {
        self.search
    }

    /// The commit the batch's checkout was at when it was planned.
    pub(crate) fn commit(&self) -> Option<&str> {
        self.checkout.head()
    }

    fn ids(&self) -> Vec<i64> {
        self.read.iter().map(|read| read.id).collect()
    }

    fn absence(&self, cite: &Cite) -> Absence {
        if let Some(known) = self.absence.lock().expect("absence cache").get(cite) {
            return known.clone();
        }
        let found = look_for(&self.checkout, cite, &SEARCH_LIMITS);
        self.absence
            .lock()
            .expect("absence cache")
            .insert(cite.clone(), found.clone());
        found
    }
}

impl TaskInput for VerifyBatch {
    fn system(&self) -> &str {
        &self.system
    }

    fn prompt(&self, window: Window, output_tokens: u64) -> Option<String> {
        window
            .admits(output_tokens, &self.system, &self.message)
            .then(|| self.message.clone())
    }

    fn accepts(&self, reply: &str) -> Result<(), String> {
        let verdicts = parse_manifest(reply, &self.ids())?;
        for verdict in &verdicts {
            if let (Decision::Archive, Some(missing)) = (verdict.decision, &verdict.missing) {
                let read = self.read.iter().find(|read| read.id == verdict.id);
                if let Some(cite) = read
                    .map(|read| cites::cites(&read.content))
                    .and_then(|cited| cited.into_iter().find(|cite| cite.text() == missing))
                {
                    self.absence(&cite);
                }
            }
        }
        Ok(())
    }
}

impl Batch for VerifyBatch {
    fn apply(&self, tx: &Transaction<'_>, reply: &TaskReply, run: i64) -> Result<Applied, String> {
        let verdicts = parse_manifest(&reply.text, &self.ids())?;
        self.write(tx, &verdicts, run)
            .map_err(|error| format!("writing verdicts: {error}"))
    }
}

#[cfg(test)]
#[path = "verify_tests.rs"]
pub(crate) mod tests;
