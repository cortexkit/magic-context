//! SQLite source and FTS schema used by the TypeScript git-commit producer.

use rusqlite::Connection;

use rusqlite::{params, Row};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// The complete stored metadata returned by the TypeScript commit search.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredGitCommit {
    pub sha: String,
    pub short_sha: String,
    pub project_path: String,
    pub message: String,
    pub author: Option<String>,
    pub committed_at_ms: i64,
    pub indexed_at_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MatchType {
    Fts,
    Semantic,
    Hybrid,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitSearchHit {
    pub commit: StoredGitCommit,
    pub score: f64,
    pub match_type: MatchType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchOptions {
    pub limit: u32,
    pub semantic_weight: f64,
    pub fts_weight: f64,
    pub single_source_penalty: f64,
    pub query_embedding: Option<Vec<f32>>,
    pub query_model_id: Option<String>,
    pub from: Option<i64>,
    pub to: Option<i64>,
}

impl Default for SearchOptions {
    fn default() -> Self {
        Self {
            limit: 10,
            semantic_weight: 0.7,
            fts_weight: 0.3,
            single_source_penalty: 0.8,
            query_embedding: None,
            query_model_id: None,
            from: None,
            to: None,
        }
    }
}

/// Separate lexical and vector rankings, each capped at 25 hits before fusion.
/// These are the rankings exposed by the TypeScript `captureLanes` callback.
#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SearchResults {
    pub hits: Vec<GitCommitSearchHit>,
    pub fts: Vec<GitCommitSearchHit>,
    pub vector: Vec<GitCommitSearchHit>,
}

fn js_space(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
        | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

/// Quote whitespace-delimited tokens, not FTS operators or user-supplied phrases.
/// NUL must be a separator: SQLite rejects it even inside a quoted FTS string.
pub fn sanitize_fts_query(query: &str) -> String {
    query
        .split(|c| c == '\0' || js_space(c))
        .filter(|token| !token.is_empty())
        .map(|token| format!("\"{}\"", token.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" ")
}

fn escape_like(query: &str) -> String {
    query
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn row_to_commit(row: &Row<'_>) -> rusqlite::Result<StoredGitCommit> {
    Ok(StoredGitCommit {
        sha: row.get(0)?,
        project_path: row.get(1)?,
        short_sha: row.get(2)?,
        message: row.get(3)?,
        author: row.get(4)?,
        committed_at_ms: row.get(5)?,
        indexed_at_ms: row.get(6)?,
    })
}

fn cosine(a: &[f32], b: &[f32]) -> f64 {
    if a.len() != b.len() {
        return 0.0;
    }
    // JavaScript widens each Float32Array element before doing arithmetic.
    let (mut dot, mut norm_a, mut norm_b) = (0.0, 0.0, 0.0);
    for (a, b) in a.iter().zip(b) {
        let (a, b) = (f64::from(*a), f64::from(*b));
        dot += a * b;
        norm_a += a * a;
        norm_b += b * b;
    }
    let denominator = norm_a.sqrt() * norm_b.sqrt();
    let similarity = if denominator == 0.0 {
        0.0
    } else {
        dot / denominator
    };
    if similarity.is_finite() {
        similarity.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

fn rank(hits: &mut [GitCommitSearchHit]) {
    // Stable sorting preserves SQLite/Map order when scores and dates both tie.
    hits.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.commit.committed_at_ms.cmp(&a.commit.committed_at_ms))
    });
}

/// Read-only BM25/LIKE retrieval with reciprocal lexical ranks, optional cosine
/// scores, and weighted fusion, matching `searchGitCommitsSync` at 282d9c08bce4.
pub fn search(
    db: &Connection,
    project: &str,
    query: &str,
    options: &SearchOptions,
) -> rusqlite::Result<Vec<GitCommitSearchHit>> {
    Ok(search_with_lanes(db, project, query, options)?.hits)
}

pub fn search_with_lanes(
    db: &Connection,
    project: &str,
    query: &str,
    options: &SearchOptions,
) -> rusqlite::Result<SearchResults> {
    let trimmed = query.trim_matches(js_space);
    if trimmed.is_empty() || options.limit == 0 {
        return Ok(SearchResults::default());
    }
    let fetch_limit = (i64::from(options.limit) * 3).max(30);
    let dated = options.from.is_some() || options.to.is_some();
    let from = options.from.unwrap_or(-9_007_199_254_740_991);
    let to = options.to.unwrap_or(9_007_199_254_740_991);
    let date_sql = if dated {
        " AND c.committed_at BETWEEN ?3 AND ?4"
    } else {
        ""
    };
    let sanitized = sanitize_fts_query(trimmed);
    let mut candidates = Vec::new();
    if !sanitized.is_empty() {
        // Invalid MATCH syntax or missing FTS support must still allow literal
        // substring retrieval through LIKE, just as an empty FTS result does.
        let fts = (|| -> rusqlite::Result<Vec<StoredGitCommit>> {
            let mut stmt = db.prepare(&format!(
                "SELECT c.sha, c.project_path, c.short_sha, c.message, c.author, c.committed_at, c.indexed_at
                 FROM git_commits_fts INNER JOIN git_commits c ON c.sha = git_commits_fts.sha
                 WHERE c.project_path = ?1{date_sql} AND git_commits_fts MATCH ?2
                 ORDER BY bm25(git_commits_fts) LIMIT ?5"
            ))?;
            let rows = stmt.query_map(
                params![project, sanitized, from, to, fetch_limit],
                row_to_commit,
            )?;
            rows.collect()
        })();
        if let Ok(rows) = fts {
            candidates = rows;
        }
    }
    if candidates.is_empty() {
        let mut stmt = db.prepare(&format!(
            "SELECT c.sha, c.project_path, c.short_sha, c.message, c.author, c.committed_at, c.indexed_at
             FROM git_commits c WHERE c.project_path = ?1{date_sql}
             AND lower(c.message) LIKE '%' || lower(?2) || '%' ESCAPE '\\'
             ORDER BY c.committed_at DESC LIMIT ?5"
        ))?;
        candidates = stmt
            .query_map(
                params![project, escape_like(trimmed), from, to, fetch_limit],
                row_to_commit,
            )?
            .collect::<rusqlite::Result<_>>()?;
    }
    let fts_scores: HashMap<_, _> = candidates
        .iter()
        .enumerate()
        .map(|(rank, commit)| (commit.sha.clone(), 1.0 / (rank + 1) as f64))
        .collect();
    let mut semantic_scores = HashMap::new();
    if let (Some(query), Some(model)) = (&options.query_embedding, &options.query_model_id) {
        if !model.is_empty() && model != "off" {
            let mut stmt = db.prepare(
                "SELECT e.sha, e.embedding FROM git_commit_embeddings e
                 JOIN git_commits c ON c.sha = e.sha WHERE c.project_path = ?1 AND e.model_id = ?2",
            )?;
            let rows = stmt.query_map(params![project, model], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
            })?;
            for row in rows {
                let (sha, bytes) = row?;
                if bytes.len() % 4 != 0 {
                    return Err(rusqlite::Error::FromSqlConversionFailure(
                        1,
                        rusqlite::types::Type::Blob,
                        "commit embedding length must be a multiple of four".into(),
                    ));
                }
                let vector: Vec<f32> = bytes
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .map(|chunk| f32::from_le_bytes(*chunk))
                    .collect();
                let similarity = cosine(query, &vector);
                if similarity > 0.0 {
                    semantic_scores.insert(sha, similarity);
                }
            }
        }
    }
    let semantic_only: Vec<_> = semantic_scores
        .keys()
        .filter(|sha| !fts_scores.contains_key(*sha))
        .collect();
    if !semantic_only.is_empty() {
        let mut stmt = db.prepare(&format!(
            "SELECT c.sha, c.project_path, c.short_sha, c.message, c.author, c.committed_at, c.indexed_at
             FROM git_commits c WHERE c.project_path = ?1{date_sql}
             AND c.sha IN (SELECT value FROM json_each(?2))"
        ))?;
        let shas = serde_json::to_string(&semantic_only).expect("string array");
        // ?3/?4 exist only in the dated statement, unlike the lexical LIMIT ?5.
        let mut rows = if dated {
            stmt.query(params![project, shas, from, to])?
        } else {
            stmt.query(params![project, shas])?
        };
        while let Some(row) = rows.next()? {
            candidates.push(row_to_commit(row)?);
        }
    }
    let mut result = SearchResults::default();
    for commit in candidates {
        let fts = fts_scores.get(&commit.sha);
        let sem = semantic_scores.get(&commit.sha);
        if let Some(fts) = fts {
            result.fts.push(GitCommitSearchHit {
                commit: commit.clone(),
                score: fts * options.single_source_penalty,
                match_type: MatchType::Fts,
            });
        }
        if let Some(sem) = sem {
            result.vector.push(GitCommitSearchHit {
                commit: commit.clone(),
                score: *sem,
                match_type: MatchType::Semantic,
            });
        }
        let (score, match_type) = match (sem, fts) {
            (Some(sem), Some(fts)) => (
                options.semantic_weight * sem + options.fts_weight * fts,
                MatchType::Hybrid,
            ),
            (Some(sem), None) => (sem * options.single_source_penalty, MatchType::Semantic),
            (None, Some(fts)) => (fts * options.single_source_penalty, MatchType::Fts),
            (None, None) => continue,
        };
        if score <= 0.0 {
            continue;
        }
        result.hits.push(GitCommitSearchHit {
            commit,
            score,
            match_type,
        });
    }
    rank(&mut result.hits);
    result.hits.truncate(options.limit as usize);
    for lane in [&mut result.fts, &mut result.vector] {
        rank(lane);
        lane.truncate(25);
    }
    Ok(result)
}

/// Install the git archive tables and write-through FTS triggers on an owned connection.
/// Existing context databases already have these objects; installation is idempotent.
pub fn initialize_schema(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS git_commits (
            sha TEXT PRIMARY KEY,
            project_path TEXT NOT NULL,
            short_sha TEXT NOT NULL,
            message TEXT NOT NULL,
            author TEXT,
            committed_at INTEGER NOT NULL,
            indexed_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_git_commits_project_time
            ON git_commits(project_path, committed_at DESC);
        CREATE TABLE IF NOT EXISTS git_commit_embeddings (
            sha TEXT PRIMARY KEY,
            embedding BLOB NOT NULL,
            model_id TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            FOREIGN KEY(sha) REFERENCES git_commits(sha) ON DELETE CASCADE
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS git_commits_fts USING fts5(
            sha UNINDEXED,
            project_path UNINDEXED,
            message,
            tokenize = 'porter unicode61'
        );
        CREATE TRIGGER IF NOT EXISTS git_commits_fts_insert
        AFTER INSERT ON git_commits BEGIN
            DELETE FROM git_commits_fts WHERE sha = NEW.sha;
            INSERT INTO git_commits_fts(sha, project_path, message)
            VALUES (NEW.sha, NEW.project_path, NEW.message);
        END;
        CREATE TRIGGER IF NOT EXISTS git_commits_fts_delete
        AFTER DELETE ON git_commits BEGIN
            DELETE FROM git_commits_fts WHERE sha = OLD.sha;
        END;
        CREATE TRIGGER IF NOT EXISTS git_commits_fts_update
        AFTER UPDATE OF message, project_path ON git_commits BEGIN
            DELETE FROM git_commits_fts WHERE sha = OLD.sha;
            INSERT INTO git_commits_fts(sha, project_path, message)
            VALUES (NEW.sha, NEW.project_path, NEW.message);
        END;",
    )
}
