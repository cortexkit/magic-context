//! Workspace engine adapters and provider discovery. The runner owns transcript tags.
use super::*;
use cortexkit_role_compaction_provider as compact;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

mod async_bus;
#[cfg(test)]
mod async_contract_vectors;
mod async_provider;
mod step_transform;
pub(crate) use async_provider::offline_first_pass as offline_first_pass_engine;
pub(crate) use async_provider::reminder_echoes::accounting as runner_accounting;
pub(crate) use async_provider::reminder_echoes::origin as runner_origin;
#[cfg(test)]
pub(crate) use async_provider::serve_descriptors;
pub(crate) use step_transform::declare as step_transform_declare;
#[cfg(test)]
mod describe_fixture_tests;

pub mod codec;
pub mod codec_anthropic;
#[cfg(test)]
mod codec_broca_media_tests;
#[cfg(test)]
mod codec_native_tests;
pub mod codec_opencode;
pub mod codec_pi;
pub mod compaction;
pub mod fold_prefix;
pub mod fold_working;
pub mod historian;
pub(crate) mod historian_config;
pub(crate) use historian_config::HistorianModelCatalog;
pub mod historian_budget;
pub mod hygiene_memo;
pub mod policy_summary;
pub mod records;
mod reduce;
pub mod resident_bytes;
pub(crate) mod runner_todo;
#[cfg(test)]
pub(crate) mod session_runner_fake;
pub(crate) mod usage_policy;
pub mod view_recipe;

pub(crate) use historian::RunCompletion;
pub use records::{Catalog, Key, Storage};

/// Active and queued callers retain their lock; only idle entries can be evicted.
/// A rebuild in one conversation must never queue a hook in another conversation.
#[derive(Default)]
pub struct ProviderSerial {
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl ProviderSerial {
    fn lock_arc(&self, key: &Key) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self.locks.lock().expect("provider lock map");
        if locks.len() >= 1024 {
            locks.retain(|_, lock| Arc::strong_count(lock) > 1);
        }
        Arc::clone(
            locks
                .entry(key.store_key().conversation_key())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
        )
    }
    pub async fn lock_for(&self, key: &Key) -> tokio::sync::OwnedMutexGuard<()> {
        self.lock_arc(key).lock_owned().await
    }
    pub fn try_lock_for(
        &self,
        key: &Key,
    ) -> Result<tokio::sync::OwnedMutexGuard<()>, tokio::sync::TryLockError> {
        self.lock_arc(key).try_lock_owned()
    }
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
pub fn runner_groups() -> [&'static str; 1] {
    ["transcript_reads"]
}

pub fn describe() -> HandlerOutcome {
    let mut answer: Value = match tool_catalog::role_describe_bytes() {
        Ok(bytes) => serde_json::from_slice(&bytes).expect("compiled role description"),
        Err(error) => return error.into_outcome(),
    };
    answer["majors"]
        .as_array_mut()
        .expect("role majors")
        .push(serde_json::to_value(step_transform::describe_major()).expect("step role major"));
    answer["majors"]
        .as_array_mut()
        .expect("role majors")
        .push(json!({
            "version": compact::PROVIDES,
            "ops": ["role.describe", "compaction.setup", "view.get", "compaction.ride"],
            "stability": "alpha"
        }));
    answer["runner_groups"] = json!(runner_groups());
    answer["setup_descends_from"] = json!(true);
    answer["reminder_templates"] = crate::runner_reminders::catalog();
    // ck-mc extension: the `params.serializer_profile` values Setup accepts,
    // in the codec registry's fixed order.
    answer["serializer_profiles"] = json!(codec::Codec::ALL.map(codec::Codec::wire_id));
    HandlerOutcome::Response(serde_jcs::to_vec(&answer).expect("build-only role JSON"))
}

fn invalid_field(field: &str, message: impl ToString) -> HandlerOutcome {
    HandlerOutcome::ErrorWithDetail {
        code: "invalid_params".into(),
        message: message.to_string(),
        detail: json!({"field":field}),
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
            Err(_) => return error("route_unbound", "compaction requires a bound runner route"),
        };
        if !matches!(
            binding.principal.as_ref(),
            Some(subc_protocol::Principal::Reserved { module_id })
                if crate::route_targets::SESSION_RUNNER_MODULE_IDS
                    .contains(&module_id.as_str())
        ) {
            return error(
                "route_unbound",
                "compaction requires an attested session runner",
            );
        }
        if let Some(session) = params.get("session").and_then(Value::as_str) {
            if let Some(refusal) = self.provider_store.catalog_refusal(&binding, session) {
                return refusal;
            }
        }
        let result = match method {
            "compaction.setup" => self.async_setup(channel, &binding, params).await,
            "view.get" => self.async_view_get(&binding, params).await,
            "compaction.ride" => self.async_ride(&binding, params).await,
            _ => Err(invalid("unknown compaction operation")),
        };
        match result {
            Ok(bytes) => HandlerOutcome::Response(bytes),
            Err(error) => error,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovery_restores_pre_user_without_native_capabilities() {
        let HandlerOutcome::Response(bytes) = describe() else {
            panic!("role discovery failed")
        };
        let answer: Value = serde_json::from_slice(&bytes).unwrap();
        let majors = answer["majors"].as_array().unwrap();
        // The role is restored for pre_user time markers and auto memory.
        assert!(majors
            .iter()
            .any(|major| major["version"] == "step-transform-provider/v1"));
        let compaction = majors
            .iter()
            .find(|major| major["version"] == compact::PROVIDES)
            .unwrap();
        assert!(!compaction["ops"]
            .as_array()
            .unwrap()
            .iter()
            .any(|op| op == "compaction.step" || op == "compaction.view.read"));
        assert!(answer.get("claude_code").is_none());
    }

    #[test]
    fn discovery_lists_every_accepted_serializer_profile_in_fixed_order() {
        let HandlerOutcome::Response(bytes) = describe() else {
            panic!("role discovery failed")
        };
        let answer: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            answer["serializer_profiles"],
            json!(["owned-broca", "opencode-aisdk", "pi", "anthropic-messages"])
        );
        for profile in answer["serializer_profiles"].as_array().unwrap() {
            assert!(
                codec::Codec::from_params(&json!({"serializer_profile": profile})).is_ok(),
                "{profile} is advertised but refused"
            );
        }
    }

    #[tokio::test]
    async fn retired_compaction_methods_are_unrecognized() {
        let handler = McHandler::new();
        for method in [
            "compaction.step",
            "compaction.delete",
            "compaction.view.read",
            // The step-transform role is restored for pre_user time markers and auto memory.
        ] {
            let answer = handler
                .dispatch_value(1, json!({"method":method,"params":{}}))
                .await;
            assert!(
                matches!(answer, HandlerOutcome::Error { ref code, .. } if code == "unrecognized_request_shape"),
                "{method}: {answer:?}"
            );
        }
    }
}
