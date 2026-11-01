use serde_json::Value;

/// Host-owned metadata is authoritative regardless of the registered tool name.
pub(crate) fn has_user_answer_metadata(value: &Value) -> bool {
    value.get("userAnswer").and_then(Value::as_bool) == Some(true)
        || value.get("answers").is_some_and(Value::is_array)
        || value.get("answer").is_some_and(Value::is_string)
        || value.get("selectedOptions").is_some_and(Value::is_array)
        || value.get("customInput").is_some_and(Value::is_string)
        || value
            .get("results")
            .and_then(Value::as_array)
            .is_some_and(|results| results.iter().any(has_user_answer_metadata))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ts_rust_parity_recognizes_structural_host_answer_metadata() {
        let cases: Vec<Value> = serde_json::from_str(include_str!(
            "../../../tests/fixtures/user-answer-metadata.json"
        ))
        .unwrap();
        for case in cases {
            assert_eq!(
                has_user_answer_metadata(&case["metadata"]),
                case["protected"].as_bool().unwrap(),
                "{case}"
            );
        }
    }
}
