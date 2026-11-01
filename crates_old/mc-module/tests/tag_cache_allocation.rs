//! Tag-cache allocation must not scale with historical tag payloads.
//!
//! A session keeps tag rows (with their stored source bytes) for blocks that have long left the
//! live projection. Those payloads are retained for recovery, but an ordinary pass that mints
//! nothing, or mints one tag, must not copy them. This binary installs a counting global
//! allocator that records bytes requested by the calling thread only, runs real transforms
//! against stores seeded with small and large historical payloads, and requires the measured
//! passes to allocate the same amount either way.
//!
//! The allocator lives in its own test binary because a global allocator applies to every test
//! linked with it.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
use mc_module::config::CacheTtlProvenance;
use mc_module::transform::{transform, ProducerContext, TransformRequest};
use mc_store::McStore;
use serde_json::json;
use sha2::{Digest, Sha256};

struct ThreadCountingAllocator;

thread_local! {
    static ALLOCATED_BYTES: Cell<usize> = const { Cell::new(0) };
}

fn record(size: usize) {
    // `try_with` because the allocator can run while thread-locals are being torn down.
    let _ = ALLOCATED_BYTES.try_with(|bytes| bytes.set(bytes.get() + size));
}

unsafe impl GlobalAlloc for ThreadCountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record(layout.size());
        System.alloc(layout)
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        record(layout.size());
        System.alloc_zeroed(layout)
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        record(new_size);
        System.realloc(ptr, layout, new_size)
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout)
    }
}

#[global_allocator]
static ALLOCATOR: ThreadCountingAllocator = ThreadCountingAllocator;

const HISTORICAL_TAGS: usize = 300;
const LIVE_MESSAGES: usize = 20;

fn descriptor(dir: &std::path::Path) -> StorageDescriptor {
    StorageDescriptor {
        module_id: "magic-context-test".to_string(),
        storage_namespace: "mc_cache".to_string(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: dir.join("store.db").to_string_lossy().to_string(),
        },
    }
}

fn context(dir: &str) -> ProducerContext<'_> {
    ProducerContext {
        project_path: "git:alloc",
        note_project_path: "git:alloc",
        project_directory: dir,
        history_budget_tokens: 60_000.0,
        memory_budget_tokens: 8_000.0,
        user_profile_budget_tokens: 4_000.0,
        memory_enabled: false,
        inject_docs: false,
        temporal_awareness: true,
        now_ms: 1_800_000_000_000,
        execute_threshold_percentage: 65.0,
        protected_tokens_floor: 16_000,
        protected_tokens_provenance: "derived",
        compaction_enabled: true,
        signed_thinking_hold: mc_module::config::SignedThinkingHold::Off,
        smart_drops: false,
        protected_tools: [("todowrite".to_string(), 1), ("ctx_reduce".to_string(), 3)].into(),
        cache_ttl: "5m".to_string(),
        cache_ttl_provenance: CacheTtlProvenance::Default,
        cache_ttl_policy: None,
        model_key: None,
        observed_last_response_at_ms: None,
        guidance_date: None,
        historian_active: false,
        wrapup_active: false,
        caveman_english_word_rules: true,
    }
}

fn request(session: &str, messages: usize) -> TransformRequest {
    let messages = (0..messages)
        .map(|index| {
            json!({
                "mid": format!("live-{index}"),
                "ordinal": HISTORICAL_TAGS + index + 1,
                "ck": {
                    "role": if index % 2 == 0 { "user" } else { "assistant" },
                    "content": [{ "kind": { "type": "text", "text": format!("live message {index}") } }],
                    "meta": {
                        "harness_id": format!("live-{index}"),
                        "created_at_ms": 1_799_999_000_000i64 + index as i64 * 1_000,
                    },
                },
            })
        })
        .collect::<Vec<_>>();
    serde_json::from_value(json!({
        "kind": "transform",
        "v": 2,
        "serializer_profile": "opencode-aisdk",
        "tool_present": true,
        "session_id": session,
        "render_config": "alloc",
        "messages": messages,
    }))
    .expect("transform request")
}

/// Bytes the calling thread requested while running `f`.
fn allocated_by<T>(f: impl FnOnce() -> T) -> (T, usize) {
    let before = ALLOCATED_BYTES.with(Cell::get);
    let value = f();
    (value, ALLOCATED_BYTES.with(Cell::get) - before)
}

struct PassAllocations {
    append_load: usize,
    no_mint: usize,
    one_mint: usize,
    digests: Vec<String>,
    tag_numbers: Vec<i64>,
}

/// Seeds `HISTORICAL_TAGS` rows for blocks outside the live projection, each carrying
/// `payload` source bytes, then runs: bootstrap (mints the live tags), a replay that extends the
/// retained tag baseline with those mints, a replay that mints nothing, and a pass that appends
/// one message and mints one tag. Returns the allocation of the last three.
fn run(payload: usize) -> PassAllocations {
    let session = format!("alloc-{payload}");
    let dir = tempfile::tempdir().unwrap();
    drop(McStore::open(&descriptor(dir.path())).unwrap());
    {
        let conn = rusqlite::Connection::open(dir.path().join("store.db")).unwrap();
        let source = vec![b'h'; payload];
        for number in 1..=HISTORICAL_TAGS as i64 {
            conn.execute(
                "INSERT INTO mc_tags
                     (session_id, tag_number, block_id, kind, token_count, created_at_ms, source_bytes)
                 VALUES (?1, ?2, ?3, 'message', 10, 1, ?4)",
                rusqlite::params![session, number, format!("gone-{number}#0"), source],
            )
            .unwrap();
        }
    }
    let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
    let dir_text = dir.path().to_str().unwrap().to_string();
    let ctx = context(&dir_text);
    let live = request(&session, LIVE_MESSAGES);
    let appended = request(&session, LIVE_MESSAGES + 1);
    let mut digests = Vec::new();
    let mut pass = |req: &TransformRequest| {
        let (response, bytes) = allocated_by(|| transform(&store, req, &ctx).unwrap());
        let mut digest = Sha256::new();
        for message in response.messages() {
            digest.update(serde_json::to_vec(&**message).unwrap());
        }
        digests.push(format!("{}:{:x}", response.action, digest.finalize()));
        bytes
    };
    pass(&live);
    let append_load = pass(&live);
    let no_mint = pass(&live);
    let one_mint = pass(&appended);
    let tag_numbers = store
        .load_tags_for_session(&session)
        .unwrap()
        .iter()
        .map(|tag| tag.tag_number)
        .collect();
    PassAllocations {
        append_load,
        no_mint,
        one_mint,
        digests,
        tag_numbers,
    }
}

#[test]
fn tag_cache_allocation_is_independent_of_historical_payloads() {
    // Process-wide caches (token counts, rendered prompt pieces) fill on the first sessions
    // this binary runs; a warm-up session keeps those one-time fills out of the comparison.
    run(2048);
    let small = run(1024);
    let large = run(64 * 1024);
    let historical_delta = HISTORICAL_TAGS * (64 * 1024 - 1024);
    for (name, small_bytes, large_bytes) in [
        ("append_load", small.append_load, large.append_load),
        ("no_mint", small.no_mint, large.no_mint),
        ("one_mint", small.one_mint, large.one_mint),
    ] {
        eprintln!(
            "tag-cache-allocation pass={name} small_payload_bytes={small_bytes} large_payload_bytes={large_bytes} historical_source_delta={historical_delta}"
        );
        // One copy of the historical payloads would add `historical_delta` bytes; allow only a
        // small fraction of a single payload for incidental differences.
        assert!(
            large_bytes.abs_diff(small_bytes) < 16 * 1024,
            "{name}: {small_bytes} bytes with 1 KiB payloads vs {large_bytes} with 64 KiB"
        );
    }
    // Historical payload size must not change what is served or which tags exist.
    assert_eq!(small.digests, large.digests);
    assert_eq!(small.tag_numbers, large.tag_numbers);
    assert_eq!(
        small.tag_numbers.len(),
        HISTORICAL_TAGS + LIVE_MESSAGES + 1,
        "every live message and the appended one were tagged"
    );
}
