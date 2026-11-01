//! Semantic compressed-history lane. Titles are previews, not lexical candidates.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::hybrid::{cosine_score, preview, DateBounds, MatchType, SINGLE_SOURCE_PENALTY};
use crate::parity_contract::{EmbeddingIdentity, StoreScope};

#[derive(Debug, Clone)]
pub struct CompartmentChunk {
    pub compartment_id: i64,
    pub session_id: String,
    pub project_path: String,
    pub title: String,
    /// Bounds of the whole compartment, not the individual embedding window.
    pub start_ordinal: i64,
    pub end_ordinal: i64,
    /// Persisted times of the compartment's first and last messages. Dated
    /// searches exclude ranges without both authoritative endpoint mappings.
    pub start_time_ms: Option<i64>,
    pub end_time_ms: Option<i64>,
    pub identity: EmbeddingIdentity,
    pub values: Vec<f32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompartmentHit {
    pub content: String,
    pub score: f64,
    pub compartment_id: i64,
    pub session_id: String,
    pub title: String,
    pub start_ordinal: i64,
    pub end_ordinal: i64,
    pub match_type: MatchType,
}

pub fn rank_compartments(
    chunks: &[CompartmentChunk],
    scope: &StoreScope,
    identity: &EmbeddingIdentity,
    query: &[f32],
    dates: DateBounds,
    max_ordinal: Option<i64>,
    limit: usize,
) -> Vec<CompartmentHit> {
    let cutoff = max_ordinal.filter(|n| *n >= 0);
    // Preserve first-seen chunk and compartment order on exact ties, as a stable
    // sort over the store's ordered rows does. HashMap iteration cannot do that.
    let mut indexes: HashMap<i64, usize> = HashMap::new();
    let mut best: Vec<(&CompartmentChunk, f64)> = Vec::new();
    for chunk in chunks {
        if chunk.session_id != scope.session.0
            || chunk.project_path != scope.project.0
            || &chunk.identity != identity
            || !overlaps_dates(chunk, dates)
            || chunk.values.len() != identity.dimensions as usize
            || cutoff.is_some_and(|cutoff| chunk.end_ordinal > cutoff)
        {
            continue;
        }
        let score = cosine_score(query, &chunk.values);
        if score <= 0.0 {
            continue;
        }
        if let Some(&index) = indexes.get(&chunk.compartment_id) {
            if score > best[index].1 {
                best[index] = (chunk, score);
            }
        } else {
            indexes.insert(chunk.compartment_id, best.len());
            best.push((chunk, score));
        }
    }
    best.sort_by(|(a, sa), (b, sb)| sb.total_cmp(sa).then(a.start_ordinal.cmp(&b.start_ordinal)));
    best.truncate(limit);
    best.into_iter()
        .map(|(chunk, score)| CompartmentHit {
            content: preview(&chunk.title),
            score: score * SINGLE_SOURCE_PENALTY,
            compartment_id: chunk.compartment_id,
            session_id: chunk.session_id.clone(),
            title: chunk.title.clone(),
            start_ordinal: chunk.start_ordinal,
            end_ordinal: chunk.end_ordinal,
            match_type: MatchType::Semantic,
        })
        .collect()
}

fn overlaps_dates(chunk: &CompartmentChunk, dates: DateBounds) -> bool {
    if dates.from_ms.is_none() && dates.to_ms.is_none() {
        return true;
    }
    match (chunk.start_time_ms, chunk.end_time_ms) {
        (Some(start), Some(end)) => {
            dates.to_ms.is_none_or(|to| start <= to) && dates.from_ms.is_none_or(|from| end >= from)
        }
        _ => false,
    }
}
