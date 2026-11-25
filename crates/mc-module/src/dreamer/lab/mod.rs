//! One unscheduled, read-only dreamer experiment.

mod frozen;
mod git;
mod persona;
mod spec;
#[cfg(test)]
#[path = "lab_tests.rs"]
mod tests;
mod verdicts;

use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cortexkit_persona::{
    AgentContext, Demand, EnvContext, HarnessContext, ModelContext, OsName, RenderContext,
};
use cortexkit_role_compaction::setup::ModelRef;
use cortexkit_role_routing::select::SelectRequest;
use cortexkit_role_tool_provider::catalog::{self, composition_digest};
use serde::Serialize;
use serde_json::{json, Value};

use crate::child_scopes::{WorkerScope, WorkerScopeGuard, LAB_WORKER_SCOPE};
use crate::client::{Child, RunnerClient};
use crate::routing::{self, Router};
use crate::summary::fit::Window;
use crate::summary::run::{ObservedSend, PlanRun};

use super::{plan, run};
use spec::{Route, Spec, Tool};

static RUNS: AtomicU64 = AtomicU64::new(0);
const OWN_NAMES: [&str; 4] = ["git_read", "memory_search", "history_search", "submit"];
const READER_NAMES: [&str; 9] = [
    "read",
    "grep",
    "glob",
    "outline",
    "zoom",
    "search",
    "aft_outline",
    "aft_zoom",
    "aft_search",
];

#[derive(Default)]
pub(crate) struct Registry {
    children: Mutex<HashMap<String, (Child, Arc<Lab>)>>,
    active: Mutex<Option<PathBuf>>,
}

impl Registry {
    pub(crate) fn get(&self, route: &crate::route::Route) -> Option<Arc<Lab>> {
        let children = self.children.lock().expect("lab sessions");
        let (child, lab) = children.get(&route.session.session)?;
        (route.session.runner == child.session.runner && route.workdir == child.project_root)
            .then(|| lab.clone())
    }

    fn register(&self, child: Child, lab: Arc<Lab>) -> Registered<'_> {
        let id = child.session.session.clone();
        self.children
            .lock()
            .expect("lab sessions")
            .insert(id.clone(), (child, lab));
        Registered(self, id)
    }

    fn ensure_idle(&self) -> Result<(), String> {
        match self.active.lock().expect("active lab").as_ref() {
            Some(folder) => Err(format!(
                "a dreamer lab is already active: {}",
                folder.display()
            )),
            None => Ok(()),
        }
    }

    fn reserve(self: &Arc<Self>, folder: &Path) -> Result<Permit, String> {
        let mut active = self.active.lock().expect("active lab");
        if let Some(folder) = active.as_ref() {
            return Err(format!(
                "a dreamer lab is already active: {}",
                folder.display()
            ));
        }
        *active = Some(folder.to_owned());
        Ok(Permit(self.clone()))
    }
}

struct Permit(Arc<Registry>);

impl Drop for Permit {
    fn drop(&mut self) {
        self.0.active.lock().expect("active lab").take();
    }
}

pub(super) struct Registered<'a>(&'a Registry, String);

impl Drop for Registered<'_> {
    fn drop(&mut self) {
        self.0
            .children
            .lock()
            .expect("lab sessions")
            .remove(&self.1);
    }
}

pub(crate) struct Lab {
    spec: Spec,
    context: String,
    memories: String,
    persona: persona::Persona,
    store: Mutex<rusqlite::Connection>,
    history: Option<crate::search::lab::History>,
    embedding: Option<crate::embedding::Provider>,
    tools: Vec<Value>,
    verdicts: Mutex<verdicts::Verdicts>,
    called_tool: AtomicBool,
    stopped: AtomicBool,
}

pub(crate) struct Start {
    spec: Spec,
    live: PathBuf,
    permit: Option<Permit>,
}

impl Start {
    pub(crate) async fn load(
        path: &Path,
        live: &Path,
        registry: Arc<Registry>,
    ) -> Result<Self, String> {
        registry.ensure_idle()?;
        let (path, live) = (path.to_owned(), live.to_owned());
        let runtime = tokio::runtime::Handle::current();
        validate_with_limit(Duration::from_secs(15), move |deadline| {
            let spec = runtime.block_on(async {
                tokio::time::timeout_at(deadline, Spec::load(&path, &live))
                    .await
                    .map_err(|_| VALIDATION_TIMEOUT.to_owned())?
            })?;
            if tokio::time::Instant::now() >= deadline {
                return Err(VALIDATION_TIMEOUT.into());
            }
            let permit = registry.reserve(&spec.out_dir)?;
            spec.prepare_output()?;
            Ok(Self {
                spec,
                live,
                permit: Some(permit),
            })
        })
        .await
    }

    pub(crate) fn out_dir(&self) -> &Path {
        &self.spec.out_dir
    }

    #[cfg(test)]
    async fn execute<C: RunnerClient + Router>(
        self,
        client: Arc<C>,
        registry: Arc<Registry>,
        embedding: Option<crate::embedding::Provider>,
    ) {
        self.execute_with(client, registry, move |_, _| embedding)
            .await;
    }

    pub(crate) async fn execute_with<C: RunnerClient + Router>(
        mut self,
        client: Arc<C>,
        registry: Arc<Registry>,
        embedding: impl FnOnce(&Path, &str) -> Option<crate::embedding::Provider> + Send + 'static,
    ) {
        let start = Instant::now();
        let deadline =
            tokio::time::Instant::now() + Duration::from_secs(self.spec.deadline_minutes * 60);
        // Keep the reservation until both the artifact writer and scope teardown finish.
        let permit = Arc::new(self.permit.take());
        let out = self.spec.out_dir.clone();
        let ids = self.spec.memory_ids.clone();
        let mut observed = Observed::default();
        let mut loaded = None;
        let outcome = tokio::time::timeout_at(deadline, async {
            let lab = tokio::task::spawn_blocking(move || {
                let embedding = embedding(&self.spec.root, &self.spec.project);
                Lab::load(self, embedding)
            })
            .await
            .map_err(|e| run::LabEnd::Error(e.to_string()))?
            .map_err(run::LabEnd::Refused)?;
            let lab = loaded.insert(Arc::new(lab));
            lab.execute(client.as_ref(), registry.as_ref(), &mut observed, deadline)
                .await
        })
        .await;
        if let Some(lab) = &loaded {
            lab.stopped.store(true, Ordering::Release);
        }
        let worker_guard = observed.worker_scope.take();
        let worker_scope = worker_guard.as_ref().map(|guard| &guard.0);
        let (stop, error) = match outcome {
            Err(_) => {
                in_child_scope(worker_scope, observed.cancel(client.as_ref())).await;
                ("deadline", None)
            }
            Ok(answer) => match answer {
                Ok(()) => ("model_finished", None),
                Err(run::LabEnd::StepCap) => ("step_cap", None),
                Err(run::LabEnd::AccountLimit(e)) => ("account_limit", Some(e)),
                Err(run::LabEnd::Refused(e)) => ("refusal", Some(e)),
                Err(run::LabEnd::Error(e)) => ("error", Some(e)),
            },
        };
        let write_permit = permit.clone();
        let finished = tokio::task::spawn_blocking(move || {
            let _permit = write_permit;
            let history_session_ids_skipped = loaded.as_ref().and_then(|lab| {
                lab.history
                    .as_ref()
                    .map(crate::search::lab::History::skipped_session_ids)
            });
            let missing = loaded.map_or(ids, |lab| {
                verdicts::missing(
                    &lab.spec.memory_ids,
                    &lab.verdicts.lock().expect("lab verdicts"),
                )
            });
            let request_error = observed.write_request(&out).err();
            let (stop, error) = if let Some(error) = request_error {
                (if stop == "deadline" { stop } else { "error" }, Some(error))
            } else if stop == "model_finished" && tokio::time::Instant::now() >= deadline {
                ("deadline", None)
            } else {
                (stop, error)
            };
            let mut result = observed.result(stop, missing, error, start.elapsed().as_millis());
            if let Some(skipped) = history_session_ids_skipped {
                result["history_session_ids_skipped"] = json!(skipped);
            }
            verdicts::write_json(&out, "run.json", &result)
        })
        .await
        .map_err(|e| e.to_string())
        .and_then(|result| result);
        if let Err(error) = finished {
            tracing::info!(%error, "ck-mc: dreamer lab could not record the result");
        }
        if let Some(worker_scope) = worker_scope {
            if let Err(error) = client.end_worker_scope(worker_scope).await {
                tracing::warn!(%error, "ck-mc: dreamer lab could not end its Worker scope");
            }
        }
        drop(worker_guard);
        drop(permit);
    }
}

const VALIDATION_TIMEOUT: &str = "dreamer lab validation timed out";

async fn in_child_scope<T>(scope: Option<&Arc<WorkerScope>>, run: impl Future<Output = T>) -> T {
    match scope {
        Some(scope) => LAB_WORKER_SCOPE.scope(scope.clone(), run).await,
        None => run.await,
    }
}

async fn validate_with_limit<T: Send + 'static>(
    limit: Duration,
    work: impl FnOnce(tokio::time::Instant) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let deadline = tokio::time::Instant::now() + limit;
    tokio::time::timeout_at(
        deadline,
        tokio::task::spawn_blocking(move || work(deadline)),
    )
    .await
    .map_err(|_| VALIDATION_TIMEOUT.to_owned())?
    .map_err(|e| e.to_string())?
}

impl Lab {
    fn load(start: Start, embedding: Option<crate::embedding::Provider>) -> Result<Self, String> {
        let Start { spec, live, .. } = start;
        if spec.tools.contains(&Tool::Sidekick) {
            WorkerScope::check_project_id(&spec.project).map_err(|error| error.to_string())?;
        }
        spec::reject_live(&spec.store, &live)?;
        let store = frozen::open(&spec.store)?;
        let memories = frozen::memories(&store, &spec.project, &spec.memory_ids)?;
        let history = spec
            .tools
            .contains(&Tool::HistorySearch)
            .then(|| {
                crate::search::lab::History::load(
                    &store,
                    &spec.project,
                    spec.history_sessions.as_deref(),
                )
            })
            .transpose()?;
        let context = spec.context()?;
        let persona = persona::Persona::load(&spec, &live)?;
        let tools = tool_definitions(&spec)?;
        Ok(Self {
            spec,
            context,
            memories,
            persona,
            store: Mutex::new(store),
            history,
            embedding,
            tools,
            verdicts: Mutex::default(),
            called_tool: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
        })
    }

    async fn execute<C: RunnerClient + Router>(
        self: &Arc<Self>,
        client: &C,
        registry: &Registry,
        observed: &mut Observed,
        deadline: tokio::time::Instant,
    ) -> Result<(), run::LabEnd> {
        let root = self
            .spec
            .root
            .to_str()
            .ok_or_else(|| run::LabEnd::Refused("root must be UTF-8".into()))?;
        let reader = if self.spec.tools.contains(&Tool::Reader) {
            Some(
                plan::select_reader(client, root)
                    .await
                    .map_err(run::LabEnd::Refused)?,
            )
        } else {
            None
        };
        let id = format!(
            "lab-{}-{}-{}",
            std::process::id(),
            crate::memory_writes::now_ms(),
            RUNS.fetch_add(1, Ordering::Relaxed)
        );
        let worker_scope = self
            .spec
            .tools
            .contains(&Tool::Sidekick)
            .then(|| WorkerScope::new(root, &self.spec.project, &id))
            .transpose()
            .map_err(|error| run::LabEnd::Refused(error.to_string()))?;
        let job = run::TaskRun {
            demand: &routing::LAB_DEMAND,
            run_id: &id,
            project_root: root,
            reader: reader.as_deref(),
            remaining_tokens: u64::MAX,
            attribution: None,
        };
        observed.worker_scope = worker_scope.clone().map(WorkerScopeGuard);
        let result = in_child_scope(
            worker_scope.as_ref(),
            run::run_lab(client, &job, self, registry, observed, deadline),
        )
        .await;
        // Capability discovery reports an inaccessible runner as not supporting
        // plans. Keep the scope refusal rather than that proxy error.
        if result.is_err() {
            if let Some(Err(error)) = worker_scope.as_ref().map(|scope| scope.check_live()) {
                return Err(run::LabEnd::Refused(error.to_string()));
            }
        }
        result
    }

    pub(super) fn route_select(&self, select: &mut SelectRequest) {
        match &self.spec.route {
            Some(Route::Demand { iq, eq }) => {
                select.requirements.iq = *iq;
                select.requirements.eq = Some(*eq);
            }
            Some(Route::Pin(pin)) => select.pin = Some(pin.clone()),
            None => {}
        }
    }

    pub(super) async fn prepare<C: RunnerClient>(
        self: &Arc<Self>,
        client: &C,
        child: &Child,
        reader: Option<&str>,
        model: &ModelRef,
        window: Window,
        output_tokens: u64,
    ) -> Result<Prepared, String> {
        let mut tools: BTreeMap<String, bool> = OWN_NAMES
            .into_iter()
            .chain(READER_NAMES)
            .chain([plan::SIDEKICK_NAME])
            .map(|name| (name.into(), false))
            .collect();
        let mut reader_tools = Vec::new();
        let mut providers = BTreeMap::new();
        let mut tool_items = Vec::new();
        if let Some(reader) = reader {
            let preset = plan::reader_preset();
            let catalog = client
                .tool_catalog(child, reader, Some(preset))
                .await
                .map_err(|e| e.to_string())?;
            let definitions = plan::reader_tools(reader, &catalog)?;
            for tool in &definitions {
                tools.insert(tool.name.clone(), true);
            }
            for tool in &catalog.tools {
                reader_tools.push(serde_json::to_value(tool).map_err(|e| e.to_string())?);
            }
            providers.insert(reader, composition_tools(definitions));
            tool_items.push(json!({"provider": reader, "preset": preset, "params":{}}));
        }
        let sidekick_offered = self.spec.tools.contains(&Tool::Sidekick);
        let checkout_paths = if sidekick_offered {
            let sidekick = plan::sidekick_tool(client, child).await?;
            if tools.insert(sidekick.name.clone(), true) == Some(true)
                || providers.contains_key(plan::SIDEKICK_PROVIDER)
            {
                return Err("the reader and the sidekick preset overlap".into());
            }
            providers.insert(plan::SIDEKICK_PROVIDER, composition_tools(vec![sidekick]));
            tool_items.push(plan::sidekick_item());
            self.spec
                .checkouts
                .values()
                .map(|path| {
                    path.to_str().map(str::to_owned).ok_or_else(|| {
                        format!("sidekick checkout path must be UTF-8: {}", path.display())
                    })
                })
                .collect::<Result<Vec<_>, _>>()?
        } else {
            Vec::new()
        };
        let mut own = Vec::new();
        for tool in &self.tools {
            let name = tool["name"].as_str().expect("lab tool name");
            if tools.insert(name.into(), true) == Some(true) {
                return Err(format!("the reader and lab both serve {name}"));
            }
            own.push(plan::ReaderTool {
                name: name.into(),
                capabilities: Vec::new(),
            });
        }
        providers.insert(crate::MODULE_ID, composition_tools(own));
        let preset = crate::catalog::Preset::Dreamer.as_str();
        if !self.tools.is_empty() {
            tool_items.push(json!({"provider": crate::MODULE_ID, "preset": preset, "params":{}}));
        }
        let (iq, eq) = match self.spec.route {
            Some(Route::Demand { iq, eq }) => (iq, eq),
            _ => (routing::LAB_DEMAND.iq, 0),
        };
        let context = RenderContext {
            agent: AgentContext {
                project: Some(self.spec.project.clone()),
                role: "lab".into(),
                name: None,
                agent_id: None,
                workspace: None,
            },
            model: ModelContext {
                provider: model.provider.clone(),
                id: model.model.clone(),
                variant: model.variant.clone().unwrap_or_else(|| "default".into()),
                family: None,
            },
            harness: HarnessContext {
                id: child.session.harness.clone(),
                capabilities: BTreeMap::new(),
            },
            demand: Demand { iq, eq },
            env: EnvContext {
                os: os(),
                timezone: "UTC".into(),
                locale: "en".into(),
            },
            ..RenderContext::default()
        };
        let owned = self.clone();
        let (system, prompt) = tokio::task::spawn_blocking(move || -> Result<_, String> {
            let (system, prompt) = owned.persona.render(
                context,
                tools,
                &checkout_paths,
                &owned.context,
                &owned.memories,
            )?;
            if system.trim().is_empty() || prompt.trim().is_empty() {
                return Err("the lab system text and first message must not be empty".into());
            }
            if !window.admits(output_tokens, &system, &prompt) {
                return Err("the exact lab request does not fit the selected model".into());
            }
            Ok((system, prompt))
        })
        .await
        .map_err(|e| e.to_string())??;
        let composition = json!({"providers": providers.into_iter().map(|(provider, tools)| json!({"provider":provider,"tools":tools})).collect::<Vec<_>>(),"step_transform_items":[]});
        let digest = composition_digest(&composition).map_err(|e| e.to_string())?;
        let plan = json!({
            "composition":composition, "composition_digest":digest, "step_transform_items":[],
            "system_text_items":[{"provider":crate::MODULE_ID,"preset":preset,"params":{crate::catalog::DREAMER_TEXT_PARAM:system}}],
            "tool_items":tool_items
        });
        Ok(Prepared {
            system,
            prompt,
            reader_tools,
            sidekick_offered,
            plan: PlanRun {
                plan: plan.as_object().expect("lab plan object").clone(),
                max_steps: self.spec.step_cap,
            },
        })
    }

    pub(super) fn register<'a>(
        self: &Arc<Self>,
        registry: &'a Registry,
        child: &Child,
    ) -> Registered<'a> {
        registry.register(child.clone(), self.clone())
    }

    pub(crate) fn tools(&self) -> &[Value] {
        &self.tools
    }

    pub(crate) fn note_tool_call(&self) {
        self.called_tool.store(true, Ordering::Release);
    }

    pub(super) fn called_tool(&self) -> bool {
        self.called_tool.load(Ordering::Acquire)
    }

    fn active_merge(&self, id: i64) -> Result<bool, String> {
        self.store.lock().expect("frozen store").query_row(
            "SELECT EXISTS (SELECT 1 FROM memories WHERE id=?1 AND level='project' AND owner_id=?2
              AND status IN ('active','permanent') AND superseded_by_memory_id IS NULL
              AND (expires_at IS NULL OR expires_at > ?3))",
            rusqlite::params![id, self.spec.project, crate::memory_writes::now_ms()], |row| row.get(0),
        ).map_err(|e| format!("checking merge destination {id}: {e}"))
    }

    pub(crate) async fn tool(self: Arc<Self>, name: &str, input: Value) -> Result<String, String> {
        if self.stopped.load(Ordering::Acquire) {
            return Err("the dreamer lab has ended".into());
        }
        if !self
            .tools
            .iter()
            .any(|tool| tool["name"].as_str() == Some(name))
        {
            return Err(format!("this lab does not offer {name}"));
        }
        match name {
            "git_read" => {
                let request: git::Request =
                    serde_json::from_value(input).map_err(|e| format!("git_read: {e}"))?;
                let root = self
                    .spec
                    .checkouts
                    .get(&request.checkout)
                    .ok_or_else(|| format!("unknown checkout {:?}", request.checkout))?;
                request.read(root).await
            }
            "submit" => tokio::task::spawn_blocking(move || {
                let mut current = self.verdicts.lock().expect("lab verdicts");
                if self.stopped.load(Ordering::Acquire) {
                    return Err("the dreamer lab has ended".into());
                }
                verdicts::submit(
                    &self.spec.out_dir,
                    &self.spec.memory_ids,
                    &mut current,
                    input,
                    |id| self.active_merge(id),
                )
            })
            .await
            .map_err(|e| e.to_string())?,
            "memory_search" => self.search(Tool::MemorySearch, input).await,
            "history_search" => self.search(Tool::HistorySearch, input).await,
            _ => Err(format!("unknown lab tool {name}")),
        }
    }

    async fn search(self: Arc<Self>, tool: Tool, input: Value) -> Result<String, String> {
        let timed_out = match tool {
            Tool::MemorySearch => "memory_search timed out; narrow the query",
            Tool::HistorySearch => "history_search timed out; narrow the query",
            _ => unreachable!("only search tools use a frozen-store deadline"),
        };
        tokio::time::timeout(
            frozen::SEARCH_LIMIT,
            self.search_frozen(tool, input, timed_out),
        )
        .await
        .map_err(|_| timed_out.to_owned())?
    }

    async fn search_frozen(
        self: Arc<Self>,
        tool: Tool,
        input: Value,
        timed_out: &'static str,
    ) -> Result<String, String> {
        let deadline = Instant::now() + frozen::SEARCH_LIMIT;
        let query = input
            .get("query")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let semantic = match &self.embedding {
            Some(provider) if !query.is_empty() => provider
                .embed_search_query_traced(query)
                .await
                .0
                .map(|vector| (vector, provider.model_id(), provider.chunk_model_id())),
            _ => None,
        };
        tokio::task::spawn_blocking(move || {
            let conn = self.store.lock().expect("frozen store");
            frozen::search_with_limit(
                &conn,
                deadline.saturating_duration_since(Instant::now()),
                timed_out,
                |conn| {
                    let semantic = semantic.as_ref().map(|(vector, model, chunk)| {
                        crate::search::sources::Semantic {
                            vector,
                            model_id: model,
                            chunk_model_id: chunk,
                        }
                    });
                    match tool {
                        Tool::MemorySearch => crate::search::lab::memory_search(
                            conn,
                            &self.spec.project,
                            &input,
                            semantic,
                        ),
                        Tool::HistorySearch => self
                            .history
                            .as_ref()
                            .expect("history tool has a session scope")
                            .search(conn, &input, semantic),
                        _ => unreachable!("only search tools use the frozen index"),
                    }
                },
            )
        })
        .await
        .map_err(|e| e.to_string())?
    }
}

pub(super) struct Prepared {
    pub system: String,
    pub prompt: String,
    reader_tools: Vec<Value>,
    sidekick_offered: bool,
    pub plan: PlanRun,
}

#[derive(Default)]
pub(super) struct Observed {
    pub model: Option<ModelRef>,
    pub route: Option<String>,
    pub child: Option<Child>,
    pub send: ObservedSend,
    pub account_limit_detail: Option<&'static str>,
    sidekick_offered: bool,
    worker_scope: Option<WorkerScopeGuard>,
    request: Option<Value>,
    request_written_at: Option<i64>,
}

#[derive(Serialize)]
struct Totals {
    new_input: Option<u64>,
    cached_input: Option<u64>,
    output: Option<u64>,
}

impl Observed {
    pub(super) fn record_attempt(
        &mut self,
        child: &Child,
        prepared: &Prepared,
        lab_tools: &[Value],
    ) {
        self.child = Some(child.clone());
        self.send = ObservedSend::default();
        self.sidekick_offered = prepared.sidekick_offered;
        self.request = Some(
            json!({"system_text":prepared.system, "first_message":prepared.prompt,
            "lab_tools":lab_tools, "reader_tools_at_preflight":prepared.reader_tools}),
        );
    }

    fn write_request(&mut self, out: &Path) -> Result<(), String> {
        // An account refusal can discard a pre-step attempt. Publish only
        // the selected child's record, so a retry never replaces the file.
        if let Some(request) = self.request.take() {
            verdicts::write_json(out, "request.json", &request)?;
            self.request_written_at = Some(crate::memory_writes::now_ms());
        }
        Ok(())
    }

    async fn cancel(&self, client: &impl RunnerClient) {
        let Some(child) = &self.child else {
            return;
        };
        if !self.send.finished {
            let _ = tokio::time::timeout(Duration::from_secs(2), async {
                if let Some(id) = &self.send.run_id {
                    let _ = client.cancel_child_run(child, id).await;
                } else if let Some(id) = &self.send.submission_id {
                    let _ = client.retract_child_send(child, id).await;
                }
            })
            .await;
        }
    }

    fn result(
        self,
        stop: &str,
        missing: Vec<i64>,
        error: Option<String>,
        wall_time_ms: u128,
    ) -> Value {
        let total = self.send.usage.as_ref().map(|usage| Totals {
            // `input_tokens` is the uncached input; cache creation is also new work.
            new_input: match (usage.input_tokens, usage.cache_write_tokens) {
                (None, None) => None,
                (input, write) => Some(input.unwrap_or(0).saturating_add(write.unwrap_or(0))),
            },
            cached_input: usage.cached_input_tokens,
            output: usage.output_tokens,
        });
        let ended = if missing.is_empty() {
            "complete"
        } else {
            "incomplete"
        };
        let unreported = self.send.usage.as_ref().map(|usage| usage.unreported_steps);
        let session = self.child.as_ref().map(|child| &child.session);
        json!({"model":self.model,"route":self.route,"child_session_id":session.map(|s| &s.session),"runner":session.map(|s| &s.runner),
            "sent":self.send.accepted,"request_written_at":self.request_written_at,"account_limit_detail":self.account_limit_detail,
            "sidekick_offered":self.sidekick_offered,
            "steps":self.send.usage.as_ref().map(|usage| usage.steps),"usage":{"total":total,"per_step":null,
                 "unreported_steps":unreported,"usage_complete":self.send.terminal_usage && unreported == Some(0),
                "per_step_unavailable":"the runner's run result reports aggregate usage only"},
            "wall_time_ms":wall_time_ms,"ended":ended,"stop":stop,"missing_ids":missing,"error":error})
    }
}

fn composition_tools(mut tools: Vec<plan::ReaderTool>) -> Vec<Value> {
    tools.sort_by(|a, b| a.name.cmp(&b.name));
    tools
        .into_iter()
        .map(|mut tool| {
            tool.capabilities.sort();
            tool.capabilities.dedup();
            json!({"name":tool.name,"capabilities":tool.capabilities})
        })
        .collect()
}

fn os() -> OsName {
    match std::env::consts::OS {
        "macos" => OsName::Darwin,
        "linux" => OsName::Linux,
        "windows" => OsName::Windows,
        _ => OsName::Unknown,
    }
}

fn tool_definitions(spec: &Spec) -> Result<Vec<Value>, String> {
    let mut tools = Vec::new();
    let mut add = |name, description, schema, read_only| -> Result<(), String> {
        let digest = catalog::schema_digest(&schema).map_err(|e| e.to_string())?;
        let mut tool = json!({"name":name,"description":description,"input_schema":schema,"schema_digest":digest,
            "semantics":1,"result_ops":["prepend","append"],"capabilities":[]});
        if read_only {
            tool["read_only"] = json!(true);
        }
        tools.push(tool);
        Ok(())
    };
    if spec.tools.contains(&Tool::GitRead) {
        add("git_read", "Read local Git history in a named lab checkout. Omitted refs default to HEAD except diff (two refs) and ls-files (none).",
            json!({"type":"object","additionalProperties":false,"required":["checkout","command"],"properties":{
                "checkout":{"type":"string","enum":spec.checkouts.keys().collect::<Vec<_>>()},
                "command":{"type":"string","enum":git::commands().collect::<Vec<_>>()},
                "refs":{"type":"array","items":{"type":"string"}},
                "paths":{"type":"array","items":{"type":"string"},"description":"Literal paths relative to the checkout; blame takes one path."},
                "options":{"type":"array","items":{"type":"string","enum":git::options()}}
            }}), true)?;
    }
    if spec.tools.contains(&Tool::MemorySearch) {
        add(
            "memory_search",
            "Find other project memories about the same subject, or look them up by memory id. Returns active matches first, then archived matches marked as archived, with each memory's category, creation date, importance and text. Does not return messages, summaries or commits.",
            json!({"type":"object","additionalProperties":false,"required":["query"],"properties":{
                "query":{"type":"string"},
                "limit":{"type":"integer","minimum":1,"maximum":20,"default":10}
            }}),
            true,
        )?;
    }
    if spec.tools.contains(&Tool::HistorySearch) {
        add(
            "history_search",
            "Find what was said or decided in this project, and when. Returns separate groups of summaries, the person's indexed messages and commits, with dates and references you can cite. Agent messages are omitted unless requested, in which case they have their own group. Use the optional UTC dates to narrow the search.",
            json!({"type":"object","additionalProperties":false,"required":["query"],"properties":{
                "query":{"type":"string"},
                "from":{"type":"string","description":"Inclusive start date (YYYY-MM-DD in UTC, or a full ISO datetime)."},
                "to":{"type":"string","description":"Inclusive end date (YYYY-MM-DD in UTC, or a full ISO datetime)."},
                "limit":{"type":"integer","minimum":1,"maximum":3,"default":1,"description":"Multiply group sizes: 4 summaries, 4 person messages, 3 commits, and 4 agent messages if included."},
                "include_agent":{"type":"boolean","default":false}
            }}),
            true,
        )?;
    }
    if spec.tools.contains(&Tool::Submit) {
        add("submit", "Record verdicts for some lab memories. Later calls may replace an earlier verdict for the same id.", verdicts::schema(), false)?;
    }
    Ok(tools)
}
