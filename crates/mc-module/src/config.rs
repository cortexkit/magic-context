//! Thin mc-module JSONC config reader for autonomous historian firing.
//!
//! This intentionally reads user and project tiers directly instead of depending on a
//! daemon config plane. Per-leaf trust policy is enforced during the read: model choice
//! is user-tier only because it affects spend; project config may only raise the execute
//! threshold (fire less often), and may override trusted memory, auto-search, caveman, promotion,
//! and privacy settings. User-profile, historian budgets, and output language remain user-tier
//! only. The Rust module intentionally keeps stricter model-selection policy than the current
//! TypeScript implementation until both implementations are deliberately aligned.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde_json::Value;

use crate::historian_runner::{resolve_runner, HistorianRunnerKind, ResolvedRunner};
use crate::scheduler::{self, ExecuteThresholdConfig};

/// Default execute threshold percentage (65.0). The Rust module reads config without the
/// plugin, so this must stay identical to packages/plugin/src/config/schema/magic-context.ts.
pub const DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE: f64 = 65.0;
/// Default token budget for project-memory injection. This is the twin of
/// `packages/plugin/src/config/schema/magic-context.ts` and must stay at 4,000 tokens.
pub const DEFAULT_MEMORY_BUDGET_TOKENS: f64 = 4_000.0;
/// Default token budget for user-profile injection. It must remain 4,000 tokens so the Rust
/// module and the TypeScript renderer use the same default.
pub const DEFAULT_USER_PROFILE_BUDGET_TOKENS: f64 = 4_000.0;
/// Minimum historian producer chunk size. The derived budget is one quarter of the model
/// context limit, but it is never allowed to fall below 8,000 tokens.
pub const MIN_HISTORIAN_CHUNK_TOKENS: usize = 8_000;
/// Maximum historian producer chunk size. The derived budget is one quarter of the model
/// context limit, but it is never allowed to exceed 50,000 tokens.
pub const MAX_HISTORIAN_CHUNK_TOKENS: usize = 50_000;
/// Matches the TypeScript historian fallback when no model catalog value is available.
/// The explicit config override still wins when a binding supplies one.
pub const DEFAULT_HISTORIAN_CONTEXT_LIMIT_TOKENS: usize = 128_000;
/// Defaults shared with the TypeScript `memory.auto_search` schema.
pub const DEFAULT_AUTO_SEARCH_SCORE_THRESHOLD: f64 = 0.6;
pub const DEFAULT_AUTO_SEARCH_MIN_PROMPT_CHARS: usize = 20;
/// Defaults shared with the TypeScript `caveman_text_compression` schema.
pub const DEFAULT_CAVEMAN_MIN_SIZE: usize = 500;

/// Derive the historian producer budget from its own context window, as the TS runner does.
pub fn derive_historian_chunk_tokens(context_limit_tokens: usize) -> usize {
    (((context_limit_tokens as f64) * 0.25).round() as usize)
        .clamp(MIN_HISTORIAN_CHUNK_TOKENS, MAX_HISTORIAN_CHUNK_TOKENS)
}

#[derive(Debug, Clone, PartialEq)]
pub struct AutoSearchConfig {
    pub enabled: bool,
    pub score_threshold: f64,
    pub min_prompt_chars: usize,
}

impl Default for AutoSearchConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            score_threshold: DEFAULT_AUTO_SEARCH_SCORE_THRESHOLD,
            min_prompt_chars: DEFAULT_AUTO_SEARCH_MIN_PROMPT_CHARS,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CavemanConfig {
    pub enabled: bool,
    pub min_size: usize,
}

impl Default for CavemanConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            min_size: DEFAULT_CAVEMAN_MIN_SIZE,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct McModuleConfig {
    /// Historian-only previews, with project entries overriding user entries.
    pub historian_expand_tools: crate::historian_tool_template::ExpansionMap,
    // No model chain lives here. The host resolves the historian's and each dreamer
    // task's model chain from its own config and sends it with every request; the
    // module refuses a request that carries none rather than guessing from disk.
    /// Optional trusted user-configured sampling temperature for historian requests.
    pub historian_temperature: Option<f64>,
    /// Which side runs the historian's completion, when the user tier names one.
    /// USER-tier only, for the same reason the model is: it decides whose provider
    /// account and whose process pays for the call, so a cloned repository must not
    /// be able to redirect it. `None` means the harness that sent the request decides
    /// (see [`McModuleConfig::historian_runner_for`]).
    pub historian_runner: Option<HistorianRunnerKind>,
    /// Which side runs the module-routed dreamer completions (classify), when the
    /// user tier names one. USER-tier only, like `historian_runner`. `None` falls
    /// back to `historian_runner`, so an install that already set only the
    /// historian runner keeps its dreamer completions where they were.
    pub dreamer_runner: Option<HistorianRunnerKind>,
    /// Trusted user-configured language for hidden-agent prose. Project config is deliberately
    /// excluded because the language directive becomes provider-visible prompt text.
    pub language: Option<String>,
    pub execute_threshold_percentage: f64,
    /// Retain per-model threshold values until the request supplies its canonical model key.
    pub execute_threshold_user_config: Option<ExecuteThresholdConfig>,
    pub execute_threshold_user_configured: bool,
    /// Project overrides are a per-model floor, never permission to lower the user threshold.
    pub execute_threshold_project_config: Option<ExecuteThresholdConfig>,
    /// User and project protected-token overrides remain separate until usable geometry is known.
    pub protected_tokens_user: Option<u64>,
    pub protected_tokens_project: Option<u64>,
    /// Fixed-default reasoning retention, scalar or cache_ttl-style model map.
    pub keep_reasoning_tokens: Option<Value>,
    /// Whether compaction is enabled, as resolved during host startup. This determines which
    /// component controls context-window compaction for the request.
    pub compaction_enabled: bool,
    pub memory_enabled: bool,
    /// Independent transform-time hint controls from `memory.auto_search`.
    pub auto_search: AutoSearchConfig,
    /// Deterministic age-tier compression controls from `caveman_text_compression`.
    pub caveman: CavemanConfig,
    /// Mirrors the TS auto-promote switch. Facts are dropped when this is false.
    pub auto_promote: bool,
    /// Privacy gate controlling whether historian user observations may be collected for later
    /// review and promotion.
    pub user_memory_collection_enabled: bool,
    /// Historian model context limit; configurable until the module has a model catalog.
    pub historian_context_limit_tokens: usize,
    /// True only when the user supplied a known historian model window.
    pub historian_context_limit_known: bool,
    pub memory_budget_tokens: f64,
    pub user_profile_budget_tokens: f64,
    /// Controls whether the frozen m0 baseline includes the canonical project-docs block.
    pub inject_docs: bool,
    /// Controls temporal gap overlays when the active wire surface supports overlays.
    pub temporal_awareness: bool,
    /// Trusted USER-tier guidance bytes resolved from the user config directory at route bind.
    /// Only the immutable contents are retained; transform and guidance requests never carry a
    /// filesystem path.
    pub prompt_surface_guidance_override: Option<String>,
    pub smart_drops: bool,
    pub protected_tools: std::collections::BTreeMap<String, usize>,
    pub cache_ttl: String,
    /// Configured cache lifetimes (including an explicit `default`). Try the exact model key first;
    /// then try provider-qualified and bare model names, removing the final dash suffix and
    /// retrying after each miss. Finally try `provider/*`, then the default.
    pub cache_ttl_by_model: std::collections::BTreeMap<String, String>,
    /// Settings only `tool.catalog` reads (`src/tool_catalog.rs`).
    pub catalog: CatalogConfigInputs,
}

/// The configuration `tool.catalog` reads that nothing else in the module does.
/// The plugin reads the same keys for its own prompt surface.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CatalogConfigInputs {
    /// `prompt_surface.default` (`full` or `light`); unset means full. The user
    /// or the project tier may set it: it selects among shipped texts and adds none.
    pub prompt_surface_default: Option<String>,
    /// `prompt_surface.models`: model key to `full` or `light`. The user or the
    /// project tier; a project entry replaces the user entry for the same key.
    pub prompt_surface_models: std::collections::BTreeMap<String, String>,
    /// `prompt_surface.tool_descriptions`: replacement tool descriptions.
    /// USER-tier only, because a cloned repository must not be able to write
    /// model-facing text.
    pub tool_descriptions: std::collections::BTreeMap<String, String>,
    /// Whether the dreamer can run: a `dreamer` block is configured in either
    /// tier and `dreamer.disable` is not true (the plugin's `isDreamerRunnable`).
    pub dreamer_runnable: bool,
}

impl Default for McModuleConfig {
    fn default() -> Self {
        Self {
            historian_temperature: None,
            historian_expand_tools: Default::default(),
            historian_runner: None,
            dreamer_runner: None,
            language: None,
            execute_threshold_percentage: DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE,
            execute_threshold_user_config: None,
            execute_threshold_user_configured: false,
            execute_threshold_project_config: None,
            protected_tokens_user: None,
            protected_tokens_project: None,
            keep_reasoning_tokens: None,
            compaction_enabled: true,
            memory_enabled: true,
            auto_search: AutoSearchConfig::default(),
            caveman: CavemanConfig::default(),
            auto_promote: true,
            user_memory_collection_enabled: false,
            historian_context_limit_tokens: DEFAULT_HISTORIAN_CONTEXT_LIMIT_TOKENS,
            historian_context_limit_known: false,
            memory_budget_tokens: DEFAULT_MEMORY_BUDGET_TOKENS,
            user_profile_budget_tokens: DEFAULT_USER_PROFILE_BUDGET_TOKENS,
            inject_docs: true,
            temporal_awareness: true,
            prompt_surface_guidance_override: None,
            smart_drops: false,
            protected_tools: crate::selection::default_protected_tools(),
            cache_ttl: "5m".to_string(),
            cache_ttl_by_model: std::collections::BTreeMap::new(),
            catalog: CatalogConfigInputs::default(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheTtlProvenance {
    Explicit,
    /// A user or project default sets when an idle session expires; it does not tell the
    /// provider to place a cache marker in a request.
    ConfiguredDefault,
    Default,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedCacheTtl {
    pub value: String,
    pub provenance: CacheTtlProvenance,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedExecuteThreshold {
    pub percentage: f64,
    pub provenance: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedProtectedTokens {
    pub floor: u64,
    pub provenance: &'static str,
    pub warning: Option<String>,
}

fn resolve_threshold_config(
    config: &ExecuteThresholdConfig,
    model_key: Option<&str>,
    configured: bool,
    fallback: f64,
) -> ResolvedExecuteThreshold {
    let provenance = match config {
        _ if !configured => "builtin",
        ExecuteThresholdConfig::Percentage(_) => "scalar",
        ExecuteThresholdConfig::ByModel(values) => {
            if model_key.is_some_and(|key| {
                scheduler::model_key_lookup_order(key)
                    .iter()
                    .any(|candidate| values.contains_key(candidate))
            }) {
                "object.model"
            } else if values.contains_key("default") {
                "object.default"
            } else {
                "builtin"
            }
        }
    };
    ResolvedExecuteThreshold {
        percentage: scheduler::resolve_execute_threshold(config, model_key, fallback, None, None),
        provenance,
    }
}

impl McModuleConfig {
    pub fn resolve_keep_reasoning_tokens(&self, model_key: Option<&str>) -> u64 {
        let Some(value) = &self.keep_reasoning_tokens else {
            return 10_000;
        };
        if let Some(tokens) = value.as_u64() {
            return tokens;
        }
        let Some(values) = value.as_object() else {
            return 10_000;
        };
        model_key
            .into_iter()
            .flat_map(crate::tool_catalog::model_key_candidates)
            .find_map(|candidate| values.get(&candidate).and_then(Value::as_u64))
            .or_else(|| values.get("default").and_then(Value::as_u64))
            .unwrap_or(10_000)
    }
    pub fn resolve_protected_tokens(&self, usable_soft: u64) -> ResolvedProtectedTokens {
        let derived = crate::protection_window::derive_default_floor(usable_soft);
        let (mut floor, mut provenance) = self
            .protected_tokens_user
            .map_or((derived, "derived"), |value| (value, "user"));
        let mut warning = None;
        if let Some(project) = self.protected_tokens_project {
            if project >= floor {
                floor = project;
                provenance = "project";
            } else {
                warning = Some(format!(
                    "ignoring project protected_tokens={project}; it cannot lower resolved user/default floor {floor}"
                ));
            }
        }
        ResolvedProtectedTokens {
            floor,
            provenance,
            warning,
        }
    }

    pub fn resolve_execute_threshold(&self, model_key: Option<&str>) -> ResolvedExecuteThreshold {
        let scalar = ExecuteThresholdConfig::Percentage(self.execute_threshold_percentage);
        let mut resolved = resolve_threshold_config(
            self.execute_threshold_user_config
                .as_ref()
                .unwrap_or(&scalar),
            model_key,
            self.execute_threshold_user_configured,
            DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE,
        );
        if let Some(project) = &self.execute_threshold_project_config {
            let floor = resolve_threshold_config(project, model_key, true, resolved.percentage);
            if floor.percentage > resolved.percentage {
                resolved = floor;
            }
        }
        resolved
    }

    /// Resolve the effective cache TTL while preserving whether the model walk matched an entry.
    ///
    /// The configured default remains the effective value for host-side scheduling, but it is not
    /// an instruction to place that value on a provider cache marker.
    pub fn resolve_cache_ttl_with_provenance(&self, model_key: Option<&str>) -> ResolvedCacheTtl {
        let explicit = |value: &String| ResolvedCacheTtl {
            value: value.clone(),
            provenance: CacheTtlProvenance::Explicit,
        };
        let default = || ResolvedCacheTtl {
            value: self.cache_ttl.clone(),
            provenance: if self.cache_ttl_by_model.contains_key("default") {
                CacheTtlProvenance::ConfiguredDefault
            } else {
                CacheTtlProvenance::Default
            },
        };

        // Check an exact key before splitting into provider and model parts, so a bare key cannot
        // silently fall back to the default TTL.
        if let Some(ttl) = model_key.and_then(|key| self.cache_ttl_by_model.get(key)) {
            return explicit(ttl);
        }
        let Some((provider, mut model_id)) = model_key.and_then(|key| key.split_once('/')) else {
            return default();
        };
        if provider.is_empty() || model_id.is_empty() {
            return default();
        }

        loop {
            let exact = format!("{provider}/{model_id}");
            if let Some(ttl) = self.cache_ttl_by_model.get(&exact) {
                return explicit(ttl);
            }
            if let Some(ttl) = self.cache_ttl_by_model.get(model_id) {
                return explicit(ttl);
            }

            let Some(last_dash) = model_id.rfind('-').filter(|index| *index > 0) else {
                break;
            };
            model_id = &model_id[..last_dash];
        }

        if let Some(ttl) = self.cache_ttl_by_model.get(&format!("{provider}/*")) {
            return explicit(ttl);
        }
        default()
    }

    /// Resolve only the effective value for existing host-side callers.
    pub fn resolve_cache_ttl(&self, model_key: Option<&str>) -> String {
        self.resolve_cache_ttl_with_provenance(model_key).value
    }
}

#[derive(Debug, Clone, Default)]
struct TierConfig {
    path: PathBuf,
    mtime: Option<SystemTime>,
    value: Option<Value>,
}

#[derive(Debug, Clone, Default)]
pub struct ConfigCache {
    user: TierConfig,
    project: TierConfig,
    effective: McModuleConfig,
}

impl ConfigCache {
    pub fn effective_for_project(&mut self, project_root: &Path) -> McModuleConfig {
        let user_path = user_config_path();
        self.effective_for_paths(&user_path, project_root)
    }

    pub fn effective_for_paths(&mut self, user_path: &Path, project_root: &Path) -> McModuleConfig {
        let project_path = detect_config_file(&project_root.join(".cortexkit"));
        let user = read_tier_cached(&mut self.user, user_path.to_path_buf());
        let project = read_tier_cached(&mut self.project, project_path);
        let (mut effective, mut warnings) =
            merge_tiers_with_warnings(user.as_ref(), project.as_ref());
        resolve_user_guidance_override(&mut effective, user.as_ref(), user_path, &mut warnings);
        emit_warnings(warnings);
        self.effective = effective;
        self.effective.clone()
    }
}

impl McModuleConfig {
    /// The runner the historian uses for a request from `harness`: the user-tier
    /// `historian.runner` when set, otherwise the harness default.
    pub fn historian_runner_for(&self, harness: &str) -> ResolvedRunner {
        resolve_runner(self.historian_runner, harness)
    }

    /// The runner module-routed dreamer completions use for a request from
    /// `harness`: `dreamer.runner`, then `historian.runner`, then the harness default.
    pub fn dreamer_runner_for(&self, harness: &str) -> ResolvedRunner {
        resolve_runner(self.dreamer_runner.or(self.historian_runner), harness)
    }

    /// The runners the user tier names, without any harness applied.
    pub fn configured_runners(&self) -> ConfiguredRunners {
        ConfiguredRunners {
            historian: self.historian_runner,
            dreamer: self.dreamer_runner.or(self.historian_runner),
        }
    }
}

/// The runners the user tier names for each role, with the dreamer's fallback to
/// the historian's value already applied. `None` means "decided per request by the
/// harness".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConfiguredRunners {
    pub historian: Option<HistorianRunnerKind>,
    pub dreamer: Option<HistorianRunnerKind>,
}

/// The runners the user tier names.
///
/// Both runner settings are read from the user tier only, so the answer is the same
/// for every project this process serves. That is what lets the boot manifest
/// declare its routes from it. The harness default is per request, and a Claude
/// Code request with nothing configured still goes to Broca, so the background-
/// completion route to Broca is declared unless BOTH roles are configured to the
/// host runner. The optional provider runner route is declared independently.
pub fn user_configured_runners() -> ConfiguredRunners {
    user_configured_runners_at(&user_config_path())
}

/// [`user_configured_runners`] against an explicit user config file.
pub fn user_configured_runners_at(user_path: &Path) -> ConfiguredRunners {
    let mut tier = TierConfig::default();
    let user = read_tier_cached(&mut tier, user_path.to_path_buf());
    let (config, warnings) = merge_tiers_with_warnings(user.as_ref(), None);
    emit_warnings(warnings);
    config.configured_runners()
}

fn user_config_path() -> PathBuf {
    user_config_path_from(std::env::var_os("XDG_CONFIG_HOME"), user_home_dir())
}

/// Read the user-only permission override shared with the plugin.
/// Project config cannot loosen filesystem permissions for the user's store.
pub fn private_storage_permissions_enabled() -> bool {
    fs::read_to_string(user_config_path())
        .ok()
        .and_then(|raw| parse_config_text(&raw).ok())
        .and_then(|config| config.get("storage").and_then(Value::as_object).cloned())
        .and_then(|storage| {
            storage
                .get("enforce_private_permissions")
                .and_then(Value::as_bool)
        })
        .unwrap_or(true)
}

/// The user config file, chosen the way the host chooses it (`configHome()` and
/// `detectConfigFile` in the plugin): `XDG_CONFIG_HOME` counts only when it is an absolute
/// path, otherwise `<home>/.config`; in that directory `magic-context.jsonc` wins and
/// `magic-context.json` is read when only it exists. A relative or empty `XDG_CONFIG_HOME`
/// would otherwise resolve against whatever directory the module happened to start in,
/// and the module would read a different file than the host it serves.
fn user_config_path_from(
    xdg_config_home: Option<std::ffi::OsString>,
    home: Option<PathBuf>,
) -> PathBuf {
    let config_home = xdg_config_home
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| home.unwrap_or_else(|| PathBuf::from(".")).join(".config"));
    detect_config_file(&config_home.join("cortexkit"))
}

/// `magic-context.jsonc` in `directory`, or `magic-context.json` when only that exists,
/// matching the host's `detectConfigFile`. When neither exists the `.jsonc` path is
/// returned, which reads as "no file".
fn detect_config_file(directory: &Path) -> PathBuf {
    let jsonc = directory.join("magic-context.jsonc");
    if jsonc.exists() {
        return jsonc;
    }
    let json = directory.join("magic-context.json");
    if json.exists() {
        return json;
    }
    jsonc
}

/// The user's home directory the way Node's `os.homedir()` finds it, which is what the
/// host uses: a non-empty `HOME` first (on Windows, `USERPROFILE` before it), then the
/// platform's own answer (the password database, or the Windows profile directory).
/// `None` only when no home can be found at all; callers must not substitute the current
/// directory or `/`, which name somewhere unrelated to the user.
pub(crate) fn user_home_dir() -> Option<PathBuf> {
    let non_empty = |name: &str| {
        std::env::var_os(name)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
    };
    #[cfg(windows)]
    if let Some(profile) = non_empty("USERPROFILE") {
        return Some(profile);
    }
    non_empty("HOME").or_else(|| std::env::home_dir().filter(|home| !home.as_os_str().is_empty()))
}

fn read_tier_cached(cache: &mut TierConfig, path: PathBuf) -> Option<Value> {
    let mtime = fs::metadata(&path).and_then(|m| m.modified()).ok();
    if cache.path == path && cache.mtime == mtime {
        return cache.value.clone();
    }
    cache.path = path.clone();
    cache.mtime = mtime;
    cache.value = match fs::read_to_string(&path) {
        Ok(raw) => parse_config_text(&raw).map_or_else(
            |error| {
                // The host reports an unreadable file and uses defaults for it; say so here
                // too, rather than silently running on defaults the user did not choose.
                emit_warnings(vec![format!(
                    "{}: {error}; using defaults for this file",
                    path.display()
                )]);
                None
            },
            Some,
        ),
        Err(_) => None,
    };
    cache.value.clone()
}

/// Parse one config file's text. A leading UTF-8 byte-order mark is dropped first:
/// editors on Windows commonly write one, the host strips it before parsing, and
/// `serde_json` rejects it.
fn parse_config_text(raw: &str) -> Result<Value, serde_json::Error> {
    let without_bom = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    serde_json::from_str(&strip_jsonc(without_bom))
}

#[cfg(test)]
fn merge_tiers(user: Option<&Value>, project: Option<&Value>) -> McModuleConfig {
    let (cfg, warnings) = merge_tiers_with_warnings(user, project);
    emit_warnings(warnings);
    cfg
}

fn emit_warnings(warnings: Vec<String>) {
    for warning in warnings {
        tracing::warn!("mc-module: config warning: {warning}");
    }
}

fn resolve_user_guidance_override(
    cfg: &mut McModuleConfig,
    user: Option<&Value>,
    user_config_path: &Path,
    warnings: &mut Vec<String>,
) {
    let Some(configured_path) = user
        .and_then(|value| value.pointer("/prompt_surface/guidance_override_path"))
        .and_then(Value::as_str)
    else {
        return;
    };
    if configured_path.is_empty() {
        return;
    }

    // When a guidance override path is configured, use it as the only override source. An
    // invalid path clears any pre-resolved text and falls back to built-in guidance.
    cfg.prompt_surface_guidance_override = None;
    let configured_path = Path::new(configured_path);
    let path = if configured_path.is_absolute() {
        configured_path.to_path_buf()
    } else {
        user_config_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(configured_path)
    };

    let metadata = match fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) => {
            warnings.push(format!(
                "prompt_surface.guidance_override_path ({}) could not be read ({error}); using built-in guidance.",
                path.display()
            ));
            return;
        }
    };
    if !metadata.is_file() {
        warnings.push(format!(
            "prompt_surface.guidance_override_path ({}) is not a file; using built-in guidance.",
            path.display()
        ));
        return;
    }

    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) => {
            warnings.push(format!(
                "prompt_surface.guidance_override_path ({}) could not be read ({error}); using built-in guidance.",
                path.display()
            ));
            return;
        }
    };
    let content = String::from_utf8_lossy(&bytes).into_owned();
    if content.trim().is_empty() {
        warnings.push(format!(
            "prompt_surface.guidance_override_path ({}) is empty; using built-in guidance.",
            path.display()
        ));
        return;
    }

    let markers = guidance_marker_count(&content);
    if markers != 1 {
        warnings.push(format!(
            "prompt_surface.guidance_override_path ({}) must contain exactly one {:?} section marker; found {markers}. Using built-in guidance.",
            path.display(),
            GUIDANCE_MARKER
        ));
        return;
    }

    cfg.prompt_surface_guidance_override = Some(content);
}

const GUIDANCE_MARKER: &str = "## Magic Context";

fn guidance_marker_count(content: &str) -> usize {
    content
        .split('\n')
        .filter(|line| {
            let line = line.strip_suffix('\r').unwrap_or(line);
            line.strip_prefix(GUIDANCE_MARKER)
                .is_some_and(|suffix| suffix.bytes().all(|byte| matches!(byte, b' ' | b'\t')))
        })
        .count()
}

fn apply_cache_ttl_config(cfg: &mut McModuleConfig, value: Option<&Value>) {
    match value {
        Some(Value::String(ttl)) if !ttl.trim().is_empty() => {
            cfg.cache_ttl = ttl.trim().to_string();
            // A project-wide cache lifetime clears the user's per-model entries and becomes the default.
            cfg.cache_ttl_by_model.clear();
            cfg.cache_ttl_by_model
                .insert("default".to_string(), cfg.cache_ttl.clone());
        }
        Some(Value::Object(map)) => {
            for (key, value) in map {
                let Some(ttl) = value.as_str().map(str::trim).filter(|ttl| !ttl.is_empty()) else {
                    continue;
                };
                if key == "default" {
                    cfg.cache_ttl = ttl.to_string();
                }
                // This distinguishes an explicitly configured `5m` from the built-in `5m` default.
                cfg.cache_ttl_by_model.insert(key.clone(), ttl.to_string());
            }
        }
        _ => {}
    }
}

fn merge_tiers_with_warnings(
    user: Option<&Value>,
    project: Option<&Value>,
) -> (McModuleConfig, Vec<String>) {
    let mut cfg = McModuleConfig::default();
    let mut warnings = Vec::new();
    for (tier, value) in [("user", user), ("project", project)] {
        let Some(value) = value else {
            continue;
        };
        if value.get("clear_reasoning_age").is_some() {
            warnings.push(format!("clear_reasoning_age in {tier} tier is deprecated and ignored; use keep_reasoning_tokens (default 10,000)"));
        }
        if let Some(tokens) = value.get("keep_reasoning_tokens") {
            let valid = |value: &Value| value.as_u64().is_some_and(|n| n <= 1_000_000);
            if valid(tokens)
                || tokens
                    .as_object()
                    .is_some_and(|map| map.values().all(valid))
            {
                if let (Some(Value::Object(existing)), Value::Object(overrides)) =
                    (&mut cfg.keep_reasoning_tokens, tokens)
                {
                    existing.extend(overrides.clone());
                } else {
                    cfg.keep_reasoning_tokens = Some(tokens.clone());
                }
            } else {
                warnings.push(format!("invalid keep_reasoning_tokens in {tier} tier; expected integer 0..1,000,000 or per-model object"));
            }
        }
    }

    if let Some(user) = user {
        if let Some(temperature) = number_at(user, "/historian/temperature") {
            cfg.historian_temperature = Some(temperature);
        }
        for (pointer, name, slot) in [
            (
                "/historian/runner",
                "historian.runner",
                &mut cfg.historian_runner,
            ),
            ("/dreamer/runner", "dreamer.runner", &mut cfg.dreamer_runner),
        ] {
            if let Some(runner) = user.pointer(pointer).and_then(Value::as_str) {
                match HistorianRunnerKind::parse(runner) {
                    Some(kind) => *slot = Some(kind),
                    // An unreadable value keeps the harness default rather than refusing
                    // to fire. A typo then leaves completions running exactly where an
                    // unconfigured install runs them, instead of sending every completion
                    // somewhere the user never asked for.
                    None => warnings.push(format!(
                        "ignoring {name} {runner:?}; expected one of {}",
                        HistorianRunnerKind::ACCEPTED_VALUES.join(", ")
                    )),
                }
            }
        }
        if let Some(language) = user
            .pointer("/language")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|language| !language.is_empty())
        {
            cfg.language = Some(language.to_ascii_lowercase());
        }
        cfg.execute_threshold_user_config = execute_threshold_at(user);
        cfg.execute_threshold_user_configured = cfg.execute_threshold_user_config.is_some();
        cfg.protected_tokens_user = protected_tokens_at(user, "user", &mut warnings);
        warn_deprecated_protected_tags(user, "user", &mut warnings);
        if let Some(enabled) = user.pointer("/compaction/enabled").and_then(Value::as_bool) {
            cfg.compaction_enabled = enabled;
        }
        if let Some(enabled) = user.pointer("/memory/enabled").and_then(Value::as_bool) {
            cfg.memory_enabled = enabled;
        }
        apply_auto_search_config(&mut cfg.auto_search, user);
        apply_caveman_config(&mut cfg.caveman, user);
        if let Some(budget) = number_at(user, "/memory/injection_budget_tokens") {
            cfg.memory_budget_tokens = budget.max(1.0);
        } else if let Some(budget) = number_at(user, "/memory/budget_tokens") {
            cfg.memory_budget_tokens = budget.max(1.0);
        }
        if user.pointer("/memory/budget_tokens").is_some() {
            warnings.push(
                "deprecated key /memory/budget_tokens in user tier; use /memory/injection_budget_tokens"
                    .to_string(),
            );
        }
        if let Some(budget) = number_at(user, "/memory/user_profile_budget_tokens") {
            cfg.user_profile_budget_tokens = budget.max(1.0);
        }
        if let Some(enabled) = user
            .pointer("/memory/auto_promote")
            .and_then(Value::as_bool)
        {
            cfg.auto_promote = enabled;
        }
        if let Some(enabled) = user_memory_collection_at(user) {
            cfg.user_memory_collection_enabled = enabled;
        }
        if let Some(limit) = positive_usize_at(user, "/historian/context_limit_tokens") {
            cfg.historian_context_limit_tokens = limit;
            cfg.historian_context_limit_known = true;
        }
        if let Some(map) = user.pointer("/protected_tools").and_then(Value::as_object) {
            for (name, count) in map {
                if let Some(count) = count.as_u64().and_then(|count| usize::try_from(count).ok()) {
                    cfg.protected_tools
                        .insert(crate::selection::normalize_tool_name(name), count);
                }
            }
        }
        if let Some(enabled) = user
            .pointer("/dreamer/inject_docs")
            .and_then(Value::as_bool)
        {
            cfg.inject_docs = enabled;
        }
        if let Some(enabled) = user.pointer("/temporal_awareness").and_then(Value::as_bool) {
            cfg.temporal_awareness = enabled;
        }
        if let Some(guidance) = user
            .pointer("/prompt_surface/guidance_override_text")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
        {
            cfg.prompt_surface_guidance_override = Some(guidance.to_string());
        }
        apply_cache_ttl_config(&mut cfg, user.get("cache_ttl"));
    }

    if let Some(project) = project {
        // Cache lifetime controls idle-expiry scheduling, not prompt text, so project config may
        // set it. Project entries replace user entries with the same key.
        apply_cache_ttl_config(&mut cfg, project.get("cache_ttl"));
        cfg.execute_threshold_project_config = execute_threshold_at(project);
        cfg.protected_tokens_project = protected_tokens_at(project, "project", &mut warnings);
        warn_deprecated_protected_tags(project, "project", &mut warnings);
        warn_ignored_project_key(project, "/language", &mut warnings);
        warn_ignored_project_key(project, "/compaction/enabled", &mut warnings);
        if let Some(enabled) = project.pointer("/memory/enabled").and_then(Value::as_bool) {
            cfg.memory_enabled = enabled;
        }
        apply_auto_search_config(&mut cfg.auto_search, project);
        apply_caveman_config(&mut cfg.caveman, project);
        if let Some(budget) = number_at(project, "/memory/injection_budget_tokens") {
            cfg.memory_budget_tokens = budget.max(1.0);
        }
        if let Some(enabled) = project
            .pointer("/memory/auto_promote")
            .and_then(Value::as_bool)
        {
            cfg.auto_promote = enabled;
        }
        if let Some(enabled) = user_memory_collection_at(project) {
            cfg.user_memory_collection_enabled = enabled;
        }
        warn_ignored_project_key(project, "/memory/budget_tokens", &mut warnings);
        warn_ignored_project_key(project, "/memory/user_profile_budget_tokens", &mut warnings);
        warn_ignored_project_key(project, "/historian/context_limit_tokens", &mut warnings);
        warn_ignored_project_key(project, "/historian/runner", &mut warnings);
        if let Some(map) = project
            .pointer("/protected_tools")
            .and_then(Value::as_object)
        {
            for (name, count) in map {
                if let Some(count) = count.as_u64().and_then(|count| usize::try_from(count).ok()) {
                    cfg.protected_tools
                        .insert(crate::selection::normalize_tool_name(name), count);
                }
            }
        }
        if let Some(enabled) = project
            .pointer("/dreamer/inject_docs")
            .and_then(Value::as_bool)
        {
            cfg.inject_docs = enabled;
        }
        if let Some(enabled) = project
            .pointer("/temporal_awareness")
            .and_then(Value::as_bool)
        {
            cfg.temporal_awareness = enabled;
        }
        warn_ignored_project_key(
            project,
            "/prompt_surface/guidance_override_text",
            &mut warnings,
        );
        warn_ignored_project_key(
            project,
            "/prompt_surface/guidance_override_path",
            &mut warnings,
        );
    }

    apply_catalog_config(&mut cfg.catalog, user, project);
    for tier in [user, project].into_iter().flatten() {
        if let Some(entries) = tier
            .pointer("/historian/expand_tools")
            .and_then(Value::as_object)
        {
            for (name, value) in entries {
                if value == &Value::Bool(false)
                    || value
                        .as_str()
                        .is_some_and(crate::historian_tool_template::valid_template)
                {
                    cfg.historian_expand_tools
                        .insert(name.clone(), value.clone());
                } else {
                    warnings.push(format!(
                        "Invalid historian.expand_tools template for {name}; ignoring entry"
                    ));
                }
            }
        }
    }

    cfg.execute_threshold_user_config
        .get_or_insert(ExecuteThresholdConfig::Percentage(
            DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE,
        ));
    cfg.execute_threshold_percentage = cfg.resolve_execute_threshold(None).percentage;
    (cfg, warnings)
}

/// Read the settings only `tool.catalog` uses. Invalid entries are skipped, so a
/// typo falls back to the default wording rather than refusing every catalog.
fn apply_catalog_config(
    catalog: &mut CatalogConfigInputs,
    user: Option<&Value>,
    project: Option<&Value>,
) {
    let is_surface = |value: &str| value == "full" || value == "light";
    for tier in [user, project].into_iter().flatten() {
        if let Some(default) = tier
            .pointer("/prompt_surface/default")
            .and_then(Value::as_str)
            .filter(|value| is_surface(value))
        {
            catalog.prompt_surface_default = Some(default.to_string());
        }
        if let Some(models) = tier
            .pointer("/prompt_surface/models")
            .and_then(Value::as_object)
        {
            for (key, value) in models {
                if let Some(surface) = value.as_str().filter(|value| is_surface(value)) {
                    if !key.trim().is_empty() {
                        catalog
                            .prompt_surface_models
                            .insert(key.clone(), surface.to_string());
                    }
                }
            }
        }
    }
    if let Some(descriptions) = user
        .and_then(|user| user.pointer("/prompt_surface/tool_descriptions"))
        .and_then(Value::as_object)
    {
        for (tool, text) in descriptions {
            if let Some(text) = text.as_str().filter(|text| !text.trim().is_empty()) {
                if !tool.trim().is_empty() {
                    catalog
                        .tool_descriptions
                        .insert(tool.clone(), text.to_string());
                }
            }
        }
    }
    let configured = [user, project]
        .into_iter()
        .flatten()
        .any(|tier| tier.pointer("/dreamer").is_some_and(Value::is_object));
    // The project tier's `disable` takes precedence over the user tier's.
    let disabled = [project, user]
        .into_iter()
        .flatten()
        .find_map(|tier| tier.pointer("/dreamer/disable").and_then(Value::as_bool))
        .unwrap_or(false);
    catalog.dreamer_runnable = configured && !disabled;
}

fn warn_ignored_project_key(value: &Value, pointer: &str, warnings: &mut Vec<String>) {
    if value.pointer(pointer).is_some() {
        warnings.push(format!(
            "ignoring {pointer} from project tier; setting is user-tier only"
        ));
    }
}

fn apply_auto_search_config(config: &mut AutoSearchConfig, value: &Value) {
    if let Some(enabled) = value
        .pointer("/memory/auto_search/enabled")
        .and_then(Value::as_bool)
    {
        config.enabled = enabled;
    }
    if let Some(threshold) = number_at(value, "/memory/auto_search/score_threshold") {
        config.score_threshold = threshold.clamp(0.3, 0.95);
    }
    if let Some(min_prompt_chars) = positive_usize_at(value, "/memory/auto_search/min_prompt_chars")
    {
        config.min_prompt_chars = min_prompt_chars.clamp(5, 500);
    }
}

fn apply_caveman_config(config: &mut CavemanConfig, value: &Value) {
    if let Some(enabled) = value
        .pointer("/caveman_text_compression/enabled")
        .and_then(Value::as_bool)
    {
        config.enabled = enabled;
    }
    if let Some(min_chars) = positive_usize_at(value, "/caveman_text_compression/min_chars") {
        config.min_size = min_chars.clamp(100, 10_000);
    }
}

fn user_memory_collection_at(value: &Value) -> Option<bool> {
    if let Some(schedule) = value
        .pointer("/dreamer/tasks/review-user-memories/schedule")
        .and_then(Value::as_str)
    {
        return Some(!schedule.trim().is_empty());
    }
    value
        .pointer("/user_memories/enabled")
        .and_then(Value::as_bool)
}

fn positive_usize_at(value: &Value, pointer: &str) -> Option<usize> {
    value
        .pointer(pointer)
        .and_then(Value::as_u64)
        .and_then(|v| usize::try_from(v).ok())
        .filter(|v| *v > 0)
}

fn protected_tokens_at(value: &Value, tier: &str, warnings: &mut Vec<String>) -> Option<u64> {
    let configured = value.get("protected_tokens")?;
    let valid = configured
        .as_u64()
        .filter(|tokens| (4_000..=1_000_000).contains(tokens));
    if valid.is_none() {
        warnings.push(format!(
            "invalid {tier} protected_tokens; expected an integer from 4000 through 1000000; using the derived/default floor"
        ));
    }
    valid
}

fn warn_deprecated_protected_tags(value: &Value, tier: &str, warnings: &mut Vec<String>) {
    if value.get("protected_tags").is_some() {
        warnings.push(format!(
            "deprecated {tier} protected_tags is ignored; use protected_tokens"
        ));
    }
}

fn execute_threshold_at(value: &Value) -> Option<ExecuteThresholdConfig> {
    let threshold = value.get("execute_threshold_percentage")?;
    if let Some(number) = threshold.as_f64() {
        return Some(ExecuteThresholdConfig::Percentage(number));
    }
    threshold.as_object().map(|values| {
        ExecuteThresholdConfig::ByModel(
            values
                .iter()
                .filter_map(|(key, value)| value.as_f64().map(|value| (key.clone(), value)))
                .collect(),
        )
    })
}

fn number_at(value: &Value, pointer: &str) -> Option<f64> {
    value
        .pointer(pointer)
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite())
}

/// Strip JSONC line/block comments and trailing commas while respecting string literals.
/// The module only consumes its own config convention; this is not a general JSONC parser.
pub fn strip_jsonc(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut i = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    while i < chars.len() {
        let c = chars[i];
        if in_string {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        if c == '"' {
            in_string = true;
            out.push(c);
            i += 1;
            continue;
        }
        let next = chars.get(i + 1).copied().unwrap_or('\0');
        if c == '/' && next == '/' {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '/' && next == '*' {
            i += 2;
            while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                i += 1;
            }
            i = (i + 2).min(chars.len());
            continue;
        }
        if c == ',' {
            let mut k = i + 1;
            loop {
                while k < chars.len() && chars[k].is_whitespace() {
                    k += 1;
                }
                if k + 1 < chars.len() && chars[k] == '/' && chars[k + 1] == '/' {
                    k += 2;
                    while k < chars.len() && chars[k] != '\n' {
                        k += 1;
                    }
                    continue;
                }
                if k + 1 < chars.len() && chars[k] == '/' && chars[k + 1] == '*' {
                    k += 2;
                    while k + 1 < chars.len() && !(chars[k] == '*' && chars[k + 1] == '/') {
                        k += 1;
                    }
                    k = (k + 2).min(chars.len());
                    continue;
                }
                break;
            }
            if k < chars.len() && matches!(chars[k], '}' | ']') {
                i += 1;
                continue;
            }
        }
        out.push(c);
        i += 1;
    }
    out
}

#[cfg(test)]
mod protected_tokens_tests {
    #[test]
    fn review_reasoning_budget_aliases_follow_the_shared_canonical_first_lookup() {
        let (cfg, _) = super::merge_tiers_with_warnings(
            Some(&serde_json::json!({"keep_reasoning_tokens": {
                "openai/*": 250,
                "openai-codex/*": 500,
                "google/*": 750
            }})),
            None,
        );
        // The shared TS/Pi resolver checks canonical spellings first. Both a
        // collision and a canonical-only wildcard must behave the same in Rust.
        assert_eq!(
            cfg.resolve_keep_reasoning_tokens(Some("openai-codex/gpt-6.1-sol")),
            250
        );
        assert_eq!(
            cfg.resolve_keep_reasoning_tokens(Some("google-antigravity/gemini-3.8-flash")),
            750
        );
    }

    #[test]
    fn reasoning_budget_resolution_fixed_default_and_deprecated_age() {
        use super::*;
        let (cfg, warnings) = merge_tiers_with_warnings(
            Some(
                &serde_json::json!({"clear_reasoning_age": 1, "keep_reasoning_tokens": {"default": 4000, "openai/*": 3000, "openai/gpt-5": 2000, "openai/gpt-5-mini": 1000}}),
            ),
            None,
        );
        assert_eq!(
            cfg.resolve_keep_reasoning_tokens(Some("openai/gpt-5-mini")),
            1000
        );
        assert_eq!(
            cfg.resolve_keep_reasoning_tokens(Some("openai/gpt-5-pro")),
            2000
        );
        assert_eq!(cfg.resolve_keep_reasoning_tokens(Some("openai/o3")), 3000);
        assert_eq!(cfg.resolve_keep_reasoning_tokens(Some("other/model")), 4000);
        assert!(warnings
            .iter()
            .any(|warning| warning.contains("clear_reasoning_age") && warning.contains("ignored")));
        assert_eq!(
            McModuleConfig::default().resolve_keep_reasoning_tokens(None),
            10_000
        );
        let (zero, _) =
            merge_tiers_with_warnings(None, Some(&serde_json::json!({"keep_reasoning_tokens": 0})));
        assert_eq!(zero.resolve_keep_reasoning_tokens(None), 0);
    }
    use super::*;
    use serde_json::json;

    #[test]
    fn scalar_overrides_resolve_raise_only_after_geometry_derivation() {
        let (cfg, warnings) = merge_tiers_with_warnings(
            Some(&json!({ "protected_tokens": 20_000 })),
            Some(&json!({ "protected_tokens": 16_000 })),
        );
        assert!(warnings.is_empty());
        let resolved = cfg.resolve_protected_tokens(200_000);
        assert_eq!(resolved.floor, 20_000);
        assert_eq!(resolved.provenance, "user");
        assert!(resolved.warning.unwrap().contains("cannot lower"));

        let (cfg, _) = merge_tiers_with_warnings(
            Some(&json!({ "protected_tokens": 20_000 })),
            Some(&json!({ "protected_tokens": 30_000 })),
        );
        assert_eq!(cfg.resolve_protected_tokens(200_000).floor, 30_000);
    }

    #[test]
    fn invalid_override_falls_back_and_deprecated_count_is_parsed_inertly() {
        let (cfg, warnings) = merge_tiers_with_warnings(
            Some(&json!({ "protected_tokens": 4_000.5, "protected_tags": 101 })),
            None,
        );
        assert_eq!(cfg.resolve_protected_tokens(372_000).floor, 18_600);
        assert_eq!(warnings.len(), 2);
        assert!(warnings[0].contains("expected an integer"));
        assert!(warnings[1].contains("protected_tags is ignored"));
    }
}

#[cfg(test)]
mod cache_ttl_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn per_model_cache_ttl_object_shape_parses_and_resolves() {
        let user = json!({
            "cache_ttl": {
                "default": "10m",
                "anthropic/claude-opus-4-8": "300m",
                "gpt-5.6-sol": "30m"
            }
        });
        let cfg = merge_tiers(Some(&user), None);
        assert_eq!(cfg.cache_ttl, "10m");
        assert_eq!(
            cfg.resolve_cache_ttl(Some("anthropic/claude-opus-4-8")),
            "300m"
        );
        // Bare model id matches a provider-prefixed request key.
        assert_eq!(cfg.resolve_cache_ttl(Some("openai/gpt-5.6-sol")), "30m");
        assert_eq!(cfg.resolve_cache_ttl(Some("unknown/model")), "10m");
        assert_eq!(cfg.resolve_cache_ttl(None), "10m");
        // A bare unprefixed key with an exact config entry must not downgrade
        // to the default (pre-parity behavior preserved).
        assert_eq!(cfg.resolve_cache_ttl(Some("gpt-5.6-sol")), "30m");
    }

    #[test]
    fn provenance_distinguishes_an_explicit_value_equal_to_the_default() {
        let mut cfg = McModuleConfig::default();
        cfg.cache_ttl_by_model.insert(
            "anthropic/claude-haiku-4-5".to_string(),
            cfg.cache_ttl.clone(),
        );

        let explicit = cfg.resolve_cache_ttl_with_provenance(Some("anthropic/claude-haiku-4-5"));
        let fallback = cfg.resolve_cache_ttl_with_provenance(Some("anthropic/claude-nova-6-0"));
        assert_eq!(explicit.value, fallback.value);
        assert_eq!(explicit.provenance, CacheTtlProvenance::Explicit);
        assert_eq!(fallback.provenance, CacheTtlProvenance::Default);
    }

    #[test]
    fn cache_ttl_resolution_matches_shared_typescript_vectors() {
        let vectors: serde_json::Value =
            serde_json::from_str(include_str!("../testdata/cache-ttl-routing-vectors.json"))
                .unwrap();
        let mut cfg = McModuleConfig {
            cache_ttl: vectors["default"].as_str().unwrap().to_string(),
            ..McModuleConfig::default()
        };
        cfg.cache_ttl_by_model = vectors["models"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(key, value)| (key.clone(), value.as_str().unwrap().to_string()))
            .collect();

        for case in vectors["cases"].as_array().unwrap() {
            assert_eq!(
                cfg.resolve_cache_ttl(case["modelKey"].as_str()),
                case["expected"].as_str().unwrap(),
                "shared vector {}",
                case["name"].as_str().unwrap()
            );
        }
    }

    #[test]
    fn string_cache_ttl_shape_still_parses() {
        let user = json!({ "cache_ttl": "45m" });
        let cfg = merge_tiers(Some(&user), None);
        assert_eq!(cfg.cache_ttl, "45m");
        assert_eq!(
            cfg.resolve_cache_ttl(Some("anthropic/claude-opus-4-8")),
            "45m"
        );
    }

    #[test]
    fn project_tier_cache_ttl_overrides_user_policy_per_key() {
        let project = json!({ "cache_ttl": { "default": "600m" } });
        let user = json!({ "cache_ttl": { "default": "1h", "anthropic/opus": "13h" } });
        let cfg = merge_tiers(Some(&user), Some(&project));
        assert_eq!(cfg.resolve_cache_ttl(Some("other/model")), "600m");
        assert_eq!(cfg.resolve_cache_ttl(Some("anthropic/opus")), "13h");
        assert_eq!(
            cfg.resolve_cache_ttl_with_provenance(None).provenance,
            CacheTtlProvenance::ConfiguredDefault
        );
        let global = merge_tiers(Some(&user), Some(&json!({ "cache_ttl": "5m" })));
        assert_eq!(global.resolve_cache_ttl(Some("anthropic/opus")), "5m");
        assert_eq!(
            global
                .resolve_cache_ttl_with_provenance(Some("anthropic/opus"))
                .provenance,
            CacheTtlProvenance::ConfiguredDefault
        );
    }
}

#[cfg(test)]
mod tests {

    use super::*;

    #[test]
    fn catalog_settings_follow_the_tiers_the_plugin_allows() {
        let unconfigured = merge_tiers(None, None).catalog;
        assert_eq!(unconfigured, CatalogConfigInputs::default());
        assert!(
            !unconfigured.dreamer_runnable,
            "no dreamer block, no dreamer"
        );

        let user = serde_json::json!({
            "prompt_surface": {
                "default": "light",
                "models": {"anthropic/claude-haiku-4-5": "light", "openai/*": "full", "bad": "tiny"},
                "tool_descriptions": {"ctx_search": "Search it.", "ctx_note": "  "},
            },
            "dreamer": {"runner": "host"},
        });
        let project = serde_json::json!({
            "prompt_surface": {
                "default": "full",
                "models": {"openai/*": "light"},
                "tool_descriptions": {"ctx_search": "repository-controlled text"},
            },
            "dreamer": {"disable": true},
        });
        let user_only = merge_tiers(Some(&user), None).catalog;
        assert_eq!(user_only.prompt_surface_default.as_deref(), Some("light"));
        assert!(user_only.dreamer_runnable);
        assert_eq!(
            user_only.tool_descriptions,
            std::collections::BTreeMap::from([(
                "ctx_search".to_string(),
                "Search it.".to_string()
            )]),
            "blank descriptions are skipped"
        );

        let both = merge_tiers(Some(&user), Some(&project)).catalog;
        // The project tier may pick among shipped wordings, but never write
        // model-facing text, and its `dreamer.disable` takes precedence.
        assert_eq!(both.prompt_surface_default.as_deref(), Some("full"));
        assert_eq!(
            both.prompt_surface_models,
            std::collections::BTreeMap::from([
                (
                    "anthropic/claude-haiku-4-5".to_string(),
                    "light".to_string()
                ),
                ("openai/*".to_string(), "light".to_string()),
            ])
        );
        assert_eq!(both.tool_descriptions, user_only.tool_descriptions);
        assert!(!both.dreamer_runnable);
    }

    #[test]
    fn an_unconfigured_runner_is_left_to_the_harness_and_only_the_user_may_set_it() {
        use crate::historian_runner::RunnerSource;

        let unconfigured = merge_tiers(None, None);
        assert_eq!(unconfigured.historian_runner, None);
        assert_eq!(unconfigured.dreamer_runner, None);
        for (harness, kind) in [
            ("opencode", HistorianRunnerKind::Host),
            ("opencode2", HistorianRunnerKind::Host),
            ("claude-code", HistorianRunnerKind::Broca),
            ("pi", HistorianRunnerKind::Broca),
        ] {
            for resolved in [
                unconfigured.historian_runner_for(harness),
                unconfigured.dreamer_runner_for(harness),
            ] {
                assert_eq!(resolved.kind, kind, "{harness}");
                assert_eq!(resolved.source, RunnerSource::HarnessDefault, "{harness}");
            }
        }

        let user = serde_json::json!({ "historian": { "runner": "broca" } });
        let configured = merge_tiers(Some(&user), None);
        assert_eq!(
            configured.historian_runner,
            Some(HistorianRunnerKind::Broca)
        );
        for resolved in [
            configured.historian_runner_for("opencode"),
            configured.dreamer_runner_for("opencode2"),
        ] {
            assert_eq!(resolved.kind, HistorianRunnerKind::Broca);
            assert_eq!(resolved.source, RunnerSource::Configured);
        }

        // A cloned repository must not be able to move either completion to a
        // different process or provider account.
        let project = serde_json::json!({
            "historian": { "runner": "broca" },
            "dreamer": { "runner": "broca" },
        });
        let from_project = merge_tiers(None, Some(&project));
        assert_eq!(from_project.historian_runner, None);
        assert_eq!(from_project.dreamer_runner, None);
        let user = serde_json::json!({ "historian": { "runner": "host" } });
        assert_eq!(
            merge_tiers(Some(&user), Some(&project)).historian_runner,
            Some(HistorianRunnerKind::Host),
            "the project tier cannot move the runner in either direction"
        );
    }

    #[test]
    fn the_dreamer_runner_falls_back_to_the_historian_runner_then_the_harness() {
        let historian_only = merge_tiers(
            Some(&serde_json::json!({ "historian": { "runner": "broca" } })),
            None,
        );
        assert_eq!(
            historian_only.dreamer_runner_for("opencode").kind,
            HistorianRunnerKind::Broca
        );
        let split = merge_tiers(
            Some(&serde_json::json!({
                "historian": { "runner": "broca" },
                "dreamer": { "runner": "host" },
            })),
            None,
        );
        assert_eq!(
            split.historian_runner_for("opencode").kind,
            HistorianRunnerKind::Broca
        );
        assert_eq!(
            split.dreamer_runner_for("claude-code").kind,
            HistorianRunnerKind::Host
        );
    }

    #[test]
    fn the_boot_runners_are_read_from_the_user_file_alone() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("magic-context.jsonc");
        assert_eq!(
            user_configured_runners_at(&path),
            ConfiguredRunners {
                historian: None,
                dreamer: None,
            }
        );
        std::fs::write(
            &path,
            r#"{ // user tier
            "historian": { "runner": "host" } }"#,
        )
        .expect("write user config");
        assert_eq!(
            user_configured_runners_at(&path),
            ConfiguredRunners {
                historian: Some(HistorianRunnerKind::Host),
                dreamer: Some(HistorianRunnerKind::Host),
            }
        );
    }

    #[test]
    fn an_unreadable_runner_value_leaves_the_choice_to_the_harness() {
        for value in [serde_json::json!("hosted"), serde_json::json!("")] {
            let user = serde_json::json!({
                "historian": { "runner": value.clone() },
                "dreamer": { "runner": value.clone() },
            });
            let cfg = merge_tiers(Some(&user), None);
            assert_eq!(cfg.historian_runner, None, "value {value}");
            assert_eq!(cfg.dreamer_runner, None, "value {value}");
        }
        // A non-string is not a runner name at all and is ignored the same way.
        let user = serde_json::json!({ "historian": { "runner": 7 } });
        assert_eq!(merge_tiers(Some(&user), None).historian_runner, None);
    }

    #[test]
    fn tier_policy_rejects_project_lowering() {
        let user = serde_json::json!({
            "execute_threshold_percentage": 80,
            "memory": { "enabled": false }
        });
        let project = serde_json::json!({
            "execute_threshold_percentage": 40,
            "memory": { "enabled": true }
        });
        let cfg = merge_tiers(Some(&user), Some(&project));
        assert_eq!(cfg.execute_threshold_percentage, 80.0);
        assert!(cfg.memory_enabled);
    }

    #[test]
    fn language_is_normalized_from_user_config_and_rejected_from_project_config() {
        let user = serde_json::json!({ "language": " Tr " });
        let project = serde_json::json!({ "language": "nb" });

        let (cfg, warnings) = merge_tiers_with_warnings(Some(&user), Some(&project));

        assert_eq!(cfg.language.as_deref(), Some("tr"));
        assert!(warnings.iter().any(|warning| {
            warning.contains("/language")
                && warning.contains("project tier")
                && warning.contains("user-tier only")
        }));
    }

    #[test]
    fn project_threshold_may_only_raise() {
        let user = serde_json::json!({ "execute_threshold_percentage": 70 });
        let project = serde_json::json!({ "execute_threshold_percentage": 91 });
        let cfg = merge_tiers(Some(&user), Some(&project));
        assert_eq!(cfg.execute_threshold_percentage, 90.0);
    }

    #[test]
    fn object_execute_threshold_default_is_not_silently_replaced_by_builtin_65() {
        let object = merge_tiers(
            Some(&serde_json::json!({
                "execute_threshold_percentage": {
                    "default": 75,
                    "openai/gpt-6-astra": 85
                }
            })),
            None,
        );
        assert_eq!(object.execute_threshold_percentage, 75.0);
        assert!(!scheduler::advance_drain_latch(
            scheduler::LatchState {
                active_since_ms: Some(1_000)
            },
            63.0,
            object
                .resolve_execute_threshold(Some("anthropic/claude-sonnet-5"))
                .percentage,
            2_000,
        )
        .is_active());
        assert_eq!(
            object.resolve_execute_threshold(Some("anthropic/claude-sonnet-5")),
            ResolvedExecuteThreshold {
                percentage: 75.0,
                provenance: "object.default"
            }
        );
        assert_eq!(
            object.resolve_execute_threshold(Some("openai/gpt-6-astra-fast")),
            ResolvedExecuteThreshold {
                percentage: 85.0,
                provenance: "object.model"
            }
        );
        let scalar = merge_tiers(
            Some(&serde_json::json!({"execute_threshold_percentage": 65})),
            None,
        );
        assert_eq!(scalar.execute_threshold_percentage, 65.0);
    }

    #[test]
    fn execute_threshold_config_matches_typescript_percentage_goldens() {
        let golden: Value =
            serde_json::from_str(include_str!("../testdata/scheduler-golden.json")).unwrap();
        let mut checked = 0;
        for case in golden["threshold_cases"].as_array().unwrap() {
            if case.get("tokens_config").is_some() {
                continue;
            }
            let cfg = merge_tiers(
                Some(
                    &serde_json::json!({"execute_threshold_percentage": case["percentage_config"]}),
                ),
                None,
            );
            assert_eq!(
                cfg.resolve_execute_threshold(case["model_key"].as_str())
                    .percentage,
                case["expected"].as_f64().unwrap(),
                "{}",
                case["label"]
            );
            checked += 1;
        }
        assert!(checked >= 4);
    }

    #[test]
    fn execute_threshold_object_lookup_and_project_floor_preserve_model_identity() {
        let user = serde_json::json!({"execute_threshold_percentage": {"default": 75, "claude-sonnet": 78, "anthropic/claude-sonnet-5": 82}});
        let project = serde_json::json!({"execute_threshold_percentage": {"default": 90, "anthropic/claude-sonnet-5": 80}});
        let cfg = merge_tiers(Some(&user), Some(&project));
        assert_eq!(
            cfg.resolve_execute_threshold(Some("anthropic/claude-sonnet-5"))
                .percentage,
            82.0
        );
        assert_eq!(
            cfg.resolve_execute_threshold(Some("openai/gpt-6-astra"))
                .percentage,
            90.0
        );
        let alias = merge_tiers(
            Some(
                &serde_json::json!({"execute_threshold_percentage": {"default": 65, "openai-codex/gpt-5.6-sol": 40}}),
            ),
            None,
        );
        assert_eq!(
            alias
                .resolve_execute_threshold(Some("openai/gpt-5.6-sol"))
                .percentage,
            40.0
        );
        let canonical = merge_tiers(
            Some(
                &serde_json::json!({"execute_threshold_percentage": {"default": 65, "openai-codex/gpt-5.6-sol": 40, "openai/gpt-5.6-sol": 30}}),
            ),
            None,
        );
        assert_eq!(
            canonical
                .resolve_execute_threshold(Some("openai-codex/gpt-5.6-sol"))
                .percentage,
            30.0
        );
        let user_only = merge_tiers(Some(&user), None);
        assert_eq!(
            user_only
                .resolve_execute_threshold(Some("anthropic/claude-sonnet-4-fast"))
                .percentage,
            78.0
        );
        for (value, expected) in [(0.0, 0.0), (-1.0, 65.0), (95.0, 90.0)] {
            let cfg = merge_tiers(
                Some(&serde_json::json!({"execute_threshold_percentage": value})),
                None,
            );
            assert_eq!(cfg.resolve_execute_threshold(None).percentage, expected);
        }
        assert_eq!(
            merge_tiers(None, None)
                .resolve_execute_threshold(None)
                .provenance,
            "builtin"
        );
        assert_eq!(
            merge_tiers(
                Some(&serde_json::json!({"execute_threshold_percentage": 65})),
                None
            )
            .resolve_execute_threshold(None)
            .provenance,
            "scalar"
        );
    }

    #[test]
    fn default_threshold_matches_typescript_schema() {
        let cfg = merge_tiers(None, None);
        assert_eq!(cfg.execute_threshold_percentage, 65.0);
    }

    #[test]
    fn default_memory_budget_matches_typescript_schema() {
        // Twin: packages/plugin/src/config/schema/magic-context.ts defaults
        // memory.injection_budget_tokens to 4,000.
        assert_eq!(DEFAULT_MEMORY_BUDGET_TOKENS, 4_000.0);
        assert_eq!(merge_tiers(None, None).memory_budget_tokens, 4_000.0);
    }

    #[test]
    fn memory_injection_budget_uses_standard_key_and_deprecated_user_fallback() {
        let standard_user = serde_json::json!({
            "memory": { "injection_budget_tokens": 3_000, "budget_tokens": 9_000 }
        });
        let standard_project = serde_json::json!({
            "memory": { "injection_budget_tokens": 3_500 }
        });
        let (standard, warnings) =
            merge_tiers_with_warnings(Some(&standard_user), Some(&standard_project));
        assert_eq!(standard.memory_budget_tokens, 3_500.0);
        assert!(warnings.iter().any(|warning| {
            warning.contains("/memory/budget_tokens") && warning.contains("deprecated")
        }));

        let legacy_user = serde_json::json!({ "memory": { "budget_tokens": 3_250 } });
        let (legacy, warnings) = merge_tiers_with_warnings(Some(&legacy_user), None);
        assert_eq!(legacy.memory_budget_tokens, 3_250.0);
        assert!(warnings.iter().any(|warning| {
            warning.contains("/memory/budget_tokens")
                && warning.contains("user tier")
                && warning.contains("/memory/injection_budget_tokens")
        }));
    }

    #[test]
    fn rust_only_budget_leaves_are_user_tier_only_and_warn_when_project_supplies_them() {
        let user = serde_json::json!({
            "memory": {
                "injection_budget_tokens": 5_000,
                "user_profile_budget_tokens": 2_500
            },
            "historian": { "context_limit_tokens": 64_000 }
        });
        let project = serde_json::json!({
            "memory": {
                "budget_tokens": 19_000,
                "user_profile_budget_tokens": 12_000
            },
            "historian": { "context_limit_tokens": 200_000 }
        });
        let (cfg, warnings) = merge_tiers_with_warnings(Some(&user), Some(&project));

        assert_eq!(cfg.memory_budget_tokens, 5_000.0);
        assert_eq!(cfg.user_profile_budget_tokens, 2_500.0);
        assert_eq!(cfg.historian_context_limit_tokens, 64_000);
        assert!(cfg.historian_context_limit_known);
        for key in [
            "/memory/budget_tokens",
            "/memory/user_profile_budget_tokens",
            "/historian/context_limit_tokens",
        ] {
            assert!(
                warnings.iter().any(|warning| {
                    warning.contains(key)
                        && warning.contains("project tier")
                        && warning.contains("user-tier only")
                }),
                "missing warning for {key}: {warnings:?}"
            );
        }
    }

    #[test]
    fn compaction_enabled_defaults_true_and_is_user_tier_only() {
        assert!(merge_tiers(None, None).compaction_enabled);

        let user = serde_json::json!({ "compaction": { "enabled": false } });
        let project = serde_json::json!({ "compaction": { "enabled": true } });
        let (cfg, warnings) = merge_tiers_with_warnings(Some(&user), Some(&project));
        assert!(!cfg.compaction_enabled);
        assert!(warnings.iter().any(|warning| {
            warning.contains("/compaction/enabled") && warning.contains("project tier")
        }));

        let (project_only, warnings) = merge_tiers_with_warnings(None, Some(&project));
        assert!(project_only.compaction_enabled);
        assert_eq!(warnings.len(), 1);
    }

    #[test]
    fn auto_search_and_caveman_config_follow_user_then_project_tiers() {
        let user = serde_json::json!({
            "memory": { "auto_search": {
                "enabled": false,
                "score_threshold": 0.4,
                "min_prompt_chars": 100
            }},
            "caveman_text_compression": { "enabled": true, "min_chars": 900 }
        });
        let project = serde_json::json!({
            "memory": { "auto_search": {
                "enabled": true,
                "score_threshold": 0.8,
                "min_prompt_chars": 50
            }},
            "caveman_text_compression": { "enabled": false, "min_chars": 700 }
        });
        let cfg = merge_tiers(Some(&user), Some(&project));
        assert_eq!(
            cfg.auto_search,
            AutoSearchConfig {
                enabled: true,
                score_threshold: 0.8,
                min_prompt_chars: 50,
            }
        );
        assert_eq!(
            cfg.caveman,
            CavemanConfig {
                enabled: false,
                min_size: 700,
            }
        );

        assert_eq!(
            merge_tiers(None, None).auto_search,
            AutoSearchConfig::default()
        );
        assert_eq!(merge_tiers(None, None).caveman, CavemanConfig::default());
    }

    #[test]
    fn historian_budget_derivation_clamps_at_both_bounds() {
        assert_eq!(derive_historian_chunk_tokens(1), 8_000);
        assert_eq!(derive_historian_chunk_tokens(32_000), 8_000);
        assert_eq!(derive_historian_chunk_tokens(128_000), 32_000);
        assert_eq!(derive_historian_chunk_tokens(200_000), 50_000);
        assert_eq!(derive_historian_chunk_tokens(400_000), 50_000);
    }

    #[test]
    fn docs_and_temporal_flags_follow_user_then_project_tiers() {
        let user = serde_json::json!({
            "dreamer": { "inject_docs": false },
            "temporal_awareness": false
        });
        let project = serde_json::json!({
            "dreamer": { "inject_docs": true },
            "temporal_awareness": true
        });
        let cfg = merge_tiers(Some(&user), Some(&project));
        assert!(cfg.inject_docs);
        assert!(cfg.temporal_awareness);
        let defaults = merge_tiers(None, None);
        assert!(defaults.inject_docs);
        assert!(defaults.temporal_awareness);
    }

    #[test]
    fn protected_tools_merge_defaults_user_project_and_ignore_smart_drops() {
        let config = merge_tiers(
            Some(
                &serde_json::json!({"protected_tools":{"MCP_CUSTOM":3,"todowrite":0},"smart_drops":false}),
            ),
            Some(
                &serde_json::json!({"protected_tools":{"custom":2,"CTX_REDUCE":1},"smart_drops":"ignored"}),
            ),
        );
        assert_eq!(
            config.protected_tools,
            [
                ("custom".to_string(), 2),
                ("ctx_reduce".to_string(), 1),
                ("todowrite".to_string(), 0)
            ]
            .into()
        );
        assert_eq!(
            merge_tiers(None, None).protected_tools,
            crate::selection::default_protected_tools()
        );
    }

    #[test]
    fn guidance_override_accepts_resolved_user_text_and_ignores_project_injection() {
        let user = serde_json::json!({
            "prompt_surface": {
                "guidance_override_text": "## Magic Context\n\nTrusted user guidance."
            }
        });
        let project = serde_json::json!({
            "prompt_surface": {
                "guidance_override_text": "## Magic Context\n\nProject injection.",
                "guidance_override_path": "/repo/untrusted.md"
            }
        });

        let (cfg, warnings) = merge_tiers_with_warnings(Some(&user), Some(&project));

        assert_eq!(
            cfg.prompt_surface_guidance_override.as_deref(),
            Some("## Magic Context\n\nTrusted user guidance.")
        );
        assert_eq!(warnings.len(), 2);
        assert!(warnings
            .iter()
            .all(|warning| warning.contains("user-tier only")));
    }

    #[test]
    fn guidance_override_path_resolves_relative_to_user_config_directory() {
        let dir = tempfile::tempdir().unwrap();
        let user_path = dir.path().join("magic-context.jsonc");
        let guidance_path = dir.path().join("guidance.md");
        let guidance = "## Magic Context\r\n\r\nTrusted route guidance.\r\n";
        fs::write(&guidance_path, guidance).unwrap();
        fs::write(
            &user_path,
            r#"{
                "prompt_surface": {
                    "guidance_override_path": "guidance.md"
                }
            }"#,
        )
        .unwrap();

        let mut cache = ConfigCache::default();
        let cfg = cache.effective_for_paths(&user_path, dir.path());

        assert_eq!(
            cfg.prompt_surface_guidance_override.as_deref(),
            Some(guidance)
        );
    }

    #[test]
    fn guidance_override_invalid_and_missing_files_warn_and_fall_back() {
        let dir = tempfile::tempdir().unwrap();
        let user_path = dir.path().join("magic-context.jsonc");
        let invalid_path = dir.path().join("invalid.md");
        fs::write(
            &invalid_path,
            "## Magic Context\n\nFirst.\n## Magic Context \t\n\nSecond.",
        )
        .unwrap();

        for (configured_path, expected_warning) in [
            (
                "invalid.md",
                "must contain exactly one \"## Magic Context\" section marker; found 2",
            ),
            ("missing.md", "could not be read"),
        ] {
            let user = serde_json::json!({
                "prompt_surface": {
                    "guidance_override_path": configured_path,
                    "guidance_override_text": "## Magic Context\n\nStale text"
                }
            });
            let (mut cfg, mut warnings) = merge_tiers_with_warnings(Some(&user), None);

            resolve_user_guidance_override(&mut cfg, Some(&user), &user_path, &mut warnings);

            assert!(cfg.prompt_surface_guidance_override.is_none());
            assert_eq!(warnings.len(), 1);
            assert!(warnings[0].contains(expected_warning), "{}", warnings[0]);
            assert!(warnings[0]
                .to_ascii_lowercase()
                .contains("using built-in guidance"));
        }
    }

    #[test]
    fn guidance_marker_validation_matches_the_typescript_line_rule() {
        assert_eq!(guidance_marker_count("## Magic Context"), 1);
        assert_eq!(guidance_marker_count("## Magic Context \t\r\nbody"), 1);
        assert_eq!(guidance_marker_count("prefix ## Magic Context\nbody"), 0);
        assert_eq!(guidance_marker_count("## Magic Context extra\nbody"), 0);
    }

    #[test]
    fn historian_gates_follow_tiers_but_context_limit_remains_user_tier_only() {
        let user = serde_json::json!({
            "memory": { "auto_promote": false },
            "dreamer": { "tasks": { "review-user-memories": { "schedule": "daily" } } },
            "historian": { "context_limit_tokens": 128000 }
        });
        let project = serde_json::json!({
            "memory": { "auto_promote": true },
            "user_memories": { "enabled": false },
            "historian": { "context_limit_tokens": 64000 }
        });
        assert!(user_memory_collection_at(&user).unwrap());
        let cfg = merge_tiers(Some(&user), Some(&project));
        assert!(cfg.auto_promote);
        assert!(!cfg.user_memory_collection_enabled);
        assert_eq!(cfg.historian_context_limit_tokens, 128_000);
        let legacy_disabled = serde_json::json!({
            "user_memories": { "enabled": false }
        });
        assert!(!user_memory_collection_at(&legacy_disabled).unwrap());
    }

    #[test]
    fn historian_expand_tools_merges_user_and_project_templates_with_validation() {
        let user = serde_json::json!({ "historian": { "expand_tools": { "ask": "User ${output}", "peer_send": false, "read": "${input.path}" } } });
        let project = serde_json::json!({ "historian": { "expand_tools": { "ask": false, "board": "${input.ops.each(\"${op}\")}" } } });
        let config = merge_tiers(Some(&user), Some(&project));
        assert_eq!(
            config.historian_expand_tools["ask"],
            serde_json::json!(false)
        );
        assert_eq!(
            config.historian_expand_tools["peer_send"],
            serde_json::json!(false)
        );
        assert_eq!(
            config.historian_expand_tools["read"],
            serde_json::json!("${input.path}")
        );
        assert!(config.historian_expand_tools.contains_key("board"));
        let invalid =
            serde_json::json!({ "historian": { "expand_tools": { "ask": "${input.x.nope()}" } } });
        let (config, warnings) = merge_tiers_with_warnings(Some(&invalid), None);
        assert!(config.historian_expand_tools.is_empty());
        assert!(warnings
            .iter()
            .any(|w| w.contains("Invalid historian.expand_tools")));
    }

    #[test]
    fn historian_temperature_is_optional_and_user_tier_only() {
        let project = serde_json::json!({ "historian": { "temperature": 0.9 } });
        assert_eq!(merge_tiers(None, None).historian_temperature, None);
        for temperature in [0.1, 0.0] {
            let user = serde_json::json!({
                "historian": {
                    "temperature": temperature
                }
            });
            let resolved = merge_tiers(Some(&user), Some(&project));
            assert_eq!(resolved.historian_temperature, Some(temperature));
        }
        assert_eq!(
            merge_tiers(None, Some(&project)).historian_temperature,
            None
        );
    }

    #[test]
    fn jsonc_strip_preserves_comment_like_strings() {
        let parsed: Value = serde_json::from_str(&strip_jsonc(
            r#"{ "url": "http://x/y", "a": [1,], /* c */ }"#,
        ))
        .unwrap();
        assert_eq!(parsed["url"], "http://x/y");
        assert_eq!(parsed["a"], serde_json::json!([1]));
    }

    #[test]
    fn mtime_cache_reuses_unchanged_reads_and_invalidates_on_mtime_change() {
        let dir = tempfile::tempdir().unwrap();
        let user = dir.path().join("user.jsonc");
        let project = dir.path().join("project");
        std::fs::create_dir_all(project.join(".cortexkit")).unwrap();

        std::fs::write(&user, r#"{ "historian": { "temperature": 0.1 } }"#).unwrap();
        std::fs::write(
            project.join(".cortexkit/magic-context.jsonc"),
            r#"{ "memory": { "enabled": true } }"#,
        )
        .unwrap();

        let mut cache = ConfigCache::default();
        let first = cache.effective_for_paths(&user, &project);
        assert_eq!(first.historian_temperature, Some(0.1));

        // Without an mtime change, a different file body is intentionally ignored.
        let original_mtime = std::fs::metadata(&user).unwrap().modified().unwrap();
        std::fs::write(&user, r#"{ "historian": { "temperature": 0.2 } }"#).unwrap();
        filetime::set_file_mtime(&user, filetime::FileTime::from_system_time(original_mtime))
            .unwrap();
        let unchanged = cache.effective_for_paths(&user, &project);
        assert_eq!(unchanged.historian_temperature, Some(0.1));

        // Once mtime changes, the cache reloads and picks up the new user-tier value.
        let newer = filetime::FileTime::from_unix_time(
            original_mtime
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs() as i64
                + 2,
            0,
        );
        filetime::set_file_mtime(&user, newer).unwrap();
        let reloaded = cache.effective_for_paths(&user, &project);
        assert_eq!(reloaded.historian_temperature, Some(0.2));
    }
}

#[cfg(test)]
mod config_file_location_tests {
    use super::*;

    fn user_tier_temperature(path: &Path) -> Option<f64> {
        let project = tempfile::tempdir().unwrap();
        ConfigCache::default()
            .effective_for_paths(path, project.path())
            .historian_temperature
    }

    #[test]
    fn a_config_with_a_byte_order_mark_is_read_not_replaced_by_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("magic-context.jsonc");
        std::fs::write(
            &path,
            "\u{feff}{ // user tier\n \"historian\": { \"temperature\": 0.3 } }",
        )
        .unwrap();
        assert_eq!(user_tier_temperature(&path), Some(0.3));
    }

    #[test]
    fn a_json_config_is_read_when_no_jsonc_exists_and_jsonc_wins_when_both_do() {
        let home = tempfile::tempdir().unwrap();
        let cortexkit = home.path().join(".config").join("cortexkit");
        std::fs::create_dir_all(&cortexkit).unwrap();
        let json = cortexkit.join("magic-context.json");
        std::fs::write(&json, r#"{ "historian": { "temperature": 0.4 } }"#).unwrap();
        let chosen = user_config_path_from(None, Some(home.path().to_path_buf()));
        assert_eq!(chosen, json);
        assert_eq!(user_tier_temperature(&chosen), Some(0.4));

        let jsonc = cortexkit.join("magic-context.jsonc");
        std::fs::write(&jsonc, r#"{ "historian": { "temperature": 0.5 } }"#).unwrap();
        assert_eq!(
            user_config_path_from(None, Some(home.path().to_path_buf())),
            jsonc
        );

        // The project tier follows the same rule.
        let project = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(project.path().join(".cortexkit")).unwrap();
        std::fs::write(
            project.path().join(".cortexkit/magic-context.json"),
            r#"{ "memory": { "enabled": false } }"#,
        )
        .unwrap();
        let effective = ConfigCache::default()
            .effective_for_paths(&home.path().join("absent.jsonc"), project.path());
        assert!(!effective.memory_enabled);
    }

    #[test]
    fn a_relative_or_empty_xdg_config_home_is_ignored_like_the_host_ignores_it() {
        let home = PathBuf::from("/home/someone");
        let expected = home
            .join(".config")
            .join("cortexkit")
            .join("magic-context.jsonc");
        for xdg in ["", "relative/config", "."] {
            assert_eq!(
                user_config_path_from(Some(xdg.into()), Some(home.clone())),
                expected,
                "XDG_CONFIG_HOME={xdg:?}"
            );
        }
        assert_eq!(
            user_config_path_from(Some("/etc/xdg".into()), Some(home)),
            PathBuf::from("/etc/xdg/cortexkit/magic-context.jsonc")
        );
    }
    /// With `HOME` empty (or unset, as it usually is on Windows) the paths must still be
    /// under the user's real home, not relative to whatever directory the module started
    /// in. Runs in a child process so changing the environment cannot race other tests.
    #[test]
    fn an_empty_home_falls_back_to_the_platform_home_not_the_current_directory() {
        const CHILD: &str = "MC_TEST_EMPTY_HOME_CHILD";
        if std::env::var_os(CHILD).is_some() {
            let home = user_home_dir().expect("the platform knows this user's home");
            assert!(home.is_absolute(), "{home:?}");
            assert!(user_config_path().is_absolute(), "{:?}", user_config_path());
            let context_db = crate::host_store::resolve_context_db_path();
            assert!(context_db.is_absolute(), "{context_db:?}");
            return;
        }
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "config::config_file_location_tests::an_empty_home_falls_back_to_the_platform_home_not_the_current_directory",
                "--test-threads=1",
            ])
            .env(CHILD, "1")
            .env("HOME", "")
            .env_remove("XDG_CONFIG_HOME")
            .env_remove("XDG_DATA_HOME")
            .env_remove("MAGIC_CONTEXT_STORAGE_DIR")
            .env_remove("MAGIC_CONTEXT_TEST_DATA_DIR")
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            output.status.success() && stdout.contains("1 passed"),
            "{stdout}\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
