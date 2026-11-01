//! Resolve user-owned model profiles and migrate older setting names (such as
//! dreamer.schedule) in memory, so older configs still work without rewriting files.

use super::{merge, remove_path, schema, schema_parse, set_path, value_at, Warning};
use serde_json::{json, Map, Value};

pub(crate) fn resolve(
    user: &mut Value,
    project: &mut Value,
    warnings: &mut Vec<Warning>,
) -> Option<String> {
    let selection = |raw: &Value| {
        raw.get("profile")
            .and_then(Value::as_str)
            .map(super::variables::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
    };
    let user_name = selection(user);
    let project_name = selection(project);
    if project.get("profile").is_some() && project_name.is_none()
        || project.get("profile").is_none() && user.get("profile").is_some() && user_name.is_none()
    {
        warnings.push(Warning::new(
            "profile_selection",
            "Profile selection must be a non-empty string.",
        ));
    }
    let mut definitions = json!({});
    if let Some(raw) = user.get("profiles") {
        let (parsed, issues) = schema_parse(&schema()["profiles"], Some(raw), "profiles");
        if issues.is_empty() {
            definitions = parsed.unwrap_or(json!({}));
        } else {
            warnings.push(Warning::new(
                "profile_invalid",
                "Profiles may contain only historian/dreamer harness model blocks.",
            ));
        }
    }
    for raw in [&mut *user, &mut *project] {
        let object = raw.as_object_mut().unwrap();
        object.remove("profile");
        object.remove("profiles");
    }
    let name = project_name.or(user_name)?;
    if let Some(overlay) = definitions.get(&name) {
        *user = merge(user, overlay);
        Some(name)
    } else {
        warnings.push(Warning::new(
            "profile_unknown",
            "Unknown profile; using base config without an overlay.",
        ));
        None
    }
}

pub(crate) fn removed(raw: &mut Value, warnings: &mut Vec<Warning>) {
    let mut removed = raw.as_object_mut().unwrap().remove("sidekick").is_some();
    if let Some(profiles) = raw.get_mut("profiles").and_then(Value::as_object_mut) {
        for profile in profiles.values_mut() {
            if let Some(object) = profile.as_object_mut() {
                removed |= object.remove("sidekick").is_some();
            }
        }
    }
    if removed {
        warnings.push(Warning::new(
            "deprecated",
            "The sidekick configuration was removed and is ignored.",
        ));
    }
}

pub(crate) fn migrate(raw: &mut Value, warnings: &mut Vec<Warning>) {
    for key in ["protected_tags", "clear_reasoning_age", "smart_drops"] {
        if raw.get(key).is_some() {
            warnings.push(Warning::new(
                "deprecated",
                "Deprecated configuration key is ignored.",
            ));
        }
    }
    for agent in ["historian", "dreamer"] {
        if raw.get(agent).is_some_and(Value::is_object)
            && ["model", "fallback_models", "variant", "thinking_level"]
                .iter()
                .any(|key| raw[agent].get(*key).is_some())
        {
            warnings.push(Warning::new(
                "misplaced_model",
                "Model fields belong in a per-harness block.",
            ));
        }
    }
    if let Some(exp) = raw.get("experimental").and_then(Value::as_object).cloned() {
        let mut migrated = false;
        for (key, destination, coerce) in [
            ("temporal_awareness", "temporal_awareness", false),
            (
                "caveman_text_compression",
                "caveman_text_compression",
                false,
            ),
            ("auto_search", "memory.auto_search", false),
            ("git_commit_indexing", "memory.git_commit_indexing", false),
            ("mural", "mural", true),
            ("user_memories", "dreamer.user_memories", true),
            ("pin_key_files", "dreamer.pin_key_files", true),
        ] {
            let Some(old) = exp.get(key) else {
                continue;
            };
            migrated = true;
            let old = if coerce && old.is_boolean() {
                json!({"enabled":old})
            } else {
                old.clone()
            };
            if coerce && key != "mural" && !old.is_object() {
                continue;
            }
            let existing = value_at(raw, destination).cloned();
            if let Some(existing) = existing {
                if old.is_object() && existing.is_object() {
                    set_path(raw, destination, merge(&old, &existing));
                } else if key == "pin_key_files" && old.is_object() && existing.is_boolean() {
                    set_path(raw, destination, merge(&old, &json!({"enabled":existing})));
                }
            } else {
                set_path(raw, destination, old);
                warnings.push(Warning::new(
                    "deprecated",
                    "Legacy experimental setting migrated in memory.",
                ));
            }
            remove_path(raw, &format!("experimental.{key}"));
        }
        if migrated && raw.get("dreamer").is_none() {
            raw["dreamer"] = json!({});
        }
    }
    if value_at(raw, "mural.model").is_some() {
        warnings.push(Warning::new(
            "deprecated",
            "mural.model is ignored; compress-cues uses the dreamer model.",
        ));
    }
    dreamer_v2(raw, warnings);
    for agent in ["dreamer", "historian"] {
        if let Some(object) = raw.get_mut(agent).and_then(Value::as_object_mut) {
            if let Some(enabled) = object.remove("enabled") {
                if agent == "historian" {
                    warnings.push(Warning::new("deprecated", "historian.enabled is removed."));
                } else if enabled == false && object.get("disable") != Some(&Value::Bool(true)) {
                    object.insert("disable".into(), json!(true));
                    warnings.push(Warning::new(
                        "deprecated",
                        "dreamer.enabled=false migrated to disable=true.",
                    ));
                }
            }
        }
    }
}

const CANONICAL: [&str; 11] = [
    "map-memories",
    "verify",
    "verify-broad",
    "curate",
    "classify-memories",
    "retrospective",
    "maintain-docs",
    "evaluate-smart-notes",
    "review-user-memories",
    "promote-primers",
    "refresh-primers",
];
const RETIRED: [&str; 4] = ["maintain-memory", "consolidate", "archive-stale", "improve"];
fn entry(schedule: &str, timeout: Option<&Value>) -> Value {
    let mut value = json!({"schedule":schedule});
    if let Some(timeout) = timeout {
        value["timeout_minutes"] = timeout.clone();
    }
    value
}
fn enabled(task: Option<&Value>) -> bool {
    task.and_then(|v| v.get("schedule"))
        .and_then(Value::as_str)
        .is_some_and(|v| !v.trim().is_empty())
}
fn interval(schedule: &str) -> u64 {
    let parts: Vec<_> = schedule.split_whitespace().collect();
    if parts.len() != 5 {
        return u64::MAX;
    }
    if parts[3] != "*" {
        return 366 * 24 * 60;
    }
    if parts[2] != "*" {
        return 31 * 24 * 60;
    }
    if parts[4] != "*" {
        return 7 * 24 * 60;
    }
    if let Some(step) = parts[1]
        .strip_prefix("*/")
        .and_then(|v| v.parse::<u64>().ok())
    {
        return step.max(1) * 60;
    }
    if parts[1] == "*" {
        return parts[0]
            .strip_prefix("*/")
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(60)
            .max(1);
    }
    24 * 60
}
fn window(value: Option<&Value>) -> String {
    let Some(value) = value.and_then(Value::as_str) else {
        return "0 2 * * *".into();
    };
    let regex = regex::Regex::new(r"^(\d{1,2}):(\d{2})\s*-").unwrap();
    if let Some(m) = regex.captures(value.trim()) {
        let hour: u32 = m[1].parse().unwrap_or(24);
        let minute: u32 = m[2].parse().unwrap_or(60);
        if hour < 24 && minute < 60 {
            return format!("{minute} {hour} * * *");
        }
    }
    "0 2 * * *".into()
}
fn dreamer_v2(raw: &mut Value, warnings: &mut Vec<Warning>) {
    let Some(mut dreamer) = raw.get("dreamer").and_then(Value::as_object).cloned() else {
        return;
    };
    let tasks_object = dreamer.get("tasks").and_then(Value::as_object);
    let retired =
        tasks_object.is_some_and(|tasks| RETIRED.iter().any(|key| tasks.contains_key(*key)));
    let legacy = [
        "schedule",
        "user_memories",
        "pin_key_files",
        "task_timeout_minutes",
        "max_runtime_minutes",
    ]
    .iter()
    .any(|key| dreamer.contains_key(*key))
        || dreamer.get("tasks").is_some_and(Value::is_array)
        || retired;
    if !legacy {
        if let Some(tasks) = dreamer.get_mut("tasks").and_then(Value::as_object_mut) {
            tasks.remove("key-files");
            for value in tasks.values_mut() {
                if let Some(object) = value.as_object_mut() {
                    object.remove("broad_interval_days");
                }
            }
            if !tasks.contains_key("verify-broad") {
                let schedule = if enabled(tasks.get("verify")) {
                    "0 4 * * 0"
                } else {
                    ""
                };
                tasks.insert("verify-broad".into(), entry(schedule, None));
            }
            raw["dreamer"] = Value::Object(dreamer);
        }
        return;
    }
    let base = window(dreamer.get("schedule"));
    let timeout = dreamer
        .get("task_timeout_minutes")
        .filter(|v| v.is_number());
    let disabled = dreamer.get("disable") == Some(&Value::Bool(true));
    let classify = if disabled { "" } else { "0 6 * * *" };
    let retrospective = if disabled { "" } else { "0 5 * * *" };
    let mut tasks = Map::new();
    if let Some(old) = tasks_object {
        for (key, value) in old {
            if !RETIRED.contains(&key.as_str()) && value.is_object() {
                tasks.insert(key.clone(), value.clone());
            }
        }
        if let Some(maintain) = old.get("maintain-memory").filter(|v| v.is_object()) {
            for task in ["verify", "curate"] {
                let mut value = maintain.clone();
                value.as_object_mut().unwrap().remove("broad_interval_days");
                let schedule = tasks
                    .get(task)
                    .and_then(|v| v.get("schedule"))
                    .or_else(|| maintain.get("schedule"))
                    .cloned()
                    .unwrap_or(json!(base));
                value = merge(&value, tasks.get(task).unwrap_or(&json!({})));
                value["schedule"] = schedule;
                if let Some(timeout) = timeout {
                    value["timeout_minutes"] = timeout.clone();
                }
                tasks.insert(task.into(), value);
            }
        }
        if let Some(verify) = tasks.get_mut("verify") {
            verify
                .as_object_mut()
                .unwrap()
                .remove("broad_interval_days");
            if verify.get("schedule").is_none() {
                verify["schedule"] = json!(base);
            }
            if let Some(timeout) = timeout {
                verify["timeout_minutes"] = timeout.clone();
            }
        }
        if !tasks.contains_key("verify-broad") {
            tasks.insert(
                "verify-broad".into(),
                entry(
                    if enabled(tasks.get("verify")) {
                        "0 4 * * 0"
                    } else {
                        ""
                    },
                    timeout,
                ),
            );
        }
        let schedules: Vec<_> = RETIRED[1..]
            .iter()
            .filter_map(|task| {
                old.get(*task)
                    .filter(|v| v.is_object())
                    .map(|v| v.get("schedule").and_then(Value::as_str).unwrap_or(&base))
            })
            .collect();
        if !schedules.is_empty() {
            let schedule = schedules
                .into_iter()
                .filter(|s| !s.trim().is_empty())
                .min_by_key(|s| interval(s))
                .unwrap_or("");
            let value = tasks.entry("curate").or_insert(json!({}));
            value["schedule"] = json!(schedule);
            if let Some(timeout) = timeout {
                value["timeout_minutes"] = timeout.clone();
            }
        }
        for task in CANONICAL {
            let schedule = match task {
                "verify" | "curate" | "verify-broad" | "maintain-docs" => "",
                "classify-memories" => classify,
                "retrospective" => retrospective,
                _ => &base,
            };
            tasks
                .entry(task)
                .or_insert_with(|| entry(schedule, timeout));
        }
    } else {
        let array = dreamer.get("tasks").and_then(Value::as_array);
        let verify = array.is_none_or(|v| v.contains(&json!("verify")));
        let curate = array.is_none_or(|v| RETIRED[1..].iter().any(|task| v.contains(&json!(task))));
        for (task, schedule) in [
            ("verify", if verify { base.as_str() } else { "" }),
            ("verify-broad", if verify { "0 4 * * 0" } else { "" }),
            ("curate", if curate { base.as_str() } else { "" }),
            ("classify-memories", classify),
            ("retrospective", retrospective),
            (
                "maintain-docs",
                if array.is_some_and(|v| v.contains(&json!("maintain-docs"))) {
                    base.as_str()
                } else {
                    ""
                },
            ),
        ] {
            tasks.insert(task.into(), entry(schedule, timeout));
        }
    }
    for task in ["map-memories", "evaluate-smart-notes"] {
        tasks.entry(task).or_insert_with(|| entry(&base, timeout));
    }
    let um = dreamer.get("user_memories").filter(|v| v.is_object());
    if um.is_some() || !tasks.contains_key("review-user-memories") {
        let mut value = tasks
            .get("review-user-memories")
            .cloned()
            .unwrap_or(json!({}));
        value["schedule"] = json!(if um
            .is_some_and(|v| v.get("enabled") == Some(&Value::Bool(false)))
        {
            ""
        } else {
            &base
        });
        if let Some(threshold) = um
            .and_then(|v| v.get("promotion_threshold"))
            .filter(|v| v.is_number())
        {
            value["promotion_threshold"] = threshold.clone();
        }
        if let Some(timeout) = timeout {
            value["timeout_minutes"] = timeout.clone();
        }
        tasks.insert("review-user-memories".into(), value);
    }
    for key in [
        "schedule",
        "tasks",
        "task_timeout_minutes",
        "max_runtime_minutes",
        "user_memories",
        "pin_key_files",
    ] {
        dreamer.remove(key);
    }
    dreamer.insert("tasks".into(), Value::Object(tasks));
    raw["dreamer"] = Value::Object(dreamer);
    warnings.push(Warning::new(
        "deprecated",
        "Legacy dreamer scheduling migrated to per-task metadata.",
    ));
}

fn harness_entry(value: &Value, harness: &str) -> Value {
    if let Some(array) = value.as_array() {
        return Value::Array(array.iter().map(|v| harness_entry(v, harness)).collect());
    }
    if let Some(model) = value.get("model") {
        let mut entry = json!({"model":model});
        let qualifier = if harness == "opencode" {
            "variant"
        } else {
            "thinking_level"
        };
        if let Some(value) = value.get(qualifier) {
            entry[qualifier] = value.clone();
        }
        entry
    } else {
        value.clone()
    }
}

pub(crate) fn flat(raw: &mut Value, warnings: &mut Vec<Warning>) -> bool {
    let original = raw.clone();
    let mut sites = vec![
        ("historian".to_owned(), false),
        ("dreamer".to_owned(), false),
    ];
    if let Some(tasks) = value_at(&original, "dreamer.tasks").and_then(Value::as_object) {
        for task in tasks.keys() {
            sites.push((format!("dreamer.tasks.{task}"), true));
        }
    }
    let mut changed = false;
    for (site, task) in sites {
        for field in [
            "model",
            "fallback_models",
            "variant",
            "thinking_level",
            "timeout_minutes",
        ] {
            if field == "timeout_minutes" && !task {
                continue;
            }
            let source = format!("{site}.{field}");
            let Some(value) = value_at(&original, &source) else {
                continue;
            };
            changed = true;
            for harness in ["opencode", "pi"] {
                if field == "variant" && harness != "opencode"
                    || field == "thinking_level" && harness != "pi"
                {
                    continue;
                }
                let destination = if let Some(name) = site.strip_prefix("dreamer.tasks.") {
                    format!("dreamer.{harness}.tasks.{name}.{field}")
                } else {
                    format!("{site}.{harness}.{field}")
                };
                let value = if field == "fallback_models" && value.is_string() {
                    json!([value])
                } else {
                    value.clone()
                };
                let value = if field == "model" || field == "fallback_models" {
                    harness_entry(&value, harness)
                } else {
                    value
                };
                if value_at(&original, &destination).is_none() {
                    let mut cursor = &original;
                    let mut possible = true;
                    for part in destination
                        .split('.')
                        .collect::<Vec<_>>()
                        .split_last()
                        .unwrap()
                        .1
                    {
                        if let Some(next) = cursor.get(*part) {
                            if !next.is_object() {
                                possible = false;
                                break;
                            }
                            cursor = next;
                        } else {
                            break;
                        }
                    }
                    if possible {
                        set_path(raw, &destination, value);
                    } else {
                        warnings.push(Warning::new(
                            "flat_conflict",
                            "Flat field ignored because its destination is not an object.",
                        ));
                    }
                } else if value_at(&original, &destination) != Some(&value) {
                    warnings.push(Warning::new(
                        "flat_conflict",
                        "Flat field ignored because the per-harness value already exists.",
                    ));
                }
            }
            remove_path(raw, &source);
        }
    }
    if changed {
        warnings.push(Warning::new(
            "deprecated",
            "Flat historian/dreamer model config migrated to per-harness blocks.",
        ));
    }
    changed
}

pub(crate) fn valid_template(source: &str) -> bool {
    Template { source, at: 0 }.template(false).is_some()
}
struct Template<'a> {
    source: &'a str,
    at: usize,
}
impl Template<'_> {
    fn take(&mut self, text: &str) -> bool {
        if self.source[self.at..].starts_with(text) {
            self.at += text.len();
            true
        } else {
            false
        }
    }
    fn field(&mut self) -> Option<&str> {
        let start = self.at;
        let b = *self.source.as_bytes().get(self.at)?;
        if !b.is_ascii_alphabetic() && b != b'_' {
            return None;
        }
        self.at += 1;
        while self
            .source
            .as_bytes()
            .get(self.at)
            .is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'-')
        {
            self.at += 1;
        }
        Some(&self.source[start..self.at])
    }
    fn integer(&mut self) -> Option<()> {
        let start = self.at;
        while self
            .source
            .as_bytes()
            .get(self.at)
            .is_some_and(u8::is_ascii_digit)
        {
            self.at += 1;
        }
        if start == self.at
            || self.source[start..self.at].parse::<u64>().ok()? > 9_007_199_254_740_991
        {
            None
        } else {
            Some(())
        }
    }
    fn quoted(&mut self) -> Option<String> {
        let start = self.at;
        if !self.take("\"") {
            return None;
        }
        while self.at < self.source.len() {
            if self.take("\\") {
                let c = self.source[self.at..].chars().next()?;
                self.at += c.len_utf8();
            } else if self.take("\"") {
                return serde_json::from_str(&self.source[start..self.at]).ok();
            } else {
                let c = self.source[self.at..].chars().next()?;
                self.at += c.len_utf8();
            }
        }
        None
    }
    fn expression(&mut self, relative: bool) -> Option<()> {
        if !(relative && self.take(".")) {
            let root = self.field()?;
            if !relative && root != "input" && root != "output" {
                return None;
            }
        }
        loop {
            if self.take("[") {
                if self.take("*].") {
                    self.field()?;
                } else {
                    self.integer()?;
                    if !self.take("]") {
                        return None;
                    }
                }
            } else {
                let rest = &self.source[self.at..];
                let modifier = [".each(", ".join(", ".count.", ".count}", ".truncate("]
                    .iter()
                    .any(|v| rest.starts_with(v));
                if rest.starts_with('.') && !modifier {
                    self.at += 1;
                    self.field()?;
                    if self.source[self.at..].starts_with('(') {
                        return None;
                    }
                } else {
                    break;
                }
            }
        }
        let each = self.take(".each(");
        if each {
            if relative {
                return None;
            }
            let inner = self.quoted()?;
            Template {
                source: &inner,
                at: 0,
            }
            .template(true)?;
            if !self.take(")") {
                return None;
            }
        }
        let join = self.take(".join(");
        if join {
            self.quoted()?;
            if !self.take(")") {
                return None;
            }
        }
        if self.take(".count") && (each || join) {
            return None;
        }
        if self.take(".truncate(") {
            self.integer()?;
            if !self.take(")") {
                return None;
            }
        }
        if !self.take("}") {
            return None;
        }
        Some(())
    }
    fn template(&mut self, relative: bool) -> Option<()> {
        while let Some(next) = self.source[self.at..].find("${") {
            self.at += next + 2;
            self.expression(relative)?;
        }
        Some(())
    }
}

pub(crate) fn serialize_flat(raw: &Value, tool_order: &[String]) -> String {
    let mut fields = Vec::new();
    for (key, value) in raw.as_object().unwrap() {
        let text = if key == "protected_tools" && value.is_object() {
            let mut names = tool_order.to_vec();
            for key in value.as_object().unwrap().keys() {
                if !names.contains(key) {
                    names.push(key.clone());
                }
            }
            let pairs: Vec<_> = names
                .iter()
                .filter_map(|key| {
                    value
                        .get(key)
                        .map(|value| format!("{}:{}", serde_json::to_string(key).unwrap(), value))
                })
                .collect();
            format!("{{{}}}", pairs.join(","))
        } else {
            value.to_string()
        };
        fields.push(format!("{}:{text}", serde_json::to_string(key).unwrap()));
    }
    format!("{{{}}}", fields.join(","))
}
