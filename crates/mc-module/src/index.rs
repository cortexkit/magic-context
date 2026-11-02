//! ck-mc's index of a session's transcript: every entry in compact form (text
//! in full; tool outputs, reasoning and media as sizes), in transcript order.
//! It is the "what the model is working with" half of ck-mc's picture of a
//! session; the other half is the view the runner applies.
//!
//! The index only grows from the runner's notices and reads. Only the newest
//! message may change after it was written (a tool gets its result), so an
//! entry at a known ordinal with a different id or content means the
//! transcript changed under ck-mc, and the index is rebuilt from a read.
//!
//! It holds the transcript from a base ordinal on: once a view replaces the
//! older messages with their summaries, ck-mc forgets everything before the
//! last message the view cuts (see [`Index::prune_before`]). What the model
//! no longer sees needs no index, so a session's index, and the work each
//! notice does over it, stays the size of the model's window however long
//! the session runs. The few readers of older messages (the summarizer,
//! `ctx_expand`) read them from the runner.

use cortexkit_role_compaction::part::{Part, PartBody, ToolStatus};
use cortexkit_role_compaction::read::{Cursor, Entry, Role};

/// Whether `new` is `held` with only tool parts changed: the same parts in
/// the same order, each the same or a tool part (its status, result, or the
/// sends delivered with it).
fn only_tool_results_changed(held: &Entry, new: &Entry) -> bool {
    held.role == new.role
        && held.parts.len() == new.parts.len()
        && held.parts.iter().zip(&new.parts).all(|(old, new)| {
            old.id == new.id
                && (old.digest == new.digest
                    || matches!(
                        (&old.body, &new.body),
                        (PartBody::Tool(old), PartBody::Tool(new)) if old.call_id == new.call_id
                    ))
        })
}

#[derive(Clone, Debug)]
pub struct Index {
    /// The ordinal of `entries[0]`, or of the next entry when empty.
    /// Ordinals count from 1.
    base: u64,
    entries: Vec<Entry>,
}

/// An empty index that holds the whole transcript, from its first entry.
impl Default for Index {
    fn default() -> Self {
        Self::starting_at(1)
    }
}

/// What adding entries did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Extend {
    /// The entries continued the index (or repeated what it holds).
    Continued,
    /// The first new entry is beyond the end: something was missed.
    Gap,
    /// An entry differs from what the index holds at its ordinal in a way
    /// the contract does not allow for a stored message (P5): it is another
    /// message, or more than a tool result changed.
    Diverged,
}

impl Index {
    /// An empty index that holds the transcript from `base` on.
    pub fn starting_at(base: u64) -> Self {
        Self {
            base,
            entries: Vec::new(),
        }
    }

    /// The first ordinal the index holds (or will hold, while empty).
    pub fn base(&self) -> u64 {
        self.base
    }

    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    pub fn cursor(&self) -> Option<Cursor> {
        self.entries
            .last()
            .map(|entry| Cursor::new(entry.ordinal, entry.mid.clone(), entry.digest.clone()))
    }

    /// Whether the index ends exactly where the runner says the transcript
    /// ends.
    pub fn ends_at(&self, newest: Option<&Cursor>) -> bool {
        self.cursor().as_ref() == newest
    }

    /// Add entries in transcript order. Stops at the first one that does not
    /// fit and says why; entries before it are kept.
    pub fn extend(&mut self, incoming: impl IntoIterator<Item = Entry>) -> Extend {
        for entry in incoming {
            let next = self.base + self.entries.len() as u64;
            // Before the base: a message the view already cut.
            if entry.ordinal < self.base {
                continue;
            }
            if entry.ordinal == next {
                self.entries.push(entry);
                continue;
            }
            if entry.ordinal > next {
                return Extend::Gap;
            }
            let held = &mut self.entries[(entry.ordinal - self.base) as usize];
            if held.digest == entry.digest && held.mid == entry.mid {
                continue;
            }
            // The newest message may still be written; an older one changes
            // only when one of its tool calls gets its result, or a send is
            // delivered with one (P5), even when the host stored the result
            // in a later message.
            let newest = entry.ordinal + 1 == next;
            if held.mid == entry.mid && (newest || only_tool_results_changed(held, &entry)) {
                *held = entry;
                continue;
            }
            return Extend::Diverged;
        }
        Extend::Continued
    }

    /// Forget every entry from `ordinal` on. An ordinal before the base
    /// empties the index; the caller decides where it starts again.
    pub fn truncate(&mut self, ordinal: u64) {
        self.entries
            .truncate(ordinal.saturating_sub(self.base) as usize);
    }

    /// Forget every entry before `ordinal`, which becomes the base. Returns
    /// the entries forgotten.
    pub fn prune_before(&mut self, ordinal: u64) -> Vec<Entry> {
        let count = (ordinal.saturating_sub(self.base) as usize).min(self.entries.len());
        self.base += count as u64;
        self.entries.drain(..count).collect()
    }

    /// Where a read that brings the index up to date starts: after this
    /// ordinal, so the newest held entry (which may still change) is read
    /// again; `None` reads from the transcript's start.
    pub fn read_after(&self) -> Option<u64> {
        let first = match self.entries.last() {
            Some(newest) => newest
                .ordinal
                .min(self.changeable_from().unwrap_or(u64::MAX)),
            None => self.base,
        };
        first.checked_sub(1).filter(|after| *after > 0)
    }

    /// The oldest held entry that may still change (P5): one with a tool
    /// call still running, or the newest assistant message on, whose results
    /// may yet have a send delivered with them. A read from here sees every
    /// change a notice could not carry.
    pub fn changeable_from(&self) -> Option<u64> {
        let running = self.entries.iter().find(|entry| {
            entry.parts.iter().any(|part| {
                matches!(&part.body, PartBody::Tool(tool) if tool.status == ToolStatus::Running)
            })
        });
        let newest_assistant = self
            .entries
            .iter()
            .rev()
            .find(|entry| entry.role == Role::Assistant);
        [running, newest_assistant]
            .into_iter()
            .flatten()
            .map(|entry| entry.ordinal)
            .min()
    }

    /// The entry and part that carry tag number `tag`.
    pub fn find_tag(&self, tag: u64) -> Option<(&Entry, &Part)> {
        self.entries.iter().find_map(|entry| {
            entry
                .parts
                .iter()
                .find(|part| part.tag == Some(tag))
                .map(|part| (entry, part))
        })
    }

    /// The entry and part with these ids.
    pub fn find(&self, mid: &str, part: &str) -> Option<(&Entry, &Part)> {
        let entry = self.entries.iter().find(|entry| entry.mid == mid)?;
        let part = entry.parts.iter().find(|candidate| candidate.id == part)?;
        Some((entry, part))
    }

    /// Tag numbers of the newest `count` tool parts, newest first.
    pub fn newest_tool_tags(&self, count: usize) -> Vec<u64> {
        self.entries
            .iter()
            .rev()
            .flat_map(|entry| entry.parts.iter().rev())
            .filter(|part| matches!(part.body, PartBody::Tool(_)))
            .filter_map(|part| part.tag)
            .take(count)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cortexkit_role_compaction::part::Seal;

    fn entry(ordinal: u64, mid: &str, text: &str) -> Entry {
        let parts = vec![crate::neutral::part(
            format!("{mid}:p0"),
            Some(ordinal),
            Seal::None,
            PartBody::Text { text: text.into() },
        )];
        Entry::new(ordinal, mid, Role::User, 0, parts)
    }

    #[test]
    fn entries_extend_repeat_or_update_only_the_newest_message() {
        let mut index = Index::default();
        assert_eq!(
            index.extend([entry(1, "a", "one"), entry(2, "b", "two")]),
            Extend::Continued
        );
        // A repeat changes nothing.
        assert_eq!(index.extend([entry(2, "b", "two")]), Extend::Continued);
        // The newest message may change.
        assert_eq!(
            index.extend([entry(2, "b", "two, done")]),
            Extend::Continued
        );
        assert_eq!(index.find_tag(2).unwrap().0.mid, "b");
        // An older one may not, unless only a tool result changed, nor may a
        // different message at a known ordinal.
        assert_eq!(index.extend([entry(1, "a", "changed")]), Extend::Diverged);
        assert_eq!(index.extend([entry(2, "c", "other")]), Extend::Diverged);
        assert_eq!(index.extend([entry(4, "d", "later")]), Extend::Gap);
        index.truncate(2);
        assert_eq!(index.cursor().unwrap().mid, "a");
    }

    /// An assistant message with one `read` call, running or completed.
    fn call(ordinal: u64, mid: &str, done: bool) -> Entry {
        let status = if done { "completed" } else { "running" };
        let mut tool = serde_json::json!({
            "id": "p0", "kind": "tool", "call_id": "c1", "name": "read",
            "input": {}, "status": status, "digest": status,
        });
        if done {
            tool["output_bytes"] = 4.into();
        }
        let parts = vec![serde_json::from_value(tool).unwrap()];
        Entry::new(ordinal, mid, Role::Assistant, 0, parts)
    }

    #[test]
    fn an_older_call_takes_its_result_after_later_messages() {
        let mut index = Index::default();
        index.extend([call(1, "a", false), entry(2, "b", "meanwhile")]);
        assert_eq!(index.changeable_from(), Some(1));
        assert_eq!(index.read_after(), None, "a read covers the running call");
        // The result arrives in place, after a later message was stored.
        assert_eq!(index.extend([call(1, "a", true)]), Extend::Continued);
        assert!(matches!(
            &index.entries()[0].parts[0].body,
            PartBody::Tool(tool) if tool.status == ToolStatus::Completed
        ));
        // Anything else changing in an older message still diverges.
        assert_eq!(index.extend([entry(1, "a", "text now")]), Extend::Diverged);
    }

    #[test]
    fn a_pruned_index_holds_only_what_follows_its_base() {
        let mut index = Index::default();
        index.extend((1..=5).map(|n| entry(n, &format!("m{n}"), "x")));
        let gone = index.prune_before(4);
        assert_eq!(gone.len(), 3);
        assert_eq!(index.base(), 4);
        assert_eq!(index.entries().len(), 2);
        // Cut messages coming back in a read are skipped; the rest continue.
        assert_eq!(
            index.extend((3..=7).map(|n| entry(n, &format!("m{n}"), "x"))),
            Extend::Continued
        );
        assert_eq!(index.entries().len(), 4);
        assert_eq!(index.read_after(), Some(6));
        assert_eq!(index.extend([entry(4, "other", "x")]), Extend::Diverged);
        index.truncate(1);
        assert!(index.entries().is_empty());
        assert_eq!(Index::starting_at(4).read_after(), Some(3));
        assert_eq!(Index::starting_at(2).read_after(), Some(1));
        assert_eq!(Index::default().read_after(), None);
    }
}
