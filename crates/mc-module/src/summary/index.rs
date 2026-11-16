//! A session's summaries as it holds them in memory: a small index entry for
//! every summary, and the full rows of only the newest ones.
//!
//! A head session can have thousands of summaries, and their text is most
//! of what it would otherwise hold. Between folds the history head needs the
//! text of only the summaries newer than its baseline, which `m[1]` shows at
//! full detail: those rows stay in memory, so a refresh renders exactly the
//! bytes it showed before. Every other summary's text stays in `context.db`
//! and is read when a fold renders `m[0]` again, when a summary run needs the
//! bodies of the references it chose, or when a read asks for every row.

use std::collections::BTreeMap;
use std::sync::Arc;

use crate::context_db::{ContextDb, StoredCompartment};

/// What the session keeps of every summary: where it sits in the transcript
/// and what decisions about it read, without its text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SummaryIndex {
    pub sequence: i64,
    /// The first and last message the summary covers, by the runner's
    /// ordinal, and their ids.
    pub start_message: i64,
    pub end_message: i64,
    pub start_message_id: String,
    pub end_message_id: String,
    pub importance: i32,
    pub created_at: i64,
    /// Whether the summary has a title, a body or a tier. One with none
    /// still covers its messages, but is never rendered or shown to the
    /// summarizer as a reference.
    pub has_content: bool,
}

impl From<&StoredCompartment> for SummaryIndex {
    fn from(row: &StoredCompartment) -> Self {
        let tiers_empty = [&row.p2, &row.p3, &row.p4]
            .iter()
            .all(|tier| tier.as_deref().unwrap_or("").is_empty());
        Self {
            sequence: row.sequence,
            start_message: row.start_message,
            end_message: row.end_message,
            start_message_id: row.start_message_id.clone(),
            end_message_id: row.end_message_id.clone(),
            importance: row.importance,
            created_at: row.created_at,
            has_content: !(row.title.is_empty()
                && row.content.is_empty()
                && row.p1.as_deref().unwrap_or("").is_empty()
                && tiers_empty),
        }
    }
}

/// A session's summaries, oldest first (in sequence order), with a revision
/// that every change moves on. Values derived from the summaries are kept
/// against the revision they were derived at, instead of being derived again
/// on every step or compared summary by summary. Changes go through the
/// methods below, so none can leave the revision behind.
///
/// Every summary has an entry in the index; the full rows `held` are those
/// the history head may still show in `m[1]` (see [`Summaries::release_through`]).
/// Cloning shares the index, so a summary run takes the list without a copy.
#[derive(Clone, Debug, Default)]
pub struct Summaries {
    index: Arc<Vec<SummaryIndex>>,
    held: BTreeMap<i64, Arc<StoredCompartment>>,
    revision: u64,
}

impl Summaries {
    pub(crate) fn revision(&self) -> u64 {
        self.revision
    }

    /// Every summary's row, all held until [`Summaries::release_through`].
    pub(crate) fn replace(&mut self, list: Vec<StoredCompartment>) {
        self.index = Arc::new(list.iter().map(SummaryIndex::from).collect());
        self.held = list
            .into_iter()
            .map(|row| (row.sequence, Arc::new(row)))
            .collect();
        self.revision += 1;
    }

    pub(crate) fn truncate(&mut self, len: usize) {
        if len < self.index.len() {
            for removed in &self.index[len..] {
                self.held.remove(&removed.sequence);
            }
            Arc::make_mut(&mut self.index).truncate(len);
        }
        self.revision += 1;
    }

    /// Newly published summaries: newer than any baseline, so held.
    pub(crate) fn extend(&mut self, summaries: impl IntoIterator<Item = StoredCompartment>) {
        let index = Arc::make_mut(&mut self.index);
        for row in summaries {
            index.push(SummaryIndex::from(&row));
            self.held.insert(row.sequence, Arc::new(row));
        }
        self.revision += 1;
    }

    #[cfg(test)]
    pub(crate) fn push(&mut self, summary: StoredCompartment) {
        self.extend([summary]);
    }

    /// Edit the summaries' rows in place; the index follows the edit when
    /// the returned rows are dropped. Every row must be held.
    #[cfg(test)]
    pub(crate) fn edit(&mut self) -> EditRows<'_> {
        let rows = self
            .index
            .iter()
            .map(|entry| (*self.held[&entry.sequence]).clone())
            .collect();
        EditRows {
            summaries: self,
            rows,
        }
    }

    /// Stop holding the text of summaries at or before `sequence`: no
    /// baseline the head may still render `m[1]` against shows them there,
    /// and a fold reads them back from `context.db`. The index is unchanged,
    /// so the revision is too.
    pub(crate) fn release_through(&mut self, sequence: i64) {
        self.held = self.held.split_off(&(sequence + 1));
    }

    /// How many summaries' full rows are held in memory.
    #[cfg(test)]
    pub(crate) fn held(&self) -> usize {
        self.held.len()
    }

    /// The full rows of the summaries at `positions` in the list, in that
    /// order: held rows as they are in memory, the others read from
    /// `context.db` in one read. `Err` when the read fails or a summary is
    /// no longer stored there.
    pub(crate) fn rows(
        &self,
        positions: impl IntoIterator<Item = usize>,
        store: Option<(&ContextDb, &str, &str)>,
    ) -> Result<Vec<Arc<StoredCompartment>>, String> {
        let wanted: Vec<&SummaryIndex> = positions
            .into_iter()
            .map(|position| &self.index[position])
            .collect();
        let missing: Vec<i64> = wanted
            .iter()
            .map(|entry| entry.sequence)
            .filter(|sequence| !self.held.contains_key(sequence))
            .collect();
        let mut read = BTreeMap::new();
        if !missing.is_empty() {
            let Some((db, harness, session)) = store else {
                return Err("no store holds the summaries' text".into());
            };
            for row in db.compartments_with_sequences(harness, session, &missing)? {
                read.insert(row.sequence, Arc::new(row));
            }
        }
        wanted
            .iter()
            .map(|entry| {
                self.held
                    .get(&entry.sequence)
                    .or_else(|| read.get(&entry.sequence))
                    .cloned()
                    .ok_or_else(|| format!("summary {} is not in context.db", entry.sequence))
            })
            .collect()
    }

    /// The full rows of the summaries newer than `sequence`, oldest first.
    pub(crate) fn rows_after(
        &self,
        sequence: i64,
        store: Option<(&ContextDb, &str, &str)>,
    ) -> Result<Vec<Arc<StoredCompartment>>, String> {
        let first = self
            .index
            .partition_point(|entry| entry.sequence <= sequence);
        self.rows(first..self.index.len(), store)
    }
}

impl std::ops::Deref for Summaries {
    type Target = [SummaryIndex];
    fn deref(&self) -> &[SummaryIndex] {
        &self.index
    }
}

/// The summaries' rows open for a test to edit ([`Summaries::edit`]). When
/// it is dropped, the summaries become these rows, all held.
#[cfg(test)]
pub(crate) struct EditRows<'a> {
    summaries: &'a mut Summaries,
    rows: Vec<StoredCompartment>,
}

#[cfg(test)]
impl std::ops::Deref for EditRows<'_> {
    type Target = Vec<StoredCompartment>;
    fn deref(&self) -> &Vec<StoredCompartment> {
        &self.rows
    }
}

#[cfg(test)]
impl std::ops::DerefMut for EditRows<'_> {
    fn deref_mut(&mut self) -> &mut Vec<StoredCompartment> {
        &mut self.rows
    }
}

#[cfg(test)]
impl Drop for EditRows<'_> {
    fn drop(&mut self) {
        self.summaries.replace(std::mem::take(&mut self.rows));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Store summary `sequence` for session `s1` and return it as read back.
    fn store(db: &ContextDb, sequence: i64, body: &str) -> StoredCompartment {
        db.with_connection(|conn| {
            conn.execute(
                "INSERT INTO compartments (session_id, sequence, start_message, end_message,
                    start_message_id, end_message_id, title, content, p1, importance, created_at, harness)
                 VALUES ('s1', ?1, ?1, ?1, 'm' || ?1, 'm' || ?1, 'Work', ?2, ?2, 60, ?1, 'mock')",
                rusqlite::params![sequence, body],
            )
        })
        .unwrap();
        db.compartments("mock", "s1")
            .unwrap()
            .into_iter()
            .find(|row| row.sequence == sequence)
            .unwrap()
    }

    fn sequences(rows: &[Arc<StoredCompartment>]) -> Vec<i64> {
        rows.iter().map(|row| row.sequence).collect()
    }

    #[test]
    fn letting_text_go_keeps_every_index_entry_and_the_revision() {
        let mut summaries = Summaries::default();
        summaries.replace(
            (1..=5)
                .map(|sequence| StoredCompartment {
                    sequence,
                    title: "Work".into(),
                    ..StoredCompartment::default()
                })
                .collect(),
        );
        let revision = summaries.revision();
        summaries.release_through(3);
        assert_eq!(summaries.len(), 5);
        assert_eq!(summaries.held(), 2);
        assert_eq!(summaries.revision(), revision);
        assert_eq!(sequences(&summaries.rows_after(3, None).unwrap()), [4, 5]);
        assert!(
            summaries.rows(0..5, None).is_err(),
            "text let go needs a store to read it back from"
        );
        summaries.truncate(4);
        assert_eq!(summaries.held(), 1);
        assert_eq!(summaries.revision(), revision + 1);
    }

    #[test]
    fn rows_not_held_are_read_from_context_db_and_held_rows_from_memory() {
        let dir = tempfile::tempdir().unwrap();
        let db = ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
        let rows: Vec<_> = (1..=3)
            .map(|sequence| store(&db, sequence, &format!("Body {sequence}")))
            .collect();
        let mut summaries = Summaries::default();
        summaries.replace(rows.clone());
        summaries.release_through(2);
        db.with_connection(|conn| {
            conn.execute_batch("UPDATE compartments SET content = 'Edited', p1 = 'Edited';")
        })
        .unwrap();
        let read = summaries
            .rows(0..3, Some((&db, "mock", "s1")))
            .unwrap();
        assert_eq!(&*read[0].content, "Edited");
        assert_eq!(&*read[1].content, "Edited");
        assert_eq!(*read[2], rows[2], "a held row stays as it was");

        db.with_connection(|conn| conn.execute_batch("DELETE FROM compartments WHERE sequence = 1;"))
            .unwrap();
        assert_eq!(
            summaries.rows(0..3, Some((&db, "mock", "s1"))).unwrap_err(),
            "summary 1 is not in context.db"
        );
    }

    #[test]
    fn a_summary_has_content_when_any_text_field_does() {
        let empty = StoredCompartment::default();
        assert!(!SummaryIndex::from(&empty).has_content);
        let with = |edit: fn(&mut StoredCompartment)| {
            let mut row = StoredCompartment::default();
            edit(&mut row);
            SummaryIndex::from(&row).has_content
        };
        assert!(with(|row| row.title = "Work".into()));
        assert!(with(|row| row.content = "Body".into()));
        assert!(with(|row| row.p1 = Some("Body".into())));
        assert!(with(|row| row.p4 = Some("Cue".into())));
        assert!(!with(|row| row.p2 = Some(String::new())));
    }
}
