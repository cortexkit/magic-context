//! The split cache-state layout: round trips, the commit rules and fail-closed loading.

use super::*;
use crate::{
    HistorianClaimOutcome, HistorianPhase, McStore, McStoreError, NewHistorianPendingRun,
    SectionsCommit, TransformCommit,
};
use cortexkit_cache_core::DurabilityClass;
use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};

const SESSION: &str = "ses";

fn open_store(dir: &std::path::Path) -> McStore {
    McStore::open_for_test(&StorageDescriptor {
        module_id: "magic-context".into(),
        storage_namespace: "magic-context".into(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: dir.join("store.db").to_string_lossy().into_owned(),
        },
    })
    .unwrap()
}

fn unit(index: usize) -> FrozenUnit {
    FrozenUnit {
        key: format!("u{index}"),
        kind: "message".into(),
        // A NUL and non-ASCII text, so escaping is part of every round trip.
        frozen_payload: format!("payload {index} \u{0000} \u{00e9}\u{1f600}"),
        durability_class: DurabilityClass::Lineage,
        reset_rule: String::new(),
    }
}

fn units(range: std::ops::Range<usize>) -> Vec<FrozenUnit> {
    range.map(unit).collect()
}

fn boundary(sequence: i64) -> ResolvedContextBoundary {
    ResolvedContextBoundary {
        sequence,
        source_start_message: 1,
        source_end_message: 2,
        source_start_message_id: "m1".into(),
        source_end_message_id: "m2".into(),
        source_start_block_index: None,
        source_end_block_index: None,
        source_row_identity: String::new(),
        start_message: 1,
        end_message: 2,
        start_message_id: "m1#0".into(),
        end_message_id: "m2#0".into(),
        start_date: None,
        end_date: None,
    }
}

fn tail(generation: u64) -> TailHygieneBaseline {
    TailHygieneBaseline {
        baseline_u: 7,
        baseline_t: 9,
        baseline_generation: generation,
        content_signature: "sig".into(),
        hygiene_tools_ratio: 0.300_000_000_000_000_04,
        ..TailHygieneBaseline::default()
    }
}

fn core_with(frozen_units: Vec<FrozenUnit>) -> CoreState {
    CoreState {
        version: 3,
        boundary_id: "m2#0".into(),
        frozen_units,
        pending_changes: vec![unit(9_999)],
        reconcile_pending: false,
    }
}

/// Every split row and the small row's index, exactly as stored.
#[derive(Debug, PartialEq, Eq)]
struct RowSnapshot {
    row_version: Option<i64>,
    core_state: Option<String>,
    meta: Option<String>,
    section_index: Option<String>,
    chunks: Vec<(i64, String)>,
    sections: Vec<(String, String)>,
}

fn snapshot(store: &McStore) -> RowSnapshot {
    store
        .inner
        .with_conn(|conn| {
            let small = conn
                .query_row(
                    "SELECT row_version, core_state, meta, section_index FROM mc_cache_state
                      WHERE session_id = ?1",
                    params![SESSION],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .optional()?;
            let chunks = conn
                .prepare(
                    "SELECT chunk, body FROM mc_cache_frozen_chunks WHERE session_id = ?1
                      ORDER BY chunk",
                )?
                .query_map(params![SESSION], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            let sections = conn
                .prepare(
                    "SELECT section, body FROM mc_cache_sections WHERE session_id = ?1
                      ORDER BY section",
                )?
                .query_map(params![SESSION], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            let (row_version, core_state, meta, section_index) = match small {
                Some((a, b, c, d)) => (Some(a), Some(b), Some(c), Some(d)),
                None => (None, None, None, None),
            };
            Ok(RowSnapshot {
                row_version,
                core_state,
                meta,
                section_index,
                chunks,
                sections,
            })
        })
        .unwrap()
}

fn exec(store: &McStore, sql: &str) {
    store
        .inner
        .with_conn(|conn| conn.execute_batch(sql))
        .unwrap();
}

/// Commit through the transform path, diffing against the base `load` returned.
fn commit_over(
    store: &McStore,
    loaded: &crate::LoadedState,
    core: &CoreState,
    meta: &ModuleMeta,
    frozen_clear: crate::FrozenClear,
) -> Result<u64, McStoreError> {
    store.commit_transform(
        SESSION,
        TransformCommit {
            expected: loaded.row_version,
            core,
            meta,
            sections: SectionsCommit {
                base: loaded.sections.as_ref(),
                meta_only_steps: 0,
                frozen_clear,
            },
            consumed_drop_ids: &[],
            first_applied_command_ids: &[],
            memory_revision: None,
            compartment_max_seq: None,
            project_root: None,
            first_divergence: None,
            scheduler_observation: None,
            scheduler_request_observed_at_ms: None,
            scheduler_full_array_fingerprint: None,
            scheduler_eligible_supersession_count: None,
            scheduler_withheld_by_tag_window: None,
            scheduler_withheld_by_exempt_message: None,
            scheduler_applied_supersession_count: None,
            scheduler_applied_reductions: false,
            overlays: crate::TransformOverlayBatch::default(),
        },
    )
}

/// Seed a session with 130 units (three chunks), two boundaries and a tail baseline.
fn seeded(store: &McStore) -> (CoreState, ModuleMeta) {
    let core = core_with(units(0..130));
    let meta = ModuleMeta {
        resolved_compartment_boundaries: vec![boundary(0), boundary(1)],
        tail_hygiene_baseline: Some(tail(1)),
        initialized: true,
        ..ModuleMeta::default()
    };
    store.commit(SESSION, None, &core, &meta).unwrap();
    (core, meta)
}

#[test]
fn encode_then_decode_round_trips_exactly() {
    let core = core_with(units(0..200));
    let meta = ModuleMeta {
        resolved_compartment_boundaries: vec![boundary(0)],
        tail_hygiene_baseline: Some(tail(4)),
        ..ModuleMeta::default()
    };
    let encoded = encode_row(&core, &meta).unwrap();
    assert_eq!(encoded.chunks.len(), 4);
    assert!(!encoded.core_json.contains(FROZEN_UNITS_KEY));
    assert!(!encoded.meta_json.contains(SECTION_BOUNDARIES));
    assert!(!encoded.meta_json.contains(SECTION_TAIL));
    // A chunk is exactly the serde output of its units, which is what migration 63 writes.
    assert_eq!(
        encoded.chunks[1].body,
        serde_json::to_string(&core.frozen_units[64..128]).unwrap()
    );
    let index = SectionIndex {
        sv: 1,
        shape: None,
        f: Some(FrozenIndex {
            n: 200,
            c: 4,
            h: Some(digest_hex(frozen_digest(
                &encoded.chunks.iter().map(|c| c.digest).collect::<Vec<_>>(),
            ))),
        }),
        b: Some(SectionIndexEntry {
            n: Some(1),
            h: Some(digest_hex(encoded.boundaries.as_ref().unwrap().0.digest)),
        }),
        t: Some(SectionIndexEntry {
            n: None,
            h: Some(digest_hex(encoded.tail.as_ref().unwrap().digest)),
        }),
    };
    let decoded = decode_row(
        StoredRow {
            row_version: 5,
            core_state: encoded.core_json.clone(),
            meta: encoded.meta_json.clone(),
            section_index: index.to_json(),
        },
        StoredSections {
            chunks: encoded
                .chunks
                .iter()
                .enumerate()
                .map(|(i, c)| (i as i64, c.body.clone()))
                .collect(),
            boundaries: Some(encoded.boundaries.as_ref().unwrap().0.body.clone()),
            tail: Some(encoded.tail.as_ref().unwrap().body.clone()),
        },
    )
    .unwrap();
    assert_eq!(decoded.core, core);
    assert_eq!(decoded.meta, meta);
    assert!(!decoded.sections.any_discarded());
}

#[test]
fn shape_summary_is_old_reader_compatible_and_preserves_chunk_bytes_and_hashes() {
    #[derive(Deserialize)]
    struct OldIndex {
        sv: u64,
        f: Option<FrozenIndex>,
        b: Option<SectionIndexEntry>,
        t: Option<SectionIndexEntry>,
    }
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path());
    let (core, _) = seeded(&store);
    let with_summary = snapshot(&store);
    let old: OldIndex = serde_json::from_str(with_summary.section_index.as_ref().unwrap()).unwrap();
    let current = SectionIndex::parse(with_summary.section_index.as_ref().unwrap()).unwrap();
    assert!(current.shape.is_some());
    assert_eq!(
        (old.sv, old.f, old.b, old.t),
        (
            current.sv,
            current.f.clone(),
            current.b.clone(),
            current.t.clone()
        )
    );
    let old_chunk_bytes = core
        .frozen_units
        .chunks(FROZEN_CHUNK_UNITS)
        .enumerate()
        .map(|(i, units)| (i as i64, serde_json::to_string(units).unwrap()))
        .collect::<Vec<_>>();
    assert_eq!(with_summary.chunks, old_chunk_bytes);
    let mut old_index = current.clone();
    old_index.shape = None;
    store
        .inner
        .with_conn_fenced(|conn| {
            conn.execute(
                "UPDATE mc_cache_state SET section_index=?2 WHERE session_id=?1",
                params![SESSION, old_index.to_json()],
            )?;
            Ok(())
        })
        .unwrap();
    let without = snapshot(&store);
    assert_eq!(without.chunks, with_summary.chunks);
    assert_eq!(without.core_state, with_summary.core_state);
    assert_eq!(without.meta, with_summary.meta);
    assert_eq!(
        SectionIndex::parse(without.section_index.as_ref().unwrap())
            .unwrap()
            .f,
        current.f
    );
    assert_eq!(store.load(SESSION).unwrap().core, core);
    assert!(store
        .load_compaction_trigger_core(SESSION)
        .unwrap()
        .is_none());
    // A scalar-only update must not create the missing summary or touch chunks.
    let loaded = store.load_meta(SESSION).unwrap();
    let mut meta = loaded.meta;
    meta.last_model_key = "changed".into();
    store
        .commit_meta(SESSION, loaded.row_version, &meta)
        .unwrap();
    let scalar = snapshot(&store);
    assert_eq!(scalar.section_index, without.section_index);
    assert_eq!(scalar.chunks, without.chunks);
}

#[test]
fn shape_accessor_reads_only_header_metadata_not_frozen_chunk_payloads() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path());
    seeded(&store);
    let before = store
        .load_compaction_trigger_core(SESSION)
        .unwrap()
        .unwrap();
    let decodes = full_decode_count();
    store
        .inner
        .with_conn_fenced(|conn| {
            conn.execute(
                "UPDATE mc_cache_frozen_chunks SET body='unreadable payload' WHERE session_id=?1",
                [SESSION],
            )?;
            Ok(())
        })
        .unwrap();
    assert_eq!(
        store
            .load_compaction_trigger_core(SESSION)
            .unwrap()
            .unwrap(),
        before
    );
    assert_eq!(
        full_decode_count(),
        decodes,
        "shape reads must not decode frozen payloads"
    );
}

#[test]
fn shape_summary_agrees_with_full_core_after_every_cache_write_path() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path());
    let check = || {
        let actual = store.load(SESSION).unwrap();
        let expected = encode_row(&actual.core, &actual.meta).unwrap().shape;
        let index = SectionIndex::parse(snapshot(&store).section_index.as_ref().unwrap()).unwrap();
        assert_eq!(index.shape.as_ref(), Some(&expected));
        let summary = store
            .load_compaction_trigger_core(SESSION)
            .unwrap()
            .unwrap();
        assert_eq!(
            summary
                .frozen_units
                .iter()
                .map(|u| u.key.clone())
                .collect::<Vec<_>>(),
            expected
        );
        assert_eq!(summary.boundary_id, actual.core.boundary_id);
    };
    let core = CoreState {
        frozen_units: ["m0", "m1"]
            .into_iter()
            .map(|key| FrozenUnit {
                key: key.into(),
                kind: "synthesized-region".into(),
                frozen_payload: format!("{key} bytes"),
                durability_class: cortexkit_cache_core::DurabilityClass::Lineage,
                reset_rule: String::new(),
            })
            .collect(),
        ..Default::default()
    };
    let meta = ModuleMeta {
        initialized: true,
        ..Default::default()
    };
    store.commit(SESSION, None, &core, &meta).unwrap();
    check();
    let mut loaded = store.load(SESSION).unwrap();
    loaded.core.frozen_units.push(unit(7));
    commit_over(
        &store,
        &loaded,
        &loaded.core,
        &loaded.meta,
        crate::FrozenClear::Refuse,
    )
    .unwrap();
    check();
    let mut scalar = store.load_meta(SESSION).unwrap();
    scalar.meta.last_model_key = "scalar-only".into();
    store
        .commit_meta(SESSION, scalar.row_version, &scalar.meta)
        .unwrap();
    check();
    let version = store.load_meta(SESSION).unwrap().row_version;
    store.reset_session_for_recomp(SESSION, version).unwrap();
    check();
    assert!(store.load(SESSION).unwrap().core.frozen_units.is_empty());
    let empty = store.load(SESSION).unwrap();
    store
        .commit(SESSION, empty.row_version, &empty.core, &empty.meta)
        .unwrap();
    check();
    let version = store.load_meta(SESSION).unwrap().row_version;
    store.commit(SESSION, version, &core, &meta).unwrap();
    check();
}

#[test]
fn edit_sequences_round_trip_through_the_store() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path());
    let (mut core, mut meta) = seeded(&store);
    type Edit = Box<dyn Fn(&mut CoreState, &mut ModuleMeta)>;
    let mut edits: Vec<Edit> = vec![
        // Append within the last chunk, then across a chunk boundary.
        Box::new(|core, _| core.frozen_units.push(unit(500))),
        Box::new(|core, _| core.frozen_units.extend(units(600..640))),
        // Truncate below a chunk boundary.
        Box::new(|core, _| core.frozen_units.truncate(70)),
        // Insert before the tail: every later chunk shifts.
        Box::new(|core, _| core.frozen_units.insert(3, unit(700))),
        // A HARD re-mint replaces every unit.
        Box::new(|core, _| core.frozen_units = units(1_000..1_100)),
        // The tail baseline goes away, the boundaries empty, then both come back.
        Box::new(|_, meta| meta.tail_hygiene_baseline = None),
        Box::new(|_, meta| meta.resolved_compartment_boundaries.clear()),
        Box::new(|_, meta| {
            meta.resolved_compartment_boundaries = vec![boundary(4)];
            meta.tail_hygiene_baseline = Some(tail(9));
        }),
        // A scalar-only edit.
        Box::new(|_, meta| meta.coverage_ordinal = Some(42)),
    ];
    for (step, edit) in edits.drain(..).enumerate() {
        let loaded = store.load(SESSION).unwrap();
        assert_eq!(loaded.core, core, "step {step}");
        assert_eq!(
            loaded.meta.resolved_compartment_boundaries,
            meta.resolved_compartment_boundaries
        );
        assert_eq!(
            loaded.meta.tail_hygiene_baseline,
            meta.tail_hygiene_baseline
        );
        edit(&mut core, &mut meta);
        commit_over(&store, &loaded, &core, &meta, crate::FrozenClear::Refuse).unwrap();
        let rows = snapshot(&store);
        assert_eq!(
            rows.chunks.len(),
            core.frozen_units.len().div_ceil(FROZEN_CHUNK_UNITS),
            "step {step}: no chunk survives past the new length"
        );
        let names: Vec<_> = rows
            .sections
            .iter()
            .map(|(name, _)| name.as_str())
            .collect();
        assert_eq!(
            names.contains(&SECTION_BOUNDARIES),
            !meta.resolved_compartment_boundaries.is_empty(),
            "step {step}"
        );
        assert_eq!(
            names.contains(&SECTION_TAIL),
            meta.tail_hygiene_baseline.is_some()
        );
    }
    let loaded = store.load(SESSION).unwrap();
    assert_eq!(loaded.core, core);
    assert_eq!(loaded.meta.coverage_ordinal, Some(42));
    assert!(!loaded.sections.unwrap().any_discarded());
}

#[test]
fn an_append_rewrites_only_the_last_chunk() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path());
    let (mut core, meta) = seeded(&store);
    let before = snapshot(&store);
    let loaded = store.load(SESSION).unwrap();
    core.frozen_units.push(unit(131));
    commit_over(&store, &loaded, &core, &meta, crate::FrozenClear::Refuse).unwrap();
    let after = snapshot(&store);
    assert_eq!(after.chunks[..2], before.chunks[..2]);
    assert_ne!(after.chunks[2], before.chunks[2]);
    assert_eq!(after.sections, before.sections);
    let sv = |rows: &RowSnapshot| {
        SectionIndex::parse(rows.section_index.as_ref().unwrap())
            .unwrap()
            .sv
    };
    assert_eq!(sv(&after), sv(&before) + 1);
}

/// A pass whose state is byte-identical to what is stored writes nothing and keeps its
/// version, as before the split: defer passes stay write-free.
#[test]
fn an_unchanged_commit_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path());
    let (core, meta) = seeded(&store);
    // The first commit over a fresh bootstrap settles the index; the second must be a no-op.
    let loaded = store.load(SESSION).unwrap();
    commit_over(&store, &loaded, &core, &meta, crate::FrozenClear::Refuse).unwrap();
    let before = snapshot(&store);
    let loaded = store.load(SESSION).unwrap();
    let version = commit_over(&store, &loaded, &core, &meta, crate::FrozenClear::Refuse).unwrap();
    assert_eq!(Some(version as i64), before.row_version);
    assert_eq!(snapshot(&store), before);
}

#[test]
fn moved_key_in_small_blob_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path());
    seeded(&store);
    exec(
        &store,
        "UPDATE mc_cache_state SET core_state = json_set(core_state, '$.frozen_units', json('[]'))",
    );
    assert!(store.load(SESSION).is_err());
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path());
    seeded(&store);
    exec(
        &store,
        "UPDATE mc_cache_state SET meta = json_set(meta, '$.tail_hygiene_baseline', json('{}'))",
    );
    assert!(store.load(SESSION).is_err());
    assert!(matches!(
        decode_small_meta(r#"{"resolved_compartment_boundaries":[]}"#),
        Err(CodecError::MovedKeyInSmallBlob {
            key: SECTION_BOUNDARIES
        })
    ));
}

#[test]
fn a_scalar_unit_in_a_chunk_is_discarded_not_coerced() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path());
    seeded(&store);
    // The migration's guard refuses a scalar unit; a chunk holding one anyway must not decode.
    exec(
        &store,
        "UPDATE mc_cache_frozen_chunks SET body = '[0.30000000000000004]' WHERE chunk = 2;
         UPDATE mc_cache_state SET section_index = json_set(section_index, '$.sv', 0,
             '$.f', json_remove(json_extract(section_index, '$.f'), '$.h'))",
    );
    let loaded = store.load(SESSION).unwrap();
    assert_eq!(
        loaded.sections.unwrap().frozen,
        SectionState::Discarded(DiscardReason::ChunkUnparseable)
    );
    assert!(loaded.core.frozen_units.is_empty());
}

fn corrupt_chunk(store: &McStore) {
    exec(
        store,
        "UPDATE mc_cache_frozen_chunks SET body = replace(body, 'payload 5 ', 'PAYLOAD 5 ')
          WHERE chunk = 0",
    );
}

#[test]
fn corrupt_chunk_is_discarded_and_the_next_commit_rewrites_every_chunk() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path());
    let (core, meta) = seeded(&store);
    let clean = snapshot(&store);
    corrupt_chunk(&store);
    let loaded = store.load(SESSION).unwrap();
    let base = loaded.sections.clone().unwrap();
    assert_eq!(
        base.frozen,
        SectionState::Discarded(DiscardReason::DigestMismatch)
    );
    assert!(base.boundaries.intact().is_some() && base.tail.intact().is_some());
    assert!(
        loaded.core.frozen_units.is_empty(),
        "a discarded list decodes empty"
    );
    // The pass rebuilds the list (here: the same units) and commits over the discarded base.
    commit_over(&store, &loaded, &core, &meta, crate::FrozenClear::Refuse).unwrap();
    let rewritten = snapshot(&store);
    assert_eq!(
        rewritten.chunks, clean.chunks,
        "every chunk is rewritten in full"
    );
    let reloaded = store.load(SESSION).unwrap();
    assert_eq!(reloaded.core, core);
    assert!(!reloaded.sections.unwrap().any_discarded());
}

#[test]
fn digest_mismatch_survives_meta_only_writes() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path());
    seeded(&store);
    corrupt_chunk(&store);
    let index_before = snapshot(&store).section_index;

    // A meta-only commit.
    let small = store.load_meta(SESSION).unwrap();
    let mut meta = small.meta.clone();
    meta.historian.state = HistorianPhase::Firing;
    meta.historian.firing_seq = 1;
    meta.historian.chunk_fingerprint = "fp".into();
    store
        .commit_meta(SESSION, small.row_version, &meta)
        .unwrap();
    // A historian queue, claim and heartbeat: three more meta-only writes.
    store
        .publish_pending_historian_run(&NewHistorianPendingRun {
            run_id: "run-1".into(),
            session_id: SESSION.into(),
            project_path: "git:proj".into(),
            firing_seq: 1,
            chunk_fingerprint: "fp".into(),
            system_prompt: "sys".into(),
            user_prompt: "user".into(),
            model_chain: vec!["test/model".into()],
            await_budget_ms: 660_000,
            historian_timeout_ms: None,
            now_ms: 1_000,
        })
        .unwrap();
    let token = match store
        .claim_historian_run("git:proj", "run-1", "claimant", 2_000)
        .unwrap()
    {
        HistorianClaimOutcome::Claimed(claim) => claim.token,
        other => panic!("expected a claim, got {other:?}"),
    };
    store
        .heartbeat_historian_run("git:proj", "run-1", &token, 3_000)
        .unwrap();

    let after = snapshot(&store);
    assert_eq!(
        after.section_index, index_before,
        "no meta-only writer touches the index"
    );
    assert!(after.row_version.unwrap() >= 4);
    let loaded = store.load(SESSION).unwrap();
    assert_eq!(
        loaded.sections.unwrap().frozen,
        SectionState::Discarded(DiscardReason::DigestMismatch),
        "the corruption is still reported after the meta-only writes"
    );
}

/// A state sync carrying one valid and one invalid drop seed, and one valid and one invalid
/// strip seed. Seeds are the host's drop and strip decisions, which the sync turns into
/// frozen units; the invalid ones have no block index or an unknown strip kind.
fn sync_with_seeds(store: &McStore, expected_shadow_seq: u64) -> crate::ModuleStateSyncResult {
    let drop_seeds = [
        crate::ModuleDropSeedRow {
            block_id: "m7#0".into(),
            drop_mode: "full".into(),
            ..Default::default()
        },
        crate::ModuleDropSeedRow {
            block_id: "no-block-index".into(),
            drop_mode: "full".into(),
            ..Default::default()
        },
    ];
    let strip_seeds = [
        crate::ModuleStripSeedRow {
            message_id: "m8".into(),
            strip_kind: "placeholder".into(),
        },
        crate::ModuleStripSeedRow {
            message_id: "m9".into(),
            strip_kind: "not-a-strip-kind".into(),
        },
    ];
    store
        .apply_authority_state_sync(crate::ModuleStateSyncRequest {
            resolved_compartment_boundaries: &[],
            session_id: SESSION,
            project_path: "project",
            shadow_generation: 0,
            expected_shadow_seq,
            seed_boundary_id: None,
            drop_seeds: &drop_seeds,
            drop_seed_skipped: 0,
            pending_agent_drops: &[],
            pending_agent_drops_skipped: 0,
            user_hint_seeds: &[],
            auto_search_hint_skipped: 0,
            note_nudge_anchors: None,
            todo_synthetic_anchor: None,
            todo_synthetic_anchor_present: false,
            emergency_latches: None,
            pending_compaction_marker: None,
            deferred_execute_state: None,
            channel2_nudge_state: None,
            strip_seeds: &strip_seeds,
            strip_seed_skipped: 0,
            reasoning_cleared_through_tag: None,
            last_todo_state: None,
            acked_watermarks: serde_json::json!({}),
        })
        .unwrap()
}

/// The control for the test below: over an intact stored frozen list, the valid seeds land
/// as frozen units and only the invalid ones are reported as skipped.
#[test]
fn a_state_sync_over_an_intact_list_stores_its_valid_seeds() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path());
    seeded(&store);
    let result = sync_with_seeds(&store, 0);
    assert_eq!(result.drop_seeds_skipped, 1);
    assert_eq!(result.strip_seeds_skipped, 1);
    assert_eq!(result.seeds_skipped_frozen_discarded, 0);
    let loaded = store.load(SESSION).unwrap();
    assert!(!loaded.sections.unwrap().any_discarded());
    let keys: Vec<_> = loaded
        .core
        .frozen_units
        .iter()
        .map(|u| u.key.as_str())
        .collect();
    assert!(keys.contains(&"red:m7#0"));
    assert!(keys.contains(&"strip:placeholder:m8"));
}

/// A state sync does not own the frozen list. When the stored list failed its checks, the
/// sync keeps those rows as they are (so the next transform still sees the discard and goes
/// HARD) and its valid seeds are not stored. It must report them as skipped, not as landed.
#[test]
fn a_state_sync_over_a_discarded_list_keeps_the_chunks_and_reports_its_seeds_skipped() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path());
    seeded(&store);
    corrupt_chunk(&store);
    let before = snapshot(&store);
    let frozen_entry = |rows: &RowSnapshot| {
        SectionIndex::parse(rows.section_index.as_ref().unwrap())
            .unwrap()
            .f
    };

    let result = sync_with_seeds(&store, 0);
    // One invalid seed of each kind, plus the valid seed of each kind that was not stored.
    assert_eq!(result.drop_seeds_skipped, 2);
    assert_eq!(result.strip_seeds_skipped, 2);
    assert_eq!(result.seeds_skipped_frozen_discarded, 2);

    let after = snapshot(&store);
    assert_eq!(after.chunks, before.chunks, "the stored chunks are kept");
    assert_eq!(frozen_entry(&after), frozen_entry(&before));
    let loaded = store.load(SESSION).unwrap();
    assert_eq!(
        loaded.sections.unwrap().frozen,
        SectionState::Discarded(DiscardReason::DigestMismatch),
        "the next transform still sees the discard"
    );
}

/// Every refusal leaves every chunk, section and index byte identical.
#[test]
fn conflicting_commit_leaves_sections_untouched() {
    type Case = Box<dyn Fn(&McStore) -> Result<u64, McStoreError>>;
    let cases: Vec<(&str, Case)> = vec![
        (
            "row_version conflict",
            Box::new(|store| {
                let loaded = store.load(SESSION).unwrap();
                let small = store.load_meta(SESSION).unwrap();
                let mut meta = small.meta;
                meta.coverage_ordinal = Some(1);
                store
                    .commit_meta(SESSION, small.row_version, &meta)
                    .unwrap();
                let mut core = loaded.core.clone();
                core.frozen_units.push(unit(900));
                let mut meta = loaded.meta.clone();
                meta.tail_hygiene_baseline = None;
                commit_over(store, &loaded, &core, &meta, crate::FrozenClear::Refuse)
            }),
        ),
        (
            "sections version conflict",
            Box::new(|store| {
                let loaded = store.load(SESSION).unwrap();
                // Simulates a second codec writer that advanced `sv` after the load above,
                // while `row_version` still matches what the commit under test expects.
                exec(
                    store,
                    "UPDATE mc_cache_state SET section_index =
                         json_set(section_index, '$.sv', json_extract(section_index, '$.sv') + 1)",
                );
                let mut core = loaded.core.clone();
                core.frozen_units.push(unit(900));
                commit_over(
                    store,
                    &loaded,
                    &core,
                    &loaded.meta,
                    crate::FrozenClear::Refuse,
                )
            }),
        ),
        (
            "unhydrated block identities",
            Box::new(|store| {
                exec(
                    store,
                    "INSERT INTO mc_block_identities (session_id, mid, identities)
                     VALUES ('ses', 'm1', '[]')",
                );
                let loaded = store.load(SESSION).unwrap();
                let mut core = loaded.core.clone();
                core.frozen_units.push(unit(900));
                let mut meta = loaded.meta.clone();
                meta.block_identity_by_mid.clear();
                meta.resolved_compartment_boundaries.clear();
                commit_over(store, &loaded, &core, &meta, crate::FrozenClear::Refuse)
            }),
        ),
        (
            "implicit frozen clear",
            Box::new(|store| {
                let loaded = store.load(SESSION).unwrap();
                let mut meta = loaded.meta.clone();
                meta.tail_hygiene_baseline = Some(tail(77));
                commit_over(
                    store,
                    &loaded,
                    &core_with(Vec::new()),
                    &meta,
                    crate::FrozenClear::Refuse,
                )
            }),
        ),
    ];
    for (name, case) in cases {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(dir.path());
        seeded(&store);
        // The section_index and every split row before the refused commit; the small
        // row's version and meta may legitimately move in the setup of a case.
        let before = snapshot(&store);
        let result = case(&store);
        assert!(result.is_err(), "{name}: the commit must be refused");
        let after = snapshot(&store);
        assert_eq!(after.chunks, before.chunks, "{name}");
        assert_eq!(after.sections, before.sections, "{name}");
        if name != "sections version conflict" {
            assert_eq!(after.section_index, before.section_index, "{name}");
            assert_eq!(after.core_state, before.core_state, "{name}");
        }
    }
}

#[test]
fn an_explicit_clear_is_accepted() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path());
    let (_, meta) = seeded(&store);
    let loaded = store.load(SESSION).unwrap();
    commit_over(
        &store,
        &loaded,
        &core_with(Vec::new()),
        &meta,
        crate::FrozenClear::Explicit,
    )
    .unwrap();
    assert!(snapshot(&store).chunks.is_empty());
    assert!(store.load(SESSION).unwrap().core.frozen_units.is_empty());
}

#[test]
fn a_writer_killed_between_statements_reloads_the_pre_commit_state() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path());
    let (mut core, mut meta) = seeded(&store);
    let before = snapshot(&store);
    let loaded = store.load(SESSION).unwrap();
    core.frozen_units.truncate(10);
    core.frozen_units.push(unit(800));
    meta.tail_hygiene_baseline = None;
    meta.resolved_compartment_boundaries = vec![boundary(9)];
    fail_next_commit_after_section_writes();
    assert!(commit_over(&store, &loaded, &core, &meta, crate::FrozenClear::Refuse).is_err());
    assert_eq!(snapshot(&store), before);
    let reloaded = store.load(SESSION).unwrap();
    assert_eq!(reloaded.core, loaded.core);
    assert_eq!(reloaded.meta, loaded.meta);
    assert_eq!(reloaded.sections, loaded.sections);
}

#[test]
fn orphan_chunks_are_discarded_and_deleted() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path());
    let (core, meta) = seeded(&store);
    exec(
        &store,
        "INSERT INTO mc_cache_frozen_chunks (session_id, chunk, body) VALUES ('ses', 7, '[]')",
    );
    let loaded = store.load(SESSION).unwrap();
    assert_eq!(
        loaded.sections.as_ref().unwrap().frozen,
        SectionState::Discarded(DiscardReason::ChunkCountMismatch)
    );
    commit_over(&store, &loaded, &core, &meta, crate::FrozenClear::Refuse).unwrap();
    let rows = snapshot(&store);
    assert_eq!(
        rows.chunks
            .iter()
            .map(|(chunk, _)| *chunk)
            .collect::<Vec<_>>(),
        vec![0, 1, 2]
    );
}

#[test]
fn bootstrap_commit_clears_all_session_rows() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path());
    seeded(&store);
    // A test (or an older writer) that deletes only the small row leaves split rows behind.
    exec(
        &store,
        "DELETE FROM mc_cache_state WHERE session_id = 'ses'",
    );
    let core = core_with(units(0..3));
    store
        .commit(SESSION, None, &core, &ModuleMeta::default())
        .unwrap();
    let rows = snapshot(&store);
    assert_eq!(rows.chunks.len(), 1);
    assert!(rows.sections.is_empty());
    let loaded = store.load(SESSION).unwrap();
    assert_eq!(loaded.core, core);
    assert!(!loaded.sections.unwrap().any_discarded());
}

#[test]
fn absent_section_deletes_its_row() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path());
    let (core, mut meta) = seeded(&store);
    let loaded = store.load(SESSION).unwrap();
    meta.tail_hygiene_baseline = None;
    meta.resolved_compartment_boundaries.clear();
    commit_over(&store, &loaded, &core, &meta, crate::FrozenClear::Refuse).unwrap();
    let rows = snapshot(&store);
    assert!(rows.sections.is_empty());
    let index = SectionIndex::parse(rows.section_index.as_ref().unwrap()).unwrap();
    assert!(index.b.is_none() && index.t.is_none());
    let reloaded = store.load(SESSION).unwrap();
    assert_eq!(reloaded.meta.tail_hygiene_baseline, None);
    assert!(!reloaded.sections.unwrap().any_discarded());
}

#[test]
fn a_section_row_the_index_does_not_name_is_discarded() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path());
    seeded(&store);
    exec(
        &store,
        "UPDATE mc_cache_state SET section_index = json_remove(section_index, '$.t')",
    );
    let loaded = store.load(SESSION).unwrap();
    assert_eq!(
        loaded.sections.unwrap().tail,
        SectionState::Discarded(DiscardReason::SectionUnexpected)
    );
    assert_eq!(loaded.meta.tail_hygiene_baseline, None);
}

#[test]
fn revert_recut_commits_over_a_meta_only_bump() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path());
    let (mut core, meta) = seeded(&store);
    let loaded = store.load(SESSION).unwrap();
    let base_version = loaded.row_version.unwrap();
    let small = store.load_meta(SESSION).unwrap();
    let mut bumped = small.meta;
    bumped.revert_epoch += 1;
    let adopted = store
        .commit_meta(SESSION, small.row_version, &bumped)
        .unwrap();
    assert_eq!(adopted, base_version + 1);
    core.frozen_units.push(unit(321));
    let request = |steps: u64| TransformCommit {
        expected: Some(adopted),
        core: &core,
        meta: &meta,
        sections: SectionsCommit {
            base: loaded.sections.as_ref(),
            meta_only_steps: steps,
            frozen_clear: crate::FrozenClear::Refuse,
        },
        consumed_drop_ids: &[],
        first_applied_command_ids: &[],
        memory_revision: None,
        compartment_max_seq: None,
        project_root: None,
        first_divergence: None,
        scheduler_observation: None,
        scheduler_request_observed_at_ms: None,
        scheduler_full_array_fingerprint: None,
        scheduler_eligible_supersession_count: None,
        scheduler_withheld_by_tag_window: None,
        scheduler_withheld_by_exempt_message: None,
        scheduler_applied_supersession_count: None,
        scheduler_applied_reductions: false,
        overlays: crate::TransformOverlayBatch::default(),
    };
    // With the meta-only step not counted, the expected version does not match the base,
    // and the commit refuses before writing anything.
    let before = snapshot(&store);
    assert!(matches!(
        store.commit_transform(SESSION, request(0)),
        Err(McStoreError::SectionsBaseMismatch { .. })
    ));
    assert_eq!(snapshot(&store), before);
    // With the meta-only step counted, the commit diffs against the earlier base and lands.
    store.commit_transform(SESSION, request(1)).unwrap();
    assert_eq!(store.load(SESSION).unwrap().core, core);
}

#[test]
fn truncate_for_revert_leaves_section_index_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path());
    seeded(&store);
    store
        .with_context_conn_for_test(|conn| {
            conn.execute_batch(
                "INSERT INTO compartments(session_id, sequence, start_message, end_message,
                     start_message_id, end_message_id, title, content, created_at)
                 VALUES ('ses', 0, 1, 2, 'm1', 'm2', 't', 'c', 1),
                        ('ses', 1, 3, 4, 'm3', 'm4', 't', 'c', 2)",
            )
        })
        .unwrap();
    let before = snapshot(&store);
    let outcome = store
        .truncate_compartments_for_revert(SESSION, 0, before.row_version.map(|v| v as u64))
        .unwrap();
    let after = snapshot(&store);
    assert_eq!(outcome.row_version, before.row_version.unwrap() as u64 + 1);
    assert_eq!(after.section_index, before.section_index);
    assert_eq!(after.chunks, before.chunks);
    assert_eq!(after.sections, before.sections);
}

#[test]
fn a_migrated_row_is_trusted_from_its_bytes_until_its_first_commit() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path());
    let (mut core, meta) = seeded(&store);
    // What migration 63 writes: sv 0 and no digests.
    exec(
        &store,
        "UPDATE mc_cache_state SET section_index = json_object('sv', 0,
             'f', json_object('n', 130, 'c', 3), 'b', json_object('n', 2), 't', json('{}'))",
    );
    let before = snapshot(&store);
    let loaded = store.load(SESSION).unwrap();
    assert!(!loaded.sections.as_ref().unwrap().any_discarded());
    assert_eq!(loaded.core, core);
    core.frozen_units.push(unit(131));
    commit_over(&store, &loaded, &core, &meta, crate::FrozenClear::Refuse).unwrap();
    let after = snapshot(&store);
    // Only the changed chunk is written; the first commit records every digest under sv 1.
    assert_eq!(after.chunks[..2], before.chunks[..2]);
    assert_eq!(after.sections, before.sections);
    let index = SectionIndex::parse(after.section_index.as_ref().unwrap()).unwrap();
    assert_eq!(index.sv, 1);
    assert!(index.f.unwrap().h.is_some() && index.b.unwrap().h.is_some());
    assert!(index.t.unwrap().h.is_some());
}

#[test]
fn reset_for_recomp_clears_every_split_row() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path());
    seeded(&store);
    let version = store.load(SESSION).unwrap().row_version;
    store.reset_session_for_recomp(SESSION, version).unwrap();
    let rows = snapshot(&store);
    assert!(rows.chunks.is_empty() && rows.sections.is_empty());
    let loaded = store.load(SESSION).unwrap();
    assert!(loaded.core.frozen_units.is_empty());
    assert!(loaded.meta.resolved_compartment_boundaries.is_empty());
    assert!(!loaded.sections.unwrap().any_discarded());
}

#[test]
fn load_meta_reads_the_small_row_and_commit_meta_writes_only_it() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path());
    seeded(&store);
    let before = snapshot(&store);
    let decodes = full_decode_count();
    let small = store.load_meta(SESSION).unwrap();
    assert_eq!(
        full_decode_count(),
        decodes,
        "load_meta never decodes the split rows"
    );
    assert!(small.meta.resolved_compartment_boundaries.is_empty());
    let mut meta = small.meta.clone();
    meta.coverage_ordinal = Some(77);
    // A section value a caller left in meta is not written by a meta-only commit.
    meta.tail_hygiene_baseline = Some(tail(55));
    store
        .commit_meta(SESSION, small.row_version, &meta)
        .unwrap();
    let after = snapshot(&store);
    assert_eq!(after.chunks, before.chunks);
    assert_eq!(after.sections, before.sections);
    assert_eq!(after.section_index, before.section_index);
    assert_eq!(after.core_state, before.core_state);
    assert!(!after.meta.as_ref().unwrap().contains(SECTION_TAIL));
    let loaded = store.load(SESSION).unwrap();
    assert_eq!(loaded.meta.coverage_ordinal, Some(77));
    assert_eq!(loaded.meta.tail_hygiene_baseline, Some(tail(1)));
}

#[test]
fn state_sync_inventory_reports_boundaries_from_their_section() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path());
    seeded(&store);
    let (meta, _, _) = store.load_state_sync_inventory(SESSION, true).unwrap();
    assert_eq!(
        meta.resolved_compartment_boundaries,
        vec![boundary(0), boundary(1)]
    );
}

/// The bundled migration is the exact text `scripts/ckmc-write-probe/migcheck` ran against a
/// clone of a whole live store and verified row by row.
#[test]
fn migration_63_is_the_text_migcheck_verified() {
    let verified = include_str!("../../../../scripts/ckmc-write-probe/migcheck/migration63.sql");
    let bundled = crate::MIGRATIONS
        .iter()
        .find(|migration| migration.version == 63)
        .expect("migration 63 is bundled")
        .statements;
    assert_eq!(bundled, verified);
    // Later migrations leave migration 63's verified text unchanged.
    assert_eq!(
        crate::LATEST_MIGRATION_VERSION,
        crate::move_inventory::STORE_SCHEMA_VERSION
    );
}

/// Put a fresh store back into its version-62 shape: the tables, columns and view migration
/// 63 adds are dropped, the two array columns it drops come back, and every later
/// migration stamp goes. Leaving a newer stamp would make open skip migration 63.
fn rewind_to_62(store: &McStore) {
    // A version-62 writer did not install the move guards, and dropping a
    // guarded column cannot leave a trigger referring to that newer column.
    store.inner.with_conn(|conn| {
        let mut stmt = conn.prepare("SELECT name FROM sqlite_temp_master WHERE type = 'trigger' AND name LIKE 'mc_move_guard_%'")?;
        let names = stmt.query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        for name in names {
            conn.execute_batch(&format!("DROP TRIGGER temp.\"{name}\""))?;
        }
        Ok(())
    }).unwrap();
    exec(
        store,
        "DROP VIEW mc_pass_trace_history_arrays;
         DROP TABLE mc_pass_trace_history;
         DROP TABLE mc_cache_frozen_chunks;
         DROP TABLE mc_cache_sections;
          DROP TABLE mc_provider_conversations_v2;
          DROP TABLE mc_provider_lineages_v1;
          DROP TABLE mc_provider_messages_v1;
          DROP TABLE mc_provider_hook_answers_v1;
          DROP TABLE mc_provider_views_v1;
          DROP TABLE mc_provider_legacy_tags_v1;
          DROP TABLE mc_provider_pending_drops_v1;
          DROP TABLE mc_provider_sessions_v1;
         DROP TABLE mc_provider_catalogs_v1;
         ALTER TABLE mc_cache_state DROP COLUMN section_index;
         ALTER TABLE mc_pass_trace DROP COLUMN scheduler_next_seq;
         ALTER TABLE mc_pass_trace DROP COLUMN interesting_next_seq;
         ALTER TABLE mc_pass_trace DROP COLUMN request_next_seq;
         ALTER TABLE mc_pass_trace ADD COLUMN scheduler_history TEXT NOT NULL DEFAULT '[]';
         ALTER TABLE mc_pass_trace ADD COLUMN scheduler_interesting_history TEXT NOT NULL DEFAULT '[]';
          DROP TABLE mc_move_key_map;
          DROP TABLE mc_move_installs;
          DROP TABLE mc_move_cuts;
          DROP TABLE mc_move_fences;
          DROP TABLE mc_move_tag_epochs;
          DELETE FROM cortexkit_schema_version WHERE namespace = 'mc_cache' AND version >= 63;",
    );
}

fn insert_legacy(store: &McStore, session: &str, core_json: &str, meta_json: &str) {
    store
        .inner
        .with_conn(|conn| {
            conn.execute(
                "INSERT INTO mc_cache_state (session_id, row_version, core_state, meta, last_activity_at)
                 VALUES (?1, 4, ?2, ?3, 1)",
                params![session, core_json, meta_json],
            )
        })
        .unwrap();
}

fn store_descriptor(dir: &std::path::Path) -> StorageDescriptor {
    StorageDescriptor {
        module_id: "magic-context".into(),
        storage_namespace: "magic-context".into(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: dir.join("store.db").to_string_lossy().into_owned(),
        },
    }
}

#[test]
fn migration_63_moves_every_shape_and_the_codec_reads_it_back() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path());
    rewind_to_62(&store);
    let full_core = core_with(units(0..150));
    let full_meta = ModuleMeta {
        resolved_compartment_boundaries: vec![boundary(0), boundary(1)],
        tail_hygiene_baseline: Some(tail(3)),
        coverage_ordinal: Some(9),
        ..ModuleMeta::default()
    };
    let shapes = [
        (
            "full",
            serde_json::to_string(&full_core).unwrap(),
            serde_json::to_string(&full_meta).unwrap(),
        ),
        (
            "empty",
            serde_json::to_string(&core_with(Vec::new())).unwrap(),
            serde_json::to_string(&ModuleMeta::default()).unwrap(),
        ),
        // A JSON null list and tail are read as absent, as serde reads a null Option.
        (
            "nulls",
            serde_json::to_string(&core_with(units(0..1))).unwrap(),
            {
                let mut meta = serde_json::to_value(ModuleMeta::default()).unwrap();
                meta["resolved_compartment_boundaries"] = serde_json::Value::Null;
                meta["tail_hygiene_baseline"] = serde_json::Value::Null;
                meta.to_string()
            },
        ),
    ];
    for (session, core_json, meta_json) in &shapes {
        insert_legacy(&store, session, core_json, meta_json);
    }
    drop(store);
    let store = McStore::open_for_test(&store_descriptor(dir.path())).unwrap();
    assert_eq!(
        store.module_store_schema_version().unwrap(),
        crate::LATEST_MIGRATION_VERSION
    );
    let loaded = store.load("full").unwrap();
    assert_eq!(loaded.core, full_core);
    assert_eq!(
        loaded.meta.resolved_compartment_boundaries,
        full_meta.resolved_compartment_boundaries
    );
    assert_eq!(
        loaded.meta.tail_hygiene_baseline,
        full_meta.tail_hygiene_baseline
    );
    assert_eq!(loaded.meta.coverage_ordinal, Some(9));
    let base = loaded.sections.unwrap();
    assert_eq!(base.sv, 0, "a migrated row is marked unhashed");
    assert!(!base.any_discarded());
    let empty = store.load("empty").unwrap();
    assert!(empty.core.frozen_units.is_empty());
    assert!(!empty.sections.unwrap().any_discarded());
    let nulls = store.load("nulls").unwrap();
    assert_eq!(nulls.core.frozen_units, units(0..1));
    assert_eq!(nulls.meta.tail_hygiene_baseline, None);
    assert!(nulls.meta.resolved_compartment_boundaries.is_empty());
    // Every chunk the migration wrote is byte-identical to the encoder's output, so the first
    // commit diffs against it rather than rewriting the list.
    let encoded = encode_row(&full_core, &full_meta).unwrap();
    let stored: Vec<String> = store
        .inner
        .with_conn(|conn| {
            conn.prepare(
                "SELECT body FROM mc_cache_frozen_chunks WHERE session_id = 'full' ORDER BY chunk",
            )?
            .query_map([], |row| row.get(0))?
            .collect()
        })
        .unwrap();
    assert_eq!(
        stored,
        encoded
            .chunks
            .iter()
            .map(|c| c.body.clone())
            .collect::<Vec<_>>()
    );
}

#[test]
fn a_failed_migration_63_guard_leaves_the_store_at_62() {
    for (name, core_json, meta_json) in [
        (
            "scalar unit",
            r#"{"version":1,"boundary_id":"","frozen_units":[0.30000000000000004]}"#,
            "{}",
        ),
        (
            "object frozen_units",
            r#"{"version":1,"boundary_id":"","frozen_units":{"a":1}}"#,
            "{}",
        ),
        (
            "scalar boundary",
            r#"{"version":1,"boundary_id":"","frozen_units":[]}"#,
            r#"{"resolved_compartment_boundaries":[1]}"#,
        ),
        (
            "string tail",
            r#"{"version":1,"boundary_id":"","frozen_units":[]}"#,
            r#"{"tail_hygiene_baseline":"x"}"#,
        ),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(dir.path());
        rewind_to_62(&store);
        insert_legacy(&store, "bad", core_json, meta_json);
        drop(store);
        assert!(
            McStore::open_for_test(&store_descriptor(dir.path())).is_err(),
            "{name}: the guard must refuse the migration"
        );
        let conn = rusqlite::Connection::open(dir.path().join("store.db")).unwrap();
        let version: i64 = conn
            .query_row(
                "SELECT MAX(version) FROM cortexkit_schema_version WHERE namespace = 'mc_cache'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, 62, "{name}");
        let (core, meta): (String, String) = conn
            .query_row(
                "SELECT core_state, meta FROM mc_cache_state WHERE session_id = 'bad'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            (core.as_str(), meta.as_str()),
            (core_json, meta_json),
            "{name}"
        );
        let split_tables: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name IN
                     ('mc_cache_frozen_chunks', 'mc_cache_sections', 'mc_pass_trace_history')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            split_tables, 0,
            "{name}: the rollback leaves no new table behind"
        );
    }
}

#[test]
fn migration_63_moves_pass_trace_histories_into_ring_rows() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path());
    rewind_to_62(&store);
    let observation = |timestamp_ms: i64, decision: &str| {
        serde_json::to_value(crate::PassSchedulerObservation {
            timestamp_ms,
            scheduler_decision: decision.to_string(),
            canonical_decision: None,
            defer_reason: None,
            drain_latch_active: false,
            identity_delta: Vec::new(),
        })
        .unwrap()
    };
    let scheduler: Vec<serde_json::Value> = (0..3).map(|i| observation(i, "Defer")).collect();
    // The request history used to ride in a carrier entry of the interesting history.
    let interesting = serde_json::json!([
        observation(5, "Execute"),
        {"scheduler_decision": "__request_trace_history__",
         "request_history": [{"attempt_id": "a1", "received_at_ms": 1, "completed_at_ms": 2,
                              "outcome": "completed"}]},
        observation(6, "Force85")
    ]);
    store
        .inner
        .with_conn(|conn| {
            conn.execute(
                "INSERT INTO mc_pass_trace (session_id, last_received_at_ms, last_completed_at_ms,
                     reject_count, receive_count, scheduler_history, scheduler_interesting_history)
                 VALUES ('ses', 1, 2, 0, 1, ?1, ?2)",
                params![
                    serde_json::Value::Array(scheduler.clone()).to_string(),
                    interesting.to_string()
                ],
            )
        })
        .unwrap();
    drop(store);
    let store = McStore::open_for_test(&store_descriptor(dir.path())).unwrap();
    let trace = store.load_pass_trace("ses").unwrap().unwrap();
    assert_eq!(trace.scheduler_history.len(), 3);
    assert_eq!(trace.request_history.len(), 1);
    assert_eq!(trace.request_history[0].attempt_id, "a1");
    let retained: Vec<i64> = store
        .inner
        .with_conn(|conn| {
            conn.prepare(
                "SELECT json_extract(entry, '$.timestamp_ms') FROM mc_pass_trace_history
                  WHERE session_id = 'ses' AND kind = 'interesting' ORDER BY seq",
            )?
            .query_map([], |row| row.get(0))?
            .collect()
        })
        .unwrap();
    assert_eq!(
        retained,
        vec![5, 6],
        "the carrier entry is not an interesting entry"
    );
    // New appends continue each ring after the migrated entries, oldest first.
    store.trace_pass_received("ses", "a2", 10).unwrap();
    store.trace_pass_completed("ses", "a2", 11).unwrap();
    let trace = store.load_pass_trace("ses").unwrap().unwrap();
    assert_eq!(
        trace
            .request_history
            .iter()
            .map(|r| (r.attempt_id.as_str(), r.outcome.as_str()))
            .collect::<Vec<_>>(),
        vec![("a1", "completed"), ("a2", "completed")]
    );
}

#[test]
fn ring_rows_keep_the_newest_entries_in_order() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path());
    for i in 0..40 {
        store
            .trace_pass_received(SESSION, &format!("a{i}"), i)
            .unwrap();
    }
    let trace = store.load_pass_trace(SESSION).unwrap().unwrap();
    assert_eq!(
        trace.request_history.len(),
        crate::REQUEST_TRACE_HISTORY_LIMIT
    );
    assert_eq!(trace.request_history.first().unwrap().attempt_id, "a8");
    assert_eq!(trace.request_history.last().unwrap().attempt_id, "a39");
    let rows: i64 = store
        .inner
        .with_conn(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM mc_pass_trace_history WHERE session_id = 'ses'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert_eq!(rows, crate::REQUEST_TRACE_HISTORY_LIMIT as i64);
}

/// Source scans that keep the split honest: nothing outside the codec may read a moved key
/// with SQL, or write the split rows, or commit full state from production module code.
mod source_scans {
    use std::path::{Path, PathBuf};

    fn repo_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .canonicalize()
            .unwrap()
    }

    fn relative(path: &Path) -> String {
        path.strip_prefix(repo_root())
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/")
    }

    /// Every source file under `crates/`, `packages/` and `scripts/`.
    fn source_files() -> Vec<PathBuf> {
        fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
            let Ok(entries) = std::fs::read_dir(dir) else {
                return;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().into_owned();
                if path.is_dir() {
                    if !matches!(
                        name.as_str(),
                        "node_modules" | "target" | "dist" | ".git" | "build" | ".turbo"
                    ) {
                        walk(&path, out);
                    }
                } else if [".rs", ".ts", ".tsx", ".js", ".mjs", ".py", ".sh", ".sql"]
                    .iter()
                    .any(|extension| name.ends_with(extension))
                {
                    out.push(path);
                }
            }
        }
        let root = repo_root();
        let mut out = Vec::new();
        for top in ["crates", "packages", "scripts"] {
            walk(&root.join(top), &mut out);
        }
        out.sort();
        out
    }

    /// The moved keys, assembled so this file does not match its own scan.
    fn moved_keys() -> [String; 3] {
        [
            ["frozen", "_units"].concat(),
            ["resolved_compartment", "_boundaries"].concat(),
            ["tail_hygiene", "_baseline"].concat(),
        ]
    }

    /// The production part of a Rust file: everything before its first test module.
    fn production(text: &str) -> &str {
        let marker = ["#[cfg(test)]", "\nmod "].concat();
        text.find(&marker).map_or(text, |end| &text[..end])
    }

    /// The string literals of a Rust source, with their 1-based starting line.
    fn rust_literals(text: &str) -> Vec<(usize, String)> {
        let bytes = text.as_bytes();
        let mut out = Vec::new();
        let mut i = 0;
        let mut line = 1;
        while i < bytes.len() {
            match bytes[i] {
                b'\n' => {
                    line += 1;
                    i += 1;
                }
                b'/' if bytes.get(i + 1) == Some(&b'/') => {
                    while i < bytes.len() && bytes[i] != b'\n' {
                        i += 1;
                    }
                }
                b'\'' if bytes.get(i + 1) == Some(&b'"') && bytes.get(i + 2) == Some(&b'\'') => {
                    i += 3;
                }
                b'\'' if bytes.get(i + 1) == Some(&b'\\') && bytes.get(i + 3) == Some(&b'\'') => {
                    i += 4;
                }
                b'r' if matches!(bytes.get(i + 1), Some(b'#') | Some(b'"'))
                    && (i == 0
                        || !(bytes[i - 1].is_ascii_alphanumeric() || bytes[i - 1] == b'_')) =>
                {
                    let mut hashes = 0;
                    let mut j = i + 1;
                    while bytes.get(j) == Some(&b'#') {
                        hashes += 1;
                        j += 1;
                    }
                    if bytes.get(j) != Some(&b'"') {
                        i += 1;
                        continue;
                    }
                    let close = ["\"", &"#".repeat(hashes)].concat();
                    let start = j + 1;
                    let end = text[start..]
                        .find(&close)
                        .map_or(text.len(), |at| start + at);
                    out.push((line, text[start..end].to_string()));
                    line += text[i..end].matches('\n').count();
                    i = end + close.len();
                }
                b'"' => {
                    let start = i + 1;
                    let mut j = start;
                    while j < bytes.len() && bytes[j] != b'"' {
                        if bytes[j] == b'\\' {
                            j += 1;
                        }
                        j += 1;
                    }
                    let end = j.min(bytes.len());
                    out.push((line, text[start..end].to_string()));
                    line += text[i..end].matches('\n').count();
                    i = end + 1;
                }
                _ => i += 1,
            }
        }
        out
    }

    fn is_exempt_from_path_scan(path: &str) -> bool {
        path.starts_with("scripts/ckmc-write-probe/")
            // Seeds a legacy-shaped row in a scratch database to prove a Pi clone does not
            // copy the table at all; it never reads a store.
            || path == "packages/pi-plugin/src/clone-inheritance.test.ts"
            || path == "crates/mc-store/src/migrations/store_063_cache_split.sql"
            || path == "crates/mc-store/src/cache_codec/tests.rs"
    }

    /// The offending lines of one file's text, for the moved-key read rules.
    pub(super) fn moved_key_reads(path: &str, text: &str) -> Vec<String> {
        let mut hits = Vec::new();
        if is_exempt_from_path_scan(path) {
            return hits;
        }
        let keys = moved_keys();
        for (number, line) in text.lines().enumerate() {
            for key in &keys {
                let path_forms = [
                    ["$.", key].concat(),
                    ["->'", key, "'"].concat(),
                    ["->>'", key, "'"].concat(),
                    ["-> '", key, "'"].concat(),
                    ["->> '", key, "'"].concat(),
                ];
                if path_forms.iter().any(|form| line.contains(form.as_str())) {
                    hits.push(format!("{path}:{}: JSON path to `{key}`", number + 1));
                }
            }
        }
        if !path.ends_with(".rs") && text.contains("mc_cache_state") {
            for key in &keys {
                if let Some(number) = text.lines().position(|line| line.contains(key.as_str())) {
                    hits.push(format!(
                        "{path}:{}: names mc_cache_state together with `{key}`",
                        number + 1
                    ));
                }
            }
        }
        if path.ends_with(".rs") && !path.starts_with("crates/mc-store/src/cache_codec") {
            for (number, literal) in rust_literals(production(text)) {
                // SQL keywords are written in upper case throughout the crates.
                if !(literal.contains("SELECT") && literal.contains("FROM")) {
                    continue;
                }
                // A small scalar read through SQL, and the byte-equality skip check, do not
                // read the moved values.
                let stripped = literal
                    .replace("json_extract(core_state, '$.boundary_id')", "")
                    .replace("core_state = ?2", "");
                if stripped.contains("core_state") {
                    hits.push(format!("{path}:{number}: SELECT of core_state"));
                }
                if stripped.contains("meta")
                    && keys.iter().any(|key| stripped.contains(key.as_str()))
                {
                    hits.push(format!("{path}:{number}: SELECT of meta with a moved key"));
                }
            }
        }
        hits
    }

    /// The offending statements of one Rust file for the writer pin.
    pub(super) fn split_row_writes(path: &str, text: &str) -> Vec<String> {
        let mut hits = Vec::new();
        if !path.ends_with(".rs") || path.starts_with("crates/mc-store/src/cache_codec") {
            return hits;
        }
        let production = production(text);
        // Historical migrations run before 63 and are pinned by their own tests.
        if let (Some(start), Some(end)) = (
            production.find("const MIGRATIONS: &[Migration] = &["),
            production.find("pub const LATEST_MIGRATION_VERSION"),
        ) {
            hits.extend(split_row_writes_in(
                path,
                &[&production[..start], &production[end..]].concat(),
            ));
        } else {
            hits.extend(split_row_writes_in(path, production));
        }
        hits
    }

    fn split_row_writes_in(path: &str, text: &str) -> Vec<String> {
        let mut hits = Vec::new();
        for (number, literal) in rust_literals(text) {
            let upper = literal.to_ascii_uppercase();
            let writes = ["INSERT", "UPDATE", "DELETE", "REPLACE"]
                .iter()
                .any(|verb| upper.contains(verb));
            if !writes {
                continue;
            }
            if literal.contains("mc_cache_frozen_chunks") || literal.contains("mc_cache_sections") {
                hits.push(format!("{path}:{number}: writes a split-row table"));
            }
            if literal.contains("mc_cache_state")
                && (literal.contains("core_state") || literal.contains("section_index"))
            {
                hits.push(format!("{path}:{number}: sets core_state or section_index"));
            }
        }
        hits
    }

    fn rel_text(path: &Path) -> Option<(String, String)> {
        Some((relative(path), std::fs::read_to_string(path).ok()?))
    }

    #[test]
    fn no_sql_reads_moved_cache_state_keys() {
        let mut hits = Vec::new();
        let mut scanned = 0;
        for path in source_files() {
            let Some((rel, text)) = rel_text(&path) else {
                continue;
            };
            scanned += 1;
            hits.extend(moved_key_reads(&rel, &text));
        }
        assert!(
            scanned > 100,
            "the scan must see the repository, saw {scanned} files"
        );
        assert!(
            hits.is_empty(),
            "reads of moved cache-state keys:\n{}",
            hits.join("\n")
        );
    }

    #[test]
    fn the_scan_catches_a_planted_moved_key_read() {
        let key = moved_keys()[1].clone();
        let planted = [
            "let sql = \"SELECT json_extract(meta, '$.",
            &key,
            "') FROM mc_cache_state\";",
        ]
        .concat();
        assert!(!moved_key_reads("crates/mc-store/src/context_boundaries.rs", &planted).is_empty());
        let planted_ts = [
            "db.query(\"SELECT core_state FROM mc_cache_state\"); unit.",
            &moved_keys()[0],
        ]
        .concat();
        assert!(!moved_key_reads("scripts/audit.ts", &planted_ts).is_empty());
        let planted_select =
            "conn.query_row(\"SELECT row_version, core_state FROM mc_cache_state\", [], f)";
        assert!(!moved_key_reads("crates/mc-module/src/lib.rs", planted_select).is_empty());
    }

    #[test]
    fn only_the_codec_writes_split_rows_or_core_state() {
        let mut hits = Vec::new();
        for path in source_files() {
            let Some((rel, text)) = rel_text(&path) else {
                continue;
            };
            // Production code only: tests seed raw rows on purpose, to corrupt them or to
            // build stores in an older shape.
            let test_file = rel.ends_with("_tests.rs") || rel.contains("/tests/");
            if (rel.starts_with("crates/mc-store/") || rel.starts_with("crates/mc-module/"))
                && !test_file
            {
                hits.extend(split_row_writes(&rel, &text));
            }
        }
        assert!(
            hits.is_empty(),
            "split-row writers outside the codec:\n{}",
            hits.join("\n")
        );
        let planted =
            "tx.execute(\"UPDATE mc_cache_state SET core_state = ?2 WHERE session_id = ?1\", p)";
        assert!(!split_row_writes("crates/mc-store/src/lib.rs", planted).is_empty());
    }

    /// Production module code edits meta through `load_meta`/`commit_meta`; a full-state
    /// commit there would rewrite chunks and sections for a meta edit.
    #[test]
    fn module_production_code_does_not_call_the_full_state_commit() {
        let mut hits = Vec::new();
        for path in source_files() {
            let rel = relative(&path);
            if !rel.starts_with("crates/mc-module/src/")
                || rel.ends_with("_tests.rs")
                || rel.contains("/tests/")
            {
                continue;
            }
            let text = std::fs::read_to_string(&path).unwrap();
            for (number, line) in production(&text).lines().enumerate() {
                let code = line.split("//").next().unwrap_or_default();
                // A transaction's `commit()` takes no arguments; the store's takes the state.
                let full_state_commit = code
                    .match_indices(".commit(")
                    .any(|(at, call)| !code[at + call.len()..].starts_with(')'));
                if full_state_commit || code.contains(".commit_with_consumed_drops(") {
                    hits.push(format!("{rel}:{}: {}", number + 1, line.trim()));
                }
            }
        }
        assert!(
            hits.is_empty(),
            "full-state commits in module code:\n{}",
            hits.join("\n")
        );
    }
}

/// Before-and-after cost on clones of real stores: write bytes per commit and load time per
/// pass, for today's single-row layout and for the split layout, through the real code.
///
/// `MC_SPLIT_CLONE` names a directory under `$TMPDIR/magic-context/ckmc-split/` holding
/// `today/{store.db,context.db}` and `split/{store.db,context.db}`, both APFS clones of a
/// version-62 store with the writer fence reset. `today/` is written with raw SQL in today's
/// shape; `split/` is opened with `McStore::open`, which runs migration 63 on it.
/// `MC_SPLIT_SESSIONS` lists the sessions to measure, comma-separated.
#[test]
#[ignore = "set MC_SPLIT_CLONE to clones under $TMPDIR/magic-context/ckmc-split"]
fn cloned_split_store_profile() {
    use std::sync::Arc;
    use std::time::Instant;

    let root = std::path::PathBuf::from(std::env::var_os("MC_SPLIT_CLONE").expect("clone root"))
        .canonicalize()
        .unwrap();
    assert!(root.starts_with(
        std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join("magic-context/ckmc-split")
    ));
    let sessions: Vec<String> = std::env::var("MC_SPLIT_SESSIONS")
        .expect("sessions")
        .split(',')
        .map(str::to_string)
        .collect();
    let wal_bytes = |dir: &std::path::Path| {
        std::fs::metadata(dir.join("store.db-wal")).map_or(0, |meta| meta.len())
    };
    let median = |mut samples: Vec<f64>| {
        samples.sort_by(f64::total_cmp);
        (samples[0], samples[samples.len() / 2])
    };
    let lsof = |label: &str| {
        let output = std::process::Command::new("lsof")
            .args(["-p", &std::process::id().to_string()])
            .output()
            .unwrap();
        for line in String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter(|line| line.contains(".db"))
        {
            assert!(
                line.contains(root.to_str().unwrap()),
                "non-clone database opened: {line}"
            );
            println!("split-profile-lsof {label} {line}");
        }
    };

    // Today's layout: the whole row is rewritten when two units are appended, as
    // `commit_transform` did before the split.
    let today = root.join("today");
    let raw = rusqlite::Connection::open(today.join("store.db")).unwrap();
    raw.execute_batch("PRAGMA wal_autocheckpoint = 0;").unwrap();
    for session in &sessions {
        let (core_json, meta_json): (String, String) = raw
            .query_row(
                "SELECT core_state, meta FROM mc_cache_state WHERE session_id = ?1",
                params![session],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let mut parse = Vec::new();
        for _ in 0..15 {
            // Today's full load: read both blobs and parse them.
            let started = Instant::now();
            let (core_json, meta_json): (String, String) = raw
                .query_row(
                    "SELECT core_state, meta FROM mc_cache_state WHERE session_id = ?1",
                    params![session],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            let core: CoreState = serde_json::from_str(&core_json).unwrap();
            let meta: ModuleMeta = serde_json::from_str(&meta_json).unwrap();
            parse.push(started.elapsed().as_secs_f64() * 1000.0);
            std::hint::black_box((core, meta));
        }
        let mut core: CoreState = serde_json::from_str(&core_json).unwrap();
        let mut meta: ModuleMeta = serde_json::from_str(&meta_json).unwrap();
        let next_unit = core.frozen_units.len();
        core.frozen_units.push(unit(next_unit));
        core.frozen_units.push(unit(next_unit + 1));
        meta.coverage_ordinal = Some(meta.coverage_ordinal.unwrap_or(0) + 1);
        raw.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .unwrap();
        let before = wal_bytes(&today);
        let started = Instant::now();
        raw.execute(
            "UPDATE mc_cache_state SET row_version = row_version + 1, core_state = ?2, meta = ?3
              WHERE session_id = ?1",
            params![
                session,
                serde_json::to_string(&core).unwrap(),
                serde_json::to_string(&meta).unwrap()
            ],
        )
        .unwrap();
        let commit_ms = started.elapsed().as_secs_f64() * 1000.0;
        let (parse_min, parse_median) = median(parse);
        println!(
            "split-profile today session={session} row_bytes={} read_parse_min_ms={parse_min:.2} \
             read_parse_median_ms={parse_median:.2} append2_commit_wal_bytes={} commit_ms={commit_ms:.1}",
            core_json.len() + meta_json.len(),
            wal_bytes(&today) - before
        );
    }
    lsof("today");
    drop(raw);

    // The split layout through the real store: the open runs migration 63.
    let split = root.join("split");
    let started = Instant::now();
    let store = McStore::open(&store_descriptor(&split)).unwrap();
    println!(
        "split-profile migrate seconds={:.2} schema={}",
        started.elapsed().as_secs_f64(),
        store.module_store_schema_version().unwrap()
    );
    store.install_context_domain(Arc::new(
        crate::SqliteContextDomain::open(&split.join("context.db")).unwrap(),
    ));
    exec(&store, "PRAGMA wal_autocheckpoint = 0;");
    lsof("split");
    for session in &sessions {
        let session = session.as_str();
        let small = store.load_meta(session).unwrap();
        let mut snapshot_ms = Vec::new();
        let mut meta_ms = Vec::new();
        let mut decode_ms = Vec::new();
        let mut planning_ms = Vec::new();
        for pass in 0..13 {
            let started = Instant::now();
            let snapshot = store.load_transform_snapshot(session).unwrap();
            snapshot_ms.push(started.elapsed().as_secs_f64() * 1000.0);
            std::hint::black_box(snapshot);
            // The codec's own cost: read the small row, chunks and sections, check every
            // digest and parse them, comparable with today's read-and-parse of the blobs.
            let started = Instant::now();
            let decoded = store
                .inner
                .with_conn(|conn| {
                    let transaction = conn.unchecked_transaction()?;
                    let decoded = read_decoded(&transaction, session)?;
                    transaction.commit()?;
                    Ok(decoded)
                })
                .unwrap();
            decode_ms.push(started.elapsed().as_secs_f64() * 1000.0);
            std::hint::black_box(decoded);
            let started = Instant::now();
            std::hint::black_box(store.load_meta(session).unwrap());
            meta_ms.push(started.elapsed().as_secs_f64() * 1000.0);
            // The planning reads of a v93 pass: the boundary-validated coordinates twice and
            // the covered end ordinal once, as `cloned_boundary_validation_profile` measures.
            let started = Instant::now();
            let first = store.cached_context_boundaries(session).unwrap();
            let end = store.max_compartment_end_ordinal(session).unwrap();
            let second = store.cached_context_boundaries(session).unwrap();
            assert_eq!(first, second);
            if pass > 0 {
                planning_ms.push(started.elapsed().as_secs_f64() * 1000.0);
            }
            std::hint::black_box(end);
        }
        let (snapshot_min, snapshot_median) = median(snapshot_ms);
        let (meta_min, meta_median) = median(meta_ms);
        let (decode_min, decode_median) = median(decode_ms);
        let (planning_min, planning_median) = median(planning_ms);
        println!(
            "split-profile load session={session} snapshot_min_ms={snapshot_min:.2} \
             snapshot_median_ms={snapshot_median:.2} decode_min_ms={decode_min:.2} \
             decode_median_ms={decode_median:.2} load_meta_min_ms={meta_min:.3} \
             load_meta_median_ms={meta_median:.3} planning_min_ms={planning_min:.3} \
             planning_warm_median_ms={planning_median:.3}"
        );

        let commit = |label: &str, edit: &dyn Fn(&mut CoreState, &mut ModuleMeta)| {
            let loaded = store.load(session).unwrap();
            let mut core = loaded.core.clone();
            let mut meta = loaded.meta.clone();
            edit(&mut core, &mut meta);
            // Start from an empty WAL so its size afterwards is exactly what the commit wrote.
            exec(&store, "PRAGMA wal_checkpoint(TRUNCATE);");
            let before = wal_bytes(&split);
            let started = Instant::now();
            commit_over_session(&store, session, &loaded, &core, &meta);
            println!(
                "split-profile commit session={session} kind={label} wal_bytes={} commit_ms={:.1} \
                 units={}",
                wal_bytes(&split) - before,
                started.elapsed().as_secs_f64() * 1000.0,
                core.frozen_units.len()
            );
        };
        // The first commit after the migration records every digest under sv 1.
        commit("first_after_migration_append2", &|core, _| {
            let next = core.frozen_units.len();
            core.frozen_units.extend(units(next..next + 2));
        });
        commit("append2", &|core, meta| {
            let next = core.frozen_units.len();
            core.frozen_units.extend(units(next..next + 2));
            meta.coverage_ordinal = Some(meta.coverage_ordinal.unwrap_or(0) + 1);
        });
        commit("tail_baseline_refresh", &|_, meta| {
            if let Some(tail) = meta.tail_hygiene_baseline.as_mut() {
                tail.computed_at_ms += 1;
            }
        });
        commit("hard_remint_all_units", &|core, _| {
            for unit in &mut core.frozen_units {
                unit.reset_rule.push('x');
            }
        });
        exec(&store, "PRAGMA wal_checkpoint(TRUNCATE);");
        let before = wal_bytes(&split);
        let mut meta = small.meta.clone();
        meta.historian.last_no_fire = Some(format!("probe {}", meta.coverage_ordinal.unwrap_or(0)));
        let current = store.load_meta(session).unwrap().row_version;
        store.commit_meta(session, current, &meta).unwrap();
        println!(
            "split-profile commit session={session} kind=commit_meta wal_bytes={}",
            wal_bytes(&split) - before
        );
    }
}

fn commit_over_session(
    store: &McStore,
    session: &str,
    loaded: &crate::LoadedState,
    core: &CoreState,
    meta: &ModuleMeta,
) {
    store
        .commit_transform(
            session,
            TransformCommit {
                expected: loaded.row_version,
                core,
                meta,
                sections: SectionsCommit::over(loaded.sections.as_ref()),
                consumed_drop_ids: &[],
                first_applied_command_ids: &[],
                memory_revision: None,
                compartment_max_seq: None,
                project_root: None,
                first_divergence: None,
                scheduler_observation: None,
                scheduler_request_observed_at_ms: None,
                scheduler_full_array_fingerprint: None,
                scheduler_eligible_supersession_count: None,
                scheduler_withheld_by_tag_window: None,
                scheduler_withheld_by_exempt_message: None,
                scheduler_applied_supersession_count: None,
                scheduler_applied_reductions: false,
                overlays: crate::TransformOverlayBatch::default(),
            },
        )
        .unwrap();
}
