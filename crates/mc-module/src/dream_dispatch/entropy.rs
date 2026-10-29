use crate::dream_runner::CarrierError;

pub(super) fn secret() -> Result<String, CarrierError> {
    let mut bytes = [0_u8; 32];
    // Authorization secrets require OS entropy; failure must never produce a
    // predictable fallback credential.
    getrandom::getrandom(&mut bytes).map_err(|error| CarrierError {
        message: error.to_string(),
        retryable: false,
    })?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_are_32_bytes_and_distinct() {
        let decode = |secret: String| {
            assert_eq!(secret.len(), 64);
            secret
                .as_bytes()
                .as_chunks::<2>()
                .0
                .iter()
                .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
                .collect::<Vec<_>>()
        };
        let first = decode(secret().unwrap());
        let second = decode(secret().unwrap());
        assert_eq!(first.len(), 32);
        assert_eq!(second.len(), 32);
        assert_ne!(first, second);
    }
}
