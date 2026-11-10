//! OpenAI-compatible embedding endpoint probe + literal config-token detection.
//!
//! Mirrors the Node implementations in
//!   packages/plugin/src/features/magic-context/memory/embedding-probe.ts
//!
//! The dashboard intentionally does not expand `{env:...}` or `{file:...}`
//! values before probing a user-provided endpoint: expanding secrets and then
//! sending them to that endpoint would allow one-click exfiltration from the UI.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::{Path, PathBuf};
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
    /// 2xx with an embedding whose width differs from the requested
    /// `dimensions`. The runtime provider rejects such vectors (storing them
    /// would mix vector spaces under one model id), so the probe must not
    /// report success for a configuration the runtime will refuse.
    DimensionsMismatch {
        status: u16,
        requested: u32,
        returned: usize,
    },
    /// 401 / 403 — credentials rejected.
    AuthFailed { status: u16, preview: String },
    /// 404 / 405 or 2xx without an embedding body — endpoint doesn't serve
    /// embeddings (wrong URL, or provider doesn't offer the API).
    EndpointUnsupported { status: u16, preview: String },
    /// Other non-2xx status.
    HttpError { status: u16, preview: String },
    /// Connection failed, DNS failed, TLS failed, etc.
    NetworkError { message: String },
    /// Request took longer than `timeout_ms`.
    Timeout { timeout_ms: u64 },
    /// Endpoint URL is missing or is not HTTPS.
    InvalidScheme { endpoint: String },
    /// Config carries an `{env:VAR}` / `{file:path}` token that could not be
    /// resolved for the test: the env var is not set in this process, or the
    /// referenced file does not exist / is unreadable. The probe expands these
    /// tokens (this is the user-config editor, so the values are the user's own,
    /// exactly what the plugin would load at runtime) but reports unresolved
    /// ones instead of sending a literal `{...}` token to the endpoint.
    UnresolvedToken {
        /// Which field carries the token (e.g., "api_key", "endpoint").
        field: String,
        /// The unresolved token (e.g., "{env:EMBED_KEY}"). Safe to surface —
        /// users need to know which var/file is missing.
        token: String,
    },
    /// An `{file:path}` token resolves into a known-sensitive directory
    /// (SSH keys, AWS/GnuPG credentials, GitHub CLI auth). The probe refuses to
    /// read such a file and send it to the endpoint (an embedding API key is
    /// never legitimately one of these), so this is almost certainly a mistake.
    BlockedSensitiveFile {
        field: String,
        token: String,
        reason: String,
    },
    /// The probe was invoked for a non-user config scope (e.g. a project's
    /// `.cortexkit/magic-context.jsonc`). Project config is untrusted repository
    /// input, so we never expand its `{env:}`/`{file:}` tokens or contact its
    /// endpoint (a malicious repo could otherwise exfiltrate a secret via one
    /// click of "Test Connection"). The runtime also strips embedding
    /// destination fields (endpoint/provider) from project config, so a project
    /// embedding endpoint is inert anyway.
    ScopeNotAllowed { scope: String },
}

/// Options passed to the Rust probe. Mirrors the Node `EmbeddingProbeOptions`.
#[derive(Debug, Clone)]
pub struct EmbeddingProbeOptions {
    pub endpoint: String,
    pub model: String,
    pub api_key: Option<String>,
    /// Optional `input_type` body field — required by some providers (NVIDIA NIM).
    pub input_type: Option<String>,
    /// Optional `truncate` body field (e.g. NVIDIA NIM).
    pub truncate: Option<String>,
    /// Optional `dimensions` body field (Matryoshka output width). When set,
    /// a response of any other width is `DimensionsMismatch`.
    pub dimensions: Option<u32>,
    pub timeout_ms: u64,
}

const MAX_PREVIEW_CHARS: usize = 240;

/// Return the first `{env:VAR}` or `{file:path}` token embedded in a value.
///
/// The dashboard probe treats these tokens as unresolved instead of expanding
/// them. Expanding `{file:...}` or `{env:...}` and then sending the result to a
/// user-configured endpoint would let a malicious project config exfiltrate
/// local secrets through the one-click “Test embedding endpoint” button.
pub fn find_substitution_token(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{'
            && (bytes[i..].starts_with(b"{env:") || bytes[i..].starts_with(b"{file:"))
        {
            if let Some(rel_end) = raw[i..].find('}') {
                return Some(raw[i..=i + rel_end].to_string());
            }
        }
        let ch = raw[i..].chars().next().expect("in-range char");
        i += ch.len_utf8();
    }
    None
}

/// Legacy helper kept for tests and callers that need token detection semantics.
/// It never resolves tokens to local file contents or environment values.
pub fn substitute_value(raw: &str, _config_dir: Option<&Path>) -> (String, Option<String>) {
    (raw.to_string(), find_substitution_token(raw))
}

/// Why a token failed to expand. Maps to a probe outcome at the call site.
#[derive(Debug)]
pub enum TokenExpandError {
    /// `{env:VAR}` unset, or `{file:path}` missing / unreadable.
    Unresolved(String),
    /// `{file:path}` resolved into a known-sensitive directory.
    SensitiveFile { token: String, reason: String },
}

/// Expand every `{env:VAR}` / `{file:path}` token in a single config VALUE,
/// using the same semantics the plugin applies at load time
/// (`packages/plugin/src/config/variable.ts`):
///   - `{env:VAR}` → `std::env::var(VAR)` (trimmed key); unset/empty → Unresolved
///   - `{file:~/p}` → contents of `$HOME/p` (trimmed)
///   - `{file:/abs}` → contents of `/abs`
///   - `{file:rel}` → resolved against `config_dir`
///
/// This is safe to do here even though the same expansion is refused for
/// untrusted PROJECT configs: the dashboard's embedding fields come from the
/// USER-level config editor, so the values are the user's own; expanding them
/// to test the endpoint is exactly what the plugin does for real at runtime.
/// `{file:}` tokens that resolve into credential directories are still refused.
pub fn expand_config_value(value: &str, config_dir: &Path) -> Result<String, TokenExpandError> {
    let mut out = String::new();
    let mut rest = value;
    loop {
        let Some(token) = find_substitution_token(rest) else {
            out.push_str(rest);
            return Ok(out);
        };
        let idx = rest
            .find(&token)
            .expect("token was located by find_substitution_token");
        out.push_str(&rest[..idx]);
        out.push_str(&resolve_token(&token, config_dir)?);
        rest = &rest[idx + token.len()..];
    }
}

fn resolve_token(token: &str, config_dir: &Path) -> Result<String, TokenExpandError> {
    if let Some(var) = token
        .strip_prefix("{env:")
        .and_then(|s| s.strip_suffix('}'))
    {
        let name = var.trim();
        return match std::env::var(name) {
            Ok(v) if !v.is_empty() => Ok(v),
            _ => Err(TokenExpandError::Unresolved(token.to_string())),
        };
    }
    if let Some(path) = token
        .strip_prefix("{file:")
        .and_then(|s| s.strip_suffix('}'))
    {
        let raw = path.trim();
        let resolved: PathBuf = if let Some(rel) = raw.strip_prefix("~/") {
            match dirs::home_dir() {
                Some(home) => home.join(rel),
                None => return Err(TokenExpandError::Unresolved(token.to_string())),
            }
        } else if Path::new(raw).is_absolute() {
            PathBuf::from(raw)
        } else {
            config_dir.join(raw)
        };

        // Sensitive-dir block must survive `..` traversal AND symlinks:
        //  1. Lexical normalize collapses `~/.config/../.ssh/id_rsa` to
        //     `~/.ssh/id_rsa` WITHOUT touching the filesystem, so the block
        //     fires even when the file does not exist.
        //  2. Canonicalize (when the file exists) resolves symlinks, so a file
        //     OUTSIDE a credential dir that symlinks INTO one is also caught,
        //     and we then read the canonical path to close the symlink-swap
        //     window.
        let normalized = lexically_normalize(&resolved);
        if let Some(reason) = sensitive_file_reason(&normalized) {
            return Err(TokenExpandError::SensitiveFile {
                token: token.to_string(),
                reason,
            });
        }
        let canonical = std::fs::canonicalize(&resolved).ok();
        if let Some(canon) = &canonical {
            if let Some(reason) = sensitive_file_reason(canon) {
                return Err(TokenExpandError::SensitiveFile {
                    token: token.to_string(),
                    reason,
                });
            }
        }
        let read_path = canonical.unwrap_or(normalized);
        return match std::fs::read_to_string(&read_path) {
            Ok(contents) => Ok(contents.trim().to_string()),
            Err(_) => Err(TokenExpandError::Unresolved(token.to_string())),
        };
    }
    // Not an env/file token (shouldn't happen; find_substitution_token only
    // returns these two), leave it literal.
    Ok(token.to_string())
}

/// Collapse `.` and `..` segments lexically (no filesystem access, unlike
/// `canonicalize`), so the sensitive-dir block can't be bypassed with a
/// traversal like `~/.config/../.ssh/id_rsa` even when the file doesn't exist.
/// A leading `..` (escaping the base) is dropped rather than allowed to walk
/// above root. Symlinks are NOT resolved here; the caller additionally
/// canonicalizes when the file exists to catch symlink-into-credential-dir.
fn lexically_normalize(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                // Pop a normal segment; never pop a root/prefix.
                if matches!(out.components().next_back(), Some(Component::Normal(_))) {
                    out.pop();
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Short human label when `path` sits inside a known credential directory, else
/// None. Mirrors the warn list in the Node `variable.ts`; the dashboard probe
/// BLOCKS rather than warns, since reading these into an embedding test is never
/// legitimate.
fn sensitive_file_reason(path: &Path) -> Option<String> {
    let home = dirs::home_dir()?;
    let candidates = [
        (home.join(".ssh"), "SSH keys"),
        (home.join(".aws"), "AWS credentials"),
        (home.join(".gnupg"), "GnuPG keyring"),
        (home.join(".config").join("gh"), "GitHub CLI auth"),
    ];
    for (dir, label) in candidates {
        if path == dir || path.starts_with(&dir) {
            return Some(label.to_string());
        }
    }
    None
}

/// POST `{model, input}` to `${endpoint}/embeddings` and classify the outcome.
pub async fn probe_embedding_endpoint(options: EmbeddingProbeOptions) -> EmbeddingProbeOutcome {
    let validated = match validate_probe_endpoint(&options.endpoint).await {
        Ok(endpoint) => endpoint,
        Err(outcome) => return outcome,
    };
    let url = format!("{}/embeddings", validated.endpoint);

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
        // Pin reqwest to the public addresses we already validated so DNS
        // cannot re-resolve the hostname to a private or metadata address after
        // the SSRF guard has passed.
        .resolve_to_addrs(&validated.host, &validated.addrs)
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return EmbeddingProbeOutcome::NetworkError {
                message: format!("Failed to create HTTP client: {}", e),
            };
        }
    };

    let mut body = serde_json::json!({
        "model": options.model,
        "input": "magic-context probe",
    });
    // Optional provider-specific fields (e.g. NVIDIA NIM requires input_type).
    // Added only when set so standard OpenAI endpoints are unaffected.
    if let Some(map) = body.as_object_mut() {
        if let Some(input_type) = options
            .input_type
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            map.insert(
                "input_type".to_string(),
                serde_json::Value::String(input_type.to_string()),
            );
        }
        if let Some(truncate) = options
            .truncate
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            map.insert(
                "truncate".to_string(),
                serde_json::Value::String(truncate.to_string()),
            );
        }
        // Standard OpenAI field (text-embedding-3-*, Matryoshka models such as
        // Qwen3-Embedding). Sent only when configured so the probe exercises the
        // same vector space the runtime will request.
        if let Some(dimensions) = options.dimensions.filter(|d| *d > 0) {
            map.insert(
                "dimensions".to_string(),
                serde_json::Value::Number(dimensions.into()),
            );
        }
    }

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
                Some(dims) => classify_returned_width(status_u16, dims, options.dimensions),
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

struct ValidatedEndpoint {
    endpoint: String,
    host: String,
    addrs: Vec<SocketAddr>,
}

async fn validate_probe_endpoint(
    raw_endpoint: &str,
) -> Result<ValidatedEndpoint, EmbeddingProbeOutcome> {
    let endpoint = raw_endpoint.trim().trim_end_matches('/').to_string();
    let parsed = match reqwest::Url::parse(&endpoint) {
        Ok(url) => url,
        Err(_) => {
            return Err(EmbeddingProbeOutcome::InvalidScheme {
                endpoint: raw_endpoint.to_string(),
            });
        }
    };

    // Allow both http and https. The error message has always said "http:// or
    // https://", and the canonical Node probe (doctor) accepts both; a
    // self-hosted embedding server on plain http://localhost is the single most
    // common local setup, so https-only was wrong and contradicted its own
    // message.
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err(EmbeddingProbeOutcome::InvalidScheme {
            endpoint: raw_endpoint.to_string(),
        });
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(EmbeddingProbeOutcome::NetworkError {
            message: "Embedding endpoint URLs must not include usernames or passwords".to_string(),
        });
    }
    let Some(host) = parsed.host_str().map(str::to_string) else {
        return Err(EmbeddingProbeOutcome::InvalidScheme {
            endpoint: raw_endpoint.to_string(),
        });
    };
    let port = parsed.port_or_known_default().unwrap_or(443);
    let addrs: Vec<SocketAddr> = match tokio::net::lookup_host((host.as_str(), port)).await {
        Ok(iter) => iter.collect(),
        Err(e) => {
            return Err(EmbeddingProbeOutcome::NetworkError {
                message: format!("Failed to resolve embedding endpoint host: {e}"),
            });
        }
    };
    if addrs.is_empty() {
        return Err(EmbeddingProbeOutcome::NetworkError {
            message: "Embedding endpoint host resolved to no addresses".to_string(),
        });
    }
    if let Some(blocked) = addrs.iter().find(|addr| is_disallowed_probe_ip(addr.ip())) {
        return Err(EmbeddingProbeOutcome::NetworkError {
            message: format!(
                "Embedding endpoint host resolves to a private, local, or metadata address ({}) and was blocked",
                blocked.ip()
            ),
        });
    }

    Ok(ValidatedEndpoint {
        endpoint,
        host,
        addrs,
    })
}

fn is_disallowed_probe_ip(ip: IpAddr) -> bool {
    // Cloud instance-metadata is always blocked (the classic SSRF
    // exfiltration target, never a real embedding host) regardless of the
    // range rules below.
    if is_cloud_metadata_ip(ip) {
        return true;
    }
    match ip {
        IpAddr::V4(ip) => is_disallowed_probe_ipv4(ip),
        IpAddr::V6(ip) => is_disallowed_probe_ipv6(ip),
    }
}

/// Known cloud instance-metadata addresses (AWS/GCP/Azure IMDS over IPv4, AWS
/// IMDS over IPv6). Always refused. IPv4 169.254.169.254 is also link-local
/// (blocked anyway), but listing it explicitly keeps the intent obvious.
fn is_cloud_metadata_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.octets() == [169, 254, 169, 254],
        IpAddr::V6(v6) => {
            v6 == Ipv6Addr::new(0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x254)
                || v6
                    .to_ipv4_mapped()
                    .is_some_and(|m| m.octets() == [169, 254, 169, 254])
        }
    }
}

fn is_disallowed_probe_ipv4(ip: Ipv4Addr) -> bool {
    // Loopback + private (10/8, 172.16/12, 192.168/16) are now ALLOWED so a
    // self-hosted embedding server on localhost or a LAN box can be tested
    // (matches doctor). Link-local (169.254/16, covers IMDS), unspecified
    // (0.0.0.0), and the 0.x reserved block stay blocked.
    ip.is_link_local() || ip.is_unspecified() || ip.octets()[0] == 0
}

fn is_disallowed_probe_ipv6(ip: Ipv6Addr) -> bool {
    // Unwrap IPv4-mapped (::ffff:a.b.c.d) so an IPv4 link-local/metadata address
    // can't slip through via its IPv6 form.
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_disallowed_probe_ipv4(v4);
    }
    // Loopback (::1) + ULA (fc00::/7, the IPv6 LAN range) are now ALLOWED. The
    // one AWS IPv6 metadata address inside ULA is caught by is_cloud_metadata_ip
    // above. Link-local (fe80::/10) and unspecified (::) stay blocked.
    ip.is_unspecified() || is_unicast_link_local_ipv6(ip)
}

fn is_unicast_link_local_ipv6(ip: Ipv6Addr) -> bool {
    (ip.segments()[0] & 0xffc0) == 0xfe80
}

/// Classify a well-formed 2xx embedding by its width. With no requested
/// `dimensions` any width is success; with one, only an exact match is —
/// mirroring the runtime provider, which rejects other widths.
fn classify_returned_width(
    status: u16,
    returned: usize,
    requested: Option<u32>,
) -> EmbeddingProbeOutcome {
    match requested.filter(|d| *d > 0) {
        Some(requested) if returned != requested as usize => {
            EmbeddingProbeOutcome::DimensionsMismatch {
                status,
                requested,
                returned,
            }
        }
        _ => EmbeddingProbeOutcome::Ok {
            status,
            dimensions: Some(returned),
        },
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
    fn returned_width_without_requested_dimensions_is_ok() {
        match classify_returned_width(200, 768, None) {
            EmbeddingProbeOutcome::Ok { status, dimensions } => {
                assert_eq!(status, 200);
                assert_eq!(dimensions, Some(768));
            }
            other => panic!("expected Ok, got {other:?}"),
        }
    }

    #[test]
    fn returned_width_matching_requested_dimensions_is_ok() {
        match classify_returned_width(200, 1024, Some(1024)) {
            EmbeddingProbeOutcome::Ok { dimensions, .. } => {
                assert_eq!(dimensions, Some(1024));
            }
            other => panic!("expected Ok, got {other:?}"),
        }
    }

    #[test]
    fn returned_width_differing_from_requested_dimensions_is_mismatch() {
        match classify_returned_width(200, 4096, Some(1024)) {
            EmbeddingProbeOutcome::DimensionsMismatch {
                status,
                requested,
                returned,
            } => {
                assert_eq!(status, 200);
                assert_eq!(requested, 1024);
                assert_eq!(returned, 4096);
            }
            other => panic!("expected DimensionsMismatch, got {other:?}"),
        }
    }

    #[test]
    fn returned_width_with_zero_requested_dimensions_is_ok() {
        assert!(matches!(
            classify_returned_width(200, 768, Some(0)),
            EmbeddingProbeOutcome::Ok { .. }
        ));
    }

    #[test]
    fn substitute_leaves_text_without_tokens_untouched() {
        let (out, residual) = substitute_value("plain value", None);
        assert_eq!(out, "plain value");
        assert!(residual.is_none());
    }

    #[test]
    fn substitute_reports_env_tokens_without_resolving() {
        let mut env = crate::test_env::EnvGuard::new();
        env.set("MC_TEST_SUBST_KEY", "resolved-value");
        let raw = "prefix-{env:MC_TEST_SUBST_KEY}-suffix";
        let (out, residual) = substitute_value(raw, None);
        assert_eq!(out, raw);
        assert_eq!(residual.as_deref(), Some("{env:MC_TEST_SUBST_KEY}"));
        env.remove("MC_TEST_SUBST_KEY");
    }

    #[test]
    fn substitute_reports_unresolved_env_tokens() {
        let mut env = crate::test_env::EnvGuard::new();
        env.remove("MC_TEST_NONEXISTENT_VAR_FOR_PROBE");
        let (out, residual) = substitute_value("{env:MC_TEST_NONEXISTENT_VAR_FOR_PROBE}", None);
        // Tokens are preserved so the caller can refuse to expand them.
        assert_eq!(out, "{env:MC_TEST_NONEXISTENT_VAR_FOR_PROBE}");
        assert_eq!(
            residual.as_deref(),
            Some("{env:MC_TEST_NONEXISTENT_VAR_FOR_PROBE}")
        );
    }

    #[test]
    fn substitute_trims_env_var_name_whitespace() {
        let mut env = crate::test_env::EnvGuard::new();
        env.set("MC_TEST_SUBST_TRIM", "trimmed");
        let raw = "{env: MC_TEST_SUBST_TRIM }";
        let (out, residual) = substitute_value(raw, None);
        assert_eq!(out, raw);
        assert_eq!(residual.as_deref(), Some(raw));
        env.remove("MC_TEST_SUBST_TRIM");
    }

    #[test]
    fn substitute_handles_empty_env_value_as_unresolved() {
        let mut env = crate::test_env::EnvGuard::new();
        env.set("MC_TEST_EMPTY_VAR", "");
        let (out, residual) = substitute_value("{env:MC_TEST_EMPTY_VAR}", None);
        assert_eq!(out, "{env:MC_TEST_EMPTY_VAR}");
        assert_eq!(residual.as_deref(), Some("{env:MC_TEST_EMPTY_VAR}"));
        env.remove("MC_TEST_EMPTY_VAR");
    }

    #[test]
    fn substitute_preserves_file_tokens_without_reading() {
        let tmp_dir = std::env::temp_dir();
        let tmp_path = tmp_dir.join("mc-embedding-probe-test.txt");
        std::fs::write(&tmp_path, "file-contents-here").unwrap();
        let raw = format!("{{file:{}}}", tmp_path.display());
        let (out, residual) = substitute_value(&raw, None);
        assert_eq!(out, raw);
        assert_eq!(residual.as_deref(), Some(raw.as_str()));
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
        let mut env = crate::test_env::EnvGuard::new();
        env.set("MC_TEST_TOK_A", "A");
        env.set("MC_TEST_TOK_B", "B");
        let raw = "start-{env:MC_TEST_TOK_A}-mid-{env:MC_TEST_TOK_B}-end";
        let (out, residual) = substitute_value(raw, None);
        assert_eq!(out, raw);
        assert_eq!(residual.as_deref(), Some("{env:MC_TEST_TOK_A}"));
        env.remove("MC_TEST_TOK_A");
        env.remove("MC_TEST_TOK_B");
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

    #[tokio::test]
    async fn probe_rejects_metadata_endpoint_before_connecting() {
        let outcome = probe_embedding_endpoint(EmbeddingProbeOptions {
            endpoint: "https://169.254.169.254/latest/meta-data".to_string(),
            model: "text-embedding-3-small".to_string(),
            api_key: Some("literal-key".to_string()),
            input_type: None,
            truncate: None,
            dimensions: None,
            timeout_ms: 100,
        })
        .await;
        match outcome {
            EmbeddingProbeOutcome::NetworkError { message } => {
                assert!(message.contains("blocked"), "unexpected message: {message}");
                assert!(
                    message.contains("169.254.169.254"),
                    "unexpected message: {message}"
                );
            }
            other => panic!("expected blocked network error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn probe_allows_loopback_and_attempts_connection() {
        // Loopback is now ALLOWED (self-hosted local embedding servers). With
        // nothing listening on this port the probe attempts the connection and
        // gets a transport error, crucially NOT a pre-connect "blocked"
        // refusal, proving the IP guard no longer rejects loopback.
        let outcome = probe_embedding_endpoint(EmbeddingProbeOptions {
            endpoint: "http://127.0.0.1:4444".to_string(),
            model: "text-embedding-3-small".to_string(),
            api_key: None,
            input_type: None,
            truncate: None,
            dimensions: None,
            timeout_ms: 200,
        })
        .await;
        match outcome {
            EmbeddingProbeOutcome::NetworkError { message } => {
                assert!(
                    !message.contains("blocked"),
                    "loopback must not be blocked pre-connect: {message}"
                );
            }
            EmbeddingProbeOutcome::Timeout { .. } => {}
            other => panic!("expected a connection error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn probe_rejects_non_http_scheme() {
        let outcome = probe_embedding_endpoint(EmbeddingProbeOptions {
            endpoint: "ftp://example.com/v1".to_string(),
            model: "m".to_string(),
            api_key: None,
            input_type: None,
            truncate: None,
            dimensions: None,
            timeout_ms: 100,
        })
        .await;
        assert!(matches!(
            outcome,
            EmbeddingProbeOutcome::InvalidScheme { .. }
        ));
    }

    #[test]
    fn metadata_ip_blocked_v4_and_v6() {
        assert!(is_disallowed_probe_ip("169.254.169.254".parse().unwrap()));
        assert!(is_disallowed_probe_ip("fd00:ec2::254".parse().unwrap()));
    }

    #[test]
    fn loopback_and_private_now_allowed() {
        assert!(!is_disallowed_probe_ip("127.0.0.1".parse().unwrap()));
        assert!(!is_disallowed_probe_ip("192.168.1.50".parse().unwrap()));
        assert!(!is_disallowed_probe_ip("10.0.0.5".parse().unwrap()));
        assert!(!is_disallowed_probe_ip("::1".parse().unwrap()));
        assert!(!is_disallowed_probe_ip("fd12:3456::1".parse().unwrap())); // ULA LAN
    }

    #[test]
    fn unspecified_and_link_local_still_blocked() {
        assert!(is_disallowed_probe_ip("0.0.0.0".parse().unwrap()));
        assert!(is_disallowed_probe_ip("169.254.1.2".parse().unwrap())); // link-local
        assert!(is_disallowed_probe_ip("::".parse().unwrap()));
        assert!(is_disallowed_probe_ip("fe80::1".parse().unwrap())); // v6 link-local
    }

    #[test]
    fn expand_resolves_env_and_file_tokens() {
        let mut env = crate::test_env::EnvGuard::new();
        env.set("MC_TEST_EXPAND_KEY", "sk-resolved");
        let dir = std::env::temp_dir();
        assert_eq!(
            expand_config_value("{env:MC_TEST_EXPAND_KEY}", &dir).ok(),
            Some("sk-resolved".to_string())
        );
        env.remove("MC_TEST_EXPAND_KEY");

        let file = dir.join("mc-expand-probe-key.txt");
        std::fs::write(&file, "  sk-from-file\n").unwrap();
        let token = format!("{{file:{}}}", file.display());
        assert_eq!(
            expand_config_value(&token, &dir).ok(),
            // file contents are trimmed (the file had leading/trailing whitespace)
            Some("sk-from-file".to_string())
        );
        std::fs::remove_file(&file).ok();
    }

    #[test]
    fn expand_reports_unresolved_env_and_missing_file() {
        let mut env = crate::test_env::EnvGuard::new();
        env.remove("MC_TEST_NO_SUCH_EXPAND_VAR");
        assert!(matches!(
            expand_config_value("{env:MC_TEST_NO_SUCH_EXPAND_VAR}", &std::env::temp_dir()),
            Err(TokenExpandError::Unresolved(_))
        ));
        assert!(matches!(
            expand_config_value("{file:/no/such/probe/file.key}", &std::env::temp_dir()),
            Err(TokenExpandError::Unresolved(_))
        ));
    }

    #[test]
    fn expand_blocks_sensitive_file_paths() {
        let token = "{file:~/.ssh/id_rsa}";
        match expand_config_value(token, &std::env::temp_dir()) {
            Err(TokenExpandError::SensitiveFile { reason, .. }) => {
                assert!(reason.contains("SSH"), "unexpected reason: {reason}");
            }
            other => panic!("expected SensitiveFile block, got {other:?}"),
        }
    }

    #[test]
    fn expand_blocks_sensitive_path_via_dotdot_traversal() {
        // A `..` traversal that lands inside a credential dir must still be
        // blocked even though the file doesn't exist (lexical normalization runs
        // before the sensitive-dir check).
        let token = "{file:~/.config/../.ssh/id_rsa}";
        match expand_config_value(token, &std::env::temp_dir()) {
            Err(TokenExpandError::SensitiveFile { reason, .. }) => {
                assert!(reason.contains("SSH"), "unexpected reason: {reason}");
            }
            other => panic!("expected SensitiveFile block after normalization, got {other:?}"),
        }
    }

    #[test]
    fn lexically_normalize_collapses_dotdot_without_escaping_root() {
        let home = dirs::home_dir().expect("home");
        assert_eq!(
            lexically_normalize(&home.join(".config/../.ssh/id_rsa")),
            home.join(".ssh/id_rsa")
        );
        // Leading `..` segments are dropped, never walking above the first
        // normal segment.
        assert_eq!(
            lexically_normalize(Path::new("/a/../../b")),
            PathBuf::from("/b")
        );
    }

    #[test]
    fn expand_blocks_sensitive_target_via_symlink() {
        // A file OUTSIDE a credential dir that symlinks INTO one must be caught
        // by the canonicalize pass. Skip on platforms/filesystems where symlink
        // creation isn't permitted.
        #[cfg(unix)]
        {
            let home = match dirs::home_dir() {
                Some(h) => h,
                None => return,
            };
            let ssh_target = home.join(".ssh");
            // Only run if ~/.ssh actually exists to point at (avoids creating it).
            if !ssh_target.exists() {
                return;
            }
            let dir = std::env::temp_dir().join(format!("mc-symlink-test-{}", std::process::id()));
            let _ = std::fs::create_dir_all(&dir);
            let link = dir.join("decoy-key");
            let _ = std::fs::remove_file(&link);
            if std::os::unix::fs::symlink(&ssh_target, &link).is_err() {
                let _ = std::fs::remove_dir_all(&dir);
                return;
            }
            let token = format!("{{file:{}/config}}", link.display());
            let outcome = expand_config_value(&token, &std::env::temp_dir());
            let _ = std::fs::remove_file(&link);
            let _ = std::fs::remove_dir_all(&dir);
            assert!(
                matches!(outcome, Err(TokenExpandError::SensitiveFile { .. })),
                "symlink into ~/.ssh must be blocked, got {outcome:?}"
            );
        }
    }

    #[test]
    fn expand_leaves_plain_values_untouched() {
        let dir = std::env::temp_dir();
        assert_eq!(
            expand_config_value("https://api.openai.com/v1", &dir).ok(),
            Some("https://api.openai.com/v1".to_string())
        );
    }

    #[tokio::test]
    async fn probe_rejects_credentials_in_endpoint_url() {
        let outcome = probe_embedding_endpoint(EmbeddingProbeOptions {
            endpoint: "https://user:pass@example.com".to_string(),
            model: "text-embedding-3-small".to_string(),
            api_key: None,
            input_type: None,
            truncate: None,
            dimensions: None,
            timeout_ms: 100,
        })
        .await;
        match outcome {
            EmbeddingProbeOutcome::NetworkError { message } => {
                assert!(
                    message.contains("must not include"),
                    "unexpected message: {message}"
                );
            }
            other => panic!("expected credentials rejection, got {other:?}"),
        }
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
            self.source.as_deref().map(|e| e as &(dyn Error + 'static))
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
            input_type: None,
            truncate: None,
            dimensions: None,
            timeout_ms: 1000,
        })
        .await;
        assert!(matches!(
            outcome,
            EmbeddingProbeOutcome::InvalidScheme { .. }
        ));
    }

    #[tokio::test]
    async fn probe_detects_empty_endpoint() {
        let outcome = probe_embedding_endpoint(EmbeddingProbeOptions {
            endpoint: "".to_string(),
            model: "text-embedding-3-small".to_string(),
            api_key: None,
            input_type: None,
            truncate: None,
            dimensions: None,
            timeout_ms: 1000,
        })
        .await;
        assert!(matches!(
            outcome,
            EmbeddingProbeOutcome::InvalidScheme { .. }
        ));
    }
}
