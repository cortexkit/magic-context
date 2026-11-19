use super::*;

#[test]
fn nats_subject_patterns_match_whole_concrete_tokens() {
    for (pattern, matching, rejected) in [
        ("ck.box.run", "ck.box.run", "ck.other.run"),
        ("ck.*.run", "ck.box.run", "ck.box.extra.run"),
        ("ck.*.run", "ck.box.run", "ck..run"),
        ("ck.*.run", "ck.box.run", "ck.*.run"),
        ("ck.>", "ck.box", "ck"),
        ("ck.>", "ck.box.run", "ck.box."),
        ("ck.>", "ck.box.run", "ck.>"),
    ] {
        assert!(matches(pattern, matching), "{pattern}: {matching}");
        assert!(!matches(pattern, rejected), "{pattern}: {rejected}");
    }
    assert!(!matches("ck.>.run", "ck.box.run"));
}

#[test]
fn subject_drop_warning_names_both_subjects_and_is_rate_limited() {
    let mut log = crate::test_log::capture();
    let drops = SubjectDrops::new();
    assert!(drops.accepts(&["ck.box.run"], "ck.box.run"));
    for subject in ["ck.foreign.run", "ck.another.run"] {
        assert!(!drops.accepts(&["ck.box.run"], subject));
    }
    log.stop();
    assert_eq!(drops.count(), 2);
    assert_eq!(log.count("dropped a bus delivery"), 1);
    assert_eq!(log.count("ck.box.run"), 1);
    assert_eq!(log.count("ck.foreign.run"), 1);
    assert_eq!(log.count("ck.another.run"), 0);
}
