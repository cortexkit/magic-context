//! ck-mc's index of a session's transcript: every entry in compact form (text
//! in full; tool outputs, reasoning and media as sizes), in transcript order.
//! It is the "what the model is working with" half of ck-mc's picture of a
//! session; the other half is the view the runner applies.
//!
//! The index only grows from the runner's notices and reads. Only the newest
//! message may change after it was written (a tool gets its result), so an
//! entry at a known ordinal with a different id or content means the
//! transcript changed under ck-mc, and the index is rebuilt from a read.

use ck_contract_draft::part::{Part, PartBody};
use ck_contract_draft::read::{Cursor, Entry};

#[derive(Clone, Debug, Default)]
pub struct Index {
    entries: Vec<Entry>,
}

/// What adding entries did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Extend {
    /// The entries continued the index (or repeated what it holds).
    Continued,
    /// The first new entry is beyond the end: something was missed.
    Gap,
    /// An entry differs from what the index holds at its ordinal, and it is
    /// not the newest message being updated.
    Diverged,
}

impl Index {
    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    pub fn cursor(&self) -> Option<Cursor> {
        self.entries.last().map(|entry| Cursor {
            ordinal: entry.ordinal,
            mid: entry.mid.clone(),
            digest: entry.digest.clone(),
        })
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
            let len = self.entries.len() as u64;
            if entry.ordinal == len {
                self.entries.push(entry);
                continue;
            }
            if entry.ordinal > len {
                return Extend::Gap;
            }
            let held = &mut self.entries[entry.ordinal as usize];
            if held.digest == entry.digest && held.mid == entry.mid {
                continue;
            }
            let newest = entry.ordinal + 1 == len;
            if newest && held.mid == entry.mid {
                *held = entry;
                continue;
            }
            return Extend::Diverged;
        }
        Extend::Continued
    }

    /// Forget every entry from `ordinal` on.
    pub fn truncate(&mut self, ordinal: u64) {
        self.entries.truncate(ordinal as usize);
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
    use ck_contract_draft::read::{entry_digest, Role};

    fn entry(ordinal: u64, mid: &str, text: &str) -> Entry {
        let parts = vec![Part::new(
            format!("{mid}:p0"),
            Some(ordinal + 1),
            PartBody::Text { text: text.into() },
        )];
        Entry {
            ordinal,
            mid: mid.into(),
            role: Role::User,
            notice: None,
            written_at: 0,
            digest: entry_digest(Role::User, None, &parts),
            parts,
            usage: None,
            generated_under: None,
        }
    }

    #[test]
    fn entries_extend_repeat_or_update_only_the_newest_message() {
        let mut index = Index::default();
        assert_eq!(
            index.extend([entry(0, "a", "one"), entry(1, "b", "two")]),
            Extend::Continued
        );
        // A repeat changes nothing.
        assert_eq!(index.extend([entry(1, "b", "two")]), Extend::Continued);
        // The newest message may change.
        assert_eq!(
            index.extend([entry(1, "b", "two, done")]),
            Extend::Continued
        );
        assert_eq!(index.find_tag(2).unwrap().0.mid, "b");
        // An older one may not, nor may a different message at a known ordinal.
        assert_eq!(index.extend([entry(0, "a", "changed")]), Extend::Diverged);
        assert_eq!(index.extend([entry(1, "c", "other")]), Extend::Diverged);
        assert_eq!(index.extend([entry(3, "d", "later")]), Extend::Gap);
        index.truncate(1);
        assert_eq!(index.cursor().unwrap().mid, "a");
    }
}
