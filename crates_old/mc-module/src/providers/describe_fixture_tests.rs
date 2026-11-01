use super::*;
use base64::Engine;
use std::io::Write;

#[tokio::test]
async fn served_role_describe_matches_committed_jcs_fixture() {
    let handler = McHandler::new();
    let HandlerOutcome::Response(bytes) = handler
        .dispatch_value(1, json!({"method":"role.describe","params":{}}))
        .await
    else {
        panic!("role.describe failed");
    };
    let answer: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        serde_jcs::to_vec(&answer).unwrap(),
        bytes,
        "discovery must serve canonical JCS bytes"
    );
    if std::env::var_os("MC_REGENERATE_ROLE_DESCRIBE_FIXTURE").is_some() {
        // Regeneration is explicit; the ordinary test never updates its expected bytes.
        std::fs::write(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/testdata/role-describe-compaction-provider.json"
            ),
            &bytes,
        )
        .unwrap();
        let mut encoder =
            flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&bytes).unwrap();
        println!(
            "ROLE_DESCRIBE_ZLIB_BASE64={}",
            base64::engine::general_purpose::STANDARD.encode(encoder.finish().unwrap())
        );
        println!("ROLE_DESCRIBE_SHA256={}", sha256_hex(&bytes));
        return;
    }
    let pinned = include_bytes!("../../testdata/role-describe-compaction-provider.json");
    assert!(
        bytes.as_slice() == pinned,
        "served role.describe bytes drifted: served sha256={}, fixture sha256={}",
        sha256_hex(&bytes),
        sha256_hex(pinned)
    );
}
