//! Checksums used across the contract: of a part, of an entry, and of a view.
//!
//! Every checksum is the lowercase hex SHA-256 of a value's canonical JSON:
//! no whitespace, object keys sorted by their UTF-16 code units (as RFC 8785
//! does), strings escaped the way `serde_json` escapes them. Both sides
//! compute checksums with these functions, so they agree byte for byte.
//!
//! Draft note: floats are written in `serde_json`'s shortest round-trip form,
//! which differs from RFC 8785 only in exponent notation. When this contract
//! is published, it should use the same content digest as the published
//! `cortexkit-role-llm-runner` crate (`content_digest`) rather than this copy.

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

/// Canonical JSON text of a value.
pub fn canonical_json(value: &Value) -> String {
    let mut out = String::new();
    write_canonical(value, &mut out);
    out
}

fn write_canonical(value: &Value, out: &mut String) {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
            out.push('{');
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key).expect("a string always serializes"));
                out.push(':');
                write_canonical(&map[key], out);
            }
            out.push('}');
        }
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_canonical(item, out);
            }
            out.push(']');
        }
        other => out.push_str(&serde_json::to_string(other).expect("a scalar always serializes")),
    }
}

/// Lowercase hex SHA-256 of bytes.
pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Checksum of any serializable value: SHA-256 of its canonical JSON.
pub fn checksum<T: Serialize>(value: &T) -> String {
    let value = serde_json::to_value(value).expect("contract types always serialize");
    sha256_hex(canonical_json(&value).as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keys_sort_and_whitespace_goes() {
        let value = json!({"b": 1, "a": [true, null, "x"], "c": {"z": 1, "y": 2}});
        assert_eq!(
            canonical_json(&value),
            r#"{"a":[true,null,"x"],"b":1,"c":{"y":2,"z":1}}"#
        );
    }

    #[test]
    fn keys_sort_by_utf16_not_bytes() {
        // U+E000 is one UTF-16 unit (0xE000); U+1F600 is a surrogate pair
        // starting 0xD83D, so it sorts first in UTF-16 but last by UTF-8 bytes.
        let value = json!({"\u{E000}": 1, "\u{1F600}": 2});
        assert_eq!(canonical_json(&value), "{\"\u{1F600}\":2,\"\u{E000}\":1}");
    }

    #[test]
    fn same_value_same_checksum_whatever_the_key_order() {
        let left: Value = serde_json::from_str(r#"{"a":1,"b":2}"#).unwrap();
        let right: Value = serde_json::from_str(r#"{"b":2,"a":1}"#).unwrap();
        assert_eq!(checksum(&left), checksum(&right));
    }
}
