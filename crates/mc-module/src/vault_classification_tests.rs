use super::*;
use cortexkit_claustrum_client::{decode_credential_reply, decode_wire_error};
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};

struct VaultAnswers {
    reads: AtomicUsize,
    error: CredentialResolverError,
    starts_with_key: bool,
}

#[async_trait::async_trait]
impl Source for VaultAnswers {
    async fn read(&self, _: &str) -> Result<Credential, ReadError> {
        let first = self.reads.fetch_add(1, Ordering::Relaxed) == 0;
        if first && self.starts_with_key {
            return Ok(Credential {
                secret: Zeroizing::new("test-key".into()),
                version: "1".into(),
            });
        }
        Err(classify(&self.error))
    }

    async fn report_auth_failure(&self, _: &str, _: &str, _: u16) -> Result<(), ReadError> {
        panic!("no provider request was rejected")
    }
}

const ID: &str = "apikey:test";

fn target_errors() -> [CredentialResolverError; 2] {
    [
        decode_wire_error(br#"{"code":"unknown_module","message":"vault not running"}"#),
        decode_wire_error(br#"{"code":"target_unavailable","message":"vault stopped","detail":{"expected_back":false}}"#),
    ]
}

fn refusals() -> [CredentialResolverError; 2] {
    [
        decode_credential_reply(json!({"result":{"error":{"code":"not_found"}}})).unwrap_err(),
        decode_wire_error(br#"{"code":"invalid_params","message":"bad request"}"#),
    ]
}

#[tokio::test(start_paused = true)]
async fn unavailable_vault_preserves_held_key_and_uses_backoff() {
    for error in target_errors() {
        let source = Arc::new(VaultAnswers {
            reads: AtomicUsize::new(0),
            error,
            starts_with_key: true,
        });
        let vault = Vault::new(source.clone());
        let key = vault.key(ID);
        vault.start();
        tokio::task::yield_now().await;
        assert_eq!(key.current().unwrap().version(), Some("1"));

        for (elapsed, reads) in [(300_000, 2), (999, 2), (1, 3), (1_999, 3), (1, 4)] {
            tokio::time::advance(Duration::from_millis(elapsed)).await;
            tokio::task::yield_now().await;
            assert_eq!(source.reads.load(Ordering::Relaxed), reads);
            assert_eq!(key.current().unwrap().version(), Some("1"));
        }
    }
}

#[tokio::test]
async fn credential_and_request_defect_refusals_withdraw_held_keys() {
    for error in refusals() {
        let source = Arc::new(VaultAnswers {
            reads: AtomicUsize::new(0),
            error,
            starts_with_key: true,
        });
        let key = Vault::new(source).key(ID);
        key.read().await.unwrap();
        assert!(key.current().is_some());
        assert_eq!(key.read().await.unwrap_err().kind, ReadErrorKind::Refused);
        assert!(key.current().is_none());
    }
}

#[tokio::test]
async fn an_initial_vault_error_leaves_requests_without_a_key() {
    for (error, kind) in target_errors()
        .into_iter()
        .map(|error| (error, ReadErrorKind::Unavailable))
        .chain(
            refusals()
                .into_iter()
                .map(|error| (error, ReadErrorKind::Refused)),
        )
    {
        let source = Arc::new(VaultAnswers {
            reads: AtomicUsize::new(0),
            error,
            starts_with_key: false,
        });
        let key = Vault::new(source).key(ID);
        assert_eq!(key.read().await.unwrap_err().kind, kind);
        let result: Keyed<()> = send_with_key(Some(&ApiKey::Vault(key)), |_| async {
            panic!("the request must not be sent without the vault key")
        })
        .await;
        assert!(matches!(result, Keyed::NoKey));
    }
}
