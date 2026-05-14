//! OpenAI-compatible embedding endpoint probe + config-variable substitution.
//!
//! Mirrors the Node implementations in
//!   packages/plugin/src/features/magic-context/memory/embedding-probe.ts
//!   packages/plugin/src/config/variable.ts
//!
//! The dashboard and doctor perform the same network probe and classification,
//! so a failure seen in one tool looks the same in the other. Users pick
//! whichever tool they prefer without running into "it works in doctor but
//! fails in the dashboard" surprises.

use std::path::Path;
use std::time::Duration;

use serde::Serialize;

/// Structured probe outcome. Matches the kinds produced by the Node probe so
/// frontend messaging can key off the same categories.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EmbeddingProbeOutcome {
    /// 2xx with a valid `data[0].embedding` float array.
    Ok {
        status: u16,
        dimensions: Option<usize>,
    },
    /// 401 / 403 — credentials rejected.
    AuthFailed {
        status: u16,
        preview: String,
    },
    /// 404 / 405 or 2xx without an embedding body — endpoint doesn't serve
    /// embeddings (wrong URL, or provider doesn't offer the API).
    EndpointUnsupported {
        status: u16,
        preview: String,
    },
    /// Other non-2xx status.
    HttpError {
        status: u16,
        preview: String,
    },
    /// Connection failed, DNS failed, TLS failed, etc.
    NetworkError {
        message: String,
    },
    /// Request took longer than `timeout_ms`.
    Timeout {
        timeout_ms: u64,
    },
    /// Endpoint URL is missing `http://` or `https://` prefix.
    InvalidScheme {
        endpoint: String,
    },
    /// Config contains `{env:VAR}` / `{file:path}` tokens that did not
    /// resolve — the dashboard runs its own process with its own environment,
    /// so env vars set only in the user's shell won't be visible here.
    UnresolvedToken {
        /// Which field carries the token (e.g., "api_key", "endpoint").
        field: String,
        /// The unresolved token (e.g., "{env:EMBED_KEY}"). Safe to surface —
        /// users need to know which var is missing.
        token: String,
    },
}

/// Options passed to the Rust probe. Mirrors the Node `EmbeddingProbeOptions`.
#[derive(Debug, Clone)]
pub struct EmbeddingProbeOptions {
    pub endpoint: String,
    pub model: String,
    pub api_key: Option<String>,
    pub timeout_ms: u64,
}

const MAX_PREVIEW_CHARS: usize = 240;

/// Substitute `{env:VAR}` and `{file:path}` tokens in a single value string.
///
/// The plugin's Node substitution operates on raw config text before JSONC
/// parsing; the dashboard operates on individual already-parsed field values
/// directly from the form. Both semantics are the same: missing env vars
/// resolve to the empty string (we don't know whether the user *wanted* an
/// empty auth header or forgot to export the var), and missing files do the
/// same. We report whether any substitution left a residual token so the
/// probe can classify `{env:X}` residue as an actionable outcome.
///
/// `config_dir` is used to resolve relative `{file:./path}` references. For
/// virtual/unit-test callers pass `None` — `~/...` paths still work.
///
/// Returns `(substituted_value, residual_token)`. If any token failed to
/// resolve, `residual_token` holds the first one (for error reporting) —
/// otherwise `None`.
pub fn substitute_value(raw: &str, config_dir: Option<&Path>) -> (String, Option<String>) {
    let mut out = String::with_capacity(raw.len());
    let mut residual: Option<String> = None;
    let bytes = raw.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        // Look for `{env:` or `{file:` at this position.
        if bytes[i] == b'{' {
            if bytes[i..].starts_with(b"{env:") {
                let start = i + b"{env:".len();
                if let Some(rel_end) = raw[start..].find('}') {
                    let end = start + rel_end;
                    let var_name = raw[start..end].trim();
                    let token = &raw[i..=end]; // includes closing }
                    match std::env::var(var_name) {
                        Ok(val) if !val.is_empty() => {
                            out.push_str(&val);
                        }
                        _ => {
                            // Unresolved — leave the token in place so the
                            // caller can detect it and surface a specific
                            // "export your env var" message.
                            if residual.is_none() {
                                residual = Some(token.to_string());
                            }
                            out.push_str(token);
                        }
                    }
                    i = end + 1;
                    continue;
                }
            } else if bytes[i..].starts_with(b"{file:") {
                let start = i + b"{file:".len();
                if let Some(rel_end) = raw[start..].find('}') {
                    let end = start + rel_end;
                    let raw_path = raw[start..end].trim();
                    let token = &raw[i..=end];
                    match resolve_and_read_file(raw_path, config_dir) {
                        Some(contents) => {
                            // Escape for safe embedding. Because we're
                            // operating on a parsed field (not raw JSON), we
                            // don't need JSON-escape here — the value will be
                            // sent as-is over the wire (e.g., as a bearer
                            // token). Trim for parity with the Node
                            // implementation which trims file contents.
                            out.push_str(contents.trim());
                        }
                        None => {
                            if residual.is_none() {
                                residual = Some(token.to_string());
                            }
                            out.push_str(token);
                        }
                    }
                    i = end + 1;
                    continue;
                }
            }
        }

        // Not a token start — copy byte verbatim. Using bytes keeps this
        // O(n); we reassemble a valid UTF-8 string at the end because
        // tokens never straddle UTF-8 boundaries (they're ASCII-only).
        let ch = raw[i..].chars().next().expect("in-range char");
        out.push(ch);
        i += ch.len_utf8();
    }

    (out, residual)
}

fn resolve_and_read_file(raw_path: &str, config_dir: Option<&Path>) -> Option<String> {
    use std::path::PathBuf;

    let path: PathBuf = if let Some(rest) = raw_path.strip_prefix("~/") {
        let home = dirs::home_dir()?;
        home.join(rest)
    } else if Path::new(raw_path).is_absolute() {
        PathBuf::from(raw_path)
    } else {
        match config_dir {
            Some(dir) => dir.join(raw_path),
            None => PathBuf::from(raw_path),
        }
    };

    if !path.exists() {
        return None;
    }
    std::fs::read_to_string(&path).ok()
}

/// POST `{model, input}` to `${endpoint}/embeddings` and classify the outcome.
pub async fn probe_embedding_endpoint(
    options: EmbeddingProbeOptions,
) -> EmbeddingProbeOutcome {
    let endpoint = options.endpoint.trim().trim_end_matches('/').to_string();
    if endpoint.is_empty()
        || !(endpoint.starts_with("https://") || endpoint.starts_with("http://"))
    {
        return EmbeddingProbeOutcome::InvalidScheme {
            endpoint: options.endpoint.clone(),
        };
    }

    let url = format!("{}/embeddings", endpoint);

    // `.no_proxy()` is deliberate: by default reqwest auto-detects macOS
    // / Windows system proxy settings, which produces a confusing failure
    // mode where `doctor` works (Node's fetch ignores system proxies and
    // only honors HTTP_PROXY/HTTPS_PROXY env vars) but the dashboard
    // tries to route the same localhost URL through whatever the user
    // has configured in System Settings → Network → Proxies. Setting
    // no_proxy() here aligns the dashboard probe with Node's behavior so
    // both surfaces classify the same endpoint the same way. Users who
    // genuinely want to route embedding traffic through a proxy can
    // expose that as an explicit config field later if needed.
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(options.timeout_ms))
        .no_proxy()
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return EmbeddingProbeOutcome::NetworkError {
                message: format!("Failed to create HTTP client: {}", e),
            };
        }
    };

    let body = serde_json::json!({
        "model": options.model,
        "input": "magic-context probe",
    });

    let mut req = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&body);

    if let Some(key) = options.api_key.as_deref() {
        let trimmed = key.trim();
        if !trimmed.is_empty() {
            req = req.header("Authorization", format!("Bearer {}", trimmed));
        }
    }

    let response = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            // reqwest marks timeouts specifically — surface them so the user
            // gets actionable "check endpoint URL / network" wording rather
            // than the generic connection-failed message.
            if e.is_timeout() {
                return EmbeddingProbeOutcome::Timeout {
                    timeout_ms: options.timeout_ms,
                };
            }
            return EmbeddingProbeOutcome::NetworkError {
                // reqwest's Display only renders the top-level message
                // (`error sending request for url (...)`) and drops the
                // underlying cause. Walk the source chain so users see the
                // actual failure (connection refused, DNS, TLS handshake,
                // etc.) instead of just the URL.
                message: format_error_with_causes(&e),
            };
        }
    };

    let status = response.status();
    let status_u16 = status.as_u16();

    if status.is_success() {
        // Parse body and verify shape. OpenRouter, for example, may return
        // 200 with a chat-style body when the embeddings route is not
        // supported — we want to catch that instead of reporting success.
        let body_text = response.text().await.unwrap_or_default();
        let parsed: Result<serde_json::Value, _> = serde_json::from_str(&body_text);
        let preview = truncate_preview(&body_text);
        match parsed {
            Ok(value) => match extract_dimensions(&value) {
                Some(dims) => EmbeddingProbeOutcome::Ok {
                    status: status_u16,
                    dimensions: Some(dims),
                },
                None => EmbeddingProbeOutcome::EndpointUnsupported {
                    status: status_u16,
                    preview,
                },
            },
            Err(_) => {
                // 2xx but non-JSON body — definitely not an embeddings response.
                EmbeddingProbeOutcome::EndpointUnsupported {
                    status: status_u16,
                    preview,
                }
            }
        }
    } else {
        let body_text = response.text().await.unwrap_or_default();
        let preview = truncate_preview(&body_text);
        match status_u16 {
            401 | 403 => EmbeddingProbeOutcome::AuthFailed {
                status: status_u16,
                preview,
            },
            404 | 405 => EmbeddingProbeOutcome::EndpointUnsupported {
                status: status_u16,
                preview,
            },
            _ => EmbeddingProbeOutcome::HttpError {
                status: status_u16,
                preview,
            },
        }
    }
}

fn extract_dimensions(body: &serde_json::Value) -> Option<usize> {
    let data = body.get("data")?.as_array()?;
    let first = data.first()?;
    let embedding = first.get("embedding")?.as_array()?;
    if embedding.is_empty() {
        return None;
    }
    // Defensive: first entry must parse as a finite number.
    let sample = embedding.first()?.as_f64()?;
    if !sample.is_finite() {
        return None;
    }
    Some(embedding.len())
}

/// Walk a reqwest error's source chain so the user sees the underlying
/// cause (`connection refused`, `dns error: failed to lookup ...`,
/// `tls handshake eof`) instead of only the top-level `error sending
/// request for url (...)` message. Limited to 5 levels of depth as a
/// safety bound — reqwest errors typically only carry 1–2 sources.
fn format_error_with_causes(err: &(dyn std::error::Error + 'static)) -> String {
    let mut parts = vec![err.to_string()];
    let mut current = err.source();
    let mut depth = 0;
    while let Some(cause) = current {
        if depth >= 5 {
            break;
        }
        let cause_str = cause.to_string();
        // Skip empty causes and de-duplicate against the immediately
        // preceding part — reqwest occasionally wraps the same message
        // at multiple layers and we'd rather not surface it twice.
        if !cause_str.is_empty() && parts.last().map(|p| p.as_str()) != Some(cause_str.as_str()) {
            parts.push(cause_str);
        }
        current = cause.source();
        depth += 1;
    }
    parts.join(": ")
}

fn truncate_preview(text: &str) -> String {
    // Char-safe truncation so multi-byte bodies don't panic.
    let mut buf = String::with_capacity(MAX_PREVIEW_CHARS.min(text.len()));
    for (i, ch) in text.chars().enumerate() {
        if i >= MAX_PREVIEW_CHARS {
            buf.push('…');
            return buf;
        }
        buf.push(ch);
    }
    buf
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn substitute_leaves_text_without_tokens_untouched() {
        let (out, residual) = substitute_value("plain value", None);
        assert_eq!(out, "plain value");
        assert!(residual.is_none());
    }

    #[test]
    fn substitute_resolves_env_tokens() {
        std::env::set_var("MC_TEST_SUBST_KEY", "resolved-value");
        let (out, residual) = substitute_value("prefix-{env:MC_TEST_SUBST_KEY}-suffix", None);
        assert_eq!(out, "prefix-resolved-value-suffix");
        assert!(residual.is_none());
        std::env::remove_var("MC_TEST_SUBST_KEY");
    }

    #[test]
    fn substitute_reports_unresolved_env_tokens() {
        std::env::remove_var("MC_TEST_NONEXISTENT_VAR_FOR_PROBE");
        let (out, residual) =
            substitute_value("{env:MC_TEST_NONEXISTENT_VAR_FOR_PROBE}", None);
        // Unresolved token is preserved so the caller can detect it; the
        // probe will then surface it as UnresolvedToken.
        assert_eq!(out, "{env:MC_TEST_NONEXISTENT_VAR_FOR_PROBE}");
        assert_eq!(
            residual.as_deref(),
            Some("{env:MC_TEST_NONEXISTENT_VAR_FOR_PROBE}")
        );
    }

    #[test]
    fn substitute_trims_env_var_name_whitespace() {
        std::env::set_var("MC_TEST_SUBST_TRIM", "trimmed");
        let (out, residual) = substitute_value("{env: MC_TEST_SUBST_TRIM }", None);
        assert_eq!(out, "trimmed");
        assert!(residual.is_none());
        std::env::remove_var("MC_TEST_SUBST_TRIM");
    }

    #[test]
    fn substitute_handles_empty_env_value_as_unresolved() {
        std::env::set_var("MC_TEST_EMPTY_VAR", "");
        let (out, residual) = substitute_value("{env:MC_TEST_EMPTY_VAR}", None);
        assert_eq!(out, "{env:MC_TEST_EMPTY_VAR}");
        assert!(residual.is_some());
        std::env::remove_var("MC_TEST_EMPTY_VAR");
    }

    #[test]
    fn substitute_resolves_file_tokens_absolute() {
        let tmp_dir = std::env::temp_dir();
        let tmp_path = tmp_dir.join("mc-embedding-probe-test.txt");
        std::fs::write(&tmp_path, "file-contents-here").unwrap();
        let raw = format!("{{file:{}}}", tmp_path.display());
        let (out, residual) = substitute_value(&raw, None);
        assert_eq!(out, "file-contents-here");
        assert!(residual.is_none());
        std::fs::remove_file(&tmp_path).ok();
    }

    #[test]
    fn substitute_trims_file_contents() {
        let tmp_dir = std::env::temp_dir();
        let tmp_path = tmp_dir.join("mc-embedding-probe-trim-test.txt");
        std::fs::write(&tmp_path, "  whitespace-wrapped  \n").unwrap();
        let raw = format!("{{file:{}}}", tmp_path.display());
        let (out, _) = substitute_value(&raw, None);
        assert_eq!(out, "whitespace-wrapped");
        std::fs::remove_file(&tmp_path).ok();
    }

    #[test]
    fn substitute_reports_missing_files() {
        let (out, residual) = substitute_value("{file:/no/such/file/path.txt}", None);
        assert_eq!(out, "{file:/no/such/file/path.txt}");
        assert_eq!(residual.as_deref(), Some("{file:/no/such/file/path.txt}"));
    }

    #[test]
    fn substitute_handles_multiple_tokens_preserving_order() {
        std::env::set_var("MC_TEST_TOK_A", "A");
        std::env::set_var("MC_TEST_TOK_B", "B");
        let (out, residual) =
            substitute_value("start-{env:MC_TEST_TOK_A}-mid-{env:MC_TEST_TOK_B}-end", None);
        assert_eq!(out, "start-A-mid-B-end");
        assert!(residual.is_none());
        std::env::remove_var("MC_TEST_TOK_A");
        std::env::remove_var("MC_TEST_TOK_B");
    }

    #[test]
    fn extract_dimensions_accepts_valid_embedding() {
        let body = serde_json::json!({
            "data": [
                {
                    "embedding": [0.1, 0.2, 0.3, 0.4, 0.5]
                }
            ]
        });
        assert_eq!(extract_dimensions(&body), Some(5));
    }

    #[test]
    fn extract_dimensions_rejects_chat_style_body() {
        // OpenRouter would return something like this — 200 OK but not an
        // embeddings response. We classify as endpoint_unsupported.
        let body = serde_json::json!({
            "choices": [{
                "message": {"role": "assistant", "content": "hello"}
            }]
        });
        assert!(extract_dimensions(&body).is_none());
    }

    #[test]
    fn extract_dimensions_rejects_empty_array() {
        let body = serde_json::json!({"data": []});
        assert!(extract_dimensions(&body).is_none());
    }

    #[test]
    fn extract_dimensions_rejects_non_numeric_embedding() {
        let body = serde_json::json!({
            "data": [{"embedding": ["not", "a", "number"]}]
        });
        assert!(extract_dimensions(&body).is_none());
    }

    #[test]
    fn truncate_preview_caps_long_bodies() {
        let long_input = "a".repeat(500);
        let preview = truncate_preview(&long_input);
        assert!(preview.ends_with('…'));
        // MAX_PREVIEW_CHARS chars followed by the ellipsis.
        assert_eq!(preview.chars().count(), MAX_PREVIEW_CHARS + 1);
    }

    #[test]
    fn truncate_preview_leaves_short_bodies_intact() {
        let preview = truncate_preview("short");
        assert_eq!(preview, "short");
    }

    // ── format_error_with_causes ──────────────────────────────

    use std::error::Error;
    use std::fmt;

    /// Tiny error with a manually-controlled source chain so we can verify
    /// the formatter walks it correctly without needing reqwest internals.
    #[derive(Debug)]
    struct ChainErr {
        msg: &'static str,
        source: Option<Box<ChainErr>>,
    }
    impl fmt::Display for ChainErr {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str(self.msg)
        }
    }
    impl Error for ChainErr {
        fn source(&self) -> Option<&(dyn Error + 'static)> {
            self.source
                .as_deref()
                .map(|e| e as &(dyn Error + 'static))
        }
    }

    #[test]
    fn format_error_with_causes_joins_chain() {
        let inner = ChainErr {
            msg: "Connection refused (os error 61)",
            source: None,
        };
        let outer = ChainErr {
            msg: "error sending request for url (http://localhost:1234)",
            source: Some(Box::new(inner)),
        };
        let formatted = format_error_with_causes(&outer);
        assert_eq!(
            formatted,
            "error sending request for url (http://localhost:1234): Connection refused (os error 61)"
        );
    }

    #[test]
    fn format_error_with_causes_handles_single_level() {
        let only = ChainErr {
            msg: "standalone failure",
            source: None,
        };
        assert_eq!(format_error_with_causes(&only), "standalone failure");
    }

    #[test]
    fn format_error_with_causes_dedups_repeated_messages() {
        let inner = ChainErr {
            msg: "same message",
            source: None,
        };
        let outer = ChainErr {
            msg: "same message",
            source: Some(Box::new(inner)),
        };
        assert_eq!(format_error_with_causes(&outer), "same message");
    }

    #[tokio::test]
    async fn probe_detects_invalid_scheme() {
        let outcome = probe_embedding_endpoint(EmbeddingProbeOptions {
            endpoint: "example.com/v1".to_string(),
            model: "text-embedding-3-small".to_string(),
            api_key: None,
            timeout_ms: 1000,
        })
        .await;
        assert!(matches!(outcome, EmbeddingProbeOutcome::InvalidScheme { .. }));
    }

    #[tokio::test]
    async fn probe_detects_empty_endpoint() {
        let outcome = probe_embedding_endpoint(EmbeddingProbeOptions {
            endpoint: "".to_string(),
            model: "text-embedding-3-small".to_string(),
            api_key: None,
            timeout_ms: 1000,
        })
        .await;
        assert!(matches!(outcome, EmbeddingProbeOutcome::InvalidScheme { .. }));
    }
}
