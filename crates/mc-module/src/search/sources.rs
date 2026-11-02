//! The memory, note, git-commit and primer lanes. Each reads `context.db`
//! the way the TypeScript plugin's lane does and scores the same way.
//!
//! Only the full-text half of each lane runs here yet: query embeddings are
//! not wired, so no lane has a semantic score.

use std::collections::BTreeSet;

use rusqlite::{params, Connection};

use super::messages::{DateRange, Query};
use super::text::{preview, relaxed_fts_query, sanitize_fts_query};

/// A lane's score when only one of its full-text and semantic halves matched.
const SINGLE_SOURCE_PENALTY: f64 = 0.8;
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

/// Memories ranked by full-text match. `visible` memories (the head shows
/// their current text) are left out and returned separately, so the reply
/// can say the search found them.
pub fn search_memories(
    conn: &Connection,
    project: &str,
    query: &str,
    limit: usize,
    visible: &BTreeSet<i64>,
    dates: Option<DateRange>,
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
    let mut hits = Vec::new();
    let mut suppressed = Vec::new();
    for (rank, id) in ids.iter().enumerate() {
        let Some(memory) = memories.iter().find(|memory| memory.id == *id) else {
            continue;
        };
        if visible.contains(id) {
            suppressed.push(*id);
            continue;
        }
        hits.push(MemoryHit {
            id: memory.id,
            category: memory.category.clone(),
            content: preview(&memory.content),
            score: SINGLE_SOURCE_PENALTY / (rank as f64 + 1.0),
            match_type: "fts",
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
    pub short_sha: String,
    pub committed_at: i64,
    pub content: String,
    pub score: f64,
}

/// Commits ranked by full-text match, or, when none matches, by the query
/// as a literal substring, newest first.
pub fn search_commits(
    conn: &Connection,
    project: &str,
    query: &str,
    limit: usize,
    dates: Option<DateRange>,
) -> Vec<CommitHit> {
    let trimmed = query.trim();
    if trimmed.is_empty() || limit == 0 {
        return Vec::new();
    }
    let fetch = (limit * 3).max(30) as i64;
    let (from, to) = dates.map_or((i64::MIN, i64::MAX), |dates| (dates.from, dates.to));
    let read = |sql: &str, needle: &str| -> Vec<(String, String, i64)> {
        let run = || -> rusqlite::Result<Vec<(String, String, i64)>> {
            let mut statement = conn.prepare_cached(sql)?;
            let rows = statement.query_map(params![project, from, to, needle, fetch], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
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
            "SELECT c.short_sha, c.message, c.committed_at FROM git_commits_fts
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
            "SELECT short_sha, message, committed_at FROM git_commits
              WHERE project_path = ?1 AND committed_at BETWEEN ?2 AND ?3
                AND lower(message) LIKE '%' || lower(?4) || '%' ESCAPE '\\'
              ORDER BY committed_at DESC LIMIT ?5",
            &escaped,
        );
    }
    let mut hits: Vec<CommitHit> = rows
        .into_iter()
        .enumerate()
        .map(|(rank, (short_sha, message, committed_at))| CommitHit {
            short_sha,
            committed_at,
            content: preview(&message),
            score: SINGLE_SOURCE_PENALTY / (rank as f64 + 1.0),
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
}

/// Active primers ranked by full-text match over question and answer.
pub fn search_primers(
    conn: &Connection,
    project: &str,
    query: &str,
    limit: usize,
    dates: Option<DateRange>,
) -> Vec<PrimerHit> {
    let fts = sanitize_fts_query(query);
    if fts.is_empty() || limit == 0 {
        return Vec::new();
    }
    let (from, to) = dates.map_or((i64::MIN, i64::MAX), |dates| (dates.from, dates.to));
    let read = || -> rusqlite::Result<Vec<(i64, String, String, i64)>> {
        let mut statement = conn.prepare_cached(
            "SELECT p.id, p.question, p.answer, p.total_support FROM primers_fts
               JOIN primers p ON p.id = primers_fts.rowid
              WHERE primers_fts MATCH ?1 AND p.project_path = ?2 AND p.status = 'active'
                AND p.created_at BETWEEN ?3 AND ?4
              ORDER BY bm25(primers_fts) ASC LIMIT ?5",
        )?;
        let rows = statement
            .query_map(params![fts, project, from, to, (limit * 3) as i64], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })?;
        rows.collect()
    };
    let rows = read().unwrap_or_default();
    let total = rows.len();
    let mut hits: Vec<PrimerHit> = rows
        .into_iter()
        .enumerate()
        .map(|(rank, (id, question, answer, support))| {
            let answer = answer.trim();
            let text = if answer.is_empty() {
                format!("Q: {question}")
            } else {
                format!("Q: {question}\nA: {answer}")
            };
            PrimerHit {
                id,
                support,
                content: preview(&text),
                score: linear_decay(rank, total),
            }
        })
        .collect();
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
