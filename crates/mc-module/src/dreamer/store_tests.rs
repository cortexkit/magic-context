use chrono::{Local, TimeZone};
use serde_json::json;

use super::*;
use crate::context_db::ContextDb;

const HOUR: i64 = 3_600_000;

fn local(day: u32, hour: u32) -> i64 {
    Local
        .with_ymd_and_hms(2026, 6, day, hour, 0, 0)
        .single()
        .unwrap()
        .timestamp_millis()
}

fn row(
    conn: &Connection,
    task: &str,
) -> (
    Option<i64>,
    Option<String>,
    Option<String>,
    i64,
    Option<i64>,
) {
    conn.query_row(
        "SELECT next_due_at, last_status, last_error, failures, last_run_at FROM dream_schedules
          WHERE level = 'project' AND owner_id = 'pj-a' AND task = ?1",
        [task],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        },
    )
    .unwrap()
}

#[test]
fn the_0_49_dreamer_tables_are_gone_and_the_modules_exist() {
    let conn = ContextDb::fresh_in_memory();
    let tables: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'dream%' OR name = 'task_schedule_state' ORDER BY name")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        tables,
        ["dream_locks", "dream_schedules", "dream_task_runs"]
    );
}

#[test]
fn a_schedule_is_due_at_its_next_slot_and_moves_when_its_setting_changes() {
    let conn = ContextDb::fresh_in_memory();
    let owner = OwnerKey::project("pj-a");
    let now = local(10, 1);
    ensure_schedule(&conn, &owner, "swe:classify-memories", "0 6 * * *", now).unwrap();
    assert_eq!(row(&conn, "swe:classify-memories").0, Some(local(10, 6)));
    // The same setting again changes nothing.
    ensure_schedule(
        &conn,
        &owner,
        "swe:classify-memories",
        "0 6 * * *",
        local(10, 5),
    )
    .unwrap();
    assert_eq!(row(&conn, "swe:classify-memories").0, Some(local(10, 6)));
    // An edited setting moves the task to its new next slot.
    ensure_schedule(&conn, &owner, "swe:classify-memories", "0 2 * * *", now).unwrap();
    assert_eq!(row(&conn, "swe:classify-memories").0, Some(local(10, 2)));
    // Switched off: no due time.
    ensure_schedule(&conn, &owner, "swe:classify-memories", "", now).unwrap();
    assert_eq!(row(&conn, "swe:classify-memories").0, None);

    ensure_schedule(&conn, &owner, "swe:curate", "0 4 * * *", now).unwrap();
    assert!(due(&conn, local(10, 3)).unwrap().is_empty());
    let found = due(&conn, local(10, 4)).unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(
        (found[0].task.as_str(), found[0].next_due_at),
        ("swe:curate", local(10, 4))
    );
}

#[test]
fn settling_moves_the_due_time_and_counts_only_failures() {
    let conn = ContextDb::fresh_in_memory();
    let owner = OwnerKey::project("pj-a");
    let task = "swe:classify-memories";
    ensure_schedule(&conn, &owner, task, "0 6 * * *", local(10, 1)).unwrap();

    let ran_at = local(10, 6);
    settle(
        &conn,
        &owner,
        task,
        &Settled::Failed {
            error: "boom".into(),
        },
        None,
        ran_at,
    )
    .unwrap();
    settle(
        &conn,
        &owner,
        task,
        &Settled::Failed {
            error: "boom".into(),
        },
        None,
        ran_at,
    )
    .unwrap();
    assert_eq!(
        row(&conn, task),
        (
            Some(local(11, 6)),
            Some("failed".into()),
            Some("boom".into()),
            2,
            Some(ran_at)
        )
    );

    // A wait counts nothing, keeps the last run time, and is due when the
    // wait ends, or at the next slot if that comes first.
    let later = ran_at + HOUR;
    settle(
        &conn,
        &owner,
        task,
        &Settled::Waiting {
            until: later + HOUR,
            reason: "account".into(),
        },
        None,
        later,
    )
    .unwrap();
    assert_eq!(
        row(&conn, task),
        (
            Some(later + HOUR),
            Some("waiting".into()),
            Some("account".into()),
            2,
            Some(ran_at)
        )
    );
    settle(
        &conn,
        &owner,
        task,
        &Settled::Waiting {
            until: later + 48 * HOUR,
            reason: "account".into(),
        },
        None,
        later,
    )
    .unwrap();
    assert_eq!(row(&conn, task).0, Some(local(11, 6)));

    // A run resets the failures and stores the task's resume point.
    settle(
        &conn,
        &owner,
        task,
        &Settled::Ran { status: "applied" },
        Some(&json!({"commit": "abc"})),
        later,
    )
    .unwrap();
    assert_eq!(
        row(&conn, task),
        (
            Some(local(11, 6)),
            Some("applied".into()),
            None,
            0,
            Some(later)
        )
    );
    // Skipping keeps the resume point.
    settle(
        &conn,
        &owner,
        task,
        &Settled::Skipped {
            reason: "locked".into(),
        },
        None,
        later,
    )
    .unwrap();
    assert_eq!(
        due(&conn, local(11, 6)).unwrap()[0].watermark,
        Some(json!({"commit": "abc"}))
    );
}

#[test]
fn an_owner_has_one_writer_until_its_lock_lapses() {
    let mut conn = ContextDb::fresh_in_memory();
    let owner = OwnerKey::project("pj-a");
    let now = 1_000_000;
    assert!(lock(&mut conn, &owner, "one", "swe:curate", now, now + 10).unwrap());
    // Another writer waits; the holder may take it again.
    assert!(!lock(&mut conn, &owner, "two", "swe:verify", now + 5, now + 20).unwrap());
    assert!(lock(&mut conn, &owner, "one", "swe:curate", now + 5, now + 20).unwrap());
    assert!(renew(&conn, &owner, "one", now + 30).unwrap());
    // Lapsed: another writer takes it, and the old holder can't renew.
    assert!(lock(&mut conn, &owner, "two", "swe:verify", now + 31, now + 60).unwrap());
    assert!(!renew(&conn, &owner, "one", now + 90).unwrap());
    // Only the holder releases it.
    unlock(&conn, &owner, "one").unwrap();
    assert!(!lock(&mut conn, &owner, "three", "swe:curate", now + 40, now + 70).unwrap());
    unlock(&conn, &owner, "two").unwrap();
    assert!(lock(&mut conn, &owner, "three", "swe:curate", now + 40, now + 70).unwrap());
    // Another owner is independent.
    assert!(lock(
        &mut conn,
        &OwnerKey::project("pj-b"),
        "one",
        "swe:curate",
        now + 40,
        now + 70
    )
    .unwrap());
}

#[test]
fn a_run_record_holds_its_end_and_a_stopped_process_leaves_none_open() {
    let conn = ContextDb::fresh_in_memory();
    let owner = OwnerKey::project("pj-a");
    let done = start_run(
        &conn,
        &owner,
        "swe:classify-memories",
        "classify-memories",
        "swe",
        10,
    )
    .unwrap();
    let open = start_run(&conn, &owner, "swe:curate", "curate", "swe", 11).unwrap();
    finish_run(
        &conn,
        done,
        &RunEnd {
            outcome: "applied".into(),
            input_tokens: 120,
            output_tokens: 30,
            proposed: 4,
            applied: 3,
            dropped: vec!["memory 9 changed".into()],
            batches: vec![json!({"model": "deepseek/deepseek-flash"})],
            ..RunEnd::default()
        },
        20,
    )
    .unwrap();
    assert_eq!(close_interrupted(&conn, 30).unwrap(), 1);
    let rows: Vec<(i64, String, i64, Option<String>)> = conn
        .prepare("SELECT id, outcome, ended_at, dropped_json FROM dream_task_runs ORDER BY id")
        .unwrap()
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        rows,
        [
            (
                done,
                "applied".into(),
                20,
                Some(r#"["memory 9 changed"]"#.into())
            ),
            (open, "interrupted".into(), 30, None),
        ]
    );
}

/// Each lock row, in the order the rows were written: level, owner and
/// holder.
fn locks(conn: &Connection) -> Vec<(String, String, String)> {
    conn.prepare("SELECT level, owner_id, holder FROM dream_locks ORDER BY rowid")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

#[test]
fn several_locks_are_taken_workspace_before_project_all_or_none() {
    let (workspace, project) = (OwnerKey::workspace("ws-a"), OwnerKey::project("pj-a"));
    // Asked for in either order, the workspace's lock comes first.
    assert_eq!(
        lock_order(&[project.clone(), workspace.clone()]),
        [workspace.clone(), project.clone()]
    );
    assert_eq!(
        lock_order(&[
            OwnerKey::project("pj-b"),
            project.clone(),
            OwnerKey::global()
        ]),
        [
            OwnerKey::global(),
            project.clone(),
            OwnerKey::project("pj-b")
        ]
    );

    let mut conn = ContextDb::fresh_in_memory();
    assert!(lock_all(
        &mut conn,
        &[project.clone(), workspace.clone()],
        "this",
        "swe:lift-workspace",
        0,
        100
    )
    .unwrap());
    assert_eq!(
        locks(&conn),
        [
            ("workspace".into(), "ws-a".into(), "this".into()),
            ("project".into(), "pj-a".into(), "this".into()),
        ]
    );
    // Both renew; once another writer takes one after it lapsed, renewing
    // both fails.
    assert!(renew_all(&conn, &[workspace.clone(), project.clone()], "this", 200).unwrap());
    unlock_all(&conn, &[project.clone(), workspace.clone()], "this").unwrap();
    assert!(locks(&conn).is_empty());

    // Another writer holds the project's memories: nothing is taken, not
    // even the workspace's free lock.
    assert!(lock(&mut conn, &project, "other", "swe:curate", 0, 100).unwrap());
    assert!(!lock_all(
        &mut conn,
        &[workspace.clone(), project.clone()],
        "this",
        "swe:lift-workspace",
        0,
        100
    )
    .unwrap());
    assert_eq!(
        locks(&conn),
        [("project".into(), "pj-a".into(), "other".into())]
    );
    assert!(!renew_all(&conn, &[workspace.clone(), project.clone()], "this", 200).unwrap());
    unlock(&conn, &project, "other").unwrap();

    // Another writer holds the workspace's: the same.
    assert!(lock(
        &mut conn,
        &workspace,
        "other",
        "swe:curate-workspace",
        0,
        100
    )
    .unwrap());
    assert!(!lock_all(
        &mut conn,
        &[project.clone(), workspace.clone()],
        "this",
        "swe:lift-workspace",
        0,
        100
    )
    .unwrap());
    assert_eq!(
        locks(&conn),
        [("workspace".into(), "ws-a".into(), "other".into())]
    );
    // A lapsed lock is free to take.
    assert!(lock_all(
        &mut conn,
        &[project.clone(), workspace.clone()],
        "this",
        "swe:lift-workspace",
        100,
        300
    )
    .unwrap());
}

#[test]
fn a_task_made_due_at_a_time_is_due_then_until_it_settles() {
    let conn = ContextDb::fresh_in_memory();
    let owner = OwnerKey::workspace("ws-a");
    let now = local(1, 12);
    ensure_schedule(&conn, &owner, "swe:curate-workspace", "0 4 * * 0", now).unwrap();
    let at = now + HOUR / 2;
    assert!(due_at(&conn, &owner, "swe:curate-workspace", at).unwrap());
    assert_eq!(
        schedule_of(&conn, &owner, "swe:curate-workspace")
            .unwrap()
            .unwrap()
            .next_due_at,
        at
    );
    // Its run settles it back onto the schedule's own slots.
    settle(
        &conn,
        &owner,
        "swe:curate-workspace",
        &Settled::Ran { status: "applied" },
        None,
        at,
    )
    .unwrap();
    assert_eq!(
        schedule_of(&conn, &owner, "swe:curate-workspace")
            .unwrap()
            .unwrap()
            .next_due_at,
        cron::next_due("0 4 * * 0", at).unwrap()
    );
    // A task the settings switch off, or one with no schedule, is not made
    // due.
    ensure_schedule(&conn, &owner, "swe:curate-workspace", "", now).unwrap();
    assert!(!due_at(&conn, &owner, "swe:curate-workspace", at).unwrap());
    assert!(!due_at(&conn, &owner, "swe:other", at).unwrap());
}
