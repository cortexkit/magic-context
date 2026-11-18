//! The review of proposed settings ([`super::review::review`]): the
//! schema's refusals, the checks the schema can't state, and the changes an
//! accepted proposal makes.

use std::fs;
use std::path::Path;

use serde_json::{json, Value};
use subc_client_rs::config::{
    ApplyKind, ConfigLayer, ConfigLayerSnapshot, ConfigReviewReply, ConfigReviewRequest,
    ConfigStatus, ConfigView, Layer, LayerValue, ValidationContext,
};

const USER_FILE: &str = "/settings/magic-context.jsonc";

/// The view the daemon would have in force for `user`.
fn view(user: Value, generation: u64) -> ConfigView {
    let tuple = super::review::schema()
        .review_tuple(
            &[LayerValue::new(Layer::User, user)],
            &ValidationContext::new("magic-context", None),
        )
        .unwrap();
    ConfigView::new(
        generation,
        tuple.effective,
        tuple.sources,
        vec![],
        ConfigStatus::Active,
    )
}

fn review(user: &Value, base: Option<ConfigView>, user_path: &Path) -> ConfigReviewReply {
    let request = ConfigReviewRequest::new(
        base.as_ref().map_or(0, |base| base.generation),
        vec![ConfigLayerSnapshot::file(
            "magic-context",
            ConfigLayer::User,
            user_path.to_string_lossy(),
            Some(serde_json::to_vec(user).unwrap()),
        )],
        base,
    );
    super::review::review(&request, user_path)
}

#[test]
fn a_layer_with_a_byte_order_mark_reads_as_json() {
    let request = ConfigReviewRequest::new(
        0,
        vec![ConfigLayerSnapshot::file(
            "magic-context",
            ConfigLayer::User,
            USER_FILE,
            Some(b"\xef\xbb\xbf{\"language\": \"tr\"}\r\n".to_vec()),
        )],
        None,
    );
    let reply = super::review::review(&request, Path::new(USER_FILE));
    assert!(reply.refusals.is_empty(), "{:?}", reply.refusals);
    assert!(reply.fields.iter().any(|field| field.path == "/language"));
    // Bytes that are not JSON are refused, not read as nothing.
    let request = ConfigReviewRequest::new(
        0,
        vec![ConfigLayerSnapshot::file(
            "magic-context",
            ConfigLayer::User,
            USER_FILE,
            Some(b"{\"language\": \"tr\",} // trailing".to_vec()),
        )],
        None,
    );
    let reply = super::review::review(&request, Path::new(USER_FILE));
    assert_eq!(reply.refusals.len(), 1);
    assert!(reply.fields.is_empty());
}

#[test]
fn a_guidance_file_that_is_missing_or_lacks_one_heading_is_refused_naming_the_field() {
    let folder = tempfile::tempdir().unwrap();
    let user_path = folder.path().join("magic-context.jsonc");
    fs::write(
        folder.path().join("two.md"),
        "## Magic Context\none\n## Magic Context\ntwo\n",
    )
    .unwrap();
    fs::write(folder.path().join("empty.md"), "\n").unwrap();
    fs::write(
        folder.path().join("good.md"),
        "## Magic Context\nKeep it short.\n",
    )
    .unwrap();
    for name in ["missing.md", "two.md", "empty.md"] {
        let user = json!({"prompt_surface": {"guidance_override_path": name}});
        let reply = review(&user, None, &user_path);
        assert!(reply.fields.is_empty(), "{name}");
        assert_eq!(reply.refusals.len(), 1, "{name}");
        assert_eq!(
            reply.refusals[0].paths,
            ["/prompt_surface/guidance_override_path"]
        );
        assert_eq!(reply.refusals[0].code, "value_invalid");
        assert!(
            reply.refusals[0].reasons[0].contains(name),
            "{:?}",
            reply.refusals[0].reasons
        );
    }
    // A file that does hold one heading, and an absolute path to it.
    for path in [
        "good.md".to_owned(),
        folder.path().join("good.md").to_string_lossy().into_owned(),
    ] {
        let user = json!({"prompt_surface": {"guidance_override_path": path}});
        let reply = review(&user, None, &user_path);
        assert!(reply.refusals.is_empty(), "{:?}", reply.refusals);
    }
}

#[test]
fn a_review_refuses_what_only_ck_mc_knows_is_wrong() {
    for (user, pointer) in [
        (
            json!({"embedding": {"module": "not a module"}}),
            "/embedding/module",
        ),
        (
            json!({"rerank": {"module": "fed:short:synapse"}}),
            "/rerank/module",
        ),
        (
            json!({"dreamer": {"tasks": {"verify": {"schedule": "every day"}}}}),
            "/dreamer/tasks/verify/schedule",
        ),
        (json!({"clock_note": "99999999999999999h"}), "/clock_note"),
        (
            json!({"rerank": {"api_key": {"kind": "vault", "key": {"vault_ref": "a}b"}}}}),
            "/rerank/api_key",
        ),
    ] {
        let reply = review(&user, None, Path::new(USER_FILE));
        assert_eq!(reply.refusals.len(), 1, "{user}");
        assert_eq!(reply.refusals[0].paths, [pointer], "{user}");
    }
    // What the schema refuses is refused at its pointer.
    for (user, pointer) in [
        (json!({"clock_note": false}), "/clock_note"),
        (json!({"made_up": 1}), "/made_up"),
        (
            json!({"embedding": {"api_key": "sk-literal"}}),
            "/embedding/api_key",
        ),
    ] {
        let reply = review(&user, None, Path::new(USER_FILE));
        assert_eq!(reply.refusals.len(), 1, "{user}");
        assert_eq!(reply.refusals[0].paths, [pointer], "{user}");
        assert_eq!(reply.refusals[0].code, "value_invalid", "{user}");
    }
}

#[test]
fn a_review_names_one_change_per_changed_field_and_hides_keys() {
    let base = view(
        json!({"execute_threshold_percentage": {"default": 70}, "language": "tr"}),
        3,
    );
    let user = json!({
        "execute_threshold_percentage": {"default": 70, "openai/gpt-5": 60},
        "language": "tr",
        "rerank": {"enabled": false},
        "embedding": {"api_key": {"kind": "vault", "key": {"vault_ref": "openai"}}}
    });
    let reply = review(&user, Some(base), Path::new(USER_FILE));
    assert!(reply.refusals.is_empty(), "{:?}", reply.refusals);
    let mut paths: Vec<&str> = reply
        .fields
        .iter()
        .map(|field| field.path.as_str())
        .collect();
    paths.sort_unstable();
    assert_eq!(
        paths,
        [
            "/embedding/api_key",
            "/execute_threshold_percentage",
            "/rerank/enabled"
        ]
    );
    for field in &reply.fields {
        assert_eq!(field.apply, ApplyKind::Live);
        assert_eq!(field.new_source, Layer::User, "{}", field.path);
    }
    let enabled = reply
        .fields
        .iter()
        .find(|field| field.path == "/rerank/enabled")
        .unwrap();
    assert_eq!(enabled.old_source, Layer::Default);
    let key = reply
        .fields
        .iter()
        .find(|field| field.path == "/embedding/api_key")
        .unwrap();
    assert!(
        !serde_json::to_string(&key.new).unwrap().contains("openai"),
        "a credential is recorded by digest only"
    );
    // With no view in force, every field that has a value is a change from
    // nothing; a union nobody set has none.
    let first = review(&user, None, Path::new(USER_FILE));
    let effective = view(user.clone(), 1).effective;
    let valued = super::review::fields()
        .iter()
        .filter(|field| effective.pointer(&field.pointer).is_some())
        .count();
    assert_eq!(first.fields.len(), valued);
    assert!(valued < super::review::fields().len());
    // The same settings again change nothing.
    let base = view(user.clone(), 4);
    assert!(review(&user, Some(base), Path::new(USER_FILE))
        .fields
        .is_empty());
}
