//! Fixed token calibration, display accounting and provider-window geometry.
//! Session usage never changes class ratios or persisted local counts. Successful
//! input proofs can raise catalog-derived geometry, but not trusted provider walls.

use mc_store::FrozenDecisionCalibration;

pub const CALIBRATION_TABLE_REVISION: &str = "2026-09-30-sol-tokenizer-seeds-v3";

/// Class ratios resolved for a model by the caller.
#[derive(Debug, Clone, Copy)]
pub struct DecisionCalibration {
    pub system_ratio: f64,
    pub tools_ratio: f64,
    pub prose_ratio: f64,
    /// Family-inherited measurements are seeded; only genuinely unknown models are not.
    pub seeded: bool,
    /// Fallback for unknown models: callers must supply at least the largest measured
    /// class ratio in the static table. Values below two are rejected.
    pub unknown_fit_ratio: f64,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct LocalMass {
    pub system: f64,
    pub tools: f64,
    pub prose: f64,
}

impl DecisionCalibration {
    pub fn neutral() -> Self {
        Self {
            system_ratio: 1.0,
            tools_ratio: 1.0,
            prose_ratio: 1.0,
            seeded: false,
            unknown_fit_ratio: seeds()
                .iter()
                .flat_map(|seed| [seed.system_ratio, seed.tools_ratio, seed.prose_ratio])
                .fold(2.0, f64::max),
        }
    }

    pub fn from_frozen(frozen: &FrozenDecisionCalibration) -> Option<Self> {
        let ratios = [frozen.system_ratio, frozen.tools_ratio, frozen.prose_ratio];
        if frozen.revision.is_empty()
            || frozen.provider_id.is_empty()
            || frozen.model_id.is_empty()
            || ratios
                .into_iter()
                .any(|ratio| !ratio.is_finite() || ratio <= 0.0)
            || !matches!(
                frozen.source.as_str(),
                "seed" | "family-fallback" | "model-id"
            )
        {
            return None;
        }
        Some(Self {
            system_ratio: frozen.system_ratio,
            tools_ratio: frozen.tools_ratio,
            prose_ratio: frozen.prose_ratio,
            seeded: matches!(frozen.source.as_str(), "family-fallback" | "model-id")
                || ratios.into_iter().any(|ratio| ratio != 1.0),
            unknown_fit_ratio: seeds()
                .iter()
                .flat_map(|seed| [seed.system_ratio, seed.tools_ratio, seed.prose_ratio])
                .fold(2.0, f64::max),
        })
    }

    pub fn freeze_for_model(model_key: Option<&str>) -> FrozenDecisionCalibration {
        let key = model_key.unwrap_or("").to_lowercase();
        let (provider_id, model_id) = key
            .split_once('/')
            .map_or(("unknown", "unknown"), |(provider, model)| {
                (provider, model)
            });
        let calibration = Self::for_model(model_key);
        FrozenDecisionCalibration {
            revision: CALIBRATION_TABLE_REVISION.to_string(),
            provider_id: provider_id.to_string(),
            model_id: model_id.to_string(),
            system_ratio: calibration.system_ratio,
            tools_ratio: calibration.tools_ratio,
            prose_ratio: calibration.prose_ratio,
            source: seed_source(model_key).to_string(),
        }
    }

    /// Accumulate fractional provider mass, then ceil once at the decision boundary.
    /// Invalid inputs yield infinity, so a finite provider window cannot admit them.
    pub fn provider_mass(self, raw: LocalMass, fit: bool) -> f64 {
        if [raw.system, raw.tools, raw.prose]
            .into_iter()
            .any(|count| !count.is_finite() || count < 0.0)
            || [self.system_ratio, self.tools_ratio, self.prose_ratio]
                .into_iter()
                .any(|ratio| !ratio.is_finite() || ratio <= 0.0)
            || (fit
                && !self.seeded
                && (!self.unknown_fit_ratio.is_finite() || self.unknown_fit_ratio < 2.0))
        {
            return f64::INFINITY;
        }
        let total = if fit && !self.seeded {
            (raw.system + raw.tools + raw.prose) * self.unknown_fit_ratio
        } else {
            raw.system * self.system_ratio
                + raw.tools * self.tools_ratio
                + raw.prose * self.prose_ratio
        };
        if total.is_finite() {
            total.ceil()
        } else {
            f64::INFINITY
        }
    }
}

/// Round available real-token budgets down before comparison with raw local mass.
pub fn local_budget(provider_tokens: f64, ratio: f64) -> f64 {
    if !provider_tokens.is_finite() || provider_tokens <= 0.0 || !ratio.is_finite() || ratio <= 0.0
    {
        return 0.0;
    }
    (provider_tokens / ratio).floor()
}

/// Native catalog/provider facts supplied by the bridge, in provider token units.
#[derive(Debug, Clone, Copy, Default, serde::Deserialize, serde::Serialize)]
pub struct ModelWindowLimit {
    pub context: Option<f64>,
    pub input: Option<f64>,
    pub output: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WindowGeometry {
    SharedUpfront,
    SharedTruncating,
    Separate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WindowReserveSource {
    OutputCatalog,
    OutputConfig,
    WallMargin,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WindowLimitSource {
    Catalog,
    Overlay,
    Provider,
    Detected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WindowHarness {
    Opencode,
    Pi,
}

/// Resolved overlay cells retain unknown geometry separately from an absent fact.
/// File loading, provider aliases and model selection remain bridge concerns.
#[derive(Debug, Clone, Default, serde::Deserialize, serde::Serialize)]
pub struct WindowOverlayFacts {
    pub facts: std::collections::BTreeMap<String, WindowOverlayFact>,
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct WindowOverlayFact {
    pub value: WindowOverlayValue,
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WindowOverlayValue {
    Stated {
        value: serde_json::Value,
    },
    Bracket {
        at_least: Option<f64>,
        below: Option<f64>,
    },
    Unknown {
        why: String,
    },
}

impl WindowOverlayFacts {
    fn numeric(&self, key: &str) -> Option<f64> {
        match &self.facts.get(key)?.value {
            WindowOverlayValue::Stated { value } => positive(value.as_f64()),
            WindowOverlayValue::Bracket { at_least, .. } => positive(*at_least),
            WindowOverlayValue::Unknown { .. } => None,
        }
    }

    fn geometry(&self) -> Option<WindowGeometry> {
        match &self.facts.get("geometry")?.value {
            WindowOverlayValue::Stated { value } => serde_json::from_value(value.clone()).ok(),
            WindowOverlayValue::Unknown { .. } => Some(WindowGeometry::SharedUpfront),
            WindowOverlayValue::Bracket { .. } => None,
        }
    }
}

#[derive(Debug, Clone, Default, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowGeometryOptions {
    pub overlay: Option<WindowOverlayFacts>,
    pub provider_limit: Option<ModelWindowLimit>,
    pub output_reserve_override: Option<f64>,
    pub harness: Option<WindowHarness>,
    pub context_cap: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowDerivation {
    pub window: f64,
    pub reserve: f64,
    pub reserve_source: WindowReserveSource,
    pub geometry: WindowGeometry,
    pub window_source: WindowLimitSource,
    pub absolute_wall: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proven_input_tokens: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowGeometryResult {
    pub usable_soft: f64,
    pub usable_hard: f64,
    pub geometry: WindowGeometry,
    pub derivation: WindowDerivation,
}

pub const MIN_PLAUSIBLE_CONTEXT_LIMIT: f64 = 1_024.0;
const OUTPUT_RESERVE_CAP_RATIO: f64 = 0.25;
const OPENCODE_OUTPUT_CAP: f64 = 32_000.0;
const PROMPT_WALL_MARGIN: f64 = 4_096.0;

fn positive(value: Option<f64>) -> Option<f64> {
    value.filter(|value| value.is_finite() && *value > 0.0)
}

/// Output equal to (or larger than) context is a placeholder, not a reserve.
pub fn placeholder_filtered_output(output: Option<f64>, context: Option<f64>) -> Option<f64> {
    positive(output).filter(|output| positive(context).is_none_or(|context| *output < context))
}

/// Resolve soft admission limits, hard pressure limits and their provenance from
/// catalog, overlay and native provider facts, mirroring shared/window-geometry.ts.
/// Existing scheduler/transform callers continue to use their supplied geometry.
pub fn derive_window_geometry(
    provider_id: &str,
    catalog: Option<ModelWindowLimit>,
    options: &WindowGeometryOptions,
) -> Option<WindowGeometryResult> {
    if catalog.is_none() && options.provider_limit.is_none() {
        return None;
    }
    let catalog = catalog.unwrap_or_default();
    let provider = options.provider_limit.unwrap_or_default();
    let numeric = |key| {
        options
            .overlay
            .as_ref()
            .and_then(|facts| facts.numeric(key))
    };
    let advertised = numeric("window.advertised");
    let enforced = numeric("window.enforced");
    let provider_context = positive(provider.context);
    let mut soft_context = provider_context
        .or(enforced)
        .or(advertised)
        .or(positive(catalog.context));
    let mut hard_context = provider_context.or(enforced).or(soft_context);
    let cap = positive(options.context_cap);
    if let Some(cap) = cap {
        soft_context = Some(soft_context.map_or(cap, |window| window.min(cap)));
        hard_context = Some(hard_context.map_or(cap, |window| window.min(cap)));
    }
    let input = positive(provider.input).or(positive(catalog.input));
    let context = soft_context.or(input)?;
    let catalog_output = if options.overlay.is_none() && options.provider_limit.is_none() {
        positive(catalog.output)
    } else {
        placeholder_filtered_output(catalog.output, soft_context)
    };
    let overlay_output = placeholder_filtered_output(
        numeric("output.enforced")
            .or_else(|| numeric("output.default"))
            .or_else(|| numeric("output.advertised")),
        soft_context,
    );
    let output = placeholder_filtered_output(provider.output, soft_context)
        .or(overlay_output)
        .or(catalog_output);
    let geometry_fact = options
        .overlay
        .as_ref()
        .and_then(WindowOverlayFacts::geometry);
    let geometry = geometry_fact.unwrap_or(match provider_id {
        "anthropic" | "xai" => WindowGeometry::SharedTruncating,
        "google" | "google-antigravity" => WindowGeometry::Separate,
        _ => WindowGeometry::SharedUpfront,
    });
    let pre_carved = input.is_some_and(|input| soft_context.is_none_or(|window| input < window));
    let override_reserve = options
        .output_reserve_override
        .filter(|reserve| reserve.is_finite() && *reserve >= 0.0);
    let mut window = context;
    let reserve_source;
    let usable_soft;
    if let Some(reserve) = override_reserve {
        window = if pre_carved { input? } else { context };
        let floor = MIN_PLAUSIBLE_CONTEXT_LIMIT.max(window * 0.5);
        usable_soft = (window - reserve.min((window - floor).max(0.0))).floor();
        reserve_source = WindowReserveSource::OutputConfig;
    } else if pre_carved {
        usable_soft = input?;
        reserve_source = if soft_context.is_some() {
            WindowReserveSource::OutputCatalog
        } else {
            WindowReserveSource::None
        };
    } else if let Some(context) = soft_context {
        let separate = geometry == WindowGeometry::Separate
            && (options.overlay.is_none()
                || options.harness == Some(WindowHarness::Pi)
                || geometry_fact.is_some());
        let mut reserve = if separate { 0.0 } else { output.unwrap_or(0.0) };
        reserve_source = if separate || output.is_none() {
            WindowReserveSource::None
        } else {
            WindowReserveSource::OutputCatalog
        };
        let cap = context * OUTPUT_RESERVE_CAP_RATIO;
        reserve = reserve.min(
            if options.harness == Some(WindowHarness::Pi) || options.overlay.is_none() {
                cap
            } else {
                cap.min(OPENCODE_OUTPUT_CAP)
            },
        );
        let floor = MIN_PLAUSIBLE_CONTEXT_LIMIT.max(context * 0.5);
        usable_soft = (context - reserve.min((context - floor).max(0.0))).floor();
    } else {
        usable_soft = input?;
        reserve_source = WindowReserveSource::None;
    }
    let hard_window = hard_context.or(soft_context).or(input)?;
    let window_source = if cap.is_some() {
        WindowLimitSource::Detected
    } else if provider_context.is_some() {
        WindowLimitSource::Provider
    } else if enforced.is_some() || advertised.is_some() {
        WindowLimitSource::Overlay
    } else {
        WindowLimitSource::Catalog
    };
    let hard_reserve = match geometry {
        WindowGeometry::Separate => 0.0,
        WindowGeometry::SharedTruncating => PROMPT_WALL_MARGIN,
        WindowGeometry::SharedUpfront if options.harness == Some(WindowHarness::Pi) => {
            if provider_id == "openai-codex" {
                output.unwrap_or(OPENCODE_OUTPUT_CAP)
            } else {
                PROMPT_WALL_MARGIN
            }
        }
        WindowGeometry::SharedUpfront => output
            .unwrap_or(OPENCODE_OUTPUT_CAP)
            .min(OPENCODE_OUTPUT_CAP),
    };
    let usable_hard = (hard_window - hard_reserve)
        .floor()
        .max(MIN_PLAUSIBLE_CONTEXT_LIMIT)
        .max(usable_soft);
    Some(WindowGeometryResult {
        usable_soft,
        usable_hard,
        geometry,
        derivation: WindowDerivation {
            window: window.floor(),
            reserve: (window - usable_soft).max(0.0).floor(),
            reserve_source,
            geometry,
            window_source,
            absolute_wall: hard_window.floor(),
            proven_input_tokens: None,
        },
    })
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefusedInputProof {
    pub reading: f64,
    pub absolute_wall: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct ProvenInputFloorResult {
    pub geometry: WindowGeometryResult,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refused: Option<RefusedInputProof>,
}

pub fn has_trusted_absolute_wall(geometry: &WindowGeometryResult) -> bool {
    geometry.derivation.window_source != WindowLimitSource::Catalog
}

/// Apply an already-authorized successful input reading. Only catalog walls can
/// be disproved here; a provider, overlay or detected wall remains authoritative.
pub fn apply_proven_input_floor(
    geometry: WindowGeometryResult,
    proven_input_tokens: Option<f64>,
) -> ProvenInputFloorResult {
    let mut result = ProvenInputFloorResult {
        geometry,
        refused: None,
    };
    let Some(proven) = positive(proven_input_tokens)
        .filter(|value| *value >= MIN_PLAUSIBLE_CONTEXT_LIMIT && *value > geometry.usable_soft)
    else {
        return result;
    };
    let trusted = has_trusted_absolute_wall(&geometry);
    if trusted && proven > geometry.derivation.absolute_wall {
        result.refused = Some(RefusedInputProof {
            reading: proven,
            absolute_wall: geometry.derivation.absolute_wall,
        });
        return result;
    }
    let target = &mut result.geometry;
    target.usable_soft = proven;
    if !trusted {
        target.usable_hard = target.usable_hard.max(proven);
        target.derivation.window = target.derivation.window.max(proven);
        target.derivation.absolute_wall = target.derivation.absolute_wall.max(proven);
    }
    target.derivation.reserve = (target.derivation.window - proven).max(0.0);
    target.derivation.proven_input_tokens = Some(proven);
    result
}

/// Raw bridge-counted request buckets. The <user-profile> and <project-docs>
/// blocks are prose in the first user message, not system text. These display
/// counts never replace the raw local counts used for budgeting.
#[derive(Debug, Clone, Copy, Default, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationInput {
    pub input_tokens: f64,
    pub system_local: f64,
    pub tool_defs_local: f64,
    pub compartments_local: f64,
    pub facts_local: f64,
    pub memories_local: f64,
    pub docs_local: f64,
    pub profile_local: f64,
    pub conversation_local: f64,
    pub tool_calls_local: f64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibratedBuckets {
    pub system_tokens: f64,
    pub tool_definition_tokens: f64,
    pub compartment_tokens: f64,
    pub fact_tokens: f64,
    pub memory_tokens: f64,
    pub docs_tokens: f64,
    pub profile_tokens: f64,
    pub conversation_tokens: f64,
    pub tool_call_tokens: f64,
}

/// Attribute the provider's usage total across display buckets. After scaling
/// system text, tool definitions and first-message prose by their class ratios,
/// split the remaining tokens between conversation and tool calls proportionally.
pub fn calibrate_buckets(
    input: CalibrationInput,
    calibration: DecisionCalibration,
) -> CalibratedBuckets {
    if input.input_tokens <= 0.0 {
        return CalibratedBuckets::default();
    }
    // Match JavaScript's half-up rounding, including any negative residual delta.
    let round = |value: f64| (value + 0.5).floor();
    let mut fixed = [
        round(input.system_local * calibration.system_ratio),
        round(input.tool_defs_local * calibration.tools_ratio),
        round(input.compartments_local.max(0.0) * calibration.prose_ratio),
        round(input.facts_local.max(0.0) * calibration.prose_ratio),
        round(input.memories_local.max(0.0) * calibration.prose_ratio),
        round(input.docs_local.max(0.0) * calibration.prose_ratio),
        round(input.profile_local.max(0.0) * calibration.prose_ratio),
    ];
    let total: f64 = fixed.iter().sum();
    if total > input.input_tokens {
        let ratio = input.input_tokens / total;
        for bucket in &mut fixed {
            *bucket = round(*bucket * ratio);
        }
    }
    let residual_target = (input.input_tokens - fixed.iter().sum::<f64>()).max(0.0);
    let residual_local = input.conversation_local + input.tool_calls_local;
    let mut residual = if residual_local <= 0.0 {
        [residual_target, 0.0]
    } else {
        let scale = residual_target / residual_local;
        [
            round(input.conversation_local * scale),
            round(input.tool_calls_local * scale),
        ]
    };
    let mut delta = input.input_tokens - (fixed.iter().sum::<f64>() + residual[0] + residual[1]);
    if delta != 0.0 {
        let largest = usize::from(residual[0] < residual[1]);
        let adjusted = (residual[largest] + delta).max(0.0);
        delta -= adjusted - residual[largest];
        residual[largest] = adjusted;
    }
    if delta < 0.0 {
        // Stable ties keep the original bucket order, with profile last.
        let mut order = [0, 1, 2, 3, 4, 5, 6];
        order.sort_by(|a, b| fixed[*b].total_cmp(&fixed[*a]));
        for index in order {
            if delta >= 0.0 {
                break;
            }
            if fixed[index] <= 0.0 {
                continue;
            }
            let adjustment = fixed[index].min(-delta);
            fixed[index] -= adjustment;
            delta += adjustment;
        }
    }
    CalibratedBuckets {
        system_tokens: fixed[0],
        tool_definition_tokens: fixed[1],
        compartment_tokens: fixed[2],
        fact_tokens: fixed[3],
        memory_tokens: fixed[4],
        docs_tokens: fixed[5],
        profile_tokens: fixed[6],
        conversation_tokens: residual[0],
        tool_call_tokens: residual[1],
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SeedEntry {
    prefix: String,
    system_ratio: f64,
    tools_ratio: f64,
    #[serde(default = "neutral_ratio")]
    prose_ratio: f64,
}
fn neutral_ratio() -> f64 {
    1.0
}

fn seeds() -> &'static [SeedEntry] {
    static SEEDS: std::sync::OnceLock<Vec<SeedEntry>> = std::sync::OnceLock::new();
    SEEDS.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../packages/plugin/src/hooks/magic-context/tokenizer-calibration-seeds.json"
        ))
        .expect("compiled static calibration table")
    })
}

fn lineage(model: &str) -> Option<(String, Vec<u64>, String)> {
    let tokens: Vec<_> = model.split('-').collect();
    let numeric = |token: &str| {
        !token.is_empty()
            && token
                .split('.')
                .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
    };
    let at = tokens.iter().position(|token| numeric(token))?;
    if at == 0 {
        return None;
    }
    let mut end = at;
    let mut version = Vec::new();
    while end < tokens.len() && numeric(tokens[end]) {
        for part in tokens[end].split('.') {
            version.push(part.parse().ok()?);
        }
        end += 1;
    }
    Some((tokens[..at].join("-"), version, tokens[end..].join("-")))
}
fn version_order(a: &[u64], b: &[u64]) -> std::cmp::Ordering {
    for i in 0..a.len().max(b.len()) {
        let order = a.get(i).unwrap_or(&0).cmp(b.get(i).unwrap_or(&0));
        if order != std::cmp::Ordering::Equal {
            return order;
        }
    }
    std::cmp::Ordering::Equal
}

fn canonical_provider(model: &str) -> &'static str {
    if model.starts_with("claude-") {
        "anthropic"
    } else if model.starts_with("gpt-") {
        "openai"
    } else if model.starts_with("gemini-") {
        "google"
    } else {
        ""
    }
}

fn family_seed(provider: &str, model: &str) -> Option<&'static SeedEntry> {
    let (family, version, variant) = lineage(model)?;
    let mut below: Option<(&SeedEntry, Vec<u64>)> = None;
    let mut above: Option<(&SeedEntry, Vec<u64>)> = None;
    for entry in seeds() {
        let Some(seed_model) = entry.prefix.strip_prefix(&format!("{provider}/")) else {
            continue;
        };
        let Some((f, v, kind)) = lineage(seed_model) else {
            continue;
        };
        if f != family || kind != variant {
            continue;
        }
        match version_order(&v, &version) {
            std::cmp::Ordering::Less
                if below
                    .as_ref()
                    .is_none_or(|(_, old)| version_order(&v, old).is_gt()) =>
            {
                below = Some((entry, v))
            }
            std::cmp::Ordering::Greater
                if above
                    .as_ref()
                    .is_none_or(|(_, old)| version_order(&v, old).is_lt()) =>
            {
                above = Some((entry, v))
            }
            _ => {}
        }
    }
    let original = below.or(above);
    if original.as_ref().is_some_and(|(_, v)| v[0] != version[0])
        && !canonical_provider(model).is_empty()
    {
        // Same-generation measurements avoid inheriting a previous tokenizer generation.
        let mut sibling: Option<(&SeedEntry, Vec<u64>)> = None;
        for entry in seeds() {
            let Some(seed_model) = entry.prefix.strip_prefix(&format!("{provider}/")) else {
                continue;
            };
            let Some((f, v, kind)) = lineage(seed_model) else {
                continue;
            };
            if v[0] != version[0]
                || kind != variant
                || f.split('-').next() != family.split('-').next()
            {
                continue;
            }
            let replace = sibling.as_ref().is_none_or(|(_, old)| {
                (version_order(&v, &version).is_le() && version_order(old, &version).is_gt())
                    || (version_order(&v, &version).is_le() && version_order(&v, old).is_gt())
                    || (version_order(old, &version).is_gt() && version_order(&v, old).is_lt())
            });
            if replace {
                sibling = Some((entry, v));
            }
        }
        return sibling.or(original).map(|(entry, _)| entry);
    }
    original.map(|(entry, _)| entry)
}

fn selected_seed(key: &str) -> (Option<&'static SeedEntry>, &'static str) {
    let table = seeds();
    let direct = table
        .iter()
        .filter(|entry| key.starts_with(&entry.prefix))
        .max_by_key(|entry| entry.prefix.len());
    if let Some(seed) = direct {
        return (Some(seed), "seed");
    }
    let Some((provider, model)) = key.split_once('/') else {
        return (None, "seed");
    };
    if table
        .iter()
        .any(|entry| entry.prefix.starts_with(&format!("{provider}/")))
    {
        let inherited = family_seed(provider, model);
        return (
            inherited,
            if inherited.is_some() {
                "family-fallback"
            } else {
                "seed"
            },
        );
    }
    // Providers without measurements can reuse a model measurement; prefer its
    // canonical provider over a relay when model prefixes have equal length.
    let canonical = canonical_provider(model);
    let mut direct_model: Option<&SeedEntry> = None;
    for entry in table {
        let Some((_, seed_model)) = entry.prefix.split_once('/') else {
            continue;
        };
        if !model.starts_with(seed_model) {
            continue;
        }
        let previous_len =
            direct_model.map_or(0, |seed| seed.prefix.split_once('/').unwrap().1.len());
        if seed_model.len() > previous_len
            || (seed_model.len() == previous_len
                && entry.prefix.starts_with(&format!("{canonical}/"))
                && !direct_model
                    .is_some_and(|seed| seed.prefix.starts_with(&format!("{canonical}/"))))
        {
            direct_model = Some(entry);
        }
    }
    let selected = direct_model.or_else(|| {
        if canonical.is_empty() {
            None
        } else {
            family_seed(canonical, model)
        }
    });
    (
        selected,
        if selected.is_some() {
            "model-id"
        } else {
            "seed"
        },
    )
}

/// Report whether the measurement was direct, inherited, or matched by model id.
pub fn seed_source(model_key: Option<&str>) -> &'static str {
    selected_seed(&model_key.unwrap_or("").to_lowercase()).1
}

impl DecisionCalibration {
    /// Match provider prefixes first, then inherited family or same-generation
    /// sibling seeds. Providers without seeds can match the model id alone.
    pub fn for_model(model_key: Option<&str>) -> Self {
        let key = model_key.unwrap_or("").to_lowercase();
        let table = seeds();
        let selected = selected_seed(&key).0;
        Self {
            system_ratio: selected.map_or(1.0, |s| s.system_ratio),
            tools_ratio: selected.map_or(1.0, |s| s.tools_ratio),
            prose_ratio: selected.map_or(1.0, |s| s.prose_ratio),
            seeded: selected.is_some(),
            unknown_fit_ratio: table
                .iter()
                .flat_map(|s| [s.system_ratio, s.tools_ratio, s.prose_ratio])
                .fold(2.0, f64::max),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    // Geometry vectors generated with Bun 1.4.2 from deriveWindowGeometry in
    // packages/plugin/src/shared/window-geometry.ts at 282d9c08bce4. Inputs and
    // complete results are frozen together; Rust never generates expectations.
    const GEOMETRY_VECTORS: &str = r#"
{"name":"missing","provider":"custom","catalog":null,"options":{},"expected":null}
{"name":"overlay-only","provider":"custom","catalog":null,"options":{"overlay":{"facts":{"window.enforced":{"value":{"kind":"stated","value":200000}}}}},"expected":null}
{"name":"input-only","provider":"custom","catalog":{"input":120000},"options":{},"expected":{"usableSoft":120000,"usableHard":120000,"geometry":"shared_upfront","derivation":{"window":120000,"reserve":0,"reserveSource":"none","geometry":"shared_upfront","windowSource":"catalog","absoluteWall":120000}}}
{"name":"invalid","provider":"custom","catalog":{"context":0,"input":-1,"output":0},"options":{},"expected":null}
{"name":"upfront","provider":"openai","catalog":{"context":200000,"output":32000},"options":{},"expected":{"usableSoft":168000,"usableHard":168000,"geometry":"shared_upfront","derivation":{"window":200000,"reserve":32000,"reserveSource":"output_catalog","geometry":"shared_upfront","windowSource":"catalog","absoluteWall":200000}}}
{"name":"truncating","provider":"anthropic","catalog":{"context":1000000,"output":128000},"options":{},"expected":{"usableSoft":872000,"usableHard":995904,"geometry":"shared_truncating","derivation":{"window":1000000,"reserve":128000,"reserveSource":"output_catalog","geometry":"shared_truncating","windowSource":"catalog","absoluteWall":1000000}}}
{"name":"separate","provider":"google","catalog":{"context":1000000,"output":65536},"options":{},"expected":{"usableSoft":1000000,"usableHard":1000000,"geometry":"separate","derivation":{"window":1000000,"reserve":0,"reserveSource":"none","geometry":"separate","windowSource":"catalog","absoluteWall":1000000}}}
{"name":"placeholder-legacy","provider":"xai","catalog":{"context":500000,"output":500000},"options":{},"expected":{"usableSoft":375000,"usableHard":495904,"geometry":"shared_truncating","derivation":{"window":500000,"reserve":125000,"reserveSource":"output_catalog","geometry":"shared_truncating","windowSource":"catalog","absoluteWall":500000}}}
{"name":"placeholder-filtered","provider":"xai","catalog":{"context":500000,"output":500000},"options":{"overlay":{"facts":{}}},"expected":{"usableSoft":500000,"usableHard":500000,"geometry":"shared_truncating","derivation":{"window":500000,"reserve":0,"reserveSource":"none","geometry":"shared_truncating","windowSource":"catalog","absoluteWall":500000}}}
{"name":"unknown-geometry","provider":"google","catalog":{"context":1048576,"output":65536},"options":{"overlay":{"facts":{"geometry":{"value":{"kind":"unknown","why":"never_measured"}}}}},"expected":{"usableSoft":1016576,"usableHard":1016576,"geometry":"shared_upfront","derivation":{"window":1048576,"reserve":32000,"reserveSource":"output_catalog","geometry":"shared_upfront","windowSource":"catalog","absoluteWall":1048576}}}
{"name":"absent-geometry","provider":"google","catalog":{"context":1048576,"output":65536},"options":{"overlay":{"facts":{}}},"expected":{"usableSoft":1016576,"usableHard":1048576,"geometry":"separate","derivation":{"window":1048576,"reserve":32000,"reserveSource":"output_catalog","geometry":"separate","windowSource":"catalog","absoluteWall":1048576}}}
{"name":"explicit-separate","provider":"custom","catalog":{"context":1048576,"output":65536},"options":{"overlay":{"facts":{"geometry":{"value":{"kind":"stated","value":"separate"}}}}},"expected":{"usableSoft":1048576,"usableHard":1048576,"geometry":"separate","derivation":{"window":1048576,"reserve":0,"reserveSource":"none","geometry":"separate","windowSource":"catalog","absoluteWall":1048576}}}
{"name":"bracket","provider":"custom","catalog":{"context":200000,"output":10000},"options":{"overlay":{"facts":{"window.advertised":{"value":{"kind":"bracket","at_least":300000,"below":400000}}}}},"expected":{"usableSoft":290000,"usableHard":290000,"geometry":"shared_upfront","derivation":{"window":300000,"reserve":10000,"reserveSource":"output_catalog","geometry":"shared_upfront","windowSource":"overlay","absoluteWall":300000}}}
{"name":"upper-only","provider":"custom","catalog":{"context":200000},"options":{"overlay":{"facts":{"window.enforced":{"value":{"kind":"bracket","below":300000}}}}},"expected":{"usableSoft":200000,"usableHard":200000,"geometry":"shared_upfront","derivation":{"window":200000,"reserve":0,"reserveSource":"none","geometry":"shared_upfront","windowSource":"catalog","absoluteWall":200000}}}
{"name":"overlay","provider":"custom","catalog":{"context":200000,"output":10000},"options":{"overlay":{"facts":{"window.enforced":{"value":{"kind":"stated","value":300000}},"output.enforced":{"value":{"kind":"stated","value":20000}}}}},"expected":{"usableSoft":280000,"usableHard":280000,"geometry":"shared_upfront","derivation":{"window":300000,"reserve":20000,"reserveSource":"output_catalog","geometry":"shared_upfront","windowSource":"overlay","absoluteWall":300000}}}
{"name":"provider","provider":"custom","catalog":{"context":200000,"output":10000},"options":{"overlay":{"facts":{"window.enforced":{"value":{"kind":"stated","value":300000}},"output.enforced":{"value":{"kind":"stated","value":20000}}}},"providerLimit":{"context":400000,"output":30000}},"expected":{"usableSoft":370000,"usableHard":370000,"geometry":"shared_upfront","derivation":{"window":400000,"reserve":30000,"reserveSource":"output_catalog","geometry":"shared_upfront","windowSource":"provider","absoluteWall":400000}}}
{"name":"cap","provider":"custom","catalog":{"context":200000,"output":10000},"options":{"providerLimit":{"context":400000},"contextCap":100000},"expected":{"usableSoft":90000,"usableHard":90000,"geometry":"shared_upfront","derivation":{"window":100000,"reserve":10000,"reserveSource":"output_catalog","geometry":"shared_upfront","windowSource":"detected","absoluteWall":100000}}}
{"name":"cap-above","provider":"custom","catalog":{"context":200000,"output":10000},"options":{"contextCap":400000},"expected":{"usableSoft":190000,"usableHard":190000,"geometry":"shared_upfront","derivation":{"window":200000,"reserve":10000,"reserveSource":"output_catalog","geometry":"shared_upfront","windowSource":"detected","absoluteWall":200000}}}
{"name":"pre-carved","provider":"anthropic","catalog":{"context":1000000,"input":900000,"output":128000},"options":{},"expected":{"usableSoft":900000,"usableHard":995904,"geometry":"shared_truncating","derivation":{"window":1000000,"reserve":100000,"reserveSource":"output_catalog","geometry":"shared_truncating","windowSource":"catalog","absoluteWall":1000000}}}
{"name":"override","provider":"openai-codex","catalog":{"context":400000,"input":272000,"output":128000},"options":{"outputReserveOverride":16384,"overlay":{"facts":{"output.enforced":{"value":{"kind":"stated","value":68000}}}}},"expected":{"usableSoft":255616,"usableHard":368000,"geometry":"shared_upfront","derivation":{"window":272000,"reserve":16384,"reserveSource":"output_config","geometry":"shared_upfront","windowSource":"catalog","absoluteWall":400000}}}
{"name":"zero-reserve","provider":"google","catalog":{"context":200000,"output":65536},"options":{"outputReserveOverride":0},"expected":{"usableSoft":200000,"usableHard":200000,"geometry":"separate","derivation":{"window":200000,"reserve":0,"reserveSource":"output_config","geometry":"separate","windowSource":"catalog","absoluteWall":200000}}}
{"name":"floor","provider":"custom","catalog":{"context":200000},"options":{"outputReserveOverride":190000},"expected":{"usableSoft":100000,"usableHard":168000,"geometry":"shared_upfront","derivation":{"window":200000,"reserve":100000,"reserveSource":"output_config","geometry":"shared_upfront","windowSource":"catalog","absoluteWall":200000}}}
{"name":"tiny","provider":"custom","catalog":{"context":512,"output":128},"options":{},"expected":{"usableSoft":512,"usableHard":1024,"geometry":"shared_upfront","derivation":{"window":512,"reserve":0,"reserveSource":"output_catalog","geometry":"shared_upfront","windowSource":"catalog","absoluteWall":512}}}
{"name":"pi","provider":"custom","catalog":{"context":272000,"output":128000},"options":{"harness":"pi"},"expected":{"usableSoft":204000,"usableHard":267904,"geometry":"shared_upfront","derivation":{"window":272000,"reserve":68000,"reserveSource":"output_catalog","geometry":"shared_upfront","windowSource":"catalog","absoluteWall":272000}}}
{"name":"codex-pi","provider":"openai-codex","catalog":{"context":272000,"output":128000},"options":{"providerLimit":{"context":272000},"harness":"pi"},"expected":{"usableSoft":204000,"usableHard":204000,"geometry":"shared_upfront","derivation":{"window":272000,"reserve":68000,"reserveSource":"output_catalog","geometry":"shared_upfront","windowSource":"provider","absoluteWall":272000}}}
{"name":"inversion","provider":"custom","catalog":{"context":200000,"input":190000,"output":10000},"options":{"providerLimit":{"context":192000,"input":190000,"output":10000}},"expected":{"usableSoft":190000,"usableHard":190000,"geometry":"shared_upfront","derivation":{"window":192000,"reserve":2000,"reserveSource":"output_catalog","geometry":"shared_upfront","windowSource":"provider","absoluteWall":192000}}}
{"name":"output-default","provider":"custom","catalog":{"context":1048576,"output":1048576},"options":{"overlay":{"facts":{"output.default":{"value":{"kind":"stated","value":65536}}}}},"expected":{"usableSoft":1016576,"usableHard":1016576,"geometry":"shared_upfront","derivation":{"window":1048576,"reserve":32000,"reserveSource":"output_catalog","geometry":"shared_upfront","windowSource":"catalog","absoluteWall":1048576}}}
{"name":"invalid-provider","provider":"custom","catalog":{"context":200000,"output":20000},"options":{"providerLimit":{"context":0,"input":-1,"output":200000},"outputReserveOverride":-1},"expected":{"usableSoft":180000,"usableHard":180000,"geometry":"shared_upfront","derivation":{"window":200000,"reserve":20000,"reserveSource":"output_catalog","geometry":"shared_upfront","windowSource":"catalog","absoluteWall":200000}}}
{"name":"fractional","provider":"custom","catalog":{"context":200000.8,"input":190000.4,"output":10000.6},"options":{},"expected":{"usableSoft":190000.4,"usableHard":190000.4,"geometry":"shared_upfront","derivation":{"window":200000,"reserve":10000,"reserveSource":"output_catalog","geometry":"shared_upfront","windowSource":"catalog","absoluteWall":200000}}}
"#;

    #[derive(Deserialize)]
    struct GeometryVector {
        name: String,
        provider: String,
        catalog: Option<ModelWindowLimit>,
        options: WindowGeometryOptions,
        expected: Option<WindowGeometryResult>,
    }

    #[test]
    fn geometry_matches_pinned_typescript() {
        let mut count = 0;
        for line in GEOMETRY_VECTORS.lines().filter(|line| !line.is_empty()) {
            let vector: GeometryVector = serde_json::from_str(line).unwrap();
            assert_eq!(
                derive_window_geometry(&vector.provider, vector.catalog, &vector.options),
                vector.expected,
                "{}",
                vector.name
            );
            count += 1;
        }
        assert_eq!(count, 29);
    }

    #[test]
    fn input_proof_matches_pinned_typescript() {
        // Accepted-input proof vectors from applyProvenInputFloor in
        // packages/plugin/src/shared/window-geometry.ts at 282d9c08bce4.
        let trusted: WindowGeometryResult = serde_json::from_str(r#"{"usableSoft":204000,"usableHard":204000,"geometry":"shared_upfront","derivation":{"window":272000,"reserve":68000,"reserveSource":"output_catalog","geometry":"shared_upfront","windowSource":"provider","absoluteWall":272000}}"#).unwrap();
        let within: ProvenInputFloorResult = serde_json::from_str(r#"{"geometry":{"usableSoft":255834,"usableHard":204000,"geometry":"shared_upfront","derivation":{"window":272000,"reserve":16166,"reserveSource":"output_catalog","geometry":"shared_upfront","windowSource":"provider","absoluteWall":272000,"provenInputTokens":255834}}}"#).unwrap();
        let beyond: ProvenInputFloorResult = serde_json::from_str(r#"{"geometry":{"usableSoft":204000,"usableHard":204000,"geometry":"shared_upfront","derivation":{"window":272000,"reserve":68000,"reserveSource":"output_catalog","geometry":"shared_upfront","windowSource":"provider","absoluteWall":272000}},"refused":{"reading":593717,"absoluteWall":272000}}"#).unwrap();
        assert_eq!(apply_proven_input_floor(trusted, Some(255_834.0)), within);
        assert_eq!(apply_proven_input_floor(trusted, Some(593_717.0)), beyond);
        let catalog: WindowGeometryResult = serde_json::from_str(r#"{"usableSoft":30000,"usableHard":30000,"geometry":"shared_upfront","derivation":{"window":30000,"reserve":0,"reserveSource":"none","geometry":"shared_upfront","windowSource":"catalog","absoluteWall":30000}}"#).unwrap();
        let escaped: ProvenInputFloorResult = serde_json::from_str(r#"{"geometry":{"usableSoft":90000,"usableHard":90000,"geometry":"shared_upfront","derivation":{"window":90000,"reserve":0,"reserveSource":"none","geometry":"shared_upfront","windowSource":"catalog","absoluteWall":90000,"provenInputTokens":90000}}}"#).unwrap();
        assert_eq!(apply_proven_input_floor(catalog, Some(90_000.0)), escaped);
        for source in [
            WindowLimitSource::Provider,
            WindowLimitSource::Overlay,
            WindowLimitSource::Detected,
        ] {
            let mut wall = trusted;
            wall.derivation.window_source = source;
            let mut expected = beyond;
            expected.geometry = wall;
            assert_eq!(apply_proven_input_floor(wall, Some(593_717.0)), expected);
        }
        for reading in [
            None,
            Some(0.0),
            Some(1023.0),
            Some(200_000.0),
            Some(f64::NAN),
            Some(f64::INFINITY),
        ] {
            assert_eq!(
                apply_proven_input_floor(trusted, reading),
                ProvenInputFloorResult {
                    geometry: trusted,
                    refused: None
                }
            );
        }
    }

    #[test]
    fn profile_accounting_matches_pinned_typescript() {
        // Display-bucket vectors generated with Bun 1.4.2 from calibrateBuckets
        // in packages/plugin/src/hooks/magic-context/tokenizer-calibration.ts
        // at 282d9c08bce4. Distinct prose ratios and clamp cases distinguish
        // profile attribution from system/tool calibration.
        let vectors = r#"
{"name":"profile-prose","ratios":[1.5,1.2,1.1],"input":{"inputTokens":10000,"systemLocal":100,"toolDefsLocal":200,"compartmentsLocal":300,"factsLocal":400,"memoriesLocal":500,"docsLocal":600,"profileLocal":700,"conversationLocal":800,"toolCallsLocal":900},"expected":{"systemTokens":150,"toolDefinitionTokens":240,"compartmentTokens":330,"factTokens":440,"memoryTokens":550,"docsTokens":660,"profileTokens":770,"conversationTokens":3228,"toolCallTokens":3632}}
{"name":"clamp","ratios":[1.5,1.2,1.1],"input":{"inputTokens":100,"systemLocal":100,"toolDefsLocal":200,"compartmentsLocal":300,"factsLocal":400,"memoriesLocal":500,"docsLocal":600,"profileLocal":700,"conversationLocal":800,"toolCallsLocal":900},"expected":{"systemTokens":5,"toolDefinitionTokens":8,"compartmentTokens":11,"factTokens":14,"memoryTokens":18,"docsTokens":21,"profileTokens":23,"conversationTokens":0,"toolCallTokens":0}}
{"name":"tiny-ties","ratios":[1,1,1],"input":{"inputTokens":4,"systemLocal":1,"toolDefsLocal":1,"compartmentsLocal":1,"factsLocal":1,"memoriesLocal":1,"docsLocal":1,"profileLocal":1,"conversationLocal":800,"toolCallsLocal":900},"expected":{"systemTokens":0,"toolDefinitionTokens":0,"compartmentTokens":0,"factTokens":1,"memoryTokens":1,"docsTokens":1,"profileTokens":1,"conversationTokens":0,"toolCallTokens":0}}
{"name":"profile-largest","ratios":[1,1,1],"input":{"inputTokens":3,"systemLocal":1,"toolDefsLocal":1,"compartmentsLocal":1,"factsLocal":1,"memoriesLocal":1,"docsLocal":1,"profileLocal":3,"conversationLocal":800,"toolCallsLocal":900},"expected":{"systemTokens":0,"toolDefinitionTokens":0,"compartmentTokens":0,"factTokens":0,"memoryTokens":0,"docsTokens":0,"profileTokens":1,"conversationTokens":1,"toolCallTokens":1}}
{"name":"no-residual","ratios":[1.5,1.2,1.1],"input":{"inputTokens":10000,"systemLocal":100,"toolDefsLocal":200,"compartmentsLocal":300,"factsLocal":400,"memoriesLocal":500,"docsLocal":600,"profileLocal":700,"conversationLocal":0,"toolCallsLocal":0},"expected":{"systemTokens":150,"toolDefinitionTokens":240,"compartmentTokens":330,"factTokens":440,"memoryTokens":550,"docsTokens":660,"profileTokens":770,"conversationTokens":6860,"toolCallTokens":0}}
{"name":"residual-round","ratios":[1,1,1],"input":{"inputTokens":2801,"systemLocal":100,"toolDefsLocal":200,"compartmentsLocal":300,"factsLocal":400,"memoriesLocal":500,"docsLocal":600,"profileLocal":700,"conversationLocal":1,"toolCallsLocal":1},"expected":{"systemTokens":100,"toolDefinitionTokens":200,"compartmentTokens":300,"factTokens":400,"memoryTokens":500,"docsTokens":600,"profileTokens":700,"conversationTokens":0,"toolCallTokens":1}}
{"name":"negative-prose","ratios":[1,1,1],"input":{"inputTokens":10000,"systemLocal":100,"toolDefsLocal":200,"compartmentsLocal":-1,"factsLocal":-1,"memoriesLocal":-1,"docsLocal":-1,"profileLocal":-1,"conversationLocal":800,"toolCallsLocal":900},"expected":{"systemTokens":100,"toolDefinitionTokens":200,"compartmentTokens":0,"factTokens":0,"memoryTokens":0,"docsTokens":0,"profileTokens":0,"conversationTokens":4565,"toolCallTokens":5135}}
{"name":"empty","ratios":[1.5,1.2,1.1],"input":{"inputTokens":0,"systemLocal":100,"toolDefsLocal":200,"compartmentsLocal":300,"factsLocal":400,"memoriesLocal":500,"docsLocal":600,"profileLocal":700,"conversationLocal":800,"toolCallsLocal":900},"expected":{"systemTokens":0,"toolDefinitionTokens":0,"compartmentTokens":0,"factTokens":0,"memoryTokens":0,"docsTokens":0,"profileTokens":0,"conversationTokens":0,"toolCallTokens":0}}
"#;
        #[derive(Deserialize)]
        struct Vector {
            name: String,
            ratios: [f64; 3],
            input: CalibrationInput,
            expected: CalibratedBuckets,
        }
        let mut count = 0;
        for line in vectors.lines().filter(|line| !line.is_empty()) {
            let vector: Vector = serde_json::from_str(line).unwrap();
            let [system_ratio, tools_ratio, prose_ratio] = vector.ratios;
            let calibration = DecisionCalibration {
                system_ratio,
                tools_ratio,
                prose_ratio,
                seeded: true,
                unknown_fit_ratio: 2.0,
            };
            let actual = calibrate_buckets(vector.input, calibration);
            assert_eq!(actual, vector.expected, "{}", vector.name);
            let sum: f64 = serde_json::to_value(actual)
                .unwrap()
                .as_object()
                .unwrap()
                .values()
                .map(|value| value.as_f64().unwrap())
                .sum();
            assert_eq!(sum, vector.input.input_tokens, "{}", vector.name);
            count += 1;
        }
        assert_eq!(count, 8);
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        system_ratio: f64,
        tools_ratio: f64,
        prose_ratio: f64,
        raw_system: f64,
        raw_tools: f64,
        raw_prose: f64,
        provider_mass: f64,
        provider_budget: f64,
        local_budget: f64,
    }

    #[derive(Deserialize)]
    struct ResolverCase {
        provider: String,
        model: String,
        prefix: Option<String>,
        source: String,
    }

    #[test]
    fn resolves_shared_model_and_provider_cases() {
        let cases: Vec<ResolverCase> = serde_json::from_str(include_str!(
            "../../../tests/fixtures/calibration-resolver.json"
        ))
        .unwrap();
        for case in cases {
            let key = format!("{}/{}", case.provider, case.model);
            let result = DecisionCalibration::for_model(Some(&key));
            let expected = case
                .prefix
                .as_ref()
                .map(|prefix| seeds().iter().find(|seed| &seed.prefix == prefix).unwrap());
            assert_eq!(
                result.system_ratio,
                expected.map_or(1.0, |s| s.system_ratio),
                "{key}"
            );
            assert_eq!(
                result.tools_ratio,
                expected.map_or(1.0, |s| s.tools_ratio),
                "{key}"
            );
            assert_eq!(
                result.prose_ratio,
                expected.map_or(1.0, |s| s.prose_ratio),
                "{key}"
            );
            assert_eq!(result.seeded, expected.is_some(), "{key}");
            assert_eq!(seed_source(Some(&key)), case.source, "{key}");
            let frozen = DecisionCalibration::freeze_for_model(Some(&key));
            assert_eq!(frozen.source, case.source, "{key}");
            let thawed = DecisionCalibration::from_frozen(&frozen).unwrap();
            assert_eq!(thawed.system_ratio, result.system_ratio, "{key}");
            assert_eq!(thawed.seeded, result.seeded, "{key}");
        }
    }

    #[test]
    fn sol_seeds_price_reported_prompt_without_unknown_fit_inflation() {
        for key in ["openai/gpt-6-sol", "openai/gpt-6.1-sol"] {
            let seed = DecisionCalibration::for_model(Some(key));
            assert!(seed.seeded, "{key}");
            assert_eq!(seed_source(Some(key)), "seed", "{key}");
            assert_eq!(
                seed.provider_mass(
                    LocalMass {
                        system: 8000.0,
                        tools: 0.0,
                        prose: 192000.0
                    },
                    true
                ),
                200006.0,
                "{key}"
            );
        }
        let unknown = DecisionCalibration::for_model(Some("openai/gpt-6-madeup"));
        assert!(!unknown.seeded);
        assert_eq!(
            unknown.provider_mass(
                LocalMass {
                    system: 8000.0,
                    tools: 0.0,
                    prose: 192000.0
                },
                true
            ),
            400000.0
        );
    }

    #[test]
    fn shares_independent_fable_arithmetic_with_typescript() {
        let fixture: Fixture = serde_json::from_str(include_str!(
            "../../../tests/fixtures/decision-calibration.json"
        ))
        .unwrap();
        let seed = DecisionCalibration {
            system_ratio: fixture.system_ratio,
            tools_ratio: fixture.tools_ratio,
            prose_ratio: fixture.prose_ratio,
            seeded: true,
            unknown_fit_ratio: 2.0,
        };
        assert_eq!(
            seed.provider_mass(
                LocalMass {
                    system: fixture.raw_system,
                    tools: fixture.raw_tools,
                    prose: fixture.raw_prose,
                },
                true
            ),
            fixture.provider_mass
        );
        assert_eq!(
            local_budget(fixture.provider_budget, seed.prose_ratio),
            fixture.local_budget
        );
    }

    #[test]
    fn frozen_revision_survives_restart_and_changes_only_at_the_next_bust() {
        let frozen = FrozenDecisionCalibration {
            revision: "frozen-family-v1".to_string(),
            provider_id: "anthropic".to_string(),
            model_id: "claude-fable-5-1".to_string(),
            system_ratio: 1.511497,
            tools_ratio: 1.551639,
            prose_ratio: 1.571778,
            source: "seed".to_string(),
        };
        let mut meta = mc_store::ModuleMeta {
            decision_calibration: Some(frozen.clone()),
            ..Default::default()
        };
        let restarted: mc_store::ModuleMeta =
            serde_json::from_str(&serde_json::to_string(&meta).unwrap()).unwrap();
        let defer =
            DecisionCalibration::from_frozen(restarted.decision_calibration.as_ref().unwrap())
                .unwrap();
        assert_eq!(defer.tools_ratio, 1.551639);
        assert_eq!(
            restarted.decision_calibration.unwrap().revision,
            "frozen-family-v1"
        );

        let adopted = DecisionCalibration::freeze_for_model(Some("unknown/new-model"));
        meta.decision_calibration = Some(adopted.clone());
        assert_eq!(adopted.revision, CALIBRATION_TABLE_REVISION);
        assert_eq!(
            DecisionCalibration::from_frozen(&adopted)
                .unwrap()
                .tools_ratio,
            1.0
        );
    }

    #[test]
    fn unknown_fit_is_conservative_while_decisions_stay_neutral() {
        let seed = DecisionCalibration {
            system_ratio: 1.0,
            tools_ratio: 1.0,
            prose_ratio: 1.0,
            seeded: false,
            unknown_fit_ratio: 2.0,
        };
        let raw = LocalMass {
            prose: 1000.0,
            ..Default::default()
        };
        assert_eq!(seed.provider_mass(raw, false), 1000.0);
        assert_eq!(seed.provider_mass(raw, true), 2000.0);
        assert_eq!(
            seed.provider_mass(
                LocalMass {
                    prose: f64::NAN,
                    ..raw
                },
                true
            ),
            f64::INFINITY
        );
        assert_eq!(local_budget(100.0, 0.0), 0.0);
    }
}
