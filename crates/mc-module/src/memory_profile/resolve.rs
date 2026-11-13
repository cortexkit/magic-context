use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{bundled, list, text, Profile};
use crate::memory_context::{ContextAnswer, ProjectContext, SessionContext};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProfilePin {
    pub name: Option<String>,
    pub version: Option<String>,
    pub digest: Option<String>,
    pub resolution: Option<String>,
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pin: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub candidates: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryContext {
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
            tracing::info!(
                "ck-mc: memory-profile pin {} has no registry status record",
                text(pin, "name")
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

/// The profile a session's prompts render from: the one its memory context
/// chose, or the bundled coding profile when it chose none (no context yet, or
/// a pin that is in conflict, blocked, unavailable or unresolved). The module
/// installs no profiles of its own yet, so a chosen profile is always one of
/// the bundled packages.
pub(crate) fn prompt_profile(context: Option<&MemoryContext>) -> super::Result<Profile> {
    let chosen = context.and_then(|context| {
        let pin = &context.profile;
        let (name, version, digest) = (
            pin.name.as_ref()?,
            pin.version.as_ref()?,
            pin.digest.as_ref()?,
        );
        let packages = bundled::packages();
        let at = packages
            .iter()
            .position(|p| p.env["name"] == name.as_str() && p.env["version"] == version.as_str())?;
        let profile = super::load_chain(&packages[..=at]).ok()?;
        (&profile.digest == digest).then_some(profile)
    });
    match chosen {
        Some(profile) => Ok(profile),
        None => bundled::swe(),
    }
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
