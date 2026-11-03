//! The standalone plugin's canonical history text and chunk windows.
//!
//! Raw indexed conversation is the source; the title and most detailed summary
//! tier (p1) are a fallback only when the ordinal-to-FTS rowid mapping is
//! complete and the span has no indexable conversation.

use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Window {
    pub window_index: usize,
    pub start_ordinal: i64,
    pub end_ordinal: i64,
    pub text: String,
    pub chunk_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub(crate) struct FtsRow {
    pub ordinal: i64,
    pub role: String,
    pub content: String,
}

fn js_space(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}' |
        '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
        '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn trim(text: &str) -> &str {
    text.trim_matches(js_space)
}

pub(crate) fn canonical_text(rows: &[FtsRow]) -> String {
    let mut lines = Vec::new();
    let mut current: Option<(char, i64, i64, Vec<String>)> = None;
    let flush = |current: &mut Option<(char, i64, i64, Vec<String>)>, lines: &mut Vec<String>| {
        if let Some((role, start, end, parts)) = current.take() {
            let range = if start == end {
                format!("[{start}]")
            } else {
                format!("[{start}-{end}]")
            };
            lines.push(format!("{range} {role}: {}", parts.join(" / ")));
        }
    };
    for row in rows {
        let role = match row.role.as_str() {
            "user" => 'U',
            "assistant" => 'A',
            _ => continue,
        };
        let content = row
            .content
            .split(js_space)
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        if row.ordinal <= 0 || content.is_empty() {
            continue;
        }
        if let Some((current_role, _, end, parts)) = current.as_mut() {
            if *current_role == role {
                *end = row.ordinal;
                parts.push(content);
                continue;
            }
        }
        flush(&mut current, &mut lines);
        current = Some((role, row.ordinal, row.ordinal, vec![content]));
    }
    flush(&mut current, &mut lines);
    lines.join("\n")
}

pub(crate) fn summary_fallback(title: &str, p1: &str, content: &str) -> String {
    let body = if trim(p1).is_empty() { content } else { p1 };
    [trim(title), trim(body)]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn line_range(line: &str) -> Option<(i64, i64)> {
    let (range, tail) = line.strip_prefix('[')?.split_once(']')?;
    if !tail.starts_with(js_space)
        || !(trim(tail).starts_with("U:") || trim(tail).starts_with("A:"))
    {
        return None;
    }
    let (start, end) = range.split_once('-').unwrap_or((range, range));
    if !start.bytes().all(|b| b.is_ascii_digit()) || !end.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((start.parse().ok()?, end.parse().ok()?))
}

fn window(text: String, start: i64, end: i64, index: usize) -> Window {
    Window {
        chunk_hash: format!("{:x}", Sha256::digest(text.as_bytes())),
        text,
        start_ordinal: start,
        end_ordinal: end,
        window_index: index,
    }
}

pub(crate) fn windows(text: &str, start: i64, end: i64, max_tokens: u64) -> Option<Vec<Window>> {
    use mc_tokenizer::estimate_tokens as tokens;
    let lines: Vec<_> = text
        .split('\n')
        .map(trim)
        .filter(|s| !s.is_empty())
        .collect();
    if lines.is_empty() || end < start {
        return Some(Vec::new());
    }
    for line in &lines {
        if let Some((first, last)) = line_range(line) {
            if first < start || last > end || last < first {
                return None;
            }
        }
    }
    let budget = ((max_tokens.max(1) as f64 * 0.9).floor() as usize).max(1);
    let full = lines.join("\n");
    if tokens(&full) <= budget {
        return Some(vec![window(full, start, end, 0)]);
    }
    let mut out = Vec::new();
    let mut pending = Vec::new();
    let (mut first, mut last, mut count) = (start, start, 0);
    let flush = |out: &mut Vec<Window>, pending: &mut Vec<&str>, first, last| {
        if !pending.is_empty() {
            out.push(window(pending.join("\n"), first, last, out.len()));
            pending.clear();
        }
    };
    for line in lines {
        let (line_start, line_end) = line_range(line).unwrap_or((start, start));
        let size = tokens(line);
        if size > budget {
            flush(&mut out, &mut pending, first, last);
            count = 0;
            for slice in split_oversized(line, budget) {
                out.push(window(slice, line_start, line_end, out.len()));
            }
            continue;
        }
        if !pending.is_empty() && count + size > budget {
            flush(&mut out, &mut pending, first, last);
            count = 0;
        }
        if pending.is_empty() {
            first = line_start;
        }
        pending.push(line);
        last = line_end;
        count += size;
    }
    flush(&mut out, &mut pending, first, last);
    Some(out)
}

// JavaScript splits and slices by UTF-16 units. Keep units until a complete
// slice is emitted, so an astral character does not change packing boundaries.
fn unit_tokens(text: &[u16]) -> usize {
    mc_tokenizer::estimate_tokens(&String::from_utf16_lossy(text))
}

fn merge_splits(splits: &[Vec<u16>], separator: &[u16], budget: usize) -> Vec<Vec<u16>> {
    let mut out = Vec::new();
    let mut current: Vec<Vec<u16>> = Vec::new();
    let mut total = 0;
    let emit = |current: &[Vec<u16>], out: &mut Vec<Vec<u16>>| {
        let text = current.join(separator);
        let text = String::from_utf16_lossy(&text);
        let text = trim(&text);
        if !text.is_empty() {
            out.push(text.encode_utf16().collect());
        }
    };
    for part in splits {
        let length = unit_tokens(part);
        if total + length + current.len() * separator.len() > budget && !current.is_empty() {
            emit(&current, &mut out);
            while total > 0 && !current.is_empty() {
                total -= unit_tokens(&current.remove(0));
            }
        }
        current.push(part.clone());
        total += length;
    }
    emit(&current, &mut out);
    out
}

fn recursive_split(text: &[u16], separators: &[&str], budget: usize) -> Vec<Vec<u16>> {
    let index = separators
        .iter()
        .position(|s| {
            s.is_empty() || {
                let units: Vec<_> = s.encode_utf16().collect();
                text.windows(units.len()).any(|w| w == units)
            }
        })
        .unwrap();
    let separator: Vec<_> = separators[index].encode_utf16().collect();
    let splits: Vec<Vec<u16>> = if separator.is_empty() {
        text.iter().map(|c| vec![*c]).collect()
    } else {
        // All separators are ASCII and one unit except the paragraph break.
        let mut parts = Vec::new();
        let (mut start, mut pos) = (0, 0);
        while pos + separator.len() <= text.len() {
            if text[pos..].starts_with(&separator) {
                if pos > start {
                    parts.push(text[start..pos].to_vec());
                }
                pos += separator.len();
                start = pos;
            } else {
                pos += 1;
            }
        }
        if start < text.len() {
            parts.push(text[start..].to_vec());
        }
        parts
    };
    let mut out = Vec::new();
    let mut good = Vec::new();
    for part in splits {
        if unit_tokens(&part) < budget {
            good.push(part);
        } else {
            out.extend(merge_splits(&good, &separator, budget));
            good.clear();
            if index + 1 == separators.len() {
                out.push(part);
            } else {
                out.extend(recursive_split(&part, &separators[index + 1..], budget));
            }
        }
    }
    out.extend(merge_splits(&good, &separator, budget));
    out
}

fn char_budget_split(text: &[u16], budget: usize) -> Vec<Vec<u16>> {
    let ratio = (text.len() / unit_tokens(text).max(1)).max(1);
    let width = budget.saturating_mul(ratio).max(1);
    let mut out = Vec::new();
    let mut pos = 0;
    while pos < text.len() {
        let mut end = pos.saturating_add(width).min(text.len());
        while end - pos > 1 && unit_tokens(&text[pos..end]) > budget {
            end = pos + ((end - pos) / 2).max(1);
        }
        out.push(text[pos..end].to_vec());
        pos = end;
    }
    out
}

fn split_oversized(text: &str, budget: usize) -> Vec<String> {
    let units: Vec<_> = text.encode_utf16().collect();
    let mut slices = recursive_split(&units, &["\n\n", "\n", " ", ""], budget);
    if slices.is_empty() {
        slices = char_budget_split(&units, budget);
    }
    slices
        .into_iter()
        .flat_map(|s| {
            if unit_tokens(&s) <= budget {
                vec![s]
            } else {
                char_budget_split(&s, budget)
            }
        })
        .filter(|s| !s.is_empty())
        .map(|s| String::from_utf16_lossy(&s))
        .collect()
}

#[cfg(test)]
mod tests;
