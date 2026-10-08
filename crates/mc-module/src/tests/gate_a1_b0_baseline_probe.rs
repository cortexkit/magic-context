//! Verify that adding durable session fields leaves the served response unchanged, and pin
//! the default historian request including its raw ordinal range header. The request digest
//! covers the system prompt, user prompt, and model sent to the completion provider; the
//! served digest covers the response array. The metadata checks allow only expected fields.

use super::*;
use sha2::{Digest, Sha256};

/// Digest of the system prompt, user prompt, and model sent to the provider.
const EXPECTED_REQUEST_DIGEST: &str =
    "297ecdb7d65bd894b72d532032378d5c808e37e838fbd5209b01d5d9d4ab343b";

/// Digest of the message array returned by a fold pass.
const BASELINE_SERVED_DIGEST: &str =
    "34e55f759e321821f452bf6e028cfe94eef25c5087afac4345480b419863b680";

/// Digest of the earlier session metadata format, before the attempt and
/// protected-tool policy fields were added.
const BASELINE_META_DIGEST: &str =
    "6d9f28bd0253565e8175ad3d26a4f7e490b01d577f188c8299b0321ee502caeb";
// Expected earlier-format metadata length before the two fields checked below.
const BASELINE_META_BYTES: usize = 22_404;
const ATTEMPT_FIELD: &str = ",\"producer_attempt\":0";
// The saved nudge baseline includes the default keep counts for ctx_reduce and
// todowrite. This fragment includes the comma that follows the first field.
const PROTECTED_POLICY_FIELD: &str =
    "\"protected_tools_policy\":{\"ctx_reduce\":3,\"todowrite\":1},";

fn digest(parts: &[&str]) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part.as_bytes());
        // A separator no prompt can contain, so two different splits of the same
        // concatenated text cannot collide into one digest.
        hasher.update([0u8]);
    }
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Drive one real fold through the default (in-module) runner and report the
/// digest of the completion request it sent, plus the durable meta blob.
#[tokio::test(flavor = "current_thread")]
async fn gate_probe_default_runner_request_and_meta_digests() {
    let producer = Arc::new(ProducerState::default());
    let (handler, store, _dir, _project) =
        handler_with_store(Arc::clone(&producer), default_test_config());

    let fired = call_transform(&handler, big_messages()).await;
    assert_eq!(fired["historian"]["fired"], true, "{fired}");
    wait_for_count(&producer.starts, 1).await;
    wait_for_idle(&store).await;

    let systems = producer.systems.lock().unwrap().clone();
    let prompts = producer.prompts.lock().unwrap().clone();
    let models = producer.models.lock().unwrap().clone();
    assert_eq!(systems.len(), 1, "exactly one completion was requested");

    let parts: Vec<&str> = systems
        .iter()
        .chain(prompts.iter())
        .chain(models.iter())
        .map(String::as_str)
        .collect();
    let request_digest = digest(&parts);

    // The provider session id carries a hash of the project root, which is a
    // temp directory, so it is reported in shape rather than hashed.
    let sessions = producer.sessions.lock().unwrap().clone();
    let session_shape = sessions
        .iter()
        .map(|session| {
            let mut fields: Vec<&str> = session.split(':').collect();
            // Only the middle field (the project hash) is path-dependent.
            if fields.len() == 4 {
                fields[2] = "<project-hash>";
            }
            fields.join(":")
        })
        .collect::<Vec<_>>()
        .join(",");

    let meta_blob = serde_json::to_string(&store.load("ses").unwrap().meta).unwrap();
    let meta_digest = digest(&[&meta_blob]);

    println!("GATE-PROBE request_digest={request_digest}");
    println!("GATE-PROBE system_bytes={}", systems[0].len());
    println!("GATE-PROBE prompt_bytes={}", prompts[0].len());
    println!("GATE-PROBE model={}", models[0]);
    println!("GATE-PROBE session_shape={session_shape}");
    println!("GATE-PROBE meta_digest={meta_digest}");
    println!("GATE-PROBE meta_bytes={}", meta_blob.len());
    println!(
        "GATE-PROBE meta_has_producer_attempt={}",
        meta_blob.contains("\"producer_attempt\"")
    );

    assert_eq!(
        request_digest, EXPECTED_REQUEST_DIGEST,
        "the default runner's completion request must match its pinned prompt bytes"
    );

    // Idle expiry and result protection are metadata, not prompt text. Pin their
    // additions and the producer's attempt identifier so unrelated changes fail.
    const TTL_POLICY_FIELD: &str = ",\"cache_ttl_policy\":{\"value\":\"5m\",\"source\":\"built-in default, frozen for this session\",\"model_key\":null,\"built_in_default\":\"5m\"}";
    assert!(meta_blob.contains(&TTL_POLICY_FIELD[1..]));
    assert_ne!(
        meta_digest, BASELINE_META_DIGEST,
        "the attempt is stored unconditionally, so the blob cannot match the base's"
    );
    assert!(
        meta_blob.contains(ATTEMPT_FIELD),
        "the attempt rides the blob as a plain field: {meta_blob:.200}"
    );
    assert!(
        meta_blob.contains(PROTECTED_POLICY_FIELD),
        "the frozen protected-tool policy rides the blob as a plain field"
    );
    assert_eq!(
        meta_blob.len(),
        BASELINE_META_BYTES + ATTEMPT_FIELD.len() + TTL_POLICY_FIELD.len() + PROTECTED_POLICY_FIELD.len(),
        "the blob must grow by exactly the attempt, TTL and protection policy fields and nothing else"
    );
}

/// The bytes the harness is served on the pass that folds. This is the other
/// half of "no behaviour change": the request going out AND the array coming
/// back.
#[tokio::test(flavor = "current_thread")]
async fn gate_probe_served_bytes_digest_across_a_fold() {
    let producer = Arc::new(ProducerState::default());
    let (handler, store, _dir, _project) =
        handler_with_store(Arc::clone(&producer), default_test_config());

    let first = call_transform(&handler, big_messages()).await;
    assert_eq!(first["historian"]["fired"], true, "{first}");
    wait_for_count(&producer.starts, 1).await;
    wait_for_idle(&store).await;

    let folded = call_transform(&handler, big_messages()).await;
    let served = serde_json::to_string(&folded["ck_messages"]).unwrap();
    let served_digest = digest(&[&served]);
    println!("GATE-PROBE served_digest={served_digest}");
    println!("GATE-PROBE served_bytes={}", served.len());
    println!(
        "GATE-PROBE compartments={}",
        store.load_compartments("ses").unwrap().len()
    );
    assert_eq!(
        store.load_compartments("ses").unwrap().len(),
        1,
        "the pass under test has to be one that serves a published fold"
    );
    assert_eq!(
        served_digest, BASELINE_SERVED_DIGEST,
        "a fold pass must serve the same array it served on the base tree"
    );
}
