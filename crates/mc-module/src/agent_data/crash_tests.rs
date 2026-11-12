//! Crashes during a move, on real modules over stores in temporary
//! folders. A crash is an op stopped at one of the points that follow each
//! of its durable writes ([`crash`]), then the module dropped with all it
//! kept in memory, and a new one started over the same files the way
//! `main.rs` starts one: the journal loaded, the files of ended cuts swept,
//! and every install the journal records as started finished.

use super::*;
use crate::agent_data::crash::{self, Mode, Plan};
use crate::agent_data::install;
use cortexkit_role_agent_data::step::Step;
use std::future::Future;

const BOTH: [&str; 2] = ["s1", "s2"];

/// Run `op` under `plan`: its reply when it runs to its end, `None` when it
/// stopped where the plan crashes it.
pub(super) async fn stopped_at<T>(plan: &Arc<Plan>, op: impl Future<Output = T>) -> Option<T> {
    tokio::select! {
        biased;
        result = crash::PLAN.scope(Arc::clone(plan), op) => (!plan.stopped()).then_some(result),
        () = plan.reached() => None,
    }
}

impl Machine {
    /// The same machine after a crash, started as `main.rs` starts ck-mc,
    /// with moves served or not (`agent_data`).
    async fn reboot(self, agent_data: bool) -> Self {
        let Self {
            module,
            shared,
            db,
            dir,
        } = self;
        drop(module);
        let journal = Arc::new(Journal::load(journal_file::path(&db)));
        source::sweep(&db, &journal);
        let module = Module::with_journal(
            Mover(Arc::clone(&shared)),
            Settings::default(),
            Some(ContextDb::open(&db).unwrap()),
            Some(Store::open(&dir.path().join("mode3.db")).unwrap()),
            journal,
            agent_data,
        );
        module.inner.agent_data.recover(&module).await;
        Self {
            module,
            shared,
            db,
            dir,
        }
    }

    /// Prepare the sessions and seal the cut from `prepare`'s items, as
    /// Entorhinal does, without exporting it.
    async fn cut_out(&self, cut: &str, names: &[&str]) {
        let prepared = self.op("prepare", cut, names).await.unwrap();
        for item in prepared["items"].as_array().unwrap() {
            self.shared.door.lock().unwrap().sealed.insert(
                (
                    cut.to_owned(),
                    item["sessionRef"].as_str().unwrap().to_owned(),
                ),
                (
                    item["endOffset"].as_u64().unwrap() as usize,
                    item["digest"].as_str().unwrap().to_owned(),
                ),
            );
        }
    }

    fn contents(&self) -> journal_file::Contents {
        self.module.journal().contents().unwrap()
    }

    fn store(&self) -> &Store {
        self.module.inner.store.as_ref().unwrap()
    }
}

/// Facts reserved under the cut's key on this machine.
fn reserved_under(machine: &Machine, cut: &str) -> i64 {
    machine
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM memory_pending_facts WHERE state = 'in_flight' AND reserved_stage_key = ?1",
            [format!("agent-data:{cut}")],
            |row| row.get(0),
        )
        .unwrap()
}

/// Each fact of a publication: its index, state and reservation.
type Facts = Vec<(i64, String, Option<String>)>;

/// What a machine holds of a move, compared between a run the crash cut
/// short and one that was never stopped.
#[derive(Debug, PartialEq)]
struct State {
    journal: journal_file::Contents,
    sessions: Vec<(snapshot::Fingerprint, Facts)>,
    files: bool,
}

impl State {
    fn of(machine: &Machine, cut: &str, sessions: &[&str]) -> Self {
        Self {
            journal: machine.contents(),
            sessions: sessions
                .iter()
                .map(|session| {
                    (
                        machine.fingerprint(session),
                        facts(&machine.conn(), &format!("pub-{session}")),
                    )
                })
                .collect(),
            files: source::cut_folder(&machine.db, cut).exists(),
        }
    }
}

/// The rules a restart must find kept, whichever write the crash came
/// after. No session is left being installed: startup finishes each
/// install. A session served again holds rows `served` allows for it,
/// never a part of an install. The gate refuses exactly the sessions the
/// journal names. The cut's facts are reserved only while a session of the
/// cut is frozen or was released from here, so never under a cut recorded
/// aborted.
fn check_restart(
    machine: &Machine,
    cut: &str,
    served: &[(&str, Vec<snapshot::Fingerprint>)],
    point: &str,
) {
    let contents = machine.contents();
    for entry in &contents.sessions {
        assert!(
            entry
                .moving
                .as_ref()
                .is_none_or(|moving| moving.state != MovingState::Activating),
            "after {point}: {entry:?} is still being installed"
        );
        let gate = machine.gate(&entry.session);
        let expected = match (&entry.moving, &entry.released) {
            (Some(_), _) => Err(SESSION_MOVING),
            (None, Some(_)) => Err(SESSION_MOVED),
            (None, None) => Ok(()),
        };
        assert_eq!(gate, expected, "after {point}: gate of {entry:?}");
    }
    let holds = contents.sessions.iter().any(|entry| {
        entry
            .moving
            .as_ref()
            .is_some_and(|moving| moving.cut == cut && moving.state == MovingState::Frozen)
            || entry
                .released
                .as_ref()
                .is_some_and(|released| released.cut == cut)
    });
    if !holds {
        assert_eq!(reserved_under(machine, cut), 0, "after {point}");
    }
    if contents
        .cuts
        .get(cut)
        .is_some_and(|record| record.step == Step::Aborted)
    {
        assert_eq!(reserved_under(machine, cut), 0, "after {point}");
    }
    for (session, allowed) in served {
        if machine.gate(session).is_ok() {
            assert!(
                allowed.contains(&machine.fingerprint(session)),
                "after {point}: session {session} is served with rows no move step leaves"
            );
        }
    }
}

/// Which machine of the pair an op runs on.
#[derive(Clone, Copy)]
enum Side {
    Source,
    Receiver,
}

/// One op of a move, sent to `side` once `setup` has brought the pair to
/// just before it.
struct Case {
    side: Side,
    method: &'static str,
    params: Value,
    cut: &'static str,
}

/// Crash `case`'s op after every durable write it makes, one write per
/// run, each time on a pair set up afresh. After the restart the machine
/// keeps [`check_restart`]'s rules, and the same request then returns
/// the reply a run that was never stopped returned and leaves the same
/// journal, rows and files.
async fn crash_at_every_write<F, Fut>(case: Case, setup: F)
where
    F: Fn() -> Fut,
    Fut: Future<Output = (Machine, Machine)>,
{
    let side = |pair: (Machine, Machine)| match case.side {
        Side::Source => (pair.0, pair.1),
        Side::Receiver => (pair.1, pair.0),
    };
    let (machine, other) = side(setup().await);
    let source = match case.side {
        Side::Source => &machine,
        Side::Receiver => &other,
    };
    let sources: Vec<_> = BOTH.iter().map(|s| source.fingerprint(s)).collect();
    let plan = Plan::record();
    let expected = stopped_at(&plan, machine.call(case.method, case.params.clone()))
        .await
        .expect("a plan that stops nowhere lets the op run to its end");
    let points = plan.passed();
    assert!(!points.is_empty(), "{} passes no write", case.method);
    let reference = State::of(&machine, case.cut, &BOTH);
    drop((machine, other));

    let mut crashed = 0;
    for (index, point) in points.iter().enumerate() {
        let occurrence = points[..index].iter().filter(|seen| *seen == point).count();
        let (machine, _other) = side(setup().await);
        let served: Vec<_> = BOTH
            .iter()
            .zip(&sources)
            .map(|(session, source)| {
                let before = machine.fingerprint(session);
                (
                    *session,
                    match case.side {
                        Side::Source => vec![before],
                        Side::Receiver => vec![before, source.clone()],
                    },
                )
            })
            .collect();
        let plan = Plan::at(point, occurrence, Mode::Crash);
        let at = format!("{} at {point} #{occurrence}", case.method);
        if let Some(reply) = stopped_at(&plan, machine.call(case.method, case.params.clone())).await
        {
            // The install groups its batches by how long each write takes,
            // so this run may have committed them in fewer transactions.
            assert!(point.starts_with("commit "), "{at} was never reached");
            assert_eq!(reply, expected, "{at}");
            continue;
        }
        crashed += 1;
        let machine = machine.reboot(true).await;
        check_restart(&machine, case.cut, &served, &at);
        let repeated = machine.call(case.method, case.params.clone()).await;
        assert_eq!(repeated, expected, "{at}: the repeat");
        assert_eq!(
            State::of(&machine, case.cut, &BOTH),
            reference,
            "{at}: after the repeat"
        );
        // And once more, past the restart, the repeat gets the same bytes.
        assert_eq!(
            machine.call(case.method, case.params.clone()).await,
            expected,
            "{at}: a second repeat"
        );
    }
    assert!(crashed > 0, "{}: no crash landed", case.method);
    eprintln!(
        "{}: crashed after {crashed} of the {} writes one run makes: {points:?}",
        case.method,
        points.len()
    );
}

/// Two sessions on the source, each with summaries, a session note, its
/// project link and a committed publication with a waiting fact and an
/// applied one; the receiver holds a session of its own in the project.
fn pair() -> (Machine, Machine) {
    let (a, b) = machines(&BOTH);
    for session in BOTH {
        seed(&a.conn(), session, PROJECT);
    }
    seed(&b.conn(), "b1", PROJECT);
    (a, b)
}

fn cut_params(cut: &str) -> Value {
    json!({"refs": refs(&BOTH), "cutId": cut})
}

fn case(side: Side, op: &str) -> Case {
    let method = match op {
        "prepare" => "agent_data.prepare",
        "export" => "agent_data.export",
        "import" => "agent_data.import",
        "activate" => "agent_data.activate",
        "abort" => "agent_data.abort",
        other => panic!("{other}"),
    };
    Case {
        side,
        method,
        params: cut_params(CUT),
        cut: CUT,
    }
}

#[tokio::test]
async fn a_crash_at_any_write_of_prepare_is_finished_by_its_repeat() {
    crash_at_every_write(case(Side::Source, "prepare"), || async { pair() }).await;
}

/// A `prepare` refused on its second ref, because another session's send
/// holds that session's fact, unfreezes the first: the reservation is let
/// go, then the journal stops naming the session frozen. A crash between
/// the freeze and the reservation, or between letting the reservation go
/// and that journal write, leaves the session frozen, and the repeat
/// refuses the same way and unfreezes it.
#[tokio::test]
async fn a_crash_at_any_write_of_a_refused_prepare_is_undone_by_its_repeat() {
    crash_at_every_write(case(Side::Source, "prepare"), || async {
        let (a, b) = pair();
        let stage = json!([PROJECT, "pub-s9", 1, "turn_two"]).to_string();
        a.conn()
            .execute(
                "UPDATE memory_pending_facts SET state = 'in_flight', reserved_stage_key = ?1
                 WHERE publication_id = 'pub-s2' AND fact_index = 0",
                [&stage],
            )
            .unwrap();
        (a, b)
    })
    .await;
}

#[tokio::test]
async fn a_crash_at_any_write_of_export_is_finished_by_its_repeat() {
    crash_at_every_write(case(Side::Source, "export"), || async {
        let (a, b) = pair();
        a.cut_out(CUT, &BOTH).await;
        (a, b)
    })
    .await;
}

#[tokio::test]
async fn a_crash_at_any_write_of_release_is_finished_by_its_repeat() {
    let release = Case {
        side: Side::Source,
        method: "agent_data.release",
        params: json!({"refs": refs(&BOTH), "cutId": CUT, "holder": "machine-b"}),
        cut: CUT,
    };
    crash_at_every_write(release, || async {
        let (a, b) = pair();
        a.send_out(CUT, &BOTH).await;
        (a, b)
    })
    .await;
}

#[tokio::test]
async fn a_crash_at_any_write_of_the_sources_abort_is_finished_by_its_repeat() {
    crash_at_every_write(case(Side::Source, "abort"), || async {
        let (a, b) = pair();
        a.send_out(CUT, &BOTH).await;
        (a, b)
    })
    .await;
}

#[tokio::test]
async fn a_crash_at_any_write_of_import_is_finished_by_its_repeat() {
    crash_at_every_write(case(Side::Receiver, "import"), || async {
        let (a, b) = pair();
        a.send_out(CUT, &BOTH).await;
        (a, b)
    })
    .await;
}

/// Every write of `activate`, the install's own transactions included. The
/// receiver holds an earlier copy of the first session at its baseline, so
/// the install writes an undo image and deletes rows before it inserts.
#[tokio::test]
async fn a_crash_at_any_write_of_activate_is_finished_at_the_restart() {
    crash_at_every_write(case(Side::Receiver, "activate"), || async {
        let (a, b) = pair();
        seed(&b.conn(), "s1", PROJECT);
        let baseline = b.fingerprint("s1").digest;
        b.module
            .journal()
            .change(|contents| {
                contents.session_mut(RUNNER, HARNESS, "s1").baseline = Some(baseline);
            })
            .unwrap();
        a.conn()
            .execute(
                "UPDATE notes SET content = 'newer' WHERE session_id = 's1'",
                [],
            )
            .unwrap();
        a.send_out(CUT, &BOTH).await;
        b.op("import", CUT, &BOTH).await.unwrap();
        a.release(CUT, &BOTH, "machine-b").await;
        (a, b)
    })
    .await;
}

#[tokio::test]
async fn a_crash_at_any_write_of_the_receivers_abort_is_finished_by_its_repeat() {
    crash_at_every_write(case(Side::Receiver, "abort"), || async {
        let (a, b) = pair();
        a.send_out(CUT, &BOTH).await;
        b.op("import", CUT, &BOTH).await.unwrap();
        (a, b)
    })
    .await;
}

/// How a test stops an `activate` between its two refs' step 6.
#[derive(Clone, Copy, Debug)]
enum Stop {
    Crash,
    BusyStore,
}

/// A two-ref `activate` stopped after both installs are done and the first
/// ref's step 6 has run, before the second's: once by a crash, once by a
/// busy `mode3.db`. Until both refs are finished nothing answers success,
/// and the restart or the next repeat finishes them. Meanwhile the second
/// ref's facts stay reserved: a second turn of another session of the
/// project takes the first ref's fact and none of the second's, and the
/// first ref's baseline is still its staged body's digest once the cut is
/// activated, although that turn has changed its rows since.
#[tokio::test]
async fn an_activate_stopped_between_its_two_refs_finishes_both_before_it_succeeds() {
    for stop in [Stop::Crash, Stop::BusyStore] {
        let (a, b) = pair();
        a.send_out(CUT, &BOTH).await;
        b.op("import", CUT, &BOTH).await.unwrap();
        a.release(CUT, &BOTH, "machine-b").await;
        let staged: Vec<String> = b.contents().cuts[CUT]
            .imported
            .iter()
            .map(|one| one.body.clone())
            .collect();
        assert_eq!(staged.len(), 2);
        // The first ref's step 6 ends with its facts let go.
        let first_done = "activate facts released";
        let lock = match stop {
            Stop::Crash => {
                let plan = Plan::at(first_done, 0, Mode::Crash);
                assert!(stopped_at(&plan, b.op("activate", CUT, &BOTH))
                    .await
                    .is_none());
                None
            }
            Stop::BusyStore => {
                let plan = Plan::at(first_done, 0, Mode::Pause);
                let (refused, lock) = tokio::join!(
                    crash::PLAN.scope(Arc::clone(&plan), b.op("activate", CUT, &BOTH)),
                    async {
                        plan.reached().await;
                        let lock = hold_store(&b);
                        plan.go_on();
                        lock
                    }
                );
                let refused = refused.unwrap_err();
                assert_eq!(code(&refused), "unavailable");
                assert!(refused.message.contains("mode3.db"), "{}", refused.message);
                // A repeat while the store is still busy does not succeed.
                let again = b.op("activate", CUT, &BOTH).await.unwrap_err();
                assert_eq!(code(&again), "unavailable", "{stop:?}");
                Some(lock)
            }
        };
        for session in BOTH {
            assert_eq!(
                b.moving(session),
                Some((CUT.into(), MovingState::Activating)),
                "{stop:?}"
            );
            assert_eq!(b.fingerprint(session), a.fingerprint(session), "{stop:?}");
        }
        assert_eq!(facts(&b.conn(), "pub-s1"), [waiting(0), applied(1)]);
        assert_eq!(facts(&b.conn(), "pub-s2"), [reserved(0, CUT), applied(1)]);
        assert_eq!(
            second_turn(&b.conn(), "pub-b1"),
            ["fact pub-b1 0", "fact pub-s1 0"],
            "{stop:?}"
        );
        // That turn takes the first ref's fact, as its send reserves one.
        let stage = json!([PROJECT, "pub-b1", 2, "turn_two"]).to_string();
        b.conn()
            .execute(
                "UPDATE memory_pending_facts SET state = 'in_flight', reserved_stage_key = ?1
                 WHERE publication_id = 'pub-s1' AND fact_index = 0 AND state = 'retryable'",
                [&stage],
            )
            .unwrap();
        assert_eq!(
            b.contents().cuts[CUT]
                .imported
                .iter()
                .map(|one| one.body.clone())
                .collect::<Vec<_>>(),
            staged
        );

        let b = match lock {
            None => b.reboot(true).await,
            Some(lock) => {
                drop(lock);
                assert_eq!(b.op("activate", CUT, &BOTH).await.unwrap(), json!({}));
                b
            }
        };
        assert_eq!(b.status(CUT).await, "activated", "{stop:?}");
        assert_eq!(
            facts(&b.conn(), "pub-s1"),
            [(0, "in_flight".into(), Some(stage.clone())), applied(1)]
        );
        assert_eq!(facts(&b.conn(), "pub-s2"), [waiting(0), applied(1)]);
        for (session, body) in BOTH.iter().zip(&staged) {
            assert_eq!(b.gate(session), Ok(()), "{stop:?}");
            assert_eq!(b.entry(session).unwrap().baseline.as_ref(), Some(body));
            assert_eq!(&a.fingerprint(session).digest, body);
        }
        assert_ne!(b.fingerprint("s1").digest, staged[0], "the turn changed s1");
        assert_eq!(b.op("activate", CUT, &BOTH).await.unwrap(), json!({}));
    }
}

/// After a move is activated, an ordinary turn of the session writes its
/// state in `mode3.db` and changes its rows. A restart keeps both: the cut
/// is finished, so no install step runs again.
#[tokio::test]
async fn a_restart_after_an_activated_move_keeps_what_the_next_turn_wrote() {
    let (a, b) = pair();
    move_session(&a, &b, CUT, "machine-b").await;
    let plan = install::key(CUT, HARNESS, "s1");
    let record = crate::move_batches::record(&b.conn(), &plan).unwrap();
    assert_eq!(record.as_ref().unwrap()["state"], "done");

    b.setup("s1").unwrap();
    b.module.idle(&key("s1")).await.unwrap();
    assert!(
        b.store().load(&key("s1")).is_some(),
        "the turn saved its state"
    );
    b.conn()
        .execute(
            "UPDATE notes SET content = 'written by the turn' WHERE session_id = 's1'",
            [],
        )
        .unwrap();
    let state = b.store().session_rows(&key("s1")).unwrap();
    let rows = b.fingerprint("s1");
    let journal = b.contents();

    let b = b.reboot(true).await;
    assert_eq!(b.store().session_rows(&key("s1")).unwrap(), state);
    assert_eq!(b.fingerprint("s1"), rows);
    assert_eq!(
        crate::move_batches::record(&b.conn(), &plan).unwrap(),
        record
    );
    assert_eq!(b.contents(), journal);
    assert_eq!(b.gate("s1"), Ok(()));
}

/// The journal's moves stay enforced after a restart into a build that
/// does not serve moves: a session released from here is refused
/// `session_moved` naming its holder, a frozen one stays refused
/// `session_moving` with its facts reserved, and an install the last run
/// started is finished at startup. No move request is served.
#[tokio::test]
async fn moves_recorded_with_moves_on_are_enforced_after_a_restart_with_them_off() {
    let (a, b) = machines(&["s1", "s2", "s3"]);
    for session in ["s1", "s2", "s3"] {
        seed(&a.conn(), session, PROJECT);
    }
    a.send_out(CUT, &["s1"]).await;
    a.release(CUT, &["s1"], "machine-b").await;
    a.op("prepare", BACK, &["s2"]).await.unwrap();
    a.send_out(THIRD, &["s3"]).await;
    b.op("import", THIRD, &["s3"]).await.unwrap();
    a.release(THIRD, &["s3"], "machine-b").await;
    let lock = hold_store(&b);
    b.op("activate", THIRD, &["s3"]).await.unwrap_err();
    drop(lock);
    assert_eq!(
        b.moving("s3"),
        Some((THIRD.into(), MovingState::Activating))
    );

    let a = a.reboot(false).await;
    let b = b.reboot(false).await;
    assert!(!a.module.agent_data_enabled() && !b.module.agent_data_enabled());
    let gated = |machine: &Machine, session: &str| match machine.setup(session) {
        Err(ModuleError::Gated(gated)) => (gated.code, gated.detail),
        other => panic!("{session}: {other:?}"),
    };
    assert_eq!(
        gated(&a, "s1"),
        (SESSION_MOVED, Some(json!({"holder": "machine-b"})))
    );
    assert_eq!(
        gated(&a, "s2"),
        (SESSION_MOVING, Some(json!({"cut": BACK})))
    );
    assert_eq!(facts(&a.conn(), "pub-s2"), [reserved(0, BACK), applied(1)]);
    let refused = a.op("abort", BACK, &["s2"]).await.unwrap_err();
    assert_eq!(code(&refused), "unavailable");
    assert_eq!(a.gate("s2"), Err(SESSION_MOVING));

    assert_eq!(b.contents().cuts[THIRD].step, Step::Activated);
    assert_eq!(b.moving("s3"), None);
    assert_eq!(b.gate("s3"), Ok(()));
    assert_eq!(b.fingerprint("s3"), a.fingerprint("s3"));
    assert_eq!(facts(&b.conn(), "pub-s3"), [waiting(0), applied(1)]);
}

/// A crash between two batches of an install leaves the cursor between
/// them and part of the session's summaries in. The restart applies the
/// rest from the cursor: the rows then equal the source's, each once.
#[tokio::test]
async fn a_crash_between_two_install_batches_resumes_from_the_cursor_without_duplicates() {
    const SUMMARIES: i64 = 122;
    let (a, b) = machines(&["s1"]);
    seed(&a.conn(), "s1", PROJECT);
    for sequence in 3..=SUMMARIES {
        a.conn()
            .execute(
                "INSERT INTO compartments(session_id, sequence, start_message, end_message, start_message_id, end_message_id,
                    title, content, p1, importance, created_at, harness)
                 VALUES ('s1', ?1, ?2, ?3, 'm-a', 'm-b', ?4, 'content', 'p1', 60, 100, ?5)",
                params![sequence, sequence * 10, sequence * 10 + 9, format!("summary {sequence}"), HARNESS],
            )
            .unwrap();
    }
    a.send_out(CUT, &["s1"]).await;
    b.op("import", CUT, &["s1"]).await.unwrap();
    a.release(CUT, &["s1"], "machine-b").await;

    let plan = Plan::at("commit agent_data/insert/compartments", 0, Mode::Crash);
    assert!(stopped_at(&plan, b.op("activate", CUT, &["s1"]))
        .await
        .is_none());
    let key = install::key(CUT, HARNESS, "s1");
    let record = crate::move_batches::record(&b.conn(), &key)
        .unwrap()
        .unwrap();
    assert_eq!(record["state"], "applying");
    let next = record["next"].as_u64().unwrap();
    assert!(
        0 < next && next < record["batches"].as_u64().unwrap(),
        "{record}"
    );
    let summaries = |machine: &Machine| {
        count(
            &machine.conn(),
            "SELECT COUNT(*) FROM compartments WHERE session_id = 's1'",
        )
    };
    let installed = summaries(&b);
    assert!(0 < installed && installed < SUMMARIES, "{installed}");
    assert_eq!(b.moving("s1"), Some((CUT.into(), MovingState::Activating)));

    let b = b.reboot(true).await;
    assert_eq!(b.status(CUT).await, "activated");
    assert_eq!(summaries(&b), SUMMARIES);
    assert_eq!(b.fingerprint("s1"), a.fingerprint("s1"));
    for sql in [
        "SELECT COUNT(*) FROM notes WHERE session_id = 's1'",
        "SELECT COUNT(*) FROM session_projects WHERE session_id = 's1'",
        "SELECT COUNT(*) FROM memory_publications WHERE publication_id = 'pub-s1'",
        "SELECT COUNT(*) FROM memory_stage_attempts WHERE publication_id = 'pub-s1'",
        "SELECT COUNT(*) FROM memory_pending_facts WHERE publication_id = 'pub-s1'",
    ] {
        assert_eq!(count(&b.conn(), sql), count(&a.conn(), sql), "{sql}");
    }
    assert_eq!(facts(&b.conn(), "pub-s1"), [waiting(0), applied(1)]);
    assert_eq!(
        count(
            &b.conn(),
            "SELECT COUNT(*) FROM schema_migrations_meta WHERE key LIKE 'mode3_batch:%'"
        ),
        0
    );
}
