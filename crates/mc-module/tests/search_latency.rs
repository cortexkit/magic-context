//! Where a `ctx_search` call spends its time on a store the size of the live
//! one, stage by stage, alone and next to other work on the same store.
//!
//! It is ignored because it first builds a store of several gigabytes. Run it
//! on Linux, in release mode, and read its report on standard output:
//!
//! ```text
//! cargo test --locked --release -p mc-module --test search_latency -- --ignored --nocapture
//! ```
//!
//! Add `--features context-db-timing` to also print how long upkeep held the
//! connection at each call site.
//!
//! Sizes default to the live store's counts on 2026-11-13: 2,025,399 indexed
//! messages averaging about 1,400 characters, a searched project with 5,244
//! memories of which 3,073 have 1,024-dimension vectors, 2,000 commits per
//! project with vectors (65,316 in all), and 29,499 history-chunk vectors.
//! `MC_LATENCY_MESSAGES` (indexed messages) and `MC_LATENCY_MEDIAN_WORDS`
//! (median words per message, default 130) shrink the message corpus for a
//! quick run. `MC_LATENCY_REPEATS` (default 2) sets how often each stage
//! runs. `MC_LATENCY_PROTOTYPE=0` skips building a second message index with
//! the session id searchable, which shows what a session-scoped match costs;
//! `MC_LATENCY_ROWID_MAP=1` also times matching through the session's rowid
//! map, which is slow on a large store.
//!
//! The store is written in large transactions, so its full-text index has
//! fewer segments than one built a message at a time; the live index's reads
//! can only be slower than the ones measured here.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::{Arc, Barrier};
use std::time::{Duration, Instant};

use mc_module::context_db::ContextDb;
use mc_module::search::{self, messages, sources, Scope};
use rusqlite::{params, Connection};
use serde_json::json;

const PROJECT: &str = "pj-searched";
const HARNESS: &str = "broca";
/// The model ids stored vectors carry; the query vector is compared only
/// with rows under the same ids, as with a configured provider.
const MODEL: &str = "embedding-provider:latency-harness";
const CHUNK_MODEL: &str = "embedding-provider:latency-harness:chunk:0000000000000000";
const DIMS: usize = 1024;
/// A long-running session: 3,000 indexed messages, the first 2,500 covered
/// by 100 summaries.
const LONG_SESSION: &str = "ses_long_running";
const LONG_MESSAGES: i64 = 3_000;
const LONG_SUMMARIZED: i64 = 2_500;
/// A session with nothing indexed yet, as any session is right after its
/// Setup.
const NEW_SESSION: &str = "ses_fresh";

const PROJECT_MEMORIES: usize = 5_244;
const PROJECT_MEMORY_VECTORS: usize = 3_073;
const OTHER_MEMORIES: usize = 30_000;
const COMMITS_PER_PROJECT: usize = 2_000;
const OTHER_COMMIT_PROJECTS: usize = 31;
const CHUNK_VECTORS: usize = 29_499;
const PRIMERS: usize = 300;

/// The queries measured: a prose question (reranked when a reranker is
/// configured), a shorter prose query, an identifier query (which takes the
/// literal-probe path) and one rare word.
const QUERIES: [&str; 4] = [
    "how does upkeep embed memories",
    "why is search slow after restart",
    "ContextDb with_connection",
    "upkeep",
];

/// A prompt as the automatic memory hint searches it on a person's message.
const PROMPT: &str = "The search tool got slow again after the restart this afternoon. \
    Can you check how upkeep embeds memories and whether the store connection is held \
    while the session waits, and tell me what to change first?";

fn env_usize(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .map(|value| value.replace('_', "").parse().expect(name))
        .unwrap_or(default)
}

/// splitmix64: a fixed seed gives the same store on every run.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }

    fn normal(&mut self) -> f64 {
        let first = self.unit().max(1e-12);
        let second = self.unit();
        (-2.0 * first.ln()).sqrt() * (std::f64::consts::TAU * second).cos()
    }

    fn vector(&mut self) -> Vec<f32> {
        let mut vector: Vec<f32> = (0..DIMS).map(|_| self.normal() as f32).collect();
        let norm = vector.iter().map(|x| x * x).sum::<f32>().sqrt();
        vector.iter_mut().for_each(|x| *x /= norm);
        vector
    }
}

/// English-like text: words drawn by a Zipf law over 60,000 ranks, the most
/// common ranks being real English and coding words, so that "the" is in
/// nearly every message and the query words are as common as their rank
/// makes them.
struct Vocabulary {
    words: Vec<String>,
    cdf: Vec<f64>,
}

const COMMON: &[&str] = &[
    "the", "to", "and", "a", "of", "i", "in", "is", "it", "that", "for", "this", "you", "be", "on",
    "with", "as", "not", "are", "we", "have", "can", "if", "or", "but", "at", "from", "by", "so",
    "an", "will", "do", "use", "was", "all", "there", "what", "file", "test", "how", "code", "run",
    "error", "does", "need", "now", "here", "one", "which", "should", "then", "just", "also",
    "when", "like", "new", "them", "get", "more", "set", "add", "our", "make", "check", "its",
    "no", "change", "data", "call", "update", "value", "line", "build", "read", "type", "out",
    "time", "function", "return", "first", "work", "fix", "see", "path", "into", "would", "only",
    "case", "state", "message", "after", "why", "because", "before", "where", "each", "other",
    "some", "than", "way", "any", "same",
];

/// Query words, placed at ranks that make them common, middling or rare.
const PLACED: &[(&str, usize)] = &[
    ("session", 120),
    ("search", 150),
    ("store", 200),
    ("memories", 350),
    ("connection", 500),
    ("slow", 900),
    ("embed", 1_500),
    ("restart", 2_200),
    ("latency", 3_500),
    ("upkeep", 5_000),
    ("contextdb", 9_000),
];

impl Vocabulary {
    fn new() -> Self {
        const SIZE: usize = 60_000;
        const EXPONENT: f64 = 1.07;
        let mut words: Vec<String> = (0..SIZE).map(|rank| format!("w{rank:05}")).collect();
        for (rank, word) in COMMON.iter().enumerate() {
            words[rank] = (*word).to_owned();
        }
        for (word, rank) in PLACED {
            words[*rank] = (*word).to_owned();
        }
        let mut cdf = Vec::with_capacity(SIZE);
        let mut total = 0.0;
        for rank in 0..SIZE {
            total += 1.0 / ((rank + 1) as f64).powf(EXPONENT);
            cdf.push(total);
        }
        cdf.iter_mut().for_each(|value| *value /= total);
        Self { words, cdf }
    }

    fn text(&self, rng: &mut Rng, count: usize) -> String {
        let mut text = String::with_capacity(count * 7);
        for index in 0..count {
            if index > 0 {
                text.push(' ');
            }
            let draw = rng.unit();
            let rank = self
                .cdf
                .partition_point(|value| *value < draw)
                .min(self.words.len() - 1);
            text.push_str(&self.words[rank]);
        }
        text
    }

    /// A message length: log-normal around the median, so most messages are
    /// short and a few are very long (the mean is about twice the median).
    fn length(rng: &mut Rng, median: usize) -> usize {
        ((median as f64).ln() + 1.2 * rng.normal())
            .exp()
            .clamp(3.0, 40.0 * median as f64) as usize
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn sha(rng: &mut Rng) -> String {
    format!(
        "{:016x}{:016x}{:08x}",
        rng.next(),
        rng.next(),
        rng.next() as u32
    )
}

fn insert_message(tx: &Connection, rowid: i64, session: &str, ordinal: i64, text: &str, now: i64) {
    let role = if ordinal % 2 == 1 {
        "user"
    } else {
        "assistant"
    };
    tx.prepare_cached(
        "INSERT INTO message_history_fts (rowid, session_id, message_ordinal, message_id, role, content)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
    .unwrap()
    .execute(params![rowid, session, ordinal, format!("msg_{ordinal:06}"), role, text])
    .unwrap();
    tx.prepare_cached(
        "INSERT INTO message_fts_rowid_map (session_id, message_ordinal, fts_rowid, message_time_ms)
         VALUES (?1, ?2, ?3, ?4)",
    )
    .unwrap()
    .execute(params![session, ordinal, rowid, now - 3_600_000_000 + rowid * 1_000])
    .unwrap();
}

fn set_indexed(tx: &Connection, session: &str, count: i64, now: i64) {
    tx.execute(
        "INSERT INTO message_history_index (session_id, last_indexed_ordinal, dirty_floor_ordinal, updated_at, harness)
         VALUES (?1, ?2, 0, ?3, ?4)",
        params![session, count, now, HARNESS],
    )
    .unwrap();
}

/// Build the store at `path` and return how many messages it indexed. With
/// `prototype`, also build a session-indexed copy of the message index.
fn build_store(path: &Path, messages: usize, median_words: usize, prototype: bool) -> usize {
    drop(ContextDb::create_for_tests(path).unwrap());
    let mut conn = Connection::open(path).unwrap();
    // A throwaway build: no journal and no syncs. The store goes back to WAL
    // before the module opens it.
    conn.execute_batch(
        "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-500000;",
    )
    .unwrap();
    // The full-text index flushes its pending terms to a new segment every
    // megabyte by default, and merging those segments makes a build of two
    // million messages take hours. A larger buffer for the build only gives
    // fewer, larger segments; the default is restored before the module
    // opens the store.
    if let Err(error) = conn.execute(
        "INSERT INTO message_history_fts(message_history_fts, rank) VALUES ('hashsize', ?1)",
        params![256 * 1024 * 1024],
    ) {
        println!("BUILD full-text hashsize left at its default: {error}");
    }
    let vocabulary = Vocabulary::new();
    let mut rng = Rng(0x5EED);
    let now = now_ms();
    let started = Instant::now();

    let tx = conn.transaction().unwrap();
    {
        let mut memory = tx
            .prepare(
                "INSERT INTO memories (project_path, category, content, normalized_hash, status,
                     first_seen_at, created_at, updated_at, last_seen_at)
                 VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?5, ?5, ?5)",
            )
            .unwrap();
        let mut vector = tx
            .prepare("INSERT INTO memory_embeddings (memory_id, embedding, model_id) VALUES (?1, ?2, ?3)")
            .unwrap();
        let categories = [
            "ARCHITECTURE",
            "CONSTRAINTS",
            "CONFIG_VALUES",
            "NAMING",
            "PROJECT_RULES",
        ];
        for index in 0..PROJECT_MEMORIES + OTHER_MEMORIES {
            let project = if index < PROJECT_MEMORIES {
                PROJECT.to_owned()
            } else {
                format!("pj-other-{}", index % 20)
            };
            let length = Vocabulary::length(&mut rng, 25);
            memory
                .execute(params![
                    project,
                    categories[index % categories.len()],
                    vocabulary.text(&mut rng, length),
                    format!("hash-{index}"),
                    now - index as i64 * 60_000
                ])
                .unwrap();
            if index < PROJECT_MEMORY_VECTORS {
                let id = tx.last_insert_rowid();
                vector
                    .execute(params![
                        id,
                        mc_module::embedding::encode(&rng.vector()),
                        MODEL
                    ])
                    .unwrap();
            }
        }
        let mut primer = tx
            .prepare(
                "INSERT INTO primers (project_path, question, question_embedding,
                     question_embedding_model_id, answer, status, total_support, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?7, ?7)",
            )
            .unwrap();
        for index in 0..PRIMERS {
            primer
                .execute(params![
                    PROJECT,
                    vocabulary.text(&mut rng, 12),
                    mc_module::embedding::encode(&rng.vector()),
                    MODEL,
                    vocabulary.text(&mut rng, 60),
                    (index % 7) as i64,
                    now - index as i64 * 3_600_000
                ])
                .unwrap();
        }
        let mut note = tx
            .prepare(
                "INSERT INTO notes (type, status, content, session_id, project_path, harness,
                     created_at, updated_at)
                 VALUES (?1, 'active', ?2, ?3, ?4, ?5, ?6, ?6)",
            )
            .unwrap();
        for index in 0..30 {
            let (kind, session, project) = match index % 3 {
                0 => ("smart", None, Some(PROJECT)),
                1 => ("session", Some(LONG_SESSION), None),
                _ => ("session", Some(NEW_SESSION), None),
            };
            let length = Vocabulary::length(&mut rng, 40);
            note.execute(params![
                kind,
                vocabulary.text(&mut rng, length),
                session,
                project,
                HARNESS,
                now - index as i64 * 60_000
            ])
            .unwrap();
        }
        let mut commit = tx
            .prepare(
                "INSERT INTO git_commits (sha, project_path, short_sha, message, author, committed_at, indexed_at)
                 VALUES (?1, ?2, ?3, ?4, 'Dev', ?5, ?6)",
            )
            .unwrap();
        let mut commit_vector = tx
            .prepare(
                "INSERT INTO git_commit_embeddings (sha, embedding, model_id, created_at) VALUES (?1, ?2, ?3, ?4)",
            )
            .unwrap();
        for project in 0..=OTHER_COMMIT_PROJECTS {
            let project = if project == 0 {
                PROJECT.to_owned()
            } else {
                format!("pj-other-{project}")
            };
            for index in 0..COMMITS_PER_PROJECT {
                let sha = sha(&mut rng);
                let length = Vocabulary::length(&mut rng, 12);
                commit
                    .execute(params![
                        sha,
                        project,
                        &sha[..7],
                        vocabulary.text(&mut rng, length),
                        now - index as i64 * 3_600_000,
                        now
                    ])
                    .unwrap();
                commit_vector
                    .execute(params![
                        sha,
                        mc_module::embedding::encode(&rng.vector()),
                        MODEL,
                        now
                    ])
                    .unwrap();
            }
        }
    }
    tx.commit().unwrap();
    println!(
        "BUILD memories, primers, notes and commits: {:.1}s",
        started.elapsed().as_secs_f64()
    );

    // Messages. The long session lived through the middle third of the
    // store's history: its rows are spread over that span, as a session's
    // rows interleave with every other session active at the time.
    let per_session = 1_000usize;
    let others = messages.saturating_sub(LONG_MESSAGES as usize);
    let sessions: Vec<(String, usize)> = (0..others.div_ceil(per_session))
        .map(|index| {
            let count = per_session.min(others - index * per_session);
            (format!("ses_other_{index:05}"), count)
        })
        .collect();
    let span_start = others / 3;
    let stride = (others / 3 / LONG_MESSAGES as usize).max(1);
    let mut long_next: i64 = 1;
    let mut written = 0usize;
    let mut rowid: i64 = 0;
    let mut uncommitted = 0;
    let mut tx = conn.transaction().unwrap();
    for (session, count) in &sessions {
        for ordinal in 1..=*count as i64 {
            rowid += 1;
            let length = Vocabulary::length(&mut rng, median_words);
            let text = vocabulary.text(&mut rng, length);
            insert_message(&tx, rowid, session, ordinal, &text, now);
            written += 1;
            if written >= span_start
                && long_next <= LONG_MESSAGES
                && (written - span_start).is_multiple_of(stride)
            {
                rowid += 1;
                let length = Vocabulary::length(&mut rng, median_words);
                let text = vocabulary.text(&mut rng, length);
                insert_message(&tx, rowid, LONG_SESSION, long_next, &text, now);
                long_next += 1;
            }
            uncommitted += 1;
            if uncommitted >= 100_000 {
                tx.commit().unwrap();
                uncommitted = 0;
                println!(
                    "BUILD {rowid} messages indexed at {:.0}s",
                    started.elapsed().as_secs_f64()
                );
                tx = conn.transaction().unwrap();
            }
        }
        set_indexed(&tx, session, *count as i64, now);
    }
    while long_next <= LONG_MESSAGES {
        rowid += 1;
        let length = Vocabulary::length(&mut rng, median_words);
        let text = vocabulary.text(&mut rng, length);
        insert_message(&tx, rowid, LONG_SESSION, long_next, &text, now);
        long_next += 1;
    }
    set_indexed(&tx, LONG_SESSION, LONG_MESSAGES, now);
    tx.execute(
        "INSERT OR REPLACE INTO message_fts_rowid_map_backfill_state (id, watermark_rowid, completed, updated_at)
         VALUES (1, ?1, 1, ?2)",
        params![rowid, now],
    )
    .unwrap();
    tx.commit().unwrap();
    println!(
        "BUILD {rowid} messages indexed at {:.0}s",
        started.elapsed().as_secs_f64()
    );
    if prototype {
        // Not ck-mc's schema: the same rows indexed with the session id as a
        // searchable column, to measure what a session-scoped match costs.
        let (_, took) = timed(|| {
            conn.execute_batch(
                "CREATE VIRTUAL TABLE message_session_fts USING fts5(
                     c0, c4, content='message_history_fts_content', content_rowid='id',
                     tokenize='porter unicode61');
                 INSERT INTO message_session_fts(message_session_fts, rank) VALUES('hashsize', 268435456);
                 INSERT INTO message_session_fts(message_session_fts) VALUES('rebuild');",
            )
            .unwrap()
        });
        println!(
            "BUILD session-indexed prototype table: {:.0}s",
            took.as_secs_f64()
        );
    }

    // Summaries and their chunk vectors: the long session's 100 summaries,
    // three chunks each, and other sessions' up to the live count.
    let tx = conn.transaction().unwrap();
    {
        let mut compartment = tx
            .prepare(
                "INSERT INTO compartments (session_id, sequence, start_message, end_message, title, content, created_at, harness)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )
            .unwrap();
        let mut chunk = tx
            .prepare(
                "INSERT INTO compartment_chunk_embeddings (compartment_id, session_id, project_path, harness,
                     window_index, start_ordinal, end_ordinal, chunk_hash, model_id, dims, vector, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            )
            .unwrap();
        let mut written = 0;
        let owners = std::iter::once(LONG_SESSION).chain(
            sessions
                .iter()
                .map(|(session, _)| session.as_str())
                .filter(|session| *session != LONG_SESSION),
        );
        for session in owners {
            if written >= CHUNK_VECTORS {
                break;
            }
            let summaries = if session == LONG_SESSION { 100 } else { 10 };
            let span = if session == LONG_SESSION { 25 } else { 50 };
            for sequence in 0..summaries {
                let start = sequence * span + 1;
                compartment
                    .execute(params![
                        session,
                        sequence,
                        start,
                        start + span - 1,
                        vocabulary.text(&mut rng, 8),
                        vocabulary.text(&mut rng, 120),
                        now,
                        HARNESS
                    ])
                    .unwrap();
                let id = tx.last_insert_rowid();
                for window in 0..3 {
                    chunk
                        .execute(params![
                            id,
                            session,
                            PROJECT,
                            HARNESS,
                            window,
                            start,
                            start + span - 1,
                            format!("chunk-{id}-{window}"),
                            CHUNK_MODEL,
                            DIMS as i64,
                            mc_module::embedding::encode(&rng.vector()),
                            now
                        ])
                        .unwrap();
                    written += 1;
                }
            }
        }
    }
    tx.commit().unwrap();
    conn.execute(
        "DELETE FROM message_history_fts_config WHERE k = 'hashsize'",
        [],
    )
    .unwrap();
    conn.execute_batch("PRAGMA journal_mode=WAL;").unwrap();
    drop(conn);
    println!(
        "BUILD done: {rowid} messages in {} sessions, {:.0}s, {:.2} GB",
        sessions.len() + 1,
        started.elapsed().as_secs_f64(),
        std::fs::metadata(path).unwrap().len() as f64 / 1e9
    );
    rowid as usize
}

fn timed<T>(work: impl FnOnce() -> T) -> (T, Duration) {
    let started = Instant::now();
    let value = work();
    (value, started.elapsed())
}

fn ms(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1e3
}

fn median(mut samples: Vec<Duration>) -> Duration {
    samples.sort();
    samples[samples.len() / 2]
}

/// One kind of session a search runs for.
struct Case {
    label: &'static str,
    session: &'static str,
    cutoff: i64,
    visible: Option<BTreeSet<i64>>,
}

fn cases() -> Vec<Case> {
    vec![
        // As `Session::search_scope` gives a compacted session without
        // summaries: no cutoff, and its one message in view.
        Case {
            label: "new",
            session: NEW_SESSION,
            cutoff: i64::MAX,
            visible: Some(BTreeSet::from([1])),
        },
        Case {
            label: "long",
            session: LONG_SESSION,
            cutoff: LONG_SUMMARIZED,
            visible: None,
        },
    ]
}

fn scope<'a>(
    case: &'a Case,
    seen: &'a BTreeMap<i64, String>,
    semantic: Option<sources::Semantic<'a>>,
) -> Scope<'a> {
    Scope {
        harness: HARNESS,
        session: case.session,
        project: Some(PROJECT),
        workspace: None,
        cutoff: case.cutoff,
        visible_messages: case.visible.clone(),
        seen,
        memory_enabled: true,
        git_commits_enabled: true,
        git_repository: Some(true),
        semantic,
    }
}

/// The lane depth `search::collect` uses for the default limit of ten.
const TIER: usize = 30;

/// The reads one `ctx_search` makes on its read connection, in the order
/// `search::collect` makes them and with the same arguments, each timed on
/// its own. `rerank` adds what a reranked search reads besides. `coverage`
/// is the connection's rowid-map proof, so the first run of a session pays
/// for the proof and later ones reuse it while the store is unchanged.
fn lanes(
    conn: &Connection,
    coverage: &mut messages::Coverage,
    case: &Case,
    query: &str,
    semantic: Option<sources::Semantic<'_>>,
    rerank: bool,
) -> Vec<(&'static str, Duration)> {
    let mut stages = Vec::new();
    let lane_tier = if rerank {
        TIER.max(search::rerank::LANE_LIMIT)
    } else {
        TIER
    };
    let owners = sources::MemoryOwners {
        project: Some(PROJECT),
        workspace: None,
    };
    let (_, took) = timed(|| sources::searchable_memories(conn, owners).unwrap().len());
    stages.push(("memories: in-view check (reads all)", took));
    let visible = BTreeSet::new();
    let (_, took) = timed(|| {
        sources::search_memories(conn, owners, query, TIER, &visible, None, semantic, None)
    });
    stages.push(("memories: words + vectors", took));
    let (_, took) =
        timed(|| sources::search_primers(conn, PROJECT, query, TIER, None, semantic, None));
    stages.push(("primers", took));
    let probes = search::text::literal_probes(query);
    let (reach, took) = timed(|| messages::reach(conn, coverage, case.session, None));
    stages.push((
        "messages: reach (rowid-map coverage, kept per connection)",
        took,
    ));
    let (_, took) = timed(|| {
        messages::count_live_matches(
            conn,
            case.session,
            query,
            case.cutoff,
            None,
            case.visible.as_ref(),
            reach,
        )
    });
    stages.push(("messages: live-match counts", took));
    let wanted = messages::Query {
        text: query,
        limit: TIER,
        probes: &probes,
        dates: None,
        visible: case.visible.as_ref(),
    };
    // A reranked search reads its candidate pool from the same reads.
    let depths: &[usize] = if rerank { &[TIER, 75] } else { &[TIER] };
    let (_, took) = timed(|| {
        messages::search_at(
            conn,
            case.session,
            &wanted,
            depths,
            case.cutoff,
            true,
            reach,
        )
    });
    stages.push((
        if rerank {
            "messages: ranked search with the rerank's pool (one read)"
        } else {
            "messages: ranked search"
        },
        took,
    ));
    if let Some(semantic) = semantic {
        let (_, took) = timed(|| {
            sources::search_chunks(
                conn,
                case.session,
                PROJECT,
                lane_tier,
                case.cutoff,
                None,
                semantic,
            )
        });
        stages.push(("history-chunk vectors", took));
    }
    let (_, took) =
        timed(|| sources::search_commits(conn, PROJECT, query, TIER, None, semantic, None));
    stages.push(("commits: words + vectors", took));
    let notes = messages::Query {
        limit: lane_tier,
        ..wanted
    };
    let (_, took) =
        timed(|| sources::search_notes(conn, HARNESS, case.session, Some(PROJECT), &notes));
    stages.push(("notes", took));
    stages
}

fn count(conn: &Connection, sql: &str, params: impl rusqlite::Params) -> (i64, Duration) {
    timed(|| conn.query_row(sql, params, |row| row.get(0)).unwrap())
}

/// Why the message lane costs what it does: how many documents its full-text
/// queries match across every session, the per-session work, and what a
/// query restricted to the session's own rows costs instead. Each search is
/// timed both ways the lane can reach the session's rows: screened by its
/// rowid map (what `ctx_search` now does for a covered session) and through
/// every match's session id (what it did before, and still does for a
/// session with unmapped rows), with the two results compared.
fn message_diagnostics(conn: &Connection, case: &Case, query: &str, prototype: bool) {
    let strict = search::text::sanitize_fts_query(query);
    let relaxed = search::text::relaxed_fts_query(query);
    let probes = search::text::literal_probes(query);
    let wanted = messages::Query {
        text: query,
        limit: TIER,
        probes: &probes,
        dates: None,
        visible: case.visible.as_ref(),
    };
    let (reach, proof_took) =
        timed(|| messages::reach(conn, &mut messages::Coverage::default(), case.session, None));
    println!(
        "MESSAGES {} | {query} | reach {reach:?}, with a fresh rowid-map coverage proof: {:.0} ms",
        case.label,
        ms(proof_took)
    );
    for (way, reach) in [
        ("screened", reach),
        ("unscreened", messages::Reach::Unmapped),
    ] {
        let (strict_hits, strict_took) = timed(|| {
            messages::search(conn, case.session, &wanted, case.cutoff, false, reach).len()
        });
        let (all_hits, all_took) =
            timed(|| messages::search(conn, case.session, &wanted, case.cutoff, true, reach).len());
        let (_, both_took) = timed(|| {
            messages::search_at(
                conn,
                case.session,
                &wanted,
                &[TIER, 75],
                case.cutoff,
                true,
                reach,
            )
        });
        println!(
            "MESSAGES {} | {query} | {way}: strict form only: {strict_hits} hits {:.0} ms; with the relaxed fallback: {all_hits} hits {:.0} ms; both rerank depths from one read: {:.0} ms",
            case.label,
            ms(strict_took),
            ms(all_took),
            ms(both_took)
        );
    }
    let same = messages::search_at(
        conn,
        case.session,
        &wanted,
        &[TIER, 75],
        case.cutoff,
        true,
        reach,
    ) == messages::search_at(
        conn,
        case.session,
        &wanted,
        &[TIER, 75],
        case.cutoff,
        true,
        messages::Reach::Unmapped,
    );
    println!(
        "MESSAGES {} | {query} | screened and unscreened results identical: {same}",
        case.label
    );
    assert!(same, "{} {query}", case.label);
    for (form, fts) in [("strict", &strict), ("relaxed", &relaxed)] {
        if fts.is_empty() {
            continue;
        }
        let matching = format!("content : ({fts})");
        let (global, took) = count(
            conn,
            "SELECT COUNT(*) FROM message_history_fts WHERE message_history_fts MATCH ?1",
            params![matching],
        );
        let (session, session_took) = count(
            conn,
            "SELECT COUNT(*) FROM message_history_fts
              WHERE session_id = ?1 AND message_history_fts MATCH ?2",
            params![case.session, matching],
        );
        let (indexed, indexed_took) = count(
            conn,
            "SELECT COALESCE(MAX(last_indexed_ordinal), 0) FROM message_history_index WHERE session_id = ?1",
            params![case.session],
        );
        println!(
            "MESSAGES {} | {query} | {form}: matches {global} documents in all sessions (count {:.0} ms); \
             {session} in the session by its unindexed column ({:.0} ms); session watermark {indexed} ({:.3} ms)",
            case.label,
            ms(took),
            ms(session_took),
            ms(indexed_took)
        );
        // The same rows found through the session's rowid map instead of the
        // unindexed column. SQLite runs the full-text query again for every
        // row of the session, so this is slower, and on a large store far
        // slower; it runs only when asked for.
        if env_usize("MC_LATENCY_ROWID_MAP", 0) == 1 {
            let (mapped, mapped_took) = count(
                conn,
                "SELECT COUNT(*) FROM message_history_fts
                  WHERE message_history_fts MATCH ?2
                    AND rowid IN (SELECT fts_rowid FROM message_fts_rowid_map WHERE session_id = ?1)",
                params![case.session, matching],
            );
            let (ranked, ranked_took) = timed(|| {
                let mut statement = conn
                    .prepare(
                        "SELECT message_ordinal FROM message_history_fts
                          WHERE message_history_fts MATCH ?2
                            AND rowid IN (SELECT fts_rowid FROM message_fts_rowid_map
                                           WHERE session_id = ?1 AND message_ordinal <= ?3)
                          ORDER BY bm25(message_history_fts) LIMIT ?4",
                    )
                    .unwrap();
                let rows = statement
                    .query_map(
                        params![case.session, matching, case.cutoff, (TIER * 3) as i64],
                        |row| row.get::<_, i64>(0),
                    )
                    .unwrap()
                    .count();
                rows
            });
            println!(
                "MESSAGES {} | {query} | {form}: {mapped} through the rowid map ({:.0} ms); ranked top {} through the map ({ranked} rows, {:.0} ms)",
                case.label,
                ms(mapped_took),
                TIER * 3,
                ms(ranked_took)
            );
        }
        // The plugin's session filter (`message-fts-session-filter.ts`): the
        // unary `+` keeps SQLite from restarting the full-text query for each
        // mapped row, so every match's rowid is checked against the session's
        // rowids once, before any content column is read. The session-id test
        // stays, as in the plugin.
        let screened = "SELECT {columns} FROM message_history_fts
              WHERE +message_history_fts.rowid IN (
                        SELECT fts_rowid FROM message_fts_rowid_map WHERE session_id = ?1)
                AND message_history_fts.session_id = ?1 AND message_history_fts MATCH ?2 {tail}";
        let (found, took) = count(
            conn,
            &screened
                .replace("{columns}", "COUNT(*)")
                .replace("{tail}", ""),
            params![case.session, matching],
        );
        let (ranked, ranked_took) = timed(|| {
            let sql = screened
                .replace("{columns}", "message_ordinal")
                .replace("{tail}", "ORDER BY bm25(message_history_fts) LIMIT ?3");
            let mut statement = conn.prepare(&sql).unwrap();
            let rows = statement
                .query_map(params![case.session, matching, (TIER * 3) as i64], |row| {
                    row.get::<_, rusqlite::types::Value>(0)
                })
                .unwrap()
                .count();
            rows
        });
        println!(
            "MESSAGES {} | {query} | {form}: screened by the session's rowid map as the plugin does: {found} in the session ({:.0} ms), ranked top {} ({ranked} rows, {:.0} ms)",
            case.label,
            ms(took),
            TIER * 3,
            ms(ranked_took)
        );
        // A narrower bound that needs no schema change: the session's own
        // span of rows, which the full-text index can seek to.
        let (low, high): (Option<i64>, Option<i64>) = conn
            .query_row(
                "SELECT MIN(fts_rowid), MAX(fts_rowid) FROM message_fts_rowid_map WHERE session_id = ?1",
                params![case.session],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        match (low, high) {
            (Some(low), Some(high)) => {
                let (ranged, took) = count(
                    conn,
                    "SELECT COUNT(*) FROM message_history_fts
                      WHERE message_history_fts MATCH ?1 AND rowid BETWEEN ?2 AND ?3 AND session_id = ?4",
                    params![matching, low, high, case.session],
                );
                let (spanned, _) = count(
                    conn,
                    "SELECT COUNT(*) FROM message_history_fts WHERE message_history_fts MATCH ?1 AND rowid BETWEEN ?2 AND ?3",
                    params![matching, low, high],
                );
                println!(
                    "MESSAGES {} | {query} | {form}: within the session's own rowid span ({low}..{high}, {spanned} matches there): {ranged} in the session ({:.0} ms)",
                    case.label,
                    ms(took)
                );
            }
            _ => println!(
                "MESSAGES {} | {query} | {form}: the session has no indexed rows; a check of its rowid span answers that in no time",
                case.label
            ),
        }
        if prototype {
            let tokens = case.session.replace('_', " ");
            let scoped = format!("c0 : \"{tokens}\" AND c4 : ({fts})");
            let (found, took) = count(
                conn,
                "SELECT COUNT(*) FROM message_session_fts WHERE message_session_fts MATCH ?1",
                params![scoped],
            );
            let (ranked, ranked_took) = timed(|| {
                let mut statement = conn
                    .prepare(
                        "SELECT rowid FROM message_session_fts WHERE message_session_fts MATCH ?1
                          ORDER BY bm25(message_session_fts) LIMIT ?2",
                    )
                    .unwrap();
                let rows = statement
                    .query_map(params![scoped, (TIER * 3) as i64], |row| {
                        row.get::<_, i64>(0)
                    })
                    .unwrap()
                    .count();
                rows
            });
            println!(
                "MESSAGES {} | {query} | {form}: session id indexed as a column (prototype): {found} in the session ({:.0} ms), ranked top {} ({ranked} rows, {:.0} ms)",
                case.label,
                ms(took),
                TIER * 3,
                ms(ranked_took)
            );
        }
    }
}

fn plan(conn: &Connection, sql: &str, params: impl rusqlite::Params) -> String {
    let mut statement = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
    let rows = statement
        .query_map(params, |row| row.get::<_, String>(3))
        .unwrap()
        .map(Result::unwrap)
        .collect::<Vec<_>>();
    rows.join(" / ")
}

/// An OpenAI-compatible embeddings endpoint on localhost that answers at
/// once with one `DIMS`-wide vector per input, so what is timed is ck-mc's
/// own side of a request: a fresh client, a connection, the body and parsing.
async fn embedding_stub() -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut raw = Vec::new();
                let mut chunk = [0u8; 16384];
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
                let Some(body) = body else { return };
                let request: serde_json::Value = serde_json::from_str(&body).unwrap();
                let count = request["input"].as_array().map_or(0, Vec::len);
                let vector: Vec<f64> = (0..DIMS).map(|index| (index % 7) as f64 * 0.01).collect();
                let data: Vec<_> = (0..count)
                    .map(|index| json!({"index": index, "embedding": vector}))
                    .collect();
                let body = json!({"model": request["model"], "data": data}).to_string();
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
            });
        }
    });
    format!("http://{address}")
}

fn stub_provider(endpoint: &str) -> mc_module::embedding::Provider {
    mc_module::embedding::Provider::from_tiers(
        &json!({"embedding": {"provider": "openai-compatible", "endpoint": endpoint, "model": "latency-stub"}}),
        &json!({}),
        Path::new("/nonexistent"),
    )
    .expect("a localhost endpoint is allowed")
}

/// A repository of `count` commits with distinct messages, written by
/// `git fast-import` in well under a second.
fn repository(dir: &Path, tag: usize, count: usize, vocabulary: &Vocabulary) -> std::path::PathBuf {
    use std::io::Write;
    let repo = dir.join(format!("repo-{tag}"));
    std::fs::create_dir_all(&repo).unwrap();
    let git = |args: &[&str]| {
        let status = std::process::Command::new("git")
            .args(args)
            .current_dir(&repo)
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?}");
    };
    git(&["init", "-q"]);
    let mut rng = Rng(0xC0FFEE + tag as u64);
    let now = now_ms() / 1000;
    let mut stream = String::new();
    for index in 0..count {
        let message = format!("{tag}-{index} {}\n", vocabulary.text(&mut rng, 12));
        stream.push_str(&format!(
            "commit refs/heads/main\nmark :{}\ncommitter Dev <dev@example.com> {} +0000\ndata {}\n{message}",
            index + 1,
            now - (count - index) as i64 * 600,
            message.len()
        ));
        if index > 0 {
            stream.push_str(&format!("from :{index}\n"));
        }
        stream.push('\n');
    }
    let mut child = std::process::Command::new("git")
        .args(["fast-import", "--quiet"])
        .current_dir(&repo)
        .stdin(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(stream.as_bytes())
        .unwrap();
    assert!(child.wait().unwrap().success());
    git(&["symbolic-ref", "HEAD", "refs/heads/main"]);
    repo
}

/// Run `searches` full `ctx_search` reads one after another for the session
/// of `cases()[case]`, as a `ctx_search` makes them: the lanes on a read
/// connection, then the retrieval counts on the shared one. Each is timed
/// from asking for the read connection; returns each one's wait for it and
/// its total time.
fn search_series(
    db: &ContextDb,
    case: usize,
    searches: usize,
    vector: &[f32],
    pause: Duration,
) -> Vec<(Duration, Duration)> {
    let cases = cases();
    let case = &cases[case];
    let seen = BTreeMap::new();
    let semantic = sources::Semantic {
        vector,
        model_id: MODEL,
        chunk_model_id: CHUNK_MODEL,
    };
    let scope = scope(case, &seen, Some(semantic));
    let input = json!({"query": QUERIES[0]});
    (0..searches)
        .map(|_| {
            std::thread::sleep(pause);
            let started = Instant::now();
            let (wait, prepared) = db.with_search_reader(|conn, coverage| {
                let wait = started.elapsed();
                (
                    wait,
                    search::prepare(conn, coverage, &scope, &input, None).unwrap(),
                )
            });
            db.with_connection(|conn| search::finish(conn, &scope, prepared));
            (wait, started.elapsed())
        })
        .collect()
}

fn summarize(label: &str, series: &[(Duration, Duration)]) {
    let waits: Vec<Duration> = series.iter().map(|(wait, _)| *wait).collect();
    let totals: Vec<Duration> = series.iter().map(|(_, total)| *total).collect();
    println!(
        "{label}: {} searches; total median {:.0} ms, max {:.0} ms; waiting for the connection median {:.0} ms, max {:.0} ms",
        series.len(),
        ms(median(totals.clone())),
        ms(totals.iter().copied().max().unwrap_or_default()),
        ms(median(waits.clone())),
        ms(waits.iter().copied().max().unwrap_or_default())
    );
}

#[cfg(feature = "context-db-timing")]
fn report_holds(db: &ContextDb, label: &str) {
    let mut sites: BTreeMap<String, (usize, Duration, Duration)> = BTreeMap::new();
    for sample in db.take_lock_samples() {
        let site = format!("{}:{}", sample.site.file(), sample.site.line());
        let entry = sites.entry(site).or_default();
        entry.0 += 1;
        entry.1 += sample.elapsed;
        entry.2 = entry.2.max(sample.elapsed);
    }
    let mut sites: Vec<_> = sites.into_iter().collect();
    sites.sort_by(|left, right| right.1 .2.cmp(&left.1 .2));
    for (site, (count, total, longest)) in sites.into_iter().take(12) {
        println!(
            "HOLD {label} | {site} | {count} holds, total {:.1} ms, longest {:.1} ms",
            ms(total),
            ms(longest)
        );
    }
}

#[cfg(not(feature = "context-db-timing"))]
fn report_holds(_: &ContextDb, _: &str) {}

#[test]
#[ignore = "builds a multi-gigabyte store; run on Linux in release mode, command in the module doc"]
fn ctx_search_latency_on_a_live_sized_store() {
    let messages = env_usize("MC_LATENCY_MESSAGES", 2_025_399);
    let median_words = env_usize("MC_LATENCY_MEDIAN_WORDS", 130);
    let repeats = env_usize("MC_LATENCY_REPEATS", 2).max(1);
    let prototype = env_usize("MC_LATENCY_PROTOTYPE", 1) == 1;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("context.db");
    let indexed = build_store(&path, messages, median_words, prototype);
    // The content column of the full-text table's own row store.
    let average: f64 = Connection::open(&path)
        .unwrap()
        .query_row(
            "SELECT AVG(length(c4)) FROM message_history_fts_content",
            [],
            |row| row.get(0),
        )
        .unwrap();
    println!("STORE {indexed} indexed messages, {average:.0} characters on average");
    let db = Arc::new(ContextDb::open(&path).unwrap());
    let mut rng = Rng(0xFACE);
    let vector = rng.vector();
    let semantic = sources::Semantic {
        vector: &vector,
        model_id: MODEL,
        chunk_model_id: CHUNK_MODEL,
    };
    let seen = BTreeMap::new();

    db.with_connection(|conn| {
        println!(
            "PLAN message lane | {}",
            plan(
                conn,
                "SELECT message_ordinal FROM message_history_fts
                  WHERE message_history_fts.session_id = ?1 AND message_history_fts MATCH ?2
                  ORDER BY bm25(message_history_fts) LIMIT 30",
                params![NEW_SESSION, "content : (\"upkeep\")"],
            )
        );
        println!(
            "PLAN commit vectors | {}",
            plan(
                conn,
                "SELECT e.sha, e.embedding FROM git_commit_embeddings e
                   JOIN git_commits c ON c.sha = e.sha
                  WHERE c.project_path = ?1 AND e.model_id = ?2",
                params![PROJECT, MODEL],
            )
        );
        println!(
            "PLAN memory vectors | {}",
            plan(
                conn,
                "SELECT e.memory_id, e.embedding FROM memory_embeddings e
                   JOIN memories m ON m.id = e.memory_id
                  WHERE m.id IN (SELECT value FROM json_each(?1)) AND e.model_id = ?2",
                params!["[1,2,3]", MODEL],
            )
        );
    });

    // 1. Stage by stage, then the whole call through the module's own
    // functions, for each kind of session and query.
    for case in cases() {
        for query in QUERIES {
            let rerank = search::rerank::is_prose_query(query);
            let mut runs: Vec<Vec<(&'static str, Duration)>> = Vec::new();
            for _ in 0..repeats {
                runs.push(db.with_search_reader(|conn, coverage| {
                    lanes(conn, coverage, &case, query, Some(semantic), rerank)
                }));
            }
            let total_first: Duration = runs[0].iter().map(|(_, took)| *took).sum();
            for (index, (stage, first)) in runs[0].iter().enumerate() {
                let typical = median(runs.iter().map(|run| run[index].1).collect());
                println!(
                    "STAGE {} | {query} | {stage} | first {:.1} ms | median {:.1} ms",
                    case.label,
                    ms(*first),
                    ms(typical)
                );
            }
            println!(
                "STAGE {} | {query} | sum of stages | first {:.1} ms | reranked: {rerank}",
                case.label,
                ms(total_first)
            );
            let input = json!({"query": query});
            for (label, pool, semantic) in [
                ("whole call", None, Some(semantic)),
                (
                    "whole call, reranked",
                    Some(search::rerank::POOL),
                    Some(semantic),
                ),
                ("whole call, no query vector", None, None),
            ] {
                if pool.is_some() && !rerank {
                    continue;
                }
                let scope = scope(&case, &seen, semantic);
                let mut prepares = Vec::new();
                let mut finishes = Vec::new();
                for _ in 0..repeats {
                    let (prepared, prepare) = db.with_search_reader(|conn, coverage| {
                        timed(|| search::prepare(conn, coverage, &scope, &input, pool).unwrap())
                    });
                    let (_, finish) =
                        db.with_connection(|conn| timed(|| search::finish(conn, &scope, prepared)));
                    prepares.push(prepare);
                    finishes.push(finish);
                }
                println!(
                    "CALL {} | {query} | {label} | prepare first {:.1} ms, median {:.1} ms | finish (retrieval counts and reply) median {:.1} ms",
                    case.label,
                    ms(prepares[0]),
                    ms(median(prepares)),
                    ms(median(finishes))
                );
            }
            db.with_search_reader(|conn, _| message_diagnostics(conn, &case, query, prototype));
        }
        let scope = scope(&case, &seen, Some(semantic));
        let holds: Vec<Duration> = (0..repeats)
            .map(|_| {
                db.with_search_reader(|conn, coverage| {
                    timed(|| search::auto_hits(conn, coverage, &scope, PROMPT)).1
                })
            })
            .collect();
        println!(
            "AUTO {} | memory hint on a {}-character prompt holds its read connection: first {:.1} ms, median {:.1} ms",
            case.label,
            PROMPT.len(),
            ms(holds[0]),
            ms(median(holds))
        );
    }
    report_holds(&db, "stage runs");

    // 2. The query embedding: ck-mc's own share of one request, on
    // localhost. A hosted endpoint adds its round trip and a TLS handshake
    // on every call, as each call builds a new client.
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let endpoint = runtime.block_on(embedding_stub());
    let provider = stub_provider(&endpoint);
    let mut embeds = Vec::new();
    for _ in 0..20 {
        let (vector, took) = timed(|| runtime.block_on(provider.embed_search_query(QUERIES[0])));
        assert_eq!(vector.map(|vector| vector.len()), Some(DIMS));
        embeds.push(took);
    }
    let mut builds = Vec::new();
    for _ in 0..20 {
        builds.push(
            timed(|| {
                reqwest::Client::builder()
                    .redirect(reqwest::redirect::Policy::none())
                    .no_proxy()
                    .build()
                    .unwrap()
            })
            .1,
        );
    }
    println!(
        "EMBED query embedding against localhost: median {:.1} ms, max {:.1} ms; building the client alone: median {:.1} ms",
        ms(median(embeds.clone())),
        ms(embeds.iter().copied().max().unwrap()),
        ms(median(builds))
    );

    // 3. Searches from several sessions at once, each on a read connection
    // of its own (at most four), for a new and for a long session.
    for (index, case) in cases().iter().enumerate() {
        for concurrent in [1usize, 2, 4, 8] {
            let barrier = Arc::new(Barrier::new(concurrent));
            let results: Vec<(Duration, Duration)> = std::thread::scope(|threads| {
                let handles: Vec<_> = (0..concurrent)
                    .map(|_| {
                        let (db, barrier, vector) =
                            (Arc::clone(&db), Arc::clone(&barrier), &vector);
                        threads.spawn(move || {
                            barrier.wait();
                            search_series(&db, index, 1, vector, Duration::ZERO)[0]
                        })
                    })
                    .collect();
                handles
                    .into_iter()
                    .map(|handle| handle.join().unwrap())
                    .collect()
            });
            summarize(
                &format!("CONCURRENT {} {concurrent} at once", case.label),
                &results,
            );
        }
    }

    // 4. A one-statement read, as a Setup or a `ctx_memory` call makes,
    // asked for 100 ms after a search of the long session started.
    let small_wait = std::thread::scope(|threads| {
        let searcher = {
            let (db, vector) = (Arc::clone(&db), &vector);
            threads.spawn(move || search_series(&db, 1, 1, vector, Duration::ZERO))
        };
        std::thread::sleep(Duration::from_millis(100));
        let started = Instant::now();
        db.with_connection(|conn| {
            conn.query_row("SELECT COUNT(*) FROM memories WHERE id = 1", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap()
        });
        let waited = started.elapsed();
        let search = searcher.join().unwrap()[0];
        (waited, search.1)
    });
    println!(
        "SMALL a one-row read asked for 100 ms into a search waited {:.0} ms for the connection; the search took {:.0} ms",
        ms(small_wait.0),
        ms(small_wait.1)
    );

    // 5. Searches alone, then while upkeep runs: a project's memory batch
    // and, for a project new to the store, its first commit sweep (2,000
    // commits stored, then up to 500 embedded in batches of 16), round after
    // round on fresh repositories.
    let alone = search_series(&db, 1, 6, &vector, Duration::from_millis(50));
    summarize("UPKEEP searches alone", &alone);
    let vocabulary = Vocabulary::new();
    let repos: Vec<_> = (0..8)
        .map(|tag| repository(dir.path(), tag, COMMITS_PER_PROJECT, &vocabulary))
        .collect();
    let memory_plan = mc_module::upkeep::Plan {
        memory: true,
        embedding: Some(provider.clone()),
        git: None,
    };
    let sweep_plan = mc_module::upkeep::Plan {
        memory: true,
        embedding: Some(provider.clone()),
        git: Some(mc_module::upkeep::GitIndexing {
            since_days: 365,
            max_commits: COMMITS_PER_PROJECT as u64,
        }),
    };
    report_holds(&db, "before upkeep (discarded)");
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let upkeep = {
        let (db, stop) = (Arc::clone(&db), Arc::clone(&stop));
        let handle = runtime.handle().clone();
        std::thread::spawn(move || {
            let mut rounds = Vec::new();
            for (tag, repo) in repos.iter().enumerate() {
                if stop.load(std::sync::atomic::Ordering::SeqCst) {
                    break;
                }
                let (reports, took) = timed(|| {
                    handle.block_on(async {
                        let memories = mc_module::upkeep::run_project(
                            &db,
                            PROJECT,
                            repo,
                            &memory_plan,
                            &now_ms,
                        )
                        .await;
                        let sweep = mc_module::upkeep::run_project(
                            &db,
                            &format!("pj-upkeep-{tag}"),
                            repo,
                            &sweep_plan,
                            &now_ms,
                        )
                        .await;
                        (memories, sweep)
                    })
                });
                rounds.push((reports, took));
            }
            rounds
        })
    };
    std::thread::sleep(Duration::from_millis(200));
    let during = search_series(&db, 1, 6, &vector, Duration::from_millis(50));
    stop.store(true, std::sync::atomic::Ordering::SeqCst);
    let rounds = upkeep.join().unwrap();
    summarize("UPKEEP searches during upkeep", &during);
    for ((memories, sweep), took) in &rounds {
        println!(
            "UPKEEP round {:.0} ms: memories {memories:?}; first sweep {sweep:?}",
            ms(*took)
        );
    }
    report_holds(&db, "upkeep rounds and the searches beside them");
}

/// A runner with nothing behind it. The tool calls measured below read only
/// `context.db` and the embedding stub, so the module never calls it.
struct NoRunner;

fn no_runner<T>() -> Result<T, mc_module::client::ClientError> {
    Err(mc_module::client::ClientError::new(
        "no runner in this measurement",
    ))
}

impl mc_module::client::RunnerClient for NoRunner {
    async fn read(
        &self,
        _: &cortexkit_role_compaction::read::SessionRef,
        _: cortexkit_role_compaction::read::ReadRequest,
    ) -> Result<cortexkit_role_compaction::read::ReadPage, mc_module::client::ClientError> {
        no_runner()
    }

    async fn apply_view(
        &self,
        _: &cortexkit_role_compaction::read::SessionRef,
        _: cortexkit_role_compaction::view::ApplyViewRequest,
    ) -> Result<cortexkit_role_compaction::view::ApplyViewAnswer, mc_module::client::ClientError>
    {
        no_runner()
    }

    async fn applied_view(
        &self,
        _: &cortexkit_role_compaction::read::SessionRef,
    ) -> Result<cortexkit_role_compaction::view::AppliedViewAnswer, mc_module::client::ClientError>
    {
        no_runner()
    }

    async fn send(
        &self,
        _: &cortexkit_role_compaction::read::SessionRef,
        _: cortexkit_role_llm_runner::send::SendRequest,
    ) -> Result<cortexkit_role_llm_runner::send::SendReply, mc_module::client::ClientError> {
        no_runner()
    }

    async fn send_child(
        &self,
        _: &mc_module::client::Child,
        _: cortexkit_role_llm_runner::send::SendRequest,
    ) -> Result<cortexkit_role_llm_runner::send::SendReply, mc_module::client::ClientError> {
        no_runner()
    }

    async fn child_result(
        &self,
        _: &mc_module::client::Child,
        _: cortexkit_role_llm_runner::run::RunResultRequest,
    ) -> Result<cortexkit_role_llm_runner::run::RunResult, mc_module::client::ClientError> {
        no_runner()
    }
}

impl mc_module::routing::Router for NoRunner {
    async fn select(
        &self,
        _: cortexkit_role_routing::select::SelectRequest,
    ) -> Result<cortexkit_role_routing::select::SelectAnswer, mc_module::routing::RouteError> {
        Err(mc_module::routing::RouteError {
            code: "routing_unavailable".into(),
            message: "no routing in this measurement".into(),
            detail: None,
        })
    }

    async fn report(&self, _: cortexkit_role_routing::report::ReportRequest) {}
}

/// How late a 5 ms timer fires, at worst, until `stop` is set: a Tokio
/// worker thread blocked on the `context.db` mutex runs nothing else, so
/// this shows how long every other task on the runtime waited.
async fn timer_lateness(stop: Arc<std::sync::atomic::AtomicBool>) -> Duration {
    let tick = Duration::from_millis(5);
    let mut worst = Duration::ZERO;
    while !stop.load(std::sync::atomic::Ordering::SeqCst) {
        let asked = Instant::now();
        tokio::time::sleep(tick).await;
        worst = worst.max(asked.elapsed().saturating_sub(tick));
    }
    worst
}

/// The live log's pattern, reproduced through the module's own tool entry
/// point: a `ctx_memory` call sent while a `ctx_search` of the same session
/// runs is answered only after the search, because one worker per session
/// takes that session's jobs one at a time. A `ctx_memory` of another
/// session is timed beside it: it waited for the whole search while
/// searches read on the one shared `context.db` connection. Then several
/// searches at once on a small runtime, with a timer measuring how late the
/// runtime runs unrelated tasks: a search that waits for a connection on a
/// Tokio worker thread holds that thread.
///
/// ```text
/// cargo test --locked --release -p mc-module --test search_latency \
///     ctx_memory_waits -- --ignored --nocapture
/// ```
///
/// `MC_LATENCY_QUEUE_MESSAGES` (default 400,000) sizes the message index,
/// and `MC_LATENCY_RUNTIME_WORKERS` (default 2) the runtime's threads.
#[test]
#[ignore = "builds a store of about a gigabyte; run on Linux in release mode, command in the doc"]
fn ctx_memory_waits_for_ctx_search_on_its_session() {
    use mc_module::route::{Project, Route};
    let messages = env_usize("MC_LATENCY_QUEUE_MESSAGES", 400_000);
    let median_words = env_usize("MC_LATENCY_MEDIAN_WORDS", 130);
    let workers = env_usize("MC_LATENCY_RUNTIME_WORKERS", 2).max(1);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("context.db");
    build_store(&path, messages, median_words, false);
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(workers)
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let endpoint = embedding_stub().await;
        let provider = stub_provider(&endpoint);
        // The stub's model id depends on its port, so the stored vectors are
        // relabelled to it: the vector lanes then score them as they would
        // under a configured provider.
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(&format!(
            "UPDATE memory_embeddings SET model_id = '{model}';
             UPDATE git_commit_embeddings SET model_id = '{model}';
             UPDATE primers SET question_embedding_model_id = '{model}';
             UPDATE compartment_chunk_embeddings SET model_id = '{chunk}';",
            model = provider.model_id(),
            chunk = provider.chunk_model_id()
        ))
        .unwrap();
        drop(conn);
        let settings = mc_module::pass::Settings {
            memory_enabled: true,
            git_commits_enabled: true,
            embedding: Some(provider),
            rerank: search::rerank::Reranker::Off,
            ..Default::default()
        };
        let module = mc_module::module::Module::new(
            NoRunner,
            settings,
            Some(ContextDb::open(&path).unwrap()),
            None,
        );
        let root = dir.path().to_string_lossy().into_owned();
        let route = move |session: &str| Route {
            session: cortexkit_role_compaction::read::SessionRef::new(
                "latency-runner",
                HARNESS,
                session,
            ),
            project: Some(Project {
                id: PROJECT.to_owned(),
                root: root.clone(),
            }),
            workdir: None,
            agent_id: None,
        };
        let read = json!({"action": "get", "ids": [1]});
        let sessions: Vec<String> = std::iter::once(NEW_SESSION.to_owned())
            .chain((0..=workers).map(|index| format!("ses_bystander_{index}")))
            .collect();
        // Each session's worker starts on its first call; start them all
        // first, so the calls timed below include no worker start.
        for session in &sessions {
            module
                .tool(&route(session), "ctx_memory", read.clone())
                .await
                .unwrap();
        }
        let call = |session: String, name: &'static str, input: serde_json::Value| {
            let (module, route) = (module.clone(), route(&session));
            tokio::spawn(async move {
                let asked = Instant::now();
                let answer = module.tool(&route, name, input).await;
                assert!(answer.is_ok(), "{name}: {answer:?}");
                (asked, Instant::now())
            })
        };
        let query = json!({"query": QUERIES[1]});

        // 1. One search alone, for its own time.
        let (asked, answered) = call(NEW_SESSION.to_owned(), "ctx_search", query.clone())
            .await
            .unwrap();
        println!(
            "QUEUE a ctx_search alone through Module::tool: {:.0} ms",
            ms(answered - asked)
        );

        // 2. A search, and 50 ms later a ctx_memory read on the same session
        // and one on another session.
        let started = Instant::now();
        let searching = call(NEW_SESSION.to_owned(), "ctx_search", query.clone());
        tokio::time::sleep(Duration::from_millis(50)).await;
        let same = call(NEW_SESSION.to_owned(), "ctx_memory", read.clone());
        let other = call(sessions[1].clone(), "ctx_memory", read.clone());
        let (_, search_done) = searching.await.unwrap();
        let (same_asked, same_done) = same.await.unwrap();
        let (other_asked, other_done) = other.await.unwrap();
        println!(
            "QUEUE ctx_search answered at {:.0} ms; ctx_memory on the same session asked at {:.0} ms, answered at {:.0} ms ({:.0} ms after the search); ctx_memory on another session asked at {:.0} ms, answered at {:.0} ms",
            ms(search_done - started),
            ms(same_asked - started),
            ms(same_done - started),
            ms(same_done.saturating_duration_since(search_done)),
            ms(other_asked - started),
            ms(other_done - started)
        );

        // 3. One search per worker thread and one more, on separate sessions,
        // while a timer measures how late the runtime runs other tasks.
        for concurrent in [1, workers + 1] {
            let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let probe = tokio::spawn(timer_lateness(Arc::clone(&stop)));
            tokio::time::sleep(Duration::from_millis(20)).await;
            let started = Instant::now();
            let searches: Vec<_> = sessions
                .iter()
                .skip(1)
                .take(concurrent)
                .map(|session| call(session.clone(), "ctx_search", query.clone()))
                .collect();
            let mut answered = Vec::new();
            for search in searches {
                answered.push(ms(search.await.unwrap().1 - started));
            }
            stop.store(true, std::sync::atomic::Ordering::SeqCst);
            let late = probe.await.unwrap();
            println!(
                "RUNTIME {workers} worker threads, {concurrent} searches at once: answered at {answered:.0?} ms; a 5 ms timer fired up to {:.0} ms late",
                ms(late)
            );
        }
    });
}
