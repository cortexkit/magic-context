//! Vector persistence extension; register store and drain implementations in this namespace.

pub mod drain;
pub mod queue;
pub mod store;

#[cfg(test)]
mod queue_tests;

use crate::parity_schema_manifest::*;

pub struct UnavailableRetrievalVectors;
pub static UNAVAILABLE: UnavailableRetrievalVectors = UnavailableRetrievalVectors;

impl RetrievalVectorStore for UnavailableRetrievalVectors {
    fn availability(&self) -> Availability {
        unavailable("retrieval_vectors")
    }

    fn read(&self, _: &VectorReadRequest) -> CapabilityResult<Vec<StoredVector>> {
        CapabilityResult::unavailable("retrieval_vectors")
    }

    fn publish(&self, _: &VectorPublishRequest) -> CapabilityResult<PublishReceipt> {
        CapabilityResult::unavailable("retrieval_vectors")
    }
}
