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
