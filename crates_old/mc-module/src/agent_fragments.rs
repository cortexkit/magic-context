//! The Rust twin of composeSoftMemoryUpdates. Inputs are previously served memory
//! bytes and immutable agent-operation fragments; current canonical rows must not
//! influence this delta composer.

use mc_store::memory_projection::{AgentFragment, AppliedProjection, CommittedFragment};

pub const HEADER: &str = "These memories changed since the snapshot below — trust these:";

pub fn updates(lines: &[String]) -> String {
    if lines.is_empty() {
        String::new()
    } else {
        format!(
            "<memory-updates>\n{}\n</memory-updates>",
            std::iter::once(HEADER.to_string())
                .chain(lines.iter().cloned())
                .collect::<Vec<_>>()
                .join("\n")
        )
    }
}

pub fn block(text: &str, tag: &str) -> String {
    let open = format!("<{tag}>\n");
    let close = format!("\n</{tag}>");
    text.find(&open)
        .and_then(|start| {
            text[start..]
                .find(&close)
                .map(|end| text[start..start + end + close.len()].to_string())
        })
        .unwrap_or_default()
}

fn hard_lines(text: &str) -> Vec<String> {
    let text = block(text, "memory-updates");
    if text.is_empty() {
        return Vec::new();
    }
    let body = text
        .strip_prefix("<memory-updates>\n")
        .unwrap()
        .strip_suffix("\n</memory-updates>")
        .unwrap();
    body.strip_prefix(&format!("{HEADER}\n"))
        .unwrap_or(body)
        .lines()
        .map(str::to_string)
        .collect()
}

fn overflow_line(ids: &[i64], count: usize) -> String {
    let mut seen = std::collections::HashSet::new();
    let mut listed = String::new();
    for id in ids {
        if !seen.insert(id) {
            continue;
        }
        let next = if listed.is_empty() {
            id.to_string()
        } else {
            format!("{listed},{id}")
        };
        if next.len() > 120 {
            listed.push_str(",…");
            break;
        }
        listed = next;
    }
    format!("  <more-memory-edits count=\"{count}\" ids=\"{listed}\" note=\"{count} more memory edits apply at the next rebuild; read them with ctx_search\"/>")
}

#[allow(clippy::too_many_arguments)]
pub fn compose(
    mut projection: AppliedProjection,
    pending: &[AgentFragment],
    memory_budget: f64,
    history_budget: f64,
    independent_tokens: usize,
    m0_tokens: usize,
    estimate: impl Fn(&str) -> usize,
) -> (String, AppliedProjection) {
    let hard = hard_lines(&projection.hard_memory_block);
    let mut committed = projection
        .committed
        .iter()
        .filter(|entry| entry.form != "overflow")
        .cloned()
        .collect::<Vec<_>>();
    let mut overflow = projection
        .committed
        .iter()
        .find(|entry| entry.form == "overflow")
        .cloned();
    let line_cost = |lines: &[String]| {
        lines
            .iter()
            .map(|line| estimate(&format!("{line}\n")))
            .sum::<usize>()
    };
    let mut used_full = estimate(&format!("<memory-updates>\n{HEADER}\n</memory-updates>\n"))
        + line_cost(&hard)
        + committed
            .iter()
            .filter(|entry| entry.form == "full")
            .map(|entry| line_cost(&entry.lines))
            .sum::<usize>();
    let mut used_markers = committed
        .iter()
        .filter(|entry| entry.form == "marker")
        .map(|entry| line_cost(&entry.lines))
        .sum::<usize>();
    let mut full_lines = hard.len()
        + committed
            .iter()
            .filter(|entry| entry.form == "full")
            .map(|entry| entry.lines.len())
            .sum::<usize>();
    let allowance = (memory_budget * 0.25).floor().max(0.0) as usize;
    let reserve = 200.min(allowance / 2);
    let cap = if m0_tokens >= 500 {
        (history_budget * 0.2).min(m0_tokens as f64 * 0.15)
    } else {
        history_budget * 0.2
    };
    let full_budget = (allowance - reserve) as f64;
    let full_budget = full_budget.min((cap - independent_tokens as f64).max(0.0));
    for fragment in pending {
        if overflow.is_none() {
            let cost = line_cost(&fragment.lines);
            if (used_full + cost) as f64 <= full_budget && full_lines + fragment.lines.len() <= 40 {
                committed.push(CommittedFragment {
                    id: fragment.id,
                    dashboard_log_id: fragment.dashboard_log_id,
                    form: "full".into(),
                    overflow_ids: Vec::new(),
                    overflow_count: None,
                    lines: fragment.lines.clone(),
                    visible_texts: fragment.visible_texts.clone(),
                });
                used_full += cost;
                full_lines += fragment.lines.len();
                continue;
            }
            let ids = fragment
                .memory_ids
                .iter()
                .map(i64::to_string)
                .collect::<Vec<_>>()
                .join(",");
            let current = fragment
                .current_id
                .map(|id| format!(" current=\"{id}\""))
                .unwrap_or_default();
            let marker =
                format!("  <stale-memory ids=\"{ids}\"{current} read-with=\"ctx_search\"/>");
            let cost = line_cost(std::slice::from_ref(&marker));
            if used_markers + cost <= reserve {
                committed.push(CommittedFragment {
                    id: fragment.id,
                    dashboard_log_id: fragment.dashboard_log_id,
                    form: "marker".into(),
                    overflow_ids: Vec::new(),
                    overflow_count: None,
                    lines: vec![marker],
                    visible_texts: Vec::new(),
                });
                used_markers += cost;
                continue;
            }
            overflow = Some(CommittedFragment {
                id: fragment.id,
                dashboard_log_id: fragment.dashboard_log_id,
                form: "overflow".into(),
                overflow_ids: Vec::new(),
                overflow_count: Some(0),
                lines: Vec::new(),
                visible_texts: Vec::new(),
            });
        }
        let entry = overflow.as_mut().unwrap();
        entry.id = entry.id.max(fragment.id);
        if fragment.dashboard_log_id.is_some() {
            entry.dashboard_log_id = fragment.dashboard_log_id;
        }
        entry.overflow_ids.extend(&fragment.memory_ids);
        entry.overflow_count = Some(entry.overflow_count.unwrap_or(0) + 1);
    }
    if let Some(mut entry) = overflow {
        entry.lines = vec![overflow_line(
            &entry.overflow_ids,
            entry.overflow_count.unwrap_or(0),
        )];
        committed.push(entry);
    }
    let lines = hard
        .into_iter()
        .chain(
            committed
                .iter()
                .flat_map(|entry| entry.lines.iter().cloned()),
        )
        .collect::<Vec<_>>();
    projection.committed = committed;
    (updates(&lines), projection)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ts_pi_rust_fragment_bytes_match_shared_randomized_fixture() {
        let cases: Vec<serde_json::Value> = serde_json::from_str(include_str!(
            "../tests/fixtures/agent-fragments-golden.json"
        ))
        .unwrap();
        assert_eq!(cases.len(), 164);
        for (index, case) in cases.iter().enumerate() {
            let before = &case["before"];
            let projection = AppliedProjection {
                committed: serde_json::from_value(before["committed"].clone()).unwrap(),
                fragment_watermark: before["fragmentWatermark"].as_i64().unwrap(),
                ..Default::default()
            };
            let expected: Vec<CommittedFragment> =
                serde_json::from_value(case["committed"].clone()).unwrap();
            if case["pass"] != "soft" {
                assert_eq!(projection.committed, expected, "pass {index}");
                continue;
            }
            let pending: Vec<AgentFragment> =
                serde_json::from_value(case["pending"].clone()).unwrap();
            let (block, rendered) = compose(
                projection,
                &pending,
                case["memoryBudgetTokens"].as_f64().unwrap(),
                case["historyBudgetTokens"].as_f64().unwrap(),
                case["independentTokens"].as_u64().unwrap() as usize,
                case["m0Tokens"].as_u64().unwrap() as usize,
                mc_tokenizer::estimate_tokens,
            );
            assert_eq!(block, case["block"].as_str().unwrap(), "pass {index}");
            assert_eq!(rendered.committed, expected, "pass {index}");
        }
    }
}
