use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::json;
use sha2::{Digest, Sha256};

use super::*;
use crate::dreamer::lease_double::{
    notices, records, yielded, Answer, Frame, SampleLeases, Step, SAMPLES, SHA256SUMS,
};

/// A clock a test sets by hand.
fn fake_clock(at: u64) -> (Arc<AtomicU64>, Clock) {
    let now = Arc::new(AtomicU64::new(at));
    let read = Arc::clone(&now);
    (now, Arc::new(move || read.load(Ordering::SeqCst)))
}

fn steps(file: &str, role: &str) -> Vec<Step> {
    notices(file, role).into_iter().map(Step::Notice).collect()
}

/// The copy in `testdata/role-lease-v1.2` is the published one: every file
/// its `SHA256SUMS` lists is here with that digest, and nothing else is.
#[test]
fn the_copied_samples_match_their_published_digests() {
    let listed: Vec<(&str, &str)> = SHA256SUMS
        .lines()
        .map(|line| line.split_once("  ").expect("a digest and a file name"))
        .collect();
    assert_eq!(listed.len(), SAMPLES.len());
    for (digest, file) in listed {
        let (_, text) = SAMPLES
            .iter()
            .find(|(name, _)| *name == file)
            .unwrap_or_else(|| panic!("{file} is listed but not copied"));
        let actual: String = Sha256::digest(text.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        assert_eq!(actual, digest, "{file}");
    }
}

/// Every frame of every sample decodes through this module's types, and
/// encodes back to the same JSON, so no field the handler serves is lost.
/// The bytes of each notice and answer also decode as the live client
/// reads them.
#[test]
fn every_frame_of_every_sample_decodes_through_the_lease_types() {
    let mut frames = 0;
    for (file, text) in SAMPLES {
        let raw: Vec<serde_json::Value> = serde_json::from_str(text).unwrap();
        for (record, raw) in records(file).iter().zip(&raw) {
            assert!(record.principal.is_object(), "{file}: {}", record.op);
            for (frame, raw) in record.frames.iter().zip(raw["frames"].as_array().unwrap()) {
                let body = &raw["body"];
                let bytes = serde_json::to_vec(body).unwrap();
                let encoded = match frame {
                    Frame::StreamData(notice) => {
                        assert_eq!(&decode_notice(&bytes).unwrap(), notice);
                        serde_json::to_value(notice).unwrap()
                    }
                    Frame::StreamEnd(()) => serde_json::Value::Null,
                    Frame::Error(error) => serde_json::to_value(error).unwrap(),
                    Frame::Response(Answer::Ack(answer)) => {
                        assert_eq!(record.op, ACK_OP);
                        decode_ack(&bytes).unwrap();
                        serde_json::to_value(answer).unwrap()
                    }
                    Frame::Response(Answer::Yield(answer)) => {
                        assert_eq!(record.op, YIELD_OP);
                        assert_eq!(decode_yield(&bytes).unwrap(), answer.result.yielded);
                        serde_json::to_value(answer).unwrap()
                    }
                };
                assert_eq!(&encoded, body, "{file}: {}", record.op);
                frames += 1;
            }
        }
    }
    assert_eq!(frames, 21);
}

/// The requests are sent as `{"method": op, "params": request}`, with the
/// op and params the samples record.
#[test]
fn the_watch_and_its_requests_are_framed_as_the_samples_record_them() {
    let framed = |bytes: Vec<u8>| serde_json::from_slice::<serde_json::Value>(&bytes).unwrap();
    let watch = &records("not-holding.json")[0];
    assert_eq!(
        framed(watch_request("dreamer.pj-fern_01")),
        json!({"method": watch.op, "params": watch.request})
    );
    let ack = &records("ack.json")[1];
    assert_eq!(
        framed(ack_request("dreamer.pj-fern_01", 2)),
        json!({"method": ack.op, "params": ack.request})
    );
    let offer = &records("yield-transferred.json")[0];
    assert_eq!(
        framed(yield_request("connector_home", 1)),
        json!({"method": offer.op, "params": offer.request})
    );
}

#[test]
fn roles_are_named_for_their_owner() {
    assert_eq!(role(&OwnerKey::project("pj-fern_01")), "dreamer.pj-fern_01");
    assert_eq!(
        role(&OwnerKey::workspace("workspace_02")),
        "dreamer.workspace_02"
    );
    assert_eq!(role(&OwnerKey::global()), "dreamer.global");
}
/// A single computer grants the role at once at gen 1, and renews it; each
/// notice is acknowledged, and closing the lease closes the watch.
#[tokio::test]
async fn a_single_computer_grants_the_role_at_gen_one() {
    let leases = SampleLeases::new();
    leases.default_script(steps("sharing-disabled.json", "dreamer.global"));
    let (_, clock) = fake_clock(120_500);
    let lease = Lease::open(&*leases, "dreamer.global", &clock)
        .await
        .unwrap();
    assert_eq!(lease.standing(&clock).await, Standing::Acting { gen: 1 });
    lease.close().await;
    let log = leases.log();
    assert_eq!(log.opened, ["dreamer.global"]);
    assert_eq!(
        log.acks,
        [
            ("dreamer.global".to_owned(), 3),
            ("dreamer.global".to_owned(), 4)
        ]
    );
    assert_eq!(log.closed, ["dreamer.global"]);
}

/// `holding: false` is refused with its reason, and still acknowledged.
#[tokio::test]
async fn a_role_another_computer_holds_is_refused_and_its_notice_acknowledged() {
    let leases = SampleLeases::new();
    leases.default_script(steps("not-holding.json", "dreamer.pj-fern_01"));
    let (_, clock) = fake_clock(100_500);
    let refused = Lease::open(&*leases, "dreamer.pj-fern_01", &clock)
        .await
        .err()
        .unwrap();
    assert_eq!(refused, "this computer does not hold dreamer.pj-fern_01");
    let log = leases.log();
    assert_eq!(log.acks, [("dreamer.pj-fern_01".to_owned(), 2)]);
    assert_eq!(log.closed, ["dreamer.pj-fern_01"]);
}

/// Nothing extends the window, so the run stops acting at its deadline
/// (less the margin) while the watch is still open.
#[tokio::test]
async fn a_lapsed_window_stops_the_run_with_the_watch_still_open() {
    let leases = SampleLeases::new();
    // The sample's closing `StreamEnd` is the recording test closing the
    // watch; leaving it out keeps the watch open throughout.
    leases.default_script(steps("lapsed.json", "dreamer.workspace_02"));
    let (now, clock) = fake_clock(100_500);
    let lease = Lease::open(&*leases, "dreamer.workspace_02", &clock)
        .await
        .unwrap();
    assert_eq!(lease.standing(&clock).await, Standing::Acting { gen: 4 });
    now.store(145_000 - MARGIN_MS, Ordering::SeqCst);
    assert_eq!(lease.standing(&clock).await, Standing::Acting { gen: 4 });
    now.store(145_000 - MARGIN_MS + 1, Ordering::SeqCst);
    assert!(matches!(lease.standing(&clock).await, Standing::Lost(_)));
    assert!(leases.log().closed.is_empty(), "the watch is still open");
    lease.close().await;
}

/// The deadline is fixed by when the notice was issued: one that arrives
/// 30 seconds late grants 15 seconds, not 45.
#[tokio::test]
async fn a_late_notice_grants_less_time() {
    let leases = SampleLeases::new();
    leases.default_script(steps("lapsed.json", "dreamer.workspace_02"));
    // Issued at 100 000 for 45 000: received 30 000 late.
    let (now, clock) = fake_clock(130_000);
    let lease = Lease::open(&*leases, "dreamer.workspace_02", &clock)
        .await
        .unwrap();
    assert_eq!(lease.standing(&clock).await, Standing::Acting { gen: 4 });
    // Counted from its receipt the window would run to 175 000.
    now.store(140_000, Ordering::SeqCst);
    assert!(matches!(lease.standing(&clock).await, Standing::Lost(_)));
    lease.close().await;
    // So late that less than the margin is left: not taken at all.
    let (_, clock) = fake_clock(136_000);
    assert!(Lease::open(&*leases, "dreamer.workspace_02", &clock)
        .await
        .is_err());
}

/// The notice `handback.json` records (gen 9, `handback: true`, seq 3),
/// and the same notice before the request came: seq 2, without handback.
fn handback_notices() -> (Notice, Notice) {
    let handback = notices("handback.json", "dreamer.global").remove(0);
    let mut held = handback.clone();
    held.handback = false;
    held.seq = 2;
    (held, handback)
}

/// At the safe point after the batch in flight, a handback is offered with
/// a yield of the generation held. A yield that hands the role over stops
/// the run at once, its window not yet passed, and it is never offered
/// again. Every notice is acknowledged.
#[tokio::test]
async fn a_handback_is_yielded_and_a_transfer_stops_the_run() {
    let leases = SampleLeases::new();
    let (held, handback) = handback_notices();
    leases.default_script(vec![Step::Notice(held)]);
    leases.answer_yield("dreamer.global", Ok(yielded("yield-transferred.json")));
    let (_, clock) = fake_clock(100_500);
    let lease = Lease::open(&*leases, "dreamer.global", &clock)
        .await
        .unwrap();
    assert_eq!(lease.standing(&clock).await, Standing::Acting { gen: 9 });
    assert!(leases.log().yields.is_empty(), "nothing was asked yet");
    assert!(leases.send("dreamer.global", Step::Notice(handback)));
    assert_eq!(lease.standing(&clock).await, Standing::HandedBack);
    assert_eq!(lease.standing(&clock).await, Standing::HandedBack);
    lease.close().await;
    let log = leases.log();
    assert_eq!(log.yields, [("dreamer.global".to_owned(), 9)]);
    assert_eq!(
        log.acks,
        [
            ("dreamer.global".to_owned(), 2),
            ("dreamer.global".to_owned(), 3)
        ]
    );
    assert_eq!(log.closed, ["dreamer.global"]);
}

/// A yield the other computer withdrew keeps the role: the run goes on
/// within the same deadline, offers the same request only once, and the
/// renewal that follows (`handback: false`, a fresh deadline) extends it.
#[tokio::test]
async fn a_withdrawn_yield_keeps_the_role() {
    let leases = SampleLeases::new();
    let (held, handback) = handback_notices();
    leases.default_script(vec![Step::Notice(held)]);
    leases.answer_yield("dreamer.global", Ok(yielded("yield-withdrawn.json")));
    let (now, clock) = fake_clock(100_500);
    let lease = Lease::open(&*leases, "dreamer.global", &clock)
        .await
        .unwrap();
    assert!(leases.send("dreamer.global", Step::Notice(handback.clone())));
    assert_eq!(lease.standing(&clock).await, Standing::Acting { gen: 9 });
    assert_eq!(lease.standing(&clock).await, Standing::Acting { gen: 9 });
    assert_eq!(leases.log().yields, [("dreamer.global".to_owned(), 9)]);
    // The old window ends at 120 000: past it, less the margin, the run
    // stops unless a renewal came.
    now.store(112_000, Ordering::SeqCst);
    assert!(matches!(lease.standing(&clock).await, Standing::Lost(_)));
    let mut renewed = handback;
    renewed.handback = false;
    renewed.issued_at_ms = 110_000;
    renewed.seq = 4;
    assert!(leases.send("dreamer.global", Step::Notice(renewed)));
    assert_eq!(lease.standing(&clock).await, Standing::Acting { gen: 9 });
    lease.close().await;
}

/// A yield whose answer never comes leaves unknown whether the role was
/// handed over: the run acts no more for it.
#[tokio::test(start_paused = true)]
async fn an_unanswered_yield_stops_the_run() {
    let leases = SampleLeases::new();
    let (held, handback) = handback_notices();
    leases.default_script(vec![Step::Notice(held)]);
    let (_, clock) = fake_clock(100_500);
    let lease = Lease::open(&*leases, "dreamer.global", &clock)
        .await
        .unwrap();
    assert!(leases.send("dreamer.global", Step::Notice(handback)));
    assert_eq!(
        lease.standing(&clock).await,
        Standing::Lost("the yield of dreamer.global got no answer within 10 seconds".into())
    );
    lease.close().await;
}

/// A run whose first notice already asks for the role has nothing in
/// flight: it offers the role at once, and starts only when the request was
/// withdrawn.
#[tokio::test]
async fn a_handback_in_the_first_notice_is_yielded_before_the_run_starts() {
    let leases = SampleLeases::new();
    let (_, handback) = handback_notices();
    leases.default_script(vec![Step::Notice(handback)]);
    let (_, clock) = fake_clock(100_500);
    leases.answer_yield("dreamer.global", Ok(yielded("yield-transferred.json")));
    let first = Lease::open(&*leases, "dreamer.global", &clock).await.err();
    assert_eq!(
        first.as_deref(),
        Some("dreamer.global was handed over to another computer that asked for it")
    );
    leases.answer_yield("dreamer.global", Ok(yielded("yield-withdrawn.json")));
    let kept = Lease::open(&*leases, "dreamer.global", &clock)
        .await
        .unwrap();
    assert_eq!(kept.standing(&clock).await, Standing::Acting { gen: 9 });
    kept.close().await;
    assert_eq!(leases.log().yields.len(), 2);
}

/// A notice that withdraws the role mid-run stops the run at once, however
/// much of the earlier window was left.
#[tokio::test]
async fn a_withdrawn_role_stops_the_run() {
    let leases = SampleLeases::new();
    let mut engram = notices("engram-sharing.json", "connector_home");
    let withdrawn = engram.pop().unwrap();
    leases.default_script(engram.into_iter().map(Step::Notice).collect());
    let (_, clock) = fake_clock(140_500);
    let lease = Lease::open(&*leases, "connector_home", &clock)
        .await
        .unwrap();
    assert_eq!(lease.standing(&clock).await, Standing::Acting { gen: 12 });
    assert!(leases.send("connector_home", Step::Notice(withdrawn)));
    assert_eq!(
        lease.standing(&clock).await,
        Standing::Lost("this computer does not hold connector_home".into())
    );
    lease.close().await;
}

/// The watch ending is no expiry: the newest notice's window holds until
/// its deadline (`lapsed.json`, played to its closing `StreamEnd`).
#[tokio::test]
async fn an_ended_watch_still_acts_until_its_deadline() {
    let leases = SampleLeases::new();
    let played: Vec<Step> = records("lapsed.json")[0]
        .frames
        .iter()
        .map(|frame| match frame {
            Frame::StreamData(notice) => Step::Notice(notice.clone()),
            Frame::StreamEnd(()) => Step::End,
            other => panic!("lapsed.json serves no {other:?}"),
        })
        .collect();
    leases.default_script(played);
    let (now, clock) = fake_clock(100_500);
    let lease = Lease::open(&*leases, "dreamer.workspace_02", &clock)
        .await
        .unwrap();
    assert_eq!(lease.standing(&clock).await, Standing::Acting { gen: 4 });
    assert_eq!(
        leases.log().closed,
        ["dreamer.workspace_02"],
        "the watch ended"
    );
    now.store(135_001, Ordering::SeqCst);
    assert!(matches!(lease.standing(&clock).await, Standing::Lost(_)));
    lease.close().await;
}

/// A watch Entorhinal ends on a refusal before any notice is refused with
/// that refusal.
#[tokio::test]
async fn a_watch_refused_before_any_notice_names_the_refusal() {
    let leases = SampleLeases::new();
    let Frame::Error(error) = records("refusals.json")[4].frames[0].clone() else {
        panic!("the flow-scoped refusal is an error frame");
    };
    leases.default_script(vec![Step::Refuse(error)]);
    let (_, clock) = fake_clock(100_500);
    let refused = Lease::open(&*leases, "dreamer.global", &clock).await.err();
    assert_eq!(
        refused.as_deref(),
        Some(
            "the dreamer.global watch ended before any notice (caller_forbidden: \
             only the module assigned to this role may open or control its lease)"
        )
    );
}

/// No first notice within the bound: refused as unanswered.
#[tokio::test(start_paused = true)]
async fn an_unanswered_watch_is_refused_after_the_bound() {
    let leases = SampleLeases::new();
    let (_, clock) = fake_clock(100_500);
    let started = tokio::time::Instant::now();
    let refused = Lease::open(&*leases, "dreamer.global", &clock).await.err();
    assert_eq!(
        refused.as_deref(),
        Some("Entorhinal did not answer for dreamer.global within 10 seconds")
    );
    assert_eq!(started.elapsed(), FIRST_NOTICE);
    assert_eq!(leases.log().closed, ["dreamer.global"]);
}

/// Entorhinal's refusal of the watch is the reason, with its code.
#[tokio::test]
async fn a_refused_watch_names_the_refusal() {
    let leases = SampleLeases::new();
    let Frame::Error(error) = records("refusals.json")[0].frames[0].clone() else {
        panic!("the first refusal is an error frame");
    };
    leases.refuse("dreamer..global", error);
    let (_, clock) = fake_clock(100_500);
    let refused = Lease::open(&*leases, "dreamer..global", &clock).await.err();
    assert_eq!(
        refused.as_deref(),
        Some("Entorhinal refused the dreamer..global lease (invalid_request: invalid role name)")
    );
}

#[test]
fn the_monotonic_clock_moves_forward() {
    let first = monotonic_ms();
    let second = monotonic_ms();
    assert!(first > 0 && first != u64::MAX);
    assert!(second >= first);
}
