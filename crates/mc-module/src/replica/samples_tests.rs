//! The vault's tagged Magic Context samples
//! (`fleet-epoch-magic-context-vectors-v1`, copied from claustrum's
//! `crates/credentials-module/tests/fixtures/fleet-epoch-magic-context-v1/`
//! with their `SHA256SUMS`): the additional data ck-mc builds for a memory
//! change matches the samples' byte for byte, the batch requests it sends
//! and the replies it reads have the samples' shape, the samples'
//! ciphertexts open under the vault's rules, and a message ck-mc seals opens
//! under the same rules.

use serde_json::Value;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use super::seal::{
    open_batch_params, parse_open_reply, parse_seal_reply, seal_batch_params, OpenInput, Opened,
    SealInput, Sealer,
};
use super::test_support::{vault_aad, TestSealer, MAGIC_CONTEXT_DOMAIN};
use super::wire::{self, decode, encode};

const README: &str = include_str!("../../testdata/fleet-epoch-magic-context-v1/README.md");
const CASES: &str = include_str!("../../testdata/fleet-epoch-magic-context-v1/cases.json");
const SUMS: &str = include_str!("../../testdata/fleet-epoch-magic-context-v1/SHA256SUMS");

/// The memory change the samples seal: memory 42 of box
/// `0123456789abcdef0123456789abcdef`, a project memory of `pj-example`.
const BOX: &str = "0123456789abcdef0123456789abcdef";

fn cases() -> Value {
    serde_json::from_str(CASES).unwrap()
}

fn key() -> [u8; 32] {
    decode(cases()["epoch_key"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap()
}

fn open_input(item: &Value) -> OpenInput {
    OpenInput {
        epoch: item["epoch"].as_u64().unwrap(),
        nonce: item["nonce"].as_str().unwrap().to_owned(),
        ciphertext: item["ciphertext"].as_str().unwrap().to_owned(),
        aad: decode(item["aad"].as_str().unwrap()).unwrap(),
    }
}

fn plaintext(opened: &Opened) -> String {
    match opened {
        Opened::Plaintext(bytes) => String::from_utf8(bytes.to_vec()).unwrap(),
        other => panic!("not opened: {other:?}"),
    }
}

#[test]
fn the_copied_samples_are_the_tagged_ones() {
    for (name, text) in [("README.md", README), ("cases.json", CASES)] {
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
    assert_eq!(cases()["version"], "fleet-epoch-magic-context-vectors-v1");
    assert_eq!(cases()["caller"], "reserved:magic-context");
}

#[test]
fn the_additional_data_ck_mc_builds_is_the_samples_byte_for_byte() {
    let cases = cases();
    let global = wire::global_id(BOX, 42);
    let subject = wire::subject("memory", Some("project"), "pj-example").unwrap();
    assert_eq!(subject, "ck.fleet.memory.project.pj-example");
    assert_eq!(
        encode(&wire::aad(&global, 3, &subject)),
        cases["seal_open"]["request"]["aad"].as_str().unwrap()
    );
    for (item, revision) in cases["batch"]["request"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .zip([3, 4])
    {
        assert_eq!(
            encode(&wire::aad(&global, revision, &subject)),
            item["aad"].as_str().unwrap()
        );
    }
    // The vault wraps it in its own record for the AEAD.
    assert_eq!(
        vault_aad(&wire::aad(&global, 3, &subject), 1, MAGIC_CONTEXT_DOMAIN),
        cases["seal_open"]["record_aad_utf8"]
            .as_str()
            .unwrap()
            .as_bytes()
    );
}

#[test]
fn the_batch_requests_and_replies_have_the_samples_shape() {
    let cases = cases();
    let batch = &cases["batch"];
    let inputs: Vec<SealInput> = batch["request"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| SealInput {
            aad: decode(item["aad"].as_str().unwrap()).unwrap(),
            plaintext: Zeroizing::new(decode(item["plaintext"].as_str().unwrap()).unwrap()),
        })
        .collect();
    assert_eq!(seal_batch_params(&inputs), batch["request"]);
    let sealed = parse_seal_reply(&batch["response"], 2).unwrap();
    assert_eq!(sealed[1].epoch, 1);
    assert_eq!(
        sealed[1].nonce,
        batch["response"]["items"][1]["nonce"].as_str().unwrap()
    );
    let opens: Vec<OpenInput> = batch["open_request"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(open_input)
        .collect();
    assert_eq!(open_batch_params(&opens), batch["open_request"]);
    let opened = parse_open_reply(&batch["open_response"], 2).unwrap();
    assert_eq!(
        opened.iter().map(plaintext).collect::<Vec<_>>(),
        ["first memory change", "second memory change"]
    );
    // A reply holding a refusal for one item opens the others.
    let mixed = serde_json::json!({"items": [
        batch["open_response"]["items"][0],
        cases["seal_open"]["cross_domain_open"]["response"],
    ]});
    let opened = parse_open_reply(&mixed, 2).unwrap();
    assert_eq!(plaintext(&opened[0]), "first memory change");
    assert!(matches!(&opened[1], Opened::Refused { code, class }
        if code == "fleet_epoch_open_failed" && class == "permanent"));
    // A count that doesn't match the request is refused whole.
    assert!(parse_open_reply(&batch["open_response"], 3).is_err());
}

#[tokio::test]
async fn the_samples_open_under_the_vaults_rules_and_only_in_their_domain() {
    let cases = cases();
    let sealer = TestSealer::new(key(), 1);
    let single = open_input(&cases["seal_open"]["open_request"]);
    let batch: Vec<OpenInput> = cases["batch"]["open_request"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(open_input)
        .collect();
    let mut items = vec![single.clone()];
    items.extend(batch);
    let opened = sealer.open_batch(&items).await.unwrap();
    assert_eq!(
        opened.iter().map(plaintext).collect::<Vec<_>>(),
        [
            "first memory change",
            "first memory change",
            "second memory change"
        ]
    );
    // The same request in Prefrontal's domain is refused.
    let prefrontal = TestSealer::with_domain(key(), 1, "ck-fleet-epoch-aad/prefrontal/v1");
    assert!(matches!(
        prefrontal.open_one(&single),
        Opened::Refused { .. }
    ));
}

#[tokio::test]
async fn a_message_ck_mc_seals_opens_under_the_samples_rules() {
    let sealer = TestSealer::new(key(), 1);
    let global = wire::global_id(BOX, 42);
    let subject = wire::subject("memory", Some("project"), "pj-example").unwrap();
    let aad = wire::aad(&global, 5, &subject);
    let sealed = sealer
        .seal_batch(&[SealInput {
            aad: aad.clone(),
            plaintext: Zeroizing::new(b"a memory change".to_vec()),
        }])
        .await
        .unwrap();
    let open = OpenInput {
        epoch: sealed[0].epoch,
        nonce: sealed[0].nonce.clone(),
        ciphertext: sealed[0].ciphertext.clone(),
        aad,
    };
    assert_eq!(plaintext(&sealer.open_one(&open)), "a memory change");
    // Bound to its message: another revision's additional data won't open it.
    let other = OpenInput {
        aad: wire::aad(&global, 6, &subject),
        ..open
    };
    assert!(matches!(sealer.open_one(&other), Opened::Refused { .. }));
}
