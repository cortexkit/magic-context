//! Text cut by UTF-16 code units, the way the TypeScript plugin measures
//! string length, so limits mean the same thing on both sides.

/// The first `requested` UTF-16 code units of `units`. A cut that would end
/// on the first half of a surrogate pair stops one unit earlier, so the
/// result is always valid text.
pub fn string_from_utf16_prefix(units: &[u16], requested: usize) -> String {
    let mut end = requested.min(units.len());
    if end > 0 && (0xD800..=0xDBFF).contains(&units[end - 1]) {
        end -= 1;
    }
    String::from_utf16_lossy(&units[..end])
}

/// Tool argument excerpts keep at most 60 UTF-16 code units, then an ellipsis.
pub(crate) fn truncate_arg(value: &str) -> String {
    truncate_units(value, 60)
}

pub(crate) fn truncate_units(value: &str, max: usize) -> String {
    let units: Vec<u16> = value.encode_utf16().collect();
    if units.len() <= max {
        return value.to_owned();
    }
    format!("{}…", string_from_utf16_prefix(&units, max))
}
