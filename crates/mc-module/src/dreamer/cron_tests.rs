use chrono::{Local, TimeZone};

use super::*;

/// Epoch milliseconds of a local wall-clock time. The tests use dates far
/// from daylight-saving changes, so they hold in any time zone.
fn local(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> i64 {
    Local
        .with_ymd_and_hms(year, month, day, hour, minute, 0)
        .single()
        .unwrap()
        .timestamp_millis()
}

#[test]
fn daily_weekly_and_stepped_schedules() {
    let after = local(2026, 6, 10, 2, 30); // a Wednesday
    assert_eq!(next_due("0 3 * * *", after), Some(local(2026, 6, 10, 3, 0)));
    // The slot itself is not due again: the next one is a day later.
    assert_eq!(
        next_due("0 3 * * *", local(2026, 6, 10, 3, 0)),
        Some(local(2026, 6, 11, 3, 0))
    );
    // Sunday 04:00, written as 0 and as 7.
    assert_eq!(next_due("0 4 * * 0", after), Some(local(2026, 6, 14, 4, 0)));
    assert_eq!(next_due("0 4 * * 7", after), Some(local(2026, 6, 14, 4, 0)));
    assert_eq!(
        next_due("0 */6 * * *", after),
        Some(local(2026, 6, 10, 6, 0))
    );
    assert_eq!(
        next_due("15,45 9-10 * * 1-5", after),
        Some(local(2026, 6, 10, 9, 15))
    );
}

#[test]
fn restricting_both_day_fields_matches_either() {
    // The 1st of the month or any Friday: Friday 12 June comes first.
    let after = local(2026, 6, 10, 12, 0);
    assert_eq!(next_due("0 0 1 * 5", after), Some(local(2026, 6, 12, 0, 0)));
}

#[test]
fn an_empty_invalid_or_impossible_schedule_is_never_due() {
    let after = local(2026, 6, 10, 12, 0);
    for expression in [
        "",
        "  ",
        "0 3 * *",
        "60 3 * * *",
        "0 3 * * 8",
        "*/0 * * * *",
        "a b c d e",
        "0 0 31 2 *",
    ] {
        assert_eq!(next_due(expression, after), None, "{expression:?}");
    }
    // 29 February exists, four years apart at most.
    assert_eq!(
        next_due("0 0 29 2 *", after),
        Some(local(2028, 2, 29, 0, 0))
    );
}
