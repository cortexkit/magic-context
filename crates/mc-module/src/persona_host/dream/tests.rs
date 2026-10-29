use super::*;
use cortexkit_persona::{Approval, ApprovalState};
use std::fs;

fn input() -> Input<'static> {
    Input {
        project: "Example project {{ not_a_template }}",
        category: "PROJECT_RULES",
        memories: "Memory α\nMemory β",
        anchors: "Anchors\n\n",
        candidates: "Candidate α\nCandidate β",
        profiles: "Profile α\nProfile β",
        threshold: 3,
        has_evidence: false,
        evidence: "",
    }
}

#[test]
fn dream_persona_sources_normalize_lf_and_crlf_for_every_variant() {
    // Builder byte parity is checked against executed base-code output in
    // retrospective_host::builder_oracle. This checks source normalization
    // independently of the prompt builders' memory/evidence assembly.
    for kind in KINDS {
        let name = kind.id().strip_prefix("mc_dream_").unwrap();
        let root = tempfile::tempdir().unwrap();
        let tier = Tier::directory("base", TrustClass::Operator, root.path(), "roles").unwrap();
        let mut lf = Vec::new();
        for crlf in [false, true] {
            for (path, text) in kind.files() {
                let path = root.path().join("roles").join(kind.id()).join(path);
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(
                    path,
                    if crlf {
                        text.replace('\n', "\r\n")
                    } else {
                        text.into()
                    },
                )
                .unwrap();
            }
            let persona =
                load(kind, std::slice::from_ref(&tier), &ApprovalSet::new(), None).unwrap();
            let mut alternate = input();
            let variant = match kind {
                Kind::Curate => {
                    alternate.candidates = "(none)";
                    "curate_no_candidates"
                }
                Kind::Classify => {
                    alternate.anchors = "";
                    "classify_no_anchors"
                }
                Kind::Map => {
                    alternate.memories = "";
                    "map_empty"
                }
                Kind::Verify => {
                    alternate.has_evidence = true;
                    alternate.evidence = "\n\nDIFF";
                    "verify_diff"
                }
                Kind::ReviewUser => {
                    alternate.profiles = "";
                    alternate.candidates = "";
                    "review_user_empty"
                }
            };
            for (name, input) in [(name, input()), (variant, alternate)] {
                for mode in ["full", "broad"] {
                    for (system_turn, key) in [(true, "system"), (false, "task")] {
                        let got = render(&persona, &input, mode, system_turn).unwrap();
                        let embedded =
                            render(embedded(kind).unwrap(), &input, mode, system_turn).unwrap();
                        assert_eq!(
                            (got.text.as_str(), got.digest),
                            (embedded.text.as_str(), embedded.digest),
                            "{name} {mode} {key} crlf={crlf}"
                        );
                        if crlf {
                            assert!(lf.contains(&(got.text, got.digest)));
                        } else {
                            lf.push((got.text, got.digest));
                        }
                    }
                }
            }
        }
    }
}

fn repo_file(root: &Path, kind: Kind, text: &str) {
    let path = root
        .join("repo/.cortexkit/magic-context/roles")
        .join(kind.id())
        .join("PERSONA.md");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

fn tiers(root: &Path) -> Vec<Tier> {
    tier_ladder_with_config_home(
        &root.join("config"),
        Some("workspace"),
        Some(&root.join("repo")),
    )
    .unwrap()
}

fn approval(kind: Kind, tiers: &[Tier], key: &ProjectKey) -> ApprovalSet {
    let skipped = load(kind, tiers, &ApprovalSet::new(), Some(key)).unwrap();
    let tier = skipped.role.tiers().last().unwrap();
    assert_eq!(tier.approval, ApprovalState::Unapproved);
    let mut approvals = ApprovalSet::new();
    approvals.insert(Approval {
        module: MODULE.into(),
        role: kind.id().into(),
        project_key: key.clone(),
        relative_path: tier.relative_path.clone(),
        layer_digest: tier.layer_digest.unwrap(),
    });
    approvals
}

#[test]
fn dream_repository_wording_needs_matching_checksum_approval() {
    for kind in KINDS {
        let root = tempfile::tempdir().unwrap();
        repo_file(
            root.path(),
            kind,
            "---\n---\n{% block instructions %}Approved wording{% endblock %}",
        );
        let tiers = tiers(root.path());
        let key = ProjectKey::new("project-identity").unwrap();
        let render_system = |approvals: &ApprovalSet| {
            render(
                &load(kind, &tiers, approvals, Some(&key)).unwrap(),
                &Input::default(),
                "full",
                true,
            )
            .unwrap()
        };
        assert_eq!(
            render_system(&ApprovalSet::new()).text,
            system(kind).unwrap()
        );
        let approved = approval(kind, &tiers, &key);
        assert_eq!(render_system(&approved).text, "Approved wording");
        repo_file(
            root.path(),
            kind,
            "---\ngeneration: {temperature: 0.9}\n---\n",
        );
        let changed = render_system(&approved);
        assert_eq!(changed.text, system(kind).unwrap());
        assert_eq!(
            changed.report.tiers.last().unwrap().approval,
            ApprovalState::Changed
        );
    }
}

#[test]
fn dream_approved_repository_cost_fields_are_refused_by_name() {
    for kind in KINDS {
        for (field, value) in [
            ("routing", "{consumer: evil, iq: 99}"),
            ("generation", "{temperature: 0.9}"),
        ] {
            let root = tempfile::tempdir().unwrap();
            repo_file(root.path(), kind, &format!("---\n{field}: {value}\n---\n"));
            let tiers = tiers(root.path());
            let key = ProjectKey::new("project-identity").unwrap();
            let approved = approval(kind, &tiers, &key);
            let error = load(kind, &tiers, &approved, Some(&key)).unwrap_err();
            let message = error.to_string();
            assert!(
                message.contains(field)
                    && message.contains("tier `project`")
                    && message.contains(&format!("roles/{}/PERSONA.md", kind.id())),
                "{message}"
            );
            assert!(
                matches!(error, PersonaError::InvalidField { field: refused, .. } if refused == field)
            );
        }
    }
}

#[test]
fn dream_operator_ladder_and_strict_context_are_preserved() {
    for kind in KINDS {
        let root = tempfile::tempdir().unwrap();
        let path = root
            .path()
            .join("config/cortexkit/magic-context/roles")
            .join(kind.id())
            .join("PERSONA.md");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "---\nrouting: {iq: 80}\ngeneration: {temperature: 0.25}\n---\n{% block instructions %}{{ module.unknown_field }}{% endblock %}").unwrap();
        let persona = load(kind, &tiers(root.path()), &ApprovalSet::new(), None).unwrap();
        assert_eq!(persona.routing().iq, 80);
        let defaults =
            crate::dream_dispatch::routed::registry::registration(kind.task_name()).unwrap();
        assert_eq!(persona.routing().consumer, defaults.consumer);
        assert_eq!(persona.routing().eq, defaults.eq);
        assert_eq!(persona.generation().temperature, Some(0.25));
        let message = render(&persona, &Input::default(), "full", true)
            .unwrap_err()
            .to_string();
        assert!(
            message.contains("unknown_field")
                && message.contains("tier `user`")
                && message.contains(kind.id()),
            "{message}"
        );
    }
}

#[test]
fn dream_verify_modes_describe_their_own_consumer_and_read_only_tools() {
    let root = tempfile::tempdir().unwrap();
    let kind = Kind::Verify;
    repo_file(root.path(), kind, "---\n---\n{% block instructions %}{{ module.routing.consumer }}:{{ module.mode }}:{% for tool in module.tools %}{{ tool.name }},{% endfor %}{% endblock %}");
    let tiers = tiers(root.path());
    let key = ProjectKey::new("project-identity").unwrap();
    let approved = approval(kind, &tiers, &key);
    let persona = load(kind, &tiers, &approved, Some(&key)).unwrap();
    for (mode, consumer) in [
        ("full", "mc.dream.verify"),
        ("broad", "mc.dream.verify-broad"),
    ] {
        let rendered = render(&persona, &Input::default(), mode, true).unwrap();
        assert_eq!(
            rendered.text,
            format!("{consumer}:{mode}:read,grep,glob,aft_outline,aft_zoom,aft_search,")
        );
    }
}
