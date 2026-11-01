//! Off-thread Dreamer child lifecycle. Callers supply a trusted, effective config
//! snapshot, not a request's model chain. Carriers implement the subc Host/Broca
//! boundary; this module never starts work from a served transform.

// Background scheduler and manual-dream callers will supply runtime carriers;
// the served handlers deliberately do not invoke this module.
#![allow(dead_code)]

use crate::config::McModuleConfig;
use crate::historian_runner::ResolvedRunner;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelEntry {
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub qualifier: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskModels {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary: Option<ModelEntry>,
    pub fallbacks: Vec<ModelEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schedule: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_minutes: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub promotion_threshold: Option<f64>,
}

fn text(value: Option<&Value>) -> Option<String> {
    value?
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn qualifier_key(harness: &str) -> &'static str {
    if harness == "opencode" {
        "variant"
    } else {
        "thinking_level"
    }
}

fn normalize(entry: &Value, harness: &str) -> Option<ModelEntry> {
    Some(ModelEntry {
        model: text(Some(if entry.is_string() {
            entry
        } else {
            entry.get("model")?
        }))?,
        qualifier: text(entry.get(qualifier_key(harness))),
    })
}

fn coalesce<'a>(first: Option<&'a Value>, second: Option<&'a Value>) -> Option<&'a Value> {
    first.filter(|v| !v.is_null()).or(second)
}

/// Matches shared/model-resolution.ts's resolveDreamerTaskModel: only the
/// selected harness supplies model attempts; scheduling stays outside its subtree.
/// Both OpenCode hosts read the `opencode` model/variant configuration block.
/// The snapshot must already have the user's selected profile applied by config
/// loading. A project or management request must not supply this snapshot.
pub fn resolve_task_models(config: &Value, harness: &str, task: &str) -> TaskModels {
    let harness = if harness == "opencode2" {
        "opencode"
    } else {
        harness
    };
    let dreamer = &config["dreamer"];
    let block = if harness == "omp" {
        coalesce(dreamer.get("omp"), dreamer.get("pi"))
    } else {
        dreamer.get(harness)
    }
    .filter(|v| v.is_object());
    let task_block = block
        .and_then(|v| v.get("tasks"))
        .and_then(|v| v.get(task))
        .filter(|v| v.is_object());
    let schedule = &dreamer["tasks"][task];
    let key = qualifier_key(harness);
    let model_qualifier = block
        .and_then(|v| v.get("model"))
        .and_then(|v| normalize(v, harness))
        .and_then(|m| m.qualifier)
        .map(Value::String);
    let harness_qualifier = coalesce(block.and_then(|v| v.get(key)), model_qualifier.as_ref());
    let default_qualifier = coalesce(task_block.and_then(|v| v.get(key)), harness_qualifier);
    let selected = |key: &str| {
        task_block
            .and_then(|v| v.get(key))
            .or_else(|| block.and_then(|v| v.get(key)))
    };
    let primary = selected("model")
        .and_then(|v| normalize(v, harness))
        .map(|mut model| {
            model.qualifier = model.qualifier.or_else(|| text(default_qualifier));
            model
        });
    let mut fallbacks = Vec::new();
    if let Some(value) = selected("fallback_models") {
        let values: Vec<&Value> = match value.as_array() {
            Some(a) => a.iter().collect(),
            None => vec![value],
        };
        for value in values {
            if let Some(model) = normalize(value, harness) {
                if model
                    .model
                    .split_once('/')
                    .is_some_and(|(p, m)| !p.is_empty() && !m.is_empty())
                    && !fallbacks.contains(&model)
                {
                    fallbacks.push(model);
                }
            }
        }
    }
    TaskModels {
        primary,
        fallbacks,
        schedule: text(schedule.get("schedule")),
        timeout_minutes: task_block
            .and_then(|v| v.get("timeout_minutes"))
            .and_then(Value::as_f64),
        promotion_threshold: schedule.get("promotion_threshold").and_then(Value::as_f64),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DreamRole {
    Classifier,
    MemoryMapper,
    Curate,
    Docs,
    Reviewer,
    PrimerInvestigator,
    Retrospective,
}

impl DreamRole {
    pub fn agent(self) -> &'static str {
        match self {
            Self::Classifier => "dreamer-classifier",
            Self::MemoryMapper => "dreamer-memory-mapper",
            Self::Curate => "dreamer",
            Self::Docs => "dreamer-docs",
            Self::Reviewer => "dreamer-reviewer",
            Self::PrimerInvestigator => "dreamer-primer-investigator",
            Self::Retrospective => "dreamer-retrospective",
        }
    }

    pub fn tools(self) -> &'static [&'static str] {
        const READ: &[&str] = &[
            "read",
            "grep",
            "glob",
            "aft_outline",
            "aft_zoom",
            "aft_search",
        ];
        match self {
            Self::Classifier | Self::Reviewer => &[],
            Self::Retrospective => &["ctx_search"],
            Self::MemoryMapper | Self::Docs => READ,
            Self::Curate => &["ctx_memory"],
            Self::PrimerInvestigator => &[
                "read",
                "grep",
                "glob",
                "aft_outline",
                "aft_zoom",
                "aft_search",
                "ctx_search",
            ],
        }
    }

    pub fn max_steps(self) -> u32 {
        match self {
            Self::Classifier | Self::Reviewer => 4,
            Self::Curate => 150,
            Self::MemoryMapper | Self::Docs => 60,
            Self::PrimerInvestigator | Self::Retrospective => 40,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ChildRequest {
    pub runner: ResolvedRunner,
    pub parent_session_id: String,
    pub directory: PathBuf,
    pub agent: &'static str,
    pub allowed_tools: &'static [&'static str],
    pub max_steps: u32,
    pub model: Option<ModelEntry>,
    pub system: String,
    pub prompt: String,
    pub timeout: Duration,
    pub token_budget: Option<u64>,
    /// Dreamer does not inherit historian or foreground sampling settings.
    pub temperature: Option<f64>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Usage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

#[derive(Debug, Default, Clone)]
pub struct Completion {
    pub text: String,
    pub length_capped: bool,
    pub usage: Usage,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CarrierError {
    pub message: String,
    pub retryable: bool,
}

/// A subc completion carrier, not an alternate selector. `open` must lock tools
/// to the allow-list and fence filesystem access to `directory`, without inheriting
/// foreground permissions. `complete` enforces the optional per-session prompt
/// token budget (mc-store's TokenBudget). `close(false)` aborts unfinished work;
/// closing a Broca route retains its append-only session rather than deleting it.
/// These operations must be cancellation-safe, including a timed-out open.
#[allow(async_fn_in_trait)]
pub trait DreamCarrier {
    async fn open(&mut self, request: &ChildRequest) -> Result<String, CarrierError>;
    async fn complete(
        &mut self,
        child: &str,
        request: &ChildRequest,
    ) -> Result<Completion, CarrierError>;
    async fn close(&mut self, child: &str, prompt_settled: bool) -> Result<(), CarrierError>;
}

pub struct DreamRequest<'a> {
    pub task: &'a str,
    pub role: DreamRole,
    pub harness: &'a str,
    pub parent_session_id: &'a str,
    pub directory: &'a Path,
    pub system: &'a str,
    pub prompt: &'a str,
    pub timeout: Duration,
    pub token_budget: Option<u64>,
    pub allow_empty: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Failure {
    Inactive,
    InvalidRequest,
    Open(String),
    Transport(String),
    Timeout,
    LengthCapped,
    Empty,
    Validation(String),
    Cleanup(String),
}

#[derive(Debug, Clone)]
pub struct Attempt {
    pub model: Option<ModelEntry>,
    pub child: Option<String>,
    pub usage: Usage,
    pub failure: Option<Failure>,
    pub cleanup_failure: Option<String>,
}

#[derive(Debug)]
pub struct RunResult<T> {
    pub result: Result<T, Failure>,
    pub attempts: Vec<Attempt>,
}

/// Run off the serving thread with the activation value captured by the caller
/// at task start. No configuration toggle is re-read here. No chain is accepted
/// from the host: primary and ordered alternates are selected here from config.
/// A missing primary deliberately leaves model selection to the carrier's session
/// default; no built-in provider or historian chain is invented.
pub async fn run_dream_task<T>(
    activated: bool,
    route_config: &McModuleConfig,
    trusted_config: &Value,
    request: &DreamRequest<'_>,
    carrier: &mut impl DreamCarrier,
    mut validate: impl FnMut(&Completion) -> Result<T, String>,
) -> RunResult<T> {
    let mut report = RunResult {
        result: Err(Failure::Inactive),
        attempts: Vec::new(),
    };
    if !activated {
        return report;
    }
    if request.parent_session_id.is_empty()
        || !request.directory.is_absolute()
        || request.timeout.is_zero()
        || request.token_budget == Some(0)
    {
        report.result = Err(Failure::InvalidRequest);
        return report;
    }
    let models = resolve_task_models(trusted_config, request.harness, request.task);
    let timeout = models
        .timeout_minutes
        .and_then(|v| Duration::try_from_secs_f64(v * 60.0).ok())
        .map_or(request.timeout, |v| v.min(request.timeout));
    let deadline = tokio::time::Instant::now() + timeout;
    let runner = route_config.dreamer_runner_for(request.harness);
    for model in std::iter::once(models.primary).chain(models.fallbacks.into_iter().map(Some)) {
        let child_request = ChildRequest {
            runner,
            parent_session_id: request.parent_session_id.into(),
            directory: request.directory.into(),
            agent: request.role.agent(),
            allowed_tools: request.role.tools(),
            max_steps: request.role.max_steps(),
            model: model.clone(),
            system: request.system.into(),
            prompt: request.prompt.into(),
            timeout: deadline.saturating_duration_since(tokio::time::Instant::now()),
            token_budget: request.token_budget,
            temperature: None,
        };
        if child_request.timeout.is_zero() {
            report.result = Err(Failure::Timeout);
            break;
        }
        let mut attempt = Attempt {
            model,
            child: None,
            usage: Usage::default(),
            failure: None,
            cleanup_failure: None,
        };
        let opened = tokio::time::timeout_at(deadline, carrier.open(&child_request)).await;
        let child = match opened {
            Ok(Ok(child)) if !child.is_empty() => child,
            other => {
                let (failure, retryable) = match other {
                    Ok(Err(e)) => (Failure::Open(e.message), e.retryable),
                    Err(_) => (Failure::Timeout, false),
                    _ => (
                        Failure::Open("carrier returned no session id".into()),
                        false,
                    ),
                };
                attempt.failure = Some(failure.clone());
                report.result = Err(failure);
                report.attempts.push(attempt);
                if retryable {
                    continue;
                } else {
                    break;
                }
            }
        };
        attempt.child = Some(child.clone());
        let mut retryable = true;
        let answer =
            match tokio::time::timeout_at(deadline, carrier.complete(&child, &child_request)).await
            {
                Ok(Ok(completion)) => {
                    attempt.usage = completion.usage.clone();
                    if completion.length_capped {
                        Err(Failure::LengthCapped)
                    } else if completion.text.is_empty() && !request.allow_empty {
                        Err(Failure::Empty)
                    } else {
                        validate(&completion).map_err(Failure::Validation)
                    }
                }
                Ok(Err(e)) => {
                    retryable = e.retryable;
                    Err(Failure::Transport(e.message))
                }
                Err(_) => {
                    retryable = false;
                    Err(Failure::Timeout)
                }
            };
        let settled = answer.is_ok();
        attempt.failure = answer.as_ref().err().cloned();
        let cleanup =
            tokio::time::timeout(Duration::from_secs(3), carrier.close(&child, settled)).await;
        attempt.cleanup_failure = match cleanup {
            Ok(Ok(())) => None,
            Ok(Err(e)) => Some(e.message),
            Err(_) => Some("cleanup timeout".into()),
        };
        report.result = answer;
        // Never run another paid attempt while cleanup of its predecessor failed.
        if let Some(error) = &attempt.cleanup_failure {
            report.result = Err(Failure::Cleanup(error.clone()));
            retryable = false;
        }
        let done = report.result.is_ok() || !retryable;
        report.attempts.push(attempt);
        if done {
            break;
        }
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::historian_runner::{HistorianRunnerKind as Kind, HOST_RUNNER_HARNESSES};
    use serde_json::json;
    use std::collections::VecDeque;

    // These tests compare model selection, locked role tools and complete-output
    // validation against the TypeScript implementation at the fixed revision
    // 282d9c08bce490346583a3b8c145c402499f980f. SHA-256 of
    // packages/plugin/src/shared/model-resolution.ts:
    // e22efd439af02c77817e6ca665d927a12c326d7be574d8f82dc1acc16023812d
    // packages/plugin/src/features/magic-context/dreamer/hidden-single-shot.ts:
    // 8354caf46d78eaf0be88ede1e00eb1448de8c4924f214758ea52f4af26bf3560
    // packages/plugin/src/agents/hidden-agent-registrations.ts:
    // c3ca247e26b6f4f9b0fb473723c9ec3dc68f8090623737d70f453158def96347
    // Selector expectations below were generated by executing the pinned TS
    // selector, not by serializing the Rust result. Role limits are frozen from
    // the pinned registrations; lifecycle guards follow hidden-single-shot.
    fn config() -> Value {
        json!({"historian":{"temperature":0.9,"opencode":{"model":"history/never"}},"dreamer":{
            "opencode":{"model":{"model":"base/model","variant":"high"},
                "fallback_models":[" bad "," alternate/model ",{"model":"alternate/model","variant":"low"},"alternate/model"],
                "tasks":{
                    "classify":{"model":" task/model ","timeout_minutes":2},
                    "curate":{"model":null,"fallback_models":[]},
                    "verify":{"model":{"model":"verify/model","variant":"low"},"variant":"ignored",
                        "fallback_models":[{"model":"other/model","variant":"fast"},{"model":"other/model"}]}}},
            "pi":{"model":{"model":"pi/default","thinking_level":"medium"},"fallback_models":{"model":"pi/fallback","thinking_level":"low"}},
            "tasks":{"classify":{"schedule":" 0 3 * * * ","promotion_threshold":3},"curate":{"schedule":""}}
        }})
    }

    #[test]
    fn selector_matches_pinned_typescript_vectors() {
        let cases = [
            (
                "opencode",
                "classify",
                json!({"primary":{"model":"task/model","qualifier":"high"},"fallbacks":[{"model":"alternate/model"},{"model":"alternate/model","qualifier":"low"}],"schedule":"0 3 * * *","timeoutMinutes":2,"promotionThreshold":3}),
            ),
            ("opencode", "curate", json!({"fallbacks":[]})),
            (
                "opencode",
                "verify",
                json!({"primary":{"model":"verify/model","qualifier":"low"},"fallbacks":[{"model":"other/model","qualifier":"fast"},{"model":"other/model"}]}),
            ),
            (
                "pi",
                "classify",
                json!({"primary":{"model":"pi/default","qualifier":"medium"},"fallbacks":[{"model":"pi/fallback","qualifier":"low"}],"schedule":"0 3 * * *","promotionThreshold":3}),
            ),
            (
                "omp",
                "classify",
                json!({"primary":{"model":"pi/default","qualifier":"medium"},"fallbacks":[{"model":"pi/fallback","qualifier":"low"}],"schedule":"0 3 * * *","promotionThreshold":3}),
            ),
            (
                "unknown",
                "classify",
                json!({"fallbacks":[],"schedule":"0 3 * * *","promotionThreshold":3}),
            ),
            (
                "opencode",
                "compress-cues",
                json!({"primary":{"model":"base/model","qualifier":"high"},"fallbacks":[{"model":"alternate/model"},{"model":"alternate/model","qualifier":"low"}]}),
            ),
        ];
        for (harness, task, expected) in cases {
            assert_eq!(
                resolve_task_models(&config(), harness, task),
                serde_json::from_value::<TaskModels>(expected).unwrap(),
                "{harness}/{task}"
            );
        }
        let mut own_omp = config();
        own_omp["dreamer"]["omp"] = json!({});
        assert_eq!(
            serde_json::to_value(resolve_task_models(&own_omp, "omp", "verify")).unwrap(),
            json!({"fallbacks":[]})
        );
        let empty = json!({"dreamer":{"opencode":{"model":"only/primary","variant":"","tasks":{"classify":{"model":"override/model","variant":""}}}}});
        assert_eq!(
            serde_json::to_value(resolve_task_models(&empty, "opencode", "classify")).unwrap(),
            json!({"primary":{"model":"override/model"},"fallbacks":[]})
        );
        assert_eq!(
            resolve_task_models(&config(), "opencode2", "classify"),
            resolve_task_models(&config(), "opencode", "classify")
        );
    }

    #[derive(Default)]
    struct FakeCarrier {
        opened: Vec<ChildRequest>,
        closed: Vec<(String, bool)>,
        responses: VecDeque<Result<Completion, CarrierError>>,
        park: bool,
        fail_close: bool,
    }

    impl DreamCarrier for FakeCarrier {
        async fn open(&mut self, request: &ChildRequest) -> Result<String, CarrierError> {
            self.opened.push(request.clone());
            Ok(format!("child-{}", self.opened.len()))
        }
        async fn complete(
            &mut self,
            _: &str,
            _: &ChildRequest,
        ) -> Result<Completion, CarrierError> {
            if self.park {
                return std::future::pending().await;
            }
            self.responses.pop_front().unwrap_or_else(|| {
                Ok(Completion {
                    text: "valid".into(),
                    ..Default::default()
                })
            })
        }
        async fn close(&mut self, child: &str, settled: bool) -> Result<(), CarrierError> {
            self.closed.push((child.into(), settled));
            if self.fail_close {
                Err(CarrierError {
                    message: "lost route".into(),
                    retryable: false,
                })
            } else {
                Ok(())
            }
        }
    }

    fn request() -> DreamRequest<'static> {
        DreamRequest {
            task: "classify",
            role: DreamRole::Classifier,
            harness: "opencode",
            parent_session_id: "parent",
            directory: Path::new("/fixture/project"),
            system: "system",
            prompt: "prompt",
            timeout: Duration::from_secs(5),
            token_budget: Some(100),
            allow_empty: false,
        }
    }

    async fn run_route(config: &McModuleConfig, harness: &str) -> Kind {
        let mut carrier = FakeCarrier::default();
        let mut req = request();
        req.harness = harness;
        let report = run_dream_task(true, config, &self::config(), &req, &mut carrier, |c| {
            Ok(c.text.clone())
        })
        .await;
        assert!(report.result.is_ok());
        carrier.opened[0].runner.kind
    }

    #[tokio::test]
    async fn dreamer_routes_use_canonical_harness_defaults() {
        let config = McModuleConfig::default();
        for harness in HOST_RUNNER_HARNESSES {
            assert_eq!(run_route(&config, harness).await, Kind::Host, "{harness}");
            assert_eq!(config.dreamer_runner_for(harness).kind, Kind::Host);
        }
        for harness in [
            "",
            "unknown",
            "claude-code",
            "pi",
            "omp",
            "OPENCODE",
            "opencode ",
        ] {
            assert_eq!(run_route(&config, harness).await, Kind::Broca, "{harness}");
            assert_eq!(config.dreamer_runner_for(harness).kind, Kind::Broca);
        }
    }

    #[tokio::test]
    async fn dreamer_route_precedence_does_not_redirect_historian() {
        for harness in HOST_RUNNER_HARNESSES.into_iter().chain(["", "unknown"]) {
            for historian in [None, Some(Kind::Host), Some(Kind::Broca)] {
                for dreamer in [Some(Kind::Host), Some(Kind::Broca)] {
                    let config = McModuleConfig {
                        historian_runner: historian,
                        dreamer_runner: dreamer,
                        ..Default::default()
                    };
                    assert_eq!(run_route(&config, harness).await, dreamer.unwrap());
                    let historian_only = McModuleConfig {
                        dreamer_runner: None,
                        ..config.clone()
                    };
                    assert_eq!(
                        config.historian_runner_for(harness),
                        historian_only.historian_runner_for(harness)
                    );
                }
            }
            for kind in [Kind::Host, Kind::Broca] {
                let config = McModuleConfig {
                    historian_runner: Some(kind),
                    ..Default::default()
                };
                assert_eq!(run_route(&config, harness).await, kind);
            }
        }
    }

    #[tokio::test]
    async fn roles_keep_locked_tools_and_ignore_historian_temperature() {
        let roles = [
            (DreamRole::Classifier, "dreamer-classifier", vec![], 4),
            (DreamRole::Reviewer, "dreamer-reviewer", vec![], 4),
            (DreamRole::Curate, "dreamer", vec!["ctx_memory"], 150),
            (
                DreamRole::Retrospective,
                "dreamer-retrospective",
                vec!["ctx_search"],
                40,
            ),
            (
                DreamRole::Docs,
                "dreamer-docs",
                vec![
                    "read",
                    "grep",
                    "glob",
                    "aft_outline",
                    "aft_zoom",
                    "aft_search",
                ],
                60,
            ),
            (
                DreamRole::MemoryMapper,
                "dreamer-memory-mapper",
                vec![
                    "read",
                    "grep",
                    "glob",
                    "aft_outline",
                    "aft_zoom",
                    "aft_search",
                ],
                60,
            ),
            (
                DreamRole::PrimerInvestigator,
                "dreamer-primer-investigator",
                vec![
                    "read",
                    "grep",
                    "glob",
                    "aft_outline",
                    "aft_zoom",
                    "aft_search",
                    "ctx_search",
                ],
                40,
            ),
        ];
        for temperature in [None, Some(0.0), Some(0.9)] {
            let config = McModuleConfig {
                historian_temperature: temperature,
                ..Default::default()
            };
            for (role, agent, tools, steps) in &roles {
                let mut carrier = FakeCarrier::default();
                let mut req = request();
                req.role = *role;
                let report =
                    run_dream_task(true, &config, &self::config(), &req, &mut carrier, |c| {
                        Ok(c.text.clone())
                    })
                    .await;
                assert!(report.result.is_ok());
                let sent = &carrier.opened[0];
                assert_eq!(sent.agent, *agent);
                assert_eq!(sent.allowed_tools, tools.as_slice());
                assert_eq!(sent.max_steps, *steps);
                assert_eq!(sent.temperature, None);
                assert_eq!(sent.directory, Path::new("/fixture/project"));
                assert_eq!(sent.parent_session_id, "parent");
                assert_eq!(sent.system, "system");
                assert_eq!(sent.prompt, "prompt");
                assert_eq!(sent.token_budget, Some(100));
                assert_eq!(carrier.closed, vec![("child-1".into(), true)]);
            }
        }
    }

    #[tokio::test]
    async fn invalid_answers_use_fresh_children_and_record_all_usage() {
        let completion = |text: &str, capped, input| {
            Ok(Completion {
                text: text.into(),
                length_capped: capped,
                usage: Usage {
                    input,
                    output: 5,
                    ..Default::default()
                },
            })
        };
        let mut carrier = FakeCarrier {
            responses: VecDeque::from([
                completion("truncated", true, 10),
                completion("bad", false, 20),
                completion("valid", false, 30),
            ]),
            ..Default::default()
        };
        let mut parsed = Vec::new();
        let report = run_dream_task(
            true,
            &McModuleConfig::default(),
            &config(),
            &request(),
            &mut carrier,
            |c| {
                parsed.push(c.text.clone());
                if c.text == "valid" {
                    Ok(c.text.clone())
                } else {
                    Err("bad manifest".into())
                }
            },
        )
        .await;
        assert_eq!(report.result, Ok("valid".into()));
        assert_eq!(parsed, ["bad", "valid"]);
        assert_eq!(
            report.attempts.iter().map(|a| a.usage.input).sum::<u64>(),
            60
        );
        assert_eq!(report.attempts[0].failure, Some(Failure::LengthCapped));
        assert_eq!(
            report.attempts[1].failure,
            Some(Failure::Validation("bad manifest".into()))
        );
        assert_eq!(
            carrier.closed,
            vec![
                ("child-1".into(), false),
                ("child-2".into(), false),
                ("child-3".into(), true)
            ]
        );
        assert_eq!(
            carrier
                .opened
                .iter()
                .map(|r| r.model.as_ref().unwrap().qualifier.as_deref())
                .collect::<Vec<_>>(),
            [Some("high"), None, Some("low")]
        );
        assert_eq!(
            carrier
                .opened
                .iter()
                .map(|r| r.model.as_ref().unwrap().model.as_str())
                .collect::<Vec<_>>(),
            ["task/model", "alternate/model", "alternate/model"]
        );
    }

    #[tokio::test]
    async fn terminal_transport_failure_does_not_fallback_and_closes() {
        let mut carrier = FakeCarrier {
            responses: VecDeque::from([Err(CarrierError {
                message: "ownership lost".into(),
                retryable: false,
            })]),
            ..Default::default()
        };
        let report = run_dream_task(
            true,
            &McModuleConfig::default(),
            &config(),
            &request(),
            &mut carrier,
            |_| Ok(()),
        )
        .await;
        assert_eq!(
            report.result,
            Err(Failure::Transport("ownership lost".into()))
        );
        assert_eq!(carrier.opened.len(), 1);
        assert_eq!(carrier.closed, vec![("child-1".into(), false)]);
    }

    #[tokio::test]
    async fn timeouts_abort_child_without_starting_fallback() {
        let mut carrier = FakeCarrier {
            park: true,
            ..Default::default()
        };
        let mut req = request();
        req.timeout = Duration::from_millis(5);
        let report = run_dream_task(
            true,
            &McModuleConfig::default(),
            &config(),
            &req,
            &mut carrier,
            |_| Ok(()),
        )
        .await;
        assert_eq!(report.result, Err(Failure::Timeout));
        assert_eq!(carrier.opened.len(), 1);
        assert_eq!(carrier.closed, vec![("child-1".into(), false)]);
    }

    #[tokio::test]
    async fn cleanup_failure_stops_fallback() {
        let mut carrier = FakeCarrier {
            fail_close: true,
            responses: VecDeque::from([Ok(Completion::default())]),
            ..Default::default()
        };
        let report = run_dream_task(
            true,
            &McModuleConfig::default(),
            &config(),
            &request(),
            &mut carrier,
            |_| Ok(()),
        )
        .await;
        assert_eq!(report.result, Err(Failure::Cleanup("lost route".into())));
        assert_eq!(report.attempts[0].failure, Some(Failure::Empty));
        assert_eq!(
            report.attempts[0].cleanup_failure.as_deref(),
            Some("lost route")
        );
        assert_eq!(carrier.opened.len(), 1);
    }

    #[tokio::test]
    async fn inactive_and_invalid_requests_open_no_children() {
        let mut carrier = FakeCarrier::default();
        let report = run_dream_task(
            false,
            &McModuleConfig::default(),
            &config(),
            &request(),
            &mut carrier,
            |_| Ok(()),
        )
        .await;
        assert_eq!(report.result, Err(Failure::Inactive));
        let mut req = request();
        req.parent_session_id = "";
        let report = run_dream_task(
            true,
            &McModuleConfig::default(),
            &config(),
            &req,
            &mut carrier,
            |_| Ok(()),
        )
        .await;
        assert_eq!(report.result, Err(Failure::InvalidRequest));
        assert!(carrier.opened.is_empty());
        assert!(carrier.closed.is_empty());
    }

    #[tokio::test]
    async fn empty_curate_completion_requires_caller_validation() {
        let mut carrier = FakeCarrier {
            responses: VecDeque::from([Ok(Completion::default())]),
            ..Default::default()
        };
        let mut req = request();
        req.role = DreamRole::Curate;
        req.allow_empty = true;
        let report = run_dream_task(
            true,
            &McModuleConfig::default(),
            &config(),
            &req,
            &mut carrier,
            |c| {
                assert!(c.text.is_empty());
                Ok("completed tool actions")
            },
        )
        .await;
        assert_eq!(report.result, Ok("completed tool actions"));
        assert_eq!(carrier.closed, vec![("child-1".into(), true)]);
    }

    #[tokio::test]
    async fn missing_primary_uses_session_default_without_inventing_models() {
        let mut carrier = FakeCarrier::default();
        let report = run_dream_task(
            true,
            &McModuleConfig::default(),
            &json!({}),
            &request(),
            &mut carrier,
            |_| Ok(()),
        )
        .await;
        assert_eq!(report.result, Ok(()));
        assert_eq!(carrier.opened.len(), 1);
        assert_eq!(carrier.opened[0].model, None);
    }
}
