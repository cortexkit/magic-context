use crate::tail_hygiene::TailHygieneMeasurement;
use sha2::{Digest, Sha256};

#[derive(Default, Debug)]
pub(crate) struct HygieneMemo {
    pub key: Option<[u8; 32]>,
    pub measured: Option<TailHygieneMeasurement>,
}
impl HygieneMemo {
    pub fn key<T: serde::Serialize>(value: &T) -> [u8; 32] {
        Sha256::digest(serde_json::to_vec(value).expect("hygiene identity JSON")).into()
    }
    pub fn retained_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + self.measured.as_ref().map_or(0, |measured| {
                measured.content_signature.capacity()
                    + measured.parts.capacity()
                        * std::mem::size_of::<mc_store::TailHygienePartMeasurement>()
                    + measured
                        .parts
                        .iter()
                        .map(|part| {
                            part.key.capacity()
                                + part.content_hash.capacity()
                                + part.tag_status.as_ref().map_or(0, String::capacity)
                        })
                        .sum::<usize>()
            })
    }
}
