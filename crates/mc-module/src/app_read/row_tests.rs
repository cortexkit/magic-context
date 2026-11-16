//! Typed app rows render exactly the JSON the projection built, survive their
//! compact encoding, and keep any other shape as the JSON it was.
use super::row::*;
use cortexkit_role_compaction::read::HostPart;
use serde_json::{json, Value};

fn part(id: &str, kind: Kind, state: PartState, origin: PartOrigin) -> Part {
    Part {
        id: id.into(),
        kind,
        tokens: 7,
        source: Source::Counted,
        state,
        origin,
        tool: None,
    }
}

fn size(bytes: Option<u64>) -> Size {
    Size { bytes, tokens: 3 }
}

/// Rows with every part state, origin, tool and host fact a row can carry.
fn typed_rows() -> Vec<Typed> {
    let notice = Origin::Notice {
        sender: "prefrontal".into(),
        speaks_for: Some(("agent-1".into(), Some("BROCA".into()))),
    };
    let unnamed_notice = Origin::Notice {
        sender: "prefrontal".into(),
        speaks_for: Some(("agent-2".into(), None)),
    };
    let plain_notice = Origin::Notice {
        sender: "subc".into(),
        speaks_for: None,
    };
    let agent = Origin::Agent {
        agent_id: "agent-3".into(),
        name: Some("SUBC".into()),
    };
    let unnamed_agent = Origin::Agent {
        agent_id: "agent-4".into(),
        name: None,
    };
    let mut tool = part(
        "call",
        Kind::Tool,
        PartState::Stamped {
            at_ms: Some(123),
            size: size(Some(4000)),
        },
        PartOrigin::None,
    );
    tool.tool = Some("read".into());
    tool.source = Source::Runner;
    let mut reasoning = part(
        "think",
        Kind::Reasoning,
        PartState::Dropped { size: size(None) },
        PartOrigin::None,
    );
    reasoning.source = Source::Reported;
    let mut unstamped = part(
        "later",
        Kind::Opaque,
        PartState::Stamped {
            at_ms: None,
            size: size(Some(0)),
        },
        PartOrigin::None,
    );
    unstamped.source = Source::Estimate;
    vec![
        Typed::new(
            2,
            vec![
                part("p", Kind::Text, PartState::Live, PartOrigin::User),
                part(
                    "host",
                    Kind::Text,
                    PartState::Live,
                    PartOrigin::Host(Some("continue".into())),
                ),
                part("bare", Kind::Text, PartState::Live, PartOrigin::Host(None)),
                part("file", Kind::File, PartState::Live, PartOrigin::None),
            ],
            Some(&Origin::Person),
            &[
                HostPart::new("host").with_host_code("continue"),
                HostPart::new("bare"),
            ],
        ),
        Typed::new(
            1,
            vec![tool, reasoning, unstamped],
            None,
            &[],
        ),
        Typed::new(
            1,
            vec![part(
                "p",
                Kind::Text,
                PartState::Dropped { size: size(Some(12)) },
                PartOrigin::User,
            )],
            Some(&notice),
            &[],
        ),
        Typed::new(
            0,
            vec![
                part("a", Kind::Text, PartState::Cut, PartOrigin::User),
                part("b", Kind::Reasoning, PartState::Cut, PartOrigin::None),
            ],
            Some(&unnamed_notice),
            &[],
        ),
        Typed::new(
            1,
            vec![part("p", Kind::Text, PartState::Live, PartOrigin::User)],
            Some(&plain_notice),
            &[],
        ),
        Typed::new(
            1,
            vec![part("p", Kind::Text, PartState::Live, PartOrigin::User)],
            Some(&agent),
            &[],
        ),
        Typed::new(
            1,
            vec![part("p", Kind::Text, PartState::Live, PartOrigin::User)],
            Some(&unnamed_agent),
            &[],
        ),
        // A user entry with no text part: its origin is not shown.
        Typed::new(
            0,
            vec![part("img", Kind::File, PartState::Live, PartOrigin::None)],
            Some(&Origin::Person),
            &[],
        ),
        Typed::new(0, vec![], None, &[]),
    ]
}

#[test]
fn a_typed_row_renders_the_projections_json_and_reads_back_typed() {
    for typed in typed_rows() {
        let row = Row::Typed(typed);
        let value = row.to_value("m7");
        assert_eq!(value["message_id"], "m7");
        let read = Row::from_json("m7", value.clone());
        assert!(matches!(read, Row::Typed(_)), "{value}");
        assert_eq!(read, row, "{value}");
        assert_eq!(read.to_value("m7"), value);
        assert_eq!(Row::decode(&row.encode()).unwrap(), row, "{value}");
    }
}

/// The JSON of one row as the projection wrote it before rows were typed,
/// member by member: every member a typed row renders.
#[test]
fn a_typed_row_renders_every_member_the_projection_wrote() {
    let row = Row::Typed(typed_rows().swap_remove(1));
    let expected = json!({
        "message_id":"m2","state":"raw","compartment_id":null,"outside_reason":null,"split":null,
        "parts":{"tagged":1,"stamped":2,"dropped":1},
        "stamped_parts":[
            {"kind":"tool","part_ref":{"part_key":"call"},"size":{"bytes":4000,"tokens":3,"input_bytes":null,"input_tokens":null},"stage":"queued","stamped_at_ms":123,"stamped_at_source":"recorded"},
            {"kind":"opaque","part_ref":{"part_key":"later"},"size":{"bytes":0,"tokens":3,"input_bytes":null,"input_tokens":null},"stage":"queued","stamped_at_ms":null,"stamped_at_source":"recorded"}
        ],
        "dropped_parts":[
            {"kind":"reasoning","part_ref":{"part_key":"think"},"size":{"bytes":null,"tokens":3,"input_bytes":null,"input_tokens":null},"dropped_at_ms":null,"dropped_at_source":"not_recorded","drop_mode":null}
        ],
        "items":[
            {"part_ref":{"part_key":"call"},"kind":"tool","tokens":7,"source":"runner","state":"stamped","tool":"read"},
            {"part_ref":{"part_key":"think"},"kind":"reasoning","tokens":7,"source":"reported","state":"dropped"},
            {"part_ref":{"part_key":"later"},"kind":"opaque","tokens":7,"source":"estimate","state":"stamped"}
        ]
    });
    assert_eq!(row.to_value("m2").to_string(), expected.to_string());
    let host = Row::Typed(typed_rows().swap_remove(0)).to_value("m1");
    assert_eq!(
        host["items"][1]["origin"],
        json!({"kind":"host","label":"[host text: continue]","host_code":"continue"})
    );
    assert_eq!(
        host["items"][2]["origin"],
        json!({"kind":"host","label":"[host text]"})
    );
    assert_eq!(host["items"][0]["origin"], json!({"kind":"person"}));
    assert_eq!(
        host["host_parts"],
        json!([{"part":"host","host_code":"continue"},{"part":"bare"}])
    );
    let notice = Row::Typed(typed_rows().swap_remove(2)).to_value("m3");
    assert_eq!(notice["state"], "dropped");
    assert_eq!(
        notice["items"][0]["origin"],
        json!({"kind":"notice","sender":"prefrontal","speaks_for":{"agent_id":"agent-1","name":"BROCA"}})
    );
    let cut = Row::Typed(typed_rows().swap_remove(3)).to_value("m4");
    assert_eq!(cut["state"], "raw", "a cut message lists no dropped parts");
    assert_eq!(cut["dropped_parts"], json!([]));
    assert_eq!(cut["items"][0]["state"], "dropped");
}

#[test]
fn a_row_of_another_shape_is_kept_as_its_json() {
    let typed = Row::Typed(typed_rows().swap_remove(0)).to_value("m1");
    let mut extra = typed.clone();
    extra["future"] = json!(true);
    let mut two_origins = typed.clone();
    two_origins["items"][3]["origin"] = json!({"kind":"agent","agent_id":"other"});
    let mut partly_listed = Row::Typed(typed_rows().swap_remove(3)).to_value("m1");
    partly_listed["dropped_parts"] = json!([{"kind":"text","part_ref":{"part_key":"a"},"size":{"bytes":null,"tokens":3,"input_bytes":null,"input_tokens":null},"dropped_at_ms":null,"dropped_at_source":"not_recorded","drop_mode":null}]);
    partly_listed["parts"]["dropped"] = json!(1);
    for value in [
        // Older rows have no item list.
        json!({"message_id":"m1","state":"raw","compartment_id":null,"outside_reason":null,"split":null,"stamped_parts":[],"dropped_parts":[],"parts":{"tagged":1,"stamped":0,"dropped":0}}),
        json!("not an object"),
        json!({"message_id":"elsewhere"}),
        extra,
        two_origins,
        partly_listed,
    ] {
        let row = Row::from_json("m1", value.clone());
        assert!(matches!(row, Row::Json(_)), "{value}");
        assert_eq!(row.to_value("m1"), value);
        assert_eq!(Row::decode(&row.encode()).unwrap(), row);
    }
    // A typed row names its own message; any other id keeps the JSON.
    assert!(matches!(Row::from_json("m2", typed), Row::Json(_)));
}

#[test]
fn decoding_refuses_bytes_encode_did_not_write() {
    let row = Row::Typed(typed_rows().swap_remove(0)).encode();
    let mut trailing = row.clone();
    trailing.push(0);
    for bytes in [
        vec![],
        vec![9],
        row[..row.len() - 1].to_vec(),
        trailing,
        Row::unreadable(b"not JSON"),
        // A count far larger than the bytes that follow.
        vec![1, 0, 0, 0xff, 0xff, 0xff, 0xff, 0x0f],
    ] {
        assert!(Row::decode(&bytes).is_err(), "{bytes:?}");
    }
}

/// The encoding names no fields: a row with one text part takes a few
/// bytes beyond its strings, where its JSON takes hundreds.
#[test]
fn a_typed_row_encodes_without_field_names() {
    let row = Row::Typed(typed_rows().swap_remove(4));
    let bytes = row.encode();
    assert!(bytes.len() < 32, "{} bytes", bytes.len());
    let json: Value = row.to_value("m5");
    assert!(json.to_string().len() > 200);
    assert!(!bytes.windows(5).any(|window| window == b"items"));
}
