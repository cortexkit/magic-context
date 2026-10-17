//! Per-step usage for Broca sessions, read live from Broca's write-ahead logs.
//!
//! Broca appends every record of a session (run starts, model steps, tool
//! calls, ...) to one WAL file as it happens, so this is the only source that
//! shows the steps of a run that is still going. `run-index.db` only learns
//! about a run when it ends.
//!
//! On-disk framing, a stable reader contract published by Broca:
//!
//! ```text
//! frame   := [len u32 LE][ver u8][seq u64 LE][fence u64 LE][digest 32][payload: len bytes]
//! record  := ver 1, seq >= 1, payload = one record as JSON
//! lineage := ver 2, seq 0, fence 0, payload = 16 opaque identity bytes
//! gated   := ver 3, seq >= 1, payload = {"requires": [feature names], "record": record}
//! digest  := SHA-256 over (ver ‖ seq LE ‖ fence LE ‖ payload)
//! ```
//!
//! A record payload is either the record object itself or an envelope
//! `{"ts_ms": …, "record": {…}}`. Reader rules, each mirrored here:
//!
//! - every digest is verified;
//! - a short final frame, or a complete final frame that fails its digest or
//!   JSON decode, is a torn tail (Broca is mid-append): stop before it, and
//!   look again on the next poll;
//! - unknown features or framing versions stop projection at that frame and
//!   retain the verified prefix with a compatibility note; nothing is skipped;
//! - a bad frame anywhere else or a record sequence gap makes the whole file
//!   unreadable: nothing is guessed past it,
//!   and the caller falls back to `run-index.db` run totals;
//! - lineage frames recur anywhere in a file and are verified then skipped;
//! - record types this reader does not use are skipped (Broca keeps adding
//!   informational ones).
//!
//! Files are opened read-only and never written. A live file is
//! `<state root>/wal/<session_addr>.wal`. Once a session goes cold Broca moves
//! its WAL, byte for byte, into a sealed archive container
//! `<state root>/wal-archive/fold-<unix-ms>.ark`; the live file wins when both
//! exist, and among containers the highest fold stamp wins.

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

const HEADER_LEN: usize = 4 + 1 + 8 + 8 + 32;
const RECORD_VERSION: u8 = 1;
const LINEAGE_VERSION: u8 = 2;
const GATED_VERSION: u8 = 3;
/// Broca's own table (`KNOWN_FEATURES` in broca-wal's framing.rs). A name
/// missing here stops the session at the first frame that requires it: a
/// missing `restart-pause/v1` cut every mason run Broca paused for a daemon
/// restart at the pause, hiding every step after the resume, and a missing
/// `session-class/v1` did the same to every run from its first record.
///
/// Each name below only adds a field or a record type this reader does not
/// use; Broca's owner confirmed that for each. `compaction/v1`,
/// `compaction-wait/v1` and `step-transforms/v1` change which messages the
/// model saw, which matters only to a transcript view: this reader takes
/// usage, steps and timestamps, which they leave as they were.
/// `input-token-cap/v1` adds a `budget_exhausted` run end, and this reader
/// only records that a run finished, not why. `structured-output/v1` adds the
/// run's frozen output schema to `RunStarted` and a structured result record
/// at the run's end, neither of which this reader uses.
const KNOWN_FEATURES: &[&str] = &[
    "flow-scopes/v1",
    "plan-manifest/v1",
    "restart-pause/v1",
    "scope/v1",
    "steer-queue/v1",
    "archive-index/v2",
    "dispatch-module/v1",
    "session-class/v1",
    "retention/v1",
    "run-cancel-at/v1",
    "agent-run-scopes/v1",
    "deferred-call/v1",
    "compaction/v1",
    "compaction-wait/v1",
    "step-transforms/v1",
    "input-token-cap/v1",
    "structured-output/v1",
];

#[derive(serde::Deserialize)]
struct GatedRequires {
    requires: Vec<String>,
    #[allow(dead_code)]
    record: serde::de::IgnoredAny,
}
const LINEAGE_PAYLOAD_LEN: usize = 16;
const MAX_PAYLOAD_LEN: u32 = 64 * 1024 * 1024;

/// Bytes read from one live WAL per poll. A large file is caught up over
/// several polls; a single frame bigger than this is still read whole.
const READ_BUDGET_BYTES: usize = 16 * 1024 * 1024;

/// Archived members are read in one go (they never change), so an
/// unexpectedly large one falls back to run totals rather than being loaded.
const MAX_ARCHIVED_MEMBER_BYTES: u64 = 64 * 1024 * 1024;

/// Live files whose read position is remembered. Past this the memory is
/// dropped and files are re-read from the start when next asked for.
const MAX_REMEMBERED_FILES: usize = 512;

/// Decoded archived members kept in memory. Each holds a session's whole run
/// history, so fewer are kept than live cursors; past this they are dropped
/// and re-read from their container when next asked for.
const MAX_REMEMBERED_ARCHIVED: usize = 64;

const ARCHIVE_MEMBER_PREFIX: &[u8; 8] = b"WALM\x01\x00\x00\x00";
const ARCHIVE_TRAILER_MAGIC: &[u8; 4] = b"WALK";
const ARCHIVE_MEMBER_HEADER_LEN: u64 = 64;
const ARCHIVE_INDEX_ENTRY_LEN: u64 = 32;

/// The `session` triple Broca binds a session to, as stored in
/// `export_facts.segment_json.session` and `run_index.session`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct SessionIdentity {
    pub project_root: String,
    pub harness: String,
    pub session: String,
}

impl SessionIdentity {
    /// Parses the JSON object the dashboard uses as a Broca session id.
    pub(crate) fn from_json(text: &str) -> Option<Self> {
        let value: Value = serde_json::from_str(text).ok()?;
        Some(Self {
            project_root: value.get("project_root")?.as_str()?.to_owned(),
            harness: value.get("harness")?.as_str()?.to_owned(),
            session: value.get("session")?.as_str()?.to_owned(),
        })
    }

    pub(crate) fn addr(&self) -> String {
        session_addr(&self.project_root, &self.harness, &self.session)
    }
}

/// The 16-hex-digit WAL file stem Broca derives from a session triple:
/// FNV-1a 64 over `project_root`, `harness` and `session` joined by the
/// ASCII unit separator (U+001F). `project_root` must be Broca's canonical
/// spelling (on macOS `/private/tmp/...`, not `/tmp/...`), which is what
/// `run-index.db` stores.
pub(crate) fn session_addr(project_root: &str, harness: &str, session: &str) -> String {
    let key = format!("{project_root}\u{1f}{harness}\u{1f}{session}");
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in key.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// Token counts of one model step. Each is `None` when Broca's record omitted
/// the key, which means the provider did not report it, not that it was zero.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct StepUsage {
    pub input_tokens: Option<i64>,
    pub cached_input_tokens: Option<i64>,
    pub cache_write_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
}

/// One finished model step (one provider request).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct WalStep {
    pub step_id: u64,
    /// When the step finished: the frame's envelope time, else the end of the
    /// step's last provider attempt, else when the step started. `None` when
    /// the WAL recorded none of these.
    pub ts_ms: Option<i64>,
    pub usage: StepUsage,
    pub finish_reason: Option<String>,
    /// The step's own provider and model when its record names them, else the
    /// run's.
    pub provider: Option<String>,
    pub model: Option<String>,
}

/// One run (episode) of a session, from its `run_started` record on.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct WalRun {
    pub run_id: String,
    pub ts_ms: Option<i64>,
    pub provider: Option<String>,
    pub model: Option<String>,
    /// The context window the run was admitted with
    /// (`run_started.config.context_limit`: the caller's override, else the
    /// catalog's window for the model), frozen for the whole run.
    pub context_limit: Option<i64>,
    pub steps: Vec<WalStep>,
    /// True once the run's `run_finished` record has been read.
    pub finished: bool,
}

/// The session's runs as far as its WAL has been read, or `None` when the WAL
/// is missing, unreadable, or corrupt and the caller must use run totals.
pub(crate) fn session_runs(
    state_root: &Path,
    identity: &SessionIdentity,
) -> Option<(Vec<WalRun>, Option<String>)> {
    session_snapshot(state_root, identity).map(|fold| (fold.runs, fold.activity_note))
}

/// The session's compatibility note as of the last time its WAL was read in
/// this process, without reading it now. The Cache tab's session list calls
/// this for every listed Broca session on every poll; decoding each of those
/// WALs (and archived ones out of their containers) just for the note cost far
/// more than the list. A session's WAL is read when its events are fetched,
/// which the tab does for the sessions it shows, so their notes appear by the
/// next poll.
pub(crate) fn session_activity_note(identity: &SessionIdentity) -> Option<String> {
    shared_cache().lock().ok()?.known_note(identity)
}

fn shared_cache() -> &'static Mutex<WalCache> {
    static CACHE: OnceLock<Mutex<WalCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(WalCache::default()))
}

fn session_snapshot(state_root: &Path, identity: &SessionIdentity) -> Option<Fold> {
    shared_cache()
        .lock()
        .ok()?
        .session_snapshot(state_root, identity)
}

// ── Frame decoding ─────────────────────────────────────────────────────────

fn frame_digest(version: u8, seq: u64, fence: u64, payload: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update([version]);
    hasher.update(seq.to_le_bytes());
    hasher.update(fence.to_le_bytes());
    hasher.update(payload);
    hasher.finalize().into()
}

#[derive(Debug, PartialEq, Eq)]
enum Corruption {
    /// A complete frame whose digest does not match its bytes.
    Digest,
    /// Anything else wrong with a complete frame header.
    Other(String),
}

enum Next<'a> {
    NewerWriter(String),
    Record {
        gated: bool,
        seq: u64,
        payload: &'a [u8],
        consumed: usize,
    },
    Lineage {
        consumed: usize,
    },
    /// The buffer ends inside this frame; `needed` is the frame's full size
    /// (or the header size when not even the header is present).
    Incomplete {
        needed: usize,
    },
    Corrupt(Corruption),
}

fn decode_next(buf: &[u8]) -> Next<'_> {
    if buf.len() < HEADER_LEN {
        return Next::Incomplete { needed: HEADER_LEN };
    }
    let len = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]);
    let version = buf[4];
    let seq = u64::from_le_bytes(buf[5..13].try_into().expect("8 bytes"));
    let fence = u64::from_le_bytes(buf[13..21].try_into().expect("8 bytes"));
    if version != RECORD_VERSION && version != LINEAGE_VERSION && version != GATED_VERSION {
        return Next::NewerWriter(format!("frame version {version}"));
    }
    if len > MAX_PAYLOAD_LEN {
        return Next::Corrupt(Corruption::Other(format!(
            "frame payload {len} exceeds the {MAX_PAYLOAD_LEN}-byte cap"
        )));
    }
    let total = HEADER_LEN + len as usize;
    if buf.len() < total {
        return Next::Incomplete { needed: total };
    }
    let payload = &buf[HEADER_LEN..total];
    if frame_digest(version, seq, fence, payload)[..] != buf[21..HEADER_LEN] {
        return Next::Corrupt(Corruption::Digest);
    }
    if version == LINEAGE_VERSION {
        if len as usize != LINEAGE_PAYLOAD_LEN || seq != 0 || fence != 0 {
            return Next::Corrupt(Corruption::Other(format!(
                "invalid lineage frame (len={len}, seq={seq}, fence={fence})"
            )));
        }
        return Next::Lineage { consumed: total };
    }
    Next::Record {
        gated: version == GATED_VERSION,
        seq,
        payload,
        consumed: total,
    }
}

/// Where a scan of one buffer stopped.
#[derive(Debug, PartialEq, Eq)]
enum ScanStop {
    /// Every byte of the buffer was consumed.
    End,
    /// The buffer ends inside a frame but the file continues; read at least
    /// `needed` bytes from the stop point to decode it.
    NeedMore {
        needed: usize,
    },
    /// The file ends in a torn frame, left for a later poll.
    TornTail,
    NewerWriter(String),
}

/// Decodes frames from `buf` into `fold`, returning how many bytes were
/// consumed. `at_eof` says whether `buf` runs to the current end of the file,
/// which is what makes a bad last frame a torn tail rather than corruption.
/// On error `fold` may hold records from before the bad frame; the caller
/// discards the whole file then.
fn scan(
    buf: &[u8],
    at_eof: bool,
    expected_seq: &mut u64,
    fold: &mut Fold,
) -> Result<(usize, ScanStop), String> {
    let mut pos = 0;
    loop {
        if pos == buf.len() {
            return Ok((pos, ScanStop::End));
        }
        match decode_next(&buf[pos..]) {
            Next::Incomplete { needed } => {
                let stop = if at_eof {
                    ScanStop::TornTail
                } else {
                    ScanStop::NeedMore { needed }
                };
                return Ok((pos, stop));
            }
            Next::Corrupt(Corruption::Digest) if at_eof && frame_ends_buffer(&buf[pos..]) => {
                return Ok((pos, ScanStop::TornTail));
            }
            Next::Corrupt(Corruption::Digest) => {
                return Err(format!("digest mismatch at byte {pos}"));
            }
            Next::Corrupt(Corruption::Other(reason)) => {
                return Err(format!("{reason} at byte {pos}"));
            }
            Next::NewerWriter(reason) => return Ok((pos, ScanStop::NewerWriter(reason))),
            Next::Lineage { consumed } => pos += consumed,
            Next::Record {
                gated,
                seq,
                payload,
                consumed,
            } => {
                if seq != *expected_seq {
                    return Err(format!("expected sequence {expected_seq}, found {seq}"));
                }
                if gated {
                    let requires = match serde_json::from_slice::<GatedRequires>(payload) {
                        Ok(envelope) => envelope.requires,
                        Err(_) if at_eof && pos + consumed == buf.len() => {
                            return Ok((pos, ScanStop::TornTail));
                        }
                        Err(error) => return Err(format!("frame {seq}: {error}")),
                    };
                    let mut missing: Vec<_> = requires
                        .into_iter()
                        .filter(|name| !KNOWN_FEATURES.contains(&name.as_str()))
                        .collect();
                    missing.sort_unstable();
                    missing.dedup();
                    if !missing.is_empty() {
                        return Ok((pos, ScanStop::NewerWriter(missing.join(", "))));
                    }
                }
                let envelope = match serde_json::from_slice::<Value>(payload) {
                    Ok(value) => value,
                    Err(_) if at_eof && pos + consumed == buf.len() => {
                        return Ok((pos, ScanStop::TornTail));
                    }
                    Err(error) => return Err(format!("frame {seq} is not valid JSON: {error}")),
                };
                let (ts_ms, record) =
                    open_envelope(&envelope).map_err(|reason| format!("frame {seq}: {reason}"))?;
                fold.apply(ts_ms, record)
                    .map_err(|reason| format!("frame {seq}: {reason}"))?;
                *expected_seq += 1;
                pos += consumed;
            }
        }
    }
}

/// True when the frame starting at `buf[0]` is complete and is the last
/// thing in `buf`.
fn frame_ends_buffer(buf: &[u8]) -> bool {
    buf.len() >= HEADER_LEN
        && HEADER_LEN + u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize == buf.len()
}

/// Splits a payload into its envelope timestamp and record object. A payload
/// without a `record` key is the record itself, and its own top-level `ts_ms`
/// (when the record type has one) stands in for the envelope's.
fn open_envelope(envelope: &Value) -> Result<(Option<i64>, &Map<String, Value>), String> {
    let object = envelope
        .as_object()
        .ok_or_else(|| "payload is not an object".to_owned())?;
    let ts_ms = match object
        .get("ts_ms")
        .or_else(|| object.get("record").and_then(|r| r.get("ts_ms")))
    {
        None | Some(Value::Null) => None,
        Some(value) => {
            Some(non_negative_int(value).ok_or_else(|| format!("invalid ts_ms {value}"))?)
        }
    };
    let record = match object.get("record") {
        Some(inner) => inner
            .as_object()
            .ok_or_else(|| "envelope record is not an object".to_owned())?,
        None => object,
    };
    if !record.get("type").is_some_and(Value::is_string) {
        return Err("no tagged record".to_owned());
    }
    Ok((ts_ms, record))
}

fn non_negative_int(value: &Value) -> Option<i64> {
    value.as_u64().and_then(|n| i64::try_from(n).ok())
}

fn string_field(object: &Map<String, Value>, key: &str) -> Option<String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

/// A finish reason is a plain string, or a one-key object for a variant that
/// carries data; the key names it.
fn finish_reason(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(reason) => Some(reason.clone()),
        Value::Object(object) if object.len() == 1 => object.keys().next().cloned(),
        _ => None,
    }
}

// ── Record projection ──────────────────────────────────────────────────────

/// What the dashboard keeps from a WAL: its runs and their finished steps,
/// plus the in-flight step times needed to date the next finished step.
#[derive(Debug, Clone, Default)]
struct Fold {
    runs: Vec<WalRun>,
    step_started_ts: HashMap<u64, i64>,
    attempt_ts: HashMap<u64, i64>,
    last_ts_ms: Option<i64>,
    activity_note: Option<String>,
}

impl Fold {
    fn apply(
        &mut self,
        envelope_ts: Option<i64>,
        record: &Map<String, Value>,
    ) -> Result<(), String> {
        if let Some(ts) = envelope_ts {
            self.last_ts_ms = Some(ts);
        }
        let kind = record
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if kind == "run_started" {
            let run_id = string_field(record, "run_id").ok_or("run_started without run_id")?;
            let model = record
                .get("config")
                .and_then(|config| config.get("model"))
                .and_then(Value::as_object);
            let provider = model.and_then(|model| {
                string_field(model, "provider_module_id")
                    .or_else(|| string_field(model, "provider"))
            });
            let model_id = model.and_then(|model| {
                string_field(model, "model_id").or_else(|| string_field(model, "model"))
            });
            let context_limit = record
                .get("config")
                .and_then(|config| config.get("context_limit"))
                .and_then(non_negative_int)
                .filter(|limit| *limit > 0);
            self.step_started_ts.clear();
            self.attempt_ts.clear();
            self.runs.push(WalRun {
                run_id,
                ts_ms: envelope_ts,
                provider,
                model: model_id,
                context_limit,
                steps: Vec::new(),
                finished: false,
            });
            return Ok(());
        }
        // Records before the first run_started belong to no run.
        let Some(run) = self.runs.last_mut() else {
            return Ok(());
        };
        let step_id = || {
            record
                .get("step_id")
                .and_then(Value::as_u64)
                .ok_or_else(|| format!("{kind} without a step_id"))
        };
        match kind {
            "step_started" => {
                if let Some(ts) = envelope_ts {
                    self.step_started_ts.insert(step_id()?, ts);
                }
            }
            "model_attempt_finished" => {
                if let Some(ts) = envelope_ts {
                    self.attempt_ts.insert(step_id()?, ts);
                }
            }
            "model_step_finished" => {
                let step_id = step_id()?;
                let usage = record.get("usage").and_then(Value::as_object);
                let count = |key: &str| {
                    usage
                        .and_then(|usage| usage.get(key))
                        .and_then(non_negative_int)
                };
                let started = self.step_started_ts.remove(&step_id);
                let attempted = self.attempt_ts.remove(&step_id);
                run.steps.push(WalStep {
                    step_id,
                    ts_ms: envelope_ts.or(attempted).or(started),
                    usage: StepUsage {
                        input_tokens: count("input_tokens"),
                        cached_input_tokens: count("cached_input_tokens"),
                        cache_write_tokens: count("cache_write_tokens"),
                        output_tokens: count("output_tokens"),
                    },
                    finish_reason: finish_reason(record.get("finish_reason")),
                    provider: string_field(record, "provider").or_else(|| run.provider.clone()),
                    model: string_field(record, "model").or_else(|| run.model.clone()),
                });
            }
            "run_finished" => run.finished = true,
            _ => {}
        }
        Ok(())
    }
}

// ── Incremental reading ────────────────────────────────────────────────────

/// How far one WAL has been read, and what it said so far.
#[derive(Debug, Clone)]
struct WalCursor {
    offset: u64,
    /// The file length when a read last reached the end of the file. A torn
    /// tail leaves `offset` short of it; while the length is unchanged there
    /// is nothing new to read.
    seen_len: u64,
    expected_seq: u64,
    fold: Fold,
    /// Set once the file proved unreadable; it stays unreadable until it
    /// shrinks or is replaced (Broca rewrote it), since corruption does not
    /// heal.
    failed: Option<String>,
    /// The (device, inode) of the file this cursor read, when known. A
    /// different file at the same path (replaced, not appended to) is read
    /// again from the start even when it is not shorter.
    file_key: Option<(u64, u64)>,
}

impl Default for WalCursor {
    fn default() -> Self {
        Self {
            offset: 0,
            seen_len: 0,
            expected_seq: 1,
            fold: Fold::default(),
            failed: None,
            file_key: None,
        }
    }
}

impl WalCursor {
    /// Reads what was appended since the last call, at most `budget` bytes
    /// (or one frame, when a single frame is bigger).
    fn advance<R: Read + Seek>(&mut self, reader: &mut R, len: u64, budget: usize) {
        if len < self.offset {
            *self = Self {
                file_key: self.file_key,
                ..Self::default()
            };
        }
        if self.failed.is_some()
            || self.fold.activity_note.is_some()
            || len == self.offset
            || len == self.seen_len
        {
            return;
        }
        let available = len - self.offset;
        let mut want = available.min(budget as u64);
        loop {
            let buf = match read_exact_at(reader, self.offset, want) {
                Ok(buf) => buf,
                Err(error) => {
                    self.failed = Some(format!("read failed: {error}"));
                    return;
                }
            };
            let at_eof = want == available;
            match scan(&buf, at_eof, &mut self.expected_seq, &mut self.fold) {
                Ok((consumed, stop)) => {
                    self.offset += consumed as u64;
                    if at_eof {
                        self.seen_len = len;
                    }
                    match stop {
                        // One frame larger than the budget: read it whole.
                        ScanStop::NeedMore { needed } if consumed == 0 && needed as u64 > want => {
                            want = available.min(needed as u64);
                        }
                        ScanStop::NewerWriter(reason) => {
                            let through = self
                                .fold
                                .last_ts_ms
                                .and_then(chrono::DateTime::from_timestamp_millis)
                                .map(|time| time.to_rfc3339())
                                .unwrap_or_else(|| {
                                    "the beginning of the WAL (no timestamp read)".to_owned()
                                });
                            self.fold.activity_note = Some(format!(
                                "Broca recorded features this dashboard doesn't understand ({reason}); showing data up to {through}."
                            ));
                            return;
                        }
                        _ => return,
                    }
                }
                Err(reason) => {
                    self.failed = Some(reason);
                    return;
                }
            }
        }
    }
}

/// Bytes this process has read from Broca WAL files and archive containers,
/// for measuring what a Cache tab refresh costs (`bench_cache_poll`).
static BYTES_READ: AtomicU64 = AtomicU64::new(0);

pub fn bytes_read_total() -> u64 {
    BYTES_READ.load(Ordering::Relaxed)
}

/// The (device, inode) pair naming the file behind `metadata`, so a reader can
/// tell a file replaced at the same path from the one it already read. `None`
/// where the platform does not expose it; callers then rely on length alone.
pub(crate) fn file_identity(metadata: &std::fs::Metadata) -> Option<(u64, u64)> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Some((metadata.dev(), metadata.ino()))
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        None
    }
}

fn read_exact_at<R: Read + Seek>(
    reader: &mut R,
    offset: u64,
    len: u64,
) -> std::io::Result<Vec<u8>> {
    reader.seek(SeekFrom::Start(offset))?;
    let mut buf = vec![0; len as usize];
    reader.read_exact(&mut buf)?;
    BYTES_READ.fetch_add(len, Ordering::Relaxed);
    Ok(buf)
}

// ── Archive containers ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ArchivedMember {
    offset: u64,
    size: u64,
}

/// A container's member index, `None` when the container is unsealed. An
/// unsealed container belongs to a fold pass still in flight (or one that
/// died), and every member it holds is still a live file, so it is skipped
/// exactly as Broca's own reader skips it.
type ContainerIndex = Option<HashMap<String, ArchivedMember>>;

#[derive(Debug, Clone)]
struct CachedContainer {
    len: u64,
    modified: Option<SystemTime>,
    index: Result<ContainerIndex, String>,
}

fn hex_address(raw: &[u8]) -> Result<String, String> {
    if raw.len() == 16 && raw.iter().all(u8::is_ascii_hexdigit) {
        Ok(String::from_utf8_lossy(raw).into_owned())
    } else {
        Err("invalid archive session address".to_owned())
    }
}

/// Reads and checks one 64-byte member header at `offset`, which must fit
/// before `end`. Returns (address, payload length, payload SHA-256).
fn read_member_header<R: Read + Seek>(
    reader: &mut R,
    offset: u64,
    end: u64,
) -> Result<(String, u64, [u8; 32]), String> {
    if offset + ARCHIVE_MEMBER_HEADER_LEN > end {
        return Err("truncated archive member header".to_owned());
    }
    let raw =
        read_exact_at(reader, offset, ARCHIVE_MEMBER_HEADER_LEN).map_err(|e| e.to_string())?;
    if &raw[..8] != ARCHIVE_MEMBER_PREFIX {
        return Err("unknown archive member header".to_owned());
    }
    let address = hex_address(&raw[8..24])?;
    let size = u64::from_le_bytes(raw[24..32].try_into().expect("8 bytes"));
    // `size` is file data: checked, so a huge value is refused rather than
    // overflowing (a panic in debug builds, a wrapped bound check in release).
    match member_end(offset, size) {
        Some(member_end) if member_end <= end => {}
        _ => return Err("archive member exceeds container bounds".to_owned()),
    }
    Ok((address, size, raw[32..64].try_into().expect("32 bytes")))
}

/// The offset just past a member whose header starts at `offset`, or `None`
/// when that overflows.
fn member_end(offset: u64, size: u64) -> Option<u64> {
    offset
        .checked_add(ARCHIVE_MEMBER_HEADER_LEN)?
        .checked_add(size)
}

/// Parses a container's trailer and index, rebuilding the index from the
/// member headers when the stored one is missing or invalid (it is a cache
/// Broca can lose, never the authority).
fn read_container_index<R: Read + Seek>(
    reader: &mut R,
    len: u64,
) -> Result<ContainerIndex, String> {
    if len < 8 {
        return Ok(None);
    }
    let trailer = read_exact_at(reader, len - 8, 8).map_err(|e| e.to_string())?;
    if &trailer[4..] != ARCHIVE_TRAILER_MAGIC {
        return Ok(None);
    }
    let end = len - 8;
    let index_len = u64::from(u32::from_le_bytes(
        trailer[..4].try_into().expect("4 bytes"),
    ));
    match read_stored_index(reader, end, index_len) {
        Ok(members) => Ok(Some(members)),
        Err(_) => rescan_member_headers(reader, end).map(Some),
    }
}

fn read_stored_index<R: Read + Seek>(
    reader: &mut R,
    end: u64,
    index_len: u64,
) -> Result<HashMap<String, ArchivedMember>, String> {
    if index_len < 4 || index_len > end || (index_len - 4) % ARCHIVE_INDEX_ENTRY_LEN != 0 {
        return Err("invalid archive index length".to_owned());
    }
    let start = end - index_len;
    let raw = read_exact_at(reader, start, index_len).map_err(|e| e.to_string())?;
    let count = u64::from(u32::from_le_bytes(raw[..4].try_into().expect("4 bytes")));
    if count * ARCHIVE_INDEX_ENTRY_LEN + 4 != index_len {
        return Err("invalid archive index count".to_owned());
    }
    let mut members = HashMap::new();
    let mut next_offset = 0;
    for entry in raw[4..].chunks_exact(ARCHIVE_INDEX_ENTRY_LEN as usize) {
        let address = hex_address(&entry[..16])?;
        let offset = u64::from_le_bytes(entry[16..24].try_into().expect("8 bytes"));
        let size = u64::from_le_bytes(entry[24..32].try_into().expect("8 bytes"));
        if offset != next_offset || members.contains_key(&address) {
            return Err("invalid archive index coverage".to_owned());
        }
        next_offset = match member_end(offset, size) {
            Some(member_end) => member_end,
            None => return Err("archive index member exceeds bounds".to_owned()),
        };
        if next_offset > start {
            return Err("archive index member exceeds bounds".to_owned());
        }
        members.insert(address, ArchivedMember { offset, size });
    }
    if next_offset != start {
        return Err("archive index omits members".to_owned());
    }
    Ok(members)
}

fn rescan_member_headers<R: Read + Seek>(
    reader: &mut R,
    end: u64,
) -> Result<HashMap<String, ArchivedMember>, String> {
    let mut members = HashMap::new();
    let mut offset = 0;
    while offset < end {
        if end - offset < 4 {
            return Err("truncated archive member or index".to_owned());
        }
        if read_exact_at(reader, offset, 4).map_err(|e| e.to_string())? != b"WALM" {
            break; // The first non-member is the (damaged) index.
        }
        let (address, size, _) = read_member_header(reader, offset, end)?;
        if members.contains_key(&address) {
            return Err("duplicate session in archive headers".to_owned());
        }
        members.insert(address, ArchivedMember { offset, size });
        offset += ARCHIVE_MEMBER_HEADER_LEN + size;
    }
    Ok(members)
}

/// Reads one archived member, checks its header and payload digest, and
/// decodes the WAL bytes it holds.
fn read_archived_member<R: Read + Seek>(
    reader: &mut R,
    container_len: u64,
    address: &str,
    member: ArchivedMember,
) -> Result<Fold, String> {
    let (actual, size, digest) = read_member_header(reader, member.offset, container_len - 8)?;
    if actual != address || size != member.size {
        return Err("archive index disagrees with member header".to_owned());
    }
    if size > MAX_ARCHIVED_MEMBER_BYTES {
        return Err(format!("archived WAL of {size} bytes is over the read cap"));
    }
    let payload = read_exact_at(reader, member.offset + ARCHIVE_MEMBER_HEADER_LEN, size)
        .map_err(|e| e.to_string())?;
    if <[u8; 32]>::from(Sha256::digest(&payload)) != digest {
        return Err("archive member digest mismatch".to_owned());
    }
    let mut cursor = WalCursor::default();
    cursor.advance(&mut std::io::Cursor::new(&payload), size, size as usize);
    match cursor.failed {
        Some(reason) => Err(reason),
        None => Ok(cursor.fold),
    }
}

/// The fold stamp of a canonically named container, `fold-<unix-ms>.ark`.
fn fold_stamp(name: &str) -> Option<u64> {
    let digits = name.strip_prefix("fold-")?.strip_suffix(".ark")?;
    if digits.is_empty()
        || !digits.bytes().all(|b| b.is_ascii_digit())
        || (digits.len() > 1 && digits.starts_with('0'))
    {
        return None;
    }
    digits.parse().ok()
}

// ── Cache ──────────────────────────────────────────────────────────────────

/// Read positions of live WALs, archive indexes, and decoded archived
/// members, kept across polls so Live mode only reads what is new.
#[derive(Debug, Default)]
pub(crate) struct WalCache {
    live: HashMap<PathBuf, WalCursor>,
    /// Each session's compatibility note from its last read, by address.
    notes: HashMap<String, Option<String>>,
    containers: HashMap<PathBuf, CachedContainer>,
    /// Decoded archived members by (container, member offset, container length).
    archived: HashMap<(PathBuf, u64, u64), Result<Fold, String>>,
}

impl WalCache {
    #[cfg(test)]
    pub(crate) fn session_runs(
        &mut self,
        state_root: &Path,
        identity: &SessionIdentity,
    ) -> Option<Vec<WalRun>> {
        self.session_snapshot(state_root, identity)
            .map(|fold| fold.runs)
    }

    fn known_note(&self, identity: &SessionIdentity) -> Option<String> {
        self.notes.get(&identity.addr()).cloned().flatten()
    }

    fn session_snapshot(&mut self, state_root: &Path, identity: &SessionIdentity) -> Option<Fold> {
        let address = identity.addr();
        let fold = self.read_session(state_root, &address);
        if self.notes.len() >= MAX_REMEMBERED_FILES && !self.notes.contains_key(&address) {
            self.notes.clear();
        }
        self.notes.insert(
            address,
            fold.as_ref().and_then(|fold| fold.activity_note.clone()),
        );
        fold
    }

    fn read_session(&mut self, state_root: &Path, address: &str) -> Option<Fold> {
        let live_path = state_root.join("wal").join(format!("{address}.wal"));
        match File::open(&live_path) {
            Ok(mut file) => {
                let metadata = file.metadata().ok()?;
                let (len, file_key) = (metadata.len(), file_identity(&metadata));
                if !self.live.contains_key(&live_path) && self.live.len() >= MAX_REMEMBERED_FILES {
                    self.live.clear();
                }
                let cursor = self.live.entry(live_path).or_default();
                if cursor.file_key != file_key {
                    *cursor = WalCursor {
                        file_key,
                        ..WalCursor::default()
                    };
                }
                cursor.advance(&mut file, len, READ_BUDGET_BYTES);
                if cursor.failed.is_some() {
                    return None;
                }
                Some(cursor.fold.clone())
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.live.remove(&live_path);
                self.archived_runs(&state_root.join("wal-archive"), address)
            }
            Err(_) => None,
        }
    }

    /// Caches a decoded member. Entries for an older length of the same
    /// container (it was rewritten) can never be hit again and are dropped.
    fn remember_archived(&mut self, key: (PathBuf, u64, u64), runs: Result<Fold, String>) {
        self.archived
            .retain(|(path, _, len), _| *path != key.0 || *len == key.2);
        if self.archived.len() >= MAX_REMEMBERED_ARCHIVED {
            self.archived.clear();
        }
        self.archived.insert(key, runs);
    }

    /// The session's runs from the newest container holding it. `None` when
    /// no container holds it, or when a container that might hold a newer
    /// copy cannot be read.
    fn archived_runs(&mut self, archive_dir: &Path, address: &str) -> Option<Fold> {
        let mut containers = Vec::new();
        for entry in std::fs::read_dir(archive_dir).ok()? {
            let path = entry.ok()?.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("ark") {
                continue;
            }
            // A container named some other way is not one this reader knows.
            let stamp = fold_stamp(path.file_name()?.to_str()?)?;
            containers.push((stamp, path));
        }
        containers.sort_by_key(|container| std::cmp::Reverse(container.0));
        for (_, path) in containers {
            let mut file = File::open(&path).ok()?;
            let metadata = file.metadata().ok()?;
            let (len, modified) = (metadata.len(), metadata.modified().ok());
            let cached = self
                .containers
                .get(&path)
                .filter(|cached| cached.len == len && cached.modified == modified);
            let index = match cached {
                Some(cached) => cached.index.clone(),
                None => {
                    let index = read_container_index(&mut file, len);
                    self.containers.insert(
                        path.clone(),
                        CachedContainer {
                            len,
                            modified,
                            index: index.clone(),
                        },
                    );
                    index
                }
            };
            let Some(members) = index.ok()? else {
                continue;
            };
            let Some(member) = members.get(address).copied() else {
                continue;
            };
            let key = (path, member.offset, len);
            if let Some(runs) = self.archived.get(&key) {
                return runs.clone().ok();
            }
            let runs = read_archived_member(&mut file, len, address, member);
            self.remember_archived(key, runs.clone());
            return runs.ok();
        }
        None
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    // ── Fixture encoder, written independently of the decoder above ──

    fn frame(version: u8, seq: u64, fence: u64, payload: &[u8]) -> Vec<u8> {
        let mut hasher = Sha256::new();
        hasher.update([version]);
        hasher.update(seq.to_le_bytes());
        hasher.update(fence.to_le_bytes());
        hasher.update(payload);
        let digest: [u8; 32] = hasher.finalize().into();
        let mut out = Vec::new();
        out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        out.push(version);
        out.extend_from_slice(&seq.to_le_bytes());
        out.extend_from_slice(&fence.to_le_bytes());
        out.extend_from_slice(&digest);
        out.extend_from_slice(payload);
        out
    }

    fn lineage() -> Vec<u8> {
        frame(2, 0, 0, &[0x5a; 16])
    }

    /// Builds WAL bytes from records, numbering sequences from 1 and
    /// inserting a lineage frame before each record, the way any Broca
    /// append may.
    struct Wal {
        bytes: Vec<u8>,
        seq: u64,
    }

    impl Wal {
        fn new() -> Self {
            Self {
                bytes: lineage(),
                seq: 0,
            }
        }

        fn push(&mut self, payload: Value) -> &mut Self {
            self.seq += 1;
            self.bytes
                .extend(frame(1, self.seq, 3, payload.to_string().as_bytes()));
            self
        }

        fn push_lineage(&mut self) -> &mut Self {
            self.bytes.extend(lineage());
            self
        }
    }

    fn run_started(run: &str, ts: u64) -> Value {
        json!({"type": "run_started", "run_id": run, "ts_ms": ts,
               "session": {"project_root": "/work", "harness": "broca", "session": "s"},
               "config": {"model": {"provider_module_id": "anthropic", "model_id": "claude-opus-5"}},
               "input": [], "origin": {"kind": "fresh"}})
    }

    fn step_started(step: u64) -> Value {
        json!({"type": "step_started", "step_id": step})
    }

    fn attempt(step: u64, ts: u64) -> Value {
        json!({"type": "model_attempt_finished", "step_id": step, "attempt": 0, "ts_ms": ts,
               "request_body_len": 1, "request_body_sha256": "00", "response_body_len": 1,
               "response_body_sha256": "00", "outcome": "completed"})
    }

    fn step_finished(step: u64, usage: Value) -> Value {
        json!({"type": "model_step_finished", "step_id": step, "usage": usage,
               "finish_reason": "tool_calls", "retries_used": 0,
               "assistant_message": {"content": []}})
    }

    fn usage(input: u64, read: u64, write: u64, output: u64) -> Value {
        json!({"input_tokens": input, "cached_input_tokens": read,
               "cache_write_tokens": write, "output_tokens": output})
    }

    /// A finished two-step run followed by a one-step run still in progress.
    fn two_runs() -> Wal {
        let mut wal = Wal::new();
        wal.push(run_started("r1", 1_000))
            .push(step_started(1))
            .push(attempt(1, 1_010))
            .push(step_finished(1, usage(5_000, 0, 4_000, 10)))
            .push_lineage()
            .push(step_started(2))
            .push(attempt(2, 1_020))
            .push(step_finished(2, usage(10, 4_000, 300, 10)))
            .push(json!({"type": "run_finished", "reason": "completed", "ts_ms": 1_030}))
            .push(run_started("r2", 2_000))
            .push(step_started(1))
            .push(attempt(1, 2_010))
            .push(step_finished(1, usage(10, 4_300, 200, 10)));
        wal
    }

    fn decode(bytes: &[u8]) -> Result<Vec<WalRun>, String> {
        let mut cursor = WalCursor::default();
        cursor.advance(
            &mut std::io::Cursor::new(bytes),
            bytes.len() as u64,
            READ_BUDGET_BYTES,
        );
        match cursor.failed {
            Some(reason) => Err(reason),
            None => Ok(cursor.fold.runs),
        }
    }

    fn step_ids(runs: &[WalRun]) -> Vec<(String, u64)> {
        runs.iter()
            .flat_map(|run| {
                run.steps
                    .iter()
                    .map(|step| (run.run_id.clone(), step.step_id))
            })
            .collect()
    }

    /// Addresses produced by Broca's own `scripts/wal-addressability.py --key`
    /// for each triple, including canonical macOS temp roots and two triples
    /// taken from live WAL filenames. A port that got the separator, the
    /// field order, or the hash constants wrong fails here.
    #[test]
    fn session_addr_matches_broca_for_real_triples() {
        for (root, harness, session, expected) in [
            ("/tmp/p", "runner", "s1", "31a7840439280f40"),
            ("/private/tmp/p", "runner", "s1", "ec7cdb7928891188"),
            (
                "/private/tmp/magic-context/x",
                "opencode",
                "ses_Ünïcode",
                "df1b928c664b11c7",
            ),
            (
                "/Users/ufukaltinok/Work/Projects/CortexKit/magic-context",
                "alfonso",
                "ses_abc123",
                "f834cd13cc5f3335",
            ),
            (
                "/Users/ufukaltinok/.local/share/cortexkit/alfonso/worktrees/c0c39eea197fcc68/bg_c9b6c173169d2c81",
                "broca",
                "alfonso:bg_c9b6c173169d2c81",
                "04c32fce149fa16f",
            ),
            (
                "/private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/prefrontal-core-manager",
                "broca",
                "alfonso:oneshot-00000000-0000-4033-98d8-a7f0965fa3b8",
                "dd3a307632c7da7f",
            ),
        ] {
            assert_eq!(session_addr(root, harness, session), expected, "{root} {session}");
        }
        let identity = SessionIdentity::from_json(
            r#"{"project_root":"/tmp/p","harness":"runner","session":"s1"}"#,
        )
        .unwrap();
        assert_eq!(identity.addr(), "31a7840439280f40");
    }

    /// Broca pins the wire bytes of a lineage frame with a digest computed
    /// outside its code. Building that frame from the literal (not from any
    /// digest function here) and decoding it proves this reader hashes the
    /// same domain Broca writes.
    #[test]
    fn broca_pinned_lineage_frame_verifies() {
        const BROCA_DIGEST: [u8; 32] = [
            0xb8, 0xc1, 0xc2, 0x6f, 0x10, 0xd3, 0xd6, 0x36, 0xff, 0x9d, 0x9d, 0x83, 0x61, 0x97,
            0x15, 0x8a, 0x04, 0x82, 0xd1, 0x39, 0x75, 0xcc, 0x1b, 0x7c, 0x52, 0xa3, 0xf1, 0x43,
            0xac, 0x76, 0x45, 0x80,
        ];
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.push(2);
        bytes.extend_from_slice(&[0; 16]);
        bytes.extend_from_slice(&BROCA_DIGEST);
        bytes.extend_from_slice(&[0x5a; 16]);
        assert!(matches!(
            decode_next(&bytes),
            Next::Lineage { consumed: 69 }
        ));
        assert_eq!(lineage(), bytes, "the test encoder writes Broca's bytes");
    }

    #[test]
    fn broca_encoder_golden_gated_frames_decode() {
        let bytes = include_bytes!("../tests/fixtures/broca-gated/frames.wal");
        let mut fold = Fold::default();
        let mut seq = 1;
        assert_eq!(
            scan(bytes, true, &mut seq, &mut fold).unwrap(),
            (bytes.len(), ScanStop::End)
        );
        assert_eq!(seq, 3);
        assert!(fold.activity_note.is_none());
        assert!(matches!(
            decode_next(bytes),
            Next::Record {
                gated: false,
                seq: 1,
                ..
            }
        ));
        let first_len = HEADER_LEN + u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize;
        assert!(matches!(
            decode_next(&bytes[first_len..]),
            Next::Record {
                gated: true,
                seq: 2,
                ..
            }
        ));
    }

    #[test]
    #[ignore = "requires a copied Broca state root and independently extracted run facts"]
    fn copied_broca_sessions_match_export_facts() {
        let root = PathBuf::from(std::env::var("BROCA_WAL_COPY_ROOT").expect("copy root"));
        let facts: Value =
            serde_json::from_slice(&std::fs::read(root.join("expected.json")).unwrap()).unwrap();
        let mut cache = WalCache::default();
        let sessions = facts.as_array().unwrap();
        assert!(sessions.len() >= 3);
        for fact in sessions {
            let identity = SessionIdentity::from_json(&fact["session"].to_string()).unwrap();
            assert!(root
                .join("wal")
                .join(format!("{}.wal", identity.addr()))
                .is_file());
            let fold = cache.session_snapshot(&root, &identity).unwrap();
            assert!(fold.activity_note.is_none());
            let mut checked = 0;
            for expected in fact["runs"].as_array().unwrap() {
                let run = fold
                    .runs
                    .iter()
                    .find(|run| run.run_id == expected["run_id"].as_str().unwrap())
                    .unwrap();
                assert!(!run.steps.is_empty());
                for (key, count) in [
                    ("input_tokens", 0),
                    ("cached_input_tokens", 1),
                    ("cache_write_tokens", 2),
                    ("output_tokens", 3),
                ] {
                    let sum: i64 = run
                        .steps
                        .iter()
                        .map(|step| {
                            match count {
                                0 => step.usage.input_tokens,
                                1 => step.usage.cached_input_tokens,
                                2 => step.usage.cache_write_tokens,
                                _ => step.usage.output_tokens,
                            }
                            .unwrap_or(0)
                        })
                        .sum();
                    assert_eq!(
                        sum,
                        expected["usage"][key].as_i64().unwrap(),
                        "{} {} {key}",
                        identity.addr(),
                        run.run_id
                    );
                }
                checked += 1;
            }
            assert!(checked > 0);
            println!(
                "address={} runs={checked} steps={}",
                identity.addr(),
                fold.runs.iter().map(|run| run.steps.len()).sum::<usize>()
            );
        }
    }

    #[test]
    fn multi_step_runs_decode_with_usage_model_and_times() {
        let runs = decode(&two_runs().bytes).unwrap();
        assert_eq!(
            step_ids(&runs),
            [
                ("r1".to_string(), 1),
                ("r1".to_string(), 2),
                ("r2".to_string(), 1)
            ]
        );
        assert!(runs[0].finished);
        // The second run has no run_finished yet: it is in progress, and its
        // finished step is still reported.
        assert!(!runs[1].finished);
        assert_eq!(runs[1].ts_ms, Some(2_000));
        let step = &runs[0].steps[1];
        assert_eq!(
            step.usage,
            StepUsage {
                input_tokens: Some(10),
                cached_input_tokens: Some(4_000),
                cache_write_tokens: Some(300),
                output_tokens: Some(10),
            }
        );
        // Dated by its attempt, since the step record carries no time.
        assert_eq!(step.ts_ms, Some(1_020));
        assert_eq!(step.provider.as_deref(), Some("anthropic"));
        assert_eq!(step.model.as_deref(), Some("claude-opus-5"));
        assert_eq!(step.finish_reason.as_deref(), Some("tool_calls"));
    }

    #[test]
    fn envelope_payloads_and_their_timestamps_are_read() {
        let mut wal = Wal::new();
        wal.push(json!({"ts_ms": 500, "record": run_started("r1", 400)}))
            .push(json!({"ts_ms": 510, "record": step_started(1)}))
            .push(json!({"ts_ms": 520, "record": step_finished(1, usage(1, 2, 3, 4))}));
        let runs = decode(&wal.bytes).unwrap();
        assert_eq!(runs[0].ts_ms, Some(500));
        assert_eq!(runs[0].steps[0].ts_ms, Some(520));
    }

    #[test]
    fn a_step_with_no_attempt_takes_its_start_time_or_none() {
        let mut wal = Wal::new();
        wal.push(run_started("r1", 1_000))
            .push(json!({"ts_ms": 1_005, "record": step_started(1)}))
            .push(step_finished(1, usage(1, 0, 0, 1)))
            .push(step_started(2))
            .push(step_finished(2, usage(1, 0, 0, 1)));
        let runs = decode(&wal.bytes).unwrap();
        assert_eq!(runs[0].steps[0].ts_ms, Some(1_005));
        assert_eq!(runs[0].steps[1].ts_ms, None);
    }

    #[test]
    fn a_torn_tail_keeps_every_complete_frame_before_it() {
        let full = two_runs().bytes;
        let mut wal = two_runs();
        wal.push(step_started(2));
        let tail_start = full.len();
        // Every cut inside the last frame (header or payload) is torn.
        for cut in [
            tail_start + 3,
            tail_start + HEADER_LEN - 1,
            wal.bytes.len() - 1,
        ] {
            let runs = decode(&wal.bytes[..cut]).unwrap();
            assert_eq!(step_ids(&runs).len(), 3, "cut at {cut}");
        }
    }

    #[test]
    fn a_complete_final_frame_with_a_bad_digest_is_a_torn_tail() {
        let mut wal = two_runs();
        wal.push(step_started(2));
        let last = wal.bytes.len() - 1;
        wal.bytes[last] ^= 0xff;
        assert_eq!(step_ids(&decode(&wal.bytes).unwrap()).len(), 3);
    }

    #[test]
    fn a_bad_digest_before_the_end_makes_the_file_unreadable() {
        let mut wal = two_runs();
        // The last byte of the first step_started frame: a complete frame
        // with more frames after it.
        let mut prefix = Wal::new();
        prefix.push(run_started("r1", 1_000)).push(step_started(1));
        let at = prefix.bytes.len() - 1;
        wal.bytes[at] ^= 0x01;
        let error = decode(&wal.bytes).unwrap_err();
        assert!(error.contains("digest"), "{error}");
    }

    #[test]
    fn unknown_frame_versions_keep_the_prefix_and_stop_with_a_note() {
        for version in [4, 9, 255] {
            let mut wal = two_runs();
            let stop = wal.bytes.len();
            wal.bytes.extend(frame(version, wal.seq + 1, 0, b"future"));
            wal.push(step_finished(2, usage(999, 999, 999, 999)));
            let mut cursor = WalCursor::default();
            cursor.advance(
                &mut std::io::Cursor::new(&wal.bytes),
                wal.bytes.len() as u64,
                READ_BUDGET_BYTES,
            );
            assert!(cursor.failed.is_none());
            assert_eq!(cursor.offset, stop as u64);
            assert_eq!(step_ids(&cursor.fold.runs).len(), 3);
            let note = cursor.fold.activity_note.as_deref().unwrap();
            assert!(note.contains(&format!("frame version {version}")), "{note}");
            assert!(note.contains("1970-01-01T00:00:02.010"), "{note}");
            wal.push(step_finished(3, usage(999, 999, 999, 999)));
            cursor.advance(
                &mut std::io::Cursor::new(&wal.bytes),
                wal.bytes.len() as u64,
                READ_BUDGET_BYTES,
            );
            assert_eq!(cursor.offset, stop as u64);
            assert_eq!(step_ids(&cursor.fold.runs).len(), 3);
        }
    }

    #[test]
    fn gated_known_features_decode_usage_and_inner_timestamps() {
        let mut wal = Wal::new();
        for record in [
            run_started("gated", 400),
            step_finished(1, usage(10, 20, 30, 40)),
        ] {
            wal.seq += 1;
            wal.bytes.extend(frame(
                3,
                wal.seq,
                3,
                json!({"requires": KNOWN_FEATURES, "record": record})
                    .to_string()
                    .as_bytes(),
            ));
        }
        let runs = decode(&wal.bytes).unwrap();
        assert_eq!(runs[0].ts_ms, Some(400));
        assert_eq!(
            runs[0].steps[0].usage,
            StepUsage {
                input_tokens: Some(10),
                cached_input_tokens: Some(20),
                cache_write_tokens: Some(30),
                output_tokens: Some(40)
            }
        );
    }

    #[test]
    fn gated_unknown_features_keep_steps_and_do_not_interpret_the_record() {
        let mut wal = two_runs();
        let stop = wal.bytes.len();
        wal.seq += 1;
        wal.bytes.extend(frame(
            3,
            wal.seq,
            3,
            br#"{"requires":["future/v1"],"record":42}"#,
        ));
        wal.push(step_finished(2, usage(999, 999, 999, 999)));
        let mut cursor = WalCursor::default();
        cursor.advance(
            &mut std::io::Cursor::new(&wal.bytes),
            wal.bytes.len() as u64,
            READ_BUDGET_BYTES,
        );
        assert!(cursor.failed.is_none());
        assert_eq!(cursor.offset, stop as u64);
        assert_eq!(step_ids(&cursor.fold.runs).len(), 3);
        let note = cursor.fold.activity_note.unwrap();
        assert!(note.contains("future/v1"), "{note}");
        assert!(
            note.contains("showing data up to 1970-01-01T00:00:02.010"),
            "{note}"
        );
    }

    #[test]
    fn gated_frames_preserve_digest_sequence_and_torn_tail_rules() {
        let original = two_runs();
        let payload = br#"{"requires":["scope/v1"],"record":{"type":"turn_finished","step_id":1}}"#;
        let tail = frame(3, original.seq + 1, 3, payload);
        for cut in [3, HEADER_LEN - 1, tail.len() - 1] {
            let mut bytes = original.bytes.clone();
            bytes.extend(&tail[..cut]);
            assert_eq!(step_ids(&decode(&bytes).unwrap()).len(), 3);
        }
        let mut bad = tail.clone();
        bad[21] ^= 1;
        let mut bytes = original.bytes.clone();
        bytes.extend(&bad);
        assert_eq!(step_ids(&decode(&bytes).unwrap()).len(), 3);
        bytes.extend(lineage());
        assert!(decode(&bytes).unwrap_err().contains("digest"));
        let mut bytes = original.bytes.clone();
        bytes.extend(frame(3, original.seq + 2, 3, payload));
        assert!(decode(&bytes).unwrap_err().contains("sequence"));
    }

    #[test]
    fn recurring_lineage_frames_are_skipped_but_a_malformed_one_is_refused() {
        let mut wal = Wal::new();
        wal.push_lineage()
            .push(run_started("r1", 1))
            .push_lineage()
            .push_lineage()
            .push(step_finished(1, usage(1, 1, 1, 1)))
            .push_lineage();
        assert_eq!(step_ids(&decode(&wal.bytes).unwrap()).len(), 1);
        wal.bytes.extend(frame(2, 1, 0, &[0x5a; 16]));
        wal.push(step_finished(2, usage(1, 1, 1, 1)));
        assert!(decode(&wal.bytes).unwrap_err().contains("lineage"));
    }

    #[test]
    fn unknown_record_types_are_skipped() {
        let mut wal = Wal::new();
        wal.push(run_started("r1", 1))
            .push(json!({"type": "added_by_a_newer_broca", "anything": [1, 2]}))
            .push(step_finished(1, usage(1, 1, 1, 1)));
        assert_eq!(step_ids(&decode(&wal.bytes).unwrap()).len(), 1);
    }

    #[test]
    fn a_sequence_gap_makes_the_file_unreadable() {
        let mut wal = Wal::new();
        wal.push(run_started("r1", 1));
        wal.seq += 1;
        wal.push(step_finished(1, usage(1, 1, 1, 1)));
        assert!(decode(&wal.bytes).unwrap_err().contains("sequence"));
    }

    #[test]
    fn absent_usage_keys_stay_absent() {
        let mut wal = Wal::new();
        wal.push(run_started("r1", 1))
            .push(step_finished(1, json!({"input_tokens": 7})))
            .push(step_finished(2, json!({})));
        let runs = decode(&wal.bytes).unwrap();
        assert_eq!(
            runs[0].steps[0].usage,
            StepUsage {
                input_tokens: Some(7),
                ..StepUsage::default()
            }
        );
        assert_eq!(runs[0].steps[1].usage, StepUsage::default());
    }

    /// WAL bytes shaped like a live gather research session (`alfonso:gather-…`),
    /// synthesized from the record types and keys a real one holds, with no
    /// live content: one lineage frame, then bare records (no `ts_ms`/`record`
    /// envelope) written at fence 1. Each model step is followed by a tool
    /// batch and `turn_finished`; only `run_started` and
    /// `model_attempt_finished` carry a time; usage omits `cache_write_tokens`
    /// and adds `reasoning_tokens`; a `budget_fired` record comes late in the
    /// run. `steps` is `(attempt time, input, cached input)` per step. When
    /// `finished` is false the run is still going: its last frame is a
    /// `step_started` with no finished step after it.
    pub(crate) fn gather_wal(
        run_id: &str,
        started_ms: u64,
        steps: &[(u64, u64, u64)],
        finished: bool,
    ) -> Vec<u8> {
        let mut bytes = lineage();
        let mut seq = 0;
        let mut push = |record: Value| {
            seq += 1;
            bytes.extend(frame(1, seq, 1, record.to_string().as_bytes()));
        };
        push(
            json!({"type": "run_started", "run_id": run_id, "ts_ms": started_ms,
                    "session": {"project_root": "/work", "harness": "broca",
                                "session": "alfonso:gather-test"},
                    "project_id": "p", "origin": {"kind": "fresh"}, "input": [],
                    "config": {"model": {"provider_module_id": "openai",
                                          "model_id": "gpt-test"}}}),
        );
        for (index, &(attempt_ms, input, cached)) in steps.iter().enumerate() {
            let step = index as u64 + 1;
            let batch = format!("b{step}");
            push(json!({"type": "step_started", "step_id": step}));
            push(
                json!({"type": "model_attempt_finished", "step_id": step, "attempt": 0,
                        "request_body_len": 1, "request_body_sha256": "00",
                        "http_status": 200, "response_body_len": 1,
                        "response_body_sha256": "00", "outcome": "completed",
                        "ts_ms": attempt_ms}),
            );
            push(json!({"type": "model_step_finished", "step_id": step,
                        "assistant_message": {"message_id": "m", "content": []},
                        "usage": {"input_tokens": input, "cached_input_tokens": cached,
                                  "output_tokens": 200, "reasoning_tokens": 40},
                        "finish_reason": "stop", "retries_used": 0,
                        "service_tier_used": "default"}));
            push(
                json!({"type": "tool_batch_started", "batch_id": batch, "step_id": step,
                        "planned_calls": ["c1"]}),
            );
            push(json!({"type": "tool_dispatch_intent", "batch_id": batch,
                        "tool_call_id": "c1", "tool_name": "read",
                        "args": {"filePath": "a.rs"}}));
            push(json!({"type": "tool_result", "batch_id": batch,
                        "result": {"tool_call_id": "c1",
                                   "output": {"kind": "text", "text": "x"},
                                   "is_error": false},
                        "outcome": "completed"}));
            push(json!({"type": "tool_batch_finished", "batch_id": batch}));
            push(json!({"type": "turn_finished", "step_id": step}));
        }
        push(
            json!({"type": "budget_fired", "run_id": run_id, "kind": "steps",
                    "threshold": 10, "ordinal": 1, "caller_text": "wrap up"}),
        );
        if finished {
            push(json!({"type": "run_finished", "reason": "completed"}));
        } else {
            push(json!({"type": "step_started", "step_id": steps.len() as u64 + 1}));
        }
        bytes
    }

    /// WAL bytes holding `payloads` in order: a payload with a `requires` key
    /// is written as a gated (version 3) frame, any other as a plain record.
    pub(crate) fn wal_bytes(payloads: &[Value]) -> Vec<u8> {
        let mut bytes = lineage();
        for (index, payload) in payloads.iter().enumerate() {
            let version = if payload.get("requires").is_some() {
                3
            } else {
                1
            };
            bytes.extend(frame(
                version,
                index as u64 + 1,
                1,
                payload.to_string().as_bytes(),
            ));
        }
        bytes
    }

    /// A mason run cut by a daemon restart, shaped like the live one: Broca
    /// pauses the run in a gated `run_paused` frame (`restart-pause/v1`),
    /// then resumes the same run id without a new `run_started`, and step ids
    /// carry on from where they stopped.
    pub(crate) fn restart_resumed_wal() -> Vec<u8> {
        let run = "run-sid-restart";
        wal_bytes(&[
            json!({"type": "run_started", "run_id": run, "ts_ms": 1_000,
                   "session": {"project_root": "/work", "harness": "broca", "session": "alfonso:bg_mason"},
                   "config": {"model": {"provider_module_id": "openai", "model_id": "gpt-6.1-sol"},
                              "context_limit": 1_050_000},
                   "input": [], "origin": {"kind": "fresh"}}),
            step_started(1),
            attempt(1, 1_100),
            step_finished(
                1,
                json!({"input_tokens": 3_928, "cached_input_tokens": 13_056,
                                    "cache_write_tokens": 0, "output_tokens": 89}),
            ),
            step_started(2),
            attempt(2, 1_200),
            step_finished(
                2,
                json!({"input_tokens": 260, "cached_input_tokens": 16_896,
                                    "cache_write_tokens": 0, "output_tokens": 135}),
            ),
            json!({"requires": ["restart-pause/v1"],
                   "record": {"type": "run_paused", "run_id": run, "ts_ms": 1_300, "reason": "restart"}}),
            json!({"type": "resume_started", "episode": run, "resumed_from_seq": 8,
                   "replayed": {"messages": 4, "model_steps": 2, "tool_results": 0},
                   "redone": [], "indeterminate": []}),
            step_started(3),
            attempt(3, 2_000),
            step_finished(
                3,
                json!({"input_tokens": 485, "cached_input_tokens": 89_600,
                                    "cache_write_tokens": 0, "output_tokens": 780}),
            ),
            json!({"type": "run_finished", "reason": "completed", "ts_ms": 2_100,
                   "usage": {"input_tokens": 4_673, "cached_input_tokens": 119_552,
                             "cache_write_tokens": 0, "output_tokens": 1_004}}),
        ])
    }

    #[test]
    fn a_run_resumed_after_a_restart_pause_keeps_every_step() {
        let mut cursor = WalCursor::default();
        let bytes = restart_resumed_wal();
        cursor.advance(
            &mut std::io::Cursor::new(&bytes),
            bytes.len() as u64,
            bytes.len(),
        );
        assert_eq!(cursor.failed, None);
        assert_eq!(cursor.fold.activity_note, None);
        let runs = cursor.fold.runs;
        assert_eq!(
            step_ids(&runs),
            [
                ("run-sid-restart".to_string(), 1),
                ("run-sid-restart".to_string(), 2),
                ("run-sid-restart".to_string(), 3)
            ]
        );
        assert!(runs[0].finished);
    }

    /// Every feature name Broca 0.3.214 writes (`KNOWN_FEATURES` in
    /// broca-wal's framing.rs), spelled out rather than taken from this reader's own list,
    /// so a name Broca adds and this reader lacks shows up here instead of
    /// silently truncating sessions.
    #[test]
    fn every_feature_broca_writes_is_understood() {
        for feature in [
            "flow-scopes/v1",
            "plan-manifest/v1",
            "restart-pause/v1",
            "scope/v1",
            "steer-queue/v1",
            "archive-index/v2",
            "dispatch-module/v1",
            "session-class/v1",
            "retention/v1",
            "run-cancel-at/v1",
            "agent-run-scopes/v1",
            "deferred-call/v1",
            "compaction/v1",
            "compaction-wait/v1",
            "step-transforms/v1",
            "input-token-cap/v1",
            "structured-output/v1",
        ] {
            let bytes = wal_bytes(&[
                json!({"requires": [feature], "record": run_started("r1", 1)}),
                step_finished(1, usage(1, 2, 3, 4)),
            ]);
            let runs = decode(&bytes).unwrap_or_else(|e| panic!("{feature}: {e}"));
            assert_eq!(step_ids(&runs), [("r1".to_string(), 1)], "{feature}");
        }
    }

    /// `structured-output/v1` adds the frozen schema settings to `RunStarted`
    /// and a structured result record at the run's end; a run that carries both
    /// still yields its steps and finishes.
    #[test]
    fn a_structured_output_run_keeps_its_steps() {
        let mut record = run_started("r1", 1);
        record["structured_output"] = json!({"schema_digest": "sha256:00", "mode": "best_effort"});
        let bytes = wal_bytes(&[
            json!({"requires": ["structured-output/v1"], "record": record}),
            step_finished(1, usage(1, 2, 3, 4)),
            json!({"requires": ["structured-output/v1"],
                   "record": {"type": "structured_result", "run_id": "r1", "value": {"ok": true}}}),
        ]);
        let runs = decode(&bytes).unwrap();
        assert_eq!(step_ids(&runs), [("r1".to_string(), 1)]);
    }

    /// `session-class/v1` adds `session_class` to `RunStarted`; a run that
    /// carries it still yields its steps (Broca's 03:25Z deploy on
    /// 2026-10-17 started writing it on every run).
    #[test]
    fn a_run_started_with_a_session_class_keeps_its_steps() {
        let mut record = run_started("r1", 1);
        record["session_class"] = json!("mason");
        let bytes = wal_bytes(&[
            json!({"requires": ["session-class/v1"], "record": record}),
            step_finished(1, usage(1, 2, 3, 4)),
        ]);
        let runs = decode(&bytes).unwrap();
        assert_eq!(step_ids(&runs), [("r1".to_string(), 1)]);
    }

    #[test]
    fn a_gather_run_decodes_every_model_step() {
        let steps = [
            (1_010, 6_026, 0),
            (1_020, 930, 5_632),
            (1_030, 4_042, 5_632),
        ];
        let runs = decode(&gather_wal("g1", 1_000, &steps, false)).unwrap();
        assert_eq!(
            step_ids(&runs),
            [("g1".into(), 1), ("g1".into(), 2), ("g1".into(), 3)]
        );
        let step = &runs[0].steps[1];
        assert_eq!(step.ts_ms, Some(1_020));
        assert_eq!(step.model.as_deref(), Some("gpt-test"));
        assert_eq!(
            step.usage,
            StepUsage {
                input_tokens: Some(930),
                cached_input_tokens: Some(5_632),
                cache_write_tokens: None,
                output_tokens: Some(200),
            }
        );
        assert!(!runs[0].finished);
    }

    /// Counts the bytes a reader hands out, to prove a poll reads only what
    /// was appended.
    struct Counting<'a> {
        inner: std::io::Cursor<&'a [u8]>,
        read: usize,
    }

    impl Read for Counting<'_> {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let n = self.inner.read(buf)?;
            self.read += n;
            Ok(n)
        }
    }

    impl Seek for Counting<'_> {
        fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
            self.inner.seek(pos)
        }
    }

    fn poll(cursor: &mut WalCursor, bytes: &[u8], budget: usize) -> usize {
        let mut reader = Counting {
            inner: std::io::Cursor::new(bytes),
            read: 0,
        };
        cursor.advance(&mut reader, bytes.len() as u64, budget);
        reader.read
    }

    #[test]
    fn incremental_reads_resume_from_the_remembered_offset() {
        let mut wal = Wal::new();
        wal.push(run_started("r1", 1))
            .push(step_finished(1, usage(1, 1, 1, 1)));
        let first_len = wal.bytes.len();
        // Broca is mid-way through appending the next frame.
        wal.push(step_finished(2, usage(2, 2, 2, 2)));
        let torn = &wal.bytes[..wal.bytes.len() - 5];

        let mut cursor = WalCursor::default();
        assert_eq!(poll(&mut cursor, torn, READ_BUDGET_BYTES), torn.len());
        assert_eq!(cursor.offset, first_len as u64);
        assert_eq!(cursor.fold.runs[0].steps.len(), 1);

        // Nothing new, not even the torn fragment, is read again.
        assert_eq!(poll(&mut cursor, torn, READ_BUDGET_BYTES), 0);

        // The append completes and another follows; only bytes past the
        // remembered offset are read.
        wal.push(step_finished(3, usage(3, 3, 3, 3)));
        let read = poll(&mut cursor, &wal.bytes, READ_BUDGET_BYTES);
        assert_eq!(read, wal.bytes.len() - first_len);
        let steps: Vec<_> = cursor.fold.runs[0]
            .steps
            .iter()
            .map(|s| s.step_id)
            .collect();
        assert_eq!(steps, [1, 2, 3]);
    }

    #[test]
    fn a_small_budget_catches_up_over_several_polls() {
        let bytes = two_runs().bytes;
        let mut cursor = WalCursor::default();
        let mut polls = 0;
        while cursor.offset < bytes.len() as u64 {
            // A budget far below one frame still reads one whole frame.
            let read = poll(&mut cursor, &bytes, 8);
            assert!(read > 0);
            assert!(cursor.failed.is_none(), "{:?}", cursor.failed);
            polls += 1;
        }
        assert!(polls > 5);
        assert_eq!(step_ids(&cursor.fold.runs).len(), 3);
    }

    #[test]
    fn a_file_that_shrinks_is_read_again_from_the_start() {
        let long = two_runs().bytes;
        let mut cursor = WalCursor::default();
        poll(&mut cursor, &long, READ_BUDGET_BYTES);
        let mut short = Wal::new();
        short
            .push(run_started("r9", 1))
            .push(step_finished(1, usage(1, 1, 1, 1)));
        poll(&mut cursor, &short.bytes, READ_BUDGET_BYTES);
        assert_eq!(step_ids(&cursor.fold.runs), [("r9".to_string(), 1)]);
    }

    // ── Files on disk, live and archived ──

    fn identity() -> SessionIdentity {
        SessionIdentity {
            project_root: "/private/tmp/project".into(),
            harness: "broca".into(),
            session: "alfonso:bg_fixture".into(),
        }
    }

    fn write_live(root: &Path, bytes: &[u8]) -> PathBuf {
        std::fs::create_dir_all(root.join("wal")).unwrap();
        let path = root.join("wal").join(format!("{}.wal", identity().addr()));
        std::fs::write(&path, bytes).unwrap();
        path
    }

    /// A sealed container in Broca's layout: members, index, index length,
    /// trailer magic.
    fn container(members: &[(&str, &[u8])], with_index: bool) -> Vec<u8> {
        let mut out = Vec::new();
        let mut index = Vec::new();
        for (address, payload) in members {
            index.push((address.to_string(), out.len() as u64, payload.len() as u64));
            out.extend_from_slice(b"WALM\x01\x00\x00\x00");
            out.extend_from_slice(address.as_bytes());
            out.extend_from_slice(&(payload.len() as u64).to_le_bytes());
            out.extend_from_slice(&Sha256::digest(payload));
            out.extend_from_slice(payload);
        }
        let mut index_bytes = (index.len() as u32).to_le_bytes().to_vec();
        for (address, offset, size) in index {
            index_bytes.extend_from_slice(address.as_bytes());
            index_bytes.extend_from_slice(&offset.to_le_bytes());
            index_bytes.extend_from_slice(&size.to_le_bytes());
        }
        if !with_index {
            index_bytes = b"junk".to_vec();
        }
        out.extend_from_slice(&index_bytes);
        out.extend_from_slice(&(index_bytes.len() as u32).to_le_bytes());
        out.extend_from_slice(b"WALK");
        out
    }

    fn write_container(root: &Path, stamp: u64, bytes: &[u8]) {
        let dir = root.join("wal-archive");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("fold-{stamp}.ark")), bytes).unwrap();
    }

    fn one_step_wal(run: &str) -> Vec<u8> {
        let mut wal = Wal::new();
        wal.push(run_started(run, 1))
            .push(step_finished(1, usage(1, 1, 1, 1)));
        wal.bytes
    }

    fn run_ids(runs: Option<Vec<WalRun>>) -> Option<Vec<String>> {
        runs.map(|runs| runs.into_iter().map(|run| run.run_id).collect())
    }

    #[test]
    fn a_live_file_is_read_from_disk_and_appends_are_picked_up() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_live(dir.path(), &one_step_wal("r1"));
        let mut cache = WalCache::default();
        let runs = cache.session_runs(dir.path(), &identity()).unwrap();
        assert_eq!(step_ids(&runs), [("r1".to_string(), 1)]);

        let mut more = Wal::new();
        more.seq = 2;
        more.bytes.clear();
        more.push(step_finished(2, usage(2, 2, 2, 2)));
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(&more.bytes)
            .unwrap();
        let runs = cache.session_runs(dir.path(), &identity()).unwrap();
        assert_eq!(
            step_ids(&runs),
            [("r1".to_string(), 1), ("r1".to_string(), 2)]
        );
    }

    #[test]
    fn a_live_file_replaced_by_one_no_shorter_is_read_again_from_the_start() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_live(dir.path(), &one_step_wal("r1"));
        let mut cache = WalCache::default();
        let runs = cache.session_runs(dir.path(), &identity()).unwrap();
        assert_eq!(step_ids(&runs), [("r1".to_string(), 1)]);

        // Same length, different file: written aside and renamed over the
        // old one, so only the file's identity says it changed.
        let replacement = one_step_wal("r2");
        assert_eq!(replacement.len(), one_step_wal("r1").len());
        let aside = path.with_extension("tmp");
        std::fs::write(&aside, &replacement).unwrap();
        std::fs::rename(&aside, &path).unwrap();
        let runs = cache.session_runs(dir.path(), &identity()).unwrap();
        assert_eq!(step_ids(&runs), [("r2".to_string(), 1)]);
    }

    #[test]
    fn the_list_note_reports_only_what_was_already_read() {
        let dir = tempfile::tempdir().unwrap();
        let mut wal = two_runs();
        wal.bytes.extend(frame(4, wal.seq + 1, 0, b"future"));
        write_live(dir.path(), &wal.bytes);
        let mut cache = WalCache::default();
        // Asking for the note reads nothing, so nothing is known yet.
        assert_eq!(cache.known_note(&identity()), None);
        assert!(cache.live.is_empty());
        let note = cache
            .session_snapshot(dir.path(), &identity())
            .unwrap()
            .activity_note;
        assert!(note.is_some());
        assert_eq!(cache.known_note(&identity()), note);
    }

    #[test]
    fn compatibility_notes_and_prefix_steps_survive_live_and_archive_caches() {
        for archived in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let mut wal = two_runs();
            wal.bytes.extend(frame(4, wal.seq + 1, 0, b"future"));
            if archived {
                write_container(
                    dir.path(),
                    100,
                    &container(&[(&identity().addr(), &wal.bytes)], true),
                );
            } else {
                write_live(dir.path(), &wal.bytes);
            }
            for _ in 0..2 {
                let (runs, note) = session_runs(dir.path(), &identity()).unwrap();
                assert_eq!(step_ids(&runs).len(), 3);
                assert!(note.as_deref().unwrap().contains("showing data up to"));
                assert_eq!(session_activity_note(&identity()), note);
            }
        }
    }

    #[test]
    fn a_missing_or_corrupt_live_file_yields_no_steps() {
        let dir = tempfile::tempdir().unwrap();
        let mut cache = WalCache::default();
        assert!(cache.session_runs(dir.path(), &identity()).is_none());
        let mut bytes = two_runs().bytes;
        bytes[HEADER_LEN + 16 + 10] ^= 0xff; // the first record frame's header, after the lineage frame
        write_live(dir.path(), &bytes);
        assert!(cache.session_runs(dir.path(), &identity()).is_none());
    }

    #[test]
    fn archived_members_are_read_newest_container_first_and_live_wins() {
        let dir = tempfile::tempdir().unwrap();
        let address = identity().addr();
        let other = "0123456789abcdef";
        let old = one_step_wal("old");
        let new = one_step_wal("new");
        let filler = one_step_wal("filler");
        write_container(
            dir.path(),
            100,
            &container(&[(other, &filler), (&address, &old)], true),
        );
        // The newer container has lost its index: its headers are walked.
        write_container(
            dir.path(),
            200,
            &container(&[(&address, &new), (other, &filler)], false),
        );
        // An unsealed container (a fold still running) is skipped.
        write_container(dir.path(), 300, b"WALM partial");
        let mut cache = WalCache::default();
        assert_eq!(
            run_ids(cache.session_runs(dir.path(), &identity())),
            Some(vec!["new".into()])
        );
        write_live(dir.path(), &one_step_wal("live"));
        assert_eq!(
            run_ids(cache.session_runs(dir.path(), &identity())),
            Some(vec!["live".into()])
        );
    }

    #[test]
    fn an_unreadable_container_or_member_yields_no_steps() {
        let address = identity().addr();
        let wal = one_step_wal("r1");

        // The member's bytes do not match its recorded digest.
        let dir = tempfile::tempdir().unwrap();
        let mut bytes = container(&[(&address, &wal)], true);
        bytes[70] ^= 0xff;
        write_container(dir.path(), 100, &bytes);
        assert!(WalCache::default()
            .session_runs(dir.path(), &identity())
            .is_none());

        // An unknown member format version.
        let dir = tempfile::tempdir().unwrap();
        let mut bytes = container(&[(&address, &wal)], false);
        bytes[4] = 2;
        write_container(dir.path(), 100, &bytes);
        assert!(WalCache::default()
            .session_runs(dir.path(), &identity())
            .is_none());

        // A newer container that cannot be read hides an older copy, which
        // might be stale.
        let dir = tempfile::tempdir().unwrap();
        write_container(dir.path(), 100, &container(&[(&address, &wal)], true));
        let mut broken = container(&[(&address, &wal)], false);
        broken[4] = 9;
        write_container(dir.path(), 200, &broken);
        assert!(WalCache::default()
            .session_runs(dir.path(), &identity())
            .is_none());

        // The control: the same older container alone is read.
        let dir = tempfile::tempdir().unwrap();
        write_container(dir.path(), 100, &container(&[(&address, &wal)], true));
        assert_eq!(
            run_ids(WalCache::default().session_runs(dir.path(), &identity())),
            Some(vec!["r1".into()])
        );
    }

    #[test]
    fn a_member_size_that_overflows_is_refused_without_panicking() {
        let address = identity().addr();
        let wal = one_step_wal("r1");
        let huge = (u64::MAX - 10).to_le_bytes();

        // In a member header, read when the index is missing.
        let dir = tempfile::tempdir().unwrap();
        let mut bytes = container(&[(&address, &wal)], false);
        bytes[24..32].copy_from_slice(&huge);
        write_container(dir.path(), 100, &bytes);
        assert!(WalCache::default()
            .session_runs(dir.path(), &identity())
            .is_none());

        // In the stored index: entry = address(16) offset(8) size(8), after
        // the 4-byte entry count that follows the members.
        let dir = tempfile::tempdir().unwrap();
        let mut bytes = container(&[(&address, &wal)], true);
        let size_at = ARCHIVE_MEMBER_HEADER_LEN as usize + wal.len() + 4 + 24;
        bytes[size_at..size_at + 8].copy_from_slice(&huge);
        write_container(dir.path(), 100, &bytes);
        // The index is rejected and the headers are walked instead.
        assert_eq!(
            run_ids(WalCache::default().session_runs(dir.path(), &identity())),
            Some(vec!["r1".into()])
        );
    }

    #[test]
    fn decoded_archived_members_are_bounded() {
        let mut cache = WalCache::default();
        for i in 0..(MAX_REMEMBERED_ARCHIVED as u64 + 5) {
            cache.remember_archived((PathBuf::from(format!("c{i}.ark")), 0, 100), Err("x".into()));
        }
        assert!(cache.archived.len() <= MAX_REMEMBERED_ARCHIVED);

        // A rewritten container replaces what was cached for its old length.
        let mut cache = WalCache::default();
        let path = PathBuf::from("fold-1.ark");
        cache.remember_archived((path.clone(), 0, 100), Err("old".into()));
        cache.remember_archived((path.clone(), 0, 200), Err("new".into()));
        assert_eq!(cache.archived.keys().collect::<Vec<_>>(), [&(path, 0, 200)]);
    }

    #[test]
    fn fold_stamps_must_be_canonical() {
        assert_eq!(
            fold_stamp("fold-1789317632019.ark"),
            Some(1_789_317_632_019)
        );
        assert_eq!(fold_stamp("fold-0.ark"), Some(0));
        assert_eq!(fold_stamp("fold-01.ark"), None);
        assert_eq!(fold_stamp("fold-.ark"), None);
        assert_eq!(fold_stamp("fold-12x.ark"), None);
    }
}
