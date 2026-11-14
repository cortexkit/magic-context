//! The outline names the level of each memory block and each memory-update
//! line, and the category an update line carries, so an app can group them
//! without reading the section text. Nothing else in the outline moves.

use super::tests::{item_text, rendered, rendered_with, section_text, snapshot};
use super::*;
use crate::summary::head::{head_ops, Committed};
use cortexkit_role_compaction::view::Edit;
use std::collections::BTreeMap;

#[test]
fn memory_sections_name_the_workspace_then_the_project_level() {
    let (state, _) = rendered_with(false, false, false, true);
    let outline = read(&snapshot(), Some(&state)).unwrap();
    let sections = outline["messages"][0]["sections"].as_array().unwrap();
    let memory = sections
        .iter()
        .filter(|section| section["kind"] == "memory")
        .collect::<Vec<_>>();
    assert_eq!(memory.len(), 2);
    for (section, level, open, id, category) in [
        (
            memory[0],
            "workspace",
            "<workspace-memory>",
            3,
            "CONSTRAINTS",
        ),
        (memory[1], "project", "<project-memory>", 1, "PROJECT_RULES"),
    ] {
        assert_eq!(section["level"], level);
        let text = section_text(
            &state,
            "baseline",
            section["index"].as_u64().unwrap() as usize,
        );
        assert!(text.starts_with(open), "{text}");
        let items = section["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["id"], id);
        assert_eq!(items[0]["category"], category);
        assert!(item_text(&text, &items[0]).starts_with(&format!("#{id}: ")));
    }
    for section in sections
        .iter()
        .filter(|section| section["kind"] != "memory")
    {
        assert!(section.get("level").is_none(), "{section}");
    }
}

#[test]
fn update_items_name_the_level_and_category_of_their_lines() {
    let (state, _) = rendered(false, false, false);
    let outline = read(&snapshot(), Some(&state)).unwrap();
    let section = &outline["messages"][1]["sections"][0];
    assert_eq!(section["kind"], "memory_updates");
    let text = section_text(&state, "delta", 0);
    let items = section["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    // The project memory's edit, then the user profile line's.
    for (item, (id, level, category)) in items
        .iter()
        .zip([(1, "project", "PROJECT_RULES"), (2, "global", "USER")])
    {
        assert_eq!(item["level"], level);
        assert_eq!(item["category"], category);
        assert_eq!(item["form"], "full");
        assert!(item_text(&text, item).trim_start().starts_with(&format!(
            "<updated id=\"{id}\" level=\"{level}\" category=\"{category}\">"
        )));
    }
}

/// A head whose delta holds only `lines`, each one committed update entry,
/// with a baseline that matches the served `m[0]`, so the read trusts the
/// committed lines.
fn with_update_lines(lines: &[(Form, &str)]) -> ReadState {
    let m0 = crate::summary::head::HISTORY_EMPTY.to_owned();
    let m1 = format!(
        "<session-history-since>\n<memory-updates>\nThese memories changed since the snapshot below — trust these:\n{}\n</memory-updates>\n</session-history-since>",
        lines
            .iter()
            .map(|(_, line)| *line)
            .collect::<Vec<_>>()
            .join("\n")
    );
    let baseline = Baseline {
        m0: m0.clone(),
        through_sequence: -1,
        committed: lines
            .iter()
            .map(|(form, line)| Committed {
                form: *form,
                lines: vec![(*line).to_owned()],
                overflow_ids: Vec::new(),
                overflow_count: 0,
            })
            .collect(),
        ..Default::default()
    };
    let view = View::seal(
        7,
        head_ops(&m0, &m1, None)
            .into_iter()
            .map(|op| Edit::new(7, op))
            .collect(),
    );
    let mut state = ReadState::default();
    state.record(&view, Some(Arc::new(baseline)), "provider/model");
    state.confirm(7);
    state
}

#[test]
fn update_lines_without_a_level_get_no_level() {
    // Lines as an older module wrote them, beside current ones, an
    // out-of-date marker and the overflow line. Only what a line names is
    // reported; nothing is guessed for a line that names no level.
    let lines = [
        (
            Form::Full,
            r#"  <updated id="1" category="PROJECT_RULES">Keep the old text.</updated>"#,
            None,
            Some("PROJECT_RULES"),
        ),
        (Form::Full, r#"  <removed id="2"/>"#, None, None),
        (
            Form::Full,
            r#"  <removed id="3" level="project"/>"#,
            Some("project"),
            None,
        ),
        (
            Form::Full,
            r#"  <added id="5" level="workspace" category="A &amp; B">x &lt; y</added>"#,
            Some("workspace"),
            Some("A & B"),
        ),
        (
            Form::Marker,
            r#"  <stale-memory ids="4" current="4" read-with="ctx_search"/>"#,
            None,
            None,
        ),
        (
            Form::Overflow,
            r#"  <more-memory-edits count="2" ids="6,7" note="2 more memory edits apply at the next rebuild; read them with ctx_search"/>"#,
            None,
            None,
        ),
    ];
    let state = with_update_lines(
        &lines
            .iter()
            .map(|(form, line, _, _)| (*form, *line))
            .collect::<Vec<_>>(),
    );
    let outline = read(&snapshot(), Some(&state)).unwrap();
    let section = &outline["messages"][1]["sections"][0];
    assert_eq!(section["kind"], "memory_updates");
    let text = section_text(&state, "delta", 0);
    let items = section["items"].as_array().unwrap();
    assert_eq!(items.len(), lines.len());
    for (item, (_, line, level, category)) in items.iter().zip(lines) {
        assert_eq!(item_text(&text, item), line);
        assert_eq!(item.get("level").and_then(Value::as_str), level, "{line}");
        assert_eq!(
            item.get("category").and_then(Value::as_str),
            category,
            "{line}"
        );
    }
}

/// Removes what the outline added after v14: each memory section's `level`
/// and each update item's `level` and `category`. Returns how many members
/// it removed.
fn without_levels(sample: &mut Value) -> usize {
    let mut removed = 0;
    let Some(messages) = sample
        .pointer_mut("/response/result/messages")
        .and_then(Value::as_array_mut)
    else {
        return 0;
    };
    for message in messages {
        for section in message["sections"].as_array_mut().unwrap() {
            match section["kind"].as_str().unwrap() {
                "memory" => {
                    removed +=
                        usize::from(section.as_object_mut().unwrap().remove("level").is_some());
                }
                "memory_updates" => {
                    for item in section
                        .get_mut("items")
                        .and_then(Value::as_array_mut)
                        .into_iter()
                        .flatten()
                    {
                        for member in ["level", "category"] {
                            removed +=
                                usize::from(item.as_object_mut().unwrap().remove(member).is_some());
                        }
                    }
                }
                _ => {}
            }
        }
    }
    removed
}

#[test]
fn v14_heads_keep_every_range_and_only_gain_the_levels() {
    let mut samples = BTreeMap::new();
    super::tests::head_samples(&mut samples);
    let v14 =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/mc-app-read-samples-v14");
    let mut gained = BTreeMap::new();
    for (name, bytes) in &samples {
        // The one head sample v14 doesn't have: both memory blocks.
        if name == "head-workspace.json" {
            continue;
        }
        let old: Value = serde_json::from_slice(&std::fs::read(v14.join(name)).unwrap()).unwrap();
        let mut new: Value = serde_json::from_slice(bytes).unwrap();
        gained.insert(name.as_str(), without_levels(&mut new));
        // Every count, byte range and other member is v14's.
        assert_eq!(new, old, "{name}");
    }
    assert_eq!(gained.len(), samples.len() - 1);
    // `head.json` gains the project block's level, and the level and
    // category of both update lines.
    assert_eq!(gained["head.json"], 5);
    assert_eq!(gained["head-utf8.json"], 1);
}
