use super::jcs;
use mc_store::memory_levels::{Actor, CreateEvent, CreateKind};
use serde_json::{json, Value};

pub(super) const TEXT_CAP: usize = 16_384;
pub(super) const OP_CAP: usize = 65_536;

pub(super) fn eligible(event: &CreateEvent) -> bool {
    event.kind == CreateKind::Create
        && event.writer_project_id.is_some()
        && event.owner.is_some()
        && event.origin_profile.is_some()
        && event.snapshot_digest.is_some()
}

pub(super) fn map(
    event: &CreateEvent,
    account: &str,
    device: &str,
    local_id: i64,
    clock: (i64, i64),
) -> Result<Vec<u8>, &'static str> {
    let missing = "op_unmappable";
    let owner = event.owner.as_ref().ok_or(missing)?;
    let profile = event.origin_profile.as_ref().ok_or(missing)?;
    let category = event
        .effective_category_id
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or(missing)?;
    let project = event
        .writer_project_id
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or(missing)?;
    let snapshot_digest = event.snapshot_digest.as_deref().ok_or(missing)?;
    if account.is_empty()
        || device.is_empty()
        || local_id <= 0
        || owner.kind != "project"
        || owner.id.is_empty()
        || profile.name.is_empty()
        || profile.version.is_empty()
        || profile.digest.is_empty()
        || snapshot_digest.len() != 64
        || !snapshot_digest
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || event.content.is_empty()
        || event.expires_at.is_some_and(|v| v < 0)
    {
        return Err(missing);
    }
    if event.content.len() > TEXT_CAP {
        return Err("text_too_large");
    }
    let importance = event.importance.unwrap_or(50);
    if !(1..=100).contains(&importance) {
        return Err(missing);
    }
    let ordinals = ordinals(event)?;
    let (actor, reason) = match event.actor {
        Actor::MainAgent => ("main_agent", "main_agent: explicit ctx_memory write"),
        Actor::Historian => ("historian", "historian: promoted from session history"),
        Actor::Dreamer => ("dreamer", "dreamer: written by a dreamer task"),
    };
    let owner = json!({"kind":owner.kind,"id":owner.id});
    let authority = jcs::digest(
        &jcs::bytes(&json!({"snapshot_digest":snapshot_digest,"owner":owner}))
            .map_err(|_| missing)?,
    );
    let id = json!({"device":device,"local_id":local_id.to_string()});
    let projects = json!([event.owner.as_ref().unwrap().id]);
    let value = json!({
        "schema":"mc/memory-op@1", "op_id":id, "memory_id":id,
        "hlc":{"wall_ms":clock.0.to_string(),"logical":clock.1.to_string()},
        "account":account,"kind":"create","level":"project","owner_key":owner,
        "category":category,"origin_profile":profile,
        "provenance":{"session_id":event.session_id,"ordinals":ordinals,"evidence":[],"actor":actor,
            "authority_snapshot":authority,"batch_id":null,"legacy_origin":null},
        "revision":{"parents":[],"result":id},"curation":null,"delivery":"A",
        "payload":{"snapshot":{"content":event.content,"importance":importance,"load_mode":"always",
            "applies_to":{"subject":category,"project_ids":projects,"reason":reason},
            "audience":{"principal":account,"source_project_ids":[project],"project_ids":projects},
            "shareable":false,"valid_from":null,"valid_to":null,"expires_at":event.expires_at.map(|v| v.to_string()),
            "event_condition":null,"overrides":[],"superseded_by":null,
            "verification":{"status":"unverified","evidence":[],"content_revision":id},"mural_cue":null,"lineage":[]}}
    });
    let bytes = jcs::bytes(&value).map_err(|_| missing)?;
    if bytes.len() > OP_CAP {
        return Err("op_too_large");
    }
    Ok(bytes)
}

fn ordinals(event: &CreateEvent) -> Result<Value, &'static str> {
    if event.actor == Actor::Dreamer {
        return Ok(json!([]));
    }
    if event.session_id.as_deref().is_none_or(str::is_empty) {
        return Err("op_unmappable");
    }
    let mut values = event.ordinals.clone();
    if values
        .iter()
        .any(|v| !(1..=9_007_199_254_740_991).contains(v))
    {
        return Err("op_unmappable");
    }
    values.sort_unstable();
    values.dedup();
    let mut ranges: Vec<[i64; 2]> = Vec::new();
    for ordinal in values {
        if let Some(last) = ranges.last_mut().filter(|r| r[1] + 1 == ordinal) {
            last[1] = ordinal;
        } else {
            ranges.push([ordinal, ordinal]);
        }
    }
    if ranges.len() > 64 {
        return Err("op_unmappable");
    }
    Ok(json!(ranges))
}
