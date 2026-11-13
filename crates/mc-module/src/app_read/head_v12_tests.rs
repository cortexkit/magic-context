use super::tests::{item_text, large_head, reconstruct, rendered, section_text, snapshot};
use super::*;
use crate::summary::head::head_ops;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use cortexkit_role_compaction::view::Edit;
use std::collections::BTreeMap;

fn state_with(text: &str, image: Option<InsertedImage>) -> ReadState {
    let baseline = Arc::new(Baseline {
        m0: text.into(),
        ..Default::default()
    });
    let view = View::seal(
        7,
        head_ops(text, M1_EMPTY, image)
            .into_iter()
            .map(|op| Edit::new(7, op))
            .collect(),
    );
    let mut state = ReadState::default();
    state.record(&view, Some(baseline), "provider/model");
    state.confirm(7);
    state
}

fn piece(state: &ReadState, extra: Value) -> Result<Value, Refusal> {
    let mut params = json!({"view":7,"slot":"baseline","section":0,"max_bytes":1024});
    params
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    read_section(Some(state), SectionRequest::parse(&params)?)
}

#[test]
fn v11_folder_is_frozen() {
    let root =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/mc-app-read-samples-v11");
    for (name, hash) in [
        (
            "README.md",
            "f6d6d4d151b31e948894b5e0924b40bbfa37d0d11eef26eab5c6e027ef496bda",
        ),
        (
            "SHA256SUMS",
            "9246e4624920b1c7970e4b99e48a496c76a5e3019630a52bc53bdb9895e8d430",
        ),
    ] {
        assert_eq!(
            format!(
                "{:x}",
                Sha256::digest(std::fs::read(root.join(name)).unwrap())
            ),
            hash
        );
    }
    for line in std::fs::read_to_string(root.join("SHA256SUMS"))
        .unwrap()
        .lines()
    {
        let (hash, name) = line.split_once("  ").unwrap();
        assert_eq!(
            format!(
                "{:x}",
                Sha256::digest(std::fs::read(root.join(name)).unwrap())
            ),
            hash,
            "{name}"
        );
    }
}

fn without_attribution(mut state: ReadState, through: i64) -> ReadState {
    state.confirmed = None;
    let head = Arc::get_mut(state.offered.as_mut().unwrap()).unwrap();
    let baseline = Arc::make_mut(head.baseline.as_mut().unwrap());
    baseline.summary_items = Default::default();
    baseline.committed.clear();
    baseline.through_sequence = through;
    state
}

#[test]
fn old_baseline_summary_attribution_is_unknown_not_zero() {
    for through in [0, 1] {
        let state = without_attribution(rendered(false, false, false).0, through);
        let outline = read(&snapshot(), Some(&state)).unwrap();
        for (m, s) in [(0, 2), (1, 0), (1, 1)] {
            assert!(outline["messages"][m]["sections"][s].get("items").is_none());
        }
        let text = section_text(&state, "baseline", 2);
        assert_eq!(outline["messages"][0]["sections"][2]["bytes"], text.len());
        assert_eq!(
            outline["messages"][0]["sections"][2]["tokens"],
            Counter::for_model(Some("provider/model")).count(&text)
        );
        assert_eq!(
            reconstruct(&state, &outline["messages"][0]),
            state.offered.as_ref().unwrap().slots[0].text
        );
    }
    let state = state_with(crate::summary::head::HISTORY_EMPTY, None);
    let outline = read(&snapshot(), Some(&state)).unwrap();
    assert_eq!(outline["messages"][0]["sections"][0]["items"], json!([]));
    for text in [
        "<project-docs>unknown files</project-docs>",
        "<project-memory>unknown memories</project-memory>",
    ] {
        let state = state_with(text, None);
        assert!(
            read(&snapshot(), Some(&state)).unwrap()["messages"][0]["sections"][0]
                .get("items")
                .is_none()
        );
    }
}

#[test]
fn chunks_honor_utf8_boundaries_defaults_and_invalid_fields() {
    let text = format!("{}é{}", "a".repeat(1023), "b".repeat(12));
    let state = state_with(&text, None);
    let first = piece(&state, json!({})).unwrap();
    assert_eq!(first["text"].as_str().unwrap().len(), 1023);
    assert_eq!(first["next_offset"], 1023);
    let second = piece(&state, json!({"offset":1023})).unwrap();
    assert_eq!(
        format!(
            "{}{}",
            first["text"].as_str().unwrap(),
            second["text"].as_str().unwrap()
        ),
        text
    );
    assert!(second.get("next_offset").is_none());
    assert_eq!(
        piece(&state, json!({"offset":text.len()})).unwrap()["text"],
        ""
    );
    for (extra, field) in invalid_cases(text.len()) {
        let refusal = piece(&state, extra).unwrap_err();
        assert_eq!(refusal.code, "invalid_params");
        assert!(refusal.message.contains(field), "{refusal:?}");
    }
    assert_eq!(
        piece(&state, json!({"view":8})).unwrap_err().code,
        "head_changed"
    );
    let no_view = ReadState {
        ready: true,
        ..Default::default()
    };
    assert_eq!(piece(&no_view, json!({})).unwrap_err().code, "head_changed");
    assert_eq!(
        piece(&ReadState::default(), json!({})).unwrap_err().code,
        "head_not_ready"
    );
    let params = json!({"view":7,"slot":"baseline","section":0});
    assert_eq!(
        read_section(Some(&state), SectionRequest::parse(&params).unwrap()).unwrap()["text"],
        text
    );
}

fn invalid_cases(len: usize) -> Vec<(Value, &'static str)> {
    vec![
        (json!({"slot":"unknown"}), "slot"),
        (json!({"section":99}), "section"),
        (json!({"part":"unknown"}), "part"),
        (json!({"part":"image"}), "part"),
        (json!({"offset":1024}), "offset"),
        (json!({"offset":len+1}), "offset"),
        (json!({"max_bytes":1023}), "max_bytes"),
        (json!({"max_bytes":262145}), "max_bytes"),
        (json!({"view":null}), "view"),
        (json!({"offset":-1}), "offset"),
        (json!({"section":null}), "section"),
    ]
}

fn image_state() -> ReadState {
    let svg = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1\" height=\"1\"><!--{}--></svg>",
        "x".repeat(1100)
    );
    state_with(
        "<memory-mural>\nMemories in the attached image.\n</memory-mural>",
        Some(InsertedImage::new("image/svg+xml", STANDARD.encode(svg))),
    )
}

fn utf8_state() -> ReadState {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("ARCHITECTURE.md"), "東京と大阪漢").unwrap();
    let docs = crate::project_docs::read_project_docs_canonical(dir.path().to_str().unwrap());
    let memories = [crate::head_memories::Row::from_stored(
        "project",
        &crate::context_db::StoredMemory {
            id: 1,
            category: "PROJECT_RULES".into(),
            content: "🧠原文を保持🌍".into(),
            status: "active".into(),
            ..Default::default()
        },
    )];
    let baseline = crate::summary::head::fold(
        &crate::summary::head::Inputs {
            counter: Counter::for_model(Some("provider/model")),
            summaries: &[],
            docs: &docs.rendered_block,
            rows: &memories,
            workspace: None,
            classes: &std::collections::HashMap::new(),
            now_ms: 0,
            gone: &[],
            history_budget_tokens: 10000,
            history_local_budget_tokens: 10000,
            memory_budget_tokens: 4000,
            profile_budget_tokens: 1000,
        },
        None,
    );
    state_with(&baseline.m0, None)
}

#[test]
fn utf8_content_edges_preserve_every_item_range_and_message() {
    let state = utf8_state();
    let outline = read(&snapshot(), Some(&state)).unwrap();
    assert_eq!(
        reconstruct(&state, &outline["messages"][0]),
        state.offered.as_ref().unwrap().slots[0].text
    );
    let sections = outline["messages"][0]["sections"].as_array().unwrap();
    for (n, section) in sections.iter().enumerate() {
        let text = section_text(&state, "baseline", n);
        for item in section["items"].as_array().unwrap() {
            let rendered = item_text(&text, item);
            assert_eq!(
                rendered,
                if n == 0 {
                    "<file name=\"ARCHITECTURE.md\">\n東京と大阪漢\n</file>"
                } else {
                    "#1: 🧠原文を保持🌍"
                }
            );
        }
    }
}

#[test]
fn invalid_utf8_item_boundaries_omit_items_without_changing_content_or_counts() {
    let text = "🧠原文🌍";
    for (start, len) in [(1, 3), (0, 2), (0, 999)] {
        let mut section = json!({"kind":"memory","bytes":text.len(),"tokens":4,"items":[{"start":start,"len":len}]});
        validate_ranges(&mut section, text);
        assert!(section.get("items").is_none());
        assert_eq!(
            section,
            json!({"kind":"memory","bytes":text.len(),"tokens":4})
        );
        assert_eq!(text, "🧠原文🌍");
    }
}

#[test]
fn image_chunks_decode_individually_and_match_the_outline_digest() {
    let state = image_state();
    let first = piece(&state, json!({"part":"image","max_bytes":1025})).unwrap();
    assert_eq!(first["data"].as_str().unwrap().len(), 1024);
    assert_eq!(
        piece(&state, json!({"part":"image","offset":1}))
            .unwrap_err()
            .code,
        "invalid_params"
    );
    let second = piece(&state, json!({"part":"image","offset":1024})).unwrap();
    let mut decoded = STANDARD.decode(first["data"].as_str().unwrap()).unwrap();
    decoded.extend(STANDARD.decode(second["data"].as_str().unwrap()).unwrap());
    let outline = read(&snapshot(), Some(&state)).unwrap();
    assert_eq!(
        outline["messages"][0]["sections"][0]["image"]["sha256"],
        format!("{:x}", Sha256::digest(decoded))
    );
}

#[test]
fn large_head_outline_and_every_chunk_fit_in_frames() {
    let (view, baseline) = large_head(
        1500,
        2000,
        Some(InsertedImage::new(
            "image/png",
            STANDARD.encode(vec![0u8; 400_000]),
        )),
    );
    let mut state = ReadState::default();
    state.record(&view, Some(baseline), "provider/model");
    let outline = read(&snapshot(), Some(&state)).unwrap();
    let bytes = super::super::reply_bytes("context.head", outline.clone())
        .unwrap()
        .len();
    println!("v12 outline: 1500 summaries, 2000 memories, 400000 image bytes: {bytes} bytes");
    assert_eq!(
        outline["messages"][0]["sections"][0]["items"]
            .as_array()
            .unwrap()
            .len(),
        1500
    );
    assert_eq!(
        outline["messages"][0]["sections"][1]["items"]
            .as_array()
            .unwrap()
            .len(),
        2000
    );
    for (message, slot) in outline["messages"]
        .as_array()
        .unwrap()
        .iter()
        .zip(&state.offered.as_ref().unwrap().slots)
    {
        assert_eq!(reconstruct(&state, message), slot.text);
        for section in message["sections"].as_array().unwrap() {
            if section.get("image").is_none() {
                continue;
            }
            let mut offset = 0;
            let mut image = Vec::new();
            loop {
                let p = json!({"view":9,"slot":message["slot"],"section":section["index"],"part":"image","offset":offset,"max_bytes":1024});
                let chunk = read_section(Some(&state), SectionRequest::parse(&p).unwrap()).unwrap();
                super::super::reply_bytes("context.head_section", chunk.clone()).unwrap();
                image.extend(STANDARD.decode(chunk["data"].as_str().unwrap()).unwrap());
                let Some(next) = chunk["next_offset"].as_u64() else {
                    break;
                };
                offset = next;
            }
            assert_eq!(image.len(), 400_000);
            assert_eq!(
                section["image"]["sha256"],
                format!("{:x}", Sha256::digest(image))
            );
        }
    }
}

#[test]
fn outline_omits_largest_attribution_before_it_exhausts_the_frame() {
    let mut state = without_attribution(rendered(false, false, false).0, 1);
    let head = Arc::get_mut(state.offered.as_mut().unwrap()).unwrap();
    let baseline = Arc::make_mut(head.baseline.as_mut().unwrap());
    let source = rendered(false, false, false).0;
    let summary = source
        .offered
        .as_ref()
        .unwrap()
        .baseline
        .as_ref()
        .unwrap()
        .summary_items[0]
        .clone();
    baseline.summary_items = crate::summary::head::SummaryItems::new(vec![summary; 20000]);
    let outline = read(&snapshot(), Some(&state)).unwrap();
    let history = &outline["messages"][0]["sections"][2];
    assert!(history.get("items").is_none());
    assert_eq!(history["items_omitted"], "too_large");
    super::super::reply_bytes("context.head", outline).unwrap();
}

#[test]
fn escaped_text_chunks_still_fit_the_encoded_frame() {
    let state = state_with(&"\u{1}".repeat(262144), None);
    let p = json!({"view":7,"slot":"baseline","section":0});
    let chunk = read_section(Some(&state), SectionRequest::parse(&p).unwrap()).unwrap();
    assert!(chunk["next_offset"].as_u64().unwrap() < 262144);
    super::super::reply_bytes("context.head_section", chunk).unwrap();
    assert_eq!(section_text(&state, "baseline", 0), "\u{1}".repeat(262144));
}

pub(super) fn samples(samples: &mut BTreeMap<String, Vec<u8>>) {
    let utf8 = utf8_state();
    insert_sample(
        samples,
        "head-utf8",
        "context.head",
        json!({"session":snapshot().key}),
        read(&snapshot(), Some(&utf8)),
    );
    let text = format!("{}é{}", "a".repeat(1023), "b".repeat(12));
    let state = state_with(&text, None);
    insert_sample(
        samples,
        "head-text-chunks",
        "context.head",
        json!({"session":snapshot().key}),
        read(&snapshot(), Some(&state)),
    );
    let mut cases = vec![
        ("head-section-text".to_owned(), json!({"max_bytes":262144})),
        ("head-section-text-1".into(), json!({})),
        ("head-section-text-2".into(), json!({"offset":1023})),
        ("head-changed".into(), json!({"view":8})),
    ];
    for (n, (extra, _)) in invalid_cases(text.len()).into_iter().enumerate() {
        cases.push((format!("head-invalid-{}", n + 1), extra));
    }
    for (name, extra) in cases {
        let mut params = json!({"session":snapshot().key,"view":7,"slot":"baseline","section":0,"max_bytes":1024});
        params
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let result = SectionRequest::parse(&params).and_then(|r| read_section(Some(&state), r));
        insert_sample(samples, &name, "context.head_section", params, result);
    }
    let state = image_state();
    insert_sample(
        samples,
        "head-image-chunks",
        "context.head",
        json!({"session":snapshot().key}),
        read(&snapshot(), Some(&state)),
    );
    for (name, offset) in [("head-section-image-1", 0), ("head-section-image-2", 1024)] {
        let params = json!({"session":snapshot().key,"view":7,"slot":"baseline","section":0,"part":"image","offset":offset,"max_bytes":1024});
        let result = read_section(Some(&state), SectionRequest::parse(&params).unwrap());
        insert_sample(samples, name, "context.head_section", params, result);
    }
    let refusal =
        super::super::reply_bytes("session_data.read", json!("x".repeat(512 * 1024))).unwrap_err();
    insert_sample(
        samples,
        "reply-too-large",
        "session_data.read",
        json!({"session":snapshot().key,"section":"meta"}),
        Err(refusal),
    );
}

fn insert_sample(
    samples: &mut BTreeMap<String, Vec<u8>>,
    name: &str,
    method: &str,
    params: Value,
    result: Result<Value, Refusal>,
) {
    let response = match result {
        Ok(result) => json!({"result":result}),
        Err(error) => json!({"error":error}),
    };
    let sample =
        json!({"name":name,"request":{"method":method,"params":params},"response":response});
    samples.insert(
        format!("{name}.json"),
        format!("{}\n", serde_json::to_string_pretty(&sample).unwrap()).into_bytes(),
    );
}
