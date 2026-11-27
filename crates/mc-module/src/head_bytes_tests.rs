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
use cortexkit_role_compaction::view::View;

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
        "INSERT INTO memories(id,level, owner_id,category, origin_category,content,normalized_hash,importance,first_seen_at,created_at,updated_at,last_seen_at) VALUES
            (1,'project', 'own','swe:project-rules', 'PROJECT_RULES','Run the gate before every delivery.','h1',80,1,1,1,1),
            (2,'project', 'own','swe:architecture', 'ARCHITECTURE','The store keeps one row per session.','h2',70,1,1,1,1),
            (3,'project', 'own','swe:naming', 'NAMING','Files are kebab-case.','h3',60,1,1,1,1);
         INSERT INTO memories(id, level, owner_id, category, origin_category, content, normalized_hash,
            first_seen_at, created_at, updated_at, last_seen_at, status, metadata_json)
            VALUES (100, 'global', 'self', 'mc:user-unsorted', 'USER_MEMORY', 'Prefers short answers',
            'h-user', 1, 1, 1, 1, 'active', json_object('user_memory_id', 1, 'promoted_at', 1));",
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
    let conn = rusqlite::Connection::open(dir.join("sessions.db")).unwrap();
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

/// The states up to a restart: the session that was saved, its settings and
/// what each state published.
fn states_until_restart(
    dir: &std::path::Path,
    store: &crate::store::Store,
) -> (Session, Settings, Vec<Value>) {
    let (mut session, settings) = head(dir);
    let mut states = vec![record("first render", &mut session, &settings, store, dir)];
    states.push(record("nothing new", &mut session, &settings, store, dir));

    add_summary(&session, 4, "Newer work on the reader.");
    add_summary(&session, 5, "Newer work on the writer.");
    session.load_summaries();
    session.summary_unshown = true;
    states.push(record(
        "newer summaries",
        &mut session,
        &settings,
        store,
        dir,
    ));
    add_summary(&session, 6, "The newest work, reverted next.");
    session.load_summaries();
    session.summary_unshown = true;
    states.push(record(
        "one more newer summary",
        &mut session,
        &settings,
        store,
        dir,
    ));
    session.forget_summaries_from(21);
    states.push(record(
        "a summary in m[1] reverted",
        &mut session,
        &settings,
        store,
        dir,
    ));

    execute(
        &session,
        "UPDATE memories SET content='The store keeps one row per session, and its history text apart.' WHERE id=2;
         UPDATE memories SET status='archived' WHERE id=3;
         INSERT INTO memories(id,level, owner_id,category, origin_category,content,normalized_hash,importance,first_seen_at,created_at,updated_at,last_seen_at)
            VALUES (4,'project', 'own','swe:constraints', 'CONSTRAINTS','Never open the live stores.','h4',90,2,2,2,2);",
    );
    session.head_stale = true;
    states.push(record(
        "memory changes",
        &mut session,
        &settings,
        store,
        dir,
    ));

    session.fold_due = true;
    states.push(record("fold", &mut session, &settings, store, dir));
    add_summary(&session, 6, "Work after the fold.");
    session.load_summaries();
    session.summary_unshown = true;
    states.push(record(
        "newer summary after the fold",
        &mut session,
        &settings,
        store,
        dir,
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
        store,
        dir,
    ));
    (session, settings, states)
}

/// A restart: a new session takes the saved state and the view the runner
/// holds, then shows a newer summary and a memory change.
fn states_after_restart(
    session: &Session,
    latest: Option<View>,
    settings: &Settings,
    store: &crate::store::Store,
    dir: &std::path::Path,
) -> (Session, Vec<Value>) {
    let (mut restored, _, _, _, _) = fixture();
    restored.db = session.db.clone();
    restored.features.summarizer = true;
    restored.project = session.project.clone();
    // Summaries load first, as a restart does: state ahead of them is distrusted.
    restored.load_summaries();
    restored.restore(store.load(&session.key).unwrap());
    restored.latest = latest;
    restored.latest_unknown = false;
    restored.index.extend(session.index.entries().to_vec());
    restored.index_ready = true;
    add_summary(&restored, 10, "Work after the restart.");
    restored.load_summaries();
    restored.summary_unshown = true;
    let mut states = vec![record(
        "newer summary after a restart",
        &mut restored,
        settings,
        store,
        dir,
    )];
    execute(
        &restored,
        "UPDATE memories SET content='Run the gate before every delivery, on Linux.' WHERE id=1;",
    );
    restored.head_stale = true;
    states.push(record(
        "memory change after a restart",
        &mut restored,
        settings,
        store,
        dir,
    ));
    (restored, states)
}

#[test]
fn head_bytes_match_the_build_before_summary_attribution_was_shared() {
    let dir = scratch("head-bytes");
    let store = crate::store::Store::open(&dir.join("sessions.db")).unwrap();
    let (session, settings, mut states) = states_until_restart(&dir, &store);
    let (restored, after) =
        states_after_restart(&session, session.latest.clone(), &settings, &store, &dir);
    states.extend(after);

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
    write_stored(&copy, last);
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

/// Put `stored` (a state's saved session and its history texts, as
/// [`stored`] reads them) into the store at `path`, in place of what it holds.
fn write_stored(path: &std::path::Path, stored: &Value) {
    let conn = rusqlite::Connection::open(path).unwrap();
    conn.execute_batch("DELETE FROM sessions; DELETE FROM state_texts;")
        .unwrap();
    conn.execute(
        "INSERT INTO sessions (runner, harness, session, state) VALUES ('test', 'mock', 's1', ?1)",
        [stored["state"].as_str().unwrap()],
    )
    .unwrap();
    for text in stored["texts"].as_array().unwrap() {
        conn.execute(
            "INSERT INTO state_texts (id, text) VALUES (?1, ?2)",
            [text[0].as_str().unwrap(), text[1].as_str().unwrap()],
        )
        .unwrap();
    }
}

/// A baseline saved by the build that rendered history with the decay curve
/// keeps its bytes under the history line until something folds it: the
/// line runs only at a fold, and no format change makes a session fold.
/// `testdata/head-bytes-before-line.json` holds what that build saved just
/// before a restart and what it published after it. The same session here
/// restores that saved state and must publish and save exactly the same
/// bytes for a newer summary and for a memory change, neither of which folds.
#[test]
fn a_baseline_from_the_decay_curve_build_replays_byte_identical_until_a_fold() {
    let before: Vec<Value> =
        serde_json::from_str(include_str!("../testdata/head-bytes-before-line.json")).unwrap();
    assert_eq!(before[0]["state"], "refold for a large m[1]");
    let dir = scratch("head-bytes-before-line");
    let store = crate::store::Store::open(&dir.join("sessions.db")).unwrap();
    let (session, settings, _) = states_until_restart(&dir, &store);
    write_stored(&dir.join("sessions.db"), &before[0]["stored"]);
    let latest: View = serde_json::from_str(before[0]["view"].as_str().unwrap()).unwrap();
    let (restored, after) = states_after_restart(&session, Some(latest), &settings, &store, &dir);
    assert_eq!(after.len(), 2);
    for (earlier, now) in before[1..].iter().zip(&after) {
        assert_eq!(earlier["state"], now["state"]);
        for field in ["view", "baseline", "header", "stored"] {
            assert_eq!(
                earlier[field], now[field],
                "{}: {field} is not what the decay curve build wrote",
                now["state"]
            );
        }
    }

    // These few summaries render the same under the curve and the line. A
    // baseline whose history the line would render otherwise keeps its
    // bytes as well: only a fold renders the history again.
    let mut restored = restored;
    let rows: Vec<crate::summary::render::DecayRenderCompartment> = restored
        .summary_rows()
        .unwrap()
        .iter()
        .map(Into::into)
        .collect();
    let (curve, _) =
        crate::summary::render_before_line::render(&rows, 600.0, mc_tokenizer::estimate_tokens);
    let history = |m0: &str| {
        let start = m0.find("<session-history>").unwrap();
        let end = m0.find("</session-history>").unwrap();
        m0[start..end].to_owned()
    };
    let mut baseline = (**restored.baseline.as_ref().unwrap()).clone();
    let block = format!("<session-history>\n{curve}\n");
    let m0 = baseline.m0.replace(&history(&baseline.m0), &block);
    assert_ne!(*baseline.m0, *m0);
    baseline.m0 = m0.as_str().into();
    restored.baseline = Some(Arc::new(baseline));
    add_summary(&restored, 11, "Work after a baseline the curve rendered.");
    restored.load_summaries();
    restored.summary_unshown = true;
    record("newer summary", &mut restored, &settings, &store, &dir);
    assert_eq!(&*restored.baseline.as_ref().unwrap().m0, m0.as_str());
    restored.head_stale = true;
    record("head rebuilt", &mut restored, &settings, &store, &dir);
    assert_eq!(&*restored.baseline.as_ref().unwrap().m0, m0.as_str());
    restored.fold_due = true;
    record("fold", &mut restored, &settings, &store, &dir);
    assert_ne!(history(&restored.baseline.as_ref().unwrap().m0), block);
    drop(restored);
    std::fs::remove_dir_all(dir).unwrap();
}
