//! Magic Context's configuration, read the way the plugin reads it.
//!
//! Two files: the user's (`magic-context.jsonc` in `$XDG_CONFIG_HOME/cortexkit`,
//! else `~/.config/cortexkit`) and the project's (`.cortexkit/magic-context.jsonc`
//! in the project folder). Both may be JSON with comments.
//!
//! A project file comes with a cloned repository, so it may not make a session
//! spend more or send private text somewhere else. The plugin's trust rules
//! (`config/project-security.ts`) apply here unchanged:
//! - a project may raise the execute threshold and `protected_tokens`, never
//!   lower them, and may only raise a token threshold the user already set;
//! - `{env:…}` and `{file:…}` are expanded in the user file only;
//! - where text is embedded (provider, endpoint, query wording) is the user's
//!   choice alone.
//!
//! Each file is re-read when its modification time changes, so an edit
//! applies from the session's next pass without a restart.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use serde_json::Value;

use crate::embedding;
use crate::pass::Settings;

/// The highest execute threshold any setting can reach, as the plugin caps
/// it: above it too little room is left to act before the window fills.
const MAX_EXECUTE_THRESHOLD_PERCENTAGE: f64 = 90.0;
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
}

#[derive(Default)]
struct Cached {
    modified: Option<SystemTime>,
    value: Option<Value>,
}

/// Reads the two files, keeping each parsed copy until the file changes.
pub struct Loader {
    user_path: PathBuf,
    cache: Mutex<HashMap<PathBuf, Cached>>,
}

impl Loader {
    /// The user file chosen the way the plugin chooses it.
    pub fn from_environment() -> Self {
        Self::with_user_path(user_config_path(
            std::env::var_os("XDG_CONFIG_HOME"),
            home_dir(),
        ))
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

    fn read(&self, path: &Path) -> Option<Value> {
        let modified = fs::metadata(path).and_then(|meta| meta.modified()).ok();
        let mut cache = self.cache.lock().expect("config cache");
        let entry = cache.entry(path.to_path_buf()).or_default();
        if entry.modified != modified || (modified.is_some() && entry.value.is_none()) {
            entry.modified = modified;
            entry.value =
                fs::read_to_string(path)
                    .ok()
                    .and_then(|raw| match parse_config_text(&raw) {
                        Ok(value) => Some(value),
                        Err(error) => {
                            eprintln!(
                                "ck-mc: {}: {error}; using defaults for this file",
                                path.display()
                            );
                            None
                        }
                    });
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
    let mut settings = Settings {
        execute_threshold_percentage: execute_threshold(user, project, model_key, usable),
        ..Settings::default()
    };

    let mut reasoning: Option<Value> = None;
    for tier in [user, project] {
        if let Some(value) = tier.get("keep_reasoning_tokens") {
            let valid = |value: &Value| value.as_u64().is_some_and(|n| n <= 1_000_000);
            let is_valid =
                valid(value) || value.as_object().is_some_and(|map| map.values().all(valid));
            if !is_valid {
                continue;
            }
            match (&mut reasoning, value) {
                (Some(Value::Object(existing)), Value::Object(overrides)) => {
                    existing.extend(overrides.clone());
                }
                _ => reasoning = Some(value.clone()),
            }
        }
    }
    settings.keep_reasoning_tokens = match reasoning {
        Some(Value::Object(map)) => model_value(&map, model_key)
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_KEEP_REASONING_TOKENS),
        Some(value) => value.as_u64().unwrap_or(DEFAULT_KEEP_REASONING_TOKENS),
        None => DEFAULT_KEEP_REASONING_TOKENS,
    };

    let protected_tokens = |tier: &Value| {
        tier.get("protected_tokens")
            .and_then(Value::as_u64)
            .filter(|tokens| (4_000..=1_000_000).contains(tokens))
    };
    settings.protected_tokens = match (protected_tokens(user), protected_tokens(project)) {
        (user, Some(project)) if user.is_none_or(|user| project >= user) => Some(project),
        (user, _) => user,
    };

    for tier in [user, project] {
        if let Some(map) = tier.get("protected_tools").and_then(Value::as_object) {
            for (name, count) in map {
                if let Some(count) = count.as_u64() {
                    settings
                        .protected_tools
                        .insert(name.trim().to_lowercase(), count);
                }
            }
        }
        if let Some(share) = number_at(tier, "/history_budget_percentage") {
            settings.history_budget_percentage = share.clamp(0.05, 0.5);
        }
        if let Some(enabled) = tier.pointer("/memory/enabled").and_then(Value::as_bool) {
            settings.memory_enabled = enabled;
        }
        if let Some(budget) = number_at(tier, "/memory/injection_budget_tokens") {
            settings.memory_budget_tokens = budget.max(1.0) as u64;
        }
    }
    // The deprecated key still counts when the user never set the new one.
    if user.pointer("/memory/injection_budget_tokens").is_none() {
        if let Some(budget) = number_at(user, "/memory/budget_tokens") {
            settings.memory_budget_tokens = budget.max(1.0) as u64;
        }
    }
    if let Some(budget) = number_at(user, "/memory/user_profile_budget_tokens") {
        settings.profile_budget_tokens = budget.max(1.0) as u64;
    }
    settings.git_commits_enabled = project
        .pointer("/memory/git_commit_indexing/enabled")
        .and_then(Value::as_bool)
        .or_else(|| {
            user.pointer("/memory/git_commit_indexing/enabled")
                .and_then(Value::as_bool)
        })
        .unwrap_or(false);
    settings.embedding = embedding::Provider::from_tiers(user, project, user_path);
    settings
}

/// The execute threshold for one model, as a percentage of the usable window.
///
/// A token threshold, when one applies to the model, wins over every
/// percentage. A project may only raise either kind, and may not add a token
/// threshold where the user set none: a cloned repository must not make the
/// session summarize earlier, and so spend more.
fn execute_threshold(user: &Value, project: &Value, model_key: &str, usable: u64) -> f64 {
    let tokens = |tier: &Value| -> Option<f64> {
        let map = tier.get("execute_threshold_tokens")?.as_object()?;
        model_value(map, model_key)?
            .as_f64()
            .filter(|tokens| tokens.is_finite() && *tokens > 0.0)
    };
    if usable > 0 {
        if let Some(user_tokens) = tokens(user) {
            let chosen = tokens(project).map_or(user_tokens, |project| project.max(user_tokens));
            let cap = usable as f64 * MAX_EXECUTE_THRESHOLD_PERCENTAGE / 100.0;
            return (chosen.min(cap) / usable as f64 * 100.0).min(MAX_EXECUTE_THRESHOLD_PERCENTAGE);
        }
    }
    let percentage = |tier: &Value, fallback: f64| -> Option<f64> {
        let value = tier.get("execute_threshold_percentage")?;
        let found = match value {
            Value::Object(map) => model_value(map, model_key).and_then(Value::as_f64),
            other => other.as_f64(),
        }
        .unwrap_or(fallback);
        Some(if found.is_finite() && found >= 0.0 {
            found
        } else {
            fallback
        })
    };
    let user_value = percentage(user, DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE)
        .unwrap_or(DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE);
    let chosen =
        percentage(project, user_value).map_or(user_value, |project| project.max(user_value));
    chosen.min(MAX_EXECUTE_THRESHOLD_PERCENTAGE)
}

/// A per-model setting's value for `model_key`, falling back to `default`.
fn model_value<'a>(map: &'a serde_json::Map<String, Value>, model_key: &str) -> Option<&'a Value> {
    model_key_lookup_order(model_key)
        .iter()
        .find_map(|key| map.get(key))
        .or_else(|| map.get("default"))
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

fn number_at(value: &Value, pointer: &str) -> Option<f64> {
    value
        .pointer(pointer)
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
}

/// `{env:NAME}` and `{file:path}` in every string of the user file. A relative
/// file path is read from the user file's folder, `~/` from the home folder;
/// a missing variable or file becomes empty text, as in the plugin.
fn expand_user(mut value: Value, user_path: &Path) -> Value {
    match &mut value {
        Value::String(text) if text.contains('{') => {
            let env = regex::Regex::new(r"\{env:([^}]*)\}").expect("env pattern");
            let file = regex::Regex::new(r"\{file:([^}]*)\}").expect("file pattern");
            let expanded = env.replace_all(text, |caps: &regex::Captures<'_>| {
                std::env::var(caps[1].trim()).unwrap_or_default()
            });
            let expanded = file.replace_all(&expanded, |caps: &regex::Captures<'_>| {
                let name = caps[1].trim();
                let path = match name.strip_prefix("~/") {
                    Some(rest) => home_dir().unwrap_or_default().join(rest),
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
                *entry = expand_user(entry.take(), user_path);
            }
        }
        Value::Array(list) => {
            for entry in list {
                *entry = expand_user(entry.take(), user_path);
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

/// One file's text as JSON: a leading byte-order mark, comments and trailing
/// commas are allowed.
fn parse_config_text(raw: &str) -> Result<Value, serde_json::Error> {
    let raw = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    serde_json::from_str(&strip_jsonc(raw))
}

/// Remove `//` and `/* */` comments and trailing commas, leaving string
/// literals untouched.
fn strip_jsonc(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    let mut in_string = false;
    let mut escaped = false;
    let skip_comment = |chars: &[char], mut k: usize| -> Option<usize> {
        match (chars.get(k), chars.get(k + 1)) {
            (Some('/'), Some('/')) => {
                while k < chars.len() && chars[k] != '\n' {
                    k += 1;
                }
                Some(k)
            }
            (Some('/'), Some('*')) => {
                k += 2;
                while k + 1 < chars.len() && !(chars[k] == '*' && chars[k + 1] == '/') {
                    k += 1;
                }
                Some((k + 2).min(chars.len()))
            }
            _ => None,
        }
    };
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
        if let Some(next) = skip_comment(&chars, i) {
            i = next;
            continue;
        }
        if c == ',' {
            let mut k = i + 1;
            loop {
                while k < chars.len() && chars[k].is_whitespace() {
                    k += 1;
                }
                match skip_comment(&chars, k) {
                    Some(next) => k = next,
                    None => break,
                }
            }
            if matches!(chars.get(k), Some('}' | ']')) {
                i += 1;
                continue;
            }
        }
        out.push(c);
        i += 1;
    }
    out
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
mod tests {
    use super::*;
    use serde_json::json;

    const OPUS: &str = "anthropic/claude-opus-5-5";

    #[test]
    fn comments_and_trailing_commas_parse() {
        let parsed = parse_config_text(
            "\u{feff}{\n // note\n \"a\": \"x // not a comment\", /* block */\n \"b\": [1, 2,],\n}",
        )
        .unwrap();
        assert_eq!(parsed, json!({"a": "x // not a comment", "b": [1, 2]}));
    }

    #[test]
    fn a_project_only_raises_the_percentage_threshold() {
        let lower = resolve_for_test(
            json!({"execute_threshold_percentage": 70}),
            json!({"execute_threshold_percentage": 50}),
            OPUS,
            1_000,
        );
        assert_eq!(lower.execute_threshold_percentage, 70.0);
        let higher = resolve_for_test(
            json!({"execute_threshold_percentage": {"claude-opus-5": 60, "default": 40}}),
            json!({"execute_threshold_percentage": 80}),
            OPUS,
            1_000,
        );
        assert_eq!(higher.execute_threshold_percentage, 80.0);
        let capped = resolve_for_test(
            json!({"execute_threshold_percentage": 99}),
            json!({}),
            OPUS,
            1_000,
        );
        assert_eq!(capped.execute_threshold_percentage, 90.0);
    }

    #[test]
    fn a_token_threshold_wins_and_a_project_cannot_add_one() {
        let user = resolve_for_test(
            json!({"execute_threshold_percentage": 80, "execute_threshold_tokens": {"claude-opus-5-5": 700}}),
            json!({}),
            OPUS,
            1_000,
        );
        assert_eq!(user.execute_threshold_percentage, 70.0);
        let added = resolve_for_test(
            json!({}),
            json!({"execute_threshold_tokens": {"default": 100}}),
            OPUS,
            1_000,
        );
        assert_eq!(added.execute_threshold_percentage, 65.0);
        let raised = resolve_for_test(
            json!({"execute_threshold_tokens": {"default": 600}}),
            json!({"execute_threshold_tokens": {"default": 500}}),
            OPUS,
            1_000,
        );
        assert_eq!(raised.execute_threshold_percentage, 60.0);
    }

    #[test]
    fn reasoning_budgets_merge_per_model() {
        let settings = resolve_for_test(
            json!({"keep_reasoning_tokens": {"openai/*": 1, "default": 2_000}}),
            json!({"keep_reasoning_tokens": {"gpt-6.1": 3_000}}),
            "openai-codex/gpt-6.1-sol",
            1_000,
        );
        assert_eq!(settings.keep_reasoning_tokens, 3_000);
        let fallback =
            resolve_for_test(json!({"keep_reasoning_tokens": 5}), json!({}), OPUS, 1_000);
        assert_eq!(fallback.keep_reasoning_tokens, 5);
    }

    #[test]
    fn a_project_only_raises_protected_tokens() {
        let lowered = resolve_for_test(
            json!({"protected_tokens": 30_000}),
            json!({"protected_tokens": 10_000}),
            OPUS,
            1_000,
        );
        assert_eq!(lowered.protected_tokens, Some(30_000));
        let raised = resolve_for_test(json!({}), json!({"protected_tokens": 50_000}), OPUS, 1_000);
        assert_eq!(raised.protected_tokens, Some(50_000));
    }

    #[test]
    fn user_strings_expand_and_project_strings_stay_literal() {
        let folder = std::env::temp_dir().join(format!("ck-mc-config-{}", std::process::id()));
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("key"), "secret\n").unwrap();
        let user_path = folder.join("magic-context.jsonc");
        let expanded = expand_user(json!({"embedding": {"api_key": "{file:key}"}}), &user_path);
        assert_eq!(expanded["embedding"]["api_key"], "secret");
        fs::write(
            &user_path,
            r#"{"embedding": {"provider": "openai-compatible", "endpoint": "https://e.invalid/v1", "model": "m", "api_key": "{file:key}"}}"#,
        )
        .unwrap();
        let project = folder.join("project");
        fs::create_dir_all(project.join(".cortexkit")).unwrap();
        fs::write(
            project.join(".cortexkit/magic-context.jsonc"),
            r#"{"embedding": {"endpoint": "https://evil.invalid", "api_key": "{file:key}"}}"#,
        )
        .unwrap();
        let settings = Loader::with_user_path(user_path).resolve(Some(&project), OPUS, 1_000);
        let provider = settings.embedding.expect("provider");
        assert_eq!(provider.endpoint(), "https://e.invalid/v1");
        assert_eq!(provider.api_key_for_test(), Some("{file:key}"));
        fs::remove_dir_all(folder).ok();
    }
}
