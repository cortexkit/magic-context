use super::*;
use serde_json::json;

const OPUS: &str = "anthropic/claude-opus-5-5";

struct TestEnv<const N: usize>([(&'static str, PathBuf); N]);

impl<const N: usize> EnvSource for TestEnv<N> {
    fn var_os(&self, key: &str) -> Option<std::ffi::OsString> {
        self.0
            .iter()
            .find(|(name, _)| *name == key)
            .map(|(_, value)| value.as_os_str().to_owned())
    }
}

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
    let loader = Loader::from_env(&TestEnv([
        ("MAGIC_CONTEXT_CONFIG_PATH", explicit.clone()),
        ("XDG_CONFIG_HOME", xdg.clone()),
    ]))
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
    for invalid in ["", "relative.jsonc"] {
        assert!(
            Loader::from_env(&TestEnv([("MAGIC_CONTEXT_CONFIG_PATH", invalid.into())])).is_err()
        );
    }
    let loader = Loader::from_env(&TestEnv([("XDG_CONFIG_HOME", xdg)])).unwrap();
    assert_eq!(
        loader
            .resolve(None, OPUS, 100_000)
            .execute_threshold_percentage,
        70.0
    );
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn unix_default_user_path_keeps_the_xdg_layout() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().to_path_buf();
    let folder = home.join(".config").join("cortexkit");
    let jsonc = folder.join("magic-context.jsonc");
    let json = folder.join("magic-context.json");
    let env = TestEnv([
        ("HOME", home),
        ("XDG_CONFIG_HOME", "relative-config".into()),
    ]);

    assert_eq!(Loader::from_env(&env).unwrap().user_path(), jsonc);
    fs::create_dir_all(folder).unwrap();
    fs::write(&json, "{}").unwrap();
    assert_eq!(Loader::from_env(&env).unwrap().user_path(), json);
    fs::write(&jsonc, "{}").unwrap();
    assert_eq!(Loader::from_env(&env).unwrap().user_path(), jsonc);
}

#[cfg(unix)]
#[test]
fn relative_home_does_not_select_settings_from_the_working_directory() {
    let env = TestEnv([("HOME", ".".into())]);
    assert!(Loader::from_env(&env).is_err());
}

#[cfg(windows)]
#[test]
fn windows_default_user_path_uses_roaming_appdata() {
    let root = tempfile::tempdir().unwrap();
    let appdata = root.path().join("roaming");
    let expected = appdata.join("cortexkit").join("magic-context.jsonc");
    let env = TestEnv([
        ("USERPROFILE", root.path().join("profile")),
        ("APPDATA", appdata),
        ("LOCALAPPDATA", root.path().join("local")),
    ]);

    assert_eq!(Loader::from_env(&env).unwrap().user_path(), expected);
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
    assert_eq!(provider.endpoint(), Some("https://e.invalid/v1"));
    assert_eq!(
        provider.api_key_for_test(),
        Some(&ApiKey::Text(Secret::new("{file:key}".into())))
    );
    fs::remove_dir_all(folder).ok();
}

#[test]
fn a_vault_reference_is_the_whole_value_of_a_user_secret() {
    assert_eq!(
        vault_reference("{vault:apikey:voyage}"),
        Some("apikey:voyage")
    );
    assert_eq!(
        vault_reference(" {vault: apikey:voyage } "),
        Some("apikey:voyage")
    );
    for not_one in [
        "Bearer {vault:apikey:voyage}",
        "{vault:}",
        "{vault:a}{vault:b}",
        "{env:X}",
        "vault:x",
    ] {
        assert_eq!(vault_reference(not_one), None, "{not_one}");
    }
    let embedding = |api_key: &str| json!({"embedding": {"provider": "openai-compatible", "endpoint": "https://e.invalid/v1", "model": "m", "api_key": api_key}});
    let user = resolve_for_test(embedding("{vault:apikey:voyage}"), json!({}), OPUS, 1_000)
        .embedding
        .unwrap();
    assert!(
        matches!(user.api_key_for_test(), Some(ApiKey::Vault(held)) if held.id() == "apikey:voyage")
    );
    // A project's reference stays text; a project's empty key still clears
    // the user's, as before.
    let project = resolve_for_test(
        embedding("{vault:apikey:voyage}"),
        json!({"embedding": {"api_key": "{vault:apikey:project-tier}"}}),
        OPUS,
        1_000,
    )
    .embedding
    .unwrap();
    assert_eq!(
        project.api_key_for_test(),
        Some(&ApiKey::Text(Secret::new(
            "{vault:apikey:project-tier}".into()
        )))
    );
    let cleared = resolve_for_test(
        embedding("{vault:apikey:voyage}"),
        json!({"embedding": {"api_key": ""}}),
        OPUS,
        1_000,
    )
    .embedding
    .unwrap();
    assert_eq!(cleared.api_key_for_test(), None);
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
    let vault = Vault::none();
    let source = |user: Value, project: Option<Value>| {
        let settings = resolve_tiers(Some(&user), project.as_ref(), OPUS, 100_000, &vault);
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

#[test]
fn keep_subagents_is_off_by_default_and_only_the_user_turns_it_on() {
    let keep =
        |user: Value, project: Value| resolve_for_test(user, project, OPUS, 100_000).keep_subagents;
    assert!(!keep(json!({}), json!({})));
    assert!(keep(json!({"keep_subagents": true}), json!({})));
    assert!(!keep(json!({"keep_subagents": false}), json!({})));
    // Not a boolean: the default applies, as in the plugin's schema.
    assert!(!keep(json!({"keep_subagents": "yes"}), json!({})));
    // Keeping widens what is stored, so a project file can't turn it on, and
    // it can't turn the user's choice off either.
    assert!(!keep(json!({}), json!({"keep_subagents": true})));
    assert!(keep(
        json!({"keep_subagents": true}),
        json!({"keep_subagents": false})
    ));
}

#[test]
fn dreamer_projects_limit_the_dreamer_and_an_unreadable_list_means_none() {
    let settings =
        |dreamer: serde_json::Value| dreamer_settings(Some(&json!({ "dreamer": dreamer })));
    assert_eq!(settings(json!({})).unwrap().projects, None);
    assert_eq!(
        settings(json!({"projects": ["pj-a", " pj-b "]}))
            .unwrap()
            .projects,
        Some(["pj-a".to_owned(), "pj-b".to_owned()].into())
    );
    // A list that can't be read narrows to no project, never to all.
    assert_eq!(
        settings(json!({"projects": "pj-a"})).unwrap().projects,
        Some(Default::default())
    );
    assert_eq!(
        settings(json!({"projects": ["pj-a", 3]})).unwrap().projects,
        Some(Default::default())
    );
    let off = settings(json!({"projects": []})).unwrap();
    assert!(!off.runs_for("pj-a"));
    assert!(settings(json!({})).unwrap().runs_for("pj-a"));
}

#[test]
fn dreamer_branches_name_each_projects_other_live_branches() {
    let settings =
        |dreamer: serde_json::Value| dreamer_settings(Some(&json!({ "dreamer": dreamer })));
    assert!(settings(json!({})).unwrap().branches.is_empty());
    let branches = settings(json!({"branches": {
        "pj-a": [" release ", ""],
        "pj-b": "release",
        "pj-c": ["next", 3],
    }}))
    .unwrap()
    .branches;
    // An entry that can't be read leaves its project on one line.
    assert_eq!(
        branches,
        [("pj-a".to_owned(), vec!["release".to_owned()])].into()
    );
}

#[test]
fn clock_note_defaults_to_thirty_minutes_and_only_the_user_sets_it() {
    let interval =
        |user: Value, project: Value| resolve_for_test(user, project, OPUS, 100_000).clock_note;
    const MINUTE: u64 = 60_000;
    assert_eq!(interval(json!({}), json!({})), Some(30 * MINUTE));
    assert_eq!(
        interval(json!({"clock_note": "10m"}), json!({})),
        Some(10 * MINUTE)
    );
    assert_eq!(
        interval(json!({"clock_note": "42m"}), json!({})),
        Some(42 * MINUTE)
    );
    assert_eq!(
        interval(json!({"clock_note": "1h"}), json!({})),
        Some(60 * MINUTE)
    );
    assert_eq!(interval(json!({"clock_note": false}), json!({})), None);
    // A value that can't be used leaves the default rather than turning the
    // note off.
    for bad in [json!("90s"), json!(true), json!(30), json!("1d")] {
        assert_eq!(
            interval(json!({ "clock_note": bad }), json!({})),
            Some(30 * MINUTE),
            "{bad}"
        );
    }
    // A cloned repository's file neither adds notes nor takes them away.
    assert_eq!(
        interval(json!({}), json!({"clock_note": "1m"})),
        Some(30 * MINUTE)
    );
    assert_eq!(
        interval(json!({"clock_note": "10m"}), json!({"clock_note": false})),
        Some(10 * MINUTE)
    );
}

#[test]
fn clock_note_follows_an_edit_without_a_restart() {
    let root = temp_config("clock-note");
    let user = root.join("user.jsonc");
    let loader = Loader::with_user_path(user.clone());
    rewrite_config(&user, r#"{"clock_note": "10m"}"#, 1);
    assert_eq!(
        loader.resolve(None, OPUS, 100_000).clock_note,
        Some(600_000)
    );
    rewrite_config(&user, r#"{"clock_note": false}"#, 2);
    assert_eq!(loader.resolve(None, OPUS, 100_000).clock_note, None);
    rewrite_config(&user, r#"{"clock_note": "2h"}"#, 3);
    assert_eq!(
        loader.resolve(None, OPUS, 100_000).clock_note,
        Some(7_200_000)
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn an_unusable_clock_note_is_named_in_the_log_once_per_value() {
    let root = temp_config("clock-note-log");
    fs::create_dir_all(root.join(".cortexkit")).unwrap();
    let user = root.join("user.jsonc");
    let loader = Loader::with_user_path(user.clone());
    let mut lines = Vec::new();
    for tick in [1, 2] {
        rewrite_config(&user, r#"{"clock_note": "5s"}"#, tick);
        loader.read_with_warning(&user, &mut |line| lines.push(line));
    }
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert!(
        lines[0].ends_with(
            r#"clock_note must be false or a duration in minutes or hours such as "30m" or "1h", not "5s"; the default of 30m applies"#
        ),
        "{lines:?}"
    );
    assert!(
        lines[0].starts_with(&user.display().to_string()),
        "{lines:?}"
    );
    rewrite_config(&user, r#"{"clock_note": "15m"}"#, 3);
    loader.read_with_warning(&user, &mut |line| lines.push(line));
    assert_eq!(lines.len(), 1, "a usable value logs nothing: {lines:?}");
    // In a project file the key is ignored, and the log says so.
    let project = root.join(".cortexkit/magic-context.jsonc");
    rewrite_config(&project, r#"{"clock_note": "1m"}"#, 1);
    loader.read_with_warning(&project, &mut |line| lines.push(line));
    assert_eq!(lines.len(), 2, "{lines:?}");
    assert!(
        lines[1].ends_with("clock_note is read from the user's file only; ignored here"),
        "{lines:?}"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_malformed_rerank_module_is_named_in_the_log_once_and_the_default_applies() {
    use crate::search::rerank::Reranker;
    let root = temp_config("rerank-module-log");
    fs::create_dir_all(root.join(".cortexkit")).unwrap();
    let user = root.join("user.jsonc");
    let loader = Loader::with_user_path(user.clone());
    let mut lines = Vec::new();
    for tick in [1, 2] {
        rewrite_config(&user, r#"{"rerank": {"module": "fed:ABC:synapse"}}"#, tick);
        loader.read_with_warning(&user, &mut |line| lines.push(line));
        assert_eq!(
            loader.resolve(None, OPUS, 100_000).rerank,
            Reranker::local_synapse()
        );
    }
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert!(
        lines[0].ends_with(
            r#"rerank.module must be a module id such as "synapse" or fed:<fingerprint>:<module id> with a fingerprint of 32 lowercase hex characters, not "fed:ABC:synapse"; the default of synapse applies"#
        ),
        "{lines:?}"
    );
    assert!(
        lines[0].starts_with(&user.display().to_string()),
        "{lines:?}"
    );
    // A usable value logs nothing and applies.
    let remote = "fed:0123456789abcdef0123456789abcdef:synapse";
    rewrite_config(
        &user,
        &format!(r#"{{"rerank": {{"module": "{remote}"}}}}"#),
        3,
    );
    loader.read_with_warning(&user, &mut |line| lines.push(line));
    assert_eq!(lines.len(), 1, "a usable value logs nothing: {lines:?}");
    assert_eq!(
        loader.resolve(None, OPUS, 100_000).rerank,
        Reranker::Synapse(remote.into())
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn only_the_user_file_names_the_rerank_module() {
    use crate::search::rerank::Reranker;
    let remote = "fed:0123456789abcdef0123456789abcdef:synapse";
    let rerank =
        |user: Value, project: Value| resolve_for_test(user, project, OPUS, 100_000).rerank;
    assert_eq!(rerank(json!({}), json!({})), Reranker::local_synapse());
    assert_eq!(
        rerank(json!({}), json!({"rerank": {"module": remote}})),
        Reranker::local_synapse()
    );
    assert_eq!(
        rerank(
            json!({"rerank": {"module": remote}}),
            json!({"rerank": {"provider": "synapse", "module": "synapse"}})
        ),
        Reranker::Synapse(remote.into())
    );
    // A project may still turn reranking off.
    assert_eq!(
        rerank(
            json!({"rerank": {"module": remote}}),
            json!({"rerank": {"provider": "off"}})
        ),
        Reranker::Off
    );
    // A project file naming the module logs nothing: like the rest of
    // `rerank.*` there, it is simply not read.
    assert_eq!(
        setting_notes(&json!({"rerank": {"module": "not a module"}}), false),
        Vec::<String>::new()
    );
}

#[test]
fn a_config_with_temporal_awareness_loads_and_logs_the_key_obsolete_once() {
    let root = temp_config("temporal-awareness");
    let user = root.join("user.jsonc");
    let loader = Loader::with_user_path(user.clone());
    let mut lines = Vec::new();
    for (tick, value) in [(1, "true"), (2, "false"), (3, "true")] {
        rewrite_config(
            &user,
            &format!(r#"{{"execute_threshold_percentage": 80, "temporal_awareness": {value}}}"#),
            tick,
        );
        let settings = loader.read_with_warning(&user, &mut |line| lines.push(line));
        assert_eq!(settings.unwrap()["execute_threshold_percentage"], 80);
        // The rest of the file still applies.
        assert_eq!(
            loader
                .resolve(None, OPUS, 100_000)
                .execute_threshold_percentage,
            80.0
        );
    }
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert!(
        lines[0].ends_with(
            "temporal_awareness is obsolete and ignored: ck-mc no longer adds time markers to messages; clock_note sets how often an agent is told the time"
        ),
        "{lines:?}"
    );
    fs::remove_dir_all(root).unwrap();
}
