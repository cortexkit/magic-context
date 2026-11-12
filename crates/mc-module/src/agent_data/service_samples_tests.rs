//! Service-only examples for states that do not require a daemon.

use super::*;

use crate::agent_data::sample_files as files;

async fn capture(
    samples: &mut files::Samples,
    service: &Service,
    host: &Stand,
    name: &str,
    op: &str,
    params: Value,
) {
    let name = format!("service-{name}");
    let method = format!("agent_data.{op}");
    let body = samples.request(&name, &method, params);
    match service
        .handle(host, ENTORHINAL, &serde_json::to_vec(&body).unwrap())
        .await
    {
        Ok(bytes) => samples.reply(&name, op, &serde_json::from_slice(&bytes).unwrap()),
        Err(error) => samples.refusal(&name, &serde_json::to_value(error).unwrap()),
    }
}

#[tokio::test]
async fn agent_data_samples_v1_service() {
    let mut samples = files::Samples::default();
    let host = Stand::new(Journal::in_memory());
    let service = Service::new(true);
    capture(
        &mut samples,
        &service,
        &host,
        "describe-runner",
        "describe",
        json!({}),
    )
    .await;
    host.historian.lock().unwrap().insert(pi("sample-head"));
    host.bind(
        "pi-session",
        "sample-head",
        Some("thalamus-harness"),
        "pi",
        "sample-head",
    );
    capture(
        &mut samples,
        &service,
        &host,
        "busy-historian",
        "busy",
        busy_request(&["sample-head"]),
    )
    .await;
    host.historian.lock().unwrap().clear();
    *host.probe.lock().unwrap() = Probe::Answered {
        view_unconfirmed: true,
    };
    capture(
        &mut samples,
        &service,
        &host,
        "busy-view",
        "busy",
        busy_request(&["sample-head"]),
    )
    .await;
    *host.probe.lock().unwrap() = Probe::NoAnswer;
    capture(
        &mut samples,
        &service,
        &host,
        "busy-unknown",
        "busy",
        busy_request(&["sample-head"]),
    )
    .await;
    for step in Step::ALL {
        seed(&host.journal, CUT, step, &["sample-head"]);
        capture(
            &mut samples,
            &service,
            &host,
            &format!("status-{}", step.as_str()),
            "status",
            cut_params(CUT, &["sample-head"]),
        )
        .await;
    }
    capture(
        &mut samples,
        &Service::new(false),
        &host,
        "moves-off-defensive",
        "describe",
        json!({}),
    )
    .await;
    let body = samples.request(
        "service-caller-forbidden",
        contract::ops::DESCRIBE,
        json!({}),
    );
    let error = service
        .handle(&host, "reserved:broca", &serde_json::to_vec(&body).unwrap())
        .await
        .unwrap_err();
    samples.refusal(
        "service-caller-forbidden",
        &serde_json::to_value(error).unwrap(),
    );
    let error = service
        .handle(
            &host,
            ENTORHINAL,
            br#"{"method":"agent_data.describe","params":{},"extra":true}"#,
        )
        .await
        .unwrap_err();
    samples.refusal(
        "service-invalid-request",
        &serde_json::to_value(error).unwrap(),
    );
    capture(
        &mut samples,
        &service,
        &host,
        "unknown-ref",
        "busy",
        busy_request(&["missing"]),
    )
    .await;
    capture(
        &mut samples,
        &service,
        &host,
        "cut-unknown",
        "export",
        cut_params(OTHER_CUT, &["sample-head"]),
    )
    .await;
    capture(
        &mut samples,
        &service,
        &host,
        "abort",
        "abort",
        cut_params(OTHER_CUT, &["sample-head"]),
    )
    .await;
    capture(
        &mut samples,
        &service,
        &host,
        "id-reused",
        "abort",
        cut_params(OTHER_CUT, &["other-head"]),
    )
    .await;
    samples.finish("service-");
}
