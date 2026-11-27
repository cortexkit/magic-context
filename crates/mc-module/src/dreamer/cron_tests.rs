use chrono::{FixedOffset, Local, NaiveDate, NaiveDateTime, TimeZone};

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

#[test]
#[cfg_attr(
    windows,
    ignore = "Windows Local does not honor POSIX TZ; see dst_schedule_runs_the_first_repeated_minute_and_skips_the_missing_minute"
)]
fn a_repeated_wall_clock_minute_matches_only_on_its_first_occurrence() {
    const CHILD: &str = "MC_CRON_TEST_DST_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let (_, module) = module_path!().split_once("::").unwrap();
        let name =
            format!("{module}::a_repeated_wall_clock_minute_matches_only_on_its_first_occurrence");
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", &name, "--nocapture"])
            .env("TZ", ":/usr/share/zoneinfo/America/New_York")
            .env(CHILD, "1")
            .output()
            .unwrap();
        let output = String::from_utf8_lossy(&result.stdout);
        let error = String::from_utf8_lossy(&result.stderr);
        assert!(
            output.contains("running 1 test") && result.status.success(),
            "{output}\n{error}"
        );
        return;
    }
    let chrono::LocalResult::Ambiguous(first, second) =
        Local.with_ymd_and_hms(2026, 11, 1, 1, 30, 0)
    else {
        panic!("the test timezone must repeat 01:30");
    };
    assert_ne!(first.offset(), second.offset());
    let mut slots = [first.timestamp_millis(), second.timestamp_millis()];
    slots.sort_unstable();
    let [first, second] = slots;
    assert_eq!(second - first, 60 * MINUTE);
    assert_eq!(
        Local.timestamp_millis_opt(second).single().unwrap().hour(),
        1,
        "the later instant must really be the repeated 01:30"
    );
    assert_eq!(next_due("30 1 * * *", first - MINUTE), Some(first));
    assert_eq!(
        next_due("30 1 * * *", first + MINUTE),
        Some(local(2026, 11, 2, 1, 30))
    );
    assert_eq!(
        next_due("30 2 * * *", local(2026, 3, 8, 1, 59)),
        Some(local(2026, 3, 9, 2, 30))
    );
}

// A fixed fixture with the 2026 US Eastern transitions, independent of the
// machine's zone and without making the scheduler depend on a timezone table.
#[derive(Clone)]
struct DstZone;

fn transition(month: u32, day: u32, hour: u32) -> NaiveDateTime {
    NaiveDate::from_ymd_opt(2026, month, day)
        .unwrap()
        .and_hms_opt(hour, 0, 0)
        .unwrap()
}

impl TimeZone for DstZone {
    type Offset = FixedOffset;

    fn from_offset(_offset: &Self::Offset) -> Self {
        Self
    }

    fn offset_from_utc_date(&self, date: &NaiveDate) -> Self::Offset {
        self.offset_from_utc_datetime(&date.and_hms_opt(0, 0, 0).unwrap())
    }

    fn offset_from_utc_datetime(&self, utc: &NaiveDateTime) -> Self::Offset {
        let daylight = (transition(3, 8, 7)..transition(11, 1, 6)).contains(utc);
        FixedOffset::west_opt(if daylight { 4 } else { 5 } * 3600).unwrap()
    }

    fn offset_from_local_date(&self, date: &NaiveDate) -> LocalResult<Self::Offset> {
        self.offset_from_local_datetime(&date.and_hms_opt(0, 0, 0).unwrap())
    }

    fn offset_from_local_datetime(&self, local: &NaiveDateTime) -> LocalResult<Self::Offset> {
        // Keep only offsets that round-trip through one of the real instants.
        let mut offsets = [4, 5]
            .map(|hours| FixedOffset::west_opt(hours * 3600).unwrap())
            .into_iter()
            .filter(|offset| {
                local
                    .checked_sub_offset(*offset)
                    .is_some_and(|utc| self.offset_from_utc_datetime(&utc) == *offset)
            });
        match (offsets.next(), offsets.next()) {
            (Some(first), Some(second)) => LocalResult::Ambiguous(first, second),
            (Some(only), None) => LocalResult::Single(only),
            _ => LocalResult::None,
        }
    }
}

#[test]
fn dst_schedule_runs_the_first_repeated_minute_and_skips_the_missing_minute() {
    let zone = DstZone;
    let LocalResult::Ambiguous(first, second) = zone.with_ymd_and_hms(2026, 11, 1, 1, 30, 0) else {
        panic!("the fixture must repeat 01:30");
    };
    assert_ne!(first.offset(), second.offset());
    assert_eq!((second.hour(), second.minute()), (1, 30));
    let (first, second) = (first.timestamp_millis(), second.timestamp_millis());
    assert_eq!(second - first, 60 * MINUTE);
    let local = |month, day, hour, minute| {
        zone.with_ymd_and_hms(2026, month, day, hour, minute, 0)
            .single()
            .unwrap()
            .timestamp_millis()
    };
    assert_eq!(
        next_due_in(&zone, "30 1 * * *", first - MINUTE),
        Some(first)
    );
    assert_eq!(
        next_due_in(&zone, "30 1 * * *", first + MINUTE),
        Some(local(11, 2, 1, 30))
    );
    assert!(matches!(
        zone.with_ymd_and_hms(2026, 3, 8, 2, 30, 0),
        LocalResult::None
    ));
    assert_eq!(
        next_due_in(&zone, "30 2 * * *", local(3, 8, 1, 59)),
        Some(local(3, 9, 2, 30))
    );
}
