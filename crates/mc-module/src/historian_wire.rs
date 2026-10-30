//! Validate the historian's JSON response wrapper locally, without provider schema
//! enforcement. An invalid decision or score does not reject other items in the reply.
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashSet};

#[derive(Debug, PartialEq)]
pub enum TurnTwoEnvelope {
    Failure(&'static str),
    Valid {
        decisions: BTreeMap<i64, Value>,
        scores: Vec<Value>,
        schema_valid: bool,
    },
}

fn integer(value: &Value) -> Option<i64> {
    let number = value.as_f64()?;
    (number.is_finite() && number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0)
        .then_some(number as i64)
}

fn clauses(raw: Option<&Value>, added: bool) -> Option<Vec<Value>> {
    let Some(raw) = raw else { return Some(vec![]) };
    raw.as_array()?.iter().map(|entry| {
        let entry = entry.as_object()?;
        let block = integer(entry.get("block")?)?;
        let excerpt = entry.get("excerpt")?.as_str()?;
        if added {
            Some(json!({"text": entry.get("text")?.as_str()?, "block":block, "excerpt":excerpt}))
        } else {
            Some(json!({"memoryId":integer(entry.get("memory_id")?)?, "clause":integer(entry.get("clause")?)?, "block":block, "excerpt":excerpt}))
        }
    }).collect()
}

fn decision(raw: &Map<String, Value>, fact_id: i64, ordinal: usize) -> Option<Value> {
    let action = raw.get("action")?.as_str()?;
    let check = raw.get("check")?.as_str()?;
    let mut out = json!({"factId":fact_id,"ordinal":ordinal,"action":action,"check":check});
    match action {
        "new" | "abstain" => {}
        "conflict" | "retire" | "promote_rule" => {
            out["targetId"] = json!(integer(raw.get("target_id")?)?);
        }
        "covered" => {
            out["targetId"] = json!(integer(raw.get("target_id")?)?);
            out["revision"] = json!(integer(raw.get("revision")?)?);
            let clauses = raw.get("clauses")?.as_array()?;
            if clauses.is_empty() {
                return None;
            }
            out["clauses"] = json!(clauses.iter().map(integer).collect::<Option<Vec<_>>>()?);
            if let Some(excerpt) = raw.get("excerpt") {
                out["excerpt"] = json!(excerpt.as_str()?);
            }
        }
        "edit" | "replaces" | "merge" => {
            out["removed"] = json!(clauses(raw.get("removed"), false)?);
            out["replaced"] = json!(clauses(raw.get("replaced"), false)?);
            out["added"] = json!(clauses(raw.get("added"), true)?);
            out["kept"] = json!(raw.get("kept")?.as_array()?.iter().map(|entry| {
                Some(json!({"memoryId":integer(entry.get("memory_id")?)?,"clause":integer(entry.get("clause")?)?}))
            }).collect::<Option<Vec<Value>>>()?);
            out["finalText"] = json!(raw.get("final_text")?.as_str()?);
            if action == "merge" {
                let sources = raw.get("sources")?.as_array()?;
                if sources.len() < 2 {
                    return None;
                }
                out["sources"] = json!(sources.iter().map(|entry| {
                    Some(json!({"id":integer(entry.get("id")?)?,"revision":integer(entry.get("revision")?)?}))
                }).collect::<Option<Vec<Value>>>()?);
                out["survivorId"] = json!(integer(raw.get("survivor_id")?)?);
            } else {
                out["targetId"] = json!(integer(raw.get("target_id")?)?);
                out["revision"] = json!(integer(raw.get("revision")?)?);
            }
        }
        _ => return None,
    }
    Some(out)
}

pub fn parse_turn_two_envelope(
    text: &str,
    length_capped: bool,
    tool_activity: bool,
) -> TurnTwoEnvelope {
    use TurnTwoEnvelope::{Failure, Valid};
    if tool_activity {
        return Failure("tool_activity");
    }
    if length_capped {
        return Failure("length_capped");
    }
    let Ok(raw) = serde_json::from_str::<Value>(text) else {
        return Failure("unparseable");
    };
    let Some(result) = raw.get("result").and_then(Value::as_object) else {
        return Failure("schema_invalid");
    };
    if result.get("step").and_then(Value::as_str) != Some("turn_two") {
        return Failure("schema_invalid");
    }
    let Some(entries) = result.get("decisions").and_then(Value::as_array) else {
        return Failure("schema_invalid");
    };
    if result
        .get("scores")
        .is_some_and(|scores| !scores.is_array())
    {
        return Failure("schema_invalid");
    }
    let mut decisions = BTreeMap::new();
    let mut schema_valid = true;
    for (ordinal, entry) in entries.iter().enumerate() {
        let Some(raw) = entry.as_object() else {
            schema_valid = false;
            continue;
        };
        let Some(fact_id) = raw.get("fact_id").and_then(integer) else {
            schema_valid = false;
            continue;
        };
        // A repeated fact_id makes that fact's decision ambiguous, so it collapses
        // to malformed instead of keeping either entry.
        if let std::collections::btree_map::Entry::Occupied(mut existing) = decisions.entry(fact_id)
        {
            existing.insert(json!("malformed"));
            schema_valid = false;
            continue;
        }
        let parsed = decision(raw, fact_id, ordinal);
        if parsed.is_none()
            || matches!(
                raw.get("action").and_then(Value::as_str),
                Some("retire" | "promote_rule")
            )
        {
            schema_valid = false
        }
        decisions.insert(fact_id, parsed.unwrap_or(json!("malformed")));
    }
    let mut seen = HashSet::new();
    let mut scores: Vec<Value> = vec![];
    for entry in result
        .get("scores")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let item = entry.get("item").and_then(integer);
        if let Some(item) = item {
            if !seen.insert(item) {
                schema_valid = false;
                scores.retain(|score| score["item"] != item);
                continue;
            }
        }
        let importance = entry.get("importance").and_then(integer);
        let class = entry.get("class").and_then(Value::as_str);
        match (item, importance, class) {
            (Some(item), Some(importance @ 1..=100), Some(class))
                if (1..=64).contains(&class.encode_utf16().count()) =>
            {
                scores.push(json!({"item":item,"importance":importance,"proposedClass":class}))
            }
            _ => schema_valid = false,
        }
    }
    Valid {
        decisions,
        scores,
        schema_valid,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn historian_wire_equivalence_corpus() {
        let corpus: Vec<Value> =
            serde_json::from_str(include_str!("../testdata/historian-wire-corpus.json")).unwrap();
        assert_eq!(corpus.len(), 33);
        for entry in corpus {
            let parsed = parse_turn_two_envelope(
                entry["text"].as_str().unwrap(),
                entry["lengthCapped"].as_bool().unwrap_or(false),
                entry["toolActivity"].as_bool().unwrap_or(false),
            );
            let normalized = match parsed {
                TurnTwoEnvelope::Failure(reason) => json!({"ok":false,"reason":reason}),
                TurnTwoEnvelope::Valid {
                    decisions,
                    scores,
                    schema_valid,
                } => {
                    json!({"ok":true,"decisions": decisions.into_iter().collect::<Vec<_>>(),"scores":scores,"schemaValid":schema_valid})
                }
            };
            assert_eq!(normalized, entry["expected"], "{}", entry["name"]);
        }
    }
}
