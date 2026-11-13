//! When the summarizer runs, and how far it may read: ports of the
//! TypeScript plugin's trigger (`compartment-trigger.ts`) and protected-tail
//! boundary (`protected-tail-boundary.ts`), on the runner's messages.
//!
//! The newest stretch of the conversation, the protected tail, is never
//! summarized: the model is still working with it. Its size shrinks as usage
//! grows, between a floor and a ceiling scaled by the usable window.

use cortexkit_role_compaction::part::PartBody;
use cortexkit_role_compaction::read::{Entry, Role};

/// The summarizer may start this many points below the execute threshold,
/// so a summary is ready when usage reaches it.
const PROACTIVE_OFFSET_PERCENTAGE: f64 = 2.0;
/// An early run needs this much unsummarized history, or this many messages.
const MIN_PROACTIVE_TAIL_TOKENS: u64 = 6_000;
const MIN_PROACTIVE_TAIL_MESSAGES: usize = 12;
/// Unsummarized history past this many trigger budgets starts a run at any
/// usage.
const TAIL_SIZE_MULTIPLIER: u64 = 3;

const TRIGGER_BUDGET_SHARE: f64 = 0.05;
const TRIGGER_BUDGET_MIN: u64 = 5_000;
const TRIGGER_BUDGET_MAX: u64 = 50_000;

const ALPHA: f64 = 0.3;
const FLOOR_RATIO: f64 = 0.08;
const FLOOR_MIN: u64 = 2_000;
const FLOOR_MAX: u64 = 12_000;
const ABS_CAP: u64 = 96_000;
const MAX_USABLE_RATIO: f64 = 0.4;
const RESERVED_HEADROOM_MIN: u64 = 1_000;
const RESERVED_HEADROOM_RATIO: f64 = 0.02;
/// A boundary that would leave this few tokens to summarize stays put, so a
/// one-message change in size never moves it.
const HYSTERESIS_TOKENS: u64 = 256;

/// The size-based trigger's basis: 5% of the usable window, clamped.
pub fn trigger_budget(context_window: u64, threshold_percentage: f64) -> u64 {
    let usable = context_window as f64 * threshold_percentage.max(0.0) / 100.0;
    ((usable * TRIGGER_BUDGET_SHARE).round() as u64).clamp(TRIGGER_BUDGET_MIN, TRIGGER_BUDGET_MAX)
}

/// How many of the newest tokens stay unsummarized at this usage.
pub fn protected_tail_tokens(
    context_window: u64,
    threshold_percentage: f64,
    usage_percentage: f64,
) -> u64 {
    let usable =
        ((context_window as f64 * threshold_percentage.max(0.0) / 100.0).round() as u64).max(1);
    let usage = usage_percentage.clamp(0.0, 100.0);
    let budget = trigger_budget(context_window, threshold_percentage);
    let reserve =
        RESERVED_HEADROOM_MIN.max((usable as f64 * RESERVED_HEADROOM_RATIO).round() as u64);
    let raw = (usable as f64 * ALPHA * (1.0 - usage / 100.0)).round() as u64;
    let floor = FLOOR_MAX.min(FLOOR_MIN.max((usable as f64 * FLOOR_RATIO).round() as u64));
    let headroom = (budget + reserve).min(usable / 2);
    let ceiling = 1.max(
        ABS_CAP
            .min((usable as f64 * MAX_USABLE_RATIO) as u64)
            .min(usable.saturating_sub(headroom)),
    );
    ceiling.min(floor.min(ceiling).max(raw))
}

/// Whether a user message carries the person's own words: not a notice or relay, and
/// with text left once injected regions (reminders, directives) are stripped.
pub fn is_meaningful_user(entry: &Entry) -> bool {
    let _timing = crate::notice_cost_timing::span("trigger.meaningful_user");
    entry.role == Role::User
        && entry.notice.is_none()
        && entry.speaks_for.is_none()
        && !super::chunk::is_relayed_wake(
            &entry
                .parts
                .iter()
                .filter_map(|part| match &part.body {
                    PartBody::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n"),
        )
        && entry.parts.iter().any(|part| match &part.body {
            PartBody::Text { text } => !crate::injection::strip(text)
                .as_deref()
                .unwrap_or(text)
                .trim()
                .is_empty(),
            _ => false,
        })
}

/// The first ordinal the summarizer must not read, given that everything
/// before `from` is already summarized. Returns `from` when nothing may be
/// read yet.
///
/// The tail is the newest `tail_tokens` of history, rounded out to whole
/// messages. A tool call and its result are one part, so the tail never
/// splits them; a call still running in a message older than the tail was
/// interrupted, and is summarized as it stands (the plugin treats such an
/// open call as stale). Below the force band, the newest message the user
/// wrote is in the tail: summarizing the prompt the model is answering would
/// replace it with a narration mid-turn.
pub fn tail_start(
    entries: &[Entry],
    weight: impl Fn(&Entry) -> u64,
    from: u64,
    tail_tokens: u64,
    force: bool,
) -> u64 {
    let Some(newest) = entries.last() else {
        return from;
    };
    let mut boundary = newest.ordinal + 1;
    let mut total = 0;
    for entry in entries.iter().rev() {
        if entry.ordinal < from {
            break;
        }
        boundary = entry.ordinal;
        total += weight(entry);
        if total >= tail_tokens {
            // One huge message alone over the tail stays summarizable,
            // or nothing before it could ever be read.
            if weight(entry) > (2 * tail_tokens).max(HUGE_MESSAGE_MIN_TOKENS)
                && entry.ordinal < newest.ordinal
            {
                boundary += 1;
            }
            break;
        }
    }
    boundary = semantic_snap(entries, &weight, from, boundary, tail_tokens);
    if !force {
        if let Some(prompt) = entries.iter().rev().find(|entry| is_meaningful_user(entry)) {
            if prompt.ordinal >= from {
                boundary = boundary.min(prompt.ordinal);
            }
        }
    }
    let readable: u64 = entries
        .iter()
        .filter(|entry| entry.ordinal >= from && entry.ordinal < boundary)
        .map(&weight)
        .sum();
    if readable <= HYSTERESIS_TOKENS {
        return from;
    }
    boundary.max(from)
}

/// The tail starts preferably at a message that opens a stretch of work: a
/// prompt the person wrote, or a message with a tool call. So the boundary
/// moves back to the newest such message at or before it, as the plugin's
/// `semanticSnapBoundary` does, unless that keeps more than
/// `min(1.5 × tail, 48,000)` extra tokens raw, or the message is a prompt
/// too large to keep (over `max(2 × tail, 64,000)`).
fn semantic_snap(
    entries: &[Entry],
    weight: &impl Fn(&Entry) -> u64,
    from: u64,
    boundary: u64,
    tail_tokens: u64,
) -> u64 {
    let opens_work = |entry: &Entry| {
        is_meaningful_user(entry)
            || entry
                .parts
                .iter()
                .any(|part| matches!(part.body, PartBody::Tool(_)))
    };
    let Some(snapped) = entries
        .iter()
        .filter(|entry| entry.ordinal >= from && entry.ordinal <= boundary)
        .rfind(|entry| opens_work(entry))
    else {
        return boundary;
    };
    if snapped.ordinal == boundary {
        return boundary;
    }
    let extra: u64 = entries
        .iter()
        .filter(|entry| entry.ordinal >= snapped.ordinal && entry.ordinal < boundary)
        .map(weight)
        .sum();
    let allowed = ((1.5 * tail_tokens as f64).round() as u64).min(SNAP_MAX_EXTRA_TOKENS);
    let huge_prompt = is_meaningful_user(snapped)
        && weight(snapped) > (2 * tail_tokens).max(HUGE_MESSAGE_MIN_TOKENS);
    if extra > allowed || huge_prompt {
        boundary
    } else {
        snapped.ordinal
    }
}

/// The most a semantic snap keeps raw beyond the size walk.
const SNAP_MAX_EXTRA_TOKENS: u64 = 48_000;
/// A message larger than `max(2 × tail, this)` is too large to keep raw.
const HUGE_MESSAGE_MIN_TOKENS: u64 = 64_000;

/// What decided a run, for the log.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    /// Usage is near the execute threshold.
    Proactive,
    /// The history to summarize holds several stretches of work that ended in
    /// commits.
    CommitClusters,
    /// The history to summarize is large, whatever the usage.
    TailSize,
    /// Usage is in the force band.
    Force,
}

/// A summary is not needed this pass when the drops landing on it bring
/// usage to this share of the execute threshold or below.
const POST_DROP_TARGET_RATIO: f64 = 0.75;

/// What the history the summarizer could read looks like, measured on the
/// lines it would be sent (`U:`, `A:`, `TC:`), as the plugin measures it.
#[derive(Debug, PartialEq, Eq)]
pub struct Scan {
    /// The lines' tokens, scaled to the model's tokens.
    pub tokens: u64,
    /// The lines ran past the scan's budget.
    pub has_more: bool,
    pub commit_clusters: u64,
    pub messages: usize,
    /// The history's own size, tool output included.
    pub raw_tokens: u64,
    /// Text and tool-input tokens, measured as the summary run cap measures them.
    pub removed_tokens: u64,
}

/// The usage a pass sees.
pub struct Pressure {
    pub usage: f64,
    pub threshold: f64,
    pub force: bool,
    pub usable_window: u64,
    /// Usage once the drops this pass will land have landed, when it lands
    /// any.
    pub after_drops: Option<f64>,
}

/// Whether a summarizer run should start now, in the plugin's order
/// (`compartment-trigger.ts`): the force band, then commit clusters, then
/// the history's size, then usage near the threshold. `scan` is `None` when
/// nothing may be read.
pub fn decide(
    pressure: &Pressure,
    scan: Option<&Scan>,
    trigger_budget: u64,
    commit_clusters: Option<u64>,
) -> Option<Reason> {
    let drops_suffice = pressure
        .after_drops
        .is_some_and(|after| after <= pressure.threshold * POST_DROP_TARGET_RATIO);
    if pressure.force {
        let scan = scan?;
        // Tiny force-band summaries each rewrite the prompt; wait for enough
        // text and tool input to reclaim 2% of the request's usable window.
        // ck-mc has no manual summary commands (wrapup or compartment rebuild)
        // or dedicated overflow-recovery summary path. Only notices start runs,
        // so the 95% exemption keeps recovery moving.
        let enough =
            pressure.usage >= 95.0 || scan.removed_tokens >= pressure.usable_window.div_ceil(50);
        return (!drops_suffice && enough).then_some(Reason::Force);
    }
    let scan = scan?;
    if commit_clusters.is_some_and(|min| scan.commit_clusters >= min)
        && scan.tokens >= trigger_budget
    {
        return Some(Reason::CommitClusters);
    }
    // The size trigger counts the lines, not the raw history: tool output
    // the summarizer never reads must not make it run at low usage on a
    // few large reads, each run summarizing a sliver.
    if scan.tokens >= trigger_budget * TAIL_SIZE_MULTIPLIER || (scan.has_more && scan.tokens > 0) {
        return Some(Reason::TailSize);
    }
    if pressure.usage < pressure.threshold - PROACTIVE_OFFSET_PERCENTAGE || drops_suffice {
        return None;
    }
    let meaningful = scan.has_more
        || scan.raw_tokens >= MIN_PROACTIVE_TAIL_TOKENS
        || scan.tokens >= MIN_PROACTIVE_TAIL_TOKENS
        || scan.messages >= MIN_PROACTIVE_TAIL_MESSAGES;
    meaningful.then_some(Reason::Proactive)
}

/// The scan reads at most this many model tokens of lines: enough to tell
/// whether the size trigger fires.
pub fn scan_budget(trigger_budget: u64) -> u64 {
    MIN_PROACTIVE_TAIL_TOKENS.max(trigger_budget * TAIL_SIZE_MULTIPLIER)
}

/// How much raw history one run may read: a multiple of the protected tail
/// that grows with usage (`protected-tail-boundary.ts`, `selectPerRunCap`).
pub fn per_run_cap(context_window: u64, threshold_percentage: f64, usage_percentage: f64) -> u64 {
    let usable = ((context_window as f64 * threshold_percentage / 100.0).round() as u64).max(1);
    let n = protected_tail_tokens(context_window, threshold_percentage, usage_percentage);
    let share = |ratio: f64, cap: u64| ((usable as f64 * ratio).round() as u64).min(cap);
    if usage_percentage >= 95.0 {
        (4 * n).max(share(0.5, 250_000)).min(750_000)
    } else if usage_percentage >= 80.0 {
        (3 * n).max(share(0.35, 150_000)).min(500_000)
    } else {
        (2 * n).max(share(0.25, 100_000)).min(250_000)
    }
}

/// The first ordinal past what one run may read from `from` on: the oldest
/// messages until `cap` raw tokens, at least one message.
pub fn cap_run(
    entries: &[Entry],
    weight: impl Fn(&Entry) -> u64,
    from: u64,
    until: u64,
    cap: u64,
) -> u64 {
    let mut total = 0;
    for entry in entries
        .iter()
        .filter(|entry| entry.ordinal >= from && entry.ordinal < until)
    {
        total += weight(entry);
        if total > cap && entry.ordinal > from {
            return entry.ordinal;
        }
    }
    until
}

#[cfg(test)]
mod tests {
    use super::*;
    use cortexkit_role_compaction::part::Part;
    use cortexkit_role_compaction::read::NoticeOrigin;

    fn entry(ordinal: u64, role: Role, notice: bool, text: &str) -> Entry {
        let parts = vec![Part::new(
            format!("p{ordinal}"),
            PartBody::Text { text: text.into() },
        )];
        let entry = Entry::new(ordinal, format!("m{ordinal}"), role, 0, parts);
        if notice {
            entry.with_notice(NoticeOrigin::new("x"))
        } else {
            entry
        }
    }

    #[test]
    fn speaks_for_is_neither_the_newest_prompt_nor_a_semantic_prompt_floor() {
        let mut entries: Vec<_> = (1..=10)
            .map(|n| entry(n, Role::Assistant, false, "work"))
            .collect();
        entries[6] = entry(7, Role::User, false, "head brief");
        entries[6].speaks_for =
            Some(serde_json::from_value(serde_json::json!({"agent_id":"lead-agent"})).unwrap());
        assert!(!is_meaningful_user(&entries[6]));
        assert_eq!(tail_start(&entries, |_| 1_000, 1, 2_000, false), 9);
        assert_eq!(tail_start(&entries, |_| 1_000, 1, 2_000, true), 9);
        entries[6].speaks_for = None;
        assert_eq!(tail_start(&entries, |_| 1_000, 1, 2_000, false), 7);
    }

    /// A user message holding only an injected reminder is not the person's
    /// prompt, so it does not hold the tail back.
    #[test]
    fn a_reminder_only_user_message_is_not_a_prompt() {
        assert!(is_meaningful_user(&entry(1, Role::User, false, "Do it.")));
        assert!(!is_meaningful_user(&entry(
            1,
            Role::User,
            false,
            "<system-reminder>Keep going.</system-reminder>"
        )));
        let wrapped = "<system-reminder>\nThe user sent the following message:\nDo not deploy.\n\nPlease address this message and continue with your tasks.\n</system-reminder>";
        assert!(is_meaningful_user(&entry(1, Role::User, false, wrapped)));
    }

    /// The tail moves back to the newest prompt or tool call at or before
    /// the size walk's boundary, when that keeps little extra raw.
    #[test]
    fn the_tail_snaps_back_to_the_prompt_that_opens_the_work() {
        let entries: Vec<Entry> = (1..=10)
            .map(|ordinal| {
                let role = if ordinal == 7 {
                    Role::User
                } else {
                    Role::Assistant
                };
                entry(ordinal, role, false, "x")
            })
            .collect();
        let weight = |_: &Entry| 1_000;
        // The size walk keeps 9 and 10; the prompt at 7 opens that work and
        // costs 2,000 extra, within 1.5 × 2,000.
        assert_eq!(tail_start(&entries, weight, 1, 2_000, true), 7);
        // With a tail of 1,000 the extra 3,000 is too much.
        assert_eq!(tail_start(&entries, weight, 1, 1_000, true), 10);
    }

    /// A call left running in an old message was interrupted: it does not
    /// pull the tail back to it, or nothing after it could be summarized.
    #[test]
    fn an_old_running_call_does_not_hold_the_tail_back() {
        let mut entries: Vec<Entry> = (1..=10)
            .map(|ordinal| entry(ordinal, Role::Assistant, false, "x"))
            .collect();
        entries[1] = Entry::new(
            2,
            "m2".to_owned(),
            Role::Assistant,
            0,
            vec![Part::new(
                "p2",
                PartBody::Tool(cortexkit_role_compaction::part::ToolPart::new(
                    "c2",
                    "bash",
                    serde_json::json!({}),
                    cortexkit_role_compaction::part::ToolStatus::Running,
                )),
            )],
        );
        let weight = |_: &Entry| 1_000;
        assert_eq!(tail_start(&entries, weight, 1, 2_000, false), 9);
    }

    #[test]
    fn the_tail_shrinks_with_usage_between_its_floor_and_ceiling() {
        // 200k window at 65%: usable 130k, floor 10.4k, ceiling 52k.
        assert_eq!(protected_tail_tokens(200_000, 65.0, 0.0), 39_000);
        assert_eq!(protected_tail_tokens(200_000, 65.0, 50.0), 19_500);
        assert_eq!(protected_tail_tokens(200_000, 65.0, 95.0), 10_400);
    }

    #[test]
    fn the_newest_user_prompt_stays_in_the_tail_until_the_force_band() {
        let entries: Vec<Entry> = (0..10)
            .map(|ordinal| {
                let role = if ordinal == 2 {
                    Role::User
                } else {
                    Role::Assistant
                };
                entry(ordinal, role, false, "x")
            })
            .collect();
        let weight = |_: &Entry| 1_000;
        // Tail of 2k: ordinals 8 and 9. The prompt at 2 pulls it back.
        assert_eq!(tail_start(&entries, weight, 0, 2_000, false), 2);
        assert_eq!(tail_start(&entries, weight, 0, 2_000, true), 8);
        // A notice is not the user's prompt.
        let mut notices = entries.clone();
        notices[2] = entry(2, Role::User, true, "x");
        assert_eq!(tail_start(&notices, weight, 0, 2_000, false), 8);
        // Too little to read stays put.
        assert_eq!(tail_start(&entries, |_: &Entry| 10, 0, 50, true), 0);
    }

    fn pressure(usage: f64, force: bool, after_drops: Option<f64>) -> Pressure {
        Pressure {
            usage,
            threshold: 65.0,
            force,
            usable_window: 200_000,
            after_drops,
        }
    }

    fn scan(tokens: u64, raw_tokens: u64, commit_clusters: u64) -> Scan {
        Scan {
            tokens,
            has_more: false,
            commit_clusters,
            messages: 5,
            raw_tokens,
            removed_tokens: tokens,
        }
    }

    #[test]
    fn a_run_starts_near_the_threshold_or_when_the_history_is_large() {
        let budget = 6_500;
        let none = None;
        // Near the threshold, with enough to summarize.
        assert_eq!(
            decide(
                &pressure(62.0, false, none),
                Some(&scan(7_000, 7_000, 0)),
                budget,
                Some(3)
            ),
            None
        );
        assert_eq!(
            decide(
                &pressure(63.0, false, none),
                Some(&scan(7_000, 7_000, 0)),
                budget,
                Some(3)
            ),
            Some(Reason::Proactive)
        );
        assert_eq!(
            decide(
                &pressure(63.0, false, none),
                Some(&scan(1_000, 1_000, 0)),
                budget,
                Some(3)
            ),
            None
        );
        // Size counts the lines the summarizer reads, not the raw history: a
        // few large tool outputs do not start a run at low usage.
        assert_eq!(
            decide(
                &pressure(10.0, false, none),
                Some(&scan(1_000, 40_000, 0)),
                budget,
                Some(3)
            ),
            None
        );
        assert_eq!(
            decide(
                &pressure(10.0, false, none),
                Some(&scan(19_500, 19_500, 0)),
                budget,
                Some(3)
            ),
            Some(Reason::TailSize)
        );
        // Three stretches of committed work and a trigger budget of lines.
        assert_eq!(
            decide(
                &pressure(10.0, false, none),
                Some(&scan(6_500, 6_500, 3)),
                budget,
                Some(3)
            ),
            Some(Reason::CommitClusters)
        );
        assert_eq!(
            decide(
                &pressure(10.0, false, none),
                Some(&scan(6_500, 6_500, 3)),
                budget,
                None
            ),
            None
        );
        assert_eq!(
            decide(
                &pressure(10.0, false, none),
                Some(&scan(6_400, 6_400, 3)),
                budget,
                Some(3)
            ),
            None
        );
        // The force band waits until enough text and tool input can leave.
        assert_eq!(
            decide(
                &pressure(90.0, true, none),
                Some(&scan(10, 10, 0)),
                budget,
                Some(3)
            ),
            None
        );
        assert_eq!(
            decide(&pressure(90.0, true, none), None, budget, Some(3)),
            None
        );
    }

    #[test]
    fn force_band_waits_for_two_percent_of_the_usable_window() {
        for tokens in [1, 3_999, 4_000] {
            let mut readable = scan(tokens, 100_000, 3);
            readable.has_more = true;
            readable.messages = 100;
            assert_eq!(
                decide(&pressure(85.0, true, None), Some(&readable), 5_000, Some(3)),
                (tokens >= 4_000).then_some(Reason::Force),
                "{tokens} reclaimable tokens"
            );
        }
    }

    #[test]
    fn the_force_minimum_does_not_change_lower_usage_or_emergency_runs() {
        let readable = scan(1, 6_000, 0);
        assert_eq!(
            decide(&pressure(84.99, false, None), Some(&readable), 5_000, None),
            Some(Reason::Proactive)
        );
        for usage in [95.0, 100.0, 120.0] {
            assert_eq!(
                decide(&pressure(usage, true, None), Some(&readable), 5_000, None),
                Some(Reason::Force)
            );
            assert_eq!(
                decide(&pressure(usage, true, None), None, 5_000, None),
                None
            );
        }
    }

    #[test]
    fn drops_that_bring_usage_low_enough_make_a_summary_unneeded() {
        let budget = 6_500;
        let readable = scan(7_000, 7_000, 0);
        // 0.75 x 65% = 48.75%.
        assert_eq!(
            decide(
                &pressure(90.0, true, Some(48.0)),
                Some(&readable),
                budget,
                Some(3)
            ),
            None
        );
        assert_eq!(
            decide(
                &pressure(90.0, true, Some(50.0)),
                Some(&readable),
                budget,
                Some(3)
            ),
            Some(Reason::Force)
        );
        assert_eq!(
            decide(
                &pressure(64.0, false, Some(40.0)),
                Some(&readable),
                budget,
                Some(3)
            ),
            None
        );
    }

    #[test]
    fn one_run_reads_at_most_its_cap_and_never_less_than_a_message() {
        let entries: Vec<Entry> = (1..=6).map(|n| entry(n, Role::User, false, "x")).collect();
        let weight = |_: &Entry| 100;
        assert_eq!(cap_run(&entries, weight, 1, 7, 250), 3);
        assert_eq!(cap_run(&entries, weight, 1, 7, 10_000), 7);
        assert_eq!(cap_run(&entries, weight, 1, 7, 50), 2);
        // The cap grows with usage: 2, 3 and 4 times the protected tail.
        assert!(per_run_cap(200_000, 65.0, 50.0) < per_run_cap(200_000, 65.0, 85.0));
        assert!(per_run_cap(200_000, 65.0, 85.0) < per_run_cap(200_000, 65.0, 96.0));
        // On a huge window: twice the protected tail at its 96,000 ceiling.
        assert_eq!(per_run_cap(10_000_000, 65.0, 50.0), 192_000);
    }
}
