//! Primer promotion: the module job, with no model, that turns standing
//! questions the summarizer noticed in several sessions into primers.
//!
//! Ported from the 0.49 plugin as it was (`promote-primers.ts`,
//! `primer-clustering.ts` and `storage-primers.ts`). Candidates whose source
//! is at most [`CANDIDATE_TTL_MS`] old are clustered: by cosine similarity
//! of their question vectors when both share an embedding model, otherwise
//! by their normalized question text. A cluster that matches an active
//! primer updates its support, last observation, vector and sources; any
//! other cluster becomes a primer once it was asked on at least
//! [`PROMOTION_THRESHOLD`] distinct UTC days spanning at least
//! [`MIN_SPAN_DAYS`] days. Older candidates are pruned, except those an
//! active primer names as its sources, which go once they are
//! [`CANDIDATE_MAX_AGE_MS`] old.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, HashMap};

use rusqlite::{params, Connection, Transaction, TransactionBehavior};
use serde_json::{json, Value};

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// Candidates older than this are pruned, and no older one is clustered.
pub(crate) const CANDIDATE_TTL_MS: i64 = 90 * DAY_MS;
/// A candidate an active primer names as a source is kept until it is this
/// old.
pub(crate) const CANDIDATE_MAX_AGE_MS: i64 = 180 * DAY_MS;
/// Two questions this similar, or more, are one question.
pub(crate) const CLUSTER_THRESHOLD: f64 = 0.85;
/// A candidate an active primer already counts stays with it down to
/// [`CLUSTER_THRESHOLD`] less this.
pub(crate) const CLUSTER_HYSTERESIS: f64 = 0.02;
/// A new cluster becomes a primer once asked on this many distinct days...
pub(crate) const PROMOTION_THRESHOLD: usize = 2;
/// ...spanning at least this many days.
pub(crate) const MIN_SPAN_DAYS: i64 = 7;
/// The question a cluster whose questions are all blank is promoted under.
const FALLBACK_QUESTION: &str = "How does this project subsystem work?";

/// One stored primer candidate: a standing question one summary noticed.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Candidate {
    pub id: i64,
    pub project: String,
    pub harness: String,
    pub session: String,
    pub question: String,
    pub normalized: String,
    pub compartment_start: Option<i64>,
    pub compartment_end: Option<i64>,
    pub start_message_id: String,
    pub end_message_id: String,
    /// When the first message of its source was written.
    pub source_time: i64,
    pub embedding: Option<Vec<f32>>,
    pub model: Option<String>,
}

/// One stored primer.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Primer {
    pub id: i64,
    pub project: String,
    pub question: String,
    pub embedding: Option<Vec<f32>>,
    pub model: Option<String>,
    pub answer: String,
    pub support: i64,
    pub last_observed_at: Option<i64>,
    pub answer_refreshed_at: Option<i64>,
    /// The candidates it counts, by id.
    pub sources: Vec<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

fn vector(blob: Option<Vec<u8>>) -> Option<Vec<f32>> {
    crate::embedding::decode(&blob?)
}

const CANDIDATE_COLUMNS: &str = "id, project_path, harness, session_id, question, normalized_question,
    source_compartment_start, source_compartment_end, source_start_message_id, source_end_message_id,
    source_message_time, question_embedding, question_embedding_model_id";

fn candidate(row: &rusqlite::Row<'_>) -> rusqlite::Result<Candidate> {
    Ok(Candidate {
        id: row.get(0)?,
        project: row.get(1)?,
        harness: row.get(2)?,
        session: row.get(3)?,
        question: row.get(4)?,
        normalized: row.get(5)?,
        compartment_start: row.get(6)?,
        compartment_end: row.get(7)?,
        start_message_id: row.get(8)?,
        end_message_id: row.get(9)?,
        source_time: row.get(10)?,
        embedding: vector(row.get(11)?),
        model: row.get(12)?,
    })
}

/// The ids a primer's `source_candidate_ids` lists; anything else is none.
fn ids_of(json: Option<String>) -> Vec<i64> {
    json.and_then(|json| serde_json::from_str::<Vec<Value>>(&json).ok())
        .map(|ids| ids.iter().filter_map(Value::as_i64).collect())
        .unwrap_or_default()
}

const PRIMER_COLUMNS: &str = "id, project_path, question, question_embedding,
    question_embedding_model_id, answer, total_support, last_observed_at, answer_refreshed_at,
    source_candidate_ids, created_at, updated_at";

fn primer(row: &rusqlite::Row<'_>) -> rusqlite::Result<Primer> {
    Ok(Primer {
        id: row.get(0)?,
        project: row.get(1)?,
        question: row.get(2)?,
        embedding: vector(row.get(3)?),
        model: row.get(4)?,
        answer: row.get(5)?,
        support: row.get(6)?,
        last_observed_at: row.get(7)?,
        answer_refreshed_at: row.get(8)?,
        sources: ids_of(row.get(9)?),
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

/// The project's candidates whose source is no older than the clustering
/// window at `now`, in the order of their source occurrence, then by id.
pub(crate) fn candidates_for_promotion(
    conn: &Connection,
    project: &str,
    now: i64,
) -> rusqlite::Result<Vec<Candidate>> {
    conn.prepare(&format!(
        "SELECT {CANDIDATE_COLUMNS} FROM primer_candidates
          WHERE project_path = ?1 AND source_message_time >= ?2
          ORDER BY project_path, harness, session_id, source_start_message_id,
                   source_end_message_id, id"
    ))?
    .query_map(params![project, now - CANDIDATE_TTL_MS], candidate)?
    .collect()
}

/// The candidates with these ids.
pub(crate) fn candidates_by_ids(
    conn: &Connection,
    ids: &[i64],
) -> rusqlite::Result<Vec<Candidate>> {
    conn.prepare(&format!(
        "SELECT {CANDIDATE_COLUMNS} FROM primer_candidates
          WHERE id IN (SELECT value FROM json_each(?1)) ORDER BY id"
    ))?
    .query_map(
        [serde_json::to_string(ids).expect("ids serialize")],
        candidate,
    )?
    .collect()
}

/// The project's active primers, the most recently observed first.
pub(crate) fn active_primers(conn: &Connection, project: &str) -> rusqlite::Result<Vec<Primer>> {
    conn.prepare(&format!(
        "SELECT {PRIMER_COLUMNS} FROM primers
          WHERE project_path = ?1 AND status = 'active'
          ORDER BY COALESCE(last_observed_at, created_at) DESC, id ASC"
    ))?
    .query_map([project], primer)?
    .collect()
}

/// Delete the project's candidates whose source is older than the
/// clustering window at `now`, keeping one an active primer counts until it
/// is [`CANDIDATE_MAX_AGE_MS`] old. Returns how many went.
pub(crate) fn prune(conn: &mut Connection, project: &str, now: i64) -> rusqlite::Result<usize> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let kept: BTreeSet<i64> = active_primers(&tx, project)?
        .into_iter()
        .flat_map(|primer| primer.sources)
        .collect();
    let old: Vec<(i64, i64)> = tx
        .prepare(
            "SELECT id, source_message_time FROM primer_candidates
              WHERE project_path = ?1 AND source_message_time < ?2",
        )?
        .query_map(params![project, now - CANDIDATE_TTL_MS], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut pruned = 0;
    for (id, time) in old {
        if !kept.contains(&id) || time < now - CANDIDATE_MAX_AGE_MS {
            pruned += tx.execute(
                "DELETE FROM primer_candidates WHERE id = ?1 AND project_path = ?2",
                params![id, project],
            )?;
        }
    }
    tx.commit()?;
    Ok(pruned)
}

/// Store a candidate's question vector, made by the provider whose model id
/// is `model`.
pub(crate) fn set_embedding(
    conn: &Connection,
    id: i64,
    vector: &[f32],
    model: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE primer_candidates SET question_embedding = ?2, question_embedding_model_id = ?3
          WHERE id = ?1",
        params![id, crate::embedding::encode(vector), model],
    )?;
    Ok(())
}

/// The key of a candidate's source occurrence: one summary of one session.
pub(crate) fn occurrence_key(candidate: &Candidate) -> String {
    [
        candidate.project.as_str(),
        candidate.harness.as_str(),
        candidate.session.as_str(),
        candidate.start_message_id.as_str(),
        candidate.end_message_id.as_str(),
    ]
    .join("\u{1f}")
}

/// The UTC calendar day of a time, as a day number.
pub(crate) fn utc_day(time: i64) -> i64 {
    time.div_euclid(DAY_MS)
}

/// Cosine similarity, unclamped, as the plugin scores primer questions;
/// vectors of different lengths score 0.
pub(crate) fn cosine(a: &[f32], b: &[f32]) -> f64 {
    if a.len() != b.len() {
        return 0.0;
    }
    let (mut dot, mut norm_a, mut norm_b) = (0.0f64, 0.0f64, 0.0f64);
    for (x, y) in a.iter().zip(b) {
        let (x, y) = (f64::from(*x), f64::from(*y));
        dot += x * y;
        norm_a += x * x;
        norm_b += y * y;
    }
    let denominator = norm_a.sqrt() * norm_b.sqrt();
    if denominator == 0.0 {
        0.0
    } else {
        dot / denominator
    }
}

/// One cluster of candidates, with the active primer it matches.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Cluster {
    pub primer: Option<Primer>,
    pub candidates: Vec<Candidate>,
    pub centroid: Option<Vec<f32>>,
    pub model: Option<String>,
}

fn average(vectors: &[&Vec<f32>]) -> Option<Vec<f32>> {
    let dims = vectors.first()?.len();
    if dims == 0 {
        return None;
    }
    let mut out = vec![0f32; dims];
    for vector in vectors {
        if vector.len() != dims {
            return None;
        }
        for (sum, value) in out.iter_mut().zip(vector.iter()) {
            *sum += *value;
        }
    }
    let count = vectors.len() as f32;
    for sum in &mut out {
        *sum /= count;
    }
    Some(out)
}

/// Whether `candidate` has a vector made by `model`.
fn same_space(candidate: &Candidate, model: Option<&str>) -> bool {
    candidate.embedding.is_some()
        && candidate.model.is_some()
        && model.is_some()
        && candidate.model.as_deref() == model
}

fn recompute_centroid(cluster: &mut Cluster) {
    let model = cluster.model.clone();
    let vectors: Vec<&Vec<f32>> = cluster
        .candidates
        .iter()
        .filter(|candidate| same_space(candidate, model.as_deref()))
        .filter_map(|candidate| candidate.embedding.as_ref())
        .collect();
    if !vectors.is_empty() {
        cluster.centroid = average(&vectors);
        return;
    }
    if let Some(embedding) = cluster
        .primer
        .as_ref()
        .and_then(|primer| primer.embedding.clone())
    {
        cluster.centroid = Some(embedding);
    }
}

/// Whether `candidate` asks the question `cluster` holds, by text: the same
/// normalized question as the cluster's first candidate, or, for a primer's
/// cluster with no candidate yet, as the primer's question normalized the
/// same way ([`crate::context_db::normalize_primer_question`], which stored
/// the candidate's). 0.49 compared the primer's question only lowercased and
/// trimmed; its trailing question mark then never matched, and a primer
/// whose questions had no vectors was promoted again on every run.
fn normalized_text_matches(candidate: &Candidate, cluster: &Cluster) -> bool {
    if let Some(first) = cluster.candidates.first() {
        return first.normalized == candidate.normalized;
    }
    cluster.primer.as_ref().is_some_and(|primer| {
        crate::context_db::normalize_primer_question(&primer.question) == candidate.normalized
    })
}

/// Compare two texts in UTF-16 code-unit order, as the plugin sorts them.
fn code_unit_order(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

/// Cluster `candidates` around `primers` (the project's active primers):
/// every candidate in the order of its occurrence key, then id, joins the
/// cluster it is most similar to at or above `threshold` (a candidate a
/// primer already counts stays with that primer down to `threshold` less
/// `hysteresis`), or starts a cluster of its own. The primers' clusters come
/// first, by primer id.
pub(crate) fn build_clusters(
    candidates: &[Candidate],
    primers: &[Primer],
    threshold: f64,
    hysteresis: f64,
) -> Vec<Cluster> {
    let mut primers = primers.to_vec();
    primers.sort_by_key(|primer| primer.id);
    let mut clusters: Vec<Cluster> = primers
        .into_iter()
        .map(|primer| Cluster {
            centroid: primer.embedding.clone(),
            model: primer.model.clone(),
            primer: Some(primer),
            candidates: Vec::new(),
        })
        .collect();
    let mut sorted: Vec<&Candidate> = candidates.iter().collect();
    sorted.sort_by(|left, right| {
        code_unit_order(
            &format!("{}\u{1f}{}", occurrence_key(left), left.id),
            &format!("{}\u{1f}{}", occurrence_key(right), right.id),
        )
    });
    for candidate in sorted {
        let mut best: Option<(usize, f64)> = None;
        for (at, cluster) in clusters.iter().enumerate() {
            let mut score = f64::NEG_INFINITY;
            match (&candidate.embedding, &cluster.centroid) {
                (Some(own), Some(centroid)) if same_space(candidate, cluster.model.as_deref()) => {
                    score = cosine(own, centroid);
                }
                _ if normalized_text_matches(candidate, cluster) => score = 1.0,
                _ => {}
            }
            let stickier = if cluster
                .primer
                .as_ref()
                .is_some_and(|primer| primer.sources.contains(&candidate.id))
            {
                threshold - hysteresis
            } else {
                threshold
            };
            if score >= stickier && best.is_none_or(|(_, best)| score > best) {
                best = Some((at, score));
            }
        }
        match best {
            Some((at, _)) => {
                clusters[at].candidates.push(candidate.clone());
                recompute_centroid(&mut clusters[at]);
            }
            None => clusters.push(Cluster {
                primer: None,
                candidates: vec![candidate.clone()],
                centroid: candidate.embedding.clone(),
                model: candidate.model.clone(),
            }),
        }
    }
    clusters
}

/// What a cluster adds up to.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Summary {
    /// Distinct UTC days it was asked on.
    pub support: usize,
    /// Whole days from its first day's earliest occurrence to its last's.
    pub span_days: i64,
    pub last_observed_at: i64,
    /// Every candidate it counts, its primer's earlier sources included, by
    /// id.
    pub sources: Vec<i64>,
}

/// Sum `cluster` up at `now`: one occurrence per source occurrence key (its
/// first candidate), then the earliest occurrence of each UTC day.
pub(crate) fn summarize(cluster: &Cluster, now: i64) -> Summary {
    let mut by_key: Vec<(String, &Candidate)> = Vec::new();
    for candidate in &cluster.candidates {
        let key = occurrence_key(candidate);
        if !by_key.iter().any(|(seen, _)| *seen == key) {
            by_key.push((key, candidate));
        }
    }
    let mut by_day: HashMap<i64, &Candidate> = HashMap::new();
    for (_, candidate) in by_key {
        let day = utc_day(candidate.source_time);
        match by_day.get(&day) {
            Some(existing) if existing.source_time <= candidate.source_time => {}
            _ => {
                by_day.insert(day, candidate);
            }
        }
    }
    let mut distinct: Vec<&Candidate> = by_day.into_values().collect();
    distinct.sort_by_key(|candidate| (candidate.source_time, candidate.id));
    let first = distinct
        .first()
        .map_or(0, |candidate| candidate.source_time);
    let last = distinct
        .last()
        .map_or(first, |candidate| candidate.source_time);
    let mut sources: BTreeSet<i64> = cluster
        .primer
        .as_ref()
        .map(|primer| primer.sources.iter().copied().collect())
        .unwrap_or_default();
    sources.extend(cluster.candidates.iter().map(|candidate| candidate.id));
    Summary {
        support: distinct.len(),
        span_days: if distinct.len() <= 1 {
            0
        } else {
            (last - first).div_euclid(DAY_MS)
        },
        last_observed_at: if last == 0 { now } else { last },
        sources: sources.into_iter().collect(),
    }
}

/// Whether a new cluster becomes a primer.
pub(crate) fn eligible(summary: &Summary, threshold: usize, min_span_days: i64) -> bool {
    summary.support >= threshold && summary.span_days >= min_span_days
}

/// The question a new primer takes: its oldest candidate's, ending with a
/// question mark.
pub(crate) fn canonical_question(candidates: &[Candidate]) -> String {
    let first = candidates
        .iter()
        .min_by_key(|candidate| (candidate.source_time, candidate.id))
        .map(|candidate| candidate.question.trim().to_owned())
        .unwrap_or_default();
    if first.is_empty() {
        return FALLBACK_QUESTION.to_owned();
    }
    if first.ends_with('?') {
        first
    } else {
        format!("{first}?")
    }
}

/// Where each of `ids` came from, as a primer records its sources, read
/// from the candidates that still exist.
fn provenance(tx: &Transaction<'_>, ids: &[i64]) -> rusqlite::Result<BTreeMap<i64, Value>> {
    Ok(candidates_by_ids(tx, ids)?
        .into_iter()
        .map(|candidate| {
            (
                candidate.id,
                json!({
                    "candidate_id": candidate.id,
                    "project_path": candidate.project,
                    "harness": candidate.harness,
                    "session_id": candidate.session,
                    "source_compartment_start": candidate.compartment_start,
                    "source_compartment_end": candidate.compartment_end,
                    "source_start_message_id": candidate.start_message_id,
                    "source_end_message_id": candidate.end_message_id,
                }),
            )
        })
        .collect())
}

/// A primer's provenance column: every source's record, by candidate id;
/// `None` (unknown) when it has sources but none could be recorded.
fn provenance_json(provenance: &BTreeMap<i64, Value>, sources: &[i64]) -> Option<String> {
    if provenance.is_empty() && !sources.is_empty() {
        return None;
    }
    Some(Value::Array(provenance.values().cloned().collect()).to_string())
}

/// A primer's recorded provenance, when it is the shape the plugin writes.
fn stored_provenance(json: Option<&str>) -> Option<Vec<Value>> {
    let records: Vec<Value> = serde_json::from_str(json?).ok()?;
    records
        .iter()
        .all(|record| {
            let compartment = |name: &str| {
                record
                    .get(name)
                    .is_some_and(|value| value.is_null() || value.is_number())
            };
            record["candidate_id"].is_number()
                && record["project_path"].is_string()
                && record["harness"].is_string()
                && record["session_id"].is_string()
                && compartment("source_compartment_start")
                && compartment("source_compartment_end")
                && record["source_start_message_id"].is_string()
                && record["source_end_message_id"].is_string()
        })
        .then_some(records)
}

/// What a promotion did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Promoted {
    pub candidates: usize,
    pub promoted: usize,
    pub updated: usize,
}

/// Cluster the project's candidates at `now` and write the result in one
/// transaction: each cluster that matches an active primer updates it, and
/// each new cluster that is eligible becomes a primer.
pub(crate) fn promote(
    conn: &mut Connection,
    project: &str,
    now: i64,
) -> rusqlite::Result<Promoted> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let candidates = candidates_for_promotion(&tx, project, now)?;
    let mut done = Promoted {
        candidates: candidates.len(),
        ..Promoted::default()
    };
    if candidates.is_empty() {
        return Ok(done);
    }
    let primers = active_primers(&tx, project)?;
    let clusters = build_clusters(&candidates, &primers, CLUSTER_THRESHOLD, CLUSTER_HYSTERESIS);
    for cluster in &clusters {
        if cluster.candidates.is_empty() {
            continue;
        }
        let summary = summarize(cluster, now);
        let vector = cluster.centroid.as_deref().map(crate::embedding::encode);
        let records = provenance(&tx, &summary.sources)?;
        if let Some(primer) = &cluster.primer {
            // Records of sources pruned since stay, as long as the primer
            // still counts them.
            let mut merged: BTreeMap<i64, Value> = BTreeMap::new();
            let stored: Option<String> = tx.query_row(
                "SELECT source_candidate_provenance FROM primers WHERE id = ?1",
                [primer.id],
                |row| row.get(0),
            )?;
            for record in stored_provenance(stored.as_deref()).unwrap_or_default() {
                if let Some(id) = record["candidate_id"].as_i64() {
                    if summary.sources.contains(&id) {
                        merged.insert(id, record);
                    }
                }
            }
            merged.extend(records);
            tx.execute(
                "UPDATE primers
                    SET question_embedding = COALESCE(?2, question_embedding),
                        question_embedding_model_id = COALESCE(?3, question_embedding_model_id),
                        total_support = ?4, last_observed_at = ?5, source_candidate_ids = ?6,
                        source_candidate_provenance = ?7, updated_at = ?8
                  WHERE id = ?1",
                params![
                    primer.id,
                    vector,
                    cluster.model,
                    summary.support as i64,
                    summary.last_observed_at,
                    serde_json::to_string(&summary.sources).expect("ids serialize"),
                    provenance_json(&merged, &summary.sources),
                    now
                ],
            )?;
            done.updated += 1;
            continue;
        }
        if !eligible(&summary, PROMOTION_THRESHOLD, MIN_SPAN_DAYS) {
            continue;
        }
        tx.execute(
            "INSERT INTO primers (project_path, question, question_embedding,
                 question_embedding_model_id, answer, status, total_support, last_observed_at,
                 answer_refreshed_at, source_candidate_ids, source_candidate_provenance,
                 created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, '', 'active', ?5, ?6, NULL, ?7, ?8, ?9, ?9)",
            params![
                project,
                canonical_question(&cluster.candidates),
                vector,
                cluster.model,
                summary.support as i64,
                summary.last_observed_at,
                serde_json::to_string(&summary.sources).expect("ids serialize"),
                provenance_json(&records, &summary.sources),
                now
            ],
        )?;
        done.promoted += 1;
    }
    tx.commit()?;
    Ok(done)
}

#[cfg(test)]
#[path = "promote_tests.rs"]
pub(crate) mod tests;
