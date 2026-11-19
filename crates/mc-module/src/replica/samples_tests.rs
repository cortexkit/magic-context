//! The vault's tagged Magic Context samples
//! (`fleet-epoch-magic-context-vectors-v1.1`, copied from claustrum's tag of
//! that name with their `SHA256SUMS`): the additional data ck-mc builds for
//! a memory change matches the samples' byte for byte, the batch requests it
//! sends and the replies it reads have the samples' shape, the samples'
//! ciphertexts open under the vault's rules, a message ck-mc seals opens
//! under the same rules, and the vault's refusal to open a message under an
//! epoch it doesn't hold holds the stream until the epoch arrives.

use serde_json::Value;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use super::seal::{
    open_batch_params, parse_open_reply, parse_seal_reply, seal_batch_params, OpenInput, Opened,
    SealInput, Sealer,
};
use super::test_support::{vault_aad, TestSealer, MAGIC_CONTEXT_DOMAIN};
use super::wire::{self, decode, encode};

const README: &str = include_str!("../../testdata/fleet-epoch-magic-context-v1.1/README.md");
const CASES: &str = include_str!("../../testdata/fleet-epoch-magic-context-v1.1/cases.json");
const SUMS: &str = include_str!("../../testdata/fleet-epoch-magic-context-v1.1/SHA256SUMS");

/// The memory change the samples seal: a project memory of `pj-example`
/// under the global id `0123456789abcdef0123456789abcdef.42`. The samples
/// predate the table letter ck-mc's global ids carry (`.m42`); the
/// additional data binds whatever id it is given, unchanged.
const GLOBAL: &str = "0123456789abcdef0123456789abcdef.42";

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

/// The SHA-256 of the tagged set's `SHA256SUMS`, as the vault's team
/// published it with the tag.
const SUMS_SHA256: &str = "52b3fddff7eaf5fe5336fc7ffb31dba66341ea35e114cac02f4ec124410b588c";

#[test]
fn the_copied_samples_are_the_tagged_ones() {
    assert_eq!(
        format!("{:x}", Sha256::digest(SUMS.as_bytes())),
        SUMS_SHA256
    );
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
    // The set's cases keep the version they were made under; v1.1 adds
    // `unheld_epoch_open` and leaves the others byte for byte as they were.
    assert_eq!(cases()["version"], "fleet-epoch-magic-context-vectors-v1");
    assert_eq!(cases()["caller"], "reserved:magic-context");
}

/// The samples' open request sent to a vault that doesn't hold its epoch
/// (`unheld_epoch_open`) is refused `fleet_epoch_unavailable`, transient,
/// as a per-item answer. Whatever this computer knows of the epoch record,
/// that refusal holds the stream and is never skipped; once the vault holds
/// the epoch, the message is read again and applies.
#[tokio::test]
async fn a_refusal_for_an_epoch_the_vault_doesnt_hold_is_held_and_read_again() {
    use super::epochs::{unopened, EpochStatus, UnknownEpochs, Unopened};
    use super::hub::InMemoryHub;
    use super::test_support::{memory, Computer, Vault};

    let case = &cases()["unheld_epoch_open"];
    let request = open_input(&case["request"]);
    assert_eq!(
        open_batch_params(std::slice::from_ref(&request))["items"][0],
        case["request"],
        "the request has the shape ck-mc sends"
    );
    let reply = serde_json::json!({"items": [case["response"]]});
    let opened = parse_open_reply(&reply, 1).unwrap();
    let Opened::Refused { code, class } = &opened[0] else {
        panic!("the sample is a refusal");
    };
    assert_eq!(
        (code.as_str(), class.as_str()),
        ("fleet_epoch_unavailable", "transient")
    );
    for current in [None, Some(1), Some(2)] {
        for highest_held in [None, Some(0), Some(1), Some(2)] {
            for opened_before in [false, true] {
                let record = EpochStatus {
                    current,
                    highest_held,
                };
                assert!(
                    matches!(
                        unopened(code, class, request.epoch, opened_before, record),
                        Unopened::Hold { .. }
                    ),
                    "{record:?} opened before: {opened_before}"
                );
            }
        }
    }

    // The engine, under a vault that answers as the sample does.
    let hub = InMemoryHub::new();
    let a = Computer::new(&hub, 1);
    memory(&a, "pj-a", "Sealed under epoch one.");
    a.sync().await;
    let mut b = Computer::new(&hub, 2);
    let vault = Vault::new(&[], (code, class));
    b.with_vault(
        &hub,
        2,
        std::sync::Arc::clone(&vault) as _,
        std::sync::Arc::new(UnknownEpochs),
    );
    for _ in 0..2 {
        assert!(b.replica.follow().await.is_err(), "held");
    }
    assert_eq!(b.replica.position().unwrap(), 0);
    assert_eq!(b.value::<i64>("SELECT COUNT(*) FROM replica_rejects"), 0);
    vault.receive(1);
    b.follow_all().await;
    assert_eq!(b.live(), ["Sealed under epoch one."]);
}

#[test]
fn the_additional_data_ck_mc_builds_is_the_samples_byte_for_byte() {
    let cases = cases();
    let global = GLOBAL.to_owned();
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
    let global = GLOBAL.to_owned();
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

/// The base64 plaintext a vault request or reply holds as text is wiped
/// once it is no longer needed, and nothing else in it changes.
#[test]
fn the_plaintext_text_of_a_vault_request_and_reply_is_wiped() {
    let mut request = seal_batch_params(&[SealInput {
        aad: b"aad".to_vec(),
        plaintext: Zeroizing::new(b"a secret memory".to_vec()),
    }]);
    let mut reply: Value = serde_json::json!({
        "result": {"items": [{"plaintext": encode(b"a secret memory")}, {"error": {"code": "x", "class": "permanent"}}]}
    });
    super::seal::wipe_plaintexts(&mut request);
    super::seal::wipe_plaintexts(&mut reply);
    assert_eq!(request["items"][0]["plaintext"], "");
    assert_eq!(request["items"][0]["aad"], encode(b"aad"));
    assert_eq!(reply["result"]["items"][0]["plaintext"], "");
    assert_eq!(reply["result"]["items"][1]["error"]["code"], "x");
}
