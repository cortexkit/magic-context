use super::*;
use cortexkit_role_tool_provider::catalog::{system_text_digest, SystemTextAnswer};

const GUIDANCE: &str = "  Use `read` for a file.\n\nUse `aft_search` to find café.  \n";

fn scripted_reader(client: &mut Client, names: Option<&[&str]>) {
    available_sidekick(client);
    client.lab_guidance_missing = names.is_none();
    let mut catalog = sidekick_catalog(&[], &["read", "aft_search"]);
    catalog.tools[0].capabilities = vec!["code.read/v1".into()];
    if let Some(names) = names {
        catalog.system_text = Some(
            SystemTextAnswer::new(system_text_digest(GUIDANCE), "a".repeat(64))
                .with_text(GUIDANCE)
                .with_tool_names(names.iter().copied())
                .with_composition_digest("b".repeat(64)),
        );
    }
    client
        .lab_catalogs
        .as_mut()
        .unwrap()
        .insert(("aft", Some("reader")), Ok(catalog));
}

#[tokio::test]
async fn lab_uses_provider_guidance_verbatim_and_records_digests() {
    let fixture = Fixture::new();
    let mut spec = fixture.spec_value();
    spec["tools"] = json!(["reader", "sidekick"]);
    let fact =
        "[AFT]{{ tool_guidance.aft }}[/AFT][prefrontal]{{ tool_guidance.prefrontal }}[/prefrontal]";
    fs::write(
        fixture.persona.join("PERSONA.md"),
        format!("{SYSTEM}\n{fact}"),
    )
    .unwrap();
    fs::write(
        fixture.persona.join("first-message.md"),
        format!("{MESSAGE}\n{fact}"),
    )
    .unwrap();
    let client = fixture
        .run_with(spec, Ends::LabTools(vec![]), |client| {
            scripted_reader(client, Some(&["read", "aft_search"]));
        })
        .await;
    let run = fixture.output("run.json");
    assert_eq!(run["stop"], "model_finished", "{run}");
    let request = fixture.output("request.json");
    for field in ["first_message", "system_text"] {
        assert!(
            request[field]
                .as_str()
                .unwrap()
                .contains(&format!("[AFT]{GUIDANCE}[/AFT][prefrontal][/prefrontal]")),
            "{request}"
        );
    }
    assert_eq!(
        request["tool_guidance_digests"],
        json!({"aft":{
            "item_digest":system_text_digest(GUIDANCE),"preflight_digest":"a".repeat(64),"composition_digest":"b".repeat(64)
        }})
    );
    let sends = client.sends.lock().unwrap();
    assert_eq!(sends.len(), 1);
    assert_eq!(
        *client.lab_guidance_requests.lock().unwrap(),
        [("aft".into(), "reader".into())]
    );
    assert_eq!(
        sends[0].1.plan.as_ref().unwrap()["system_text_items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn lab_refuses_missing_or_mismatched_reader_guidance_before_send() {
    for (names, expected) in [
        (
            None,
            "aft reader catalog did not return system_text.text guidance",
        ),
        (
            Some(&["read", "shell"][..]),
            "missing: [\"aft_search\"]; unexpected: [\"shell\"]",
        ),
    ] {
        let fixture = Fixture::new();
        let mut spec = fixture.spec_value();
        spec["tools"] = json!(["reader"]);
        let client = fixture
            .run_with(spec, Ends::LabTools(vec![]), |client| {
                scripted_reader(client, names);
            })
            .await;
        let run = fixture.output("run.json");
        assert_eq!(run["stop"], "refusal", "{run}");
        assert!(run["error"].as_str().unwrap().contains(expected), "{run}");
        assert!(client.sends.lock().unwrap().is_empty());
    }
}
