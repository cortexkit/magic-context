use super::*;

const FIXTURE: &str =
    include_str!("../testdata/cache-bust-sentinel/cache-bust-runner-structured.log.txt");

// The sentinel tests pair the fixture's unchanged-view line with this request,
// which was made synthetic in cache-bust-runner-log.test.ts rather than recorded.
const RIDE_REQUEST: &str = r#"INFO magic-context: ck-mc: session: the runner requested a ride session=s1 causes="[ChainReset]" request_tokens=Some(430000) last_prompt_tokens=650000 applied_view=Some(11)"#;

#[test]
fn cache_sentinel_log_fixture_matches_plugin_copy() {
    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/plugin/scripts/fixtures/cache-bust-runner-structured.log.txt");
    let source = std::fs::read(&source)
        .unwrap_or_else(|err| panic!("cache-bust sentinel fixture {}: {err}", source.display()));
    assert!(
        FIXTURE.as_bytes() == source,
        "the vendored cache-bust sentinel fixture differs from the plugin copy"
    );
}

#[tokio::test]
async fn cache_sentinel_log_events_keep_their_messages_and_fields() {
    let mut capture = crate::test_log::capture();
    log_ride_and_view_events().await;
    log_summary_events().await;
    capture.stop();
    let log = capture.text();

    // Ignore timestamps, targets, levels and values. Quoted values can have
    // spaces (or text that looks like another field); the sentinel recognizes
    // the fixed message and named fields, not the session's particular values.
    let field = regex::Regex::new(r#" ([a-z][a-z0-9_]*)=(?:"(?:[^"\\]|\\.)*"|[^ ]*)"#).unwrap();
    let shape = |line: &str| {
        let (_, event) = line.split_once(" ck-mc: session: ")?;
        let first = field.find(event)?;
        let mut names: Vec<_> = field
            .captures_iter(event)
            .map(|c| c[1].to_owned())
            .collect();
        names.sort_unstable();
        Some((event[..first.start()].to_owned(), names))
    };
    let mut actual: Vec<_> = log.lines().filter_map(shape).collect();
    for line in FIXTURE.lines().chain([RIDE_REQUEST]) {
        let expected = shape(line)
            .unwrap_or_else(|| panic!("invalid cache-bust sentinel fixture line: {line}"));
        let matched = actual.iter().position(|event| *event == expected).unwrap_or_else(|| {
            panic!("cache-bust sentinel lost a log event with message {:?} and fields {:?}\nCaptured module log:\n{log}", expected.0, expected.1)
        });
        actual.swap_remove(matched);
    }
}

async fn log_ride_and_view_events() {
    let (mut session, client, route, mut setup, settings) = fixture();
    let entries = vec![text(1, "earlier"), text(2, "newest")];
    setup.newest = entries.last().map(cursor);
    *client.entries.lock().unwrap() = entries;
    session
        .setup(&client, &settings, &route, &setup, session.features)
        .await;

    let mut conditions = session.conditions.clone();
    conditions.signed_floor = Some(cortexkit_role_compaction::SignedFloor::new("earlier"));
    conditions.last_prompt_tokens = Some(20_000);
    let _ = session.ride(
        &settings,
        &RideRequest::new(vec![RideCause::ChainReset], 1_000, conditions),
    );

    let first = session.seal_unchecked(Vec::new());
    session.publish(&client, first.clone()).await;
    session.settle_unconfirmed(Some(&first.applied()), &[]);
    let next = session.seal_unchecked(Vec::new());
    session.publish(&client, next.clone()).await;
    session.settle_unconfirmed(Some(&next.applied()), &[]);
    session.conditions.last_prompt_tokens = Some(70_000);
    session.conditions.last_prompt_view = Some(first.version);
    session.judge_reading((None, None), Some(&next.applied()));

    let pending = session.seal_unchecked(Vec::new());
    session.publish(&client, pending).await;
    *client.refuse.lock().unwrap() = true;
    *client.refusal.lock().unwrap() = Some(ViewRefusal::BadChecksum);
    session
        .offer_unconfirmed_again(&client, StatedView::Older)
        .await;
}

async fn log_summary_events() {
    let (mut session, client, _, _, settings) = fixture();
    session.features.summarizer = true;
    session.conditions.last_prompt_tokens = Some(75_000);
    let _ = session.summary_due(&settings);

    let entries = vec![text(1, "earlier"), text(2, "newest")];
    session.index.extend(entries.clone());
    *client.entries.lock().unwrap() = entries;
    session.begin_summary(&settings, 1, 2, false, false);
    let compartment = serde_json::from_value(serde_json::json!({
        "sequence": 0, "start_message": 1, "end_message": 1,
        "start_message_id": "earlier", "end_message_id": "earlier",
        "title": "Earlier", "content": "Earlier work", "p1": "Earlier work"
    }))
    .unwrap();
    let result = run::Summarized {
        validated: crate::summary::validate::ValidatedChunk {
            compartments: vec![compartment],
            ..Default::default()
        },
        source: run::PublicationSource::new(1, 2, session.index.entries()),
        publication: None,
        continuation: None,
    };
    let _ = session
        .summary_finished(&client, &settings, Ok(Some(result)), 100)
        .await;
}
