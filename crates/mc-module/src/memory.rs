//! Project memories, the user profile and memory corrections as the history
//! head shows them. The selection order, budgets and bytes are the TypeScript
//! plugin's (`inject-compartments.ts`), so a head reads the same in both.

use std::cmp::Ordering;
use std::collections::HashSet;

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
    render_workspace_block(memories, wrapper, None)
}

pub fn render_workspace_block(
    memories: &[StoredMemory],
    wrapper: &str,
    workspace: Option<&crate::workspace::Workspace>,
) -> String {
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
        lines.push(render_workspace_line(memory, workspace));
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
pub fn trim_to_budget(
    mut memories: Vec<StoredMemory>,
    budget_tokens: u64,
    counter: crate::count::Counter,
) -> Vec<StoredMemory> {
    let estimate = |text: &str| counter.count(text);
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
pub fn trim_profile(
    profile: Vec<String>,
    budget_tokens: u64,
    counter: crate::count::Counter,
) -> Vec<String> {
    let mut used = 0;
    profile
        .into_iter()
        .filter(|content| {
            let cost = counter.count(&format!("- {content}")) + 4;
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

fn category_attribute(category: Option<&str>) -> String {
    category
        .filter(|category| !category.is_empty())
        .map(|category| format!(" category=\"{}\"", escape_attr(category)))
        .unwrap_or_default()
}

/// The `m[1]` line for a memory whose text was replaced.
pub fn updated_line(id: i64, category: Option<&str>, text: &str, source: Option<&str>) -> String {
    format!(
        "  <updated id=\"{id}\"{}{}>{}</updated>",
        category_attribute(category),
        project_attribute(source),
        escape_content(text)
    )
}

/// The `m[1]` line for a new memory, saved or produced by a merge.
pub fn added_line(id: i64, category: Option<&str>, text: &str, source: Option<&str>) -> String {
    format!(
        "  <added id=\"{id}\"{}{}>{}</added>",
        category_attribute(category),
        project_attribute(source),
        escape_content(text)
    )
}

pub fn removed_line(id: i64) -> String {
    format!("  <removed id=\"{id}\"/>")
}

pub fn superseded_line(id: i64, by: i64) -> String {
    format!("  <superseded id=\"{id}\" by=\"{by}\"/>")
}

fn project_attribute(source: Option<&str>) -> String {
    source
        .map(|name| format!(" project=\"{}\"", escape_attr(name)))
        .unwrap_or_default()
}

fn render_workspace_line(
    memory: &StoredMemory,
    workspace: Option<&crate::workspace::Workspace>,
) -> String {
    match workspace.and_then(|workspace| workspace.source_name(&memory.project_path)) {
        Some(name) => format!(
            "#{} [{}]: {}",
            memory.id,
            escape_content(name),
            escape_content(&memory.content)
        ),
        None => render_line(memory),
    }
}

/// Permanent rows precede equal per-member floors; the remainder fills by priority.
/// Candidate costs include source labels and category tags before admission.
pub fn trim_workspace_to_budget(
    mut memories: Vec<StoredMemory>,
    budget: u64,
    workspace: &crate::workspace::Workspace,
    counter: crate::count::Counter,
) -> Vec<StoredMemory> {
    if !workspace.is_workspaced() {
        return trim_to_budget(memories, budget, counter);
    }
    let estimate = |text: &str| counter.count(text);
    let mut used = estimate("<project-memory>\n</project-memory>");
    let mut categories = HashSet::new();
    let cost = |memory: &StoredMemory, categories: &HashSet<String>| {
        let mut cost = estimate(&(render_workspace_line(memory, Some(workspace)) + "\n"));
        if !categories.contains(&memory.category) {
            let category = escape_attr(&memory.category);
            cost += estimate(&format!("<{category}>\n</{category}>\n"));
        }
        cost
    };
    memories.sort_by(selection_order);
    let mut selected = Vec::new();
    let mut ids = HashSet::new();
    for memory in memories
        .iter()
        .filter(|memory| memory.status == "permanent")
    {
        let tokens = cost(memory, &categories);
        if used + tokens <= budget {
            used += tokens;
            categories.insert(memory.category.clone());
            ids.insert(memory.id);
            selected.push(memory.clone());
        }
    }
    let floor = budget.saturating_sub(used) as f64 / workspace.members.len() as f64;
    for member in &workspace.members {
        let mut member_tokens = 0;
        for memory in memories.iter().filter(|memory| {
            memory.status != "permanent"
                && workspace.member(&memory.project_path) == Some(member.as_str())
        }) {
            let tokens = cost(memory, &categories);
            if (member_tokens + tokens) as f64 > floor || used + tokens > budget {
                continue;
            }
            used += tokens;
            member_tokens += tokens;
            categories.insert(memory.category.clone());
            ids.insert(memory.id);
            selected.push(memory.clone());
        }
    }
    for memory in memories {
        if ids.contains(&memory.id) {
            continue;
        }
        let tokens = cost(&memory, &categories);
        if used + tokens <= budget {
            used += tokens;
            categories.insert(memory.category.clone());
            selected.push(memory);
        }
    }
    selected
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
        let kept: Vec<i64> = trim_to_budget(memories, 40, crate::count::Counter::for_model(None))
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
