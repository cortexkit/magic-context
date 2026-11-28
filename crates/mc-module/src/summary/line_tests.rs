//! The history line's choices, on injected token costs: the reference
//! calculation's results on a real session's shape
//! (`testdata/history-line-shape.json`), and the line's promises on
//! generated sessions.

use super::line::*;

/// Token costs given per summary: its five forms, its line under a day
/// heading, and one cost for any day heading.
pub(super) struct Table {
    pub forms: Vec<[u64; 5]>,
    pub lines: Vec<u64>,
    pub header: u64,
}

impl Costs for Table {
    fn piece(&mut self, index: usize, form: u8) -> u64 {
        self.forms[index][usize::from(form - 1)]
    }
    fn group_line(&mut self, index: usize) -> u64 {
        self.lines[index]
    }
    fn group_header(&mut self, _heading: Heading) -> u64 {
        self.header
    }
}

/// A small deterministic generator (splitmix64), so every run sees the same
/// sessions.
pub(super) struct Random(u64);

impl Random {
    pub fn new(seed: u64) -> Self {
        Self(seed)
    }
    pub fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    /// A number in `low..=high`.
    pub fn between(&mut self, low: u64, high: u64) -> u64 {
        low + self.next() % (high - low + 1)
    }
}

/// A generated session: scores, days and costs shaped like real ones (the
/// sizes of the forms in testdata/history-line-shape.json, a few summaries scored 90 or more, about
/// 25 summaries a day).
pub(super) struct Generated {
    pub scores: Vec<f64>,
    pub days: Vec<String>,
}

impl Generated {
    pub fn new(random: &mut Random, count: usize) -> (Self, Table) {
        let per_day = random.between(5, 60) as usize;
        let mut scores = Vec::with_capacity(count);
        let mut days = Vec::with_capacity(count);
        let mut forms = Vec::with_capacity(count);
        let mut lines = Vec::with_capacity(count);
        for index in 0..count {
            let score = if random.between(1, 100) <= 8 {
                random.between(90, 100)
            } else {
                random.between(15, 89)
            };
            scores.push(score as f64);
            let day = index / per_day;
            days.push(format!("2026-{:02}-{:02}", 1 + day / 28 % 12, 1 + day % 28));
            let title = random.between(15, 35);
            forms.push([
                random.between(150, 900),
                random.between(60, 260),
                random.between(30, 100),
                random.between(20, 75),
                title,
            ]);
            lines.push(title - 4);
        }
        (
            Self { scores, days },
            Table {
                forms,
                lines,
                header: 12,
            },
        )
    }

    pub fn summaries(&self) -> Vec<Summary<'_>> {
        self.scores
            .iter()
            .zip(&self.days)
            .map(|(&score, day)| Summary {
                score,
                scored: true,
                day: Some(day),
            })
            .collect()
    }
}

/// The form the line alone gives each summary at `stretch`.
fn line_forms(scores: &[f64], stretch: f64) -> Vec<u8> {
    let count = scores.len();
    (0..count)
        .map(|index| {
            form_under_line(
                scores[index],
                line_height((count - 1 - index) as f64, stretch),
            )
        })
        .collect()
}

/// The line, the floor and the step down alone, without the titles that
/// fill what they leave of the budget.
fn no_fill() -> Options {
    Options {
        fill: false,
        ..Options::default()
    }
}

fn fnv1a32(forms: &[u8]) -> u32 {
    forms.iter().fold(2_166_136_261u32, |hash, &form| {
        (hash ^ u32::from(form)).wrapping_mul(16_777_619)
    })
}

#[test]
fn the_line_matches_the_lab_on_a_real_sessions_shape() {
    #[derive(serde::Deserialize)]
    struct Row {
        score: f64,
        date: String,
        costs: [u64; 5],
    }
    #[derive(serde::Deserialize)]
    struct Expected {
        budget: f64,
        stretch: f64,
        tokens: u64,
        counts_full_lighter_condensed_line_title_hidden: [usize; 6],
        floor_titles: usize,
        levels_fnv1a32: u32,
    }
    #[derive(serde::Deserialize)]
    struct Fixture {
        rows: Vec<Row>,
        expected: Vec<Expected>,
    }
    // One real session's history without text (scores, start days and the
    // token cost of each form) and what the reference calculation
    // (`export-shape.mjs`) chose for six budgets, with the floor on, scores as
    // stored and no day headings.
    let fixture: Fixture =
        serde_json::from_str(include_str!("../../testdata/history-line-shape.json")).unwrap();
    assert_eq!(fixture.rows.len(), 3782);
    assert_eq!(fixture.expected.len(), 6);
    let summaries: Vec<Summary> = fixture
        .rows
        .iter()
        .map(|row| Summary {
            score: row.score,
            scored: true,
            day: Some(&row.date),
        })
        .collect();
    let mut table = Table {
        forms: fixture.rows.iter().map(|row| row.costs).collect(),
        lines: vec![0; fixture.rows.len()],
        header: 0,
    };
    let options = Options {
        reference_scale: false,
        day_headers: false,
        ..no_fill()
    };
    for expected in &fixture.expected {
        let plan = plan(&summaries, expected.budget, &mut table, options);
        let stretch = plan.stretch.expect("the session does not fit in full");
        assert_eq!(
            format!("{stretch:.6}"),
            format!("{:.6}", expected.stretch),
            "stretch at {}",
            expected.budget
        );
        assert_eq!(plan.total, expected.tokens, "tokens at {}", expected.budget);
        let mut counts = [0usize; 6];
        for &form in &plan.forms {
            counts[usize::from(form - 1)] += 1;
        }
        assert_eq!(
            counts, expected.counts_full_lighter_condensed_line_title_hidden,
            "counts at {}",
            expected.budget
        );
        let by_line = line_forms(&plan.scores, stretch);
        let floor = plan
            .forms
            .iter()
            .zip(&by_line)
            .filter(|&(&form, &line)| form == TITLE && line == NOT_SHOWN)
            .count();
        assert_eq!(floor, expected.floor_titles, "floor at {}", expected.budget);
        assert_eq!(
            fnv1a32(&plan.forms),
            expected.levels_fnv1a32,
            "forms at {}",
            expected.budget
        );
    }
}

const SIZES: [usize; 12] = [1, 2, 7, 49, 50, 51, 120, 300, 1_200, 2_500, 3_800, 5_000];
const BUDGETS: [f64; 7] = [
    2_000.0, 5_000.0, 15_000.0, 30_000.0, 60_000.0, 98_000.0, 200_000.0,
];

#[test]
fn generated_sessions_keep_the_lines_promises_at_every_budget() {
    let mut random = Random::new(1127);
    for &count in &SIZES {
        for round in 0..2 {
            let (session, mut table) = Generated::new(&mut random, count);
            let summaries = session.summaries();
            let full: u64 = table.forms.iter().map(|forms| forms[0]).sum();
            let mut previous: Option<Vec<u8>> = None;
            for &budget in &BUDGETS {
                let plan = plan(&summaries, budget, &mut table, no_fill());
                let at = format!("{count} summaries (round {round}) at {budget}");

                // Within the budget.
                assert!(plan.total as f64 <= budget, "{at}: {} tokens", plan.total);
                // In full exactly when everything fits in full.
                assert_eq!(plan.stretch.is_none(), full as f64 <= budget, "{at}");

                // A larger budget never shortens a summary.
                if let Some(previous) = &previous {
                    for (index, (&now, &before)) in plan.forms.iter().zip(previous).enumerate() {
                        assert!(
                            now <= before,
                            "{at}: summary {index} went {before} -> {now}"
                        );
                    }
                }
                previous = Some(plan.forms.clone());

                let Some(stretch) = plan.stretch else {
                    assert!(plan.forms.iter().all(|&form| form == FULL), "{at}");
                    continue;
                };
                let by_line = line_forms(&plan.scores, stretch);
                for (index, (&form, &line)) in plan.forms.iter().zip(&by_line).enumerate() {
                    // Never longer than the line gives, except a hidden summary
                    // scored 90 or more that the floor brings back as a title.
                    let floor =
                        line == NOT_SHOWN && form == TITLE && plan.floor_scores[index] >= 90.0;
                    assert!(
                        form >= line || floor,
                        "{at}: summary {index} at {form}, line {line}"
                    );
                    // Never shorter than the line gives: nothing is cut to
                    // make room.
                    assert!(form <= line, "{at}: summary {index} at {form}, line {line}");
                }
                // So no older one-line or title form is left out while a
                // newer summary keeps a longer form than the line gives it.
                for (older, (&form, &line)) in plan.forms.iter().zip(&by_line).enumerate() {
                    if form == NOT_SHOWN && (line == 4 || line == TITLE) {
                        let newer_longer =
                            (older + 1..count).find(|&newer| plan.forms[newer] < by_line[newer]);
                        assert_eq!(newer_longer, None, "{at}: summary {older} left out");
                    }
                }
            }
        }
    }
}

/// Budgets from one token up, including budgets smaller than the newest
/// summary alone: the forms fit, or nothing is shown. When the line at its
/// smallest stretch is still over, the summaries it shows are stepped down
/// oldest first, each one form at a time until it is hidden before the next
/// newer one is touched, and the stepping stops as soon as the total fits.
#[test]
fn the_plan_fits_its_budget_or_is_empty_at_any_budget() {
    let mut random = Random::new(1128);
    let mut stepped = 0;
    for &count in &[1, 2, 7, 50, 51, 300, 1_200] {
        for round in 0..2 {
            let (session, mut table) = Generated::new(&mut random, count);
            let summaries = session.summaries();
            for budget in [
                1.0, 5.0, 20.0, 50.0, 120.0, 200.0, 700.0, 1_500.0, 3_000.0, 10_000.0,
            ] {
                let at = format!("{count} summaries (round {round}) at {budget}");
                let filled = plan(&summaries, budget, &mut table, Options::default());
                assert!(
                    filled.total as f64 <= budget,
                    "{at}: {} tokens",
                    filled.total
                );
                let plan = plan(&summaries, budget, &mut table, no_fill());
                assert!(plan.total as f64 <= budget, "{at}: {} tokens", plan.total);
                if plan.stretch != Some(STRETCH_MIN) {
                    continue;
                }
                let scores = Scores {
                    line: &plan.scores,
                    floor: &plan.floor_scores,
                };
                let on_line = forms_on_line(scores, STRETCH_MIN, budget, &mut table);
                let Some(last) = (0..count).rev().find(|&i| plan.forms[i] != on_line[i]) else {
                    continue;
                };
                stepped += 1;
                // Everything older than the last summary stepped down is hidden,
                // everything newer keeps the line's form, and that summary is
                // one form short of not fitting.
                assert!(
                    plan.forms[..last].iter().all(|&form| form == NOT_SHOWN),
                    "{at}"
                );
                assert_eq!(plan.forms[last + 1..], on_line[last + 1..], "{at}");
                assert!(plan.forms[last] > on_line[last], "{at}");
                let mut longer = plan.forms.clone();
                longer[last] -= 1;
                let (_, total) = cost_of(&summaries, &longer, &mut table, Options::default());
                assert!(total as f64 > budget, "{at}: stepped one form too far");
            }
        }
    }
    assert!(stepped > 0);
}

#[test]
fn everything_is_full_exactly_while_it_fits_in_full() {
    let mut random = Random::new(7);
    let (session, mut table) = Generated::new(&mut random, 400);
    let summaries = session.summaries();
    let full: u64 = table.forms.iter().map(|forms| forms[0]).sum();

    let fits = plan(&summaries, full as f64, &mut table, Options::default());
    assert_eq!(fits.stretch, None);
    assert!(fits.forms.iter().all(|&form| form == FULL));
    assert_eq!(fits.total, full);

    let over = plan(
        &summaries,
        full as f64 - 1.0,
        &mut table,
        Options::default(),
    );
    let stretch = over.stretch.expect("one token short uses the line");
    assert!(over.total < full);
    assert!(over.forms.iter().any(|&form| form != FULL));
    // Just over the point, the widest line may leave budget unused; it is
    // still within the budget.
    assert!(over.total as f64 <= full as f64 - 1.0);
    assert!(stretch <= 12.0);
}

#[test]
fn a_budget_of_zero_or_less_uses_the_fallback_for_an_unknown_window() {
    let mut random = Random::new(3);
    let (session, mut table) = Generated::new(&mut random, 3_800);
    let summaries = session.summaries();
    let fallback = plan(
        &summaries,
        HISTORY_BUDGET_WHEN_WINDOW_UNKNOWN,
        &mut table,
        Options::default(),
    );
    for budget in [0.0, -1.0] {
        let none = plan(&summaries, budget, &mut table, Options::default());
        assert_eq!(none, fallback);
        assert_eq!(none.budget, HISTORY_BUDGET_WHEN_WINDOW_UNKNOWN);
        assert!(none.total as f64 <= HISTORY_BUDGET_WHEN_WINDOW_UNKNOWN);
    }
}

#[test]
fn another_scorers_scale_maps_onto_the_reference_scale() {
    // A scorer that gives everything 80 to 99 in the same order picks every
    // form exactly as ours, through the ranks.
    let mut random = Random::new(42);
    for count in [60, 900, 3_800] {
        let (session, mut table) = Generated::new(&mut random, count);
        let ours = session.summaries();
        let inflated_scores: Vec<f64> = session.scores.iter().map(|s| 80.0 + s / 5.0).collect();
        let inflated: Vec<Summary> = ours
            .iter()
            .zip(&inflated_scores)
            .map(|(summary, &score)| Summary { score, ..*summary })
            .collect();
        for budget in [5_000.0, 30_000.0, 98_000.0] {
            let a = plan(&ours, budget, &mut table, Options::default());
            let b = plan(&inflated, budget, &mut table, Options::default());
            assert_eq!(a.forms, b.forms, "{count} at {budget}");
            assert_eq!(a.stretch, b.stretch);
        }
    }
}

#[test]
fn fewer_than_fifty_scored_summaries_keep_their_scores() {
    let summary = |score: f64, scored: bool| Summary {
        score,
        scored,
        day: None,
    };
    let stored: Vec<f64> = (0..49).map(|n| f64::from(n % 7 * 10 + 30)).collect();
    let few: Vec<Summary> = stored.iter().map(|&s| summary(s, true)).collect();
    assert_eq!(line_scores(&few, true), stored);
    // Fifty summaries, but only 49 with a stored score: still the stored ones.
    let mut unscored = few.clone();
    unscored.push(summary(50.0, false));
    assert_eq!(line_scores(&unscored, true)[..49], stored[..]);
    // Fifty scored: the reference scale.
    let mut enough = few.clone();
    enough.push(summary(50.0, true));
    assert_ne!(line_scores(&enough, true)[..49], stored[..]);
    // And off when the caller turns it off.
    assert_eq!(line_scores(&enough, false)[..49], stored[..]);
}

#[test]
fn tied_scores_get_one_reference_value_from_the_middle_of_their_rank() {
    let summaries: Vec<Summary> = (0..100)
        .map(|n| Summary {
            score: if n < 50 { 40.0 } else { f64::from(n) },
            scored: true,
            day: None,
        })
        .collect();
    let mapped = line_scores(&summaries, true);
    assert!(mapped[..50].iter().all(|&value| value == mapped[0]));
    // Fifty tied at the bottom of a hundred: their rank is the middle of
    // their group, 25, where the table reads 58.
    assert_eq!(mapped[0], 58.0);
    // The highest score is at rank 99.5: half way from 88 to 95.
    assert_eq!(mapped[99], 91.5);
    assert_eq!(reference_score(0.0), 1.0);
    assert_eq!(reference_score(50.0), 70.0);
    assert_eq!(reference_score(100.0), 95.0);
    assert_eq!(reference_score(150.0), 95.0);
}

#[test]
fn the_floor_takes_the_highest_scores_first_and_stops_at_five_percent() {
    // 400 summaries all scored 95 or more except the newest ones, which fill
    // the budget, so the line hides the old ones and only the floor can bring
    // them back.
    let count = 400;
    let mut random = Random::new(11);
    let summaries: Vec<Summary> = (0..count)
        .map(|index| Summary {
            score: if index < count - 5 {
                90.0 + random.between(0, 10) as f64
            } else {
                99.0
            },
            scored: false,
            day: None,
        })
        .collect();
    let mut table = Table {
        forms: (0..count)
            .map(|index| {
                if index < count - 5 {
                    [800, 400, 200, 100, 20 + index as u64 % 7]
                } else {
                    [1_500, 1_400, 1_300, 1_200, 20]
                }
            })
            .collect(),
        lines: vec![10; count],
        header: 10,
    };
    let budget = 10_000.0;
    let options = Options {
        reference_scale: false,
        day_headers: false,
        ..no_fill()
    };
    let plan = plan(&summaries, budget, &mut table, options);
    let stretch = plan.stretch.unwrap();
    let by_line = line_forms(&plan.scores, stretch);
    let floored: Vec<usize> = (0..count)
        .filter(|&i| by_line[i] == NOT_SHOWN && plan.forms[i] == TITLE)
        .collect();
    let left: Vec<usize> = (0..count).filter(|&i| plan.forms[i] == NOT_SHOWN).collect();
    assert!(!floored.is_empty() && !left.is_empty());
    let spent: u64 = floored.iter().map(|&i| table.forms[i][4]).sum();
    assert!(spent as f64 <= 0.05 * budget, "spent {spent}");
    // The next in line did not fit what was left.
    let order = |a: &usize, b: &usize| {
        let (a, b) = (*a, *b);
        plan.scores[b].total_cmp(&plan.scores[a]).then(b.cmp(&a))
    };
    let next = *left.iter().min_by(|a, b| order(a, b)).unwrap();
    assert!(table.forms[next][4] as f64 > 0.05 * budget - spent as f64);
    // Every floored title comes before every summary left out, by score and
    // then the newer first.
    for &taken in &floored {
        for &out in &left {
            assert_eq!(order(&taken, &out), std::cmp::Ordering::Less);
        }
    }
}

#[test]
fn the_floor_brings_back_only_scores_of_ninety_or_more() {
    let count = 300;
    let summaries: Vec<Summary> = (0..count)
        .map(|index| Summary {
            score: if index == 0 { 89.0 } else { 40.0 },
            scored: false,
            day: None,
        })
        .collect();
    let mut table = Table {
        forms: vec![[500, 200, 80, 40, 20]; count],
        lines: vec![10; count],
        header: 10,
    };
    let plan = plan(&summaries, 2_000.0, &mut table, no_fill());
    assert_eq!(plan.forms[0], NOT_SHOWN);
}

#[test]
fn titles_of_one_day_group_over_hidden_summaries_and_break_at_other_forms_and_days() {
    let day = |d: &'static str| Some(d);
    let summaries: Vec<Summary> = [
        day("2026-10-16"),
        day("2026-10-16"),
        day("2026-10-16"),
        day("2026-10-16"),
        day("2026-10-16"),
        day("2026-10-17"),
        day("2026-10-17"),
        None,
        day("2026-10-17"),
        day("2026-10-17"),
        day("2026-10-17"),
    ]
    .into_iter()
    .map(|day| Summary {
        score: 50.0,
        scored: true,
        day,
    })
    .collect();
    // titles 0, 1 (with 2 hidden between) and 3; 4 is one line; 5 and 6 on
    // the next day; 7 has no day; 8 alone; 9 condensed; 10 alone.
    let forms = [5, 5, 6, 5, 4, 5, 5, 5, 5, 3, 5];
    assert_eq!(
        day_groups(&summaries, &forms),
        vec![vec![0, 1, 3], vec![5, 6]]
    );
}

/// Costs that count how many pieces were asked for.
struct Asked<'t> {
    table: &'t mut Table,
    asked: usize,
}

impl Costs for Asked<'_> {
    fn piece(&mut self, index: usize, form: u8) -> u64 {
        self.asked += 1;
        self.table.piece(index, form)
    }
    fn group_line(&mut self, index: usize) -> u64 {
        self.asked += 1;
        self.table.group_line(index)
    }
    fn group_header(&mut self, heading: Heading) -> u64 {
        self.table.group_header(heading)
    }
}

/// Stopping each sum once it is over the budget chooses exactly what adding
/// up every piece chooses, including where an old summary's cost decides:
/// the floor's titles, the step down from the oldest end, and showing
/// everything in full when all of it fits. Budgets run from one token to
/// more than everything costs; sessions with and without summaries the
/// floor can bring back, with and without the reference scale and day
/// headings.
#[test]
fn stopping_the_sums_early_changes_no_choice() {
    let mut random = Random::new(4_000);
    let (mut fewer, mut early_total, mut all_total) = (0, 0, 0);
    for &count in &[1, 2, 7, 49, 50, 51, 300, 1_200, 4_000] {
        for round in 0..2 {
            let (mut session, mut table) = Generated::new(&mut random, count);
            if round == 1 {
                // No stored score the floor could bring back.
                session
                    .scores
                    .iter_mut()
                    .for_each(|score| *score = score.min(85.0));
            }
            let summaries = session.summaries();
            let full: u64 = table.forms.iter().map(|forms| forms[0]).sum();
            let budgets = [
                1,
                10,
                100,
                1_000,
                5_000,
                30_000,
                98_000,
                full - 1,
                full,
                full * 10,
            ];
            for budget in budgets.map(|budget| budget as f64) {
                for reference_scale in [true, false] {
                    for day_headers in [true, false] {
                        let early = Options {
                            reference_scale,
                            day_headers,
                            stop_early: true,
                            fill: true,
                        };
                        let all = Options {
                            stop_early: false,
                            ..early
                        };
                        let mut asked = Asked {
                            table: &mut table,
                            asked: 0,
                        };
                        let with = plan(&summaries, budget, &mut asked, early);
                        let early_asked = asked.asked;
                        asked.asked = 0;
                        let without = plan(&summaries, budget, &mut asked, all);
                        assert_eq!(
                            with, without,
                            "{count} (round {round}) at {budget}, {early:?}"
                        );
                        assert!(early_asked <= asked.asked);
                        fewer += usize::from(early_asked < asked.asked);
                        early_total += early_asked;
                        all_total += asked.asked;
                    }
                }
            }
        }
    }
    assert!(
        fewer > 0 && early_total < all_total,
        "{early_total} against {all_total}"
    );
}

#[test]
fn stopping_the_sums_early_changes_nothing_on_the_lab_session() {
    #[derive(serde::Deserialize)]
    struct Row {
        score: f64,
        date: String,
        costs: [u64; 5],
    }
    #[derive(serde::Deserialize)]
    struct Fixture {
        rows: Vec<Row>,
    }
    let fixture: Fixture =
        serde_json::from_str(include_str!("../../testdata/history-line-shape.json")).unwrap();
    let summaries: Vec<Summary> = fixture
        .rows
        .iter()
        .map(|row| Summary {
            score: row.score,
            scored: true,
            day: Some(&row.date),
        })
        .collect();
    let mut table = Table {
        forms: fixture.rows.iter().map(|row| row.costs).collect(),
        lines: fixture
            .rows
            .iter()
            .map(|row| row.costs[4].saturating_sub(4))
            .collect(),
        header: 12,
    };
    let full: u64 = table.forms.iter().map(|forms| forms[0]).sum();
    for budget in [
        1,
        500,
        5_000,
        15_000,
        30_000,
        60_000,
        98_000,
        150_000,
        full,
        full + 1,
    ] {
        for options in [
            Options::default(),
            Options {
                reference_scale: false,
                day_headers: false,
                ..Options::default()
            },
        ] {
            let with = plan(&summaries, budget as f64, &mut table, options);
            let without = plan(
                &summaries,
                budget as f64,
                &mut table,
                Options {
                    stop_early: false,
                    ..options
                },
            );
            assert_eq!(with, without, "at {budget}, {options:?}");
        }
    }
}

/// The floor in a session whose top scores are tied: the tie group counts at
/// its highest rank for the floor, so it still has candidates, taken newest
/// first within the floor's share of the budget, while the forms keep the
/// middle of the group.
#[test]
fn a_tied_top_group_still_has_floor_titles() {
    // (summaries, share tied at the top, the top score); the tied summaries
    // are the oldest, so the line hides them.
    let cases = [
        (1_000usize, 0.03, 100.0),
        (3_800, 0.015, 95.0),
        (200, 1.0, 60.0),
    ];
    for (count, share, top) in cases {
        let tied = (count as f64 * share) as usize;
        let summaries: Vec<Summary> = (0..count)
            .map(|index| Summary {
                score: if index < tied {
                    top
                } else {
                    15.0 + (index % 75) as f64
                },
                scored: true,
                day: None,
            })
            .collect();
        let mut table = Table {
            forms: vec![[400, 150, 60, 40, 20]; count],
            lines: vec![16; count],
            header: 12,
        };
        let budget = 6_000.0;
        let at = format!("{tied} of {count} tied at {top}");
        let plan = plan(&summaries, budget, &mut table, no_fill());
        let stretch = plan.stretch.unwrap();
        // The forms still read the middle of the group: below the floor.
        assert!(plan.scores[0] < 90.0, "{at}: {}", plan.scores[0]);
        let by_line = line_forms(&plan.scores, stretch);
        let floored: Vec<usize> = (0..count)
            .filter(|&i| by_line[i] == NOT_SHOWN && plan.forms[i] == TITLE)
            .collect();
        assert!(!floored.is_empty(), "{at}: no floor titles");
        assert!(floored.iter().all(|&i| i < tied), "{at}");
        // Within the floor's share, and the newest of the group first: the
        // next newer hidden one did not fit.
        let spent = floored.len() as f64 * 20.0;
        assert!(spent <= 0.05 * budget, "{at}: spent {spent}");
        let hidden_tied: Vec<usize> = (0..tied).filter(|&i| plan.forms[i] == NOT_SHOWN).collect();
        assert!(!hidden_tied.is_empty(), "{at}: the cap did not cut");
        assert!(
            hidden_tied.iter().max() < floored.iter().min(),
            "{at}: an older one was taken before a newer one"
        );
        assert!(spent + 20.0 > 0.05 * budget, "{at}: room left for the next");
    }
}

/// The floor and forms on the real session's shape in
/// `testdata/history-line-shape.json`, with the reference scale: 34 summaries
/// qualify, and the forms at the six budgets are pinned (day headings off).
#[test]
fn the_lab_sessions_floor_on_the_reference_scale_is_pinned() {
    #[derive(serde::Deserialize)]
    struct Row {
        score: f64,
        date: String,
        costs: [u64; 5],
    }
    #[derive(serde::Deserialize)]
    struct Fixture {
        rows: Vec<Row>,
    }
    let fixture: Fixture =
        serde_json::from_str(include_str!("../../testdata/history-line-shape.json")).unwrap();
    let summaries: Vec<Summary> = fixture
        .rows
        .iter()
        .map(|row| Summary {
            score: row.score,
            scored: true,
            day: Some(&row.date),
        })
        .collect();
    let mut table = Table {
        forms: fixture.rows.iter().map(|row| row.costs).collect(),
        lines: vec![0; fixture.rows.len()],
        header: 0,
    };
    let options = Options {
        day_headers: false,
        ..no_fill()
    };
    let candidates = floor_scores(&summaries, true)
        .iter()
        .filter(|&&score| score >= 90.0)
        .count();
    assert_eq!(candidates, 34);
    let pinned: [(f64, u32); 6] = [
        (5_000.0, 1_052_589_277),
        (15_000.0, 1_108_801_024),
        (30_000.0, 2_191_712_027),
        (60_000.0, 208_577_252),
        (98_000.0, 570_235_141),
        (150_000.0, 1_748_734_472),
    ];
    let found: Vec<(f64, u32)> = pinned
        .iter()
        .map(|&(budget, _)| {
            let plan = plan(&summaries, budget, &mut table, options);
            (budget, fnv1a32(&plan.forms))
        })
        .collect();
    assert_eq!(found, pinned);
}

/// A score exactly at the line is not shown; just above it is a title.
#[test]
fn a_score_exactly_at_the_line_is_not_shown() {
    for height in [6.0, 32.0, 70.0, 96.0] {
        assert_eq!(form_under_line(height, height), NOT_SHOWN, "at {height}");
        assert_eq!(
            form_under_line(height + 0.01, height),
            TITLE,
            "above {height}"
        );
    }
    // In a plan: the newest summary, scored 6 where the line starts at 6.
    let summaries = [Summary {
        score: 6.0,
        scored: false,
        day: None,
    }; 2];
    let mut table = Table {
        forms: vec![[500, 200, 80, 40, 20]; 2],
        lines: vec![10; 2],
        header: 10,
    };
    let plan = plan(&summaries, 600.0, &mut table, no_fill());
    assert_eq!(plan.forms[1], NOT_SHOWN);
}

/// With the window unknown, a fold works with 25,000 tokens.
#[test]
fn an_unknown_window_gives_twenty_five_thousand_tokens() {
    assert_eq!(HISTORY_BUDGET_WHEN_WINDOW_UNKNOWN, 25_000.0);
    assert_eq!(effective_budget(0.0), 25_000.0);
    assert_eq!(effective_budget(-3.0), 25_000.0);
    assert_eq!(effective_budget(1.0), 1.0);
    let mut random = Random::new(25);
    let (session, mut table) = Generated::new(&mut random, 600);
    let plan = plan(&session.summaries(), 0.0, &mut table, Options::default());
    assert_eq!(plan.budget, 25_000.0);
    assert!(
        plan.total <= 25_000 && plan.total > 23_000,
        "{}",
        plan.total
    );
}

/// The widest stretch is 12: a session just past fitting in full takes it,
/// and at 12 the line still hides what it hides there.
#[test]
fn the_widest_stretch_is_twelve() {
    let mut random = Random::new(7);
    let (session, mut table) = Generated::new(&mut random, 400);
    let summaries = session.summaries();
    let full: u64 = table.forms.iter().map(|forms| forms[0]).sum();
    let plan = plan(&summaries, full as f64 - 1.0, &mut table, no_fill());
    assert_eq!(plan.stretch, Some(12.0));
    assert_eq!(plan.forms, line_forms_with_floor(&plan, 12.0, &mut table));
    // The line's far end at 12: flat at 96 from age 1718.3 × 12.
    assert_eq!(line_height(1_718.3 * 12.0, 12.0), 96.0);
    assert!(line_height(1_718.3 * 12.0 - 1.0, 12.0) < 96.0);
}

/// The forms the line and the floor give at `stretch`, for `plan`'s scores.
fn line_forms_with_floor(plan: &Plan, stretch: f64, table: &mut Table) -> Vec<u8> {
    let scores = Scores {
        line: &plan.scores,
        floor: &plan.floor_scores,
    };
    forms_on_line(scores, stretch, plan.budget, table)
}

/// What filling with titles adds on the real session's shape in
/// `testdata/history-line-shape.json`, at the six budgets, with stored and
/// with reference scores (day headings off, as in the pins above): the same
/// stretch, the same form for every summary the plan showed, and titles for
/// the newest summaries it hid, as many as fit. Pinned: the number added,
/// the total and the forms' checksum.
#[test]
fn filling_on_the_lab_session_adds_only_the_newest_hidden_titles() {
    #[derive(serde::Deserialize)]
    struct Row {
        score: f64,
        date: String,
        costs: [u64; 5],
    }
    #[derive(serde::Deserialize)]
    struct Fixture {
        rows: Vec<Row>,
    }
    let fixture: Fixture =
        serde_json::from_str(include_str!("../../testdata/history-line-shape.json")).unwrap();
    let summaries: Vec<Summary> = fixture
        .rows
        .iter()
        .map(|row| Summary {
            score: row.score,
            scored: true,
            day: Some(&row.date),
        })
        .collect();
    let mut table = Table {
        forms: fixture.rows.iter().map(|row| row.costs).collect(),
        lines: vec![0; fixture.rows.len()],
        header: 0,
    };
    let mut found = Vec::new();
    for reference_scale in [false, true] {
        for budget in [5_000.0, 15_000.0, 30_000.0, 60_000.0, 98_000.0, 150_000.0] {
            let options = Options {
                reference_scale,
                day_headers: false,
                ..Options::default()
            };
            let without = plan(
                &summaries,
                budget,
                &mut table,
                Options {
                    fill: false,
                    ..options
                },
            );
            let with = plan(&summaries, budget, &mut table, options);
            let at = format!("reference {reference_scale} at {budget}");
            assert_eq!(with.stretch, without.stretch, "{at}");
            let added: Vec<usize> = (0..summaries.len())
                .filter(|&i| with.forms[i] != without.forms[i])
                .collect();
            for &i in &added {
                assert_eq!(
                    (without.forms[i], with.forms[i]),
                    (NOT_SHOWN, TITLE),
                    "{at}"
                );
            }
            // The newest hidden summaries, with none skipped between them.
            let hidden_newest_first: Vec<usize> = (0..summaries.len())
                .rev()
                .filter(|&i| without.forms[i] == NOT_SHOWN)
                .take(added.len())
                .collect();
            assert_eq!(
                added.iter().rev().copied().collect::<Vec<_>>(),
                hidden_newest_first,
                "{at}"
            );
            assert!(with.total as f64 <= budget);
            found.push((
                reference_scale,
                budget,
                added.len(),
                with.total,
                fnv1a32(&with.forms),
            ));
        }
    }
    // (reference scale, budget, titles added, total, forms' checksum).
    let pinned: Vec<(bool, f64, usize, u64, u32)> = vec![
        (false, 5_000.0, 0, 4_991, 1_052_589_277),
        (false, 15_000.0, 1, 14_986, 1_473_885_001),
        (false, 30_000.0, 2, 29_965, 975_964_847),
        (false, 60_000.0, 0, 59_989, 1_477_899_541),
        (false, 98_000.0, 10, 97_992, 2_617_244_088),
        (false, 150_000.0, 1, 149_979, 27_596_514),
        (true, 5_000.0, 0, 4_991, 1_052_589_277),
        (true, 15_000.0, 0, 14_976, 1_108_801_024),
        (true, 30_000.0, 1, 29_985, 2_648_418_696),
        (true, 60_000.0, 0, 59_993, 208_577_252),
        (true, 98_000.0, 12, 97_970, 351_146_901),
        (true, 150_000.0, 1, 149_988, 2_952_854_611),
    ];
    assert_eq!(found, pinned);
}

/// On generated sessions, filling adds titles only for hidden summaries,
/// the newest first with none skipped, keeps every other form, stays within
/// the budget, and stops only where the next title does not fit.
#[test]
fn filling_spends_what_is_left_on_the_newest_hidden_titles() {
    let mut random = Random::new(2_611);
    let mut filled = 0;
    for &count in &[1, 2, 7, 50, 300, 1_200] {
        let (session, mut table) = Generated::new(&mut random, count);
        let summaries = session.summaries();
        for budget in [1.0, 25.0, 200.0, 2_000.0, 15_000.0, 60_000.0] {
            let at = format!("{count} at {budget}");
            let without = plan(&summaries, budget, &mut table, no_fill());
            let with = plan(&summaries, budget, &mut table, Options::default());
            assert!(with.total as f64 <= budget, "{at}");
            let hidden: Vec<usize> = (0..count)
                .rev()
                .filter(|&i| without.forms[i] == NOT_SHOWN)
                .collect();
            let added = hidden
                .iter()
                .take_while(|&&i| with.forms[i] == TITLE)
                .count();
            filled += added;
            for i in 0..count {
                if !hidden[..added].contains(&i) {
                    assert_eq!(with.forms[i], without.forms[i], "{at}: summary {i}");
                }
            }
            if let Some(&next) = hidden.get(added) {
                let mut more = with.forms.clone();
                more[next] = TITLE;
                let (_, total) = cost_of(&summaries, &more, &mut table, Options::default());
                assert!(total as f64 > budget, "{at}: summary {next} would fit");
            }
        }
    }
    assert!(filled > 0);
}

/// Costs that count every lookup.
struct Looked<'t> {
    forms: &'t dyn Fn(usize, u8) -> u64,
    lookups: usize,
}

impl Costs for Looked<'_> {
    fn piece(&mut self, index: usize, form: u8) -> u64 {
        self.lookups += 1;
        (self.forms)(index, form)
    }
    fn group_line(&mut self, _: usize) -> u64 {
        self.lookups += 1;
        10
    }
    fn group_header(&mut self, _: Heading) -> u64 {
        self.lookups += 1;
        1
    }
}

/// Stepping down looks each cost up a number of times linear in the
/// summaries, not once per summary per step: every summary tied at a high
/// score on one day, so the floor brings all the old ones back as titles
/// (5% of a budget of 200 a summary), with the newest summary too large for
/// what is left. Two newest sizes: one far over the budget (stepped down
/// itself after every title is gone) and one just under it (part of the
/// titles go).
#[test]
fn stepping_down_looks_costs_up_a_linear_number_of_times() {
    for newest_share in [None, Some(0.97)] {
        for n in [1_000usize, 4_000] {
            let budget = (n * 200) as f64;
            let newest = newest_share.map_or(10_000_000, |share| (share * budget) as u64);
            let forms = move |index: usize, form: u8| match form {
                TITLE => 10,
                _ if index == n - 1 => newest,
                _ => 10_000_000,
            };
            let summaries: Vec<Summary> = (0..n)
                .map(|_| Summary {
                    score: 95.0,
                    scored: true,
                    day: Some("2026-03-01"),
                })
                .collect();
            let mut costs = Looked {
                forms: &forms,
                lookups: 0,
            };
            let plan = plan(&summaries, budget, &mut costs, no_fill());
            let at = format!("{n} summaries, newest {newest}");
            assert!(plan.total as f64 <= budget, "{at}");
            assert!(
                plan.forms[..n / 3].iter().all(|&form| form == NOT_SHOWN),
                "{at}"
            );
            assert!(
                costs.lookups <= 60 * n,
                "{at}: {} lookups, {} a summary",
                costs.lookups,
                costs.lookups / n
            );
        }
    }
}

/// The title fill looks each cost up a number of times linear in the
/// summaries, however many titles it adds: the newest summary is larger
/// than the budget in every form but its title, so the plan steps it down
/// to its title, and the budget then has room for every older summary's
/// title, which the fill adds one by one. All on one day (one long day
/// heading) and in pairs of two days (a new day heading every two titles).
#[test]
fn the_title_fill_looks_costs_up_a_linear_number_of_times() {
    for paired in [false, true] {
        for n in [4_000usize, 8_000] {
            let budget = (n * 19) as f64;
            let forms = move |index: usize, form: u8| match form {
                TITLE => 4,
                _ if index == n - 1 => (n * 25) as u64,
                _ => 200,
            };
            let days: Vec<&str> = (0..n)
                .map(|index| match (paired, index / 2 % 2) {
                    (true, 1) => "2026-11-02",
                    _ => "2026-11-01",
                })
                .collect();
            let summaries: Vec<Summary> = (0..n)
                .map(|index| Summary {
                    score: if index == n - 1 {
                        100.0
                    } else {
                        (index % 100 + 1) as f64
                    },
                    scored: true,
                    day: Some(days[index]),
                })
                .collect();
            let mut costs = Looked {
                forms: &forms,
                lookups: 0,
            };
            let plan = plan(&summaries, budget, &mut costs, Options::default());
            let at = format!("{n} summaries, paired days {paired}");
            let titles = plan.forms.iter().filter(|&&form| form == TITLE).count();
            assert!(titles > n / 2, "{at}: {titles} titles");
            assert!(plan.total as f64 <= budget, "{at}");
            assert!(
                costs.lookups <= 60 * n,
                "{at}: {} lookups, {} a summary",
                costs.lookups,
                costs.lookups / n
            );
        }
    }
}

/// Costs given per summary, with a day heading whose cost depends on what it
/// shows (its first and last title and how many) and a joint that can be a
/// fraction, so that a wrong heading or piece count shows in the total.
struct Varied {
    forms: Vec<[u64; 5]>,
    lines: Vec<u64>,
    joint: f64,
}

impl Costs for Varied {
    fn piece(&mut self, index: usize, form: u8) -> u64 {
        self.forms[index][usize::from(form - 1)]
    }
    fn group_line(&mut self, index: usize) -> u64 {
        self.lines[index]
    }
    fn group_header(&mut self, heading: Heading) -> u64 {
        ((heading.first * 7 + heading.last * 3 + heading.count * 5) % 13 + 1) as u64
    }
    fn joint(&mut self) -> f64 {
        self.joint
    }
}

/// The title fill chooses exactly what counting the whole plan again for
/// every title chose: the same forms, day groups and total. Over generated
/// plans with titles, other forms and hidden summaries in any order, days
/// that repeat in runs or are missing, titles that cost more or less than
/// their line, day headings on and off, fractional joints, sums stopped
/// early or not, and budgets from what the plan costs to far more.
#[test]
fn the_title_fill_chooses_what_counting_every_plan_again_chooses() {
    let mut random = Random::new(4_242);
    let mut compared = 0;
    let mut filled = 0;
    for round in 0..400 {
        let count = random.between(1, 160) as usize;
        let days_seen = ["2026-11-01", "2026-11-02", "2026-11-03"];
        let mut day = Some(days_seen[0]);
        let days: Vec<Option<&str>> = (0..count)
            .map(|_| {
                match random.between(1, 10) {
                    1 => day = None,
                    2 | 3 => day = Some(days_seen[random.between(0, 2) as usize]),
                    _ => {}
                }
                day
            })
            .collect();
        let summaries: Vec<Summary> = days
            .iter()
            .map(|&day| Summary {
                score: 50.0,
                scored: true,
                day,
            })
            .collect();
        let forms: Vec<u8> = (0..count)
            .map(|_| match random.between(1, 10) {
                1..=5 => NOT_SHOWN,
                6..=8 => TITLE,
                _ => random.between(1, 4) as u8,
            })
            .collect();
        let mut costs = Varied {
            forms: (0..count)
                .map(|_| {
                    let title = random.between(2, 30);
                    [
                        random.between(100, 600),
                        random.between(50, 200),
                        random.between(20, 90),
                        random.between(10, 50),
                        title,
                    ]
                })
                .collect(),
            lines: (0..count).map(|_| random.between(1, 30)).collect(),
            joint: [0.0, 0.3, 1.0, 1.7][round % 4],
        };
        for day_headers in [true, false] {
            for stop_early in [true, false] {
                let options = Options {
                    day_headers,
                    stop_early,
                    ..Options::default()
                };
                let (_, cost) = cost_of(&summaries, &forms, &mut costs, options);
                for extra in [0, 1, 6, 40, 250, 2_000, 1_000_000] {
                    let budget = (cost + extra) as f64;
                    let at = format!(
                        "round {round}, {count} summaries, headings {day_headers}, early {stop_early}, budget {budget}"
                    );
                    let linear =
                        fill_titles(&summaries, forms.clone(), budget, &mut costs, options);
                    let reference = fill_titles_reference(
                        &summaries,
                        forms.clone(),
                        budget,
                        &mut costs,
                        options,
                    );
                    assert_eq!(linear, reference, "{at}");
                    filled += usize::from(linear.0 != forms);
                    compared += 1;
                }
            }
        }
    }
    // An empty plan at the smallest budgets.
    let summaries = vec![
        Summary {
            score: 50.0,
            scored: true,
            day: Some("2026-11-01"),
        };
        3
    ];
    let mut costs = Varied {
        forms: vec![[50, 40, 30, 20, 5]; 3],
        lines: vec![4; 3],
        joint: 0.5,
    };
    for budget in [0.0, 1.0, 4.0, 5.0, 9.0, 10.0, 20.0] {
        let hidden = vec![NOT_SHOWN; 3];
        assert_eq!(
            fill_titles(
                &summaries,
                hidden.clone(),
                budget,
                &mut costs,
                Options::default()
            ),
            fill_titles_reference(&summaries, hidden, budget, &mut costs, Options::default()),
            "at {budget}"
        );
    }
    assert!(
        compared > 5_000 && filled > compared / 4,
        "{compared} compared, {filled} filled"
    );
}

/// Through the whole plan: the title fill after the line, the floor (whose
/// titles can sit inside a run of one day) and any step down gives what
/// the first fill gave, on generated sessions with both score scales and
/// on the two shapes that made the first fill slowest (a newest summary
/// larger than the budget, then room for every older title, on one day or
/// in pairs of days).
#[test]
fn the_title_fill_in_a_plan_chooses_what_the_first_fill_chose() {
    let compare = |summaries: &[Summary],
                   budget: f64,
                   costs: &mut dyn FnMut() -> Table,
                   options: Options,
                   at: &str| {
        let with = plan(summaries, budget, &mut costs(), options);
        let mut table = costs();
        let without = plan(
            summaries,
            budget,
            &mut table,
            Options {
                fill: false,
                ..options
            },
        );
        let reference = fill_titles_reference(
            summaries,
            without.forms,
            without.budget,
            &mut table,
            options,
        );
        assert_eq!((with.forms, with.groups, with.total), reference, "{at}");
    };
    let mut random = Random::new(77);
    for &count in &[1, 2, 7, 49, 50, 51, 300, 1_200] {
        let (session, table) = Generated::new(&mut random, count);
        let summaries = session.summaries();
        for reference_scale in [true, false] {
            for budget in [1.0, 40.0, 300.0, 2_000.0, 15_000.0, 60_000.0] {
                let options = Options {
                    reference_scale,
                    ..Options::default()
                };
                let at = format!("{count} summaries, reference {reference_scale}, budget {budget}");
                compare(
                    &summaries,
                    budget,
                    &mut || Table {
                        forms: table.forms.clone(),
                        lines: table.lines.clone(),
                        header: table.header,
                    },
                    options,
                    &at,
                );
            }
        }
    }
    for paired in [false, true] {
        let n = 600;
        let days: Vec<&str> = (0..n)
            .map(|index| match (paired, index / 2 % 2) {
                (true, 1) => "2026-11-02",
                _ => "2026-11-01",
            })
            .collect();
        let summaries: Vec<Summary> = (0..n)
            .map(|index| Summary {
                score: if index == n - 1 {
                    100.0
                } else {
                    (index % 100 + 1) as f64
                },
                scored: true,
                day: Some(days[index]),
            })
            .collect();
        for budget in [(n * 19) as f64, (n * 7) as f64, (n * 3) as f64] {
            compare(
                &summaries,
                budget,
                &mut || Table {
                    forms: (0..n)
                        .map(|index| {
                            if index == n - 1 {
                                let big = (n * 25) as u64;
                                [big, big, big, big, 4]
                            } else {
                                [200, 150, 100, 60, 4 + index as u64 % 3]
                            }
                        })
                        .collect(),
                    lines: (0..n).map(|index| 3 + index as u64 % 2).collect(),
                    header: 6,
                },
                Options::default(),
                &format!("{n} summaries, paired {paired}, budget {budget}"),
            );
        }
    }
}
