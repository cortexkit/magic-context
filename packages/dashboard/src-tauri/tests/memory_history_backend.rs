use magic_context_dashboard_lib::{db, memory_bridge};
use rusqlite::{params, Connection};
use serde_json::{json, Value};

fn fixture(path: &std::path::Path) -> Connection {
    mc_store::single_store_domain::create_test_context_db(path).unwrap();
    let conn = Connection::open(path).unwrap();
    conn.execute("INSERT INTO memories(project_path,category,content,normalized_hash,source_type,importance,scope,shareable,status,first_seen_at,created_at,updated_at,last_seen_at) VALUES('git:idle','CONFIG_VALUES',?1,?2,'agent',50,'project',0,'active',1,1,1,1)", params!["cache_ttl=5m", mc_store::memory_history::normalized_hash("cache_ttl=5m")]).unwrap();
    conn
}
fn edit_request() -> Value {
    json!({ "projectPath":"git:idle", "operationId":"edit", "expectedRevisions":[{"memoryId":1,"revision":1}], "changes":[{"memoryId":1,"content":"cache_ttl=10m"}] })
}

#[tokio::test]
async fn ts_owned_dashboard_edit_works_without_any_host_process() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("context.db");
    let conn = fixture(&path);
    drop(conn);
    let receipt = db::memory_request(&path, "memory.edit", edit_request())
        .await
        .unwrap();
    assert_eq!(receipt["state"], "applied");
    let conn = Connection::open(&path).unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT content,revision FROM memories WHERE id=1",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        )
        .unwrap(),
        ("cache_ttl=10m".into(), 2)
    );
}

#[tokio::test]
async fn module_owned_idle_host_keeps_history_readable_and_refuses_without_sql_fallback() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("context.db");
    let mut conn = fixture(&path);
    let edited = mc_store::memory_history::local_write(&mut conn, &edit_request(), 1000).unwrap();
    conn.execute("INSERT INTO authority_managed(project_path,context_store_uuid,marked_at) VALUES('git:idle','idle-context',1000)", []).unwrap();
    drop(conn);
    // A live daemon endpoint cannot grant the external editor local ownership.
    let _daemon = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let before = std::fs::read(&path).unwrap();
    let history =
        memory_bridge::request(&path, "memory.history", json!({ "projectPath":"git:idle" }))
            .await
            .unwrap();
    assert_eq!(history["decisions"].as_array().unwrap().len(), 1);
    let request = json!({ "projectPath":"git:idle", "decisionKey":edited["decisionKey"], "operationId":"undo", "expectedRevisions":[{"memoryId":1,"revision":2}] });
    let preview = memory_bridge::request(
        &path,
        "memory.restore.preview",
        json!({ "projectPath":"git:idle", "decisionKey":edited["decisionKey"] }),
    )
    .await
    .unwrap();
    assert_eq!(preview["state"], "ready");
    let receipt = memory_bridge::request(&path, "memory.restore", request.clone())
        .await
        .unwrap();
    assert_eq!(receipt["state"], "refused");
    assert_eq!(receipt["reason"], "authority_unavailable");
    assert_eq!(receipt["detail"], "module_host_not_running");
    assert_eq!(receipt["restoredDecisionKey"], Value::Null);
    assert_eq!(receipt["revisions"], json!([]));
    assert_eq!(
        memory_bridge::request(&path, "memory.restore", request)
            .await
            .unwrap(),
        receipt
    );
    assert_eq!(std::fs::read(&path).unwrap(), before);
    let edit = memory_bridge::request(&path, "memory.edit", edit_request())
        .await
        .unwrap();
    assert_eq!(edit["detail"], "module_host_not_running");
    assert_eq!(edit["decisionKey"], Value::Null);
    assert_eq!(std::fs::read(&path).unwrap(), before);
}

#[tokio::test]
async fn review_module_bridge_authenticates_and_never_falls_back_after_http_refusal() {
    use std::io::{Read, Write};
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("context.db");
    let conn = fixture(&path);
    conn.execute("INSERT INTO authority_managed(project_path,context_store_uuid,marked_at) VALUES('git:idle','review-context',1)", []).unwrap();
    drop(conn);
    let before = std::fs::read(&path).unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let rpc = directory.path().join("rpc/review");
    std::fs::create_dir_all(&rpc).unwrap();
    std::fs::write(rpc.join("port-review.json"), serde_json::to_vec(&json!({"projectPath":"git:idle", "port":port, "token":"throwaway-review-token", "started_at":1})).unwrap()).unwrap();
    // This listener observes the real HTTP request, not a mock of bearer_auth.
    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(std::time::Duration::from_secs(10)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut buffer = [0u8; 1024];
        while !bytes.windows(4).any(|part| part == b"\r\n\r\n") {
            let count = socket.read(&mut buffer).unwrap();
            assert_ne!(count, 0);
            bytes.extend_from_slice(&buffer[..count]);
        }
        let headers = String::from_utf8(bytes).unwrap().to_ascii_lowercase();
        assert!(headers.starts_with("post /rpc/memory.edit http/1.1"));
        assert!(headers.contains("authorization: bearer throwaway-review-token\r\n"));
        socket
            .write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .unwrap();
    });
    assert_eq!(
        memory_bridge::request(&path, "memory.edit", edit_request())
            .await
            .unwrap_err(),
        "authority_unavailable"
    );
    server.join().unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), before);
}

// Build the store and the decisions with the shipping TypeScript writers, then
// exercise the dashboard's local Rust reader/writer against those exact bytes.
fn typescript_operation(path: &std::path::Path, operation: &str) -> Value {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let script = r#"
import { Database } from './packages/plugin/src/shared/sqlite';
import { initializeDatabase } from './packages/plugin/src/features/magic-context/storage-db';
import { runMigrations } from './packages/plugin/src/features/magic-context/migrations';
import { insertMemory, getMemoryById } from './packages/plugin/src/features/magic-context/memory/storage-memory';
import { applyMemoryAdmission, applyHistorianRevision } from './packages/plugin/src/features/magic-context/memory/lifecycle-applier';
import { memoryHistorySnapshot } from './packages/plugin/src/features/magic-context/memory/history-applier';
import { CHECK_SYSTEM_PROMPTS } from './packages/plugin/src/features/magic-context/memory/lifecycle-gates';
import { lifecycleTextHash } from './packages/plugin/src/features/magic-context/memory/lifecycle-text';
const db = new Database(process.env.UNDO_DATABASE);
initializeDatabase(db);
runMigrations(db);
const projectPath = 'git:undo';
const operation = process.env.UNDO_OPERATION;
const add = (content) => insertMemory(db, { projectPath, category: 'CONFIG_VALUES', content, sourceType: 'agent', sourceSessionId: 'original-session' });
let before = [], survivorId;
if (operation === 'new' || operation === 'conflict') {
    const target = add('Conflicting original rule.');
    const receipt = applyMemoryAdmission(db, { key: 'operation', operation, conflictTargetId: target.id, input: { projectPath, category: 'CONFIG_VALUES', content: 'New rule.' } });
    if (receipt.state !== 'applied') throw new Error(JSON.stringify(receipt));
    survivorId = receipt.memoryId;
} else {
    const sources = [add('Old rule.')];
    if (operation === 'merge') sources.push(add('Other rule.'));
    for (const [i, row] of sources.entries()) {
        db.prepare("UPDATE memories SET status='permanent',metadata_json=?,safety_critical=?,importance=90 WHERE id=?").run(JSON.stringify({ original: i }), i === 0 ? 1 : 0, row.id);
        db.prepare('INSERT INTO memory_clause_evidence VALUES(?,1,1,?,?)').run(row.id, lifecycleTextHash(row.content), JSON.stringify({ original: row.id }));
    }
    before = sources.map((row) => memoryHistorySnapshot(db, row.id));
    const evidence = { blockStartOrdinal: 42, excerpt: 'New rule.' };
    const profile = { provider: 'test', modelId: 'undo', variant: null, temperature: 0, systemHash: 'historian' };
    const receipt = await applyHistorianRevision(db, {
        key: 'operation', action: operation, projectPath,
        expectedSources: before.map((row) => ({ id: row.id, revision: row.revision })),
        survivorId: sources[0].id, finalText: 'New rule.',
        changes: before.map((row) => ({ memoryId: row.id, ordinal: 1, replacement: true, evidence })),
        added: [{ text: 'New rule.', evidence }],
    }, {
        memoryEnabled: true, autoPromote: true, enabled: true, enforcedJson: true, anchorKnown: true,
        blocks: [{ startOrdinal: 42, endOrdinal: 42, role: 'user', parts: ['New rule.'], joinedText: 'New rule.' }],
        sources: before.map((row) => ({ ...getMemoryById(db, row.id), revision: row.revision })),
        historianProfile: profile,
        validatedProfiles: [profile, ...Object.values(CHECK_SYSTEM_PROMPTS).map((system) => ({ ...profile, systemHash: lifecycleTextHash(system) }))],
    }, { sessionId: 'undo', harness: 'opencode' }, async (request) => ({
        profile: { ...profile, systemHash: request.systemHash },
        verdicts: (request.kind === 'compatibility' ? request.pairs : request.operands).map((operand) => ({ id: operand.id, verdict: request.kind === 'disproof' || request.kind === 'support' ? 'yes' : 'no' })),
    }));
    if (receipt.state !== 'applied') throw new Error(JSON.stringify(receipt));
    survivorId = receipt.memoryId;
}
db.exec("INSERT INTO session_meta(session_id,cached_m0_materialized_at,cached_m0_max_mutation_id,cached_m0_max_memory_mutation_id) VALUES('undo',123,7,8); INSERT INTO session_render_cache(session_id,cache_key,value) VALUES('undo','cached_m0_bytes',X'010203'),('undo','cached_m1_bytes',X'040506')");
db.close();
console.log(JSON.stringify({ before, survivorId }));
"#;
    let output = std::process::Command::new("bun")
        .args(["-e", script])
        .current_dir(root)
        .env("UNDO_DATABASE", path)
        .env("UNDO_OPERATION", operation)
        .output()
        .expect("bun is required to produce TypeScript-owned undo fixtures");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

fn canonical_state(conn: &Connection) -> Value {
    let mut tables = serde_json::Map::new();
    for table in [
        "memories",
        "memory_history",
        "memory_journal",
        "memory_successor_links",
        "memory_conflict_links",
        "memory_clause_evidence",
        "memory_mutation_log",
        "project_state",
        "session_meta",
        "session_render_cache",
    ] {
        let mut statement = conn
            .prepare(&format!("SELECT * FROM {table} ORDER BY 1,2"))
            .unwrap();
        let columns = statement
            .column_names()
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>();
        let rows = statement
            .query_map([], |row| {
                let mut value = serde_json::Map::new();
                for (i, name) in columns.iter().enumerate() {
                    let item = match row.get_ref(i)? {
                        rusqlite::types::ValueRef::Null => Value::Null,
                        rusqlite::types::ValueRef::Integer(n) => json!(n),
                        rusqlite::types::ValueRef::Real(n) => json!(n),
                        rusqlite::types::ValueRef::Text(s) => json!(String::from_utf8_lossy(s)),
                        rusqlite::types::ValueRef::Blob(b) => json!(b),
                    };
                    value.insert(name.clone(), item);
                }
                Ok(Value::Object(value))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        tables.insert(table.to_string(), json!(rows));
    }
    Value::Object(tables)
}

#[tokio::test]
async fn dashboard_undoes_typescript_operations_atomically_without_rebuilding_cache() {
    for operation in ["edit", "merge", "replaces", "new", "conflict"] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("context.db");
        let fixture = typescript_operation(&path, operation);
        let conn = Connection::open(&path).unwrap();
        let cache = canonical_state(&conn)["session_meta"].clone();
        let payloads = canonical_state(&conn)["session_render_cache"].clone();
        let preview = memory_bridge::request(
            &path,
            "memory.restore.preview",
            json!({"projectPath":"git:undo","decisionKey":"operation"}),
        )
        .await
        .unwrap();
        assert_eq!(preview["state"], "ready", "{operation}: {preview}");
        let mut request = json!({"projectPath":"git:undo","decisionKey":"operation","operationId":"undo","expectedRevisions":preview["expectedRevisions"]});
        if operation == "merge" {
            // Make the last participant stale so a partial first-row write would be observable.
            conn.execute("UPDATE memories SET revision=revision+1 WHERE id=2", [])
                .unwrap();
            let unchanged = canonical_state(&conn);
            let refused = memory_bridge::request(&path, "memory.restore", request.clone())
                .await
                .unwrap();
            assert_eq!(refused["reason"], "stale_revision");
            assert_eq!(canonical_state(&conn), unchanged);
            let preview = memory_bridge::request(
                &path,
                "memory.restore.preview",
                json!({"projectPath":"git:undo","decisionKey":"operation"}),
            )
            .await
            .unwrap();
            request["operationId"] = json!("undo-fresh");
            request["expectedRevisions"] = preview["expectedRevisions"].clone();
            let unchanged = canonical_state(&conn);
            let receipts: i64 = conn
                .query_row("SELECT COUNT(*) FROM memory_decision_receipts", [], |row| {
                    row.get(0)
                })
                .unwrap();
            conn.execute_batch("CREATE TRIGGER fail_restore BEFORE INSERT ON memory_history BEGIN SELECT RAISE(ABORT,'injected restore failure'); END;").unwrap();
            let failure = memory_bridge::request(&path, "memory.restore", request.clone())
                .await
                .unwrap_err();
            assert!(failure.contains("injected restore failure"), "{failure}");
            assert_eq!(canonical_state(&conn), unchanged);
            assert_eq!(
                conn.query_row("SELECT COUNT(*) FROM memory_decision_receipts", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
                receipts
            );
            conn.execute_batch("DROP TRIGGER fail_restore").unwrap();
        }
        let restored = db::memory_request(&path, "memory.restore", request.clone())
            .await
            .unwrap();
        assert_eq!(restored["state"], "applied", "{operation}: {restored}");
        for original in fixture["before"].as_array().unwrap() {
            let id = original["id"].as_i64().unwrap();
            let current = mc_store::memory_history::snapshot(&conn, id)
                .unwrap()
                .unwrap();
            for field in [
                "content",
                "status",
                "supersededByMemoryId",
                "mergedFrom",
                "metadataJson",
                "safetyCritical",
                "importance",
                "sourceSessionId",
                "sourceType",
            ] {
                assert_eq!(current[field], original[field], "{operation} {id} {field}");
            }
            assert_eq!(
                current["revision"],
                if operation == "merge" && id == 2 {
                    4
                } else {
                    3
                }
            );
            let evidence: String = conn.query_row("SELECT evidence_json FROM memory_clause_evidence WHERE memory_id=?1 AND revision=?2", params![id, current["revision"].as_i64()], |row| row.get(0)).unwrap();
            assert_eq!(evidence, json!({"original":id}).to_string());
            let stale = memory_bridge::request(&path, "memory.edit", json!({"projectPath":"git:undo","operationId":format!("old-{id}"),"expectedRevisions":[{"memoryId":id,"revision":1}],"changes":[{"memoryId":id,"content":"Stale decision."}]})).await.unwrap();
            assert_eq!(stale["reason"], "stale_revision");
            assert_eq!(
                mc_store::memory_history::snapshot(&conn, id)
                    .unwrap()
                    .unwrap(),
                current
            );
        }
        let survivor = fixture["survivorId"].as_i64().unwrap();
        if ["replaces", "new", "conflict"].contains(&operation) {
            let current = mc_store::memory_history::snapshot(&conn, survivor)
                .unwrap()
                .unwrap();
            assert_eq!(current["status"], "archived");
            assert_eq!(current["revision"], 2);
        }
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM memory_successor_links", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM memory_conflict_links", [], |row| row
                .get::<_, i64>(
                0
            ))
            .unwrap(),
            0
        );
        assert_eq!(canonical_state(&conn)["session_meta"], cache);
        assert_eq!(canonical_state(&conn)["session_render_cache"], payloads);
        let unchanged = canonical_state(&conn);
        assert_eq!(
            db::memory_request(&path, "memory.restore", request)
                .await
                .unwrap(),
            restored
        );
        assert_eq!(canonical_state(&conn), unchanged);
    }
}
