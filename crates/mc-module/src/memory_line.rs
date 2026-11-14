//! The git line a memory was learned on: the branch checked out in the
//! writing session's folder (none when its HEAD was detached) and the commit
//! it was at, stored in the memory's `source_branch` and `source_commit`.
//!
//! A repository can carry several live lines at once, a release branch next
//! to the next version's for example, and a fact true on one may be false on
//! another. The dreamer's verify tasks check a memory that names its branch
//! against that branch, and change a memory without one only where every
//! live line agrees (see `dreamer::tasks::verify`).
//!
//! Who records what:
//! - a memory a session writes (the agent's memory tool, the summarizer's
//!   second turn) records the session folder's line at write time, and so
//!   does a session's rewrite of one memory;
//! - a merge, and a split's new parts, carry the line their sources share
//!   when every source names the same branch, and none otherwise;
//! - a background rewrite of one memory by the dreamer keeps the memory's
//!   line, except a verify rewrite, which names the branch it checked.

use std::path::Path;
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};

/// How long reading a folder's line may take before the memory is written
/// without one.
const LINE_TIMEOUT: Duration = Duration::from_secs(5);

/// A memory's git line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Line {
    /// The branch, without `refs/heads/`; `None` when HEAD was detached.
    pub branch: Option<String>,
    /// The commit HEAD was at.
    pub commit: Option<String>,
}

impl Line {
    /// The line checked out in `folder`, read with one git command. `None`
    /// when the folder is in no repository, its branch has no commit yet,
    /// or git fails or runs out of time: the memory is then written without
    /// a line, which the verify tasks treat as the most careful case.
    pub fn of_folder(folder: &Path) -> Option<Self> {
        if !folder.is_dir() {
            return None;
        }
        let printed = crate::dreamer::checkout::run_git_within(
            folder,
            &["rev-parse", "HEAD", "--symbolic-full-name", "HEAD"],
            LINE_TIMEOUT,
        )
        .ok()?;
        let mut lines = printed.lines().map(str::trim);
        let commit = lines
            .next()
            .filter(|commit| crate::dreamer::checkout::is_commit(commit))?
            .to_owned();
        // A detached HEAD prints `HEAD` here.
        let branch = lines
            .next()
            .and_then(|name| name.strip_prefix("refs/heads/"))
            .filter(|name| !name.is_empty())
            .map(str::to_owned);
        Some(Self {
            branch,
            commit: Some(commit),
        })
    }
}

/// Read `folder`'s line on a blocking thread, for a caller on the async
/// runtime. `None` when there is no folder or no line.
pub(crate) async fn of_folder_async(folder: Option<String>) -> Option<Line> {
    let folder = folder?;
    tokio::task::spawn_blocking(move || Line::of_folder(Path::new(&folder)))
        .await
        .ok()
        .flatten()
}

/// Record `line` as memory `id`'s line; `None` clears it.
pub(crate) fn stamp(conn: &Connection, id: i64, line: Option<&Line>) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE memories SET source_branch = ?2, source_commit = ?3 WHERE id = ?1",
        params![
            id,
            line.and_then(|line| line.branch.as_deref()),
            line.and_then(|line| line.commit.as_deref())
        ],
    )?;
    Ok(())
}

/// Memory `id`'s line; `None` when it records none.
pub(crate) fn of_memory(conn: &Connection, id: i64) -> rusqlite::Result<Option<Line>> {
    Ok(conn
        .query_row(
            "SELECT source_branch, source_commit FROM memories WHERE id = ?1",
            params![id],
            |row| {
                Ok(Line {
                    branch: row.get(0)?,
                    commit: row.get(1)?,
                })
            },
        )
        .optional()?
        .filter(|line| line.branch.is_some() || line.commit.is_some()))
}

/// The line memories `ids` share: their branch when every one names the same
/// branch, with their commit when that is shared too. `None` when one names
/// no branch or two name different ones.
pub(crate) fn shared(conn: &Connection, ids: &[i64]) -> rusqlite::Result<Option<Line>> {
    let mut lines = Vec::with_capacity(ids.len());
    for id in ids {
        match of_memory(conn, *id)? {
            Some(line) if line.branch.is_some() => lines.push(line),
            _ => return Ok(None),
        }
    }
    let Some(first) = lines.first().cloned() else {
        return Ok(None);
    };
    if lines.iter().any(|line| line.branch != first.branch) {
        return Ok(None);
    }
    let commit = if lines.iter().all(|line| line.commit == first.commit) {
        first.commit
    } else {
        None
    };
    Ok(Some(Line {
        branch: first.branch,
        commit,
    }))
}

#[cfg(test)]
#[path = "memory_line_tests.rs"]
mod tests;
