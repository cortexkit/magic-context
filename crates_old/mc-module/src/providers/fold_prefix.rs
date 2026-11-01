//! Messages already represented by summaries have zero measured tokens and no
//! tag, protection, or queued-drop state. Their immutable key/hash pairs need
//! only a retained SHA state and counts; the unsummarized tail keeps full measurements.
use mc_store::provider_records::ProviderPolicyPart;
use sha2::{Digest, Sha256};

#[derive(Clone, Debug)]
pub struct FoldPrefix {
    pub cut_id: u64,
    pub through: u64,
    pub parts: usize,
    pub users: u64,
    pub messages: usize,
    pub has_system: bool,
    signature: Sha256,
}

impl FoldPrefix {
    pub fn reference(&self) -> mc_store::provider_records::ProviderNativePrefix {
        mc_store::provider_records::ProviderNativePrefix {
            cut_id: self.cut_id,
            through: self.through,
            parts: self.parts,
        }
    }
    pub fn build(parts: &[ProviderPolicyPart], settings: &serde_json::Value) -> Option<Self> {
        let mut prefix = Self {
            cut_id: settings.get("baseline_cut_id")?.as_u64()?,
            through: settings.get("coverage")?.as_u64()?,
            parts: 0,
            users: 0,
            messages: 0,
            has_system: false,
            signature: Sha256::new(),
        };
        let through = prefix.through;
        for part in parts.iter().take_while(|part| part.ordinal <= through) {
            if part.kind == "header" {
                prefix.messages += 1;
                prefix.has_system |= part.role == "system";
                prefix.users += u64::from(part.real_user);
            } else {
                prefix.push(&part.measurement);
            }
        }
        Some(prefix)
    }

    pub fn push(&mut self, part: &mc_store::TailHygienePartMeasurement) {
        self.signature.update(part.key.as_bytes());
        self.signature.update(b":");
        self.signature.update(part.content_hash.as_bytes());
        self.signature.update(b"\0");
        self.parts += 1;
    }

    pub fn signature(&self, tail: &[mc_store::TailHygienePartMeasurement]) -> String {
        let mut state = self.signature.clone();
        for part in tail {
            state.update(part.key.as_bytes());
            state.update(b":");
            state.update(part.content_hash.as_bytes());
            state.update(b"\0");
        }
        format!("{:x}", state.finalize())
    }
}
