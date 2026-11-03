//! `ctx_reduce`: the model names tag numbers it no longer needs, and ck-mc
//! holds them for the next view. Nothing is dropped by the call itself; the
//! drops land on the next pass that may rebuild.

/// The most numbers one range may name, so a typo such as `1-999999999`
/// cannot make a call expand into millions of numbers.
pub const MAX_RANGE: u64 = 1_000;

/// Parse a tag list like [`parse_tags`], keeping the order given and the
/// first of any repeat.
pub fn parse_tags_in_order(spec: &str) -> Result<Vec<u64>, String> {
    use std::sync::OnceLock;
    static DROPPED: OnceLock<regex::Regex> = OnceLock::new();
    static TAG_WORD: OnceLock<regex::Regex> = OnceLock::new();
    static HANDLE: OnceLock<regex::Regex> = OnceLock::new();
    let dropped = DROPPED.get_or_init(|| regex::Regex::new(r"\[dropped\s+§(\d+)§\]").unwrap());
    let tag_word = TAG_WORD.get_or_init(|| regex::Regex::new(r"tag\s+(\d+)").unwrap());
    let handle = HANDLE.get_or_init(|| regex::Regex::new(r"§(\d+)§?").unwrap());
    let normalized = dropped.replace_all(spec, "$1");
    let normalized = tag_word.replace_all(&normalized, "$1");
    let normalized = handle.replace_all(&normalized, "$1");
    let normalized = normalized.trim();
    if normalized.is_empty() {
        return Err("Range string must not be empty".into());
    }
    let mut tags = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for item in normalized.split(',') {
        let item = item.trim();
        let number = |value: &str| {
            let value = value.trim();
            if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err(format!("Invalid integer: \"{value}\""));
            }
            value
                .parse::<u64>()
                .map_err(|_| format!("Invalid integer: \"{value}\""))
        };
        let (low, high) = match item.split_once('-') {
            Some((low, high)) => (number(low)?, number(high)?),
            None => {
                let tag = number(item)?;
                (tag, tag)
            }
        };
        if low > high {
            return Err(format!(
                "Invalid range \"{item}\": start ({low}) must be <= end ({high})"
            ));
        }
        let size = u128::from(high) - u128::from(low) + 1;
        if size > u128::from(MAX_RANGE) {
            return Err(format!(
                "Range \"{item}\" exceeds maximum size of {MAX_RANGE} elements (got {size})"
            ));
        }
        for tag in low..=high {
            if seen.insert(tag) {
                tags.push(tag);
            }
        }
    }
    if tags.len() > MAX_RANGE as usize {
        return Err(format!(
            "Total range size exceeds maximum of {MAX_RANGE} elements (got {})",
            tags.len()
        ));
    }
    Ok(tags)
}

/// Parse a drop list such as `3-5,8,§12§`: numbers and inclusive ranges,
/// separated by commas, with optional section signs around a number.
pub fn parse_tags(spec: &str) -> Result<Vec<u64>, String> {
    let mut tags = parse_tags_in_order(spec)?;
    tags.sort_unstable();
    Ok(tags)
}

/// The plugin's acknowledgement, including calls it leaves for automatic cleanup.
pub fn reply(stamped: usize, self_stamps: usize) -> String {
    let mut parts = Vec::new();
    if stamped > 0 {
        parts.push(format!(
            "{stamped} tag{} stamped.",
            if stamped == 1 { "" } else { "s" }
        ));
    }
    match self_stamps {
        0 => {}
        1 => parts.push(
            "1 was a ctx_reduce call; leave those alone, they are cleaned up automatically.".into(),
        ),
        n => parts.push(format!(
            "{n} were ctx_reduce calls; leave those alone, they are cleaned up automatically."
        )),
    }
    parts.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_ranges_and_section_signs_parse() {
        assert_eq!(parse_tags("3-5, 8,§12§,5").unwrap(), [3, 4, 5, 8, 12]);
        assert!(parse_tags("5-3").is_err());
        assert!(parse_tags("x").is_err());
        assert!(parse_tags(" , ").is_err());
        assert!(parse_tags("1-999999999").is_err());
    }

    #[test]
    fn surface_range_and_total_limits_match_the_plugin_for_reduce_and_keep() {
        for parse in [parse_tags, parse_tags_in_order] {
            assert!(parse("1-1001").is_err());
            assert!(parse("1-1000,1001").is_err());
            assert_eq!(parse("1-1000,1-1000").unwrap().len(), 1000);
        }
    }
}
