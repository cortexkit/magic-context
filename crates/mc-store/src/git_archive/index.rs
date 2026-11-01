//! Bounded git-log ingestion with the TypeScript producer's reachable-SHA semantics.
//! The caller supplies the opaque project identity separately from the repository directory.

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{mpsc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const GIT_TIMEOUT: Duration = Duration::from_secs(10);
pub const GIT_MAX_BUFFER: usize = 32 * 1024 * 1024;
pub const DEFAULT_MAX_COMMITS: f64 = 5_000.0;
const DAY_MS: i64 = 86_400_000;
const FORMAT: &str = "--format=%H\x1f%s\x1f%ae\x1f%ct\x1f%b\x1e";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub sha: String,
    pub short_sha: String,
    pub message: String,
    pub author: Option<String>,
    pub committed_at_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GitLogFailure {
    NotARepo,
    NoHead,
    Transient,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitReadResult {
    pub commits: Vec<GitCommit>,
    pub failure: Option<GitLogFailure>,
}

#[derive(Debug, Clone)]
pub struct ReadOptions {
    pub branch: String,
    pub since_ms: Option<i64>,
    pub max_commits: f64,
    pub exclude_reachable_from: Option<String>,
}

impl Default for ReadOptions {
    fn default() -> Self {
        Self {
            branch: "HEAD".into(),
            since_ms: None,
            max_commits: DEFAULT_MAX_COMMITS,
            exclude_reachable_from: None,
        }
    }
}

/// Supplies subprocess output, allowing deterministic failure tests without altering PATH.
pub trait GitLogRunner {
    fn run(&self, directory: &Path, args: &[String]) -> Result<String, String>;
}

pub struct GitCommand;

impl GitLogRunner for GitCommand {
    fn run(&self, directory: &Path, args: &[String]) -> Result<String, String> {
        let mut command = Command::new("git");
        command
            .args(args)
            .current_dir(directory)
            .env("LC_ALL", "C")
            .env("LANG", "C");
        run_command(command, GIT_TIMEOUT, GIT_MAX_BUFFER)
    }
}

// Drain both pipes while git runs: waiting before reading can deadlock on a full pipe.
fn read_pipe(mut pipe: impl Read, limit: usize) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut chunk = [0; 8192];
    loop {
        let count = pipe.read(&mut chunk).map_err(|error| error.to_string())?;
        if count == 0 {
            return Ok(bytes);
        }
        if count > limit.saturating_sub(bytes.len()) {
            return Err("git output exceeded maxBuffer".into());
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
}

fn run_command(mut command: Command, timeout: Duration, limit: usize) -> Result<String, String> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| error.to_string())?;
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let (sender, receiver) = mpsc::channel();
    let out_sender = sender.clone();
    thread::spawn(move || {
        let _ = out_sender.send((true, read_pipe(stdout, limit)));
    });
    thread::spawn(move || {
        let _ = sender.send((false, read_pipe(stderr, limit)));
    });
    let start = Instant::now();
    let mut out = None;
    let mut err = None;
    let result = loop {
        while let Ok((is_stdout, bytes)) = receiver.try_recv() {
            match bytes {
                Ok(bytes) if is_stdout => out = Some(bytes),
                Ok(bytes) => err = Some(bytes),
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(error);
                }
            }
        }
        match child.try_wait() {
            Ok(Some(status)) if out.is_some() && err.is_some() => {
                break if status.success() {
                    Ok(String::from_utf8_lossy(&out.unwrap()).into_owned())
                } else {
                    Err(format!(
                        "git exited with {status}: {}",
                        String::from_utf8_lossy(&err.unwrap())
                    ))
                };
            }
            Err(error) => break Err(error.to_string()),
            _ => {}
        }
        if start.elapsed() >= timeout {
            break Err("git log timed out".into());
        }
        thread::sleep(Duration::from_millis(5));
    };
    if result.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    result
}

pub fn classify_failure(message: &str) -> GitLogFailure {
    if message.contains("not a git repository") {
        GitLogFailure::NotARepo
    } else if message.contains("unknown revision or path not in the working tree")
        || message.contains("does not have any commits yet")
        || message.contains("bad revision")
    {
        GitLogFailure::NoHead
    } else {
        GitLogFailure::Transient
    }
}

fn full_object_name(sha: &str) -> bool {
    matches!(sha.len(), 40 | 64)
        && sha
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

// ECMAScript trim includes BOM but not U+0085; Rust's default whitespace set differs.
fn js_whitespace(character: char) -> bool {
    matches!(character, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
        | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn trim(text: &str) -> &str {
    text.trim_matches(js_whitespace)
}

pub fn parse_git_log_output(output: &str) -> Vec<GitCommit> {
    output
        .split('\x1e')
        .filter_map(|raw_record| {
            let fields: Vec<_> = raw_record
                .trim_start_matches(js_whitespace)
                .splitn(5, '\x1f')
                .collect();
            if fields.len() != 5 {
                return None;
            }
            let sha = trim(fields[0]);
            let timestamp = trim(fields[3]);
            // parseInt accepts a sign and ignores a non-digit suffix.
            let digits = timestamp
                .strip_prefix(['+', '-'])
                .unwrap_or(timestamp)
                .bytes()
                .take_while(u8::is_ascii_digit)
                .count();
            let signed_length = digits + usize::from(timestamp.starts_with(['+', '-']));
            let seconds: i64 = timestamp.get(..signed_length)?.parse().ok()?;
            if !full_object_name(sha) || seconds <= 0 {
                return None;
            }
            let subject = trim(fields[1]);
            let body = trim(fields[4]);
            Some(GitCommit {
                sha: sha.into(),
                short_sha: sha[..7].into(),
                message: if body.is_empty() {
                    subject.into()
                } else {
                    format!("{subject}\n\n{body}")
                },
                author: (!trim(fields[2]).is_empty()).then(|| trim(fields[2]).into()),
                committed_at_ms: seconds.checked_mul(1000)?,
            })
        })
        .collect()
}

// Gregorian civil-date conversion keeps --since identical to Date.toISOString(),
// without introducing a date/time dependency for the subprocess reader.
fn iso_time(milliseconds: i64) -> String {
    let seconds = milliseconds.div_euclid(1000);
    let days = seconds.div_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    let year_text = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else {
        format!("{year:+07}")
    };
    let time = seconds.rem_euclid(86_400);
    format!(
        "{year_text}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        time / 3600,
        time / 60 % 60,
        time % 60,
        milliseconds.rem_euclid(1000)
    )
}

pub fn read_git_commits(directory: &Path, options: &ReadOptions) -> Result<GitReadResult, String> {
    read_git_commits_with_runner(directory, options, &GitCommand)
}

pub fn read_git_commits_with_runner(
    directory: &Path,
    options: &ReadOptions,
    runner: &impl GitLogRunner,
) -> Result<GitReadResult, String> {
    if options.branch.starts_with('-') {
        return Err("refusing revision that looks like an option".into());
    }
    let mut exclusion = options
        .exclude_reachable_from
        .as_deref()
        .filter(|sha| full_object_name(sha));
    loop {
        let mut args = vec!["log".into(), options.branch.clone()];
        if let Some(sha) = exclusion {
            args.push(format!("^{sha}"));
        }
        args.extend([
            "--no-merges".into(),
            format!("--max-count={}", options.max_commits),
            FORMAT.into(),
        ]);
        if let Some(since_ms) = options.since_ms.filter(|since| *since > 0) {
            args.push(format!("--since={}", iso_time(since_ms)));
        }
        // A revision-named worktree file must not be interpreted as a pathspec.
        args.push("--".into());
        match runner.run(directory, &args) {
            Ok(output) => {
                return Ok(GitReadResult {
                    commits: parse_git_log_output(&output),
                    failure: None,
                });
            }
            Err(error) if exclusion.is_some() && error.contains("bad object") => {
                // A rewritten or garbage-collected excluded tip cannot bound the scan;
                // retry without that reachability exclusion.
                exclusion = None;
            }
            Err(error) => {
                return Ok(GitReadResult {
                    commits: Vec::new(),
                    failure: Some(classify_failure(&error)),
                });
            }
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct IndexOptions {
    pub since_days: f64,
    pub max_commits: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexResult {
    pub scanned: usize,
    pub inserted: usize,
    pub updated: usize,
    pub evicted: usize,
    /// Vector production is separate; this lexical producer never reports embeddings.
    pub embedded: usize,
    pub non_indexable: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct UpsertResult {
    pub inserted: usize,
    pub updated: usize,
}

pub fn latest_indexed_sha(
    db: &Connection,
    project_identity: &str,
) -> rusqlite::Result<Option<String>> {
    db.query_row(
        "SELECT sha FROM git_commits WHERE project_path = ?
         ORDER BY committed_at DESC, sha DESC LIMIT 1",
        [project_identity],
        |row| row.get(0),
    )
    .optional()
}

pub(super) fn upsert_batch(
    db: &Connection,
    project_identity: &str,
    commits: &[GitCommit],
    now_ms: i64,
) -> rusqlite::Result<UpsertResult> {
    let mut existing: HashSet<String> = db
        .prepare("SELECT sha FROM git_commits WHERE project_path = ?")?
        .query_map([project_identity], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut statement = db.prepare_cached(
        "INSERT INTO git_commits
         (sha, project_path, short_sha, message, author, committed_at, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(sha) DO UPDATE SET
             project_path = excluded.project_path,
             short_sha = excluded.short_sha,
             message = excluded.message,
             author = excluded.author,
             committed_at = excluded.committed_at,
             indexed_at = excluded.indexed_at
         WHERE git_commits.message != excluded.message",
    )?;
    let mut result = UpsertResult::default();
    for commit in commits {
        let changes = statement.execute(params![
            commit.sha,
            project_identity,
            commit.short_sha,
            commit.message,
            commit.author,
            commit.committed_at_ms,
            now_ms,
        ])?;
        if changes > 0 {
            if existing.insert(commit.sha.clone()) {
                result.inserted += 1;
            } else {
                result.updated += 1;
            }
        }
    }
    Ok(result)
}

pub fn upsert_commits_at(
    db: &mut Connection,
    project_identity: &str,
    commits: &[GitCommit],
    now_ms: i64,
) -> rusqlite::Result<UpsertResult> {
    if commits.is_empty() {
        return Ok(UpsertResult::default());
    }
    let transaction = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let result = upsert_batch(&transaction, project_identity, commits, now_ms)?;
    transaction.commit()?;
    Ok(result)
}

pub fn enforce_project_cap(
    db: &Connection,
    project_identity: &str,
    max_commits: f64,
) -> rusqlite::Result<usize> {
    if max_commits <= 0.0 {
        return Ok(0);
    }
    let count = || {
        db.query_row(
            "SELECT COUNT(*) FROM git_commits WHERE project_path = ?",
            [project_identity],
            |row| row.get::<_, usize>(0),
        )
    };
    let before = count()?;
    if before as f64 <= max_commits {
        return Ok(0);
    }
    db.execute(
        "DELETE FROM git_commits WHERE rowid IN (
             SELECT rowid FROM git_commits WHERE project_path = ?
             ORDER BY committed_at DESC, sha DESC LIMIT -1 OFFSET ?
         )",
        params![project_identity, max_commits],
    )?;
    Ok(before.saturating_sub(count()?))
}

static IN_PROGRESS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

struct SweepGuard(String);

impl SweepGuard {
    fn acquire(identity: &str) -> Option<Self> {
        let mut projects = IN_PROGRESS.get_or_init(Mutex::default).lock().ok()?;
        projects
            .insert(identity.into())
            .then(|| Self(identity.into()))
    }
}

impl Drop for SweepGuard {
    fn drop(&mut self) {
        if let Ok(mut projects) = IN_PROGRESS.get_or_init(Mutex::default).lock() {
            projects.remove(&self.0);
        }
    }
}

pub fn index_project(
    db: &mut Connection,
    project_identity: &str,
    directory: &Path,
    options: &IndexOptions,
) -> rusqlite::Result<IndexResult> {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    index_project_at(db, project_identity, directory, options, now_ms)
}

/// A clock-explicit sweep for deterministic replay and fixtures.
/// Rewriting Git history keeps previously indexed commits in the archive;
/// entries are removed only when enforcing the per-project size cap.
pub fn index_project_at(
    db: &mut Connection,
    project_identity: &str,
    directory: &Path,
    options: &IndexOptions,
    now_ms: i64,
) -> rusqlite::Result<IndexResult> {
    let Some(_guard) = SweepGuard::acquire(project_identity) else {
        return Ok(IndexResult::default());
    };
    let read = read_git_commits(
        directory,
        &ReadOptions {
            // Match the TypeScript producer's Date.toISOString conversion: fractional
            // days are accepted, but the resulting timestamp uses whole milliseconds.
            since_ms: Some((now_ms as f64 - options.since_days * DAY_MS as f64) as i64),
            max_commits: options.max_commits,
            exclude_reachable_from: latest_indexed_sha(db, project_identity)?,
            ..ReadOptions::default()
        },
    )
    .expect("the fixed HEAD revision is not an option");
    let mut result = IndexResult {
        scanned: read.commits.len(),
        ..IndexResult::default()
    };
    if matches!(
        read.failure,
        Some(GitLogFailure::NotARepo | GitLogFailure::NoHead)
    ) {
        result.non_indexable = true;
        return Ok(result);
    }
    // Couple the batch, cap eviction, FTS triggers and embedding cascades atomically.
    // TypeScript commits the batch before eviction; this stronger boundary also
    // prevents a failed eviction from leaving an over-cap partially published sweep.
    let transaction = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let upsert = upsert_batch(&transaction, project_identity, &read.commits, now_ms)?;
    result.inserted = upsert.inserted;
    result.updated = upsert.updated;
    result.evicted = enforce_project_cap(&transaction, project_identity, options.max_commits)?;
    transaction.commit()?;
    Ok(result)
}

#[cfg(test)]
mod subprocess_tests {
    use super::*;

    #[test]
    fn subprocess_timeout_is_bounded_and_reaped() {
        let mut command = Command::new("sh");
        command.args(["-c", "exec sleep 10"]);
        let start = Instant::now();
        let result = run_command(command, Duration::from_millis(50), GIT_MAX_BUFFER);
        assert_eq!(result.unwrap_err(), "git log timed out");
        assert!(start.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn subprocess_buffers_are_bounded_on_both_pipes() {
        for script in ["printf '123456789'", "printf '123456789' >&2"] {
            let mut command = Command::new("sh");
            command.args(["-c", script]);
            assert_eq!(
                run_command(command, GIT_TIMEOUT, 8).unwrap_err(),
                "git output exceeded maxBuffer"
            );
        }
    }
}
