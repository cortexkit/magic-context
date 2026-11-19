//! Which code a verify run checks each memory against, and when a change to
//! a memory without a line of its own is refused.

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::tests::{row, Fixture, Row};
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
    let batches = fixture.several_at(true, &worktree.join("src"));
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
    let batches = fixture.several(true);
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

/// A repository on master and memory 2, which names no line of its own, is
/// mapped to src/b.rs and cites it. With `second`, the repository has a
/// second live branch: a worktree with a commit of its own that leaves
/// src/b.rs as master has it. The worktree's folder is returned with the
/// guard that deletes it.
fn agreed_file(second: bool) -> (Fixture, Option<(tempfile::TempDir, PathBuf)>) {
    let fixture = Fixture::on(
        "master",
        &[
            ("src/b.rs", "fn beta() {}\n"),
            ("src/other.rs", "fn other() {}\n"),
        ],
    );
    let feature = second.then(|| {
        let (outer, worktree) = fixture.repo.worktree("feature");
        commit_at(
            &worktree,
            &[("src/other.rs", "fn other(x: u8) {}\n")],
            "feature",
        );
        (outer, worktree)
    });
    fixture.insert(&[Row {
        files: vec!["src/b.rs"],
        ..row(2, "`beta` in src/b.rs takes no arguments at all.")
    }]);
    (fixture, feature)
}

const OLDER_ON_TWO_BRANCHES: &str =
    "memory 2: older memory: only confirmed while branches differ (live branches: master, feature)";

/// While the repository has two live branches, an old memory is never
/// archived, even when every file the archive rests on is the same on both.
#[test]
fn an_old_memory_is_never_archived_while_there_are_two_live_branches() {
    let (fixture, _feature) = agreed_file(true);
    let batch = fixture.batches(true).remove(0);
    let applied = fixture.apply(
        &batch,
        &manifest(r#"<archive id="2" files="src/b.rs" reason="beta takes an argument now"/>"#),
    );
    assert_eq!(applied.applied, 0, "{applied:?}");
    assert_eq!(applied.dropped, [OLDER_ON_TWO_BRANCHES]);
    assert_eq!(fixture.memory(2).0, "active");
}

/// Nor rewritten.
#[test]
fn an_old_memory_is_never_rewritten_while_there_are_two_live_branches() {
    let (fixture, _feature) = agreed_file(true);
    let batch = fixture.batches(true).remove(0);
    let applied = fixture.apply(
        &batch,
        &manifest(r#"<update id="2" files="src/b.rs">`beta` in src/b.rs takes no arguments and returns unit.</update>"#),
    );
    assert_eq!(applied.applied, 0, "{applied:?}");
    assert_eq!(applied.dropped, [OLDER_ON_TWO_BRANCHES]);
    assert_eq!(
        fixture.memory(2).1,
        "`beta` in src/b.rs takes no arguments at all."
    );
}

/// With one live branch, the same archive is applied.
#[test]
fn an_old_memory_is_archived_when_there_is_one_live_branch() {
    let (fixture, _) = agreed_file(false);
    let batch = fixture.batches(true).remove(0);
    let applied = fixture.apply(
        &batch,
        &manifest(r#"<archive id="2" files="src/b.rs" reason="beta takes an argument now"/>"#),
    );
    assert_eq!(
        (applied.applied, applied.dropped.len()),
        (1, 0),
        "{applied:?}"
    );
    assert_eq!(fixture.memory(2).0, "archived");
}

/// A memory that names its branch is archived on that branch's evidence
/// while there are two live branches, in the same batch as an old memory
/// whose archive is refused.
#[test]
fn a_memory_that_names_its_branch_is_archived_while_there_are_two_live_branches() {
    let fixture = Fixture::on("master", &[("src/other.rs", "fn other() {}\n")]);
    let (_feature, worktree) = fixture.repo.worktree("feature");
    commit_at(
        &worktree,
        &[("src/other.rs", "fn other(x: u8) {}\n")],
        "feature",
    );
    // This contradiction only concerns a file introduced on master after
    // the branches split. The feature branch has no copy of its citations.
    fixture.repo.write(&[("src/b.rs", "fn beta(x: u8) {}\n")]);
    fixture.repo.commit("add beta on master");
    fixture.insert(&[
        Row {
            files: vec!["src/b.rs"],
            ..row(2, "`beta` in src/b.rs takes no arguments at all.")
        },
        row(3, "`other` in src/other.rs takes no arguments."),
    ]);
    learned_on(&fixture, 2, "master");
    let batch = fixture.several(true).remove(0);
    let mut sent = read(&batch);
    sent.sort();
    assert_eq!(sent, [(2, true), (3, false)]);
    let applied = fixture.apply(
        &batch,
        &manifest(
            r#"<archive id="2" files="src/b.rs" reason="beta takes an argument now"/>
<archive id="3" files="src/other.rs" reason="other takes an argument on feature"/>"#,
        ),
    );
    assert_eq!(applied.applied, 1, "{applied:?}");
    assert_eq!(
        applied.dropped,
        ["memory 3: older memory: only confirmed while branches differ (live branches: master, feature)"]
    );
    assert_eq!(fixture.memory(2).0, "archived");
    assert_eq!(fixture.memory(3).0, "active");
}

/// An archive of an old memory because its subject is gone waits, like any
/// other change to it, until the repository has one live branch; it is
/// then applied on the proof every such archive needs.
#[test]
fn a_subject_gone_archive_of_an_old_memory_waits_for_a_single_live_branch() {
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
        ["memory 2: older memory: only confirmed while branches differ (live branches: master, keep)"]
    );
    assert_eq!(fixture.memory(2).0, "active");

    // Removing the checkout leaves just one live branch, but the keeper
    // branch still holds the name and protects the memory on its own.
    git_at(
        repo.path(),
        &["worktree", "remove", "--force", worktree.to_str().unwrap()],
    );
    let batch = fixture.batches(true).remove(0);
    let applied = fixture.apply(
        &batch,
        &manifest(r#"<archive id="2" missing="gone_function"/>"#),
    );
    assert_eq!(applied.applied, 0);
    assert_eq!(
        applied.dropped,
        ["memory 2: gone_function is on branch keep (recent, not merged)"]
    );
    assert_eq!(fixture.memory(2).0, "active");

    // The default branch's removal is enough once the keeper ref is gone.
    repo.git(&["branch", "-D", "keep"]);
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

/// Audit rows 269, 232 and 258 (wrong line, and false on the default
/// branch): facts about the next version confirmed from code only the
/// default branch holds. With the next version's branch live, a confirmation
/// of a memory without a line of its own stands only where every live branch
/// holds the lines it cites.
#[test]
fn a_confirmation_stands_only_where_every_live_branch_holds_its_lines() {
    const PHASE: &str = "packages/plugin/src/hooks/magic-context/transform-postprocess-phase.ts";
    const DAEMON: &str = "crates/mc-module/tests/real_daemon.rs";
    const WAL: &str = "packages/dashboard/src-tauri/src/broca_wal.rs";
    let fixture = Fixture::on(
        "master",
        &[
            (
                PHASE,
                "// An expired provider cache grants no fold.\nconst cacheExpiredIsExecute = true;\n",
            ),
            (DAEMON, "fn register_broca_surface() {}\n"),
            (
                WAL,
                "//! Reads Broca's write-ahead logs.\npub fn read_wal() {}\n",
            ),
            ("src/shared.rs", "pub const SHARED_LIMIT: u32 = 7;\n"),
        ],
    );
    // The next version's line, in its own worktree with commits of its own.
    let (_outer, worktree) = fixture.repo.worktree("mode3-clean");
    std::fs::remove_file(worktree.join(DAEMON)).unwrap();
    std::fs::remove_file(worktree.join(WAL)).unwrap();
    commit_at(
        &worktree,
        &[(
            PHASE,
            "// cache_expired is Forgotten: no rebuild permission.\n",
        )],
        "the next version",
    );
    fixture.insert(&[
        row(
            1,
            "ck-mc treats `cacheExpiredIsExecute` rides as execute passes.",
        ),
        row(
            2,
            "The supervised tests register `register_broca_surface` in crates/mc-module/tests/real_daemon.rs.",
        ),
        row(
            3,
            "The dashboard reads Broca's write-ahead logs with `read_wal`.",
        ),
        row(4, "`SHARED_LIMIT` is 7."),
    ]);
    let batch = fixture.several(true).remove(0);
    let applied = fixture.apply(
        &batch,
        &manifest(&format!(
            r#"<verified id="1" cites="{PHASE}:1-2"/>
<verified id="2" cites="{DAEMON}:1-1"/>
<verified id="3" cites="{WAL}:1-2"/>
<verified id="4" cites="src/shared.rs:1-1"/>"#
        )),
    );
    assert_eq!(applied.applied, 1, "{applied:?}");
    assert_eq!(
        applied.dropped,
        [
            format!("memory 1: counted as a skip: the lines differ between live branches ({PHASE}:1-2 is not on live branch mode3-clean)"),
            format!("memory 2: counted as a skip: the lines differ between live branches ({DAEMON}:1-1 is not on live branch mode3-clean)"),
            format!("memory 3: counted as a skip: the lines differ between live branches ({WAL}:1-2 is not on live branch mode3-clean)"),
        ]
    );
    assert!(fixture.memory(1).3.is_none());
    // Lines every live branch holds confirm a memory without a line.
    assert!(fixture.memory(4).3.is_some());

    // A memory learned on the default branch is checked there alone.
    learned_on(&fixture, 1, "master");
    let batch = fixture
        .several(true)
        .into_iter()
        .find(|batch| batch.read().iter().any(|read| read.id == 1))
        .unwrap();
    let applied = fixture.apply(
        &batch,
        &manifest(&format!(
            r#"<verified id="1" cites="{PHASE}:1-2"/>
<skip id="2"/>
<skip id="3"/>"#
        )),
    );
    assert_eq!(applied.dropped, Vec::<String>::new());
    assert!(fixture.memory(1).3.is_some());
}

/// A memory without a line of its own stays confirmed by its stored lines
/// only while every live branch holds them; once another live branch
/// changes them, it goes to the model.
#[test]
fn stored_lines_keep_a_memory_confirmed_only_while_every_live_branch_holds_them() {
    let fixture = Fixture::on(
        "master",
        &[
            ("src/a.rs", "const CAP: u64 = 64_000;\n"),
            ("src/b.rs", "const UNIT: &str = \"tokens\";\n"),
        ],
    );
    let first = fixture.repo.git(&["rev-parse", "HEAD"]).trim().to_owned();
    fixture
        .repo
        .write(&[("src/a.rs", "// Caps.\nconst CAP: u64 = 64_000;\n")]);
    fixture.repo.commit("a comment");
    // Also mapped to src/b.rs, which every live branch agrees on, so it is
    // not left out of the run.
    fixture.insert(&[Row {
        files: vec!["src/a.rs", "src/b.rs"],
        verified: Some((1_000, Some(first.clone()))),
        spans: vec![("src/a.rs", 1, 1, "const CAP: u64 = 64_000;")],
        ..row(1, "`CAP` is 64k.")
    }]);
    let (_outer, worktree) = fixture.repo.worktree("next");
    commit_at(
        &worktree,
        &[("src/a.rs", "const CAP: u64 = 32_000;\n")],
        "next",
    );
    let batches = fixture.batches(false);
    assert_eq!(read(&batches[0]), [(1, false)]);
    assert!(batches[0].has_diff());

    // With the other branch gone, master alone holds the lines unchanged.
    git_at(
        fixture.repo.path(),
        &["worktree", "remove", "--force", worktree.to_str().unwrap()],
    );
    assert!(fixture.batches(false).is_empty());
}

/// While the repository has two live branches, an old memory every file of
/// whose mapping differs between them is sent to no model: a confirmation
/// from lines of those files is almost always refused. Nothing is written
/// for it, so it is not counted as checked, and a later run with one live
/// branch sends it. A memory with one mapped file both branches agree on,
/// one mapped to nothing, and one that names its branch are sent.
#[test]
fn an_old_memory_whose_mapped_files_all_differ_between_live_branches_is_not_sent() {
    let fixture = Fixture::on(
        "master",
        &[
            ("src/a.rs", "fn alpha() {}\n"),
            ("src/b.rs", "fn beta() {}\n"),
            ("src/c.rs", "fn gamma() {}\n"),
        ],
    );
    let (_outer, worktree) = fixture.repo.worktree("feature");
    commit_at(
        &worktree,
        &[
            ("src/a.rs", "fn alpha(x: u8) {}\n"),
            ("src/c.rs", "fn gamma(x: u8) {}\n"),
        ],
        "feature",
    );
    fixture.insert(&[
        Row {
            files: vec!["src/a.rs", "src/c.rs"],
            ..row(1, "`alpha` in src/a.rs calls `gamma` in src/c.rs.")
        },
        Row {
            files: vec!["src/a.rs", "src/b.rs"],
            ..row(2, "`alpha` in src/a.rs calls `beta` in src/b.rs.")
        },
        row(3, "`beta` takes no arguments at all."),
        Row {
            files: vec!["src/a.rs", "src/c.rs"],
            ..row(4, "`alpha` in src/a.rs takes no arguments.")
        },
    ]);
    learned_on(&fixture, 4, "master");
    let sent = |broad: bool| {
        let mut sent: Vec<(i64, bool)> = fixture.batches(broad).iter().flat_map(read).collect();
        sent.sort();
        sent
    };
    // `verify` checks mapped memories only; `verify-broad` every one.
    assert_eq!(sent(false), [(2, false), (4, true)]);
    assert_eq!(sent(true), [(2, false), (3, false), (4, true)]);
    assert_eq!(fixture.memory(1).4, Value::Null);

    git_at(
        fixture.repo.path(),
        &["worktree", "remove", "--force", worktree.to_str().unwrap()],
    );
    assert_eq!(sent(false), [(1, false), (2, false), (4, true)]);
}
