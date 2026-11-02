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
use ck_contract_draft::rules::SignedParts;

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
    /// Tokens of the newest tool output the routine heuristics leave alone;
    /// derived from the usable window when not set.
    pub protected_tokens: Option<u64>,
    /// For sessions with `ctx_keep`: when a pass at the execute threshold
    /// frees less than this share of the usable window, the model is asked to
    /// call `ctx_keep`. 100 asks on every such pass.
    pub keep_min_recovery_percentage: f64,
    /// What `ctx_keep` may keep, as a share of the usable window. Tags past
    /// it, in the order the model listed them, are not kept.
    pub keep_max_percentage: f64,
    /// The history head's budget, as a share of the window up to the execute
    /// threshold.
    pub history_budget_percentage: f64,
    /// Project memories shown in the head, in tokens.
    pub memory_budget_tokens: u64,
    /// User profile lines shown in the head, in tokens.
    pub profile_budget_tokens: u64,
    /// `memory.enabled`: project memories, primers and their search.
    pub memory_enabled: bool,
    /// `memory.git_commit_indexing.enabled`: commit search. Off by default.
    pub git_commits_enabled: bool,
    /// The embedding provider `ctx_search` scores by meaning with; `None`
    /// leaves search to its word lanes.
    pub embedding: Option<crate::embedding::Provider>,
    /// `temporal_awareness`: a person's message after a gap of five minutes
    /// or more starts with a marker saying how long it was.
    pub temporal_awareness: bool,
    /// `memory.auto_search`: memory hints on a person's message.
    pub auto_search: AutoSearch,
    /// `caveman_text_compression`: older long text compressed by age, for
    /// sessions with a summarizer. `None` when off, the default.
    pub caveman: Option<Caveman>,
    /// The user-level `language`, lower-cased: the summarizer writes its
    /// prose in it. `None` writes English.
    pub language: Option<String>,
}

/// How the caveman lane compresses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Caveman {
    /// Text shorter than this, in bytes of its own text, stays as it is.
    pub min_chars: u64,
    /// The English word lists apply; for another `language`, only the
    /// language-neutral passes run.
    pub english_word_rules: bool,
}

/// When a person's message gets a memory hint.
#[derive(Clone, Debug, PartialEq)]
pub struct AutoSearch {
    pub enabled: bool,
    /// The relevance a fragment needs to appear in the hint.
    pub score_threshold: f64,
    /// Shorter prompts get no hint: too little to search with.
    pub min_prompt_chars: usize,
}

impl Default for AutoSearch {
    fn default() -> Self {
        Self {
            enabled: true,
            score_threshold: 0.6,
            min_prompt_chars: 20,
        }
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            execute_threshold_percentage: 65.0,
            keep_reasoning_tokens: 10_000,
            protected_tools: BTreeMap::from([("todowrite".into(), 1), ("ctx_reduce".into(), 3)]),
            protected_tokens: None,
            keep_min_recovery_percentage: 30.0,
            keep_max_percentage: 30.0,
            history_budget_percentage: 0.15,
            memory_budget_tokens: 4_000,
            profile_budget_tokens: 4_000,
            memory_enabled: true,
            git_commits_enabled: false,
            embedding: None,
            temporal_awareness: true,
            auto_search: AutoSearch::default(),
            caveman: None,
            language: None,
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
/// rebuilds before it reaches the force band, where emergency drops start
/// ([`force_band`]). A view the runner asks for because it is about to
/// rewrite its cache anyway (a ride) is never held: that rewrite is paid for
/// already, so the held work lands in it.
pub fn signed_thinking_hold(
    entries: &[Entry],
    conditions: &Conditions,
    settings: &Settings,
) -> bool {
    if conditions.rules.signed_parts != SignedParts::Bound {
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

/// The force band: from here a pass stops waiting for a summary and the
/// emergency drop runs. At least 85%, and above the execute threshold.
pub fn force_band(settings: &Settings) -> f64 {
    85.0_f64.max(settings.execute_threshold_percentage + 2.0)
}

/// Whether usage has reached the force band.
pub fn in_force_band(conditions: &Conditions, settings: &Settings) -> bool {
    usage(conditions).is_some_and(|usage| usage * 100.0 >= force_band(settings))
}
