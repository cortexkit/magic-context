//! On-disk diagnostics that do not initialize the serving module.

mod files;
mod stores;
#[cfg(test)]
mod tests;

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{Duration, Instant};

use cortexkit_doctor::module::{self, CheckError, FixOutcome, PreflightError};
use cortexkit_doctor::{Evidence, EvidenceValue, Finding, FindingId, Fix, PathCategory, Severity};

const WALK_BUDGET: Duration = Duration::from_secs(4);
const FIX_BUDGET: Duration = Duration::from_secs(30);
const PRIVATE_ID: &str = "files.not_private";
const INCOMPLETE_ID: &str = "scan.incomplete";
const BACKUP_LIMIT: u64 = 2_000_000_000;
const WIRE_MAX_INTEGER: u64 = (1 << 53) - 1;

pub const MANIFEST: &str = include_str!("../../doctor-manifest.json");

pub fn run(args: &[OsString]) -> ExitCode {
    module::run(args, check, preflight, fix, MANIFEST)
}

fn data_home() -> Result<PathBuf, CheckError> {
    // The runner supplies this root. A fallback to the user's home or older
    // store overrides could inspect a different installation.
    cortexkit_paths::env_absolute_path(&cortexkit_paths::SystemEnv, "XDG_DATA_HOME")
        .map_err(|_| CheckError)?
        .ok_or(CheckError)
}

pub fn check() -> Result<Vec<Finding>, CheckError> {
    check_at(&data_home()?, Instant::now, crate::memory_writes::now_ms())
}

fn check_at(
    home: &Path,
    now: impl Fn() -> Instant,
    unix_ms: i64,
) -> Result<Vec<Finding>, CheckError> {
    let Some(data) = files::DataDir::open(home).map_err(|_| CheckError)? else {
        return Ok(Vec::new());
    };
    let mut findings = Vec::new();
    stores::check(&data, unix_ms, &mut findings);

    let deadline = now() + WALK_BUDGET;
    let private = data.permissions(|| now() >= deadline);
    let deadline = now() + WALK_BUDGET;
    let backups = data.backups(|| now() >= deadline);
    if let Some(path) = &private.first {
        let id = PRIVATE_ID.parse().expect("fixed finding id");
        let fix = Fix::safe(
            &id,
            false,
            vec!["Set Magic Context's stores, backups and logs to be readable only by you.".into()],
            FIX_BUDGET.as_millis() as u64,
        )
        .expect("fixed permission plan");
        findings.push(
            Finding::new(
                id,
                Severity::Warning,
                "Some Magic Context files or folders are readable by group or other users.",
                vec![
                    count("count", private.count),
                    path_evidence("path", &data, path),
                ],
                fix,
            )
            .expect("valid permission finding"),
        );
    }
    if backups.bytes > BACKUP_LIMIT {
        findings.push(finding(
            "backups.large",
            Severity::Info,
            "Magic Context's backups and specimens take up more than 2 GB.",
            vec![
                evidence(
                    "bytes",
                    EvidenceValue::Bytes(backups.bytes.min(WIRE_MAX_INTEGER)),
                ),
                count("count", backups.count),
            ],
        ));
    }
    let mut incomplete = Vec::new();
    for (name, walk) in [("permissions", private.walk), ("backups", backups.walk)] {
        if walk.incomplete {
            incomplete.push(code(&format!("{name}_walk"), name));
            incomplete.push(count(&format!("{name}_entries"), walk.examined));
        }
    }
    if !incomplete.is_empty() {
        incomplete.push(evidence(
            "budget_ms",
            EvidenceValue::DurationMs(WALK_BUDGET.as_secs_f64() * 1000.0),
        ));
        findings.push(finding(
            INCOMPLETE_ID,
            Severity::Info,
            "Magic Context could not finish looking through a folder within its time limit.",
            incomplete,
        ));
    }
    Ok(findings)
}

pub fn preflight(_finding: &Finding) -> Result<(), PreflightError> {
    // The permissions fix changes mode bits on owned descriptors, not data or
    // SQLite state. An open store needs no exclusion against those changes.
    Ok(())
}

pub fn fix(_confirmed: Finding) -> FixOutcome {
    let deadline = Instant::now() + FIX_BUDGET;
    let data = data_home().and_then(|home| files::DataDir::open(&home).map_err(|_| CheckError));
    let Ok(Some(data)) = data else {
        return FixOutcome::failed("data_dir_unavailable", Vec::new()).expect("fixed failure code");
    };
    let changes = data.tighten(|| Instant::now() >= deadline);
    let mut details = vec![
        count("changed_count", changes.changed),
        count("skipped_count", changes.skipped),
    ];
    if let Some(path) = changes.first_link {
        details.push(count("symlink_count", changes.links));
        details.push(path_evidence("first_symlink_path", &data, &path));
    }
    if changes.walk.incomplete || changes.failed > 0 {
        details.push(count("failed_count", changes.failed));
        let reason = if changes.walk.incomplete {
            "time_budget"
        } else {
            "chmod_failed"
        };
        FixOutcome::failed(reason, details).expect("valid permission fix failure")
    } else {
        FixOutcome::fixed(details).expect("valid permission fix result")
    }
}

fn finding(id: &str, severity: Severity, summary: &str, evidence: Vec<Evidence>) -> Finding {
    Finding::new(
        FindingId::new(id).expect("fixed finding id"),
        severity,
        summary,
        evidence,
        Fix::none(false),
    )
    .expect("valid built-in finding")
}

fn evidence(name: &str, value: EvidenceValue) -> Evidence {
    Evidence::new(name, value).expect("valid built-in evidence")
}

fn code(name: &str, value: &str) -> Evidence {
    evidence(name, EvidenceValue::Code(value.into()))
}

fn count(name: &str, n: u64) -> Evidence {
    evidence(name, EvidenceValue::Count(n.min(WIRE_MAX_INTEGER)))
}

fn path_evidence(name: &str, data: &files::DataDir, relative: &Path) -> Evidence {
    let path = data.path.join(relative).to_string_lossy().into_owned();
    // A non-UTF-8 filename can grow when rendered. Retain the data-relative
    // spelling if the rendered absolute path exceeds the 4096-byte path limit.
    let value = |path| EvidenceValue::Path {
        category: PathCategory::Data,
        path,
    };
    Evidence::new(name, value(path)).unwrap_or_else(|_| {
        Evidence::new(name, value(relative.to_string_lossy().into_owned()))
            .unwrap_or_else(|_| evidence(name, value(crate::storage_paths::MODULE_DIR.into())))
    })
}
