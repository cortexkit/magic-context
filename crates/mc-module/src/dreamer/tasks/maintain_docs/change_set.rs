//! The code changes the docs-upkeep task reads: what changed in the main
//! checkout between the commit it last processed and the current one,
//! ported from the 0.49 plugin's `docsChangeSet` (`docs-proposals.ts`).
//!
//! The changed paths (both paths of a rename) are filtered first: the two
//! documents, test and spec files, lock files and CortexKit's own folder
//! (`.cortexkit/`) are left out. The change
//! is worth a model run only when one remaining path, or its folder, is
//! named in the documents, or when it adds a file under a top-level area
//! (a folder one or two levels deep) that didn't exist before and that the
//! documents don't name yet, so a new subsystem can still reach them.
//! Otherwise the run ends without a model call.
//!
//! The text the model gets is the paths, the diff stat and the hunks. When
//! that is longer than [`TEXT_BUDGET`] characters it is the paths, each
//! changed file's line ranges and the stat; when the paths alone are too
//! many to hand git, it is the path list.

use std::path::Path;
use std::sync::OnceLock;

use regex::Regex;

use crate::docs_proposals::DOCUMENTS;
use crate::dreamer::checkout::{run_git_output, run_git_within, GIT_TIMEOUT};

/// The longest change text, in UTF-16 units as the plugin counted.
pub(crate) const TEXT_BUDGET: usize = 32_000;
/// Pathspec bytes allowed on one git command line. macOS caps arguments plus
/// environment at 1 MiB and Linux usually at 2 MiB; beyond this the changed
/// files are listed instead of passed to git, whose start would fail because
/// its argument list is over the operating system's limit.
pub(crate) const MAX_PATHSPEC_BYTES: usize = 256_000;

/// The commits a change runs between.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Range {
    /// The commit the change starts from: the recorded commit, or its merge
    /// base with `head` when the recorded commit isn't an ancestor of it.
    pub base: String,
    pub head: String,
}

/// What the change between two commits holds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    /// It changes no file other than the two documents.
    DocumentsOnly,
    /// Every path it changes is a document, a test or spec, or a lock file.
    Filtered,
    /// No changed path is named in the documents, and it adds no new area.
    NotRelevant,
    /// The text the model reads.
    Changes(String),
}

/// One changed path: git's status letter, and the path it now has.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Changed {
    status: char,
    /// Every path the entry names: the old and new path of a rename or copy.
    paths: Vec<String>,
}

fn filtered_out() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?:^|[./-])(?:test|spec)(?:[./-]|$)").expect("the filter compiles")
    })
}

/// Whether a changed path stays out of the change: a document, a test or
/// spec, a lock file, or a file of CortexKit's own folder (the proposals'
/// markdown copies live there, and are not code).
pub(crate) fn left_out(path: &str) -> bool {
    DOCUMENTS.contains(&path)
        || filtered_out().is_match(path)
        || path.ends_with(".lock")
        || path.starts_with(".cortexkit/")
}

fn git(repo: &Path, args: &[&str]) -> Result<String, String> {
    run_git_within(repo, args, GIT_TIMEOUT).map(|out| out.trim().to_owned())
}

/// Whether `commit` names a commit of the repository at `repo`.
pub(crate) fn is_commit(repo: &Path, commit: &str) -> bool {
    crate::dreamer::checkout::is_commit(commit)
        && git(repo, &["cat-file", "-t", commit]).is_ok_and(|kind| kind == "commit")
}

/// The commits the change from `recorded` to `head` runs between: from
/// `recorded` when it is an ancestor of `head`, and from their merge base
/// otherwise (the checkout moved to another branch). `None` when the two
/// share no history.
pub(crate) fn range(repo: &Path, recorded: &str, head: &str) -> Result<Option<Range>, String> {
    let ancestor = run_git_output(
        repo,
        &["merge-base", "--is-ancestor", recorded, head],
        GIT_TIMEOUT,
    )?;
    let base = match ancestor.code {
        Some(0) => recorded.to_owned(),
        Some(1) => match run_git_output(repo, &["merge-base", recorded, head], GIT_TIMEOUT)? {
            output if output.code == Some(0) => output.stdout.trim().to_owned(),
            output if output.code == Some(1) => return Ok(None),
            output => return Err(output.stderr.trim().chars().take(500).collect()),
        },
        _ => return Err(ancestor.stderr.trim().chars().take(500).collect()),
    };
    Ok(Some(Range {
        base,
        head: head.to_owned(),
    }))
}

/// The paths changed between the range's commits, renames detected.
fn changed(repo: &Path, range: &Range) -> Result<Vec<Changed>, String> {
    let listed = run_git_within(
        repo,
        &[
            "diff",
            "-M",
            "--name-status",
            "-z",
            &range.base,
            &range.head,
            "--",
            ".",
        ],
        GIT_TIMEOUT,
    )?;
    let mut fields = listed.split('\0').filter(|field| !field.is_empty());
    let mut entries = Vec::new();
    while let Some(status) = fields.next() {
        let letter = status.chars().next().unwrap_or('M');
        let count = if matches!(letter, 'R' | 'C') { 2 } else { 1 };
        let paths: Vec<String> = fields.by_ref().take(count).map(str::to_owned).collect();
        entries.push(Changed {
            status: letter,
            paths,
        });
    }
    Ok(entries)
}

/// The folders one and two levels deep that hold `path` (`crates` and
/// `crates/mc-store` for `crates/mc-store/src/lib.rs`).
fn top_folders(path: &str) -> Vec<String> {
    let parts: Vec<&str> = path.split('/').collect();
    (1..=2)
        .filter(|depth| parts.len() > *depth)
        .map(|depth| parts[..depth].join("/"))
        .collect()
}

/// Whether the change adds a file under a top-level area that didn't exist
/// at `base` and that `documents` don't name.
fn adds_an_area(
    repo: &Path,
    base: &str,
    entries: &[Changed],
    documents: &str,
) -> Result<bool, String> {
    let mut asked = std::collections::BTreeSet::new();
    for entry in entries {
        let added = match entry.status {
            'A' => entry.paths.first(),
            'R' | 'C' => entry.paths.get(1),
            _ => None,
        };
        let Some(added) = added.filter(|path| !left_out(path)) else {
            continue;
        };
        for folder in top_folders(added) {
            if documents.contains(&folder) || !asked.insert(folder.clone()) {
                continue;
            }
            if git(repo, &["ls-tree", base, "--", &folder])?.is_empty() {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// The first `limit` UTF-16 units of `text`, ending on a whole character.
fn cut(text: &str, limit: usize) -> &str {
    let mut units = 0;
    for (at, c) in text.char_indices() {
        units += c.len_utf16();
        if units > limit {
            return &text[..at];
        }
    }
    text
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// The change between the range's commits, judged against `documents` (the
/// two documents' current text joined by a newline).
pub(crate) fn build(repo: &Path, range: &Range, documents: &str) -> Result<Outcome, String> {
    let entries = changed(repo, range)?;
    if entries
        .iter()
        .flat_map(|entry| &entry.paths)
        .all(|path| DOCUMENTS.contains(&path.as_str()))
    {
        return Ok(Outcome::DocumentsOnly);
    }
    let mut files: Vec<String> = Vec::new();
    for path in entries.iter().flat_map(|entry| &entry.paths) {
        if !left_out(path) && !files.contains(path) {
            files.push(path.clone());
        }
    }
    if files.is_empty() {
        return Ok(Outcome::Filtered);
    }
    let named = files.iter().any(|file| {
        let folder = file.rsplit_once('/').map_or("", |(folder, _)| folder);
        documents.contains(file.as_str()) || (folder.len() > 2 && documents.contains(folder))
    });
    if !named && !adds_an_area(repo, &range.base, &entries, documents)? {
        return Ok(Outcome::NotRelevant);
    }
    let pathspec_bytes: usize = files.iter().map(|file| file.len() + 1).sum();
    if pathspec_bytes > MAX_PATHSPEC_BYTES {
        let listed = files.join("\n");
        return Ok(Outcome::Changes(format!(
            "Changed files (too many to include a diff):\n{}",
            cut(&listed, TEXT_BUDGET)
        )));
    }
    let diff_args = |extra: &str| -> Vec<String> {
        let mut args: Vec<String> = [
            "--literal-pathspecs",
            "diff",
            "-M",
            extra,
            range.base.as_str(),
            range.head.as_str(),
            "--",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect();
        args.extend(files.iter().cloned());
        args
    };
    let run = |extra: &str| -> Result<String, String> {
        let args = diff_args(extra);
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        git(repo, &args)
    };
    let stat = run("--stat")?;
    let patch = run("--unified=3")?;
    let listed = files.join("\n");
    let text = format!("Changed files:\n{listed}\n\nStat:\n{stat}\n\nHunks:\n{patch}");
    if utf16_len(&text) <= TEXT_BUDGET {
        return Ok(Outcome::Changes(text));
    }
    static RANGES: OnceLock<Regex> = OnceLock::new();
    let ranges = RANGES.get_or_init(|| {
        Regex::new(r"(?m)^\+\+\+ b/(.+)$|^@@ .* \+(\d+)(?:,(\d+))? @@").expect("ranges compile")
    });
    let lines: Vec<String> = ranges
        .captures_iter(&patch)
        .map(|found| match found.get(1) {
            Some(file) => format!("file: {}", file.as_str()),
            None => format!(
                "line: {} +{}",
                found.get(2).map_or("", |line| line.as_str()),
                found.get(3).map_or("1", |count| count.as_str())
            ),
        })
        .collect();
    Ok(Outcome::Changes(format!(
        "Changed files and ranges (diff exceeds prompt budget):\n{listed}\n{}\n\nStat:\n{stat}",
        cut(&lines.join("\n"), TEXT_BUDGET)
    )))
}

#[cfg(test)]
#[path = "change_set_tests.rs"]
mod tests;
