//! Raw archive extension. The archive owner registers store, FTS and ordinal modules here.

use crate::parity_schema_manifest::*;

// Expose FTS search and ordinal-map coverage without exposing ingestion.
#[allow(dead_code)]
mod fts;

pub use fts::{search, FtsRow};

/// Whether the persisted ordinal map can address every indexed message in a range.
pub fn range_is_mapped(
    db: &rusqlite::Connection,
    session: &str,
    start: i64,
    end: i64,
) -> rusqlite::Result<bool> {
    fts::range_is_mapped(db, session, start, end)
}

pub struct UnavailableRawArchive;
pub static UNAVAILABLE: UnavailableRawArchive = UnavailableRawArchive;

impl RawArchiveStore for UnavailableRawArchive {
    fn availability(&self) -> Availability {
        unavailable("raw_archive")
    }

    fn ingest(&self, _: &RawArchiveBatch) -> CapabilityResult<PublishReceipt> {
        CapabilityResult::unavailable("raw_archive")
    }

    fn read(&self, _: &RawReadRequest) -> CapabilityResult<Vec<RawMessage>> {
        CapabilityResult::unavailable("raw_archive")
    }

    fn search(&self, _: &ArchiveQuery) -> CapabilityResult<Vec<RawMessage>> {
        CapabilityResult::unavailable("raw_archive")
    }
}
