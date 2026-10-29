//! Dream prompt rendering shares the summary host's ladder and approval policy.
//! The legacy `task` and `system` helpers use the embedded tier; `load` accepts
//! the caller's tiers and checksum approvals.

use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Curate,
    Classify,
    Map,
    Verify,
    ReviewUser,
}

pub const KINDS: [Kind; 5] = [
    Kind::Curate,
    Kind::Classify,
    Kind::Map,
    Kind::Verify,
    Kind::ReviewUser,
];

impl Kind {
    fn task_name(self) -> mc_store::dream_scheduler::schedules::TaskName {
        use mc_store::dream_scheduler::schedules::TaskName;
        match self {
            Self::Curate => TaskName::Curate,
            Self::Classify => TaskName::Classify,
            Self::Map => TaskName::Map,
            Self::Verify => TaskName::Verify,
            Self::ReviewUser => TaskName::ReviewUserMemories,
        }
    }
    pub fn id(self) -> &'static str {
        match self {
            Self::Curate => "mc_dream_curate",
            Self::Classify => "mc_dream_classify",
            Self::Map => "mc_dream_map",
            Self::Verify => "mc_dream_verify",
            Self::ReviewUser => "mc_dream_review_user",
        }
    }

    fn files(self) -> [(&'static str, &'static str); 3] {
        macro_rules! files {
            ($id:literal) => {
                [
                    (
                        "PERSONA.md",
                        include_str!(concat!("../../personas/", $id, "/PERSONA.md")),
                    ),
                    (
                        "fragments/task.md",
                        include_str!(concat!("../../personas/", $id, "/fragments/task.md")),
                    ),
                    (
                        "fragments/system.md",
                        include_str!(concat!("../../personas/", $id, "/fragments/system.md")),
                    ),
                ]
            };
        }
        match self {
            Self::Curate => files!("mc_dream_curate"),
            Self::Classify => files!("mc_dream_classify"),
            Self::Map => files!("mc_dream_map"),
            Self::Verify => files!("mc_dream_verify"),
            Self::ReviewUser => files!("mc_dream_review_user"),
        }
    }

    fn contract(self) -> &'static str {
        match self {
            Self::Curate => "mc.dream.curate/v1",
            Self::Classify => "mc.dream.classify/v1",
            Self::Map => "mc.dream.map/v1",
            Self::Verify => "mc.dream.verify/v1",
            Self::ReviewUser => "mc.dream.review_user/v1",
        }
    }

    fn tools(self) -> &'static [&'static str] {
        use crate::dream_dispatch::routed::fetch_plan;
        use mc_store::dream_scheduler::schedules::TaskName;
        match self {
            Self::Curate => fetch_plan::plan(TaskName::Curate)[0].tools,
            Self::Map => fetch_plan::plan(TaskName::Map)[0].tools,
            Self::Verify => fetch_plan::plan(TaskName::Verify)[0].tools,
            Self::Classify | Self::ReviewUser => &[],
        }
    }
}

pub(super) fn with_embedded(mut base: EmbeddedTier) -> EmbeddedTier {
    for kind in KINDS {
        for (path, text) in kind.files() {
            base = base
                .with_file(kind.id(), path, text)
                .expect("fixed dream persona path");
        }
    }
    base
}

/// Preformatted memory/evidence blocks preserve the existing task wire format.
/// They are values, never parsed again as templates, even if they contain Jinja.
#[derive(Debug, Default, Serialize)]
pub struct Input<'a> {
    pub project: &'a str,
    pub category: &'a str,
    pub memories: &'a str,
    pub anchors: &'a str,
    pub candidates: &'a str,
    pub profiles: &'a str,
    pub threshold: usize,
    pub has_evidence: bool,
    pub evidence: &'a str,
}

#[derive(Debug)]
pub struct DreamPersona {
    kind: Kind,
    role: LoadedRole,
    routing: Routing,
    profile: crate::memory_profile::Profile,
    parity: bool,
}

impl DreamPersona {
    pub fn routing(&self) -> &Routing {
        &self.routing
    }
    pub fn generation(&self) -> &Generation {
        &self
            .role
            .manifest()
            .extension::<OperatorValue<Generation>>("generation")
            .expect("required generation")
            .value
    }
}

/// Like the summary mapping, an operator routing mapping replaces the lower
/// mapping. Omitted fields fall back to this dream task, not to summary demand.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DreamRouting {
    #[serde(default)]
    consumer: Option<String>,
    #[serde(default)]
    iq: Option<u8>,
    #[serde(default, deserialize_with = "declared_eq")]
    eq: Option<Option<u8>>,
}

fn declared_eq<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Option<u8>>, D::Error> {
    Option::<u8>::deserialize(d).map(Some)
}

/// Repository wording requires persona/v1 checksum approval. Cost fields still
/// pass through the same host-side ceiling as the summary persona.
pub fn load(
    kind: Kind,
    tiers: &[Tier],
    approvals: &ApprovalSet,
    project_key: Option<&ProjectKey>,
) -> Result<DreamPersona, PersonaError> {
    let role = load_role::<DreamRouting>(kind.id(), tiers, approvals, project_key)?;
    let declared = &role
        .manifest()
        .extension::<OperatorValue<DreamRouting>>("routing")
        .expect("required routing")
        .value;
    let defaults = crate::dream_dispatch::routed::registry::registration(kind.task_name())
        .expect("registered dream persona");
    let routing = Routing {
        consumer: declared
            .consumer
            .clone()
            .unwrap_or_else(|| defaults.consumer.into()),
        iq: declared.iq.unwrap_or(defaults.iq),
        eq: declared.eq.unwrap_or(defaults.eq),
    };
    validate_routing(&routing)?;
    Ok(DreamPersona {
        kind,
        role,
        routing,
        profile: crate::memory_profile::documents::bundled_swe().map_err(profile_error)?,
        parity: crate::memory_profile::documents::parity_mode(),
    })
}

#[derive(Serialize)]
struct Tool {
    name: &'static str,
    description: &'static str,
}

#[derive(Serialize)]
struct Context<'a> {
    turn: &'static str,
    mode: &'a str,
    routing: &'a Routing,
    language: LanguageContext,
    project: ProjectContext,
    tools: Vec<Tool>,
    output: DreamOutput,
    input: &'a Input<'a>,
    memory_profile: &'a MemoryProfile,
}

#[derive(Serialize)]
struct DreamOutput {
    id: &'static str,
    format: &'static str,
    schema_text: String,
}

/// Render one turn from a loaded, approved persona. `mode` is `full` or `broad`
/// for verification; the base wording deliberately remains identical for both.
pub fn render(
    persona: &DreamPersona,
    input: &Input<'_>,
    mode: &str,
    system: bool,
) -> Result<Rendered, PersonaError> {
    let kind = persona.kind;
    let profile = memory_profile(persona, mode)?;
    let mut routing = persona.routing().clone();
    if kind == Kind::Verify && mode == "broad" && routing.consumer == "mc.dream.verify" {
        routing.consumer = "mc.dream.verify-broad".into();
    }
    let module = Context {
        turn: if system { "system" } else { "task" },
        mode,
        routing: &routing,
        language: LanguageContext::default(),
        project: ProjectContext::default(),
        tools: kind
            .tools()
            .iter()
            .map(|name| Tool {
                name,
                description: if *name == "ctx_memory" {
                    "Scoped project memory operations"
                } else {
                    "Read-only repository inspection"
                },
            })
            .collect(),
        output: DreamOutput {
            id: kind.contract(),
            format: if kind == Kind::ReviewUser {
                "json"
            } else {
                "xml"
            },
            schema_text: kind.files()[2]
                .1
                .replace("\r\n", "\n")
                .trim_end_matches('\n')
                .to_owned(),
        },
        input,
        memory_profile: &profile,
    };
    let rendered = persona.role.render(
        &context_for(kind.id(), &routing, &ProjectContext::default(), module),
        &fragments_with_profile(&profile)?,
    )?;
    if system {
        guard_profile(&persona.role, &profile, rendered)
    } else {
        Ok(rendered)
    }
}

fn memory_profile(persona: &DreamPersona, mode: &str) -> Result<MemoryProfile, PersonaError> {
    let kind = match persona.kind {
        Kind::Curate => "curate",
        Kind::Classify => "classify-memories",
        Kind::Map => "map-memories",
        Kind::Verify if mode == "broad" => "verify-broad",
        Kind::Verify => "verify",
        Kind::ReviewUser => "review-user-memories",
    };
    let task = persona.profile.body["tasks"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|t| t["kind"] == kind);
    MemoryProfile::capture(
        &persona.profile,
        persona.parity,
        task.and_then(|t| t["prompts"]["system"].as_str()),
        task.and_then(|t| t["id"].as_str()),
    )
}

fn embedded(kind: Kind) -> Result<&'static DreamPersona, PersonaError> {
    static PARITY: OnceLock<Vec<DreamPersona>> = OnceLock::new();
    static RESOLVED: OnceLock<Vec<DreamPersona>> = OnceLock::new();
    let base = if crate::memory_profile::documents::parity_mode() {
        &PARITY
    } else {
        &RESOLVED
    };
    let personas = cached(base, || {
        let tiers = [Tier::embedded(
            "base",
            TrustClass::Operator,
            embedded_base(),
        )?];
        KINDS
            .iter()
            .map(|kind| load(*kind, &tiers, &ApprovalSet::new(), None))
            .collect()
    })?;
    Ok(
        &personas[KINDS.iter().position(|k| *k == kind).ok_or_else(|| {
            PersonaError::InvalidContext {
                field: "dream_kind".into(),
                reason: "unregistered dream persona".into(),
            }
        })?],
    )
}

pub fn task(kind: Kind, input: &Input<'_>) -> Result<String, PersonaError> {
    task_with_mode(kind, input, "full")
}

pub fn task_with_mode(kind: Kind, input: &Input<'_>, mode: &str) -> Result<String, PersonaError> {
    Ok(render(embedded(kind)?, input, mode, false)?.text)
}

/// One immutable system prefix per role; batches never re-render it.
pub fn system(kind: Kind) -> Result<&'static str, PersonaError> {
    static PARITY: OnceLock<Vec<String>> = OnceLock::new();
    static RESOLVED: OnceLock<Vec<String>> = OnceLock::new();
    let systems = if crate::memory_profile::documents::parity_mode() {
        &PARITY
    } else {
        &RESOLVED
    };
    let systems = cached(systems, || {
        KINDS
            .iter()
            .map(|kind| Ok(render(embedded(*kind)?, &Input::default(), "full", true)?.text))
            .collect()
    })?;
    Ok(
        &systems[KINDS.iter().position(|k| *k == kind).ok_or_else(|| {
            PersonaError::InvalidContext {
                field: "dream_kind".into(),
                reason: "unregistered dream persona".into(),
            }
        })?],
    )
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod profile_tests {
    use super::*;
    use crate::memory_profile::documents;

    fn forced(kind: Kind, acme: bool) -> DreamPersona {
        let tiers = [Tier::embedded("base", TrustClass::Operator, embedded_base()).unwrap()];
        let mut persona = documents::with_parity_mode(false, || {
            load(kind, &tiers, &ApprovalSet::new(), None).unwrap()
        });
        if acme {
            persona.profile = documents::tests::acme();
        }
        persona
    }

    #[test]
    fn invalid_dream_profile_document_refuses_without_panicking_and_retries() {
        let mut persona = forced(Kind::Verify, false);
        let original = persona.profile.clone();
        persona.profile.body["prompts"]["dreamer/swe:verify/system"]["sections"] = serde_json::json!([
            {"id": "broken", "mc": "missing-frame"}
        ]);
        let attempt = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            render(&persona, &Input::default(), "full", true)
        }));
        let error = attempt
            .expect("invalid dream documents must refuse, not panic")
            .unwrap_err();
        assert!(error.to_string().contains("prompt_invalid"), "{error}");
        persona.profile = original;
        assert_eq!(
            render(&persona, &Input::default(), "full", true)
                .unwrap()
                .text,
            include_str!(
                "../../testdata/memory_profile/resolved-swe/rendered/dreamer/swe-verify/system.md"
            )
        );
    }

    #[test]
    fn verify_broad_records_its_task_with_shared_system_bytes() {
        let persona = forced(Kind::Verify, false);
        let full = memory_profile(&persona, "full").unwrap();
        let broad = memory_profile(&persona, "broad").unwrap();
        assert_eq!(full.task.as_deref(), Some("swe:verify"));
        assert_eq!(broad.task.as_deref(), Some("swe:verify-broad"));
        let expected = include_str!(
            "../../testdata/memory_profile/resolved-swe/rendered/dreamer/swe-verify/system.md"
        );
        for (mode, fragment) in [("full", full), ("broad", broad)] {
            assert!(fragment.present && fragment.supplies);
            assert_eq!(fragment.fragment, expected);
            assert_eq!(
                render(&persona, &Input::default(), mode, true)
                    .unwrap()
                    .text,
                expected
            );
        }
    }

    #[test]
    fn acme_dream_uses_only_matching_review_user_system() {
        for kind in KINDS {
            let persona = forced(kind, true);
            let fragment = memory_profile(&persona, "full").unwrap();
            assert!(fragment.present);
            assert_eq!(fragment.name.as_deref(), Some("@acme/memory-legal"));
            assert!(fragment.version.is_some() && fragment.digest.is_some());
            let output = render(&persona, &Input::default(), "full", true).unwrap();
            if kind == Kind::ReviewUser {
                assert_eq!(fragment.task.as_deref(), Some("base:review-user-memories"));
                assert!(fragment.supplies);
                assert_eq!(
                    output.text,
                    documents::render(
                        &persona.profile,
                        "dreamer/base:review-user-memories/system",
                        None
                    )
                    .unwrap()
                );
            } else {
                assert_eq!(fragment.task, None);
                assert!(!fragment.supplies);
                assert!(fragment.fragment.is_empty());
                assert_eq!(
                    output.text,
                    kind.files()[2]
                        .1
                        .replace("\r\n", "\n")
                        .trim_end_matches('\n')
                );
            }
            let task = render(&persona, &Input::default(), "full", false).unwrap();
            assert_eq!(
                task.text,
                render(embedded(kind).unwrap(), &Input::default(), "full", false)
                    .unwrap()
                    .text
            );
        }
    }

    #[test]
    fn parity_dream_fragments_are_empty_and_mode_is_captured_at_load() {
        for kind in KINDS {
            let tiers = [Tier::embedded("base", TrustClass::Operator, embedded_base()).unwrap()];
            let persona = documents::with_parity_mode(true, || {
                load(kind, &tiers, &ApprovalSet::new(), None).unwrap()
            });
            documents::with_parity_mode(false, || {
                let fragment = memory_profile(&persona, "full").unwrap();
                assert!(fragment.present);
                assert!(!fragment.supplies);
                assert!(fragment.fragment.is_empty());
                assert_eq!(
                    render(&persona, &Input::default(), "full", true)
                        .unwrap()
                        .text,
                    kind.files()[2]
                        .1
                        .replace("\r\n", "\n")
                        .trim_end_matches('\n')
                );
            });
        }
    }
}
