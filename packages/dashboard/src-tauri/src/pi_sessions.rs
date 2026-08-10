use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize)]
pub struct PiSessionMeta {
    pub session_id: String,
    pub jsonl_path: PathBuf,
    pub cwd: String,
    pub created: i64,
    pub modified: i64,
    pub message_count: u32,
    pub first_message: String,
    pub session_name: Option<String>,
    pub parent_session_path: Option<String>,
    #[serde(skip)]
    pub has_usage_event: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PiSessionDetail {
    pub meta: PiSessionMeta,
    pub messages: Vec<PiMessage>,
    pub compaction_entries: Vec<PiCompactionEntry>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PiMessage {
    pub entry_id: String,
    pub parent_id: Option<String>,
    pub timestamp_ms: i64,
    pub role: String,
    pub text_preview: String,
    pub usage: Option<PiUsage>,
    pub stop_reason: Option<String>,
    pub raw_json: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct PiUsage {
    pub input: u32,
    pub output: u32,
    pub cache_read: u32,
    pub cache_write: u32,
    pub total: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct PiCompactionEntry {
    pub entry_id: String,
    pub parent_id: Option<String>,
    pub timestamp_ms: i64,
    pub summary: String,
    pub first_kept_entry_id: String,
    pub tokens_before: u32,
    pub from_hook: bool,
    pub raw_json: Value,
}

type MetaCache = HashMap<PathBuf, (SystemTime, Arc<PiSessionMeta>)>;
type DetailCache = HashMap<PathBuf, (SystemTime, Arc<PiSessionDetail>)>;

#[derive(Clone)]
struct OmpEnvironment {
    home: PathBuf,
    package_dir: Option<PathBuf>,
    path: std::ffi::OsString,
    app_data: Option<PathBuf>,
    config_dir: Option<PathBuf>,
    configured_agent: Option<PathBuf>,
    xdg_data: Option<PathBuf>,
    active_profile: Option<std::ffi::OsString>,
    windows: bool,
    unix: bool,
}

static META_CACHE: OnceLock<RwLock<MetaCache>> = OnceLock::new();
static DETAIL_CACHE: OnceLock<RwLock<DetailCache>> = OnceLock::new();
static TEST_ROOT: OnceLock<RwLock<Option<PathBuf>>> = OnceLock::new();

#[cfg(test)]
std::thread_local! {
    static TEST_OMP_ENVIRONMENT: std::cell::RefCell<Option<OmpEnvironment>> =
        std::cell::RefCell::new(None);
}

fn meta_cache() -> &'static RwLock<MetaCache> {
    META_CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

fn detail_cache() -> &'static RwLock<DetailCache> {
    DETAIL_CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

fn test_root() -> &'static RwLock<Option<PathBuf>> {
    TEST_ROOT.get_or_init(|| RwLock::new(None))
}

impl OmpEnvironment {
    fn from_process(home: PathBuf) -> Self {
        Self {
            home,
            package_dir: trimmed_env_path(std::env::var_os("PI_PACKAGE_DIR")),
            path: std::env::var_os("PATH").unwrap_or_default(),
            app_data: trimmed_env_path(std::env::var_os("APPDATA")),
            config_dir: trimmed_env_path(std::env::var_os("PI_CONFIG_DIR")),
            configured_agent: trimmed_env_path(std::env::var_os("PI_CODING_AGENT_DIR")),
            xdg_data: trimmed_env_path(std::env::var_os("XDG_DATA_HOME")),
            active_profile: active_omp_profile(),
            windows: cfg!(target_os = "windows"),
            unix: cfg!(target_os = "linux") || cfg!(target_os = "macos"),
        }
    }
}

fn current_omp_environment() -> Option<OmpEnvironment> {
    #[cfg(test)]
    if let Some(environment) = TEST_OMP_ENVIRONMENT.with(|value| value.borrow().clone()) {
        return Some(environment);
    }

    dirs::home_dir().map(OmpEnvironment::from_process)
}

#[cfg(test)]
struct TestOmpEnvironmentGuard;

#[cfg(test)]
impl Drop for TestOmpEnvironmentGuard {
    fn drop(&mut self) {
        TEST_OMP_ENVIRONMENT.with(|value| *value.borrow_mut() = None);
    }
}

#[cfg(test)]
fn set_test_omp_environment(environment: OmpEnvironment) -> TestOmpEnvironmentGuard {
    TEST_OMP_ENVIRONMENT.with(|value| *value.borrow_mut() = Some(environment));
    TestOmpEnvironmentGuard
}

fn trimmed_env_path(value: Option<std::ffi::OsString>) -> Option<PathBuf> {
    let value = value?;
    if let Some(text) = value.to_str() {
        let trimmed = text.trim();
        return (!trimmed.is_empty()).then(|| PathBuf::from(trimmed));
    }
    (!value.is_empty()).then(|| PathBuf::from(value))
}

fn normalize_omp_profile(value: Option<std::ffi::OsString>) -> Option<std::ffi::OsString> {
    let value = value?;
    let trimmed = value.to_string_lossy().trim().to_string();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("default") || trimmed.len() > 64 {
        return None;
    }
    let mut chars = trimmed.chars();
    let first = chars.next()?;
    let valid = (first.is_ascii_lowercase() || first.is_ascii_digit())
        && chars.all(|ch| {
            ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '.' | '_' | '-')
        });
    valid.then(|| trimmed.into())
}

fn resolve_omp_profile(
    omp_profile: Option<std::ffi::OsString>,
    pi_profile: Option<std::ffi::OsString>,
) -> Option<std::ffi::OsString> {
    normalize_omp_profile(match omp_profile {
        Some(value) => Some(value),
        None => pi_profile,
    })
}

fn active_omp_profile() -> Option<std::ffi::OsString> {
    resolve_omp_profile(
        std::env::var_os("OMP_PROFILE"),
        std::env::var_os("PI_PROFILE"),
    )
}

fn append_omp_profile_roots(roots: &mut Vec<PathBuf>, profiles_dir: &Path, xdg: bool) {
    let Ok(entries) = fs::read_dir(profiles_dir) else {
        return;
    };
    let mut discovered = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| {
            if xdg {
                entry.path().join("sessions")
            } else {
                entry.path().join("agent/sessions")
            }
        })
        .collect::<Vec<_>>();
    discovered.sort();
    roots.extend(discovered);
}

fn omp_package_dir_is_valid(path: &Path) -> bool {
    fs::read_to_string(path.join("package.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|manifest| manifest.get("name")?.as_str().map(str::to_owned))
        .is_some_and(|name| name == "@oh-my-pi/pi-coding-agent")
}

fn omp_fallback_binary_candidates(
    home: &Path,
    app_data: Option<&Path>,
    windows: bool,
) -> Vec<PathBuf> {
    if windows {
        let mut candidates = Vec::new();
        if let Some(app_data) = app_data {
            candidates.push(app_data.join("npm/omp.cmd"));
            candidates.push(app_data.join("npm/omp.exe"));
        }
        candidates.push(home.join(".bun/bin/omp.exe"));
        candidates.push(home.join(".bun/bin/omp.cmd"));
        return candidates;
    }
    vec![
        home.join(".bun/bin/omp"),
        home.join(".local/bin/omp"),
        PathBuf::from("/usr/local/bin/omp"),
        PathBuf::from("/opt/homebrew/bin/omp"),
        home.join(".local/share/mise/shims/omp"),
        home.join(".asdf/shims/omp"),
        home.join(".volta/bin/omp"),
    ]
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    fs::metadata(path).is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

fn omp_installation_detected(environment: &OmpEnvironment) -> bool {
    // OMP_PROFILE alone is not proof: the variable can be exported in a shell
    // that never installed OMP, and treating it as evidence would surface OMP
    // roots to plain Pi users. Require the same positive package/binary
    // evidence the Pi runtime uses.
    if environment
        .package_dir
        .as_deref()
        .is_some_and(omp_package_dir_is_valid)
    {
        return true;
    }
    let binary_names: &[&str] = if environment.windows {
        &["omp.exe", "omp.cmd"]
    } else {
        &["omp"]
    };
    if std::env::split_paths(&environment.path).any(|dir| {
        binary_names
            .iter()
            .any(|name| is_executable_file(&dir.join(name)))
    }) {
        return true;
    }
    omp_fallback_binary_candidates(
        &environment.home,
        environment.app_data.as_deref(),
        environment.windows,
    )
    .iter()
    .any(|path| is_executable_file(path))
}

/// OMP only relocates default-profile data into XDG on Unix while the configured
/// agent directory matches its derived default. A named profile is authoritative:
/// OMP ignores a stale/custom `PI_CODING_AGENT_DIR` and uses the initialized
/// profile-specific XDG root.
fn omp_xdg_allowed(
    configured_agent: Option<&Path>,
    expected_agent: &Path,
    active_named_profile: bool,
    unix: bool,
) -> bool {
    unix && (active_named_profile || configured_agent.map_or(true, |agent| agent == expected_agent))
}

fn deduplicate_session_roots(mut roots: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    roots.retain(|path| {
        let canonical = fs::canonicalize(path).unwrap_or_else(|_| path.clone());
        seen.insert(canonical)
    });
    roots
}

fn pi_session_roots_for_home(home: &Path, configured_agent: Option<&Path>) -> Vec<PathBuf> {
    let mut roots = vec![home.join(".pi/agent/sessions")];
    if let Some(agent_dir) = configured_agent {
        roots.push(agent_dir.join("sessions"));
    }
    deduplicate_session_roots(roots)
}

fn omp_session_roots_for_environment(environment: &OmpEnvironment) -> Vec<PathBuf> {
    let config_dir = environment
        .config_dir
        .clone()
        .unwrap_or_else(|| PathBuf::from(".omp"));
    let config_root = environment.home.join(config_dir);
    let default_agent = config_root.join("agent");
    let active_profile = &environment.active_profile;
    let mut roots = Vec::new();

    if let Some(agent_dir) = &environment.configured_agent {
        roots.push(agent_dir.join("sessions"));
    }

    // Keep the default root visible even when a named profile is active.
    roots.push(default_agent.join("sessions"));
    append_omp_profile_roots(&mut roots, &config_root.join("profiles"), false);

    // OMP only switches data into XDG on Unix while the agent directory is
    // the one it derives itself. OMP exports PI_CODING_AGENT_DIR for its
    // children, including named profiles, so compare against the ACTIVE
    // profile's agent dir rather than the default one.
    let expected_agent = match active_profile {
        Some(profile) => config_root.join("profiles").join(profile).join("agent"),
        None => default_agent,
    };
    if active_profile.is_some() {
        roots.push(expected_agent.join("sessions"));
    }

    let can_use_xdg = omp_xdg_allowed(
        environment.configured_agent.as_deref(),
        &expected_agent,
        active_profile.is_some(),
        environment.unix,
    );
    if can_use_xdg {
        if let Some(xdg_data) = &environment.xdg_data {
            let app_root = xdg_data.join("omp");
            if app_root.exists() {
                roots.push(app_root.join("sessions"));
                append_omp_profile_roots(&mut roots, &app_root.join("profiles"), true);
                if let Some(profile) = active_profile {
                    roots.push(app_root.join("profiles").join(profile).join("sessions"));
                }
            }
        }
    }

    deduplicate_session_roots(roots)
}

fn pi_session_roots() -> Vec<PathBuf> {
    if let Ok(root) = test_root().read() {
        if let Some(path) = root.clone() {
            return vec![path];
        }
    }

    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let configured_agent = trimmed_env_path(std::env::var_os("PI_CODING_AGENT_DIR"));
    pi_session_roots_for_home(&home, configured_agent.as_deref())
}

fn omp_session_roots() -> Vec<PathBuf> {
    let Some(environment) = current_omp_environment() else {
        return Vec::new();
    };
    if !omp_installation_detected(&environment) {
        return Vec::new();
    }
    omp_session_roots_for_environment(&environment)
}

fn deduplicate_pi_sessions(mut sessions: Vec<(usize, PiSessionMeta)>) -> Vec<PiSessionMeta> {
    sessions.sort_by(|(left_priority, left), (right_priority, right)| {
        right
            .modified
            .cmp(&left.modified)
            .then_with(|| left_priority.cmp(right_priority))
            .then_with(|| left.jsonl_path.cmp(&right.jsonl_path))
    });
    let mut seen_ids = HashSet::new();
    sessions.retain(|(_, session)| {
        session.session_id.is_empty() || seen_ids.insert(session.session_id.clone())
    });
    sessions.into_iter().map(|(_, session)| session).collect()
}

fn scan_session_roots(
    roots: Vec<PathBuf>,
    scan_root: fn(&Path) -> Vec<PiSessionMeta>,
) -> Vec<PiSessionMeta> {
    deduplicate_pi_sessions(
        roots
            .into_iter()
            .enumerate()
            .flat_map(|(priority, root)| {
                scan_root(&root)
                    .into_iter()
                    .map(move |session| (priority, session))
            })
            .collect(),
    )
}

pub fn scan_pi_session_dir() -> Vec<PiSessionMeta> {
    scan_session_roots(pi_session_roots(), scan_pi_session_dir_at)
}

pub fn scan_omp_session_dir() -> Vec<PiSessionMeta> {
    scan_session_roots(omp_session_roots(), scan_pi_session_dir_at)
}

pub fn scan_pi_compatible_session_dir() -> Vec<PiSessionMeta> {
    deduplicate_pi_sessions(
        scan_pi_session_dir()
            .into_iter()
            .map(|session| (0, session))
            .chain(
                scan_omp_session_dir()
                    .into_iter()
                    .map(|session| (1, session)),
            )
            .collect(),
    )
}

pub fn scan_pi_cache_session_dir() -> Vec<PiSessionMeta> {
    scan_session_roots(pi_session_roots(), scan_pi_cache_session_dir_at)
}

pub fn scan_omp_cache_session_dir() -> Vec<PiSessionMeta> {
    scan_session_roots(omp_session_roots(), scan_pi_cache_session_dir_at)
}

pub fn scan_pi_compatible_cache_session_dir() -> Vec<PiSessionMeta> {
    deduplicate_pi_sessions(
        scan_pi_cache_session_dir()
            .into_iter()
            .map(|session| (0, session))
            .chain(
                scan_omp_cache_session_dir()
                    .into_iter()
                    .map(|session| (1, session)),
            )
            .collect(),
    )
}

fn scan_pi_cache_session_dir_at(root: &Path) -> Vec<PiSessionMeta> {
    scan_pi_session_dir_at(root)
        .into_iter()
        .filter(|meta| meta.has_usage_event)
        .collect()
}

pub fn scan_pi_session_dir_at(root: &Path) -> Vec<PiSessionMeta> {
    if !root.exists() {
        return Vec::new();
    }

    let mut metas = Vec::new();
    let Ok(project_dirs) = fs::read_dir(root) else {
        return metas;
    };

    for project_dir in project_dirs.flatten() {
        let Ok(file_type) = project_dir.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let Ok(files) = fs::read_dir(project_dir.path()) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().is_some_and(|ext| ext == "jsonl") {
                if let Some(meta) = read_pi_session_meta(&path) {
                    metas.push(meta);
                }
            }
        }
    }

    metas.sort_by_key(|meta| std::cmp::Reverse(meta.modified));
    metas
}

pub fn read_pi_session_meta(path: &Path) -> Option<PiSessionMeta> {
    let mtime = file_mtime(path)?;
    if let Ok(cache) = meta_cache().read() {
        if let Some((cached_mtime, cached)) = cache.get(path) {
            if *cached_mtime == mtime {
                return Some((**cached).clone());
            }
        }
    }

    let meta = Arc::new(read_pi_session_meta_uncached(path, mtime)?);
    if let Ok(mut cache) = meta_cache().write() {
        cache.insert(path.to_path_buf(), (mtime, Arc::clone(&meta)));
    }
    Some((*meta).clone())
}

pub fn read_pi_session_detail(path: &Path) -> Option<PiSessionDetail> {
    let mtime = file_mtime(path)?;
    if let Ok(cache) = detail_cache().read() {
        if let Some((cached_mtime, cached)) = cache.get(path) {
            if *cached_mtime == mtime {
                return Some((**cached).clone());
            }
        }
    }

    let detail = Arc::new(read_pi_session_detail_uncached(path, &mut HashSet::new())?);
    if let Ok(mut cache) = detail_cache().write() {
        cache.insert(path.to_path_buf(), (mtime, Arc::clone(&detail)));
    }
    Some((*detail).clone())
}

pub fn find_pi_session_path(session_id: &str) -> Option<PathBuf> {
    scan_pi_compatible_session_dir()
        .into_iter()
        .find(|meta| meta.session_id == session_id)
        .map(|meta| meta.jsonl_path)
}

fn read_pi_session_meta_uncached(path: &Path, mtime: SystemTime) -> Option<PiSessionMeta> {
    let file = File::open(path).ok()?;
    let reader = BufReader::new(file);
    let mut lines = reader.lines();
    let header = parse_json_line(&lines.next()?.ok()?)?;
    if header.get("type")?.as_str()? != "session" {
        return None;
    }

    let mut message_count = 0u32;
    let mut first_message = String::new();
    let mut session_name = None;
    let mut last_activity_line = None;
    let mut has_usage_event = false;

    for line in lines.map_while(Result::ok) {
        if json_string_field_is(&line, "type", "session_info") {
            if let Some(entry) = parse_json_line(&line) {
                session_name = entry
                    .get("name")
                    .and_then(Value::as_str)
                    .map(normalize_title)
                    .filter(|name| !name.is_empty());
            }
            continue;
        }
        if !json_string_field_is(&line, "type", "message") {
            continue;
        }
        message_count = message_count.saturating_add(1);
        let is_user = json_string_field_is(&line, "role", "user");
        let is_assistant = json_string_field_is(&line, "role", "assistant");
        if !is_user && !is_assistant {
            continue;
        }
        if (first_message.is_empty() && is_user) || (!has_usage_event && is_assistant) {
            if let Some(entry) = parse_json_line(&line) {
                if let Some(message) = entry.get("message") {
                    if first_message.is_empty() && is_user {
                        let text = normalize_title(&extract_text_content(message));
                        if !text.is_empty() {
                            first_message = text;
                        }
                    }
                    if !has_usage_event && is_assistant {
                        has_usage_event =
                            extract_usage(message).is_some_and(|usage| usage.total > 0);
                    }
                }
            }
        }
        // JSONL entries are chronological. Retaining only the final activity
        // line avoids deserializing every large message merely to find its time.
        last_activity_line = Some(line);
    }

    let last_activity = last_activity_line.as_deref().and_then(|line| {
        let entry = parse_json_line(line)?;
        message_timestamp_ms(&entry, entry.get("message")?)
    });
    let created = parse_ts_ms(header.get("timestamp")).unwrap_or_else(|| system_time_ms(mtime));
    Some(PiSessionMeta {
        session_id: header.get("id")?.as_str()?.to_string(),
        jsonl_path: path.to_path_buf(),
        cwd: header
            .get("cwd")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        created,
        modified: last_activity.unwrap_or_else(|| system_time_ms(mtime).max(created)),
        message_count,
        first_message: if first_message.is_empty() {
            "(no messages)".to_string()
        } else {
            first_message
        },
        session_name,
        parent_session_path: header
            .get("parentSession")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        has_usage_event,
    })
}

fn read_pi_session_detail_uncached(
    path: &Path,
    visited: &mut HashSet<PathBuf>,
) -> Option<PiSessionDetail> {
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    if !visited.insert(canonical) {
        return None;
    }

    let meta = read_pi_session_meta(path)?;
    let mut messages = Vec::new();
    let mut compaction_entries = Vec::new();

    if let Some(parent) = meta.parent_session_path.as_deref() {
        let parent_path = PathBuf::from(parent);
        let parent_path = if parent_path.is_absolute() {
            parent_path
        } else {
            path.parent()
                .unwrap_or_else(|| Path::new(""))
                .join(parent_path)
        };
        if let Some(parent_detail) = read_pi_session_detail_uncached(&parent_path, visited) {
            messages.extend(parent_detail.messages);
            compaction_entries.extend(parent_detail.compaction_entries);
        }
    }

    let file = File::open(path).ok()?;
    let reader = BufReader::new(file);
    for (idx, line) in reader.lines().map_while(Result::ok).enumerate() {
        let Some(entry) = parse_json_line(&line) else {
            continue;
        };
        if idx == 0 && entry.get("type").and_then(Value::as_str) == Some("session") {
            continue;
        }
        match entry.get("type").and_then(Value::as_str) {
            Some("message") => {
                if let Some(message) = pi_message_from_entry(entry) {
                    messages.push(message);
                }
            }
            Some("compaction") => {
                compaction_entries.push(pi_compaction_from_entry(&entry));
                messages.push(PiMessage {
                    entry_id: get_string(&entry, "id"),
                    parent_id: get_optional_string(&entry, "parentId"),
                    timestamp_ms: entry_timestamp_ms(&entry),
                    role: "compactionSummary".to_string(),
                    text_preview: truncate_preview(
                        entry.get("summary").and_then(Value::as_str).unwrap_or(""),
                    ),
                    usage: None,
                    stop_reason: None,
                    raw_json: entry,
                });
            }
            Some("branch_summary") => messages.push(PiMessage {
                entry_id: get_string(&entry, "id"),
                parent_id: get_optional_string(&entry, "parentId"),
                timestamp_ms: entry_timestamp_ms(&entry),
                role: "branchSummary".to_string(),
                text_preview: truncate_preview(
                    entry.get("summary").and_then(Value::as_str).unwrap_or(""),
                ),
                usage: None,
                stop_reason: None,
                raw_json: entry,
            }),
            Some("custom_message") | Some("custom") => messages.push(PiMessage {
                entry_id: get_string(&entry, "id"),
                parent_id: get_optional_string(&entry, "parentId"),
                timestamp_ms: entry_timestamp_ms(&entry),
                role: "custom".to_string(),
                text_preview: truncate_preview(&extract_entry_text(&entry)),
                usage: None,
                stop_reason: None,
                raw_json: entry,
            }),
            _ => {}
        }
    }

    Some(PiSessionDetail {
        meta,
        messages,
        compaction_entries,
    })
}

fn pi_message_from_entry(entry: Value) -> Option<PiMessage> {
    let message = entry.get("message")?;
    let role = message
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    Some(PiMessage {
        entry_id: get_string(&entry, "id"),
        parent_id: get_optional_string(&entry, "parentId"),
        timestamp_ms: message_timestamp_ms(&entry, message)
            .unwrap_or_else(|| entry_timestamp_ms(&entry)),
        role,
        text_preview: truncate_preview(&extract_text_content(message)),
        usage: extract_usage(message),
        stop_reason: message
            .get("stopReason")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        raw_json: entry,
    })
}

fn pi_compaction_from_entry(entry: &Value) -> PiCompactionEntry {
    PiCompactionEntry {
        entry_id: get_string(entry, "id"),
        parent_id: get_optional_string(entry, "parentId"),
        timestamp_ms: entry_timestamp_ms(entry),
        summary: entry
            .get("summary")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        first_kept_entry_id: get_string(entry, "firstKeptEntryId"),
        tokens_before: entry
            .get("tokensBefore")
            .and_then(Value::as_u64)
            .unwrap_or(0) as u32,
        from_hook: entry
            .get("fromHook")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        raw_json: entry.clone(),
    }
}

fn extract_usage(message: &Value) -> Option<PiUsage> {
    let usage = message.get("usage").or_else(|| message.get("tokens"))?;
    let input = get_u32_any(usage, &["input", "inputTokens"]);
    let output = get_u32_any(usage, &["output", "outputTokens"]);
    let cache_read = usage
        .get("cache")
        .map(|cache| get_u32_any(cache, &["read", "cacheRead", "cache_read"]))
        .unwrap_or_else(|| get_u32_any(usage, &["cache_read", "cacheRead"]));
    let cache_write = usage
        .get("cache")
        .map(|cache| get_u32_any(cache, &["write", "cacheWrite", "cache_write"]))
        .unwrap_or_else(|| get_u32_any(usage, &["cache_write", "cacheWrite"]));
    let total = get_u32_any(usage, &["total", "totalTokens"]).max(
        input
            .saturating_add(output)
            .saturating_add(cache_read)
            .saturating_add(cache_write),
    );
    Some(PiUsage {
        input,
        output,
        cache_read,
        cache_write,
        total,
    })
}

fn get_u32_any(value: &Value, keys: &[&str]) -> u32 {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_u64).map(|n| n as u32))
        .unwrap_or(0)
}

fn extract_entry_text(entry: &Value) -> String {
    if let Some(content) = entry.get("content") {
        return extract_content_value(content);
    }
    entry
        .get("data")
        .map(extract_content_value)
        .unwrap_or_default()
}

fn extract_text_content(message: &Value) -> String {
    message
        .get("content")
        .map(extract_content_value)
        .unwrap_or_default()
}

fn extract_content_value(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    if let Some(parts) = content.as_array() {
        return parts
            .iter()
            .filter_map(|part| {
                if part.get("type").and_then(Value::as_str) == Some("text") {
                    part.get("text")
                        .and_then(Value::as_str)
                        .map(ToString::to_string)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join(" ");
    }
    String::new()
}

fn normalize_title(text: &str) -> String {
    text.chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

fn truncate_preview(text: &str) -> String {
    let normalized = normalize_title(text);
    const MAX_CHARS: usize = 500;
    if normalized.chars().count() <= MAX_CHARS {
        return normalized;
    }
    normalized.chars().take(MAX_CHARS).collect::<String>()
}

fn file_mtime(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).ok()?.modified().ok()
}

fn system_time_ms(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn json_string_field_is(line: &str, key: &str, expected: &str) -> bool {
    let quoted_key = match key {
        "type" => "\"type\"",
        "role" => "\"role\"",
        _ => return false,
    };
    let Some(key_start) = line.find(quoted_key) else {
        return false;
    };
    let after_key = line[key_start + quoted_key.len()..].trim_start();
    let Some(after_colon) = after_key.strip_prefix(':') else {
        return false;
    };
    after_colon
        .trim_start()
        .strip_prefix('"')
        .is_some_and(|value| {
            value.starts_with(expected) && value[expected.len()..].starts_with('"')
        })
}

fn parse_json_line(line: &str) -> Option<Value> {
    serde_json::from_str(line).ok()
}

fn parse_ts_ms(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::Number(n) => n.as_i64(),
        Value::String(s) => chrono::DateTime::parse_from_rfc3339(s)
            .map(|dt| dt.timestamp_millis())
            .ok()
            .or_else(|| s.parse::<i64>().ok()),
        _ => None,
    }
}

fn entry_timestamp_ms(entry: &Value) -> i64 {
    parse_ts_ms(entry.get("timestamp")).unwrap_or(0)
}

fn message_timestamp_ms(entry: &Value, message: &Value) -> Option<i64> {
    parse_ts_ms(message.get("timestamp")).or_else(|| parse_ts_ms(entry.get("timestamp")))
}

fn get_string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn get_optional_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

#[cfg(test)]
pub fn clear_caches_for_tests() {
    if let Ok(mut cache) = meta_cache().write() {
        cache.clear();
    }
    if let Ok(mut cache) = detail_cache().write() {
        cache.clear();
    }
    if let Ok(mut root) = test_root().write() {
        *root = None;
    }
    TEST_OMP_ENVIRONMENT.with(|value| *value.borrow_mut() = None);
}

#[cfg(test)]
pub fn set_test_root_for_tests(path: PathBuf) {
    if let Ok(mut root) = test_root().write() {
        *root = Some(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn fixture_path(dir: &tempfile::TempDir, content: &str) -> PathBuf {
        let session_dir = dir.path().join("--tmp-proj--");
        fs::create_dir_all(&session_dir).unwrap();
        let path = session_dir.join("2026-01-01_test.jsonl");
        fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn environment_paths_are_trimmed_and_blank_values_are_ignored() {
        assert_eq!(
            trimmed_env_path(Some("  /tmp/omp-agent  ".into())),
            Some(PathBuf::from("/tmp/omp-agent"))
        );
        assert_eq!(trimmed_env_path(Some("   ".into())), None);
        assert_eq!(trimmed_env_path(None), None);
    }

    #[cfg(unix)]
    #[test]
    fn environment_paths_preserve_non_utf8_bytes() {
        use std::os::unix::ffi::{OsStrExt, OsStringExt};

        let raw = std::ffi::OsString::from_vec(vec![b'/', b't', b'm', b'p', b'/', 0xff]);
        let path = trimmed_env_path(Some(raw.clone())).unwrap();
        assert_eq!(path.as_os_str().as_bytes(), raw.as_os_str().as_bytes());
    }

    #[test]
    fn discovers_named_omp_profile_session_roots() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("profiles/work/agent/sessions")).unwrap();
        fs::create_dir_all(dir.path().join("profiles/personal/agent/sessions")).unwrap();
        fs::write(dir.path().join("profiles/not-a-directory"), "").unwrap();
        let mut roots = Vec::new();
        append_omp_profile_roots(&mut roots, &dir.path().join("profiles"), false);
        roots.sort();
        assert_eq!(
            roots,
            vec![
                dir.path().join("profiles/personal/agent/sessions"),
                dir.path().join("profiles/work/agent/sessions"),
            ]
        );
    }

    #[test]
    fn public_omp_scanner_requires_positive_installation_evidence() {
        let home = tempfile::tempdir().unwrap();
        let session_root = home.path().join(".omp/agent/sessions/--tmp-proj--");
        fs::create_dir_all(&session_root).unwrap();
        fs::write(
            session_root.join("2026-01-01_omp.jsonl"),
            r#"{"type":"session","id":"omp-split-test","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp/omp-project"}"#,
        )
        .unwrap();

        let mut environment = OmpEnvironment {
            home: home.path().to_path_buf(),
            package_dir: None,
            path: std::ffi::OsString::new(),
            app_data: None,
            config_dir: None,
            configured_agent: None,
            xdg_data: None,
            active_profile: None,
            windows: cfg!(target_os = "windows"),
            unix: cfg!(target_os = "linux") || cfg!(target_os = "macos"),
        };
        {
            let _guard = set_test_omp_environment(environment.clone());
            assert!(scan_omp_session_dir().is_empty());
            assert!(scan_pi_compatible_session_dir()
                .iter()
                .all(|session| session.session_id != "omp-split-test"));
        }

        let package_dir = home.path().join("omp-package");
        fs::create_dir_all(&package_dir).unwrap();
        fs::write(
            package_dir.join("package.json"),
            r#"{"name":"@oh-my-pi/pi-coding-agent"}"#,
        )
        .unwrap();
        environment.package_dir = Some(package_dir);
        let _guard = set_test_omp_environment(environment);

        let omp_sessions = scan_omp_session_dir();
        assert_eq!(omp_sessions.len(), 1);
        assert_eq!(omp_sessions[0].session_id, "omp-split-test");
        assert!(scan_pi_compatible_session_dir()
            .iter()
            .any(|session| session.session_id == "omp-split-test"));
    }

    #[test]
    fn omp_detection_candidates_cover_gui_install_locations() {
        let home = Path::new("/home/fox");
        let unix = omp_fallback_binary_candidates(home, None, false);
        assert!(unix.contains(&PathBuf::from("/usr/local/bin/omp")));
        assert!(unix.contains(&PathBuf::from("/opt/homebrew/bin/omp")));
        assert!(unix.contains(&home.join(".local/share/mise/shims/omp")));
        assert!(unix.contains(&home.join(".asdf/shims/omp")));
        assert!(unix.contains(&home.join(".volta/bin/omp")));

        let app_data = Path::new("C:/Users/fox/AppData/Roaming");
        let windows =
            omp_fallback_binary_candidates(Path::new("C:/Users/fox"), Some(app_data), true);
        assert!(windows.contains(&app_data.join("npm/omp.cmd")));
        assert!(windows.contains(&PathBuf::from("C:/Users/fox/.bun/bin/omp.exe")));
    }

    #[test]
    fn xdg_guard_treats_an_active_named_profile_as_authoritative() {
        let default_agent = PathBuf::from("/home/fox/.omp/agent");
        let profile_agent = PathBuf::from("/home/fox/.omp/profiles/work/agent");
        let custom_agent = PathBuf::from("/home/fox/custom-agent");

        // Named profiles use their initialized XDG root even when the inherited
        // agent-dir override is stale or custom.
        assert!(omp_xdg_allowed(
            Some(&profile_agent),
            &profile_agent,
            true,
            true
        ));
        assert!(omp_xdg_allowed(
            Some(&custom_agent),
            &profile_agent,
            true,
            true
        ));
        assert!(omp_xdg_allowed(
            Some(&default_agent),
            &profile_agent,
            true,
            true
        ));

        // The default profile still requires its derived agent dir, and Windows
        // never uses the Unix XDG layout.
        assert!(omp_xdg_allowed(
            Some(&default_agent),
            &default_agent,
            false,
            true
        ));
        assert!(omp_xdg_allowed(None, &default_agent, false, true));
        assert!(!omp_xdg_allowed(
            Some(&custom_agent),
            &default_agent,
            false,
            true
        ));
        assert!(!omp_xdg_allowed(None, &profile_agent, true, false));
    }

    #[cfg(unix)]
    #[test]
    fn omp_detection_requires_an_executable_not_just_a_file() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let candidate = dir.path().join("omp");
        fs::write(&candidate, "not a real binary").unwrap();
        assert!(!is_executable_file(&candidate));

        let mut perms = fs::metadata(&candidate).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&candidate, perms).unwrap();
        assert!(is_executable_file(&candidate));

        assert!(!is_executable_file(dir.path()));
        assert!(!is_executable_file(&dir.path().join("missing-omp")));
    }

    #[test]
    fn omp_profile_rejects_unsafe_names_and_preserves_default_semantics() {
        assert_eq!(normalize_omp_profile(Some("".into())), None);
        assert_eq!(normalize_omp_profile(Some("  ".into())), None);
        assert_eq!(normalize_omp_profile(Some("default".into())), None);
        assert_eq!(normalize_omp_profile(Some("../escape".into())), None);
        assert_eq!(normalize_omp_profile(Some("UPPER".into())), None);
        assert_eq!(normalize_omp_profile(Some("bad/name".into())), None);
        assert_eq!(normalize_omp_profile(Some("a".repeat(65).into())), None);
        assert_eq!(
            normalize_omp_profile(Some(" work ".into())),
            Some("work".into())
        );
        assert_eq!(
            resolve_omp_profile(Some("".into()), Some("work".into())),
            None
        );
    }

    #[test]
    fn round_trip_small_pi_jsonl_fixture() {
        clear_caches_for_tests();
        let dir = tempfile::tempdir().unwrap();
        let path = fixture_path(
            &dir,
            r#"{"type":"session","version":3,"id":"s1","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp/proj"}
{"type":"message","id":"u1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"hello\nworld"}]}}
{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"hi"}],"usage":{"input":10,"output":5,"cache":{"read":3,"write":2},"total":20}}}
{"type":"session_info","id":"i1","parentId":"a1","timestamp":"2026-01-01T00:00:03.000Z","name":" Named "}
"#,
        );
        set_test_root_for_tests(dir.path().to_path_buf());

        let metas = scan_pi_session_dir();
        assert_eq!(metas.len(), 1);
        assert_eq!(scan_pi_cache_session_dir_at(dir.path()).len(), 1);
        assert_eq!(metas[0].session_id, "s1");
        assert_eq!(metas[0].cwd, "/tmp/proj");
        assert_eq!(metas[0].message_count, 2);
        assert_eq!(metas[0].first_message, "hello world");
        assert_eq!(metas[0].session_name.as_deref(), Some("Named"));

        let detail = read_pi_session_detail(&path).unwrap();
        assert_eq!(detail.messages.len(), 2);
        assert_eq!(detail.messages[1].usage.as_ref().unwrap().total, 20);
    }

    #[test]
    fn eventless_session_is_excluded_only_from_cache_discovery() {
        clear_caches_for_tests();
        let dir = tempfile::tempdir().unwrap();
        fixture_path(
            &dir,
            r#"{"type":"session","id":"s1","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp/proj"}
{"type":"message","id":"u1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"hello"}}
{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"assistant","content":"no accounting"}}
"#,
        );

        assert_eq!(scan_pi_session_dir_at(dir.path()).len(), 1);
        assert!(scan_pi_cache_session_dir_at(dir.path()).is_empty());
    }

    #[test]
    fn multi_root_discovery_deduplicates_logical_sessions() {
        clear_caches_for_tests();
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let content = r#"{"type":"session","id":"same-session","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp/proj"}"#;
        fixture_path(&first, content);
        fixture_path(&second, content);

        let mut first_sessions = scan_pi_session_dir_at(first.path());
        first_sessions[0].modified = 100;
        let mut second_sessions = scan_pi_session_dir_at(second.path());
        second_sessions[0].modified = 200;
        let newest_path = second_sessions[0].jsonl_path.clone();
        let sessions = deduplicate_pi_sessions(
            first_sessions
                .into_iter()
                .map(|session| (0, session))
                .chain(second_sessions.into_iter().map(|session| (1, session)))
                .collect(),
        );

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "same-session");
        assert_eq!(sessions[0].jsonl_path, newest_path);
    }

    #[test]
    fn tied_duplicates_keep_the_higher_priority_root() {
        let dir = tempfile::tempdir().unwrap();
        let content = r#"{"type":"session","id":"same-session","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp/proj"}"#;
        fixture_path(&dir, content);
        let original = scan_pi_session_dir_at(dir.path()).remove(0);
        let mut lower_priority = original.clone();
        lower_priority.jsonl_path = PathBuf::from("/lower-priority/session.jsonl");

        let sessions = deduplicate_pi_sessions(vec![(1, lower_priority), (0, original.clone())]);

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].jsonl_path, original.jsonl_path);
    }

    #[test]
    fn compaction_entry_handling() {
        clear_caches_for_tests();
        let dir = tempfile::tempdir().unwrap();
        let path = fixture_path(
            &dir,
            r#"{"type":"session","id":"s1","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp/proj"}
{"type":"compaction","id":"c1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","summary":"old stuff","firstKeptEntryId":"u2","tokensBefore":123,"fromHook":true}
"#,
        );
        let detail = read_pi_session_detail(&path).unwrap();
        assert_eq!(detail.compaction_entries.len(), 1);
        assert_eq!(detail.compaction_entries[0].summary, "old stuff");
        assert_eq!(detail.messages[0].role, "compactionSummary");
    }

    #[test]
    fn empty_or_missing_session_header_returns_none() {
        clear_caches_for_tests();
        let dir = tempfile::tempdir().unwrap();
        let empty = fixture_path(&dir, "");
        assert!(read_pi_session_meta(&empty).is_none());
        let bad = fixture_path(&dir, r#"{"type":"message","id":"m1"}"#);
        assert!(read_pi_session_meta(&bad).is_none());
    }

    #[test]
    fn malformed_json_line_is_skipped() {
        clear_caches_for_tests();
        let dir = tempfile::tempdir().unwrap();
        let path = fixture_path(
            &dir,
            r#"{"type":"session","id":"s1","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp/proj"}
not json
{"type":"message","id":"u1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"ok"}}
"#,
        );
        let meta = read_pi_session_meta(&path).unwrap();
        assert_eq!(meta.message_count, 1);
        assert_eq!(meta.first_message, "ok");
    }

    #[test]
    fn mtime_cache_invalidation_reloads_file() {
        clear_caches_for_tests();
        let dir = tempfile::tempdir().unwrap();
        let path = fixture_path(
            &dir,
            r#"{"type":"session","id":"s1","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp/proj"}
{"type":"message","id":"u1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"first"}}
"#,
        );
        let first = read_pi_session_meta(&path).unwrap();
        assert_eq!(first.first_message, "first");

        std::thread::sleep(std::time::Duration::from_millis(20));
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(file, "{{\"type\":\"message\",\"id\":\"u2\",\"parentId\":\"u1\",\"timestamp\":\"2026-01-01T00:00:02.000Z\",\"message\":{{\"role\":\"assistant\",\"content\":\"second\"}}}}").unwrap();
        drop(file);

        let second = read_pi_session_meta(&path).unwrap();
        assert_eq!(second.message_count, 2);
    }
}
