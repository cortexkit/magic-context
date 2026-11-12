//! Session-door size failures mapped by the real source service.

use super::*;

use crate::agent_data::sample_files as files;

#[tokio::test]
async fn agent_data_samples_v1_source() {
    let mut samples = files::Samples::default();
    let fixture = Fixture::new();
    seed(&fixture.conn(), "sample-head", "content");
    fixture.bind("sample-head");
    fixture.settle("sample-head").await;
    let params = cut_params(CUT, &["sample-head"]);
    samples.request("source-prepare", "agent_data.prepare", params.clone());
    let prepared = fixture.prepare(CUT, &["sample-head"]).await.unwrap();
    samples.reply("source-prepare", "prepare", &prepared);
    for code in ["record_too_large", "response_too_large"] {
        fixture.door().admit_refusals = vec![(code, false)];
        let name = format!("source-export-{code}");
        samples.request(&name, "agent_data.export", params.clone());
        let refusal = fixture.export(CUT, &["sample-head"]).await.unwrap_err();
        assert_eq!(refusal.code, RefusalCode::ParticipantFailed);
        assert_eq!(
            refusal.detail.as_ref().unwrap()["reason"],
            format!("session_door:{code} at prepared")
        );
        samples.refusal(&name, &serde_json::to_value(refusal).unwrap());
    }
    samples.finish("source-");
}
