//! A separate host-like writer times its BEGIN IMMEDIATE wait separately from COMMIT,
//! whose elapsed time includes any automatic PASSIVE checkpoint it performs.

use rusqlite::{Connection, TransactionBehavior};
use std::collections::BTreeMap;
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

pub(super) struct Sample {
    phase: &'static str,
    wait: Duration,
    commit: Duration,
    error: Option<String>,
}

pub(super) struct Writer {
    phase: Arc<Mutex<&'static str>>,
    stop: Option<mpsc::Sender<()>>,
    task: Option<JoinHandle<Result<Vec<Sample>, String>>>,
}

impl Writer {
    pub(super) fn start(path: &std::path::Path) -> Self {
        let path = path.to_owned();
        let phase = Arc::new(Mutex::new("idle-before"));
        let shared_phase = Arc::clone(&phase);
        let (stop, stopping) = mpsc::channel();
        let (ready, started) = mpsc::sync_channel(0);
        let task = thread::spawn(move || -> Result<Vec<Sample>, String> {
            let mut conn = Connection::open(path).map_err(|e| e.to_string())?;
            conn.busy_timeout(Duration::from_secs(5))
                .map_err(|e| e.to_string())?;
            conn.pragma_update(None, "synchronous", "NORMAL")
                .map_err(|e| e.to_string())?;
            conn.execute_batch(
                "CREATE TABLE move_writer_probe(id INTEGER PRIMARY KEY, content TEXT NOT NULL)",
            )
            .map_err(|e| e.to_string())?;
            let checkpoint: i64 = conn
                .query_row("PRAGMA wal_autocheckpoint", [], |row| row.get(0))
                .map_err(|e| e.to_string())?;
            eprintln!("HOST_WRITER wal_autocheckpoint={checkpoint}");
            let mut samples = Vec::new();
            ready.send(()).map_err(|e| e.to_string())?;
            loop {
                let phase = *shared_phase.lock().unwrap();
                let started = Instant::now();
                let attempt = (|| {
                    let tx = conn
                        .transaction_with_behavior(TransactionBehavior::Immediate)
                        .map_err(|e| format!("companion writer BEGIN during {phase}: {e}"))?;
                    let wait = started.elapsed();
                    tx.execute("INSERT INTO move_writer_probe(content) VALUES ('an unrelated host session made a small write')", [])
                        .map_err(|e| e.to_string())?;
                    let committing = Instant::now();
                    tx.commit()
                        .map_err(|e| format!("companion writer COMMIT during {phase}: {e}"))?;
                    Ok::<_, String>((wait, committing.elapsed()))
                })();
                let (wait, commit, error) = match attempt {
                    Ok((wait, commit)) => (wait, commit, None),
                    Err(error) => (started.elapsed(), Duration::ZERO, Some(error)),
                };
                samples.push(Sample {
                    phase,
                    wait,
                    commit,
                    error,
                });
                match stopping
                    .recv_timeout(Duration::from_millis(10).saturating_sub(started.elapsed()))
                {
                    Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                }
            }
            Ok(samples)
        });
        started
            .recv()
            .expect("companion writer failed to initialize");
        Self {
            phase,
            stop: Some(stop),
            task: Some(task),
        }
    }

    pub(super) fn phase(&self, phase: &'static str) {
        *self.phase.lock().unwrap() = phase;
    }

    pub(super) fn finish(mut self) -> Vec<Sample> {
        let _ = self.stop.take().unwrap().send(());
        self.task
            .take()
            .unwrap()
            .join()
            .expect("companion writer panicked")
            .expect("companion writer failed")
    }
}

impl Drop for Writer {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(task) = self.task.take() {
            let _ = task.join();
        }
    }
}

#[derive(Default)]
struct Totals {
    count: usize,
    wait: Duration,
    commit: Duration,
    pair: Duration,
}

pub(super) fn report(samples: Vec<Sample>, fixture: &str) {
    let mut groups = BTreeMap::<&str, Totals>::new();
    let mut errors = Vec::new();
    for sample in samples {
        if let Some(error) = sample.error {
            errors.push(error);
        }
        for phase in [
            sample.phase,
            if sample.phase.starts_with("idle-") {
                "no-move"
            } else {
                "with-move"
            },
        ] {
            let group = groups.entry(phase).or_default();
            group.count += 1;
            group.wait = group.wait.max(sample.wait);
            group.commit = group.commit.max(sample.commit);
            group.pair = group.pair.max(sample.wait + sample.commit);
        }
    }
    for (phase, group) in &groups {
        eprintln!("HOST_WRITER fixture={fixture} phase={phase} count={} max_wait={:.3}ms max_commit={:.3}ms max_wait_plus_commit={:.3}ms sum_maxima={:.3}ms",
            group.count, group.wait.as_secs_f64()*1000.0, group.commit.as_secs_f64()*1000.0,
            group.pair.as_secs_f64()*1000.0, (group.wait+group.commit).as_secs_f64()*1000.0);
    }
    for error in errors {
        eprintln!("HOST_WRITER fixture={fixture} error={error}");
    }
}
