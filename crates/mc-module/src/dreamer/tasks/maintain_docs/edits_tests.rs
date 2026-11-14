//! The answer's parsing and every check a change passes, each with a
//! change that fails it, and the budget.

use serde_json::json;

use super::*;

const ARCHITECTURE: &str = "# Architecture\n\n## Core\nOld sentence.\n\n## Guard\n<!-- mc:protected START hand-authored -->\nHand authored\n<!-- mc:protected END -->\n\n## Tail\nLast words.\n";
const STRUCTURE: &str = "# Structure\n\n## Layout\nOld layout.\n";

fn base() -> Texts {
    [Some(ARCHITECTURE.into()), Some(STRUCTURE.into())]
}

/// One token per word, so sizes are easy to reason about.
fn words(text: &str) -> u64 {
    text.split_whitespace().count() as u64
}

fn change(file: &str, action: &str, heading: &str, text: &str) -> Value {
    json!({"file": file, "action": action, "heading": heading, "text": text, "reason": "The code says so."})
}

fn check(answer: &[Value]) -> Checked {
    check_answer(answer, &base(), 10_000, &words)
}

/// The one change's drop reason.
fn refused(change: Value) -> String {
    let checked = check(&[change]);
    assert!(checked.kept.is_empty(), "{checked:?}");
    checked.dropped[0].reason.clone()
}

#[test]
fn an_answer_is_one_json_array_alone_fenced_or_in_text() {
    let changes = json!([{"file": "ARCHITECTURE.md"}]);
    assert_eq!(parse_answer("[]").unwrap(), Vec::<Value>::new());
    assert_eq!(parse_answer(&changes.to_string()).unwrap().len(), 1);
    assert_eq!(
        parse_answer(&format!("Proposed:\n```json\n{changes}\n```"))
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        parse_answer(&format!("```\n{changes}\n```")).unwrap().len(),
        1
    );
    assert_eq!(
        parse_answer(&format!("Here it is: {changes} done"))
            .unwrap()
            .len(),
        1
    );
    for bad in ["not JSON", "{}", "{\"changes\": 1}"] {
        assert!(parse_answer(bad).is_err(), "{bad}");
    }
}

#[test]
fn sections_run_to_the_next_heading_and_skip_fenced_lines() {
    let text = "intro\n# A\none\n```\n# not a heading\n```\n## B\ntwo\n### C\n";
    let found = sections(text);
    let headings: Vec<_> = found
        .iter()
        .map(|section| section.heading.as_str())
        .collect();
    assert_eq!(headings, ["# A", "## B", "### C"]);
    assert_eq!((found[0].start, found[0].end), (1, 6));
    assert_eq!((found[2].start, found[2].end), (8, 10));
}

#[test]
fn a_replacement_rewrites_its_section_and_keeps_the_rest() {
    let checked = check(&[change(
        "ARCHITECTURE.md",
        "replace",
        "## Core",
        "## Core\nCurrent sentence.",
    )]);
    assert!(checked.dropped.is_empty(), "{:?}", checked.dropped);
    assert_eq!(checked.kept.len(), 1);
    assert_eq!(
        checked.results[0].as_deref().unwrap(),
        ARCHITECTURE.replace("Old sentence.", "Current sentence.")
    );
    assert_eq!(checked.results[1].as_deref(), Some(STRUCTURE));
}

#[test]
fn an_addition_goes_at_the_end_and_a_removal_takes_its_section() {
    let checked = check(&[
        change(
            "STRUCTURE.md",
            "add",
            "## Tools",
            "## Tools\nThe tools live in tools/.",
        ),
        change("ARCHITECTURE.md", "remove", "## Tail", ""),
    ]);
    assert!(checked.dropped.is_empty(), "{:?}", checked.dropped);
    assert_eq!(
        checked.results[1].as_deref().unwrap(),
        "# Structure\n\n## Layout\nOld layout.\n\n## Tools\nThe tools live in tools/.\n"
    );
    assert!(checked.results[0]
        .as_deref()
        .unwrap()
        .ends_with("<!-- mc:protected END -->\n"));
}

#[test]
fn an_addition_to_a_missing_document_creates_it() {
    let checked = check_answer(
        &[change(
            "STRUCTURE.md",
            "add",
            "# Structure",
            "# Structure\nA map.",
        )],
        &[Some(ARCHITECTURE.into()), None],
        10_000,
        &words,
    );
    assert!(checked.dropped.is_empty(), "{:?}", checked.dropped);
    assert_eq!(checked.results[1].as_deref(), Some("# Structure\nA map.\n"));
}

#[test]
fn each_check_drops_a_change_that_fails_it_with_its_reason() {
    let cases = [
        (
            change("README.md", "replace", "## Core", "## Core\nx"),
            "the file is neither ARCHITECTURE.md nor STRUCTURE.md",
        ),
        (
            change("ARCHITECTURE.md", "edit", "## Core", "## Core\nx"),
            "the action is neither replace, remove nor add",
        ),
        (
            change("ARCHITECTURE.md", "replace", "Core", "Core\nx"),
            "the heading is not one markdown heading line",
        ),
        (
            json!({"file": "ARCHITECTURE.md", "action": "replace", "heading": "## Core", "text": "## Core\nx", "reason": ""}),
            "the change gives no one-line reason",
        ),
        (
            change("ARCHITECTURE.md", "replace", "## Missing", "## Missing\nx"),
            "the file has no section with this heading",
        ),
        (
            change("ARCHITECTURE.md", "remove", "## Missing", ""),
            "the file has no section with this heading",
        ),
        (
            change("ARCHITECTURE.md", "add", "## Core", "## Core\nx"),
            "the file already has a section with this heading",
        ),
        (
            change("ARCHITECTURE.md", "replace", "## Core", "New sentence."),
            "the text doesn't start with its heading line",
        ),
        (
            change("ARCHITECTURE.md", "add", "## New", "## Other\nx"),
            "the text doesn't start with its heading line",
        ),
        (
            change(
                "ARCHITECTURE.md",
                "replace",
                "## Core",
                "## Core\nx\n## More\ny",
            ),
            "the text holds more than one section",
        ),
        (
            change(
                "ARCHITECTURE.md",
                "replace",
                "## Core",
                "## Core\nOld sentence.",
            ),
            "the change leaves the section as it is",
        ),
        (
            change(
                "ARCHITECTURE.md",
                "replace",
                "## Core",
                "## Core\nRewritten on 2026-11-14 to match the code.",
            ),
            "the text holds a date (2026-11-14)",
        ),
        (
            change(
                "ARCHITECTURE.md",
                "add",
                "## New",
                "## New\nShipped Nov 14, 2026.",
            ),
            "the text holds a date (Nov 14, 2026)",
        ),
        (json!("## Core"), "the change is not a JSON object"),
    ];
    for (proposed, reason) in cases {
        assert_eq!(refused(proposed.clone()), reason, "{proposed}");
    }
}

#[test]
fn a_heading_that_appears_twice_is_ambiguous() {
    let checked = check_answer(
        &[change(
            "STRUCTURE.md",
            "replace",
            "## Layout",
            "## Layout\nNew.",
        )],
        &[None, Some("## Layout\nOne.\n\n## Layout\nTwo.\n".into())],
        10_000,
        &words,
    );
    assert_eq!(
        checked.dropped[0].reason,
        "the heading appears 2 times in the file, so the section is ambiguous"
    );
}

#[test]
fn a_protected_region_is_never_changed_or_removed() {
    // The region sits inside `## Guard`: rewriting that section changes it,
    // removing the section removes it, and a section that adds a marker of
    // its own makes a new one.
    assert_eq!(
        refused(change(
            "ARCHITECTURE.md",
            "replace",
            "## Guard",
            "## Guard\nRemoved hand authored text"
        )),
        "the change alters a protected region"
    );
    assert_eq!(
        refused(change("ARCHITECTURE.md", "remove", "## Guard", "")),
        "the removed section holds a protected region"
    );
    assert_eq!(
        refused(change(
            "ARCHITECTURE.md",
            "add",
            "## New",
            "## New\n<!-- mc:protected START -->\nmine\n<!-- mc:protected END -->"
        )),
        "the change alters a protected region"
    );
    // A rewrite that carries the region forward byte for byte is kept.
    let kept = check(&[change(
        "ARCHITECTURE.md",
        "replace",
        "## Guard",
        "## Guard\nA new first line.\n<!-- mc:protected START hand-authored -->\nHand authored\n<!-- mc:protected END -->",
    )]);
    assert!(kept.dropped.is_empty(), "{:?}", kept.dropped);
}

#[test]
fn a_change_is_checked_against_the_documents_the_kept_changes_before_it_left() {
    let checked = check(&[
        change("ARCHITECTURE.md", "add", "## New", "## New\nFirst."),
        change("ARCHITECTURE.md", "replace", "## New", "## New\nSecond."),
        change("ARCHITECTURE.md", "remove", "## Tail", ""),
        change("ARCHITECTURE.md", "replace", "## Tail", "## Tail\nGone."),
    ]);
    let reasons: Vec<_> = checked
        .dropped
        .iter()
        .map(|dropped| (dropped.heading.as_str(), dropped.reason.as_str()))
        .collect();
    assert_eq!(
        reasons,
        [
            ("## New", "an earlier change already changes this section"),
            ("## Tail", "an earlier change already changes this section"),
        ]
    );
    assert_eq!(checked.kept.len(), 2);
}

#[test]
fn growth_past_the_budget_drops_the_latest_growing_changes_first() {
    // The documents hold 29 words; the budget leaves room for four more.
    let before = words(ARCHITECTURE) + words(STRUCTURE);
    assert_eq!(before, 29);
    let budget = before + 4;
    let answer = [
        change("STRUCTURE.md", "add", "## One", "## One\na b"),
        change("ARCHITECTURE.md", "replace", "## Core", "## Core\nShort."),
        change("STRUCTURE.md", "add", "## Two", "## Two\nc d e f g"),
    ];
    let checked = check_answer(&answer, &base(), budget, &words);
    let kept: Vec<_> = checked.kept.iter().map(|c| c.heading.as_str()).collect();
    assert_eq!(kept, ["## One", "## Core"]);
    assert_eq!(checked.dropped.len(), 1);
    assert_eq!(checked.dropped[0].heading, "## Two");
    // One adds four words, Core loses one, Two adds seven.
    assert_eq!(
        checked.dropped[0].reason,
        format!(
            "the documents would hold {} tokens, over their budget of {budget}",
            before + 4 - 1 + 7
        )
    );
    assert_eq!(checked.tokens_after, before + 4 - 1);
}

#[test]
fn documents_already_over_the_budget_keep_a_change_that_does_not_grow_them() {
    let budget = 5;
    let shrinking = change("ARCHITECTURE.md", "replace", "## Core", "## Core\nShort.");
    let checked = check_answer(std::slice::from_ref(&shrinking), &base(), budget, &words);
    assert_eq!(checked.kept.len(), 1, "{:?}", checked.dropped);
    assert!(checked.tokens_after < checked.tokens_before);
    let growing = change(
        "STRUCTURE.md",
        "add",
        "## More",
        "## More\nmany more words here",
    );
    let checked = check_answer(&[shrinking, growing], &base(), budget, &words);
    assert_eq!(checked.kept.len(), 1);
    assert_eq!(
        checked.dropped[0].reason,
        format!(
            "the documents would hold {} tokens, more than the 29 they hold now, which is already over their budget of 5",
            29 - 1 + 6
        )
    );
}

#[test]
fn an_empty_answer_keeps_the_documents() {
    let checked = check(&[]);
    assert!(checked.kept.is_empty() && checked.dropped.is_empty());
    assert_eq!(checked.results, base());
}
