//! A view ck-mc handed to the runner and saved as unconfirmed is offered
//! again after a restart. The runner checks the offered view's checksum, so
//! what ck-mc loads from `mode3.db` must be the view exactly as it was
//! sealed, including the policy members (`built_through`, `new_signed`) a
//! runner that declares `view_anchor` receives.

use super::*;
use cortexkit_role_compaction::part::{ToolPart, ToolStatus};
use cortexkit_role_compaction::view::{InsertAt, InsertedMessage};

/// Log output, for reading the lines ck-mc writes.
#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for Captured {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Captured {
    fn text(&self) -> String {
        String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
    }
}

/// Capture this thread's log lines until the guard drops.
fn capture() -> (Captured, tracing::subscriber::DefaultGuard) {
    let output = Captured::default();
    let writer = output.clone();
    let subscriber = tracing_subscriber::fmt()
        .without_time()
        .with_ansi(false)
        .with_writer(move || writer.clone())
        .finish();
    (output, tracing::subscriber::set_default(subscriber))
}

/// A session on the `head` preset (the one that gets a history head and a
/// cut) on a Claude model whose runner declares `view_anchor`,
/// with a store, its transcript read, and two views handed over: view 1,
/// which the runner applied, and view 2, which it accepted but has not
/// applied yet. View 2 carries the history head (large enough that the store
/// keeps its text apart), a whole-message drop, view 1's carried part drop,
/// and a replace of a tool argument beside an object whose keys are out of
/// alphabetical order.
struct Handed {
    session: Session,
    client: Client,
    route: Route,
    setup: SetupRequest,
    settings: Settings,
    store: Arc<crate::store::Store>,
    applied: View,
    pending: View,
    dir: std::path::PathBuf,
}

/// The text part of the message view 2 drops whole, which view 2 covers.
fn middle() -> lanes::PartKey {
    ("middle".into(), "p".into())
}

async fn handed(label: &str) -> Handed {
    let (mut session, client, route, mut setup, settings) = fixture();
    setup.model = ModelRef::new("anthropic", "claude-opus-5-5");
    setup.rules = ProviderRules::new(SignedParts::Bound, EditCost::Suffix);
    setup.view_anchor = Some(true);
    let mut tool = ToolPart::new(
        "call",
        "bash",
        serde_json::json!({
            "command": "ls -la",
            "options": {"zeta": 1, "alpha": [2, 1.5], "mid": {"y": true, "b": null}},
        }),
        ToolStatus::Completed,
    );
    tool.output = Some("listing".into());
    let tool = Part::new("t", PartBody::Tool(tool)).with_tag(3);
    let expect = tool.digest.clone();
    *client.entries.lock().unwrap() = vec![
        text(1, "older"),
        text(2, "middle"),
        Entry::new(3, "tools", Role::Assistant, 3, vec![tool]),
        text(4, "newest"),
    ];
    setup.newest = client.entries.lock().unwrap().last().map(cursor);
    let dir = scratch(label);
    let store = Arc::new(crate::store::Store::open(&dir.join("mode3.db")).unwrap());
    session.set_store(Some(Arc::clone(&store)));
    session
        .setup(&client, &settings, &route, &setup, Features::NONE)
        .await;

    let applied = session
        .seal(
            vec![EditOp::Drop {
                mid: "older".into(),
                part: Some("p".into()),
            }],
            &[],
        )
        .expect("view 1 is built");
    session.publish(&client, applied.clone()).await;
    session.settle_unconfirmed(Some(&applied.applied()), &[]);
    let mut answer = AppliedViewAnswer::new();
    answer.view = Some(applied.clone());
    *client.applied.lock().unwrap() = Some(answer);

    let head = "history \"quoted\" \\ 雪\n".repeat(400);
    assert!(head.len() > 4_096, "the store keeps the head's text apart");
    let pending = session
        .seal(
            vec![
                EditOp::Insert {
                    at: InsertAt::Start,
                    message: InsertedMessage::new("m0", Role::User, vec![head]),
                },
                EditOp::Drop {
                    mid: "middle".into(),
                    part: None,
                },
                EditOp::Replace {
                    mid: "tools".into(),
                    part: "t".into(),
                    field: "input.command".into(),
                    value: serde_json::json!("{\"zeta\":\"\\u00e9 \\\"q\\\"\",\"alpha\":1} §3§"),
                    expect,
                },
            ],
            &[middle()],
        )
        .expect("view 2 is built");
    assert_eq!(pending.version, 2);
    assert_eq!(pending.built_through.as_deref(), Some("newest"));
    assert_eq!(pending.new_signed.as_deref(), Some("strip"));
    assert!(pending.verify(), "view 2 was sealed with a valid checksum");
    session.publish(&client, pending.clone()).await;
    assert_eq!(session.unconfirmed.len(), 1, "view 2 awaits confirmation");
    Handed {
        session,
        client,
        route,
        setup,
        settings,
        store,
        applied,
        pending,
        dir,
    }
}

impl Handed {
    /// What a ck-mc restart does: a new session restored from the store,
    /// then the runner's Setup reporting view 1 applied, which offers view 2
    /// again.
    async fn restart(&mut self) {
        let mut restored = Session::new(&self.route, &self.setup, Features::NONE, None);
        restored.set_store(Some(Arc::clone(&self.store)));
        restored.restore(self.store.load(&self.route.session).unwrap());
        let mut setup = self.setup.clone();
        setup.applied_view = Some(self.applied.applied());
        restored
            .setup(
                &self.client,
                &self.settings,
                &self.route,
                &setup,
                Features::NONE,
            )
            .await;
        self.session = restored;
    }

    fn offered(&self) -> Vec<View> {
        self.client.offered.lock().unwrap().clone()
    }
}

/// After each of two restarts, the view offered again is the one first
/// handed over, byte for byte, and its checksum still verifies. The runner
/// accepts it, so ck-mc keeps it rather than rolling it back.
#[tokio::test]
async fn restart_a_view_offered_again_keeps_the_bytes_it_was_sealed_with() {
    let mut handed = handed("offer-again").await;
    let sealed = serde_json::to_vec(&handed.pending).unwrap();
    for restart in 1..=2 {
        let loaded = handed.store.load(&handed.route.session).unwrap();
        let before = handed.offered().len();
        handed.restart().await;
        let mut offered = handed.offered();
        assert_eq!(offered.len(), before + 1, "restart {restart}: one offer");
        let offered = offered.pop().unwrap();
        assert!(
            offered.verify(),
            "restart {restart}: the view offered again fails its checksum \
             (built_through {:?}, new_signed {:?})",
            offered.built_through,
            offered.new_signed
        );
        assert_eq!(
            serde_json::to_vec(&offered).unwrap(),
            sealed,
            "restart {restart}"
        );
        assert_eq!(handed.session.latest.as_ref(), Some(&handed.pending));
        assert_eq!(handed.session.unconfirmed.len(), 1);
        // A rollback puts back the view the pending one replaced, so the
        // store must keep that view whole too.
        assert_eq!(
            loaded.unconfirmed[0].before.latest.as_ref(),
            Some(&handed.applied),
            "restart {restart}: the store changed the view that view 2 replaced"
        );
        // Save again, as the next pass would before the following restart.
        handed
            .store
            .save(&handed.route.session, &handed.session.durable())
            .unwrap();
    }
    std::fs::remove_dir_all(&handed.dir).unwrap();
}

/// A refused offer names the policy members the view carried, so a checksum
/// refusal can be told apart from one caused by a lost member.
#[tokio::test]
async fn restart_a_refused_offer_logs_the_policy_members_it_carried() {
    let mut handed = handed("refused-offer").await;
    *handed.client.refuse.lock().unwrap() = true;
    *handed.client.refusal.lock().unwrap() = Some(ViewRefusal::BadChecksum);
    let (logs, guard) = capture();
    handed.restart().await;
    drop(guard);
    assert!(
        logs.text().contains(
            "runner refused view 2 offered again: BadChecksum (built_through present, new_signed strip)"
        ),
        "{}",
        logs.text()
    );
    assert!(
        handed.session.unconfirmed.is_empty(),
        "a refused view is rolled back"
    );
    std::fs::remove_dir_all(&handed.dir).unwrap();
}

/// Rewrite the saved state the way ck-mc's earlier encoder wrote it: every
/// saved view without `built_through` and `new_signed`.
fn strip_policy_members(path: &std::path::Path) {
    fn strip(view: &mut Value) {
        let view = view.as_object_mut().expect("a saved view");
        assert!(view.remove("built_through").is_some(), "{view:?}");
        assert!(view.remove("new_signed").is_some(), "{view:?}");
    }
    let connection = rusqlite::Connection::open(path).unwrap();
    let text: String = connection
        .query_row(
            "SELECT state FROM sessions WHERE session = 's1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let mut state: Value = serde_json::from_str(&text).unwrap();
    for pending in state["unconfirmed"].as_array_mut().unwrap() {
        strip(&mut pending["view"]);
        strip(&mut pending["before"]["latest"]);
    }
    connection
        .execute(
            "UPDATE sessions SET state = ?1 WHERE session = 's1'",
            [state.to_string()],
        )
        .unwrap();
}

/// A view an earlier ck-mc saved without its policy members fails its own
/// checksum and can't be repaired. It is not sent: it is rolled back as
/// undelivered, without blaming its parts, and logged. The view it replaced
/// lost the same members, so ck-mc reads the runner's copy back rather than
/// building on one that differs from it in policy alone.
#[tokio::test]
async fn restart_a_view_saved_without_its_policy_members_is_rebuilt_not_offered_again() {
    let mut handed = handed("old-encoder").await;
    strip_policy_members(&handed.dir.join("mode3.db"));
    let loaded = handed.store.load(&handed.route.session).unwrap();
    assert!(!loaded.unconfirmed[0].view.verify());
    let before = handed.offered().len();
    let (logs, guard) = capture();
    handed.restart().await;
    drop(guard);
    assert_eq!(
        handed.offered().len(),
        before,
        "a view failing its checksum was sent"
    );
    assert!(
        logs.text().contains(
            "view 2 saved without its policy members; rebuilding instead of offering it again"
        ),
        "{}",
        logs.text()
    );
    assert!(
        handed.session.unconfirmed.is_empty(),
        "view 2 is rolled back"
    );
    assert!(
        !handed.session.failed_parts.contains(&middle()),
        "the parts of a view rolled back as undelivered are not blamed"
    );
    assert_eq!(handed.session.latest.as_ref(), Some(&handed.applied));
    assert!(!handed.session.latest_unknown);
    assert!(
        handed
            .session
            .seal(
                vec![EditOp::Drop {
                    mid: "older".into(),
                    part: Some("p".into()),
                }],
                &[],
            )
            .is_none(),
        "a view differing from the runner's in policy alone was built"
    );
    std::fs::remove_dir_all(&handed.dir).unwrap();
}
