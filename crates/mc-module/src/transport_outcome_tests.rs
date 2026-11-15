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
    // A `NotSent` that can't prove the request stayed unsent. subc-client-rs
    // builds such an error only inside its own crate, so the fact it reports
    // (`never_forwarded() == Some(false)`) is passed to the classifier here.
    assert!(may_have_arrived(false, Some(false)));
}

#[test]
fn outcome_a_call_that_never_left_or_was_answered_is_known() {
    // The runner's own error answer.
    let answered = call_error(
        "session.apply_view",
        &subc_client_rs::CallError::Module(subc_protocol::ErrorBody::new(
            "compaction_not_permitted",
            "another provider",
        )),
    );
    assert!(!answered.outcome_unknown, "{answered:?}");
    // A `NotSent` the client proved never reached the runner.
    assert!(!may_have_arrived(false, Some(true)));
    // Errors other than `NotSent` report nothing about forwarding.
    assert!(!may_have_arrived(false, None));
}
