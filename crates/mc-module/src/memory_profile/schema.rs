use serde_json::Value;

use super::{refuse, Result};

/// Validate the frozen schema without network references or implicit coercion.
pub(super) fn validate(body: &Value) -> Result<()> {
    let schema: Value = serde_json::from_str(include_str!(
        "../../profiles/schema/mc-memory-profile-v1.schema.json"
    ))
    .expect("bundled JSON schema");
    check(&schema, body, &schema, "body").map_err(|detail| refuse("profile_schema_invalid", detail))
}

fn check(s: &Value, v: &Value, root: &Value, at: &str) -> std::result::Result<(), String> {
    let fail = |message: String| Err(format!("{at}: {message}"));
    for key in s.as_object().into_iter().flat_map(|m| m.keys()) {
        if ![
            "$schema",
            "$id",
            "$defs",
            "$ref",
            "title",
            "type",
            "const",
            "enum",
            "pattern",
            "minLength",
            "maxLength",
            "minimum",
            "maximum",
            "required",
            "properties",
            "additionalProperties",
            "propertyNames",
            "minProperties",
            "maxProperties",
            "items",
            "minItems",
            "maxItems",
            "uniqueItems",
            "anyOf",
            "oneOf",
            "allOf",
            "not",
            "if",
            "then",
            "else",
        ]
        .contains(&key.as_str())
        {
            return fail(format!("unsupported schema keyword {key}"));
        }
    }
    if let Some(reference) = s["$ref"].as_str() {
        let target = root
            .pointer(
                reference
                    .strip_prefix('#')
                    .ok_or("external schema reference")?,
            )
            .ok_or("unknown schema reference")?;
        check(target, v, root, at)?;
    }
    if let Some(types) = s.get("type") {
        let matches = |t: &Value| match t.as_str().unwrap_or("") {
            "null" => v.is_null(),
            "object" => v.is_object(),
            "array" => v.is_array(),
            "string" => v.is_string(),
            "boolean" => v.is_boolean(),
            "number" => v.is_number(),
            "integer" => {
                v.as_i64().is_some()
                    || v.as_u64().is_some()
                    || v.as_f64().is_some_and(|number| number.fract() == 0.0)
            }
            _ => false,
        };
        if !types
            .as_array()
            .map_or_else(|| matches(types), |ts| ts.iter().any(matches))
        {
            return fail(format!("expected {types}"));
        }
    }
    if s.get("const").is_some_and(|c| c != v) {
        return fail(format!("must be {}", s["const"]));
    }
    if s["enum"].as_array().is_some_and(|es| !es.contains(v)) {
        return fail("not in enum".into());
    }
    if let Some(text) = v.as_str() {
        if let Some(pattern) = s["pattern"].as_str() {
            if !regex::Regex::new(pattern)
                .map_err(|e| e.to_string())?
                .is_match(text)
            {
                return fail(format!("{text:?} does not match {pattern}"));
            }
        }
        for (key, too_short) in [("minLength", true), ("maxLength", false)] {
            if let Some(limit) = s[key].as_u64() {
                let len = text.chars().count() as u64;
                if (too_short && len < limit) || (!too_short && len > limit) {
                    return fail(format!("violates {key} {limit}"));
                }
            }
        }
    }
    if let Some(number) = v.as_f64() {
        for (key, minimum) in [("minimum", true), ("maximum", false)] {
            if let Some(limit) = s[key].as_f64() {
                if (minimum && number < limit) || (!minimum && number > limit) {
                    return fail(format!("violates {key} {limit}"));
                }
            }
        }
    }
    if let Some(object) = v.as_object() {
        for required in s["required"].as_array().into_iter().flatten() {
            if !object.contains_key(required.as_str().unwrap()) {
                return fail(format!("missing required field {required}"));
            }
        }
        for (key, value) in object {
            if let Some(names) = s.get("propertyNames") {
                check(names, &Value::String(key.clone()), root, at)?;
            }
            if let Some(property) = s["properties"].get(key) {
                check(property, value, root, &format!("{at}.{key}"))?;
            } else if s["additionalProperties"] == false {
                return fail(format!("unknown field {key}"));
            } else if s["additionalProperties"].is_object() {
                check(
                    &s["additionalProperties"],
                    value,
                    root,
                    &format!("{at}.{key}"),
                )?;
            }
        }
        bounds(s, object.len(), "Properties", at)?;
    }
    if let Some(array) = v.as_array() {
        bounds(s, array.len(), "Items", at)?;
        for (i, value) in array.iter().enumerate() {
            if s["uniqueItems"] == true && array[..i].contains(value) {
                return fail("items are not unique".into());
            }
            if let Some(items) = s.get("items") {
                check(items, value, root, &format!("{at}[{i}]"))?;
            }
        }
    }
    if let Some(all) = s["allOf"].as_array() {
        for branch in all {
            check(branch, v, root, at)?;
        }
    }
    for (key, one) in [("anyOf", false), ("oneOf", true)] {
        if let Some(branches) = s[key].as_array() {
            let matches = branches
                .iter()
                .filter(|b| check(b, v, root, at).is_ok())
                .count();
            if matches == 0 || (one && matches != 1) {
                return fail(format!("does not satisfy {key}"));
            }
        }
    }
    if s.get("not").is_some_and(|b| check(b, v, root, at).is_ok()) {
        return fail("matches a forbidden shape".into());
    }
    if let Some(condition) = s.get("if") {
        let branch = if check(condition, v, root, at).is_ok() {
            "then"
        } else {
            "else"
        };
        if let Some(branch) = s.get(branch) {
            check(branch, v, root, at)?;
        }
    }
    Ok(())
}

fn bounds(s: &Value, len: usize, suffix: &str, at: &str) -> std::result::Result<(), String> {
    for (prefix, minimum) in [("min", true), ("max", false)] {
        let key = format!("{prefix}{suffix}");
        if let Some(limit) = s[&key].as_u64() {
            if (minimum && (len as u64) < limit) || (!minimum && (len as u64) > limit) {
                return Err(format!("{at}: violates {key} {limit}"));
            }
        }
    }
    Ok(())
}
