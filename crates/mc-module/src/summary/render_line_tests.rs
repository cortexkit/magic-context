//! The history block the line renders: day headings and how they read back,
//! legacy rows, the attribution of tokens, and what stays as it was.

use super::line::{NOT_SHOWN, TITLE};
use super::line_tests::Random;
use super::render::*;
use super::render_before_line;

/// Four tokens a character, roughly as real text counts.
fn chars(text: &str) -> usize {
    text.chars().count().div_ceil(4)
}

/// A generated session of `count` summaries with every stored form, about
/// `per_day` a day, scored by `score`.
fn session(
    count: usize,
    per_day: usize,
    score: impl Fn(&mut Random) -> i32,
) -> Vec<DecayRenderCompartment> {
    let mut random = Random::new(count as u64 * 31 + per_day as u64);
    let words = |random: &mut Random, low: u64, high: u64| {
        (0..random.between(low, high))
            .map(|n| {
                [
                    "parser", "fixed", "the", "store", "reader", "kept", "- item", "x < y",
                ][n as usize % 8]
            })
            .collect::<Vec<_>>()
            .join(" ")
    };
    (0..count)
        .map(|index| {
            let day = index / per_day;
            let date = format!("2026-{:02}-{:02}", 1 + day / 28 % 12, 1 + day % 28);
            let start = index as i64 * 10 + 1;
            DecayRenderCompartment {
                start_message: start,
                end_message: start + 9,
                title: format!("Work {index}: {}", words(&mut random, 3, 9)),
                content: String::new(),
                start_date: Some(date.clone()),
                end_date: Some(date),
                p1: Some(words(&mut random, 150, 700)),
                p2: Some(words(&mut random, 60, 200)),
                p3: Some(words(&mut random, 25, 80)),
                p4: Some(words(&mut random, 12, 50)),
                importance: Some(score(&mut random)),
                legacy: Some(0),
            }
        })
        .collect()
}

fn mixed_score(random: &mut Random) -> i32 {
    if random.between(1, 100) <= 8 {
        random.between(90, 100) as i32
    } else {
        random.between(15, 89) as i32
    }
}

#[test]
fn titles_of_one_day_share_a_heading_that_reads_back_as_the_same_ranges() {
    let comps = session(1_500, 30, mixed_score);
    let rendered = render_history(&comps, 12_000.0, chars);
    let sections: Vec<&str> = rendered.text.split("\n\n").collect();
    let mut items = rendered.items.iter().peekable();
    let (mut groups, mut single_titles) = (0, 0);
    for section in sections {
        let mut lines = section.lines();
        let heading = lines.next().unwrap();
        let rest: Vec<&str> = lines.collect();
        let group = heading
            .strip_suffix(" summaries")
            .and_then(|head| head.rsplit_once(" · "))
            .and_then(|(head, count)| Some((head, count.parse::<usize>().ok()?)))
            .filter(|(_, count)| {
                *count == rest.len() && rest.iter().all(|line| line.starts_with("- "))
            });
        match group {
            Some((head, count)) => {
                groups += 1;
                assert!(count >= 2);
                let (range, day) = head.strip_prefix("## ").unwrap().split_once(" · ").unwrap();
                let (start, end) = range.split_once('-').unwrap();
                let members: Vec<&DecayRenderCompartment> = (0..count)
                    .map(|_| {
                        let (index, tier, _) = items.next().unwrap();
                        assert_eq!(*tier, TITLE);
                        &comps[*index]
                    })
                    .collect();
                // The heading spans the run; each line names its own start
                // and title, in order.
                assert_eq!(start.parse::<i64>().unwrap(), members[0].start_message);
                assert_eq!(end.parse::<i64>().unwrap(), members[count - 1].end_message);
                for (line, member) in rest.iter().zip(&members) {
                    assert_eq!(member.start_date.as_deref(), Some(day));
                    let (at, title) = line.strip_prefix("- ").unwrap().split_once(": ").unwrap();
                    assert_eq!(at.parse::<i64>().unwrap(), member.start_message);
                    assert_eq!(
                        title,
                        member.title.replace('<', "&lt;").replace('>', "&gt;")
                    );
                }
                // Each line's stretch ends before the next line's start.
                for pair in members.windows(2) {
                    assert!(pair[0].end_message < pair[1].start_message);
                }
            }
            None => {
                let (index, tier, _) = items.next().unwrap();
                let c = &comps[*index];
                assert_eq!(section, render_compartment_at_tier(c, *tier));
                assert!(heading.starts_with(&format!("## {}-{}", c.start_message, c.end_message)));
                if *tier == TITLE {
                    // A title alone keeps today's heading.
                    single_titles += 1;
                    assert_eq!(section, heading);
                }
            }
        }
    }
    assert!(items.next().is_none());
    assert!(
        groups > 0 && single_titles > 0,
        "{groups} groups, {single_titles} single titles"
    );
}

#[test]
fn the_items_add_up_to_the_blocks_pieces() {
    let comps = session(1_500, 30, mixed_score);
    let rendered = render_history(&comps, 12_000.0, chars);
    let tokens: u64 = rendered.items.iter().map(|item| item.2).sum();
    assert_eq!(tokens + rendered.plan.joints, rendered.plan.total);
    assert!(rendered.items.iter().all(|item| item.1 < NOT_SHOWN));
    // A title under a day heading counts its own line, and the first one
    // also the heading.
    let mut items = rendered.items.iter();
    let mut grouped = 0;
    for section in rendered.text.split("\n\n") {
        let lines: Vec<&str> = section.lines().collect();
        if lines.len() > 1
            && lines[1..].iter().all(|line| line.starts_with("- "))
            && lines[0].ends_with(" summaries")
        {
            for (n, line) in lines[1..].iter().enumerate() {
                let expected = chars(line) + if n == 0 { chars(lines[0]) } else { 0 };
                assert_eq!(items.next().unwrap().2, expected as u64);
                grouped += 1;
            }
        } else {
            assert_eq!(items.next().unwrap().2, chars(section) as u64);
        }
    }
    assert!(grouped > 0);
}

#[test]
fn a_session_scored_on_another_scale_renders_the_same_bytes() {
    // Scores in steps of five, so 80 + s / 5 is a whole score in the same order.
    let ours = session(900, 20, |random| random.between(1, 20) as i32 * 5);
    let theirs: Vec<DecayRenderCompartment> = ours
        .iter()
        .map(|c| DecayRenderCompartment {
            importance: c.importance.map(|s| 80 + s / 5),
            ..c.clone()
        })
        .collect();
    for budget in [4_000.0, 20_000.0, 60_000.0] {
        let a = render_history(&ours, budget, chars);
        let b = render_history(&theirs, budget, chars);
        assert_eq!(a.text, b.text, "at {budget}");
        assert_eq!(a.items, b.items);
    }
}

#[test]
fn legacy_rows_never_render_longer_than_before() {
    let long = "U: please fix the reader\n".to_string() + &"A: done. ".repeat(400);
    let rows = [
        DecayRenderCompartment {
            start_message: 1,
            end_message: 2,
            title: "With a user line".into(),
            content: long.clone(),
            legacy: Some(1),
            importance: Some(95),
            ..Default::default()
        },
        DecayRenderCompartment {
            start_message: 3,
            end_message: 4,
            title: "Without one".into(),
            content: "A: ".to_string() + &"notes ".repeat(400),
            legacy: Some(1),
            importance: Some(95),
            ..Default::default()
        },
    ];
    for c in &rows {
        let before = render_compartment_at_tier(c, legacy_tier(c));
        for form in 1..=6 {
            let now = render_compartment_at_tier(c, rendered_tier(c, form));
            assert!(now.len() <= before.len(), "form {form}: {now}");
            if form <= legacy_tier(c) {
                assert_eq!(now, before, "form {form}");
            }
        }
        assert_eq!(
            render_compartment_at_tier(c, rendered_tier(c, TITLE)),
            render_compartment_at_tier(c, 4).lines().next().unwrap()
        );
    }
    // In full, a session with legacy rows renders them as before.
    let comps: Vec<DecayRenderCompartment> = rows
        .iter()
        .cloned()
        .chain(session(30, 10, mixed_score))
        .collect();
    let now = render_decayed_compartments(&comps, 1_000_000.0, chars);
    let (before, _) = render_before_line::render(&comps, 0.0, chars);
    assert!(now.starts_with(
        &before
            .split("\n\n")
            .take(2)
            .collect::<Vec<_>>()
            .join("\n\n")
    ));
}

#[test]
fn the_same_inputs_render_the_same_bytes() {
    let comps = session(2_000, 25, mixed_score);
    let first = render_history(&comps, 30_000.0, chars);
    let second = render_history(&comps, 30_000.0, |text: &str| chars(text));
    assert_eq!(first.text, second.text);
    assert_eq!(first.items, second.items);
    assert_eq!(first.plan, second.plan);
}

#[test]
fn an_empty_session_and_a_one_summary_session_render_as_before() {
    assert_eq!(render_decayed_compartments(&[], 60_000.0, chars), "");
    assert_eq!(render_before_line::render(&[], 60_000.0, chars).0, "");
    // Rows without content are not summaries.
    let empty = DecayRenderCompartment {
        start_message: 1,
        end_message: 4,
        ..Default::default()
    };
    assert_eq!(
        render_decayed_compartments(std::slice::from_ref(&empty), 60_000.0, chars),
        ""
    );
    for score in [1, 30, 59, 60, 100] {
        let mut one = session(1, 1, |_| score);
        for budget in [0.0, 60_000.0] {
            let now = render_history(&one, budget, chars);
            let (before, items) = render_before_line::render(&one, budget, chars);
            assert_eq!(now.text, before, "score {score} at {budget}");
            assert_eq!(now.items, items);
        }
        one[0].legacy = Some(1);
        one[0].content = "U: a question\nA: an answer".into();
        assert_eq!(
            render_decayed_compartments(&one, 60_000.0, chars),
            render_before_line::render(&one, 60_000.0, chars).0
        );
    }
}

#[test]
fn a_budget_of_zero_renders_as_for_an_unknown_window() {
    let comps = session(3_800, 30, mixed_score);
    let none = render_history(&comps, 0.0, chars);
    let fallback = render_history(
        &comps,
        super::line::HISTORY_BUDGET_WHEN_WINDOW_UNKNOWN,
        chars,
    );
    assert_eq!(none.text, fallback.text);
    assert!(none.plan.total as f64 <= super::line::HISTORY_BUDGET_WHEN_WINDOW_UNKNOWN);
}

#[test]
fn the_joined_body_is_held_to_the_budget_when_joining_takes_it_over() {
    // A counter that charges three tokens for each blank line that follows
    // a summary's body. Neither the pieces nor the joint measured between
    // headings show it, so the first plan's body is over, and the forms are
    // chosen again.
    let count = |text: &str| {
        let sections: Vec<&str> = text.split("\n\n").collect();
        let after_body = sections
            .windows(2)
            .filter(|pair| {
                pair[0]
                    .lines()
                    .last()
                    .is_some_and(|line| !line.starts_with("## ") && !line.starts_with("- "))
            })
            .count();
        chars(text) + 3 * after_body
    };
    let comps = session(2_000, 25, mixed_score);
    let mut replanned = 0;
    for budget in [5_000.0, 15_000.0, 30_000.0, 60_000.0, 98_000.0, 150_000.0] {
        let rendered = render_history(&comps, budget, count);
        assert!(
            count(&rendered.text) as f64 <= budget,
            "at {budget}: {:?}, plan total {} at {}",
            rendered.body_tokens,
            rendered.plan.total,
            rendered.plan.budget
        );
        assert!(rendered.body_tokens.len() <= 3);
        assert_eq!(
            *rendered.body_tokens.last().unwrap(),
            count(&rendered.text) as u64
        );
        if rendered.body_tokens.len() > 1 {
            replanned += 1;
            assert!(rendered.body_tokens[0] as f64 > budget);
        }
        // The same inputs give the same bytes, replans included.
        assert_eq!(render_history(&comps, budget, count).text, rendered.text);
    }
    assert!(replanned > 0);
}

/// The exact counter a fold uses for Claude models.
fn claude() -> crate::count::Counter {
    crate::count::Counter::for_model(Some("anthropic/claude-opus-5-5"))
}

/// The body fits the budget, or nothing is shown.
fn assert_fits_or_empty(rendered: &RenderedHistory, budget: f64, tokens: u64, at: &str) {
    assert!(
        tokens as f64 <= budget || rendered.text.is_empty(),
        "{at}: {tokens} tokens over {budget}, forms {:?}",
        rendered.items
    );
    assert_eq!(rendered.text.is_empty(), rendered.items.is_empty(), "{at}");
}

#[test]
fn budgets_below_one_summary_are_held() {
    let counter = claude();
    let count = |text: &str| counter.count(text) as usize;
    let normal = session(300, 25, mixed_score);
    for budget in [1.0, 10.0, 50.0] {
        let rendered = render_history(&normal[..1], budget, count);
        let tokens = counter.count(&rendered.text);
        assert_fits_or_empty(
            &rendered,
            budget,
            tokens,
            &format!("one summary at {budget}"),
        );
    }
    let mut high_newest = normal.clone();
    high_newest[299].importance = Some(95);
    let rendered = render_history(&high_newest, 200.0, count);
    let tokens = counter.count(&rendered.text);
    assert_fits_or_empty(
        &rendered,
        200.0,
        tokens,
        "300, the newest scored 95, at 200",
    );

    // One summary far larger than the budget, alone and as the newest of 300.
    let vocabulary = [
        "the",
        "reader",
        "parser",
        "kept",
        "diagnostics",
        "stable",
        "while",
        "summary_due",
        "crates/mc-module/src/session.rs",
        "traced",
        "notice",
        "through",
        "regression",
        "test",
        "cargo",
        "fold",
        "baseline",
        "budget",
        "cache",
        "prefix",
        "rebuild",
        "memory",
        "and",
        "of",
    ];
    let mut huge = normal[299].clone();
    huge.p1 = Some(
        vocabulary
            .iter()
            .cycle()
            .take(40_000)
            .copied()
            .collect::<Vec<_>>()
            .join(" "),
    );
    huge.importance = Some(80);
    let full = counter.count(&render_compartment_at_tier(&huge, 1));
    assert!(full > 100_000, "the large summary is {full} tokens");
    for budget in [2_000.0, 25_000.0, 60_000.0] {
        let rendered = render_history(std::slice::from_ref(&huge), budget, count);
        let tokens = counter.count(&rendered.text);
        assert_fits_or_empty(&rendered, budget, tokens, &format!("one large at {budget}"));
    }
    let mut with = normal.clone();
    with[299] = huge;
    let rendered = render_history(&with, 30_000.0, count);
    let tokens = counter.count(&rendered.text);
    assert_fits_or_empty(
        &rendered,
        30_000.0,
        tokens,
        "300, the newest large, at 30000",
    );
}

/// For any session and any budget from one token up, the body fits, or it
/// is empty.
#[test]
fn the_body_fits_its_budget_or_is_empty_for_generated_sessions() {
    let mut random = Random::new(80);
    for count in [1, 2, 5, 30, 120, 400] {
        let comps = session(count, 1 + random.between(1, 40) as usize, mixed_score);
        for budget in [1.0, 3.0, 10.0, 30.0, 80.0, 200.0, 600.0, 2_000.0, 8_000.0] {
            let rendered = render_history(&comps, budget, chars);
            let tokens = chars(&rendered.text) as u64;
            assert_fits_or_empty(&rendered, budget, tokens, &format!("{count} at {budget}"));
        }
    }
}

const LATIN: [&str; 24] = [
    "the",
    "reader",
    "parser",
    "kept",
    "diagnostics",
    "stable",
    "while",
    "summary_due",
    "crates/mc-module/src/session.rs",
    "traced",
    "notice",
    "through",
    "regression",
    "test",
    "cargo",
    "fold",
    "baseline",
    "budget",
    "cache",
    "prefix",
    "rebuild",
    "memory",
    "and",
    "of",
];
const CJK: [&str; 24] = [
    "解析器",
    "读取了文件",
    "并保持诊断稳定",
    "缓存前缀",
    "重建",
    "の設定を確認した",
    "テストを追加",
    "メモリ",
    "🚀",
    "✅",
    "🔧📦",
    "历史记录",
    "折叠",
    "基线",
    "ストア",
    "和",
    "の",
    "在",
    "😀😀",
    "检查",
    "修复",
    "👍",
    "変更",
    "确认",
];
const CODE: [&str; 24] = [
    "```rust\nfn render_history_with_line(rows: &[Row]) -> RenderedHistory {\n    todo!()\n}\n```",
    "HISTORY_BUDGET_WHEN_WINDOW_UNKNOWN",
    "crate::summary::line::CountedCosts::new",
    "`render_decayed_with_items`",
    "0x9E37_79B9_7F4A_7C15",
    "{\"tier\":5,\"tokens\":20}",
    "SELECT message_id, at_ms FROM app_read_message_index",
    "->",
    "=>",
    "&&",
    "||",
    "/Users/someone/Work/Projects/CortexKit/magic-context/crates/mc-module/src/summary/head.rs:430",
    "assert_eq!(plan.total, 4991);",
    "Vec<Vec<usize>>",
    "fn",
    "let",
    "impl",
    "the",
    "and",
    "a3f9c0d2e1b4",
    "--features memory-replica",
    "cargo test --locked",
    "§12§",
    "x<y&z",
];

/// A generated summary written in `vocabulary`, its forms sized like real
/// ones (about 250, 115, 50 and 40 words), 25 summaries a day.
pub(super) fn scripted_row(
    random: &mut Random,
    index: usize,
    vocabulary: &[&str; 24],
) -> DecayRenderCompartment {
    let text = |random: &mut Random, words: u64| {
        (0..random.between(words * 6 / 10, words * 14 / 10))
            .map(|_| vocabulary[random.between(0, 23) as usize])
            .collect::<Vec<_>>()
            .join(" ")
    };
    let start = index as i64 * 12 + 1;
    let day = index / 25;
    let date = format!("2026-{:02}-{:02}", 1 + day / 28 % 12, 1 + day % 28);
    DecayRenderCompartment {
        start_message: start,
        end_message: start + 11,
        title: text(random, 18),
        content: String::new(),
        start_date: Some(date.clone()),
        end_date: Some(date),
        p1: Some(text(random, 250)),
        p2: Some(text(random, 115)),
        p3: Some(text(random, 50)),
        p4: Some(text(random, 40)),
        importance: Some(if random.between(1, 100) <= 8 {
            random.between(90, 100) as i32
        } else {
            random.between(15, 89) as i32
        }),
        legacy: Some(0),
    }
}

/// The scripts the fold-time and budget measurements use, by name: which
/// vocabulary summary `index` of `count` is written in.
pub(super) fn script(name: &str, index: usize, count: usize) -> &'static [&'static str; 24] {
    match name {
        "latin" => &LATIN,
        "cjk" => &CJK,
        "newest 400 cjk" if index + 400 >= count => &CJK,
        "newest 400 cjk" => &LATIN,
        "oldest cjk, newest 800 code" if index + 800 >= count => &CODE,
        "oldest cjk, newest 800 code" => &CJK,
        // 64 rows spread evenly over the session in Latin, the rest in CJK and
        // emoji: a sample of rows says little about the rest.
        "sample rows latin"
            if (0..64.min(count)).any(|k| k * (count - 1) / 63.min(count - 1).max(1) == index) =>
        {
            &LATIN
        }
        "sample rows latin" => &CJK,
        other => panic!("no script {other}"),
    }
}

pub(super) fn scripted_session(name: &str, count: usize, seed: u64) -> Vec<DecayRenderCompartment> {
    let mut random = Random::new(seed);
    (0..count)
        .map(|index| scripted_row(&mut random, index, script(name, index, count)))
        .collect()
}

/// Each piece counted for real with `counter`, once.
struct Counted<'r> {
    rows: Vec<&'r DecayRenderCompartment>,
    counter: crate::count::Counter,
    pieces: std::collections::HashMap<(usize, u8), u64>,
    joint: f64,
}

impl super::line::Costs for Counted<'_> {
    fn piece(&mut self, index: usize, form: u8) -> u64 {
        let (rows, counter) = (&self.rows, self.counter);
        *self.pieces.entry((index, form)).or_insert_with(|| {
            counter.count(&render_compartment_at_tier(
                rows[index],
                rendered_tier(rows[index], form),
            ))
        })
    }
    fn group_line(&mut self, index: usize) -> u64 {
        let (rows, counter) = (&self.rows, self.counter);
        *self
            .pieces
            .entry((index, 0))
            .or_insert_with(|| counter.count(&group_line(rows[index])))
    }
    fn group_header(&mut self, members: &[usize]) -> u64 {
        self.counter.count(&group_header(&self.rows, members))
    }
    fn joint(&mut self) -> f64 {
        self.joint
    }
}

/// A session written mostly in one script and, at its newest end, in
/// another chooses what a search on real counts alone chooses: no estimate
/// from a sample of the session's text leaves budget unused.
#[test]
fn a_mixed_script_session_uses_its_budget_as_real_counts_choose() {
    let counter = claude();
    let rows = scripted_session("oldest cjk, newest 800 code", 3_800, 77);
    let refs: Vec<&DecayRenderCompartment> = rows.iter().collect();
    let summaries: Vec<super::line::Summary> = rows
        .iter()
        .map(|c| super::line::Summary {
            score: f64::from(c.importance.unwrap().clamp(1, 100)),
            scored: true,
            day: c.start_date.as_deref(),
        })
        .collect();
    // The joint as the render measures it: on the newest 16 heading pairs.
    let added: i64 = (rows.len() - 17..rows.len() - 1)
        .map(|i| {
            let (a, b) = (
                compartment_heading(&rows[i]),
                compartment_heading(&rows[i + 1]),
            );
            counter.count(&format!("{a}\n\n{b}")) as i64
                - counter.count(&a) as i64
                - counter.count(&b) as i64
        })
        .sum();
    let mut real = Counted {
        rows: refs,
        counter,
        pieces: Default::default(),
        joint: (added as f64 / 16.0).max(0.0),
    };
    for budget in [30_000.0, 60_000.0, 98_000.0] {
        let rendered = render_history(&rows, budget, |text: &str| counter.count(text) as usize);
        let expected = super::line::plan(
            &summaries,
            budget,
            &mut real,
            super::line::Options::default(),
        );
        assert_eq!(rendered.body_tokens.len(), 1, "at {budget}");
        assert_eq!(
            (rendered.plan.stretch, rendered.plan.total),
            (expected.stretch, expected.total),
            "at {budget}"
        );
        assert_eq!(rendered.plan.forms, expected.forms, "at {budget}");
    }
}

/// A fold counts each piece once for the session: a later fold of the same
/// summaries counts none of them again and renders the same bytes.
#[test]
fn a_later_render_counts_only_what_no_earlier_one_counted() {
    let comps = session(1_200, 25, mixed_score);
    // Counts of texts that are one summary's piece: not joined text (the
    // body, or a heading pair the joint is measured on) and not a day
    // heading, which are counted each render.
    let pieces = std::cell::Cell::new(0usize);
    let count = |text: &str| {
        if !text.contains("\n\n") && !(text.starts_with("## ") && text.ends_with(" summaries")) {
            pieces.set(pieces.get() + 1);
        }
        chars(text)
    };
    let mut known = vec![super::line::PieceCounts::default(); comps.len()];
    let first = render_history_counted(
        &comps,
        30_000.0,
        count,
        &mut known,
        super::line::Options::default(),
    );
    let cold = pieces.replace(0);
    let second = render_history_counted(
        &comps,
        30_000.0,
        count,
        &mut known,
        super::line::Options::default(),
    );
    let warm = pieces.get();
    assert_eq!((first.text, first.items), (second.text, second.items));
    assert!(cold > 100, "{cold} counts");
    // Only the 16 heading pairs the joint is measured on, each heading on
    // its own.
    assert!(warm <= 32, "{warm} counts");
}

/// The session keeps counts by summary and counter: another counter starts
/// over, a summary whose heading would change is counted again, and a
/// summary the session no longer has is forgotten.
#[test]
fn kept_counts_follow_the_summary_and_the_counter() {
    use crate::context_db::StoredCompartment;
    let summary = |sequence: i64, start: i64| StoredCompartment {
        sequence,
        start_message: start,
        end_message: start + 9,
        title: format!("Work {sequence}"),
        p1: Some("full".into()),
        start_date: Some("2026-01-01".into()),
        end_date: Some("2026-01-01".into()),
        ..Default::default()
    };
    let rows = vec![summary(1, 1), summary(2, 11), summary(3, 21)];
    let exact = claude();
    let estimator = crate::count::Counter::estimated_for_model(Some("anthropic/claude-opus-5-5"));
    let counted = super::line::PieceCounts {
        forms: [Some(7), None, None, None, Some(3)],
        line: Some(2),
    };
    let counts = HistoryCounts::default();
    assert_eq!(counts.known(exact, &rows), vec![Default::default(); 3]);
    counts.keep(exact, &rows, vec![counted; 3]);
    assert_eq!(counts.known(exact, &rows), vec![counted; 3]);
    // A summary that would render another heading is counted again.
    let mut dated = rows.clone();
    dated[0].start_date = Some("2025-12-31".into());
    assert_eq!(counts.known(exact, &dated)[0], Default::default());
    // After a revert, another summary at sequence 3 is not the counted one.
    let mut reverted = rows.clone();
    reverted[2] = summary(3, 25);
    assert_eq!(counts.known(exact, &reverted)[2], Default::default());
    counts.retain(|sequence| sequence <= 2);
    assert_eq!(counts.len(), 2);
    assert_eq!(counts.known(exact, &rows)[2], Default::default());
    // Another counter counts differently: everything is counted again.
    assert_eq!(counts.known(estimator, &rows), vec![Default::default(); 3]);
    assert_eq!(counts.known(exact, &rows), vec![Default::default(); 3]);
    assert_eq!(counts.len(), 0);
}

/// A revert that removes summaries removes their counts with them.
#[test]
fn a_revert_forgets_the_counts_of_the_summaries_it_removed() {
    use crate::context_db::StoredCompartment;
    let mut summaries = super::index::Summaries::default();
    summaries.replace(
        (0..4)
            .map(|sequence| StoredCompartment {
                sequence,
                start_message: sequence * 10 + 1,
                end_message: sequence * 10 + 10,
                title: format!("Work {sequence}"),
                ..Default::default()
            })
            .collect(),
    );
    let rows: Vec<StoredCompartment> = (0..4)
        .map(|sequence| StoredCompartment {
            sequence,
            start_message: sequence * 10 + 1,
            end_message: sequence * 10 + 10,
            ..Default::default()
        })
        .collect();
    let counted = super::line::PieceCounts {
        forms: [Some(7); 5],
        line: Some(2),
    };
    summaries.counts().known(claude(), &rows);
    summaries.counts().keep(claude(), &rows, vec![counted; 4]);
    assert_eq!(summaries.counts().len(), 4);
    summaries.truncate(2);
    assert_eq!(summaries.counts().len(), 2);
    // A clone shares the counts: they describe the summaries, not the list.
    let clone = summaries.clone();
    clone.counts().retain(|_| false);
    assert_eq!(summaries.counts().len(), 0);
}

/// The rendered bytes and items are the same whether each sum stops once it
/// is over the budget or adds up every piece, over sessions in several
/// scripts and budgets from one token to more than everything costs.
#[test]
fn stopping_the_sums_early_renders_the_same_bytes() {
    let all = super::line::Options {
        stop_early: false,
        ..Default::default()
    };
    let check = |comps: &[DecayRenderCompartment], count: &dyn Fn(&str) -> usize, at: &str| {
        let full: usize = comps
            .iter()
            .map(|c| count(&render_compartment_at_tier(c, 1)) + 2)
            .sum();
        for budget in [1, 50, 400, 3_000, 15_000, 60_000, full, full * 2] {
            let early = render_history(comps, budget as f64, count);
            let every = render_history_with(comps, budget as f64, count, all);
            assert_eq!(early.text, every.text, "{at} at {budget}");
            assert_eq!(early.items, every.items, "{at} at {budget}");
            assert_eq!(early.body_tokens, every.body_tokens, "{at} at {budget}");
        }
    };
    for (script, count) in [
        ("latin", 1),
        ("cjk", 30),
        ("newest 400 cjk", 600),
        ("oldest cjk, newest 800 code", 4_000),
    ] {
        let comps = scripted_session(script, count, 11);
        check(&comps, &chars, &format!("{script}, {count}"));
    }
    let counter = claude();
    let exact = |text: &str| counter.count(text) as usize;
    check(
        &scripted_session("oldest cjk, newest 800 code", 900, 12),
        &exact,
        "exact, 900",
    );
}

/// The first plan already leaves room for what joining the pieces adds, as
/// measured on the newest headings: with a counter that charges two tokens
/// for every blank line between pieces, the body fits at the first plan,
/// and the plan's joints are exactly those two tokens a joint.
#[test]
fn the_first_plan_charges_the_joints_between_pieces() {
    let count = |text: &str| text.split_whitespace().count() + text.matches('\n').count();
    let comps = session(1_500, 30, mixed_score);
    for budget in [5_000.0, 30_000.0, 98_000.0] {
        let rendered = render_history(&comps, budget, count);
        let plan = &rendered.plan;
        let pieces =
            plan.forms.iter().filter(|&&form| form < NOT_SHOWN).count() + plan.groups.len();
        assert_eq!(plan.joints, 2 * (pieces as u64 - 1), "at {budget}");
        assert_eq!(
            rendered.body_tokens.len(),
            1,
            "at {budget}: {:?}",
            rendered.body_tokens
        );
        assert!(rendered.body_tokens[0] as f64 <= budget);
        // A line under a day heading joins with one newline, not two.
        assert!(rendered.body_tokens[0] <= plan.total);
    }
}
