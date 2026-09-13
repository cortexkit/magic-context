use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use regex::Regex;
use rusqlite::{Connection, OpenFlags};
use serde_json::value::RawValue;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

const DB_SHA256: &str = "f589668287f41abaeb2a6526ee6d6f9d162e7ed80b1650f1ca5ec0a45984b8c0";
const CAPTURE_SHA256: &str = "766c26e1fab1129e0866e275c22d79e111a4382140f4334095279c46f26f526b";
const INDEX_SHA256: &str = "54cd51a54920ebefde642e63f3af85273230d3d08a82fe4a5114230c14f33b0b";
const CANONICAL_VECTORS_SHA256: &str =
    "8fc5b1b90997378941534bd5a0d88bebd6b10282f030ad25315612d77285f012";
const DIGEST_PLACEHOLDER: &str = "<computed-by-slice-0>";
const PROBES: [(u64, &str); 3] = [
    (
        1824,
        "Your parsed disk assertions are independently verified: setup intact",
    ),
    (1864, "the archived project must still be findable by name"),
    (
        1927,
        "Take the real follow-up note1274: audit persistence-related test assertions in this repo",
    ),
];

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("d5-specimen")
}

fn parse_json(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap_or_else(|error| {
        panic!("read {}: {error}", path.display());
    }))
    .unwrap_or_else(|error| panic!("parse {}: {error}", path.display()))
}

fn object(value: &Value) -> &Map<String, Value> {
    value.as_object().expect("expected JSON object")
}

fn array(value: &Value) -> &[Value] {
    value.as_array().expect("expected JSON array")
}

fn text(value: &Value) -> &str {
    value.as_str().expect("expected JSON string")
}

fn number(value: &Value) -> u64 {
    value.as_u64().expect("expected nonnegative JSON integer")
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn decode_base64(encoded: &str) -> Vec<u8> {
    fn sextet(byte: u8) -> Option<u8> {
        match byte {
            b'A'..=b'Z' => Some(byte - b'A'),
            b'a'..=b'z' => Some(byte - b'a' + 26),
            b'0'..=b'9' => Some(byte - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }

    let input = encoded.as_bytes();
    assert_eq!(
        input.len() % 4,
        0,
        "base64 length must be divisible by four"
    );
    let mut output = Vec::with_capacity(input.len() / 4 * 3);
    for chunk in input.as_chunks::<4>().0 {
        let a = sextet(chunk[0]).expect("base64 character");
        let b = sextet(chunk[1]).expect("base64 character");
        let c = if chunk[2] == b'=' {
            0
        } else {
            sextet(chunk[2]).expect("base64 character")
        };
        let d = if chunk[3] == b'=' {
            0
        } else {
            sextet(chunk[3]).expect("base64 character")
        };
        output.push((a << 2) | (b >> 4));
        if chunk[2] != b'=' {
            output.push((b << 4) | (c >> 2));
        }
        if chunk[3] != b'=' {
            output.push((c << 6) | d);
        }
    }
    output
}

fn canonical_json_number_bytes(lexeme: &str) -> Vec<u8> {
    if lexeme.contains(['.', 'e', 'E']) {
        let value = lexeme.parse::<f64>().expect("finite binary64 JSON number");
        assert!(
            value.is_finite(),
            "canonical JSON forbids non-finite floats"
        );
        ryu_js::Buffer::new()
            .format_finite(value)
            .as_bytes()
            .to_vec()
    } else if lexeme == "-0" {
        b"0".to_vec()
    } else {
        lexeme.as_bytes().to_vec()
    }
}

fn canonical_json_bytes(value: &Value) -> Vec<u8> {
    fn write(value: &Value, output: &mut Vec<u8>) {
        match value {
            Value::Null => output.extend_from_slice(b"null"),
            Value::Bool(true) => output.extend_from_slice(b"true"),
            Value::Bool(false) => output.extend_from_slice(b"false"),
            Value::Number(number) => {
                output.extend_from_slice(&canonical_json_number_bytes(&number.to_string()));
            }
            Value::String(text) => output.extend_from_slice(
                &serde_json::to_vec(text).expect("serialize canonical JSON string"),
            ),
            Value::Array(items) => {
                output.push(b'[');
                for (index, item) in items.iter().enumerate() {
                    if index != 0 {
                        output.push(b',');
                    }
                    write(item, output);
                }
                output.push(b']');
            }
            Value::Object(fields) => {
                let mut keys = fields.keys().collect::<Vec<_>>();
                keys.sort_unstable();
                output.push(b'{');
                for (index, key) in keys.into_iter().enumerate() {
                    if index != 0 {
                        output.push(b',');
                    }
                    output.extend_from_slice(
                        &serde_json::to_vec(key).expect("serialize canonical JSON key"),
                    );
                    output.push(b':');
                    write(&fields[key], output);
                }
                output.push(b'}');
            }
        }
    }

    let mut output = Vec::new();
    write(value, &mut output);
    output
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DecodeContext {
    TopLevel,
    ToolResultChild,
}

fn decode_context(value: &str) -> DecodeContext {
    match value {
        "top_level" => DecodeContext::TopLevel,
        "tool_result_child" => DecodeContext::ToolResultChild,
        _ => panic!("unknown decoder context {value}"),
    }
}

fn decoder_would_decode_known(context: DecodeContext, role: &str, block: &Value) -> bool {
    let Some(fields) = block.as_object() else {
        return false;
    };
    let provider_kind = fields.get("type").and_then(Value::as_str);
    if context == DecodeContext::ToolResultChild {
        return provider_kind == Some("text") && fields.get("text").is_some_and(Value::is_string);
    }
    match provider_kind {
        Some("text") => fields.get("text").is_some_and(Value::is_string),
        Some("thinking") => {
            fields.get("thinking").is_some_and(Value::is_string)
                && fields.get("signature").is_some_and(Value::is_string)
        }
        Some("redacted_thinking") => fields.get("data").is_some_and(Value::is_string),
        Some("tool_use") => {
            role == "assistant"
                && fields.get("id").is_some_and(Value::is_string)
                && fields.get("name").is_some_and(Value::is_string)
                && fields.contains_key("input")
        }
        Some("tool_result") => {
            role == "user"
                && fields.get("tool_use_id").is_some_and(Value::is_string)
                && fields.contains_key("content")
        }
        _ => false,
    }
}

fn contract_kind(context: DecodeContext, role: &str, block: &Value) -> &'static str {
    if !decoder_would_decode_known(context, role, block) {
        return "opaque";
    }
    match block.get("type").and_then(Value::as_str) {
        Some("thinking") => "reasoning",
        Some("redacted_thinking") => "redacted_reasoning",
        Some("tool_use") => "tool_use",
        Some("tool_result") => "tool_result",
        Some("text") => "text",
        _ => unreachable!("known decoder block has a mapped kind"),
    }
}

fn block_identity(block: &Value) -> String {
    let provider_kind = block
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    block
        .get("id")
        .or_else(|| block.get("tool_use_id"))
        .and_then(Value::as_str)
        .map_or_else(
            || provider_kind.to_owned(),
            |identity| format!("{provider_kind}[{identity}]"),
        )
}

fn canonical_raw_json_bytes(raw: &RawValue) -> Vec<u8> {
    let source = raw.get().trim();
    match source.as_bytes().first().copied() {
        Some(b'{') => {
            let fields = serde_json::from_str::<BTreeMap<String, Box<RawValue>>>(source)
                .expect("parse raw JSON object");
            let mut output = Vec::new();
            output.push(b'{');
            for (index, (key, value)) in fields.iter().enumerate() {
                if index != 0 {
                    output.push(b',');
                }
                output.extend_from_slice(
                    &serde_json::to_vec(key).expect("serialize canonical JSON key"),
                );
                output.push(b':');
                output.extend_from_slice(&canonical_raw_json_bytes(value));
            }
            output.push(b'}');
            output
        }
        Some(b'[') => {
            let items =
                serde_json::from_str::<Vec<Box<RawValue>>>(source).expect("parse raw JSON array");
            let mut output = Vec::new();
            output.push(b'[');
            for (index, item) in items.iter().enumerate() {
                if index != 0 {
                    output.push(b',');
                }
                output.extend_from_slice(&canonical_raw_json_bytes(item));
            }
            output.push(b']');
            output
        }
        Some(b'"') => serde_json::to_vec(
            &serde_json::from_str::<String>(source).expect("parse raw JSON string"),
        )
        .expect("serialize canonical JSON string"),
        Some(b't' | b'f' | b'n') => source.as_bytes().to_vec(),
        Some(_) => canonical_json_number_bytes(source),
        None => panic!("raw JSON value cannot be empty"),
    }
}

fn canonical_tool_result_content_bytes(
    role: &str,
    raw: &RawValue,
) -> Result<Option<Vec<u8>>, String> {
    let Ok(items) = serde_json::from_str::<Vec<Box<RawValue>>>(raw.get()) else {
        return Ok(None);
    };
    let mut output = Vec::new();
    output.push(b'[');
    for (index, item) in items.iter().enumerate() {
        if index != 0 {
            output.push(b',');
        }
        output.extend_from_slice(&canonical_provider_block_bytes(
            DecodeContext::ToolResultChild,
            role,
            item.as_ref(),
        )?);
    }
    output.push(b']');
    Ok(Some(output))
}

fn canonical_provider_block_bytes(
    context: DecodeContext,
    role: &str,
    raw: &RawValue,
) -> Result<Vec<u8>, String> {
    let block: Value = serde_json::from_str(raw.get()).expect("parse provider block");
    if !decoder_would_decode_known(context, role, &block) {
        return Ok(raw.get().as_bytes().to_vec());
    }
    if context == DecodeContext::ToolResultChild {
        return Ok(canonical_json_bytes(&block));
    }

    let provider_kind = block
        .get("type")
        .and_then(Value::as_str)
        .expect("known provider kind");
    let fields = serde_json::from_str::<BTreeMap<String, Box<RawValue>>>(raw.get())
        .expect("parse provider block fields");
    let retained = fields
        .iter()
        .filter(|(key, _)| !matches!(key.as_str(), "type" | "id" | "tool_use_id"))
        .collect::<Vec<_>>();
    let mut output = Vec::new();
    output.push(b'{');
    for (index, (key, value)) in retained.into_iter().enumerate() {
        if index != 0 {
            output.push(b',');
        }
        output.extend_from_slice(
            &serde_json::to_vec(key).expect("serialize canonical provider field name"),
        );
        output.push(b':');
        if provider_kind == "tool_result" && key == "content" {
            if let Some(content) = canonical_tool_result_content_bytes(role, value)? {
                output.extend_from_slice(&content);
                continue;
            }
        }
        output.extend_from_slice(&canonical_raw_json_bytes(value));
    }
    output.push(b'}');
    Ok(output)
}

fn canonical_provider_block_without_raw(
    context: DecodeContext,
    role: &str,
    block: &Value,
) -> Result<Vec<u8>, String> {
    if !decoder_would_decode_known(context, role, block) {
        return Err(format!(
            "opaque {} is missing its raw JSON bytes",
            block_identity(block)
        ));
    }
    if context == DecodeContext::TopLevel
        && block.get("type").and_then(Value::as_str) == Some("tool_result")
    {
        if let Some(items) = block.get("content").and_then(Value::as_array) {
            if let Some((index, child)) = items.iter().enumerate().find(|(_, child)| {
                !decoder_would_decode_known(DecodeContext::ToolResultChild, role, child)
            }) {
                return Err(format!(
                    "{} has opaque descendant content[{index}] {} but raw JSON bytes are unavailable",
                    block_identity(block),
                    block_identity(child)
                ));
            }
        }
    }

    let mut payload = block.clone();
    if context == DecodeContext::TopLevel {
        let fields = payload
            .as_object_mut()
            .expect("known provider block object");
        for key in ["type", "id", "tool_use_id"] {
            fields.remove(key);
        }
    }
    Ok(canonical_json_bytes(&payload))
}

fn assert_synthetic_string_segment(
    value: &str,
    ordinal: u64,
    block_index: u64,
    leaf_index: usize,
    character_offset: usize,
) {
    const ALPHABET: &[u8; 26] = b"abcdefghijklmnopqrstuvwxyz";
    for (relative_index, character) in value.chars().enumerate() {
        let valid = match character {
            '"' | '\\' | '\n' | '\r' | '\t' | '\u{0008}' | '\u{000c}' | '\0' => true,
            character if character < '\u{0020}' => false,
            character if character.is_ascii() => {
                let position = character_offset + relative_index;
                let seed = format!("d5:{ordinal}:{block_index}:{leaf_index}:{position}");
                let digest = Sha256::digest(seed.as_bytes());
                let selection = u32::from_be_bytes(digest[..4].try_into().expect("SHA prefix"));
                let selection = selection as usize % 26;
                character == ALPHABET[selection] as char
                    || character == ALPHABET[(selection + 1) % 26] as char
            }
            character if character.len_utf8() == 2 => character == 'é',
            character if character.len_utf8() == 3 => character == '☃',
            character if character.len_utf8() == 4 => character == '😀',
            _ => unreachable!("valid Unicode has a one-to-four-byte UTF-8 encoding"),
        };
        assert!(
            valid,
            "unexpected string bytes could expose source text at {ordinal}#{block_index} string {leaf_index}"
        );
    }
}

fn assert_synthetic_string_values(
    value: &Value,
    ordinal: u64,
    block_index: u64,
    probe: Option<&str>,
    leaf_index: &mut usize,
) -> usize {
    match value {
        Value::Object(fields) => fields
            .values()
            .map(|value| {
                assert_synthetic_string_values(value, ordinal, block_index, probe, leaf_index)
            })
            .sum(),
        Value::Array(items) => items
            .iter()
            .map(|value| {
                assert_synthetic_string_values(value, ordinal, block_index, probe, leaf_index)
            })
            .sum(),
        Value::String(value) => {
            let current_leaf = *leaf_index;
            *leaf_index += 1;
            let hits = probe.map_or(0, |probe| value.matches(probe).count());
            assert!(hits <= 1, "duplicate probe at {ordinal}#{block_index}");
            if hits == 1 {
                let probe = probe.expect("probe hit");
                let (prefix, suffix) = value.split_once(probe).expect("split probe string");
                assert_synthetic_string_segment(prefix, ordinal, block_index, current_leaf, 0);
                assert_synthetic_string_segment(
                    suffix,
                    ordinal,
                    block_index,
                    current_leaf,
                    prefix.chars().count() + probe.chars().count(),
                );
            } else {
                assert_synthetic_string_segment(value, ordinal, block_index, current_leaf, 0);
            }
            hits
        }
        _ => 0,
    }
}

fn string_byte_lengths(value: &Value) -> Vec<u64> {
    fn collect(value: &Value, lengths: &mut Vec<u64>) {
        match value {
            Value::Object(fields) => fields.values().for_each(|value| collect(value, lengths)),
            Value::Array(items) => items.iter().for_each(|value| collect(value, lengths)),
            Value::String(value) => lengths.push(value.len() as u64),
            _ => {}
        }
    }

    let mut lengths = Vec::new();
    collect(value, &mut lengths);
    lengths
}

fn assert_recoverable_block_kind(kind: &str, payload: &Map<String, Value>) {
    match kind {
        "reasoning" => {
            assert_eq!(
                payload.keys().map(String::as_str).collect::<Vec<_>>(),
                ["signature", "thinking"]
            );
            assert!(payload.values().all(Value::is_string));
        }
        "text" => {
            assert_eq!(
                payload.keys().map(String::as_str).collect::<Vec<_>>(),
                ["text"]
            );
            assert!(payload["text"].is_string());
        }
        "tool_use" => {
            assert!(payload["input"].is_object());
            assert!(payload["name"].is_string());
            assert!(payload
                .keys()
                .all(|key| matches!(key.as_str(), "cache_control" | "input" | "name")));
            assert!(payload.len() == 2 || payload.len() == 3);
        }
        "opaque" => assert!(!payload.is_empty()),
        "tool_result" => {
            assert!(
                payload["content"].is_string()
                    || payload["content"].is_array()
                    || payload["content"].is_object()
            );
            assert!(payload
                .get("is_error")
                .is_none_or(|value| value.is_boolean()));
            assert!(payload
                .keys()
                .all(|key| matches!(key.as_str(), "content" | "is_error")));
            assert!(payload.len() == 1 || payload.len() == 2);
        }
        other => panic!("unexpected D5 block kind {other}"),
    }
}

fn identity_tuple(value: &Value) -> (String, u64, u64) {
    let value = object(value);
    (
        text(&value["mid"]).to_owned(),
        number(&value["index"]),
        number(&value["ordinal"]),
    )
}

#[test]
fn d5_fixture_index_pins_every_sibling_and_scans_for_secrets() {
    let root = fixture_dir();
    let index_bytes = fs::read(root.join("fixture-index-v1.json")).expect("read fixture index");
    assert_eq!(
        sha256_hex(&index_bytes),
        INDEX_SHA256,
        "fixture index drift"
    );
    let index: Value = serde_json::from_slice(&index_bytes).expect("parse fixture index");
    let index = object(&index);
    assert_eq!(number(&index["fixture_shape_version"]), 5);
    assert_eq!(text(&index["readiness"]), "scaffold");
    assert_eq!(number(&index["opaque_blocks"]), 0);
    assert_eq!(text(&index["source_db_sha256"]), DB_SHA256);
    assert_eq!(text(&index["capture_13610_sha256"]), CAPTURE_SHA256);
    // The gateway owner's private snapshots are pinned per artifact, never as one
    // ambiguous "snapshot" hash; the capture hash must agree with ours.
    let gateway = object(&index["gateway_private_evidence"]);
    assert_eq!(
        text(&object(&gateway["13610-req-body"])["sha256"]),
        CAPTURE_SHA256
    );
    for artifact in [
        "mc_cache_state.json",
        "mc_compartments.json",
        "mc_tags.json",
    ] {
        assert_eq!(
            text(&object(&gateway[artifact])["sha256"]).len(),
            64,
            "{artifact}"
        );
    }

    let indexed_names = array(&index["files"])
        .iter()
        .map(|entry| text(&object(entry)["path"]).to_owned())
        .collect::<BTreeSet<_>>();
    let actual_names = fs::read_dir(&root)
        .expect("read fixture directory")
        .map(|entry| entry.expect("directory entry").file_name())
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| name != "fixture-index-v1.json")
        .collect::<BTreeSet<_>>();
    assert_eq!(
        indexed_names, actual_names,
        "index must cover every sibling file"
    );

    let email = Regex::new(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
        .expect("compile email scanner");
    let forbidden = ["~/", "/Users/", "sk-", "ghp_", "Bearer ", "ufukaltinok"];
    for entry in array(&index["files"]) {
        let entry = object(entry);
        let name = text(&entry["path"]);
        let bytes =
            fs::read(root.join(name)).unwrap_or_else(|error| panic!("read {name}: {error}"));
        assert_eq!(
            number(&entry["byte_size"]) as usize,
            bytes.len(),
            "{name} size"
        );
        assert_eq!(text(&entry["sha256"]), sha256_hex(&bytes), "{name} digest");
        if name == "canonical-json-vectors-v1.json" || name == "redeem-vectors-v1.json" {
            assert_eq!(entry["derived"], Value::Bool(false));
            let expected_source = if name == "canonical-json-vectors-v1.json" {
                "hand-written independent canonical-form vectors"
            } else {
                "owner-authored D5 redeem contract vectors"
            };
            assert_eq!(text(&entry["source"]), expected_source);
        } else {
            assert_eq!(entry["derived"], Value::Bool(true));
            assert_eq!(text(&entry["source"]), format!("VACUUM {DB_SHA256}"));
            assert_eq!(number(&entry["sanitized_members"]), 138);
            assert_eq!(
                array(&entry["verbatim_members"])
                    .iter()
                    .map(number)
                    .collect::<Vec<_>>(),
                vec![1824, 1864, 1927]
            );
        }

        let decoded = String::from_utf8_lossy(&bytes);
        for needle in forbidden {
            assert!(
                !decoded.contains(needle),
                "secret marker {needle:?} in {name}"
            );
        }
        assert!(!email.is_match(&decoded), "email-like text in {name}");
    }
}

#[test]
fn d5_fixture_canonical_json_matches_independent_vectors() {
    let vector_bytes = fs::read(fixture_dir().join("canonical-json-vectors-v1.json"))
        .expect("read canonical JSON vectors");
    assert_eq!(
        sha256_hex(&vector_bytes),
        CANONICAL_VECTORS_SHA256,
        "canonical JSON vectors drift"
    );
    let raw_document = serde_json::from_slice::<BTreeMap<String, Box<RawValue>>>(&vector_bytes)
        .expect("parse raw canonical JSON vector document");
    let raw_vectors = serde_json::from_str::<Vec<Box<RawValue>>>(raw_document["vectors"].get())
        .expect("parse raw canonical JSON vectors");
    let vectors: Value =
        serde_json::from_slice(&vector_bytes).expect("parse canonical JSON vector document");
    let vectors = object(&vectors);
    assert_eq!(number(&vectors["schema_version"]), 1);
    assert_eq!(
        text(&vectors["provenance"]),
        "hand-written independent canonical-form vectors; the numbered algorithm is normative and these vectors are conformance checks"
    );
    let rules = array(&vectors["normative_algorithm"]);
    assert_eq!(rules.len(), 9);
    for (index, rule) in rules.iter().enumerate() {
        assert_eq!(number(&object(rule)["rule"]), index as u64 + 1);
        assert!(!text(&object(rule)["text"]).is_empty());
    }
    let number_reference = object(&vectors["number_reference"]);
    assert_eq!(text(&number_reference["engine"]), "Node.js v22.23.1");
    assert!(text(&number_reference["n1"]).contains("BigInt"));
    assert!(text(&number_reference["n2"]).contains("JSON.stringify"));
    let vector_values = array(&vectors["vectors"]);
    assert_eq!(vector_values.len(), 31);
    assert_eq!(raw_vectors.len(), vector_values.len());
    for (vector, raw_vector) in vector_values.iter().zip(raw_vectors) {
        let vector = object(vector);
        let raw_fields = serde_json::from_str::<BTreeMap<String, Box<RawValue>>>(raw_vector.get())
            .expect("parse raw canonical JSON vector");
        let name = text(&vector["name"]);
        let expected = text(&vector["expected_utf8"]).as_bytes();
        assert_eq!(
            sha256_hex(expected),
            text(&vector["sha256"]),
            "independent vector digest {name}"
        );
        assert_eq!(
            canonical_raw_json_bytes(&raw_fields["input"]),
            expected,
            "canonical JSON vector {name}"
        );
        let reparsed = serde_json::from_slice::<Box<RawValue>>(expected)
            .expect("parse canonical vector output");
        assert_eq!(
            canonical_raw_json_bytes(&reparsed),
            expected,
            "canonical JSON vector output is idempotent {name}"
        );
    }

    let block_reference = object(&vectors["block_aware_reference"]);
    assert!(text(&block_reference["note"]).contains("(context, role, block)"));
    assert!(text(&block_reference["note"]).contains("anthropic_decode.rs:648-661"));
    assert!(text(&block_reference["result_block_kind"]).contains("Text, Media, Opaque"));
    assert!(text(&block_reference["parity_follow_up"]).contains("opencode.rs:719-738"));
    assert!(text(&block_reference["parity_follow_up"]).contains("pi.rs:845-892"));
    let boundary_table = array(&block_reference["decoder_boundary_table"]);
    assert_eq!(boundary_table.len(), 12);
    for row in boundary_table {
        assert!(text(&object(row)["decoder_cite"]).contains("anthropic_decode.rs:"));
    }
    let block_vectors = array(&vectors["block_aware_vectors"]);
    assert_eq!(block_vectors.len(), 18);
    for vector in block_vectors {
        let vector = object(vector);
        let name = text(&vector["name"]);
        let input = text(&vector["input_json"]);
        let context = decode_context(text(&vector["context"]));
        let role = text(&vector["role"]);
        let expected = text(&vector["expected_utf8"]).as_bytes();
        assert_eq!(
            sha256_hex(expected),
            text(&vector["sha256"]),
            "N4 digest {name}"
        );
        let raw = serde_json::from_str::<Box<RawValue>>(input).expect("parse raw N4 vector");
        assert_eq!(
            canonical_provider_block_bytes(context, role, raw.as_ref())
                .expect("canonicalize raw N4 vector"),
            expected,
            "N4 block-aware vector {name}"
        );
        let parsed: Value = serde_json::from_str(input).expect("parse N4 provider block");
        let (kind, _, _) = lift_provider_block_for_contract(context, role, parsed.clone());
        assert_eq!(
            kind,
            text(&vector["expected_kind"]),
            "N4 decoded kind {name}"
        );
        if let Some(raw_withheld) = vector.get("raw_withheld") {
            let raw_withheld = object(raw_withheld);
            assert_eq!(text(&raw_withheld["expected"]), "refusal");
            assert_eq!(raw_withheld["expected_utf8"], Value::Null);
            let error = canonical_provider_block_without_raw(context, role, &parsed)
                .expect_err("opaque descendant without raw bytes must refuse");
            assert!(
                error.contains(text(&raw_withheld["error_contains"])),
                "N4 raw-withheld refusal identity {name}: {error}"
            );
        }
    }

    let opaque = object(&vectors["opaque_control"]);
    assert_eq!(text(&opaque["expected_kind"]), "opaque");
    assert_eq!(
        text(&opaque["note"]),
        "Opaque raw bytes preserve whitespace, key order, escape spelling, exponent spelling, and every field and value."
    );
    let input = text(&opaque["input_json"]).as_bytes();
    let expected = text(&opaque["expected_utf8"]).as_bytes();
    assert_eq!(sha256_hex(expected), text(&opaque["sha256"]));
    let parsed: Value = serde_json::from_slice(input).expect("parse opaque control");
    assert_eq!(
        text(&object(&parsed)["type"]),
        "future_kind",
        "opaque control kind"
    );
    assert_eq!(input, expected, "opaque provider bytes must remain exact");
}

fn lift_provider_block_for_contract(
    context: DecodeContext,
    role: &str,
    block: Value,
) -> (String, Map<String, Value>, Map<String, Value>) {
    let kind = contract_kind(context, role, &block);
    if kind == "opaque" {
        return ("opaque".to_owned(), object(&block).clone(), Map::new());
    }
    let mut payload = object(&block).clone();
    let mut lifted = Map::new();
    if context == DecodeContext::TopLevel {
        for key in ["type", "id", "tool_use_id"] {
            if let Some(value) = payload.remove(key) {
                lifted.insert(key.to_owned(), value);
            }
        }
    }
    (kind.to_owned(), payload, lifted)
}

#[test]
fn d5_fixture_lifting_preserves_extensions_and_opaque_blocks() {
    let provider = serde_json::json!({
        "type": "text",
        "id": "provider-id",
        "text": "visible",
        "vendor_extension": {"array": [true, 7, null]}
    });
    let (kind, payload, lifted) =
        lift_provider_block_for_contract(DecodeContext::TopLevel, "assistant", provider);
    assert_eq!(kind, "text");
    assert_eq!(
        lifted,
        serde_json::from_value(serde_json::json!({
            "id": "provider-id",
            "type": "text"
        }))
        .expect("lifted provider fields")
    );
    assert_eq!(
        payload,
        serde_json::from_value(serde_json::json!({
            "text": "visible",
            "vendor_extension": {"array": [true, 7, null]}
        }))
        .expect("known provider payload")
    );
    let payload_bytes = canonical_json_bytes(&Value::Object(payload.clone()));
    assert_eq!(
        serde_json::from_slice::<Value>(&payload_bytes).expect("known provider round trip"),
        Value::Object(payload)
    );

    let opaque = serde_json::json!({
        "type": "future_provider_block",
        "id": "opaque-id",
        "tool_use_id": "opaque-tool-id",
        "extension": {"nested": ["unchanged"]}
    });
    let (kind, payload, lifted) =
        lift_provider_block_for_contract(DecodeContext::TopLevel, "assistant", opaque.clone());
    assert_eq!(kind, "opaque");
    assert!(lifted.is_empty());
    assert_eq!(Value::Object(payload), opaque);
}

#[test]
fn d5_fixture_preserves_measured_tail_geometry_without_private_text() {
    let root = fixture_dir();
    let source = parse_json(&root.join("source-segment-v1.json"));
    let source = object(&source);
    assert_eq!(number(&source["normalization_version"]), 1);
    assert_eq!(
        source["excluded_additions"],
        serde_json::json!([{
            "kind": "recognized_compaction",
            "addition_kind": "claude_code_compaction_instruction"
        }])
    );

    let index = parse_json(&root.join("fixture-index-v1.json"));
    let index = object(&index);
    assert_eq!(
        index["length_preservation"],
        serde_json::json!({"both": 188, "decoded_only": 0, "encoded_only": 0})
    );
    let members = array(&index["members"]);
    let messages = array(&source["messages"]);
    assert_eq!(messages.len(), 141);
    assert_eq!(members.len(), 141);

    let mut roles = BTreeMap::<&str, usize>::new();
    let mut kinds = BTreeMap::<&str, usize>::new();
    let mut kind_sources = BTreeMap::<&str, usize>::new();
    let mut tool_result_content_shapes =
        BTreeMap::from([("array", 0), ("object", 0), ("string", 0)]);
    let mut block_count = 0;
    for (offset, (message, member)) in messages.iter().zip(members).enumerate() {
        let ordinal = 1799 + offset as u64;
        let position = 64 + offset as u64;
        let message = object(message);
        let member = object(member);
        assert_eq!(number(&message["ordinal"]), ordinal);
        assert_eq!(number(&message["position"]), position);
        assert_eq!(text(&message["mid"]), format!("ccm-{ordinal}"));
        assert_eq!(number(&member["ordinal"]), ordinal);
        assert_eq!(text(&member["length_source"]), "capture_13610");
        assert_eq!(text(&member["tool_links_source"]), "capture_13610");
        assert_eq!(text(&member["geometry"]), "measured");
        *kind_sources
            .entry(text(&member["kinds_source"]))
            .or_default() += 1;
        *roles.entry(text(&message["role"])).or_default() += 1;

        let blocks = array(&message["blocks"]);
        assert_eq!(number(&member["block_count"]) as usize, blocks.len());
        let block_kinds = array(&member["block_kinds"]);
        let block_byte_lengths = array(&member["block_byte_lengths"]);
        let block_string_byte_lengths = array(&member["block_string_byte_lengths"]);
        let block_length_preservation = array(&member["block_length_preservation"]);
        assert_eq!(block_kinds.len(), blocks.len());
        assert_eq!(block_byte_lengths.len(), blocks.len());
        assert_eq!(block_string_byte_lengths.len(), blocks.len());
        assert_eq!(block_length_preservation.len(), blocks.len());
        assert!(block_length_preservation
            .iter()
            .all(|value| text(value) == "both"));
        block_count += blocks.len();
        let mut member_length = 0;
        let probe = PROBES
            .iter()
            .find(|(probe_ordinal, _)| *probe_ordinal == ordinal);
        let mut probe_hits = 0;
        for (expected_index, block) in blocks.iter().enumerate() {
            let block = object(block);
            let block_index = number(&block["index"]);
            assert_eq!(block_index as usize, expected_index);
            let kind = text(&block["kind"]);
            assert_eq!(text(&block_kinds[expected_index]), kind);
            *kinds.entry(kind).or_default() += 1;
            let bytes = decode_base64(text(&block["bytes"]));
            assert_eq!(
                bytes.len() as u64,
                number(&block_byte_lengths[expected_index]),
                "original block length at {ordinal}#{block_index}"
            );
            member_length += bytes.len();

            let payload: Value = serde_json::from_slice(&bytes).unwrap_or_else(|error| {
                panic!("provider block JSON at {ordinal}#{block_index}: {error}")
            });
            if kind != "opaque" {
                assert_eq!(
                    canonical_json_bytes(&payload),
                    bytes,
                    "known provider block must use pinned canonical JSON at {ordinal}#{block_index}"
                );
            }
            assert_eq!(
                string_byte_lengths(&payload),
                array(&block_string_byte_lengths[expected_index])
                    .iter()
                    .map(number)
                    .collect::<Vec<_>>(),
                "decoded string UTF-8 lengths at {ordinal}#{block_index}"
            );
            let payload = object(&payload);
            assert_recoverable_block_kind(kind, payload);
            if kind == "tool_result" {
                let shape = if payload["content"].is_array() {
                    "array"
                } else if payload["content"].is_object() {
                    "object"
                } else {
                    "string"
                };
                *tool_result_content_shapes.entry(shape).or_default() += 1;
            }
            if kind != "opaque" {
                let mut leaf_index = 0;
                probe_hits += assert_synthetic_string_values(
                    &Value::Object(payload.clone()),
                    ordinal,
                    block_index,
                    probe.map(|(_, probe)| *probe),
                    &mut leaf_index,
                );
            }
        }
        assert_eq!(member_length as u64, number(&member["source_byte_length"]));
        assert_eq!(
            probe_hits,
            usize::from(probe.is_some()),
            "probe member {ordinal}"
        );

        let decoded_member = blocks
            .iter()
            .flat_map(|block| decode_base64(text(&object(block)["bytes"])))
            .collect::<Vec<_>>();
        for (probe_ordinal, probe) in PROBES {
            let occurrences = decoded_member
                .windows(probe.len())
                .filter(|window| *window == probe.as_bytes())
                .count();
            assert_eq!(
                occurrences,
                usize::from(probe_ordinal == ordinal),
                "probe leakage at ordinal {ordinal}"
            );
        }
    }

    assert_eq!(block_count, 188);
    assert_eq!(
        roles,
        BTreeMap::from([("assistant", 70), ("system", 1), ("user", 70)])
    );
    assert_eq!(
        kinds,
        BTreeMap::from([
            ("reasoning", 38),
            ("text", 18),
            ("tool_result", 66),
            ("tool_use", 66),
        ])
    );
    assert_eq!(
        kind_sources,
        BTreeMap::from([("capture_13610", 58), ("db", 83)])
    );
    assert_eq!(
        tool_result_content_shapes,
        BTreeMap::from([("array", 31), ("object", 0), ("string", 35)])
    );
}

#[test]
fn d5_fixture_private_source_run_rejection_when_available() {
    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("repository root");
    let db_path =
        repo_root.join(".cortexkit/alfonso/reviews/d5-uncovered-tail-2026-09-11/d5-specimen.db");
    if !db_path.is_file() {
        eprintln!(
            "SKIP d5_fixture_private_source_run_rejection_when_available: private source DB absent"
        );
        return;
    }
    let db_bytes = fs::read(&db_path).expect("read private source DB");
    assert_eq!(sha256_hex(&db_bytes), DB_SHA256, "private source DB drift");
    let connection = Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("open private source DB read-only");
    let mut states = connection
        .prepare("SELECT session_id, meta FROM mc_cache_state")
        .expect("prepare predecessor lookup");
    let candidates = states
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .expect("query predecessor states")
        .filter_map(Result::ok)
        .filter(|(_, meta)| {
            serde_json::from_str::<Value>(meta).is_ok_and(|meta| {
                let meta = object(&meta);
                meta.get("coverage_ordinal").and_then(Value::as_u64) == Some(1798)
                    && meta.get("newest_live_ordinal").and_then(Value::as_u64) == Some(1939)
            })
        })
        .collect::<Vec<_>>();
    assert_eq!(candidates.len(), 1, "one private D5 predecessor");
    let session_id = &candidates[0].0;
    let mut tag_query = connection
        .prepare("SELECT block_id, source_bytes FROM mc_tags WHERE session_id=?1")
        .expect("prepare private tag lookup");
    let rows = tag_query
        .query_map([session_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
        })
        .expect("query private source tags");

    let approved_windows = PROBES
        .iter()
        .flat_map(|(_, probe)| probe.as_bytes().windows(20).map(<[u8]>::to_vec))
        .collect::<HashSet<_>>();
    let mut forbidden_windows = HashSet::new();
    for row in rows {
        let (block_id, source) = row.expect("private source tag row");
        let ordinal = block_id
            .strip_prefix("ccm-")
            .and_then(|value| value.split_once('#'))
            .and_then(|(ordinal, _)| ordinal.parse::<u64>().ok());
        if !ordinal.is_some_and(|ordinal| (1799..=1939).contains(&ordinal)) {
            continue;
        }
        forbidden_windows.extend(
            source
                .windows(20)
                .filter(|window| !approved_windows.contains(*window))
                .map(<[u8]>::to_vec),
        );
    }
    assert!(
        !forbidden_windows.is_empty(),
        "private source rejection set"
    );

    let source = parse_json(&fixture_dir().join("source-segment-v1.json"));
    for message in array(&object(&source)["messages"]) {
        let ordinal = number(&object(message)["ordinal"]);
        for block in array(&object(message)["blocks"]) {
            let block = object(block);
            let block_index = number(&block["index"]);
            let bytes = decode_base64(text(&block["bytes"]));
            let payload: Value = serde_json::from_slice(&bytes).expect("provider block JSON");
            fn reject_private_runs(
                value: &Value,
                forbidden_windows: &HashSet<Vec<u8>>,
                ordinal: u64,
                block_index: u64,
                probe: Option<&str>,
            ) {
                match value {
                    Value::Object(fields) => fields.values().for_each(|value| {
                        reject_private_runs(value, forbidden_windows, ordinal, block_index, probe)
                    }),
                    Value::Array(items) => items.iter().for_each(|value| {
                        reject_private_runs(value, forbidden_windows, ordinal, block_index, probe)
                    }),
                    Value::String(value) => {
                        let probe_range = probe.and_then(|probe| {
                            value.find(probe).map(|start| start..start + probe.len())
                        });
                        assert!(
                            value
                                .as_bytes()
                                .windows(20)
                                .enumerate()
                                .all(|(offset, window)| {
                                    let overlaps_probe =
                                        probe_range.as_ref().is_some_and(|range| {
                                            offset < range.end
                                                && offset + window.len() > range.start
                                        });
                                    overlaps_probe || !forbidden_windows.contains(window)
                                }),
                            "private 20-byte source-text run survived at {ordinal}#{block_index}"
                        );
                    }
                    _ => {}
                }
            }
            let probe = PROBES
                .iter()
                .find(|(probe_ordinal, _)| *probe_ordinal == ordinal)
                .map(|(_, probe)| *probe);
            reject_private_runs(&payload, &forbidden_windows, ordinal, block_index, probe);
        }
    }
}

#[test]
fn d5_fixture_tool_pairing_is_closed_with_deterministic_ids() {
    let source = parse_json(&fixture_dir().join("source-segment-v1.json"));
    let mut arcs =
        BTreeMap::<String, ((String, u64, u64), (String, u64, u64), usize, usize)>::new();
    for message in array(&object(&source)["messages"]) {
        for block in array(&object(message)["blocks"]) {
            let block = object(block);
            let links = array(&block["tool_links"]);
            let kind = text(&block["kind"]);
            if !matches!(kind, "tool_use" | "tool_result") {
                assert!(links.is_empty(), "non-tool blocks cannot carry tool arcs");
                continue;
            }
            assert_eq!(links.len(), 1, "each tool block has one closed arc");
            let link = object(&links[0]);
            let id = text(&link["tool_use_id"]).to_owned();
            assert!(id.starts_with("toolu_d5_"));
            let use_identity = identity_tuple(&link["use_identity"]);
            let result_identity = identity_tuple(&link["result_identity"]);
            let entry =
                arcs.entry(id)
                    .or_insert((use_identity.clone(), result_identity.clone(), 0, 0));
            assert_eq!(entry.0, use_identity);
            assert_eq!(entry.1, result_identity);
            if kind == "tool_use" {
                assert_eq!(
                    identity_tuple(&link["use_identity"]),
                    identity_tuple_from_block(message, block)
                );
                entry.2 += 1;
            } else {
                assert_eq!(
                    identity_tuple(&link["result_identity"]),
                    identity_tuple_from_block(message, block)
                );
                entry.3 += 1;
            }
        }
    }
    assert_eq!(arcs.len(), 66);
    assert!(arcs
        .values()
        .all(|(_, _, uses, results)| (*uses, *results) == (1, 1)));
}

fn identity_tuple_from_block(message: &Value, block: &Map<String, Value>) -> (String, u64, u64) {
    let message = object(message);
    (
        text(&message["mid"]).to_owned(),
        number(&block["index"]),
        number(&message["ordinal"]),
    )
}

#[test]
fn d5_fixture_manifest_and_archive_are_explicit_pending_scaffolds() {
    let root = fixture_dir();
    let manifest = parse_json(&root.join("expected-manifest-v1.json"));
    let archive = parse_json(&root.join("expected-archive-v1.json"));
    assert_eq!(object(&manifest)["digests_pending"], Value::Bool(true));
    assert_eq!(object(&archive)["digests_pending"], Value::Bool(true));
    assert_eq!(text(&object(&archive)["archive_id"]), DIGEST_PLACEHOLDER);

    let mut manifest_body = manifest.clone();
    object_mut(&mut manifest_body).remove("digests_pending");
    assert_eq!(object(&archive)["manifest"], manifest_body);
    assert_pending_digests(&manifest);
    assert_pending_digests(&archive);

    let manifest_messages = array(&object(&manifest)["messages"]);
    let projected = array(&object(&archive)["V"]);
    assert_eq!(manifest_messages.len(), 141);
    assert_eq!(projected.len(), 141);
    for (manifest_message, projected_message) in manifest_messages.iter().zip(projected) {
        let projected_message: Value =
            serde_json::from_slice(&decode_base64(text(projected_message)))
                .expect("projected message JSON");
        let manifest_message = object(manifest_message);
        let projected_message = object(&projected_message);
        assert_eq!(projected_message["ordinal"], manifest_message["ordinal"]);
        assert_eq!(projected_message["role"], manifest_message["role"]);
        assert_eq!(
            array(&projected_message["blocks"]).len(),
            array(&manifest_message["blocks"]).len()
        );
        for (projected_block, manifest_block) in array(&projected_message["blocks"])
            .iter()
            .zip(array(&manifest_message["blocks"]))
        {
            let projected_block = object(projected_block);
            let manifest_block = object(manifest_block);
            assert_eq!(projected_block["index"], manifest_block["index"]);
            assert_eq!(projected_block["kind"], manifest_block["kind"]);
            assert_eq!(projected_block["tool_links"], manifest_block["tool_links"]);
            assert_eq!(
                decode_base64(text(&projected_block["bytes"])).len() as u64,
                number(&object(&manifest_block["served"])["len"])
            );
        }
    }

    let applied = object(&archive)["A"]
        .as_object()
        .expect("applied state object");
    assert_eq!(number(&applied["schema_version"]), 1);
    let payload: Value =
        serde_json::from_slice(&decode_base64(text(&applied["canonical_payload"])))
            .expect("applied-state scaffold JSON");
    let payload = object(&payload);
    assert_eq!(array(&payload["units"]).len(), 17);
    assert_eq!(array(&payload["tags"]).len(), 83);
    assert_eq!(array(&payload["drops"]).len(), 29);
    assert_eq!(array(&payload["ledger"]).len(), 1);
    assert!(!contains_key(
        &Value::Object(payload.clone()),
        "token_count"
    ));
}

fn object_mut(value: &mut Value) -> &mut Map<String, Value> {
    value.as_object_mut().expect("expected mutable JSON object")
}

fn assert_pending_digests(value: &Value) {
    match value {
        Value::Object(fields) => {
            for (key, child) in fields {
                if key == "sha256" || key == "archive_id" {
                    assert_eq!(
                        text(child),
                        DIGEST_PLACEHOLDER,
                        "pending digest field {key}"
                    );
                } else {
                    assert_pending_digests(child);
                }
            }
        }
        Value::Array(items) => items.iter().for_each(assert_pending_digests),
        _ => {}
    }
}

fn contains_key(value: &Value, needle: &str) -> bool {
    match value {
        Value::Object(fields) => {
            fields.contains_key(needle) || fields.values().any(|value| contains_key(value, needle))
        }
        Value::Array(items) => items.iter().any(|value| contains_key(value, needle)),
        _ => false,
    }
}
