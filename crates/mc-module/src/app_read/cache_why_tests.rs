//! `context.cache_why {session, views}`: the records of the requested views,
//! read from what the session holds in memory and from the store.

use super::tests::{fixture, replica, request, save_fixture};
use super::*;

const DAY_MS: u64 = 24 * 60 * 60 * 1000;

fn record(version: u64, at_ms: u64) -> Value {
    json!({
        "view_version": version, "view_checksum": format!("checksum-{version}"), "status": "applied",
        "producer_ref": null, "at_ms": at_ms, "decision": "publish", "cause": "history_refresh",
        "changes": {"model": null, "system_prompt": null, "tool_set": null}, "dropped_count": 1,
        "dropped_tokens": 10, "emergency": false, "identity_delta": [], "input_tokens": null,
        "materialized": false,
    })
}

/// What the read serves of a record: every field but the two that carry
/// nothing.
fn served(record: &Value) -> Value {
    let mut record = record.clone();
    let fields = record.as_object_mut().unwrap();
    fields.remove("producer_ref");
    fields.remove("decision");
    record
}

fn views(replica: &mut Replica, views: Value) -> Result<Value, Refusal> {
    replica.read("context.cache_why", &request(json!({ "views": views })))
}

/// A replica that reads the fixture session from `store`, as after a
/// restart: only the newest records are held in memory.
fn from_store(store: &crate::store::Store, decisions: Vec<Value>) -> Replica {
    let mut snapshot = fixture();
    snapshot.decisions = decisions;
    save_fixture(store, &snapshot, None);
    let mut replica = replica(None);
    replica.snapshots.clear();
    replica.store =
        Some(Connection::open_with_flags(&store.path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap());
    replica.load();
    replica
}

#[test]
fn views_answer_each_kept_version_in_ascending_order_and_list_the_missing() {
    let mut replica = replica(None);
    let now = now_ms();
    let kept = [
        record(2, now - 3_000),
        record(5, now - 2_000),
        record(9, now - 1_000),
    ];
    replica.snapshots.get_mut(&fixture().key).unwrap().decisions = kept.to_vec();
    let reply = views(&mut replica, json!([9, 7, 2, 100])).unwrap();
    assert_eq!(reply["state"], "ready");
    assert_eq!(reply["op"], "context.cache_why");
    assert_eq!(reply["schema"], 1);
    assert_eq!(
        reply["decisions"],
        json!([served(&kept[0]), served(&kept[2])])
    );
    assert_eq!(reply["missing"], json!([7, 100]));
    assert_eq!(
        reply["retention"],
        json!({"days": 30, "oldest_at_ms": now - 3_000})
    );
    for field in [
        "join",
        "join_reason",
        "producer_ref_kind",
        "managed",
        "next_cursor",
    ] {
        assert!(reply.get(field).is_none(), "{field}");
    }
    let none = views(&mut replica, json!([1])).unwrap();
    assert_eq!(none["decisions"], json!([]));
    assert_eq!(none["missing"], json!([1]));
}

#[test]
fn views_name_one_to_a_hundred_distinct_versions_and_exclude_the_producers_form() {
    let mut replica = replica(None);
    let hundred: Vec<u64> = (1..=100).collect();
    assert_eq!(
        views(&mut replica, json!(hundred)).unwrap()["missing"],
        json!(hundred)
    );
    let too_many: Vec<u64> = (1..=101).collect();
    for invalid in [
        json!([]),
        json!(too_many),
        json!([1, 1]),
        json!(["1"]),
        json!([-1]),
        json!([1.5]),
        json!(null),
        json!(3),
    ] {
        let refusal = replica
            .read(
                "context.cache_why",
                &request(json!({ "views": invalid.clone() })),
            )
            .unwrap_err();
        assert_eq!(refusal.code, "invalid_params", "{invalid}");
    }
    let both = replica
        .read(
            "context.cache_why",
            &request(json!({"views": [1], "producers": [{"producer_ref": "step-1"}]})),
        )
        .unwrap_err();
    assert_eq!(both.code, "invalid_params");
    let neither = replica
        .read("context.cache_why", &request(json!({})))
        .unwrap_err();
    assert_eq!(neither.code, "invalid_params");
    // The producers form alone is answered as before.
    let producers = replica
        .read(
            "context.cache_why",
            &request(json!({"producers": [{"producer_ref": "step-1"}]})),
        )
        .unwrap();
    assert_eq!(producers["join"], "unavailable");
}

#[test]
fn a_version_older_than_memory_holds_is_read_from_the_store() {
    let dir = tempfile::tempdir().unwrap();
    let store = crate::store::Store::open(&dir.path().join("mode3.db")).unwrap();
    let now = now_ms();
    let records: Vec<Value> = (1..=300).map(|v| record(v, now - 1_000 + v)).collect();
    let mut replica = from_store(&store, records.clone());
    let reply = views(&mut replica, json!([301, 300, 1])).unwrap();
    assert_eq!(
        replica.snapshots[&fixture().key].decisions,
        records[300 - crate::store::VIEW_DECISIONS_IN_MEMORY..],
        "memory holds only the newest records"
    );
    assert_eq!(
        reply["decisions"],
        json!([served(&records[0]), served(&records[299])])
    );
    assert_eq!(reply["missing"], json!([301]));
    assert_eq!(reply["retention"]["oldest_at_ms"], now - 999);
}

#[test]
fn a_record_past_retention_is_missing_and_a_younger_one_is_served() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mode3.db");
    let store = crate::store::Store::open(&path).unwrap();
    let now = now_ms();
    let expired = record(1, now - 31 * DAY_MS);
    let kept = record(2, now - 29 * DAY_MS);
    drop(from_store(&store, vec![expired.clone(), kept.clone()]));
    // Opening the store deletes the expired row.
    drop(crate::store::Store::open(&path).unwrap());
    let mut replica = from_store(&store, vec![]);
    let reply = views(&mut replica, json!([1, 2])).unwrap();
    assert_eq!(reply["decisions"], json!([served(&kept)]));
    assert_eq!(reply["missing"], json!([1]));
    assert_eq!(reply["retention"]["oldest_at_ms"], kept["at_ms"]);

    // A record still held in memory past retention reads as missing too.
    let mut memory = super::tests::replica(None);
    memory.snapshots.get_mut(&fixture().key).unwrap().decisions = vec![expired, kept.clone()];
    let reply = views(&mut memory, json!([1, 2])).unwrap();
    assert_eq!(reply["decisions"], json!([served(&kept)]));
    assert_eq!(reply["missing"], json!([1]));
    assert_eq!(reply["retention"]["oldest_at_ms"], kept["at_ms"]);
}
