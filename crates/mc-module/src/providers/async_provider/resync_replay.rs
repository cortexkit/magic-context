//! A resync verifies sources; it does not by itself prove the model lost its cache.
use super::*;

pub(super) const SNAPSHOT_UNAVAILABLE: &str = "applied_snapshot_unavailable";

pub(super) fn unavailable_reason(state: &State) -> String {
    let version = state.snapshot_unavailable.unwrap_or(0);
    if state.snapshot_recovery_used {
        format!("Applied view {version}'s snapshot is unavailable. Fresh Setup recovery was already used for this session; start a new session instead of rebuilding again.")
    } else {
        format!("Applied view {version}'s snapshot is unavailable. Start a fresh full lineage and call compaction.setup to recover it.")
    }
}

pub(super) fn unavailable_error(state: &State) -> HandlerOutcome {
    error(SNAPSHOT_UNAVAILABLE, unavailable_reason(state))
}

pub(super) fn mark_unavailable(state: &mut State, version: u64) {
    state.snapshot_unavailable = Some(version);
    state.resync_replay_pending = false;
    if let Some(source) = &mut state.resync_sources {
        source.replay = None;
    }
}

pub(super) fn missing_snapshot(
    store: &McStore,
    state: &State,
) -> Result<Option<u64>, HandlerOutcome> {
    // Offline first-pass views have not been applied yet. The first live
    // notice checks their stored input proof against the runner's transcript.
    if state.offline_first_pass.is_some() {
        return Ok(None);
    }
    let Some(version) = acknowledged_version(store, state)? else {
        return Ok(None);
    };
    if state.lineage.is_some()
        && state.applied_lineage(store, version)? == state.lineage
        && stored_view(store, &state.reference(), version)?.is_none()
    {
        return Ok(Some(version));
    }
    Ok(None)
}

pub(super) fn park_unavailable(
    store: &McStore,
    state: &mut State,
    seq: Option<u64>,
) -> Result<bool, HandlerOutcome> {
    let Some(version) = state.snapshot_unavailable else {
        return Ok(false);
    };
    let mut changed = false;
    if !state.snapshot_warning_logged {
        tracing::warn!(session_ref=%state.reference(), code=SNAPSHOT_UNAVAILABLE, view_version=version,
            reason=%unavailable_reason(state), "applied view snapshot unavailable");
        state.snapshot_warning_logged = true;
        store
            .retire_unannounced_async_views(&state.reference())
            .map_err(transient)?;
        changed = true;
    }
    if let Some(seq) = seq {
        if seq > state.seq || seq > state.completed_seq {
            state.seq = state.seq.max(seq);
            state.completed_seq = state.completed_seq.max(seq);
            changed = true;
        }
    }
    if changed {
        state.save(store, &[])?;
    }
    Ok(true)
}

pub(super) fn zero(value: &u64) -> bool {
    *value == 0
}

#[derive(Serialize, Deserialize)]
pub(super) struct Replay {
    pub engine: transform::compaction::State,
    pub entries: BTreeMap<u64, String>,
    first_ordinal: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_witness: Option<engine_cache::Witness>,
}

impl Replay {
    pub(super) fn capture(state: &State) -> Result<Option<Self>, HandlerOutcome> {
        if state.entries.is_empty() || state.applied_view.is_none() {
            return Ok(None);
        }
        let engine = state.engine_with_baselines()?;
        if !engine_on_lineage(&engine, state.lineage.as_deref()) {
            return Ok(None);
        }
        Ok(Some(Self {
            engine,
            entries: state
                .entries
                .iter()
                .map(|(ordinal, entry)| Ok((*ordinal, fingerprint(&entry.read()?)?)))
                .collect::<Result<_, HandlerOutcome>>()?,
            first_ordinal: state.lineage_first_ordinal,
            cache_witness: state.engine_cache_witness.clone(),
        }))
    }

    pub(super) fn matches(&self, state: &State) -> Result<bool, HandlerOutcome> {
        if self.first_ordinal != state.lineage_first_ordinal
            || !engine_on_lineage(&self.engine, state.lineage.as_deref())
        {
            return Ok(false);
        }
        // Appended messages do not invalidate a verified prefix. Every old
        // position must survive unchanged; matching only surviving mids would
        // also accept truncation, reordering, or a changed tag assignment.
        for (ordinal, old) in &self.entries {
            let Some(entry) = state.entries.get(ordinal) else {
                return Ok(false);
            };
            if fingerprint(&entry.read()?)? != *old {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

fn engine_on_lineage(engine: &transform::compaction::State, lineage: Option<&str>) -> bool {
    let Some(lineage) = lineage else {
        return false;
    };
    // Equal source rows cannot validate a rendering baseline from another
    // lineage. Restoring it would repeat the engine's lineage refusal on every
    // retry instead of allowing the full reread to initialize its lineage.
    engine
        .last_applied
        .as_ref()
        .is_some_and(|view| view.range.lineage_id == lineage)
        && engine
            .last_produced
            .as_ref()
            .is_none_or(|view| view.range.lineage_id == lineage)
}

pub(super) fn fingerprint(entry: &ReadMessage) -> Result<String, HandlerOutcome> {
    // This is a private equality proof for the same fields as stable_entry,
    // not a content identity computed from descriptor payloads. Content
    // identities remain the runner's digest and part_digests, used as given.
    // Native JSON preserves distinctions such as integer 1 versus float 1.0;
    // The JSON Canonicalization Scheme deliberately erases them and therefore
    // cannot prove equality of the serialized messages.
    let bytes = serde_json::to_vec(&(
        entry.ordinal,
        &entry.mid,
        &entry.message,
        &entry.digest,
        &entry.part_digests,
        &entry.tags,
        &entry.role,
        &entry.written_at,
        &entry.delivered_as,
    ))
    .map_err(transient)?;
    Ok(crate::sha256_hex(&bytes))
}

pub(super) fn retained_views(
    store: &McStore,
    reference: &str,
) -> Result<BTreeMap<u64, EngineView>, HandlerOutcome> {
    store
        .load_async_compaction_views(reference)
        .map_err(transient)?
        .0
        .into_iter()
        .filter_map(|(version, _, engine, _)| engine.map(|engine| (version, engine)))
        .map(|(version, engine)| {
            Ok((
                version,
                EngineView::parse(engine)?.with_publication_version(version),
            ))
        })
        .collect()
}

pub(super) fn stored_view(
    store: &McStore,
    reference: &str,
    version: u64,
) -> Result<Option<EngineView>, HandlerOutcome> {
    store
        .load_async_compaction_views(reference)
        .map_err(transient)?
        .0
        .into_iter()
        .find(|(candidate, _, _, _)| *candidate == version)
        .and_then(|(_, _, engine, _)| engine)
        .map(|engine| EngineView::parse(engine).map(|view| view.with_publication_version(version)))
        .transpose()
}

pub(super) fn restore_baselines(
    store: &McStore,
    state: &mut State,
    retained: &BTreeMap<u64, EngineView>,
) -> Result<(), HandlerOutcome> {
    fn restore(
        baseline: &mut Option<EngineView>,
        preferred: Option<u64>,
        retained: &BTreeMap<u64, EngineView>,
    ) -> Result<(), HandlerOutcome> {
        let Some(held) = baseline else {
            return Ok(());
        };
        let bytes = serde_json::to_vec(&held.view()?).map_err(transient)?;
        let candidates = preferred
            .and_then(|version| retained.get(&version))
            .into_iter()
            .chain(retained.values().rev());
        for candidate in candidates {
            if candidate.identity == held.identity
                && serde_json::to_vec(&candidate.view()?).map_err(transient)? == bytes
            {
                *held = candidate.clone();
                break;
            }
        }
        Ok(())
    }
    restore(&mut state.produced_view, None, retained)?;
    if let Some(version) = acknowledged_version(store, state)? {
        match retained.get(&version) {
            Some(applied) => {
                state.engine.version_high_water =
                    state.engine.version_high_water.max(applied.identity.0);
                state.applied_view = Some(applied.clone());
            }
            None => mark_unavailable(state, version),
        }
        Ok(())
    } else {
        restore(&mut state.applied_view, None, retained)
    }
}

pub(super) fn acknowledged_version(
    store: &McStore,
    state: &State,
) -> Result<Option<u64>, HandlerOutcome> {
    if let Some(version) = state.applied {
        if state.lineage.is_some() && state.applied_lineage(store, version)? == state.lineage {
            return Ok(Some(version));
        }
    }
    // An omitted header does not acknowledge Setup again. Preserve the last
    // qualified native acknowledgement while the session stays on its lineage.
    match state.frozen_edits_version {
        Some(version) if state.applied_lineage(store, version)? == state.lineage => {
            Ok(Some(version))
        }
        _ => Ok(None),
    }
}

pub(super) fn reissue_applied(
    store: &McStore,
    state: &mut State,
    permitted: bool,
) -> Result<Option<view::CompactionView>, HandlerOutcome> {
    if !state.resync_replay_pending {
        return Ok(None);
    }
    let reference = state.reference();
    let basis = acknowledged_version(store, state)?;
    let applied = match basis {
        Some(version) => match state
            .applied_view
            .as_ref()
            .filter(|view| view.publication_version == Some(version))
            .cloned()
            .or(stored_view(store, &reference, version)?)
        {
            Some(view) => view,
            None => {
                mark_unavailable(state, version);
                return Ok(None);
            }
        },
        None => state
            .applied_view
            .as_ref()
            .cloned()
            .ok_or_else(|| transient("resync has no applied engine baseline"))?,
    };
    let mut view = match basis {
        Some(version) => {
            let raw = store
                .load_async_compaction_view(&reference, version)
                .map_err(transient)?
                .ok_or_else(|| transient("resync has no applied view"))?;
            serde_json::from_str::<view::CompactionView>(&raw).map_err(transient)?
        }
        None => {
            // Setup is the applied rendering until the runner acknowledges a
            // published view. Its native replacement is already stored verbatim.
            // A header-only checkout leaves that stored answer unloaded.
            if state.initial.is_null() {
                state.load_setup_payloads(store)?;
            }
            let initial: contract::message::CompactionMessage = decode(&state.initial["initial"])?;
            let (last, entry) = state
                .entries
                .last_key_value()
                .expect("verified nonempty read");
            let mut ranges = vec![view::ViewRange::replace(
                initial.range.from,
                initial.range.to,
                serde_json::to_string(&initial.replacement).map_err(transient)?,
            )];
            if initial.range.to <= *last {
                ranges.push(view::ViewRange::keep(initial.range.to, last + 1));
            }
            view::CompactionView::new(
                &reference,
                0,
                state.lineage.as_deref().unwrap_or_default(),
                contract::lineage::MessageRef {
                    ordinal: *last,
                    mid: entry.mid.clone(),
                },
                ranges,
            )
            .with_cache_ttl(state.cache_ttl())
        }
    };
    if Some(view.lineage_id.as_str()) != state.lineage.as_deref() {
        return Err(transient("resync applied view belongs to another lineage"));
    }
    // An applied view can predate an archive prune. A defer must neither
    // repair its cached bytes nor put the removed content back.
    let mut reconciled = view.ranges.clone();
    state.repair_restoring_edits(&mut reconciled)?;
    if reconciled != view.ranges || state.replacement_restores_pruned(&view.ranges)? {
        return Ok(None);
    }
    // Reissuing a rendering is not a new proposal to cut the raw lineage.
    view.cut = None;
    let version = store
        .reserve_async_compaction_version(&reference, basis.unwrap_or(0))
        .map_err(transient)?;
    view.view_version = version;
    view.digest = view.compute_digest();
    view.check().map_err(|error| transient(error.name()))?;
    let mut edits = match applied.frozen_edits.as_deref() {
        Some(edits) => edits.clone(),
        None => basis
            .map(|version| state.frozen_version_sources(store, version))
            .transpose()?
            .flatten()
            .map(|edits| edits.as_ref().clone())
            .unwrap_or_default(),
    };
    edits.stamp_version(version);
    let mut engine: Value = serde_json::from_str(&applied.json).map_err(transient)?;
    // Allocate a distinct engine identity for the reissued view without
    // replacing newer produced decisions or treating this view as acknowledged.
    state.engine.version_high_water = state
        .engine
        .version_high_water
        .checked_add(1)
        .ok_or_else(|| transient("compaction version exhausted"))?;
    engine["version"] = json!(state.engine.version_high_water);
    engine["native_frozen_edits"] = serde_json::to_value(&edits).map_err(transient)?;
    engine["publication_lineage"] = json!(view.lineage_id);
    engine["publication_version"] = json!(version);
    engine["resync_reissued"] = json!(true);
    engine["resync_reissued_from"] = json!(basis);
    engine["engine_cache_snapshot"] = serde_json::to_value(engine_cache::snapshot(
        store,
        state,
        &state.engine_with_baselines()?,
        None,
    )?)
    .map_err(transient)?;
    let engine = serde_json::to_string(&engine).map_err(transient)?;
    // The immutable view and its applied engine/native-edit snapshot are
    // written together. Existing view retention prunes both in the same row.
    store
        .save_async_compaction_view(
            &reference,
            version,
            &serde_json::to_string(&view).map_err(transient)?,
            &engine,
        )
        .map_err(transient)?;
    state
        .published_engine
        .insert(version, EngineView::parse(engine)?);
    // Leave newer, unacknowledged decisions in the produced engine baseline.
    // Publishing them still requires permission to rewrite cached history;
    // a defer reissues only the runner's acknowledged rendering.
    if let Some(pass) = &mut state.last_pass {
        pass.published = true;
        pass.replayed = !permitted && !pass.rebuild;
    }
    state.resync_replay_pending = false;
    Ok(Some(view))
}
