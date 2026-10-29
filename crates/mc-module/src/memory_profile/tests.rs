use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::{json, Value};

use super::resolve::ContextSource;
use super::*;
use crate::memory_context::{ContextAnswer, ProjectContext, SessionContext};

fn legal_package() -> Package {
    let root =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/memory_profile/acme-memory-legal");
    let ck = std::fs::read(root.join("ck.json")).unwrap();
    let env: Value = serde_json::from_slice(&ck).unwrap();
    let files = list(&env, "files")
        .iter()
        .map(|f| {
            let name = text(f, "path");
            (name.into(), std::fs::read(root.join(name)).unwrap())
        })
        .collect();
    Package::decode(&ck, files).unwrap()
}

fn legal() -> Profile {
    load_chain(&[bundled::packages().remove(0), legal_package()]).unwrap()
}

#[test]
fn vendored_bytes_match_every_checksum() {
    fn walk(root: &Path, path: &Path, paths: &mut BTreeSet<String>) {
        for entry in std::fs::read_dir(path).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk(root, &path, paths);
            } else if path.file_name().unwrap() != "SHA256SUMS" {
                paths.insert(
                    path.strip_prefix(root)
                        .unwrap()
                        .to_str()
                        .unwrap()
                        .replace('\\', "/"),
                );
            }
        }
    }
    for dir in ["profiles", "testdata/memory_profile"] {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join(dir);
        let mut covered = BTreeSet::new();
        for line in std::fs::read_to_string(root.join("SHA256SUMS"))
            .unwrap()
            .lines()
        {
            let (digest, path) = line.split_once("  ").unwrap();
            assert!(covered.insert(path.to_owned()), "duplicate checksum {path}");
            assert_eq!(
                sha256(&std::fs::read(root.join(path)).unwrap()),
                digest,
                "{dir}/{path}"
            );
        }
        let mut actual = BTreeSet::new();
        walk(&root, &root, &mut actual);
        assert_eq!(covered, actual, "checksum list is exhaustive for {dir}");
    }
}

#[test]
fn bundled_packages_load_and_base_cannot_be_an_agent() {
    let packages = bundled::packages();
    assert_eq!(packages.len(), 2);
    assert_eq!(
        load_chain(&packages[..1]).unwrap_err().code,
        "profile_chain_invalid"
    );
    let profile = load_chain(&packages).unwrap();
    assert_eq!(
        profile.digest,
        "5750ce5af0712251e4bf8fe599ed3f9edeb6b8477bc49042b74170991cb6fe8d"
    );
    assert_eq!(list(&profile.body, "categories").len(), 12);
    let mut facts: Vec<_> = list(&profile.body, "categories")
        .iter()
        .filter(|c| c["stream"] == "fact")
        .collect();
    facts.sort_by_key(|c| c["render_order"].as_i64().unwrap());
    assert_eq!(
        facts.iter().map(|c| text(c, "tag")).collect::<Vec<_>>(),
        crate::memory_render::MEMORY_CATEGORY_ORDER
    );
}

#[test]
fn every_writer_tag_has_its_effective_category() {
    let p = bundled::swe().unwrap();
    let expected = [
        ("PROJECT_RULES", "swe:project-rules"),
        ("ARCHITECTURE", "swe:architecture"),
        ("CONSTRAINTS", "swe:constraints"),
        ("CONFIG_VALUES", "swe:config-values"),
        ("NAMING", "swe:naming"),
        ("USER_DIRECTIVES", "swe:project-rules"),
        ("USER_PREFERENCES", "swe:project-rules"),
        ("CONFIG_DEFAULTS", "swe:config-values"),
        ("ARCHITECTURE_DECISIONS", "swe:architecture"),
        ("ENVIRONMENT", "swe:config-values"),
        ("WORKFLOW_RULES", "swe:project-rules"),
        ("KNOWN_ISSUES", "swe:constraints"),
    ];
    for (tag, id) in expected {
        assert_eq!(p.effective_category(tag), Some(id), "{tag}");
    }
    assert_eq!(p.effective_category("unmapped"), None);
}

#[test]
fn known_issues_uses_category_map() {
    assert_eq!(
        bundled::swe().unwrap().effective_category("KNOWN_ISSUES"),
        Some("swe:constraints")
    );
}

#[test]
fn prompt_section_override_preserves_inherited_condition() {
    let profile = bundled::swe().unwrap();
    let section = list(&profile.body["prompts"]["historian/system"], "sections")
        .iter()
        .find(|s| s["id"] == "facts-general-rules")
        .unwrap();
    assert_eq!(section["requires"], "fact_categories");
    assert_eq!(section["_from"], "@cortexkit/memory-swe");
}

#[test]
fn envelope_rejects_version_build_metadata() {
    let mut packages = bundled::packages();
    packages[1].env["version"] = "1.0.0+build".into();
    assert_eq!(
        load_chain(&packages).unwrap_err().code,
        "profile_schema_invalid"
    );
}

#[test]
fn schema_integer_accepts_integral_json_number() {
    let mut body = bundled::packages()[1].env["body"].clone();
    body["categories"][0]["render_order"] = json!(1.0);
    schema::validate(&body).unwrap();
    body["categories"][0]["render_order"] = json!(1.5);
    assert_eq!(
        schema::validate(&body).unwrap_err().code,
        "profile_schema_invalid"
    );
}

fn entry<'a>(body: &'a mut Value, collection: &str, id: &str) -> &'a mut Value {
    body[collection]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|c| c["id"] == id)
        .unwrap()
}

/// Generates the 28 invalid variants in negative-to-code.json, in source order.
/// Only valid packages are copied; invalid manifests are generated in memory.
fn negative(index: usize, base: &mut Value, swe: &mut Value) {
    let b = &mut base["body"];
    let s = &mut swe["body"];
    match index {
        0 => s["load_mode"] = "always".into(),
        1 => entry(s,"categories","swe:naming")["id"] = "NAMING".into(),
        2 => entry(s,"categories","swe:naming")["id"] = "base:naming".into(),
        3 => { let mut c = entry(s,"categories","swe:naming").clone(); c["id"] = "base:identity".into(); c["tag"] = "IDENTITY".into(); s["categories"].as_array_mut().unwrap().push(c); }
        4 => entry(s,"categories","swe:naming")["tag"] = "COMMUNICATION".into(),
        5 => entry(s,"categories","swe:naming")["tag"] = "UNCATEGORISED".into(),
        6 => { for i in 0..13 { let mut c = entry(s,"categories","swe:naming").clone(); let id = format!("swe:extra-{i}"); c["id"] = id.clone().into(); c["tag"] = format!("EXTRA_{i}").into(); s["categories"].as_array_mut().unwrap().push(c); s["retention"]["category_ttl_ms"][id] = Value::Null; } }
        7 => { let c = entry(s,"categories","swe:dev-environment"); c["sensitive"] = true.into(); c["visibility"] = "all-profiles".into(); }
        8 => entry(s,"categories","swe:naming")["decay_class"] = "forever".into(),
        9 => entry(s,"categories","swe:naming")["default_level"] = "global".into(),
        10 => s["extraction"]["events"][0]["consumer"] = "swe:missing".into(),
        11 => entry(s,"tasks","swe:reflect-patterns")["enabled"] = false.into(),
        12 => s["extraction"]["events"][0]["consumer"] = "swe:curate".into(),
        13 => s["extraction"]["events"][0]["fields"]["optional"].as_array_mut().unwrap().push("blast_radius".into()),
        14 => entry(s,"tasks","swe:curate")["actions"].as_array_mut().unwrap().push("set-scope".into()),
        15 => entry(s,"tasks","swe:curate")["reads"].as_array_mut().unwrap().push("git".into()),
        16 => { entry(s,"tasks","swe:reflect-patterns")["prompts"].as_object_mut().unwrap().remove("gate_system"); }
        17 => s["prompts"]["dreamer/swe:curate/system"]["sections"] = json!([{"id":"body","file":"prompts/dreamer/curate/user.md"}]),
        18 => entry(s,"tasks","swe:curate")["settings"] = json!({"min_proof_count":2}),
        19 => {
            let mut task = b["tasks"][0].clone(); task["id"] = "base:extra-review".into(); task["enabled"] = true.into(); b["tasks"].as_array_mut().unwrap().push(task);
            let mut task = s["tasks"][0].clone();
            for (k,v) in json!({"id":"base:extra-review","kind":"review-user-memories","reads":["historian-user-observations"],"evidence":[],"actions":["promote"],"categories":[],"prompts":{"system":"dreamer/base:review-user-memories/system","user":"dreamer/base:review-user-memories/user"},"enabled":false,"override":true}).as_object().unwrap() { task[k] = v.clone(); }
            s["tasks"].as_array_mut().unwrap().push(task);
        }
        20 => s["prompts"]["dreamer/base:review-user-memories/user"]["sections"].as_array_mut().unwrap().push(json!({"id":"intro","override":true,"file":"prompts/dreamer/review-user-memories/user.swe-categories.md"})),
        21 => { s["extend"].as_array_mut().unwrap().pop(); }
        22 => s["prompts"]["historian/system"]["sections"].as_array_mut().unwrap().push(json!({"id":"output","override":true,"file":"prompts/historian/system/persona.md"})),
        23 => s["prompts"]["main-agent/ctx_memory.description.full"] = json!({"sections":[{"id":"body","file":"prompts/historian/system/persona.md"}]}),
        24 => { s["serves"].as_array_mut().unwrap().push("@acme/domain-software".into()); s["default_for"].as_array_mut().unwrap().push("@acme/domain-software".into()); }
        25 => { s["abstract"] = true.into(); s["serves"] = json!([]); s["default_for"] = json!([]); }
        26 => swe["requires"]["packages"] = json!({}),
        27 => swe["requires"]["packages"]["@cortexkit/memory-base"] = "^2.0.0".into(),
        _ => panic!("unexpected NEGATIVE row"),
    }
}

#[test]
fn all_28_generated_negative_variants_refuse_with_authored_detail() {
    let table: Vec<Value> = serde_json::from_str(include_str!(
        "../../testdata/memory_profile/negative-to-code.json"
    ))
    .unwrap();
    assert_eq!(table.len(), 28);
    for (i, row) in table.iter().enumerate() {
        let mut packages = bundled::packages();
        let (base, swe) = packages.split_at_mut(1);
        negative(i, &mut base[0].env, &mut swe[0].env);
        let refusal = load_chain(&packages).unwrap_err();
        assert_eq!(
            refusal.code, row["code"],
            "{}: {}",
            row["name"], refusal.detail
        );
        assert!(
            refusal.detail.contains(text(row, "expect")),
            "{}: expected {:?}, got {:?}",
            row["name"],
            row["expect"],
            refusal.detail
        );
    }
}

#[test]
fn third_party_profile_warns_and_cannot_claim_foreign_default() {
    assert_eq!(legal().warnings, ["third-party memory profile"]);
    let mut packages = vec![bundled::packages().remove(0), legal_package()];
    for field in ["serves", "default_for"] {
        packages[1].env["body"][field]
            .as_array_mut()
            .unwrap()
            .push("@cortexkit/domain-software".into());
    }
    assert_eq!(
        load_chain(&packages).unwrap_err().code,
        "default_scope_mismatch"
    );
    packages[1].env["body"]["unknown"] = true.into();
    assert_eq!(
        load_chain(&packages).unwrap_err().code,
        "profile_schema_invalid"
    );
}

fn project(domain: Option<&str>) -> ContextAnswer<ProjectContext> {
    let records: Vec<Value> = serde_json::from_str(include_str!(
        "../../testdata/entorhinal-memory-context-v1/context-project.json"
    ))
    .unwrap();
    let mut value = records[0]["reply"]["result"].clone();
    value["domain"] = json!(domain);
    ContextAnswer::Answer(serde_json::from_value(value).unwrap())
}

fn session(pins: Vec<Value>) -> ContextAnswer<SessionContext> {
    let records: Vec<Value> = serde_json::from_str(include_str!(
        "../../testdata/entorhinal-memory-context-v1/context-session-populated.json"
    ))
    .unwrap();
    let mut value = records[0]["reply"]["result"].clone();
    value["pins"] = pins.into();
    ContextAnswer::Answer(serde_json::from_value(value).unwrap())
}

fn swe_pin() -> Value {
    json!({"kind":"memory-profile","name":"@cortexkit/memory-swe","version":"1.0.0","manifest_sha256":"44d954f1d325f7e250064c1d0b256333f392d1b0fc9c797e93c76310942d8a98","archive_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","publisher_fingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","status":null})
}

fn outcome(domain: Option<&str>, pins: Vec<Value>, installed: &[Profile]) -> MemoryContext {
    resolve(&project(domain), &session(pins), installed)
}
fn resolved(context: &MemoryContext, source: &str) {
    assert_eq!(context.profile.state, "resolved");
    assert_eq!(
        context.profile.name.as_deref(),
        Some("@cortexkit/memory-swe")
    );
    assert_eq!(context.profile.resolution.as_deref(), Some(source));
    assert!(context.profile.parity);
}

#[test]
fn null_domain_uses_parity_bundled_default() {
    resolved(&outcome(None, vec![], &[]), "bundled_default");
}
#[test]
fn software_domain_uses_domain_default() {
    resolved(
        &outcome(Some("@cortexkit/domain-software"), vec![], &[]),
        "domain_default",
    );
}
#[test]
fn unknown_domain_is_unresolved() {
    assert_eq!(
        outcome(Some("@acme/domain-legal"), vec![], &[])
            .profile
            .state,
        "unresolved"
    );
}
#[test]
fn two_owning_scope_claimants_conflict() {
    let a = legal();
    let mut b = a.clone();
    b.name = "@acme/memory-other".into();
    assert_eq!(
        outcome(Some("@acme/domain-legal"), vec![], &[a, b])
            .profile
            .state,
        "conflict"
    );
}
#[test]
fn two_distinct_memory_profile_pins_conflict() {
    let a = swe_pin();
    let mut b = a.clone();
    b["version"] = "2.0.0".into();
    assert_eq!(outcome(None, vec![a, b], &[]).profile.state, "conflict");
}
#[test]
fn duplicate_memory_profile_pin_is_not_a_conflict() {
    resolved(&outcome(None, vec![swe_pin(), swe_pin()], &[]), "agent_pin");
}
#[test]
fn matching_raw_ck_manifest_pin_resolves() {
    resolved(&outcome(None, vec![swe_pin()], &[]), "agent_pin");
}
#[test]
fn bundled_pin_version_mismatch_is_unavailable() {
    let mut pin = swe_pin();
    pin["version"] = "9.0.0".into();
    assert_eq!(outcome(None, vec![pin], &[]).profile.state, "unavailable");
}
#[test]
fn bundled_pin_hash_mismatch_is_unavailable() {
    let mut pin = swe_pin();
    pin["manifest_sha256"] =
        "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc".into();
    assert_eq!(outcome(None, vec![pin], &[]).profile.state, "unavailable");
}
#[test]
fn one_changed_ck_byte_refuses_pin_identity() {
    let mut bytes = bundled::packages()[1].ck_bytes.clone();
    bytes.push(b' ');
    let mut pin = swe_pin();
    pin["manifest_sha256"] = sha256(&bytes).into();
    assert_eq!(outcome(None, vec![pin], &[]).profile.state, "unavailable");
}
#[test]
fn archive_hash_is_recorded_not_compared() {
    let mut pin = swe_pin();
    pin["archive_sha256"] =
        "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc".into();
    resolved(&outcome(None, vec![pin], &[]), "agent_pin");
}
#[test]
fn persona_without_memory_profile_pin_skips_persona_step() {
    let mut pin = swe_pin();
    pin["kind"] = "persona".into();
    pin["name"] = "@acme/persona-lawyer".into();
    resolved(
        &outcome(Some("@cortexkit/domain-software"), vec![pin], &[]),
        "domain_default",
    );
}
fn blocked_pin() -> Value {
    let mut pin = swe_pin();
    pin["status"] = json!({"state":"revoked","blocked":true});
    pin
}
#[test]
fn blocked_pin_never_loads_for_unknown_domain() {
    let context = outcome(Some("@acme/domain-legal"), vec![blocked_pin()], &[]);
    assert_eq!(context.profile.state, "blocked");
    assert!(context.profile.digest.is_none());
}
#[test]
fn blocked_pin_falls_back_for_null_domain() {
    resolved(&outcome(None, vec![blocked_pin()], &[]), "bundled_default");
}
#[test]
fn blocked_pin_falls_back_for_software_domain() {
    resolved(
        &outcome(Some("@cortexkit/domain-software"), vec![blocked_pin()], &[]),
        "domain_default",
    );
}
#[test]
fn revoked_but_unblocked_pin_is_usable() {
    let mut pin = blocked_pin();
    pin["status"]["blocked"] = false.into();
    resolved(&outcome(None, vec![pin], &[]), "agent_pin");
}
#[test]
fn not_answering_has_null_snapshot_and_legacy_parity() {
    let context = resolve(
        &ContextAnswer::NotAnswering,
        &ContextAnswer::NotAnswering,
        &[],
    );
    assert_eq!(context.profile.state, "entorhinal_not_answering");
    assert_eq!(
        context.profile.resolution.as_deref(),
        Some("bundled_default")
    );
    assert!(context.snapshot_digest.is_none());
    assert!(context.profile.parity);
}

struct Fake {
    project: ContextAnswer<ProjectContext>,
    session: ContextAnswer<SessionContext>,
    calls: AtomicUsize,
}
impl Fake {
    fn new(domain: Option<&str>) -> Self {
        Self {
            project: project(domain),
            session: session(vec![]),
            calls: AtomicUsize::new(0),
        }
    }
}
impl ContextSource for Fake {
    async fn project(&self, folder: &str) -> ContextAnswer<ProjectContext> {
        assert_eq!(folder, "/fixture/project");
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.project.clone()
    }
    async fn session(&self, agent_id: &str) -> ContextAnswer<SessionContext> {
        assert_eq!(agent_id, "durable-agent");
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.session.clone()
    }
}

#[tokio::test]
async fn project_profile_reads_project_and_replays_domain_outcomes() {
    for (domain, state, source) in [
        (None, "resolved", Some("bundled_default")),
        (
            Some("@cortexkit/domain-software"),
            "resolved",
            Some("domain_default"),
        ),
        (Some("@acme/domain-legal"), "unresolved", None),
    ] {
        let fake = Fake::new(domain);
        let actual = project_profile(&fake, "/fixture/project", &[]).await;
        assert_eq!(actual.profile.state, state);
        assert_eq!(actual.profile.resolution.as_deref(), source);
        assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
        assert_eq!(actual.profile, outcome(domain, vec![], &[]).profile);
        assert_eq!(
            actual.snapshot_digest,
            outcome(domain, vec![], &[]).snapshot_digest
        );
    }
    let a = legal();
    let mut b = a.clone();
    b.name = "@acme/memory-other".into();
    let fake = Fake::new(Some("@acme/domain-legal"));
    assert_eq!(
        project_profile(&fake, "/fixture/project", &[a, b])
            .await
            .profile
            .state,
        "conflict"
    );
    let fake = Fake {
        project: ContextAnswer::NotAnswering,
        ..Fake::new(None)
    };
    assert_eq!(
        project_profile(&fake, "/fixture/project", &[])
            .await
            .profile
            .state,
        "entorhinal_not_answering"
    );
}

fn open_store(path: PathBuf) -> mc_store::McStore {
    use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
    mc_store::McStore::open(&StorageDescriptor {
        module_id: "magic-context".into(),
        storage_namespace: "mc_cache".into(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: path.to_string_lossy().into_owned(),
        },
    })
    .unwrap()
}

#[tokio::test]
async fn restart_reuses_pin_with_zero_entorhinal_calls() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store.db");
    let store = open_store(path.clone());
    let fake = Fake::new(None);
    let first = bind(
        &fake,
        &store,
        "session",
        "/fixture/project",
        Some("durable-agent"),
    )
    .await
    .unwrap();
    assert_eq!(fake.calls.load(Ordering::SeqCst), 2);
    assert_eq!(
        project_profile(&fake, "/fixture/project", &[])
            .await
            .snapshot_digest,
        first.snapshot_digest
    );
    drop(store);
    let store = open_store(path);
    let restarted = Fake::new(Some("@acme/domain-legal"));
    let held = bind(
        &restarted,
        &store,
        "session",
        "/fixture/project",
        Some("durable-agent"),
    )
    .await
    .unwrap();
    assert_eq!(held, first);
    assert_eq!(restarted.calls.load(Ordering::SeqCst), 0);
    let fresh = bind(
        &restarted,
        &store,
        "new-session",
        "/fixture/project",
        Some("durable-agent"),
    )
    .await
    .unwrap();
    assert_eq!(fresh.profile.state, "unresolved");
    assert_ne!(fresh.snapshot_digest, first.snapshot_digest);
    assert_eq!(restarted.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn legacy_meta_binds_once_then_holds() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path().join("store.db"));
    let legacy_json = serde_json::to_value(mc_store::ModuleMeta::default()).unwrap();
    assert!(legacy_json.get("memory_context").is_none());
    let meta: mc_store::ModuleMeta = serde_json::from_value(legacy_json).unwrap();
    assert!(serde_json::to_value(&meta)
        .unwrap()
        .get("memory_context")
        .is_none());
    store.commit_meta("old-session", None, &meta).unwrap();
    let fake = Fake::new(None);
    let first = bind(&fake, &store, "old-session", "/fixture/project", None)
        .await
        .unwrap();
    let version = store.load_meta("old-session").unwrap().row_version;
    assert_eq!(
        bind(&fake, &store, "old-session", "/fixture/project", None)
            .await
            .unwrap(),
        first
    );
    assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
    assert_eq!(store.load_meta("old-session").unwrap().row_version, version);
}

#[tokio::test]
async fn resolving_is_read_only_and_only_acceptance_persists() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path().join("store.db"));
    let fake = Fake::new(None);
    let pin =
        super::resolve::resolve_session_pin(&fake, &store, "session", "/fixture/project", None)
            .await
            .unwrap();
    assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
    assert_eq!(store.load_meta("session").unwrap().row_version, None);
    super::persist_session_pin(&store, "session", &pin).unwrap();
    let version = store.load_meta("session").unwrap().row_version;
    let pin2 =
        super::resolve::resolve_session_pin(&fake, &store, "session", "/fixture/project", None)
            .await
            .unwrap();
    assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
    super::persist_session_pin(&store, "session", &pin2).unwrap();
    assert_eq!(store.load_meta("session").unwrap().row_version, version);
}

fn handler_fixture() -> (crate::McHandler, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path().join("store.db"));
    let context = dir.path().join("context.db");
    rusqlite::Connection::open(&context)
        .unwrap()
        .execute_batch(
            &include_str!("../../../mc-store/testdata/context_schema/schema.sql")
                .replace(":applied_at", "1"),
        )
        .unwrap();
    store.install_context_domain(std::sync::Arc::new(
        mc_store::SqliteContextDomain::open(&context).unwrap(),
    ));
    let handler = crate::McHandler::new();
    handler.store.set(std::sync::Arc::new(store)).ok().unwrap();
    (handler, dir)
}

async fn route_bind(handler: &crate::McHandler, root: &Path, harness: &str, session: &str) {
    let request = subc_client_rs::RouteBindRequest::new(
        subc_client_rs::RouteHandle::detached(7, 1),
        subc_protocol::RouteTarget::ToolProvider {
            module_id: "magic-context".into(),
        },
        subc_protocol::BindIdentity::new(root.to_path_buf(), harness, session),
    );
    <crate::McHandler as subc_client_rs::ModuleHandler>::on_bind(handler, &request).await;
}

struct FacadeResolver(Option<String>);
#[async_trait::async_trait]
impl crate::session_resolver::SessionResolver for FacadeResolver {
    async fn resolve_session(
        &self,
        _: &Path,
        _: &str,
        token: &str,
    ) -> std::result::Result<
        Option<crate::session_resolver::ResolvedSession>,
        crate::session_resolver::SessionResolveError,
    > {
        assert_eq!(token, "instance-token");
        Ok(self
            .0
            .as_ref()
            .map(|session| crate::session_resolver::ResolvedSession {
                session_id: session.clone(),
                last_traffic_ms: 1,
            }))
    }
}

#[tokio::test]
async fn unproven_facade_token_never_creates_a_meta_row() {
    let (mut handler, dir) = handler_fixture();
    handler.session_resolver = std::sync::Arc::new(FacadeResolver(None));
    route_bind(&handler, dir.path(), "claude-code", "instance-token").await;
    let store = handler.store.get().unwrap();
    assert_eq!(store.load_meta("instance-token").unwrap().row_version, None);
    assert!(handler
        .resolve_facade_scope(7, None, "memories", false, false)
        .await
        .is_err());
    assert_eq!(store.load_meta("instance-token").unwrap().row_version, None);
}

#[tokio::test]
async fn proven_facade_pins_once_under_the_resolved_session() {
    let (mut handler, dir) = handler_fixture();
    handler.session_resolver =
        std::sync::Arc::new(FacadeResolver(Some("opaque-conversation".into())));
    route_bind(&handler, dir.path(), "claude-code", "instance-token").await;
    let store = handler.store.get().unwrap();
    assert_eq!(store.load_meta("instance-token").unwrap().row_version, None);
    handler
        .resolve_facade_scope(7, None, "memories", false, false)
        .await
        .unwrap();
    let first = store.load_meta("opaque-conversation").unwrap();
    assert!(first.meta.memory_context.is_some());
    handler
        .resolve_facade_scope(7, None, "memories", false, false)
        .await
        .unwrap();
    assert_eq!(
        store.load_meta("opaque-conversation").unwrap().row_version,
        first.row_version
    );
    assert_eq!(store.load_meta("instance-token").unwrap().row_version, None);
}

#[tokio::test]
async fn proven_durable_bind_pins_once() {
    let (handler, dir) = handler_fixture();
    let store = handler.store.get().unwrap();
    store
        .commit_meta("durable", None, &mc_store::ModuleMeta::default())
        .unwrap();
    handler
        .transform_session_roots
        .lock()
        .unwrap()
        .entry("durable".into())
        .or_default()
        .insert(crate::canonical_root(dir.path()));
    route_bind(&handler, dir.path(), "opencode", "durable").await;
    let first = store.load_meta("durable").unwrap();
    assert!(first.meta.memory_context.is_some());
    route_bind(&handler, dir.path(), "opencode", "durable").await;
    assert_eq!(
        store.load_meta("durable").unwrap().row_version,
        first.row_version
    );
}

#[test]
fn session_category_snapshot_has_fixed_size_and_frozen_lookup() {
    let pin = outcome(None, vec![], &[]);
    let ids = pin.category_ids.as_ref().unwrap();
    assert_eq!(ids.len(), 19);
    assert_eq!(
        serde_json::to_vec(ids).unwrap().len(),
        679,
        "per-session snapshot byte budget"
    );
    assert_eq!(ids.get("NAMING").map(String::as_str), Some("swe:naming"));
    assert_eq!(
        ids.get("KNOWN_ISSUES").map(String::as_str),
        Some("swe:constraints")
    );
    let decoded: MemoryContext =
        serde_json::from_value(serde_json::to_value(&pin).unwrap()).unwrap();
    assert_eq!(decoded.category_ids, pin.category_ids);
}

#[test]
fn test_profile_without_writer_mappings_stores_null_origin_category() {
    let mut profile = bundled::swe().unwrap();
    profile.body["serves"] = json!(["@test/domain"]);
    profile.body["default_for"] = json!(["@test/domain"]);
    profile.body["categories"]
        .as_array_mut()
        .unwrap()
        .retain(|category| category["tag"] != "NAMING");
    let map = profile.body["category_map"].as_object_mut().unwrap();
    map.remove("NAMING");
    map.remove("KNOWN_ISSUES");
    let pin = outcome(Some("@test/domain"), vec![], &[profile]);
    let authority = mc_store::memory_levels::RunAuthority::from_session_pin(
        &serde_json::to_value(pin).unwrap(),
        "test-profile",
    )
    .unwrap();
    assert!(authority.project_id.is_some());
    assert!(!authority.category_ids.contains_key("NAMING"));
    assert!(!authority.category_ids.contains_key("KNOWN_ISSUES"));
    let mut conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch(
        &include_str!("../../../mc-store/testdata/context_schema/schema.sql")
            .replace(":applied_at", "0"),
    )
    .unwrap();
    let tx = conn.transaction().unwrap();
    tx.execute("INSERT INTO memories(project_path,category,content,normalized_hash,created_at,updated_at,first_seen_at,last_seen_at) VALUES('project','NAMING','unmapped naming','hash',1,1,1,1)",[]).unwrap();
    let id = tx.last_insert_rowid();
    mc_store::memory_levels::MemoryWriter {
        authority: Some(authority),
        ..Default::default()
    }
    .created(
        &tx,
        id,
        mc_store::memory_levels::Actor::MainAgent,
        mc_store::memory_levels::CreateKind::Create,
        Some("test-profile"),
        None,
        1,
    )
    .unwrap();
    tx.commit().unwrap();
    let placement = mc_store::memory_levels::read_placement(&conn, id)
        .unwrap()
        .unwrap();
    assert!(placement.origin_profile.is_some());
    assert_eq!(placement.origin_category, None);
}
