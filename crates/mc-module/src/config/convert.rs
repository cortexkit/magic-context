//! The conversion of a 0.49 user settings file to the shape ck-mc declares
//! to the daemon (`assets/settings-schema.json`), as pointer edits.
//!
//! [`convert_0_49`] is pure: it reads the parsed file and says what to
//! change, and the one-time rewrite makes those changes to the file's text
//! ([`super::edit::apply`]). Every conversion keeps today's meaning:
//! - a reshaped setting is written in its new shape (`clock_note: false`
//!   becomes `"off"`, a number threshold becomes `{"default": n}`, and so on);
//! - a value ck-mc ignores today, so that the default applies, is removed,
//!   since the schema would refuse it and its absence means the same;
//! - a key outside the schema is removed: the 0.49 plugin's keys mean nothing
//!   to ck-mc, and the old file is saved before the rewrite.
//!
//! What can't be converted is left as written, with a note: a literal API key
//! (it belongs in the vault), and `{env:…}` or `{file:…}` inside a string
//! (the daemon's settings take values, not references to them). The daemon
//! refuses such a file until the person fixes it.
//!
//! Converting a converted file gives no edits.

use serde_json::{json, Map, Value};

use super::edit::{child, Edit};

/// The pattern a per-model key matches: `default`, a model name, or
/// `provider/model`, where the model part may hold further slashes, `@` and
/// `:` (OpenRouter, Vertex and local model names do).
pub(crate) const MODEL_KEY_PATTERN: &str = r"^(default|[^\s/]+(/\S+)?)$";

/// The dreamer tasks ck-mc runs, the keys `dreamer.tasks` holds.
pub(crate) const TASK_KINDS: [&str; 12] = [
    "classify-memories",
    "compress-cues",
    "curate",
    "curate-workspace",
    "lift-workspace",
    "maintain-docs",
    "map-memories",
    "reflect-events",
    "refresh-primers",
    "review-user-memories",
    "verify",
    "verify-broad",
];

/// Keys the 0.49 plugin read from the same file, by pointer, that ck-mc has
/// no use for. The list only shapes the note; every key outside the schema is
/// removed whether it is listed or not.
const PLUGIN_KEYS: &[&str] = &[
    "/$schema",
    "/agents",
    "/allow_home_project",
    "/auto_update",
    "/cache_ttl",
    "/clear_reasoning_age",
    "/dashboard",
    "/debug_rpc",
    "/enabled",
    "/experimental",
    "/fail_closed_blocking",
    "/historian",
    "/historian_timeout_ms",
    "/models",
    "/output_reserve",
    "/pi",
    "/profile",
    "/profiles",
    "/protected_tags",
    "/rust_background_enabled",
    "/rust_pipeline",
    "/rust_provider_preparation",
    "/shadow_embedding",
    "/signed_thinking_hold",
    "/smart_drops",
    "/smart_notes",
    "/sqlite",
    "/storage",
    "/subc",
    "/system_prompt_injection",
    "/toast_duration_ms",
    "/todowrite",
    "/transform_mode",
    "/dreamer/color",
    "/dreamer/description",
    "/dreamer/fallback_models",
    "/dreamer/inject_docs",
    "/dreamer/maxSteps",
    "/dreamer/mode",
    "/dreamer/model",
    "/dreamer/omp",
    "/dreamer/opencode",
    "/dreamer/permission",
    "/dreamer/pi",
    "/dreamer/prompt",
    "/dreamer/runner",
    "/dreamer/temperature",
    "/dreamer/tools",
    "/dreamer/top_p",
    "/dreamer/variant",
    "/dreamer/tasks/evaluate-smart-notes",
    "/dreamer/tasks/promote-primers",
    "/dreamer/tasks/retrospective",
    "/embedding/local_dtype",
    "/embedding/local_runtime",
    "/memory/retrieval_count_promotion_threshold",
    "/mural/model",
];

/// The tasks' own settings the plugin kept beside `schedule`.
const PLUGIN_TASK_KEYS: [&str; 6] = [
    "max_tokens",
    "model",
    "promotion_threshold",
    "recency_days",
    "fallback_models",
    "variant",
];

/// The edits that turn a 0.49 user file's parsed value into the managed
/// shape, and a line for each thing a person may want to know: what was
/// removed, and what could not be converted. Each note names the setting by
/// its JSON pointer.
pub fn convert_0_49(value: &Value) -> (Vec<Edit>, Vec<String>) {
    let mut converter = Converter::default();
    match value.as_object() {
        Some(root) => converter.root(root),
        None => converter
            .notes
            .push("the file's top level is not an object; nothing was converted".into()),
    }
    (converter.edits, converter.notes)
}

#[derive(Default)]
struct Converter {
    edits: Vec<Edit>,
    notes: Vec<String>,
}

/// What one value needs.
enum Verdict {
    Keep,
    /// Write this instead, saying why.
    Replace(Value, Option<String>),
    /// Remove it: ck-mc ignores it today.
    Drop(String),
}

use Verdict::{Drop, Keep, Replace};

impl Converter {
    fn root(&mut self, root: &Map<String, Value>) {
        for (key, value) in root {
            let at = child("", key);
            match key.as_str() {
                "execute_threshold_percentage" => self.per_model_number(&at, value, 20.0, 90.0),
                "execute_threshold_tokens" => self.token_thresholds(&at, value),
                "keep_reasoning_tokens" => self.reasoning(&at, value),
                "protected_tokens" => self.leaf(&at, value, protected_tokens),
                "protected_tools" => self.protected_tools(&at, value),
                "history_budget_percentage" => self.leaf(&at, value, |v| number(v, 0.05, 0.5)),
                "memory" => self.memory(&at, value),
                "mural" => self.object(&at, value, &mut |this, key, at, value| match key {
                    "enabled" => this.leaf(at, value, boolean),
                    _ => this.unknown(at),
                }),
                "commit_cluster_trigger" => {
                    self.object(&at, value, &mut |this, key, at, value| match key {
                        "enabled" => this.leaf(at, value, boolean),
                        "min_clusters" => this.leaf(at, value, |v| integer(v, 1, None)),
                        _ => this.unknown(at),
                    })
                }
                "caveman_text_compression" => {
                    self.object(&at, value, &mut |this, key, at, value| match key {
                        "enabled" => this.leaf(at, value, boolean),
                        "min_chars" => this.leaf(at, value, |v| integer(v, 100, Some(10_000))),
                        _ => this.unknown(at),
                    })
                }
                "language" => self.leaf(&at, value, text),
                "keep_subagents" => self.leaf(&at, value, boolean),
                "compaction" => self.object(&at, value, &mut |this, key, at, value| match key {
                    "enabled" => this.leaf(at, value, boolean),
                    _ => this.unknown(at),
                }),
                "clock_note" => self.leaf(&at, value, clock_note),
                "prompt_surface" => self.prompt_surface(&at, value),
                "embedding" => self.embedding(&at, value),
                "rerank" => self.rerank(&at, value, root.get("rerank_backend")),
                "rerank_backend" => self.object(&at, value, &mut Self::rerank_backend_field),
                "dreamer" => self.dreamer(&at, value),
                "temporal_awareness" => {
                    self.edits.push(Edit::remove(&at));
                    self.notes.push(format!(
                        "{at}: obsolete (ck-mc adds no time markers to messages; clock_note sets how often an agent is told the time); removed"
                    ));
                }
                _ => self.unknown(&at),
            }
        }
    }

    /// Apply a verdict on the value at `at`. A string holding `{env:…}` or
    /// `{file:…}` is never converted: it gets a note and stays.
    fn leaf(&mut self, at: &str, value: &Value, check: impl Fn(&Value) -> Verdict) {
        if expansion(value) {
            self.notes.push(format!(
                "{at}: {{env:…}} and {{file:…}} are not converted: the daemon's settings take the value itself; write it here"
            ));
            return;
        }
        match check(value) {
            Keep => {}
            Replace(new, why) => {
                self.edits.push(Edit::set(at, new));
                if let Some(why) = why {
                    self.notes.push(format!("{at}: {why}"));
                }
            }
            Drop(why) => self.drop_value(at, &why),
        }
    }

    fn drop_value(&mut self, at: &str, why: &str) {
        self.edits.push(Edit::remove(at));
        self.notes.push(format!(
            "{at}: {why}; ck-mc ignored it, so it is removed and the default applies"
        ));
    }

    fn unknown(&mut self, at: &str) {
        self.edits.push(Edit::remove(at));
        let task_key = at
            .strip_prefix("/dreamer/tasks/")
            .and_then(|rest| rest.split_once('/'))
            .is_some_and(|(_, key)| PLUGIN_TASK_KEYS.contains(&key));
        if PLUGIN_KEYS.contains(&at) || task_key {
            self.notes.push(format!(
                "{at}: belonged to the 0.49 plugin and means nothing to ck-mc; removed (the old file is saved)"
            ));
        } else {
            self.notes
                .push(format!("{at}: not a ck-mc setting; removed"));
        }
    }

    /// An object whose members `member` handles; anything else is removed.
    fn object(
        &mut self,
        at: &str,
        value: &Value,
        member: &mut dyn FnMut(&mut Self, &str, &str, &Value),
    ) {
        match value.as_object() {
            Some(map) => {
                for (key, value) in map {
                    member(self, key, &child(at, key), value);
                }
            }
            None => self.drop_value(at, "not an object"),
        }
    }

    /// A map from model keys to entries `entry` checks: entries it refuses,
    /// and keys the schema's pattern refuses, are removed.
    fn model_map(&mut self, at: &str, map: &Map<String, Value>, entry: &dyn Fn(&Value) -> Verdict) {
        for (key, value) in map {
            let entry_at = child(at, key);
            if !model_key(key) {
                self.drop_value(&entry_at, "not a model key the settings accept");
            } else {
                self.leaf(&entry_at, value, entry);
            }
        }
    }

    /// `execute_threshold_percentage`: a number becomes the map's `default`.
    fn per_model_number(&mut self, at: &str, value: &Value, min: f64, max: f64) {
        match value {
            Value::Object(map) => self.model_map(at, map, &|v| number(v, min, max)),
            _ => self.leaf(at, value, |v| match number(v, min, max) {
                Keep => Replace(json!({"default": v}), None),
                other => other,
            }),
        }
    }

    /// `execute_threshold_tokens`: whole token counts per model.
    fn token_thresholds(&mut self, at: &str, value: &Value) {
        let Some(map) = value.as_object() else {
            return self.leaf(at, value, |_| Drop("not a map of model keys".into()));
        };
        self.model_map(at, map, &|v| match v.as_f64() {
            Some(n) if (5_000.0..=2_000_000.0).contains(&n) && n.fract() != 0.0 => Replace(
                json!(n.floor() as u64),
                Some("a token count is a whole number; the fraction is dropped".into()),
            ),
            _ => integer(v, 5_000, Some(2_000_000)),
        });
    }

    /// `keep_reasoning_tokens`: a number becomes the map's `default`.
    fn reasoning(&mut self, at: &str, value: &Value) {
        let valid = |v: &Value| integer(v, 0, Some(1_000_000));
        match value {
            Value::Object(map) => self.model_map(at, map, &valid),
            _ => self.leaf(at, value, |v| match valid(v) {
                Keep => Replace(json!({"default": v}), None),
                other => other,
            }),
        }
    }

    fn protected_tools(&mut self, at: &str, value: &Value) {
        let Some(map) = value.as_object() else {
            return self.leaf(at, value, |_| Drop("not a map of tool names".into()));
        };
        for (tool, count) in map {
            let entry_at = child(at, tool);
            if tool.is_empty() || tool.chars().any(char::is_whitespace) {
                self.drop_value(&entry_at, "not a tool name");
            } else {
                self.leaf(&entry_at, count, |v| integer(v, 0, None));
            }
        }
    }

    fn memory(&mut self, at: &str, value: &Value) {
        self.object(at, value, &mut |this, key, at, value| match key {
            "enabled" | "auto_promote" => this.leaf(at, value, boolean),
            "injection_budget_tokens" => this.leaf(at, value, |v| number(v, 500.0, 20_000.0)),
            "auto_search" => this.object(at, value, &mut |this, key, at, value| match key {
                "enabled" => this.leaf(at, value, boolean),
                "score_threshold" => this.leaf(at, value, |v| number(v, 0.3, 0.95)),
                "min_prompt_chars" => this.leaf(at, value, |v| number(v, 5.0, 500.0)),
                _ => this.unknown(at),
            }),
            "git_commit_indexing" => {
                this.object(at, value, &mut |this, key, at, value| match key {
                    "enabled" => this.leaf(at, value, boolean),
                    "since_days" => this.leaf(at, value, |v| number(v, 7.0, 3650.0)),
                    "max_commits" => this.leaf(at, value, |v| number(v, 100.0, 20_000.0)),
                    _ => this.unknown(at),
                })
            }
            _ => this.unknown(at),
        });
    }

    fn prompt_surface(&mut self, at: &str, value: &Value) {
        self.object(at, value, &mut |this, key, at, value| match key {
            "default" => this.leaf(at, value, surface),
            "models" => match value.as_object() {
                Some(map) => this.model_map(at, map, &surface),
                None => this.drop_value(at, "not a map of model keys"),
            },
            "tool_descriptions" => match value.as_object() {
                Some(map) => {
                    for (tool, description) in map {
                        let entry_at = child(at, tool);
                        if crate::catalog::definition().tool(tool).is_none() {
                            this.drop_value(&entry_at, "not one of Magic Context's tools");
                        } else {
                            this.leaf(&entry_at, description, text);
                        }
                    }
                }
                None => this.drop_value(at, "not a map of tool names"),
            },
            "guidance_override_path" | "guidance_override_text" => this.leaf(at, value, text),
            _ => this.unknown(at),
        });
    }

    fn embedding(&mut self, at: &str, value: &Value) {
        self.object(at, value, &mut |this, key, at, value| match key {
            "provider" => this.leaf(at, value, |v| match v.as_str() {
                Some("synapse" | "openai-compatible" | "off") => Keep,
                Some("local") => Replace(json!("synapse"), None),
                Some(other) => Replace(
                    json!("off"),
                    Some(format!(
                        "{other:?} is not a provider ck-mc serves, so nothing was embedded; now \"off\""
                    )),
                ),
                None => Drop("not text".into()),
            }),
            "module" => this.leaf(at, value, module),
            "endpoint" | "model" | "input_type" | "query_input_type" | "truncate" => {
                this.leaf(at, value, text);
            }
            "api_key" => this.api_key(at, value),
            "query_instruction" => this.leaf(at, value, |v| match v {
                Value::String(text) => Replace(json!({"kind": "text", "text": text}), None),
                Value::Bool(false) => Replace(json!({"kind": "none"}), None),
                Value::Object(_) if text_choice(v, true) => Keep,
                _ => Drop("neither text nor false".into()),
            }),
            "document_prefix" => this.leaf(at, value, |v| match v {
                Value::String(text) => Replace(json!({"kind": "text", "text": text}), None),
                Value::Object(_) if text_choice(v, false) => Keep,
                _ => Drop("not text".into()),
            }),
            "dimensions" => this.leaf(at, value, |v| integer(v, 0, Some(8192))),
            "max_input_tokens" => this.leaf(at, value, |v| integer(v, 0, None)),
            _ => this.unknown(at),
        });
    }

    fn rerank(&mut self, at: &str, value: &Value, backend: Option<&Value>) {
        let has_enabled = value.get("enabled").is_some();
        self.object(at, value, &mut |this, key, at, value| match key {
            // `"off"` becomes `enabled: false`, on the provider's own line.
            "provider" if value.as_str() == Some("off") => {
                this.renamed(at, "enabled", has_enabled, json!(false));
            }
            "provider" | "module" | "endpoint" | "model" | "api_key" => {
                let start = this.edits.len();
                let notes = this.notes.len();
                this.rerank_backend_field(key, at, value);
                let converted = match this.edits.get(start) {
                    Some(Edit::Set { value, .. }) => value.clone(),
                    Some(_) => return,
                    None if this.notes.len() != notes => return,
                    None => value.clone(),
                };
                this.edits.truncate(start);
                this.edits.push(Edit::remove(at));
                if backend.and_then(|section| section.get(key)).is_none() {
                    this.edits.push(Edit::set(child("/rerank_backend", key), converted));
                }
            }
            "enabled" => {
                // A provider of "off" sets this member itself.
                let off = this
                    .edits
                    .iter()
                    .any(|edit| matches!(edit, Edit::Set { pointer, .. } if pointer == at));
                if !off {
                    this.leaf(at, value, boolean);
                }
            }
            "timeout_ms" => this.leaf(at, value, |v| match v.as_f64() {
                Some(ms) if ms.is_finite() && ms.fract() == 0.0 => {
                    if (50.0..=15_000.0).contains(&ms) {
                        Keep
                    } else {
                        Replace(
                            json!(ms.clamp(50.0, 15_000.0) as u64),
                            Some("outside 50 to 15,000 ms, so ck-mc used the nearest end; now that value".into()),
                        )
                    }
                }
                _ => Drop("not a whole number of milliseconds".into()),
            }),
            "top_n" => this.leaf(at, value, |v| integer(v, 1, Some(20))),
            _ => this.unknown(at),
        });
    }

    fn rerank_backend_field(&mut self, key: &str, at: &str, value: &Value) {
        match key {
            "provider" => self.leaf(at, value, |v| match v.as_str() {
                Some("synapse" | "remote") => Keep,
                Some(other) => Replace(
                    json!("synapse"),
                    Some(format!("{other:?} is not a reranker ck-mc knows, so Synapse reranked; now \"synapse\"")),
                ),
                None => Drop("not text".into()),
            }),
            "module" => self.leaf(at, value, module),
            "endpoint" | "model" => self.leaf(at, value, text),
            "api_key" => self.api_key(at, value),
            _ => self.unknown(at),
        }
    }

    /// An API key: a `{vault:<id>}` reference becomes the vault credential;
    /// a literal key stays, with a note telling the person to store it in
    /// the vault.
    fn api_key(&mut self, at: &str, value: &Value) {
        match value {
            Value::String(_) if expansion(value) => self.notes.push(format!(
                "{at}: {{env:…}} and {{file:…}} are not converted; store the key in the CortexKit vault and write {{\"kind\": \"vault\", \"key\": {{\"vault_ref\": \"<credential id>\"}}}} here"
            )),
            Value::String(text) if text.trim().is_empty() => {
                self.edits.push(Edit::remove(at));
                self.notes.push(format!("{at}: empty, which sends no key; removed"));
            }
            Value::String(text) => match super::vault_reference(text) {
                Some(id) if vault_id(id) => self.edits.push(Edit::set(
                    at,
                    json!({"kind": "vault", "key": {"vault_ref": id}}),
                )),
                Some(_) => self.notes.push(format!(
                    "{at}: the vault credential id must be printable ASCII without spaces, at most 256 characters; not converted"
                )),
                None => self.notes.push(format!(
                    "{at}: a literal API key is not converted; store it in the CortexKit vault and write {{\"kind\": \"vault\", \"key\": {{\"vault_ref\": \"<credential id>\"}}}} here"
                )),
            },
            Value::Object(_) if api_key_choice(value) => {}
            _ => self.drop_value(at, "not text"),
        }
    }

    fn dreamer(&mut self, at: &str, value: &Value) {
        let Some(map) = value.as_object() else {
            return self.drop_value(at, "not an object");
        };
        // The 0.49 spellings, when usable, decide their new members: today's
        // reader reads only them.
        let disabled = map.get("disable").and_then(Value::as_bool);
        let budget = map
            .get("maxTokens")
            .and_then(super::integer)
            .filter(|budget| *budget > 0);
        for (key, value) in map {
            let member_at = child(at, key);
            match key.as_str() {
                "disable" => match disabled {
                    Some(disabled) => {
                        self.renamed(
                            &member_at,
                            "enabled",
                            map.contains_key("enabled"),
                            json!(!disabled),
                        );
                    }
                    None => self.drop_value(&member_at, "not true or false"),
                },
                "enabled" if disabled.is_some() => {}
                "enabled" => self.leaf(&member_at, value, boolean),
                "maxTokens" => match budget {
                    Some(budget) => self.renamed(
                        &member_at,
                        "max_tokens",
                        map.contains_key("max_tokens"),
                        json!(budget),
                    ),
                    None => self.drop_value(&member_at, "not a whole number above 0"),
                },
                "max_tokens" if budget.is_some() => {}
                "max_tokens" => self.leaf(&member_at, value, |v| integer(v, 1, None)),
                "projects" => self.leaf(&member_at, value, projects),
                "tasks" => self.tasks(&member_at, value),
                _ => self.unknown(&member_at),
            }
        }
    }

    /// Move the member at `at` to `to` in the same object with `value`:
    /// renamed in place when `to` is free, else written there and removed.
    fn renamed(&mut self, at: &str, to: &str, target_exists: bool, value: Value) {
        if target_exists {
            let (parent, _) = at.rsplit_once('/').expect("a pointer to a member");
            self.edits.push(Edit::remove(at));
            self.edits.push(Edit::set(child(parent, to), value));
        } else {
            self.edits.push(Edit::rename_and_set(at, to, value));
        }
    }

    fn tasks(&mut self, at: &str, value: &Value) {
        self.object(at, value, &mut |this, kind, at, task| {
            if !TASK_KINDS.contains(&kind) {
                return this.unknown(at);
            }
            this.object(at, task, &mut |this, key, at, value| match key {
                "schedule" => this.leaf(at, value, |v| match v.as_str() {
                    Some(schedule)
                        if schedule.trim().is_empty()
                            || crate::dreamer::cron::Cron::parse(schedule.trim()).is_some() =>
                    {
                        Keep
                    }
                    Some(_) => Drop("not a five-field cron expression".into()),
                    None => Drop("not text".into()),
                }),
                _ => this.unknown(at),
            });
        });
    }
}

fn boolean(value: &Value) -> Verdict {
    if value.is_boolean() {
        Keep
    } else {
        Drop("not true or false".into())
    }
}

fn number(value: &Value, min: f64, max: f64) -> Verdict {
    match value.as_f64() {
        Some(n) if (min..=max).contains(&n) => Keep,
        _ => Drop(format!("not a number from {min} to {max}")),
    }
}

/// A whole number, read as ck-mc reads token counts ([`super::integer`]).
fn integer(value: &Value, min: u64, max: Option<u64>) -> Verdict {
    match super::integer(value) {
        Some(n) if n >= min && max.is_none_or(|max| n <= max) => Keep,
        _ => Drop(match max {
            Some(max) => format!("not a whole number from {min} to {max}"),
            None => format!("not a whole number of at least {min}"),
        }),
    }
}

fn text(value: &Value) -> Verdict {
    if value.is_string() {
        Keep
    } else {
        Drop("not text".into())
    }
}

fn surface(value: &Value) -> Verdict {
    match value.as_str() {
        Some("full" | "light") => Keep,
        _ => Drop("neither \"full\" nor \"light\"".into()),
    }
}

fn module(value: &Value) -> Verdict {
    match value.as_str() {
        Some(id) if crate::search::rerank::module_id(id).is_some() => Keep,
        _ => Drop("not a module id such as \"synapse\" or fed:<fingerprint>:<module id>".into()),
    }
}

fn clock_note(value: &Value) -> Verdict {
    if value == "off" {
        return Keep;
    }
    match crate::clock_note::parse_interval(value) {
        Ok(None) => Replace(json!("off"), None),
        Ok(Some(_)) => {
            // The schema's spelling: no spaces around it and no leading zeros.
            let written = value.as_str().unwrap_or_default();
            let trimmed = written.trim();
            let (digits, unit) = trimmed.split_at(trimmed.len() - 1);
            let canonical = format!("{}{unit}", digits.trim_start_matches('0'));
            if canonical == written {
                Keep
            } else {
                Replace(json!(canonical), None)
            }
        }
        Err(why) => Drop(why),
    }
}

fn protected_tokens(value: &Value) -> Verdict {
    if value.is_object() {
        let auto = value == &json!({"kind": "auto"});
        let tokens = value.get("kind") == Some(&json!("tokens"))
            && value.as_object().is_some_and(|map| map.len() == 2)
            && super::integer(&value["tokens"]).is_some_and(|n| (4_000..=1_000_000).contains(&n));
        return if auto || tokens {
            Keep
        } else {
            Drop("not a number of tokens from 4,000 to 1,000,000".into())
        };
    }
    match super::integer(value) {
        Some(n) if (4_000..=1_000_000).contains(&n) => {
            Replace(json!({"kind": "tokens", "tokens": n}), None)
        }
        _ => Drop("not a whole number of tokens from 4,000 to 1,000,000".into()),
    }
}

fn projects(value: &Value) -> Verdict {
    if value == &json!({"kind": "all"}) {
        return Keep;
    }
    if value.get("kind") == Some(&json!("listed"))
        && value.as_object().is_some_and(|map| map.len() == 2)
        && value["projects"]
            .as_array()
            .is_some_and(|ids| ids.iter().all(Value::is_string))
    {
        return Keep;
    }
    let listed: Option<Vec<Value>> = value.as_array().and_then(|ids| {
        ids.iter()
            .map(|id| id.as_str().map(|id| json!(id.trim())))
            .collect()
    });
    match listed {
        Some(ids) => Replace(json!({"kind": "listed", "projects": ids}), None),
        None => Replace(
            json!({"kind": "listed", "projects": []}),
            Some(
                "not a list of project ids, so the dreamer ran for no project; now an empty list"
                    .into(),
            ),
        ),
    }
}

/// A `query_instruction` (`with_none`) or `document_prefix` in the new shape.
pub(crate) fn text_choice(value: &Value, with_none: bool) -> bool {
    let Some(map) = value.as_object() else {
        return false;
    };
    match map.get("kind").and_then(Value::as_str) {
        Some("auto") => map.len() == 1,
        Some("none") => with_none && map.len() == 1,
        Some("text") => map.len() == 2 && map.get("text").is_some_and(Value::is_string),
        _ => false,
    }
}

/// An API key in the new shape.
pub(crate) fn api_key_choice(value: &Value) -> bool {
    let Some(map) = value.as_object() else {
        return false;
    };
    match map.get("kind").and_then(Value::as_str) {
        Some("none") => map.len() == 1,
        Some("vault") => {
            map.len() == 2
                && map["key"].as_object().is_some_and(|key| key.len() == 1)
                && map["key"]["vault_ref"].as_str().is_some_and(vault_id)
        }
        _ => false,
    }
}

/// An id the daemon accepts as a vault reference, and that the file's
/// `{vault:<id>}` spelling can carry: printable ASCII without spaces or
/// braces, at most 256 characters.
pub(crate) fn vault_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 256
        && id
            .bytes()
            .all(|byte| (0x21..=0x7e).contains(&byte) && byte != b'{' && byte != b'}')
}

fn model_key(key: &str) -> bool {
    use std::sync::OnceLock;
    static PATTERN: OnceLock<regex::Regex> = OnceLock::new();
    PATTERN
        .get_or_init(|| regex::Regex::new(MODEL_KEY_PATTERN).expect("model key pattern"))
        .is_match(key)
}

/// A string holding `{env:…}` or `{file:…}`, which the daemon refuses.
fn expansion(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|text| text.contains("{env:") || text.contains("{file:"))
}
