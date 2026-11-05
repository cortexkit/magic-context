use super::*;

pub(super) fn message_state(snapshot: &Snapshot, mid: &str, ordinal: Option<u64>) -> Value {
    let archived = Message {
        ordinal: ordinal
            .or_else(|| {
                snapshot.compartments.iter().find_map(|c| {
                    if c["first_message_id"] == mid {
                        c["first_message_ordinal"].as_u64()
                    } else if c["last_message_id"] == mid {
                        c["last_message_ordinal"].as_u64()
                    } else {
                        None
                    }
                })
            })
            .unwrap_or(u64::MAX),
        at_ms: 0,
        row: json!({"message_id":mid, "state":"outside", "compartment_id":null, "outside_reason":"not_indexed", "split":null, "parts":{"tagged":0,"stamped":0,"dropped":0}, "stamped_parts":[], "dropped_parts":[]}),
    };
    let message = snapshot.messages.get(mid).unwrap_or(&archived);
    let mut row = message.row.clone();
    // Older snapshots predate per-part accounting and cannot recover part
    // identities without the transcript. Keep their item list explicitly empty.
    if row.get("items").is_none() {
        row["items"] = json!([]);
    }
    if let Some(compartment) = snapshot.compartments.iter().find(|c| {
        c["first_message_ordinal"].as_u64().unwrap_or(u64::MAX) <= message.ordinal
            && c["last_message_ordinal"].as_u64().unwrap_or(0) >= message.ordinal
    }) {
        row["state"] = json!("summarized");
        row["outside_reason"] = Value::Null;
        row["compartment_id"] = compartment["compartment_id"].clone();
        row["stamped_parts"] = json!([]);
        row["dropped_parts"] = json!([]);
        row["parts"]["stamped"] = json!(0);
        row["parts"]["dropped"] = json!(0);
    }
    row
}
