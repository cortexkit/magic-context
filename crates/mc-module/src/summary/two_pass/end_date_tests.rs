//! A turn-two decision's `expires`: the calendar date a memory's own text
//! says it stops holding.

use serde_json::json;

use super::*;

fn decision(record: serde_json::Value) -> Entry {
    let reply = json!({"result": {"step": "turn_two", "decisions": [record], "scores": []}});
    let mut envelope = parse(&reply.to_string(), false, false).unwrap();
    envelope.decisions.remove(&7).unwrap()
}

fn expires_of(entry: &Entry) -> Option<&str> {
    match entry {
        Entry::Decision(decision) => decision.expires.as_deref(),
        Entry::Malformed => panic!("malformed: {entry:?}"),
    }
}

#[test]
fn an_end_date_is_read_on_the_actions_that_write_a_memorys_text() {
    let new =
        decision(json!({"fact_id": 7, "check": "c", "action": "new", "expires": "2026-11-20"}));
    assert_eq!(expires_of(&new), Some("2026-11-20"));
    let edit = decision(json!({
        "fact_id": 7, "check": "c", "action": "edit", "target_id": 3, "revision": 1,
        "kept": [], "final_text": "Release freeze until 2026-11-20.", "expires": "2026-11-20"
    }));
    assert_eq!(expires_of(&edit), Some("2026-11-20"));
    let plain = decision(json!({"fact_id": 7, "check": "c", "action": "new"}));
    assert_eq!(expires_of(&plain), None);
}

#[test]
fn an_end_date_on_another_action_or_not_a_real_date_is_malformed() {
    for record in [
        json!({"fact_id": 7, "check": "c", "action": "abstain", "expires": "2026-11-20"}),
        json!({"fact_id": 7, "check": "c", "action": "conflict", "target_id": 3, "expires": "2026-11-20"}),
        json!({"fact_id": 7, "check": "c", "action": "new", "expires": "2026-02-30"}),
        json!({"fact_id": 7, "check": "c", "action": "new", "expires": "2026-11-2"}),
        json!({"fact_id": 7, "check": "c", "action": "new", "expires": "until the migration"}),
        json!({"fact_id": 7, "check": "c", "action": "new", "expires": 20261120}),
    ] {
        assert_eq!(decision(record.clone()), Entry::Malformed, "{record}");
    }
}

#[test]
fn calendar_dates_follow_the_calendar() {
    assert_eq!(calendar_date("2028-02-29"), Some((2028, 2, 29)));
    assert_eq!(calendar_date("2026-02-29"), None);
    assert_eq!(calendar_date("2100-02-29"), None);
    assert_eq!(calendar_date("2000-02-29"), Some((2000, 2, 29)));
    assert_eq!(calendar_date("2026-13-01"), None);
    assert_eq!(calendar_date("2026-00-10"), None);
    assert_eq!(calendar_date("２０２６-11-20"), None);
}

#[test]
fn a_day_ends_at_local_midnight_after_it() {
    let end = end_of_date_ms("2026-11-20").unwrap();
    let previous = end_of_date_ms("2026-11-19").unwrap();
    // One local day apart, give or take a daylight-saving hour.
    assert!(
        (23 * 3_600_000..=25 * 3_600_000).contains(&(end - previous)),
        "{}",
        end - previous
    );
    // The end is local midnight: the local time of that instant is 00:00 on
    // the next day.
    use chrono::{Local, TimeZone, Timelike};
    let local = Local.timestamp_millis_opt(end).unwrap();
    assert_eq!((local.hour(), local.minute()), (0, 0));
    assert_eq!(local.date_naive().to_string(), "2026-11-21");
    assert_eq!(end_of_date_ms("2026-02-30"), None);
}
