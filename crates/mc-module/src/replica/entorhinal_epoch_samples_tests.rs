//! Entorhinal's tagged `fleet.epoch_current` samples (`hub-samples-v1`,
//! folder `test-vectors/fleet-epoch-current-v1/`, copied with their
//! `SHA256SUMS`): ck-mc's request has the samples' shape, every served reply
//! reads as the epoch record it states (a missing member is unknown, never
//! zero), a refusal reads as nothing known, and the change marker is the key
//! ck-mc watches.

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::epochs::{parse_status, status_request, EpochStatus, EPOCH_CURRENT_OP, EPOCH_MARKER};

macro_rules! sample {
    ($name:literal) => {
        (
            $name,
            include_str!(concat!(
                "../../testdata/entorhinal-fleet-epoch-current-v1/",
                $name
            )),
        )
    };
}

const SUMS: &str = include_str!("../../testdata/entorhinal-fleet-epoch-current-v1/SHA256SUMS");

/// The SHA-256 of the tagged set's `SHA256SUMS`, as Entorhinal's team
/// published it with the tag.
const SUMS_SHA256: &str = "b8634fb2ceb9b8d96ef9c998aabe2dbf18481ba1a760237e362d8afc451b2c2f";

const FILES: [(&str, &str); 8] = [
    sample!("README.md"),
    sample!("before-hub.json"),
    sample!("current-unknown.json"),
    sample!("held-behind.json"),
    sample!("held-current.json"),
    sample!("held-unknown.json"),
    sample!("marker-bump.json"),
    sample!("unknown-param.json"),
];

fn file(name: &str) -> Value {
    let (_, text) = FILES.iter().find(|(file, _)| *file == name).unwrap();
    serde_json::from_str(text).unwrap()
}

/// The one record a status sample holds.
fn record(name: &str) -> Value {
    let records = file(name);
    let records = records.as_array().unwrap();
    assert_eq!(records.len(), 1, "{name} holds one record");
    records[0].clone()
}

#[test]
fn the_copied_samples_are_the_tagged_ones() {
    assert_eq!(
        format!("{:x}", Sha256::digest(SUMS.as_bytes())),
        SUMS_SHA256
    );
    for (name, text) in FILES {
        let line = SUMS
            .lines()
            .find(|line| line.ends_with(&format!("  {name}")))
            .unwrap_or_else(|| panic!("{name} is pinned"));
        let pinned = line.split_whitespace().next().unwrap();
        assert_eq!(
            format!("{:x}", Sha256::digest(text.as_bytes())),
            pinned,
            "{name}"
        );
    }
}

#[test]
fn the_request_is_the_samples_operation_with_empty_params() {
    let sent: Value = serde_json::from_slice(&status_request()).unwrap();
    let sample = record("held-current.json");
    assert_eq!(sample["op"], EPOCH_CURRENT_OP);
    assert_eq!(sent["method"], sample["op"]);
    assert_eq!(sent["params"], sample["request"]);
}

#[test]
fn every_served_reply_reads_as_the_record_it_states() {
    for (name, current, highest_held) in [
        ("before-hub.json", None, None),
        ("current-unknown.json", None, Some(2)),
        ("held-behind.json", Some(2), Some(1)),
        ("held-current.json", Some(2), Some(2)),
        ("held-unknown.json", Some(2), None),
    ] {
        let reply = serde_json::to_vec(&record(name)["reply"]).unwrap();
        assert_eq!(
            parse_status(&reply),
            EpochStatus {
                current,
                highest_held
            },
            "{name}"
        );
    }
}

#[test]
fn a_refusal_reads_as_nothing_known() {
    let sample = record("unknown-param.json");
    assert_eq!(sample["reply"]["code"], "invalid_request");
    let reply = serde_json::to_vec(&sample["reply"]).unwrap();
    assert_eq!(parse_status(&reply), EpochStatus::default());
}

#[test]
fn the_marker_is_the_key_ck_mc_watches() {
    let markers = file("marker-bump.json");
    let marker = &markers.as_array().unwrap()[0];
    assert_eq!(marker["key"], EPOCH_MARKER);
    // The watch wakes on any change of the value; the value itself is the
    // counter pair the samples' README describes.
    let value: Value = serde_json::from_str(marker["value_bytes"].as_str().unwrap()).unwrap();
    assert!(value["generation"].is_u64());
    assert!(value["incarnation"].is_string());
}
