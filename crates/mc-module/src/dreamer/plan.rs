//! The plan a code-reading dreamer run creates its child with.
//!
//! Some task kinds judge memories against the project's files (verify a
//! memory, map it to the files that back it). Their child gets tools: AFT's
//! `reader` preset (read and search, no shell and no edits) in the project's
//! folder. Its system prompt comes from Magic Context itself, as the plan's
//! one system-text item, because a runner admits no inline system prompt
//! next to a plan. The item carries the prompt in its own params and Magic
//! Context's catalog serves it back as sent, so the text needs no state in
//! the module and survives a module restart between the send and the
//! runner's fetch.
//!
//! A runner fetches each item of a plan itself, under the child's scope, and
//! freezes what it fetched. Before that it checks the plan's composition:
//! every provider the items name, with the tools each serves, in canonical
//! order, and the composition's digest. Both runners refuse a plan without
//! them, and refuse one whose provider set differs from the items'.
//! ck-mc learns AFT's tools by fetching the same catalog first, under the
//! same scope ([`reader_tools`] checks that answer).

use cortexkit_role_tool_provider::catalog::{composition_digest, CatalogAnswer};
use serde_json::{json, Value};

/// The module that serves the code-reading tools.
pub const READER_PROVIDER: &str = "aft";

/// The fleet's reader role, which AFT serves as read and search tools only.
/// Providers name the canonical roles alike, so it is Magic Context's own.
pub fn reader_preset() -> &'static str {
    crate::catalog::Preset::Reader.as_str()
}

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

/// The reader's tools from its catalog answer. Refused when it offers no
/// tool, or any tool that could change the project.
pub fn reader_tools(answer: &CatalogAnswer) -> Result<Vec<ReaderTool>, String> {
    if answer.tools.is_empty() {
        return Err(format!(
            "{READER_PROVIDER} served no {} tools",
            reader_preset()
        ));
    }
    let mut tools = Vec::with_capacity(answer.tools.len());
    for tool in &answer.tools {
        if WRITING_TOOLS.contains(&tool.name.as_str()) {
            return Err(format!(
                "{READER_PROVIDER}'s {} catalog offers {}, which changes the project",
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
                "{READER_PROVIDER}'s {} tool {} is tagged {tag}",
                reader_preset(),
                tool.name
            ));
        }
        tools.push(ReaderTool {
            name: tool.name.clone(),
            capabilities: tool.capabilities.clone(),
        });
    }
    Ok(tools)
}

/// The plan for a child that reads with `tools` under `system`.
/// `module_id` is Magic Context's own module, which serves that text.
pub fn plan(tools: &[ReaderTool], module_id: &str, system: &str) -> Result<Value, String> {
    let composition = composition(tools, module_id)?;
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
            "provider": READER_PROVIDER,
        }],
    }))
}

/// The composition both runners check: providers sorted by name, each one's
/// tools sorted by name with their capabilities sorted, and no repeats.
/// Magic Context is listed with no tools, since its item is text only.
fn composition(tools: &[ReaderTool], module_id: &str) -> Result<Value, String> {
    let mut reader: Vec<ReaderTool> = tools.to_vec();
    reader.sort_by(|a, b| a.name.cmp(&b.name));
    if let Some(pair) = reader.windows(2).find(|pair| pair[0].name == pair[1].name) {
        return Err(format!(
            "{READER_PROVIDER} listed the tool {} twice",
            pair[0].name
        ));
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
        json!({"provider": READER_PROVIDER, "tools": reader}),
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
