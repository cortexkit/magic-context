use super::*;
use crate::memory_profile::prompt_profile;

const INPUT: &str = "dreamer/classify-memories.input";

#[test]
fn a_task_fills_its_input_frame_and_the_profiles_markers() {
    let profile = prompt_profile(None).unwrap();
    let (system, user) = task_prompts(
        &profile,
        "swe:classify-memories",
        "user",
        &[(INPUT, "### Memory pool to classify\n[7] PROJECT_RULES (current: importance=50 scope=project shareable=false)\nRun the gate before pushing.")],
        &[("projectIdentity", "pj-test")],
    )
    .unwrap();
    // The system prompt is the profile's own document.
    assert!(
        system.starts_with("You are a memory classifier"),
        "{system}"
    );
    assert!(!system.contains('⟦'));
    // The message keeps the profile's wording around the filled slot.
    assert!(
        user.starts_with("## Task: Classify Project Memories\n\n**Project:** pj-test\n"),
        "{user}"
    );
    assert!(user.contains("[7] PROJECT_RULES (current: importance=50 scope=project shareable=false)\nRun the gate before pushing."));
    // The frame's sample shape is gone.
    assert!(!user.contains("anchor.content"));
    assert!(!user.contains('⟦'));
}

#[test]
fn an_unfilled_marker_or_an_unknown_frame_is_refused() {
    let profile = prompt_profile(None).unwrap();
    let error = task_prompts(
        &profile,
        "swe:classify-memories",
        "user",
        &[(INPUT, "pool")],
        &[],
    )
    .unwrap_err();
    assert!(error.contains("⟦projectIdentity⟧ is not filled"), "{error}");
    // Without its input the frame's sample shape stays, and its markers are
    // refused too.
    let error = task_prompts(
        &profile,
        "swe:classify-memories",
        "user",
        &[],
        &[("projectIdentity", "p")],
    )
    .unwrap_err();
    assert!(error.contains("is not filled"), "{error}");
    let error = task_prompts(
        &profile,
        "swe:classify-memories",
        "user",
        &[("dreamer/nope", "x")],
        &[],
    )
    .unwrap_err();
    assert_eq!(error, "no frame dreamer/nope");
}
