//! `ctx_search`'s rerank, as the plugin's `search-rerank.ts`. An explicit
//! search whose query reads as prose (a question or a descriptive phrase,
//! not an identifier or an error line) has a reranker score its best
//! candidates and returns them in that order:
//!
//! 1. Each source keeps its separate rankings ([`Lanes`]): memories, primers
//!    and commits by words and by meaning, messages, summaries and notes.
//! 2. The lanes are fused by equal-weight reciprocal rank into at most 20
//!    candidates; a message inside a summary that a lane found votes for that
//!    summary.
//! 3. Each candidate becomes a short document (where it is, a title, then its
//!    body, at most 1 KiB) and the reranker scores them against the query.
//! 4. The candidates are returned best score first, cut to the search's
//!    limit.
//!
//! Any failure keeps the ordinary ranking. The reranker is the local Synapse
//! module by default (`models.list` pins its certified model, `rerank.score`
//! scores), a hosted endpoint when the user configures one, or off.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::future::Future;
use std::sync::Mutex;
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use super::Hit;

/// Synapse's certified reranker model.
pub const MODEL: &str = "gte-reranker-modernbert-base-f32";
/// How many hits of each lane are fused.
pub const LANE_LIMIT: usize = 25;
/// The most candidates one rerank scores.
pub const POOL: usize = 20;
/// How long Synapse may take for each call.
pub const SYNAPSE_DEADLINE: Duration = Duration::from_millis(1500);
/// One candidate document's size, so twenty send at most 20 KiB.
const DOCUMENT_BYTES: usize = 1024;
const RRF_K: f64 = 60.0;

/// Which reranker an explicit search uses (`rerank.*`).
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub enum Reranker {
    Off,
    /// The local Synapse module, over subc.
    #[default]
    Synapse,
    /// A hosted `/rerank` endpoint; user configuration only.
    Remote(Remote),
}

#[derive(Clone, PartialEq, Eq)]
pub struct Remote {
    /// The API base; a `tei+` prefix selects the Hugging Face TEI shape.
    pub endpoint: Option<String>,
    pub model: Option<String>,
    pub api_key: Option<String>,
    /// Clamped to 50..=15000 ms; default 1500.
    pub timeout_ms: u64,
    /// The most candidates sent, 1..=20; default 20.
    pub top_n: usize,
}

impl std::fmt::Debug for Remote {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Remote")
            .field("endpoint", &self.endpoint)
            .field("model", &self.model)
            .finish_non_exhaustive()
    }
}

impl Reranker {
    /// The reranker from the configuration tiers. Only the user picks a
    /// reranker or where text is sent; a project may only switch it off.
    pub fn from_tiers(user: &Value, project: &Value) -> Self {
        if project.pointer("/rerank/provider").and_then(Value::as_str) == Some("off") {
            return Self::Off;
        }
        let rerank = &user["rerank"];
        match rerank["provider"].as_str() {
            Some("off") => Self::Off,
            Some("remote") => Self::Remote(Remote {
                endpoint: text(rerank, "endpoint"),
                model: text(rerank, "model"),
                api_key: rerank["api_key"]
                    .as_str()
                    .filter(|key| !key.is_empty())
                    .map(str::to_owned),
                timeout_ms: rerank["timeout_ms"]
                    .as_f64()
                    .filter(|ms| ms.is_finite() && ms.fract() == 0.0)
                    .map_or(1500, |ms| ms.clamp(50.0, 15_000.0) as u64),
                top_n: crate::config::integer(&rerank["top_n"])
                    .filter(|n| (1..=20).contains(n))
                    .map_or(POOL, |n| n as usize),
            }),
            _ => Self::Synapse,
        }
    }

    /// The pool size this reranker scores.
    pub fn pool(&self) -> usize {
        match self {
            Self::Remote(remote) => remote.top_n,
            _ => POOL,
        }
    }
}

fn text(value: &Value, key: &str) -> Option<String> {
    value[key]
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// `isProseQuery`: questions and descriptive phrases of at least three plain
/// words are reranked; identifiers, symbol lists, quoted strings and error
/// lines keep the ordinary ranking, which suits them better.
pub fn is_prose_query(query: &str) -> bool {
    use std::sync::OnceLock;
    static PATTERNS: OnceLock<[regex::Regex; 6]> = OnceLock::new();
    let [special, error_start, error_line, plain_word, question, symbols] =
        PATTERNS.get_or_init(|| {
            [
                regex::Regex::new(r#"[\n;]|^["'`]|["'`]$"#),
                regex::Regex::new(
                    r"(?i)^(?:error\b|cannot\b|failed\b|panic\b|traceback\b|assertion\b|SQLITE_|TypeError\b|ReferenceError\b|SyntaxError\b)",
                ),
                regex::Regex::new(r"\b(?:[A-Z][A-Z_]+:|\w*(?:Error|Exception):)|\bat\s+\S+\s*\("),
                regex::Regex::new(r"^[a-zA-Z]+(?:['’-][a-zA-Z]+)*$"),
                regex::Regex::new(r"(?i)^(?:how|why|what|where|when|which|who)\b"),
                regex::Regex::new(r"[\\/]|::|="),
            ]
            .map(|pattern| pattern.expect("rerank patterns"))
        });
    let text = query.trim();
    if text.is_empty()
        || special.is_match(text)
        || error_start.is_match(text)
        || error_line.is_match(text)
    {
        return false;
    }
    let stripped = text.strip_suffix(['?', '!', '.']).unwrap_or(text);
    let words: Vec<&str> = stripped.split_whitespace().collect();
    if words.len() < 3 {
        return false;
    }
    let plain = words
        .iter()
        .filter(|word| plain_word.is_match(word))
        .count();
    if question.is_match(text) {
        return plain >= 3;
    }
    words.len() >= 4 && plain >= 3 && !symbols.is_match(text)
}

/// Each source's own ranking, best first, at most [`LANE_LIMIT`] each, in
/// the order the plugin fuses them.
#[derive(Debug, Default)]
pub struct Lanes {
    pub memory_fts: Vec<Hit>,
    pub memory_vector: Vec<Hit>,
    pub primer_fts: Vec<Hit>,
    pub primer_vector: Vec<Hit>,
    pub message_fts: Vec<Hit>,
    pub chunk_vector: Vec<Hit>,
    pub git_fts: Vec<Hit>,
    pub git_vector: Vec<Hit>,
    pub notes: Vec<Hit>,
}

/// A hit's identity across lanes.
pub fn key(hit: &Hit) -> String {
    match hit {
        Hit::Memory(hit) => format!("memory:{}", hit.id),
        Hit::Primer(hit) => format!("primer:{}", hit.id),
        Hit::Message(hit) => format!("message:{}", hit.message_id),
        Hit::Chunk(hit) => format!("compartment:{}", hit.compartment_id),
        Hit::Commit(hit) => format!("git_commit:{}", hit.sha),
        Hit::Note(hit) => format!("note:{}", hit.id),
    }
}

/// `fuseSearchLanes`: equal-weight reciprocal rank over every lane; a
/// message inside a summary the summary lane found counts for that summary.
/// At most [`POOL`] hits, best fused score first, ties in first-seen order.
pub fn fuse(lanes: &Lanes) -> Vec<Hit> {
    let chunks: Vec<&super::sources::ChunkHit> = lanes
        .chunk_vector
        .iter()
        .filter_map(|hit| match hit {
            Hit::Chunk(chunk) => Some(chunk),
            _ => None,
        })
        .collect();
    let ordered: [(&str, &Vec<Hit>); 9] = [
        ("memory_fts", &lanes.memory_fts),
        ("memory_vector", &lanes.memory_vector),
        ("primer_fts", &lanes.primer_fts),
        ("primer_vector", &lanes.primer_vector),
        ("message_fts", &lanes.message_fts),
        ("chunk_vector", &lanes.chunk_vector),
        ("git_fts", &lanes.git_fts),
        ("git_vector", &lanes.git_vector),
        ("notes", &lanes.notes),
    ];
    let mut fused: Vec<(String, Hit, f64)> = Vec::new();
    let mut at: HashMap<String, usize> = HashMap::new();
    for (name, lane) in ordered {
        let mut seen = BTreeSet::new();
        for (index, original) in lane.iter().take(LANE_LIMIT).enumerate() {
            let hit = match original {
                Hit::Message(message) if name == "message_fts" => chunks
                    .iter()
                    .find(|chunk| message.number >= chunk.start && message.number <= chunk.end)
                    .map_or_else(|| original.clone(), |chunk| Hit::Chunk((*chunk).clone())),
                _ => original.clone(),
            };
            let id = key(&hit);
            if !seen.insert(id.clone()) {
                continue;
            }
            let score = 1.0 / (RRF_K + index as f64 + 1.0);
            match at.get(&id) {
                Some(&position) => fused[position].2 += score,
                None => {
                    at.insert(id.clone(), fused.len());
                    fused.push((id, hit, score));
                }
            }
        }
    }
    let mut order: Vec<usize> = (0..fused.len()).collect();
    order.sort_by(|left, right| {
        fused[*right]
            .2
            .partial_cmp(&fused[*left].2)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(left.cmp(right))
    });
    order
        .into_iter()
        .take(POOL)
        .map(|index| fused[index].1.clone())
        .collect()
}

/// `text` cut to at most `bytes` bytes at a character boundary.
pub fn truncate_utf8(text: &str, bytes: usize) -> &str {
    if text.len() <= bytes {
        return text;
    }
    let mut end = bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// `candidateText`: a one-line location and title, then as much body as
/// fits in [`DOCUMENT_BYTES`].
pub fn candidate_text(location: &str, title: &str, body: &str) -> String {
    let header = format!(
        "{}\n{}\n",
        truncate_utf8(&location.replace('\n', " "), 200),
        truncate_utf8(&title.replace('\n', " "), 120)
    );
    let room = DOCUMENT_BYTES.saturating_sub(header.len());
    format!("{header}{}", truncate_utf8(body, room))
}

fn first_line(text: &str) -> &str {
    text.split('\n').next().unwrap_or("")
}

/// `candidateTexts`: each candidate's document, from its stored text rather
/// than the shortened preview the hit carries.
pub fn candidate_texts(
    conn: &Connection,
    session: &str,
    project: &str,
    pool: &[Hit],
) -> Vec<String> {
    let one = |sql: &str, id: &dyn rusqlite::ToSql| -> Option<String> {
        conn.query_row(sql, [id], |row| row.get(0))
            .optional()
            .ok()
            .flatten()
    };
    pool.iter()
        .map(|hit| {
            let id = key(hit);
            let id = id.split_once(':').map_or("", |(_, id)| id);
            let mut location = format!("{} {id} {project}", source_name(hit));
            let (title, body) = match hit {
                Hit::Memory(memory) => {
                    let body = one("SELECT content FROM memories WHERE id = ?1", &memory.id)
                        .unwrap_or_else(|| memory.content.clone());
                    (first_line(&body).to_owned(), body)
                }
                Hit::Primer(primer) => {
                    let row: Option<(String, String)> = conn
                        .query_row(
                            "SELECT question, answer FROM primers WHERE id = ?1",
                            params![primer.id],
                            |row| Ok((row.get(0)?, row.get(1)?)),
                        )
                        .optional()
                        .ok()
                        .flatten();
                    match row {
                        Some((question, answer)) => {
                            let body = format!("Q: {question}\nA: {answer}");
                            (question, body)
                        }
                        None => (first_line(&primer.content).to_owned(), primer.content.clone()),
                    }
                }
                Hit::Commit(commit) => {
                    let body = one("SELECT message FROM git_commits WHERE sha = ?1", &commit.sha)
                        .unwrap_or_else(|| commit.content.clone());
                    (format!("{} {}", commit.short_sha, first_line(&body)), body)
                }
                Hit::Note(note) => {
                    let row: Option<(String, Option<String>)> = conn
                        .query_row(
                            "SELECT content, ready_reason FROM notes WHERE id = ?1",
                            params![note.id],
                            |row| Ok((row.get(0)?, row.get(1)?)),
                        )
                        .optional()
                        .ok()
                        .flatten();
                    let body = match row {
                        Some((content, Some(reason))) if !reason.is_empty() => {
                            format!("{content}\nReason: {reason}")
                        }
                        Some((content, _)) => content,
                        None => note.content.clone(),
                    };
                    (first_line(&body).to_owned(), body)
                }
                Hit::Message(message) => {
                    let body: Option<String> = conn
                        .query_row(
                            "SELECT f.content FROM message_fts_rowid_map m
                               JOIN message_history_fts f ON f.rowid = m.fts_rowid
                              WHERE m.session_id = ?1 AND m.message_ordinal = ?2 AND f.message_id = ?3",
                            params![session, message.number, message.message_id],
                            |row| row.get(0),
                        )
                        .optional()
                        .ok()
                        .flatten();
                    let body = body.unwrap_or_else(|| message.content.clone());
                    location = format!(
                        "message {} {session} @{}",
                        message.message_id, message.number
                    );
                    (format!("{}: {}", message.role, first_line(&body)), body)
                }
                Hit::Chunk(chunk) => {
                    location = format!(
                        "compartment {} {session} @{}-{}",
                        chunk.compartment_id, chunk.start, chunk.end
                    );
                    (
                        chunk.title.clone(),
                        chunk_text(conn, session, chunk.start, chunk.end),
                    )
                }
            };
            candidate_text(&location, &title, &body)
        })
        .collect()
}

fn source_name(hit: &Hit) -> &'static str {
    match hit {
        Hit::Memory(_) => "memory",
        Hit::Primer(_) => "primer",
        Hit::Message(_) => "message",
        Hit::Chunk(_) => "compartment",
        Hit::Commit(_) => "git_commit",
        Hit::Note(_) => "note",
    }
}

/// `buildCanonicalChunkTextFromFts`: the summarized messages as lines of
/// `[ordinals] U:` or `A:`, consecutive messages of one role joined with
/// ` / `.
fn chunk_text(conn: &Connection, session: &str, start: i64, end: i64) -> String {
    if end < start {
        return String::new();
    }
    let read = || -> rusqlite::Result<Vec<(i64, String, String)>> {
        let mut statement = conn.prepare_cached(
            "SELECT map.message_ordinal, fts.role, fts.content
               FROM message_fts_rowid_map AS map
              CROSS JOIN message_history_fts AS fts ON fts.rowid = map.fts_rowid
              WHERE map.session_id = ?1 AND map.message_ordinal BETWEEN ?2 AND ?3
                AND fts.role IN ('user', 'assistant')
              ORDER BY map.message_ordinal ASC",
        )?;
        let rows = statement.query_map(params![session, start, end], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?;
        rows.collect()
    };
    let mut lines: Vec<String> = Vec::new();
    let mut current: Option<(char, i64, i64, Vec<String>)> = None;
    let flush = |current: &mut Option<(char, i64, i64, Vec<String>)>, lines: &mut Vec<String>| {
        if let Some((role, first, last, parts)) = current.take() {
            if !parts.is_empty() {
                let range = if first == last {
                    format!("[{first}]")
                } else {
                    format!("[{first}-{last}]")
                };
                lines.push(format!("{range} {role}: {}", parts.join(" / ")));
            }
        }
    };
    for (ordinal, role, content) in read().unwrap_or_default() {
        let prefix = match role.as_str() {
            "user" => 'U',
            "assistant" => 'A',
            _ => continue,
        };
        let content = content.split_whitespace().collect::<Vec<_>>().join(" ");
        if ordinal <= 0 || content.is_empty() {
            continue;
        }
        if let Some((role, _, last, parts)) = current.as_mut() {
            if *role == prefix {
                *last = ordinal;
                parts.push(content);
                continue;
            }
        }
        flush(&mut current, &mut lines);
        current = Some((prefix, ordinal, ordinal, vec![content]));
    }
    flush(&mut current, &mut lines);
    lines.join("\n")
}

/// `pool` reordered by `scores` (best first, ties in pool order) and cut to
/// `limit`.
pub fn order(pool: Vec<Hit>, scores: &[f64], limit: usize) -> Vec<Hit> {
    let mut ranked: Vec<(usize, Hit)> = pool.into_iter().enumerate().collect();
    ranked.sort_by(|(left, _), (right, _)| {
        scores[*right]
            .partial_cmp(&scores[*left])
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(left.cmp(right))
    });
    ranked.into_iter().take(limit).map(|(_, hit)| hit).collect()
}

/// Synapse's certified reranker, as `models.list` names it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pinned {
    pub fingerprint: String,
    pub table_epoch: i64,
}

/// A rerank that did not happen, by a fixed reason: logged once per reason,
/// and for a hosted reranker also shown under the results.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Skipped(pub String);

/// Pin Synapse's catalog unless the daemon recently refused the module by name.
/// One daemon serves the process, so sessions share the absence, and a pin
/// is reused for a minute instead of asking on every prose search.
pub async fn pin_synapse(
    catalog: impl Future<Output = Result<Value, String>>,
) -> Result<Pinned, Skipped> {
    SYNAPSE_CATALOG.pin(catalog).await
}

/// Drop the reused pin, so the next search asks the catalog again.
pub fn forget_synapse_pin() {
    SYNAPSE_CATALOG.forget();
}

static SYNAPSE_CATALOG: SynapseCatalog = SynapseCatalog::new();

/// How long a pin from a catalog answer is reused. A failed pin is never
/// kept, so a Synapse that comes back is asked on the next search.
const PIN_REUSE: Duration = Duration::from_secs(60);

struct SynapseCatalog {
    retry_at: Mutex<Option<tokio::time::Instant>>,
    /// The last pin and when the catalog gave it.
    pinned: Mutex<Option<(Pinned, tokio::time::Instant)>>,
}

impl SynapseCatalog {
    const fn new() -> Self {
        Self {
            retry_at: Mutex::new(None),
            pinned: Mutex::new(None),
        }
    }

    fn forget(&self) {
        *self.pinned.lock().expect("Synapse pin") = None;
    }

    async fn pin(
        &self,
        catalog: impl Future<Output = Result<Value, String>>,
    ) -> Result<Pinned, Skipped> {
        if let Some((pin, at)) = self.pinned.lock().expect("Synapse pin").clone() {
            if tokio::time::Instant::now() < at + PIN_REUSE {
                return Ok(pin);
            }
        }
        let previous = *self.retry_at.lock().expect("Synapse availability");
        if previous.is_some_and(|retry_at| tokio::time::Instant::now() < retry_at) {
            return Err(Skipped("unknown_module".into()));
        }
        let result = catalog.await.map_err(Skipped).and_then(pin);
        *self.pinned.lock().expect("Synapse pin") = result
            .as_ref()
            .ok()
            .map(|pin| (pin.clone(), tokio::time::Instant::now()));
        let mut retry_at = self.retry_at.lock().expect("Synapse availability");
        match &result {
            Ok(_) => *retry_at = None,
            Err(Skipped(code)) if code == "unknown_module" && *retry_at == previous => {
                // A restart can look like an absent module for a few seconds.
                // Probe after 30 seconds; a refusal within 10 minutes of that
                // retry time backs off for 10 minutes. An older refusal starts
                // over at 30 seconds so separate restarts do not escalate.
                // Concurrent refusals from the same probe window count only once.
                let now = tokio::time::Instant::now();
                let delay = if previous.is_some_and(|retry_at| {
                    now.saturating_duration_since(retry_at) < Duration::from_secs(600)
                }) {
                    600
                } else {
                    30
                };
                *retry_at = Some(now + Duration::from_secs(delay));
            }
            _ => {}
        }
        result
    }
}

/// The body of a Synapse reply: the `result` member, refused when it carries
/// an error.
fn unwrap_reply(value: Value) -> Result<Value, Skipped> {
    let mut value = value;
    let body = match value.get_mut("result") {
        Some(result) => result.take(),
        None => value,
    };
    if !body.is_object() {
        return Err(Skipped("validation".into()));
    }
    if let Some(error) = body.get("error") {
        let code = error["code"].as_str().unwrap_or("synapse_error");
        return Err(Skipped(code.to_owned()));
    }
    Ok(body)
}

/// `pinReranker`: the certified model's single fingerprint and the table
/// epoch from a `models.list` answer.
pub fn pin(reply: Value) -> Result<Pinned, Skipped> {
    let body = unwrap_reply(reply)?;
    let model = body["models"]
        .as_array()
        .and_then(|models| models.iter().find(|row| row["model_id"] == MODEL));
    let invalid = || Skipped("catalog_validation".into());
    let model = model.ok_or_else(invalid)?;
    let fingerprints = model["fingerprints"].as_array().ok_or_else(invalid)?;
    let fingerprint = match (model["certified"].as_bool(), fingerprints.as_slice()) {
        (Some(true), [only]) => only.as_str().ok_or_else(invalid)?,
        _ => return Err(invalid()),
    };
    if fingerprint.len() != 64
        || !fingerprint
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err(invalid());
    }
    let table_epoch = body["table_epoch"]
        .as_i64()
        .filter(|epoch| epoch.unsigned_abs() < (1u64 << 53))
        .ok_or_else(invalid)?;
    Ok(Pinned {
        fingerprint: fingerprint.to_owned(),
        table_epoch,
    })
}

/// The `rerank.score` request for `texts`.
pub fn score_request(pinned: &Pinned, query: &str, texts: &[String]) -> Value {
    json!({
        "model": MODEL,
        "query": query,
        "candidates": texts,
        "required_fingerprint": pinned.fingerprint,
        "allow_equivalent": false,
        "max_queue_ms": 100,
        "deadline_ms": SYNAPSE_DEADLINE.as_millis() as u64,
    })
}

/// The scores in a `rerank.score` answer, checked against the pin and the
/// candidate count.
pub fn scores(reply: Value, pinned: &Pinned, count: usize) -> Result<Vec<f64>, Skipped> {
    let body = unwrap_reply(reply)?;
    if body["fingerprint"].as_str() != Some(pinned.fingerprint.as_str()) {
        return Err(Skipped("fingerprint_mismatch".into()));
    }
    if body["table_epoch"].as_i64() != Some(pinned.table_epoch) {
        return Err(Skipped("epoch_mismatch".into()));
    }
    let scores: Option<Vec<f64>> = body["scores"].as_array().and_then(|scores| {
        scores
            .iter()
            .map(|score| score.as_f64().filter(|score| score.is_finite()))
            .collect()
    });
    match scores {
        Some(scores) if scores.len() == count => Ok(scores),
        _ => Err(Skipped("validation".into())),
    }
}

/// Score `texts` on a hosted reranker. TEI endpoints take `{query, texts}`
/// and answer a list; others take `{model, query, documents}` and answer
/// their rows under `results` (Cohere, Jina, OpenRouter) or `data` (Voyage).
/// No `top_n` is sent: the others score every document without it, and
/// Voyage refuses it. Every document must come back scored exactly once.
pub async fn remote_scores(
    remote: &Remote,
    query: &str,
    texts: &[String],
) -> Result<Vec<f64>, Skipped> {
    let skipped = |reason: &str| Skipped(reason.to_owned());
    let configured = remote.endpoint.as_deref().unwrap_or("");
    let tei = configured.starts_with("tei+");
    let endpoint = configured
        .strip_prefix("tei+")
        .unwrap_or(configured)
        .trim_end_matches('/');
    if !(endpoint.starts_with("http://") || endpoint.starts_with("https://")) {
        return Err(skipped("invalid_endpoint"));
    }
    let body = if tei {
        json!({"query": query, "texts": texts})
    } else {
        json!({"model": remote.model, "query": query, "documents": texts})
    };
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .timeout(Duration::from_millis(remote.timeout_ms))
        .build()
        .map_err(|_| skipped("remote_error"))?;
    let mut request = client
        .post(format!("{endpoint}/rerank"))
        .header("content-type", "application/json");
    if let Some(key) = &remote.api_key {
        request = request.header("authorization", format!("Bearer {key}"));
    }
    let response = request
        .body(body.to_string())
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                skipped("timeout")
            } else {
                skipped("remote_error")
            }
        })?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(Skipped(format!("http_{status}")));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| skipped("invalid_reply"))?;
    let raw: Value = serde_json::from_slice(&bytes).map_err(|_| skipped("invalid_reply"))?;
    let rows = if tei {
        &raw
    } else if raw["results"].is_null() {
        &raw["data"]
    } else {
        &raw["results"]
    };
    let rows = rows.as_array().ok_or_else(|| skipped("invalid_reply"))?;
    if rows.len() != texts.len() {
        return Err(skipped("invalid_reply"));
    }
    let mut scores: Vec<Option<f64>> = vec![None; texts.len()];
    for row in rows {
        let index = row["index"].as_u64().map(|index| index as usize);
        let score = if tei {
            &row["score"]
        } else {
            &row["relevance_score"]
        };
        match (index, score.as_f64().filter(|score| score.is_finite())) {
            (Some(index), Some(score)) if index < texts.len() && scores[index].is_none() => {
                scores[index] = Some(score);
            }
            _ => return Err(skipped("invalid_reply")),
        }
    }
    Ok(scores
        .into_iter()
        .map(|score| score.unwrap_or(0.0))
        .collect())
}

/// The line a skipped hosted rerank adds under the results. Only fixed
/// reasons are shown; anything else reads as `remote_error`.
pub fn skipped_line(reason: &str) -> String {
    let known = matches!(
        reason,
        "invalid_reply"
            | "invalid_endpoint"
            | "validation"
            | "timeout"
            | "aborted"
            | "candidate_validation"
    ) || (reason.len() == 8
        && reason.starts_with("http_")
        && reason[5..].bytes().all(|byte| byte.is_ascii_digit()));
    format!(
        "Reranking skipped: {}",
        if known { reason } else { "remote_error" }
    )
}

/// Log a fallback to the ordinary ranking once per reason, as the plugin
/// does, so an absent Synapse does not repeat itself on every search.
pub fn log_fallback(reason: &str) {
    static LOGGED: Mutex<BTreeMap<String, ()>> = Mutex::new(BTreeMap::new());
    let mut logged = LOGGED.lock().expect("rerank log");
    if logged.insert(reason.to_owned(), ()).is_none() {
        tracing::info!(
            "ck-mc: ctx_search rerank fallback ({reason}); keeping the original ranking"
        );
    }
}

#[cfg(test)]
#[path = "rerank/synapse_tests.rs"]
mod synapse_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::search::messages::MessageHit;
    use crate::search::sources::{ChunkHit, MemoryHit};

    fn memory(id: i64) -> Hit {
        Hit::Memory(MemoryHit {
            id,
            source_name: None,
            category: "ARCHITECTURE".into(),
            content: format!("memory {id}"),
            hint_content: format!("memory {id}"),
            score: 0.5,
            match_type: "fts",
        })
    }

    fn message(number: i64) -> Hit {
        Hit::Message(MessageHit {
            number,
            message_id: format!("m{number}"),
            role: "user".into(),
            content: "text".into(),
            score: 0.5,
        })
    }

    fn chunk(id: i64, start: i64, end: i64) -> Hit {
        Hit::Chunk(ChunkHit {
            compartment_id: id,
            title: format!("summary {id}"),
            start,
            end,
            score: 0.5,
            match_type: "semantic",
            snippet: None,
        })
    }

    #[test]
    fn prose_questions_and_phrases_are_reranked_and_symbols_are_not() {
        for prose in [
            "how does the summarizer pick its model",
            "where is the commit sweep lease taken?",
            "summary boundary snaps back to the prompt",
        ] {
            assert!(is_prose_query(prose), "{prose}");
        }
        for not in [
            "Session::apply_cut",
            "two words",
            "error: database is locked",
            "TypeError: x is undefined in foo",
            "\"quoted phrase here please\"",
            "src/search/mod.rs rank lanes now",
            "a; b; c; d",
            "at foo (bar.rs:12) failed to read",
        ] {
            assert!(!is_prose_query(not), "{not}");
        }
    }

    #[test]
    fn lanes_fuse_by_reciprocal_rank_and_messages_vote_for_their_summary() {
        let lanes = Lanes {
            memory_fts: vec![memory(1), memory(2)],
            memory_vector: vec![memory(2), memory(3)],
            message_fts: vec![message(5), message(40)],
            chunk_vector: vec![chunk(9, 1, 10)],
            ..Lanes::default()
        };
        let fused: Vec<String> = fuse(&lanes).iter().map(key).collect();
        // Message 5 lies in summary 9's range, so it votes for the summary,
        // which then leads with two first places; memory 2 has a first and a
        // second place. Ties keep first-seen order.
        assert_eq!(
            fused,
            [
                "compartment:9",
                "memory:2",
                "memory:1",
                "memory:3",
                "message:m40"
            ]
        );
    }

    #[test]
    fn documents_stay_within_a_kilobyte_and_cut_at_characters() {
        let body = "é".repeat(2000);
        let text = candidate_text("memory 1 pj", "Title", &body);
        assert!(text.len() <= DOCUMENT_BYTES);
        assert!(text.starts_with("memory 1 pj\nTitle\n"));
        assert_eq!(truncate_utf8("aé", 2), "a");
    }

    #[test]
    fn a_pin_needs_one_certified_fingerprint_and_scores_must_match_it() {
        let fingerprint = "a".repeat(64);
        let catalog = json!({"result": {"table_epoch": 7, "models": [
            {"model_id": MODEL, "certified": true, "fingerprints": [fingerprint]}
        ]}});
        let pinned = pin(catalog).unwrap();
        assert_eq!(pinned.table_epoch, 7);
        let uncertified = json!({"result": {"table_epoch": 7, "models": [
            {"model_id": MODEL, "certified": false, "fingerprints": [fingerprint]}
        ]}});
        assert_eq!(pin(uncertified), Err(Skipped("catalog_validation".into())));
        let good =
            json!({"result": {"fingerprint": fingerprint, "table_epoch": 7, "scores": [0.1, 2.0]}});
        assert_eq!(scores(good, &pinned, 2), Ok(vec![0.1, 2.0]));
        let other_epoch =
            json!({"result": {"fingerprint": fingerprint, "table_epoch": 8, "scores": [0.1, 2.0]}});
        assert_eq!(
            scores(other_epoch, &pinned, 2),
            Err(Skipped("epoch_mismatch".into()))
        );
        let short =
            json!({"result": {"fingerprint": fingerprint, "table_epoch": 7, "scores": [0.1]}});
        assert_eq!(scores(short, &pinned, 2), Err(Skipped("validation".into())));
        let loading = json!({"result": {"error": {"code": "model_loading"}}});
        assert_eq!(
            scores(loading, &pinned, 2),
            Err(Skipped("model_loading".into()))
        );
    }

    #[test]
    fn the_reranked_order_is_best_score_first_cut_to_the_limit() {
        let pool = vec![memory(1), memory(2), memory(3)];
        let ordered: Vec<String> = order(pool, &[0.1, 3.0, 1.0], 2).iter().map(key).collect();
        assert_eq!(ordered, ["memory:2", "memory:3"]);
    }

    #[test]
    fn only_the_user_picks_a_reranker_and_a_project_may_only_turn_it_off() {
        let none = json!({});
        assert_eq!(Reranker::from_tiers(&none, &none), Reranker::Synapse);
        let remote_in_project = json!({"rerank": {"provider": "remote", "endpoint": "https://x"}});
        assert_eq!(
            Reranker::from_tiers(&none, &remote_in_project),
            Reranker::Synapse
        );
        let off = json!({"rerank": {"provider": "off"}});
        assert_eq!(Reranker::from_tiers(&none, &off), Reranker::Off);
        let user = json!({"rerank": {"provider": "remote", "endpoint": "tei+https://r", "timeout_ms": 1, "top_n": 50}});
        match Reranker::from_tiers(&user, &none) {
            Reranker::Remote(remote) => {
                assert_eq!(remote.timeout_ms, 50);
                assert_eq!(remote.top_n, POOL);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn only_fixed_reasons_reach_the_skip_line() {
        assert_eq!(skipped_line("http_503"), "Reranking skipped: http_503");
        assert_eq!(
            skipped_line("secret detail"),
            "Reranking skipped: remote_error"
        );
    }

    /// A `/rerank` endpoint shaped like Voyage's: it refuses a request that
    /// carries `top_n` with 400, and answers its rows under `data`.
    async fn voyage_endpoint() -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut raw = Vec::new();
                let mut chunk = [0u8; 8192];
                let body = loop {
                    let read = socket.read(&mut chunk).await.unwrap_or(0);
                    if read == 0 {
                        break None;
                    }
                    raw.extend_from_slice(&chunk[..read]);
                    let text = String::from_utf8_lossy(&raw).into_owned();
                    let Some(end) = text.find("\r\n\r\n") else {
                        continue;
                    };
                    let length = text[..end]
                        .lines()
                        .find_map(|line| {
                            line.to_lowercase()
                                .strip_prefix("content-length:")
                                .map(str::to_owned)
                        })
                        .and_then(|value| value.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    if raw.len() >= end + 4 + length {
                        break Some(text[end + 4..].to_owned());
                    }
                };
                let Some(body) = body else { continue };
                let request: Value = serde_json::from_str(&body).unwrap();
                let (status, reply) = if request.get("top_n").is_some() {
                    (
                        "400 Bad Request",
                        json!({"detail": "Argument 'top_n' is not supported"}),
                    )
                } else {
                    let rows: Vec<_> = (0..request["documents"].as_array().map_or(0, Vec::len))
                        .rev()
                        .map(|index| json!({"relevance_score": index as f64, "index": index}))
                        .collect();
                    (
                        "200 OK",
                        json!({"object": "list", "data": rows, "model": "rerank-3-lite"}),
                    )
                };
                let reply = reply.to_string();
                let response = format!(
                    "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}",
                    reply.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });
        format!("http://{address}")
    }

    #[tokio::test]
    async fn a_voyage_endpoint_scores_without_top_n_and_answers_under_data() {
        let remote = Remote {
            endpoint: Some(voyage_endpoint().await),
            model: Some("rerank-3-lite".into()),
            api_key: None,
            timeout_ms: 5_000,
            top_n: POOL,
        };
        let texts = vec!["a".to_owned(), "b".to_owned(), "c".to_owned()];
        let scores = remote_scores(&remote, "q", &texts).await.unwrap();
        assert_eq!(scores, [0.0, 1.0, 2.0]);
    }
}

#[cfg(test)]
mod config_regression_tests {
    use super::*;

    #[test]
    fn integral_timeout_is_clamped() {
        for (timeout, expected) in [
            (json!(-5), 50),
            (json!(75.0), 75),
            (json!(20000.0), 15000),
            (json!(75.5), 1500),
        ] {
            let Reranker::Remote(remote) = Reranker::from_tiers(
                &json!({"rerank": {"provider": "remote", "timeout_ms": timeout, "top_n": 3.0}}),
                &json!({}),
            ) else {
                panic!("not remote")
            };
            assert_eq!(remote.timeout_ms, expected);
            assert_eq!(remote.top_n, 3);
        }
    }
}
