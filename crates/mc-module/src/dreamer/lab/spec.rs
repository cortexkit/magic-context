use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Deserialize;

const MAX_SPEC: usize = 1024 * 1024;
const MAX_CONTEXT: usize = 2 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Spec {
    pub project: String,
    pub root: PathBuf,
    pub store: PathBuf,
    pub checkouts: BTreeMap<String, PathBuf>,
    pub memory_ids: Vec<i64>,
    #[serde(default)]
    pub related: BTreeMap<i64, Vec<i64>>,
    pub history_sessions: Option<Vec<String>>,
    pub persona_dir: PathBuf,
    pub context_files: Vec<ContextFile>,
    pub tools: BTreeSet<Tool>,
    #[serde(default)]
    pub confirm_record_removals: bool,
    #[serde(default = "rerank_by_default")]
    pub rerank: bool,
    pub route: Option<Route>,
    /// The most model steps the session takes. A spec leaves it out to run
    /// with no step limit: a session cut at a count has read for nothing,
    /// and a test must show what a session costs when it finishes.
    #[serde(default = "no_step_limit")]
    pub step_cap: u64,
    #[serde(default = "default_deadline_minutes")]
    pub deadline_minutes: u64,
    pub out_dir: PathBuf,
}

/// The runner's plan needs a number, so this is one no session reaches.
fn no_step_limit() -> u64 {
    100_000
}

fn rerank_by_default() -> bool {
    true
}

/// The longest a spec may ask for. It ends a session that hangs; it is not
/// meant to end one that is working.
fn default_deadline_minutes() -> u64 {
    240
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub(super) enum Tool {
    Reader,
    Sidekick,
    GitRead,
    MemorySearch,
    HistorySearch,
    HistoryRead,
    Submit,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ContextFile {
    pub title: String,
    pub path: PathBuf,
}

#[derive(Deserialize)]
#[serde(untagged, deny_unknown_fields)]
pub(super) enum Route {
    Demand { iq: u8, eq: u8 },
    Pin(String),
}

impl Spec {
    // These checks are snapshots, not handles: only a process of the same
    // user may start the lab, and that user can already change these files.
    pub(super) async fn load(path: &Path, live: &Path) -> Result<Self, String> {
        let path = existing(path, "spec", false)?;
        reject_live(&path, live)?;
        let text = read_text(&path, MAX_SPEC)?;
        let mut spec: Self = serde_json::from_str(&text).map_err(|e| format!("spec: {e}"))?;
        if spec.project.trim().is_empty() {
            return Err("project must not be blank".into());
        }
        if spec.memory_ids.is_empty() || spec.memory_ids.len() > 5000 {
            return Err("memory_ids must contain between 1 and 5000 ids".into());
        }
        let judged: BTreeSet<_> = spec.memory_ids.iter().copied().collect();
        if judged.first().is_some_and(|id| *id <= 0) || judged.len() != spec.memory_ids.len() {
            return Err("memory_ids must be positive and distinct".into());
        }
        for (id, related) in &spec.related {
            if !judged.contains(id) {
                return Err(format!("related: memory {id} is not in memory_ids"));
            }
            if related.len() > 8 {
                return Err(format!(
                    "related: memory {id} lists {} related memories (at most 8)",
                    related.len()
                ));
            }
            if let Some(in_set) = related.iter().find(|id| judged.contains(id)) {
                return Err(format!("related: memory {in_set} is in memory_ids and cannot be listed under memory {id}"));
            }
        }
        if spec.context_files.len() > 64 {
            return Err("context_files may contain at most 64 files".into());
        }
        if spec.step_cap == 0 {
            return Err("step_cap must be positive".into());
        }
        if !(1..=240).contains(&spec.deadline_minutes) {
            return Err("deadline_minutes must be between 1 and 240".into());
        }
        match &spec.route {
            Some(Route::Demand { iq, eq }) if *iq > 100 || *eq > 100 => {
                return Err("route.iq and route.eq must be between 0 and 100".into());
            }
            Some(Route::Pin(pin))
                if !pin.split_once('/').is_some_and(|(provider, model)| {
                    !provider.is_empty() && !model.is_empty() && !pin.contains(char::is_whitespace)
                }) =>
            {
                return Err("the route pin must be provider/model[:variant]".into())
            }
            _ => {}
        }
        spec.root = existing(&spec.root, "root", true)?;
        if live
            .canonicalize()
            .is_ok_and(|live| live.starts_with(&spec.root))
        {
            return Err("root must not contain the live context.db".into());
        }
        spec.store = existing(&spec.store, "store", false)?;
        reject_live(&spec.store, live)?;
        if spec.checkouts.is_empty() {
            return Err("checkouts must name at least one worktree".into());
        }
        for (line, checkout) in &mut spec.checkouts {
            let field = format!("checkouts[{line:?}]");
            if checkout
                .symlink_metadata()
                .is_ok_and(|m| m.file_type().is_symlink())
            {
                return Err(format!("{field} must not be a symlink"));
            }
            let canonical = existing(checkout, &field, true)?;
            if checkout
                .parent()
                .and_then(|parent| parent.canonicalize().ok())
                .as_ref()
                != Some(&spec.root)
                || canonical.parent() != Some(&spec.root)
                || checkout.file_name() != canonical.file_name()
            {
                return Err(format!("{field} must be a direct subfolder of root"));
            }
            super::git::check_worktree(&canonical)
                .await
                .map_err(|e| format!("{field}: {e}"))?;
            *checkout = canonical;
        }
        spec.persona_dir = input_inside(&spec.persona_dir, &spec.root, "persona_dir", true)?;
        for file in &mut spec.context_files {
            file.path = input_inside(&file.path, &spec.root, "context_files.path", false)?;
            reject_live(&file.path, live)?;
        }
        spec.out_dir = output_path(&spec.out_dir, &spec.root)?;
        if spec.out_dir == spec.root
            || spec
                .checkouts
                .values()
                .any(|path| spec.out_dir.starts_with(path))
        {
            return Err("out_dir must not be root or inside a checkout".into());
        }
        Ok(spec)
    }

    pub(super) fn context(&self) -> Result<String, String> {
        let mut context = String::new();
        for file in &self.context_files {
            let text = read_text(&file.path, MAX_CONTEXT)?;
            if !context.is_empty() {
                context.push_str("\n\n");
            }
            context.push_str("## ");
            context.push_str(&file.title);
            context.push_str("\n\n");
            context.push_str(&text);
        }
        Ok(context)
    }

    pub(super) fn prepare_output(&self) -> Result<(), String> {
        fs::create_dir_all(&self.out_dir).map_err(|e| format!("out_dir: {e}"))?;
        let mut entries = fs::read_dir(&self.out_dir).map_err(|e| format!("out_dir: {e}"))?;
        if entries.next().is_some() {
            return Err("out_dir must be empty".into());
        }
        // Claim the folder atomically, even if another command just saw the
        // same empty directory. No run may replace a previous run's files.
        use std::io::Write;
        File::create_new(self.out_dir.join("verdicts.json"))
            .and_then(|mut file| {
                file.write_all(b"[]\n")?;
                file.sync_all()
            })
            .map_err(|e| format!("reserving out_dir: {e}"))?;
        Ok(())
    }
}

pub(super) fn read_text(path: &Path, max: usize) -> Result<String, String> {
    let mut bytes = Vec::new();
    File::open(path)
        .and_then(|file| file.take(max as u64 + 1).read_to_end(&mut bytes))
        .map_err(|e| format!("{}: {e}", path.display()))?;
    if bytes.len() > max {
        return Err(format!("{} exceeds {max} bytes", path.display()));
    }
    String::from_utf8(bytes).map_err(|e| format!("{} is not UTF-8: {e}", path.display()))
}

pub(super) fn input_inside(
    path: &Path,
    root: &Path,
    field: &str,
    dir: bool,
) -> Result<PathBuf, String> {
    let path = existing(path, field, dir)?;
    if !path.starts_with(root) {
        return Err(format!("{field} must resolve inside root"));
    }
    Ok(path)
}

fn existing(path: &Path, field: &str, dir: bool) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err(format!("{field} must be absolute: {}", path.display()));
    }
    let path = path
        .canonicalize()
        .map_err(|e| format!("{field} {}: {e}", path.display()))?;
    let metadata = path
        .metadata()
        .map_err(|e| format!("{field} {}: {e}", path.display()))?;
    if if dir {
        !metadata.is_dir()
    } else {
        !metadata.is_file()
    } {
        return Err(format!(
            "{field} must be a {}: {}",
            if dir { "directory" } else { "regular file" },
            path.display()
        ));
    }
    Ok(path)
}

fn output_path(path: &Path, root: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| part == std::path::Component::ParentDir)
    {
        return Err("out_dir must be absolute and must not contain `..`".into());
    }
    let mut nearest = path;
    loop {
        match nearest.symlink_metadata() {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                nearest = nearest.parent().ok_or("out_dir has no existing parent")?;
            }
            _ => break,
        }
    }
    let base = input_inside(nearest, root, "out_dir", true)?;
    Ok(base.join(path.strip_prefix(nearest).expect("ancestor of out_dir")))
}

pub(super) fn reject_live(path: &Path, live: &Path) -> Result<(), String> {
    let same = match live.canonicalize() {
        Ok(live) => path == live || same_file(path, &live)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(e) => return Err(format!("checking the live context.db path: {e}")),
    };
    if same {
        return Err("the lab cannot read the live context.db; use a frozen copy".into());
    }
    Ok(())
}

#[cfg(unix)]
fn same_file(path: &Path, live: &Path) -> Result<bool, String> {
    use std::os::unix::fs::MetadataExt;
    let a = path
        .metadata()
        .map_err(|e| format!("checking {}: {e}", path.display()))?;
    let b = live
        .metadata()
        .map_err(|e| format!("checking live context.db: {e}"))?;
    Ok(a.dev() == b.dev() && a.ino() == b.ino())
}

#[cfg(not(unix))]
fn same_file(_path: &Path, _live: &Path) -> Result<bool, String> {
    Ok(false)
}
