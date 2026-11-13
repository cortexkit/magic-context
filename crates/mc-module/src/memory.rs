//! How the history head writes memories: the memory blocks of `m[0]`, the
//! user profile's bullets, and the memory-update lines of `m[1]`. Which
//! memories it shows is chosen in [`crate::head_memories`].

use std::cmp::Ordering;

use crate::context_db::StoredMemory;

/// Render order of the five memory categories.
pub(crate) const CATEGORY_ORDER: [&str; 5] = [
    "PROJECT_RULES",
    "ARCHITECTURE",
    "CONSTRAINTS",
    "CONFIG_VALUES",
    "NAMING",
];

fn escape_attr(text: &str) -> String {
    escape_content(text).replace('"', "&quot;")
}

pub(crate) fn escape_content(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
/// The fixed category order, unknown tags after it by name, then id.
fn tag_order(left: (&str, i64), right: (&str, i64)) -> Ordering {
    let rank = |tag: &str| CATEGORY_ORDER.iter().position(|category| *category == tag);
    match (rank(left.0), rank(right.0)) {
        (Some(left_rank), Some(right_rank)) => {
            left_rank.cmp(&right_rank).then(left.1.cmp(&right.1))
        }
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => left.0.cmp(right.0).then(left.1.cmp(&right.1)),
    }
}

/// Already rendered lines, each with its category tag and memory id,
/// grouped by tag inside `<wrapper>` in the order of [`render_block`], or
/// nothing.
pub fn render_lines(mut lines: Vec<(String, i64, String)>, wrapper: &str) -> String {
    if lines.is_empty() {
        return String::new();
    }
    lines.sort_by(|left, right| tag_order((&left.0, left.1), (&right.0, right.1)));
    let mut out = vec![format!("<{wrapper}>")];
    let mut open: Option<&str> = None;
    for (tag, _, line) in &lines {
        if open != Some(tag.as_str()) {
            if let Some(category) = open {
                out.push(format!("</{}>", escape_attr(category)));
            }
            open = Some(tag);
            out.push(format!("<{}>", escape_attr(tag)));
        }
        out.push(line.clone());
    }
    if let Some(category) = open {
        out.push(format!("</{}>", escape_attr(category)));
    }
    out.push(format!("</{wrapper}>"));
    out.join("\n")
}

/// `#id: fact`. Importance decides selection but is left off the line, so
/// re-scoring a memory never changes the bytes.
pub fn render_line(memory: &StoredMemory) -> String {
    let mut end = memory.content.len().min(64 * 1024);
    while !memory.content.is_char_boundary(end) {
        end -= 1;
    }
    let content = escape_content(&memory.content[..end]).replace('\n', "\n  ");
    format!("#{}: {content}", memory.id)
}

/// The memories grouped by category inside `<wrapper>`, or nothing.
pub fn render_block(memories: &[StoredMemory], wrapper: &str) -> String {
    render_lines(
        memories
            .iter()
            .map(|memory| (memory.category.clone(), memory.id, render_line(memory)))
            .collect(),
        wrapper,
    )
}

/// `User prefers X` reads as `Prefers X` under the profile heading.
fn profile_line(content: &str) -> String {
    let content = match content.strip_prefix("User ") {
        Some(rest) => {
            let mut chars = rest.chars();
            chars.next().map_or(String::new(), |first| {
                first.to_uppercase().chain(chars).collect()
            })
        }
        None => content.to_owned(),
    };
    format!("- {}", escape_content(&content))
}

/// The profile inside `<wrapper>`, or nothing.
pub fn render_profile(profile: &[String], wrapper: &str) -> String {
    if profile.is_empty() {
        return String::new();
    }
    let mut lines = vec![format!("<{wrapper}>")];
    lines.extend(profile.iter().map(|content| profile_line(content)));
    lines.push(format!("</{wrapper}>"));
    lines.join("\n")
}

fn category_attribute(category: Option<&str>) -> String {
    category
        .filter(|category| !category.is_empty())
        .map(|category| format!(" category=\"{}\"", escape_attr(category)))
        .unwrap_or_default()
}

/// The `m[1]` line for a memory whose text was replaced. `level` says which
/// block of the head the memory belongs to (`global` for the user profile).
pub fn updated_line(
    id: i64,
    level: &str,
    category: Option<&str>,
    text: &str,
    source: Option<&str>,
) -> String {
    format!(
        "  <updated id=\"{id}\" level=\"{}\"{}{}>{}</updated>",
        escape_attr(level),
        category_attribute(category),
        project_attribute(source),
        escape_content(text)
    )
}

/// The `m[1]` line for a new memory, saved or produced by a merge.
pub fn added_line(
    id: i64,
    level: &str,
    category: Option<&str>,
    text: &str,
    source: Option<&str>,
) -> String {
    format!(
        "  <added id=\"{id}\" level=\"{}\"{}{}>{}</added>",
        escape_attr(level),
        category_attribute(category),
        project_attribute(source),
        escape_content(text)
    )
}

pub fn removed_line(id: i64, level: &str) -> String {
    format!("  <removed id=\"{id}\" level=\"{}\"/>", escape_attr(level))
}

pub fn superseded_line(id: i64, level: &str, by: i64) -> String {
    format!(
        "  <superseded id=\"{id}\" level=\"{}\" by=\"{by}\"/>",
        escape_attr(level)
    )
}

fn project_attribute(source: Option<&str>) -> String {
    source
        .map(|name| format!(" project=\"{}\"", escape_attr(name)))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory(id: i64, category: &str, content: &str, importance: i32) -> StoredMemory {
        StoredMemory {
            id,
            project_path: "pj".into(),
            category: category.into(),
            content: content.into(),
            importance: Some(importance),
            status: "active".into(),
            ..StoredMemory::default()
        }
    }

    #[test]
    fn blocks_group_by_category_in_the_fixed_order() {
        let block = render_block(
            &[
                memory(3, "NAMING", "snake case", 50),
                memory(1, "PROJECT_RULES", "never <push>", 90),
                memory(2, "PROJECT_RULES", "ask first", 80),
            ],
            "project-memory",
        );
        assert_eq!(
            block,
            "<project-memory>\n<PROJECT_RULES>\n#1: never &lt;push&gt;\n#2: ask first\n</PROJECT_RULES>\n<NAMING>\n#3: snake case\n</NAMING>\n</project-memory>"
        );
    }

    #[test]
    fn profile_lines_drop_the_user_prefix() {
        assert_eq!(
            render_profile(&["User prefers short answers".into()], "user-profile"),
            "<user-profile>\n- Prefers short answers\n</user-profile>"
        );
    }
}
