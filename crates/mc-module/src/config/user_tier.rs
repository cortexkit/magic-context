//! The person's own settings, in the one shape every resolver reads.
//!
//! A default build reads the user file in its 0.49 shape; a build with
//! `managed-settings` reads the shape ck-mc declares to the daemon, from the
//! view the daemon delivers. Both arrive here as a [`UserTier`], so the
//! resolvers (`resolve_tiers`, `catalog_config`, the dreamer's settings, the
//! embedding and rerank providers) are the same code either way, and
//! equivalent files resolve to the same settings.
//!
//! The tier holds the 0.49 shape. That shape can say everything the managed
//! one can (`"off"` is `false`, a vault credential is `{vault:<id>}`, a union
//! is its old spelling), while the managed shape can't say everything the
//! 0.49 one could (a literal key, `{env:…}`), so translating the managed
//! shape into it loses nothing.

use std::path::Path;

use serde_json::Value;

#[cfg(any(test, feature = "managed-settings"))]
use serde_json::{json, Map};

/// The user tier: the user's settings, in the shape the resolvers read.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct UserTier(Value);

impl UserTier {
    /// The user file as this build reads it: `{env:…}` and `{file:…}`
    /// expanded ([`super::expand_user`]), and with managed settings, the
    /// managed shape translated ([`Self::from_managed`]).
    pub(crate) fn from_file(value: Value, user_path: &Path) -> Self {
        let value = super::expand_user(value, user_path);
        #[cfg(feature = "managed-settings")]
        let value = Self::from_managed(value).0;
        Self(value)
    }

    /// The settings as the resolvers read them.
    pub(crate) fn value(&self) -> &Value {
        &self.0
    }

    /// Settings in the managed shape, translated member by member. A value
    /// that is not in the managed shape passes through as it is, so a file
    /// still in the 0.49 shape reads as before.
    #[cfg(any(test, feature = "managed-settings"))]
    pub(crate) fn from_managed(mut value: Value) -> Self {
        let Some(root) = value.as_object_mut() else {
            return Self(Value::Object(Map::new()));
        };
        if root.get("clock_note").and_then(Value::as_str) == Some("off") {
            root.insert("clock_note".into(), json!(false));
        }
        if let Some(tokens) = root.get("protected_tokens") {
            match union_kind(tokens) {
                Some("auto") => {
                    root.remove("protected_tokens");
                }
                Some("tokens") => {
                    let tokens = tokens["tokens"].clone();
                    root.insert("protected_tokens".into(), tokens);
                }
                _ => {}
            }
        }
        if let Some(embedding) = root.get_mut("embedding").and_then(Value::as_object_mut) {
            text_choice(embedding, "query_instruction");
            text_choice(embedding, "document_prefix");
            api_key(embedding);
        }
        if let Some(rerank) = root.get_mut("rerank").and_then(Value::as_object_mut) {
            match rerank.remove("enabled") {
                Some(Value::Bool(false)) => {
                    rerank.insert("provider".into(), json!("off"));
                }
                Some(Value::Bool(true)) | None => {}
                // Not the managed shape: put it back for the reader to
                // ignore, as it ignores every key it doesn't know.
                Some(other) => {
                    rerank.insert("enabled".into(), other);
                }
            }
            api_key(rerank);
        }
        if let Some(dreamer) = root.get_mut("dreamer").and_then(Value::as_object_mut) {
            if let Some(Value::Bool(enabled)) = dreamer.get("enabled").cloned() {
                dreamer.remove("enabled");
                if !enabled {
                    dreamer.insert("disable".into(), json!(true));
                }
            }
            if !dreamer.contains_key("maxTokens") {
                if let Some(budget) = dreamer.remove("max_tokens") {
                    dreamer.insert("maxTokens".into(), budget);
                }
            }
            if let Some(projects) = dreamer.get("projects") {
                match union_kind(projects) {
                    Some("all") => {
                        dreamer.remove("projects");
                    }
                    Some("listed") => {
                        let listed = projects["projects"].clone();
                        dreamer.insert("projects".into(), listed);
                    }
                    _ => {}
                }
            }
        }
        Self(value)
    }

    /// The effective user view the daemon delivered. A value the view holds
    /// only because it is the schema's default is left out, so the
    /// resolvers see what the person set, as they do with a file: whether
    /// the person chose a threshold shows in the apps' session metadata
    /// (`execute_threshold_source`). The schema's defaults are the
    /// resolvers' own, so leaving them out changes no value.
    #[cfg(any(test, feature = "managed-settings"))]
    pub(crate) fn from_view(
        effective: &Value,
        sources: &std::collections::BTreeMap<String, subc_client_rs::config::Layer>,
    ) -> Self {
        let mut value = effective.clone();
        if !keep_set(&mut value, "", sources) {
            value = Value::Object(Map::new());
        }
        Self::from_managed(value)
    }
}

/// Remove from `value` every leaf whose source is the schema's default, and
/// every object left empty. `false` when nothing at all remains.
#[cfg(any(test, feature = "managed-settings"))]
fn keep_set(
    value: &mut Value,
    path: &str,
    sources: &std::collections::BTreeMap<String, subc_client_rs::config::Layer>,
) -> bool {
    use subc_client_rs::config::Layer;
    let is_reference = value
        .as_object()
        .is_some_and(|map| map.len() == 1 && map.contains_key("vault_ref"));
    match value {
        Value::Object(map) if !is_reference => {
            map.retain(|key, child| keep_set(child, &super::edit::child(path, key), sources));
            !map.is_empty()
        }
        _ => sources.get(path) != Some(&Layer::Default),
    }
}

#[cfg(any(test, feature = "managed-settings"))]
fn union_kind(value: &Value) -> Option<&str> {
    value.get("kind").and_then(Value::as_str)
}

/// `query_instruction` and `document_prefix`: auto is absent, none is
/// `false`, text is the text.
#[cfg(any(test, feature = "managed-settings"))]
fn text_choice(section: &mut Map<String, Value>, key: &str) {
    let Some(choice) = section.get(key) else {
        return;
    };
    let replacement = match union_kind(choice) {
        Some("auto") => None,
        Some("none") => Some(json!(false)),
        Some("text") => Some(choice["text"].clone()),
        _ => return,
    };
    match replacement {
        Some(value) => section.insert(key.into(), value),
        None => section.remove(key),
    };
}

/// `api_key`: none is absent, a vault credential is `{vault:<id>}`, the
/// spelling the resolvers read a vault key from.
#[cfg(any(test, feature = "managed-settings"))]
fn api_key(section: &mut Map<String, Value>) {
    let Some(key) = section.get("api_key") else {
        return;
    };
    match union_kind(key) {
        Some("none") => {
            section.remove("api_key");
        }
        Some("vault") => {
            let id = key["key"]["vault_ref"].as_str().unwrap_or_default();
            if super::convert::vault_id(id) {
                let reference = format!("{{vault:{id}}}");
                section.insert("api_key".into(), json!(reference));
            } else {
                // Review refuses such an id; were one to arrive anyway, no
                // key is sent rather than the id as if it were the key.
                tracing::warn!("ck-mc: an api_key names a vault credential id ck-mc can't read; no key is sent");
                section.remove("api_key");
            }
        }
        _ => {}
    }
}
