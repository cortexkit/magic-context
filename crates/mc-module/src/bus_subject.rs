//! Subject checks for bus deliveries before their contents are handled.

use std::fmt::Debug;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const LOG_INTERVAL: Duration = Duration::from_secs(60);

/// Match a concrete NATS subject against a subscription pattern. A trailing
/// `>` needs at least one token, just like `*`, but consumes the whole tail.
fn matches(pattern: &str, subject: &str) -> bool {
    fn concrete(token: &str) -> bool {
        !token.is_empty()
            && !token.contains(['*', '>'])
            && !token.bytes().any(|byte| byte.is_ascii_whitespace())
    }

    let mut patterns = pattern.split('.').peekable();
    let mut tokens = subject.split('.');
    while let Some(pattern) = patterns.next() {
        let Some(token) = tokens.next().filter(|token| concrete(token)) else {
            return false;
        };
        match pattern {
            ">" => return patterns.peek().is_none() && tokens.all(concrete),
            "*" => {}
            literal if literal == token => {}
            _ => return false,
        }
    }
    tokens.next().is_none()
}

/// Count rejected deliveries even when their warnings are suppressed. Keep
/// one counter and log budget per reader, not per subject or binding, so a
/// sender cannot get more warnings printed by varying subjects or rebinding.
#[derive(Default)]
pub(crate) struct SubjectDrops {
    count: AtomicU64,
    last_log: Mutex<Option<Instant>>,
}

impl SubjectDrops {
    pub(crate) const fn new() -> Self {
        Self {
            count: AtomicU64::new(0),
            last_log: Mutex::new(None),
        }
    }

    #[cfg(test)]
    pub(crate) fn count(&self) -> u64 {
        self.count.load(Ordering::Relaxed)
    }

    pub(crate) fn accepts(&self, patterns: &[impl AsRef<str> + Debug], subject: &str) -> bool {
        if patterns
            .iter()
            .any(|pattern| matches(pattern.as_ref(), subject))
        {
            return true;
        }

        let dropped = self.count.fetch_add(1, Ordering::Relaxed) + 1;
        if let Ok(mut last) = self.last_log.try_lock() {
            let now = Instant::now();
            if last.is_none_or(|prev| now.duration_since(prev) >= LOG_INTERVAL) {
                *last = Some(now);
                tracing::warn!(
                    subject = ?subject,
                    expected = ?patterns,
                    dropped,
                    "ck-mc: dropped a bus delivery with an unexpected subject"
                );
            }
        }
        false
    }
}

#[cfg(test)]
#[path = "bus_subject_tests.rs"]
mod tests;
