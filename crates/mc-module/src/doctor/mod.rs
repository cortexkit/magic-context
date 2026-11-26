//! On-disk diagnostics that do not initialize the serving module.

mod files;
mod stores;
#[cfg(test)]
mod tests;

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;
use std::time::{Duration, Instant};

use cortexkit_doctor::module::{self, CheckError, FixOutcome, PreflightError};
use cortexkit_doctor::{
    Evidence, EvidenceValue, Finding, FindingId, Fix, Mode, PathCategory, Severity,
};

const WALK_BUDGET: Duration = Duration::from_secs(4);
const CHECK_BUDGET: Duration = Duration::from_secs(8);
// The serving parser has no cap: completed move records are kept indefinitely,
// so a large journal can be valid even when the quick check skips it.
const JOURNAL_LIMIT: u64 = 4 * 1024 * 1024;
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
    // `ck doctor` starts this program with a cleared environment and passes
    // the data home in XDG_DATA_HOME. Falling back to HOME, or honouring the
    // MAGIC_CONTEXT_* path variables the serving module reads, could make a
    // check inspect a different installation than the one it was asked about.
    cortexkit_paths::env_absolute_path(&cortexkit_paths::SystemEnv, "XDG_DATA_HOME")
        .map_err(|_| CheckError)?
        .ok_or(CheckError)
}

pub fn check(mode: Mode) -> Result<Vec<Finding>, CheckError> {
    let budget = Budget::new(mode, Instant::now);
    Ok(check_at(
        &data_home()?,
        &budget,
        crate::memory_writes::now_ms(),
    ))
}

#[derive(Clone)]
struct Budget {
    now: Arc<dyn Fn() -> Instant + Send + Sync>,
    limits: Option<QuickLimits>,
}

#[derive(Clone, Copy)]
struct QuickLimits {
    deadline: Instant,
    walk: Duration,
    journal_bytes: u64,
}

impl Budget {
    fn new(mode: Mode, now: impl Fn() -> Instant + Send + Sync + 'static) -> Self {
        let limits = match mode {
            Mode::Quick => Some(QuickLimits {
                deadline: now() + CHECK_BUDGET,
                walk: WALK_BUDGET,
                journal_bytes: JOURNAL_LIMIT,
            }),
            // Full mode lifts the quick limits; the deep store inspection is not implemented yet.
            Mode::Full => None,
        };
        Self {
            now: Arc::new(now),
            limits,
        }
    }

    fn expired(&self) -> bool {
        self.expired_at(self.limits.map(|limits| limits.deadline))
    }

    fn expired_at(&self, deadline: Option<Instant>) -> bool {
        deadline.is_some_and(|deadline| (self.now)() >= deadline)
    }

    fn walk_deadline(&self) -> Option<Instant> {
        self.limits
            .map(|limits| ((self.now)() + limits.walk).min(limits.deadline))
    }

    fn journal_limit(&self) -> Option<u64> {
        self.limits.map(|limits| limits.journal_bytes)
    }
}

fn check_at(home: &Path, budget: &Budget, unix_ms: i64) -> Vec<Finding> {
    let data = match files::DataDir::open(home) {
        Ok(Some(data)) => data,
        Ok(None) => return Vec::new(),
        Err(_) => {
            return vec![incomplete_finding(
                vec![
                    code("stores_phase", "stores"),
                    count("stores_open_failed_count", 1),
                ],
                budget,
            )]
        }
    };
    let mut findings = Vec::new();
    let store_scan = stores::check(&data, unix_ms, budget, &mut findings);
    let mut incomplete = store_scan.evidence();
    scan_walks(&data, budget, &mut findings, &mut incomplete);
    if !incomplete.is_empty() {
        findings.push(incomplete_finding(incomplete, budget));
    }
    findings
}

fn scan_walks(
    data: &files::DataDir,
    budget: &Budget,
    findings: &mut Vec<Finding>,
    incomplete: &mut Vec<Evidence>,
) {
    let deadline = budget.walk_deadline();
    let private = data.permissions(nix::unistd::geteuid().as_raw(), || {
        budget.expired_at(deadline)
    });
    let deadline = budget.walk_deadline();
    let backups = data.backups(|| budget.expired_at(deadline));
    if let Some(finding) = permission_finding(data, &private) {
        findings.push(finding);
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
    for (name, walk) in [("permissions", private.walk), ("backups", backups.walk)] {
        if walk.timed_out || walk.open_failed + walk.list_failed > 0 {
            incomplete.push(code(&format!("{name}_walk"), name));
            incomplete.push(count(&format!("{name}_entries"), walk.examined));
            incomplete.push(count(
                &format!("{name}_unreadable_count"),
                walk.open_failed + walk.list_failed,
            ));
            if walk.timed_out {
                incomplete.push(evidence(
                    &format!("{name}_timed_out"),
                    EvidenceValue::Bool(true),
                ));
            }
        }
    }
}

fn incomplete_finding(mut details: Vec<Evidence>, budget: &Budget) -> Finding {
    let duration = |name, duration: Duration| {
        evidence(
            name,
            EvidenceValue::DurationMs(duration.as_secs_f64() * 1000.0),
        )
    };
    if let Some(limits) = budget.limits {
        details.push(duration("check_budget_ms", CHECK_BUDGET));
        details.push(duration("walk_budget_ms", limits.walk));
    }
    finding(
        INCOMPLETE_ID,
        Severity::Info,
        "Magic Context could not finish checking some of its files.",
        details,
    )
}

fn permission_finding(data: &files::DataDir, private: &files::PermissionScan) -> Option<Finding> {
    let path = private.first.as_ref()?;
    let id = PRIVATE_ID.parse().expect("fixed finding id");
    let (summary, fix) = if private.fixable == 0 {
        (
            "Some Magic Context files or folders are readable by group or other users and need a change by hand.",
            Fix::none(false),
        )
    } else {
        let fix = Fix::safe(
            &id,
            false,
            vec!["Remove group and other permissions from Magic Context's stores, backups and logs where safe.".into()],
            FIX_BUDGET.as_millis() as u64,
        ).expect("fixed permission plan");
        (
            "Some Magic Context files or folders are readable by group or other users.",
            fix,
        )
    };
    Some(
        Finding::new(
            id,
            Severity::Warning,
            summary,
            vec![
                count("fixable_count", private.fixable),
                count(
                    "not_fixable_count",
                    private.other_owner + private.multiple_links,
                ),
                count("other_owner_count", private.other_owner),
                count("multiple_links_count", private.multiple_links),
                path_evidence("path", data, path),
            ],
            fix,
        )
        .expect("valid permission finding"),
    )
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
        return FixOutcome::failed("open_failed", Vec::new()).expect("fixed failure code");
    };
    let changes = data.tighten(nix::unistd::geteuid().as_raw(), || {
        Instant::now() >= deadline
    });
    fix_outcome(&data, changes)
}

fn fix_outcome(data: &files::DataDir, changes: files::Changes) -> FixOutcome {
    let mut details = vec![
        count("changed_count", changes.changed),
        count("skipped_count", changes.skipped),
    ];
    if let Some(path) = changes.first_link {
        details.push(count("symlink_count", changes.links));
        details.push(path_evidence("first_symlink_path", data, &path));
    }
    let open_failed = changes.open_failed + changes.walk.open_failed;
    let reason = [
        (changes.walk.timed_out, "time_budget"),
        (open_failed > 0, "open_failed"),
        (changes.walk.list_failed > 0, "list_failed"),
        (changes.mode_failed > 0, "chmod_failed"),
    ]
    .into_iter()
    .find_map(|(failed, code)| failed.then_some(code));
    if let Some(reason) = reason {
        details.extend([
            count("open_failed_count", open_failed),
            count("list_failed_count", changes.walk.list_failed),
            count("chmod_failed_count", changes.mode_failed),
        ]);
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
    // Lossy UTF-8 rendering can exceed the wire's 4096-byte path limit. Try
    // the relative path, then give the containing module directory instead
    // of attempting to put a truncated filename in the report.
    let value = |path| EvidenceValue::Path {
        category: PathCategory::Data,
        path,
    };
    Evidence::new(name, value(path)).unwrap_or_else(|_| {
        Evidence::new(name, value(relative.to_string_lossy().into_owned()))
            .unwrap_or_else(|_| evidence(name, value(crate::storage_paths::MODULE_DIR.into())))
    })
}
