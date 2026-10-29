//! Retention and release of a dream child (llm-runner §9.14): the groups the
//! runner declares pick the one retention member a send carries, and a child
//! sent the keep-nothing policy is released exactly once after its result is
//! consumed. The fake runner validates sends with llm-runner's own
//! `check_policy`, so it refuses a send carrying both members.

use super::*;

/// Make the fake runner declare `session_retention` with these limits.
fn declare_session_retention(f: &Fixture, max_unreleased_hold_ms: u64, required: bool) {
    let mut state = f.broca.state();
    let describe = &mut state.describe;
    describe["capabilities"]
        .as_array_mut()
        .unwrap()
        .push(json!(caps::SESSION_RETENTION));
    describe["session_retention"] = json!({
        "max_days": 30,
        "max_unreleased_hold_ms": max_unreleased_hold_ms,
        "required": required,
    });
    for major in describe["majors"].as_array_mut().unwrap() {
        let ops = major["ops"].as_array_mut().unwrap();
        for op in ["session.head", "session.release"] {
            if !ops.contains(&json!(op)) {
                ops.push(json!(op));
            }
        }
    }
}

/// Make the fake runner stop declaring `group`.
fn undeclare(f: &Fixture, group: &str) {
    f.broca.state().describe["capabilities"]
        .as_array_mut()
        .unwrap()
        .retain(|declared| declared != group);
}

fn keep_nothing() -> Value {
    json!({"keep": "none", "archive_after_days": 0, "backup": false, "request_dumps": false})
}

/// Run one attempt that answers `done`; returns the child session.
async fn run_done(f: &Fixture, policy: BrocaPolicy) -> String {
    f.script(vec![answer("done")]);
    let request = f.request(&["ctx_search"], 3);
    let (completion, child) = run(f, &mut f.carrier(policy), &request).await;
    assert_eq!(completion.unwrap().text, "done");
    child
}

/// The position of `op` calls in the fake's log.
fn positions(f: &Fixture, op: &str) -> Vec<usize> {
    f.broca
        .state()
        .log
        .iter()
        .enumerate()
        .filter(|(_, (_, o, _))| o == op)
        .map(|(index, _)| index)
        .collect()
}

#[tokio::test]
async fn a_runner_declaring_session_retention_is_sent_only_the_policy() {
    for (keep_retention, required) in [(true, false), (false, false), (true, true)] {
        let f = Fixture::new(BASE);
        declare_session_retention(&f, 60_000, required);
        if !keep_retention {
            undeclare(&f, caps::RETENTION);
        }
        run_done(&f, policy()).await;
        let sent = f.sent();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0]["retention_policy"], keep_nothing(), "{}", sent[0]);
        assert!(sent[0].get("retention").is_none(), "{}", sent[0]);
    }
}

#[tokio::test]
async fn a_runner_with_only_the_retention_group_is_sent_seconds_and_never_released() {
    let f = Fixture::new(BASE);
    run_done(&f, policy()).await;
    let sent = f.sent();
    assert_eq!(sent[0]["retention"], ORDINARY_RETENTION_SECONDS);
    assert!(sent[0].get("retention_policy").is_none(), "{}", sent[0]);
    assert!(f.broca.ops("session.release").is_empty());
}

/// Without either retention group a dream child is unavailable: nothing is
/// sent and nothing is released.
#[tokio::test]
async fn a_runner_declaring_neither_group_is_unavailable_and_sent_nothing() {
    let f = Fixture::new(BASE);
    undeclare(&f, caps::RETENTION);
    let request = f.request(&["ctx_search"], 3);
    let error = bounded(f.carrier(policy()).open(&request))
        .await
        .unwrap_err();
    assert_eq!(error.message, "unavailable: retention");
    assert!(f.sent().is_empty());
    assert!(f.broca.ops("session.release").is_empty());
}

#[tokio::test]
async fn release_is_called_once_after_the_result_is_consumed() {
    let f = Fixture::new(BASE);
    declare_session_retention(&f, 60_000, false);
    let child = run_done(&f, policy()).await;
    let releases = positions(&f, "session.release");
    assert_eq!(releases.len(), 1, "{:?}", f.broca.state().log);
    let (session, _, params) = f.broca.state().log[releases[0]].clone();
    assert_eq!(session, child);
    assert_eq!(params, json!({}));
    // After the terminal result was read, and before the routes were closed.
    let results = positions(&f, "run.result");
    assert!(results.last().is_some_and(|last| *last < releases[0]));
    assert_eq!(f.broca.state().released, vec![child.clone()]);
    let lines = child_retention::release_lines(&child);
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert!(lines[0].ends_with("released: deleted"), "{lines:?}");
}

/// A refusal or a call that never answered is logged once, with its detail,
/// and never retried; close still succeeds, since the runner's unreleased hold
/// deletes the child.
#[tokio::test]
async fn a_refused_or_unanswered_release_is_logged_once_and_never_retried() {
    let replies = [
        refused(
            "retention_conflict",
            json!({"code": "retention_conflict", "detail": {"frozen": keep_nothing()}}),
        ),
        refused("session_released", json!({"code": "session_released"})),
        refused(
            "scope_owner_mismatch",
            json!({"code": "scope_owner_mismatch"}),
        ),
        refused("invalid_params", json!({"field": "retention_policy"})),
        PortError {
            code: "transport".into(),
            message: "connection reset".into(),
            detail: Value::Null,
            outcome_unknown: true,
        },
    ];
    for reply in replies {
        let f = Fixture::new(BASE);
        declare_session_retention(&f, 60_000, false);
        f.broca.state().release_replies = VecDeque::from([
            Err(reply.clone()),
            // A retry would be answered; none must be made.
            Ok(json!({"state": "deleted"})),
        ]);
        let child = run_done(&f, policy()).await;
        assert_eq!(f.broca.ops("session.release").len(), 1, "{}", reply.code);
        let lines = child_retention::release_lines(&child);
        assert_eq!(lines.len(), 1, "{lines:?}");
        let expected = if reply.outcome_unknown {
            "release got no answer: connection reset".to_string()
        } else {
            format!("release refused {}", reply.code)
        };
        assert!(lines[0].contains(&expected), "{lines:?}");
        if reply.code == "retention_conflict" {
            assert!(lines[0].contains("\"frozen\""), "{lines:?}");
        }
    }
}

#[tokio::test]
async fn pending_and_absent_answers_are_final() {
    for state in ["pending", "absent"] {
        let f = Fixture::new(BASE);
        declare_session_retention(&f, 60_000, false);
        f.broca.state().release_replies = VecDeque::from([Ok(json!({ "state": state }))]);
        let child = run_done(&f, policy()).await;
        assert_eq!(f.broca.ops("session.release").len(), 1);
        let lines = child_retention::release_lines(&child);
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(
            lines[0].ends_with(&format!("released: {state}")),
            "{lines:?}"
        );
    }
}
