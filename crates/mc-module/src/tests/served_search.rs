//! Seeded-store proofs at the model-visible facade, with expected output bytes
//! rendered by TypeScript.

use super::*;
use crate::embedding_provider::{ProviderIo, Settings};
use crate::retrieval::embedding_provider::{EmbeddingError, HttpRequest, HttpResponse};
use crate::retrieval::hybrid::RerankIdentity;
use rusqlite::params;

const DAY: i64 = 1_735_689_600_000;
const FUTURE: i64 = 4_070_908_800_000;

fn golden() -> Value {
    serde_json::from_str(include_str!("../../testdata/ctx-search-tool-golden.json")).unwrap()
}

#[derive(Default)]
struct FixtureIo {
    fail_embed: bool,
    fail_rerank: bool,
    synapse: bool,
    calls: Mutex<Vec<(String, Value)>>,
}

#[subc_client_rs::async_trait]
impl ProviderIo for FixtureIo {
    async fn post(
        &self,
        request: HttpRequest,
        _timeout: Duration,
    ) -> Result<HttpResponse, EmbeddingError> {
        let body: Value = serde_json::from_slice(&request.body).unwrap();
        self.calls
            .lock()
            .unwrap()
            .push((request.url.clone(), body.clone()));
        if request.url.ends_with("/embeddings") {
            if self.fail_embed {
                return Err(EmbeddingError::Transport);
            }
            Ok(HttpResponse {
                status: 200,
                headers: vec![],
                body: br#"{"model":"fixture","data":[{"index":0,"embedding":[1,0]}]}"#.to_vec(),
            })
        } else if request.url.ends_with("/rerank") {
            if self.fail_rerank {
                return Ok(HttpResponse {
                    status: 503,
                    headers: vec![],
                    body: b"private provider body".to_vec(),
                });
            }
            let docs = body["documents"].as_array().unwrap();
            let rows = (0..docs.len())
                .rev()
                .map(|i| json!({"index":i,"relevance_score":i as f64}))
                .collect::<Vec<_>>();
            Ok(HttpResponse {
                status: 200,
                headers: vec![],
                body: json!({"results":rows}).to_string().into_bytes(),
            })
        } else {
            Err(EmbeddingError::Transport)
        }
    }
    async fn rpc(
        &self,
        method: &str,
        params: Value,
        _identity: RerankIdentity,
        _timeout_ms: u64,
        _connection: Option<&Path>,
    ) -> Result<Value, String> {
        self.calls
            .lock()
            .unwrap()
            .push((method.into(), params.clone()));
        if self.synapse {
            if method == "models.list" {
                return Ok(
                    json!({"table_epoch":6,"models":[{"model_id":"gte-modernbert-base-f16","certified":true,"fingerprints":["b".repeat(64)],"max_tokens":512,"max_tokens_source":"catalog","dims":2}]}),
                );
            }
            if self.fail_embed {
                return Err("unavailable".into());
            }
            assert_eq!(method, "embed.query");
            assert_eq!(
                params,
                json!({"id":"query","text":"needle","purpose":"query","deadline_ms":3000,"model":"gte-modernbert-base-f16","required_fingerprint":"b".repeat(64),"required_epoch":6,"allow_equivalent":false})
            );
            use sha2::Digest;
            let hash = format!("{:x}", sha2::Sha256::digest(b"needle"));
            return Ok(
                json!({"fingerprint":"b".repeat(64),"table_epoch":6,"dims":2,"vectors":[{"id":"query","vector":[1,0],"submitted_sha256":hash,"content_sha256":hash}]}),
            );
        }
        if method == "models.list" {
            return Ok(
                json!({"table_epoch":6,"models":[{"model_id":"gte-reranker-modernbert-base-f32","certified":true,"fingerprints":["a".repeat(64)]}]}),
            );
        }
        if self.fail_rerank {
            return Err("private provider error must never be rendered".into());
        }
        let count = params["candidates"].as_array().unwrap().len();
        Ok(
            json!({"fingerprint":"a".repeat(64),"table_epoch":6,"scores":(0..count).map(|i|i as f64).collect::<Vec<_>>()}),
        )
    }
}

fn fixture(
    config: Value,
    io: Arc<FixtureIo>,
) -> (McHandler, Arc<McStore>, tempfile::TempDir, PathBuf) {
    let resolver = FakeSessionResolver::with(&[("token", FakeResolve::Hit("ses".into()))]);
    let (mut handler, store, dir, project) = handler_with_store_and_resolver(
        Arc::new(ProducerState::default()),
        default_test_config(),
        resolver,
    );
    std::fs::create_dir(project.join(".git")).unwrap();
    handler.bind_route(7, binding(project.to_str().unwrap(), "token"));
    handler.record_route_role_versions(
        7,
        Some(&BTreeMap::from([(
            cortexkit_role_tool_provider::ROLE.to_owned(),
            cortexkit_role_tool_provider::VERSION.to_owned(),
        )])),
    );
    handler.search_io = io;
    handler
        .config
        .lock()
        .unwrap()
        .set_search_providers_for_test(Settings::from_tiers(
            Some(&config),
            None,
            &dir.path().join("config.json"),
        ));
    (handler, store, dir, project)
}

fn lexical() -> Value {
    json!({"embedding":{"provider":"off"},"rerank":{"provider":"off"},"memory":{"git_commit_indexing":{"enabled":true}}})
}
fn semantic() -> Value {
    json!({"embedding":{"provider":"openai-compatible","endpoint":"https://embedding.invalid/v1","model":"fixture"},"rerank":{"provider":"off"}})
}

async fn search(handler: &McHandler, args: Value) -> String {
    tool_text(call_facade(handler, "ctx_search", args).await)
}

fn raw(store: &McStore, session: &str, ordinal: i64, content: &str, time: Option<i64>) {
    store.with_context_conn_for_test(|db| {
        db.execute("INSERT INTO message_history_fts(session_id,message_ordinal,message_id,role,content) VALUES (?1,?2,?3,'user',?4)",params![session,ordinal,format!("raw-{ordinal}"),content])?;
        db.execute("INSERT INTO message_fts_rowid_map(session_id,message_ordinal,fts_rowid,message_time_ms) VALUES (?1,?2,?3,?4)",params![session,ordinal,db.last_insert_rowid(),time])?;
        Ok(())
    }).unwrap();
}

fn register(store: &McStore, project: &str) {
    let g = golden();
    store.with_context_conn_for_test(|db| {
        db.execute("INSERT INTO embedding_registrations(project_path,model_id,chunk_model_id,fingerprint,table_epoch,dims,generation) VALUES (?1,?2,?3,'',0,2,1)",params![project,g["embedding"]["modelId"].as_str().unwrap(),g["embedding"]["chunkId"].as_str().unwrap()])?;
        Ok(())
    }).unwrap();
}

fn memory_vector(store: &McStore, id: i64, model: &str, values: [f32; 2]) {
    let bytes = values
        .into_iter()
        .flat_map(f32::to_le_bytes)
        .collect::<Vec<_>>();
    store
        .with_context_conn_for_test(|db| {
            db.execute(
                "INSERT INTO memory_embeddings(memory_id,model_id,embedding) VALUES (?1,?2,?3)",
                params![id, model, bytes],
            )?;
            Ok(())
        })
        .unwrap();
}

#[tokio::test]
async fn memory_uses_ts_fts_scoring_and_output_bytes() {
    let (handler, store, _dir, project) = fixture(lexical(), Arc::default());
    insert_memory(
        &store,
        project.to_str().unwrap(),
        "CONSTRAINTS",
        "needle memory",
        DAY,
    );
    assert_eq!(
        search(&handler, json!({"query":"needle","sources":["memory"]})).await,
        golden()["outputs"]["memory"]
    );
}

#[tokio::test]
async fn raw_messages_use_archive_and_ts_bytes_not_literal_compartment_search() {
    let (handler, store, _dir, _project) = fixture(lexical(), Arc::default());
    store
        .replace_compartments("ses", &[stored_comp(1, 1, 5, "m5", "unrelated summary")])
        .unwrap();
    raw(&store, "ses", 4, "needle archived text", Some(DAY));
    assert_eq!(
        search(&handler, json!({"query":"needle","sources":["message"]})).await,
        golden()["outputs"]["message"]
    );
}

#[tokio::test]
async fn primer_only_search_returns_existing_producer_rows_and_ts_bytes() {
    let (handler, store, _dir, project) = fixture(lexical(), Arc::default());
    store.with_context_conn_for_test(|db| {db.execute("INSERT INTO primers(project_path,question,answer,total_support,created_at,updated_at) VALUES (?1,'needle question','A supported answer',3,?2,?2)",params![project.to_str().unwrap(),DAY])?;Ok(())}).unwrap();
    assert_eq!(
        search(&handler, json!({"query":"needle","sources":["primer"]})).await,
        golden()["outputs"]["primer"]
    );
}

#[tokio::test]
async fn git_only_search_returns_indexed_commits_and_ts_bytes() {
    let (handler, store, _dir, project) = fixture(lexical(), Arc::default());
    store.with_context_conn_for_test(|db| {db.execute("INSERT INTO git_commits(sha,short_sha,project_path,message,committed_at,indexed_at) VALUES (?1,'aaaaaaa',?2,'needle commit',?3,?3)",params!["a".repeat(40),project.to_str().unwrap(),FUTURE])?;Ok(())}).unwrap();
    assert_eq!(
        search(&handler, json!({"query":"needle","sources":["git_commit"]})).await,
        golden()["outputs"]["git"]
    );
}

#[tokio::test]
async fn note_only_search_keeps_ts_anchor_and_output_bytes() {
    let (handler, store, _dir, project) = fixture(lexical(), Arc::default());
    store
        .insert_project_note(NoteWriteInput {
            project_path: project.to_str().unwrap(),
            route_project_root: None,
            session_id: Some("ses"),
            content: "needle  note",
            surface_condition: None,
            compiled_provider: None,
            compiled_config: None,
            compiled_at: None,
            compile_status: None,
            anchor_block_id: None,
            anchor_ordinal: Some(4),
            now_ms: FUTURE,
        })
        .unwrap();
    assert_eq!(
        search(&handler, json!({"query":"needle","sources":["note"]})).await,
        golden()["outputs"]["note"]
    );
}

#[tokio::test]
async fn semantic_query_embeds_once_and_checks_stored_model_identity() {
    let io = Arc::new(FixtureIo::default());
    let (handler, store, _dir, project) = fixture(semantic(), io.clone());
    let project = project.to_str().unwrap();
    let id = insert_memory(&store, project, "CONSTRAINTS", "unrelated wording", DAY);
    register(&store, project);
    memory_vector(
        &store,
        id,
        golden()["embedding"]["modelId"].as_str().unwrap(),
        [1., 0.],
    );
    let hit = search(&handler, json!({"query":"needle","sources":["memory"]})).await;
    assert!(
        hit.contains("score=0.80") && hit.contains("match=semantic"),
        "{hit}"
    );
    {
        let calls = io.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].1, json!({"model":"fixture","input":["needle"]}));
    }
    store
        .with_context_conn_for_test(|db| {
            db.execute(
                "UPDATE memory_embeddings SET model_id='different-provider'",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    let mismatch = search(&handler, json!({"query":"needle","sources":["memory"]})).await;
    assert!(mismatch.starts_with("No results found"), "{mismatch}");
}

#[tokio::test]
async fn semantic_compartments_use_ts_chunk_identity_and_output_bytes() {
    let (handler, store, _dir, project) = fixture(semantic(), Arc::default());
    let project = project.to_str().unwrap();
    register(&store, project);
    store
        .replace_compartments("ses", &[stored_comp(1, 1, 5, "m5", "unrelated summary")])
        .unwrap();
    let chunk = golden()["embedding"]["chunkId"]
        .as_str()
        .unwrap()
        .to_owned();
    store.with_context_conn_for_test(|db| {
        let id:i64=db.query_row("SELECT id FROM compartments WHERE session_id='ses'",[],|r|r.get(0))?;
        db.execute("INSERT INTO compartment_chunk_embeddings(compartment_id,session_id,project_path,window_index,start_ordinal,end_ordinal,chunk_hash,dims,created_at,vector,model_id) VALUES (?1,'ses',?2,0,1,5,'fixture',2,0,?3,?4)",params![id,project,[1f32,0.].into_iter().flat_map(f32::to_le_bytes).collect::<Vec<_>>(),chunk])?;
        Ok(())
    }).unwrap();
    assert_eq!(
        search(&handler, json!({"query":"needle","sources":["message"]})).await,
        golden()["outputs"]["compartment"]
    );
}

#[tokio::test]
async fn filters_and_dates_apply_before_limits_across_new_lanes() {
    let (handler, store, _dir, project) = fixture(lexical(), Arc::default());
    let project = project.to_str().unwrap();
    store
        .replace_compartments("ses", &[stored_comp(1, 1, 9, "m9", "unrelated summary")])
        .unwrap();
    for (ordinal, time) in [(1, Some(DAY - 1)), (2, Some(DAY)), (3, None)] {
        raw(&store, "ses", ordinal, "needle text", time);
    }
    raw(&store, "foreign", 2, "needle foreign", Some(DAY));
    let dated=search(&handler,json!({"query":"needle","sources":["message"],"from":"2025-01-01","to":"2025-01-01","limit":1})).await;
    assert!(
        dated.contains("ordinal=2") && !dated.contains("[memory]"),
        "{dated}"
    );
    store.with_context_conn_for_test(|db| {
        for (owner,time,question) in [(project,DAY-1,"needle before"),(project,DAY,"needle on date"),("foreign",DAY,"needle foreign")] {
            db.execute("INSERT INTO primers(project_path,question,created_at,updated_at) VALUES (?1,?2,?3,?3)",params![owner,question,time])?;
        }
        Ok(())
    }).unwrap();
    let primer=search(&handler,json!({"query":"needle","sources":["primer"],"from":"2025-01-01","to":"2025-01-01","limit":1})).await;
    assert!(
        primer.contains("needle on date")
            && !primer.contains("needle before")
            && !primer.contains("needle foreign"),
        "{primer}"
    );
    let all = search(&handler, json!({"query":"needle","sources":[]})).await;
    assert!(
        all.contains("[message]") && all.contains("[primer]"),
        "{all}"
    );
    let none = search(&handler, json!({"query":"needle","sources":["invalid"]})).await;
    assert!(none.starts_with("No results found"), "{none}");
}

#[tokio::test]
async fn live_tail_is_hidden_with_and_without_compartments_and_index_gap_stays_unfilled() {
    let (handler, store, _dir, _project) = fixture(lexical(), Arc::default());
    // Three of five runner messages are indexed. Search may not manufacture the
    // two newest messages; archive intake has a separate owner.
    let runner_ordinals = [1, 2, 3, 4, 5];
    for &ordinal in runner_ordinals.iter().take(3) {
        raw(&store, "ses", ordinal, "needle archived text", Some(DAY));
    }
    let before = search(&handler, json!({"query":"needle","sources":["message"]})).await;
    assert!(
        before.contains("3 raw-message matches are newer"),
        "{before}"
    );
    assert!(!before.contains("[message]"));
    store
        .replace_compartments("ses", &[stored_comp(1, 1, 2, "m2", "unrelated summary")])
        .unwrap();
    let after = search(&handler, json!({"query":"needle","sources":["message"]})).await;
    assert!(
        after.contains("ordinal=1") && after.contains("ordinal=2") && !after.contains("ordinal=3"),
        "{after}"
    );
    assert!(after.contains("1 raw-message match is newer"));
    let count = store
        .with_context_conn_for_test(|db| {
            db.query_row("SELECT COUNT(*) FROM message_history_fts", [], |r| {
                r.get::<_, i64>(0)
            })
        })
        .unwrap();
    assert_eq!(
        count, 3,
        "search is read-only and must not fill the two-message gap"
    );
    assert_eq!(
        runner_ordinals.len() as i64 - count,
        2,
        "coverage: 3 indexed of 5 runner messages, 2 unindexed"
    );
}

#[tokio::test]
async fn head_memory_hiding_applies_to_semantic_results_but_not_changed_text() {
    let (handler, store, _dir, project) = fixture(semantic(), Arc::default());
    let project = project.to_str().unwrap();
    let id = insert_memory(&store, project, "CONSTRAINTS", "unrelated wording", DAY);
    register(&store, project);
    memory_vector(
        &store,
        id,
        golden()["embedding"]["modelId"].as_str().unwrap(),
        [1., 0.],
    );
    seed_shown_memory_pair(&store, "ses", project, id);
    let hidden = search(&handler, json!({"query":"needle","sources":["memory"]})).await;
    assert!(
        hidden.contains("all already visible") && !hidden.contains("[memory]"),
        "{hidden}"
    );
    store
        .with_context_conn_for_test(|db| {
            db.execute(
                "UPDATE memories SET content='corrected text' WHERE id=?",
                [id],
            )?;
            Ok(())
        })
        .unwrap();
    let changed = search(&handler, json!({"query":"needle","sources":["memory"]})).await;
    assert!(
        changed.contains("corrected text") && changed.contains("match=semantic"),
        "{changed}"
    );
}

#[tokio::test]
async fn failing_embedding_keeps_ts_lexical_baseline() {
    let (handler, store, _dir, project) = fixture(
        semantic(),
        Arc::new(FixtureIo {
            fail_embed: true,
            ..Default::default()
        }),
    );
    let project = project.to_str().unwrap();
    insert_memory(&store, project, "CONSTRAINTS", "needle memory", DAY);
    register(&store, project);
    assert_eq!(
        search(&handler, json!({"query":"needle","sources":["memory"]})).await,
        golden()["outputs"]["memory"]
    );
}

#[tokio::test]
async fn configured_rerank_changes_order_and_failure_retains_complete_baseline() {
    let mut config = lexical();
    config["rerank"]["provider"] = json!("synapse");
    let io = Arc::new(FixtureIo::default());
    let (mut handler, store, _dir, project) = fixture(config, io.clone());
    let project = project.to_str().unwrap();
    insert_memory(
        &store,
        project,
        "CONSTRAINTS",
        "where needle memory first",
        DAY,
    );
    insert_memory(
        &store,
        project,
        "CONSTRAINTS",
        "where needle memory second",
        DAY,
    );
    let query = "where needle memory";
    let ranked = search(&handler, json!({"query":query,"sources":["memory"]})).await;
    assert!(ranked.find("id=2 ") < ranked.find("id=1 "), "{ranked}");
    assert!(io
        .calls
        .lock()
        .unwrap()
        .iter()
        .any(|(m, _)| m == "rerank.score"));
    handler.search_io = Arc::new(FixtureIo {
        fail_rerank: true,
        ..Default::default()
    });
    let fallback = search(&handler, json!({"query":query,"sources":["memory"]})).await;
    assert!(
        fallback.find("id=1 ") < fallback.find("id=2 "),
        "{fallback}"
    );
    assert!(!fallback.contains("private provider error"));
}

#[tokio::test]
async fn synapse_query_uses_ts_protocol_and_certified_stored_identity() {
    let io = Arc::new(FixtureIo {
        synapse: true,
        ..Default::default()
    });
    let (handler, store, _dir, project) = fixture(
        json!({"embedding":{"provider":"synapse","fallback_provider":"off"},"rerank":{"provider":"off"}}),
        io.clone(),
    );
    let project = project.to_str().unwrap();
    let id = insert_memory(&store, project, "CONSTRAINTS", "unrelated wording", DAY);
    register(&store, project);
    let model = golden()["embedding"]["synapseId"]
        .as_str()
        .unwrap()
        .to_owned();
    store
        .with_context_conn_for_test(|db| {
            db.execute(
                "UPDATE embedding_registrations SET model_id=?1,fingerprint=?2,table_epoch=6",
                params![model, "b".repeat(64)],
            )?;
            Ok(())
        })
        .unwrap();
    memory_vector(&store, id, &model, [1., 0.]);
    let result = search(&handler, json!({"query":"needle","sources":["memory"]})).await;
    assert!(result.contains("match=semantic"), "{result}");
    assert_eq!(io.calls.lock().unwrap().len(), 2);
    store
        .with_context_conn_for_test(|db| {
            db.execute(
                "UPDATE embedding_registrations SET fingerprint='wrong-provider-fingerprint'",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    let mismatch = search(&handler, json!({"query":"needle","sources":["memory"]})).await;
    assert!(mismatch.starts_with("No results found"), "{mismatch}");
    assert_eq!(
        io.calls.lock().unwrap().len(),
        3,
        "identity mismatch must stop before embed.query"
    );
}

#[tokio::test]
async fn hosted_rerank_validates_indices_and_reports_safe_failure_without_synapse() {
    let config = json!({"embedding":{"provider":"off"},"rerank":{"provider":"remote","endpoint":"https://rank.invalid/v1","model":"ranker","api_key":"fake-private-key","timeout_ms":1500,"top_n":20}});
    let io = Arc::new(FixtureIo::default());
    let (mut handler, store, _dir, project) = fixture(config, io.clone());
    let project = project.to_str().unwrap();
    insert_memory(
        &store,
        project,
        "CONSTRAINTS",
        "where needle memory first",
        DAY,
    );
    insert_memory(
        &store,
        project,
        "CONSTRAINTS",
        "where needle memory second",
        DAY,
    );
    let result = search(
        &handler,
        json!({"query":"where needle memory","sources":["memory"]}),
    )
    .await;
    assert!(result.find("id=2 ") < result.find("id=1 "), "{result}");
    {
        let calls = io.calls.lock().unwrap();
        assert_eq!(calls.len(), 1, "hosted rerank must not discover Synapse");
        assert_eq!(calls[0].0, "https://rank.invalid/v1/rerank");
        assert_eq!(calls[0].1["model"], "ranker");
        assert_eq!(calls[0].1["top_n"], 2);
        assert!(calls[0].1["documents"][0]
            .as_str()
            .unwrap()
            .contains("where needle memory first"));
    }
    handler.search_io = Arc::new(FixtureIo {
        fail_rerank: true,
        ..Default::default()
    });
    let fallback = search(
        &handler,
        json!({"query":"where needle memory","sources":["memory"]}),
    )
    .await;
    assert!(
        fallback.find("id=1 ") < fallback.find("id=2 "),
        "{fallback}"
    );
    assert!(
        fallback.ends_with("\nReranking skipped: http_503"),
        "{fallback}"
    );
    assert!(!fallback.contains("private"));
}

#[tokio::test]
async fn registration_mismatch_and_blocked_endpoint_fall_back_without_provider_calls() {
    let io = Arc::new(FixtureIo::default());
    let mut config = semantic();
    config["embedding"]["model"] = json!("different-model");
    let (handler, store, _dir, project) = fixture(config, io.clone());
    let project = project.to_str().unwrap();
    insert_memory(&store, project, "CONSTRAINTS", "needle memory", DAY);
    register(&store, project);
    assert_eq!(
        search(&handler, json!({"query":"needle","sources":["memory"]})).await,
        golden()["outputs"]["memory"]
    );
    assert!(io.calls.lock().unwrap().is_empty());
    let mut config = semantic();
    config["embedding"]["endpoint"] = json!("http://169.254.169.254");
    handler
        .config
        .lock()
        .unwrap()
        .set_search_providers_for_test(Settings::from_tiers(
            Some(&config),
            None,
            Path::new("fixture.json"),
        ));
    assert_eq!(
        search(&handler, json!({"query":"needle","sources":["memory"]})).await,
        golden()["outputs"]["memory"]
    );
    assert!(io.calls.lock().unwrap().is_empty());
}
