//! A default build and a `managed-settings` build resolve the same settings
//! from equivalent files: a 0.49 user file as today's reader takes it, and
//! the same file converted, as the daemon delivers it and as `config_files`
//! reads it.

use serde_json::{json, Value};
use subc_client_rs::config::{Layer, LayerValue, ValidationContext};

use super::convert_tests::convert;
use super::UserTier;
use crate::pass::Settings;
use crate::vault::Vault;

/// Fail unless `actual` and `expected` are the same settings, field by
/// field, the embedding provider and the reranker included.
pub(super) fn assert_same(actual: &Settings, expected: &Settings, case: &str) {
    let plain = |settings: &Settings| {
        let mut settings = settings.clone();
        settings.embedding = None;
        settings.rerank = crate::search::rerank::Reranker::Off;
        format!("{settings:?}")
    };
    assert_eq!(plain(actual), plain(expected), "{case}");
    assert!(
        actual.rerank == expected.rerank,
        "{case}: {:?} != {:?}",
        actual.rerank,
        expected.rerank
    );
    let embedding = |settings: &Settings| {
        settings.embedding.as_ref().map(|provider| {
            (
                format!("{provider:?}"),
                provider.model_id(),
                provider.chunk_model_id(),
                provider.endpoint().map(str::to_owned),
                provider.query_wording_for_test(),
            )
        })
    };
    assert_eq!(embedding(actual), embedding(expected), "{case}");
    assert!(
        actual
            .embedding
            .as_ref()
            .and_then(|provider| provider.api_key_for_test())
            == expected
                .embedding
                .as_ref()
                .and_then(|provider| provider.api_key_for_test()),
        "{case}: the embedding key differs"
    );
}

/// The effective view the daemon delivers for `user`, converted to a
/// `UserTier`.
fn delivered(user: &Value) -> UserTier {
    let tuple = super::review::schema()
        .review_tuple(
            &[LayerValue::new(Layer::User, user.clone())],
            &ValidationContext::new("magic-context", None),
        )
        .unwrap_or_else(|refusal| panic!("{refusal:?} for {user}"));
    UserTier::from_view(&tuple.effective, &tuple.sources)
}

/// Project files a cloned repository could carry.
fn projects() -> Vec<Value> {
    vec![
        json!({}),
        json!({
            "execute_threshold_percentage": 75,
            "rerank": {"provider": "off"},
            "memory": {"injection_budget_tokens": 8000, "git_commit_indexing": {"enabled": true}},
            "embedding": {"model": "other-model", "max_input_tokens": 1024},
            "mural": {"enabled": false},
            "prompt_surface": {"default": "full"}
        }),
        json!({
            "execute_threshold_tokens": {"anthropic/claude-opus-5-5": 160000},
            "execute_threshold_percentage": {"openai/gpt-5": 88},
            "protected_tokens": 20000,
            "caveman_text_compression": {"enabled": true},
            "commit_cluster_trigger": {"min_clusters": 2},
            "keep_reasoning_tokens": 3000
        }),
    ]
}

const MODELS: [&str; 4] = [
    "anthropic/claude-opus-5-5",
    "openai/gpt-5",
    "openrouter/anthropic/claude-3.5-sonnet",
    "google-vertex-anthropic/claude-3-5-sonnet@20240620",
];

#[test]
fn equivalent_files_resolve_to_the_same_settings_in_both_builds() {
    let vault = Vault::none();
    let path = std::path::Path::new("/settings/magic-context.jsonc");
    for (name, file) in super::convert_tests::corpus() {
        let (converted, _) = convert(&file);
        let readers = [
            ("as delivered", delivered(&converted)),
            (
                "as config_files reads it",
                UserTier::from_managed(converted.clone()),
            ),
        ];
        for (how, tier) in &readers {
            for project in projects() {
                for model in MODELS {
                    let case = format!("{name}, {how}, project {project}, {model}");
                    let expected =
                        super::resolve_tiers(Some(&file), Some(&project), model, 200_000, &vault);
                    let actual = super::resolve_tiers(
                        Some(tier.value()),
                        Some(&project),
                        model,
                        200_000,
                        &vault,
                    );
                    assert_same(&actual, &expected, &case);
                }
                assert_eq!(
                    super::catalog_config(Some(tier.value()), &[&project], path),
                    super::catalog_config(Some(&file), &[&project], path),
                    "{name}, {how}, project {project}"
                );
            }
            assert_eq!(dreamer(tier.value()), dreamer(&file), "{name}, {how}");
        }
    }
}

/// What the dreamer runs with: its budget, its projects and each task's
/// schedule. A schedule for a task not in `TASK_KINDS` is never read, and
/// the conversion drops it.
fn dreamer(user: &Value) -> Option<(u64, Option<std::collections::BTreeSet<String>>, Vec<String>)> {
    super::dreamer_settings(Some(user)).map(|settings| {
        let schedules =
            super::convert::TASK_KINDS
                .iter()
                .map(|kind| {
                    settings.schedules.get(*kind).cloned().unwrap_or_else(|| {
                        crate::dreamer::engine::default_schedule(kind).to_owned()
                    })
                })
                .collect();
        (settings.budget_tokens, settings.projects, schedules)
    })
}

/// The one place the conversion changes a meaning: a number
/// `keep_reasoning_tokens` becomes the map's `default`, so a project's map
/// now merges into it instead of replacing it.
#[test]
fn a_number_keep_reasoning_tokens_survives_a_projects_map_once_converted() {
    let vault = Vault::none();
    let file = json!({"keep_reasoning_tokens": 4000});
    let project = json!({"keep_reasoning_tokens": {"anthropic/*": 8000}});
    let today = super::resolve_tiers(Some(&file), Some(&project), "openai/gpt-5", 200_000, &vault);
    assert_eq!(today.keep_reasoning_tokens, 10_000);
    let converted = delivered(&convert(&file).0);
    let managed = super::resolve_tiers(
        Some(converted.value()),
        Some(&project),
        "openai/gpt-5",
        200_000,
        &vault,
    );
    assert_eq!(managed.keep_reasoning_tokens, 4000);
    // The project's own model still gets the project's value either way.
    let anthropic = super::resolve_tiers(
        Some(converted.value()),
        Some(&project),
        "anthropic/claude-opus-5-5",
        200_000,
        &vault,
    );
    assert_eq!(anthropic.keep_reasoning_tokens, 8000);
}

#[test]
fn whether_the_person_set_a_threshold_shows_the_same_in_both_builds() {
    let vault = Vault::none();
    for file in [
        json!({}),
        json!({"execute_threshold_percentage": 65}),
        json!({"execute_threshold_percentage": {"anthropic/claude-opus-5-5": 80}}),
    ] {
        let (converted, _) = convert(&file);
        let tier = delivered(&converted);
        for model in MODELS {
            assert_eq!(
                super::resolve_tiers(Some(tier.value()), None, model, 200_000, &vault)
                    .execute_threshold_source,
                super::resolve_tiers(Some(&file), None, model, 200_000, &vault)
                    .execute_threshold_source,
                "{file}, {model}"
            );
        }
    }
}
