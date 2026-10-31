//! Replay Broca's conformance captures against the 0.7.10 provider.
use super::*;
use sha2::{Digest, Sha256};

const ROOT: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/testdata/broca-compaction-0710/"
);
const MANIFEST_SHA256: &str = "c679754e05680772890502cced3e0f1902bad79cce8d2f9569457e991a84c3ed";

fn fixture(name: &str) -> Value {
    serde_json::from_slice(&std::fs::read(Path::new(ROOT).join(name)).unwrap()).unwrap()
}

#[test]
fn checksums_cover_all_31_captured_files() {
    let manifest = std::fs::read(Path::new(ROOT).join("SHA256SUMS")).unwrap();
    assert_eq!(format!("{:x}", Sha256::digest(&manifest)), MANIFEST_SHA256);
    let mut listed = BTreeSet::new();
    for line in std::str::from_utf8(&manifest).unwrap().lines() {
        let (expected, name) = line.split_once("  ").unwrap();
        assert!(listed.insert(name.to_owned()), "duplicate fixture: {name}");
        let bytes = std::fs::read(Path::new(ROOT).join(name)).unwrap();
        assert_eq!(format!("{:x}", Sha256::digest(&bytes)), expected, "{name}");
    }
    let present: BTreeSet<_> = std::fs::read_dir(ROOT)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .filter(|name| name.ends_with(".json"))
        .collect();
    assert_eq!(listed, present);
    assert_eq!(listed.len(), 31);
}

fn invalid_params(outcome: HandlerOutcome) -> String {
    match outcome {
        HandlerOutcome::Error { code, message }
        | HandlerOutcome::ErrorWithDetail { code, message, .. } => {
            assert_eq!(code, "invalid_params");
            message
        }
        other => panic!("expected invalid_params, got {other:?}"),
    }
}

fn no_truncate(value: &Value) {
    match value {
        Value::Object(fields) => {
            assert!(!fields.contains_key("truncate"), "{value}");
            for child in fields.values() {
                no_truncate(child);
            }
        }
        Value::Array(values) => {
            for child in values {
                no_truncate(child);
            }
        }
        _ => {}
    }
}

async fn replay_case(case: &str, fetches: usize, notices: usize, models: usize) {
    let dir = tempfile::tempdir().unwrap();
    let setup_name = format!("{case}-setup-0.json");
    let setup = fixture(&setup_name);
    let params = &setup["params"];
    let session = params["session"].as_str().unwrap();
    let harness = params["harness"].as_str().unwrap();
    let rig = Rig::without_setup(
        dir.path(),
        "broca",
        ("runner", session),
        (harness, session),
        |_| {},
    )
    .await;

    // Since compaction-provider 0.7.11 the Setup decoder knows the runner's
    // `view_features`. ck-mc decodes them but doesn't use them yet: it still
    // publishes no truncate edits (checked below). The captured scripted preset
    // is not one ck-mc implements.
    let decoded: compact::setup::SetupRequest = decode(params).unwrap();
    assert_eq!(decoded.view_due_max_ms(), Some(30_000));
    assert_eq!(decoded.ride_wait_max_ms, Some(120_000));
    assert_eq!(
        params["view_features"],
        json!(["truncate", "tag_bytes_edits"])
    );
    let known = serde_json::to_value(decoded).unwrap();
    assert_eq!(known["view_features"], params["view_features"]);
    let error = invalid_params(rig.h.dispatch_value(7, setup.clone()).await);
    assert_eq!(error, "unknown provider preset");
    assert!(load_head(rig.h.store.get().unwrap(), &rig.reference)
        .unwrap()
        .is_none());
    println!("{setup_name}: PASS decode (view_due_max_ms=30000, view_features decoded, unused); handler REJECT invalid_params: {error}");

    // This is a separate compatibility probe, not a rewrite of the capture:
    // remove only the future member and leave view_due_max_ms unchanged.
    let mut v0710 = params.clone();
    v0710.as_object_mut().unwrap().remove("view_features");
    let decoded: compact::setup::SetupRequest = decode(&v0710).unwrap();
    let mut without_features = known.clone();
    without_features
        .as_object_mut()
        .unwrap()
        .remove("view_features");
    assert_eq!(serde_json::to_value(decoded).unwrap(), without_features);
    let error = invalid_params(
        rig.h
            .dispatch_value(7, json!({"method":"compaction.setup","params":v0710}))
            .await,
    );
    assert_eq!(error, "unknown provider preset");
    println!("{setup_name}: without view_features, decode PASS (view_due_max_ms=30000); handler REJECT scripted preset");

    for index in 0..notices {
        let name = format!("{case}-notice-{index}.json");
        let headers: BTreeMap<String, String> = serde_json::from_value(fixture(&name)).unwrap();
        let decoded = notice::AdvanceNotice::from_headers(&headers).unwrap();
        assert_eq!(decoded.to_headers(), headers, "{name}: header lost");
        let message = cortexkit_bus_trait::Message {
            subject: notice::event_subject("fixture", "broca", notice::ADVANCED_EVENT),
            id: bus_id(&decoded.session_ref, "advanced", decoded.seq),
            digest: decoded.digest().parse().unwrap(),
            headers,
        };
        // Setup was refused. The actual notice handler acknowledges an unknown
        // conversation without reading the runner or publishing a view.
        rig.h.advance_compaction("fixture", &message).await.unwrap();
        assert!(load_head(rig.h.store.get().unwrap(), &decoded.session_ref)
            .unwrap()
            .is_none());
        let mut corrupt = message.clone();
        corrupt.id.push_str("-wrong");
        assert!(rig.h.advance_compaction("fixture", &corrupt).await.is_err());
        println!("{name}: PASS decode and handler (unknown conversation acknowledged)");
    }

    for index in 0..fetches {
        let name = format!("{case}-fetch-{index}.json");
        let capture = fixture(&name);
        let _: view::ViewGetRequest = decode(&capture["request"]["params"]).unwrap();
        let answer = response(rig.h.dispatch_value(7, capture["request"].clone()).await);
        let _: view::ViewGetAnswer = decode(&answer).unwrap();
        assert_eq!(answer["answer"], "refuse");
        assert_eq!(answer["code"], "unknown_session");
        no_truncate(&answer);

        // These captured answers come from a scripted provider, not ck-mc.
        // Since compaction-provider 0.7.11 a truncate edit is a valid action,
        // so every captured view, the truncate one included, validates.
        let scripted: view::ViewGetAnswer = decode(&capture["answer"]).unwrap();
        if let view::ViewGetAnswer::View { view } = scripted {
            assert_eq!(view.check(), Ok(()), "{name}");
        }
        println!("{name}: request PASS; ck-mc answer PASS (unknown_session); scripted answer PASS decode/validation");
    }

    for index in 0..models {
        let name = format!("{case}-model-{index}.json");
        let rows = fixture(&name);
        assert!(!rows.as_array().unwrap().is_empty());
        for row in rows.as_array().unwrap() {
            assert!(matches!(row["role"].as_str(), Some("user" | "assistant")));
            assert!(row["content"].is_string());
        }
        println!("{name}: N/A model input (Broca -> model, not a ck-mc request/answer)");
    }
    assert!(rig.runner.reads.lock().unwrap().is_empty());
}

macro_rules! case {
    ($name:ident, $fetches:expr, $notices:expr, $models:expr) => {
        #[tokio::test]
        async fn $name() {
            replay_case(stringify!($name), $fetches, $notices, $models).await;
        }
    };
}

case!(view_due_first_model_uses_view, 1, 2, 1);
case!(view_due_later_step_retries, 2, 3, 1);
case!(view_due_refused_fetch_blocks_model, 1, 1, 0);
case!(part_edits_truncate_renders_with_own_tag, 1, 4, 2);
case!(part_edits_bytes_render_with_own_tag, 1, 4, 2);

#[tokio::test]
async fn supported_broca_setup_and_published_edits_never_contain_truncate() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::open(
        dir.path(),
        "broca",
        "broca",
        json!({"serializer_profile":"owned-broca"}),
    )
    .await;
    let setup: compact::setup::SetupAnswer = decode(&rig.state().initial).unwrap();
    no_truncate(&serde_json::to_value(setup).unwrap());
    // A supported ck-mc session is a separate publication witness: the captures
    // omit session.read pages and their scripted Setup is not a ck-mc preset.
    *rig.runner.entries.lock().unwrap() = (0..40)
        .map(|n| {
            ReadMessage::new(
                n,
                format!("m{n}"),
                json!({"role":if n % 2 == 0 {"user"} else {"assistant"},"content":[{"type":"text","text":format!("message {n} ")+&"durable words ".repeat(16)}]}),
            )
            .with_tags(vec![tags::PartTag::tagged(format!("m{n}#0"), format!("§{}§", n + 1))])
        })
        .collect();
    rig.notice(1, 100, None).await;
    rig.queue(&[2]).await;
    let published = rig
        .ride("ttl_expired")
        .await
        .expect("a reduction publishes");
    let answer = rig
        .op(
            "view.get",
            json!({"session_ref":rig.reference,"view_version":published.view_version}),
        )
        .await;
    assert_eq!(answer["answer"], "view");
    let _: view::ViewGetAnswer = decode(&answer).unwrap();
    no_truncate(&answer);
    let edits: Vec<_> = answer["view"]["ranges"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|range| range["edits"].as_array())
        .flatten()
        .collect();
    assert!(
        !edits.is_empty(),
        "exercise a real edit, not an unchanged view"
    );
    assert!(edits
        .iter()
        .all(|edit| edit.get("drop").is_some() || edit.get("bytes").is_some()));
}
