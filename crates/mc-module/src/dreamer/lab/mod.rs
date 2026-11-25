//! One unscheduled, read-only dreamer experiment.

mod frozen;
mod git;
mod persona;
mod spec;
#[cfg(test)]
mod tests;
mod verdicts;

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use cortexkit_persona::{
    AgentContext, Demand, EnvContext, HarnessContext, ModelContext, OsName, RenderContext,
};
use cortexkit_role_compaction::setup::ModelRef;
use cortexkit_role_llm_runner::usage::RunUsage;
use cortexkit_role_routing::select::SelectRequest;
use cortexkit_role_tool_provider::catalog::{self, composition_digest};
use serde::Serialize;
use serde_json::{json, Value};

use crate::client::{Child, RunnerClient};
use crate::routing::{self, Router};
use crate::summary::fit::Window;
use crate::summary::run::PlanRun;

use super::{plan, run};
use spec::{Route, Spec, Tool};

static RUNS: AtomicU64 = AtomicU64::new(0);
const OWN_NAMES: [&str; 3] = ["git_read", "memory_search", "submit"];
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
pub(crate) struct Registry(Mutex<HashMap<String, (Child, Arc<Lab>)>>);

impl Registry {
    pub(crate) fn get(&self, route: &crate::route::Route) -> Option<Arc<Lab>> {
        let children = self.0.lock().expect("lab sessions");
        let (child, lab) = children.get(&route.session.session)?;
        (route.session.runner == child.session.runner && route.workdir == child.project_root)
            .then(|| lab.clone())
    }

    fn register(&self, child: Child, lab: Arc<Lab>) -> Registered<'_> {
        let id = child.session.session.clone();
        self.0
            .lock()
            .expect("lab sessions")
            .insert(id.clone(), (child, lab));
        Registered(self, id)
    }
}

pub(super) struct Registered<'a>(&'a Registry, String);

impl Drop for Registered<'_> {
    fn drop(&mut self) {
        self.0 .0.lock().expect("lab sessions").remove(&self.1);
    }
}

pub(crate) struct Lab {
    spec: Spec,
    context: String,
    memories: String,
    persona: persona::Persona,
    store: Mutex<rusqlite::Connection>,
    history: crate::search::lab::History,
    embedding: Option<crate::embedding::Provider>,
    tools: Vec<Value>,
    verdicts: Mutex<verdicts::Verdicts>,
}

pub(crate) struct Start {
    spec: Spec,
    live: PathBuf,
}

impl Start {
    pub(crate) async fn load(path: &Path, live: &Path) -> Result<Self, String> {
        let spec = Spec::load(path, live).await?;
        spec.prepare_output()?;
        Ok(Self {
            spec,
            live: live.to_owned(),
        })
    }

    pub(crate) fn out_dir(&self) -> &Path {
        &self.spec.out_dir
    }
    pub(crate) fn root(&self) -> &Path {
        &self.spec.root
    }
    pub(crate) fn project(&self) -> &str {
        &self.spec.project
    }

    pub(crate) async fn execute<C: RunnerClient + Router>(
        self,
        client: Arc<C>,
        registry: Arc<Registry>,
        embedding: Option<crate::embedding::Provider>,
    ) {
        let start = Instant::now();
        let out = self.spec.out_dir.clone();
        let ids = self.spec.memory_ids.clone();
        let mut observed = Observed::default();
        let (ended, missing, error) =
            match tokio::task::spawn_blocking(move || Lab::load(self, embedding)).await {
                Ok(Ok(lab)) => {
                    let lab = Arc::new(lab);
                    let answer = lab
                        .execute(client.as_ref(), registry.as_ref(), &mut observed)
                        .await;
                    let missing = verdicts::missing(
                        &lab.spec.memory_ids,
                        &lab.verdicts.lock().expect("lab verdicts"),
                    );
                    let (ended, error) = match answer {
                        Ok(()) if missing.is_empty() => ("complete", None),
                        Ok(()) => ("incomplete", None),
                        Err(run::LabEnd::StepCap) => ("step_cap", None),
                        Err(run::LabEnd::Refused(e)) => ("refusal", Some(e)),
                        Err(run::LabEnd::Error(e)) => ("error", Some(e)),
                    };
                    (ended, missing, error)
                }
                Ok(Err(error)) => ("refusal", ids, Some(error)),
                Err(error) => ("error", ids, Some(error.to_string())),
            };
        let result = observed.result(ended, missing, error, start.elapsed().as_millis());
        if let Err(error) = verdicts::write_json(&out, "run.json", &result) {
            tracing::info!(%error, "ck-mc: dreamer lab could not record the result");
        }
    }
}

impl Lab {
    fn load(start: Start, embedding: Option<crate::embedding::Provider>) -> Result<Self, String> {
        let Start { spec, live } = start;
        spec::reject_live(&spec.store, &live)?;
        let store = frozen::open(&spec.store)?;
        let memories = frozen::memories(&store, &spec.project, &spec.memory_ids)?;
        let history = crate::search::lab::History::load(
            &store,
            &spec.project,
            spec.history_sessions.as_deref(),
        )?;
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
        })
    }

    async fn execute<C: RunnerClient + Router>(
        self: &Arc<Self>,
        client: &C,
        registry: &Registry,
        observed: &mut Observed,
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
        let job = run::TaskRun {
            demand: &routing::LAB_DEMAND,
            run_id: &id,
            project_root: root,
            reader: reader.as_deref(),
            remaining_tokens: u64::MAX,
            attribution: None,
        };
        run::run_lab(client, &job, self, registry, observed).await
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
            .map(|name| (name.into(), false))
            .collect();
        let mut exact = Vec::new();
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
                exact.push(serde_json::to_value(tool).map_err(|e| e.to_string())?);
            }
            providers.insert(reader, composition_tools(definitions));
            tool_items.push(json!({"provider": reader, "preset": preset, "params":{}}));
        }
        let mut own = Vec::new();
        for tool in &self.tools {
            let name = tool["name"].as_str().expect("lab tool name");
            if tools.insert(name.into(), true) == Some(true) {
                return Err(format!("the reader and lab both serve {name}"));
            }
            exact.push(tool.clone());
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
        let (system, prompt) =
            self.persona
                .render(context, tools, &self.context, &self.memories)?;
        if system.trim().is_empty() || prompt.trim().is_empty() {
            return Err("the lab system text and first message must not be empty".into());
        }
        if !window.admits(output_tokens, &system, &prompt) {
            return Err("the exact lab request does not fit the selected model".into());
        }
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
            tools: exact,
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
        prepared: &Prepared,
    ) -> Result<Registered<'a>, String> {
        verdicts::write_json(
            &self.spec.out_dir,
            "request.json",
            &json!({
                "system": prepared.system, "first_message": prepared.prompt, "tools": prepared.tools,
            }),
        )?;
        Ok(registry.register(child.clone(), self.clone()))
    }

    pub(crate) fn tools(&self) -> &[Value] {
        &self.tools
    }

    pub(crate) async fn tool(self: Arc<Self>, name: &str, input: Value) -> Result<String, String> {
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
                verdicts::submit(
                    &self.spec.out_dir,
                    &self.spec.memory_ids,
                    &mut self.verdicts.lock().expect("lab verdicts"),
                    input,
                )
            })
            .await
            .map_err(|e| e.to_string())?,
            "memory_search" => {
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
                    frozen::search(
                        &self.store.lock().expect("frozen store"),
                        &self.spec.project,
                        &self.history,
                        input,
                        semantic.as_ref().map(|(vector, model, chunk)| {
                            crate::search::sources::Semantic {
                                vector,
                                model_id: model,
                                chunk_model_id: chunk,
                            }
                        }),
                    )
                })
                .await
                .map_err(|e| e.to_string())?
            }
            _ => Err(format!("unknown lab tool {name}")),
        }
    }
}

pub(super) struct Prepared {
    pub system: String,
    pub prompt: String,
    tools: Vec<Value>,
    pub plan: PlanRun,
}

#[derive(Default)]
pub(super) struct Observed {
    pub model: Option<ModelRef>,
    pub route: Option<String>,
    pub child: Option<String>,
    pub runner: Option<String>,
    pub usage: Option<RunUsage>,
}

#[derive(Serialize)]
struct Totals {
    new_input: Option<u64>,
    cached_input: Option<u64>,
    output: Option<u64>,
}

impl Observed {
    fn result(
        self,
        ended: &str,
        missing: Vec<i64>,
        error: Option<String>,
        wall_time_ms: u128,
    ) -> Value {
        let total = self.usage.as_ref().map(|usage| Totals {
            // `input_tokens` is the uncached input; cache creation is also new work.
            new_input: match (usage.input_tokens, usage.cache_write_tokens) {
                (None, None) => None,
                (input, write) => Some(input.unwrap_or(0).saturating_add(write.unwrap_or(0))),
            },
            cached_input: usage.cached_input_tokens,
            output: usage.output_tokens,
        });
        json!({"model":self.model,"route":self.route,"child_session_id":self.child,"runner":self.runner,
            "steps":self.usage.as_ref().map(|usage| usage.steps),"usage":{"total":total,"per_step":null,
                "per_step_unavailable":"the runner's run result reports aggregate usage only"},
            "wall_time_ms":wall_time_ms,"ended":ended,"missing_ids":missing,"error":error})
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
                "command":{"type":"string","enum":["log","show","diff","blame","ls-files"]},
                "refs":{"type":"array","items":{"type":"string"}},
                "paths":{"type":"array","items":{"type":"string"},"description":"Literal paths relative to the checkout; blame takes one path."},
                "options":{"type":"array","items":{"type":"string","enum":["--oneline","--stat","--name-only","--name-status"]}}
            }}), true)?;
    }
    if spec.tools.contains(&Tool::MemorySearch) {
        let search = crate::catalog::definition()
            .tool("ctx_search")
            .expect("ctx_search definition");
        let mut schema = crate::catalog::input_schema(search, crate::catalog::Surface::Full)
            .map_err(|e| e.into_refusal().message)?;
        schema["properties"]["sources"]["items"]["enum"] =
            json!(["memory", "message", "git_commit"]);
        add(
            "memory_search",
            "Search this project's frozen memories, messages, summaries and commits.",
            schema,
            true,
        )?;
    }
    if spec.tools.contains(&Tool::Submit) {
        add("submit", "Record verdicts for some lab memories. Later calls may replace an earlier verdict for the same id.", verdicts::schema(), false)?;
    }
    Ok(tools)
}
