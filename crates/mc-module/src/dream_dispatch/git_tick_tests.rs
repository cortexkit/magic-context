use super::*;
use crate::config_parity::{CoreConfig, ProtectedTokenTiers, TrustFlags};
use mc_store::parity_schema_manifest::Availability;
use rusqlite::Connection;
use serde_json::json;
use std::process::Command;
use std::sync::atomic::AtomicI64;
use std::sync::Condvar;

const PROJECT: &str = "git:tick-fixture";
const NOW: i64 = 1_900_000_000_000;
const COOLDOWN: i64 = 600_001;

struct TestClock(AtomicI64);
impl Clock for TestClock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

struct Resolver {
    enabled: AtomicBool,
    background: AtomicBool,
    gate: (Mutex<(bool, bool)>, Condvar),
}

impl CoreConfigResolver for Resolver {
    fn availability(&self) -> Availability {
        Availability::Available
    }
    fn resolve(&self, _: &ConfigResolveRequest) -> CapabilityResult<CoreConfig> {
        let (lock, cv) = &self.gate;
        let mut gate = lock.lock().unwrap();
        gate.1 = true;
        cv.notify_all();
        while gate.0 {
            gate = cv.wait(gate).unwrap();
        }
        CapabilityResult::Available {
            value: CoreConfig {
                effective: crate::McModuleConfig {
                    rust_background_enabled: self.background.load(Ordering::SeqCst),
                    ..Default::default()
                },
                settings: json!({"memory":{"git_commit_indexing":{
                    "enabled":self.enabled.load(Ordering::SeqCst),
                    "since_days":365,"max_commits":2
                }}}),
                generation: Generation(1),
                warnings: vec![],
                trust: TrustFlags::default(),
                protected_token_tiers: ProtectedTokenTiers::default(),
            },
        }
    }
}

struct Fixture {
    _dir: tempfile::TempDir,
    repo: PathBuf,
    handles: DreamHandles,
    resolver: Arc<Resolver>,
    clock: Arc<TestClock>,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-q"]);
        let path = dir.path().join("context.db");
        Connection::open(&path)
            .unwrap()
            .execute_batch(
                &include_str!("../../../mc-store/testdata/context_schema/schema.sql")
                    .replace(":applied_at", "1"),
            )
            .unwrap();
        let store = Arc::new(
            McStore::open(&crate::dev_descriptor_at(dir.path().to_str().unwrap())).unwrap(),
        );
        store.install_context_domain(Arc::new(
            mc_store::SqliteContextDomain::open(&path).unwrap(),
        ));
        let resolver = Arc::new(Resolver {
            enabled: AtomicBool::new(true),
            background: AtomicBool::new(true),
            gate: (Mutex::new((false, false)), Condvar::new()),
        });
        let clock = Arc::new(TestClock(AtomicI64::new(NOW)));
        let runs = Arc::new(DreamRuns::new(
            None,
            &RouteTargetConfig::default(),
            Arc::new(crate::child_scopes::ChildScopes::new("magic-context")),
        ));
        runs.use_resolver(resolver.clone());
        runs.use_clock(clock.clone());
        runs.record(
            PROJECT,
            DreamTarget {
                directory: repo.clone(),
                session: "session".into(),
                harness: "opencode".into(),
                seen_at_ms: NOW,
                session_runner: None,
            },
        );
        let cell = Arc::new(OnceLock::new());
        assert!(cell.set(store).is_ok());
        Self {
            _dir: dir,
            repo,
            handles: DreamHandles {
                store: cell,
                runs,
                broca_routes: Arc::default(),
                wiring: Wiring::production(),
                module_id: "magic-context".into(),
            },
            resolver,
            clock,
        }
    }

    fn store(&self) -> &McStore {
        self.handles.store.get().unwrap()
    }

    fn commit(&self, name: &str, seconds: i64) {
        let timestamp = format!("@{} +0000", NOW / 1000 - 100 + seconds);
        let output = Command::new("git")
            .current_dir(&self.repo)
            .args([
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
            ])
            .args(["commit", "-q", "--allow-empty", "-m", name])
            .env("GIT_AUTHOR_DATE", &timestamp)
            .env("GIT_COMMITTER_DATE", &timestamp)
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
    }

    fn tick(&self) {
        let report = self
            .handles
            .start(PROJECT, None)
            .unwrap()
            .join()
            .unwrap()
            .unwrap();
        if let Some(report) = report {
            assert!(report.unwrap().is_empty());
        }
    }

    fn advance(&self) {
        self.clock.0.fetch_add(COOLDOWN, Ordering::SeqCst);
    }

    fn rows(&self) -> Vec<(String, i64)> {
        self.store()
            .with_context_read(|db| {
                db.prepare("SELECT message,indexed_at FROM git_commits ORDER BY committed_at,sha")?
                    .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                    .collect()
            })
            .unwrap()
    }
}

fn git(directory: &std::path::Path, args: &[&str]) {
    let output = Command::new("git")
        .current_dir(directory)
        .args(args)
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
}

#[test]
fn tick_indexes_new_commits_incrementally_and_enforces_retention_without_a_dream_runner() {
    let f = Fixture::new();
    f.commit("first", 1);
    f.commit("second", 2);
    f.tick();
    assert_eq!(
        f.rows(),
        vec![("first".into(), NOW), ("second".into(), NOW)]
    );
    f.commit("third", 3);
    f.tick();
    assert_eq!(f.rows().len(), 2, "successful sweeps share TS cooldown");
    f.advance();
    f.tick();
    assert_eq!(
        f.rows(),
        vec![("second".into(), NOW), ("third".into(), NOW + COOLDOWN)]
    );
}

#[test]
fn tick_skips_disabled_indexing_and_disabled_background_work() {
    let f = Fixture::new();
    f.commit("first", 1);
    f.resolver.enabled.store(false, Ordering::SeqCst);
    f.tick();
    assert!(f.rows().is_empty());
    f.resolver.enabled.store(true, Ordering::SeqCst);
    f.resolver.background.store(false, Ordering::SeqCst);
    f.tick();
    assert!(f.rows().is_empty());
    f.resolver.background.store(true, Ordering::SeqCst);
    f.tick();
    assert_eq!(f.rows(), vec![("first".into(), NOW)]);
}

#[test]
fn concurrent_ticks_are_single_flight_per_project() {
    let f = Fixture::new();
    f.commit("first", 1);
    let (lock, cv) = &f.resolver.gate;
    lock.lock().unwrap().0 = true;
    let first = f.handles.start(PROJECT, None).unwrap();
    let mut gate = lock.lock().unwrap();
    while !gate.1 {
        gate = cv.wait(gate).unwrap();
    }
    let second = f.handles.start(PROJECT, None);
    gate.0 = false;
    cv.notify_all();
    drop(gate);
    first.join().unwrap().unwrap().unwrap().unwrap();
    let single_flight = second.is_none();
    if let Some(second) = second {
        second.join().unwrap().unwrap().unwrap().unwrap();
    }
    assert!(single_flight);
    assert_eq!(f.rows(), vec![("first".into(), NOW)]);
}

#[test]
fn tick_obeys_standalone_plugin_lease_and_cooldown_then_takes_over_after_expiry() {
    let f = Fixture::new();
    f.commit("first", 1);
    f.store().with_context_conn_for_test(|tx| {
        tx.execute("INSERT INTO git_sweep_coordinator(project_path,lease_holder,lease_expires_at,last_swept_at)
                    VALUES (?1,'standalone',?2,NULL)", rusqlite::params![PROJECT, NOW + 300_000])?;
        Ok(())
    }).unwrap();
    f.tick();
    assert!(f.rows().is_empty());
    f.store().with_context_conn_for_test(|tx| {
        tx.execute("UPDATE git_sweep_coordinator SET lease_holder=NULL,lease_expires_at=NULL,last_swept_at=?1", [NOW])?;
        Ok(())
    }).unwrap();
    f.tick();
    assert!(f.rows().is_empty());
    f.advance();
    f.store().with_context_conn_for_test(|tx| {
        tx.execute("UPDATE git_sweep_coordinator SET lease_holder='crashed-plugin',lease_expires_at=?1", [NOW + 300_000])?;
        Ok(())
    }).unwrap();
    f.tick();
    assert_eq!(f.rows(), vec![("first".into(), NOW + COOLDOWN)]);
}

#[test]
fn overlapping_indexers_share_the_sqlite_lease_and_lost_ownership_cannot_publish() {
    let f = Fixture::new();
    f.commit("first", 1);
    let options = mc_store::git_archive::index::IndexOptions {
        since_days: 365.0,
        max_commits: 2.0,
    };
    let acquired = std::sync::Barrier::new(2);
    let completed = std::sync::Barrier::new(2);
    std::thread::scope(|scope| {
        let job = scope.spawn(|| {
            f.store()
                .index_git_commits(PROJECT, &f.repo, &options, NOW, || {
                    acquired.wait();
                    completed.wait();
                    NOW
                })
                .unwrap()
                .unwrap()
        });
        acquired.wait();
        // The tick's in-process guard prevents concurrent ticks, but it must also
        // respect the shared lease held by an indexer outside that guard.
        f.tick();
        let rows_during_lease = f.rows();
        completed.wait();
        assert_eq!(job.join().unwrap().inserted, 1);
        assert!(rows_during_lease.is_empty());
    });
    f.commit("second", 2);
    f.advance();
    let result = f
        .store()
        .index_git_commits(PROJECT, &f.repo, &options, NOW + COOLDOWN, || {
            f.store()
                .with_context_conn_for_test(|tx| {
                    tx.execute(
                        "UPDATE git_sweep_coordinator SET lease_holder='new-owner'",
                        [],
                    )?;
                    Ok(())
                })
                .unwrap();
            NOW + COOLDOWN
        })
        .unwrap();
    assert!(result.is_none());
    assert_eq!(f.rows(), vec![("first".into(), NOW)]);
    f.store()
        .with_context_read(|db| {
            let holder: String = db.query_row(
                "SELECT lease_holder FROM git_sweep_coordinator WHERE project_path=?1",
                [PROJECT],
                |row| row.get(0),
            )?;
            assert_eq!(holder, "new-owner");
            Ok(())
        })
        .unwrap();
}

#[test]
fn failed_index_publication_rolls_back_and_releases_without_cooldown() {
    let f = Fixture::new();
    f.commit("first", 1);
    f.store()
        .with_context_conn_for_test(|tx| {
            tx.execute_batch(
                "CREATE TRIGGER fail_index BEFORE INSERT ON git_commits
                 BEGIN SELECT RAISE(ABORT,'injected publication failure'); END;",
            )
        })
        .unwrap();
    f.tick();
    assert!(f.rows().is_empty());
    f.store()
        .with_context_read(|db| {
            let state: (Option<String>, Option<i64>) = db.query_row(
                "SELECT lease_holder,last_swept_at FROM git_sweep_coordinator
                 WHERE project_path=?1",
                [PROJECT],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(state, (None, None));
            Ok(())
        })
        .unwrap();
    f.store()
        .with_context_conn_for_test(|tx| tx.execute_batch("DROP TRIGGER fail_index"))
        .unwrap();
    f.tick();
    assert_eq!(f.rows(), vec![("first".into(), NOW)]);
}
