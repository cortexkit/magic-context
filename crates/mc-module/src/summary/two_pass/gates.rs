//! The deterministic gates a historian revision (`edit`, `merge`,
//! `replaces`) must pass before any model check is spent, and the narrow
//! checks themselves: their requests, prompts and verdicts. Ported from the
//! plugin's `memory/lifecycle-gates.ts`.
//!
//! The plugin also matches each check reply's reported model against the
//! first turn's frozen identity. ck-mc names the model on every call and the
//! runner reports none back, so every check runs on the first turn's model,
//! variant and generation settings, and no reply is matched against an
//! identity.

use serde_json::{json, Value};

use super::constants::{KEPT_CHECK_INPUT_MAX, NARROW_CHECK_CALL_CEILING};
use super::text::{
    lifecycle_text_hash, match_fact_evidence, scan_concrete_tokens, split_memory_clauses,
    EvidenceBlock, EvidenceSpan,
};

/// The reply contract every check states.
pub const CHECK_SCHEMA_CONTRACT: &str = r#"Reply with exactly one JSON object: {"verdicts":[{"id":"operand or pair id","verdict":"yes|no"}]}. Each entry must be an object with a string id and a verdict of "yes" or "no". Include exactly one entry per requested id. Do not call tools."#;

/// What a check asks of the model.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CheckKind {
    /// Does the evidence disprove a removed or replaced clause?
    Disproof,
    /// Does the evidence support an added clause?
    Support,
    /// Do the stored blocks disprove any kept clause?
    KeptClause,
    /// Do two statements contradict each other?
    Compatibility,
}

impl CheckKind {
    pub fn name(self) -> &'static str {
        match self {
            Self::Disproof => "disproof",
            Self::Support => "support",
            Self::KeptClause => "kept-clause",
            Self::Compatibility => "compatibility",
        }
    }

    fn question(self) -> &'static str {
        match self {
            Self::Disproof => "Does the evidence disprove each statement? Return exactly one identity-keyed verdict per operand.",
            Self::Support => "Does the evidence support each statement? Return exactly one identity-keyed verdict per operand.",
            Self::KeptClause => "Do the stored blocks disprove any kept statement? Return exactly one identity-keyed verdict per operand.",
            Self::Compatibility => "Do the statements in each pair contradict each other? Return exactly one identity-keyed verdict per pair.",
        }
    }

    /// The check's system prompt.
    pub fn system(self) -> String {
        format!("{}\n\n{CHECK_SCHEMA_CONTRACT}", self.question())
    }

    /// The verdict every entry needs for the revision to pass.
    fn passing(self) -> &'static str {
        match self {
            Self::Disproof | Self::Support => "yes",
            Self::KeptClause | Self::Compatibility => "no",
        }
    }
}

/// A clause a decision removes or replaces, with the evidence it cites.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChangedClause {
    pub memory_id: i64,
    pub ordinal: i64,
    pub block: i64,
    pub excerpt: String,
    pub replacement: bool,
}

/// A clause a decision adds, with the evidence it cites.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AddedClause {
    pub text: String,
    pub block: i64,
    pub excerpt: String,
}

/// A source memory as the gates read it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Source {
    pub id: i64,
    pub revision: i64,
    pub project: String,
    pub status: String,
    pub content: String,
}

/// A revision decision, as the gates and the applier see it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Revision {
    pub key: String,
    /// `edit`, `merge` or `replaces`.
    pub action: String,
    pub project: String,
    /// The sources with the revisions the decision read.
    pub expected: Vec<(i64, i64)>,
    pub survivor: i64,
    pub final_text: String,
    pub changes: Vec<ChangedClause>,
    pub added: Vec<AddedClause>,
    /// The calendar date the revised text says it stops holding.
    pub expires: Option<String>,
}

/// What the gates need beyond the decision.
pub struct Context<'a> {
    pub memory_enabled: bool,
    pub auto_promote: bool,
    pub anchor_known: bool,
    pub blocks: &'a [EvidenceBlock],
    pub sources: &'a [Source],
}

/// A statement a check judges, under its identity.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Operand {
    pub id: String,
    pub text: String,
}

/// Two statements a compatibility check compares.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pair {
    pub id: String,
    pub left: Operand,
    pub right: Operand,
}

/// One check the plan asks for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Check {
    pub kind: CheckKind,
    pub operands: Vec<Operand>,
    pub pairs: Vec<Pair>,
    pub input: String,
}

/// A revision that passed every gate.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Plan {
    pub checks: Vec<Check>,
    /// The clauses the revision keeps unchanged.
    pub kept: Vec<Operand>,
    /// The evidence its changes cite.
    pub spans: Vec<EvidenceSpan>,
}

fn existing_operand(id: i64, revision: i64, ordinal: usize) -> String {
    json!([id, revision, ordinal]).to_string()
}

fn proposed_operand(key: &str, index: usize, text: &str) -> String {
    json!([key, "proposed", index, lifecycle_text_hash(text)]).to_string()
}

/// The pair of two operands in a fixed order (by their ids' bytes), so the
/// same two statements always form the same pair.
fn pair(left: &Operand, right: &Operand) -> Pair {
    let (left, right) = if left.id.as_bytes() <= right.id.as_bytes() {
        (left, right)
    } else {
        (right, left)
    };
    Pair {
        id: json!([left.id, right.id]).to_string(),
        left: left.clone(),
        right: right.clone(),
    }
}

/// Check clause bytes, evidence, concrete tokens and input bounds before any
/// check is spent (`planMemoryRevision`). `Err` names the refusal.
pub fn plan(decision: &Revision, context: &Context<'_>) -> Result<Plan, &'static str> {
    if !context.memory_enabled {
        return Err("memory_disabled");
    }
    if !context.auto_promote {
        return Err("auto_promote_disabled");
    }
    if decision.key.is_empty()
        || decision.final_text.is_empty()
        || !["edit", "merge", "replaces"].contains(&decision.action.as_str())
    {
        return Err("shape");
    }
    if decision.changes.is_empty() {
        return Err("append_only");
    }
    let mut expected = std::collections::BTreeMap::new();
    for (id, revision) in &decision.expected {
        expected.insert(*id, *revision);
    }
    if expected.len() != decision.expected.len()
        || expected.len() != context.sources.len()
        || !expected.contains_key(&decision.survivor)
        || (decision.action != "merge" && expected.len() != 1)
    {
        return Err("shape");
    }
    if context.sources.iter().any(|source| {
        source.project != decision.project
            || source.status == "archived"
            || expected.get(&source.id) != Some(&source.revision)
    }) {
        return Err("source_revision");
    }
    let mut changed = std::collections::BTreeMap::new();
    for change in &decision.changes {
        if changed
            .insert((change.memory_id, change.ordinal), change)
            .is_some()
        {
            return Err("clauses");
        }
    }
    let mut kept: Vec<Operand> = Vec::new();
    let mut removed: Vec<(Operand, &ChangedClause)> = Vec::new();
    let mut source_of = std::collections::BTreeMap::new();
    for source in context.sources {
        for clause in split_memory_clauses(&source.content) {
            let operand = Operand {
                id: existing_operand(source.id, source.revision, clause.ordinal),
                text: clause.text,
            };
            source_of.insert(operand.id.clone(), source.id);
            match changed.get(&(source.id, clause.ordinal as i64)) {
                Some(change) => removed.push((operand, change)),
                None => kept.push(operand),
            }
        }
    }
    if removed.len() != changed.len() {
        return Err("clauses");
    }
    let added: Vec<Operand> = decision
        .added
        .iter()
        .enumerate()
        .map(|(index, clause)| Operand {
            id: proposed_operand(&decision.key, index, &clause.text),
            text: clause.text.clone(),
        })
        .collect();
    if added
        .iter()
        .any(|operand| operand.text.is_empty() || split_memory_clauses(&operand.text).len() != 1)
    {
        return Err("clauses");
    }
    // Each unchanged clause must survive byte for byte, and an addition
    // can't rewrite a clause left out of the changes.
    let mut remaining: Vec<&str> = kept
        .iter()
        .chain(&added)
        .map(|operand| operand.text.as_str())
        .collect();
    for clause in split_memory_clauses(&decision.final_text) {
        let Some(index) = remaining.iter().position(|text| *text == clause.text) else {
            return Err("clauses");
        };
        remaining.remove(index);
    }
    if !remaining.is_empty() {
        return Err("clauses");
    }
    let tokens_of = |text: &str| scan_concrete_tokens(text);
    if decision.action == "merge"
        && removed.iter().all(|(operand, change)| {
            !change.replacement
                && tokens_of(&operand.text).iter().all(|token| {
                    kept.iter()
                        .any(|item| tokens_of(&item.text).contains(token))
                })
        })
    {
        return Err("paraphrase_only");
    }
    if !context.anchor_known {
        return Err("unknown_anchor");
    }
    let final_tokens = tokens_of(&decision.final_text);
    // A merge must keep each source's concrete facts in the surviving
    // memory; naming one in the evidence doesn't keep it.
    if decision.action == "merge"
        && context.sources.iter().any(|source| {
            tokens_of(&source.content)
                .iter()
                .any(|token| !final_tokens.contains(token))
        })
    {
        return Err("dropped_token");
    }
    let mut spans = Vec::new();
    let mut checks = Vec::new();
    for (operand, change) in &removed {
        let Some(span) = match_fact_evidence(context.blocks, change.block, &change.excerpt) else {
            return Err("evidence_or_window");
        };
        let evidence = tokens_of(&span.text);
        if tokens_of(&operand.text)
            .iter()
            .any(|token| !final_tokens.contains(token) && !evidence.contains(token))
        {
            return Err("dropped_token");
        }
        checks.push(Check {
            kind: CheckKind::Disproof,
            operands: vec![operand.clone()],
            pairs: Vec::new(),
            input: span.window.clone(),
        });
        spans.push(span);
    }
    for (operand, clause) in added.iter().zip(&decision.added) {
        let Some(span) = match_fact_evidence(context.blocks, clause.block, &clause.excerpt) else {
            return Err("evidence_or_window");
        };
        let evidence = tokens_of(&span.text);
        if tokens_of(&operand.text)
            .iter()
            .any(|token| !evidence.contains(token))
        {
            return Err("new_token");
        }
        checks.push(Check {
            kind: CheckKind::Support,
            operands: vec![operand.clone()],
            pairs: Vec::new(),
            input: span.window.clone(),
        });
        spans.push(span);
    }
    let mut blocks: Vec<&EvidenceBlock> = context.blocks.iter().collect();
    blocks.sort_by_key(|block| block.start_ordinal);
    let kept_input = format!(
        "{}\n{}",
        blocks
            .iter()
            .map(|block| block.joined_text.as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        kept.iter()
            .map(|operand| format!("{}: {}", operand.id, operand.text))
            .collect::<Vec<_>>()
            .join("\n")
    );
    if !kept.is_empty() {
        if kept_input.encode_utf16().count() > KEPT_CHECK_INPUT_MAX {
            return Err("kept_input_limit");
        }
        checks.push(Check {
            kind: CheckKind::KeptClause,
            operands: kept.clone(),
            pairs: Vec::new(),
            input: kept_input,
        });
    }
    for operand in &added {
        let others: Vec<Pair> = kept
            .iter()
            .chain(&added)
            .filter(|other| other.id != operand.id)
            .map(|other| pair(operand, other))
            .collect();
        if !others.is_empty() {
            checks.push(Check {
                kind: CheckKind::Compatibility,
                operands: Vec::new(),
                pairs: others,
                input: String::new(),
            });
        }
    }
    if decision.action == "merge" {
        let mut pairs = Vec::new();
        for (index, left) in kept.iter().enumerate() {
            for right in &kept[index + 1..] {
                if source_of.get(&left.id) != source_of.get(&right.id) {
                    pairs.push(pair(left, right));
                }
            }
        }
        if !pairs.is_empty() {
            checks.push(Check {
                kind: CheckKind::Compatibility,
                operands: Vec::new(),
                pairs,
                input: String::new(),
            });
        }
    }
    if checks.len() > NARROW_CHECK_CALL_CEILING {
        return Err("call_ceiling");
    }
    Ok(Plan {
        checks,
        kept,
        spans,
    })
}

/// A check's durable key: the decision, the check's operands and input, and
/// the model it runs on (`model`), so the same check under the same
/// decision is never sent twice.
pub fn check_key(decision_key: &str, check: &Check, model: &Value) -> String {
    let operands: Vec<Value> = check
        .operands
        .iter()
        .map(|operand| json!({"id": operand.id, "text": operand.text}))
        .collect();
    let pairs: Vec<Value> = check
        .pairs
        .iter()
        .map(|pair| {
            json!({
                "id": pair.id,
                "left": {"id": pair.left.id, "text": pair.left.text},
                "right": {"id": pair.right.id, "text": pair.right.text},
            })
        })
        .collect();
    let identity = json!({
        "decisionKey": decision_key,
        "kind": check.kind.name(),
        "operands": operands,
        "pairs": pairs,
        "inputHash": lifecycle_text_hash(&check.input),
        "model": model,
        "systemHash": lifecycle_text_hash(&check.kind.system()),
    });
    lifecycle_text_hash(&identity.to_string())
}

/// The ids a check's verdicts must name, in order.
pub fn expected_ids(check: &Check) -> Vec<String> {
    if check.kind == CheckKind::Compatibility {
        check.pairs.iter().map(|pair| pair.id.clone()).collect()
    } else {
        check
            .operands
            .iter()
            .map(|operand| operand.id.clone())
            .collect()
    }
}

/// The check prompt: an `Operands:` section listing each operand (or each
/// A/B pair) under its identity, then the `Input:` text (`renderCheckInput`).
pub fn render_input(check: &Check) -> String {
    let operands: Vec<String> = if check.kind == CheckKind::Compatibility {
        check
            .pairs
            .iter()
            .map(|pair| {
                format!(
                    "{}\n  A: {}\n  B: {}",
                    pair.id, pair.left.text, pair.right.text
                )
            })
            .collect()
    } else {
        check
            .operands
            .iter()
            .map(|operand| format!("{}: {}", operand.id, operand.text))
            .collect()
    };
    let mut lines = vec!["Operands:".to_owned()];
    lines.extend(operands);
    lines.push(String::new());
    lines.push("Input:".to_owned());
    lines.push(check.input.clone());
    lines.join("\n")
}

/// The verdict entries of a check reply; an unparseable reply has none, so
/// it reads as a malformed verdict rather than a transport failure.
pub fn parse_verdicts(text: &str) -> Vec<Value> {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|value| value.get("verdicts")?.as_array().cloned())
        .unwrap_or_default()
}

/// Why a check sank the revision.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Passed,
    /// Not exactly one `yes` or `no` per expected id.
    Malformed,
    /// A verdict other than the one the revision needs.
    Refused(CheckKind),
}

/// Judge a check's verdicts. A length-capped reply has no verdicts.
pub fn judge(check: &Check, verdicts: &[Value], length_capped: bool) -> Verdict {
    let expected = expected_ids(check);
    if length_capped || verdicts.len() != expected.len() {
        return Verdict::Malformed;
    }
    let mut seen = std::collections::BTreeSet::new();
    for entry in verdicts {
        let id = entry.get("id").and_then(Value::as_str);
        let verdict = entry.get("verdict").and_then(Value::as_str);
        match (id, verdict) {
            (Some(id), Some("yes" | "no")) if expected.iter().any(|known| known == id) => {
                seen.insert(id.to_owned());
            }
            _ => return Verdict::Malformed,
        }
    }
    if seen.len() != expected.len() {
        return Verdict::Malformed;
    }
    if verdicts
        .iter()
        .any(|entry| entry.get("verdict").and_then(Value::as_str) != Some(check.kind.passing()))
    {
        return Verdict::Refused(check.kind);
    }
    Verdict::Passed
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Vectors {
        blocks: Vec<EvidenceBlock>,
        cases: Vec<Case>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Case {
        name: String,
        decision: Value,
        sources: Vec<Value>,
        anchor_known: bool,
        memory_enabled: bool,
        auto_promote: bool,
        plan: Value,
    }

    fn revision(value: &Value) -> Revision {
        let changes = value["changes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|change| ChangedClause {
                memory_id: change["memoryId"].as_i64().unwrap(),
                ordinal: change["ordinal"].as_i64().unwrap(),
                block: change["evidence"]["blockStartOrdinal"].as_i64().unwrap(),
                excerpt: change["evidence"]["excerpt"].as_str().unwrap().to_owned(),
                replacement: change["replacement"].as_bool().unwrap(),
            })
            .collect();
        let added = value["added"]
            .as_array()
            .unwrap()
            .iter()
            .map(|clause| AddedClause {
                text: clause["text"].as_str().unwrap().to_owned(),
                block: clause["evidence"]["blockStartOrdinal"].as_i64().unwrap(),
                excerpt: clause["evidence"]["excerpt"].as_str().unwrap().to_owned(),
            })
            .collect();
        Revision {
            key: value["key"].as_str().unwrap().to_owned(),
            action: value["action"].as_str().unwrap().to_owned(),
            project: value["projectPath"].as_str().unwrap().to_owned(),
            expected: value["expectedSources"]
                .as_array()
                .unwrap()
                .iter()
                .map(|source| {
                    (
                        source["id"].as_i64().unwrap(),
                        source["revision"].as_i64().unwrap(),
                    )
                })
                .collect(),
            survivor: value["survivorId"].as_i64().unwrap(),
            final_text: value["finalText"].as_str().unwrap().to_owned(),
            changes,
            added,
            expires: None,
        }
    }

    /// The gates refuse and plan exactly as the plugin's do, check for
    /// check, operand for operand (gen/gen-revision-gates.ts).
    #[test]
    fn gates_match_the_plugin() {
        let vectors: Vectors =
            serde_json::from_str(include_str!("../../../testdata/revision-gates.json"))
                .expect("parse the gate vectors");
        assert!(vectors.cases.len() >= 15);
        for case in &vectors.cases {
            let sources: Vec<Source> = case
                .sources
                .iter()
                .map(|source| Source {
                    id: source["id"].as_i64().unwrap(),
                    revision: source["revision"].as_i64().unwrap(),
                    project: source["projectPath"].as_str().unwrap().to_owned(),
                    status: source["status"].as_str().unwrap().to_owned(),
                    content: source["content"].as_str().unwrap().to_owned(),
                })
                .collect();
            let context = Context {
                memory_enabled: case.memory_enabled,
                auto_promote: case.auto_promote,
                anchor_known: case.anchor_known,
                blocks: &vectors.blocks,
                sources: &sources,
            };
            let got = match plan(&revision(&case.decision), &context) {
                Err(reason) => json!({"ok": false, "reason": reason}),
                Ok(plan) => json!({
                    "ok": true,
                    "kept": plan.kept.iter().map(|operand| operand.id.clone()).collect::<Vec<_>>(),
                    "checks": plan.checks.iter().map(|check| json!({
                        "kind": check.kind.name(),
                        "operands": check.operands.iter().map(|operand| operand.id.clone()).collect::<Vec<_>>(),
                        "pairs": check.pairs.iter().map(|pair| pair.id.clone()).collect::<Vec<_>>(),
                        "input": check.input,
                    })).collect::<Vec<_>>(),
                }),
            };
            assert_eq!(got, case.plan, "{}", case.name);
        }
    }

    fn operand_check(kind: CheckKind, ids: &[&str]) -> Check {
        Check {
            kind,
            operands: ids
                .iter()
                .map(|id| Operand {
                    id: (*id).to_owned(),
                    text: String::new(),
                })
                .collect(),
            pairs: Vec::new(),
            input: String::new(),
        }
    }

    #[test]
    fn a_check_passes_only_with_exactly_one_needed_verdict_per_id() {
        let support = operand_check(CheckKind::Support, &["a", "b"]);
        let verdicts = |pairs: &[(&str, &str)]| -> Vec<Value> {
            pairs
                .iter()
                .map(|(id, verdict)| json!({"id": id, "verdict": verdict}))
                .collect()
        };
        assert_eq!(
            judge(&support, &verdicts(&[("a", "yes"), ("b", "yes")]), false),
            Verdict::Passed
        );
        assert_eq!(
            judge(&support, &verdicts(&[("a", "yes"), ("b", "no")]), false),
            Verdict::Refused(CheckKind::Support)
        );
        assert_eq!(
            judge(&support, &verdicts(&[("a", "yes"), ("a", "yes")]), false),
            Verdict::Malformed
        );
        assert_eq!(
            judge(&support, &verdicts(&[("a", "yes"), ("c", "yes")]), false),
            Verdict::Malformed
        );
        assert_eq!(
            judge(
                &support,
                &verdicts(&[("a", "yes"), ("b", "unclear")]),
                false
            ),
            Verdict::Malformed
        );
        assert_eq!(
            judge(&support, &verdicts(&[("a", "yes"), ("b", "yes")]), true),
            Verdict::Malformed
        );
        // A kept clause passes when nothing disproves it.
        let kept = operand_check(CheckKind::KeptClause, &["k"]);
        assert_eq!(
            judge(&kept, &verdicts(&[("k", "no")]), false),
            Verdict::Passed
        );
        assert_eq!(
            judge(&kept, &verdicts(&[("k", "yes")]), false),
            Verdict::Refused(CheckKind::KeptClause)
        );
        assert!(parse_verdicts("not json").is_empty());
    }
}
