//! Installs fresh schemas only; existing stores still need the TypeScript migration chain.

use std::{fs, path::Path, time::Duration};

use rusqlite::{Connection, OpenFlags, TransactionBehavior};

use crate::{parity_schema_manifest::*, private_permissions};

use super::fingerprints::{fingerprint, schema_snapshot};

const STORAGE_SOURCE: &str =
    include_str!("../../../../packages/plugin/src/features/magic-context/storage-db.ts");
const MIGRATION_SOURCE: &str =
    include_str!("../../../../packages/plugin/src/features/magic-context/migrations.ts");
const SCHEMA: &str = include_str!("../../testdata/context_schema/schema.sql");

// Read the authoritative declarations at compile time; installed binaries need no TypeScript files.
const fn declared_number(source: &str, declaration: &str) -> u32 {
    let source = source.as_bytes();
    let declaration = declaration.as_bytes();
    let mut offset = 0;
    while offset + declaration.len() < source.len() {
        let mut matched = 0;
        while matched < declaration.len() && source[offset + matched] == declaration[matched] {
            matched += 1;
        }
        if matched == declaration.len() {
            let mut position = offset + matched;
            let mut value = 0;
            let mut digits = 0;
            while position < source.len() {
                let byte = source[position];
                if byte >= b'0' && byte <= b'9' {
                    value = value * 10 + (byte - b'0') as u32;
                    digits += 1;
                } else if byte != b'_' {
                    break;
                }
                position += 1;
            }
            assert!(digits > 0, "schema declaration must be a numeric literal");
            return value;
        }
        offset += 1;
    }
    panic!("schema declaration not found");
}

pub const BOOTSTRAP_VERSION: u32 =
    declared_number(STORAGE_SOURCE, "export const LATEST_SUPPORTED_VERSION = ");
const FORK_VERSION_FLOOR: u32 = declared_number(
    MIGRATION_SOURCE,
    "export const FORK_MIGRATION_VERSION_FLOOR = ",
);

#[derive(Debug, Default, Clone, Copy)]
pub struct BootstrapContextSchema;
pub static BOOTSTRAP: BootstrapContextSchema = BootstrapContextSchema;

fn refusal(code: &str, message: impl Into<String>) -> CapabilityReason {
    CapabilityReason {
        code: code.into(),
        message: message.into(),
    }
}

fn mismatch(found: i64, expected: u32) -> CapabilityReason {
    refusal(
        "schema_version_mismatch",
        format!("context.db schema version found {found}, expected {expected}; Rust bootstrap never migrates existing databases"),
    )
}

fn fail(error: impl std::fmt::Display) -> CapabilityReason {
    refusal(
        "bootstrap_failed",
        format!("context.db bootstrap failed: {error}"),
    )
}

fn reject_link(path: &Path) -> Result<(), CapabilityReason> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(refusal(
            "unsafe_database_path",
            format!("refusing symlink {}", path.display()),
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(fail(error)),
    }
}

fn secure_path(path: &Path) -> Result<(), CapabilityReason> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| {
            refusal(
                "unsafe_database_path",
                "database path must name a storage directory",
            )
        })?;
    for ancestor in parent.ancestors() {
        reject_link(ancestor)?;
    }
    reject_link(path)?;
    private_permissions::ensure_directory(parent, true).map_err(fail)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700)).map_err(fail)?;
    }
    match private_permissions::create_file(path, true) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(fail(error)),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(fail)?;
    }
    Ok(())
}

fn bootstrap(request: &ContextSchemaRequest) -> Result<ContextSchemaReport, CapabilityReason> {
    if request.expected_schema_version != BOOTSTRAP_VERSION {
        return Err(mismatch(
            i64::from(request.expected_schema_version),
            BOOTSTRAP_VERSION,
        ));
    }
    let path = Path::new(&request.database_path);
    secure_path(path)?;
    let mut connection =
        Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(fail)?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(fail)?;
    connection
        .pragma_update(None, "foreign_keys", true)
        .map_err(fail)?;
    // Serialize the emptiness/version decision with every other SQLite writer.
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(fail)?;
    let objects: i64 = transaction
        .query_row("SELECT COUNT(*) FROM sqlite_master", [], |row| row.get(0))
        .map_err(fail)?;
    if objects == 0 {
        let applied_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(fail)?
            .as_millis();
        transaction
            .execute_batch(&SCHEMA.replace(":applied_at", &applied_at.to_string()))
            .map_err(fail)?;
    }
    let has_ledger: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations')",
            [], |row| row.get(0),
        ).map_err(fail)?;
    let found: i64 = if has_ledger {
        transaction
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM schema_migrations WHERE version < ?1",
                [FORK_VERSION_FLOOR],
                |row| row.get(0),
            )
            .map_err(fail)?
    } else {
        0
    };
    if found != i64::from(BOOTSTRAP_VERSION) {
        return Err(mismatch(found, BOOTSTRAP_VERSION));
    }
    let snapshot = schema_snapshot(&transaction).map_err(fail)?;
    let report = ContextSchemaReport {
        schema_version: BOOTSTRAP_VERSION,
        schema_fingerprint: ContentHash(fingerprint(&snapshot)),
    };
    transaction.commit().map_err(fail)?;
    Ok(report)
}

impl ContextSchemaStore for BootstrapContextSchema {
    fn availability(&self) -> Availability {
        Availability::Available
    }

    fn bootstrap(&self, request: &ContextSchemaRequest) -> CapabilityResult<ContextSchemaReport> {
        match bootstrap(request) {
            Ok(value) => CapabilityResult::Available { value },
            Err(reason) => CapabilityResult::Unavailable { reason },
        }
    }
}
