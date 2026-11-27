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
//! its form or gets a longer one. The fold takes the largest factor whose
//! rendered size fits, counting each summary's chosen form with the session's
//! own counter. Old short forms are therefore never removed to keep a newer
//! long one, as a guard that cuts from the oldest end would.
//!
//! When every summary fits in full there is nothing to trade, and every
//! summary is shown in full. Old summaries the line hides whose score is 90
//! or more come back as titles, within a small share of the budget. Titles of
//! the same day share one heading.
//!
//! Everything here is plain arithmetic on the inputs, so the same summaries,
//! scores and budget always give the same forms and the same bytes.

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
const STRETCH_MIN: f64 = 0.0005;
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
    /// The day heading over the titles `members`.
    fn group_header(&mut self, members: &[usize]) -> u64;
    /// Switch to estimated costs (`true`) or back to real ones. Returns
    /// whether estimates are available; costs that have none stay real.
    fn estimating(&mut self, on: bool) -> bool {
        let _ = on;
        false
    }
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

/// Switches the tests use to compare with the lab's calculation.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Options {
    /// Map scores onto the reference scale (for sessions with enough scores).
    pub reference_scale: bool,
    /// Group titles of the same day under one heading.
    pub day_headers: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            reference_scale: true,
            day_headers: true,
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
    /// When the search used estimates: the real total of the forms it
    /// picked, before the check that runs the search again on real counts
    /// when that total is over the budget.
    pub estimated_pick_total: Option<u64>,
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
            reference_score(100.0 * ((first + last) as f64 / 2.0 + 0.5) / count)
        })
        .collect()
}

/// How far an estimated total may be from the budget before the search
/// counts it exactly. Estimates come from character lengths and are
/// typically within a few percent of the real count.
const ESTIMATE_MARGIN: f64 = 0.1;

/// Choose every summary's form for `budget` tokens.
///
/// The search takes the largest stretch factor whose total fits, by halving
/// the range [`STRETCH_MIN`, `STRETCH_MAX`] [`STRETCH_STEPS`] times. Counting
/// every form the search looks at with an exact tokenizer would take far
/// longer than the rest of a fold, so when `costs` can estimate
/// ([`Costs::estimating`]), each step first estimates its total and counts it
/// for real only when the estimate is within [`ESTIMATE_MARGIN`] of the
/// budget, which in practice are the last steps. The chosen forms are always
/// counted for real; should they not fit (an estimate far off), the search
/// runs again on real counts alone.
pub(crate) fn plan(
    summaries: &[Summary],
    budget: f64,
    costs: &mut impl Costs,
    options: Options,
) -> Plan {
    let budget = effective_budget(budget);
    let scores = line_scores(summaries, options.reference_scale);
    let estimates = costs.estimating(true);
    costs.estimating(false);
    let mut chosen = search(summaries, &scores, budget, costs, options, estimates);
    let estimated_pick_total = estimates.then_some(chosen.2);
    if estimates && chosen.2 as f64 > budget {
        chosen = search(summaries, &scores, budget, costs, options, false);
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
        estimated_pick_total,
    }
}

/// The stretch factor the search settles on (`None` when everything fits in
/// full), with its forms, total and day groups counted for real.
fn search(
    summaries: &[Summary],
    scores: &[f64],
    budget: f64,
    costs: &mut impl Costs,
    options: Options,
    estimates: bool,
) -> (Option<f64>, Vec<u8>, u64, Vec<Vec<usize>>) {
    let count = summaries.len();
    let joints = (costs.joint() * count.saturating_sub(1) as f64).ceil() as u64;
    let all_full =
        |costs: &mut dyn FnMut(usize) -> u64| (0..count).map(costs).sum::<u64>() + joints;
    // Whether everything fits in full; an estimate far over the budget
    // spares counting every full form.
    let over_in_full = estimates && {
        costs.estimating(true);
        let estimated = all_full(&mut |index| costs.piece(index, FULL));
        costs.estimating(false);
        estimated as f64 > budget * (1.0 + ESTIMATE_MARGIN)
    };
    if !over_in_full {
        let full = all_full(&mut |index| costs.piece(index, FULL));
        if full as f64 <= budget {
            return (None, vec![FULL; count], full, Vec::new());
        }
    }
    let mut fits = |stretch: f64| {
        if estimates {
            costs.estimating(true);
            let estimated = forms_at(summaries, scores, stretch, budget, costs, options).2 as f64;
            costs.estimating(false);
            if estimated < budget * (1.0 - ESTIMATE_MARGIN) {
                return true;
            }
            if estimated > budget * (1.0 + ESTIMATE_MARGIN) {
                return false;
            }
        }
        forms_at(summaries, scores, stretch, budget, costs, options).2 as f64 <= budget
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
    let (forms, groups, total) = forms_at(summaries, scores, stretch, budget, costs, options);
    (Some(stretch), forms, total, groups)
}

/// The forms, day groups and total cost at one stretch factor.
fn forms_at(
    summaries: &[Summary],
    scores: &[f64],
    stretch: f64,
    budget: f64,
    costs: &mut impl Costs,
    options: Options,
) -> (Vec<u8>, Vec<Vec<usize>>, u64) {
    let count = summaries.len();
    let mut forms: Vec<u8> = (0..count)
        .map(|index| {
            let age = (count - 1 - index) as f64;
            form_under_line(scores[index], line_height(age, stretch))
        })
        .collect();

    // The floor: hidden summaries with the highest scores come back as
    // titles, the newer first on equal scores, while they fit in their share
    // of the budget. Each is charged its title on its own.
    let mut hidden: Vec<usize> = (0..count)
        .filter(|&index| forms[index] == NOT_SHOWN)
        .collect();
    hidden.sort_by(|&a, &b| scores[b].total_cmp(&scores[a]).then(b.cmp(&a)));
    let mut room = FLOOR_SHARE * budget;
    for index in hidden {
        if scores[index] < FLOOR_SCORE {
            break;
        }
        let cost = costs.piece(index, TITLE) as f64;
        if cost > room {
            break;
        }
        room -= cost;
        forms[index] = TITLE;
    }

    let groups = if options.day_headers {
        day_groups(summaries, &forms)
    } else {
        Vec::new()
    };
    let mut grouped = vec![false; count];
    let mut total = 0;
    for group in &groups {
        total += costs.group_header(group);
        for &index in group {
            grouped[index] = true;
            total += costs.group_line(index);
        }
    }
    for (index, &form) in forms.iter().enumerate() {
        if form < NOT_SHOWN && !grouped[index] {
            total += costs.piece(index, form);
        }
    }
    total += joints_cost(&forms, &groups, costs);
    (forms, groups, total)
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

/// A rendered piece of the history block.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Piece<'a> {
    /// Summary `index` on its own at a form (1..=5).
    Form(usize, u8),
    /// Summary `index` as one line under a day heading.
    Line(usize),
    /// The day heading over these titles.
    Header(&'a [usize]),
}

/// How many summaries the ratio of tokens to characters is measured on, for
/// each form.
const RATIO_SAMPLE: usize = 64;

/// The costs of a session's pieces with its own token counter, each counted
/// once per fold: the search looks at the same pieces at many stretch
/// factors. Estimates multiply a piece's characters by the ratio of tokens to
/// characters measured on a sample of the session's own pieces of the same
/// form.
pub(crate) struct CountedCosts<R, C> {
    render: R,
    count: C,
    pieces: Vec<[Option<u64>; 5]>,
    lines: Vec<Option<u64>>,
    headers: HashMap<(usize, usize, usize), u64>,
    piece_chars: Vec<[Option<u32>; 5]>,
    line_chars: Vec<Option<u32>>,
    /// Tokens per character for each form, measured on first use.
    ratios: Option<[f64; 5]>,
    estimating: bool,
    joint: f64,
}

impl<R, C> CountedCosts<R, C>
where
    R: Fn(Piece) -> String,
    C: Fn(&str) -> u64,
{
    pub(crate) fn new(summaries: usize, render: R, count: C) -> Self {
        Self {
            render,
            count,
            pieces: vec![[None; 5]; summaries],
            lines: vec![None; summaries],
            headers: HashMap::new(),
            piece_chars: vec![[None; 5]; summaries],
            line_chars: vec![None; summaries],
            ratios: None,
            estimating: false,
            joint: 0.0,
        }
    }

    /// Set what joining two pieces adds to the block's count
    /// ([`Costs::joint`]).
    pub(crate) fn set_joint(&mut self, joint: f64) {
        self.joint = joint;
    }

    fn real_piece(&mut self, index: usize, form: u8) -> u64 {
        let (render, count) = (&self.render, &self.count);
        *self.pieces[index][usize::from(form - 1)]
            .get_or_insert_with(|| count(&render(Piece::Form(index, form))))
    }

    fn chars(&mut self, piece: Piece) -> u32 {
        let render = &self.render;
        let slot = match piece {
            Piece::Form(index, form) => &mut self.piece_chars[index][usize::from(form - 1)],
            Piece::Line(index) => &mut self.line_chars[index],
            Piece::Header(_) => unreachable!("headings are counted for real"),
        };
        *slot.get_or_insert_with(|| render(piece).chars().count() as u32)
    }

    fn ratios(&mut self) -> [f64; 5] {
        if let Some(ratios) = self.ratios {
            return ratios;
        }
        let summaries = self.pieces.len();
        let sample = summaries.min(RATIO_SAMPLE);
        let mut ratios = [0.25; 5];
        for (slot, form) in ratios.iter_mut().zip(1u8..) {
            let (mut tokens, mut chars) = (0u64, 0u64);
            for n in 0..sample {
                let index = if sample > 1 {
                    n * (summaries - 1) / (sample - 1)
                } else {
                    0
                };
                tokens += self.real_piece(index, form);
                chars += u64::from(self.chars(Piece::Form(index, form)));
            }
            if chars > 0 {
                *slot = tokens as f64 / chars as f64;
            }
        }
        self.ratios = Some(ratios);
        ratios
    }
}

impl<R, C> Costs for CountedCosts<R, C>
where
    R: Fn(Piece) -> String,
    C: Fn(&str) -> u64,
{
    fn piece(&mut self, index: usize, form: u8) -> u64 {
        if self.estimating {
            let ratio = self.ratios()[usize::from(form - 1)];
            return (f64::from(self.chars(Piece::Form(index, form))) * ratio).ceil() as u64;
        }
        self.real_piece(index, form)
    }

    fn group_line(&mut self, index: usize) -> u64 {
        if self.estimating {
            let ratio = self.ratios()[usize::from(TITLE - 1)];
            return (f64::from(self.chars(Piece::Line(index))) * ratio).ceil() as u64;
        }
        let (render, count) = (&self.render, &self.count);
        *self.lines[index].get_or_insert_with(|| count(&render(Piece::Line(index))))
    }

    fn group_header(&mut self, members: &[usize]) -> u64 {
        let key = (members[0], members[members.len() - 1], members.len());
        let (render, count) = (&self.render, &self.count);
        *self
            .headers
            .entry(key)
            .or_insert_with(|| count(&render(Piece::Header(members))))
    }

    fn estimating(&mut self, on: bool) -> bool {
        self.estimating = on;
        true
    }

    fn joint(&mut self) -> f64 {
        self.joint
    }
}
