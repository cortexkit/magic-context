use std::collections::BTreeSet;

use super::*;
use crate::dreamer::checkout::tests::Repo;

/// The top level of the checkout these tests cite against.
fn top_level() -> BTreeSet<String> {
    ["crates", "packages", "docs"].map(str::to_owned).into()
}

fn texts(content: &str) -> Vec<String> {
    cites(content, &top_level())
        .iter()
        .map(|cite| match cite {
            Cite::Path(text) => format!("path:{text}"),
            Cite::Name(text) => format!("name:{text}"),
        })
        .collect()
}

#[test]
fn a_memory_cites_spans_paths_and_code_names_in_order() {
    assert_eq!(
        texts(
            "Use `transform_route_retired` from crates/mc-module/src/dreamer/task.rs and \
             `ContextDb::open()`; the McStore type, the run_git helper and the `mc-module` \
             crate, see verify.rs."
        ),
        [
            "name:transform_route_retired",
            "path:crates/mc-module/src/dreamer/task.rs",
            "name:ContextDb::open",
            "name:McStore",
            "name:run_git",
            "name:mc-module",
            "path:verify.rs",
        ]
    );
}

#[test]
fn plain_english_ids_urls_and_placeholders_are_not_citations() {
    for content in [
        "A read-only, long-lived and built-in rule. Never ask twice.",
        "Ufuk ruled it (ask_a0ff68d975ba1b60) at commit ad354a36fa.",
        "See https://docs.example.com/guide/a.md and ~/.local/share/cortexkit/x.db.",
        "Keys look like `dream-run:<id>:…` and `ctx_reduce(drop=…)`; use `never`.",
        "It works and/or fails on 2026-11-13 with node.js.",
        "The package @cortexkit/claustrum-client",
    ] {
        let found = texts(content);
        assert!(
            found.iter().all(|cite| !cite.contains("read-only")
                && !cite.contains("ask_")
                && !cite.contains("docs.example")
                && !cite.contains(".local")
                && !cite.contains('<')
                && !cite.contains("name:never")
                && !cite.contains("and/or")
                && !cite.contains("2026")
                && !cite.contains("node.js")
                && !cite.contains("path:@cortexkit")),
            "{content}: {found:?}"
        );
    }
    // Tokens inside a skipped span are still read on their own.
    assert_eq!(
        texts("Keys look like `ctx_reduce(drop=…)`."),
        ["name:ctx_reduce"]
    );
    // A package name is neither a path of the checkout nor, bare and
    // hyphenated, a code name.
    assert!(texts("The package @cortexkit/claustrum-client").is_empty());
}

/// Hyphenated words a real verify-broad batch was told were "not found",
/// each from a behavioural rule that cited nothing else.
const ENGLISH_COMPOUNDS: [&str; 18] = [
    "audit-flagged",
    "checklist-verification",
    "non-unique",
    "Maintain-memory",
    "release-bound",
    "cross-validate",
    "30-60s",
    "Team-mode",
    "channel-facing",
    "re-classifying",
    "stop-if-absent",
    "Prevention-starves-recovery",
    "test-confirmed",
    "per-seat",
    "zero-delta",
    "late-arriving",
    "Timer-bracket",
    "distribution-shape",
];

#[test]
fn a_bare_hyphenated_word_is_never_a_citation() {
    for word in ENGLISH_COMPOUNDS {
        assert!(
            texts(&format!(
                "When intentionally keeping an {word} pattern, add inline comments."
            ))
            .is_empty(),
            "{word}"
        );
        assert!(texts(word).is_empty(), "{word} alone");
    }
    // A code name written inside a compound still counts.
    assert_eq!(texts("A ContextDb-backed reader."), ["name:ContextDb"]);
}

#[test]
fn backticked_kebab_flags_paths_and_qualified_or_dotted_names_are_citations() {
    assert_eq!(texts("The `mc-module` crate."), ["name:mc-module"]);
    assert_eq!(
        texts("Pass --shared-context-db to share it."),
        ["name:--shared-context-db"]
    );
    assert_eq!(
        texts("It lives in crates/mc-module now."),
        ["path:crates/mc-module"]
    );
    assert_eq!(
        texts("Reads go through session.entries first."),
        ["name:session.entries"]
    );
    assert_eq!(
        texts("It fails with compaction_unavailable."),
        ["name:compaction_unavailable"]
    );
    assert_eq!(
        texts("Pi sessions use RecipeLane::Pi."),
        ["name:RecipeLane::Pi"]
    );
    assert_eq!(texts("MAX_CITES caps it."), ["name:MAX_CITES"]);
    // Abbreviations, host names, file-like product names and an em dash
    // written as two hyphens are none of these.
    for prose in [
        "e.g. this, i.e. that",
        "See docs.cortexkit.io for it.",
        "Built on node.js today.",
        "It works--mostly.",
    ] {
        assert!(texts(prose).is_empty(), "{prose}: {:?}", texts(prose));
    }
}

#[test]
fn a_memory_cites_each_thing_once_and_at_most_sixteen() {
    assert_eq!(
        texts("`run_git` and run_git and `run_git`"),
        ["name:run_git"]
    );
    let many: String = (0..30).map(|n| format!("name_{n} ")).collect();
    assert_eq!(cites(&many, &top_level()).len(), MAX_CITES);
}

/// English phrases and a number written with slashes, which a broad verify
/// batch (one that checks memories whether or not they are mapped to files)
/// over this project's checkout once listed as missing paths.
const SLASHED_PROSE: [&str; 10] = [
    "prompt/input/output",
    "SOFT/SOFT+/HARD",
    "project/user-facing",
    "Task/Athena/bash/board",
    "SUBC/Thalamus/MC",
    "CI-green/gated/mutation-proved",
    "py/sh/bash/zsh/rb/pl/etc",
    "platform-matrix/reachability",
    "FFI/TinyCC-disabled",
    "38520/",
];

#[test]
fn words_joined_by_slashes_are_a_path_only_when_shaped_like_the_checkouts() {
    let repo = Repo::new(&[
        ("crates/a.rs", "\n"),
        ("packages/b.ts", "\n"),
        ("docs/c.md", "\n"),
    ]);
    let checkout = repo.checkout();
    let top_level = checkout.top_level();
    for prose in SLASHED_PROSE {
        for content in [prose.to_owned(), format!("Every {prose} step is checked.")] {
            let found = cites(&content, top_level);
            assert!(
                found.iter().all(|cite| !matches!(cite, Cite::Path(_))),
                "{content}: {found:?}"
            );
        }
    }
    // A file name at the end, a name at the top of the checkout (`.cortexkit`
    // always among them) or `./` at the start makes a path.
    for path in [
        "crates/mc-module/src/x.rs",
        "packages/plugin",
        "docs/cache-policy/",
        ".cortexkit/release-notes/",
        "./scripts/a.sh",
    ] {
        assert_eq!(
            cites(&format!("See {path} for it."), top_level),
            [Cite::Path(path.to_owned())],
            "{path}"
        );
    }
    // A backticked span keeps its own rule.
    assert_eq!(
        texts("The `prompt/input/output` folder."),
        ["path:prompt/input/output"]
    );
}

#[test]
fn shapes_for_a_missing_citation() {
    for path in [
        "src/old/module.rs",
        "Cargo.toml",
        "crates/mc-module",
        "a/b/c",
    ] {
        assert!(path_shaped(path), "{path}");
    }
    for not_path in ["and/or", "src/shared", "/etc/x.rs", "node.js", "@x/y-z"] {
        assert!(!path_shaped(not_path), "{not_path}");
    }
}
