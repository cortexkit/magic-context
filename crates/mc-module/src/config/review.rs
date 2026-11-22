//! The daemon's review of settings (`config.review`), the
//! schema ck-mc declares (`assets/settings-schema.json`), and the checks the
//! schema can't state.
//!
//! The daemon validates every proposal against the schema; the module merges
//! the layers ([`Schema::review_tuple`]), then checks what only it knows:
//! whether a guidance override file exists and holds exactly one
//! `## Magic Context` heading, whether a `module` names a module ck-mc may
//! call, whether a schedule is a cron expression, whether `clock_note` is an
//! interval ck-mc can use, and whether a vault credential id can be read.
//! Each problem is a refusal naming its field. An accepted proposal is
//! described as one change per field that changes.

use std::path::Path;
use std::sync::OnceLock;

use serde_json::Value;
use subc_client_rs::config::{
    ApplyKind, ConfigReviewRefusal, ConfigReviewReply, ConfigReviewRequest, ConfigView,
    FieldChange, Layer, LayerValue, RecordedValue, Schema, ValidationContext,
};

/// The schema ck-mc declares. `rerank_backend` is user-only so an overlay can
/// disable reranking without changing where the backend sends text or a key.
pub(crate) const SCHEMA_JSON: &str = include_str!("../../assets/settings-schema.json");

/// [`SCHEMA_JSON`], parsed.
pub(crate) fn schema_value() -> &'static Value {
    static VALUE: OnceLock<Value> = OnceLock::new();
    VALUE.get_or_init(|| serde_json::from_str(SCHEMA_JSON).expect("settings-schema.json parses"))
}

/// The schema as the daemon's rules read it. The file is compiled in, so a
/// schema the rules refuse is a build defect the tests catch.
pub(crate) fn schema() -> &'static Schema {
    static SCHEMA: OnceLock<Schema> = OnceLock::new();
    SCHEMA.get_or_init(|| {
        Schema::new(schema_value().clone())
            .expect("settings-schema.json follows the daemon's rules")
    })
}

/// One setting the schema declares: a value, a map, a union or a
/// credential, by its pointer, and whether it can hold a credential.
pub(crate) struct Field {
    pub pointer: String,
    pub secret: bool,
}

/// Every field, in schema order.
pub(crate) fn fields() -> &'static [Field] {
    static FIELDS: OnceLock<Vec<Field>> = OnceLock::new();
    FIELDS.get_or_init(|| {
        let mut fields = Vec::new();
        collect_fields(schema_value(), "", &mut fields);
        fields
    })
}

fn collect_fields(node: &Value, path: &str, out: &mut Vec<Field>) {
    let section = node.get("type").and_then(Value::as_str) == Some("object")
        && node.get("x-ck-kind").is_none()
        && node.get("patternProperties").is_none()
        && node.get("oneOf").is_none();
    if section {
        for (key, child) in node["properties"].as_object().into_iter().flatten() {
            collect_fields(child, &super::edit::child(path, key), out);
        }
    } else {
        out.push(Field {
            pointer: path.to_owned(),
            secret: holds_credential(node),
        });
    }
}

fn holds_credential(node: &Value) -> bool {
    node.get("x-ck-kind").and_then(Value::as_str) == Some("credential_ref")
        || ["properties", "patternProperties"].iter().any(|key| {
            node[*key]
                .as_object()
                .is_some_and(|children| children.values().any(holds_credential))
        })
        || node["oneOf"]
            .as_array()
            .is_some_and(|branches| branches.iter().any(holds_credential))
}

/// Review the proposed layers against the view in force. `user_path` is the
/// declared user file, beside which a relative guidance override path is
/// read.
pub fn review(request: &ConfigReviewRequest, user_path: &Path) -> ConfigReviewReply {
    let module_id = request.layers.first().map_or_else(
        || crate::MODULE_ID.to_owned(),
        |layer| layer.module_id.clone(),
    );
    let project_id = request
        .layers
        .iter()
        .find_map(|layer| layer.project_id.clone());
    let refuse = |refusals: Vec<(String, String, String)>| {
        let refusals = refusals
            .into_iter()
            .map(|(code, path, reason)| {
                let mut refusal = ConfigReviewRefusal::new(code, vec![path], vec![reason]);
                refusal.project_id = project_id.clone();
                refusal
            })
            .collect();
        ConfigReviewReply::new(vec![], refusals)
    };
    let mut layers = Vec::new();
    for snapshot in &request.layers {
        let Some(bytes) = &snapshot.bytes else {
            continue;
        };
        let Some(layer) = snapshot.layer.known_layer() else {
            return refuse(vec![(
                "layer_forbidden".into(),
                String::new(),
                "a settings layer of a kind ck-mc does not know".into(),
            )]);
        };
        match parse_layer(bytes) {
            Ok(value) => layers.push(LayerValue::new(layer, value)),
            Err(error) => {
                return refuse(vec![(
                    "value_invalid".into(),
                    String::new(),
                    format!(
                        "the {} settings are not valid JSONC: {error}",
                        layer_name(layer)
                    ),
                )])
            }
        }
    }
    layers.sort_by_key(|layer| layer.layer);
    let context = ValidationContext::new(module_id.clone(), project_id.clone());
    let tuple = match schema().review_tuple(&layers, &context) {
        Ok(tuple) => tuple,
        Err(refusal) => {
            let code = serde_json::to_value(refusal.code)
                .ok()
                .and_then(|code| code.as_str().map(str::to_owned))
                .unwrap_or_else(|| "value_invalid".into());
            let reason = format!("{}: {}", setting(&refusal.path), why(&code));
            return refuse(vec![(code, refusal.path, reason)]);
        }
    };
    let problems = checks(&tuple.effective, user_path);
    if !problems.is_empty() {
        return refuse(
            problems
                .into_iter()
                .map(|(path, reason)| ("value_invalid".into(), path, reason))
                .collect(),
        );
    }
    let mut changes = changes(
        &module_id,
        request.base.as_ref(),
        &tuple.effective,
        &tuple.sources,
    );
    for change in &mut changes {
        change.project_id = project_id.clone();
    }
    ConfigReviewReply::new(changes, vec![])
}

/// Snapshots contain the original file bytes, including comments and a BOM.
pub(super) fn parse_layer(bytes: &[u8]) -> Result<Value, String> {
    let text = std::str::from_utf8(bytes).map_err(|error| error.to_string())?;
    let json = subc_jsonc::jsonc_to_json(text.strip_prefix('\u{feff}').unwrap_or(text))?;
    let value: Value = serde_json::from_str(&json).map_err(|error| error.to_string())?;
    if !value.is_object() {
        return Err("expected an object".to_owned());
    }
    Ok(value)
}

fn layer_name(layer: Layer) -> &'static str {
    match layer {
        Layer::User => "user",
        Layer::Workspace => "workspace",
        Layer::Project => "project",
        _ => "default",
    }
}

fn setting(pointer: &str) -> String {
    if pointer.is_empty() {
        "the settings".to_owned()
    } else {
        pointer.to_owned()
    }
}

fn why(code: &str) -> &'static str {
    match code {
        "layer_forbidden" => "may only be set in the user's settings file",
        "bound_violated" => "breaks a bound a lower layer sets",
        "credential_shared" => "names a credential this layer may not use",
        "schema_invalid" => "the schema ck-mc declares is not valid",
        _ => "not a value this setting takes (see its description in ck-mc's settings schema)",
    }
}

/// What the schema can't state, each as the field's pointer and why it is
/// refused.
pub(crate) fn checks(effective: &Value, user_path: &Path) -> Vec<(String, String)> {
    let mut problems = Vec::new();
    let text = |pointer: &str| effective.pointer(pointer).and_then(Value::as_str);
    if let Some(configured) =
        text("/prompt_surface/guidance_override_path").filter(|path| !path.is_empty())
    {
        let path = super::guidance_override_path(configured, user_path);
        if let Err(why) = super::guidance_file(&path) {
            problems.push((
                "/prompt_surface/guidance_override_path".to_owned(),
                format!("the guidance override file {} {why}", path.display()),
            ));
        }
    }
    for pointer in ["/embedding/module", "/rerank_backend/module"] {
        if let Some(id) = text(pointer) {
            if crate::search::rerank::module_id(id).is_none() {
                problems.push((
                    pointer.to_owned(),
                    format!("{id:?} is not a module id such as \"synapse\" or fed:<fingerprint>:<module id> with a fingerprint of 32 lowercase hex characters"),
                ));
            }
        }
    }
    if let Some(note) = effective.get("clock_note").filter(|note| *note != "off") {
        if let Err(why) = crate::clock_note::parse_interval(note) {
            problems.push(("/clock_note".to_owned(), why));
        }
    }
    for kind in super::convert::TASK_KINDS {
        let pointer = format!("/dreamer/tasks/{kind}/schedule");
        if let Some(schedule) = text(&pointer) {
            let schedule = schedule.trim();
            if !schedule.is_empty() && crate::dreamer::cron::Cron::parse(schedule).is_none() {
                problems.push((
                    pointer,
                    format!("{schedule:?} is not a five-field cron expression"),
                ));
            }
        }
    }
    for pointer in ["/embedding/api_key", "/rerank_backend/api_key"] {
        if let Some(id) = text(&format!("{pointer}/key/vault_ref")) {
            if !super::convert::vault_id(id) {
                problems.push((
                    pointer.to_owned(),
                    "a vault credential id ck-mc can read is printable ASCII without spaces or braces".to_owned(),
                ));
            }
        }
    }
    problems
}

/// One change per field whose value or source differs between the view in
/// force and the reviewed effective settings. A field that can hold a
/// credential is recorded by digest only.
pub(crate) fn changes(
    module_id: &str,
    base: Option<&ConfigView>,
    effective: &Value,
    sources: &std::collections::BTreeMap<String, Layer>,
) -> Vec<FieldChange> {
    let mut changes = Vec::new();
    for field in fields() {
        let old = base
            .and_then(|base| base.effective.pointer(&field.pointer))
            .cloned()
            .unwrap_or(Value::Null);
        let new = effective
            .pointer(&field.pointer)
            .cloned()
            .unwrap_or(Value::Null);
        let old_source = base.map_or(Layer::Default, |base| source(&base.sources, &field.pointer));
        let new_source = source(sources, &field.pointer);
        if old == new && old_source == new_source {
            continue;
        }
        let record = |value: &Value| {
            if field.secret && !value.is_null() {
                RecordedValue::redacted(value).unwrap_or_else(|_| RecordedValue::new(Value::Null))
            } else {
                RecordedValue::new(value.clone())
            }
        };
        let mut change = FieldChange::new(
            module_id,
            field.pointer.clone(),
            record(&old),
            record(&new),
            ApplyKind::Live,
        );
        change.old_source = old_source;
        change.new_source = new_source;
        changes.push(change);
    }
    changes
}

/// The layer a field's value comes from: the highest layer among its
/// parts, the schema's default when nothing sets it.
fn source(sources: &std::collections::BTreeMap<String, Layer>, pointer: &str) -> Layer {
    let nested = format!("{pointer}/");
    sources
        .iter()
        .filter(|(path, _)| *path == pointer || path.starts_with(&nested))
        .map(|(_, layer)| *layer)
        .max()
        .unwrap_or(Layer::Default)
}
