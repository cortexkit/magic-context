//! Review witnesses for the cached summary due-check at the session level.
//! Two sessions take the same notices; one evaluates with the cached window,
//! the other with the unindexed evaluator. Beyond the original differential
//! sequence, these notices carry runner counts under a token family that
//! switches, tool results that reach older messages, attribution backfilled
//! on older messages, summaries that move the start of unsummarized history
//! forward and back, and runs that stay outstanding over several notices.

use super::*;
use cortexkit_role_compaction::part::{ToolPart, ToolStatus};
use cortexkit_role_compaction::tokens::PartTokens;

struct Rng(u64);

impl Rng {
    fn below(&mut self, n: u64) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        if n == 0 {
            0
        } else {
            self.0 % n
        }
    }
}

fn tool(call: &str, status: ToolStatus, output: Option<u64>) -> Part {
    let mut tool = ToolPart::new(
        call,
        "bash",
        serde_json::json!({"command": format!("git commit -m {call}")}),
        status,
    );
    tool.output_bytes = output;
    Part::new("t", PartBody::Tool(tool))
}

fn summary(sequence: i64, start: u64, end: u64, transcript: &[Entry]) -> StoredCompartment {
    let mid = |ordinal: u64| {
        transcript
            .iter()
            .find(|entry| entry.ordinal == ordinal)
            .map_or_else(|| format!("m{ordinal}"), |entry| entry.mid.clone())
    };
    StoredCompartment {
        sequence,
        start_message: start as i64,
        end_message: end as i64,
        start_message_id: mid(start),
        end_message_id: mid(end),
        title: format!("Summary {sequence}"),
        content: "summary of earlier work".into(),
        importance: 50,
        created_at: sequence,
        ..Default::default()
    }
}

async fn sequence(seed: u64) {
    let (_, new_client, route, mut setup, mut settings) = fixture();
    let (_, old_client, _, _, _) = fixture();
    let features = crate::preset::features("head").unwrap();
    setup.preset = "head".into();
    setup.model = ModelRef::new("anthropic", "claude-opus-5-5");
    let mut new = Session::new(&route, &setup, features, None);
    let mut old = new.clone();
    old.use_legacy_summary_scan(true);
    let mut rng = Rng(seed);
    let mut transcript: Vec<Entry> = Vec::new();
    let mut family = "fam-a";
    let mut hold = 0;
    let (mut due, mut quiet) = (0, 0);
    for step in 1..=160u64 {
        let choice = rng.below(16);
        // Changes to messages the sessions already hold ride on the notice
        // before the new message, as a runner reports them.
        let mut changed: Vec<Entry> = Vec::new();
        match choice {
            0 if transcript.len() > 3 => {
                // A tool call in an older message gets its result.
                if let Some(at) = transcript.iter().position(|entry| {
                    entry.parts.iter().any(|part| {
                        matches!(&part.body, PartBody::Tool(t) if t.status == ToolStatus::Running)
                    })
                }) {
                    let held = &transcript[at];
                    let PartBody::Tool(running) = &held.parts[0].body else {
                        unreachable!()
                    };
                    let mut done = tool(
                        &running.call_id,
                        ToolStatus::Completed,
                        Some(rng.below(200_000)),
                    );
                    done.tokens = Some(PartTokens::tool(rng.below(400), rng.below(60_000)));
                    let entry = Entry::new(
                        held.ordinal,
                        held.mid.clone(),
                        held.role.clone(),
                        held.written_at,
                        vec![done],
                    );
                    transcript[at] = entry.clone();
                    changed.push(entry);
                }
            }
            1 if transcript.len() > 3 => {
                // Attribution backfilled on an older user message.
                if let Some(at) = transcript
                    .iter()
                    .position(|entry| entry.role == Role::User && entry.speaks_for.is_none())
                {
                    transcript[at].speaks_for = Some(
                        serde_json::from_value(
                            serde_json::json!({"agent_id":"agent-a","name":"Helper"}),
                        )
                        .unwrap(),
                    );
                    changed.push(transcript[at].clone());
                }
            }
            2 if !transcript.is_empty() => {
                // Runner counts arrive late for an older message.
                let at = rng.below(transcript.len() as u64) as usize;
                for part in &mut transcript[at].parts {
                    part.tokens = Some(match part.body {
                        PartBody::Tool(_) => PartTokens::tool(rng.below(400), rng.below(60_000)),
                        _ => PartTokens::count(rng.below(40_000)),
                    });
                }
                changed.push(transcript[at].clone());
            }
            3 => {
                family = if family == "fam-a" { "fam-b" } else { "fam-a" };
            }
            4 if transcript.len() > 4 => {
                // A summary run finished: unsummarized history starts later.
                let through = new.summarized_through().unwrap_or(0);
                let newest = transcript.last().unwrap().ordinal;
                if through + 1 < newest {
                    let end = through + 1 + rng.below(newest - through - 1);
                    let sequence = new.summaries.len() as i64 + 1;
                    for session in [&mut new, &mut old] {
                        session
                            .summaries
                            .push(summary(sequence, through + 1, end, &transcript));
                    }
                }
            }
            5 if !new.summaries.is_empty() => {
                // The newest summary is undone: history starts earlier again.
                let len = new.summaries.len() - 1;
                new.summaries.truncate(len);
                old.summaries.truncate(len);
            }
            6 => {
                // A run stays outstanding over the next few notices.
                hold = 1 + rng.below(4);
            }
            7 => {
                settings.execute_threshold_percentage = [45.0, 65.0, 90.0][rng.below(3) as usize];
                settings.commit_clusters = Some(rng.below(3) + 1);
            }
            8 => {
                setup.model = if rng.below(2) == 0 {
                    ModelRef::new("test", "unknown")
                } else {
                    ModelRef::new("anthropic", "claude-opus-5-5")
                };
                let newest = transcript.last().map(cursor);
                setup.newest = newest;
                *new_client.entries.lock().unwrap() = transcript.clone();
                *old_client.entries.lock().unwrap() = transcript.clone();
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
            _ => {}
        }
        let ordinal = transcript.len() as u64 + 1;
        let kind = rng.below(8);
        let parts = match kind {
            0 => vec![tool(&format!("c{ordinal}"), ToolStatus::Running, None)],
            1 => vec![tool(
                &format!("c{ordinal}"),
                ToolStatus::Completed,
                Some(rng.below(100_000)),
            )],
            _ => vec![Part::new(
                "p",
                PartBody::Text {
                    text: "Preserve the prefix. Committed abc1234; run the focused tests. "
                        .repeat(if kind == 2 { 300 } else { 25 })
                        .into(),
                },
            )],
        };
        let role = if kind >= 5 {
            Role::User
        } else {
            Role::Assistant
        };
        let mut entry = Entry::new(ordinal, format!("m{step}-{ordinal}"), role, step, parts);
        if rng.below(3) == 0 {
            for part in &mut entry.parts {
                part.tokens = Some(match part.body {
                    PartBody::Tool(_) => PartTokens::tool(rng.below(400), rng.below(60_000)),
                    _ => PartTokens::count(rng.below(30_000)),
                });
            }
        }
        transcript.push(entry.clone());
        *new_client.entries.lock().unwrap() = transcript.clone();
        *old_client.entries.lock().unwrap() = transcript.clone();
        let newest = Some(cursor(&entry));
        setup.newest = newest.clone();
        let usage = [10_000, 65_000, 86_000, 96_000][rng.below(4) as usize];
        for session in [&mut new, &mut old] {
            session.conditions.last_prompt_tokens = Some(usage);
            if hold > 0 {
                session.summarizing = true;
            }
        }
        hold = hold.saturating_sub(1);
        let mut entries = changed;
        entries.push(entry);
        let mut a_notice = notice(&new, step, newest.clone());
        a_notice.entries = entries.clone();
        a_notice.token_family = Some(family.into());
        let mut b_notice = notice(&old, step, newest);
        b_notice.entries = entries;
        b_notice.token_family = Some(family.into());

        let (a, a_log) =
            crate::test_log::logged_async(new.notice(&new_client, &settings, a_notice)).await;
        let (b, b_log) =
            crate::test_log::logged_async(old.notice(&old_client, &settings, b_notice)).await;
        due += usize::from(a.is_some());
        quiet += usize::from(a.is_none());
        assert_eq!(
            format!("{a:?}"),
            format!("{b:?}"),
            "request at step {step} (seed {seed:#x})"
        );
        assert_eq!(a_log, b_log, "logs at step {step} (seed {seed:#x})");
        assert_eq!(new.floor_pending_for, old.floor_pending_for);
        assert_eq!(new.floor_lifted_for, old.floor_lifted_for);
        assert_eq!(new.summarizing, old.summarizing);
        if hold == 0 {
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
async fn review_counts_tool_results_backfill_and_summaries_match_the_original_due_check() {
    for seed in [0x51de_cafe_0001u64, 0x0ddb_0a11_0002, 0x7e57_5eed_0003] {
        sequence(seed).await;
    }
}
