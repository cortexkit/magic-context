use std::future::Future;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{bundled, list, text, Profile};

pub(crate) fn parity_mode() -> bool {
    true
}
use crate::memory_context::{ContextAnswer, MemoryContextReader, ProjectContext, SessionContext};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ProfilePin {
    pub name: Option<String>,
    pub version: Option<String>,
    pub digest: Option<String>,
    pub resolution: Option<String>,
    pub state: String,
    pub parity: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pin: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub candidates: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct MemoryContext {
    pub profile: ProfilePin,
    /// Frozen effective ids, including legacy writer tags from category_map.
    #[serde(default)]
    pub category_ids: Option<std::collections::BTreeMap<String, String>>,
    pub project_id: Option<String>,
    pub workspace_id: Option<String>,
    pub domain: Option<String>,
    pub members_digest: Option<String>,
    pub stamp: Value,
    pub snapshot_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub catalog_generations: Vec<Value>,
}

pub(crate) fn resolve(
    project: &ContextAnswer<ProjectContext>,
    session: &ContextAnswer<SessionContext>,
    installed: &[Profile],
) -> MemoryContext {
    let mut context = MemoryContext {
        profile: ProfilePin {
            name: None,
            version: None,
            digest: None,
            resolution: None,
            state: "resolved".into(),
            parity: parity_mode(),
            pin: None,
            candidates: vec![],
        },
        category_ids: Some(Default::default()),
        project_id: None,
        workspace_id: None,
        domain: None,
        members_digest: None,
        stamp: Value::Null,
        snapshot_digest: None,
        catalog_generations: vec![],
    };
    let ContextAnswer::Answer(reply) = project else {
        select(
            &mut context,
            &bundled::swe().expect("bundled SWE"),
            "bundled_default",
        );
        context.profile.state = "entorhinal_not_answering".into();
        return context;
    };
    let value = serde_json::to_value(reply).expect("project reply JSON");
    context.project_id = value["project_id"].as_str().map(str::to_owned);
    context.workspace_id = value["workspace_id"].as_str().map(str::to_owned);
    context.domain = value["domain"].as_str().map(str::to_owned);
    context.members_digest = value["members_digest"].as_str().map(str::to_owned);
    context.stamp = value["stamp"].clone();
    context.snapshot_digest = Some(crate::memory_context::snapshot_digest(reply));
    let mut pins = vec![];
    if let ContextAnswer::Answer(session) = session {
        context.catalog_generations = serde_json::to_value(&session.catalog_generations)
            .expect("catalog generations JSON")
            .as_array()
            .unwrap()
            .clone();
        for pin in &session.pins {
            let value = serde_json::to_value(pin).expect("pin JSON");
            if value["kind"] != "memory-profile" {
                continue;
            }
            if !pins.iter().any(|p: &Value| {
                p["name"] == value["name"]
                    && p["version"] == value["version"]
                    && p["manifest_sha256"] == value["manifest_sha256"]
            }) {
                pins.push(value);
            }
        }
    }
    if pins.len() > 1 {
        context.profile.state = "conflict".into();
        context.profile.candidates = pins.iter().map(|p| text(p, "name").into()).collect();
        return context;
    }
    if let Some(pin) = pins.first() {
        context.profile.pin = Some(pin.clone());
        if pin["status"].is_null() {
            tracing::warn!(
                profile = text(pin, "name"),
                "memory-profile pin has no registry status record"
            );
        }
        if pin["status"]["blocked"] == true {
            if context
                .domain
                .as_deref()
                .is_none_or(|d| d == "@cortexkit/domain-software")
            {
                let source = if context.domain.is_none() {
                    "bundled_default"
                } else {
                    "domain_default"
                };
                select(&mut context, &bundled::swe().expect("bundled SWE"), source);
            } else {
                context.profile.state = "blocked".into();
                context.profile.pin = Some(pin.clone());
            }
            return context;
        }
        let packages = bundled::packages();
        let matching_bundle = packages.iter().find(|p| {
            p.env["name"] == pin["name"]
                && p.env["version"] == pin["version"]
                && pin["manifest_sha256"] == bundled::pin_manifest_digest(p)
        });
        if let Some(package) = matching_bundle {
            let chain: Vec<_> = packages
                .iter()
                .take_while(|p| p.env["name"] != package.env["name"])
                .cloned()
                .chain([package.clone()])
                .collect();
            if let Ok(profile) = super::load_chain(&chain) {
                select(&mut context, &profile, "agent_pin");
                return context;
            }
        }
        if !packages.iter().any(|p| p.env["name"] == pin["name"]) {
            if let Some(profile) = installed.iter().find(|p| {
                p.name == text(pin, "name")
                    && p.version == text(pin, "version")
                    && p.packages
                        .last()
                        .is_some_and(|p| pin["manifest_sha256"] == bundled::pin_manifest_digest(p))
            }) {
                select(&mut context, profile, "agent_pin");
                return context;
            }
        }
        context.profile.state = "unavailable".into();
        context.profile.pin = Some(pin.clone());
        return context;
    }
    // A persona without a memory-profile pin does not nominate a profile.
    let Some(domain) = context.domain.as_deref() else {
        select(
            &mut context,
            &bundled::swe().expect("bundled SWE"),
            "bundled_default",
        );
        return context;
    };
    let swe = bundled::swe().expect("bundled SWE");
    let mut candidates: Vec<&Profile> = installed
        .iter()
        .chain([&swe])
        .filter(|p| {
            list(&p.body, "default_for").iter().any(|d| d == domain)
                && list(&p.body, "serves").iter().any(|d| d == domain)
        })
        .collect();
    candidates
        .sort_by(|a, b| (&a.name, &a.version, &a.digest).cmp(&(&b.name, &b.version, &b.digest)));
    candidates.dedup_by(|a, b| a.name == b.name && a.version == b.version && a.digest == b.digest);
    match candidates.as_slice() {
        [] => context.profile.state = "unresolved".into(),
        [profile] => select(&mut context, profile, "domain_default"),
        _ => {
            context.profile.state = "conflict".into();
            context.profile.candidates = candidates.iter().map(|p| p.name.clone()).collect();
        }
    }
    context
}

fn select(context: &mut MemoryContext, profile: &Profile, source: &str) {
    context.profile.name = Some(profile.name.clone());
    context.profile.version = Some(profile.version.clone());
    context.profile.digest = Some(profile.digest.clone());
    context.profile.resolution = Some(source.into());
    let mut ids = std::collections::BTreeMap::new();
    for category in list(&profile.body, "categories") {
        let tag = text(category, "tag");
        if let Some(id) = profile.effective_category(tag) {
            ids.insert(tag.into(), id.into());
        }
    }
    if let Some(map) = profile.body["category_map"].as_object() {
        for tag in map.keys() {
            if let Some(id) = profile.effective_category(tag) {
                ids.insert(tag.clone(), id.into());
            }
        }
    }
    context.category_ids = Some(ids);
}

pub(crate) trait ContextSource {
    fn project(&self, folder: &str) -> impl Future<Output = ContextAnswer<ProjectContext>> + Send;
    fn session(&self, agent_id: &str)
        -> impl Future<Output = ContextAnswer<SessionContext>> + Send;
}
impl ContextSource for MemoryContextReader {
    async fn project(&self, folder: &str) -> ContextAnswer<ProjectContext> {
        self.project(folder).await
    }
    async fn session(&self, agent_id: &str) -> ContextAnswer<SessionContext> {
        self.session(agent_id).await
    }
}

pub(crate) async fn project_profile(
    source: &impl ContextSource,
    project: &str,
    installed: &[Profile],
) -> MemoryContext {
    resolve(
        &source.project(project).await,
        &ContextAnswer::NotAnswering,
        installed,
    )
}

/// Rebinding returns the memory-profile context already stored for the session,
/// including after a process restart.
pub(crate) async fn bind(
    source: &impl ContextSource,
    store: &mc_store::McStore,
    session_id: &str,
    folder: &str,
    agent_id: Option<&str>,
) -> std::result::Result<MemoryContext, mc_store::McStoreError> {
    let context = resolve_session_pin(source, store, session_id, folder, agent_id).await?;
    persist_session_pin(store, session_id, &context)
}

pub(crate) async fn resolve_session_pin(
    source: &impl ContextSource,
    store: &mc_store::McStore,
    session_id: &str,
    folder: &str,
    agent_id: Option<&str>,
) -> std::result::Result<MemoryContext, mc_store::McStoreError> {
    if let Some(context) = store.load_meta(session_id)?.meta.memory_context {
        return serde_json::from_value(context)
            .map_err(|e| mc_store::McStoreError::Serde(e.to_string()));
    }
    let project = source.project(folder).await;
    let session = match agent_id {
        Some(agent) => source.session(agent).await,
        None => ContextAnswer::NotAnswering,
    };
    let resolved = resolve(&project, &session, &[]);
    Ok(resolved)
}

pub(crate) fn persist_session_pin(
    store: &mc_store::McStore,
    session_id: &str,
    resolved: &MemoryContext,
) -> std::result::Result<MemoryContext, mc_store::McStoreError> {
    loop {
        let mut current = store.load_meta(session_id)?;
        // A concurrent bind may have committed while the provider was answering.
        if let Some(context) = current.meta.memory_context {
            return serde_json::from_value(context)
                .map_err(|e| mc_store::McStoreError::Serde(e.to_string()));
        }
        current.meta.memory_context =
            Some(serde_json::to_value(resolved).expect("memory context JSON"));
        match store.commit_meta(session_id, current.row_version, &current.meta) {
            Ok(_) => return Ok(resolved.clone()),
            Err(mc_store::McStoreError::CasConflict { .. }) => continue,
            Err(error) => return Err(error),
        }
    }
}
