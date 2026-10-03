//! Pull-based reply delivery keeps a large response from monopolizing the daemon's
//! per-connection egress queue. Each next page requires a new consumer request.

use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
use subc_client_rs::HandlerOutcome;

pub(crate) const FRAME_TARGET: usize = 512 * 1024;
// Each page's `data` is cut by its JSON-escaped size, not its raw size, so a page fills
// most of the frame. A fixed raw cut had to assume the worst case (one byte escaping to
// six) and so used 64 KiB pages, which turned a large reply into a hundred-plus sequential
// round trips through the daemon. The headroom covers the page's own metadata fields.
const PAGE_DATA_ESCAPED_BUDGET: usize = FRAME_TARGET - 4 * 1024;

/// Bytes `c` occupies inside a JSON string as serde_json writes it.
fn escaped_len(c: char) -> usize {
    match c {
        '"' | '\\' | '\u{08}' | '\u{0c}' | '\n' | '\r' | '\t' => 2,
        c if (c as u32) < 0x20 => 6,
        c => c.len_utf8(),
    }
}
const CACHE_BYTES: usize = 128 * 1024 * 1024;
const CACHE_ENTRIES: usize = 64;
const TTL: Duration = Duration::from_secs(120);

struct Reply {
    bytes: Arc<str>,
    boundaries: Vec<usize>,
    created: Instant,
}

#[derive(Default)]
pub(crate) struct ReplyPages {
    entries: HashMap<((u16, u32), String), Reply>,
    bytes: usize,
}

fn error(code: &str) -> HandlerOutcome {
    HandlerOutcome::Error {
        code: code.into(),
        message: "Reply unavailable; abandon this pass rather than resending the transform".into(),
    }
}

#[derive(serde::Deserialize)]
struct ReplyCapabilities {
    #[serde(default)]
    accept_reply_pages: bool,
}

pub(crate) fn accepts_reply_pages(body: &[u8]) -> bool {
    serde_json::from_slice::<ReplyCapabilities>(body)
        .map(|request| request.accept_reply_pages)
        .unwrap_or(false)
}

impl ReplyPages {
    pub(crate) fn remove_channel(&mut self, channel: u16) {
        self.entries.retain(|(owner, _), reply| {
            if owner.0 == channel {
                self.bytes -= reply.bytes.len();
                false
            } else {
                true
            }
        });
    }

    pub(crate) fn bound(
        &mut self,
        channel: (u16, u32),
        outcome: HandlerOutcome,
        accept_reply_pages: bool,
    ) -> HandlerOutcome {
        let HandlerOutcome::Response(bytes) = outcome else {
            return outcome;
        };
        if !accept_reply_pages || bytes.len() <= FRAME_TARGET {
            return HandlerOutcome::Response(bytes);
        }
        if bytes.len() > CACHE_BYTES {
            return error("reply_too_large");
        }
        let Ok(text) = String::from_utf8(bytes) else {
            return error("reply_invalid_utf8");
        };
        let id = format!("{:x}", Sha256::digest(text.as_bytes()));
        self.entries.retain(|_, reply| {
            if reply.created.elapsed() >= TTL {
                self.bytes -= reply.bytes.len();
                false
            } else {
                true
            }
        });
        let key = (channel, id.clone());
        if !self.entries.contains_key(&key) {
            while self.entries.len() >= CACHE_ENTRIES || self.bytes + text.len() > CACHE_BYTES {
                let oldest = self
                    .entries
                    .iter()
                    .min_by_key(|(_, r)| r.created)
                    .map(|(k, _)| k.clone());
                if let Some(key) = oldest {
                    let removed = self.entries.remove(&key).expect("oldest reply exists");
                    self.bytes -= removed.bytes.len();
                } else {
                    break;
                }
            }
            let mut boundaries = vec![0];
            let mut escaped = 0;
            for (offset, c) in text.char_indices() {
                let width = escaped_len(c);
                if escaped + width > PAGE_DATA_ESCAPED_BUDGET {
                    boundaries.push(offset);
                    escaped = 0;
                }
                escaped += width;
            }
            if *boundaries.last().expect("first boundary") != text.len() {
                boundaries.push(text.len());
            }
            self.bytes += text.len();
            self.entries.insert(
                key,
                Reply {
                    bytes: Arc::from(text),
                    boundaries,
                    created: Instant::now(),
                },
            );
        }
        self.page(channel, &id, 0)
    }

    pub(crate) fn page(&self, channel: (u16, u32), id: &str, index: usize) -> HandlerOutcome {
        let Some(reply) = self.entries.get(&(channel, id.into())) else {
            return error("reply_page_missing");
        };
        let total = reply.boundaries.len() - 1;
        if reply.created.elapsed() >= TTL || index >= total {
            return error("reply_page_missing");
        }
        let data = &reply.bytes[reply.boundaries[index]..reply.boundaries[index + 1]];
        let bytes = serde_json::to_vec(&json!({"reply_page": {
            "id": id, "index": index, "total": total, "bytes": reply.bytes.len(), "data": data
        }}))
        .expect("reply page JSON");
        if bytes.len() > FRAME_TARGET {
            return error("reply_page_too_large");
        }
        HandlerOutcome::Response(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn old_shape_requests_keep_oversized_unary_replies_byte_identical() {
        let original =
            serde_json::to_vec(&json!({"screenshots": "QUJD".repeat(1_100_000)})).unwrap();
        assert!(original.len() > 4 * 1024 * 1024);
        for body in [
            br#"{"method":"transform","input":[]}"#.as_slice(),
            br#"{"method":"transform","accept_reply_pages":false}"#.as_slice(),
            br#"{"method":"transform","accept_reply_pages":"true"}"#.as_slice(),
        ] {
            let mut cache = ReplyPages::default();
            let HandlerOutcome::Response(reply) = cache.bound(
                (7, 1),
                HandlerOutcome::Response(original.clone()),
                accepts_reply_pages(body),
            ) else {
                panic!("expected legacy unary response");
            };
            assert_eq!(reply.len(), original.len());
            assert_eq!(reply, original);
            assert!(cache.entries.is_empty());
        }
    }

    #[test]
    fn oversized_reply_frames_are_bounded_and_byte_identical() {
        let original =
            serde_json::to_vec(&json!({"screenshots": "é🦀\\\n".repeat(900_000)})).unwrap();
        assert!(original.len() > 4 * 1024 * 1024);
        let mut cache = ReplyPages::default();
        let HandlerOutcome::Response(first) = cache.bound(
            (7, 1),
            HandlerOutcome::Response(original.clone()),
            accepts_reply_pages(br#"{"method":"transform","accept_reply_pages":true}"#),
        ) else {
            panic!("expected page");
        };
        assert!(first.len() <= 512 * 1024, "reply frame exceeded 512 KiB");
        let first: Value = serde_json::from_slice(&first).unwrap();
        let page = &first["reply_page"];
        let id = page["id"].as_str().unwrap();
        let total = page["total"].as_u64().unwrap() as usize;
        let mut rebuilt = Vec::new();
        for index in 0..total {
            let HandlerOutcome::Response(bytes) = cache.page((7, 1), id, index) else {
                panic!("expected page");
            };
            assert!(bytes.len() <= 512 * 1024, "reply frame exceeded 512 KiB");
            let page: Value = serde_json::from_slice(&bytes).unwrap();
            rebuilt.extend_from_slice(page["reply_page"]["data"].as_str().unwrap().as_bytes());
        }
        assert_eq!(rebuilt, original);
        assert!(matches!(
            cache.page((8, 1), id, 0),
            HandlerOutcome::Error { .. }
        ));
        cache.remove_channel(7);
        assert!(matches!(
            cache.page((7, 1), id, 0),
            HandlerOutcome::Error { .. }
        ));
        assert_eq!(cache.bytes, 0);
    }

    fn page_count(original: &[u8]) -> usize {
        let mut cache = ReplyPages::default();
        let HandlerOutcome::Response(first) =
            cache.bound((7, 1), HandlerOutcome::Response(original.to_vec()), true)
        else {
            panic!("expected page");
        };
        let first: Value = serde_json::from_slice(&first).unwrap();
        let id = first["reply_page"]["id"].as_str().unwrap().to_string();
        let total = first["reply_page"]["total"].as_u64().unwrap() as usize;
        let mut rebuilt = Vec::new();
        for index in 0..total {
            let HandlerOutcome::Response(bytes) = cache.page((7, 1), &id, index) else {
                panic!("page {index} of {total} was refused");
            };
            assert!(
                bytes.len() <= FRAME_TARGET,
                "page {index} exceeded the frame"
            );
            let page: Value = serde_json::from_slice(&bytes).unwrap();
            rebuilt.extend_from_slice(page["reply_page"]["data"].as_str().unwrap().as_bytes());
        }
        assert_eq!(rebuilt, original);
        total
    }

    #[test]
    fn ordinary_replies_page_in_few_round_trips() {
        // A transform reply is JSON text: mostly plain characters, with quotes and
        // newlines that escape to two bytes. 5 MiB of it must not take ~80 pages.
        let message = json!({"role": "tool", "text": "line of output\n".repeat(40)});
        let original = serde_json::to_vec(&json!({
            "messages": std::iter::repeat_n(message, 9_000).collect::<Vec<_>>()
        }))
        .unwrap();
        assert!(original.len() > 5 * 1024 * 1024);
        let pages = page_count(&original);
        assert!(pages <= 16, "{} bytes took {pages} pages", original.len());
    }

    #[test]
    fn worst_case_escaping_still_fits_each_frame() {
        // Every byte a control character that escapes to six bytes.
        let original = serde_json::to_vec(&json!({"data": "\u{01}".repeat(1_000_000)})).unwrap();
        page_count(&original);
    }
}
