use serde_json::json;

use super::*;

fn span(path: &str, start: usize, end: usize) -> Span {
    Span {
        path: path.into(),
        start,
        end,
    }
}

#[test]
fn cites_are_path_start_end_spans_separated_by_semicolons() {
    assert_eq!(
        parse_cites("src/a.rs:120-128; src/b.rs:40-41;").unwrap(),
        [span("src/a.rs", 120, 128), span("src/b.rs", 40, 41)]
    );
    // One line, and a dash as typography writes it.
    assert_eq!(
        parse_cites("src/a.rs:7;src/b.rs:3–5").unwrap(),
        [span("src/a.rs", 7, 7), span("src/b.rs", 3, 5)]
    );
}

#[test]
fn a_missing_or_malformed_cite_is_refused_with_why() {
    assert_eq!(parse_cites("").unwrap_err(), "cites names no lines");
    assert_eq!(parse_cites(" ; ").unwrap_err(), "cites names no lines");
    for malformed in [
        "src/a.rs",
        "src/a.rs:",
        "src/a.rs:a-b",
        "src/a.rs:0-3",
        "src/a.rs:9-3",
        ":1-2",
        "src/a.rs:1-2-3",
    ] {
        let why = parse_cites(malformed).unwrap_err();
        assert!(why.contains("is not path:start-end"), "{malformed}: {why}");
    }
}

#[test]
fn a_cite_is_at_most_sixteen_spans_of_a_hundred_and_fifty_lines() {
    assert!(parse_cites("src/a.rs:1-150").is_ok());
    assert_eq!(
        parse_cites("src/a.rs:1-151").unwrap_err(),
        "a cite covers more than 150 lines"
    );
    let sixteen: Vec<String> = (1..=16).map(|line| format!("a.rs:{line}-{line}")).collect();
    assert!(parse_cites(&sixteen.join(";")).is_ok());
    let seventeen: Vec<String> = (1..=17).map(|line| format!("a.rs:{line}-{line}")).collect();
    assert_eq!(
        parse_cites(&seventeen.join(";")).unwrap_err(),
        "cites names more than 16 spans"
    );
}

#[test]
fn lines_are_read_and_found_again_where_they_moved() {
    let file = "fn a() {}\nconst CAP: u64 = 64_000;   \nfn b() {}\n";
    assert_eq!(
        lines_of(file, 2, 3).unwrap(),
        "const CAP: u64 = 64_000;   \nfn b() {}"
    );
    assert_eq!(lines_of(file, 3, 4), Err(3));
    let moved = "// moved\n\nconst CAP: u64 = 64_000;\nfn b() {}\n";
    assert_eq!(
        find_lines(moved, "const CAP: u64 = 64_000;   \nfn b() {}"),
        Some((3, 4))
    );
    assert_eq!(find_lines(moved, "const CAP: u64 = 32_000;"), None);
    assert_eq!(find_lines(moved, ""), None);
}

fn confirmation() -> Confirmation {
    Confirmation {
        commit: "a".repeat(40),
        spans: vec![Cited {
            path: "src/a.rs".into(),
            start: 2,
            end: 2,
            text: "const CAP: u64 = 64_000;".into(),
        }],
        derive: Some("64k = 64 × 1000".into()),
    }
}

#[test]
fn a_confirmation_is_stored_with_its_time_and_counts_only_for_that_confirmation() {
    let stored = confirmation().json(1_000);
    assert_eq!(
        stored,
        json!({
            "verifiedAt": 1_000,
            "commit": "a".repeat(40),
            "spans": [{"path": "src/a.rs", "start": 2, "end": 2, "text": "const CAP: u64 = 64_000;"}],
            "derive": "64k = 64 × 1000",
        })
    );
    let metadata = json!({"dreamerVerifiedAt": 1_000, STORED_KEY: stored});
    assert_eq!(Confirmation::stored(&metadata, 1_000), Some(confirmation()));
    // Spans kept for an earlier confirmation, or none, count for nothing.
    assert_eq!(Confirmation::stored(&metadata, 2_000), None);
    assert_eq!(Confirmation::stored(&json!({}), 1_000), None);
    let mut empty = metadata.clone();
    empty[STORED_KEY]["spans"] = json!([]);
    assert_eq!(Confirmation::stored(&empty, 1_000), None);
    let mut bad_commit = metadata.clone();
    bad_commit[STORED_KEY]["commit"] = json!("HEAD");
    assert_eq!(Confirmation::stored(&bad_commit, 1_000), None);

    assert!(cites_its_confirmation(Some(&metadata.to_string())));
    // A confirmation recorded later without cited lines (the 0.49 plugin's
    // verifier) leaves the earlier spans behind, which then count for
    // nothing.
    let later = json!({"dreamerVerifiedAt": 2_000, STORED_KEY: confirmation().json(1_000)});
    assert!(!cites_its_confirmation(Some(&later.to_string())));
    assert!(!cites_its_confirmation(Some(
        &json!({"dreamerVerifiedAt": 1_000}).to_string()
    )));
    assert!(!cites_its_confirmation(None));
    assert!(!cites_its_confirmation(Some("not json")));
}
