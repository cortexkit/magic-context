use super::*;

#[test]
fn a_summary_ending_on_a_null_system_row_trims_to_the_previous_entry() {
    let messages: Vec<HostMessage> = serde_json::from_value(serde_json::json!([
        {"mid":"user","source_entry":1,"entry":1},
        {"mid":"assistant","source_entry":2,"entry":2},
        {"mid":"system","source_entry":3,"entry":null},
        {"mid":"next","source_entry":4,"entry":3}
    ]))
    .unwrap();
    let numbering = Numbering::runner(&messages, &Cursor::new(3, "next", "digest")).unwrap();
    assert_eq!(numbering.range(1, 3), Some((1, 2)));
    assert_eq!(numbering.cut(3), Some((2, "assistant")));
    assert_eq!(numbering.range(3, 4), Some((3, 3)));
    assert_eq!(numbering.range(3, 3), None);
}

#[test]
fn explicit_null_source_entry_is_distinct_from_an_omitted_field() {
    let absent: HostMessage =
        serde_json::from_value(serde_json::json!({"mid":"m","entry":1})).unwrap();
    let null: HostMessage =
        serde_json::from_value(serde_json::json!({"mid":"m","entry":1,"source_entry":null}))
            .unwrap();
    assert_eq!(absent.source_entry, None);
    assert_eq!(null.source_entry, Some(None));
}
