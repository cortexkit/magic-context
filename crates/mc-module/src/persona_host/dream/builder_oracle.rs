//! Executable prompt inputs shared by the current-code test and the temporary
//! test compiled against the baseline commit by the reproduction script.

use super::*;
use crate::dream_tasks::{classify, curate, verify};
use mc_store::dream_retrospective::{ReviewSnapshot, UserCandidate, UserProfile};
use serde_json::{json, Value};

const PROJECT: &str = "Example project {{ not_a_template }}";
const CATEGORY: &str = "PROJECT_RULES";
const CONTENTS: [&str; 2] = ["Memory α", "Memory β"];
const CANDIDATES: [&str; 2] = ["Candidate α", "Candidate β"];
const PROFILES: [&str; 2] = ["Profile α", "Profile β"];
const ANCHOR: &str = "Anchors\n\n";
const PATH: &str = "src/example.rs";
const COMMIT: &str = "0123456789abcdef0123456789abcdef01234567";

fn curate_memory(id: i64, content: &str) -> curate::PromptMemory {
    curate::PromptMemory {
        id,
        category: CATEGORY.into(),
        content: content.into(),
        mapped_files: vec![],
        has_no_file_sentinel: false,
        importance: 50.0,
        retrieval_count: 0.0,
        seen_count: 0.0,
    }
}

fn classify_memory(id: i64, content: &str, unclassified: bool) -> classify::Memory {
    classify::Memory {
        id,
        category: CATEGORY.into(),
        content: content.into(),
        normalized_hash: mc_store::compute_normalized_memory_hash(content),
        importance: Some(50),
        scope: Some("project".into()),
        shareable: true,
        safety_critical: Some(false),
        unclassified,
        open_classification: false,
        unmapped: true,
        has_sentinel: false,
        files: vec![],
        mapping_origin: None,
    }
}

fn verify_memory(id: i64, content: &str) -> verify::Memory {
    verify::Memory {
        id,
        category: CATEGORY.into(),
        content: content.into(),
        revision: 1,
        content_hash: mc_store::compute_normalized_memory_hash(content),
        files: vec![PATH.into()],
        verified_at: 1000,
        verified_commit: Some(COMMIT.into()),
    }
}

fn review_snapshot() -> ReviewSnapshot {
    ReviewSnapshot {
        candidates: CANDIDATES
            .iter()
            .enumerate()
            .map(|(index, content)| UserCandidate {
                id: index as i64 + 1,
                content: (*content).into(),
                session_id: format!("session-{}-longer-than-twelve", index + 1),
                created_at: 100 + index as i64,
                source_compartment_start: Some(1),
                source_compartment_end: Some(2),
            })
            .collect(),
        profiles: PROFILES
            .iter()
            .enumerate()
            .map(|(index, content)| UserProfile {
                id: index as i64 + 1,
                content: (*content).into(),
                status: "active".into(),
                promoted_at: 90,
                source_candidate_ids: "[]".into(),
                source_candidate_provenance: None,
                created_at: 90,
                updated_at: 90,
            })
            .collect(),
        task_state_json: None,
    }
}

fn capture() -> Value {
    let mut cases = serde_json::Map::new();
    let mut record = |name: &str, kind: &str, mode: &str, system: &str, task: String| {
        cases.insert(
            name.into(),
            json!({"kind": kind, "mode": mode, "system": system, "task": task}),
        );
    };
    let chunk = curate::Chunk {
        memories: CONTENTS
            .iter()
            .enumerate()
            .map(|(index, content)| curate_memory(index as i64 + 1, content))
            .collect(),
        cross_chunk_candidates: CANDIDATES.iter().map(|s| (*s).into()).collect(),
    };
    let curate_system = curate::system_prompt().unwrap();
    record(
        "curate",
        "curate",
        "full",
        curate_system,
        curate::build_prompt(PROJECT, CATEGORY, &chunk).unwrap(),
    );
    let no_candidates = curate::Chunk {
        memories: chunk.memories.clone(),
        cross_chunk_candidates: vec![],
    };
    record(
        "curate_no_candidates",
        "curate",
        "full",
        curate_system,
        curate::build_prompt(PROJECT, CATEGORY, &no_candidates).unwrap(),
    );
    let empty_chunk = curate::Chunk {
        memories: vec![],
        cross_chunk_candidates: vec![],
    };
    record(
        "curate_empty",
        "curate",
        "full",
        curate_system,
        curate::build_prompt(PROJECT, CATEGORY, &empty_chunk).unwrap(),
    );

    let pool: Vec<_> = CONTENTS
        .iter()
        .enumerate()
        .map(|(index, content)| classify_memory(index as i64 + 1, content, true))
        .collect();
    let anchors = [classify_memory(3, ANCHOR, false)];
    let classify_system = classify::classify_system_prompt().unwrap();
    record(
        "classify",
        "classify",
        "full",
        classify_system,
        classify::build_classify_prompt(PROJECT, &pool, &anchors).unwrap(),
    );
    record(
        "classify_no_anchors",
        "classify",
        "full",
        classify_system,
        classify::build_classify_prompt(PROJECT, &pool, &[]).unwrap(),
    );
    record(
        "classify_empty",
        "classify",
        "full",
        classify_system,
        classify::build_classify_prompt(PROJECT, &[], &[]).unwrap(),
    );

    let inputs: Vec<_> = CONTENTS
        .iter()
        .enumerate()
        .map(|(index, content)| classify::MapInput {
            id: index as i64 + 1,
            category: CATEGORY.into(),
            content: (*content).into(),
            candidates: vec![],
        })
        .collect();
    let map_system = classify::map_system_prompt().unwrap();
    record(
        "map",
        "map",
        "full",
        map_system,
        classify::build_map_prompt(PROJECT, &inputs).unwrap(),
    );
    let mut likely = inputs.clone();
    likely[0].candidates = vec![PATH.into(), "src/other.rs".into()];
    record(
        "map_likely",
        "map",
        "full",
        map_system,
        classify::build_map_prompt(PROJECT, &likely).unwrap(),
    );
    record(
        "map_empty",
        "map",
        "full",
        map_system,
        classify::build_map_prompt(PROJECT, &[]).unwrap(),
    );

    let batch: Vec<_> = CONTENTS
        .iter()
        .enumerate()
        .map(|(index, content)| verify_memory(index as i64 + 1, content))
        .collect();
    let evidence = verify::DiffEvidence {
        head: COMMIT.into(),
        mode: "diff".into(),
        files: vec![verify::EvidenceFile {
            path: PATH.into(),
            text: "DIFF".into(),
            memory_ids: vec![1, 2],
        }],
    };
    let verify_system = verify::system_prompt().unwrap();
    let broad_prompt = |batch: &[verify::Memory]| {
        verify::build_prompt_with_mode(PROJECT, batch, None, "broad").unwrap()
    };
    record(
        "verify",
        "verify",
        "full",
        verify_system,
        verify::build_prompt(PROJECT, &batch, None).unwrap(),
    );
    record(
        "verify_diff",
        "verify",
        "full",
        verify_system,
        verify::build_prompt(PROJECT, &batch, Some(&evidence)).unwrap(),
    );
    record(
        "verify_broad",
        "verify",
        "broad",
        verify_system,
        broad_prompt(&batch),
    );
    record(
        "verify_empty",
        "verify",
        "full",
        verify_system,
        verify::build_prompt(PROJECT, &[], None).unwrap(),
    );
    record(
        "verify_broad_empty",
        "verify",
        "broad",
        verify_system,
        broad_prompt(&[]),
    );

    let snapshot = review_snapshot();
    let review_system = review_system().unwrap();
    record(
        "review_user",
        "review_user",
        "full",
        review_system,
        review_prompt(&snapshot, 3).unwrap(),
    );
    let empty = ReviewSnapshot {
        candidates: vec![],
        profiles: vec![],
        task_state_json: None,
    };
    record(
        "review_user_empty",
        "review_user",
        "full",
        review_system,
        review_prompt(&empty, 3).unwrap(),
    );
    let mut escaped = review_snapshot();
    escaped.candidates[0].content = "Candidate α\n\"quoted\" \\ path\t{{ braces }}".into();
    escaped.profiles[0].content = "Profile α\n\"quoted\" \\ path\t{{ braces }}".into();
    escaped.profiles[1].status = "archived".into();
    record(
        "review_user_escaped",
        "review_user",
        "full",
        review_system,
        review_prompt(&escaped, 3).unwrap(),
    );
    json!({
        "base_commit": "7bf675a0d39f5f86fe0568aa2f1dcea6df309945",
        "input": {
            "project": PROJECT, "category": CATEGORY, "memory_contents": CONTENTS,
            "candidates": CANDIDATES, "anchor_content": ANCHOR, "profile_contents": PROFILES,
            "threshold": 3, "example_path": PATH, "evidence_text": "DIFF",
        },
        "cases": cases,
    })
}

// Executable baseline capture ends here. The reproduction script compiles the
// functions above against the original builders, without the current fixture.

#[test]
fn prompt_builders_match_executed_base() {
    let expected: Value =
        serde_json::from_str(include_str!("../../../testdata/dream-personas/legacy.json")).unwrap();
    let actual = capture();
    assert_eq!(actual["base_commit"], expected["base_commit"]);
    assert_eq!(actual["input"], expected["input"]);
    assert_eq!(
        actual["cases"].as_object().unwrap().len(),
        expected["cases"].as_object().unwrap().len()
    );
    for (name, case) in actual["cases"].as_object().unwrap() {
        assert_eq!(case["kind"], expected["cases"][name]["kind"], "{name}");
        assert_eq!(case["mode"], expected["cases"][name]["mode"], "{name}");
        for turn in ["system", "task"] {
            assert_eq!(
                case[turn].as_str().unwrap().as_bytes(),
                expected["cases"][name][turn].as_str().unwrap().as_bytes(),
                "{name} {turn}"
            );
        }
    }
}
