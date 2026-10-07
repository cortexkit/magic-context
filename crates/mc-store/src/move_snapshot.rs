//! The uncompressed v1 move stream. Table data is streamed, not collected into a
//! single RPC value; even a value larger than a transport record can span chunks.
use crate::move_inventory::{self, Class, RowSelector, Store, TableInventory};
use rusqlite::{types::Value, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{self, Read, Write};

pub const MAGIC: &[u8; 4] = b"MCS1";
pub const HEADER_LENGTH: usize = 21;
pub const MAX_RECORD_LENGTH: usize = 3 * 1024 * 1024;

#[derive(Debug)]
pub enum SnapshotError {
    Io(io::Error),
    Sql(rusqlite::Error),
    Inventory(move_inventory::InventoryError),
    Invalid(&'static str),
}
impl std::fmt::Display for SnapshotError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => e.fmt(f),
            Self::Sql(e) => e.fmt(f),
            Self::Inventory(e) => e.fmt(f),
            Self::Invalid(code) => f.write_str(code),
        }
    }
}
impl std::error::Error for SnapshotError {}
impl From<io::Error> for SnapshotError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}
impl From<rusqlite::Error> for SnapshotError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Sql(e)
    }
}
impl From<move_inventory::InventoryError> for SnapshotError {
    fn from(e: move_inventory::InventoryError) -> Self {
        Self::Inventory(e)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Chunk {
    /// Absolute stream offset, including records that preceded this snapshot.
    pub offset: u64,
    pub length: u64,
    pub digest: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub snapshot_id: [u8; 16],
    pub cut_id: String,
    pub session_ref: String,
    pub host_session_id: String,
    pub host_end_offset: u64,
    pub host_end_message_id: Option<String>,
    pub source_mode: SourceMode,
    pub inventory_version: u32,
    pub store_schema_version: u32,
    pub context_schema_version: u32,
    pub render_versions: serde_json::Value,
    pub render_state_digest: String,
    pub render_identity: serde_json::Value,
    /// The cut which owns the frozen fences in both halves.
    pub fence_cut_id: String,
    pub chunk_count: u64,
    pub chunks: Vec<Chunk>,
    pub total_length: u64,
    pub total_digest: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceMode {
    Ts,
    Rust,
}

pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub(crate) fn quoted(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

pub fn write_count(out: &mut impl Write, mut count: u64) -> io::Result<()> {
    loop {
        let byte = (count & 127) as u8;
        count >>= 7;
        out.write_all(&[byte | if count == 0 { 0 } else { 128 }])?;
        if count == 0 {
            return Ok(());
        }
    }
}
pub fn read_count(input: &mut impl Read) -> Result<u64, SnapshotError> {
    let mut result = 0;
    for shift in (0..70).step_by(7) {
        let mut byte = [0];
        input.read_exact(&mut byte)?;
        if shift == 63 && byte[0] > 1 {
            return Err(SnapshotError::Invalid("manifest_mismatch"));
        }
        result |= u64::from(byte[0] & 127) << shift;
        if byte[0] < 128 {
            if shift > 0 && byte[0] == 0 {
                return Err(SnapshotError::Invalid("manifest_mismatch"));
            }
            return Ok(result);
        }
    }
    Err(SnapshotError::Invalid("manifest_mismatch"))
}
fn write_bytes(out: &mut impl Write, bytes: &[u8]) -> io::Result<()> {
    write_count(out, bytes.len() as u64)?;
    out.write_all(bytes)
}
fn read_bytes(input: &mut impl Read) -> Result<Vec<u8>, SnapshotError> {
    let len = usize::try_from(read_count(input)?)
        .map_err(|_| SnapshotError::Invalid("manifest_mismatch"))?;
    // Read incrementally: a hostile length must not allocate before EOF is detected.
    let mut bytes = Vec::new();
    input.take(len as u64).read_to_end(&mut bytes)?;
    if bytes.len() != len {
        return Err(SnapshotError::Invalid("manifest_mismatch"));
    }
    Ok(bytes)
}
pub fn write_value(out: &mut impl Write, value: &Value) -> io::Result<()> {
    match value {
        Value::Null => out.write_all(&[0]),
        Value::Integer(n) => {
            out.write_all(&[1])?;
            out.write_all(&n.to_be_bytes())
        }
        Value::Real(n) => {
            out.write_all(&[2])?;
            out.write_all(&n.to_be_bytes())
        }
        Value::Text(text) => {
            out.write_all(&[3])?;
            write_bytes(out, text.as_bytes())
        }
        Value::Blob(bytes) => {
            out.write_all(&[4])?;
            write_bytes(out, bytes)
        }
    }
}
pub fn read_value(input: &mut impl Read) -> Result<Value, SnapshotError> {
    let mut tag = [0];
    input.read_exact(&mut tag)?;
    Ok(match tag[0] {
        0 => Value::Null,
        1 | 2 => {
            let mut bytes = [0; 8];
            input.read_exact(&mut bytes)?;
            if tag[0] == 1 {
                Value::Integer(i64::from_be_bytes(bytes))
            } else {
                Value::Real(f64::from_be_bytes(bytes))
            }
        }
        3 => Value::Text(
            String::from_utf8(read_bytes(input)?)
                .map_err(|_| SnapshotError::Invalid("manifest_mismatch"))?,
        ),
        4 => Value::Blob(read_bytes(input)?),
        _ => return Err(SnapshotError::Invalid("manifest_mismatch")),
    })
}

pub(crate) fn ship_tables(store: Store) -> impl Iterator<Item = &'static TableInventory> {
    move_inventory::tables(store).filter(|table| table.class == Class::Ship)
}

/// Call on a dedicated read-only connection. The transaction spans the complete
/// half, but neither a write lock nor McStore's shared handle is acquired.
pub fn capture_half(
    conn: &mut Connection,
    store: Store,
    session: &str,
    out: &mut impl Write,
) -> Result<(), SnapshotError> {
    capture_half_checked(conn, store, session, out, |_| Ok(()))
}
pub(crate) fn capture_half_checked(
    conn: &mut Connection,
    store: Store,
    session: &str,
    out: &mut impl Write,
    check: impl FnOnce(&Connection) -> Result<(), SnapshotError>,
) -> Result<(), SnapshotError> {
    let tx = conn.transaction()?;
    move_inventory::validate_schema(&tx, store)?;
    check(&tx)?;
    for table in ship_tables(store) {
        let RowSelector::Predicate(predicate) = table.rows else {
            return Err(SnapshotError::Invalid("inventory_mismatch"));
        };
        let columns = table.shipped_columns();
        let name = quoted(table.table);
        let count: u64 = tx.query_row(
            &format!("SELECT COUNT(*) FROM {name} WHERE {predicate}"),
            [session],
            |row| row.get(0),
        )?;
        write_bytes(out, table.table.as_bytes())?;
        write_count(out, columns.len() as u64)?;
        for column in &columns {
            write_bytes(out, column.as_bytes())?;
        }
        write_count(out, count)?;
        let mut stmt = tx.prepare(&format!(
            "SELECT {} FROM {name} WHERE {predicate} ORDER BY {}",
            columns
                .iter()
                .map(|c| quoted(c))
                .collect::<Vec<_>>()
                .join(","),
            table
                .primary_key
                .iter()
                .map(|c| quoted(c))
                .collect::<Vec<_>>()
                .join(",")
        ))?;
        let mut rows = stmt.query([session])?;
        while let Some(row) = rows.next()? {
            for (index, column) in columns.iter().enumerate() {
                let value = row.get::<_, Value>(index)?;
                if matches!(*column, "project_path" | "project_identity")
                    && matches!(&value, Value::Text(identity) if identity.starts_with("dir:"))
                {
                    return Err(SnapshotError::Invalid("non_portable_project"));
                }
                write_value(out, &value)?;
            }
        }
    }
    tx.commit()?;
    Ok(())
}

/// Verify section names and column order against the inventory, not against a
/// second description supplied by the peer.
pub(crate) fn read_section(
    input: &mut impl Read,
    table: &TableInventory,
) -> Result<u64, SnapshotError> {
    if read_bytes(input)? != table.table.as_bytes() {
        return Err(SnapshotError::Invalid("inventory_mismatch"));
    }
    let columns = table.shipped_columns();
    if read_count(input)? != columns.len() as u64 {
        return Err(SnapshotError::Invalid("inventory_mismatch"));
    }
    for column in columns {
        if read_bytes(input)? != column.as_bytes() {
            return Err(SnapshotError::Invalid("inventory_mismatch"));
        }
    }
    read_count(input)
}
pub(crate) fn read_row(
    input: &mut impl Read,
    table: &TableInventory,
) -> Result<Vec<Value>, SnapshotError> {
    table
        .shipped_columns()
        .iter()
        .map(|_| read_value(input))
        .collect()
}
pub(crate) fn source_key(table: &TableInventory, row: &[Value]) -> Result<Vec<u8>, SnapshotError> {
    let columns = table.shipped_columns();
    let mut key = Vec::new();
    for name in table.primary_key {
        let index = columns
            .iter()
            .position(|column| column == name)
            .ok_or(SnapshotError::Invalid("inventory_mismatch"))?;
        if matches!(row[index], Value::Null) {
            return Err(SnapshotError::Invalid("key_collision"));
        }
        write_value(&mut key, &row[index])?;
    }
    Ok(key)
}

pub fn record(
    kind: u8,
    snapshot: [u8; 16],
    payload: &[u8],
    framing_bytes: usize,
) -> Result<Vec<u8>, SnapshotError> {
    if !matches!(kind, 1 | 2) {
        return Err(SnapshotError::Invalid("manifest_mismatch"));
    }
    if payload
        .len()
        .saturating_add(HEADER_LENGTH)
        .saturating_add(framing_bytes)
        > MAX_RECORD_LENGTH
    {
        return Err(SnapshotError::Invalid("snapshot_record_too_large"));
    }
    let mut bytes = Vec::with_capacity(HEADER_LENGTH + payload.len());
    bytes.extend_from_slice(MAGIC);
    bytes.push(kind);
    bytes.extend_from_slice(&snapshot);
    bytes.extend_from_slice(payload);
    Ok(bytes)
}
pub fn record_payload(bytes: &[u8], kind: u8, snapshot: [u8; 16]) -> Result<&[u8], SnapshotError> {
    if bytes.len() < HEADER_LENGTH
        || bytes.len() > MAX_RECORD_LENGTH
        || &bytes[..4] != MAGIC
        || bytes[4] != kind
        || bytes[5..21] != snapshot
    {
        return Err(SnapshotError::Invalid("manifest_mismatch"));
    }
    Ok(&bytes[HEADER_LENGTH..])
}
impl Manifest {
    pub fn encode_record(&self, framing_bytes: usize) -> Result<Vec<u8>, SnapshotError> {
        let payload =
            serde_json::to_vec(self).map_err(|_| SnapshotError::Invalid("manifest_mismatch"))?;
        record(2, self.snapshot_id, &payload, framing_bytes)
    }
    pub fn decode_record(bytes: &[u8]) -> Result<Self, SnapshotError> {
        if bytes.len() < HEADER_LENGTH {
            return Err(SnapshotError::Invalid("manifest_mismatch"));
        }
        let snapshot = bytes[5..21].try_into().unwrap();
        let manifest: Self = serde_json::from_slice(record_payload(bytes, 2, snapshot)?)
            .map_err(|_| SnapshotError::Invalid("manifest_mismatch"))?;
        if manifest.snapshot_id != snapshot || manifest.fence_cut_id != manifest.cut_id {
            return Err(SnapshotError::Invalid("manifest_mismatch"));
        }
        Ok(manifest)
    }
    /// The caller supplies records selected by this manifest's absolute offsets.
    /// Other snapshots' records are deliberately not scanned or appended here.
    pub fn verify_chunks(
        &self,
        mut read_at: impl FnMut(u64) -> Result<Vec<u8>, SnapshotError>,
        out: &mut impl Write,
    ) -> Result<(), SnapshotError> {
        if self.chunk_count != self.chunks.len() as u64 {
            return Err(SnapshotError::Invalid("manifest_mismatch"));
        }
        let mut hash = Sha256::new();
        let mut length = 0u64;
        let mut previous_end = None;
        for chunk in &self.chunks {
            if previous_end.is_some_and(|end| chunk.offset < end) {
                return Err(SnapshotError::Invalid("manifest_mismatch"));
            }
            let bytes = read_at(chunk.offset)?;
            let payload = record_payload(&bytes, 1, self.snapshot_id)?;
            if payload.len() as u64 != chunk.length || digest(payload) != chunk.digest {
                return Err(SnapshotError::Invalid("manifest_mismatch"));
            }
            previous_end = Some(
                chunk
                    .offset
                    .checked_add(bytes.len() as u64)
                    .ok_or(SnapshotError::Invalid("manifest_mismatch"))?,
            );
            hash.update(payload);
            length = length
                .checked_add(payload.len() as u64)
                .ok_or(SnapshotError::Invalid("manifest_mismatch"))?;
            out.write_all(payload)?;
        }
        if length != self.total_length || format!("{:x}", hash.finalize()) != self.total_digest {
            return Err(SnapshotError::Invalid("manifest_mismatch"));
        }
        Ok(())
    }
}

/// Reads only one transport-sized buffer at a time. `emit` owns admission and
/// its offset accounting; no SQLite handle or transaction lives in this function.
pub fn chunks(
    input: &mut impl Read,
    snapshot: [u8; 16],
    framing_bytes: usize,
    mut emit: impl FnMut(Vec<u8>) -> Result<(), SnapshotError>,
) -> Result<(u64, String), SnapshotError> {
    let capacity = MAX_RECORD_LENGTH
        .checked_sub(HEADER_LENGTH)
        .and_then(|n| n.checked_sub(framing_bytes))
        .filter(|n| *n > 0)
        .ok_or(SnapshotError::Invalid("snapshot_record_too_large"))?;
    let mut hash = Sha256::new();
    let mut total = 0;
    loop {
        let mut bytes = Vec::with_capacity(capacity);
        input.take(capacity as u64).read_to_end(&mut bytes)?;
        if bytes.is_empty() {
            break;
        }
        hash.update(&bytes);
        total += bytes.len() as u64;
        emit(record(1, snapshot, &bytes, framing_bytes)?)?;
    }
    Ok((total, format!("{:x}", hash.finalize())))
}
