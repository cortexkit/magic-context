//! Validate the independently stored engine cache against its provider baseline.
use super::*;

#[derive(Serialize, Deserialize)]
pub(super) struct Witness {
    namespace: String,
    digest: String,
}

fn digest(loaded: &mc_store::LoadedState) -> Result<String, HandlerOutcome> {
    let bytes = serde_json::to_vec(&(
        &loaded.core,
        &loaded.meta.last_render_config,
        &loaded.meta.served_output_fingerprint,
        loaded.meta.coverage_ordinal,
        loaded.meta.initialized,
    ))
    .map_err(transient)?;
    Ok(crate::sha256_hex(&bytes))
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
