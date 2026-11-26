//! Vault keys through the real configuration loader and the real embedding
//! (and rerank) requests, with a stand-in vault answering scoped reads and a
//! local endpoint that accepts only the keys a test names.

use super::*;
use crate::config::Loader;
use crate::vault::{Credential, ReadError, Secret, Source, Timing, Vault};
use std::collections::HashSet;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const KEY_ID: &str = "apikey:voyage";
const OPUS: &str = "anthropic/claude-opus-5-5";

/// A stand-in vault: answers each scoped read with what the test set, and
/// records the reads and the auth-failure reports it gets.
#[derive(Default)]
struct FakeVault {
    answer: Mutex<Option<Result<(String, String), ReadError>>>,
    reads: Mutex<Vec<String>>,
    reports: Mutex<Vec<(String, String, u16)>>,
}

impl FakeVault {
    fn serving(key: &str, version: &str) -> Arc<Self> {
        let vault = Arc::new(Self::default());
        vault.serve(key, version);
        vault
    }

    fn failing(error: ReadError) -> Arc<Self> {
        let vault = Arc::new(Self::default());
        vault.fail(error);
        vault
    }

    fn serve(&self, key: &str, version: &str) {
        *self.answer.lock().unwrap() = Some(Ok((key.to_owned(), version.to_owned())));
    }

    fn fail(&self, error: ReadError) {
        *self.answer.lock().unwrap() = Some(Err(error));
    }

    fn reads(&self) -> Vec<String> {
        self.reads.lock().unwrap().clone()
    }

    fn reports(&self) -> Vec<(String, String, u16)> {
        self.reports.lock().unwrap().clone()
    }
}

#[async_trait::async_trait]
impl Source for FakeVault {
    async fn read(&self, credential_id: &str) -> Result<Credential, ReadError> {
        self.reads.lock().unwrap().push(credential_id.to_owned());
        match self.answer.lock().unwrap().clone().expect("an answer") {
            Ok((key, version)) => Ok(Credential {
                secret: Secret::new(key),
                version,
            }),
            Err(error) => Err(error),
        }
    }

    async fn report_auth_failure(
        &self,
        credential_id: &str,
        version: &str,
        status: u16,
    ) -> Result<(), ReadError> {
        self.reports
            .lock()
            .unwrap()
            .push((credential_id.to_owned(), version.to_owned(), status));
        Ok(())
    }
}

/// A local endpoint for `/embeddings` and `/rerank` that answers 200 to a
/// bearer key in `accepted` and 401 to any other, and records the
/// `authorization` header of every request.
struct Endpoint {
    url: String,
    seen: Arc<Mutex<Vec<Option<String>>>>,
}

impl Endpoint {
    async fn accepting(accepted: &[&str]) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let accepted: Arc<HashSet<String>> =
            Arc::new(accepted.iter().map(|key| format!("Bearer {key}")).collect());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&seen);
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let (accepted, recorded) = (Arc::clone(&accepted), Arc::clone(&recorded));
                tokio::spawn(async move {
                    let mut bytes = Vec::new();
                    loop {
                        let mut chunk = [0; 8192];
                        let Ok(read) = socket.read(&mut chunk).await else {
                            return;
                        };
                        if read == 0 {
                            return;
                        }
                        bytes.extend_from_slice(&chunk[..read]);
                        let text = String::from_utf8_lossy(&bytes).into_owned();
                        let Some(end) = text.find("\r\n\r\n") else {
                            continue;
                        };
                        let header = |name: &str| {
                            text[..end].lines().find_map(|line| {
                                let (key, value) = line.split_once(':')?;
                                key.eq_ignore_ascii_case(name)
                                    .then(|| value.trim().to_owned())
                            })
                        };
                        let length = header("content-length")
                            .map_or(0, |length| length.parse::<usize>().unwrap());
                        if bytes.len() < end + 4 + length {
                            continue;
                        }
                        let authorization = header("authorization");
                        let rerank = text.starts_with("POST /v1/rerank");
                        bytes.drain(..end + 4 + length);
                        recorded.lock().unwrap().push(authorization.clone());
                        let response = if authorization.is_some_and(|key| accepted.contains(&key)) {
                            let body = if rerank {
                                json!({"results": [{"index": 0, "relevance_score": 0.5}]})
                            } else {
                                json!({"data": [{"embedding": [1, 0]}]})
                            }
                            .to_string();
                            format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                                body.len()
                            )
                        } else {
                            "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n".to_owned()
                        };
                        if socket.write_all(response.as_bytes()).await.is_err() {
                            return;
                        }
                    }
                });
            }
        });
        Self {
            url: format!("http://{address}/v1"),
            seen,
        }
    }

    fn seen(&self) -> Vec<Option<String>> {
        self.seen.lock().unwrap().clone()
    }
}

fn bearer(key: &str) -> Option<String> {
    Some(format!("Bearer {key}"))
}

/// The user's configuration file, with an embedding provider at `url` whose
/// key is `api_key`, and `extra` merged in.
fn user_file(dir: &Path, url: &str, api_key: &str, extra: Value) -> std::path::PathBuf {
    let mut config = json!({"embedding": {
        "provider": "openai-compatible",
        "endpoint": url,
        "model": "voyage-4",
        "api_key": api_key,
    }});
    if let (Some(config), Some(extra)) = (config.as_object_mut(), extra.as_object()) {
        config.extend(extra.clone());
    }
    let path = dir.join("magic-context.jsonc");
    std::fs::write(&path, config.to_string()).unwrap();
    path
}

/// Reads every `refresh`, and retries an unreachable vault after a few
/// milliseconds.
fn timing(refresh: Duration) -> Timing {
    Timing {
        refresh,
        retry_first: Duration::from_millis(10),
        retry_longest: Duration::from_millis(40),
    }
}

/// The record version of the key ck-mc would send now for [`KEY_ID`].
fn held_version(vault: &Vault) -> Option<String> {
    vault
        .key(KEY_ID)
        .current()
        .and_then(|key| key.version().map(str::to_owned))
}

async fn until(what: &str, mut ready: impl FnMut() -> bool) {
    for _ in 0..1000 {
        if ready() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("timed out waiting until {what}");
}

/// The embedding identity of the same provider with a key written in the
/// file: a vault key counts as present whether or not it was read yet.
fn identity_with_written_key(url: &str) -> (String, String) {
    let provider = Provider::from_tiers(
        &json!({"embedding": {"provider": "openai-compatible", "endpoint": url, "model": "voyage-4", "api_key": "written"}}),
        &json!({}),
        Path::new("unused"),
    )
    .unwrap();
    (provider.model_id(), provider.chunk_model_id())
}

#[tokio::test]
async fn a_vault_key_is_read_at_start_and_sent_as_the_bearer() {
    let endpoint = Endpoint::accepting(&["key-one"]).await;
    let dir = tempfile::tempdir().unwrap();
    let source = FakeVault::serving("key-one", "1");
    let vault = Vault::with_timing(source.clone(), timing(Duration::from_secs(3600)));
    let user = user_file(
        dir.path(),
        &endpoint.url,
        "{vault:apikey:voyage}",
        json!({}),
    );
    let loader = Loader::with_user_path(user).with_vault(Arc::clone(&vault));
    // Named by the user's file, the key is read as soon as the vault starts,
    // before any session resolves its settings.
    assert!(source.reads().is_empty());
    vault.start();
    until("the key is read", || held_version(&vault).is_some()).await;
    assert_eq!(source.reads(), [KEY_ID]);

    let provider = loader
        .resolve(None, OPUS, 100_000)
        .embedding
        .expect("provider");
    assert_eq!(provider.embed_query("query").await, Some(vec![1.0, 0.0]));
    assert_eq!(
        provider.embed_documents(&["memory".to_owned()]).await,
        Some(vec![Some(vec![1.0, 0.0])])
    );
    assert_eq!(endpoint.seen(), [bearer("key-one"), bearer("key-one")]);
    assert_eq!(
        (provider.model_id(), provider.chunk_model_id()),
        identity_with_written_key(&endpoint.url)
    );
}

#[tokio::test]
async fn a_key_rotated_in_the_vault_is_sent_after_the_next_scheduled_read() {
    let endpoint = Endpoint::accepting(&["key-one", "key-two"]).await;
    let dir = tempfile::tempdir().unwrap();
    let source = FakeVault::serving("key-one", "1");
    let vault = Vault::with_timing(source.clone(), timing(Duration::from_millis(30)));
    let user = user_file(
        dir.path(),
        &endpoint.url,
        "{vault:apikey:voyage}",
        json!({}),
    );
    let loader = Loader::with_user_path(user).with_vault(Arc::clone(&vault));
    vault.start();
    until("the first version is read", || {
        held_version(&vault).as_deref() == Some("1")
    })
    .await;
    let provider = || loader.resolve(None, OPUS, 100_000).embedding.unwrap();
    assert!(provider()
        .embed_documents(&["a".to_owned()])
        .await
        .is_some());

    // Rotated in place: no 401 tells ck-mc, only its next scheduled read.
    source.serve("key-two", "2");
    until("the rotated version is read", || {
        held_version(&vault).as_deref() == Some("2")
    })
    .await;
    assert!(provider()
        .embed_documents(&["b".to_owned()])
        .await
        .is_some());
    assert_eq!(endpoint.seen(), [bearer("key-one"), bearer("key-two")]);
    assert!(source.reports().is_empty());
}

#[tokio::test]
async fn a_refused_key_is_read_again_and_a_second_refusal_is_reported() {
    let endpoint = Endpoint::accepting(&[]).await;
    let dir = tempfile::tempdir().unwrap();
    let source = FakeVault::serving("key-dead", "7");
    let vault = Vault::with_timing(source.clone(), timing(Duration::from_secs(3600)));
    let user = user_file(
        dir.path(),
        &endpoint.url,
        "{vault:apikey:voyage}",
        json!({}),
    );
    let loader = Loader::with_user_path(user).with_vault(Arc::clone(&vault));
    vault.start();
    until("the key is read", || held_version(&vault).is_some()).await;
    let provider = loader.resolve(None, OPUS, 100_000).embedding.unwrap();

    assert_eq!(provider.embed_query("query").await, None);
    // Sent, refused, read again at once, sent once more, refused again.
    assert_eq!(endpoint.seen(), [bearer("key-dead"), bearer("key-dead")]);
    assert_eq!(source.reports(), [(KEY_ID.to_owned(), "7".to_owned(), 401)]);
    // The start, the read after the first 401, and the read after the report.
    assert_eq!(source.reads().len(), 3);

    // That version is not sent again, nor reported again.
    assert_eq!(held_version(&vault), None);
    assert_eq!(provider.embed_query("query").await, None);
    assert_eq!(endpoint.seen().len(), 2);
    assert_eq!(source.reports().len(), 1);
}

#[tokio::test]
async fn a_401_cured_by_the_fresh_read_is_not_reported() {
    let endpoint = Endpoint::accepting(&["key-two"]).await;
    let dir = tempfile::tempdir().unwrap();
    let source = FakeVault::serving("key-one", "1");
    let vault = Vault::with_timing(source.clone(), timing(Duration::from_secs(3600)));
    let user = user_file(
        dir.path(),
        &endpoint.url,
        "{vault:apikey:voyage}",
        json!({}),
    );
    let loader = Loader::with_user_path(user).with_vault(Arc::clone(&vault));
    vault.start();
    until("the key is read", || held_version(&vault).is_some()).await;
    // Rotated, and the next scheduled read is an hour away.
    source.serve("key-two", "2");
    let provider = loader.resolve(None, OPUS, 100_000).embedding.unwrap();
    assert_eq!(provider.embed_query("query").await, Some(vec![1.0, 0.0]));
    assert_eq!(endpoint.seen(), [bearer("key-one"), bearer("key-two")]);
    assert!(source.reports().is_empty());
    assert_eq!(held_version(&vault).as_deref(), Some("2"));
}

#[tokio::test]
async fn a_vault_down_at_start_fails_requests_like_a_timeout_until_it_answers() {
    let capture = crate::test_log::capture();
    let endpoint = Endpoint::accepting(&["key-one"]).await;
    let dir = tempfile::tempdir().unwrap();
    let source = FakeVault::failing(ReadError::unavailable(
        "unknown_module",
        "unknown_module: no module claustrum",
    ));
    let vault = Vault::with_timing(source.clone(), timing(Duration::from_secs(3600)));
    let user = user_file(
        dir.path(),
        &endpoint.url,
        "{vault:apikey:voyage}",
        json!({}),
    );
    let loader = Loader::with_user_path(user).with_vault(Arc::clone(&vault));
    vault.start();
    until("several reads were tried", || source.reads().len() >= 3).await;

    let provider = loader.resolve(None, OPUS, 100_000).embedding.unwrap();
    // No key yet: the call fails without a request, and the provider's
    // identity is the one stored vectors were written under.
    assert_eq!(provider.embed_query("query").await, None);
    assert!(endpoint.seen().is_empty());
    assert_eq!(
        (provider.model_id(), provider.chunk_model_id()),
        identity_with_written_key(&endpoint.url)
    );

    source.serve("key-one", "1");
    until("the key is read", || held_version(&vault).is_some()).await;
    assert_eq!(provider.embed_query("query").await, Some(vec![1.0, 0.0]));
    assert_eq!(endpoint.seen(), [bearer("key-one")]);
    // Once for the outage however many reads failed, once for the recovery.
    assert_eq!(
        capture
            .text()
            .lines()
            .filter(
                |line| line.contains("ck-mc: the vault could not be read for the API key")
                    && line.contains("credential_id=apikey:voyage")
            )
            .count(),
        1
    );
    assert_eq!(
        capture
            .count("ck-mc: read an API key from the vault credential_id=apikey:voyage version=1"),
        1
    );
}

#[tokio::test]
async fn an_unreachable_vault_keeps_the_key_read_before() {
    let endpoint = Endpoint::accepting(&["key-one"]).await;
    let dir = tempfile::tempdir().unwrap();
    let source = FakeVault::serving("key-one", "1");
    let vault = Vault::with_timing(source.clone(), timing(Duration::from_millis(20)));
    let user = user_file(
        dir.path(),
        &endpoint.url,
        "{vault:apikey:voyage}",
        json!({}),
    );
    let loader = Loader::with_user_path(user).with_vault(Arc::clone(&vault));
    vault.start();
    until("the key is read", || held_version(&vault).is_some()).await;
    source.fail(ReadError::unavailable(
        "credential_transport",
        "connection lost",
    ));
    let reads = source.reads().len();
    until("a refresh failed", || source.reads().len() >= reads + 2).await;
    let provider = loader.resolve(None, OPUS, 100_000).embedding.unwrap();
    assert_eq!(provider.embed_query("query").await, Some(vec![1.0, 0.0]));
    assert_eq!(endpoint.seen(), [bearer("key-one")]);
}

#[tokio::test]
async fn a_refusal_is_a_configuration_problem_logged_once_per_change() {
    let capture = crate::test_log::capture();
    let endpoint = Endpoint::accepting(&["key-one"]).await;
    let dir = tempfile::tempdir().unwrap();
    let source = FakeVault::failing(ReadError::refused(
        "credential_absent",
        "credential_absent: credential service rejected the request: not_found",
    ));
    let vault = Vault::with_timing(source.clone(), timing(Duration::from_millis(10)));
    let user = user_file(
        dir.path(),
        &endpoint.url,
        "{vault:apikey:voyage}",
        json!({}),
    );
    let loader = Loader::with_user_path(user).with_vault(Arc::clone(&vault));
    vault.start();
    until("several reads were refused", || source.reads().len() >= 4).await;
    let provider = loader.resolve(None, OPUS, 100_000).embedding.unwrap();
    assert_eq!(provider.embed_query("query").await, None);
    assert!(endpoint.seen().is_empty());
    let refused = || {
        capture
            .text()
            .lines()
            .filter(|line| {
                line.contains("ck-mc: the vault refused to serve the API key")
                    && line.contains("credential_id=apikey:voyage")
            })
            .count()
    };
    assert_eq!(refused(), 1);

    // Another refusal is a change, and logged once more.
    source.fail(ReadError::refused(
        "credential_auth_required",
        "needs reauth",
    ));
    let reads = source.reads().len();
    until("the new refusal was read", || {
        source.reads().len() >= reads + 3
    })
    .await;
    assert_eq!(refused(), 2);

    // A refusal withdraws a key held before (a revoked grant).
    source.serve("key-one", "1");
    until("the key is read", || held_version(&vault).is_some()).await;
    source.fail(ReadError::refused("credential_absent", "revoked"));
    until("the key is withdrawn", || held_version(&vault).is_none()).await;
    assert_eq!(provider.embed_query("query").await, None);
    assert!(endpoint.seen().is_empty());
}

#[tokio::test]
async fn a_project_file_cannot_name_a_vault_key() {
    let capture = crate::test_log::capture();
    let endpoint = Endpoint::accepting(&["key-one"]).await;
    let dir = tempfile::tempdir().unwrap();
    let source = FakeVault::serving("key-one", "1");
    let vault = Vault::with_timing(source.clone(), timing(Duration::from_secs(3600)));
    let user = user_file(
        dir.path(),
        &endpoint.url,
        "{vault:apikey:voyage}",
        json!({}),
    );
    let project = dir.path().join("project");
    std::fs::create_dir_all(project.join(".cortexkit")).unwrap();
    std::fs::write(
        project.join(".cortexkit/magic-context.jsonc"),
        r#"{"embedding": {"api_key": "{vault:apikey:project-named}"}, "rerank": {"provider": "remote", "api_key": "{vault:apikey:project-named}"}}"#,
    )
    .unwrap();
    let loader = Loader::with_user_path(user).with_vault(Arc::clone(&vault));
    vault.start();
    until("the user's key is read", || held_version(&vault).is_some()).await;

    let settings = loader.resolve(Some(&project), OPUS, 100_000);
    let provider = settings.embedding.unwrap();
    // The project's reference stays the text it wrote, as `{env:}` and
    // `{file:}` do there, and the vault is never asked for it.
    assert_eq!(
        provider.api_key_for_test(),
        Some(&ApiKey::Text(Secret::new(
            "{vault:apikey:project-named}".into()
        )))
    );
    assert_eq!(provider.embed_query("query").await, None);
    assert_eq!(endpoint.seen(), [bearer("{vault:apikey:project-named}")]);
    assert_eq!(source.reads(), [KEY_ID]);
    assert!(source.reports().is_empty());
    assert_eq!(
        capture.count("names a vault credential; only the user's file may, so ck-mc does not read it and sends the setting as written credential_id=apikey:project-named"),
        1
    );
    // A project may not configure the reranker's key at all.
    assert!(!matches!(
        settings.rerank,
        crate::search::rerank::Reranker::Remote(_)
    ));
}

#[tokio::test]
async fn file_and_env_keys_are_read_as_before_and_never_from_the_vault() {
    let endpoint = Endpoint::accepting(&["from-a-file"]).await;
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("voyage.key"), "from-a-file\n").unwrap();
    let source = FakeVault::serving("key-one", "1");
    let vault = Vault::with_timing(source.clone(), timing(Duration::from_secs(3600)));
    let user = user_file(dir.path(), &endpoint.url, "{file:voyage.key}", json!({}));
    let loader = Loader::with_user_path(user).with_vault(Arc::clone(&vault));
    vault.start();
    let provider = loader.resolve(None, OPUS, 100_000).embedding.unwrap();
    assert_eq!(
        provider.api_key_for_test(),
        Some(&ApiKey::Text(Secret::new("from-a-file".into())))
    );
    assert_eq!(provider.embed_query("query").await, Some(vec![1.0, 0.0]));
    assert_eq!(endpoint.seen(), [bearer("from-a-file")]);

    // `PATH` is set wherever the tests run; its value becomes the key.
    let path = std::env::var("PATH").expect("PATH");
    let env_dir = tempfile::tempdir().unwrap();
    let user = user_file(env_dir.path(), &endpoint.url, "{env:PATH}", json!({}));
    let loader = Loader::with_user_path(user).with_vault(Arc::clone(&vault));
    let provider = loader.resolve(None, OPUS, 100_000).embedding.unwrap();
    assert_eq!(
        provider.api_key_for_test(),
        Some(&ApiKey::Text(Secret::new(path.trim().to_owned())))
    );
    assert!(source.reads().is_empty());
}

#[tokio::test]
async fn a_vault_key_serves_the_remote_reranker_and_is_read_again_on_401() {
    let endpoint = Endpoint::accepting(&["key-two"]).await;
    let dir = tempfile::tempdir().unwrap();
    let source = FakeVault::serving("key-one", "1");
    let vault = Vault::with_timing(source.clone(), timing(Duration::from_secs(3600)));
    let user = user_file(
        dir.path(),
        &endpoint.url,
        "{vault:apikey:voyage}",
        json!({"rerank": {"provider": "remote", "endpoint": endpoint.url, "model": "rerank-2", "api_key": "{vault:apikey:voyage}"}}),
    );
    let loader = Loader::with_user_path(user).with_vault(Arc::clone(&vault));
    vault.start();
    until("the key is read", || held_version(&vault).is_some()).await;
    source.serve("key-two", "2");
    let crate::search::rerank::Reranker::Remote(remote) =
        loader.resolve(None, OPUS, 100_000).rerank
    else {
        panic!("a remote reranker");
    };
    let scores = crate::search::rerank::remote_scores(&remote, "query", &["doc".to_owned()]).await;
    assert_eq!(scores.ok(), Some(vec![0.5]));
    assert_eq!(endpoint.seen(), [bearer("key-one"), bearer("key-two")]);
}

#[tokio::test]
async fn the_key_text_never_reaches_a_log_line_an_error_or_debug_output() {
    const SECRET: &str = "sk-vault-secret-6f1d9a";
    let capture = crate::test_log::capture();
    let endpoint = Endpoint::accepting(&[]).await;
    let dir = tempfile::tempdir().unwrap();
    let source = FakeVault::serving(SECRET, "3");
    let vault = Vault::with_timing(source.clone(), timing(Duration::from_millis(15)));
    let user = user_file(
        dir.path(),
        &endpoint.url,
        "{vault:apikey:voyage}",
        json!({"rerank": {"provider": "remote", "endpoint": endpoint.url, "model": "rerank-2", "api_key": "{vault:apikey:voyage}"}}),
    );
    let loader = Loader::with_user_path(user).with_vault(Arc::clone(&vault));
    vault.start();
    until("the key is read", || held_version(&vault).is_some()).await;
    let settings = loader.resolve(None, OPUS, 100_000);
    let provider = settings.embedding.clone().unwrap();
    let mut texts = vec![
        format!("{settings:?}"),
        format!("{provider:?}"),
        format!("{:?}", provider.api_key_for_test()),
        format!("{:?}", vault.key(KEY_ID)),
    ];
    // Refused twice and reported; the reranker refused too.
    assert_eq!(provider.embed_query("query").await, None);
    if let crate::search::rerank::Reranker::Remote(remote) = &settings.rerank {
        let error = crate::search::rerank::remote_scores(remote, "query", &["doc".to_owned()])
            .await
            .unwrap_err();
        texts.push(error.0);
    }
    assert_eq!(source.reports().len(), 1);
    // A newer version, then an unreachable vault, then a refusal.
    source.serve(SECRET, "4");
    until("the new version is read", || {
        held_version(&vault).as_deref() == Some("4")
    })
    .await;
    source.fail(ReadError::unavailable(
        "credential_transport",
        "connection lost",
    ));
    let reads = source.reads().len();
    until("a read failed", || source.reads().len() > reads).await;
    source.fail(ReadError::refused("credential_absent", "not_found"));
    until("the key is withdrawn", || held_version(&vault).is_none()).await;

    let log = capture.text();
    assert!(log.contains("version=3") && log.contains("version=4"));
    assert!(log.contains("refused to serve the API key"));
    texts.push(log);
    for text in texts {
        assert!(!text.contains(SECRET), "the key leaked into: {text}");
    }
}
