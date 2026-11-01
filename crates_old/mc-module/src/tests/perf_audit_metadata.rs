use super::*;

#[test]
fn empty_pending_drop_helpers_skip_frozen_and_projection_indexes() {
    let core = CoreState::default();
    let projection = ck_wire::project_messages(&[]).unwrap();
    crate::per_pass_profile::begin_pass();
    assert!(!pending_agent_drops_applied_this_pass(&[], &core, &core));
    assert!(first_applied_pending_command_ids(&[], &core, &core).is_empty());
    assert!(consumed_pending_drop_ids(&[], &core, &core, &projection, None).is_empty());
    let costs = crate::per_pass_profile::end_pass();
    assert!(
        !costs.contains_key("rt12_red_targets"),
        "an empty queue must not build frozen indexes"
    );
}
