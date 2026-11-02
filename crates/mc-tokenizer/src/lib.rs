//! Claude BPE token estimator — a bit-faithful Rust port of `ai-tokenizer`'s
//! `claude` encoding, which the TS `estimateTokens` uses.
//!
//! `estimateTokens(text)` in the TS harness is `Tokenizer(claudeEncoding).encode(
//! text, "all").length`. The `"all"` mode byte-BPEs special-token substrings as
//! LITERAL text (e.g. `<EOT>` → 4 byte tokens, not the special rank), i.e. it is a
//! plain byte-BPE with NO special-token handling — exactly tiktoken's
//! `encode_ordinary` / `count_ordinary`. So this crate builds a `CoreBPE` from the
//! vendored claude vocab (`assets/claude.tiktoken`, generated from
//! `ai-tokenizer/encoding/claude` by `gen/gen-claude-vocab.ts`) plus the claude
//! `pat_str`, and exposes [`estimate_tokens`].
//!
//! DETERMINISM is the load-bearing property (the module's cache-stability core
//! only ever calls this on a HARD m0 rematerialization, and a resume must produce
//! byte-identical m0). The vocab is VENDORED and frozen, and tiktoken-rs +
//! fancy-regex are version-pinned, so the same text tokenizes identically across
//! runs and machines. Bit-exact agreement with the TS `ai-tokenizer` is a
//! FAITHFULNESS goal (validated by the differential golden in `tests/`), not a
//! runtime invariant — only this implementation runs in the target.
//!
//! Relocation-clean: the public surface is a plain `estimate_tokens(&str) ->
//! usize` with no Magic-Context coupling, so this crate can move to a shared
//! `commons` home (with a vocab registry) if a second consumer — e.g. the
//! llm-runner — ever needs a Claude tokenizer.

use std::sync::{Arc, OnceLock};

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use rustc_hash::FxHashMap;
use tiktoken_rs::{CoreBPE, Rank};

/// The vendored Claude BPE vocab: `base64(token_bytes) SP rank` per line, unified
/// from `ai-tokenizer/encoding/claude`'s string + binary encoders. Embedded at
/// build time so there is no runtime file read or network fetch (both would break
/// the determinism guarantee on resume).
const CLAUDE_TIKTOKEN: &str = include_str!("../assets/claude.tiktoken");

/// The Claude pre-tokenization split pattern (`pat_str` from
/// `ai-tokenizer/encoding/claude`). The standard GPT-2 pattern: contractions,
/// letter runs, number runs, punctuation runs, and whitespace (with a `(?!\S)`
/// lookahead that fancy-regex supports).
const CLAUDE_PAT_STR: &str =
    r"'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+";

fn tokenizer() -> &'static CoreBPE {
    static TOKENIZER: OnceLock<CoreBPE> = OnceLock::new();
    TOKENIZER.get_or_init(|| {
        let mut encoder: FxHashMap<Vec<u8>, Rank> = FxHashMap::default();
        for line in CLAUDE_TIKTOKEN.lines() {
            if line.is_empty() {
                continue;
            }
            let mut parts = line.split(' ');
            let raw = parts.next().expect("vocab line missing token field");
            let rank_str = parts.next().expect("vocab line missing rank field");
            let bytes = STANDARD
                .decode(raw)
                .expect("vocab token is not valid base64");
            let rank: Rank = rank_str.parse().expect("vocab rank is not a u32");
            encoder.insert(bytes, rank);
        }
        // No special-token encoder: estimate_tokens is byte-BPE only (matches the
        // TS `encode(_, "all")` semantics), so specials are never consulted.
        CoreBPE::new(encoder, FxHashMap::default(), CLAUDE_PAT_STR)
            .expect("claude BPE construction failed (bad vocab or pattern)")
    })
}

/// Count the Claude BPE tokens in `text` — the Rust equivalent of the TS
/// `estimateTokens`. Empty text is 0 (matching the TS falsy-guard); otherwise it
/// is the length of the ordinary (special-free) byte-BPE encoding.
pub fn estimate_tokens(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }
    count_history_cached(text)
}

// A heading follows two newlines, so no Claude pre-tokenization piece crosses
// this boundary. The sentinel preserves the whitespace regex's end-of-input
// lookahead for non-final chunks; it is a separate one-token punctuation piece.
fn count_history_cached(text: &str) -> usize {
    let cache = HISTORY_COUNTS.get_or_init(|| std::sync::Mutex::new(HistoryCounts::default()));
    // Counting on another transform must not wait behind a cold cache fill.
    let Ok(mut cache) = cache.try_lock() else {
        return tokenizer().count_ordinary(text);
    };
    let mut start = 0;
    let mut total = 0;
    for (offset, _) in text.match_indices("\n\n## ") {
        let end = offset + 2;
        total += cache.count(&text[start..end], true);
        start = end;
    }
    total + cache.count(&text[start..], false)
}

/// Count a paragraph both at end of input and before a `\n\n## ` heading.
/// The continued count includes the two joining newlines, not the next heading.
/// Callers must preserve that separator and heading prefix when summing counts.
pub fn history_paragraph_counts(text: &str) -> (usize, usize) {
    let final_count = estimate_tokens(text);
    let continued_count = estimate_tokens(&format!("{text}\n\n#")) - 1;
    (final_count, continued_count)
}

/// Process-local ceiling for retained history text and entry overhead.
/// Oversized chunks bypass the cache; eviction is least-recently-used.
const HISTORY_CACHE_BYTES: usize = 8 * 1024 * 1024;

static HISTORY_COUNTS: OnceLock<std::sync::Mutex<HistoryCounts>> = OnceLock::new();

/// The text of each entry is stored once and shared between the lookup map and
/// the recency index, so refreshing an entry's recency on a hit copies a pointer
/// rather than the (possibly very large) text.
#[derive(Default)]
struct HistoryCounts {
    entries: std::collections::HashMap<Arc<str>, HistoryCount>,
    age: std::collections::BTreeMap<u64, Arc<str>>,
    clock: u64,
    bytes: usize,
}

struct HistoryCount {
    counts: [Option<usize>; 2],
    age: u64,
    /// The same allocation as this entry's key in `entries`.
    key: Arc<str>,
}

/// Bytes charged against [`HISTORY_CACHE_BYTES`] for one cached text. The
/// formula is the cache's budget convention and is kept stable so the set of
/// texts that fit, and therefore eviction order, does not change.
fn history_entry_cost(text_len: usize) -> usize {
    text_len.saturating_mul(2).saturating_add(128)
}

impl HistoryCounts {
    fn count(&mut self, text: &str, continued: bool) -> usize {
        self.count_within(text, continued, HISTORY_CACHE_BYTES)
    }

    /// [`Self::count`] against an explicit byte budget. Production always uses
    /// [`HISTORY_CACHE_BYTES`]; tests pass a small budget so eviction can be
    /// exercised without tokenizing megabytes of text.
    fn count_within(&mut self, text: &str, continued: bool, budget: usize) -> usize {
        let slot = usize::from(continued);
        self.clock += 1;
        if let Some(entry) = self.entries.get_mut(text) {
            self.age.remove(&entry.age);
            entry.age = self.clock;
            self.age.insert(self.clock, Arc::clone(&entry.key));
            if let Some(count) = entry.counts[slot] {
                return count;
            }
        }
        let count = if continued {
            tokenizer().count_ordinary(&format!("{text}#")) - 1
        } else {
            tokenizer().count_ordinary(text)
        };
        if let Some(entry) = self.entries.get_mut(text) {
            entry.counts[slot] = Some(count);
            return count;
        }
        let cost = history_entry_cost(text.len());
        if cost > budget {
            return count;
        }
        while self.bytes + cost > budget {
            let (_, key) = self.age.pop_first().expect("non-empty bounded cache");
            self.bytes -= history_entry_cost(key.len());
            self.entries.remove(&*key);
        }
        let mut counts = [None; 2];
        counts[slot] = Some(count);
        let key: Arc<str> = Arc::from(text);
        self.entries.insert(
            Arc::clone(&key),
            HistoryCount {
                counts,
                age: self.clock,
                key: Arc::clone(&key),
            },
        );
        self.age.insert(self.clock, key);
        self.bytes += cost;
        count
    }
}

/// The full token-ID sequence for `text` (ordinary byte-BPE). Exposed for the
/// differential golden, which asserts the exact IDs match `ai-tokenizer` — a
/// stronger check than the count alone (it catches count-coincident merge bugs).
pub fn encode_ordinary(text: &str) -> Vec<Rank> {
    tokenizer().encode_ordinary(text)
}

/// Process-local ceiling for the session-history render counts, charged with the
/// same per-entry convention as [`HISTORY_CACHE_BYTES`].
const HISTORY_RENDER_CACHE_BYTES: usize = 32 * 1024 * 1024;

/// Counts for the session-history render only: compartment tier texts and the
/// rendered history slice. They are kept apart from [`HISTORY_COUNTS`], which every
/// other estimate in the process (tail blocks, tags, memories) shares. In a busy
/// process that other traffic evicted a long session's tier counts between folds, and
/// a fold that found the shared cache locked counted without it, so every fold
/// re-tokenized its whole visible history.
static HISTORY_RENDER_COUNTS: OnceLock<std::sync::Mutex<HistoryCounts>> = OnceLock::new();

/// [`estimate_tokens`] for session-history render text, memoized in the history
/// render cache. Returns exactly what `estimate_tokens` returns for the same text.
pub fn estimate_history_render_tokens(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }
    let cache = HISTORY_RENDER_COUNTS.get_or_init(Default::default);
    let mut start = 0;
    let mut total = 0;
    for (offset, _) in text.match_indices("\n\n## ") {
        let end = offset + 2;
        total += count_render_piece(cache, &text[start..end], true);
        start = end;
    }
    total + count_render_piece(cache, &text[start..], false)
}

/// [`history_paragraph_counts`] through the history render cache.
pub fn history_render_paragraph_counts(text: &str) -> (usize, usize) {
    let final_count = estimate_history_render_tokens(text);
    let continued_count = estimate_history_render_tokens(&format!("{text}\n\n#")) - 1;
    (final_count, continued_count)
}

/// One cached piece count. The lock is held only for the lookup and the insert,
/// never while tokenizing, so concurrent folds wait for each other's map updates but
/// not for each other's tokenization.
fn count_render_piece(
    cache: &std::sync::Mutex<HistoryCounts>,
    piece: &str,
    continued: bool,
) -> usize {
    let lock = || {
        cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    };
    if let Some(count) = lock().lookup(piece, continued) {
        return count;
    }
    let count = count_piece(piece, continued);
    lock().insert_counted(piece, continued, count, HISTORY_RENDER_CACHE_BYTES);
    count
}

/// The uncached count of one piece. A piece followed by a `\n\n## ` heading
/// (`continued`) is counted with a sentinel `#` appended, minus that one token, so its
/// trailing newlines split as they do mid-text: the pre-tokenizer's `\s+(?!\S)` rule
/// treats whitespace at end of input differently. Piece counts then sum to the
/// whole text's count.
fn count_piece(piece: &str, continued: bool) -> usize {
    #[cfg(test)]
    RENDER_PIECE_TOKENIZATIONS.with(|count| count.set(count.get() + 1));
    if continued {
        tokenizer().count_ordinary(&format!("{piece}#")) - 1
    } else {
        tokenizer().count_ordinary(piece)
    }
}

#[cfg(test)]
thread_local! {
    /// Pieces this thread tokenized through the history render cache.
    static RENDER_PIECE_TOKENIZATIONS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

impl HistoryCounts {
    /// A cached count, refreshing the entry's recency on a hit.
    fn lookup(&mut self, text: &str, continued: bool) -> Option<usize> {
        self.clock += 1;
        let entry = self.entries.get_mut(text)?;
        self.age.remove(&entry.age);
        entry.age = self.clock;
        self.age.insert(self.clock, Arc::clone(&entry.key));
        entry.counts[usize::from(continued)]
    }

    /// Record a count computed outside the lock. Another thread may have inserted the
    /// same text meanwhile; then only the slot is filled. A new entry takes a fresh
    /// clock tick, so two inserts between lookups never share a recency key.
    fn insert_counted(&mut self, text: &str, continued: bool, count: usize, budget: usize) {
        let slot = usize::from(continued);
        if let Some(entry) = self.entries.get_mut(text) {
            entry.counts[slot] = Some(count);
            return;
        }
        let cost = history_entry_cost(text.len());
        if cost > budget {
            return;
        }
        while self.bytes + cost > budget {
            let (_, key) = self.age.pop_first().expect("non-empty bounded cache");
            self.bytes -= history_entry_cost(key.len());
            self.entries.remove(&*key);
        }
        self.clock += 1;
        let mut counts = [None; 2];
        counts[slot] = Some(count);
        let key: Arc<str> = Arc::from(text);
        self.entries.insert(
            Arc::clone(&key),
            HistoryCount {
                counts,
                age: self.clock,
                key: Arc::clone(&key),
            },
        );
        self.age.insert(self.clock, key);
        self.bytes += cost;
    }
}

#[cfg(test)]
mod review_tests;

#[cfg(test)]
mod history_cache_tests {
    use super::*;

    #[test]
    fn history_piece_counts_equal_ordinary_encoding() {
        let bodies = [
            "",
            "x",
            "  ",
            "x\n",
            "x\n \t\n",
            "é漢字🙂🚀",
            "can't I'd we've",
            "\u{2003}\u{2028}",
            "## title\n## nested",
            "<EOT>",
            "x \r\n\t ",
        ];
        for left in bodies {
            for right in bodies {
                let text = format!("## first\n{left}\n\n## second\n{right}");
                assert_eq!(
                    estimate_tokens(&text),
                    encode_ordinary(&text).len(),
                    "{text:?}"
                );
                let first = format!("## first\n{left}");
                let second = format!("## second\n{right}");
                assert_eq!(
                    history_paragraph_counts(&first).1 + history_paragraph_counts(&second).0,
                    encode_ordinary(&text).len(),
                    "joined: {text:?}"
                );
            }
        }
    }

    #[test]
    fn history_cache_is_byte_bounded_and_evicts_least_recently_used() {
        let mut cache = HistoryCounts::default();
        // Three six-byte texts fit in this budget; a fourth must evict one.
        let budget = 420;
        cache.count_within("recent", false, budget);
        cache.count_within("oldest", false, budget);
        cache.count_within("middle", false, budget);
        cache.count_within("recent", false, budget);
        cache.count_within("newest", false, budget);
        assert!(cache.bytes <= budget);
        assert_eq!(cache.entries.len(), 3);
        assert!(cache.entries.contains_key("recent"));
        assert!(cache.entries.contains_key("middle"));
        assert!(cache.entries.contains_key("newest"));
        assert!(!cache.entries.contains_key("oldest"));
        assert_eq!(
            cache.bytes,
            cache
                .entries
                .keys()
                .map(|s| s.len() * 2 + 128)
                .sum::<usize>()
        );
    }

    #[test]
    fn history_render_counts_equal_ordinary_encoding_cold_and_cached() {
        let bodies = [
            "",
            "x",
            "  ",
            "x\n",
            "x\n \t\n",
            "é漢字🙂🚀",
            "can't I'd we've",
            "\u{2003}\u{2028}",
            "## title\n## nested",
            "<EOT>",
            "x \r\n\t ",
        ];
        // The second round answers from the cache; both must match the encoder.
        for round in 0..2 {
            for left in bodies {
                for right in bodies {
                    let text = format!("## render {round}\n{left}\n\n## second\n{right}");
                    let expected = encode_ordinary(&text).len();
                    assert_eq!(estimate_history_render_tokens(&text), expected, "{text:?}");
                    assert_eq!(estimate_tokens(&text), expected, "{text:?}");
                    let first = format!("## render\n{left}");
                    let second = format!("## second\n{right}");
                    let joined = format!("{first}\n\n{second}");
                    assert_eq!(
                        history_render_paragraph_counts(&first),
                        history_paragraph_counts(&first),
                        "{first:?}"
                    );
                    assert_eq!(
                        history_render_paragraph_counts(&first).1
                            + history_render_paragraph_counts(&second).0,
                        encode_ordinary(&joined).len(),
                        "joined: {joined:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn history_render_cache_answers_a_repeat_without_tokenizing() {
        // Text no other test produces, so a parallel test cannot have cached it.
        let text = format!(
            "## {:?} repeat\nbody one\n\n## second\nbody two",
            std::thread::current().id()
        );
        let tokenizations = || RENDER_PIECE_TOKENIZATIONS.with(std::cell::Cell::get);
        let before = tokenizations();
        let cold = history_render_paragraph_counts(&text);
        let cold_work = tokenizations() - before;
        assert!(cold_work > 0);
        let before = tokenizations();
        assert_eq!(history_render_paragraph_counts(&text), cold);
        assert_eq!(
            tokenizations() - before,
            0,
            "a repeated count must be a cache hit"
        );
    }

    #[test]
    fn history_render_inserts_between_lookups_keep_the_byte_accounting_exact() {
        const BUDGET: usize = 4 * 1024;
        let mut cache = HistoryCounts::default();
        let texts: Vec<String> = (0..30)
            .map(|index| format!("## t{index}\n{}", "ab ".repeat(20 + index * 7)))
            .collect();
        for pair in texts.chunks(2) {
            // Two misses are looked up before either count is recorded, as when two
            // folds miss concurrently and insert after tokenizing outside the lock.
            for text in pair {
                assert_eq!(cache.lookup(text, false), None);
            }
            for text in pair {
                cache.insert_counted(text, false, text.len(), BUDGET);
            }
            assert_eq!(cache.entries.len(), cache.age.len());
            assert!(cache.bytes <= BUDGET);
            assert_eq!(
                cache.bytes,
                cache
                    .entries
                    .keys()
                    .map(|key| history_entry_cost(key.len()))
                    .sum::<usize>()
            );
            for (age, key) in &cache.age {
                assert_eq!(cache.entries[&**key].age, *age);
            }
        }
        let newest = texts.last().unwrap();
        assert_eq!(cache.lookup(newest, false), Some(newest.len()));
        // A concurrent insert of a text already present fills its other slot only.
        let bytes = cache.bytes;
        cache.insert_counted(newest, true, 7, BUDGET);
        assert_eq!(cache.bytes, bytes);
        assert_eq!(cache.lookup(newest, true), Some(7));
    }

    /// The cache as it was before entries shared their text between the lookup
    /// map and the recency index: every recency refresh copied the text. Kept
    /// only as the reference for the differential test below.
    #[derive(Default)]
    struct OwnedKeyHistoryCounts {
        entries: std::collections::HashMap<String, ([Option<usize>; 2], u64)>,
        age: std::collections::BTreeMap<u64, String>,
        clock: u64,
        bytes: usize,
    }

    impl OwnedKeyHistoryCounts {
        fn count(&mut self, text: &str, continued: bool, budget: usize) -> usize {
            let slot = usize::from(continued);
            self.clock += 1;
            if let Some(entry) = self.entries.get_mut(text) {
                self.age.remove(&entry.1);
                entry.1 = self.clock;
                self.age.insert(self.clock, text.to_owned());
                if let Some(count) = entry.0[slot] {
                    return count;
                }
            }
            let count = if continued {
                tokenizer().count_ordinary(&format!("{text}#")) - 1
            } else {
                tokenizer().count_ordinary(text)
            };
            if let Some(entry) = self.entries.get_mut(text) {
                entry.0[slot] = Some(count);
                return count;
            }
            let cost = text.len().saturating_mul(2).saturating_add(128);
            if cost > budget {
                return count;
            }
            while self.bytes + cost > budget {
                let (_, key) = self.age.pop_first().expect("non-empty bounded cache");
                self.bytes -= key.len() * 2 + 128;
                self.entries.remove(&key);
            }
            let mut counts = [None; 2];
            counts[slot] = Some(count);
            self.entries.insert(text.to_owned(), (counts, self.clock));
            self.age.insert(self.clock, text.to_owned());
            self.bytes += cost;
            count
        }
    }

    /// Drives the shared-key cache and the owned-key reference through the same
    /// sequence of lookups (hits, misses, both count slots, evictions and
    /// oversized bypasses) and requires identical counts, retained entries,
    /// recency order and byte accounting after every step. A small budget keeps
    /// the working set several times larger than the cache.
    #[test]
    fn shared_key_cache_matches_owned_key_reference() {
        const BUDGET: usize = 16 * 1024;
        let texts: Vec<String> = (0..40)
            .map(|index| {
                let bytes = match index % 7 {
                    0 => 3_000,
                    1 => 3,
                    _ => 200 * (index % 5 + 1),
                };
                format!("## t{index}\n{}", "ab ".repeat(bytes / 3 + 1))
            })
            .collect();
        // Larger than the whole budget: always counted, never cached.
        let oversized = "ab ".repeat(BUDGET / 6 + 1);
        let mut shared = HistoryCounts::default();
        let mut owned = OwnedKeyHistoryCounts::default();
        // Steps whose insertion evicted enough to shrink the cache; a lower
        // bound on eviction activity that proves the walk exercised it.
        let mut evictions = 0;
        // A fixed pseudo-random walk so the order is reproducible.
        let mut state: u64 = 0x9e37_79b9_7f4a_7c15;
        for step in 0..3_000 {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            let text = if step % 500 == 100 {
                &oversized
            } else {
                &texts[(state % texts.len() as u64) as usize]
            };
            let continued = (state >> 32) & 1 == 1;
            let bytes_before = shared.bytes;
            assert_eq!(
                shared.count_within(text, continued, BUDGET),
                owned.count(text, continued, BUDGET)
            );
            if shared.bytes < bytes_before {
                evictions += 1;
            }
            assert_eq!(shared.bytes, owned.bytes);
            assert_eq!(shared.clock, owned.clock);
            let shared_age: Vec<(u64, &str)> = shared.age.iter().map(|(k, v)| (*k, &**v)).collect();
            let owned_age: Vec<(u64, &str)> =
                owned.age.iter().map(|(k, v)| (*k, v.as_str())).collect();
            assert_eq!(shared_age, owned_age);
            for (key, entry) in &shared.entries {
                let reference = owned.entries.get(&**key).expect("same retained set");
                assert_eq!(entry.counts, reference.0);
                assert_eq!(entry.age, reference.1);
                assert!(Arc::ptr_eq(key, &entry.key));
            }
            assert_eq!(shared.entries.len(), owned.entries.len());
            assert!(shared.bytes <= BUDGET);
        }
        assert!(evictions > 100, "only {evictions} evicting steps");
    }
}
