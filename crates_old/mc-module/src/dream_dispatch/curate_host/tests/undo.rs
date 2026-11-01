use super::*;
use rusqlite::types::{Value as SqlValue, ValueRef};

const TABLES: &[&str] = &[
    "memories",
    "memory_embeddings",
    "memory_verifications",
    "memory_history",
    "memory_journal",
    "memory_successor_links",
    "memory_mutation_log",
    "project_state",
];

fn rows(db: &rusqlite::Connection, table: &str) -> rusqlite::Result<Value> {
    let mut statement = db.prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))?;
    let names: Vec<String> = statement
        .column_names()
        .iter()
        .map(|s| (*s).into())
        .collect();
    let values = statement
        .query_map([], |row| {
            let mut value = serde_json::Map::new();
            for (index, name) in names.iter().enumerate() {
                let field = match row.get_ref(index)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(n) => json!(n),
                    ValueRef::Real(n) => json!(n),
                    ValueRef::Text(s) => json!(std::str::from_utf8(s).unwrap()),
                    ValueRef::Blob(bytes) => json!(bytes),
                };
                value.insert(name.clone(), field);
            }
            Ok(Value::Object(value))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(json!(values))
}

fn state(f: &Fixture) -> Value {
    f.store
        .with_context_read(|db| {
            TABLES
                .iter()
                .map(|table| Ok(((*table).into(), rows(db, table)?)))
                .collect::<rusqlite::Result<serde_json::Map<String, Value>>>()
                .map(Value::Object)
        })
        .unwrap()
}

fn load_ts_edit(f: &Fixture, edited: &Value) {
    f.store
        .with_context_conn_for_test(|db| {
            for table in TABLES.iter().rev() {
                db.execute(&format!("DELETE FROM {table}"), [])?;
            }
            for table in TABLES {
                for row in edited[*table].as_array().unwrap() {
                    let object = row.as_object().unwrap();
                    let columns = object.keys().cloned().collect::<Vec<_>>().join(",");
                    let placeholders = vec!["?"; object.len()].join(",");
                    let values = object.values().map(|value| match value {
                        Value::Null => SqlValue::Null,
                        Value::Number(n) if n.is_i64() => SqlValue::Integer(n.as_i64().unwrap()),
                        Value::Number(n) => SqlValue::Real(n.as_f64().unwrap()),
                        Value::String(s) => SqlValue::Text(s.clone()),
                        Value::Array(bytes) => SqlValue::Blob(
                            bytes.iter().map(|n| n.as_u64().unwrap() as u8).collect(),
                        ),
                        _ => panic!("unexpected oracle SQL value"),
                    });
                    db.execute(
                        &format!("INSERT INTO {table}({columns}) VALUES({placeholders})"),
                        rusqlite::params_from_iter(values),
                    )?;
                }
            }
            Ok(())
        })
        .unwrap();
}

fn restore(f: &Fixture, key: &str, action: &str) -> Value {
    let preview = f
        .store
        .memory_history_rpc(
            "memory.restore.preview",
            &json!({
                "projectPath":"project", "decisionKey":key,
            }),
            2000,
        )
        .unwrap();
    assert_eq!(
        preview["state"], "ready",
        "{action} undo preview: {preview}"
    );
    let receipt = f
        .store
        .memory_history_rpc(
            "memory.restore",
            &json!({
                "projectPath":"project", "decisionKey":key,
                "operationId":format!("undo-{action}"),
                "expectedRevisions":preview["expectedRevisions"],
            }),
            2000,
        )
        .unwrap();
    assert_eq!(
        receipt["state"], "applied",
        "{action} undo receipt: {receipt}"
    );
    state(f)
}

fn normalize(value: &Value, key: &str) -> Value {
    // Only invocation identity differs: fixture row IDs and both clocks are fixed.
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), normalize(v, key)))
                .collect(),
        ),
        Value::Array(values) => json!(values.iter().map(|v| normalize(v, key)).collect::<Vec<_>>()),
        Value::String(s) => {
            let escaped = serde_json::to_string(key).unwrap();
            json!(s
                .replace(&escaped[1..escaped.len() - 1], "<curate-edit>")
                .replace(key, "<curate-edit>"))
        }
        _ => value.clone(),
    }
}

fn assert_same(actual: &Value, expected: &Value, at: &str) {
    match (actual, expected) {
        (Value::Object(a), Value::Object(b)) if a.keys().eq(b.keys()) => {
            for key in a.keys() {
                assert_same(&a[key], &b[key], &format!("{at}.{key}"));
            }
        }
        (Value::Array(a), Value::Array(b)) if a.len() == b.len() => {
            for (index, (a, b)) in a.iter().zip(b).enumerate() {
                assert_same(a, b, &format!("{at}[{index}]"));
            }
        }
        _ => assert_eq!(actual, expected, "{at}"),
    }
}

#[tokio::test]
async fn rust_curate_undo_matches_typescript_edit_rows_history_and_embedding_queue() {
    let cases: Value = serde_json::from_str(include_str!(
        "../../../../testdata/memory_actions/curate_undo.json"
    ))
    .unwrap();
    for case in cases.as_array().unwrap() {
        let action = case["args"]["action"].as_str().unwrap();
        let rust = Fixture::new();
        rust.store.with_context_conn_for_test(|db| db.execute_batch("UPDATE memories SET shareable=1,classified_at=1,verification_status='verified',verified_at=1,mural_cue='old cue',mural_cue_hash='old hash',mural_cue_at=1,verify_result='verified',verify_files_json='[\"boundary.ts\"]',verify_commit='old commit'; INSERT INTO memory_verifications(memory_id,file_path,verified_at) SELECT id,'boundary.ts',1 FROM memories;")).unwrap();
        assert_eq!(
            state(&rust),
            case["before"],
            "{action} identical starting rows"
        );
        let (mut host, _) = rust.host(vec![case["args"].clone()], None);
        host.run().await.unwrap();
        let edited = state(&rust);
        let rust_key = edited["memory_journal"][0]["decision_key"]
            .as_str()
            .unwrap();
        let ts = Fixture::new();
        load_ts_edit(&ts, &case["edited"]);
        let ts_key = case["key"].as_str().unwrap();
        let ts_restored = restore(&ts, ts_key, action);
        let restored = restore(&rust, rust_key, action);
        assert_same(
            &normalize(&restored, rust_key),
            &normalize(&ts_restored, ts_key),
            action,
        );

        let old_history = edited["memory_history"].as_array().unwrap();
        let history = restored["memory_history"].as_array().unwrap();
        assert_eq!(
            &history[..old_history.len()],
            old_history,
            "{action} original history bytes are immutable"
        );
        assert!(
            history.len() > old_history.len(),
            "{action} appends restore history"
        );
        assert_eq!(restored["memory_journal"].as_array().unwrap().len(), 2);
        assert_eq!(rust.scalar("SELECT COUNT(*) FROM memory_decision_receipts WHERE decision_key LIKE '%memory-restore%'"), 1);
        assert_eq!(restored["memory_journal"][0], edited["memory_journal"][0]);
        let affected = case["args"]["ids"].as_array().unwrap();
        for id in affected {
            let before = case["before"]["memories"]
                .as_array()
                .unwrap()
                .iter()
                .find(|r| r["id"] == *id)
                .unwrap();
            let after = restored["memories"]
                .as_array()
                .unwrap()
                .iter()
                .find(|r| r["id"] == *id)
                .unwrap();
            for field in [
                "content",
                "category",
                "normalized_hash",
                "importance",
                "scope",
                "status",
                "expires_at",
                "superseded_by_memory_id",
                "merged_from",
                "metadata_json",
            ] {
                assert_eq!(
                    after[field], before[field],
                    "{action} id={id} canonical {field} bytes"
                );
            }
            assert_eq!(after["shareable"], 0);
            assert_eq!(after["classified_at"], Value::Null);
            assert_eq!(after["verification_status"], "unverified");
            assert_eq!(after["verified_at"], Value::Null);
            for field in [
                "mural_cue",
                "mural_cue_hash",
                "mural_cue_at",
                "verify_result",
                "verify_files_json",
                "verify_commit",
            ] {
                assert!(!before[field].is_null(), "{action} precondition {field}");
                assert_eq!(after[field], Value::Null, "{action} clears {field}");
            }
            assert_eq!(
                after["revision"].as_i64(),
                Some(before["revision"].as_i64().unwrap() + 2)
            );
        }
        // The durable embedding queue is the live missing-vector set, not a job table.
        // Restored sources must be pending; a merge's archived survivor must not be.
        rust.store.with_context_read(|db| {
            let pending = db.prepare("SELECT m.id FROM memories m LEFT JOIN memory_embeddings e ON e.memory_id=m.id WHERE m.project_path='project' AND m.status IN ('active','permanent') AND m.superseded_by_memory_id IS NULL AND e.memory_id IS NULL ORDER BY m.id")?
                .query_map([], |r| r.get::<_, i64>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            assert_eq!(json!(pending), case["args"]["ids"], "{action} exact pending embeddings");
            assert_eq!(db.query_row("SELECT COUNT(*) FROM memory_verifications WHERE memory_id IN (SELECT value FROM json_each(?1))", [case["args"]["ids"].to_string()], |r| r.get::<_,i64>(0))?, 0);
            Ok(())
        }).unwrap();
    }
}
