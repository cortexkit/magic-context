//! Background lexical indexing under the standalone plugin's SQLite lease.

use super::index::{self, GitLogFailure, IndexOptions, IndexResult, ReadOptions};
use crate::{McStore, McStoreError};
use rusqlite::{params, OptionalExtension};
use std::path::Path;

const COOLDOWN_MS: i64 = 10 * 60_000;
const LEASE_MS: i64 = 5 * 60_000;
const NON_INDEXABLE_REPROBE_MS: i64 = 24 * 60 * 60_000;
const MAX_COMMITS_PER_SWEEP: f64 = 20_000.0;

impl McStore {
    /// Index one bounded Git window without holding the context writer during Git
    /// execution. The shared lease excludes standalone plugin sweeps as well as
    /// other module processes. Missing/expired ownership cannot publish a batch.
    pub fn index_git_commits(
        &self,
        project: &str,
        directory: &Path,
        options: &IndexOptions,
        now: i64,
        completed_at: impl FnOnce() -> i64,
    ) -> Result<Option<IndexResult>, McStoreError> {
        if project.starts_with("dir:") {
            return Ok(None);
        }
        let claim = self.context_write(&["git_sweep_coordinator"], |tx| {
            let state = tx
                .query_row(
                    "SELECT lease_holder, lease_expires_at, last_swept_at
                     FROM git_sweep_coordinator WHERE project_path=?1",
                    [project],
                    |row| {
                        Ok((
                            row.get::<_, Option<String>>(0)?,
                            row.get::<_, Option<i64>>(1)?,
                            row.get::<_, Option<i64>>(2)?,
                        ))
                    },
                )
                .optional()?;
            if state.is_some_and(|(holder, expires, swept)| {
                (holder.is_some() && expires.is_some_and(|expiry| expiry > now))
                    || swept.is_some_and(|swept| swept.saturating_add(COOLDOWN_MS) > now)
            }) {
                return Ok(None);
            }
            let holder: String =
                tx.query_row("SELECT lower(hex(randomblob(16)))", [], |row| row.get(0))?;
            tx.execute(
                "INSERT INTO git_sweep_coordinator
                 (project_path,lease_holder,lease_expires_at,last_swept_at)
                 VALUES (?1,?2,?3,NULL) ON CONFLICT(project_path) DO UPDATE SET
                 lease_holder=excluded.lease_holder,lease_expires_at=excluded.lease_expires_at",
                params![project, holder, now.saturating_add(LEASE_MS)],
            )?;
            Ok(Some((holder, index::latest_indexed_sha(tx, project)?)))
        })?;
        let Some((holder, latest)) = claim else {
            return Ok(None);
        };
        // The schema caps the user's retention at 20,000. Keep the same hard work
        // bound even if an older/unvalidated config requests unlimited retention.
        let limit = if options.max_commits > 0.0 {
            options.max_commits.min(MAX_COMMITS_PER_SWEEP)
        } else {
            MAX_COMMITS_PER_SWEEP
        };
        let read = index::read_git_commits(
            directory,
            &ReadOptions {
                since_ms: Some((now as f64 - options.since_days * 86_400_000.0) as i64),
                max_commits: limit,
                exclude_reachable_from: latest,
                ..ReadOptions::default()
            },
        )
        .expect("the fixed HEAD revision is not an option");
        let end = completed_at();
        let result = self.context_write(
            &[
                "git_commits",
                "git_commit_embeddings",
                "git_sweep_coordinator",
            ],
            |tx| {
                let owned: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM git_sweep_coordinator
                     WHERE project_path=?1 AND lease_holder=?2 AND lease_expires_at>?3)",
                    params![project, holder, end],
                    |row| row.get(0),
                )?;
                if !owned {
                    return Ok(None);
                }
                if read.failure == Some(GitLogFailure::Transient) {
                    return Err(rusqlite::Error::InvalidQuery);
                }
                let non_indexable = matches!(
                    read.failure,
                    Some(GitLogFailure::NotARepo | GitLogFailure::NoHead)
                );
                let mut result = IndexResult {
                    scanned: read.commits.len(),
                    non_indexable,
                    ..IndexResult::default()
                };
                if !non_indexable {
                    let upsert = index::upsert_batch(tx, project, &read.commits, end)?;
                    result.inserted = upsert.inserted;
                    result.updated = upsert.updated;
                    result.evicted = index::enforce_project_cap(tx, project, options.max_commits)?;
                }
                let swept = if non_indexable {
                    end.saturating_add(NON_INDEXABLE_REPROBE_MS - COOLDOWN_MS)
                } else {
                    end
                };
                tx.execute(
                    "UPDATE git_sweep_coordinator SET lease_holder=NULL,
                     lease_expires_at=NULL,last_swept_at=?3
                     WHERE project_path=?1 AND lease_holder=?2",
                    params![project, holder, swept],
                )?;
                Ok(Some(result))
            },
        );
        if result.is_err() {
            // A failed sweep must not start a success cooldown. If another owner
            // took over meanwhile, its lease is left untouched.
            let _ = self.context_write(&["git_sweep_coordinator"], |tx| {
                tx.execute(
                    "UPDATE git_sweep_coordinator SET lease_holder=NULL,lease_expires_at=NULL
                     WHERE project_path=?1 AND lease_holder=?2",
                    params![project, holder],
                )?;
                Ok(())
            });
        }
        result
    }
}
