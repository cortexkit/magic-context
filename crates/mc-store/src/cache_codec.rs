//! The stored layout of a session's cache state, split so a commit writes what changed.
//!
//! A session's cache state used to be two JSON blobs in one `mc_cache_state` record. SQLite
//! rewrites a whole record whenever its length changes, and a new agent step always appends
//! to `core_state.frozen_units`, so every commit rewrote megabytes on a large session to
//! record a few hundred bytes. Store migration 63 splits the three large values out:
//!
//! - `core_state.frozen_units` lives in `mc_cache_frozen_chunks`, as positional chunks of
//!   [`FROZEN_CHUNK_UNITS`] units. Appending a unit rewrites one chunk.
//! - `meta.resolved_compartment_boundaries` and `meta.tail_hygiene_baseline` live in
//!   `mc_cache_sections`, one row each, rewritten only when their bytes change. No row means
//!   an empty boundary list or no tail baseline.
//! - `mc_cache_state.section_index` records what those rows must hold: the unit and chunk
//!   counts and a digest per value, under a sections version (`sv`) that only this module's
//!   writers advance. A meta-only writer never touches the index, so it can never make a
//!   corrupted chunk look valid again.
//!
//! The in-memory `CoreState` and `ModuleMeta` keep their shapes. This module is the only
//! code that turns them into rows and back; everything else reads and writes through it.

use std::marker::PhantomData;

use cortexkit_cache_core::{CoreState, FrozenUnit};
use rusqlite::{params, OptionalExtension};
use serde::de::{DeserializeOwned, MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::value::RawValue;

use crate::{row_state_hash_128, ModuleMeta, ResolvedContextBoundary, TailHygieneBaseline};

/// Units per row of `mc_cache_frozen_chunks`. Chunk `i` holds units `64 * i ..`; every chunk
/// but the last is full. Migration 63 uses the same number, so it must not change without a
/// migration that re-cuts every stored chunk.
pub const FROZEN_CHUNK_UNITS: usize = 64;
/// `mc_cache_sections.section` of the resolved compartment boundaries.
pub const SECTION_BOUNDARIES: &str = "resolved_compartment_boundaries";
/// `mc_cache_sections.section` of the tail hygiene baseline.
pub const SECTION_TAIL: &str = "tail_hygiene_baseline";
const FROZEN_UNITS_KEY: &str = "frozen_units";

/// Why a decoder refused to trust one stored value. The value then decodes as empty and the
/// caller must rebuild it (the transform forces a HARD pass, see `SectionsBase`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiscardReason {
    /// `section_index` is not the JSON object the codec writes.
    IndexUnreadable,
    /// A unit or boundary count, or a chunk's fill, disagrees with the index.
    LengthMismatch,
    /// There are chunk rows at or past the indexed chunk count, or the count disagrees with
    /// the unit count.
    ChunkCountMismatch,
    /// A chunk below the indexed chunk count is missing.
    ChunkGap,
    /// A chunk's body does not parse as a list of frozen units.
    ChunkUnparseable,
    /// The stored bytes do not hash to the digest the last codec writer recorded.
    DigestMismatch,
    /// The index names a section whose row is missing.
    SectionMissing,
    /// A section row exists that the index does not name.
    SectionUnexpected,
    /// A section row's body does not parse as its type.
    SectionUnparseable,
}

impl DiscardReason {
    pub fn as_str(self) -> &'static str {
        match self {
            DiscardReason::IndexUnreadable => "index_unreadable",
            DiscardReason::LengthMismatch => "length_mismatch",
            DiscardReason::ChunkCountMismatch => "chunk_count_mismatch",
            DiscardReason::ChunkGap => "chunk_gap",
            DiscardReason::ChunkUnparseable => "chunk_unparseable",
            DiscardReason::DigestMismatch => "digest_mismatch",
            DiscardReason::SectionMissing => "section_missing",
            DiscardReason::SectionUnexpected => "section_unexpected",
            DiscardReason::SectionUnparseable => "section_unparseable",
        }
    }
}

/// Whether one stored value was trusted at load time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SectionState<T> {
    Intact(T),
    Discarded(DiscardReason),
}

impl<T> SectionState<T> {
    pub fn intact(&self) -> Option<&T> {
        match self {
            SectionState::Intact(value) => Some(value),
            SectionState::Discarded(_) => None,
        }
    }

    pub fn discard_reason(&self) -> Option<DiscardReason> {
        match self {
            SectionState::Intact(_) => None,
            SectionState::Discarded(reason) => Some(*reason),
        }
    }
}

/// The frozen-unit chunks as they were stored at load time.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FrozenBase {
    /// The digest of each stored chunk's bytes, in chunk order.
    pub chunk_digests: Vec<u128>,
}

/// A hashed section as it was stored at load time.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HashBase {
    /// The digest of the stored body; `None` when the section has no row.
    pub digest: Option<u128>,
}

/// What a full load saw of the split rows. A commit diffs against it, so it writes only the
/// chunks and sections whose bytes differ, and its sections compare-and-set refuses the
/// commit if another codec writer moved `sv` since the load.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SectionsBase {
    /// The `row_version` the base was loaded at.
    pub row_version: u64,
    /// The sections version stored in `section_index.sv` at load time.
    pub sv: u64,
    pub frozen: SectionState<FrozenBase>,
    pub boundaries: SectionState<HashBase>,
    pub tail: SectionState<HashBase>,
}

impl SectionsBase {
    /// Every value the load refused to trust, by stored name.
    pub fn discarded(&self) -> Vec<(&'static str, DiscardReason)> {
        let mut out = Vec::new();
        if let Some(reason) = self.frozen.discard_reason() {
            out.push((FROZEN_UNITS_KEY, reason));
        }
        if let Some(reason) = self.boundaries.discard_reason() {
            out.push((SECTION_BOUNDARIES, reason));
        }
        if let Some(reason) = self.tail.discard_reason() {
            out.push((SECTION_TAIL, reason));
        }
        out
    }

    pub fn any_discarded(&self) -> bool {
        !self.discarded().is_empty()
    }
}

/// A row the codec cannot decode at all. Unlike a discarded section this is a hard error:
/// there is no safe value to fall back to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodecError {
    /// A small blob still carries a key that lives in its own rows since migration 63. Some
    /// writer bypassed the codec, and neither copy can safely be preferred.
    MovedKeyInSmallBlob { key: &'static str },
    /// A small blob is not valid JSON of its type.
    Serde(String),
}

impl std::fmt::Display for CodecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CodecError::MovedKeyInSmallBlob { key } => write!(
                f,
                "cache state small blob carries `{key}`, which is stored in its own rows"
            ),
            CodecError::Serde(detail) => write!(f, "cache state blob: {detail}"),
        }
    }
}

impl std::error::Error for CodecError {}

impl From<CodecError> for rusqlite::Error {
    fn from(error: CodecError) -> Self {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    }
}

/// The JSON stored in `mc_cache_state.section_index`.
///
/// `sv = 0` with no digests is written only by migration 63: it means "migrated, not yet
/// hashed", and a decoder then trusts the structure it can check and computes the digests
/// from the stored bytes. Codec writers always write `sv >= 1` with every digest.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct SectionIndex {
    #[serde(default)]
    pub sv: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub f: Option<FrozenIndex>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub b: Option<SectionIndexEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub t: Option<SectionIndexEntry>,
    /// Bounded representative keys for the engine's existing shape classifier.
    /// Older readers ignore this field; older indexes conservatively lack it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shape: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct FrozenIndex {
    pub n: u64,
    pub c: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub h: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct SectionIndexEntry {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub n: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub h: Option<String>,
}

impl SectionIndex {
    pub(crate) fn parse(json: &str) -> Option<SectionIndex> {
        serde_json::from_str(json).ok()
    }

    pub(crate) fn to_json(&self) -> String {
        serde_json::to_string(self).expect("section index serializes")
    }

    pub(crate) fn frozen_units(&self) -> u64 {
        self.f.as_ref().map_or(0, |f| f.n)
    }
}

pub(crate) fn digest_hex(digest: u128) -> String {
    format!("{digest:032x}")
}

/// The digest of a stored body: the same 128-bit hash the row-state fingerprint uses. It
/// guards our own rows against corruption and partial writes, not against an attacker.
pub(crate) fn body_digest(body: &str) -> u128 {
    row_state_hash_128(body.as_bytes())
}

/// The frozen list's digest: a hash over the per-chunk digests in chunk order.
pub(crate) fn frozen_digest(chunk_digests: &[u128]) -> u128 {
    let mut buffer = Vec::with_capacity(chunk_digests.len() * 16);
    for digest in chunk_digests {
        buffer.extend_from_slice(&digest.to_le_bytes());
    }
    row_state_hash_128(&buffer)
}

/// The chunk count that holds `units` frozen units.
pub(crate) fn chunk_count(units: u64) -> u64 {
    units.div_ceil(FROZEN_CHUNK_UNITS as u64)
}

/// The top-level entries of a JSON object, values left as their exact source text.
struct Entries<'a>(Vec<(String, &'a RawValue)>);

impl<'de> Deserialize<'de> for Entries<'de> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct EntriesVisitor<'de>(PhantomData<&'de ()>);
        impl<'de> Visitor<'de> for EntriesVisitor<'de> {
            type Value = Entries<'de>;
            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a JSON object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut entries = Vec::new();
                while let Some(entry) = map.next_entry::<String, &'de RawValue>()? {
                    entries.push(entry);
                }
                Ok(Entries(entries))
            }
        }
        deserializer.deserialize_map(EntriesVisitor(PhantomData))
    }
}

fn entries(json: &str) -> Result<Entries<'_>, CodecError> {
    serde_json::from_str(json).map_err(|error| CodecError::Serde(error.to_string()))
}

/// Re-emit an object from its entries, keeping order and every value's exact bytes.
fn object_from_entries<'a>(entries: impl Iterator<Item = &'a (String, &'a RawValue)>) -> String {
    let mut out = String::from("{");
    for (index, (key, value)) in entries.enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push_str(&serde_json::to_string(key).expect("a string key serializes"));
        out.push(':');
        out.push_str(value.get());
    }
    out.push('}');
    out
}

fn reject_moved_keys(entries: &Entries<'_>, moved: &[&'static str]) -> Result<(), CodecError> {
    for (key, _) in &entries.0 {
        if let Some(moved) = moved.iter().find(|moved| **moved == key.as_str()) {
            return Err(CodecError::MovedKeyInSmallBlob { key: moved });
        }
    }
    Ok(())
}

/// Parse the small `core_state` blob, which carries everything but the frozen units.
pub(crate) fn decode_small_core(json: &str) -> Result<CoreState, CodecError> {
    let parsed = entries(json)?;
    reject_moved_keys(&parsed, &[FROZEN_UNITS_KEY])?;
    // `CoreState` requires the key, so the empty list is spliced in front of the stored
    // entries rather than parsing into a hand-kept mirror of its fields.
    let spliced = format!(
        "{{\"{FROZEN_UNITS_KEY}\":[]{}{}",
        if parsed.0.is_empty() { "" } else { "," },
        &object_from_entries(parsed.0.iter())[1..]
    );
    serde_json::from_str(&spliced).map_err(|error| CodecError::Serde(error.to_string()))
}

/// Parse the small `meta` blob, which carries everything but the two hashed sections.
pub(crate) fn decode_small_meta(json: &str) -> Result<ModuleMeta, CodecError> {
    let parsed = entries(json)?;
    reject_moved_keys(&parsed, &[SECTION_BOUNDARIES, SECTION_TAIL])?;
    serde_json::from_str(json).map_err(|error| CodecError::Serde(error.to_string()))
}

/// Serialize `meta` without the two hashed sections. Any value a caller left in them is
/// dropped: only the codec's section writers may store them.
pub(crate) fn encode_small_meta(meta: &ModuleMeta) -> Result<String, CodecError> {
    let full = serde_json::to_string(meta).map_err(|error| CodecError::Serde(error.to_string()))?;
    let parsed = entries(&full)?;
    Ok(object_from_entries(parsed.0.iter().filter(|(key, _)| {
        key != SECTION_BOUNDARIES && key != SECTION_TAIL
    })))
}

/// One small row of `mc_cache_state` as stored.
#[derive(Debug, Clone)]
pub(crate) struct StoredRow {
    pub row_version: u64,
    pub core_state: String,
    pub meta: String,
    pub section_index: String,
}

/// The split rows of one session as stored.
#[derive(Debug, Clone, Default)]
pub(crate) struct StoredSections {
    /// `(chunk, body)` in chunk order.
    pub chunks: Vec<(i64, String)>,
    pub boundaries: Option<String>,
    pub tail: Option<String>,
}

/// A fully decoded session row.
#[derive(Debug, Clone)]
pub struct DecodedRow {
    pub row_version: u64,
    pub core: CoreState,
    pub meta: ModuleMeta,
    pub sections: SectionsBase,
}

/// Read the small row only.
pub(crate) fn read_small_row(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> rusqlite::Result<Option<StoredRow>> {
    conn.prepare_cached(
        "SELECT row_version, core_state, meta, section_index FROM mc_cache_state
          WHERE session_id = ?1",
    )?
    .query_row(params![session_id], |row| {
        Ok(StoredRow {
            row_version: row.get::<_, i64>(0)?.max(0) as u64,
            core_state: row.get(1)?,
            meta: row.get(2)?,
            section_index: row.get(3)?,
        })
    })
    .optional()
}

/// Read one section body, without touching the small row's blobs.
pub(crate) fn read_section_body(
    conn: &rusqlite::Connection,
    session_id: &str,
    section: &str,
) -> rusqlite::Result<Option<String>> {
    conn.prepare_cached(
        "SELECT body FROM mc_cache_sections WHERE session_id = ?1 AND section = ?2",
    )?
    .query_row(params![session_id, section], |row| row.get(0))
    .optional()
}

/// The boundary section's index entry and the sections version, read from the small row
/// without touching its blobs. `None` when the session has no row; an entry of `None` means
/// the session has no boundaries. An unreadable index reads as no boundaries.
pub(crate) fn boundary_index_entry(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> rusqlite::Result<Option<(u64, Option<SectionIndexEntry>)>> {
    let row: Option<(Option<i64>, Option<String>)> = conn
        .prepare_cached(
            "SELECT CASE WHEN json_valid(section_index) THEN json_extract(section_index, '$.sv') END,
                    CASE WHEN json_valid(section_index) THEN json_extract(section_index, '$.b') END
               FROM mc_cache_state WHERE session_id = ?1",
        )?
        .query_row(params![session_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()?;
    Ok(row.map(|(sv, entry)| {
        (
            sv.unwrap_or(0).max(0) as u64,
            entry.and_then(|entry| serde_json::from_str(&entry).ok()),
        )
    }))
}

/// The boundary section body, checked against its index entry. `None` when the row is
/// missing or its bytes do not match the digest the last codec writer recorded: a value
/// nobody can vouch for is treated as absent, and the host re-supplies the boundaries.
pub(crate) fn read_verified_boundary_body(
    conn: &rusqlite::Connection,
    session_id: &str,
    sv: u64,
    entry: &SectionIndexEntry,
) -> rusqlite::Result<Option<(String, u128)>> {
    let Some(body) = read_section_body(conn, session_id, SECTION_BOUNDARIES)? else {
        return Ok(None);
    };
    let digest = body_digest(&body);
    let trusted = match entry.h.as_deref() {
        Some(stored) => stored == digest_hex(digest),
        None => sv == 0,
    };
    Ok(trusted.then_some((body, digest)))
}

/// The session's resolved compartment boundaries from their section row, verified. Empty
/// when the session has none or their row cannot be trusted.
pub(crate) fn read_boundary_section(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> rusqlite::Result<Option<Vec<ResolvedContextBoundary>>> {
    let Some((sv, Some(entry))) = boundary_index_entry(conn, session_id)? else {
        return Ok(None);
    };
    let Some((body, _)) = read_verified_boundary_body(conn, session_id, sv, &entry)? else {
        return Ok(None);
    };
    Ok(serde_json::from_str(&body).ok())
}

/// Read every split row of a session. Call it inside the read transaction that read the
/// small row, so the two cannot come from different commits.
pub(crate) fn read_sections(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> rusqlite::Result<StoredSections> {
    let chunks = conn
        .prepare_cached(
            "SELECT chunk, body FROM mc_cache_frozen_chunks WHERE session_id = ?1 ORDER BY chunk",
        )?
        .query_map(params![session_id], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<Vec<(i64, String)>, _>>()?;
    let mut sections = StoredSections {
        chunks,
        ..StoredSections::default()
    };
    let mut statement =
        conn.prepare_cached("SELECT section, body FROM mc_cache_sections WHERE session_id = ?1")?;
    let mut rows = statement.query(params![session_id])?;
    while let Some(row) = rows.next()? {
        let section: String = row.get(0)?;
        let body: String = row.get(1)?;
        match section.as_str() {
            SECTION_BOUNDARIES => sections.boundaries = Some(body),
            SECTION_TAIL => sections.tail = Some(body),
            // A section a newer binary added is not ours to interpret.
            _ => {}
        }
    }
    Ok(sections)
}

/// Read and decode a session in full. `None` when the session has no row.
pub(crate) fn read_decoded(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> Result<Option<DecodedRow>, rusqlite::Error> {
    let Some(row) = read_small_row(conn, session_id)? else {
        return Ok(None);
    };
    let sections = read_sections(conn, session_id)?;
    Ok(Some(decode_row(row, sections)?))
}

#[cfg(any(test, feature = "test-support"))]
thread_local! {
    /// Full decodes run on this thread, so a test can pin how many a pass performs. Per
    /// thread because tests run in parallel and each drives its passes on its own thread.
    static FULL_DECODES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    /// Makes the next transform commit on this thread fail after its chunk and section
    /// writes, before the small row, the way a writer killed mid-transaction would.
    pub(crate) static FAIL_COMMIT_AFTER_SECTION_WRITES: std::cell::Cell<bool> =
        const { std::cell::Cell::new(false) };
}

/// How many full decodes this thread has run.
#[cfg(any(test, feature = "test-support"))]
pub fn full_decode_count() -> usize {
    FULL_DECODES.with(std::cell::Cell::get)
}

/// Fail the next transform commit on this thread after its section writes.
#[cfg(any(test, feature = "test-support"))]
pub fn fail_next_commit_after_section_writes() {
    FAIL_COMMIT_AFTER_SECTION_WRITES.with(|flag| flag.set(true));
}

/// Decode a stored row. A value whose rows disagree with the index decodes as empty and is
/// reported as discarded in [`SectionsBase`]; only an unreadable small blob is an error.
pub(crate) fn decode_row(
    row: StoredRow,
    sections: StoredSections,
) -> Result<DecodedRow, CodecError> {
    #[cfg(any(test, feature = "test-support"))]
    FULL_DECODES.with(|count| count.set(count.get() + 1));
    let mut core = decode_small_core(&row.core_state)?;
    let mut meta = decode_small_meta(&row.meta)?;
    let index = SectionIndex::parse(&row.section_index);
    let sv = index.as_ref().map_or(0, |index| index.sv);

    let (frozen, units) = match &index {
        None => (
            SectionState::Discarded(DiscardReason::IndexUnreadable),
            Vec::new(),
        ),
        Some(index) => decode_frozen(index, &sections.chunks),
    };
    core.frozen_units = units;

    let (boundaries, boundary_value) = match &index {
        None => (
            SectionState::Discarded(DiscardReason::IndexUnreadable),
            None,
        ),
        Some(index) => decode_hashed::<Vec<ResolvedContextBoundary>>(
            sv,
            index.b.as_ref(),
            sections.boundaries.as_deref(),
            |value| value.len() as u64,
        ),
    };
    meta.resolved_compartment_boundaries = boundary_value.unwrap_or_default();

    let (tail, tail_value) = match &index {
        None => (
            SectionState::Discarded(DiscardReason::IndexUnreadable),
            None,
        ),
        Some(index) => decode_hashed::<TailHygieneBaseline>(
            sv,
            index.t.as_ref(),
            sections.tail.as_deref(),
            |_| 1,
        ),
    };
    meta.tail_hygiene_baseline = tail_value;

    Ok(DecodedRow {
        row_version: row.row_version,
        core,
        meta,
        sections: SectionsBase {
            row_version: row.row_version,
            sv,
            frozen,
            boundaries,
            tail,
        },
    })
}

fn decode_frozen(
    index: &SectionIndex,
    chunks: &[(i64, String)],
) -> (SectionState<FrozenBase>, Vec<FrozenUnit>) {
    let discard = |reason| (SectionState::Discarded(reason), Vec::new());
    let (n, c, h) = index
        .f
        .as_ref()
        .map_or((0, 0, None), |f| (f.n, f.c, f.h.as_deref()));
    if chunk_count(n) != c {
        return discard(DiscardReason::ChunkCountMismatch);
    }
    for (position, (chunk, _)) in chunks.iter().enumerate() {
        if *chunk != position as i64 {
            return discard(if *chunk < 0 || *chunk as u64 >= c {
                DiscardReason::ChunkCountMismatch
            } else {
                DiscardReason::ChunkGap
            });
        }
    }
    if (chunks.len() as u64) < c {
        return discard(DiscardReason::ChunkGap);
    }
    if (chunks.len() as u64) > c {
        return discard(DiscardReason::ChunkCountMismatch);
    }
    let chunk_digests: Vec<u128> = chunks.iter().map(|(_, body)| body_digest(body)).collect();
    match h {
        Some(stored) if stored == digest_hex(frozen_digest(&chunk_digests)) => {}
        // Only migration 63 writes an index without digests, always with `sv = 0`.
        None if index.sv == 0 => {}
        _ => return discard(DiscardReason::DigestMismatch),
    }
    let mut units = Vec::with_capacity(n as usize);
    for (position, (_, body)) in chunks.iter().enumerate() {
        let Ok(mut chunk) = serde_json::from_str::<Vec<FrozenUnit>>(body) else {
            return discard(DiscardReason::ChunkUnparseable);
        };
        let full = position + 1 < chunks.len();
        if chunk.is_empty()
            || chunk.len() > FROZEN_CHUNK_UNITS
            || (full && chunk.len() != FROZEN_CHUNK_UNITS)
        {
            return discard(DiscardReason::LengthMismatch);
        }
        units.append(&mut chunk);
    }
    if units.len() as u64 != n {
        return discard(DiscardReason::LengthMismatch);
    }
    (SectionState::Intact(FrozenBase { chunk_digests }), units)
}

fn decode_hashed<T: DeserializeOwned>(
    sv: u64,
    entry: Option<&SectionIndexEntry>,
    body: Option<&str>,
    len: impl Fn(&T) -> u64,
) -> (SectionState<HashBase>, Option<T>) {
    let discard = |reason| (SectionState::Discarded(reason), None);
    match (entry, body) {
        (None, None) => (SectionState::Intact(HashBase { digest: None }), None),
        (Some(_), None) => discard(DiscardReason::SectionMissing),
        (None, Some(_)) => discard(DiscardReason::SectionUnexpected),
        (Some(entry), Some(body)) => {
            let digest = body_digest(body);
            match entry.h.as_deref() {
                Some(stored) if stored == digest_hex(digest) => {}
                None if sv == 0 => {}
                _ => return discard(DiscardReason::DigestMismatch),
            }
            let Ok(value) = serde_json::from_str::<T>(body) else {
                return discard(DiscardReason::SectionUnparseable);
            };
            if entry.n.is_some_and(|n| n != len(&value)) {
                return discard(DiscardReason::LengthMismatch);
            }
            (
                SectionState::Intact(HashBase {
                    digest: Some(digest),
                }),
                Some(value),
            )
        }
    }
}

/// One serialized body and the digest of its bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct EncodedBody {
    pub body: String,
    pub digest: u128,
}

/// A session's state serialized into the split layout, not yet written.
#[derive(Debug, Clone)]
pub(crate) struct EncodedRow {
    pub core_json: String,
    pub meta_json: String,
    pub unit_count: u64,
    pub chunks: Vec<EncodedBody>,
    pub boundaries: Option<(EncodedBody, u64)>,
    pub tail: Option<EncodedBody>,
    pub shape: Vec<String>,
}

fn encoded(body: String) -> EncodedBody {
    let digest = body_digest(&body);
    EncodedBody { body, digest }
}

/// Serialize a session's state into the split layout. Each chunk is the exact serde output
/// of its 64 units, so a chunk migration 63 wrote hashes the same as this encoder's output
/// for the same units, and the first commit after the migration rewrites only real changes.
pub(crate) fn encode_row(core: &CoreState, meta: &ModuleMeta) -> Result<EncodedRow, CodecError> {
    let serde = |error: serde_json::Error| CodecError::Serde(error.to_string());
    // Destructured exhaustively so a field added to `CoreState` fails to compile here
    // instead of being dropped from the stored row.
    let CoreState {
        version,
        boundary_id,
        frozen_units,
        pending_changes,
        reconcile_pending,
    } = core;
    let small = CoreState {
        version: *version,
        boundary_id: boundary_id.clone(),
        frozen_units: Vec::new(),
        pending_changes: pending_changes.clone(),
        reconcile_pending: *reconcile_pending,
    };
    let small_core = serde_json::to_string(&small).map_err(serde)?;
    let core_json = object_from_entries(
        entries(&small_core)?
            .0
            .iter()
            .filter(|(key, _)| key != FROZEN_UNITS_KEY),
    );
    let chunks = frozen_units
        .chunks(FROZEN_CHUNK_UNITS)
        .map(|chunk| serde_json::to_string(chunk).map(encoded))
        .collect::<Result<Vec<_>, _>>()
        .map_err(serde)?;

    // One serialization of the whole meta; the two sections are cut out of it as their exact
    // bytes, so a section body is byte-identical to serializing the value on its own.
    let full_meta = serde_json::to_string(meta).map_err(serde)?;
    let parsed = entries(&full_meta)?;
    let mut boundaries = None;
    let mut tail = None;
    for (key, value) in &parsed.0 {
        if key == SECTION_BOUNDARIES {
            boundaries = Some((
                encoded(value.get().to_string()),
                meta.resolved_compartment_boundaries.len() as u64,
            ));
        } else if key == SECTION_TAIL {
            tail = Some(encoded(value.get().to_string()));
        }
    }
    let meta_json = object_from_entries(
        parsed
            .0
            .iter()
            .filter(|(key, _)| key != SECTION_BOUNDARIES && key != SECTION_TAIL),
    );
    Ok(EncodedRow {
        core_json,
        meta_json,
        unit_count: frozen_units.len() as u64,
        chunks,
        boundaries,
        tail,
        shape: {
            let mut keys = std::collections::BTreeMap::<String, usize>::new();
            for unit in frozen_units {
                let key = if ["red:", "strip:", "cav:", "channel1:"]
                    .iter()
                    .any(|p| unit.key.starts_with(p))
                {
                    unit.key
                        .split_once(':')
                        .expect("prefix separator")
                        .0
                        .to_string()
                        + ":"
                } else if matches!(
                    unit.key.as_str(),
                    "m0" | "m1"
                        | "m0-mural"
                        | "baseline"
                        | "migration:renderer-transition-v1"
                        | "migration:renderer-transition-v2"
                ) {
                    unit.key.clone()
                } else {
                    "unknown".into()
                };
                let n = keys.entry(key).or_default();
                *n = (*n + 1).min(2);
            }
            keys.into_iter()
                .flat_map(|(key, n)| std::iter::repeat_n(key, n))
                .collect()
        },
    })
}

/// How a codec write treats the frozen chunks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FrozenWrite {
    /// Write the encoded units.
    Write,
    /// Leave the stored chunks and their index entry as they are. For writers that do not
    /// own the frozen list, such as a state sync.
    Keep,
}

/// What a codec write compares the new state against.
#[derive(Debug, Clone, Copy)]
pub(crate) enum WriteBase<'a> {
    /// Nothing is stored for the session any more: the caller deleted every split row.
    Cleared,
    /// The stored rows as a load saw them.
    Loaded(&'a SectionsBase),
}

/// Write the small row: the CAS token, both small blobs and the index that vouches for the
/// split rows. The one statement outside migrations that sets `core_state` or
/// `section_index`.
pub(crate) fn upsert_small_row(
    tx: &rusqlite::Connection,
    session_id: &str,
    row_version: u64,
    encoded: &EncodedRow,
    index_json: &str,
    last_activity_at: i64,
) -> rusqlite::Result<()> {
    tx.prepare_cached(
        "INSERT INTO mc_cache_state
             (session_id, row_version, core_state, meta, section_index, last_activity_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(session_id) DO UPDATE SET
             row_version = excluded.row_version,
             core_state = excluded.core_state,
             meta = excluded.meta,
             section_index = excluded.section_index,
             last_activity_at = excluded.last_activity_at",
    )?
    .execute(params![
        session_id,
        row_version as i64,
        encoded.core_json,
        encoded.meta_json,
        index_json,
        last_activity_at
    ])?;
    Ok(())
}

/// Delete every split row of a session. A bootstrap and a reset start from here, so no row
/// a previous life of the session left behind can be read as part of the new one.
pub(crate) fn clear_session_rows(
    tx: &rusqlite::Connection,
    session_id: &str,
) -> rusqlite::Result<()> {
    tx.prepare_cached("DELETE FROM mc_cache_frozen_chunks WHERE session_id = ?1")?
        .execute(params![session_id])?;
    tx.prepare_cached("DELETE FROM mc_cache_sections WHERE session_id = ?1")?
        .execute(params![session_id])?;
    Ok(())
}

/// The result of [`write_sections`].
#[derive(Debug, Clone)]
pub(crate) struct WrittenSections {
    /// The new `section_index`, for the caller to store in the small row.
    pub index_json: String,
    /// The rows as they now stand, for a caller that hands a loaded state onward and must
    /// let its next commit diff against what was just written.
    pub base_after: SectionsBase,
}

/// Write the chunk and section rows that differ from `base`, and return the new
/// `section_index` JSON. The caller has already run every refusal; it writes the returned
/// index into the small row in the same transaction, at `row_version`.
///
/// - A chunk or section whose base is intact is written only when its digest changed.
/// - A discarded one is rewritten in full: a diff against a value nobody trusts could leave
///   a corrupted row in place wherever the new content happened to hash the same as the base.
/// - Chunks past the new chunk count, and sections that are now absent, are deleted
///   unconditionally, not from arithmetic on the base.
/// - `sv` advances by one when any row or digest changed, and is kept otherwise.
pub(crate) fn write_sections(
    tx: &rusqlite::Connection,
    session_id: &str,
    encoded: &EncodedRow,
    base: WriteBase<'_>,
    frozen_write: FrozenWrite,
    stored_index: Option<&SectionIndex>,
    row_version: u64,
) -> rusqlite::Result<WrittenSections> {
    let stored_sv = stored_index.map_or(0, |index| index.sv);
    let mut wrote = false;
    let mut wrote_frozen = false;
    let encoded_frozen = || {
        SectionState::Intact(FrozenBase {
            chunk_digests: encoded.chunks.iter().map(|chunk| chunk.digest).collect(),
        })
    };
    let frozen_after = match (frozen_write, base) {
        (FrozenWrite::Write, _) => encoded_frozen(),
        (FrozenWrite::Keep, WriteBase::Cleared) => SectionState::Intact(FrozenBase::default()),
        (FrozenWrite::Keep, WriteBase::Loaded(base)) => base.frozen.clone(),
    };

    let frozen_index = match frozen_write {
        FrozenWrite::Write => {
            let frozen_base = match base {
                WriteBase::Cleared => None,
                WriteBase::Loaded(base) => match &base.frozen {
                    SectionState::Intact(frozen) => Some(frozen),
                    SectionState::Discarded(_) => {
                        tx.prepare_cached(
                            "DELETE FROM mc_cache_frozen_chunks WHERE session_id = ?1",
                        )?
                        .execute(params![session_id])?;
                        wrote = true;
                        wrote_frozen = true;
                        None
                    }
                },
            };
            let mut upsert = tx.prepare_cached(
                "INSERT INTO mc_cache_frozen_chunks (session_id, chunk, body) VALUES (?1, ?2, ?3)
                 ON CONFLICT(session_id, chunk) DO UPDATE SET body = excluded.body",
            )?;
            for (position, chunk) in encoded.chunks.iter().enumerate() {
                let unchanged = frozen_base
                    .and_then(|frozen| frozen.chunk_digests.get(position))
                    .is_some_and(|digest| *digest == chunk.digest);
                if !unchanged {
                    upsert.execute(params![session_id, position as i64, chunk.body])?;
                    wrote = true;
                    wrote_frozen = true;
                }
            }
            let deleted = tx
                .prepare_cached(
                    "DELETE FROM mc_cache_frozen_chunks WHERE session_id = ?1 AND chunk >= ?2",
                )?
                .execute(params![session_id, encoded.chunks.len() as i64])?;
            wrote |= deleted > 0;
            wrote_frozen |= deleted > 0;
            let digests: Vec<u128> = encoded.chunks.iter().map(|chunk| chunk.digest).collect();
            Some(FrozenIndex {
                n: encoded.unit_count,
                c: encoded.chunks.len() as u64,
                h: Some(digest_hex(frozen_digest(&digests))),
            })
        }
        FrozenWrite::Keep => {
            let stored = stored_index.and_then(|index| index.f.clone());
            match base {
                // A migrated index has no digest yet; the base computed it from the stored
                // bytes, and the new index must carry it because it will no longer say sv=0.
                WriteBase::Loaded(SectionsBase {
                    frozen: SectionState::Intact(frozen),
                    ..
                }) => stored.map(|stored| FrozenIndex {
                    h: Some(digest_hex(frozen_digest(&frozen.chunk_digests))),
                    ..stored
                }),
                _ => stored,
            }
        }
    };

    let boundaries_base = match base {
        WriteBase::Cleared => None,
        WriteBase::Loaded(base) => Some(&base.boundaries),
    };
    wrote |= write_hashed(
        tx,
        session_id,
        SECTION_BOUNDARIES,
        encoded.boundaries.as_ref().map(|(body, _)| body),
        boundaries_base,
    )?;
    let tail_base = match base {
        WriteBase::Cleared => None,
        WriteBase::Loaded(base) => Some(&base.tail),
    };
    wrote |= write_hashed(
        tx,
        session_id,
        SECTION_TAIL,
        encoded.tail.as_ref(),
        tail_base,
    )?;

    let mut index = SectionIndex {
        sv: stored_sv,
        f: frozen_index,
        b: encoded
            .boundaries
            .as_ref()
            .map(|(body, n)| SectionIndexEntry {
                n: Some(*n),
                h: Some(digest_hex(body.digest)),
            }),
        t: encoded.tail.as_ref().map(|body| SectionIndexEntry {
            n: None,
            h: Some(digest_hex(body.digest)),
        }),
        shape: if matches!(frozen_write, FrozenWrite::Write) && wrote_frozen {
            Some(encoded.shape.clone())
        } else {
            stored_index.and_then(|i| i.shape.clone())
        },
    };
    if wrote || stored_index != Some(&index) || stored_sv == 0 {
        index.sv = stored_sv + 1;
    }
    Ok(WrittenSections {
        index_json: index.to_json(),
        base_after: SectionsBase {
            row_version,
            sv: index.sv,
            frozen: frozen_after,
            boundaries: SectionState::Intact(HashBase {
                digest: encoded.boundaries.as_ref().map(|(body, _)| body.digest),
            }),
            tail: SectionState::Intact(HashBase {
                digest: encoded.tail.as_ref().map(|body| body.digest),
            }),
        },
    })
}

fn write_hashed(
    tx: &rusqlite::Connection,
    session_id: &str,
    section: &str,
    new: Option<&EncodedBody>,
    base: Option<&SectionState<HashBase>>,
) -> rusqlite::Result<bool> {
    let mut wrote = false;
    let rewrite = match base {
        None => true,
        Some(SectionState::Discarded(_)) => {
            tx.prepare_cached(
                "DELETE FROM mc_cache_sections WHERE session_id = ?1 AND section = ?2",
            )?
            .execute(params![session_id, section])?;
            wrote = true;
            true
        }
        Some(SectionState::Intact(base)) => base.digest != new.map(|body| body.digest),
    };
    match new {
        Some(body) if rewrite => {
            tx.prepare_cached(
                "INSERT INTO mc_cache_sections (session_id, section, body) VALUES (?1, ?2, ?3)
                 ON CONFLICT(session_id, section) DO UPDATE SET body = excluded.body",
            )?
            .execute(params![session_id, section, body.body])?;
            wrote = true;
        }
        Some(_) => {}
        None => {
            // Unconditional: a value that went from present to absent must not leave its
            // old row behind for the next load to find.
            wrote |= tx
                .prepare_cached(
                    "DELETE FROM mc_cache_sections WHERE session_id = ?1 AND section = ?2",
                )?
                .execute(params![session_id, section])?
                > 0;
        }
    }
    Ok(wrote)
}

#[cfg(test)]
mod tests;
