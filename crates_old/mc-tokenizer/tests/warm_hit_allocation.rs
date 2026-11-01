//! A token count served from the history cache must not copy the counted text.
//!
//! This test binary installs a counting global allocator that records the bytes
//! requested by the calling thread only, so allocations made by other test
//! threads cannot leak into the measurement. It lives in its own binary because
//! a global allocator applies to every test linked with it.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

struct ThreadCountingAllocator;

thread_local! {
    static ALLOCATED_BYTES: Cell<usize> = const { Cell::new(0) };
    static ALLOCATION_CALLS: Cell<usize> = const { Cell::new(0) };
}

fn record(size: usize) {
    // `try_with` because the allocator can run while thread-locals are being
    // torn down at thread exit.
    let _ = ALLOCATED_BYTES.try_with(|bytes| bytes.set(bytes.get() + size));
    let _ = ALLOCATION_CALLS.try_with(|calls| calls.set(calls.get() + 1));
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

/// Bytes and allocation calls requested by this thread while running `f`.
fn measure(f: impl FnOnce()) -> (usize, usize) {
    let bytes_before = ALLOCATED_BYTES.with(Cell::get);
    let calls_before = ALLOCATION_CALLS.with(Cell::get);
    f();
    (
        ALLOCATED_BYTES.with(Cell::get) - bytes_before,
        ALLOCATION_CALLS.with(Cell::get) - calls_before,
    )
}

const WARM_CALLS: usize = 100;

/// Counts `text` once to fill the cache, then measures `WARM_CALLS` cached
/// counts. Every warm count must equal the cold one.
fn warm_hit_allocation(text: &str) -> (usize, usize) {
    let cold = mc_tokenizer::estimate_tokens(text);
    assert_eq!(cold, mc_tokenizer::encode_ordinary(text).len());
    measure(|| {
        for _ in 0..WARM_CALLS {
            assert_eq!(mc_tokenizer::estimate_tokens(text), cold);
        }
    })
}

#[test]
fn warm_cache_hits_allocate_no_text_bytes() {
    // One chunk each (no `\n\n## ` separators), from 1 KiB to 512 KiB, all small
    // enough to be cached.
    let mut measured = Vec::new();
    for len in [1024usize, 64 * 1024, 512 * 1024] {
        let text = "word ".repeat(len / 5);
        let (bytes, calls) = warm_hit_allocation(&text);
        eprintln!("warm hits: text_bytes={} allocated_bytes={bytes} allocation_calls={calls} over {WARM_CALLS} calls", text.len());
        measured.push((text.len(), bytes));
    }
    for (text_len, bytes) in &measured {
        // A single copy of the text on any one hit would exceed this bound for
        // every size measured; the recency index itself may allocate a node.
        assert!(
            *bytes < 1024,
            "warm hits on a {text_len}-byte text allocated {bytes} bytes"
        );
    }
    // Allocation must not scale with the text length.
    assert_eq!(measured[0].1, measured[2].1, "{measured:?}");
}
