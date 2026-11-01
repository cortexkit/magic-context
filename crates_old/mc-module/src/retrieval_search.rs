//! Shared search orchestration; adapters handle reads and callers format replies.

use super::{ReadContext, RetrievalStore};
use crate::parity_contract::*;
use crate::retrieval::{self, hybrid::*};
use crate::{retrieval_candidate, retrieval_key, retrieval_merge_messages, retrieval_values};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};

pub(crate) struct PreparedSearch {
    pub baseline: Vec<SearchCandidate>,
    pub availability: BTreeMap<String, Availability>,
    probes: Vec<String>,
    lanes: SearchLanes,
    bodies: HashMap<String, String>,
    limit: usize,
}

pub(crate) fn collect<R: ReadContext>(
    adapter: &RetrievalStore<'_, R>,
    scope: &StoreScope,
    request: &RetrievalRequest,
    sources: &[RetrievalSource],
    vector: Option<&[f32]>,
) -> PreparedSearch {
    let app_limit = adapter.store.lexical().map(|s| s.limit());
    let limit = app_limit.unwrap_or(request.limit.clamp(1, 25) as usize);
    let tier_limit = app_limit.unwrap_or((limit * 3).max(10));
    let dates = DateBounds {
        from_ms: request.start_at_ms,
        to_ms: request.end_at_ms_inclusive,
    };
    let cutoff = request
        .ordinal_cutoff
        .map(|o| o.value as i64)
        .unwrap_or(i64::MAX);
    let mut availability = BTreeMap::new();
    let mut lanes = SearchLanes::default();
    let mut bodies = HashMap::<String, String>::new();
    let mut memory_hits = Vec::new();
    let mut raw_hits = Vec::new();
    let mut compartment_hits = Vec::new();
    let mut other_hits = Vec::new();
    let query_vector = request.embedding.as_ref().zip(vector).filter(|(id, v)| {
        !matches!(id.provider.as_str(), "local" | "transformers")
            && id.model != "off"
            && id.dimensions > 0
            && v.len() == id.dimensions as usize
            && v.iter().all(|v| v.is_finite())
    });
    let probes = literal_probes(request.intent, &request.query);
    let has = |source| sources.contains(&source);
    if has(RetrievalSource::Memory) {
        let memories = retrieval_values(
            adapter.read_search_memories(scope, dates),
            "memory",
            &mut availability,
        );
        let fts = retrieval_values(
            adapter.search_memory_fts(scope, &request.query, dates, FTS_CANDIDATE_LIMIT),
            "memory",
            &mut availability,
        );
        let visible = retrieval_values(
            adapter.read_visible_memory_ids(scope),
            "memory",
            &mut availability,
        )
        .into_iter()
        .chain(request.visible_memory_ids.iter().map(|v| *v as i64))
        .collect();
        let vectors = query_vector
            .map(|(id, _)| {
                retrieval_values(
                    adapter.read_memory_vectors(
                        scope,
                        &memories.iter().map(|m| m.id).collect::<Vec<_>>(),
                        id,
                    ),
                    "memory",
                    &mut availability,
                )
            })
            .unwrap_or_default();
        let (ranked, _) = rank_memories(
            &memories,
            &fts,
            &vectors,
            query_vector,
            &visible,
            dates,
            tier_limit.max(25),
        );
        for hit in ranked {
            let memory = memories
                .iter()
                .find(|m| m.id == hit.memory_id)
                .expect("ranked memory belongs to snapshot");
            let candidate = retrieval_candidate(
                RetrievalSource::Memory,
                hit.memory_id.to_string(),
                None,
                hit.content,
                hit.score,
                scope,
            );
            bodies.insert(
                retrieval_key(&candidate),
                candidate_text(
                    &format!("memory {} {}", hit.memory_id, scope.project.0),
                    memory.content.lines().next().unwrap_or_default(),
                    &memory.content,
                ),
            );
            memory_hits.push(candidate);
        }
        let convert = |hit: MemoryHit| {
            retrieval_candidate(
                RetrievalSource::Memory,
                hit.memory_id.to_string(),
                None,
                hit.content,
                hit.score,
                scope,
            )
        };
        lanes.memory_fts = rank_memories(&memories, &fts, &[], None, &visible, dates, 25)
            .0
            .into_iter()
            .map(convert)
            .collect();
        lanes.memory_vector =
            rank_memories(&memories, &[], &vectors, query_vector, &visible, dates, 25)
                .0
                .into_iter()
                .map(convert)
                .collect();
        for candidate in lanes.memory_fts.iter().chain(&lanes.memory_vector) {
            if let Some(memory) = memories
                .iter()
                .find(|m| m.id.to_string() == candidate.hit.source_id)
            {
                bodies.insert(
                    retrieval_key(candidate),
                    candidate_text(
                        &format!("memory {} {}", memory.id, scope.project.0),
                        memory.content.lines().next().unwrap_or_default(),
                        &memory.content,
                    ),
                );
            }
        }
        memory_hits.truncate(tier_limit);
    }
    if has(RetrievalSource::RawMessage) {
        let rows = retrieval_values(
            adapter.raw_messages(
                scope,
                &request.query,
                dates,
                cutoff,
                75,
                request.intent == RetrievalIntent::Explicit,
            ),
            "raw_message",
            &mut availability,
        );
        for (rank, row) in rows.iter().enumerate() {
            let candidate = retrieval_candidate(
                RetrievalSource::RawMessage,
                row.id.clone(),
                Some(row.ordinal as u64),
                row.content.clone(),
                1.0 - rank as f64 / rows.len() as f64,
                scope,
            );
            bodies.insert(
                retrieval_key(&candidate),
                candidate_text(
                    &format!("message {} {} @{}", row.id, scope.session.0, row.ordinal),
                    &format!(
                        "{}: {}",
                        row.role,
                        row.content.lines().next().unwrap_or_default()
                    ),
                    &row.content,
                ),
            );
            raw_hits.push(candidate);
        }
        if !probes.is_empty() {
            let corpus = retrieval_values(
                adapter.corpus_size(scope, cutoff),
                "raw_message",
                &mut availability,
            );
            let matches = probes
                .iter()
                .map(|probe| {
                    let rows = retrieval_values(
                        adapter.raw_messages(scope, probe, dates, cutoff, 75, true),
                        "raw_message",
                        &mut availability,
                    );
                    let hits = rows
                        .iter()
                        .map(|row| {
                            let c = retrieval_candidate(
                                RetrievalSource::RawMessage,
                                row.id.clone(),
                                Some(row.ordinal as u64),
                                row.content.clone(),
                                0.0,
                                scope,
                            );
                            bodies.insert(
                                retrieval_key(&c),
                                candidate_text(
                                    &format!(
                                        "message {} {} @{}",
                                        row.id, scope.session.0, row.ordinal
                                    ),
                                    &format!(
                                        "{}: {}",
                                        row.role,
                                        row.content.lines().next().unwrap_or_default()
                                    ),
                                    &row.content,
                                ),
                            );
                            c.hit
                        })
                        .collect();
                    ProbeMatches {
                        probe: probe.clone(),
                        document_frequency: retrieval_values(
                            adapter.probe_frequency(scope, probe, dates, cutoff),
                            "raw_message",
                            &mut availability,
                        ),
                        hits,
                    }
                })
                .collect::<Vec<_>>();
            raw_hits = rank_message_probes(
                &raw_hits.iter().map(|c| c.hit.clone()).collect::<Vec<_>>(),
                &matches,
                corpus,
                75,
                tier_limit.max(25),
            )
            .into_iter()
            .map(|hit| SearchCandidate {
                hit,
                compartment_range: None,
            })
            .collect();
        }
        lanes.message_fts = raw_hits
            .iter()
            .take(25)
            .cloned()
            .map(|mut c| {
                c.hit.text = preview(&c.hit.text);
                c
            })
            .collect();
        raw_hits.truncate(tier_limit);
        let count = raw_hits.len();
        for (rank, candidate) in raw_hits.iter_mut().enumerate() {
            candidate.hit.text = preview(&candidate.hit.text);
            candidate.hit.score = 1.0 - rank as f64 / count as f64;
        }
    }
    if has(RetrievalSource::Compartment) {
        if let Some((identity, vector)) = query_vector {
            let chunks = retrieval_values(
                adapter.read_compartment_chunks(scope, dates, identity),
                "compartment",
                &mut availability,
            );
            for hit in retrieval::compartments::rank_compartments(
                &chunks,
                scope,
                identity,
                vector,
                dates,
                Some(cutoff),
                tier_limit.max(25),
            ) {
                let mut candidate = retrieval_candidate(
                    RetrievalSource::Compartment,
                    hit.compartment_id.to_string(),
                    Some(hit.start_ordinal as u64),
                    hit.content,
                    hit.score,
                    scope,
                );
                candidate.compartment_range =
                    Some((hit.start_ordinal as u64, hit.end_ordinal as u64));
                let body = adapter.compartment_text(scope, hit.start_ordinal, hit.end_ordinal);
                if let CapabilityResult::Available { value: body }
                | CapabilityResult::Degraded { value: body, .. } = body
                {
                    bodies.insert(
                        retrieval_key(&candidate),
                        candidate_text(
                            &format!(
                                "compartment {} {} @{}-{}",
                                hit.compartment_id,
                                scope.session.0,
                                hit.start_ordinal,
                                hit.end_ordinal
                            ),
                            &hit.title,
                            &body,
                        ),
                    );
                }
                compartment_hits.push(candidate);
            }
            lanes.chunk_vector = compartment_hits.iter().take(25).cloned().collect();
            compartment_hits.truncate(tier_limit);
        } else {
            availability.insert(
                "compartment".into(),
                mc_store::parity_schema_manifest::unavailable("retrieval_lane"),
            );
        }
    }
    if has(RetrievalSource::GitCommit) {
        let result = retrieval_values(
            adapter.git_commits(scope, request, query_vector, tier_limit),
            "git_commit",
            &mut availability,
        );
        let convert = |hit: &mc_store::git_archive::GitCommitSearchHit| {
            retrieval_candidate(
                RetrievalSource::GitCommit,
                hit.commit.sha.clone(),
                None,
                preview(&hit.commit.message),
                hit.score,
                scope,
            )
        };
        for hit in result.hits.iter().chain(&result.fts).chain(&result.vector) {
            let candidate = convert(hit);
            bodies.insert(
                retrieval_key(&candidate),
                candidate_text(
                    &format!("git_commit {} {}", hit.commit.sha, scope.project.0),
                    &format!(
                        "{} {}",
                        hit.commit.short_sha,
                        hit.commit.message.lines().next().unwrap_or_default()
                    ),
                    &hit.commit.message,
                ),
            );
        }
        lanes.git_fts = result.fts.iter().map(convert).collect();
        lanes.git_vector = result.vector.iter().map(convert).collect();
        other_hits.extend(result.hits.iter().map(convert));
    }
    if has(RetrievalSource::Note) {
        let (hits, rows) = retrieval_values(
            adapter.notes(scope, request, &probes, tier_limit.max(25)),
            "note",
            &mut availability,
        );
        for hit in hits {
            let candidate = retrieval_candidate(
                RetrievalSource::Note,
                hit.note_id.to_string(),
                hit.anchor_ordinal.and_then(|o| u64::try_from(o).ok()),
                hit.content,
                hit.score,
                scope,
            );
            if let Some(row) = rows.iter().find(|r| r.id == hit.note_id) {
                let body = format!(
                    "{}{}",
                    row.content,
                    row.ready_reason
                        .as_deref()
                        .filter(|s| !s.is_empty())
                        .map(|s| format!("\nReason: {s}"))
                        .unwrap_or_default()
                );
                bodies.insert(
                    retrieval_key(&candidate),
                    candidate_text(
                        &format!("note {} {}", hit.note_id, scope.project.0),
                        body.lines().next().unwrap_or_default(),
                        &body,
                    ),
                );
            }
            lanes.notes.push(candidate.clone());
            other_hits.push(candidate);
        }
        lanes.notes.truncate(25);
    }
    if has(RetrievalSource::Primer) {
        availability.insert(
            "primer".into(),
            mc_store::parity_schema_manifest::unavailable("retrieval_lane"),
        );
    }
    let mut baseline = memory_hits;
    baseline.extend(retrieval_merge_messages(
        raw_hits,
        compartment_hits,
        tier_limit,
    ));
    baseline.extend(other_hits);
    baseline.sort_by(|a, b| {
        let boost = |c: &SearchCandidate| match c.hit.source {
            RetrievalSource::Memory => 1.3,
            RetrievalSource::RawMessage | RetrievalSource::Compartment => 1.275,
            RetrievalSource::GitCommit => 1.2,
            RetrievalSource::Primer => 1.25,
            RetrievalSource::Note => 1.0,
        };
        (b.hit.score * boost(b))
            .total_cmp(&(a.hit.score * boost(a)))
            .then_with(|| {
                if a.hit.source != b.hit.source {
                    return std::cmp::Ordering::Equal;
                }
                match a.hit.source {
                    RetrievalSource::Memory => a
                        .hit
                        .source_id
                        .parse::<i64>()
                        .unwrap_or_default()
                        .cmp(&b.hit.source_id.parse::<i64>().unwrap_or_default()),
                    RetrievalSource::RawMessage | RetrievalSource::Compartment => a
                        .hit
                        .ordinal
                        .map(|o| o.value)
                        .cmp(&b.hit.ordinal.map(|o| o.value)),
                    _ => std::cmp::Ordering::Equal,
                }
            })
    });
    baseline.truncate(limit);
    if request.query.is_empty() {
        baseline.clear();
    }
    PreparedSearch {
        baseline,
        availability,
        probes,
        lanes,
        bodies,
        limit,
    }
}

pub(crate) async fn finish(
    prepared: PreparedSearch,
    request: &RetrievalRequest,
    identity: RerankIdentity,
    reranker: Option<&dyn RerankClient>,
    capture_lanes: bool,
) -> Value {
    let PreparedSearch {
        baseline,
        availability,
        probes,
        lanes,
        bodies,
        limit,
    } = prepared;
    let pinned = prepare_reranker(request.intent, &request.query, reranker, &identity).await;
    let session = pinned.zip(reranker).map(|(lane, client)| RerankSession {
        client,
        lane,
        identity,
    });
    let pool = fuse_search_lanes(&lanes);
    let texts = pool
        .iter()
        .map(|c| bodies.get(&retrieval_key(c)).cloned())
        .collect::<Option<Vec<_>>>();
    let hits = if let Some(texts) = texts {
        rerank_search_results(
            request.intent,
            session.as_ref(),
            &request.query,
            &baseline,
            &pool,
            &texts,
            limit,
        )
        .await
    } else {
        baseline
    };
    let mut body = json!({"v":1,"hits":hits.into_iter().map(|c| c.hit).collect::<Vec<_>>(),"source_availability":availability,"literal_probes":probes});
    if capture_lanes {
        body["lanes"] = json!({"git_fts":lanes.git_fts.iter().map(|c| &c.hit).collect::<Vec<_>>(),"git_vector":lanes.git_vector.iter().map(|c| &c.hit).collect::<Vec<_>>()});
    }
    body
}
