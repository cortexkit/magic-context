//! Reminders to call `ctx_reduce`, ported from the plugin's two nudge
//! channels (`ctx-reduce-nudge.ts`, `docs/architecture/nudges.md`).
//!
//! Both read one measurement of what the model sees after the history head:
//! `T`, the content mass that counts (text the model or a person wrote, tool
//! calls and results, files), and `U`, the part of `T` the model could still
//! drop: tagged, not dropped or already asked for, and outside the protected
//! tail. The share `U/T` picks a band:
//!
//! | Band      | When                                            |
//! |-----------|-------------------------------------------------|
//! | quiet     | `T < 60k`, `U < 25k`, or `U/T < 0.20`           |
//! | gentle    | `U/T ≥ 0.20`                                    |
//! | firm      | `U/T ≥ 0.40`                                    |
//! | urgent    | `U/T ≥ 0.60`                                    |
//! | ceiling   | urgent, `U/T ≥ 0.75` and `U ≥ 50k`              |
//!
//! Channel 1 rides the next tool result and so never costs a turn of its own:
//! once when the band rises, and again within a band only after `U` has grown
//! by `max(25k, 8% of T)` and five turns by a person have passed. Channel 2,
//! the ceiling, goes once per cycle as a notice message before the next
//! request.
//!
//! Two rules keep a reminder from being caused by ck-mc itself:
//! - a pass that published a view fires nothing. Removing content lowers `T`
//!   and can raise `U/T`; that pass records the band it left, so only growth
//!   after it can fire.
//! - after the model calls `ctx_reduce`, Channel 1 waits until `U` has grown
//!   by the same amount, or the band rises above where it was.

use std::collections::BTreeSet;

use compaction_view::tags::tag_prefix;
use cortexkit_role_compaction::part::PartBody;
use cortexkit_role_compaction::read::{Entry, Role};
use serde::{Deserialize, Serialize};

use crate::lanes::{self, Context, PartKey};
use crate::tokens;

const MIN_TAIL_TOKENS: u64 = 60_000;
const FLOOR_TOKENS: u64 = 25_000;
const REFIRE_FLOOR_TOKENS: u64 = 25_000;
const GENTLE: f64 = 0.2;
const FIRM: f64 = 0.4;
const URGENT: f64 = 0.6;
const CEILING_SHARE: f64 = 0.75;
const CEILING_FLOOR_TOKENS: u64 = 50_000;
/// Turns by a person between two same-band reminders.
const REFIRE_TURN_GAP: u64 = 5;
/// Hints skip outputs known to be smaller than this.
const HINT_MIN_TOKENS: u64 = 250;
const HINT_COUNT: usize = 4;
/// Coordination and control tools: poor suggestions for a reduction, though
/// the model may still drop them.
const HINT_EXCLUDED_TOOLS: [&str; 8] = [
    "ask",
    "bash_kill",
    "bash_status",
    "board",
    "task",
    "todoread",
    "todowrite",
    "work",
];

/// The kinds of `ctx_reduce` reminder: each send's `dedupe_key`, so a
/// newer reminder replaces a queued one of its kind, and its `send_id` prefix.
pub const REMINDER_KIND: &str = "mc.reduce.reminder";
pub const CEILING_KIND: &str = "mc.reduce.ceiling";

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Level {
    Gentle,
    Firm,
    Urgent,
}

/// `T`, `U`, how many tool results make up `U`, and the oldest of them worth
/// suggesting, as `(tag, tool name)`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Measurement {
    pub t: u64,
    pub u: u64,
    pub outputs: usize,
    pub hints: Vec<(u64, String)>,
}

impl Measurement {
    fn share(&self) -> f64 {
        (self.u as f64 / self.t.max(1) as f64).clamp(0.0, 1.0)
    }

    /// The Channel 1 band; `None` is quiet.
    pub fn level(&self) -> Option<Level> {
        if self.t < MIN_TAIL_TOKENS || self.u < FLOOR_TOKENS {
            return None;
        }
        let share = self.share();
        if share >= URGENT {
            Some(Level::Urgent)
        } else if share >= FIRM {
            Some(Level::Firm)
        } else if share >= GENTLE {
            Some(Level::Gentle)
        } else {
            None
        }
    }

    /// Whether the ceiling reminder applies.
    pub fn at_ceiling(&self) -> bool {
        self.level() == Some(Level::Urgent)
            && self.u >= CEILING_FLOOR_TOKENS
            && self.share() >= CEILING_SHARE
    }
}

/// Measure what the model sees. `protected_from` is the lowest tag of the
/// protected tail; `queued` the parts the model already asked to drop.
pub fn measure(
    context: &Context,
    protected_from: Option<u64>,
    queued: &BTreeSet<PartKey>,
) -> Measurement {
    let protected_tools = lanes::protected_tool_parts(context.index, context.protected_tools);
    let first = context
        .keep_first_message
        .then(|| {
            context
                .index
                .entries()
                .first()
                .map(|entry| entry.mid.as_str())
        })
        .flatten();
    let mut measurement = Measurement::default();
    let mut candidates: Vec<(u8, u64, String)> = Vec::new();
    for entry in context.index.entries() {
        // Reminders and other notices are the runner's or a module's, not
        // content the model could act on.
        if entry.notice.is_some() {
            continue;
        }
        for part in &entry.parts {
            if context.edited.covers(&entry.mid, &part.id) {
                continue;
            }
            let (weight, tool) = match &part.body {
                PartBody::Text { .. } | PartBody::File(_) => (tokens::part(part), None),
                PartBody::Tool(tool) => (tokens::part(part), Some(tool)),
                _ => continue,
            };
            measurement.t += weight;
            let key = (entry.mid.clone(), part.id.clone());
            let protected = match (tool, part.tag, protected_from) {
                (Some(_), Some(tag), Some(from)) => tag >= from,
                _ => false,
            } || protected_tools.contains(&key);
            let Some(tag) = part.tag else {
                continue;
            };
            if protected || queued.contains(&key) || Some(entry.mid.as_str()) == first {
                continue;
            }
            measurement.u += weight;
            if let Some(tool) = tool {
                measurement.outputs += 1;
                let name = lanes::normalize_tool_name(&tool.name);
                if weight >= HINT_MIN_TOKENS
                    && !name.starts_with("ctx_")
                    && !HINT_EXCLUDED_TOOLS.contains(&name.as_str())
                {
                    candidates.push((lanes::emergency_tier(&tool.name), tag, tool.name.clone()));
                }
            }
        }
    }
    // Miscellaneous tools first, then edits and searches, then navigation;
    // oldest first within each.
    candidates.sort_by(|left, right| right.0.cmp(&left.0).then(left.1.cmp(&right.1)));
    measurement.hints = candidates
        .into_iter()
        .take(HINT_COUNT)
        .map(|(_, tag, name)| (tag, name))
        .collect();
    measurement
}

/// What the reminders remember between passes, so their cadence survives a
/// ck-mc restart.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct State {
    /// The band last observed, quiet as `None`.
    pub last_level: Option<Level>,
    /// `U` when the band was last observed or a reminder went out.
    pub last_u: u64,
    /// Turns by a person when the last Channel 1 reminder went out.
    pub last_fire_turn: Option<u64>,
    /// The model called `ctx_reduce`; the next measurement starts its grace.
    pub grace_pending: bool,
    /// `U` right after the model's last `ctx_reduce`, while its grace lasts.
    pub grace_u: Option<u64>,
    /// The band before that `ctx_reduce`.
    pub grace_level: Option<Level>,
    /// The ceiling reminder went out in this cycle.
    pub ceiling_sent: bool,
}

/// What a pass sends.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Reminders {
    /// Text to ride the next tool result.
    pub tool_result: Option<String>,
    /// Text to store as a notice message before the next request.
    pub ceiling: Option<String>,
}

fn rank(level: Option<Level>) -> u8 {
    match level {
        None => 0,
        Some(Level::Gentle) => 1,
        Some(Level::Firm) => 2,
        Some(Level::Urgent) => 3,
    }
}

fn refire_tokens(t: u64) -> u64 {
    ((0.08 * t as f64).round() as u64).max(REFIRE_FLOOR_TOKENS)
}

impl State {
    /// The model called `ctx_reduce`.
    pub fn reduced(&mut self) {
        self.grace_pending = true;
        self.grace_level = self.last_level;
    }

    /// Decide this pass's reminders. `rebuilt` says the pass published a
    /// view; `turns` counts the messages a person wrote so far; `cut_moved`
    /// says a new summary now covers more of the history.
    pub fn decide(
        &mut self,
        measurement: &Measurement,
        rebuilt: bool,
        turns: u64,
        cut_moved: bool,
    ) -> Reminders {
        let mut reminders = Reminders::default();
        let level = measurement.level();
        // The ceiling's cycle ends when a summary covers more history, or
        // when what the model could drop has collapsed.
        if self.ceiling_sent && (cut_moved || (rebuilt && measurement.u < FLOOR_TOKENS)) {
            self.ceiling_sent = false;
        }
        if self.grace_pending {
            // `U` already leaves out what the model asked to drop.
            self.grace_pending = false;
            self.grace_u = Some(measurement.u);
            return reminders;
        }
        if rebuilt {
            self.last_level = level;
            self.last_u = measurement.u;
            return reminders;
        }
        if !self.ceiling_sent && measurement.at_ceiling() {
            self.ceiling_sent = true;
            reminders.ceiling = Some(ceiling_text(measurement));
        }
        let threshold = refire_tokens(measurement.t);
        if let Some(grace_u) = self.grace_u {
            let regrown = measurement.u.saturating_sub(grace_u) >= threshold;
            if !regrown && rank(level) <= rank(self.grace_level) {
                return reminders;
            }
            // The grace is over; the usual rules decide, against the band
            // and `U` from before the reduce, as the plugin does.
            self.grace_u = None;
            self.grace_level = None;
        }
        let Some(level) = level else {
            self.last_level = None;
            self.last_u = 0;
            return reminders;
        };
        if rank(Some(level)) < rank(self.last_level) {
            self.last_level = Some(level);
            self.last_u = measurement.u;
            return reminders;
        }
        let crossed = rank(Some(level)) > rank(self.last_level);
        let grown = measurement.u.saturating_sub(self.last_u) >= threshold;
        let turns_passed = self
            .last_fire_turn
            .is_none_or(|last| last > turns || turns - last >= REFIRE_TURN_GAP);
        if !crossed && !(grown && turns_passed) {
            return reminders;
        }
        // When the ceiling reminder goes on the same pass it says it all; a
        // second reminder in the same step would only repeat it.
        if reminders.ceiling.is_none() {
            reminders.tool_result = Some(reminder_text(level, measurement, !crossed));
        }
        self.last_level = Some(level);
        self.last_u = measurement.u;
        self.last_fire_turn = Some(turns);
        reminders
    }
}

/// How many messages a person wrote, for the reminder cadence.
pub fn person_turns(entries: &[Entry]) -> u64 {
    entries
        .iter()
        .filter(|entry| entry.role == Role::User && entry.notice.is_none())
        .count() as u64
}

fn summary(measurement: &Measurement) -> String {
    let outputs = match measurement.outputs {
        0 => "spent tool outputs".to_owned(),
        1 => "1 spent tool output".to_owned(),
        count => format!("{count} spent tool outputs"),
    };
    format!(
        "{outputs} (~{}k tokens)",
        (measurement.u as f64 / 1_000.0).round() as u64
    )
}

fn hint_text(measurement: &Measurement) -> String {
    if measurement.hints.is_empty() {
        return String::new();
    }
    let rendered: Vec<String> = measurement
        .hints
        .iter()
        .map(|(tag, name)| format!("{}{name}", tag_prefix(*tag)))
        .collect();
    format!("\noldest reclaimable: {}.", rendered.join(" · "))
}

/// The Channel 1 text, as the plugin words it. `again` is a same-band
/// reminder, which uses the calm one-line wording.
pub fn reminder_text(level: Level, measurement: &Measurement, again: bool) -> String {
    let summary = summary(measurement);
    let body = if again {
        format!("Still unstamped: {summary}. Stamp the ones you've used with ctx_reduce now.")
    } else {
        match level {
            Level::Gentle => format!(
                "Housekeeping: {summary} are reclaimable. Stamp each output with ctx_reduce as soon as you've taken what you need from it; don't wait for the task to finish."
            ),
            Level::Firm => format!(
                "{summary} are reclaimable. Make a ctx_reduce pass now over the outputs you've already used, then continue."
            ),
            Level::Urgent => format!(
                "{summary} are still unstamped. Call ctx_reduce now, before your next tool call, on every output you've already used."
            ),
        }
    };
    format!(
        "<system-reminder>\n{body}{}\n</system-reminder>",
        hint_text(measurement)
    )
}

pub fn ceiling_text(measurement: &Measurement) -> String {
    format!(
        "<system-reminder>\nYour next step: call ctx_reduce on the outputs you've already used ({}). Then continue your task.{}\n</system-reminder>",
        summary(measurement),
        hint_text(measurement)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(u: u64, t: u64) -> Measurement {
        Measurement {
            t,
            u,
            outputs: 3,
            hints: vec![(12, "bash".into())],
        }
    }

    #[test]
    fn bands_follow_the_plugin() {
        assert_eq!(at(20_000, 100_000).level(), None);
        assert_eq!(at(30_000, 50_000).level(), None);
        assert_eq!(at(30_000, 100_000).level(), Some(Level::Gentle));
        assert_eq!(at(45_000, 100_000).level(), Some(Level::Firm));
        assert_eq!(at(65_000, 100_000).level(), Some(Level::Urgent));
        assert!(!at(65_000, 100_000).at_ceiling());
        assert!(at(80_000, 100_000).at_ceiling());
    }

    #[test]
    fn a_rising_band_fires_once_and_regrowth_needs_turns() {
        let mut state = State::default();
        let first = state.decide(&at(30_000, 100_000), false, 1, false);
        assert!(first
            .tool_result
            .unwrap()
            .contains("Housekeeping: 3 spent tool outputs (~30k tokens)"));
        assert_eq!(
            state.decide(&at(31_000, 100_000), false, 1, false),
            Reminders::default()
        );
        // Grown enough within the band, but too few turns since the last one.
        assert_eq!(
            state.decide(&at(56_000, 200_000), false, 3, false),
            Reminders::default()
        );
        let again = state.decide(&at(56_000, 200_000), false, 6, false);
        assert!(again.tool_result.unwrap().contains("Still unstamped"));
    }

    #[test]
    fn a_rebuild_never_fires_what_it_caused() {
        let mut state = State::default();
        state.decide(&at(30_000, 100_000), false, 1, false);
        // The rebuild removed 40k of other content: the share jumps to urgent.
        assert_eq!(
            state.decide(&at(30_000, 60_000), true, 1, false),
            Reminders::default()
        );
        // The next pass sees the same band and no growth.
        assert_eq!(
            state.decide(&at(31_000, 61_000), false, 1, false),
            Reminders::default()
        );
    }

    #[test]
    fn a_reduce_starts_a_grace_until_regrowth() {
        let mut state = State::default();
        state.decide(&at(45_000, 100_000), false, 1, false);
        state.reduced();
        assert_eq!(
            state.decide(&at(20_000, 100_000), false, 1, false),
            Reminders::default()
        );
        assert_eq!(
            state.decide(&at(40_000, 120_000), false, 9, false),
            Reminders::default()
        );
        let after = state.decide(&at(75_000, 125_000), false, 9, false);
        assert!(after.tool_result.unwrap().contains("Call ctx_reduce now"));
    }

    #[test]
    fn the_ceiling_goes_once_per_cycle() {
        let mut state = State::default();
        let first = state.decide(&at(80_000, 100_000), false, 1, false);
        assert!(first.ceiling.unwrap().starts_with(
            "<system-reminder>\nYour next step: call ctx_reduce on the outputs you've already used (3 spent tool outputs (~80k tokens)). Then continue your task.\noldest reclaimable: §12§ bash."
        ));
        assert_eq!(first.tool_result, None);
        assert_eq!(
            state.decide(&at(90_000, 110_000), false, 9, false).ceiling,
            None
        );
        state.decide(&at(10_000, 40_000), true, 9, false);
        assert!(state
            .decide(&at(80_000, 100_000), false, 9, false)
            .ceiling
            .is_some());
    }
}
