use std::cell::Cell;
use std::fs::{self, File};
use std::os::unix::fs::{symlink, PermissionsExt};

use cortexkit_doctor::{CheckOutput, FixClass, LogSource, Manifest, ModuleId};
use cortexkit_log_manifest::{generate, ManifestMetadata};
use rusqlite::Connection;

use crate::agent_data::journal;
use crate::context_db::{ContextDb, FRESH_SCHEMA, SCHEMA_VERSION};
use crate::context_migrations::RELEASED_PLUGIN_VERSION;
use crate::storage_paths::{CONTEXT_DB, MODULE_DIR, SESSION_DB};
use crate::store::Store;

use super::*;

const NOW: i64 = 24 * 60 * 60 * 1_000;

struct Fixture {
    home: tempfile::TempDir,
    data: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let home = tempfile::Builder::new()
            .prefix("home ?#% ")
            .tempdir()
            .unwrap();
        let data = home.path().join("cortexkit").join(MODULE_DIR);
        fs::create_dir_all(&data).unwrap();
        Self { home, data }
    }

    fn healthy() -> Self {
        let f = Self::new();
        drop(ContextDb::create_for_tests(&f.data.join(CONTEXT_DB)).unwrap());
        chmod(&f.data.join(CONTEXT_DB), 0o600);
        drop(Store::open(&f.data.join(SESSION_DB)).unwrap());
        chmod(&f.data.join(SESSION_DB), 0o600);
        for name in ["backups", "specimens", "logs"] {
            let path = f.data.join(name);
            fs::create_dir(&path).unwrap();
            chmod(&path, 0o700);
        }
        let journal = journal::path(&f.data.join(CONTEXT_DB));
        fs::create_dir(journal.parent().unwrap()).unwrap();
        fs::write(
            journal,
            serde_json::to_vec(&journal::Contents::default()).unwrap(),
        )
        .unwrap();
        f
    }

    fn findings(&self) -> Vec<Finding> {
        check_at(self.home.path(), Instant::now, NOW).unwrap()
    }

    fn context(&self) -> Connection {
        Connection::open(self.data.join(CONTEXT_DB)).unwrap()
    }

    fn data(&self) -> files::DataDir {
        files::DataDir::open(self.home.path()).unwrap().unwrap()
    }
}

fn chmod(path: &Path, mode: u32) {
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
}

fn mode(path: &Path) -> u32 {
    fs::metadata(path).unwrap().permissions().mode() & 0o777
}

fn expect(findings: &[Finding], id: &str, severity: Severity) -> serde_json::Value {
    let item = findings
        .iter()
        .find(|f| f.id().as_str() == id)
        .unwrap_or_else(|| panic!("missing {id}: {findings:?}"));
    assert_eq!(item.severity(), severity);
    let evidence = serde_json::to_value(item.evidence()).unwrap();
    evidence
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            (
                entry["name"].as_str().unwrap().to_owned(),
                entry["value"].clone(),
            )
        })
        .collect()
}

#[test]
fn healthy_and_uninitialized_data_report_no_findings() {
    assert!(Fixture::healthy().findings().is_empty());
    assert!(Fixture::new().findings().is_empty());
    let home = tempfile::tempdir().unwrap();
    assert!(check_at(home.path(), Instant::now, NOW).unwrap().is_empty());
    assert_eq!(fs::read_dir(home.path()).unwrap().count(), 0);
}

#[test]
fn context_too_new_uses_the_ledger_not_the_header() {
    let f = Fixture::healthy();
    let conn = f.context();
    conn.execute(
        "INSERT INTO schema_migrations(version, description, applied_at) VALUES (?1, 'new', 0)",
        [SCHEMA_VERSION + 1],
    )
    .unwrap();
    drop(conn);
    assert_eq!(stores::header(&f.data(), CONTEXT_DB).unwrap(), Some(0));
    let evidence = expect(&f.findings(), "store.context.too_new", Severity::Error);
    assert_eq!(evidence["found_version"], (SCHEMA_VERSION + 1).to_string());
    assert_eq!(evidence["supported_version"], SCHEMA_VERSION.to_string());
}

#[test]
fn context_too_old_uses_the_released_plugin_floor() {
    let f = Fixture::new();
    f.context()
        .execute_batch("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY)")
        .unwrap();
    f.context()
        .execute(
            "INSERT INTO schema_migrations VALUES (?1)",
            [RELEASED_PLUGIN_VERSION - 1],
        )
        .unwrap();
    let evidence = expect(&f.findings(), "store.context.too_old", Severity::Error);
    assert_eq!(
        evidence["found_version"],
        (RELEASED_PLUGIN_VERSION - 1).to_string()
    );
    assert_eq!(
        evidence["oldest_supported_version"],
        RELEASED_PLUGIN_VERSION.to_string()
    );
}

#[test]
fn plugin_snapshot_reports_upgrade_pending_without_migrating() {
    let f = Fixture::new();
    f.context()
        .execute_batch(&FRESH_SCHEMA.replace(":applied_at", "0"))
        .unwrap();
    let before = fs::read(f.data.join(CONTEXT_DB)).unwrap();
    let evidence = expect(
        &f.findings(),
        "store.context.upgrade_pending",
        Severity::Info,
    );
    assert_eq!(
        evidence["found_version"],
        crate::context_db::PLUGIN_SCHEMA_VERSION.to_string()
    );
    assert_eq!(evidence["current_version"], SCHEMA_VERSION.to_string());
    assert_eq!(fs::read(f.data.join(CONTEXT_DB)).unwrap(), before);
}

#[test]
fn session_headers_before_and_after_migration_and_above_the_fence() {
    let f = Fixture::new();
    let path = f.data.join(SESSION_DB);
    drop(Store::create_version_three_for_tests(&path).unwrap());
    assert_eq!(stores::header(&f.data(), SESSION_DB).unwrap(), Some(3));
    drop(Store::open(&path).unwrap());
    assert_eq!(
        stores::header(&f.data(), SESSION_DB).unwrap(),
        Some(crate::store::SCHEMA_VERSION)
    );
    let conn = Connection::open(path).unwrap();
    let newer = crate::store::SCHEMA_VERSION + 1;
    conn.pragma_update(None, "user_version", newer).unwrap();
    drop(conn);
    assert_eq!(stores::header(&f.data(), SESSION_DB).unwrap(), Some(newer));
    let findings = f.findings();
    let evidence = expect(&findings, "store.sessions.too_new", Severity::Error);
    assert_eq!(evidence["found_version"], newer.to_string());
    assert_eq!(
        evidence["supported_version"],
        crate::store::SCHEMA_VERSION.to_string()
    );
    let session_finding = findings
        .iter()
        .find(|f| f.id().as_str() == "store.sessions.too_new")
        .unwrap();
    assert!(!serde_json::to_string(session_finding)
        .unwrap()
        .contains(SESSION_DB));
}

#[test]
fn unreadable_stores_are_reported_in_one_finding_without_file_content() {
    let f = Fixture::new();
    fs::write(f.data.join(CONTEXT_DB), b"PRIVATE_STORE_CANARY").unwrap();
    fs::create_dir(f.data.join(SESSION_DB)).unwrap();
    let findings = f.findings();
    let evidence = expect(&findings, "store.unreadable", Severity::Error);
    assert_eq!(evidence["context_store"], "context");
    assert_eq!(evidence["sessions_store"], "sessions");
    assert_eq!(evidence["context_path"]["category"], "data");
    assert_eq!(evidence["sessions_path"]["category"], "data");
    assert!(!serde_json::to_string(&findings)
        .unwrap()
        .contains("PRIVATE_STORE_CANARY"));
    CheckOutput::new(findings).unwrap();
}

#[test]
fn either_sidecar_skips_context_sql_and_two_busy_stores_share_one_id() {
    for suffix in ["-wal", "-shm"] {
        let f = Fixture::healthy();
        fs::write(f.data.join(format!("{CONTEXT_DB}{suffix}")), []).unwrap();
        fs::write(f.data.join(format!("{SESSION_DB}{suffix}")), []).unwrap();
        let findings = f.findings();
        let evidence = expect(&findings, "store.in_use", Severity::Info);
        assert_eq!(evidence["context_store"], "context");
        assert_eq!(evidence["sessions_store"], "sessions");
        assert!(!findings
            .iter()
            .any(|f| f.id().as_str().starts_with("store.context.")));
        CheckOutput::new(findings).unwrap();
    }
}

#[test]
fn permissions_finding_has_one_safe_thirty_second_plan() {
    let f = Fixture::healthy();
    chmod(&f.data.join(CONTEXT_DB), 0o640);
    chmod(&f.data.join("logs"), 0o705);
    let findings = f.findings();
    let evidence = expect(&findings, PRIVATE_ID, Severity::Warning);
    assert_eq!(evidence["count"], 2);
    assert_eq!(evidence["path"]["category"], "data");
    assert!(evidence["path"]["path"]
        .as_str()
        .unwrap()
        .ends_with(CONTEXT_DB));
    let fix = findings[0].fix();
    assert_eq!(fix.class(), FixClass::Safe);
    assert!(!fix.needs_stop());
    assert_eq!(fix.plan().unwrap().timeout_ms(), 30_000);
}

#[test]
fn backups_and_specimens_combined_must_exceed_two_decimal_gigabytes() {
    let f = Fixture::healthy();
    let backup = File::create(f.data.join("backups/one")).unwrap();
    let specimen = File::create(f.data.join("specimens/two")).unwrap();
    backup.set_len(1_999_999_999).unwrap();
    specimen.set_len(1).unwrap();
    assert!(!f
        .findings()
        .iter()
        .any(|f| f.id().as_str() == "backups.large"));
    specimen.set_len(2).unwrap();
    let e = expect(&f.findings(), "backups.large", Severity::Info);
    assert_eq!(e["bytes"], 2_000_000_001u64);
    assert_eq!(e["count"], 2);
}

#[test]
fn unreadable_journal_reports_only_its_path() {
    let f = Fixture::healthy();
    fs::write(
        journal::path(&f.data.join(CONTEXT_DB)),
        r#"{"format":"PRIVATE_JOURNAL_CANARY"}"#,
    )
    .unwrap();
    let findings = f.findings();
    let e = expect(&findings, "moves.journal_unreadable", Severity::Error);
    assert_eq!(e["path"]["category"], "data");
    assert!(e["path"]["path"]
        .as_str()
        .unwrap()
        .ends_with("agent-data/journal.json"));
    assert!(!serde_json::to_string(&findings)
        .unwrap()
        .contains("PRIVATE_JOURNAL_CANARY"));
}

#[test]
fn sharing_reports_an_overdue_key_and_unsent_changes_without_payloads() {
    let f = Fixture::healthy();
    let conn = f.context();
    conn.execute("UPDATE replica_state SET held_epoch = 7, held_since = ?1, held_why = 'PRIVATE_HOLD_CANARY' WHERE id = 1", [NOW - 3_600_000]).unwrap();
    conn.execute_batch("INSERT INTO replica_outbox(kind, local_id, revision, base_revision, change, created_at, state, actor) VALUES
        ('memory', 1, 1, 0, 'create', 0, 'pending', 'PRIVATE_ACTOR_CANARY'),
        ('memory', 2, 1, 0, 'create', 0, 'sending', 'PRIVATE_ACTOR_CANARY'),
        ('memory', 3, 1, 0, 'create', 0, 'published', 'PRIVATE_ACTOR_CANARY');").unwrap();
    drop(conn);
    let boundary = f.findings();
    assert!(!boundary.iter().any(|f| f.id().as_str() == "sharing.held"));
    assert_eq!(
        expect(&boundary, "sharing.unsent", Severity::Info)["count"],
        2
    );
    f.context()
        .execute(
            "UPDATE replica_state SET held_since = ?1 WHERE id = 1",
            [NOW - 5_400_000],
        )
        .unwrap();
    let findings = f.findings();
    let e = expect(&findings, "sharing.held", Severity::Warning);
    assert_eq!(e["hours_held"], 1.5);
    assert_eq!(e["key_number"], 7);
    assert!(!serde_json::to_string(&findings).unwrap().contains("CANARY"));
    fs::write(f.data.join(format!("{SESSION_DB}-shm")), []).unwrap();
    assert!(!f
        .findings()
        .iter()
        .any(|f| f.id().as_str().starts_with("sharing.")));
}

#[test]
fn budget_stops_both_walks_without_a_proven_finding() {
    let f = Fixture::healthy();
    let start = Instant::now();
    let tick = Cell::new(0);
    let now = || {
        let n = tick.get();
        tick.set(n + 1);
        start + WALK_BUDGET * n
    };
    let findings = check_at(f.home.path(), now, NOW).unwrap();
    assert_eq!(findings.len(), 1);
    let e = expect(&findings, INCOMPLETE_ID, Severity::Info);
    assert_eq!(e["permissions_walk"], "permissions");
    assert_eq!(e["permissions_entries"], 0);
    assert_eq!(e["backups_walk"], "backups");
    assert_eq!(e["backups_entries"], 0);
    assert_eq!(e["budget_ms"], 4000.0);
    CheckOutput::new(findings).unwrap();
}

#[test]
fn budget_preserves_a_permission_finding_proven_before_the_cutoff() {
    let f = Fixture::healthy();
    chmod(&f.data.join(CONTEXT_DB), 0o644);
    let start = Instant::now();
    let tick = Cell::new(0);
    let now = || {
        let n = tick.get();
        tick.set(n + 1);
        if n < 2 {
            start
        } else {
            start + WALK_BUDGET
        }
    };
    let findings = check_at(f.home.path(), now, NOW).unwrap();
    assert_eq!(findings.len(), 2);
    assert_eq!(expect(&findings, PRIVATE_ID, Severity::Warning)["count"], 1);
    let e = expect(&findings, INCOMPLETE_ID, Severity::Info);
    assert_eq!(e["permissions_entries"], 1);
    assert!(e["backups_walk"].is_null());
}

#[test]
fn fix_tightens_only_owned_regular_files_and_dirs_and_reports_symlinks() {
    let f = Fixture::healthy();
    let outside = f.home.path().join("outside");
    fs::create_dir(&outside).unwrap();
    chmod(&outside, 0o755);
    let outsider = outside.join("file");
    fs::write(&outsider, b"outside file").unwrap();
    chmod(&outsider, 0o644);
    let shared = f.data.join("backups/hardlink");
    fs::hard_link(&outsider, &shared).unwrap();
    symlink(&outside, f.data.join("logs/outside")).unwrap();
    symlink(&outsider, f.data.join("logs/file-link")).unwrap();
    let log = f.data.join("logs/local");
    let context = f.data.join(CONTEXT_DB);
    let lock = f.data.join(format!("{SESSION_DB}.lock"));
    fs::write(&log, b"log bytes").unwrap();
    chmod(&log, 0o644);
    chmod(&context, 0o644);
    chmod(&lock, 0o644);
    chmod(&f.data.join("logs"), 0o755);

    let changes = f.data().tighten(|| false);
    assert_eq!(changes.changed, 3);
    assert_eq!(changes.skipped, 3);
    assert_eq!(changes.links, 2);
    assert_eq!(changes.failed, 0);
    assert!(changes.first_link.unwrap().starts_with("logs"));
    assert_eq!(mode(&log), 0o600);
    assert_eq!(mode(&context), 0o600);
    assert_eq!(mode(&f.data.join("logs")), 0o700);
    assert_eq!(mode(&lock), 0o644);
    assert_eq!(mode(&outside), 0o755);
    assert_eq!(mode(&outsider), 0o644);
    assert_eq!(mode(&shared), 0o644);
    assert!(fs::symlink_metadata(f.data.join("logs/outside"))
        .unwrap()
        .is_symlink());
}

#[test]
fn doctor_manifest_is_current() {
    let metadata = ManifestMetadata::new(
        ModuleId::new(crate::MODULE_ID).unwrap(),
        "https://github.com/cortexkit/magic-context",
        vec![LogSource::new("logs/magic-context.*.log").unwrap()],
    );
    let (manifest, _) = generate(env!("CARGO_MANIFEST_DIR"), &metadata).unwrap();
    Manifest::decode(MANIFEST.as_bytes()).unwrap();
    assert!(
        manifest.to_canonical_bytes().unwrap() == MANIFEST.as_bytes(),
        "doctor manifest is stale; run cortexkit-log-manifest from crates/mc-module"
    );
}
