//! The checks a confirmation's cited lines must pass, on files given by
//! path. Cases marked with an audit row come from the audit of the first
//! live verify run (16 Nov 2026), which found them confirmed although the
//! cited code does not show the claim; each now counts as a skip.

use std::collections::{BTreeSet, HashMap};

use super::*;

const COMMIT: &str = "abcdef0123456789abcdef0123456789abcdef01";

const LIMITS: &str = "// Limits.
pub const MAX_TOKENS: usize = 64_000;
pub const SHARE: f64 = 0.05;
pub const RETRY_DELAY_MS: u64 = 15_000;
pub const MAX_ATTEMPTS: u32 = 10;
pub const WAL_CAP: usize = 64 * 1024 * 1024;
";

/// A commit holding `files`, read by exact path or by a unique path end.
fn files(files: &[(&'static str, &'static str)]) -> HashMap<&'static str, &'static str> {
    files.iter().copied().collect()
}

fn top_level() -> BTreeSet<String> {
    ["src", "crates", "packages"]
        .iter()
        .map(|name| (*name).to_owned())
        .collect()
}

/// [`confirm`] for `content`, citing `cites` with `derive`, at a commit
/// holding `held`.
fn check(
    held: &HashMap<&'static str, &'static str>,
    content: &str,
    cites: Option<&str>,
    derive: Option<&str>,
) -> Result<Confirmation, String> {
    let read = |cited: &str| -> Result<Option<(String, String)>, String> {
        if cited == "src/unreadable.rs" {
            return Err("git timed out".into());
        }
        Ok(held
            .iter()
            .find(|(path, _)| **path == cited || path.ends_with(&format!("/{cited}")))
            .map(|(path, text)| ((*path).to_owned(), (*text).to_owned())))
    };
    confirm(content, &top_level(), cites, derive, Some(COMMIT), &read)
}

fn skipped(result: Result<Confirmation, String>) -> String {
    result.expect_err("the confirmation counts as a skip")
}

#[test]
fn a_confirmation_keeps_the_cited_lines_as_read_at_the_commit() {
    let held = files(&[("src/limits.rs", LIMITS)]);
    let confirmation = check(
        &held,
        "`MAX_TOKENS` in src/limits.rs caps a batch at 64k tokens.",
        Some("limits.rs:2-2"),
        None,
    )
    .unwrap();
    assert_eq!(
        confirmation,
        Confirmation {
            commit: COMMIT.into(),
            spans: vec![Cited {
                path: "src/limits.rs".into(),
                start: 2,
                end: 2,
                text: "pub const MAX_TOKENS: usize = 64_000;".into(),
            }],
            derive: None,
        }
    );
}

#[test]
fn every_name_and_path_the_memory_states_must_be_in_a_cited_span() {
    let held = files(&[
        ("src/limits.rs", LIMITS),
        ("src/other.rs", "fn other() {}\n"),
    ]);
    // A path counts by being a cited span's file.
    assert!(check(
        &held,
        "`SHARE` lives in src/limits.rs.",
        Some("src/limits.rs:3-3"),
        None
    )
    .is_ok());
    assert_eq!(
        skipped(check(
            &held,
            "`MAX_TOKENS` and `MAX_BYTES` cap a batch.",
            Some("src/limits.rs:2-3"),
            None
        )),
        "MAX_BYTES, which the memory names, is in none of the cited lines"
    );
    assert_eq!(
        skipped(check(
            &held,
            "`SHARE` in src/limits.rs is read by src/other.rs.",
            Some("src/limits.rs:3-3"),
            None
        )),
        "src/other.rs, which the memory names, is in none of the cited lines"
    );
    // A name is looked for in the cited lines only, not the whole file.
    assert_eq!(
        skipped(check(
            &held,
            "`MAX_ATTEMPTS` bounds retries.",
            Some("src/limits.rs:2-4"),
            None
        )),
        "MAX_ATTEMPTS, which the memory names, is in none of the cited lines"
    );
}

#[test]
fn every_number_must_be_in_a_cited_span_in_some_equal_form() {
    let held = files(&[("src/limits.rs", LIMITS)]);
    for content in [
        "`MAX_TOKENS` is 64k.",
        "`MAX_TOKENS` is 64,000.",
        "`MAX_TOKENS` is 64_000.",
        "`MAX_TOKENS` is 64000.",
    ] {
        assert!(
            check(&held, content, Some("src/limits.rs:2-2"), None).is_ok(),
            "{content}"
        );
    }
    for content in ["`SHARE` is 5%.", "`SHARE` is 0.05."] {
        assert!(
            check(&held, content, Some("src/limits.rs:3-3"), None).is_ok(),
            "{content}"
        );
    }
    for content in [
        "`RETRY_DELAY_MS` waits 15 s.",
        "`RETRY_DELAY_MS` waits 15 seconds.",
        "`RETRY_DELAY_MS` waits 15_000 ms.",
    ] {
        assert!(
            check(&held, content, Some("src/limits.rs:4-4"), None).is_ok(),
            "{content}"
        );
    }
    assert!(check(
        &held,
        "`WAL_CAP` is 64 MiB.",
        Some("src/limits.rs:6-6"),
        None
    )
    .is_ok());
    assert_eq!(
        skipped(check(
            &held,
            "`MAX_TOKENS` is 32k.",
            Some("src/limits.rs:2-2"),
            None
        )),
        "the number 32k the memory states is in none of the cited lines, in any equal form"
    );
    assert_eq!(
        skipped(check(
            &held,
            "`RETRY_DELAY_MS` waits 15 min.",
            Some("src/limits.rs:4-4"),
            None
        )),
        "the number 15 min the memory states is in none of the cited lines, in any equal form"
    );
    // Versions, dates and references are no numbers to check.
    assert!(check(
        &held,
        "Since 0.49 (2026-11-16, row 12), `SHARE` is 5%.",
        Some("src/limits.rs:3-3"),
        None
    )
    .is_ok());
}

#[test]
fn a_derived_number_needs_arithmetic_that_holds_from_cited_numbers() {
    let held = files(&[("src/limits.rs", LIMITS)]);
    let content =
        "Retries wait `RETRY_DELAY_MS` between `MAX_ATTEMPTS` attempts, about 150 s in all.";
    assert_eq!(
        skipped(check(&held, content, Some("src/limits.rs:4-5"), None)),
        "the number 150 s the memory states is in none of the cited lines, in any equal form"
    );
    let confirmation = check(
        &held,
        content,
        Some("src/limits.rs:4-5"),
        Some("150 s = 10 × 15_000 ms"),
    )
    .unwrap();
    assert_eq!(
        confirmation.derive.as_deref(),
        Some("150 s = 10 × 15_000 ms")
    );
    let wrong = skipped(check(
        &held,
        content,
        Some("src/limits.rs:4-5"),
        Some("150 s = 10 × 10_000 ms"),
    ));
    assert!(wrong.contains("does not hold"), "{wrong}");
    assert_eq!(
        skipped(check(
            &held,
            "Retries wait `RETRY_DELAY_MS`, about 150 s in all.",
            Some("src/limits.rs:4-4"),
            Some("150 s = 10 × 15_000 ms")
        )),
        "derive uses 10, which is in none of the cited lines"
    );
    assert_eq!(
        skipped(check(
            &held,
            content,
            Some("src/limits.rs:4-5"),
            Some("300 s = 20 × 15_000 ms")
        )),
        "derive computes 300 s, which is not a number the memory states"
    );
    let unreadable = skipped(check(
        &held,
        content,
        Some("src/limits.rs:4-5"),
        Some("150 s"),
    ));
    assert!(unreadable.contains("has no `=`"), "{unreadable}");
}

#[test]
fn a_missing_malformed_or_unreadable_cite_counts_as_a_skip() {
    let held = files(&[("src/limits.rs", LIMITS)]);
    let content = "`SHARE` is 5%.";
    assert_eq!(
        skipped(check(&held, content, None, None)),
        "a verified verdict needs cites, the lines that state the claim"
    );
    assert_eq!(
        skipped(check(&held, content, Some("  "), None)),
        "a verified verdict needs cites, the lines that state the claim"
    );
    assert_eq!(
        skipped(check(&held, content, Some("src/limits.rs"), None)),
        "cites entry \"src/limits.rs\" is not path:start-end"
    );
    assert_eq!(
        skipped(check(&held, content, Some("src/limits.rs:3-9"), None)),
        "src/limits.rs:3-9 runs past the end of the file, which has 6 lines"
    );
    assert_eq!(
        skipped(check(&held, content, Some("src/nowhere.rs:1-2"), None)),
        "src/nowhere.rs is not a file at abcdef012345"
    );
    assert_eq!(
        skipped(check(&held, content, Some("src/unreadable.rs:1-2"), None)),
        "reading src/unreadable.rs failed: git timed out"
    );
    assert_eq!(
        skipped(check(&held, content, Some("src/limits.rs:1-151"), None)),
        "a cite covers more than 150 lines"
    );
    let read = |_: &str| -> Result<Option<(String, String)>, String> { Ok(None) };
    assert_eq!(
        confirm(content, &top_level(), Some("a.rs:1-1"), None, None, &read).unwrap_err(),
        "the checkout has no commit to read the cited lines at"
    );
}

/// Audit row 55 (#10806, loose): the ledger is in the cited code, the
/// "~150 s across 10 attempts" figure is not, and no derive can be built
/// from numbers the cited lines hold.
#[test]
fn audit_row_55_a_retry_budget_the_cited_code_does_not_hold() {
    let held = files(&[(
        "crates/mc-store/src/lib.rs",
        "CREATE TABLE mc_reduce_command_ledger (
    session_id TEXT NOT NULL,
    command_id TEXT NOT NULL,
    response_json TEXT,
    PRIMARY KEY (session_id, command_id)
);
",
    )]);
    let content = "`mc_reduce_command_ledger` is keyed by (session_id, command_id) so a lost response can be retried, about 150 s across 10 attempts.";
    let cites = Some("crates/mc-store/src/lib.rs:1-6");
    assert_eq!(
        skipped(check(&held, content, cites, None)),
        "the number 150 s the memory states is in none of the cited lines, in any equal form"
    );
    assert_eq!(
        skipped(check(&held, content, cites, Some("150 s = 10 × 15 s"))),
        "derive uses 10, which is in none of the cited lines"
    );
}

/// Audit row 95 (#18968, loose): the code and its name exist, the "3
/// attempts or 5 minutes" threshold is not in the cited lines.
#[test]
fn audit_row_95_a_threshold_missing_from_the_cited_code() {
    let held = files(&[(
        "packages/plugin/src/shared/user-facing-codes.ts",
        "    \"MC-C11\": {
        code: \"compaction_marker_missing\",
        message: \"The compaction marker could not be written.\",
    },
",
    )]);
    assert_eq!(
        skipped(check(
            &held,
            "`MC-C11` (`compaction_marker_missing`) is raised after 3 attempts or 5 minutes.",
            Some("packages/plugin/src/shared/user-facing-codes.ts:1-4"),
            None
        )),
        "the number 3 the memory states is in none of the cited lines, in any equal form"
    );
}

/// Audit row 207 (#29685, loose): the name the memory states appears
/// nowhere in the cited code, which only models image runs and a count.
#[test]
fn audit_row_207_a_function_the_cited_code_does_not_have() {
    let held = files(&[(
        "packages/pi-plugin/src/pi-dispatch-image-budget.ts",
        "export interface ImageRun {
    start: number;
    count: number;
}
export function imageRuns(parts: Part[]): ImageRun[] {
    return [];
}
",
    )]);
    assert_eq!(
        skipped(check(
            &held,
            "Pi bounds provider images with `clampProviderContextImages`, which keeps 5 by default.",
            Some("packages/pi-plugin/src/pi-dispatch-image-budget.ts:1-7"),
            None
        )),
        "clampProviderContextImages, which the memory names, is in none of the cited lines"
    );
}

/// Audit row 183 (#27848, loose): the lane, deadline and top 20 are in the
/// cited code, `max_queue_ms` is not.
#[test]
fn audit_row_183_one_setting_of_several_is_not_in_the_cited_code() {
    let held = files(&[(
        "packages/plugin/src/features/magic-context/search-rerank.ts",
        "export const RERANK_LANE = \"ctx-search-rerank\";
export const RERANK_DEADLINE_MS = 1500;
export const RERANK_TOP = 20;
",
    )]);
    let cites = Some("packages/plugin/src/features/magic-context/search-rerank.ts:1-3");
    assert!(check(
        &held,
        "Reranking runs on lane `ctx-search-rerank` with a 1500 ms deadline over the top 20.",
        cites,
        None
    )
    .is_ok());
    assert_eq!(
        skipped(check(
            &held,
            "Reranking runs on lane `ctx-search-rerank` with a 1500 ms deadline over the top 20, and `max_queue_ms` bounds its queue.",
            cites,
            None
        )),
        "max_queue_ms, which the memory names, is in none of the cited lines"
    );
}

/// Audit row 50 (#8882, loose): the cited line only says the module serves
/// through subc-client-rs; the 21-byte header is another program's.
#[test]
fn audit_row_50_another_programs_number() {
    let held = files(&[(
        "crates/mc-module/src/lib.rs",
        "//! The magic-context module for subc.\n//! It serves the daemon through `subc-client-rs`.\n",
    )]);
    assert_eq!(
        skipped(check(
            &held,
            "ck-mc serves the daemon through subc-client-rs, whose frames start with a 21-byte header.",
            Some("crates/mc-module/src/lib.rs:2-2"),
            None
        )),
        "the number 21-byte the memory states is in none of the cited lines, in any equal form"
    );
}

/// Audit row 146 (#23678, loose): main calls the logging crate's init, but
/// `CK_LOG` and its default live in that crate, not in the cited code.
#[test]
fn audit_row_146_a_setting_another_crate_reads() {
    let held = files(&[(
        "crates/mc-module/src/main.rs",
        "fn main() {\n    cortexkit_log::init_from_env(\"ck-mc\");\n    run();\n}\n",
    )]);
    assert_eq!(
        skipped(check(
            &held,
            "ck-mc's main calls `cortexkit_log::init_from_env`, which reads `CK_LOG` and logs at INFO by default.",
            Some("crates/mc-module/src/main.rs:1-4"),
            None
        )),
        "CK_LOG, which the memory names, is in none of the cited lines"
    );
}

/// Audit row 73 (#16329, loose): the frame cap is in the cited code, the
/// streamed-body call it also names is not.
#[test]
fn audit_row_73_a_call_the_cited_code_does_not_make() {
    let held = files(&[(
        "packages/plugin/src/module-wire.ts",
        "export const SUBC_MAX_FRAME_BODY_BYTES = 64 * 1024 * 1024;\n",
    )]);
    let cites = Some("packages/plugin/src/module-wire.ts:1-1");
    assert!(check(&held, "`SUBC_MAX_FRAME_BODY_BYTES` is 64 MiB.", cites, None).is_ok());
    assert_eq!(
        skipped(check(
            &held,
            "`SUBC_MAX_FRAME_BODY_BYTES` is 64 MiB, and large bodies go through `call_with_streamed_body`.",
            cites,
            None
        )),
        "call_with_streamed_body, which the memory names, is in none of the cited lines"
    );
}
