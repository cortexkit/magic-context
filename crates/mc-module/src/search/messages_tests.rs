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
    coverage.for_snapshot(0);
    let reached: Vec<Reach> = SESSIONS
        .iter()
        .map(|session| reach(&conn, &mut coverage, session, None))
        .collect();
    // A session with rows the map lacks is screened by those rows' rowids
    // besides its mapped ones: here, every one of them, in order.
    let partly = |session: &str, count: usize| {
        let rowids: Vec<i64> = conn
            .prepare(
                "SELECT rowid FROM message_history_fts
                  WHERE session_id = ?1
                    AND rowid NOT IN (SELECT fts_rowid FROM message_fts_rowid_map)
                  ORDER BY rowid",
            )
            .unwrap()
            .query_map([session], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(rowids.len(), count, "{session}");
        Reach::Partly(rowids.into())
    };
    assert_eq!(
        reached,
        [
            Reach::Mapped,
            Reach::Mapped,
            partly("partly", 15),
            partly("legacy", 30),
            partly("duplicated", 1),
            Reach::Mapped,
            Reach::Nothing,
        ]
    );
    assert_eq!(coverage.scans(), 1);
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
                        search_at(&conn, session, &wanted, &[30, 75], cutoff, relaxed, &reach);
                    let unscreened = search_at(
                        &conn,
                        session,
                        &wanted,
                        &[30, 75],
                        cutoff,
                        relaxed,
                        &Reach::Unmapped,
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
                        &reach
                    ),
                    count_live_matches(
                        &conn,
                        session,
                        query,
                        cutoff,
                        dates,
                        visible.as_ref(),
                        &Reach::Unmapped
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
                        &reach,
                    );
                    assert_eq!(
                        both,
                        [
                            search(&conn, session, &wanted(shallow), cutoff, true, &reach),
                            search(&conn, session, &wanted(deep), cutoff, true, &reach),
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
    static ROW_LOADS: Cell<usize> = const { Cell::new(0) };
}

fn count_reads(sql: &str) {
    if sql.contains("message_history_fts MATCH") {
        MESSAGE_READS.with(|reads| reads.set(reads.get() + 1));
    }
    if sql.contains("ORDER BY bm25(message_history_fts)") {
        RANKED_READS.with(|reads| reads.set(reads.get() + 1));
    }
    // FTS5's own read of one stored row, which it makes the first time a
    // query reads a column other than the rowid of a match.
    if sql.contains("'message_history_fts_content'") {
        ROW_LOADS.with(|loads| loads.set(loads.get() + 1));
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

/// How many stored rows of the full-text table `work` loads on `conn`.
fn row_loads_during(conn: &mut Connection, work: impl FnOnce(&Connection)) -> usize {
    ROW_LOADS.with(|loads| loads.set(0));
    conn.trace(Some(count_reads));
    work(conn);
    conn.trace(None);
    ROW_LOADS.with(Cell::get)
}

/// A session with rows the map lacks is screened like a covered one: its
/// reads load the stored rows of its own matches only. Unscreened, a read
/// loads the stored row of every match in the store to learn its session,
/// which on a store of two million messages takes seconds per read.
#[test]
fn a_partly_mapped_session_loads_only_its_own_stored_rows() {
    let store = Store::new();
    let mut conn = store.read_only();
    let matches = |conn: &Connection, filter: &str| -> usize {
        conn.query_row(
            &format!(
                "SELECT COUNT(*) FROM message_history_fts
                  WHERE message_history_fts MATCH 'content : (\"alpha\")' {filter}"
            ),
            [],
            |row| row.get(0),
        )
        .unwrap()
    };
    let everywhere = matches(&conn, "");
    for session in ["partly", "legacy", "duplicated"] {
        let own = matches(&conn, &format!("AND session_id = '{session}'"));
        assert!(
            own > 0 && everywhere > 2 * own,
            "{session}: {own} of {everywhere}"
        );
        conn.execute_batch("BEGIN").unwrap();
        let reach = reach(&conn, &mut Coverage::default(), session, None);
        // The two counts of `count_live_matches` each load every match they
        // test for its session once.
        let loads = |conn: &mut Connection, reach: &Reach| {
            row_loads_during(conn, |conn| {
                count_live_matches(conn, session, "alpha", 20, None, None, reach);
            })
        };
        assert_eq!(loads(&mut conn, &reach), 2 * own, "{session} {reach:?}");
        // The count is not vacuous: unscreened, every match in the store loads.
        assert_eq!(
            loads(&mut conn, &Reach::Unmapped),
            2 * everywhere,
            "{session}"
        );
        conn.execute_batch("COMMIT").unwrap();
    }
}

fn scope<'a>(
    session: &'a str,
    seen: &'a std::collections::BTreeMap<i64, String>,
) -> super::super::Scope<'a> {
    super::super::Scope {
        harness: "mock",
        session,
        project: None,
        workspace: None,
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
fn an_unrelated_memory_retrieval_commit_does_not_rescan_message_coverage() {
    let store = Store::new();
    let db = &store._db;
    db.with_connection(|conn| {
        conn.execute("INSERT INTO memories (level, owner_id, category, origin_category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES ('project', 'p', 'swe:architecture', 'ARCHITECTURE', 'Memory', 'hash', 1, 1, 1, 1)", []).unwrap();
    });
    let ask = || {
        db.with_search_reader(|conn, coverage| {
            assert!(coverage.complete(conn, "mapped"));
            coverage.scans()
        })
    };
    assert_eq!(ask(), 1);
    db.with_connection(|conn| {
        conn.execute(
            "UPDATE memories SET retrieval_count = retrieval_count + 1 WHERE owner_id = 'p'",
            [],
        )
        .unwrap();
    });
    assert_eq!(
        ask(),
        1,
        "the retrieval count did not change the message index"
    );
}

#[test]
fn an_index_commit_refreshes_a_read_only_coverage_proof() {
    let store = Store::new();
    let db = &store._db;
    let ask = |session: &str| {
        db.with_search_reader(|conn, coverage| (coverage.complete(conn, session), coverage.scans()))
    };
    assert_eq!(ask("neighbour"), (true, 1));
    assert_eq!(ask("partly"), (false, 1));

    let mut writer = Connection::open(&store.path).unwrap();
    let entry = Entry::new(
        51,
        "neighbour-51",
        cortexkit_role_compaction::read::Role::User,
        51_000,
        vec![cortexkit_role_compaction::part::Part::new(
            "p",
            cortexkit_role_compaction::part::PartBody::Text {
                text: "alpha beta".into(),
            },
        )],
    );
    index_with_generation(
        &mut writer,
        &db.message_index,
        "mock",
        "neighbour",
        std::slice::from_ref(&entry),
    )
    .unwrap();
    assert_eq!(ask("neighbour"), (true, 2));
    index_with_generation(
        &mut writer,
        &db.message_index,
        "mock",
        "neighbour",
        &[entry],
    )
    .unwrap();
    assert_eq!(
        ask("neighbour"),
        (true, 2),
        "a watermark-only write is not an index change"
    );
    // A write during this read leaves its old snapshot and proof intact.
    // The next call to with_search_reader must see the new unmapped row.
    db.with_search_reader(|conn, coverage| {
        let tx = writer.transaction().unwrap();
        write(&tx, "neighbour", 52, "alpha beta", false);
        db.message_index.commit(tx, true).unwrap();
        assert!(coverage.complete(conn, "neighbour"));
        assert_eq!(coverage.scans(), 2);
    });
    assert_eq!(ask("neighbour"), (false, 3));
    // A connection that can write proves again on every read.
    let mut own = Coverage::default();
    writer.execute_batch("BEGIN").unwrap();
    assert!(own.complete(&writer, "mapped"));
    assert!(own.complete(&writer, "mapped"));
    writer.execute_batch("COMMIT").unwrap();
    assert_eq!(own.scans(), 2);
}
