//! Run-limit discovery shared by background prompt fitting and historian sends.

use crate::historian::HistorianModelLimits;
use crate::historian_producer::{HistorianProducerError, ProducerErrorBody};
use cortexkit_role_llm_runner::capabilities as caps;
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RunnerLimits {
    pub max_steps: bool,
    pub max_output_tokens: bool,
    pub no_tools: bool,
}

impl RunnerLimits {
    /// The run-limit groups `answer` declares. `answer` is the `role.describe`
    /// answer inside the runner's reply envelope: the envelope is read, strictly,
    /// by `session_resolver::read_runner_reply` before this.
    pub(crate) fn from_describe(answer: &Value) -> Self {
        let declares = |name| {
            answer["capabilities"]
                .as_array()
                .is_some_and(|groups| groups.iter().any(|group| group.as_str() == Some(name)))
        };
        Self {
            max_steps: declares(caps::MAX_STEPS),
            max_output_tokens: declares(caps::MAX_OUTPUT_TOKENS),
            no_tools: declares(caps::NO_TOOLS),
        }
    }

    pub(crate) fn require_historian(self) -> Result<(), HistorianProducerError> {
        let missing: Vec<_> = [
            (caps::NO_TOOLS, self.no_tools),
            (caps::MAX_STEPS, self.max_steps),
        ]
        .into_iter()
        .filter_map(|(name, declared)| (!declared).then_some(name))
        .collect();
        if missing.is_empty() {
            Ok(())
        } else {
            Err(refusal(format!(
                "historian_runner_missing_groups: {}",
                missing.join(",")
            )))
        }
    }

    pub(crate) fn historian_chain(
        self,
        session: &str,
        chain: &mut Vec<String>,
    ) -> Result<(), HistorianProducerError> {
        self.require_historian()?;
        let skipped: Vec<_> = chain
            .iter()
            .filter(|model| is_zen_model(model))
            .cloned()
            .collect();
        chain.retain(|model| !is_zen_model(model));
        if !skipped.is_empty() {
            static WARNED: std::sync::OnceLock<
                std::sync::Mutex<std::collections::HashSet<String>>,
            > = std::sync::OnceLock::new();
            if WARNED
                .get_or_init(Default::default)
                .lock()
                .expect("Zen skip log")
                .insert(session.to_string())
            {
                tracing::warn!(session, models = ?skipped, "historian_zen_no_tools: skipping OpenCode Zen models because no tools can be offered");
            }
        }
        if chain.is_empty() {
            Err(refusal(
                "historian_zen_no_eligible_models: the entire model chain requires an offered tool"
                    .into(),
            ))
        } else {
            Ok(())
        }
    }

    /// Tighten the existing model-limit input path rather than changing the legacy
    /// capped estimator. Without a runner-enforced output cap, the model can use
    /// its entire catalog maximum, even when that exceeds a quarter of the window.
    /// Missing catalog maxima use the configured output cap or 32,000-token
    /// default as an estimate, not an enforceable bound. Missing context uses
    /// the configured window or the historian's 128,000-token default.
    pub(crate) fn fit_limits(
        self,
        chain: &[String],
        limits: &mut BTreeMap<String, HistorianModelLimits>,
        legacy_window: Option<usize>,
        fallback_output_tokens: u32,
    ) -> Result<(), HistorianProducerError> {
        if self.max_output_tokens {
            return Ok(());
        }
        for model in chain {
            let entry = limits.entry(model.clone()).or_default();
            let output = entry
                .output
                .filter(|output| *output > 0)
                .unwrap_or_else(|| {
                    static WARNED: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> = std::sync::OnceLock::new();
                    if WARNED.get_or_init(Default::default).lock().expect("output reserve log").insert(model.clone()) {
                        tracing::warn!(model, reserve = fallback_output_tokens, "historian_model_output_limit_unknown: reserving the configured output cap or default 32000 tokens; the runner cannot enforce it");
                    }
                    fallback_output_tokens
                });
            let window = entry
                .context
                .or(legacy_window)
                .unwrap_or(crate::config::DEFAULT_HISTORIAN_CONTEXT_LIMIT_TOKENS);
            let window = if entry.input.is_some() {
                window
            } else {
                legacy_window.map_or(window, |cap| window.min(cap))
            };
            let input = window.saturating_sub(output as usize);
            let input = entry.input.map_or(input, |cap| cap.min(input));
            if input == 0 {
                return Err(refusal(format!(
                    "historian_model_output_fills_window: {model}"
                )));
            }
            entry.input = Some(input);
        }
        Ok(())
    }
}

pub(crate) fn refusal(reason: String) -> HistorianProducerError {
    HistorianProducerError::Subc(ProducerErrorBody::untagged("background_run_limits", reason))
}

/// Deliberately conservative: the TypeScript hidden-run executor offers a `read`
/// tool to every OpenCode Zen model, then refuses any call to it. Zen's free tier
/// rejects requests offering no tools. Paid Zen models are skipped too, matching
/// `shared/hidden-zen-read.ts::needsBlockedRead`, because a no-tools historian
/// cannot offer that compatibility tool.
pub(crate) fn is_zen_model(model: &str) -> bool {
    model
        .split_once('/')
        .is_some_and(|(provider, _)| provider == "opencode")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zen_skip_uses_the_standalone_provider_gate_and_refuses_an_all_zen_chain() {
        let fixture: Value =
            serde_json::from_str(include_str!("../testdata/historian-zen-models.json")).unwrap();
        let limits = RunnerLimits {
            max_steps: true,
            max_output_tokens: true,
            no_tools: true,
        };
        for case in fixture.as_array().unwrap() {
            let model = case["model"].as_str().unwrap();
            assert_eq!(
                is_zen_model(model),
                case["blockedRead"].as_bool().unwrap(),
                "{model}"
            );
            let mut chain = vec![model.into(), "other/model".into()];
            limits.historian_chain("zen-fixture", &mut chain).unwrap();
            assert_eq!(
                chain.contains(&model.to_string()),
                !case["blockedRead"].as_bool().unwrap()
            );
        }
        let error = limits
            .historian_chain(
                "all-zen",
                &mut vec!["opencode/free".into(), "opencode/paid".into()],
            )
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("historian_zen_no_eligible_models"));
    }

    /// The groups are read from the answer only. A reply envelope is removed,
    /// strictly, before this (a bare reply never gets here: see
    /// `historian_producer`'s `a_bare_role_describe_reply_is_refused_by_name_before_any_send`),
    /// so an envelope that reaches this reader is not peeled.
    #[test]
    fn limits_are_read_from_the_answer_and_an_envelope_is_not_peeled() {
        let answer =
            serde_json::json!({"capabilities":["max_steps","max_output_tokens","no_tools"]});
        assert_eq!(
            RunnerLimits::from_describe(&answer),
            RunnerLimits {
                max_steps: true,
                max_output_tokens: true,
                no_tools: true,
            }
        );
        assert_eq!(
            RunnerLimits::from_describe(&serde_json::json!({ "result": answer })),
            RunnerLimits::default()
        );
    }

    #[test]
    fn uncapped_fit_uses_configured_or_default_reserve_for_unknown_maximum() {
        let limits = RunnerLimits {
            max_steps: true,
            no_tools: true,
            max_output_tokens: false,
        };
        for fallback in [32_000, 6_000] {
            let mut models = BTreeMap::from([(
                "p/m".into(),
                HistorianModelLimits {
                    context: Some(200_000),
                    input: None,
                    output: None,
                },
            )]);
            limits
                .fit_limits(&["p/m".into()], &mut models, None, fallback)
                .unwrap();
            assert_eq!(models["p/m"].input, Some(200_000 - fallback as usize));
            let mut unknown_context = BTreeMap::new();
            limits
                .fit_limits(
                    &["p/m".into()],
                    &mut unknown_context,
                    Some(200_000),
                    fallback,
                )
                .unwrap();
            assert_eq!(
                unknown_context["p/m"].input,
                Some(200_000 - fallback as usize)
            );
        }
        for (output, input) in [(Some(200), None), (Some(50), Some(0))] {
            let mut models = BTreeMap::from([(
                "p/m".into(),
                HistorianModelLimits {
                    context: Some(100),
                    input,
                    output,
                },
            )]);
            let error = limits
                .fit_limits(&["p/m".into()], &mut models, None, 32_000)
                .unwrap_err();
            assert!(error.to_string().contains("output_fills_window"), "{error}");
        }
        let mut unknown = BTreeMap::new();
        limits
            .fit_limits(&["p/m".into()], &mut unknown, None, 32_000)
            .unwrap();
        assert_eq!(unknown["p/m"].input, Some(96_000));
    }
}
