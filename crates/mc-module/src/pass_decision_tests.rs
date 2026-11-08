use super::*;
use cortexkit_role_compaction::read::StepUsage;
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Table {
    description: String,
    context_window: u64,
    output_reserve: u64,
    usable_window: u64,
    rows: Vec<Row>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Row {
    id: String,
    input: Input,
    expected: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    model: String,
    percentage: Value,
    tokens: Option<Value>,
    usage: f64,
    primary: bool,
    cache_expired: bool,
    summary: String,
    floor_passes: usize,
    floor_shrink: bool,
    queued_tokens: u64,
    held_passes: u64,
    prefix_bound: bool,
    reasoning_tokens: u64,
    heavy_steps_back: usize,
    person: bool,
    routine_already_applied: bool,
    emergency_latched: bool,
}

fn transcript(input: &Input) -> Vec<Entry> {
    let mut entries = Vec::new();
    let mut push = |role: Role, text: String, reasoning: u64| {
        let ordinal = entries.len() as u64 + 1;
        let body = if reasoning > 0 {
            PartBody::Reasoning {
                text: Some(text),
                text_bytes: Some(4),
            }
        } else {
            PartBody::Text { text }
        };
        let mut part = Part::new("p", body);
        part.tag = Some(ordinal);
        let mut entry = Entry::new(ordinal, format!("m{ordinal}"), role, ordinal, vec![part]);
        let mut usage = StepUsage::new();
        usage.reasoning_tokens = Some(reasoning);
        entry.usage = Some(usage);
        entries.push(entry);
    };
    if input.summary == "floor" {
        push(Role::User, "Implement the long autonomous task".into(), 0);
        for _ in 0..16 {
            push(Role::Assistant, "history ".repeat(1_000), 0);
            push(
                Role::User,
                "<system-reminder>Continue working</system-reminder>".into(),
                0,
            );
        }
        return entries;
    }
    if input.summary == "ready" {
        for i in 0..16 {
            push(
                if i % 2 == 0 {
                    Role::User
                } else {
                    Role::Assistant
                },
                "history ".repeat(1_000),
                0,
            );
        }
    }
    if input.person {
        push(Role::User, "task".into(), 0);
    }
    for step in (1..=input.heavy_steps_back).rev() {
        push(
            Role::Assistant,
            "step".into(),
            if step == input.heavy_steps_back {
                input.reasoning_tokens
            } else {
                1
            },
        );
    }
    entries
}

fn evaluate(row: &Row, table: &Table) -> Value {
    let usable = table.usable_window;
    let input = &row.input;
    // The retained-pass count and cleanup history are plugin inputs, not state
    // ck-mc persists: every rebuild in ck-mc admits all ordinary lanes.
    let _ = (input.held_passes, input.routine_already_applied);
    let mut settings = crate::config::resolve_for_test(
        json!({
            "execute_threshold_percentage": input.percentage,
            "execute_threshold_tokens": input.tokens,
        }),
        json!({}),
        &input.model,
        usable,
    );
    settings.protected_tokens = Some(0);
    let (mut session, _, _, _, _) = fixture();
    session.preset = if input.primary {
        crate::catalog::Preset::Head
    } else {
        crate::catalog::Preset::Worker
    };
    session.features = crate::preset::features(session.preset.as_str()).unwrap();
    session.conditions.context_window = table.context_window;
    session.conditions.output_reserve = table.output_reserve;
    assert_eq!(pass::usable_window(&session.conditions), usable);
    session.conditions.last_prompt_tokens =
        Some((input.usage * usable as f64 / 100.0).round() as u64);
    let (provider, model) = input.model.split_once('/').unwrap();
    session.conditions.model = ModelRef::new(provider, model);
    session.conditions.rules.signed_parts = if input.prefix_bound {
        SignedParts::Bound
    } else {
        SignedParts::None
    };
    let entries = transcript(input);
    session.index.extend(entries.clone());
    session.index_ready = true;
    session.head_stale = false;
    session.summarizing =
        input.primary && (input.summary == "running" || input.summary == "waiting");
    session.emergency_latched = input.emergency_latched;
    let execute = pass::at_execute(&session.conditions, &settings);
    let force = pass::in_force_band(&session.conditions, &settings);
    let hold = pass::signed_thinking_hold(session.index.entries(), &session.conditions, &settings);

    // This is the same decision point handle_notice uses, including starting a
    // summary before deciding whether the other lanes have permission to land.
    let mut decision = session.decide_notice(&settings);
    for _ in 1..input.floor_passes {
        // A mark is durable: the second pass must behave the same after a
        // checkpoint/restart as it does in a continuously running session.
        let current = session.index.entries().to_vec();
        let saved = serde_json::to_string(&session.durable()).unwrap();
        session.restore(serde_json::from_str(&saved).unwrap());
        // A restarted session re-reads its visible transcript before deciding.
        session.index.extend(current);
        session.index_ready = true;
        if input.floor_shrink {
            session.index = Index::starting_at(1);
            session.index.extend(entries[..2].to_vec());
        }
        decision = session.decide_notice(&settings);
    }
    let mut rebuild = decision.rebuild;
    if input.cache_expired {
        // Cache loss is delivered by the runner as a ride, not a timed notice.
        // Give the ride an eligible edit so permission is observable as a view.
        // A forgotten cache permits nothing by itself: the ride carries the
        // edit only when a notice with the same conditions would rebuild.
        let entry = entries
            .iter()
            .find(|entry| entry.role == Role::Assistant)
            .unwrap();
        session.queued.insert((entry.mid.clone(), "p".into()));
        // The message the request ends on keeps its parts, so a drop of it
        // would wait. When that is the only assistant message, a newer
        // message makes its drop eligible.
        if entries.last().is_some_and(|last| last.mid == entry.mid) {
            let ordinal = entries.len() as u64 + 1;
            let mut part = Part::new(
                "p",
                PartBody::Text {
                    text: "next".into(),
                },
            );
            part.tag = Some(ordinal);
            session.index.extend([Entry::new(
                ordinal,
                format!("m{ordinal}"),
                Role::User,
                ordinal,
                vec![part],
            )]);
        }
        let ride = RideRequest::new(
            vec![RideCause::CacheExpired],
            1_000,
            session.conditions.clone(),
        );
        rebuild = session.ride(&settings, &ride).is_some();
    }
    let priced = rebuild && (input.queued_tokens > 0 || input.cache_expired);
    let emergency_drop = rebuild && session.emergency_drop_allowed(&settings, false, priced);
    json!({
        "threshold": settings.execute_threshold_percentage,
        "execute": execute,
        "force": force,
        "hold": hold,
        "rebuild": rebuild,
        "floor_marked": session.floor_pending_for.is_some(),
        "queued_drops": rebuild,
        "heuristics": rebuild,
        "reasoning": rebuild,
        "emergency_drop": emergency_drop,
        "summary_may_start": decision.summary.is_some(),
    })
}

struct Difference {
    rows: &'static [&'static str],
    fields: &'static [&'static str],
    rule: &'static str,
    reason: &'static str,
    typescript: bool,
    rust: bool,
}

// Only these row/field pairs differ. Each entry is checked in both directions:
// it must still differ exactly as documented, and cannot excuse another field.
const DIFFERENCES: &[Difference] = &[
    Difference {
        rows: &["queue-0-0", "queue-0-1", "queue-0-2", "queue-1999-0", "queue-1999-1"],
        fields: &["rebuild", "queued_drops", "heuristics", "reasoning"],
        rule: "PD9",
        reason: "Mode 3 removes the bounded queued-work exception: an execute with no summary admits every lane even below 2% and before the third held pass.",
        typescript: false,
        rust: true,
    },
    Difference {
        rows: &[
            "thinking-65-2-75-true", "thinking-65-3-85-true",
            "thinking-80-0-85-true", "thinking-80-1-89.9-true", "thinking-80-2-90-true", "thinking-80-3-85-true",
            "thinking-90-0-95-true", "thinking-90-1-99.9-true", "thinking-90-2-100-true", "thinking-90-3-92-true",
            "thinking-window-1500-1-false", "thinking-window-1500-1-true",
            "thinking-window-1500-15-false", "thinking-window-1500-15-true",
            "thinking-window-1500-16-false", "thinking-window-1500-16-true",
            "thinking-window-1501-1-false", "thinking-window-1501-15-false",
            "thinking-window-1501-16-false", "thinking-window-1501-16-true",
        ],
        fields: &["reasoning"],
        rule: "RC3",
        reason: "Mode 3 keeps oldest-contiguous-run reasoning clearing on bound models; TypeScript disables partial reasoning clearing on prefix-bound models.",
        typescript: false,
        rust: true,
    },
    Difference {
        rows: &["cache-true-true-false", "cache-true-true-true", "cache-false-true-false", "cache-false-true-true"],
        fields: &["execute"],
        rule: "PD7",
        reason: "Cache expiry is a runner ride in mode 3, not a TTL-induced execute classification.",
        typescript: true,
        rust: false,
    },
    // The three entries below come from the forgotten-cache ride rule: a ride
    // whose causes only say the provider forgot its cache (expiry, a chain
    // reset, a tier or account switch) is no rebuild permission and lifts no
    // signed-thinking hold. The checked-in table still encodes the plugin's
    // older rule, under which an expiry permits a rebuild and lifts the hold.
    // Once the table is regenerated from a plugin with the same rule, these
    // entries go stale, and this test fails until they are removed or
    // restated.
    Difference {
        rows: &["cache-true-true-false", "cache-false-true-false"],
        fields: &["rebuild", "queued_drops", "heuristics", "reasoning"],
        rule: "PD7",
        reason: "A forgotten-cache ride below the execute threshold answers nothing in mode 3; the table predates that rule and still lands every lane on expiry.",
        typescript: true,
        rust: false,
    },
    Difference {
        rows: &["cache-true-true-true", "cache-false-true-true"],
        fields: &["rebuild", "queued_drops", "heuristics"],
        rule: "PD7",
        reason: "A forgotten-cache ride below the execute threshold answers nothing in mode 3; the table predates that rule and still lands every lane on expiry.",
        typescript: true,
        rust: false,
    },
    Difference {
        rows: &["cache-true-true-true", "cache-false-true-true"],
        fields: &["hold"],
        rule: "PD7",
        reason: "A forgotten-cache ride keeps the signed-thinking hold in mode 3, since resending the same bytes keeps the thinking valid; the table predates that rule and lifts the hold on expiry.",
        typescript: false,
        rust: true,
    },
    Difference {
        rows: &["latch-true-85-0", "latch-true-94.9-0"],
        fields: &["rebuild", "queued_drops", "heuristics", "reasoning"],
        rule: "PD5, PD9",
        reason: "Mode 3 retains force-band rebuild permission for every ordinary lane instead of withholding it after the force episode's first batch.",
        typescript: false,
        rust: true,
    },
    Difference {
        rows: &["latch-true-85-2000", "latch-true-94.9-2000"],
        fields: &["rebuild", "queued_drops", "heuristics", "reasoning", "emergency_drop"],
        rule: "PD5, PD9, EM4",
        reason: "Mode 3's force permission lands queued work even in a spent episode, and that independent rewrite rearms emergency selection.",
        typescript: false,
        rust: true,
    },
    Difference {
        rows: &["latch-false-85-0", "latch-false-94.9-0", "routine-true"],
        fields: &["heuristics", "reasoning"],
        rule: "PD9",
        reason: "Mode 3 runs ordinary cleanup on every permitted rebuild instead of applying the plugin's turn and pressure-episode limits.",
        typescript: false,
        rust: true,
    },
    Difference {
        rows: &["latch-true-95-0", "latch-false-95-0"],
        fields: &["emergency_drop"],
        rule: "PD6, EM5",
        reason: "Mode 3 has no absolute 95% override of a spent emergency episode; the runner must request an over_limit ride.",
        typescript: true,
        rust: false,
    },
];

#[test]
fn pass_decision_table_matches_typescript() {
    let table: Table =
        serde_json::from_str(include_str!("../testdata/pass-decisions.json")).unwrap();
    assert!(table.description.contains("production TypeScript gates"));
    assert_eq!(table.rows.len(), 354);
    let mut exceptions = std::collections::BTreeMap::new();
    for difference in DIFFERENCES {
        assert!(!difference.rule.is_empty() && !difference.reason.is_empty());
        for row in difference.rows {
            for field in difference.fields {
                assert!(
                    exceptions.insert((*row, *field), difference).is_none(),
                    "duplicate exception {row}/{field}"
                );
            }
        }
    }
    let mut mismatches = Vec::new();
    for row in &table.rows {
        let actual = evaluate(row, &table);
        let expected = row.expected.as_object().unwrap();
        assert_eq!(
            expected.len(),
            actual.as_object().unwrap().len(),
            "{}: output schema drift",
            row.id
        );
        for (field, value) in expected {
            if let Some(difference) = exceptions.remove(&(row.id.as_str(), field.as_str())) {
                assert_eq!(
                    *value,
                    json!(difference.typescript),
                    "{} / {field}: stale TypeScript exception ({}, {})",
                    row.id,
                    difference.rule,
                    difference.reason
                );
                assert_eq!(
                    actual[field],
                    json!(difference.rust),
                    "{} / {field}: stale Rust exception ({}, {})",
                    row.id,
                    difference.rule,
                    difference.reason
                );
                continue;
            }
            let equal = if field == "threshold" {
                actual[field].as_f64() == value.as_f64()
            } else {
                actual[field] == *value
            };
            if !equal {
                mismatches.push(format!(
                    "{} / {field}: TS={value} Rust={}",
                    row.id, actual[field]
                ));
            }
        }
    }
    assert!(
        exceptions.is_empty(),
        "exception names missing rows or fields: {:?}",
        exceptions.keys().collect::<Vec<_>>()
    );
    assert!(
        mismatches.is_empty(),
        "{} divergences:\n{}",
        mismatches.len(),
        mismatches.join("\n")
    );
}
