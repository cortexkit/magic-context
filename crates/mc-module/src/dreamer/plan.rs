//! The plan a code-reading dreamer run creates its child with.
//!
//! Some task kinds judge memories against the project's files (verify a
//! memory, map it to the files that back it). Their child gets tools: the
//! `reader` preset (read and search, no shell and no edits) of a tool
//! provider, in the folder the batch reads. Its system prompt comes from
//! Magic Context itself, as the plan's
//! one system-text item, because a runner admits no inline system prompt
//! next to a plan. The item carries the prompt in its own params and Magic
//! Context's catalog serves it back as sent, so the text needs no state in
//! the module and survives a module restart between the send and the
//! runner's fetch.
//!
//! A runner fetches each item of a plan itself, under the child's scope, and
//! freezes what it fetched. Before that it checks the plan's composition:
//! every provider the items name, with the tools each serves, in canonical
//! order, and the composition's digest. The Agent Runner and Broca both refuse
//! a plan without them, and refuse one whose provider set differs from the
//! items'. This module learns the reader's tools by fetching the same catalog
//! first, under the same scope ([`reader_tools`] checks that answer).
//!
//! Which module is the reader is decided by capability, never by its name
//! ([`select_reader`]), as Prefrontal core chooses its workers' repository
//! reader: every module the daemon lists as a tool provider is asked, in
//! module-id order, which presets it serves, and one that lists `reader` is
//! asked for that catalog. The first whose reader catalog reads code
//! (`code.read/v1`) and offers nothing that changes the project is chosen.
//! Without one, a task that reads code does not run.

use cortexkit_role_compaction::read::SessionRef;
use cortexkit_role_tool_provider::catalog::{check_presets, composition_digest, CatalogAnswer};
use serde_json::{json, Value};

use crate::client::{Child, RunnerClient};

/// The fleet's reader role, which a tool provider serves as read and search
/// tools only. Providers name the canonical roles alike, so it is Magic
/// Context's own.
pub fn reader_preset() -> &'static str {
    crate::catalog::Preset::Reader.as_str()
}

/// The capability tag of a tool that returns file contents
/// (`cortexkit_role_tool_provider::DEFINED_CAPABILITY_TAGS`): a reader
/// without one can't read the code a memory names.
const CODE_READ: &str = "code.read/v1";

/// The child identity the reader choice asks each provider's catalog under:
/// no run has a child yet when the choice is made.
const SELECT_HARNESS: &str = "magic-context";
const SELECT_SESSION: &str = "mc-dream:reader";

/// Tools that change files or run commands. A reader catalog that offers any
/// is refused: a dreamer child only reads, whatever the provider's preset
/// happens to serve.
const WRITING_TOOLS: &[&str] = &[
    "bash",
    "edit",
    "write",
    "delete",
    "move",
    "apply_patch",
    "ast_replace",
];
/// Capability tags that say a tool changes files or runs commands.
const WRITING_TAGS: &[&str] = &["code.edit/v1", "shell.exec/v1"];

/// One tool the reader serves, as the composition lists it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReaderTool {
    pub name: String,
    pub capabilities: Vec<String>,
}

/// The tools of `provider`'s answer to a `reader` catalog request. Refused
/// when the answer is not that preset's (it lists the provider's presets,
/// which only an answer to a request without one does), offers no tool
/// tagged [`CODE_READ`], or offers any tool that could change the project.
pub fn reader_tools(provider: &str, answer: &CatalogAnswer) -> Result<Vec<ReaderTool>, String> {
    if check_presets(answer, Some(reader_preset())).is_err() {
        return Err(format!(
            "{provider} did not answer with its {} preset",
            reader_preset()
        ));
    }
    if answer.tools.is_empty() {
        return Err(format!("{provider} served no {} tools", reader_preset()));
    }
    let mut tools = Vec::with_capacity(answer.tools.len());
    for tool in &answer.tools {
        if WRITING_TOOLS.contains(&tool.name.as_str()) {
            return Err(format!(
                "{provider}'s {} catalog offers {}, which changes the project",
                reader_preset(),
                tool.name
            ));
        }
        if let Some(tag) = tool
            .capabilities
            .iter()
            .find(|tag| WRITING_TAGS.contains(&tag.as_str()))
        {
            return Err(format!(
                "{provider}'s {} tool {} is tagged {tag}",
                reader_preset(),
                tool.name
            ));
        }
        tools.push(ReaderTool {
            name: tool.name.clone(),
            capabilities: tool.capabilities.clone(),
        });
    }
    if !tools
        .iter()
        .any(|tool| tool.capabilities.iter().any(|tag| tag == CODE_READ))
    {
        return Err(format!(
            "{provider}'s {} catalog has no tool tagged {CODE_READ}",
            reader_preset()
        ));
    }
    Ok(tools)
}

/// The tool provider a code-reading run in `root` reads with: the first, by
/// module id, of the modules the daemon lists as ready tool providers that
/// list the `reader` preset in their catalog for `root` and whose `reader`
/// catalog passes [`reader_tools`]. A preset is asked for only of a provider
/// that lists it, as the tool-provider role requires. Magic Context's own
/// module is never asked: it serves the plan's text, not code. `Err` says
/// what was missing, naming each provider asked and why it was passed over.
pub(crate) async fn select_reader<C: RunnerClient>(
    client: &C,
    root: &str,
) -> Result<String, String> {
    let mut candidates = client.tool_providers().await.map_err(|error| {
        format!("no code-reading tools: listing the tool providers failed: {error}")
    })?;
    candidates.retain(|module| module != crate::MODULE_ID);
    candidates.sort();
    candidates.dedup();
    if candidates.is_empty() {
        return Err(format!(
            "no code-reading tools: no module provides {}",
            cortexkit_role_tool_provider::PROVIDES
        ));
    }
    let child = Child {
        session: SessionRef::new(crate::MODULE_ID, SELECT_HARNESS, SELECT_SESSION),
        project_root: Some(root.to_owned()),
    };
    let mut passed_over = Vec::new();
    for candidate in candidates {
        match client.tool_catalog(&child, &candidate, None).await {
            Ok(listing) if listing.lists_preset(reader_preset()) => {}
            Ok(_) => {
                passed_over.push(format!("{candidate} serves no {} preset", reader_preset()));
                continue;
            }
            Err(error) => {
                passed_over.push(format!("{candidate}: {error}"));
                continue;
            }
        }
        match client
            .tool_catalog(&child, &candidate, Some(reader_preset()))
            .await
        {
            Ok(answer) => match reader_tools(&candidate, &answer) {
                Ok(_) => return Ok(candidate),
                Err(refusal) => passed_over.push(refusal),
            },
            Err(error) => passed_over.push(format!("{candidate}: {error}")),
        }
    }
    Err(format!(
        "no code-reading tools: no tool provider serves a {} catalog with a {CODE_READ} tool and nothing that changes the project ({})",
        reader_preset(),
        passed_over.join("; ")
    ))
}

/// The plan for a child that reads with `tools` of module `reader` under
/// `system`. `module_id` is Magic Context's own module, which serves that
/// text.
pub fn plan(
    tools: &[ReaderTool],
    reader: &str,
    module_id: &str,
    system: &str,
) -> Result<Value, String> {
    let composition = composition(tools, reader, module_id)?;
    let digest = composition_digest(&composition).map_err(|error| error.to_string())?;
    Ok(json!({
        "composition": composition,
        "composition_digest": digest,
        "step_transform_items": [],
        "system_text_items": [{
            "params": {crate::catalog::DREAMER_TEXT_PARAM: system},
            // Magic Context's text-only role for a dreamer child.
            "preset": crate::catalog::Preset::Dreamer.as_str(),
            "provider": module_id,
        }],
        "tool_items": [{
            "params": {},
            "preset": reader_preset(),
            "provider": reader,
        }],
    }))
}

/// The composition the Agent Runner and Broca check: providers sorted by name, each one's
/// tools sorted by name with their capabilities sorted, and no repeats.
/// Magic Context is listed with no tools, since its item is text only.
fn composition(tools: &[ReaderTool], provider: &str, module_id: &str) -> Result<Value, String> {
    let mut reader: Vec<ReaderTool> = tools.to_vec();
    reader.sort_by(|a, b| a.name.cmp(&b.name));
    if let Some(pair) = reader.windows(2).find(|pair| pair[0].name == pair[1].name) {
        return Err(format!("{provider} listed the tool {} twice", pair[0].name));
    }
    let reader: Vec<Value> = reader
        .into_iter()
        .map(|mut tool| {
            tool.capabilities.sort();
            tool.capabilities.dedup();
            json!({"capabilities": tool.capabilities, "name": tool.name})
        })
        .collect();
    let mut providers = vec![
        json!({"provider": provider, "tools": reader}),
        json!({"provider": module_id, "tools": []}),
    ];
    providers.sort_by(|a, b| a["provider"].as_str().cmp(&b["provider"].as_str()));
    if providers[0]["provider"] == providers[1]["provider"] {
        return Err(format!("{module_id} can't also be the reader"));
    }
    Ok(json!({"providers": providers, "step_transform_items": []}))
}

#[cfg(test)]
#[path = "plan_tests.rs"]
mod tests;
