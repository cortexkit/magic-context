//! Unmodified Broca serve captures shared by the two production subscribe readers.

use serde_json::Value;
use std::path::PathBuf;

pub(crate) struct Case {
    pub name: &'static str,
    pub before: Capture,
    pub after: Capture,
}

pub(crate) struct Capture {
    pub path: String,
    pub frames: Vec<Value>,
}

pub(crate) fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("testdata/broca-held-calls")
}

pub(crate) fn cases() -> Vec<Case> {
    [
        "status-late-listed-live",
        "status-late-listed-replay",
        "status-late-settled-live",
        "status-late-settled-replay",
        "status-expired-listed-live",
        "status-expired-listed-replay",
        "status-expired-settled-live",
        "status-expired-settled-replay",
        "status-ordinary-settled-live",
        "status-ordinary-settled-replay",
    ]
    .into_iter()
    .map(|name| {
        let load = |side| {
            let path = format!("{side}/{name}.jsonl");
            let bytes = std::fs::read_to_string(root().join(&path)).unwrap();
            let frames = bytes
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect();
            Capture { path, frames }
        };
        Case {
            name,
            before: load("before"),
            after: load("after"),
        }
    })
    .collect()
}

impl Capture {
    pub fn listed(&self) -> bool {
        self.path.contains("-listed-")
    }

    pub fn state(&self) -> &'static str {
        if !self.listed() {
            "completed"
        } else if self.path.starts_with("before/") {
            "paused"
        } else {
            "active"
        }
    }

    pub fn controls(&self) -> usize {
        self.frames
            .iter()
            .filter(|frame| frame["kind"] == "control")
            .count()
    }
}

#[test]
fn broca_held_calls_fixture_checksums_and_shape() {
    use sha2::{Digest, Sha256};
    let manifest = std::fs::read(root().join("SHA256SUMS")).unwrap();
    assert_eq!(
        format!("{:x}", Sha256::digest(&manifest)),
        "805637f2c284435c3ce2d581a918fce1cc67545959335db5345383c172063197"
    );
    let manifest = String::from_utf8(manifest).unwrap();
    assert_eq!(manifest.lines().count(), 20);
    for line in manifest.lines() {
        let mut fields = line.split_whitespace();
        let hash = fields.next().unwrap();
        let path = fields.next().unwrap();
        let bytes = std::fs::read(root().join(path)).unwrap();
        assert_eq!(format!("{:x}", Sha256::digest(bytes)), hash, "{path}");
    }
    for case in cases() {
        for capture in [&case.before, &case.after] {
            for (index, frame) in capture.frames.iter().enumerate() {
                assert_eq!(frame["seq"], index + 1, "{}", capture.path);
            }
        }
        let statuses: Vec<_> = case
            .after
            .frames
            .iter()
            .filter(|frame| frame["unit"]["type"] == "status")
            .collect();
        if case.name.contains("ordinary") {
            assert!(statuses.is_empty());
        } else {
            assert_eq!(statuses.len(), if case.after.listed() { 1 } else { 2 });
            for (index, frame) in statuses.iter().enumerate() {
                assert_eq!(frame["kind"], "control");
                assert_eq!(frame["state"], "active");
                assert!(frame["cursor"]["wal_seq"].is_u64());
                assert!(frame["unit"]["run_id"].is_string());
                assert!(frame.get("event").is_none());
                if index == 0 {
                    assert!(!frame["held_calls"].as_array().unwrap().is_empty());
                } else {
                    assert!(frame.get("held_calls").is_none());
                }
            }
        }
        assert!(!case.after.frames.iter().any(|frame| {
            frame["unit"]["type"] == "paused" || frame["event"]["type"] == "run_paused"
        }));
    }
}
