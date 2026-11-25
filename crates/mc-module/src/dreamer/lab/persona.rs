use std::collections::BTreeMap;
use std::path::Path;

use cortexkit_persona::{
    ApprovalSet, EmbeddedTier, FactsShape, FragmentSources, GrantMap, GuidanceSet, LoadRequest,
    LoadedRole, PersonaEngine, RenderContext, RenderLimits, Tier, TrustClass, MAX_FILE_BYTES,
};
use serde_json::{json, Value};

use super::spec::{input_inside, read_text, reject_live, Spec};

pub(super) struct Persona {
    role: LoadedRole,
    first_message: GuidanceSet,
}

impl Persona {
    pub(super) fn load(spec: &Spec, live: &Path) -> Result<Self, String> {
        let file = |path: &Path| {
            let path = input_inside(path, &spec.root, "persona file", false)?;
            reject_live(&path, live)?;
            read_text(&path, MAX_FILE_BYTES as usize)
        };
        // Load only the operator's chosen directory. Give the persona engine
        // the checked bytes so it cannot follow an unchecked link on render.
        let mut layer = EmbeddedTier::new()
            .with_file(
                "lab",
                "PERSONA.md",
                file(&spec.persona_dir.join("PERSONA.md"))?,
            )
            .map_err(show)?;
        let fragments = spec.persona_dir.join("fragments");
        match fragments.symlink_metadata() {
            Ok(_) => {
                let dir = input_inside(&fragments, &spec.root, "persona fragments", true)?;
                for entry in dir.read_dir().map_err(show)? {
                    let entry = entry.map_err(show)?;
                    let name = entry.file_name();
                    let Some(name) = name.to_str() else {
                        continue;
                    };
                    if let Some(id) = name.strip_suffix(".md") {
                        if id.len() <= 64
                            && !id.is_empty()
                            && id.as_bytes()[0].is_ascii_alphanumeric()
                            && id.as_bytes()[id.len() - 1].is_ascii_alphanumeric()
                            && id
                                .bytes()
                                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                        {
                            layer
                                .insert("lab", &format!("fragments/{name}"), file(&entry.path())?)
                                .map_err(show)?;
                        }
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(show(e)),
        }
        let tiers = [Tier::embedded("spec", TrustClass::Operator, layer).map_err(show)?];
        let role = PersonaEngine::new(crate::MODULE_ID)
            .map_err(show)?
            .load(LoadRequest::new("lab", &tiers, &ApprovalSet::new()))
            .map_err(show)?;
        let message = file(&spec.persona_dir.join("first-message.md"))?;
        let first_message =
            GuidanceSet::new([("first-message", message.as_str())]).map_err(show)?;
        Ok(Self {
            role,
            first_message,
        })
    }

    pub(super) fn render(
        &self,
        mut context: RenderContext<()>,
        tools: BTreeMap<String, bool>,
        context_text: &str,
        memories_text: &str,
    ) -> Result<(String, String), String> {
        context.tools = GrantMap(tools.clone());
        let system = self
            .role
            .render(&context, &FragmentSources::new())
            .map_err(show)?
            .text;
        // The closed guidance checker can loop over scalars, not lists of
        // named records. Supply one Markdown string for each ordered block list.
        let properties: BTreeMap<&str, Value> = tools
            .keys()
            .map(|name| (name.as_str(), json!({"type":"boolean"})))
            .collect();
        let shape = FactsShape::from_json_schema(&json!({"type":"object","properties":{
            "tools":{"type":"object","properties":properties},
            "context_text":{"type":"string"}, "memories_text":{"type":"string"}
        }}))
        .map_err(show)?;
        self.first_message.check(&shape).map_err(show)?;
        let message = self
            .first_message
            .render(
                "first-message",
                &json!({
                    "tools":tools, "context_text":context_text, "memories_text":memories_text,
                }),
                RenderLimits::default(),
            )
            .map_err(show)?
            .text;
        Ok((system, message))
    }
}

fn show(error: impl std::fmt::Display) -> String {
    error.to_string()
}
