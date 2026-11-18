//! Two stores share memories through a real `nats-server`, over the live
//! hub (`mc_module::replica::nats`): JetStream in the `hub` domain, the
//! `HUB_MEMORY` stream made from `cortexkit_bus_naming`'s specification. A
//! create, an edit and a delete travel between them, and they go on
//! exchanging after the server restarts. A second case fills a small copy
//! of the stream to check how the server's refusal is read.
//!
//! Each case is skipped, with the reason printed, when no `nats-server`
//! binary is on PATH.

use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_nats::jetstream;
use async_trait::async_trait;
use cortexkit_bus_naming::federation::{hub_memory_stream, HubStreamSpec};
use mc_module::context_db::ContextDb;
use mc_module::replica::hub::{Hub, HubError};
use mc_module::replica::nats::{Fault, HubStream, JetStream, NatsHub, STREAM_FULL};
use mc_module::replica::seal::{OpenInput, Opened, SealError, SealInput, Sealed, Sealer};
use mc_module::replica::wire::{decode, encode};
use mc_module::replica::Replica;

/// The `nats-server` on PATH, if there is one.
fn nats_server() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join("nats-server"))
        .find(|candidate| candidate.is_file())
}

/// A `nats-server` with JetStream in the `hub` domain, its store in a
/// folder of its own, on a port of its own.
struct Server {
    binary: PathBuf,
    dir: tempfile::TempDir,
    port: u16,
    child: Option<Child>,
}

impl Server {
    fn start(binary: PathBuf) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        std::fs::write(
            dir.path().join("server.conf"),
            format!(
                "listen: \"127.0.0.1:{port}\"\njetstream {{\n  store_dir: \"{}\"\n  domain: hub\n}}\n",
                dir.path().join("js").display()
            ),
        )
        .unwrap();
        let mut server = Self {
            binary,
            dir,
            port,
            child: None,
        };
        server.run();
        server
    }

    /// Start the process and wait until it takes connections.
    fn run(&mut self) {
        let child = Command::new(&self.binary)
            .arg("-c")
            .arg(self.dir.path().join("server.conf"))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        self.child = Some(child);
        let deadline = Instant::now() + Duration::from_secs(20);
        while TcpStream::connect(("127.0.0.1", self.port)).is_err() {
            assert!(Instant::now() < deadline, "nats-server never listened");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    fn url(&self) -> String {
        format!("nats://127.0.0.1:{}", self.port)
    }

    /// A JetStream context in the hub's domain, on a connection of its own
    /// that reconnects for as long as it is needed.
    async fn hub(&self) -> jetstream::Context {
        let client = async_nats::ConnectOptions::new()
            .retry_on_initial_connect()
            .connect(self.url())
            .await
            .unwrap();
        jetstream::with_domain(client, "hub")
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop();
    }
}

/// The stream configuration a hub provisions from `spec`.
fn stream_config(spec: HubStreamSpec) -> jetstream::stream::Config {
    use cortexkit_bus_naming::DiscardPolicy;
    let stream = spec.stream;
    assert!(!stream.work_queue);
    jetstream::stream::Config {
        name: stream.name,
        subjects: stream.subjects,
        storage: jetstream::stream::StorageType::File,
        max_age: stream.max_age,
        max_bytes: stream.max_bytes as i64,
        discard: match stream.discard {
            DiscardPolicy::New => jetstream::stream::DiscardPolicy::New,
            DiscardPolicy::Old => jetstream::stream::DiscardPolicy::Old,
        },
        max_message_size: stream.max_message_size.unwrap_or(-1),
        max_messages_per_subject: stream.max_msgs_per_subject.unwrap_or(-1),
        duplicate_window: stream.duplicate_window.unwrap_or_default(),
        num_replicas: spec.replicas.unwrap_or(1),
        allow_direct: spec.allow_direct,
        allow_rollup: spec.allow_rollup_hdrs,
        deny_delete: spec.deny_delete,
        ..Default::default()
    }
}

/// A seal that keeps the plaintext as it is and names the additional data
/// in the nonce, so opening checks that it is the same. The vault's
/// sealing is tested on its own; this case is about the stream.
struct Plain;

#[async_trait]
impl Sealer for Plain {
    async fn seal_batch(&self, items: &[SealInput]) -> Result<Vec<Sealed>, SealError> {
        Ok(items
            .iter()
            .map(|item| Sealed {
                epoch: 1,
                nonce: encode(&item.aad),
                ciphertext: encode(&item.plaintext),
            })
            .collect())
    }

    async fn open_batch(&self, items: &[OpenInput]) -> Result<Vec<Opened>, SealError> {
        Ok(items
            .iter()
            .map(|item| match decode(&item.ciphertext) {
                Ok(plaintext) if item.nonce == encode(&item.aad) => {
                    Opened::Plaintext(plaintext.into())
                }
                _ => Opened::Refused {
                    code: "not_opened".into(),
                    class: "permanent".into(),
                },
            })
            .collect())
    }
}

/// One computer: its store, and its engine on the live hub.
struct Computer {
    db: Arc<ContextDb>,
    replica: Replica,
    _dir: tempfile::TempDir,
}

impl Computer {
    async fn new(server: &Server, n: u8) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(ContextDb::create(&dir.path().join("context.db")).unwrap());
        let hub = NatsHub::new(Arc::new(JetStream::new(server.hub().await)));
        let replica = Replica::new(
            Arc::clone(&db),
            Arc::new(hub),
            Arc::new(Plain),
            format!("{n:x}").repeat(32),
        );
        Self {
            db,
            replica,
            _dir: dir,
        }
    }

    fn execute(&self, sql: &str, params: &[&dyn rusqlite::ToSql]) {
        self.db
            .with_connection(|conn| conn.execute(sql, params))
            .unwrap();
    }

    fn remember(&self, content: &str) {
        self.execute(
            "INSERT INTO memories (level, owner_id, category, origin_category, content,
                 normalized_hash, first_seen_at, created_at, updated_at, last_seen_at)
             VALUES ('project', 'pj-a', 'swe:architecture', 'ARCHITECTURE', ?1, ?2, 1, 1, 1, 1)",
            &[
                &content,
                &mc_module::memory_writes::normalized_hash(content),
            ],
        );
    }

    fn edit(&self, from: &str, to: &str) {
        self.execute(
            "UPDATE memories SET content = ?2, normalized_hash = ?3 WHERE content = ?1",
            &[&from, &to, &mc_module::memory_writes::normalized_hash(to)],
        );
    }

    fn forget(&self, content: &str) {
        self.execute("DELETE FROM memories WHERE content = ?1", &[&content]);
    }

    /// Every memory's text, in order.
    fn contents(&self) -> Vec<String> {
        self.db.with_connection(|conn| {
            conn.prepare("SELECT content FROM memories ORDER BY content")
                .unwrap()
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap()
        })
    }
}

/// Run both computers' rounds until `done` holds, for at most a minute. A
/// round may fail meanwhile (the server restarting, a consumer made again);
/// the last failure of each is shown if `done` never holds.
async fn exchange(computers: [&Computer; 2], done: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut failures: [Option<String>; 2] = [None, None];
    loop {
        for (computer, failure) in computers.iter().zip(failures.iter_mut()) {
            if let Err(error) = computer.replica.round().await {
                *failure = Some(error);
            }
        }
        if done() {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "the computers never agreed: {:?} / {:?}; last failures {failures:?}",
            computers[0].contents(),
            computers[1].contents()
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_stores_share_a_create_an_edit_and_a_delete_and_go_on_after_a_restart() {
    let Some(binary) = nats_server() else {
        println!("skipped: no nats-server on PATH");
        return;
    };
    let mut server = Server::start(binary);
    server
        .hub()
        .await
        .create_stream(stream_config(hub_memory_stream()))
        .await
        .unwrap();
    let a = Computer::new(&server, 1).await;
    let b = Computer::new(&server, 2).await;

    a.remember("The parser rejects empty input.");
    exchange([&a, &b], || {
        b.contents() == ["The parser rejects empty input."]
    })
    .await;

    b.edit(
        "The parser rejects empty input.",
        "The parser rejects empty and blank input.",
    );
    exchange([&a, &b], || {
        a.contents() == ["The parser rejects empty and blank input."]
    })
    .await;

    a.forget("The parser rejects empty and blank input.");
    exchange([&a, &b], || b.contents().is_empty()).await;

    server.stop();
    server.run();
    b.remember("Releases need one reviewer.");
    exchange([&a, &b], || a.contents() == ["Releases need one reviewer."]).await;
    a.edit(
        "Releases need one reviewer.",
        "Releases need two reviewers.",
    );
    exchange([&a, &b], || {
        b.contents() == ["Releases need two reviewers."]
    })
    .await;
    assert_eq!(a.contents(), b.contents());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_full_stream_is_read_as_full_and_a_message_it_holds_is_still_acknowledged() {
    let Some(binary) = nats_server() else {
        println!("skipped: no nats-server on PATH");
        return;
    };
    let server = Server::start(binary);
    let context = server.hub().await;
    let mut spec = hub_memory_stream();
    spec.stream.max_bytes = 4096;
    context.create_stream(stream_config(spec)).await.unwrap();
    let stream = JetStream::new(context);
    let subject = "ck.fleet.memory.global.all";
    let mut stored = 0;
    let refusal = loop {
        match stream
            .publish(subject, &format!("s.o{stored}@1"), vec![b'x'; 512])
            .await
        {
            Ok(ack) => {
                stored += 1;
                assert_eq!(ack.seq, stored);
                assert!(stored < 100, "the stream never filled");
            }
            Err(fault) => break fault,
        }
    };
    assert!(stored > 0);
    assert!(matches!(refusal, Fault::Full(_)), "{refusal:?}");
    let hub = NatsHub::new(Arc::new(stream));
    assert_eq!(
        hub.publish(subject, "s.o999@1", vec![b'x'; 512]).await,
        Err(HubError(STREAM_FULL.into()))
    );
    let again = hub
        .publish(subject, "s.o0@1", vec![b'x'; 512])
        .await
        .unwrap();
    assert!(again.duplicate && again.seq == 1, "{again:?}");
}
