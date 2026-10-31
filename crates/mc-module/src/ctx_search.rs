//! Model-visible search. Keep this collector separate from app/RPC retrieval:
//! their historical wire bytes and caller-supplied vectors are independent contracts.

use super::*;
use crate::embedding_provider::{QueryVector, Settings};
use crate::parity_contract::{
    Generation, ProjectId, RetrievalRequest, RetrievalSource, SessionId, StoreScope,
};
use crate::retrieval::hybrid::*;
use crate::retrieval_store::RetrievalStore;
use mc_store::retrieval_vectors::drain::Registration;
use rusqlite::{params, OptionalExtension};

const MESSAGE_FOOTER: &str = "Use ctx_expand(start, end) with the range from any message result above to read the conversation context. If the host no longer holds those messages, ctx_expand returns indexed text from the search archive only, with no surrounding messages or tool output.";

#[derive(Clone)]
enum Detail {
    Memory {
        id: i64,
        category: String,
        source: Option<String>,
        matched: MatchType,
    },
    Message {
        ordinal: i64,
        role: String,
    },
    Compartment {
        id: i64,
        start: i64,
        end: i64,
        title: String,
        matched: MatchType,
        snippet: Option<String>,
    },
    Git(mc_store::git_archive::GitCommitSearchHit),
    Primer {
        id: i64,
        support: i64,
        matched: MatchType,
    },
    Note {
        id: i64,
        status: String,
        created: i64,
        session: Option<String>,
        anchor: Option<i64>,
    },
}

#[derive(Clone)]
struct Hit {
    candidate: SearchCandidate,
    detail: Detail,
    document: String,
}

impl Hit {
    #[allow(clippy::too_many_arguments)]
    fn new(
        source: RetrievalSource,
        id: String,
        ordinal: Option<u64>,
        content: String,
        score: f64,
        detail: Detail,
        scope: &StoreScope,
        location: String,
        title: &str,
        body: &str,
    ) -> Self {
        Self {
            candidate: retrieval_candidate(source, id, ordinal, content, score, scope),
            detail,
            document: candidate_text(&location, title, body),
        }
    }
    fn score(&self) -> f64 {
        self.candidate.hit.score
    }
    fn key(&self) -> String {
        retrieval_key(&self.candidate)
    }
    fn boost(&self) -> f64 {
        match self.candidate.hit.source {
            RetrievalSource::Memory => 1.3,
            RetrievalSource::RawMessage | RetrievalSource::Compartment => 1.275,
            RetrievalSource::GitCommit => 1.2,
            RetrievalSource::Primer => 1.25,
            RetrievalSource::Note => 1.0,
        }
    }
}

#[derive(Default)]
struct Collected {
    baseline: Vec<Hit>,
    lanes: [Vec<Hit>; 9],
    visible: Vec<i64>,
    tail_matches: usize,
    no_git: bool,
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn search(
    handler: &McHandler,
    store: &McStore,
    facade: &FacadeScope,
    query: &str,
    limit: usize,
    sources: FacadeSearchSources,
    dates: DateBounds,
    visible: &BTreeSet<i64>,
) -> Result<String, String> {
    let settings = handler
        .config
        .lock()
        .unwrap()
        .search_providers_for_project(Path::new(&facade.route_project_root));
    let scope = StoreScope {
        project: ProjectId(facade.memory_project_path.clone()),
        session: SessionId(facade.conversation_key.clone()),
        generation: Generation(0),
    };
    let identity = RerankIdentity::new(
        facade.route_project_root.clone(),
        facade.conversation_key.clone(),
    );
    let before = registration(store, &scope.project.0)?;
    let vector = if sources.message
        || sources.git_commit
        || (facade.memory_enabled && (sources.memory || sources.primer))
    {
        if let Some(registration) = before.as_ref() {
            settings
                .query(
                    handler.search_io.clone(),
                    registration,
                    &scope,
                    &identity,
                    query,
                )
                .await
        } else {
            None
        }
    } else {
        None
    };
    // Provider calls never hold a SQLite lock. A concurrent provider/config switch
    // cannot attach an old query vector to newly registered stored vectors.
    let vector = vector.filter(|v| {
        registration(store, &scope.project.0)
            .ok()
            .flatten()
            .as_ref()
            == Some(&v.registration)
    });
    let cutoff = store.with_context_read(|db| db.query_row("SELECT COALESCE(MAX(end_message),0) FROM compartments WHERE session_id=? AND rebase_status!='unresolved'",[&scope.session.0],|r|r.get::<_,i64>(0))).map_err(|e|e.to_string())?.max(0);
    let mut collected = collect(
        store,
        &scope,
        query,
        limit,
        sources,
        dates,
        visible,
        facade.memory_enabled,
        cutoff,
        vector.as_ref(),
        &settings,
    )?;
    collected.no_git = sources.git_commit
        && !Path::new(&facade.route_project_root)
            .ancestors()
            .any(|p| p.join(".git").exists());
    collected.baseline.truncate(limit);
    let mut suffix = None;
    if settings.rerank_enabled() && is_prose_query(query) {
        let lane = |index: usize| {
            collected.lanes[index]
                .iter()
                .map(|h| h.candidate.clone())
                .collect()
        };
        let lanes = SearchLanes {
            memory_fts: lane(0),
            memory_vector: lane(1),
            primer_fts: lane(2),
            primer_vector: lane(3),
            message_fts: lane(4),
            chunk_vector: lane(5),
            git_fts: lane(6),
            git_vector: lane(7),
            notes: lane(8),
        };
        let pool = fuse_search_lanes(&lanes)
            .into_iter()
            .take(settings.rerank_limit())
            .collect::<Vec<_>>();
        let hits = pool
            .iter()
            .map(|c| {
                collected
                    .lanes
                    .iter()
                    .flatten()
                    .find(|h| h.candidate == *c)
                    .cloned()
            })
            .collect::<Option<Vec<_>>>();
        if let Some(hits) = hits.filter(|h| !h.is_empty()) {
            let documents = hits.iter().map(|h| h.document.clone()).collect::<Vec<_>>();
            let (order, skipped) = settings
                .rerank(handler.search_io.as_ref(), &identity, query, &documents)
                .await;
            suffix = skipped;
            if let Some(order) = order {
                collected.baseline = order
                    .into_iter()
                    .take(limit)
                    .map(|i| hits[i].clone())
                    .collect();
            }
        }
    }
    let mut output = render(query, &collected, &scope.session.0, !facade.tools_only);
    if let Some(suffix) = suffix {
        output.push('\n');
        output.push_str(&suffix);
    }
    Ok(output)
}

fn registration(store: &McStore, project: &str) -> Result<Option<Registration>, String> {
    store.with_context_read(|db| db.query_row(
        "SELECT model_id,chunk_model_id,fingerprint,table_epoch,dims,generation FROM embedding_registrations WHERE project_path=?",
        [project],|r| Ok(Registration {project:project.into(),model_id:r.get(0)?,chunk_model_id:r.get(1)?,fingerprint:r.get(2)?,table_epoch:r.get(3)?,dimensions:r.get(4)?,generation:r.get(5)?}),
    ).optional()).map_err(|e| e.to_string())
}

#[allow(clippy::too_many_arguments)]
fn collect(
    store: &McStore,
    scope: &StoreScope,
    query: &str,
    limit: usize,
    sources: FacadeSearchSources,
    dates: DateBounds,
    visible: &BTreeSet<i64>,
    memory_enabled: bool,
    cutoff: i64,
    vector: Option<&QueryVector>,
    settings: &Settings,
) -> Result<Collected, String> {
    let mut out = Collected::default();
    let adapter = RetrievalStore {
        store,
        now_ms: now_ms(),
    };
    let tier = (limit * 3).max(10);
    let request = RetrievalRequest {
        query: query.into(),
        intent: parity_contract::RetrievalIntent::Explicit,
        limit: limit as u32,
        start_at_ms: dates.from_ms,
        end_at_ms_inclusive: dates.to_ms,
        ordinal_cutoff: None,
        visible_memory_ids: Vec::new(),
        embedding: None,
    };
    let identity = vector.map(|v| parity_contract::EmbeddingIdentity {
        provider: "registered".into(),
        model: v.registration.model_id.clone(),
        dimensions: v.registration.dimensions as u32,
        query_recipe: String::new(),
        passage_recipe: String::new(),
        fingerprint: v.registration.fingerprint.clone(),
        epoch: v.registration.table_epoch as u64,
    });
    let query_vector = identity
        .as_ref()
        .zip(vector)
        .map(|(id, v)| (id, v.values.as_slice()));
    if memory_enabled && sources.memory {
        let memories = retrieval_values(
            adapter.read_search_memories(scope, dates),
            "memory",
            &mut Default::default(),
        );
        let fts = retrieval_values(
            adapter.search_memory_fts(scope, query, dates, 50),
            "memory",
            &mut Default::default(),
        );
        let vectors = identity
            .as_ref()
            .map(|id| {
                retrieval_values(
                    adapter.read_memory_vectors(
                        scope,
                        &memories.iter().map(|m| m.id).collect::<Vec<_>>(),
                        id,
                    ),
                    "memory",
                    &mut Default::default(),
                )
            })
            .unwrap_or_default();
        let (ranked, suppressed) = rank_memories(
            &memories,
            &fts,
            &vectors,
            query_vector,
            visible,
            dates,
            tier,
        );
        out.visible = suppressed;
        let convert = |h: MemoryHit| {
            let row = memories.iter().find(|m| m.id == h.memory_id).unwrap();
            Hit::new(
                RetrievalSource::Memory,
                h.memory_id.to_string(),
                None,
                h.content,
                h.score,
                Detail::Memory {
                    id: h.memory_id,
                    category: h.category,
                    source: h.source_name,
                    matched: h.match_type,
                },
                scope,
                format!("memory {} {}", row.id, scope.project.0),
                row.content.lines().next().unwrap_or_default(),
                &row.content,
            )
        };
        out.baseline.extend(ranked.into_iter().map(convert));
        out.lanes[0] = rank_memories(&memories, &fts, &[], None, visible, dates, 25)
            .0
            .into_iter()
            .map(convert)
            .collect();
        out.lanes[1] = rank_memories(&memories, &[], &vectors, query_vector, visible, dates, 25)
            .0
            .into_iter()
            .map(convert)
            .collect();
    }
    if memory_enabled && sources.primer {
        collect_primers(store, scope, query, dates, tier, vector, &mut out)?;
    }
    if sources.message {
        collect_messages(
            store, &adapter, scope, query, dates, tier, cutoff, vector, settings, &mut out,
        )?;
    }
    if sources.git_commit && settings.git_enabled {
        let results = retrieval_values(
            adapter.git_commits(scope, &request, query_vector, tier),
            "git_commit",
            &mut Default::default(),
        );
        let convert = |h: mc_store::git_archive::GitCommitSearchHit| {
            let c = &h.commit;
            Hit::new(
                RetrievalSource::GitCommit,
                c.sha.clone(),
                None,
                preview(&c.message),
                h.score,
                Detail::Git(h.clone()),
                scope,
                format!("git_commit {} {}", c.sha, scope.project.0),
                &format!(
                    "{} {}",
                    c.short_sha,
                    c.message.lines().next().unwrap_or_default()
                ),
                &c.message,
            )
        };
        out.baseline.extend(results.hits.into_iter().map(convert));
        out.lanes[6] = results.fts.into_iter().map(convert).collect();
        out.lanes[7] = results.vector.into_iter().map(convert).collect();
    }
    if sources.note {
        let probes = literal_probes(parity_contract::RetrievalIntent::Explicit, query);
        let (hits, rows) = retrieval_values(
            adapter.notes(scope, &request, &probes, tier.max(25)),
            "note",
            &mut Default::default(),
        );
        let convert = |h: crate::retrieval::note_ranking::NoteHit| {
            let row = rows.iter().find(|r| r.id == h.note_id).unwrap();
            let body = format!(
                "{}{}",
                row.content,
                row.ready_reason
                    .as_deref()
                    .filter(|s| !s.is_empty())
                    .map(|s| format!("\nReason: {s}"))
                    .unwrap_or_default()
            );
            Hit::new(
                RetrievalSource::Note,
                h.note_id.to_string(),
                h.anchor_ordinal.and_then(|o| u64::try_from(o).ok()),
                h.content,
                h.score,
                Detail::Note {
                    id: row.id,
                    status: format!("{:?}", row.status).to_lowercase(),
                    created: row.created_at,
                    session: row.session_id.clone(),
                    anchor: row.anchor_ordinal,
                },
                scope,
                format!("note {} {}", row.id, scope.project.0),
                body.lines().next().unwrap_or_default(),
                &body,
            )
        };
        let hits = hits.into_iter().map(convert).collect::<Vec<_>>();
        out.lanes[8] = hits.iter().take(25).cloned().collect();
        out.baseline.extend(hits.into_iter().take(tier));
    }
    out.baseline.sort_by(|a, b| {
        (b.score() * b.boost())
            .total_cmp(&(a.score() * a.boost()))
            .then_with(|| tie(a, b))
    });
    Ok(out)
}

fn tie(a: &Hit, b: &Hit) -> std::cmp::Ordering {
    match (&a.detail, &b.detail) {
        (Detail::Memory { id: a, .. }, Detail::Memory { id: b, .. }) => a.cmp(b),
        (Detail::Message { ordinal: a, .. }, Detail::Message { ordinal: b, .. }) => a.cmp(b),
        (Detail::Compartment { start: a, .. }, Detail::Compartment { start: b, .. }) => a.cmp(b),
        (
            Detail::Primer {
                id: a, support: sa, ..
            },
            Detail::Primer {
                id: b, support: sb, ..
            },
        ) => sb.cmp(sa).then(a.cmp(b)),
        (Detail::Git(a), Detail::Git(b)) => b.commit.committed_at_ms.cmp(&a.commit.committed_at_ms),
        (
            Detail::Note {
                id: a, created: ca, ..
            },
            Detail::Note {
                id: b, created: cb, ..
            },
        ) => cb.cmp(ca).then(a.cmp(b)),
        _ => std::cmp::Ordering::Equal,
    }
}

fn decode(blob: &[u8]) -> Option<Vec<f32>> {
    if blob.is_empty() || !blob.len().is_multiple_of(4) {
        return None;
    }
    let values = blob
        .as_chunks::<4>()
        .0
        .iter()
        .map(|c| f32::from_le_bytes(*c))
        .collect::<Vec<_>>();
    values.iter().all(|v| v.is_finite()).then_some(values)
}

#[allow(clippy::too_many_arguments)]
fn collect_primers(
    store: &McStore,
    scope: &StoreScope,
    query: &str,
    dates: DateBounds,
    tier: usize,
    vector: Option<&QueryVector>,
    out: &mut Collected,
) -> Result<(), String> {
    store.with_context_read(|db| {
        let mut stmt = db.prepare("SELECT id,question,answer,total_support,question_embedding,question_embedding_model_id FROM primers WHERE project_path=? AND status='active' AND (?2 IS NULL OR created_at>=?2) AND (?3 IS NULL OR created_at<=?3) ORDER BY id")?;
        let rows = stmt.query_map(params![scope.project.0,dates.from_ms,dates.to_ms],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,i64>(3)?,r.get::<_,Option<Vec<u8>>>(4)?,r.get::<_,Option<String>>(5)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
        let mut stmt = db.prepare("SELECT p.id FROM primers_fts JOIN primers p ON p.id=primers_fts.rowid WHERE primers_fts MATCH ?1 AND p.project_path=?2 AND p.status='active' AND (?3 IS NULL OR p.created_at>=?3) AND (?4 IS NULL OR p.created_at<=?4) ORDER BY bm25(primers_fts) LIMIT ?5")?;
        let fts_query = crate::retrieval_store::fts_query(query);
        let fts = if fts_query.is_empty() { Vec::new() } else {
            stmt.query_map(params![fts_query,scope.project.0,dates.from_ms,dates.to_ms,(tier*3).max(225) as i64],|r|r.get::<_,i64>(0))?.collect::<rusqlite::Result<Vec<_>>>()?
        };
        let baseline_fts_count = fts.len().min(tier*3);
        let mut baseline = Vec::new();
        for (id,question,answer,support,blob,model) in rows {
            let body = if answer.trim().is_empty() {format!("Q: {question}")} else {format!("Q: {question}\nA: {}",answer.trim())};
            let make = |score, matched| Hit::new(RetrievalSource::Primer,id.to_string(),None,preview(&body),score,Detail::Primer{id,support,matched},scope,format!("primer {id} {}",scope.project.0),&question,&body);
            let rank = fts.iter().position(|&v|v == id);
            if let Some(rank) = rank.filter(|&r|r < 25) {out.lanes[2].push(make(1.0-rank as f64/fts.len() as f64,MatchType::Fts));}
            let fts = rank.filter(|&r|r < baseline_fts_count).map_or(0.0,|r|1.0-r as f64/baseline_fts_count as f64);
            let semantic = vector.filter(|v|model.as_deref() == Some(v.registration.model_id.as_str())).zip(blob.as_deref().and_then(decode)).map_or(0.0,|(v,stored)|cosine_score(&v.values,&stored));
            if semantic > 0.0 { out.lanes[3].push(make(semantic,MatchType::Semantic)); }
            if semantic > 0.0 || fts > 0.0 {
                baseline.push(make(if semantic > 0.0 && fts > 0.0 {0.7*semantic+0.3*fts} else {semantic.max(fts)},if semantic > 0.0 && fts > 0.0 {MatchType::Hybrid} else if semantic > 0.0 {MatchType::Semantic} else {MatchType::Fts}));
            }
        }
        let sort = |hits: &mut Vec<Hit>| hits.sort_by(|a,b|b.score().total_cmp(&a.score()).then_with(||tie(a,b)));
        sort(&mut baseline); sort(&mut out.lanes[2]); sort(&mut out.lanes[3]);
        out.lanes[2].truncate(25);out.lanes[3].truncate(25);
        out.baseline.extend(baseline.into_iter().take(tier));
        Ok(())
    }).map_err(|e|e.to_string())
}

#[allow(clippy::too_many_arguments)]
fn collect_messages(
    store: &McStore,
    adapter: &RetrievalStore<'_>,
    scope: &StoreScope,
    query: &str,
    dates: DateBounds,
    tier: usize,
    cutoff: i64,
    vector: Option<&QueryVector>,
    settings: &Settings,
    out: &mut Collected,
) -> Result<(), String> {
    let probes = literal_probes(parity_contract::RetrievalIntent::Explicit, query);
    let mut rows = retrieval_values(
        adapter.raw_messages(scope, query, dates, cutoff, 75, probes.is_empty()),
        "raw_message",
        &mut Default::default(),
    );
    out.tail_matches = store.with_context_read(|db| {
        let fts = crate::retrieval_store::fts_query(query);
        if fts.is_empty() { return Ok(0); }
        db.query_row("SELECT COUNT(*) FROM message_history_fts f JOIN message_fts_rowid_map m ON m.fts_rowid=f.rowid WHERE f.session_id=?1 AND message_history_fts MATCH ?2 AND m.message_ordinal>?3 AND (?4 IS NULL OR m.message_time_ms>=?4) AND (?5 IS NULL OR m.message_time_ms<=?5)",params![scope.session.0,format!("content : ({fts})"),cutoff,dates.from_ms,dates.to_ms],|r|r.get(0))
    }).map_err(|e|e.to_string())?;
    let make = |row: &mc_store::archive_index::FtsRow, score| {
        Hit::new(
            RetrievalSource::RawMessage,
            row.id.clone(),
            Some(row.ordinal as u64),
            matched_snippet(&row.content, query),
            score,
            Detail::Message {
                ordinal: row.ordinal,
                role: row.role.clone(),
            },
            scope,
            format!("message {} {} @{}", row.id, scope.session.0, row.ordinal),
            &format!(
                "{}: {}",
                row.role,
                row.content.lines().next().unwrap_or_default()
            ),
            &row.content,
        )
    };
    let candidates = rows
        .iter()
        .enumerate()
        .map(|(i, r)| make(r, 1.0 - i as f64 / rows.len() as f64))
        .collect::<Vec<_>>();
    let mut ranked = candidates
        .iter()
        .map(|h| h.candidate.hit.clone())
        .collect::<Vec<_>>();
    for hit in &mut ranked {
        if let Some(row) = rows.iter().find(|r| r.id == hit.source_id) {
            hit.text = row.content.clone();
        }
    }
    if !probes.is_empty() {
        let corpus = retrieval_values(
            adapter.corpus_size(scope, cutoff),
            "raw_message",
            &mut Default::default(),
        );
        let matches = probes
            .iter()
            .map(|p| {
                let found = retrieval_values(
                    adapter.raw_messages(scope, p, dates, cutoff, 75, false),
                    "raw_message",
                    &mut Default::default(),
                );
                let hits = found
                    .iter()
                    .map(|r| {
                        let mut hit = make(r, 0.0).candidate.hit;
                        hit.text = r.content.clone();
                        hit
                    })
                    .collect();
                rows.extend(found);
                ProbeMatches {
                    probe: p.clone(),
                    document_frequency: retrieval_values(
                        adapter.probe_frequency(scope, p, dates, cutoff),
                        "raw_message",
                        &mut Default::default(),
                    ),
                    hits,
                }
            })
            .collect::<Vec<_>>();
        ranked = rank_message_probes(&ranked, &matches, corpus, 75, tier.max(25));
    }
    let render = |count: usize| {
        let count = count.min(ranked.len());
        ranked
            .iter()
            .take(count)
            .enumerate()
            .filter_map(|(i, h)| {
                rows.iter()
                    .find(|r| r.id == h.source_id)
                    .map(|r| make(r, 1.0 - i as f64 / count as f64))
            })
            .collect::<Vec<_>>()
    };
    out.lanes[4] = render(25);
    let messages = render(tier);
    let mut compartments = Vec::new();
    if let Some((vector, model)) = vector.and_then(|v| v.chunk_model(settings).map(|m| (v, m))) {
        let identity = parity_contract::EmbeddingIdentity {
            provider: "registered".into(),
            model: model.into(),
            dimensions: vector.values.len() as u32,
            query_recipe: String::new(),
            passage_recipe: String::new(),
            fingerprint: vector.registration.fingerprint.clone(),
            epoch: vector.registration.table_epoch as u64,
        };
        let chunks = retrieval_values(
            adapter.read_compartment_chunks(scope, dates, &identity),
            "compartment",
            &mut Default::default(),
        );
        for h in crate::retrieval::compartments::rank_compartments(
            &chunks,
            scope,
            &identity,
            &vector.values,
            dates,
            Some(cutoff),
            tier.max(25),
        ) {
            let body = retrieval_values(
                adapter.compartment_text(scope, h.start_ordinal, h.end_ordinal),
                "compartment",
                &mut Default::default(),
            );
            let mut hit = Hit::new(
                RetrievalSource::Compartment,
                h.compartment_id.to_string(),
                Some(h.start_ordinal as u64),
                h.content,
                h.score,
                Detail::Compartment {
                    id: h.compartment_id,
                    start: h.start_ordinal,
                    end: h.end_ordinal,
                    title: h.title.clone(),
                    matched: MatchType::Semantic,
                    snippet: None,
                },
                scope,
                format!(
                    "compartment {} {} @{}-{}",
                    h.compartment_id, scope.session.0, h.start_ordinal, h.end_ordinal
                ),
                &h.title,
                &body,
            );
            hit.candidate.compartment_range = Some((h.start_ordinal as u64, h.end_ordinal as u64));
            compartments.push(hit);
        }
        out.lanes[5] = compartments.iter().take(25).cloned().collect();
        compartments.truncate(tier);
    }
    out.baseline
        .extend(merge_messages(messages, compartments, tier));
    Ok(())
}

fn merge_messages(messages: Vec<Hit>, compartments: Vec<Hit>, limit: usize) -> Vec<Hit> {
    if messages.is_empty() {
        return compartments;
    }
    if compartments.is_empty() {
        return messages;
    }
    let mut fused = compartments
        .iter()
        .enumerate()
        .map(|(rank, c)| (c.clone(), 1.0 / (60 + rank) as f64))
        .collect::<Vec<_>>();
    for (rank, message) in messages.into_iter().enumerate() {
        let containing = message.candidate.hit.ordinal.and_then(|o| {
            compartments.iter().find(|c| {
                c.candidate
                    .compartment_range
                    .is_some_and(|(start, end)| o.value >= start && o.value <= end)
            })
        });
        let key = containing.unwrap_or(&message).key();
        if let Some((hit, score)) = fused.iter_mut().find(|(h, _)| h.key() == key) {
            *score += 1.0 / (60 + rank) as f64;
            if let Detail::Compartment {
                matched, snippet, ..
            } = &mut hit.detail
            {
                if snippet.is_none() {
                    *snippet = Some(message.candidate.hit.text.clone());
                    *matched = MatchType::Hybrid;
                }
            }
        } else {
            fused.push((message, 1.0 / (60 + rank) as f64));
        }
    }
    fused.sort_by(|(a, sa), (b, sb)| sb.total_cmp(sa).then_with(|| tie(a, b)));
    // Reciprocal rank fusion determines ordering, not reported relevance. Keep
    // the original scores rather than promoting a weak match to perfect relevance.
    fused.into_iter().take(limit).map(|(h, _)| h).collect()
}

fn matched_snippet(content: &str, query: &str) -> String {
    let mut cleaned = String::new();
    let tags =
        regex::Regex::new(r"(?i)<(/?)(system-reminder|task|task_cohort)(?:\s[^<>]*?)?\s*(/?)>")
            .unwrap();
    let mut stack = Vec::new();
    let mut cursor = 0;
    for captures in tags.captures_iter(content) {
        let tag = captures.get(0).unwrap();
        let name = captures[2].to_lowercase();
        if stack.is_empty() {
            cleaned.push_str(&content[cursor..tag.start()]);
        }
        if &captures[1] == "/" {
            if stack.last() == Some(&name) {
                stack.pop();
            }
        } else if &captures[3] != "/" {
            stack.push(name);
        }
        cursor = tag.end();
    }
    if stack.is_empty() {
        cleaned.push_str(&content[cursor..]);
    }
    let cleaned = regex::Regex::new(r"[\s\u{feff}]+")
        .unwrap()
        .replace_all(&cleaned, " ")
        .trim()
        .to_owned();
    let tokens = regex::Regex::new(r"[\p{L}\p{N}_]+").unwrap();
    let stop = "a an and are as at be been by can could did do does for from how i in is it me my of on or our please should that the their them there these they this to us was we were what when where which who why will with would you your".split(' ').collect::<BTreeSet<_>>();
    let query = query.to_lowercase();
    let terms = tokens
        .find_iter(&query)
        .map(|m| m.as_str())
        .filter(|s| !stop.contains(s))
        .collect::<BTreeSet<_>>();
    let matches = tokens
        .find_iter(&cleaned)
        .filter(|m| terms.contains(m.as_str().to_lowercase().as_str()))
        .map(|m| cleaned[..m.start()].encode_utf16().count())
        .collect::<Vec<_>>();
    if matches.is_empty() {
        return preview(content);
    }
    let utf16 = cleaned.encode_utf16().collect::<Vec<_>>();
    let mut best = (matches[0], 0usize);
    for position in &matches {
        let start = position.saturating_sub(44);
        let slice =
            String::from_utf16_lossy(&utf16[start..(start + 220).min(utf16.len())]).to_lowercase();
        let words = tokens
            .find_iter(&slice)
            .map(|m| m.as_str())
            .collect::<BTreeSet<_>>();
        let coverage = terms.intersection(&words).count();
        if coverage > best.1 {
            best = (start, coverage);
        }
    }
    let mut start = best.0;
    if start > 0 {
        if let Some(boundary) = utf16[start..]
            .iter()
            .position(|&c| c == 32)
            .map(|p| p + start)
            .filter(|p| *p < matches[matches.len() - 1])
        {
            start = boundary + 1;
        }
    }
    let end = (start + 220).min(utf16.len());
    format!(
        "{}{}{}",
        if start > 0 { "…" } else { "" },
        String::from_utf16_lossy(&utf16[start..end]).trim(),
        if end < utf16.len() { "…" } else { "" }
    )
}

fn match_name(m: MatchType) -> &'static str {
    match m {
        MatchType::Fts => "fts",
        MatchType::Semantic => "semantic",
        MatchType::Hybrid => "hybrid",
    }
}

fn render(query: &str, collected: &Collected, session: &str, history: bool) -> String {
    let mut body = Vec::new();
    let mut message = false;
    let mut anchored_note = false;
    for (i, hit) in collected.baseline.iter().enumerate() {
        let index = i + 1;
        let score = reported_score(hit.score());
        let mut content = hit.candidate.hit.text.clone();
        let header = match &hit.detail {
            Detail::Memory {
                id,
                category,
                source,
                matched,
            } => format!(
                "[{index}] [memory] score={score} id={id} category={category}{} match={}",
                source
                    .as_ref()
                    .map(|s| format!(" source={s}"))
                    .unwrap_or_default(),
                match_name(*matched)
            ),
            Detail::Message { ordinal, role } => {
                message = true;
                format!(
                    "[{index}] [message] score={score} ordinal={ordinal} range={}-{} role={role}",
                    1.max(ordinal - 3),
                    ordinal + 3
                )
            }
            Detail::Compartment {
                id,
                start,
                end,
                title,
                matched,
                snippet,
            } => {
                message = true;
                if let Some(snippet) = snippet {
                    content = format!("Snippet: {snippet}");
                }
                format!("[{index}] [message] score={score} compartment_id={id} range={start}-{end} match={} title={title}",match_name(*matched))
            }
            Detail::Git(h) => format!(
                "[{index}] [git_commit] score={score} sha={} {} match={}",
                h.commit.short_sha,
                format_search_age(h.commit.committed_at_ms),
                match h.match_type {
                    mc_store::git_archive::MatchType::Fts => "fts",
                    mc_store::git_archive::MatchType::Semantic => "semantic",
                    mc_store::git_archive::MatchType::Hybrid => "hybrid",
                }
            ),
            Detail::Primer {
                id,
                support,
                matched,
            } => format!(
                "[{index}] [primer] score={score} id={id} support={support} match={}",
                match_name(*matched)
            ),
            Detail::Note {
                id,
                status,
                created,
                session: source,
                anchor,
            } => {
                let anchor = anchor
                    .filter(|_| source.as_deref() == Some(session))
                    .map(|o| format!(" @msg {o}"));
                anchored_note |= anchor.is_some();
                format!(
                    "[{index}] [note] score={score} id=#{id} status={status} {}{}",
                    format_search_age(*created),
                    anchor.unwrap_or_default()
                )
            }
        };
        body.push(format!("{header}\n{content}"));
    }
    let has_memories = collected
        .baseline
        .iter()
        .any(|h| matches!(h.detail, Detail::Memory { .. }));
    let count = collected.visible.len();
    if count > 0 {
        let noun = if count == 1 { "match" } else { "matches" };
        let ids = join_i64s(&collected.visible);
        body.push(if has_memories {format!("Memories: {count} additional {noun} suppressed because {} already visible in your project-memory block (ids {ids}).",if count==1 {"it is"} else {"they are"})}
        else {format!("Memories: {count} {noun} found, all already visible in your project-memory block (ids {ids}).")});
    }
    if collected.tail_matches > 0 {
        let n = collected.tail_matches;
        body.push(format!("Message history: {n} raw-message {} newer than the last compartment boundary (already in your context).",if n==1 {"match is"} else {"matches are"}));
    }
    if collected.no_git {
        body.push(
            "Git commits: no git repository — commit search unavailable for this project.".into(),
        );
    }
    let count = collected.baseline.len();
    if count == 0 {
        return if body.is_empty() {
            format!("No results found for \"{query}\" across notes, memories, primers, git commits, or message history.")
        } else {
            format!(
                "No hidden results found for \"{query}\".\n\n{}",
                body.join("\n\n")
            )
        };
    }
    if history && message {
        body.push(MESSAGE_FOOTER.into());
    }
    if history && anchored_note {
        body.push("Use ctx_expand(start=N-10, end=N) around any note @msg anchor above to read the surrounding conversation context.".into());
    }
    format!(
        "Found {count} result{} for \"{query}\":\n\n{}",
        if count == 1 { "" } else { "s" },
        body.join("\n\n")
    )
}
