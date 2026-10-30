use super::*;
use crate::providers::async_provider::offline_first_pass as offline;
use crate::session_resolver::ProviderRunner as _;
use cortexkit_role_llm_runner::read::ReadPage;

mod open_tool_wait;

#[test]
fn broca_media_descriptors_preserve_digest_and_unnumbered_part_rows() {
    for (descriptor, inline) in [
        (
            include_str!("../../../../testdata/broca-media-set2/on-session-read-descriptors.jsonl"),
            include_str!("../../../../testdata/broca-media-set2/on-session-read.jsonl"),
        ),
        (
            include_str!(
                "../../../../testdata/broca-media-set2/off-session-read-descriptors.jsonl"
            ),
            include_str!("../../../../testdata/broca-media-set2/off-session-read.jsonl"),
        ),
    ] {
        let descriptor: Value = serde_json::from_str(descriptor).unwrap();
        let inline: Value = serde_json::from_str(inline).unwrap();
        let entries: Vec<ReadMessage> = decode(&descriptor["result"]["messages"]).unwrap();
        let inline: Vec<ReadMessage> = decode(&inline["result"]["messages"]).unwrap();
        assert_eq!(entries.len(), inline.len());
        for (entry, original) in entries.iter().zip(&inline) {
            check_served_identity(entry, codec::Codec::OwnedBroca).unwrap();
            assert_eq!(
                served_digest(entry).unwrap(),
                inline_digest(original, &original.message).unwrap()
            );
            let kept = tool_arcs::KeptMessage::new(codec::Codec::OwnedBroca, entry).unwrap();
            assert_eq!(
                kept.parts,
                entry
                    .tags
                    .iter()
                    .map(|tag| tag.part.clone())
                    .collect::<Vec<_>>()
            );
            for (index, tag) in entry.tags.iter().enumerate() {
                assert_eq!(
                    served_part_digest(entry, &tag.part).unwrap(),
                    inline_digest(original, &original.message["content"][index]).unwrap()
                );
                if let Some(block) = entry.message["content"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|block| block["part"] == tag.part)
                {
                    assert_eq!(block["type"], "media_ref");
                    assert!(tag.tag.is_none());
                    assert_eq!(tag.part, "m2#1");
                }
            }
            let decoded = decoded_entry(
                codec::Codec::OwnedBroca,
                &InboundMessage {
                    ordinal: entry.ordinal,
                    mid: entry.mid.clone(),
                    message: entry.message.clone(),
                },
            )
            .unwrap();
            assert_eq!(codec::encode_message(&decoded.ck).unwrap(), entry.message);
            if entry.mid == "m4" {
                let rendered = render_part(&entry.message["content"][0], Some("§4§"), true);
                let mut tagged = decoded.ck.clone();
                assert!(crate::transform::apply_tag_prefix_to_block(
                    "tool",
                    &mut tagged.content[0],
                    crate::transform::TaggableKind::ToolResult,
                    4
                ));
                assert_eq!(
                    codec::encode_message(&tagged).unwrap()["content"][0],
                    rendered
                );
                assert!(!crate::descriptors::holds_stand_in(&rendered));
            }
            let mut corrupt = entry.clone();
            corrupt.part_digests.as_mut().unwrap().pop();
            assert!(check_served_identity(&corrupt, codec::Codec::OwnedBroca).is_err());
        }
        assert!(
            tag_rows_for(held(&entries).values(), codec::Codec::OwnedBroca)
                .unwrap()
                .is_empty()
        );
    }
}

#[tokio::test]
async fn broca_media_tag_rows_keep_outer_part_identity_and_reduce_target() {
    let capture: Value = serde_json::from_str(include_str!(
        "../../../../testdata/broca-media/on-session-read.jsonl"
    ))
    .unwrap();
    let mut entries: Vec<ReadMessage> = decode(&capture["result"]["messages"]).unwrap();
    let native_counts: Vec<_> = entries
        .iter()
        .map(|entry| parts(&entry.message).unwrap().len())
        .collect();
    assert_eq!(native_counts, vec![1, 1, 2, 1, 1, 1]);
    for entry in &entries {
        assert_eq!(entry.tags.len(), parts(&entry.message).unwrap().len());
        for (index, row) in entry.tags.iter().enumerate() {
            assert_eq!(row.part, format!("{}#{index}", entry.mid));
            assert!(
                row.tag.is_none(),
                "the real capture was made with numbering off"
            );
        }
    }
    assert!(
        tag_rows_for(held(&entries).values(), codec::Codec::OwnedBroca)
            .unwrap()
            .is_empty()
    );
    // Number user/assistant text and the outer tool result, as Broca does.
    // Standalone media and tool calls retain their unnumbered rows.
    for (ordinal, number) in [(0, 1), (1, 2), (2, 3), (4, 4), (5, 5)] {
        entries[ordinal].tags[0].tag = Some(format!("§{number}§"));
    }
    let rows = tag_rows_for(held(&entries).values(), codec::Codec::OwnedBroca).unwrap();
    assert_eq!(
        rows.iter()
            .map(|row| (row.tag_number, row.block_id.as_str()))
            .collect::<Vec<_>>(),
        vec![
            (1, "m0#0"),
            (2, "m1#0"),
            (3, "m2#0"),
            (4, "m4#0"),
            (5, "m5#0")
        ]
    );
    assert_eq!(String::from_utf8(rows[3].source_bytes.to_vec()).unwrap(), "before-media\n[media not shown: kind=image mime=image/png bytes=4749 sha256=2bb3f6f7eb60 reason=carrier]\n[media not shown: kind=document mime=application/pdf bytes=584 sha256=b7442ba422ac reason=carrier]\nafter-media");
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::open(
        dir.path(),
        "broca",
        "broca",
        json!({"serializer_profile":"owned-broca"}),
    )
    .await;
    *rig.runner.entries.lock().unwrap() = entries;
    let answer = rig.tool(7, "ctx_reduce", json!({"drop":"4"})).await;
    assert_ne!(answer["isError"], true, "{answer}");
    assert_eq!(rig.pending_targets(), vec!["m4#0"]);
    assert_eq!(rig.state().tag_index["§4§"].part, "m4#0");
}

struct Golden {
    name: &'static str,
    bytes: &'static str,
    sha256: &'static str,
    wrapped: bool,
    numbers: &'static [i64],
}

const GOLDENS: &[Golden] = &[
    Golden {
        name: "two_episode",
        bytes: include_str!(
            "../../../../tests/fixtures/broca-tag-rows/session_read.two_episode.json"
        ),
        sha256: "19be9242730f47faf675b8dfd02629bfabd46febf10f9057df05b2218721050b",
        wrapped: false,
        numbers: &[],
    },
    Golden {
        name: "descriptors",
        bytes: include_str!(
            "../../../../tests/fixtures/broca-tag-rows/session_read.two_episode.descriptors.json"
        ),
        sha256: "e467e932a1a7ce1f1cf0528fd3ef9bb90a577df8243b97b760a75af7dc36d8f6",
        wrapped: false,
        numbers: &[],
    },
    Golden {
        name: "counted",
        bytes: include_str!("../../../../tests/fixtures/broca-tag-rows/session_read.counted.json"),
        sha256: "68eaa904a0c6f5b86e539c16aa9cb6f20614a454e61e777c98be82260c1c54b0",
        wrapped: false,
        numbers: &[1, 2, 3, 4],
    },
    Golden {
        name: "tool_turn",
        bytes: include_str!(
            "../../../../tests/fixtures/broca-tag-rows/session_read.tool_turn.json"
        ),
        sha256: "efd8c09435361fe5daedb082134d8bd3311765b607870d48f51bb3e61cb58bff",
        wrapped: true,
        numbers: &[],
    },
];

fn wire_page(golden: &Golden) -> Value {
    let wire = serde_json::from_str(golden.bytes).unwrap();
    if golden.wrapped {
        session_resolver::read_runner_reply(wire).expect("real strict runner reply decoder")
    } else {
        wire
    }
}

fn entries(golden: &Golden) -> Vec<ReadMessage> {
    decode(&wire_page(golden)["messages"]).unwrap()
}

fn descriptors(entries: &[ReadMessage]) -> Vec<ReadMessage> {
    entries
        .iter()
        .map(|entry| {
            if entry.digest.is_some() {
                entry.clone()
            } else {
                // Inline goldens need the normal test runner's descriptors projection
                // because the async and offline readers request that media mode.
                serve_descriptors(entry)
            }
        })
        .collect()
}

fn served_page(golden: &Golden, from: u64) -> Value {
    let mut page = wire_page(golden);
    // The first three goldens came from a rig without lineage headers. Real
    // written-session reads carry lineage; supply it in the test, and replace
    // the real-serve sample's placeholder with the same fixed test lineage.
    page["lineage_id"] = json!("L");
    page["messages"] = json!(descriptors(&entries(golden))
        .into_iter()
        .filter(|entry| entry.ordinal >= from)
        .collect::<Vec<_>>());
    page
}

fn held(entries: &[ReadMessage]) -> held_entries::HeldEntries {
    let mut held = held_entries::HeldEntries::default();
    for entry in entries {
        held.insert(
            entry.ordinal,
            Arc::new(HeldEntry::from_read(entry).unwrap()),
        );
    }
    held
}

fn numbers(state: &State) -> Vec<i64> {
    tag_rows(state, codec::Codec::OwnedBroca)
        .unwrap()
        .into_iter()
        .map(|row| row.tag_number)
        .collect()
}

#[test]
fn broca_tag_rows_goldens_decode_every_row_and_preserve_absent_tags() {
    for golden in GOLDENS {
        assert_eq!(crate::sha256_hex(golden.bytes.as_bytes()), golden.sha256);
        let wire = wire_page(golden);
        let page: ReadPage = serde_json::from_value(wire.clone()).unwrap();
        let decoded = entries(golden);
        assert_eq!(page.messages.len(), 4, "{}", golden.name);
        let mut actual = Vec::new();
        for (index, entry) in decoded.iter().enumerate() {
            assert_eq!(entry.ordinal, index as u64);
            assert_eq!(entry.mid, format!("m{index}"));
            let rows = wire["messages"][index]["tags"].as_array().unwrap();
            assert_eq!(rows.len(), 1);
            assert_eq!(entry.tags.len(), parts(&entry.message).unwrap().len());
            assert_eq!(entry.tags[0].part, format!("m{index}#0"));
            if golden.numbers.is_empty() {
                assert!(!rows[0].as_object().unwrap().contains_key("tag"));
                assert_eq!(entry.tags[0].tag, None);
                let encoded = serde_json::to_value(entry).unwrap();
                assert!(encoded["tags"][0].get("tag").is_none());
            } else {
                actual.push(tags::parse_tag(entry.tags[0].tag.as_deref().unwrap()).unwrap() as i64);
            }
            let restored =
                HeldEntry::from_stored(HeldEntry::from_read(entry).unwrap().raw().to_owned())
                    .unwrap();
            assert_eq!(restored.read().unwrap().tags, entry.tags);
            assert_eq!(restored.inbound().unwrap().message, entry.message);
            let kept = tool_arcs::KeptMessage::new(codec::Codec::OwnedBroca, entry).unwrap();
            assert_eq!(kept.parts, vec![format!("m{index}#0")]);
        }
        assert_eq!(actual, golden.numbers);
    }
}

#[test]
fn broca_tag_rows_descriptor_identity_uses_unnumbered_row_keys() {
    let golden = &GOLDENS[1];
    for entry in entries(golden) {
        assert_eq!(entry.tags[0].tag, None);
        check_served_identity(&entry, codec::Codec::OwnedBroca).unwrap();
        let digests = entry.part_digests.as_ref().unwrap();
        assert_eq!(digests.len(), entry.tags.len());
        assert_eq!(digests[0].part, entry.tags[0].part);
        assert_eq!(
            served_part_digest(&entry, &entry.tags[0].part).unwrap(),
            digests[0].digest
        );
    }
}

#[tokio::test]
async fn broca_tag_rows_live_ingest_summarizer_input_and_restore() {
    for golden in GOLDENS {
        let dir = tempfile::tempdir().unwrap();
        let rig = Rig::open(
            dir.path(),
            "broca",
            "broca",
            json!({"serializer_profile":"owned-broca"}),
        )
        .await;
        *rig.runner.entries.lock().unwrap() = entries(golden);
        *rig.runner.page_override.lock().unwrap() = Some(served_page(golden, 0));
        rig.notice(1, 1_000, None).await;
        let state = rig.state();
        assert_eq!(state.entries.len(), 4, "{}", golden.name);
        assert!(
            !state.resync && !state.engine_failed && state.failure.is_none(),
            "{}",
            golden.name
        );
        assert_eq!(state.completed_seq, 1);
        assert_eq!(numbers(&state), golden.numbers);
        assert_eq!(state.tag_index.len(), golden.numbers.len());
        let store = rig.h.store.get().unwrap();
        let saved = store.load_tags_for_session(&state.namespace()).unwrap();
        assert_eq!(
            saved.iter().map(|row| row.tag_number).collect::<Vec<_>>(),
            golden.numbers
        );

        let mut request = rig.h.async_historian_request(&state).unwrap();
        let mut index = historian_tail::InputIndex::default();
        for entry in state.entries.values() {
            index.add(&decoded_entry(codec::Codec::OwnedBroca, &entry.inbound().unwrap()).unwrap());
        }
        historian_tail::prepare_input(
            store,
            &state.reference(),
            index.window(None).through(Some(3)),
            codec::Codec::OwnedBroca,
            &mut request,
            &state.reminder_echoes,
        )
        .unwrap();
        assert_eq!(
            request
                .messages
                .iter()
                .map(|m| (m.ordinal, m.mid.as_str()))
                .collect::<Vec<_>>(),
            vec![(0, "m0"), (1, "m1"), (2, "m2"), (3, "m3")]
        );
        assert_eq!(
            request
                .messages
                .iter()
                .map(|m| m.ck.content.len())
                .sum::<usize>(),
            4
        );
        assert_eq!(request.serializer_profile, "owned-broca");

        // An inclusive tail re-read must finish once, not retry because a row
        // without a number was mistaken for a missing tag or changed entry.
        *rig.runner.page_override.lock().unwrap() = Some(served_page(golden, 3));
        rig.notice(2, 1_000, None).await;
        let restored = rig.state();
        assert_eq!(restored.completed_seq, 2);
        assert!(!restored.resync && restored.failure.is_none());
        assert_eq!(numbers(&restored), golden.numbers);
        let reads = rig.runner.reads.lock().unwrap();
        assert_eq!(reads.len(), 2, "{}: no read retry loop", golden.name);
        assert_eq!(reads[0]["from_ordinal"], 0);
        assert_eq!(reads[1]["from_ordinal"], 3);
        assert!(reads.iter().all(|read| read["media"] == "descriptors"));
    }
}

#[tokio::test]
async fn broca_tag_rows_ctx_reduce_catches_up_without_inventing_numbers() {
    for golden in GOLDENS {
        let dir = tempfile::tempdir().unwrap();
        let rig = Rig::open(
            dir.path(),
            "broca",
            "broca",
            json!({"serializer_profile":"owned-broca"}),
        )
        .await;
        *rig.runner.page_override.lock().unwrap() = Some(served_page(golden, 0));
        assert!(rig.state().entries.is_empty());
        let answer = rig.tool(7, "ctx_reduce", json!({"drop":"4"})).await;
        let state = rig.state();
        assert_eq!(state.entries.len(), 4, "{}", golden.name);
        assert_eq!(numbers(&state), golden.numbers);
        assert!(state.failure.is_none() && !state.resync);
        if golden.numbers.is_empty() {
            assert_eq!(answer["isError"], true);
            assert_eq!(
                answer["content"][0]["text"],
                "Refused: no valid tags to queue. tags 4 not found"
            );
            assert!(rig.pending_targets().is_empty());
        } else {
            assert_ne!(answer["isError"], true, "{answer}");
            assert_eq!(rig.pending_targets(), vec!["m3#0"]);
            assert_eq!(state.tag_index["§4§"].part, "m3#0");
        }
        assert_eq!(rig.runner.reads.lock().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn broca_tag_rows_ceiling_ride_reads_every_entry() {
    for golden in GOLDENS {
        let dir = tempfile::tempdir().unwrap();
        let rig = Rig::open(
            dir.path(),
            "broca",
            "broca",
            json!({"serializer_profile":"owned-broca"}),
        )
        .await;
        *rig.runner.entries.lock().unwrap() = entries(golden);
        *rig.runner.page_override.lock().unwrap() = Some(served_page(golden, 0));
        rig.notice(1, 1_000, None).await;
        *rig.runner.page_override.lock().unwrap() = Some(served_page(golden, 3));
        let answer = rig
            .op(
                "compaction.ride",
                json!({
                    "session_ref":rig.reference,"cause":"ceiling","deadline_ms":10_000
                }),
            )
            .await;
        assert!(
            answer["answer"] == "view" || answer["answer"] == "nothing",
            "{answer}"
        );
        let state = rig.state();
        assert_eq!(state.entries.len(), 4, "{}", golden.name);
        assert_eq!(numbers(&state), golden.numbers);
        assert!(!state.resync && !state.engine_failed && state.failure.is_none());
        let reads = rig.runner.reads.lock().unwrap();
        assert_eq!(reads.len(), 2);
        assert_eq!(reads[1]["from_ordinal"], 3);
    }
}

#[test]
fn broca_tag_rows_frozen_edits_reanchor_by_key_even_without_numbers() {
    for golden in GOLDENS {
        let entries = held(&descriptors(&entries(golden)));
        let kept = entries
            .iter()
            .map(|(ordinal, entry)| {
                (
                    *ordinal,
                    tool_arcs::KeptMessage::new(codec::Codec::OwnedBroca, &entry.read().unwrap())
                        .unwrap(),
                )
            })
            .collect();
        let mid_index = entries
            .iter()
            .map(|(ordinal, entry)| (entry.mid.clone(), *ordinal))
            .collect();
        let bytes = r#"{"type":"text","text":"edited user text"}"#;
        let mut frozen = frozen_edits::FrozenEdits::default();
        frozen
            .capture_edits(&[view::PartEdit::replace(0, "m0", "m0#0", bytes)], &entries)
            .unwrap();
        assert!(frozen.served("m0", "m0#0", bytes));
        let mut ranges = vec![view::ViewRange::keep_with_edits(0, 4, vec![])];
        frozen
            .apply(&mid_index, &entries, &kept, &mut ranges)
            .unwrap();
        let view::ViewRange::Keep { edits, .. } = &ranges[0] else {
            panic!("expected a keep range");
        };
        assert_eq!(edits.len(), 1);
        assert_eq!(edits[0].part, "m0#0");
        assert_eq!(edits[0].bytes.as_deref(), Some(bytes));
    }
}

#[tokio::test]
async fn broca_tag_rows_untagged_tool_call_does_not_count_or_shift_numbers() {
    // BROCA's real-serve tool sample has no numbered rows. This numbered
    // derivative is test-made: only user text, tool result and final answer
    // get numbers, while the original tool-call row remains untagged.
    let mut mixed = entries(&GOLDENS[3]);
    for (ordinal, number) in [(0, 1), (2, 2), (3, 3)] {
        mixed[ordinal].tags[0].tag = Some(format!("§{number}§"));
    }
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::open(
        dir.path(),
        "broca",
        "broca",
        json!({"serializer_profile":"owned-broca"}),
    )
    .await;
    let served = descriptors(&mixed);
    let mut open = rig.state();
    open.entries = held(&served[..2]);
    open.reindex().unwrap();
    assert_eq!(numbers(&open), vec![1]);
    assert_eq!(open.tag_index.len(), 1);
    let call_rows = open.entries[&1].read().unwrap().tags;
    assert_eq!(call_rows, vec![tags::PartTag::untagged("m1#0")]);
    for entry in &served[2..] {
        open.entries.insert(
            entry.ordinal,
            Arc::new(HeldEntry::from_read(entry).unwrap()),
        );
    }
    open.reindex().unwrap();
    assert_eq!(open.entries[&1].read().unwrap().tags, call_rows);
    assert_eq!(numbers(&open), vec![1, 2, 3]);
    assert_eq!(open.tag_index.len(), 3);
    assert_eq!(open.tag_index["§2§"].part, "m2#0");
    assert_eq!(open.tag_index["§3§"].part, "m3#0");
    assert!(tag_rows_for(
        open.entries.range(1..2).map(|(_, e)| e),
        codec::Codec::OwnedBroca
    )
    .unwrap()
    .is_empty());

    *rig.runner.entries.lock().unwrap() = mixed;
    let answer = rig.tool(7, "ctx_reduce", json!({"drop":"2"})).await;
    assert_ne!(answer["isError"], true, "{answer}");
    assert_eq!(rig.pending_targets(), vec!["m2#0"]);
    assert_eq!(numbers(&rig.state()), vec![1, 2, 3]);
    assert_eq!(rig.runner.reads.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn broca_tag_rows_offline_first_pass_accepts_all_goldens() {
    for golden in GOLDENS {
        let dir = tempfile::tempdir().unwrap();
        let page = served_page(golden, 0).to_string();
        let pages = crate::offline_first_pass::parse_pages(
            std::io::Cursor::new(page),
            crate::providers::codec::Codec::OwnedBroca,
        )
        .unwrap();
        assert_eq!(pages.entries, 4);
        assert_eq!(pages.lineage, "L");
        assert_eq!(pages.lowest_tag, golden.numbers.first().map(|n| *n as u64));
        let describe = Runner::default()
            .call(
                dir.path(),
                "s",
                "role.describe",
                json!({}),
                Duration::from_secs(1),
            )
            .await
            .unwrap();
        let setup = offline::OfflineSetup {
            project_root: dir.path().into(),
            runner_module: "broca".into(),
            runner_describe: describe.clone(),
            request: decode(
                &json!({"session":"s","harness":"broca","request_id":"setup",
                "model":"fixture","context_window":100_000,"composition":{"render_tags":!golden.numbers.is_empty()},
                "params":{"serializer_profile":"owned-broca"},"lineage_id":"L","now":1}),
            )
            .unwrap(),
        };
        let descriptor = StorageDescriptor {
            module_id: DEFAULT_MODULE_ID.into(),
            storage_namespace: "mc_cache".into(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: dir.path().join("store.db").to_string_lossy().into(),
            },
        };
        let store = Arc::new(McStore::open_for_test(&descriptor).unwrap());
        let mut h = McHandler::new();
        h.producer_factory =
            crate::providers::session_runner_fake::FakeSessionRunner::for_project(dir.path())
                .factory();
        h.fixed_config = Some(McModuleConfig {
            inject_docs: false,
            protected_tokens_user: Some(0),
            protected_tools: BTreeMap::new(),
            ..Default::default()
        });
        h.store.set(store.clone()).ok().unwrap();
        h.provider_runner = Arc::new(offline::PagesRunner::new(pages.served, describe));
        let outcome = h.offline_first_pass(&setup).await.unwrap();
        let offline::OfflineOutcome::Prepared(report) = outcome else {
            panic!("{}: expected a first pass, got {outcome:?}", golden.name);
        };
        assert_eq!(report.proof.count, 4);
        assert_eq!(report.proof.lineage, "L");
        let state = load(&store, &report.reference).unwrap().unwrap();
        assert_eq!(state.entries.len(), 4);
        assert_eq!(numbers(&state), golden.numbers);
        assert_eq!(state.tag_index.len(), golden.numbers.len());
        assert!(!state.engine_failed && state.failure.is_none() && !state.resync);
        assert!(matches!(
            h.offline_first_pass(&setup).await.unwrap(),
            offline::OfflineOutcome::Unchanged(_)
        ));
    }
}
