//! Which form each summary takes in the history block at a fold.
//!
//! Every summary can be shown in one of five forms: the four stored ones
//! (full, lighter, condensed, one line) and its title alone. It can also be
//! left out. One line, drawn over the summaries' ages, decides the form: a
//! summary is shown while its score stands above the line, and the further
//! above, the longer its form. The line rises with age, so newer summaries
//! keep more detail and only the higher scored older ones stay visible.
//!
//! The line has a fixed shape. To fit a budget, its ages are stretched by one
//! factor: a larger factor lowers the line everywhere, so every summary keeps
//! its form or gets a longer one, and the total usually grows with it. It
//! need not: the floor's titles for old high scores can make it fall a
//! little, and a stored form is not always longer than the next shorter one.
//! The fold halves the range of factors a fixed number of times and keeps
//! the factor it ends on that fits, which is not always the widest that
//! fits; the bound on the body is what it guarantees. It counts every piece
//! it looks at with the session's own counter. Old short forms are therefore
//! never removed to keep a newer long one, as a guard that cuts from the
//! oldest end would. Only when even the smallest factor is over the budget
//! (the newest summary alone can be larger than a small budget) do the
//! shown summaries step down from the oldest end, so the block always fits
//! or is empty. What the forms leave of the budget then goes to the titles
//! of the newest hidden summaries.
//!
//! When every summary fits in full there is nothing to trade, and every
//! summary is shown in full. Old summaries the line hides whose reference
//! score is 90 or more come back as titles, within a small share of the
//! budget. Titles of the same day share one heading.
//!
//! Everything here is arithmetic on the inputs, so on one platform the same
//! summaries, scores and budget always give the same forms and the same
//! bytes. The line's power function may round differently in the last bit on
//! another platform; that is enough, because a stored baseline is replayed
//! as it was rendered, never rendered again on another machine.

use std::collections::HashMap;

/// The stored full text.
pub(crate) const FULL: u8 = 1;
/// The heading line alone, with no body.
pub(crate) const TITLE: u8 = 5;
/// Left out of the history block.
pub(crate) const NOT_SHOWN: u8 = 6;

/// The budget a fold uses when it is given none (zero or less). That happens
/// when the model's window is unknown, so it is not "no limit": the history
/// block still has to stay a reasonable size, and the line's own shape,
/// unstretched, renders about 98,000 tokens on a session with thousands of
/// summaries. The earlier decay curve rendered about 25,000 tokens in that
/// case (measured on generated sessions of 200 to 3,800 summaries), so this
/// keeps such a session's history at the size it had.
pub(crate) const HISTORY_BUDGET_WHEN_WINDOW_UNKNOWN: f64 = 25_000.0;

/// The line's height at the newest summary.
const START_HEIGHT: f64 = 6.0;
/// The line's parts, each running from the previous point to `(age, height)`
/// with its bend. Past the last point the line stays flat. These values were
/// tuned by hand on a session of 3,800 summaries.
const PARTS: [(f64, f64, f64); 3] = [(234.2, 32.0, 2.0), (1059.6, 70.0, 0.6), (1718.3, 96.0, 2.6)];
/// The share of a summary's score above the line from which it takes each
/// of the first four forms; below the last, it is shown as its title.
const FORM_SHARES: [f64; 4] = [90.0, 80.0, 60.0, 50.0];

/// The range the stretch factor is searched in, and the number of halvings.
pub(crate) const STRETCH_MIN: f64 = 0.0005;
const STRETCH_MAX: f64 = 12.0;
const STRETCH_STEPS: usize = 40;

/// Hidden summaries scored at least this come back as titles.
const FLOOR_SCORE: f64 = 90.0;
/// The share of the budget those titles may take.
const FLOOR_SHARE: f64 = 0.05;

/// Below this many scored summaries, a session's own scores are used as they
/// are: a rank among fewer says little.
const REFERENCE_MIN_SCORED: usize = 50;
/// The score at each rank percentile 0..=100 in the session the line was
/// tuned on. Another summarizer may score on another scale (everything from
/// 80 to 99, say), which would move every summary against the line. Mapping
/// each score through its rank in its own session onto this table keeps the
/// scale the line was tuned for, while keeping the summarizer's order.
const REFERENCE_SCORES: [f64; 101] = [
    1.0, 20.0, 25.0, 30.0, 30.0, 35.0, 35.0, 40.0, 40.0, 42.0, 45.0, 45.0, 45.0, 48.0, 50.0, 50.0,
    50.0, 52.0, 52.0, 55.0, 55.0, 55.0, 55.0, 55.0, 58.0, 58.0, 60.0, 60.0, 60.0, 60.0, 60.0, 62.0,
    62.0, 62.0, 62.0, 64.0, 65.0, 65.0, 65.0, 65.0, 65.0, 66.0, 68.0, 68.0, 68.0, 68.0, 70.0, 70.0,
    70.0, 70.0, 70.0, 70.0, 72.0, 72.0, 72.0, 72.0, 72.0, 72.0, 73.0, 74.0, 74.0, 74.0, 75.0, 75.0,
    75.0, 75.0, 75.0, 75.0, 75.0, 76.0, 76.0, 76.0, 78.0, 78.0, 78.0, 78.0, 78.0, 78.0, 78.0, 79.0,
    80.0, 80.0, 80.0, 80.0, 80.0, 80.0, 82.0, 82.0, 82.0, 82.0, 82.0, 82.0, 84.0, 84.0, 85.0, 85.0,
    85.0, 86.0, 88.0, 88.0, 95.0,
];

/// One summary with content, as the line sees it. Summaries are given oldest
/// first.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Summary<'a> {
    /// The stored score, 1..=100.
    pub score: f64,
    /// Whether the summary has a stored score at all.
    pub scored: bool,
    /// The day its first message was written (`YYYY-MM-DD`), if known.
    pub day: Option<&'a str>,
}

/// What the rendered pieces of the history block cost, in the counter's
/// tokens. Indices are positions in the summaries given to [`plan`].
pub(crate) trait Costs {
    /// Summary `index` rendered on its own at `form` (1..=5).
    fn piece(&mut self, index: usize, form: u8) -> u64;
    /// Summary `index` as one line under a day heading.
    fn group_line(&mut self, index: usize) -> u64;
    /// A day heading. Its text shows only its first and last title and how
    /// many there are ([`Heading`]), so that is all its cost may depend on.
    fn group_header(&mut self, heading: Heading) -> u64;
    /// What joining two pieces into the block adds to its count, per joint.
    fn joint(&mut self) -> f64 {
        0.0
    }
}

/// What the joints between the shown pieces add: one fewer than the pieces,
/// where a day heading and each line under it are pieces of their own.
fn joints_cost(forms: &[u8], groups: &[Vec<usize>], costs: &mut impl Costs) -> u64 {
    let shown = forms.iter().filter(|&&form| form < NOT_SHOWN).count();
    let pieces = shown + groups.len();
    (costs.joint() * pieces.saturating_sub(1) as f64).ceil() as u64
}

/// Switches the tests use to compare with the reference calculation in
/// `testdata/history-line-shape.json`, and to check that stopping a sum
/// early never changes a choice.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Options {
    /// Map scores onto the reference scale (for sessions with enough scores).
    pub reference_scale: bool,
    /// Group titles of the same day under one heading.
    pub day_headers: bool,
    /// Stop adding up pieces, newest first, once the sum is over the budget
    /// ([`cost_within`]). Off, every piece is counted.
    pub stop_early: bool,
    /// Spend what the chosen forms leave of the budget on titles of hidden
    /// summaries ([`fill_titles`]). Off, the plan is the one the reference
    /// calculation for `testdata/history-line-shape.json` makes, which has
    /// no such step.
    pub fill: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            reference_scale: true,
            day_headers: true,
            stop_early: true,
            fill: true,
        }
    }
}

impl Options {
    /// How far a sum of pieces needs to go to tell whether they fit `budget`.
    fn limit(self, budget: f64) -> f64 {
        if self.stop_early {
            budget
        } else {
            f64::INFINITY
        }
    }
}

/// The forms a fold chose. A fold reads the forms and groups; the rest is for
/// tests and the replay harness.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) struct Plan {
    /// The stretch factor, or `None` when every summary fits in full and the
    /// line was not used.
    pub stretch: Option<f64>,
    /// The form of each summary, 1..=6, oldest first.
    pub forms: Vec<u8>,
    /// Runs of titles that share one day heading, each oldest first.
    pub groups: Vec<Vec<usize>>,
    /// The cost of every rendered piece together, headings and the joints
    /// between pieces included.
    pub total: u64,
    /// The joints' share of `total` ([`Costs::joint`]).
    pub joints: u64,
    /// The budget the forms were chosen for, after the fallback for none.
    pub budget: f64,
    /// The scores the line compared, after the reference scale.
    pub scores: Vec<f64>,
    /// The scores the floor compared ([`floor_scores`]).
    pub floor_scores: Vec<f64>,
}

/// The budget a fold works with: `budget`, or the fallback when there is none.
pub(crate) fn effective_budget(budget: f64) -> f64 {
    if budget > 0.0 {
        budget
    } else {
        HISTORY_BUDGET_WHEN_WINDOW_UNKNOWN
    }
}

/// The line's height at `age` (0 for the newest summary) when its ages are
/// stretched by `stretch`.
pub(crate) fn line_height(age: f64, stretch: f64) -> f64 {
    let (mut from_age, mut from_height) = (0.0, START_HEIGHT);
    for (to_age, to_height, bend) in PARTS {
        let to_age = to_age * stretch;
        if age < to_age {
            let u = ((age - from_age) / (to_age - from_age)).clamp(0.0, 1.0);
            return from_height + (to_height - from_height) * u.powf(bend);
        }
        from_age = to_age;
        from_height = to_height;
    }
    from_height
}

/// The form a summary scored `score` takes where the line stands at `height`.
pub(crate) fn form_under_line(score: f64, height: f64) -> u8 {
    if score <= height {
        return NOT_SHOWN;
    }
    let share = 100.0 * (score - height) / score;
    FORM_SHARES
        .iter()
        .position(|&cut| share >= cut)
        .map_or(TITLE, |position| position as u8 + 1)
}

/// The reference score at rank percentile `rank` (0..=100), interpolated
/// between the table's entries.
pub(crate) fn reference_score(rank: f64) -> f64 {
    let rank = rank.clamp(0.0, 100.0);
    let below = rank.floor() as usize;
    if below >= 100 {
        return REFERENCE_SCORES[100];
    }
    let (low, high) = (REFERENCE_SCORES[below], REFERENCE_SCORES[below + 1]);
    low + (high - low) * (rank - below as f64)
}

/// The scores the line compares: the stored ones, or, for a session with
/// enough scored summaries, each one's rank in the session mapped onto the
/// reference scale. A rank is the share of the session's summaries with a
/// lower score, with tied summaries at the middle of their group, so equal
/// scores get one value.
pub(crate) fn line_scores(summaries: &[Summary], reference_scale: bool) -> Vec<f64> {
    ranked_scores(summaries, reference_scale, false)
}

/// The scores the floor compares: as [`line_scores`], but a tie group counts
/// at its highest rank. At the middle, a top score shared by more than about
/// one summary in seventy would map below the floor's score, and a session
/// whose summarizer gives its best work one score would have no floor.
pub(crate) fn floor_scores(summaries: &[Summary], reference_scale: bool) -> Vec<f64> {
    ranked_scores(summaries, reference_scale, true)
}

/// [`line_scores`], with each tie group at its highest rank when `top`.
fn ranked_scores(summaries: &[Summary], reference_scale: bool, top: bool) -> Vec<f64> {
    let scores: Vec<f64> = summaries.iter().map(|summary| summary.score).collect();
    let scored = summaries.iter().filter(|summary| summary.scored).count();
    if !reference_scale || scored < REFERENCE_MIN_SCORED {
        return scores;
    }
    let mut sorted = scores.clone();
    sorted.sort_by(f64::total_cmp);
    let count = sorted.len() as f64;
    scores
        .iter()
        .map(|&score| {
            let first = sorted.partition_point(|&other| other < score);
            let last = sorted.partition_point(|&other| other <= score) - 1;
            let position = if top {
                last as f64
            } else {
                (first + last) as f64 / 2.0
            };
            reference_score(100.0 * (position + 0.5) / count)
        })
        .collect()
}

/// Choose every summary's form for `budget` tokens.
///
/// The search takes [`STRETCH_MAX`] if its total fits, and otherwise halves
/// the range [`STRETCH_MIN`, `STRETCH_MAX`] [`STRETCH_STEPS`] times, keeping
/// the lower end, on the real token count of every piece it looks at. A
/// fold's costs remember those counts for the session ([`PieceCounts`]), so
/// a fold counts only the pieces no earlier fold counted. When even the
/// smallest stretch is over the budget, the shown summaries step down from
/// the oldest end ([`step_down`]), so the total always fits. What is left of
/// the budget goes to titles of hidden summaries ([`fill_titles`]).
pub(crate) fn plan(
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
    // The search ends over the budget only when it ended at the smallest
    // stretch, which it never tries, and that plan is over. A wider stretch
    // could still fit: forms of one summary need not cost less the shorter
    // they are, so the total need not grow with the stretch.
    if chosen.2 as f64 > budget {
        let (forms, groups, total) = step_down(summaries, chosen.1, budget, costs, options);
        chosen = (chosen.0, forms, total, groups);
    }
    if options.fill {
        let (forms, groups, total) = fill_titles(summaries, chosen.1, budget, costs, options);
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

/// The scores a plan compares, one of each per summary: the line's
/// ([`line_scores`]) and the floor's ([`floor_scores`]).
#[derive(Clone, Copy)]
pub(crate) struct Scores<'s> {
    pub line: &'s [f64],
    pub floor: &'s [f64],
}

/// Spend what is left of the budget on the summaries the plan hides: newest
/// first, each as its title alone, until the next one does not fit. A title
/// that fits is history the block would otherwise drop, while the messages
/// it covers are already out of the request. The titles join day headings
/// like any other.
///
/// `forms` must fit the budget, as every plan before the fill does. The
/// total is kept as a running sum rather than counted again for every title
/// tried: since the fill goes newest first and stops at the first title that
/// does not fit, every summary newer than the one tried is already shown,
/// and adding its title changes only the runs of titles on either side of
/// it (see [`TitleFill`]). The full count runs once, at the end.
pub(crate) fn fill_titles(
    summaries: &[Summary],
    mut forms: Vec<u8>,
    budget: f64,
    costs: &mut impl Costs,
    options: Options,
) -> (Vec<u8>, Vec<Vec<usize>>, u64) {
    let limit = options.limit(budget);
    let (groups, total) = cost_within(summaries, &forms, costs, options, limit);
    if !forms.contains(&NOT_SHOWN) {
        return (forms, groups, total);
    }
    debug_assert!(
        total as f64 <= budget,
        "the plan to fill is over its budget"
    );
    let mut fill = TitleFill::new(summaries, &forms, options, costs, &groups, total);
    let mut filled = false;
    for index in (0..forms.len()).rev() {
        if forms[index] != NOT_SHOWN {
            fill.settle(&forms, index);
            continue;
        }
        let (sum, pieces) = fill.with_title(&forms, index, costs);
        if (sum + fill.joints(pieces)) as f64 > budget {
            break;
        }
        forms[index] = TITLE;
        (fill.sum, fill.pieces) = (sum, pieces);
        fill.settle(&forms, index);
        filled = true;
    }
    if !filled {
        return (forms, groups, total);
    }
    let total = fill.sum + fill.joints(fill.pieces);
    let groups = if options.day_headers {
        day_groups(summaries, &forms)
    } else {
        Vec::new()
    };
    debug_assert_eq!(
        cost_of(summaries, &forms, costs, options),
        (groups.clone(), total),
        "the title fill's running sum"
    );
    (forms, groups, total)
}

/// The running sum of [`fill_titles`]. While the fill tries the title of
/// summary `i`, every summary newer than `i` is shown and every older one has
/// its form from before the fill. A title of `i` can join the run of titles
/// of its day right after it (which starts at `i + 1`, all shown) and the one
/// before it (which ends at the newest shown summary older than `i`; hidden
/// summaries between do not break a run), or split the one run those two
/// form together when it is of another day or has none. Nothing else in the
/// block changes.
struct TitleFill<'s, 'd> {
    summaries: &'s [Summary<'d>],
    day_headers: bool,
    joint: f64,
    /// The shown pieces' cost without the joints, and how many pieces.
    sum: u64,
    pieces: usize,
    /// For each summary older than the fill's start: the newest shown
    /// summary before it, from before the fill.
    before: Vec<Option<usize>>,
    /// For each shown title of a day, from before the fill: the first title
    /// and the length of the run of titles of its day that ends at it.
    run_back: Vec<(usize, usize)>,
    /// For each summary the fill has passed (all shown): the last summary of
    /// the run of titles of its day that starts at it.
    run_end: Vec<usize>,
}

impl<'s, 'd> TitleFill<'s, 'd> {
    fn new(
        summaries: &'s [Summary<'d>],
        forms: &[u8],
        options: Options,
        costs: &mut impl Costs,
        groups: &[Vec<usize>],
        total: u64,
    ) -> Self {
        let count = forms.len();
        let mut fill = Self {
            summaries,
            day_headers: options.day_headers,
            joint: costs.joint(),
            sum: 0,
            pieces: forms.iter().filter(|&&form| form < NOT_SHOWN).count() + groups.len(),
            before: vec![None; count],
            run_back: (0..count).map(|index| (index, 1)).collect(),
            run_end: (0..count).collect(),
        };
        fill.sum = total - fill.joints(fill.pieces);
        let mut newest_shown: Option<usize> = None;
        for index in 0..count {
            fill.before[index] = newest_shown;
            if forms[index] == NOT_SHOWN {
                continue;
            }
            if let Some(previous) = newest_shown.filter(|&p| fill.joins(forms, p, index)) {
                let (first, length) = fill.run_back[previous];
                fill.run_back[index] = (first, length + 1);
            }
            newest_shown = Some(index);
        }
        fill
    }

    fn joints(&self, pieces: usize) -> u64 {
        (self.joint * pieces.saturating_sub(1) as f64).ceil() as u64
    }

    /// Whether summary `index` is a title that can share a day heading.
    fn groups(&self, forms: &[u8], index: usize) -> bool {
        self.day_headers && forms[index] == TITLE && self.summaries[index].day.is_some()
    }

    /// Whether shown summaries `older` and `newer`, with no shown summary
    /// between them, are titles in one run.
    fn joins(&self, forms: &[u8], older: usize, newer: usize) -> bool {
        self.groups(forms, older)
            && self.groups(forms, newer)
            && self.summaries[older].day == self.summaries[newer].day
    }

    /// Record the run that starts at `index`, now that every summary from
    /// it on keeps its form.
    fn settle(&mut self, forms: &[u8], index: usize) {
        let next = index + 1;
        self.run_end[index] = if next < forms.len() && self.joins(forms, index, next) {
            self.run_end[next]
        } else {
            index
        };
    }

    /// The sum and piece count with the title of hidden summary `index`.
    fn with_title(&self, forms: &[u8], index: usize, costs: &mut impl Costs) -> (u64, usize) {
        // The runs on either side, as (first, last, length).
        let older = self.before[index]
            .filter(|&p| self.groups(forms, p))
            .map(|p| {
                let (first, length) = self.run_back[p];
                (first, p, length)
            });
        let newer = Some(index + 1)
            .filter(|&q| q < forms.len() && self.groups(forms, q))
            .map(|q| (q, self.run_end[q], self.run_end[q] - q + 1));
        let day = |at: usize| self.summaries[at].day;
        let own = self.day_headers && day(index).is_some();
        let joins_older = older.filter(|run| own && day(run.1) == day(index));
        let joins_newer = newer.filter(|run| own && day(run.0) == day(index));
        let (before, after) = match (older, newer) {
            // One run spans the hidden summary: it grows, or splits around
            // a title of another day or of none.
            (Some(o), Some(n)) if day(o.1) == day(n.0) => {
                let joined = (o.0, n.1, o.2 + n.2);
                if joins_older.is_some() {
                    (vec![joined], vec![(o.0, n.1, o.2 + n.2 + 1)])
                } else {
                    (vec![joined], vec![o, (index, index, 1), n])
                }
            }
            _ => match (joins_older, joins_newer) {
                (Some(o), _) => (vec![o], vec![(o.0, index, o.2 + 1)]),
                (_, Some(n)) => (vec![n], vec![(index, n.1, n.2 + 1)]),
                _ => (Vec::new(), vec![(index, index, 1)]),
            },
        };
        // A run costs its heading and its lines, or one title its piece. The
        // lines of the titles shown before stay, so only the difference
        // between a run's heading and a title alone is counted, and the new
        // title's line.
        let own_line = costs.group_line(index) as i64;
        let mut cost = |(first, last, length): (usize, usize, usize)| -> (i64, usize) {
            if length == 1 {
                let alone = costs.piece(first, TITLE) as i64 - costs.group_line(first) as i64;
                (alone, 1)
            } else {
                let heading = Heading {
                    first,
                    last,
                    count: length,
                };
                (costs.group_header(heading) as i64, length + 1)
            }
        };
        let mut sum = self.sum as i64 + own_line;
        let mut pieces = self.pieces as i64;
        for run in before {
            let (extra, count) = cost(run);
            sum -= extra;
            pieces -= count as i64;
        }
        for run in after {
            let (extra, count) = cost(run);
            sum += extra;
            pieces += count as i64;
        }
        (sum as u64, pieces as usize)
    }
}

/// The title fill as it first was: the whole plan counted again for every
/// title tried. [`fill_titles`] must choose exactly what this chooses.
#[cfg(test)]
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

/// The stretch factor the search settles on (`None` when everything fits in
/// full), with its forms, total and day groups.
fn search(
    summaries: &[Summary],
    scores: Scores,
    budget: f64,
    costs: &mut impl Costs,
    options: Options,
) -> (Option<f64>, Vec<u8>, u64, Vec<Vec<usize>>) {
    let count = summaries.len();
    let limit = options.limit(budget);
    // Newest first, stopping once over: whether everything fits in full
    // does not need the full count of every old summary.
    let mut full = (costs.joint() * count.saturating_sub(1) as f64).ceil() as u64;
    for index in (0..count).rev() {
        if full as f64 > limit {
            break;
        }
        full += costs.piece(index, FULL);
    }
    if full as f64 <= budget {
        return (None, vec![FULL; count], full, Vec::new());
    }
    let mut fits = |stretch: f64| {
        forms_at(summaries, scores, stretch, budget, costs, options, limit).2 as f64 <= budget
    };
    let stretch = if fits(STRETCH_MAX) {
        STRETCH_MAX
    } else {
        let (mut low, mut high) = (STRETCH_MIN, STRETCH_MAX);
        for _ in 0..STRETCH_STEPS {
            let middle = (low + high) / 2.0;
            if fits(middle) {
                low = middle;
            } else {
                high = middle;
            }
        }
        low
    };
    let (forms, groups, total) =
        forms_at(summaries, scores, stretch, budget, costs, options, limit);
    (Some(stretch), forms, total, groups)
}

/// When even the smallest stretch is over the budget (the newest summary
/// alone can be larger than a small budget, since the line starts at the
/// same height at every stretch), the shown summaries give up detail from
/// the oldest end: each one form at a time until it is hidden, before the
/// next newer one is touched, until the total fits. The floor's titles are
/// among the oldest shown, so they go first. With every summary hidden the
/// total is zero, so the result always fits.
///
/// Only the oldest shown summary ever changes, so the total is kept as the
/// cost of a block at that end plus the cost of everything after it, which
/// stays as it is and is summed once: the block is the oldest shown summary
/// and the run of titles right after it, which it can join under one day
/// heading. Each step looks up a few costs instead of every shown piece
/// again, and the total is counted in full once, at the end.
fn step_down(
    summaries: &[Summary],
    mut forms: Vec<u8>,
    budget: f64,
    costs: &mut impl Costs,
    options: Options,
) -> (Vec<u8>, Vec<Vec<usize>>, u64) {
    // The shown summaries, oldest first; a position is an index into this.
    let order: Vec<usize> = (0..forms.len())
        .filter(|&index| forms[index] < NOT_SHOWN)
        .collect();
    let count = order.len();
    let joins = |forms: &[u8], a: usize, b: usize| {
        let (a, b) = (order[a], order[b]);
        options.day_headers
            && forms[a] == TITLE
            && forms[b] == TITLE
            && summaries[a].day.is_some()
            && summaries[a].day == summaries[b].day
    };
    // The last position of the run of titles from each position on.
    let mut run_end: Vec<usize> = (0..count).collect();
    for position in (0..count.saturating_sub(1)).rev() {
        if joins(&forms, position, position + 1) {
            run_end[position] = run_end[position + 1];
        }
    }
    // The line costs of the titles, summed up to each position.
    let mut lines = vec![0u64; count + 1];
    for (position, &index) in order.iter().enumerate() {
        let line = if forms[index] == TITLE {
            costs.group_line(index)
        } else {
            0
        };
        lines[position + 1] = lines[position] + line;
    }
    // What the positions from each start of a run (or a summary that is
    // not a title) on cost, and their pieces.
    let mut after = vec![(0u64, 0usize); count + 1];
    for start in (0..count).rev() {
        if start > 0 && joins(&forms, start - 1, start) {
            continue;
        }
        let end = run_end[start];
        let (cost, pieces) = if forms[order[start]] == TITLE {
            run_cost(costs, &order, &lines, start, end)
        } else {
            (costs.piece(order[start], forms[order[start]]), 1)
        };
        after[start] = (cost + after[end + 1].0, pieces + after[end + 1].1);
    }
    for front in 0..count {
        let index = order[front];
        // The block: this summary and the run of titles right after it.
        let next_is_title = front + 1 < count && forms[order[front + 1]] == TITLE;
        let end = if next_is_title {
            run_end[front + 1]
        } else {
            front
        };
        while forms[index] < NOT_SHOWN {
            forms[index] += 1;
            let (block, pieces) = if next_is_title && joins(&forms, front, front + 1) {
                let header = costs.group_header(Heading::of(&order[front..=end]));
                let line = costs.group_line(index);
                (
                    header + line + lines[end + 1] - lines[front + 1],
                    end - front + 2,
                )
            } else {
                let (own, own_pieces) = match forms[index] {
                    NOT_SHOWN => (0, 0),
                    form => (costs.piece(index, form), 1),
                };
                let (rest, rest_pieces) = if next_is_title {
                    run_cost(costs, &order, &lines, front + 1, end)
                } else {
                    (0, 0)
                };
                (own + rest, own_pieces + rest_pieces)
            };
            let (rest, rest_pieces) = after[end + 1];
            let pieces = pieces + rest_pieces;
            let joints = (costs.joint() * pieces.saturating_sub(1) as f64).ceil() as u64;
            if (block + rest + joints) as f64 <= budget {
                let (groups, total) = cost_of(summaries, &forms, costs, options);
                debug_assert_eq!(total, block + rest + joints);
                return (forms, groups, total);
            }
        }
    }
    let (groups, total) = cost_of(summaries, &forms, costs, options);
    (forms, groups, total)
}

/// What the titles at positions `from..=to` of `order` cost as one run, and
/// how many pieces they are: a title on its own, or a day heading and a
/// line each. `lines` holds the titles' line costs summed by position.
fn run_cost(
    costs: &mut impl Costs,
    order: &[usize],
    lines: &[u64],
    from: usize,
    to: usize,
) -> (u64, usize) {
    if from == to {
        (costs.piece(order[from], TITLE), 1)
    } else {
        (
            costs.group_header(Heading::of(&order[from..=to])) + lines[to + 1] - lines[from],
            to - from + 2,
        )
    }
}

/// Give the oldest summary `plan` shows one shorter form (or leave it out),
/// with the plan's day groups and total brought up to date, as one step of
/// [`step_down`]. Returns whether any summary was shown.
pub(crate) fn step_oldest(
    plan: &mut Plan,
    summaries: &[Summary],
    costs: &mut impl Costs,
    options: Options,
) -> bool {
    let Some(index) = plan.forms.iter().position(|&form| form < NOT_SHOWN) else {
        return false;
    };
    plan.forms[index] += 1;
    let (groups, total) = cost_of(summaries, &plan.forms, costs, options);
    plan.joints = joints_cost(&plan.forms, &groups, costs);
    (plan.groups, plan.total) = (groups, total);
    true
}

/// The forms, day groups and total cost at one stretch factor, the total
/// summed only until it is over `limit` ([`cost_within`]).
fn forms_at(
    summaries: &[Summary],
    scores: Scores,
    stretch: f64,
    budget: f64,
    costs: &mut impl Costs,
    options: Options,
    limit: f64,
) -> (Vec<u8>, Vec<Vec<usize>>, u64) {
    let forms = forms_on_line(scores, stretch, budget, costs);
    let (groups, total) = cost_within(summaries, &forms, costs, options, limit);
    (forms, groups, total)
}

/// The form the line gives each summary at `stretch`, with the floor's
/// titles for `budget`.
pub(crate) fn forms_on_line(
    scores: Scores,
    stretch: f64,
    budget: f64,
    costs: &mut impl Costs,
) -> Vec<u8> {
    let Scores { line, floor } = scores;
    let count = line.len();
    let mut forms: Vec<u8> = (0..count)
        .map(|index| {
            let age = (count - 1 - index) as f64;
            form_under_line(line[index], line_height(age, stretch))
        })
        .collect();

    // The floor: hidden summaries with the highest scores come back as
    // titles, the newer first on equal scores, while they fit in their share
    // of the budget. Each is charged its title on its own. The order is the
    // line's scores; within equal ones the floor's (which only differ there
    // for summaries of different stored scores), so the summaries the floor
    // accepts come first.
    let mut hidden: Vec<usize> = (0..count)
        .filter(|&index| forms[index] == NOT_SHOWN)
        .collect();
    hidden.sort_by(|&a, &b| {
        line[b]
            .total_cmp(&line[a])
            .then(floor[b].total_cmp(&floor[a]))
            .then(b.cmp(&a))
    });
    let mut room = FLOOR_SHARE * budget;
    for index in hidden {
        if floor[index] < FLOOR_SCORE {
            break;
        }
        let cost = costs.piece(index, TITLE) as f64;
        if cost > room {
            break;
        }
        room -= cost;
        forms[index] = TITLE;
    }
    forms
}

/// The day groups of `forms` and what the shown pieces cost together.
pub(crate) fn cost_of(
    summaries: &[Summary],
    forms: &[u8],
    costs: &mut impl Costs,
    options: Options,
) -> (Vec<Vec<usize>>, u64) {
    cost_within(summaries, forms, costs, options, f64::INFINITY)
}

/// [`cost_of`], but the sum stops, newest piece first, once it is over
/// `limit`: the caller then only needs to know that it is over, and the old
/// pieces it did not reach (often the longest, at a wide stretch) are never
/// counted. Every part is at least zero, so a sum that fits is exact.
fn cost_within(
    summaries: &[Summary],
    forms: &[u8],
    costs: &mut impl Costs,
    options: Options,
    limit: f64,
) -> (Vec<Vec<usize>>, u64) {
    let groups = if options.day_headers {
        day_groups(summaries, forms)
    } else {
        Vec::new()
    };
    // Each day heading is added with its newest title.
    let mut group_of = vec![None; forms.len()];
    for group in &groups {
        for &index in group {
            group_of[index] = Some(group);
        }
    }
    let mut total = joints_cost(forms, &groups, costs);
    for (index, &form) in forms.iter().enumerate().rev() {
        if total as f64 > limit {
            break;
        }
        match group_of[index] {
            _ if form >= NOT_SHOWN => {}
            Some(group) if group.last() == Some(&index) => {
                total += costs.group_header(Heading::of(group)) + costs.group_line(index);
            }
            Some(_) => total += costs.group_line(index),
            None => total += costs.piece(index, form),
        }
    }
    (groups, total)
}

/// Runs of at least two titles that follow each other in the block (hidden
/// summaries between them don't break a run) and start on the same day. Any
/// other shown form, another day or a title without a day ends a run.
pub(crate) fn day_groups(summaries: &[Summary], forms: &[u8]) -> Vec<Vec<usize>> {
    let mut groups = Vec::new();
    let mut run: Vec<usize> = Vec::new();
    let mut run_day: Option<&str> = None;
    let mut close = |run: &mut Vec<usize>| {
        if run.len() >= 2 {
            groups.push(std::mem::take(run));
        } else {
            run.clear();
        }
    };
    for (index, &form) in forms.iter().enumerate() {
        match (form, summaries[index].day) {
            (NOT_SHOWN, _) => {}
            (TITLE, Some(day)) if run_day == Some(day) => run.push(index),
            (TITLE, Some(day)) => {
                close(&mut run);
                run.push(index);
                run_day = Some(day);
            }
            _ => {
                close(&mut run);
                run_day = None;
            }
        }
    }
    close(&mut run);
    groups
}

/// A day heading over a run of titles: its first and last title and how
/// many there are, which is all its text shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct Heading {
    pub first: usize,
    pub last: usize,
    pub count: usize,
}

impl Heading {
    /// The heading over `members`, a run of at least one title.
    pub(crate) fn of(members: &[usize]) -> Self {
        Self {
            first: members[0],
            last: members[members.len() - 1],
            count: members.len(),
        }
    }
}

/// A rendered piece of the history block.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Piece {
    /// Summary `index` on its own at a form (1..=5).
    Form(usize, u8),
    /// Summary `index` as one line under a day heading.
    Line(usize),
    /// A day heading.
    Header(Heading),
}

/// The token counts of one summary's pieces: its five forms on its own and
/// its line under a day heading, each counted when first needed. The session
/// keeps them across folds ([`super::render::HistoryCounts`]); each count is
/// kept with a hash of the text it counted and used again only for the same
/// text, since a stored row can be rewritten in place.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct PieceCounts {
    pub forms: [Option<Counted>; 5],
    pub line: Option<Counted>,
}

/// A piece's token count and a hash of the text it was counted on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Counted {
    pub tokens: u64,
    pub text: u64,
}

/// The hash a count is kept with. Counts live only in memory, so the
/// standard library's hasher, fixed within a build, is enough.
pub(crate) fn text_hash(text: &str) -> u64 {
    use std::hash::Hasher;
    let mut hasher = std::hash::DefaultHasher::new();
    hasher.write(text.as_bytes());
    hasher.finish()
}

/// The costs of a session's pieces with its own token counter. Each piece is
/// counted once, into `known`: the search looks at the same pieces at many
/// stretch factors, and later folds of the session at the same ones again.
/// A count found in `known` is checked once per render against the text the
/// piece renders now.
pub(crate) struct CountedCosts<'k, R, C> {
    render: R,
    count: C,
    known: &'k mut [PieceCounts],
    /// Which of each summary's six slots (five forms, then the line) this
    /// render has checked or counted.
    checked: Vec<[bool; 6]>,
    headers: HashMap<Heading, u64>,
    joint: f64,
}

impl<'k, R, C> CountedCosts<'k, R, C>
where
    R: Fn(Piece) -> String,
    C: Fn(&str) -> u64,
{
    /// Costs over `known`, one entry per summary given to [`plan`].
    pub(crate) fn new(known: &'k mut [PieceCounts], render: R, count: C) -> Self {
        let checked = vec![[false; 6]; known.len()];
        Self {
            render,
            count,
            known,
            checked,
            headers: HashMap::new(),
            joint: 0.0,
        }
    }

    /// Set what joining two pieces adds to the block's count
    /// ([`Costs::joint`]).
    pub(crate) fn set_joint(&mut self, joint: f64) {
        self.joint = joint;
    }

    /// The tokens of summary `index`'s piece in `slot` (0..5 a form, 5 its
    /// line): the kept count when it was counted on the same text, else
    /// counted now.
    fn tokens(&mut self, index: usize, slot: usize, piece: Piece) -> u64 {
        let kept = if slot < 5 {
            &mut self.known[index].forms[slot]
        } else {
            &mut self.known[index].line
        };
        if self.checked[index][slot] {
            if let Some(counted) = kept {
                return counted.tokens;
            }
        }
        self.checked[index][slot] = true;
        let text = (self.render)(piece);
        let hash = text_hash(&text);
        match kept {
            Some(counted) if counted.text == hash => counted.tokens,
            _ => {
                let tokens = (self.count)(&text);
                *kept = Some(Counted { tokens, text: hash });
                tokens
            }
        }
    }
}

impl<R, C> Costs for CountedCosts<'_, R, C>
where
    R: Fn(Piece) -> String,
    C: Fn(&str) -> u64,
{
    fn piece(&mut self, index: usize, form: u8) -> u64 {
        self.tokens(index, usize::from(form - 1), Piece::Form(index, form))
    }

    fn group_line(&mut self, index: usize) -> u64 {
        self.tokens(index, 5, Piece::Line(index))
    }

    fn group_header(&mut self, heading: Heading) -> u64 {
        let (render, count) = (&self.render, &self.count);
        *self
            .headers
            .entry(heading)
            .or_insert_with(|| count(&render(Piece::Header(heading))))
    }

    fn joint(&mut self) -> f64 {
        self.joint
    }
}
