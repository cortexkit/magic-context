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
    fn group_header(&mut self, _members: &[usize]) -> u64 {
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
                let plan = plan(&summaries, budget, &mut table, Options::default());
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
                    let floor = line == NOT_SHOWN && form == TITLE && plan.scores[index] >= 90.0;
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
    let plan = plan(&summaries, 2_000.0, &mut table, Options::default());
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

/// Costs whose estimates are off from the real ones by up to `noise` (a
/// share), differently for every piece.
struct Noisy {
    table: Table,
    noise: f64,
    /// Every estimate is also multiplied by this.
    scale: f64,
    estimating: bool,
}

impl Noisy {
    fn off(&self, real: u64, index: usize, form: u8) -> u64 {
        if !self.estimating {
            return real;
        }
        let mut random = Random::new(index as u64 * 8 + u64::from(form));
        let wobble = random.between(0, 2_000) as f64 / 1_000.0 - 1.0;
        (real as f64 * (1.0 + self.noise * wobble) * self.scale).round() as u64
    }
}

impl Costs for Noisy {
    fn piece(&mut self, index: usize, form: u8) -> u64 {
        let real = self.table.piece(index, form);
        self.off(real, index, form)
    }
    fn group_line(&mut self, index: usize) -> u64 {
        let real = self.table.group_line(index);
        self.off(real, index, 7)
    }
    fn group_header(&mut self, members: &[usize]) -> u64 {
        self.table.group_header(members)
    }
    fn estimating(&mut self, on: bool) -> bool {
        self.estimating = on;
        true
    }
}

#[test]
fn estimates_close_to_the_real_counts_choose_what_real_counts_choose() {
    let mut random = Random::new(5);
    for count in [300, 3_800] {
        let (session, table) = Generated::new(&mut random, count);
        let summaries = session.summaries();
        let mut noisy = Noisy {
            table,
            noise: 0.03,
            scale: 1.0,
            estimating: false,
        };
        for budget in [5_000.0, 30_000.0, 98_000.0] {
            let estimated = plan(&summaries, budget, &mut noisy, Options::default());
            let real = plan(&summaries, budget, &mut noisy.table, Options::default());
            assert_eq!(real.estimated_pick_total, None);
            assert_eq!(estimated.estimated_pick_total, Some(real.total));
            assert_eq!(
                Plan {
                    estimated_pick_total: None,
                    ..estimated
                },
                real,
                "{count} at {budget}"
            );
        }
    }
}

#[test]
fn estimates_far_off_still_give_forms_on_the_line_within_the_budget() {
    let mut random = Random::new(6);
    let (session, table) = Generated::new(&mut random, 2_000);
    let summaries = session.summaries();
    let mut noisy = Noisy {
        table,
        noise: 0.5,
        scale: 1.0,
        estimating: false,
    };
    for budget in [5_000.0, 30_000.0, 98_000.0] {
        let plan = plan(&summaries, budget, &mut noisy, Options::default());
        assert!(plan.total as f64 <= budget);
        let by_line = line_forms(&plan.scores, plan.stretch.unwrap());
        for (index, (&form, &line)) in plan.forms.iter().zip(&by_line).enumerate() {
            let floor = line == NOT_SHOWN && form == TITLE && plan.scores[index] >= 90.0;
            assert!(
                form == line || floor,
                "summary {index} at {form}, line {line}"
            );
        }
    }
}

#[test]
fn a_pick_over_the_budget_on_estimates_is_searched_again_on_real_counts() {
    // Estimates at half the real counts make the search pick far too much;
    // the real count of the pick catches it.
    let mut random = Random::new(8);
    let (session, table) = Generated::new(&mut random, 1_500);
    let summaries = session.summaries();
    let mut noisy = Noisy {
        table,
        noise: 0.0,
        scale: 0.5,
        estimating: false,
    };
    for budget in [5_000.0, 30_000.0, 98_000.0] {
        let corrected = plan(&summaries, budget, &mut noisy, Options::default());
        assert!(
            corrected.estimated_pick_total.unwrap() as f64 > budget,
            "at {budget}"
        );
        assert!(corrected.total as f64 <= budget);
        let real = plan(&summaries, budget, &mut noisy.table, Options::default());
        assert_eq!(
            Plan {
                estimated_pick_total: None,
                ..corrected
            },
            real
        );
    }
}
