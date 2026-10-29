//! Byte parity with real TypeScript builders, independently of Rust's assets.
use std::sync::OnceLock;

use mc_module::config::McModuleConfig;
use mc_module::prompt_surface::{
    catalog_for_config, compose_guidance, guidance_asset, primary_language_directive,
    session_tools_for_config, GuidanceVariant, PromptSurfacePreset, PromptSurfaceSelection,
};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
struct ToolCase {
    preset: PromptSurfacePreset,
    smart: bool,
    tools: Vec<Value>,
}

#[derive(Deserialize)]
struct Language {
    code: String,
    directive: String,
}

#[derive(Deserialize)]
struct Extra {
    mask: usize,
    preset: PromptSurfacePreset,
    language: String,
    denied: bool,
    #[serde(rename = "override")]
    primary_override: Option<String>,
    text: [usize; 2],
}

#[derive(Deserialize)]
struct Golden {
    known_divergences: Value,
    tools: Vec<ToolCase>,
    languages: Vec<Language>,
    rejected: Vec<String>,
    strings: Vec<String>,
    guidance_cases: Vec<[usize; 5]>,
    extras: Vec<Extra>,
    catalog_tools_only: Vec<[usize; 5]>,
    catalog_tools_only_descriptions: Value,
}

fn golden() -> &'static Golden {
    static GOLDEN: OnceLock<Golden> = OnceLock::new();
    GOLDEN.get_or_init(|| {
        let golden: Golden =
            serde_json::from_str(include_str!("../testdata/tool_surfaces/golden.json")).unwrap();
        validate_known_divergences(&golden.known_divergences).unwrap();
        golden
    })
}

fn known_divergences() -> Value {
    // TypeScript advertises drop as optional, but execution refuses missing drop.
    // Preserve Rust's required drop because the Claude Code gateway
    // requires this exact four-key schema before it authorizes reduction.
    json!([{
        "name": "ctx_reduce.drop_requiredness",
        "tool": "ctx_reduce",
        "field": "input_schema.required",
        "typescript": { "present": false },
        "rust": { "present": true, "value": ["drop"] },
        "reason": "TypeScript's builder is wrong and will be changed to required: [\"drop\"]. Execution already refuses missing drop; the Claude Code gateway requires the four-key schema."
    }])
}

fn validate_known_divergences(actual: &Value) -> Result<(), String> {
    if actual != &known_divergences() {
        return Err("expected exactly the named ctx_reduce.drop_requiredness divergence".into());
    }
    Ok(())
}

fn compare_schema(name: &str, actual: &Value, expected: &Value) -> Result<(), String> {
    let mut comparable = actual.clone();
    if name == "ctx_reduce" {
        if actual.get("required") != Some(&json!(["drop"])) {
            return Err("ctx_reduce.drop_requiredness disappeared or changed on Rust".into());
        }
        if expected.get("required").is_some() {
            return Err("ctx_reduce.drop_requiredness disappeared or changed on TypeScript".into());
        }
        let properties = comparable.as_object_mut().ok_or("expected schema object")?;
        if properties.len() != 4 {
            return Err("ctx_reduce must advertise exactly four schema keys".into());
        }
        properties.remove("required");
    }
    // Only the checked, named requiredness difference is omitted. Preserve all
    // other fields, constraints, enum ordering and parameter-description bytes.
    if serde_jcs::to_vec(&comparable).unwrap() != serde_jcs::to_vec(expected).unwrap() {
        return Err(format!("unexpected schema divergence for {name}"));
    }
    Ok(())
}

fn config(mask: usize, language: &str, preset: PromptSurfacePreset) -> McModuleConfig {
    let on = |bit: u32| mask & (1usize << bit) != 0;
    let mut config = McModuleConfig {
        memory_enabled: on(0),
        temporal_awareness: on(2),
        smart_notes_enabled: on(4),
        compaction_enabled: on(6),
        language: (!language.is_empty()).then(|| language.to_string()),
        ..Default::default()
    };
    config.caveman.enabled = on(3);
    config.catalog.dreamer_runnable = on(1);
    config.catalog.prompt_surface_default = Some(preset.as_str().to_string());
    config
}

fn catalog_request(config: &McModuleConfig, subagent: bool, denied: bool) -> Value {
    let compacting = config.compaction_enabled;
    let role = if subagent { "worker" } else { "head" };
    let mut names = if subagent && !compacting {
        Vec::new()
    } else if subagent {
        vec!["ctx_reduce", "ctx_expand", "ctx_search"]
    } else if compacting {
        vec![
            "ctx_reduce",
            "ctx_expand",
            "ctx_note",
            "ctx_memory",
            "ctx_search",
        ]
    } else {
        vec!["ctx_search", "ctx_memory", "ctx_note"]
    };
    names.retain(|name| {
        !(*name == "ctx_reduce" && denied || *name == "ctx_memory" && !config.memory_enabled)
    });
    let mut composition = json!({
        "providers": [{"provider": "magic-context", "tools": names.iter().map(|name| json!({"name": name})).collect::<Vec<_>>()}]
    });
    if compacting {
        composition["compaction"] = json!({"provider": "magic-context"});
    }
    json!({
        "preset": role,
        "params": {"exclude": if denied {vec!["ctx_reduce"]} else {vec![]}},
        "composition": composition,
        "system_text": {"preset": role, "params": {}}
    })
}

fn expected_text(pair: [usize; 2]) -> String {
    let golden = golden();
    format!("{}{}", golden.strings[pair[0]], golden.strings[pair[1]])
}

fn catalog_tools_only_text(config: &McModuleConfig, preset: PromptSurfacePreset) -> String {
    let golden = golden();
    let flags = usize::from(config.memory_enabled)
        | (usize::from(config.catalog.dreamer_runnable && config.smart_notes_enabled) << 1)
        | (usize::from(config.temporal_awareness) << 2)
        | (usize::from(config.caveman.enabled) << 3);
    let surface = usize::from(preset == PromptSurfacePreset::Light);
    let language = golden
        .languages
        .iter()
        .position(|language| language.code == config.language.as_deref().unwrap_or_default())
        .unwrap();
    let index = (flags * 2 + surface) * golden.languages.len() + language;
    let [case_flags, case_surface, case_language, prefix, suffix] =
        golden.catalog_tools_only[index];
    assert_eq!(
        [case_flags, case_surface, case_language],
        [flags, surface, language]
    );
    expected_text([prefix, suffix])
}

fn assert_tool(actual: &Value, expected: &Value, context: &str) {
    assert_eq!(actual["name"], expected["name"], "{context}");
    assert_eq!(
        actual["description"].as_str().unwrap().as_bytes(),
        expected["description"].as_str().unwrap().as_bytes(),
        "{context}: description"
    );
    compare_schema(
        actual["name"].as_str().unwrap(),
        &actual["input_schema"],
        &expected["input_schema"],
    )
    .unwrap_or_else(|error| panic!("{context}: {error}"));
}

#[test]
fn requiredness_allowlist_rejects_disappearing_or_extra_divergences() {
    let selection = PromptSurfaceSelection::default();
    let tool = session_tools_for_config(&selection, &config(1 | 16 | 64, "", selection.preset))
        .into_iter()
        .find(|tool| tool.name == "ctx_reduce")
        .unwrap();
    let expected = golden()
        .tools
        .iter()
        .find(|case| case.preset == PromptSurfacePreset::Full && case.smart)
        .unwrap()
        .tools
        .iter()
        .find(|tool| tool["name"] == "ctx_reduce")
        .unwrap()["input_schema"]
        .clone();
    compare_schema("ctx_reduce", &tool.schema, &expected).unwrap();

    let mut rust_optional = tool.schema.clone();
    rust_optional.as_object_mut().unwrap().remove("required");
    assert!(compare_schema("ctx_reduce", &rust_optional, &expected).is_err());
    let mut typescript_fixed = expected.clone();
    typescript_fixed["required"] = json!(["drop"]);
    assert!(compare_schema("ctx_reduce", &tool.schema, &typescript_fixed).is_err());
    let mut extra_required = tool.schema.clone();
    extra_required["required"] = json!(["drop", "other"]);
    assert!(compare_schema("ctx_reduce", &extra_required, &expected).is_err());
    let mut changed_drop = tool.schema.clone();
    changed_drop["properties"]["drop"]["type"] = json!("number");
    assert!(compare_schema("ctx_reduce", &changed_drop, &expected).is_err());
    let mut changed_root = tool.schema.clone();
    changed_root["additionalProperties"] = json!(true);
    assert!(compare_schema("ctx_reduce", &changed_root, &expected).is_err());
    let mut extra_root = tool.schema.clone();
    extra_root["title"] = json!("unexpected");
    assert!(compare_schema("ctx_reduce", &extra_root, &expected).is_err());

    assert!(validate_known_divergences(&json!([])).is_err());
    let mut additional_allowance = known_divergences();
    additional_allowance
        .as_array_mut()
        .unwrap()
        .push(json!({"name": "other"}));
    assert!(validate_known_divergences(&additional_allowance).is_err());
}

#[test]
fn typescript_tool_builders_match_legacy_and_catalog_bytes() {
    for case in &golden().tools {
        let mask = 1 | 64 | if case.smart { 16 } else { 0 };
        let config = config(mask, "", case.preset);
        let selection = PromptSurfaceSelection {
            preset: case.preset,
            ..Default::default()
        };
        let legacy = session_tools_for_config(&selection, &config);
        let catalog = catalog_for_config(&catalog_request(&config, false, false), &config).unwrap();
        assert_eq!(legacy.len(), 5);
        assert_eq!(catalog["tools"].as_array().unwrap().len(), 5);
        for expected in &case.tools {
            let name = expected["name"].as_str().unwrap();
            let tool = legacy.iter().find(|tool| tool.name == name).unwrap();
            let actual = json!({"name": tool.name, "description": tool.description, "input_schema": tool.schema});
            assert_tool(
                &actual,
                expected,
                &format!("legacy {name} {:?} smart={}", case.preset, case.smart),
            );
            let actual = catalog["tools"]
                .as_array()
                .unwrap()
                .iter()
                .find(|tool| tool["name"] == name)
                .unwrap();
            assert_tool(
                actual,
                expected,
                &format!("catalog {name} {:?} smart={}", case.preset, case.smart),
            );
        }
    }
    println!("Compared 20 builder-derived tool schemas/descriptions through both legacy and catalog surfaces");
}

fn assert_guidance(
    mask: usize,
    preset: PromptSurfacePreset,
    language: &str,
    denied: bool,
    primary_override: Option<&str>,
    expected: &str,
) -> bool {
    let subagent = mask & 32 != 0;
    let mut config = config(mask, language, preset);
    config.prompt_surface_guidance_override = primary_override.map(str::to_string);
    let selection = PromptSurfaceSelection {
        preset,
        guidance_override: config.prompt_surface_guidance_override.clone(),
        ..Default::default()
    };
    let composed = compose_guidance(
        &selection,
        &config,
        subagent,
        config.compaction_enabled && !denied,
    );
    assert_eq!(
        composed.as_bytes(),
        expected.as_bytes(),
        "composer mask={mask} preset={preset:?} language={language:?} denied={denied}"
    );
    let answer = catalog_for_config(&catalog_request(&config, subagent, denied), &config).unwrap();
    let tools_only = !config.compaction_enabled && !subagent && primary_override.is_none();
    let catalog_expected = if tools_only {
        catalog_tools_only_text(&config, preset)
    } else {
        expected.to_string()
    };
    if tools_only {
        assert_ne!(
            answer["system_text"]["text"].as_str().unwrap().as_bytes(),
            expected.as_bytes(),
            "non-compacting head must take tools_only/{} instead of standalone no_reduce",
            preset.as_str()
        );
    }
    assert_eq!(
        answer["system_text"]["text"].as_str().unwrap().as_bytes(),
        catalog_expected.as_bytes(),
        "catalog mask={mask} preset={preset:?} language={language:?} denied={denied}"
    );
    let case = golden()
        .tools
        .iter()
        .find(|case| case.preset == preset && case.smart == config.smart_notes_enabled)
        .unwrap();
    for actual in answer["tools"].as_array().unwrap() {
        let expected = case
            .tools
            .iter()
            .find(|tool| tool["name"] == actual["name"])
            .unwrap();
        let mut expected = expected.clone();
        if !config.compaction_enabled && actual["name"] == "ctx_search" {
            expected["description"] =
                golden().catalog_tools_only_descriptions[preset.as_str()]["ctx_search"].clone();
        }
        assert_tool(actual, &expected, &format!("matrix mask={mask} {language}"));
    }
    tools_only
}

#[test]
fn typescript_guidance_matrix_matches_every_config_and_language() {
    let golden = golden();
    assert_eq!(golden.languages.len(), 191);
    assert_eq!(
        golden.guidance_cases.len(),
        128 * 2 * golden.languages.len()
    );
    assert_eq!(
        golden.catalog_tools_only.len(),
        16 * 2 * golden.languages.len()
    );
    let mut seen = vec![false; golden.guidance_cases.len()];
    let mut tools_only_cases = 0;
    for &[mask, surface, language, prefix, suffix] in &golden.guidance_cases {
        let index = (mask * 2 + surface) * golden.languages.len() + language;
        assert!(!seen[index], "duplicate config case");
        seen[index] = true;
        let preset = if surface == 0 {
            PromptSurfacePreset::Full
        } else {
            PromptSurfacePreset::Light
        };
        tools_only_cases += usize::from(assert_guidance(
            mask,
            preset,
            &golden.languages[language].code,
            false,
            None,
            &expected_text([prefix, suffix]),
        ));
    }
    assert!(seen.iter().all(|seen| *seen));
    for case in &golden.extras {
        tools_only_cases += usize::from(assert_guidance(
            case.mask,
            case.preset,
            &case.language,
            case.denied,
            case.primary_override.as_deref(),
            &expected_text(case.text),
        ));
    }
    assert_eq!(tools_only_cases, 32 * 2 * (golden.languages.len() + 1));
    println!("Compared {} exhaustive guidance cases and {} override/permission cases on both Rust serving composers, including {tools_only_cases} catalog tools-only cases", golden.guidance_cases.len(), golden.extras.len());
}

#[test]
fn all_icu_languages_and_rejected_codes_match_typescript() {
    let golden = golden();
    for language in &golden.languages {
        assert_eq!(
            primary_language_directive(Some(&language.code)).as_bytes(),
            language.directive.as_bytes(),
            "{}",
            language.code
        );
        let padded = format!(" {} ", language.code.to_ascii_uppercase());
        assert_eq!(
            primary_language_directive(Some(&padded)),
            language.directive
        );
    }
    for code in golden
        .rejected
        .iter()
        .map(String::as_str)
        .chain(["english", "en-US", "123", "éé"])
    {
        assert_eq!(primary_language_directive(Some(code)), "", "{code}");
    }
    assert_eq!(golden.languages.len() - 1 + golden.rejected.len(), 26 * 26);
    println!(
        "Compared 190 ICU names/directives and {} rejected two-letter codes",
        golden.rejected.len()
    );
}

#[test]
fn legacy_guidance_assets_are_the_generated_enabled_baseline() {
    for preset in [PromptSurfacePreset::Full, PromptSurfacePreset::Light] {
        for (variant, reduce) in [
            (GuidanceVariant::Full, true),
            (GuidanceVariant::NoReduce, false),
        ] {
            let mask = 1 | 2 | 4 | 16 | if reduce { 64 } else { 0 };
            let surface = usize::from(preset == PromptSurfacePreset::Light);
            let row = golden()
                .guidance_cases
                .iter()
                .find(|row| row[0] == mask && row[1] == surface && row[2] == 0)
                .unwrap();
            let expected = expected_text([row[3], row[4]]);
            assert_eq!(
                guidance_asset(preset, variant).bytes.as_bytes(),
                expected.as_bytes()
            );
        }
    }
}
