//! First-divergence attribution for served CK block sequences.
//!
//! The comparison intentionally treats appending after the previously served set as normal
//! tail growth. It only reports a mismatch when an existing served position changes, so the
//! steady-state path compares block hashes and exits at the first changed position.

use mc_store::ServedBlockFingerprint;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DivergenceKind {
    ContentChanged,
    Inserted,
    Removed,
    Reordered,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FirstDivergence {
    pub index: usize,
    pub block_id_old: Option<String>,
    pub block_id_new: Option<String>,
    pub kind: DivergenceKind,
    pub approx_token_depth: usize,
}

/// Compare the old and new served block sequences and return their first non-append mismatch.
///
/// A missing old sequence is a cold start, not a divergence. Likewise, a new sequence that
/// retains every old entry in order and only appends blocks is normal tail growth.
pub fn first_divergence(
    old: &[ServedBlockFingerprint],
    new: &[ServedBlockFingerprint],
) -> Option<FirstDivergence> {
    if old.is_empty() {
        return None;
    }

    for index in 0..old.len().min(new.len()) {
        let old_block = &old[index];
        let new_block = &new[index];
        if old_block == new_block {
            continue;
        }

        let kind = if old_block.block_id == new_block.block_id {
            DivergenceKind::ContentChanged
        } else {
            let old_id_reappears = new[index..]
                .iter()
                .any(|block| block.block_id == old_block.block_id);
            let new_id_reappears = old[index..]
                .iter()
                .any(|block| block.block_id == new_block.block_id);
            match (old_id_reappears, new_id_reappears) {
                (true, false) => DivergenceKind::Inserted,
                (false, true) => DivergenceKind::Removed,
                (true, true) | (false, false) => DivergenceKind::Reordered,
            }
        };

        return Some(FirstDivergence {
            index,
            block_id_old: Some(old_block.block_id.clone()),
            block_id_new: Some(new_block.block_id.clone()),
            kind,
            approx_token_depth: approx_token_depth(old, new, index),
        });
    }

    // The old sequence being a prefix of the new one is append-only growth, not a bust
    // attribution. A shorter new sequence removes a previously served tail block.
    if new.len() < old.len() {
        let index = new.len();
        let old_block = &old[index];
        return Some(FirstDivergence {
            index,
            block_id_old: Some(old_block.block_id.clone()),
            block_id_new: None,
            kind: DivergenceKind::Removed,
            approx_token_depth: approx_token_depth(old, new, index),
        });
    }

    None
}

fn approx_token_depth(
    old: &[ServedBlockFingerprint],
    new: &[ServedBlockFingerprint],
    index: usize,
) -> usize {
    let old_bytes = old.iter().take(index).fold(0usize, |total, block| {
        total.saturating_add(block.serialized_len)
    });
    let new_bytes = new.iter().take(index).fold(0usize, |total, block| {
        total.saturating_add(block.serialized_len)
    });
    old_bytes.max(new_bytes).saturating_add(3) / 4
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block(id: &str, hash: &str, len: usize) -> ServedBlockFingerprint {
        ServedBlockFingerprint {
            block_id: id.to_string(),
            content_hash: hash.to_string(),
            serialized_len: len,
        }
    }

    #[test]
    fn reports_content_change() {
        let old = vec![block("a", "one", 8), block("b", "two", 8)];
        let new = vec![block("a", "changed", 12), block("b", "two", 8)];
        let divergence = first_divergence(&old, &new).unwrap();
        assert_eq!(divergence.index, 0);
        assert_eq!(divergence.kind, DivergenceKind::ContentChanged);
        assert_eq!(divergence.block_id_old.as_deref(), Some("a"));
        assert_eq!(divergence.block_id_new.as_deref(), Some("a"));
    }

    #[test]
    fn reports_insertion_in_the_middle() {
        let old = vec![block("a", "a", 4), block("b", "b", 4), block("c", "c", 4)];
        let new = vec![
            block("a", "a", 4),
            block("x", "x", 4),
            block("b", "b", 4),
            block("c", "c", 4),
        ];
        let divergence = first_divergence(&old, &new).unwrap();
        assert_eq!(divergence.kind, DivergenceKind::Inserted);
        assert_eq!(divergence.index, 1);
    }

    #[test]
    fn reports_removal_in_the_middle() {
        let old = vec![block("a", "a", 4), block("b", "b", 4), block("c", "c", 4)];
        let new = vec![block("a", "a", 4), block("c", "c", 4)];
        let divergence = first_divergence(&old, &new).unwrap();
        assert_eq!(divergence.kind, DivergenceKind::Removed);
        assert_eq!(divergence.index, 1);
        assert_eq!(divergence.block_id_old.as_deref(), Some("b"));
        assert_eq!(divergence.block_id_new.as_deref(), Some("c"));
    }

    #[test]
    fn reports_reordering() {
        let old = vec![block("a", "a", 4), block("b", "b", 4), block("c", "c", 4)];
        let new = vec![block("b", "b", 4), block("a", "a", 4), block("c", "c", 4)];
        let divergence = first_divergence(&old, &new).unwrap();
        assert_eq!(divergence.kind, DivergenceKind::Reordered);
        assert_eq!(divergence.index, 0);
    }

    #[test]
    fn append_past_old_end_is_not_a_divergence() {
        let old = vec![block("a", "a", 4), block("b", "b", 4)];
        let new = vec![old[0].clone(), old[1].clone(), block("c", "c", 4)];
        assert_eq!(first_divergence(&old, &new), None);
    }

    #[test]
    fn identical_sequence_is_fast_path_none() {
        let old = vec![block("a", "a", 4), block("b", "b", 4)];
        assert_eq!(first_divergence(&old, &old), None);
    }

    #[test]
    fn absent_fingerprint_is_a_cold_start() {
        let new = vec![block("a", "a", 4)];
        assert_eq!(first_divergence(&[], &new), None);
    }
}
