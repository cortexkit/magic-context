//! Which failed runner calls may still have reached the runner. A caller
//! that hands the runner a view must not undo it when only the answer was
//! lost, so the error has to say so.

use super::*;

#[test]
fn outcome_a_lost_answer_says_the_request_may_have_arrived() {
    let error = call_error(
        "session.apply_view",
        &subc_client_rs::CallError::OutcomeUnknown(
            "request on channel 16 timed out at its deadline".into(),
        ),
    );
    assert!(error.outcome_unknown, "{error:?}");
    assert_eq!(error.code, None);
    assert!(error.message.starts_with("session.apply_view: "), "{error}");
}

#[test]
fn outcome_a_call_that_never_left_or_was_answered_is_known() {
    for error in [
        subc_client_rs::CallError::NotSent("route.open refused".into()),
        subc_client_rs::CallError::Module(subc_protocol::ErrorBody::new(
            "compaction_not_permitted",
            "another provider",
        )),
    ] {
        let mapped = call_error("session.apply_view", &error);
        assert!(!mapped.outcome_unknown, "{mapped:?}");
    }
}
