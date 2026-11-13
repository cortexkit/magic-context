//! One opt-in sample; a caller interleaves the old and new executables.
use super::*;
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering::Relaxed};

struct Allocator;
static LIVE: AtomicI64 = AtomicI64::new(0);
static COUNT: AtomicU64 = AtomicU64::new(0);
static BYTES: AtomicU64 = AtomicU64::new(0);
static ACTIVE: AtomicBool = AtomicBool::new(false);
static SENDS: AtomicU64 = AtomicU64::new(0);

// Charge requested Rust heap bytes, not allocator size classes or resident set
// size (RSS). Realloc
// counts as one allocation operation, including when System grows in place.
unsafe impl GlobalAlloc for Allocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let ptr = System.alloc(layout);
        if !ptr.is_null() {
            LIVE.fetch_add(layout.size() as i64, Relaxed);
            if ACTIVE.load(Relaxed) {
                COUNT.fetch_add(1, Relaxed);
                BYTES.fetch_add(layout.size() as u64, Relaxed);
            }
        }
        ptr
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let ptr = System.alloc_zeroed(layout);
        if !ptr.is_null() {
            LIVE.fetch_add(layout.size() as i64, Relaxed);
            if ACTIVE.load(Relaxed) {
                COUNT.fetch_add(1, Relaxed);
                BYTES.fetch_add(layout.size() as u64, Relaxed);
            }
        }
        ptr
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        LIVE.fetch_sub(layout.size() as i64, Relaxed);
        System.dealloc(ptr, layout);
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        let next = System.realloc(ptr, layout, size);
        if !next.is_null() {
            LIVE.fetch_add(size as i64 - layout.size() as i64, Relaxed);
            if ACTIVE.load(Relaxed) {
                COUNT.fetch_add(1, Relaxed);
                BYTES.fetch_add(size as u64, Relaxed);
            }
        }
        next
    }
}

#[global_allocator]
static ALLOCATOR: Allocator = Allocator;

#[cfg(feature = "notice-cost-timing")]
include!("summary-due-cost.inc.rs");

// A wire round-trip gives the session its own payload buffers, as a real
// runner read does. Otherwise shared Text would also belong to the fixture,
// understating the session's held memory after the port.
struct WireClient(Client);
impl RunnerClient for WireClient {
    async fn read(&self, key: &SessionRef, request: ReadRequest) -> Result<ReadPage, ClientError> {
        let page = self.0.read(key, request).await?;
        Ok(serde_json::from_slice(&serde_json::to_vec(&page).unwrap()).unwrap())
    }
    async fn apply_view(
        &self,
        key: &SessionRef,
        request: ApplyViewRequest,
    ) -> Result<ApplyViewAnswer, ClientError> {
        self.0.apply_view(key, request).await
    }
    async fn applied_view(&self, key: &SessionRef) -> Result<AppliedViewAnswer, ClientError> {
        self.0.applied_view(key).await
    }
    async fn send(&self, _: &SessionRef, _: SendRequest) -> Result<SendReply, ClientError> {
        SENDS.fetch_add(1, Relaxed);
        Ok(SendReply::new("pending"))
    }
    async fn send_child(&self, _: &Child, _: SendRequest) -> Result<SendReply, ClientError> {
        panic!("worker has no summarizer")
    }
    async fn child_result(&self, _: &Child, _: RunResultRequest) -> Result<RunResult, ClientError> {
        panic!("worker has no summarizer")
    }
}

#[test]
#[ignore = "opt-in release held-heap / ordinary notice allocation and CPU sample"]
#[allow(
    clippy::assertions_on_constants,
    reason = "compile in debug builds, but refuse to measure them"
)]
fn compaction_port_sample() {
    assert!(!cfg!(debug_assertions), "measure an optimized executable");
    let size: usize = std::env::var("COMPACTION_PORT_ENTRIES")
        .unwrap()
        .parse()
        .unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let original = Arc::new(
            (1..=size)
                .map(|n| cycle(Shape::OpenCode2, n as u64, n - 1))
                .collect(),
        );
        let client = WireClient(Client(Arc::new(Mutex::new(RunnerState {
            original,
            added: vec![],
            view: View::seal(0, vec![]),
            offered: 0,
            views: vec![],
            record_views: false,
            foreground_reads: 0,
            background_reads: 0,
        }))));
        let route = Route {
            session: SessionRef::new("runner", "opencode2", "port-cost"),
            project: None,
            workdir: None,
            agent_id: None,
        };
        let setup = SetupRequest::new("worker", model(), WINDOW, RESERVE, rules(), vec![], 1)
            .with_newest(client.0.newest());
        let settings = Settings::default();
        let features = mc_module::preset::features("worker").unwrap();
        // Warm process-wide caches and async machinery with a complete setup,
        // outside the retained-byte interval. Its session is then discarded.
        let mut warm = Session::new(&route, &setup, features, None);
        warm.setup(&client, &settings, &route, &setup, features)
            .await;
        drop(warm);
        let before = LIVE.load(Relaxed);
        let mut session = Session::new(&route, &setup, features, None);
        session
            .setup(&client, &settings, &route, &setup, features)
            .await;
        let held = LIVE.load(Relaxed) - before;
        for seq in 1..=3 {
            let entries = client.0.step(Shape::OpenCode2);
            let wire = serde_json::to_vec(&request(&client.0, seq, entries, false)).unwrap();
            let notice = serde_json::from_slice(&wire).unwrap();
            assert!(session.notice(&client, &settings, notice).await.is_none());
        }
        let entries = client.0.step(Shape::OpenCode2);
        let wire = serde_json::to_vec(&request(&client.0, 4, entries, false)).unwrap();
        // Include the wire decode and full Session::notice, but exclude fixture
        // work, clock syscalls and printing from the exact allocation interval.
        COUNT.store(0, Relaxed);
        let sends = SENDS.load(Relaxed);
        let cpu = cpu_us();
        ACTIVE.store(true, Relaxed);
        let notice = serde_json::from_slice(&wire).unwrap();
        let summary = session.notice(&client, &settings, notice).await;
        ACTIVE.store(false, Relaxed);
        let elapsed = cpu_us() - cpu;
        let allocations = COUNT.load(Relaxed);
        assert!(summary.is_none());
        assert_eq!(
            SENDS.load(Relaxed),
            sends,
            "timed notice must not send a reminder"
        );
        assert_eq!(
            client.0 .0.lock().unwrap().offered,
            0,
            "ordinary notice must not rebuild"
        );
        println!(
            "COMPACTION_PORT_SAMPLE {}",
            json!({"entries":size,"held_bytes":held,"allocations":allocations,"cpu_us":elapsed})
        );
    });
}
