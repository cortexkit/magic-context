use super::*;
use serde::de::DeserializeOwned;
use sha2::{Digest, Sha256};

const VECTORS: &[(&str, &str)] = &[
    (
        "declarations.json",
        include_str!("../../testdata/user-commands-contract-v1/declarations.json"),
    ),
    (
        "describe.json",
        include_str!("../../testdata/user-commands-contract-v1/describe.json"),
    ),
    (
        "requests.json",
        include_str!("../../testdata/user-commands-contract-v1/requests.json"),
    ),
    (
        "previews.json",
        include_str!("../../testdata/user-commands-contract-v1/previews.json"),
    ),
    (
        "run-replies.json",
        include_str!("../../testdata/user-commands-contract-v1/run-replies.json"),
    ),
    (
        "facts.json",
        include_str!("../../testdata/user-commands-contract-v1/facts.json"),
    ),
    (
        "invalid.json",
        include_str!("../../testdata/user-commands-contract-v1/invalid.json"),
    ),
    (
        "list.json",
        include_str!("../../testdata/user-commands-contract-v1/list.json"),
    ),
    (
        "README.md",
        include_str!("../../testdata/user-commands-contract-v1/README.md"),
    ),
];

fn vector(name: &str) -> Value {
    serde_json::from_str(VECTORS.iter().find(|(n, _)| *n == name).unwrap().1).unwrap()
}
fn decode<T: DeserializeOwned>(value: &Value) -> T {
    serde_json::from_value(value.clone()).unwrap()
}

#[test]
fn user_commands_authority_vectors_decode_and_validate_every_module_body() {
    let manifest = include_str!("../../testdata/user-commands-contract-v1/SHA256SUMS");
    for (name, bytes) in VECTORS {
        let digest = format!("{:x}", Sha256::digest(bytes.as_bytes()));
        assert!(
            manifest
                .lines()
                .any(|line| line == format!("{digest}  {name}")),
            "{name}"
        );
    }
    let declarations: std::collections::BTreeMap<String, Vec<wire::Command>> =
        decode(&vector("declarations.json"));
    for commands in declarations.values() {
        wire::validate_commands(commands).unwrap();
    }
    let describe: wire::DescribeReply = decode(&vector("describe.json"));
    describe.check().unwrap();
    let list: wire::ListReply = decode(&vector("list.json"));
    list.check().unwrap();
    for case in vector("previews.json").as_array().unwrap() {
        let preview: wire::Preview = decode(&case["body"]);
        preview.check().unwrap();
    }
    for case in vector("run-replies.json").as_array().unwrap() {
        let reply: wire::RunReply = decode(&case["body"]);
        reply.check().unwrap();
    }
    let requests = vector("requests.json");
    let _: wire::DescribeRequest = decode(&requests["describe"]);
    let request: wire::ListRequest = decode(&requests["list"]);
    request.check().unwrap();
    let flush = describe.commands.iter().find(|c| c.id == "flush").unwrap();
    let p: wire::ModulePreviewRequest = decode(&requests["module_preview"]);
    p.check(flush).unwrap();
    let r: wire::ModuleRunRequest = decode(&requests["module_run"]);
    r.check(flush).unwrap();
    let p: wire::AppPreviewRequest = decode(&requests["app_preview"]);
    p.check(flush).unwrap();
    let r: wire::AppRunRequest = decode(&requests["app_run"]);
    r.check(flush).unwrap();
    for case in vector("facts.json").as_array().unwrap() {
        let result = wire::validate_fact(&case["body"]);
        if case["valid"] == true {
            result.unwrap();
            let fact: wire::Fact = decode(&case["body"]);
            fact.check().unwrap();
        } else {
            let error = result.unwrap_err();
            assert_eq!(error.code, case["code"].as_str().unwrap());
            assert_eq!(error.field, case["field"].as_str().unwrap());
        }
    }
    for case in vector("invalid.json").as_array().unwrap() {
        let result = match case["kind"].as_str().unwrap() {
            "command" => decode::<wire::Command>(&case["body"]).check(),
            "preview" => decode::<wire::Preview>(&case["body"]).check(),
            "run" => decode::<wire::ModuleRunRequest>(&case["body"])
                .check(flush)
                .map(|_| ()),
            _ => panic!("unknown vector kind"),
        };
        assert_eq!(result.unwrap_err().field, case["field"].as_str().unwrap());
    }
}

#[test]
fn user_commands_replays_keep_unexpired_answers_and_refuse_capacity_without_eviction() {
    let request: ModuleRunRequest = decode(&vector("requests.json")["module_run"]);
    let mut replays = Replays::default();
    let answer = serde_json::json!({"outcome":"scheduled"});
    for i in 0..4096 {
        let mut body = request.clone();
        body.request_id = format!("request-{i}");
        replays.records.insert(
            body.request_id.clone(),
            Record {
                principal: wire::ADMITTED_CALLER,
                at: Instant::now() - Duration::from_secs(23 * 60 * 60),
                body,
                answer: answer.clone(),
            },
        );
    }
    assert_eq!(
        replays.prepare(&request).unwrap_err().code,
        "command_capacity"
    );
    assert_eq!(replays.records.len(), 4096);
    let body = replays.records["request-1"].body.clone();
    assert_eq!(replays.prepare(&body).unwrap(), Some(answer));
    let mut changed = body.clone();
    changed.subject = Subject::session(wire::SessionRef::new("other", "host", "session"));
    assert_eq!(
        replays.prepare(&changed).unwrap().unwrap()["outcome"],
        "request_conflict"
    );
    replays.records.get_mut("request-1").unwrap().at =
        Instant::now() - Duration::from_secs(24 * 60 * 60 + 1);
    assert!(replays.prepare(&request).unwrap().is_none());
    assert!(!replays.records.contains_key("request-1"));
    assert_eq!(replays.records.len(), 4095);
}
