use super::*;
use crate::move_snapshot::{
    chunks, digest, record_payload, Chunk, Manifest, SourceMode, HEADER_LENGTH, MAX_RECORD_LENGTH,
};
use crate::{ModuleMeta, TagMintInput};
use cortexkit_cache_core::CoreState;
use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

fn open(dir: &Path) -> McStore {
    McStore::open(&StorageDescriptor {
        module_id: "magic-context".into(),
        storage_namespace: "mc_cache".into(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: dir.join("store.db").to_string_lossy().into_owned(),
        },
    })
    .unwrap()
}
fn binding(cut: &str) -> CutBinding {
    CutBinding {
        cut_id: cut.into(),
        session_ref: "0123456789abcdef".into(),
        host_session_id: "ses_move".into(),
        host_end_offset: 42,
        host_cut: serde_json::json!({"lastMessageId":"msg_1","hostInputs":{"count":1,"digest":"abc"}}),
        mc_start_offset: 100,
    }
}
fn seeded(dir: &Path, count: usize, bytes: usize) -> McStore {
    let store = open(dir);
    store
        .commit(
            "ses_move",
            None,
            &CoreState::default(),
            &ModuleMeta::default(),
        )
        .unwrap();
    store
        .mint_or_get_tags(
            "ses_move",
            &(0..count)
                .map(|n| TagMintInput {
                    block_id: format!("msg_{n}#0"),
                    kind: "message".into(),
                    token_count: n as i64 + 1,
                    source_bytes: vec![(n % 251) as u8; bytes],
                })
                .collect::<Vec<_>>(),
            1,
        )
        .unwrap();
    store
}
fn capture(store: &McStore, cut: &str, path: &Path) -> MoveStore {
    let mut mover = store.move_store().unwrap();
    mover.acquire_fence(&binding(cut)).unwrap();
    mover.freeze(cut).unwrap();
    mover.capture(cut, path).unwrap();
    mover
}
fn install(mover: &mut MoveStore, cut: &str) {
    while !mover.install_batch(cut).unwrap().complete {}
}
fn discard(mover: &mut MoveStore, cut: &str) {
    mover.begin_discard(cut).unwrap();
    while !mover.discard_batch(cut).unwrap() {}
    while !mover.discard_key_map_batch(cut).unwrap() {}
    mover.finish_discard(cut).unwrap();
}
fn dump(store: &McStore, table: &str, columns: &str) -> Vec<Vec<Value>> {
    store
        .inner
        .with_conn(|conn| {
            let mut stmt = conn.prepare(&format!(
                "SELECT {columns} FROM {table} WHERE session_id = 'ses_move' ORDER BY 1,2"
            ))?;
            let count = stmt.column_count();
            let rows = stmt
                .query_map([], |r| {
                    (0..count)
                        .map(|i| r.get(i))
                        .collect::<rusqlite::Result<Vec<Value>>>()
                })?
                .collect::<rusqlite::Result<_>>()?;
            Ok(rows)
        })
        .unwrap()
}
#[test]
fn v1_values_are_independent_big_endian_vectors_and_leb128_is_canonical() {
    let values = [
        Value::Null,
        Value::Integer(-2),
        Value::Real(1.5),
        Value::Text("é".into()),
        Value::Blob(vec![0, 255]),
    ];
    let expected = [
        vec![0],
        vec![1, 255, 255, 255, 255, 255, 255, 255, 254],
        vec![2, 63, 248, 0, 0, 0, 0, 0, 0],
        vec![3, 2, 195, 169],
        vec![4, 2, 0, 255],
    ]
    .concat();
    let mut bytes = Vec::new();
    for value in &values {
        codec::write_value(&mut bytes, value).unwrap();
    }
    assert_eq!(bytes, expected);
    let mut input = bytes.as_slice();
    for value in values {
        assert_eq!(codec::read_value(&mut input).unwrap(), value);
    }
    let mut count = Vec::new();
    codec::write_count(&mut count, 624485).unwrap();
    assert_eq!(count, [0xe5, 0x8e, 0x26]);
    assert_eq!(codec::read_count(&mut &count[..]).unwrap(), 624485);
    for malformed in [
        vec![0x80, 0],
        vec![0xff; 10],
        vec![0x80],
        vec![255, 255, 255, 255, 255, 255, 255, 255, 255, 2],
    ] {
        assert!(codec::read_count(&mut &malformed[..]).is_err());
    }
    assert!(codec::read_value(&mut &[3, 1, 255][..]).is_err());
}
#[test]
fn v1_large_value_spans_records_and_manifest_selects_only_its_absolute_offsets() {
    let id = [7; 16];
    let payload = vec![42; MAX_RECORD_LENGTH * 2 + 137];
    let framing = 37;
    let mut offset = 98765;
    let mut records = std::collections::BTreeMap::new();
    let mut listed = Vec::new();
    let (total_length, total_digest) = chunks(&mut payload.as_slice(), id, framing, |record| {
        assert!(record.len() + framing <= MAX_RECORD_LENGTH);
        let body = record_payload(&record, 1, id).unwrap();
        listed.push(Chunk {
            offset,
            length: body.len() as u64,
            digest: digest(body),
        });
        let next = record.len() as u64 + framing as u64;
        records.insert(offset, record);
        offset += next;
        Ok(())
    })
    .unwrap();
    records.insert(
        0,
        codec::record(1, [9; 16], b"earlier snapshot", framing).unwrap(),
    );
    let manifest = Manifest {
        snapshot_id: id,
        cut_id: "cut".into(),
        session_ref: "ref".into(),
        host_session_id: "ses_move".into(),
        host_end_offset: 42,
        host_end_message_id: Some("msg_1".into()),
        source_mode: SourceMode::Rust,
        inventory_version: move_inventory::INVENTORY_VERSION,
        store_schema_version: move_inventory::STORE_SCHEMA_VERSION,
        context_schema_version: move_inventory::CONTEXT_SCHEMA_VERSION,
        render_versions: serde_json::json!({"memory":1}),
        render_state_digest: digest(b"memory"),
        render_identity: serde_json::json!({"provider":"p"}),
        fence_cut_id: "cut".into(),
        chunk_count: listed.len() as u64,
        chunks: listed,
        total_length,
        total_digest,
    };
    let bytes = manifest.encode_record(framing).unwrap();
    assert_eq!(&bytes[..4], b"MCS1");
    assert_eq!(bytes[4], 2);
    assert_eq!(&bytes[5..HEADER_LENGTH], &id);
    assert_eq!(Manifest::decode_record(&bytes).unwrap(), manifest);
    let mut restored = Vec::new();
    manifest
        .verify_chunks(|at| Ok(records[&at].clone()), &mut restored)
        .unwrap();
    assert_eq!(restored, payload);
    for change in 0..5 {
        let mut bad = manifest.clone();
        match change {
            0 => bad.chunks.pop().map(|_| ()).unwrap(),
            1 => bad.chunks[0].digest = digest(b"wrong"),
            2 => bad.total_length += 1,
            4 => bad.chunk_count += 1,
            _ => bad.total_digest = digest(b"wrong"),
        };
        assert!(bad
            .verify_chunks(|at| Ok(records[&at].clone()), &mut Vec::new())
            .is_err());
    }
}
#[test]
fn frozen_fence_triggers_cover_insert_update_delete_for_every_session_table() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(dir.path());
    store
        .inner
        .with_conn(|conn| {
            // This probe isolates the row-write fence from each table's semantic
            // CHECKs; every action below must fail specifically with session_moving.
            conn.pragma_update(None, "ignore_check_constraints", true)?;
            for table in move_inventory::tables(Store::Module).filter(|t| {
                t.class != Class::NotSession && matches!(t.rows, RowSelector::Predicate(_))
            }) {
                let mut columns = conn.prepare(&format!(
                    "PRAGMA table_info({})",
                    codec::quoted(table.table)
                ))?;
                let fields = columns
                    .query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                let values = fields
                    .iter()
                    .map(|(name, ty)| {
                        if name == "session_id" || name == "identity_scope" {
                            Value::Text("ses_move".into())
                        } else if ty.contains("INT") {
                            Value::Integer(1)
                        } else if ty.contains("BLOB") {
                            Value::Blob(vec![1])
                        } else if name == "meta" {
                            Value::Text("{\"historian\":{\"state\":\"idle\"}}".into())
                        } else {
                            Value::Text("{}".into())
                        }
                    })
                    .collect::<Vec<_>>();
                conn.execute(
                    &format!(
                        "INSERT OR REPLACE INTO {} ({}) VALUES ({})",
                        codec::quoted(table.table),
                        fields
                            .iter()
                            .map(|(n, _)| codec::quoted(n))
                            .collect::<Vec<_>>()
                            .join(","),
                        (1..=fields.len())
                            .map(|i| format!("?{i}"))
                            .collect::<Vec<_>>()
                            .join(",")
                    ),
                    rusqlite::params_from_iter(values.iter()),
                )?;
            }
            conn.pragma_update(None, "ignore_check_constraints", false)?;
            conn.execute(
                "INSERT INTO mc_move_fences VALUES('ses_move','cut','frozen')",
                [],
            )?;
            for table in move_inventory::tables(Store::Module).filter(|t| {
                t.class != Class::NotSession && matches!(t.rows, RowSelector::Predicate(_))
            }) {
                let owner = if table.table == "mc_facade_mutation_ledger" {
                    "identity_scope"
                } else {
                    "session_id"
                };
                let quoted = codec::quoted(table.table);
                for sql in [
                    format!(
                        "INSERT INTO {quoted} SELECT * FROM {quoted} WHERE {owner} = 'ses_move'"
                    ),
                    format!("UPDATE {quoted} SET {owner} = {owner} WHERE {owner} = 'ses_move'"),
                    format!("DELETE FROM {quoted} WHERE {owner} = 'ses_move'"),
                ] {
                    let error = conn
                        .execute(&sql, [])
                        .expect_err(&format!("unguarded {sql}"));
                    assert!(
                        error.to_string().contains("session_moving"),
                        "{sql}: {error}"
                    );
                }
            }
            Ok(())
        })
        .unwrap();
    assert!(matches!(
        store.check_session_not_moving("ses_move"),
        Err(McStoreError::SessionMoving)
    ));
    assert!(store.check_session_not_moving("ses_other").is_ok());
    // A fresh process-equivalent handle installs its own transaction guards and
    // startup pruning must not delete the gated fixture's stale lineage rows.
    drop(store);
    let reopened = open(dir.path());
    assert!(matches!(
        reopened.commit_meta("ses_move", Some(1), &ModuleMeta::default()),
        Err(McStoreError::SessionMoving)
    ));
}
#[test]
fn draining_allows_only_historian_terminalization_and_pending_deletion() {
    let dir = tempfile::tempdir().unwrap();
    let store = seeded(dir.path(), 1, 10);
    let mut mover = store.move_store().unwrap();
    mover.acquire_fence(&binding("cut")).unwrap();
    store.inner.with_conn(|conn| {
        conn.execute("UPDATE mc_cache_state SET meta = json_set(meta,'$.historian.state','idle'), row_version = row_version + 1 WHERE session_id = 'ses_move'",[])?;
        for sql in ["UPDATE mc_cache_state SET meta = json_set(meta,'$.todo_state','changed') WHERE session_id = 'ses_move'", "UPDATE mc_cache_state SET meta = json_set(meta,'$.historian.state','firing') WHERE session_id = 'ses_move'", "UPDATE mc_tags SET token_count = 9 WHERE session_id = 'ses_move'", "UPDATE mc_cache_state SET meta = '{}' WHERE session_id = 'ses_move'"] {
            assert!(conn.execute(sql,[]).unwrap_err().to_string().contains("session_moving"));
        }
        Ok(())
    }).unwrap();
    assert!(matches!(
        store.commit(
            "ses_move",
            Some(2),
            &CoreState::default(),
            &ModuleMeta::default()
        ),
        Err(McStoreError::SessionMoving)
    ));
    mover.freeze("cut").unwrap();
    assert!(matches!(
        store.commit_meta("ses_move", Some(2), &ModuleMeta::default()),
        Err(McStoreError::SessionMoving)
    ));
}
#[test]
fn drain_cancels_real_claimed_historian_and_never_publishes_or_reattaches_it() {
    for complete in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let store = open(dir.path());
        let mut meta = ModuleMeta::default();
        meta.historian.state = crate::HistorianPhase::Firing;
        meta.historian.firing_seq = 1;
        meta.historian.chunk_fingerprint = "fp".into();
        store
            .commit("ses_move", None, &CoreState::default(), &meta)
            .unwrap();
        store
            .publish_pending_historian_run(&crate::NewHistorianPendingRun {
                run_id: "run".into(),
                session_id: "ses_move".into(),
                project_path: "git:project".into(),
                firing_seq: 1,
                chunk_fingerprint: "fp".into(),
                system_prompt: "system".into(),
                user_prompt: "user".into(),
                model_chain: vec!["model".into()],
                await_budget_ms: 60000,
                historian_timeout_ms: None,
                now_ms: 1000,
            })
            .unwrap();
        let crate::HistorianClaimOutcome::Claimed(claim) = store
            .claim_historian_run("git:project", "run", "worker", 1001)
            .unwrap()
        else {
            panic!("claim refused");
        };
        let before = store.load("ses_move").unwrap();
        let mut mover = store.move_store().unwrap();
        mover.acquire_fence(&binding("cut")).unwrap();
        assert_eq!(mover.freeze("cut").unwrap_err().code(), "session_busy");
        assert!(store
            .list_pending_historian_runs("git:project", None, 1002)
            .unwrap()
            .is_empty());
        if complete {
            assert!(matches!(
                store
                    .record_historian_report(
                        "git:project",
                        "run",
                        &claim.token,
                        &crate::HistorianRunReport::Output {
                            text: "must not publish".into(),
                            length_capped: false
                        },
                        1002
                    )
                    .unwrap(),
                crate::HistorianRecordOutcome::Refused(crate::HistorianReportRefusal::RunExpired)
            ));
        } else {
            assert!(matches!(
                store
                    .heartbeat_historian_run("git:project", "run", &claim.token, 1002)
                    .unwrap(),
                crate::HistorianHeartbeatOutcome::Refused(
                    crate::HistorianReportRefusal::RunExpired
                )
            ));
        }
        let after = store.load("ses_move").unwrap();
        assert_eq!(after.core, before.core);
        assert_eq!(after.meta.historian.state, crate::HistorianPhase::Idle);
        assert!(after.meta.historian.producer_run_id.is_none());
        assert_eq!(after.meta.historian.firing_seq, 1);
        mover.freeze("cut").unwrap();
        mover.release_source("cut", false).unwrap();
        assert!(store
            .list_pending_historian_runs("git:project", None, 1003)
            .unwrap()
            .is_empty());
    }
}

#[test]
fn failed_install_batch_rolls_back_rows_key_map_and_source_cursor_together() {
    let source = tempfile::tempdir().unwrap();
    let destination = tempfile::tempdir().unwrap();
    let src = seeded(source.path(), 20, 10);
    let dst = open(destination.path());
    let staging = destination.path().join("staging");
    capture(&src, "cut", &staging);
    let mut mover = dst.move_store().unwrap();
    mover
        .reserve_install(&binding("cut"), "digest", &staging)
        .unwrap();
    let before = read_cursor(&mover.writer, "cut").unwrap();
    mover.writer.execute_batch("CREATE TEMP TRIGGER fail_mid_batch BEFORE INSERT ON mc_tags WHEN NEW.tag_number = 3 BEGIN SELECT RAISE(ABORT,'injected write failure'); END").unwrap();
    assert!(mover.install_batch("cut").is_err());
    assert_eq!(read_cursor(&mover.writer, "cut").unwrap(), before);
    let maps: usize = mover
        .writer
        .query_row(
            "SELECT COUNT(*) FROM mc_move_key_map WHERE cut_id = 'cut'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(maps, 0);
    assert!(dst.load_tags_for_session("ses_move").unwrap().is_empty());
    drop(mover);
    let mut resumed = dst.move_store().unwrap();
    install(&mut resumed, "cut");
    assert_eq!(dump(&src, "mc_tags", "*"), dump(&dst, "mc_tags", "*"));
}

#[test]
fn completing_import_and_discard_invalidates_live_tag_and_boundary_cache_namespace() {
    let source = tempfile::tempdir().unwrap();
    let destination = tempfile::tempdir().unwrap();
    let src = seeded(source.path(), 4, 10);
    let dst = open(destination.path());
    let before = dst.tag_cache_namespace();
    let staging = destination.path().join("staging");
    capture(&src, "cut", &staging);
    let mut mover = dst.move_store().unwrap();
    mover
        .reserve_install(&binding("cut"), "digest", &staging)
        .unwrap();
    install(&mut mover, "cut");
    mover.finish_install("cut", "result").unwrap();
    let imported = dst.tag_cache_namespace();
    assert_ne!(imported, before);
    discard(&mut mover, "cut");
    assert_ne!(dst.tag_cache_namespace(), imported);
}
#[test]
fn source_cut_conflicts_and_release_tombstones_are_durable() {
    let dir = tempfile::tempdir().unwrap();
    let store = seeded(dir.path(), 2, 10);
    let file = dir.path().join("capture");
    let mut mover = capture(&store, "cut", &file);
    let mut changed = binding("cut");
    changed.host_end_offset += 1;
    assert_eq!(
        mover.acquire_fence(&changed).unwrap_err().code(),
        "cut_conflict"
    );
    assert_eq!(
        mover.acquire_fence(&binding("other")).unwrap_err().code(),
        "move_in_progress"
    );
    mover
        .record_capture("cut", "digest", &file, "receipt")
        .unwrap();
    let saved = mover.source_cut_record(&binding("cut")).unwrap().unwrap();
    assert_eq!(saved.manifest_digest, "digest");
    assert_eq!(saved.receipt.as_deref(), Some("receipt"));
    assert_eq!(
        mover
            .record_capture("cut", "digest", &file, "different receipt")
            .unwrap_err()
            .code(),
        "cut_conflict"
    );
    mover.release_source("cut", true).unwrap();
    assert!(!file.exists());
    mover.acquire_fence(&binding("cut")).unwrap();
    assert_eq!(
        mover
            .source_cut_record(&binding("cut"))
            .unwrap()
            .unwrap()
            .state,
        "sealed"
    );
    assert_eq!(
        mover.release_source("cut", true).unwrap().as_deref(),
        Some("receipt")
    );
    assert_eq!(
        store.session_move_phase("ses_move").unwrap().as_deref(),
        Some("frozen")
    );
    assert_eq!(
        mover.release_source("wrong", false).unwrap_err().code(),
        "cut_conflict"
    );
    let dir2 = tempfile::tempdir().unwrap();
    let store2 = seeded(dir2.path(), 1, 10);
    let file2 = dir2.path().join("capture");
    let mut abort = capture(&store2, "abort", &file2);
    abort
        .record_capture("abort", "digest", &file2, "receipt")
        .unwrap();
    abort.release_source("abort", false).unwrap();
    abort.release_source("abort", false).unwrap();
    assert!(!file2.exists());
    assert_eq!(
        abort.acquire_fence(&binding("abort")).unwrap_err().code(),
        "cut_released"
    );
    assert!(store2.check_session_not_moving("ses_move").is_ok());
}
#[test]
fn batched_install_resumes_source_cursor_and_durable_identity_key_map() {
    let source = tempfile::tempdir().unwrap();
    let destination = tempfile::tempdir().unwrap();
    let src = seeded(source.path(), 77, 1024);
    let staging = destination.path().join("staging");
    let _export = capture(&src, "cut", &staging);
    let dst = open(destination.path());
    let mut mover = dst.move_store().unwrap();
    mover
        .reserve_install(&binding("cut"), "digest", &staging)
        .unwrap();
    assert!(matches!(
        dst.commit(
            "ses_move",
            None,
            &CoreState::default(),
            &ModuleMeta::default()
        ),
        Err(McStoreError::SessionMoving)
    ));
    let first = mover.install_batch("cut").unwrap();
    assert_eq!(first.rows_written, 16);
    assert!(first.last_source_key.is_some());
    assert!(!first.complete);
    let maps: usize = mover.writer.query_row("SELECT COUNT(*) FROM mc_move_key_map WHERE cut_id = 'cut' AND source_key = destination_key",[],|r|r.get(0)).unwrap();
    assert_eq!(maps, 16);
    drop(mover);
    let mut resumed = dst.move_store().unwrap();
    resumed
        .reserve_install(&binding("cut"), "digest", &staging)
        .unwrap();
    install(&mut resumed, "cut");
    assert_eq!(dump(&src, "mc_tags", "*"), dump(&dst, "mc_tags", "*"));
    assert_eq!(
        dump(&src, "mc_cache_state", "*"),
        dump(&dst, "mc_cache_state", "*")
    );
    resumed
        .finish_install("cut", "{\"renderDifferences\":[\"docs\"]}")
        .unwrap();
    assert!(!staging.exists());
    assert_eq!(
        resumed
            .installed_result(&binding("cut"), None)
            .unwrap()
            .as_deref(),
        Some("{\"renderDifferences\":[\"docs\"]}")
    );
    assert_eq!(
        resumed
            .installed_result(&binding("cut"), Some("changed"))
            .unwrap_err()
            .code(),
        "cut_conflict"
    );
    resumed.activate_for_test("cut").unwrap();
    assert!(dst.check_session_not_moving("ses_move").is_ok());
    assert_eq!(
        resumed.begin_discard("cut").unwrap_err().code(),
        "cut_conflict"
    );
}
#[test]
fn tag_generation_exceeds_shipped_and_previously_observed_generation() {
    let source = tempfile::tempdir().unwrap();
    let destination = tempfile::tempdir().unwrap();
    let src = seeded(source.path(), 4, 10);
    let dst = open(destination.path());
    src.inner
        .with_conn(|conn| {
            conn.execute(
                "UPDATE mc_tag_cache_generations SET generation = 500 WHERE session_id = 'ses_move'",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    let staging = destination.path().join("staging");
    capture(&src, "cut", &staging);
    let mut mover = dst.move_store().unwrap();
    mover
        .reserve_install(&binding("cut"), "digest", &staging)
        .unwrap();
    install(&mut mover, "cut");
    mover.finish_install("cut", "result").unwrap();
    let old = dst.tag_cache_summary("ses_move").unwrap();
    assert_eq!(old.generation, 501);
    discard(&mut mover, "cut");
    // The live store has observed 501 even though discard removed the shipped
    // rows. Only the local high-water mark may survive destination preflight.
    let staging = destination.path().join("staging2");
    src.move_store().unwrap().capture("cut", &staging).unwrap();
    mover
        .reserve_install(&binding("new"), "digest2", &staging)
        .unwrap();
    install(&mut mover, "new");
    let new = dst.tag_cache_summary("ses_move").unwrap();
    assert_eq!(new.generation, 502);
    assert_eq!(new.count, 4);
    assert_eq!(new.max_tag_number, 4);
}
#[test]
fn discard_resumes_after_every_batch_and_old_cut_cannot_touch_new_install() {
    let source = tempfile::tempdir().unwrap();
    let destination = tempfile::tempdir().unwrap();
    let src = seeded(source.path(), 50, 10);
    let dst = open(destination.path());
    let staging = destination.path().join("staging");
    capture(&src, "cut", &staging);
    let mut mover = dst.move_store().unwrap();
    mover
        .reserve_install(&binding("cut"), "digest", &staging)
        .unwrap();
    install(&mut mover, "cut");
    mover.begin_discard("cut").unwrap();
    loop {
        let done = mover.discard_batch("cut").unwrap();
        drop(mover);
        mover = dst.move_store().unwrap();
        assert!(dst.check_session_not_moving("ses_move").is_err());
        if done {
            break;
        }
    }
    while !mover.discard_key_map_batch("cut").unwrap() {
        drop(mover);
        mover = dst.move_store().unwrap();
    }
    mover.finish_discard("cut").unwrap();
    assert!(!staging.exists());
    assert!(dst.check_session_not_moving("ses_move").is_ok());
    assert!(mover.discard_batch("cut").unwrap());
    mover.finish_discard("cut").unwrap();
    let staging2 = destination.path().join("staging2");
    // The source remains frozen under the original cut; copying its existing
    // capture is a test-only new transport snapshot, not a source re-prepare.
    let export = src.move_store().unwrap();
    export.capture("cut", &staging2).unwrap();
    mover
        .reserve_install(&binding("new"), "newdigest", &staging2)
        .unwrap();
    install(&mut mover, "new");
    let before = dump(&dst, "mc_tags", "*");
    discard(&mut mover, "cut");
    assert_eq!(before, dump(&dst, "mc_tags", "*"));
    assert_eq!(
        dst.session_move_phase("ses_move").unwrap().as_deref(),
        Some("staged")
    );
    discard(&mut mover, "new");
}
#[test]
fn preflight_refusals_do_not_reserve_or_write_live_rows() {
    let source = tempfile::tempdir().unwrap();
    let destination = tempfile::tempdir().unwrap();
    let src = seeded(source.path(), 1, 10);
    let dst = open(destination.path());
    let staging = destination.path().join("staging");
    capture(&src, "cut", &staging);
    dst.append_pending_agent_drops("other", &["other#0".into()], 1)
        .unwrap();
    src.inner.with_conn(|conn| { // A preserved store-wide id collides with another session.
        conn.execute("DELETE FROM mc_move_fences WHERE cut_id = 'cut'",[])?;
        conn.execute("INSERT INTO pending_agent_drops(id,session_id,target_id,queued_at) VALUES(1,'ses_move','msg_1#0',1)",[])?;
        conn.execute("INSERT INTO mc_move_fences VALUES('ses_move','cut','frozen')",[])?; Ok(())
    }).unwrap();
    std::fs::remove_file(&staging).unwrap();
    src.move_store().unwrap().capture("cut", &staging).unwrap();
    let mut mover = dst.move_store().unwrap();
    assert_eq!(
        mover
            .reserve_install(&binding("cut"), "digest", &staging)
            .unwrap_err()
            .code(),
        "key_collision"
    );
    assert!(dst.session_move_phase("ses_move").unwrap().is_none());
    assert!(!dst.has_cache_state("ses_move").unwrap());
    assert_eq!(dst.load_pending_agent_drops("other").unwrap().len(), 1);
    dst.inner.with_conn(|conn| {conn.execute("DELETE FROM pending_agent_drops WHERE session_id = 'other'",[])?;conn.execute("INSERT INTO mc_facade_mutation_ledger(identity_scope,tool,action,command_id,response_json,created_at_ms) VALUES('ses_move','p','write','c',X'01',1)",[])?;Ok(())}).unwrap();
    let error = mover
        .reserve_install(&binding("cut"), "digest", &staging)
        .unwrap_err();
    assert_eq!(error.code(), "destination_populated");
    dst.inner
        .with_conn(|conn| {
            conn.execute(
                "DELETE FROM mc_facade_mutation_ledger WHERE identity_scope = 'ses_move'",
                [],
            )?;
            conn.execute(
                "INSERT INTO mc_tag_cache_generations VALUES('ses_move',500,0,0)",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    let error = mover
        .reserve_install(&binding("cut"), "digest", &staging)
        .unwrap_err();
    assert!(
        matches!(error,MoveError::Refused {code:"destination_populated",table:Some(ref table)} if table == "mc_tag_cache_generations")
    );
}
#[test]
fn capture_inventory_drift_refuses_before_writing_and_files_are_private() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let store = seeded(dir.path(), 1, 10);
    let file = dir.path().join("capture");
    let mut mover = capture(&store, "cut", &file);
    assert_eq!(
        std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        std::fs::metadata(dir.path()).unwrap().permissions().mode() & 0o777,
        0o700
    );
    store
        .inner
        .with_conn(|conn| {
            conn.execute("ALTER TABLE mc_tags ADD COLUMN surprise_secret TEXT", [])?;
            Ok(())
        })
        .unwrap();
    let fail = dir.path().join("fail");
    assert_eq!(
        mover.capture("cut", &fail).unwrap_err().code(),
        "inventory_unclassified"
    );
    assert!(!fail.exists());
    mover
        .record_capture("cut", "digest", &file, "receipt")
        .unwrap();
    mover.release_source("cut", false).unwrap();
}
#[test]
fn startup_pending_replay_skips_draining_frozen_and_staged_sessions() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(dir.path());
    store.inner.with_conn(|conn|{
        for (n,phase) in ["draining","frozen","staged"].iter().enumerate() {
            conn.execute("INSERT INTO mc_single_store_pending_publish(session_id,publish_json,created_at) VALUES(?1,'invalid intent',1)",[format!("session_{n}")])?;
            conn.execute("INSERT INTO mc_move_fences VALUES(?1,?2,?3)",params![format!("session_{n}"),format!("cut_{n}"),phase])?;
        }
        Ok(())
    }).unwrap();
    assert_eq!(store.resume_all_pending_context_writes().unwrap(), 0);
}
#[test]
fn a6_store_155_mib_capture_install_discard_release_other_session_writer_and_bound_locks() {
    run_a6_fixture();
}
#[test]
#[ignore = "wall-clock A6 gate requires a quiet machine and --test-threads=1; see move_store module docs"]
fn a6_store_155_mib_wall_clock_lock_bound() {
    for metrics in run_a6_fixture() {
        assert!(
            metrics.longest_hold <= Duration::from_millis(100),
            "move lock exceeded A6: {metrics:?}"
        );
    }
}
fn run_a6_fixture() -> [LockMetrics; 2] {
    let source = tempfile::tempdir().unwrap();
    let destination = tempfile::tempdir().unwrap();
    // 620 * 256 KiB is the independently sized 155 MiB store-half fixture.
    let src = Arc::new(seeded(source.path(), 620, 256 * 1024));
    let dst = Arc::new(open(destination.path()));
    for store in [&src, &dst] {
        // Waiting to acquire a lock is not a move lock hold. Allow scheduling
        // delays in the parallel suite without changing production wait bounds.
        store
            .inner
            .with_conn(|conn| conn.busy_timeout(Duration::from_secs(30)))
            .unwrap();
    }
    let staging = destination.path().join("staging");
    let running = Arc::new(AtomicBool::new(true));
    let source_commits = Arc::new(AtomicUsize::new(0));
    let destination_commits = Arc::new(AtomicUsize::new(0));
    let workers = FixtureWriters {
        running: running.clone(),
        workers: [src.clone(), dst.clone()]
            .into_iter()
            .zip([source_commits.clone(), destination_commits.clone()])
            .map(|(store, committed)| {
                let running = running.clone();
                std::thread::spawn(move || {
                    let mut version = None;
                    while running.load(Ordering::Relaxed) {
                        version = Some(
                            store
                                .commit(
                                    "unrelated",
                                    version,
                                    &CoreState::default(),
                                    &ModuleMeta {
                                        last_system_prompt_hash: format!(
                                            "sentinel {}",
                                            version.unwrap_or(0)
                                        ),
                                        ..Default::default()
                                    },
                                )
                                .unwrap(),
                        );
                        committed.fetch_add(1, Ordering::Relaxed);
                        // Continuous ordinary turns, not a synthetic maximum-rate
                        // fsync/checkpoint storm competing with the size fixture.
                        std::thread::park_timeout(Duration::from_millis(2));
                    }
                })
            })
            .collect::<Vec<_>>(),
    };
    let before_capture = source_commits.load(Ordering::Relaxed);
    let mut exporting = src.move_store().unwrap();
    exporting
        .writer
        .busy_timeout(Duration::from_secs(30))
        .unwrap();
    let source_probe = TransactionProbe::attach(&mut exporting);
    exporting.acquire_fence(&binding("cut")).unwrap();
    exporting.freeze("cut").unwrap();
    exporting.capture("cut", &staging).unwrap();
    assert!(source_commits.load(Ordering::Relaxed) > before_capture);
    let shipped = std::fs::metadata(&staging).unwrap().len();
    assert!(shipped >= 155 * 1024 * 1024);
    let mut importing = dst.move_store().unwrap();
    importing
        .writer
        .busy_timeout(Duration::from_secs(30))
        .unwrap();
    let destination_probe = TransactionProbe::attach(&mut importing);
    importing
        .reserve_install(&binding("cut"), "digest", &staging)
        .unwrap();
    let before_install = destination_commits.load(Ordering::Relaxed);
    install(&mut importing, "cut");
    for events in destination_probe.transactions() {
        assert_install_transaction_bounds(&events);
    }
    assert!(destination_commits.load(Ordering::Relaxed) > before_install);
    assert_eq!(dst.tag_cache_summary("ses_move").unwrap().count, 620);
    let before_discard = destination_commits.load(Ordering::Relaxed);
    let before_discard_transactions = destination_probe.transactions().len();
    discard(&mut importing, "cut");
    assert!(destination_commits.load(Ordering::Relaxed) > before_discard);
    exporting
        .record_capture("cut", "digest", &source.path().join("missing"), "receipt")
        .unwrap();
    exporting.release_source("cut", false).unwrap();
    drop(workers);
    let transactions = destination_probe.transactions();
    for events in &transactions[before_discard_transactions..] {
        assert_discard_transaction_bounds(events);
    }
    for events in source_probe.transactions() {
        assert_install_transaction_bounds(&events);
    }
    assert_eq!(
        transactions.len() as u64,
        importing.lock_metrics().transactions
    );
    assert_eq!(
        source_probe.transactions().len() as u64,
        exporting.lock_metrics().transactions
    );
    let metrics = [exporting.lock_metrics(), importing.lock_metrics()];
    for metrics in metrics {
        assert!(metrics.transactions > 0);
        println!("A6 store fixture shipped={shipped} bytes; {metrics:?}");
    }
    metrics
}

// Observe the SQL mutations on the actual move connection, not the decoded row
// buffer. A transaction accidentally containing two batches must leave two cursor
// advances (or too many writes) in the same observation.
#[derive(Clone, Debug)]
struct RowMutation {
    table: String,
    operation: String,
    bytes: usize,
}
struct FixtureWriters {
    running: Arc<AtomicBool>,
    workers: Vec<std::thread::JoinHandle<()>>,
}
impl Drop for FixtureWriters {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Relaxed);
        for worker in self.workers.drain(..) {
            let result = worker.join();
            if !std::thread::panicking() {
                assert!(result.is_ok(), "concurrent fixture writer failed");
            }
        }
    }
}
#[derive(Default)]
struct ProbeState {
    active: bool,
    pending: Vec<RowMutation>,
    transactions: Vec<Vec<RowMutation>>,
}
#[derive(Clone, Default)]
pub(super) struct TransactionProbe(Arc<Mutex<ProbeState>>);
impl TransactionProbe {
    pub(super) fn begin(&self) {
        let mut state = self.0.lock().unwrap();
        assert!(!state.active, "nested move transaction");
        state.active = true;
        assert!(state.pending.is_empty());
    }
    pub(super) fn finish(&self) {
        let mut state = self.0.lock().unwrap();
        state.active = false;
        let events = std::mem::take(&mut state.pending);
        state.transactions.push(events);
    }
    fn attach(mover: &mut MoveStore) -> Self {
        let probe = Self::default();
        let captured = probe.clone();
        mover
            .writer
            .create_scalar_function(
                "move_transaction_probe",
                3,
                rusqlite::functions::FunctionFlags::SQLITE_UTF8,
                move |ctx| {
                    let event = RowMutation {
                        table: ctx.get(0)?,
                        operation: ctx.get(1)?,
                        bytes: ctx.get(2)?,
                    };
                    let mut state = captured.0.lock().unwrap();
                    assert!(
                        state.active,
                        "move mutation outside an observed transaction"
                    );
                    state.pending.push(event);
                    Ok(0)
                },
            )
            .unwrap();
        for table in move_inventory::tables(Store::Module)
            .filter(|t| !move_inventory::is_sqlite_internal(t.table))
        {
            for operation in ["INSERT", "UPDATE", "DELETE"] {
                let side = if operation == "DELETE" { "OLD" } else { "NEW" };
                // SQLite measures the stored values independently of the stream
                // decoder: integer/real are 8 bytes, text/blob use byte length.
                let bytes = table.columns.iter().map(|column| {
                    let value = format!("{side}.{}", codec::quoted(column));
                    format!("CASE typeof({value}) WHEN 'null' THEN 0 WHEN 'integer' THEN 8 WHEN 'real' THEN 8 ELSE length(CAST({value} AS BLOB)) END")
                }).collect::<Vec<_>>().join(" + ");
                let label = if operation == "UPDATE" && table.table == "mc_move_installs" {
                    "CASE WHEN NEW.table_index IS NOT OLD.table_index OR NEW.file_offset IS NOT OLD.file_offset OR NEW.rows_remaining IS NOT OLD.rows_remaining OR NEW.last_source_key IS NOT OLD.last_source_key OR NEW.complete IS NOT OLD.complete THEN 'install_cursor' ELSE 'UPDATE' END".into()
                } else if operation == "UPDATE" && table.table == "mc_move_cuts" {
                    "CASE WHEN NEW.discard_table IS NOT OLD.discard_table THEN 'discard_cursor' ELSE 'UPDATE' END".into()
                } else {
                    format!("'{operation}'")
                };
                mover.writer.execute_batch(&format!(
                    "CREATE TEMP TRIGGER {} AFTER {operation} ON main.{} BEGIN SELECT move_transaction_probe('{}', {label}, {bytes}); END;",
                    codec::quoted(&format!("probe_{}_{operation}",table.table)), codec::quoted(table.table), table.table
                )).unwrap();
            }
        }
        mover.transaction_probe = Some(probe.clone());
        probe
    }
    fn transactions(&self) -> Vec<Vec<RowMutation>> {
        self.0.lock().unwrap().transactions.clone()
    }
}
fn count_mutations(events: &[RowMutation], table: &str, operation: &str) -> usize {
    events
        .iter()
        .filter(|event| event.table == table && event.operation == operation)
        .count()
}
fn primary_mutations(events: &[RowMutation]) -> Vec<&RowMutation> {
    events
        .iter()
        .filter(|event| {
            event.table != "mc_tag_cache_generations"
                && move_inventory::entry(Store::Module, &event.table)
                    .unwrap()
                    .class
                    != Class::NotSession
        })
        .collect()
}
fn assert_install_transaction_bounds(events: &[RowMutation]) {
    let source_rows = count_mutations(events, "mc_move_key_map", "INSERT");
    let primary = primary_mutations(events);
    assert!(
        source_rows <= 16,
        "install transaction exceeded 16 source rows: {events:?}"
    );
    assert!(
        primary.len() <= source_rows,
        "session rows escaped the batch key map: {events:?}"
    );
    let bytes: usize = events.iter().map(|event| event.bytes).sum();
    // Key-map copies, cursor/generation rows and fixed cut metadata contribute
    // less than 4 KiB for these fixtures. Larger indivisible values stand alone.
    let oversized = primary.iter().map(|event| event.bytes).max().unwrap_or(0);
    assert!(
        bytes <= 256 * 1024 + 4096
            || (source_rows == 1
                && primary.len() == 1
                && oversized > 256 * 1024
                && bytes <= oversized + 4096),
        "install transaction exceeded the byte budget: {bytes} bytes, {events:?}"
    );
    assert!(
        events
            .iter()
            .filter(|event| event.operation == "install_cursor")
            .count()
            <= 1,
        "one transaction spanned multiple install batches: {events:?}"
    );
}
fn assert_discard_transaction_bounds(events: &[RowMutation]) {
    let primary = primary_mutations(events);
    let deletes = events
        .iter()
        .filter(|event| {
            event.operation == "DELETE"
                && move_inventory::entry(Store::Module, &event.table)
                    .unwrap()
                    .class
                    != Class::NotSession
        })
        .count();
    assert!(
        deletes <= 1,
        "discard transaction deleted more than one session row: {events:?}"
    );
    assert!(primary.iter().all(|event| event.operation == "DELETE"));
    assert!(count_mutations(events, "mc_move_key_map", "DELETE") <= 64);
    let bytes: usize = events.iter().map(|event| event.bytes).sum();
    assert!(
        bytes <= 256 * 1024 + 4096,
        "discard transaction exceeded the fixture byte budget: {bytes}"
    );
    assert!(
        events
            .iter()
            .filter(|event| event.operation == "discard_cursor")
            .count()
            <= 1,
        "one transaction spanned multiple discard batches: {events:?}"
    );
}

#[test]
fn install_byte_budget_does_not_pack_two_rows_past_the_limit() {
    for size in [1024, 150 * 1024, 512 * 1024] {
        let source = tempfile::tempdir().unwrap();
        let destination = tempfile::tempdir().unwrap();
        let src = seeded(source.path(), 20, size);
        let dst = open(destination.path());
        let staging = destination.path().join("staging");
        capture(&src, "cut", &staging);
        let mut mover = dst.move_store().unwrap();
        mover
            .reserve_install(&binding("cut"), "digest", &staging)
            .unwrap();
        let probe = TransactionProbe::attach(&mut mover);
        install(&mut mover, "cut");
        for events in probe.transactions() {
            assert_install_transaction_bounds(&events);
        }
        assert_eq!(dump(&src, "mc_tags", "*"), dump(&dst, "mc_tags", "*"));
    }
}

#[test]
fn transaction_probe_rejects_two_cursor_advances_in_one_transaction() {
    let source = tempfile::tempdir().unwrap();
    let destination = tempfile::tempdir().unwrap();
    let src = seeded(source.path(), 1, 10);
    let dst = open(destination.path());
    let staging = destination.path().join("staging");
    capture(&src, "cut", &staging);
    let mut mover = dst.move_store().unwrap();
    mover
        .reserve_install(&binding("cut"), "digest", &staging)
        .unwrap();
    let probe = TransactionProbe::attach(&mut mover);
    mover
        .write("cut", |tx| {
            tx.execute(
                "UPDATE mc_move_installs SET file_offset = 1 WHERE cut_id = 'cut'",
                [],
            )?;
            tx.execute(
                "UPDATE mc_move_installs SET file_offset = 2 WHERE cut_id = 'cut'",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    let transactions = probe.transactions();
    assert_eq!(transactions.len(), 1);
    assert_eq!(
        count_mutations(&transactions[0], "mc_move_installs", "install_cursor"),
        2
    );
    let refused = std::panic::catch_unwind(|| assert_install_transaction_bounds(&transactions[0]));
    assert!(
        refused.is_err(),
        "transaction audit accepted two batch advances"
    );
}
