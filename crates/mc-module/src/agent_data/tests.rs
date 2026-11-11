//! The move journal and its gate.

use std::sync::Arc;

use cortexkit_role_compaction::read::SessionRef;
use serde_json::json;

use super::journal::{self, Contents, Cut, Moving, MovingState, Released};
use super::{Journal, SESSION_MOVED, SESSION_MOVING};
use cortexkit_role_agent_data::step::Step;

fn freeze(contents: &mut Contents, key: &SessionRef, cut: &str, state: MovingState) {
    contents.cuts.entry(cut.to_owned()).or_insert(Cut {
        step: Step::Prepared,
        ..Cut::default()
    });
    contents
        .session_mut(&key.runner, &key.harness, &key.session)
        .moving = Some(Moving {
        cut: cut.to_owned(),
        state,
    });
}

fn release(contents: &mut Contents, key: &SessionRef, cut: &str, holder: &str) {
    let entry = contents.session_mut(&key.runner, &key.harness, &key.session);
    entry.moving = None;
    entry.released = Some(Released {
        cut: cut.to_owned(),
        holder: holder.to_owned(),
    });
}

#[test]
fn an_empty_journal_gates_nothing_and_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let path = journal::path(&dir.path().join("context.db"));
    let journal = Journal::load(path.clone());
    let key = SessionRef::new("runner", "pi", "s");
    assert_eq!(journal.gate().check(&key), Ok(()));
    assert_eq!(journal.gate().check_any_runner("pi", "s"), Ok(()));
    assert_eq!(journal.contents(), Some(Contents::default()));
    // A change that changes nothing is not written.
    journal.change(|_| ()).unwrap();
    assert!(!path.exists());
    assert!(!dir.path().join("agent-data").exists());
}

#[test]
fn every_state_refuses_its_session_and_only_its_session() {
    let journal = Journal::in_memory();
    let frozen = SessionRef::new("runner", "pi", "frozen");
    let staged = SessionRef::new("runner", "pi", "staged");
    let activating = SessionRef::new("runner", "pi", "activating");
    let released = SessionRef::new("runner", "pi", "released");
    journal
        .change(|contents| {
            freeze(contents, &frozen, "cut-f", MovingState::Frozen);
            freeze(contents, &staged, "cut-s", MovingState::Staged);
            freeze(contents, &activating, "cut-a", MovingState::Activating);
            freeze(contents, &released, "cut-r", MovingState::Frozen);
            release(contents, &released, "cut-r", "mac-b");
        })
        .unwrap();
    for (key, cut) in [
        (&frozen, "cut-f"),
        (&staged, "cut-s"),
        (&activating, "cut-a"),
    ] {
        let gated = journal.gate().check(key).unwrap_err();
        assert_eq!(gated.code, SESSION_MOVING);
        assert_eq!(gated.cut.as_deref(), Some(cut));
        assert_eq!(gated.detail, Some(json!({"cut": cut})));
        let refusal = gated.refusal();
        assert_eq!(refusal.code, SESSION_MOVING);
        assert!(refusal.message.contains(cut), "{}", refusal.message);
    }
    let gated = journal.gate().check(&released).unwrap_err();
    assert_eq!(gated.code, SESSION_MOVED);
    assert_eq!(gated.cut.as_deref(), Some("cut-r"));
    assert_eq!(gated.detail, Some(json!({"holder": "mac-b"})));
    assert!(gated.line().starts_with("session_moved: cut cut-r: "));
    // The same session id under another harness or runner is another session.
    assert_eq!(
        journal
            .gate()
            .check(&SessionRef::new("runner", "opencode2", "frozen")),
        Ok(())
    );
    assert_eq!(
        journal
            .gate()
            .check(&SessionRef::new("other", "pi", "frozen")),
        Ok(())
    );
    assert_eq!(
        journal
            .gate()
            .check(&SessionRef::new("runner", "pi", "other")),
        Ok(())
    );
    // Reads that name no runner match any runner with that harness and id.
    assert_eq!(
        journal
            .gate()
            .check_any_runner("pi", "frozen")
            .unwrap_err()
            .code,
        SESSION_MOVING
    );
    assert_eq!(
        journal.gate().check_any_runner("opencode2", "frozen"),
        Ok(())
    );
}

#[test]
fn a_move_back_staged_over_a_tombstone_is_moving_and_its_abort_restores_the_tombstone() {
    let journal = Journal::in_memory();
    let key = SessionRef::new("runner", "pi", "s");
    journal
        .change(|contents| {
            freeze(contents, &key, "out", MovingState::Frozen);
            release(contents, &key, "out", "mac-b");
            freeze(contents, &key, "back", MovingState::Staged);
        })
        .unwrap();
    let gated = journal.gate().check(&key).unwrap_err();
    assert_eq!(
        (gated.code, gated.cut.as_deref()),
        (SESSION_MOVING, Some("back"))
    );
    journal
        .change(|contents| contents.session_mut("runner", "pi", "s").moving = None)
        .unwrap();
    let gated = journal.gate().check(&key).unwrap_err();
    assert_eq!(gated.code, SESSION_MOVED);
    assert_eq!(gated.detail, Some(json!({"holder": "mac-b"})));
}

#[test]
fn a_change_is_durable_private_and_read_back_at_startup() {
    let dir = tempfile::tempdir().unwrap();
    let path = journal::path(&dir.path().join("context.db"));
    let key = SessionRef::new("runner", "pi", "s");
    {
        let journal = Journal::load(path.clone());
        journal
            .change(|contents| freeze(contents, &key, "cut-1", MovingState::Frozen))
            .unwrap();
        assert_eq!(journal.gate().check(&key).unwrap_err().code, SESSION_MOVING);
    }
    assert_eq!(path, dir.path().join("agent-data/journal.json"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode =
            |path: &std::path::Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&path), 0o600);
        assert_eq!(mode(path.parent().unwrap()), 0o700);
    }
    // No temporary file is left beside the journal.
    let names: Vec<_> = std::fs::read_dir(path.parent().unwrap())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(names, vec![std::ffi::OsString::from("journal.json")]);
    let restarted = Journal::load(path);
    let gated = restarted.gate().check(&key).unwrap_err();
    assert_eq!(
        (gated.code, gated.cut.as_deref()),
        (SESSION_MOVING, Some("cut-1"))
    );
    let contents = restarted.contents().unwrap();
    assert_eq!(contents.cuts["cut-1"].step, Step::Prepared);
    assert_eq!(contents.format, journal::FORMAT);
}

#[cfg(unix)]
#[test]
fn a_change_tightens_a_folder_that_predates_it() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let path = journal::path(&dir.path().join("context.db"));
    let folder = path.parent().unwrap();
    std::fs::create_dir(folder).unwrap();
    std::fs::set_permissions(folder, std::fs::Permissions::from_mode(0o755)).unwrap();
    let journal = Journal::load(path.clone());
    let key = SessionRef::new("runner", "pi", "s");
    journal
        .change(|contents| freeze(contents, &key, "cut", MovingState::Frozen))
        .unwrap();
    assert_eq!(
        std::fs::metadata(folder).unwrap().permissions().mode() & 0o777,
        0o700
    );
}

#[test]
fn a_failed_write_changes_neither_the_journal_nor_the_gate() {
    let dir = tempfile::tempdir().unwrap();
    let context = dir.path().join("context.db");
    let journal = Journal::load(journal::path(&context));
    // The journal's folder becomes a file, so nothing can be written in it.
    std::fs::write(journal::folder(&context), b"not a folder").unwrap();
    let key = SessionRef::new("runner", "pi", "s");
    assert_eq!(journal.gate().check(&key), Ok(()));
    let error = journal
        .change(|contents| freeze(contents, &key, "cut", MovingState::Frozen))
        .unwrap_err();
    assert!(matches!(error, journal::ChangeError::Io(_)), "{error}");
    assert_eq!(journal.gate().check(&key), Ok(()));
    assert_eq!(journal.contents(), Some(Contents::default()));
}

#[test]
fn an_unparseable_journal_refuses_every_session_and_is_never_overwritten() {
    for bytes in [
        &b"{ not json"[..],
        br#"{"format":"mc-agent-data-journal/2"}"#,
        br#"{"format":"mc-agent-data-journal/1","unknown":1}"#,
    ] {
        let dir = tempfile::tempdir().unwrap();
        let path = journal::path(&dir.path().join("context.db"));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, bytes).unwrap();
        let journal = Journal::load(path.clone());
        for key in [
            SessionRef::new("runner", "pi", "s"),
            SessionRef::new("other", "opencode2", "t"),
        ] {
            let gated = journal.gate().check(&key).unwrap_err();
            assert_eq!(gated.code, SESSION_MOVING);
            assert_eq!(gated.cut, None);
            assert!(
                gated.message.contains("journal cannot be read"),
                "{}",
                gated.message
            );
            assert_eq!(
                journal
                    .gate()
                    .check_any_runner(&key.harness, &key.session)
                    .unwrap_err()
                    .code,
                SESSION_MOVING
            );
        }
        assert_eq!(journal.contents(), None);
        assert!(matches!(
            journal.change(|contents| contents.cuts.clear()),
            Err(journal::ChangeError::Unreadable)
        ));
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }
}

#[test]
fn two_concurrent_changes_for_two_cuts_both_survive() {
    let dir = tempfile::tempdir().unwrap();
    let path = journal::path(&dir.path().join("context.db"));
    let journal = Arc::new(Journal::load(path.clone()));
    let barrier = Arc::new(std::sync::Barrier::new(2));
    let threads: Vec<_> = ["cut-a", "cut-b"]
        .into_iter()
        .map(|cut| {
            let journal = Arc::clone(&journal);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                for round in 0..20 {
                    journal
                        .change(|contents| {
                            let key = SessionRef::new("runner", "pi", format!("{cut}-{round}"));
                            freeze(contents, &key, cut, MovingState::Frozen);
                        })
                        .unwrap();
                }
            })
        })
        .collect();
    for thread in threads {
        thread.join().unwrap();
    }
    let restarted = Journal::load(path);
    let contents = restarted.contents().unwrap();
    assert_eq!(
        contents.cuts.keys().collect::<Vec<_>>(),
        vec!["cut-a", "cut-b"]
    );
    assert_eq!(contents.sessions.len(), 40);
    for cut in ["cut-a", "cut-b"] {
        for round in 0..20 {
            let key = SessionRef::new("runner", "pi", format!("{cut}-{round}"));
            assert_eq!(
                restarted.gate().check(&key).unwrap_err().cut.as_deref(),
                Some(cut)
            );
        }
    }
}

#[test]
fn the_offline_tools_refuse_a_held_session_with_its_code_and_cut() {
    let dir = tempfile::tempdir().unwrap();
    let context = dir.path().join("context.db");
    assert_eq!(super::refuse_offline(&context, [("pi", "s")]), Ok(()));
    let journal = Journal::load(journal::path(&context));
    journal
        .change(|contents| {
            freeze(
                contents,
                &SessionRef::new("runner", "pi", "moving"),
                "cut-m",
                MovingState::Staged,
            );
            release(
                contents,
                &SessionRef::new("runner", "pi", "moved"),
                "cut-r",
                "mac-b",
            );
        })
        .unwrap();
    assert_eq!(super::refuse_offline(&context, [("pi", "s")]), Ok(()));
    let error = super::refuse_offline(&context, [("pi", "s"), ("pi", "moving")]).unwrap_err();
    assert!(error.starts_with("session_moving: cut cut-m: "), "{error}");
    let error = super::refuse_offline(&context, [("pi", "moved")]).unwrap_err();
    assert!(error.starts_with("session_moved: cut cut-r: "), "{error}");
    assert!(error.contains("mac-b"), "{error}");
}

#[tokio::test]
async fn context_reads_are_refused_for_a_held_session_before_any_store_is_read() {
    let journal = Journal::in_memory();
    journal
        .change(|contents| {
            freeze(
                contents,
                &SessionRef::new("runner", "pi", "held"),
                "cut-c",
                MovingState::Frozen,
            )
        })
        .unwrap();
    // No stores at all: a read that got past the gate would answer
    // store_unavailable.
    let reads = crate::context_read::ContextRead::new(
        None,
        None,
        Arc::new(crate::pass::Settings::default().into()),
        Default::default(),
        journal.gate().clone(),
    );
    let body = |session: &str| {
        serde_json::to_vec(&json!({"method": "context.summaries", "params": {
            "session": {"harness": "pi", "session": session}, "budget_tokens": 100}}))
        .unwrap()
    };
    let refused = reads.read(&body("held")).await.unwrap_err();
    assert_eq!(refused.code, SESSION_MOVING);
    assert_eq!(refused.detail, Some(json!({"cut": "cut-c"})));
    let served = reads.read(&body("other")).await.unwrap_err();
    assert_eq!(served.code, "store_unavailable");
}
