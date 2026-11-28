//! One unscheduled dreamer experiment using frozen inputs. Its only write to
//! the live context store is the attribution fact of the session it starts:
//! the record that says which task and project that session's model cost
//! belongs to ([`crate::attribution`]).

mod frozen;
mod git;
mod persona;
mod ranking;
mod spec;
#[cfg(test)]
#[path = "lab_tests.rs"]
mod tests;
mod verdicts;

use std::collections::{BTreeMap, HashMap, HashSet};
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

use crate::attribution::{Attribution, Purpose};
use crate::child_scopes::{WorkerScope, WorkerScopeGuard, LAB_WORKER_SCOPE};
use crate::client::{Child, RunnerClient};
use crate::context_db::ContextDb;
use crate::routing::{self, Router};
use crate::search::lab::{History, HistoryScope};
use crate::summary::fit::Window;
use crate::summary::run::{ObservedSend, PlanRun};

use super::{plan, run};
use spec::{Route, Spec, Tool};

static RUNS: AtomicU64 = AtomicU64::new(0);
const OWN_NAMES: [&str; 5] = [
    "git_read",
    "memory_search",
    "history_search",
    "history_read",
    "submit",
];
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
    active_outputs: Mutex<HashSet<PathBuf>>,
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

    fn reserve(self: &Arc<Self>, folder: &Path) -> Result<Permit, String> {
        let mut active_outputs = self.active_outputs.lock().expect("active lab outputs");
        if !active_outputs.insert(folder.to_owned()) {
            return Err(format!(
                "a dreamer lab is already using out_dir: {}",
                folder.display()
            ));
        }
        Ok(Permit(self.clone(), folder.to_owned()))
    }
}

struct Permit(Arc<Registry>, PathBuf);

impl Drop for Permit {
    fn drop(&mut self) {
        self.0
            .active_outputs
            .lock()
            .expect("active lab outputs")
            .remove(&self.1);
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
    memories: frozen::Memories,
    persona: persona::Persona,
    store: Mutex<rusqlite::Connection>,
    history: History,
    embedding: Option<crate::embedding::Provider>,
    ranking: ranking::Runtime,
    tools: Vec<Value>,
    verdicts: Mutex<verdicts::Verdicts>,
    called_tool: AtomicBool,
    stopped: AtomicBool,
}

pub(crate) struct Start {
    spec: Spec,
    live: PathBuf,
    related: frozen::Related,
    permit: Option<Permit>,
}

impl Start {
    pub(crate) async fn load(
        path: &Path,
        live: &Path,
        registry: Arc<Registry>,
    ) -> Result<Self, String> {
        let (path, live) = (path.to_owned(), live.to_owned());
        let runtime = tokio::runtime::Handle::current();
        validate_with_limit(Duration::from_secs(15), move |deadline| {
            let spec = runtime.block_on(async {
                tokio::time::timeout_at(deadline, Spec::load(&path, &live))
                    .await
                    .map_err(|_| VALIDATION_TIMEOUT.to_owned())?
            })?;
            let related = frozen::Related::load(&spec, deadline.into())?;
            if tokio::time::Instant::now() >= deadline {
                return Err(VALIDATION_TIMEOUT.into());
            }
            let permit = registry.reserve(&spec.out_dir)?;
            spec.prepare_output()?;
            Ok(Self {
                spec,
                live,
                related,
                permit: Some(permit),
            })
        })
        .await
    }

    pub(crate) fn out_dir(&self) -> &Path {
        &self.spec.out_dir
    }

    pub(crate) async fn execute_with<C: RunnerClient + Router>(
        mut self,
        client: Arc<C>,
        registry: Arc<Registry>,
        attribution_db: Arc<ContextDb>,
        search_settings: impl FnOnce(
                &Path,
                &str,
            ) -> (
                Option<crate::embedding::Provider>,
                crate::search::rerank::Reranker,
            ) + Send
            + 'static,
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
            let search_client = client.clone();
            let lab = tokio::task::spawn_blocking(move || {
                let (embedding, reranker) = search_settings(&self.spec.root, &self.spec.project);
                let mut lab = Lab::load(self, embedding)?;
                lab.ranking = ranking::Runtime::new(search_client, reranker);
                Ok::<_, String>(lab)
            })
            .await
            .map_err(|e| run::LabEnd::Error(e.to_string()))?
            .map_err(run::LabEnd::Refused)?;
            let lab = loaded.insert(Arc::new(lab));
            lab.execute(
                client.as_ref(),
                registry.as_ref(),
                attribution_db.as_ref(),
                &mut observed,
                deadline,
            )
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
                searches_history(&lab.spec).then(|| lab.history.skipped_session_ids())
            });
            let history_session_map = loaded
                .as_ref()
                .map_or_else(|| json!({}), |lab| json!(lab.history.scope.report()));
            let origins_outside_scope = loaded
                .as_ref()
                .map_or(0, |lab| lab.memories.origins_outside_scope);
            let ranking = loaded
                .as_ref()
                .map(|lab| lab.ranking.report(lab.spec.rerank));
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
            result["history_session_map"] = history_session_map;
            result["origins_outside_scope"] = json!(origins_outside_scope);
            if let Some(skipped) = history_session_ids_skipped {
                result["history_session_ids_skipped"] = json!(skipped);
            }
            if let Some(ranking) = ranking {
                result["rerank"] = ranking;
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
        let Start {
            spec,
            live,
            related,
            ..
        } = start;
        if spec.tools.contains(&Tool::Sidekick) {
            WorkerScope::check_project_id(&spec.project).map_err(|error| error.to_string())?;
        }
        spec::reject_live(&spec.store, &live)?;
        let store = frozen::open(&spec.store)?;
        let history = History::for_lab(
            &store,
            &spec.project,
            spec.history_sessions.as_deref(),
            searches_history(&spec),
        )?;
        let memories = frozen::memories(&store, &spec, &history.scope, &related)?;
        let context = spec.context()?;
        let persona = persona::Persona::load(&spec, &live)?;
        let tools = tool_definitions(&spec, &history.scope)?;
        Ok(Self {
            spec,
            context,
            memories,
            persona,
            store: Mutex::new(store),
            history,
            embedding,
            ranking: ranking::Runtime::default(),
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
        attribution_db: &ContextDb,
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
        let demand = &routing::LAB_DEMAND;
        let purpose = Purpose::dream(demand.kind, Some(&self.spec.project));
        let job = run::TaskRun {
            demand,
            run_id: &id,
            project_root: root,
            reader: reader.as_deref(),
            remaining_tokens: u64::MAX,
            attribution: Some(Attribution {
                db: attribution_db,
                purpose: &purpose,
            }),
        };
        observed.worker_scope = worker_scope.clone().map(WorkerScopeGuard);
        let result = in_child_scope(
            worker_scope.as_ref(),
            run::run_lab(client, &job, self, registry, observed, deadline),
        )
        .await;
        // When the Worker scope was refused, the runner cannot be reached
        // under it, and capability discovery then reports that the runner
        // does not support plans. Report the scope refusal, which is the cause.
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
            let (system, mut prompt) = owned.persona.render(
                context,
                tools,
                &checkout_paths,
                &owned.context,
                &owned.memories.text,
            )?;
            if system.trim().is_empty() || prompt.trim().is_empty() {
                return Err("the lab system text and first message must not be empty".into());
            }
            if let Some(legend) = owned.history.scope.legend() {
                prompt.push_str("\n\n");
                prompt.push_str(&legend);
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
        self.ranking.bind(&child.session);
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
            "submit" => self.submit(input).await,
            "memory_search" => self.memory_search(input).await,
            "history_search" => self.history_search(input, false).await,
            "history_read" => self.history_read(input).await,
            _ => Err(format!("unknown lab tool {name}")),
        }
    }

    async fn embed(&self, query: &str) -> Option<(Vec<f32>, String, String)> {
        match &self.embedding {
            Some(provider) if !query.is_empty() => provider
                .embed_search_query_traced(query)
                .await
                .0
                .map(|vector| (vector, provider.model_id(), provider.chunk_model_id())),
            _ => None,
        }
    }

    async fn memory_search(self: Arc<Self>, input: Value) -> Result<String, String> {
        const TIMEOUT: &str = "memory_search timed out; narrow the query";
        let deadline = Instant::now() + frozen::SEARCH_LIMIT;
        let embedded = tokio::time::timeout_at(deadline.into(), self.embed(query_text(&input)))
            .await
            .map_err(|_| TIMEOUT.to_owned())?;
        self.read_frozen(deadline, TIMEOUT, move |lab, conn| {
            crate::search::lab::memory_search(conn, &lab.spec.project, &input, semantic(&embedded))
        })
        .await
    }

    async fn history_search(
        self: Arc<Self>,
        input: Value,
        summaries_only: bool,
    ) -> Result<String, String> {
        const TIMEOUT: &str = "history_search timed out; narrow the query";
        let deadline = Instant::now() + frozen::SEARCH_LIMIT;
        let query = query_text(&input).to_owned();
        let can_rerank =
            self.spec.rerank && input.get("order").is_none_or(|order| order == "relevance");
        let (embedded, scorer) = tokio::join!(
            tokio::time::timeout_at(deadline.into(), self.embed(&query)),
            async {
                if can_rerank {
                    self.ranking.prepare(&query, deadline).await
                } else {
                    None
                }
            },
        );
        let embedded = embedded.map_err(|_| TIMEOUT.to_owned())?;
        let pool = scorer.as_ref().map(ranking::Scorer::pool);
        let mut prepared = self
            .clone()
            .read_frozen(deadline, TIMEOUT, move |lab, conn| {
                lab.history
                    .prepare(conn, &input, semantic(&embedded), pool, summaries_only)
            })
            .await?;
        if let Some(scorer) = scorer {
            scorer.apply(&query, &mut prepared, deadline).await;
        }
        Ok(if summaries_only {
            prepared.render_two_summaries(&self.history.scope)
        } else {
            prepared.render(&self.history.scope)
        })
    }

    async fn history_read(self: Arc<Self>, input: Value) -> Result<String, String> {
        self.read_frozen(
            Instant::now() + frozen::SEARCH_LIMIT,
            "history_read timed out; narrow the date range",
            move |lab, conn| {
                crate::search::lab::history_read(
                    conn,
                    &lab.spec.project,
                    &lab.history.scope,
                    &input,
                )
            },
        )
        .await
    }

    async fn read_frozen<T: Send + 'static>(
        self: Arc<Self>,
        deadline: Instant,
        timed_out: &'static str,
        work: impl FnOnce(&Self, &rusqlite::Connection) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let task = tokio::task::spawn_blocking(move || {
            let conn = self.store.lock().expect("frozen store");
            frozen::search_with_limit(
                &conn,
                deadline.saturating_duration_since(Instant::now()),
                timed_out,
                |conn| work(&self, conn),
            )
        });
        tokio::time::timeout_at(deadline.into(), task)
            .await
            .map_err(|_| timed_out.to_owned())?
            .map_err(|e| e.to_string())?
    }

    async fn submit(self: Arc<Self>, input: Value) -> Result<String, String> {
        let lab = self.clone();
        let verdicts::Submission {
            mut reply,
            challenges,
        } = tokio::task::spawn_blocking(move || {
            let mut current = lab.verdicts.lock().expect("lab verdicts");
            if lab.stopped.load(Ordering::Acquire) {
                return Err("the dreamer lab has ended".into());
            }
            verdicts::submit(
                &lab.spec.out_dir,
                &lab.spec.memory_ids,
                &mut current,
                input,
                lab.spec.confirm_record_removals,
                |id| lab.active_merge(id),
            )
        })
        .await
        .map_err(|e| e.to_string())??;
        for (id, challenge) in challenges {
            if matches!(challenge, verdicts::Challenge::Evidence) {
                let (origin, summaries) = self.clone().removal_evidence(id).await;
                reply.push_str(&format!(
                    "\n\n### Memory {id}: confirmation evidence\nOrigin:\n{origin}\n\n{summaries}"
                ));
            }
            reply.push_str(&format!("\nMemory {id} is unconfirmed. Send the same verdict with `confirmed: true`, or send a different verdict."));
        }
        Ok(reply)
    }

    async fn removal_evidence(self: Arc<Self>, id: i64) -> (String, String) {
        let deadline = Instant::now() + frozen::SEARCH_LIMIT;
        let frozen = self.clone().read_frozen(deadline, "reading the origin timed out", move |lab, conn| {
            let origin = lab.memories.origins.get(&id).map(|(session, origin)| origin.render(conn, &lab.history.scope, session))
                .transpose()?.unwrap_or_else(|| "No origin summary could be located.".into());
            let content: String = conn.query_row("SELECT content FROM memories WHERE id = ?1 AND level = 'project' AND owner_id = ?2",
                rusqlite::params![id, lab.spec.project], |row| row.get(0)).map_err(|e| format!("reading frozen memory {id}: {e}"))?;
            Ok((origin, content))
        }).await;
        match frozen {
            Ok((origin, content)) => {
                let summaries = self
                    .history_search(json!({"query":content,"order":"newest"}), true)
                    .await
                    .unwrap_or_else(|error| format!("## Summaries\nUnavailable: {error}"));
                (origin, summaries)
            }
            Err(error) => (
                format!("Unavailable: {error}"),
                "## Summaries\nUnavailable: could not read the frozen memory text.".into(),
            ),
        }
    }
}

fn query_text(input: &Value) -> &str {
    input["query"].as_str().unwrap_or("").trim()
}

fn semantic(
    embedded: &Option<(Vec<f32>, String, String)>,
) -> Option<crate::search::sources::Semantic<'_>> {
    embedded
        .as_ref()
        .map(|(vector, model, chunk)| crate::search::sources::Semantic {
            vector,
            model_id: model,
            chunk_model_id: chunk,
        })
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

fn searches_history(spec: &Spec) -> bool {
    spec.tools.contains(&Tool::HistorySearch) || spec.confirm_record_removals
}

fn tool_definitions(spec: &Spec, scope: &HistoryScope) -> Result<Vec<Value>, String> {
    let mut tools = Vec::new();
    let mut add = |name, description: &str, schema, read_only| -> Result<(), String> {
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
                "checkout":{"type":"string","enum":spec.checkouts.keys().collect::<Vec<_>>(),"description":"Name of the lab checkout to read, from the listed choices."},
                "command":{"type":"string","enum":git::commands().collect::<Vec<_>>(),"description":"Git subcommand to run, from the listed choices."},
                "refs":{"type":"array","items":{"type":"string"},"description":"List of local commit refs, such as branch names, tags or commit IDs."},
                "paths":{"type":"array","items":{"type":"string"},"description":"Literal paths relative to the checkout; blame takes one path."},
                "options":{"type":"array","items":{"type":"string","enum":git::options()},"description":"List of literal Git flags allowed for the chosen subcommand."}
            }}), true)?;
    }
    if spec.tools.contains(&Tool::MemorySearch) {
        add(
            "memory_search",
            r##"Find other project memories about the same subject, or look memories up by id.

Retrieval matches meaning and exact words and fuses them, so phrase `query` as a natural-language question that still carries the exact terms you expect (a name, a number, a setting); a bare keyword stack finds less.
- "which memories say how a release tag is cut again after a failed publish?"
- Not: "release tag re-cut retry"
A query that is only memory ids ("#123" or "12, 34") returns those memories.

Returns active matches first, then archived matches marked as archived, with each memory's category, creation date, importance and text. Does not return messages, summaries or commits."##,
            json!({"type":"object","additionalProperties":false,"required":["query"],"properties":{
                "query":{"type":"string","description":"A natural-language question about the subject, carrying the exact terms you expect; or memory ids."},
                "limit":{"type":"integer","minimum":1,"maximum":20,"default":10,"description":"How many memories to return, 1 to 20."}
            }}),
            true,
        )?;
    }
    if spec.tools.contains(&Tool::HistorySearch) {
        add(
            "history_search",
            r#"Search the project's history: summaries of past work, the person's own messages, and commits, each in its own group with dates.

Retrieval matches meaning and exact words and fuses them, so phrase `query` as a natural-language question that still carries the exact terms you expect in the answer (a file, a setting, a command); a bare keyword stack finds less.
- "why did we stop publishing nightly builds?"  (a decision and its reasons)
- "when was the `retry_limit` setting renamed, and what is it called now?"  (a later change to something a memory names)
- "what did the person decide about squash merges?"  (a ruling)
- Not: "nightly build publish stop"

`from` and `to` bound the dates. `order: newest` returns the most recent matches first; use it to learn what was done last about a subject. Each summary hit has a `ref`; `history_read` shows that summary in full."#,
            json!({"type":"object","additionalProperties":false,"required":["query"],"properties":{
                "query":{"type":"string","description":"A natural-language question carrying the exact terms you expect in the answer."},
                "from":{"type":"string","description":"Inclusive start date (YYYY-MM-DD in UTC, or a full ISO datetime)."},
                "to":{"type":"string","description":"Inclusive end date (YYYY-MM-DD in UTC, or a full ISO datetime)."},
                "limit":{"type":"integer","minimum":1,"maximum":3,"default":1,"description":"1 to 3. Each step adds 4 summaries, 4 of the person's messages and 3 commits."},
                "order":{"type":"string","enum":["relevance","newest"],"default":"relevance","description":"Use newest to learn what was done most recently about the subject."},
                "include_agent":{"type":"boolean","default":false,"description":"Also return the agent's own messages. Off by default, because summaries and the person's messages carry the decisions."}
            }}),
            true,
        )?;
    }
    if spec.tools.contains(&Tool::HistoryRead) {
        let mut schema = json!({"type":"object","additionalProperties":false,"properties":{
                "ref":{"type":"string","description":format!("Reference to one summary, in the form {}.", scope.reference_form())},
                "from":{"type":"string","description":"Inclusive start date (YYYY-MM-DD in UTC, or a full ISO datetime)."},
                "to":{"type":"string","description":"Inclusive end date (YYYY-MM-DD in UTC, or a full ISO datetime)."},
                "offset":{"type":"integer","minimum":0,"description":"Continue a long summary from this character position; the previous result names the value."}
            },"oneOf":[{"required":["ref"],"not":{"anyOf":[{"required":["from"]},{"required":["to"]}]}},
                       {"required":["from","to"],"not":{"anyOf":[{"required":["ref"]},{"required":["offset"]}]}}]});
        let dates = if let Some(labels) = scope.labels() {
            schema["properties"]["session"] = json!({"type":"string","enum":labels,"description":"History session label (such as s2) when reading by date."});
            schema["oneOf"][0]["not"]["anyOf"]
                .as_array_mut()
                .expect("ref exclusions")
                .push(json!({"required":["session"]}));
            schema["oneOf"][1]["required"] = json!(["session", "from", "to"]);
            "a `session` label with `from` and `to` dates"
        } else {
            "`from` and `to` dates"
        };
        let description = format!("Read summaries of past work in full. Give the `ref` of a `history_search` summary or of a memory's `origin`, or {dates}.");
        add("history_read", description.as_str(), schema, true)?;
    }
    if spec.tools.contains(&Tool::Submit) {
        add("submit", "Record verdicts for some lab memories. Supply reasoning for every verdict except keep. Later calls may replace an earlier verdict for the same id.", verdicts::schema(spec.confirm_record_removals, scope.labels().is_some()), false)?;
    }
    Ok(tools)
}
