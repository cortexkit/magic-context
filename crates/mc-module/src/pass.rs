//! When a session may rebuild: the pass decision, and the settings it and
//! the lanes use.
//!
//! A new view rewrites the provider's prompt cache from its first changed
//! byte, so a view is built only on a pass that may pay for that:
//! - when usage reaches the execute threshold, unless a summary is on its
//!   way, in which case everything waits and lands with that summary;
//! - when the runner reports that the cache is lost anyway, or that the next
//!   request would not fit (a ride). The rewrite is then free, or unavoidable.
//!
//! Below the threshold nothing happens, and every request is a cache hit.

use std::collections::BTreeMap;

use ck_contract_draft::notice::Conditions;
use ck_contract_draft::read::{Entry, Role};
use ck_contract_draft::rules::SignedReasoning;

use crate::lanes;

#[derive(Clone, Debug)]
pub struct Settings {
    /// Usage, as a percentage of the usable window, at which a pass executes.
    pub execute_threshold_percentage: f64,
    /// Reasoning tokens the newest assistant messages keep; older reasoning
    /// is dropped on every pass that rebuilds.
    pub keep_reasoning_tokens: u64,
    /// The newest results of these tools are never dropped automatically:
    /// tool name to how many results it keeps.
    pub protected_tools: BTreeMap<String, u64>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            execute_threshold_percentage: 65.0,
            keep_reasoning_tokens: 10_000,
            protected_tools: BTreeMap::from([("todowrite".into(), 1), ("ctx_reduce".into(), 3)]),
        }
    }
}

/// The window a request may fill: the context window minus the room kept for
/// the reply.
pub fn usable_window(conditions: &Conditions) -> u64 {
    conditions
        .context_window
        .saturating_sub(conditions.output_reserve)
}

/// The share of the usable window the newest request used, from the size
/// the model provider reported. `None` before the first request.
pub fn usage(conditions: &Conditions) -> Option<f64> {
    let usable = usable_window(conditions);
    let prompt = conditions.last_prompt_tokens?;
    (usable > 0).then(|| prompt as f64 / usable as f64)
}

/// Whether usage has reached the execute threshold.
pub fn at_execute(conditions: &Conditions, settings: &Settings) -> bool {
    usage(conditions).is_some_and(|usage| usage * 100.0 >= settings.execute_threshold_percentage)
}

/// An assistant step that spent more reasoning tokens than this is heavy.
pub const HEAVY_REASONING_TOKENS: u64 = 1_500;

/// How many of the turn's newest assistant steps the hold looks at.
pub const HEAVY_REASONING_WINDOW_STEPS: usize = 15;

/// The hold always ends at the execute threshold plus this many points.
pub const HOLD_CAP_POINTS: f64 = 10.0;

/// The signed-thinking hold, for sessions whose runner declares signed
/// reasoning (Anthropic thinking on prefix-bound models).
///
/// A new view that changes anything before a signed thinking block makes the
/// view drop that block, so a rebuild right after heavy reasoning throws away
/// the reasoning the model just paid for. An execute pass is therefore held,
/// building no view, while both hold:
/// - one of the current turn's last 15 assistant steps spent more than 1,500
///   reasoning tokens, and
/// - usage is below the execute threshold plus 10 points.
///
/// The cap bounds the hold: a session that keeps reasoning heavily still
/// rebuilds before it gets near the force band. Rides are never held: their
/// rewrite is paid for anyway.
pub fn signed_thinking_hold(
    entries: &[Entry],
    conditions: &Conditions,
    settings: &Settings,
) -> bool {
    if conditions.rules.signed_reasoning != SignedReasoning::Bound {
        return false;
    }
    let Some(usage) = usage(conditions) else {
        return false;
    };
    if usage * 100.0 >= settings.execute_threshold_percentage + HOLD_CAP_POINTS {
        return false;
    }
    // The current turn starts after the last message the user wrote; notices
    // a module or the runner delivered do not end it.
    let turn_start = entries
        .iter()
        .rposition(|entry| entry.role == Role::User && entry.notice.is_none())
        .map_or(0, |user| user + 1);
    entries[turn_start..]
        .iter()
        .rev()
        .filter(|entry| entry.role == Role::Assistant && !entry.parts.is_empty())
        .take(HEAVY_REASONING_WINDOW_STEPS)
        .any(|entry| lanes::step_reasoning_tokens(entry) > HEAVY_REASONING_TOKENS)
}
