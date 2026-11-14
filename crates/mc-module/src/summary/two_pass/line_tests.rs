//! The second turn's writes record git lines: a new memory or an edit the
//! line of the summarized session's folder, a merge the line its sources
//! share.

use serde_json::json;

use super::workspace_tests::{client, fact, job, reply, store, PROJECT};
use super::*;
use crate::dreamer::checkout::tests::{git_at, Repo};
use crate::memory_line::{of_memory, stamp, Line};
use crate::memory_writes;

fn line(branch: &str, commit: &str) -> Line {
    Line {
        branch: Some(branch.into()),
        commit: Some(commit.into()),
    }
}

#[tokio::test]
async fn a_new_memory_records_the_line_of_the_summarized_sessions_folder() {
    let repo = Repo::on("master", &[("a.rs", "a\n")]);
    let (_outer, worktree) = repo.worktree("feature-x");
    let head = git_at(&worktree, &["rev-parse", "HEAD"]).trim().to_owned();
    let (_dir, db, _, _) = store("ws-none");
    let client = client(None, Some(reply(json!({"action": "new"}))));
    let mut job = job(None);
    job.project_root = Some(worktree.to_str().unwrap().into());
    run(&client, &db, &job).await;
    let (state, reason, id) = fact(&db);
    assert_eq!((state.as_str(), reason.as_str()), ("applied", "inserted"));
    let recorded = db
        .with_connection(|conn| of_memory(conn, id.unwrap()))
        .unwrap();
    assert_eq!(recorded, Some(line("feature-x", &head)));
}

#[test]
fn an_edit_records_the_sessions_line_and_a_merge_the_line_its_sources_share() {
    let (_dir, db, own, _) = store("ws-none");
    let other = db
        .with_connection(|conn| {
            memory_writes::save(
                conn,
                &memory_writes::Writer {
                    harness: "pi",
                    session: "head",
                    project: PROJECT,
                    authority: None,
                    line: None,
                },
                "CONSTRAINTS",
                "Releases are tagged from the release branch.",
            )
        })
        .unwrap()
        .memory_id
        .unwrap();
    let revision = |key: &str, action: &str, expected: Vec<(i64, i64)>| Revision {
        key: key.into(),
        action: action.into(),
        project: PROJECT.into(),
        workspace: None,
        survivor: expected[0].0,
        expected,
        final_text: format!("Releases need two reviewers, revised by {key}."),
        changes: Vec::new(),
        added: Vec::new(),
        expires: None,
    };
    let plan = gates::Plan {
        checks: Vec::new(),
        kept: Vec::new(),
        spans: Vec::new(),
    };
    let session = line("release-0.49", &"a".repeat(40));
    let commit = |revision: &Revision| {
        db.with_connection(|conn| {
            applier::commit_revision(conn, revision, &plan, 1, None, None, Some(&session))
        })
        .unwrap()
    };
    let lines = |id: i64| db.with_connection(|conn| of_memory(conn, id)).unwrap();

    let edited = commit(&revision("edit", "edit", vec![(own, 1)]));
    assert_eq!(edited.state, "applied");
    assert_eq!(lines(own), Some(session.clone()));

    // Sources on different lines (one has none): the survivor names none,
    // whatever the session's line.
    let merged = commit(&revision("merge", "merge", vec![(own, 2), (other, 1)]));
    assert_eq!(merged.state, "applied", "{merged:?}");
    assert_eq!(lines(merged.memory_id.unwrap()), None);

    // Sources that share a branch: the survivor carries it, at the commit
    // they share.
    let (_dir, db, own, _) = store("ws-none");
    let second = db
        .with_connection(|conn| {
            memory_writes::save(
                conn,
                &memory_writes::Writer {
                    harness: "pi",
                    session: "head",
                    project: PROJECT,
                    authority: None,
                    line: None,
                },
                "CONSTRAINTS",
                "Releases are tagged from the release branch.",
            )
        })
        .unwrap()
        .memory_id
        .unwrap();
    let theirs = line("next", &"b".repeat(40));
    db.with_connection(|conn| {
        stamp(conn, own, Some(&theirs))?;
        stamp(conn, second, Some(&theirs))
    })
    .unwrap();
    let merged = db
        .with_connection(|conn| {
            applier::commit_revision(
                conn,
                &revision("shared", "merge", vec![(own, 1), (second, 1)]),
                &plan,
                1,
                None,
                None,
                Some(&session),
            )
        })
        .unwrap();
    assert_eq!(merged.state, "applied", "{merged:?}");
    assert_eq!(
        db.with_connection(|conn| of_memory(conn, merged.memory_id.unwrap()))
            .unwrap(),
        Some(theirs)
    );
}
