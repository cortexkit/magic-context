use super::*;
use cortexkit_bus_nats::NatsConnectionState;
use cortexkit_bus_trait::WatchEvent;
use std::process::{Command, Stdio};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot, watch};

struct LocalNats {
    child: std::process::Child,
    _dir: tempfile::TempDir,
    addr: std::net::SocketAddr,
}

impl LocalNats {
    async fn start() -> Option<Self> {
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = port.local_addr().unwrap();
        drop(port);
        let dir = tempfile::tempdir().unwrap();
        let child = match Command::new("nats-server")
            .args([
                "-js",
                "-a",
                "127.0.0.1",
                "-p",
                &addr.port().to_string(),
                "-sd",
            ])
            .arg(dir.path())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(child) => child,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                assert!(
                    std::env::var_os("MC_REQUIRE_NATS_SERVER").is_none(),
                    "nats-server is required by MC_REQUIRE_NATS_SERVER; install NATS Server v2.15.0 from https://github.com/nats-io/nats-server/releases/tag/v2.15.0 and add it to PATH"
                );
                eprintln!("skipped: nats-server is not on PATH");
                return None;
            }
            Err(error) => panic!("could not start nats-server: {error}"),
        };
        let server = Self {
            child,
            _dir: dir,
            addr,
        };
        tokio::time::timeout(Duration::from_secs(5), async {
            while TcpStream::connect(addr).await.is_err() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("nats-server listened");
        Some(server)
    }
}

impl Drop for LocalNats {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct LocalCredential {
    first: Mutex<Option<Credential>>,
    repeat: Credential,
}

#[async_trait]
impl CredentialProvider for LocalCredential {
    async fn issue(&self) -> Result<Credential, String> {
        Ok(self
            .first
            .lock()
            .unwrap()
            .take()
            .unwrap_or_else(|| self.repeat.clone()))
    }

    async fn renewal(&self, credential: &Credential) -> Result<Renewal, String> {
        Ok(Renewal {
            jwt: "fresh-fixture-token".to_owned().into(),
            exp: now_ms() / 1000 + 900,
            credential_public: credential.credential_public.clone(),
            user_jwt_id: "renewed".into(),
            spawn_generation: credential.spawn_generation,
            credential_epoch: credential.credential_epoch,
        })
    }
}

impl NonceSigner for LocalCredential {
    fn sign<'a>(&'a self, _: &'a str, _: &'a [u8]) -> SignFuture<'a> {
        Box::pin(async { Ok(vec![0; 64]) })
    }
}

struct LocalSessions {
    provider: Arc<dyn CredentialProvider>,
    production: ProductionSessions,
    stall_next_snapshot: Option<Arc<SnapshotGate>>,
}

#[async_trait]
impl SessionFactory for LocalSessions {
    async fn open(&self) -> Result<BusSession, String> {
        build_session(self.provider.clone(), self.provider.issue().await?).await
    }

    async fn renew(&self, session: &mut BusSession) -> Result<(), String> {
        self.production.renew(session).await?;
        if let Some(gate) = &self.stall_next_snapshot {
            session.registers = Arc::new(GatedRegisters {
                registers: NatsRegisters(session.connection.as_ref().unwrap().clone()),
                gate: gate.clone(),
            });
        }
        Ok(())
    }
}

fn local_bus(addr: std::net::SocketAddr) -> Arc<Bus> {
    local_bus_with_gate(addr, None)
}

fn local_bus_with_gate(
    addr: std::net::SocketAddr,
    stall_next_snapshot: Option<Arc<SnapshotGate>>,
) -> Arc<Bus> {
    local_bus_at(addr, addr, stall_next_snapshot)
}

fn local_bus_at(
    first_addr: std::net::SocketAddr,
    next_addr: std::net::SocketAddr,
    stall_next_snapshot: Option<Arc<SnapshotGate>>,
) -> Arc<Bus> {
    let credential_public = "UTEST".to_owned();
    let repeat = Credential {
        jwt: "original-fixture-token".to_owned().into(),
        exp: now_ms() / 1000 + 900,
        acct: account().account().to_owned(),
        account_public: "fixture-account".into(),
        inbox_prefix: ConnectConfig::new(&credential_public)
            .unwrap()
            .inbox_prefix(),
        server_url: next_addr.to_string(),
        credential_public,
        user_jwt_id: "original".into(),
        spawn_generation: 1,
        credential_epoch: 1,
    };
    let provider = Arc::new(LocalCredential {
        first: Mutex::new(Some(Credential {
            server_url: first_addr.to_string(),
            ..repeat.clone()
        })),
        repeat,
    });
    Arc::new(Bus::with_factory(Arc::new(LocalSessions {
        provider,
        stall_next_snapshot,
        production: ProductionSessions {
            path: std::path::PathBuf::new(),
            runtime: crate::dreamer::runtime::OnRuntime::try_current(),
        },
    })))
}

async fn registry_bucket(server: &LocalNats) -> async_nats::jetstream::kv::Store {
    use crate::entorhinal_changes::{BUCKET, OWNER};
    let client = async_nats::connect(server.addr.to_string()).await.unwrap();
    let bucket = account().module_bucket_name(OWNER, BUCKET).unwrap();
    async_nats::jetstream::new(client)
        .create_key_value(async_nats::jetstream::kv::Config {
            bucket,
            history: 10,
            ..Default::default()
        })
        .await
        .unwrap()
}

async fn enter_renewal_window(
    bus: &Bus,
    addr: std::net::SocketAddr,
) -> watch::Receiver<NatsConnectionState> {
    let mut slot = bus.session.lock().await;
    let old = slot.as_mut().unwrap();
    let state = old.connection.as_ref().unwrap().connection_state();
    let credential = old.credential.as_mut().unwrap();
    credential.exp = now_ms() / 1000 + 299;
    credential.server_url = addr.to_string();
    state
}

async fn at_renewal(
    bus: &Bus,
    addr: std::net::SocketAddr,
) -> (watch::Receiver<NatsConnectionState>, u64) {
    let state = enter_renewal_window(bus, addr).await;
    let (new, generation) = bus.session_with_generation().await.unwrap();
    drop(new);
    (state, generation)
}

async fn closed(state: &mut watch::Receiver<NatsConnectionState>, timeout: Duration) {
    tokio::time::timeout(
        timeout,
        state.wait_for(|state| *state == NatsConnectionState::Closed),
    )
    .await
    .expect("retired connection closed")
    .unwrap();
}

async fn marker_event(events: &mut mpsc::UnboundedReceiver<()>) {
    tokio::time::timeout(Duration::from_secs(3), events.recv())
        .await
        .expect("marker callback")
        .expect("marker task is alive");
}

#[tokio::test]
async fn renewal_retires_the_connection_held_by_a_marker_watch() {
    use crate::entorhinal_changes::{spawn_marker, WatchState, KEY};
    use run_ends::Cursor as _;
    let Some(server) = LocalNats::start().await else {
        return;
    };
    let bucket = registry_bucket(&server).await;
    bucket.put(KEY, b"one".as_slice().into()).await.unwrap();
    let bus = local_bus(server.addr);
    let (change, mut events) = mpsc::unbounded_channel();
    let state = Arc::new(WatchState::default());
    let _task = spawn_marker(bus.clone(), state.clone(), KEY, move || {
        change.send(()).unwrap();
    });
    let fleet_key = "fleet_epoch";
    bucket
        .put(fleet_key, b"one".as_slice().into())
        .await
        .unwrap();
    let fleet = Arc::new(WatchState::default());
    let (epoch_change, mut epochs) = mpsc::unbounded_channel();
    let _fleet_watch = spawn_marker(bus.clone(), fleet.clone(), fleet_key, move || {
        epoch_change.send(()).unwrap();
    });
    let jetstream = run_end_stream(&server).await;
    let mut reader = bind_reader(&bus).await;
    marker_event(&mut events).await;
    marker_event(&mut epochs).await;
    let log = crate::test_log::capture();
    let started = tokio::time::Instant::now();
    let (mut old, generation) = at_renewal(&bus, server.addr).await;
    assert_eq!(generation, 2);
    bucket.put(KEY, b"two".as_slice().into()).await.unwrap();
    bucket
        .put(fleet_key, b"two".as_slice().into())
        .await
        .unwrap();
    let subject = publish_run_end(&jetstream, "handoff").await;
    assert_eq!(reader.next().await.unwrap().unwrap().subject, subject);
    reader.ack().await.unwrap();
    marker_event(&mut events).await;
    marker_event(&mut epochs).await;
    assert!(state.is_up() && fleet.is_up());
    assert_eq!(
        *old.borrow(),
        NatsConnectionState::Connected,
        "users moved before retirement"
    );
    eprintln!(
        "both markers and run-end pull/ack moved in {:?}",
        started.elapsed()
    );
    closed(&mut old, Duration::from_secs(6)).await;
    assert!(state.is_up() && fleet.is_up());
    bucket.put(KEY, b"three".as_slice().into()).await.unwrap();
    bucket
        .put(fleet_key, b"three".as_slice().into())
        .await
        .unwrap();
    marker_event(&mut events).await;
    marker_event(&mut epochs).await;
    assert_eq!(log.count("ck-mc: entorhinal changes:"), 0, "{}", log.text());
}

#[tokio::test]
async fn a_marker_opens_a_fresh_session_by_itself_after_reconnect_exhaustion() {
    use crate::entorhinal_changes::{spawn_marker, WatchState, BUCKET, KEY, OWNER};
    use tokio::io::AsyncWriteExt as _;
    let Some(server) = LocalNats::start().await else {
        return;
    };
    let bucket = registry_bucket(&server).await;
    bucket.put(KEY, b"one".as_slice().into()).await.unwrap();

    let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_addr = proxy.local_addr().unwrap();
    let upstream = server.addr;
    let (cut, cut_first) = oneshot::channel::<()>();
    let (finish_retry, failed_retry) = oneshot::channel::<()>();
    let proxy_task = tokio::spawn(async move {
        let (mut downstream, _) = proxy.accept().await.unwrap();
        let mut upstream = TcpStream::connect(upstream).await.unwrap();
        tokio::select! {
            result = tokio::io::copy_bidirectional(&mut downstream, &mut upstream) => {
                panic!("first connection ended before the forced cut: {result:?}");
            }
            _ = cut_first => {}
        }
        downstream
            .write_all(b"-ERR 'User Authentication Expired'\r\n")
            .await
            .unwrap();
        drop(downstream);
        drop(upstream);
        let (retry, _) = proxy.accept().await.unwrap();
        failed_retry.await.unwrap();
        drop(proxy);
        drop(retry);
    });

    let bus = local_bus_at(proxy_addr, server.addr, None);
    let (change, mut events) = mpsc::unbounded_channel();
    let state = Arc::new(WatchState::default());
    let _task = spawn_marker(bus.clone(), state.clone(), KEY, move || {
        change.send(()).unwrap()
    });
    marker_event(&mut events).await;
    let (mut watch, client) = {
        let session = bus.session().await.unwrap();
        (
            session.watch(OWNER, BUCKET, KEY).await.unwrap(),
            session.connection.as_ref().unwrap().client(),
        )
    };
    assert!(matches!(
        watch.next().await.unwrap(),
        WatchEvent::Snapshot { .. }
    ));
    let mut first = bus
        .session()
        .await
        .unwrap()
        .connection
        .as_ref()
        .unwrap()
        .connection_state();
    cut.send(()).unwrap();
    tokio::time::timeout(
        Duration::from_secs(3),
        first.wait_for(|state| *state == NatsConnectionState::Disconnected),
    )
    .await
    .expect("the first connection observed the disconnect")
    .unwrap();
    let mut generations = bus.generations();
    {
        let pending = watch.next();
        tokio::pin!(pending);
        tokio::select! {
            biased;
            outcome = &mut pending => panic!("watch returned while reconnect was held: {outcome:?}"),
            () = std::future::ready(()) => {}
        }
        finish_retry.send(()).unwrap();
        proxy_task.await.unwrap();
        assert!(tokio::time::timeout(Duration::from_secs(3), client.flush())
            .await
            .expect("the exhausted handler rejects commands")
            .is_err());
        closed(&mut first, Duration::from_secs(15)).await;
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(15), pending)
                .await
                .unwrap(),
            Err(BusError::Unavailable { .. })
        ));
        eprintln!("reconnect exhaustion closed generation 1 and ended its register watch with Unavailable");
    }

    tokio::time::timeout(
        Duration::from_secs(15),
        generations.wait_for(Option::is_none),
    )
    .await
    .expect("the marker forgets its lost session without another user")
    .unwrap();
    assert!(!state.is_up());
    bucket.put(KEY, b"two".as_slice().into()).await.unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(15), events.recv())
            .await
            .unwrap(),
        Some(())
    );
    assert_eq!(generations.borrow().map(|current| current.id), Some(2));
    assert!(
        state.is_up(),
        "the original marker task recovered without a restart"
    );
}

async fn run_end_stream(server: &LocalNats) -> async_nats::jetstream::Context {
    run_end_stream_with_ack_wait(server, Duration::from_secs(30)).await
}

async fn run_end_stream_with_ack_wait(
    server: &LocalNats,
    ack_wait: Duration,
) -> async_nats::jetstream::Context {
    let jetstream =
        async_nats::jetstream::new(async_nats::connect(server.addr.to_string()).await.unwrap());
    let account = account();
    let subjects = run_ends::SUBJECTS.map(|suffix| format!("ck.{}.{suffix}", account.account()));
    let stream = jetstream
        .create_stream(async_nats::jetstream::stream::Config {
            name: account.streams().event.clone(),
            subjects: subjects.to_vec(),
            ..Default::default()
        })
        .await
        .unwrap();
    stream
        .create_consumer(async_nats::jetstream::consumer::pull::Config {
            durable_name: Some(run_ends::DURABLE.to_owned()),
            filter_subjects: subjects.to_vec(),
            ack_wait,
            ..Default::default()
        })
        .await
        .unwrap();
    jetstream
}

async fn publish_run_end(jetstream: &async_nats::jetstream::Context, id: &str) -> String {
    let subject = format!("ck.{}.{}", account().account(), run_ends::SUBJECTS[0]);
    let mut headers = async_nats::HeaderMap::new();
    headers.insert("Nats-Msg-Id", id);
    headers.insert(
        "Ck-Content-Digest",
        ContentDigest::of_bytes(b"").to_string(),
    );
    headers.insert("session_ref", "fixture");
    jetstream
        .publish_with_headers(subject.clone(), headers, Default::default())
        .await
        .unwrap()
        .await
        .unwrap();
    subject
}

async fn bind_reader(bus: &Arc<Bus>) -> RunEndCursor {
    RunEndCursor {
        bus: bus.clone(),
        binding: bind_run_ends(bus).await.unwrap(),
    }
}

#[tokio::test]
async fn the_next_run_end_pull_renews_credentials_in_the_window() {
    use run_ends::Cursor as _;
    let Some(server) = LocalNats::start().await else {
        return;
    };
    let jetstream = run_end_stream(&server).await;
    let bus = local_bus(server.addr);
    let mut reader = bind_reader(&bus).await;
    assert_eq!(reader.binding.generation, 1);
    let _first = enter_renewal_window(&bus, server.addr).await;
    publish_run_end(&jetstream, "renew-by-pull").await;
    assert_eq!(
        reader.next().await.unwrap().unwrap().id.as_deref(),
        Some("renew-by-pull")
    );
    assert_eq!(reader.binding.generation, 2);
    reader.ack().await.unwrap();
}

#[tokio::test]
async fn an_unconfirmed_ack_is_reported_and_the_same_event_is_redelivered() {
    use run_ends::Cursor as _;
    let Some(server) = LocalNats::start().await else {
        return;
    };
    let jetstream = run_end_stream_with_ack_wait(&server, Duration::from_millis(100)).await;
    let bus = local_bus(server.addr);
    let mut reader = bind_reader(&bus).await;
    publish_run_end(&jetstream, "old-delivery").await;
    let original = reader.next().await.unwrap().unwrap();
    assert_eq!(original.id.as_deref(), Some("old-delivery"));
    let (_, generation) = at_renewal(&bus, server.addr).await;
    assert_eq!(generation, 2);
    reader
        .binding
        .connection
        .close(Duration::from_secs(1))
        .await
        .unwrap();
    assert_eq!(reader.ack().await.unwrap_err(), "nats_ack_failed");
    drop(reader);

    // The reader binds again after its outage retry. The server, not a
    // second publish, supplies the old delivery on the new connection.
    let mut reader = bind_reader(&bus).await;
    assert_eq!(reader.binding.generation, 2);
    let redelivery = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let Some(delivery) = reader.next().await.unwrap() {
                break delivery;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the same durable redelivers the unacknowledged event");
    assert_eq!(redelivery.id, original.id);
    assert_eq!(redelivery.subject, original.subject);
    reader.ack().await.unwrap();
}

#[tokio::test]
async fn a_failed_ack_on_the_current_binding_is_an_outage() {
    use run_ends::Cursor as _;
    let Some(server) = LocalNats::start().await else {
        return;
    };
    let jetstream = run_end_stream(&server).await;
    let bus = local_bus(server.addr);
    let mut reader = bind_reader(&bus).await;
    publish_run_end(&jetstream, "lost-ack").await;
    assert!(reader.next().await.unwrap().is_some());
    reader
        .binding
        .connection
        .close(Duration::from_secs(1))
        .await
        .unwrap();
    assert_eq!(reader.ack().await.unwrap_err(), "nats_ack_failed");
    assert_eq!(reader.binding.generation, 1);
}

#[tokio::test]
async fn discarding_the_new_session_leaves_the_old_ack_in_its_grace() {
    use run_ends::Cursor as _;
    let Some(server) = LocalNats::start().await else {
        return;
    };
    let jetstream = run_end_stream(&server).await;
    let bus = local_bus(server.addr);
    let mut reader = bind_reader(&bus).await;
    publish_run_end(&jetstream, "in-hand").await;
    let delivery = reader.next().await.unwrap().unwrap();
    assert_eq!(delivery.id.as_deref(), Some("in-hand"));

    let (mut first, generation) = at_renewal(&bus, server.addr).await;
    assert_eq!(generation, 2);
    let second = bus.session().await.unwrap();
    let holder = second.connection.as_ref().unwrap().clone();
    let mut second_state = holder.connection_state();
    second.discard();

    // Give an incorrectly expedited close a turn to reach the real socket.
    // This observes half a second of the four-second grace before the ack.
    let went_early = tokio::time::timeout(
        Duration::from_millis(500),
        first.wait_for(|state| *state == NatsConnectionState::Closed),
    )
    .await
    .is_ok();
    reader
        .ack()
        .await
        .expect("discarding the next session must not interrupt this ack");
    assert!(!went_early, "the older connection lost its grace");
    let stream = jetstream
        .get_stream(&account().streams().event)
        .await
        .unwrap();
    let consumer: async_nats::jetstream::consumer::PullConsumer =
        stream.get_consumer(run_ends::DURABLE).await.unwrap();
    assert_eq!(
        consumer.get_info().await.unwrap().ack_floor.stream_sequence,
        1
    );

    closed(&mut first, Duration::from_secs(15)).await;
    closed(&mut second_state, Duration::from_secs(15)).await;
    drop(holder);
}

#[derive(Default)]
struct SnapshotGate {
    waiting: tokio::sync::Notify,
    resume: tokio::sync::Notify,
}

struct GatedRegisters {
    registers: NatsRegisters,
    gate: Arc<SnapshotGate>,
}

#[async_trait]
impl Registers for GatedRegisters {
    async fn watch(&self, bucket: &str, key: &str) -> Result<Box<dyn RegisterWatch>, String> {
        self.gate.waiting.notify_one();
        self.gate.resume.notified().await;
        self.registers.watch(bucket, key).await
    }
}

#[tokio::test]
async fn retirement_closes_the_old_connection_even_if_a_marker_cannot_move_yet() {
    use crate::entorhinal_changes::{spawn_marker, WatchState, KEY};
    let Some(server) = LocalNats::start().await else {
        return;
    };
    let bucket = registry_bucket(&server).await;
    bucket.put(KEY, b"one".as_slice().into()).await.unwrap();
    let gate = Arc::new(SnapshotGate::default());
    let bus = local_bus_with_gate(server.addr, Some(gate.clone()));
    let (change, mut events) = mpsc::unbounded_channel();
    let state = Arc::new(WatchState::default());
    let _marker = spawn_marker(bus.clone(), state.clone(), KEY, move || {
        change.send(()).unwrap()
    });
    marker_event(&mut events).await;
    let (mut first, generation) = at_renewal(&bus, server.addr).await;
    assert_eq!(generation, 2);
    tokio::time::timeout(Duration::from_secs(2), gate.waiting.notified())
        .await
        .unwrap();
    assert_eq!(*first.borrow(), NatsConnectionState::Connected);
    assert!(
        !state.is_up(),
        "the replacement has not delivered its snapshot"
    );
    assert_eq!(
        bus.session_with_generation().await.unwrap().1,
        2,
        "a publisher can acquire the new connection before retirement or snapshot"
    );
    // The replacement snapshot must include writes made while its request
    // was stalled.
    bucket.put(KEY, b"two".as_slice().into()).await.unwrap();
    closed(&mut first, Duration::from_secs(6)).await;
    gate.resume.notify_one();
    marker_event(&mut events).await;
    assert!(
        state.is_up(),
        "the same marker task takes over on the replacement"
    );
    bucket.put(KEY, b"three".as_slice().into()).await.unwrap();
    marker_event(&mut events).await;
}

#[tokio::test]
async fn a_failed_pull_on_a_replaced_binding_rebinds_without_an_outage() {
    use run_ends::Cursor as _;
    let Some(server) = LocalNats::start().await else {
        return;
    };
    let jetstream = run_end_stream(&server).await;
    let peer = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let bus = local_bus(peer.local_addr().unwrap());
    let (waiting, entered) = oneshot::channel();
    let (fail_pull, resume) = oneshot::channel();
    let peer = tokio::spawn(run_end_pull_peer(
        peer,
        Vec::new(),
        Some(PausedPull { waiting, resume }),
    ));
    let mut reader = bind_reader(&bus).await;
    assert_eq!(reader.binding.generation, 1);
    {
        let pull = reader.next();
        tokio::pin!(pull);
        tokio::select! {
            biased;
            _ = &mut pull => panic!("the old pull is held by the peer"),
            entered = entered => entered.unwrap(),
        }
        let (_, generation) = at_renewal(&bus, server.addr).await;
        assert_eq!(generation, 2);
        publish_run_end(&jetstream, "after-stale-failure").await;
        fail_pull.send(()).unwrap();
        let event = pull
            .await
            .unwrap()
            .expect("the same pull recovered on generation 2");
        assert_eq!(event.id.as_deref(), Some("after-stale-failure"));
    }
    assert_eq!(reader.binding.generation, 2);
    reader.ack().await.unwrap();
    peer.await.unwrap();
}

#[tokio::test]
async fn a_failed_pull_on_the_current_binding_is_an_outage() {
    use run_ends::Cursor as _;
    let peer = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let bus = local_bus(peer.local_addr().unwrap());
    let (waiting, entered) = oneshot::channel();
    let (fail_pull, resume) = oneshot::channel();
    let peer = tokio::spawn(run_end_pull_peer(
        peer,
        Vec::new(),
        Some(PausedPull { waiting, resume }),
    ));
    let mut reader = bind_reader(&bus).await;
    let pull = reader.next();
    tokio::pin!(pull);
    tokio::select! {
        biased;
        _ = &mut pull => panic!("the old pull is held by the peer"),
        entered = entered => entered.unwrap(),
    }
    fail_pull.send(()).unwrap();
    assert_eq!(pull.await.err().as_deref(), Some("nats_pull_failed"));
    peer.await.unwrap();
}

#[tokio::test]
async fn shutdown_expedites_retirement_without_waiting_for_the_current_guard() {
    let Some(server) = LocalNats::start().await else {
        return;
    };
    let bus = local_bus(server.addr);
    drop(bus.session().await.unwrap());
    let (mut first, generation) = at_renewal(&bus, server.addr).await;
    assert_eq!(generation, 2);
    assert_eq!(*first.borrow(), NatsConnectionState::Connected);
    let current = bus.session().await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), bus.close_retiring())
        .await
        .unwrap();
    assert_eq!(*first.borrow_and_update(), NatsConnectionState::Closed);
    assert!(current.connection.is_some());
}

struct ClosedWatchProbe {
    inner: Box<dyn RegisterWatch>,
    ended: bool,
    polled_after_end: Arc<tokio::sync::Notify>,
}

#[async_trait]
impl RegisterWatch for ClosedWatchProbe {
    async fn next(&mut self) -> cortexkit_bus_trait::BusResult<WatchEvent> {
        if self.ended {
            self.polled_after_end.notify_one();
            // Fail the test without repeatedly polling a permanently ended watch.
            return std::future::pending().await;
        }
        let event = self.inner.next().await;
        self.ended = event.is_err();
        event
    }

    fn has_snapshot(&self) -> bool {
        self.inner.has_snapshot()
    }
}

struct ProbedRegisters(NatsRegisters, Arc<tokio::sync::Notify>);

#[async_trait]
impl Registers for ProbedRegisters {
    async fn watch(&self, bucket: &str, key: &str) -> Result<Box<dyn RegisterWatch>, String> {
        Ok(Box::new(ClosedWatchProbe {
            inner: self.0.watch(bucket, key).await?,
            ended: false,
            polled_after_end: self.1.clone(),
        }))
    }
}

#[tokio::test]
async fn a_closed_marker_with_no_live_replacement_backs_off_instead_of_polling_again() {
    use crate::entorhinal_changes::{spawn_marker, WatchState, BUCKET, KEY, OWNER};
    let Some(server) = LocalNats::start().await else {
        return;
    };
    let bucket = registry_bucket(&server).await;
    bucket.put(KEY, b"one".as_slice().into()).await.unwrap();
    let bus = local_bus(server.addr);
    let mut raw = bus
        .session()
        .await
        .unwrap()
        .watch(OWNER, BUCKET, KEY)
        .await
        .unwrap();
    assert!(matches!(
        raw.next().await.unwrap(),
        WatchEvent::Snapshot { .. }
    ));
    let polled_after_end = Arc::new(tokio::sync::Notify::new());
    {
        let mut slot = bus.session.lock().await;
        let session = slot.as_mut().unwrap();
        session.registers = Arc::new(ProbedRegisters(
            NatsRegisters(session.connection.as_ref().unwrap().clone()),
            polled_after_end.clone(),
        ));
    }
    let (change, mut events) = mpsc::unbounded_channel();
    let state = Arc::new(WatchState::default());
    let _marker = spawn_marker(bus.clone(), state.clone(), KEY, move || {
        change.send(()).unwrap()
    });
    marker_event(&mut events).await;
    let mut first = enter_renewal_window(&bus, server.addr).await;
    let (second, generation) = bus.session_with_generation().await.unwrap();
    assert_eq!(generation, 2);
    // Install and discard the replacement without letting the marker see it.
    second.discard();
    assert_eq!(*bus.generations().borrow(), None);
    closed(&mut first, Duration::from_secs(15)).await;

    assert!(tokio::time::timeout(Duration::from_secs(2), raw.next())
        .await
        .unwrap()
        .is_err());
    tokio::select! {
        biased;
        result = raw.next() => assert!(result.is_err()),
        () = std::future::ready(()) => panic!("expected the ended NATS watch to fail immediately again"),
    }

    bucket.put(KEY, b"two".as_slice().into()).await.unwrap();
    tokio::select! {
        biased;
        () = polled_after_end.notified() => panic!("marker polled the ended watch again"),
        event = tokio::time::timeout(Duration::from_secs(8), events.recv()) => {
            assert_eq!(event.expect("the marker retries and reads the new snapshot"), Some(()));
        }
    }
    assert_eq!(bus.generation(), 3);
    assert!(state.is_up());
}

#[tokio::test]
async fn a_discard_during_the_replacement_snapshot_recovers_after_backoff() {
    use crate::entorhinal_changes::{spawn_marker, WatchState, KEY, RETRY_FIRST};
    let Some(server) = LocalNats::start().await else {
        return;
    };
    let bucket = registry_bucket(&server).await;
    bucket.put(KEY, b"one".as_slice().into()).await.unwrap();
    let gate = Arc::new(SnapshotGate::default());
    let bus = local_bus_with_gate(server.addr, Some(gate.clone()));
    let (change, mut events) = mpsc::unbounded_channel();
    let state = Arc::new(WatchState::default());
    let _marker = spawn_marker(bus.clone(), state.clone(), KEY, move || {
        change.send(()).unwrap()
    });
    marker_event(&mut events).await;
    let log = crate::test_log::capture();
    let (_, generation) = at_renewal(&bus, server.addr).await;
    assert_eq!(generation, 2);
    tokio::time::timeout(Duration::from_secs(2), gate.waiting.notified())
        .await
        .unwrap();

    // The snapshot request is held while a third session is installed and
    // discarded. Opening the watch must not keep that session locked.
    let mut second = enter_renewal_window(&bus, server.addr).await;
    let (third, generation) = bus.session_with_generation().await.unwrap();
    assert_eq!(generation, 3);
    third.discard();
    closed(&mut second, Duration::from_secs(15)).await;
    bucket.put(KEY, b"two".as_slice().into()).await.unwrap();
    let resumed = tokio::time::Instant::now();
    gate.resume.notify_one();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(8), events.recv())
            .await
            .expect("the marker reopens after the failed handoff"),
        Some(())
    );
    assert!(
        resumed.elapsed() >= RETRY_FIRST,
        "a failed snapshot without a replacement should back off"
    );
    assert_eq!(bus.generation(), 4);
    assert!(state.is_up());
    let text = log.text();
    let marker_lines: Vec<_> = text
        .lines()
        .filter(|line| line.contains("ck-mc: entorhinal changes:"))
        .collect();
    assert_eq!(marker_lines.len(), 2, "{text}");
    assert!(
        marker_lines[0].trim_start().starts_with("WARN")
            && marker_lines[0].contains("no watch on the registry marker"),
        "{text}"
    );
    assert!(
        marker_lines[1].trim_start().starts_with("INFO")
            && marker_lines[1].contains("watching the registry marker"),
        "{text}"
    );
}

#[tokio::test]
async fn a_replacement_snapshot_without_the_marker_reports_absence_and_the_returning_value() {
    use crate::entorhinal_changes::{spawn_marker, WatchState, KEY};
    let Some(server) = LocalNats::start().await else {
        return;
    };
    let bucket = registry_bucket(&server).await;
    bucket.put(KEY, b"one".as_slice().into()).await.unwrap();
    let bus = local_bus(server.addr);
    let (change, mut events) = mpsc::unbounded_channel();
    let state = Arc::new(WatchState::default());
    let _marker = spawn_marker(bus.clone(), state.clone(), KEY, move || {
        change.send(()).unwrap()
    });
    marker_event(&mut events).await;

    enter_renewal_window(&bus, server.addr).await;
    let (guard, generation) = bus.session_with_generation().await.unwrap();
    assert_eq!(generation, 2);
    // The marker cannot acquire the replacement session until both writes finish.
    bucket.put(KEY, b"two".as_slice().into()).await.unwrap();
    bucket.delete(KEY).await.unwrap();
    drop(guard);
    marker_event(&mut events).await;
    assert!(state.is_up());
    bucket.put(KEY, b"one".as_slice().into()).await.unwrap();
    marker_event(&mut events).await;
}
