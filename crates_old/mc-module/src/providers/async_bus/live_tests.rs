//! The bus link against a private nats-server in operator (JWT) mode, with a
//! ck-bus double that mints real user JWTs: nats-server itself ends the
//! connection at each JWT's `exp`, so these tests see the forced reconnect.
//! Skipped, with a line on stderr, when no nats-server is on `PATH` or named
//! by `CK_NATS_SERVER_BIN`.
use super::*;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use nkeys::KeyPair;
use std::sync::atomic::{AtomicUsize, Ordering};

const MODULE: &str = "ckmc-live";
const STREAM: &str = "EVENTS";

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

static JTI: AtomicUsize = AtomicUsize::new(0);

/// A NATS JWT: `claims` with `jti`, `iat`, `iss` and `sub` filled in,
/// signed by `issuer`.
fn jwt(issuer: &KeyPair, subject: &str, mut claims: Value) -> String {
    claims["jti"] = json!(format!("JTI{}", JTI.fetch_add(1, Ordering::Relaxed)));
    claims["iat"] = json!(unix_now());
    claims["iss"] = json!(issuer.public_key());
    claims["sub"] = json!(subject);
    let signing = format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(br#"{"typ":"JWT","alg":"ed25519-nkey"}"#),
        URL_SAFE_NO_PAD.encode(claims.to_string())
    );
    let signature = issuer.sign(signing.as_bytes()).unwrap();
    format!("{signing}.{}", URL_SAFE_NO_PAD.encode(signature))
}

fn user_jwt(account: &KeyPair, user: &str, exp: Option<i64>) -> String {
    let mut claims = json!({"name":"user","nats":{"pub":{},"sub":{},"subs":-1,"data":-1,"payload":-1,"type":"user","version":2}});
    if let Some(exp) = exp {
        claims["exp"] = json!(exp);
    }
    jwt(account, user, claims)
}

fn nats_server() -> Option<PathBuf> {
    if let Some(bin) = std::env::var_os("CK_NATS_SERVER_BIN") {
        return Some(bin.into());
    }
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|dir| dir.join("nats-server"))
        .find(|path| path.is_file())
}

struct Server {
    child: std::process::Child,
    url: String,
    account: Arc<KeyPair>,
    _dir: tempfile::TempDir,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Server {
    /// A throwaway nats-server trusting one operator, with a system account
    /// and one JetStream-enabled account, and the stream and module durable
    /// ck-bus would have provisioned.
    async fn start() -> Option<Self> {
        let Some(bin) = nats_server() else {
            eprintln!("nats-server-absent: bus link live tests skipped");
            return None;
        };
        let dir = tempfile::tempdir().unwrap();
        let operator = KeyPair::new_operator();
        let system = KeyPair::new_account();
        let account = KeyPair::new_account();
        let limits = json!({"subs":-1,"data":-1,"payload":-1,"imports":-1,"exports":-1,"wildcards":true,"conn":-1,"leaf":-1});
        let mut account_limits = limits.clone();
        for key in ["mem_storage", "disk_storage", "streams", "consumer"] {
            account_limits[key] = json!(-1);
        }
        let operator_jwt = jwt(
            &operator,
            &operator.public_key(),
            json!({"name":"op","nats":{"type":"operator","version":2,"system_account":system.public_key()}}),
        );
        let system_jwt = jwt(
            &operator,
            &system.public_key(),
            json!({"name":"SYS","nats":{"limits":limits,"type":"account","version":2}}),
        );
        let account_jwt = jwt(
            &operator,
            &account.public_key(),
            json!({"name":"ACC","nats":{"limits":account_limits,"type":"account","version":2}}),
        );
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let config = format!(
            "listen: \"127.0.0.1:{port}\"\noperator: \"{operator_jwt}\"\nsystem_account: \"{}\"\nresolver: MEMORY\nresolver_preload: {{\n  {}: \"{system_jwt}\"\n  {}: \"{account_jwt}\"\n}}\njetstream: {{ store_dir: \"{}\", max_mem: 64MB, max_file: 64MB }}\n",
            system.public_key(),
            system.public_key(),
            account.public_key(),
            dir.path().join("js").display()
        );
        let config_path = dir.path().join("server.conf");
        std::fs::write(&config_path, config).unwrap();
        let log = std::fs::File::create(dir.path().join("server.log")).unwrap();
        let child = std::process::Command::new(bin)
            .arg("-c")
            .arg(&config_path)
            .stdout(log.try_clone().unwrap())
            .stderr(log)
            .spawn()
            .unwrap();
        let server = Self {
            child,
            url: format!("nats://127.0.0.1:{port}"),
            account: Arc::new(account),
            _dir: dir,
        };
        for _ in 0..100 {
            if tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .is_ok()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let admin = server.admin().await;
        let js = async_nats::jetstream::new(admin.client());
        let stream = js
            .create_stream(async_nats::jetstream::stream::Config {
                name: STREAM.into(),
                subjects: vec!["ev.>".into()],
                storage: async_nats::jetstream::stream::StorageType::Memory,
                ..Default::default()
            })
            .await
            .unwrap();
        stream
            .create_consumer(async_nats::jetstream::consumer::pull::Config {
                durable_name: Some(
                    cortexkit_bus_naming::AccountNames::module_consumer_name(MODULE).unwrap(),
                ),
                ack_policy: async_nats::jetstream::consumer::AckPolicy::Explicit,
                ack_wait: Duration::from_secs(30),
                ..Default::default()
            })
            .await
            .unwrap();
        Some(server)
    }

    /// A connection with a JWT that never expires, standing in for the
    /// runner that publishes notices.
    async fn admin(&self) -> cortexkit_bus_nats::NatsConnection {
        let user = Arc::new(KeyPair::new_user());
        let token = user_jwt(&self.account, &user.public_key(), None);
        let signer = user.clone();
        let options = async_nats::ConnectOptions::with_jwt(token, move |nonce| {
            let signer = signer.clone();
            async move { signer.sign(&nonce).map_err(async_nats::AuthError::new) }
        });
        cortexkit_bus_nats::NatsConnection::connect(
            self.url.as_str(),
            options,
            cortexkit_bus_nats::ConnectConfig::new(user.public_key()).unwrap(),
        )
        .await
        .unwrap()
    }
}

/// A ck-bus double over real keys: issues user JWTs living `lifetime` seconds,
/// re-signs the same key on renewal when `renews`, and signs nonces.
struct LiveIssuer {
    url: String,
    account: Arc<KeyPair>,
    user: KeyPair,
    lifetime: i64,
    renews: bool,
    renewals: AtomicUsize,
    signed_at: Mutex<Vec<Clock>>,
}

impl LiveIssuer {
    fn new(server: &Server, lifetime: i64, renews: bool) -> Self {
        Self {
            url: server.url.clone(),
            account: server.account.clone(),
            user: KeyPair::new_user(),
            lifetime,
            renews,
            renewals: AtomicUsize::new(0),
            signed_at: Mutex::new(Vec::new()),
        }
    }
    fn fresh(&self) -> (String, i64) {
        let exp = unix_now() + self.lifetime;
        (
            user_jwt(&self.account, &self.user.public_key(), Some(exp)),
            exp,
        )
    }
}

#[async_trait]
impl Issuer for LiveIssuer {
    async fn op(&self, method: &str, params: Value) -> Result<Value, IssuerError> {
        // A real ck-bus call yields to the runtime; so does this one.
        tokio::task::yield_now().await;
        match method {
            CREDENTIAL_OP => {
                let (jwt, exp) = self.fresh();
                Ok(
                    json!({"jwt":jwt,"exp":exp,"acct":"live","credential_public":self.user.public_key(),"server_url":self.url}),
                )
            }
            CREDENTIAL_RENEW_OP if self.renews => {
                assert_eq!(params["credential_public"], self.user.public_key());
                self.renewals.fetch_add(1, Ordering::Relaxed);
                let (jwt, exp) = self.fresh();
                Ok(json!({"jwt":jwt,"exp":exp,"credential_public":self.user.public_key()}))
            }
            CREDENTIAL_RENEW_OP => Err(IssuerError::Unreachable("ck-bus stopped".into())),
            NONCE_SIGN_OP => {
                self.signed_at.lock().unwrap().push(Clock::now());
                let nonce = STANDARD
                    .decode(params["nonce_b64"].as_str().unwrap())
                    .unwrap();
                Ok(json!({"signature_b64":STANDARD.encode(self.user.sign(&nonce).unwrap())}))
            }
            other => panic!("unexpected op {other}"),
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_short_lived_credential_renews_across_the_forced_reconnect_without_losing_a_notice() {
    let Some(server) = Server::start().await else {
        return;
    };
    let issuer = Arc::new(LiveIssuer::new(&server, 3, true));
    let link = Link::connect(issuer.clone()).await.unwrap();
    let status = Arc::new(LinkStatus::default());
    let renewal = tokio::spawn(renew_until_retired(
        link.credential.clone(),
        issuer.clone(),
        status.clone(),
    ));
    let stream = LinkStream::new(link.bus.stream(STREAM), link.credential.clone());
    let mut cursor = stream.consumer(DurableOwner::Module(MODULE)).await.unwrap();

    // Notices every 100 ms for 9 s: across three JWT lifetimes, so across at
    // least two expiries and the reconnects nats-server forces at them.
    const NOTICES: usize = 90;
    let published = Arc::new(Mutex::new(BTreeMap::<String, Clock>::new()));
    let record = published.clone();
    let publisher = server.admin().await.stream(STREAM);
    let publishing = tokio::spawn(async move {
        for n in 0..NOTICES {
            let id = format!("n{n}");
            record.lock().unwrap().insert(id.clone(), Clock::now());
            let _receipt = publisher
                .publish(
                    "ev.notice",
                    &id,
                    ContentDigest::of_bytes(id.as_bytes()),
                    Headers::new(),
                )
                .await
                .unwrap();
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    });

    let mut seen = BTreeMap::<String, (usize, Duration)>::new();
    let deadline = Clock::now() + Duration::from_secs(60);
    while seen.len() < NOTICES && Clock::now() < deadline {
        match cursor.next().await {
            Ok(Some(delivery)) => {
                let id = delivery.message.id.clone();
                let sent = published.lock().unwrap()[&id];
                let entry = seen.entry(id).or_insert((0, sent.elapsed()));
                entry.0 += 1;
                cursor.ack().await.unwrap();
            }
            Ok(None) => {}
            Err(error) => panic!("the reader stopped: {error}"),
        }
    }
    publishing.await.unwrap();
    renewal.abort();

    let missing: Vec<_> = published
        .lock()
        .unwrap()
        .keys()
        .filter(|id| !seen.contains_key(*id))
        .cloned()
        .collect();
    assert!(
        missing.is_empty(),
        "notices lost across renewal: {missing:?}"
    );
    let twice: Vec<_> = seen.iter().filter(|(_, (n, _))| *n > 1).collect();
    assert!(twice.is_empty(), "notices delivered twice: {twice:?}");
    let renewals = issuer.renewals.load(Ordering::Relaxed);
    let connects = issuer.signed_at.lock().unwrap().len();
    assert!(renewals >= 2, "{renewals} renewals");
    assert!(
        connects >= 3,
        "nats-server forced {} reconnects",
        connects - 1
    );
    let slowest = seen.values().map(|(_, latency)| *latency).max().unwrap();
    eprintln!(
        "bus link live: {NOTICES} notices, {renewals} renewals, {} forced reconnects, slowest delivery {slowest:?}",
        connects - 1
    );
    // A pull lost to a reconnect would show as a delivery delayed by the
    // 30 s ack wait; the reader's own pull lasts at most 2 s plus the
    // library's 5 s grace.
    assert!(
        slowest < Duration::from_secs(8),
        "slowest delivery {slowest:?}"
    );
    assert!(link.credential.retired().is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_expired_credential_does_not_reconnect_in_a_tight_loop() {
    let Some(server) = Server::start().await else {
        return;
    };
    let issuer = Arc::new(LiveIssuer::new(&server, 2, false));
    let link = Link::connect(issuer.clone()).await.unwrap();
    let expires = link.credential.expires();
    let status = Arc::new(LinkStatus::default());
    let renewal = tokio::spawn(renew_until_retired(
        link.credential.clone(),
        issuer.clone(),
        status.clone(),
    ));
    let stream = LinkStream::new(link.bus.stream(STREAM), link.credential.clone());
    let mut cursor = stream.consumer(DurableOwner::Module(MODULE)).await.unwrap();
    let error = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            if let Err(error) = cursor.next().await {
                return error;
            }
        }
    })
    .await
    .expect("the reader stops once the credential expired unrenewed");
    assert!(
        error.to_string().contains("expired before renewal"),
        "{error}"
    );
    assert!(renewal.await.is_ok());
    assert_eq!(status.state(), LinkState::CredentialExpired);

    // Watch the dead connection's reconnect loop for eight seconds.
    let before = link.credential.auth_attempts.load(Ordering::Relaxed);
    tokio::time::sleep(Duration::from_secs(8)).await;
    let attempts = link.credential.auth_attempts.load(Ordering::Relaxed) - before;
    let signed_after_exp = issuer
        .signed_at
        .lock()
        .unwrap()
        .iter()
        .filter(|at| **at >= expires)
        .count();
    eprintln!("bus link live: {attempts} reconnect attempts in 8 s after expiry");
    assert_eq!(
        signed_after_exp, 0,
        "ck-bus signed a connect for an expired JWT"
    );
    assert!(attempts <= 8, "{attempts} reconnect attempts in 8 s");
    // Every connect since the first, counted over the whole test: a client that
    // retried without delay would spend its 60 attempts at once.
    let total = link.credential.auth_attempts.load(Ordering::Relaxed);
    assert!(total <= 12, "{total} connects in all");
}
