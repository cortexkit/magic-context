//! The days a summary's heading in the history head shows: when the
//! summary's first and last message were written, as `YYYY-MM-DD` in UTC.
//!
//! They are found when the head renders (a fold, or `m[1]` showing newer
//! summaries), never stored with the summary. A session looks for each
//! boundary message's time in the transcript index it holds, then in the
//! times it saved for the messages its index let go, then in the message
//! search index ([`search_times`]), which also holds the standalone plugin's
//! times for a session moved from it, then in the days `m[1]` already showed
//! for the summary. A boundary message often has no time of its own (the
//! search index times only messages with text), so the last resort is the
//! nearest timed message ([`summary_times`]): the first and last timed
//! message inside the summary's range, else the nearest earlier one, else
//! the next later one. A summary with either day still unknown shows no
//! date.

use std::collections::{BTreeSet, HashMap};

use rusqlite::{params, Connection, OptionalExtension};

/// A session's timed messages, looked up by message number.
pub(crate) trait TimedMessages {
    type Time: Copy;
    /// The first timed message numbered `start..=end`.
    fn first_in(&self, start: i64, end: i64) -> Option<Self::Time>;
    /// The last timed message numbered `start..=end`.
    fn last_in(&self, start: i64, end: i64) -> Option<Self::Time>;
    /// The last timed message before `number`.
    fn last_before(&self, number: i64) -> Option<Self::Time>;
    /// The first timed message after `number`.
    fn first_after(&self, number: i64) -> Option<Self::Time>;
}

/// The times a summary of messages `start..=end` is dated by: the first and
/// the last timed message in its range. A range with none (its messages have
/// no indexed text) still belongs to the session's timeline, so it takes the
/// nearest earlier timed message for both, or, before the session's first
/// timed message, the next later one. `None` only when the session has no
/// timed message at all.
pub(crate) fn summary_times<M: TimedMessages + ?Sized>(
    messages: &M,
    start: i64,
    end: i64,
) -> Option<(M::Time, M::Time)> {
    if let Some(first) = messages.first_in(start, end) {
        return Some((first, messages.last_in(start, end).unwrap_or(first)));
    }
    let nearest = messages
        .last_before(start)
        .or_else(|| messages.first_after(end))?;
    Some((nearest, nearest))
}

/// Where to look for a timed message: the numbers `low..=high`, and which
/// end of them to take.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Near {
    pub low: i64,
    pub high: i64,
    pub newest: bool,
}

impl Near {
    fn first_in(start: i64, end: i64) -> Self {
        Self {
            low: start,
            high: end,
            newest: false,
        }
    }
    fn last_in(start: i64, end: i64) -> Self {
        Self {
            low: start,
            high: end,
            newest: true,
        }
    }
    fn last_before(number: i64) -> Self {
        Self {
            low: i64::MIN,
            high: number.saturating_sub(1),
            newest: true,
        }
    }
    fn first_after(number: i64) -> Self {
        Self {
            low: number.saturating_add(1),
            high: i64::MAX,
            newest: false,
        }
    }
}

/// The times [`summary_times`] found for a session's summaries, by sequence
/// and range, kept in memory for the session: each takes a few indexed
/// queries, and an old summary's messages and their times do not change.
/// A summary whose range is not the one recorded (another summary at the
/// same sequence after a revert) is looked up again.
#[derive(Debug, Default)]
pub(crate) struct NearestTimes(std::sync::Mutex<NearestBySequence>);

/// Each summary sequence's range and the times found for it.
type NearestBySequence = HashMap<i64, ((i64, i64), (u64, u64))>;

impl NearestTimes {
    fn lock(&self) -> std::sync::MutexGuard<'_, NearestBySequence> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub(crate) fn get(&self, sequence: i64, range: (i64, i64)) -> Option<(u64, u64)> {
        self.lock()
            .get(&sequence)
            .filter(|(kept, _)| *kept == range)
            .map(|(_, times)| *times)
    }

    pub(crate) fn keep(&self, sequence: i64, range: (i64, i64), times: (u64, u64)) {
        self.lock().insert(sequence, (range, times));
    }

    /// Forget every summary `keep` says no: the session no longer has it.
    pub(crate) fn retain(&self, keep: impl Fn(i64) -> bool) {
        self.lock().retain(|sequence, _| keep(*sequence));
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.lock().len()
    }
}

/// The timed message `near` asks for in the message search index, as its
/// number and time, in one indexed query. A message the source table records
/// for another harness at that number is passed over. Inside a range the
/// ids are not known, so, unlike [`search_times`], no id is checked: after a
/// revert, a row left from a removed message at a reused number can give an
/// older time until the index is reconciled, and the day shown is then at
/// worst earlier than the true one.
pub(crate) fn search_time_near(
    conn: &Connection,
    harness: &str,
    session: &str,
    near: Near,
) -> Option<(i64, u64)> {
    let sql = |order: &str| {
        format!(
            "SELECT map.message_ordinal, map.message_time_ms
               FROM message_fts_rowid_map map
              WHERE map.session_id = ?1
                AND map.message_ordinal BETWEEN ?2 AND ?3
                AND map.message_time_ms > 0
                AND NOT EXISTS (
                    SELECT 1 FROM message_history_source src
                     WHERE src.session_id = map.session_id
                       AND src.message_ordinal = map.message_ordinal
                       AND src.harness <> ?4)
              ORDER BY map.message_ordinal {order} LIMIT 1"
        )
    };
    let sql = sql(if near.newest { "DESC" } else { "ASC" });
    conn.prepare_cached(&sql)
        .and_then(|mut statement| {
            statement
                .query_row(params![session, near.low, near.high, harness], |row| {
                    Ok((row.get(0)?, row.get::<_, i64>(1)?))
                })
                .optional()
        })
        .ok()
        .flatten()
        .and_then(|(number, at)| Some((number, u64::try_from(at).ok()?)))
}

/// The timed message `near` asks for among the times a session saved for the
/// messages its transcript index let go (`app_read_message_index` in
/// `sessions.db`), as its number and time, in one indexed query.
pub(crate) fn saved_time_near(
    conn: &Connection,
    (runner, harness, session): (&str, &str, &str),
    near: Near,
) -> Option<(i64, u64)> {
    let sql = if near.newest {
        "SELECT ordinal, at_ms FROM app_read_message_index
          WHERE runner = ?1 AND harness = ?2 AND session = ?3
            AND ordinal BETWEEN ?4 AND ?5 AND at_ms > 0
          ORDER BY ordinal DESC LIMIT 1"
    } else {
        "SELECT ordinal, at_ms FROM app_read_message_index
          WHERE runner = ?1 AND harness = ?2 AND session = ?3
            AND ordinal BETWEEN ?4 AND ?5 AND at_ms > 0
          ORDER BY ordinal ASC LIMIT 1"
    };
    conn.prepare_cached(sql)
        .and_then(|mut statement| {
            statement
                .query_row(
                    params![runner, harness, session, near.low, near.high],
                    |row| Ok((row.get(0)?, row.get::<_, i64>(1)?)),
                )
                .optional()
        })
        .ok()
        .flatten()
        .and_then(|(number, at)| Some((number, u64::try_from(at).ok()?)))
}

/// The times saved when the transcript index let messages go and the
/// message search index together, each asked through `saved` and
/// `searched` ([`Near`]). At the same number the saved time wins, as it does
/// for a boundary message.
pub(crate) struct StoredTimes<A, B> {
    pub saved: A,
    pub searched: B,
}

impl<A, B> StoredTimes<A, B>
where
    A: Fn(Near) -> Option<(i64, u64)>,
    B: Fn(Near) -> Option<(i64, u64)>,
{
    fn nearest(&self, near: Near) -> Option<u64> {
        match ((self.saved)(near), (self.searched)(near)) {
            (Some(saved), Some(searched)) => {
                let searched_wins = if near.newest {
                    searched.0 > saved.0
                } else {
                    searched.0 < saved.0
                };
                Some(if searched_wins { searched.1 } else { saved.1 })
            }
            (saved, searched) => saved.or(searched).map(|(_, at)| at),
        }
    }
}

impl<A, B> TimedMessages for StoredTimes<A, B>
where
    A: Fn(Near) -> Option<(i64, u64)>,
    B: Fn(Near) -> Option<(i64, u64)>,
{
    type Time = u64;
    fn first_in(&self, start: i64, end: i64) -> Option<u64> {
        self.nearest(Near::first_in(start, end))
    }
    fn last_in(&self, start: i64, end: i64) -> Option<u64> {
        self.nearest(Near::last_in(start, end))
    }
    fn last_before(&self, number: i64) -> Option<u64> {
        self.nearest(Near::last_before(number))
    }
    fn first_after(&self, number: i64) -> Option<u64> {
        self.nearest(Near::first_after(number))
    }
}

/// The UTC day `ms` (milliseconds since the Unix epoch) falls on, as
/// `YYYY-MM-DD`. `None` for 0, which stands for an unknown time, and for a
/// time past what a date can hold.
pub(crate) fn utc_day(ms: u64) -> Option<String> {
    if ms == 0 {
        return None;
    }
    let ms = i64::try_from(ms).ok()?;
    chrono::DateTime::from_timestamp_millis(ms).map(|at| at.format("%Y-%m-%d").to_string())
}

/// When each of `boundaries` (a message's number and id) was written,
/// from the message search index in `context.db`, in one query: the time
/// stored with each message the index holds text for, by number. The
/// standalone plugin writes the same rows, from the host's own message
/// times, so a session moved from it finds its older messages' times here.
/// A row is passed over when the index records a different message at that
/// number; an empty id is matched by number alone. Keyed by number and id;
/// a time unknown or 0 is left out, as is every time when the read fails.
pub(crate) fn search_times(
    conn: &Connection,
    harness: &str,
    session: &str,
    boundaries: &[(i64, &str)],
) -> HashMap<(i64, String), u64> {
    if boundaries.is_empty() {
        return HashMap::new();
    }
    let numbers: BTreeSet<i64> = boundaries.iter().map(|(number, _)| *number).collect();
    let Ok(wanted) = serde_json::to_string(&numbers) else {
        return HashMap::new();
    };
    // Each number's time, and the ids the index records at it.
    let mut found: HashMap<i64, (Option<i64>, Vec<String>)> = HashMap::new();
    let read = |found: &mut HashMap<i64, (Option<i64>, Vec<String>)>| -> rusqlite::Result<()> {
        let mut statement = conn.prepare_cached(
            "SELECT map.message_ordinal, map.message_time_ms, src.message_id
               FROM message_fts_rowid_map map
               LEFT JOIN message_history_source src
                 ON src.session_id = map.session_id
                AND src.message_ordinal = map.message_ordinal
                AND src.harness = ?3
              WHERE map.session_id = ?1
                AND map.message_ordinal IN (SELECT value FROM json_each(?2))",
        )?;
        let mut rows = statement.query(params![session, wanted, harness])?;
        while let Some(row) = rows.next()? {
            let entry = found.entry(row.get(0)?).or_default();
            entry.0 = row.get(1)?;
            if let Some(mid) = row.get::<_, Option<String>>(2)? {
                entry.1.push(mid);
            }
        }
        Ok(())
    };
    if read(&mut found).is_err() {
        return HashMap::new();
    }
    boundaries
        .iter()
        .filter_map(|(number, mid)| {
            let (at, recorded) = found.get(number)?;
            if !mid.is_empty() && recorded.iter().any(|other| other != mid) {
                return None;
            }
            let at = u64::try_from((*at)?).ok().filter(|at| *at > 0)?;
            Some(((*number, (*mid).to_owned()), at))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Timed messages in a sorted list of `(number, time)`.
    struct Listed(Vec<(i64, u64)>);

    impl TimedMessages for Listed {
        type Time = u64;
        fn first_in(&self, start: i64, end: i64) -> Option<u64> {
            self.0
                .iter()
                .find(|(n, _)| (start..=end).contains(n))
                .map(|t| t.1)
        }
        fn last_in(&self, start: i64, end: i64) -> Option<u64> {
            self.0
                .iter()
                .rev()
                .find(|(n, _)| (start..=end).contains(n))
                .map(|t| t.1)
        }
        fn last_before(&self, number: i64) -> Option<u64> {
            self.0.iter().rev().find(|(n, _)| *n < number).map(|t| t.1)
        }
        fn first_after(&self, number: i64) -> Option<u64> {
            self.0.iter().find(|(n, _)| *n > number).map(|t| t.1)
        }
    }

    #[test]
    fn a_summary_is_dated_by_its_first_and_last_timed_message() {
        let timed = Listed(vec![(3, 30), (5, 50), (7, 70), (20, 200)]);
        // Inside the range: its first and last timed message.
        assert_eq!(summary_times(&timed, 4, 8), Some((50, 70)));
        assert_eq!(summary_times(&timed, 5, 5), Some((50, 50)));
        // None inside: the nearest earlier one, for both days.
        assert_eq!(summary_times(&timed, 8, 19), Some((70, 70)));
        // None earlier either: the next later one.
        assert_eq!(summary_times(&timed, 1, 2), Some((30, 30)));
        // A session with no timed message: undated.
        assert_eq!(summary_times(&Listed(Vec::new()), 1, 2), None);
    }

    #[test]
    fn saved_times_win_over_searched_ones_at_the_same_number() {
        let near = |list: Vec<(i64, u64)>| {
            move |near: Near| {
                let inside = list
                    .iter()
                    .filter(|(n, _)| (near.low..=near.high).contains(n));
                if near.newest {
                    inside.max_by_key(|(n, _)| *n).copied()
                } else {
                    inside.min_by_key(|(n, _)| *n).copied()
                }
            }
        };
        let times = StoredTimes {
            saved: near(vec![(5, 500), (9, 900)]),
            searched: near(vec![(4, 41), (5, 51), (9, 91), (10, 101)]),
        };
        // The nearest of either store; the saved one at the same number.
        assert_eq!(summary_times(&times, 4, 10), Some((41, 101)));
        assert_eq!(summary_times(&times, 5, 9), Some((500, 900)));
        assert_eq!(summary_times(&times, 11, 12), Some((101, 101)));
        assert_eq!(summary_times(&times, 1, 3), Some((41, 41)));
    }

    #[test]
    fn the_nearest_searched_time_passes_over_another_harnesss_message() {
        let conn = crate::context_db::ContextDb::fresh_in_memory();
        conn.execute_batch(
            "INSERT INTO message_fts_rowid_map (session_id, message_ordinal, fts_rowid, message_time_ms)
                VALUES ('s', 2, 1, 200), ('s', 4, 2, 400), ('s', 5, 3, 0), ('s', 6, 4, NULL),
                       ('s', 8, 5, 800), ('other', 7, 6, 700);
             INSERT INTO message_history_source
                (session_id, message_id, message_ordinal, source_version, normalized_content_hash, role, harness, updated_at)
                VALUES ('s', 'a', 4, 'd', 'h', 'user', 'mock', 0),
                       ('s', 'b', 8, 'd', 'h', 'user', 'pi', 0);",
        )
        .unwrap();
        let near = |near: Near| search_time_near(&conn, "mock", "s", near);
        assert_eq!(near(Near::first_in(3, 9)), Some((4, 400)));
        // 8 is another harness's message, 5 and 6 have no time.
        assert_eq!(near(Near::last_in(3, 9)), Some((4, 400)));
        assert_eq!(near(Near::last_before(4)), Some((2, 200)));
        assert_eq!(near(Near::first_after(4)), None);
        assert_eq!(near(Near::first_in(5, 7)), None);
    }

    #[test]
    fn the_nearest_saved_time_is_read_for_the_session_only() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE app_read_message_index (
                runner TEXT NOT NULL, harness TEXT NOT NULL, session TEXT NOT NULL,
                message_id TEXT NOT NULL, ordinal INTEGER NOT NULL, at_ms INTEGER NOT NULL,
                PRIMARY KEY (runner, harness, session, message_id));
             INSERT INTO app_read_message_index VALUES
                ('r', 'h', 's', 'm1', 1, 100), ('r', 'h', 's', 'm3', 3, 0),
                ('r', 'h', 's', 'm4', 4, 400), ('r', 'h', 'other', 'm2', 2, 200),
                ('other', 'h', 's', 'x2', 2, 222);",
        )
        .unwrap();
        let near = |near: Near| saved_time_near(&conn, ("r", "h", "s"), near);
        assert_eq!(near(Near::first_in(2, 4)), Some((4, 400)));
        assert_eq!(near(Near::last_in(1, 3)), Some((1, 100)));
        assert_eq!(near(Near::last_before(4)), Some((1, 100)));
        assert_eq!(near(Near::first_after(1)), Some((4, 400)));
        assert_eq!(near(Near::first_after(4)), None);
    }

    #[test]
    fn nearest_times_are_kept_by_sequence_and_range() {
        let kept = NearestTimes::default();
        kept.keep(3, (10, 20), (1, 2));
        assert_eq!(kept.get(3, (10, 20)), Some((1, 2)));
        // Another summary at the same sequence, after a revert.
        assert_eq!(kept.get(3, (10, 25)), None);
        kept.retain(|sequence| sequence < 3);
        assert_eq!(kept.len(), 0);
    }

    #[test]
    fn a_day_is_the_utc_date_of_the_time() {
        // 2026-03-04T23:59:59.999Z and one millisecond later.
        assert_eq!(utc_day(1_772_668_799_999).as_deref(), Some("2026-03-04"));
        assert_eq!(utc_day(1_772_668_800_000).as_deref(), Some("2026-03-05"));
        assert_eq!(utc_day(0), None);
        assert_eq!(utc_day(u64::MAX), None);
    }

    #[test]
    fn search_times_are_read_by_number_and_skip_another_message_at_it() {
        let conn = crate::context_db::ContextDb::fresh_in_memory();
        conn.execute_batch(
            "INSERT INTO message_fts_rowid_map (session_id, message_ordinal, fts_rowid, message_time_ms)
                VALUES ('s', 1, 1, 1772668800000), ('s', 2, 2, 1772755200000),
                       ('s', 3, 3, NULL), ('s', 4, 4, 0), ('other', 5, 5, 1772668800000);
             INSERT INTO message_history_source
                (session_id, message_id, message_ordinal, source_version, normalized_content_hash, role, harness, updated_at)
                VALUES ('s', 'm1', 1, 'd', 'h', 'user', 'mock', 0),
                       ('s', 'replaced', 2, 'd', 'h', 'user', 'mock', 0);",
        )
        .unwrap();
        let times = search_times(
            &conn,
            "mock",
            "s",
            &[
                (1, "m1"),
                (2, "m2"),
                (3, "m3"),
                (4, "m4"),
                (5, "m5"),
                (6, ""),
            ],
        );
        assert_eq!(
            times,
            HashMap::from([((1, "m1".to_owned()), 1_772_668_800_000)])
        );
        // An empty id is matched by number alone.
        assert_eq!(
            search_times(&conn, "mock", "s", &[(2, "")]),
            HashMap::from([((2, String::new()), 1_772_755_200_000)])
        );
    }
}
