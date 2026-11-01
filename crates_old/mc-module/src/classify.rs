//! Zero-tool memory classification producer contract.
//!
//! The host still owns prompt rendering and XML parsing. This module owns the
//! provider-facing role and its fixed generation budget so callers cannot turn
//! this management surface into a generic arbitrary-prompt producer.

use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

/// The only task currently accepted by `dreamer.run_task`.
pub const CLASSIFY_TASK: &str = "classify";
/// Host-rendered prompt bodies are bounded before they reach the provider leg.
pub const MAX_CLASSIFY_PROMPT_BYTES: usize = 256 * 1024;
/// Classifier generation calibration, kept separate from historian calibration.
pub const CLASSIFY_TEMPERATURE: f64 = 0.1;
pub const CLASSIFY_MAX_OUTPUT_TOKENS: u32 = 32_000;
pub const CLASSIFY_AWAIT_TIMEOUT: Duration = Duration::from_secs(600);
pub const CLASSIFY_RECOVERY_TIMEOUT: Duration = Duration::from_secs(60);

/// This is deliberately a zero-tool system role. The host supplies the pool and
/// retains the parser because accepting a caller-selected role would reopen the
/// producer trust boundary.
pub const CLASSIFY_SYSTEM_PROMPT: &str = r#"You are a memory classifier for the magic-context system. You classify project memories by metadata only. You do NOT rewrite, merge, archive, verify, or create memories, and you do NOT read code — you judge each memory from its own text.

### How to score importance (1-100)
Importance decides which memories survive when the injected memory block is over budget: high scores stay in context, low scores drop first. So the score is only useful if it **discriminates** — if most memories land in the same band, you have not classified them, you have just labelled them.

Use judgment, not a formula. Blend:
- **Durability / decay-rate value:** Will this fact still matter weeks from now, across sessions?
- **Operational impact:** Would missing this fact cause wrong code, wasted time, broken workflows, or violated constraints?

Most memories are ordinary working facts — they belong in the middle, not the top. Reserve the high band for the genuinely load-bearing handful a teammate would be sunk without; push routine observations, one-off details, and now-obvious facts down. A "real, true fact" is not automatically important — truth is not importance.

Rough anchors (not quotas — spread naturally within them): transient/obvious observations 1-30, ordinary helpful project facts 40-65, load-bearing rules/architecture/constraints 70-100. A constraint that is a genuine must/never/always rule the project actively depends on floors around 60; but not every memory in a category is load-bearing — a niche, dated, or narrowly-scoped external quirk can sit lower even if it is a "constraint". Score the fact, not the label. If you assigned most of the pool to one band, re-read and differentiate.

### Scope
- `project` — only meaningful inside this repository/product (default when uncertain).
- `ecosystem` — useful to sibling projects in the same stack, harness, provider, or company ecosystem.
- `universe` — broadly true outside this codebase (protocol/platform/API facts), still written as a concise memory.

### Shareability
Shareability is about EXPOSURE, not scope: **would a teammate working on THIS SAME project benefit from seeing this memory, and is it free of anything personal, local, or sensitive?** If yes, set `shareable="true"`. This is the COMMON case — most project knowledge is exactly what you'd hand a new teammate: architecture, design rules, conventions, constraints, file locations, hard-won gotchas. Mark those shareable even though they are specific to this repo's internals.

Keep `shareable="false"` only for what is tied to the USER or their machine rather than the project: personal/absolute paths, usernames, local or private endpoints (e.g. localhost), credentials/secrets/tokens, customer data, machine-specific config, and personal working-style preferences. A fact's scope does NOT decide shareability. The host also fails closed and forces secret/credential/personal-path text to private regardless.

Output ONE XML manifest at the very end and NOTHING else — no narration, no per-memory commentary, no reasoning:
<classify>
<memory id="N" importance="75" scope="project" shareable="true"/>
<memory id="M" importance="20" scope="universe" shareable="false"/>
</classify>

Rules:
- Every memory in the pool below MUST appear exactly once.
- importance is an integer 1-100; scope is one of project|ecosystem|universe; shareable is true|false."#;

/// Cheap producer-chain guard for completions that succeeded at the transport
/// layer but did not return even a classify manifest envelope. The TypeScript
/// host remains responsible for XML parsing, membership checks, and field validation.
pub fn has_manifest_envelope(text: &str) -> bool {
    let text = text.trim();
    text.contains("<classify>") && text.contains("</classify>")
}

/// `dreamer.run_task` code telling the host to run the classify completion itself.
///
/// Under `historian.runner = "host"` this module opens no route to a completion
/// runner. The classify completion is then the host's to make, exactly as the
/// historian's is: the host runs it on its own carrier and sends the text back in
/// `host_completion`, and the module checks and records it as it would its own
/// runner's output.
pub const HOST_COMPLETION_REQUIRED: &str = "host_completion_required";

/// A classify completion the host ran on its own carrier.
#[derive(Debug, Clone, PartialEq)]
pub struct HostClassifyCompletion {
    pub text: String,
    /// The `provider/model` the host's completion actually used.
    pub model: String,
    pub length_capped: bool,
    pub usage: Option<crate::historian_producer::ProducerUsage>,
}

/// Read `host_completion` off a `dreamer.run_task` request. The text is bounded the
/// same way the prompt is, and the model the same way a model chain entry is.
pub fn parse_host_classify_completion(
    value: &serde_json::Value,
) -> Result<HostClassifyCompletion, String> {
    let object = value
        .as_object()
        .ok_or("host_completion must be an object")?;
    let text = object
        .get("text")
        .and_then(serde_json::Value::as_str)
        .ok_or("host_completion requires text")?;
    if text.len() > MAX_CLASSIFY_PROMPT_BYTES {
        return Err(format!(
            "host_completion text exceeds {MAX_CLASSIFY_PROMPT_BYTES} bytes"
        ));
    }
    let model = object
        .get("model")
        .and_then(serde_json::Value::as_str)
        .ok_or("host_completion requires model")?;
    if model.trim().is_empty() || model.len() > 256 {
        return Err("host_completion model must be 1-256 bytes".to_string());
    }
    let length_capped = match object.get("length_capped") {
        None | Some(serde_json::Value::Null) => false,
        Some(serde_json::Value::Bool(value)) => *value,
        Some(_) => return Err("host_completion length_capped must be a boolean".to_string()),
    };
    let usage = match object.get("usage") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::Object(usage)) => {
            let count = |key: &str| {
                usage
                    .get(key)
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0)
            };
            Some(crate::historian_producer::ProducerUsage {
                input: count("input"),
                output: count("output"),
                cache_read: count("cache_read"),
                cache_write: count("cache_write"),
            })
        }
        Some(_) => return Err("host_completion usage must be an object".to_string()),
    };
    Ok(HostClassifyCompletion {
        text: text.to_string(),
        model: model.to_string(),
        length_capped,
        usage,
    })
}

/// Mint an opaque child id without exposing the command id or project path in
/// provider/session diagnostics. The registry, rather than this prefix, is the
/// transform exemption authority.
///
/// `attempt_nonce` makes every attempt its own provider session. A producer session runs
/// one episode at a time: a send that arrives while the previous attempt's run is still
/// active (a parked run, or one this module stopped waiting for) is queued behind it
/// rather than started, and the classifier has no way to drain a queued run. Reusing one
/// id for a whole fallback chain therefore turned the SECOND model attempt into a queued
/// prompt every time the first attempt ended without its run ending. The historian solves
/// the same problem by putting its firing sequence in the id.
pub fn child_session_id(project: &str, command_id: &str, attempt_nonce: u64) -> String {
    let mut hasher = Sha256::new();
    hasher.update(project.as_bytes());
    hasher.update([0]);
    hasher.update(command_id.as_bytes());
    hasher.update([0]);
    hasher.update(attempt_nonce.to_be_bytes());
    let digest = hasher.finalize();
    format!("mc-dreamer:classify:{}", hex_prefix(&digest, 16))
}

static ATTEMPT_NONCE: AtomicU64 = AtomicU64::new(0);

/// Mint the next attempt nonce for `child_session_id`. The counter is first raised to the
/// current wall clock so a module that restarts in the middle of a command cannot reissue
/// a nonce an earlier process already spent on a provider session that may still be live.
pub fn next_attempt_nonce(now_ms: i64) -> u64 {
    ATTEMPT_NONCE.fetch_max(now_ms.max(0) as u64, Ordering::Relaxed);
    ATTEMPT_NONCE
        .fetch_add(1, Ordering::Relaxed)
        .saturating_add(1)
}

fn hex_prefix(bytes: &[u8], count: usize) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(count);
    for byte in bytes.iter().take(count.div_ceil(2)) {
        out.push(HEX[(byte >> 4) as usize] as char);
        if out.len() < count {
            out.push(HEX[(byte & 0x0f) as usize] as char);
        }
    }
    out.truncate(count);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_envelope_rejects_provider_outage_text() {
        assert!(!has_manifest_envelope("All Antigravity endpoints failed"));
        assert!(has_manifest_envelope(
            "<classify><memory id=\"1\"/></classify>"
        ));
    }

    #[test]
    fn child_ids_are_stable_but_lineage_scoped() {
        assert_eq!(
            child_session_id("project", "command", 1),
            child_session_id("project", "command", 1)
        );
        assert_ne!(
            child_session_id("project", "command", 1),
            child_session_id("other", "command", 1)
        );
        assert!(child_session_id("project", "command", 1).starts_with("mc-dreamer:classify:"));
    }

    #[test]
    fn attempt_nonces_never_repeat_and_survive_a_restart_mid_command() {
        let first = next_attempt_nonce(1_000);
        let second = next_attempt_nonce(1_000);
        assert!(second > first, "{second} must advance past {first}");
        // A restarted process seeds from its own clock, which is ahead of anything the
        // previous process could have minted.
        let after_restart = next_attempt_nonce(9_000_000_000_000);
        assert!(after_restart > second);
    }

    #[test]
    fn each_attempt_gets_its_own_provider_session() {
        // Two attempts at the same command must never share a session: the first
        // attempt's run can still be holding it when the second one sends.
        assert_ne!(
            child_session_id("project", "command", 1),
            child_session_id("project", "command", 2)
        );
    }
}
