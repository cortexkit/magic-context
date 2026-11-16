//! Migration 8 on populated stores: message rows become compact and read
//! back the same, summary rows go, and an interrupted or repeated run is
//! safe.
use super::persistence::{load_session, migrate_compact_rows};
use super::row::Row;
use super::tests::fixture;
use super::*;

/// The tables a version-7 store holds for app reads that version 8 changes.
const VERSION_SEVEN: &str = "
CREATE TABLE app_read_headers (
    runner TEXT NOT NULL, harness TEXT NOT NULL, session TEXT NOT NULL,
    header TEXT NOT NULL, PRIMARY KEY(runner,harness,session)
);
CREATE TABLE app_read_messages (
    runner TEXT NOT NULL, harness TEXT NOT NULL, session TEXT NOT NULL,
    message_id TEXT NOT NULL, ordinal INTEGER NOT NULL, at_ms INTEGER NOT NULL,
    row TEXT NOT NULL, PRIMARY KEY(runner,harness,session,message_id)
);
CREATE TABLE app_read_summaries (
    runner TEXT NOT NULL, harness TEXT NOT NULL, session TEXT NOT NULL,
    position INTEGER NOT NULL, row TEXT NOT NULL,
    PRIMARY KEY(runner,harness,session,position)
);
PRAGMA user_version = 7;";

/// One saved session: its key and its rows as the JSON text version 7 wrote.
struct Saved {
    key: SessionRef,
    rows: Vec<(String, u64, u64, String)>,
}

/// Sessions as version 7 saved them: the sample session's rows, which have
/// the projection's shape; the fixture's older rows; and one session with a
/// row that is not JSON.
fn version_seven_store(path: &std::path::Path) -> Vec<Saved> {
    let sample = crate::session::Session::app_sample_snapshot().rendered();
    let old = fixture();
    let rows = |messages: Vec<(String, u64, u64, Value)>| {
        messages
            .into_iter()
            .map(|(mid, ordinal, at_ms, row)| (mid, ordinal, at_ms, row.to_string()))
            .collect::<Vec<_>>()
    };
    let saved = vec![
        Saved {
            key: SessionRef::new("runner", "opencode2", "sample"),
            rows: rows(
                sample
                    .messages
                    .iter()
                    .map(|(mid, m)| (mid.clone(), m.ordinal, m.at_ms, m.row.clone()))
                    .collect(),
            ),
        },
        Saved {
            key: SessionRef::new("runner", "opencode2", "older"),
            rows: rows(
                old.messages
                    .iter()
                    .map(|(mid, m)| (mid.clone(), m.ordinal, m.at_ms, m.row.to_value(mid)))
                    .collect(),
            ),
        },
        Saved {
            key: SessionRef::new("runner", "pi", "broken"),
            rows: vec![("m1".into(), 1, 10, "not JSON".into())],
        },
    ];
    let conn = Connection::open(path).unwrap();
    conn.execute_batch(VERSION_SEVEN).unwrap();
    let header = Header {
        base: 1,
        newest: 5,
        ready: true,
        meta: sample.meta.clone(),
        breakdown: sample.breakdown.clone(),
    }
    .json();
    for session in &saved {
        let key = &session.key;
        conn.execute(
            "INSERT INTO app_read_headers VALUES (?1, ?2, ?3, ?4)",
            params![key.runner, key.harness, key.session, header],
        )
        .unwrap();
        for (mid, ordinal, at_ms, row) in &session.rows {
            conn.execute(
                "INSERT INTO app_read_messages VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![key.runner, key.harness, key.session, mid, ordinal, at_ms, row],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO app_read_summaries VALUES (?1, ?2, ?3, 0, ?4)",
            params![
                key.runner,
                key.harness,
                key.session,
                json!({"compartment_id":"1","summary_markdown":"A summary"}).to_string()
            ],
        )
        .unwrap();
    }
    saved
}

/// Every good session loads with each row rendering as the JSON it was
/// saved as, and the session whose row is not JSON still fails to load.
fn assert_rows_read_the_same(conn: &Connection, saved: &[Saved]) {
    for session in saved {
        let loaded = load_session(conn, &session.key);
        if session.key.session == "broken" {
            assert!(loaded.is_err(), "a row that is not JSON loads");
            continue;
        }
        let snapshot = loaded.unwrap().expect("saved session");
        assert_eq!(snapshot.messages.len(), session.rows.len());
        for (mid, ordinal, at_ms, text) in &session.rows {
            let message = &snapshot.messages[mid];
            assert_eq!((message.ordinal, message.at_ms), (*ordinal, *at_ms));
            assert_eq!(
                message.row.to_value(mid).to_string(),
                serde_json::from_str::<Value>(text).unwrap().to_string(),
                "{}/{mid}",
                session.key.session
            );
            if session.key.session == "sample" {
                assert!(matches!(message.row, Row::Typed(_)), "{mid} kept as JSON");
            }
        }
    }
}

fn kinds(conn: &Connection) -> Vec<String> {
    conn.prepare("SELECT DISTINCT typeof(row) FROM app_read_messages ORDER BY 1")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

fn tables(conn: &Connection) -> Vec<String> {
    conn.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'app_read_%' ORDER BY 1",
    )
    .unwrap()
    .query_map([], |row| row.get(0))
    .unwrap()
    .collect::<rusqlite::Result<_>>()
    .unwrap()
}

#[test]
fn opening_a_version_seven_store_compacts_its_rows_and_drops_its_summaries() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mode3.db");
    let saved = version_seven_store(&path);
    let before: u64 = Connection::open(&path)
        .unwrap()
        .query_row("SELECT SUM(length(row)) FROM app_read_messages", [], |row| row.get(0))
        .unwrap();
    drop(crate::store::Store::open(&path).unwrap());
    let conn = Connection::open(&path).unwrap();
    assert_eq!(
        conn.pragma_query_value::<u32, _>(None, "user_version", |row| row.get(0))
            .unwrap(),
        8
    );
    assert!(!tables(&conn).contains(&"app_read_summaries".to_owned()));
    assert!(!tables(&conn).contains(&"app_read_messages_compact".to_owned()));
    assert_eq!(kinds(&conn), ["blob"]);
    let declared: String = conn
        .query_row(
            "SELECT type FROM pragma_table_info('app_read_messages') WHERE name = 'row'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(declared, "BLOB");
    assert_rows_read_the_same(&conn, &saved);
    let after: u64 = conn
        .query_row("SELECT SUM(length(row)) FROM app_read_messages", [], |row| row.get(0))
        .unwrap();
    // The fixture's older rows stay JSON inside the compact form; the
    // sample session's typed rows take a fraction of their JSON.
    assert!(after * 3 < before, "{after} compact bytes from {before} JSON bytes");
    // The app reads answer from the compacted rows.
    drop(conn);
    let mut app = super::tests::replica(None);
    app.snapshots.clear();
    app.store = Some(Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap());
    app.load();
    let read = app
        .read(
            "context.states",
            &json!({"session":{"runner":"runner","harness":"opencode2","session":"sample"},"message_ids":["m2"]}),
        )
        .unwrap();
    assert_eq!(read["messages"][0]["parts"]["stamped"], 1);
}

#[test]
fn an_interrupted_compaction_leaves_version_seven_and_runs_again() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mode3.db");
    let saved = version_seven_store(&path);
    let conn = Connection::open(&path).unwrap();
    // A crash part way through: the transaction the store opens in never
    // commits, so the version-7 tables stay as they were.
    {
        let tx = conn.unchecked_transaction().unwrap();
        migrate_compact_rows(&tx).unwrap();
        assert_eq!(kinds(&tx), ["blob"]);
    }
    assert_eq!(kinds(&conn), ["text"]);
    assert!(tables(&conn).contains(&"app_read_summaries".to_owned()));
    // Rows already compact and a table left by an earlier attempt are taken
    // as they are.
    let first = conn
        .query_row(
            "SELECT message_id, row FROM app_read_messages WHERE session = 'sample' ORDER BY ordinal LIMIT 1",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .unwrap();
    let compact = Row::from_json(&first.0, serde_json::from_str(&first.1).unwrap()).encode();
    conn.execute(
        "UPDATE app_read_messages SET row = ?1 WHERE session = 'sample' AND message_id = ?2",
        params![compact, first.0],
    )
    .unwrap();
    conn.execute_batch(
        "CREATE TABLE app_read_messages_compact (runner TEXT, harness TEXT, session TEXT,
             message_id TEXT, ordinal INTEGER, at_ms INTEGER, row BLOB);
         INSERT INTO app_read_messages_compact VALUES ('runner','pi','stale','m9',9,9,X'00');",
    )
    .unwrap();
    assert_eq!(kinds(&conn), ["blob", "text"]);
    drop(conn);
    drop(crate::store::Store::open(&path).unwrap());
    let conn = Connection::open(&path).unwrap();
    assert_eq!(kinds(&conn), ["blob"]);
    assert!(!tables(&conn).contains(&"app_read_messages_compact".to_owned()));
    let stale: u64 = conn
        .query_row(
            "SELECT count(*) FROM app_read_messages WHERE session = 'stale'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(stale, 0);
    assert_rows_read_the_same(&conn, &saved);
    // Running it again over compact rows changes no byte.
    let dump = |conn: &Connection| -> Vec<Vec<u8>> {
        conn.prepare("SELECT row FROM app_read_messages ORDER BY session, message_id")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    };
    let compacted = dump(&conn);
    migrate_compact_rows(&conn).unwrap();
    assert_eq!(dump(&conn), compacted);
}

/// Times migration 8 on a generated store the size of a long-used one:
/// `MC_COMPACT_ROWS` rows (900,000 by default) of about 1.1 KB of JSON each,
/// over 1,000 sessions. Run it in release:
/// `cargo test --release -p mc-module --features agent-data --locked --lib
/// compacting_a_large_store -- --ignored --nocapture`.
#[test]
#[ignore = "generates about 1 GB; a timing, not a check"]
fn compacting_a_large_store() {
    use std::time::Instant;
    let count: u64 = std::env::var("MC_COMPACT_ROWS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(900_000);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mode3.db");
    let mut conn = Connection::open(&path).unwrap();
    conn.execute_batch("PRAGMA journal_mode = WAL;").unwrap();
    conn.execute_batch(VERSION_SEVEN).unwrap();
    let started = Instant::now();
    let tx = conn.transaction().unwrap();
    {
        let mut insert = tx
            .prepare("INSERT INTO app_read_messages VALUES ('runner', 'opencode2', ?1, ?2, ?3, ?4, ?5)")
            .unwrap();
        for n in 0..count {
            let session = format!("ses_{:04}", n % 1000);
            let mid = format!("msg_{n:012x}a7Yq3kLmN0pQ");
            let row = generated_row(n).to_value(&mid).to_string();
            insert
                .execute(params![session, mid, n, 1_700_000_000_000 + n, row])
                .unwrap();
        }
        let mut summaries = tx
            .prepare("INSERT INTO app_read_summaries VALUES ('runner', 'opencode2', ?1, ?2, ?3)")
            .unwrap();
        for n in 0..24_000u64 {
            summaries
                .execute(params![
                    format!("ses_{:04}", n % 1000),
                    n / 1000,
                    "summary text ".repeat(460)
                ])
                .unwrap();
        }
    }
    tx.commit().unwrap();
    let json_bytes: u64 = conn
        .query_row("SELECT SUM(length(row)) FROM app_read_messages", [], |row| row.get(0))
        .unwrap();
    let file_bytes = std::fs::metadata(&path).unwrap().len();
    println!(
        "generated {count} rows, {json_bytes} JSON bytes, {file_bytes} file bytes in {:.1} s",
        started.elapsed().as_secs_f64()
    );
    drop(conn);
    let started = Instant::now();
    drop(crate::store::Store::open(&path).unwrap());
    let elapsed = started.elapsed();
    let conn = Connection::open(&path).unwrap();
    let compact_bytes: u64 = conn
        .query_row("SELECT SUM(length(row)) FROM app_read_messages", [], |row| row.get(0))
        .unwrap();
    let rows: u64 = conn
        .query_row("SELECT count(*) FROM app_read_messages", [], |row| row.get(0))
        .unwrap();
    assert_eq!(rows, count);
    println!(
        "migration 8: {rows} rows in {:.1} s; rows {json_bytes} -> {compact_bytes} bytes",
        elapsed.as_secs_f64()
    );
}

/// A row like the ones long sessions hold: user words, or an assistant step
/// with text, reasoning and tool calls, some queued or dropped, with now and
/// then a row of an older shape.
fn generated_row(n: u64) -> Row {
    use super::row::{Kind, Origin, Part, PartOrigin, PartState, Size, Source, Typed};
    if n % 97 == 0 {
        return Row::from(json!({"message_id":"older","state":"raw","compartment_id":null,"outside_reason":null,"split":null,"stamped_parts":[],"dropped_parts":[],"parts":{"tagged":1,"stamped":0,"dropped":0}}));
    }
    let state = |at: u64| match (n + at) % 7 {
        0 => PartState::Stamped {
            at_ms: Some(1_700_000_000_000 + n),
            size: Size {
                bytes: Some(4_000 + n % 900),
                tokens: 900 + n % 300,
            },
        },
        1 => PartState::Dropped {
            size: Size {
                bytes: Some(12_000),
                tokens: 3_000,
            },
        },
        _ => PartState::Live,
    };
    let part = |at: u64, kind: Kind, origin: PartOrigin, tool: Option<&str>| Part {
        id: format!("prt_{n:010x}{at}Zx8wVbT2").into(),
        kind,
        tokens: 40 + (n * 7 + at) % 2_000,
        source: if tool.is_some() {
            Source::Runner
        } else {
            Source::Counted
        },
        state: state(at),
        origin,
        tool: tool.map(Into::into),
    };
    if n % 3 == 0 {
        let origin = if n % 2 == 0 {
            Origin::Person
        } else {
            Origin::Notice {
                sender: "prefrontal".into(),
                speaks_for: Some(("agent_7f3a".into(), Some("BROCA".into()))),
            }
        };
        return Row::Typed(Typed::new(
            1,
            vec![part(0, Kind::Text, PartOrigin::User, None)],
            Some(&origin),
            &[],
        ));
    }
    let tools = ["read", "bash", "edit", "grep"];
    let mut parts = vec![
        part(0, Kind::Reasoning, PartOrigin::None, None),
        part(1, Kind::Text, PartOrigin::None, None),
    ];
    for at in 0..(n % 6) {
        parts.push(part(
            2 + at,
            Kind::Tool,
            PartOrigin::None,
            Some(tools[(at as usize) % tools.len()]),
        ));
    }
    Row::Typed(Typed::new(parts.len() as u64, parts, None, &[]))
}
