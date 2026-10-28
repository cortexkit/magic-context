use super::*;
use crate::tests::broca_rich_ui_stamp::answer;

const READS: [&str; 2] = ["session.read.default.json", "session.read.opt-in.json"];

// The captures are inline-mode replies. Live compaction asks for descriptors;
// add only the runner's digests, retaining all captured metadata, including rich_ui.
fn described_page(name: &str) -> Value {
    let mut page = answer(name);
    for row in page["messages"].as_array_mut().unwrap() {
        let entry: ReadMessage = decode(row).unwrap();
        let served = serde_json::to_value(serve_descriptors(&entry)).unwrap();
        for key in ["digest", "part_digests"] {
            row[key] = served[key].clone();
        }
    }
    page
}

async fn rig(dir: &Path) -> Rig {
    Rig::open(
        dir,
        "thalamus-harness",
        "opencode",
        json!({"serializer_profile":"owned-broca"}),
    )
    .await
}

#[test]
fn rich_ui_stamp_descriptor_rows() {
    for name in READS {
        let inline: Vec<ReadMessage> = decode(&answer(name)["messages"]).unwrap();
        for entry in inline {
            let error = entry
                .check_descriptor_rows(codec::Codec::OwnedBroca.wire_id())
                .unwrap_err();
            eprintln!(
                "{name}, ordinal {}: inline descriptor check: {error}",
                entry.ordinal
            );
        }
        let described: Vec<ReadMessage> = decode(&described_page(name)["messages"]).unwrap();
        for entry in described {
            entry
                .check_descriptor_rows(codec::Codec::OwnedBroca.wire_id())
                .unwrap();
            check_served_identity(&entry, codec::Codec::OwnedBroca).unwrap();
        }
    }
}

#[tokio::test]
async fn rich_ui_stamp_resumable_reads_and_notice_ingest() {
    for name in READS {
        let dir = tempfile::tempdir().unwrap();
        let rig = rig(dir.path()).await;
        let page = described_page(name);
        *rig.runner.page_override.lock().unwrap() = Some(page.clone());
        let mut state = rig.state();
        state.lineage = Some(page["lineage_id"].as_str().unwrap().into());
        let read = rig
            .h
            .read_async_resumable(&mut state, 0, Duration::from_secs(5))
            .await;
        if let Err(error) = &read {
            panic!("{name}: {error:?}");
        }
        assert!(matches!(read, Ok(ReadProgress::Complete)), "{name}");
        assert_eq!(state.entries.len(), 2);
        let other = described_page(if name == READS[0] { READS[1] } else { READS[0] });
        let fresh: Vec<ReadMessage> = decode(&other["messages"]).unwrap();
        for entry in fresh {
            assert!(stable_entry(
                &state.entries[&entry.ordinal].read().unwrap(),
                &entry
            ));
        }
        state
            .ingest_read(rig.h.store.get().unwrap(), codec::Codec::OwnedBroca)
            .unwrap_or_else(|error| panic!("{name}: {error:?}"));
        assert_eq!(rig.state().entries.len(), 2);
        rig.h
            .read_async(&mut state, 0, Duration::from_secs(5))
            .await
            .unwrap_or_else(|error| panic!("{name}: {error:?}"));
    }
}

#[tokio::test]
async fn rich_ui_stamp_cut_runtime_head() {
    let dir = tempfile::tempdir().unwrap();
    let rig = rig(dir.path()).await;
    let head = answer("session.head.json");
    *rig.runner.head_override.lock().unwrap() = Some(head.clone());
    let mut state = rig.state();
    state.entries = Default::default();
    state.cut_seed = None;
    state.conditions = None;
    let lineage = state.lineage.clone();
    rig.h
        .ensure_lineage_window(&mut state, Duration::from_secs(5))
        .await
        .unwrap_or_else(|error| panic!("{error:?}"));
    // An uncut head leaves the existing window unchanged.
    assert_eq!(state.lineage, lineage);
    assert!(state.cut_seed.is_none());
    assert!(rig
        .h
        .runner_prune_state(&state, Duration::from_secs(5))
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn rich_ui_stamp_offline_pages_runner() {
    use crate::providers::offline_first_pass_engine::{PagesRunner, ServedPage};
    use crate::session_resolver::{ProviderRunner, RunnerBindIdentity};
    let route = crate::route_targets::SessionRunnerRoute::for_principal(
        Some(&subc_protocol::Principal::Reserved {
            module_id: "broca".into(),
        }),
        "s",
    )
    .unwrap();
    let identity = RunnerBindIdentity {
        project_root: "/project".into(),
        harness: "broca".into(),
        session: "s".into(),
    };
    for name in READS {
        // Offline exports contain bare pages rather than unary reply envelopes.
        let page = answer(name);
        let runner = PagesRunner::new(
            vec![ServedPage {
                first: 0,
                last: 1,
                line: page.to_string(),
            }],
            answer("role.describe.json"),
        );
        let served = runner
            .call_for_identity(
                &route,
                &identity,
                "session.read",
                json!({"from_ordinal":0,"media":"descriptors","lineage_id":page["lineage_id"]}),
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        let parsed: cortexkit_role_llm_runner::read::ReadPage = decode(&served).unwrap();
        assert_eq!(parsed.messages.len(), 2, "{name}");
    }
}

#[test]
fn rich_ui_stamp_raw_history_equivalent() {
    let mut history = answer("session.history.json");
    let read = answer("session.read.default.json");
    for (row, entry) in history["messages"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .zip(read["messages"].as_array().unwrap())
    {
        // Broca's supplied history capture is display-only. ctx_expand requests
        // raw form, whose native bodies are available in the paired read capture.
        row["message"] = entry["message"].clone();
        row.as_object_mut().unwrap().remove("row");
    }
    let page: cortexkit_role_llm_runner::history::HistoryPage = decode(&history).unwrap();
    assert_eq!(page.messages.len(), 2);
    for entry in page.messages {
        decoded_entry(
            codec::Codec::OwnedBroca,
            &InboundMessage {
                ordinal: entry.ordinal.unwrap(),
                mid: entry.mid,
                message: entry.message,
            },
        )
        .unwrap();
    }
}
