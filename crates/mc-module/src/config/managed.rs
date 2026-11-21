//! ck-mc's user settings on the daemon's managed settings (subc's config
//! gate), behind the `managed-settings` build switch.
//!
//! The daemon owns the user file once ck-mc declares it: it reviews each
//! change with ck-mc ([`super::review`]) and delivers the approved,
//! effective settings as a view. ck-mc never reads the user file directly
//! then, except through `config_files` when the daemon is too old to have a
//! config gate. The per-project file is still read from disk, with its own
//! trust rules.
//!
//! The user tier comes from, in order:
//! 1. the view the daemon delivered this run;
//! 2. before that, the last view a run applied, saved in ck-mc's data folder.
//!    It was approved, and it is what the previous run served: settings such
//!    as the memory budget and the thresholds shape the history head ck-mc
//!    renders at the start of every session's request, so serving different
//!    ones after a restart would change those bytes and cost each session a
//!    full prompt-cache rewrite;
//! 3. on the first run, with no saved view, nothing: settings resolution
//!    waits up to [`FIRST_STATE_WAIT`] for the daemon's first answer, then
//!    serves its view, the defaults when it refused the settings and none
//!    were ever approved, or the user file when it has no config gate.
//!
//! Before ck-mc connects, [`rewrite_0_49`] converts a 0.49-shaped user file
//! once ([`super::convert::convert_0_49`]), keeping its comments and saving
//! the old bytes in the data folder.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use subc_client_rs::config::{
    ConfigAvailability, ConfigDeclareRequest, ConfigReviewReply, ConfigReviewRequest, ConfigState,
    ConfigView, Layer,
};

use super::{Loader, SettingsSource, UserTier};

/// How long the first run's settings resolution waits for the daemon's
/// first answer before it serves the defaults.
pub const FIRST_STATE_WAIT: Duration = Duration::from_secs(5);

/// The file in ck-mc's data folder that holds the last applied view.
pub const VIEW_FILE: &str = "settings-view.json";

/// The folder in ck-mc's data folder that keeps a user file's bytes from
/// before its conversion.
pub const BACKUP_FOLDER: &str = "settings-0.49";

/// Where the user tier comes from now.
enum State {
    /// The first run's start: no view yet, nothing saved, no answer from
    /// the daemon. `since` is when a resolution first waited for one.
    Waiting { since: Option<Instant> },
    /// An approved view. `delivered` when this run's daemon delivered it;
    /// otherwise it is the one a previous run saved.
    View {
        tier: UserTier,
        generation: u64,
        delivered: bool,
    },
    /// The defaults, and why.
    Defaults { why: &'static str },
    /// The user file: the daemon has no config gate.
    Files,
}

impl State {
    fn source(&self) -> SettingsSource {
        match self {
            Self::Waiting { .. } => SettingsSource::Waiting,
            Self::View {
                delivered: true, ..
            } => SettingsSource::View,
            Self::View {
                delivered: false, ..
            } => SettingsSource::SavedView,
            Self::Defaults { .. } => SettingsSource::Defaults,
            Self::Files => SettingsSource::File,
        }
    }
}

/// The user tier's source under managed settings.
pub struct Managed {
    state: Mutex<State>,
    // Health probes cannot wait for settings resolution or view delivery.
    source: AtomicU8,
    changed: Condvar,
    /// Where an applied view is saved.
    view_path: PathBuf,
    /// Whether a resolution may wait for the daemon: never for a command
    /// that runs without one.
    wait: bool,
    logged: AtomicBool,
}

impl Managed {
    fn new(view_path: PathBuf, wait: bool) -> Self {
        let state = match load_view(&view_path) {
            Ok(Some((tier, generation))) => State::View {
                tier,
                generation,
                delivered: false,
            },
            Ok(None) => State::Waiting { since: None },
            Err(why) => {
                tracing::warn!(
                    "ck-mc: the saved settings view {} can't be read ({why}); waiting for the daemon's",
                    view_path.display()
                );
                State::Waiting { since: None }
            }
        };
        Self {
            source: AtomicU8::new(state.source() as u8),
            state: Mutex::new(state),
            changed: Condvar::new(),
            view_path,
            wait,
            logged: AtomicBool::new(false),
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn set_state(&self, current: &mut State, next: State) {
        *current = next;
        self.source.store(current.source() as u8, Ordering::Relaxed);
        self.changed.notify_all();
    }

    fn source(&self) -> SettingsSource {
        match self.source.load(Ordering::Relaxed) {
            value if value == SettingsSource::Waiting as u8 => SettingsSource::Waiting,
            value if value == SettingsSource::View as u8 => SettingsSource::View,
            value if value == SettingsSource::SavedView as u8 => SettingsSource::SavedView,
            value if value == SettingsSource::Defaults as u8 => SettingsSource::Defaults,
            value if value == SettingsSource::File as u8 => SettingsSource::File,
            _ => unreachable!("only a managed settings state can publish its source"),
        }
    }

    /// The user tier for a resolution, waiting first if this is the first
    /// run and the daemon has not answered yet. `read_file` reads the user
    /// file, only for a daemon without a config gate.
    pub(super) fn user_tier(
        &self,
        read_file: impl FnOnce() -> Option<UserTier>,
    ) -> Option<UserTier> {
        let mut state = self.lock();
        loop {
            let deadline = match &mut *state {
                State::Waiting { since } if self.wait => {
                    *since.get_or_insert_with(Instant::now) + FIRST_STATE_WAIT
                }
                _ => break,
            };
            let now = Instant::now();
            if now >= deadline {
                self.set_state(
                    &mut state,
                    State::Defaults {
                        why: "the daemon gave no answer within 5 s",
                    },
                );
                break;
            }
            state = blocking(|| {
                self.changed
                    .wait_timeout(state, deadline - now)
                    .unwrap_or_else(PoisonError::into_inner)
                    .0
            });
        }
        if matches!(*state, State::Files) {
            drop(state);
            self.log_first("the user file: the daemon has no config gate");
            return read_file();
        }
        let (tier, from) = match &*state {
            State::View {
                tier,
                generation,
                delivered: true,
            } => (
                Some(tier.clone()),
                format!("the view the daemon delivered (generation {generation})"),
            ),
            State::View {
                tier, generation, ..
            } => (
                Some(tier.clone()),
                format!("the view a previous run applied (generation {generation}), until the daemon delivers this run's"),
            ),
            State::Defaults { why } => (None, format!("the defaults: {why}")),
            State::Waiting { .. } | State::Files => (
                None,
                "the defaults: no view is saved, and this command runs without the daemon".to_owned(),
            ),
        };
        drop(state);
        self.log_first(&from);
        tier
    }

    /// Say, once, where the first resolution's user tier came from.
    fn log_first(&self, from: &str) {
        if !self.logged.swap(true, Ordering::Relaxed) {
            tracing::info!("ck-mc: the first settings resolution used {from}");
        }
    }

    /// The user tier as it stands, without waiting.
    pub(super) fn user_tier_now(
        &self,
        read_file: impl FnOnce() -> Option<UserTier>,
    ) -> Option<UserTier> {
        let state = self.lock();
        if matches!(*state, State::Files) {
            drop(state);
            return read_file();
        }
        match &*state {
            State::View { tier, .. } => Some(tier.clone()),
            State::Waiting { .. } | State::Defaults { .. } | State::Files => None,
        }
    }

    /// Take `view` as the user tier, saving it first so the next run starts
    /// from it. When it can't be saved, nothing changes and the reason is
    /// the daemon's to hear.
    fn apply(&self, view: &ConfigView) -> Result<UserTier, Vec<String>> {
        let tier = UserTier::from_view(&view.effective, &view.sources);
        let record = json!({
            "format": 1,
            "generation": view.generation,
            "effective": view.effective,
            "sources": view.sources,
        });
        let bytes = serde_json::to_vec_pretty(&record).map_err(|error| vec![error.to_string()])?;
        write_atomically(&self.view_path, &bytes, None).map_err(|error| {
            vec![format!(
                "ck-mc could not save the settings view to {}: {error}",
                self.view_path.display()
            )]
        })?;
        self.set_state(
            &mut self.lock(),
            State::View {
                tier: tier.clone(),
                generation: view.generation,
                delivered: true,
            },
        );
        Ok(tier)
    }

    /// The daemon has no config gate: read the user file.
    fn use_files(&self) {
        self.set_state(&mut self.lock(), State::Files);
    }

    /// A refusal that leaves no approved view ends the first run's wait with
    /// the defaults. A saved view stays in force: it was approved.
    fn state_arrived(&self, state: &ConfigState) {
        let refused = matches!(
            state,
            ConfigState::Failed {
                view: ConfigAvailability::NoApprovedConfig,
                ..
            } | ConfigState::ConfigGated {
                view: ConfigAvailability::NoApprovedConfig,
                ..
            } | ConfigState::NotDeliveryTarget {
                view: ConfigAvailability::NoApprovedConfig,
                ..
            } | ConfigState::AnchorPending {
                view: ConfigAvailability::NoApprovedConfig,
                ..
            }
        );
        let mut current = self.lock();
        if refused && matches!(*current, State::Waiting { .. }) {
            self.set_state(
                &mut current,
                State::Defaults {
                    why: "the daemon refused the settings and none were approved",
                },
            );
        }
    }
}

/// Run `wait` without holding up the other tasks of a multi-threaded tokio
/// runtime, so the task that delivers the daemon's answer keeps running.
fn blocking<R>(wait: impl FnOnce() -> R) -> R {
    match tokio::runtime::Handle::try_current() {
        Ok(handle) if handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread => {
            tokio::task::block_in_place(wait)
        }
        _ => wait(),
    }
}

/// The view a previous run saved, when there is one.
fn load_view(path: &Path) -> Result<Option<(UserTier, u64)>, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let record: Value = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    if record["format"] != 1 || !record["effective"].is_object() {
        return Err("not a saved view".into());
    }
    let sources: std::collections::BTreeMap<String, Layer> =
        serde_json::from_value(record["sources"].clone()).map_err(|error| error.to_string())?;
    let generation = record["generation"].as_u64().ok_or("no generation")?;
    Ok(Some((
        UserTier::from_view(&record["effective"], &sources),
        generation,
    )))
}

/// Write `bytes` to `path` through a temporary file beside it and a rename,
/// so a reader sees the old file or the new one, never part of one.
fn write_atomically(
    path: &Path,
    bytes: &[u8],
    permissions: Option<fs::Permissions>,
) -> std::io::Result<()> {
    let folder = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(folder)?;
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let temporary = folder.join(format!(".{name}.{}.tmp", std::process::id()));
    let written = (|| {
        let mut file = fs::File::create(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        if let Some(permissions) = permissions {
            fs::set_permissions(&temporary, permissions)?;
        }
        fs::rename(&temporary, path)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    written
}

/// What [`rewrite_0_49`] did.
#[derive(Debug, PartialEq, Eq)]
pub enum Rewrite {
    /// No user file.
    Missing,
    /// Nothing to convert; the file is untouched.
    Unchanged,
    /// The file was left as it is, for this reason (already logged).
    Refused(String),
    /// The file was rewritten; the old bytes are at this path.
    Rewritten(PathBuf),
}

/// Convert a 0.49-shaped user file once, before ck-mc connects: apply the
/// conversion's edits to its text, keeping its comments, after saving the
/// old bytes in `data_dir`. A file with nothing to convert is left
/// untouched, so this runs once in effect. A file the JSONC reader finds an
/// issue in is never rewritten; the issue is logged so the person can fix
/// it.
pub fn rewrite_0_49(user_path: &Path, data_dir: &Path) -> Rewrite {
    let rewrite = rewrite_file(user_path, data_dir);
    match &rewrite {
        Rewrite::Rewritten(saved) => tracing::info!(
            "ck-mc: rewrote {} in the shape of the daemon's managed settings; the file as it was is saved at {}",
            user_path.display(),
            saved.display()
        ),
        Rewrite::Refused(why) => tracing::warn!(
            "ck-mc: {} was not converted to the managed settings' shape: {why}",
            user_path.display()
        ),
        Rewrite::Missing | Rewrite::Unchanged => {}
    }
    rewrite
}

fn rewrite_file(user_path: &Path, data_dir: &Path) -> Rewrite {
    // A user file that is a link (a dotfiles checkout) is rewritten where
    // it points, so the link stays a link.
    let target = match fs::canonicalize(user_path) {
        Ok(target) => target,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Rewrite::Missing,
        Err(error) => return Rewrite::Refused(format!("it can't be resolved ({error})")),
    };
    let bytes = match fs::read(&target) {
        Ok(bytes) => bytes,
        Err(error) => return Rewrite::Refused(format!("it can't be read ({error})")),
    };
    let Ok(text) = String::from_utf8(bytes.clone()) else {
        return Rewrite::Refused("it is not UTF-8 text".into());
    };
    let parsed = super::jsonc::parse(&text);
    if let Some(issue) = parsed.issue {
        return Rewrite::Refused(format!(
            "the file has a syntax issue at {issue}; fix it and ck-mc converts it on its next start"
        ));
    }
    let (edits, notes) = super::convert::convert_0_49(&parsed.value);
    for note in &notes {
        tracing::info!("ck-mc: {}: {note}", user_path.display());
    }
    if edits.is_empty() {
        return Rewrite::Unchanged;
    }
    let converted = match super::edit::apply(&text, &edits) {
        Ok(converted) => converted,
        Err(why) => return Rewrite::Refused(why),
    };
    let name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "magic-context.jsonc".into());
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs());
    let saved = data_dir
        .join(BACKUP_FOLDER)
        .join(format!("{name}.{seconds}.{}", std::process::id()));
    if let Err(error) = write_atomically(&saved, &bytes, None) {
        return Rewrite::Refused(format!(
            "the old file could not be saved at {} ({error})",
            saved.display()
        ));
    }
    let permissions = fs::metadata(&target).ok().map(|meta| meta.permissions());
    match write_atomically(&target, converted.as_bytes(), permissions) {
        Ok(()) => Rewrite::Rewritten(saved),
        Err(error) => Rewrite::Refused(format!("it could not be written ({error})")),
    }
}

impl Loader {
    pub(super) fn settings_source(&self) -> SettingsSource {
        self.managed
            .as_ref()
            .map_or(SettingsSource::File, |managed| managed.source())
    }

    /// Take the user tier from the daemon's managed settings, saving each
    /// applied view in `data_dir`.
    pub fn managed(mut self, data_dir: &Path) -> Self {
        self.managed = Some(Arc::new(Managed::new(data_dir.join(VIEW_FILE), true)));
        self
    }

    /// [`Self::managed`] for a command that runs without the daemon: the
    /// saved view, or the defaults when none is saved. It never waits.
    pub fn managed_offline(mut self, data_dir: &Path) -> Self {
        self.managed = Some(Arc::new(Managed::new(data_dir.join(VIEW_FILE), false)));
        self
    }

    /// The schema and user file ck-mc declares; `None` when this loader
    /// reads files.
    pub fn config_declaration(&self) -> Option<ConfigDeclareRequest> {
        self.managed.as_ref()?;
        Some(ConfigDeclareRequest::new(
            super::review::schema_value().clone(),
            self.user_path.to_string_lossy(),
            vec![],
        ))
    }

    /// Review a proposal ([`super::review::review`]).
    pub fn config_review(&self, request: &ConfigReviewRequest) -> ConfigReviewReply {
        super::review::review(request, &self.user_path)
    }

    /// Take a delivered view as the user tier.
    pub fn config_apply(&self, view: &ConfigView) -> Result<(), Vec<String>> {
        let managed = self
            .managed
            .as_ref()
            .ok_or_else(|| vec!["ck-mc reads these settings from its files".to_owned()])?;
        let tier = managed.apply(view)?;
        super::register_vault_keys(&tier, &self.vault);
        Ok(())
    }

    /// The daemon has no config gate: read the user file as before.
    pub fn config_files(&self) {
        if let Some(managed) = &self.managed {
            managed.use_files();
        }
        if let Some(tier) = self.user_file_tier() {
            super::register_vault_keys(&tier, &self.vault);
        }
    }

    /// Log the daemon's word on the settings, and end a first run's wait
    /// on a refusal.
    pub fn on_config_state(&self, state: &ConfigState) {
        match state {
            ConfigState::Failed { reasons, .. } => {
                tracing::warn!("ck-mc: managed settings: failed: {}", reasons.join("; "))
            }
            ConfigState::ConfigGated { refusal, .. }
            | ConfigState::NotDeliveryTarget { refusal, .. }
            | ConfigState::AnchorPending { refusal, .. } => tracing::warn!(
                "ck-mc: managed settings: {}: {}: {}",
                state.as_str(),
                refusal.code,
                refusal.message
            ),
            _ => tracing::info!("ck-mc: managed settings: {}", state.as_str()),
        }
        if let Some(managed) = &self.managed {
            managed.state_arrived(state);
        }
    }
}

#[cfg(test)]
#[path = "managed_tests.rs"]
mod tests;
