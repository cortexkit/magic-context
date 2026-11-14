use serde_json::{json, Value};

use super::super::tests::{row, Fixture, Row};
use super::super::{look_for, Absence};
use crate::dreamer::checkout::Limits;

/// A checkout with one live source file, and a store holding memory 1 (an
/// architecture fact citing `live_function`) and memory 2 (one citing only
/// what is gone).
fn fixture() -> Fixture {
    let fixture = Fixture::new(&[
        ("src/live.rs", "fn live_function() {}\n"),
        ("src/other.rs", "fn other() {}\n"),
    ]);
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

/// The one batch a broad run of `fixture` plans.
fn plan_one(fixture: &Fixture) -> super::super::VerifyBatch {
    let mut batches = fixture.batches(true);
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
            r#"<verified id="1" files="./src/live.rs, src/untracked.rs, src/live.rs"/>
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
    assert_eq!(
        metadata,
        json!({"dreamerVerifiedAt": verified_at, "dreamerVerifiedCommit": head, "dreamerCheckedAt": verified_at})
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
    let batch = fixture.batches_under(true, &declaration).remove(0);
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
            r#"<update id="1" files="src/live.rs" consolidation="true">live_function takes one argument.</update>
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
fn a_missing_name_the_memory_does_not_cite_or_the_module_cannot_look_up_is_refused() {
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
    let fixture = Fixture::new(&[("a.rs", "\n")]);
    fixture.insert(&[row(1, "It uses ContextDb::open_gone here.")]);
    let applied = fixture.apply(
        &plan_one(&fixture),
        &manifest(r#"<archive id="1" missing="ContextDb::open_gone"/>"#),
    );
    assert_eq!(
        applied.dropped,
        ["memory 1: whether ContextDb::open_gone is gone is undecided: ContextDb::open_gone is neither a path nor a code name the module can look up"]
    );
}

#[test]
fn a_name_whose_search_was_cut_is_undecided() {
    let fixture = fixture();
    let checkout = fixture.repo.checkout();
    let cut = Limits {
        max_files: 0,
        max_time: std::time::Duration::from_secs(60),
    };
    assert!(matches!(
        look_for(&checkout, "gone_function", &cut),
        Absence::Undecided(why) if why.contains("stopped after 0 files")
    ));
    assert_eq!(
        look_for(
            &checkout,
            "gone_function",
            &crate::dreamer::checkout::SEARCH_LIMITS
        ),
        Absence::Absent
    );
    assert_eq!(look_for(&checkout, "src/live.rs", &cut), Absence::Present);
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
fn an_archive_without_missing_needs_a_reason_and_is_refused_for_a_directive() {
    let fixture = Fixture::new(&[("a.rs", "\n")]);
    fixture.insert(&[
        row(1, "The cache holds ten entries."),
        row(2, "The cache holds twenty entries."),
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
    let applied = fixture.apply(
        &batch,
        &manifest(
            r#"<archive id="1" reason=" "/>
<archive id="2" reason="a.rs holds no cache"/>
<archive id="3" reason="the file is gone"/>
<archive id="4" missing="gone_settings.toml"/>"#,
        ),
    );
    assert_eq!(
        applied.dropped,
        [
            "memory 1: an archive without missing= needs the code's evidence in reason",
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
            json!([2, "a.rs holds no cache"]),
            json!([4, "gone_settings.toml is gone from the checkout"])
        ]
    );
}

#[test]
fn a_protected_memory_is_never_archived_but_may_be_verified_updated_or_skipped() {
    let fixture = Fixture::new(&[("src/live.rs", "fn live_function() {}\n")]);
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
    let batch = plan_one(&fixture);
    let applied = fixture.apply(
        &batch,
        &manifest(
            r#"<archive id="1" missing="gone_guard"/>
<archive id="2" reason="the helper was removed" missing="gone_helper"/>
<archive id="3" missing="gone_other"/>
<update id="4" files="src/live.rs">live_function has exactly two callers.</update>
<verified id="5" files="src/live.rs"/>
<skip id="6"/>"#,
        ),
    );
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
            r#"<verified id="1" files="src/live.rs"/>
<verified id="4" files="src/live.rs"/>
<update id="3" files="src/live.rs">live_function takes one argument.</update>
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
