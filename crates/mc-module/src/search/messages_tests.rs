//! The message lane gives the same results whichever way it reaches a
//! session's rows: screened by the session's rowid map, through every
//! match's session id, or not at all for a session with nothing indexed;
//! and a search at two depths gives what two searches would.

use std::cell::Cell;
use std::collections::BTreeSet;

use rusqlite::{params, Connection, OpenFlags};

use super::*;

/// A store with sessions whose rows the map covers fully, partly or not at
/// all, sharing one vocabulary so most queries match in every session.
struct Store {
    path: std::path::PathBuf,
    // Kept open so the store's WAL files stay while the test reads it.
    _db: crate::context_db::ContextDb,
    _dir: tempfile::TempDir,
}

const WORDS: [&str; 12] = [
    "alpha", "beta", "gamma", "store", "embed", "memories", "upkeep", "search", "cache", "parser",
    "quoted", "summary",
];

/// Message `ordinal` of a session, written when `mapped` with its rowid-map
/// row, as every current writer does, or without one, as rows written
/// before the map existed were.
fn write(conn: &Connection, session: &str, ordinal: i64, content: &str, mapped: bool) {
    conn.execute(
        "INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content)
         VALUES (?1, ?2, ?3, 'user', ?4)",
        params![session, ordinal, format!("{session}-{ordinal}"), content],
    )
    .unwrap();
    if mapped {
        conn.execute(
            "INSERT OR REPLACE INTO message_fts_rowid_map (session_id, message_ordinal, fts_rowid, message_time_ms)
             VALUES (?1, ?2, ?3, ?4)",
            params![session, ordinal, conn.last_insert_rowid(), ordinal * 1_000],
        )
        .unwrap();
    }
}

fn set_watermark(conn: &Connection, session: &str, mark: i64) {
    conn.execute(
        "INSERT INTO message_history_index (session_id, last_indexed_ordinal, dirty_floor_ordinal, updated_at, harness)
         VALUES (?1, ?2, 0, 0, 'mock')",
        params![session, mark],
    )
    .unwrap();
}

/// A deterministic message of eight to twenty words; every message also
/// names its own number, so `upkeep_store_7` finds message 7 verbatim.
fn content(seed: &mut u64, ordinal: i64) -> String {
    let mut next = || {
        *seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (*seed >> 33) as usize
    };
    let count = 8 + next() % 13;
    let mut words: Vec<String> = (0..count)
        .map(|_| WORDS[next() % WORDS.len()].to_owned())
        .collect();
    words.push(format!("upkeep_store_{}", ordinal % 9));
    words.join(" ")
}

impl Store {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("context.db");
        let db = crate::context_db::ContextDb::create_for_tests(&path).unwrap();
        db.with_connection(|conn| {
            let tx = conn.transaction().unwrap();
            let mut seed = 7;
            // Rows of several sessions interleave, as they do in a shared store.
            for ordinal in 1..=60 {
                for (session, last, mapped_through) in [
                    ("mapped", 60, 60),
                    ("neighbour", 50, 50),
                    ("partly", 40, 25),
                    ("legacy", 30, 0),
                ] {
                    if ordinal <= last {
                        let text = content(&mut seed, ordinal);
                        write(&tx, session, ordinal, &text, ordinal <= mapped_through);
                    }
                }
            }
            // A second, unmapped row for one message: the map points at one
            // of the two only, as when a message was indexed twice before the
            // map existed.
            write(&tx, "duplicated", 1, "alpha beta store", true);
            write(&tx, "duplicated", 2, "gamma store embed", true);
            write(&tx, "duplicated", 2, "gamma store cache", false);
            for (session, mark) in [
                ("mapped", 60),
                ("neighbour", 50),
                ("partly", 40),
                ("legacy", 30),
                ("duplicated", 2),
                // Messages with no text: indexed, with no rows.
                ("textless", 4),
            ] {
                set_watermark(&tx, session, mark);
            }
            tx.commit().unwrap();
        });
        Store {
            path,
            _db: db,
            _dir: dir,
        }
    }

    fn read_only(&self) -> Connection {
        let conn =
            Connection::open_with_flags(&self.path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        conn.busy_timeout(std::time::Duration::from_secs(1))
            .unwrap();
        conn
    }
}

const SESSIONS: [&str; 7] = [
    "mapped",
    "neighbour",
    "partly",
    "legacy",
    "duplicated",
    "textless",
    "fresh",
];

const QUERIES: [&str; 5] = [
    // ANDed form matches.
    "alpha beta",
    // ANDed form finds nothing, so the ORed fallback ranks.
    "alpha nonexistentword",
    // Prose, as a reranked search reads it.
    "how does the store embed memories",
    // An identifier, which adds literal probes.
    "upkeep_store_4 cache",
    // Matches nothing anywhere.
    "zzzz",
];

/// Every combination of cutoff, visibility and dates a search can carry.
fn filters() -> Vec<(i64, Option<BTreeSet<i64>>, Option<DateRange>)> {
    let mut all = Vec::new();
    for cutoff in [i64::MAX, 20] {
        for visible in [None, Some(BTreeSet::from([1, 2, 3, 15]))] {
            for dates in [
                None,
                Some(DateRange {
                    from: 5_000,
                    to: 35_000,
                }),
            ] {
                all.push((cutoff, visible.clone(), dates));
            }
        }
    }
    all
}

#[test]
fn reach_follows_the_rowid_map_coverage() {
    let store = Store::new();
    let conn = store.read_only();
    conn.execute_batch("BEGIN").unwrap();
    let mut coverage = Coverage::default();
    let reached: Vec<Reach> = SESSIONS
        .iter()
        .map(|session| reach(&conn, &mut coverage, session, None))
        .collect();
    assert_eq!(
        reached,
        [
            Reach::Mapped,
            Reach::Mapped,
            Reach::Unmapped,
            Reach::Unmapped,
            Reach::Unmapped,
            Reach::Mapped,
            Reach::Nothing,
        ]
    );
    // A dated read joins the map anyway, so it is always screened.
    let dates = Some(DateRange { from: 0, to: 1 });
    assert_eq!(reach(&conn, &mut coverage, "legacy", dates), Reach::Mapped);
    assert_eq!(reach(&conn, &mut coverage, "fresh", dates), Reach::Nothing);
    conn.execute_batch("COMMIT").unwrap();
}

#[test]
fn screened_and_unscreened_reads_find_the_same_messages_in_every_session() {
    let store = Store::new();
    let conn = store.read_only();
    let mut coverage = Coverage::default();
    let mut compared = 0;
    for session in SESSIONS {
        for query in QUERIES {
            let probes = super::super::text::literal_probes(query);
            for (cutoff, visible, dates) in filters() {
                let reach = reach(&conn, &mut coverage, session, dates);
                let wanted = Query {
                    text: query,
                    limit: 30,
                    probes: &probes,
                    dates,
                    visible: visible.as_ref(),
                };
                for relaxed in [true, false] {
                    let screened =
                        search_at(&conn, session, &wanted, &[30, 75], cutoff, relaxed, reach);
                    let unscreened = search_at(
                        &conn,
                        session,
                        &wanted,
                        &[30, 75],
                        cutoff,
                        relaxed,
                        Reach::Unmapped,
                    );
                    assert_eq!(
                        screened, unscreened,
                        "{session} {query:?} cutoff {cutoff} {visible:?} {dates:?} relaxed {relaxed}"
                    );
                    compared += usize::from(!unscreened[1].is_empty());
                }
                assert_eq!(
                    count_live_matches(
                        &conn,
                        session,
                        query,
                        cutoff,
                        dates,
                        visible.as_ref(),
                        reach
                    ),
                    count_live_matches(
                        &conn,
                        session,
                        query,
                        cutoff,
                        dates,
                        visible.as_ref(),
                        Reach::Unmapped
                    ),
                    "{session} {query:?} cutoff {cutoff} {visible:?} {dates:?}"
                );
            }
        }
    }
    // The comparison is not vacuous: most cases found messages.
    assert!(compared > 100, "{compared}");
}

#[test]
fn one_read_at_two_depths_equals_two_searches() {
    let store = Store::new();
    let conn = store.read_only();
    let mut coverage = Coverage::default();
    for session in SESSIONS {
        for query in QUERIES {
            let probes = super::super::text::literal_probes(query);
            for (cutoff, visible, dates) in filters() {
                let reach = reach(&conn, &mut coverage, session, dates);
                let wanted = |limit| Query {
                    text: query,
                    limit,
                    probes: &probes,
                    dates,
                    visible: visible.as_ref(),
                };
                for (shallow, deep) in [(30, 75), (12, 75), (75, 30)] {
                    let both = search_at(
                        &conn,
                        session,
                        &wanted(shallow),
                        &[shallow, deep],
                        cutoff,
                        true,
                        reach,
                    );
                    assert_eq!(
                        both,
                        [
                            search(&conn, session, &wanted(shallow), cutoff, true, reach),
                            search(&conn, session, &wanted(deep), cutoff, true, reach),
                        ],
                        "{session} {query:?} {shallow}/{deep} cutoff {cutoff} {visible:?} {dates:?}"
                    );
                }
            }
        }
    }
}

thread_local! {
    static RANKED_READS: Cell<usize> = const { Cell::new(0) };
    static MESSAGE_READS: Cell<usize> = const { Cell::new(0) };
}

fn count_reads(sql: &str) {
    if sql.contains("message_history_fts MATCH") {
        MESSAGE_READS.with(|reads| reads.set(reads.get() + 1));
    }
    if sql.contains("ORDER BY bm25(message_history_fts)") {
        RANKED_READS.with(|reads| reads.set(reads.get() + 1));
    }
}

/// The ranked message reads and all message reads `work` runs on `conn`.
fn reads_during(conn: &mut Connection, work: impl FnOnce(&Connection)) -> (usize, usize) {
    RANKED_READS.with(|reads| reads.set(0));
    MESSAGE_READS.with(|reads| reads.set(0));
    conn.trace(Some(count_reads));
    work(conn);
    conn.trace(None);
    (RANKED_READS.with(Cell::get), MESSAGE_READS.with(Cell::get))
}

fn scope<'a>(
    session: &'a str,
    seen: &'a std::collections::BTreeMap<i64, String>,
) -> super::super::Scope<'a> {
    super::super::Scope {
        harness: "mock",
        session,
        project: None,
        cutoff: i64::MAX,
        visible_messages: None,
        seen,
        memory_enabled: false,
        git_commits_enabled: false,
        git_repository: None,
        semantic: None,
    }
}

#[test]
fn a_reranked_search_reads_the_message_lane_no_more_than_a_plain_one() {
    let store = Store::new();
    let mut conn = store.read_only();
    let seen = std::collections::BTreeMap::new();
    for (query, ranked) in [
        // The ANDed form finds messages: one ranked read.
        ("alpha beta", 1),
        // It finds none, so the ORed form is read too.
        ("alpha nonexistentword", 2),
    ] {
        let input = serde_json::json!({"query": query, "sources": ["message"]});
        let mut prepared = Vec::new();
        for pool in [None, Some(super::super::rerank::POOL)] {
            let reads = reads_during(&mut conn, |conn| {
                let mut coverage = Coverage::default();
                prepared.push(
                    super::super::prepare(
                        conn,
                        &mut coverage,
                        &scope("mapped", &seen),
                        &input,
                        pool,
                    )
                    .unwrap(),
                );
            });
            assert_eq!(reads.0, ranked, "{query:?} pool {pool:?}");
        }
        // The reranked search ranks its own results as the plain one does,
        // and has candidates for the reranker.
        assert_eq!(prepared[0].hits, prepared[1].hits, "{query:?}");
        assert!(!prepared[1].pool.is_empty(), "{query:?}");
    }
}

#[test]
fn a_session_with_nothing_indexed_reads_no_messages() {
    let store = Store::new();
    let mut conn = store.read_only();
    let seen = std::collections::BTreeMap::new();
    let input = serde_json::json!({"query": "how does the store embed memories"});
    let (_, fresh) = reads_during(&mut conn, |conn| {
        let mut coverage = Coverage::default();
        super::super::prepare(conn, &mut coverage, &scope("fresh", &seen), &input, None).unwrap();
    });
    assert_eq!(fresh, 0);
    // A session with rows reads them: the count above is not vacuous.
    let (_, indexed) = reads_during(&mut conn, |conn| {
        let mut coverage = Coverage::default();
        super::super::prepare(conn, &mut coverage, &scope("mapped", &seen), &input, None).unwrap();
    });
    assert!(indexed > 0);
}

#[test]
fn a_read_only_connection_reuses_its_proof_until_the_store_changes() {
    let store = Store::new();
    let conn = store.read_only();
    let mut coverage = Coverage::default();
    let ask = |coverage: &mut Coverage, session: &str| {
        conn.execute_batch("BEGIN").unwrap();
        let complete = coverage.complete(&conn, session);
        conn.execute_batch("COMMIT").unwrap();
        complete
    };
    assert!(ask(&mut coverage, "neighbour"));
    assert!(!ask(&mut coverage, "partly"));
    assert_eq!(coverage.scans(), 1);
    // Another connection adds a row the map lacks to a covered session.
    let writer = Connection::open(&store.path).unwrap();
    write(&writer, "neighbour", 51, "alpha beta", false);
    assert!(!ask(&mut coverage, "neighbour"));
    assert_eq!(coverage.scans(), 2);
    // A connection that can write proves again on every read.
    let mut own = Coverage::default();
    writer.execute_batch("BEGIN").unwrap();
    assert!(own.complete(&writer, "mapped"));
    assert!(own.complete(&writer, "mapped"));
    writer.execute_batch("COMMIT").unwrap();
    assert_eq!(own.scans(), 2);
}
