//! The Synapse embedding provider against a stand-in Synapse, reached the
//! way the module reaches the real one: through a runner client's Synapse
//! calls ([`RunnerClient::synapse_embedding_call`]).

use std::collections::VecDeque;
use std::path::Path;

use super::*;
use crate::client::{Child, ClientError};
use crate::embedding::Provider;
use cortexkit_role_compaction::read::{Head, ReadPage, ReadRequest, SessionRef};
use cortexkit_role_compaction::view::{AppliedViewAnswer, ApplyViewAnswer, ApplyViewRequest};
use cortexkit_role_llm_runner::run::{RunResult, RunResultRequest};
use cortexkit_role_llm_runner::send::{SendReply, SendRequest};

const REMOTE: &str = "fed:0123456789abcdef0123456789abcdef:synapse";

/// A Synapse module named `module`. `models.list` answers with `catalog`
/// (refused as an unregistered module is while it is `None`); each vector
/// is `[bytes of the text, 1]`, so a test can tell which text it came from.
struct Fake {
    module: &'static str,
    catalog: Mutex<Option<Vec<Value>>>,
    /// Refusals each method gives before it answers, in order.
    refusals: Mutex<HashMap<&'static str, VecDeque<Refusal>>>,
    /// The fingerprint replies name instead of the required one.
    served: Mutex<Option<String>>,
    /// When set, `embed.batch` answers with a job whose rows `embed.result`
    /// pages this many at a time.
    page: Option<usize>,
    jobs: Mutex<HashMap<String, Vec<Value>>>,
    calls: Mutex<Vec<(String, String, Value)>>,
}

impl Fake {
    fn serving(rows: Vec<Value>) -> Arc<Self> {
        Arc::new(Self {
            module: "synapse",
            catalog: Mutex::new(Some(rows)),
            refusals: Mutex::default(),
            served: Mutex::default(),
            page: None,
            jobs: Mutex::default(),
            calls: Mutex::default(),
        })
    }

    fn refuse(&self, method: &'static str, refusal: Refusal) {
        self.refusals
            .lock()
            .unwrap()
            .entry(method)
            .or_default()
            .push_back(refusal);
    }

    /// The calls made, as (module, method).
    fn methods(&self) -> Vec<(String, String)> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .map(|(module, method, _)| (module.clone(), method.clone()))
            .collect()
    }

    /// The params of every call to `method`.
    fn params(&self, method: &str) -> Vec<Value> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, called, _)| called == method)
            .map(|(_, _, params)| params.clone())
            .collect()
    }

    fn answer(&self, method: &str, params: &Value) -> Result<Value, Refusal> {
        let fingerprint = self.served.lock().unwrap().clone().unwrap_or_else(|| {
            params["required_fingerprint"]
                .as_str()
                .unwrap_or("")
                .to_owned()
        });
        let vector = |text: &Value| json!([text.as_str().unwrap().len(), 1]);
        match method {
            "models.list" => match &*self.catalog.lock().unwrap() {
                Some(rows) => Ok(json!({"result": {"table_epoch": 2, "models": rows}})),
                None => Err(Refusal::new("unknown_module")),
            },
            "embed.query" => Ok(json!({"result": {
                "fingerprint": fingerprint,
                "table_epoch": 2,
                "vectors": [{"id": params["id"], "vector": vector(&params["text"])}],
            }})),
            "embed.batch" => {
                let rows: Vec<Value> = params["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|item| json!({"id": item["id"], "vector": vector(&item["text"])}))
                    .collect();
                if self.page.is_none() {
                    return Ok(
                        json!({"result": {"fingerprint": fingerprint, "table_epoch": 2, "vectors": rows}}),
                    );
                }
                let mut jobs = self.jobs.lock().unwrap();
                let job = format!("job-{}", jobs.len());
                jobs.insert(job.clone(), rows);
                Ok(json!({"result": {"job_id": job}}))
            }
            "embed.result" => {
                let rows = self.jobs.lock().unwrap()[params["job_id"].as_str().unwrap()].clone();
                let start = params["cursor"].as_u64().unwrap_or(0) as usize;
                let end = (start + self.page.unwrap()).min(rows.len());
                let next = if end < rows.len() {
                    json!(end)
                } else {
                    Value::Null
                };
                Ok(json!({"result": {
                    "fingerprint": fingerprint,
                    "table_epoch": 2,
                    "vectors": rows[start..end],
                    "next_cursor": next,
                }}))
            }
            _ => Err(Refusal::new("unknown_method")),
        }
    }
}

impl RunnerClient for Fake {
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

    async fn synapse_embedding_call(
        &self,
        module: &str,
        method: &str,
        params: Value,
        _timeout: Duration,
    ) -> Result<Value, Refusal> {
        self.calls
            .lock()
            .unwrap()
            .push((module.to_owned(), method.to_owned(), params.clone()));
        if module != self.module {
            return Err(Refusal::new("unknown_module"));
        }
        let queued = self
            .refusals
            .lock()
            .unwrap()
            .get_mut(method)
            .and_then(VecDeque::pop_front);
        match queued {
            Some(refusal) => Err(refusal),
            None => self.answer(method, &params),
        }
    }
}

/// A catalog row for lane `id`, with a fingerprint of 64 `fingerprint`s.
fn lane(id: &str, admitted: bool, fingerprint: char) -> Value {
    json!({
        "model_id": id,
        "serving_admission": if admitted { "enabled" } else { "disabled" },
        "fingerprints": [fingerprint.to_string().repeat(64)],
        "max_tokens": 8192,
    })
}

/// Lanes `-ane`, `-metal`, `-cuda` and `-vulkan` of `model`, admitted as
/// `admitted` says, with fingerprints `a` to `d`.
fn lanes(model: &str, admitted: [bool; 4]) -> Vec<Value> {
    LANE_ORDER
        .iter()
        .zip(admitted)
        .zip(['a', 'b', 'c', 'd'])
        .map(|((suffix, admitted), fingerprint)| {
            lane(&format!("{model}-{suffix}"), admitted, fingerprint)
        })
        .collect()
}

fn resolve(user: Value, project: Value) -> Option<Provider> {
    Provider::from_tiers(&user, &project, Path::new("/u"))
}

fn synapse(provider: Option<Provider>) -> Synapse {
    match provider {
        Some(Provider::Synapse(provider)) => provider,
        other => panic!("not a Synapse provider: {other:?}"),
    }
}

/// The default provider, calling `fake` through `link`.
fn linked(link: &Arc<Link>) -> Provider {
    resolve(json!({}), json!({}))
        .unwrap()
        .with_synapse_link(link)
}

#[test]
fn local_synapse_and_unset_resolve_to_synapse_and_off_to_none() {
    for user in [
        json!({}),
        json!({"embedding": {}}),
        json!({"embedding": {"provider": "local"}}),
        json!({"embedding": {"provider": "synapse"}}),
    ] {
        let provider = synapse(resolve(user.clone(), json!({})));
        assert_eq!(provider.module(), "synapse", "{user}");
        assert_eq!(provider.model(), DEFAULT_MODEL, "{user}");
    }
    let named = synapse(resolve(
        json!({"embedding": {"provider": "synapse", "model": "gte-modernbert-base", "module": REMOTE}}),
        json!({}),
    ));
    assert_eq!(
        (named.module(), named.model()),
        (REMOTE, "gte-modernbert-base")
    );
    assert!(resolve(json!({"embedding": {"provider": "off"}}), json!({})).is_none());
    assert!(resolve(
        json!({"embedding": {"provider": "off", "module": REMOTE}}),
        json!({"embedding": {"provider": "synapse"}})
    )
    .is_none());
}

#[test]
fn only_the_user_names_the_module_and_a_project_cannot() {
    // A project can't pick a module, nor switch the provider, whatever the
    // user chose.
    for user in [json!({}), json!({"embedding": {"provider": "local"}})] {
        let provider = synapse(resolve(
            user,
            json!({"embedding": {"provider": "synapse", "module": REMOTE}}),
        ));
        assert_eq!(provider.module(), "synapse");
    }
    let provider = synapse(resolve(
        json!({"embedding": {"module": REMOTE}}),
        json!({"embedding": {"module": "fed:ffffffffffffffffffffffffffffffff:synapse"}}),
    ));
    assert_eq!(provider.module(), REMOTE);
    let endpoint = resolve(
        json!({}),
        json!({"embedding": {"provider": "openai-compatible", "endpoint": "https://e.invalid/v1", "model": "m"}}),
    );
    assert!(
        matches!(endpoint, Some(Provider::Synapse(_))),
        "{endpoint:?}"
    );
    // A malformed module keeps the default, and the user's file says so.
    let user = json!({"embedding": {"module": "fed:ABC:synapse"}});
    assert_eq!(
        synapse(resolve(user.clone(), json!({}))).module(),
        "synapse"
    );
    assert!(crate::search::rerank::module_note(&user, "embedding")
        .unwrap()
        .starts_with("embedding.module must be a module id"));
}

#[tokio::test]
async fn an_endpoint_is_served_as_before() {
    let provider = resolve(
        json!({"embedding": {"provider": "openai-compatible", "endpoint": "https://api.voyageai.com/v1/", "model": "voyage-4", "api_key": "k", "input_type": "document", "query_input_type": "query", "max_input_tokens": 8192}}),
        json!({}),
    )
    .unwrap();
    assert!(matches!(provider, Provider::Http(_)));
    // The identity the plugin derives for this configuration.
    assert_eq!(
        provider.model_id(),
        "embedding-provider:fe1e3cf9119cf8e4c7667b9d6c0fb057"
    );
    assert_eq!(provider.serving_model_id(), Some(provider.model_id()));
    // A link changes nothing for an endpoint.
    let fake = Fake::serving(lanes(DEFAULT_MODEL, [true; 4]));
    let linked = provider
        .clone()
        .with_synapse_link(&Link::over(Arc::clone(&fake)));
    assert!(linked.prepare().await);
    assert_eq!(linked.model_id(), provider.model_id());
    assert!(fake.methods().is_empty());
}

#[test]
fn a_lane_identity_is_049s() {
    // `getSynapseLaneIdentity("gte-modernbert-base-f16", "abc")` in the
    // 0.49 plugin.
    assert_eq!(
        identity("gte-modernbert-base-f16", "abc"),
        "synapse:v1:dae8d92beb38c1d81a5e52f9c16a4829749853ff4df73dbccde8377a8b1c7c20"
    );
}

#[tokio::test]
async fn the_first_admitted_lane_in_order_is_pinned() {
    let mut rows = vec![
        lane("qwen3-embedding-0.6b-vulkan", true, 'd'),
        lane("qwen3-embedding-0.6b-ane", false, 'a'),
        lane("qwen3-embedding-0.6b-cuda", true, 'c'),
        lane("qwen3-embedding-0.6b-metal", true, 'b'),
        lane("gte-modernbert-base-ane", true, 'e'),
        lane("gte-reranker-modernbert-base-metal", true, 'f'),
    ];
    for (expected, fingerprint) in [("metal", 'b'), ("cuda", 'c'), ("vulkan", 'd')] {
        let fake = Fake::serving(rows.clone());
        let provider = linked(&Link::over(Arc::clone(&fake)));
        assert_eq!(provider.model_id(), PENDING, "nothing is pinned yet");
        let provider = provider.unbound();
        assert_eq!(
            provider.embed_query("where is the parser").await,
            Some(vec![(QUERY_INSTRUCTION.len() + 19) as f32, 1.0])
        );
        let lane_id = format!("qwen3-embedding-0.6b-{expected}");
        let fingerprint = fingerprint.to_string().repeat(64);
        let request = &fake.params("embed.query")[0];
        assert_eq!(request["model"], lane_id);
        assert_eq!(request["required_fingerprint"], fingerprint);
        assert_eq!(request["required_epoch"], 2);
        assert_eq!(request["allow_equivalent"], false);
        assert_eq!(provider.model_id(), identity(&lane_id, &fingerprint));
        // Remove the pinned lane; the next run of the test takes the next one.
        rows.retain(|row| row["model_id"] != lane_id.as_str());
    }
}

#[tokio::test]
async fn a_reply_from_another_fingerprint_is_refused() {
    let fake = Fake::serving(lanes(DEFAULT_MODEL, [true; 4]));
    let link = Link::over(Arc::clone(&fake));
    let provider = linked(&link);
    assert!(provider.prepare().await);
    let pinned = provider.model_id();
    assert_eq!(
        pinned,
        identity("qwen3-embedding-0.6b-ane", &"a".repeat(64))
    );
    *fake.served.lock().unwrap() = Some("e".repeat(64));
    let output = crate::test_log::capture();
    assert_eq!(provider.embed_query("query").await, None);
    assert_eq!(provider.embed_documents(&["memory".into()]).await, None);
    assert!(
        output
            .text()
            .contains("ck-mc: a Synapse reply had a different fingerprint than the lane's; the vectors are refused method=embed.query"),
        "{}",
        output.text()
    );
    // The provider keeps the identity it read with; the link stops using the lane.
    assert_eq!(provider.model_id(), pinned);
    assert_eq!(linked(&link).serving_model_id(), None);
}

#[tokio::test]
async fn the_query_instruction_goes_on_queries_only_and_inputs_fit_the_lane() {
    let fake = Fake::serving(lanes(DEFAULT_MODEL, [true; 4]));
    let provider = linked(&Link::over(Arc::clone(&fake)));
    assert!(provider
        .embed_search_query("how are retries bounded")
        .await
        .is_some());
    let long = "x".repeat(40_000);
    let texts = vec!["The store is SQLite.".to_owned(), String::new(), long];
    let vectors = provider.embed_documents(&texts).await.unwrap();
    assert_eq!(
        fake.params("embed.query")[0]["text"],
        format!("{QUERY_INSTRUCTION}how are retries bounded")
    );
    let items = fake.params("embed.batch")[0]["items"].clone();
    assert_eq!(items[0]["text"], "The store is SQLite.");
    // A blank text goes as one space, and nothing is longer than the lane
    // takes: Synapse refuses a longer input rather than cutting it.
    assert_eq!(items[1]["text"], " ");
    assert_eq!(items[2]["text"].as_str().unwrap().len(), 8192 - 16);
    assert_eq!(
        vectors,
        vec![
            Some(vec![20.0, 1.0]),
            Some(vec![1.0, 1.0]),
            Some(vec![(8192 - 16) as f32, 1.0])
        ]
    );
    for item in items.as_array().unwrap() {
        assert!(!item["text"].as_str().unwrap().starts_with("Instruct:"));
    }
    // History is chunked within the lane's limit, whatever the user asks for.
    assert_eq!(provider.chunk_max_input_tokens(), 512);
    let large = resolve(
        json!({"embedding": {"max_input_tokens": 100_000}}),
        json!({}),
    )
    .unwrap()
    .with_synapse_link(&Link::over(fake));
    assert!(large.prepare().await);
    assert_eq!(large.chunk_max_input_tokens(), (8192 - 16) / 4);
}

#[tokio::test]
async fn batch_results_are_paged_through_embed_result() {
    let mut rows = lanes(DEFAULT_MODEL, [true; 4]);
    rows[0]["recommended_batch"] = json!(3);
    let fake = Arc::new(Fake {
        page: Some(2),
        ..Arc::into_inner(Fake::serving(rows)).unwrap()
    });
    let provider = linked(&Link::over(Arc::clone(&fake)));
    let texts: Vec<String> = ["a", "bb", "ccc", "dddd", "eeeee"]
        .iter()
        .map(|text| (*text).to_owned())
        .collect();
    let vectors = provider.embed_documents(&texts).await.unwrap();
    assert_eq!(
        vectors,
        (1..=5)
            .map(|bytes| Some(vec![bytes as f32, 1.0]))
            .collect::<Vec<_>>()
    );
    // Two batches of at most three, each paged two rows at a time.
    let methods: Vec<String> = fake
        .methods()
        .into_iter()
        .map(|(_, method)| method)
        .collect();
    assert_eq!(
        methods,
        [
            "models.list",
            "embed.batch",
            "embed.result",
            "embed.result",
            "embed.batch",
            "embed.result",
        ]
    );
    let cursors: Vec<Value> = fake
        .params("embed.result")
        .iter()
        .map(|params| params["cursor"].clone())
        .collect();
    assert_eq!(cursors, [Value::Null, json!(2), Value::Null]);
    for params in fake.params("embed.result") {
        assert_eq!(params["required_fingerprint"], "a".repeat(64));
        assert!(params["request_key"]
            .as_str()
            .is_some_and(|key| key.len() == 64));
    }
}

#[tokio::test]
async fn model_loading_is_waited_out_within_the_timeout() {
    let fake = Fake::serving(lanes(DEFAULT_MODEL, [true; 4]));
    let link = Link::over(Arc::clone(&fake));
    let loading = Refusal {
        code: "model_loading".into(),
        retry_after: Some(Duration::from_millis(20)),
    };
    fake.refuse("embed.query", loading.clone());
    fake.refuse("embed.query", loading.clone());
    assert!(linked(&link).embed_search_query("query").await.is_some());
    assert_eq!(fake.params("embed.query").len(), 3);
    // A wait longer than the search's budget ends the search instead.
    fake.refuse(
        "embed.query",
        Refusal {
            code: "model_loading".into(),
            retry_after: Some(Duration::from_secs(60)),
        },
    );
    let short =
        linked(&link).with_timeouts_for_test(Duration::from_secs(30), Duration::from_millis(100));
    assert_eq!(
        short.embed_search_query_traced("query").await,
        (None, "timeout")
    );
}

/// Every unavailable cause: logged once with its fix, again only when the
/// cause changes, never on each search, and searches use words only.
#[tokio::test(start_paused = true)]
async fn each_unavailable_cause_is_logged_once_and_search_uses_words() {
    let output = crate::test_log::capture();
    let fake = Fake::serving(Vec::new());
    *fake.catalog.lock().unwrap() = None;
    let link = Link::over(Arc::clone(&fake));
    let search = || async {
        let (vector, outcome) = linked(&link).embed_search_query_traced("query").await;
        assert_eq!((vector, outcome), (None, "unavailable"));
        // A provider resolved afterwards has no lane either.
        assert_eq!(linked(&link).serving_model_id(), None);
    };
    let minute = || tokio::time::advance(Duration::from_secs(61));
    let no_module = "ck-mc: semantic search is off: the Synapse module does not answer, so search uses words only. To embed without Synapse, set an HTTP endpoint in `embedding` (provider \"openai-compatible\") module=synapse";
    for _ in 0..3 {
        search().await;
    }
    minute().await;
    search().await;
    assert_eq!(output.count(no_module), 1, "{}", output.text());
    // Within the minute the catalog is not asked again.
    assert_eq!(fake.params("models.list").len(), 2);

    // A GPU-less machine: the lane is listed but refuses.
    *fake.catalog.lock().unwrap() = Some(lanes(DEFAULT_MODEL, [true; 4]));
    for _ in 0..2 {
        fake.refuse("embed.query", Refusal::new("backend_unavailable"));
        minute().await;
        search().await;
        search().await;
    }
    let no_gpu = "the Synapse module has no supported GPU on this machine (backend_unavailable), so search uses words only. To embed without Synapse, set an HTTP endpoint in `embedding` (provider \"openai-compatible\") module=synapse";
    assert_eq!(output.count(no_gpu), 1, "{}", output.text());

    // The model not downloaded.
    fake.refuse("embed.query", Refusal::new("model_not_installed"));
    minute().await;
    search().await;
    search().await;
    let download = "the Synapse module has not downloaded the model (model_not_installed), so search uses words only. Download the model with `ck-synapse-opctl models download` module=synapse model=qwen3-embedding-0.6b download_size= (about 1.2 GB)";
    assert_eq!(output.count(download), 1, "{}", output.text());

    // No lane admitted.
    *fake.catalog.lock().unwrap() = Some(lanes(DEFAULT_MODEL, [false; 4]));
    for _ in 0..2 {
        minute().await;
        search().await;
    }
    let no_lane = "the Synapse module lists no lane for the model that admits requests, so search uses words only. Download the model with `ck-synapse-opctl models download`, or set an HTTP endpoint in `embedding` (provider \"openai-compatible\") module=synapse model=qwen3-embedding-0.6b download_size= (about 1.2 GB)";
    assert_eq!(output.count(no_lane), 1, "{}", output.text());
    // Each cause once, and no line on any single search.
    assert_eq!(
        output.count("semantic search is off"),
        4,
        "{}",
        output.text()
    );
    assert_eq!(output.count("WARN"), 0, "{}", output.text());

    // A lane comes back: search uses meaning again, and says so once. The
    // lane was named once, the first time it was pinned.
    *fake.catalog.lock().unwrap() = Some(lanes(DEFAULT_MODEL, [true; 4]));
    minute().await;
    assert!(linked(&link).embed_search_query("query").await.is_some());
    assert!(linked(&link).embed_search_query("query").await.is_some());
    assert_eq!(
        output.count("ck-mc: semantic search is on again: a Synapse lane is serving lane_id=qwen3-embedding-0.6b-ane module=synapse"),
        1,
        "{}",
        output.text()
    );
    assert_eq!(
        output.count("ck-mc: embeddings use a Synapse lane"),
        1,
        "{}",
        output.text()
    );
}

#[tokio::test(start_paused = true)]
async fn a_lane_change_is_a_new_identity() {
    let fake = Fake::serving(lanes(DEFAULT_MODEL, [true; 4]));
    let link = Link::over(Arc::clone(&fake));
    let before = linked(&link);
    assert!(before.prepare().await);
    let ane = before.model_id();
    assert_eq!(ane, identity("qwen3-embedding-0.6b-ane", &"a".repeat(64)));
    // The ANE lane stops admitting requests and refuses its fingerprint.
    *fake.catalog.lock().unwrap() = Some(lanes(DEFAULT_MODEL, [false, true, true, true]));
    fake.refuse("embed.query", Refusal::new("substitution_rejected"));
    let output = crate::test_log::capture();
    assert_eq!(before.embed_query("query").await, None);
    tokio::time::advance(Duration::from_secs(61)).await;
    let after = linked(&link);
    assert!(after.embed_query("query").await.is_some());
    let metal = after.model_id();
    assert_eq!(
        metal,
        identity("qwen3-embedding-0.6b-metal", &"b".repeat(64))
    );
    assert_ne!(metal, ane);
    assert_eq!(
        after.chunk_model_id().split(":chunk:").next(),
        Some(metal.as_str())
    );
    // The provider that read under the old lane keeps its id, so nothing it
    // saves mixes the lanes.
    assert_eq!(before.model_id(), ane);
    assert_eq!(
        output.count(
            "ck-mc: embeddings switched to a Synapse lane; vectors from the previous lane are set aside and upkeep embeds again in the background lane_id=qwen3-embedding-0.6b-metal module=synapse"
        ),
        1,
        "{}",
        output.text()
    );
}

#[tokio::test]
async fn a_model_synapse_does_not_list_falls_back_to_the_default() {
    let mut rows = lanes(DEFAULT_MODEL, [true; 4]);
    rows.extend(lanes("gte-modernbert-base", [false, true, true, true]));
    // 0.49's local model, and 0.49's Synapse lane that was retired.
    for leftover in ["Xenova/all-MiniLM-L6-v2", "gte-modernbert-base-f16"] {
        let fake = Fake::serving(rows.clone());
        let link = Link::over(Arc::clone(&fake));
        let output = crate::test_log::capture();
        for _ in 0..2 {
            let provider = resolve(json!({"embedding": {"model": leftover}}), json!({}))
                .unwrap()
                .with_synapse_link(&link);
            assert!(provider.embed_query("query").await.is_some(), "{leftover}");
            assert_eq!(
                provider.model_id(),
                identity("qwen3-embedding-0.6b-ane", &"a".repeat(64)),
                "{leftover}"
            );
        }
        assert_eq!(
            fake.params("embed.query")[0]["model"],
            "qwen3-embedding-0.6b-ane"
        );
        let ignored = format!("ck-mc: embedding.model is not an embedding model listed by the Synapse module; using the default instead model=\"{leftover}\" module=synapse fallback_model=qwen3-embedding-0.6b");
        assert_eq!(output.count(&ignored), 1, "{}", output.text());
    }
    // A model the catalog lists is used as named.
    let fake = Fake::serving(rows);
    let provider = resolve(
        json!({"embedding": {"model": "gte-modernbert-base"}}),
        json!({}),
    )
    .unwrap()
    .with_synapse_link(&Link::over(Arc::clone(&fake)));
    assert!(provider.prepare().await);
    assert_eq!(
        provider.model_id(),
        identity("gte-modernbert-base-metal", &"b".repeat(64))
    );
}

/// Upkeep reads ids before it embeds, so the lane is learned first: the
/// first round already embeds, under the lane's identity.
#[tokio::test]
async fn upkeep_embeds_memories_on_its_first_round() {
    let dir = tempfile::tempdir().unwrap();
    let db =
        crate::context_db::ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO memories (level, owner_id, category, origin_category, content, normalized_hash, status, \
             first_seen_at, created_at, updated_at, last_seen_at) \
             VALUES ('project', 'pj', 'swe:architecture', 'ARCHITECTURE', 'The store is SQLite.', 'h', 'active', 1, 1, 1, 1)",
            [],
        )
        .unwrap();
    });
    let fake = Fake::serving(lanes(DEFAULT_MODEL, [false, false, true, true]));
    let plan = crate::upkeep::Plan {
        memory: true,
        embedding: Some(linked(&Link::over(Arc::clone(&fake)))),
        git: None,
    };
    let report = crate::upkeep::run_project(&db, "pj", dir.path(), &plan, &|| 1_000).await;
    assert_eq!(report.memories_embedded, 1);
    let model: String = db.with_connection(|conn| {
        conn.query_row("SELECT model_id FROM memory_embeddings", [], |row| {
            row.get(0)
        })
        .unwrap()
    });
    assert_eq!(
        model,
        identity("qwen3-embedding-0.6b-cuda", &"c".repeat(64))
    );
}

#[tokio::test]
async fn user_provider_upkeep_refreshes_workspace_vectors_for_each_model_identity() {
    use crate::memory_levels::Authority;
    use crate::memory_writes::Writer;
    use crate::search::sources::{search_memories, MemoryOwners, Semantic};

    let dir = tempfile::tempdir().unwrap();
    let db =
        crate::context_db::ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
    let save = |project: &str, workspace: &str, content: &str| {
        let authority = Authority {
            project_id: Some(project.into()),
            workspace_id: Some(workspace.into()),
            profile: None,
            state: "resolved".into(),
            snapshot_digest: None,
            category_ids: [("CONSTRAINTS".into(), "swe:constraints".into())].into(),
            category_levels: [("swe:constraints".into(), vec!["workspace".into()])].into(),
        };
        let who = Writer {
            harness: "mock",
            session: "s",
            project,
            authority: Some(&authority),
            line: None,
        };
        db.with_connection(|conn| {
            let reply = crate::memory_tool::run(conn, &who, &json!({"action": "write", "level": "workspace", "category": "CONSTRAINTS", "content": content})).unwrap();
            assert!(reply.starts_with("Saved workspace memory"), "{reply}");
        });
    };
    let text = "Use the narrow bridge for deliveries.";
    save("pj-source", "team", text);
    save("pj-other", "other-team", "Keep emergency exits clear.");
    let mut old_model = None;
    for serving in [[false, false, true, true], [true, true, true, true]] {
        let fake = Fake::serving(lanes(DEFAULT_MODEL, serving));
        let provider = linked(&Link::over(Arc::clone(&fake)));
        let plan = crate::upkeep::Plan {
            memory: true,
            embedding: Some(provider.clone()),
            git: None,
        };
        let report =
            crate::upkeep::run_project(&db, "pj-source", dir.path(), &plan, &|| 1_000).await;
        assert_eq!(report.memories_embedded, 0);
        assert!(fake.params("embed.batch").is_empty());
        let user = crate::pass::Settings {
            embedding: Some(provider.clone()),
            ..Default::default()
        };
        assert_eq!(crate::upkeep::run_workspace(&db, &user).await, 2);
        let model = provider.model_id();
        assert_ne!(old_model.as_ref(), Some(&model));
        old_model = Some(model.clone());
        let paraphrase = "routing shipments";
        let vector = provider.embed_search_query(paraphrase).await.unwrap();
        let find = |semantic| {
            db.with_connection(|conn| {
                search_memories(
                    conn,
                    MemoryOwners {
                        project: None,
                        workspace: Some("team"),
                    },
                    paraphrase,
                    10,
                    &Default::default(),
                    None,
                    semantic,
                    None,
                )
                .0
            })
        };
        assert!(find(None).is_empty());
        let hits = find(Some(Semantic {
            vector: &vector,
            model_id: &model,
            chunk_model_id: &model,
        }));
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].content, text);
        let calls = fake.params("embed.batch");
        let texts: std::collections::BTreeSet<_> = calls[0]["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["text"].as_str().unwrap())
            .collect();
        assert_eq!(texts, [text, "Keep emergency exits clear."].into());
    }
}

#[tokio::test]
async fn automatic_search_caps_the_deadline_sent_to_synapse() {
    use cortexkit_role_compaction::rules::{EditCost, ProviderRules, SignedParts};
    use cortexkit_role_compaction::setup::{ModelRef, SetupRequest};

    let dir = tempfile::tempdir().unwrap();
    let db = Arc::new(
        crate::context_db::ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap(),
    );
    let fake = Fake::serving(lanes(DEFAULT_MODEL, [true; 4]));
    let provider = linked(&Link::over(Arc::clone(&fake)));
    let session = crate::session::Session::new(
        &crate::route::Route {
            session: SessionRef::new("test", "mock", "s"),
            project: None,
            workdir: None,
            agent_id: None,
        },
        &SetupRequest::new(
            "head",
            ModelRef::new("test", "test"),
            100_000,
            1_000,
            ProviderRules::new(SignedParts::None, EditCost::Suffix),
            Vec::new(),
            1,
        ),
        crate::preset::Features {
            auto_memory: true,
            ..crate::preset::Features::NONE
        },
        Some(db),
    );
    let mut settings = crate::pass::Settings {
        embedding: Some(provider),
        ..Default::default()
    };
    settings.auto_search.enabled = true;
    settings.auto_search.min_prompt_chars = 1;
    session
        .pre_user(
            &settings,
            "How do workspace facts reach the semantic search index?",
            1,
        )
        .await;
    let calls = fake.params("embed.query");
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["deadline_ms"], 200);
}
