//! The runner's signed floor: ck-mc takes it from Setup and from every
//! notice's conditions, keeps it moving forward only, saves it with the
//! session, and stops treating the signed reasoning it covers as sent.

use super::*;
use cortexkit_role_compaction::SignedFloor;

/// Log output, for counting how often the floor's move is logged.
#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for Captured {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Captured {
    fn install(&self) -> tracing::subscriber::DefaultGuard {
        let writer = self.clone();
        tracing::subscriber::set_default(
            tracing_subscriber::fmt()
                .without_time()
                .with_ansi(false)
                .with_writer(move || writer.clone())
                .finish(),
        )
    }

    fn count(&self, needle: &str) -> usize {
        String::from_utf8(self.0.lock().unwrap().clone())
            .unwrap()
            .matches(needle)
            .count()
    }
}

const MOVED: &str = "signed floor moved";

fn transcript() -> Vec<Entry> {
    (1..=4).map(|n| text(n, &format!("m{n}"))).collect()
}

/// A notice whose conditions name `through` as the signed floor.
fn floor_notice(session: &Session, seq: u64, through: &str) -> NoticeRequest {
    let mut request = notice(session, seq, transcript().last().map(cursor));
    request.conditions.signed_floor = Some(SignedFloor::new(through));
    request
}

/// A session set up on a transcript of four messages, with the floor Setup
/// reported, if any.
async fn set_up(floor: Option<&str>) -> (Session, Client, Route, SetupRequest, Settings) {
    let (mut session, client, route, mut request, settings) = fixture();
    *client.entries.lock().unwrap() = transcript();
    request.newest = transcript().last().map(cursor);
    if let Some(floor) = floor {
        request = request.with_signed_floor(SignedFloor::new(floor), true);
    }
    session
        .setup(&client, &settings, &route, &request, session.features)
        .await;
    assert!(session.index_ready);
    (session, client, route, request, settings)
}

#[tokio::test]
async fn signed_floor_setup_reports_it_and_ck_mc_takes_it() {
    let captured = Captured::default();
    let _guard = captured.install();
    let (session, ..) = set_up(Some("m2")).await;
    assert_eq!(session.signed_floor.as_deref(), Some("m2"));
    assert_eq!(session.signed_floor(), Some(2));
    assert_eq!(captured.count(MOVED), 1);
    // Without a floor in Setup there is none.
    let (session, ..) = set_up(None).await;
    assert_eq!(session.signed_floor, None);
    assert_eq!(session.signed_floor(), None);
}

#[tokio::test]
async fn signed_floor_conditions_move_it_forward_and_never_back() {
    let captured = Captured::default();
    let _guard = captured.install();
    let (mut session, client, _, _, settings) = set_up(Some("m2")).await;
    session
        .notice(&client, &settings, floor_notice(&session, 1, "m3"))
        .await;
    assert_eq!(session.signed_floor(), Some(3));
    // The same floor again is no move and logs nothing.
    session
        .notice(&client, &settings, floor_notice(&session, 2, "m3"))
        .await;
    // A lower floor never moves it back.
    session
        .notice(&client, &settings, floor_notice(&session, 3, "m1"))
        .await;
    assert_eq!(session.signed_floor.as_deref(), Some("m3"));
    assert_eq!(session.signed_floor(), Some(3));
    // Conditions without a floor leave it where it is.
    let mut without = notice(&session, 4, transcript().last().map(cursor));
    without.conditions.signed_floor = None;
    session.notice(&client, &settings, without).await;
    assert_eq!(session.signed_floor(), Some(3));
    // Setup to m2, then the move to m3: logged once each.
    assert_eq!(captured.count(MOVED), 2);
}

#[tokio::test]
async fn signed_floor_naming_an_entry_ck_mc_does_not_hold_is_not_taken() {
    let (mut session, client, _, _, settings) = set_up(None).await;
    session
        .notice(&client, &settings, floor_notice(&session, 1, "elsewhere"))
        .await;
    assert_eq!(session.signed_floor, None);
}

#[tokio::test]
async fn signed_floor_survives_a_restart_and_a_lower_floor_after_it() {
    let (session, client, route, request, settings) = set_up(Some("m3")).await;
    let bytes = serde_json::to_vec(&session.durable()).unwrap();
    let saved: crate::store::Durable = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(saved.signed_floor.as_deref(), Some("m3"));
    let (mut restored, ..) = fixture();
    restored.restore(saved);
    assert_eq!(restored.signed_floor.as_deref(), Some("m3"));
    // The runner's Setup after the restart reports an older floor; the one
    // ck-mc saved stands.
    let lower = request.with_signed_floor(SignedFloor::new("m1"), true);
    restored
        .setup(&client, &settings, &route, &lower, restored.features)
        .await;
    assert_eq!(restored.signed_floor(), Some(3));
    // A session that never had a floor saves none, so its row is unchanged.
    let (plain, ..) = fixture();
    let saved = serde_json::to_value(plain.durable()).unwrap();
    assert!(saved.get("signed_floor").is_none());
}

/// Heavy signed reasoning in the current turn holds an execute pass, unless
/// the runner already strips it: then there is nothing left to protect.
#[test]
fn signed_floor_the_hold_ignores_heavy_reasoning_at_or_before_it() {
    let reasoning = |id: &str| {
        Part::new(
            id,
            PartBody::Reasoning {
                text: None,
                text_bytes: Some(8_000),
            },
        )
        .with_seal(cortexkit_role_compaction::part::Seal::Signed)
    };
    // 2,000 visible reasoning tokens in each of two steps after the prompt,
    // then a light step.
    let entries = vec![
        text(1, "prompt"),
        Entry::new(2, "m2", Role::Assistant, 2, vec![reasoning("r2")]),
        Entry::new(3, "m3", Role::Assistant, 3, vec![reasoning("r3")]),
        Entry::new(
            4,
            "m4",
            Role::Assistant,
            4,
            vec![Part::new("t4", PartBody::Text { text: "ok".into() })],
        ),
    ];
    let mut conditions = Conditions::new(
        ModelRef::new("test", "model"),
        100_000,
        1_000,
        ProviderRules::new(SignedParts::Bound, EditCost::Suffix),
    );
    // 70%: over the execute threshold, under the hold's cap.
    conditions.last_prompt_tokens = Some(69_300);
    let settings = Settings::default();
    let hold =
        |floor: Option<u64>| pass::signed_thinking_hold(&entries, &conditions, &settings, floor);
    assert!(hold(None));
    // The floor covers the first heavy step only: the second still holds.
    assert!(hold(Some(2)));
    // The floor covers both: nothing left to protect.
    assert!(!hold(Some(3)));
    assert!(!hold(Some(4)));
    assert!(!pass::heavy_signed_turn(&entries, &conditions, Some(3)));
}

/// Reasoning clearing measures what the next request sends: signed
/// reasoning the runner strips is neither counted nor dropped.
#[tokio::test]
async fn signed_floor_reasoning_clearing_leaves_stripped_reasoning_alone() {
    let (mut session, client, _, _, _) = set_up(None).await;
    let signed = |id: &str| {
        Part::new(
            id,
            PartBody::Reasoning {
                text: None,
                text_bytes: Some(32_000),
            },
        )
        .with_seal(cortexkit_role_compaction::part::Seal::Signed)
    };
    // Four steps of 8,000 reasoning tokens after the four messages.
    let steps: Vec<Entry> = (5..=8)
        .map(|n| {
            Entry::new(
                n,
                format!("m{n}"),
                Role::Assistant,
                n,
                vec![signed(&format!("r{n}"))],
            )
        })
        .collect();
    session.index.extend(steps.clone());
    *client.entries.lock().unwrap() = transcript().into_iter().chain(steps).collect();
    let settings = Settings {
        keep_reasoning_tokens: 10_000,
        protected_tokens: Some(0),
        ..Settings::default()
    };
    let cleared = |session: &Session| -> Vec<String> {
        let edited = lanes::Edited::default();
        let context = lanes::Context {
            index: &session.index,
            edited: &edited,
            protected_tools: &settings.protected_tools,
            keep_first_message: false,
            signed_floor: session.signed_floor(),
        };
        lanes::reasoning_over_budget(&context, settings.keep_reasoning_tokens, false)
            .into_iter()
            .map(|((mid, _), _)| mid)
            .collect()
    };
    assert_eq!(cleared(&session), ["m5", "m6", "m7"]);
    session.conditions.signed_floor = Some(SignedFloor::new("m6"));
    session.take_signed_floor();
    assert_eq!(cleared(&session), ["m7"]);
    // The projected usage after the drops weighs what they free against
    // what is sent: the four one-token messages and the 16,000 reasoning
    // tokens after the floor, not the 16,000 the runner strips.
    let projected = session.usage_after_drops(&settings, 0.9).unwrap();
    let expected = 0.9 * (1.0 - 8_000.0 / 16_004.0);
    assert!(
        (projected - expected).abs() < 1e-9,
        "{projected} vs {expected}"
    );
    session.conditions.signed_floor = Some(SignedFloor::new("m7"));
    session.take_signed_floor();
    assert!(cleared(&session).is_empty());
    assert_eq!(session.usage_after_drops(&settings, 0.9), None);
}
