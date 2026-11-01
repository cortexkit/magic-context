//! ck-mc serves through the subc SDK, which decodes every route bind it
//! receives, scope stamp included, before any ck-mc code runs. Before subc
//! 0.29 and subc-client-rs 0.26.1, a stamp carrying an attribute the linked
//! protocol did not know (`flow_id`) failed that decode and ended `serve()`,
//! stopping the whole module. These tests pin that the linked protocol knows
//! `flow_id` and still refuses attributes it does not know, so a lockfile
//! regression to an older protocol fails here instead of in production.

use subc_protocol::scope::ScopeAttributes;

#[test]
fn scope_attributes_with_a_flow_id_decode() {
    let attributes: ScopeAttributes = serde_json::from_value(serde_json::json!({
        "agent_id": "agent-1",
        "delegates": true,
        "flow_id": "flow-nightly-triage",
    }))
    .expect("the linked subc-protocol must decode a scope stamp carrying flow_id");
    assert_eq!(attributes.flow_id.as_deref(), Some("flow-nightly-triage"));
    assert_eq!(attributes.agent_id.as_deref(), Some("agent-1"));
}

#[test]
fn scope_attributes_still_refuse_an_unknown_attribute() {
    let error = serde_json::from_value::<ScopeAttributes>(serde_json::json!({
        "flow_id": "flow-nightly-triage",
        "not_a_real_attribute": true,
    }))
    .expect_err("unknown scope attributes must still be refused");
    assert!(
        error.to_string().contains("not_a_real_attribute"),
        "the refusal should name the unknown attribute: {error}"
    );
}
