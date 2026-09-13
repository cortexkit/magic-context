struct ReasoningNativeHarness {
    cache: Mutex<crate::NativeAttachmentCache>,
    native: Vec<Arc<Value>>,
    source: Vec<Arc<Value>>,
    after: Option<String>,
    pass: usize,
    deltas: usize,
}

impl ReasoningNativeHarness {
    fn new() -> Self {
        Self {
            cache: Mutex::new(crate::NativeAttachmentCache::new(16 * 1024 * 1024)),
            native: Vec::new(),
            source: Vec::new(),
            after: None,
            pass: 0,
            deltas: 0,
        }
    }
    fn attach(
        &mut self,
        db: &McStore,
        result: &mut TransformWithProjection,
        request: &TransformRequest,
    ) -> Vec<u8> {
        self.pass += 1;
        let mut request = request.clone();
        request.full_array_fingerprint = Some(format!("native-pass-{}", self.pass));
        let source = request.native_messages.as_deref().unwrap_or(&[]);
        let shared = self
            .source
            .iter()
            .zip(source)
            .take_while(|(old, new)| old.as_ref() == *new)
            .count();
        let frontier = self.after.as_ref().map(|after| crate::NativeDeltaFrontier {
            after: after.clone(),
            native_replace_from: shared,
            native_prefix: self.source[..shared].to_vec(),
            native_prefix_retained_bytes: self.source[..shared]
                .iter()
                .map(|value| crate::native_value_retained_bytes(value))
                .collect(),
            projection_cache: None,
        });
        let stats = crate::attach_native_messages_incremental(
            &mut result.response,
            &request,
            &result.reasoning_clear_units,
            &result.tag_numbers,
            result.mutation_exempt_mid.as_deref(),
            result.lineage_anchor_mid.as_deref(),
            result.transition_consumed,
            frontier.as_ref(),
            result.revert_epoch,
            &self.cache,
            crate::NativeCacheKeyMode::Normal,
        );
        crate::record_reasoning_native_evidence(
            db,
            &mut result.response,
            &request,
            &result.reasoning_clear_units,
            &result.tag_numbers,
            result.mutation_exempt_mid.as_deref(),
            result.lineage_anchor_mid.as_deref(),
            result.transition_consumed,
        )
        .unwrap();
        crate::finalize_native_messages_response(
            &mut result.response,
            &request,
            &result.reasoning_clear_units,
            &result.tag_numbers,
            result.mutation_exempt_mid.as_deref(),
            result.lineage_anchor_mid.as_deref(),
            result.transition_consumed,
            frontier.as_ref(),
            stats,
        );
        if let Some(delta) = &result.response.native_messages_delta {
            assert_eq!(Some(delta.after.as_str()), self.after.as_deref());
            assert!(delta.replace_from <= self.native.len());
            self.native.truncate(delta.replace_from);
            self.native.extend(delta.messages.iter().cloned());
            self.deltas += 1;
        } else {
            self.native = result.response.native_messages.clone().unwrap();
        }
        self.source = source.iter().cloned().map(Arc::new).collect();
        self.after = request.full_array_fingerprint;
        serde_json::to_vec(&self.native).unwrap()
    }
}

fn load_pre_fix_reasoning_fixture(dir: &std::path::Path) -> (McStore, TransformRequest, Value) {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../gen/reasoning-clear-legacy/pre-fix.json"
    ))
    .unwrap();
    assert_eq!(
        fixture["generating_commit"],
        "e2109bdc1d1f6fc0dd61c0b995083c12d700fe04"
    );
    std::fs::write(
        dir.join("store.db"),
        include_bytes!("../../gen/reasoning-clear-legacy/pre-fix.sqlite"),
    )
    .unwrap();
    let mut request: TransformRequest = serde_json::from_value(fixture["request"].clone()).unwrap();
    // Decode the recorded raw ingress as production does; CK's private origin
    // stamps are not serialized into the fixture request envelope.
    request.messages =
        crate::codec::decode_opencode(request.native_messages.as_ref().unwrap()).messages;
    let db = store(dir);
    // The captured database predates the tool-result codec epoch. Advance only that
    // identity component so these fixtures continue to isolate reasoning replay behavior.
    let mut loaded = db.load(&request.session_id).unwrap();
    let profile_epoch = crate::profile_render_epoch(SerializerProfile::OpencodeAiSdk);
    let profile_component = format!("mpe{profile_epoch}");
    let tagger_delimiter = ";tfe:";
    assert!(!loaded.meta.last_render_config.contains(";mpe:"));
    assert!(loaded.meta.last_render_config.contains(tagger_delimiter));
    loaded.meta.last_render_config = loaded.meta.last_render_config.replacen(
        tagger_delimiter,
        &format!(
            ";mpe:{}:{profile_component}{tagger_delimiter}",
            profile_component.len()
        ),
        1,
    );
    db.commit(
        &request.session_id,
        loaded.row_version,
        &loaded.core,
        &loaded.meta,
    )
    .unwrap();
    (db, request, fixture)
}

fn append_native_reasoning(request: &mut TransformRequest, id: &str) {
    request.native_messages.as_mut().unwrap().push(json!({"info":{"id":id,"role":"assistant"},"parts":[
        {"id":format!("{id}-r"),"type":"reasoning","text":format!("thinking-{id}"),"metadata":{"signature":format!("signature-{id}")}},
        {"id":format!("{id}-t"),"type":"text","text":format!("answer-{id}")}]}));
    request.messages =
        crate::codec::decode_opencode(request.native_messages.as_ref().unwrap()).messages;
}

#[test]
fn reasoning_clear_pre_fix_database_migrates_ck_and_incremental_wire_without_bust() {
    let dir = tempfile::tempdir().unwrap();
    let (db, mut request, fixture) = load_pre_fix_reasoning_fixture(dir.path());
    let mut ctx = pctx("git:fixture", "/nonexistent-docs", 0);
    ctx.temporal_awareness = false;
    let loaded = db.load(&request.session_id).unwrap();
    assert!(loaded.meta.reasoning_replay_evidence.is_none());
    assert!(!loaded
        .core
        .frozen_units
        .iter()
        .any(|unit| unit.key.starts_with("strip:reasoning_clear:")));
    let mut native = ReasoningNativeHarness::new();
    let mut first = transform_with_projection(&db, &request, &ctx).unwrap();
    assert_eq!(first.response.action, "SOFT+");
    assert_eq!(
        serde_json::to_vec(first.response.messages()).unwrap(),
        include_bytes!("../../gen/reasoning-clear-legacy/pre-fix.ck.json").as_slice()
    );
    assert!(
        reasoning_clear_mids(&first.reasoning_clear_units).is_empty(),
        "CK-only evidence must not adopt a unit"
    );
    let wire = native.attach(&db, &mut first, &request);
    assert_eq!(
        wire,
        include_bytes!("../../gen/reasoning-clear-legacy/pre-fix.native.json").as_slice()
    );
    assert!(db
        .load(&request.session_id)
        .unwrap()
        .meta
        .reasoning_replay_evidence
        .is_some());
    let mut adopted = transform_with_projection(&db, &request, &ctx).unwrap();
    assert_eq!(adopted.response.action, "SOFT+");
    assert_eq!(
        reasoning_clear_mids(&adopted.reasoning_clear_units),
        HashSet::from(["already"])
    );
    assert_eq!(native.attach(&db, &mut adopted, &request), wire);
    append_native_reasoning(&mut request, "new");
    let mut held = transform_with_projection(&db, &request, &ctx).unwrap();
    assert_eq!(held.response.action, "SOFT+");
    assert!(!reasoning_clear_mids(&held.reasoning_clear_units).contains("old"));
    assert!(held.response.first_divergence.is_none());
    native.attach(&db, &mut held, &request);
    assert_eq!(
        serde_json::to_vec(&native.native[..fixture["native"].as_array().unwrap().len()]).unwrap(),
        wire
    );
    request.render_config = "cfg2".to_string();
    let mut priced = transform_with_projection(&db, &request, &ctx).unwrap();
    assert_eq!(priced.response.action, "HARD");
    assert!(reasoning_clear_mids(&priced.reasoning_clear_units).contains("old"));
    let priced_wire = native.attach(&db, &mut priced, &request);
    for _ in 0..3 {
        let mut deferred = transform_with_projection(&db, &request, &ctx).unwrap();
        assert_eq!(deferred.response.action, "SOFT+");
        assert!(!deferred
            .reasoning_clear_units
            .iter()
            .any(|unit| unit.key.starts_with(LEGACY_REASONING_CLEAR_PREFIX)));
        assert_eq!(native.attach(&db, &mut deferred, &request), priced_wire);
    }
    assert!(
        native.deltas >= 3,
        "the wire assertions must exercise reconstructed deltas"
    );
    let retired = db.load(&request.session_id).unwrap();
    assert!(retired.meta.reasoning_clear_initialized);
    assert!(retired.meta.reasoning_replay_evidence.is_none());
}

#[test]
fn reasoning_clear_rejects_previous_generation_and_hydration_evidence() {
    let dir = tempfile::tempdir().unwrap();
    let (db, request, _) = load_pre_fix_reasoning_fixture(dir.path());
    let mut ctx = pctx("git:fixture", "/nonexistent-docs", 0);
    ctx.temporal_awareness = false;
    let mut native = ReasoningNativeHarness::new();
    let mut first = transform_with_projection(&db, &request, &ctx).unwrap();
    native.attach(&db, &mut first, &request);
    let loaded = db.load(&request.session_id).unwrap();
    let projection = ck_wire::project_messages(&request.messages).unwrap();
    for arm in 0..5 {
        let mut stale = loaded.meta.clone();
        match arm {
            0 => stale.revert_epoch += 1,
            1 => stale.shadow_generation += 1,
            2 => stale.shadow_seq += 1,
            3 => {
                stale
                    .reasoning_replay_evidence
                    .as_mut()
                    .unwrap()
                    .row_version -= 1
            }
            _ => {
                stale
                    .reasoning_replay_evidence
                    .as_mut()
                    .unwrap()
                    .unit_native
                    .insert(
                        "already".to_string(),
                        json!({"parts":[{"type":"text","text":""}]}),
                    );
            }
        }
        let units = new_reasoning_clear_units(
            &loaded.core,
            &stale,
            &request,
            &first.tag_numbers,
            false,
            None,
            ReasoningClearSnapshot {
                meta: &stale,
                row_version: loaded.row_version,
                projection: &projection,
            },
        );
        assert!(
            reasoning_clear_mids(&units).is_empty(),
            "stale evidence arm {arm} adopted a clear"
        );
    }
    let mut changed = request.clone();
    changed.messages[1].ck.content[0].kind = ck_wire::CkKind::Reasoning {
        text: "new source generation".to_string(),
        signature: Some("different signature".to_string()),
    };
    let changed_projection = ck_wire::project_messages(&changed.messages).unwrap();
    let units = new_reasoning_clear_units(
        &loaded.core,
        &loaded.meta,
        &changed,
        &first.tag_numbers,
        false,
        None,
        ReasoningClearSnapshot {
            meta: &loaded.meta,
            row_version: loaded.row_version,
            projection: &changed_projection,
        },
    );
    assert!(
        !units.iter().any(|unit| unit.key.ends_with(":already")),
        "rehydrated source cannot borrow an old cleared fingerprint"
    );
    let mut retired = loaded.meta.clone();
    retired.reasoning_clear_initialized = true;
    let units = new_reasoning_clear_units(
        &loaded.core,
        &retired,
        &request,
        &first.tag_numbers,
        false,
        None,
        ReasoningClearSnapshot {
            meta: &retired,
            row_version: loaded.row_version,
            projection: &projection,
        },
    );
    assert!(
        units.is_empty(),
        "a retired legacy arm must remain unreachable even with matching evidence"
    );
}

fn native_mid_bytes(native: &ReasoningNativeHarness, mid: &str) -> Vec<u8> {
    serde_json::to_vec(
        native
            .native
            .iter()
            .find(|message| message["info"]["id"] == mid)
            .unwrap()
            .as_ref(),
    )
    .unwrap()
}

#[test]
fn reasoning_clear_reexemption_and_native_keep_collision_change_only_on_priced_passes() {
    let dir = tempfile::tempdir().unwrap();
    let (db, mut request, _) = load_pre_fix_reasoning_fixture(dir.path());
    let mut ctx = pctx("git:fixture", "/nonexistent-docs", 0);
    ctx.temporal_awareness = false;
    append_native_reasoning(&mut request, "new");
    request.render_config = "priced-clear".to_string();
    let mut native = ReasoningNativeHarness::new();
    let mut clear = transform_with_projection(&db, &request, &ctx).unwrap();
    assert_eq!(clear.response.action, "HARD");
    native.attach(&db, &mut clear, &request);
    let clear_bytes = native_mid_bytes(&native, "old");
    assert!(!String::from_utf8_lossy(&clear_bytes).contains("thinking-old"));
    let mut collision = db.load(&request.session_id).unwrap();
    collision
        .core
        .frozen_units
        .push(strip_unit("native_reasoning_keep", "old", ""));
    db.commit(
        &request.session_id,
        collision.row_version,
        &collision.core,
        &collision.meta,
    )
    .unwrap();
    for _ in 0..3 {
        let mut deferred = transform_with_projection(&db, &request, &ctx).unwrap();
        assert_eq!(deferred.response.action, "SOFT+");
        native.attach(&db, &mut deferred, &request);
        assert_eq!(
            native_mid_bytes(&native, "old"),
            clear_bytes,
            "keep/clear collision oscillated on defer"
        );
    }
    let with_new = request.native_messages.clone().unwrap();
    request.native_messages.as_mut().unwrap().pop();
    request.messages =
        crate::codec::decode_opencode(request.native_messages.as_ref().unwrap()).messages;
    let mut reexempt = transform_with_projection(&db, &request, &ctx).unwrap();
    assert_eq!(reexempt.response.action, "HARD");
    assert_eq!(
        reexempt.response.materialize_reason.as_deref(),
        Some("reasoning_exemption_repair")
    );
    native.attach(&db, &mut reexempt, &request);
    let kept_bytes = native_mid_bytes(&native, "old");
    assert!(String::from_utf8_lossy(&kept_bytes).contains("thinking-old"));
    for arm in 0..3 {
        if arm == 1 {
            request.native_messages = Some(with_new.clone());
            request.messages =
                crate::codec::decode_opencode(request.native_messages.as_ref().unwrap()).messages;
        }
        let mut deferred = transform_with_projection(&db, &request, &ctx).unwrap();
        assert_eq!(deferred.response.action, "SOFT+");
        native.attach(&db, &mut deferred, &request);
        assert_eq!(
            native_mid_bytes(&native, "old"),
            kept_bytes,
            "a suspended clear resumed without permission"
        );
    }
    request.render_config = "priced-resume".to_string();
    let mut resumed = transform_with_projection(&db, &request, &ctx).unwrap();
    native.attach(&db, &mut resumed, &request);
    assert_eq!(native_mid_bytes(&native, "old"), clear_bytes);
}

#[test]
fn reasoning_clear_lineage_anchor_suspension_requires_permission() {
    let mut request = reasoning_clear_fixture();
    let mut newer = request.messages[1].clone();
    newer.mid = "new".to_string();
    newer.ordinal = 17;
    newer.ck.meta.harness_id = Some("new".to_string());
    request.messages.push(newer);
    let mut core = CoreState::default();
    core.frozen_units
        .push(strip_unit("reasoning_clear", "old", ""));
    assert!(!reasoning_clear_exemption_changed(&core, &request, None));
    assert!(reasoning_clear_exemption_changed(
        &core,
        &request,
        Some("old")
    ));
    refresh_reasoning_clear_exemptions(&mut core, &request, false, Some("old"));
    assert_eq!(core.frozen_units[0].reset_rule, "");
    refresh_reasoning_clear_exemptions(&mut core, &request, true, Some("old"));
    assert_eq!(core.frozen_units[0].reset_rule, REASONING_CLEAR_SUSPENDED);
    assert!(!reasoning_clear_exemption_changed(
        &core,
        &request,
        Some("old")
    ));
}

#[test]
fn reasoning_clear_merged_assistant_whitespace_sentinels_replay_one_wire_shape() {
    let dir = tempfile::tempdir().unwrap();
    let (db, mut request, _) = load_pre_fix_reasoning_fixture(dir.path());
    let raw = request.native_messages.as_mut().unwrap();
    raw.retain(|message| message["info"]["id"] != "gap");
    let old = raw
        .iter_mut()
        .find(|message| message["info"]["id"] == "old")
        .unwrap();
    old["parts"]
        .as_array_mut()
        .unwrap()
        .insert(0, json!({"id":"old-blank","type":"text","text":"   "}));
    // The changed source belongs to a new session; no old source-identity pin is reused.
    request.session_id = "combined-reasoning".to_string();
    request.messages =
        crate::codec::decode_opencode(request.native_messages.as_ref().unwrap()).messages;
    let mut ctx = pctx("git:fixture", "/nonexistent-docs", 0);
    ctx.temporal_awareness = false;
    transform_with_projection(&db, &request, &ctx).unwrap();
    append_native_reasoning(&mut request, "new");
    request.render_config = "combined-hard".to_string();
    let mut native = ReasoningNativeHarness::new();
    let mut applied = transform_with_projection(&db, &request, &ctx).unwrap();
    assert_eq!(applied.response.action, "HARD");
    native.attach(&db, &mut applied, &request);
    let old_bytes = native_mid_bytes(&native, "old");
    assert!(!String::from_utf8_lossy(&old_bytes).contains("thinking-old"));
    let state = db.load(&request.session_id).unwrap();
    assert_eq!(
        state
            .core
            .frozen_units
            .iter()
            .filter(|unit| unit.key == "strip:reasoning_clear:old")
            .count(),
        1
    );
    assert!(
        !state
            .core
            .frozen_units
            .iter()
            .any(|unit| unit.key == "strip:merged_reasoning:old"),
        "typed clear must own its blocks rather than minting a second strip decision"
    );
    for arm in 0..3 {
        if arm == 2 {
            append_native_reasoning(&mut request, "newer");
        }
        let mut deferred = transform_with_projection(&db, &request, &ctx).unwrap();
        assert_eq!(deferred.response.action, "SOFT+");
        native.attach(&db, &mut deferred, &request);
        assert_eq!(native_mid_bytes(&native, "old"), old_bytes);
        assert!(deferred.response.first_divergence.is_none());
    }
    assert!(native.deltas > 0);
}

#[test]
fn reasoning_clear_native_proof_cannot_overwrite_a_newer_hydration_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let (db, request, _) = load_pre_fix_reasoning_fixture(dir.path());
    let mut ctx = pctx("git:fixture", "/nonexistent-docs", 0);
    ctx.temporal_awareness = false;
    let mut first = transform_with_projection(&db, &request, &ctx).unwrap();
    let mut hydrated = db.load(&request.session_id).unwrap();
    hydrated.meta.shadow_seq += 1;
    let newer_version = db
        .commit(
            &request.session_id,
            hydrated.row_version,
            &hydrated.core,
            &hydrated.meta,
        )
        .unwrap();
    ReasoningNativeHarness::new().attach(&db, &mut first, &request);
    let after = db.load(&request.session_id).unwrap();
    assert_eq!(after.row_version, Some(newer_version));
    assert_eq!(after.meta.shadow_seq, hydrated.meta.shadow_seq);
    assert!(
        after.meta.reasoning_replay_evidence.is_none(),
        "late native attachment stamped evidence over a newer hydration"
    );
}

#[test]
fn reasoning_clear_stale_generation_holds_legacy_wire_without_adopting() {
    let dir = tempfile::tempdir().unwrap();
    let (db, request, _) = load_pre_fix_reasoning_fixture(dir.path());
    let mut old = db.load(&request.session_id).unwrap();
    old.meta.shadow_seq += 1;
    db.commit(&request.session_id, old.row_version, &old.core, &old.meta)
        .unwrap();
    let mut ctx = pctx("git:fixture", "/nonexistent-docs", 0);
    ctx.temporal_awareness = false;
    let mut held = transform_with_projection(&db, &request, &ctx).unwrap();
    assert_eq!(held.response.action, "SOFT+");
    assert!(reasoning_clear_mids(&held.reasoning_clear_units).is_empty());
    assert_eq!(
        serde_json::to_vec(held.response.messages()).unwrap(),
        include_bytes!("../../gen/reasoning-clear-legacy/pre-fix.ck.json").as_slice()
    );
    let wire = ReasoningNativeHarness::new().attach(&db, &mut held, &request);
    assert_eq!(
        wire,
        include_bytes!("../../gen/reasoning-clear-legacy/pre-fix.native.json").as_slice()
    );
}

#[test]
fn reasoning_clear_legacy_reexemption_prices_restoration_before_unit_adoption() {
    let dir = tempfile::tempdir().unwrap();
    let (db, mut request, _) = load_pre_fix_reasoning_fixture(dir.path());
    request.native_messages.as_mut().unwrap().retain(|message| {
        !["old", "multipart-user"]
            .iter()
            .any(|id| message["info"]["id"] == *id)
    });
    request.messages =
        crate::codec::decode_opencode(request.native_messages.as_ref().unwrap()).messages;
    let mut ctx = pctx("git:fixture", "/nonexistent-docs", 0);
    ctx.temporal_awareness = false;
    let mut restored = transform_with_projection(&db, &request, &ctx).unwrap();
    assert_eq!(restored.response.action, "HARD");
    assert_eq!(
        restored.response.materialize_reason.as_deref(),
        Some("reasoning_exemption_repair")
    );
    let mut native = ReasoningNativeHarness::new();
    native.attach(&db, &mut restored, &request);
    let bytes = native_mid_bytes(&native, "already");
    assert!(String::from_utf8_lossy(&bytes).contains("thinking-already"));
    for _ in 0..3 {
        let mut deferred = transform_with_projection(&db, &request, &ctx).unwrap();
        assert_eq!(deferred.response.action, "SOFT+");
        native.attach(&db, &mut deferred, &request);
        assert_eq!(native_mid_bytes(&native, "already"), bytes);
    }
}

#[test]
fn reasoning_clear_subset_ingress_cannot_retire_an_omitted_legacy_clear() {
    let dir = tempfile::tempdir().unwrap();
    let (db, mut request, _) = load_pre_fix_reasoning_fixture(dir.path());
    append_native_reasoning(&mut request, "new");
    let old = request
        .messages
        .iter()
        .find(|message| message.mid == "old")
        .unwrap();
    let (reasoning_index, mut cleared_block) = old
        .ck
        .content
        .iter()
        .enumerate()
        .find(|(_, block)| is_reasoning_block(block))
        .map(|(index, block)| (index, block.clone()))
        .unwrap();
    cleared_block.kind = ck_wire::CkKind::Reasoning {
        text: String::new(),
        signature: None,
    };
    cleared_block.mark_modified();
    let cleared_ck = ServedMessage::from_message(CkWireMessage::from_parts(
        "assistant",
        vec![cleared_block],
        None,
        ck_wire::ProviderExtras::new(),
        ck_wire::HarnessMeta::default(),
    ));

    let mut loaded = db.load(&request.session_id).unwrap();
    let served = loaded
        .meta
        .served_output_fingerprint
        .iter_mut()
        .find(|fingerprint| fingerprint.block_id == ck_wire::block_id("old", reasoning_index))
        .unwrap();
    served.content_hash = cleared_ck.block_fingerprints[0].0.clone();
    served.serialized_len = cleared_ck.block_fingerprints[0].1;
    let tag_numbers = tag_number_by_message(&db.load_tags_for_session(&request.session_id).unwrap());
    let old_tag = tag_numbers["old"];
    loaded.meta.reasoning_cleared_through_tag = old_tag;
    loaded.meta.reasoning_cleared_through_ordinal = old_tag;
    loaded
        .core
        .frozen_units
        .retain(|unit| unit.key != "strip:native_reasoning_keep:old");
    loaded
        .core
        .frozen_units
        .push(strip_unit("reasoning_clear", "unrelated", ""));
    db.commit(
        &request.session_id,
        loaded.row_version,
        &loaded.core,
        &loaded.meta,
    )
    .unwrap();

    let mut ctx = pctx("git:fixture", "/nonexistent-docs", 0);
    ctx.temporal_awareness = false;
    let mut native = ReasoningNativeHarness::new();
    let mut first = transform_with_projection(&db, &request, &ctx).unwrap();
    assert_eq!(first.response.action, "SOFT+");
    assert!(first
        .reasoning_clear_units
        .iter()
        .any(|unit| unit.key == "strip:reasoning_clear_legacy:old"));
    native.attach(&db, &mut first, &request);
    let cleared_bytes = native_mid_bytes(&native, "old");

    let mut subset = request.clone();
    subset.native_messages.as_mut().unwrap().retain(|message| {
        !matches!(message["info"]["id"].as_str(), Some("old" | "already"))
    });
    subset.messages =
        crate::codec::decode_opencode(subset.native_messages.as_ref().unwrap()).messages;
    let mut contracted = transform_with_projection(&db, &subset, &ctx).unwrap();
    assert_eq!(contracted.response.action, "SOFT+");
    native.attach(&db, &mut contracted, &subset);

    let mut expanded = transform_with_projection(&db, &request, &ctx).unwrap();
    assert_eq!(expanded.response.action, "SOFT+");
    assert!(expanded
        .reasoning_clear_units
        .iter()
        .any(|unit| unit.key == "strip:reasoning_clear_legacy:old"));
    native.attach(&db, &mut expanded, &request);
    assert_eq!(native_mid_bytes(&native, "old"), cleared_bytes);
    assert!(!db
        .load(&request.session_id)
        .unwrap()
        .meta
        .reasoning_clear_initialized);
}

#[test]
fn reasoning_clear_legacy_arm_cannot_mint_for_just_demoted_exempt_assistant() {
    let dir = tempfile::tempdir().unwrap();
    let (db, mut request, _) = load_pre_fix_reasoning_fixture(dir.path());
    append_native_reasoning(&mut request, "new");
    let mut ctx = pctx("git:fixture", "/nonexistent-docs", 0);
    ctx.temporal_awareness = false;

    let mut held = transform_with_projection(&db, &request, &ctx).unwrap();
    assert_eq!(held.response.action, "SOFT+");
    assert!(!held
        .reasoning_clear_units
        .iter()
        .any(|unit| unit.key == "strip:reasoning_clear_legacy:old"));
    let mut native = ReasoningNativeHarness::new();
    native.attach(&db, &mut held, &request);
    assert!(String::from_utf8_lossy(&native_mid_bytes(&native, "old"))
        .contains("thinking-old"));
}
