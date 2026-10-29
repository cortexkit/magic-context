use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Value};

use super::{list, refuse, schema, sha256, text, Result};

const BASE: &str = "@cortexkit/memory-base";
const REVIEW: &str = "base:review-user-memories";
const MAIN: &[&str] = &[
    "main-agent/system.memory-guidance.full",
    "main-agent/system.memory-guidance.light",
    "main-agent/system.memory-mural-guidance",
];
const RESERVED: &[&str] = &[
    "output",
    "compartments",
    "compartment",
    "facts",
    "events",
    "user_observations",
    "primer_candidates",
    "p1",
    "p2",
    "p3",
    "p4",
    "u",
    "learnings",
    "learning",
    "UNCATEGORISED",
];

#[derive(Clone, Debug)]
pub(crate) struct Package {
    pub env: Value,
    pub ck_bytes: Vec<u8>,
    pub files: BTreeMap<String, Vec<u8>>,
}

impl Package {
    pub fn decode(ck: &[u8], files: BTreeMap<String, Vec<u8>>) -> Result<Self> {
        let env: Value = serde_json::from_slice(ck)
            .map_err(|e| refuse("profile_schema_invalid", e.to_string()))?;
        let pkg = Self {
            env,
            files,
            ck_bytes: ck.to_vec(),
        };
        if ck.len() > 65_536
            || files_total(&pkg.files) + ck.len() > 10_485_760
            || pkg.files.len() + 1 > 1_000
        {
            return Err(refuse(
                "profile_schema_invalid",
                "package exceeds catalog size caps",
            ));
        }
        pkg.validate()?;
        let mut named = BTreeSet::new();
        for member in list(&pkg.env, "files") {
            let path = text(member, "path");
            let bytes = pkg.files.get(path).ok_or_else(|| {
                refuse("body_ref_missing", format!("archive member {path} missing"))
            })?;
            if path.len() > 255
                || !safe_path(path)
                || !named.insert(path.to_ascii_lowercase())
                || member["sha256"] != sha256(bytes)
                || member["bytes"].as_u64() != Some(bytes.len() as u64)
            {
                return Err(refuse(
                    "profile_schema_invalid",
                    format!("invalid archive member {path}"),
                ));
            }
        }
        if named.len() != pkg.files.len() {
            return Err(refuse(
                "body_ref_missing",
                "archive members differ from files",
            ));
        }
        let refs = referenced_files(&pkg.env["body"]);
        if refs != pkg.files.keys().cloned().collect() {
            return Err(refuse(
                "body_ref_missing",
                "body references differ from archive members",
            ));
        }
        Ok(pkg)
    }

    fn validate(&self) -> Result<()> {
        let e = &self.env;
        let envelope_keys = [
            "schema", "name", "version", "kind", "summary", "license", "source", "requires",
            "files", "body",
        ];
        if !e.is_object()
            || envelope_keys.iter().any(|k| e.get(k).is_none())
            || e.as_object()
                .unwrap()
                .keys()
                .any(|k| !envelope_keys.contains(&k.as_str()))
        {
            return Err(refuse(
                "profile_schema_invalid",
                "invalid ck-package/v1 envelope fields",
            ));
        }
        let grammar =
            regex::Regex::new(r"^@[a-z0-9]+(?:-[a-z0-9]+)*/[a-z0-9]+(?:-[a-z0-9]+)*$").unwrap();
        if e["schema"] != "ck-package/v1"
            || e["kind"] != "memory-profile"
            || !grammar.is_match(text(e, "name"))
            || semver::Version::parse(text(e, "version"))
                .map_or(true, |version| !version.build.is_empty())
        {
            return Err(refuse(
                "profile_schema_invalid",
                "invalid ck-package/v1 envelope",
            ));
        }
        schema::validate(&e["body"])?;
        for domain in list(&e["body"], "default_for") {
            if !list(&e["body"], "serves").contains(domain) {
                return Err(refuse(
                    "profile_schema_invalid",
                    "default_for is not in serves",
                ));
            }
            if scope(domain.as_str().unwrap_or("")) != scope(text(e, "name")) {
                return Err(refuse(
                    "default_scope_mismatch",
                    "default_scope_mismatch: publisher does not own domain",
                ));
            }
        }
        if let Some(parent) = e["body"]["extends"].as_str() {
            if e["requires"]["packages"].get(parent).is_none() {
                return Err(refuse(
                    "body_ref_missing",
                    format!(
                        "extends {parent} is missing from requires.packages (body_ref_missing)"
                    ),
                ));
            }
        }
        if !e["requires"]["capabilities"].is_array()
            || !e["requires"]["packages"].is_object()
            || e["requires"]["packages"]
                .as_object()
                .unwrap()
                .keys()
                .any(|k| e["body"]["extends"] != *k)
        {
            return Err(refuse(
                "body_ref_missing",
                "requires.packages contains an unused dependency",
            ));
        }
        Ok(())
    }
}

fn files_total(files: &BTreeMap<String, Vec<u8>>) -> usize {
    files.values().map(Vec::len).sum()
}

fn safe_path(path: &str) -> bool {
    !path.is_empty()
        && !path.contains('\\')
        && !path.contains(':')
        && path
            .split('/')
            .all(|p| !p.is_empty() && p != "." && p != "..")
}

fn referenced_files(body: &Value) -> BTreeSet<String> {
    let mut refs = BTreeSet::new();
    for entry in list(body, "categories")
        .iter()
        .chain(list(&body["extraction"], "events"))
    {
        if let Some(path) = entry["definition_file"].as_str() {
            refs.insert(path.into());
        }
    }
    for doc in body["prompts"]
        .as_object()
        .into_iter()
        .flat_map(|m| m.values())
    {
        for section in list(doc, "sections") {
            if let Some(path) = section["file"].as_str() {
                refs.insert(path.into());
            }
        }
    }
    for cal in [&body["calibration"], &body["overrides"]["calibration"]] {
        if let Some(path) = cal["file"].as_str() {
            refs.insert(path.into());
        }
    }
    refs
}

#[derive(Clone, Debug)]
pub(crate) struct Profile {
    pub name: String,
    pub version: String,
    pub digest: String,
    pub body: Value,
    pub packages: Vec<Package>,
    pub warnings: Vec<String>,
}

impl Profile {
    pub fn effective_category(&self, tag: &str) -> Option<&str> {
        list(&self.body, "categories")
            .iter()
            .find(|c| c["tag"] == tag)
            .and_then(|c| c["id"].as_str())
            .or_else(|| self.body["category_map"][tag].as_str())
    }

    pub fn member(&self, entry: &Value, field: &str) -> Result<&str> {
        let package = self
            .packages
            .iter()
            .find(|p| p.env["name"] == entry["_from"])
            .ok_or_else(|| refuse("body_ref_missing", "member provenance missing"))?;
        let path = text(entry, field);
        let bytes = package
            .files
            .get(path)
            .ok_or_else(|| refuse("body_ref_missing", format!("body member {path} missing")))?;
        std::str::from_utf8(bytes)
            .map_err(|_| refuse("prompt_invalid", format!("member {path} is not UTF-8")))
    }
}

pub(crate) fn load_chain(chain: &[Package]) -> Result<Profile> {
    if chain.is_empty() || chain.len() > 4 || chain[0].env["name"] != BASE {
        return Err(refuse(
            "profile_chain_invalid",
            "chain must start at memory-base and have at most four layers",
        ));
    }
    let mut body = Value::Null;
    for (i, package) in chain.iter().enumerate() {
        package.validate()?;
        let mut child = package.env["body"].clone();
        stamp(&mut child, text(&package.env, "name"));
        namespaces(package, if i == 0 { None } else { Some(&body) })?;
        if i == 0 {
            if !child["extends"].is_null() {
                return Err(refuse(
                    "profile_chain_invalid",
                    "base extends another package",
                ));
            }
            body = child;
        } else {
            let parent = &chain[i - 1];
            let parent_name = text(&parent.env, "name");
            if child["extends"] != parent_name {
                return Err(refuse(
                    "profile_chain_invalid",
                    "extends differs from parent",
                ));
            }
            let range = text(&package.env["requires"]["packages"], parent_name);
            let valid = semver::VersionReq::parse(range)
                .ok()
                .zip(semver::Version::parse(text(&parent.env, "version")).ok())
                .is_some_and(|(r, v)| r.matches(&v));
            if !valid {
                return Err(refuse(
                    "base_version_mismatch",
                    format!("base {parent_name} does not satisfy {range}"),
                ));
            }
            overlay(&mut body, &child)?;
        }
    }
    let leaf = &chain.last().unwrap().env;
    if body["abstract"] == true {
        return Err(refuse(
            "profile_chain_invalid",
            "an abstract profile cannot be an agent root",
        ));
    }
    let identity: Vec<Value> = chain.iter().map(|p| json!({"name": p.env["name"], "version": p.env["version"], "ck_sha256": sha256(&p.ck_bytes)})).collect();
    let profile = Profile {
        name: text(leaf, "name").into(),
        version: text(leaf, "version").into(),
        digest: sha256(&serde_jcs::to_vec(&identity).expect("chain JCS")),
        body,
        packages: chain.to_vec(),
        warnings: if scope(text(leaf, "name")) != "cortexkit" {
            vec!["third-party memory profile".into()]
        } else {
            vec![]
        },
    };
    validate_resolved(&profile)?;
    Ok(profile)
}

fn scope(name: &str) -> &str {
    name.trim_start_matches('@').split('/').next().unwrap_or("")
}

fn stamp(body: &mut Value, name: &str) {
    for key in ["categories", "tasks", "decay_classes", "render_slots"] {
        if let Some(entries) = body[key].as_array_mut() {
            for e in entries {
                e["_from"] = name.into();
            }
        }
    }
    if let Some(events) = body["extraction"]["events"].as_array_mut() {
        for e in events {
            e["_from"] = name.into();
        }
    }
    if let Some(docs) = body["prompts"].as_object_mut() {
        for doc in docs.values_mut() {
            for s in doc["sections"].as_array_mut().unwrap() {
                s["_from"] = name.into();
            }
        }
    }
}

fn namespaces(pkg: &Package, parent: Option<&Value>) -> Result<()> {
    let name = text(&pkg.env, "name");
    let short = name
        .split('/')
        .nth(1)
        .unwrap()
        .trim_start_matches("memory-");
    let namespace = if scope(name) == "cortexkit" {
        short.to_owned()
    } else {
        format!("{}.{short}", scope(name))
    };
    let entries = |b: &Value| -> Vec<Value> {
        ["categories", "tasks", "decay_classes", "render_slots"]
            .iter()
            .flat_map(|k| list(b, k).to_vec())
            .chain(list(&b["extraction"], "events").to_vec())
            .collect()
    };
    let inherited: BTreeSet<String> = parent
        .map(entries)
        .unwrap_or_default()
        .iter()
        .map(|e| text(e, "id").into())
        .collect();
    for e in entries(&pkg.env["body"]) {
        let id = text(&e, "id");
        let root_vocabulary = parent.is_none()
            && !id.contains(':')
            && ["decay_classes", "render_slots"]
                .iter()
                .any(|k| list(&pkg.env["body"], k).contains(&e));
        if namespace == "mc"
            || (!inherited.contains(id)
                && !root_vocabulary
                && !id.starts_with(&format!("{namespace}:")))
        {
            return Err(refuse(
                "namespace_violation",
                format!("new id {id} must use the namespace `{namespace}:`"),
            ));
        }
    }
    Ok(())
}

fn merge_entries(base: &Value, child: &Value, kind: &str) -> Result<Value> {
    let mut result = base.as_array().cloned().unwrap_or_default();
    for e in child.as_array().into_iter().flatten() {
        if let Some(at) = result.iter().position(|b| b["id"] == e["id"]) {
            if e["override"] != true {
                return Err(refuse(
                    "namespace_violation",
                    "inherited entry redeclared without `override: true`",
                ));
            }
            let old = &result[at];
            if kind == "task" && old["id"] == REVIEW {
                return Err(refuse(
                    "override_not_allowed",
                    "global review is never overridden",
                ));
            }
            if kind == "task" && old["enabled"] == true && e["enabled"] == false {
                return Err(refuse(
                    "override_not_allowed",
                    "an override may not disable a base task",
                ));
            }
            for key in match kind {
                "task" => &["kind"][..],
                "category" => &["tag", "stream"][..],
                "event" => &["tag"][..],
                _ => &[],
            } {
                if old[key] != e[key] {
                    return Err(refuse(
                        "override_not_allowed",
                        format!("override changes {key}"),
                    ));
                }
            }
            result[at] = e.clone();
        } else {
            if e["override"] == true {
                return Err(refuse(
                    "override_not_allowed",
                    "override has no inherited entry",
                ));
            }
            result.push(e.clone());
        }
    }
    Ok(result.into())
}

fn merge_map(base: &Value, child: &Value) -> Result<Value> {
    let mut out = base.as_object().cloned().unwrap_or_default();
    for (k, v) in child.as_object().into_iter().flatten() {
        if out.insert(k.clone(), v.clone()).is_some() {
            return Err(refuse(
                "override_not_allowed",
                format!("map key {k} already declared"),
            ));
        }
    }
    Ok(out.into())
}

fn overlay(base: &mut Value, child: &Value) -> Result<()> {
    for key in ["schema", "abstract", "extends", "serves", "default_for"] {
        base[key] = child[key].clone();
    }
    for (key, kind) in [
        ("categories", "category"),
        ("tasks", "task"),
        ("decay_classes", "decay"),
        ("render_slots", "slot"),
    ] {
        base[key] = merge_entries(&base[key], &child[key], kind)?;
    }
    if child["extraction"]
        .as_object()
        .is_some_and(|m| m.keys().any(|k| k != "events"))
        || child.get("calibration").is_some()
        || child["retention"].get("default_ttl_ms").is_some()
    {
        return Err(refuse(
            "override_not_allowed",
            "inherited scalar replacement requires overrides",
        ));
    }
    base["extraction"]["events"] = merge_entries(
        &base["extraction"]["events"],
        &child["extraction"]["events"],
        "event",
    )?;
    for key in ["category_ttl_ms", "legacy_ttl_ms"] {
        base["retention"][key] = merge_map(&base["retention"][key], &child["retention"][key])?;
    }
    base["category_map"] = merge_map(&base["category_map"], &child["category_map"])?;
    let mut examples = list(&base["main_agent"], "memory_examples").to_vec();
    examples.extend_from_slice(list(&child["main_agent"], "memory_examples"));
    base["main_agent"]["memory_examples"] = examples.into();
    let review_docs: BTreeSet<String> = list(base, "tasks")
        .iter()
        .find(|t| t["id"] == REVIEW)
        .and_then(|t| t["prompts"].as_object())
        .into_iter()
        .flat_map(|m| m.values())
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect();
    for (id, doc) in child["prompts"].as_object().into_iter().flatten() {
        if let Some(target) = base["prompts"].get_mut(id) {
            if doc.get("variants").is_some() || doc.get("ext").is_some() {
                return Err(refuse(
                    "override_not_allowed",
                    "document variants belong to declaring layer",
                ));
            }
            let sections = target["sections"].as_array_mut().unwrap();
            for s in list(doc, "sections") {
                let at = sections.iter().position(|old| old["id"] == s["id"]);
                if s["override"] == true {
                    let at = at.ok_or_else(|| {
                        refuse("override_not_allowed", "unknown section override")
                    })?;
                    if sections[at].get("mc").is_some() {
                        return Err(refuse(
                            "override_not_allowed",
                            "MC-owned sections cannot be overridden",
                        ));
                    }
                    if review_docs.contains(id) {
                        return Err(refuse(
                            "override_not_allowed",
                            "global review sections are never overridden",
                        ));
                    }
                    if s.get("mc").is_some() {
                        return Err(refuse(
                            "override_not_allowed",
                            "override supplies an MC frame",
                        ));
                    }
                    let target = sections[at].as_object_mut().unwrap();
                    for (key, value) in s.as_object().unwrap() {
                        if key != "override" {
                            target.insert(key.clone(), value.clone());
                        }
                    }
                } else {
                    if at.is_some() {
                        return Err(refuse("override_not_allowed", "section already exists"));
                    }
                    let anchor = s.get("after").or_else(|| s.get("before")).ok_or_else(|| {
                        refuse(
                            "override_not_allowed",
                            "child section needs override, after or before",
                        )
                    })?;
                    let anchor = sections
                        .iter()
                        .position(|old| &old["id"] == anchor)
                        .ok_or_else(|| refuse("override_not_allowed", "section anchor missing"))?;
                    sections.insert(anchor + usize::from(s.get("after").is_some()), s.clone());
                }
            }
        } else {
            if list(doc, "sections").iter().any(|s| {
                ["override", "after", "before"]
                    .iter()
                    .any(|k| s.get(k).is_some())
            }) {
                return Err(refuse(
                    "override_not_allowed",
                    "new document sections must be in order",
                ));
            }
            base["prompts"][id] = doc.clone();
        }
    }
    for (path, value) in child["overrides"].as_object().into_iter().flatten() {
        let pointer = format!("/{}", path.replace('.', "/"));
        let target = base
            .pointer_mut(&pointer)
            .ok_or_else(|| refuse("override_not_allowed", format!("no base value {path}")))?;
        *target = value.clone();
    }
    for extension in list(child, "extend") {
        let mut path: Vec<_> = text(extension, "path").split('.').collect();
        let collection = path.remove(0);
        let field = path
            .pop()
            .ok_or_else(|| refuse("override_not_allowed", "invalid extend path"))?;
        let id = path.join(".");
        let entry = base[collection]
            .as_array_mut()
            .and_then(|a| a.iter_mut().find(|e| e["id"] == id))
            .ok_or_else(|| refuse("override_not_allowed", "extend target missing"))?;
        let target = entry[field]
            .as_array_mut()
            .ok_or_else(|| refuse("override_not_allowed", "extend target is not a list"))?;
        for v in list(extension, "append") {
            if target.contains(v) {
                return Err(refuse("override_not_allowed", "extend duplicates an item"));
            }
            target.push(v.clone());
        }
    }
    Ok(())
}

struct Interface {
    reads: &'static [&'static str],
    actions: &'static [&'static str],
    roles: &'static [&'static str],
    optional: &'static [&'static str],
    settings: &'static [&'static str],
    frames: &'static [&'static str],
}

fn interface(kind: &str) -> Option<Interface> {
    let (reads, actions, roles, optional, settings, frames): (_, _, _, _, _, &[&str]) = match kind {
        "map-memories" => (
            &["memory-pool", "repo-files"][..],
            &["record-mapping"][..],
            &["system", "user"][..],
            &[][..],
            &["map_extensions", "seed_paths_per_memory"][..],
            &["map-memories.input", "map-memories.output-contract"],
        ),
        "verify" => (
            &["memory-pool", "repo-files", "git"][..],
            &["mark-verified", "update", "archive", "skip"][..],
            &["system", "user"][..],
            &["user_without_diff"][..],
            &[][..],
            &["verify.input.with-diff", "verify.output-contract"],
        ),
        "verify-broad" => (
            &["memory-pool", "repo-files"][..],
            &["mark-verified", "update", "archive", "skip"][..],
            &["system", "user"][..],
            &[][..],
            &[][..],
            &["verify.input", "verify.output-contract"],
        ),
        "curate" => (
            &["memory-pool"][..],
            &["merge", "update", "write-split", "archive"][..],
            &["system", "user"][..],
            &[][..],
            &[][..],
            &["curate.input", "curate.memory-operations"],
        ),
        "compress-cues" => (
            &["memory-pool"][..],
            &["set-cue"][..],
            &["system", "user"][..],
            &[][..],
            &["cue_chars_high", "cue_chars_low", "cue_high_from"][..],
            &["compress-cues.input", "compress-cues.output-contract"],
        ),
        "classify-memories" => (
            &["memory-pool"][..],
            &[
                "set-importance",
                "set-scope",
                "set-shareable",
                "set-safety-critical",
            ][..],
            &["system", "user"][..],
            &[][..],
            &[][..],
            &[
                "classify-memories.input",
                "classify-memories.output-contract",
            ],
        ),
        "reflect-events" => (
            &["historian-events", "session-transcripts", "memory-pool"][..],
            &["write-memory", "write-observation-candidate"][..],
            &["gate_system", "gate_user", "system", "user"][..],
            &[][..],
            &["min_proof_count", "group_events_by"][..],
            &[
                "reflect-events.gate.input",
                "reflect-events.gate.output-contract",
                "reflect-events.input",
                "reflect-events.output-contract",
            ],
        ),
        "maintain-docs" => (
            &["repo-files", "git"][..],
            &["propose-doc-change"][..],
            &["system", "user"][..],
            &[][..],
            &[][..],
            &["maintain-docs.input", "maintain-docs.output-contract"],
        ),
        "refresh-primers" => (
            &["primers", "repo-files", "session-transcripts"][..],
            &["set-primer-answer"][..],
            &["system", "user_raw", "user_closed_book"][..],
            &[][..],
            &[][..],
            &[
                "refresh-primers.input.raw",
                "refresh-primers.input.closed-book",
                "refresh-primers.output-contract",
            ],
        ),
        "review-user-memories" => (
            &["historian-user-observations", "user-profile"][..],
            &["promote", "update", "dismiss", "consume-candidates"][..],
            &["system", "user"][..],
            &[][..],
            &[][..],
            &[
                "review-user-memories.input",
                "review-user-memories.safety-rules",
                "review-user-memories.output-contract",
            ],
        ),
        _ => return None,
    };
    Some(Interface {
        reads,
        actions,
        roles,
        optional,
        settings,
        frames,
    })
}

fn frames(profile: &Profile, doc: &str) -> Result<BTreeSet<String>> {
    let mut out = BTreeSet::new();
    let marker = regex::Regex::new(r"(?m)^⟦mc:([^⟧]+)⟧$").unwrap();
    for section in list(&profile.body["prompts"][doc], "sections") {
        if let Some(frame) = section["mc"].as_str() {
            out.insert(frame.trim_start_matches("dreamer/").into());
        }
        if section.get("file").is_some() {
            for m in marker.captures_iter(profile.member(section, "file")?) {
                out.insert(m[1].trim_start_matches("dreamer/").into());
            }
        }
    }
    Ok(out)
}

fn validate_resolved(p: &Profile) -> Result<()> {
    let r = &p.body;
    let cats = list(r, "categories");
    let tasks = list(r, "tasks");
    let events = list(&r["extraction"], "events");
    for domain in list(r, "default_for") {
        if !list(r, "serves").contains(domain) {
            return Err(refuse(
                "profile_schema_invalid",
                "default_for is not in serves",
            ));
        }
        if scope(domain.as_str().unwrap_or("")) != scope(&p.name) {
            return Err(refuse(
                "default_scope_mismatch",
                "default_scope_mismatch: publisher does not own domain",
            ));
        }
    }
    if cats.len() > 24 {
        return Err(refuse(
            "category_cap",
            format!("{} categories exceed the cap of 24", cats.len()),
        ));
    }
    let mut tags = BTreeSet::new();
    for c in cats {
        let tag = text(c, "tag");
        if !tags.insert(tag) {
            return Err(refuse("tag_conflict", format!("duplicate tag {tag}")));
        }
        if RESERVED.contains(&tag) {
            return Err(refuse(
                "tag_conflict",
                format!("tag {tag} is reserved by MC"),
            ));
        }
        if !list(c, "allowed_levels").contains(&c["default_level"]) {
            return Err(refuse(
                "category_invalid",
                "default level not in allowed_levels",
            ));
        }
        if !list(r, "decay_classes")
            .iter()
            .any(|d| d["id"] == c["decay_class"])
        {
            return Err(refuse("category_invalid", "unknown decay class"));
        }
        if c["sensitive"] == true && c["visibility"] != "own-profile" {
            return Err(refuse(
                "category_invalid",
                "sensitive category must be own-profile",
            ));
        }
        if r["retention"]["category_ttl_ms"]
            .get(text(c, "id"))
            .is_none()
        {
            return Err(refuse("category_invalid", "missing category_ttl_ms"));
        }
        let definition = p.member(c, "definition_file")?;
        if !definition.starts_with(&format!("#### `{tag}`"))
            || !definition.contains(&format!("**Test**: {:?}", text(c, "test")))
            || c["definition"]
                .as_str()
                .is_some_and(|d| !definition.contains(d))
        {
            return Err(refuse(
                "category_invalid",
                "test or definition missing from definition file",
            ));
        }
    }
    for id in r["retention"]["category_ttl_ms"]
        .as_object()
        .into_iter()
        .flat_map(|m| m.keys())
    {
        if !cats.iter().any(|c| c["id"] == *id) {
            return Err(refuse(
                "category_invalid",
                "retention entry has no category",
            ));
        }
    }
    for target in r["category_map"]
        .as_object()
        .into_iter()
        .flat_map(|m| m.values())
    {
        if !target.is_null()
            && (!cats.iter().any(|c| c["id"] == *target)
                || target
                    .as_str()
                    .is_some_and(|t| r["category_map"].get(t).is_some()))
        {
            return Err(refuse(
                "category_map_invalid",
                "category_map target missing or chained",
            ));
        }
    }
    let mut used: BTreeSet<String> = MAIN
        .iter()
        .map(|s| (*s).into())
        .chain(["historian/system".into()])
        .collect();
    for task in tasks {
        let kind = text(task, "kind");
        let iface = interface(kind).ok_or_else(|| {
            refuse(
                "task_interface_mismatch",
                format!("unknown task interface {kind}"),
            )
        })?;
        let mismatch = |detail: String| refuse("task_interface_mismatch", detail);
        for action in list(task, "actions") {
            if !iface.actions.contains(&action.as_str().unwrap_or("")) {
                return Err(mismatch(format!(
                    "action {action} is not in the {kind} interface"
                )));
            }
        }
        for read in list(task, "reads") {
            if !iface.reads.contains(&read.as_str().unwrap_or("")) {
                return Err(mismatch(format!(
                    "reads {read}, outside the {kind} interface"
                )));
            }
        }
        for evidence in list(task, "evidence") {
            if !list(task, "reads").contains(evidence) {
                return Err(mismatch("evidence is outside reads".into()));
            }
        }
        for cat in list(task, "categories") {
            if !cats.iter().any(|c| c["id"] == *cat) {
                return Err(mismatch("unknown category".into()));
            }
        }
        for setting in task["settings"]
            .as_object()
            .into_iter()
            .flat_map(|m| m.keys())
        {
            if !iface.settings.contains(&setting.as_str()) {
                return Err(mismatch(format!(
                    "setting {setting} is not in the {kind} interface"
                )));
            }
        }
        for role in iface.roles {
            if task["prompts"].get(role).is_none() {
                return Err(mismatch(format!("prompt role {role} missing")));
            }
        }
        let mut found_frames = BTreeSet::new();
        for (role, doc) in task["prompts"].as_object().unwrap() {
            if !iface.roles.contains(&role.as_str()) && !iface.optional.contains(&role.as_str()) {
                return Err(mismatch(format!("unknown prompt role {role}")));
            }
            let doc = doc.as_str().unwrap();
            if r["prompts"].get(doc).is_none() {
                return Err(mismatch(format!("prompt document {doc} missing")));
            }
            used.insert(doc.into());
            found_frames.extend(frames(p, doc)?);
        }
        for required in iface.frames {
            if !found_frames.contains(*required) {
                return Err(mismatch(format!(
                    "prompts must contain the MC frame {required}"
                )));
            }
        }
        if let Some(builtin) = task["replaces_builtin"].as_str() {
            if builtin != "retrospective" || kind != "reflect-events" {
                return Err(mismatch("invalid replaces_builtin".into()));
            }
        }
        if kind == "reflect-events" {
            if task["settings"]["min_proof_count"].as_u64().unwrap_or(0) == 0
                || list(task, "event_kinds").is_empty()
            {
                return Err(mismatch(
                    "reflect-events requires proof count and event kinds".into(),
                ));
            }
        } else if task.get("event_kinds").is_some() {
            return Err(mismatch("only reflect-events consumes event kinds".into()));
        }
        for id in list(task, "event_kinds") {
            if !events.iter().any(|e| e["id"] == *id) {
                return Err(mismatch("unknown event kind".into()));
            }
        }
        for field in list(&task["settings"], "group_events_by") {
            if !events.iter().any(|e| {
                list(task, "event_kinds").contains(&e["id"])
                    && e["enums"].get(field.as_str().unwrap()).is_some()
            }) {
                return Err(refuse(
                    "event_kind_invalid",
                    "group_events_by is not enumerated by a consumed event",
                ));
            }
        }
    }
    let review = tasks
        .iter()
        .find(|t| t["id"] == REVIEW)
        .ok_or_else(|| refuse("user_category_uncovered", "global review missing"))?;
    for c in cats.iter().filter(|c| c["stream"] == "user-observation") {
        if !list(review, "categories").contains(&c["id"]) {
            return Err(refuse(
                "user_category_uncovered",
                "user category must be curated by the one global review",
            ));
        }
        if !list(r, "render_slots")
            .iter()
            .any(|s| list(s, "categories").contains(&c["id"]))
        {
            return Err(refuse(
                "user_category_uncovered",
                "user category has no render slot",
            ));
        }
    }
    tags.clear();
    for event in events {
        let tag = text(event, "tag");
        if !tags.insert(tag) || RESERVED.contains(&tag) {
            return Err(refuse(
                "tag_conflict",
                "event tag duplicate or reserved by MC",
            ));
        }
        let consumer = tasks
            .iter()
            .find(|t| t["id"] == event["consumer"] && t["enabled"] == true)
            .ok_or_else(|| refuse("event_kind_invalid", "event has no enabled consumer"))?;
        if !list(consumer, "event_kinds").contains(&event["id"]) {
            return Err(refuse(
                "event_kind_invalid",
                format!("consumer {} does not list it", text(consumer, "id")),
            ));
        }
        let fields: Vec<_> = list(&event["fields"], "required")
            .iter()
            .chain(list(&event["fields"], "optional"))
            .collect();
        for field in list(event, "shape_fields").iter().chain(
            event["enums"]
                .as_object()
                .into_iter()
                .flat_map(|m| m.keys())
                .map(|k| Value::String(k.clone()))
                .collect::<Vec<_>>()
                .iter(),
        ) {
            if !fields.contains(&field) {
                return Err(refuse(
                    "event_kind_invalid",
                    "shape or enumerated field undeclared",
                ));
            }
        }
        let definition = p.member(event, "definition_file")?;
        if !definition.starts_with(&format!("### `{tag}`")) {
            return Err(refuse("event_kind_invalid", "event heading missing"));
        }
        for field in fields {
            if !definition.contains(&format!("- `{}`", field.as_str().unwrap())) {
                return Err(refuse(
                    "event_kind_invalid",
                    "field not described in its definition",
                ));
            }
        }
    }
    if let Some(primers) = r["extraction"]
        .get("primer_candidates")
        .filter(|v| !v.is_null())
    {
        if !tasks.iter().any(|t| {
            t["id"] == primers["answered_by"]
                && t["enabled"] == true
                && t["kind"] == "refresh-primers"
        }) || ![
            "mc:embedding",
            "mc:expiry",
            "mc:promote-primers",
            "mc:mural-rendering",
        ]
        .contains(&text(primers, "consumer"))
        {
            return Err(refuse(
                "primer_candidates_invalid",
                "invalid primer consumer or answered_by",
            ));
        }
    }
    for slot in list(r, "render_slots") {
        for id in list(slot, "categories") {
            if !cats
                .iter()
                .any(|c| c["id"] == *id && c["stream"] == "user-observation")
            {
                return Err(refuse(
                    "user_category_uncovered",
                    "render slot lists a non-user category",
                ));
            }
        }
    }
    for ex in list(&r["main_agent"], "memory_examples") {
        if !cats
            .iter()
            .any(|c| c["id"] == ex["category"] && c["stream"] == "fact")
        {
            return Err(refuse(
                "main_agent_invalid",
                "memory example is not a fact category",
            ));
        }
    }
    for id in r["prompts"].as_object().unwrap().keys() {
        if id.starts_with("main-agent/") && !MAIN.contains(&id.as_str()) {
            return Err(refuse(
                "prompt_invalid",
                "tool descriptions and other main-agent texts are MC-owned",
            ));
        }
        if !used.contains(id) {
            return Err(refuse(
                "prompt_invalid",
                format!("document {id} is rendered by nothing"),
            ));
        }
        let mut ids = BTreeSet::new();
        for section in list(&r["prompts"][id], "sections") {
            if !ids.insert(text(section, "id")) {
                return Err(refuse("prompt_invalid", "duplicate section id"));
            }
        }
    }
    for doc in MAIN.iter().copied().chain(["historian/system"]) {
        if r["prompts"].get(doc).is_none() {
            return Err(refuse("prompt_invalid", format!("missing document {doc}")));
        }
    }
    let historian = frames(p, "historian/system")?;
    for frame in ["historian/input-notation", "historian/output-contract"] {
        if !historian.contains(frame) {
            return Err(refuse(
                "prompt_invalid",
                format!("historian/system must contain the MC frame {frame}"),
            ));
        }
    }
    validate_markers(p)?;
    Ok(())
}

// This registry checks referenced frame names only. The host defines frame contents
// and rendering, so a package cannot add new frame names here.
const FRAMES: &[&str] = &[
    "dreamer/agent-registration.system",
    "dreamer/classify-memories.input",
    "dreamer/classify-memories.output-contract",
    "dreamer/compress-cues.input",
    "dreamer/compress-cues.output-contract",
    "dreamer/curate.input",
    "dreamer/curate.memory-operations",
    "dreamer/maintain-docs.input",
    "dreamer/maintain-docs.output-contract",
    "dreamer/map-memories.input",
    "dreamer/map-memories.output-contract",
    "dreamer/reflect-events.gate.input",
    "dreamer/reflect-events.gate.output-contract",
    "dreamer/reflect-events.input",
    "dreamer/reflect-events.output-contract",
    "dreamer/reflect-patterns.gate.input",
    "dreamer/reflect-patterns.gate.output-contract",
    "dreamer/reflect-patterns.input",
    "dreamer/reflect-patterns.output-contract",
    "dreamer/refresh-primers.input.closed-book",
    "dreamer/refresh-primers.input.raw",
    "dreamer/refresh-primers.output-contract",
    "dreamer/review-user-memories.input",
    "dreamer/review-user-memories.output-contract",
    "dreamer/review-user-memories.safety-rules",
    "dreamer/verify.input",
    "dreamer/verify.input.with-diff",
    "dreamer/verify.output-contract",
    "historian/input-notation",
    "historian/output-contract.xml",
    "historian/output-contract.combined",
    "historian/turn-one.project-memory-block",
    "historian/turn-one.reference-blocks",
    "historian/turn-one.user.production",
    "historian/turn-one.user.two-pass",
    "historian/turn-two.check.compatibility.system",
    "historian/turn-two.check.compatibility.user",
    "historian/turn-two.check.disproof.system",
    "historian/turn-two.check.kept-clause.system",
    "historian/turn-two.check.support.system",
    "historian/turn-two.check.user",
    "historian/turn-two.user",
    "main-agent/ctx_memory.description.full",
    "main-agent/ctx_memory.description.light",
    "main-agent/ctx_memory_list.description",
];

fn validate_frame(name: &str, variant: Option<&str>) -> Result<()> {
    let exists = if name.contains('/') {
        FRAMES.contains(&name)
            || variant.is_some_and(|v| FRAMES.contains(&format!("{name}.{v}").as_str()))
    } else {
        FRAMES
            .iter()
            .filter(|f| f.rsplit('/').next() == Some(name))
            .count()
            == 1
    };
    if exists {
        Ok(())
    } else {
        Err(refuse(
            "prompt_invalid",
            format!("MC frame {name} not found"),
        ))
    }
}

fn validate_markers(p: &Profile) -> Result<()> {
    let marker = regex::Regex::new(r"⟦(profile:|mc:|if )([^⟧]+)⟧").unwrap();
    let conditions = [
        "fact_categories",
        "user_categories",
        "event_kinds",
        "primer_candidates",
    ];
    let generators = [
        "fact-category-count",
        "fact-category-definitions",
        "fact-routing-list",
        "fact-routing-next",
        "fact-category-taxonomy",
        "fact-category-tags",
        "fact-shape-blocks",
        "project-memory-groups",
        "user-category-definitions",
        "user-category-tags",
        "user-category-list",
        "user-observation-shape-blocks",
        "event-definitions",
        "event-shape-blocks",
        "episode-types",
        "decay-class-list",
        "memory-guidance-categories",
        "memory-guidance-categories-light",
        "cue-chars-high",
        "cue-chars-low",
        "cue-high-from",
        "min-proof-count",
    ];
    let check_text = |value: &str, variant: Option<&str>| -> Result<()> {
        for line in value.lines() {
            for cap in marker.captures_iter(line) {
                let name = &cap[2];
                match &cap[1] {
                    "mc:" => {
                        if cap.get(0).unwrap().as_str() != line {
                            return Err(refuse(
                                "prompt_invalid",
                                "an MC marker must stand on its own line",
                            ));
                        }
                        validate_frame(name, variant)?;
                    }
                    "if " => {
                        if !conditions.contains(&name)
                            || !line.starts_with(cap.get(0).unwrap().as_str())
                        {
                            return Err(refuse(
                                "prompt_invalid",
                                format!("unknown condition {name}"),
                            ));
                        }
                    }
                    _ => {
                        let enum_exists = name.split_once('.').is_some_and(|(tag, field)| {
                            list(&p.body["extraction"], "events")
                                .iter()
                                .any(|e| e["tag"] == tag && e["enums"].get(field).is_some())
                        });
                        if !generators.contains(&name) && !enum_exists {
                            return Err(refuse(
                                "prompt_invalid",
                                format!("unknown profile marker {name}"),
                            ));
                        }
                        let needed = if name.starts_with("cue-") {
                            Some("compress-cues")
                        } else if name == "min-proof-count" {
                            Some("reflect-events")
                        } else {
                            None
                        };
                        if needed.is_some_and(|k| {
                            !list(&p.body, "tasks")
                                .iter()
                                .any(|t| t["kind"] == k && t["enabled"] == true)
                        }) {
                            return Err(refuse(
                                "prompt_invalid",
                                format!("marker {name} has no enabled task"),
                            ));
                        }
                    }
                }
            }
            let rest = marker.replace_all(line, "");
            if ["⟦profile:", "⟦mc:", "⟦if "]
                .iter()
                .any(|prefix| rest.contains(prefix))
            {
                return Err(refuse("prompt_invalid", "unexpanded malformed marker"));
            }
        }
        Ok(())
    };
    for doc in p.body["prompts"].as_object().unwrap().values() {
        let variants: Vec<Option<&str>> = match doc["variants"].as_array() {
            Some(v) => v.iter().map(Value::as_str).collect(),
            None => vec![None],
        };
        for variant in variants {
            for s in list(doc, "sections") {
                if s["requires"]
                    .as_str()
                    .is_some_and(|c| !conditions.contains(&c))
                {
                    return Err(refuse("prompt_invalid", "unknown section condition"));
                }
                if let Some(frame) = s["mc"].as_str() {
                    validate_frame(frame, variant)?;
                }
                if s.get("file").is_some() {
                    check_text(p.member(s, "file")?, variant)?;
                }
            }
        }
    }
    for entry in list(&p.body, "categories")
        .iter()
        .chain(list(&p.body["extraction"], "events"))
    {
        check_text(p.member(entry, "definition_file")?, None)?;
    }
    Ok(())
}
