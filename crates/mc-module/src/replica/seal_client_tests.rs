//! The vault through the claustrum client's typed fleet epoch calls
//! ([`super::seal::Claustrum`]): the client reads the vault's published
//! replies into what the engine reads, the same as the wire-shape readers
//! do, and an envelope that can never open is refused without asking the
//! vault.

use cortexkit_claustrum_client::{
    decode_fleet_epoch_open_batch_reply, decode_fleet_epoch_seal_batch_reply, CredentialErrorClass,
    CredentialResolverError,
};
use serde_json::{json, Value};

use super::seal::{
    call_error, merge, open_bytes, parse_open_reply, parse_seal_reply, sealed, OpenInput, Opened,
    SealError, ENVELOPE_INVALID,
};
use super::wire::decode;

fn cases() -> Value {
    serde_json::from_str(include_str!(
        "../../testdata/fleet-epoch-magic-context-v1/cases.json"
    ))
    .unwrap()
}

/// `body` as the vault's Response frame carries it.
fn frame(body: &Value) -> Vec<u8> {
    serde_json::to_vec(&json!({ "result": body })).unwrap()
}

fn input(item: &Value) -> OpenInput {
    OpenInput {
        epoch: item["epoch"].as_u64().unwrap(),
        nonce: item["nonce"].as_str().unwrap().to_owned(),
        ciphertext: item["ciphertext"].as_str().unwrap().to_owned(),
        aad: decode(item["aad"].as_str().unwrap()).unwrap(),
    }
}

fn shown(opened: &[Opened]) -> Vec<String> {
    opened
        .iter()
        .map(|opened| match opened {
            Opened::Plaintext(bytes) => String::from_utf8(bytes.to_vec()).unwrap(),
            Opened::Refused { code, class } => format!("refused {code} ({class})"),
        })
        .collect()
}

#[test]
fn the_clients_reading_of_the_samples_seal_reply_is_the_wire_readers() {
    let cases = cases();
    let response = &cases["batch"]["response"];
    let typed: Vec<_> = decode_fleet_epoch_seal_batch_reply(&frame(response))
        .unwrap()
        .into_iter()
        .map(sealed)
        .collect();
    assert_eq!(typed, parse_seal_reply(response, 2).unwrap());
}

#[test]
fn the_clients_reading_of_the_samples_open_replies_is_the_wire_readers() {
    let cases = cases();
    let items = cases["batch"]["open_request"]["items"].as_array().unwrap();
    let bytes: Vec<_> = items.iter().map(|item| open_bytes(&input(item))).collect();
    assert!(bytes.iter().all(Option::is_some));
    let mixed = json!({"items": [
        cases["batch"]["open_response"]["items"][0],
        cases["seal_open"]["cross_domain_open"]["response"],
    ]});
    for reply in [&cases["batch"]["open_response"], &mixed] {
        let answers = decode_fleet_epoch_open_batch_reply(&frame(reply)).unwrap();
        assert_eq!(
            shown(&merge(&bytes, answers).unwrap()),
            shown(&parse_open_reply(reply, 2).unwrap())
        );
    }
    let answers = decode_fleet_epoch_open_batch_reply(&frame(&mixed)).unwrap();
    assert_eq!(
        shown(&merge(&bytes, answers).unwrap()),
        [
            "first memory change",
            "refused fleet_epoch_open_failed (permanent)"
        ]
    );
}

/// An envelope whose fields the vault never wrote is refused for good in
/// its own slot; the others keep the vault's answers, in order.
#[test]
fn an_envelope_that_can_never_open_is_refused_without_the_vault() {
    let cases = cases();
    let good = input(&cases["batch"]["open_request"]["items"][1]);
    let bad_nonce = OpenInput {
        nonce: "not base64url!".into(),
        ..good.clone()
    };
    let bad_epoch = OpenInput {
        epoch: u64::from(u32::MAX) + 1,
        ..good.clone()
    };
    let bytes: Vec<_> = [&bad_nonce, &good, &bad_epoch]
        .into_iter()
        .map(open_bytes)
        .collect();
    assert!(bytes[0].is_none() && bytes[1].is_some() && bytes[2].is_none());
    let reply = json!({"items": [cases["batch"]["open_response"]["items"][1]]});
    let answers = decode_fleet_epoch_open_batch_reply(&frame(&reply)).unwrap();
    let invalid = format!("refused {ENVELOPE_INVALID} (permanent)");
    assert_eq!(
        shown(&merge(&bytes, answers).unwrap()),
        [invalid.as_str(), "second memory change", invalid.as_str()]
    );
    // Fewer or more answers than items sent is a broken reply.
    assert!(merge(&bytes, Vec::new()).is_err());
    let twice =
        decode_fleet_epoch_open_batch_reply(&frame(&cases["batch"]["open_response"])).unwrap();
    assert!(merge(&bytes, twice).is_err());
}

#[test]
fn a_failed_call_is_transient_only_when_the_vault_may_answer_later() {
    for (class, transient) in [
        (CredentialErrorClass::Transient, true),
        (CredentialErrorClass::Transport, true),
        (CredentialErrorClass::Unavailable, true),
        (CredentialErrorClass::Permanent, false),
        (CredentialErrorClass::InvalidResponse, false),
        (CredentialErrorClass::Unauthorized, false),
    ] {
        let error = CredentialResolverError::new(class, "refused");
        assert_eq!(
            call_error(&error),
            SealError {
                code: class.classifier_code().to_owned(),
                transient
            },
            "{class:?}"
        );
    }
}
