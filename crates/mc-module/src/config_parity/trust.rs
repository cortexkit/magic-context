//! Project config may select user-owned profiles and delay compaction, but cannot
//! change user-only settings such as provider destinations, secret reads or agent permissions.

use super::{merge, remove_path, schema, schema_parse, set_path, value_at, Warning};
use serde_json::{json, Map, Value};

const HARNESSES: [&str; 3] = ["opencode", "pi", "omp"];
const HISTORIAN_HARNESSES: [&str; 4] = ["opencode", "pi", "omp", "broca"];
const HISTORIAN: [&str; 7] = [
    "model",
    "fallback_models",
    "variant",
    "thinking_level",
    "runner",
    "host_runner",
    "turn_two",
];

fn strip(value: &mut Value, keys: &[&str], warnings: &mut Vec<Warning>) {
    if let Some(object) = value.as_object_mut() {
        if keys.iter().any(|key| object.contains_key(*key)) {
            for key in keys {
                object.remove(*key);
            }
            warnings.push(Warning::new(
                "project_policy",
                "Ignoring user-only fields from project config.",
            ));
        }
    }
}
fn executable(value: &mut Value, warnings: &mut Vec<Warning>) {
    strip(value, &["prompt", "permission", "tools"], warnings);
    if let Some(entry) = value.get_mut("model") {
        strip(entry, &["prompt", "permission", "tools"], warnings);
    }
    if let Some(entries) = value
        .get_mut("fallback_models")
        .and_then(Value::as_array_mut)
    {
        for entry in entries {
            strip(entry, &["prompt", "permission", "tools"], warnings);
        }
    }
}

pub(crate) fn sanitize(project: &mut Value, warnings: &mut Vec<Warning>) {
    strip(
        project,
        &[
            "rust_pipeline",
            "profiles",
            "auto_update",
            "fail_closed_blocking",
            "debug_rpc",
            "signed_thinking_hold",
            "allow_home_project",
            "output_reserve",
            "language",
            "sqlite",
            "subc",
            "shadow_embedding",
        ],
        warnings,
    );
    for (block, keys) in [
        ("compaction", &["enabled"][..]),
        ("models", &["window_overlay_path"][..]),
        ("storage", &["enforce_private_permissions"][..]),
        ("smart_notes", &["enabled"][..]),
        (
            "prompt_surface",
            &["guidance_override_path", "tool_descriptions"][..],
        ),
        ("pi", &["subagent_extensions"][..]),
        (
            "embedding",
            &[
                "endpoint",
                "provider",
                "fallback_provider",
                "query_instruction",
                "document_prefix",
            ][..],
        ),
    ] {
        if let Some(value) = project.get_mut(block) {
            strip(value, keys, warnings);
        }
    }
    for key in ["historian", "dreamer"] {
        let Some(agent) = project.get_mut(key).filter(|v| v.is_object()) else {
            continue;
        };
        executable(agent, warnings);
        for harness in HARNESSES {
            if let Some(block) = agent.get_mut(harness) {
                executable(block, warnings);
                if let Some(tasks) = block.get_mut("tasks").and_then(Value::as_object_mut) {
                    for task in tasks.values_mut() {
                        executable(task, warnings);
                    }
                }
            }
        }
        if let Some(tasks) = agent.get_mut("tasks").and_then(Value::as_object_mut) {
            for task in tasks.values_mut() {
                strip(task, &["prompt", "permission", "tools"], warnings);
            }
        }
        if key == "historian" {
            strip(agent, &HISTORIAN, warnings);
            for harness in HISTORIAN_HARNESSES {
                if let Some(value) = agent.get_mut(harness) {
                    strip(value, &HISTORIAN, warnings);
                }
            }
        } else {
            strip(agent, &["runner"], warnings);
        }
    }
}
fn percentage(value: &Value) -> bool {
    value.as_f64().is_some_and(|v| (20.0..=90.0).contains(&v))
}
fn tokens(value: &Value) -> bool {
    value
        .as_f64()
        .is_some_and(|v| (5000.0..=2_000_000.0).contains(&v))
}
pub(crate) fn protected(value: &Value) -> bool {
    value
        .as_u64()
        .is_some_and(|v| (4000..=1_000_000).contains(&v))
}
fn policy_warning(warnings: &mut Vec<Warning>) {
    warnings.push(Warning::new(
        "project_policy",
        "Project configuration may only raise trusted compaction floors.",
    ));
}

pub(crate) fn thresholds(
    merged: &mut Value,
    project: &Value,
    trusted: &Value,
    warnings: &mut Vec<Warning>,
) {
    if let Some(p) = project.get("execute_threshold_percentage") {
        let base = trusted
            .get("execute_threshold_percentage")
            .unwrap_or(&Value::Null);
        let mut map = base.as_object().cloned().unwrap_or_else(|| {
            Map::from_iter([(
                "default".to_owned(),
                if percentage(base) {
                    base.clone()
                } else {
                    json!(65)
                },
            )])
        });
        let default = map.get("default").cloned().unwrap_or(json!(65));
        map.retain(|k, v| k == "default" || *v != default);
        let before = map.clone();
        let mut touched = false;
        if percentage(p) {
            touched = true;
            for v in map.values_mut() {
                if p.as_f64() > v.as_f64() {
                    *v = p.clone();
                }
            }
            let default = map["default"].clone();
            map.retain(|k, v| k == "default" || *v != default);
            if map == before {
                policy_warning(warnings);
            }
        } else if let Some(object) = p.as_object() {
            for (key, value) in object {
                if !percentage(value) {
                    continue;
                }
                touched = true;
                let floor = before.get(key).unwrap_or(&default);
                if value.as_f64() > floor.as_f64() {
                    map.insert(key.clone(), value.clone());
                } else {
                    policy_warning(warnings);
                }
            }
            let new_default = map["default"].clone();
            for (key, value) in object {
                if key != "default"
                    && percentage(value)
                    && value.as_f64() > before.get(key).unwrap_or(&default).as_f64()
                    && *value == new_default
                {
                    map.remove(key);
                }
            }
        }
        if touched {
            merged["execute_threshold_percentage"] = if map.len() == 1 {
                map["default"].clone()
            } else {
                Value::Object(map)
            };
        }
    }
    if let Some(p) = project
        .get("execute_threshold_tokens")
        .and_then(Value::as_object)
    {
        let base = trusted
            .get("execute_threshold_tokens")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let mut constrained = base.clone();
        let mut touched = false;
        for (key, value) in p {
            if !tokens(value) {
                continue;
            }
            touched = true;
            if let Some(floor) = base.get(key).or_else(|| base.get("default")) {
                if value.as_f64() > floor.as_f64() {
                    constrained.insert(key.clone(), value.clone());
                } else {
                    policy_warning(warnings);
                }
            } else {
                policy_warning(warnings);
            }
        }
        let default = constrained.get("default").cloned();
        constrained.retain(|k, v| k == "default" || Some(v.clone()) != default);
        if touched {
            if constrained.is_empty() {
                merged
                    .as_object_mut()
                    .unwrap()
                    .remove("execute_threshold_tokens");
            } else {
                merged["execute_threshold_tokens"] = Value::Object(constrained);
            }
        }
    }
    if let Some(p) = project.get("protected_tokens") {
        let user = trusted.get("protected_tokens").filter(|v| protected(v));
        match (protected(p), user) {
            (true, Some(user)) if p.as_u64() < user.as_u64() => {
                merged["protected_tokens"] = user.clone();
                policy_warning(warnings);
            }
            (true, _) => merged["protected_tokens"] = p.clone(),
            (false, Some(user)) => {
                merged["protected_tokens"] = user.clone();
                policy_warning(warnings);
            }
            (false, None) => {
                merged.as_object_mut().unwrap().remove("protected_tokens");
                policy_warning(warnings);
            }
        }
    }
}

pub(crate) fn restore_invalid(
    merged: &mut Value,
    project: &Value,
    trusted: &Value,
    warnings: &mut Vec<Warning>,
) -> bool {
    let mut restored = std::collections::BTreeSet::new();
    for _ in 0..8 {
        let mut probe = merged.clone();
        super::profiles::migrate(&mut probe, &mut Vec::new());
        let (_, issues) = schema_parse(&schema()["config"], Some(&probe), "");
        let mut changed = false;
        for issue in issues {
            let segments: Vec<&str> = issue.split('.').collect();
            // Stop at a non-object project value: it replaces the whole user block
            // at that prefix, so restoring only a deeper leaf would lose valid siblings.
            let mut contribution = Vec::new();
            let mut cursor = project;
            for segment in &segments {
                if let Some(next) = cursor.get(super::unsegment(segment)) {
                    contribution.push(*segment);
                    cursor = next;
                    if !cursor.is_object() {
                        break;
                    }
                } else {
                    break;
                }
            }
            if contribution.is_empty() {
                continue;
            }
            let path = contribution.join(".");
            if restored.contains(&path) {
                continue;
            }
            if let Some(value) = value_at(trusted, &path) {
                set_path(merged, &path, value.clone());
                restored.insert(path);
                changed = true;
                warnings.push(Warning::new(
                    "project_invalid",
                    "Invalid project value ignored; keeping the user-level value.",
                ));
            }
        }
        if !changed {
            break;
        }
    }
    !restored.is_empty()
}
pub(crate) fn commands(
    merged: &mut Value,
    project: &Value,
    trusted: &Value,
    warnings: &mut Vec<Warning>,
) {
    let Some(project_commands) = project.get("command") else {
        return;
    };
    let mut result = trusted
        .get("command")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(project_commands) = project_commands.as_object() {
        for (name, command) in project_commands {
            let builtin = schema()["commands"]
                .as_array()
                .is_some_and(|commands| commands.iter().any(|v| v.as_str() == Some(name)));
            let valid = command.as_object().is_some_and(|object| {
                object
                    .get("template")
                    .and_then(Value::as_str)
                    .is_some_and(|v| !v.trim().is_empty())
                    && ["description", "agent", "model"]
                        .iter()
                        .all(|k| object.get(*k).is_none_or(Value::is_string))
                    && object.get("subtask").is_none_or(Value::is_boolean)
            });
            if builtin || !valid || result.contains_key(name) {
                warnings.push(Warning::new(
                    "project_command",
                    "Project command cannot replace a trusted command or reserved name.",
                ));
            } else {
                let mut value = Map::new();
                for key in ["template", "description", "agent", "model", "subtask"] {
                    if let Some(v) = command.get(key) {
                        value.insert(key.into(), v.clone());
                    }
                }
                result.insert(name.clone(), Value::Object(value));
            }
        }
    } else {
        warnings.push(Warning::new(
            "project_command",
            "Project commands must be an object of named commands.",
        ));
    }
    if result.is_empty() {
        remove_path(merged, "command");
    } else {
        merged["command"] = Value::Object(result);
    }
}
// Normalize protected-tool identifiers before merging so case aliases cannot override twice.
pub(crate) fn protected_tools(raw: &Value) -> Value {
    let mut result = json!({});
    if let Some(object) = raw.as_object() {
        for (key, value) in object {
            let key = key.to_lowercase();
            let key = key.strip_prefix("mcp_").unwrap_or(&key);
            result[key] = value.clone();
        }
    }
    result
}

pub(crate) fn ordered_tools(raw: &Value, order: &[String]) -> Value {
    let mut result = protected_tools(raw);
    for key in order {
        if let Some(value) = raw.get(key) {
            let key = key.to_lowercase();
            result[key.strip_prefix("mcp_").unwrap_or(&key)] = value.clone();
        }
    }
    result
}

pub(crate) fn deep_merge(
    user: &Value,
    project: &Value,
    user_order: &[String],
    project_order: &[String],
) -> Value {
    let mut result = merge(user, project);
    if let (Some(u), Some(p)) = (
        user.get("disabled_hooks").and_then(Value::as_array),
        project.get("disabled_hooks").and_then(Value::as_array),
    ) {
        let mut hooks = u.clone();
        for hook in p {
            if !hooks.contains(hook) {
                hooks.push(hook.clone());
            }
        }
        result["disabled_hooks"] = Value::Array(hooks);
    }
    if user.get("protected_tools").is_some_and(Value::is_object)
        && project.get("protected_tools").is_some_and(Value::is_object)
    {
        result["protected_tools"] = merge(
            &ordered_tools(&user["protected_tools"], user_order),
            &ordered_tools(&project["protected_tools"], project_order),
        );
    }
    result
}
