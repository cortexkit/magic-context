//! Project memories, the user profile and memory corrections as the history
//! head shows them. The selection order, budgets and bytes are the TypeScript
//! plugin's (`inject-compartments.ts`), so a head reads the same in both.

use std::cmp::Ordering;
use std::collections::HashSet;

use crate::context_db::{StoredMemory, StoredMutation};

/// Render order of the five memory categories.
const CATEGORY_ORDER: [&str; 5] = [
    "PROJECT_RULES",
    "ARCHITECTURE",
    "CONSTRAINTS",
    "CONFIG_VALUES",
    "NAMING",
];

fn escape_attr(text: &str) -> String {
    escape_content(text).replace('"', "&quot;")
}

fn escape_content(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn render_order(left: &StoredMemory, right: &StoredMemory) -> Ordering {
    let rank = |memory: &StoredMemory| {
        CATEGORY_ORDER
            .iter()
            .position(|category| *category == memory.category)
    };
    match (rank(left), rank(right)) {
        (Some(left_rank), Some(right_rank)) => {
            left_rank.cmp(&right_rank).then(left.id.cmp(&right.id))
        }
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => left
            .category
            .cmp(&right.category)
            .then(left.id.cmp(&right.id)),
    }
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
    if memories.is_empty() {
        return String::new();
    }
    let mut ordered: Vec<&StoredMemory> = memories.iter().collect();
    ordered.sort_by(|left, right| render_order(left, right));
    let mut lines = vec![format!("<{wrapper}>")];
    let mut open: Option<&str> = None;
    for memory in ordered {
        if open != Some(memory.category.as_str()) {
            if let Some(category) = open {
                lines.push(format!("</{}>", escape_attr(category)));
            }
            open = Some(&memory.category);
            lines.push(format!("<{}>", escape_attr(&memory.category)));
        }
        lines.push(render_line(memory));
    }
    if let Some(category) = open {
        lines.push(format!("</{}>", escape_attr(category)));
    }
    lines.push(format!("</{wrapper}>"));
    lines.join("\n")
}

/// Permanent memories first, then importance, then the latest time a memory
/// was seen again or verified, newest first.
fn selection_order(left: &StoredMemory, right: &StoredMemory) -> Ordering {
    let permanent = |memory: &StoredMemory| memory.status == "permanent";
    if permanent(left) != permanent(right) {
        return permanent(right).cmp(&permanent(left));
    }
    let reinforced = |memory: &StoredMemory| {
        memory
            .last_seen_at
            .into_iter()
            .chain(memory.verified_at)
            .max()
    };
    right
        .importance
        .unwrap_or(i32::MIN)
        .cmp(&left.importance.unwrap_or(i32::MIN))
        .then_with(|| match (reinforced(left), reinforced(right)) {
            (None, None) => left.id.cmp(&right.id),
            (None, Some(_)) => Ordering::Greater,
            (Some(_), None) => Ordering::Less,
            (Some(left_at), Some(right_at)) => right_at.cmp(&left_at),
        })
}

/// The memories that fit `budget_tokens` once rendered, counting each
/// category's tags once.
pub fn trim_to_budget(mut memories: Vec<StoredMemory>, budget_tokens: u64) -> Vec<StoredMemory> {
    let estimate = |text: &str| mc_tokenizer::estimate_tokens(text) as u64;
    let budget = budget_tokens.max(1);
    let mut used = estimate("<project-memory>\n</project-memory>");
    let mut categories = HashSet::new();
    memories.sort_by(selection_order);
    memories
        .into_iter()
        .filter(|memory| {
            let mut cost = estimate(&(render_line(memory) + "\n"));
            if !categories.contains(&memory.category) {
                cost += estimate(&format!("<{0}>\n</{0}>\n", memory.category));
            }
            if used + cost > budget {
                return false;
            }
            used += cost;
            categories.insert(memory.category.clone());
            true
        })
        .collect()
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

/// The user profile lines that fit `budget_tokens`, oldest first.
pub fn trim_profile(profile: Vec<String>, budget_tokens: u64) -> Vec<String> {
    let mut used = 0;
    profile
        .into_iter()
        .filter(|content| {
            let cost = mc_tokenizer::estimate_tokens(&format!("- {content}")) as u64 + 4;
            if used + cost > budget_tokens.max(1) {
                return false;
            }
            used += cost;
            true
        })
        .collect()
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

/// `<memory-updates>`: what changed in memories the head already shows, so
/// the model trusts these over the older lines. A replacement shown in the
/// head is named; otherwise the memory reads as removed.
pub fn render_updates(mutations: &[StoredMutation], shown: &HashSet<i64>) -> String {
    if mutations.is_empty() {
        return String::new();
    }
    let mut lines =
        vec!["These memories changed since the snapshot below — trust these:".to_owned()];
    for mutation in mutations {
        let line = match mutation.mutation_type.as_str() {
            "update" => {
                let category = mutation
                    .category
                    .as_deref()
                    .filter(|category| !category.is_empty())
                    .map(|category| format!(" category=\"{}\"", escape_attr(category)))
                    .unwrap_or_default();
                format!(
                    "  <updated id=\"{}\"{category}>{}</updated>",
                    mutation.target_memory_id,
                    escape_content(mutation.new_content.as_deref().unwrap_or(""))
                )
            }
            "superseded" => match mutation.superseded_by_id {
                Some(by) if shown.contains(&by) => {
                    format!(
                        "  <superseded id=\"{}\" by=\"{by}\"/>",
                        mutation.target_memory_id
                    )
                }
                _ => format!("  <removed id=\"{}\"/>", mutation.target_memory_id),
            },
            _ => format!("  <removed id=\"{}\"/>", mutation.target_memory_id),
        };
        lines.push(line);
    }
    format!("<memory-updates>\n{}\n</memory-updates>", lines.join("\n"))
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
    fn the_budget_keeps_permanent_and_important_memories_first() {
        let mut permanent = memory(9, "NAMING", "kept", 1);
        permanent.status = "permanent".into();
        let memories = vec![
            memory(1, "NAMING", &"x".repeat(400), 90),
            memory(2, "NAMING", "small", 80),
            permanent,
        ];
        let kept: Vec<i64> = trim_to_budget(memories, 40)
            .iter()
            .map(|memory| memory.id)
            .collect();
        assert_eq!(kept, vec![9, 2]);
    }

    #[test]
    fn profile_lines_drop_the_user_prefix() {
        assert_eq!(
            render_profile(&["User prefers short answers".into()], "user-profile"),
            "<user-profile>\n- Prefers short answers\n</user-profile>"
        );
    }
}
