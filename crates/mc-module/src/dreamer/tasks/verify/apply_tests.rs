use serde_json::{json, Value};

use super::super::tests::{row, Fixture, Row};

/// A checkout with one live source file and one removed in a later commit,
/// and a store holding memory 1 (an architecture fact citing
/// `live_function`) and memory 2 (one citing only what was removed).
fn fixture() -> Fixture {
    let fixture = Fixture::new(&[
        ("src/live.rs", "fn live_function() {}\n"),
        ("src/other.rs", "fn other() {}\n"),
    ]);
    fixture
        .repo
        .add_then_remove(&[("src/old/gone.rs", "fn gone_function() {}\n")]);
    fixture.insert(&[
        row(
            1,
            "`live_function` in src/live.rs takes no arguments and returns nothing.",
        ),
        row(
            2,
            "`gone_function` in src/old/gone.rs registers the dream timer.",
        ),
    ]);
    fixture
}

fn manifest(entries: &str) -> String {
    format!("<verify>\n{entries}\n</verify>")
}

/// The one batch a broad run of `fixture` plans when a message holds
/// several memories, so one reply decides both.
fn plan_one(fixture: &Fixture) -> super::super::VerifyBatch {
    let mut batches = fixture.several(true);
    assert_eq!(batches.len(), 1);
    batches.remove(0)
}

#[test]
fn a_verified_memory_records_time_commit_and_the_named_files_as_its_mapping() {
    let fixture = fixture();
    let batch = plan_one(&fixture);
    let before = fixture.memory(1);
    let applied = fixture.apply(
        &batch,
        &manifest(
            r#"<verified id="1" files="./src/live.rs, src/untracked.rs, src/live.rs" cites="src/live.rs:1-1"/>
<skip id="2" reason="code can't decide it"/>"#,
        ),
    );
    assert_eq!((applied.proposed, applied.applied), (2, 2));
    assert!(applied.dropped.is_empty(), "{:?}", applied.dropped);
    // A memory verified by searching is now mapped to the tracked file it
    // was checked against; an untracked one is left out.
    assert_eq!(fixture.mapping(1), ["src/live.rs"]);
    let (status, content, revision, verified_at, metadata, updated_at) = fixture.memory(1);
    assert_eq!((status.as_str(), content), ("active", before.1));
    // A verification changes no text: same revision and update time, no
    // history.
    assert_eq!((revision, updated_at), (before.2, before.5));
    let verified_at = verified_at.expect("a verification time");
    let head = fixture.repo.checkout().head().unwrap().to_owned();
    // The lines it cites are kept, as read at the commit checked.
    assert_eq!(
        metadata,
        json!({
            "dreamerVerifiedAt": verified_at,
            "dreamerVerifiedCommit": head,
            "dreamerCheckedAt": verified_at,
            "dreamerVerifiedSpans": {
                "verifiedAt": verified_at,
                "commit": head,
                "spans": [{"path": "src/live.rs", "start": 1, "end": 1, "text": "fn live_function() {}"}],
            },
        })
    );
    // A skip records only that the memory was checked.
    let (_, _, revision, verified_at, metadata, updated_at) = fixture.memory(2);
    assert_eq!((revision, verified_at, updated_at), (1, None, 5));
    assert!(metadata["dreamerCheckedAt"].as_i64().is_some());
    assert!(fixture.mapping(2).is_empty());
    assert!(fixture.history().is_empty());
    // The next broad run reaches them after everything checked earlier.
    let live = fixture
        .db
        .with_connection(|conn| {
            super::super::live_memories(
                conn,
                super::super::tests::PROJECT,
                &["swe:architecture".to_owned()],
                0,
            )
        })
        .unwrap();
    assert!(live.iter().all(|memory| memory.checked_at > 0));
    assert_eq!(live[0].verified_commit.as_deref(), Some(head.as_str()));
    assert!(live[0].confirmation.is_some());
}

#[test]
fn a_confirmation_without_usable_cites_counts_as_a_skip_and_says_why() {
    let fixture = fixture();
    let batch = plan_one(&fixture);
    let applied = fixture.apply(
        &batch,
        &manifest(
            r#"<verified id="1" files="src/live.rs"/>
<verified id="2" files="src/other.rs" cites="src/other.rs:1-1"/>"#,
        ),
    );
    assert_eq!((applied.proposed, applied.applied), (2, 0));
    assert_eq!(
        applied.dropped,
        [
            "memory 1: counted as a skip: a verified verdict needs cites, the lines that state the claim",
            "memory 2: counted as a skip: gone_function, which the memory names, is in none of the cited lines",
        ]
    );
    for id in [1, 2] {
        // Marked checked, as a skip is, and neither verified nor mapped.
        let (status, _, revision, verified_at, metadata, _) = fixture.memory(id);
        assert_eq!(
            (status.as_str(), revision, verified_at),
            ("active", 1, None)
        );
        assert!(metadata["dreamerCheckedAt"].as_i64().is_some());
        assert!(metadata.get("dreamerVerifiedSpans").is_none());
        assert!(fixture.mapping(id).is_empty());
    }
    let result: String = fixture
        .db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT verify_result FROM memories WHERE id = 1",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert_eq!(result, "skipped");
}

#[test]
fn an_update_drops_the_lines_an_earlier_confirmation_cited() {
    let fixture = fixture();
    let batch = plan_one(&fixture);
    fixture.apply(
        &batch,
        &manifest(r#"<verified id="1" files="src/live.rs" cites="src/live.rs:1-1"/>"#),
    );
    assert!(fixture.memory(1).4.get("dreamerVerifiedSpans").is_some());
    let batch = plan_one(&fixture);
    let applied = fixture.apply(
        &batch,
        &manifest(
            r#"<update id="1" files="src/live.rs" cites="src/live.rs:1">`live_function` in src/live.rs takes no arguments and returns unit.</update>"#,
        ),
    );
    assert_eq!(applied.applied, 1, "{applied:?}");
    // The new text was never confirmed from cited lines.
    assert!(fixture.memory(1).4.get("dreamerVerifiedSpans").is_none());
    let live = fixture
        .db
        .with_connection(|conn| {
            super::super::live_memories(
                conn,
                super::super::tests::PROJECT,
                &["swe:architecture".to_owned()],
                0,
            )
        })
        .unwrap();
    let updated = live.iter().find(|memory| memory.id == 1).unwrap();
    assert_eq!(
        (updated.verified_at, updated.confirmation.is_none()),
        (0, true)
    );
}

#[test]
fn a_verdict_outside_the_owner_category_declaration_or_read_revision_is_dropped() {
    let fixture = fixture();
    let batch = plan_one(&fixture);
    fixture.execute(
        "UPDATE memories SET revision = 2 WHERE id = 1;
         UPDATE memories SET category = 'swe:workflow' WHERE id = 2;",
    );
    let applied = fixture.apply(&batch, &manifest(r#"<verified id="1"/><verified id="2"/>"#));
    assert_eq!(applied.applied, 0);
    assert_eq!(
        applied.dropped,
        [
            "memory 1 changed after the batch read it (revision 1, now 2)",
            "memory 2 is filed under swe:workflow, which swe:verify-broad does not cover",
        ]
    );

    let fixture = super::super::tests::Fixture::new(&[("a.rs", "\n")]);
    fixture.insert(&[row(1, "One."), row(2, "Two.")]);
    let mut declaration = fixture.declaration("verify-broad");
    declaration["actions"] = json!(["mark-verified", "skip"]);
    let batch = fixture.several_under(true, &declaration).remove(0);
    fixture.execute("UPDATE memories SET owner_id = 'pj-other' WHERE id = 2;");
    let applied = fixture.apply(
        &batch,
        &manifest(r#"<archive id="1" reason="contradicted"/><verified id="2"/>"#),
    );
    assert_eq!(
        applied.dropped,
        [
            "memory 2 is no longer a live memory of the project",
            "memory 1: swe:verify-broad does not declare archive",
        ]
    );
    assert_eq!(fixture.memory(1).0, "active");
}

#[test]
fn an_update_keeps_the_plugins_rules_and_records_history_naming_the_run() {
    let fixture = Fixture::new(&[("src/live.rs", "fn live_function(a: u8) {}\n")]);
    let long = "The live_function handler in src/live.rs takes one argument and logs it.";
    fixture.insert(&[
        row(1, long),
        Row {
            tag: "PROJECT_RULES",
            ..row(2, "Always run live_function before committing.")
        },
        row(3, "A duplicate target."),
        row(4, "A duplicate source."),
    ]);
    fixture.execute("UPDATE memories SET content = 'A duplicate target text.' WHERE id = 3");
    fixture.execute(&format!(
        "UPDATE memories SET normalized_hash = '{}' WHERE id = 3",
        crate::memory_writes::normalized_hash("A duplicate target text.")
    ));
    let batch = plan_one(&fixture);
    let applied = fixture.apply(
        &batch,
        &manifest(
            r#"<update id="1" files="src/live.rs">Short.</update>
<update id="2">Always run live_function twice before committing.</update>
<update id="3">  </update>
<update id="4">A duplicate target text.</update>"#,
        ),
    );
    assert_eq!(applied.applied, 0);
    assert_eq!(
        applied.dropped,
        [
            "memory 1: the update drops more than half the text without consolidation=\"true\"",
            "memory 2: a project rule that reads as a behavioural directive is only verified or skipped",
            "memory 3: the update's text is empty or longer than 20000 characters",
            "memory 4: the update's text is already memory 3",
        ]
    );

    let batch = plan_one(&fixture);
    let applied = fixture.apply(
        &batch,
        &manifest(
            r#"<update id="1" files="src/live.rs" consolidation="true" cites="src/live.rs:1">live_function takes one argument.</update>
<skip id="2"/>"#,
        ),
    );
    assert_eq!((applied.applied, applied.dropped.len()), (2, 0));
    let (status, content, revision, verified_at, metadata, _) = fixture.memory(1);
    assert_eq!(
        (status.as_str(), content.as_str(), revision),
        ("active", "live_function takes one argument.", 2)
    );
    assert_eq!(metadata["dreamerVerifiedAt"].as_i64(), verified_at);
    assert_eq!(fixture.mapping(1), ["src/live.rs"]);
    let history = fixture.history();
    assert_eq!(history.len(), 1);
    assert_eq!(
        (
            history[0].0,
            history[0].1,
            history[0].2.as_str(),
            history[0].4.as_str()
        ),
        (1, 1, "verify_update", "dream-run:7:verify-broad:0:1")
    );
}

#[test]
fn an_archive_naming_what_is_missing_needs_it_cited_and_gone() {
    let fixture = fixture();
    let batch = plan_one(&fixture);
    // Memory 2 goes first: everything it cites is gone.
    assert_eq!(batch.read()[0].id, 2);
    let applied = fixture.apply(
        &batch,
        &manifest(
            r#"<archive id="1" reason="removed" missing="live_function"/>
<archive id="2" missing="src/old/gone.rs"/>"#,
        ),
    );
    assert_eq!(
        applied.dropped,
        ["memory 1: live_function is still in the checkout"]
    );
    assert_eq!(fixture.memory(1).0, "active");
    let (status, _, revision, _, metadata, _) = fixture.memory(2);
    assert_eq!((status.as_str(), revision), ("archived", 2));
    assert_eq!(
        metadata["archive_reason"],
        json!("src/old/gone.rs is gone from the checkout")
    );
    let history = fixture.history();
    assert_eq!(history.len(), 1);
    assert_eq!(
        (history[0].0, history[0].3.clone(), history[0].4.as_str()),
        (
            2,
            json!([{"missing": "src/old/gone.rs"}]),
            "dream-run:7:verify-broad:0:2"
        )
    );
}

#[test]
fn a_fast_gate_archive_cannot_prove_removal_with_prose_a_short_read_or_a_live_glob() {
    let gate = format!(
        "{}printf '%s\\n' 'preparing scripts/gate.sh'\n{}\ncase \"$stage\" in\n  fast) step 'Pinned vector Python prerequisite' require_vector_python ;;\nesac\n",
        "\n".repeat(116),
        "\n".repeat(270)
    );
    let fixture = Fixture::new(&[
        ("scripts/gate.sh", &gate),
        ("vectors/fed-pairing-v1/requirements.txt", ""),
        ("vectors/another-v1/requirements.txt", ""),
    ]);
    fixture.insert(&[row(
        1,
        "Every new scratch worktree needs the pinned vector Python before any landing script runs `scripts/gate.sh fast`: `python3 -m venv target/gate-python && for r in vectors/*/requirements.txt; do …`. Without it the fast gate fails \"Pinned vector Python prerequisite\".",
    )]);
    let batch = plan_one(&fixture);
    for proposal in [
        r#"<archive id="1" reason="scripts/gate.sh fast() (lines 117-150) no longer checks for target/gate-python or 'Pinned vector Python prerequisite', and vectors/*/requirements.txt does not exist in the repository"/>"#,
        r#"<archive id="1" reason="the prerequisite is not present" cites="scripts/gate.sh:117-150"/>"#,
        r#"<archive id="1" files="scripts/gate.sh" cites="scripts/gate.sh:117-150" missing="Pinned vector Python prerequisite"/>"#,
        r#"<archive id="1" missing="vectors/*/requirements.txt"/>"#,
    ] {
        let applied = fixture.apply(&batch, &manifest(proposal));
        assert_eq!(applied.applied, 0, "accepted {proposal}");
        assert_eq!(fixture.memory(1).0, "active");
        if proposal.contains("missing=") {
            assert!(
                applied.dropped[0].contains("still"),
                "{:?}",
                applied.dropped
            );
        }
    }
}

#[test]
fn a_removed_glob_can_prove_an_archive() {
    let fixture = Fixture::new(&[("vectors/README.md", "Vectors are checked in.\n")]);
    fixture
        .repo
        .add_then_remove(&[("vectors/old-v1/requirements.txt", "")]);
    fixture.insert(&[row(
        1,
        "The vector checks install `vectors/*/requirements.txt`.",
    )]);
    let applied = fixture.apply(
        &plan_one(&fixture),
        &manifest(r#"<archive id="1" missing="vectors/*/requirements.txt"/>"#),
    );
    assert_eq!(applied.applied, 1, "{applied:?}");
    assert_eq!(fixture.memory(1).0, "archived");
}

#[test]
fn a_rewrite_checks_the_new_claim_and_looks_for_removed_names_outside_the_cites() {
    let fixture = Fixture::new(&[(
        "src/gate.rs",
        "const old_limit: u64 = 10;\nconst still_used: u64 = 20;\n",
    )]);
    fixture.repo.write(&[(
        "src/gate.rs",
        "const new_limit: u64 = 10;\nconst still_used: u64 = 20;\n",
    )]);
    fixture.repo.commit("replace the old limit");
    fixture.insert(&[
        row(1, "`old_limit` is 10, the cap on batch work."),
        row(2, "`still_used` is 20, the cap on batch work."),
    ]);
    let batch = plan_one(&fixture);
    let applied = fixture.apply(&batch, &manifest(
        r#"<update id="1" files="src/gate.rs" cites="src/gate.rs:1" missing="old_limit">`new_limit` is 11, the cap on batch work.</update>
<update id="2" files="src/gate.rs" cites="src/gate.rs:1" missing="still_used">`new_limit` is 10, the cap on batch work.</update>"#,
    ));
    assert_eq!(applied.applied, 0);
    assert_eq!(applied.dropped, [
        "memory 1: the number 11 the memory states is in none of the cited lines, in any equal form",
        "memory 2: still_used is still in the checkout",
    ]);
    let applied = fixture.apply(&batch, &manifest(
        r#"<update id="1" files="src/gate.rs" cites="src/gate.rs:1" missing="old_limit">`new_limit` is 10, the cap on batch work.</update>"#,
    ));
    assert_eq!(applied.applied, 1, "{applied:?}");
    assert_eq!(
        fixture.memory(1).1,
        "`new_limit` is 10, the cap on batch work."
    );
}

#[test]
fn a_recent_unmerged_branch_without_a_worktree_refuses_both_archive_forms() {
    let fixture = Fixture::on("main", &[("src/live.rs", "fn live_function() {}\n")]);
    let branch = "campaign/local-secret-delivery-b17";
    fixture
        .repo
        .write(&[("src/job.rs", "struct WindowsJob;\n")]);
    fixture.repo.commit("add job");
    fixture.repo.git(&["checkout", "-qb", branch]);
    fixture.repo.write(&[(
        "src/job.rs",
        "struct WindowsJob;\nfn revoke(_: WindowsJob) {}\n",
    )]);
    let campaign = fixture.repo.commit("revoke job");
    fixture.repo.git(&["checkout", "-q", "main"]);
    fixture.repo.git(&["rm", "-q", "src/job.rs"]);
    fixture.repo.commit("remove job from main");
    fixture.insert(&[
        row(
            1,
            "`WindowsJob` is revoked synchronously by `live_function`.",
        ),
        row(2, "`WindowsJob` is revoked at task completion."),
    ]);

    let applied = fixture.apply(
        &plan_one(&fixture),
        &manifest(
            r#"<archive id="1" reason="the live function does no cleanup" cites="src/live.rs:1"/>
<archive id="2" missing="WindowsJob"/>"#,
        ),
    );
    assert_eq!((applied.proposed, applied.applied), (2, 0), "{applied:?}");
    assert_eq!(
        applied.dropped,
        [
            format!(
                "memory 1: WindowsJob changed in unmerged commit {} on branch {branch}",
                &campaign[..12]
            ),
            format!(
                "memory 2: WindowsJob changed in unmerged commit {} on branch {branch}",
                &campaign[..12]
            ),
        ]
    );
    assert_eq!(fixture.memory(1).0, "active");
    assert_eq!(fixture.memory(2).0, "active");
    assert!(fixture.history().is_empty());
}

#[test]
fn unmerged_history_can_touch_a_different_citation_by_path() {
    let fixture = Fixture::on("main", &[("src/live.rs", "fn live_function() {}\n")]);
    fixture
        .repo
        .add_then_remove(&[("src/job.rs", "struct WindowsJob;\n")]);
    fixture.repo.git(&["checkout", "-qb", "campaign"]);
    fixture.repo.write(&[("crates/worker/src/job.rs", "\n")]);
    let change = fixture.repo.commit("move job path");
    fixture.repo.git(&["checkout", "-q", "main"]);
    fixture.insert(&[row(1, "`WindowsJob` runs cleanup in `src/job.rs`.")]);

    let applied = fixture.apply(
        &plan_one(&fixture),
        &manifest(r#"<archive id="1" missing="WindowsJob"/>"#),
    );
    assert_eq!(
        applied.dropped,
        [format!(
            "memory 1: src/job.rs changed in unmerged commit {} on branch campaign",
            &change[..12]
        )]
    );
    assert_eq!(fixture.memory(1).0, "active");
}

#[test]
fn old_or_merged_local_branches_do_not_refuse_an_archive() {
    let fixture = Fixture::on("main", &[("src/live.rs", "fn live_function() {}\n")]);
    let repo = &fixture.repo;
    repo.git(&["checkout", "-qb", "stale"]);
    repo.write(&[("src/old.rs", "struct WindowsJob;\n")]);
    repo.git(&["add", "src/old.rs"]);
    repo.git(&["commit", "-qm", "old job", "--date=2001-01-01T00:00:00Z"]);
    repo.git(&[
        "rebase",
        "-q",
        "--force-rebase",
        "--committer-date-is-author-date",
        "main",
    ]);
    repo.git(&["checkout", "-q", "main"]);
    repo.git(&["checkout", "-qb", "merged"]);
    repo.write(&[("src/job.rs", "struct WindowsJob;\n")]);
    repo.commit("add job");
    repo.git(&["checkout", "-q", "main"]);
    repo.git(&["merge", "-q", "--ff-only", "merged"]);
    repo.git(&["rm", "-q", "src/job.rs"]);
    repo.commit("remove job");
    fixture.insert(&[row(1, "`WindowsJob` runs cleanup.")]);

    let applied = fixture.apply(
        &plan_one(&fixture),
        &manifest(r#"<archive id="1" missing="WindowsJob"/>"#),
    );
    assert_eq!(
        (applied.applied, applied.dropped.len()),
        (1, 0),
        "{applied:?}"
    );
    assert_eq!(fixture.memory(1).0, "archived");
}

#[test]
fn a_recent_branch_search_timeout_refuses_the_archive_as_undecided() {
    let fixture = Fixture::on("main", &[("src/live.rs", "struct WindowsJob;\n")]);
    fixture.repo.git(&["checkout", "-qb", "campaign"]);
    fixture.repo.commit("campaign work");
    fixture.repo.git(&["checkout", "-q", "main"]);
    fixture.insert(&[row(1, "`WindowsJob` runs cleanup.")]);
    let mut batch = plan_one(&fixture);
    batch.archive_branches.timeout = std::time::Duration::ZERO;

    let applied = fixture.apply(
        &batch,
        &manifest(
            r#"<archive id="1" reason="WindowsJob is a unit struct" cites="src/live.rs:1"/>"#,
        ),
    );
    assert_eq!(
        applied.dropped,
        ["memory 1: the recent local branch check is undecided: searching unmerged history for WindowsJob failed: git log timed out"]
    );
    assert_eq!(fixture.memory(1).0, "active");
}

#[test]
fn archives_search_all_recent_tips_even_when_they_need_several_log_calls() {
    let fixture = Fixture::on(
        "main",
        &[(
            "src/live.rs",
            "struct WindowsJob;\nconst CACHE_SIZE: usize = 4;\nstruct RemovedWorker;\n",
        )],
    );
    let repo = &fixture.repo;
    repo.git(&["checkout", "-qb", "keeper"]);
    repo.write(&[("src/job.rs", "struct WindowsJob;\n")]);
    repo.git(&["add", "src/job.rs"]);
    repo.git(&["commit", "-qm", "add job", "--date=7.days.ago"]);
    repo.git(&[
        "rebase",
        "-q",
        "--force-rebase",
        "--committer-date-is-author-date",
        "main",
    ]);
    let keeper = repo.git(&["rev-parse", "HEAD"]);
    repo.git(&["checkout", "-q", "main"]);
    let tree = repo.git(&["rev-parse", "HEAD^{tree}"]);
    // Put the match after more than one command's worth of newer tips.
    for index in 0..260 {
        let name = format!("worker-{index}");
        let tip = repo.git(&["commit-tree", tree.trim(), "-p", "main", "-m", &name]);
        repo.git(&["branch", &name, tip.trim()]);
    }
    fixture.insert(&[
        row(1, "`WindowsJob` runs cleanup."),
        row(2, "`CACHE_SIZE` is ten."),
        row(3, "`RemovedWorker` shows the queue."),
    ]);

    let applied = fixture.apply(
        &plan_one(&fixture),
        &manifest(
            r#"<archive id="1" reason="WindowsJob is a unit struct" cites="src/live.rs:1"/>
<archive id="2" reason="the cache holds four entries" cites="src/live.rs:2"/>
<archive id="3" reason="RemovedWorker is a unit struct" cites="src/live.rs:3"/>"#,
        ),
    );
    assert_eq!(
        applied.dropped,
        [format!(
            "memory 1: WindowsJob changed in unmerged commit {} on branch keeper",
            &keeper[..12]
        )]
    );
    assert_eq!(fixture.memory(1).0, "active");
    assert_eq!(fixture.memory(2).0, "archived");
    assert_eq!(fixture.memory(3).0, "archived");
}

#[test]
fn a_missing_name_that_is_not_one_of_the_memorys_citations_is_refused() {
    let fixture = fixture();
    let batch = plan_one(&fixture);
    let applied = fixture.apply(
        &batch,
        &manifest(
            r#"<archive id="1" reason="x" missing="never_cited_name"/>
<archive id="2" reason="x" missing="the old timer"/>"#,
        ),
    );
    assert_eq!(
        applied.dropped,
        [
            "memory 1: missing=\"never_cited_name\" is not a path or name the memory cites",
            "memory 2: missing=\"the old timer\" is not a path or name the memory cites",
        ]
    );
    // The rule a real reply could have archived: its text holds the word,
    // which is kebab-shaped and in no file, but it is English, not a
    // citation, so the rule's subject can't be shown gone.
    let fixture = Fixture::new(&[("a.rs", "\n")]);
    fixture.insert(&[Row {
        tag: "PROJECT_RULES",
        ..row(
            1,
            "When intentionally keeping an audit-flagged pattern, add inline comments explaining why.",
        )
    }]);
    let batch = plan_one(&fixture);
    let applied = fixture.apply(
        &batch,
        &manifest(r#"<archive id="1" reason="no audit flags remain" missing="audit-flagged"/>"#),
    );
    assert_eq!(
        applied.dropped,
        ["memory 1: missing=\"audit-flagged\" is not a path or name the memory cites"]
    );
    assert_eq!(fixture.memory(1).0, "active");
    // A qualified name the memory cites, gone from the checkout, still
    // archives.
    let fixture = Fixture::new(&[("a.rs", "\n")]);
    fixture
        .repo
        .add_then_remove(&[("src/lane.rs", "RecipeLane::Pi\n")]);
    fixture.insert(&[row(1, "Pi sessions run through RecipeLane::Pi.")]);
    let applied = fixture.apply(
        &plan_one(&fixture),
        &manifest(r#"<archive id="1" missing="RecipeLane::Pi"/>"#),
    );
    assert_eq!((applied.applied, applied.dropped.len()), (1, 0));
    assert_eq!(fixture.memory(1).0, "archived");
}

#[test]
fn an_uncommitted_deletion_does_not_prove_removal() {
    let fixture = fixture();
    let batch = plan_one(&fixture);
    fixture.repo.git(&["rm", "-f", "src/live.rs"]);
    let applied = fixture.apply(
        &batch,
        &manifest(r#"<archive id="1" missing="live_function"/>"#),
    );
    assert_eq!(
        applied.dropped,
        ["memory 1: live_function is still in the checkout"]
    );
    assert_eq!(fixture.memory(1).0, "active");
}

#[test]
fn the_missing_lookup_runs_when_the_reply_is_accepted_not_inside_the_write() {
    let fixture = fixture();
    let batch = plan_one(&fixture);
    let reply = manifest(r#"<archive id="2" reason="removed" missing="gone_function"/>"#);
    crate::dreamer::run::TaskInput::accepts(&batch, &reply).unwrap();
    // The name appears after the reply was accepted; the write uses what
    // the lookup found then.
    fixture
        .repo
        .write(&[("src/other.rs", "fn gone_function() {}\n")]);
    let applied = fixture.apply(&batch, &reply);
    assert_eq!((applied.applied, applied.dropped.len()), (1, 0));
    assert_eq!(fixture.memory(2).0, "archived");
}

#[test]
fn an_archive_needs_what_is_missing_to_have_been_in_the_history() {
    let fixture = Fixture::new(&[("src/live.rs", "fn live_function() {}\n")]);
    fixture
        .repo
        .add_then_remove(&[("src/old/removed.rs", "fn removed_function() {}\n")]);
    fixture.insert(&[
        // Another module's parameter, which this repository never held.
        row(1, "Settle requires merged_ref."),
        // A file that was never here.
        row(2, "The timer lives in src/old/never.rs."),
        // A name added in one commit and deleted in a later one.
        row(3, "removed_function registers the timer."),
        // A file added and deleted likewise.
        row(4, "The timer lives in src/old/removed.rs."),
    ]);
    let applied = fixture.apply(
        &plan_one(&fixture),
        &manifest(
            r#"<archive id="1" missing="merged_ref"/>
<archive id="2" missing="src/old/never.rs"/>
<archive id="3" missing="removed_function"/>
<archive id="4" missing="src/old/removed.rs"/>"#,
        ),
    );
    let mut dropped = applied.dropped.clone();
    dropped.sort();
    assert_eq!(
        dropped,
        [
            "memory 1: merged_ref was never in this repository",
            "memory 2: src/old/never.rs was never in this repository",
        ]
    );
    assert_eq!(applied.applied, 2);
    let statuses: Vec<String> = (1..=4).map(|id| fixture.memory(id).0).collect();
    assert_eq!(statuses, ["active", "active", "archived", "archived"]);
}

#[test]
fn an_archive_whose_history_search_runs_out_of_time_is_dropped() {
    let fixture = fixture();
    let mut batch = plan_one(&fixture);
    batch.history_timeout = std::time::Duration::ZERO;
    let applied = fixture.apply(
        &batch,
        &manifest(r#"<archive id="2" missing="gone_function"/>"#),
    );
    assert_eq!(
        applied.dropped,
        ["memory 2: whether gone_function is gone is undecided: searching the history for it failed: git log timed out"]
    );
    assert_eq!(fixture.memory(2).0, "active");
}

#[test]
fn an_archive_without_missing_needs_cited_subject_lines_and_is_refused_for_a_directive() {
    let fixture = Fixture::new(&[(
        "a.rs",
        "const CACHE_SIZE: usize = 40;\nconst QUEUE_SIZE: usize = 40;\n",
    )]);
    fixture
        .repo
        .add_then_remove(&[("gone_settings.toml", "x = 1\n")]);
    fixture.insert(&[
        row(1, "The cache holds ten entries."),
        row(2, "`CACHE_SIZE` sets the cache to twenty entries."),
        Row {
            tag: "PROJECT_RULES",
            ..row(3, "Never edit `gone_config.toml` by hand.")
        },
        Row {
            tag: "PROJECT_RULES",
            ..row(4, "Never edit `gone_settings.toml` by hand.")
        },
    ]);
    let batch = plan_one(&fixture);
    let unrelated = fixture.apply(
        &batch,
        &manifest(r#"<skip id="1"/><archive id="2" reason="the cache holds forty entries" cites="a.rs:2"/>"#),
    );
    assert_eq!(
        unrelated.dropped,
        ["memory 2: none of the cited lines names a path or code name the memory cites"]
    );
    let applied = fixture.apply(
        &batch,
        &manifest(
            r#"<archive id="1" reason=" "/>
<archive id="2" reason="the cache holds forty entries" cites="a.rs:1"/>
<archive id="3" reason="the file is gone"/>
<archive id="4" missing="gone_settings.toml"/>"#,
        ),
    );
    assert_eq!(
        applied.dropped,
        [
            "memory 1: an archive or rewrite needs cites for the code's evidence",
            "memory 3: a project rule that reads as a behavioural directive is archived only with missing=, once everything it cites is gone",
        ]
    );
    let statuses: Vec<String> = (1..=4).map(|id| fixture.memory(id).0).collect();
    assert_eq!(statuses, ["active", "archived", "active", "archived"]);
    let reasons: Vec<Value> = fixture
        .history()
        .into_iter()
        .map(|(id, _, reason, _, _)| json!([id, reason]))
        .collect();
    assert_eq!(
        reasons,
        [
            json!([2, "the cache holds forty entries"]),
            json!([4, "gone_settings.toml is gone from the checkout"])
        ]
    );
}

#[test]
fn a_missing_file_cannot_archive_a_rule_that_still_names_a_live_file() {
    let fixture = Fixture::new(&[("live_settings.toml", "x = 1\n")]);
    fixture
        .repo
        .add_then_remove(&[("gone_settings.toml", "x = 1\n")]);
    fixture.insert(&[Row {
        tag: "PROJECT_RULES",
        ..row(
            1,
            "Never edit `gone_settings.toml` or `live_settings.toml` by hand.",
        )
    }]);

    let batch = plan_one(&fixture);
    let applied = fixture.apply(
        &batch,
        &manifest(r#"<archive id="1" missing="gone_settings.toml"/>"#),
    );
    assert_eq!(fixture.memory(1).0, "active");
    assert_eq!(
        applied.dropped,
        ["memory 1: live_settings.toml is still in the checkout"]
    );
}

#[test]
fn a_configured_release_protects_an_unlined_memory_after_main_removes_its_code() {
    for with_worktree in [false, true] {
        let mut fixture = Fixture::new(&[("release_only.rs", "fn release_only() {}\n")]);
        let _worktree = if with_worktree {
            Some(fixture.repo.worktree("release"))
        } else {
            fixture.repo.git(&["branch", "release"]);
            None
        };
        fixture.repo.git(&["rm", "release_only.rs"]);
        fixture
            .repo
            .commit("remove the release code from the default branch");
        fixture.branches = vec!["release".into()];
        fixture.insert(&[row(1, "The release handler is in `release_only.rs`.")]);

        let applied = fixture.apply(
            &plan_one(&fixture),
            &manifest(r#"<archive id="1" missing="release_only.rs"/>"#),
        );
        assert_eq!(
            fixture.memory(1).0,
            "active",
            "with worktree: {with_worktree}"
        );
        assert_eq!(applied.applied, 0);
        assert!(applied.dropped[0].contains("live"), "{applied:?}");
    }
}

#[test]
fn a_protected_memory_is_never_archived_but_may_be_verified_updated_or_skipped() {
    let fixture = Fixture::new(&[("src/live.rs", "fn live_function() {}\n")]);
    fixture
        .repo
        .add_then_remove(&[("src/old/other.rs", "fn gone_other() {}\n")]);
    fixture.insert(&[
        row(1, "`gone_guard` in src/old/guard.rs stops every delete."),
        row(2, "`gone_helper` cleans the queue."),
        row(3, "`gone_other` in src/old/other.rs does it."),
        row(4, "live_function has exactly one caller."),
        row(5, "live_function is defined once."),
        row(6, "live_function never panics."),
    ]);
    // 1, 4 and 6 are safety-critical, 5 is permanent, and the person edited
    // 2 in the apps; 3 is not protected.
    fixture.execute(&format!(
        "UPDATE memories SET safety_critical = 1 WHERE id IN (1, 4, 6);
         UPDATE memories SET status = 'permanent' WHERE id = 5;
         INSERT INTO memory_history(memory_id, revision, previous_text, applied_at, reason,
                                    evidence_json, source_ids_json, decision_key)
              VALUES (2, 0, 'before', 1, 'edited', '[]', '[2]', 'person-edit-2');
         INSERT INTO memory_journal(project_path, decision_key, operation, receipt_json, applied_at)
              VALUES ('{}', 'person-edit-2', 'person_edit', '{{}}', 1);",
        super::super::tests::PROJECT
    ));
    // Each of the six memories takes a message of its own in the broad run;
    // the one reply is applied to each, which reads only its own memory's
    // verdict.
    let reply = manifest(
        r#"<archive id="1" missing="gone_guard"/>
<archive id="2" reason="the helper was removed" missing="gone_helper"/>
<archive id="3" missing="gone_other"/>
<update id="4" files="src/live.rs" cites="src/live.rs:1">live_function has exactly two callers.</update>
<verified id="5" files="src/live.rs" cites="src/live.rs:1-1"/>
<skip id="6"/>"#,
    );
    let mut applied = crate::dreamer::task::Applied::default();
    for batch in fixture.batches(true) {
        let one = fixture.apply(&batch, &reply);
        applied.applied += one.applied;
        applied.dropped.extend(one.dropped);
    }
    assert_eq!(
        applied.dropped,
        [
            "memory 1 is protected (safety-critical, permanent, a policy, or the person's own) and is never archived",
            "memory 2 is protected (safety-critical, permanent, a policy, or the person's own) and is never archived",
        ]
    );
    assert_eq!(applied.applied, 4);
    let statuses: Vec<String> = (1..=6).map(|id| fixture.memory(id).0).collect();
    assert_eq!(
        statuses,
        [
            "active",
            "active",
            "archived",
            "active",
            "permanent",
            "active"
        ]
    );
    assert_eq!(
        fixture.memory(4).1,
        "live_function has exactly two callers."
    );
    assert!(fixture.memory(5).3.is_some());
    assert!(fixture.memory(6).4["dreamerCheckedAt"].as_i64().is_some());
}

#[test]
fn undoing_a_verify_run_puts_back_its_rows_and_the_mappings_it_replaced() {
    use crate::memory_writes::person::{self, OwnerRef};

    let fixture = Fixture::new(&[
        ("src/live.rs", "fn live_function(a: u8) {}\n"),
        ("src/other.rs", "fn other() {}\n"),
    ]);
    fixture
        .repo
        .add_then_remove(&[("src/old/gone.rs", "fn gone_function() {}\n")]);
    fixture.insert(&[
        row(1, "`live_function` is defined in the live module."),
        Row {
            files: vec!["src/other.rs"],
            ..row(2, "`gone_function` in src/old/gone.rs does the work.")
        },
        row(3, "live_function takes no arguments at all."),
        Row {
            files: vec!["src/live.rs"],
            verified: Some((5, None)),
            ..row(4, "live_function lives in src/live.rs.")
        },
    ]);
    let batch = plan_one(&fixture);
    let applied = fixture.apply(
        &batch,
        &manifest(
            r#"<verified id="1" files="src/live.rs" cites="src/live.rs:1-1"/>
<verified id="4" files="src/live.rs" cites="src/live.rs:1-1"/>
<update id="3" files="src/live.rs" cites="src/live.rs:1">live_function takes one argument.</update>
<archive id="2" missing="gone_function"/>"#,
        ),
    );
    assert_eq!((applied.applied, applied.dropped.len()), (4, 0));
    assert_eq!(fixture.mapping(1), ["src/live.rs"]);
    assert!(fixture.mapping(2).is_empty());
    let owner = OwnerRef {
        level: "project".into(),
        owner_id: super::super::tests::PROJECT.into(),
    };
    let plan = fixture
        .db
        .with_connection(|conn| person::plan_run_undo(conn, &owner, 7))
        .unwrap();
    assert!(plan.left.is_empty(), "{:?}", plan.left);
    assert_eq!(
        plan.restore
            .iter()
            .map(|(target, _)| target.id)
            .collect::<Vec<_>>(),
        [2, 3]
    );
    // 4 was checked against the same file again, which is no new mapping.
    assert_eq!(
        plan.mappings
            .iter()
            .map(|mapping| mapping.id)
            .collect::<Vec<_>>(),
        [1, 2]
    );
    fixture
        .db
        .with_connection(|conn| person::undo_run(conn, &owner, 7, &plan))
        .unwrap();
    assert!(fixture.mapping(1).is_empty());
    assert_eq!(fixture.memory(2).0, "active");
    assert_eq!(fixture.mapping(2), ["src/other.rs"]);
    assert_eq!(
        fixture.memory(3).1,
        "live_function takes no arguments at all."
    );
    // Restoring the older text cleared the update's mapping, as restoring
    // any text does.
    assert!(fixture.mapping(3).is_empty());
    assert_eq!(fixture.mapping(4), ["src/live.rs"]);
}

/// Verify's writes are captured for the user's other computers: a
/// confirmation, a skip, an update and an archive each queue one outbox row
/// for the memory they touch, its revision raised once
/// ([`crate::replica`]).
#[test]
fn each_verdict_queues_one_outbox_row_per_memory() {
    use crate::replica::test_support::{assert_changes_captured, mark_sent, state};
    for reply in [
        r#"<verified id="1" files="src/live.rs" cites="src/live.rs:1-1"/>
<skip id="2" reason="code can't decide it"/>"#,
        r#"<update id="1" files="src/live.rs" cites="src/live.rs:1">`live_function` in src/live.rs takes no arguments and returns unit.</update>
<archive id="2" missing="gone_function"/>"#,
    ] {
        let fixture = fixture();
        let batch = plan_one(&fixture);
        let before = fixture.db.with_connection(|conn| {
            mark_sent(conn);
            state(conn)
        });
        let applied = fixture.apply(&batch, &manifest(reply));
        assert_eq!(applied.applied, 2, "{reply}: {applied:?}");
        let changed = fixture
            .db
            .with_connection(|conn| assert_changes_captured(conn, &before));
        assert_eq!(changed, ["memory:1", "memory:2"], "{reply}");
    }
}
