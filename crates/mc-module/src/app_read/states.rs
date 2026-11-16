use super::*;

/// The row `context.states` returns for message `mid`: its stored row, or
/// an outside row for a message the replica holds no row of, placed by
/// `ordinal` when that is known. A message a summary covers reads as
/// summarized.
pub(super) fn message_state(snapshot: &Snapshot, mid: &str, ordinal: Option<u64>) -> Value {
    let (ordinal, mut row) = match snapshot.messages.get(mid) {
        Some(message) => (message.ordinal, message.row.to_value(mid)),
        None => (
            ordinal
                .or_else(|| {
                    snapshot.compartments.iter().find_map(|c| {
                        if *c.first_message_id == *mid {
                            u64::try_from(c.first_message_ordinal).ok()
                        } else if *c.last_message_id == *mid {
                            u64::try_from(c.last_message_ordinal).ok()
                        } else {
                            None
                        }
                    })
                })
                .unwrap_or(u64::MAX),
            json!({"message_id":mid, "state":"outside", "compartment_id":null, "outside_reason":"not_indexed", "split":null, "parts":{"tagged":0,"stamped":0,"dropped":0}, "stamped_parts":[], "dropped_parts":[]}),
        ),
    };
    // Older snapshots predate per-part accounting and cannot recover part
    // identities without the transcript. Keep their item list explicitly empty.
    if row.get("items").is_none() {
        row["items"] = json!([]);
    }
    if let Some(compartment) = snapshot.compartments.iter().find(|c| c.covers(ordinal)) {
        row["state"] = json!("summarized");
        row["outside_reason"] = Value::Null;
        row["compartment_id"] = json!(compartment.id());
        row["stamped_parts"] = json!([]);
        row["dropped_parts"] = json!([]);
        row["parts"]["stamped"] = json!(0);
        row["parts"]["dropped"] = json!(0);
    }
    row
}
