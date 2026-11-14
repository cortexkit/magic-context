use serde_json::{json, Value};

use super::constants::*;
use super::text::*;

const GOLDENS: &str = include_str!("text_goldens.json");

// A real memory from the historian merge trial (.cortexkit/internal-docs/investigations/reports/historian-merge-turn-trial-v6-sonnet.md:71,
// issue #17639). The trial numbered its clauses with the outdated "gap" statement as clause
// four, and edits cite clauses by number, so the splitter must produce exactly that numbering
// and must not split after the abbreviation "e.g.".
const GAP_MEMORY: &str = "Rust transform mode must not require Broca (or any other CK module) to be running: every module under CK/subc stays decoupled unless coupling is necessary. Historian and dreamer completions in rust mode run by default in the same harness as the parent session (the host runs the prompt, e.g. OpenCode/Pi child session or the v2 child carrier), and route to the Broca runner only when the user configures it (Ufuk ruling, 2026-09-17). Today `crates/mc-module/src/historian_producer.rs` opens a route straight to `broca` (DEFAULT_RUNNER_MODULE_ID) — that is the gap to close with a host-runner default.";

/// Every case of the shared goldens whose Rust output differs from the expected value
/// the TypeScript reference produced, named so a failure says which rule diverged.
fn golden_mismatches(goldens: &Value) -> Vec<String> {
    let mut mismatches = Vec::new();
    let mut check = |section: &str, index: usize, actual: Value, expected: &Value| {
        if &actual != expected {
            mismatches.push(format!(
                "{section}[{index}]: rust {actual} != expected {expected}"
            ));
        }
    };
    let text = |case: &Value, field: &str| case[field].as_str().unwrap().to_string();
    let offset = |case: &Value, field: &str| case[field].as_u64().unwrap() as usize;
    for (index, case) in goldens["split"].as_array().unwrap().iter().enumerate() {
        let actual = serde_json::to_value(split_memory_clauses(&text(case, "input"))).unwrap();
        check("split", index, actual, &case["expected"]);
    }
    for (index, case) in goldens["normalize"].as_array().unwrap().iter().enumerate() {
        let actual = json!(normalize_lifecycle_text(&text(case, "input")));
        check("normalize", index, actual, &case["expected"]);
    }
    for (index, case) in goldens["tokens"].as_array().unwrap().iter().enumerate() {
        let actual = json!(scan_concrete_tokens(&text(case, "input")));
        check("tokens", index, actual, &case["expected"]);
    }
    for (index, case) in goldens["markers"].as_array().unwrap().iter().enumerate() {
        let actual = json!(has_evidence_marker(&text(case, "input")));
        check("markers", index, actual, &case["expected"]);
    }
    for (index, case) in goldens["windows"].as_array().unwrap().iter().enumerate() {
        let actual = json!(extract_evidence_window(
            &text(case, "part"),
            offset(case, "start"),
            offset(case, "end"),
        ));
        check("windows", index, actual, &case["expected"]);
    }
    let blocks: Vec<EvidenceBlock> =
        serde_json::from_value(goldens["match"]["blocks"].clone()).unwrap();
    for (index, case) in goldens["match"]["cases"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        let actual = serde_json::to_value(match_fact_evidence(
            &blocks,
            case["ordinal"].as_i64().unwrap(),
            &text(case, "excerpt"),
        ))
        .unwrap();
        check("match", index, actual, &case["expected"]);
    }
    mismatches
}

#[test]
fn named_constants_and_lists_are_fixed() {
    assert_eq!(
        [
            LEXICAL_SLOT_COUNT,
            NEIGHBOUR_SHORTLIST_CAP,
            NARROW_CHECK_WINDOW_MAX,
            KEPT_CHECK_INPUT_MAX,
            NARROW_CHECK_CALL_CEILING,
            RETRY_BACKLOG_PER_RUN,
        ],
        [2, 12, 1200, 48000, 8, 8]
    );
    assert_eq!(
        [MAX_STAGE2_ATTEMPTS, EXCERPT_BEFORE, EXCERPT_AFTER],
        [3, 2, 4]
    );
    assert_eq!(CLAUSE_ABBREVIATIONS, ["e.g.", "i.e.", "etc.", "vs."]);
    assert_eq!(
        CONCRETE_UNITS.join(" "),
        "KiB MiB GiB TiB KB MB GB TB byte bytes ns us µs ms s sec secs millisecond milliseconds second seconds m min mins minute minutes h hour hours d day days w week weeks token tokens percent %"
    );
    assert_eq!(
        EVIDENCE_MARKERS,
        [
            " / ",
            "[N]",
            "[N-M]",
            "Messages N-M:",
            "...[truncated]",
            "[… tokens truncated by Magic Context to fit the historian window …]",
            "…",
            "… +N more",
            "[dropped]",
            "[dropped §",
            "[truncated §",
            "<!-- +",
        ]
    );
}

#[test]
fn text_goldens_match_the_typescript_reference() {
    let goldens: Value = serde_json::from_str(GOLDENS).unwrap();
    for section in ["split", "normalize", "tokens", "markers", "windows"] {
        assert!(
            !goldens[section].as_array().unwrap().is_empty(),
            "{section} goldens are present"
        );
    }
    assert!(!goldens["match"]["cases"].as_array().unwrap().is_empty());
    let mismatches = golden_mismatches(&goldens);
    assert!(mismatches.is_empty(), "{mismatches:#?}");
}

#[test]
fn a_golden_expecting_different_output_fails() {
    let goldens: Value = serde_json::from_str(GOLDENS).unwrap();
    for (section, pointer) in [
        ("split", "/split/0/expected/3/text"),
        ("normalize", "/normalize/1/expected"),
        ("tokens", "/tokens/0/expected/2"),
        ("markers", "/markers/0/expected"),
        ("windows", "/windows/2/expected"),
        ("match", "/match/cases/0/expected/window"),
    ] {
        let mut altered = goldens.clone();
        let slot = altered.pointer_mut(pointer).unwrap();
        *slot = match slot {
            Value::Bool(value) => json!(!*value),
            Value::String(value) => json!(format!("{value}x")),
            _ => panic!("unexpected golden shape at {pointer}"),
        };
        let mismatches = golden_mismatches(&altered);
        assert_eq!(mismatches.len(), 1, "{section}: {mismatches:#?}");
        assert!(mismatches[0].starts_with(section), "{mismatches:#?}");
    }
}

#[test]
fn v6_17639_yields_four_clauses_with_c4_the_gap() {
    let clauses = split_memory_clauses(GAP_MEMORY);
    assert_eq!(clauses.len(), 4);
    assert_eq!(
        clauses[3].text,
        "that is the gap to close with a host-runner default."
    );
    assert!(clauses[1].text.contains("e.g. OpenCode/Pi"));
    assert_eq!(
        clauses
            .iter()
            .map(|clause| clause.text.as_str())
            .collect::<String>(),
        GAP_MEMORY
    );
}

#[test]
fn token_and_whitespace_goldens_hold_their_fixed_values() {
    assert_eq!(scan_concrete_tokens("164 KiB"), ["164 KiB"]);
    assert!(!scan_concrete_tokens("164 KiB").contains(&"64 KiB".to_string()));
    assert_eq!(
        scan_concrete_tokens("keep >512 KiB and 64 KiB"),
        [">512 KiB", "64 KiB"]
    );
    assert_eq!(
        normalize_lifecycle_text("\u{FEFF} A \u{180E}"),
        "\u{FEFF} A \u{180E}"
    );
    assert_eq!(
        normalize_lifecycle_text("\u{0085} A\t\u{00a0}B\u{3000} "),
        "A B"
    );
    // A cut that would start on the low half of a surrogate pair drops the pair.
    let astral = format!("{}😀{}", "x".repeat(800), "y".repeat(1199));
    assert_eq!(
        extract_evidence_window(&astral, 1999, 2001).as_deref(),
        Some("y".repeat(1199).as_str())
    );
    assert_eq!(extract_evidence_window(&"x".repeat(2000), 0, 1201), None);
}
mod envelope_parity {
    use serde_json::Value;
    use sha2::{Digest, Sha256};

    use crate::summary::two_pass::envelope::{
        build_prompt, fit, parse, Entry, Neighbour, PromptBlock, PromptFact, PromptItem,
    };

    const GOLDENS: &str = include_str!("envelope_goldens.json");

    fn int(value: &Value) -> i64 {
        value.as_i64().unwrap()
    }

    fn fact(value: &Value) -> PromptFact {
        PromptFact {
            fact_id: int(&value["factId"]),
            category: value["category"].as_str().unwrap().to_owned(),
            content: value["content"].as_str().unwrap().to_owned(),
            source_session_id: value["sourceSessionId"].as_str().unwrap().to_owned(),
            anchor_known: value["anchorKnown"].as_bool().unwrap(),
            backlog: value["backlog"].as_bool().unwrap(),
            blocks: value["blocks"]
                .as_array()
                .unwrap()
                .iter()
                .map(|block| PromptBlock {
                    start_ordinal: int(&block["startOrdinal"]),
                    end_ordinal: int(&block["endOrdinal"]),
                    role: block["role"].as_str().unwrap().to_owned(),
                    parts: serde_json::from_value(block["parts"].clone()).unwrap(),
                })
                .collect(),
            neighbours: value["neighbours"]
                .as_array()
                .unwrap()
                .iter()
                .map(|neighbour| Neighbour {
                    id: int(&neighbour["id"]),
                    revision: int(&neighbour["revision"]),
                    category: neighbour["category"].as_str().unwrap().to_owned(),
                    content: neighbour["content"].as_str().unwrap().to_owned(),
                    workspace: false,
                })
                .collect(),
        }
    }

    fn item(value: &Value) -> PromptItem {
        PromptItem {
            item: int(&value["item"]),
            memory_id: int(&value["memoryId"]),
            content: value["content"].as_str().unwrap().to_owned(),
            excerpt: value["excerpt"].as_str().unwrap().to_owned(),
        }
    }

    /// The decision as the golden generator prints it.
    fn view(entry: &Entry) -> Value {
        let Entry::Decision(decision) = entry else {
            return Value::from("malformed");
        };
        let cited = |clauses: &[crate::summary::two_pass::envelope::CitedClause]| {
            clauses
                .iter()
                .map(|clause| {
                    serde_json::json!({"memoryId": clause.memory_id, "clause": clause.clause, "block": clause.block, "excerpt": clause.excerpt})
                })
                .collect::<Vec<_>>()
        };
        serde_json::json!({
            "fact_id": decision.fact_id,
            "ordinal": decision.ordinal,
            "action": decision.action,
            "target_id": decision.target_id,
            "revision": decision.revision,
            "sources": decision.sources.as_ref().map(|sources| sources.iter().map(|(id, revision)| vec![*id, *revision]).collect::<Vec<_>>()),
            "survivor_id": decision.survivor_id,
            "clauses": decision.clauses,
            "decided": decision.decided,
            "excerpt": decision.excerpt,
            "removed": cited(&decision.removed),
            "replaced": cited(&decision.replaced),
            "kept": decision.kept.iter().map(|(memory, clause)| vec![*memory, *clause]).collect::<Vec<_>>(),
            "added": decision.added.iter().map(|clause| serde_json::json!({"text": clause.text, "block": clause.block, "excerpt": clause.excerpt})).collect::<Vec<_>>(),
            "final_text": decision.final_text,
        })
    }

    #[test]
    fn replies_parse_as_the_plugin_parses_them() {
        let goldens: Value = serde_json::from_str(GOLDENS).unwrap();
        let cases = goldens["parsed"].as_array().unwrap();
        assert!(cases.len() >= 8);
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let result = parse(
                case["text"].as_str().unwrap(),
                case["length_capped"].as_bool().unwrap(),
                case["tool_activity"].as_bool().unwrap(),
            );
            match (&result, case.get("refused")) {
                (Err(refusal), Some(expected)) => {
                    assert_eq!(refusal.as_str(), expected.as_str().unwrap(), "{name}")
                }
                (Ok(envelope), None) => {
                    assert_eq!(
                        envelope.schema_valid,
                        case["schema_valid"].as_bool().unwrap(),
                        "{name}"
                    );
                    let decisions: Vec<Value> = envelope
                        .decisions
                        .iter()
                        .map(|(id, entry)| serde_json::json!([id, view(entry)]))
                        .collect();
                    assert_eq!(Value::from(decisions), case["decisions"], "{name}");
                    let scores: Vec<Value> = envelope
                        .scores
                        .iter()
                        .map(|score| {
                            serde_json::json!([score.item, score.importance, score.proposed_class])
                        })
                        .collect();
                    assert_eq!(Value::from(scores), case["scores"], "{name}");
                }
                _ => panic!("{name}: {result:?} vs {case}"),
            }
        }
    }

    #[test]
    fn prompts_and_fits_match_the_plugins_bytes() {
        let goldens: Value = serde_json::from_str(GOLDENS).unwrap();
        for case in goldens["prompts"].as_array().unwrap() {
            let facts: Vec<PromptFact> =
                case["facts"].as_array().unwrap().iter().map(fact).collect();
            let items: Vec<PromptItem> =
                case["items"].as_array().unwrap().iter().map(item).collect();
            let deferred = (
                case["deferred"][0].as_u64().unwrap() as usize,
                case["deferred"][1].as_u64().unwrap() as usize,
            );
            let prompt = build_prompt(
                &crate::summary::prompts::SummaryPrompts::plugin(),
                &facts,
                &items,
                case["lexical_only"].as_bool().unwrap(),
                deferred,
                None,
            );
            assert_eq!(prompt, case["prompt"].as_str().unwrap(), "{}", case["name"]);
        }
        let facts: Vec<PromptFact> = goldens["fit_input"]["facts"]
            .as_array()
            .unwrap()
            .iter()
            .map(fact)
            .collect();
        let items: Vec<PromptItem> = goldens["fit_input"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(item)
            .collect();
        for case in goldens["fits"].as_array().unwrap() {
            let max = case["max_length"].as_u64().unwrap() as usize;
            let fitted = fit(
                &crate::summary::prompts::SummaryPrompts::plugin(),
                &facts,
                &items,
                false,
                max,
                None,
            );
            let ids: Vec<i64> = fitted.facts.iter().map(|fact| fact.fact_id).collect();
            let item_ids: Vec<i64> = fitted.items.iter().map(|item| item.item).collect();
            assert_eq!(Value::from(ids), case["facts"], "fit {max}");
            assert_eq!(Value::from(item_ids), case["items"], "fit {max}");
            assert_eq!(
                serde_json::json!([fitted.deferred.0, fitted.deferred.1]),
                case["deferred"],
                "fit {max}"
            );
            assert_eq!(
                format!("{:x}", Sha256::digest(fitted.prompt.as_bytes())),
                case["prompt_sha256"].as_str().unwrap(),
                "fit {max}"
            );
        }
    }
}
