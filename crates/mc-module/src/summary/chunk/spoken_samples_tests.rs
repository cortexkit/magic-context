use std::collections::HashMap;

use cortexkit_role_compaction::part::{Part, ToolPart, ToolStatus};
use cortexkit_role_compaction::read::{Head, ReadPage};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{build_with, render_entry, Entry, Lines, PartBody, Role};

const SUMS: &str = include_str!("../../../testdata/say-transcript-v1/SHA256SUMS");
const BROCA: &str = include_str!("../../../testdata/say-transcript-v1/broca-head.json");
const OPENCODE2: &str = include_str!("../../../testdata/say-transcript-v1/opencode2-head.json");

#[test]
fn say_transcript_sample_hashes_match_the_upstream_manifest() {
    assert_eq!(
        format!("{:x}", Sha256::digest(SUMS)),
        "1dd0eeb4b0cea5c62e6ad5cc40b78a721a605946bbf1e83d40ff97f068be0c70"
    );
    for (line, (file, contents)) in SUMS.lines().zip([
        ("broca-head.json", BROCA),
        ("opencode2-head.json", OPENCODE2),
    ]) {
        assert_eq!(line, format!("{:x}  {file}", Sha256::digest(contents)));
    }
    assert_eq!(SUMS.lines().count(), 2);
}

fn native_parts(row: &Value) -> impl Iterator<Item = &Value> {
    row["message"]["content"].as_array().into_iter().flatten()
}

fn required_str(value: &Value) -> &str {
    value
        .as_str()
        .unwrap_or_else(|| panic!("expected string, got {value}"))
}

fn project_tool(part: &Value, results: &HashMap<&str, &Value>) -> Option<ToolPart> {
    match required_str(&part["type"]) {
        "tool_call" => {
            let id = required_str(&part["tool_call_id"]);
            let result = results.get(id);
            let status = match result {
                Some(result) if result["is_error"] == true => ToolStatus::Error,
                Some(_) => ToolStatus::Completed,
                None => ToolStatus::Running,
            };
            let mut tool = ToolPart::new(
                id,
                required_str(&part["tool_name"]),
                part["input"].clone(),
                status,
            );
            if let Some(output) = result.and_then(|result| result["output"]["text"].as_str()) {
                tool = tool.with_output(output);
            }
            Some(tool)
        }
        "tool" => {
            let state = &part["state"];
            let status = serde_json::from_value(state["status"].clone()).unwrap();
            let mut tool = ToolPart::new(
                required_str(&part["id"]),
                required_str(&part["name"]),
                state["input"].clone(),
                status,
            );
            let output = state["content"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|item| item["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n");
            if !output.is_empty() {
                tool = tool.with_output(output);
            }
            Some(tool)
        }
        _ => None,
    }
}

/// These captures are native `session.read` pages, not the compaction
/// `session.entries` replies ck-mc reads. Project their text and tool parts
/// onto the compaction wire shape in the test; then decode the same `ReadPage`
/// and `Entry` types the summarizer gets. Provider reasoning and runner
/// bookkeeping are not needed to exercise the rendered lines.
fn entries(sample: &str) -> Vec<Entry> {
    let native: Value = serde_json::from_str(sample).unwrap();
    let mut entries = Vec::new();
    for page in native["pages"].as_array().unwrap() {
        let rows = page["reply"]["result"]["messages"].as_array().unwrap();
        let results: HashMap<_, _> = rows
            .iter()
            .flat_map(native_parts)
            .filter(|part| part["type"] == "tool_result")
            .map(|part| (required_str(&part["tool_call_id"]), part))
            .collect();
        let projected: Vec<_> = rows
            .iter()
            .map(|row| {
                let mid = required_str(&row["mid"]);
                let text = |text: &Value| PartBody::Text {
                    text: required_str(text).into(),
                };
                let mut parts: Vec<_> = native_parts(row)
                    .enumerate()
                    .filter_map(|(position, part)| {
                        let body = if part["type"] == "text" {
                            text(&part["text"])
                        } else {
                            PartBody::Tool(project_tool(part, &results)?)
                        };
                        Some(Part::new(format!("{mid}/{position}"), body))
                    })
                    .collect();
                if let Some(text_value) =
                    row["message"].get("text").filter(|value| value.is_string())
                {
                    parts.push(Part::new(format!("{mid}/text"), text(text_value)));
                }
                let role: Role = serde_json::from_value(row["role"].clone()).unwrap();
                Entry::new(
                    row["ordinal"].as_u64().unwrap(),
                    mid,
                    role,
                    row["written_at"].as_u64().unwrap(),
                    parts,
                )
            })
            .collect();
        let reply: ReadPage =
            serde_json::from_value(json!({"entries": projected, "head": Head::new()})).unwrap();
        entries.extend(reply.entries);
    }
    entries
}

fn chunk(entries: &[Entry]) -> String {
    build_with(
        entries,
        1_000_000,
        Lines::PerMessage,
        crate::count::Counter::for_model(None),
    )
    .unwrap()
    .input
}

fn line(chunk: &str, ordinal: u64) -> &str {
    // Per-message lines can cover subsequent non-speaking ordinals too.
    let prefix = format!("[{ordinal}");
    chunk
        .lines()
        .filter_map(|line| line.strip_prefix(&prefix))
        .find_map(|rest| {
            rest.strip_prefix("] ").or_else(|| {
                rest.strip_prefix('-')
                    .and_then(|range| range.split_once("] "))
                    .map(|(_, body)| body)
            })
        })
        .unwrap_or_else(|| panic!("message {ordinal} has no line"))
}

fn narrative(entries: &[Entry], ordinal: u64) -> bool {
    let entry = entries
        .iter()
        .find(|entry| entry.ordinal == ordinal)
        .unwrap();
    render_entry(entry, true).unwrap().3
}

#[test]
fn person_facing_broca_sample_renders_say_instead_of_receipt_and_tool_noise() {
    let entries = entries(BROCA);
    let chunk = chunk(&entries);
    let say = line(&chunk, 309280);
    assert!(say.starts_with("A: (to §416321§ \"put the labels beside the small blue tray\") I will put the labels beside the small blue tray"), "{say}");
    assert!(
        say.ends_with("if either stack runs low during the afternoon."),
        "{say}"
    );
    assert!(narrative(&entries, 309280));
    assert!(!say.contains("TC:"), "{say}");
    assert!(!chunk.contains("[309281] "), "tool result became a line");
    assert!(
        !chunk.contains("[309298] "),
        "closing acknowledgement became a line"
    );
}

#[test]
fn person_facing_opencode2_sample_renders_say_and_keeps_the_real_closing_text() {
    let entries = entries(OPENCODE2);
    let chunk = chunk(&entries);
    let say = line(&chunk, 162029);
    assert!(say.starts_with("A: (to §189885§ \"the morning session\") I will check the room schedule for the morning session"), "{say}");
    assert!(
        say.ends_with("both sides of the main table without clearing a space."),
        "{say}"
    );
    assert!(narrative(&entries, 162029));
    assert!(!say.contains("TC:"), "{say}");
    let info = line(&chunk, 162015);
    assert!(
        info.starts_with("A: The update for the workshop will take a little longer than expected."),
        "{info}"
    );
    assert!(
        info.contains("for the first group. I will compare the two packets"),
        "{info}"
    );
    assert!(
        !chunk.contains("[162016] "),
        "closing acknowledgement became a line"
    );
    assert_eq!(line(&chunk, 162091), "A: The supply list is beside the sign-up sheet, and the large table is available for the morning session. I left the spare cards on the side table and kept the entry clear.");
}
