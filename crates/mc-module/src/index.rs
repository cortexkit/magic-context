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
use std::sync::Arc;

/// Whether `new` is `held` with only tool parts changed: the same parts in
/// the same order, each the same or a tool part (its status, result, or a
/// reminder that rode on its result: a message a module asked the runner to
/// deliver with the next tool result, `session.send` with `tool_result`
/// delivery).
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
    entries: Arc<Vec<Entry>>,
    /// The token family the held entries' counts were made in (compaction
    /// contract W4.11): the family named by the last page or notice that
    /// carried counts.
    family: Option<String>,
    app_identity: u64,
    app_changed: std::collections::BTreeSet<u64>,
    app_truncated: Option<u64>,
    app_pruned: Option<u64>,
    positions: std::collections::HashMap<String, u64>,
    summary_changed: Option<u64>,
}

/// An empty index that holds the whole transcript, from its first entry.
impl Default for Index {
    fn default() -> Self {
        Self::starting_at(1)
    }
}

/// Forget an entry's token counts: they belong to a family the index no
/// longer holds, or came without the family that gives them meaning.
fn clear_counts(entry: &mut Entry) {
    entry.reasoning_tokens = None;
    for part in &mut entry.parts {
        part.tokens = None;
        if let PartBody::Tool(tool) = &mut part.body {
            for ride in tool.delivered_mut() {
                ride.tokens = None;
            }
        }
    }
}

/// Take `new`'s counts into `held`, the same message with the same content.
/// Counts sit outside the checksum, so they can arrive after the message, or
/// change when the family does; a count `new` lacks is kept. Says whether
/// any count changed.
fn refresh_counts(held: &mut Entry, new: &Entry) -> bool {
    let mut changed = false;
    if new.reasoning_tokens.is_some() && held.reasoning_tokens != new.reasoning_tokens {
        held.reasoning_tokens = new.reasoning_tokens;
        changed = true;
    }
    for (held, new) in held.parts.iter_mut().zip(&new.parts) {
        if held.id != new.id {
            continue;
        }
        if new.tokens.is_some() && held.tokens != new.tokens {
            held.tokens = new.tokens;
            changed = true;
        }
        if let (PartBody::Tool(held), PartBody::Tool(new)) = (&mut held.body, &new.body) {
            for (held, new) in held
                .delivered_mut()
                .iter_mut()
                .zip(new.delivered().unwrap_or_default())
            {
                if new.tokens.is_some() && held.tokens != new.tokens {
                    held.tokens = new.tokens;
                    changed = true;
                }
            }
        }
    }
    changed
}

/// What adding entries did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Extend {
    /// The entries continued the index (or repeated what it holds).
    Continued,
    /// The first new entry is beyond the end: something was missed.
    Gap,
    /// An entry differs from what the index holds at its ordinal in a way
    /// the contract does not allow for a stored message (compaction contract P5): it is another
    /// message, or more than a tool result changed.
    Diverged,
}

impl Index {
    /// An empty index that holds the transcript from `base` on.
    pub fn starting_at(base: u64) -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        Self {
            base,
            entries: Arc::new(Vec::new()),
            family: None,
            app_identity: NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            app_changed: Default::default(),
            app_truncated: None,
            app_pruned: None,
            positions: Default::default(),
            summary_changed: Some(base),
        }
    }

    /// The first ordinal the index holds (or will hold, while empty).
    pub fn base(&self) -> u64 {
        self.base
    }

    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    /// The trigger cache has its own change cursor. Readers of application
    /// data consume a separate cursor, so neither can hide an invalidation
    /// from the other.
    pub(crate) fn summary_changes(&mut self) -> (u64, Option<u64>) {
        (self.app_identity, self.summary_changed.take())
    }

    /// The ordinal of the held entry `mid`, if the index holds it.
    pub fn ordinal_of(&self, mid: &str) -> Option<u64> {
        self.positions.get(mid).copied()
    }

    /// Share the held window with asynchronous readers without copying its
    /// entries. Later mutations copy only if a reader still holds a snapshot.
    pub(crate) fn snapshot(&self) -> Arc<Vec<Entry>> {
        self.entries.clone()
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
        self.extend_counted(incoming, None)
    }

    /// [`Index::extend`] with the token family the page or notice named for
    /// the counts its entries carry. As the contract asks of a reader, a new
    /// family discards every count held in another one (they are estimated
    /// until the runner sends new ones), and counts that arrive without a
    /// family are dropped. A response with no family carries no counts and
    /// leaves the held ones alone.
    pub fn extend_counted(
        &mut self,
        incoming: impl IntoIterator<Item = Entry>,
        family: Option<&str>,
    ) -> Extend {
        if let Some(family) = family.filter(|family| self.family.as_deref() != Some(*family)) {
            self.summary_changed = Some(self.base);
            Arc::make_mut(&mut self.entries)
                .iter_mut()
                .for_each(clear_counts);
            // Every message's weights changed, and the apps show them.
            self.app_changed
                .extend(self.entries.iter().map(|entry| entry.ordinal));
            self.family = Some(family.to_owned());
        }
        for mut entry in incoming {
            if family.is_none() {
                clear_counts(&mut entry);
            }
            let next = self.base + self.entries.len() as u64;
            // Before the base: a message the view already cut.
            if entry.ordinal < self.base {
                continue;
            }
            if entry.ordinal == next {
                self.summary_changed = Some(
                    self.summary_changed
                        .map_or(entry.ordinal, |old| old.min(entry.ordinal)),
                );
                self.app_changed.insert(entry.ordinal);
                self.positions.insert(entry.mid.clone(), entry.ordinal);
                Arc::make_mut(&mut self.entries).push(entry);
                continue;
            }
            if entry.ordinal > next {
                return Extend::Gap;
            }
            let held = &mut Arc::make_mut(&mut self.entries)[(entry.ordinal - self.base) as usize];
            if held.digest == entry.digest && held.mid == entry.mid {
                // The host's finish stamp can arrive after the message was
                // first read. It isn't part of the transcript, so it only
                // fills in the held copy.
                if entry.completed_at.is_some() && held.completed_at != entry.completed_at {
                    held.completed_at = entry.completed_at;
                    self.app_changed.insert(entry.ordinal);
                }
                // Attribution may be backfilled without changing a digest. Once
                // stored, its write-time identity and display name stay frozen.
                if held.speaks_for.is_none() && entry.speaks_for.is_some() {
                    self.summary_changed = Some(
                        self.summary_changed
                            .map_or(entry.ordinal, |old| old.min(entry.ordinal)),
                    );
                    held.speaks_for = entry.speaks_for.clone();
                    self.app_changed.insert(entry.ordinal);
                }
                if refresh_counts(held, &entry) {
                    self.summary_changed = Some(
                        self.summary_changed
                            .map_or(entry.ordinal, |old| old.min(entry.ordinal)),
                    );
                    self.app_changed.insert(entry.ordinal);
                }
                continue;
            }
            // The newest message may still be written; an older one changes
            // only when one of its tool calls gets its result, or a reminder
            // rides on that result (compaction contract P5), even when the
            // host stored the result in a later message.
            let newest = entry.ordinal + 1 == next;
            if held.mid == entry.mid && (newest || only_tool_results_changed(held, &entry)) {
                self.summary_changed = Some(
                    self.summary_changed
                        .map_or(entry.ordinal, |old| old.min(entry.ordinal)),
                );
                self.app_changed.insert(entry.ordinal);
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
        self.summary_changed = Some(self.summary_changed.map_or(ordinal, |old| old.min(ordinal)));
        for entry in self
            .entries
            .iter()
            .skip(ordinal.saturating_sub(self.base) as usize)
        {
            self.positions.remove(&entry.mid);
        }
        self.app_truncated = Some(self.app_truncated.map_or(ordinal, |old| old.min(ordinal)));
        Arc::make_mut(&mut self.entries).truncate(ordinal.saturating_sub(self.base) as usize);
    }

    /// Forget every entry before `ordinal`, which becomes the base. Returns
    /// the entries forgotten.
    pub fn prune_before(&mut self, ordinal: u64) -> Vec<Entry> {
        let count = (ordinal.saturating_sub(self.base) as usize).min(self.entries.len());
        self.base += count as u64;
        if count > 0 {
            self.summary_changed = Some(self.base);
            self.app_pruned = Some(self.base);
        }
        let gone: Vec<_> = Arc::make_mut(&mut self.entries).drain(..count).collect();
        for entry in &gone {
            self.positions.remove(&entry.mid);
        }
        gone
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

    /// The oldest held entry that may still change (compaction contract P5):
    /// one with a tool call still running, or the newest assistant message
    /// on, whose results may yet carry a reminder that rides on them. A read
    /// from here sees every change a notice could not carry.
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
        let entry = self.at(*self.positions.get(mid)?)?;
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

    pub(crate) fn app_changes(&mut self) -> (u64, Vec<u64>, Option<u64>, Option<u64>) {
        (
            self.app_identity,
            std::mem::take(&mut self.app_changed).into_iter().collect(),
            self.app_truncated.take(),
            self.app_pruned.take(),
        )
    }

    pub(crate) fn at(&self, ordinal: u64) -> Option<&Entry> {
        ordinal
            .checked_sub(self.base)
            .and_then(|at| self.entries.get(at as usize))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speaks_for_backfills_without_divergence_and_keeps_the_write_time_identity() {
        let original = entry(1, "m1", "relayed words");
        let mut marked = original.clone();
        marked.speaks_for = Some(
            serde_json::from_value(serde_json::json!({"agent_id":"peer", "name":"Mason"})).unwrap(),
        );
        // The same planned next view must serialize identically after metadata
        // appears on an existing entry, including its content preconditions.
        let next_view = |entry: &Entry| {
            use cortexkit_role_compaction::rules::{EditCost, ProviderRules, SignedParts};
            use cortexkit_role_compaction::view::{EditOp, InsertAt, InsertedMessage};
            let op = EditOp::Insert {
                at: InsertAt::Start,
                message: InsertedMessage::new("history", Role::User, vec!["summary".into()]),
            };
            let replace = EditOp::Replace {
                mid: entry.mid.clone(),
                part: entry.parts[0].id.clone(),
                field: "text".into(),
                value: serde_json::json!("shortened relay"),
                expect: entry.parts[0].digest.clone(),
            };
            crate::view_builder::next_view(
                None,
                std::slice::from_ref(entry),
                vec![op, replace],
                &ProviderRules::new(SignedParts::None, EditCost::Suffix),
                2,
                |_| false,
            )
            .unwrap()
            .unwrap()
        };
        assert_eq!(
            cortexkit_role_compaction::read::entry_digest(
                original.role.clone(),
                original.notice.as_ref(),
                &original.parts
            ),
            cortexkit_role_compaction::read::entry_digest(
                marked.role.clone(),
                marked.notice.as_ref(),
                &marked.parts
            )
        );
        assert_eq!(
            serde_json::to_vec(&next_view(&original)).unwrap(),
            serde_json::to_vec(&next_view(&marked)).unwrap()
        );
        let mut index = Index::default();
        index.extend([original.clone()]);
        index.app_changes();
        assert_eq!(index.extend([marked.clone()]), Extend::Continued);
        assert_eq!(index.entries()[0].speaks_for, marked.speaks_for);
        assert_eq!(index.entries()[0].digest, original.digest);
        assert_eq!(index.app_changes().1, vec![1]);
        index.extend([original]);
        assert_eq!(index.entries()[0].speaks_for, marked.speaks_for);
    }

    #[test]
    fn shared_window_snapshots_are_zero_copy_and_survive_later_mutation() {
        let mut index = Index::default();
        index.extend(vec![entry(1, "a", "first")]);
        let snapshot = index.snapshot();
        assert!(
            std::ptr::eq(index.entries(), snapshot.as_slice()),
            "handoff copied held entries"
        );
        assert!(Arc::ptr_eq(&snapshot, &index.snapshot()));
        index.extend(vec![entry(2, "b", "second")]);
        assert_eq!(snapshot.len(), 1);
        assert_eq!(index.entries().len(), 2);
        index.prune_before(2);
        assert_eq!(snapshot[0].mid, "a");
        assert_eq!(index.entries()[0].mid, "b");
    }
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
    fn a_repeated_message_fills_in_its_finish_stamp() {
        let mut index = Index::default();
        index.extend([entry(1, "a", "one")]);
        assert_eq!(index.entries()[0].completed_at, None);
        let mut finished = entry(1, "a", "one");
        finished.completed_at = Some(42);
        assert_eq!(index.extend([finished]), Extend::Continued);
        assert_eq!(index.entries()[0].completed_at, Some(42));
    }

    fn counted(ordinal: u64, mid: &str, text: &str, count: u64) -> Entry {
        let mut entry = entry(ordinal, mid, text);
        entry.parts[0].tokens = Some(cortexkit_role_compaction::tokens::PartTokens::count(count));
        entry
    }

    fn counts(index: &Index) -> Vec<u64> {
        index
            .entries()
            .iter()
            .map(|entry| crate::tokens::part(&entry.parts[0]))
            .collect()
    }

    #[test]
    fn runner_counts_are_kept_per_family_and_estimated_without_one() {
        let mut index = Index::default();
        // "one two three four" estimates to 5 at four bytes a token.
        let text = "one two three four";
        index.extend_counted([counted(1, "a", text, 4)], Some("claude-v5/1"));
        assert_eq!(counts(&index), [4]);
        // A repeat that brings no count keeps the held one; one that brings a
        // count refreshes it.
        index.extend_counted([entry(1, "a", text)], Some("claude-v5/1"));
        assert_eq!(counts(&index), [4]);
        index.extend_counted([counted(1, "a", text, 3)], Some("claude-v5/1"));
        assert_eq!(counts(&index), [3]);
        // A response with no family carries no counts: held ones stay, and
        // counts on its entries are dropped.
        index.extend_counted([counted(2, "b", text, 9)], None);
        assert_eq!(counts(&index), [3, 5]);
        // A new family discards every count held in the old one.
        index.extend_counted([counted(3, "c", text, 7)], Some("o200k/1"));
        assert_eq!(counts(&index), [5, 5, 7]);
    }

    #[test]
    fn ride_counts_arriving_later_refresh_without_content_changes() {
        use cortexkit_role_compaction::part::Delivered;
        use cortexkit_role_compaction::tokens::TokenCount;

        let mut message = call(1, "a", true);
        let PartBody::Tool(tool) = &mut message.parts[0].body else {
            unreachable!()
        };
        tool.set_delivered(vec![Delivered::new("sender", "ride")]);
        let uncounted = message.clone();
        let mut index = Index::default();
        index.extend_counted([message.clone()], Some("family-a"));
        assert_eq!(counts(&index), [4]);

        let PartBody::Tool(tool) = &mut message.parts[0].body else {
            unreachable!()
        };
        tool.delivered_mut()[0].tokens = Some(TokenCount::new(9));
        assert_eq!(
            index.extend_counted([message], Some("family-a")),
            Extend::Continued
        );
        assert_eq!(counts(&index), [12]);
        index.extend_counted([uncounted], None);
        assert_eq!(counts(&index), [12]);
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
