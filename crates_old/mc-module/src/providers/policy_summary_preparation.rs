//! Preparation leaves the baseline unchanged. The next hook chooses the newest
//! message included in the policy and publishes that policy.
use super::*;
use crate::tail_hygiene::{
    refresh_tail_hygiene_baseline_calibrated, HygieneCalibration, TailHygieneMeasurement,
};
use mc_store::ProviderPreparationWrite;

const MAX_PREPARED_PARTS: usize = 100_000;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MeasuredPart {
    position: PartKey,
    measurement: TailHygienePartMeasurement,
    stored: TailHygienePartMeasurement,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct PreparedPolicy {
    format: u8,
    summary: PolicySummary,
    original: Option<TailHygieneBaseline>,
    measured: Vec<MeasuredPart>,
    needs_refreeze: bool,
    newest_ordinal: u64,
}

pub fn prepare(
    index: &ProviderPolicyIndex<'_>,
    engine_policy: &Value,
    protected_floor: u64,
    protected_tools: &BTreeMap<String, usize>,
    model_key: Option<&str>,
) -> Result<Option<ProviderPreparationWrite>, ProviderError> {
    let settings = Settings::resolve(
        engine_policy,
        protected_floor,
        protected_tools,
        false,
        model_key,
    );
    let parts = index.all_parts()?;
    if parts.len() > MAX_PREPARED_PARTS {
        return Ok(None);
    }
    // Compare against the measurements stored before preparation, not measurements
    // reset while evaluating an earlier candidate range of messages.
    let Some(summary) = build(&parts, &settings, settings.key(index), None) else {
        return Ok(None);
    };
    let needs_refreeze = summary.totals.base_mismatch != 0 || settings.previous.is_none();
    let arcs = protected_set(&summary.protected);
    let protection = Protection {
        window: &summary.window,
        arcs: &arcs,
        cutoff: summary.cutoff,
    };
    let neighbours = Neighbours::from_parts(&parts);
    let measured = parts
        .iter()
        .filter(|part| part.kind != "header")
        .map(|part| MeasuredPart {
            position: part_key(part),
            measurement: measure(part, &settings, &protection, &neighbours),
            stored: part.measurement.clone(),
        })
        .collect::<Vec<_>>();
    let mut original = settings.previous.clone();
    if let Some(original) = original.as_mut() {
        original.baseline_parts = measured
            .iter()
            .take(settings.baseline_len)
            .map(|part| part.stored.clone())
            .collect();
    }
    let newest_ordinal = parts.iter().map(|part| part.ordinal).max().unwrap_or(0);
    let original_baseline_json = serde_json::to_string(&settings.previous).expect("baseline JSON");
    let settings_key = settings.preparation_key(index);
    let data = PreparedPolicy {
        format: 1,
        summary,
        original,
        measured,
        needs_refreeze,
        newest_ordinal,
    };
    let prepared_json = serde_json::to_string(&data).expect("prepared policy JSON");
    Ok(Some(ProviderPreparationWrite {
        settings_key,
        original_baseline_json,
        newest_ordinal,
        prepared_json,
    }))
}

pub fn changed_measurement(
    part: &ProviderPolicyPart,
    settings: &Settings,
    protection: &Protection<'_>,
    neighbours: &Neighbours,
) -> MeasuredPart {
    MeasuredPart {
        position: part_key(part),
        measurement: measure(part, settings, protection, neighbours),
        stored: part.measurement.clone(),
    }
}

pub fn consume(
    index: &ProviderPolicyIndex<'_>,
    settings: &Settings,
    carrier: bool,
) -> Result<Option<(Channel1PolicyInputs, String)>, ProviderError> {
    let Some(saved) = index.preparation() else {
        return Ok(None);
    };
    if saved.settings_key != settings.preparation_key(index)
        || saved.original_baseline_json
            != serde_json::to_string(&settings.previous).expect("baseline JSON")
    {
        return Ok(None);
    }
    let data = saved
        .decode()
        .ok()
        .and_then(|raw| serde_json::from_str::<PreparedPolicy>(&raw).ok());
    let Some(mut data) =
        data.filter(|data| data.format == 1 && data.measured.len() <= MAX_PREPARED_PARTS)
    else {
        return Ok(None);
    };
    if data.summary.key != settings.key(index) || data.newest_ordinal != saved.newest_ordinal {
        return Ok(None);
    }
    let mut changed = Vec::new();
    let Some(mut summary) =
        replay_measured(index, data.summary, settings, Some(&mut changed), None)?
    else {
        return Ok(None);
    };
    if !summary.totals.bounded() {
        return Ok(None);
    }
    changed.sort_by_key(|part| part.position);
    for part in changed {
        match data
            .measured
            .binary_search_by_key(&part.position, |held| held.position)
        {
            Ok(at) => {
                if let Some(original) = data
                    .original
                    .as_mut()
                    .filter(|_| at < settings.baseline_len)
                {
                    if let Some(held) = original.baseline_parts.get_mut(at) {
                        *held = part.stored.clone();
                    }
                }
                data.measured[at] = part;
            }
            Err(at) if at == data.measured.len() => data.measured.push(part),
            Err(_) => return Ok(None),
        }
    }
    data.measured.sort_by_key(|part| part.position);
    let newest = summary.max_key.map_or(0, |key| key.0);
    // If the newest message has not advanced past the recorded ordinal, return
    // None so the caller evaluates the full, non-prepared policy.
    if newest <= data.newest_ordinal {
        return Ok(None);
    }
    if data.measured.len() != usize::try_from(summary.totals.nonheader).unwrap_or(usize::MAX) {
        return Ok(None);
    }
    let newest_start = data
        .measured
        .partition_point(|part| part.position.0 < newest);
    let calibration = data.original.as_ref().map_or(
        HygieneCalibration {
            units_version: 2,
            tools_ratio: settings.tools_ratio,
            prose_ratio: settings.prose_ratio,
        },
        |old| HygieneCalibration {
            units_version: old.hygiene_units_version.max(1),
            tools_ratio: old.hygiene_tools_ratio,
            prose_ratio: old.hygiene_prose_ratio,
        },
    );
    let baseline = refresh_tail_hygiene_baseline_calibrated(
        TailHygieneMeasurement {
            u: 0,
            t: 0,
            content_signature: String::new(),
            parts: data
                .measured
                .iter()
                .map(|part| part.measurement.clone())
                .collect(),
            newest_message_part_start: newest_start,
        },
        false,
        data.original.as_ref(),
        0,
        calibration,
    )
    .baseline;
    let froze = settings
        .previous
        .as_ref()
        .map(|old| old.baseline_generation)
        != Some(baseline.baseline_generation);
    let mut next_settings = settings.clone();
    if froze {
        // Only the hook admitting the message may publish these baseline values;
        // preparation must not reset measurements before that admission.
        next_settings.baseline_len = baseline.baseline_parts.len();
        let mut compact = baseline.clone();
        compact.baseline_parts.clear();
        next_settings.previous = Some(compact);
        summary.key = next_settings.key(index);
        summary.baseline_end = data
            .measured
            .get(next_settings.baseline_len)
            .map(|part| part.position);
        summary.totals.base_mismatch = 0;
        summary.totals.base_advance_u = 0;
        summary.totals.base_queued_u = 0;
        summary.totals.base_tool_outputs = baseline
            .baseline_parts
            .iter()
            .filter(|part| part.kind == TailHygienePartKind::ToolOutput && part.u_tokens > 0)
            .count() as i64;
        summary.totals.turn_t = baseline.turn_delta_t;
        summary.totals.turn_u = baseline.turn_delta_u;
    }
    let (Ok(users), Ok(tool_outputs)) = (
        u64::try_from(summary.totals.users),
        usize::try_from(summary.totals.base_tool_outputs),
    ) else {
        return Ok(None);
    };
    let inputs = Channel1PolicyInputs {
        baseline,
        users,
        tool_outputs,
        hint: merged_hint(&summary.hint),
        carrier,
    };
    tracing::info!(
        parts = data.measured.len(),
        refroze = froze,
        prepared_refreeze_needed = data.needs_refreeze,
        "provider prepared policy consumed"
    );
    index.mark_preparation_consumed();
    Ok(Some((
        inputs,
        serde_json::to_string(&summary).expect("summary JSON"),
    )))
}
