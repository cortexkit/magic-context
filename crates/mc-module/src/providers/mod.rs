//! Provider discovery and method routing; conversation state is owned by mc-store.
use super::*;
use cortexkit_role_compaction_provider as compact;
use cortexkit_role_step_transform_provider as hooks;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

mod codec;
mod compaction;
mod records;
mod step_transform;
#[cfg(test)]
mod tests;

use codec::{checked_view, decode_message};
#[cfg(test)]
use codec::{encode_message, validate_replacement};
use records::{frontier, ingest, scan, HookRecord, HookState, Key, Record, Setup};
pub(crate) use records::{Catalog, Storage};
use step_transform::declaration;

pub const HOOK_BUDGET_MS: u64 = 1_500;

pub fn runner_groups() -> [&'static str; 1] {
    ["transcript_reads"]
}

pub fn describe() -> HandlerOutcome {
    let mut answer: Value = match tool_catalog::role_describe_bytes() {
        Ok(bytes) => serde_json::from_slice(&bytes).expect("compiled role description"),
        Err(error) => return error.into_outcome(),
    };
    let majors = answer["majors"].as_array_mut().expect("role majors");
    majors.push(
        json!({"version": compact::PROVIDES, "ops": compact::REQUIRED_OPS, "stability": "alpha"}),
    );
    majors.push(
        json!({"version": hooks::PROVIDES, "ops": hooks::REQUIRED_OPS, "stability": "alpha"}),
    );
    answer["runner_groups"] = json!(runner_groups());
    HandlerOutcome::Response(serde_jcs::to_vec(&answer).expect("build-only role JSON"))
}

pub fn error(code: &str, message: impl ToString) -> HandlerOutcome {
    HandlerOutcome::Error {
        code: code.into(),
        message: message.to_string(),
    }
}

pub fn invalid(message: impl ToString) -> HandlerOutcome {
    error("invalid_params", message)
}

pub fn transient(message: impl ToString) -> HandlerOutcome {
    error("transient", message)
}

pub fn decode<T: serde::de::DeserializeOwned>(params: &Value) -> Result<T, HandlerOutcome> {
    serde_json::from_value(params.clone()).map_err(invalid)
}

pub fn bytes<T: Serialize>(answer: &T) -> Result<Vec<u8>, HandlerOutcome> {
    serde_json::to_vec(answer).map_err(transient)
}
pub fn preset(name: Option<&str>) -> Result<transform::compaction::Preset, HandlerOutcome> {
    match name.unwrap_or("head") {
        "head" | "primary" => Ok(transform::compaction::Preset::Head),
        "worker" | "subagent" => Ok(transform::compaction::Preset::Worker),
        "reader" => Ok(transform::compaction::Preset::Reader),
        _ => Err(invalid("unknown provider preset")),
    }
}
pub const FAULT_POINTS: &[&str] = &[
    "SetupRecorded",
    "MessagesIngested",
    "AnswerRecorded",
    "WaitAnswered",
    "WaitWorkDurable",
    "HookStateRecorded",
];

pub fn fault(point: &str) {
    debug_assert!(FAULT_POINTS.contains(&point));
    #[cfg(feature = "drive-fault")]
    if std::env::var("MC_PROVIDER_FAULT_POINT").ok().as_deref() == Some(point) {
        // The harness sees this line, then sends a real process kill. A
        // fault-enabled binary alone can park at a durable provider cut.
        eprintln!("MC_PROVIDER_FAULT_REACHED {point}");
        loop {
            std::thread::park();
        }
    }
}

impl McHandler {
    pub(crate) async fn handle_provider_value(
        &self,
        channel: u16,
        method: &str,
        params: &Value,
    ) -> HandlerOutcome {
        let binding = match self.facade_binding(channel) {
            Ok(binding) => binding,
            Err(_) => {
                return error(
                    "route_unbound",
                    format!("{method} requires a bound project route"),
                )
            }
        };
        if method == "transform.declare" {
            return match declaration(params).and_then(|d| bytes(&d)) {
                Ok(bytes) => HandlerOutcome::Response(bytes),
                Err(e) => e,
            };
        }
        let result = match method {
            "compaction.setup" => self.provider_setup(binding, params).await,
            "compaction.step" => self.provider_step(binding, params).await,
            "transform.hook" => self.provider_hook(binding, params).await,
            _ => Err(invalid("unknown provider method")),
        };
        match result {
            Ok(bytes) => HandlerOutcome::Response(bytes),
            Err(error) => error,
        }
    }
}
