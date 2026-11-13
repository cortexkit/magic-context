//! Real store failures and move refusals that the wire move does not meet.

use super::*;

use crate::agent_data::sample_files as files;

async fn capture(
    samples: &mut files::Samples,
    machine: &Machine,
    name: &str,
    op: &str,
    cut: &str,
    names: &[&str],
) -> Value {
    let name = format!("receiver-{name}");
    let body = samples.request(
        &name,
        &format!("agent_data.{op}"),
        json!({"refs": refs(names), "cutId": cut}),
    );
    match machine
        .call(body["method"].as_str().unwrap(), body["params"].clone())
        .await
    {
        Ok(value) => {
            samples.reply(&name, op, &value);
            value
        }
        Err(error) => {
            let value = serde_json::to_value(error).unwrap();
            samples.refusal(&name, &value);
            value
        }
    }
}

#[tokio::test]
async fn agent_data_samples_v1_receiver() {
    let mut samples = files::Samples::default();
    let (a, b) = machines(&["sample-head", "sample-alias"]);
    seed(&a.conn(), "sample-head", PROJECT);
    a.shared
        .bindings
        .lock()
        .unwrap()
        .get_mut("sample-alias")
        .unwrap()["session_id"] = json!("sample-head");
    let refusal = capture(
        &mut samples,
        &a,
        "not-exportable",
        "prepare",
        CUT,
        &["sample-head", "sample-alias"],
    )
    .await;
    assert_eq!(refusal["code"], "not_exportable");
    a.send_out(CUT, &["sample-head"]).await;
    let refusal = capture(
        &mut samples,
        &b,
        "cut-not-ready",
        "import",
        BACK,
        &["sample-head"],
    )
    .await;
    assert_eq!(refusal["code"], "cut_not_ready");
    seed(&b.conn(), "sample-head", PROJECT);
    let refusal = capture(
        &mut samples,
        &b,
        "local-advanced",
        "import",
        CUT,
        &["sample-head"],
    )
    .await;
    assert_eq!(refusal["code"], "local_advanced");
    let c = Machine::new(&a.shared);
    c.conn().execute("INSERT INTO schema_migrations(version, description, applied_at) VALUES (999, 'newer', 0)", []).unwrap();
    let refusal = capture(
        &mut samples,
        &c,
        "incompatible-version",
        "import",
        CUT,
        &["sample-head"],
    )
    .await;
    assert_eq!(refusal["code"], "incompatible_version");
    let d = Machine::new(&a.shared);
    let stream = source::session_ref(&key("sample-head"));
    let sealed_key = (CUT.to_owned(), stream);
    let original = a.shared.door.lock().unwrap().sealed[&sealed_key].clone();
    a.shared
        .door
        .lock()
        .unwrap()
        .sealed
        .get_mut(&sealed_key)
        .unwrap()
        .1 = "0".repeat(64);
    let refusal = capture(
        &mut samples,
        &d,
        "digest-mismatch",
        "import",
        CUT,
        &["sample-head"],
    )
    .await;
    assert_eq!(refusal["code"], "digest_mismatch");
    a.shared
        .door
        .lock()
        .unwrap()
        .sealed
        .insert(sealed_key, original);
    let e = Machine::new(&a.shared);
    e.setup("sample-head").unwrap();
    let refusal = capture(&mut samples, &e, "busy", "import", CUT, &["sample-head"]).await;
    assert_eq!(refusal["code"], "busy");
    samples.finish("receiver-");
}
