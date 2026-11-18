//! The days a summary's heading in the history head shows: when the
//! summary's first and last message were written, as `YYYY-MM-DD` in UTC.
//!
//! They are found when the head renders (a fold, or `m[1]` showing newer
//! summaries), never stored with the summary. A session looks for each time
//! in the transcript index it holds, then in the times it saved for the
//! messages its index let go, then in the message search index
//! ([`search_times`]), which also holds the standalone plugin's times for a
//! session moved from it. A summary with either time unknown shows no date.

use std::collections::HashMap;

use rusqlite::{params, Connection};

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
/// from the message search index in `context.db`: the time stored with
/// each message the index holds text for, by number. The standalone plugin
/// writes the same rows, from the host's own message times, so a session
/// moved from it finds its older messages' times here. A row is passed over
/// when the index records a different message at that number; an empty id
/// is matched by number alone. Keyed by message number; a time unknown, 0
/// or unreadable is left out.
pub(crate) fn search_times(
    conn: &Connection,
    harness: &str,
    session: &str,
    boundaries: &[(i64, &str)],
) -> HashMap<i64, u64> {
    let Ok(mut statement) = conn.prepare_cached(
        "SELECT map.message_time_ms FROM message_fts_rowid_map map
          WHERE map.session_id = ?1 AND map.message_ordinal = ?2
            AND NOT EXISTS (
                SELECT 1 FROM message_history_source src
                 WHERE src.session_id = map.session_id
                   AND src.message_ordinal = map.message_ordinal
                   AND src.harness = ?3
                   AND ?4 <> '' AND src.message_id <> ?4)",
    ) else {
        return HashMap::new();
    };
    boundaries
        .iter()
        .filter_map(|(number, mid)| {
            let at: Option<i64> = statement
                .query_row(params![session, number, harness, mid], |row| row.get(0))
                .ok()?;
            let at = u64::try_from(at?).ok().filter(|at| *at > 0)?;
            Some((*number, at))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(times, HashMap::from([(1, 1_772_668_800_000)]));
        // An empty id is matched by number alone.
        assert_eq!(
            search_times(&conn, "mock", "s", &[(2, "")]),
            HashMap::from([(2, 1_772_755_200_000)])
        );
    }
}
