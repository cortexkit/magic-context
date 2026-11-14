//! Which code a verify run checks each memory against, and when a change to
//! a memory without a line of its own is refused.

use std::path::{Path, PathBuf};

use super::tests::{row, Fixture};
use super::*;
use crate::dreamer::checkout::tests::{commit_at, git_at};
use crate::memory_line::{of_memory, Line};

fn manifest(entries: &str) -> String {
    format!("<verify>\n{entries}\n</verify>")
}

fn canonical(path: &Path) -> PathBuf {
    path.canonicalize().unwrap()
}

/// Memory `id`'s line, as stored.
fn line_of(fixture: &Fixture, id: i64) -> Option<Line> {
    fixture
        .db
        .with_connection(|conn| of_memory(conn, id))
        .unwrap()
}

/// Record that memory `id` was learned on `branch`.
fn learned_on(fixture: &Fixture, id: i64, branch: &str) {
    fixture.execute(&format!(
        "UPDATE memories SET source_branch = '{branch}', source_commit = '{}' WHERE id = {id}",
        "0".repeat(40)
    ));
}

/// The ids of the batch's memories, and whether each is checked against
/// its own line.
fn read(batch: &VerifyBatch) -> Vec<(i64, bool)> {
    batch
        .read()
        .iter()
        .map(|read| (read.id, read.lined))
        .collect()
}

#[test]
fn a_run_started_in_a_worktree_reads_the_main_checkout() {
    let fixture = Fixture::on("master", &[("src/a.rs", "fn main_name() {}\n")]);
    let (_outer, worktree) = fixture.repo.worktree("wip");
    commit_at(&worktree, &[("src/a.rs", "fn wip_name() {}\n")], "wip");
    fixture.insert(&[
        row(1, "`main_name` in src/a.rs is the entry point."),
        row(2, "`wip_name` in src/a.rs is the entry point."),
    ]);
    let batches = fixture.batches_at(true, &worktree.join("src"));
    assert_eq!(batches.len(), 1);
    let batch = &batches[0];
    // The child session and every lookup read the main checkout.
    assert_eq!(
        canonical(Path::new(batch.folder().unwrap())),
        canonical(fixture.repo.path())
    );
    assert!(!batch.checkout().is_copy());
    assert!(batch
        .message
        .contains("Not found by a plain search of the checkout: wip_name"));
    assert!(!batch.message.contains("checkout: main_name"));
}

#[test]
fn a_memory_learned_on_a_branch_is_checked_on_a_copy_of_its_newest_commit() {
    let fixture = Fixture::on("master", &[("src/a.rs", "fn old_name() {}\n")]);
    let repo = &fixture.repo;
    repo.git(&["checkout", "-q", "-b", "next"]);
    let next = commit_at(
        repo.path(),
        &[
            ("src/a.rs", "fn new_name() {}\n"),
            ("src/next_only.rs", "fn next_only() {}\n"),
        ],
        "next",
    );
    repo.git(&["checkout", "-q", "master"]);
    let master = repo.git(&["rev-parse", "HEAD"]).trim().to_owned();
    fixture.insert(&[
        row(1, "`new_name` in src/a.rs builds the head of the prompt."),
        row(2, "`old_name` in src/a.rs builds the head of the prompt."),
        row(3, "`old_name` in src/a.rs builds the prompt's head block."),
    ]);
    learned_on(&fixture, 1, "next");
    // A branch that is gone stands for the default branch, master, which
    // the main checkout has checked out.
    learned_on(&fixture, 3, "deleted-branch");
    let batches = fixture.batches(true);
    assert_eq!(batches.len(), 2);
    // The main checkout's batch first: memory 2 without a line, memory 3
    // checked against master as its line.
    let mut main_read = read(&batches[0]);
    main_read.sort();
    assert_eq!(main_read, [(2, false), (3, true)]);
    assert!(!batches[0].checkout().is_copy());
    // Memory 1 on a copy of next's newest commit, not the main checkout.
    let copy = &batches[1];
    assert_eq!(read(copy), [(1, true)]);
    assert!(copy.checkout().is_copy());
    assert_eq!(copy.commit(), Some(next.as_str()));
    let folder = PathBuf::from(copy.folder().unwrap());
    assert_ne!(canonical(&folder), canonical(repo.path()));
    assert!(folder.join("src/next_only.rs").is_file());
    assert!(!copy.message.contains("Not found by a plain search"));
    // The repository is untouched: still on master, nothing uncommitted.
    assert_eq!(repo.git(&["rev-parse", "HEAD"]).trim(), master);
    assert_eq!(repo.git(&["status", "--porcelain"]).trim(), "");

    // A rewrite records the branch it was checked on, at that commit.
    let applied = fixture.apply(
        copy,
        &manifest(r#"<update id="1" files="src/a.rs">`new_name` in src/a.rs builds the prompt's head.</update>"#),
    );
    assert_eq!(
        (applied.applied, applied.dropped.len()),
        (1, 0),
        "{applied:?}"
    );
    assert_eq!(
        line_of(&fixture, 1),
        Some(Line {
            branch: Some("next".into()),
            commit: Some(next.clone())
        })
    );
    // So does one checked on the default branch in the main checkout.
    let applied = fixture.apply(
        &batches[0],
        &manifest(r#"<update id="3" files="src/a.rs">`old_name` in src/a.rs builds the head block of the prompt.</update>"#),
    );
    assert_eq!(applied.applied, 1, "{applied:?}");
    assert_eq!(
        line_of(&fixture, 3),
        Some(Line {
            branch: Some("master".into()),
            commit: Some(master)
        })
    );
    // The copy is deleted with the run's batches.
    drop(batches);
    assert!(!folder.exists());
}

#[test]
fn an_old_memory_is_rewritten_only_where_every_live_branch_agrees() {
    let fixture = Fixture::on(
        "master",
        &[
            ("src/a.rs", "fn alpha() {}\n"),
            ("src/b.rs", "fn beta() {}\n"),
        ],
    );
    let (_outer, worktree) = fixture.repo.worktree("feature");
    commit_at(
        &worktree,
        &[("src/a.rs", "fn alpha(x: u8) {}\n")],
        "feature",
    );
    fixture.insert(&[
        row(1, "`alpha` in src/a.rs takes no arguments at all."),
        row(2, "`beta` in src/b.rs takes no arguments at all."),
    ]);
    let batch = fixture.batches(true).remove(0);
    let applied = fixture.apply(
        &batch,
        &manifest(
            r#"<update id="1" files="src/a.rs">`alpha` in src/a.rs takes one byte argument.</update>
<update id="2" files="src/b.rs">`beta` in src/b.rs takes no arguments and returns unit.</update>"#,
        ),
    );
    assert_eq!(applied.applied, 1, "{applied:?}");
    assert_eq!(
        applied.dropped,
        ["memory 1: src/a.rs differs between live branches master and feature; it names no git line of its own, so it changes only where every live branch agrees"]
    );
    assert_eq!(
        fixture.memory(1).1,
        "`alpha` in src/a.rs takes no arguments at all."
    );
    // The file both branches agree on was rewritten, and the memory still
    // names no line.
    assert_eq!(
        fixture.memory(2).1,
        "`beta` in src/b.rs takes no arguments and returns unit."
    );
    assert_eq!(line_of(&fixture, 2), None);
    // An archive because the code contradicts it is refused the same way.
    let batch = fixture.batches(true).remove(0);
    let applied = fixture.apply(
        &batch,
        &manifest(r#"<archive id="1" reason="alpha takes an argument now"/>"#),
    );
    assert_eq!(applied.applied, 0);
    assert!(
        applied.dropped[0].contains("src/a.rs differs between live branches master and feature"),
        "{applied:?}"
    );
    assert_eq!(fixture.memory(1).0, "active");
}

#[test]
fn an_old_memory_is_not_rewritten_over_an_uncommitted_change_in_the_main_checkout() {
    let fixture = Fixture::on("master", &[("src/b.rs", "fn beta() {}\n")]);
    // A second live branch whose src/b.rs is the same as master's.
    let (_outer, worktree) = fixture.repo.worktree("feature");
    commit_at(&worktree, &[("src/other.rs", "\n")], "feature");
    fixture.insert(&[row(2, "`beta` in src/b.rs takes no arguments at all.")]);
    fixture.repo.write(&[("src/b.rs", "fn beta(y: u8) {}\n")]);
    let batch = fixture.batches(true).remove(0);
    let applied = fixture.apply(
        &batch,
        &manifest(r#"<update id="2" files="src/b.rs">`beta` in src/b.rs takes one byte argument.</update>"#),
    );
    assert_eq!(applied.applied, 0);
    assert_eq!(
        applied.dropped,
        ["memory 2: src/b.rs has an uncommitted change in the main checkout; it names no git line of its own, so it changes only where every live branch agrees"]
    );
    assert_eq!(
        fixture.memory(2).1,
        "`beta` in src/b.rs takes no arguments at all."
    );
}

#[test]
fn a_subject_gone_archive_needs_its_names_gone_from_every_live_branch() {
    let fixture = Fixture::on("master", &[("src/live.rs", "fn live_function() {}\n")]);
    let repo = &fixture.repo;
    repo.write(&[("src/old/gone.rs", "fn gone_function() {}\n")]);
    repo.commit("add");
    // Another worktree's branch moved the function instead of removing it.
    let (_outer, worktree) = repo.worktree("keep");
    std::fs::remove_file(worktree.join("src/old/gone.rs")).unwrap();
    commit_at(
        &worktree,
        &[("src/moved.rs", "fn gone_function() {}\n")],
        "move",
    );
    std::fs::remove_file(repo.path().join("src/old/gone.rs")).unwrap();
    repo.commit("remove");
    fixture.insert(&[row(
        2,
        "`gone_function` in src/old/gone.rs registers the dream timer.",
    )]);
    let batch = fixture.batches(true).remove(0);
    let applied = fixture.apply(
        &batch,
        &manifest(r#"<archive id="2" missing="gone_function"/>"#),
    );
    assert_eq!(applied.applied, 0);
    assert_eq!(
        applied.dropped,
        ["memory 2: a code name it cites (gone_function) is still on live branch keep; it names no git line of its own, so it changes only where every live branch agrees"]
    );
    assert_eq!(fixture.memory(2).0, "active");

    // Once that worktree is gone, master is the only live branch and the
    // archive is applied as before.
    git_at(
        repo.path(),
        &["worktree", "remove", "--force", worktree.to_str().unwrap()],
    );
    let batch = fixture.batches(true).remove(0);
    let applied = fixture.apply(
        &batch,
        &manifest(r#"<archive id="2" missing="gone_function"/>"#),
    );
    assert_eq!(
        (applied.applied, applied.dropped.len()),
        (1, 0),
        "{applied:?}"
    );
    assert_eq!(fixture.memory(2).0, "archived");
}

#[test]
fn a_single_branch_repository_changes_old_memories_as_before() {
    let fixture = Fixture::on("master", &[("src/b.rs", "fn beta() {}\n")]);
    fixture.insert(&[row(2, "`beta` in src/b.rs takes no arguments at all.")]);
    // An uncommitted change is the one checked, as before lines existed.
    fixture.repo.write(&[("src/b.rs", "fn beta(y: u8) {}\n")]);
    let batch = fixture.batches(true).remove(0);
    let applied = fixture.apply(
        &batch,
        &manifest(r#"<update id="2" files="src/b.rs">`beta` in src/b.rs takes one byte argument.</update>"#),
    );
    assert_eq!(
        (applied.applied, applied.dropped.len()),
        (1, 0),
        "{applied:?}"
    );
    assert_eq!(
        fixture.memory(2).1,
        "`beta` in src/b.rs takes one byte argument."
    );
    assert_eq!(line_of(&fixture, 2), None);
}
