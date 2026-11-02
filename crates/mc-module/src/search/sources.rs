//! The memory, note, git-commit and primer lanes. Each reads `context.db`
//! the way the TypeScript plugin's lane does and scores the same way.
//!
//! Memories, commits and primers each have a full-text half and, when the
//! query was embedded, a semantic half over the vectors stored for the same
//! provider. A hit found by both halves scores 0.7 × meaning + 0.3 ×
//! full-text rank; a hit found by one scores that half alone, discounted.
//! Notes match by words only.

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{params, Connection};

use super::messages::{DateRange, Query};
use super::text::{preview, relaxed_fts_query, sanitize_fts_query};
use crate::embedding;

/// A lane's score when only one of its full-text and semantic halves matched.
const SINGLE_SOURCE_PENALTY: f64 = 0.8;
const SEMANTIC_WEIGHT: f64 = 0.7;
const FTS_WEIGHT: f64 = 0.3;

/// The query's embedding, and the model ids stored vectors must carry to be
/// compared with it: one for memories, commits and primers, one for history
/// chunks, whose id also names how history was cut into chunks.
#[derive(Clone, Copy)]
pub struct Semantic<'a> {
    pub vector: &'a [f32],
    pub model_id: &'a str,
    pub chunk_model_id: &'a str,
}

/// How many hits each half keeps for reranking (`RERANK_LANE_LIMIT`).
pub const HALF_LIMIT: usize = 25;

/// A source's two rankings before they are combined: by words alone and by
/// meaning alone, best first, at most [`HALF_LIMIT`] each. An explicit
/// search that reranks fuses these instead of the combined scores, as the
/// plugin's rerank lanes do.
#[derive(Debug)]
pub struct Halves<T> {
    pub words: Vec<T>,
    pub meaning: Vec<T>,
}

impl<T> Default for Halves<T> {
    fn default() -> Self {
        Self {
            words: Vec::new(),
            meaning: Vec::new(),
        }
    }
}

/// Best score first, ties by `tie`; then cut to [`HALF_LIMIT`].
fn rank_half<T>(
    mut hits: Vec<T>,
    score: impl Fn(&T) -> f64,
    tie: impl Fn(&T, &T) -> std::cmp::Ordering,
) -> Vec<T> {
    hits.sort_by(|left, right| {
        score(right)
            .partial_cmp(&score(left))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| tie(left, right))
    });
    hits.truncate(HALF_LIMIT);
    hits
}

/// One hit's score from its two halves, and which halves matched.
fn hybrid(semantic: Option<f64>, fts: Option<f64>) -> Option<(f64, &'static str)> {
    let (score, kind) = match (semantic, fts) {
        (Some(semantic), Some(fts)) => (SEMANTIC_WEIGHT * semantic + FTS_WEIGHT * fts, "hybrid"),
        (Some(semantic), None) => (semantic * SINGLE_SOURCE_PENALTY, "semantic"),
        (None, Some(fts)) => (fts * SINGLE_SOURCE_PENALTY, "fts"),
        (None, None) => return None,
    };
    (score > 0.0).then_some((score, kind))
}

/// Stored vectors for `model_id`, keyed by the row they belong to.
fn vectors<K: Ord + rusqlite::types::FromSql>(
    conn: &Connection,
    sql: &str,
    project: &str,
    model_id: &str,
) -> BTreeMap<K, Vec<f32>> {
    let read = || -> rusqlite::Result<BTreeMap<K, Vec<f32>>> {
        let mut statement = conn.prepare_cached(sql)?;
        let rows = statement.query_map(params![project, model_id], |row| {
            Ok((row.get::<_, K>(0)?, row.get::<_, Vec<u8>>(1)?))
        })?;
        let mut found = BTreeMap::new();
        for row in rows {
            let (key, blob) = row?;
            if let Some(vector) = embedding::decode(&blob) {
                found.insert(key, vector);
            }
        }
        Ok(found)
    };
    read().unwrap_or_default()
}
/// Memory full-text candidates read before ranking.
const MEMORY_FTS_CANDIDATES: usize = 50;
const MAX_NOTE_KEYWORD_SCORE: f64 = 3.5;
const RRF_IDF_FALLOFF: f64 = 100.0;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}

fn linear_decay(rank: usize, total: usize) -> f64 {
    if total == 0 {
        return 0.0;
    }
    (1.0 - rank as f64 / total as f64).max(0.0)
}

#[derive(Clone, Debug, PartialEq)]
pub struct MemoryHit {
    pub id: i64,
    pub category: String,
    pub content: String,
    pub score: f64,
    pub match_type: &'static str,
}

#[derive(Clone, Debug)]
pub struct SearchMemory {
    pub id: i64,
    pub category: String,
    pub content: String,
    pub created_at: i64,
}

/// The project's current memories: active or permanent, not expired.
pub fn project_memories(conn: &Connection, project: &str) -> rusqlite::Result<Vec<SearchMemory>> {
    let mut statement = conn.prepare_cached(
        "SELECT id, category, content, created_at FROM memories
          WHERE project_path = ?1 AND status IN ('active', 'permanent')
            AND (expires_at IS NULL OR expires_at > ?2)",
    )?;
    let rows = statement.query_map(params![project, now_ms()], |row| {
        Ok(SearchMemory {
            id: row.get(0)?,
            category: row.get(1)?,
            content: row.get(2)?,
            created_at: row.get(3)?,
        })
    })?;
    rows.collect()
}

fn memory_fts_ids(
    conn: &Connection,
    project: &str,
    fts: &str,
    dates: Option<DateRange>,
) -> Vec<i64> {
    if fts.is_empty() {
        return Vec::new();
    }
    let (from, to) = dates.map_or((i64::MIN, i64::MAX), |dates| (dates.from, dates.to));
    let read = || -> rusqlite::Result<Vec<i64>> {
        let mut statement = conn.prepare_cached(
            "SELECT memories.id FROM memories_fts INNER JOIN memories ON memories.id = memories_fts.rowid
              WHERE memories.project_path = ?1 AND memories.status IN ('active', 'permanent')
                AND (memories.expires_at IS NULL OR memories.expires_at > ?2)
                AND memories.created_at BETWEEN ?3 AND ?4 AND memories_fts MATCH ?5
              ORDER BY bm25(memories_fts), memories.updated_at DESC, memories.id ASC LIMIT ?6",
        )?;
        let rows = statement.query_map(
            params![
                project,
                now_ms(),
                from,
                to,
                fts,
                MEMORY_FTS_CANDIDATES as i64
            ],
            |row| row.get(0),
        )?;
        rows.collect()
    };
    read().unwrap_or_default()
}

/// Memories ranked by full-text match and meaning. `visible` memories (the
/// head shows their current text) are left out and returned separately, so
/// the reply can say the search found them.
///
/// Vectors are read as stored: a memory without one for this provider is
/// found by words only until the embedding drain gives it one.
#[allow(clippy::too_many_arguments)]
pub fn search_memories(
    conn: &Connection,
    project: &str,
    query: &str,
    limit: usize,
    visible: &BTreeSet<i64>,
    dates: Option<DateRange>,
    semantic: Option<Semantic<'_>>,
    halves: Option<&mut Halves<MemoryHit>>,
) -> (Vec<MemoryHit>, Vec<i64>) {
    let memories: Vec<SearchMemory> = project_memories(conn, project)
        .unwrap_or_default()
        .into_iter()
        .filter(|memory| dates.is_none_or(|dates| dates.contains(memory.created_at)))
        .collect();
    if memories.is_empty() {
        return (Vec::new(), Vec::new());
    }
    let trimmed = query.trim();
    let mut ids = memory_fts_ids(conn, project, &sanitize_fts_query(trimmed), dates);
    if ids.is_empty() {
        ids = memory_fts_ids(conn, project, &relaxed_fts_query(trimmed), dates);
    }
    let fts: BTreeMap<i64, f64> = ids
        .iter()
        .enumerate()
        .map(|(rank, id)| (*id, 1.0 / (rank as f64 + 1.0)))
        .collect();
    let mut meaning: BTreeMap<i64, f64> = BTreeMap::new();
    if let Some(semantic) = semantic {
        let stored: BTreeMap<i64, Vec<f32>> = vectors(
            conn,
            "SELECT e.memory_id, e.embedding FROM memory_embeddings e
               JOIN memories m ON m.id = e.memory_id
              WHERE m.project_path = ?1 AND e.model_id = ?2",
            project,
            semantic.model_id,
        );
        for memory in &memories {
            if let Some(vector) = stored.get(&memory.id) {
                meaning.insert(memory.id, embedding::similarity(semantic.vector, vector));
            }
        }
    }
    if let Some(halves) = halves {
        let half = |scores: &BTreeMap<i64, f64>, factor: f64, match_type: &'static str| {
            let hits = memories
                .iter()
                .filter(|memory| !visible.contains(&memory.id))
                .filter_map(|memory| {
                    let score = scores.get(&memory.id)? * factor;
                    (score > 0.0).then(|| MemoryHit {
                        id: memory.id,
                        category: memory.category.clone(),
                        content: preview(&memory.content),
                        score,
                        match_type,
                    })
                })
                .collect();
            rank_half(hits, |hit| hit.score, |left, right| left.id.cmp(&right.id))
        };
        // Words alone carry the single-source penalty; meaning alone does not,
        // as in the plugin's lanes.
        halves.words = half(&fts, SINGLE_SOURCE_PENALTY, "fts");
        halves.meaning = half(&meaning, 1.0, "semantic");
    }
    let mut hits = Vec::new();
    let mut suppressed = Vec::new();
    for memory in &memories {
        let Some((score, match_type)) = hybrid(
            meaning.get(&memory.id).copied(),
            fts.get(&memory.id).copied(),
        ) else {
            continue;
        };
        if visible.contains(&memory.id) {
            suppressed.push(memory.id);
            continue;
        }
        hits.push(MemoryHit {
            id: memory.id,
            category: memory.category.clone(),
            content: preview(&memory.content),
            score,
            match_type,
        });
    }
    hits.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(left.id.cmp(&right.id))
    });
    hits.truncate(limit);
    suppressed.sort_unstable();
    (hits, suppressed)
}

#[derive(Clone, Debug, PartialEq)]
pub struct NoteHit {
    pub id: i64,
    pub status: String,
    pub created_at: i64,
    pub anchor_ordinal: Option<i64>,
    pub session_id: Option<String>,
    pub content: String,
    pub score: f64,
}

#[derive(Clone, Debug)]
struct Note {
    id: i64,
    status: String,
    created_at: i64,
    anchor_ordinal: Option<i64>,
    session_id: Option<String>,
    text: String,
}

fn searchable_notes(
    conn: &Connection,
    harness: &str,
    session: &str,
    project: &str,
) -> rusqlite::Result<Vec<Note>> {
    let mut statement = conn.prepare_cached(
        "SELECT id, status, created_at, anchor_ordinal, session_id, content, ready_reason FROM notes
          WHERE status IN ('active', 'pending', 'ready')
            AND ((type = 'session' AND session_id = ?1 AND harness = ?2)
              OR (type = 'smart' AND project_path = ?3))
          ORDER BY id",
    )?;
    let rows = statement.query_map(params![session, harness, project], |row| {
        let content: String = row.get(5)?;
        let reason: Option<String> = row.get(6)?;
        let text = match reason
            .as_deref()
            .map(str::trim)
            .filter(|reason| !reason.is_empty())
        {
            Some(reason) => format!("{content}\nReason: {reason}"),
            None => content,
        };
        Ok(Note {
            id: row.get(0)?,
            status: row.get(1)?,
            created_at: row.get(2)?,
            anchor_ordinal: row.get(3)?,
            session_id: row.get(4)?,
            text,
        })
    })?;
    rows.collect()
}

/// Lowercase words of letters, digits and `/._:-`, at least two characters
/// with a letter or digit, in first-seen order.
fn keyword_tokens(text: &str) -> Vec<String> {
    static WORD: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let word = WORD.get_or_init(|| regex::Regex::new(r"[a-z0-9/._:-]+").expect("valid regex"));
    let lowered = text.to_lowercase();
    let mut seen = BTreeSet::new();
    word.find_iter(&lowered)
        .map(|found| found.as_str())
        .filter(|token| token.len() > 1 && token.bytes().any(|byte| byte.is_ascii_alphanumeric()))
        .filter(|token| seen.insert(token.to_string()))
        .map(str::to_owned)
        .collect()
}

/// Notes that hold `needle` or its words, best first.
fn rank_notes<'a>(notes: &'a [Note], needle: &str) -> Vec<(&'a Note, f64)> {
    let needle = needle.trim().to_lowercase();
    if needle.is_empty() {
        return Vec::new();
    }
    let needle_tokens = keyword_tokens(&needle);
    let mut ranked = Vec::new();
    for note in notes {
        let text = note.text.to_lowercase();
        let note_tokens: BTreeSet<String> = keyword_tokens(&text).into_iter().collect();
        let exact = text.contains(&needle);
        let matched = needle_tokens
            .iter()
            .filter(|token| note_tokens.contains(*token))
            .count();
        if !exact && matched == 0 {
            continue;
        }
        let coverage = if needle_tokens.is_empty() {
            0.0
        } else {
            matched as f64 / needle_tokens.len() as f64
        };
        let density = if note_tokens.is_empty() {
            0.0
        } else {
            matched as f64 / note_tokens.len() as f64
        };
        let exact_phrase = exact && (needle_tokens.len() > 1 || text.trim() == needle);
        let all_tokens = needle_tokens.len() > 1 && matched == needle_tokens.len();
        let score = if exact_phrase { 2.0 } else { 0.0 }
            + coverage * density
            + if all_tokens { 0.5 * density } else { 0.0 };
        ranked.push((note, score));
    }
    ranked.sort_by(|(left, left_score), (right, right_score)| {
        right_score
            .partial_cmp(left_score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(right.created_at.cmp(&left.created_at))
            .then(left.id.cmp(&right.id))
    });
    ranked
}

fn note_score(score: f64) -> f64 {
    (score / MAX_NOTE_KEYWORD_SCORE).clamp(0.0, 1.0) * SINGLE_SOURCE_PENALTY
}

/// This session's notes and the project's smart notes that match the query
/// or one of its probes.
pub fn search_notes(
    conn: &Connection,
    harness: &str,
    session: &str,
    project: &str,
    wanted: &Query,
) -> Vec<NoteHit> {
    let Query {
        text: query,
        limit,
        probes,
        dates,
    } = *wanted;
    let notes: Vec<Note> = searchable_notes(conn, harness, session, project)
        .unwrap_or_default()
        .into_iter()
        .filter(|note| dates.is_none_or(|dates| dates.contains(note.created_at)))
        .collect();
    if notes.is_empty() || limit == 0 {
        return Vec::new();
    }
    let mut lists = Vec::new();
    let base = rank_notes(&notes, query);
    if !base.is_empty() {
        lists.push((base, 1.0));
    }
    for probe in probes {
        let rows = rank_notes(&notes, probe);
        if rows.is_empty() {
            continue;
        }
        let weight = 1.0 / (1.0 + RRF_IDF_FALLOFF * rows.len() as f64 / notes.len() as f64);
        lists.push((rows, weight));
    }
    let mut fused: Vec<(&Note, f64)> = Vec::new();
    for (rows, weight) in &lists {
        for (note, score) in rows {
            let relevance = score * weight;
            match fused
                .iter_mut()
                .find(|(existing, _)| existing.id == note.id)
            {
                Some((_, best)) if relevance > *best => *best = relevance,
                Some(_) => {}
                None => fused.push((note, relevance)),
            }
        }
    }
    fused.sort_by(|(left, left_score), (right, right_score)| {
        right_score
            .partial_cmp(left_score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(right.created_at.cmp(&left.created_at))
            .then(left.id.cmp(&right.id))
    });
    fused
        .into_iter()
        .take(limit)
        .map(|(note, score)| NoteHit {
            id: note.id,
            status: note.status.clone(),
            created_at: note.created_at,
            anchor_ordinal: note.anchor_ordinal,
            session_id: note.session_id.clone(),
            content: preview(&note.text),
            score: note_score(score),
        })
        .collect()
}

#[derive(Clone, Debug, PartialEq)]
pub struct CommitHit {
    pub sha: String,
    pub short_sha: String,
    pub committed_at: i64,
    pub content: String,
    pub score: f64,
    pub match_type: &'static str,
}

/// Commits ranked by full-text match (or, when none matches, by the query as
/// a literal substring) and by meaning.
pub fn search_commits(
    conn: &Connection,
    project: &str,
    query: &str,
    limit: usize,
    dates: Option<DateRange>,
    semantic: Option<Semantic<'_>>,
    halves: Option<&mut Halves<CommitHit>>,
) -> Vec<CommitHit> {
    let trimmed = query.trim();
    if trimmed.is_empty() || limit == 0 {
        return Vec::new();
    }
    let fetch = (limit * 3).max(30) as i64;
    let (from, to) = dates.map_or((i64::MIN, i64::MAX), |dates| (dates.from, dates.to));
    type Row = (String, String, String, i64);
    let read = |sql: &str, needle: &str| -> Vec<Row> {
        let run = || -> rusqlite::Result<Vec<Row>> {
            let mut statement = conn.prepare_cached(sql)?;
            let rows = statement.query_map(params![project, from, to, needle, fetch], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })?;
            rows.collect()
        };
        run().unwrap_or_default()
    };
    let fts = sanitize_fts_query(trimmed);
    let mut rows = if fts.is_empty() {
        Vec::new()
    } else {
        read(
            "SELECT c.sha, c.short_sha, c.message, c.committed_at FROM git_commits_fts
              INNER JOIN git_commits c ON c.sha = git_commits_fts.sha
              WHERE c.project_path = ?1 AND c.committed_at BETWEEN ?2 AND ?3 AND git_commits_fts MATCH ?4
              ORDER BY bm25(git_commits_fts) LIMIT ?5",
            &fts,
        )
    };
    if rows.is_empty() {
        let escaped: String = trimmed
            .chars()
            .flat_map(|ch| match ch {
                '\\' | '%' | '_' => vec!['\\', ch],
                _ => vec![ch],
            })
            .collect();
        rows = read(
            "SELECT sha, short_sha, message, committed_at FROM git_commits
              WHERE project_path = ?1 AND committed_at BETWEEN ?2 AND ?3
                AND lower(message) LIKE '%' || lower(?4) || '%' ESCAPE '\\'
              ORDER BY committed_at DESC LIMIT ?5",
            &escaped,
        );
    }
    let fts_scores: BTreeMap<String, f64> = rows
        .iter()
        .enumerate()
        .map(|(rank, row)| (row.0.clone(), 1.0 / (rank as f64 + 1.0)))
        .collect();
    let mut commits: BTreeMap<String, (String, String, i64)> = rows
        .into_iter()
        .map(|(sha, short_sha, message, committed_at)| (sha, (short_sha, message, committed_at)))
        .collect();
    let mut meaning: BTreeMap<String, f64> = BTreeMap::new();
    if let Some(semantic) = semantic {
        let stored: BTreeMap<String, Vec<f32>> = vectors(
            conn,
            "SELECT e.sha, e.embedding FROM git_commit_embeddings e
               JOIN git_commits c ON c.sha = e.sha
              WHERE c.project_path = ?1 AND e.model_id = ?2",
            project,
            semantic.model_id,
        );
        for (sha, vector) in &stored {
            let similarity = embedding::similarity(semantic.vector, vector);
            if similarity > 0.0 {
                meaning.insert(sha.clone(), similarity);
            }
        }
        // Commits found by meaning alone, read in one statement as the plugin
        // does; the date range applies to them too.
        if meaning.keys().any(|sha| !commits.contains_key(sha)) {
            let read_all = || -> rusqlite::Result<Vec<Row>> {
                let mut statement = conn.prepare_cached(
                    "SELECT sha, short_sha, message, committed_at FROM git_commits
                      WHERE project_path = ?1 AND committed_at BETWEEN ?2 AND ?3",
                )?;
                let rows = statement.query_map(params![project, from, to], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })?;
                rows.collect()
            };
            for (sha, short_sha, message, committed_at) in read_all().unwrap_or_default() {
                if meaning.contains_key(&sha) && !commits.contains_key(&sha) {
                    commits.insert(sha, (short_sha, message, committed_at));
                }
            }
        }
    }
    if let Some(halves) = halves {
        let half = |scores: &BTreeMap<String, f64>, factor: f64, match_type: &'static str| {
            let hits = commits
                .iter()
                .filter_map(|(sha, (short_sha, message, committed_at))| {
                    let score = scores.get(sha)? * factor;
                    (score > 0.0).then(|| CommitHit {
                        sha: sha.clone(),
                        short_sha: short_sha.clone(),
                        committed_at: *committed_at,
                        content: preview(message),
                        score,
                        match_type,
                    })
                })
                .collect();
            rank_half(
                hits,
                |hit| hit.score,
                |left, right| right.committed_at.cmp(&left.committed_at),
            )
        };
        halves.words = half(&fts_scores, SINGLE_SOURCE_PENALTY, "fts");
        halves.meaning = half(&meaning, 1.0, "semantic");
    }
    let mut hits: Vec<CommitHit> = commits
        .into_iter()
        .filter_map(|(sha, (short_sha, message, committed_at))| {
            let (score, match_type) =
                hybrid(meaning.get(&sha).copied(), fts_scores.get(&sha).copied())?;
            Some(CommitHit {
                sha,
                short_sha,
                committed_at,
                content: preview(&message),
                score,
                match_type,
            })
        })
        .collect();
    hits.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(right.committed_at.cmp(&left.committed_at))
    });
    hits.truncate(limit);
    hits
}

#[derive(Clone, Debug, PartialEq)]
pub struct PrimerHit {
    pub id: i64,
    pub support: i64,
    pub content: String,
    pub score: f64,
    pub match_type: &'static str,
}

/// Active primers ranked by full-text match over question and answer, and by
/// the meaning of their question. Unlike the other lanes, a primer found by
/// one half alone keeps that half's score undiscounted, as in the plugin.
pub fn search_primers(
    conn: &Connection,
    project: &str,
    query: &str,
    limit: usize,
    dates: Option<DateRange>,
    semantic: Option<Semantic<'_>>,
    mut halves: Option<&mut Halves<PrimerHit>>,
) -> Vec<PrimerHit> {
    if limit == 0 {
        return Vec::new();
    }
    let (from, to) = dates.map_or((i64::MIN, i64::MAX), |dates| (dates.from, dates.to));
    type Row = (i64, String, String, i64, Option<Vec<u8>>, Option<String>);
    let read_primers = || -> rusqlite::Result<Vec<Row>> {
        let mut statement = conn.prepare_cached(
            "SELECT id, question, answer, total_support, question_embedding, question_embedding_model_id
               FROM primers WHERE project_path = ?1 AND status = 'active'
                AND created_at BETWEEN ?2 AND ?3",
        )?;
        let rows = statement.query_map(params![project, from, to], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
            ))
        })?;
        rows.collect()
    };
    let primers = read_primers().unwrap_or_default();
    if primers.is_empty() {
        return Vec::new();
    }
    let fts = sanitize_fts_query(query);
    let mut fts_scores: BTreeMap<i64, f64> = BTreeMap::new();
    // The words half lists more candidates than the combined score uses, as
    // the plugin's lane does.
    let mut words_ranked: Vec<i64> = Vec::new();
    if !fts.is_empty() {
        let fetch = if halves.is_some() {
            (limit * 3).max(225)
        } else {
            limit * 3
        };
        let read = || -> rusqlite::Result<Vec<i64>> {
            let mut statement = conn.prepare_cached(
                "SELECT p.id FROM primers_fts
                   JOIN primers p ON p.id = primers_fts.rowid
                  WHERE primers_fts MATCH ?1 AND p.project_path = ?2 AND p.status = 'active'
                    AND p.created_at BETWEEN ?3 AND ?4
                  ORDER BY bm25(primers_fts) ASC LIMIT ?5",
            )?;
            let rows = statement
                .query_map(params![fts, project, from, to, fetch as i64], |row| {
                    row.get(0)
                })?;
            rows.collect()
        };
        words_ranked = read().unwrap_or_default();
        let baseline = &words_ranked[..words_ranked.len().min(limit * 3)];
        for (rank, id) in baseline.iter().enumerate() {
            fts_scores.insert(*id, linear_decay(rank, baseline.len()));
        }
    }
    let text_of = |question: &str, answer: &str| {
        let answer = answer.trim();
        if answer.is_empty() {
            format!("Q: {question}")
        } else {
            format!("Q: {question}\nA: {answer}")
        }
    };
    if let Some(halves) = halves.as_deref_mut() {
        let by_id: BTreeMap<i64, &Row> = primers.iter().map(|row| (row.0, row)).collect();
        halves.words = words_ranked
            .iter()
            .enumerate()
            .filter_map(|(rank, id)| {
                let (id, question, answer, support, ..) = by_id.get(id)?;
                Some(PrimerHit {
                    id: *id,
                    support: *support,
                    content: preview(&text_of(question, answer)),
                    score: linear_decay(rank, words_ranked.len()),
                    match_type: "fts",
                })
            })
            .take(HALF_LIMIT)
            .collect();
    }
    let mut meaning_half: Vec<PrimerHit> = Vec::new();
    let mut hits: Vec<PrimerHit> = primers
        .into_iter()
        .filter_map(|(id, question, answer, support, blob, model_id)| {
            let meaning = match (semantic, blob, model_id) {
                (Some(semantic), Some(blob), Some(model_id)) if model_id == semantic.model_id => {
                    embedding::decode(&blob).map_or(0.0, |vector| {
                        embedding::similarity(semantic.vector, &vector)
                    })
                }
                _ => 0.0,
            };
            let words = fts_scores.get(&id).copied().unwrap_or(0.0);
            if halves.is_some() && meaning > 0.0 {
                meaning_half.push(PrimerHit {
                    id,
                    support,
                    content: preview(&text_of(&question, &answer)),
                    score: meaning,
                    match_type: "semantic",
                });
            }
            if meaning <= 0.0 && words <= 0.0 {
                return None;
            }
            let (score, match_type) = if meaning > 0.0 && words > 0.0 {
                (meaning * SEMANTIC_WEIGHT + words * FTS_WEIGHT, "hybrid")
            } else if meaning > 0.0 {
                (meaning, "semantic")
            } else {
                (words, "fts")
            };
            Some(PrimerHit {
                id,
                support,
                content: preview(&text_of(&question, &answer)),
                score,
                match_type,
            })
        })
        .collect();
    if let Some(halves) = halves {
        halves.meaning = rank_half(
            meaning_half,
            |hit| hit.score,
            |left, right| {
                right
                    .support
                    .cmp(&left.support)
                    .then(left.id.cmp(&right.id))
            },
        );
    }
    hits.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(right.support.cmp(&left.support))
            .then(left.id.cmp(&right.id))
    });
    hits.truncate(limit);
    hits
}

/// A summary whose text matched the query by meaning: the history lane's
/// semantic half. Each summary's chunks are stored as separate vectors; the
/// best-matching chunk speaks for its summary.
#[derive(Clone, Debug, PartialEq)]
pub struct ChunkHit {
    pub compartment_id: i64,
    pub title: String,
    pub start: i64,
    pub end: i64,
    pub score: f64,
    pub match_type: &'static str,
    /// The best message hit inside the summary's range, shown in place of
    /// the title once message and summary results are fused.
    pub snippet: Option<String>,
}

/// The session's summaries ranked by how close their best chunk is to the
/// query, up to `cutoff` (later messages are in the model's view). A date
/// range keeps summaries whose messages overlap it.
pub fn search_chunks(
    conn: &Connection,
    session: &str,
    project: &str,
    limit: usize,
    cutoff: i64,
    dates: Option<DateRange>,
    semantic: Semantic<'_>,
) -> Vec<ChunkHit> {
    if limit == 0 {
        return Vec::new();
    }
    type Row = (i64, String, i64, i64, Option<i64>, Option<i64>, Vec<u8>);
    let read = || -> rusqlite::Result<Vec<Row>> {
        let mut statement = conn.prepare_cached(
            "SELECT e.compartment_id, c.title, c.start_message, c.end_message,
                    start_map.message_time_ms, end_map.message_time_ms, e.vector
               FROM compartment_chunk_embeddings e
               JOIN compartments c ON c.id = e.compartment_id
               LEFT JOIN message_fts_rowid_map start_map
                 ON start_map.session_id = c.session_id AND start_map.message_ordinal = c.start_message
               LEFT JOIN message_fts_rowid_map end_map
                 ON end_map.session_id = c.session_id AND end_map.message_ordinal = c.end_message
              WHERE e.session_id = ?1 AND e.project_path = ?2 AND e.model_id = ?3
              ORDER BY e.id ASC",
        )?;
        let rows =
            statement.query_map(params![session, project, semantic.chunk_model_id], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            })?;
        rows.collect()
    };
    let mut best: BTreeMap<i64, ChunkHit> = BTreeMap::new();
    for (id, title, start, end, start_time, end_time, blob) in read().unwrap_or_default() {
        if end > cutoff {
            continue;
        }
        if let Some(dates) = dates {
            match (start_time, end_time) {
                (Some(start_time), Some(end_time))
                    if start_time <= dates.to && end_time >= dates.from => {}
                _ => continue,
            }
        }
        let Some(vector) = embedding::decode(&blob) else {
            continue;
        };
        let score = embedding::similarity(semantic.vector, &vector);
        if score <= 0.0 {
            continue;
        }
        if best.get(&id).is_none_or(|existing| score > existing.score) {
            best.insert(
                id,
                ChunkHit {
                    compartment_id: id,
                    title,
                    start,
                    end,
                    score,
                    match_type: "semantic",
                    snippet: None,
                },
            );
        }
    }
    let mut hits: Vec<ChunkHit> = best.into_values().collect();
    hits.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(left.start.cmp(&right.start))
    });
    hits.truncate(limit);
    for hit in &mut hits {
        hit.score *= SINGLE_SOURCE_PENALTY;
    }
    hits
}

/// Add one to each memory's retrieval count: a search the agent asked for
/// returned it.
pub fn count_retrievals(conn: &mut Connection, ids: &[i64]) -> rusqlite::Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let now = now_ms();
    for id in ids {
        tx.execute(
            "UPDATE memories SET retrieval_count = retrieval_count + 1, last_retrieved_at = ?2, updated_at = ?2
              WHERE id = ?1",
            params![id, now],
        )?;
    }
    tx.commit()
}
