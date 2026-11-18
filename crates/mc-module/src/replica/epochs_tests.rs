//! What a vault refusal to open a message means: held until it may open,
//! or skipped when it never will ([`super::epochs::unopened`]), and how the
//! engine holds the stream at such a message.

use std::sync::Arc;

use super::epochs::{parse_status, unopened, EpochStatus, UnknownEpochs, Unopened, OPEN_FAILED};
use super::hub::InMemoryHub;
use super::test_support::{memory, Computer, Epochs, Vault};

fn status(current: Option<u64>, highest_held: Option<u64>) -> EpochStatus {
    EpochStatus {
        current,
        highest_held,
    }
}

fn held(outcome: &Unopened) -> Option<bool> {
    match outcome {
        Unopened::Hold { alert, .. } => Some(*alert),
        Unopened::Skip(_) => None,
    }
}

/// `Some(alert)` for a hold, `None` for a skip.
fn decide(code: &str, class: &str, epoch: u64, opened: bool, record: EpochStatus) -> Option<bool> {
    held(&unopened(code, class, epoch, opened, record))
}

#[test]
fn an_open_failure_is_final_only_for_an_epoch_the_vault_holds() {
    // The record names the highest epoch the vault holds.
    assert_eq!(
        decide(OPEN_FAILED, "permanent", 3, false, status(None, Some(3))),
        None
    );
    assert_eq!(
        decide(OPEN_FAILED, "permanent", 2, false, status(Some(3), Some(3))),
        None
    );
    assert_eq!(
        decide(OPEN_FAILED, "permanent", 4, true, status(Some(4), Some(3))),
        Some(false),
        "above the highest held: the epoch's wrap hasn't arrived"
    );
    // Without it, an epoch this computer opened before counts as held.
    assert_eq!(
        decide(OPEN_FAILED, "permanent", 2, true, status(None, None)),
        None
    );
    assert_eq!(
        decide(OPEN_FAILED, "permanent", 2, false, status(None, None)),
        Some(false),
        "today's vault answers it for an epoch it doesn't hold"
    );
    assert_eq!(
        decide(OPEN_FAILED, "permanent", 1, false, status(Some(5), None)),
        Some(false),
        "below the current epoch, but never opened here: held"
    );
}

#[test]
fn an_epoch_above_the_hubs_current_one_is_held_and_alerted_never_skipped() {
    for (code, opened) in [
        (OPEN_FAILED, true),
        ("fleet_epoch_unavailable", false),
        ("store_error", false),
    ] {
        assert_eq!(
            decide(code, "permanent", 6, opened, status(Some(5), Some(9))),
            Some(true),
            "{code}"
        );
    }
}

#[test]
fn every_other_refusal_is_held_and_a_damaged_key_is_alerted() {
    assert_eq!(
        decide(
            "fleet_epoch_unavailable",
            "transient",
            2,
            false,
            status(None, None)
        ),
        Some(false)
    );
    assert_eq!(
        decide("store_error", "transient", 2, true, status(None, Some(2))),
        Some(false)
    );
    assert_eq!(
        decide("corrupt", "permanent", 2, true, status(Some(2), Some(2))),
        Some(true),
        "the vault's own key copy is damaged, not the message"
    );
    assert_eq!(
        decide(
            "a_code_this_build_doesnt_know",
            "permanent",
            2,
            true,
            status(None, Some(2))
        ),
        Some(false)
    );
}

#[test]
fn the_epoch_record_is_read_from_entorhinals_answer_each_member_on_its_own() {
    assert_eq!(
        parse_status(br#"{"result": {"current": 7, "highest_held": 6}}"#),
        status(Some(7), Some(6))
    );
    assert_eq!(
        parse_status(br#"{"result": {"highest_held": 6}}"#),
        status(None, Some(6))
    );
    assert_eq!(
        parse_status(br#"{"result": {"current": "seven"}}"#),
        status(None, None)
    );
    assert_eq!(
        parse_status(br#"{"error": {"code": "unknown_op"}}"#),
        status(None, None),
        "an Entorhinal without the operation"
    );
    assert_eq!(parse_status(b"not json"), status(None, None));
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&super::epochs::status_request()).unwrap(),
        serde_json::json!({"method": "fleet.epoch_current", "params": {}})
    );
}

/// A writes a memory sealed under epoch `epoch`, and sends it.
async fn sealed_under(hub: &Arc<InMemoryHub>, epoch: u64, content: &str) -> Computer {
    let mut a = Computer::new(hub, 1);
    a.with_vault(
        hub,
        1,
        Vault::new(&[epoch], (OPEN_FAILED, "permanent")),
        Arc::new(UnknownEpochs),
    );
    memory(&a, "pj-a", content);
    a.sync().await;
    a
}

fn rejects(computer: &Computer) -> i64 {
    computer.value("SELECT COUNT(*) FROM replica_rejects")
}

/// A message sealed under an epoch this computer's vault doesn't hold yet
/// is never skipped: the stream is held before it, with nothing recorded,
/// until the vault holds the epoch, and then it applies.
#[tokio::test]
async fn a_message_under_an_epoch_the_vault_doesnt_hold_yet_holds_the_stream_until_it_does() {
    for missing in [
        ("fleet_epoch_unavailable", "transient"),
        (OPEN_FAILED, "permanent"),
    ] {
        let hub = InMemoryHub::new();
        sealed_under(&hub, 2, "Sealed under epoch two.").await;
        let mut b = Computer::new(&hub, 2);
        let vault = Vault::new(&[1], missing);
        b.with_vault(&hub, 2, Arc::clone(&vault) as _, Arc::new(UnknownEpochs));
        for _ in 0..3 {
            assert!(b.replica.follow().await.is_err(), "{missing:?}");
        }
        assert_eq!(b.replica.position().unwrap(), 0);
        assert_eq!(rejects(&b), 0);
        vault.receive(2);
        b.follow_all().await;
        assert_eq!(b.live(), ["Sealed under epoch two."], "{missing:?}");
    }
}

/// A message the vault can't open under an epoch it holds never will open:
/// skipped with a log line and recorded, and the stream goes on. The vault
/// holds the epoch when the record says so, or, while the record is
/// unknown, when this computer opened a message of it before; without
/// either, the same refusal holds the stream.
#[tokio::test]
async fn a_message_the_vault_cant_open_under_an_epoch_it_holds_is_skipped() {
    for (record, opened_first, skipped) in [
        (status(None, Some(1)), false, true),
        (status(None, None), true, true),
        (status(None, None), false, false),
    ] {
        let hub = InMemoryHub::new();
        let a = sealed_under(&hub, 1, "The first memory.").await;
        let mut b = Computer::new(&hub, 2);
        b.with_vault(
            &hub,
            2,
            Vault::new(&[1], (OPEN_FAILED, "permanent")),
            Arc::new(Epochs(std::sync::Mutex::new(record))),
        );
        if opened_first {
            b.follow_all().await;
        } else {
            b.execute("UPDATE replica_state SET stream_seq = 1");
        }
        // A message whose ciphertext was changed on the way, read in a call
        // of its own.
        let mut tampered = hub.messages()[0].clone();
        let mut envelope: super::wire::Envelope =
            serde_json::from_slice(&tampered.payload).unwrap();
        envelope.ciphertext = super::wire::encode(b"0123456789abcdef0123");
        tampered.payload = envelope.to_bytes();
        hub.inject(&tampered.subject, None, tampered.payload);
        let read = b.replica.follow().await;
        assert_eq!(read.is_ok(), skipped, "{record:?} {opened_first}");
        assert_eq!(rejects(&b), i64::from(skipped));
        if skipped {
            memory(&a, "pj-a", "The second memory.");
            a.publish_all().await;
            b.follow_all().await;
            assert!(b.live().contains(&"The second memory.".to_owned()));
        }
    }
}

/// With the record known, an epoch above the highest the vault holds is
/// held even under today's vault, which answers it as a failed open.
#[tokio::test]
async fn an_epoch_above_the_highest_the_vault_holds_is_held() {
    let hub = InMemoryHub::new();
    sealed_under(&hub, 3, "Sealed under epoch three.").await;
    let mut b = Computer::new(&hub, 2);
    let record = Arc::new(Epochs(std::sync::Mutex::new(status(Some(3), Some(2)))));
    b.with_vault(
        &hub,
        2,
        Vault::new(&[1, 2], (OPEN_FAILED, "permanent")),
        Arc::clone(&record) as _,
    );
    assert!(b.replica.follow().await.is_err());
    assert_eq!((b.replica.position().unwrap(), rejects(&b)), (0, 0));
}

/// A damaged key copy in this computer's vault, or a call the vault refuses
/// as malformed, holds the stream: neither is the message's fault.
#[tokio::test]
async fn a_damaged_key_or_a_refused_call_holds_the_stream() {
    let hub = InMemoryHub::new();
    sealed_under(&hub, 1, "Sealed under epoch one.").await;
    let mut b = Computer::new(&hub, 2);
    let vault = Vault::new(&[1], (OPEN_FAILED, "permanent"));
    b.with_vault(&hub, 2, Arc::clone(&vault) as _, Arc::new(UnknownEpochs));
    vault.damage(1);
    let log = crate::test_log::capture();
    assert!(b.replica.follow().await.is_err());
    assert!(b.replica.follow().await.is_err());
    assert_eq!(
        log.count("the memory stream is held"),
        1,
        "logged once: {}",
        log.text()
    );
    let mut b = Computer::open(&hub, 2, b.copy());
    let vault = Vault::new(&[1], (OPEN_FAILED, "permanent"));
    b.with_vault(&hub, 2, Arc::clone(&vault) as _, Arc::new(UnknownEpochs));
    vault.refuse_next_call(super::epochs::INVALID_PARAMS);
    assert!(b.replica.follow().await.is_err());
    assert_eq!((b.replica.position().unwrap(), rejects(&b)), (0, 0));
    b.follow_all().await;
    assert_eq!(b.live(), ["Sealed under epoch one."]);
}
