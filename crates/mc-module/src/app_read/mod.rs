//! A session-independent, read-only lane for the operator's apps.

pub mod admission;
mod agent_ids;
mod cache_why;
mod compartment;
mod config;
mod context_states;
mod dreamer;
pub mod envelope;
mod health;
mod locator;
mod part_ref;
#[cfg(test)]
mod part_ref_tests;
mod project_memory;
#[cfg(test)]
mod samples_tests;
pub(crate) mod search;
mod session_data;
mod version;

use subc_client_rs::HandlerOutcome;

pub const SERVICE_ID: &str = "mc-app-read";
pub const APP_READ_METHODS: &[&str] = &[
    "context.states",
    "context.compartment",
    "context.search",
    "context.cache_why",
    "session_data.read",
    "project_memory.read",
    "dreamer.read",
    "store.health",
    "config.read",
    "config.embedding_probe",
];

pub fn handle(caller: &admission::AppCaller, allow_direct: bool, body: &[u8]) -> HandlerOutcome {
    if let Err(refusal) = caller.recheck(allow_direct) {
        return refusal;
    }
    let request = match envelope::parse(body) {
        Ok(request) => request,
        Err(refusal) => return refusal,
    };
    // The lane is available before its operations. Fail closed until an operation
    // has a read-only implementation, rather than forwarding to session dispatch.
    let _params = request.params;
    envelope::unknown_method(&request.method)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{config::McModuleConfig, McHandler, SessionBinding};
    use subc_client_rs::ModuleHandler;
    use subc_protocol::Principal;
    use syn::visit::Visit;

    fn code(outcome: HandlerOutcome) -> String {
        match outcome {
            HandlerOutcome::Error { code, .. } | HandlerOutcome::ErrorWithDetail { code, .. } => {
                code
            }
            other => panic!("expected refusal, got {other:?}"),
        }
    }

    // The handler's process-wide historian budget reads user config on first use.
    // Construct handlers only in fresh children with an empty temporary home.
    fn isolated(test: &str) -> bool {
        if std::env::var("MC_APP_READ_ISOLATED_TEST").as_deref() == Ok(test) {
            return false;
        }
        let home = tempfile::tempdir().unwrap();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", test, "--nocapture"])
            .env("MC_APP_READ_ISOLATED_TEST", test)
            .env("HOME", home.path())
            .env("USERPROFILE", home.path())
            .env("XDG_CONFIG_HOME", home.path())
            .env("XDG_DATA_HOME", home.path())
            .output()
            .unwrap();
        assert!(
            String::from_utf8_lossy(&output.stdout).contains("running 1 test"),
            "isolated test filter did not run {test}"
        );
        assert!(
            output.status.success(),
            "isolated {test}:\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        true
    }

    async fn app_handler() -> McHandler {
        let handler = McHandler::new();
        let decision = handler.on_bind(&admission::tests::phone_bind()).await;
        assert!(format!("{decision:?}").contains("Accept"), "{decision:?}");
        assert!(!handler.bindings.lock().unwrap().contains_key(&1));
        handler
    }

    #[tokio::test]
    async fn app_op_unknown_never_falls_through() {
        if isolated("app_read::tests::app_op_unknown_never_falls_through") {
            return;
        }
        let handler = app_handler().await;
        for method in [
            "transform",
            "mc.flush",
            "ctx_reduce",
            "session.flush",
            "session.read",
            "reply.page",
            "other",
        ] {
            let body =
                serde_json::to_vec(&serde_json::json!({"method":method,"params":{}})).unwrap();
            assert_eq!(
                code(handler.handle_channel(1, body).await),
                "app_op_unknown",
                "{method}"
            );
        }
        for method in APP_READ_METHODS {
            let body =
                serde_json::to_vec(&serde_json::json!({"method":method,"params":{}})).unwrap();
            assert_eq!(
                code(handler.handle_channel(1, body).await),
                "app_op_unknown",
                "unimplemented {method}"
            );
        }
    }

    #[tokio::test]
    async fn app_methods_refused_on_plugin_harness_and_flow_routes() {
        if isolated("app_read::tests::app_methods_refused_on_plugin_harness_and_flow_routes") {
            return;
        }
        let handler = McHandler::new();
        for (channel, harness, principal, scope) in [
            (2, "opencode", Some(Principal::Direct), None),
            (
                3,
                "thalamus",
                Some(Principal::Reserved {
                    module_id: "thalamus-harness".into(),
                }),
                None,
            ),
            (
                4,
                "basal",
                Some(Principal::Reserved {
                    module_id: "basal".into(),
                }),
                Some(admission::tests::scope("flow_id")),
            ),
        ] {
            handler.bind_route(
                channel,
                SessionBinding {
                    principal,
                    scope,
                    project_root: "fixture-project".into(),
                    harness: harness.into(),
                    session: "fixture-session".into(),
                    model_key: None,
                    config: McModuleConfig::default(),
                    history_budget_tokens: 1000.0,
                },
            );
            for method in APP_READ_METHODS {
                let body =
                    serde_json::to_vec(&serde_json::json!({"method":method,"params":{}})).unwrap();
                assert_eq!(
                    code(handler.handle_channel(channel, body).await),
                    "app_caller_forbidden",
                    "{harness}: {method}"
                );
            }
        }
    }

    #[tokio::test]
    async fn route_gone_removes_app_channel_before_reuse() {
        if isolated("app_read::tests::route_gone_removes_app_channel_before_reuse") {
            return;
        }
        let handler = app_handler().await;
        handler
            .on_route_gone(&admission::tests::phone_bind().handle)
            .await;
        let body = br#"{"method":"context.states","params":{}}"#.to_vec();
        assert_eq!(code(handler.handle_channel(1, body).await), "route_unbound");
        assert!(!handler.app_channels.lock().unwrap().contains_key(&1));
    }

    #[test]
    fn app_manifest_is_internal_and_not_agent_facing() {
        let manifest = crate::manifest_with_route_targets_and_smart_notes(
            crate::DEFAULT_MODULE_ID,
            &crate::route_targets::RouteTargetConfig::default(),
            true,
        );
        let value = serde_json::to_value(manifest).unwrap();
        let provides = value["provides"].as_array().unwrap();
        let app = provides
            .iter()
            .find(|role| role["service_id"] == SERVICE_ID)
            .expect("app service manifest");
        assert_eq!(app["agent_facing"], false);
        assert_eq!(app["transport"], "bulk");
        assert_eq!(app["operations"], serde_json::json!(APP_READ_METHODS));
        for role in provides
            .iter()
            .filter(|role| role["service_id"] != SERVICE_ID)
        {
            let encoded = serde_json::to_string(role).unwrap();
            for method in APP_READ_METHODS {
                assert!(!encoded.contains(method), "{method} leaked to another role");
            }
        }
    }

    #[test]
    fn trait_handle_is_exact_channel_delegation() {
        let source = syn::parse_file(include_str!("../lib.rs")).unwrap();
        let module_handler = source
            .items
            .iter()
            .find_map(|item| match item {
                syn::Item::Impl(item)
                    if item.trait_.as_ref().is_some_and(|(_, path, _)| {
                        path.segments.last().unwrap().ident == "ModuleHandler"
                    }) =>
                {
                    Some(item)
                }
                _ => None,
            })
            .unwrap();
        let handle = module_handler
            .items
            .iter()
            .find_map(|item| match item {
                syn::ImplItem::Fn(f) if f.sig.ident == "handle" => Some(f),
                _ => None,
            })
            .unwrap();
        let expected: syn::Block =
            syn::parse_quote!({ self.handle_channel(ctx.route_handle().channel, body).await });
        assert_eq!(quote::quote!(#expected).to_string(), {
            let block = &handle.block;
            quote::quote!(#block).to_string()
        });
    }

    fn forbidden_name(name: &str) -> bool {
        let name = name.strip_prefix("r#").unwrap_or(name);
        matches!(
            name,
            "HostStore"
                | "execute"
                | "execute_batch"
                | "raw_execute"
                | "pragma_update"
                | "pragma_update_and_check"
                | "with_domain_transaction"
                | "try_domain_transaction"
                | "with_facade_command"
                | "with_facade_mutation"
                | "promote_facts"
                | "arm_soft_refresh"
                | "replace_compartments"
                | "truncate_compartments_for_revert"
                | "reset_session_for_recomp"
                | "merge_memories"
                | "archive_memory"
                | "archive_memories"
                | "dismiss_note"
                | "dismiss_note_cas"
                | "transition_note"
                | "claim_due_note"
                | "admit_memory"
                | "admit_provider_pass"
                | "apply_authority_state_sync"
                | "ops_flush"
                | "ops_flush_in_project"
                | "heartbeat_historian_run"
                | "reconcile_provider_drop_targets"
                | "queue_provider_drops"
                | "consume_provider_drops"
        ) || [
            "insert_",
            "update_",
            "upsert_",
            "delete_",
            "save_",
            "commit",
            "publish_",
            "record_",
            "append_",
            "set_memory_",
            "set_todo_",
            "set_provider_",
            "trace_pass_",
            "abandon_",
            "drain_",
            "acquire_",
            "renew_",
            "release_",
            "resume_",
            "clear_async_",
            "prune_",
            "copy_async_",
            "retire_",
            "async_compaction_save",
            "reserve_",
            "adopt_",
            "mark_async_",
            "finish_",
            "cancel_historian_",
            "claim_historian_",
            "republish_",
            "park_",
            "expire_historian_",
            "discard_staged_",
            "write_note_",
        ]
        .iter()
        .any(|prefix| name.starts_with(prefix))
    }

    #[derive(Default)]
    struct ReadOnlySource {
        violations: Vec<String>,
    }

    impl ReadOnlySource {
        fn tokens(&mut self, tokens: proc_macro2::TokenStream) {
            for token in tokens {
                match token {
                    proc_macro2::TokenTree::Ident(ident) if forbidden_name(&ident.to_string()) => {
                        self.violations.push(ident.to_string())
                    }
                    proc_macro2::TokenTree::Group(group) => self.tokens(group.stream()),
                    proc_macro2::TokenTree::Literal(lit) => {
                        if let Ok(lit) = syn::parse_str::<syn::LitStr>(&lit.to_string()) {
                            self.sql(&lit.value());
                        }
                    }
                    _ => {}
                }
            }
        }

        fn sql(&mut self, value: &str) {
            let words: Vec<_> = value
                .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
                .filter(|word| !word.is_empty())
                .map(str::to_ascii_uppercase)
                .collect();
            if words.windows(2).any(|pair| pair == ["BEGIN", "IMMEDIATE"]) {
                self.violations.push("immediate write transaction".into());
            }
        }
    }

    impl<'ast> Visit<'ast> for ReadOnlySource {
        fn visit_ident(&mut self, ident: &'ast syn::Ident) {
            if forbidden_name(&ident.to_string()) {
                self.violations.push(ident.to_string());
            }
        }
        fn visit_lit_str(&mut self, lit: &'ast syn::LitStr) {
            self.sql(&lit.value());
        }
        fn visit_macro(&mut self, mac: &'ast syn::Macro) {
            self.visit_path(&mac.path);
            self.tokens(mac.tokens.clone());
        }
    }

    fn scan(path: &std::path::Path) {
        for entry in std::fs::read_dir(path).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                scan(&path);
            } else if path.extension().is_some_and(|extension| extension == "rs") {
                let source = std::fs::read_to_string(&path).unwrap();
                let syntax = syn::parse_file(&source).unwrap();
                let mut visitor = ReadOnlySource::default();
                visitor.visit_file(&syntax);
                assert!(
                    visitor.violations.is_empty(),
                    "{} contains write access: {:?}",
                    path.display(),
                    visitor.violations
                );
            }
        }
    }

    #[test]
    fn app_read_sources_are_read_only() {
        scan(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/app_read"));
    }

    #[test]
    fn source_guard_detects_writer_paths_calls_and_macros() {
        for source in [
            "fn bad() { db.execute(\"SQL\", []); }",
            "type Bad = crate::host_store::HostStore;",
            "fn bad() { db.insert_memory(row); }",
            "fn bad() { m!(db.execute_batch(sql)); }",
        ] {
            let mut visitor = ReadOnlySource::default();
            visitor.visit_file(&syn::parse_file(source).unwrap());
            assert!(!visitor.violations.is_empty(), "missed {source}");
        }
        let source = format!(
            "fn bad() {{ db.query_row(\"{} {};\", [], row); }}",
            "BEGIN", "IMMEDIATE"
        );
        let mut visitor = ReadOnlySource::default();
        visitor.visit_file(&syn::parse_file(&source).unwrap());
        assert!(!visitor.violations.is_empty(), "missed write transaction");
    }
}
