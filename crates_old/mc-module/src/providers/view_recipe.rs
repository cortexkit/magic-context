//! Lossless rendering recipes address immutable message identities. Unchanged
//! source text is not copied merely to stamp a tag or append a reminder.
use super::codec::Codec;
use super::compaction::EngineView;
use super::*;
use mc_store::{ProviderViewRecipe, ProviderViewSegment, ProviderViewTreatment};

#[cfg(test)]
#[path = "view_recipe_tests.rs"]
mod tests;

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Edit {
    Set {
        path: Vec<String>,
        value: Value,
    },
    Remove {
        path: Vec<String>,
    },
    Affix {
        path: Vec<String>,
        before: String,
        after: String,
    },
}

fn difference(old: &Value, new: &Value, path: &mut Vec<String>, edits: &mut Vec<Edit>) {
    if old == new {
        return;
    }
    match (old, new) {
        (Value::Object(old), Value::Object(new)) => {
            for key in old.keys().filter(|key| !new.contains_key(*key)) {
                let mut path = path.clone();
                path.push(key.clone());
                edits.push(Edit::Remove { path });
            }
            for (key, new) in new {
                path.push(key.clone());
                if let Some(old) = old.get(key) {
                    difference(old, new, path, edits);
                } else {
                    edits.push(Edit::Set {
                        path: path.clone(),
                        value: new.clone(),
                    });
                }
                path.pop();
            }
        }
        (Value::Array(old), Value::Array(new)) if old.len() == new.len() => {
            for (i, (old, new)) in old.iter().zip(new).enumerate() {
                path.push(i.to_string());
                difference(old, new, path, edits);
                path.pop();
            }
        }
        (Value::String(old), Value::String(new))
            if !old.is_empty() && new.contains(old.as_str()) =>
        {
            let at = new.find(old.as_str()).expect("matched source");
            edits.push(Edit::Affix {
                path: path.clone(),
                before: new[..at].into(),
                after: new[at + old.len()..].into(),
            });
        }
        _ => edits.push(Edit::Set {
            path: path.clone(),
            value: new.clone(),
        }),
    }
}

fn at_path<'a>(value: &'a mut Value, path: &[String]) -> Result<&'a mut Value, HandlerOutcome> {
    let mut value = value;
    for key in path {
        value = if let Value::Array(array) = value {
            array.get_mut(key.parse::<usize>().map_err(transient)?)
        } else {
            value.get_mut(key)
        }
        .ok_or_else(|| transient("view treatment source path is missing"))?;
    }
    Ok(value)
}

fn apply(value: &mut Value, edits: &[Edit]) -> Result<(), HandlerOutcome> {
    for edit in edits {
        match edit {
            Edit::Set { path, value: next } => {
                if path.is_empty() {
                    *value = next.clone();
                } else {
                    let (last, parent) = path.split_last().expect("nonempty path");
                    let parent = at_path(value, parent)?;
                    if let Value::Object(object) = parent {
                        object.insert(last.clone(), next.clone());
                    } else {
                        *at_path(parent, std::slice::from_ref(last))? = next.clone();
                    }
                }
            }
            Edit::Remove { path } => {
                let (last, parent) = path
                    .split_last()
                    .ok_or_else(|| transient("view cannot remove message root"))?;
                let parent = at_path(value, parent)?
                    .as_object_mut()
                    .ok_or_else(|| transient("view removal requires object source"))?;
                parent.remove(last);
            }
            Edit::Affix {
                path,
                before,
                after,
            } => {
                let target = at_path(value, path)?;
                let source = target
                    .as_str()
                    .ok_or_else(|| transient("view affix requires text source"))?;
                *target = json!(format!("{before}{source}{after}"));
            }
        }
    }
    Ok(())
}

fn original(
    message: &mc_store::provider_records::ProviderMessage,
) -> Result<(Value, Value), HandlerOutcome> {
    let native: Value = serde_json::from_slice(&message.message_bytes).map_err(transient)?;
    let entry = codec::InboundMessage {
        ordinal: message.ordinal,
        mid: message.mid.clone(),
        message: native.clone(),
    };
    let ck = Codec::OpencodeAiSdk.decode_message(&entry)?;
    Ok((serde_json::to_value(ck.ck).map_err(transient)?, native))
}

pub fn save(
    store: &McStore,
    key: &Key,
    view: &EngineView,
    state: &str,
) -> Result<(), HandlerOutcome> {
    save_with_base(store, key, view, state, None, None)
}

pub trait RecipeBase {
    fn version(&self) -> u64;
    fn lineage(&self) -> &str;
    fn same_slot(&self, position: usize, ck: &ck_wire::CkWireMessage, wire: &Value) -> bool;
    fn same_native(&self, mid: &str, ordinal: u64, ck: &[u8], wire: &Value) -> bool;
}

pub fn save_with_base(
    store: &McStore,
    key: &Key,
    view: &EngineView,
    state: &str,
    previous_view: Option<&dyn RecipeBase>,
    engine_bytes: Option<&[std::borrow::Cow<'_, [u8]>]>,
) -> Result<(), HandlerOutcome> {
    let started = std::time::Instant::now();
    let first = view
        .engine
        .replacement
        .iter()
        .filter(|ck| !ck.meta.synthetic)
        .filter_map(|ck| ck.meta.ordinal)
        .min()
        .unwrap_or(view.engine.range.to);
    let sources: BTreeMap<_, _> = if first < view.engine.range.to {
        store
            .load_provider_message_sources_since(
                &key.store_key(),
                &view.engine.range.lineage_id,
                first,
            )
            .map_err(transient)?
            .into_iter()
            .map(|(lineage, message)| ((message.mid.clone(), message.ordinal), (lineage, message)))
            .collect()
    } else {
        BTreeMap::new()
    };
    let source_ms = started.elapsed().as_secs_f64() * 1000.0;
    let mut metadata = if previous_view.is_some() {
        serde_json::to_value({
            let mut shell = view.clone();
            shell.engine.replacement.clear();
            shell.wire.replacement.clear();
            shell
        })
        .map_err(transient)?
    } else {
        serde_json::to_value(view).map_err(transient)?
    };
    metadata["engine"]["replacement"] = json!([]);
    metadata["wire"]["replacement"] = json!([]);
    let conversation = store
        .load_provider_conversation(&key.store_key())
        .map_err(transient)?;
    let base = conversation
        .as_ref()
        .and_then(|c| c.setup_json.as_ref())
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|s| s.pointer("/produced/version").and_then(Value::as_u64));
    let previous_view = previous_view.filter(|previous| {
        Some(previous.version()) == base
            && previous.lineage() == view.engine.range.lineage_id
            && previous.version() < view.engine.version
    });
    let mut recipe = ProviderViewRecipe {
        version: view.engine.version,
        lineage_id: view.engine.range.lineage_id.clone(),
        range_from: view.engine.range.from,
        range_to: view.engine.range.to,
        base_version: previous_view.map(|previous| previous.version()),
        policy_cut_id: store
            .provider_fold_settings(&key.store_key())
            .map_err(transient)?
            .get("baseline_cut_id")
            .and_then(Value::as_u64),
        metadata,
        segments: Vec::new(),
        synthetic: BTreeMap::new(),
        treatments: Vec::new(),
        serializer_profile: "opencode-aisdk".into(),
        render_key: "provider-open-code-render-v2".into(),
        tokenizer_key: "mc-tokenizer-byte-bpe-v1".into(),
        state: state.into(),
    };
    for (position, (ck, wire)) in view
        .engine
        .replacement
        .iter()
        .zip(&view.wire.replacement)
        .enumerate()
    {
        if ck.meta.synthetic || ck.meta.harness_id.is_none() {
            let slot = format!("synthetic-{position}");
            if !previous_view.is_some_and(|previous| previous.same_slot(position, ck, wire)) {
                recipe
                    .synthetic
                    .insert(slot.clone(), json!({"engine":ck,"wire":wire}));
            }
            recipe
                .segments
                .push(ProviderViewSegment::Synthetic { slot });
            continue;
        }
        let mid = ck.meta.harness_id.as_deref().expect("native identity");
        let ordinal = ck
            .meta
            .ordinal
            .ok_or_else(|| transient("view native ordinal is missing"))?;
        let (lineage, message) = sources
            .get(&(mid.to_string(), ordinal))
            .ok_or_else(|| transient("view source message is missing"))?;
        let encoded = engine_bytes.map(|bytes| bytes[position].as_ref());
        let fallback;
        let encoded = if let Some(encoded) = encoded {
            encoded
        } else {
            fallback = ck.to_canonical_json_vec().map_err(transient)?;
            &fallback
        };
        let unchanged =
            previous_view.is_some_and(|previous| previous.same_native(mid, ordinal, encoded, wire));
        if !unchanged {
            let (old_engine, old_wire) = original(message)?;
            let mut engine_edits = Vec::new();
            let mut wire_edits = Vec::new();
            difference(
                &old_engine,
                &serde_json::to_value(ck).map_err(transient)?,
                &mut Vec::new(),
                &mut engine_edits,
            );
            difference(&old_wire, wire, &mut Vec::new(), &mut wire_edits);
            let edited = !engine_edits.is_empty() || !wire_edits.is_empty();
            if edited || previous_view.is_some() {
                recipe.treatments.push(ProviderViewTreatment {
                    source_lineage_id: lineage.clone(),
                    mid: mid.into(),
                    ordinal,
                    block_index: -1,
                    block_id: format!("{mid}#@message"),
                    patch: edited
                        .then(|| json!({"format":1,"engine":engine_edits,"wire":wire_edits})),
                });
            }
        }
        if let Some(ProviderViewSegment::NativeRange {source_lineage_id,to,last_mid,..})=recipe.segments.last_mut().filter(|segment|matches!(segment,ProviderViewSegment::NativeRange {source_lineage_id,to,..} if source_lineage_id==lineage && *to==ordinal)) {*to=ordinal+1;*last_mid=mid.into();let _=source_lineage_id;} else {
            recipe.segments.push(ProviderViewSegment::NativeRange {source_lineage_id:lineage.clone(),from:ordinal,to:ordinal+1,first_mid:mid.into(),last_mid:mid.into()});
        }
    }
    let diff_ms = started.elapsed().as_secs_f64() * 1000.0 - source_ms;
    // Store only changed synthetic slots and treatments relative to the base view.
    // After 16 ancestors or 8 MiB of inherited recipes, the store merges their
    // entries into one standalone recipe without copying native message bodies.
    if let Some(base) = base.filter(|base| previous_view.is_none() && *base < recipe.version) {
        inherit(store, &key.store_key(), &mut recipe, base)?;
    }
    let catalog_ms = started.elapsed().as_secs_f64() * 1000.0 - source_ms - diff_ms;
    let bytes = store
        .save_provider_view_recipe(&key.store_key(), &recipe)
        .map_err(transient)?;
    tracing::info!(session_id=%key.session,view_version=view.engine.version,stored_view_bytes=bytes,source_ms,diff_ms,catalog_ms,persist_ms=started.elapsed().as_secs_f64()*1000.0-source_ms-diff_ms-catalog_ms,"provider view recipe stored");
    Ok(())
}

/// Store only synthetic slots and treatments that differ from `base`. After 16
/// ancestors or 8 MiB of inherited recipes, the store merges their entries into
/// one standalone recipe without copying native message bodies.
fn inherit(
    store: &McStore,
    key: &mc_store::ProviderSessionKey,
    recipe: &mut ProviderViewRecipe,
    base: u64,
) -> Result<(), HandlerOutcome> {
    let Some(old) = store
        .resolve_provider_view_catalog(key, base)
        .map_err(transient)?
    else {
        return Ok(());
    };
    recipe.base_version = Some(base);
    recipe
        .synthetic
        .retain(|slot, value| old.recipe.synthetic.get(slot) != Some(value));
    let mut previous: BTreeMap<_, _> = old
        .recipe
        .treatments
        .into_iter()
        .map(|t| {
            (
                (t.source_lineage_id.clone(), t.mid.clone(), t.block_index),
                t,
            )
        })
        .collect();
    recipe.treatments.retain(|t| {
        previous
            .remove(&(t.source_lineage_id.clone(), t.mid.clone(), t.block_index))
            .is_none_or(|old| old.patch != t.patch)
    });
    for (_, mut reset) in previous {
        reset.patch = None;
        recipe.treatments.push(reset);
    }
    Ok(())
}

pub fn load(
    store: &McStore,
    key: &Key,
    version: u64,
) -> Result<Option<EngineView>, HandlerOutcome> {
    let started = std::time::Instant::now();
    let Some(resolved) = store
        .resolve_provider_view(&key.store_key(), version)
        .map_err(transient)?
    else {
        return Ok(None);
    };
    let resolve_ms = started.elapsed().as_secs_f64() * 1000.0;
    let lane = RecipeLane::from_profile(&resolved.recipe.serializer_profile)?;
    if lane != RecipeLane::OpencodeAiSdk {
        let (metadata, items) = resolve_items(lane, resolved)?;
        let view = assemble_host(lane, metadata, items)?;
        tracing::info!(session_id=%key.session,view_version=version,resolve_ms,reconstruct_ms=started.elapsed().as_secs_f64()*1000.0-resolve_ms,"provider view recipe loaded");
        return Ok(Some(view));
    }
    let mut metadata = resolved.recipe.metadata;
    let mut engines = Vec::new();
    let mut wires = Vec::new();
    let mut sources: BTreeMap<_, _> = resolved
        .messages
        .into_iter()
        .map(|(lineage, message)| ((lineage, message.ordinal), message))
        .collect();
    let treatments: BTreeMap<_, _> = resolved
        .recipe
        .treatments
        .into_iter()
        .map(|t| ((t.source_lineage_id.clone(), t.mid.clone()), t))
        .collect();
    for segment in resolved.recipe.segments {
        match segment {
            ProviderViewSegment::Synthetic { slot } => {
                let entry = resolved
                    .recipe
                    .synthetic
                    .get(&slot)
                    .ok_or_else(|| transient("view synthetic slot is missing"))?;
                engines.push(entry["engine"].clone());
                wires.push(entry["wire"].clone());
            }
            ProviderViewSegment::NativeRange {
                source_lineage_id,
                from,
                to,
                ..
            } => {
                for ordinal in from..to {
                    let message = sources
                        .remove(&(source_lineage_id.clone(), ordinal))
                        .ok_or_else(|| transient("view source lifetime ended"))?;
                    let (mut engine, mut wire) = original(&message)?;
                    if let Some(treatment) =
                        treatments.get(&(source_lineage_id.clone(), message.mid))
                    {
                        let patch = treatment.patch.as_ref().expect("effective treatment");
                        if patch["format"] != json!(1) {
                            return Err(transient("unknown view treatment format"));
                        }
                        apply(
                            &mut engine,
                            &serde_json::from_value::<Vec<Edit>>(patch["engine"].clone())
                                .map_err(transient)?,
                        )?;
                        apply(
                            &mut wire,
                            &serde_json::from_value::<Vec<Edit>>(patch["wire"].clone())
                                .map_err(transient)?,
                        )?;
                    }
                    engines.push(engine);
                    wires.push(wire);
                }
            }
        }
    }
    metadata["engine"]["replacement"] = json!(engines);
    metadata["wire"]["replacement"] = json!(wires);
    let view = serde_json::from_value(metadata).map_err(transient)?;
    tracing::info!(session_id=%key.session,view_version=version,resolve_ms,reconstruct_ms=started.elapsed().as_secs_f64()*1000.0-resolve_ms,"provider view recipe loaded");
    Ok(Some(view))
}

// ---------------------------------------------------------------------------
// Exact recipes for Claude Code and Broca.
//
// OpenCode's recipes above keep their own treatment format. The lanes below
// decode each native source through its own codec, store a sparse patch that
// turns the decoded source into the view's message, and check at save time
// that applying the patch reproduces that message exactly. A message the patch
// cannot reproduce is stored whole as a synthetic slot, so a recipe always
// resolves to the view that was saved.
// ---------------------------------------------------------------------------

/// The codec that decodes a recipe's native sources and the shape of the view
/// assembled from them. Stored as the recipe's serializer profile.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecipeLane {
    OpencodeAiSdk,
    /// A host-lane Broca view: engine and wire messages.
    OwnedBroca,
    /// A Broca runner record's engine-only view.
    OwnedBrocaRunner,
    /// A Pi host view. Every message is stored whole as a synthetic slot: no
    /// native source is matched or decoded, so the stored bytes are the same
    /// whole copy the retired mc_provider_views_v1 table held.
    Pi,
}

impl RecipeLane {
    /// The recipe lane for a host-lane conversation's codec. An
    /// `anthropic-messages` session exists only on the asynchronous runner
    /// lane, which keeps its views in its own table, so it has no recipe lane.
    fn host(codec: Codec) -> Result<Self, HandlerOutcome> {
        match codec {
            Codec::OpencodeAiSdk => Ok(Self::OpencodeAiSdk),
            Codec::OwnedBroca => Ok(Self::OwnedBroca),
            Codec::Pi => Ok(Self::Pi),
            Codec::AnthropicMessages => Err(transient(
                "anthropic-messages views are not stored as host recipes",
            )),
        }
    }

    fn profile(self) -> &'static str {
        match self {
            Self::OpencodeAiSdk => "opencode-aisdk",
            Self::OwnedBroca => "owned-broca",
            Self::OwnedBrocaRunner => "owned-broca-runner",
            Self::Pi => "pi",
        }
    }

    fn render_key(self) -> &'static str {
        match self {
            Self::OpencodeAiSdk => "provider-open-code-render-v2",
            Self::OwnedBroca => "provider-owned-broca-wire-v1",
            Self::OwnedBrocaRunner => "provider-owned-broca-engine-v1",
            Self::Pi => "provider-pi-whole-v1",
        }
    }

    fn from_profile(profile: &str) -> Result<Self, HandlerOutcome> {
        [
            Self::OpencodeAiSdk,
            Self::OwnedBroca,
            Self::OwnedBrocaRunner,
            Self::Pi,
        ]
        .into_iter()
        .find(|lane| lane.profile() == profile)
        .ok_or_else(|| transient("unknown provider view recipe profile"))
    }
}

/// One view message in engine form and, when present, rendered serializer form.
#[derive(Clone, Debug, PartialEq)]
struct Item {
    engine: Value,
    wire: Option<Value>,
}

impl Item {
    fn slot(&self) -> Value {
        let mut slot = json!({ "engine": self.engine });
        if let Some(wire) = &self.wire {
            slot["wire"] = wire.clone();
        }
        slot
    }

    fn from_slot(slot: &Value) -> Result<Self, HandlerOutcome> {
        Ok(Self {
            engine: slot
                .get("engine")
                .cloned()
                .ok_or_else(|| transient("view synthetic slot has no engine message"))?,
            wire: slot.get("wire").cloned(),
        })
    }
}

/// Decode one stored transcript message through the recipe's codec.
fn source_item(
    lane: RecipeLane,
    mid: &str,
    ordinal: u64,
    native: Value,
) -> Result<Item, HandlerOutcome> {
    let entry = codec::InboundMessage {
        ordinal,
        mid: mid.into(),
        message: native,
    };
    match lane {
        RecipeLane::OwnedBroca | RecipeLane::OwnedBrocaRunner => {
            let ck = super::codec::decode_message(&entry)?;
            Ok(Item {
                engine: serde_json::to_value(ck.ck).map_err(transient)?,
                wire: (lane == RecipeLane::OwnedBroca).then_some(entry.message),
            })
        }
        RecipeLane::OpencodeAiSdk => {
            Err(transient("OpenCode recipes use their own treatment format"))
        }
        RecipeLane::Pi => Err(transient("Pi recipes store every message whole")),
    }
}

/// Exact patches are format 2; OpenCode's whole-message treatments are format 1.
const EXACT_PATCH_FORMAT: u64 = 2;

/// The patch that turns a decoded source into a view message, `Ok(None)` when
/// they are equal, or `Err(())` when the forms differ in kind.
fn exact_patch(source: &Item, target: &Item) -> Result<Option<Value>, ()> {
    let mut engine = Vec::new();
    difference(&source.engine, &target.engine, &mut Vec::new(), &mut engine);
    let mut wire = Vec::new();
    match (&source.wire, &target.wire) {
        (Some(old), Some(new)) => difference(old, new, &mut Vec::new(), &mut wire),
        (None, None) => {}
        _ => return Err(()),
    }
    if engine.is_empty() && wire.is_empty() {
        return Ok(None);
    }
    let mut patch = json!({"format": EXACT_PATCH_FORMAT, "engine": engine});
    if !wire.is_empty() {
        patch["wire"] = serde_json::to_value(wire).map_err(|_| ())?;
    }
    Ok(Some(patch))
}

fn apply_exact(mut item: Item, patch: &Value) -> Result<Item, HandlerOutcome> {
    if patch["format"] != json!(EXACT_PATCH_FORMAT) {
        return Err(transient("unknown view treatment format"));
    }
    let edits = |field: &str| -> Result<Vec<Edit>, HandlerOutcome> {
        patch
            .get(field)
            .map(|edits| serde_json::from_value(edits.clone()).map_err(transient))
            .transpose()
            .map(Option::unwrap_or_default)
    };
    apply(&mut item.engine, &edits("engine")?)?;
    let wire = edits("wire")?;
    if !wire.is_empty() {
        apply(
            item.wire
                .as_mut()
                .ok_or_else(|| transient("view wire patch has no wire source"))?,
            &wire,
        )?;
    }
    Ok(item)
}

/// A view message's native source, resolved before the recipe is built.
struct Native {
    lineage: String,
    mid: String,
    ordinal: u64,
    source: Item,
}

struct ExactView<'a> {
    lane: RecipeLane,
    version: u64,
    range: &'a transform::compaction::Range,
    metadata: Value,
    items: Vec<Item>,
    natives: Vec<Option<Native>>,
    policy_cut_id: Option<u64>,
    state: &'a str,
}

fn build_exact(view: ExactView<'_>) -> ProviderViewRecipe {
    let mut recipe = ProviderViewRecipe {
        version: view.version,
        lineage_id: view.range.lineage_id.clone(),
        range_from: view.range.from,
        range_to: view.range.to,
        base_version: None,
        policy_cut_id: view.policy_cut_id,
        metadata: view.metadata,
        segments: Vec::new(),
        synthetic: BTreeMap::new(),
        treatments: Vec::new(),
        serializer_profile: view.lane.profile().into(),
        render_key: view.lane.render_key().into(),
        tokenizer_key: "mc-tokenizer-byte-bpe-v1".into(),
        state: view.state.into(),
    };
    for (position, (item, native)) in view.items.iter().zip(view.natives).enumerate() {
        if let Some(native) = native {
            if let Ok(patch) = exact_patch(&native.source, item) {
                let rebuilt = match &patch {
                    Some(patch) => apply_exact(native.source.clone(), patch).ok(),
                    None => Some(native.source.clone()),
                };
                if rebuilt.as_ref() == Some(item) {
                    if let Some(patch) = patch {
                        recipe.treatments.push(ProviderViewTreatment {
                            source_lineage_id: native.lineage.clone(),
                            mid: native.mid.clone(),
                            ordinal: native.ordinal,
                            block_index: -1,
                            block_id: format!("{}#@message", native.mid),
                            patch: Some(patch),
                        });
                    }
                    match recipe.segments.last_mut() {
                        Some(ProviderViewSegment::NativeRange {
                            source_lineage_id,
                            to,
                            last_mid,
                            ..
                        }) if *source_lineage_id == native.lineage && *to == native.ordinal => {
                            *to = native.ordinal + 1;
                            *last_mid = native.mid;
                        }
                        _ => recipe.segments.push(ProviderViewSegment::NativeRange {
                            source_lineage_id: native.lineage,
                            from: native.ordinal,
                            to: native.ordinal + 1,
                            first_mid: native.mid.clone(),
                            last_mid: native.mid,
                        }),
                    }
                    continue;
                }
            }
        }
        let slot = format!("synthetic-{position}");
        recipe.synthetic.insert(slot.clone(), item.slot());
        recipe
            .segments
            .push(ProviderViewSegment::Synthetic { slot });
    }
    recipe
}

/// Resolve a stored exact recipe into its metadata and messages.
fn resolve_items(
    lane: RecipeLane,
    resolved: mc_store::ProviderResolvedView,
) -> Result<(Value, Vec<Item>), HandlerOutcome> {
    let mut sources: BTreeMap<_, _> = resolved
        .messages
        .into_iter()
        .map(|(lineage, message)| ((lineage, message.ordinal), message))
        .collect();
    let treatments: BTreeMap<_, _> = resolved
        .recipe
        .treatments
        .into_iter()
        .map(|t| ((t.source_lineage_id.clone(), t.mid.clone()), t))
        .collect();
    let mut items = Vec::new();
    for segment in resolved.recipe.segments {
        match segment {
            ProviderViewSegment::Synthetic { slot } => {
                items.push(Item::from_slot(
                    resolved
                        .recipe
                        .synthetic
                        .get(&slot)
                        .ok_or_else(|| transient("view synthetic slot is missing"))?,
                )?);
            }
            ProviderViewSegment::NativeRange {
                source_lineage_id,
                from,
                to,
                ..
            } => {
                for ordinal in from..to {
                    let message = sources
                        .remove(&(source_lineage_id.clone(), ordinal))
                        .ok_or_else(|| transient("view source lifetime ended"))?;
                    let native =
                        serde_json::from_slice(&message.message_bytes).map_err(transient)?;
                    let mut item = source_item(lane, &message.mid, ordinal, native)?;
                    if let Some(treatment) =
                        treatments.get(&(source_lineage_id.clone(), message.mid))
                    {
                        let patch = treatment.patch.as_ref().expect("effective treatment");
                        item = apply_exact(item, patch)?;
                    }
                    items.push(item);
                }
            }
        }
    }
    Ok((resolved.recipe.metadata, items))
}

/// Recipe-format marker stored with the message-free view metadata.
const HOST_SHELL_FORMAT: u64 = 1;

fn decompose_host(view: &compaction::EngineView) -> Result<(Value, Vec<Item>), HandlerOutcome> {
    if view.wire.replacement.len() != view.engine.replacement.len() {
        let mut metadata = serde_json::to_value(view).map_err(transient)?;
        metadata["mc_recipe"] = json!({"format": HOST_SHELL_FORMAT, "whole": true});
        return Ok((metadata, Vec::new()));
    }
    let mut shell = view.clone();
    shell.engine.replacement.clear();
    shell.wire.replacement.clear();
    let mut metadata = serde_json::to_value(shell).map_err(transient)?;
    metadata["mc_recipe"] = json!({"format": HOST_SHELL_FORMAT});
    let items = view
        .engine
        .replacement
        .iter()
        .zip(&view.wire.replacement)
        .map(|(engine, wire)| {
            Ok(Item {
                engine: serde_json::to_value(engine).map_err(transient)?,
                wire: Some(wire.clone()),
            })
        })
        .collect::<Result<Vec<_>, HandlerOutcome>>()?;
    Ok((metadata, items))
}

fn assemble_host(
    lane: RecipeLane,
    mut metadata: Value,
    items: Vec<Item>,
) -> Result<compaction::EngineView, HandlerOutcome> {
    if !matches!(lane, RecipeLane::OwnedBroca | RecipeLane::Pi) {
        return Err(transient("recipe is not a rendered view"));
    }
    let marker = metadata
        .as_object_mut()
        .and_then(|fields| fields.remove("mc_recipe"))
        .ok_or_else(|| transient("view recipe has no shell marker"))?;
    if marker["format"] != json!(HOST_SHELL_FORMAT) {
        return Err(transient("unknown view recipe format"));
    }
    let mut view: compaction::EngineView = serde_json::from_value(metadata).map_err(transient)?;
    if marker["whole"] == json!(true) {
        return Ok(view);
    }
    for item in items {
        view.engine
            .replacement
            .push(serde_json::from_value(item.engine).map_err(transient)?);
        view.wire.replacement.push(
            item.wire
                .ok_or_else(|| transient("view message has no rendered form"))?,
        );
    }
    Ok(view)
}

/// Broca carries the whole native message it decoded from; that copy is the
/// identity used to find the stored source.
fn broca_identity(message: &ck_wire::CkWireMessage) -> Option<String> {
    message
        .provider_extras
        .get("mc-provider")?
        .get("native_message")
        .map(Value::to_string)
}

/// Pair each Broca view message with a stored source of identical native
/// content, preferring the ordinal after the previous match so a run of
/// survivors maps onto one contiguous range.
fn match_broca(
    lane: RecipeLane,
    messages: &[ck_wire::CkWireMessage],
    sources: &[(String, String, u64, Value)],
) -> Result<Vec<Option<Native>>, HandlerOutcome> {
    let mut index: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (position, (_, _, _, native)) in sources.iter().enumerate() {
        index.entry(native.to_string()).or_default().push(position);
    }
    let mut previous: Option<(String, u64)> = None;
    let mut natives = Vec::with_capacity(messages.len());
    for message in messages {
        let found = (!message.meta.synthetic)
            .then(|| broca_identity(message))
            .flatten()
            .and_then(|identity| index.get(&identity))
            .and_then(|candidates| {
                candidates
                    .iter()
                    .find(|&&at| {
                        previous.as_ref().is_some_and(|(lineage, ordinal)| {
                            sources[at].0 == *lineage && sources[at].2 == ordinal + 1
                        })
                    })
                    .or_else(|| candidates.first())
                    .copied()
            });
        natives.push(match found {
            Some(at) => {
                let (lineage, mid, ordinal, native) = &sources[at];
                previous = Some((lineage.clone(), *ordinal));
                Some(Native {
                    lineage: lineage.clone(),
                    mid: mid.clone(),
                    ordinal: *ordinal,
                    source: source_item(lane, mid, *ordinal, native.clone())?,
                })
            }
            None => None,
        });
    }
    Ok(natives)
}

fn parsed_sources(
    messages: Vec<(String, mc_store::provider_records::ProviderMessage)>,
) -> Result<Vec<(String, String, u64, Value)>, HandlerOutcome> {
    messages
        .into_iter()
        .map(|(lineage, message)| {
            Ok((
                lineage,
                message.mid,
                message.ordinal,
                serde_json::from_slice(&message.message_bytes).map_err(transient)?,
            ))
        })
        .collect()
}

/// Find the stored native source of every host view message that has one.
fn host_natives(
    store: &McStore,
    key: &Key,
    lane: RecipeLane,
    view: &compaction::EngineView,
) -> Result<Vec<Option<Native>>, HandlerOutcome> {
    let messages = &view.engine.replacement;
    let range = &view.engine.range;
    // Broca survivors normally sit at the end of the replaced range. Read that
    // tail first and widen to the whole range only if a survivor is missing.
    let wanted = messages
        .iter()
        .filter(|message| !message.meta.synthetic && broca_identity(message).is_some())
        .count() as u64;
    let tail = range.to.saturating_sub(wanted + 64).max(range.from);
    let read = |first: u64| -> Result<Vec<Option<Native>>, HandlerOutcome> {
        let sources = parsed_sources(
            store
                .load_provider_message_sources_since(&key.store_key(), &range.lineage_id, first)
                .map_err(transient)?,
        )?;
        match_broca(lane, messages, &sources)
    };
    let natives = read(tail)?;
    if tail > range.from && (natives.iter().flatten().count() as u64) < wanted {
        return read(range.from);
    }
    Ok(natives)
}

fn baseline_cut(store: &McStore, key: &mc_store::ProviderSessionKey) -> Option<u64> {
    store
        .provider_fold_settings(key)
        .ok()?
        .get("baseline_cut_id")
        .and_then(Value::as_u64)
}

/// Persist a Broca or Pi rendered view as an exact recipe; OpenCode uses its own writer.
pub fn save_host(
    store: &McStore,
    key: &Key,
    view: &compaction::EngineView,
    state: &str,
) -> Result<(), HandlerOutcome> {
    let started = std::time::Instant::now();
    let conversation = store
        .load_provider_conversation(&key.store_key())
        .map_err(transient)?;
    let params = conversation
        .as_ref()
        .map(|c| serde_json::from_str::<Value>(&c.params_json).map_err(transient))
        .transpose()?
        .unwrap_or_else(|| json!({}));
    let lane = RecipeLane::host(Codec::from_params(&params)?)?;
    if lane == RecipeLane::OpencodeAiSdk {
        return save(store, key, view, state);
    }
    let (metadata, items) = decompose_host(view)?;
    let natives = if items.is_empty() {
        Vec::new()
    } else if lane == RecipeLane::Pi {
        // Pi has no native-source matching yet, so every message becomes a
        // synthetic slot holding its whole engine and wire form.
        items.iter().map(|_| None).collect()
    } else {
        host_natives(store, key, lane, view)?
    };
    let mut recipe = build_exact(ExactView {
        lane,
        version: view.engine.version,
        range: &view.engine.range,
        metadata,
        items,
        natives,
        policy_cut_id: baseline_cut(store, &key.store_key()),
        state,
    });
    let base = conversation
        .as_ref()
        .and_then(|c| c.setup_json.as_deref())
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|setup| setup.pointer("/produced/version").and_then(Value::as_u64));
    if let Some(base) = base.filter(|base| *base < recipe.version) {
        inherit(store, &key.store_key(), &mut recipe, base)?;
    }
    let bytes = store
        .save_provider_view_recipe(&key.store_key(), &recipe)
        .map_err(transient)?;
    tracing::info!(session_id=%key.session,view_version=view.engine.version,stored_view_bytes=bytes,
        persist_ms=started.elapsed().as_secs_f64()*1000.0,profile=lane.profile(),"provider view recipe stored");
    Ok(())
}

/// Build the recipe of a Broca runner view from the record's in-memory
/// transcript. The record writer inserts it in the record's own transaction.
pub fn runner_recipe(
    store: &McStore,
    key: &mc_store::ProviderSessionKey,
    view: &transform::compaction::View,
    messages: &BTreeMap<String, BTreeMap<u64, codec::InboundMessage>>,
    base: Option<u64>,
    state: &str,
) -> Result<ProviderViewRecipe, HandlerOutcome> {
    let lane = RecipeLane::OwnedBrocaRunner;
    let mut shell = view.clone();
    shell.replacement.clear();
    let items = view
        .replacement
        .iter()
        .map(|message| {
            Ok(Item {
                engine: serde_json::to_value(message).map_err(transient)?,
                wire: None,
            })
        })
        .collect::<Result<Vec<_>, HandlerOutcome>>()?;
    // Read the range's tail first, then the whole record, as for host Broca.
    let wanted = view
        .replacement
        .iter()
        .filter(|message| !message.meta.synthetic && broca_identity(message).is_some())
        .count() as u64;
    let collect = |first: u64| {
        let mut sources = Vec::new();
        // The view's own lineage first, so its ordinals win identical content.
        let ordered = messages
            .get_key_value(&view.range.lineage_id)
            .into_iter()
            .chain(
                messages
                    .iter()
                    .filter(|(lineage, _)| **lineage != view.range.lineage_id),
            );
        for (lineage, entries) in ordered {
            for (ordinal, entry) in entries.range(first..) {
                sources.push((
                    lineage.clone(),
                    entry.mid.clone(),
                    *ordinal,
                    entry.message.clone(),
                ));
            }
        }
        sources
    };
    let tail = view
        .range
        .to
        .saturating_sub(wanted + 64)
        .max(view.range.from);
    let mut natives = match_broca(lane, &view.replacement, &collect(tail))?;
    if tail > view.range.from && (natives.iter().flatten().count() as u64) < wanted {
        natives = match_broca(lane, &view.replacement, &collect(view.range.from))?;
    }
    let mut recipe = build_exact(ExactView {
        lane,
        version: view.version,
        range: &view.range,
        metadata: serde_json::to_value(&shell).map_err(transient)?,
        items,
        natives,
        policy_cut_id: store
            .load_provider_conversation(key)
            .ok()
            .flatten()
            .and_then(|_| baseline_cut(store, key)),
        state,
    });
    if let Some(base) = base.filter(|base| *base < recipe.version) {
        inherit(store, key, &mut recipe, base)?;
    }
    Ok(recipe)
}

/// Resolve a Broca runner view recipe.
pub fn load_runner(
    store: &McStore,
    key: &mc_store::ProviderSessionKey,
    version: u64,
) -> Result<Option<transform::compaction::View>, HandlerOutcome> {
    let Some(resolved) = store
        .resolve_provider_view(key, version)
        .map_err(transient)?
    else {
        return Ok(None);
    };
    let lane = RecipeLane::from_profile(&resolved.recipe.serializer_profile)?;
    if lane != RecipeLane::OwnedBrocaRunner {
        return Err(transient("recipe is not a runner view"));
    }
    let (metadata, items) = resolve_items(lane, resolved)?;
    let mut view: transform::compaction::View =
        serde_json::from_value(metadata).map_err(transient)?;
    view.replacement = items
        .into_iter()
        .map(|item| serde_json::from_value(item.engine).map_err(transient))
        .collect::<Result<_, _>>()?;
    Ok(Some(view))
}

/// A stored view as one row, for tests that inspect what a lane persisted:
/// the resolved host view serialized exactly as the whole-copy table held it.
#[cfg(test)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredView {
    pub version: u64,
    pub lineage_id: String,
    pub range_from: u64,
    pub range_to: u64,
    pub replacement_json: String,
    pub state: String,
}

#[cfg(test)]
pub fn stored_view(
    store: &McStore,
    key: &mc_store::ProviderSessionKey,
    version: u64,
) -> Option<StoredView> {
    let resolved = store.resolve_provider_view(key, version).unwrap()?;
    let state = resolved.recipe.state.clone();
    let lane = RecipeLane::from_profile(&resolved.recipe.serializer_profile).unwrap();
    assert_ne!(
        lane,
        RecipeLane::OpencodeAiSdk,
        "OpenCode views have their own reader"
    );
    if lane == RecipeLane::OwnedBrocaRunner {
        let view = load_runner(store, key, version).unwrap().unwrap();
        return Some(StoredView {
            version: view.version,
            lineage_id: view.range.lineage_id.clone(),
            range_from: view.range.from,
            range_to: view.range.to,
            replacement_json: serde_json::to_string(&view.replacement).unwrap(),
            state,
        });
    }
    let (metadata, items) = resolve_items(lane, resolved).unwrap();
    let view = assemble_host(lane, metadata, items).unwrap();
    Some(StoredView {
        version: view.engine.version,
        lineage_id: view.engine.range.lineage_id.clone(),
        range_from: view.engine.range.from,
        range_to: view.engine.range.to,
        replacement_json: serde_json::to_string(&view).unwrap(),
        state,
    })
}

#[cfg(test)]
pub fn stored_views(store: &McStore, key: &mc_store::ProviderSessionKey) -> Vec<StoredView> {
    store
        .load_provider_view_recipe_versions(key)
        .unwrap()
        .into_iter()
        .filter_map(|version| stored_view(store, key, version))
        .collect()
}
