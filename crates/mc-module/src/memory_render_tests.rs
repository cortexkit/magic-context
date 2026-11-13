use super::*;

const DAY: i64 = 86_400_000;
const NOW: i64 = 1_000 * DAY;

/// A project memory costing 10 tokens, with free tags and wrapper.
fn row(id: i64, importance: i64) -> Candidate {
    Candidate {
        id,
        level: Level::Project,
        source_project: None,
        category: "swe:constraints".into(),
        importance: Some(importance),
        permanent: false,
        policy: false,
        safety_critical: false,
        decay: Decay::Stable,
        last_met_ms: Some(NOW),
        expires_at_ms: None,
        resolved: false,
        overrides: None,
        line_tokens: 10,
        category_tokens: 0,
        block_tokens: 0,
    }
}

fn budget(total: u64) -> Budget {
    Budget {
        total_tokens: total,
        protected_tokens: 0,
        level_minimum_tokens: BTreeMap::new(),
        half_life_ms: 30 * DAY,
    }
}

#[test]
fn higher_importance_wins_and_the_same_input_gives_the_same_selection() {
    let rows = [row(1, 40), row(2, 90), row(3, 70)];
    let first = select(&rows, &budget(20), NOW);
    assert_eq!(first.ids, [2, 3]);
    assert_eq!(first.tokens, 20);
    assert_eq!(select(&rows, &budget(20), NOW), first);
}

#[test]
fn permanent_and_policy_memories_come_before_any_ranked_one() {
    let mut low = row(1, 5);
    low.permanent = true;
    let mut policy = row(2, 1);
    policy.policy = true;
    let rows = [row(3, 99), low, policy];
    // Both come first; between them, rank still orders.
    assert_eq!(select(&rows, &budget(20), NOW).ids, [1, 2]);
}

#[test]
fn a_drifting_memory_halves_every_half_life_since_it_was_last_met() {
    let mut old = row(1, 80);
    old.decay = Decay::Drifting;
    old.last_met_ms = Some(NOW - 60 * DAY); // two half-lives: 80 -> 20
    let rows = [old.clone(), row(2, 30)];
    assert_eq!(select(&rows, &budget(10), NOW).ids, [2]);
    // Met again recently, it ranks on its full importance.
    old.last_met_ms = Some(NOW);
    assert_eq!(select(&[old, row(2, 30)], &budget(10), NOW).ids, [1]);
}

#[test]
fn a_safety_critical_rule_does_not_decay() {
    let stale_critical = |id, importance| {
        let mut row = row(id, importance);
        row.decay = Decay::Drifting;
        row.safety_critical = true;
        row.last_met_ms = Some(NOW - 360 * DAY);
        row
    };
    let mut budget = budget(10);
    budget.protected_tokens = 10;
    // Decayed, the year-old rule (85 -> about 5) would lose to the fresh 80.
    let mut fresh = row(2, 80);
    fresh.safety_critical = true;
    assert_eq!(
        select(&[stale_critical(1, 85), fresh], &budget, NOW).ids,
        [1]
    );
}

#[test]
fn a_bounded_memory_is_shown_until_its_end_and_a_resolved_one_not_at_all() {
    let mut bounded = row(1, 50);
    bounded.decay = Decay::Bounded;
    bounded.expires_at_ms = Some(NOW + 1);
    assert_eq!(select(&[bounded.clone()], &budget(100), NOW).ids, [1]);
    bounded.expires_at_ms = Some(NOW);
    assert!(select(&[bounded], &budget(100), NOW).ids.is_empty());
    let mut open = row(2, 50);
    open.decay = Decay::OpenUntilResolved;
    open.resolved = true;
    assert!(select(&[open], &budget(100), NOW).ids.is_empty());
}

#[test]
fn an_override_hides_the_memory_it_names() {
    let mut narrower = row(2, 10);
    narrower.overrides = Some(1);
    assert_eq!(select(&[row(1, 90), narrower], &budget(100), NOW).ids, [2]);
}

#[test]
fn critical_rules_fill_their_slice_before_anything_else() {
    let mut critical = row(1, 20);
    critical.safety_critical = true;
    let mut budget = budget(10);
    budget.protected_tokens = 10;
    // Without the slice the higher importance would take the only room.
    assert_eq!(
        select(&[row(2, 90), critical.clone()], &budget, NOW).ids,
        [1]
    );
    budget.protected_tokens = 0;
    assert_eq!(select(&[row(2, 90), critical], &budget, NOW).ids, [2]);
}

#[test]
fn each_level_gets_its_minimum_and_an_unused_minimum_goes_to_the_pool() {
    let mut global = row(10, 10);
    global.level = Level::Global;
    let rows = [row(1, 90), row(2, 80), row(3, 70), global];
    let mut budget = budget(30);
    budget.level_minimum_tokens = BTreeMap::from([(Level::Global, 10), (Level::Project, 10)]);
    // The low-importance global memory keeps its minimum.
    assert_eq!(select(&rows, &budget, NOW).ids, [1, 2, 10]);
    // With no global memory, its minimum goes to project rows.
    assert_eq!(select(&rows[..3], &budget, NOW).ids, [1, 2, 3]);
}

#[test]
fn inside_the_workspace_share_each_project_gets_an_equal_part() {
    let sibling = |id, importance, project: &str| {
        let mut row = row(id, importance);
        row.level = Level::Workspace;
        row.source_project = Some(project.into());
        row
    };
    let rows = [
        sibling(1, 90, "pj-a"),
        sibling(2, 85, "pj-a"),
        sibling(3, 80, "pj-a"),
        sibling(4, 20, "pj-b"),
    ];
    let mut budget = budget(20);
    budget.level_minimum_tokens = BTreeMap::from([(Level::Workspace, 20)]);
    // pj-b's one low-ranked memory keeps its half of the share.
    assert_eq!(select(&rows, &budget, NOW).ids, [1, 4]);
}

#[test]
fn a_row_that_does_not_fit_is_skipped_and_category_tags_are_paid_once() {
    let mut big = row(1, 90);
    big.line_tokens = 50;
    let mut tagged = [row(2, 80), row(3, 70)];
    for row in &mut tagged {
        row.category_tokens = 5;
        row.block_tokens = 3;
    }
    let rows = [big, tagged[0].clone(), tagged[1].clone()];
    let selection = select(&rows, &budget(30), NOW);
    // 3 + 5 + 10 for the first, 10 for the second.
    assert_eq!(selection.ids, [2, 3]);
    assert_eq!(selection.tokens, 28);
}

#[test]
fn critical_rules_never_take_the_user_profile_s_minimum() {
    let critical = |id| {
        let mut row = row(id, 90);
        row.safety_critical = true;
        row
    };
    let profile = |id| {
        let mut row = row(id, 30);
        row.level = Level::Global;
        row
    };
    let rows = [
        critical(1),
        critical(2),
        critical(3),
        profile(10),
        profile(11),
    ];
    let mut budget = budget(30);
    budget.protected_tokens = 30;
    budget.level_minimum_tokens = BTreeMap::from([(Level::Global, 20)]);
    // Critical rules alone would fill all 30; the profile keeps its 20 and the
    // other two rules go to the mural.
    assert_eq!(select(&rows, &budget, NOW).ids, [1, 10, 11]);
    // A profile of one line holds back only its 10, so two rules fit.
    assert_eq!(select(&rows[..4], &budget, NOW).ids, [1, 2, 10]);
    // With no profile at all, nothing is held back.
    assert_eq!(select(&rows[..3], &budget, NOW).ids, [1, 2, 3]);
}

#[test]
fn unscored_profile_lines_show_oldest_first() {
    let profile = |id, met_days_ago| {
        let mut row = row(id, 0);
        row.level = Level::Global;
        row.importance = None;
        row.last_met_ms = Some(NOW - met_days_ago * DAY);
        row
    };
    // Line 3 was met most recently, but lines 1 and 2 were learned first.
    let rows = [profile(3, 0), profile(2, 5), profile(1, 9)];
    assert_eq!(select(&rows, &budget(20), NOW).ids, [1, 2]);
    // Unscored project memories still go most recently met first.
    let mut project = rows.clone();
    for row in &mut project {
        row.level = Level::Project;
    }
    assert_eq!(select(&project, &budget(20), NOW).ids, [3, 2]);
    // Mixed with a project memory of the same rank met in between, the
    // profile lines stay a group in age order, and the order is total.
    let mut between = row(4, 50);
    between.last_met_ms = Some(NOW - 7 * DAY);
    let mixed = [profile(3, 0), between, profile(2, 5), profile(1, 9)];
    assert_eq!(select(&mixed, &budget(40), NOW).ids, [4, 1, 2, 3]);
}
