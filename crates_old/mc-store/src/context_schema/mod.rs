//! Injectable fresh context.db bootstrap; legacy migrations are not installed by this provider.

pub mod bootstrap;
pub mod fingerprints;
pub mod migrations_legacy;
mod session_payload_layout;

pub use bootstrap::{BootstrapContextSchema, BOOTSTRAP, BOOTSTRAP_VERSION};

use crate::parity_schema_manifest::*;

pub struct UnavailableContextSchema;
pub static UNAVAILABLE: UnavailableContextSchema = UnavailableContextSchema;

impl ContextSchemaStore for UnavailableContextSchema {
    fn availability(&self) -> Availability {
        unavailable("context_schema")
    }

    fn bootstrap(&self, _: &ContextSchemaRequest) -> CapabilityResult<ContextSchemaReport> {
        CapabilityResult::unavailable("context_schema")
    }
}
