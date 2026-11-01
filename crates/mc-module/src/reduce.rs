//! `ctx_reduce`: the model names tag numbers it no longer needs, and ck-mc
//! holds them for the next view. Nothing is dropped by the call itself; the
//! drops land on the next pass that may rebuild.

/// The most numbers one range may name, so a typo such as `1-999999999`
/// cannot make a call expand into millions of numbers.
pub const MAX_RANGE: u64 = 10_000;

/// Parse a drop list such as `3-5,8,§12§`: numbers and inclusive ranges,
/// separated by commas, with optional section signs around a number.
pub fn parse_tags(spec: &str) -> Result<Vec<u64>, String> {
    let mut tags = Vec::new();
    for item in spec.split(',') {
        let item: String = item
            .chars()
            .filter(|c| *c != '§' && !c.is_whitespace())
            .collect();
        if item.is_empty() {
            continue;
        }
        let number = |text: &str| {
            text.parse::<u64>()
                .map_err(|_| format!("`{item}` is not a tag number or a range"))
        };
        match item.split_once('-') {
            Some((low, high)) => {
                let (low, high) = (number(low)?, number(high)?);
                if low > high {
                    return Err(format!("range `{item}` runs backwards"));
                }
                if high - low >= MAX_RANGE {
                    return Err(format!("range `{item}` names more than {MAX_RANGE} tags"));
                }
                tags.extend(low..=high);
            }
            None => tags.push(number(&item)?),
        }
    }
    tags.sort_unstable();
    tags.dedup();
    if tags.is_empty() {
        return Err("no tag numbers given".into());
    }
    Ok(tags)
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
}
