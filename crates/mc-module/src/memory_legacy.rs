//! The 0.49 history head's memory selection: the project block's budget trim
//! (with its workspace variant) and the user profile's. The head no longer
//! uses it ([`crate::head_memories`] chooses every level together); the
//! selection simulation keeps it to report what a head showed before, and a
//! test keeps the plugin's workspace vectors pinned against it.

use std::cmp::Ordering;
use std::collections::HashSet;

use crate::context_db::StoredMemory;
use crate::memory::{escape_content, render_line};

fn escape_attr(text: &str) -> String {
    escape_content(text).replace('"', "&quot;")
}

fn render_order(left: &StoredMemory, right: &StoredMemory) -> Ordering {
    let rank = |memory: &StoredMemory| {
        crate::memory::CATEGORY_ORDER
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
