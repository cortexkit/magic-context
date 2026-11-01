//! Deterministic primer task plans. Callers supply recorded/project-scoped reads
//! and commit each batch under its named dream lease. Planning performs no I/O,
//! model calls, activation reads or cache invalidation.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashSet};

pub const DAY_MS: i64 = 86_400_000;
pub const CANDIDATE_TTL_MS: i64 = 90 * DAY_MS;
pub const CANDIDATE_MAX_AGE_MS: i64 = 180 * DAY_MS;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub id: i64,
    pub project_path: String,
    pub harness: String,
    pub session_id: String,
    pub question: String,
    pub normalized_question: String,
    pub source_start_message_id: String,
    pub source_end_message_id: String,
    pub source_message_time: i64,
    pub source_compartment_start: Option<i64>,
    pub source_compartment_end: Option<i64>,
    pub question_embedding: Option<Vec<f32>>,
    pub question_embedding_model_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Provenance {
    pub candidate_id: i64,
    pub project_path: String,
    pub harness: String,
    pub session_id: String,
    pub source_compartment_start: Option<i64>,
    pub source_compartment_end: Option<i64>,
    pub source_start_message_id: String,
    pub source_end_message_id: String,
}

impl Candidate {
    fn occurrence_key(&self) -> String {
        [
            &self.project_path,
            &self.harness,
            &self.session_id,
            &self.source_start_message_id,
            &self.source_end_message_id,
        ]
        .map(String::as_str)
        .join("\u{1f}")
    }

    fn provenance(&self) -> Provenance {
        Provenance {
            candidate_id: self.id,
            project_path: self.project_path.clone(),
            harness: self.harness.clone(),
            session_id: self.session_id.clone(),
            source_compartment_start: self.source_compartment_start,
            source_compartment_end: self.source_compartment_end,
            source_start_message_id: self.source_start_message_id.clone(),
            source_end_message_id: self.source_end_message_id.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Primer {
    pub id: i64,
    pub project_path: String,
    pub question: String,
    pub question_embedding: Option<Vec<f32>>,
    pub question_embedding_model_id: Option<String>,
    pub answer: String,
    pub status: String,
    pub last_observed_at: Option<i64>,
    pub answer_refreshed_at: Option<i64>,
    pub source_candidate_ids: Vec<i64>,
    pub source_provenance: Option<Vec<Provenance>>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingUpdate {
    pub candidate_id: i64,
    pub vector: Vec<f32>,
    pub model_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SupportWrite {
    /// None creates an active primer with an empty answer and no refresh time.
    pub primer_id: Option<i64>,
    pub project_path: String,
    pub question: Option<String>,
    pub question_embedding: Option<Vec<f32>>,
    pub question_embedding_model_id: Option<String>,
    pub total_support: usize,
    pub last_observed_at: i64,
    pub source_candidate_ids: Vec<i64>,
    pub source_provenance: Option<Vec<Provenance>>,
    pub updated_at: i64,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PromotionResult {
    pub promoted: usize,
    pub updated: usize,
    pub candidates: usize,
    pub pruned: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PromotionBatch {
    pub project_path: String,
    pub lease_key: String,
    pub pruned_candidate_ids: Vec<i64>,
    pub embedding_updates: Vec<EmbeddingUpdate>,
    pub writes: Vec<SupportWrite>,
    pub result: PromotionResult,
}

struct Cluster<'a> {
    primer: Option<&'a Primer>,
    candidates: Vec<&'a Candidate>,
    centroid: Option<Vec<f32>>,
    model: Option<String>,
}

fn cosine(a: &[f32], b: &[f32]) -> f64 {
    if a.len() != b.len() {
        return 0.0;
    }
    let (mut dot, mut aa, mut bb) = (0.0, 0.0, 0.0);
    for (&a, &b) in a.iter().zip(b) {
        let (a, b) = (f64::from(a), f64::from(b));
        dot += a * b;
        aa += a * a;
        bb += b * b;
    }
    if aa == 0.0 || bb == 0.0 {
        0.0
    } else {
        dot / (aa.sqrt() * bb.sqrt())
    }
}

fn centroid(cluster: &Cluster<'_>) -> Option<Vec<f32>> {
    let vectors: Vec<_> = cluster
        .candidates
        .iter()
        .filter(|c| {
            c.question_embedding_model_id.is_some()
                && c.question_embedding_model_id == cluster.model
        })
        .filter_map(|c| c.question_embedding.as_ref())
        .collect();
    let Some(first) = vectors.first() else {
        return cluster.centroid.clone();
    };
    if first.is_empty() || vectors.iter().any(|v| v.len() != first.len()) {
        return None;
    }
    // Float32Array rounds after each addition, not just after the final average.
    let mut out = vec![0.0_f32; first.len()];
    for vector in &vectors {
        for (sum, value) in out.iter_mut().zip(vector.iter()) {
            *sum = (f64::from(*sum) + f64::from(*value)) as f32;
        }
    }
    for value in &mut out {
        *value = (f64::from(*value) / vectors.len() as f64) as f32;
    }
    Some(out)
}

/// Plan prune, embedding updates and promotion in that order. `embeddings` is the
/// optional Synapse result for missing vectors; an unavailable embedding service
/// is represented by an empty slice and retains normalized-text clustering.
/// The integration must recheck the lease inside its write transaction.
/// `compare_keys` supplies TS's localeCompare ordering; Rust lexical ordering is
/// not a substitute while the TS producer still uses locale-dependent sorting.
#[allow(clippy::too_many_arguments)]
pub fn plan_promotion(
    project: &str,
    lease_key: &str,
    now: i64,
    promotion_threshold: usize,
    candidates: &[Candidate],
    primers: &[Primer],
    embeddings: &[EmbeddingUpdate],
    compare_keys: impl Fn(&str, &str) -> std::cmp::Ordering,
) -> PromotionBatch {
    let mut active: Vec<_> = primers
        .iter()
        .filter(|p| p.project_path == project && p.status == "active")
        .collect();
    active.sort_by_key(|p| p.id);
    let protected: HashSet<_> = active
        .iter()
        .flat_map(|p| &p.source_candidate_ids)
        .copied()
        .collect();
    let mut batch = PromotionBatch {
        project_path: project.into(),
        lease_key: lease_key.into(),
        pruned_candidate_ids: Vec::new(),
        embedding_updates: Vec::new(),
        writes: Vec::new(),
        result: PromotionResult::default(),
    };
    let mut retained = Vec::new();
    let mut ordered_candidates: Vec<_> = candidates
        .iter()
        .filter(|c| c.project_path == project)
        .collect();
    ordered_candidates.sort_by_key(|c| {
        (
            &c.project_path,
            &c.harness,
            &c.session_id,
            &c.source_start_message_id,
            &c.source_end_message_id,
            c.id,
        )
    });
    for candidate in ordered_candidates {
        if candidate.source_message_time < now - CANDIDATE_TTL_MS
            && (!protected.contains(&candidate.id)
                || candidate.source_message_time < now - CANDIDATE_MAX_AGE_MS)
        {
            batch.pruned_candidate_ids.push(candidate.id);
        } else {
            let mut candidate = candidate.clone();
            if candidate.question_embedding.is_none()
                || candidate
                    .question_embedding_model_id
                    .as_deref()
                    .is_none_or(str::is_empty)
            {
                if let Some(update) = embeddings.iter().find(|e| e.candidate_id == candidate.id) {
                    candidate.question_embedding = Some(update.vector.clone());
                    candidate.question_embedding_model_id = Some(update.model_id.clone());
                    batch.embedding_updates.push(update.clone());
                }
            }
            retained.push(candidate);
        }
    }
    batch.result.candidates = retained.len();
    batch.pruned_candidate_ids.sort_unstable();
    batch.result.pruned = batch.pruned_candidate_ids.len();
    let mut clusters: Vec<_> = active
        .iter()
        .map(|p| Cluster {
            primer: Some(*p),
            candidates: Vec::new(),
            centroid: p.question_embedding.clone(),
            model: p.question_embedding_model_id.clone(),
        })
        .collect();
    retained.sort_by(|a, b| {
        let a = format!("{}\u{1f}{}", a.occurrence_key(), a.id);
        let b = format!("{}\u{1f}{}", b.occurrence_key(), b.id);
        compare_keys(&a, &b)
    });
    for candidate in &retained {
        let mut best = None;
        let mut best_score = f64::NEG_INFINITY;
        for (index, cluster) in clusters.iter().enumerate() {
            let score = match (&candidate.question_embedding, &cluster.centroid) {
                (Some(a), Some(b))
                    if candidate
                        .question_embedding_model_id
                        .as_deref()
                        .is_some_and(|m| !m.is_empty())
                        && candidate.question_embedding_model_id == cluster.model =>
                {
                    cosine(a, b)
                }
                _ => {
                    let same = cluster.candidates.first().map_or_else(
                        || {
                            cluster.primer.is_some_and(|p| {
                                p.question.to_lowercase().trim() == candidate.normalized_question
                            })
                        },
                        |c| c.normalized_question == candidate.normalized_question,
                    );
                    if same {
                        1.0
                    } else {
                        f64::NEG_INFINITY
                    }
                }
            };
            let threshold = if cluster
                .primer
                .is_some_and(|p| p.source_candidate_ids.contains(&candidate.id))
            {
                0.85 - 0.02
            } else {
                0.85
            };
            if score >= threshold && (best.is_none() || score > best_score) {
                best = Some(index);
                best_score = score;
            }
        }
        if let Some(index) = best {
            clusters[index].candidates.push(candidate);
            clusters[index].centroid = centroid(&clusters[index]);
        } else {
            clusters.push(Cluster {
                primer: None,
                candidates: vec![candidate],
                centroid: candidate.question_embedding.clone(),
                model: candidate.question_embedding_model_id.clone(),
            });
        }
    }
    for cluster in clusters.iter().filter(|c| !c.candidates.is_empty()) {
        let mut seen = HashSet::new();
        let mut days = std::collections::BTreeMap::new();
        for candidate in &cluster.candidates {
            if seen.insert(candidate.occurrence_key()) {
                let day = candidate.source_message_time.div_euclid(DAY_MS);
                let earliest = days.entry(day).or_insert(candidate.source_message_time);
                *earliest = (*earliest).min(candidate.source_message_time);
            }
        }
        let first = days.values().min().copied().unwrap_or(0);
        let last = days.values().max().copied().unwrap_or(first);
        let span = (last - first).div_euclid(DAY_MS);
        if cluster.primer.is_none() && (days.len() < promotion_threshold || span < 7) {
            continue;
        }
        let ids: BTreeSet<_> = cluster
            .primer
            .into_iter()
            .flat_map(|p| p.source_candidate_ids.iter().copied())
            .chain(cluster.candidates.iter().map(|c| c.id))
            .collect();
        let mut provenance = std::collections::BTreeMap::new();
        for source in cluster
            .primer
            .into_iter()
            .flat_map(|p| p.source_provenance.iter().flatten())
        {
            if ids.contains(&source.candidate_id) {
                provenance.insert(source.candidate_id, source.clone());
            }
        }
        for candidate in &retained {
            if ids.contains(&candidate.id) {
                provenance.insert(candidate.id, candidate.provenance());
            }
        }
        let question = if cluster.primer.is_none() {
            let first = cluster
                .candidates
                .iter()
                .min_by_key(|c| (c.source_message_time, c.id))
                .unwrap()
                .question
                .trim();
            Some(if first.is_empty() {
                "How does this project subsystem work?".into()
            } else if first.ends_with('?') {
                first.into()
            } else {
                format!("{first}?")
            })
        } else {
            None
        };
        let source_provenance = if provenance.is_empty() && !ids.is_empty() {
            None
        } else {
            Some(provenance.into_values().collect())
        };
        batch.writes.push(SupportWrite {
            primer_id: cluster.primer.map(|p| p.id),
            project_path: project.into(),
            question,
            question_embedding: cluster.centroid.clone(),
            question_embedding_model_id: cluster.model.clone(),
            total_support: days.len(),
            last_observed_at: if last == 0 { now } else { last },
            source_candidate_ids: ids.into_iter().collect(),
            source_provenance,
            updated_at: now,
        });
        if cluster.primer.is_some() {
            batch.result.updated += 1;
        } else {
            batch.result.promoted += 1;
        }
    }
    batch
}

pub fn refresh_queue<'a>(project: &str, primers: &'a [Primer]) -> Vec<&'a Primer> {
    let mut queue: Vec<_> = primers
        .iter()
        .filter(|p| p.project_path == project && p.status == "active")
        .filter(|p| {
            p.answer.trim().is_empty()
                || p.answer_refreshed_at.is_none()
                || p.last_observed_at.unwrap_or(0) > p.answer_refreshed_at.unwrap_or(0)
        })
        .collect();
    queue.sort_by_key(|p| {
        (
            p.answer_refreshed_at.unwrap_or(0),
            p.last_observed_at.unwrap_or(p.created_at),
            p.id,
        )
    });
    queue.truncate(5);
    queue
}

pub fn origin_candidate<'a>(primer: &Primer, candidates: &'a [Candidate]) -> Option<&'a Candidate> {
    candidates
        .iter()
        .filter(|c| {
            c.project_path == primer.project_path && primer.source_candidate_ids.contains(&c.id)
        })
        .max_by_key(|c| (c.source_message_time, c.id))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AnswerBatch {
    pub project_path: String,
    pub lease_key: String,
    pub primer_id: i64,
    pub answer: String,
    pub answer_refreshed_at: i64,
    pub updated_at: i64,
}

/// Parse the same fenced-or-greedy JSON object as the TS child-output validator.
pub(crate) fn answer_json(text: &str) -> Option<&str> {
    let fenced = regex::Regex::new(r"(?s)```(?:json)?\s*(.*?)```").unwrap();
    if let Some(capture) = fenced.captures(text) {
        return capture.get(1).map(|m| m.as_str());
    }
    let (start, end) = (text.find('{')?, text.rfind('}')?);
    (start <= end).then(|| &text[start..=end])
}

pub fn plan_answer(
    primer: &Primer,
    lease_key: &str,
    text: &str,
    tool_calls: usize,
    now: i64,
) -> Result<Option<AnswerBatch>, String> {
    if text.is_empty() {
        return Err("refresh-primers returned no output".into());
    }
    let json = answer_json(text).ok_or("refresh-primers returned no JSON")?;
    let value: serde_json::Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
    if value.is_null() {
        return Err("refresh-primers returned null JSON".into());
    }
    let mut answer = value
        .get("answer")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if answer.is_empty() && !primer.answer.trim().is_empty() {
        answer = primer.answer.trim();
    } else if answer.encode_utf16().count() > 20_000 {
        return Err("refresh-primers answer too large".into());
    }
    if answer.is_empty() || tool_calls == 0 {
        return Ok(None);
    }
    Ok(Some(AnswerBatch {
        project_path: primer.project_path.clone(),
        lease_key: lease_key.into(),
        primer_id: primer.id,
        answer: answer.into(),
        answer_refreshed_at: now,
        updated_at: now,
    }))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Seed {
    pub kind: String,
    pub orientation: String,
    pub pre_post: String,
    pub session_id: Option<String>,
}

/// Host-normalized summary projection: tool summaries carry inputs, never tool
/// outputs. Assistant narrative has no field and therefore cannot enter a seed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrientationMessage {
    pub session_id: String,
    pub ordinal: i64,
    pub user_text: Option<String>,
    pub tool_summaries: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedCompartment {
    pub session_id: String,
    pub sequence: i64,
    pub start_message: i64,
    pub title: String,
    pub p1: Option<String>,
    pub content: Option<String>,
}

pub(crate) fn utf16_prefix(text: &str, limit: usize) -> String {
    // Never split a Unicode scalar in a Rust string. The source projections are
    // valid text; a half-surrogate is not a representable durable UTF-8 value.
    let mut units = 0;
    text.chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= limit
        })
        .collect()
}

/// Build the seed from bounded, recorded summary pages for the selected origin.
/// `estimate` must be the same token estimator used for the child request.
pub fn build_seed(
    primer: &Primer,
    candidates: &[Candidate],
    raw: Option<&[OrientationMessage]>,
    compartments: &[SeedCompartment],
    estimate: impl Fn(&str) -> usize,
) -> Seed {
    let empty = || Seed {
        kind: "closed-book".into(),
        orientation: String::new(),
        pre_post: String::new(),
        session_id: None,
    };
    let Some(origin) = origin_candidate(primer, candidates) else {
        return empty();
    };
    let (Some(start), Some(end)) = (
        origin.source_compartment_start,
        origin.source_compartment_end,
    ) else {
        return empty();
    };
    let compartment = compartments
        .iter()
        .filter(|c| c.session_id == origin.session_id && c.start_message == start)
        .min_by_key(|c| c.sequence);
    let mut neighbors: Vec<_> = compartments
        .iter()
        .filter(|c| {
            c.session_id == origin.session_id
                && compartment
                    .is_some_and(|o| c.sequence == o.sequence - 1 || c.sequence == o.sequence + 1)
        })
        .collect();
    neighbors.sort_by_key(|c| c.sequence);
    let pre_post = neighbors
        .iter()
        .map(|c| {
            let label = if c.sequence < compartment.unwrap().sequence {
                "before"
            } else {
                "after"
            };
            let body = utf16_prefix(c.p1.as_deref().or(c.content.as_deref()).unwrap_or(""), 1200);
            format!("- ({label}) {}: {body}", utf16_prefix(&c.title, 512))
        })
        .collect::<Vec<_>>()
        .join("\n");
    let mut lines = Vec::new();
    let mut tokens = 0;
    let mut saw_message = false;
    'pages: for message in raw
        .into_iter()
        .flatten()
        .filter(|m| m.session_id == origin.session_id && (start..=end).contains(&m.ordinal))
    {
        saw_message = true;
        let user = message
            .user_text
            .as_ref()
            .filter(|s| !s.is_empty())
            .map(|s| format!("U: {s}"));
        for line in user.iter().chain(message.tool_summaries.iter()) {
            let cost = estimate(line);
            if tokens + cost > 4000 && !lines.is_empty() {
                lines.push(
                    "… (orientation truncated; investigate the current source directly)".into(),
                );
                break 'pages;
            }
            lines.push(line.clone());
            tokens += cost;
        }
    }
    let (kind, orientation) = if saw_message {
        ("raw", lines.join("\n"))
    } else {
        let body = compartment
            .map(|c| utf16_prefix(c.p1.as_deref().or(c.content.as_deref()).unwrap_or(""), 2000))
            .unwrap_or_default();
        let orientation = compartment
            .filter(|c| !c.title.is_empty())
            .map_or(body.clone(), |c| {
                format!("{}: {body}", utf16_prefix(&c.title, 512))
            });
        ("closed-book", orientation)
    };
    Seed {
        kind: kind.into(),
        orientation,
        pre_post,
        session_id: Some(origin.session_id.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Expected batches come from the TypeScript dreamer implementation at git
    // revision 282d9c08bce4, executed with a fixed clock and recorded source rows.
    // The expected values were not generated from this Rust implementation.
    const NOW: i64 = 17_280_000_000;

    fn candidate(id: i64, day: i64) -> Candidate {
        Candidate {
            id,
            project_path: "/p".into(),
            harness: "pi".into(),
            session_id: format!("s{id}"),
            question: "How does routing work".into(),
            normalized_question: "how does routing work".into(),
            source_start_message_id: format!("m{id}"),
            source_end_message_id: format!("m{id}"),
            source_message_time: day * DAY_MS,
            source_compartment_start: Some(1),
            source_compartment_end: Some(3),
            question_embedding: None,
            question_embedding_model_id: None,
        }
    }

    fn primer(id: i64) -> Primer {
        Primer {
            id,
            project_path: "/p".into(),
            question: "How does routing work".into(),
            question_embedding: None,
            question_embedding_model_id: None,
            answer: "old answer".into(),
            status: "active".into(),
            last_observed_at: Some(NOW),
            answer_refreshed_at: Some(1),
            source_candidate_ids: Vec::new(),
            source_provenance: Some(Vec::new()),
            created_at: 1,
        }
    }

    fn plan(
        candidates: &[Candidate],
        primers: &[Primer],
        embeddings: &[EmbeddingUpdate],
        order: &[i64],
    ) -> PromotionBatch {
        // `order` contains candidate IDs in the order returned by TypeScript's
        // localeCompare sort. Only that string comparator is substituted; the
        // planner still assigns clusters and computes their centroids/support.
        let keys: Vec<_> = order
            .iter()
            .filter_map(|id| candidates.iter().find(|c| c.id == *id))
            .map(|c| {
                format!(
                    "{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}",
                    c.project_path,
                    c.harness,
                    c.session_id,
                    c.source_start_message_id,
                    c.source_end_message_id,
                    c.id
                )
            })
            .collect();
        plan_promotion(
            "/p",
            "project:/p",
            NOW,
            2,
            candidates,
            primers,
            embeddings,
            |a, b| {
                keys.iter()
                    .position(|k| k == a)
                    .unwrap()
                    .cmp(&keys.iter().position(|k| k == b).unwrap())
            },
        )
    }

    fn assert_recorded(actual: PromotionBatch, expected: &str) {
        let expected: PromotionBatch = serde_json::from_str(expected).unwrap();
        assert_eq!(
            serde_json::to_vec(&actual).unwrap(),
            serde_json::to_vec(&expected).unwrap()
        );
    }

    #[test]
    fn promotion_distinct_days_and_span_match_ts() {
        assert_recorded(
            plan(
                &[candidate(3, 192), candidate(1, 184), candidate(2, 184)],
                &[],
                &[],
                &[1, 2, 3],
            ),
            r#"{"projectPath":"/p","leaseKey":"project:/p","prunedCandidateIds":[],"embeddingUpdates":[],"writes":[{"primerId":null,"projectPath":"/p","question":"How does routing work?","questionEmbedding":null,"questionEmbeddingModelId":null,"totalSupport":2,"lastObservedAt":16588800000,"sourceCandidateIds":[1,2,3],"sourceProvenance":[{"candidateId":1,"projectPath":"/p","harness":"pi","sessionId":"s1","sourceCompartmentStart":1,"sourceCompartmentEnd":3,"sourceStartMessageId":"m1","sourceEndMessageId":"m1"},{"candidateId":2,"projectPath":"/p","harness":"pi","sessionId":"s2","sourceCompartmentStart":1,"sourceCompartmentEnd":3,"sourceStartMessageId":"m2","sourceEndMessageId":"m2"},{"candidateId":3,"projectPath":"/p","harness":"pi","sessionId":"s3","sourceCompartmentStart":1,"sourceCompartmentEnd":3,"sourceStartMessageId":"m3","sourceEndMessageId":"m3"}],"updatedAt":17280000000}],"result":{"promoted":1,"updated":0,"candidates":3,"pruned":0}}"#,
        );
        for candidates in [
            vec![candidate(1, 195), candidate(2, 199)],
            vec![candidate(1, 192), candidate(2, 192), candidate(3, 192)],
        ] {
            let result = plan(&candidates, &[], &[], &[1, 2, 3]);
            assert!(result.writes.is_empty());
            assert_eq!(result.result.promoted, 0);
        }
    }

    #[test]
    fn promotion_retention_and_provenance_match_ts() {
        let mut p = primer(7);
        p.source_candidate_ids = vec![1, 2];
        p.source_provenance = Some(vec![
            candidate(1, 10).provenance(),
            candidate(2, 100).provenance(),
        ]);
        let mut foreign = candidate(4, 199);
        foreign.project_path = "/other".into();
        assert_recorded(
            plan(
                &[
                    candidate(1, 10),
                    candidate(2, 100),
                    candidate(3, 100),
                    foreign,
                ],
                &[p],
                &[],
                &[2],
            ),
            r#"{"projectPath":"/p","leaseKey":"project:/p","prunedCandidateIds":[1,3],"embeddingUpdates":[],"writes":[{"primerId":7,"projectPath":"/p","question":null,"questionEmbedding":null,"questionEmbeddingModelId":null,"totalSupport":1,"lastObservedAt":8640000000,"sourceCandidateIds":[1,2],"sourceProvenance":[{"candidateId":1,"projectPath":"/p","harness":"pi","sessionId":"s1","sourceCompartmentStart":1,"sourceCompartmentEnd":3,"sourceStartMessageId":"m1","sourceEndMessageId":"m1"},{"candidateId":2,"projectPath":"/p","harness":"pi","sessionId":"s2","sourceCompartmentStart":1,"sourceCompartmentEnd":3,"sourceStartMessageId":"m2","sourceEndMessageId":"m2"}],"updatedAt":17280000000}],"result":{"promoted":0,"updated":1,"candidates":1,"pruned":2}}"#,
        );
    }

    #[test]
    fn promotion_hysteresis_and_embedding_spaces_match_ts() {
        let mut candidates = vec![candidate(1, 184), candidate(2, 192)];
        for c in &mut candidates {
            c.question_embedding = Some(vec![0.84, (1.0_f64 - 0.84_f64.powi(2)).sqrt() as f32]);
            c.question_embedding_model_id = Some("m".into());
        }
        let mut p = primer(7);
        p.question = "other".into();
        p.question_embedding = Some(vec![1.0, 0.0]);
        p.question_embedding_model_id = Some("m".into());
        p.source_candidate_ids = vec![1];
        assert_recorded(
            plan(&candidates, &[p], &[], &[1, 2]),
            r#"{"projectPath":"/p","leaseKey":"project:/p","prunedCandidateIds":[],"embeddingUpdates":[],"writes":[{"primerId":7,"projectPath":"/p","question":null,"questionEmbedding":[0.8399999737739563,0.5425863862037659],"questionEmbeddingModelId":"m","totalSupport":2,"lastObservedAt":16588800000,"sourceCandidateIds":[1,2],"sourceProvenance":[{"candidateId":1,"projectPath":"/p","harness":"pi","sessionId":"s1","sourceCompartmentStart":1,"sourceCompartmentEnd":3,"sourceStartMessageId":"m1","sourceEndMessageId":"m1"},{"candidateId":2,"projectPath":"/p","harness":"pi","sessionId":"s2","sourceCompartmentStart":1,"sourceCompartmentEnd":3,"sourceStartMessageId":"m2","sourceEndMessageId":"m2"}],"updatedAt":17280000000}],"result":{"promoted":0,"updated":1,"candidates":2,"pruned":0}}"#,
        );
        candidates[0].question_embedding = Some(vec![1.0, 0.0]);
        candidates[0].question_embedding_model_id = Some("a".into());
        candidates[1].question_embedding = Some(vec![0.0, 1.0]);
        candidates[1].question_embedding_model_id = Some("b".into());
        let b = plan(&candidates, &[], &[], &[1, 2]);
        assert_eq!(b.writes[0].question_embedding, Some(vec![1.0, 0.0]));
        assert_eq!(
            b.writes[0].question_embedding_model_id.as_deref(),
            Some("a")
        );
        assert_eq!(b.writes[0].total_support, 2);
    }

    #[test]
    fn promotion_missing_embeddings_and_occurrence_identity_match_ts() {
        let mut candidates = vec![candidate(1, 184), candidate(2, 192)];
        candidates[1].question = "Different text".into();
        candidates[1].normalized_question = "different text".into();
        let embeddings = vec![
            EmbeddingUpdate {
                candidate_id: 1,
                vector: vec![1.0, 0.0],
                model_id: "m".into(),
            },
            EmbeddingUpdate {
                candidate_id: 2,
                vector: vec![1.0, 0.0],
                model_id: "m".into(),
            },
        ];
        candidates.reverse();
        let b = plan(&candidates, &[], &embeddings, &[1, 2]);
        assert_eq!(
            serde_json::to_value(&b.result).unwrap(),
            json!({"promoted":1,"updated":0,"candidates":2,"pruned":0})
        );
        assert_eq!(b.embedding_updates, embeddings);
        assert_eq!(b.writes[0].question_embedding, Some(vec![1.0, 0.0]));
        let mut duplicate = candidate(4, 192);
        duplicate.session_id = "s1".into();
        duplicate.source_start_message_id = "m1".into();
        duplicate.source_end_message_id = "m1".into();
        let b = plan(
            &[candidate(1, 184), candidate(10, 192), duplicate],
            &[],
            &[],
            &[10, 1, 4],
        );
        assert_eq!(b.writes[0].source_candidate_ids, vec![1, 4, 10]);
        assert_eq!(b.writes[0].total_support, 2);
        let mut duplicate = candidate(4, 192);
        duplicate.session_id = "s1".into();
        duplicate.source_start_message_id = "m1".into();
        duplicate.source_end_message_id = "m1".into();
        let b = plan(
            &[candidate(1, 184), candidate(10, 184), duplicate],
            &[],
            &[],
            &[10, 1, 4],
        );
        assert!(b.writes.is_empty());
    }

    #[test]
    fn promotion_candidate_comparator_controls_tie_assignment() {
        let mut candidates = vec![candidate(1, 184), candidate(10, 184), candidate(2, 192)];
        for (c, question, vector) in [
            (0, "First", vec![1.0, 2.0]),
            (1, "Second", vec![2.0, 1.0]),
            (2, "Bridge", vec![1.0, 1.0]),
        ] {
            candidates[c].question = question.into();
            candidates[c].normalized_question = question.to_lowercase();
            candidates[c].question_embedding = Some(vector);
            candidates[c].question_embedding_model_id = Some("m".into());
        }
        assert_recorded(
            plan(&candidates, &[], &[], &[10, 1, 2]),
            r#"{"projectPath":"/p","leaseKey":"project:/p","prunedCandidateIds":[],"embeddingUpdates":[],"writes":[{"primerId":null,"projectPath":"/p","question":"Second?","questionEmbedding":[1.5,1],"questionEmbeddingModelId":"m","totalSupport":2,"lastObservedAt":16588800000,"sourceCandidateIds":[2,10],"sourceProvenance":[{"candidateId":2,"projectPath":"/p","harness":"pi","sessionId":"s2","sourceCompartmentStart":1,"sourceCompartmentEnd":3,"sourceStartMessageId":"m2","sourceEndMessageId":"m2"},{"candidateId":10,"projectPath":"/p","harness":"pi","sessionId":"s10","sourceCompartmentStart":1,"sourceCompartmentEnd":3,"sourceStartMessageId":"m10","sourceEndMessageId":"m10"}],"updatedAt":17280000000}],"result":{"promoted":1,"updated":0,"candidates":3,"pruned":0}}"#,
        );
    }

    #[test]
    fn refresh_queue_priority_and_cap_match_ts() {
        let mut primers: Vec<_> = (1..=8).map(primer).collect();
        for p in &mut primers {
            p.answer_refreshed_at = Some(p.id - 1);
            p.last_observed_at = Some(p.id);
        }
        primers[0].answer = String::new();
        primers[0].answer_refreshed_at = None;
        primers[0].last_observed_at = Some(1000);
        primers[6].answer_refreshed_at = Some(900);
        primers[6].last_observed_at = Some(800);
        primers[7].project_path = "/other".into();
        primers.reverse();
        assert_eq!(
            refresh_queue("/p", &primers)
                .iter()
                .map(|p| p.id)
                .collect::<Vec<_>>(),
            vec![1, 2, 3, 4, 5]
        );
    }

    #[test]
    fn refresh_answer_grounding_fallback_and_bounds_match_ts() {
        let mut p = primer(1);
        for (text, fallback, calls, expected) in [
            (
                "```json\n{\"answer\":\" new answer \"}\n```",
                "old",
                1,
                Some("new answer"),
            ),
            ("{\"answer\":\"\"}", " old ", 1, Some("old")),
            ("{\"answer\":\"new\"}", "old", 0, None),
            ("{\"answer\":42}", "", 1, None),
        ] {
            p.answer = fallback.into();
            let actual = plan_answer(&p, "project:/p", text, calls, NOW).unwrap();
            assert_eq!(actual.as_ref().map(|a| a.answer.as_str()), expected);
            if let Some(answer) = actual {
                assert_eq!(answer.primer_id, 1);
                assert_eq!(answer.answer_refreshed_at, NOW);
                assert_eq!(answer.lease_key, "project:/p");
            }
        }
        for (text, error) in [
            (String::new(), "refresh-primers returned no output"),
            ("} {".into(), "refresh-primers returned no JSON"),
            (
                format!("{{\"answer\":\"{}\"}}", "a".repeat(20_001)),
                "refresh-primers answer too large",
            ),
        ] {
            assert_eq!(
                plan_answer(&p, "project:/p", &text, 1, NOW).unwrap_err(),
                error
            );
        }
        assert!(plan_answer(&p, "project:/p", "{\"answer\":", 1, NOW).is_err());
    }

    #[test]
    fn seed_origin_privacy_and_closed_book_match_ts() {
        let mut p = primer(7);
        p.source_candidate_ids = vec![1, 2, 3];
        let mut foreign = candidate(3, 199);
        foreign.project_path = "/other".into();
        let candidates = vec![candidate(1, 184), candidate(2, 192), foreign];
        let compartments: Vec<SeedCompartment> = serde_json::from_value(json!([
            {"sessionId":"s2","sequence":1,"startMessage":0,"title":"before","p1":"prior","content":null},
            {"sessionId":"s2","sequence":2,"startMessage":1,"title":"origin","p1":"summary","content":null},
            {"sessionId":"s2","sequence":3,"startMessage":4,"title":"after","p1":null,"content":"next"}
        ])).unwrap();
        let mut raw = vec![
            OrientationMessage {
                session_id: "s2".into(),
                ordinal: 1,
                user_text: Some("Where is routing?".into()),
                tool_summaries: Vec::new(),
            },
            OrientationMessage {
                session_id: "s2".into(),
                ordinal: 2,
                user_text: None,
                tool_summaries: vec!["TC: read src/routes.rs".into()],
            },
        ];
        let expected = json!({"kind":"raw","orientation":"U: Where is routing?\nTC: read src/routes.rs","prePost":"- (before) before: prior\n- (after) after: next","sessionId":"s2"});
        assert_eq!(
            serde_json::to_value(build_seed(
                &p,
                &candidates,
                Some(&raw),
                &compartments,
                str::len
            ))
            .unwrap(),
            expected
        );
        let expected = json!({"kind":"closed-book","orientation":"origin: summary","prePost":"- (before) before: prior\n- (after) after: next","sessionId":"s2"});
        assert_eq!(
            serde_json::to_value(build_seed(&p, &candidates, None, &compartments, str::len))
                .unwrap(),
            expected
        );
        raw[0].user_text = Some("x".repeat(4100));
        let seed = build_seed(&p, &candidates, Some(&raw), &compartments, str::len);
        assert_eq!(
            seed.orientation,
            format!(
                "U: {}\n… (orientation truncated; investigate the current source directly)",
                "x".repeat(4100)
            )
        );
    }
}
