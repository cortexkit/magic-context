use super::*;

pub(super) struct Suffix {
    entries: Vec<ReadMessage>,
    rendered: Vec<Value>,
    to: u64,
    frozen: frozen_edits::FrozenEdits,
}

impl McHandler {
    /// Read the new lineage before importing anything. Unlike a notice reread,
    /// recovery may lose rows or replace their bytes; only matching identities
    /// may inherit the last applied view's edits. Its horizon never advances
    /// just because this read observes more rows.
    pub(super) async fn read_adoption_suffix(
        &self,
        old: &State,
        request: &compact::setup::SetupRequest,
        record: &crate::offline_move::MoveRecord,
    ) -> Result<Suffix, HandlerOutcome> {
        let store = self
            .store
            .get()
            .ok_or_else(|| transient("store unavailable"))?;
        let first = record.message_count;
        let applied: Option<view::CompactionView> = old
            .applied
            .map(|version| {
                store
                    .load_async_compaction_view(&old.reference(), version)
                    .map_err(transient)
            })
            .transpose()?
            .flatten()
            .map(|raw| serde_json::from_str(&raw).map_err(transient))
            .transpose()?;
        let last = applied
            .as_ref()
            .map(|view| view.covers_through.ordinal)
            .filter(|last| *last >= first);
        let mut held = BTreeMap::new();
        if let Some(last) = last {
            for (ordinal, raw) in store
                .load_async_compaction_entries_range(&old.reference(), first, last)
                .map_err(transient)?
            {
                held.insert(ordinal, Arc::new(HeldEntry::from_stored(raw)?));
            }
        }
        let by_mid = held
            .iter()
            .map(|(ordinal, entry)| (entry.mid.clone(), *ordinal))
            .collect::<BTreeMap<_, _>>();
        let codec = codec::Codec::from_params(&Value::Object(request.params.clone()))?;
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut from = first;
        let mut entries = Vec::new();
        loop {
            let budget = deadline.saturating_duration_since(Instant::now());
            if budget.is_zero() {
                return Err(transient("Setup suffix read timed out"));
            }
            let page = self.provider_runner.call_for_identity(
                &old.runner()?, &old.runner_identity(), "session.read",
                json!({"lineage_id":request.lineage_id,"from_ordinal":from,"limit":256,"max_bytes":1_048_576,"media":"descriptors"}), budget,
            ).await.map_err(runner_error)?;
            if page["lineage_id"].as_str() != request.lineage_id.as_deref()
                || request.lineage_id.is_none()
            {
                return Err(transient("Setup suffix lineage changed"));
            }
            let rows: Vec<ReadMessage> = decode(&page["messages"])?;
            let mut next_min = from;
            for entry in rows {
                if entry.ordinal < next_min {
                    return Err(transient("Setup suffix returned an out-of-window row"));
                }
                next_min = entry
                    .ordinal
                    .checked_add(1)
                    .ok_or_else(|| invalid("ordinal exhausted"))?;
                check_served_identity(&entry, codec)?;
                entries.push(entry);
            }
            match page["next_from_ordinal"].as_u64() {
                Some(next) if next >= next_min && next > from => from = next,
                Some(_) => return Err(transient("Setup suffix paging did not advance")),
                None => break,
            }
        }

        let mut rendered = Vec::new();
        let mut to = first;
        let mut unchanged = std::collections::HashSet::new();
        let mut current_edits = frozen_edits::FrozenEdits::default();
        for entry in entries
            .iter()
            .filter(|entry| last.is_some_and(|last| entry.ordinal <= last))
        {
            to = entry
                .ordinal
                .checked_add(1)
                .ok_or_else(|| invalid("ordinal exhausted"))?;
            let prior = by_mid
                .get(&entry.mid)
                .and_then(|ordinal| held.get(ordinal))
                .map(|entry| entry.read())
                .transpose()?;
            if let (Some(prior), Some(applied)) = (prior.as_ref(), applied.as_ref()) {
                if served_digest(prior)? == served_digest(entry)? {
                    unchanged.insert(entry.mid.clone());
                    rendered.extend(cut_runtime::render_retained_rows(
                        &held,
                        applied,
                        prior.ordinal,
                        prior.ordinal,
                    )?);
                    continue;
                }
            }
            // A changed message may still contain unchanged dropped parts.
            // Match each part's source identity before carrying an edit; the
            // changed part itself uses its current raw bytes and tags.
            let mut raw = applied
                .clone()
                .ok_or_else(|| transient("applied suffix view missing"))?;
            raw.ranges.clear();
            let current = BTreeMap::from([(entry.ordinal, Arc::new(HeldEntry::from_read(entry)?))]);
            let current_rows =
                cut_runtime::render_retained_rows(&current, &raw, entry.ordinal, entry.ordinal)?;
            let edits = entry
                .tags
                .iter()
                .zip(parts(&current_rows[0])?.iter())
                .map(|(tag, part)| {
                    if let Some(prior) = &prior {
                        if served_part_digest(prior, &tag.part).ok().as_ref()
                            == Some(&served_part_digest(entry, &tag.part)?)
                        {
                            if let Some(edit) = applied
                                .as_ref()
                                .into_iter()
                                .flat_map(|view| &view.ranges)
                                .filter_map(|range| match range {
                                    view::ViewRange::Keep { edits, .. } => Some(edits),
                                    _ => None,
                                })
                                .flatten()
                                .find(|edit| {
                                    edit.ordinal == prior.ordinal
                                        && edit.mid == entry.mid
                                        && edit.part == tag.part
                                })
                            {
                                let mut edit = edit.clone();
                                edit.ordinal = entry.ordinal;
                                return Ok(edit);
                            }
                        }
                    }
                    Ok(view::PartEdit::replace(
                        entry.ordinal,
                        &entry.mid,
                        &tag.part,
                        serde_json::to_string(part).map_err(transient)?,
                    ))
                })
                .collect::<Result<Vec<_>, HandlerOutcome>>()?;
            raw.ranges = vec![view::ViewRange::Keep {
                from: entry.ordinal,
                to,
                edits,
            }];
            // Freeze the installed rendering, including current raw parts, so
            // the fresh engine cannot rewrite it during its first notice.
            current_edits.capture(&raw, &current)?;
            rendered.extend(cut_runtime::render_retained_rows(
                &current,
                &raw,
                entry.ordinal,
                entry.ordinal,
            )?);
        }
        let mut frozen = store
            .load_async_compaction_baseline(&old.reference(), "frozen_edits")
            .map_err(transient)?
            .map(|raw| frozen_edits::FrozenEdits::from_json(&raw))
            .transpose()?
            .unwrap_or_default();
        if let Some(applied) = &applied {
            frozen.capture(applied, &held)?;
        }
        frozen = frozen.only_mids(&unchanged);
        frozen.merge(&current_edits);
        frozen.dirty = true;
        Ok(Suffix {
            entries,
            rendered,
            to,
            frozen,
        })
    }
}

impl AsyncRecord {
    pub(super) fn install_adoption_suffix(
        &mut self,
        store: &McStore,
        suffix: Suffix,
    ) -> Result<(), HandlerOutcome> {
        let first = self.lineage_first_ordinal;
        for entry in suffix.entries {
            self.entries
                .insert(entry.ordinal, Arc::new(HeldEntry::from_read(&entry)?));
        }
        self.reindex()?;
        self.frozen_edits.merge(&suffix.frozen);
        let codec = codec::Codec::from_params(&Value::Object(self.setup.params.clone()))?;
        self.bind_standalone_move(store, codec)?;
        let replacement = self.initial["initial"]["replacement"]
            .as_array_mut()
            .ok_or_else(|| transient("adoption Setup omitted its history head"))?;
        replacement.extend(suffix.rendered);
        self.initial["initial"]["range"] = json!({"from":first,"to":suffix.to});
        self.initial_stored = false;
        Ok(())
    }
}
