use super::*;
use rusqlite::{Connection, StatementStatus};

fn old_triggers(conn: &Connection) {
    let sql = MIGRATIONS
        .iter()
        .find(|m| m.version == 43)
        .unwrap()
        .statements;
    for name in [
        "mc_tags_cache_generation_delete",
        "mc_tags_cache_generation_update",
    ] {
        let start = format!("CREATE TRIGGER {name} ");
        let (_, rest) = sql.split_once(&start).unwrap();
        let (body, _) = rest.split_once("END;").unwrap();
        conn.execute_batch(&format!("{start}{body}END;")).unwrap();
    }
}

fn tag_schema(conn: &Connection) {
    conn.execute_batch(
        "CREATE TABLE mc_tags (session_id TEXT NOT NULL, tag_number INTEGER NOT NULL,
         block_id TEXT NOT NULL, kind TEXT NOT NULL, token_count INTEGER NOT NULL DEFAULT 0,
         source_bytes BLOB, PRIMARY KEY (session_id, tag_number), UNIQUE (session_id, block_id));",
    )
    .unwrap();
    conn.execute_batch(
        MIGRATIONS
            .iter()
            .find(|m| m.version == 43)
            .unwrap()
            .statements,
    )
    .unwrap();
}

fn summaries(conn: &Connection) -> Vec<(String, i64, i64, i64)> {
    conn.prepare("SELECT session_id, generation, tag_count, max_tag_number FROM mc_tag_cache_generations ORDER BY session_id")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

#[test]
fn migration_62_upgrades_populated_61_store_without_losing_tag_summaries() {
    let dir = tempfile::tempdir().unwrap();
    let descriptor = descriptor(dir.path());
    let store = McStore::open_for_test(&descriptor).unwrap();
    // Rewind just the tag triggers and migration stamp to represent the same populated v61
    // database that an older binary leaves behind; all other schema objects remain intact.
    store
        .inner
        .with_conn(|conn| {
            conn.execute_batch(
                "DROP TRIGGER mc_tags_cache_generation_delete;
                            DROP TRIGGER mc_tags_cache_generation_update;
                            DROP TRIGGER mc_tags_cache_generation_update_same_session;",
            )?;
            old_triggers(conn);
            conn.execute(
                "DELETE FROM cortexkit_schema_version WHERE namespace = ?1 AND version = 62",
                params![NS],
            )?;
            Ok(())
        })
        .unwrap();
    store
        .mint_or_get_tags(
            "ses",
            &[TagMintInput {
                block_id: "block".into(),
                kind: "message".into(),
                token_count: 3,
                source_bytes: b"payload".to_vec(),
            }],
            1,
        )
        .unwrap();
    let before = store.tag_cache_summary("ses").unwrap();
    drop(store);
    let migrated = McStore::open_for_test(&descriptor).unwrap();
    assert_eq!(migrated.tag_cache_summary("ses").unwrap(), before);
    migrated
        .execute_tag_sql_for_test(
            "UPDATE mc_tags SET source_bytes = X'02' WHERE session_id = 'ses'",
        )
        .unwrap();
    assert_eq!(
        migrated.tag_cache_summary("ses").unwrap().generation,
        before.generation + 2
    );
    assert_eq!(migrated.load_tags_for_session("ses").unwrap().len(), 1);
}

#[test]
fn migration_62_matches_old_triggers_after_every_mutation() {
    let old = Connection::open_in_memory().unwrap();
    let new = Connection::open_in_memory().unwrap();
    tag_schema(&old);
    tag_schema(&new);
    new.execute_batch(
        MIGRATIONS
            .iter()
            .find(|migration| migration.version == 62)
            .unwrap()
            .statements,
    )
    .unwrap();
    let mut seed = 0x1234_5678_u64;
    let directed = [
        "INSERT INTO mc_tags(session_id,tag_number,block_id,kind) VALUES ('a',1,'first','message')",
        "INSERT INTO mc_tags(session_id,tag_number,block_id,kind) VALUES ('a',2,'second','message')",
        "UPDATE mc_tags SET tag_number = 5 WHERE session_id = 'a' AND tag_number = 2",
        "UPDATE mc_tags SET tag_number = 3 WHERE session_id = 'a' AND tag_number = 5",
        "UPDATE mc_tags SET session_id = 'b' WHERE session_id = 'a' AND tag_number = 3",
        "DELETE FROM mc_tags WHERE session_id = 'a'",
        "DELETE FROM mc_tags WHERE session_id = 'b'",
        "DELETE FROM mc_tag_cache_generations WHERE session_id = 'b'",
        "INSERT INTO mc_tags(session_id,tag_number,block_id,kind) VALUES ('b',9,'again','message')",
        "DELETE FROM mc_tag_cache_generations WHERE session_id = 'b'",
        "UPDATE mc_tags SET tag_number = 7 WHERE session_id = 'b' AND tag_number = 9",
        "DELETE FROM mc_tag_cache_generations WHERE session_id = 'b'",
        "DELETE FROM mc_tags WHERE session_id = 'b' AND tag_number = 7",
    ];
    for (step, sql) in directed.into_iter().enumerate() {
        old.execute(sql, []).unwrap();
        new.execute(sql, []).unwrap();
        assert_eq!(
            summaries(&new),
            summaries(&old),
            "directed step {step}: {sql}"
        );
    }
    for step in 0..1200 {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        let session = if seed & 1 == 0 { "a" } else { "b" };
        let number = (seed >> 8) % 32 + 1;
        let sql = match (seed >> 16) % 6 {
            0 => format!("INSERT OR IGNORE INTO mc_tags(session_id, tag_number, block_id, kind) VALUES ('{session}', {number}, 'b{step}', 'message')"),
            1 => format!("UPDATE mc_tags SET source_bytes = X'01' WHERE session_id = '{session}' AND tag_number = {number}"),
            2 => format!("UPDATE OR IGNORE mc_tags SET tag_number = {number} WHERE session_id = '{session}' AND tag_number = {}", (seed >> 24) % 32 + 1),
            3 => format!("DELETE FROM mc_tags WHERE session_id = '{session}' AND tag_number = {number}"),
            4 => format!("DELETE FROM mc_tags WHERE session_id = '{session}'"),
            _ => format!("UPDATE OR IGNORE mc_tags SET session_id = '{}' WHERE session_id = '{session}' AND tag_number = {number}", if session == "a" { "b" } else { "a" }),
        };
        old.execute(&sql, []).unwrap();
        new.execute(&sql, []).unwrap();
        assert_eq!(summaries(&new), summaries(&old), "step {step}: {sql}");
    }
}

#[test]
fn migration_62_bulk_tag_writes_have_linear_vm_step_cost() {
    fn measure(n: i64) -> (i32, i32) {
        let conn = Connection::open_in_memory().unwrap();
        tag_schema(&conn);
        conn.execute_batch(
            MIGRATIONS
                .iter()
                .find(|migration| migration.version == 62)
                .unwrap()
                .statements,
        )
        .unwrap();
        conn.execute_batch(&format!(
            "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < {n})
            INSERT INTO mc_tags(session_id,tag_number,block_id,kind)
            SELECT 'bulk',x,printf('b%d',x),'message' FROM n;"
        ))
        .unwrap();
        let steps = |sql: &str| {
            let mut statement = conn.prepare(sql).unwrap();
            statement.execute([]).unwrap();
            statement.get_status(StatementStatus::VmStep)
        };
        let update = steps("UPDATE mc_tags SET source_bytes = X'01' WHERE session_id = 'bulk'");
        let delete = steps("DELETE FROM mc_tags WHERE session_id = 'bulk'");
        assert_eq!(summaries(&conn), vec![("bulk".to_string(), 4 * n, 0, 0)]);
        (update, delete)
    }
    let baseline = measure(1000);
    let large = measure(8000);
    // The measured 1k-row baseline sets a linear 8k-row budget with 50% slack.
    // A COUNT of the session per row grows quadratically and exceeds this budget.
    assert!(
        large.0 < baseline.0 * 12,
        "update VM steps: baseline {baseline:?}, 8k {large:?}"
    );
    assert!(
        large.1 < baseline.1 * 12,
        "delete VM steps: baseline {baseline:?}, 8k {large:?}"
    );
}
