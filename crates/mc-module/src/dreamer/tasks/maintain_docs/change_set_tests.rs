//! The change set, with the 0.49 plugin's cases (`docs-proposals.test.ts`)
//! and the module's own: the gates a change can end on, the new-area rule,
//! and the range when the checkout moved to another branch.

use super::*;
use crate::dreamer::checkout::tests::Repo;

const ARCHITECTURE: &str = "# Architecture\n\n## Core\nOld sentence.\n";

fn range(repo: &Repo, base: &str) -> Range {
    let head = repo.git(&["rev-parse", "HEAD"]).trim().to_owned();
    super::range(repo.path(), base, &head).unwrap().unwrap()
}

fn head(repo: &Repo) -> String {
    repo.git(&["rev-parse", "HEAD"]).trim().to_owned()
}

#[test]
fn the_change_leaves_out_the_documents_tests_and_lock_files() {
    let repo = Repo::new(&[
        ("ARCHITECTURE.md", ARCHITECTURE),
        ("STRUCTURE.md", "# Structure\n"),
    ]);
    let base = head(&repo);
    repo.write(&[
        ("src.ts", "export const value = 1;\n"),
        ("foo.test.ts", "test\n"),
        ("Cargo.lock", "lock\n"),
        (
            "ARCHITECTURE.md",
            "# Architecture\n\n## Core\nNew sentence.\n",
        ),
    ]);
    repo.commit("update code");
    // The documents don't name src.ts: nothing to read.
    assert_eq!(
        build(repo.path(), &range(&repo, &base), ARCHITECTURE).unwrap(),
        Outcome::NotRelevant
    );
    // Once they do, the change shows its paths, stat and hunks, and leaves
    // the test, the lock file and the documents out.
    let documents = "# Architecture\n\n## Core\nsrc.ts implements the core.\n";
    let Outcome::Changes(text) = build(repo.path(), &range(&repo, &base), documents).unwrap()
    else {
        panic!("a change to a named file is read");
    };
    assert!(
        text.starts_with("Changed files:\nsrc.ts\n\nStat:\n"),
        "{text}"
    );
    assert!(text.contains("@@"));
    assert!(text.contains("Hunks:\n"));
    for left_out in ["foo.test.ts", "Cargo.lock", "ARCHITECTURE.md"] {
        assert!(!text.contains(left_out), "{left_out} in {text}");
    }
}

#[test]
fn a_change_to_the_documents_alone_or_to_tests_and_lock_files_is_not_read() {
    let repo = Repo::new(&[("ARCHITECTURE.md", ARCHITECTURE), ("src/a.rs", "a\n")]);
    let base = head(&repo);
    repo.write(&[("ARCHITECTURE.md", "# Architecture\n\n## Core\nsrc/a.rs\n")]);
    repo.commit("docs");
    assert_eq!(
        build(repo.path(), &range(&repo, &base), "src/a.rs").unwrap(),
        Outcome::DocumentsOnly
    );
    repo.write(&[
        ("src/a.spec.ts", "spec\n"),
        ("test/b.rs", "b\n"),
        ("bun.lock", "lock\n"),
    ]);
    repo.commit("tests");
    assert_eq!(
        build(repo.path(), &range(&repo, &base), "src/a.spec.ts test/b.rs").unwrap(),
        Outcome::Filtered
    );
    // No change at all is the documents' alone.
    let at = head(&repo);
    assert_eq!(
        build(repo.path(), &range(&repo, &at), "").unwrap(),
        Outcome::DocumentsOnly
    );
}

#[test]
fn a_rename_names_both_paths_and_captures_its_hunks() {
    let repo = Repo::new(&[(
        "old.ts",
        "export const rule = 1;\nexport const stable = 'unchanged';\nexport const other = 'unchanged';\n",
    )]);
    let base = head(&repo);
    repo.git(&["mv", "old.ts", "new.ts"]);
    repo.write(&[(
        "new.ts",
        "export const rule = 2;\nexport const stable = 'unchanged';\nexport const other = 'unchanged';\n",
    )]);
    repo.commit("rename");
    let Outcome::Changes(text) = build(
        repo.path(),
        &range(&repo, &base),
        "## Core\nold.ts implements the rule.\n",
    )
    .unwrap() else {
        panic!("a renamed file the documents name is read");
    };
    assert!(text.contains("rename from old.ts"), "{text}");
    assert!(text.contains("rename to new.ts"), "{text}");
    assert!(text.contains("-export const rule = 1;"), "{text}");
}

#[test]
fn a_patch_over_the_budget_becomes_its_files_and_line_ranges() {
    let repo = Repo::new(&[("ARCHITECTURE.md", "## Core\nsrc/big.txt\n")]);
    let base = head(&repo);
    // About 3.3 MB of added lines: past the plugin's 2 MB read buffer and far
    // past the budget.
    repo.write(&[(
        "src/big.txt",
        &"a line long enough to fill the patch\n".repeat(90_000),
    )]);
    repo.commit("big");
    let Outcome::Changes(text) =
        build(repo.path(), &range(&repo, &base), "## Core\nsrc/big.txt\n").unwrap()
    else {
        panic!("a big change is read");
    };
    assert!(
        text.starts_with("Changed files and ranges (diff exceeds prompt budget):\nsrc/big.txt\n"),
        "{}",
        &text[..200]
    );
    assert!(text.contains("file: src/big.txt\nline: 1 +90000"), "{text}");
    assert!(text.contains("\n\nStat:\n"));
    assert!(text.encode_utf16().count() <= TEXT_BUDGET + 2_000);
}

#[test]
fn more_paths_than_a_command_line_takes_are_listed_without_a_diff() {
    let deep = format!("src/{}", "nested-directory-name-".repeat(7));
    let repo = Repo::new(&[("ARCHITECTURE.md", "## Core\n")]);
    let base = head(&repo);
    // About 1,400 paths of roughly 200 bytes: over the pathspec byte cap.
    let files: Vec<(String, String)> = (0..1_400)
        .map(|index| {
            (
                format!("{deep}/file-{index}-{}.txt", "x".repeat(25)),
                format!("{index}\n"),
            )
        })
        .collect();
    let refs: Vec<(&str, &str)> = files
        .iter()
        .map(|(path, text)| (path.as_str(), text.as_str()))
        .collect();
    repo.write(&refs);
    repo.commit("many");
    let documents = format!("## Core\n{deep}\n");
    let Outcome::Changes(text) = build(repo.path(), &range(&repo, &base), &documents).unwrap()
    else {
        panic!("a change to a named folder is read");
    };
    assert!(
        text.starts_with("Changed files (too many to include a diff):\n"),
        "{}",
        &text[..100]
    );
    assert!(text.contains(&format!("{deep}/file-0-")));
    assert!(text.encode_utf16().count() <= TEXT_BUDGET + 100);
}

#[test]
fn a_change_only_in_an_undocumented_existing_folder_is_not_read() {
    let repo = Repo::new(&[
        (
            "ARCHITECTURE.md",
            "## Core\nThe parser lives in src/parser.\n",
        ),
        ("tools/gen/main.rs", "fn main() {}\n"),
    ]);
    let base = head(&repo);
    repo.write(&[
        ("tools/gen/main.rs", "fn main() { run(); }\n"),
        ("tools/gen/extra.rs", "fn run() {}\n"),
    ]);
    repo.commit("tools");
    assert_eq!(
        build(
            repo.path(),
            &range(&repo, &base),
            "## Core\nThe parser lives in src/parser.\n"
        )
        .unwrap(),
        Outcome::NotRelevant
    );
}

#[test]
fn a_new_top_level_area_is_read_even_when_the_documents_name_nothing_in_it() {
    let repo = Repo::new(&[
        (
            "ARCHITECTURE.md",
            "## Core\nThe parser lives in src/parser.\n",
        ),
        ("crates/core/lib.rs", "pub fn core() {}\n"),
    ]);
    let base = head(&repo);
    // A new crate: `crates` existed, `crates/store` didn't.
    repo.write(&[("crates/store/src/lib.rs", "pub fn store() {}\n")]);
    repo.commit("new crate");
    let documents = "## Core\nThe parser lives in src/parser.\n";
    let Outcome::Changes(text) = build(repo.path(), &range(&repo, &base), documents).unwrap()
    else {
        panic!("a new area is read");
    };
    assert!(text.contains("crates/store/src/lib.rs"), "{text}");
    // A new top-level folder counts too.
    let base = head(&repo);
    repo.write(&[("plugins/one.rs", "fn one() {}\n")]);
    repo.commit("new folder");
    assert!(matches!(
        build(repo.path(), &range(&repo, &base), documents).unwrap(),
        Outcome::Changes(_)
    ));
    // A new file in an area that existed before is not a new area.
    let base = head(&repo);
    repo.write(&[("crates/store/src/more.rs", "fn more() {}\n")]);
    repo.commit("more");
    assert_eq!(
        build(repo.path(), &range(&repo, &base), documents).unwrap(),
        Outcome::NotRelevant
    );
}

#[test]
fn a_recorded_commit_off_the_current_line_is_read_from_the_merge_base() {
    let repo = Repo::on("master", &[("src/a.rs", "a\n")]);
    let fork = head(&repo);
    repo.git(&["checkout", "-q", "-b", "side"]);
    repo.write(&[("src/side.rs", "side\n")]);
    let side = repo.commit("side");
    repo.git(&["checkout", "-q", "master"]);
    repo.write(&[("src/main.rs", "main\n")]);
    let main = repo.commit("main");
    let found = super::range(repo.path(), &side, &main).unwrap().unwrap();
    assert_eq!(found.base, fork);
    assert_eq!(found.head, main);
    // An ancestor is read from itself.
    let found = super::range(repo.path(), &fork, &main).unwrap().unwrap();
    assert_eq!(found.base, fork);
    // A commit with no shared history has no range.
    repo.git(&["checkout", "-q", "--orphan", "other"]);
    repo.write(&[("other.rs", "other\n")]);
    let other = repo.commit("other");
    assert_eq!(super::range(repo.path(), &other, &main).unwrap(), None);
}

#[test]
fn only_a_commit_of_the_repository_counts_as_recorded() {
    let repo = Repo::new(&[("a.rs", "a\n")]);
    assert!(is_commit(repo.path(), &head(&repo)));
    assert!(!is_commit(repo.path(), &"1".repeat(40)));
    assert!(!is_commit(repo.path(), "HEAD"));
}
