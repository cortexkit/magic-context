//! Production transitions onto a published cut. Setup uses only saved, window-bounded state.
use super::*;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct PublishedCut {
    #[serde(default)]
    pub(super) first_ordinal: u64,
    pub(super) lineage: String,
    pub(super) version: u64,
    #[serde(default)]
    pub(super) covered_through: Option<u64>,
    pub(super) generation: u64,
    #[serde(default)]
    pub(super) head: String,
    #[serde(default)]
    parent_namespace: String,
    #[serde(default)]
    parent_revision: Option<mc_store::CompartmentSourceRevision>,
    tag_high_water: i64,
    #[serde(default)]
    cut_mid: String,
    #[serde(default)]
    cut_digest: String,
    /// Legacy payloads may outlive their staging namespace.
    #[serde(default)]
    history_identity: Option<(String, i64, i64, bool)>,
    /// An older numeric payload slot can remain readable without copying it
    /// into the new lineage-qualified slot or changing the store schema.
    #[serde(default)]
    pub(super) seed_suffix: Option<String>,
}

/// Group candidates by ordinal without treating arbitrary lineage text as slot
/// syntax. Distinct publishing lineages at the same ordinal remain independent.
pub(super) fn cut_key(first: u64, lineage: &str) -> String {
    format!(
        "{first:020}:{}",
        contract::digest::content_digest(&json!(lineage))
    )
}

impl PublishedCut {
    pub(super) fn key(&self) -> String {
        cut_key(self.first_ordinal, &self.lineage)
    }
    pub(super) fn candidate_json(&self) -> Result<String, HandlerOutcome> {
        serde_json::to_string(&CutCandidate {
            key: self.key(),
            first_ordinal: self.first_ordinal,
            mid: self.cut_mid.clone(),
            digest: self.cut_digest.clone(),
            version: self.version,
            legacy_seed_suffix: self.seed_suffix.clone(),
        })
        .map_err(transient)
    }
}

#[derive(Serialize, Deserialize)]
struct CutCandidate {
    key: String,
    first_ordinal: u64,
    mid: String,
    digest: String,
    version: u64,
    legacy_seed_suffix: Option<String>,
}

pub(super) fn deserialize_cut_cache<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<BTreeMap<String, PublishedCut>, D::Error> {
    let value = Value::deserialize(deserializer)?;
    let mut cuts = BTreeMap::<String, PublishedCut>::new();
    for (key, raw) in value.as_object().into_iter().flatten() {
        let Ok(mut cut) = serde_json::from_value::<PublishedCut>(raw.clone()) else {
            continue;
        };
        if cut.first_ordinal == 0 {
            let Some(first) = key
                .split(':')
                .next()
                .and_then(|first| first.parse::<u64>().ok())
            else {
                continue;
            };
            cut.first_ordinal = first;
            cut.seed_suffix = Some(first.to_string());
        }
        if cut.first_ordinal == 0 {
            continue;
        }
        let key = cut.key();
        if cuts.get(&key).is_none_or(|old| old.version <= cut.version) {
            cuts.insert(key, cut);
        }
    }
    Ok(cuts)
}

#[derive(Serialize, Deserialize)]
pub(super) struct ParentHistory {
    namespace: String,
    revision: Option<mc_store::CompartmentSourceRevision>,
}

#[derive(Serialize, Deserialize)]
struct PendingStage {
    namespace: String,
    version: u64,
}

#[cfg(test)]
thread_local! { static CRASH_AFTER_STAGE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }

#[cfg(test)]
pub(super) fn crash_after_stage_for_test() {
    CRASH_AFTER_STAGE.with(|flag| flag.set(true));
}

pub(super) fn split_head_at(ranges: &mut Vec<view::ViewRange>, first: u64) {
    if let Some(index) = ranges.iter().position(|range| {
        matches!(range, view::ViewRange::Replace { from, to, .. } if *from < first && first < *to)
    }) {
        let to = ranges[index].to();
        if let view::ViewRange::Replace { to, .. } = &mut ranges[index] { *to = first; }
        ranges.insert(index + 1, view::ViewRange::replace(first, to, "[]"));
    }
}

impl AsyncRecord {
    #[cfg(test)]
    pub(super) fn newest_published_cut(&self) -> Option<&PublishedCut> {
        self.published_cuts.values().max_by_key(|cut| cut.version)
    }

    #[cfg(test)]
    pub(super) fn cached_cut(&self, first: u64) -> Option<&PublishedCut> {
        self.published_cuts
            .values()
            .filter(|cut| cut.first_ordinal == first)
            .max_by_key(|cut| cut.version)
    }

    pub(super) fn published_cut_for(
        &self,
        store: &McStore,
        first: u64,
        lineage: &str,
    ) -> Result<Option<PublishedCut>, HandlerOutcome> {
        let key = cut_key(first, lineage);
        if let Some(cut) = self.published_cuts.get(&key) {
            return Ok(Some(cut.clone()));
        }
        if let Some(raw) = store
            .load_async_compaction_baseline(&self.reference(), &format!("published-cut-meta:{key}"))
            .map_err(transient)?
        {
            return serde_json::from_str(&raw).map(Some).map_err(transient);
        }
        let mut old = store
            .load_async_compaction_baseline(
                &self.reference(),
                &format!("published-cut-meta:{first}"),
            )
            .map_err(transient)?
            .map(|raw| serde_json::from_str::<PublishedCut>(&raw).map_err(transient))
            .transpose()?
            .filter(|cut| cut.lineage == lineage);
        if let Some(cut) = &mut old {
            cut.first_ordinal = first;
            cut.seed_suffix = Some(first.to_string());
        }
        Ok(old)
    }

    fn selected_cut_seed(
        &self,
        store: &McStore,
        first: u64,
        lineage: &str,
    ) -> Result<Option<(PublishedCut, cut_seed::CutSeed)>, HandlerOutcome> {
        let key = cut_key(first, lineage);
        let mut selected = key.clone();
        let mut bundle = store
            .load_async_cut_bundle(&self.reference(), &selected)
            .map_err(transient)?;
        if bundle.is_none() {
            let alias = self
                .published_cut_for(store, first, lineage)?
                .and_then(|cut| cut.seed_suffix);
            let Some(alias) = alias else { return Ok(None) };
            selected = alias;
            bundle = store
                .load_async_cut_bundle(&self.reference(), &selected)
                .map_err(transient)?;
        }
        let Some(bundle) = bundle else {
            return Ok(None);
        };
        let mut seed: cut_seed::CutSeed = serde_json::from_str(&bundle.seed).map_err(transient)?;
        let cut = bundle
            .metadata
            .as_ref()
            .map(|raw| serde_json::from_str::<PublishedCut>(raw).map_err(transient))
            .transpose()?
            .or_else(|| {
                self.published_cuts
                    .get(&key)
                    .filter(|cut| cut.seed_suffix.is_some())
                    .cloned()
            });
        let Some(mut cut) = cut else { return Ok(None) };
        if cut.first_ordinal == 0 {
            cut.first_ordinal = first;
        }
        if seed.first_ordinal != first || cut.first_ordinal != first {
            return Ok(None);
        }
        if selected != key && cut.seed_suffix.is_none() {
            cut.seed_suffix = Some(selected);
        }
        if cut.cut_mid.is_empty() {
            cut.cut_mid = seed.cut_mid.clone();
        }
        if cut.cut_digest.is_empty() {
            cut.cut_digest = seed.cut_digest.clone();
        }
        if cut.history_identity.is_none() {
            cut.history_identity = seed
                .recovery_history_ref
                .as_ref()
                .and_then(|history| history.identity.clone());
            if cut.history_identity.is_none() {
                cut.history_identity = store
                    .compartment_history_identity(&format!(
                        "{}:async:{}",
                        self.key.engine_key(),
                        cut.generation
                    ))
                    .map_err(transient)?;
            }
        }
        seed.pending_history_objects.extend(bundle.history_objects);
        Ok(Some((cut, seed)))
    }

    pub(super) fn prepare_cut_metadata(&mut self, store: &McStore) -> Result<(), HandlerOutcome> {
        #[derive(Deserialize)]
        struct Identity {
            cut_mid: String,
            cut_digest: String,
            #[serde(default)]
            recovery_history_ref: Option<IdentityRef>,
        }
        #[derive(Deserialize)]
        struct IdentityRef {
            identity: Option<(String, i64, i64, bool)>,
        }
        let reference = self.reference();
        let engine_key = self.key.engine_key();
        let mut prepared = Vec::new();
        for cut in self
            .published_cuts
            .values_mut()
            .chain(self.pending_cut_metadata.values_mut())
        {
            if !cut.cut_mid.is_empty() && !cut.cut_digest.is_empty() {
                continue;
            }
            let suffix = cut.seed_suffix.clone().unwrap_or_else(|| cut.key());
            let Some(raw) = store
                .load_async_compaction_baseline(&reference, &format!("published-cut:{suffix}"))
                .map_err(transient)?
            else {
                continue;
            };
            let identity: Identity = serde_json::from_str(&raw).map_err(transient)?;
            cut.cut_mid = identity.cut_mid;
            cut.cut_digest = identity.cut_digest;
            cut.history_identity = identity
                .recovery_history_ref
                .and_then(|history| history.identity);
            if cut.history_identity.is_none() {
                cut.history_identity = store
                    .compartment_history_identity(&format!("{engine_key}:async:{}", cut.generation))
                    .map_err(transient)?;
            }
            prepared.push((cut.key(), cut.clone()));
        }
        for (key, cut) in prepared {
            self.pending_cut_metadata.entry(key).or_insert(cut);
        }
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn published_cut(
        &self,
        store: &McStore,
        first: u64,
    ) -> Result<Option<PublishedCut>, HandlerOutcome> {
        if let Some(cut) = self.cached_cut(first) {
            return Ok(Some(cut.clone()));
        }
        let candidates = store
            .load_async_cut_candidates(&self.reference(), first)
            .map_err(transient)?
            .into_iter()
            .map(|raw| serde_json::from_str::<CutCandidate>(&raw).map_err(transient))
            .collect::<Result<Vec<_>, _>>()?;
        let slot = candidates
            .into_iter()
            .max_by_key(|cut| cut.version)
            .map(|candidate| format!("published-cut-meta:{}", candidate.key))
            .unwrap_or_else(|| format!("published-cut-meta:{first}"));
        let mut cut = store
            .load_async_compaction_baseline(&self.reference(), &slot)
            .map_err(transient)?
            .map(|raw| serde_json::from_str::<PublishedCut>(&raw).map_err(transient))
            .transpose()?;
        if let Some(cut) = &mut cut {
            if cut.first_ordinal == 0 {
                cut.first_ordinal = first;
                cut.seed_suffix = Some(first.to_string());
            }
        }
        Ok(cut)
    }

    pub(super) fn trim_published_cut_cache(&mut self) {
        while self.published_cuts.len() > 4 {
            let key = self
                .published_cuts
                .iter()
                .min_by_key(|(_, cut)| cut.version)
                .unwrap()
                .0
                .clone();
            let old = self.published_cuts.remove(&key).unwrap();
            // The immutable seed and history remain durable undo targets; only
            // the disposable namespace and in-record cache entry are evicted.
            self.retired_cut_stages.push(format!(
                "{}:async:{}",
                self.key.engine_key(),
                old.generation
            ));
            self.pending_cut_metadata.entry(key).or_insert(old);
        }
    }

    pub(super) fn next_generation(&self) -> Result<u64, HandlerOutcome> {
        self.published_cuts
            .values()
            .map(|cut| cut.generation)
            .chain(
                self.retired_cut_stages
                    .iter()
                    .filter_map(|namespace| namespace.rsplit(':').next()?.parse::<u64>().ok()),
            )
            .fold(self.generation, u64::max)
            .checked_add(1)
            .ok_or_else(|| transient("async generation exhausted"))
    }

    pub(super) fn restore_undo_edits(&mut self, store: &McStore) -> Result<(), HandlerOutcome> {
        if !self.pending_undo_edits {
            return Ok(());
        }
        let mids = self
            .entries
            .range(self.lineage_first_ordinal..)
            .map(|(_, entry)| entry.mid.clone())
            .collect::<Vec<_>>();
        for archive in store
            .load_async_undo_edits_for_messages(&self.reference(), &mids)
            .map_err(transient)?
        {
            self.frozen_edits
                .merge(&frozen_edits::FrozenEdits::from_json(&archive)?);
        }
        self.pending_undo_edits = false;
        Ok(())
    }

    pub(super) fn active_seed_is_unsafe(&self, store: &McStore) -> Result<bool, HandlerOutcome> {
        let Some(first) = self.cut_first_ordinal else {
            return Ok(false);
        };
        if let Some(seed) = &self.cut_seed {
            return Ok(!seed.boundary_safe());
        }
        Ok(store
            .load_async_compaction_baseline(&self.reference(), &cut_seed::CutSeed::slot(first))
            .map_err(transient)?
            .and_then(|raw| serde_json::from_str::<cut_seed::CutSeed>(&raw).ok())
            .is_none_or(|seed| !seed.boundary_safe()))
    }

    pub(super) fn cleanup_retired_cut_stages(
        &mut self,
        store: &McStore,
    ) -> Result<(), HandlerOutcome> {
        let mut pending = Vec::new();
        for namespace in &self.retired_cut_stages {
            let referenced = namespace == &self.namespace()
                || self.published_cuts.values().any(|cut| {
                    namespace == &format!("{}:async:{}", self.key.engine_key(), cut.generation)
                        || namespace == &cut.parent_namespace
                })
                || self
                    .pending_parent_history
                    .as_ref()
                    .is_some_and(|parent| &parent.namespace == namespace);
            if referenced {
                pending.push(namespace.clone());
            } else {
                store
                    .discard_staged_namespace(namespace, &self.project().to_string_lossy())
                    .map_err(transient)?;
            }
        }
        self.retired_cut_stages = pending;
        Ok(())
    }

    pub(super) fn recovery_seed(
        &self,
        store: &McStore,
    ) -> Result<Option<Arc<cut_seed::CutSeed>>, HandlerOutcome> {
        if let Some(seed) = &self.cut_seed {
            if !seed.boundary_safe() {
                return Err(error(
                    "unsafe_cut_seed",
                    "the stored head requires a fresh full lineage",
                ));
            }
            return Ok(Some(Arc::clone(seed)));
        }
        if self.lineage_first_ordinal == 0 {
            return Ok(None);
        }
        if let Some(parent) = self.setup.descends_from.as_ref().filter(|parent| {
            parent.through_ordinal.checked_add(1) == Some(self.lineage_first_ordinal)
        }) {
            return self
                .selected_cut_seed(store, self.lineage_first_ordinal, &parent.lineage_id)
                .map(|selected| {
                    selected
                        .filter(|(cut, seed)| {
                            cut.lineage == parent.lineage_id && seed.boundary_safe()
                        })
                        .map(|(_, seed)| Arc::new(seed))
                });
        }
        // Numeric payload slots predate lineage-qualified targets. They are
        // usable only when no modern candidates exist for this ordinal.
        if !store
            .load_async_cut_candidates(&self.reference(), self.lineage_first_ordinal)
            .map_err(transient)?
            .is_empty()
        {
            return Ok(None);
        }
        store
            .load_async_compaction_baseline(
                &self.reference(),
                &format!("published-cut:{}", self.lineage_first_ordinal),
            )
            .map_err(transient)?
            .map(|raw| {
                serde_json::from_str::<cut_seed::CutSeed>(&raw)
                    .map(Arc::new)
                    .map_err(transient)
            })
            .transpose()
    }

    pub(super) fn repair_cut_history(
        &self,
        store: &McStore,
        history: &mut Vec<mc_store::StoredCompartment>,
        through: Option<u64>,
    ) -> Result<(), HandlerOutcome> {
        let Some(seed) = self.recovery_seed(store)? else {
            return Ok(());
        };
        let mut next = seed.lineage_from as i64;
        for c in history.iter() {
            if c.start_message <= next && c.end_message >= next {
                next = c.end_message.saturating_add(1);
            }
        }
        if next >= seed.first_ordinal as i64 {
            return Ok(());
        }
        // A replacement summary can straddle the cut and then be removed by
        // a fork. The staged history is the last independent source for the
        // unreadable prefix; window messages are replayed from held rows.
        let mut restored = seed
            .recovery_compartments(store, &self.reference())?
            .into_iter()
            .filter(|c| through.is_none_or(|end| c.end_message <= end as i64))
            .collect::<Vec<_>>();
        let end = restored.iter().map(|c| c.end_message).max().unwrap_or(-1);
        restored.extend(history.iter().filter(|c| c.start_message > end).cloned());
        *history = restored;
        Ok(())
    }

    fn stage_slot() -> &'static str {
        "pending-cut-stage"
    }

    pub(super) fn cleanup_pending_cut_stage(&self, store: &McStore) -> Result<(), HandlerOutcome> {
        let Some(raw) = store
            .load_async_compaction_baseline(&self.reference(), Self::stage_slot())
            .map_err(transient)?
        else {
            return Ok(());
        };
        let pending: PendingStage = serde_json::from_str(&raw).map_err(transient)?;
        let namespace = pending.namespace;
        let prefix = format!("{}:async:", self.key.engine_key());
        if !namespace.starts_with(&prefix) {
            return Err(invalid("staged namespace belongs to another conversation"));
        }
        let referenced = namespace == self.namespace()
            || self
                .published_cuts
                .values()
                .any(|cut| namespace == format!("{prefix}{}", cut.generation));
        if !referenced {
            store
                .discard_staged_namespace(&namespace, &self.project().to_string_lossy())
                .map_err(transient)?;
            store
                .retire_unannounced_async_view(&self.reference(), pending.version)
                .map_err(transient)?;
        }
        self.save_stage_intent(store, None)
    }

    fn save_stage_intent(
        &self,
        store: &McStore,
        stage: Option<(&str, u64)>,
    ) -> Result<(), HandlerOutcome> {
        let record = serde_json::to_string(self).map_err(transient)?;
        let reference = self.reference();
        let key = self.key.store_key().conversation_key();
        let mut save = store.async_compaction_save(&reference, &key, &self.key.session, &record);
        save.baseline(
            Self::stage_slot(),
            stage
                .map(|(namespace, version)| PendingStage {
                    namespace: namespace.into(),
                    version,
                })
                .map(|intent| serde_json::to_string(&intent))
                .transpose()
                .map_err(transient)?,
        );
        save.commit().map_err(transient)
    }

    pub(super) fn forward_parent_history(&mut self, store: &McStore) -> Result<(), HandlerOutcome> {
        let Some(parent) = self.pending_parent_history.as_ref() else {
            return Ok(());
        };
        let namespace = self.namespace();
        if store
            .compartment_source_revision(&parent.namespace)
            .map_err(transient)?
            != parent.revision
            && store
                .compartment_source_revision(&namespace)
                .map_err(transient)?
                == parent.revision
        {
            let compartments = store
                .load_compartments(&parent.namespace)
                .map_err(transient)?;
            store
                .replace_compartments(&namespace, &compartments)
                .map_err(transient)?;
            store
                .adopt_compartment_history_identity(&parent.namespace, &namespace)
                .map_err(transient)?;
            store.arm_soft_refresh(&namespace).map_err(transient)?;
        }
        self.pending_parent_history = None;
        Ok(())
    }

    pub(super) fn keep_published_cut(
        &mut self,
        store: &McStore,
        codec: codec::Codec,
        first: u64,
        view: &view::CompactionView,
    ) -> Result<(), HandlerOutcome> {
        let mut seed = match self.capture_cut_seed(store, codec, first)? {
            Ok(seed) => seed,
            Err(reason) => {
                #[cfg(test)]
                measurements::deferred(store, reason.code());
                tracing::debug!(
                    first,
                    reason = reason.code(),
                    "cut seed unavailable; descent will be refused"
                );
                return Ok(());
            }
        };
        if !seed.boundary_safe() {
            #[cfg(test)]
            measurements::deferred(store, "unsafe_cut_seed");
            return Ok(());
        }
        // The new lineage adopts this published view, not a parent's older
        // applied view. Its candidate must satisfy the same pruning guard;
        // parent views remain available only on the parent until descent.
        if self.produced_view.iter().any(|held| {
            held.view().map_or(true, |v| {
                v.replacement
                    .iter()
                    .any(|m| !m.meta.synthetic && m.meta.ordinal.is_some_and(|n| n < first))
            })
        }) {
            #[cfg(test)]
            measurements::deferred(store, "cut_retains_live_prefix");
            return Ok(());
        }
        let candidate = self
            .published_engine
            .get(&view.view_version)
            .ok_or_else(|| transient("published cut engine view missing"))?;
        seed.window.produced_view = Some(candidate.json.to_string());
        seed.window.applied_view = seed.window.produced_view.clone();
        seed.window
            .views
            .retain(|(version, _, _, _)| *version >= view.view_version);
        if let Some(record) = &mut seed.window.record {
            record.insert("applied".into(), json!(view.view_version));
            record.insert("frozen_edits_version".into(), json!(view.view_version));
        }
        if let Some(edits) = &candidate.frozen_edits {
            let mut frozen = self.frozen_edits.clone();
            frozen.merge(edits);
            let mids = self
                .entries
                .range(first..)
                .map(|(_, entry)| entry.mid.clone())
                .collect();
            seed.window.frozen_edits = Some(frozen.only_mids(&mids).json()?);
        }
        let mut head = Vec::<Value>::new();
        for range in view
            .ranges
            .iter()
            .take_while(|range| matches!(range, view::ViewRange::Replace { .. }))
        {
            if let view::ViewRange::Replace { bytes, .. } = range {
                head.extend(serde_json::from_str::<Vec<Value>>(bytes).map_err(transient)?);
            }
        }
        let generation = self
            .generation
            .checked_add(view.view_version)
            .and_then(|v| v.checked_add(1))
            .ok_or_else(|| transient("async generation exhausted"))?;
        let namespace = format!("{}:async:{generation}", self.key.engine_key());
        // Persist one intent before any namespace writes. A crash can leave at
        // most this one unreferenced stage; the next publication removes it.
        self.cleanup_pending_cut_stage(store)?;
        self.save_stage_intent(store, Some((&namespace, view.view_version)))?;
        if let Some(head) = &seed.window.head {
            store
                .adopt_namespace_head(&namespace, head)
                .map_err(transient)?;
        }
        if let Some(identity) = seed
            .recovery_history_ref
            .as_ref()
            .and_then(|history| history.identity.as_ref())
        {
            store
                .set_compartment_history_identity(&namespace, identity)
                .map_err(transient)?;
        }
        let tags = tag_rows_for(self.entries.range(first..).map(|(_, entry)| entry), codec)?;
        let record = serde_json::to_string(&*self).map_err(transient)?;
        let reference = self.reference();
        let key = self.key.store_key().conversation_key();
        let mut save = store.async_compaction_save(&reference, &key, &self.key.session, &record);
        save.tags(&namespace, &tags);
        save.commit().map_err(transient)?;
        #[cfg(test)]
        if CRASH_AFTER_STAGE.with(|flag| flag.get()) {
            std::process::abort();
        }
        let key = cut_key(first, &view.lineage_id);
        let superseded = self.published_cut_for(store, first, &view.lineage_id)?;
        let published = PublishedCut {
            first_ordinal: first,
            lineage: view.lineage_id.clone(),
            version: view.view_version,
            covered_through: seed.summary_end(),
            generation,
            head: serde_json::to_string(&head).map_err(transient)?,
            parent_namespace: self.namespace(),
            parent_revision: store
                .compartment_source_revision(&self.namespace())
                .map_err(transient)?,
            tag_high_water: store
                .tag_cache_summary(&self.namespace())
                .map_err(transient)?
                .max_tag_number,
            cut_mid: seed.cut_mid.clone(),
            cut_digest: seed.cut_digest.clone(),
            history_identity: seed
                .recovery_history_ref
                .as_ref()
                .and_then(|history| history.identity.clone()),
            seed_suffix: None,
        };
        self.pending_cut_metadata
            .insert(key.clone(), published.clone());
        self.published_cuts.insert(key.clone(), published);
        if let Some(old) = superseded {
            self.cut_history_gc_pending = true;
            if let Some(suffix) = old.seed_suffix {
                for prefix in ["published-cut", "published-cut-meta", "published-cut-root"] {
                    self.retired_cut_baselines
                        .push(format!("{prefix}:{suffix}"));
                }
            }
            self.retired_cut_stages.push(format!(
                "{}:async:{}",
                self.key.engine_key(),
                old.generation
            ));
        }
        self.trim_published_cut_cache();
        self.pending_cut_seeds.insert(key, seed);
        #[cfg(test)]
        measurements::staged(store);
        Ok(())
    }
}

impl McHandler {
    pub(super) async fn setup_cut_descent(
        &self,
        binding: &SessionBinding,
        request: &compact::setup::SetupRequest,
        existing: Option<State>,
        store: &McStore,
    ) -> Result<Vec<u8>, HandlerOutcome> {
        let unknown = || {
            bytes(&compact::setup::SetupAnswer::refuse(
                &request.request_id,
                compact::errors::RefuseCode::from_code("unknown_cut"),
                "The lineage does not descend from a cut Magic Context published.",
            ))
        };
        let Some(mut state) = existing else {
            return unknown();
        };
        self.authorize_async(binding, &state)?;
        if state.setup.params != request.params
            || state.setup.composition != request.composition
            || state.setup.preset != request.preset
        {
            return Err(invalid_field("params", "async setup plan is frozen"));
        }
        if state.setup.descends_from == request.descends_from && state.lineage == request.lineage_id
        {
            if state.active_seed_is_unsafe(store)? {
                return bytes(&compact::setup::SetupAnswer::refuse(
                    &request.request_id,
                    compact::errors::RefuseCode::from_code("unsafe_cut_seed"),
                    "The stored head depends on rows outside its cut. Set up a fresh full lineage.",
                ));
            }
            let mut answer = state.initial;
            answer["request_id"] = json!(request.request_id);
            return bytes(&with_checkpoint(answer, None));
        }
        if state.lineage == request.lineage_id {
            return unknown();
        }
        let descends = request.descends_from.as_ref().expect("descending Setup");
        let Some(first) = descends.through_ordinal.checked_add(1) else {
            return unknown();
        };
        let Some((cut, mut seed)) = state.selected_cut_seed(store, first, &descends.lineage_id)?
        else {
            return unknown();
        };
        if cut.lineage != descends.lineage_id {
            return unknown();
        }
        if cut.seed_suffix.is_some() {
            state.pending_cut_metadata.insert(cut.key(), cut.clone());
        }
        if !seed.boundary_safe() {
            return bytes(&compact::setup::SetupAnswer::refuse(
                &request.request_id,
                compact::errors::RefuseCode::from_code("unsafe_cut_seed"),
                "The stored head depends on rows outside its cut. Set up a fresh full lineage.",
            ));
        }
        let current_parent_cut = state.lineage.as_deref() == Some(cut.lineage.as_str())
            && state.published_cuts.values().map(|cut| cut.version).max() == Some(cut.version);
        if current_parent_cut {
            // The current parent may have read more of this same live window
            // since staging. Reuse that observed cache, with matching tags,
            // without asking the runner; an older-cut undo uses its snapshot.
            seed.window.entries = store
                .load_async_compaction_entries_range(&state.reference(), first, i64::MAX as u64)
                .map_err(transient)?
                .into_iter()
                .collect();
        }
        // A saved stage is immutable. A descendant gets its own namespace and
        // reads the live window on its next notice, so an undo cannot inherit
        // the parent's removed window rows or tag identities.
        if let Some(edits) = store
            .load_async_compaction_baseline(&state.reference(), "frozen_edits")
            .map_err(transient)?
        {
            // These source-identified edits can reappear after undo. Archive
            // each message separately; Setup reads only its current window,
            // and a later read looks up only the surviving window's ids.
            let record = serde_json::to_string(&state).map_err(transient)?;
            let reference = state.reference();
            let key = state.key.store_key().conversation_key();
            let mut save =
                store.async_compaction_save(&reference, &key, &state.key.session, &record);
            for (mid, current) in
                frozen_edits::FrozenEdits::from_json(&edits)?.message_snapshots()?
            {
                let slot = format!("undo-native-edits:mid:{mid}");
                let mut merged = store
                    .load_async_compaction_baseline(&reference, &slot)
                    .map_err(transient)?
                    .map(|raw| frozen_edits::FrozenEdits::from_json(&raw))
                    .transpose()?
                    .unwrap_or_default();
                merged.merge(&frozen_edits::FrozenEdits::from_json(&current)?);
                save.baseline(slot, Some(merged.json()?));
            }
            save.commit().map_err(transient)?;
        }
        if request.lineage_id.is_none() {
            return Err(invalid_field(
                "lineage_id",
                "descending Setup needs a lineage",
            ));
        }
        // The selected cut certifies this lineage's prefix. Reset sources can
        // belong to an abandoned branch and must not overwrite that selection.
        state.resync_sources = None;
        state.lineage = request.lineage_id.clone();
        state.ack_lineage_root = request.lineage_id.clone();
        state.ack_selection_pending = false;
        state.pending_native_acks.clear();
        state.native_setup_predecessor = None;
        state.generation = state.next_generation()?;
        state.lineage_first_ordinal = first;
        state.journal = Journal::new_record();
        state.journal.truncate = Some(None);
        state.journal.truncate_below = Some(first);
        let namespace = state.namespace();
        store
            .replace_compartments(
                &namespace,
                &seed.recovery_compartments(store, &state.reference())?,
            )
            .map_err(transient)?;
        if let Some(identity) = seed
            .recovery_history_ref
            .as_ref()
            .and_then(|history| history.identity.as_ref())
            .or(cut.history_identity.as_ref())
        {
            store
                .set_compartment_history_identity(&namespace, identity)
                .map_err(transient)?;
        } else {
            store
                .adopt_compartment_history_identity(
                    &format!("{}:async:{}", state.key.engine_key(), cut.generation),
                    &namespace,
                )
                .map_err(transient)?;
        }
        state.begin_at_cut(store, seed, cut_seed::CutStart::Descending)?;
        let mut engine = state.engine_with_baselines()?;
        for view in [&mut engine.last_produced, &mut engine.last_applied]
            .into_iter()
            .flatten()
        {
            view.range.lineage_id = request.lineage_id.clone().expect("lineage");
        }
        state.adopt_engine(engine)?;
        if let Some(prefix) = &mut state.logical_prefix {
            Arc::make_mut(prefix).lineage = request.lineage_id.clone().expect("lineage");
        }
        state.applied = Some(cut.version);
        state.failure = None;
        state.resync = false;
        state.setup.lineage_id = request.lineage_id.clone();
        state.setup.descends_from = request.descends_from.clone();
        // The initial answer is the published cut's exact head. A historian
        // completion on the parent after staging is folded only by a later view.
        state.pending_parent_history = (current_parent_cut && !cut.parent_namespace.is_empty())
            .then_some(ParentHistory {
                namespace: cut.parent_namespace.clone(),
                revision: cut.parent_revision.clone(),
            });
        state.pending_undo_edits = true;
        let old: compact::setup::SetupAnswer = decode(&state.initial)?;
        let codec = codec::Codec::from_params(&Value::Object(request.params.clone()))?;
        let initial = compact::message::CompactionMessage::new(
            format!("cut-{first}"),
            cut.version,
            compact::message::Range::new(first, first),
            serde_json::from_str(&cut.head).map_err(transient)?,
        );
        let mut answer = compact::setup::SetupAnswer::ready(&request.request_id, initial)
            .with_cache_ttl(state.cache_policy.resolve(&request.model));
        if let Some(ceiling) = old.ceiling() {
            answer = answer.with_ceiling(ceiling.clone());
        }
        if let Some(wait) = old.ride_wait_ms() {
            answer = answer.with_ride_wait_ms(wait);
        }
        // The descent keeps the session's pruning permission as it was.
        answer = answer.with_accepts(old.accepts().to_vec());
        state.initial = serde_json::to_value(answer).map_err(transient)?;
        state.initial["serializer_profile"] = json!(codec.wire_id());
        state.save(store, &[])?;
        self.provider_store
            .async_runtime
            .resident
            .lock()
            .expect("async resident cache")
            .forget(&state.reference());
        bytes(&state.initial)
    }
}

impl McHandler {
    /// Prove a fork whose declared endpoint was appended after the last read.
    /// Probe from the last held row first, then verify the rest of the held
    /// window. Neither read may cross below the retained cut. The declared
    /// endpoint must exist and match even though no engine state used it yet.
    pub(super) async fn verify_unseen_descent(
        &self,
        state: &State,
        lineage: &str,
        header: &str,
        budget: Duration,
    ) -> Result<Option<u64>, HandlerOutcome> {
        let mut fields = header.rsplitn(3, ':');
        let Some(digest) = fields.next() else {
            return Ok(None);
        };
        let Some(through) = fields.next().and_then(|n| n.parse::<u64>().ok()) else {
            return Ok(None);
        };
        let Some(parent) = fields.next() else {
            return Ok(None);
        };
        let first = state
            .cut_first_ordinal
            .unwrap_or(state.lineage_first_ordinal);
        let Some(last) = state.entries.last_key_value().map(|(n, _)| *n) else {
            return Ok(None);
        };
        if first == 0 || last < first || through <= last || state.lineage.as_deref() != Some(parent)
        {
            return Ok(None);
        }
        let deadline = Instant::now() + budget;
        let ranges = [(last, through), (first, last.saturating_sub(1))];
        for (low, high) in ranges {
            if low > high {
                continue;
            }
            let mut from = low;
            loop {
                let page = self.provider_runner.call_for_identity(
                    &state.runner()?, &state.runner_identity(), "session.read",
                    json!({"lineage_id":lineage,"from_ordinal":from,"max_bytes":1_048_576,"media":"descriptors"}),
                    deadline.saturating_duration_since(Instant::now()),
                ).await.map_err(runner_error)?;
                if page["lineage_id"].as_str() != Some(lineage) {
                    return Ok(None);
                }
                let entries: Vec<ReadMessage> = decode(&page["messages"])?;
                let mut expected = from;
                let mut complete = false;
                for entry in entries {
                    if entry.ordinal != expected {
                        return Ok(None);
                    }
                    if entry.ordinal <= last {
                        let Some(held) = state.entries.get(&entry.ordinal) else {
                            return Ok(None);
                        };
                        let held = held.read()?;
                        if held.mid != entry.mid || served_digest(&held)? != served_digest(&entry)?
                        {
                            return Ok(None);
                        }
                    }
                    if entry.ordinal == through && served_digest(&entry)? != digest {
                        return Ok(None);
                    }
                    if entry.ordinal == high {
                        complete = true;
                        break;
                    }
                    expected = expected
                        .checked_add(1)
                        .ok_or_else(|| invalid("ordinal exhausted"))?;
                }
                if complete {
                    break;
                }
                let Some(next) = page["next_from_ordinal"].as_u64() else {
                    return Ok(None);
                };
                if next != expected || next <= from {
                    return Ok(None);
                }
                from = next;
            }
        }
        Ok(Some(through))
    }

    pub(super) async fn ensure_lineage_window(
        &self,
        state: &mut State,
        budget: Duration,
    ) -> Result<(), HandlerOutcome> {
        if !state.entries.is_empty() || state.cut_seed.is_some() {
            return Ok(());
        }
        let raw = self
            .provider_runner
            .call_for_identity(
                &state.runner()?,
                &state.runner_identity(),
                "session.head",
                json!({}),
                budget,
            )
            .await
            .map_err(runner_error)?;
        let head: cortexkit_role_llm_runner::read::HeadMeta = decode(&raw)?;
        let first = head.first_ordinal.unwrap_or(0);
        if let Some(header) = state
            .conditions
            .as_ref()
            .and_then(|h| h.get("first_ordinal"))
        {
            if header.parse::<u64>().ok() != Some(first) {
                return Err(invalid_field(
                    "first_ordinal",
                    "notice and session.head disagree",
                ));
            }
        }
        if first == 0 {
            return Ok(());
        }
        state.native_setup_predecessor = None;
        if state.lineage.is_some() && state.lineage != head.lineage_id {
            return Err(transient("async lineage changed"));
        }
        state.lineage = head.lineage_id;
        state.lineage_first_ordinal = first;
        let cut = head
            .cut
            .ok_or_else(|| invalid_field("cut", "session.head omitted the cut"))?;
        let store = self
            .store
            .get()
            .ok_or_else(|| transient("store unavailable"))?;
        let meta = store.load_meta(&state.namespace()).map_err(transient)?.meta;
        let mut seed = cut_seed::CutSeed::without_rows(
            first,
            cut.mid,
            meta.coverage_compartment_seq
                .unwrap_or(meta.folded_compartment_seq),
            String::new(),
        );
        seed.cut_digest = cut.digest;
        seed.time_basis = Some((i64::try_from(cut.written_at).ok(), None));
        let mut compartments = store
            .load_compartments(&state.namespace())
            .map_err(transient)?;
        let mut next = 0i64;
        let mut ordered = compartments.iter().collect::<Vec<_>>();
        ordered.sort_by_key(|c| c.start_message);
        for c in ordered {
            if c.start_message <= next && c.end_message >= next {
                next = c.end_message.saturating_add(1);
            }
        }
        if next < first as i64 {
            // A failed descent proof discards the old window, not a physical
            // cut the runner still holds. Only a matching published cut can
            // certify the unreadable prefix in the new namespace.
            let retained = store
                .load_async_cut_bundle_for_head(
                    &state.reference(),
                    first,
                    &seed.cut_mid,
                    &seed.cut_digest,
                )
                .map_err(transient)?
                .map(|bundle| {
                    let mut seed = serde_json::from_str::<cut_seed::CutSeed>(&bundle.seed)
                        .map_err(transient)?;
                    seed.pending_history_objects.extend(bundle.history_objects);
                    Ok::<_, HandlerOutcome>(seed)
                })
                .transpose()?
                .filter(|saved| {
                    saved.first_ordinal == first
                        && saved.cut_mid == seed.cut_mid
                        && saved.cut_digest == seed.cut_digest
                        && saved.boundary_safe()
                });
            let Some(mut retained) = retained else {
                return Err(error("cut_rebootstrap_required",
                    "the runner's cut is not uniquely retained; set up with its publishing lineage or start a full lineage"));
            };
            compartments = retained
                .recovery_compartments(store, &state.reference())?
                .into_iter()
                .filter(|row| row.end_message < first as i64)
                .collect();
            let mut restored_through = 0i64;
            let mut ordered = compartments.iter().collect::<Vec<_>>();
            ordered.sort_by_key(|row| row.start_message);
            for row in ordered {
                if row.start_message <= restored_through && row.end_message >= restored_through {
                    restored_through = row.end_message.saturating_add(1);
                }
            }
            if restored_through < first as i64 {
                return Err(error(
                    "cut_rebootstrap_required",
                    "retained history no longer covers the runner's cut; start a full lineage",
                ));
            }
            store
                .replace_compartments(&state.namespace(), &compartments)
                .map_err(transient)?;
            // The fork keeps the certified prefix facts but discards the
            // parent's live window; replay and revalidate those source rows.
            retained.window = cut_seed::CutWindow::default();
            seed = retained;
        }
        if seed.boundary_id.is_empty() {
            if let Some(last) = compartments
                .iter()
                .filter(|c| c.end_message < first as i64)
                .max_by_key(|c| c.sequence)
            {
                seed.compartment_seq = last.sequence;
                seed.boundary_id = last.end_message_id.clone();
            }
        }
        seed.set_recovery_history(
            compartments,
            store
                .compartment_history_identity(&state.namespace())
                .map_err(transient)?,
            None,
        )?;
        state.begin_at_cut(store, seed, cut_seed::CutStart::Fresh)?;
        state.initial["initial"]["range"] = json!({"from":first,"to":first});
        Ok(())
    }
}

#[cfg(test)]
pub(super) mod measurements {
    use super::*;
    #[derive(Clone, Debug, Default)]
    pub(crate) struct Stats {
        pub max_prelude_bytes: usize,
        pub largest_deferred_bytes: usize,
        pub deferred_cuts: u64,
        pub staged_cuts: u64,
        pub opencode_reverts: u64,
        pub pi_tree_switches: u64,
        pub deferrals: BTreeMap<String, u64>,
    }
    fn rows() -> &'static Mutex<BTreeMap<usize, Stats>> {
        static ROWS: OnceLock<Mutex<BTreeMap<usize, Stats>>> = OnceLock::new();
        ROWS.get_or_init(|| Mutex::new(BTreeMap::new()))
    }
    pub(crate) fn prelude(store: &McStore, bytes: usize, deferred: bool) {
        let mut rows = rows().lock().unwrap();
        let stats = rows.entry(store as *const McStore as usize).or_default();
        if deferred {
            stats.deferred_cuts += 1;
            stats.largest_deferred_bytes = stats.largest_deferred_bytes.max(bytes);
        } else {
            stats.max_prelude_bytes = stats.max_prelude_bytes.max(bytes);
        }
    }
    pub(crate) fn staged(store: &McStore) {
        rows()
            .lock()
            .unwrap()
            .entry(store as *const McStore as usize)
            .or_default()
            .staged_cuts += 1;
    }
    pub(crate) fn deferred(store: &McStore, reason: &str) {
        *rows()
            .lock()
            .unwrap()
            .entry(store as *const McStore as usize)
            .or_default()
            .deferrals
            .entry(reason.into())
            .or_default() += 1;
    }
    pub(crate) fn host_rewind(store: &McStore, pi: bool) {
        let mut rows = rows().lock().unwrap();
        let stats = rows.entry(store as *const McStore as usize).or_default();
        if pi {
            stats.pi_tree_switches += 1;
        } else {
            stats.opencode_reverts += 1;
        }
    }
    pub(crate) fn take(store: &McStore) -> Stats {
        rows()
            .lock()
            .unwrap()
            .remove(&(store as *const McStore as usize))
            .unwrap_or_default()
    }
    impl Stats {
        pub(crate) fn merge(&mut self, other: Self) {
            self.max_prelude_bytes = self.max_prelude_bytes.max(other.max_prelude_bytes);
            self.largest_deferred_bytes = self
                .largest_deferred_bytes
                .max(other.largest_deferred_bytes);
            self.deferred_cuts += other.deferred_cuts;
            self.staged_cuts += other.staged_cuts;
            self.opencode_reverts += other.opencode_reverts;
            self.pi_tree_switches += other.pi_tree_switches;
            for (reason, count) in other.deferrals {
                *self.deferrals.entry(reason).or_default() += count;
            }
        }
    }
}
