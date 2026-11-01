//! Read-only commit retrieval over the git archive producer's existing tables.

pub mod fts;
pub mod index;
mod maintenance;

use crate::parity_schema_manifest::*;
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use std::sync::Mutex;

pub use fts::{
    search, search_with_lanes, GitCommitSearchHit, MatchType, SearchOptions, SearchResults,
    StoredGitCommit,
};

/// A connection and project identity supplied by the owning context store.
/// Construction never opens a database, installs schema, or writes archive data.
pub struct SqliteGitArchive {
    connection: Mutex<Connection>,
    project: ProjectId,
}

impl SqliteGitArchive {
    pub fn new(connection: Connection, project: ProjectId) -> Self {
        Self {
            connection: Mutex::new(connection),
            project,
        }
    }

    /// Returns full commit metadata and optional vector scores when the query's
    /// model matches the stored vectors.
    pub fn search_hits(
        &self,
        query: &str,
        options: &SearchOptions,
    ) -> rusqlite::Result<SearchResults> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| rusqlite::Error::InvalidQuery)?;
        search_with_lanes(&connection, &self.project.0, query, options)
    }
}

impl GitArchiveStore for SqliteGitArchive {
    fn availability(&self) -> Availability {
        Availability::Available
    }

    fn ingest(&self, _: &GitIngestRequest) -> CapabilityResult<PublishReceipt> {
        CapabilityResult::unavailable("git_archive_ingest")
    }

    fn search(&self, request: &ArchiveQuery) -> CapabilityResult<Vec<GitCommitRecord>> {
        if request.scope.project != self.project {
            return CapabilityResult::Unavailable {
                reason: CapabilityReason {
                    code: "project_mismatch".into(),
                    message: "git archive is bound to a different project".into(),
                },
            };
        }
        let options = SearchOptions {
            limit: request.limit,
            from: request.start_at_ms,
            to: request.end_at_ms_inclusive,
            ..SearchOptions::default()
        };
        match self.search_hits(&request.query, &options) {
            Ok(result) => CapabilityResult::Available {
                value: result
                    .hits
                    .into_iter()
                    .map(|hit| {
                        let commit = hit.commit;
                        // The shared record has no score/author/short SHA fields; preserve rank
                        // through list order. Parents are not persisted by the git producer.
                        GitCommitRecord {
                            provenance: Provenance {
                                origin: InputOrigin::Core,
                                source_id: commit.sha.clone(),
                                source_revision: commit.sha.clone(),
                                content_hash: ContentHash(format!(
                                    "{:x}",
                                    Sha256::digest(commit.message.as_bytes())
                                )),
                                generation: request.scope.generation,
                                observed_at_ms: commit.indexed_at_ms,
                            },
                            sha: commit.sha,
                            parents: Vec::new(),
                            message: commit.message,
                            committed_at_ms: commit.committed_at_ms,
                        }
                    })
                    .collect(),
            },
            Err(error) => CapabilityResult::Unavailable {
                reason: CapabilityReason {
                    code: "git_archive_search_failed".into(),
                    message: error.to_string(),
                },
            },
        }
    }
}

#[cfg(test)]
mod tests;

pub struct UnavailableGitArchive;
pub static UNAVAILABLE: UnavailableGitArchive = UnavailableGitArchive;

impl GitArchiveStore for UnavailableGitArchive {
    fn availability(&self) -> Availability {
        unavailable("git_archive")
    }

    fn ingest(&self, _: &GitIngestRequest) -> CapabilityResult<PublishReceipt> {
        CapabilityResult::unavailable("git_archive")
    }

    fn search(&self, _: &ArchiveQuery) -> CapabilityResult<Vec<GitCommitRecord>> {
        CapabilityResult::unavailable("git_archive")
    }
}
