//! Magic Context's configuration, read the way the plugin reads it.
//!
//! Two files: the user's (`MAGIC_CONTEXT_CONFIG_PATH`, else `magic-context.jsonc` in `$XDG_CONFIG_HOME/cortexkit`,
//! else `~/.config/cortexkit`) and the project's (`.cortexkit/magic-context.jsonc`
//! in the project folder). Both may be JSON with comments.
//!
//! A project file comes with a cloned repository, so it may not make a session
//! spend more or send private text somewhere else. The plugin's trust rules
//! (`config/project-security.ts`) apply here, with a stricter resolved-value
//! floor so more-specific project keys cannot lower a user's threshold:
//! - a project may raise the execute threshold and `protected_tokens`, never
//!   lower them, and may only raise a token threshold the user already set;
//! - `{env:…}` and `{file:…}` are expanded in the user file only;
//! - where text is embedded (provider, endpoint, query wording) is the user's
//!   choice alone.
//!
//! Each file is re-read when its modification time changes, so an edit
//! applies from the session's next pass without a restart.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use serde_json::Value;
use sha2::{Digest, Sha256};

mod jsonc;

use crate::embedding;
use crate::pass::Settings;

/// The highest execute threshold any setting can reach, as the plugin caps
/// it: above it too little room is left to act before the window fills.
const MAX_EXECUTE_THRESHOLD_PERCENTAGE: f64 = 90.0;
/// The lowest execute threshold the schema accepts.
const MIN_EXECUTE_THRESHOLD_PERCENTAGE: f64 = 20.0;
/// The range the schema accepts for a token threshold.
const MIN_THRESHOLD_TOKENS: f64 = 5_000.0;
const MAX_THRESHOLD_TOKENS: f64 = 2_000_000.0;
const DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE: f64 = 65.0;
const DEFAULT_KEEP_REASONING_TOKENS: u64 = 10_000;

/// Where settings come from: the configuration files, or (in tests) fixed
/// values.
pub enum Config {
    Fixed(Box<Settings>),
    Files(Loader),
}

impl From<Settings> for Config {
    fn from(settings: Settings) -> Self {
        Self::Fixed(Box::new(settings))
    }
}

impl Config {
    /// The settings for one session: its project folder, its model (as
    /// `provider/model`) and its usable window, which token thresholds are
    /// measured against.
    pub fn resolve(&self, project_root: Option<&str>, model_key: &str, usable: u64) -> Settings {
        match self {
            Self::Fixed(settings) => settings.as_ref().clone(),
            Self::Files(loader) => loader.resolve(project_root.map(Path::new), model_key, usable),
        }
    }

    /// The settings `tool.catalog` answers with (see [`Loader::catalog_config`]).
    /// Fixed settings answer with the files' defaults.
    pub fn catalog_config(&self, project_root: Option<&str>) -> crate::catalog::CatalogConfig {
        match self {
            Self::Fixed(_) => catalog_config(None, None, Path::new("")),
            Self::Files(loader) => loader.catalog_config(project_root.map(Path::new)),
        }
    }

    /// The dreamer's settings, or `None` when the person switched it off
    /// (`dreamer.disable`). Fixed settings run it on the defaults.
    pub fn dreamer(&self) -> Option<crate::dreamer::engine::Settings> {
        match self {
            Self::Fixed(_) => Some(crate::dreamer::engine::Settings::default()),
            Self::Files(loader) => dreamer_settings(
                loader
                    .read(&loader.user_path)
                    .map(|value| expand_user(value, &loader.user_path))
                    .as_ref(),
            ),
        }
    }
}

/// The dreamer's settings from the user's file, the same keys the 0.49
/// dreamer read: `dreamer.disable`, `dreamer.maxTokens` and each task's
/// `dreamer.tasks.<kind>.schedule`. Only the user's file is read: a
/// project's file can't make the person's machine spend more.
fn dreamer_settings(user: Option<&Value>) -> Option<crate::dreamer::engine::Settings> {
    let dreamer = user.and_then(|user| user.get("dreamer"));
    if dreamer
        .and_then(|dreamer| dreamer.get("disable"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }
    let mut settings = crate::dreamer::engine::Settings::default();
    if let Some(budget) = dreamer
        .and_then(|dreamer| dreamer.get("maxTokens"))
        .and_then(integer)
        .filter(|budget| *budget > 0)
    {
        settings.budget_tokens = budget;
    }
    for (kind, task) in dreamer
        .and_then(|dreamer| dreamer.get("tasks"))
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
    {
        if let Some(schedule) = task.get("schedule").and_then(Value::as_str) {
            let schedule = schedule.trim();
            if schedule.is_empty() || crate::dreamer::cron::Cron::parse(schedule).is_some() {
                settings.schedules.insert(kind.clone(), schedule.to_owned());
            } else {
                tracing::info!("ck-mc: dreamer.tasks.{kind}.schedule {schedule:?} is not a five-field cron expression; the default applies");
            }
        }
    }
    Some(settings)
}

#[derive(Default)]
struct Cached {
    initialized: bool,
    modified: Option<SystemTime>,
    value: Option<Value>,
    warned: HashSet<String>,
}

/// Reads the two files, keeping each parsed copy until the file changes.
pub struct Loader {
    user_path: PathBuf,
    cache: Mutex<HashMap<PathBuf, Cached>>,
}

impl Loader {
    /// The user file chosen the way the plugin chooses it.
    pub fn from_environment() -> Self {
        Self::from_paths(
            std::env::var_os("MAGIC_CONTEXT_CONFIG_PATH"),
            std::env::var_os("XDG_CONFIG_HOME"),
            home_dir(),
        )
        .expect("invalid Magic Context user config path")
    }

    fn from_paths(
        explicit: Option<std::ffi::OsString>,
        xdg: Option<std::ffi::OsString>,
        home: Option<PathBuf>,
    ) -> Result<Self, &'static str> {
        let path = match explicit {
            Some(path) => {
                let path = PathBuf::from(
                    path.to_str()
                        .ok_or("MAGIC_CONTEXT_CONFIG_PATH must be UTF-8")?
                        .trim(),
                );
                if !path.is_absolute() {
                    return Err("MAGIC_CONTEXT_CONFIG_PATH must be an absolute path to a user config file (not blank)");
                }
                if !path.exists() {
                    tracing::info!("ck-mc: MAGIC_CONTEXT_CONFIG_PATH file not found: {}; continuing without user config (no XDG or legacy fallback)", path.display());
                }
                path
            }
            None => user_config_path(xdg, home),
        };
        Ok(Self::with_user_path(path))
    }

    pub fn with_user_path(user_path: PathBuf) -> Self {
        Self {
            user_path,
            cache: Mutex::new(HashMap::new()),
        }
    }

    pub fn resolve(&self, project_root: Option<&Path>, model_key: &str, usable: u64) -> Settings {
        let user = self
            .read(&self.user_path)
            .map(|value| expand_user(value, &self.user_path));
        let project = project_root
            .map(|root| detect_config_file(&root.join(".cortexkit")))
            .and_then(|path| self.read(&path));
        resolve_tiers(
            user.as_ref(),
            project.as_ref(),
            model_key,
            usable,
            &self.user_path,
        )
    }

    /// The settings `tool.catalog` answers with, for a project folder or, on
    /// an unscoped preflight, the user's file alone.
    pub fn catalog_config(&self, project_root: Option<&Path>) -> crate::catalog::CatalogConfig {
        let user = self
            .read(&self.user_path)
            .map(|value| expand_user(value, &self.user_path));
        let project = project_root
            .map(|root| detect_config_file(&root.join(".cortexkit")))
            .and_then(|path| self.read(&path));
        catalog_config(user.as_ref(), project.as_ref(), &self.user_path)
    }

    fn read(&self, path: &Path) -> Option<Value> {
        self.read_with_warning(path, &mut |warning| tracing::info!("ck-mc: {warning}"))
    }

    fn read_with_warning(&self, path: &Path, warn: &mut dyn FnMut(String)) -> Option<Value> {
        let modified = fs::metadata(path).and_then(|meta| meta.modified()).ok();
        let mut cache = self.cache.lock().expect("config cache");
        let entry = cache.entry(path.to_path_buf()).or_default();
        if !entry.initialized || entry.modified != modified {
            let initial = !entry.initialized;
            entry.initialized = true;
            entry.modified = modified;
            match fs::read_to_string(path) {
                Ok(raw) => {
                    let mut parsed = jsonc::parse(&raw);
                    if !parsed.value.is_object() {
                        if !initial && parsed.issue.is_none() {
                            parsed.issue = Some("1:1: expected an object".to_owned());
                        }
                        parsed.value = Value::Object(serde_json::Map::new());
                    }
                    if let Some(issue) = parsed.issue {
                        let digest = format!("{:x}", Sha256::digest(raw.as_bytes()));
                        if entry.warned.insert(digest) {
                            let recovery = if !initial {
                                "keeping the previous configuration for this file."
                            } else if parsed.value.as_object().is_some_and(|map| !map.is_empty()) {
                                "recovered values were applied, but the file must be fixed."
                            } else {
                                "using defaults for this file."
                            };
                            warn(format!("{}:{issue}; {recovery}", path.display()));
                        }
                        if initial {
                            entry.value = Some(parsed.value);
                        }
                    } else {
                        entry.value = Some(parsed.value);
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => entry.value = None,
                Err(error) => {
                    if entry.warned.insert(error.to_string()) {
                        warn(format!("{}: failed to read config: {error}; keeping the previous configuration for this file.", path.display()));
                    }
                }
            }
        }
        entry.value.clone()
    }
}

/// Merge the two tiers into one session's settings.
fn resolve_tiers(
    user: Option<&Value>,
    project: Option<&Value>,
    model_key: &str,
    usable: u64,
    user_path: &Path,
) -> Settings {
    let empty = Value::Null;
    let user = user.unwrap_or(&empty);
    let project = project.unwrap_or(&empty);
    let (execute_threshold_percentage, execute_threshold_source) =
        execute_threshold(user, project, model_key, usable);
    let mut settings = Settings {
        execute_threshold_percentage,
        execute_threshold_source,
        ..Settings::default()
    };

    let mut reasoning: Option<Value> = None;
    for tier in [user, project] {
        if let Some(value) = tier.get("keep_reasoning_tokens") {
            let valid = |value: &Value| integer(value).is_some_and(|n| n <= 1_000_000);
            let value = match value {
                Value::Object(map) => Value::Object(
                    map.iter()
                        .filter(|(_, value)| valid(value))
                        .map(|(key, value)| (key.clone(), value.clone()))
                        .collect(),
                ),
                value if valid(value) => value.clone(),
                _ => continue,
            };
            match (&mut reasoning, &value) {
                (Some(Value::Object(existing)), Value::Object(overrides)) => {
                    existing.extend(overrides.clone());
                }
                _ => reasoning = Some(value),
            }
        }
    }
    settings.keep_reasoning_tokens = match reasoning {
        Some(Value::Object(map)) => reasoning_value(&map, model_key)
            .and_then(integer)
            .unwrap_or(DEFAULT_KEEP_REASONING_TOKENS),
        Some(value) => integer(&value).unwrap_or(DEFAULT_KEEP_REASONING_TOKENS),
        None => DEFAULT_KEEP_REASONING_TOKENS,
    };

    let protected_tokens = |tier: &Value| {
        tier.get("protected_tokens")
            .and_then(integer)
            .filter(|tokens| (4_000..=1_000_000).contains(tokens))
    };
    let user_protected = protected_tokens(user);
    let project_protected = protected_tokens(project);
    // The derived floor depends on the runner's usable window, not the file.
    // Keep the tiers separate until that geometry is available here.
    settings.protected_tokens = match project_protected {
        Some(project)
            if project
                >= user_protected
                    .unwrap_or_else(|| crate::lanes::default_protected_tokens(usable)) =>
        {
            Some(project)
        }
        _ => user_protected,
    };

    for tier in [user, project] {
        if let Some(map) = tier.get("protected_tools").and_then(Value::as_object) {
            for (name, count) in map {
                if let Some(count) = integer(count) {
                    settings
                        .protected_tools
                        .insert(crate::lanes::normalize_tool_name(name), count);
                }
            }
        }
        if let Some(share) = in_range(tier, "/history_budget_percentage", 0.05, 0.5) {
            settings.history_budget_percentage = share;
        }
        if let Some(enabled) = tier.pointer("/memory/enabled").and_then(Value::as_bool) {
            settings.memory_enabled = enabled;
        }
        if let Some(promote) = tier
            .pointer("/memory/auto_promote")
            .and_then(Value::as_bool)
        {
            settings.auto_promote = promote;
        }
        if let Some(budget) = in_range(tier, "/memory/injection_budget_tokens", 500.0, 20_000.0) {
            settings.memory_budget_tokens = budget as u64;
        }
        if let Some(enabled) = tier.get("temporal_awareness").and_then(Value::as_bool) {
            settings.temporal_awareness = enabled;
        }
        // A project may turn the mural on or off, as in the plugin: it only
        // changes how the project's own memories are shown.
        if let Some(enabled) = tier.pointer("/mural/enabled").and_then(Value::as_bool) {
            settings.mural_enabled = enabled;
        }
        let auto = &mut settings.auto_search;
        if let Some(enabled) = tier
            .pointer("/memory/auto_search/enabled")
            .and_then(Value::as_bool)
        {
            auto.enabled = enabled;
        }
        if let Some(threshold) = in_range(tier, "/memory/auto_search/score_threshold", 0.3, 0.95) {
            auto.score_threshold = threshold;
        }
        if let Some(chars) = in_range(tier, "/memory/auto_search/min_prompt_chars", 5.0, 500.0) {
            auto.min_prompt_chars = chars as usize;
        }
    }
    settings.git_commits_enabled = project
        .pointer("/memory/git_commit_indexing/enabled")
        .and_then(Value::as_bool)
        .or_else(|| {
            user.pointer("/memory/git_commit_indexing/enabled")
                .and_then(Value::as_bool)
        })
        .unwrap_or(false);
    // The plugin drops an out-of-range value, so the other tier or the
    // default applies.
    for tier in [user, project] {
        if let Some(days) = in_range(tier, "/memory/git_commit_indexing/since_days", 7.0, 3650.0) {
            settings.git_since_days = days as u64;
        }
        if let Some(commits) = in_range(
            tier,
            "/memory/git_commit_indexing/max_commits",
            100.0,
            20000.0,
        ) {
            settings.git_max_commits = commits as u64;
        }
    }
    settings.embedding = embedding::Provider::from_tiers(user, project, user_path);
    settings.rerank = crate::search::rerank::Reranker::from_tiers(user, project);
    settings.caveman = caveman(user, project);
    settings.commit_clusters = commit_clusters(user, project);
    // Only the user sets the language; a project file cannot.
    settings.language = user
        .pointer("/language")
        .and_then(Value::as_str)
        .map(|language| language.trim().to_ascii_lowercase())
        .filter(|language| !language.is_empty());
    settings
}

/// `commit_cluster_trigger`: on unless the last tier that sets `enabled`
/// turns it off, with `min_clusters` (at least 1, default 3) from the last
/// tier that sets a valid one.
fn commit_clusters(user: &Value, project: &Value) -> Option<u64> {
    let mut enabled = true;
    let mut min = 3;
    for tier in [user, project] {
        if let Some(on) = tier
            .pointer("/commit_cluster_trigger/enabled")
            .and_then(Value::as_bool)
        {
            enabled = on;
        }
        if let Some(clusters) = tier
            .pointer("/commit_cluster_trigger/min_clusters")
            .and_then(integer)
            .filter(|clusters| *clusters >= 1)
        {
            min = clusters;
        }
    }
    enabled.then_some(min)
}

/// `caveman_text_compression`: on when the last tier that sets `enabled`
/// turns it on, with `min_chars` (100 to 10,000, default 500) from the last
/// tier that sets a valid one; an out-of-range value is ignored, as the
/// plugin's loader falls back to the default for an invalid leaf. The word rules follow the user-level `language`: English
/// when it is unset, `en`, `en-*` or not a known code (the values that give no
/// reply-language directive), as `cavemanWordRulesForLanguage` decides.
fn caveman(user: &Value, project: &Value) -> Option<crate::pass::Caveman> {
    let mut enabled = false;
    let mut min_chars = 500;
    for tier in [user, project] {
        if let Some(on) = tier
            .pointer("/caveman_text_compression/enabled")
            .and_then(Value::as_bool)
        {
            enabled = on;
        }
        if let Some(chars) = tier
            .pointer("/caveman_text_compression/min_chars")
            .and_then(integer)
            .filter(|chars| (100..=10_000).contains(chars))
        {
            min_chars = chars;
        }
    }
    if !enabled {
        return None;
    }
    let code = user
        .pointer("/language")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let english_word_rules = code == "en"
        || code.starts_with("en-")
        || crate::catalog::primary_language_directive(Some(&code)).is_empty();
    Some(crate::pass::Caveman {
        min_chars,
        english_word_rules,
    })
}

/// The catalog's settings from the two tiers, read as the plugin reads them.
/// Invalid entries are skipped, so a typo falls back to the default wording
/// rather than refusing every catalog. What the model is told about where
/// its text goes (tool descriptions, the guidance override) is the user's
/// choice alone; a project may pick the light or full wording.
fn catalog_config(
    user: Option<&Value>,
    project: Option<&Value>,
    user_path: &Path,
) -> crate::catalog::CatalogConfig {
    use crate::catalog::{CatalogConfig, Surface};

    let tiers = || [user, project].into_iter().flatten();
    let last_bool = |pointer: &str, default: bool| {
        tiers()
            .filter_map(|tier| tier.pointer(pointer).and_then(Value::as_bool))
            .next_back()
            .unwrap_or(default)
    };
    let surface = |value: &Value| match value.as_str() {
        Some("full") => Some(Surface::Full),
        Some("light") => Some(Surface::Light),
        _ => None,
    };
    let mut surface_default = Surface::Full;
    let mut surface_models = std::collections::BTreeMap::new();
    for tier in tiers() {
        if let Some(default) = tier.pointer("/prompt_surface/default").and_then(surface) {
            surface_default = default;
        }
        if let Some(models) = tier
            .pointer("/prompt_surface/models")
            .and_then(Value::as_object)
        {
            for (key, value) in models {
                if let (false, Some(surface)) = (key.trim().is_empty(), surface(value)) {
                    surface_models.insert(key.clone(), surface);
                }
            }
        }
    }
    let tool_descriptions = user
        .and_then(|user| user.pointer("/prompt_surface/tool_descriptions"))
        .and_then(Value::as_object)
        .map(|descriptions| {
            descriptions
                .iter()
                .filter(|(tool, _)| crate::catalog::definition().tool(tool).is_some())
                .filter_map(|(tool, text)| {
                    let text = text.as_str().filter(|text| !text.trim().is_empty())?;
                    Some((tool.clone(), text.to_owned()))
                })
                .collect()
        })
        .unwrap_or_default();
    CatalogConfig {
        // The module-only version does not run smart notes, the dreamer, or
        // the slash commands yet; see `crate::catalog`.
        smart_notes_enabled: false,
        user_commands: false,
        dreamer_runnable: false,
        compaction_enabled: user
            .and_then(|user| user.pointer("/compaction/enabled"))
            .and_then(Value::as_bool)
            .unwrap_or(true),
        memory_enabled: last_bool("/memory/enabled", true),
        temporal_awareness: last_bool("/temporal_awareness", true),
        caveman_text_compression: last_bool("/caveman_text_compression/enabled", false),
        language: user
            .and_then(|user| user.pointer("/language"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|language| !language.is_empty())
            .map(str::to_ascii_lowercase),
        surface_default,
        surface_models,
        guidance_override: user.and_then(|user| guidance_override(user, user_path)),
        tool_descriptions,
        disabled_tools: Vec::new(),
    }
}

/// The user's replacement for the primary guidance section: the file at
/// `prompt_surface.guidance_override_path` (relative to the user's config
/// file), else `prompt_surface.guidance_override_text`. A file that cannot be
/// read, is empty, or does not hold exactly one `## Magic Context` heading
/// is ignored with a warning, and the built-in guidance applies.
fn guidance_override(user: &Value, user_path: &Path) -> Option<String> {
    const MARKER: &str = "## Magic Context";
    let configured = user
        .pointer("/prompt_surface/guidance_override_path")
        .and_then(Value::as_str)
        .filter(|path| !path.is_empty());
    let Some(configured) = configured else {
        return user
            .pointer("/prompt_surface/guidance_override_text")
            .and_then(Value::as_str)
            .filter(|text| !text.trim().is_empty())
            .map(str::to_owned);
    };
    let path = Path::new(configured);
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        user_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(path)
    };
    let warn = |why: &str| {
        tracing::info!(
            "ck-mc: prompt_surface.guidance_override_path ({}) {why}; using built-in guidance",
            path.display()
        );
    };
    let content = match fs::read(&path) {
        Ok(bytes) if path.is_file() => String::from_utf8_lossy(&bytes).into_owned(),
        Ok(_) => {
            warn("is not a file");
            return None;
        }
        Err(error) => {
            warn(&format!("could not be read ({error})"));
            return None;
        }
    };
    if content.trim().is_empty() {
        warn("is empty");
        return None;
    }
    let markers = content
        .split('\n')
        .filter(|line| {
            let line = line.strip_suffix('\r').unwrap_or(line);
            line.strip_prefix(MARKER)
                .is_some_and(|rest| rest.bytes().all(|byte| matches!(byte, b' ' | b'\t')))
        })
        .count();
    if markers != 1 {
        warn(&format!(
            "must contain exactly one {MARKER:?} heading, found {markers}"
        ));
        return None;
    }
    Some(content)
}

/// The execute threshold for one model, as a percentage of the usable window.
///
/// A token threshold, when one applies to the model, wins over every
/// percentage. A project may only raise either kind, and may not add a token
/// threshold where the user set none: a cloned repository must not make the
/// session summarize earlier, and so spend more.
/// The session's execute threshold, as a percentage of the usable window,
/// and which setting decided it, in the names the apps' session metadata
/// uses: `model_tokens`, `model_percentage`, `user_percentage`,
/// `project_percentage` or `default`.
fn execute_threshold(
    user: &Value,
    project: &Value,
    model_key: &str,
    usable: u64,
) -> (f64, &'static str) {
    // A value outside the schema's range is dropped, as the plugin's loader
    // drops an invalid leaf: the lookup then falls through to the map's
    // `default` or to the tier below, never to a clamped value.
    let valid_tokens = |value: &Value| {
        value
            .as_f64()
            .filter(|tokens| (MIN_THRESHOLD_TOKENS..=MAX_THRESHOLD_TOKENS).contains(tokens))
    };
    let valid_percentage = |value: &Value| {
        value.as_f64().filter(|percentage| {
            (MIN_EXECUTE_THRESHOLD_PERCENTAGE..=MAX_EXECUTE_THRESHOLD_PERCENTAGE)
                .contains(percentage)
        })
    };
    let valid_map = |value: Option<&Value>,
                     valid: &dyn Fn(&Value) -> Option<f64>|
     -> serde_json::Map<String, Value> {
        value
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
            .filter(|(_, value)| valid(value).is_some())
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect()
    };
    let user_tokens = valid_map(user.get("execute_threshold_tokens"), &valid_tokens);
    if usable > 0 {
        if let Some(user_value) = model_value(&user_tokens, model_key).and_then(valid_tokens) {
            let project_tokens = valid_map(project.get("execute_threshold_tokens"), &valid_tokens);
            let merged = raised_threshold_map(&user_tokens, &project_tokens);
            let chosen = model_value(&merged, model_key)
                .and_then(valid_tokens)
                .unwrap_or(user_value)
                .max(user_value);
            let cap = usable as f64 * MAX_EXECUTE_THRESHOLD_PERCENTAGE / 100.0;
            return (
                (chosen.min(cap) / usable as f64 * 100.0).min(MAX_EXECUTE_THRESHOLD_PERCENTAGE),
                "model_tokens",
            );
        }
    }
    let mut user_percentages =
        valid_map(user.get("execute_threshold_percentage"), &valid_percentage);
    let model_matched = model_key_lookup_order(model_key)
        .iter()
        .any(|key| user_percentages.contains_key(key));
    let user_set = !user_percentages.is_empty()
        || user
            .get("execute_threshold_percentage")
            .and_then(valid_percentage)
            .is_some();
    let default = user
        .get("execute_threshold_percentage")
        .and_then(valid_percentage)
        .unwrap_or(DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE);
    user_percentages
        .entry("default")
        .or_insert_with(|| Value::from(default));
    let user_value = model_value(&user_percentages, model_key)
        .and_then(valid_percentage)
        .unwrap_or(default);
    let chosen = if let Some(scalar) = project
        .get("execute_threshold_percentage")
        .and_then(valid_percentage)
    {
        user_value.max(scalar)
    } else {
        let project_percentages = valid_map(
            project.get("execute_threshold_percentage"),
            &valid_percentage,
        );
        let merged = raised_threshold_map(&user_percentages, &project_percentages);
        // A new, more-specific project key must not bypass the user's resolved
        // floor, even if it passed the literal-key comparison above.
        model_value(&merged, model_key)
            .and_then(valid_percentage)
            .unwrap_or(user_value)
            .max(user_value)
    };
    let source = if chosen > user_value {
        "project_percentage"
    } else if model_matched {
        "model_percentage"
    } else if user_set {
        "user_percentage"
    } else {
        "default"
    };
    (chosen.min(MAX_EXECUTE_THRESHOLD_PERCENTAGE), source)
}

/// Merge already-validated threshold maps. A project default only replaces
/// the user default; model overrides retain their own baselines.
fn raised_threshold_map(
    user: &serde_json::Map<String, Value>,
    project: &serde_json::Map<String, Value>,
) -> serde_json::Map<String, Value> {
    let mut merged = user.clone();
    if let (Some(base), Some(value)) = (
        user.get("default").and_then(Value::as_f64),
        project.get("default").and_then(Value::as_f64),
    ) {
        if value > base {
            merged.insert("default".into(), Value::from(value));
        }
    }
    for (key, value) in project {
        if key == "default" {
            continue;
        }
        let base = user
            .get(key)
            .or_else(|| user.get("default"))
            .and_then(Value::as_f64);
        if base.is_some_and(|base| value.as_f64().is_some_and(|value| value > base)) {
            if value.as_f64() == merged.get("default").and_then(Value::as_f64) {
                merged.remove(key);
            } else {
                merged.insert(key.clone(), value.clone());
            }
        }
    }
    merged
}

/// A per-model setting's value for `model_key`, falling back to `default`.
fn model_value<'a>(map: &'a serde_json::Map<String, Value>, model_key: &str) -> Option<&'a Value> {
    model_key_lookup_order(model_key)
        .iter()
        .find_map(|key| map.get(key))
        .or_else(|| map.get("default"))
}

fn reasoning_value<'a>(
    map: &'a serde_json::Map<String, Value>,
    model_key: &str,
) -> Option<&'a Value> {
    let keys = model_key_lookup_order(model_key);
    keys.iter()
        .find_map(|key| map.get(key))
        .or_else(|| {
            let mut providers = Vec::new();
            for key in &keys {
                if let Some((provider, _)) = key.split_once('/') {
                    if !providers.contains(&provider) {
                        providers.push(provider);
                    }
                }
            }
            providers
                .into_iter()
                .find_map(|provider| map.get(&format!("{provider}/*")))
        })
        .or_else(|| map.get("default"))
}

/// JSON has one number type: an integral floating-point spelling is still
/// an integer, while fractional and negative values are not token counts.
pub(crate) fn integer(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| {
        value
            .as_f64()
            .filter(|number| {
                number.is_finite()
                    && *number >= 0.0
                    && number.fract() == 0.0
                    && *number < u64::MAX as f64
            })
            .map(|number| number as u64)
    })
}

/// The keys a per-model setting is looked up under, most specific first: the
/// provider's shared name, then the name the model was given, then its native
/// alias, each with the full model name before shorter ones. A shorter name
/// drops the last dash-separated part, so `claude-opus-5-5` also matches an
/// entry for `claude-opus-5`.
pub(crate) fn model_key_lookup_order(model_key: &str) -> Vec<String> {
    let slash = model_key.find('/');
    let provider = slash.map_or("", |at| &model_key[..at]);
    let canonical = match provider {
        "openai-codex" => "openai",
        "google-antigravity" => "google",
        "opencode-zen" => "opencode",
        other => other,
    };
    let native = match canonical {
        "openai" => "openai-codex",
        "google" => "google-antigravity",
        "opencode" => "opencode-zen",
        other => other,
    };
    let mut providers: Vec<&str> = Vec::new();
    for candidate in [canonical, provider, native] {
        if !candidate.is_empty() && !providers.contains(&candidate) {
            providers.push(candidate);
        }
    }
    let mut model = slash.map_or(model_key, |at| &model_key[at + 1..]);
    let mut keys = Vec::new();
    while !model.is_empty() {
        for provider in &providers {
            keys.push(format!("{provider}/{model}"));
        }
        keys.push(model.to_owned());
        match model.rfind('-') {
            Some(dash) if dash > 0 => model = &model[..dash],
            _ => break,
        }
    }
    keys
}

/// The number at `pointer` when it is within the schema's range. A value
/// outside it is dropped, as the plugin's loader drops an invalid leaf, so
/// the tier below or the default applies.
fn in_range(value: &Value, pointer: &str, min: f64, max: f64) -> Option<f64> {
    value
        .pointer(pointer)
        .and_then(Value::as_f64)
        .filter(|number| (min..=max).contains(number))
}

/// `{env:NAME}` and `{file:path}` in every string of the user file. A relative
/// file path is read from the user file's folder, `~/` from the home folder;
/// a missing variable or file becomes empty text, as in the plugin.
fn expand_user(value: Value, user_path: &Path) -> Value {
    expand_user_with(value, user_path, home_dir().as_deref(), &|name| {
        std::env::var(name).ok()
    })
}

fn expand_user_with(
    mut value: Value,
    user_path: &Path,
    home: Option<&Path>,
    env_value: &dyn Fn(&str) -> Option<String>,
) -> Value {
    match &mut value {
        Value::String(text) if text.contains('{') => {
            let env = regex::Regex::new(r"\{env:([^}]*)\}").expect("env pattern");
            let file = regex::Regex::new(r"\{file:([^}]*)\}").expect("file pattern");
            let expanded = env.replace_all(text, |caps: &regex::Captures<'_>| {
                env_value(caps[1].trim()).unwrap_or_default()
            });
            let expanded = file.replace_all(&expanded, |caps: &regex::Captures<'_>| {
                let name = caps[1].trim();
                let path = match name.strip_prefix("~/") {
                    Some(rest) => home.unwrap_or(Path::new("")).join(rest),
                    None => user_path.parent().unwrap_or(Path::new(".")).join(name),
                };
                fs::read_to_string(path)
                    .map(|content| content.trim().to_owned())
                    .unwrap_or_default()
            });
            *text = expanded.into_owned();
        }
        Value::Object(map) => {
            for entry in map.values_mut() {
                *entry = expand_user_with(entry.take(), user_path, home, env_value);
            }
        }
        Value::Array(list) => {
            for entry in list {
                *entry = expand_user_with(entry.take(), user_path, home, env_value);
            }
        }
        _ => {}
    }
    value
}

/// `XDG_CONFIG_HOME` counts only as an absolute path, as in the plugin;
/// otherwise `<home>/.config`.
fn user_config_path(xdg: Option<std::ffi::OsString>, home: Option<PathBuf>) -> PathBuf {
    let base = xdg
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| home.unwrap_or_else(|| PathBuf::from(".")).join(".config"));
    detect_config_file(&base.join("cortexkit"))
}

/// `magic-context.jsonc`, or `magic-context.json` when only that exists.
fn detect_config_file(folder: &Path) -> PathBuf {
    let jsonc = folder.join("magic-context.jsonc");
    if jsonc.exists() {
        return jsonc;
    }
    let json = folder.join("magic-context.json");
    if json.exists() {
        return json;
    }
    jsonc
}

/// The home folder the way Node's `os.homedir()` finds it, which is what the
/// plugin uses.
pub(crate) fn home_dir() -> Option<PathBuf> {
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

/// Values for tests: the user and project tiers as JSON.
#[cfg(test)]
pub(crate) fn resolve_for_test(
    user: Value,
    project: Value,
    model_key: &str,
    usable: u64,
) -> Settings {
    resolve_tiers(
        Some(&user),
        Some(&project),
        model_key,
        usable,
        Path::new("/nonexistent/magic-context.jsonc"),
    )
}

#[cfg(test)]
mod tests;
