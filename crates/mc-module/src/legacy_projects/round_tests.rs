//! Rounds against a stand-in Entorhinal, temporary git repositories and a
//! synthetic store.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cortexkit_role_compaction::read::{ReadPage, ReadRequest, SessionRef};
use cortexkit_role_compaction::view::{AppliedViewAnswer, ApplyViewAnswer, ApplyViewRequest};
use cortexkit_role_llm_runner::run::{RunResult, RunResultRequest};
use cortexkit_role_llm_runner::send::{SendReply, SendRequest};
use rusqlite::{params, Connection};
use serde_json::{json, Value};

use super::key::tests::{golden_repository, GOLDEN_ROOT_COMMIT};
use super::{key, round, run, Mover, Report, Round, Wake};
use crate::client::{Child, ClientError, EntorhinalRefusal, RunnerClient};
use crate::context_db::ContextDb;
use crate::memory_writes::normalized_hash;

/// Answers `enumerate` with the reply it holds, or not at all, and counts
/// the calls.
#[derive(Default)]
struct Entorhinal {
    reply: Mutex<Option<Value>>,
    calls: AtomicUsize,
}

impl RunnerClient for Entorhinal {
    async fn read(&self, _: &SessionRef, _: ReadRequest) -> Result<ReadPage, ClientError> {
        unreachable!()
    }

    async fn apply_view(
        &self,
        _: &SessionRef,
        _: ApplyViewRequest,
    ) -> Result<ApplyViewAnswer, ClientError> {
        unreachable!()
    }

    async fn applied_view(&self, _: &SessionRef) -> Result<AppliedViewAnswer, ClientError> {
        unreachable!()
    }

    async fn send(&self, _: &SessionRef, _: SendRequest) -> Result<SendReply, ClientError> {
        unreachable!()
    }

    async fn send_child(&self, _: &Child, _: SendRequest) -> Result<SendReply, ClientError> {
        unreachable!()
    }

    async fn child_result(&self, _: &Child, _: RunResultRequest) -> Result<RunResult, ClientError> {
        unreachable!()
    }

    async fn entorhinal_call(
        &self,
        _: &SessionRef,
        body: Vec<u8>,
    ) -> Option<Result<Vec<u8>, EntorhinalRefusal>> {
        let request: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(request, json!({"method": "enumerate", "params": {}}));
        self.calls.fetch_add(1, Ordering::SeqCst);
        let reply = self.reply.lock().unwrap().clone()?;
        Some(Ok(serde_json::to_vec(&reply).unwrap()))
    }
}

/// An `enumerate` answer: each project with its folders and their identity.
fn answer(generation: i64, projects: &[(&str, &[(&Path, &str)])]) -> Value {
    let projects: Vec<Value> = projects
        .iter()
        .map(|(id, roots)| {
            json!({
                "projectId": id,
                "name": id,
                "roots": roots.iter().map(|(root, _)| root.display().to_string()).collect::<Vec<_>>(),
                "implicit": false,
                "refKind": "local",
                "rootRecords": roots.iter().map(|(root, identity)| json!({
                    "root": root.display().to_string(),
                    "remotes": [],
                    "incarnation": null,
                    "registrationEpoch": null,
                    "identity": identity,
                    "approval": {"state": "approved", "journalSeq": null},
                })).collect::<Vec<_>>(),
            })
        })
        .collect();
    json!({"result": {"workspaces": [], "projects": projects, "generation": generation, "incarnation": "inc-1"}})
}

struct Fixture {
    dir: tempfile::TempDir,
    db: Arc<ContextDb>,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap());
        Self { dir, db }
    }

    /// A checkout with the golden root commit.
    fn checkout(&self, name: &str) -> PathBuf {
        let repo = self.dir.path().join(name);
        golden_repository(&repo);
        repo
    }

    /// A folder outside any checkout.
    fn folder(&self, name: &str) -> PathBuf {
        let folder = self.dir.path().join(name);
        std::fs::create_dir_all(&folder).unwrap();
        folder
    }

    fn with<T>(&self, apply: impl FnOnce(&Connection) -> T) -> T {
        self.db.with_connection(|conn| apply(conn))
    }

    fn memory(&self, owner: &str, content: &str) {
        self.with(|conn| {
            conn.execute(
                "INSERT INTO memories (level, owner_id, category, origin_category, content,
                                       normalized_hash, first_seen_at, created_at, updated_at,
                                       last_seen_at, status)
                 VALUES ('project', ?1, 'swe:naming', 'NAMING', ?2, ?3, 1, 1, 1, 1, 'active')",
                params![owner, content, normalized_hash(content)],
            )
            .unwrap()
        });
    }

    fn note(&self, project: &str, content: &str) {
        self.with(|conn| {
            conn.execute(
                "INSERT INTO notes (type, content, project_path, created_at, updated_at)
                 VALUES ('smart', ?1, ?2, 1, 1)",
                params![content, project],
            )
            .unwrap()
        });
    }

    fn memories(&self, owner: &str) -> Vec<String> {
        self.with(|conn| {
            conn.prepare("SELECT content FROM memories WHERE owner_id = ?1 ORDER BY id")
                .unwrap()
                .query_map([owner], |row| row.get(0))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap()
        })
    }

    fn notes(&self, project: &str) -> i64 {
        self.with(|conn| {
            conn.query_row(
                "SELECT count(*) FROM notes WHERE project_path = ?1",
                [project],
                |row| row.get(0),
            )
            .unwrap()
        })
    }
}

fn golden_key() -> String {
    format!("git:{GOLDEN_ROOT_COMMIT}")
}

fn entorhinal(reply: Value) -> Entorhinal {
    Entorhinal {
        reply: Mutex::new(Some(reply)),
        calls: AtomicUsize::new(0),
    }
}

fn settled(round: Round) -> Report {
    match round {
        Round::Settled(report) => report,
        other => panic!("the round settled nothing: {other:?}"),
    }
}

#[tokio::test]
async fn a_git_folder_and_a_plain_folder_each_move_to_their_project() {
    let fixture = Fixture::new();
    let repo = fixture.checkout("repo");
    let plain = fixture.folder("plain");
    fixture.memory(&golden_key(), "Folds happen on cache loss.");
    fixture.note(&key::directory_key(&plain), "Ship after CI.");
    let client = entorhinal(answer(
        1,
        &[
            ("pj-git", &[(&repo, "bound")]),
            ("pj-dir", &[(&plain, "bound")]),
        ],
    ));
    let report = settled(round(&client, &fixture.db, &mut Mover::default()).await);
    assert!(report.complete);
    assert!(!report.left, "nothing is left under a 0.49 key");
    assert_eq!(report.pools.len(), 2);
    assert_eq!(
        fixture.memories("pj-git"),
        vec!["Folds happen on cache loss."]
    );
    assert!(fixture.memories(&golden_key()).is_empty());
    assert_eq!(fixture.notes("pj-dir"), 1);
    assert_eq!(fixture.notes(&key::directory_key(&plain)), 0);
}

#[tokio::test]
async fn a_project_with_two_folders_gets_both_pools() {
    let fixture = Fixture::new();
    let repo = fixture.checkout("repo");
    let plain = fixture.folder("plain");
    fixture.memory(&golden_key(), "From the checkout.");
    fixture.memory(&key::directory_key(&plain), "From the plain folder.");
    let client = entorhinal(answer(
        1,
        &[("pj-a", &[(&repo, "bound"), (&plain, "bound")])],
    ));
    settled(round(&client, &fixture.db, &mut Mover::default()).await);
    assert_eq!(
        fixture.memories("pj-a"),
        vec!["From the checkout.", "From the plain folder."]
    );
}

#[test]
fn a_key_two_projects_claim_is_copied_to_both_and_logged() {
    let fixture = Fixture::new();
    let first = fixture.checkout("clone-one");
    let second = fixture.checkout("clone-two");
    fixture.memory(&golden_key(), "Both clones learned this.");
    let roots = vec![("pj-b".to_owned(), second), ("pj-a".to_owned(), first)];
    let (report, log) = crate::test_log::logged(|| Mover::default().apply(&fixture.db, &roots, 5));
    assert!(report.complete);
    assert!(
        log.contains(&format!(
            "ck-mc: legacy project rows copied from {} to pj-a, pj-b: pj-a (memories=1); pj-b (memories=1)",
            golden_key()
        )),
        "{log}"
    );
    assert_eq!(fixture.memories("pj-a"), vec!["Both clones learned this."]);
    assert_eq!(fixture.memories("pj-b"), vec!["Both clones learned this."]);
    assert!(fixture.memories(&golden_key()).is_empty());
}

#[tokio::test]
async fn without_an_answer_from_entorhinal_nothing_moves() {
    let fixture = Fixture::new();
    fixture.memory(&golden_key(), "Stays where it is.");
    let mut mover = Mover::default();
    assert!(matches!(
        round(&Entorhinal::default(), &fixture.db, &mut mover).await,
        Round::Retry
    ));
    assert_eq!(fixture.memories(&golden_key()), vec!["Stays where it is."]);
    assert!(mover.seen.is_none());
}

#[test]
fn a_folder_git_cannot_read_is_skipped_and_said_once() {
    let fixture = Fixture::new();
    let repo = fixture.checkout("repo");
    let broken = fixture.folder("broken");
    std::fs::write(
        broken.join(".git"),
        "gitdir: /nonexistent/legacy-projects-round\n",
    )
    .unwrap();
    fixture.memory(&golden_key(), "Moves despite the broken folder.");
    // A key no folder gives keeps the store's legacy keys non-empty, so the
    // second round asks again for the broken folder.
    fixture.memory("git:ffffffff", "Nobody's.");
    let roots = vec![
        ("pj-bad".to_owned(), broken.clone()),
        ("pj-ok".to_owned(), repo),
    ];
    let mut mover = Mover::default();
    let (report, first) = crate::test_log::logged(|| mover.apply(&fixture.db, &roots, 5));
    let (_, second) = crate::test_log::logged(|| mover.apply(&fixture.db, &roots, 6));
    assert!(report.complete);
    assert_eq!(
        fixture.memories("pj-ok"),
        vec!["Moves despite the broken folder."]
    );
    assert!(fixture.memories("pj-bad").is_empty());
    let said = format!("ck-mc: no legacy project key for {}", broken.display());
    assert_eq!(first.matches(&said).count(), 1, "{first}");
    assert_eq!(second.matches(&said).count(), 0, "{second}");
}

#[tokio::test]
async fn a_rerun_moves_nothing() {
    let fixture = Fixture::new();
    let repo = fixture.checkout("repo");
    fixture.memory(&golden_key(), "Moved once.");
    // A key no folder gives keeps rounds going.
    fixture.memory("git:ffffffff", "Nobody's.");
    let client = entorhinal(answer(1, &[("pj-a", &[(&repo, "bound")])]));
    let mut mover = Mover::default();
    settled(round(&client, &fixture.db, &mut mover).await);
    let logged = || {
        fixture.with(|conn| {
            conn.query_row("SELECT count(*) FROM identity_merge_log", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap()
        })
    };
    let after_first = logged();
    // The same answer is not handled twice.
    assert!(matches!(
        round(&client, &fixture.db, &mut mover).await,
        Round::Unchanged
    ));
    // A new answer is, and finds nothing left to move.
    *client.reply.lock().unwrap() = Some(answer(2, &[("pj-a", &[(&repo, "bound")])]));
    let report = settled(round(&client, &fixture.db, &mut mover).await);
    assert!(
        report.complete && report.left && report.pools.is_empty(),
        "{report:?}"
    );
    assert_eq!(logged(), after_first);
    assert_eq!(fixture.memories("pj-a"), vec!["Moved once."]);
}

#[tokio::test]
async fn only_a_bound_folder_gives_its_key() {
    let fixture = Fixture::new();
    let repo = fixture.checkout("repo");
    fixture.memory(&golden_key(), "Not claimed yet.");
    let client = entorhinal(answer(1, &[("pj-a", &[(&repo, "unbound")])]));
    settled(round(&client, &fixture.db, &mut Mover::default()).await);
    assert_eq!(fixture.memories(&golden_key()), vec!["Not claimed yet."]);
}

/// Wait, in virtual time, until Entorhinal was asked `count` times.
async fn asked(client: &Entorhinal, count: usize) {
    for _ in 0..1_000 {
        if client.calls.load(Ordering::SeqCst) >= count {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!(
        "Entorhinal was asked {} times, not {count}",
        client.calls.load(Ordering::SeqCst)
    );
}

#[tokio::test(start_paused = true)]
async fn rounds_retry_until_entorhinal_answers_then_wait_for_a_new_project_or_the_hour() {
    let fixture = Fixture::new();
    // A key no folder gives keeps rounds going.
    fixture.memory("git:ffffffff", "Nobody's.");
    let client = Arc::new(Entorhinal::default());
    let wake = Arc::new(Wake::default());
    let task = tokio::spawn({
        let (client, db, wake) = (
            Arc::clone(&client),
            Arc::clone(&fixture.db),
            Arc::clone(&wake),
        );
        async move { run(client.as_ref(), db, wake).await }
    });
    let calls = || client.calls.load(Ordering::SeqCst);
    // The first round runs at once, and is retried after 5, 10 and 20 s.
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(calls(), 1);
    tokio::time::sleep(Duration::from_secs(5)).await;
    assert_eq!(calls(), 2);
    tokio::time::sleep(Duration::from_secs(10)).await;
    assert_eq!(calls(), 3);
    *client.reply.lock().unwrap() = Some(answer(1, &[]));
    tokio::time::sleep(Duration::from_secs(20)).await;
    assert_eq!(calls(), 4);
    // Answered, the rounds wait for the hour.
    tokio::time::sleep(Duration::from_secs(30 * 60)).await;
    assert_eq!(calls(), 4);
    // A Setup naming a project id this process hasn't seen wakes a round; a
    // known one doesn't, nor does a key that isn't a project id.
    wake.saw("pj-new");
    asked(&client, 5).await;
    wake.saw("pj-new");
    wake.saw("git:ffffffff");
    tokio::time::sleep(Duration::from_secs(60)).await;
    assert_eq!(calls(), 5);
    // The hour passes.
    tokio::time::sleep(Duration::from_secs(60 * 60)).await;
    asked(&client, 6).await;
    assert!(!task.is_finished(), "rows are left, so the rounds go on");
    task.abort();
}

#[tokio::test]
async fn rounds_stop_once_no_legacy_rows_are_left() {
    let fixture = Fixture::new();
    let repo = fixture.checkout("repo");
    fixture.memory(&golden_key(), "The last legacy memory.");
    let client = Arc::new(entorhinal(answer(1, &[("pj-a", &[(&repo, "bound")])])));
    let finished = tokio::time::timeout(
        Duration::from_secs(60),
        run(client.as_ref(), Arc::clone(&fixture.db), Arc::default()),
    )
    .await;
    assert!(finished.is_ok(), "the rounds stop once nothing is left");
    assert_eq!(fixture.memories("pj-a"), vec!["The last legacy memory."]);
    assert_eq!(client.calls.load(Ordering::SeqCst), 1);
    // A store with nothing under a 0.49 key never asks Entorhinal.
    let clean = Fixture::new();
    let client = Arc::new(entorhinal(answer(1, &[])));
    tokio::time::timeout(
        Duration::from_secs(60),
        run(client.as_ref(), Arc::clone(&clean.db), Arc::default()),
    )
    .await
    .expect("a clean store ends the rounds at once");
    assert_eq!(client.calls.load(Ordering::SeqCst), 0);
}
