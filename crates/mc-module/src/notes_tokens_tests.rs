use super::*;
use cortexkit_role_compaction::tokens::{PartTokens, SurfaceTokens};

fn count(n: u64) -> Option<SurfaceTokens> {
    Some(SurfaceTokens::new(n, true))
}

fn pair(old: u64, new: u64) -> crate::prompt_notes::Notes {
    let mut notes = crate::prompt_notes::Notes::default();
    notes.notice(count(old), Some("family"));
    notes.notice(count(new), Some("family"));
    notes
}

#[test]
fn notes_tokens_adjust_only_exact_known_growth_and_clamp_the_fixed_part() {
    assert_eq!(pair(100, 400).fixed_part(1_000.0), 1_300.0);
    assert_eq!(pair(400, 100).fixed_part(1_000.0), 700.0);
    assert_eq!(pair(4_000, 100).fixed_part(1_000.0), 0.0);
    assert_eq!(pair(400, 400).fixed_part(1_000.0), 1_000.0);
    for (old, new) in [
        (None, count(400)),
        (count(100), None),
        (Some(SurfaceTokens::new(100, false)), count(400)),
        (count(100), Some(SurfaceTokens::new(400, false))),
    ] {
        let mut notes = crate::prompt_notes::Notes::default();
        notes.notice(old, Some("family"));
        notes.notice(new, Some("family"));
        assert_eq!(notes.fixed_part(1_000.0), 1_000.0);
    }
    let mut notes = pair(100, 400);
    notes.notice(count(2_000), Some("other-family"));
    assert_eq!(notes.measured, None);
    assert_eq!(notes.fixed_part(1_000.0), 1_000.0);
}

#[tokio::test]
async fn notes_tokens_refresh_on_notices_not_rides_and_survive_restart() {
    let (mut session, client, _, _, settings) = fixture();
    let mut previous = None;
    for (seq, pending) in [count(100), count(400), None, count(700), count(0)]
        .into_iter()
        .enumerate()
    {
        let mut request = notice(&session, seq as u64 + 1, None);
        request.conditions.notes_tokens = pending;
        request.token_family = pending.map(|_| "family".into());
        session.notice(&client, &settings, request).await;
        assert_eq!(session.notes.pending, pending);
        assert_eq!(session.notes.measured, previous);
        previous = pending;
    }
    let saved = session.notes.clone();
    let mut duplicate = notice(&session, 5, None);
    duplicate.conditions.notes_tokens = count(999);
    session.notice(&client, &settings, duplicate).await;
    assert_eq!(session.notes, saved);

    let mut ride_conditions = session.conditions.clone();
    ride_conditions.notes_tokens = None;
    let ride = RideRequest::new(vec![RideCause::CacheExpired], 1_000, ride_conditions);
    session.ride(&settings, &ride);
    assert_eq!(session.notes, saved, "rides carry no surface counts");

    let mut durable = serde_json::to_value(session.durable()).unwrap();
    let (mut restored, _, _, _, _) = fixture();
    restored.restore(serde_json::from_value(durable.clone()).unwrap());
    assert_eq!(restored.notes, saved);
    durable.as_object_mut().unwrap().remove("notes");
    restored.restore(serde_json::from_value(durable).unwrap());
    assert_eq!(restored.notes, Default::default());
    assert_eq!(crate::store::SCHEMA_VERSION, 5);
}

#[tokio::test]
async fn notes_tokens_map_attributes_measured_notes_not_pending_growth() {
    for exact in [true, false] {
        let (mut session, client, _, _, settings) = fixture();
        for (seq, n) in [(1, 100), (2, 400), (3, 0), (4, 0)] {
            let mut request = notice(&session, seq, None);
            request.conditions.notes_tokens = Some(SurfaceTokens::new(n, exact));
            request.conditions.last_prompt_tokens = Some(1_000);
            request.conditions.system_tokens = count(200);
            request.conditions.tools_tokens = count(50);
            request.token_family = Some("family".into());
            session.notice(&client, &settings, request).await;
            let snapshot = session.app_snapshot();
            let notes = snapshot.breakdown["parts"]
                .as_array()
                .unwrap()
                .iter()
                .find(|part| part["part"] == "notes")
                .expect("notes category");
            let measured = match seq {
                1 => None,
                2 => Some(100),
                3 => Some(400),
                _ => Some(0),
            };
            assert_eq!(notes["tokens"], serde_json::json!(measured));
            assert_eq!(notes["estimate"], measured.is_none() || !exact);
            assert_eq!(
                snapshot.breakdown["unattributed"],
                750 - measured.unwrap_or(0)
            );
            assert_eq!(snapshot.breakdown["total"]["tokens"], 1_000);
            let breakdown = snapshot.breakdown.to_value();
            let item = breakdown["items"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["item"] == "notes")
                .unwrap();
            assert_eq!(item["tokens"], serde_json::json!(measured));
        }
    }
}

#[test]
fn notes_tokens_change_emergency_target_without_double_counting_a_ride() {
    let mut index = Index::default();
    let entries: Vec<_> = (1..=20)
        .map(|n| {
            let mut part: Part = serde_json::from_value(serde_json::json!({
                "id":"p", "kind":"tool", "call_id":format!("c{n}"),
                "name":"bash", "input":{}, "status":"completed", "digest":"d"
            }))
            .unwrap();
            part.tag = Some(n);
            part.tokens = Some(PartTokens::tool(0, 1_000));
            Entry::new(n, format!("m{n}"), Role::Assistant, n, vec![part])
        })
        .collect();
    index.extend_counted(entries, Some("family"));
    let edited = lanes::Edited::of(None, &index, None);
    let context = lanes::Context {
        index: &index,
        edited: &edited,
        protected_tools: &Default::default(),
        keep_first_message: false,
        signed_floor: None,
    };
    for (notes, request_tokens, expected) in [
        (Default::default(), None, 8),
        (pair(1_000, 11_000), None, 11),
        (pair(11_000, 1_000), None, 5),
        (pair(21_000, 0), None, 5),
        (pair(1_000, 11_000), Some(40_000), 11),
        (pair(1_000, 11_000), Some(50_000), 14),
        (pair(0, 50_001), None, 0),
    ] {
        let emergency = lanes::Emergency {
            prompt_tokens: 30_000,
            request_tokens,
            notes,
            ceiling_tokens: 50_000,
            over_limit: true,
            priced: true,
        };
        assert_eq!(
            lanes::emergency_drop(&context, None, &emergency).len(),
            expected
        );
    }
}

#[tokio::test]
async fn notes_tokens_stale_reading_keeps_its_measured_attribution() {
    let (mut session, client, _, _, settings) = fixture();
    session.notes = pair(100, 400);
    session.conditions.last_prompt_tokens = Some(1_000);
    session.conditions.last_prompt_view = Some(2);
    session.newest_applied = 2;
    let view = View::seal(2, Vec::new());
    let applied = AppliedView::new(view.version, view.checksum.clone());
    session.latest = Some(view);
    let mut request = notice(&session, 1, None);
    request.applied_view = Some(applied);
    request.conditions.last_prompt_tokens = Some(2_000);
    request.conditions.last_prompt_view = Some(1);
    request.conditions.notes_tokens = count(700);
    request.token_family = Some("family".into());
    session.notice(&client, &settings, request).await;
    assert!(session.reading_stale);
    assert_eq!(session.conditions.last_prompt_tokens, Some(1_000));
    assert_eq!(session.notes.measured, count(100));
    assert_eq!(session.notes.pending, count(700));
}

#[test]
fn notes_tokens_growth_changes_the_post_drop_summary_trigger() {
    let (mut session, _, _, _, settings) = fixture();
    session.conditions.output_reserve = 0;
    session.conditions.last_prompt_tokens = Some(90_000);
    let mut entries = vec![text(1, "a"), text(2, "b")];
    for entry in &mut entries {
        entry.role = Role::Assistant;
        entry.parts[0].tokens = Some(PartTokens::count(10_000));
    }
    session.index.extend_counted(entries, Some("family"));
    session.queued.insert(("a".into(), "p".into()));
    assert_eq!(session.usage_after_drops(&settings, 90.0), Some(45.0));
    session.notes = pair(1_000, 31_000);
    assert_eq!(session.usage_after_drops(&settings, 90.0), Some(75.0));
    let pressure = trigger::Pressure {
        usage: 90.0,
        threshold: 65.0,
        force: true,
        usable_window: crate::pass::usable_window(&session.conditions),
        after_drops: session.usage_after_drops(&settings, 90.0),
    };
    let scan = trigger::Scan {
        tokens: 20_000,
        raw_tokens: 20_000,
        // Text the summary would remove; well above the force band's 2% minimum.
        removed_tokens: 20_000,
        messages: 20,
        has_more: false,
        commit_clusters: 0,
    };
    assert!(trigger::decide(&pressure, Some(&scan), 10_000, Some(3)).is_some());
    session.notes = pair(70_000, 0);
    assert_eq!(session.usage_after_drops(&settings, 90.0), Some(10.0));
}
