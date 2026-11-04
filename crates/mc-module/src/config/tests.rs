use super::*;
use serde_json::json;

const OPUS: &str = "anthropic/claude-opus-5-5";

#[test]
fn explicit_user_path_wins_without_fallback() {
    let root = temp_config("path");
    let explicit = root.join("chosen.jsonc");
    let xdg = root.join("xdg");
    fs::create_dir_all(xdg.join("cortexkit")).unwrap();
    fs::write(
        xdg.join("cortexkit/magic-context.jsonc"),
        r#"{"execute_threshold_percentage":70}"#,
    )
    .unwrap();
    fs::write(&explicit, r#"{"execute_threshold_percentage":80}"#).unwrap();
    let loader = Loader::from_paths(
        Some(explicit.clone().into_os_string()),
        Some(xdg.clone().into_os_string()),
        Some(root.clone()),
    )
    .unwrap();
    assert_eq!(
        loader
            .resolve(None, OPUS, 100_000)
            .execute_threshold_percentage,
        80.0
    );
    fs::remove_file(explicit).unwrap();
    assert_eq!(
        loader
            .resolve(None, OPUS, 100_000)
            .execute_threshold_percentage,
        65.0
    );
    assert!(Loader::from_paths(Some("".into()), None, None).is_err());
    assert!(Loader::from_paths(Some("relative.jsonc".into()), None, None).is_err());
    let loader = Loader::from_paths(None, Some(xdg.into_os_string()), Some(root.clone())).unwrap();
    assert_eq!(
        loader
            .resolve(None, OPUS, 100_000)
            .execute_threshold_percentage,
        70.0
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn no_project_folder_reads_only_user() {
    let root = temp_config("user-only");
    fs::create_dir_all(root.join(".cortexkit")).unwrap();
    fs::write(
        root.join("user.jsonc"),
        r#"{"execute_threshold_percentage":80}"#,
    )
    .unwrap();
    fs::write(
        root.join(".cortexkit/magic-context.jsonc"),
        r#"{"execute_threshold_percentage":85}"#,
    )
    .unwrap();
    assert_eq!(
        Loader::with_user_path(root.join("user.jsonc"))
            .resolve(None, OPUS, 100_000)
            .execute_threshold_percentage,
        80.0
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn user_expansion_handles_env_home_and_missing_sources() {
    let root = temp_config("expansion");
    fs::write(root.join("secret"), "  from home\n").unwrap();
    let value = expand_user_with(
        json!({"env": "{env: KEY }", "home": "{file:~/secret}", "missing_env": "x{env:MISSING}y", "missing_file": "{file:missing}"}),
        &root.join("user.jsonc"),
        Some(&root),
        &|name| (name == "KEY").then(|| "from env".to_owned()),
    );
    assert_eq!(
        value,
        json!({"env": "from env", "home": "from home", "missing_env": "xy", "missing_file": ""})
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn invalid_project_leaf_falls_back_to_user() {
    let settings = resolve_for_test(
        json!({"history_budget_percentage": 0.2, "memory": {"injection_budget_tokens": 5000, "auto_search": {"score_threshold": 0.8, "min_prompt_chars": 30}}}),
        json!({"history_budget_percentage": 0.9, "memory": {"injection_budget_tokens": 499, "auto_search": {"score_threshold": 1.0, "min_prompt_chars": 501}}}),
        OPUS,
        100_000,
    );
    assert_eq!(settings.history_budget_percentage, 0.2);
    assert_eq!(settings.memory_budget_tokens, 5000);
    assert_eq!(settings.auto_search.score_threshold, 0.8);
    assert_eq!(settings.auto_search.min_prompt_chars, 30);
}

#[test]
fn project_cannot_set_user_only_catalog_fields() {
    let root = temp_config("catalog");
    fs::create_dir_all(root.join(".cortexkit")).unwrap();
    fs::write(root.join("user.jsonc"), r#"{"language":"fr","prompt_surface":{"tool_descriptions":{"ctx_search":"trusted description"},"guidance_override_text":"trusted guidance"}}"#).unwrap();
    fs::write(root.join(".cortexkit/magic-context.jsonc"), r#"{"language":"de","compaction":{"enabled":false},"prompt_surface":{"default":"light","tool_descriptions":{"ctx_search":"unsafe description"},"guidance_override_path":"project.md","guidance_override_text":"unsafe guidance"}}"#).unwrap();
    let loader = Loader::with_user_path(root.join("user.jsonc"));
    let catalog = loader.catalog_config(Some(&root));
    assert_eq!(catalog.language.as_deref(), Some("fr"));
    assert!(catalog.compaction_enabled);
    assert_eq!(catalog.surface_default, crate::catalog::Surface::Light);
    assert_eq!(
        catalog.guidance_override.as_deref(),
        Some("trusted guidance")
    );
    assert_eq!(
        catalog.tool_descriptions["ctx_search"],
        "trusted description"
    );
    assert_eq!(
        loader
            .resolve(Some(&root), OPUS, 100_000)
            .language
            .as_deref(),
        Some("fr")
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn project_protected_tokens_respect_derived_floor() {
    for (usable, floor) in [(100_000, 8_000), (200_000, 16_000), (1_000_000, 50_000)] {
        let settings = resolve_for_test(json!({}), json!({"protected_tokens": 4000}), OPUS, usable);
        assert_eq!(settings.protected_tokens.unwrap_or(floor), floor);
        let settings =
            resolve_for_test(json!({}), json!({"protected_tokens": floor}), OPUS, usable);
        assert_eq!(settings.protected_tokens, Some(floor));
    }
    let settings = resolve_for_test(
        json!({"protected_tokens": 4000}),
        json!({"protected_tokens": 5000}),
        OPUS,
        1_000_000,
    );
    assert_eq!(settings.protected_tokens, Some(5000));
}

#[test]
fn project_percentage_default_preserves_user_model() {
    let user = json!({"execute_threshold_percentage": {"default": 50, OPUS: 40}});
    assert_eq!(
        resolve_for_test(
            user.clone(),
            json!({"execute_threshold_percentage": {"default": 70}}),
            OPUS,
            100_000
        )
        .execute_threshold_percentage,
        40.0
    );
    assert_eq!(
        resolve_for_test(
            user.clone(),
            json!({"execute_threshold_percentage": {"default": 70}}),
            "openai/gpt-6",
            100_000
        )
        .execute_threshold_percentage,
        70.0
    );
    assert_eq!(
        resolve_for_test(
            user,
            json!({"execute_threshold_percentage": 70}),
            OPUS,
            100_000
        )
        .execute_threshold_percentage,
        70.0
    );
}

#[test]
fn project_token_default_requires_user_default() {
    assert_eq!(
        resolve_for_test(
            json!({"execute_threshold_tokens": {OPUS: 50000}}),
            json!({"execute_threshold_tokens": {"default": 80000}}),
            OPUS,
            100_000,
        )
        .execute_threshold_percentage,
        50.0
    );
    assert_eq!(
        resolve_for_test(
            json!({"execute_threshold_tokens": {"default": 50000, OPUS: 60000}}),
            json!({"execute_threshold_tokens": {"default": 80000}}),
            OPUS,
            100_000,
        )
        .execute_threshold_percentage,
        60.0
    );
    assert_eq!(
        resolve_for_test(
            json!({"execute_threshold_tokens": {"default": 50000}}),
            json!({"execute_threshold_tokens": {"default": 80000}}),
            OPUS,
            100_000,
        )
        .execute_threshold_percentage,
        80.0
    );
}

#[test]
fn more_specific_project_threshold_cannot_lower_user() {
    for key in ["execute_threshold_percentage", "execute_threshold_tokens"] {
        let (default, user, project, expected) = if key.ends_with("tokens") {
            (50_000, 85_000, 70_000, 85.0)
        } else {
            (65, 85, 70, 85.0)
        };
        assert_eq!(
            resolve_for_test(
                json!({key: {"default": default, "claude-opus-5": user}}),
                json!({key: {OPUS: project}}),
                OPUS,
                100_000,
            )
            .execute_threshold_percentage,
            expected
        );
    }
}

#[test]
fn reasoning_budget_uses_provider_wildcard_after_model_keys() {
    let user = json!({"keep_reasoning_tokens": {"anthropic/*": 0, "default": 20000}});
    assert_eq!(
        resolve_for_test(user.clone(), json!({}), OPUS, 100_000).keep_reasoning_tokens,
        0
    );
    assert_eq!(
        resolve_for_test(
            user,
            json!({"keep_reasoning_tokens": {"claude-opus": 2000}}),
            OPUS,
            100_000
        )
        .keep_reasoning_tokens,
        2000
    );
    assert_eq!(
        resolve_for_test(
            json!({"keep_reasoning_tokens": {"openai/*": 3000}}),
            json!({}),
            "openai-codex/gpt-6",
            100_000
        )
        .keep_reasoning_tokens,
        3000
    );
}

#[test]
fn reasoning_map_drops_only_invalid_entry() {
    assert_eq!(
        resolve_for_test(
            json!({"keep_reasoning_tokens": {OPUS: 2000, "openai/gpt-6": 2000000}}),
            json!({}),
            OPUS,
            100_000
        )
        .keep_reasoning_tokens,
        2000
    );
    assert_eq!(
        resolve_for_test(
            json!({"keep_reasoning_tokens": {OPUS: 3000}}),
            json!({"keep_reasoning_tokens": {OPUS: -1, "default": 4000}}),
            OPUS,
            100_000
        )
        .keep_reasoning_tokens,
        3000
    );
}

#[test]
fn protected_tool_keys_use_runtime_normalization() {
    let settings = resolve_for_test(
        json!({"protected_tools": {"MCP_GitHub": 2}}),
        json!({"protected_tools": {"github": 3}}),
        OPUS,
        100_000,
    );
    assert!(!settings.protected_tools.contains_key("mcp_github"));
    assert_eq!(settings.protected_tools["github"], 3);
    let settings = resolve_for_test(
        json!({"protected_tools": {"mcp_GitHub": 2}}),
        json!({}),
        OPUS,
        100_000,
    );
    assert_eq!(
        settings.protected_tools[&crate::lanes::normalize_tool_name("mcp_github")],
        2
    );
}

#[test]
fn integral_json_numbers_are_accepted() {
    let settings = resolve_for_test(
        json!({
            "protected_tokens": 30000.0, "keep_reasoning_tokens": {OPUS: 2000.0},
            "protected_tools": {"read": 2.0}, "commit_cluster_trigger": {"min_clusters": 4.0},
            "caveman_text_compression": {"enabled": true, "min_chars": 600.0}
        }),
        json!({}),
        OPUS,
        100_000,
    );
    assert_eq!(settings.protected_tokens, Some(30000));
    assert_eq!(settings.keep_reasoning_tokens, 2000);
    assert_eq!(settings.protected_tools["read"], 2);
    assert_eq!(settings.commit_clusters, Some(4));
    assert_eq!(settings.caveman.unwrap().min_chars, 600);
    let settings = resolve_for_test(
        json!({"protected_tokens": 30000.5, "keep_reasoning_tokens": 2000.5}),
        json!({}),
        OPUS,
        100_000,
    );
    assert_eq!(settings.protected_tokens, None);
    assert_eq!(settings.keep_reasoning_tokens, 10000);
}

fn temp_config(label: &str) -> PathBuf {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let root = std::env::temp_dir().join(format!(
        "ck-mc-config-{label}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    fs::create_dir_all(&root).unwrap();
    root
}

fn rewrite_config(path: &Path, text: &str, tick: u64) {
    fs::write(path, text).unwrap();
    fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000 + tick))
        .unwrap();
}

#[test]
fn broken_reload_keeps_last_good_tier() {
    let root = temp_config("reload");
    let user = root.join("user.jsonc");
    let project = root.join(".cortexkit/magic-context.jsonc");
    fs::create_dir_all(project.parent().unwrap()).unwrap();
    rewrite_config(&user, r#"{"execute_threshold_percentage":80}"#, 1);
    rewrite_config(
        &project,
        r#"{"memory":{"injection_budget_tokens":5000}}"#,
        1,
    );
    let loader = Loader::with_user_path(user.clone());
    assert_eq!(
        loader
            .resolve(Some(&root), OPUS, 100_000)
            .execute_threshold_percentage,
        80.0
    );
    rewrite_config(
        &user,
        r#"{"execute_threshold_percentage":80,"memory":{}"#,
        2,
    );
    rewrite_config(&project, r#"{"memory":{"injection_budget_tokens":6000}"#, 2);
    for _ in 0..2 {
        let settings = loader.resolve(Some(&root), OPUS, 100_000);
        assert_eq!(settings.execute_threshold_percentage, 80.0);
        assert_eq!(settings.memory_budget_tokens, 5000);
    }
    rewrite_config(&user, r#"{"execute_threshold_percentage":85}"#, 3);
    rewrite_config(
        &project,
        r#"{"memory":{"injection_budget_tokens":6000}}"#,
        3,
    );
    let settings = loader.resolve(Some(&root), OPUS, 100_000);
    assert_eq!(settings.execute_threshold_percentage, 85.0);
    assert_eq!(settings.memory_budget_tokens, 6000);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn first_load_recovers_jsonc_values() {
    let root = temp_config("recovery");
    let user = root.join("user.jsonc");
    for text in [
        r#"\{"execute_threshold_percentage":80}"#,
        r#"{"execute_threshold_percentage":80,"memory":{}"#,
        r#"{"execute_threshold_percentage":80 "temporal_awareness":false}"#,
    ] {
        fs::write(&user, text).unwrap();
        let loader = Loader::with_user_path(user.clone());
        assert_eq!(
            loader
                .resolve(None, OPUS, 100_000)
                .execute_threshold_percentage,
            80.0,
            "{text}"
        );
    }
    fs::write(&user, "not a config").unwrap();
    assert_eq!(
        Loader::with_user_path(user)
            .resolve(None, OPUS, 100_000)
            .execute_threshold_percentage,
        65.0
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn parse_warnings_are_located_and_deduplicated_by_content() {
    let root = temp_config("warnings");
    let user = root.join("user.jsonc");
    let loader = Loader::with_user_path(user.clone());
    let mut warnings = Vec::new();
    rewrite_config(&user, r#"\{"execute_threshold_percentage":80}"#, 1);
    for tick in [1, 2] {
        rewrite_config(&user, r#"\{"execute_threshold_percentage":80}"#, tick);
        assert_eq!(
            loader
                .read_with_warning(&user, &mut |warning| warnings.push(warning))
                .unwrap()["execute_threshold_percentage"],
            80
        );
    }
    assert_eq!(warnings.len(), 1);
    assert!(
        warnings[0].contains(
            ":1:1: invalid symbol; recovered values were applied, but the file must be fixed."
        ),
        "{warnings:?}"
    );
    rewrite_config(&user, "not a config", 3);
    assert_eq!(
        loader
            .read_with_warning(&user, &mut |warning| warnings.push(warning))
            .unwrap()["execute_threshold_percentage"],
        80
    );
    assert_eq!(warnings.len(), 2);
    assert!(warnings[1].contains("keeping the previous configuration"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn comments_and_trailing_commas_parse() {
    let parsed = jsonc::parse(
        "\u{feff}{\n // note\n \"a\": \"x // not a comment\", /* block */\n \"b\": [1, 2,],\n}",
    );
    assert_eq!(parsed.issue, None);
    assert_eq!(
        parsed.value,
        json!({"a": "x // not a comment", "b": [1, 2]})
    );
}

#[test]
fn a_project_only_raises_the_percentage_threshold() {
    let lower = resolve_for_test(
        json!({"execute_threshold_percentage": 70}),
        json!({"execute_threshold_percentage": 50}),
        OPUS,
        1_000,
    );
    assert_eq!(lower.execute_threshold_percentage, 70.0);
    let higher = resolve_for_test(
        json!({"execute_threshold_percentage": {"claude-opus-5": 60, "default": 40}}),
        json!({"execute_threshold_percentage": 80}),
        OPUS,
        1_000,
    );
    assert_eq!(higher.execute_threshold_percentage, 80.0);
    // Out of the schema's 20 to 90 range: dropped, as the plugin's loader
    // drops an invalid leaf, so the default applies; never clamped.
    for out_of_range in [99, 10] {
        let dropped = resolve_for_test(
            json!({"execute_threshold_percentage": out_of_range}),
            json!({}),
            OPUS,
            1_000,
        );
        assert_eq!(dropped.execute_threshold_percentage, 65.0, "{out_of_range}");
    }
    // An invalid model entry falls through to the map's `default`.
    let fell_through = resolve_for_test(
        json!({"execute_threshold_percentage": {"claude-opus-5": 95, "default": 75}}),
        json!({}),
        OPUS,
        1_000,
    );
    assert_eq!(fell_through.execute_threshold_percentage, 75.0);
}

#[test]
fn out_of_range_values_are_dropped_not_clamped() {
    // The plugin's loader drops these leaves and keeps the default
    // (`project-config-trust-boundary.test.ts`: an injection budget of
    // 20,001 reads as 4,000).
    let settings = resolve_for_test(
        json!({"history_budget_percentage": 0.9, "memory": {"injection_budget_tokens": 20_001,
            "auto_search": {"score_threshold": 0.99, "min_prompt_chars": 1}}}),
        json!({}),
        OPUS,
        1_000,
    );
    let defaults = Settings::default();
    assert_eq!(
        settings.history_budget_percentage,
        defaults.history_budget_percentage
    );
    assert_eq!(settings.memory_budget_tokens, 4_000);
    assert_eq!(
        settings.auto_search.score_threshold,
        defaults.auto_search.score_threshold
    );
    assert_eq!(
        settings.auto_search.min_prompt_chars,
        defaults.auto_search.min_prompt_chars
    );
    // In range, they apply.
    let set = resolve_for_test(
        json!({"history_budget_percentage": 0.3, "memory": {"injection_budget_tokens": 8_000}}),
        json!({}),
        OPUS,
        1_000,
    );
    assert_eq!(set.history_budget_percentage, 0.3);
    assert_eq!(set.memory_budget_tokens, 8_000);
}

#[test]
fn a_token_threshold_wins_and_a_project_cannot_add_one() {
    let user = resolve_for_test(
        json!({"execute_threshold_percentage": 80, "execute_threshold_tokens": {"claude-opus-5-5": 70_000}}),
        json!({}),
        OPUS,
        100_000,
    );
    assert_eq!(user.execute_threshold_percentage, 70.0);
    let added = resolve_for_test(
        json!({}),
        json!({"execute_threshold_tokens": {"default": 10_000}}),
        OPUS,
        100_000,
    );
    assert_eq!(added.execute_threshold_percentage, 65.0);
    let raised = resolve_for_test(
        json!({"execute_threshold_tokens": {"default": 60_000}}),
        json!({"execute_threshold_tokens": {"default": 50_000}}),
        OPUS,
        100_000,
    );
    assert_eq!(raised.execute_threshold_percentage, 60.0);
    // Under the schema's 5,000-token floor: dropped, so the percentage
    // applies.
    let too_small = resolve_for_test(
        json!({"execute_threshold_percentage": 80, "execute_threshold_tokens": {"default": 700}}),
        json!({}),
        OPUS,
        100_000,
    );
    assert_eq!(too_small.execute_threshold_percentage, 80.0);
}

#[test]
fn reasoning_budgets_merge_per_model() {
    let settings = resolve_for_test(
        json!({"keep_reasoning_tokens": {"openai/*": 1, "default": 2_000}}),
        json!({"keep_reasoning_tokens": {"gpt-6.1": 3_000}}),
        "openai-codex/gpt-6.1-sol",
        1_000,
    );
    assert_eq!(settings.keep_reasoning_tokens, 3_000);
    let fallback = resolve_for_test(json!({"keep_reasoning_tokens": 5}), json!({}), OPUS, 1_000);
    assert_eq!(fallback.keep_reasoning_tokens, 5);
}

#[test]
fn a_project_only_raises_protected_tokens() {
    let lowered = resolve_for_test(
        json!({"protected_tokens": 30_000}),
        json!({"protected_tokens": 10_000}),
        OPUS,
        1_000,
    );
    assert_eq!(lowered.protected_tokens, Some(30_000));
    let raised = resolve_for_test(json!({}), json!({"protected_tokens": 50_000}), OPUS, 1_000);
    assert_eq!(raised.protected_tokens, Some(50_000));
}

#[test]
fn user_strings_expand_and_project_strings_stay_literal() {
    let folder = std::env::temp_dir().join(format!("ck-mc-config-{}", std::process::id()));
    fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join("key"), "secret\n").unwrap();
    let user_path = folder.join("magic-context.jsonc");
    let expanded = expand_user(json!({"embedding": {"api_key": "{file:key}"}}), &user_path);
    assert_eq!(expanded["embedding"]["api_key"], "secret");
    fs::write(
        &user_path,
        r#"{"embedding": {"provider": "openai-compatible", "endpoint": "https://e.invalid/v1", "model": "m", "api_key": "{file:key}"}}"#,
    )
    .unwrap();
    let project = folder.join("project");
    fs::create_dir_all(project.join(".cortexkit")).unwrap();
    fs::write(
        project.join(".cortexkit/magic-context.jsonc"),
        r#"{"embedding": {"endpoint": "https://evil.invalid", "api_key": "{file:key}"}}"#,
    )
    .unwrap();
    let settings = Loader::with_user_path(user_path).resolve(Some(&project), OPUS, 1_000);
    let provider = settings.embedding.expect("provider");
    assert_eq!(provider.endpoint(), "https://e.invalid/v1");
    assert_eq!(provider.api_key_for_test(), Some("{file:key}"));
    fs::remove_dir_all(folder).ok();
}

#[test]
fn caveman_is_off_by_default_and_its_word_rules_follow_the_language() {
    use crate::pass::Caveman;
    let resolve =
        |user: Value, project: Value| resolve_for_test(user, project, OPUS, 1_000).caveman;
    assert_eq!(resolve(json!({}), json!({})), None);
    let on = json!({"caveman_text_compression": {"enabled": true}});
    assert_eq!(
        resolve(on.clone(), json!({})),
        Some(Caveman {
            min_chars: 500,
            english_word_rules: true
        })
    );
    // Another language keeps only the language-neutral passes; English
    // and an unknown code keep the English word lists.
    let with_language = |language: &str| json!({"caveman_text_compression": {"enabled": true, "min_chars": 50}, "language": language});
    assert_eq!(
        resolve(with_language("tr"), json!({})).map(|c| c.english_word_rules),
        Some(false)
    );
    assert_eq!(
        resolve(with_language("en-GB"), json!({})).map(|c| c.english_word_rules),
        Some(true)
    );
    assert_eq!(
        resolve(with_language("zz"), json!({})).map(|c| c.english_word_rules),
        Some(true)
    );
    // An out-of-range min_chars is ignored; a project may set its own,
    // and may turn the lane off.
    assert_eq!(
        resolve(with_language("en"), json!({})).map(|c| c.min_chars),
        Some(500)
    );
    assert_eq!(
        resolve(
            on.clone(),
            json!({"caveman_text_compression": {"min_chars": 800}})
        )
        .map(|c| c.min_chars),
        Some(800)
    );
    assert_eq!(
        resolve(on, json!({"caveman_text_compression": {"enabled": false}})),
        None
    );
}

/// The apps' session metadata names which setting decided the execute
/// threshold, in the names the earlier ck-mc served.
#[test]
fn the_execute_threshold_names_the_setting_that_decided_it() {
    let path = Path::new("/nonexistent/magic-context.jsonc");
    let source = |user: Value, project: Option<Value>| {
        let settings = resolve_tiers(Some(&user), project.as_ref(), OPUS, 100_000, path);
        (
            settings.execute_threshold_percentage,
            settings.execute_threshold_source,
        )
    };
    assert_eq!(source(json!({}), None), (65.0, "default"));
    assert_eq!(
        source(json!({"execute_threshold_percentage": 70}), None),
        (70.0, "user_percentage")
    );
    assert_eq!(
        source(
            json!({"execute_threshold_percentage": {"default": 60, OPUS: 75}}),
            None
        ),
        (75.0, "model_percentage")
    );
    assert_eq!(
        source(
            json!({"execute_threshold_percentage": 60}),
            Some(json!({"execute_threshold_percentage": 80}))
        ),
        (80.0, "project_percentage")
    );
    assert_eq!(
        source(json!({"execute_threshold_tokens": {OPUS: 70_000}}), None),
        (70.0, "model_tokens")
    );
}
