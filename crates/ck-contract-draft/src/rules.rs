//! Provider rules: what the session's current model and account allow a
//! view to do. The runner declares them, because only it knows the route and
//! the account. The provider plans within them and writes every consequence
//! into the view as explicit edits. The runner checks a view with [`check`]
//! and refuses it by name when it breaks a rule; it never fixes a view up.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::part::{PartBody, Sealing};
use crate::read::Entry;
use crate::view::{Edit, EditOp, InsertAt};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderRules {
    pub signed_reasoning: SignedReasoning,
    pub history_edit_cost: EditCost,
}

/// How signed reasoning constrains edits.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SignedReasoning {
    /// No constraint.
    None,
    /// Anthropic thinking on prefix-bound models (Opus 5.5, Sonnet 5.5,
    /// Fable 5.1). A signed reasoning part stays valid only while the history
    /// before it renders exactly as it did when the part was generated, with
    /// one allowance: earlier signed reasoning parts may be left out as an
    /// oldest contiguous run. Leaving out a part in the middle, or any other
    /// edit before it (a drop, a replace, an inserted message), invalidates
    /// it, so the view must leave it out as well.
    Bound,
}

/// What editing history that was already sent costs on this route.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EditCost {
    /// The provider re-reads only from the first changed byte.
    Suffix,
    /// Any edit to sent history forces the whole prompt to be resent and
    /// written again (chained OpenAI requests).
    FullResend,
}

/// A rule a view breaks.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "rule", rename_all = "snake_case")]
pub enum RuleBreak {
    /// A signed reasoning part the view keeps is no longer valid.
    SignedReasoningInvalid { mid: String, part: String },
}

/// Check a view's edits against the rules.
///
/// An edit already in the view a reasoning part was generated under (its
/// `since` is not later than that view's version) was part of the history the
/// part was signed against, so it does not invalidate the part.
pub fn check(entries: &[Entry], edits: &[Edit], rules: &ProviderRules) -> Result<(), RuleBreak> {
    match invalid_signed_parts(entries, edits, rules)
        .into_iter()
        .next()
    {
        Some((mid, part)) => Err(RuleBreak::SignedReasoningInvalid { mid, part }),
        None => Ok(()),
    }
}

/// The signed reasoning parts a view keeps that its own edits invalidate, in
/// transcript order. A provider adds a drop for each of them; since a drop is
/// itself an edit, it repeats until this returns nothing.
pub fn invalid_signed_parts(
    entries: &[Entry],
    edits: &[Edit],
    rules: &ProviderRules,
) -> Vec<(String, String)> {
    if rules.signed_reasoning == SignedReasoning::None {
        return Vec::new();
    }
    let layout = Layout::new(entries);

    // Positions of edits other than leaving out a reasoning part, with the
    // version that introduced each.
    let mut changes: Vec<(Position, u64)> = Vec::new();
    // Reasoning parts left out, with the version that left each out.
    let mut reasoning_drops: std::collections::HashMap<(usize, usize), u64> = Default::default();
    for edit in edits {
        let since = edit.since;
        match &edit.op {
            EditOp::Drop {
                mid,
                part: Some(part),
            } => {
                if let Some(position) = layout.part(mid, part) {
                    if layout.is_reasoning(position) {
                        reasoning_drops.insert((position.entry, position.slot), since);
                    } else {
                        changes.push((position, since));
                    }
                }
            }
            EditOp::Drop { mid, part: None } => {
                if let Some(position) = layout.message(mid) {
                    changes.push((position, since));
                }
            }
            EditOp::Replace { mid, part, .. } => {
                if let Some(position) = layout.part(mid, part) {
                    changes.push((position, since));
                }
            }
            // A cut removes the earliest messages, so it changes what every
            // later part was signed after.
            EditOp::Cut { through } => {
                if layout.message(through).is_some() {
                    changes.push((Position::BEFORE_ALL, since));
                }
            }
            EditOp::Insert { at, .. } => {
                let position = match at {
                    InsertAt::Start => Some(Position::BEFORE_ALL),
                    InsertAt::Before(mid) => layout.message(mid),
                };
                if let Some(position) = position {
                    changes.push((position, since));
                }
            }
        }
    }
    let dropped_messages: BTreeSet<usize> = edits
        .iter()
        .filter_map(|edit| match &edit.op {
            EditOp::Drop { mid, part: None } => {
                layout.message(mid).map(|position| vec![position.entry])
            }
            EditOp::Cut { through } => layout
                .message(through)
                .map(|last| (0..=last.entry).collect()),
            _ => None,
        })
        .flatten()
        .collect();

    // Every signed reasoning part, in transcript order.
    let signed: Vec<Position> = layout.signed_reasoning();
    let mut invalid = Vec::new();
    for (index, &position) in signed.iter().enumerate() {
        let kept = !dropped_messages.contains(&position.entry)
            && !reasoning_drops.contains_key(&(position.entry, position.slot));
        if !kept {
            continue;
        }
        let generated = layout.generated_under(position.entry);
        let edited_before = changes
            .iter()
            .any(|(change, since)| *since > generated && *change < position);
        // Earlier signed parts may be left out only as an oldest run: a part
        // left out after `generated` must not follow one that is still kept.
        let mut seen_kept = false;
        let mut gap = false;
        for earlier in &signed[..index] {
            match reasoning_drops.get(&(earlier.entry, earlier.slot)) {
                Some(since) if *since > generated => {
                    if seen_kept {
                        gap = true;
                        break;
                    }
                }
                Some(_) => {}
                None if dropped_messages.contains(&earlier.entry) => {}
                None => seen_kept = true,
            }
        }
        if edited_before || gap {
            let entry = &entries[position.entry];
            invalid.push((entry.mid.clone(), entry.parts[position.slot - 1].id.clone()));
        }
    }
    invalid
}

/// A place in the transcript: entry index, then slot within the entry. Slot
/// 0 is before the entry's first part, where message-level edits sit (an
/// insert before the message, or dropping the whole message); part `i` sits at
/// slot `i + 1`. So a message-level edit sorts strictly before every part of
/// its own message.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Position {
    entry: usize,
    slot: usize,
}

impl Position {
    const BEFORE_ALL: Position = Position { entry: 0, slot: 0 };
}

struct Layout<'a> {
    entries: &'a [Entry],
    by_mid: std::collections::HashMap<&'a str, usize>,
}

impl<'a> Layout<'a> {
    fn new(entries: &'a [Entry]) -> Self {
        let by_mid = entries
            .iter()
            .enumerate()
            .map(|(index, entry)| (entry.mid.as_str(), index))
            .collect();
        Self { entries, by_mid }
    }

    fn message(&self, mid: &str) -> Option<Position> {
        self.by_mid
            .get(mid)
            .map(|&entry| Position { entry, slot: 0 })
    }

    fn part(&self, mid: &str, part: &str) -> Option<Position> {
        let &entry = self.by_mid.get(mid)?;
        let index = self.entries[entry]
            .parts
            .iter()
            .position(|candidate| candidate.id == part)?;
        Some(Position {
            entry,
            slot: index + 1,
        })
    }

    fn is_reasoning(&self, position: Position) -> bool {
        matches!(
            self.entries[position.entry].parts[position.slot - 1].body,
            PartBody::Reasoning { .. }
        )
    }

    fn signed_reasoning(&self) -> Vec<Position> {
        let mut out = Vec::new();
        for (entry, message) in self.entries.iter().enumerate() {
            for (part, candidate) in message.parts.iter().enumerate() {
                if matches!(
                    candidate.body,
                    PartBody::Reasoning {
                        sealing: Sealing::Signed,
                        ..
                    }
                ) {
                    out.push(Position {
                        entry,
                        slot: part + 1,
                    });
                }
            }
        }
        out
    }

    /// The view version a message was generated under; 0 when it was
    /// generated with no view applied.
    fn generated_under(&self, entry: usize) -> u64 {
        self.entries[entry]
            .generated_under
            .as_ref()
            .map_or(0, |view| view.version)
    }
}
