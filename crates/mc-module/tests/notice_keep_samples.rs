//! Kept-notice entries and read replies captured from the Broca llm-runner.

use cortexkit_role_compaction::{
    notice::NoticeRequest,
    read::{entry_digest, Entry, ReadPage},
};
use cortexkit_role_llm_runner::{read::ReadPage as RunnerPage, wire::read_reply};
use mc_module::index::{Extend, Index};
use serde_json::{json, Value};

const KEPT: &[u8] = include_bytes!("../testdata/notice-keep-1122/entry-kept-notice.json");
const UNKEPT: &[u8] = include_bytes!("../testdata/notice-keep-1122/entry-notice.json");
const DISPLAY_READ: &[u8] = include_bytes!("../testdata/notice-keep-1122/keep-read.json");
const DEFAULT_READ: &[u8] = include_bytes!("../testdata/notice-keep-1122/keep-default-read.json");

#[test]
fn compaction_entries_and_notices_decode_and_match_their_wire_digests() {
    let entries = [(KEPT, true), (UNKEPT, false)].map(|(sample, keep)| {
        let entry: Entry = serde_json::from_slice(sample).unwrap();
        assert_eq!(entry.notice.as_ref().unwrap().keep, keep);
        let value: Value = serde_json::from_slice(sample).unwrap();
        assert_eq!(serde_json::to_value(&entry).unwrap(), value);
        assert_eq!(
            entry_digest(entry.role.clone(), entry.notice.as_ref(), &entry.parts),
            entry.digest
        );
        let page: ReadPage = serde_json::from_slice(
            &serde_json::to_vec(&json!({"entries": [value], "head": {}})).unwrap(),
        )
        .unwrap();
        let notice: NoticeRequest = serde_json::from_value(json!({
            "seq": 1, "entries": [value], "conditions": {
                "model": {"provider": "fake", "model": "fake"},
                "context_window": 10000, "output_reserve": 100,
                "rules": {"signed_parts": "none", "history_edit_cost": "suffix"}
            }
        }))
        .unwrap();
        assert_eq!(notice.entries, page.entries);
        assert_eq!(page.entries.as_slice(), std::slice::from_ref(&entry));
        entry
    });
    assert_eq!(entries[0].parts, entries[1].parts);
    assert_ne!(entries[0].digest, entries[1].digest);
}

#[test]
fn unchanged_entry_recognition_preserves_notice_keep() {
    for (sample, keep) in [(KEPT, true), (UNKEPT, false)] {
        let entry: Entry = serde_json::from_slice(sample).unwrap();
        let mut index = Index::default();
        assert_eq!(index.extend([entry.clone()]), Extend::Continued);
        assert_eq!(index.extend([entry.clone()]), Extend::Continued);
        assert_eq!(index.cursor().unwrap().digest, entry.digest);
        let mut unnumbered = entry;
        unnumbered.parts[0].tag = None;
        unnumbered.numbers_unknown = true;
        unnumbered.digest = entry_digest(
            unnumbered.role.clone(),
            unnumbered.notice.as_ref(),
            &unnumbered.parts,
        );
        assert_eq!(index.extend([unnumbered.clone()]), Extend::Continued);
        assert_eq!(index.entries(), &[unnumbered]);
        assert_eq!(index.entries()[0].notice.as_ref().unwrap().keep, keep);
    }
}

#[test]
fn llm_runner_read_keeps_the_opted_in_fact_and_leaves_default_unchanged() {
    // ck-mc itself reads transcript entries from session.entries, not from
    // llm-runner session.read. Verify its pinned llm-runner decoder as well.
    let opt_in: RunnerPage = read_reply(DISPLAY_READ).unwrap();
    let default: RunnerPage = read_reply(DEFAULT_READ).unwrap();
    assert_eq!(opt_in.history_version, default.history_version);
    assert_eq!(opt_in.messages.len(), 3);
    assert_eq!(default.messages.len(), 3);
    for (i, (displayed, plain)) in opt_in.messages.iter().zip(&default.messages).enumerate() {
        assert_eq!(displayed.message, plain.message);
        assert_eq!(displayed.keep, i < 2);
        assert_eq!(displayed.notice, i < 2);
        assert!(!plain.keep && !plain.notice);
        assert!(serde_json::to_value(plain).unwrap().get("keep").is_none());
    }
}
