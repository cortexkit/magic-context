//! Review witnesses for the cached summary due-check. Each test drives one
//! real `Index` through a long sequence of transcript changes (appends,
//! rewrites of the newest message, tool results reaching older messages,
//! attribution backfill, runner counts and token-family switches, undos,
//! cuts, new summaries and model changes) and, after every change, compares
//! the cached `Window` with the unindexed evaluator it replaces: the newest
//! prompt, every protected-tail boundary and the line scan at many bounds.

use super::*;
use cortexkit_role_compaction::{
    part::{Part, ToolPart, ToolStatus},
    read::{NoticeOrigin, Role},
    tokens::PartTokens,
};

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, n: u64) -> u64 {
        if n == 0 {
            0
        } else {
            self.next() % n
        }
    }
}

const RELAY: &str = "<system-reminder>\nInbox: peer\n## Peer messages\nBROCA (pm_one): Check the parser.\n</system-reminder>";

fn text_part(id: &str, text: String) -> Part {
    Part::new(id, PartBody::Text { text: text.into() })
}

fn tool_part(id: &str, call: &str, status: ToolStatus, output: Option<u64>) -> Part {
    let mut tool = ToolPart::new(
        call,
        "bash",
        serde_json::json!({"command": format!("git commit -m {call}")}),
        status,
    );
    tool.output_bytes = output;
    Part::new(id, PartBody::Tool(tool))
}

fn helper() -> Option<cortexkit_role_compaction::read::SpeaksFor> {
    Some(serde_json::from_value(serde_json::json!({"agent_id":"agent-a","name":"Helper"})).unwrap())
}

/// One new message of a randomly chosen kind at `ordinal`.
fn message(rng: &mut Rng, ordinal: u64, serial: u64) -> Entry {
    let mid = format!("m{ordinal}-{serial}");
    let kind = rng.below(13);
    let words = 1 + rng.below(40) as usize;
    let (role, parts) = match kind {
        0 | 1 => (
            Role::User,
            vec![text_part(
                "p",
                format!("Please fix the parser {ordinal}. ").repeat(words),
            )],
        ),
        2 => (
            Role::User,
            vec![text_part(
                "p",
                "<system-reminder>ignore</system-reminder>".into(),
            )],
        ),
        3 => (Role::User, vec![text_part("p", RELAY.into())]),
        4 => {
            // Up to seven hashes, some repeated: a summary line's header lists
            // at most five distinct commit hashes, so its cap and its
            // de-duplication are both exercised.
            let hashes: Vec<String> = (0..1 + rng.below(7))
                .map(|k| format!("{:07x}", 0xabc0000 + (ordinal + k % 3) * 17))
                .collect();
            (
                Role::Assistant,
                vec![text_part(
                    "p",
                    format!("Committed {}; review it. ", hashes.join(", ")).repeat(words),
                )],
            )
        }
        5 => (
            Role::Assistant,
            vec![tool_part(
                "t",
                &format!("c{ordinal}"),
                ToolStatus::Running,
                None,
            )],
        ),
        6 => (
            Role::Assistant,
            vec![tool_part(
                "t",
                &format!("c{ordinal}"),
                ToolStatus::Completed,
                Some(rng.below(400_000)),
            )],
        ),
        7 => (
            Role::Assistant,
            vec![
                text_part("p", "Reading the implementation first. ".repeat(words)),
                tool_part("t", &format!("c{ordinal}"), ToolStatus::Running, None),
            ],
        ),
        8 => (
            Role::Assistant,
            vec![text_part(
                "p",
                "A long design note about the prefix. ".repeat(words * 20),
            )],
        ),
        9 => (Role::Assistant, Vec::new()),
        10 => (
            Role::User,
            vec![text_part(
                "p",
                format!("Relay text {ordinal}. ").repeat(words),
            )],
        ),
        11 => (
            Role::User,
            vec![text_part("p", "Huge pasted log line. ".repeat(words * 40))],
        ),
        _ => (
            Role::Assistant,
            vec![text_part(
                "p",
                format!("Plain reply {ordinal}. ").repeat(words),
            )],
        ),
    };
    let mut entry = Entry::new(ordinal, mid, role, ordinal, parts);
    match kind {
        1 if rng.below(2) == 0 => entry = entry.with_notice(NoticeOrigin::new("runner")),
        10 if rng.below(2) == 0 => entry.speaks_for = helper(),
        _ => {}
    }
    if kind == 8 || kind == 11 {
        // Runner counts over the huge-message limit, so one message alone
        // can outweigh the protected tail.
        for part in &mut entry.parts {
            part.tokens = Some(PartTokens::count(60_000 + rng.below(150_000)));
        }
    } else if rng.below(4) == 0 {
        // Runner counts, which only survive under a token family.
        for part in &mut entry.parts {
            part.tokens = Some(match part.body {
                PartBody::Tool(_) => PartTokens::tool(rng.below(500), rng.below(90_000)),
                _ => PartTokens::count(rng.below(120_000)),
            });
        }
    }
    entry
}

fn raw(entry: &Entry) -> u64 {
    entry.parts.iter().map(crate::tokens::part).sum()
}

fn removed(entry: &Entry) -> u64 {
    entry
        .parts
        .iter()
        .map(crate::tokens::removed_by_summary)
        .sum()
}

/// The unindexed evaluator's scan of `[from, until)`, on a fresh count cache.
fn legacy_scan(
    entries: &[Entry],
    from: u64,
    until: u64,
    budget: u64,
    counter: Counter,
) -> Option<trigger::Scan> {
    let low = entries.partition_point(|entry| entry.ordinal < from);
    let high = entries
        .partition_point(|entry| entry.ordinal < until)
        .max(low);
    let readable = &entries[low..high];
    let chunk = chunk::CountCache::default().build(readable, budget, counter)?;
    Some(trigger::Scan {
        tokens: chunk.token_estimate,
        has_more: chunk.has_more,
        commit_clusters: chunk.commit_clusters,
        messages: chunk.messages,
        raw_tokens: readable.iter().map(raw).sum(),
        removed_tokens: readable.iter().map(removed).sum(),
    })
}

/// Apply one random transcript change to `index` (or to the evaluator's
/// other inputs) and say what it was, for the failure message.
fn mutate(
    rng: &mut Rng,
    index: &mut crate::index::Index,
    family: &mut &'static str,
    from: &mut u64,
    model: &mut &'static str,
    serial: &mut u64,
) -> String {
    let entries = index.entries().to_vec();
    let next = index.base() + entries.len() as u64;
    match rng.below(20) {
        0..=6 => {
            let count = 1 + rng.below(3);
            let new: Vec<Entry> = (0..count)
                .map(|k| {
                    *serial += 1;
                    message(rng, next + k, *serial)
                })
                .collect();
            index.extend_counted(new, Some(family));
            format!("append {count} at {next}")
        }
        7 if !entries.is_empty() => {
            // The newest message is still being written.
            let newest = entries.last().unwrap();
            *serial += 1;
            let mut entry = message(rng, newest.ordinal, *serial);
            entry.mid = newest.mid.clone();
            entry = Entry::new(
                entry.ordinal,
                entry.mid.clone(),
                entry.role.clone(),
                entry.written_at,
                entry.parts.clone(),
            );
            index.extend_counted([entry], Some(family));
            format!("rewrite newest {}", newest.ordinal)
        }
        8 => {
            // A tool call in an older message gets its result.
            let Some(held) = entries.iter().find(|entry| {
                entry.parts.iter().any(|part| {
                    matches!(&part.body, PartBody::Tool(tool) if tool.status == ToolStatus::Running)
                })
            }) else {
                return "no running call".into();
            };
            let parts = held
                .parts
                .iter()
                .map(|part| match &part.body {
                    PartBody::Tool(tool) => {
                        let mut done = tool_part(
                            &part.id,
                            &tool.call_id,
                            ToolStatus::Completed,
                            Some(rng.below(300_000)),
                        );
                        if rng.below(2) == 0 {
                            done.tokens = Some(PartTokens::tool(rng.below(500), rng.below(80_000)));
                        }
                        done
                    }
                    _ => part.clone(),
                })
                .collect();
            let mut entry = Entry::new(
                held.ordinal,
                held.mid.clone(),
                held.role.clone(),
                held.written_at,
                parts,
            );
            entry.speaks_for = held.speaks_for.clone();
            index.extend_counted([entry], Some(family));
            format!("tool result for {}", held.ordinal)
        }
        9 => {
            // Attribution backfilled on an older user message. The runner's message
            // digest leaves attribution out, so the index sees the same digest.
            let Some(held) = entries
                .iter()
                .filter(|entry| entry.role == Role::User && entry.speaks_for.is_none())
                .nth(rng.below(4) as usize)
            else {
                return "no unattributed user".into();
            };
            let mut entry = held.clone();
            entry.speaks_for = helper();
            index.extend_counted([entry], Some(family));
            format!("speaks_for backfill {}", held.ordinal)
        }
        10 if !entries.is_empty() => {
            // Runner counts arrive late for an older message.
            let held = &entries[rng.below(entries.len() as u64) as usize];
            let mut entry = held.clone();
            for part in &mut entry.parts {
                part.tokens = Some(match part.body {
                    PartBody::Tool(_) => PartTokens::tool(rng.below(500), rng.below(90_000)),
                    _ => PartTokens::count(rng.below(120_000)),
                });
            }
            index.extend_counted([entry], Some(family));
            format!("counts for {}", held.ordinal)
        }
        11 => {
            *family = if *family == "fam-a" { "fam-b" } else { "fam-a" };
            index.extend_counted([], Some(family));
            format!("family {family}")
        }
        12 if !entries.is_empty() => {
            let at = index.base() + rng.below(entries.len() as u64 + 1);
            index.truncate(at);
            format!("truncate at {at}")
        }
        13 if entries.len() > 2 => {
            let at = index.base() + rng.below(entries.len() as u64 / 2 + 1);
            index.prune_before(at);
            format!("prune before {at}")
        }
        14 => {
            *from = if rng.below(4) == 0 {
                1
            } else {
                index.base().saturating_sub(1) + rng.below(entries.len() as u64 + 3)
            }
            .max(1);
            format!("from {from}")
        }
        15 => {
            *model = if *model == "test/model" {
                "anthropic/claude-opus-5-5"
            } else {
                "test/model"
            };
            format!("model {model}")
        }
        _ => "no change".into(),
    }
}

fn run(seed: u64, steps: usize, coverage: &mut Coverage) {
    let mut rng = Rng(seed);
    let mut index = crate::index::Index::default();
    let mut window = Window::default();
    let mut counts = chunk::CountCache::default();
    let mut family = "fam-a";
    let mut from = 1u64;
    let mut model = if seed.is_multiple_of(2) {
        "test/model"
    } else {
        "anthropic/claude-opus-5-5"
    };
    let mut serial = 0;
    let mut history: Vec<String> = Vec::new();
    for step in 0..steps {
        let change = mutate(
            &mut rng,
            &mut index,
            &mut family,
            &mut from,
            &mut model,
            &mut serial,
        );
        coverage
            .changes
            .insert(change.split(' ').next().unwrap_or_default().to_owned());
        history.push(change);
        let counter = Counter::for_model(Some(model));
        let (identity, changed) = index.summary_changes();
        let entries = index.entries();
        window.sync(entries, identity, changed, from, counter, &mut counts);
        let context = || {
            format!(
                "seed={seed:#x} step={step} model={model} from={from} base={} len={} last changes={:?}",
                index.base(),
                entries.len(),
                &history[history.len().saturating_sub(6)..]
            )
        };
        assert_eq!(
            window.prompt(entries).map(|entry| entry.ordinal),
            entries
                .iter()
                .rev()
                .find(|entry| trigger::is_meaningful_user(entry))
                .map(|entry| entry.ordinal),
            "newest prompt: {}",
            context()
        );
        let mut untils = Vec::new();
        for tail in [0, 1, 300, 5_000, 40_000, 200_000] {
            for lift in [false, true] {
                for cap in [0, 500, 30_000, 1_000_000_000] {
                    let expected = trigger::cap_run(
                        entries,
                        removed,
                        from,
                        trigger::tail_start(entries, raw, from, tail, lift),
                        cap,
                    );
                    assert_eq!(
                        window.bounded(entries, from, tail, lift, cap),
                        expected,
                        "bound tail={tail} lift={lift} cap={cap}: {}",
                        context()
                    );
                    untils.push(expected);
                }
            }
        }
        // Scans in a random order, as the trigger asks for several bounds
        // per notice and different budgets as settings change.
        let newest = entries.last().map_or(from, |entry| entry.ordinal);
        for _ in 0..8 {
            let until = if rng.below(2) == 0 {
                untils[rng.below(untils.len() as u64) as usize]
            } else {
                from.saturating_sub(1) + rng.below(newest.saturating_sub(from) + 3)
            };
            let budget = [0, 1, 60, 2_000, 30_000, u64::MAX][rng.below(6) as usize];
            let expected = legacy_scan(entries, from, until, budget, counter);
            match &expected {
                Some(scan) if scan.has_more => coverage.cut_scans += 1,
                Some(_) => coverage.whole_scans += 1,
                None => {}
            }
            assert_eq!(
                window.scan(entries, from, until, budget, counter, &mut counts),
                expected,
                "scan until={until} budget={budget}: {}",
                context()
            );
        }
        coverage.readable_bounds += untils.iter().filter(|until| **until > from).count();
    }
}

#[derive(Debug, Default)]
struct Coverage {
    changes: std::collections::BTreeSet<String>,
    cut_scans: usize,
    whole_scans: usize,
    readable_bounds: usize,
}

#[test]
fn review_cached_window_matches_the_unindexed_evaluator_under_every_index_change() {
    let mut coverage = Coverage::default();
    for seed in [
        0x1234_5678_9abc_def1u64,
        0x0bad_cafe_f00d_0002,
        0x5eed_0000_0000_0003,
    ] {
        run(seed, 250, &mut coverage);
    }
    // The comparison means little unless the sequences reached every kind
    // of change and the scans saw both complete and budget-cut chunks.
    for change in [
        "append",
        "rewrite",
        "tool",
        "speaks_for",
        "counts",
        "family",
        "truncate",
        "prune",
        "from",
        "model",
    ] {
        assert!(
            coverage.changes.contains(change),
            "never exercised {change}: {:?}",
            coverage.changes
        );
    }
    assert!(
        coverage.cut_scans > 0 && coverage.whole_scans > 0 && coverage.readable_bounds > 0,
        "{coverage:?}"
    );
}
