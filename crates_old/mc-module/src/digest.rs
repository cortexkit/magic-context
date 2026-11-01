//! Byte-identical digest encoding without per-byte formatting or a JSON buffer.

use sha2::{Digest, Sha256};

pub(crate) fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = vec![0; bytes.len() * 2];
    for (pair, &byte) in output.as_chunks_mut::<2>().0.iter_mut().zip(bytes) {
        pair[0] = DIGITS[usize::from(byte >> 4)];
        pair[1] = DIGITS[usize::from(byte & 15)];
    }
    String::from_utf8(output).expect("hex digits are ASCII")
}

struct DigestWriter<'a>(&'a mut Sha256);

impl std::io::Write for DigestWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

pub(crate) fn json_value(value: &serde_json::Value) -> [u8; 32] {
    let mut hash = Sha256::new();
    // Preserve the former to_vec(...).unwrap_or_default() fallback, including
    // discarding any partially serialized bytes if serialization fails.
    if serde_json::to_writer(DigestWriter(&mut hash), value).is_err() {
        return Sha256::digest([]).into();
    }
    hash.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn hex_matches_lowercase_formatter_for_every_byte() {
        let bytes: Vec<_> = (0..=255).collect();
        let expected: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        assert_eq!(hex(&bytes), expected);
        assert_eq!(hex(&[]), "");
    }

    #[test]
    fn streamed_value_digest_matches_serialized_bytes() {
        for value in [
            json!(null),
            json!({"z":[true,false,1,-1,1.0,1e-30],"a":"\"\\\n\0é漢🙂"}),
            json!({"nested":{"provider":{"unknown":[{},[],"x"]}}}),
        ] {
            let bytes = serde_json::to_vec(&value).unwrap();
            assert_eq!(json_value(&value), <[u8; 32]>::from(Sha256::digest(bytes)));
        }
    }
}
