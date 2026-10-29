//! Budget selection at the HARD boundary. Replay sources bypass selection entirely.

use super::*;
use mc_store::memory_levels::{Owner, Placement};

pub const PROJECT_FLOOR: f64 = 0.40;
pub const WORKSPACE_FLOOR: f64 = 0.30;

#[derive(Default)]
pub struct PlacementSnapshot {
    pub workspace_id: Option<String>,
    pub pin: Option<serde_json::Value>,
    pub rows: Vec<(mc_store::StoredMemory, Placement)>,
    /// Recorded owners replace live placement during a marker probe.
    pub replay_owners: Option<HashMap<i64, Owner>>,
}

fn category_visible(category: &serde_json::Value, origin: &str, session_profile: &str) -> bool {
    let same_profile = origin == session_profile;
    (category["visibility"] == "all-profiles" || same_profile)
        && (category["sensitive"] != true || same_profile)
}

/// Placement can remove a row from the legacy pool, but only the pinned
/// workspace and a known category can grant workspace visibility.
pub fn visible_rows(
    legacy: &[mc_store::StoredMemory],
    placement: &PlacementSnapshot,
) -> (Vec<mc_store::StoredMemory>, HashMap<i64, Owner>) {
    if let Some(owners) = &placement.replay_owners {
        let rows = legacy
            .iter()
            .filter(|row| {
                owners.get(&row.id).is_none_or(|owner| {
                    owner.kind == "workspace"
                        && Some(owner.id.as_str()) == placement.workspace_id.as_deref()
                })
            })
            .cloned()
            .collect();
        return (rows, owners.clone());
    }
    let placed_ids: HashSet<_> = placement.rows.iter().map(|(row, _)| row.id).collect();
    let mut rows: Vec<_> = legacy
        .iter()
        .filter(|row| !placed_ids.contains(&row.id))
        .cloned()
        .collect();
    let mut owners = HashMap::new();
    if placement.rows.is_empty() {
        return (rows, owners);
    }
    // Bundled SWE is the only installed domain profile supported by the session
    // resolver. Unknown origin categories fail closed rather than inheriting a tag.
    let profile = crate::memory_profile::documents::bundled_swe().ok();
    let session_profile = placement
        .pin
        .as_ref()
        .and_then(|pin| pin["profile"]["name"].as_str());
    for (row, placed) in &placement.rows {
        if placed.level != "workspace"
            || placed.owner.kind != "workspace"
            || Some(placed.owner.id.as_str()) != placement.workspace_id.as_deref()
        {
            continue;
        }
        let Some(origin) = &placed.origin_profile else {
            continue;
        };
        let Some(category_id) = placed.origin_category.as_deref() else {
            continue;
        };
        let Some(category) = profile
            .as_ref()
            .and_then(|profile| profile.body["categories"].as_array())
            .and_then(|categories| {
                categories
                    .iter()
                    .find(|category| category["id"] == category_id)
            })
        else {
            continue;
        };
        if !session_profile.is_some_and(|session| category_visible(category, &origin.name, session))
        {
            continue;
        }
        rows.push(row.clone());
        owners.insert(row.id, placed.owner.clone());
    }
    (rows, owners)
}

struct LevelBudget {
    categories: HashSet<String>,
    used: f64,
    wrapper: String,
}

impl LevelBudget {
    fn cost(
        &self,
        row: &mc_store::StoredMemory,
        names: &HashMap<i64, String>,
        estimate: impl Fn(&str) -> usize + Copy,
    ) -> f64 {
        let no_attribution = HashMap::new();
        let names = if self.wrapper.starts_with("<workspace-memory ") {
            &no_attribution
        } else {
            names
        };
        memory_candidate_cost(row, &self.categories, names, estimate)
            + if self.categories.is_empty() {
                estimate(&self.wrapper) as f64
            } else {
                0.0
            }
    }
}

#[allow(clippy::too_many_arguments)]
pub fn select(
    rows: Vec<mc_store::StoredMemory>,
    owners: &HashMap<i64, Owner>,
    workspace: Option<&str>,
    membership: Option<&mc_store::WorkspaceMembership>,
    names: &HashMap<i64, String>,
    budget: f64,
    estimate: impl Fn(&str) -> usize + Copy,
) -> Vec<mc_store::StoredMemory> {
    let level = |row: &mc_store::StoredMemory| usize::from(owners.contains_key(&row.id));
    if !rows.iter().any(|row| level(row) == 1) {
        return super::trim_memories_to_budget(rows, membership, names, budget, estimate);
    }
    let mixed = rows.iter().any(|row| level(row) == 0);
    let mut ordered = rows;
    if !mixed {
        ordered.sort_by(super::memory_selection_order);
    } else {
        ordered.sort_by(|left, right| {
            // The mixed-level tie is independent of insertion order, including equal recency.
            let mut left_key = left.clone();
            let mut right_key = right.clone();
            left_key.id = 0;
            right_key.id = 0;
            super::memory_selection_order(&left_key, &right_key)
                .then_with(|| level(left).cmp(&level(right)))
                .then_with(|| left.id.cmp(&right.id))
        });
    }
    let mut levels = [
        LevelBudget {
            categories: HashSet::new(),
            used: 0.0,
            wrapper: "<project-memory>\n</project-memory>".into(),
        },
        LevelBudget {
            categories: HashSet::new(),
            used: 0.0,
            wrapper: format!(
                "<workspace-memory workspace=\"{}\">\n</workspace-memory>",
                workspace
                    .unwrap_or_default()
                    .replace('&', "&amp;")
                    .replace('<', "&lt;")
                    .replace('>', "&gt;")
                    .replace('"', "&quot;")
            ),
        },
    ];
    let budget = budget.max(1.0);
    let mut used = 0.0;
    let mut selected = Vec::new();
    let mut ids = HashSet::new();
    {
        let mut admit = |row: &mc_store::StoredMemory, limit: f64, level_limit: f64| {
            let state = &mut levels[level(row)];
            let cost = state.cost(row, names, estimate);
            if ids.contains(&row.id) || used + cost > limit || state.used + cost > level_limit {
                return false;
            }
            state.used += cost;
            used += cost;
            state.categories.insert(row.category.clone());
            ids.insert(row.id);
            selected.push(row.clone());
            true
        };
        for row in ordered.iter().filter(|row| row.status == "permanent") {
            admit(row, budget, f64::INFINITY);
        }
    }
    let remaining = (budget - used).max(0.0);
    let permanent_used = [levels[0].used, levels[1].used];
    if mixed {
        for index in 0..2 {
            let floor = remaining * [PROJECT_FLOOR, WORKSPACE_FLOOR][index];
            let mut member_used = HashMap::<String, f64>::new();
            let identities = membership
                .map(|m| m.union_identities.as_slice())
                .unwrap_or_default();
            // Legacy members share the project reservation, not the workspace reservation.
            let passes = if index == 0 && !identities.is_empty() {
                identities.len() + 1
            } else {
                1
            };
            for pass in 0..passes {
                for row in ordered
                    .iter()
                    .filter(|row| level(row) == index && row.status != "permanent")
                {
                    if ids.contains(&row.id) {
                        continue;
                    }
                    let cost = levels[index].cost(row, names, estimate);
                    if pass < passes - 1
                        && (row.project_path != identities[pass]
                            || member_used.get(&row.project_path).copied().unwrap_or(0.0) + cost
                                > floor / identities.len() as f64)
                    {
                        continue;
                    }
                    if levels[index].used + cost > permanent_used[index] + floor
                        || used + cost > budget
                    {
                        continue;
                    }
                    *member_used.entry(row.project_path.clone()).or_default() += cost;
                    levels[index].used += cost;
                    used += cost;
                    levels[index].categories.insert(row.category.clone());
                    ids.insert(row.id);
                    selected.push(row.clone());
                }
            }
        }
    }
    for row in ordered {
        if ids.contains(&row.id) {
            continue;
        }
        let state = &mut levels[level(&row)];
        let cost = state.cost(&row, names, estimate);
        if used + cost <= budget {
            used += cost;
            state.used += cost;
            state.categories.insert(row.category.clone());
            ids.insert(row.id);
            selected.push(row);
        }
    }
    selected
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: i64, cost: usize, project: &str) -> mc_store::StoredMemory {
        mc_store::StoredMemory {
            id,
            project_path: project.into(),
            category: "X".into(),
            content: format!("cost={cost}"),
            importance: Some(50),
            status: "active".into(),
            ..Default::default()
        }
    }
    fn owner() -> Owner {
        Owner {
            kind: "workspace".into(),
            id: "ws".into(),
        }
    }
    fn union() -> mc_store::WorkspaceMembership {
        mc_store::WorkspaceMembership {
            union_identities: vec!["a".into(), "b".into()],
            own_identity: "a".into(),
            share_categories: vec!["X".into()],
            display_name_by_path: Default::default(),
        }
    }
    fn estimate(text: &str) -> usize {
        if let Some((_, value)) = text.split_once("cost=") {
            value
                .chars()
                .take_while(char::is_ascii_digit)
                .collect::<String>()
                .parse()
                .unwrap()
        } else if text.starts_with("<project-memory>") {
            5
        } else if text.starts_with("<workspace-memory ") {
            7
        } else {
            3
        }
    }
    fn ids(rows: &[mc_store::StoredMemory]) -> Vec<i64> {
        rows.iter().map(|row| row.id).collect()
    }
    fn charge(rows: &[mc_store::StoredMemory], owners: &HashMap<i64, Owner>) -> f64 {
        let mut states = [
            LevelBudget {
                categories: HashSet::new(),
                used: 0.0,
                wrapper: "<project-memory>\n</project-memory>".into(),
            },
            LevelBudget {
                categories: HashSet::new(),
                used: 0.0,
                wrapper: "<workspace-memory workspace=\"ws\">\n</workspace-memory>".into(),
            },
        ];
        let mut cost = 0.0;
        for row in rows {
            let state = &mut states[usize::from(owners.contains_key(&row.id))];
            cost += state.cost(row, &HashMap::new(), estimate);
            state.categories.insert(row.category.clone());
        }
        cost
    }

    #[test]
    fn no_workspace_selection_uses_legacy_selector() {
        let mut permanent = row(3, 20, "a");
        permanent.status = "permanent".into();
        let rows = vec![row(2, 35, "b"), permanent, row(1, 70, "a")];
        for membership in [None, Some(union())] {
            let names = membership
                .as_ref()
                .map(|m| workspace_source_names(&rows, m))
                .unwrap_or_default();
            assert_eq!(
                select(
                    rows.clone(),
                    &HashMap::new(),
                    None,
                    membership.as_ref(),
                    &names,
                    100.0,
                    estimate
                ),
                super::super::trim_memories_to_budget(
                    rows.clone(),
                    membership.as_ref(),
                    &names,
                    100.0,
                    estimate
                ),
            );
        }
    }

    #[test]
    fn mixed_level_floors_order_and_charged_cost() {
        let fixtures = [
            (
                vec![
                    row(1, 25, "a"),
                    row(2, 10, "a"),
                    row(3, 20, "foreign"),
                    row(4, 28, "foreign"),
                ],
                vec![3, 4],
                false,
                vec![1, 3, 2],
                73.0,
            ),
            (
                vec![row(1, 60, "a"), row(2, 20, "foreign")],
                vec![2],
                false,
                vec![2, 1],
                98.0,
            ),
            (
                {
                    let mut p = row(1, 20, "a");
                    p.status = "permanent".into();
                    vec![p, row(2, 20, "a"), row(3, 15, "foreign")]
                },
                vec![3],
                false,
                vec![1, 2, 3],
                73.0,
            ),
            (
                vec![row(9, 35, "a"), row(1, 35, "foreign"), row(2, 35, "a")],
                vec![1],
                false,
                vec![2, 9],
                78.0,
            ),
            (
                vec![row(1, 23, "a"), row(2, 10, "b"), row(3, 20, "foreign")],
                vec![3],
                true,
                vec![2, 3, 1],
                71.0,
            ),
        ];
        for (rows, workspace_ids, legacy_union, expected, cost) in fixtures {
            let owners = workspace_ids.into_iter().map(|id| (id, owner())).collect();
            let membership = legacy_union.then(union);
            let actual = select(
                rows,
                &owners,
                Some("ws"),
                membership.as_ref(),
                &HashMap::new(),
                100.0,
                estimate,
            );
            assert_eq!(ids(&actual), expected);
            assert_eq!(charge(&actual, &owners), cost);
        }
    }

    #[test]
    fn single_level_70_20_20_keeps_large_row() {
        let estimate = |text: &str| {
            if text.contains("cost=") {
                estimate(text)
            } else {
                0
            }
        };
        let rows = vec![row(1, 70, "a"), row(2, 20, "a"), row(3, 20, "a")];
        for owners in [
            HashMap::new(),
            [(1, owner()), (2, owner()), (3, owner())].into(),
        ] {
            let selected = select(
                rows.clone(),
                &owners,
                Some("ws"),
                None,
                &HashMap::new(),
                100.0,
                estimate,
            );
            assert_eq!(ids(&selected), vec![1, 2]);
            assert_eq!(
                selected.iter().map(|r| estimate(&r.content)).sum::<usize>(),
                90
            );
        }
        let mut rows = vec![row(3, 20, "a"), row(2, 20, "a"), row(1, 20, "a")];
        for row in &mut rows {
            row.last_seen_at = Some(1);
        }
        let owners = [(1, owner()), (2, owner()), (3, owner())].into();
        let selected = select(
            rows,
            &owners,
            Some("ws"),
            None,
            &HashMap::new(),
            40.0,
            estimate,
        );
        assert_eq!(
            ids(&selected),
            vec![3, 2],
            "one-level equal-recency ties retain legacy input order"
        );
    }

    #[test]
    fn workspace_visibility_owner_profile_and_sensitive() {
        use mc_store::memory_levels::OriginProfile;
        let mut snapshot = PlacementSnapshot {
            workspace_id: Some("ws".into()),
            pin: Some(serde_json::json!({"profile":{"name":"@cortexkit/memory-swe"}})),
            ..Default::default()
        };
        for (id, category, origin, workspace) in [
            (1, "swe:engineering-practice", "@other/profile", "ws"),
            (2, "swe:constraints", "@other/profile", "ws"),
            (3, "swe:engineering-practice", "@cortexkit/memory-swe", "ws"),
            (4, "swe:constraints", "@cortexkit/memory-swe", "foreign-ws"),
        ] {
            snapshot.rows.push((
                row(id, 10, "foreign"),
                Placement {
                    level: "workspace".into(),
                    owner: Owner {
                        kind: "workspace".into(),
                        id: workspace.into(),
                    },
                    origin_profile: Some(OriginProfile {
                        name: origin.into(),
                        version: "1".into(),
                        digest: "digest".into(),
                    }),
                    origin_category: Some(category.into()),
                },
            ));
        }
        let (visible, _) = visible_rows(
            &snapshot
                .rows
                .iter()
                .map(|(r, _)| r.clone())
                .collect::<Vec<_>>(),
            &snapshot,
        );
        assert_eq!(ids(&visible), vec![2, 3]);
        assert!(!category_visible(
            &serde_json::json!({"visibility":"all-profiles","sensitive":true}),
            "other",
            "session"
        ));
    }

    fn pin_workspace(store: &McStore) {
        let mut loaded = store.load("ses").unwrap();
        loaded.meta.memory_context = Some(serde_json::json!({
            "workspace_id":"ws", "profile":{"name":"@cortexkit/memory-swe"}
        }));
        store
            .commit("ses", loaded.row_version, &loaded.core, &loaded.meta)
            .unwrap();
    }

    fn place(store: &McStore, id: i64, workspace: &str) {
        store.with_context_conn_for_test(|conn|conn.execute(
            "INSERT OR REPLACE INTO memory_placement(memory_id,level,owner_kind,owner_id,origin_profile_name,origin_profile_version,origin_profile_digest,origin_category,written_at) VALUES(?1,'workspace','workspace',?2,'@cortexkit/memory-swe','1','digest','swe:constraints',0)",
            rusqlite::params![id,workspace])).unwrap();
    }

    fn synthetic(response: &crate::transform::TransformResponse, index: usize) -> &str {
        crate::ck_wire::text_from_message(
            response
                .messages()
                .iter()
                .filter(|m| m.meta.synthetic)
                .nth(index)
                .unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn frozen_workspace_rows_defer_soft_and_marker_until_natural_hard() {
        use crate::transform::{
            tests::{item, memory_input, pctx, req, store},
            transform,
        };
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        pin_workspace(&s);
        let workspace = s
            .insert_memory(memory_input(
                "git:foreign",
                "CONSTRAINTS",
                "frozen workspace claim",
                0,
            ))
            .unwrap();
        let project = s
            .insert_memory(memory_input(
                "git:proj",
                "CONSTRAINTS",
                "frozen project claim",
                0,
            ))
            .unwrap();
        place(&s, workspace, "ws");
        s.replace_compartments(
            "ses",
            &[StoredCompartment {
                sequence: 1,
                start_message: 1,
                end_message: 1,
                end_message_id: "a#0".into(),
                title: "summary".into(),
                content: "summary".into(),
                p1: Some("summary".into()),
                importance: 50,
                ..Default::default()
            }],
        )
        .unwrap();
        let mut request = req(
            "ses",
            "cfg0",
            vec![item("a", 1, "raw"), item("tail", 2, "tail")],
        );
        let ctx = pctx("git:proj", "/nonexistent-docs", 0);
        let hard = transform(&s, &request, &ctx).unwrap();
        assert_eq!(hard.action, "HARD");
        let m0 = synthetic(&hard, 0).to_string();
        let m1 = synthetic(&hard, 1).to_string();
        assert!(m0.contains("frozen workspace claim"));
        assert!(
            m0.find("<workspace-memory workspace=\"ws\">").unwrap()
                < m0.find("<project-memory>").unwrap()
        );
        assert_eq!(m0.matches("frozen workspace claim").count(), 1);
        let before = s.load("ses").unwrap();
        assert_eq!(
            before
                .meta
                .memory_projection
                .as_ref()
                .unwrap()
                .rows
                .iter()
                .find(|shown| shown.memory.id == workspace)
                .unwrap()
                .owner,
            Some(owner())
        );
        place(&s, workspace, "other-ws");
        s.with_context_conn_for_test(|conn|conn.execute(
            "UPDATE memories SET importance=100,category='NAMING',content='pending claim',revision=revision+1 WHERE id IN (?1,?2)",
            rusqlite::params![workspace,project])).unwrap();
        let deferred = transform(&s, &request, &ctx).unwrap();
        assert_eq!(deferred.action, "SOFT+");
        assert_eq!(synthetic(&deferred, 0), m0);
        assert_eq!(synthetic(&deferred, 1), m1);
        s.arm_soft_refresh("ses").unwrap();
        let soft = transform(&s, &request, &ctx).unwrap();
        assert_eq!(soft.action, "SOFT");
        assert_eq!(synthetic(&soft, 0), m0);
        assert_eq!(synthetic(&soft, 1), m1);

        // A history marker probes cached rows, not live placement or current floors.
        s.with_context_conn_for_test(|conn|conn.execute("INSERT INTO m0_mutation_log(session_id,mutation_type,queued_at) VALUES('ses','compartment_delete',1)",[])).unwrap();
        let mut loaded = s.load("ses").unwrap();
        loaded.meta.project_memory_epoch_pending = true;
        s.commit("ses", loaded.row_version, &loaded.core, &loaded.meta)
            .unwrap();
        let marker = transform(&s, &request, &ctx).unwrap();
        assert!(!marker.prefix_bust_permitted);
        assert_eq!(synthetic(&marker, 0), m0);
        assert_eq!(synthetic(&marker, 1), m1);
        request.render_config = "natural-hard".into();
        let next = transform(&s, &request, &ctx).unwrap();
        assert_eq!(next.action, "HARD");
        assert!(!synthetic(&next, 0).contains("frozen workspace claim"));
        assert!(synthetic(&next, 0).contains("pending claim"));
    }

    #[test]
    fn old_id_workspace_placement_waits_for_hard_without_pressure() {
        use crate::transform::{
            tests::{item, memory_input, pctx, req, store},
            transform,
        };
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        pin_workspace(&s);
        let old = s
            .insert_memory(memory_input(
                "git:foreign",
                "CONSTRAINTS",
                "old workspace candidate",
                0,
            ))
            .unwrap();
        s.insert_memory(memory_input(
            "git:proj",
            "CONSTRAINTS",
            "project baseline",
            0,
        ))
        .unwrap();
        let mut request = req("ses", "cfg0", vec![item("tail", 1, "tail")]);
        let ctx = pctx("git:proj", "/nonexistent-docs", 0);
        let hard = transform(&s, &request, &ctx).unwrap();
        let before = s.load("ses").unwrap();
        assert!(old <= before.meta.max_memory_id);
        let snapshot = s.load_memory_render_snapshot("git:proj", None, 0).unwrap();
        for _ in 0..5000 {
            place(&s, old, "ws");
        }
        let after = s.load_memory_render_snapshot("git:proj", None, 0).unwrap();
        assert_eq!(snapshot, after);
        let unchanged = s.load("ses").unwrap();
        assert_eq!(unchanged.meta, before.meta);
        assert_eq!(unchanged.core, before.core);
        assert_eq!(unchanged.row_version, before.row_version);
        let mutation_count = s
            .with_context_conn_for_test(|conn| {
                conn.query_row("SELECT COUNT(*) FROM memory_mutation_log", [], |row| {
                    row.get::<_, i64>(0)
                })
            })
            .unwrap();
        assert_eq!(mutation_count, 0);
        s.arm_soft_refresh("ses").unwrap();
        let soft = transform(&s, &request, &ctx).unwrap();
        assert_eq!(soft.action, "SOFT");
        assert_eq!(synthetic(&soft, 0), synthetic(&hard, 0));
        assert!(!synthetic(&soft, 1).contains("old workspace candidate"));
        request.render_config = "natural-hard".into();
        let next = transform(&s, &request, &ctx).unwrap();
        assert!(synthetic(&next, 0).contains("old workspace candidate"));
        assert!(!synthetic(&next, 1).contains("old workspace candidate"));
    }

    #[test]
    fn legacy_projection_without_owner_round_trips_bytes() {
        use mc_store::memory_projection::AppliedProjection;
        // Literal legacy JSON omits ownership rather than deriving the expected
        // bytes from the serializer under test.
        let bytes = r#"{"generation":0,"m0_sha256":"","hard_memory_block":"","fragment_watermark":0,"committed":[],"rows":[{"memory":{"id":1,"project_path":"a","category":"X","content":"legacy","importance":50,"status":"active","expires_at":null,"superseded_by_memory_id":null,"updated_at":0,"last_seen_at":null,"verified_at":null},"revision":1,"representation":"text"}],"user_profile":[],"legacy":false}"#;
        let projection: AppliedProjection = serde_json::from_str(bytes).unwrap();
        assert_eq!(projection.rows[0].owner, None);
        assert_eq!(serde_json::to_string(&projection).unwrap(), bytes);
    }

    #[test]
    fn legacy_placement_read_does_not_touch_missing_table() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        assert!(mc_store::single_store_schema::read_workspace_memory_rows(
            &conn,
            &mc_store::single_store_schema::LEGACY_TABLES,
            0
        )
        .unwrap()
        .is_empty());
    }
}
