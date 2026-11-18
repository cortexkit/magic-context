//! Which Synapse module a reranked `ctx_search` calls: the local `synapse`
//! unless the user's file names another, and then that one only.

use super::*;
use crate::client::{Child, ClientError, RunnerClient};
use crate::context_db::ContextDb;
use crate::pass::Settings;
use crate::route::{Project, Route};
use crate::session::Session;
use cortexkit_role_compaction::read::{Head, ReadPage, ReadRequest, SessionRef};
use cortexkit_role_compaction::view::{AppliedViewAnswer, ApplyViewAnswer, ApplyViewRequest};
use cortexkit_role_llm_runner::run::{RunResult, RunResultRequest};
use cortexkit_role_llm_runner::send::{SendReply, SendRequest};
use std::sync::Arc;

const REMOTE: &str = "fed:0123456789abcdef0123456789abcdef:synapse";

#[test]
fn a_module_id_is_a_plain_id_or_a_federated_one() {
    for usable in [
        "synapse",
        "  synapse ",
        "my-synapse_2",
        REMOTE,
        "fed:ffffffffffffffffffffffffffffffff:synapse-dev",
    ] {
        assert_eq!(module_id(usable), Some(usable.trim()), "{usable:?}");
    }
    for malformed in [
        "",
        "   ",
        "fed:",
        "fed:0123456789abcdef0123456789abcdef",
        "fed:0123456789abcdef0123456789abcdef:",
        "fed:0123456789ABCDEF0123456789ABCDEF:synapse",
        "fed:0123456789abcdef0123456789abcde:synapse",
        "fed:0123456789abcdef0123456789abcdef0:synapse",
        "fed:0123456789abcdef0123456789abcdeg:synapse",
        "fed:0123456789abcdef0123456789abcdef:syn:apse",
        "fed:0123456789abcdef0123456789abcdef:syn apse",
        "peer:synapse",
        "syn apse",
        "syn\tapse",
        "syn\u{7}apse",
        "a/b",
        "..",
    ] {
        assert_eq!(module_id(malformed), None, "{malformed:?}");
    }
}

#[test]
fn the_user_names_the_module_and_a_project_cannot() {
    let none = json!({});
    let remote = json!({"rerank": {"module": REMOTE}});
    assert_eq!(
        Reranker::from_tiers(&none, &none),
        Reranker::Synapse(SYNAPSE_MODULE.into())
    );
    assert_eq!(
        Reranker::from_tiers(&remote, &none),
        Reranker::Synapse(REMOTE.into())
    );
    // With the provider named as well, and with surrounding whitespace.
    let named = json!({"rerank": {"provider": "synapse", "module": format!(" {REMOTE} ")}});
    assert_eq!(
        Reranker::from_tiers(&named, &none),
        Reranker::Synapse(REMOTE.into())
    );
    // A project naming a module changes nothing, whichever way the user
    // chose.
    assert_eq!(
        Reranker::from_tiers(&none, &remote),
        Reranker::local_synapse()
    );
    let other = json!({"rerank": {"provider": "synapse", "module": "fed:ffffffffffffffffffffffffffffffff:synapse"}});
    assert_eq!(
        Reranker::from_tiers(&remote, &other),
        Reranker::Synapse(REMOTE.into())
    );
    // A malformed value keeps the default.
    for malformed in [json!("fed:ABC:synapse"), json!(7), json!(""), json!({})] {
        let user = json!({"rerank": {"module": malformed}});
        assert_eq!(
            Reranker::from_tiers(&user, &none),
            Reranker::local_synapse(),
            "{user}"
        );
    }
}

/// A runner whose Synapse answers on the one module `serves`, if any: its
/// catalog pins a lane with `fingerprint`, and it scores a document 10 when
/// it mentions "Zebra" and 0 otherwise. Any other module is refused as the
/// daemon refuses one that isn't registered. Every call is recorded as
/// (module, method).
struct Modules {
    serves: Mutex<Option<&'static str>>,
    fingerprint: String,
    calls: Mutex<Vec<(String, String)>>,
}

impl Modules {
    fn serving(module: &'static str, fingerprint: char) -> Self {
        Self {
            serves: Mutex::new(Some(module)),
            fingerprint: fingerprint.to_string().repeat(64),
            calls: Mutex::new(Vec::new()),
        }
    }

    fn calls(&self) -> Vec<(String, String)> {
        self.calls.lock().unwrap().clone()
    }
}

impl RunnerClient for Modules {
    async fn read(&self, _: &SessionRef, _: ReadRequest) -> Result<ReadPage, ClientError> {
        Ok(ReadPage::new(Vec::new(), Head::new()))
    }

    async fn apply_view(
        &self,
        _: &SessionRef,
        _: ApplyViewRequest,
    ) -> Result<ApplyViewAnswer, ClientError> {
        Ok(ApplyViewAnswer::Accepted)
    }

    async fn applied_view(&self, _: &SessionRef) -> Result<AppliedViewAnswer, ClientError> {
        Ok(AppliedViewAnswer::new())
    }

    async fn send(&self, _: &SessionRef, _: SendRequest) -> Result<SendReply, ClientError> {
        Ok(SendReply::new("pending"))
    }

    async fn send_child(&self, _: &Child, _: SendRequest) -> Result<SendReply, ClientError> {
        Ok(SendReply::new("pending"))
    }

    async fn child_result(
        &self,
        _: &Child,
        request: RunResultRequest,
    ) -> Result<RunResult, ClientError> {
        Err(ClientError::new(format!("no run {}", request.run_id)))
    }

    async fn synapse_call(
        &self,
        _: &SessionRef,
        module: &str,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        self.calls
            .lock()
            .unwrap()
            .push((module.to_owned(), method.to_owned()));
        if *self.serves.lock().unwrap() != Some(module) {
            return Err("unknown_module".into());
        }
        let fingerprint = &self.fingerprint;
        match method {
            "models.list" => Ok(json!({"result": {"table_epoch": 1, "models": [{
                "model_id": MODEL,
                "serving_admission": "enabled",
                "fingerprints": [fingerprint],
            }]}})),
            "rerank.score" => {
                let scores: Vec<f64> = params["candidates"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|text| {
                        if text.as_str().unwrap().contains("Zebra") {
                            10.0
                        } else {
                            0.0
                        }
                    })
                    .collect();
                Ok(
                    json!({"result": {"fingerprint": fingerprint, "table_epoch": 1, "scores": scores}}),
                )
            }
            _ => Err("unknown_method".into()),
        }
    }
}

/// A tools-only session over a store of two memories: the ordinary ranking
/// puts "The parser handles" first, the stand-in Synapse puts "Zebra" first.
fn search_session(dir: &std::path::Path) -> Session {
    let path = dir.join("context.db");
    ContextDb::create_for_tests(&path).unwrap();
    let db = Arc::new(ContextDb::open(&path).unwrap());
    db.with_connection(|conn| {
        for (id, content) in [
            (1, "The parser handles quoted text in the parser module."),
            (2, "Zebra: quotes stay as written."),
        ] {
            conn.execute(
                "INSERT INTO memories(id, level, owner_id, category, origin_category, content,
                                      normalized_hash, first_seen_at, created_at, updated_at, last_seen_at)
                 VALUES(?1, 'project', 'test-project', 'swe:architecture', 'ARCHITECTURE',
                        ?2, ?3, 1, 1, 1, 1)",
                params![id, content, format!("h{id}")],
            )
            .unwrap();
        }
    });
    Session::tools_only(
        &Route {
            session: SessionRef::new("test", "mock", "rerank-module"),
            project: Some(Project {
                id: "test-project".into(),
                root: dir.to_string_lossy().into_owned(),
            }),
            workdir: None,
            agent_id: None,
        },
        Some(db),
    )
}

fn query() -> Value {
    json!({"query": "how does the parser treat quoted text", "sources": ["memory"]})
}

fn zebra_first(answer: &str) -> bool {
    let at = |needle| answer.find(needle).unwrap_or(usize::MAX);
    at("Zebra") < at("The parser handles")
}

fn calls_to(module: &str, methods: &[&str]) -> Vec<(String, String)> {
    methods
        .iter()
        .map(|method| (module.to_owned(), (*method).to_owned()))
        .collect()
}

#[tokio::test]
async fn by_default_the_local_synapse_is_called() {
    let dir = tempfile::tempdir().unwrap();
    let mut session = search_session(dir.path());
    let settings = Settings::default();
    assert_eq!(settings.rerank, Reranker::Synapse("synapse".into()));
    let client = Modules::serving(SYNAPSE_MODULE, 'a');
    // No other test pins the local module through the process's catalogs,
    // but start from no pin all the same.
    forget_synapse_pin(SYNAPSE_MODULE);
    let answer = session
        .tool(&client, &settings, "ctx_search", &query())
        .await
        .unwrap();
    assert!(zebra_first(&answer), "{answer}");
    assert_eq!(
        client.calls(),
        calls_to(SYNAPSE_MODULE, &["models.list", "rerank.score"])
    );
    forget_synapse_pin(SYNAPSE_MODULE);
}

/// A remote Synapse the user names is the only module asked, while it
/// scores and once it can't: a search it can't score keeps the ordinary
/// ranking and never turns to the local module, and the fallback is logged
/// once, not on every search.
#[tokio::test]
async fn a_named_remote_synapse_is_the_only_module_called() {
    let dir = tempfile::tempdir().unwrap();
    let mut session = search_session(dir.path());
    let mut plain = Settings {
        rerank: Reranker::Off,
        ..Settings::default()
    };
    let ordinary = session
        .tool(
            &Modules::serving(REMOTE, 'b'),
            &plain,
            "ctx_search",
            &query(),
        )
        .await
        .unwrap();
    assert!(!zebra_first(&ordinary), "{ordinary}");
    plain.rerank = Reranker::from_tiers(&json!({"rerank": {"module": REMOTE}}), &json!({}));
    let settings = plain;
    assert_eq!(settings.rerank, Reranker::Synapse(REMOTE.into()));

    let client = Modules::serving(REMOTE, 'b');
    let output = crate::test_log::capture();
    let answer = session
        .tool(&client, &settings, "ctx_search", &query())
        .await
        .unwrap();
    assert!(zebra_first(&answer), "{answer}");
    assert_eq!(
        client.calls(),
        calls_to(REMOTE, &["models.list", "rerank.score"])
    );

    // The remote computer goes away. The pin is still fresh, so the scores
    // are asked for and refused; then the catalog is asked and refused;
    // then the module is backed off and not asked at all.
    *client.serves.lock().unwrap() = None;
    for _ in 0..3 {
        let answer = session
            .tool(&client, &settings, "ctx_search", &query())
            .await
            .unwrap();
        assert_eq!(answer, ordinary);
    }
    assert_eq!(
        client.calls(),
        calls_to(
            REMOTE,
            &["models.list", "rerank.score", "rerank.score", "models.list"]
        )
    );
    let text = output.text();
    assert_eq!(
        text.matches(&format!("from Synapse module {REMOTE}; keeping"))
            .count(),
        1,
        "{text}"
    );
    assert!(
        !text.contains("from Synapse module synapse;"),
        "the local module was never involved: {text}"
    );
}
