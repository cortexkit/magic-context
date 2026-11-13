use super::*;

async fn sequence(randomized: bool) {
    let (_, new_client, route, mut setup, mut settings) = fixture();
    let (_, old_client, _, _, _) = fixture();
    let features = crate::preset::features("head").unwrap();
    setup.preset = "head".into();
    setup.model = ModelRef::new("anthropic", "claude-opus-5-5");
    let mut new = Session::new(&route, &setup, features, None);
    let mut old = new.clone();
    old.use_legacy_summary_scan(true);
    let mut seed = 0x7193_abcd_5391u64;
    let mut transcript: Vec<Entry> = Vec::new();
    let mut due = 0;
    let mut quiet = 0;
    for step in 1..=160u64 {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        let choice = if randomized { seed % 12 } else { step % 12 };
        let mut events = Vec::new();
        match choice {
            0 if transcript.len() > 6 => {
                let from = (transcript.len() / 2 + 1) as u64;
                transcript.truncate(from as usize - 1);
                events.push(Event::TranscriptChanged { from_ordinal: from });
            }
            1 => {
                settings.execute_threshold_percentage = [45.0, 65.0, 90.0][step as usize % 3];
                settings.commit_clusters = Some(step % 3 + 1);
                settings.turn_two = step % 2 == 0;
            }
            2 if transcript.len() > 4 => {
                // Apply the same accepted cut through the normal index-pruning
                // path, then let later undos and Setup invalidate derived data.
                let through = &transcript[transcript.len() / 3];
                let view = View::seal(
                    step,
                    vec![cortexkit_role_compaction::view::Edit::new(
                        step,
                        EditOp::Cut {
                            through: through.mid.clone(),
                        },
                    )],
                );
                new.apply_cut(&view);
                old.apply_cut(&view);
            }
            3 => {
                setup.model = if step % 2 == 0 {
                    ModelRef::new("test", "unknown")
                } else {
                    ModelRef::new("anthropic", "claude-opus-5-5")
                };
                setup.context_window = if step % 2 == 0 { 200_000 } else { 100_000 };
            }
            _ => {}
        }
        let ordinal = transcript.len() as u64 + 1;
        let mut entry = Entry::new(
            ordinal,
            format!("m{step}-{ordinal}"),
            if choice % 3 == 0 {
                Role::User
            } else {
                Role::Assistant
            },
            step,
            vec![Part::new(
                "p",
                PartBody::Text {
                    text: if choice == 4 {
                        "<system-reminder>notification</system-reminder>".into()
                    } else {
                        "Preserve the prefix. Committed abc1234; run the focused tests. "
                            .repeat(if choice == 5 { 300 } else { 25 })
                            .into()
                    },
                },
            )],
        );
        if choice == 6 {
            entry = entry.with_notice(cortexkit_role_compaction::read::NoticeOrigin::new("runner"));
        }
        transcript.push(entry.clone());
        *new_client.entries.lock().unwrap() = transcript.clone();
        *old_client.entries.lock().unwrap() = transcript.clone();
        let newest = Some(cursor(&entry));
        setup.newest = newest.clone();
        if choice == 7 {
            // Restart from the durable state, not a clone of the derived cache.
            let mut restarted = Session::new(&route, &setup, features, None);
            restarted.restore(new.durable());
            new = restarted;
            let mut restarted = Session::new(&route, &setup, features, None);
            restarted.restore(old.durable());
            restarted.use_legacy_summary_scan(true);
            old = restarted;
        }
        if choice == 7 || choice == 3 {
            let (a, a_log) = crate::test_log::logged_async(new.setup(
                &new_client,
                &settings,
                &route,
                &setup,
                features,
            ))
            .await;
            let (b, b_log) = crate::test_log::logged_async(old.setup(
                &old_client,
                &settings,
                &route,
                &setup,
                features,
            ))
            .await;
            assert_eq!(format!("{a:?}"), format!("{b:?}"), "Setup step {step}");
            assert_eq!(a_log, b_log, "Setup logs at step {step}");
        }
        for session in [&mut new, &mut old] {
            session.conditions.last_prompt_tokens = Some(match choice {
                8 => 96_000,
                9 => 86_000,
                10 => 65_000,
                _ => 10_000,
            });
        }
        let mut a_notice = notice(&new, step, newest.clone());
        a_notice.entries = vec![entry.clone()];
        a_notice.events = events.clone();

        let mut b_notice = notice(&old, step, newest);
        b_notice.entries = vec![entry];
        b_notice.events = events;

        let (a, a_log) =
            crate::test_log::logged_async(new.notice(&new_client, &settings, a_notice)).await;
        let (b, b_log) =
            crate::test_log::logged_async(old.notice(&old_client, &settings, b_notice)).await;
        due += usize::from(a.is_some());
        quiet += usize::from(a.is_none());
        assert_eq!(format!("{a:?}"), format!("{b:?}"), "request at step {step}");
        assert_eq!(a_log, b_log, "logs at step {step}");
        assert_eq!(
            new.floor_pending_for, old.floor_pending_for,
            "floor mark at step {step}"
        );
        assert_eq!(
            new.floor_lifted_for, old.floor_lifted_for,
            "spent floor at step {step}"
        );
        assert_eq!(new.summarizing, old.summarizing);
        if choice != 11 {
            // Complete/cancel synthetic jobs together; no model runs in this
            // state-machine test. Some steps deliberately retain an outstanding job.
            new.summarizing = false;
            old.summarizing = false;
        }
    }
    assert!(
        due > 0 && quiet > 0,
        "exercise both summary decisions: {due}/{quiet}"
    );
}

#[tokio::test]
async fn notices_cuts_undos_settings_and_restart_match_the_original_due_check() {
    sequence(false).await;
}

#[tokio::test]
async fn seeded_notice_sequences_match_the_original_due_check() {
    sequence(true).await;
}
