//! Log capture for the crate's tests, through one subscriber for the whole
//! test process.
//!
//! `tracing` keeps, per call site, one answer for the whole process to
//! whether any subscriber wants its events. It works that answer out the
//! first time some thread reaches the call site, and works it out again only
//! when a new subscriber is created (`tracing-core` 0.1.36,
//! `callsite.rs:305-343` and `484-507`). While a single subscriber exists,
//! it asks only the default subscriber of the thread that got there first
//! (`callsite.rs:544-575`, `dispatcher.rs:379-398`). So if each test set a
//! subscriber for its own thread, a call site first reached on a thread that
//! captures nothing would be remembered as wanted by nobody, and a test
//! capturing on another thread would miss that line. What a test captured
//! would then depend on which tests run beside it and in what order.
//!
//! So no test sets a subscriber of its own. The first capture installs one
//! subscriber for the process, which tells every call site that it may be
//! wanted. That answer is the same whichever thread asks, so it is safe to
//! remember. Per event, the subscriber then checks whether a capture is
//! active on the thread that logs it, and writes the line only to that
//! capture. `capture_source_has_no_other_subscriber` keeps it the only
//! subscriber in the crate's sources.

use std::cell::RefCell;
use std::future::Future;
use std::marker::PhantomData;
use std::sync::{Arc, Mutex, Once};

use tracing::subscriber::Interest;
use tracing::{Metadata, Subscriber};
use tracing_subscriber::layer::{Context, Layer, SubscriberExt};

type Sink = Arc<Mutex<Vec<u8>>>;

thread_local! {
    /// The captures active on this thread, innermost last. A line goes to
    /// the innermost one only.
    static ACTIVE: RefCell<Vec<Sink>> = const { RefCell::new(Vec::new()) };
}

/// Install the process's one subscriber, the first time a test captures.
/// It formats lines as every capture in this crate always has: the fmt
/// subscriber's defaults (level `INFO` and up), without timestamps or
/// colours.
fn install() {
    static INSTALL: Once = Once::new();
    INSTALL.call_once(|| {
        let subscriber = tracing_subscriber::fmt()
            .without_time()
            .with_ansi(false)
            .with_writer(|| Innermost)
            .finish()
            .with(Capturing);
        tracing::subscriber::set_global_default(subscriber)
            .expect("only the test log capture sets a subscriber for the test process");
    });
}

/// Tells every call site that it may be wanted, and then wants an event only
/// on a thread where a capture is active.
struct Capturing;

impl<S: Subscriber> Layer<S> for Capturing {
    fn register_callsite(&self, _: &'static Metadata<'static>) -> Interest {
        Interest::sometimes()
    }

    fn enabled(&self, _: &Metadata<'_>, _: Context<'_, S>) -> bool {
        ACTIVE.with_borrow(|active| !active.is_empty())
    }
}

/// Writes a formatted line to the innermost capture of the logging thread.
struct Innermost;

impl std::io::Write for Innermost {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        ACTIVE.with_borrow(|active| {
            if let Some(sink) = active.last() {
                sink.lock().unwrap().extend_from_slice(bytes);
            }
        });
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Make `sink` the innermost capture of this thread until the returned
/// guard is dropped.
fn enter(sink: &Sink) -> Entered {
    ACTIVE.with_borrow_mut(|active| active.push(Arc::clone(sink)));
    Entered {
        sink: Arc::clone(sink),
        _thread: PhantomData,
    }
}

/// While it lives, its capture is active on the thread that made it.
struct Entered {
    sink: Sink,
    /// Not `Send`: the capture must end on the thread it is active on.
    _thread: PhantomData<*const ()>,
}

impl Drop for Entered {
    fn drop(&mut self) {
        ACTIVE.with_borrow_mut(|active| {
            if let Some(at) = active
                .iter()
                .rposition(|sink| Arc::ptr_eq(sink, &self.sink))
            {
                active.remove(at);
            }
        });
    }
}

/// The lines logged on this thread from [`capture`] until it is stopped or
/// dropped.
/// The crate's async tests use `#[tokio::test]`, whose runtime polls every
/// task on the test's own thread. So a task the code under test spawns (the
/// per-session task that handles a session's notices and rides, for one) logs
/// on this thread and is captured too. Lines logged on other threads (a
/// `spawn_blocking` closure's, for one) are not.
pub(crate) struct Capture {
    sink: Sink,
    /// `None` once the capture is stopped.
    entered: Option<Entered>,
}

/// Capture every line logged on this thread from here on.
pub(crate) fn capture() -> Capture {
    install();
    let sink = Sink::default();
    Capture {
        entered: Some(enter(&sink)),
        sink,
    }
}

impl Capture {
    /// Stop capturing; what was captured stays readable.
    pub(crate) fn stop(&mut self) {
        self.entered = None;
    }
    /// Every line captured so far.
    pub(crate) fn text(&self) -> String {
        String::from_utf8(self.sink.lock().unwrap().clone()).unwrap()
    }

    /// How many times `needle` occurs in what was captured so far.
    pub(crate) fn count(&self, needle: &str) -> usize {
        self.text().matches(needle).count()
    }
}

/// Run `body` and return what it returned and the lines it logged on this
/// thread.
pub(crate) fn logged<R>(body: impl FnOnce() -> R) -> (R, String) {
    let capture = capture();
    let result = body();
    (result, capture.text())
}

/// Await `body` and return its output and the lines logged on this thread
/// while it was being polled, not while other tasks ran between its polls.
pub(crate) async fn logged_async<F: Future>(body: F) -> (F::Output, String) {
    install();
    let sink = Sink::default();
    let mut body = Box::pin(body);
    let result = std::future::poll_fn(|cx| {
        let _entered = enter(&sink);
        body.as_mut().poll(cx)
    })
    .await;
    let text = String::from_utf8(sink.lock().unwrap().clone()).unwrap();
    (result, text)
}

/// `log` with the elapsed milliseconds in Setup's completion line blanked:
/// two runs of the same work log the same lines but not the same time.
pub(crate) fn without_timings(log: &str) -> String {
    static TIMING: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    TIMING
        .get_or_init(|| regex::Regex::new(r"setup done in \d+ ms").unwrap())
        .replace_all(log, "setup done in _ ms")
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    // `event!` with a level rather than `info!` and the like: the issue-log
    // template generator collects every `tracing::info!`-style call in the
    // crate as a line ck-mc ships, and these lines are only the tests'.
    use tracing::Level;

    fn reached_elsewhere_first() {
        tracing::event!(Level::INFO, "test_log: a line another thread reached first");
    }

    /// The case per-thread subscribers got wrong: another thread, which
    /// captures nothing, reaches the call site first. The capturing thread
    /// still gets the line, and the other thread's line goes nowhere.
    #[test]
    fn a_line_first_reached_on_a_thread_that_captures_nothing_is_still_captured() {
        let log = capture();
        std::thread::spawn(reached_elsewhere_first).join().unwrap();
        reached_elsewhere_first();
        assert_eq!(log.count("a line another thread reached first"), 1);
    }

    /// Each capture holds only its own thread's lines, a nested capture
    /// takes the lines logged while it is active, and the outer one gets
    /// the lines again once the inner one has ended.
    #[test]
    fn a_capture_holds_its_own_threads_lines_and_the_innermost_takes_them() {
        let outer = capture();
        tracing::event!(Level::INFO, "test_log: outer before");
        let (_, inner) = logged(|| tracing::event!(Level::WARN, "test_log: inner"));
        std::thread::spawn(|| {
            let other = capture();
            tracing::event!(Level::INFO, "test_log: another thread");
            assert_eq!(other.count("test_log: another thread"), 1);
        })
        .join()
        .unwrap();
        tracing::event!(Level::INFO, "test_log: outer after");
        assert_eq!(inner.matches("test_log: inner").count(), 1);
        assert!(inner.contains("WARN"), "{inner}");
        let text = outer.text();
        assert_eq!(text.matches("test_log: outer").count(), 2, "{text}");
        assert!(!text.contains("test_log: inner"), "{text}");
        assert!(!text.contains("test_log: another thread"), "{text}");
        tracing::event!(Level::DEBUG, "test_log: below the level");
        assert_eq!(outer.count("below the level"), 0);
    }

    /// An async capture holds what its future logs while it is polled, and
    /// not what another task on the same thread logs between its polls.
    #[tokio::test]
    async fn an_async_capture_holds_only_what_its_own_future_logs() {
        let other = tokio::spawn(async {
            tokio::task::yield_now().await;
            tracing::event!(Level::INFO, "test_log: another task");
        });
        let ((), text) = logged_async(async {
            tracing::event!(Level::INFO, "test_log: this future");
            tokio::task::yield_now().await;
            tokio::task::yield_now().await;
            tracing::event!(Level::INFO, "test_log: this future again");
        })
        .await;
        other.await.unwrap();
        assert_eq!(text.matches("test_log: this future").count(), 2, "{text}");
        assert!(!text.contains("another task"), "{text}");
    }

    /// Only this module sets a subscriber in the crate. Any other subscriber,
    /// even one scoped to a thread or a future, would again make what a test
    /// captures depend on which thread reached a call site first.
    #[test]
    fn capture_source_has_no_other_subscriber() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut files = Vec::new();
        let mut folders = vec![root.join("src"), root.join("tests")];
        while let Some(folder) = folders.pop() {
            for entry in std::fs::read_dir(&folder).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    folders.push(path);
                } else if path.extension().is_some_and(|ext| ext == "rs") {
                    files.push(path);
                }
            }
        }
        let this = root.join("src").join("test_log.rs");
        let forbidden = [
            "tracing_subscriber::",
            "set_global_default",
            "subscriber::set_default",
            "subscriber::with_default",
            "dispatcher::set_default",
            "dispatcher::with_default",
            "with_subscriber(",
            "WithSubscriber",
        ];
        let mut found = Vec::new();
        for file in files.iter().filter(|file| **file != this) {
            let source = std::fs::read_to_string(file).unwrap();
            for needle in forbidden {
                if source.contains(needle) {
                    found.push(format!("{}: {needle}", file.display()));
                }
            }
        }
        assert!(
            found.is_empty(),
            "capture logs with crate::test_log, never with a subscriber of the test's own: {found:?}"
        );
    }
}
