//! The Engram backup catalog for the Magic Context data folder.
//!
//! Engram, the fleet backup service, backs up a module's data folder only from a
//! descriptor the module leaves there: `engram-catalog.json`. With no descriptor,
//! Engram skips the module and backs up nothing. The descriptor used to be written
//! by hand, so a fresh machine never had one. ck-mc now writes it at startup.
//!
//! Every path a released Magic Context build creates in the data folder under a
//! fixed name is declared here with a class: portable (backed up), device-local
//! (state that belongs to this machine), rebuild (a cache that regenerates), or
//! excluded (deliberately not backed up, with a reason). Paths only maintainer
//! tooling writes are declared excluded too, so a reader of the catalog can tell
//! a deliberate omission from a forgotten one.
//!
//! The schema is Engram's `engram-core/src/catalog.rs`. Engram matches paths
//! literally (no globs), so names that differ per machine or per run cannot be
//! declared and are left unlisted: the store's `<hash>.lease` lock files and the
//! CLI's `identity-merge-backup-*` directories. Engram captures only what a
//! descriptor declares, so an unlisted path is simply not backed up. SQLite
//! `-wal` and `-shm` companions travel with their database's capture mechanism
//! and are not declared on their own.

use std::io;
use std::path::Path;

use serde::Serialize;

/// The descriptor's file name, inside the data folder. Engram looks for exactly this.
pub const CATALOG_FILE_NAME: &str = "engram-catalog.json";

/// Engram requires the descriptor's `module_id` to equal the name of the data
/// directory it sits in, which is `magic-context` for the conventional data folder.
const CATALOG_MODULE_ID: &str = "magic-context";

/// The one descriptor schema version Engram currently accepts.
const CATALOG_SCHEMA_VERSION: u32 = 1;

/// The portable directory of remembered project identities. It is created when
/// the first identity pin is written, not when the catalog is published.
const PROJECT_IDENTITIES_DIR: &str = "project-identities";

/// Why maintainer-only paths are listed at all: no released build writes them,
/// but they exist on development machines and should read as deliberate.
const MAINTAINER_ONLY: &str = "maintainer-only, not written by released code";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum Class {
    Portable,
    DeviceLocal,
    Rebuild,
    Excluded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum Mechanism {
    WholeDb,
    PageDb,
    Filetree,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum WriterInteraction {
    /// Engram copies the database through SQLite's backup API while ck-mc keeps
    /// writing; this never takes the writer lock.
    BackupApiLive,
    /// Engram holds a read transaction while it reads pages; the host keeps
    /// writing under WAL, and checkpoints wait until the read ends.
    ReadTransactionLive,
}

#[derive(Debug, Clone, Copy, Serialize)]
struct Entry {
    entry_id: &'static str,
    class: Class,
    mechanism: Mechanism,
    path: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    writer_interaction: Option<WriterInteraction>,
    /// Tables of a page-db entry that Engram blanks in each capture, so a restored
    /// database has them empty. Only tables whose loss costs nothing lasting go here.
    #[serde(skip_serializing_if = "Option::is_none")]
    exclude_tables: Option<&'static [&'static str]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
}

#[derive(Serialize)]
struct Descriptor {
    schema_version: u32,
    module_id: &'static str,
    entries: &'static [Entry],
}

const fn file(entry_id: &'static str, class: Class, path: &'static str) -> Entry {
    Entry {
        entry_id,
        class,
        mechanism: Mechanism::Filetree,
        path,
        writer_interaction: None,
        exclude_tables: None,
        reason: None,
    }
}

const fn excluded(entry_id: &'static str, path: &'static str, reason: &'static str) -> Entry {
    Entry {
        entry_id,
        class: Class::Excluded,
        mechanism: Mechanism::Filetree,
        path,
        writer_interaction: None,
        exclude_tables: None,
        reason: Some(reason),
    }
}

/// The last-good request tables in `context.db`. They hold a copy of the last
/// request each session sent, kept only as the fallback for a busy database, and
/// they are rewritten on most turns, so they dominate the backup's churn. A
/// restored database with both empty loses nothing lasting: the next healthy pass
/// captures a fresh copy, and until then a busy moment in that session is refused
/// instead of replayed. A restore rewinds the session anyway, so an old copy would
/// rarely match. No kept table has a foreign key into either one.
const CONTEXT_DB_EXCLUDED_TABLES: &[&str] = &["lkg_slots", "lkg_slot_chunks"];

/// Every declared path, in the order the descriptor lists them. The entry IDs of
/// the four original entries (`context-db`, `module-store`, `embedding-models`,
/// `rpc`) are kept from the hand-written descriptor because Engram keys restore
/// state by entry ID.
const ENTRIES: &[Entry] = &[
    // ── Portable: what a user would lose on a new machine ──────────────────
    Entry {
        entry_id: "magic-context/context-db",
        class: Class::Portable,
        mechanism: Mechanism::PageDb,
        path: "context.db",
        writer_interaction: Some(WriterInteraction::ReadTransactionLive),
        exclude_tables: Some(CONTEXT_DB_EXCLUDED_TABLES),
        reason: None,
    },
    Entry {
        entry_id: "magic-context/module-store",
        class: Class::Portable,
        mechanism: Mechanism::WholeDb,
        path: "store.db",
        writer_interaction: Some(WriterInteraction::BackupApiLive),
        exclude_tables: None,
        reason: None,
    },
    file(
        "magic-context/project-identities",
        Class::Portable,
        PROJECT_IDENTITIES_DIR,
    ),
    // ── Device-local: state that belongs to this machine ───────────────────
    file("magic-context/rpc", Class::DeviceLocal, "rpc"),
    file(
        "magic-context/lkg-recovery-fences",
        Class::DeviceLocal,
        "lkg-recovery-fences",
    ),
    file(
        "magic-context/pi-served-array-digests",
        Class::DeviceLocal,
        "pi-served-array-digests",
    ),
    file(
        "magic-context/pi-served-tag-numbers",
        Class::DeviceLocal,
        "pi-served-tag-numbers",
    ),
    file(
        "magic-context/last-update-check",
        Class::DeviceLocal,
        "last-update-check.json",
    ),
    file(
        "magic-context/last-announced-version",
        Class::DeviceLocal,
        "last_announced_version",
    ),
    file("magic-context/agent-data", Class::DeviceLocal, "agent-data"),
    // ── Rebuild: caches that regenerate ───────────────────────────────────
    file("magic-context/embedding-models", Class::Rebuild, "models"),
    file(
        "magic-context/model-context-limits-opencode",
        Class::Rebuild,
        "model-context-limits-opencode.json",
    ),
    file(
        "magic-context/model-context-limits-opencode2",
        Class::Rebuild,
        "model-context-limits-opencode2.json",
    ),
    file(
        "magic-context/model-context-limits-pi",
        Class::Rebuild,
        "model-context-limits-pi.json",
    ),
    file(
        "magic-context/model-context-limits-omp",
        Class::Rebuild,
        "model-context-limits-omp.json",
    ),
    // ── Excluded: written or read by released code, deliberately not backed up
    excluded(
        "magic-context/github-token",
        "github-token",
        "secret: a user-placed GitHub token; place it again on the new machine",
    ),
    excluded(
        "magic-context/logs",
        "logs",
        "diagnostic logs for this machine; may quote prompt and tool text",
    ),
    excluded(
        "magic-context/window-reports",
        "window-reports.jsonl",
        "diagnostic context-window overflow ledger for this machine",
    ),
    excluded(
        "magic-context/window-reports-rotated",
        "window-reports.jsonl.1",
        "rotated diagnostic context-window overflow ledger for this machine",
    ),
    excluded(
        "magic-context/heap-snapshots",
        "heap-snapshots",
        "bulky on-demand heap dumps; may hold prompt text in memory",
    ),
    excluded(
        "magic-context/host-profiler",
        "host-profiler",
        "opt-in stall profiles for this machine's host process",
    ),
    excluded(
        "magic-context/pi-served-array-bodies",
        "pi-served-array-bodies",
        "opt-in debug capture of full served request bodies; bulky and holds prompt text",
    ),
    excluded(
        "magic-context/backups",
        "backups",
        "bulky doctor repair backups of databases that are captured on their own",
    ),
    // ── Excluded: maintainer-only paths ────────────────────────────────────
    excluded("magic-context/archive", "archive", MAINTAINER_ONLY),
    excluded("magic-context/ci-sentinel", "ci-sentinel", MAINTAINER_ONLY),
    excluded(
        "magic-context/ci-sentinel-bin",
        "ci-sentinel-bin",
        MAINTAINER_ONLY,
    ),
    excluded("magic-context/drafts", "drafts", MAINTAINER_ONLY),
    excluded("magic-context/reviews", "reviews", MAINTAINER_ONLY),
    excluded("magic-context/sentinel", "sentinel", MAINTAINER_ONLY),
    excluded("magic-context/specimens", "specimens", MAINTAINER_ONLY),
    excluded("magic-context/staging", "staging", MAINTAINER_ONLY),
    excluded(
        "magic-context/cache-bust-sentinel-state",
        "cache-bust-sentinel-state.json",
        MAINTAINER_ONLY,
    ),
    excluded(
        "magic-context/subagent-failure-sentinel-state",
        "subagent-failure-sentinel-state.json",
        MAINTAINER_ONLY,
    ),
    excluded(
        "magic-context/transform-latency-sentinel-state",
        "transform-latency-sentinel-state.json",
        MAINTAINER_ONLY,
    ),
    excluded(
        "magic-context/migration-complete",
        "migration_complete.txt",
        MAINTAINER_ONLY,
    ),
];

/// The descriptor's exact bytes: pretty-printed JSON in table order with a
/// trailing newline. Nothing in it depends on the machine, the clock, or the
/// environment, so every run produces the same bytes.
pub fn catalog_bytes() -> Vec<u8> {
    let descriptor = Descriptor {
        schema_version: CATALOG_SCHEMA_VERSION,
        module_id: CATALOG_MODULE_ID,
        entries: ENTRIES,
    };
    let mut bytes =
        serde_json::to_vec_pretty(&descriptor).expect("a static descriptor always serializes");
    bytes.push(b'\n');
    bytes
}

/// What [`write_catalog`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CatalogWrite {
    /// The file already held exactly these bytes, so it was left untouched.
    Unchanged,
    /// The file was missing or different and was replaced.
    Written,
}

/// Publish the descriptor into `data_dir`.
///
/// The bytes go to an owner-only temporary file in the same folder, are synced,
/// and are renamed over the old descriptor, so Engram never reads half a file.
/// The file is always mode 0600, whatever the private-storage setting: Engram
/// runs as the same user and nobody else needs it. An existing byte-identical
/// file is not rewritten.
pub fn write_catalog(data_dir: &Path) -> io::Result<CatalogWrite> {
    let path = data_dir.join(CATALOG_FILE_NAME);
    let bytes = catalog_bytes();
    if std::fs::read(&path).is_ok_and(|existing| existing == bytes) {
        return Ok(CatalogWrite::Unchanged);
    }
    mc_store::private_permissions::write_file_atomic(&path, &bytes, true)?;
    Ok(CatalogWrite::Written)
}

/// Startup wrapper around [`write_catalog`]: a failure is logged once and
/// returned to the caller, which carries on starting. A missing backup
/// descriptor must never stop Magic Context from serving.
pub fn write_catalog_at_startup(data_dir: &Path) -> io::Result<CatalogWrite> {
    let outcome = write_catalog(data_dir);
    match &outcome {
        Ok(CatalogWrite::Written) => tracing::info!(
            path = %data_dir.join(CATALOG_FILE_NAME).display(),
            "mc-module: engram catalog written"
        ),
        Ok(CatalogWrite::Unchanged) => {}
        Err(error) => tracing::warn!(
            path = %data_dir.join(CATALOG_FILE_NAME).display(),
            %error,
            "mc-module: engram catalog not written; Engram will not back up this data folder until it is"
        ),
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// The descriptor's exact published bytes. A change here is a change to what
    /// Engram backs up, so it must be made on purpose and reviewed as such. The
    /// same file is what Engram's `catalog_check` example validates.
    const PINNED_CATALOG: &str = include_str!("../testdata/engram-catalog.json");

    fn parsed() -> serde_json::Value {
        serde_json::from_slice(&catalog_bytes()).expect("the catalog is valid JSON")
    }

    fn entries() -> Vec<serde_json::Value> {
        parsed()["entries"]
            .as_array()
            .expect("entries array")
            .clone()
    }

    #[test]
    fn catalog_bytes_are_pinned() {
        let bytes = catalog_bytes();
        assert_eq!(bytes, catalog_bytes(), "two builds in one run must agree");
        assert_eq!(
            String::from_utf8(bytes).expect("UTF-8"),
            PINNED_CATALOG,
            "the published catalog changed"
        );
    }

    /// The live session database is the data a user most needs on a new machine.
    /// It reaches the backup only through this entry.
    #[test]
    fn catalog_declares_context_db_as_portable_page_db() {
        let entries = entries();
        let context_db = entries
            .iter()
            .find(|entry| entry["path"] == "context.db")
            .expect("context.db must be declared");
        assert_eq!(context_db["entry_id"], "magic-context/context-db");
        assert_eq!(context_db["class"], "portable");
        assert_eq!(context_db["mechanism"], "page-db");
        assert_eq!(context_db["writer_interaction"], "read-transaction-live");
        assert_eq!(
            context_db["exclude_tables"],
            serde_json::json!(["lkg_slots", "lkg_slot_chunks"]),
            "only the last-good request tables may be left out of the backup"
        );
    }

    #[test]
    fn catalog_declares_store_db_and_identity_pins_as_portable() {
        let entries = entries();
        let store = entries
            .iter()
            .find(|entry| entry["path"] == "store.db")
            .expect("store.db must be declared");
        assert_eq!(store["entry_id"], "magic-context/module-store");
        assert_eq!(store["class"], "portable");
        assert_eq!(store["mechanism"], "whole-db");
        assert_eq!(store["writer_interaction"], "backup-api-live");
        let identities = entries
            .iter()
            .find(|entry| entry["path"] == PROJECT_IDENTITIES_DIR)
            .expect("project-identities must be declared");
        assert_eq!(identities["entry_id"], "magic-context/project-identities");
        assert_eq!(identities["class"], "portable");
        assert_eq!(identities["mechanism"], "filetree");
    }

    /// A local mirror of the rules Engram's descriptor parser enforces, so a bad
    /// entry fails here rather than stopping every module's backup on the user's
    /// machine.
    #[test]
    fn every_entry_satisfies_engram_descriptor_rules() {
        let descriptor = parsed();
        assert_eq!(descriptor["schema_version"], 1);
        assert_eq!(descriptor["module_id"], "magic-context");
        let mut ids = std::collections::BTreeSet::new();
        let mut paths = std::collections::BTreeSet::new();
        for entry in entries() {
            let id = entry["entry_id"].as_str().expect("entry_id");
            assert!(ids.insert(id.to_string()), "duplicate entry id {id}");
            assert!(id.starts_with("magic-context/"), "{id}");
            let path = entry["path"].as_str().expect("every entry names a path");
            assert!(paths.insert(path.to_string()), "duplicate path {path}");
            assert!(
                !path.is_empty()
                    && !path.contains('/')
                    && !path.contains('\\')
                    && !path.contains('*')
                    && path != "."
                    && path != "..",
                "{id}: path must be one literal top-level name, got {path:?}"
            );
            let class = entry["class"].as_str().expect("class");
            assert!(
                ["portable", "device-local", "rebuild", "excluded"].contains(&class),
                "{id}: {class}"
            );
            let mechanism = entry["mechanism"].as_str().expect("mechanism");
            assert!(
                ["filetree", "whole-db", "page-db"].contains(&mechanism),
                "{id}: {mechanism}"
            );
            if class == "excluded" {
                let reason = entry["reason"].as_str().unwrap_or_default();
                assert!(!reason.trim().is_empty(), "{id}: excluded needs a reason");
            }
            if class == "portable" && mechanism == "page-db" {
                assert_eq!(
                    entry["writer_interaction"], "read-transaction-live",
                    "{id}: Engram requires read-transaction-live for page-db"
                );
            }
            if mechanism == "filetree" {
                assert!(
                    entry.get("writer_interaction").is_none(),
                    "{id}: writer_interaction is for live databases only"
                );
            }
            if let Some(tables) = entry.get("exclude_tables") {
                assert_eq!(
                    mechanism, "page-db",
                    "{id}: exclude_tables is for page-db only"
                );
                let tables = tables.as_array().expect("exclude_tables is an array");
                assert!(!tables.is_empty(), "{id}: exclude_tables must name a table");
                for table in tables {
                    assert!(
                        table.as_str().is_some_and(|name| !name.is_empty()),
                        "{id}: exclude_tables names must be non-empty strings"
                    );
                }
            }
        }
    }

    #[test]
    fn startup_writes_catalog_without_creating_the_identity_directory() {
        let temp = tempfile::tempdir().unwrap();
        let data_dir = temp.path().join("magic-context");
        assert_eq!(
            write_catalog_at_startup(&data_dir).unwrap(),
            CatalogWrite::Written
        );
        assert_eq!(
            std::fs::read(data_dir.join(CATALOG_FILE_NAME)).unwrap(),
            catalog_bytes()
        );
        assert!(
            !data_dir.join(PROJECT_IDENTITIES_DIR).exists(),
            "startup must leave the project identities directory for the pin writer"
        );
        let identities = entries()
            .into_iter()
            .find(|entry| entry["entry_id"] == "magic-context/project-identities")
            .expect("the catalog must still declare project identities");
        assert_eq!(identities["class"], "portable");
        assert_eq!(identities["path"], "project-identities");
        let mut names: Vec<String> = std::fs::read_dir(&data_dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(
            names,
            [CATALOG_FILE_NAME],
            "no temporary file may be left behind"
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_catalog_lands_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let data_dir = temp.path().join("magic-context");
        write_catalog(&data_dir).unwrap();
        let mode = std::fs::metadata(data_dir.join(CATALOG_FILE_NAME))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "catalog mode was {mode:o}");
        // A stale catalog left wider than owner-only is replaced by a 0600 file.
        std::fs::write(data_dir.join(CATALOG_FILE_NAME), b"{}").unwrap();
        std::fs::set_permissions(
            data_dir.join(CATALOG_FILE_NAME),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        assert_eq!(write_catalog(&data_dir).unwrap(), CatalogWrite::Written);
        let mode = std::fs::metadata(data_dir.join(CATALOG_FILE_NAME))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "rewritten catalog mode was {mode:o}");
    }

    #[test]
    fn a_byte_identical_catalog_is_not_rewritten() {
        let temp = tempfile::tempdir().unwrap();
        let data_dir = temp.path().join("magic-context");
        assert_eq!(write_catalog(&data_dir).unwrap(), CatalogWrite::Written);
        let path = data_dir.join(CATALOG_FILE_NAME);
        // Back-date the file: a rewrite (a rename over it) would carry a new
        // modification time, and on Unix a new inode.
        let old = filetime::FileTime::from_unix_time(1_000_000_000, 0);
        filetime::set_file_mtime(&path, old).unwrap();
        #[cfg(unix)]
        let inode_before = std::os::unix::fs::MetadataExt::ino(&std::fs::metadata(&path).unwrap());

        assert_eq!(write_catalog(&data_dir).unwrap(), CatalogWrite::Unchanged);
        let metadata = std::fs::metadata(&path).unwrap();
        assert_eq!(
            filetime::FileTime::from_last_modification_time(&metadata),
            old
        );
        #[cfg(unix)]
        assert_eq!(std::os::unix::fs::MetadataExt::ino(&metadata), inode_before);

        // Different bytes are replaced.
        std::fs::write(&path, b"hand-written").unwrap();
        assert_eq!(write_catalog(&data_dir).unwrap(), CatalogWrite::Written);
        assert_eq!(std::fs::read(&path).unwrap(), catalog_bytes());
    }

    /// Captures formatted log lines so the test can count the warning.
    #[derive(Clone)]
    struct Captured(Arc<Mutex<Vec<u8>>>);

    impl std::io::Write for Captured {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn an_unwritable_data_folder_logs_once_and_continues() {
        let temp = tempfile::tempdir().unwrap();
        // A regular file where the data folder should be: nothing can be created
        // inside it, even for a root test runner that ignores permission bits.
        let data_dir = temp.path().join("magic-context");
        std::fs::write(&data_dir, b"not a directory").unwrap();

        let output = Captured(Arc::new(Mutex::new(Vec::new())));
        let writer = output.clone();
        let subscriber = tracing_subscriber::fmt()
            .without_time()
            .with_ansi(false)
            .with_writer(move || writer.clone())
            .finish();
        let outcome =
            tracing::subscriber::with_default(subscriber, || write_catalog_at_startup(&data_dir));

        assert!(outcome.is_err(), "the failure is reported to the caller");
        let logs = String::from_utf8(output.0.lock().unwrap().clone()).unwrap();
        assert_eq!(
            logs.matches("engram catalog not written").count(),
            1,
            "exactly one warning: {logs}"
        );
        assert!(logs.contains("WARN"), "{logs}");
        assert_eq!(
            std::fs::read(&data_dir).unwrap(),
            b"not a directory",
            "the blocking file is left alone"
        );
    }

    #[test]
    #[ignore = "prints the catalog for review; run with --ignored --nocapture"]
    fn print_catalog() {
        print!("{}", String::from_utf8(catalog_bytes()).unwrap());
    }
}
