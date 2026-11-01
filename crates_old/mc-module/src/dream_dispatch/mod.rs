//! Storage and transport adapters for off-thread dream work.
//! No served transform or facade tool starts these operations.

pub mod adapters;
pub mod broca_carrier;
pub mod broca_port;
pub mod carrier_limits;
pub mod classify_host;
pub mod context;
pub mod curate_host;
pub mod dispatcher;
pub mod domain_control;
pub mod executor;
pub mod ownership;
pub mod primer_host;
pub mod retrospective_host;
pub mod session_reader;
pub mod tick;
pub mod verify_host;

#[cfg(test)]
mod tests;
