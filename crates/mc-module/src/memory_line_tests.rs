use serde_json::json;

use super::*;
use crate::context_db::ContextDb;
use crate::dreamer::checkout::tests::{git_at, Repo};
use crate::memory_writes::Writer;

fn line(branch: Option<&str>, commit: &str) -> Line {
    Line {
        branch: branch.map(str::to_owned),
        commit: Some(commit.to_owned()),
    }
}

#[test]
fn a_folders_line_is_its_branch_and_commit_or_its_commit_when_detached() {
    let repo = Repo::on("master", &[("a.rs", "a\n")]);
    let head = repo.git(&["rev-parse", "HEAD"]).trim().to_owned();
    assert_eq!(
        Line::of_folder(repo.path()),
        Some(line(Some("master"), &head))
    );
    let (_outer, worktree) = repo.worktree("feature/x");
    std::fs::create_dir_all(worktree.join("deep")).unwrap();
    assert_eq!(
        Line::of_folder(&worktree.join("deep")),
        Some(line(Some("feature/x"), &head))
    );
    git_at(&worktree, &["checkout", "-q", "--detach"]);
    assert_eq!(Line::of_folder(&worktree), Some(line(None, &head)));
    // No repository, no folder, and a branch without a commit: no line.
    let plain = tempfile::tempdir().unwrap();
    assert_eq!(Line::of_folder(plain.path()), None);
    assert_eq!(Line::of_folder(&plain.path().join("missing")), None);
    let empty = tempfile::tempdir().unwrap();
    git_at(empty.path(), &["init", "-q"]);
    assert_eq!(Line::of_folder(empty.path()), None);
}

fn store() -> (tempfile::TempDir, ContextDb) {
    let dir = tempfile::tempdir().unwrap();
    let db = ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
    (dir, db)
}

fn stored(db: &ContextDb, id: i64) -> Option<Line> {
    db.with_connection(|conn| of_memory(conn, id)).unwrap()
}

/// Run one `ctx_memory` call as a session on `on`; the memory id its reply
/// names.
fn call(db: &ContextDb, on: Option<&Line>, input: serde_json::Value) -> i64 {
    let who = Writer {
        harness: "pi",
        session: "head",
        project: "pj-line",
        authority: None,
        line: on,
    };
    let reply = db
        .with_connection(|conn| crate::memory_tool::call(conn, &who, &input, None))
        .unwrap();
    let digits: String = reply
        .text
        .split("ID:")
        .nth(1)
        .unwrap_or_else(|| panic!("{}", reply.text))
        .trim_start()
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().unwrap()
}

#[test]
fn the_memory_tool_records_the_sessions_line_and_a_merge_the_shared_one() {
    let (_dir, db) = store();
    let master = line(Some("master"), &"a".repeat(40));
    let next = line(Some("next"), &"b".repeat(40));
    let first = call(
        &db,
        Some(&master),
        json!({"action": "write", "category": "ARCHITECTURE", "content": "The head renders the memory block."}),
    );
    assert_eq!(stored(&db, first), Some(master.clone()));
    let second = call(
        &db,
        Some(&master),
        json!({"action": "write", "category": "ARCHITECTURE", "content": "The head renders the history block."}),
    );
    let third = call(
        &db,
        None,
        json!({"action": "write", "category": "ARCHITECTURE", "content": "The head renders the docs block."}),
    );
    assert_eq!(stored(&db, third), None);

    // An update records the line of the session that wrote the new text.
    call(
        &db,
        Some(&next),
        json!({"action": "update", "ids": [third], "content": "The head renders the project docs block."}),
    );
    assert_eq!(stored(&db, third), Some(next.clone()));

    // A merge of two memories on one line carries it, whoever merges.
    let merged = call(
        &db,
        Some(&next),
        json!({"action": "merge", "ids": [first, second], "content": "The head renders the memory and history blocks."}),
    );
    assert_eq!(stored(&db, merged), Some(master.clone()));
    // Sources on two lines: none.
    let mixed = call(
        &db,
        Some(&master),
        json!({"action": "merge", "ids": [merged, third], "content": "The head renders the memory, history and project docs blocks."}),
    );
    assert_eq!(stored(&db, mixed), None);
}

#[test]
fn sources_share_a_line_only_when_every_one_names_the_same_branch() {
    let (_dir, db) = store();
    db.with_connection(|conn| {
        for id in 1..=4 {
            conn.execute(
                "INSERT INTO memories(id, level, owner_id, category, origin_category, content, normalized_hash,
                                      first_seen_at, created_at, updated_at, last_seen_at)
                 VALUES (?1, 'project', 'pj', 'swe:architecture', 'ARCHITECTURE', ?2, ?2, 1, 1, 1, 1)",
                rusqlite::params![id, format!("memory {id}")],
            )?;
        }
        stamp(conn, 1, Some(&line(Some("next"), &"a".repeat(40))))?;
        stamp(conn, 2, Some(&line(Some("next"), &"b".repeat(40))))?;
        stamp(conn, 3, Some(&line(None, &"a".repeat(40))))?;
        assert_eq!(
            shared(conn, &[1, 2])?,
            Some(Line {
                branch: Some("next".into()),
                commit: None
            })
        );
        assert_eq!(shared(conn, &[1])?, Some(line(Some("next"), &"a".repeat(40))));
        // A detached source, or one without a line, shares none.
        assert_eq!(shared(conn, &[1, 3])?, None);
        assert_eq!(shared(conn, &[1, 4])?, None);
        assert_eq!(shared(conn, &[])?, None);
        Ok::<_, rusqlite::Error>(())
    })
    .unwrap();
}
