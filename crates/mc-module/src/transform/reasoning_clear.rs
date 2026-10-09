const LEGACY_REASONING_CLEAR_PREFIX: &str = "strip:reasoning_clear_legacy:";

struct ReasoningClearSnapshot<'a> {
    meta: &'a ModuleMeta,
    row_version: Option<u64>,
    projection: &'a FlatProjection,
}

fn reasoning_generation(meta: &ModuleMeta) -> (u64, u64, u64) {
    (meta.revert_epoch, meta.shadow_generation, meta.shadow_seq)
}

pub(crate) fn reasoning_native_source_hash(req: &TransformRequest) -> String {
    ck_wire::fingerprint(
        &serde_json::to_string(&(&req.messages, &req.native_messages, &req.render_config))
            .expect("native source is serializable"),
    )
}

fn legacy_ck_clear_matches(
    snapshot: &ReasoningClearSnapshot<'_>,
    lookup: &FrozenUnitLookup<'_>,
    previous: &HashMap<&str, &str>,
    message: &CkIngressMessage,
) -> bool {
    message.ck.content.iter().any(is_reasoning_block)
        && snapshot
            .meta
            .block_identity_by_mid
            .get(&message.mid)
            .is_some_and(|identity| {
                Some(identity) == snapshot.projection.identity_by_mid.get(&message.mid)
            })
        && output_message_strip_unit(lookup, "native_reasoning_keep", &message.mid).is_none()
        && message
            .ck
            .content
            .iter()
            .enumerate()
            .filter(|(_, block)| is_reasoning_block(block))
            .all(|(index, block)| {
                let mut cleared = block.clone();
                cleared.kind = ck_wire::CkKind::Reasoning {
                    text: String::new(),
                    signature: None,
                };
                cleared.mark_modified();
                let candidate = ServedMessage::from_message(CkWireMessage::from_parts(
                    "assistant",
                    vec![cleared],
                    None,
                    ck_wire::ProviderExtras::new(),
                    ck_wire::HarnessMeta::default(),
                ));
                previous
                    .get(ck_wire::block_id(&message.mid, index).as_str())
                    .copied()
                    == Some(candidate.block_fingerprints[0].0.as_str())
            })
}

/// The numeric age cutoff selects candidates, not first-application permission.
/// Legacy replay is bounded by the last served CK representation and retires on
/// the first priced pass. Adopting a durable unit additionally requires native proof.
fn new_reasoning_clear_units(
    core: &CoreState,
    meta: &ModuleMeta,
    req: &TransformRequest,
    tag_numbers: &BTreeMap<String, u64>,
    can_mutate_provider_prefix: bool,
    lineage_anchor_mid: Option<&str>,
    snapshot: ReasoningClearSnapshot<'_>,
) -> Vec<FrozenUnit> {
    if SerializerProfile::parse(&req.serializer_profile) != Some(SerializerProfile::OpencodeAiSdk)
        || !req.serve_native
        || !request_accepts_empty_content(req)
    {
        return Vec::new();
    }
    let cutoff = meta
        .reasoning_cleared_through_tag
        .max(meta.reasoning_cleared_through_ordinal);
    if cutoff == 0 {
        return Vec::new();
    }
    let newest = latest_assistant_reasoning_mutation_exempt_mid(&req.messages);
    let lookup = FrozenUnitLookup::Indexed(FrozenUnitIndex::new(&core.frozen_units));
    let generation = reasoning_generation(snapshot.meta);
    let legacy_allowed = !snapshot.meta.reasoning_clear_initialized;
    let current_generation = snapshot
        .meta
        .served_output_generation
        .map_or(generation == (0, 0, 0), |served| served == generation);
    // Native evidence retains the fingerprint set that observed the legacy clears. A
    // transient subset may replace the current served set without invalidating those clears.
    let previous = if legacy_allowed {
        snapshot
            .meta
            .reasoning_replay_evidence
            .as_ref()
            .filter(|proof| proof.generation == generation)
            .map(|proof| &proof.ck_fingerprints)
            .unwrap_or(&snapshot.meta.served_output_fingerprint)
            .iter()
            .map(|block| (block.block_id.as_str(), block.content_hash.as_str()))
            .collect::<HashMap<_, _>>()
    } else {
        HashMap::new()
    };
    let source_hash = legacy_allowed.then(|| reasoning_native_source_hash(req));
    let native_proof = snapshot
        .meta
        .reasoning_replay_evidence
        .as_ref()
        .filter(|proof| {
            current_generation
                && Some(proof.row_version) == snapshot.row_version
                && proof.generation == generation
                && Some(&proof.source_hash) == source_hash.as_ref()
                && proof.ck_fingerprints == snapshot.meta.served_output_fingerprint
        });
    let mut units = Vec::new();
    let protected_thinking = protected_thinking_turn_mids(req);
    for message in &req.messages {
        let tag = message_tag_number(message, tag_numbers);
        // Legacy served evidence is replay, not new selection. Becoming newest
        // or an anchor cannot restore thinking already absent from that wire.
        let already_served_clear =
            legacy_allowed && legacy_ck_clear_matches(&snapshot, &lookup, &previous, message);
        if message.ck.meta.synthetic
            || message.ck.role != "assistant"
            || message.mid.is_empty()
            || (!already_served_clear
                && (newest == Some(message.mid.as_str())
                    || in_active_anthropic_turn(req, &message.mid)
                    || lineage_anchor_mid == Some(message.mid.as_str())))
            || tag == 0
            || tag > cutoff
            || output_message_strip_unit(&lookup, "reasoning_clear", &message.mid).is_some()
            || !message.ck.content.iter().any(is_reasoning_block)
        {
            continue;
        }
        if protected_thinking.contains(message.mid.as_str()) && !legacy_ck_clear_matches(&snapshot, &lookup, &previous, message) {
            continue;
        }
        if can_mutate_provider_prefix {
            units.push(strip_unit("reasoning_clear", &message.mid, ""));
            continue;
        }
        // Compare the pre-hydration snapshot, not identities re-adopted earlier in
        // this transform. A fingerprint from another source generation is not proof.
        if already_served_clear {
            let native_matches = native_proof.is_some_and(|proof| {
                proof
                    .native
                    .get(&message.mid)
                    .is_some_and(|bytes| Some(bytes) == proof.unit_native.get(&message.mid))
            });
            // An ephemeral legacy replay is NOT a durable clear decision. It keeps
            // the pre-deploy representation until native attachment records proof.
            units.push(strip_unit(
                if native_matches {
                    "reasoning_clear"
                } else {
                    "reasoning_clear_legacy"
                },
                &message.mid,
                "",
            ));
        }
    }
    units
}

fn active_reasoning_clear<'a>(
    frozen_units: &FrozenUnitLookup<'a>,
    mid: &str,
) -> Option<&'a FrozenUnit> {
    output_message_strip_unit(frozen_units, "reasoning_clear", mid)
        .or_else(|| output_message_strip_unit(frozen_units, "reasoning_clear_legacy", mid))
}

fn replay_reasoning_clear(
    frozen_units: &FrozenUnitLookup<'_>,
    mid: &str,
    rebuilt: &mut CkWireMessage,
) {
    let Some(unit) = active_reasoning_clear(frozen_units, mid) else {
        return;
    };
    for block in &mut rebuilt.content {
        if is_reasoning_block(block) {
            block.kind = ck_wire::CkKind::Reasoning {
                text: unit.frozen_payload.clone(),
                signature: None,
            };
            block.mark_modified();
        }
    }
    rebuilt.mark_modified();
}

pub(crate) fn reasoning_clear_mids(units: &[FrozenUnit]) -> HashSet<&str> {
    units
        .iter()
        .filter_map(|unit| unit.key.strip_prefix("strip:reasoning_clear:"))
        .collect()
}

pub(crate) fn reasoning_native_clear_mids(units: &[FrozenUnit]) -> HashSet<&str> {
    units
        .iter()
        .filter_map(|unit| {
            unit.key
                .strip_prefix("strip:reasoning_clear:")
                .or_else(|| unit.key.strip_prefix(LEGACY_REASONING_CLEAR_PREFIX))
        })
        .collect()
}

/// Retire legacy replay only after every mid in its retained native evidence has a durable clear.
fn legacy_reasoning_adoption_complete(meta: &ModuleMeta, units: &[FrozenUnit]) -> bool {
    let durable = reasoning_clear_mids(units);
    if durable.is_empty()
        || units
            .iter()
            .any(|unit| unit.key.starts_with(LEGACY_REASONING_CLEAR_PREFIX))
    {
        return false;
    }
    let Some(proof) = meta
        .reasoning_replay_evidence
        .as_ref()
        .filter(|proof| proof.generation == reasoning_generation(meta))
    else {
        return false;
    };
    let known_mids = proof.native.keys().chain(proof.unit_native.keys());
    let mut any_known = false;
    for mid in known_mids {
        any_known = true;
        if !durable.contains(mid.as_str()) {
            return false;
        }
    }
    any_known
}
