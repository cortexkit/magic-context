//! A bounded byte stream envelope around the existing inventory snapshot codec.
//! Each appended snapshot starts with its format and identity, followed by the
//! context/store halves. Old snapshots can be skipped without decoding their rows.
use super::door::{unhex, DoorError, EngramDoor};
use cortexkit_role_agent_data::errors::{
    Detail, ErrorBody, IncompatibleVersionDetail, RefusalCode,
};
use mc_store::move_inventory;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Write},
    path::Path,
};

pub const MAGIC: &[u8; 5] = b"MCAD1";
pub const PAGE: usize = 1024 * 1024;
pub const HEADER_MAX: usize = 64 * 1024;
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Identity {
    /// The bare module id of the attested runner; with `harness` and
    /// `session` it names the snapshot's session reference.
    pub runner: String,
    pub harness: String,
    pub project_root: String,
    pub session: String,
    pub namespaces: Vec<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Half {
    pub session: String,
    pub context_length: u64,
    pub module_length: u64,
    pub context_digest: String,
    pub module_digest: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Header {
    pub cut_id: String,
    pub ref_kind: String,
    pub session_ref: String,
    pub identity: Identity,
    pub context_version: u32,
    pub store_version: u32,
    pub inventory_version: u32,
    pub halves: Vec<Half>,
}
impl Header {
    pub fn format(&self) -> String {
        format!(
            "mc-agent/1;context={};store={};inventory={}",
            self.context_version, self.store_version, self.inventory_version
        )
    }
    pub fn check_format(&self, local: (u32, u32)) -> Result<(), ErrorBody> {
        if self.context_version != move_inventory::CONTEXT_SCHEMA_VERSION
            || self.store_version != move_inventory::STORE_SCHEMA_VERSION
            || self.inventory_version != move_inventory::INVENTORY_VERSION
            || self.context_version > local.0
            || self.store_version > local.1
        {
            return Err(ErrorBody::with_typed_detail(
                Detail::IncompatibleVersion(IncompatibleVersionDetail::new(
                    self.format(),
                    format!(
                        "mc-agent/1;context={};store={};inventory={}",
                        local.0,
                        local.1,
                        move_inventory::INVENTORY_VERSION
                    ),
                )),
                "MC cannot read this snapshot format",
            ));
        }
        Ok(())
    }
    pub fn validate_identity(&self, kind: &str, reference: &str) -> Result<(), ErrorBody> {
        if self.ref_kind != kind
            || self.session_ref != reference
            || self.halves.len() > 64
            || self.halves.is_empty()
            || self.identity.session.is_empty()
        {
            return Err(error(
                RefusalCode::InvalidRequest,
                "snapshot identity does not match the ref",
            ));
        }
        let mut sessions = self.identity.namespaces.clone();
        sessions.push(self.identity.session.clone());
        sessions.sort();
        sessions.dedup();
        let mut halves = self
            .halves
            .iter()
            .map(|h| h.session.clone())
            .collect::<Vec<_>>();
        halves.sort();
        if halves != sessions {
            return Err(error(
                RefusalCode::InvalidRequest,
                "snapshot has another session set",
            ));
        }
        {
            if cortexkit_role_llm_runner::session_ref(&cortexkit_role_llm_runner::SessionIdentity {
                runner: &self.identity.runner,
                harness: &self.identity.harness,
                session: &self.identity.session,
            }) != reference
            {
                return Err(error(
                    RefusalCode::InvalidRequest,
                    "snapshot bind tuple does not match the ref",
                ));
            }
        }
        Ok(())
    }
}
pub fn error(code: RefusalCode, message: impl Into<String>) -> ErrorBody {
    ErrorBody::new(code, message)
}
pub fn storage(error: impl std::fmt::Display) -> ErrorBody {
    self::error(RefusalCode::Unavailable, error.to_string())
}
pub fn door_error(e: DoorError, reading: bool) -> ErrorBody {
    let code = if reading
        && matches!(
            e.code.as_str(),
            "cut_unknown"
                | "cut_not_ready"
                | "cut_item_missing"
                | "session_not_found"
                | "not_found"
        ) {
        RefusalCode::CutNotReady
    } else {
        RefusalCode::Unavailable
    };
    error(code, format!("engram door: {}", e.code))
}
pub fn file_digest(path: &Path) -> Result<String, ErrorBody> {
    let mut file = File::open(path).map_err(storage)?;
    let mut hash = Sha256::new();
    let mut buf = vec![0; PAGE];
    loop {
        let n = file.read(&mut buf).map_err(storage)?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
pub fn envelope(path: &Path, header: &Header, dir: &Path) -> Result<u64, ErrorBody> {
    let bytes = serde_json::to_vec(header).map_err(storage)?;
    if bytes.len() > HEADER_MAX {
        return Err(error(
            RefusalCode::Unavailable,
            "snapshot header is too large",
        ));
    }
    let mut file = mc_store::private_permissions::create_file(path, true).map_err(storage)?;
    file.write_all(MAGIC).map_err(storage)?;
    file.write_all(&(bytes.len() as u32).to_le_bytes())
        .map_err(storage)?;
    file.write_all(&bytes).map_err(storage)?;
    for i in 0..header.halves.len() {
        for side in ["context", "module"] {
            std::io::copy(
                &mut File::open(dir.join(format!("{side}-{i}.bin"))).map_err(storage)?,
                &mut file,
            )
            .map_err(storage)?;
        }
    }
    file.sync_all().map_err(storage)?;
    Ok(file.metadata().map_err(storage)?.len())
}

struct DoorReader<'a> {
    door: &'a dyn EngramDoor,
    reference: &'a str,
    cut: Option<&'a str>,
    page: Vec<u8>,
    at: usize,
    offset: u64,
    end: Option<u64>,
    hash: Sha256,
    digest: Option<String>,
}
impl<'a> DoorReader<'a> {
    fn new(door: &'a dyn EngramDoor, reference: &'a str, cut: Option<&'a str>) -> Self {
        Self {
            door,
            reference,
            cut,
            page: vec![],
            at: 0,
            offset: 0,
            end: None,
            hash: Sha256::new(),
            digest: None,
        }
    }
    async fn bytes(&mut self, n: usize) -> Result<Vec<u8>, ErrorBody> {
        let mut out = Vec::with_capacity(n);
        while out.len() < n {
            if self.at == self.page.len() {
                if self.end == Some(self.offset) {
                    return Err(error(RefusalCode::CutNotReady, "cut stream is incomplete"));
                }
                let reply = self
                    .door
                    .read(self.reference, self.offset, PAGE, self.cut)
                    .await
                    .map_err(|e| door_error(e, true))?;
                let bytes = unhex(&reply.bytes).map_err(|e| door_error(e, true))?;
                if reply.from_offset != self.offset
                    || reply.end_offset < self.offset
                    || reply.end_offset > reply.stream_end
                    || reply.end_offset - self.offset != bytes.len() as u64
                    || bytes.len() > PAGE
                    || bytes.is_empty()
                    || self.end.is_some_and(|end| end != reply.stream_end)
                {
                    return Err(error(
                        RefusalCode::Unavailable,
                        "engram returned a discontinuous stream",
                    ));
                }
                self.end = Some(reply.stream_end);
                if let Some(digest) = reply.digest {
                    self.digest = Some(digest);
                }
                self.page = bytes;
                self.at = 0;
            }
            let count = (n - out.len()).min(self.page.len() - self.at);
            let bytes = &self.page[self.at..self.at + count];
            self.hash.update(bytes);
            out.extend_from_slice(bytes);
            self.offset += count as u64;
            self.at += count;
        }
        Ok(out)
    }
    async fn copy(
        &mut self,
        mut length: u64,
        mut output: Option<&mut File>,
    ) -> Result<String, ErrorBody> {
        let mut hash = Sha256::new();
        while length > 0 {
            let bytes = self.bytes(length.min(PAGE as u64) as usize).await?;
            hash.update(&bytes);
            if let Some(file) = output.as_mut() {
                file.write_all(&bytes).map_err(storage)?;
            }
            length -= bytes.len() as u64;
        }
        Ok(format!("{:x}", hash.finalize()))
    }
}
#[derive(Clone, Debug)]
pub struct Incoming {
    pub header: Header,
    pub end: u64,
    pub digest: String,
    pub verified: bool,
}

/// Scan from byte zero so verification covers the exact seal, including earlier
/// snapshots. Staging is optional and is requested only after all item formats
/// in the agent's cut have been checked in a first, read-only pass.
pub async fn incoming(
    door: &dyn EngramDoor,
    kind: &str,
    reference: &str,
    cut: &str,
    stage: Option<&Path>,
    local: (u32, u32),
) -> Result<Incoming, ErrorBody> {
    let mut reader = DoorReader::new(door, reference, Some(cut));
    let mut selected = None;
    loop {
        if reader.end == Some(reader.offset) {
            break;
        }
        if reader.bytes(5).await?.as_slice() != MAGIC {
            return Err(error(
                RefusalCode::Unavailable,
                "unknown MC stream envelope",
            ));
        }
        let size =
            u32::from_le_bytes(reader.bytes(4).await?.try_into().expect("four bytes")) as usize;
        if size > HEADER_MAX {
            return Err(error(
                RefusalCode::Unavailable,
                "oversized MC stream header",
            ));
        }
        let metadata = reader.bytes(size).await?;
        let summary: serde_json::Value = serde_json::from_slice(&metadata).map_err(storage)?;
        if summary["cut_id"] == cut {
            let context = summary["context_version"].as_u64();
            let module = summary["store_version"].as_u64();
            let inventory = summary["inventory_version"].as_u64();
            if context != Some(move_inventory::CONTEXT_SCHEMA_VERSION as u64)
                || module != Some(move_inventory::STORE_SCHEMA_VERSION as u64)
                || inventory != Some(move_inventory::INVENTORY_VERSION as u64)
                || context.is_some_and(|v| v > local.0 as u64)
                || module.is_some_and(|v| v > local.1 as u64)
            {
                return Err(ErrorBody::with_typed_detail(
                    Detail::IncompatibleVersion(IncompatibleVersionDetail::new(
                        format!(
                            "mc-agent/1;context={};store={};inventory={}",
                            summary["context_version"],
                            summary["store_version"],
                            summary["inventory_version"]
                        ),
                        format!(
                            "mc-agent/1;context={};store={};inventory={}",
                            local.0,
                            local.1,
                            move_inventory::INVENTORY_VERSION
                        ),
                    )),
                    "MC cannot read this snapshot format",
                ));
            }
        }
        let header: Header = serde_json::from_slice(&metadata).map_err(storage)?;
        let chosen = header.cut_id == cut;
        if chosen {
            header.check_format(local)?;
            header.validate_identity(kind, reference)?;
            if selected.is_some() {
                return Err(error(RefusalCode::Unavailable, "duplicate snapshot at cut"));
            }
        }
        for (i, half) in header.halves.iter().enumerate() {
            for (side, length, expected) in [
                ("context", half.context_length, &half.context_digest),
                ("module", half.module_length, &half.module_digest),
            ] {
                let mut file = if chosen {
                    stage
                        .map(|dir| {
                            mc_store::private_permissions::create_file(
                                &dir.join(format!("{side}-{i}.bin")),
                                true,
                            )
                        })
                        .transpose()
                        .map_err(storage)?
                } else {
                    None
                };
                let digest = reader.copy(length, file.as_mut()).await?;
                if chosen && digest != *expected {
                    return Err(error(
                        RefusalCode::DigestMismatch,
                        "MC snapshot half digest differs",
                    ));
                }
                if let Some(file) = file {
                    file.sync_all().map_err(storage)?;
                }
            }
        }
        if chosen {
            selected = Some(header);
        }
    }
    let header = selected.ok_or_else(|| {
        error(
            RefusalCode::CutNotReady,
            "cut does not contain this MC snapshot",
        )
    })?;
    let digest = format!("{:x}", reader.hash.finalize());
    if reader
        .digest
        .as_ref()
        .is_some_and(|expected| expected != &digest)
    {
        return Err(error(
            RefusalCode::DigestMismatch,
            "sealed MC stream digest differs",
        ));
    }
    Ok(Incoming {
        header,
        end: reader.offset,
        digest,
        verified: reader.digest.is_some(),
    })
}

pub async fn prefix_digest(
    door: &dyn EngramDoor,
    reference: &str,
    end: u64,
    path: &Path,
) -> Result<String, ErrorBody> {
    let mut reader = DoorReader::new(door, reference, None);
    let mut hash = Sha256::new();
    let mut remaining = end;
    while remaining > 0 {
        let bytes = reader.bytes(remaining.min(PAGE as u64) as usize).await?;
        hash.update(&bytes);
        remaining -= bytes.len() as u64;
    }
    let mut file = File::open(path).map_err(storage)?;
    let mut buf = vec![0; PAGE];
    loop {
        let n = file.read(&mut buf).map_err(storage)?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

pub async fn stream_digest(
    door: &dyn EngramDoor,
    reference: &str,
    end: u64,
) -> Result<String, ErrorBody> {
    let mut reader = DoorReader::new(door, reference, None);
    reader.copy(end, None).await?;
    Ok(format!("{:x}", reader.hash.finalize()))
}
