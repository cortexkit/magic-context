//! Checksums used across the contract: of a part, of an entry, and of a view.
//!
//! Every checksum is the lowercase hex SHA-256 of a value's RFC 8785 (JCS)
//! serialization, computed by llm-runner's shared `content_digest`, so this
//! contract and llm-runner agree byte for byte and no second implementation
//! can drift. Absent optional fields are left out of every contract type, so
//! they never enter a checksum. Floats occur (a tool's `input` is any JSON),
//! and JCS fixes their form.

use serde::Serialize;

pub use cortexkit_role_llm_runner::content_digest::content_digest;

/// Checksum of any serializable contract value.
pub fn checksum<T: Serialize>(value: &T) -> String {
    let value = serde_json::to_value(value).expect("contract types always serialize");
    content_digest(&value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn same_value_same_checksum_whatever_the_key_order() {
        let left: Value = serde_json::from_str(r#"{"a":1,"b":2}"#).unwrap();
        let right: Value = serde_json::from_str(r#"{"b":2,"a":1}"#).unwrap();
        assert_eq!(checksum(&left), checksum(&right));
    }

    #[test]
    fn floats_hash_in_their_jcs_form() {
        // JCS writes 1e21 and 1.0e21 the same way; a hand-written form that
        // kept serde_json's text would not.
        let written: Value = serde_json::from_str(r#"{"x":1e21}"#).unwrap();
        let other: Value = serde_json::from_str(r#"{"x":1.0e21}"#).unwrap();
        assert_eq!(checksum(&written), checksum(&other));
        assert_ne!(checksum(&json!({"x": 1.5})), checksum(&json!({"x": 1.25})));
    }
}
