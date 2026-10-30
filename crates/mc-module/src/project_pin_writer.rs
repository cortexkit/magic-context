//! One non-blocking writer for registered pins and obsolete worktree-record cleanup.

use super::{sidecar_path, IdentityRecord};
use mc_store::private_permissions::write_file_atomic;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

const CAPACITY: usize = 256;
const SHUTDOWN_BOUND: Duration = Duration::from_millis(250);
type WriteFile = dyn Fn(&Path, &[u8], bool) -> std::io::Result<()> + Send + Sync;

#[derive(Clone)]
struct Pin {
    record: IdentityRecord,
    private: bool,
    revision: u64,
    persisted: bool,
    remove_if_unchanged: Option<Vec<u8>>,
}

#[derive(Default)]
struct State {
    // This is the process's identity cache, not a work queue. Failed and overflowed
    // pins stay visible and are retried when their folder is next bound. Keeping
    // completed pins also prevents a concurrent late answer replacing the first pin.
    pins: HashMap<PathBuf, Pin>,
    queued: HashMap<PathBuf, Pin>,
    active: Option<(PathBuf, u64)>,
    revision: u64,
    closing: bool,
    saturated: bool,
}

#[derive(Default)]
struct Shared {
    state: Mutex<State>,
    changed: Condvar,
}

pub(crate) struct PinWriter {
    shared: Arc<Shared>,
}

static PROCESS_WRITER: OnceLock<Arc<PinWriter>> = OnceLock::new();

pub(super) fn process_writer() -> Arc<PinWriter> {
    PROCESS_WRITER
        .get_or_init(|| PinWriter::new(Arc::new(write_file_atomic)))
        .clone()
}

/// Stop accepting work, drain for at most 250 ms, then leave any stalled fsync to
/// process teardown. An interrupted write has the same atomicity as a crash.
pub fn shutdown() -> bool {
    PROCESS_WRITER
        .get()
        .is_none_or(|writer| writer.shutdown(SHUTDOWN_BOUND))
}

impl PinWriter {
    pub(crate) fn new(write: Arc<WriteFile>) -> Arc<Self> {
        let shared = Arc::new(Shared::default());
        let worker = shared.clone();
        std::thread::Builder::new()
            .name("mc-project-pins".into())
            .spawn(move || Self::run(worker, write))
            .expect("start project pin writer");
        Arc::new(Self { shared })
    }

    fn schedule(state: &mut State, path: &Path, pin: Pin) {
        if pin.persisted
            || state.closing
            || state.active.as_ref() == Some(&(path.to_path_buf(), pin.revision))
        {
            return;
        }
        if state.queued.contains_key(path) || state.queued.len() < CAPACITY {
            state.queued.insert(path.to_path_buf(), pin);
        } else if !state.saturated {
            state.saturated = true;
            tracing::warn!(
                "Project pin writer saturated; retaining pins in memory until a later bind"
            );
        }
    }

    pub(super) fn lookup(&self, path: &Path) -> Option<IdentityRecord> {
        let mut state = self.shared.state.lock().unwrap();
        let pin = state.pins.get(path)?.clone();
        Self::schedule(&mut state, path, pin.clone());
        self.shared.changed.notify_all();
        Some(pin.record)
    }

    pub(super) fn records(&self, sidecars: &Path) -> HashMap<String, IdentityRecord> {
        self.shared
            .state
            .lock()
            .unwrap()
            .pins
            .iter()
            .filter(|(path, _)| path.parent() == Some(sidecars))
            .map(|(_, pin)| (pin.record.directory.clone(), pin.record.clone()))
            .collect()
    }

    pub(super) fn generation(&self) -> u64 {
        self.shared.state.lock().unwrap().revision
    }

    pub(super) fn publish(&self, sidecars: &Path, record: IdentityRecord, private: bool) {
        let path = sidecar_path(sidecars, Path::new(&record.directory));
        let mut state = self.shared.state.lock().unwrap();
        // Two concurrent accepted answers must not replace the first process pin.
        if let Some(pin) = state.pins.get(&path).cloned() {
            Self::schedule(&mut state, &path, pin);
        } else {
            Self::enqueue_latest(&mut state, path, record, private);
        }
        self.shared.changed.notify_all();
    }

    pub(super) fn remove_if_unchanged(&self, path: PathBuf, bytes: Vec<u8>) {
        let mut state = self.shared.state.lock().unwrap();
        if state.pins.contains_key(&path) {
            return;
        }
        let Ok(record) = serde_json::from_slice(&bytes) else {
            return;
        };
        state.revision += 1;
        let pin = Pin {
            record,
            private: false,
            revision: state.revision,
            persisted: false,
            remove_if_unchanged: Some(bytes),
        };
        Self::schedule(&mut state, &path, pin);
        self.shared.changed.notify_all();
    }

    fn enqueue_latest(state: &mut State, path: PathBuf, record: IdentityRecord, private: bool) {
        state.revision += 1;
        let pin = Pin {
            record,
            private,
            revision: state.revision,
            persisted: false,
            remove_if_unchanged: None,
        };
        state.pins.insert(path.clone(), pin.clone());
        Self::schedule(state, &path, pin);
    }

    fn run(shared: Arc<Shared>, write: Arc<WriteFile>) {
        loop {
            let (path, pin) = {
                let mut state = shared.state.lock().unwrap();
                while state.queued.is_empty() && !state.closing {
                    state = shared.changed.wait(state).unwrap();
                }
                let Some(path) = state.queued.keys().next().cloned() else {
                    return;
                };
                let pin = state.queued.remove(&path).unwrap();
                state.active = Some((path.clone(), pin.revision));
                state.saturated = false;
                (path, pin)
            };
            // Serialization and all filesystem work happen without holding the
            // overlay lock: neither a slow disk nor fsync can stall a bind.
            let result = if let Some(expected) = &pin.remove_if_unchanged {
                match std::fs::read(&path) {
                    Ok(bytes) if bytes == *expected => std::fs::remove_file(&path).inspect(|()| {
                        tracing::info!(path = %path.display(), "Removed stale git worktree identity; borrowing checkout project pin");
                    }),
                    Ok(_) => Ok(()),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                    Err(error) => Err(error),
                }
            } else {
                serde_json::to_vec(&pin.record)
                    .map_err(std::io::Error::other)
                    .and_then(|bytes| write(&path, &bytes, pin.private))
            };
            let mut state = shared.state.lock().unwrap();
            state.active = None;
            if result.is_ok() {
                if let Some(current) = state.pins.get_mut(&path) {
                    if current.revision == pin.revision {
                        current.persisted = true;
                    }
                }
            } else {
                tracing::warn!(path = %path.display(), error = ?result.err(), "Project pin persistence failed; retaining process pin");
            }
            shared.changed.notify_all();
        }
    }

    pub(crate) fn flush(&self, bound: Duration) -> bool {
        let deadline = Instant::now() + bound;
        let mut state = self.shared.state.lock().unwrap();
        while !state.queued.is_empty() || state.active.is_some() {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                return false;
            };
            state = self
                .shared
                .changed
                .wait_timeout(state, remaining)
                .unwrap()
                .0;
        }
        true
    }

    pub(crate) fn shutdown(&self, bound: Duration) -> bool {
        self.shared.state.lock().unwrap().closing = true;
        self.shared.changed.notify_all();
        let drained = self.flush(bound);
        if !drained {
            self.shared.state.lock().unwrap().queued.clear();
            tracing::warn!("Project pin shutdown deadline exceeded; unpersisted pins will resolve again on restart");
        }
        drained
    }
}

impl Drop for PinWriter {
    fn drop(&mut self) {
        // Tests can own isolated writers. Never leave their queues running after
        // their temporary directories have been removed.
        self.shutdown(Duration::ZERO);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entorhinal_resolve::{resolve_with_attempt, ResolveAnswer};
    use crate::project_identity::{read_record, ProjectIdentityResolver};
    use std::sync::mpsc;

    fn temp() -> tempfile::TempDir {
        let base = std::env::temp_dir().join("magic-context/pj-pin-async");
        std::fs::create_dir_all(&base).unwrap();
        tempfile::tempdir_in(base).unwrap()
    }

    struct Gate {
        open: Arc<(Mutex<bool>, Condvar)>,
        entered: mpsc::Receiver<()>,
    }

    impl Gate {
        fn release(&self) {
            *self.open.0.lock().unwrap() = true;
            self.open.1.notify_all();
        }

        fn wait_for_write(&self) {
            self.entered.recv_timeout(Duration::from_secs(5)).unwrap();
        }
    }

    impl Drop for Gate {
        fn drop(&mut self) {
            self.release();
        }
    }

    fn blocked_writer() -> (Arc<PinWriter>, Gate) {
        let open = Arc::new((Mutex::new(false), Condvar::new()));
        let wait = open.clone();
        let (send, entered) = mpsc::channel();
        let writer = PinWriter::new(Arc::new(move |path, bytes, private| {
            send.send(()).unwrap();
            let mut released = wait.0.lock().unwrap();
            while !*released {
                released = wait.1.wait(released).unwrap();
            }
            write_file_atomic(path, bytes, private)
        }));
        (writer, Gate { open, entered })
    }

    fn record(directory: &Path, identity: &str) -> IdentityRecord {
        IdentityRecord {
            directory: super::super::project_directory_key(directory),
            identity: identity.into(),
            git_common_dir: None,
        }
    }

    #[test]
    fn worktree_cleanup_preserves_a_changed_sidecar_and_does_not_publish_a_pin() {
        let temp = temp();
        let sidecars = temp.path().join("sidecars");
        let directory = temp.path().join("worktree");
        let path = sidecar_path(&sidecars, &directory);
        let bytes = serde_json::to_vec(&record(&directory, "git:abcdef123")).unwrap();
        write_file_atomic(&path, &bytes, false).unwrap();
        let (writer, gate) = blocked_writer();
        writer.publish(
            &sidecars,
            record(&temp.path().join("other"), "pj-OTHER"),
            false,
        );
        gate.wait_for_write();
        writer.remove_if_unchanged(path.clone(), bytes.clone());
        write_file_atomic(
            &path,
            &serde_json::to_vec(&record(&directory, "pj-NEW")).unwrap(),
            false,
        )
        .unwrap();
        gate.release();
        assert!(writer.flush(Duration::from_secs(5)));
        assert_eq!(
            read_record(&sidecars, &directory).unwrap().identity,
            "pj-NEW"
        );
        assert!(writer.lookup(&path).is_none());
        write_file_atomic(&path, &bytes, false).unwrap();
        writer.remove_if_unchanged(path.clone(), bytes);
        assert!(writer.flush(Duration::from_secs(5)));
        assert!(!path.exists());
    }

    async fn bind(resolver: &ProjectIdentityResolver, folder: &Path, identity: &str) -> String {
        resolve_with_attempt(resolver, folder, async {
            ResolveAnswer::Registered {
                project_id: identity.into(),
                canonical_root: Some(folder.to_path_buf()),
            }
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn pending_pin_is_visible_to_another_bind_and_resolver_over_stale_sidecar() {
        let temp = temp();
        let sidecars = temp.path().join("sidecars");
        let (writer, gate) = blocked_writer();
        let first = ProjectIdentityResolver::with_pin_writer(sidecars.clone(), writer.clone());
        let second = ProjectIdentityResolver::with_pin_writer(sidecars.clone(), writer.clone());
        let folder = temp.path().join("folder");
        std::fs::create_dir(&folder).unwrap();
        write_file_atomic(
            &sidecar_path(&sidecars, &folder),
            &serde_json::to_vec(&record(&folder, "git:123456789abcdef")).unwrap(),
            true,
        )
        .unwrap();
        assert!(second.resolve(&folder).unwrap().starts_with("git:"));
        assert_eq!(bind(&first, &folder, "pj-first").await, "pj-first");
        gate.wait_for_write();
        assert_eq!(
            read_record(&sidecars, &folder).unwrap().identity,
            "git:123456789abcdef"
        );
        assert_eq!(bind(&second, &folder, "pj-other").await, "pj-first");
        assert_eq!(second.resolve(&folder).unwrap(), "pj-first");
        super::super::remember_git_identity(&writer, &sidecars, &folder, "git:abcdef123456789");
        assert_eq!(
            read_record(&sidecars, &folder).unwrap().identity,
            "git:123456789abcdef"
        );
        gate.release();
        assert!(writer.shutdown(Duration::from_secs(5)));
        assert_eq!(
            read_record(&sidecars, &folder).unwrap().identity,
            "pj-first"
        );
    }

    #[test]
    fn pending_common_directory_pins_override_stale_records_and_detect_conflicts() {
        let temp = temp();
        let sidecars = temp.path().join("sidecars");
        let folder = temp.path().join("repo");
        let child = folder.join("sub");
        std::fs::create_dir_all(folder.join(".git")).unwrap();
        std::fs::create_dir(&child).unwrap();
        let (writer, gate) = blocked_writer();
        let resolver = ProjectIdentityResolver::with_pin_writer(sidecars.clone(), writer.clone());
        resolver.pin_live_answer(&folder, "pj-root", Some(&folder));
        gate.wait_for_write();
        assert_eq!(resolver.common_dir_pin(&child).as_deref(), Some("pj-root"));
        resolver.pin_live_answer(&child, "pj-nested", Some(&child));
        assert!(resolver.common_dir_pin(&child).is_none());
        gate.release();
        assert!(writer.shutdown(Duration::from_secs(5)));
    }

    #[test]
    fn publishing_a_pin_invalidates_a_cached_worktree_miss_before_persistence() {
        let temp = temp();
        let sidecars = temp.path().join("sidecars");
        let main = temp.path().join("repo");
        let worktree = temp.path().join("worktree");
        let gitdir = main.join(".git/worktrees/linked");
        std::fs::create_dir_all(&gitdir).unwrap();
        std::fs::create_dir(&worktree).unwrap();
        std::fs::write(
            worktree.join(".git"),
            format!("gitdir: {}\n", gitdir.display()),
        )
        .unwrap();
        std::fs::write(gitdir.join("commondir"), "../..\n").unwrap();
        let (writer, gate) = blocked_writer();
        let resolver = ProjectIdentityResolver::with_pin_writer(sidecars.clone(), writer.clone());
        assert!(resolver.common_dir_pin(&worktree).is_none());
        resolver.pin_live_answer(&main, "pj-PENDING", Some(&main));
        gate.wait_for_write();
        assert!(!sidecar_path(&sidecars, &main).exists());
        assert_eq!(
            resolver.common_dir_pin(&worktree).as_deref(),
            Some("pj-PENDING")
        );
        gate.release();
        assert!(writer.shutdown(Duration::from_secs(5)));
    }

    #[test]
    fn writer_coalesces_latest_snapshot_even_while_older_write_is_active() {
        let temp = temp();
        let sidecars = temp.path().join("sidecars");
        let folder = temp.path().join("folder");
        let path = sidecar_path(&sidecars, &folder);
        let (writer, gate) = blocked_writer();
        writer.publish(&sidecars, record(&folder, "pj-first"), true);
        gate.wait_for_write();
        // The persistence lane coalesces revisions; identity authorization above
        // this lane still preserves an already accepted authoritative pin.
        {
            let mut state = writer.shared.state.lock().unwrap();
            PinWriter::enqueue_latest(&mut state, path.clone(), record(&folder, "pj-second"), true);
            PinWriter::enqueue_latest(&mut state, path.clone(), record(&folder, "pj-latest"), true);
            assert_eq!(state.queued.len(), 1);
        }
        assert_eq!(writer.lookup(&path).unwrap().identity, "pj-latest");
        gate.release();
        assert!(writer.shutdown(Duration::from_secs(5)));
        assert_eq!(
            read_record(&sidecars, &folder).unwrap().identity,
            "pj-latest"
        );
        assert_eq!(
            gate.entered.try_iter().count(),
            1,
            "only the latest queued revision is written"
        );
    }

    #[test]
    fn late_publication_cannot_replace_a_completed_process_pin() {
        let temp = temp();
        let sidecars = temp.path().join("sidecars");
        let folder = temp.path().join("folder");
        let writer = PinWriter::new(Arc::new(write_file_atomic));
        writer.publish(&sidecars, record(&folder, "pj-first"), true);
        assert!(writer.flush(Duration::from_secs(5)));
        writer.publish(&sidecars, record(&folder, "pj-late"), true);
        assert!(writer.shutdown(Duration::from_secs(5)));
        assert_eq!(
            read_record(&sidecars, &folder).unwrap().identity,
            "pj-first"
        );
    }

    #[test]
    fn shutdown_flushes_pending_atomic_files() {
        let temp = temp();
        let sidecars = temp.path().join("sidecars");
        let writer = PinWriter::new(Arc::new(write_file_atomic));
        for i in 0..5 {
            writer.publish(
                &sidecars,
                record(&temp.path().join(i.to_string()), "pj-flushed"),
                true,
            );
        }
        assert!(writer.shutdown(Duration::from_secs(2)));
        for i in 0..5 {
            assert_eq!(
                read_record(&sidecars, &temp.path().join(i.to_string()))
                    .unwrap()
                    .identity,
                "pj-flushed"
            );
        }
        assert_eq!(std::fs::read_dir(&sidecars).unwrap().count(), 5);
    }

    #[test]
    fn shutdown_has_a_short_bound_even_if_write_is_stuck() {
        let temp = temp();
        let (writer, gate) = blocked_writer();
        writer.publish(
            temp.path(),
            record(&temp.path().join("folder"), "pj-stuck"),
            true,
        );
        gate.wait_for_write();
        let started = Instant::now();
        assert!(!writer.shutdown(Duration::from_millis(25)));
        assert!(started.elapsed() < Duration::from_millis(250));
        gate.release();
        assert!(writer.flush(Duration::from_secs(5)));
    }

    #[tokio::test]
    async fn saturated_writer_keeps_binds_fast_and_retries_overflow_on_next_bind() {
        let temp = temp();
        let sidecars = temp.path().join("sidecars");
        let (writer, gate) = blocked_writer();
        writer.publish(
            &sidecars,
            record(&temp.path().join("active"), "pj-active"),
            true,
        );
        gate.wait_for_write();
        for i in 0..CAPACITY {
            writer.publish(
                &sidecars,
                record(&temp.path().join(i.to_string()), "pj-queued"),
                true,
            );
        }
        let folder = temp.path().join("overflow");
        std::fs::create_dir(&folder).unwrap();
        let resolver = ProjectIdentityResolver::with_pin_writer(sidecars.clone(), writer.clone());
        let started = Instant::now();
        assert_eq!(bind(&resolver, &folder, "pj-overflow").await, "pj-overflow");
        for _ in 0..50 {
            assert_eq!(bind(&resolver, &folder, "pj-other").await, "pj-overflow");
        }
        assert!(started.elapsed() < Duration::from_millis(500));
        {
            let state = writer.shared.state.lock().unwrap();
            assert_eq!(state.queued.len(), CAPACITY);
            assert!(state.saturated);
        }
        gate.release();
        assert!(writer.flush(Duration::from_secs(10)));
        assert!(read_record(&sidecars, &folder).is_none());
        assert_eq!(bind(&resolver, &folder, "pj-other").await, "pj-overflow");
        assert!(writer.shutdown(Duration::from_secs(5)));
        assert_eq!(
            read_record(&sidecars, &folder).unwrap().identity,
            "pj-overflow"
        );
        assert!(!writer.shared.state.lock().unwrap().saturated);
    }

    #[tokio::test]
    async fn failed_write_keeps_process_pin_and_next_bind_retries() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let temp = temp();
        let sidecars = temp.path().join("sidecars");
        let attempts = Arc::new(AtomicUsize::new(0));
        let observed = attempts.clone();
        let writer = PinWriter::new(Arc::new(move |path, bytes, private| {
            if observed.fetch_add(1, Ordering::SeqCst) == 0 {
                return Err(std::io::Error::other("injected write failure"));
            }
            write_file_atomic(path, bytes, private)
        }));
        let resolver = ProjectIdentityResolver::with_pin_writer(sidecars.clone(), writer.clone());
        assert_eq!(bind(&resolver, temp.path(), "pj-kept").await, "pj-kept");
        assert!(writer.flush(Duration::from_secs(5)));
        assert!(!sidecars.exists());
        assert_eq!(bind(&resolver, temp.path(), "pj-other").await, "pj-kept");
        assert!(writer.shutdown(Duration::from_secs(5)));
        assert_eq!(
            read_record(&sidecars, temp.path()).unwrap().identity,
            "pj-kept"
        );
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn crash_before_write_restart_resolves_again_without_losing_other_files() {
        let temp = temp();
        std::fs::write(temp.path().join("session-data"), b"unchanged").unwrap();
        let run = |mode: &str| {
            std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "project_identity::pin_writer::tests::crash_restart_child",
                    "--ignored",
                    "--nocapture",
                ])
                .env("MC_PIN_CRASH_ROOT", temp.path())
                .env("MC_PIN_CRASH_MODE", mode)
                .output()
                .unwrap()
        };
        let crashed = run("crash");
        assert_eq!(
            crashed.status.code(),
            Some(73),
            "{}",
            String::from_utf8_lossy(&crashed.stderr)
        );
        assert!(!temp.path().join("sidecars").exists());
        let restarted = run("restart");
        assert!(
            restarted.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&restarted.stdout),
            String::from_utf8_lossy(&restarted.stderr)
        );
        assert_eq!(
            std::fs::read(temp.path().join("session-data")).unwrap(),
            b"unchanged"
        );
    }

    #[tokio::test]
    #[ignore = "subprocess of crash_before_write_restart_resolves_again_without_losing_other_files"]
    async fn crash_restart_child() {
        let root = PathBuf::from(std::env::var_os("MC_PIN_CRASH_ROOT").unwrap());
        let sidecars = root.join("sidecars");
        if std::env::var("MC_PIN_CRASH_MODE").unwrap() == "crash" {
            let (writer, gate) = blocked_writer();
            let resolver = ProjectIdentityResolver::with_pin_writer(sidecars, writer);
            assert_eq!(
                bind(&resolver, &root, "pj-before-crash").await,
                "pj-before-crash"
            );
            gate.wait_for_write();
            assert_eq!(resolver.resolve(&root).unwrap(), "pj-before-crash");
            // Bypass destructors, as an abrupt process death does. The worker has
            // entered persistence but cannot create or rename a sidecar yet.
            std::process::exit(73);
        }
        let resolver = ProjectIdentityResolver::with_sidecar_dir(sidecars.clone());
        assert!(resolver.pinned_identity(&root).is_none());
        let unavailable =
            resolve_with_attempt(&resolver, &root, async { ResolveAnswer::NotAnswering })
                .await
                .unwrap();
        assert!(unavailable.starts_with("dir:"));
        assert_eq!(
            bind(&resolver, &root, "pj-after-restart").await,
            "pj-after-restart"
        );
        resolver.flush_pins();
        assert_eq!(
            read_record(&sidecars, &root).unwrap().identity,
            "pj-after-restart"
        );
    }
}
