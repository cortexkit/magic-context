//! Project-scoped schedules live outside the session's context.db. Advancing a
//! background schedule must not invalidate the prompt cache used by serving.

use super::cron;
use crate::parity_schema_manifest::BackgroundTask;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TaskName {
    #[serde(rename = "map-memories")]
    Map,
    #[serde(rename = "verify")]
    Verify,
    #[serde(rename = "verify-broad")]
    VerifyBroad,
    #[serde(rename = "curate")]
    Curate,
    #[serde(rename = "compress-cues")]
    CompressCues,
    #[serde(rename = "classify-memories")]
    Classify,
    #[serde(rename = "retrospective")]
    Retrospective,
    #[serde(rename = "maintain-docs")]
    MaintainDocs,
    #[serde(rename = "evaluate-smart-notes")]
    EvaluateSmartNotes,
    #[serde(rename = "review-user-memories")]
    ReviewUserMemories,
    #[serde(rename = "promote-primers")]
    PromotePrimers,
    #[serde(rename = "refresh-primers")]
    RefreshPrimers,
}

pub const CANONICAL_TASKS: [TaskName; 12] = [
    TaskName::Map,
    TaskName::Verify,
    TaskName::VerifyBroad,
    TaskName::Curate,
    TaskName::CompressCues,
    TaskName::Classify,
    TaskName::Retrospective,
    TaskName::MaintainDocs,
    TaskName::EvaluateSmartNotes,
    TaskName::ReviewUserMemories,
    TaskName::PromotePrimers,
    TaskName::RefreshPrimers,
];

impl TaskName {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Map => "map-memories",
            Self::Verify => "verify",
            Self::VerifyBroad => "verify-broad",
            Self::Curate => "curate",
            Self::CompressCues => "compress-cues",
            Self::Classify => "classify-memories",
            Self::Retrospective => "retrospective",
            Self::MaintainDocs => "maintain-docs",
            Self::EvaluateSmartNotes => "evaluate-smart-notes",
            Self::ReviewUserMemories => "review-user-memories",
            Self::PromotePrimers => "promote-primers",
            Self::RefreshPrimers => "refresh-primers",
        }
    }

    pub fn lease_key(self, project: &str) -> String {
        let kind = match self {
            Self::ReviewUserMemories => return "user-memories".into(),
            Self::MaintainDocs => "maintain-docs",
            Self::EvaluateSmartNotes => "evaluate-smart-notes",
            _ => "memory",
        };
        format!("{kind}:{project}")
    }

    pub fn default_budget(self) -> Option<u64> {
        match self {
            Self::Map | Self::Verify => Some(2_500_000),
            Self::VerifyBroad => Some(3_000_000),
            Self::Curate => Some(1_500_000),
            Self::Retrospective => Some(300_000),
            Self::MaintainDocs => Some(1_600_000),
            Self::RefreshPrimers => Some(350_000),
            _ => None,
        }
    }

    pub(super) fn matches(self, task: &BackgroundTask) -> bool {
        match self {
            Self::Map => *task == BackgroundTask::Map,
            Self::Verify | Self::VerifyBroad => *task == BackgroundTask::Verify,
            Self::Curate => *task == BackgroundTask::Curate,
            Self::CompressCues => *task == BackgroundTask::CompressMuralCues,
            Self::Classify => *task == BackgroundTask::Classify,
            Self::Retrospective => *task == BackgroundTask::Retrospective,
            Self::MaintainDocs => *task == BackgroundTask::MaintainDocs,
            Self::EvaluateSmartNotes => *task == BackgroundTask::EvaluateSmartNotes,
            Self::ReviewUserMemories => *task == BackgroundTask::ReviewUserMemories,
            Self::PromotePrimers | Self::RefreshPrimers => *task == BackgroundTask::Primers,
        }
    }

    pub(super) fn from_background(task: &BackgroundTask) -> Option<Self> {
        CANONICAL_TASKS.into_iter().find(|name| name.matches(task))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskConfig {
    pub task: TaskName,
    pub schedule: String,
    /// Whether any input exists to justify seeding a schedule row. A separate
    /// activity check decides whether that input needs work at the scheduled time.
    pub has_input: bool,
    pub legacy_last_run_at: Option<i64>,
}

/// The schedule fields of the TypeScript dreamer's `task_schedule_state` row for
/// one project and task. The TypeScript scheduler runs a task only once
/// `next_due_at` has passed and moves it past the slot it ran, so the later of the
/// two runtimes' `next_due_at` values is the progress both must respect.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacySchedule {
    pub last_run_at: Option<i64>,
    pub next_due_at: Option<i64>,
    pub schedule: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Completed,
    Failed,
    Skipped,
}

impl RunStatus {
    /// The spelling both schedulers store in `last_status`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Skipped => "skipped",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScheduleState {
    pub schedule: Option<String>,
    pub last_run_at: Option<i64>,
    pub next_due_at: Option<i64>,
    pub last_status: Option<RunStatus>,
    pub last_error: Option<String>,
    pub retry_count: u32,
    pub task_state_json: Option<String>,
    pub retrospective_watermark_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inputs_watermark: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_skip_code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DueTask {
    pub task: TaskName,
    pub scheduled_at: i64,
}

#[derive(Debug, Clone)]
pub struct RunOutcome {
    pub status: RunStatus,
    pub transient: bool,
    pub error: Option<String>,
    pub task_state_json: Option<String>,
    pub retrospective_watermark_ms: Option<Option<i64>>,
    pub inputs_watermark: Option<serde_json::Value>,
    pub last_skip_code: Option<String>,
}

impl RunOutcome {
    pub fn new(status: RunStatus) -> Self {
        Self {
            status,
            transient: false,
            error: None,
            task_state_json: None,
            retrospective_watermark_ms: None,
            inputs_watermark: None,
            last_skip_code: None,
        }
    }
}

pub(super) fn read(
    db: &Connection,
    project: &str,
    task: TaskName,
) -> rusqlite::Result<Option<ScheduleState>> {
    let json: Option<String> = db
        .query_row(
            "SELECT state FROM dream_schedules WHERE project=?1 AND task=?2",
            params![project, task.as_str()],
            |r| r.get(0),
        )
        .optional()?;
    json.map(|j| serde_json::from_str(&j).map_err(|_| rusqlite::Error::InvalidQuery))
        .transpose()
}

pub(super) fn write(
    db: &Connection,
    project: &str,
    task: TaskName,
    state: &ScheduleState,
) -> rusqlite::Result<()> {
    let json = serde_json::to_string(state).map_err(|_| rusqlite::Error::InvalidQuery)?;
    db.execute("INSERT INTO dream_schedules(project,task,state) VALUES(?1,?2,?3) ON CONFLICT(project,task) DO UPDATE SET state=excluded.state", params![project, task.as_str(), json])?;
    Ok(())
}

pub(super) fn seeded(config: &TaskConfig, candidate: Option<i64>) -> ScheduleState {
    ScheduleState {
        schedule: Some(config.schedule.clone()),
        last_run_at: config.legacy_last_run_at.filter(|n| *n != 0),
        next_due_at: candidate,
        last_status: None,
        last_error: None,
        retry_count: 0,
        task_state_json: None,
        retrospective_watermark_ms: None,
        inputs_watermark: None,
        last_skip_code: None,
    }
}

pub(super) fn reconcile(
    state: &mut ScheduleState,
    config: &TaskConfig,
    candidate: Option<i64>,
    after_repeated: Option<i64>,
    repeated: bool,
) {
    if state.schedule.as_deref() == Some(&config.schedule) {
        return;
    }
    if state.schedule.is_none() && state.next_due_at.is_some() {
        state.schedule = Some(config.schedule.clone());
        return;
    }
    let candidate = if repeated
        && candidate.is_some()
        && state.next_due_at > candidate
        && state.last_status.is_some()
    {
        after_repeated
    } else {
        candidate
    };
    let next = match (state.next_due_at, candidate) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    };
    if next != state.next_due_at {
        state.retry_count = 0
    }
    state.next_due_at = next;
    state.schedule = Some(config.schedule.clone());
}

pub(super) fn advance(
    state: &mut ScheduleState,
    outcome: &RunOutcome,
    started: i64,
    finished: i64,
    scheduled: i64,
) -> rusqlite::Result<()> {
    let schedule = state.schedule.as_deref().unwrap_or("");
    let retries = state.retry_count.saturating_add(1);
    if outcome.status == RunStatus::Failed && outcome.transient && retries <= 3 {
        state.retry_count = retries;
        state.next_due_at = if schedule.trim().is_empty() {
            None
        } else {
            state.next_due_at.or(Some(scheduled))
        };
    } else {
        state.next_due_at = cron::next_due(schedule, finished, Some(scheduled))?;
        state.retry_count = 0;
    }
    if outcome.status == RunStatus::Completed {
        state.last_run_at = Some(started);
        if let Some(watermark) = &outcome.inputs_watermark {
            state.inputs_watermark = Some(watermark.clone());
        }
    }
    state.last_skip_code = outcome.last_skip_code.clone();
    state.last_status = Some(outcome.status);
    state.last_error = outcome.error.clone();
    // Skip outcomes do not publish executor cursors, even if a caller supplies one.
    if outcome.status != RunStatus::Skipped {
        if let Some(value) = &outcome.task_state_json {
            state.task_state_json = Some(value.clone())
        }
        if let Some(value) = outcome.retrospective_watermark_ms {
            state.retrospective_watermark_ms = value
        }
    }
    Ok(())
}

/// Nonblocking manual-run wait policy. The runner retries acquisition after this
/// delay; scheduled ticks never wait, and the store itself never sleeps.
pub struct ManualLeaseWait {
    deadline_ms: i64,
}
pub const MANUAL_RUN_LEASE_WAIT_MS: i64 = 60_000;
pub const LEASE_WAIT_POLL_MS: u64 = 2_000;
impl ManualLeaseWait {
    pub fn new(started_at_ms: i64) -> Self {
        Self {
            deadline_ms: started_at_ms.saturating_add(MANUAL_RUN_LEASE_WAIT_MS),
        }
    }
    pub fn retry_delay_ms(&self, now_ms: i64) -> Option<u64> {
        (now_ms < self.deadline_ms).then_some(LEASE_WAIT_POLL_MS)
    }
}
