//! ck-mc's `persona/v1` host. Operator tiers may configure routing and generation;
//! repository tiers may change wording only. Loading accepts caller-owned
//! approvals; freezing rendered bytes and storing approvals belong to the caller.

use std::path::Path;
use std::sync::{Arc, OnceLock};

use cortexkit_persona::{
    AgentContext, ApprovalSet, DefaultLadder, Demand, EmbeddedTier, EnvContext, Extension,
    FragmentSources, GrantMap, HarnessContext, LoadRequest, LoadedRole, MergeInput, MergeRule,
    ModelContext, OsName, PersonaEngine, PersonaError, ProjectKey, RenderContext, Rendered,
    SourceRef, Tier, TrustClass,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};

pub mod dream;

pub const MODULE: &str = "magic-context";
pub const SUMMARY_ROLE: &str = "mc_summary";
/// The routing consumer summaries select under. Dotted so routing configuration
/// for `mc` applies to every ck-mc consumer unless `mc.summary` overrides it.
pub const SUMMARY_CONSUMER: &str = "mc.summary";
pub const SUMMARY_CONTRACT: &str = "mc.summary.xml/v1";

/// One live source for the legacy historian guidance and its combined XML contract.
/// The testdata copy remains an independent byte-compatibility oracle.
pub const HISTORIAN_SYSTEM_PROMPT: &str =
    include_str!("../personas/mc_summary/fragments/system.md");
const SUMMARY_PERSONA: &str = include_str!("../personas/mc_summary/PERSONA.md");
const LANGUAGE_FRAGMENT: &str = include_str!("../personas/fragments/language.md");
const LANGUAGE_PERSONA: &str = "---\nname: language\nversion: 1\ndisplay_name: Language directive\nfragments: [mc/language@1]\n---\n{% include \"mc/language@1\" %}";

/// An operator layer's routing mapping replaces the lower mapping. Omitted
/// fields use the summary defaults, rather than the machine's routing state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Routing {
    pub consumer: String,
    pub iq: u8,
    pub eq: Option<u8>,
}

impl Default for Routing {
    fn default() -> Self {
        Self {
            consumer: SUMMARY_CONSUMER.into(),
            iq: 50,
            eq: None,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Generation {
    #[serde(default)]
    pub temperature: Option<f64>,
}

// The cortexkit-persona crate's SPEC.md (§5) calls a custom merge once per
// applied layer in ladder order, and its report (§7) lists those same layers in
// ladder order. Keep declaration flags in memory so policy can join them to
// trust/path without re-reading approved files. Only the value is serialized
// into the manifest/source revision (SPEC.md §6).
#[derive(Clone, Serialize, Deserialize)]
#[serde(transparent)]
struct OperatorValue<T> {
    value: T,
    #[serde(skip)]
    declarations: Vec<bool>,
}

fn operator_extension<T>(key: &str) -> Extension<OperatorValue<T>>
where
    T: DeserializeOwned + Serialize + Clone + Send + Sync + 'static,
{
    Extension::new(key)
        .required()
        .merge(MergeRule::Custom(Arc::new(
            |input: MergeInput<'_, OperatorValue<T>>| {
                let declared = input.present.is_some();
                let mut declarations = input
                    .inherited
                    .as_ref()
                    .map(|v| v.declarations.clone())
                    .unwrap_or_default();
                declarations.push(declared);
                Ok(input.present.or(input.inherited).map(|mut v| {
                    v.declarations = declarations;
                    v
                }))
            },
        )))
}

fn check_operator_only<T: 'static>(role: &LoadedRole, key: &str) -> Result<(), PersonaError> {
    let value = role
        .manifest()
        .extension::<OperatorValue<T>>(key)
        .expect("required registered extension");
    let used: Vec<_> = role.tiers().iter().filter(|tier| tier.used).collect();
    assert_eq!(
        used.len(),
        value.declarations.len(),
        "persona/v1 merge/report order contract"
    );
    for (tier, declared) in used.into_iter().zip(&value.declarations) {
        if *declared && tier.trust == TrustClass::Repository {
            return Err(PersonaError::InvalidField {
                file: SourceRef::File {
                    tier: tier.name.clone(),
                    path: format!("{}/PERSONA.md", tier.relative_path),
                },
                field: key.into(),
                reason: format!("{key}.* may only be set by operator tiers"),
            });
        }
    }
    Ok(())
}

/// A loaded summary that has passed ck-mc's repository-tier safety policy.
#[derive(Debug)]
pub struct SummaryPersona {
    role: LoadedRole,
}

impl SummaryPersona {
    pub fn routing(&self) -> &Routing {
        &self
            .role
            .manifest()
            .extension::<OperatorValue<Routing>>("routing")
            .expect("required routing")
            .value
    }

    pub fn generation(&self) -> &Generation {
        &self
            .role
            .manifest()
            .extension::<OperatorValue<Generation>>("generation")
            .expect("required generation")
            .value
    }

    pub fn manifest(&self) -> &cortexkit_persona::Manifest {
        self.role.manifest()
    }
}

/// The language fragment's arguments; these are stable inputs to a frozen render.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct LanguageOptions {
    pub preserve_user_quotes: bool,
    pub retrospective: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct LanguageContext {
    pub code: Option<String>,
    pub name: Option<String>,
    pub preserve_user_quotes: bool,
    pub retrospective: bool,
}

impl LanguageContext {
    pub fn new(code: Option<&str>, options: LanguageOptions) -> Self {
        let name = crate::content_language::resolve_language_name(code).map(str::to_owned);
        Self {
            code: code.map(str::to_owned),
            name,
            preserve_user_quotes: options.preserve_user_quotes,
            retrospective: options.retrospective,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct ProjectContext {
    /// A display name, never the checkout's absolute path.
    pub name: Option<String>,
}

/// The summary's system-only inputs. Session data, clocks, counters, extraction
/// toggles, references and memories deliberately have no fields here: they go in
/// the user turn, not the cacheable system prefix.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct SummaryContext {
    pub language: LanguageContext,
    pub project: ProjectContext,
    pub memory_profile: MemoryProfile,
}

/// Captured prompt text plus the identity of the validated profile that produced
/// it. Persona rendering uses this value rather than reloading package files or
/// rechecking the process-wide parity mode.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct MemoryProfile {
    pub present: bool,
    pub supplies: bool,
    pub name: Option<String>,
    pub version: Option<String>,
    pub digest: Option<String>,
    pub task: Option<String>,
    #[serde(skip)]
    fragment: String,
}

impl MemoryProfile {
    pub(crate) fn summary(
        pin: Option<&serde_json::Value>,
        session: &str,
    ) -> Result<Self, PersonaError> {
        let Some(pin) = pin else {
            return Ok(Self::default());
        };
        let pin: crate::memory_profile::MemoryContext = serde_json::from_value(pin.clone())
            .map_err(|e| PersonaError::InvalidContext {
                field: "memory_profile".into(),
                reason: e.to_string(),
            })?;
        let profile = crate::memory_profile::documents::bundled_swe().map_err(profile_error)?;
        if pin.profile.name.as_deref() != Some(&profile.name)
            || pin.profile.version.as_deref() != Some(&profile.version)
            || pin.profile.digest.as_deref() != Some(&profile.digest)
        {
            if first_profile_notice(session, "memory_profile_mismatch") {
                tracing::warn!(session, pinned_name = ?pin.profile.name,
                    pinned_version = ?pin.profile.version, pinned_digest = ?pin.profile.digest,
                    bundled_name = %profile.name, bundled_version = %profile.version,
                    bundled_digest = %profile.digest,
                    "pinned memory profile does not match bundled profile");
            }
            // The profile resolver/status integration owns recording a degraded
            // state. The persona layer preserves the existing prompt bytes here.
            return Ok(Self::default());
        }
        Self::capture(&profile, pin.profile.parity, Some("historian/system"), None)
    }

    fn capture(
        profile: &crate::memory_profile::Profile,
        parity: bool,
        document: Option<&str>,
        task: Option<&str>,
    ) -> Result<Self, PersonaError> {
        let fragment = if parity {
            String::new()
        } else if let Some(document) = document {
            crate::memory_profile::documents::render(profile, document, Some("xml"))
                .map_err(profile_error)?
        } else {
            String::new()
        };
        Ok(Self {
            present: true,
            supplies: !fragment.is_empty(),
            name: Some(profile.name.clone()),
            version: Some(profile.version.clone()),
            digest: Some(profile.digest.clone()),
            task: task.map(str::to_owned),
            fragment,
        })
    }
}

fn first_profile_notice(session: &str, kind: &'static str) -> bool {
    static NOTICES: OnceLock<std::sync::Mutex<std::collections::HashSet<(String, &'static str)>>> =
        OnceLock::new();
    NOTICES
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert((session.to_owned(), kind))
}

pub(crate) fn summary_refusal(
    session: &str,
    error: impl std::fmt::Display,
) -> crate::historian_producer::HistorianProducerError {
    let detail = error.to_string();
    if first_profile_notice(session, "mc_persona_invalid") {
        tracing::warn!(session, error = %detail, "mc_persona_invalid: summary persona refused");
    }
    crate::historian_producer::HistorianProducerError::Subc(
        crate::historian_producer::ProducerErrorBody::untagged("mc_persona_invalid", &detail),
    )
}

fn profile_error(error: crate::memory_profile::Refusal) -> PersonaError {
    PersonaError::InvalidContext {
        field: "memory_profile".into(),
        reason: format!("{}: {}", error.code, error.detail),
    }
}

fn guard_profile(
    role: &LoadedRole,
    profile: &MemoryProfile,
    rendered: Rendered,
) -> Result<Rendered, PersonaError> {
    if profile.supplies && !rendered.text.contains(&profile.fragment) {
        let tier = role.tiers().iter().rev().find(|t| t.used);
        return Err(PersonaError::InvalidContext {
            field: "mc_persona_invalid".into(),
            reason: serde_json::json!({"persona": role.manifest().name(), "tier": tier.map(|t| &t.name), "file": tier.map(|t| format!("{}/PERSONA.md", t.relative_path)), "error": "memory_profile_dropped"}).to_string(),
        });
    }
    Ok(rendered)
}

#[derive(Serialize)]
struct OutputContext {
    id: &'static str,
    format: &'static str,
    // Keep the existing combined guidance/contract intact until its contract changes.
    schema_text: &'static str,
}

#[derive(Serialize)]
struct ModuleContext<'a> {
    routing: &'a Routing,
    language: &'a LanguageContext,
    project: &'a ProjectContext,
    output: OutputContext,
    memory_profile: &'a MemoryProfile,
}

/// The compiled base works without any persona files on the host filesystem.
pub fn embedded_base() -> EmbeddedTier {
    dream::with_embedded(EmbeddedTier::new())
        .with_file(SUMMARY_ROLE, "PERSONA.md", SUMMARY_PERSONA)
        .expect("fixed summary persona path")
        .with_file(SUMMARY_ROLE, "fragments/system.md", HISTORIAN_SYSTEM_PROMPT)
        .expect("fixed summary system path")
}

/// Use persona/v1's platform config resolver, including APPDATA on Windows.
pub fn tier_ladder(
    workspace: Option<&str>,
    project_root: Option<&Path>,
) -> Result<Vec<Tier>, PersonaError> {
    finish_ladder(
        DefaultLadder::new(MODULE, embedded_base())?,
        workspace,
        project_root,
    )
}

/// An explicit config root supports an already-resolved host config directory
/// and hermetic tests without reading or changing the process environment.
pub fn tier_ladder_with_config_home(
    config_home: &Path,
    workspace: Option<&str>,
    project_root: Option<&Path>,
) -> Result<Vec<Tier>, PersonaError> {
    finish_ladder(
        DefaultLadder::with_config_home(MODULE, embedded_base(), config_home)?,
        workspace,
        project_root,
    )
}

fn finish_ladder(
    mut ladder: DefaultLadder,
    workspace: Option<&str>,
    project_root: Option<&Path>,
) -> Result<Vec<Tier>, PersonaError> {
    if let Some(workspace) = workspace {
        ladder = ladder.workspace(workspace)?;
    }
    if let Some(root) = project_root {
        ladder = ladder.project(root);
    }
    Ok(ladder.tiers())
}

/// Operator tiers may set routing/generation, but even an approved repository
/// tier cannot. Unapproved layers are skipped before parsing, exactly as
/// persona/v1 specifies. Tools and output schemas remain code-owned.
pub fn load_summary(
    tiers: &[Tier],
    approvals: &ApprovalSet,
    project_key: Option<&ProjectKey>,
) -> Result<SummaryPersona, PersonaError> {
    let role = load_role::<Routing>(SUMMARY_ROLE, tiers, approvals, project_key)?;
    let persona = SummaryPersona { role };
    validate_routing(persona.routing())?;
    Ok(persona)
}

fn load_role<R>(
    id: &str,
    tiers: &[Tier],
    approvals: &ApprovalSet,
    project_key: Option<&ProjectKey>,
) -> Result<LoadedRole, PersonaError>
where
    R: DeserializeOwned + Serialize + Clone + Send + Sync + 'static,
{
    let mut engine = PersonaEngine::new(MODULE)?;
    engine.register_extension(operator_extension::<R>("routing"))?;
    engine.register_extension(operator_extension::<Generation>("generation"))?;
    let mut request = LoadRequest::new(id, tiers, approvals);
    if let Some(key) = project_key {
        request = request.project_key(key);
    }
    let role = engine.load(request)?;
    check_operator_only::<R>(&role, "routing")?;
    check_operator_only::<Generation>(&role, "generation")?;
    Ok(role)
}

fn validate_routing(routing: &Routing) -> Result<(), PersonaError> {
    if routing.consumer.trim().is_empty()
        || routing.iq > 100
        || routing.eq.is_some_and(|eq| eq > 100)
    {
        return Err(PersonaError::InvalidContext {
            field: "routing".into(),
            reason: "nonempty consumer and iq/eq in 0-100 required".into(),
        });
    }
    Ok(())
}

/// Return LF-normalized text/bytes, SHA-256 digest and deterministic resolution
/// report together. Strict failures propagate unchanged, including their source.
pub fn render_summary(
    persona: &SummaryPersona,
    context: &SummaryContext,
) -> Result<Rendered, PersonaError> {
    let rendered = persona.role.render(
        &render_context(SUMMARY_ROLE, context, persona.routing()),
        &fragments_with_profile(&context.memory_profile)?,
    )?;
    guard_profile(&persona.role, &context.memory_profile, rendered)
}

fn fragments() -> Result<FragmentSources, PersonaError> {
    fragments_with_profile(&MemoryProfile::default())
}

fn fragments_with_profile(profile: &MemoryProfile) -> Result<FragmentSources, PersonaError> {
    FragmentSources::new()
        .with("mc/language@1", LANGUAGE_FRAGMENT)?
        .with("mc/memory-profile@1", profile.fragment.clone())
}

fn render_context<'a>(
    role: &str,
    context: &'a SummaryContext,
    routing: &'a Routing,
) -> RenderContext<ModuleContext<'a>> {
    context_for(
        role,
        routing,
        &context.project,
        ModuleContext {
            routing,
            language: &context.language,
            project: &context.project,
            output: OutputContext {
                id: SUMMARY_CONTRACT,
                format: "xml",
                schema_text: HISTORIAN_SYSTEM_PROMPT,
            },
            memory_profile: &context.memory_profile,
        },
    )
}

fn context_for<T>(
    role: &str,
    routing: &Routing,
    project: &ProjectContext,
    module: T,
) -> RenderContext<T> {
    RenderContext {
        agent: AgentContext {
            name: None,
            agent_id: None,
            project: project.name.clone(),
            workspace: None,
            role: role.into(),
        },
        // Rendering happens before placement. Neutral, fixed values satisfy the
        // shared context without making the prompt depend on a selected model,
        // harness, machine, locale or clock.
        model: ModelContext {
            provider: "unselected".into(),
            id: "unselected".into(),
            family: None,
            variant: "default".into(),
        },
        harness: HarnessContext {
            id: "ck-mc".into(),
            capabilities: Default::default(),
        },
        tools: GrantMap::default(),
        mcp: GrantMap::default(),
        modules: GrantMap::default(),
        demand: Demand {
            iq: routing.iq,
            eq: routing.eq.unwrap_or(0),
        },
        env: EnvContext {
            os: OsName::Unknown,
            timezone: "UTC".into(),
            locale: "en".into(),
        },
        module,
    }
}

/// A failed initialization is not cached, so the next firing can retry it.
fn cached<T>(
    cache: &OnceLock<T>,
    build: impl FnOnce() -> Result<T, PersonaError>,
) -> Result<&T, PersonaError> {
    if let Some(value) = cache.get() {
        return Ok(value);
    }
    let value = build()?;
    let _ = cache.set(value);
    cache.get().ok_or_else(|| PersonaError::InvalidContext {
        field: "persona_cache".into(),
        reason: "successful persona initialization was not retained".into(),
    })
}

fn embedded_summary() -> Result<&'static SummaryPersona, PersonaError> {
    static BASE: OnceLock<SummaryPersona> = OnceLock::new();
    cached(&BASE, || {
        let tiers = [Tier::embedded(
            "base",
            cortexkit_persona::TrustClass::Operator,
            embedded_base(),
        )?];
        load_summary(&tiers, &ApprovalSet::new(), None)
    })
}

/// Legacy callers use the embedded persona until lineage freezing adopts the
/// caller's loaded ladder. No operator files are read on this compatibility path.
pub fn render_embedded_summary(context: &SummaryContext) -> Result<Rendered, PersonaError> {
    render_summary(embedded_summary()?, context)
}

/// The legacy model-chain summarizer rebuilds its system prompt for each request
/// from `ModuleMeta::memory_context`, written once at session bind. The routed
/// summarizer captures the same profile selection in `FrozenSummaryPersona` via
/// `historian_routed::freeze_summary_persona` and reuses those bytes thereafter.
pub(crate) fn render_session_summary(
    store: &mc_store::McStore,
    session: &str,
    language: Option<&str>,
) -> Result<Rendered, PersonaError> {
    let loaded = store
        .load_meta(session)
        .map_err(|e| PersonaError::InvalidContext {
            field: "memory_profile".into(),
            reason: e.to_string(),
        })?;
    render_embedded_summary(&SummaryContext {
        language: LanguageContext::new(language, LanguageOptions::default()),
        memory_profile: MemoryProfile::summary(loaded.meta.memory_context.as_ref(), session)?,
        ..Default::default()
    })
}

/// Render the same qualified fragment for non-summary hidden agents. The small
/// internal wrapper uses the shared engine too, so there is only one language
/// template and no second implementation of its conditional instructions.
pub fn render_language_directive(
    language: Option<&str>,
    options: LanguageOptions,
) -> Result<String, PersonaError> {
    static LANGUAGE: OnceLock<LoadedRole> = OnceLock::new();
    let persona = cached(&LANGUAGE, || {
        let base = EmbeddedTier::new().with_file("language", "PERSONA.md", LANGUAGE_PERSONA)?;
        let tiers = [Tier::embedded(
            "base",
            cortexkit_persona::TrustClass::Operator,
            base,
        )?];
        PersonaEngine::new(MODULE)?.load(LoadRequest::new("language", &tiers, &ApprovalSet::new()))
    })?;
    let context = SummaryContext {
        language: LanguageContext::new(language, options),
        ..Default::default()
    };
    Ok(persona
        .render(
            &render_context("language", &context, &Routing::default()),
            &fragments()?,
        )?
        .text)
}

#[cfg(test)]
mod tests;

#[cfg(test)]
pub(crate) fn capture_profile_logs(run: impl FnOnce()) -> String {
    #[derive(Clone)]
    struct Writer(Arc<std::sync::Mutex<Vec<u8>>>);
    impl std::io::Write for Writer {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let bytes = Arc::new(std::sync::Mutex::new(Vec::new()));
    let writer = Writer(bytes.clone());
    let subscriber = tracing_subscriber::fmt()
        .without_time()
        .with_ansi(false)
        .with_max_level(tracing::Level::WARN)
        .with_writer(move || writer.clone())
        .finish();
    tracing::subscriber::with_default(subscriber, run);
    let output = bytes.lock().unwrap().clone();
    String::from_utf8(output).unwrap()
}

#[cfg(test)]
mod profile_tests {
    use super::*;
    use crate::memory_profile::documents;
    use serde_json::{json, Value};

    fn pin(parity: bool) -> Value {
        let mut context = crate::memory_profile::resolve(
            &crate::memory_context::ContextAnswer::NotAnswering,
            &crate::memory_context::ContextAnswer::NotAnswering,
            &[],
        );
        context.profile.parity = parity;
        serde_json::to_value(context).unwrap()
    }

    #[test]
    fn unmatched_profile_keeps_bytes_and_logs_identity_once_per_session() {
        let root = tempfile::tempdir().unwrap();
        let session = format!("mismatched-{}", root.path().display());
        let store = mc_store::McStore::open_for_test(&crate::dev_descriptor_at(
            root.path().to_str().unwrap(),
        ))
        .unwrap();
        let mut value = pin(false);
        value["profile"]["name"] = json!("@acme/memory-missing");
        value["profile"]["version"] = json!("9.8.7");
        value["profile"]["digest"] = json!("missing-profile-digest");
        set_pin(&store, &session, value);
        let logs = capture_profile_logs(|| {
            for _ in 0..2 {
                let result = render_session_summary(&store, &session, None).unwrap();
                assert_eq!(
                    result.text,
                    include_str!("../testdata/historian-system-prompt.txt")
                );
                assert_eq!(
                    result.digest.hex(),
                    "590649b1f6b2428940cb925586342be58bdecc3ee4d64153d2f73ec5251532bd"
                );
            }
        });
        assert_eq!(
            logs.matches("pinned memory profile does not match bundled profile")
                .count(),
            1,
            "{logs}"
        );
        let bundled = documents::bundled_swe().unwrap();
        // The tracing text formatter records string fields with Debug
        // escaping, so a Windows temp path reaches the log with each
        // backslash doubled. Compare against the encoded form the log holds.
        let logged_session = session.replace('\\', "\\\\");
        for value in [
            "pinned_name",
            "pinned_version",
            "pinned_digest",
            "bundled_name",
            "bundled_version",
            "bundled_digest",
            "@acme/memory-missing",
            "9.8.7",
            "missing-profile-digest",
            &bundled.name,
            &bundled.version,
            &bundled.digest,
            &logged_session,
        ] {
            assert!(logs.contains(value), "missing {value}: {logs}");
        }
    }

    #[test]
    fn failed_persona_initialization_is_not_cached() {
        let cache = OnceLock::new();
        let error = cached::<String>(&cache, || {
            Err(PersonaError::InvalidContext {
                field: "memory_profile".into(),
                reason: "temporary profile render failure".into(),
            })
        })
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("temporary profile render failure"));
        assert!(cache.get().is_none());
        assert_eq!(
            cached(&cache, || Ok("recovered".to_owned())).unwrap(),
            "recovered"
        );
    }

    #[test]
    fn pinned_parity_summary_ignores_nonparity_process_mode() {
        documents::with_parity_mode(false, || {
            let context = SummaryContext {
                memory_profile: MemoryProfile::summary(Some(&pin(true)), "profile-test").unwrap(),
                ..Default::default()
            };
            assert!(context.memory_profile.present);
            assert!(!context.memory_profile.supplies);
            assert!(context.memory_profile.fragment.is_empty());
            assert_eq!(context.memory_profile.task, None);
            assert_eq!(
                render_embedded_summary(&context).unwrap().text,
                include_str!("../testdata/historian-system-prompt.txt")
            );
        });
    }

    #[test]
    fn acme_summary_replaces_own_system_and_freezes_loaded_bytes() {
        let disk = tempfile::tempdir().unwrap();
        let source = documents::tests::acme();
        let package = source.packages.last().unwrap();
        std::fs::write(disk.path().join("ck.json"), &package.ck_bytes).unwrap();
        for (path, bytes) in &package.files {
            let path = disk.path().join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, bytes).unwrap();
        }
        let profile = documents::tests::acme_from(disk.path());
        let fragment =
            MemoryProfile::capture(&profile, false, Some("historian/system"), None).unwrap();
        let context = SummaryContext {
            memory_profile: fragment.clone(),
            ..Default::default()
        };
        let rendered = render_embedded_summary(&context).unwrap();
        assert_eq!(rendered.text, fragment.fragment);
        assert_ne!(
            rendered.digest,
            render_embedded_summary(&SummaryContext::default())
                .unwrap()
                .digest
        );
        assert!(fragment.supplies);
        assert_eq!(fragment.task, None);
        assert_eq!(
            serde_json::to_value(&fragment).unwrap(),
            json!({"present":true,"supplies":true,"name":profile.name,"version":profile.version,"digest":profile.digest,"task":null})
        );
        std::fs::write(
            disk.path().join("prompts/historian/persona.md"),
            "changed profile bytes\n",
        )
        .unwrap();
        assert_eq!(render_embedded_summary(&context).unwrap(), rendered);
    }

    fn repository(root: &Path, body: &str) -> (Vec<Tier>, ApprovalSet, ProjectKey) {
        use cortexkit_persona::Approval;
        let persona = root.join("repo/.cortexkit/magic-context/roles/mc_summary");
        std::fs::create_dir_all(persona.join("fragments/mc")).unwrap();
        std::fs::write(persona.join("PERSONA.md"), body).unwrap();
        std::fs::write(
            persona.join("fragments/mc/memory-profile@1.md"),
            "repository shadow",
        )
        .unwrap();
        let tiers =
            tier_ladder_with_config_home(&root.join("config"), None, Some(&root.join("repo")))
                .unwrap();
        let key = ProjectKey::new("profile-test").unwrap();
        let loaded = load_summary(&tiers, &ApprovalSet::new(), Some(&key)).unwrap();
        let tier = loaded.role.tiers().last().unwrap();
        let mut approvals = ApprovalSet::new();
        approvals.insert(Approval {
            module: MODULE.into(),
            role: SUMMARY_ROLE.into(),
            project_key: key.clone(),
            relative_path: tier.relative_path.clone(),
            layer_digest: tier.layer_digest.unwrap(),
        });
        (tiers, approvals, key)
    }

    #[test]
    fn dropped_profile_fragment_refuses_after_repository_render() {
        let root = tempfile::tempdir().unwrap();
        let (tiers, approvals, key) = repository(root.path(), "---\n---\n{% block instructions %}replacement{% endblock %}{% block memory_profile %}{% endblock %}{% block language %}{% endblock %}");
        let persona = load_summary(&tiers, &approvals, Some(&key)).unwrap();
        let context = SummaryContext {
            memory_profile: MemoryProfile::summary(Some(&pin(false)), "profile-test").unwrap(),
            ..Default::default()
        };
        let error = render_summary(&persona, &context).unwrap_err();
        assert!(
            matches!(error, PersonaError::InvalidContext { ref field, .. } if field == "mc_persona_invalid")
        );
        let text = error.to_string();
        for expected in [
            "memory_profile_dropped",
            "mc_summary",
            "project",
            "PERSONA.md",
        ] {
            assert!(text.contains(expected), "{text}");
        }
    }

    #[test]
    fn repository_fragment_cannot_shadow_module_profile() {
        let root = tempfile::tempdir().unwrap();
        let (tiers, approvals, key) = repository(root.path(), "---\n---\n");
        let persona = load_summary(&tiers, &approvals, Some(&key)).unwrap();
        let context = SummaryContext {
            memory_profile: MemoryProfile::summary(Some(&pin(false)), "profile-test").unwrap(),
            ..Default::default()
        };
        assert_eq!(
            render_summary(&persona, &context).unwrap().text,
            context.memory_profile.fragment
        );
    }

    struct FreezeRouting;
    #[subc_client_rs::async_trait]
    impl crate::historian_routed::SummaryRouting for FreezeRouting {
        fn routing_support(&self) -> Result<(), crate::historian_routed::RoutingSupportRefusal> {
            unreachable!()
        }
        async fn catalog(&self) -> Result<crate::model_work::RoutingCatalog, String> {
            unreachable!()
        }
        async fn select(
            &self,
            _: &str,
            _: &crate::historian_routed::SummaryScope,
            _: &crate::model_work::SelectParams,
        ) -> Result<crate::runner_choices::RoutedChoice, cortexkit_role_routing::errors::Refusal>
        {
            unreachable!()
        }
        async fn report(
            &self,
            _: &str,
            _: &crate::historian_routed::SummaryScope,
            _: &cortexkit_role_routing::report::ReportRequest,
        ) -> Result<
            cortexkit_role_routing::report::ReportAnswer,
            cortexkit_role_routing::errors::Refusal,
        > {
            unreachable!()
        }
        async fn connect_runner(
            &self,
            _: &crate::historian_routed::SummaryScope,
            _: &str,
        ) -> Result<
            Box<dyn crate::historian::HistorianProducerDriver + Send>,
            crate::historian_producer::HistorianProducerError,
        > {
            unreachable!()
        }
        fn persona_tiers(&self, _: &Path) -> Result<Vec<Tier>, PersonaError> {
            Ok(vec![Tier::embedded(
                "base",
                TrustClass::Operator,
                embedded_base(),
            )
            .unwrap()])
        }
    }

    fn set_pin(store: &mc_store::McStore, session: &str, value: Value) {
        let loaded = store.load_meta(session).unwrap();
        let mut meta = loaded.meta;
        meta.memory_context = Some(value);
        store
            .commit_meta(session, loaded.row_version, &meta)
            .unwrap();
    }

    #[test]
    fn routed_summary_freeze_ignores_late_pin() {
        let root = tempfile::tempdir().unwrap();
        let store = mc_store::McStore::open_for_test(&crate::dev_descriptor_at(
            root.path().to_str().unwrap(),
        ))
        .unwrap();
        let freeze = || {
            crate::historian_routed::freeze_summary_persona(
                &store,
                "session",
                &FreezeRouting,
                root.path(),
                None,
                None,
            )
            .unwrap()
        };
        let before = freeze();
        assert_eq!(
            before.bytes,
            include_str!("../testdata/historian-system-prompt.txt")
        );
        assert_eq!(
            before.render_digest,
            cortexkit_persona::Digest::of(before.bytes.as_bytes()).hex()
        );
        set_pin(&store, "session", pin(false));
        assert_eq!(freeze(), before);
    }

    #[test]
    fn chain_summary_uses_stored_pin_without_creating_freeze() {
        let root = tempfile::tempdir().unwrap();
        let store = mc_store::McStore::open_for_test(&crate::dev_descriptor_at(
            root.path().to_str().unwrap(),
        ))
        .unwrap();
        let unpinned = render_session_summary(&store, "session", None).unwrap();
        assert_eq!(
            unpinned.text,
            include_str!("../testdata/historian-system-prompt.txt")
        );
        assert_eq!(
            unpinned.digest.hex(),
            "590649b1f6b2428940cb925586342be58bdecc3ee4d64153d2f73ec5251532bd"
        );
        set_pin(&store, "session", pin(true));
        assert_eq!(
            render_session_summary(&store, "session", None)
                .unwrap()
                .bytes(),
            unpinned.bytes()
        );
        let expected = MemoryProfile::summary(Some(&pin(false)), "profile-test").unwrap();
        set_pin(&store, "nonparity", pin(false));
        assert_eq!(
            render_session_summary(&store, "nonparity", None)
                .unwrap()
                .text,
            expected.fragment
        );
        assert!(store
            .load_meta("session")
            .unwrap()
            .meta
            .summary_persona
            .is_none());
        assert!(store
            .load_meta("nonparity")
            .unwrap()
            .meta
            .summary_persona
            .is_none());
    }
}
