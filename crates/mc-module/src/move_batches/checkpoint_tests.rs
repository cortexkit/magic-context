use super::*;

#[test]
fn frame_estimates_account_for_restart_and_unfinished_backfill() {
    assert_eq!(estimated_frames(1200, 1000, 900), 300);
    assert_eq!(estimated_frames(400, 1000, 900), 400);
    assert_eq!(estimated_frames(-1, 1000, 900), 0);
}

#[test]
fn bulk_writer_checkpoints_its_writes_and_restores_the_caller_policy() {
    let dir = tempfile::tempdir().unwrap();
    let db =
        crate::context_db::ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
    db.with_connection(|conn| {
        conn.execute_batch("CREATE TABLE checkpoint_probe(content BLOB)")
            .unwrap();
        for policy in [1000, 256] {
            conn.pragma_update(None, "wal_autocheckpoint", policy)
                .unwrap();
            {
                let mut writer = Writer::new(conn).unwrap();
                for _ in 0..8 {
                    writer
                        .transaction("probe", |tx| {
                            tx.execute("INSERT INTO checkpoint_probe VALUES (zeroblob(32768))", [])
                                .map_err(|e| e.to_string())?;
                            Ok(())
                        })
                        .unwrap();
                }
                writer.finish().unwrap();
            }
            let actual: i64 = conn
                .query_row("PRAGMA wal_autocheckpoint", [], |row| row.get(0))
                .unwrap();
            assert_eq!(actual, policy);
            let samples = crate::move_in::tests::checkpoint_samples();
            assert!(
                samples.iter().any(|s| s.2 > 0 && s.3 > 0),
                "the mover must have copied WAL frames itself"
            );
            assert!(samples.iter().all(|s| s.4 == 0));
        }
        let count: i64 = conn
            .query_row("SELECT count(*) FROM checkpoint_probe", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 16);
        {
            let mut writer = Writer::new(conn).unwrap();
            let result: Result<(), String> = writer.transaction("rollback", |tx| {
                tx.execute("INSERT INTO checkpoint_probe VALUES (zeroblob(32768))", [])
                    .unwrap();
                Err("refused".into())
            });
            assert_eq!(result.unwrap_err(), "refused");
        }
        let policy: i64 = conn
            .query_row("PRAGMA wal_autocheckpoint", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            policy, 256,
            "an error must not leave automatic checkpoints disabled"
        );
        let count: i64 = conn
            .query_row("SELECT count(*) FROM checkpoint_probe", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 16);
    });
}
