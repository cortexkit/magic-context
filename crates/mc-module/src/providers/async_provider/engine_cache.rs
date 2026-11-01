//! Validate the independently stored engine cache against its provider baseline.
use super::*;

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Witness {
    namespace: String,
    digest: String,
}

fn digest(loaded: &mc_store::LoadedState) -> Result<String, HandlerOutcome> {
    mc_store::engine_cache_digest(&loaded.core, &loaded.meta).map_err(transient)
}

impl Witness {
    pub(super) fn names(&self, namespace: &str) -> bool {
        self.namespace == namespace
    }

    pub(super) fn validates(
        &self,
        store: &McStore,
        namespace: &str,
    ) -> Result<bool, HandlerOutcome> {
        if self.namespace != namespace {
            return Ok(false);
        }
        Ok(self.digest == digest(&store.load(namespace).map_err(transient)?)?)
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct Checkpoint {
    config: String,
    lineage: Option<String>,
    first: u64,
    through: Option<u64>,
    revision: Option<u64>,
    source_hash: Option<String>,
    prune: Option<u64>,
    engine_epoch: u64,
    #[serde(default)]
    replay_safe: bool,
}

fn config(state: &State) -> Result<String, HandlerOutcome> {
    let bytes = serde_json::to_vec(&(
        state.key.store_key().conversation_key(),
        &state.setup.params,
        &state.setup.model,
        state.setup.context_window,
        state.engine.preset,
    ))
    .map_err(transient)?;
    Ok(crate::sha256_hex(&bytes))
}

fn source_hash(state: &State, through: Option<u64>) -> Result<String, HandlerOutcome> {
    let fingerprints = state
        .entries
        .iter()
        .take_while(|(ordinal, _)| through.is_some_and(|through| **ordinal <= through))
        .map(|(ordinal, entry)| Ok((*ordinal, resync_replay::fingerprint(&entry.read()?)?)))
        .collect::<Result<Vec<_>, HandlerOutcome>>()?;
    Ok(crate::sha256_hex(
        &serde_json::to_vec(&fingerprints).map_err(transient)?,
    ))
}

impl Checkpoint {
    fn capture(state: &State, engine_epoch: u64) -> Result<Self, HandlerOutcome> {
        let through = state.entries.last_key_value().map(|(ordinal, _)| *ordinal);
        Ok(Self {
            config: config(state)?,
            lineage: state.lineage.clone(),
            first: state.lineage_first_ordinal,
            through,
            revision: state.input_revision,
            source_hash: state
                .input_revision
                .is_none()
                .then(|| source_hash(state, through))
                .transpose()?,
            prune: state.reasoning_pruned_generation(),
            engine_epoch,
            replay_safe: false,
        })
    }

    fn matches(&self, state: &State) -> Result<bool, HandlerOutcome> {
        if self.config != config(state)?
            || self.lineage != state.lineage
            || self.first != state.lineage_first_ordinal
            || self.prune != state.reasoning_pruned_generation()
            || self.through.is_some_and(|old| {
                state
                    .entries
                    .last_key_value()
                    .is_none_or(|(last, _)| *last < old)
            })
        {
            return Ok(false);
        }
        match self.revision {
            Some(revision) => Ok(state.input_revision == Some(revision)),
            None => {
                Ok(self.source_hash.as_deref() == Some(source_hash(state, self.through)?.as_str()))
            }
        }
    }
}

pub(super) fn recovery_context(
    state: &State,
) -> Result<mc_store::AsyncCacheRecovery, HandlerOutcome> {
    Ok(mc_store::AsyncCacheRecovery {
        session_ref: state.reference(),
        checkpoint: serde_json::to_value(Checkpoint::capture(state, state.engine.rebuild_epoch)?)
            .map_err(transient)?,
    })
}

#[derive(Serialize, Deserialize)]
enum SavedBaseline {
    Absent,
    Current,
    Published(u64),
    Inline(Arc<str>),
}

impl SavedBaseline {
    fn capture(
        state: &State,
        view: Option<&transform::compaction::View>,
        current: Option<&transform::compaction::View>,
    ) -> Result<Self, HandlerOutcome> {
        let Some(view) = view else {
            return Ok(Self::Absent);
        };
        let identity = view_identity(view);
        if current.is_some_and(|current| view_identity(current) == identity) {
            return Ok(Self::Current);
        }
        if let Some((version, _)) = state
            .published_engine
            .iter()
            .find(|(_, held)| held.identity == identity)
        {
            return Ok(Self::Published(*version));
        }
        if let Some(held) = state
            .produced_view
            .iter()
            .chain(&state.applied_view)
            .find(|held| held.identity == identity)
        {
            return Ok(match held.publication_version {
                Some(version) => Self::Published(version),
                None => Self::Inline(Arc::clone(&held.json)),
            });
        }
        Ok(Self::Inline(
            serde_json::to_string(view).map_err(transient)?.into(),
        ))
    }

    fn resolve(
        &self,
        retained: &BTreeMap<u64, EngineView>,
        current: &EngineView,
    ) -> Result<Option<EngineView>, HandlerOutcome> {
        match self {
            Self::Absent => Ok(None),
            Self::Current => Ok(Some(current.clone())),
            Self::Published(version) => Ok(retained.get(version).cloned()),
            Self::Inline(json) => EngineView::parse(json.to_string()).map(Some),
        }
    }
}

/// A cold view stores fixed engine fields and durable baseline references.
/// Published renderings are referenced, not duplicated; an unpublished Setup
/// baseline retains its original inline bytes.
#[derive(Serialize, Deserialize)]
pub(super) struct Snapshot {
    witness: Witness,
    checkpoint: Checkpoint,
    #[serde(with = "super::engine_header")]
    engine: transform::compaction::State,
    produced: SavedBaseline,
    applied: SavedBaseline,
    #[serde(default)]
    acknowledged: Option<u64>,
}

pub(super) fn snapshot(
    store: &McStore,
    state: &State,
    engine: &transform::compaction::State,
    current: Option<&transform::compaction::View>,
) -> Result<Snapshot, HandlerOutcome> {
    Ok(Snapshot {
        witness: capture(store, state)?,
        checkpoint: Checkpoint::capture(state, engine.rebuild_epoch)?,
        engine: transform::compaction::State {
            compaction_id: engine.compaction_id.clone(),
            preset: engine.preset,
            version_high_water: engine.version_high_water,
            rebuild_epoch: engine.rebuild_epoch,
            last_produced: None,
            last_applied: None,
        },
        produced: SavedBaseline::capture(state, engine.last_produced.as_ref(), current)?,
        applied: SavedBaseline::capture(state, engine.last_applied.as_ref(), current)?,
        acknowledged: resync_replay::acknowledged_version(store, state)?,
    })
}

/// Reconcile only cache states explained by this record's durable artifacts.
/// An unknown/foreign cache is left untrusted for the ordinary rebuild path.
pub(super) fn reconcile(store: &McStore, state: &mut State) -> Result<bool, HandlerOutcome> {
    let namespace = state.namespace();
    let loaded = store.load(&namespace).map_err(transient)?;
    let actual = digest(&loaded)?;
    let known = state
        .engine_cache_witness
        .as_ref()
        .is_some_and(|witness| witness.namespace == namespace && witness.digest == actual);
    if known && !state.resync_replay_pending {
        return Ok(true);
    }
    if state.snapshot_unavailable.is_some() {
        return Ok(false);
    }

    let (rows, _) = store
        .load_async_compaction_views(&state.reference())
        .map_err(transient)?;
    let retained = rows
        .into_iter()
        .filter_map(|(version, _, engine, _)| engine.map(|engine| (version, engine)))
        .map(|(version, engine)| {
            EngineView::parse(engine).map(|view| (version, view.with_publication_version(version)))
        })
        .collect::<Result<BTreeMap<_, _>, _>>()?;
    #[derive(Deserialize)]
    struct Stored {
        #[serde(default)]
        engine_cache_snapshot: Option<Snapshot>,
    }
    for view in retained.values().rev() {
        let Some(mut snapshot) = serde_json::from_str::<Stored>(&view.json)
            .ok()
            .and_then(|stored| stored.engine_cache_snapshot)
        else {
            continue;
        };
        if snapshot.witness.namespace != namespace
            || snapshot.witness.digest != actual
            || snapshot.engine.compaction_id != state.engine.compaction_id
            || snapshot.engine.preset != state.engine.preset
            || snapshot.engine.version_high_water < state.engine.version_high_water
            || !snapshot.checkpoint.matches(state)?
        {
            continue;
        }

        let produced = snapshot.produced.resolve(&retained, view)?;
        if !matches!(snapshot.produced, SavedBaseline::Absent) && produced.is_none() {
            continue;
        }
        let applied = match &state.applied_view {
            Some(applied) => Some(applied.clone()),
            None => snapshot.applied.resolve(&retained, view)?,
        };
        if !matches!(snapshot.applied, SavedBaseline::Absent) && applied.is_none() {
            continue;
        }
        snapshot.engine.last_produced = produced.as_ref().map(EngineView::view).transpose()?;
        snapshot.engine.last_applied = applied.as_ref().map(EngineView::view).transpose()?;
        // Receiving a later acknowledgement must never be undone by recovering
        // the older applied baseline captured with a produced view.
        if let Some(applied) = &applied {
            snapshot.engine.version_high_water =
                snapshot.engine.version_high_water.max(applied.identity.0);
        }
        let reissued = view.resync_reissued;
        let reissued_from = view.resync_reissued_from;
        state.published_engine.extend(retained.clone());
        state.adopt_engine(snapshot.engine)?;
        state.produced_view = produced;
        state.applied_view = applied;
        state.engine_cache_witness = Some(snapshot.witness);
        state.pruned_rebuild_pending = false;
        state.pruned_readopt.clear();
        state.moved_cold_prefix = false;
        if !state.resync
            && state.resync_sources.is_none()
            && resync_replay::acknowledged_version(store, state)? == snapshot.acknowledged
            && (!reissued || resync_replay::acknowledged_version(store, state)? == reissued_from)
        {
            state.resync_replay_pending = false;
        }
        return Ok(true);
    }

    if known {
        return Ok(true);
    }
    // A non-authorizing engine pass can commit bookkeeping before a transport
    // reissue or record save. Its receipt shares the engine CAS transaction,
    // proving that reuse does not buy permission to rewrite the served prefix.
    if let Some(receipt) = store
        .load_async_cache_receipt(&state.reference())
        .map_err(transient)?
    {
        if receipt.namespace == namespace && receipt.cache_digest == actual {
            if let Ok(checkpoint) = serde_json::from_value::<Checkpoint>(receipt.checkpoint) {
                if checkpoint.replay_safe && checkpoint.matches(state)? {
                    state.engine.rebuild_epoch =
                        state.engine.rebuild_epoch.max(checkpoint.engine_epoch);
                    state.engine_cache_witness = Some(Witness {
                        namespace,
                        digest: actual,
                    });
                    return Ok(true);
                }
            }
        }
    }
    Ok(false)
}

pub(super) fn capture(store: &McStore, state: &State) -> Result<Witness, HandlerOutcome> {
    let namespace = state.namespace();
    let loaded = store.load(&namespace).map_err(transient)?;
    Ok(Witness {
        namespace,
        digest: digest(&loaded)?,
    })
}

pub(super) fn matches(store: &McStore, state: &State) -> Result<bool, HandlerOutcome> {
    let loaded = store.load(&state.namespace()).map_err(transient)?;
    if let Some(witness) = state
        .engine_cache_witness
        .as_ref()
        .filter(|witness| witness.namespace == state.namespace())
    {
        return Ok(witness.digest == digest(&loaded)?);
    }
    let Some(produced) = &state.produced_view else {
        return Ok(!loaded.meta.initialized);
    };
    if !loaded.meta.initialized {
        return Ok(false);
    }
    let epoch = loaded
        .meta
        .last_render_config
        .rsplit_once("|broca-compaction:")
        .and_then(|(_, rest)| rest.split('|').next())
        .and_then(|raw| raw.parse::<u64>().ok());
    if epoch != Some(state.engine.rebuild_epoch) {
        return Ok(false);
    }
    if state.engine.preset != transform::compaction::Preset::Head {
        return Ok(true);
    }
    #[derive(Deserialize)]
    struct Frame {
        content: Vec<Box<serde_json::value::RawValue>>,
    }
    #[derive(Deserialize)]
    struct View {
        replacement: Vec<Frame>,
    }
    // The wire decoder retains object spelling. Hash the stored block bytes,
    // not a deserialize/re-serialize round trip that can reorder their keys.
    let view: View = serde_json::from_str(&produced.json).map_err(transient)?;
    for (index, stem) in ["mc_m0", "mc_m1"].into_iter().enumerate() {
        let Some(frame) = view.replacement.get(index) else {
            return Ok(false);
        };
        for (part, block) in frame.content.iter().enumerate() {
            let serialized = block.get();
            let id = ck_wire::block_id(stem, part);
            if !loaded.meta.served_output_fingerprint.iter().any(|stored| {
                stored.block_id == id && stored.content_hash == ck_wire::fingerprint(serialized)
            }) {
                return Ok(false);
            }
        }
    }
    Ok(true)
}
