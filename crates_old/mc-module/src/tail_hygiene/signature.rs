//! A persistent SHA-256 continuation for the exact ordered hygiene-part stream.
use super::{excluded_part, FlatProjection, TailHygienePartMeasurement};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "CheckpointWire")]
struct Checkpoint {
    state: [u32; 8],
    bytes: u64,
    buffer: Vec<u8>,
}

#[derive(Deserialize)]
struct CheckpointWire {
    state: [u32; 8],
    bytes: u64,
    buffer: Vec<u8>,
}

impl TryFrom<CheckpointWire> for Checkpoint {
    type Error = &'static str;
    fn try_from(value: CheckpointWire) -> Result<Self, Self::Error> {
        if value.buffer.len() >= 64 || value.bytes % 64 != value.buffer.len() as u64 {
            return Err("invalid SHA-256 checkpoint buffer");
        }
        Ok(Self {
            state: value.state,
            bytes: value.bytes,
            buffer: value.buffer,
        })
    }
}

impl Default for Checkpoint {
    fn default() -> Self {
        Self {
            state: [
                0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
                0x5be0cd19,
            ],
            bytes: 0,
            buffer: Vec::new(),
        }
    }
}

impl Checkpoint {
    fn update(&mut self, mut bytes: &[u8]) {
        self.bytes = self.bytes.wrapping_add(bytes.len() as u64);
        while !bytes.is_empty() {
            let count = (64 - self.buffer.len()).min(bytes.len());
            self.buffer.extend_from_slice(&bytes[..count]);
            bytes = &bytes[count..];
            if self.buffer.len() == 64 {
                let block =
                    sha2::digest::generic_array::GenericArray::clone_from_slice(&self.buffer);
                sha2::compress256(&mut self.state, &[block]);
                self.buffer.clear();
            }
        }
    }

    fn part(&mut self, part: &TailHygienePartMeasurement) {
        self.update(part.key.as_bytes());
        self.update(b":");
        self.update(part.content_hash.as_bytes());
        self.update(&[0]);
    }

    fn finish(mut self) -> String {
        let bits = self.bytes.wrapping_mul(8).to_be_bytes();
        self.update(&[0x80]);
        while self.buffer.len() != 56 {
            self.update(&[0]);
        }
        self.update(&bits);
        self.state
            .iter()
            .map(|word| format!("{word:08x}"))
            .collect()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct SignaturePrefix {
    pub(crate) first: u64,
    checkpoint: Checkpoint,
}

impl SignaturePrefix {
    pub(crate) fn heap_bytes(&self) -> usize {
        self.checkpoint.buffer.capacity()
    }
    /// Covered blocks always use the excluded-part hash, even though they do
    /// not count toward tokens. Keep their SHA state, not their source bytes.
    pub(crate) fn capture(
        first: u64,
        previous: Option<&Self>,
        projection: &FlatProjection,
    ) -> Option<Self> {
        if previous.is_some_and(|prefix| prefix.first > first) {
            return None;
        }
        let base = previous.map_or(0, |prefix| prefix.first);
        let mut checkpoint = previous
            .map(|prefix| prefix.checkpoint.clone())
            .unwrap_or_default();
        for block in projection
            .blocks
            .iter()
            .filter(|block| block.ordinal >= base && block.ordinal < first)
        {
            checkpoint.part(&excluded_part(
                format!("{}\0{}", block.id, block.kind_tag),
                &block.bytes,
            ));
        }
        Some(Self { first, checkpoint })
    }

    pub(crate) fn signature(
        &self,
        projection: &FlatProjection,
        parts: &[TailHygienePartMeasurement],
    ) -> String {
        let mut checkpoint = self.checkpoint.clone();
        for (block, part) in projection.blocks.iter().zip(parts) {
            if block.ordinal >= self.first {
                checkpoint.part(part);
            }
        }
        checkpoint.finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    #[test]
    fn serialized_sha_continuation_matches_standard_sha256() {
        for len in [0, 1, 55, 56, 63, 64, 65, 127, 128, 129, 4096] {
            let bytes = (0..len).map(|index| (index * 31) as u8).collect::<Vec<_>>();
            for split in 0..=len.min(130) {
                let mut checkpoint = Checkpoint::default();
                checkpoint.update(&bytes[..split]);
                let encoded = serde_json::to_vec(&checkpoint).unwrap();
                assert!(
                    encoded.len() < 400,
                    "checkpoint is bounded independently of the prefix"
                );
                let mut restored: Checkpoint = serde_json::from_slice(&encoded).unwrap();
                for chunk in bytes[split..].chunks(17) {
                    restored.update(chunk);
                }
                assert_eq!(
                    restored.finish(),
                    format!("{:x}", Sha256::digest(&bytes)),
                    "len={len} split={split}"
                );
            }
        }
        let invalid = serde_json::json!({"state":vec![0;8],"bytes":64,"buffer":[0]});
        assert!(serde_json::from_value::<Checkpoint>(invalid).is_err());
    }

    #[test]
    fn excluding_zero_weight_parts_preserves_totals_signature_and_newest_boundary() {
        let included = super::super::part_measurement(
            "m1#0\0text".into(),
            mc_store::TailHygienePartKind::Text,
            "text",
            4,
            Some(1),
            false,
            false,
        );
        let mut measured = super::super::TailHygieneMeasurement {
            u: 8,
            t: 8,
            content_signature: "preserve the full hash".into(),
            parts: vec![
                excluded_part("m0#0\0text".into(), "covered"),
                included.clone(),
                excluded_part("m1#1\0reasoning".into(), "signed"),
                included,
            ],
            newest_message_part_start: 3,
        };
        measured.omit_excluded_baseline_parts();
        assert_eq!((measured.u, measured.t), (8, 8));
        assert_eq!(measured.content_signature, "preserve the full hash");
        assert_eq!(measured.newest_message_part_start, 1);
        assert_eq!(measured.parts.len(), 2);
    }
}
