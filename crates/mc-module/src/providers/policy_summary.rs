//! Bounded channel-1 policy for host hooks.
//!
//! A host hook needs the same channel-1 inputs a full engine pass derives from
//! every policy part of the conversation lineage: the tail-hygiene baseline and
//! token buckets, the real-user count, the reclaimable tool-output count and the
//! oldest reclaimable hint. `transform::channel1_inputs_from_parts` computes them
//! from the complete part list. That list grows with the session, so each
//! conversation also keeps a `PolicySummary`: the per-part sums those inputs are
//! made of, plus the small structures that decide which parts are protected
//! (the tool-tag protection window and the protected tool arcs) and the
//! smallest hint candidates per tool tier.
//!
//! The store logs every policy row that changes while a summary exists, keeping
//! the row's copy from when the summary was taken. A hook replays only those
//! rows and the parts whose derived measurement they can affect: parts sharing
//! a tool arc or a tag number with a changed part, parts entering or leaving the
//! protection window or a protected arc, and parts crossing the window cutoff.
//! For each such part it subtracts the contribution computed from the old copies
//! and adds the one computed from the current rows. Anything the replay cannot
//! account for exactly (a new lineage, changed settings, a cache-busting pass, a
//! baseline that must be refrozen, rows inserted before the newest part, an
//! overlong change log) rebuilds the summary from all parts instead, so the
//! result always equals the full computation.
use crate::selection::{
    default_protected_tools, is_reclaim_hint_excluded_tool, normalize_tool_name, resolve_tool_tier,
    AGE_RECLAIM_MIN_TOKENS,
};
use crate::transform::{self, Channel1PolicyInputs};
use mc_store::provider_records::{
    ProviderError, ProviderPolicyChange, ProviderPolicyIndex, ProviderPolicyPart,
};
use mc_store::{TailHygieneBaseline, TailHygienePartKind, TailHygienePartMeasurement};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// When more than this many policy rows changed since the summary was taken,
/// rebuild it from every part instead of replaying the changes.
const CHANGE_CAP: usize = 4096;
/// Bound on parts read while propagating changes or refilling hint candidates.
const READ_CAP: usize = 8192;
const HINT_SLOTS: usize = 4;

/// A part's position in the lineage order used by the full computation.
type PartKey = (u64, i64);

fn part_key(part: &ProviderPolicyPart) -> PartKey {
    (part.ordinal, part.block_index)
}

/// What one part adds to the summary's sums.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
struct Totals {
    tools_t: i64,
    tools_u: i64,
    prose_t: i64,
    prose_u: i64,
    nonheader: i64,
    users: i64,
    /// Frozen baseline parts whose current measurement no longer matches.
    base_mismatch: i64,
    base_advance_u: i64,
    base_queued_u: i64,
    base_tool_outputs: i64,
    turn_t: i64,
    turn_u: i64,
}

impl Totals {
    fn apply(&mut self, delta: &Totals, sign: i64) -> Option<()> {
        let add = |a: &mut i64, b: i64| -> Option<()> {
            *a = a.checked_add(b.checked_mul(sign)?)?;
            Some(())
        };
        add(&mut self.tools_t, delta.tools_t)?;
        add(&mut self.tools_u, delta.tools_u)?;
        add(&mut self.prose_t, delta.prose_t)?;
        add(&mut self.prose_u, delta.prose_u)?;
        add(&mut self.nonheader, delta.nonheader)?;
        add(&mut self.users, delta.users)?;
        add(&mut self.base_mismatch, delta.base_mismatch)?;
        add(&mut self.base_advance_u, delta.base_advance_u)?;
        add(&mut self.base_queued_u, delta.base_queued_u)?;
        add(&mut self.base_tool_outputs, delta.base_tool_outputs)?;
        add(&mut self.turn_t, delta.turn_t)?;
        add(&mut self.turn_u, delta.turn_u)
    }

    /// The full computation accumulates with saturating adds. The sums here
    /// match it only while no partial sum could have saturated.
    fn bounded(&self) -> bool {
        const LIMIT: i64 = i64::MAX / 4;
        [
            self.tools_t,
            self.tools_u,
            self.prose_t,
            self.prose_u,
            self.base_advance_u,
            self.base_queued_u,
            self.turn_t,
            self.turn_u,
        ]
        .iter()
        .all(|v| v.abs() < LIMIT)
    }
}

/// One tag-number group of served tool-result tags inside the protection window.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
struct WindowGroup {
    mass: u64,
    rows: u64,
}

/// Ranking key of a protected tool arc: newest result position first.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
struct ArcRank {
    ordinal: u64,
    index: usize,
    arc: String,
}

/// A hint candidate, ordered as the full computation orders equal tiers.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
struct HintEntry {
    number: i64,
    key: PartKey,
    tool: String,
}

/// The smallest candidates of one tool tier. `complete` means no other
/// candidate of the tier exists.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
struct HintTier {
    entries: Vec<HintEntry>,
    complete: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct PolicySummary {
    /// Inputs the summary depends on beyond the policy rows; see `summary_key`.
    key: String,
    totals: Totals,
    /// Greatest part position in the lineage; new rows must sort after it.
    max_key: Option<PartKey>,
    /// Position of the first non-header part outside the frozen baseline.
    baseline_end: Option<PartKey>,
    /// Groups at or above the cutoff: exactly the protection window.
    window: BTreeMap<i64, WindowGroup>,
    /// Whether served tool-result tags exist below the window.
    window_below: bool,
    cutoff: Option<i64>,
    /// Per normalized tool name, its newest eligible arcs (at most its keep count).
    protected: BTreeMap<String, Vec<ArcRank>>,
    hint: BTreeMap<u8, HintTier>,
}

/// The engine settings and host configuration a summary is computed under,
/// resolved exactly as `transform::channel1_inputs_from_parts` resolves them.
#[derive(Clone)]
struct Settings {
    coverage: Option<u64>,
    floor: u64,
    tools_ratio: f64,
    /// Normalized tool name to the number of its newest arcs kept protected.
    keep: BTreeMap<String, usize>,
    /// The frozen baseline, without its part list.
    previous: Option<TailHygieneBaseline>,
    baseline_len: usize,
}

impl Settings {
    fn resolve(
        engine_policy: &Value,
        protected_floor: u64,
        protected_tools: &BTreeMap<String, usize>,
        cache_busting: bool,
        model_key: Option<&str>,
    ) -> Self {
        let frozen = engine_policy.get("calibration").and_then(|v| {
            serde_json::from_value::<mc_store::FrozenDecisionCalibration>(v.clone()).ok()
        });
        let calibration =
            transform::calibration_for_prefix_pass(model_key, frozen.as_ref(), cache_busting);
        let counts = engine_policy
            .get("protected_tools")
            .and_then(|v| serde_json::from_value::<BTreeMap<String, usize>>(v.clone()).ok())
            .unwrap_or_else(|| protected_tools.clone());
        let mut keep = default_protected_tools();
        for (name, count) in &counts {
            keep.insert(normalize_tool_name(name), *count);
        }
        let mut previous = engine_policy
            .get("baseline")
            .and_then(|v| serde_json::from_value::<TailHygieneBaseline>(v.clone()).ok());
        if let Some(previous) = previous.as_mut() {
            previous.baseline_parts.clear();
        }
        Self {
            coverage: engine_policy.get("coverage").and_then(Value::as_u64),
            floor: engine_policy
                .get("protected_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(protected_floor),
            tools_ratio: calibration.tools_ratio,
            keep,
            previous,
            baseline_len: engine_policy
                .get("baseline_len")
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize,
        }
    }

    /// Everything besides the policy rows that a summary's contents depend on.
    fn key(&self, ancestry: &[(String, u64)]) -> String {
        serde_json::json!([
            ancestry,
            self.coverage,
            self.floor,
            self.tools_ratio.to_bits(),
            self.keep,
            self.previous.as_ref().map(|b| b.baseline_generation),
            self.baseline_len,
        ])
        .to_string()
    }

    fn tail(&self, part: &ProviderPolicyPart) -> bool {
        transform::is_tail(part.ordinal, self.coverage)
    }
}

/// The protection window, protected arcs and cutoff a part is judged against.
struct Protection<'a> {
    window: &'a BTreeMap<i64, WindowGroup>,
    arcs: &'a BTreeSet<String>,
    cutoff: Option<i64>,
}

/// Lookups a part's measurement needs from other parts: the tag number each
/// arc's output carries and which tag numbers are queued for release.
#[derive(Default)]
struct Neighbours {
    output: HashMap<String, Option<i64>>,
    queued: BTreeSet<i64>,
}

impl Neighbours {
    /// Build from every part that shares an arc or a tag number with the parts
    /// being measured. Parts must be in lineage order: the last active tool
    /// result of an arc supplies its number, as in the full computation.
    fn from_parts<'p>(parts: impl IntoIterator<Item = &'p ProviderPolicyPart>) -> Self {
        let mut neighbours = Self::default();
        for part in parts {
            if let Some(arc) = &part.arc_id {
                let slot = neighbours.output.entry(arc.clone()).or_insert(None);
                if part.tag_kind.as_deref() == Some("tool_result") && part.active {
                    if let Some(number) = part.tag_number {
                        *slot = Some(number);
                    }
                }
            }
            if part.queued {
                if let Some(number) = part.tag_number {
                    neighbours.queued.insert(number);
                }
            }
        }
        neighbours
    }

    fn number(&self, part: &ProviderPolicyPart) -> Option<i64> {
        if part.tag_kind.is_some() {
            part.tag_number.filter(|_| part.active)
        } else {
            part.arc_id
                .as_ref()
                .and_then(|arc| self.output.get(arc).copied().flatten())
        }
    }
}

/// The measurement `channel1_inputs_from_parts` derives for a non-header part.
fn measure(
    part: &ProviderPolicyPart,
    settings: &Settings,
    protection: &Protection<'_>,
    neighbours: &Neighbours,
) -> TailHygienePartMeasurement {
    let mut m = part.measurement.clone();
    let number = neighbours.number(part);
    m.tag_number = number;
    m.tag_status = number.map(|_| "active".into());
    m.protected = number.is_some_and(|n| protection.window.contains_key(&n))
        || part
            .arc_id
            .as_ref()
            .is_some_and(|arc| protection.arcs.contains(arc));
    m.queued_for_drop = number.is_some_and(|n| neighbours.queued.contains(&n));
    if part.reduced || !settings.tail(part) {
        m.tokens = 0;
        m.kind = TailHygienePartKind::Excluded;
    }
    m.u_tokens = if number.is_some() && !m.protected && !m.queued_for_drop {
        m.tokens
    } else {
        0
    };
    m
}

/// Where a part sits relative to the frozen baseline.
enum Baseline<'a> {
    /// Compared against this frozen measurement.
    Frozen(&'a TailHygienePartMeasurement),
    /// After the frozen prefix: counted in this pass's delta.
    After,
}

/// One part's contribution to the summary sums.
fn contribution(
    part: &ProviderPolicyPart,
    baseline: Baseline<'_>,
    settings: &Settings,
    protection: &Protection<'_>,
    neighbours: &Neighbours,
) -> Totals {
    let mut totals = Totals::default();
    if part.kind == "header" {
        totals.users = i64::from(part.real_user);
        return totals;
    }
    let m = measure(part, settings, protection, neighbours);
    totals.nonheader = 1;
    let (tail, reclaimable) = (m.tokens.max(0), m.u_tokens.max(0));
    match m.kind {
        TailHygienePartKind::ToolInput | TailHygienePartKind::ToolOutput => {
            totals.tools_t = tail;
            totals.tools_u = reclaimable;
        }
        TailHygienePartKind::Text | TailHygienePartKind::File => {
            totals.prose_t = tail;
            totals.prose_u = reclaimable;
        }
        TailHygienePartKind::Excluded => {}
    }
    match baseline {
        Baseline::Frozen(before) => {
            if crate::tail_hygiene::compared_field(before, &m).is_some() {
                totals.base_mismatch = 1;
            } else if before.protected && !m.protected {
                totals.base_advance_u = m.u_tokens;
            } else if before.queued_for_drop != m.queued_for_drop {
                totals.base_queued_u = m.u_tokens.saturating_sub(before.u_tokens);
            }
            if before.kind == TailHygienePartKind::ToolOutput && before.u_tokens > 0 {
                totals.base_tool_outputs = 1;
            }
        }
        Baseline::After => {
            totals.turn_t = m.tokens;
            if m.kind != TailHygienePartKind::ToolOutput || !m.protected {
                totals.turn_u = m.u_tokens;
            }
        }
    }
    totals
}

/// A part's hint candidacy: its tool tier and entry.
fn candidate(
    part: &ProviderPolicyPart,
    settings: &Settings,
    protection: &Protection<'_>,
    neighbours: &Neighbours,
) -> Option<(u8, HintEntry)> {
    let number = part.tag_number?;
    (part.tag_kind.as_deref() == Some("tool_result")
        && part.active
        && !part.reduced
        && settings.tail(part)
        && !neighbours.queued.contains(&number)
        && part.tag_tokens >= AGE_RECLAIM_MIN_TOKENS as i64
        && !is_reclaim_hint_excluded_tool(&part.tool_name)
        && protection.cutoff.is_none_or(|cutoff| number < cutoff))
    .then(|| {
        (
            resolve_tool_tier(&part.tool_name),
            HintEntry {
                number,
                key: part_key(part),
                tool: part.tool_name.clone(),
            },
        )
    })
}

/// A served tool-result tag counted by the protection window: (number, mass).
fn window_member(part: &ProviderPolicyPart) -> Option<(i64, u64)> {
    (part.served && part.tag_kind.as_deref() == Some("tool_result"))
        .then_some(part.tag_number)
        .flatten()
        .map(|number| (number, u64::try_from(part.tag_tokens).unwrap_or(0)))
}

/// `ProtectionWindow::from_persisted_rows_calibrated`'s cutoff over tag-number
/// groups. `below` says groups exist under the lowest one given; a walk that
/// would need them returns `Err`.
fn window_cutoff(
    groups: &BTreeMap<i64, WindowGroup>,
    below: bool,
    floor: u64,
    tools_ratio: f64,
) -> Result<Option<i64>, ()> {
    let groups = groups
        .iter()
        .filter(|(_, g)| g.rows > 0)
        .collect::<Vec<_>>();
    if groups.is_empty() {
        return if below { Err(()) } else { Ok(None) };
    }
    let mut cumulative = 0u64;
    let mut mass_cutoff = None;
    let mut structural = None;
    let mut count = 0usize;
    for (index, (number, group)) in groups.iter().enumerate().rev() {
        let bottom = index == 0 && !below;
        cumulative = cumulative.saturating_add(group.mass);
        count += 1;
        if count <= 3 {
            structural = Some(**number);
        }
        if mass_cutoff.is_none()
            && ((cumulative as f64 * tools_ratio).ceil() >= floor as f64 || bottom)
        {
            mass_cutoff = Some(**number);
        }
        if mass_cutoff.is_some() && (count >= 3 || bottom) {
            return Ok(match (mass_cutoff, structural) {
                (Some(mass), Some(minimum)) => Some(mass.min(minimum)),
                (mass, minimum) => mass.or(minimum),
            });
        }
    }
    Err(())
}

/// Per arc, what `protected_tool_arc_ids` needs: its normalized name, rank and
/// whether it is eligible (has a result and no reduced result). Only tail,
/// non-header parts are selection items.
fn arc_ranks<'p>(
    parts: impl IntoIterator<Item = &'p ProviderPolicyPart>,
    settings: &Settings,
) -> BTreeMap<String, (String, ArcRank, bool)> {
    struct Acc {
        name: String,
        rank: (u64, usize),
        results: bool,
        reduced: bool,
    }
    let mut arcs: BTreeMap<String, Acc> = BTreeMap::new();
    for part in parts {
        let Some(arc) = &part.arc_id else { continue };
        if part.kind == "header" || !settings.tail(part) {
            continue;
        }
        let acc = arcs.entry(arc.clone()).or_insert(Acc {
            name: String::new(),
            rank: (0, 0),
            results: false,
            reduced: false,
        });
        match part.kind.as_str() {
            "tool_call" => acc.name = normalize_tool_name(&part.tool_name),
            "tool_result" => {
                if acc.name.is_empty() {
                    acc.name = normalize_tool_name(&part.tool_name);
                }
                let index = part
                    .block_id
                    .rsplit_once('#')
                    .and_then(|(_, index)| index.parse::<usize>().ok())
                    .unwrap_or(0);
                acc.rank = acc.rank.max((part.ordinal, index));
                acc.results = true;
                acc.reduced |= part.reduced;
            }
            _ => {}
        }
    }
    arcs.into_iter()
        .map(|(arc, acc)| {
            let rank = ArcRank {
                ordinal: acc.rank.0,
                index: acc.rank.1,
                arc: arc.clone(),
            };
            (arc, (acc.name, rank, acc.results && !acc.reduced))
        })
        .collect()
}

fn protected_set(protected: &BTreeMap<String, Vec<ArcRank>>) -> BTreeSet<String> {
    protected
        .values()
        .flatten()
        .map(|rank| rank.arc.clone())
        .collect()
}

/// Insert an eligible arc into its name's newest-first list, keeping `keep`.
fn insert_arc(list: &mut Vec<ArcRank>, rank: ArcRank, keep: usize) {
    let at = list.partition_point(|held| held > &rank);
    list.insert(at, rank);
    list.truncate(keep);
}

fn merged_hint(hint: &BTreeMap<u8, HintTier>) -> Vec<(i64, String)> {
    hint.iter()
        .rev()
        .flat_map(|(_, tier)| tier.entries.iter())
        .take(HINT_SLOTS)
        .map(|entry| (entry.number, entry.tool.clone()))
        .collect()
}

/// Build a summary from every effective part, in lineage order. `frozen` is the
/// baseline a freezing pass is about to store for the first non-header parts.
fn build(
    parts: &[ProviderPolicyPart],
    settings: &Settings,
    key: String,
    frozen: Option<&[TailHygienePartMeasurement]>,
) -> Option<PolicySummary> {
    let mut groups: BTreeMap<i64, WindowGroup> = BTreeMap::new();
    for (number, mass) in parts.iter().filter_map(window_member) {
        let group = groups.entry(number).or_default();
        group.mass = group.mass.saturating_add(mass);
        group.rows += 1;
    }
    let cutoff = window_cutoff(&groups, false, settings.floor, settings.tools_ratio).ok()?;
    let window_below = cutoff.is_some_and(|cutoff| groups.range(..cutoff).next().is_some());
    let window = match cutoff {
        Some(cutoff) => groups.split_off(&cutoff),
        None => BTreeMap::new(),
    };
    let mut protected: BTreeMap<String, Vec<ArcRank>> = BTreeMap::new();
    let mut eligible = arc_ranks(parts, settings)
        .into_values()
        .filter(|(name, _, ok)| *ok && settings.keep.get(name).is_some_and(|k| *k > 0))
        .collect::<Vec<_>>();
    eligible.sort_by(|a, b| b.1.cmp(&a.1));
    for (name, rank, _) in eligible {
        let keep = settings.keep[&name];
        let list = protected.entry(name).or_default();
        if list.len() < keep {
            list.push(rank);
        }
    }
    let arcs = protected_set(&protected);
    let protection = Protection {
        window: &window,
        arcs: &arcs,
        cutoff,
    };
    let neighbours = Neighbours::from_parts(parts);
    let baseline_len = frozen.map_or(settings.baseline_len, <[_]>::len);
    let mut totals = Totals::default();
    let mut baseline_end = None;
    let mut rank = 0usize;
    let mut candidates: BTreeMap<u8, Vec<HintEntry>> = BTreeMap::new();
    for part in parts {
        let place = if part.kind == "header" {
            Baseline::After
        } else {
            let place = if rank < baseline_len {
                Baseline::Frozen(frozen.map_or(&part.measurement, |frozen| &frozen[rank]))
            } else {
                if rank == baseline_len {
                    baseline_end = Some(part_key(part));
                }
                Baseline::After
            };
            rank += 1;
            place
        };
        let delta = contribution(part, place, settings, &protection, &neighbours);
        totals.apply(&delta, 1)?;
        if let Some((tier, entry)) = candidate(part, settings, &protection, &neighbours) {
            candidates.entry(tier).or_default().push(entry);
        }
    }
    let hint = candidates
        .into_iter()
        .map(|(tier, mut entries)| {
            entries.sort();
            let complete = entries.len() <= HINT_SLOTS;
            entries.truncate(HINT_SLOTS);
            (tier, HintTier { entries, complete })
        })
        .collect();
    Some(PolicySummary {
        key,
        totals,
        max_key: parts.last().map(part_key),
        baseline_end,
        window,
        window_below,
        cutoff,
        protected,
        hint,
    })
}

/// The channel-1 inputs a summary stands for on a pass that keeps the frozen
/// baseline: the valid-prefix branch of the tail-hygiene refresh. `None` when
/// that pass would refreeze the baseline instead.
fn inputs_from_summary(
    summary: &PolicySummary,
    settings: &Settings,
    carrier: bool,
) -> Option<Channel1PolicyInputs> {
    let previous = settings.previous.as_ref()?;
    let totals = &summary.totals;
    if !totals.bounded()
        || totals.base_mismatch != 0
        || totals.nonheader < settings.baseline_len as i64
    {
        return None;
    }
    let baseline = TailHygieneBaseline {
        turn_delta_u: totals
            .base_advance_u
            .checked_add(totals.base_queued_u)?
            .checked_add(totals.turn_u)?,
        turn_delta_t: totals.turn_t,
        hygiene_units_version: previous.hygiene_units_version.max(1),
        hygiene_tools_ratio: previous.hygiene_tools_ratio,
        hygiene_prose_ratio: previous.hygiene_prose_ratio,
        effective_token_buckets: mc_store::TailHygieneTokenBuckets {
            tools_t: totals.tools_t,
            prose_t: totals.prose_t,
            tools_u: totals.tools_u,
            prose_u: totals.prose_u,
        },
        evaluable: true,
        generation_invalidated: false,
        content_signature: String::new(),
        ..previous.clone()
    };
    Some(Channel1PolicyInputs {
        baseline,
        users: u64::try_from(totals.users).ok()?,
        tool_outputs: usize::try_from(totals.base_tool_outputs).ok()?,
        hint: merged_hint(&summary.hint),
        carrier,
    })
}

/// The two states a replay compares: each affected part as the summary saw it
/// and as it is now.
struct Views {
    /// Changed blocks: their copy when the summary was taken (`None` if new).
    previous: HashMap<String, Option<ProviderPolicyPart>>,
    /// Every affected part as it is now, by block id.
    current: BTreeMap<String, ProviderPolicyPart>,
}

impl Views {
    fn old(&self, block: &str) -> Option<&ProviderPolicyPart> {
        match self.previous.get(block) {
            Some(previous) => previous.as_ref(),
            None => self.current.get(block),
        }
    }

    fn sorted<'a>(
        parts: impl Iterator<Item = &'a ProviderPolicyPart>,
    ) -> Vec<&'a ProviderPolicyPart> {
        let mut parts = parts.collect::<Vec<_>>();
        parts.sort_by_key(|part| part_key(part));
        parts
    }

    fn old_parts(&self) -> Vec<&ProviderPolicyPart> {
        Self::sorted(
            self.current
                .keys()
                .filter_map(|block| self.old(block))
                .chain(
                    self.previous
                        .iter()
                        .filter(|(block, _)| !self.current.contains_key(*block))
                        .filter_map(|(_, part)| part.as_ref()),
                ),
        )
    }

    fn new_parts(&self) -> Vec<&ProviderPolicyPart> {
        Self::sorted(self.current.values())
    }

    fn add(&mut self, parts: Vec<ProviderPolicyPart>) {
        for part in parts {
            self.current.entry(part.block_id.clone()).or_insert(part);
        }
    }
}

/// Bring a summary up to date with the logged changes. `Ok(None)` means the
/// changes cannot be replayed exactly and the caller must rebuild.
fn replay(
    index: &ProviderPolicyIndex<'_>,
    summary: PolicySummary,
    settings: &Settings,
) -> Result<Option<PolicySummary>, ProviderError> {
    let Some(changes) = index.changes(CHANGE_CAP)? else {
        return Ok(None);
    };
    if changes.is_empty() {
        return Ok(Some(summary));
    }
    let mut views = Views {
        previous: HashMap::new(),
        current: BTreeMap::new(),
    };
    let mut inserted = Vec::new();
    for ProviderPolicyChange {
        block_id,
        previous,
        current,
        shadows,
    } in changes
    {
        if shadows {
            return Ok(None);
        }
        match (&previous, &current) {
            (None, Some(current)) => {
                // A row sorting before the newest known part would shift the
                // positions that decide which parts the frozen baseline covers.
                if summary.max_key.is_some_and(|max| part_key(current) <= max) {
                    return Ok(None);
                }
                inserted.push(current.clone());
            }
            (Some(old), Some(new)) if part_key(old) == part_key(new) => {}
            _ => return Ok(None),
        }
        if let Some(current) = current {
            views.current.insert(block_id.clone(), current);
        }
        views.previous.insert(block_id, previous);
    }
    let changed: Vec<String> = views.previous.keys().cloned().collect();

    // The tool-tag protection window (the newest served tool-result tags whose
    // mass reaches the protected-token floor): move each changed row's tag from
    // its old group to its current one, then recompute the cutoff.
    let mut groups = summary.window.clone();
    let mut below = summary.window_below;
    for block in &changed {
        if let Some((number, mass)) = views.old(block).and_then(window_member) {
            if summary.cutoff.is_none_or(|cutoff| number < cutoff) {
                return Ok(None);
            }
            let Some(group) = groups.get_mut(&number) else {
                return Ok(None);
            };
            let (Some(mass), Some(rows)) =
                (group.mass.checked_sub(mass), group.rows.checked_sub(1))
            else {
                return Ok(None);
            };
            *group = WindowGroup { mass, rows };
        }
        if let Some((number, mass)) = views.current.get(block).and_then(window_member) {
            if !below || summary.cutoff.is_none_or(|cutoff| number >= cutoff) {
                let group = groups.entry(number).or_default();
                group.mass = group.mass.saturating_add(mass);
                group.rows += 1;
            }
        }
    }
    let Ok(cutoff) = window_cutoff(&groups, below, settings.floor, settings.tools_ratio) else {
        return Ok(None);
    };
    groups.retain(|_, group| group.rows > 0);
    let window = match cutoff {
        Some(cutoff) => {
            below |= groups.range(..cutoff).next().is_some();
            groups.split_off(&cutoff)
        }
        None => BTreeMap::new(),
    };
    let window_moved: BTreeSet<i64> = summary
        .window
        .iter()
        .filter(|(_, g)| g.rows > 0)
        .map(|(n, _)| *n)
        .collect::<BTreeSet<_>>()
        .symmetric_difference(&window.keys().copied().collect())
        .copied()
        .collect();

    // Protected tool arcs (the newest arcs of each keep-protected tool name):
    // re-rank every arc a changed row belonged to or now belongs to.
    let touched: BTreeSet<String> = changed
        .iter()
        .flat_map(|block| [views.old(block), views.current.get(block)])
        .flatten()
        .filter_map(|part| part.arc_id.clone())
        .collect();
    views.add(index.parts_with_arcs(&touched)?);
    let old_ranks = arc_ranks(views.old_parts(), settings);
    let new_ranks = arc_ranks(views.new_parts(), settings);
    let mut protected = summary.protected.clone();
    let floor_of = |list: &Vec<ArcRank>| list.last().cloned();
    let before: BTreeMap<String, (usize, Option<ArcRank>)> = protected
        .iter()
        .map(|(name, list)| (name.clone(), (list.len(), floor_of(list))))
        .collect();
    let eligible = |name: &str, ok: bool| ok && settings.keep.get(name).is_some_and(|k| *k > 0);
    for arc in &touched {
        if let Some((name, _, ok)) = old_ranks.get(arc) {
            if eligible(name, *ok) {
                if let Some(list) = protected.get_mut(name) {
                    list.retain(|rank| &rank.arc != arc);
                }
            }
        }
    }
    for arc in &touched {
        if let Some((name, rank, ok)) = new_ranks.get(arc) {
            if eligible(name, *ok) {
                insert_arc(
                    protected.entry(name.clone()).or_default(),
                    rank.clone(),
                    settings.keep[name],
                );
            }
        }
    }
    for (name, list) in &protected {
        let keep = settings.keep.get(name).copied().unwrap_or(0);
        let Some((held, Some(lowest))) = before.get(name) else {
            continue;
        };
        // A list holding its whole keep count tracks only the newest arcs. If it
        // lost one, or gained one ranked below its previous lowest, an older arc
        // that was never tracked may belong in it: rebuild instead.
        if *held == keep && (list.len() < keep || list.iter().any(|rank| rank < lowest)) {
            return Ok(None);
        }
    }
    protected.retain(|_, list| !list.is_empty());
    let arcs_before = protected_set(&summary.protected);
    let arcs_after = protected_set(&protected);
    let arcs_moved: BTreeSet<String> = arcs_before
        .symmetric_difference(&arcs_after)
        .cloned()
        .collect();

    // Parts whose derived measurement can differ: changed rows, parts whose tag
    // entered or left the protection window, members of arcs that became or
    // stopped being protected, parts whose tag number moved across the window
    // cutoff (hint eligibility), and every part sharing an arc or a tag number
    // with any of those.
    let mut loaded_numbers = window_moved.clone();
    views.add(index.parts_with_tag_numbers(&window_moved)?);
    let mut loaded_arcs = touched.clone();
    loaded_arcs.extend(arcs_moved.iter().cloned());
    views.add(index.parts_with_arcs(&arcs_moved)?);
    if summary.cutoff != cutoff {
        let (Some(old), Some(new)) = (summary.cutoff, cutoff) else {
            return Ok(None);
        };
        let Some(crossing) = index.parts_with_tag_range(old.min(new), old.max(new), READ_CAP)?
        else {
            return Ok(None);
        };
        loaded_numbers.extend(crossing.iter().filter_map(|part| part.tag_number));
        views.add(crossing);
    }
    loop {
        let mut arcs = BTreeSet::new();
        let mut numbers = BTreeSet::new();
        for block in views.current.keys().chain(views.previous.keys()) {
            for part in [views.old(block), views.current.get(block)]
                .into_iter()
                .flatten()
            {
                arcs.extend(part.arc_id.clone());
                numbers.extend(part.tag_number);
            }
        }
        let arcs: BTreeSet<String> = arcs.difference(&loaded_arcs).cloned().collect();
        let numbers: BTreeSet<i64> = numbers.difference(&loaded_numbers).copied().collect();
        if arcs.is_empty() && numbers.is_empty() {
            break;
        }
        views.add(index.parts_with_arcs(&arcs)?);
        views.add(index.parts_with_tag_numbers(&numbers)?);
        loaded_arcs.extend(arcs);
        loaded_numbers.extend(numbers);
        if views.current.len() > READ_CAP {
            return Ok(None);
        }
    }

    let old_neighbours = Neighbours::from_parts(views.old_parts());
    let new_neighbours = Neighbours::from_parts(views.new_parts());
    let old_protection = Protection {
        window: &summary.window,
        arcs: &arcs_before,
        cutoff: summary.cutoff,
    };
    let new_protection = Protection {
        window: &window,
        arcs: &arcs_after,
        cutoff,
    };
    let in_frozen =
        |part: &ProviderPolicyPart| summary.baseline_end.is_none_or(|end| part_key(part) < end);
    // New rows sort after every known part, so their baseline position is their
    // rank among non-header parts.
    inserted.sort_by_key(part_key);
    let mut baseline_end = summary.baseline_end;
    let mut rank = usize::try_from(summary.totals.nonheader).unwrap_or(usize::MAX);
    let mut inserted_frozen: HashMap<&str, bool> = HashMap::new();
    for part in inserted.iter().filter(|part| part.kind != "header") {
        if rank == settings.baseline_len {
            baseline_end = Some(part_key(part));
        }
        inserted_frozen.insert(part.block_id.as_str(), rank < settings.baseline_len);
        rank = rank.saturating_add(1);
    }
    let blocks: BTreeSet<String> = views
        .current
        .keys()
        .chain(views.previous.keys())
        .cloned()
        .collect();
    let mut totals = summary.totals;
    for block in &blocks {
        if let Some(old) = views.old(block) {
            let place = if old.kind != "header" && in_frozen(old) {
                Baseline::Frozen(&old.measurement)
            } else {
                Baseline::After
            };
            let delta = contribution(old, place, settings, &old_protection, &old_neighbours);
            if totals.apply(&delta, -1).is_none() {
                return Ok(None);
            }
        }
        if let Some(new) = views.current.get(block) {
            let frozen = match inserted_frozen.get(block.as_str()) {
                Some(frozen) => *frozen,
                None => !matches!(views.previous.get(block), Some(None)) && in_frozen(new),
            };
            let place = if new.kind != "header" && frozen {
                Baseline::Frozen(&new.measurement)
            } else {
                Baseline::After
            };
            let delta = contribution(new, place, settings, &new_protection, &new_neighbours);
            if totals.apply(&delta, 1).is_none() {
                return Ok(None);
            }
        }
    }

    // Hint candidates: drop every affected part's old candidacy, refill tiers
    // that lost a tracked candidate, then add the new candidacies.
    let mut hint = summary.hint.clone();
    let mut refill: BTreeMap<u8, HintEntry> = BTreeMap::new();
    for block in &blocks {
        let Some(old) = views.old(block) else {
            continue;
        };
        if let Some((tier, entry)) = candidate(old, settings, &old_protection, &old_neighbours) {
            if let Some(list) = hint.get_mut(&tier) {
                if let Some(at) = list.entries.iter().position(|held| held == &entry) {
                    if !list.complete {
                        let highest = list.entries.last().cloned().expect("held entry");
                        refill.entry(tier).or_insert(highest);
                    }
                    list.entries.remove(at);
                }
            }
        }
    }
    let mut additions: BTreeMap<u8, BTreeSet<HintEntry>> = BTreeMap::new();
    for part in views.current.values() {
        if let Some((tier, entry)) = candidate(part, settings, &new_protection, &new_neighbours) {
            additions.entry(tier).or_default().insert(entry);
        }
    }
    for (tier, highest) in refill {
        let list = hint.entry(tier).or_default();
        let Some((found, complete)) =
            scan_candidates(index, settings, &new_protection, tier, &highest)?
        else {
            return Ok(None);
        };
        let mut entries: BTreeSet<HintEntry> = list.entries.iter().cloned().collect();
        entries.extend(found);
        entries.extend(additions.remove(&tier).unwrap_or_default());
        let entries = entries.into_iter().collect::<Vec<_>>();
        list.complete = complete && entries.len() <= HINT_SLOTS;
        list.entries = entries.into_iter().take(HINT_SLOTS).collect();
    }
    for (tier, entries) in additions {
        let list = hint.entry(tier).or_default();
        if list.entries.is_empty() && !list.complete && !summary.hint.contains_key(&tier) {
            // A tier the summary never saw had no candidates at all.
            list.complete = true;
        }
        for entry in entries {
            if list.entries.contains(&entry) {
                continue;
            }
            if list.complete || list.entries.last().is_some_and(|highest| &entry < highest) {
                let at = list.entries.partition_point(|held| held < &entry);
                list.entries.insert(at, entry);
                if list.entries.len() > HINT_SLOTS {
                    list.entries.truncate(HINT_SLOTS);
                    list.complete = false;
                }
            }
        }
    }
    hint.retain(|_, list| !(list.entries.is_empty() && list.complete));

    Ok(Some(PolicySummary {
        key: summary.key,
        totals,
        max_key: summary.max_key.max(inserted.iter().map(part_key).max()),
        baseline_end,
        window,
        window_below: below,
        cutoff,
        protected,
        hint,
    }))
}

/// Find the smallest candidates of `tier` after `after`, in widening tag-number
/// ranges below the cutoff. Returns them and whether the scan reached the end of
/// the candidate range; `None` if that took more reads than allowed.
fn scan_candidates(
    index: &ProviderPolicyIndex<'_>,
    settings: &Settings,
    protection: &Protection<'_>,
    tier: u8,
    after: &HintEntry,
) -> Result<Option<(Vec<HintEntry>, bool)>, ProviderError> {
    let end = protection.cutoff.unwrap_or(i64::MAX);
    let mut from = after.number;
    let mut span = 256i64;
    let mut found = Vec::new();
    let mut read = 0usize;
    while from < end {
        let until = from.saturating_add(span).min(end);
        let Some(parts) = index.parts_with_tag_range(from, until, READ_CAP)? else {
            return Ok(None);
        };
        read += parts.len();
        let neighbours = Neighbours::from_parts(&parts);
        for part in &parts {
            if let Some((t, entry)) = candidate(part, settings, protection, &neighbours) {
                if t == tier && &entry > after {
                    found.push(entry);
                }
            }
        }
        if found.len() >= HINT_SLOTS {
            found.sort();
            return Ok(Some((found, false)));
        }
        if read > READ_CAP {
            return Ok(None);
        }
        from = until;
        span = span.saturating_mul(2);
    }
    found.sort();
    Ok(Some((found, true)))
}

/// Channel-1 inputs for a host hook, plus the summary to store with its write.
///
/// The inputs always equal `transform::channel1_inputs_from_parts` over the
/// whole effective lineage. A cache-busting pass, a missing or stale summary, or
/// changes that cannot be replayed exactly take the full path; a pass that
/// refreezes the baseline does too. Every other hook reads only the changed
/// rows and the parts they affect.
pub(crate) fn channel1_inputs(
    index: &ProviderPolicyIndex<'_>,
    engine_policy: &Value,
    protected_floor: u64,
    protected_tools: &BTreeMap<String, usize>,
    carrier: bool,
    cache_busting: bool,
    model_key: Option<&str>,
) -> Result<(Channel1PolicyInputs, Option<String>), ProviderError> {
    let settings = Settings::resolve(
        engine_policy,
        protected_floor,
        protected_tools,
        cache_busting,
        model_key,
    );
    let key = settings.key(index.ancestry());
    if !cache_busting && settings.previous.is_some() {
        let held = index
            .summary()?
            .and_then(|raw| serde_json::from_str::<PolicySummary>(&raw).ok())
            .filter(|summary| summary.key == key);
        if let Some(held) = held {
            if let Some(next) = replay(index, held, &settings)? {
                if let Some(inputs) = inputs_from_summary(&next, &settings, carrier) {
                    #[cfg(test)]
                    check_against_full(
                        index,
                        engine_policy,
                        protected_floor,
                        protected_tools,
                        model_key,
                        &settings,
                        &inputs,
                        &next,
                    )?;
                    let raw = serde_json::to_string(&next).expect("summary JSON");
                    return Ok((inputs, Some(raw)));
                }
            }
        }
    }
    let parts = index.all_parts()?;
    let inputs = transform::channel1_inputs_from_parts(
        &parts,
        engine_policy,
        protected_floor,
        protected_tools,
        carrier,
        cache_busting,
        model_key,
    );
    // A cache-busting pass also refreezes the calibration the next hook reads,
    // so it leaves the summary to the next ordinary hook.
    if cache_busting {
        return Ok((inputs, None));
    }
    let froze = settings
        .previous
        .as_ref()
        .map(|baseline| baseline.baseline_generation)
        != Some(inputs.baseline.baseline_generation);
    let mut next = settings.clone();
    if froze {
        // The hook stores this baseline (and its parts' measurements) with the
        // write, so the summary describes the lineage after that write.
        let mut stored = inputs.baseline.clone();
        stored.baseline_parts.clear();
        next.previous = Some(stored);
        next.baseline_len = inputs.baseline.baseline_parts.len();
    }
    let summary = build(
        &parts,
        &next,
        next.key(index.ancestry()),
        froze.then_some(inputs.baseline.baseline_parts.as_slice()),
    )
    .map(|summary| serde_json::to_string(&summary).expect("summary JSON"));
    Ok((inputs, summary))
}

#[cfg(test)]
thread_local! {
    static FULL_CHECK_OFF: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Replayed hooks checked against the full computation in this process. Corpus
/// tests read it to show they exercised the replay rather than only rebuilds.
#[cfg(test)]
static REPLAY_CHECKS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[cfg(test)]
pub(crate) fn replay_checks() -> u64 {
    REPLAY_CHECKS.load(std::sync::atomic::Ordering::Relaxed)
}

/// While held, replayed hooks on this thread skip the full-computation check,
/// so a test can measure the store reads of the replay alone.
#[cfg(test)]
pub(crate) struct FullCheckOff;

#[cfg(test)]
pub(crate) fn without_full_check() -> FullCheckOff {
    FULL_CHECK_OFF.with(|off| off.set(true));
    FullCheckOff
}

#[cfg(test)]
impl Drop for FullCheckOff {
    fn drop(&mut self) {
        FULL_CHECK_OFF.with(|off| off.set(false));
    }
}

/// Every replayed hook in tests is checked against the full computation: the
/// same channel-1 inputs and the same summary a rebuild would produce.
#[cfg(test)]
#[allow(clippy::too_many_arguments)]
fn check_against_full(
    index: &ProviderPolicyIndex<'_>,
    engine_policy: &Value,
    protected_floor: u64,
    protected_tools: &BTreeMap<String, usize>,
    model_key: Option<&str>,
    settings: &Settings,
    inputs: &Channel1PolicyInputs,
    replayed: &PolicySummary,
) -> Result<(), ProviderError> {
    // The test-built pipeline driver also serves timing runs, which opt out.
    if FULL_CHECK_OFF.with(std::cell::Cell::get)
        || std::env::var_os("MC_POLICY_SUMMARY_SKIP_FULL_CHECK").is_some()
    {
        return Ok(());
    }
    let parts = index.all_parts()?;
    let full = transform::channel1_inputs_from_parts(
        &parts,
        engine_policy,
        protected_floor,
        protected_tools,
        inputs.carrier,
        false,
        model_key,
    );
    let mut expected = full.baseline.clone();
    expected.baseline_parts.clear();
    assert_eq!(inputs.baseline, expected, "replayed channel-1 baseline");
    assert_eq!(inputs.users, full.users, "replayed real-user count");
    assert_eq!(
        inputs.tool_outputs, full.tool_outputs,
        "replayed tool outputs"
    );
    assert_eq!(inputs.hint, full.hint, "replayed reclaim hint");
    let rebuilt = build(&parts, settings, replayed.key.clone(), None).expect("rebuilt summary");
    let mut comparable = replayed.clone();
    for (tier, list) in &mut comparable.hint {
        // A replay keeps a tool tier's `complete` flag false once it has ever
        // dropped candidates, even if no others remain; a rebuild can prove
        // the tier holds all of them. Only that flag may differ.
        if rebuilt.hint.get(tier).is_some_and(|held| held.complete) {
            list.complete = true;
        }
    }
    assert_eq!(comparable, rebuilt, "replayed policy summary");
    REPLAY_CHECKS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}
