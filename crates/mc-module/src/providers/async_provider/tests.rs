use super::*;
use cortexkit_bus_inmemory::{InMemoryBus, InMemoryConfig};
mod broca_tag_rows;
mod conversation_identity_probe;
mod descriptors_read;
mod full_array_setup;
mod moved_session;
mod offline_first_pass;
mod published_contract;
mod read_outcomes;
mod read_resume;
mod reminder_replay;
mod reminders;
mod reply_shape;
mod route_identity_vectors;
mod setup_checkpoint;
mod user_commands_tests;
mod wrapup;

#[tokio::test]
async fn app_search_real_setup_without_project_membership() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    let state = rig.state();
    let namespace = state.namespace();
    let context = rusqlite::Connection::open(dir.path().join("context.db")).unwrap();
    let store = rusqlite::Connection::open(dir.path().join("store.db")).unwrap();
    assert!(!context
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM session_projects WHERE session_id='s')",
            [],
            |r| r.get::<_, bool>(0)
        )
        .unwrap());
    context.execute("INSERT INTO message_history_fts(session_id,message_ordinal,message_id,role,content) VALUES(?1,1,'real-message','assistant','needle')", [&namespace]).unwrap();
    context
        .execute(
            "INSERT INTO message_fts_rowid_map VALUES(?1,1,?2,10)",
            rusqlite::params![namespace, context.last_insert_rowid()],
        )
        .unwrap();
    context.execute_batch("INSERT INTO session_meta(session_id,harness) VALUES('anchor','opencode'); INSERT INTO session_projects VALUES('anchor','opencode','git:project',1)").unwrap();
    let call = |params: Value| {
        response(crate::app_read::search::search_for_test(
            &context, &store, &params,
        ))
    };
    let session = call(
        json!({"query":"needle","scope":{"session":{"runner":state.key.runner,"harness":state.key.harness,"session":state.key.session}}}),
    );
    assert_eq!(session["hits"].as_array().unwrap().len(), 1, "{session}");
    assert_eq!(session["hits"][0]["message_id"], "real-message");
    assert_eq!(session["hits"][0]["project"], Value::Null);
    assert_eq!(
        session["diagnostics"]["project_resolution"]["reason"],
        "project_identity_not_recorded"
    );
    for source in ["memory", "git_commit", "primer"] {
        assert_eq!(session["source_status"][source], "unavailable");
    }
    let project =
        call(json!({"query":"needle","scope":{"project":"git:project"},"sources":["message"]}));
    assert!(project["hits"].as_array().unwrap().is_empty());
}

#[derive(Default)]
struct Runner {
    /// The session runner module the conversation was admitted under.
    module: String,
    entries: Mutex<Vec<ReadMessage>>,
    lineage: Mutex<String>,
    read_delay_ms: std::sync::atomic::AtomicU64,
    routed_reads: std::sync::atomic::AtomicU64,
    sent: Mutex<Vec<Value>>,
    read_unavailable: std::sync::atomic::AtomicBool,
    read_gate: Mutex<Option<Arc<ReadGate>>>,
    reads: Mutex<Vec<Value>>,
    bind_identities: Mutex<Vec<session_resolver::RunnerBindIdentity>>,
    expected_bind_identity: Mutex<Option<session_resolver::RunnerBindIdentity>>,
    /// Messages per `session.read` page; 0 keeps the default of seven.
    page_size: std::sync::atomic::AtomicUsize,
    /// Leave llm-runner's `tag_checkpoint` group out of `role.describe`.
    withholds_tag_checkpoint: std::sync::atomic::AtomicBool,
    /// Every `role.describe` this runner answered.
    describes: std::sync::atomic::AtomicU64,
    /// A page to answer every `session.read` with, verbatim.
    page_override: Mutex<Option<Value>>,
    history_requests: Mutex<Vec<Value>>,
}

#[derive(Default)]
struct ReadGate {
    entered: tokio::sync::Notify,
    resume: tokio::sync::Notify,
}

#[async_trait]
impl session_resolver::ProviderRunner for Runner {
    async fn call_for(
        &self,
        route: &crate::route_targets::SessionRunnerRoute,
        project: &Path,
        method: &str,
        params: Value,
        budget: Duration,
    ) -> Result<Value, SessionResolveError> {
        if method == "session.read" {
            return Err(SessionResolveError::InvalidResponse(
                "session.read requires the full bind identity".into(),
            ));
        }
        self.call(project, route.parent_session(), method, params, budget)
            .await
    }

    async fn call_for_identity(
        &self,
        route: &crate::route_targets::SessionRunnerRoute,
        identity: &session_resolver::RunnerBindIdentity,
        method: &str,
        params: Value,
        budget: Duration,
    ) -> Result<Value, SessionResolveError> {
        assert_eq!(route.module_id(), self.module);
        assert_eq!(route.parent_session(), identity.session);
        self.bind_identities.lock().unwrap().push(identity.clone());
        if self
            .expected_bind_identity
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|expected| expected != identity)
        {
            return Err(SessionResolveError::InvalidResponse(
                "runner bind identity mismatch".into(),
            ));
        }
        if method == "session.read" {
            self.routed_reads
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        self.call(
            &identity.project_root,
            route.parent_session(),
            method,
            params,
            budget,
        )
        .await
    }
    async fn call(
        &self,
        _: &Path,
        _: &str,
        method: &str,
        params: Value,
        _: Duration,
    ) -> Result<Value, SessionResolveError> {
        if method == "session.send" {
            self.sent.lock().unwrap().push(params);
            return Ok(json!({"state":"pending","submission_id":"reminder"}));
        }
        if method == "role.describe" {
            self.describes
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            // A THALAMUS-style runner hosting compaction declares the tags
            // groups; `tag_checkpoint` only when this test leaves it in.
            let mut capabilities = vec!["delivery_order", "compaction", "tags"];
            if !self
                .withholds_tag_checkpoint
                .load(std::sync::atomic::Ordering::Relaxed)
            {
                capabilities.push("tag_checkpoint");
            }
            return Ok(
                json!({"majors":[{"version":"llm-runner/v1","ops":["role.describe","session.baseline","session.send","session.read","session.resolve"]}],"implementation_version":"fake","session_capabilities_from":"baseline","capabilities":capabilities}),
            );
        }
        if method == "session.head" {
            return Ok(json!({"first_ordinal":0}));
        }
        if method == "session.history" {
            self.history_requests.lock().unwrap().push(params.clone());
            let entries = self.entries.lock().unwrap();
            let start = if let Some(mid) = params["from_mid"].as_str() {
                entries
                    .iter()
                    .position(|entry| entry.mid == mid)
                    .ok_or_else(|| SessionResolveError::Refused {
                        code: "unknown_mid".into(),
                        message: "unknown history id".into(),
                    })?
            } else {
                params["cursor"].as_str().unwrap().parse::<usize>().unwrap()
            };
            let messages = entries
                .iter()
                .skip(start)
                .take(2)
                .map(|entry| json!({"mid":entry.mid,"written_at":1,"message":entry.message}))
                .collect::<Vec<_>>();
            let mut page = json!({"messages":messages,"lineage_id":"L"});
            if start + 2 < entries.len() {
                page["newer"] = json!((start + 2).to_string());
            }
            return Ok(page);
        }
        assert_eq!(method, "session.read");
        self.reads.lock().unwrap().push(params.clone());
        if let Some(page) = self.page_override.lock().unwrap().clone() {
            return Ok(page);
        }
        if self
            .read_unavailable
            .load(std::sync::atomic::Ordering::Relaxed)
        {
            return Err(SessionResolveError::Transport("runner unreachable".into()));
        }
        let gate = self.read_gate.lock().unwrap().take();
        if let Some(gate) = gate {
            gate.entered.notify_one();
            gate.resume.notified().await;
        }
        let delay = self
            .read_delay_ms
            .load(std::sync::atomic::Ordering::Relaxed);
        if delay > 0 {
            tokio::time::sleep(Duration::from_millis(delay)).await;
        }
        let lineage = self.lineage.lock().unwrap().clone();
        if params["lineage_id"]
            .as_str()
            .is_some_and(|held| held != lineage)
        {
            return Err(SessionResolveError::InvalidResponse(
                "lineage_changed".into(),
            ));
        }
        let from = params["from_ordinal"]
            .as_u64()
            .expect("range read, never tail");
        let entries = self.entries.lock().unwrap();
        let messages = entries
            .iter()
            .filter(|e| e.ordinal >= from)
            .take(
                match self.page_size.load(std::sync::atomic::Ordering::Relaxed) {
                    0 => 7,
                    size => size,
                },
            )
            .map(serve_descriptors)
            .collect::<Vec<_>>();
        let mut page = json!({"lineage_id":lineage,"messages":messages});
        if let Some(last) = messages
            .last()
            .filter(|last| entries.last().is_some_and(|end| end.ordinal > last.ordinal))
        {
            page["next_from_ordinal"] = json!(last.ordinal + 1);
        }
        Ok(page)
    }
}

/// A session resolver that resolves nothing and counts its lookups, so a
/// test can tell whether a facade took the harness's own resolution path.
#[derive(Default)]
struct CountingResolver {
    calls: std::sync::atomic::AtomicU64,
}

#[async_trait]
impl session_resolver::SessionResolver for CountingResolver {
    async fn resolve_session(
        &self,
        _: &Path,
        _: &str,
        _: &str,
    ) -> Result<Option<session_resolver::ResolvedSession>, SessionResolveError> {
        self.calls
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Ok(None)
    }
}

struct Rig {
    h: Arc<McHandler>,
    resolver: Arc<CountingResolver>,
    runner: Arc<Runner>,
    bus: Arc<InMemoryBus>,
    task: tokio::task::JoinHandle<()>,
    reference: String,
    module: String,
}
impl Drop for Rig {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn response(result: HandlerOutcome) -> Value {
    let HandlerOutcome::Response(bytes) = result else {
        panic!("{result:?}")
    };
    serde_json::from_slice(&bytes).unwrap()
}

impl Rig {
    async fn new(dir: &Path) -> Self {
        Self::open(
            dir,
            "thalamus-harness",
            "opencode",
            json!({"serializer_profile":"opencode-aisdk"}),
        )
        .await
    }
    /// A rig whose route is admitted under runner module `module` and whose
    /// conversation is set up for `harness` with plan `params`.
    async fn open(dir: &Path, module: &str, harness: &str, params: Value) -> Self {
        Self::open_bound(dir, module, "runner", "s", harness, params).await
    }

    async fn configured(
        dir: &Path,
        module: &str,
        bind_harness: &str,
        bind_session: &str,
        harness: &str,
        params: Value,
        configure: impl FnOnce(&mut McHandler),
    ) -> Self {
        Self::setup_with_model(
            dir,
            module,
            (bind_harness, bind_session),
            (harness, "s"),
            "fixture",
            params,
            configure,
        )
        .await
    }

    async fn open_with_model(
        dir: &Path,
        module: &str,
        harness: &str,
        model: &str,
        params: Value,
        configure: impl FnOnce(&mut McHandler),
    ) -> Self {
        Self::setup_with_model(
            dir,
            module,
            ("runner", "s"),
            (harness, "s"),
            model,
            params,
            configure,
        )
        .await
    }

    async fn open_bound(
        dir: &Path,
        module: &str,
        bind_harness: &str,
        bind_session: &str,
        harness: &str,
        params: Value,
    ) -> Self {
        Self::configured(
            dir,
            module,
            bind_harness,
            bind_session,
            harness,
            params,
            |_| {},
        )
        .await
    }

    async fn setup_with_model(
        dir: &Path,
        module: &str,
        bind: (&str, &str),
        setup: (&str, &str),
        model: &str,
        params: Value,
        configure: impl FnOnce(&mut McHandler),
    ) -> Self {
        let (rig, answer) =
            Self::try_setup_with_model(dir, module, bind, setup, model, params, configure).await;
        assert_eq!(answer["answer"], "ready", "{answer}");
        assert_eq!(answer["ceiling"]["at_share"], 0.95);
        rig
    }

    /// Build the rig and send its setup, returning the setup answer whatever it is.
    async fn try_setup_with_model(
        dir: &Path,
        module: &str,
        bind: (&str, &str),
        setup: (&str, &str),
        model: &str,
        params: Value,
        configure: impl FnOnce(&mut McHandler),
    ) -> (Self, Value) {
        let (bind_harness, bind_session) = bind;
        let (setup_harness, setup_session) = setup;
        let descriptor = StorageDescriptor {
            module_id: DEFAULT_MODULE_ID.into(),
            storage_namespace: "mc_cache".into(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: dir.join("store.db").to_string_lossy().into(),
            },
        };
        let store = Arc::new(McStore::open_for_test(&descriptor).unwrap());
        let runner = Arc::new(Runner {
            module: module.into(),
            lineage: Mutex::new("L".into()),
            ..Default::default()
        });
        let mut h = McHandler::new();
        h.producer_factory =
            crate::providers::session_runner_fake::FakeSessionRunner::for_project(dir).factory();
        h.store.set(store).ok().unwrap();
        h.provider_runner = runner.clone();
        let resolver = Arc::new(CountingResolver::default());
        h.session_resolver = resolver.clone();
        let config = McModuleConfig {
            inject_docs: false,
            protected_tokens_user: Some(0),
            protected_tools: BTreeMap::new(),
            ..Default::default()
        };
        h.fixed_config = Some(config.clone());
        h.bind_route(
            7,
            SessionBinding {
                principal: Some(subc_protocol::Principal::Reserved {
                    module_id: module.into(),
                }),
                scope: None,
                project_root: dir.into(),
                harness: bind_harness.into(),
                session: bind_session.into(),
                model_key: None,
                config,
                history_budget_tokens: 4_000.0,
            },
        );
        configure(&mut h);
        let h = Arc::new(h);
        let bus = Arc::new(InMemoryBus::new(
            InMemoryConfig::default().with_durable(DurableOwner::Module(DEFAULT_MODULE_ID)),
        ));
        let task = h
            .clone()
            .start_compaction_bus(bus.clone(), "fixture".into())
            .await
            .unwrap();
        let reference = runner_session_ref(module, setup_harness, setup_session);
        let rig = Self {
            h,
            resolver,
            runner,
            bus,
            task,
            reference,
            module: module.into(),
        };
        let answer = rig
            .op(
                "compaction.setup",
                json!({"session":setup_session,"harness":setup_harness,"request_id":"setup","model":model,"context_window":100_000,"composition":{"render_tags":true},"params":params,"lineage_id":"L","now":1}),
            )
            .await;
        (rig, answer)
    }
    async fn op(&self, method: &str, params: Value) -> Value {
        response(
            self.h
                .dispatch_value(7, json!({"method":method,"params":params}))
                .await,
        )
    }
    fn state(&self) -> State {
        load(self.h.store.get().unwrap(), &self.reference)
            .unwrap()
            .unwrap()
    }
    fn pending_targets(&self) -> Vec<String> {
        self.h
            .store
            .get()
            .unwrap()
            .load_pending_agent_drops(&self.state().namespace())
            .unwrap()
            .into_iter()
            .map(|drop| drop.target_id)
            .collect()
    }
    async fn queue(&self, numbers: &[u64]) {
        let drop = numbers
            .iter()
            .map(u64::to_string)
            .collect::<Vec<_>>()
            .join(",");
        let answer = response(
            self.h
                .dispatch_value(7, json!({"name":"ctx_reduce","arguments":{"drop":drop}}))
                .await,
        );
        assert_ne!(answer["isError"], true, "{answer}");
        assert!(
            !self
                .h
                .store
                .get()
                .unwrap()
                .load_pending_agent_drops(&self.state().namespace())
                .unwrap()
                .is_empty(),
            "the public ctx_reduce route must enqueue engine work"
        );
    }
    fn fill(&self, count: u64) {
        *self.runner.entries.lock().unwrap()=(0..count).map(|n| {
            let part=if n%5>0 && n%5<4 {
                json!({"id":format!("p{n}"),"type":"tool","tool":"read","callID":format!("call{n}"),"state":{"status":"completed","input":{"path":format!("file{n}")},"output":"exact spent output ".repeat(500)}})
            } else {json!({"id":format!("p{n}"),"type":"text","text":format!("message {n} ")+&"durable words ".repeat(16)})};
            ReadMessage::new(n,format!("m{n}"),json!({"info":{"id":format!("m{n}"),"role":if n%5==0{"user"}else{"assistant"},"time":{"created":1}},"parts":[part]})).with_tags(vec![tags::PartTag::tagged("0",format!("§{}§",100+n*3))])
        }).collect();
    }
    async fn notice_with_descent(
        &self,
        seq: u64,
        size: u64,
        applied: Option<u64>,
        descent: Option<String>,
    ) {
        self.notice_with(seq, size, applied, descent, Vec::new())
            .await;
    }
    /// Publish advance notice `seq` with the runner's `events` and wait for
    /// the provider to finish ingesting it.
    async fn notice_with(
        &self,
        seq: u64,
        size: u64,
        applied: Option<u64>,
        descent: Option<String>,
        events: Vec<notice::Event>,
    ) {
        let last = self.runner.entries.lock().unwrap().last().cloned().unwrap();
        let mut notice = notice::AdvanceNotice::new(
            &self.reference,
            seq,
            self.runner.lineage.lock().unwrap().clone(),
            last.ordinal,
            contract::digest::content_digest(&last.message),
            size,
            "fixture",
        )
        .with_window(100_000);
        if let Some(version) = applied {
            notice = notice.with_applied_view_version(version);
        }
        if !events.is_empty() {
            notice = notice.with_events(events);
        }
        let mut headers = notice.to_headers();
        headers.insert(
            "lineage_id".into(),
            self.runner.lineage.lock().unwrap().clone(),
        );
        if let Some(descent) = descent {
            headers.insert("descends_from".into(), descent);
        }
        let notice = notice::AdvanceNotice::from_headers(&headers).unwrap();
        let receipt = self
            .bus
            .publish(
                &notice::event_subject("fixture", &self.module, notice::ADVANCED_EVENT),
                &bus_id(&self.reference, "advanced", seq),
                notice.digest().parse().unwrap(),
                headers,
            )
            .await
            .unwrap();
        assert!(!receipt.duplicate());
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if self.state().completed_seq >= seq
                    && !self.state().entries.is_empty()
                    && self
                        .h
                        .provider_store
                        .async_runtime
                        .completed_notice
                        .load(std::sync::atomic::Ordering::Relaxed)
                        >= seq
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("notice ingested");
    }
    async fn notice(&self, seq: u64, size: u64, applied: Option<u64>) {
        self.notice_with_descent(seq, size, applied, None).await;
    }
    fn newest(&self) -> Option<u64> {
        self.state().published_engine.keys().next_back().copied()
    }
    fn history(&self, end: u64, content: &str) {
        let namespace = self.state().namespace();
        let store = self.h.store.get().unwrap();
        store
            .replace_compartments(
                &namespace,
                &[mc_store::StoredCompartment {
                    sequence: 1,
                    start_message: 0,
                    end_message: end as i64,
                    end_message_id: format!("m{end}#0"),
                    title: "history".into(),
                    content: content.into(),
                    p1: Some(content.into()),
                    importance: 50,
                    ..Default::default()
                }],
            )
            .unwrap();
        store.arm_soft_refresh(&namespace).unwrap();
    }
    async fn get(&self, version: u64) -> view::CompactionView {
        let answer = self
            .op(
                "view.get",
                json!({"session_ref":self.reference,"view_version":version}),
            )
            .await;
        assert_eq!(answer["answer"], "view");
        decode(&answer["view"]).unwrap()
    }
    async fn ride(&self, cause: &str) -> Option<view::CompactionView> {
        let answer = self
            .op(
                "compaction.ride",
                json!({"session_ref":self.reference,"cause":cause,"deadline_ms":10_000}),
            )
            .await;
        if answer["answer"] == "view" {
            Some(decode(&answer["view"]).unwrap())
        } else {
            None
        }
    }
    fn render(&self, view: &view::CompactionView) -> Vec<u8> {
        assert_eq!(independent_digest(view), view.digest);
        let entries = self.runner.entries.lock().unwrap();
        let mut output = Vec::new();
        for range in &view.ranges {
            match range {
                view::ViewRange::Replace { bytes, .. } => {
                    output.extend(serde_json::from_str::<Vec<Value>>(bytes).unwrap())
                }
                view::ViewRange::Keep { from, to, edits } => {
                    for entry in entries
                        .iter()
                        .filter(|e| e.ordinal >= *from && e.ordinal < *to)
                    {
                        let mut message = entry.message.clone();
                        let mut rendered = Vec::new();
                        for (part, row) in parts(&entry.message).unwrap().iter().zip(&entry.tags) {
                            let edit = edits
                                .iter()
                                .find(|e| e.ordinal == entry.ordinal && e.part == row.part);
                            match edit {
                                Some(edit) if edit.drop => {}
                                Some(edit) => rendered.push(
                                    serde_json::from_str(edit.bytes.as_ref().unwrap()).unwrap(),
                                ),
                                None => {
                                    let mut part = part.clone();
                                    if let Some(tag) = &row.tag {
                                        let pointer = if part["type"] == "tool" {
                                            "/state/output"
                                        } else {
                                            "/text"
                                        };
                                        let text = part.pointer_mut(pointer).unwrap();
                                        *text = json!(format!("{tag} {}", text.as_str().unwrap()));
                                    }
                                    rendered.push(part);
                                }
                            }
                        }
                        message["parts"] = json!(rendered);
                        output.push(message);
                    }
                }
                _ => panic!("unknown range kind"),
            }
        }
        for entry in entries
            .iter()
            .filter(|e| e.ordinal > view.covers_through.ordinal)
        {
            output.push(entry.message.clone());
        }
        serde_json::to_vec(&output).unwrap()
    }
}

fn independent_digest(view: &view::CompactionView) -> String {
    let mut fields = vec![
        "ck.compaction.view.v1".into(),
        view.session_ref.clone(),
        view.view_version.to_string(),
        view.lineage_id.clone(),
        view.covers_through.ordinal.to_string(),
        view.covers_through.mid.clone(),
        view.ranges.len().to_string(),
    ];
    for range in &view.ranges {
        match range {
            view::ViewRange::Replace { from, to, bytes } => fields.extend([
                "replace".into(),
                from.to_string(),
                to.to_string(),
                bytes.clone(),
            ]),
            view::ViewRange::Keep { from, to, edits } => {
                fields.extend([
                    "keep".into(),
                    from.to_string(),
                    to.to_string(),
                    edits.len().to_string(),
                ]);
                for edit in edits {
                    fields.extend([
                        edit.ordinal.to_string(),
                        edit.mid.clone(),
                        edit.part.clone(),
                    ]);
                    if edit.drop {
                        fields.push("drop".into());
                    } else {
                        fields.extend(["bytes".into(), edit.bytes.clone().unwrap()]);
                    }
                }
            }
            _ => panic!("unknown range kind"),
        }
    }
    if let Some(cut) = &view.cut {
        fields.extend([
            "cut".into(),
            cut.cut_id.clone(),
            cut.through_ordinal.to_string(),
        ]);
    }
    if let Some(ttl) = &view.cache_ttl {
        fields.extend([
            "cache_ttl".into(),
            ttl.model.clone(),
            ttl.ms.map_or_else(|| "null".into(), |ms| ms.to_string()),
            ttl.configured.to_string(),
        ]);
    }
    let mut hash = sha2::Sha256::new();
    for field in fields {
        hash.update((field.len() as u64).to_be_bytes());
        hash.update(field.as_bytes());
    }
    format!("{:x}", hash.finalize())
}

#[tokio::test]
async fn defer_never_publishes_and_runner_tags_are_not_allocated() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(40);
    rig.notice(1, 1000, None).await;
    assert_eq!(rig.newest(), None, "defer must not publish");
    let state = rig.state();
    assert_eq!(
        tag_rows(&state, codec::Codec::OpencodeAiSdk).unwrap().len(),
        40,
        "all runner parts must be indexed"
    );
    let rows = rig
        .h
        .store
        .get()
        .unwrap()
        .load_tags_for_session(&state.namespace())
        .unwrap();
    assert_eq!(
        rows.iter()
            .map(|row| row.tag_number)
            .collect::<BTreeSet<_>>(),
        (0..40).map(|n| 100 + n * 3).collect()
    );
    rig.history(20, "first completed historian summary");
    rig.notice(2, 1_000, None).await;
    let baseline = rig.newest().expect("new history publishes");
    rig.queue(&[163, 166, 169]).await;
    rig.notice(3, 90_000, Some(baseline)).await;
    let version = rig.newest().expect("execute threshold publishes");
    assert!(
        version > baseline,
        "queued reductions publish at execute threshold"
    );
    let view = rig.get(version).await;
    let bytes = rig.render(&view);
    rig.notice(4, 1000, Some(version)).await;
    assert_eq!(rig.newest(), Some(version));
    assert_eq!(
        rig.render(&view),
        bytes,
        "defer replays byte-identical rendered request"
    );
}

#[tokio::test]
async fn long_session_history_ride_ceiling_resync_and_restart() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(40);
    rig.notice(1, 1_000, None).await;
    rig.history(20, "initial historian summary");
    rig.notice(2, 1_000, None).await;
    let baseline = rig.newest().expect("initial history publication");
    rig.queue(&[163, 166, 169]).await;
    rig.notice(3, 90_000, Some(baseline)).await;
    let first = rig.newest().unwrap();
    let _ = rig.render(&rig.get(first).await);
    let namespace = rig.state().namespace();
    let store = rig.h.store.get().unwrap();
    store
        .replace_compartments(
            &namespace,
            &[mc_store::StoredCompartment {
                sequence: 1,
                start_message: 0,
                end_message: 20,
                end_message_id: "m20#0".into(),
                title: "history".into(),
                content: "finished summary".into(),
                p1: Some("finished summary".into()),
                importance: 50,
                ..Default::default()
            }],
        )
        .unwrap();
    store.arm_soft_refresh(&namespace).unwrap();
    rig.notice(4, 1000, Some(first)).await;
    let history = rig.newest().unwrap();
    assert!(history > first);
    let view = rig.get(history).await;
    let _ = rig.render(&view);
    rig.history(20, "queued summary rides cache expiry");
    let ride = rig.ride("ttl_expired").await.expect("cache rebuild ride");
    assert!(ride.view_version > history);
    let _ = rig.render(&ride);
    rig.history(20, "queued summary rides ceiling");
    let ceiling = rig.ride("ceiling").await.expect("ceiling view");
    let _ = rig.render(&ceiling);
    let policy = CeilingPolicy::new(0.95, 10).with_on_overflow();
    assert_eq!(
        policy.decide(
            100_001,
            100_000,
            false,
            contract::ceiling::WaitEnd::TimedOut
        ),
        contract::ceiling::CeilingDecision::Refuse {
            cause: "over_window"
        }
    );
    *rig.runner.lineage.lock().unwrap() = "reverted".into();
    rig.fill(10);
    rig.notice(5, 1000, None).await;
    let restored = rig.newest().unwrap();
    assert!(restored > ceiling.view_version);
    assert_eq!(rig.get(restored).await.lineage_id, "reverted");
    let again = rig.get(restored).await;
    assert_eq!(
        serde_json::to_vec(&again).unwrap(),
        serde_json::to_vec(&rig.get(restored).await).unwrap(),
        "runner restart pulls identical immutable version"
    );
    let reserved = store
        .reserve_async_compaction_version(&rig.reference, restored)
        .unwrap();
    let next = store
        .reserve_async_compaction_version(&rig.reference, 0)
        .unwrap();
    assert!(next > reserved, "restart skips reserved versions");
}

#[tokio::test]
async fn old_notice_and_view_ids_collide_but_event_named_ids_do_not() {
    let bus = InMemoryBus::new(InMemoryConfig::default());
    let digest = ContentDigest::of_bytes(b"claim");
    assert!(!bus
        .publish(
            "ck.fixture.event.runner.compaction.advanced.v1",
            "abc:1",
            digest,
            BTreeMap::new()
        )
        .await
        .unwrap()
        .duplicate());
    assert!(bus
        .publish(
            "ck.fixture.event.magic-context.compaction.view_ready.v1",
            "abc:1",
            digest,
            BTreeMap::new()
        )
        .await
        .unwrap()
        .duplicate());
    for kind in ["advanced", "view_ready"] {
        assert!(!bus
            .publish(
                "ck.fixture.event.runner.compaction.advanced.v1",
                &bus_id("abc", kind, 1),
                digest,
                BTreeMap::new()
            )
            .await
            .unwrap()
            .duplicate());
    }
}

#[test]
fn part_edit_bytes_participate_in_digest() {
    let view = view::CompactionView::new(
        "00000000000000000000000000000000",
        1,
        "L",
        compact::lineage::MessageRef {
            ordinal: 0,
            mid: "m0".into(),
        },
        vec![view::ViewRange::keep_with_edits(
            0,
            1,
            vec![view::PartEdit::replace(
                0,
                "m0",
                "p0",
                "{\"text\":\"[dropped §100§]\"}",
            )],
        )],
    );
    let view = checked_async_view(view, codec::Codec::OwnedBroca, &Default::default())
        .unwrap()
        .unwrap();
    assert_eq!(view.digest, independent_digest(&view));
    let mut changed = view.clone();
    if let view::ViewRange::Keep { edits, .. } = &mut changed.ranges[0] {
        edits[0].bytes = Some("{\"text\":\"wrong\"}".into());
    }
    assert_ne!(view.digest, independent_digest(&changed));
    assert!(changed.check().is_err());
}

#[tokio::test]
async fn threshold_without_reclaimable_work_never_publishes() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(40);
    for entry in rig.runner.entries.lock().unwrap().iter_mut() {
        entry.message["parts"] = json!([{"id":format!("p{}",entry.ordinal),"type":"text","text":format!("plain message {}",entry.ordinal)}]);
    }
    rig.notice(1, 90_000, None).await;
    assert!(
        rig.newest().is_none(),
        "pressure alone grants no prefix mutation"
    );
}

#[tokio::test]
async fn versions_survive_provider_restart() {
    let dir = tempfile::tempdir().unwrap();
    let mut rig = Rig::new(dir.path()).await;
    let reference = rig.reference.clone();
    let first = rig
        .h
        .store
        .get()
        .unwrap()
        .reserve_async_compaction_version(&reference, 0)
        .unwrap();
    rig.task.abort();
    let _ = (&mut rig.task).await;
    drop(rig);
    let resumed = Rig::new(dir.path()).await;
    let next = resumed
        .h
        .store
        .get()
        .unwrap()
        .reserve_async_compaction_version(&reference, 0)
        .unwrap();
    assert!(
        next > first,
        "a restart must not reuse an allocated version"
    );
}

#[tokio::test]
async fn restored_conversations_keep_the_setup_identity_and_use_it_for_reads() {
    let dir = tempfile::tempdir().unwrap();
    let mut first = Rig::open_bound(
        dir.path(),
        "broca",
        "broca",
        "s",
        "broca",
        json!({"serializer_profile":"opencode-aisdk"}),
    )
    .await;
    let expected = session_resolver::RunnerBindIdentity {
        project_root: dir.path().to_path_buf(),
        harness: "broca".into(),
        session: "s".into(),
    };
    first.task.abort();
    let _ = (&mut first.task).await;
    drop(first);

    let restored = Rig::open_bound(
        dir.path(),
        "broca",
        "broca",
        "s",
        "broca",
        json!({"serializer_profile":"opencode-aisdk"}),
    )
    .await;
    assert_eq!(restored.state().runner_identity(), expected);
    *restored.runner.expected_bind_identity.lock().unwrap() = Some(expected.clone());
    restored.fill(10);
    restored.notice(1, 1_000, None).await;
    assert!(restored
        .runner
        .bind_identities
        .lock()
        .unwrap()
        .contains(&expected));
}

#[tokio::test]
async fn fork_descent_requires_recorded_digest() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(40);
    rig.notice(1, 1_000, None).await;
    let state = rig.state();
    let digest = contract::digest::content_digest(&state.entries[&9].read().unwrap().message);
    assert_eq!(verified_descent(&state, &format!("L:9:{digest}")), Some(9));
    assert_eq!(
        verified_descent(&state, &format!("L:9:{}", "0".repeat(64))),
        None,
        "unverified descent must be a full resync"
    );
    assert_eq!(verified_descent(&state, &format!("other:9:{digest}")), None);
}

#[tokio::test]
async fn published_part_edits_have_full_digest() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(40);
    rig.notice(1, 1_000, None).await;
    rig.history(20, "history before explicit reduction");
    rig.notice(2, 1_000, None).await;
    let baseline = rig.newest().unwrap();
    rig.queue(&[163]).await;
    rig.notice(3, 90_000, Some(baseline)).await;
    let view = rig.get(rig.newest().unwrap()).await;
    assert_eq!(view.digest, independent_digest(&view));
    let edits = view
        .ranges
        .iter()
        .filter_map(|range| match range {
            view::ViewRange::Keep { edits, .. } => Some(edits),
            _ => None,
        })
        .flatten()
        .collect::<Vec<_>>();
    assert!(
        edits.iter().any(|edit| edit
            .bytes
            .as_ref()
            .is_some_and(|bytes| bytes.contains("[dropped §163§]"))),
        "queued reductions must be part edits carrying the exact drop placeholder"
    );
    let _ = rig.render(&view);
}

#[tokio::test]
async fn runner_ordinals_may_start_at_one() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(10);
    rig.runner
        .entries
        .lock()
        .unwrap()
        .retain(|entry| entry.ordinal > 0);
    rig.notice(1, 1_000, None).await;
    assert_eq!(rig.state().entries.first_key_value().unwrap().0, &1);
}

/// Source message ids that the conversation's acknowledged frozen edits name.
fn frozen_mids(rig: &Rig) -> BTreeSet<String> {
    let json = rig.state().frozen_edits.json().unwrap();
    serde_json::from_str::<Vec<Value>>(&json)
        .unwrap()
        .iter()
        .map(|part| part["mid"].as_str().unwrap().to_owned())
        .collect()
}

/// Serve and acknowledge a view whose reduction edits message `m21` (tag 163),
/// then forget that acknowledgement's frozen edits while keeping
/// `state.applied` on it. That is the state an acknowledgement reaches a reset
/// or fork in when the notice-time capture did not record it (for example a
/// conversation stored by a build that recorded acknowledgements without
/// capturing their edits): only the capture taken right before the reset or
/// fork can keep the reduction.
async fn acknowledged_reduction_without_notice_capture(rig: &Rig) -> u64 {
    rig.fill(40);
    rig.notice(1, 1_000, None).await;
    rig.history(20, "history before explicit reduction");
    rig.notice(2, 1_000, None).await;
    let baseline = rig.newest().unwrap();
    rig.queue(&[163]).await;
    rig.notice(3, 90_000, Some(baseline)).await;
    let reduced = rig.newest().unwrap();
    assert_ne!(reduced, baseline, "precondition: the reduction was served");
    rig.notice(4, 1_000, Some(reduced)).await;
    assert!(
        frozen_mids(rig).contains("m21"),
        "precondition: the acknowledgement captured the reduction"
    );
    let store = rig.h.store.get().unwrap();
    let mut state = rig.h.checkout(store, &rig.reference).unwrap().unwrap();
    state.frozen_edits = Default::default();
    state.frozen_edits.dirty = true;
    state.frozen_edits_version = None;
    state.save(store, &[]).unwrap();
    rig.h.checkin(state);
    assert!(frozen_mids(rig).is_empty());
    assert_eq!(rig.state().applied, Some(reduced));
    reduced
}

/// A reset with no notice in between (a ride whose transcript read fails)
/// must capture the acknowledged view's edits before it discards the engine
/// state that produced them.
#[tokio::test]
async fn reset_without_a_notice_keeps_the_acknowledged_reduction() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    acknowledged_reduction_without_notice_capture(&rig).await;
    let generation = rig.state().generation;
    rig.runner
        .read_unavailable
        .store(true, std::sync::atomic::Ordering::Relaxed);
    assert!(rig.ride("ceiling").await.is_none());
    rig.runner
        .read_unavailable
        .store(false, std::sync::atomic::Ordering::Relaxed);
    assert!(rig.state().generation > generation, "the ride reset");
    assert!(
        frozen_mids(&rig).contains("m21"),
        "the reset kept the acknowledged reduction"
    );
}

/// A fork notice that names no applied view (so the notice-time capture has
/// nothing to record) must still capture the acknowledged view's edits before
/// the fork cuts the held entries.
#[tokio::test]
async fn fork_without_an_applied_version_keeps_the_acknowledged_reduction() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    acknowledged_reduction_without_notice_capture(&rig).await;
    let digest =
        contract::digest::content_digest(&rig.state().entries[&39].read().unwrap().message);
    *rig.runner.lineage.lock().unwrap() = "fork:verified".into();
    rig.notice_with_descent(5, 1_000, None, Some(format!("L:39:{digest}")))
        .await;
    assert_eq!(rig.state().lineage.as_deref(), Some("fork:verified"));
    assert!(
        frozen_mids(&rig).contains("m21"),
        "the fork kept the acknowledged reduction"
    );
}

#[tokio::test]
async fn fork_descent_preserves_only_verified_prefix_state() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(40);
    rig.notice(1, 1_000, None).await;
    let before = rig.state();
    let digest = contract::digest::content_digest(&before.entries[&9].read().unwrap().message);
    rig.runner.entries.lock().unwrap().truncate(10);
    *rig.runner.lineage.lock().unwrap() = "fork:verified".into();
    rig.notice_with_descent(2, 1_000, None, Some(format!("L:9:{digest}")))
        .await;
    let retained = rig.state();
    assert_eq!(retained.generation, before.generation);
    assert_eq!(retained.tag_index.len(), 10);
    assert_eq!(retained.lineage.as_deref(), Some("fork:verified"));
    *rig.runner.lineage.lock().unwrap() = "fork:unverified".into();
    rig.notice_with_descent(
        3,
        1_000,
        None,
        Some(format!("fork:verified:9:{}", "0".repeat(64))),
    )
    .await;
    let reread = rig.state();
    assert!(reread.generation > retained.generation);
    assert_eq!(reread.tag_index.len(), 10);
    assert_eq!(reread.lineage.as_deref(), Some("fork:unverified"));
}

#[tokio::test]
async fn ordinary_execute_with_only_drops_defers_but_m1_refresh_publishes() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(40);
    rig.notice(1, 1_000, None).await;
    rig.history(10, "stable baseline history");
    rig.notice(2, 1_000, None).await;
    let baseline = rig.newest().unwrap();
    rig.queue(&[163, 166, 169]).await;
    rig.notice(3, 75_000, Some(baseline)).await;
    assert_eq!(
        rig.newest(),
        Some(baseline),
        "ordinary Execute does not originate a bust for drops alone"
    );
    let namespace = rig.state().namespace();
    let store = rig.h.store.get().unwrap();
    assert_eq!(store.load_pending_agent_drops(&namespace).unwrap().len(), 3);
    let mut rows = store.load_compartments(&namespace).unwrap();
    rows.push(mc_store::StoredCompartment {
        sequence: 2,
        start_message: 11,
        end_message: 15,
        end_message_id: "m15#0".into(),
        title: "delta".into(),
        content: "queued in-session history delta".into(),
        p1: Some("queued in-session history delta".into()),
        importance: 50,
        ..Default::default()
    });
    store.replace_compartments(&namespace, &rows).unwrap();
    rig.notice(4, 1_000, Some(baseline)).await;
    assert_eq!(
        rig.newest(),
        Some(baseline),
        "M1 delta remains queued below Execute"
    );
    rig.notice(5, 75_000, Some(baseline)).await;
    let version = rig.newest().unwrap();
    assert!(
        version > baseline,
        "ordinary Execute publishes an M1 refresh, carrying queued drops"
    );
    assert!(store
        .load_pending_agent_drops(&namespace)
        .unwrap()
        .is_empty());
    let _ = rig.render(&rig.get(version).await);
}

#[tokio::test]
async fn reduce_catches_up_unread_runner_tag_before_queuing() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(10);
    assert!(rig.state().entries.is_empty());

    let answer = rig.tool(7, "ctx_reduce", json!({"drop":"127"})).await;
    assert_ne!(answer["isError"], true, "{answer}");
    assert_eq!(answer["content"][0]["text"], "1 tag stamped. ");
    let state = rig.state();
    assert_eq!(state.entries.len(), 10);
    assert_eq!(state.tag_index.len(), 10);
    assert_eq!(state.tag_index["§127§"].part, "0");
    assert_eq!(
        state.entries[&9].read().unwrap().message["parts"][0]["id"],
        "p9"
    );
    let codec = codec::Codec::from_params(&Value::Object(state.setup.params.clone())).unwrap();
    assert_eq!(
        rig.pending_targets(),
        vec![tag_row(&state, codec, 127).unwrap().unwrap().block_id]
    );
    let reads = rig.runner.reads.lock().unwrap();
    assert_eq!(reads.len(), 2, "catch-up must finish paging");
    assert_eq!(reads[0]["from_ordinal"], 0);
    assert_eq!(reads[1]["from_ordinal"], 7);
    assert!(reads.iter().all(|read| read["lineage_id"] == "L"));
}

#[tokio::test]
async fn reduce_refuses_missing_tag_only_after_successful_catch_up() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(2);

    let answer = rig.tool(7, "ctx_reduce", json!({"drop":"999"})).await;
    assert_eq!(answer["isError"], true, "{answer}");
    assert_eq!(
        answer["content"][0]["text"],
        "Refused: no valid tags to queue. tags 999 not found"
    );
    assert_eq!(rig.state().entries.len(), 2);
    assert_eq!(rig.runner.reads.lock().unwrap().len(), 1);
    assert!(rig.pending_targets().is_empty());
}

#[tokio::test]
async fn reduce_unreachable_runner_is_retryable_not_not_found() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(2);
    rig.runner
        .read_unavailable
        .store(true, std::sync::atomic::Ordering::Relaxed);

    let answer = rig.tool(7, "ctx_reduce", json!({"drop":"103"})).await;
    assert_eq!(answer["isError"], true, "{answer}");
    let text = answer["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("Retry ctx_reduce for tags 103"), "{text}");
    assert!(!text.contains("not found"), "{text}");
    assert!(rig.pending_targets().is_empty());
    assert!(rig.state().entries.is_empty());

    rig.runner
        .read_unavailable
        .store(false, std::sync::atomic::Ordering::Relaxed);
    rig.queue(&[103]).await;
}

#[tokio::test]
async fn reduce_mixed_request_queues_known_and_reports_only_checked_missing_tags() {
    for unavailable in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let rig = Rig::new(dir.path()).await;
        rig.fill(1);
        rig.notice(1, 1_000, None).await;
        rig.fill(2);
        rig.runner
            .read_unavailable
            .store(unavailable, std::sync::atomic::Ordering::Relaxed);

        let answer = rig
            .tool(7, "ctx_reduce", json!({"drop":"100,103,999"}))
            .await;
        assert_ne!(answer["isError"], true, "{answer}");
        let text = answer["content"][0]["text"].as_str().unwrap();
        let state = rig.state();
        let codec = codec::Codec::from_params(&Value::Object(state.setup.params.clone())).unwrap();
        let mut expected = vec![tag_row(&state, codec, 100).unwrap().unwrap().block_id];
        if unavailable {
            assert!(text.starts_with("1 tag stamped."), "{text}");
            assert!(
                text.contains("Retry ctx_reduce for tags 103, 999"),
                "{text}"
            );
            assert!(!text.contains("not found"), "{text}");
            assert_eq!(state.entries.len(), 1);
        } else {
            assert_eq!(text, "2 tags stamped. tags 999 not found");
            expected.push(tag_row(&state, codec, 103).unwrap().unwrap().block_id);
            assert_eq!(state.entries.len(), 2);
        }
        let mut actual = rig.pending_targets();
        actual.sort();
        expected.sort();
        assert_eq!(actual, expected);
    }
}

#[tokio::test]
async fn reduce_catch_up_and_concurrent_notice_share_the_saved_cursor() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(3);
    rig.notice(1, 1_000, None).await;
    rig.fill(12);
    rig.runner.reads.lock().unwrap().clear();
    let gate = Arc::new(ReadGate::default());
    *rig.runner.read_gate.lock().unwrap() = Some(gate.clone());
    let last = rig.runner.entries.lock().unwrap().last().unwrap().clone();
    let notice = notice::AdvanceNotice::new(
        &rig.reference,
        2,
        "L",
        last.ordinal,
        contract::digest::content_digest(&last.message),
        1_000,
        "fixture",
    )
    .with_window(100_000);
    let message = cortexkit_bus_trait::Message {
        subject: notice::event_subject("fixture", &rig.module, notice::ADVANCED_EVENT),
        id: bus_id(&rig.reference, "advanced", 2),
        digest: notice.digest().parse().unwrap(),
        headers: notice.to_headers(),
    };

    let (answer, ()) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(rig.tool(7, "ctx_reduce", json!({"drop":"133"})), async {
            gate.entered.notified().await;
            let advance = rig.h.advance_compaction("fixture", &message);
            tokio::pin!(advance);
            // Poll the notice until it waits on the serial held by the
            // paused catch-up. It must not read or save the older cursor.
            std::future::poll_fn(|cx| {
                assert!(std::future::Future::poll(advance.as_mut(), cx).is_pending());
                std::task::Poll::Ready(())
            })
            .await;
            assert_eq!(rig.runner.reads.lock().unwrap().len(), 1);
            assert_eq!(rig.state().entries.len(), 3);
            gate.resume.notify_one();
            advance.await.unwrap();
        })
    })
    .await
    .expect("catch-up and notice complete without deadlocking");
    assert_ne!(answer["isError"], true, "{answer}");
    assert_eq!(answer["content"][0]["text"], "1 tag stamped. ");
    let state = rig.state();
    assert_eq!(state.completed_seq, 2);
    assert_eq!(
        state.entries.keys().copied().collect::<Vec<_>>(),
        (0..12).collect::<Vec<_>>()
    );
    assert_eq!(state.tag_index.len(), 12);
    assert_eq!(state.journal.persisted_through, Some(11));
    for (ordinal, entry) in &state.entries {
        assert_eq!(
            entry.read().unwrap().message,
            rig.runner.entries.lock().unwrap()[*ordinal as usize].message
        );
    }
    assert_eq!(
        rig.runner
            .reads
            .lock()
            .unwrap()
            .iter()
            .map(|read| read["from_ordinal"].as_u64().unwrap())
            .collect::<Vec<_>>(),
        vec![2, 9, 11],
        "the notice re-reads only the tail saved by the catch-up"
    );
}

#[tokio::test]
async fn reduce_incomplete_catch_up_is_retryable_and_preserves_known_tags() {
    for reason in ["timeout", "lineage", "resync", "invalid_parts"] {
        let dir = tempfile::tempdir().unwrap();
        let rig = Rig::new(dir.path()).await;
        rig.fill(1);
        rig.notice(1, 1_000, None).await;
        rig.fill(10);
        match reason {
            "timeout" => rig
                .runner
                .read_delay_ms
                .store(5_000, std::sync::atomic::Ordering::Relaxed),
            "lineage" => *rig.runner.lineage.lock().unwrap() = "new-lineage".into(),
            "resync" => {
                let mut state = rig.state();
                state.resync = true;
                state.save(rig.h.store.get().unwrap(), &[]).unwrap();
            }
            "invalid_parts" => rig.runner.entries.lock().unwrap()[9].tags[0].part = String::new(),
            _ => unreachable!(),
        }
        let started = Instant::now();
        let answer = rig.tool(7, "ctx_reduce", json!({"drop":"100,127"})).await;
        assert!(started.elapsed() < Duration::from_secs(4), "{reason}");
        assert_ne!(answer["isError"], true, "{reason}: {answer}");
        let text = answer["content"][0]["text"]
            .as_str()
            .unwrap_or_else(|| panic!("{reason}: {answer}"));
        assert!(text.starts_with("1 tag stamped."), "{reason}: {text}");
        assert!(
            text.contains("Retry ctx_reduce for tags 127"),
            "{reason}: {text}"
        );
        assert!(!text.contains("not found"), "{reason}: {text}");
        assert_eq!(rig.pending_targets().len(), 1, "{reason}");
        assert_eq!(
            rig.state().entries.len(),
            1,
            "incomplete reads must not be saved: {reason}"
        );
        if reason != "resync" {
            rig.runner
                .read_delay_ms
                .store(0, std::sync::atomic::Ordering::Relaxed);
            *rig.runner.lineage.lock().unwrap() = "L".into();
            rig.fill(10);
            rig.queue(&[127]).await;
            assert_eq!(rig.state().entries.len(), 10, "{reason}");
            assert_eq!(rig.pending_targets().len(), 2, "{reason}");
        }
    }
}

#[tokio::test]
async fn ride_deadline_returns_nothing_without_waiting_for_slow_runner() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(10);
    rig.notice(1, 1_000, None).await;
    rig.runner
        .read_delay_ms
        .store(500, std::sync::atomic::Ordering::Relaxed);
    let started = Instant::now();
    let answer = rig
        .op(
            "compaction.ride",
            json!({"session_ref":rig.reference,"cause":"ceiling","deadline_ms":10}),
        )
        .await;
    assert_eq!(answer["answer"], "nothing");
    assert!(started.elapsed() < Duration::from_millis(250));
}

#[tokio::test]
async fn reads_use_the_admitted_runner_not_the_process_default() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(10);
    rig.notice(1, 1_000, None).await;
    assert!(
        rig.runner
            .routed_reads
            .load(std::sync::atomic::Ordering::Relaxed)
            >= 2
    );
    let state = rig.state();
    assert_eq!(state.runner_route.unwrap()["module_id"], "thalamus-harness");
    let project = state.dream_target.as_ref().unwrap()["project"]
        .as_str()
        .unwrap();
    assert!(
        rig.h.dream_runs.target_for_test(project).is_none(),
        "background-disabled conversations must not start a dream schedule"
    );
    assert_eq!(state.dream_target.unwrap()["route"]["parent_session"], "s");
}

#[tokio::test]
async fn reverse_reads_use_the_setup_identity_for_all_runner_route_shapes() {
    for (module, bind_harness, bind_session, setup_harness, profile) in [
        ("broca", "runner", "", "opencode", "opencode-aisdk"),
        (
            "thalamus",
            "runner",
            "s",
            "claude-code",
            "anthropic-messages",
        ),
        ("broca", "broca", "s", "broca", "opencode-aisdk"),
        ("broca", "runner", "s", "broca", "opencode-aisdk"),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let rig = Rig::open_bound(
            dir.path(),
            module,
            bind_harness,
            bind_session,
            setup_harness,
            json!({"serializer_profile":profile}),
        )
        .await;
        let expected = session_resolver::RunnerBindIdentity {
            project_root: dir.path().to_path_buf(),
            harness: setup_harness.into(),
            session: "s".into(),
        };
        *rig.runner.expected_bind_identity.lock().unwrap() = Some(expected.clone());
        if setup_harness == "claude-code" {
            *rig.runner.entries.lock().unwrap() = anthropic_transcript(12);
        } else {
            rig.fill(10);
        }
        rig.notice(1, 1_000, None).await;
        let identities = rig.runner.bind_identities.lock().unwrap().clone();
        assert!(
            identities.iter().any(|identity| identity == &expected),
            "reverse read did not bind the Setup identity for {bind_harness:?}/{bind_session:?} -> {setup_harness:?}: {identities:?}"
        );
        let state = rig.state();
        assert_eq!(state.runner_identity(), expected);
        let reverse_binding = rig.h.async_binding(&state);
        assert_eq!(reverse_binding.project_root, expected.project_root);
        assert_eq!(reverse_binding.harness, expected.harness);
        assert_eq!(reverse_binding.session, expected.session);
        assert_eq!(
            state.dream_target.as_ref().unwrap()["directory"],
            expected.project_root.to_string_lossy().as_ref()
        );
        assert_eq!(
            state.dream_target.as_ref().unwrap()["harness"],
            expected.harness
        );
    }
}

#[tokio::test]
async fn broca_bound_async_lane_reads_and_publishes_with_the_setup_identity() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::open_bound(
        dir.path(),
        "broca",
        "broca",
        "s",
        "broca",
        json!({"serializer_profile":"opencode-aisdk"}),
    )
    .await;
    let expected = session_resolver::RunnerBindIdentity {
        project_root: dir.path().to_path_buf(),
        harness: "broca".into(),
        session: "s".into(),
    };
    *rig.runner.expected_bind_identity.lock().unwrap() = Some(expected.clone());
    rig.fill(40);
    rig.notice(1, 1_000, None).await;
    assert_eq!(rig.state().entries.len(), 40);

    rig.history(20, "initial historian summary");
    rig.notice(2, 1_000, None).await;
    let baseline = rig.newest().expect("initial history publication");
    rig.queue(&[163, 166, 169]).await;
    rig.notice(3, 90_000, Some(baseline)).await;
    let published = rig.newest().expect("async view publication");
    assert!(published > baseline);
    assert_eq!(rig.get(published).await.lineage_id, "L");
    assert!(rig
        .runner
        .bind_identities
        .lock()
        .unwrap()
        .iter()
        .all(|identity| identity == &expected));
}

#[tokio::test]
async fn setup_accepts_allowed_runner_principals_and_rejects_other_principals() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::open_bound(
        dir.path(),
        "broca",
        "broca",
        "s",
        "broca",
        json!({"serializer_profile":"opencode-aisdk"}),
    )
    .await;
    let mut binding = rig.h.facade_binding(7).unwrap();
    binding.principal = Some(subc_protocol::Principal::Reserved {
        module_id: "unlisted-runner".into(),
    });
    rig.h.bind_route(8, binding);
    let refused = rig
        .h
        .dispatch_value(
            8,
            json!({"method":"compaction.setup","params":setup_request("s", "unlisted")}),
        )
        .await;
    assert!(matches!(
        refused,
        HandlerOutcome::Error { ref code, .. } if code == "route_unbound"
    ));
}

#[tokio::test]
async fn setup_refuses_a_nonempty_route_session_that_contradicts_the_body() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::open(
        dir.path(),
        "broca",
        "broca",
        json!({"serializer_profile":"opencode-aisdk"}),
    )
    .await;
    let mut binding = rig.h.facade_binding(7).unwrap();
    binding.principal = Some(subc_protocol::Principal::Reserved {
        module_id: "broca".into(),
    });
    binding.harness = "any-caller-harness".into();
    binding.session = "other-session".into();
    rig.h.bind_route(8, binding);
    let refused = rig
        .h
        .dispatch_value(
            8,
            json!({"method":"compaction.setup","params":setup_request("s", "mismatch")}),
        )
        .await;
    match refused {
        HandlerOutcome::ErrorWithDetail { code, detail, .. } => {
            assert_eq!(code, "setup_identity_mismatch");
            assert_eq!(detail["route_identity"]["session"], "other-session");
            assert_eq!(detail["setup_identity"]["session"], "s");
        }
        other => panic!("mismatched route session was not refused by name: {other:?}"),
    }
}

#[tokio::test]
async fn ceiling_overflow_ride_with_reported_limit_updates_learned_limit() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(10);
    rig.notice(1, 1_000, None).await;
    let answer=rig.op("compaction.ride",json!({"session_ref":rig.reference,"cause":"ceiling","deadline_ms":10_000,"overflow":{"reported_limit_tokens":80_000}})).await;
    assert!(matches!(
        answer["answer"].as_str(),
        Some("view" | "nothing")
    ));
    let state = rig.state();
    let policy = state.usage_policy.as_ref().unwrap();
    assert_eq!(policy.limit_for("fixture"), Some(80_000));
    let _ = rig.ride("ceiling").await;
    assert_eq!(
        rig.state()
            .usage_policy
            .as_ref()
            .unwrap()
            .limit_for("fixture"),
        Some(80_000),
        "an absent overflow fact must not clear an existing learned limit"
    );
}

#[tokio::test]
async fn plain_ceiling_ride_does_not_invent_a_learned_limit() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(10);
    rig.notice(1, 1_000, None).await;
    let _ = rig.ride("ceiling").await;
    assert!(rig
        .state()
        .usage_policy
        .as_ref()
        .unwrap()
        .learned_limit
        .is_none());
}

#[tokio::test]
async fn synthetic_ids_never_fall_back_to_positional_transcript_matches() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(1);
    rig.notice(1, 1_000, None).await;
    let state = rig.state();
    let entry = state.entries[&0].read().unwrap();
    let original = codec::Codec::OpencodeAiSdk
        .decode_message(&InboundMessage {
            ordinal: 0,
            mid: entry.mid.clone(),
            message: entry.message.clone(),
        })
        .unwrap();
    let engine = transform::compaction::View {
        compaction_id: "proof".into(),
        version: 1,
        range: transform::compaction::Range {
            lineage_id: "L".into(),
            from: 0,
            to: 1,
        },
        replacement: vec![original.ck],
    };
    let wire:OutboundMessage=decode(&json!({"compaction_id":"proof","version":1,"range":{"from":0,"to":1},"replacement":[{"info":{"id":"synthetic-todo","role":"user"},"parts":[{"id":"synthetic-part","type":"text","text":"inserted content"}]},entry.message]})).unwrap();
    let (ranges, _) = ranges(&state, codec::Codec::OpencodeAiSdk, &wire, &engine, None).unwrap();
    assert!(matches!(
        &ranges[0],
        view::ViewRange::Replace { from: 0, to: 0, .. }
    ));
    assert!(matches!(&ranges[1],view::ViewRange::Keep{from:0,to:1,edits} if edits.is_empty()));
}

#[tokio::test]
async fn restored_lineage_reuses_history_embeddings_and_reanchors_only_surviving_drops() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(40);
    rig.notice(1, 1_000, None).await;
    rig.history(20, "published history survives a runner backup restore");
    rig.notice(2, 1_000, None).await;
    let old_version = rig.newest().unwrap();
    rig.notice(3, 1_000, Some(old_version)).await;
    let old_view = rig.get(old_version).await;
    assert_eq!(
        old_view
            .ranges
            .iter()
            .take_while(|r| matches!(r, view::ViewRange::Replace { .. }))
            .last()
            .unwrap()
            .to(),
        21,
        "the history replacement must remove its covered raw prefix"
    );
    let old_head = match &old_view.ranges[0] {
        view::ViewRange::Replace { bytes, .. } => bytes.clone(),
        _ => panic!("history head"),
    };
    rig.queue(&[163, 208]).await;
    let held = rig.state();
    let tool = decoded_entry(
        codec::Codec::OpencodeAiSdk,
        &InboundMessage {
            ordinal: 21,
            mid: "m21".into(),
            message: held.entries[&21].read().unwrap().message,
        },
    )
    .unwrap();
    assert_eq!(tool.ck.content.len(), 2);
    assert!(matches!(
        tool.ck.content[0].kind,
        ck_wire::CkKind::ToolCall { .. }
    ));
    assert!(matches!(
        tool.ck.content[1].kind,
        ck_wire::CkKind::ToolResult { .. }
    ));
    assert_eq!(held.tag_index["§163§"].part, "0");
    tokio::time::timeout(Duration::from_secs(2), async {
        while rig
            .h
            .provider_store
            .async_runtime
            .historian_evaluations
            .load(std::sync::atomic::Ordering::Relaxed)
            == 0
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let evaluations = rig
        .h
        .provider_store
        .async_runtime
        .historian_evaluations
        .load(std::sync::atomic::Ordering::Relaxed);
    let before = rig.state();
    let source = before.namespace();
    let store = rig.h.store.get().unwrap();
    store.with_context_conn_for_test(|conn| {
        conn.execute("INSERT INTO compartment_chunk_embeddings(compartment_id,session_id,project_path,harness,window_index,start_ordinal,end_ordinal,chunk_hash,model_id,dims,vector,created_at) SELECT id,?1,'fixture','opencode',0,0,20,'unchanged-chunk-hash','fixture-model',1,x'0000803f',1 FROM compartments WHERE session_id=?1 AND sequence=1",[&source])?;
        Ok(())
    }).unwrap();
    {
        let mut entries = rig.runner.entries.lock().unwrap();
        entries.truncate(31);
        for entry in entries.iter_mut() {
            entry.tags[0].tag = Some(format!("§{}§", 9_000 + entry.ordinal * 3));
        }
    }
    *rig.runner.lineage.lock().unwrap() = "runner-restored".into();
    rig.notice(4, 1_000, None).await;
    let after = rig.state();
    assert!(after.generation > before.generation);
    assert_eq!(after.last_discarded_drops, 1);
    assert_eq!(after.last_transferred_drops, 1);
    assert_eq!(
        rig.h
            .provider_store
            .async_runtime
            .historian_evaluations
            .load(std::sync::atomic::Ordering::Relaxed),
        evaluations,
        "a restore of known messages must not even schedule another historian evaluation"
    );
    let restored = rig.get(rig.newest().unwrap()).await;
    let new_head = match &restored.ranges[0] {
        view::ViewRange::Replace { bytes, .. } => bytes,
        _ => panic!("restored history head"),
    };
    assert_eq!(
        new_head, &old_head,
        "restored history head must remain byte-identical"
    );
    assert!(after.tag_index.contains_key("§9063§"));
    // m21's only part is that tool part, so the view either drops the part
    // or removes the emptied message whole (`emptied_messages::shape`).
    let dropped = restored.ranges.iter().any(|range| match range {
        view::ViewRange::Keep { edits, .. } => edits
            .iter()
            .any(|edit| edit.mid == "m21" && edit.part == "0" && edit.drop),
        view::ViewRange::Replace {
            from: 21,
            to: 22,
            bytes,
        } => bytes == "[]",
        _ => false,
    });
    assert!(
        dropped,
        "the tool-part tag must remove the whole native pair, not a CK block numbered 0 or 1"
    );
    assert!(store.load_pending_agent_drops(&source).unwrap().is_empty());
    let target = after.namespace();
    let embedding: Vec<(String, Vec<u8>)> = store
        .with_context_read(|conn| {
            conn.prepare(
                "SELECT chunk_hash,vector FROM compartment_chunk_embeddings WHERE session_id=?1",
            )?
            .query_map([&target], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect()
        })
        .unwrap();
    assert_eq!(
        embedding,
        vec![("unchanged-chunk-hash".into(), vec![0, 0, 128, 63])],
        "copy vectors without an embedding call"
    );
    assert_eq!(
        store.load_compartments(&target).unwrap()[0].content,
        "published history survives a runner backup restore"
    );
    let _ = rig.render(&restored);
    rig.runner.entries.lock().unwrap().push(ReadMessage::new(31,"new-user-after-restore",json!({"info":{"id":"new-user-after-restore","role":"user","time":{"created":2}},"parts":[{"id":"new-part","type":"text","text":"a genuinely new turn"}]})).with_tags(vec![tags::PartTag::tagged("0","§20000§")]));
    rig.notice(5, 1_000, None).await;
    tokio::time::timeout(Duration::from_secs(2), async {
        while rig
            .h
            .provider_store
            .async_runtime
            .historian_evaluations
            .load(std::sync::atomic::Ordering::Relaxed)
            == evaluations
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("a real new user turn must still wake the historian");
}

/// The runner tag llm-runner would serve for part `part` of message `n` in
/// [`anthropic_transcript`].
fn anthropic_tag(n: u64, part: u64) -> u64 {
    1_000 + n * 10 + part
}

/// A Claude Code transcript in the `anthropic-messages` schema, repeating a
/// four-message turn: a string-content prompt, an assistant message with a
/// signed thinking block, its tool result, and a final answer. Text and tool
/// result parts are tagged; thinking and tool_use parts carry no tag.
fn anthropic_transcript(count: u64) -> Vec<ReadMessage> {
    (0..count)
        .map(|n| {
            let tagged = |part: u64| tags::PartTag::tagged(part.to_string(), format!("§{}§", anthropic_tag(n, part)));
            let (message, rows) = match n % 4 {
                0 => (
                    json!({"role":"user","content":format!("message {n} ")+&"durable words ".repeat(16)}),
                    vec![tagged(0)],
                ),
                1 => (
                    json!({"role":"assistant","content":[
                        {"type":"thinking","thinking":format!("plan {n}"),"signature":format!("EqQBsig{n}+/==")},
                        {"type":"text","text":format!("reading file {n} ")+&"careful words ".repeat(8)},
                        {"type":"tool_use","id":format!("toolu_{n}"),"name":"read","input":{"path":format!("file{n}")}},
                    ]}),
                    vec![tags::PartTag::untagged("0"), tagged(1), tags::PartTag::untagged("2")],
                ),
                2 => (
                    json!({"role":"user","content":[
                        {"type":"tool_result","tool_use_id":format!("toolu_{}", n - 1),"content":"exact spent output ".repeat(500)},
                    ]}),
                    vec![tagged(0)],
                ),
                _ => (
                    json!({"role":"assistant","content":[{"type":"text","text":format!("answer {n} ")+&"durable words ".repeat(16)}]}),
                    vec![tagged(0)],
                ),
            };
            ReadMessage::new(n, format!("m{n}"), message).with_tags(rows)
        })
        .collect()
}

impl Rig {
    /// Apply `view` to the runner's `anthropic-messages` transcript the way
    /// the runner does: replacement ranges as sent, kept parts with their
    /// rendered tags, edited parts with their edit bytes.
    fn render_anthropic(&self, view: &view::CompactionView) -> Vec<Value> {
        assert_eq!(independent_digest(view), view.digest);
        let entries = self.runner.entries.lock().unwrap();
        let mut output = Vec::new();
        for range in &view.ranges {
            match range {
                view::ViewRange::Replace { bytes, .. } => {
                    output.extend(serde_json::from_str::<Vec<Value>>(bytes).unwrap())
                }
                view::ViewRange::Keep { from, to, edits } => {
                    for entry in entries
                        .iter()
                        .filter(|e| e.ordinal >= *from && e.ordinal < *to)
                    {
                        let mut rendered = Vec::new();
                        for (part, row) in parts(&entry.message).unwrap().iter().zip(&entry.tags) {
                            match edits
                                .iter()
                                .find(|e| e.ordinal == entry.ordinal && e.part == row.part)
                            {
                                Some(edit) if edit.drop => {}
                                Some(edit) => rendered.push(
                                    serde_json::from_str(edit.bytes.as_ref().unwrap()).unwrap(),
                                ),
                                None => rendered.push(render_part(part, row.tag.as_deref(), true)),
                            }
                        }
                        let mut message = entry.message.clone();
                        message["content"] = match rendered.as_slice() {
                            [Value::String(text)] => json!(text),
                            _ => json!(rendered),
                        };
                        output.push(message);
                    }
                }
                _ => panic!("unknown range kind"),
            }
        }
        output.extend(
            entries
                .iter()
                .filter(|e| e.ordinal > view.covers_through.ordinal)
                .map(|e| e.message.clone()),
        );
        output
    }
}

#[tokio::test]
async fn anthropic_messages_session_publishes_part_edits_beside_signed_thinking() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::open(
        dir.path(),
        "thalamus-harness",
        "claude-code",
        json!({"serializer_profile":"anthropic-messages"}),
    )
    .await;
    let transcript = anthropic_transcript(39);
    *rig.runner.entries.lock().unwrap() = transcript.clone();
    rig.notice(1, 1_000, None).await;
    assert_eq!(rig.newest(), None, "defer must not publish");
    let state = rig.state();
    assert_eq!(
        tag_rows(&state, codec::Codec::AnthropicMessages)
            .unwrap()
            .len(),
        39,
        "every tagged text and tool result part must be indexed"
    );
    rig.history(20, "first completed historian summary");
    rig.notice(2, 1_000, None).await;
    let baseline = rig.newest().expect("new history publishes");
    // Message 21 is an assistant message whose first part is a signed
    // thinking block; drop its text part, and the tool result after it.
    rig.queue(&[anthropic_tag(21, 1), anthropic_tag(22, 0)])
        .await;
    rig.notice(3, 90_000, Some(baseline)).await;
    let version = rig.newest().expect("execute threshold publishes");
    assert!(version > baseline);
    let view = rig.get(version).await;
    assert!(
        matches!(view.ranges[0], view::ViewRange::Replace { from: 0, .. }),
        "the view inserts the history head before every kept message"
    );
    let edits: Vec<_> = view
        .ranges
        .iter()
        .flat_map(|range| match range {
            view::ViewRange::Keep { edits, .. } => edits.clone(),
            _ => Vec::new(),
        })
        .collect();
    let near: Vec<_> = edits
        .iter()
        .filter(|edit| edit.ordinal == 21 || edit.ordinal == 22)
        .map(|edit| (edit.ordinal, edit.part.as_str(), edit.drop))
        .collect();
    assert_eq!(
        near,
        [(21, "1", false), (22, "0", false)],
        "the dropped parts get their placeholders; the signed thinking part beside them is kept"
    );
    // The head insertion invalidates every later signature, but removing those
    // blocks is the runner's companion edit (or it defers the view): the view
    // itself never edits a thinking part.
    for edit in &edits {
        let content = &transcript[edit.ordinal as usize].message["content"];
        let part = content.get(edit.part.parse::<usize>().unwrap());
        assert!(
            part.is_none_or(|part| part["type"] != "thinking"),
            "the view edited a signed thinking part: {edit:?}"
        );
    }
    let rendered = rig.render_anthropic(&view);
    let applied = rendered
        .iter()
        .find(|message| message["content"][2]["id"] == "toolu_21")
        .expect("message 21 stays in the rendered request");
    assert_eq!(
        bytes(&applied["content"][0]).unwrap(),
        bytes(&transcript[21].message["content"][0]).unwrap(),
        "the signed thinking block and its signature are the runner's own bytes"
    );
    assert_ne!(applied["content"][1], transcript[21].message["content"][1]);
    for message in rendered.iter().filter(|m| m["role"] == "assistant") {
        if let Some(signed) = message["content"]
            .as_array()
            .and_then(|parts| parts.iter().find(|p| p["type"] == "thinking"))
        {
            let source = transcript
                .iter()
                .find(|entry| entry.message["content"][0] == *signed)
                .expect("every rendered thinking block is a runner block");
            assert_eq!(
                bytes(signed).unwrap(),
                bytes(&source.message["content"][0]).unwrap()
            );
        }
    }
    // A view is immutable: the same version is served again unchanged.
    assert_eq!(rig.get(version).await, view);
    // The runner applies the view with the provider's companion strip and says
    // so. That fact is recorded, and it is not a reason for a new view: the
    // next notice with no new work publishes nothing, so the runner and ck-mc
    // never chase each other's bytes.
    rig.notice_with(
        4,
        90_000,
        Some(version),
        None,
        vec![notice::Event::ViewCompanion {
            view_version: version,
            edit: notice::companion_edits::STRIP_SIGNED_REASONING.into(),
        }],
    )
    .await;
    assert_eq!(
        rig.state().acknowledgements,
        [format!("view_companion:{version}:strip_signed_reasoning")]
    );
    assert_eq!(
        rig.newest(),
        Some(version),
        "a companion apply needs no new view"
    );
    rig.notice(5, 90_000, Some(version)).await;
    assert_eq!(rig.newest(), Some(version));
}

/// THALAMUS's Claude Code gateway (module `thalamus`) is a session runner: a
/// Setup attested by it is accepted, and the conversation's transcript reads,
/// sends and background children all route to that module. The fake runner
/// asserts the routed module on every call it receives.
#[tokio::test]
async fn a_thalamus_attested_setup_routes_reads_sends_and_children_to_thalamus() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::open(
        dir.path(),
        "thalamus",
        "claude-code",
        json!({"serializer_profile":"anthropic-messages"}),
    )
    .await;
    *rig.runner.entries.lock().unwrap() = anthropic_transcript(12);
    rig.notice(1, 1_000, None).await;
    assert!(
        rig.runner
            .routed_reads
            .load(std::sync::atomic::Ordering::Relaxed)
            >= 1,
        "transcript reads go through the session runner route"
    );
    let state = rig.state();
    assert_eq!(state.runner_module, "thalamus");
    let route = state.runner().unwrap();
    assert_eq!(route.module_id(), "thalamus");
    assert_eq!(
        state.runner_route.as_ref().unwrap()["module_id"],
        "thalamus"
    );
    assert_eq!(
        state.dream_target.as_ref().unwrap()["route"]["module_id"],
        "thalamus"
    );
    // A send (a reminder) takes the same routed interface as the reads.
    let sent = rig
        .h
        .provider_runner
        .call_for(
            &route,
            dir.path(),
            "session.send",
            json!({}),
            Duration::from_secs(1),
        )
        .await
        .unwrap();
    assert_eq!(sent["state"], "pending");
    // Historian and dreamer children of a Claude Code conversation run on the
    // conversation's own runner.
    let principal = subc_protocol::Principal::Reserved {
        module_id: "thalamus".into(),
    };
    let config = McModuleConfig::default();
    for resolved in [
        config.historian_runner_for("claude-code"),
        config.dreamer_runner_for("claude-code"),
    ] {
        let child = crate::route_targets::SessionRunnerRoute::for_background_call(
            Some(&principal),
            "s",
            resolved,
        )
        .expect("a thalamus conversation's children use its session runner");
        assert_eq!(child.module_id(), "thalamus");
        assert_eq!(child.parent_session(), "s");
    }
}

/// A dispatch outcome as JSON: a response's body, or an error's code and message.
fn outcome(result: HandlerOutcome) -> Value {
    match result {
        HandlerOutcome::Response(bytes) => serde_json::from_slice(&bytes).unwrap(),
        HandlerOutcome::Error { code, message } => json!({"code":code,"message":message}),
        other => json!({"other":format!("{other:?}")}),
    }
}

impl Rig {
    /// Bind `channel` like the runner route but with bind harness `harness`
    /// and bind session `session`.
    fn bind(&self, channel: u16, harness: &str, session: &str) {
        let mut binding = self.h.facade_binding(7).unwrap();
        binding.harness = harness.into();
        binding.session = session.into();
        binding.principal = None;
        self.h.bind_route(channel, binding);
    }
    fn bind_provider(&self, channel: u16, module: &str, harness: &str, session: &str) {
        let mut binding = self.h.facade_binding(7).unwrap();
        binding.principal = Some(subc_protocol::Principal::Reserved {
            module_id: module.into(),
        });
        binding.harness = harness.into();
        binding.session = session.into();
        self.h.bind_route(channel, binding);
    }
    fn bind_shared_setup_route(&self) {
        let mut binding = self.h.facade_binding(7).unwrap();
        binding.session.clear();
        self.h.bind_route(7, binding);
    }
    async fn tool(&self, channel: u16, name: &str, arguments: Value) -> Value {
        outcome(
            self.h
                .dispatch_value(channel, json!({"name":name,"arguments":arguments}))
                .await,
        )
    }
}

/// ctx tools find an asynchronous compaction conversation by the bind's
/// (project_root, session), whatever harness the bind names: a Claude Code
/// MCP facade bind and the runner bind reach the same conversation, and
/// ctx_expand and ctx_search scope to the one ctx_reduce queues into.
#[tokio::test]
async fn any_bind_harness_resolves_the_async_conversation_first() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::open(
        dir.path(),
        "thalamus",
        "claude-code",
        json!({"serializer_profile":"anthropic-messages"}),
    )
    .await;
    *rig.runner.entries.lock().unwrap() = anthropic_transcript(12);
    rig.notice(1, 1_000, None).await;
    let namespace = rig.state().namespace();
    rig.bind(8, "claude-code", "s");
    for channel in [7, 8] {
        let scope = rig
            .h
            .resolve_facade_scope(channel, None, "memories", false, false)
            .await
            .unwrap_or_else(|e| panic!("channel {channel}: {e:?}"));
        assert!(scope.async_conversation, "channel {channel}");
        assert_eq!(scope.conversation_key, namespace, "channel {channel}");
    }
    let store = rig.h.store.get().unwrap();
    let answer = rig
        .tool(
            8,
            "ctx_reduce",
            json!({"drop": anthropic_tag(2, 0).to_string()}),
        )
        .await;
    assert_ne!(answer["isError"], true, "{answer}");
    assert_eq!(store.load_pending_agent_drops(&namespace).unwrap().len(), 1);
    let answer = rig
        .tool(
            7,
            "ctx_reduce",
            json!({"drop": anthropic_tag(6, 0).to_string()}),
        )
        .await;
    assert_ne!(answer["isError"], true, "{answer}");
    assert_eq!(store.load_pending_agent_drops(&namespace).unwrap().len(), 2);
    for (name, arguments) in [
        ("ctx_search", json!({"query":"durable words"})),
        ("ctx_expand", json!({"start":0,"end":3})),
    ] {
        assert_eq!(
            rig.tool(8, name, arguments.clone()).await,
            rig.tool(7, name, arguments).await,
            "{name} answers the claude-code bind from the same conversation"
        );
    }
    assert_eq!(
        rig.resolver
            .calls
            .load(std::sync::atomic::Ordering::Relaxed),
        0,
        "an async conversation never reaches the harness's session resolver"
    );
}

/// With no asynchronous conversation for the bind's session, a non-runner
/// bind keeps its own path: the harness's session resolver is asked, and
/// the answer is the one that path gives.
#[tokio::test]
async fn without_an_async_conversation_a_harness_bind_keeps_its_own_path() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::open(
        dir.path(),
        "thalamus",
        "claude-code",
        json!({"serializer_profile":"anthropic-messages"}),
    )
    .await;
    rig.bind(8, "claude-code", "instance-token");
    let answer = rig.tool(8, "ctx_reduce", json!({"drop":"3"})).await;
    assert_eq!(
        rig.resolver
            .calls
            .load(std::sync::atomic::Ordering::Relaxed),
        1,
        "the claude-code bind asked its session resolver"
    );
    // The resolver resolves nothing, so the old path's unresolved refusal is
    // the answer, exactly as a handler with no async table rows gives it.
    assert_eq!(
        answer,
        outcome(session_unresolved_error()),
        "unchanged unresolved-session answer"
    );
}

/// An accepted Setup names the serializer profile it accepted; an unknown
/// profile is refused by field and no conversation is recorded.
#[tokio::test]
async fn setup_echoes_the_accepted_serializer_profile_and_refuses_an_unknown_one() {
    for (params, expected) in [
        (
            json!({"serializer_profile":"anthropic-messages"}),
            "anthropic-messages",
        ),
        (
            json!({"serializer_profile":"opencode-aisdk"}),
            "opencode-aisdk",
        ),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let rig = Rig::open(dir.path(), "thalamus", "claude-code", params.clone()).await;
        let setup = json!({"session":"s","harness":"claude-code","request_id":"again","model":"fixture","context_window":100_000,"composition":{"render_tags":true},"params":params,"lineage_id":"L","now":1});
        let answer = rig.op("compaction.setup", setup).await;
        assert_eq!(answer["answer"], "ready");
        assert_eq!(answer["serializer_profile"], expected, "{answer}");
        assert_eq!(rig.state().initial["serializer_profile"], expected);
    }
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::open(
        dir.path(),
        "thalamus",
        "claude-code",
        json!({"serializer_profile":"anthropic-messages"}),
    )
    .await;
    rig.bind_provider(8, "thalamus", "runner", "other");
    let refused = rig
        .h
        .dispatch_value(
            8,
            json!({"method":"compaction.setup","params":{"session":"other","harness":"claude-code","request_id":"bad","model":"fixture","context_window":100_000,"composition":{},"params":{"serializer_profile":"claude-code-anthropic"},"lineage_id":"L","now":1}}),
        )
        .await;
    match refused {
        HandlerOutcome::ErrorWithDetail { code, detail, .. } => {
            assert_eq!(code, "invalid_params");
            assert_eq!(detail, json!({"field":"params.serializer_profile"}));
        }
        other => panic!("unknown profile was not refused by field: {other:?}"),
    }
    let other = runner_session_ref("thalamus", "claude-code", "other");
    assert!(load(rig.h.store.get().unwrap(), &other).unwrap().is_none());
}

fn setup_request(session: &str, request_id: &str) -> Value {
    json!({
        "session":session,
        "harness":"opencode",
        "request_id":request_id,
        "model":"fixture",
        "context_window":100_000,
        "composition":{"render_tags":true},
        "params":{"serializer_profile":"opencode-aisdk"},
        "lineage_id":"L",
        "now":1
    })
}

fn pause_bus_for_attach(rig: &Rig) -> Arc<dyn Publisher> {
    let runtime = &rig.h.provider_store.async_runtime;
    let publisher = runtime
        .publisher
        .lock()
        .unwrap()
        .take()
        .expect("test bus publisher");
    runtime
        .bus_link
        .set(super::super::async_bus::LinkState::Attaching, 1, None);
    publisher
}

fn finish_bus_attach(handler: &McHandler, publisher: Arc<dyn Publisher>) {
    let runtime = &handler.provider_store.async_runtime;
    *runtime.publisher.lock().unwrap() = Some(publisher);
    runtime
        .bus_link
        .set(super::super::async_bus::LinkState::Connected, 1, None);
}

/// The fixture delays publisher installation to model credential fetch, nonce
/// signing, NATS connect, and durable-reader attach as one active bootstrap.
#[tokio::test]
async fn setup_waits_for_initial_async_bus_attach() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.bind_shared_setup_route();
    let publisher = pause_bus_for_attach(&rig);
    let handler = rig.h.clone();
    let waiting = tokio::spawn(async move {
        handler
            .dispatch_value(
                7,
                json!({"method":"compaction.setup","params":setup_request("first-attach", "first")}),
            )
            .await
    });

    tokio::task::yield_now().await;
    assert!(
        !waiting.is_finished(),
        "Setup must wait while attach is active"
    );

    const MEASURED_ATTACH_DELAY: Duration = Duration::from_millis(50);
    let attach_started = tokio::time::Instant::now();
    tokio::time::sleep(MEASURED_ATTACH_DELAY).await;
    let measured_attach = attach_started.elapsed();
    finish_bus_attach(&rig.h, publisher);

    let answer = response(waiting.await.unwrap());
    assert_eq!(answer["answer"], "ready", "{answer}");
    assert!(measured_attach >= MEASURED_ATTACH_DELAY);
    assert!(measured_attach < ASYNC_BUS_SETUP_WAIT);
}

#[tokio::test(start_paused = true)]
async fn setup_that_outlives_attach_wait_refuses_bus_not_ready() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.bind_shared_setup_route();
    let _publisher = pause_bus_for_attach(&rig);
    let handler = rig.h.clone();
    let started = tokio::time::Instant::now();
    let waiting = tokio::spawn(async move {
        handler
            .dispatch_value(
                7,
                json!({"method":"compaction.setup","params":setup_request("never-ready", "timeout")}),
            )
            .await
    });
    tokio::task::yield_now().await;
    assert!(!waiting.is_finished(), "Setup should be waiting on attach");

    tokio::time::advance(ASYNC_BUS_SETUP_WAIT).await;
    let answer = response(waiting.await.unwrap());
    assert_eq!(answer["answer"], "refuse", "{answer}");
    assert_eq!(answer["provider_code"], "bus_not_ready", "{answer}");
    assert_eq!(
        tokio::time::Instant::now() - started,
        ASYNC_BUS_SETUP_WAIT,
        "Setup must stop waiting at the configured bound"
    );
}

#[tokio::test]
async fn setup_during_bus_backoff_refuses_without_waiting_for_another_retry() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.bind_shared_setup_route();
    let _publisher = pause_bus_for_attach(&rig);
    rig.h.provider_store.async_runtime.bus_link.set(
        super::super::async_bus::LinkState::CkbusUnreachable,
        1,
        Some("credential request failed".into()),
    );

    let started = tokio::time::Instant::now();
    let answer = tokio::time::timeout(
        Duration::from_secs(1),
        rig.op("compaction.setup", setup_request("backoff", "backoff")),
    )
    .await
    .expect("backoff refusal must not wait for the next attach");
    assert_eq!(answer["answer"], "refuse", "{answer}");
    assert_eq!(answer["provider_code"], "bus_not_ready", "{answer}");
    assert!(started.elapsed() < Duration::from_secs(1));
}

#[tokio::test]
async fn concurrent_setup_for_another_conversation_completes_with_attach() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.bind_shared_setup_route();
    let publisher = pause_bus_for_attach(&rig);
    let first_handler = rig.h.clone();
    let second_handler = rig.h.clone();
    let started = tokio::time::Instant::now();
    let first = tokio::spawn(async move {
        first_handler
            .dispatch_value(
                7,
                json!({"method":"compaction.setup","params":setup_request("concurrent-a", "a")}),
            )
            .await
    });
    let second = tokio::spawn(async move {
        second_handler
            .dispatch_value(
                7,
                json!({"method":"compaction.setup","params":setup_request("concurrent-b", "b")}),
            )
            .await
    });
    tokio::task::yield_now().await;
    tokio::task::yield_now().await;
    assert!(
        !first.is_finished(),
        "first Setup should be waiting on attach"
    );
    assert!(
        !second.is_finished(),
        "second Setup should be waiting on attach"
    );

    tokio::time::sleep(Duration::from_millis(50)).await;
    finish_bus_attach(&rig.h, publisher);
    let (first, second) =
        tokio::time::timeout(ASYNC_BUS_SETUP_WAIT, async { tokio::join!(first, second) })
            .await
            .expect("both conversations must be released by the same attach");
    let first = response(first.unwrap());
    let second = response(second.unwrap());
    assert_eq!(first["answer"], "ready", "{first}");
    assert_eq!(second["answer"], "ready", "{second}");
    assert!(started.elapsed() < ASYNC_BUS_SETUP_WAIT);
}

#[tokio::test]
async fn broca_async_lane_fires_session_model_without_historian_block() {
    let dir = tempfile::tempdir().unwrap();
    let session_runner =
        crate::providers::session_runner_fake::FakeSessionRunner::for_project(dir.path());
    let rig = Rig::open_with_model(
        dir.path(),
        "broca",
        "broca",
        "provider/session-model",
        json!({"serializer_profile":"opencode-aisdk"}),
        |handler| {
            handler.producer_factory = session_runner.factory_with_max_output_tokens(true);
        },
    )
    .await;
    let resolved_fields = rig.h.async_historian_fields(&rig.state());
    assert_eq!(
        resolved_fields["historian_model_chain"],
        json!(["provider/session-model"])
    );
    rig.fill(40);
    rig.notice(1, 99_000, None).await;
    assert!(
        rig.h
            .provider_store
            .async_runtime
            .historian_evaluations
            .load(std::sync::atomic::Ordering::Relaxed)
            > 0,
        "the notice must reach the real async historian scheduler"
    );

    let sent = tokio::time::timeout(Duration::from_secs(10), session_runner.next_unfinished())
        .await
        .expect("the async historian must send a request instead of recording no_models");

    assert_eq!(sent.model, "provider/session-model");
    assert_eq!(session_runner.sends().len(), 1);
    assert_eq!(session_runner.connects().len(), 1);
    assert_eq!(session_runner.fixed_connects(), 0);
    session_runner.finish(&sent.run_id, "test response".into());
}
