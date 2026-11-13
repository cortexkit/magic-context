//! Which learned memories a session's head shows.
//!
//! One pure function decides it: the same rows, budget and time give the
//! same selection, so a head rendered twice from unchanged rows has the same
//! bytes. The head shows the selection, and the memory mural the rest.
//!
//! Each memory ranks by importance times freshness. Freshness comes from the
//! memory's decay class: a fact that drifts loses half its weight every
//! `half_life` since it was last genuinely met again (a summary extracting
//! it, an agent saving it, a verification confirming it), while a stable
//! fact keeps it. Permanent memories and policy memories come before every
//! ranked one.
//!
//! The budget is filled in three passes, each taking rows in rank order and
//! skipping a row that doesn't fit while later, smaller rows still may:
//! 1. a protected slice for safety-critical rules, so they never fall out;
//! 2. a minimum share for each visible level, so a busy level can't crowd out
//!    the others; inside the workspace share, each member project gets an
//!    equal part, so one busy sibling can't crowd out the rest;
//! 3. a free pool, filled across all levels, which also takes whatever a
//!    level's minimum left unused.
//!
//! A pass counts only the rows it adds itself against its slice: a critical
//! rule shown in the first pass doesn't use up its level's minimum.
//!
//! Rows the session may not see (another profile's private categories,
//! another agent's memories) are removed by the caller before this runs.

use std::collections::{BTreeMap, HashMap, HashSet};

/// A memory level, in the order the head shows them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Level {
    Global,
    Workspace,
    Project,
    Agent,
}

/// How a memory's weight changes with time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decay {
    /// Full weight always: `stable`, `dated_permanent`, `recurring`.
    Stable,
    /// Halves every half-life since the memory was last met again.
    Drifting,
    /// Full weight until its end, then not shown.
    Bounded,
    /// Full weight until resolved, then not shown.
    OpenUntilResolved,
}

impl Decay {
    /// The decay class a profile names. An unknown name keeps full weight,
    /// so a newer profile's class never hides a memory.
    pub fn named(name: &str) -> Self {
        match name {
            "drifting" => Self::Drifting,
            "bounded" => Self::Bounded,
            "open_until_resolved" => Self::OpenUntilResolved,
            _ => Self::Stable,
        }
    }
}

/// One memory the session may see, with what it costs to show.
#[derive(Clone, Debug)]
pub struct Candidate {
    pub id: i64,
    pub level: Level,
    /// The project a workspace memory came from; the equal floors inside the
    /// workspace share are per project.
    pub source_project: Option<String>,
    pub category: String,
    /// Stored importance, 0 to 100; unset counts as 50.
    pub importance: Option<i64>,
    pub permanent: bool,
    pub policy: bool,
    pub safety_critical: bool,
    pub decay: Decay,
    /// When the memory was last genuinely met again, in ms.
    pub last_met_ms: Option<i64>,
    /// The end of a bounded memory's validity, in ms.
    pub expires_at_ms: Option<i64>,
    /// A resolved open-until-resolved memory is not shown.
    pub resolved: bool,
    /// A memory this one overrides for the session, hidden when both are
    /// visible.
    pub overrides: Option<i64>,
    /// Tokens for the memory's own line.
    pub line_tokens: u64,
    /// Tokens for its category's opening and closing tags in its level's
    /// block, paid once by the first memory of that category shown.
    pub category_tokens: u64,
    /// Tokens for its level's block wrapper, paid once by the first memory
    /// of that level shown.
    pub block_tokens: u64,
}

/// The budget and the parameters the selection runs with.
#[derive(Clone, Debug)]
pub struct Budget {
    pub total_tokens: u64,
    /// The protected slice for safety-critical rules.
    pub protected_tokens: u64,
    /// Each level's minimum share.
    pub level_minimum_tokens: BTreeMap<Level, u64>,
    /// How long a drifting memory takes to lose half its weight.
    pub half_life_ms: i64,
}

/// The memories to show, by id, and the tokens they use.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Selection {
    pub ids: Vec<i64>,
    pub tokens: u64,
}

const UNSET_IMPORTANCE: f64 = 50.0;

/// Pick the memories a head shows at `now_ms`.
pub fn select(candidates: &[Candidate], budget: &Budget, now_ms: i64) -> Selection {
    let shown: Vec<&Candidate> = visible(candidates, now_ms);
    let mut order: Vec<(&Candidate, f64)> = shown
        .into_iter()
        .map(|candidate| (candidate, rank(candidate, budget.half_life_ms, now_ms)))
        .collect();
    order.sort_by(|(left, left_rank), (right, right_rank)| {
        let first = |c: &Candidate| c.permanent || c.policy;
        first(right)
            .cmp(&first(left))
            .then_with(|| right_rank.total_cmp(left_rank))
            .then_with(|| right.last_met_ms.cmp(&left.last_met_ms))
            .then_with(|| left.id.cmp(&right.id))
    });
    let order: Vec<&Candidate> = order.into_iter().map(|(candidate, _)| candidate).collect();

    let mut fill = Fill::new(budget.total_tokens);
    // 1. Critical rules first, inside their own slice.
    let protected: Vec<&Candidate> = order
        .iter()
        .copied()
        .filter(|c| c.safety_critical)
        .collect();
    fill.take(&protected, budget.protected_tokens);
    // 2. Each level's minimum. Inside the workspace share, member projects
    // get equal parts, and a part a project doesn't use is left to the pool.
    for (level, minimum) in &budget.level_minimum_tokens {
        let rows: Vec<&Candidate> = order
            .iter()
            .copied()
            .filter(|c| c.level == *level)
            .collect();
        if *level == Level::Workspace {
            let mut projects: Vec<Option<&str>> = Vec::new();
            for row in &rows {
                if !projects.contains(&row.source_project.as_deref()) {
                    projects.push(row.source_project.as_deref());
                }
            }
            if projects.is_empty() {
                continue;
            }
            let part = minimum / projects.len() as u64;
            for project in projects {
                let theirs: Vec<&Candidate> = rows
                    .iter()
                    .copied()
                    .filter(|c| c.source_project.as_deref() == project)
                    .collect();
                fill.take(&theirs, part);
            }
        } else {
            fill.take(&rows, *minimum);
        }
    }
    // 3. The free pool, across every level.
    fill.take(&order, u64::MAX);
    fill.selection(&order)
}

/// Rows not hidden by time, resolution or an override.
fn visible(candidates: &[Candidate], now_ms: i64) -> Vec<&Candidate> {
    let live: Vec<&Candidate> = candidates
        .iter()
        .filter(|c| match c.decay {
            Decay::Bounded => c.expires_at_ms.is_none_or(|end| now_ms < end),
            Decay::OpenUntilResolved => !c.resolved,
            Decay::Stable | Decay::Drifting => true,
        })
        .collect();
    let overridden: HashSet<i64> = live.iter().filter_map(|c| c.overrides).collect();
    live.into_iter()
        .filter(|c| !overridden.contains(&c.id))
        .collect()
}

fn rank(candidate: &Candidate, half_life_ms: i64, now_ms: i64) -> f64 {
    let importance = candidate
        .importance
        .map_or(UNSET_IMPORTANCE, |value| value.clamp(0, 100) as f64);
    let freshness = match candidate.decay {
        Decay::Drifting if half_life_ms > 0 => {
            let since = candidate.last_met_ms.map_or(0, |met| (now_ms - met).max(0));
            0.5_f64.powf(since as f64 / half_life_ms as f64)
        }
        _ => 1.0,
    };
    importance * freshness
}

/// The running admission: what is shown so far and what it costs, with
/// category tags and block wrappers paid once.
struct Fill {
    total: u64,
    used: u64,
    shown: HashSet<i64>,
    categories: HashSet<(Level, String)>,
    blocks: HashSet<Level>,
}

impl Fill {
    fn new(total: u64) -> Self {
        Self {
            total,
            used: 0,
            shown: HashSet::new(),
            categories: HashSet::new(),
            blocks: HashSet::new(),
        }
    }

    /// The tokens showing `candidate` would add now.
    fn cost(&self, candidate: &Candidate) -> u64 {
        let mut cost = candidate.line_tokens;
        if !self
            .categories
            .contains(&(candidate.level, candidate.category.clone()))
        {
            cost += candidate.category_tokens;
        }
        if !self.blocks.contains(&candidate.level) {
            cost += candidate.block_tokens;
        }
        cost
    }

    /// Show rows in order while they fit both `slice` (the tokens this pass
    /// may spend) and the total, skipping one that doesn't fit.
    fn take(&mut self, rows: &[&Candidate], slice: u64) {
        let mut spent = 0u64;
        for row in rows {
            if self.shown.contains(&row.id) {
                continue;
            }
            let cost = self.cost(row);
            if spent.saturating_add(cost) > slice || self.used.saturating_add(cost) > self.total {
                continue;
            }
            spent += cost;
            self.used += cost;
            self.shown.insert(row.id);
            self.categories.insert((row.level, row.category.clone()));
            self.blocks.insert(row.level);
        }
    }

    /// The shown ids in rank order.
    fn selection(&self, order: &[&Candidate]) -> Selection {
        Selection {
            ids: order
                .iter()
                .filter(|c| self.shown.contains(&c.id))
                .map(|c| c.id)
                .collect(),
            tokens: self.used,
        }
    }
}

/// Count how full each level's minimum ran, for the simulation that sets
/// the shares: the tokens each level's selected rows use.
pub fn level_tokens(candidates: &[Candidate], selection: &Selection) -> HashMap<Level, u64> {
    let shown: HashSet<i64> = selection.ids.iter().copied().collect();
    let mut tokens = HashMap::new();
    for candidate in candidates.iter().filter(|c| shown.contains(&c.id)) {
        *tokens.entry(candidate.level).or_insert(0) += candidate.line_tokens;
    }
    tokens
}

#[cfg(test)]
#[path = "memory_render_tests.rs"]
mod tests;
