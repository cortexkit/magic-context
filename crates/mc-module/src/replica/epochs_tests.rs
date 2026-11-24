//! What a vault refusal to open a message means: held until it may open,
//! or skipped when it never will ([`super::epochs::unopened`]), and how the
//! engine holds the stream at such a message.

use std::sync::Arc;

use super::epochs::{
    parse_status, unopened, EpochStatus, UnknownEpochs, Unopened, OPEN_FAILED, UNAVAILABLE,
};
use super::hub::InMemoryHub;
use super::test_support::{memory, Computer, Epochs, Vault};

fn status(current: Option<u64>, highest_held: Option<u64>) -> EpochStatus {
    EpochStatus {
        current,
        highest_held,
    }
}

/// `Some(alert)` for a hold, `None` for a skip.
fn decide(code: &str, class: &str, epoch: u64, record: EpochStatus) -> Option<bool> {
    match unopened(code, class, epoch, record) {
        Unopened::Hold { alert, .. } => Some(alert),
        Unopened::Skip(_) => None,
    }
}

/// Epoch records of every kind: unknown, the epoch below, at and above the
/// hub's current one, below and above the highest the vault holds.
const RECORDS: [EpochStatus; 6] = [
    EpochStatus {
        current: None,
        highest_held: None,
    },
    EpochStatus {
        current: Some(3),
        highest_held: Some(3),
    },
    EpochStatus {
        current: Some(1),
        highest_held: None,
    },
    EpochStatus {
        current: None,
        highest_held: Some(1),
    },
    EpochStatus {
        current: Some(5),
        highest_held: Some(9),
    },
    EpochStatus {
        current: Some(0),
        highest_held: Some(0),
    },
];

/// The vault answers `fleet_epoch_open_failed` only for an epoch whose key
/// it holds: the message doesn't authenticate under it, and never will.
/// What this computer last read of the epoch record doesn't change that.
#[test]
fn an_open_failure_is_skipped_whatever_the_epoch_and_the_record() {
    for epoch in [1, 2, 3, 6] {
        for record in RECORDS {
            assert_eq!(
                decide(OPEN_FAILED, "permanent", epoch, record),
                None,
                "epoch {epoch}, {record:?}"
            );
        }
    }
}

/// `fleet_epoch_unavailable` is the vault saying it doesn't hold the
/// epoch's key: held, never skipped, alerted, and naming the epoch it
/// waits for, whatever the record says the vault holds.
#[test]
fn an_epoch_the_vault_doesnt_hold_is_held_and_alerted_whatever_the_record() {
    for epoch in [1, 2, 3, 6] {
        for record in RECORDS {
            match unopened(UNAVAILABLE, "transient", epoch, record) {
                Unopened::Hold { alert, missing, .. } => {
                    assert!(alert, "epoch {epoch}, {record:?}");
                    assert_eq!(missing, Some(epoch), "{record:?}");
                }
                Unopened::Skip(why) => panic!("epoch {epoch}, {record:?} skipped: {why}"),
            }
        }
    }
}

#[test]
fn every_other_refusal_is_held_and_a_damaged_key_is_alerted() {
    assert_eq!(
        decide("store_error", "transient", 2, status(None, Some(2))),
        Some(false)
    );
    assert_eq!(
        decide("corrupt", "permanent", 2, status(Some(2), Some(2))),
        Some(true),
        "the vault's own key copy is damaged, not the message"
    );
    assert_eq!(
        decide(
            "a_code_this_build_doesnt_know",
            "permanent",
            2,
            status(None, Some(2))
        ),
        Some(false)
    );
    for code in ["store_error", "corrupt", "a_code_this_build_doesnt_know"] {
        assert!(
            matches!(
                unopened(code, "permanent", 2, status(None, None)),
                Unopened::Hold { missing: None, .. }
            ),
            "{code} names no epoch the vault lacks"
        );
    }
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
        Vault::new(&[epoch], (UNAVAILABLE, "transient")),
        Arc::new(UnknownEpochs),
    );
    memory(&a, "pj-a", content);
    a.sync().await;
    a
}

fn rejects(computer: &Computer) -> i64 {
    computer.value("SELECT COUNT(*) FROM replica_rejects")
}

fn hold(computer: &Computer) -> Option<super::EpochHold> {
    computer
        .db
        .with_connection(|conn| super::hold_status(conn))
        .unwrap()
}

#[tokio::test]
async fn restoring_a_winner_after_an_epoch_hold_clears_health_without_an_arrival() {
    let hub = InMemoryHub::new();
    let a = sealed_under(&hub, 2, "Sealed under epoch two.").await;
    let mut b = Computer::new(&hub, 2);
    let vault = Vault::new(&[2], (UNAVAILABLE, "transient"));
    b.with_vault(&hub, 2, Arc::clone(&vault) as _, Arc::new(UnknownEpochs));
    b.sync().await;

    // Reopen the store with a vault that doesn't have the key to the
    // previously applied winner. The restore queue normally comes from
    // reconciliation after a local change can no longer win.
    b.execute("UPDATE memories SET content = 'Losing local edit.'");
    b.execute(
        "DELETE FROM replica_outbox;
               INSERT INTO replica_restore (global_id, seq)
               SELECT global_id, seq FROM replica_ids",
    );
    let mut b = Computer::open(&hub, 2, b.copy());
    let vault = Vault::new(&[1], (UNAVAILABLE, "transient"));
    b.with_vault(&hub, 2, Arc::clone(&vault) as _, Arc::new(UnknownEpochs));
    let position = b.replica.position().unwrap();
    assert!(b.replica.follow().await.unwrap_err().contains(UNAVAILABLE));
    assert_eq!(hold(&b).expect("restore is held").epoch, 2);

    vault.receive(2);
    assert_eq!(b.replica.follow().await.unwrap(), 0);
    assert_eq!(b.replica.position().unwrap(), position);
    assert_eq!(b.value::<i64>("SELECT COUNT(*) FROM replica_restore"), 0);
    assert_eq!(b.live(), a.live());
    assert_eq!(hub.messages().len(), 1);
    assert_eq!(hold(&b), None, "the restore is no longer held");
}

/// A message sealed under an epoch this computer's vault doesn't hold yet
/// is never skipped: the stream is held before it, with nothing recorded as
/// rejected, until the vault holds the epoch, and then it applies. Nothing
/// is sent meanwhile, so the hold is never silent: the store records the
/// epoch it waits for and since when, for a health report, and it is
/// logged at error level once for that epoch, however many rounds and
/// restarts of the engine it lasts.
#[tokio::test]
async fn a_message_under_an_epoch_the_vault_doesnt_hold_yet_holds_the_stream_until_it_does() {
    let hub = InMemoryHub::new();
    sealed_under(&hub, 2, "Sealed under epoch two.").await;
    let mut b = Computer::new(&hub, 2);
    let vault = Vault::new(&[1], (UNAVAILABLE, "transient"));
    b.with_vault(&hub, 2, Arc::clone(&vault) as _, Arc::new(UnknownEpochs));
    memory(&b, "pj-a", "Written on B while the stream is held.");
    let log = crate::test_log::capture();
    for _ in 0..3 {
        assert!(b.replica.round().await.is_err());
    }
    assert_eq!(b.replica.position().unwrap(), 0);
    assert_eq!(rejects(&b), 0);
    assert_eq!(hub.messages().len(), 1, "B sends nothing while it is held");
    let held = hold(&b).expect("the hold is recorded");
    assert_eq!(held.epoch, 2);
    assert!(held.since > 0);
    assert!(held.why.contains(UNAVAILABLE), "{}", held.why);

    let mut b = Computer::open(&hub, 2, b.copy());
    b.with_vault(&hub, 2, Arc::clone(&vault) as _, Arc::new(UnknownEpochs));
    assert!(b.replica.round().await.is_err());
    assert_eq!(
        hold(&b).map(|hold| (hold.epoch, hold.since)),
        Some((2, held.since)),
        "a hold for the same epoch keeps the time it began"
    );
    assert_eq!(
        log.count("the memory stream is held for fleet epoch 2"),
        1,
        "logged once: {}",
        log.text()
    );
    assert!(log.text().contains("ERROR"), "{}", log.text());
    drop(log);

    vault.receive(2);
    b.sync().await;
    assert_eq!(
        b.live(),
        [
            "Sealed under epoch two.",
            "Written on B while the stream is held."
        ]
    );
    assert_eq!(hold(&b), None, "the hold ends once the message applies");
    assert_eq!(
        hub.messages().len(),
        2,
        "B's memory is sent once it is read"
    );
}

/// A message the vault can't open under an epoch whose key it holds never
/// will open: skipped with a log line and recorded, and the stream goes
/// on, whatever this computer last read of the epoch record.
#[tokio::test]
async fn a_message_the_vault_cant_open_is_skipped_whatever_the_record() {
    for record in RECORDS {
        let hub = InMemoryHub::new();
        let a = sealed_under(&hub, 1, "The first memory.").await;
        let mut b = Computer::new(&hub, 2);
        b.with_vault(
            &hub,
            2,
            Vault::new(&[1], (UNAVAILABLE, "transient")),
            Arc::new(Epochs(std::sync::Mutex::new(record))),
        );
        b.follow_all().await;
        // A message whose ciphertext was changed on the way.
        let mut tampered = hub.messages()[0].clone();
        let mut envelope: super::wire::Envelope =
            serde_json::from_slice(&tampered.payload).unwrap();
        envelope.ciphertext = super::wire::encode(b"0123456789abcdef0123");
        tampered.payload = envelope.to_bytes();
        hub.inject(&tampered.subject, None, tampered.payload);
        assert!(b.replica.follow().await.is_ok(), "{record:?}");
        assert_eq!(rejects(&b), 1, "{record:?}");
        memory(&a, "pj-a", "The second memory.");
        a.publish_all().await;
        b.follow_all().await;
        assert!(b.live().contains(&"The second memory.".to_owned()));
    }
}

/// The vault's answer decides, not the epoch record: a record that says
/// the vault holds a higher epoch doesn't make a missing epoch skipped, and
/// one that says it holds a lower one doesn't make a failed open held.
#[tokio::test]
async fn the_epoch_record_never_decides_a_skip_or_a_hold() {
    let hub = InMemoryHub::new();
    sealed_under(&hub, 3, "Sealed under epoch three.").await;
    let mut b = Computer::new(&hub, 2);
    b.with_vault(
        &hub,
        2,
        Vault::new(&[1, 2], (UNAVAILABLE, "transient")),
        Arc::new(Epochs(std::sync::Mutex::new(status(Some(9), Some(9))))),
    );
    assert!(b.replica.follow().await.is_err());
    assert_eq!((b.replica.position().unwrap(), rejects(&b)), (0, 0));

    let mut c = Computer::new(&hub, 3);
    c.with_vault(
        &hub,
        3,
        Vault::new(&[1, 2], (OPEN_FAILED, "permanent")),
        Arc::new(Epochs(std::sync::Mutex::new(status(Some(2), Some(2))))),
    );
    assert!(c.replica.follow().await.is_ok());
    assert_eq!((c.replica.position().unwrap(), rejects(&c)), (1, 1));
}

/// A damaged key copy in this computer's vault, or a call the vault refuses
/// as malformed, holds the stream: neither is the message's fault.
#[tokio::test]
async fn a_damaged_key_or_a_refused_call_holds_the_stream() {
    let hub = InMemoryHub::new();
    sealed_under(&hub, 1, "Sealed under epoch one.").await;
    let mut b = Computer::new(&hub, 2);
    let vault = Vault::new(&[1], (UNAVAILABLE, "transient"));
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
    assert_eq!(
        hold(&b),
        None,
        "the vault holds the epoch; its copy is damaged"
    );
    let mut b = Computer::open(&hub, 2, b.copy());
    let vault = Vault::new(&[1], (UNAVAILABLE, "transient"));
    b.with_vault(&hub, 2, Arc::clone(&vault) as _, Arc::new(UnknownEpochs));
    vault.refuse_next_call(super::epochs::INVALID_PARAMS);
    assert!(b.replica.follow().await.is_err());
    assert_eq!((b.replica.position().unwrap(), rejects(&b)), (0, 0));
    b.follow_all().await;
    assert_eq!(b.live(), ["Sealed under epoch one."]);
}
