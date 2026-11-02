//! When the summarizer runs, and how far it may read: ports of the
//! TypeScript plugin's trigger (`compartment-trigger.ts`) and protected-tail
//! boundary (`protected-tail-boundary.ts`), on the runner's messages.
//!
//! The newest stretch of the conversation, the protected tail, is never
//! summarized: the model is still working with it. Its size shrinks as usage
//! grows, between a floor and a ceiling scaled by the usable window.

use ck_contract_draft::part::{PartBody, ToolStatus};
use ck_contract_draft::read::{Entry, Role};

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

/// Whether a user message carries the user's own words, not only a notice.
pub fn is_meaningful_user(entry: &Entry) -> bool {
    entry.role == Role::User
        && entry.notice.is_none()
        && entry.parts.iter().any(|part| match &part.body {
            PartBody::Text { text } => !text.trim().is_empty(),
            _ => false,
        })
}

fn has_running_tool(entry: &Entry) -> bool {
    entry.parts.iter().any(
        |part| matches!(&part.body, PartBody::Tool(tool) if tool.status == ToolStatus::Running),
    )
}

/// The first ordinal the summarizer must not read, given that everything
/// before `from` is already summarized. Returns `from` when nothing may be
/// read yet.
///
/// The tail is the newest `tail_tokens` of history, rounded out to whole
/// messages. A message still running a tool is always in it. Below the force
/// band, so is the newest message the user wrote: summarizing the prompt the
/// model is answering would replace it with a narration mid-turn.
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
            if weight(entry) > (2 * tail_tokens).max(64_000) && entry.ordinal < newest.ordinal {
                boundary += 1;
            }
            break;
        }
    }
    if let Some(running) = entries.iter().find(|entry| has_running_tool(entry)) {
        boundary = boundary.min(running.ordinal);
    }
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

/// What decided a run, for the log.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    /// Usage is near the execute threshold.
    Proactive,
    /// The unsummarized history is large, whatever the usage.
    TailSize,
    /// Usage is in the force band.
    Force,
}

/// Whether a summarizer run should start now, given the history it could
/// read (`readable_tokens` over `readable_messages`).
pub fn should_run(
    usage_percentage: f64,
    threshold_percentage: f64,
    force: bool,
    readable_tokens: u64,
    readable_messages: usize,
    trigger_budget: u64,
) -> Option<Reason> {
    if readable_messages == 0 {
        return None;
    }
    if force {
        return Some(Reason::Force);
    }
    if readable_tokens >= trigger_budget * TAIL_SIZE_MULTIPLIER {
        return Some(Reason::TailSize);
    }
    let enough = readable_tokens >= MIN_PROACTIVE_TAIL_TOKENS
        || readable_messages >= MIN_PROACTIVE_TAIL_MESSAGES;
    (usage_percentage >= threshold_percentage - PROACTIVE_OFFSET_PERCENTAGE && enough)
        .then_some(Reason::Proactive)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ck_contract_draft::part::Part;
    use ck_contract_draft::read::{entry_digest, NoticeOrigin};

    fn entry(ordinal: u64, role: Role, notice: bool, text: &str) -> Entry {
        let parts = vec![Part::new(
            format!("p{ordinal}"),
            None,
            PartBody::Text { text: text.into() },
        )];
        let notice = notice.then(|| NoticeOrigin {
            sender: "x".into(),
            template: None,
        });
        Entry {
            ordinal,
            mid: format!("m{ordinal}"),
            role,
            digest: entry_digest(role, notice.as_ref(), &parts),
            notice,
            written_at: 0,
            parts,
            usage: None,
            generated_under: None,
        }
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

    #[test]
    fn a_run_starts_near_the_threshold_or_when_the_history_is_large() {
        assert_eq!(should_run(62.0, 65.0, false, 7_000, 5, 6_500), None);
        assert_eq!(
            should_run(63.0, 65.0, false, 7_000, 5, 6_500),
            Some(Reason::Proactive)
        );
        assert_eq!(should_run(63.0, 65.0, false, 1_000, 5, 6_500), None);
        assert_eq!(
            should_run(10.0, 65.0, false, 19_500, 5, 6_500),
            Some(Reason::TailSize)
        );
        assert_eq!(
            should_run(90.0, 65.0, true, 10, 1, 6_500),
            Some(Reason::Force)
        );
        assert_eq!(should_run(90.0, 65.0, true, 0, 0, 6_500), None);
    }
}
