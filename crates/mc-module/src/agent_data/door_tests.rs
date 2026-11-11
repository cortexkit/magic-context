//! The refusal boundary between the session door and agent-data.

use super::*;
use cortexkit_role_agent_data::errors::{may_refuse, RefusalCode};
use serde_json::json;

fn refused(op: Op, step: Step, code: &str) -> ErrorBody {
    door_refusal(
        op,
        &Ref::new("pi-session", "s1"),
        step,
        door::DoorError {
            code: code.to_owned(),
            message: format!("the session door refused {code}"),
        },
    )
}

fn permanent_fault(code: &str) {
    for (op, step, step_name) in [
        (Op::Prepare, Step::None, "none"),
        (Op::Export, Step::Prepared, "prepared"),
    ] {
        let body = refused(op, step, code);
        assert_eq!(body.code, RefusalCode::ParticipantFailed, "{op:?}: {code}");
        assert!(may_refuse(op, &body.code));
        let reason = format!("session_door:{code} at {step_name}");
        assert_eq!(body.detail, Some(json!({"reason": reason})));
        let wire = serde_json::to_vec(&body).unwrap();
        let decoded: ErrorBody = serde_json::from_slice(&wire).unwrap();
        assert_eq!(
            decoded.participant_failed_detail().unwrap().unwrap().reason,
            Some(reason)
        );
        assert!(decoded.message.contains(code));
        assert!(decoded
            .message
            .contains("The order of the cut's ops is not the cause"));
    }
}

#[test]
fn invalid_request_is_a_permanent_participant_fault() {
    permanent_fault("invalid_request");
}

#[test]
fn caller_forbidden_is_a_permanent_participant_fault() {
    permanent_fault("caller_forbidden");
}

#[test]
fn stream_label_too_long_is_a_permanent_participant_fault() {
    permanent_fault("stream_label_too_long");
}

#[test]
fn record_too_large_is_a_permanent_participant_fault() {
    permanent_fault("record_too_large");
}

#[test]
fn response_too_large_is_a_permanent_participant_fault() {
    permanent_fault("response_too_large");
}

#[test]
fn offset_mismatch_is_a_permanent_participant_fault() {
    permanent_fault("offset_mismatch");
}

#[test]
fn offset_out_of_range_is_a_permanent_participant_fault() {
    permanent_fault("offset_out_of_range");
}

#[test]
fn below_floor_is_a_permanent_participant_fault() {
    permanent_fault("below_floor");
}

#[test]
fn digest_unindexed_is_a_permanent_participant_fault() {
    permanent_fault("digest_unindexed");
}

#[test]
fn stream_diverged_is_a_permanent_participant_fault() {
    permanent_fault("stream_diverged");
}

#[test]
fn midstate_malformed_is_a_permanent_participant_fault() {
    permanent_fault("midstate_malformed");
}

#[test]
fn stream_digest_mismatch_is_a_permanent_participant_fault() {
    permanent_fault("stream_digest_mismatch");
}

#[test]
fn activate_keeps_permanent_door_faults_compatible_with_older_drivers() {
    for code in [
        "invalid_request",
        "caller_forbidden",
        "stream_label_too_long",
        "record_too_large",
        "response_too_large",
        "offset_mismatch",
        "offset_out_of_range",
        "below_floor",
        "digest_unindexed",
        "stream_diverged",
        "midstate_malformed",
        "stream_digest_mismatch",
    ] {
        let body = refused(Op::Activate, Step::Imported, code);
        assert_eq!(body.code, RefusalCode::InvalidState, "{code}");
        assert_eq!(body.detail, Some(json!({"step": "imported"})), "{code}");
        assert!(may_refuse(Op::Activate, &body.code));
    }
}

#[test]
fn a_pending_handoff_still_names_the_cuts_state() {
    for (op, step, step_name) in [
        (Op::Prepare, Step::None, "none"),
        (Op::Export, Step::Prepared, "prepared"),
    ] {
        let body = refused(op, step, "cut_pending_handoff");
        assert_eq!(body.code, RefusalCode::InvalidState);
        assert_eq!(body.detail, Some(json!({"step": step_name})));
    }
}

#[test]
fn an_unknown_door_code_still_retries_like_a_temporary_failure() {
    for op in [Op::Prepare, Op::Export, Op::Activate] {
        for code in ["a_future_door_code", "unavailable"] {
            let body = refused(op, Step::None, code);
            assert_eq!(body.code, RefusalCode::Unavailable);
            assert_eq!(body.detail, None);
        }
    }
}
