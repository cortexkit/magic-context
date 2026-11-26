use std::fs::{self, File};
use std::os::unix::fs::{symlink, PermissionsExt};
use std::sync::atomic::{AtomicU32, Ordering};

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
        check_at(
            self.home.path(),
            &Budget::new(Mode::Quick, Instant::now),
            NOW,
        )
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
    assert!(check_at(home.path(), &Budget::new(Mode::Quick, Instant::now), NOW).is_empty());
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
    for suffix in files::SIDECARS {
        let f = Fixture::healthy();
        fs::write(f.data.join(files::sidecar(CONTEXT_DB, suffix)), []).unwrap();
        fs::write(f.data.join(files::sidecar(SESSION_DB, suffix)), []).unwrap();
        let findings = f.findings();
        let evidence = expect(&findings, "store.in_use", Severity::Info);
        assert_eq!(evidence["context_store"], "context");
        assert_eq!(evidence["sessions_store"], "sessions");
        assert!(evidence[format!("context_{suffix}")]["path"]
            .as_str()
            .unwrap()
            .ends_with(&format!("{CONTEXT_DB}-{suffix}")));
        assert!(evidence[format!("sessions_{suffix}")]["path"]
            .as_str()
            .unwrap()
            .ends_with(&format!("{SESSION_DB}-{suffix}")));
        if suffix == "wal" {
            assert_eq!(evidence["sessions_version_may_be_stale"], true);
        }
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
    assert_eq!(evidence["fixable_count"], 2);
    assert_eq!(evidence["not_fixable_count"], 0);
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
    conn.execute("UPDATE replica_state SET joined_at = 1, held_epoch = 7, held_since = ?1, held_why = 'PRIVATE_HOLD_CANARY' WHERE id = 1", [NOW - 3_600_000]).unwrap();
    conn.execute_batch("INSERT INTO replica_outbox(kind, local_id, revision, base_revision, change, created_at, state, actor) VALUES
        ('memory', 1, 1, 0, 'create', 0, 'pending', 'PRIVATE_ACTOR_CANARY'),
        ('memory', 2, 1, 0, 'create', 0, 'sending', 'PRIVATE_ACTOR_CANARY'),
        ('memory', 3, 1, 0, 'create', 0, 'published', 'PRIVATE_ACTOR_CANARY'),
        ('memory', 4, 1, 0, 'create', 0, 'too_large', 'PRIVATE_ACTOR_CANARY'),
        ('memory', 5, 1, 0, 'create', 0, 'unaddressable', 'PRIVATE_ACTOR_CANARY');").unwrap();
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
    let tick = AtomicU32::new(0);
    let budget = Budget::new(Mode::Quick, move || {
        start + CHECK_BUDGET * tick.fetch_add(1, Ordering::Relaxed)
    });
    let findings = check_at(f.home.path(), &budget, NOW);
    assert_eq!(findings.len(), 1);
    let e = expect(&findings, INCOMPLETE_ID, Severity::Info);
    assert_eq!(e["permissions_walk"], "permissions");
    assert_eq!(e["permissions_entries"], 0);
    assert_eq!(e["backups_walk"], "backups");
    assert_eq!(e["backups_entries"], 0);
    assert_eq!(e["stores_phase"], "stores");
    assert_eq!(e["stores_timed_out"], true);
    assert_eq!(e["check_budget_ms"], 8000.0);
    assert_eq!(e["walk_budget_ms"], 4000.0);
    CheckOutput::new(findings).unwrap();
}

#[test]
fn budget_preserves_a_permission_finding_proven_before_the_cutoff() {
    let f = Fixture::healthy();
    chmod(&f.data.join(CONTEXT_DB), 0o644);
    let start = Instant::now();
    let tick = AtomicU32::new(0);
    let budget = Budget::new(Mode::Quick, move || {
        if tick.fetch_add(1, Ordering::Relaxed) < 3 {
            start
        } else {
            start + WALK_BUDGET
        }
    });
    let mut findings = Vec::new();
    let mut incomplete = Vec::new();
    scan_walks(&f.data(), &budget, &mut findings, &mut incomplete);
    findings.push(incomplete_finding(incomplete, &budget));
    assert_eq!(findings.len(), 2);
    assert_eq!(
        expect(&findings, PRIVATE_ID, Severity::Warning)["fixable_count"],
        1
    );
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

    let changes = f.data().tighten(nix::unistd::geteuid().as_raw(), || false);
    assert_eq!(changes.changed, 3);
    assert_eq!(changes.skipped, 3);
    assert_eq!(changes.links, 2);
    assert_eq!(changes.open_failed + changes.mode_failed, 0);
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

#[test]
fn check_after_fix_leaves_only_a_manual_finding_for_a_hard_link() {
    let f = Fixture::healthy();
    let normal = f.data.join("logs/ordinary");
    let outside = f.home.path().join("outside");
    for file in [&normal, &outside] {
        File::create(file).unwrap();
        chmod(file, 0o644);
    }
    fs::hard_link(&outside, f.data.join("backups/alias")).unwrap();
    let before = f.findings();
    let e = expect(&before, PRIVATE_ID, Severity::Warning);
    assert_eq!(e["fixable_count"], 1);
    assert_eq!(e["not_fixable_count"], 1);
    assert_eq!(e["multiple_links_count"], 1);
    assert_eq!(before[0].fix().class(), FixClass::Safe);

    let changes = f.data().tighten(nix::unistd::geteuid().as_raw(), || false);
    assert_eq!(changes.changed, 1);
    assert_eq!((mode(&normal), mode(&outside)), (0o600, 0o644));
    let after = f.findings();
    let e = expect(&after, PRIVATE_ID, Severity::Warning);
    assert_eq!(e["fixable_count"], 0);
    assert_eq!(e["not_fixable_count"], 1);
    assert_eq!(e["multiple_links_count"], 1);
    assert_eq!(after[0].fix().class(), FixClass::None);
    assert!(after[0].summary().contains("need a change by hand"));
}

#[test]
fn check_after_fix_never_offers_to_change_another_owners_file() {
    let f = Fixture::healthy();
    let path = f.data.join("logs/owned-by-someone-else");
    File::create(&path).unwrap();
    chmod(&path, 0o644);
    let data = f.data();
    // Supply a different effective UID to exercise real inode ownership
    // without needing root to change the fixture's Unix owner.
    let uid = nix::unistd::geteuid().as_raw().wrapping_add(1);
    let check = || permission_finding(&data, &data.permissions(uid, || false)).unwrap();
    assert_eq!(check().fix().class(), FixClass::None);
    assert_eq!(data.tighten(uid, || false).changed, 0);
    let after = check();
    let e = expect(&[after], PRIVATE_ID, Severity::Warning);
    assert_eq!(e["fixable_count"], 0);
    assert_eq!(e["other_owner_count"], 1);
    assert_eq!(e["not_fixable_count"], 1);
    assert_eq!(mode(&path), 0o644);
}

#[test]
fn permissions_fix_preserves_setuid_setgid_and_sticky_bits() {
    let f = Fixture::healthy();
    let dir = f.data.join("logs/special");
    fs::create_dir(&dir).unwrap();
    let file = dir.join("setuid");
    File::create(&file).unwrap();
    chmod(&dir, 0o3775);
    chmod(&file, 0o4744);
    let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o7777;
    assert_eq!((mode(&dir), mode(&file)), (0o3775, 0o4744));
    assert_eq!(
        f.data()
            .tighten(nix::unistd::geteuid().as_raw(), || false)
            .changed,
        2
    );
    assert_eq!((mode(&dir), mode(&file)), (0o3700, 0o4700));
}

#[test]
fn permission_fix_failure_codes_identify_open_list_and_chmod() {
    let f = Fixture::healthy();
    let data = f.data();
    for (open, list, chmod, code) in [
        (1, 0, 0, "open_failed"),
        (0, 1, 0, "list_failed"),
        (0, 0, 1, "chmod_failed"),
    ] {
        let changes = files::Changes {
            open_failed: open,
            mode_failed: chmod,
            walk: files::Walk {
                list_failed: list,
                ..Default::default()
            },
            ..Default::default()
        };
        assert_eq!(
            fix_outcome(&data, changes),
            FixOutcome::failed(
                code,
                vec![
                    count("changed_count", 0),
                    count("skipped_count", 0),
                    count("open_failed_count", open),
                    count("list_failed_count", list),
                    count("chmod_failed_count", chmod)
                ]
            )
            .unwrap()
        );
    }
}

#[test]
fn unlistable_folder_marks_the_walk_incomplete_and_fix_open_failure() {
    if nix::unistd::geteuid().is_root() {
        // Root can list a directory despite the fixture's missing read bit.
        return;
    }
    let f = Fixture::healthy();
    let dir = f.data.join("logs/unlistable");
    fs::create_dir(&dir).unwrap();
    let file = dir.join("loose");
    File::create(&file).unwrap();
    chmod(&file, 0o644);
    chmod(&dir, 0o300);
    let findings = f.findings();
    let data = f.data();
    let changes = data.tighten(nix::unistd::geteuid().as_raw(), || false);
    chmod(&dir, 0o700);
    let e = expect(&findings, INCOMPLETE_ID, Severity::Info);
    assert_eq!(e["permissions_unreadable_count"], 1);
    assert!(e["permissions_timed_out"].is_null());
    assert_eq!(changes.walk.open_failed, 1);
    assert_eq!(changes.changed, 0);
    assert_eq!(mode(&file), 0o644);
}

#[test]
fn linked_directory_components_are_refused_before_opening_their_target() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::create_dir(outside.path().join(MODULE_DIR)).unwrap();
    symlink(outside.path(), root.path().join("cortexkit")).unwrap();
    assert!(
        files::DataDir::open(root.path()).is_err(),
        "opening the fleet root followed a symlink"
    );
    fs::remove_file(root.path().join("cortexkit")).unwrap();
    fs::create_dir(root.path().join("cortexkit")).unwrap();
    symlink(
        outside.path().join(MODULE_DIR),
        root.path().join("cortexkit").join(MODULE_DIR),
    )
    .unwrap();
    assert!(
        files::DataDir::open(root.path()).is_err(),
        "opening the module root followed a symlink"
    );
}

#[test]
fn zero_byte_store_files_are_empty_not_unreadable() {
    let f = Fixture::new();
    for name in [CONTEXT_DB, SESSION_DB] {
        let path = f.data.join(name);
        File::create(&path).unwrap();
        chmod(&path, 0o600);
        assert_eq!(stores::header(&f.data(), name).unwrap(), None);
    }
    assert!(f.findings().is_empty());
}

#[test]
fn rollback_journal_blocks_even_the_immutable_connection_open() {
    let f = Fixture::healthy();
    let journal = files::sidecar(CONTEXT_DB, "journal");
    fs::write(f.data.join(&journal), []).unwrap();
    let mut findings = Vec::new();
    let budget = Budget::new(Mode::Quick, Instant::now);
    let scan = stores::check_with_open(&f.data(), NOW, &budget, &mut findings, |_| {
        panic!("SQLite opened with a rollback journal")
    });
    assert!(scan.evidence().is_empty());
    let e = expect(&findings, "store.in_use", Severity::Info);
    assert!(e["context_journal"]["path"]
        .as_str()
        .unwrap()
        .ends_with(&journal.to_string_lossy().into_owned()));
}

#[test]
fn a_sidecar_created_during_open_prevents_the_ledger_read() {
    let f = Fixture::healthy();
    f.context().execute("INSERT INTO schema_migrations(version, description, applied_at) VALUES (?1, 'future schema', 0)", [SCHEMA_VERSION + 1]).unwrap();
    let mut findings = Vec::new();
    let budget = Budget::new(Mode::Quick, Instant::now);
    let scan = stores::check_with_open(&f.data(), NOW, &budget, &mut findings, |path| {
        let conn = stores::immutable(path)?;
        fs::write(f.data.join(files::sidecar(CONTEXT_DB, "wal")), []).unwrap();
        Ok(conn)
    });
    assert!(scan.evidence().is_empty());
    assert_eq!(
        findings.len(),
        1,
        "SQL ran despite a sidecar appearing during open: {findings:?}"
    );
    assert_eq!(findings[0].id().as_str(), "store.in_use");
}

#[test]
fn an_over_limit_move_journal_reports_size_and_incomplete_not_corruption() {
    let f = Fixture::healthy();
    let path = journal::path(&f.data.join(CONTEXT_DB));
    let mut contents = fs::read(&path).unwrap();
    contents.resize(JOURNAL_LIMIT as usize, b' ');
    fs::write(&path, &contents).unwrap();
    assert!(f.findings().is_empty(), "the cap itself is inclusive");
    contents.push(b' ');
    fs::write(&path, &contents).unwrap();
    let findings = f.findings();
    assert_eq!(findings.len(), 1);
    let e = expect(&findings, INCOMPLETE_ID, Severity::Info);
    assert_eq!(e["stores_phase"], "stores");
    assert_eq!(e["journal_reason"], "journal_size_limit");
    assert_eq!(e["journal_bytes"], JOURNAL_LIMIT + 1);

    let full = Budget::new(Mode::Full, Instant::now);
    assert!(check_at(f.home.path(), &full, NOW).is_empty());
    // Put the parse error after the quick limit, not in the bytes quick read.
    *contents.last_mut().unwrap() = b'!';
    fs::write(&path, contents).unwrap();
    let full_findings = check_at(f.home.path(), &full, NOW);
    assert_eq!(full_findings.len(), 1);
    expect(&full_findings, "moves.journal_unreadable", Severity::Error);
    expect(&f.findings(), INCOMPLETE_ID, Severity::Info);
}

#[test]
fn sqlite_progress_handler_interrupts_a_query_when_the_overall_deadline_hits() {
    let start = Instant::now();
    let tick = AtomicU32::new(0);
    let budget = Budget::new(Mode::Quick, move || {
        let n = tick.fetch_add(1, Ordering::Relaxed);
        start + if n > 2 { CHECK_BUDGET } else { Duration::ZERO }
    });
    let conn = Connection::open_in_memory().unwrap();
    let query = |conn: &Connection| {
        conn.query_row("WITH RECURSIVE count(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM count WHERE x < 100000) SELECT sum(x) FROM count", [], |row| row.get::<_, i64>(0))
    };
    stores::attach_progress_handler(&conn, &budget);
    let error = query(&conn).unwrap_err();
    assert_eq!(
        error.sqlite_error_code(),
        Some(rusqlite::ErrorCode::OperationInterrupted)
    );
    let conn = Connection::open_in_memory().unwrap();
    let full = Budget::new(Mode::Full, || panic!("full mode consulted the quick clock"));
    stores::attach_progress_handler(&conn, &full);
    assert_eq!(query(&conn).unwrap(), 5_000_050_000);
}

fn record_project_memory(conn: &Connection, owner: &str, content: &str) {
    conn.execute(
        "INSERT INTO memories(level, owner_id, category, origin_category, content,
             normalized_hash, first_seen_at, created_at, updated_at, last_seen_at)
         VALUES ('project', ?1, 'swe:architecture', 'ARCHITECTURE', ?2, ?3, 1, 1, 1, 1)",
        rusqlite::params![
            owner,
            content,
            crate::memory_writes::normalized_hash(content)
        ],
    )
    .unwrap();
}

#[test]
fn unsent_excludes_local_only_project_rows_even_after_joining() {
    let f = Fixture::healthy();
    let conn = f.context();
    conn.execute("UPDATE replica_state SET joined_at = 1 WHERE id = 1", [])
        .unwrap();
    record_project_memory(&conn, "pj-a", "addressable memory");
    record_project_memory(&conn, "/legacy/path", "local memory");
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM replica_outbox WHERE state = 'pending'",
            [],
            |r| r.get::<_, u64>(0)
        )
        .unwrap(),
        2
    );
    drop(conn);
    assert_eq!(
        expect(&f.findings(), "sharing.unsent", Severity::Info)["count"],
        1
    );
}

#[test]
fn a_never_joined_install_does_not_report_its_captured_outbox() {
    let f = Fixture::healthy();
    let conn = f.context();
    record_project_memory(&conn, "pj-a", "memory before sharing");
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM replica_outbox WHERE state = 'pending'",
            [],
            |r| r.get::<_, u64>(0)
        )
        .unwrap(),
        1
    );
    drop(conn);
    assert!(
        f.findings().is_empty(),
        "no other computer was configured to receive the changes"
    );
}

#[test]
fn walks_get_only_the_time_remaining_after_store_work() {
    let f = Fixture::healthy();
    chmod(&f.data.join(CONTEXT_DB), 0o644);
    let start = Instant::now();
    let tick = AtomicU32::new(0);
    let budget = Budget::new(Mode::Quick, move || {
        match tick.fetch_add(1, Ordering::Relaxed) {
            0 => start,
            1 => start + CHECK_BUDGET - Duration::from_millis(500),
            _ => start + CHECK_BUDGET,
        }
    });
    let mut findings = Vec::new();
    let mut incomplete = Vec::new();
    scan_walks(&f.data(), &budget, &mut findings, &mut incomplete);
    assert!(
        findings.is_empty(),
        "the permissions walk continued beyond the overall deadline"
    );
    let e = expect(
        &[incomplete_finding(incomplete, &budget)],
        INCOMPLETE_ID,
        Severity::Info,
    );
    assert_eq!(e["permissions_timed_out"], true);
    assert_eq!(e["backups_timed_out"], true);
    assert_eq!(e["permissions_entries"], 0);
    assert_eq!(e["backups_entries"], 0);
}

#[test]
fn full_check_never_consults_the_quick_clock_and_still_completes_both_walks() {
    let f = Fixture::healthy();
    chmod(&f.data.join(CONTEXT_DB), 0o644);
    let backup = f.data.join("backups/large");
    File::create(&backup)
        .unwrap()
        .set_len(BACKUP_LIMIT + 1)
        .unwrap();
    chmod(&backup, 0o644);
    let budget = Budget::new(Mode::Full, || panic!("full mode consulted the quick clock"));
    let findings = check_at(f.home.path(), &budget, NOW);
    assert_eq!(findings.len(), 2);
    assert_eq!(
        expect(&findings, PRIVATE_ID, Severity::Warning)["fixable_count"],
        2
    );
    assert_eq!(
        expect(&findings, "backups.large", Severity::Info)["bytes"],
        BACKUP_LIMIT + 1
    );
}
