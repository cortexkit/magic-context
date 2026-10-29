use super::*;
use cortexkit_persona::{Approval, ApprovalState, Digest, RenderFailure, TrustClass};
use std::fs;

#[derive(Deserialize)]
struct DirectiveCase {
    label: String,
    language: Option<String>,
    preserve_user_quotes: bool,
    retrospective: bool,
    directive: String,
}

#[derive(Deserialize)]
struct LanguageName {
    language: String,
    name: String,
}

#[derive(Deserialize)]
struct LanguageGoldens {
    language_names: Vec<LanguageName>,
    directive_cases: Vec<DirectiveCase>,
}

fn goldens() -> LanguageGoldens {
    serde_json::from_str(include_str!(
        "../../testdata/content-language-directive-golden.json"
    ))
    .unwrap()
}

fn expected_system(directive: &str) -> String {
    // Deliberately use the pre-persona fixture, not the new production constant.
    let system = include_str!("../../testdata/historian-system-prompt.txt");
    if directive.is_empty() {
        system.into()
    } else {
        format!("{system}\n\n{directive}")
    }
}

#[test]
fn embedded_summary_is_byte_equal_for_every_language_golden() {
    let golden = goldens();
    assert!(!golden.directive_cases.is_empty());
    assert!(!golden.language_names.is_empty());
    for case in &golden.directive_cases {
        let context = SummaryContext {
            language: LanguageContext::new(
                case.language.as_deref(),
                LanguageOptions {
                    preserve_user_quotes: case.preserve_user_quotes,
                    retrospective: case.retrospective,
                },
            ),
            ..Default::default()
        };
        let actual = render_embedded_summary(&context).unwrap();
        let expected = expected_system(&case.directive);
        assert_eq!(actual.bytes(), expected.as_bytes(), "{}", case.label);
        assert_eq!(actual.digest, Digest::of(expected.as_bytes()));
        assert_eq!(actual.digest, actual.report.rendered_digest);
        assert_eq!(actual.report.entry_tier, "base");
    }

    // The name table covers more languages than the full directive fixtures.
    // Substitute only the language name in one independently pinned directive.
    let reference = golden
        .directive_cases
        .iter()
        .find(|case| {
            !case.preserve_user_quotes && !case.retrospective && !case.directive.is_empty()
        })
        .unwrap();
    let reference_name = golden
        .language_names
        .iter()
        .find(|name| Some(name.language.as_str()) == reference.language.as_deref())
        .unwrap();
    for name in &golden.language_names {
        let directive = reference.directive.replace(
            &format!("in: {}.", reference_name.name),
            &format!("in: {}.", name.name),
        );
        let context = SummaryContext {
            language: LanguageContext::new(Some(&name.language), LanguageOptions::default()),
            ..Default::default()
        };
        assert_eq!(
            render_embedded_summary(&context).unwrap().text,
            expected_system(&directive),
            "{}",
            name.language
        );
    }
}

fn write_layer(root: &Path, path: &str, text: &str) {
    let path = root.join(path);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

#[test]
fn lf_and_crlf_persona_copies_have_identical_bytes_digests_and_reports() {
    let root = tempfile::tempdir().unwrap();
    let role_path = "roles/mc_summary";
    let tier = Tier::directory("base", TrustClass::Operator, root.path(), "roles").unwrap();
    let context = SummaryContext {
        language: LanguageContext::new(
            Some("tr"),
            LanguageOptions {
                preserve_user_quotes: true,
                retrospective: true,
            },
        ),
        ..Default::default()
    };
    let render_copy = |crlf: bool| {
        let newline = |text: &str| {
            if crlf {
                text.replace('\n', "\r\n")
            } else {
                text.into()
            }
        };
        write_layer(
            root.path(),
            &format!("{role_path}/PERSONA.md"),
            &newline(SUMMARY_PERSONA),
        );
        write_layer(
            root.path(),
            &format!("{role_path}/fragments/system.md"),
            &newline(HISTORIAN_SYSTEM_PROMPT),
        );
        let persona = load_summary(std::slice::from_ref(&tier), &ApprovalSet::new(), None).unwrap();
        let sources = FragmentSources::new()
            .with("mc/language@1", newline(LANGUAGE_FRAGMENT))
            .unwrap()
            .with("mc/memory-profile@1", "")
            .unwrap();
        persona
            .role
            .render(
                &render_context(SUMMARY_ROLE, &context, persona.routing()),
                &sources,
            )
            .unwrap()
    };
    let lf = render_copy(false);
    let crlf = render_copy(true);
    assert_eq!(lf, crlf);
    assert_eq!(lf.text, render_embedded_summary(&context).unwrap().text);
}

fn ladder(root: &Path) -> Vec<Tier> {
    tier_ladder_with_config_home(
        &root.join("config"),
        Some("workspace-one"),
        Some(&root.join("repo")),
    )
    .unwrap()
}

fn project_file(root: &Path, text: &str) {
    write_layer(
        root,
        "repo/.cortexkit/magic-context/roles/mc_summary/PERSONA.md",
        text,
    );
}

fn project_approval(tiers: &[Tier], key: &ProjectKey) -> ApprovalSet {
    let skipped = load_summary(tiers, &ApprovalSet::new(), Some(key)).unwrap();
    let tier = skipped.role.tiers().last().unwrap();
    assert_eq!(tier.approval, ApprovalState::Unapproved);
    let mut approvals = ApprovalSet::new();
    approvals.insert(Approval {
        module: MODULE.into(),
        role: SUMMARY_ROLE.into(),
        project_key: key.clone(),
        relative_path: tier.relative_path.clone(),
        layer_digest: tier.layer_digest.unwrap(),
    });
    approvals
}

#[test]
fn strict_render_failure_names_the_tier_file_and_undefined_field() {
    let root = tempfile::tempdir().unwrap();
    write_layer(
        root.path(),
        "config/cortexkit/magic-context/roles/mc_summary/PERSONA.md",
        "---\n---\n{% block instructions %}{{ module.nonexistent_field }}{% endblock %}",
    );
    let persona = load_summary(&ladder(root.path()), &ApprovalSet::new(), None).unwrap();
    let error = render_summary(&persona, &SummaryContext::default()).unwrap_err();
    let message = error.to_string();
    assert!(message.contains("nonexistent_field"), "{message}");
    assert!(message.contains("tier `user`"), "{message}");
    assert!(
        message.contains("cortexkit/magic-context/roles/mc_summary/PERSONA.md"),
        "{message}"
    );
    assert!(matches!(
        error,
        PersonaError::Render {
            failure: RenderFailure::UndefinedValue,
            ..
        }
    ));
}

#[test]
fn operator_routing_and_generation_overrides_apply_in_ladder_order() {
    let root = tempfile::tempdir().unwrap();
    write_layer(
        root.path(),
        "config/cortexkit/magic-context/roles/mc_summary/PERSONA.md",
        "---\nrouting: {iq: 70, eq: 20}\ngeneration: {temperature: 0.25}\n---\n",
    );
    write_layer(root.path(), "config/cortexkit/magic-context/workspaces/workspace-one/roles/mc_summary/PERSONA.md", "---\nrouting: {consumer: mc_summary, iq: 80}\n---\n{% block instructions %}iq={{ module.routing.iq }};{{ module.output.id }}{% endblock %}");
    let persona = load_summary(&ladder(root.path()), &ApprovalSet::new(), None).unwrap();
    assert_eq!(persona.routing().iq, 80);
    assert_eq!(persona.generation().temperature, Some(0.25));
    assert_eq!(persona.manifest().to_json()["routing"]["iq"], 80);
    assert_eq!(
        persona.manifest().to_json()["generation"],
        serde_json::json!({"temperature": 0.25})
    );
    let rendered = render_summary(&persona, &SummaryContext::default()).unwrap();
    assert_eq!(rendered.text, "iq=80;mc.summary.xml/v1");
    assert_eq!(
        rendered
            .report
            .tiers
            .iter()
            .map(|tier| tier.name.as_str())
            .collect::<Vec<_>>(),
        ["base", "user", "workspace", "project"]
    );
}

fn repository_key_is_refused(key_name: &str, value: &str) {
    let root = tempfile::tempdir().unwrap();
    project_file(root.path(), &format!("---\n{key_name}: {value}\n---\n"));
    let tiers = ladder(root.path());
    let key = ProjectKey::new("opaque-project-identity").unwrap();
    let approvals = project_approval(&tiers, &key);
    let error = load_summary(&tiers, &approvals, Some(&key)).unwrap_err();
    let message = error.to_string();
    assert!(message.contains(key_name), "{message}");
    assert!(message.contains("tier `project`"), "{message}");
    assert!(
        message.contains(".cortexkit/magic-context/roles/mc_summary/PERSONA.md"),
        "{message}"
    );
    assert!(matches!(error, PersonaError::InvalidField { field, .. } if field == key_name));
}

#[test]
fn approved_repository_routing_iq_is_refused() {
    // Even restating the inherited value is forbidden, not just changing it.
    repository_key_is_refused("routing", "{iq: 50}");
}

#[test]
fn approved_repository_generation_is_refused() {
    repository_key_is_refused("generation", "{temperature: null}");
}

#[test]
fn approved_wording_only_repository_layer_is_accepted() {
    let root = tempfile::tempdir().unwrap();
    project_file(
        root.path(),
        "---\n---\n{% block instructions %}Approved repository wording.{% endblock %}",
    );
    let tiers = ladder(root.path());
    let key = ProjectKey::new("opaque-project-identity").unwrap();
    let approvals = project_approval(&tiers, &key);
    let persona = load_summary(&tiers, &approvals, Some(&key)).unwrap();
    let context = SummaryContext::default();
    let rendered = render_summary(&persona, &context).unwrap();
    assert_eq!(rendered.text, "Approved repository wording.");
    assert_eq!(rendered.report.entry_tier, "project");
    assert_eq!(
        rendered.report.tiers.last().unwrap().approval,
        ApprovalState::Approved
    );
    assert_eq!(rendered, render_summary(&persona, &context).unwrap());
}

#[test]
fn unapproved_repository_layer_is_skipped_and_reported_then_changed_is_skipped() {
    let root = tempfile::tempdir().unwrap();
    project_file(
        root.path(),
        "---\nnot_a_known_key: true\n---\n{{ also_undefined }}",
    );
    let tiers = ladder(root.path());
    let key = ProjectKey::new("opaque-project-identity").unwrap();
    let persona = load_summary(&tiers, &ApprovalSet::new(), Some(&key)).unwrap();
    let rendered = render_summary(&persona, &SummaryContext::default()).unwrap();
    assert_eq!(rendered.text, expected_system(""));
    let project = rendered.report.tiers.last().unwrap();
    assert!(project.present);
    assert!(!project.used);
    assert_eq!(project.approval, ApprovalState::Unapproved);
    let approvals = project_approval(&tiers, &key);
    project_file(root.path(), "---\ngeneration: {temperature: 0.9}\n---\n");
    let persona = load_summary(&tiers, &approvals, Some(&key)).unwrap();
    let changed = render_summary(&persona, &SummaryContext::default()).unwrap();
    assert_eq!(changed.text, expected_system(""));
    assert_eq!(
        changed.report.tiers.last().unwrap().approval,
        ApprovalState::Changed
    );
}
