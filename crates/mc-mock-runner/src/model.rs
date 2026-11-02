//! Mock model providers. Each answers a rendered request the way the real
//! provider would, as far as compaction is concerned:
//! - it counts the prompt and rejects one larger than the model's window;
//! - it keeps a prompt cache and reports what it read and wrote;
//! - for signed reasoning (Anthropic), it remembers what each signed part was
//!   generated after, and rejects a request in which that history changed;
//! - for chained requests (OpenAI Responses continuing from the previous
//!   response), it continues only when the request repeats the previous one
//!   and the model's own replies exactly as the model wrote them.
//!
//! The signature check works from the rendered request alone. It does not use
//! the contract's rule checker, so it is an independent check of it.

use std::collections::HashMap;

use ck_contract_draft::part::{PartBody, Seal};
use ck_contract_draft::read::{Role, StepUsage};
use compaction_view::render::RenderedMessage;
use sha2::{Digest, Sha256};

use crate::tokens::part_tokens;

/// One request to a model.
pub struct Request<'a> {
    pub messages: &'a [RenderedMessage],
    /// Identifies the system prompt and tool definitions; a change in either
    /// changes every cached prefix.
    pub system_digest: &'a str,
    pub system_tokens: u64,
    pub window: u64,
    /// Milliseconds since the Unix epoch, on the scenario's clock.
    pub now: u64,
    /// What each reasoning part costs, as reported when it was produced.
    pub reasoning_tokens: &'a dyn Fn(&str) -> u64,
}

/// What a successful request reports.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Completion {
    pub usage: StepUsage,
    /// What a signed reasoning part produced by this request is bound to.
    /// The runner passes it to [`MockModel::bind`] once the part has an id.
    pub binding: Binding,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "error", rename_all = "snake_case")]
pub enum ModelError {
    /// The prompt is larger than the model's window.
    PromptTooLong { prompt_tokens: u64, window: u64 },
    /// A signed reasoning part no longer matches the history before it.
    InvalidSignature { part: String },
}

/// The history a signed reasoning part was generated after: the content
/// before it, without reasoning, and the signed reasoning parts it saw, in
/// order. Later, the content must be identical, and the signed parts still
/// present must be the same list with some of its oldest left out.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Binding {
    content: String,
    signed_before: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// Anthropic: signed thinking, prompt cache with a requested lifetime.
    Anthropic,
    /// OpenAI Responses sent in full each time: encrypted reasoning, prefix
    /// cache.
    OpenAi,
    /// OpenAI Responses chained to the previous response, as a connection
    /// that sends only what is new. Any change to history already sent, the
    /// model's own replies included, ends the chain: the request is sent in
    /// full and reads nothing but the system prompt from the cache.
    OpenAiChained,
}

/// A mock provider for one session.
pub struct MockModel {
    kind: Kind,
    /// How long a cached prefix lives after its last use, in milliseconds.
    cache_ttl_ms: u64,
    cache: Vec<CacheEntry>,
    bindings: HashMap<String, Binding>,
    /// Text the model wrote in its newest reply, per text part. A chained
    /// request continues from the previous response, so only that reply has
    /// to come back as written; older ones were checked as part of the
    /// previous request.
    outputs: HashMap<String, String>,
    /// The previous request, for chaining: its blocks and prompt tokens.
    previous: Option<(Vec<[u8; 32]>, u64)>,
}

struct CacheEntry {
    /// Block hashes of the cached prompt, in order.
    blocks: Vec<[u8; 32]>,
    /// Prompt tokens up to and including each block.
    tokens: Vec<u64>,
    expires_at: u64,
}

impl MockModel {
    pub fn new(kind: Kind, cache_ttl_ms: u64) -> Self {
        Self {
            kind,
            cache_ttl_ms,
            cache: Vec::new(),
            bindings: HashMap::new(),
            outputs: HashMap::new(),
            previous: None,
        }
    }

    pub fn kind(&self) -> Kind {
        self.kind
    }

    /// Answer a request, or reject it as the real provider would.
    pub fn complete(&mut self, request: &Request<'_>) -> Result<Completion, ModelError> {
        let (blocks, tokens) = self.blocks(request);
        let prompt_tokens = *tokens.last().expect("the system block is always there");
        if prompt_tokens > request.window {
            return Err(ModelError::PromptTooLong {
                prompt_tokens,
                window: request.window,
            });
        }
        if self.kind == Kind::Anthropic {
            self.check_signatures(request)?;
        }
        if self.kind == Kind::OpenAiChained {
            let continues = self.previous.as_ref().is_some_and(|(previous, _)| {
                previous.len() <= blocks.len() && blocks[..previous.len()] == previous[..]
            }) && self.replies_unchanged(request.messages);
            self.outputs.clear();
            let read = match &self.previous {
                Some((_, prompt)) if continues => *prompt,
                _ => request.system_tokens,
            };
            self.previous = Some((blocks, prompt_tokens));
            return Ok(Completion {
                usage: usage(prompt_tokens, read),
                binding: Binding {
                    content: String::new(),
                    signed_before: Vec::new(),
                },
            });
        }

        // A read reaches the end of an earlier request whose whole prompt is a
        // prefix of this one, or at least the system prompt and tools, which
        // runners always mark for caching. That is all-or-nothing per earlier
        // request, as both providers behave.
        self.cache.retain(|entry| entry.expires_at > request.now);
        let mut read = 0;
        for entry in &mut self.cache {
            let length = entry.blocks.len();
            if length <= blocks.len() && entry.blocks[..] == blocks[..length] {
                read = read.max(entry.tokens[length - 1]);
                entry.expires_at = request.now + self.cache_ttl_ms;
            } else if entry.blocks[0] == blocks[0] {
                read = read.max(entry.tokens[0]);
                entry.expires_at = request.now + self.cache_ttl_ms;
            }
        }
        self.cache.push(CacheEntry {
            blocks: blocks.clone(),
            tokens: tokens.clone(),
            expires_at: request.now + self.cache_ttl_ms,
        });
        Ok(Completion {
            usage: usage(prompt_tokens, read),
            binding: Binding {
                content: content_before(request.messages, usize::MAX, request.system_digest),
                signed_before: signed_ids(request.messages, usize::MAX),
            },
        })
    }

    /// Record what a newly generated signed reasoning part is bound to.
    pub fn bind(&mut self, part: &str, binding: Binding) {
        self.bindings.insert(part.to_owned(), binding);
    }

    /// Record the text the model wrote for a text part of its newest reply.
    pub fn record_output(&mut self, part: &str, text: String) {
        self.outputs.insert(part.to_owned(), text);
    }

    /// Whether the newest reply's text reaches this request exactly as the
    /// model wrote it.
    fn replies_unchanged(&self, messages: &[RenderedMessage]) -> bool {
        messages.iter().all(|message| {
            message
                .parts
                .iter()
                .all(|part| match self.outputs.get(&part.id) {
                    Some(written) => message.wire_text(part).as_ref() == Some(written),
                    None => true,
                })
        })
    }

    fn check_signatures(&self, request: &Request<'_>) -> Result<(), ModelError> {
        let mut position = 0;
        for message in request.messages {
            for part in &message.parts {
                if part.seal == Seal::Signed {
                    let Some(binding) = self.bindings.get(&part.id) else {
                        return Err(ModelError::InvalidSignature {
                            part: part.id.clone(),
                        });
                    };
                    let content = content_before(request.messages, position, request.system_digest);
                    let signed = signed_ids(request.messages, position);
                    let suffix = binding.signed_before.ends_with(&signed);
                    if content != binding.content || !suffix {
                        return Err(ModelError::InvalidSignature {
                            part: part.id.clone(),
                        });
                    }
                }
                position += 1;
            }
        }
        Ok(())
    }

    fn blocks(&self, request: &Request<'_>) -> (Vec<[u8; 32]>, Vec<u64>) {
        let mut blocks = vec![hash(&[request.system_digest.as_bytes()])];
        let mut tokens = vec![request.system_tokens];
        let mut total = request.system_tokens;
        for message in request.messages {
            for part in &message.parts {
                total += part_tokens(message, part, request.reasoning_tokens);
                let wire = message.wire_text(part).unwrap_or_default();
                blocks.push(hash(&[
                    role_name(message.role).as_bytes(),
                    part.id.as_bytes(),
                    part.digest.as_bytes(),
                    wire.as_bytes(),
                ]));
                tokens.push(total);
            }
        }
        (blocks, tokens)
    }
}

/// A digest of every part before flat position `limit` that is not
/// reasoning, with message boundaries and roles, plus the system prompt.
///
/// A message's boundary counts only once one of its non-reasoning parts
/// does. So for a reasoning part at the start of its message, the digest is
/// exactly that of the request it was generated by, which ended before the
/// message existed.
fn content_before(messages: &[RenderedMessage], limit: usize, system_digest: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(system_digest.as_bytes());
    let mut position = 0;
    'outer: for message in messages {
        let mut opened = false;
        for part in &message.parts {
            if position >= limit {
                break 'outer;
            }
            position += 1;
            if matches!(part.body, PartBody::Reasoning { .. }) {
                continue;
            }
            if !opened {
                hasher.update(b"\x00message\x00");
                hasher.update(role_name(message.role).as_bytes());
                opened = true;
            }
            hasher.update(b"\x00part\x00");
            hasher.update(part.digest.as_bytes());
        }
    }
    hex(&hasher.finalize())
}

/// Ids of the signed reasoning parts before flat position `limit`, in order.
fn signed_ids(messages: &[RenderedMessage], limit: usize) -> Vec<String> {
    messages
        .iter()
        .flat_map(|message| &message.parts)
        .take(limit)
        .filter(|part| part.seal == Seal::Signed)
        .map(|part| part.id.clone())
        .collect()
}

/// What a request reports: its prompt, what it read from the cache, and the
/// rest written. The mock reports no output: replies are scripted.
fn usage(prompt_tokens: u64, read: u64) -> StepUsage {
    StepUsage {
        prompt_tokens: Some(prompt_tokens),
        cache_read_tokens: Some(read),
        cache_write_tokens: Some(prompt_tokens - read),
        output_tokens: None,
        reasoning_tokens: None,
    }
}

fn role_name(role: Role) -> &'static str {
    match role {
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::System => "system",
    }
}

fn hash(chunks: &[&[u8]]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    for chunk in chunks {
        hasher.update((chunk.len() as u64).to_be_bytes());
        hasher.update(chunk);
    }
    hasher.finalize().into()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
