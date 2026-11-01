//! Enforce the daemon frame bound on every live Setup reply, including replay.
use super::*;

pub(super) fn misconfigured(
    request: &compact::setup::SetupRequest,
) -> Result<Vec<u8>, HandlerOutcome> {
    let reply = bytes(&compact::setup::SetupAnswer::refuse(
        &request.request_id,
        compact::errors::RefuseCode::from_code("misconfigured"),
        "The Setup answer exceeds one reply frame; a positive view_due_max_ms and a frame-sized published view are required.",
    ))?;
    if reply.len() > offline_first_pass::SETUP_FRAME_BUDGET {
        return Err(invalid_field(
            "request_id",
            "Setup request id leaves no room for a bounded reply",
        ));
    }
    Ok(reply)
}

pub(super) fn needs_due(answer: &Value) -> Result<bool, HandlerOutcome> {
    struct Size(usize);
    impl std::io::Write for Size {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 += bytes.len();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut size = Size(0);
    serde_json::to_writer(&mut size, answer).map_err(transient)?;
    Ok(size.0 > offline_first_pass::SETUP_FRAME_BUDGET)
}

pub(super) async fn finish(
    handler: &McHandler,
    binding: &SessionBinding,
    params: &Value,
    reply: Vec<u8>,
) -> Result<Vec<u8>, HandlerOutcome> {
    let request: compact::setup::SetupRequest = decode(params)?;
    let answer: Value = serde_json::from_slice(&reply).map_err(transient)?;
    let due_requested = request.view_due_max_ms().is_some_and(|cap| cap > 0);
    let upgrade_cut = due_requested
        && request.descends_from.is_some()
        && answer.get("view_due").is_none()
        && answer["initial"]["range"]["to"]
            .as_u64()
            .zip(answer["initial"]["range"]["from"].as_u64())
            .is_some_and(|(to, from)| to > from);
    if reply.len() <= offline_first_pass::SETUP_FRAME_BUDGET && !upgrade_cut {
        if answer.get("view_due").is_some() && request.view_due_max_ms().is_none_or(|cap| cap == 0)
        {
            return misconfigured(&request);
        }
        return Ok(reply);
    }
    if request.view_due_max_ms().is_none_or(|cap| cap == 0) {
        return misconfigured(&request);
    }
    let store = handler
        .store
        .get()
        .ok_or_else(|| transient("store unavailable"))?;
    let key = Key::new(binding, &request.session, &request.harness)?;
    let _serial = handler.provider_serial.lock_for(&key).await;
    let mut state =
        load(store, &key.reference())?.ok_or_else(|| transient("async session disappeared"))?;
    handler.authorize_async(binding, &state)?;
    if state.lineage != request.lineage_id || state.setup.descends_from != request.descends_from {
        return Err(transient(
            "Setup lineage changed while bounding its reply; retry Setup",
        ));
    }
    let Some((bounded, due)) = publish_due(&mut state, store, &request, answer)? else {
        return misconfigured(&request);
    };
    // The immutable view is saved first. Commit the answer naming it before
    // returning, so retries use exactly the same version and digest.
    state.initial = bounded;
    state.initial_stored = false;
    state.setup.view_due_max_ms = request.view_due_max_ms;
    state.save(store, &[])?;
    handler
        .provider_store
        .async_runtime
        .resident
        .lock()
        .expect("async resident cache")
        .forget(&key.reference());
    tracing::info!(session_ref=%key.reference(), view_version=due.version,
        "async Setup answered with a frame-bounded due view");
    bytes(&state.initial)
}

/// Repair a stored inline answer only when a retained native view reproduces
/// its saved row bytes. New cut Setups publish pointers without building it.
pub(super) fn publish_due(
    state: &mut State,
    store: &McStore,
    request: &compact::setup::SetupRequest,
    answer: Value,
) -> Result<Option<(Value, offline_first_pass::DueView)>, HandlerOutcome> {
    let decoded: compact::setup::SetupAnswer = decode(&answer)?;
    let Some(initial) = decoded.initial() else {
        return Ok(None);
    };
    let (from, to) = (initial.range.from, initial.range.to);
    let count = usize::try_from(to.saturating_sub(from)).map_err(transient)?;
    let Some(head_count) = initial
        .replacement
        .len()
        .checked_sub(count)
        .filter(|_| count > 0)
    else {
        return Ok(None);
    };
    let source_version = state.applied.unwrap_or(initial.version);
    let Some(raw) = store
        .load_async_compaction_view(&state.reference(), source_version)
        .map_err(transient)?
    else {
        return Ok(None);
    };
    let mut source: view::CompactionView = serde_json::from_str(&raw).map_err(transient)?;
    let entries = state
        .entries
        .iter()
        .map(|(ordinal, entry)| (*ordinal, Arc::clone(entry)))
        .collect();
    let expected = &initial.replacement[head_count..];
    if cut_runtime::render_retained_rows(&entries, &source, from, to - 1)? != expected {
        // Older builds saved only the inline answer, not the version whose
        // edits rendered it. The saved bytes, not the latest cut version,
        // determine which retained rendering a replay may use.
        let mut found = None;
        for (_, raw, _, _) in store
            .load_async_compaction_views(&state.reference())
            .map_err(transient)?
            .0
        {
            let candidate: view::CompactionView = serde_json::from_str(&raw).map_err(transient)?;
            if cut_runtime::render_retained_rows(&entries, &candidate, from, to - 1)? == expected {
                found = Some(candidate);
                break;
            }
        }
        let Some(matched) = found else {
            return Ok(None);
        };
        source = matched;
    }
    let head = json!(&initial.replacement[..head_count]);
    let head_only = offline_first_pass::head_only_answer(answer, head);
    publish_cut_due(state, store, request, head_only, to, Some(&source))
}

/// Publish the selected head and retained edits as a child view. Without a
/// usable applied view, keep the cached suffix unedited, matching the inline
/// head-only fallback. No inline copies of those messages are constructed.
pub(super) fn publish_cut_due(
    state: &mut State,
    store: &McStore,
    request: &compact::setup::SetupRequest,
    answer: Value,
    to: u64,
    source: Option<&view::CompactionView>,
) -> Result<Option<(Value, offline_first_pass::DueView)>, HandlerOutcome> {
    let policy: compact::setup::SetupAnswer = decode(&answer)?;
    let from = answer["initial"]["range"]["from"]
        .as_u64()
        .ok_or_else(|| transient("due view origin missing"))?;
    let head = answer["initial"]["replacement"].clone();
    let Some(last) = state.entries.get(&(to - 1)) else {
        return Ok(None);
    };
    let covers = compact::lineage::MessageRef {
        ordinal: to - 1,
        mid: last.mid.clone(),
    };
    let edits = source
        .into_iter()
        .flat_map(|view| view.ranges.iter())
        .filter_map(|range| match range {
            view::ViewRange::Keep { edits, .. } => Some(edits),
            _ => None,
        })
        .flatten()
        .filter(|edit| {
            edit.ordinal >= from && edit.ordinal < to && (edit.drop || edit.bytes.is_some())
        })
        .cloned()
        .collect();
    let version = store
        .reserve_async_compaction_version(
            &state.reference(),
            source
                .map(|view| view.view_version)
                .or(state.applied)
                .unwrap_or_default(),
        )
        .map_err(transient)?;
    let published = view::CompactionView::new(
        state.reference(),
        version,
        request.lineage_id.as_deref().unwrap_or_default(),
        covers,
        vec![
            view::ViewRange::Replace {
                from,
                to: from,
                bytes: head.to_string(),
            },
            view::ViewRange::Keep { from, to, edits },
        ],
    )
    .with_cache_ttl(
        policy
            .cache_ttl()
            .cloned()
            .unwrap_or_else(|| state.cache_ttl()),
    );
    published.check().map_err(|e| transient(e.name()))?;
    let due = offline_first_pass::DueView {
        version,
        digest: published.digest.clone(),
    };
    let bounded = offline_first_pass::due_answer(answer, head, &due);
    if needs_due(&bounded)?
        || needs_due(
            &serde_json::to_value(view::ViewGetAnswer::view(published.clone()))
                .map_err(transient)?,
        )?
    {
        return Ok(None);
    }
    let engine = state.engine_with_baselines()?;
    let candidate = engine
        .last_produced
        .as_ref()
        .or(engine.last_applied.as_ref())
        .ok_or_else(|| transient("due view engine baseline missing"))?;
    let mut frozen = frozen_edits::FrozenEdits::default();
    frozen.capture(&published, &state.entries)?;
    frozen.stamp_version(version);
    let mut encoded = serde_json::to_value(candidate).map_err(transient)?;
    encoded["native_frozen_edits"] = serde_json::to_value(&frozen).map_err(transient)?;
    encoded["history_through"] = json!(from.checked_sub(1));
    encoded["publication_lineage"] = json!(published.lineage_id);
    encoded["publication_version"] = json!(version);
    encoded["engine_cache_snapshot"] = serde_json::to_value(engine_cache::snapshot(
        store,
        state,
        &engine,
        Some(candidate),
    )?)
    .map_err(transient)?;
    let engine_json: Arc<str> = serde_json::to_string(&encoded).map_err(transient)?.into();
    store
        .save_async_compaction_view(
            &state.reference(),
            version,
            &serde_json::to_string(&published).map_err(transient)?,
            &engine_json,
        )
        .map_err(transient)?;
    state.published_engine.insert(
        version,
        EngineView::with_json(candidate, engine_json)
            .with_frozen_edits(frozen)
            .with_publication_lineage(published.lineage_id)
            .with_publication_version(version),
    );
    Ok(Some((bounded, due)))
}
