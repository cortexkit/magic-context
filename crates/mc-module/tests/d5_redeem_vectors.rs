use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

const RECEIPT_ID: &str = "0f5c2d7e-1234-4abc-8def-0123456789ab";
const SEALED_TOKEN: &str = "aaisem2ekvthpcezvk5q";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Fixture {
    schema: String,
    encoding_rule: EncodingRule,
    serde_evidence: Vec<SerdeEvidence>,
    sealed_scope: SealedScope,
    token_values: Vec<TokenValue>,
    precedence_table: Vec<PrecedenceRow>,
    vectors: Vec<Vector>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EncodingRule {
    lineage_request: String,
    lineage_response: String,
    nested_unions: String,
    implementation_status: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SerdeEvidence {
    path: String,
    lines: String,
    finding: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SealedScope {
    receipt_id: String,
    recognition_token: String,
    stored_edge: LineageEdge,
    fence_generation: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TokenValue {
    recognition_token: String,
    input_96_bits_hex: String,
    round_trip_matches_input: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PrecedenceRow {
    row_id: String,
    priority: u64,
    preconditions: Preconditions,
    expected_variant: String,
    expected_reason_or_cause: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Preconditions {
    scope_state: String,
    observation_class: String,
    candidate_relation: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Vector {
    id: String,
    name: String,
    scope_state: ScopeState,
    scanned_material: ScannedMaterial,
    request: Value,
    expected: Value,
    precedence_row: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ScannedMaterial {
    source_text: Option<String>,
    scanned_bytes_sha256: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
enum ScopeState {
    #[serde(rename = "SEALED")]
    Sealed,
    #[serde(rename = "REDEEMED")]
    Redeemed,
    #[serde(rename = "absent")]
    Absent,
}

impl ScopeState {
    fn wire_name(self) -> &'static str {
        match self {
            Self::Sealed => "SEALED",
            Self::Redeemed => "REDEEMED",
            Self::Absent => "absent",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase", deny_unknown_fields)]
enum LineageRequest {
    Redeem {
        #[serde(rename = "P")]
        predecessor_key: String,
        agent: String,
        incarnation: u64,
        observation: RecognitionObservation,
        candidate: Option<SuccessorCandidate>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase", deny_unknown_fields)]
enum LineageResponse {
    Redeem { result: RedeemResult },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RecognitionObservation {
    scanned_identity: Option<BlockIdentity>,
    scanned_bytes_sha256: Option<String>,
    scanned_role: Option<Role>,
    scanned_kind: Option<BlockKind>,
    native_user_index: Option<u64>,
    scan_source: ScanSource,
    observed_markers: Vec<ObservedMarker>,
    may_have_replied: bool,
    ack: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Role {
    User,
    Assistant,
    System,
    Tool,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum BlockKind {
    Text,
    Reasoning,
    RedactedReasoning,
    ToolUse,
    ToolResult,
    Image,
    Document,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum ScanSource {
    DirectScalar,
    TextBlock,
    ToolResult,
    NoCandidateBlock,
    Other { source: String },
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum ObservedMarker {
    Valid { identity: RecognitionIdentity },
    Malformed { token_prefix: String },
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct RecognitionIdentity {
    receipt_id: String,
    recognition_token: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct SuccessorCandidate {
    successor_key: String,
    native_continuation_identity: BlockIdentity,
    continuation_identity: RecognitionIdentity,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct BlockIdentity {
    mid: String,
    index: u64,
    ordinal: u64,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
enum RedeemResult {
    #[serde(rename = "REDEEMED")]
    Redeemed {
        receipt_id: String,
        edge: LineageEdge,
        existing: bool,
        fence_generation: u64,
    },
    #[serde(rename = "UNRECOGNIZED")]
    Unrecognized {
        receipt_id: String,
        cause: UnrecognizedCause,
    },
    #[serde(rename = "REFUSED")]
    Refused { refusal: Refusal },
    #[serde(rename = "lineage_corrupt")]
    LineageCorrupt { receipt_id: String },
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum UnrecognizedCause {
    NoCandidateBlock,
    NoMarker,
    MalformedMarker,
    DuplicateMarker,
    ForeignMarker,
}

impl UnrecognizedCause {
    fn wire_name(self) -> &'static str {
        match self {
            Self::NoCandidateBlock => "no_candidate_block",
            Self::NoMarker => "no_marker",
            Self::MalformedMarker => "malformed_marker",
            Self::DuplicateMarker => "duplicate_marker",
            Self::ForeignMarker => "foreign_marker",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Refusal {
    reason: RefusalReason,
    receipt_id: Option<String>,
    details: RefusalDetails,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum RefusalReason {
    InvalidArguments,
    TicketInvalid,
    StaleIncarnation,
    BudgetUnknown,
    BudgetModelMismatch,
    BudgetEvidenceMismatch,
    TokenCap,
    ByteCap,
    PAlreadySealed,
    SealMaterialMismatch,
    ResolvedAbsent,
    SealAfterTombstone,
    SealAfterResolve,
    AttemptQuota,
    SealedUnredeemed,
    LineageCorrupt,
    SuccessorOverflow,
    AlreadyRedeemed,
    InvalidTerminalState,
    UploadDeclarationConflict,
    ChunkConflict,
    UploadDigestMismatch,
    UploadIncomplete,
    UploadQuota,
    D5ReceiptRequired,
    D5DowngradeRefused,
}

impl RefusalReason {
    fn wire_name(self) -> &'static str {
        match self {
            Self::InvalidArguments => "invalid_arguments",
            Self::TicketInvalid => "ticket_invalid",
            Self::StaleIncarnation => "stale_incarnation",
            Self::BudgetUnknown => "budget_unknown",
            Self::BudgetModelMismatch => "budget_model_mismatch",
            Self::BudgetEvidenceMismatch => "budget_evidence_mismatch",
            Self::TokenCap => "token_cap",
            Self::ByteCap => "byte_cap",
            Self::PAlreadySealed => "p_already_sealed",
            Self::SealMaterialMismatch => "seal_material_mismatch",
            Self::ResolvedAbsent => "resolved_absent",
            Self::SealAfterTombstone => "seal_after_tombstone",
            Self::SealAfterResolve => "seal_after_resolve",
            Self::AttemptQuota => "attempt_quota",
            Self::SealedUnredeemed => "sealed_unredeemed",
            Self::LineageCorrupt => "lineage_corrupt",
            Self::SuccessorOverflow => "successor_overflow",
            Self::AlreadyRedeemed => "already_redeemed",
            Self::InvalidTerminalState => "invalid_terminal_state",
            Self::UploadDeclarationConflict => "upload_declaration_conflict",
            Self::ChunkConflict => "chunk_conflict",
            Self::UploadDigestMismatch => "upload_digest_mismatch",
            Self::UploadIncomplete => "upload_incomplete",
            Self::UploadQuota => "upload_quota",
            Self::D5ReceiptRequired => "d5_receipt_required",
            Self::D5DowngradeRefused => "d5_downgrade_refused",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum RefusalDetails {
    None,
    Field {
        field: String,
        reason: String,
    },
    Winner {
        receipt_id: String,
    },
    ResolvedAbsent {
        attempt_id: String,
        incarnation: u64,
    },
    Cap {
        cap: String,
        actual: u64,
        limit: u64,
        units: String,
    },
    Upload {
        upload_id: Option<String>,
        seq: Option<u64>,
        declared_digest: Option<String>,
        actual_digest: Option<String>,
    },
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct LineageEdge {
    edge_id: String,
    predecessor_key: String,
    successor_key: String,
    agent: String,
    #[serde(rename = "F")]
    fingerprint: MaterialFingerprint,
    lineage_id: String,
    continuation_identity: RecognitionIdentity,
    native_continuation_identity: BlockIdentity,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct MaterialFingerprint {
    digest: String,
    normalization_version: u64,
    excluded_additions: Vec<Value>,
}

#[derive(Debug, PartialEq, Eq)]
struct OutcomeSignature<'a> {
    variant: &'static str,
    reason_or_cause: Option<&'a str>,
}

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("d5-specimen")
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn hex_96(value: &str) -> Result<[u8; 12], String> {
    if value.len() != 24 {
        return Err("96-bit input must contain 24 hex characters".to_string());
    }
    let mut decoded = [0_u8; 12];
    for (index, output) in decoded.iter_mut().enumerate() {
        *output = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
            .map_err(|_| "96-bit input contains non-hex characters".to_string())?;
    }
    Ok(decoded)
}

fn encode_base32_96(input: &[u8; 12]) -> String {
    const ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
    let mut accumulator = 0_u32;
    let mut bits = 0_u8;
    let mut output = String::with_capacity(20);
    for byte in input {
        accumulator = (accumulator << 8) | u32::from(*byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            output.push(ALPHABET[((accumulator >> bits) & 0x1f) as usize] as char);
        }
    }
    if bits > 0 {
        output.push(ALPHABET[((accumulator << (5 - bits)) & 0x1f) as usize] as char);
    }
    output
}

fn decode_base32_96(token: &str) -> Result<[u8; 12], String> {
    if token.len() != 20 {
        return Err("recognition token must be 20 bytes".to_string());
    }
    let mut accumulator = 0_u32;
    let mut bits = 0_u8;
    let mut output = Vec::with_capacity(12);
    for byte in token.bytes() {
        let value = match byte {
            b'a'..=b'z' => byte - b'a',
            b'2'..=b'7' => byte - b'2' + 26,
            _ => return Err("recognition token is not lowercase RFC4648 base32".to_string()),
        };
        accumulator = (accumulator << 5) | u32::from(value);
        bits += 5;
        while bits >= 8 {
            bits -= 8;
            output.push(((accumulator >> bits) & 0xff) as u8);
        }
    }
    if bits != 4 || accumulator & ((1_u32 << bits) - 1) != 0 {
        return Err("recognition token has non-zero canonical padding bits".to_string());
    }
    output
        .try_into()
        .map_err(|_| "recognition token does not decode to 96 bits".to_string())
}

fn valid_uuid36(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase(),
        })
}

fn parse_marker(marker: &str) -> Result<RecognitionIdentity, String> {
    if marker.starts_with("mc-d5:") {
        return Err("marker is missing its required leading space".to_string());
    }
    if marker.len() != 64 {
        return Err("marker must be 64 bytes including its leading space".to_string());
    }
    let rest = marker
        .strip_prefix(" mc-d5:")
        .ok_or_else(|| "marker must begin with a leading space and mc-d5:".to_string())?;
    let (receipt_id, recognition_token) = rest
        .split_once(':')
        .ok_or_else(|| "marker must separate receipt and token".to_string())?;
    if !valid_uuid36(receipt_id) {
        return Err("marker receipt is not lowercase UUID36".to_string());
    }
    let decoded = decode_base32_96(recognition_token)?;
    if encode_base32_96(&decoded) != recognition_token {
        return Err("recognition token is not canonical".to_string());
    }
    Ok(RecognitionIdentity {
        receipt_id: receipt_id.to_string(),
        recognition_token: recognition_token.to_string(),
    })
}

fn observation_class(observation: &RecognitionObservation, sealed: &SealedScope) -> &'static str {
    if observation.scan_source == ScanSource::NoCandidateBlock {
        return "no_candidate_block";
    }
    if observation.observed_markers.is_empty() {
        return "no_marker";
    }
    if observation
        .observed_markers
        .iter()
        .any(|marker| matches!(marker, ObservedMarker::Malformed { .. }))
    {
        return "malformed_marker";
    }
    let valid = observation
        .observed_markers
        .iter()
        .filter_map(|marker| match marker {
            ObservedMarker::Valid { identity } => Some(identity),
            ObservedMarker::Malformed { .. } => None,
        })
        .collect::<Vec<_>>();
    if valid.len() != 1 {
        return "duplicate_marker";
    }
    if valid[0].receipt_id != sealed.receipt_id {
        return "foreign_marker";
    }
    if valid[0].recognition_token != sealed.recognition_token {
        return "same_receipt_wrong_token";
    }
    "single_valid_stored_marker"
}

fn is_negative_observation(class: &str) -> bool {
    matches!(
        class,
        "no_candidate_block"
            | "no_marker"
            | "malformed_marker"
            | "duplicate_marker"
            | "foreign_marker"
    )
}

fn candidate_relation(
    scope: ScopeState,
    observation: &RecognitionObservation,
    candidate: Option<&SuccessorCandidate>,
    sealed: &SealedScope,
) -> &'static str {
    let Some(candidate) = candidate else {
        return "absent";
    };
    if scope == ScopeState::Redeemed {
        return if candidate.successor_key == sealed.stored_edge.successor_key
            && candidate.native_continuation_identity
                == sealed.stored_edge.native_continuation_identity
            && candidate.continuation_identity == sealed.stored_edge.continuation_identity
        {
            "stored_edge_equal"
        } else {
            "different"
        };
    }
    let observed_identity = observation
        .observed_markers
        .iter()
        .find_map(|marker| match marker {
            ObservedMarker::Valid { identity } => Some(identity),
            ObservedMarker::Malformed { .. } => None,
        });
    if let Some(observed_identity) = observed_identity {
        if candidate.continuation_identity != *observed_identity {
            return "continuation_identity_mismatch";
        }
        if observation.scanned_identity.as_ref() != Some(&candidate.native_continuation_identity) {
            return "native_identity_mismatch";
        }
        return "observation_consistent";
    }
    "present"
}

fn row_matches(row: &PrecedenceRow, scope: ScopeState, observation: &str, candidate: &str) -> bool {
    let scope_matches = row.preconditions.scope_state == "any"
        || row.preconditions.scope_state == scope.wire_name();
    let observation_matches = row.preconditions.observation_class == "any"
        || row.preconditions.observation_class == observation
        || (row.preconditions.observation_class == "negative"
            && is_negative_observation(observation));
    let candidate_matches = row.preconditions.candidate_relation == "any"
        || row.preconditions.candidate_relation == candidate
        || (row.preconditions.candidate_relation == "present" && candidate != "absent");
    scope_matches && observation_matches && candidate_matches
}

fn outcome_signature(result: &RedeemResult) -> OutcomeSignature<'_> {
    match result {
        RedeemResult::Redeemed {
            receipt_id,
            edge,
            existing,
            fence_generation,
        } => {
            assert!(valid_uuid36(receipt_id));
            assert!(valid_uuid36(&edge.edge_id));
            assert!(valid_uuid36(&edge.lineage_id));
            assert!(!edge.predecessor_key.is_empty());
            assert!(!edge.successor_key.is_empty());
            assert!(!edge.agent.is_empty());
            assert_eq!(edge.fingerprint.digest.len(), 64);
            assert_eq!(edge.fingerprint.normalization_version, 1);
            assert!(edge.fingerprint.excluded_additions.is_empty());
            assert!(edge.native_continuation_identity.ordinal > 0);
            assert!(*fence_generation > 0);
            let _ = existing;
            OutcomeSignature {
                variant: "REDEEMED",
                reason_or_cause: None,
            }
        }
        RedeemResult::Unrecognized { receipt_id, cause } => {
            assert!(valid_uuid36(receipt_id));
            OutcomeSignature {
                variant: "UNRECOGNIZED",
                reason_or_cause: Some(cause.wire_name()),
            }
        }
        RedeemResult::Refused { refusal } => {
            if let Some(receipt_id) = &refusal.receipt_id {
                assert!(valid_uuid36(receipt_id));
            }
            match &refusal.details {
                RefusalDetails::None => {}
                RefusalDetails::Field { field, reason } => {
                    assert!(!field.is_empty());
                    assert!(!reason.is_empty());
                }
                RefusalDetails::Winner { receipt_id } => assert!(valid_uuid36(receipt_id)),
                RefusalDetails::ResolvedAbsent {
                    attempt_id,
                    incarnation,
                } => {
                    assert!(!attempt_id.is_empty());
                    assert!(*incarnation > 0);
                }
                RefusalDetails::Cap {
                    cap,
                    actual,
                    limit,
                    units,
                } => {
                    assert!(!cap.is_empty());
                    assert!(!units.is_empty());
                    assert!(actual >= limit);
                }
                RefusalDetails::Upload {
                    upload_id,
                    seq,
                    declared_digest,
                    actual_digest,
                } => {
                    assert!(upload_id.is_some() || seq.is_some());
                    assert!(declared_digest.is_some() || actual_digest.is_some());
                }
            }
            OutcomeSignature {
                variant: "REFUSED",
                reason_or_cause: Some(refusal.reason.wire_name()),
            }
        }
        RedeemResult::LineageCorrupt { receipt_id } => {
            assert!(valid_uuid36(receipt_id));
            OutcomeSignature {
                variant: "lineage_corrupt",
                reason_or_cause: None,
            }
        }
    }
}

fn assert_marker_and_digest_provenance(
    vector: &Vector,
    observation: &RecognitionObservation,
    token_inputs: &BTreeMap<&str, [u8; 12]>,
) {
    assert_eq!(
        observation.scanned_bytes_sha256, vector.scanned_material.scanned_bytes_sha256,
        "{} digest provenance disagrees with request",
        vector.id
    );
    match &vector.scanned_material.source_text {
        Some(source_text) if observation.scanned_identity.is_some() => {
            let digest = sha256_hex(source_text.as_bytes());
            assert_eq!(
                observation.scanned_bytes_sha256.as_deref(),
                Some(digest.as_str()),
                "{} scanned digest is not the source_text SHA-256",
                vector.id
            );
        }
        Some(source_text) => {
            assert!(
                source_text.is_empty(),
                "{} unscanned source must be empty",
                vector.id
            );
            assert!(observation.scanned_bytes_sha256.is_none());
        }
        None => assert!(observation.scanned_bytes_sha256.is_none()),
    }

    if observation.scan_source == ScanSource::NoCandidateBlock {
        assert!(observation.scanned_identity.is_none());
        assert!(observation.scanned_bytes_sha256.is_none());
        assert!(observation.scanned_kind.is_none());
        match vector.scanned_material.source_text.as_deref() {
            Some("") => {
                assert_eq!(observation.scanned_role, Some(Role::User));
                assert_eq!(observation.native_user_index, Some(0));
            }
            None => {
                assert!(observation.scanned_role.is_none());
                assert!(observation.native_user_index.is_none());
            }
            Some(_) => panic!("{} invalid no_candidate_block source", vector.id),
        }
    } else {
        assert_eq!(observation.scanned_role, Some(Role::User));
        assert_eq!(observation.scanned_kind, Some(BlockKind::Text));
        assert_eq!(observation.native_user_index, Some(0));
    }
    assert!(observation.may_have_replied || observation.ack.is_some());

    let source_text = vector.scanned_material.source_text.as_deref().unwrap_or("");
    for marker in &observation.observed_markers {
        match marker {
            ObservedMarker::Valid { identity } => {
                let marker_text = format!(
                    " mc-d5:{}:{}",
                    identity.receipt_id, identity.recognition_token
                );
                assert!(
                    source_text.contains(&marker_text),
                    "{} marker absent from source",
                    vector.id
                );
                assert_eq!(parse_marker(&marker_text).as_ref(), Ok(identity));
                let decoded = decode_base32_96(&identity.recognition_token)
                    .unwrap_or_else(|error| panic!("{} valid token: {error}", vector.id));
                assert_eq!(
                    token_inputs.get(identity.recognition_token.as_str()),
                    Some(&decoded),
                    "{} token lacks fixed 96-bit provenance",
                    vector.id
                );
            }
            ObservedMarker::Malformed { token_prefix } => {
                assert!(
                    source_text.contains(token_prefix),
                    "{} malformed bytes absent",
                    vector.id
                );
                let error = parse_marker(token_prefix).unwrap_err();
                let expected_error = if vector.name.contains("missing leading space") {
                    "missing its required leading space"
                } else if vector.name.contains("wrong length") {
                    "must be 64 bytes"
                } else if vector.name.contains("non-canonical") {
                    "non-zero canonical padding bits"
                } else if vector.name.contains("non-lowercase") {
                    "not lowercase RFC4648 base32"
                } else if vector.name.contains("bad UUID") {
                    "not lowercase UUID36"
                } else {
                    panic!("{} has an unnamed malformed criterion", vector.id);
                };
                assert!(
                    error.contains(expected_error),
                    "{} malformed criterion was not distinguished: {error}",
                    vector.id
                );
            }
        }
    }
}

fn assert_immutable_specimen_files(index: &Value) {
    let expected = [
        (
            "source-segment-v1.json",
            297_346_u64,
            "25f8d16852703115b3d4b3d35517c79b07b1d7d0360e0c8c013a97dd53e55969",
        ),
        (
            "expected-manifest-v1.json",
            200_274,
            "fa9219cdd34043610164cdfdb001096a3d7bf8db2f48529a49781835dc02db70",
        ),
        (
            "expected-archive-v1.json",
            695_469,
            "7759de3b0169a80cc1be4697474a4fdb5c2c073871eb0857c182f1c6b372eb8e",
        ),
        (
            "canonical-json-vectors-v1.json",
            24_145,
            "8fc5b1b90997378941534bd5a0d88bebd6b10282f030ad25315612d77285f012",
        ),
    ];
    let entries = index["files"].as_array().expect("index files array");
    for (path, byte_size, digest) in expected {
        let entry = entries
            .iter()
            .find(|entry| entry["path"] == path)
            .unwrap_or_else(|| panic!("missing immutable index entry {path}"));
        assert_eq!(entry["byte_size"], byte_size);
        assert_eq!(entry["sha256"], digest);
    }
}

#[test]
fn d5_redeem_vectors_are_complete_and_coherent() {
    let fixture_bytes =
        fs::read(fixture_dir().join("redeem-vectors-v1.json")).expect("read D5 redeem vectors");
    let fixture: Fixture = serde_json::from_slice(&fixture_bytes).expect("parse fixture schema");
    assert_eq!(fixture.schema, "mc.d5.redeem-vectors.v1");
    assert!(fixture
        .encoding_rule
        .lineage_request
        .contains("discriminator op"));
    assert!(fixture
        .encoding_rule
        .lineage_response
        .contains("Externally keyed"));
    assert!(fixture
        .encoding_rule
        .nested_unions
        .contains("discriminator kind"));
    assert!(fixture
        .encoding_rule
        .implementation_status
        .contains("slice 2"));
    assert!(fixture.serde_evidence.iter().any(|evidence| {
        evidence.path == "crates/mc-module/src/tail_hygiene.rs"
            && evidence.lines == "1212-1238"
            && evidence.finding.contains("internally tagged")
    }));

    assert_eq!(fixture.sealed_scope.receipt_id, RECEIPT_ID);
    assert_eq!(fixture.sealed_scope.recognition_token, SEALED_TOKEN);
    assert_eq!(fixture.sealed_scope.fence_generation, 12);
    assert_eq!(
        fixture
            .sealed_scope
            .stored_edge
            .continuation_identity
            .receipt_id,
        RECEIPT_ID
    );

    let mut token_inputs = BTreeMap::new();
    for token in &fixture.token_values {
        assert!(token.round_trip_matches_input);
        let input = hex_96(&token.input_96_bits_hex).expect("valid token provenance hex");
        assert_eq!(encode_base32_96(&input), token.recognition_token);
        let decoded = decode_base32_96(&token.recognition_token).expect("canonical token");
        assert_eq!(decoded, input);
        assert_eq!(encode_base32_96(&decoded), token.recognition_token);
        assert!(token_inputs
            .insert(token.recognition_token.as_str(), input)
            .is_none());
    }

    let mut priorities = BTreeSet::new();
    let mut row_ids = BTreeSet::new();
    for row in &fixture.precedence_table {
        assert!(
            priorities.insert(row.priority),
            "duplicate priority {}",
            row.priority
        );
        assert!(
            row_ids.insert(row.row_id.as_str()),
            "duplicate row {}",
            row.row_id
        );
        assert!(matches!(
            row.expected_variant.as_str(),
            "REDEEMED" | "UNRECOGNIZED" | "REFUSED" | "lineage_corrupt"
        ));
    }

    let mut vector_ids = BTreeSet::new();
    let mut positive_edge = None;
    for vector in &fixture.vectors {
        assert!(
            vector_ids.insert(vector.id.as_str()),
            "duplicate vector {}",
            vector.id
        );
        assert!(!vector.name.is_empty());
        let request: LineageRequest = serde_json::from_value(vector.request.clone())
            .unwrap_or_else(|error| {
                panic!(
                    "{} request does not follow pinned encoding: {error}",
                    vector.id
                )
            });
        let response: LineageResponse = serde_json::from_value(vector.expected.clone())
            .unwrap_or_else(|error| {
                panic!(
                    "{} expected result does not follow pinned encoding: {error}",
                    vector.id
                )
            });
        let LineageRequest::Redeem {
            predecessor_key,
            agent,
            incarnation,
            observation,
            candidate,
        } = request;
        assert_eq!(predecessor_key, "session-predecessor-0001");
        assert_eq!(agent, "agent-main");
        assert_eq!(incarnation, 7);
        assert_marker_and_digest_provenance(vector, &observation, &token_inputs);

        let observation_class = observation_class(&observation, &fixture.sealed_scope);
        let candidate_relation = candidate_relation(
            vector.scope_state,
            &observation,
            candidate.as_ref(),
            &fixture.sealed_scope,
        );
        let selected = fixture
            .precedence_table
            .iter()
            .filter(|row| {
                row_matches(
                    row,
                    vector.scope_state,
                    observation_class,
                    candidate_relation,
                )
            })
            .min_by_key(|row| row.priority)
            .unwrap_or_else(|| panic!("{} has no matching precedence row", vector.id));
        assert_eq!(
            selected.row_id, vector.precedence_row,
            "{} precedence_row is not the table-driven winner",
            vector.id
        );

        let LineageResponse::Redeem { result } = response;
        let signature = outcome_signature(&result);
        assert_eq!(
            signature.variant, selected.expected_variant,
            "{} owner-authored expected variant disagrees with precedence row {}",
            vector.id, selected.row_id
        );
        assert_eq!(
            signature.reason_or_cause,
            selected.expected_reason_or_cause.as_deref(),
            "{} owner-authored expected reason/cause disagrees with precedence row {}",
            vector.id,
            selected.row_id
        );
        if let RedeemResult::Redeemed {
            edge,
            existing,
            fence_generation,
            ..
        } = result
        {
            assert_eq!(edge, fixture.sealed_scope.stored_edge);
            assert_eq!(fence_generation, fixture.sealed_scope.fence_generation);
            if existing {
                assert_eq!(
                    positive_edge.as_ref(),
                    Some(&edge),
                    "replay edge changed bytes"
                );
            } else {
                positive_edge = Some(edge);
            }
        }
    }
    assert_eq!(fixture.vectors.len(), 20);

    let index: Value = serde_json::from_slice(
        &fs::read(fixture_dir().join("fixture-index-v1.json")).expect("read fixture index"),
    )
    .expect("parse fixture index");
    assert_immutable_specimen_files(&index);
    let redeem_entry = index["files"]
        .as_array()
        .expect("index files array")
        .iter()
        .find(|entry| entry["path"] == "redeem-vectors-v1.json")
        .expect("redeem vectors are indexed");
    assert_eq!(redeem_entry["byte_size"], fixture_bytes.len() as u64);
    assert_eq!(redeem_entry["sha256"], sha256_hex(&fixture_bytes));
    assert_eq!(redeem_entry["derived"], false);
    assert_eq!(
        redeem_entry["source"],
        "owner-authored D5 redeem contract vectors"
    );
}
