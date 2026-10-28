//! The offline first pass of a moved session (`ck-mc offline first-pass`), and
//! its adoption or discard on the first live notice.
//!
//! The pages come from ck-mc's own fake-runner shape: `served_entries` reads the
//! moved session from `opencode.db` the way THALAMUS's OpenCode 1 runner serves
//! it, and [`export`] writes them one `ReadPage` per line, built and
//! serialised exactly as [`Served`] answers a descriptors-mode `session.read`:
//! every message as `serve_descriptors` serves it, with the runner's digests.
use super::moved_session::served_entries;
use super::*;

#[path = "broca_role_describe_offline.rs"]
mod broca_role_describe;
use crate::offline_first_pass as command;
use crate::offline_move::{self, tests as fixture, HolderCheck, StorePaths};
use crate::providers::offline_first_pass_engine::{EntryInputProof, OfflineOutcome, PagesRunner};
use cortexkit_role_llm_runner::read::ReadPage;

const MODULE: &str = "thalamus-harness";
const LINEAGE: &str = "L";
const CHANNEL: u16 = 7;

/// One page of `entries` from `from`, as the fake runner serves it in
/// descriptors mode and as the export writes it.
fn page_from(entries: &[ReadMessage], lineage: &str, from: u64, size: usize) -> ReadPage {
    let messages = entries
        .iter()
        .filter(|entry| entry.ordinal >= from)
        .take(size)
        .map(serve_descriptors)
        .collect::<Vec<_>>();
    let next = messages
        .last()
        .filter(|last| entries.last().is_some_and(|end| end.ordinal > last.ordinal))
        .map(|last| last.ordinal + 1);
    let page = ReadPage::new(lineage, messages);
    match next {
        Some(next) => page.with_next_from_ordinal(next),
        None => page,
    }
}

/// THALAMUS's export of `entries`: every page from ordinal 0, one per line.
fn export(entries: &[ReadMessage], lineage: &str, size: usize) -> String {
    let mut lines = String::new();
    let mut from = 0;
    loop {
        let page = page_from(entries, lineage, from, size);
        lines.push_str(&serde_json::to_string(&page).unwrap());
        lines.push('\n');
        match page.next_from_ordinal {
            Some(next) => from = next,
            None => return lines,
        }
    }
}

/// The `role.describe` answer of a THALAMUS-style runner hosting compaction
/// for moved sessions: the tags groups with `tag_checkpoint`.
fn runner_describe() -> Value {
    json!({"majors":[{"version":"llm-runner/v1","ops":["role.describe","session.baseline","session.send","session.read","session.resolve"]}],"implementation_version":"fake","session_capabilities_from":"baseline","capabilities":["delivery_order","compaction","tags","tag_checkpoint"]})
}

/// A runner serving `entries` in pages of `page` messages.
struct Served {
    entries: Mutex<Vec<ReadMessage>>,
    lineage: Mutex<String>,
    page: usize,
    reads: std::sync::atomic::AtomicU64,
    sends: Mutex<Vec<Value>>,
    /// The `role.describe` answer; [`runner_describe`] unless a test changes it.
    describe: Mutex<Value>,
}

impl Served {
    fn new(entries: Vec<ReadMessage>, page: usize) -> Arc<Self> {
        Arc::new(Self {
            entries: Mutex::new(entries),
            lineage: Mutex::new(LINEAGE.into()),
            page,
            reads: Default::default(),
            sends: Mutex::new(Vec::new()),
            describe: Mutex::new(runner_describe()),
        })
    }
}

#[async_trait]
impl session_resolver::ProviderRunner for Served {
    async fn call_for_identity(
        &self,
        _: &crate::route_targets::SessionRunnerRoute,
        identity: &session_resolver::RunnerBindIdentity,
        method: &str,
        params: Value,
        budget: Duration,
    ) -> Result<Value, SessionResolveError> {
        self.call(
            &identity.project_root,
            &identity.session,
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
        match method {
            "session.send" => {
                self.sends.lock().unwrap().push(params);
                return Ok(json!({"state":"pending","submission_id":"reminder"}));
            }
            "role.describe" => return Ok(self.describe.lock().unwrap().clone()),
            "session.head" => return Ok(json!({"first_ordinal":0})),
            _ => assert_eq!(method, "session.read"),
        }
        self.reads
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let lineage = self.lineage.lock().unwrap().clone();
        if params["lineage_id"]
            .as_str()
            .is_some_and(|held| held != lineage)
        {
            return Err(SessionResolveError::InvalidResponse(
                "lineage_changed".into(),
            ));
        }
        let from = params["from_ordinal"].as_u64().unwrap();
        let entries = self.entries.lock().unwrap();
        Ok(serde_json::to_value(page_from(&entries, &lineage, from, self.page)).unwrap())
    }
}

/// Records every view announcement.
#[derive(Default)]
struct Announced(Mutex<Vec<u64>>);

#[async_trait]
impl Publisher for Announced {
    async fn publish(&self, ready: &notice::ViewReady) -> Result<(), HandlerOutcome> {
        self.0.lock().unwrap().push(ready.view_version);
        Ok(())
    }
}

fn config() -> McModuleConfig {
    McModuleConfig {
        inject_docs: false,
        protected_tokens_user: Some(0),
        protected_tools: BTreeMap::new(),
        ..Default::default()
    }
}

/// A handler on the stores in `store_dir`, routed as the runner routes a
/// moved OpenCode session of `project`.
fn handler(
    store_dir: &Path,
    project: &Path,
    session: &str,
    runner: Arc<dyn session_resolver::ProviderRunner>,
    config: &McModuleConfig,
) -> McHandler {
    let store = Arc::new(McStore::open_for_test(&fixture::store_descriptor(store_dir)).unwrap());
    let mut h = McHandler::new();
    h.producer_factory =
        crate::providers::session_runner_fake::FakeSessionRunner::for_project(project).factory();
    h.store.set(store).ok().unwrap();
    h.provider_runner = runner;
    h.fixed_config = Some(config.clone());
    h.bind_route(
        CHANNEL,
        SessionBinding {
            principal: Some(subc_protocol::Principal::Reserved {
                module_id: MODULE.into(),
            }),
            scope: None,
            project_root: project.into(),
            harness: "runner".into(),
            session: session.into(),
            model_key: None,
            config: config.clone(),
            history_budget_tokens: 4_000.0,
        },
    );
    h
}

fn setup_request(session: &str, model: &str) -> Value {
    json!({"session":session,"harness":"opencode","request_id":"setup","model":model,"context_window":100_000,
        "composition":{"render_tags":true},"params":{"serializer_profile":"opencode-aisdk"},"lineage_id":LINEAGE,"now":1})
}

/// The live module on one set of stores: Setup, notices and restarts, driven
/// straight through the handler (no bus), so two of them run deterministically
/// side by side.
struct Arm {
    h: Arc<McHandler>,
    runner: Arc<Served>,
    announced: Arc<Announced>,
    store_dir: PathBuf,
    project: PathBuf,
    session: String,
    config: McModuleConfig,
}

impl Arm {
    fn open(
        store_dir: &Path,
        project: &Path,
        session: &str,
        runner: Arc<Served>,
        config: McModuleConfig,
    ) -> Self {
        let h = handler(store_dir, project, session, runner.clone(), &config);
        let announced = Arc::new(Announced::default());
        *h.provider_store.async_runtime.publisher.lock().unwrap() = Some(announced.clone());
        Self {
            h: Arc::new(h),
            runner,
            announced,
            store_dir: store_dir.into(),
            project: project.into(),
            session: session.into(),
            config,
        }
    }

    /// A module restart: the resident copy is gone, the stores remain.
    fn restart(&mut self) {
        // The old handler must let go of the stores before the new one opens
        // them.
        drop(std::mem::replace(&mut self.h, Arc::new(McHandler::new())));
        let reopened = Self::open(
            &self.store_dir,
            &self.project,
            &self.session,
            self.runner.clone(),
            self.config.clone(),
        );
        // The arm keeps one announcement record across restarts.
        *reopened
            .h
            .provider_store
            .async_runtime
            .publisher
            .lock()
            .unwrap() = Some(self.announced.clone());
        self.h = reopened.h;
    }

    fn store(&self) -> &McStore {
        self.h.store.get().unwrap()
    }

    fn reference(&self) -> String {
        runner_session_ref(MODULE, "opencode", &self.session)
    }

    async fn setup(&self, request: Value) -> Value {
        response(
            self.h
                .dispatch_value(
                    CHANNEL,
                    json!({"method":"compaction.setup","params":request}),
                )
                .await,
        )
    }

    fn state(&self) -> State {
        load(self.store(), &self.reference()).unwrap().unwrap()
    }

    async fn settle(&self) {
        for _ in 0..5_000 {
            if self
                .h
                .provider_store
                .async_runtime
                .historian_inflight
                .load(std::sync::atomic::Ordering::SeqCst)
                == 0
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        panic!("historian evaluation did not finish");
    }

    /// Deliver notice `seq` and return its outcome.
    async fn notice(
        &self,
        seq: u64,
        est: u64,
        applied: Option<u64>,
        events: Vec<notice::Event>,
    ) -> String {
        let (last_ordinal, digest) = {
            let entries = self.runner.entries.lock().unwrap();
            let last = entries.last().unwrap();
            (
                last.ordinal,
                contract::digest::content_digest(&last.message),
            )
        };
        let lineage = self.runner.lineage.lock().unwrap().clone();
        let mut notice = notice::AdvanceNotice::new(
            self.reference(),
            seq,
            lineage.clone(),
            last_ordinal,
            digest,
            est,
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
        headers.insert("lineage_id".into(), lineage);
        let notice = notice::AdvanceNotice::from_headers(&headers).unwrap();
        let message = cortexkit_bus_trait::Message {
            subject: notice::event_subject("fixture", MODULE, notice::ADVANCED_EVENT),
            id: bus_id(&self.reference(), "advanced", seq),
            digest: notice.digest().parse().unwrap(),
            headers,
        };
        let outcome = match self.h.advance_compaction("fixture", &message).await {
            Ok(()) => "ok".to_owned(),
            Err(error) => format!("{error:?}"),
        };
        self.settle().await;
        outcome
    }

    /// Every stored view, `(version, view_json, announced)`.
    fn views(&self) -> Vec<(u64, String, i64)> {
        let conn = rusqlite::Connection::open(self.store_dir.join("store.db")).unwrap();
        conn.busy_timeout(Duration::from_secs(30)).unwrap();
        let views = conn.prepare("SELECT version,view_json,announced FROM mc_async_compaction_views WHERE session_ref=?1 ORDER BY version")
            .unwrap()
            .query_map([self.reference()], |row| Ok((row.get::<_, i64>(0)? as u64, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        views
    }

    /// The stored native-edit baselines, by slot.
    fn edit_baselines(&self) -> Vec<(String, String)> {
        let conn = rusqlite::Connection::open(self.store_dir.join("store.db")).unwrap();
        let baselines = conn.prepare("SELECT slot,view_json FROM mc_async_compaction_baselines WHERE session_ref=?1 AND slot IN ('frozen_edits','retired_native_edits') ORDER BY slot")
            .unwrap()
            .query_map([self.reference()], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        baselines
    }

    fn newest(&self) -> Option<u64> {
        self.views().last().map(|(version, ..)| *version)
    }
}

/// The engine's committed state of the conversation's namespace, whole: core,
/// meta, compartments and queued drops.
fn engine_state(store: &McStore, reference: &str) -> Value {
    let head = load_head(store, reference).unwrap().unwrap();
    let namespace = head.namespace();
    let loaded = store.load(&namespace).unwrap();
    let pending = store
        .load_pending_agent_drops(&namespace)
        .unwrap()
        .into_iter()
        .map(|drop| (drop.target_id, drop.queued_at_ms))
        .collect::<Vec<_>>();
    let mut meta = serde_json::to_value(&loaded.meta).unwrap();
    // The historian's decision log stamps its entries from the wall clock,
    // not from the fixed test clock.
    if let Some(decisions) = meta
        .pointer_mut("/historian/recent_decisions")
        .and_then(Value::as_array_mut)
    {
        for decision in decisions {
            if let Some(decision) = decision.as_object_mut() {
                decision.retain(|key, _| !key.ends_with("at_ms"));
            }
        }
    }
    json!({
        "core": format!("{:?}", loaded.core),
        "meta": meta,
        "compartments": format!("{:?}", store.load_compartments(&namespace).unwrap()),
        "pending": pending,
    })
}

/// The members of two engine states that differ, for a failure message.
fn differing(left: &Value, right: &Value) -> Vec<String> {
    let mut keys = Vec::new();
    for part in ["core", "compartments", "pending"] {
        if left[part] != right[part] {
            keys.push(format!("{part}: {} vs {}", left[part], right[part]));
        }
    }
    if let (Some(left), Some(right)) = (left["meta"].as_object(), right["meta"].as_object()) {
        for key in left.keys().chain(right.keys()) {
            if left.get(key) != right.get(key) {
                keys.push(format!(
                    "meta.{key}: {:?} vs {:?}",
                    left.get(key),
                    right.get(key)
                ));
            }
        }
    }
    keys
}

/// The provider-side state a later notice's certificate checks read.
fn certificate_state(state: &State) -> Value {
    json!({
        "logical_prefix": serde_json::to_value(&state.logical_prefix).unwrap(),
        "prefix_input_proof": serde_json::to_value(&state.prefix_input_proof).unwrap(),
        "frozen_edits": state.frozen_edits.json().unwrap(),
        "published": state.published_engine.keys().copied().collect::<Vec<_>>(),
        "entries": state.entries.len(),
        "lineage": state.lineage,
        "generation": state.generation,
    })
}

/// Moved stores in `dir`: `write` builds the standalone session, then the
/// offline move runs. Returns the store paths, the session and what the
/// runner serves for it.
fn moved_stores(
    dir: &Path,
    write: impl FnOnce(&Path) -> (StorePaths, String),
) -> (StorePaths, String, Vec<ReadMessage>) {
    let (paths, session) = write(dir);
    offline_move::run(&paths, &session, false, &fixture::NoHolders, None).unwrap();
    let served = served_entries(&paths.opencode_db, &session);
    (paths, session, served)
}

/// Pin the random history generation `context.db` gives a session's
/// compartments when they are first written. The m1 revision digests the
/// engine commits hash it, so two stores compared with each other need the
/// same value; within one store nothing changes.
fn pin_history_generation(context_db: &Path, session: &str, generations: &[u64]) {
    let key = Key {
        runner: MODULE.into(),
        session: session.into(),
        harness: "opencode".into(),
    };
    let conn = rusqlite::Connection::open(context_db).unwrap();
    for generation in generations {
        conn.execute(
            "INSERT INTO compartment_history_versions(session_id,generation) VALUES (?1,'pinned-by-test')",
            [format!("{}:async:{generation}", key.engine_key())],
        )
        .unwrap();
    }
}

fn fixture_stores(dir: &Path) -> (StorePaths, String) {
    // The fixture puts the marker on the selected cut message, which lets `run`
    // apply the move.
    (
        fixture::write_moved_session_stores(dir),
        fixture::fixture_session(),
    )
}

/// The command's inputs written to `work`, as the window script hands them
/// over.
fn command_args(
    work: &Path,
    paths: &StorePaths,
    session: &str,
    pages: &str,
    setup: &Value,
) -> command::Args {
    std::fs::write(work.join("pages.jsonl"), pages).unwrap();
    std::fs::write(work.join("setup.json"), setup.to_string()).unwrap();
    command::Args {
        paths: paths.clone(),
        session: session.into(),
        pages: work.join("pages.jsonl"),
        setup: work.join("setup.json"),
    }
}

fn setup_file(project: &Path, request: &Value) -> Value {
    json!({"project_root":project,"runner_module":MODULE,"runner_describe":runner_describe(),"request":request})
}

/// Run `ck-mc offline first-pass` as the CLI does, on a test handler: the
/// checks, then the pass on the stores in `args.paths`.
async fn first_pass(
    args: &command::Args,
    project: &Path,
    holders: &dyn HolderCheck,
) -> Result<OfflineOutcome, command::RunError> {
    let mut checked = command::check(args, holders)?;
    let store_dir = args.paths.store_db.parent().unwrap();
    let runner = Arc::new(PagesRunner::new(
        std::mem::take(&mut checked.pages.served),
        checked.setup.runner_describe.clone(),
    ));
    let h = handler(store_dir, project, &args.session, runner, &config());
    command::execute(&h, &checked).await
}

/// The common scenario: moved stores in `store`, the export of what the
/// runner serves in pages of three, and the offline pass run on them.
struct Prepared {
    _work: tempfile::TempDir,
    paths: StorePaths,
    session: String,
    served: Vec<ReadMessage>,
    args: command::Args,
}

async fn prepared(
    store: &Path,
    project: &Path,
    write: impl FnOnce(&Path) -> (StorePaths, String),
) -> (Prepared, OfflineOutcome) {
    let (paths, session, served) = moved_stores(store, write);
    pin_history_generation(&paths.context_db, &session, &[0, 1]);
    let work = tempfile::tempdir().unwrap();
    let args = command_args(
        work.path(),
        &paths,
        &session,
        &export(&served, LINEAGE, 3),
        &setup_file(project, &setup_request(&session, "fixture")),
    );
    let outcome = first_pass(&args, project, &fixture::NoHolders)
        .await
        .unwrap_or_else(|error| panic!("{error:?}"));
    (
        Prepared {
            _work: work,
            paths,
            session,
            served,
            args,
        },
        outcome,
    )
}

/// The proof of `served` as the runner serves it in descriptors mode.
fn proof_of(served: &[ReadMessage]) -> EntryInputProof {
    let mut entries = held_entries::HeldEntries::default();
    for entry in served {
        entries.insert(
            entry.ordinal,
            Arc::new(HeldEntry::from_read(&serve_descriptors(entry)).unwrap()),
        );
    }
    EntryInputProof::of(&entries, LINEAGE, None, codec::Codec::OpencodeAiSdk)
        .unwrap()
        .unwrap()
}

/// Every row of every table in both ck-mc stores, so a run that must write
/// nothing can be checked.
fn store_rows(paths: &StorePaths) -> Vec<(String, Vec<String>)> {
    let mut all = Vec::new();
    for path in [&paths.context_db, &paths.store_db] {
        let conn = rusqlite::Connection::open(path).unwrap();
        let tables = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        for table in tables {
            let mut statement = conn.prepare(&format!("SELECT * FROM \"{table}\"")).unwrap();
            let columns = statement.column_count();
            let mut rows = statement
                .query_map([], |row| {
                    Ok((0..columns)
                        .map(|index| format!("{:?}", row.get_ref(index).unwrap()))
                        .collect::<Vec<_>>()
                        .join("|"))
                })
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap();
            rows.sort();
            all.push((format!("{}:{table}", path.display()), rows));
        }
    }
    all
}

fn refusal_code(outcome: Result<OfflineOutcome, command::RunError>) -> String {
    match outcome {
        Err(command::RunError::Refused(refusal)) => refusal.code.to_owned(),
        other => panic!("expected a refusal, got {other:?}"),
    }
}

/// Change the text of the part at `ordinal`, as a runner whose transcript no
/// longer matches the export would serve it.
fn edit_entry(entries: &mut [ReadMessage], ordinal: u64) {
    let entry = entries
        .iter_mut()
        .find(|entry| entry.ordinal == ordinal)
        .unwrap();
    let parts = entry.message["parts"].as_array_mut().unwrap();
    let text = parts
        .iter_mut()
        .find(|part| part["type"] == "text")
        .expect("a text part");
    text["text"] = json!(format!(
        "{} (edited after the export)",
        text["text"].as_str().unwrap()
    ));
}

#[tokio::test]
async fn offline_first_pass_is_adopted_by_the_first_live_notice_without_a_first_pass() {
    let _clock = crate::tests::fixed_clock();
    let (store, project) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (prep, outcome) = prepared(store.path(), project.path(), fixture_stores).await;
    let OfflineOutcome::Prepared(report) = outcome else {
        panic!("{outcome:?}");
    };
    // The proof stored with the commit is the proof of the exported entries.
    assert_eq!(report.proof, proof_of(&prep.served));
    assert_eq!(report.proof.count, prep.served.len() as u64);
    assert!(report.certified, "the first pass certified its prefix");
    assert_eq!(report.published_views, 1);
    let arm = Arm::open(
        store.path(),
        project.path(),
        &prep.session,
        Served::new(prep.served.clone(), 7),
        config(),
    );
    let stored = load_head(arm.store(), &arm.reference()).unwrap().unwrap();
    let marker = stored
        .offline_first_pass
        .clone()
        .expect("the offline marker");
    assert_eq!(marker.proof.as_ref(), Some(&report.proof));
    assert!(marker.inputs.is_some());
    assert!(
        arm.views().iter().all(|(_, _, announced)| *announced == 0),
        "nothing is announced before a live notice checks the offline pass"
    );
    let engine_before = engine_state(arm.store(), &arm.reference());

    // The same Setup gets the stored answer and adopts nothing yet.
    let answer = arm.setup(setup_request(&prep.session, "fixture")).await;
    assert_eq!(answer["answer"], "ready", "{answer}");
    assert_eq!(answer["checkpoint"]["tag_checkpoint"], 20, "{answer}");
    assert!(load_head(arm.store(), &arm.reference())
        .unwrap()
        .unwrap()
        .offline_first_pass
        .is_some());

    // The first live notice adopts the stored pass: no engine pass over the
    // whole transcript runs, and the committed engine state is the offline one.
    let reference = arm.reference();
    {
        let state = arm.state();
        let prefix = state.logical_prefix.clone().expect("a stored certificate");
        let loaded = arm
            .store()
            .load_logical_transform_snapshot(&state.namespace(), &[])
            .unwrap()
            .loaded;
        let compartments = arm.store().load_compartments(&state.namespace()).unwrap();
        assert!(
            prefix.matches(LINEAGE, state.generation, &loaded, &compartments),
            "the stored certificate matches the stored engine state"
        );
        assert!(state
            .entries
            .matches(state.prefix_input_proof.as_ref(), prefix.tail_from));
    }
    scaling_tests::view_work::take(&reference);
    let passes = resident::counters::read().engine_passes;
    assert_eq!(arm.notice(1, 0, None, Vec::new()).await, "ok");
    let state = arm.state();
    assert!(state.offline_first_pass.is_none(), "adopted");
    assert_eq!(
        state.generation, 0,
        "adoption keeps the prepared generation"
    );
    let work = scaling_tests::view_work::take(&reference);
    let ran = resident::counters::read().engine_passes - passes;
    assert!(
        ran == 0 || work.engine_input < prep.served.len(),
        "the adopting notice ran a full-input engine pass: passes={ran} input={} reason={}",
        work.engine_input,
        resident::counters::last_engine_reason()
    );
    if ran == 0 {
        // Later phases of the notice (the historian's cadence) still record
        // their decisions in meta; the pass's own state is the offline one.
        assert_eq!(
            engine_state(arm.store(), &reference)["core"],
            engine_before["core"]
        );
    }
    // The provider's own certificate checks hold on the adopted record.
    let prefix = state.logical_prefix.clone().expect("a certificate");
    assert!(state
        .entries
        .matches(state.prefix_input_proof.as_ref(), prefix.tail_from));
    assert_eq!(
        state.entries.first_key_value().map(|(ordinal, _)| *ordinal),
        Some(prefix.from)
    );
    assert!(prefix.context_sources.iter().all(|(ordinal, source)| state
        .entries
        .get(ordinal)
        .is_some_and(|entry| entry.mid == source.mid && source.ordinal == *ordinal)));
    assert_eq!(
        *arm.announced.0.lock().unwrap(),
        vec![1],
        "the adopted view is announced after the check"
    );

    // The next notice runs on the certified prefix, not the whole transcript.
    {
        let mut entries = arm.runner.entries.lock().unwrap();
        let next = entries.len() as u64;
        let tag = highest_tag(&entries) + 1;
        entries.push(appended(&prep.session, next, tag));
    }
    assert_eq!(arm.notice(2, 0, Some(1), Vec::new()).await, "ok");
    let work = scaling_tests::view_work::take(&reference);
    assert!(
        work.engine_input < prep.served.len(),
        "later notices take the certified path: engine input {}",
        work.engine_input
    );
}

/// The highest runner tag number in `entries`.
fn highest_tag(entries: &[ReadMessage]) -> u64 {
    entries
        .iter()
        .flat_map(|entry| entry.tags.iter().filter_map(|row| row.tag.as_deref()))
        .filter_map(tags::parse_tag)
        .max()
        .unwrap_or(0)
}

/// The `n`th message after the export, with one tagged text part numbered
/// `tag`, in the OpenCode shape the runner serves.
fn appended(session: &str, n: u64, tag: u64) -> ReadMessage {
    let mid = format!("msg_n{n:05}");
    let part = format!("prt_n{n:05}_a");
    let role = if n.is_multiple_of(2) {
        "user"
    } else {
        "assistant"
    };
    ReadMessage::new(
        n,
        mid.clone(),
        json!({"info":{"id":mid,"sessionID":session,"role":role,"time":{"created":10_000 + n}},
            "parts":[{"id":part,"messageID":mid,"sessionID":session,"type":"text","text":format!("later message {n} ")+&"words ".repeat(12)}]}),
    )
    .with_tags(vec![tags::PartTag::tagged(part, format!("§{tag}§"))])
}

#[tokio::test]
async fn a_changed_entry_discards_the_offline_first_pass_and_runs_the_ordinary_one() {
    let _clock = crate::tests::fixed_clock();
    let (store, project) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (prep, _) = prepared(store.path(), project.path(), fixture_stores).await;
    // The runner now serves one entry differently from the export.
    let mut changed = prep.served.clone();
    edit_entry(&mut changed, 2);
    let arm = Arm::open(
        store.path(),
        project.path(),
        &prep.session,
        Served::new(changed.clone(), 7),
        config(),
    );
    let offline_view = arm.views();
    assert_eq!(
        arm.setup(setup_request(&prep.session, "fixture")).await["answer"],
        "ready"
    );
    assert_eq!(arm.notice(1, 0, None, Vec::new()).await, "ok");
    let state = arm.state();
    assert!(state.offline_first_pass.is_none());
    assert_eq!(state.generation, 1, "the stored pass was discarded");
    assert!(
        state
            .standalone_move
            .as_ref()
            .is_some_and(|moved| moved.pending.is_none()),
        "the moved import was bound again on the fresh record"
    );
    // Nothing of the offline pass is kept: the held entries are the served
    // ones, the offline view was never announced, and the fresh record has
    // its own first view.
    for entry in &changed {
        assert!(stable_entry(
            &state.entries[&entry.ordinal].read().unwrap(),
            &serve_descriptors(entry)
        ));
    }
    let views = arm.views();
    assert_eq!(views[0].2, -1, "the offline view is retired unannounced");
    assert_eq!(views[0].1, offline_view[0].1);
    assert!(views.len() >= 2, "the ordinary first pass published a view");
    assert!(!arm.announced.0.lock().unwrap().contains(&views[0].0));

    // The ordinary first pass, run on the same served entries in stores that
    // never saw the offline command, commits the same engine state.
    let control_store = tempfile::tempdir().unwrap();
    let (control_paths, _, _) = moved_stores(control_store.path(), fixture_stores);
    pin_history_generation(&control_paths.context_db, &prep.session, &[0]);
    let control = Arm::open(
        control_store.path(),
        project.path(),
        &prep.session,
        Served::new(changed.clone(), 7),
        config(),
    );
    assert_eq!(
        control.setup(setup_request(&prep.session, "fixture")).await["answer"],
        "ready"
    );
    assert_eq!(control.notice(1, 0, None, Vec::new()).await, "ok");
    // Only the namespace name differs: the fresh record lives one generation on.
    let engine_key = control.state().key.engine_key();
    let generation = |value: Value, generation: u64| {
        value
            .to_string()
            .replace(&format!("{engine_key}:async:{generation}"), "<namespace>")
    };
    let (left, right) = (
        generation(engine_state(arm.store(), &arm.reference()), 1),
        generation(engine_state(control.store(), &control.reference()), 0),
    );
    assert!(
        left == right,
        "{:?}",
        differing(
            &serde_json::from_str(&left).unwrap(),
            &serde_json::from_str(&right).unwrap()
        )
    );
    let ranges = |views: Vec<(u64, String, i64)>| {
        let view: view::CompactionView = serde_json::from_str(&views.last().unwrap().1).unwrap();
        serde_json::to_string(&view.ranges).unwrap()
    };
    assert_eq!(ranges(arm.views()), ranges(control.views()));
}

#[tokio::test]
async fn a_live_setup_that_differs_discards_the_offline_first_pass() {
    let _clock = crate::tests::fixed_clock();
    let (store, project) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (prep, _) = prepared(store.path(), project.path(), fixture_stores).await;
    let arm = Arm::open(
        store.path(),
        project.path(),
        &prep.session,
        Served::new(prep.served.clone(), 7),
        config(),
    );
    let offline_edits = arm.edit_baselines();
    // Another model than the one the pass was prepared under.
    let answer = arm.setup(setup_request(&prep.session, "fixture-2")).await;
    assert_eq!(answer["answer"], "ready", "{answer}");
    let state = arm.state();
    assert!(state.offline_first_pass.is_none());
    assert_eq!(state.generation, 1);
    assert!(state.entries.is_empty(), "no offline entry survives");
    assert_eq!(state.setup.model, "fixture-2");
    let empty = frozen_edits::FrozenEdits::default().json().unwrap();
    assert!(
        offline_edits
            .iter()
            .any(|(slot, json)| slot == "frozen_edits" && *json != empty),
        "the offline pass carried the moved drops as native edits: {offline_edits:?}"
    );
    assert!(
        arm.edit_baselines()
            .iter()
            .any(|(slot, json)| slot == "frozen_edits" && *json == empty),
        "the offline native edits are gone: {:?}",
        arm.edit_baselines()
    );
    assert_eq!(arm.notice(1, 0, None, Vec::new()).await, "ok");
    let state = arm.state();
    assert_eq!(state.entries.len(), prep.served.len());
    assert!(state.published_engine.keys().any(|version| *version > 1));
}

#[tokio::test]
async fn inputs_that_changed_after_the_offline_pass_discard_it() {
    let _clock = crate::tests::fixed_clock();
    let (store, project) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (prep, _) = prepared(store.path(), project.path(), fixture_stores).await;
    let changed = McModuleConfig {
        protected_tokens_user: Some(1),
        ..config()
    };
    let arm = Arm::open(
        store.path(),
        project.path(),
        &prep.session,
        Served::new(prep.served.clone(), 7),
        changed,
    );
    assert_eq!(
        arm.setup(setup_request(&prep.session, "fixture")).await["answer"],
        "ready"
    );
    assert!(
        arm.state().offline_first_pass.is_some(),
        "the Setup itself matches"
    );
    assert_eq!(arm.notice(1, 0, None, Vec::new()).await, "ok");
    let state = arm.state();
    assert!(state.offline_first_pass.is_none());
    assert_eq!(
        state.generation, 1,
        "a changed configuration discards the pass"
    );
}

#[tokio::test]
async fn an_offline_run_that_stopped_before_its_proof_is_never_adopted() {
    let _clock = crate::tests::fixed_clock();
    let (store, project) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (prep, _) = prepared(store.path(), project.path(), fixture_stores).await;
    // The record as a run stopped before its last save leaves it: marked, but
    // with no proof.
    let reference = runner_session_ref(MODULE, "opencode", &prep.session);
    let conn = rusqlite::Connection::open(store.path().join("store.db")).unwrap();
    let raw: String = conn
        .query_row(
            "SELECT state_json FROM mc_async_compaction WHERE session_ref=?1",
            [&reference],
            |row| row.get(0),
        )
        .unwrap();
    let mut record: Value = serde_json::from_str(&raw).unwrap();
    record["offline_first_pass"]
        .as_object_mut()
        .unwrap()
        .retain(|key, _| key != "proof" && key != "inputs");
    conn.execute(
        "UPDATE mc_async_compaction SET state_json=?1 WHERE session_ref=?2",
        rusqlite::params![record.to_string(), reference],
    )
    .unwrap();
    drop(conn);
    assert_eq!(
        refusal_code(first_pass(&prep.args, project.path(), &fixture::NoHolders).await),
        "offline_run_incomplete"
    );
    let arm = Arm::open(
        store.path(),
        project.path(),
        &prep.session,
        Served::new(prep.served.clone(), 7),
        config(),
    );
    assert_eq!(
        arm.setup(setup_request(&prep.session, "fixture")).await["answer"],
        "ready"
    );
    assert_eq!(arm.notice(1, 0, None, Vec::new()).await, "ok");
    let state = arm.state();
    assert!(state.offline_first_pass.is_none());
    assert_eq!(state.generation, 1, "an unproven run is discarded");
}

#[tokio::test]
async fn a_rerun_leaves_the_prepared_state_unchanged_or_refuses_by_name() {
    let _clock = crate::tests::fixed_clock();
    let (store, project) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (prep, _) = prepared(store.path(), project.path(), fixture_stores).await;
    let before = store_rows(&prep.paths);
    // The same pages in other page sizes: the proof has no page boundaries.
    for size in [3, 1, 5, 100] {
        let work = tempfile::tempdir().unwrap();
        let args = command_args(
            work.path(),
            &prep.paths,
            &prep.session,
            &export(&prep.served, LINEAGE, size),
            &setup_file(project.path(), &setup_request(&prep.session, "fixture")),
        );
        let outcome = first_pass(&args, project.path(), &fixture::NoHolders).await;
        assert!(
            matches!(outcome, Ok(OfflineOutcome::Unchanged(_))),
            "page size {size}: {outcome:?}"
        );
        assert!(
            store_rows(&prep.paths) == before,
            "an unchanged rerun wrote"
        );
    }
    let mut changed = prep.served.clone();
    edit_entry(&mut changed, 2);
    for (pages, setup) in [
        (
            export(&changed, LINEAGE, 3),
            setup_request(&prep.session, "fixture"),
        ),
        (
            export(&prep.served, LINEAGE, 3),
            setup_request(&prep.session, "fixture-2"),
        ),
    ] {
        let work = tempfile::tempdir().unwrap();
        let args = command_args(
            work.path(),
            &prep.paths,
            &prep.session,
            &pages,
            &setup_file(project.path(), &setup),
        );
        assert_eq!(
            refusal_code(first_pass(&args, project.path(), &fixture::NoHolders).await),
            "offline_state_differs"
        );
        assert!(store_rows(&prep.paths) == before, "a refused rerun wrote");
    }

    // A session ck-mc already set up live is not offline work any more.
    let live_store = tempfile::tempdir().unwrap();
    let (paths, session, served) = moved_stores(live_store.path(), fixture_stores);
    let live = Arm::open(
        live_store.path(),
        project.path(),
        &session,
        Served::new(served.clone(), 7),
        config(),
    );
    assert_eq!(
        live.setup(setup_request(&session, "fixture")).await["answer"],
        "ready"
    );
    drop(live);
    let work = tempfile::tempdir().unwrap();
    let args = command_args(
        work.path(),
        &paths,
        &session,
        &export(&served, LINEAGE, 3),
        &setup_file(project.path(), &setup_request(&session, "fixture")),
    );
    assert_eq!(
        refusal_code(first_pass(&args, project.path(), &fixture::NoHolders).await),
        "async_record_exists"
    );
}

struct HeldBy(&'static str);
impl HolderCheck for HeldBy {
    fn holders(&self, _: &[PathBuf]) -> Result<Vec<String>, String> {
        Ok(vec![self.0.to_owned()])
    }
}

struct Unproven;
impl HolderCheck for Unproven {
    fn holders(&self, _: &[PathBuf]) -> Result<Vec<String>, String> {
        Err("lsof could not run".into())
    }
}

#[tokio::test]
async fn the_command_refuses_each_case_by_name_without_writing() {
    let project = tempfile::tempdir().unwrap();
    let store = tempfile::tempdir().unwrap();
    let (paths, session, served) = moved_stores(store.path(), fixture_stores);
    let setup = setup_file(project.path(), &setup_request(&session, "fixture"));
    let pages = export(&served, LINEAGE, 3);
    let lines = pages.lines().map(str::to_owned).collect::<Vec<_>>();
    let joined = |lines: &[String]| lines.join("\n") + "\n";
    let mut shifted = served.clone();
    for entry in &mut shifted {
        for row in &mut entry.tags {
            if let Some(tag) = &row.tag {
                row.tag = Some(format!("§{}§", tags::parse_tag(tag).unwrap() + 1));
            }
        }
    }
    let wrapped = {
        let mut lines = lines.clone();
        lines[1] = json!({"result": serde_json::from_str::<Value>(&lines[1]).unwrap()}).to_string();
        lines
    };
    let gap = {
        let mut lines = lines.clone();
        lines.remove(1);
        lines
    };
    let other_session = {
        let mut setup = setup.clone();
        setup["request"]["session"] = json!("ses_other");
        setup
    };
    // The same session handle with a trailing space: handles are exact bytes.
    let padded_session = {
        let mut setup = setup.clone();
        setup["request"]["session"] = json!(format!("{session} "));
        setup
    };
    // A page whose second message lacks the runner's digests, as an inline
    // (not descriptors-mode) read would serve it.
    let undigested = {
        let mut lines = lines.clone();
        let mut page: Value = serde_json::from_str(&lines[0]).unwrap();
        let message = page["messages"][1].as_object_mut().unwrap();
        message.remove("digest");
        message.remove("part_digests");
        lines[0] = page.to_string();
        lines
    };
    let unreadable_describe = {
        let mut setup = setup.clone();
        setup["runner_describe"] = json!({"capabilities":["tag_checkpoint"]});
        setup
    };
    let before = store_rows(&paths);
    let cases: Vec<(&str, String, Value, &dyn HolderCheck)> = vec![
        (
            "stores_in_use",
            pages.clone(),
            setup.clone(),
            &HeldBy("opencode/42"),
        ),
        (
            "offline_exclusivity_unproven",
            pages.clone(),
            setup.clone(),
            &Unproven,
        ),
        (
            "pages_not_chained",
            joined(&lines[1..]),
            setup.clone(),
            &fixture::NoHolders,
        ),
        (
            "pages_not_chained",
            joined(&gap),
            setup.clone(),
            &fixture::NoHolders,
        ),
        (
            "pages_not_chained",
            joined(&lines[..lines.len() - 1]),
            setup.clone(),
            &fixture::NoHolders,
        ),
        (
            "pages_bare_wrapped_mismatch",
            joined(&wrapped),
            setup.clone(),
            &fixture::NoHolders,
        ),
        (
            "pages_unreadable",
            "{not json}\n".into(),
            setup.clone(),
            &fixture::NoHolders,
        ),
        (
            "checkpoint_mismatch",
            export(&shifted, LINEAGE, 3),
            setup.clone(),
            &fixture::NoHolders,
        ),
        (
            "setup_session_mismatch",
            pages.clone(),
            other_session,
            &fixture::NoHolders,
        ),
        (
            "setup_session_mismatch",
            pages.clone(),
            padded_session,
            &fixture::NoHolders,
        ),
        (
            "served_digest_missing",
            joined(&undigested),
            setup.clone(),
            &fixture::NoHolders,
        ),
        (
            "setup_unreadable",
            pages.clone(),
            unreadable_describe,
            &fixture::NoHolders,
        ),
        (
            "setup_unreadable",
            pages.clone(),
            json!({"project_root":"relative","runner_module":MODULE,"request":setup["request"]}),
            &fixture::NoHolders,
        ),
    ];
    for (code, pages, setup, holders) in cases {
        let work = tempfile::tempdir().unwrap();
        let args = command_args(work.path(), &paths, &session, &pages, &setup);
        assert_eq!(
            refusal_code(first_pass(&args, project.path(), holders).await),
            code
        );
        assert!(store_rows(&paths) == before, "{code} wrote");
    }

    // A standalone session that was never moved.
    let unmoved = tempfile::tempdir().unwrap();
    let unmoved_paths = fixture::write_stores(unmoved.path());
    let work = tempfile::tempdir().unwrap();
    let args = command_args(work.path(), &unmoved_paths, &session, &pages, &setup);
    let before = store_rows(&unmoved_paths);
    assert_eq!(
        refusal_code(first_pass(&args, project.path(), &fixture::NoHolders).await),
        "session_not_moved"
    );
    assert!(store_rows(&unmoved_paths) == before);
}

#[tokio::test]
async fn a_runner_describe_without_tag_checkpoint_is_refused_offline_by_name() {
    let _clock = crate::tests::fixed_clock();
    let project = tempfile::tempdir().unwrap();
    let store = tempfile::tempdir().unwrap();
    let (paths, session, served) = moved_stores(store.path(), fixture_stores);
    let mut setup = setup_file(project.path(), &setup_request(&session, "fixture"));
    setup["runner_describe"]["capabilities"] = json!(["delivery_order", "compaction", "tags"]);
    let work = tempfile::tempdir().unwrap();
    let args = command_args(
        work.path(),
        &paths,
        &session,
        &export(&served, LINEAGE, 3),
        &setup,
    );
    assert_eq!(
        refusal_code(first_pass(&args, project.path(), &fixture::NoHolders).await),
        "tag_checkpoint_unsupported"
    );
    let reference = runner_session_ref(MODULE, "opencode", &session);
    let store = McStore::open_for_test(&fixture::store_descriptor(store.path())).unwrap();
    assert!(
        load_head(&store, &reference).unwrap().is_none(),
        "the refused Setup stored no record"
    );
}

/// The proof reads the runner's served digests and never computes one in
/// their place: an entry held without them (an inline read) has no proof.
#[test]
fn the_entry_proof_refuses_an_entry_without_served_digests() {
    let entry = appended("ses", 0, 1);
    let mut entries = held_entries::HeldEntries::default();
    entries.insert(0, Arc::new(HeldEntry::from_read(&entry).unwrap()));
    let error =
        EntryInputProof::of(&entries, LINEAGE, None, codec::Codec::OpencodeAiSdk).unwrap_err();
    assert!(
        format!("{error:?}").contains("served_digest_missing"),
        "{error:?}"
    );
    let mut served = held_entries::HeldEntries::default();
    served.insert(
        0,
        Arc::new(HeldEntry::from_read(&serve_descriptors(&entry)).unwrap()),
    );
    assert!(
        EntryInputProof::of(&served, LINEAGE, None, codec::Codec::OpencodeAiSdk)
            .unwrap()
            .is_some()
    );
}

/// A runner whose `role.describe` changed since the export, as a THALAMUS
/// upgrade in the restart window would.
fn changed_describe() -> Value {
    let mut describe = runner_describe();
    describe["implementation_version"] = json!("fake-2");
    describe
}

#[tokio::test]
async fn a_live_runner_describe_that_differs_discards_the_offline_first_pass_at_setup() {
    let _clock = crate::tests::fixed_clock();
    let (store, project) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (prep, _) = prepared(store.path(), project.path(), fixture_stores).await;
    let runner = Served::new(prep.served.clone(), 7);
    *runner.describe.lock().unwrap() = changed_describe();
    let arm = Arm::open(
        store.path(),
        project.path(),
        &prep.session,
        runner,
        config(),
    );
    let answer = arm.setup(setup_request(&prep.session, "fixture")).await;
    assert_eq!(answer["answer"], "ready", "{answer}");
    assert_eq!(answer["checkpoint"]["tag_checkpoint"], 20, "{answer}");
    let state = arm.state();
    assert!(state.offline_first_pass.is_none());
    assert_eq!(
        state.generation, 1,
        "the stored pass was discarded at Setup"
    );
    assert!(state.entries.is_empty(), "no offline entry survives");
    assert_eq!(arm.notice(1, 0, None, Vec::new()).await, "ok");
    assert_eq!(arm.state().entries.len(), prep.served.len());
}

#[tokio::test]
async fn a_live_runner_describe_that_differs_discards_the_offline_first_pass_at_the_first_notice() {
    let _clock = crate::tests::fixed_clock();
    let (store, project) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (prep, _) = prepared(store.path(), project.path(), fixture_stores).await;
    let runner = Served::new(prep.served.clone(), 7);
    *runner.describe.lock().unwrap() = changed_describe();
    let arm = Arm::open(
        store.path(),
        project.path(),
        &prep.session,
        runner,
        config(),
    );
    // No Setup on this module first: the notice's own check must catch it.
    assert_eq!(arm.notice(1, 0, None, Vec::new()).await, "ok");
    let state = arm.state();
    assert!(state.offline_first_pass.is_none());
    assert_eq!(
        state.generation, 1,
        "a changed runner describe discards the pass"
    );
}

// ── Differential: offline first pass against the live full first pass ──

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }
}

/// The moved fixture with the band between the cut and the coverage end
/// loaded: the last summary ends at a partial endpoint inside m006 (the end
/// of coverage, C), after its text part and before its tool part, whose call
/// and result therefore sit in C's message outside coverage; and queued
/// drops are stamped on both of m006's parts, inside (cut, C].
fn band_fixture_stores(dir: &Path) -> (StorePaths, String) {
    let paths = fixture::write_stores(dir);
    let session = fixture::fixture_session();
    let conn = rusqlite::Connection::open(&paths.context_db).unwrap();
    conn.execute(
        "UPDATE compartments SET end_block_index=0 WHERE session_id=?1 AND sequence=2",
        [&session],
    )
    .unwrap();
    for (tag, at) in [(8, 1_700_000_100_010i64), (9, 1_700_000_100_011)] {
        conn.execute(
            "INSERT INTO pending_ops(session_id,tag_id,operation,queued_at,harness) VALUES (?1,?2,'drop',?3,'opencode')",
            rusqlite::params![session, tag, at],
        )
        .unwrap();
    }
    (paths, session)
}

/// A seeded standalone session: its length, tail after the cut, text size
/// and summary count vary with `seed`.
fn seeded_stores(seed: u64) -> impl Fn(&Path) -> (StorePaths, String) {
    move |dir| {
        let mut rng = Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1);
        let messages = 16 + rng.below(90) as usize;
        let tail = 3 + rng.below((messages as u64 / 3).min(30)) as usize;
        let shape = fixture::Synthetic {
            messages,
            tail,
            text_bytes: 40 + rng.below(400) as usize,
            compartments: 1 + rng.below(5) as usize,
        };
        (
            fixture::write_synthetic_stores(dir, &shape),
            fixture::SYNTHETIC_SESSION.to_owned(),
        )
    }
}

/// Everything a runner, a model or a later pass can observe of one arm.
fn observed(arm: &Arm) -> Value {
    let state = arm.state();
    json!({
        "views": arm.views(),
        "edit_baselines": arm.edit_baselines(),
        "announced": *arm.announced.0.lock().unwrap(),
        "engine": engine_state(arm.store(), &arm.reference()),
        "certificate": certificate_state(&state),
        "decisions": [state.seq, state.completed_seq, state.applied.unwrap_or(0), state.generation],
        "offline": state.offline_first_pass.is_some(),
        "sends": arm.runner.sends.lock().unwrap().len(),
    })
}

fn assert_same(label: &str, offline: &Value, live: &Value) {
    if offline == live {
        return;
    }
    let keys = offline
        .as_object()
        .unwrap()
        .keys()
        .filter(|key| offline[*key] != live[*key])
        .cloned()
        .collect::<Vec<_>>();
    let detail = if offline["engine"] != live["engine"] {
        format!("{:?}", differing(&offline["engine"], &live["engine"]))
    } else {
        String::new()
    };
    panic!(
        "{label}: the offline-prepared arm diverged from the live first pass in {keys:?} {detail}\noffline: {}\nlive: {}",
        offline.to_string().chars().take(3_000).collect::<String>(),
        live.to_string().chars().take(3_000).collect::<String>()
    );
}

/// Append one summary over the next messages after the current coverage to
/// both arms, as a historian publish does, and arm the soft refresh that
/// makes the next pass fold it.
fn publish_summary(arm: &Arm, end: u64) {
    let state = arm.state();
    let namespace = state.namespace();
    let store = arm.store();
    let mut compartments = store.load_compartments(&namespace).unwrap();
    let (sequence, start) = compartments
        .last()
        .map_or((1, 0), |last| (last.sequence + 1, last.end_message + 1));
    let mid = |ordinal: i64| state.entries[&(ordinal as u64)].mid.clone();
    compartments.push(mc_store::StoredCompartment {
        sequence,
        start_message: start,
        end_message: end as i64,
        start_message_id: format!("{}#0", mid(start)),
        end_message_id: format!("{}#0", mid(end as i64)),
        title: format!("later {sequence}"),
        content: format!("summary {sequence} through {end}"),
        p1: Some(format!("summary {sequence} through {end}")),
        importance: 50,
        ..Default::default()
    });
    store
        .replace_compartments(&namespace, &compartments)
        .unwrap();
    store.arm_soft_refresh(&namespace).unwrap();
}

/// Run one session both ways and compare: the offline command then the live
/// module (`offline`), and the live module alone (`live`), on identical moved
/// stores, identical served entries and a fixed clock. First the committed
/// state of the offline command against the live first pass, then everything
/// observable after the adopting notice and after `steps` further notices
/// (appends, defers, summary publishes that force a Hard, module restarts).
async fn differential(
    label: &str,
    write: impl Fn(&Path) -> (StorePaths, String),
    seed: u64,
    steps: usize,
) {
    let _clock = crate::tests::fixed_clock();
    let project = tempfile::tempdir().unwrap();
    let (offline_dir, live_dir) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (prep, outcome) = prepared(offline_dir.path(), project.path(), &write).await;
    assert!(
        matches!(outcome, OfflineOutcome::Prepared(_)),
        "{label}: {outcome:?}"
    );
    let (live_paths, session, served) = moved_stores(live_dir.path(), &write);
    pin_history_generation(&live_paths.context_db, &session, &[0, 1]);
    assert_eq!(
        served, prep.served,
        "{label}: both arms serve the same entries"
    );
    let mut live = Arm::open(
        live_dir.path(),
        project.path(),
        &session,
        Served::new(served.clone(), 7),
        config(),
    );
    let mut offline = Arm::open(
        offline_dir.path(),
        project.path(),
        &session,
        Served::new(served.clone(), 7),
        config(),
    );
    let live_setup = live.setup(setup_request(&session, "fixture")).await;
    assert_eq!(live.notice(1, 0, None, Vec::new()).await, "ok", "{label}");

    // The state the offline command committed is the state the live first
    // pass committed on the same entries.
    let mut prepared_state = observed(&offline);
    let mut first_pass = observed(&live);
    for value in [&mut prepared_state, &mut first_pass] {
        // Only the live arm has answered a notice and announced its view, and
        // only its notice went on to the historian cadence, which records its
        // decision in meta after the pass.
        for key in ["announced", "decisions", "offline"] {
            value.as_object_mut().unwrap().remove(key);
        }
        value["engine"]["meta"]
            .as_object_mut()
            .unwrap()
            .remove("historian");
        for view in value["views"].as_array_mut().unwrap() {
            view.as_array_mut().unwrap().truncate(2);
        }
    }
    assert_same(
        &format!("{label} committed first pass"),
        &prepared_state,
        &first_pass,
    );

    // The same Setup answers the same; the first notice adopts.
    assert_eq!(
        offline.setup(setup_request(&session, "fixture")).await,
        live_setup,
        "{label}"
    );
    assert_eq!(
        offline.notice(1, 0, None, Vec::new()).await,
        "ok",
        "{label}"
    );
    assert!(
        offline.state().offline_first_pass.is_none(),
        "{label}: adopted"
    );
    assert_same(
        &format!("{label} notice 1"),
        &observed(&offline),
        &observed(&live),
    );

    let mut rng = Rng(seed | 1);
    let mut seq = 1;
    let mut log = Vec::new();
    for _ in 0..steps {
        let newest = live.newest();
        let mut events = Vec::new();
        let est = 1_000 + rng.below(40_000);
        match rng.below(10) {
            0..=4 => {
                let count = 1 + rng.below(3);
                for arm in [&offline, &live] {
                    let mut entries = arm.runner.entries.lock().unwrap();
                    for _ in 0..count {
                        let (next, tag) = (entries.len() as u64, highest_tag(&entries) + 1);
                        entries.push(appended(&session, next, tag));
                    }
                }
                log.push(format!("append {count}"));
            }
            5..=6 => {
                if let Some(version) = newest {
                    events.push(notice::Event::ViewDeferred {
                        view_version: version,
                        reason: "mid_turn".into(),
                    });
                }
                log.push("defer".to_owned());
            }
            7..=8 => {
                let held = live.state();
                let coverage = live
                    .store()
                    .load_compartments(&held.namespace())
                    .unwrap()
                    .last()
                    .map_or(-1, |last| last.end_message);
                let last = held.entries.last_key_value().map_or(0, |(n, _)| *n) as i64;
                // A Hard over appended messages only: their one text part is block 0.
                let first_appended = prep.served.len() as i64;
                if last - 2 > coverage.max(first_appended - 1) {
                    let end = (coverage.max(first_appended - 1)
                        + 1
                        + rng.below((last - 2 - coverage.max(first_appended - 1)) as u64) as i64)
                        as u64;
                    publish_summary(&offline, end);
                    publish_summary(&live, end);
                    log.push(format!("summary through {end}"));
                } else {
                    log.push("summary skipped".to_owned());
                }
            }
            _ => {
                offline.restart();
                live.restart();
                log.push("restart".to_owned());
            }
        }
        seq += 1;
        let applied = newest.filter(|_| rng.below(4) > 0);
        let offline_outcome = offline.notice(seq, est, applied, events.clone()).await;
        let live_outcome = live.notice(seq, est, applied, events).await;
        assert_eq!(offline_outcome, live_outcome, "{label} after {log:?}");
        assert_same(
            &format!("{label} notice {seq} after {log:?}"),
            &observed(&offline),
            &observed(&live),
        );
    }
}

#[tokio::test]
async fn offline_first_pass_matches_the_live_first_pass_on_the_moved_fixture() {
    differential("fixture", fixture_stores, 7, 20).await;
}

#[tokio::test]
async fn offline_first_pass_refuses_the_partial_endpoint_band_with_block_index() {
    // Only whole-message summaries are admitted: the band's last summary ends
    // at a block index inside m006, so the move refuses before any write. The
    // band's queued drops on m006 and its tool arc outside coverage were the
    // partial-endpoint shape; with whole-message endpoints that shape cannot
    // exist (the call and result would sit inside C), and the moved-fixture
    // differential already covers whole-message drops after the cut. No
    // whole-message variant of this band is kept.
    let dir = tempfile::tempdir().unwrap();
    let (paths, session) = band_fixture_stores(dir.path());
    let before = store_rows(&paths);
    let outcome = offline_move::run(&paths, &session, false, &fixture::NoHolders, None);
    let Err(offline_move::MoveError::Refused(refusal)) = outcome else {
        panic!("expected a block_index refusal, got {outcome:?}");
    };
    assert_eq!(refusal.code, "block_index");
    assert_eq!(store_rows(&paths), before, "a refusal wrote");
}

async fn seeded(seeds: std::ops::Range<u64>) {
    for seed in seeds {
        differential(&format!("seed {seed}"), seeded_stores(seed), seed, 20).await;
    }
}

#[tokio::test]
async fn offline_first_pass_matches_the_live_first_pass_over_seeded_sessions_0_to_24() {
    seeded(0..25).await;
}

#[tokio::test]
async fn offline_first_pass_matches_the_live_first_pass_over_seeded_sessions_25_to_49() {
    seeded(25..50).await;
}

// ── Cost on a 175,000-message moved session ──

const COST_DIR: &str = "OFFLINE_FIRST_PASS_175K_DIR";

/// The offline run and then the live adoption, in a child process so its peak
/// memory leaves out building the fixture. The offline peak is read before the
/// live phase loads the fake runner's own copy of the transcript.
#[tokio::test(flavor = "current_thread")]
#[ignore = "child of offline_first_pass_175k_cost"]
async fn offline_first_pass_175k_child() {
    let Some(dir) = std::env::var_os(COST_DIR) else {
        return;
    };
    let dir = PathBuf::from(dir);
    let (store, project) = (dir.join("stores"), dir.join("project"));
    let session = fixture::SYNTHETIC_SESSION;
    let args = command::Args {
        paths: StorePaths {
            opencode_db: store.join("opencode.db"),
            context_db: store.join("context.db"),
            store_db: store.join("store.db"),
        },
        session: session.into(),
        pages: dir.join("pages.jsonl"),
        setup: dir.join("setup.json"),
    };
    let before = command::peak_rss_kib();
    let started = Instant::now();
    let outcome = first_pass(&args, &project, &fixture::NoHolders)
        .await
        .unwrap_or_else(|error| panic!("{error:?}"));
    let offline_ms = started.elapsed().as_millis();
    let offline_peak = command::peak_rss_kib();
    let OfflineOutcome::Prepared(report) = outcome else {
        panic!("{outcome:?}");
    };
    println!(
        "OFFLINE_COST wall_ms={offline_ms} peak_rss_kib={offline_peak:?} rss_before_kib={before:?} entries={} published_views={} certified={}",
        report.proof.count, report.published_views, report.certified
    );
    let served = served_entries(&args.paths.opencode_db, session);
    let runner_peak = command::peak_rss_kib();
    let arm = Arm::open(
        &store,
        &project,
        session,
        Served::new(served, 350),
        config(),
    );
    let started = Instant::now();
    assert_eq!(
        arm.setup(setup_request(session, "fixture")).await["answer"],
        "ready"
    );
    let setup_ms = started.elapsed().as_millis();
    let started = Instant::now();
    let passes = resident::counters::read().engine_passes;
    assert_eq!(arm.notice(1, 0, None, Vec::new()).await, "ok");
    let adopt_ms = started.elapsed().as_millis();
    let adopted = arm.state();
    assert!(adopted.offline_first_pass.is_none());
    assert_eq!(adopted.generation, 0, "adopted, not discarded");
    let adopt_passes = resident::counters::read().engine_passes - passes;
    {
        let mut entries = arm.runner.entries.lock().unwrap();
        let (next, tag) = (entries.len() as u64, highest_tag(&entries) + 1);
        entries.push(appended(session, next, tag));
    }
    let mut later = Vec::new();
    for seq in 2..=6 {
        if seq > 2 {
            let mut entries = arm.runner.entries.lock().unwrap();
            let (next, tag) = (entries.len() as u64, highest_tag(&entries) + 1);
            entries.push(appended(session, next, tag));
        }
        let started = Instant::now();
        assert_eq!(arm.notice(seq, 1_000, arm.newest(), Vec::new()).await, "ok");
        later.push(started.elapsed().as_millis());
    }
    println!(
        "LIVE_COST setup_ms={setup_ms} adopting_notice_ms={adopt_ms} adopting_engine_passes={adopt_passes} later_notice_ms={later:?} peak_rss_kib={:?} rss_with_runner_copy_before_live_kib={runner_peak:?}",
        command::peak_rss_kib()
    );
}

/// Wall time and peak memory of `ck-mc offline first-pass` on a synthetic
/// moved session of 175,000 messages, 200 summaries and a 1,600-message tail
/// (the shape `mode3-offline-move.md` measured the live first notice on), and
/// of the first live notices after it.
#[test]
#[ignore = "cost measurement; run explicitly"]
fn offline_first_pass_175k_cost() {
    let dir = tempfile::tempdir().unwrap();
    let (store, project) = (dir.path().join("stores"), dir.path().join("project"));
    std::fs::create_dir_all(&store).unwrap();
    std::fs::create_dir_all(&project).unwrap();
    let started = Instant::now();
    let shape = fixture::Synthetic {
        messages: 175_000,
        tail: 1_600,
        text_bytes: 786,
        compartments: 200,
    };
    let (_, session, served) = moved_stores(&store, |dir| {
        (
            fixture::write_synthetic_stores(dir, &shape),
            fixture::SYNTHETIC_SESSION.to_owned(),
        )
    });
    let pages = export(&served, LINEAGE, 350);
    std::fs::write(dir.path().join("pages.jsonl"), &pages).unwrap();
    std::fs::write(
        dir.path().join("setup.json"),
        setup_file(&project, &setup_request(&session, "fixture")).to_string(),
    )
    .unwrap();
    println!(
        "FIXTURE built_ms={} messages={} pages={} pages_bytes={}",
        started.elapsed().as_millis(),
        served.len(),
        pages.lines().count(),
        pages.len()
    );
    drop((served, pages));
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "providers::async_provider::tests::offline_first_pass::offline_first_pass_175k_child",
            "--ignored",
            "--nocapture",
        ])
        .env(COST_DIR, dir.path())
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success(),
        "{stdout}{}",
        String::from_utf8_lossy(&output.stderr)
    );
    for line in stdout
        .lines()
        .filter(|line| line.starts_with("OFFLINE_COST") || line.starts_with("LIVE_COST"))
    {
        println!("{line}");
    }
}

// ── Offline-first-pass adoption at live usage (run with MC_REVIEW_CARD=1) ──

/// Whether these optional adoption tests run; they are skipped by default.
fn review_card() -> bool {
    std::env::var("MC_REVIEW_CARD").is_ok_and(|value| value == "1")
}

/// The first live notice of a moved session usually reports real usage: a
/// moved session is long. The offline pass runs at zero usage (see
/// `offline_first_pass`, which builds its notice with `est_tokens` 0), so
/// adoption is byte-identical to the ordinary first pass only if the adopting
/// notice then publishes exactly what an ordinary first pass at the notice's
/// usage would. Compares everything observable after that one notice on both
/// arms.
async fn first_notice_at(
    label: &str,
    write: impl Fn(&Path) -> (StorePaths, String),
    est: u64,
) -> Result<(), String> {
    let _clock = crate::tests::fixed_clock();
    let project = tempfile::tempdir().unwrap();
    let (offline_dir, live_dir) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (_prep, outcome) = prepared(offline_dir.path(), project.path(), &write).await;
    assert!(
        matches!(outcome, OfflineOutcome::Prepared(_)),
        "{label}: {outcome:?}"
    );
    let (live_paths, session, served) = moved_stores(live_dir.path(), &write);
    pin_history_generation(&live_paths.context_db, &session, &[0, 1]);
    let live = Arm::open(
        live_dir.path(),
        project.path(),
        &session,
        Served::new(served.clone(), 7),
        config(),
    );
    let offline = Arm::open(
        offline_dir.path(),
        project.path(),
        &session,
        Served::new(served.clone(), 7),
        config(),
    );
    live.setup(setup_request(&session, "fixture")).await;
    offline.setup(setup_request(&session, "fixture")).await;
    let live_outcome = live.notice(1, est, None, Vec::new()).await;
    let offline_outcome = offline.notice(1, est, None, Vec::new()).await;
    if live_outcome != offline_outcome {
        return Err(format!(
            "{label} est={est}: outcomes differ: offline {offline_outcome} live {live_outcome}"
        ));
    }
    if offline.state().offline_first_pass.is_some() {
        return Err(format!("{label} est={est}: not adopted"));
    }
    let (offline_seen, live_seen) = (observed(&offline), observed(&live));
    if offline_seen == live_seen {
        return Ok(());
    }
    let keys = offline_seen
        .as_object()
        .unwrap()
        .keys()
        .filter(|key| offline_seen[*key] != live_seen[*key])
        .cloned()
        .collect::<Vec<_>>();
    let versions = |seen: &Value| {
        seen["views"]
            .as_array()
            .unwrap()
            .iter()
            .map(|view| view[0].clone())
            .collect::<Vec<_>>()
    };
    let newest_view = |seen: &Value| {
        seen["views"]
            .as_array()
            .unwrap()
            .last()
            .map(|view| view[1].as_str().unwrap_or("").to_owned())
            .unwrap_or_default()
    };
    Err(format!(
        "{label} est={est}: adopted state differs from the ordinary first pass in {keys:?}; views offline {:?} live {:?}; newest view equal: {}; engine fields {:?}",
        versions(&offline_seen),
        versions(&live_seen),
        newest_view(&offline_seen) == newest_view(&live_seen),
        differing(&offline_seen["engine"], &live_seen["engine"])
            .iter()
            .map(|field| field.chars().take(400).collect::<String>())
            .collect::<Vec<_>>()
    ))
}

/// Witness: adoption at the first live notice equals the ordinary first pass
/// when that notice reports usage of 0, 30,000, 72,000, 87,000 or 96,000
/// tokens of a 100,000-token window.
#[tokio::test]
async fn card_review_adoption_matches_the_ordinary_first_pass_at_live_usage() {
    if !review_card() {
        return;
    }
    let mut failures = Vec::new();
    for est in [0, 30_000, 72_000, 87_000, 96_000] {
        if let Err(failure) = first_notice_at("fixture", fixture_stores, est).await {
            failures.push(failure);
        }
        for seed in [3, 17, 41] {
            if let Err(failure) =
                first_notice_at(&format!("seed {seed}"), seeded_stores(seed), est).await
            {
                failures.push(failure);
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// The seeded offline differential at other seeds:
/// `MC_REVIEW_CARD_OFFLINE_FIRST` (default 1000) and
/// `MC_REVIEW_CARD_OFFLINE_SEEDS` (default 50) sessions.
#[tokio::test]
async fn card_review_offline_differential_at_new_seeds() {
    if !review_card() {
        return;
    }
    let var = |name: &str, default: u64| {
        std::env::var(name)
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(default)
    };
    let first = var("MC_REVIEW_CARD_OFFLINE_FIRST", 1_000);
    let count = var("MC_REVIEW_CARD_OFFLINE_SEEDS", 50);
    seeded(first..first + count).await;
    eprintln!(
        "card review: offline differential over seeds {first}..{}",
        first + count
    );
}
