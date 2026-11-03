use super::*;

#[tokio::test]
async fn surface_unknown_ctx_names_are_protocol_refusals() {
    let runner = start(config("head", Kind::OpenAi, free())).await;
    let provider = runner.provider();
    for name in ["ctx_keep", "ctx_missing"] {
        let result = provider
            .module()
            .tool(&provider.route, name, json!({}))
            .await;
        assert_eq!(result, Err(ModuleError::UnknownTool(name.into())));
    }
}

#[tokio::test]
async fn surface_unserved_preset_tools_are_unknown_not_failed_tool_results() {
    for preset in ["worker", "reader", "head"] {
        let runner = start(config(preset, Kind::OpenAi, free())).await;
        let provider = runner.provider();
        for name in if preset == "head" {
            vec!["ctx_keep", "ctx_missing"]
        } else {
            vec!["ctx_memory", "ctx_note", "ctx_missing"]
        } {
            let result = provider
                .module()
                .tool(&provider.route, name, json!({}))
                .await;
            assert_eq!(
                result,
                Err(ModuleError::UnknownTool(name.into())),
                "{preset}"
            );
        }
    }
}

#[tokio::test]
async fn surface_memory_disabled_refuses_with_the_plugin_wording() {
    let runner = start_full(
        config("head", Kind::OpenAi, free()),
        Settings {
            memory_enabled: false,
            ..Settings::default()
        },
        None,
    )
    .await;
    let provider = runner.provider();
    let result = provider
        .module()
        .tool(
            &provider.route,
            "ctx_memory",
            json!({"action":"get", "ids":[1]}),
        )
        .await;
    assert_eq!(
        result,
        Err(ModuleError::Tool(
            "Cross-session memory is disabled for this project.".into()
        ))
    );
}
