//! Persisted tool-tag protection window and coordinate-safe consumer projections.
//!
//! The canonical member set is computed without consulting the live projection. Consumers that
//! operate on projected blocks receive persisted block identities; consumers that operate in tag
//! number space receive the separately typed tag-number set or cutoff.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};

use mc_store::McTagRow;
use serde::{Deserialize, Serialize};

/// A persisted tag number. Keeping this distinct from projection ordinals prevents accidental
/// cross-coordinate comparisons.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TagNumber(pub i64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CoordinateSpace {
    TagNumber,
    RowIdentity,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagNumberProjection {
    pub coordinate_space: CoordinateSpace,
    pub tag_numbers: HashSet<TagNumber>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RowIdentityProjection {
    pub coordinate_space: CoordinateSpace,
    pub block_ids: HashSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagNumberCutoffProjection {
    pub coordinate_space: CoordinateSpace,
    pub cutoff: Option<TagNumber>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtectionWindowStatus {
    pub floor: u64,
    pub protected_count: usize,
    pub protected_mass: u64,
}

/// All coordinate-tagged consumer views derived from one canonical member-row union.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtectionWindow {
    pub member_rows: Vec<McTagRow>,
    pub tag_numbers: TagNumberProjection,
    pub row_identities: RowIdentityProjection,
    pub cutoff: TagNumberCutoffProjection,
    pub status: ProtectionWindowStatus,
}

impl ProtectionWindow {
    /// Walk persisted tool rows in reverse `(tag_number, block_id)` order. A complete tag-number
    /// tie group is accumulated before testing the floor, then the mass suffix is unioned with the
    /// newest three distinct tool-tag groups.
    pub fn from_persisted_rows(rows: &[McTagRow], floor: u64) -> Self {
        Self::from_persisted_rows_calibrated(rows, floor, 1.0)
    }

    /// Multiply stored local counts by the tool ratio before comparing with the
    /// provider-token protection floor; never overwrite the original member rows.
    pub fn from_persisted_rows_calibrated(rows: &[McTagRow], floor: u64, tools_ratio: f64) -> Self {
        let mut tool_rows = rows
            .iter()
            .filter(|row| is_tool_kind(&row.kind))
            .collect::<Vec<_>>();
        tool_rows.sort_unstable_by(|left, right| {
            left.tag_number
                .cmp(&right.tag_number)
                .then_with(|| left.block_id.cmp(&right.block_id))
        });

        if tool_rows.is_empty() {
            return Self::empty(floor);
        }

        let mut cumulative_mass = 0u64;
        let mut mass_cutoff = None;
        let mut structural_cutoff = None;
        let mut group_count = 0usize;
        let mut end = tool_rows.len();
        while end > 0 {
            let tag_number = tool_rows[end - 1].tag_number;
            let mut start = end - 1;
            while start > 0 && tool_rows[start - 1].tag_number == tag_number {
                start -= 1;
            }
            cumulative_mass = tool_rows[start..end]
                .iter()
                .fold(cumulative_mass, |sum, row| {
                    sum.saturating_add(row_mass(row))
                });
            group_count += 1;
            if group_count <= 3 {
                structural_cutoff = Some(TagNumber(tag_number));
            }
            if mass_cutoff.is_none()
                && ((cumulative_mass as f64 * tools_ratio).ceil() >= floor as f64 || start == 0)
            {
                mass_cutoff = Some(TagNumber(tag_number));
            }
            end = start;
            if mass_cutoff.is_some() && (group_count >= 3 || end == 0) {
                break;
            }
        }

        let cutoff = match (mass_cutoff, structural_cutoff) {
            (Some(mass), Some(minimum)) => Some(mass.min(minimum)),
            (mass, minimum) => mass.or(minimum),
        };
        let member_rows = cutoff.map_or_else(Vec::new, |cutoff| {
            tool_rows
                .into_iter()
                .filter(|row| row.tag_number >= cutoff.0)
                .cloned()
                .collect()
        });
        let mut window = Self::from_members(floor, cutoff, member_rows);
        window.status.protected_mass =
            (window.status.protected_mass as f64 * tools_ratio).ceil() as u64;
        window
    }

    fn empty(floor: u64) -> Self {
        Self::from_members(floor, None, Vec::new())
    }

    fn from_members(floor: u64, cutoff: Option<TagNumber>, member_rows: Vec<McTagRow>) -> Self {
        let mut tag_numbers = HashSet::with_capacity(member_rows.len());
        let mut block_ids = HashSet::with_capacity(member_rows.len());
        let mut protected_mass = 0u64;
        for row in &member_rows {
            tag_numbers.insert(TagNumber(row.tag_number));
            block_ids.insert(row.block_id.clone());
            protected_mass = protected_mass.saturating_add(row_mass(row));
        }
        Self {
            status: ProtectionWindowStatus {
                floor,
                protected_count: member_rows.len(),
                protected_mass,
            },
            member_rows,
            tag_numbers: TagNumberProjection {
                coordinate_space: CoordinateSpace::TagNumber,
                tag_numbers,
            },
            row_identities: RowIdentityProjection {
                coordinate_space: CoordinateSpace::RowIdentity,
                block_ids,
            },
            cutoff: TagNumberCutoffProjection {
                coordinate_space: CoordinateSpace::TagNumber,
                cutoff,
            },
        }
    }
}

/// Output-token mass only. Store reads coalesce legacy NULL counts to zero; defensive negative
/// values also contribute zero, matching the shared host walk.
pub fn row_mass(row: &McTagRow) -> u64 {
    u64::try_from(row.token_count).unwrap_or(0)
}

pub fn is_tool_kind(kind: &str) -> bool {
    matches!(kind, "tool" | "tool_call" | "tool_result")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FloorPass {
    Defer,
    CacheBust,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FloorSnapshotResolution {
    pub effective: u64,
    pub persisted: Option<u64>,
    pub source: &'static str,
}

type PreSnapshotInputsBySession = HashMap<(u64, String), (u64, u64)>;
static PRE_SNAPSHOT_INPUTS: OnceLock<Mutex<PreSnapshotInputsBySession>> = OnceLock::new();

fn pre_snapshot_tuple_changed(previous: Option<(u64, u64)>, current: (u64, u64)) -> bool {
    previous.is_some_and(|previous| previous != current)
}

/// Inspect the same pre-epoch tuple the engine records, without recording an
/// observation. A preflight must leave a changed tuple visible to the engine.
pub fn pre_snapshot_inputs_would_change(
    store_namespace: u64,
    session: &str,
    floor: u64,
    usable_soft: u64,
) -> bool {
    let previous = PRE_SNAPSHOT_INPUTS.get().and_then(|inputs| {
        inputs
            .lock()
            .expect("pre-snapshot inputs mutex")
            .get(&(store_namespace, session.to_string()))
            .copied()
    });
    pre_snapshot_tuple_changed(previous, (floor, usable_soft))
}

/// Remember only pre-epoch inputs, without writing durable state. Changed inputs must be surfaced
/// as a bust; after a restart the first observation is computed from the same config and geometry.
pub fn pre_snapshot_inputs_changed(
    store_namespace: u64,
    session: &str,
    floor: u64,
    usable_soft: u64,
) -> bool {
    let previous = PRE_SNAPSHOT_INPUTS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .expect("pre-snapshot inputs mutex")
        .insert((store_namespace, session.to_string()), (floor, usable_soft));
    pre_snapshot_tuple_changed(previous, (floor, usable_soft))
}

pub fn pre_snapshot_floor(store_namespace: u64, session: &str) -> Option<u64> {
    PRE_SNAPSHOT_INPUTS
        .get()?
        .lock()
        .expect("pre-snapshot inputs mutex")
        .get(&(store_namespace, session.to_string()))
        .map(|(floor, _)| *floor)
}

/// Resolve the module-owned floor for hosts that omit their resolved snapshot.
/// A defer may read the durable floor but cannot create or replace it.
pub fn resolve_floor_snapshot(
    host_effective: Option<u64>,
    persisted: Option<u64>,
    module_candidate: u64,
    pass: FloorPass,
) -> FloorSnapshotResolution {
    if let Some(effective) = host_effective.filter(|floor| *floor > 0) {
        return FloorSnapshotResolution {
            effective,
            // The host owns the epoch; mirror its resolved scalar for asynchronous facade replies.
            persisted: Some(effective),
            source: "host",
        };
    }
    match pass {
        FloorPass::CacheBust => FloorSnapshotResolution {
            effective: module_candidate,
            persisted: Some(module_candidate),
            source: "module-snapshot",
        },
        FloorPass::Defer => FloorSnapshotResolution {
            effective: persisted.unwrap_or(module_candidate),
            persisted,
            source: if persisted.is_some() {
                "module-snapshot"
            } else {
                "module-derived-ephemeral"
            },
        },
    }
}

/// Derive the hostless default from the usable soft geometry.
pub fn derive_default_floor(usable_soft: u64) -> u64 {
    let usable_soft = usable_soft.max(1);
    let rounded_five_percent = ((usable_soft as f64) * 0.05).round() as u64;
    let lower_bound = 16_000u64.min(((usable_soft as f64) * 0.08).round() as u64);
    rounded_five_percent.clamp(lower_bound, 64_000)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(tag_number: i64, block_id: &str, kind: &str, token_count: i64) -> McTagRow {
        McTagRow {
            tag_number,
            block_id: block_id.to_string(),
            kind: kind.to_string(),
            token_count,
            created_at_ms: 0,
            source_bytes: Default::default(),
        }
    }

    #[test]
    fn pre_snapshot_peek_preserves_missing_floor_and_window_observations() {
        let namespace = u64::MAX;
        let session = "read-only-pre-snapshot-proof";
        assert!(!pre_snapshot_inputs_would_change(
            namespace, session, 4000, 100000
        ));
        assert!(!pre_snapshot_inputs_would_change(
            namespace, session, 5000, 80000
        ));
        assert!(
            !pre_snapshot_inputs_changed(namespace, session, 4000, 100000),
            "a peek must not create an observation"
        );
        let mut previous = (4000, 100000);
        for current in [(4000, 100000), (5000, 100000), (4000, 80000), (6000, 90000)] {
            let expected = previous != current;
            for _ in 0..3 {
                assert_eq!(
                    pre_snapshot_inputs_would_change(namespace, session, current.0, current.1),
                    expected
                );
            }
            assert_eq!(
                pre_snapshot_inputs_changed(namespace, session, current.0, current.1),
                expected
            );
            assert!(!pre_snapshot_inputs_would_change(
                namespace, session, current.0, current.1
            ));
            previous = current;
        }
    }

    #[test]
    fn tie_crossing_and_structural_minimum_are_atomic() {
        let rows = vec![
            row(7, "old", "tool_result", 1),
            row(8, "minimum", "tool_result", 1),
            row(9, "z", "tool_call", 6),
            row(9, "a", "tool_result", 6),
            row(10, "new", "tool_result", 5),
        ];
        let window = ProtectionWindow::from_persisted_rows(&rows, 8);
        assert_eq!(window.cutoff.cutoff, Some(TagNumber(8)));
        assert_eq!(
            window.row_identities.block_ids,
            HashSet::from([
                "minimum".to_string(),
                "z".to_string(),
                "a".to_string(),
                "new".to_string(),
            ])
        );
        assert_eq!(window.status.protected_count, 4);
        assert_eq!(window.status.protected_mass, 18);
    }

    #[test]
    fn empty_window_has_absent_cutoff_not_a_numeric_sentinel() {
        let rows = vec![row(1, "message", "message", 99)];
        let window = ProtectionWindow::from_persisted_rows(&rows, 16_000);
        assert_eq!(window.cutoff.cutoff, None);
        assert!(window.tag_numbers.tag_numbers.is_empty());
        assert!(window.row_identities.block_ids.is_empty());
        assert_eq!(window.status.protected_count, 0);
        assert_eq!(window.status.protected_mass, 0);
    }

    #[test]
    fn growing_mass_contracts_or_holds_without_source_byte_reentry() {
        let rows = (1..=10)
            .map(|n| McTagRow {
                created_at_ms: 100 - n,
                ..row(n, &format!("r{n}"), "tool", 4_000)
            })
            .collect::<Vec<_>>();
        let before = ProtectionWindow::from_persisted_rows(&rows, 16_000);
        assert_eq!(before.cutoff.cutoff, Some(TagNumber(7)));
        for (tag_number, mass, expected_cutoff) in [
            (10, 8_000, 8),
            (10, 4_001, 7),
            (7, 8_000, 7),
            (6, 8_000, 7),
            (10, 80_000, 8),
        ] {
            let mut raised = rows.clone();
            raised[(tag_number - 1) as usize].token_count = mass;
            let after = ProtectionWindow::from_persisted_rows(&raised, 16_000);
            assert_eq!(after.cutoff.cutoff, Some(TagNumber(expected_cutoff)));
            assert!(after
                .row_identities
                .block_ids
                .is_subset(&before.row_identities.block_ids));
        }
        let mut null_backfill = rows.clone();
        null_backfill[8].token_count = 0;
        assert_eq!(
            ProtectionWindow::from_persisted_rows(&null_backfill, 16_000)
                .cutoff
                .cutoff,
            Some(TagNumber(6))
        );
        null_backfill[8].token_count = 4_000;
        for row in &mut null_backfill {
            row.source_bytes = b"[edit_marker]".to_vec().into();
        }
        assert_eq!(
            ProtectionWindow::from_persisted_rows(&null_backfill, 16_000).row_identities,
            before.row_identities
        );
    }

    #[test]
    fn derived_default_matches_shared_table() {
        assert_eq!(derive_default_floor(100_000), 8_000);
        assert_eq!(derive_default_floor(200_000), 16_000);
        assert_eq!(derive_default_floor(372_000), 18_600);
        assert_eq!(derive_default_floor(872_000), 43_600);
        assert_eq!(derive_default_floor(1_000_000), 50_000);
    }
}

#[cfg(test)]
mod lifecycle_and_coordinate_tests {
    use super::*;

    fn row(tag_number: i64, block_id: &str, token_count: i64) -> McTagRow {
        McTagRow {
            tag_number,
            block_id: block_id.to_string(),
            kind: "tool_result".to_string(),
            token_count,
            created_at_ms: 0,
            source_bytes: Default::default(),
        }
    }

    #[test]
    fn f6_tag_numbers_and_projection_ordinals_are_disjoint_domains() {
        let rows = vec![
            row(7, "persisted-absent#0", 1_000),
            row(8, "tool-b#0", 1_000),
            row(9, "tool-c#0", 1_000),
            row(10, "tool-d#0", 1_000),
        ];
        let window = ProtectionWindow::from_persisted_rows(&rows, 4_000);
        let projected = [
            (70, "plain#0"),
            (80, "tool-b#0"),
            (85, "intervening-plain#0"),
            (90, "tool-c#0"),
            (100, "tool-d#0"),
        ];
        let wrong_tag_cutoff_in_ordinal_space = projected
            .iter()
            .filter(|(ordinal, _)| *ordinal >= 7)
            .map(|(_, id)| (*id).to_string())
            .collect::<HashSet<_>>();
        let wrong_projected_suffix = projected
            .iter()
            .filter(|(ordinal, _)| *ordinal >= 80)
            .map(|(_, id)| (*id).to_string())
            .collect::<HashSet<_>>();

        assert!(
            window
                .row_identities
                .block_ids
                .contains("persisted-absent#0"),
            "a member absent from the projection remains protected unconditionally"
        );
        assert!(!window.row_identities.block_ids.contains("plain#0"));
        assert!(!window
            .row_identities
            .block_ids
            .contains("intervening-plain#0"));
        let protected_projected_rows = projected
            .iter()
            .filter(|(_, id)| window.row_identities.block_ids.contains(*id))
            .map(|(_, id)| (*id).to_string())
            .collect::<HashSet<_>>();
        assert_eq!(
            protected_projected_rows,
            HashSet::from([
                "tool-b#0".to_string(),
                "tool-c#0".to_string(),
                "tool-d#0".to_string()
            ])
        );
        assert_ne!(wrong_tag_cutoff_in_ordinal_space, protected_projected_rows);
        assert_ne!(wrong_projected_suffix, protected_projected_rows);
    }

    #[test]
    fn f7_crossing_group_includes_open_invocation_and_full_boundary_tie() {
        let rows = vec![
            row(5, "old#0", 500),
            row(6, "before-boundary#0", 500),
            McTagRow {
                kind: "tool_call".to_string(),
                ..row(7, "open-invocation#0", 1_500)
            },
            row(7, "boundary-result#0", 1_500),
            row(8, "new#0", 1_000),
        ];
        let window = ProtectionWindow::from_persisted_rows(&rows, 3_500);

        assert_eq!(window.cutoff.cutoff, Some(TagNumber(6)));
        assert!(window
            .row_identities
            .block_ids
            .contains("open-invocation#0"));
        assert!(window
            .row_identities
            .block_ids
            .contains("boundary-result#0"));
        assert!(window
            .row_identities
            .block_ids
            .contains("before-boundary#0"));
        assert!(!window.row_identities.block_ids.contains("old#0"));
    }

    #[test]
    fn defer_never_recomputes_a_persisted_floor_when_geometry_moves() {
        let host = resolve_floor_snapshot(Some(16_000), None, 40_000, FloorPass::CacheBust);
        let hostless_same_default =
            resolve_floor_snapshot(None, None, 16_000, FloorPass::CacheBust);
        assert_eq!(host.effective, hostless_same_default.effective);
        assert_eq!(
            host.persisted,
            Some(16_000),
            "mirror the host snapshot for facade replies"
        );
        let membership_rows = vec![
            row(1, "a", 8_000),
            row(2, "b", 8_000),
            row(3, "c", 8_000),
            row(4, "d", 8_000),
        ];
        assert_eq!(
            ProtectionWindow::from_persisted_rows(&membership_rows, host.effective).row_identities,
            ProtectionWindow::from_persisted_rows(
                &membership_rows,
                hostless_same_default.effective,
            )
            .row_identities
        );

        let first_defer = resolve_floor_snapshot(None, None, 16_000, FloorPass::Defer);
        assert_eq!(first_defer.effective, 16_000);
        assert_eq!(first_defer.persisted, None);

        let bust = resolve_floor_snapshot(None, None, 16_000, FloorPass::CacheBust);
        assert_eq!(bust.persisted, Some(16_000));
        let moved_geometry = resolve_floor_snapshot(None, bust.persisted, 40_000, FloorPass::Defer);
        assert_eq!(moved_geometry.effective, 16_000);
        assert_eq!(moved_geometry.persisted, Some(16_000));
        assert_eq!(moved_geometry.source, "module-snapshot");

        let next_bust =
            resolve_floor_snapshot(None, moved_geometry.persisted, 40_000, FloorPass::CacheBust);
        assert_eq!(next_bust.effective, 40_000);
        assert_eq!(next_bust.persisted, Some(40_000));
    }
}

#[cfg(test)]
mod calibration_tests {
    use super::*;
    #[test]
    fn fable_protection_spends_real_tool_tokens_without_changing_rows() {
        let rows: Vec<_> = (1..=8)
            .map(|n| McTagRow {
                tag_number: n,
                block_id: format!("b{n}"),
                kind: "tool".into(),
                token_count: 1000,
                created_at_ms: 0,
                source_bytes: Default::default(),
            })
            .collect();
        let window = ProtectionWindow::from_persisted_rows_calibrated(&rows, 6000, 1.551639);
        assert_eq!(window.cutoff.cutoff, Some(TagNumber(5)));
        assert_eq!(window.status.protected_mass, 6207);
        assert!(rows.iter().all(|r| r.token_count == 1000));
    }
}
