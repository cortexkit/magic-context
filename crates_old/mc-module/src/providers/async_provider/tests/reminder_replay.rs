//! A deterministic transcript replay. `MC_REMINDER_BASELINE` skips reminder-specific
//! visibility assertions when this same fixture runs against a revision without a delivery ledger.
use super::*;

async fn send_hint(rig: &Rig, n: u64, hint: &str) {
    let store = rig.h.store.get().unwrap();
    let mut state = rig.h.checkout(store, &rig.reference).unwrap().unwrap();
    let mut cadence = state.reminder_cadence.take().unwrap_or_default();
    let id = format!("replay{n}");
    let hints = || Ok(Default::default());
    let conditions = crate::runner_reminders::ReminderConditions {
        notice_id: &id,
        now_ms: now_ms() as u64,
        real_user_turn_count: 0,
        baseline: None,
        newest_tool_tag: None,
        hints: &hints,
        drops_applied: false,
        baseline_refreshed: false,
        hard_fold_coverage_advanced: false,
        user_message_id: Some(&id),
        temporal_enabled: false,
        gap_ms: None,
        ready_search_hint: Some(hint),
    };
    let identity = state.runner_identity();
    let route = RoutedRunner {
        runner: rig.h.provider_runner.as_ref(),
        route: state.runner().unwrap(),
        identity: identity.clone(),
    };
    let outcome = crate::runner_reminders::send_due_reminders(
        &route,
        &identity.project_root,
        &identity.session,
        &mut cadence,
        &conditions,
    )
    .await;
    assert_eq!(outcome.issued.len(), 1, "{outcome:?}");
    let last_bind = rig.runner.bind_identities.lock().unwrap().last().cloned();
    assert_eq!(last_bind, Some(identity));
    state.reminder_cadence = Some(cadence);
    state.save(store, &[]).unwrap();
    rig.h.checkin(state);
}

#[tokio::test]
async fn randomized_reminder_base_head_view_replay_320_notices() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::open(
        dir.path(),
        "thalamus-harness",
        "claude-code",
        json!({"serializer_profile":"anthropic-messages"}),
    )
    .await;
    let baseline = std::env::var_os("MC_REMINDER_BASELINE").is_some();
    let mut rng = 0xd71c_4e62_a901_338fu64;
    let mut sent = Vec::new();
    let mut stripped = BTreeSet::new();
    let mut snapshots = Vec::new();
    let mut current: Option<view::CompactionView> = None;
    let mut rides = 0;
    for n in 0..320u64 {
        rng ^= rng << 13;
        rng ^= rng >> 7;
        rng ^= rng << 17;
        let delivered = n > 0 && rng.is_multiple_of(3);
        let text = if delivered {
            format!("delivered memory hint number {n}.")
        } else {
            format!("authored user words number {n}.")
        };
        if delivered {
            send_hint(&rig, n, &text).await;
            sent.push(n);
        }
        let mut entry = ReadMessage::new(
            n,
            format!("m{n}"),
            json!({"role":"user","content":[{"type":"text","text":text}]}),
        )
        .with_tags(vec![tags::PartTag::untagged("0")]);
        // Delivered fixtures use the same clock as session.send so chronology is provable.
        entry.written_at = Some(now_ms().max(0) as u64);
        rig.runner.entries.lock().unwrap().push(entry);
        let before = current
            .as_ref()
            .map(|view| serde_json::to_vec(view).unwrap());
        rig.notice(n + 1, 5000, current.as_ref().map(|view| view.view_version))
            .await;
        assert_eq!(
            rig.newest(),
            current.as_ref().map(|view| view.view_version),
            "defer at notice {}",
            n + 1
        );
        if let Some(view) = current.as_ref() {
            assert_eq!(
                serde_json::to_vec(&rig.get(view.view_version).await).unwrap(),
                before.unwrap()
            );
        }
        let permitted = n > 0 && rng % 11 < 2;
        if permitted {
            // Pending strips do not authorize a rebuild by themselves. Only a
            // published replacement view can make those edits visible.
            if let Some(view) = rig.ride("ttl_expired").await {
                let published = current.as_ref().map(|previous| previous.view_version)
                    != Some(view.view_version);
                current = Some(view);
                if published {
                    rides += 1;
                    for ordinal in sent.iter().rev().skip(1) {
                        stripped.insert(*ordinal);
                    }
                }
            }
        }
        let rendered = if let Some(view) = current.as_ref() {
            rig.render_anthropic(view)
        } else {
            let mut messages: Vec<Value> =
                serde_json::from_value(rig.state().initial["initial"]["replacement"].clone())
                    .unwrap();
            messages.extend(
                rig.runner
                    .entries
                    .lock()
                    .unwrap()
                    .iter()
                    .map(|entry| entry.message.clone()),
            );
            messages
        };
        if !baseline {
            for ordinal in &sent {
                let needle = format!("delivered memory hint number {ordinal}.");
                let visible = rendered
                    .iter()
                    .any(|message| message["content"].to_string().contains(&needle));
                assert_eq!(
                    visible,
                    !stripped.contains(ordinal),
                    "reminder {ordinal} at notice {}",
                    n + 1
                );
            }
        }
        snapshots.push(json!({"notice":n+1,"permitted":permitted,"sent":sent,"stripped":stripped,"messages":rendered}));
    }
    assert!(rides >= 30 && sent.len() >= 70 && stripped.len() >= 60);
    println!("reminder replay: 320 notices, {rides} published rides, {} exact deliveries, {} frozen strips", sent.len(), stripped.len());
    if let Some(path) = std::env::var_os("MC_REMINDER_REPLAY_OUT") {
        std::fs::write(path, serde_json::to_vec(&snapshots).unwrap()).unwrap();
    }
}
