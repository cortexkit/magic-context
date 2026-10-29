use super::*;
use std::{collections::BTreeSet, fs, path::PathBuf};

fn data() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("testdata/memory_profile")
}

pub(crate) fn acme() -> Profile {
    acme_from(&data().join("acme-memory-legal"))
}

pub(crate) fn acme_from(root: &std::path::Path) -> Profile {
    let ck = fs::read(root.join("ck.json")).unwrap();
    let env: Value = serde_json::from_slice(&ck).unwrap();
    let files = list(&env, "files")
        .iter()
        .map(|f| {
            let path = text(f, "path");
            (path.to_owned(), fs::read(root.join(path)).unwrap())
        })
        .collect();
    let mut chain = super::super::bundled::packages();
    chain.truncate(1);
    chain.push(super::super::Package::decode(&ck, files).unwrap());
    super::super::load_chain(&chain).unwrap()
}

#[test]
fn l5_vendored_bytes_match_checksums() {
    let checks = include_str!("../../testdata/memory_profile/SHA256SUMS");
    let mut seen = BTreeSet::new();
    for line in checks.lines() {
        let (hash, path) = line.split_once("  ").unwrap();
        assert!(seen.insert(path));
        assert_eq!(
            super::super::sha256(&fs::read(data().join(path)).unwrap()),
            hash,
            "{path}"
        );
    }
    assert_eq!(seen.len(), 65);
}

#[test]
fn resolved_swe_documents_are_byte_identical() {
    let profile = bundled_swe().unwrap();
    let oracle: Vec<Value> =
        serde_json::from_str(include_str!("../../testdata/memory_profile/oracle.json")).unwrap();
    let mut actual_docs = BTreeSet::new();
    for entry in &oracle {
        let path = text(entry, "path");
        assert!(!path.starts_with("resolved-swe/rendered/data/"));
        assert!(!path.starts_with("resolved-swe/rendered/main-agent/ctx_memory.description."));
        let actual = if let Some(doc) = entry["document"].as_str() {
            let variant = entry["variant"].as_str();
            actual_docs.insert((doc.to_owned(), variant.map(str::to_owned)));
            render(&profile, doc, variant).unwrap()
        } else {
            assert!(path.starts_with("resolved-swe/rendered/mc/main-agent/ctx_memory.description."));
            render_frame(&profile, text(entry, "frame"), None).unwrap()
        };
        let expected = fs::read(data().join(path)).unwrap();
        assert_eq!(super::super::sha256(&expected), text(entry, "sha256"));
        assert_eq!(actual.as_bytes(), expected, "{path}");
    }
    let mut expected_docs = BTreeSet::new();
    for (doc, declaration) in profile.body["prompts"].as_object().unwrap() {
        if let Some(variants) = declaration["variants"].as_array() {
            for variant in variants {
                expected_docs.insert((doc.clone(), variant.as_str().map(str::to_owned)));
            }
        } else {
            expected_docs.insert((doc.clone(), None));
        }
    }
    assert_eq!(actual_docs, expected_docs);
    assert_eq!(oracle.len(), 29);
}

#[test]
fn unknown_frames_markers_and_conditions_refuse_prompt_invalid() {
    let profile = bundled_swe().unwrap();
    for input in [
        "⟦mc:not-a-frame⟧",
        "prefix ⟦mc:historian/input-notation⟧",
        "⟦profile:not-a-marker⟧",
        "prefix ⟦profile:not-a-marker⟧",
        "⟦if not_a_condition⟧text",
    ] {
        assert_eq!(
            expand(&profile, input, true, None).unwrap_err().code,
            "prompt_invalid",
            "{input}"
        );
    }
    assert_eq!(
        render_frame(&profile, "verify.input", None).unwrap(),
        render_frame(&profile, "dreamer/verify.input", None).unwrap()
    );
    assert_eq!(
        render_frame(&profile, "historian/input-notation", Some("xml")).unwrap(),
        render_frame(&profile, "historian/input-notation", None).unwrap()
    );
}

#[test]
fn acme_documents_expand_and_historian_preserves_order_and_frames() {
    let profile = acme();
    for (doc, declaration) in profile.body["prompts"].as_object().unwrap() {
        for variant in declaration["variants"]
            .as_array()
            .map(|v| v.iter().map(Value::as_str).collect::<Vec<_>>())
            .unwrap_or_else(|| vec![None])
        {
            let output = render(&profile, doc, variant).unwrap();
            for prefix in ["⟦mc:", "⟦profile:", "⟦if "] {
                assert!(!output.contains(prefix), "{doc}: {prefix}");
            }
        }
    }
    let output = render(&profile, "historian/system", Some("xml")).unwrap();
    assert!(output.starts_with(
        frames::source(
            &fs::read_to_string(data().join("acme-memory-legal/prompts/historian/persona.md"))
                .unwrap()
        )
        .unwrap()
    ));
    let mut cursor = 0;
    for section in list(&profile.body["prompts"]["historian/system"], "sections") {
        if section["requires"]
            .as_str()
            .is_some_and(|c| !condition_value(&profile, c).unwrap())
        {
            continue;
        }
        let part = if let Some(frame) = section["mc"].as_str() {
            render_frame(&profile, frame, Some("xml")).unwrap()
        } else {
            expand(
                &profile,
                frames::source(profile.member(section, "file").unwrap()).unwrap(),
                true,
                Some("xml"),
            )
            .unwrap()
        };
        let position = output[cursor..]
            .find(&part)
            .unwrap_or_else(|| panic!("missing ordered section {}", text(section, "id")));
        cursor += position + part.len();
    }
    let definition = list(&profile.body, "categories")
        .iter()
        .find(|c| c["tag"] == "MATTER_RULES")
        .unwrap();
    assert!(output
        .contains(frames::source(profile.member(definition, "definition_file").unwrap()).unwrap()));
    assert!(output
        .ends_with(&render_frame(&profile, "historian/output-contract", Some("xml")).unwrap()));
}

#[test]
fn historian_frames_are_legacy_bytes_except_classified_hunks() {
    let legacy = crate::historian_prompt::HISTORIAN_SYSTEM_PROMPT;
    let profile = bundled_swe().unwrap();
    let start = legacy.find("- Input notation:").unwrap();
    let end = legacy[start..].find("\n---").unwrap() + start;
    assert_eq!(
        render_frame(&profile, "historian/input-notation", Some("xml")).unwrap(),
        &legacy[start..end]
    );
    let (_, legacy_output) = legacy.split_once("## Output").unwrap();
    let user_blocks = [
        "COMMUNICATION",
        "PREFERENCES",
        "BOUNDARIES",
        "WORKING_STYLE",
        "IDENTITY",
        "ENGINEERING_PRACTICE",
        "DEV_ENVIRONMENT",
    ]
    .map(|tag| format!("<{tag}>\n* Observation text\n</{tag}>"))
    .join("\n");
    // The only XML-frame deltas are the optional produced fact and grouped user
    // observations. The checksum-pinned testdata/memory_profile/resolved-swe/DIFF.md
    // classifies both as interface changes; all other frame bytes must match.
    let expected = format!("## Output{legacy_output}")
        .replace(
            "<fix_summary>...</fix_summary>\n",
            "<fix_summary>...</fix_summary>\n<produced_fact>...</produced_fact>\n",
        )
        .replace(
            "<user_observations>\n* Observation text\n",
            &format!("<user_observations>\n{user_blocks}\n"),
        );
    assert_eq!(
        render_frame(&profile, "historian/output-contract", Some("xml")).unwrap(),
        expected
    );
    let diff = include_str!("../../testdata/memory_profile/resolved-swe/DIFF.md");
    let xml_diff = diff
        .split("### `historian/system.xml.md`")
        .nth(1)
        .unwrap()
        .split("### `historian/system.combined.md`")
        .next()
        .unwrap();
    assert!(xml_diff.contains("**mc-interface** (§11.11)"));
    assert!(xml_diff.contains("+<produced_fact>...</produced_fact>"));
    assert!(xml_diff.contains("**mc-interface** (§11.13, §11.15)"));
    for tag in [
        "COMMUNICATION",
        "PREFERENCES",
        "BOUNDARIES",
        "WORKING_STYLE",
        "IDENTITY",
        "ENGINEERING_PRACTICE",
        "DEV_ENVIRONMENT",
    ] {
        assert!(xml_diff.contains(&format!("+<{tag}>")));
    }
}
