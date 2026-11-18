//! The `verify` and `verify-broad` tasks: check project memories against the
//! project's code, and keep, correct or archive each.
//!
//! Ported from the 0.49.x Rust module kept for reference in `crates_old/`
//! (`mc-module/src/dream_tasks/verify.rs`, its host
//! `dream_dispatch/verify_host.rs`, and `mc-store/src/dream_verify.rs`).
//!
//! - `verify` checks the memories mapped to files (`memory_verifications`)
//!   that were never confirmed with cited lines, and those whose files, or
//!   the files of the lines their confirmation cited, changed since the
//!   commit that confirmation read. For such a memory the module first looks
//!   for each cited span's text again ([`spans`]): when every span is still
//!   in its file, the memory stays confirmed at the new commit and no model
//!   is asked. A memory with a span that changed or is gone is shown the
//!   diff of its files since then, bounded as 0.49 bounded it, with the
//!   spans it was confirmed from; every other memory is checked by reading
//!   the files.
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
//! A batch checked by reading holds one memory, and a batch shown a diff
//! twenty. The model reads code with the read-only tools for at most
//! [`STEP_CAP`] steps and answers with one `<verify>` manifest ([`manifest`]);
//! each verdict is checked and written on its own ([`apply`]). A child that
//! reaches the cap is told to answer with what it has; when that answer is
//! unusable too, every memory of the batch is written as a skip, as a
//! `<skip>` verdict is. A confirmation must cite the lines that
//! state the claim, which the module reads and checks itself ([`confirm`]);
//! one that fails a check counts as a skip.
//!
//! A confirmation recorded without cited lines (every one before they were
//! required, the 0.49 plugin's included) counts as never made: such a memory
//! is read in full again, never shown a diff.
//!
//! Which code a memory is checked against depends on the git line it was
//! learned on ([`crate::memory_line`]). The tasks never read the folder of
//! the session that started them, which may be a worktree on an old base:
//! - a memory that names its branch is checked against that branch's
//!   newest commit, in the repository's main checkout when that branch is
//!   checked out there, and otherwise in a temporary copy of the commit
//!   that is deleted after the run; a branch that is gone stands for the
//!   default branch. Batches never mix two such commits;
//! - any other memory is checked in the main checkout. While the repository
//!   has more than one live branch it is only ever confirmed, never
//!   rewritten or archived, and it is left out of the run when every file
//!   it is mapped to differs between live branches ([`live`]).
//!
//! A repository with a single live line checks every memory in its main
//! checkout as before.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::{params, Connection, Transaction};
use serde_json::Value;

use crate::dreamer::branches::{main_checkout, Refs};
use crate::dreamer::checkout::{Checkout, Limits, SEARCH_LIMITS};
use crate::dreamer::run::{StepCap, TaskInput, TaskReply, STEP_CAP};
use crate::dreamer::task::{document_prompts, Applied, Batch, Owner, Task, TaskContext};
use crate::memory_writes::table_exists;
use crate::summary::fit::Window;

mod apply;
pub(crate) mod cites;
mod confirm;
mod live;
pub(crate) mod manifest;
mod numbers;
pub(crate) mod spans;

#[cfg(test)]
pub(crate) use apply::Decided;
use apply::METADATA;
use cites::Cite;
use confirm::{confirm, Committed};
use live::Gate;
use manifest::{parse_manifest, Decision, Verdict};
use spans::{find_lines, Cited, Confirmation, STORED_KEY};

/// The kinds memory profiles name.
pub(crate) const VERIFY: &str = "verify";
pub(crate) const VERIFY_BROAD: &str = "verify-broad";
/// Magic Context's frame for memories checked by reading code.
const INPUT_FRAME: &str = "dreamer/verify.input";
/// Its frame for memories shown with the diff of their files.
const DIFF_FRAME: &str = "dreamer/verify.input.with-diff";
/// At most this many memories go in one message checked by reading code:
/// one. Each step of a child run resends every file read so far, so the
/// memories of one batch paid for each other's reads on every later step;
/// alone, a memory's run carries only its own reads, while what every run
/// shares (the system text, the tool definitions and the task's fixed
/// instructions) stays cached.
pub(crate) const READ_BATCH_SIZE: usize = 1;
/// At most this many memories go in one message shown a diff. Such a
/// message starts with the diff in hand and rarely reads much, so one run
/// for each memory would mostly repeat the shared prefix.
pub(crate) const DIFF_BATCH_SIZE: usize = 20;
/// Above this many UTF-16 units of diff in one batch, each file shows its
/// changed line ranges instead (0.49's bound).
const DIFF_BOUND: usize = 36_000;
/// How long git may search the checked-out history for one path or name a
/// reply calls missing before the archive is dropped as undecided.
const HISTORY_TIMEOUT: Duration = Duration::from_secs(30);
/// What a child whose run reached [`STEP_CAP`] is sent, once; its reply's
/// manifest is the batch's answer.
pub(crate) const FINALIZE: &str =
    "Stop reading now. Answer with what you have verified; mark anything you could not check as SKIP.";

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
    /// When it was last confirmed with cited lines, in milliseconds; 0 when
    /// never. A confirmation without them counts as never made.
    pub verified_at: i64,
    /// The commit that confirmation read.
    pub verified_commit: Option<String>,
    /// The lines that confirmation cited, as the module read them.
    pub confirmation: Option<Confirmation>,
    /// When a verify task last decided anything about it, a skip included.
    pub checked_at: i64,
    /// The branch it was learned on ([`crate::memory_line`]); `None` when
    /// it names none.
    pub branch: Option<String>,
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
        "SELECT id, origin_category, category, content, revision, COALESCE(verified_at, 0), metadata_json,
                source_branch
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
            row.get::<_, Option<String>>(7)?,
        ))
    })?;
    let mut memories = Vec::new();
    for row in rows {
        let (id, tag, category, content, revision, column_verified_at, metadata, branch) = row?;
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
        // A confirmation counts only with the lines it cited, kept by the
        // verification the memory's time comes from; one recorded without
        // them, as every confirmation before they were required, counts as
        // never made, so the memory is read in full again.
        let confirmation = (verified_at > 0
            && metadata["dreamerVerifiedAt"].as_i64() == Some(verified_at))
        .then(|| Confirmation::stored(&metadata, verified_at))
        .flatten();
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
            verified_at: if confirmation.is_some() {
                verified_at
            } else {
                0
            },
            verified_commit: confirmation
                .as_ref()
                .map(|confirmation| confirmation.commit.clone()),
            confirmation,
            checked_at,
            branch: branch.filter(|branch| !branch.is_empty()),
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
/// confirmed with cited lines, or one of its files is gone, or one of its
/// files or of the files its confirmation cited changed since that
/// confirmation's commit. When git can't tell, it is checked.
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
            .is_none_or(|files| watched(memory).iter().any(|file| files.contains(*file)));
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

/// The files whose changes concern `memory`: the files it is mapped to, then
/// the files of the lines its confirmation cited, each once.
fn watched(memory: &Memory) -> Vec<&str> {
    let mut files: Vec<&str> = memory.files.iter().map(String::as_str).collect();
    for span in memory
        .confirmation
        .iter()
        .flat_map(|confirmation| &confirmation.spans)
    {
        if !files.contains(&span.path.as_str()) {
            files.push(&span.path);
        }
    }
    files
}

/// The order of a broad run: memories none of whose citations was found
/// first, then the least recently checked, then by id.
pub(crate) fn broad_order<'a>(pool: &[&'a Memory], gone: &HashSet<i64>) -> Vec<&'a Memory> {
    let mut ordered: Vec<&Memory> = pool.to_vec();
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
        .map(|memory| {
            (
                memory.id,
                cites::cites(&memory.content, checkout.top_level()),
            )
        })
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
/// memory it concerns: the files each memory is mapped to, and those of the
/// lines its confirmation cited. `None` when one of those has no commit or
/// git can't diff it: the batch is then checked by reading the files.
fn evidence(checkout: &Checkout, batch: &[&Memory]) -> Option<Evidence> {
    checkout.head()?;
    let mut by_file: BTreeMap<&str, Vec<&Memory>> = BTreeMap::new();
    for memory in batch {
        for file in watched(memory) {
            by_file.entry(file).or_default().push(memory);
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

/// The text that fills [`DIFF_FRAME`]: each memory with the spans it was
/// confirmed from, and the diff of its files.
pub(crate) fn diff_input(memories: &[&Memory], evidence: &Evidence) -> String {
    let entries: Vec<String> = memories
        .iter()
        .map(|memory| {
            let mut text = entry(memory, &[]);
            if let Some(confirmation) = &memory.confirmation {
                let spans: Vec<String> = confirmation.spans.iter().map(Cited::label).collect();
                text.push_str("\nConfirmed from: ");
                text.push_str(&spans.join(", "));
            }
            text
        })
        .collect();
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

/// Where a group of memories is checked.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Target {
    /// The main checkout, as it is.
    Main,
    /// A temporary copy of `commit`, the newest commit of `branch`.
    Copy { branch: String, commit: String },
}

/// The memories of one run checked in one place, and how each is checked.
struct Group<'a> {
    memories: Vec<&'a Memory>,
    /// Memories checked against their own line: the branch they name, or
    /// the default branch when that one is gone. Every other memory of the
    /// main checkout's group passes the live-branch checks ([`live`]).
    lined: HashSet<i64>,
}

/// The batches planned for one group, with what they share.
struct Plans<'a> {
    target: Target,
    checkout: Arc<Checkout>,
    lined: HashSet<i64>,
    plans: Vec<Planned<'a>>,
    lookup: Lookup,
}

impl Verify {
    /// The run's batches for the context's owner, in order.
    pub(crate) fn plan_batches(
        &self,
        context: &TaskContext<'_>,
    ) -> Result<Vec<VerifyBatch>, String> {
        self.plan_batches_of(context, READ_BATCH_SIZE)
    }

    /// [`Verify::plan_batches`], with at most `read_batch` memories in a
    /// message checked by reading. Tests of a reply that decides several
    /// such memories at once plan with more than [`READ_BATCH_SIZE`].
    pub(crate) fn plan_batches_of(
        &self,
        context: &TaskContext<'_>,
        read_batch: usize,
    ) -> Result<Vec<VerifyBatch>, String> {
        let Owner::Project { id: project, root } = context.owner else {
            return Err(format!(
                "{} works on a project's memories only",
                self.kind()
            ));
        };
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
        // The main checkout, whatever worktree the run's session was in.
        let main = main_checkout(Path::new(root))?;
        let refs = if candidates.iter().any(|memory| memory.branch.is_some()) {
            Some(Refs::read(&main)?)
        } else {
            None
        };
        let main_branch = refs
            .as_ref()
            .and_then(|refs| refs.main_branch().map(str::to_owned));
        let groups = group_by_line(&candidates, refs.as_ref());
        let mut planned: Vec<Plans<'_>> = Vec::new();
        let mut rechecked: Vec<Rechecked> = Vec::new();
        for (target, group) in groups {
            let checkout = match &target {
                Target::Main => Checkout::open(&main)?,
                Target::Copy { branch, commit } => match Checkout::open_copy(&main, commit) {
                    Ok(copy) => copy,
                    // Its memories stay as they are until a later run can
                    // read their branch.
                    Err(error) => {
                        tracing::warn!(
                            "ck-mc: dreamer: {} for {project}: the memories learned on {branch} are not checked this run: {error}",
                            declared.task
                        );
                        continue;
                    }
                },
            };
            let checkout = Arc::new(checkout);
            // The main checkout's memories without a line of their own stay
            // confirmed only where every live branch holds their lines, and
            // are not sent while every file they are mapped to differs
            // between live branches.
            let live = (target == Target::Main).then(|| Gate::new(&main));
            let (plans, lookup, kept, left_out) = self.plan_group(
                &checkout,
                &group.memories,
                &group.lined,
                live.as_ref(),
                read_batch,
            );
            rechecked.extend(kept);
            // Nothing is written for them, so they are not counted as
            // checked and a later run plans them again.
            if !left_out.is_empty() {
                tracing::info!(
                    "ck-mc: dreamer: {} for {project}: {} older memories are not checked this run: every file each is mapped to differs between live branches (ids {})",
                    declared.task,
                    left_out.len(),
                    left_out
                        .iter()
                        .map(i64::to_string)
                        .collect::<Vec<_>>()
                        .join(", ")
                );
            }
            if lookup.cut {
                tracing::warn!(
                    "ck-mc: dreamer: {} for {project}: the plain search stopped after {} of the checkout's files; no citation is listed as not found",
                    declared.task,
                    lookup.files
                );
            }
            planned.push(Plans {
                target,
                checkout,
                lined: group.lined,
                plans,
                lookup,
            });
        }
        // No model is asked about a memory whose cited lines are unchanged;
        // it is recorded as confirmed at the new commit now, so the next
        // run looks only at what changes after it.
        if !rechecked.is_empty() {
            match context
                .db
                .with_connection(|conn| record_rechecked(conn, &rechecked))
            {
                Ok(recorded) => tracing::info!(
                    "ck-mc: dreamer: {} for {project}: {recorded} memories stay confirmed, the lines they cite unchanged",
                    declared.task
                ),
                Err(error) => tracing::warn!(
                    "ck-mc: dreamer: {} for {project}: recording the memories whose cited lines are unchanged failed: {error}",
                    declared.task
                ),
            }
        }
        // `verify` checks memories without a diff under its other message.
        let read_document = if self.broad {
            document("user")
        } else {
            document("user_without_diff")
        };
        let mut batches = Vec::new();
        for group in planned {
            let branch = match &group.target {
                Target::Main => main_branch.clone(),
                Target::Copy { branch, .. } => Some(branch.clone()),
            };
            for plan in group.plans {
                let (frame, user, text) = match &plan.evidence {
                    Some(evidence) => (
                        DIFF_FRAME,
                        document("user"),
                        diff_input(&plan.memories, evidence),
                    ),
                    None => (
                        INPUT_FRAME,
                        read_document,
                        input(&plan.memories, &group.lookup),
                    ),
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
                let read: Vec<Read> = plan
                    .memories
                    .iter()
                    .map(|memory| Read {
                        id: memory.id,
                        revision: memory.revision,
                        files: memory.files.clone(),
                        content: memory.content.clone(),
                        lined: group.lined.contains(&memory.id),
                    })
                    .collect();
                // A batch of the main checkout holding a memory without a
                // line of its own checks the live branches before writing.
                let gate = (group.target == Target::Main && read.iter().any(|read| !read.lined))
                    .then(|| Gate::new(&main));
                batches.push(VerifyBatch {
                    declared: Arc::clone(&declared),
                    index: batches.len(),
                    project: project.clone(),
                    system,
                    message,
                    read,
                    diff: plan.evidence.is_some(),
                    search: plan.evidence.is_none().then_some(SearchRecord {
                        names: group.lookup.names,
                        files: group.lookup.files,
                        cut: group.lookup.cut,
                        elapsed_ms: group.lookup.elapsed_ms,
                    }),
                    folder: group.checkout.root().to_string_lossy().into_owned(),
                    checkout: Arc::clone(&group.checkout),
                    branch: branch.clone(),
                    gate,
                    history_timeout: HISTORY_TIMEOUT,
                    absence: Mutex::default(),
                    confirmations: Mutex::default(),
                    files: Mutex::default(),
                });
            }
        }
        Ok(batches)
    }

    /// The messages for `memories`, all checked in `checkout`, the plain
    /// search behind their `Not found` lines, the confirmed memories that
    /// still stand at the checkout's commit because every line they cite is
    /// unchanged ([`recheck`]), which need no message, and the ids of the
    /// memories left out of every message. `lined` holds the memories
    /// checked against their own line; every other memory stays confirmed
    /// only where every live branch holds its lines, and is left out when
    /// every file it is mapped to differs between live branches (`live`, for
    /// the main checkout's group): a confirmation from lines of those files
    /// is almost always refused, and a rewrite or an archive always is. A
    /// message checked by reading holds at most `read_batch` memories.
    fn plan_group<'a>(
        &self,
        checkout: &Checkout,
        memories: &[&'a Memory],
        lined: &HashSet<i64>,
        live: Option<&Gate>,
        read_batch: usize,
    ) -> (Vec<Planned<'a>>, Lookup, Vec<Rechecked>, Vec<i64>) {
        let mut left_out = Vec::new();
        let mut send = |memory: &&Memory| {
            let unsendable = !lined.contains(&memory.id)
                && live.is_some_and(|live| live.all_differ(&memory.files));
            if unsendable {
                left_out.push(memory.id);
            }
            !unsendable
        };
        let mut plans: Vec<Planned<'a>> = Vec::new();
        if self.broad {
            let sent: Vec<&Memory> = memories.iter().copied().filter(&mut send).collect();
            let lookup = if sent.is_empty() {
                Lookup::default()
            } else {
                look_up(checkout, &sent, &SEARCH_LIMITS)
            };
            for chunk in broad_order(&sent, &lookup.gone).chunks(read_batch) {
                plans.push(Planned {
                    memories: chunk.to_vec(),
                    evidence: None,
                });
            }
            return (plans, lookup, Vec::new(), left_out);
        }
        let changes = Changes::read(checkout, memories);
        let selected: Vec<&Memory> = memories
            .iter()
            .copied()
            .filter(|memory| changed(memory, &changes))
            .collect();
        let (confirmed, never): (Vec<&Memory>, Vec<&Memory>) = selected
            .into_iter()
            .partition(|memory| memory.confirmation.is_some());
        let mut kept = Vec::new();
        let mut stale = Vec::new();
        for memory in confirmed {
            let live = live.filter(|_| !lined.contains(&memory.id));
            match memory
                .confirmation
                .as_ref()
                .and_then(|confirmation| recheck(checkout, confirmation, live))
            {
                Some(confirmation) => kept.push(Rechecked {
                    id: memory.id,
                    revision: memory.revision,
                    verified_at: memory.verified_at,
                    confirmation,
                }),
                None => stale.push(memory),
            }
        }
        stale.retain(&mut send);
        let never: Vec<&Memory> = never.into_iter().filter(&mut send).collect();
        let mut read: Vec<&Memory> = Vec::new();
        for chunk in stale.chunks(DIFF_BATCH_SIZE) {
            match evidence(checkout, chunk) {
                Some(evidence) => plans.push(Planned {
                    memories: chunk.to_vec(),
                    evidence: Some(evidence),
                }),
                None => read.extend(chunk),
            }
        }
        read.extend(never);
        for chunk in read.chunks(read_batch) {
            plans.push(Planned {
                memories: chunk.to_vec(),
                evidence: None,
            });
        }
        let lookup = if read.is_empty() {
            Lookup::default()
        } else {
            look_up(checkout, &read, &SEARCH_LIMITS)
        };
        (plans, lookup, kept, left_out)
    }
}

/// A confirmed memory whose cited lines are unchanged, as a re-check found
/// it: it stays confirmed, now at the re-check's commit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Rechecked {
    pub id: i64,
    /// The revision the re-check read; a memory changed since is left as it
    /// is.
    pub revision: i64,
    /// The time of the confirmation that stands.
    pub verified_at: i64,
    /// Its spans, where they are at the new commit.
    pub confirmation: Confirmation,
}

/// `confirmation`, still standing at `checkout`'s commit, or `None` when a
/// line it cites changed or is gone. Each stored span's text must be in the
/// same file at that commit, anywhere, so lines that moved still match; for
/// a memory without a line of its own (`live`), on every live branch too.
/// What it returns carries the new commit and where each span is now. Git
/// failing counts as a change: the memory then goes to a model.
fn recheck(
    checkout: &Checkout,
    confirmation: &Confirmation,
    live: Option<&Gate>,
) -> Option<Confirmation> {
    let commit = checkout.head()?;
    let mut spans = Vec::new();
    for span in &confirmation.spans {
        let (path, file) = checkout.committed(&span.path).ok()??;
        if path != span.path {
            return None;
        }
        let (start, end) = find_lines(&file, &span.text)?;
        spans.push(Cited {
            path,
            start,
            end,
            text: span.text.clone(),
        });
    }
    if live.is_some_and(|live| live.lines_differ(&spans).is_some()) {
        return None;
    }
    Some(Confirmation {
        commit: commit.to_owned(),
        spans,
        derive: confirmation.derive.clone(),
    })
}

/// Record that each of `rechecked` stays confirmed at its new commit: the
/// commit and the spans' new places replace the old ones, the time of the
/// confirmation stays. A memory whose text or confirmation changed since
/// the re-check read it is left alone. Returns how many were recorded.
fn record_rechecked(conn: &mut Connection, rechecked: &[Rechecked]) -> rusqlite::Result<usize> {
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let mut recorded = 0;
    for memory in rechecked {
        recorded += tx.execute(
            &format!(
                "UPDATE memories SET verify_commit = ?2,
                        metadata_json = json_set({METADATA}, '$.dreamerVerifiedCommit', ?2,
                                                 '$.{STORED_KEY}', json(?3))
                  WHERE id = ?1 AND revision = ?4
                    AND CASE WHEN json_valid(metadata_json)
                             THEN json_extract(metadata_json, '$.{STORED_KEY}.verifiedAt') END = ?5"
            ),
            params![
                memory.id,
                memory.confirmation.commit,
                memory.confirmation.json(memory.verified_at).to_string(),
                memory.revision,
                memory.verified_at
            ],
        )?;
    }
    tx.commit()?;
    Ok(recorded)
}

/// Where each of `memories` is checked, the main checkout first and then
/// each copied branch by name. A memory that names a branch is checked on
/// that branch's newest commit, or on the default branch's when its own is
/// gone; in the main checkout when that branch is checked out there. A
/// memory that names none, or whose branch and the default branch are both
/// unknown, is checked in the main checkout without a line of its own.
fn group_by_line<'a>(memories: &[&'a Memory], refs: Option<&Refs>) -> BTreeMap<Target, Group<'a>> {
    let mut groups: BTreeMap<Target, Group<'a>> = BTreeMap::new();
    for memory in memories {
        let line = memory
            .branch
            .as_deref()
            .zip(refs)
            .and_then(|(branch, refs)| {
                refs.tip(branch)
                    .map(|commit| (branch.to_owned(), commit.to_owned()))
                    .or_else(|| refs.default_branch())
                    .map(|(branch, commit)| {
                        (refs.main_branch() == Some(branch.as_str()), branch, commit)
                    })
            });
        let (target, lined) = match line {
            Some((true, _, _)) => (Target::Main, true),
            Some((false, branch, commit)) => (Target::Copy { branch, commit }, true),
            None => (Target::Main, false),
        };
        let group = groups.entry(target).or_insert_with(|| Group {
            memories: Vec::new(),
            lined: HashSet::new(),
        });
        group.memories.push(memory);
        if lined {
            group.lined.insert(memory.id);
        }
    }
    groups
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
    /// Checked against its own line (see [`group_by_line`]); a memory that is
    /// not is only ever confirmed while the repository has more than one
    /// live branch ([`live`]).
    pub lined: bool,
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
    /// Not in the checkout. Once [`in_history`] has run, also held by some
    /// commit of the checked-out history: removed.
    Absent,
    Present,
    /// Not in the checkout, and no commit of its history ever held it: the
    /// memory's subject was never in this repository (another module's
    /// parameter, a host's variable), so its absence says nothing about
    /// whether the memory still holds.
    Never,
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

/// Whether what `cite` names, already absent from the checkout, was ever in
/// its checked-out history: a path some commit touched, a code name some
/// commit added or removed. [`Absence::Absent`] when it was, so it was
/// removed; [`Absence::Never`] when not; undecided when git fails or runs
/// past `timeout`.
fn in_history(checkout: &Checkout, cite: &Cite, timeout: Duration) -> Absence {
    let held = match cite {
        Cite::Path(path) => checkout.path_in_history(path, timeout),
        Cite::Name(name) => checkout.text_in_history(name, timeout),
    };
    match held {
        Ok(true) => Absence::Absent,
        Ok(false) => Absence::Never,
        Err(why) => Absence::Undecided(format!("searching the history for it failed: {why}")),
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
    /// The folder the batch's child session reads: the main checkout, or a
    /// copy of one branch.
    folder: String,
    checkout: Arc<Checkout>,
    /// The branch the checkout holds, which a rewrite of a memory checked
    /// against its own line records with the checkout's commit; `None` when
    /// the main checkout's HEAD is detached.
    branch: Option<String>,
    /// The live-branch check of the batch's memories without a line of
    /// their own; `None` when it holds none.
    gate: Option<Gate>,
    /// How long git may search the history for one `missing` a reply names
    /// ([`HISTORY_TIMEOUT`]).
    history_timeout: Duration,
    /// What each `missing` a reply names was found to be: whether the
    /// checkout holds it and, when not, whether its history ever did. The
    /// lookups run when the reply is accepted, before the store's write lock
    /// is taken, and the write reads the answer from here.
    absence: Mutex<HashMap<Cite, Absence>>,
    /// Each confirmation's check, by memory and the `cites` and `derive` the
    /// reply gave: the cited lines it rests on, or why it counts as a skip.
    /// The checks run when the reply is accepted, before the store's write
    /// lock is taken, and the write reads the answer from here.
    confirmations: Mutex<HashMap<ConfirmationKey, Result<Confirmation, String>>>,
    /// The files those checks read at the checkout's commit, by cited path.
    files: Mutex<HashMap<String, Committed>>,
}

/// A confirmation's memory, `cites` and `derive`, as one reply gave them.
type ConfirmationKey = (i64, Option<String>, Option<String>);

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

    #[cfg(test)]
    pub(crate) fn checkout(&self) -> &Checkout {
        &self.checkout
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
        let mut found = look_for(&self.checkout, cite, &SEARCH_LIMITS);
        // Only what the history once held can have been removed. Git is
        // asked only here, for a proposed archive, never while planning.
        if found == Absence::Absent {
            found = in_history(&self.checkout, cite, self.history_timeout);
        }
        self.absence
            .lock()
            .expect("absence cache")
            .insert(cite.clone(), found.clone());
        found
    }

    /// The cited lines confirmation `verdict` rests on, or why it counts as
    /// a skip ([`confirm`]); for a memory without a line of its own, also
    /// only where every live branch holds those lines ([`live`]).
    pub(crate) fn confirmation(&self, verdict: &Verdict) -> Result<Confirmation, String> {
        let key = (verdict.id, verdict.cites.clone(), verdict.derive.clone());
        if let Some(known) = self.confirmations.lock().expect("confirmations").get(&key) {
            return known.clone();
        }
        let checked = match self.read.iter().find(|read| read.id == verdict.id) {
            None => Err(format!("memory {} is not in this batch", verdict.id)),
            Some(read) => confirm(
                &read.content,
                self.checkout.top_level(),
                verdict.cites.as_deref(),
                verdict.derive.as_deref(),
                self.commit(),
                &|cited| self.committed(cited),
            )
            .and_then(|confirmation| match (&self.gate, read.lined) {
                (Some(gate), false) => match gate.lines_differ(&confirmation.spans) {
                    Some(why) => Err(why),
                    None => Ok(confirmation),
                },
                _ => Ok(confirmation),
            }),
        };
        self.confirmations
            .lock()
            .expect("confirmations")
            .insert(key, checked.clone());
        checked
    }

    /// The file `cited` names at the checkout's commit, read once per batch.
    fn committed(&self, cited: &str) -> Committed {
        if let Some(known) = self.files.lock().expect("cited files").get(cited) {
            return known.clone();
        }
        let read = self.checkout.committed(cited);
        self.files
            .lock()
            .expect("cited files")
            .insert(cited.to_owned(), read.clone());
        read
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
                    .map(|read| cites::cites(&read.content, self.checkout.top_level()))
                    .and_then(|cited| cited.into_iter().find(|cite| cite.text() == missing))
                {
                    self.absence(&cite);
                }
            }
        }
        // The live branches are read here too, before the store's write
        // lock is taken, for each change the write will check against them,
        // and so are the lines each confirmation cites.
        self.warm_gate(&verdicts);
        for verdict in &verdicts {
            if verdict.decision == Decision::Verified {
                let _ = self.confirmation(verdict);
            }
        }
        Ok(())
    }

    fn step_cap(&self) -> Option<StepCap> {
        Some(StepCap {
            steps: STEP_CAP,
            finalize: FINALIZE,
        })
    }
}

impl Batch for VerifyBatch {
    fn apply(&self, tx: &Transaction<'_>, reply: &TaskReply, run: i64) -> Result<Applied, String> {
        let verdicts = parse_manifest(&reply.text, &self.ids())?;
        self.write(tx, &verdicts, run)
            .map_err(|error| format!("writing verdicts: {error}"))
    }

    fn folder(&self) -> Option<&str> {
        Some(&self.folder)
    }

    /// Each memory of the batch is written as a `<skip>` verdict is, with
    /// the same checks, so it is marked checked and a broad run reaches the
    /// memories it has not checked first.
    fn skip(&self, tx: &Transaction<'_>, run: i64) -> Result<Applied, String> {
        let skips: Vec<Verdict> = self
            .read
            .iter()
            .map(|read| Verdict {
                id: read.id,
                decision: Decision::Skip,
                files: Vec::new(),
                content: String::new(),
                reason: "the model reached its step cap without a usable answer".into(),
                consolidation: false,
                missing: None,
                cites: None,
                derive: None,
            })
            .collect();
        self.write(tx, &skips, run)
            .map_err(|error| format!("writing skips: {error}"))
    }

    fn memory_ids(&self) -> Vec<i64> {
        self.ids()
    }
}

#[cfg(test)]
#[path = "verify_tests.rs"]
pub(crate) mod tests;

#[cfg(test)]
mod lines_tests;
