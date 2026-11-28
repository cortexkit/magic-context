//! The plan as first written, before its step down and title fill kept
//! running sums: each counts the whole plan again for every form it tries.
//! Slow, but plainly right, so the tests compare the running sums with it:
//! every step down and every whole plan must choose exactly what these
//! choose.

use super::*;

/// The reference title fill: the whole plan counted again for every title
/// tried. [`fill_titles`] must choose exactly what this chooses.
pub(crate) fn fill_titles_reference(
    summaries: &[Summary],
    mut forms: Vec<u8>,
    budget: f64,
    costs: &mut impl Costs,
    options: Options,
) -> (Vec<u8>, Vec<Vec<usize>>, u64) {
    let limit = options.limit(budget);
    let (mut groups, mut total) = cost_within(summaries, &forms, costs, options, limit);
    for index in (0..forms.len()).rev() {
        if forms[index] != NOT_SHOWN {
            continue;
        }
        forms[index] = TITLE;
        let (with_title, with_total) = cost_within(summaries, &forms, costs, options, limit);
        if with_total as f64 > budget {
            forms[index] = NOT_SHOWN;
            break;
        }
        (groups, total) = (with_title, with_total);
    }
    (forms, groups, total)
}

/// The reference step down: the oldest shown summary gives up one form at
/// a time, and the whole plan is counted again after each.
fn step_down_reference(
    summaries: &[Summary],
    mut forms: Vec<u8>,
    budget: f64,
    costs: &mut impl Costs,
    options: Options,
) -> (Vec<u8>, Vec<Vec<usize>>, u64) {
    let limit = options.limit(budget);
    for index in 0..forms.len() {
        while forms[index] < NOT_SHOWN {
            forms[index] += 1;
            let (groups, total) = cost_within(summaries, &forms, costs, options, limit);
            if total as f64 <= budget {
                return (forms, groups, total);
            }
        }
    }
    let (groups, total) = cost_of(summaries, &forms, costs, options);
    (forms, groups, total)
}

/// [`plan`] with the reference step down and title fill.
fn plan_reference(
    summaries: &[Summary],
    budget: f64,
    costs: &mut impl Costs,
    options: Options,
) -> Plan {
    let budget = effective_budget(budget);
    let scores = line_scores(summaries, options.reference_scale);
    let floor_scores = floor_scores(summaries, options.reference_scale);
    let ranked = Scores {
        line: &scores,
        floor: &floor_scores,
    };
    let mut chosen = search(summaries, ranked, budget, costs, options);
    if chosen.2 as f64 > budget {
        let (forms, groups, total) =
            step_down_reference(summaries, chosen.1, budget, costs, options);
        chosen = (chosen.0, forms, total, groups);
    }
    if options.fill {
        let (forms, groups, total) =
            fill_titles_reference(summaries, chosen.1, budget, costs, options);
        chosen = (chosen.0, forms, total, groups);
    }
    let (stretch, forms, total, groups) = chosen;
    let joints = joints_cost(&forms, &groups, costs);
    Plan {
        stretch,
        forms,
        groups,
        total,
        joints,
        budget,
        scores,
        floor_scores,
    }
}

/// Costs that differ per summary, form, line and heading, with a joint that
/// can be a fraction. In `cheap` costs, a title costs 10 and any other form
/// 1,000. Summary 3,000, when there is one, is far larger than any budget in
/// every form but its title.
struct Trial {
    salt: u64,
    joint: f64,
    cheap: bool,
}

impl Costs for Trial {
    fn piece(&mut self, index: usize, form: u8) -> u64 {
        if self.cheap {
            return if form == TITLE { 10 } else { 1_000 };
        }
        if index == 3_000 && form < TITLE {
            return 1_000_000;
        }
        1 + mix(self.salt + index as u64 * 19 + u64::from(form) * 7) % 200
    }
    fn group_line(&mut self, index: usize) -> u64 {
        1 + mix(self.salt + index as u64) % 19
    }
    fn group_header(&mut self, heading: Heading) -> u64 {
        let shown = heading.first + heading.last * 19;
        1 + mix(self.salt + shown as u64) % 53
    }
    fn joint(&mut self) -> f64 {
        self.joint
    }
}

/// A mixing function (splitmix64's), for costs and scores that look random
/// but are the same in every run.
fn mix(mut x: u64) -> u64 {
    x ^= x >> 30;
    x = x.wrapping_mul(0xbf58_476d_1ce4_e5b9);
    x ^= x >> 27;
    x = x.wrapping_mul(0x94d0_49bb_1331_11eb);
    x ^ (x >> 31)
}

/// `count` summaries: runs of two days with a run without a day between,
/// every seventh and the newest scored 100, and every ninth unscored.
fn entries(count: usize, seed: u64) -> Vec<Summary<'static>> {
    (0..count)
        .map(|index| {
            let day = match (index / (1 + seed as usize % 19)) % 6 {
                0 | 1 | 5 => Some("2026-11-01"),
                2 => None,
                _ => Some("2026-11-02"),
            };
            let score = if index % 7 == 3 || index + 1 == count {
                100.0
            } else {
                (mix(seed + index as u64) % 100 + 1) as f64
            };
            Summary {
                score,
                day,
                scored: index % 9 != 0,
            }
        })
        .collect()
}

/// The step down's and the title fill's running sums choose exactly what
/// counting every plan again chooses: for every step down, from plans of
/// titles and other forms with the newest in full, at budgets from zero to
/// one token short of the plan; for whole plans at budgets from zero to
/// past everything; with day headings on and off, both score scales,
/// fractional joints, and a run of titles of one day with a floor title
/// inside it.
#[test]
fn every_step_down_and_plan_chooses_what_the_reference_chooses() {
    let (mut steps, mut plans, mut floor_runs) = (0, 0, 0);
    for (count, seeds) in [
        (1, 16),
        (2, 16),
        (7, 32),
        (19, 40),
        (49, 32),
        (50, 32),
        (251, 10),
        (1_000, 4),
        (3_001, 2),
    ] {
        for seed in 1..=seeds {
            let rows = entries(count, seed);
            for day_headers in [true, false] {
                let mut costs = Trial {
                    salt: seed,
                    joint: [0.0, 0.25, 1.0, 1.742][seed as usize % 4],
                    cheap: false,
                };
                let options = Options {
                    day_headers,
                    reference_scale: seed % 2 == 1,
                    // The reference fill counts the plan again per title.
                    fill: count < 1_000,
                    ..Options::default()
                };
                let mut forms: Vec<u8> = (0..count)
                    .map(|index| {
                        if (index + seed as usize) % 7 < 4 {
                            TITLE
                        } else {
                            (mix(index as u64 + seed) % 6 + 1) as u8
                        }
                    })
                    .collect();
                forms[count - 1] = FULL;
                let base = cost_of(&rows, &forms, &mut costs, options).1 as f64;
                for budget in [
                    0.0,
                    1.0,
                    5.0,
                    61.0,
                    101.0,
                    base / 10.0,
                    base / 2.0,
                    base - 1.0,
                ] {
                    if budget >= base {
                        continue;
                    }
                    let at = format!(
                        "{count} rows, seed {seed}, headings {day_headers}, budget {budget}"
                    );
                    let got = step_down(&rows, forms.clone(), budget, &mut costs, options);
                    let reference =
                        step_down_reference(&rows, forms.clone(), budget, &mut costs, options);
                    assert_eq!(got, reference, "{at}");
                    assert!(got.2 as f64 <= budget, "{at}");
                    steps += 1;
                }
                for budget in [0.0, 1.0, 39.0, 500.0, 1_000.0, 3_000.0, 120_000.0] {
                    let at = format!(
                        "{count} rows, seed {seed}, headings {day_headers}, budget {budget}"
                    );
                    let got = plan(&rows, budget, &mut costs, options);
                    let reference = plan_reference(&rows, budget, &mut costs, options);
                    assert_eq!(
                        (got.stretch, &got.forms, &got.groups, got.total),
                        (
                            reference.stretch,
                            &reference.forms,
                            &reference.groups,
                            reference.total
                        ),
                        "{at}"
                    );
                    assert!(got.total as f64 <= effective_budget(budget), "{at}");
                    plans += 1;
                }
                if count >= 251 && day_headers {
                    // Every summary of one day, scored 95 to 100: at the
                    // smallest stretch the floor brings old ones back as
                    // titles between titles the line shows, so a run of one
                    // day holds a floor title inside it.
                    let rows: Vec<Summary> = (0..count)
                        .map(|index| Summary {
                            score: if index + 1 == count {
                                100.0
                            } else if index % 7 == 3 {
                                95.0
                            } else {
                                97.0
                            },
                            scored: true,
                            day: Some("2026-11-01"),
                        })
                        .collect();
                    let scores = line_scores(&rows, false);
                    let floors = floor_scores(&rows, false);
                    let mut cheap = Trial {
                        salt: seed,
                        joint: 1.25,
                        cheap: true,
                    };
                    let options = Options {
                        day_headers,
                        reference_scale: false,
                        fill: false,
                        ..options
                    };
                    let budget = 510.0;
                    let ranked = Scores {
                        line: &scores,
                        floor: &floors,
                    };
                    let initial = forms_on_line(ranked, STRETCH_MIN, budget, &mut cheap);
                    let no_floor = vec![0.0; count];
                    let before_floor = forms_on_line(
                        Scores {
                            floor: &no_floor,
                            ..ranked
                        },
                        STRETCH_MIN,
                        budget,
                        &mut cheap,
                    );
                    let groups = day_groups(&rows, &initial);
                    assert!(groups.iter().any(|group| group.len() >= 3
                        && group[1..group.len() - 1]
                            .iter()
                            .any(|&index| before_floor[index] == NOT_SHOWN)));
                    assert_eq!(
                        step_down(&rows, initial.clone(), budget, &mut cheap, options),
                        step_down_reference(&rows, initial, budget, &mut cheap, options)
                    );
                    floor_runs += 1;
                }
            }
        }
    }
    assert!(steps > 2_000 && plans > 2_000 && floor_runs > 0);
}
