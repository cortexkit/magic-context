//! Session-frozen prompt-cache policy shared by Setup, rides and published views.
use super::*;
use crate::config::{CacheTtlProvenance, McModuleConfig};
use compact::cache_ttl::CacheTtl;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub(super) struct CachePolicy {
    default: String,
    models: BTreeMap<String, String>,
}

impl CachePolicy {
    pub(super) fn freeze(config: &McModuleConfig) -> Self {
        Self {
            default: config.cache_ttl.clone(),
            models: config.cache_ttl_by_model.clone(),
        }
    }

    pub(super) fn resolve(&self, model: &str) -> CacheTtl {
        let config = McModuleConfig {
            cache_ttl: self.default.clone(),
            cache_ttl_by_model: self.models.clone(),
            ..McModuleConfig::default()
        };
        let resolved = config.resolve_cache_ttl_with_provenance(Some(model));
        let configured = resolved.provenance != CacheTtlProvenance::Default;
        let ms = if configured {
            crate::scheduler::parse_cache_ttl(&resolved.value)
                .ok()
                .filter(|ms| *ms != u64::MAX)
        } else {
            let id = model.rsplit('/').next().unwrap_or(model);
            let long = id.starts_with("gpt-6")
                || id
                    .strip_prefix("gpt-5.")
                    .and_then(|v| v.split('-').next())
                    .and_then(|v| v.parse::<u64>().ok())
                    .is_some_and(|minor| minor >= 6);
            Some(if long { 1_800_000 } else { 300_000 })
        };
        CacheTtl::new(model, ms, configured)
    }
}

impl AsyncRecord {
    pub(super) fn cache_ttl(&self) -> CacheTtl {
        let model = self
            .conditions
            .as_ref()
            .and_then(|h| h.get("model"))
            .map(String::as_str)
            .unwrap_or(&self.setup.model);
        self.cache_policy.resolve(model)
    }
}
