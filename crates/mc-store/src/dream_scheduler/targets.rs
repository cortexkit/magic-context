//! Which projects the Rust dreamer ticks, kept in the scheduler's own database
//! so a restart keeps ticking them.
//!
//! A row only says "this project was served here recently, in this folder". It
//! is never a source of identity: the dreamer resolves the project id from
//! Entorhinal again before every run, and `project_id` here is only the last
//! answer it got, kept so a changed answer can be noticed and logged.

use super::{Error, Result, SqliteDreamScheduler};
use rusqlite::{params, OptionalExtension};

/// One project the dreamer should tick.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DreamTargetRow {
    /// The store's project key: the key the project's dream schedules use.
    pub project: String,
    /// The folder the project's dream runs work in.
    pub workdir: String,
    /// The last project id Entorhinal answered for `workdir`, if any run has
    /// asked yet. Informational only; see the module documentation.
    pub project_id: Option<String>,
    /// When ck-mc last served a conversation of this project, in Unix ms.
    pub seen_at: i64,
}

impl SqliteDreamScheduler {
    /// Remember that `row.project` was served in `row.workdir` at `row.seen_at`.
    /// A row without a project id keeps the id already stored, so recording a
    /// sighting never forgets what the last run learned from Entorhinal. A
    /// sighting older than the stored one changes nothing.
    pub fn record_target(&self, row: &DreamTargetRow) -> Result<()> {
        if row.project.trim().is_empty() || row.workdir.trim().is_empty() {
            return Err(Error::Refused("invalid_target"));
        }
        self.write(|db| {
            db.execute(
                "INSERT INTO dream_targets(project, workdir, project_id, seen_at) VALUES(?1, ?2, ?3, ?4)
                 ON CONFLICT(project) DO UPDATE SET
                    workdir = excluded.workdir,
                    project_id = COALESCE(excluded.project_id, dream_targets.project_id),
                    seen_at = excluded.seen_at
                 WHERE excluded.seen_at >= dream_targets.seen_at",
                params![row.project, row.workdir, row.project_id, row.seen_at],
            )?;
            Ok(())
        })
    }

    /// Every project seen within `ttl_ms` of `now`, oldest sighting first. Rows
    /// older than that are deleted here, so a project nobody serves any more
    /// stops being ticked and its row does not linger.
    pub fn live_targets(&self, now: i64, ttl_ms: i64) -> Result<Vec<DreamTargetRow>> {
        let cutoff = now.saturating_sub(ttl_ms);
        self.write(|db| {
            db.execute("DELETE FROM dream_targets WHERE seen_at < ?1", [cutoff])?;
            let mut statement = db.prepare(
                "SELECT project, workdir, project_id, seen_at FROM dream_targets ORDER BY seen_at, project",
            )?;
            let rows = statement
                .query_map([], |r| {
                    Ok(DreamTargetRow {
                        project: r.get(0)?,
                        workdir: r.get(1)?,
                        project_id: r.get(2)?,
                        seen_at: r.get(3)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    /// The stored row for `project`, if any.
    pub fn target(&self, project: &str) -> Result<Option<DreamTargetRow>> {
        self.read(|db| {
            Ok(db
                .query_row(
                    "SELECT project, workdir, project_id, seen_at FROM dream_targets WHERE project = ?1",
                    [project],
                    |r| {
                        Ok(DreamTargetRow {
                            project: r.get(0)?,
                            workdir: r.get(1)?,
                            project_id: r.get(2)?,
                            seen_at: r.get(3)?,
                        })
                    },
                )
                .optional()?)
        })
    }

    /// Store the project id Entorhinal answered for `project`'s folder on its
    /// existing row (nothing is stored when the project has no row). Returns
    /// the id stored before, so the caller can tell whether it changed.
    pub fn set_target_project_id(&self, project: &str, project_id: &str) -> Result<Option<String>> {
        self.write(|db| {
            let previous: Option<Option<String>> = db
                .query_row(
                    "SELECT project_id FROM dream_targets WHERE project = ?1",
                    [project],
                    |r| r.get(0),
                )
                .optional()?;
            db.execute(
                "UPDATE dream_targets SET project_id = ?2 WHERE project = ?1",
                params![project, project_id],
            )?;
            Ok(previous.flatten())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(project: &str, project_id: Option<&str>, seen_at: i64) -> DreamTargetRow {
        DreamTargetRow {
            project: project.into(),
            workdir: format!("/work/{project}"),
            project_id: project_id.map(str::to_owned),
            seen_at,
        }
    }

    /// A scheduler.db written by a build without `dream_targets` (the three
    /// tables only, application id set) opens and gains the table.
    #[test]
    fn a_scheduler_database_from_before_targets_opens_and_gains_the_table() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("scheduler.db");
        {
            let db = rusqlite::Connection::open(&path).unwrap();
            db.execute_batch("PRAGMA application_id=1296254035;
                CREATE TABLE dream_schedules(project TEXT NOT NULL, task TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(project,task));
                CREATE TABLE dream_leases(domain TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at INTEGER NOT NULL);
                CREATE TABLE dream_runs(project TEXT NOT NULL, invocation TEXT NOT NULL, token TEXT NOT NULL UNIQUE, state TEXT NOT NULL, PRIMARY KEY(project,invocation));
                INSERT INTO dream_schedules VALUES('p', 'curate', '{}');").unwrap();
        }
        let scheduler = SqliteDreamScheduler::open(&path, true).unwrap();
        scheduler.record_target(&row("p", None, 10)).unwrap();
        assert_eq!(
            scheduler.live_targets(10, 100).unwrap(),
            [row("p", None, 10)]
        );
        // The earlier rows are untouched.
        let kept: i64 = scheduler
            .read(|db| Ok(db.query_row("SELECT count(*) FROM dream_schedules", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(kept, 1);
    }

    #[test]
    fn targets_survive_reopening_and_stale_rows_expire() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("scheduler.db");
        {
            let scheduler = SqliteDreamScheduler::open(&path, true).unwrap();
            scheduler.record_target(&row("old", None, 100)).unwrap();
            scheduler.record_target(&row("new", None, 900)).unwrap();
        }
        let reopened = SqliteDreamScheduler::open(&path, true).unwrap();
        assert_eq!(
            reopened.live_targets(1_000, 500).unwrap(),
            [row("new", None, 900)]
        );
        // The expired row is gone, not merely filtered.
        assert_eq!(reopened.target("old").unwrap(), None);
    }

    #[test]
    fn a_sighting_keeps_the_last_resolved_id_and_never_moves_backwards() {
        let root = tempfile::tempdir().unwrap();
        let scheduler = SqliteDreamScheduler::open(root.path().join("s.db"), true).unwrap();
        scheduler.record_target(&row("p", None, 10)).unwrap();
        assert_eq!(
            scheduler.set_target_project_id("p", "pj-one").unwrap(),
            None
        );
        scheduler.record_target(&row("p", None, 20)).unwrap();
        assert_eq!(
            scheduler.target("p").unwrap(),
            Some(row("p", Some("pj-one"), 20))
        );
        // An older sighting arriving late changes nothing.
        scheduler.record_target(&row("p", None, 5)).unwrap();
        assert_eq!(scheduler.target("p").unwrap().unwrap().seen_at, 20);
        assert_eq!(
            scheduler.set_target_project_id("p", "pj-two").unwrap(),
            Some("pj-one".into())
        );
        assert!(scheduler.record_target(&row(" ", None, 1)).is_err());
    }
}
