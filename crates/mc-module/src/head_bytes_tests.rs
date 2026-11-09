//! The history head, the views that carry it, the apps' token breakdown and
//! the saved session state, byte for byte, across the states a head goes
//! through: its first render, a rebuild with nothing new, newer summaries in
//! `m[1]`, a reverted summary, memory changes, a fold, a refold forced by a
//! large `m[1]`, and a restart from the store.
//!
//! The bytes are compared with `testdata/head-bytes-df3a14aa.json`. Build
//! df3a14aa, the last one that copied every summary's attribution on every
//! step, wrote that file by running this test with `MC_HEAD_BYTES_OUT` set
//! to its path. Sharing that attribution between steps must change none of
//! these bytes. A later change meant to change them writes the file again
//! the same way and says why in its commit.

use super::*;

const GOLDEN: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/testdata/head-bytes-df3a14aa.json"
);

/// One summary over messages `4k-3..=4k`, with every detail tier.
pub(super) fn add_summary(session: &Session, sequence: i64, body: &str) {
    let (start, end) = (sequence * 4 - 3, sequence * 4);
    session.db.as_ref().unwrap().with_connection(|conn| {
        conn.execute(
            "INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, p1, p2, p3, p4, importance, created_at, harness) VALUES ('s1', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8, ?9, ?10, ?11, ?1, 'mock')",
            rusqlite::params![
                sequence,
                start,
                end,
                format!("m{start}"),
                format!("m{end}"),
                format!("Work {sequence}"),
                format!("Summary {sequence}: {body}"),
                format!("Shorter {sequence}: {}", &body[..body.len().min(80)]),
                format!("Brief {sequence}"),
                format!("Cue {sequence}"),
                30 + sequence * 7 % 50,
            ],
        )
        .map_err(|error| error.to_string())
    })
    .unwrap();
}

pub(super) fn execute(session: &Session, sql: &str) {
    session
        .db
        .as_ref()
        .unwrap()
        .with_connection(|conn| conn.execute_batch(sql).map_err(|error| error.to_string()))
        .unwrap();
}

/// A head session with a project, three memories, a profile line, three
/// summaries and sixty messages.
pub(super) fn head(dir: &std::path::Path) -> (Session, Settings) {
    let (mut session, _, _, _, settings) = fixture();
    let db = ContextDb::create_for_tests(&dir.join("context.db")).unwrap();
    session.db = Some(Arc::new(db));
    session.features.summarizer = true;
    std::fs::write(
        dir.join("ARCHITECTURE.md"),
        "# Architecture\n\nThe layers.\n",
    )
    .unwrap();
    session.project = Some(Project {
        id: "own".into(),
        root: dir.to_string_lossy().into(),
    });
    execute(
        &session,
        "INSERT INTO memories(id,project_path,category,content,normalized_hash,importance,first_seen_at,created_at,updated_at,last_seen_at) VALUES
            (1,'own','PROJECT_RULES','Run the gate before every delivery.','h1',80,1,1,1,1),
            (2,'own','ARCHITECTURE','The store keeps one row per session.','h2',70,1,1,1,1),
            (3,'own','NAMING','Files are kebab-case.','h3',60,1,1,1,1);
         INSERT INTO user_memories(content, promoted_at, source_candidate_provenance, created_at, updated_at)
            VALUES ('Prefers short answers', 1, '[]', 1, 1);",
    );
    for sequence in 1..=3 {
        add_summary(
            &session,
            sequence,
            &"We read the parser and kept its diagnostics stable. ".repeat(3),
        );
    }
    session.load_summaries();
    session
        .index
        .extend((1..=60).map(|n| text(n, &format!("m{n}"))));
    session.index_ready = true;
    (session, settings)
}

/// What one state publishes and saves, each as the bytes it is written as.
fn record(
    name: &str,
    session: &mut Session,
    settings: &Settings,
    store: &crate::store::Store,
    dir: &std::path::Path,
) -> Value {
    let (view, _) = session.build(settings, None, false, None);
    if let Some(view) = &view {
        session.accept(view.clone());
        session.settle_unconfirmed(
            Some(&AppliedView::new(view.version, view.checksum.clone())),
            &[],
        );
    }
    let update = session.app_update();
    store.save(&session.key, &session.durable()).unwrap();
    serde_json::json!({
        "state": name,
        "view": view.as_ref().map(|view| serde_json::to_string(view).unwrap()),
        "baseline": serde_json::to_string(&session.baseline).unwrap(),
        "header": serde_json::to_string(&*update.header).unwrap(),
        "stored": stored(dir),
    })
}

/// The session's saved state and the history text it refers to, as the
/// store holds them.
fn stored(dir: &std::path::Path) -> Value {
    let conn = rusqlite::Connection::open(dir.join("mode3.db")).unwrap();
    let state: String = conn
        .query_row("SELECT state FROM sessions WHERE session='s1'", [], |row| {
            row.get(0)
        })
        .unwrap();
    let mut texts = conn
        .prepare("SELECT id, text FROM state_texts ORDER BY id")
        .unwrap();
    let texts: Vec<(String, String)> = texts
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    serde_json::json!({"state": state, "texts": texts})
}

#[test]
fn head_bytes_match_the_build_before_summary_attribution_was_shared() {
    let dir = scratch("head-bytes");
    let store = crate::store::Store::open(&dir.join("mode3.db")).unwrap();
    let (mut session, settings) = head(&dir);
    let mut states = vec![record(
        "first render",
        &mut session,
        &settings,
        &store,
        &dir,
    )];
    states.push(record("nothing new", &mut session, &settings, &store, &dir));

    add_summary(&session, 4, "Newer work on the reader.");
    add_summary(&session, 5, "Newer work on the writer.");
    session.load_summaries();
    session.summary_unshown = true;
    states.push(record(
        "newer summaries",
        &mut session,
        &settings,
        &store,
        &dir,
    ));
    add_summary(&session, 6, "The newest work, reverted next.");
    session.load_summaries();
    session.summary_unshown = true;
    states.push(record(
        "one more newer summary",
        &mut session,
        &settings,
        &store,
        &dir,
    ));
    session.forget_summaries_from(21);
    states.push(record(
        "a summary in m[1] reverted",
        &mut session,
        &settings,
        &store,
        &dir,
    ));

    execute(
        &session,
        "UPDATE memories SET content='The store keeps one row per session, and its history text apart.' WHERE id=2;
         UPDATE memories SET status='archived' WHERE id=3;
         INSERT INTO memories(id,project_path,category,content,normalized_hash,importance,first_seen_at,created_at,updated_at,last_seen_at)
            VALUES (4,'own','CONSTRAINTS','Never open the live stores.','h4',90,2,2,2,2);",
    );
    session.head_stale = true;
    states.push(record(
        "memory changes",
        &mut session,
        &settings,
        &store,
        &dir,
    ));

    session.fold_due = true;
    states.push(record("fold", &mut session, &settings, &store, &dir));
    add_summary(&session, 6, "Work after the fold.");
    session.load_summaries();
    session.summary_unshown = true;
    states.push(record(
        "newer summary after the fold",
        &mut session,
        &settings,
        &store,
        &dir,
    ));

    // Newer summaries this large outgrow `m[1]`'s share of `m[0]`: the
    // rebuild folds instead.
    for sequence in 7..=9 {
        add_summary(
            &session,
            sequence,
            &"A long stretch of work that the refold takes into m[0]. ".repeat(60),
        );
    }
    session.load_summaries();
    session.summary_unshown = true;
    states.push(record(
        "refold for a large m[1]",
        &mut session,
        &settings,
        &store,
        &dir,
    ));

    // A restart: a new session takes the saved state and the view the
    // runner holds, then shows a newer summary.
    let (mut restored, _, _, _, _) = fixture();
    restored.db = session.db.clone();
    restored.features.summarizer = true;
    restored.project = session.project.clone();
    // Summaries load first, as a restart does: state ahead of them is distrusted.
    restored.load_summaries();
    restored.restore(store.load(&session.key).unwrap());
    restored.latest = session.latest.clone();
    restored.latest_unknown = false;
    restored.index.extend(session.index.entries().to_vec());
    restored.index_ready = true;
    add_summary(&restored, 10, "Work after the restart.");
    restored.load_summaries();
    restored.summary_unshown = true;
    states.push(record(
        "newer summary after a restart",
        &mut restored,
        &settings,
        &store,
        &dir,
    ));
    execute(
        &restored,
        "UPDATE memories SET content='Run the gate before every delivery, on Linux.' WHERE id=1;",
    );
    restored.head_stale = true;
    states.push(record(
        "memory change after a restart",
        &mut restored,
        &settings,
        &store,
        &dir,
    ));

    if let Some(path) = std::env::var_os("MC_HEAD_BYTES_OUT") {
        std::fs::write(path, serde_json::to_string_pretty(&states).unwrap()).unwrap();
        std::fs::remove_dir_all(dir).unwrap();
        return;
    }
    let golden: Vec<Value> =
        serde_json::from_str(&std::fs::read_to_string(GOLDEN).unwrap()).unwrap();
    assert_eq!(golden.len(), states.len());
    for (before, now) in golden.iter().zip(&states) {
        assert_eq!(before["state"], now["state"]);
        for field in ["view", "baseline", "header", "stored"] {
            assert_eq!(
                before[field], now[field],
                "{}: {field} is not what the earlier build wrote",
                now["state"]
            );
        }
    }

    // State the earlier build saved loads here as the same session state,
    // and saves as the same bytes.
    let last = &golden.last().unwrap()["stored"];
    let copy = dir.join("earlier.db");
    let earlier = crate::store::Store::open(&copy).unwrap();
    drop(earlier);
    let conn = rusqlite::Connection::open(&copy).unwrap();
    conn.execute(
        "INSERT INTO sessions (runner, harness, session, state) VALUES ('test', 'mock', 's1', ?1)",
        [last["state"].as_str().unwrap()],
    )
    .unwrap();
    for text in last["texts"].as_array().unwrap() {
        conn.execute(
            "INSERT INTO state_texts (id, text) VALUES (?1, ?2)",
            [text[0].as_str().unwrap(), text[1].as_str().unwrap()],
        )
        .unwrap();
    }
    drop(conn);
    let earlier = crate::store::Store::open(&copy).unwrap();
    let loaded = earlier.load(&restored.key).unwrap();
    assert_eq!(loaded, restored.durable());
    let again = dir.join("again.db");
    crate::store::Store::open(&again)
        .unwrap()
        .save(&restored.key, &loaded)
        .unwrap();
    let saved: String = rusqlite::Connection::open(&again)
        .unwrap()
        .query_row("SELECT state FROM sessions", [], |row| row.get(0))
        .unwrap();
    assert_eq!(saved, last["state"].as_str().unwrap());
    std::fs::remove_dir_all(dir).unwrap();
}
