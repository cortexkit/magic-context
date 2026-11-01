//! Trusted inputs captured once by the off-thread dispatcher.

use crate::dream_runner::Usage;
use crate::McModuleConfig;
use mc_store::dream_domain::DreamDomainLease;
use mc_store::dream_scheduler::{budget::BudgetAction, schedules::TaskName};
use mc_store::parity_schema_manifest::{DreamLease, StoreScope};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ControlError {
    Cancelled,
    LeaseLost,
    Deadline,
    BudgetExhausted,
    Storage(String),
}

#[derive(Debug, Clone, Default)]
pub struct Cancellation(Arc<AtomicBool>);

impl Cancellation {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

pub trait Clock: Send + Sync {
    fn now_ms(&self) -> i64;
}

/// Live checks and durable, message-id-deduplicated prompt-token accounting.
/// A successful check is not a write fence: hosts must also check the domain
/// identity in the transaction that applies their effects.
pub trait TaskControl: Send + Sync {
    fn check_control(&self) -> Result<(), ControlError>;
    fn charge_usage(
        &self,
        message_id: &str,
        usage: &Usage,
        completed: bool,
        can_finalize: bool,
    ) -> Result<BudgetAction, ControlError>;
    fn refuse_tool(&self) -> Result<Option<(&'static str, bool)>, ControlError>;
}

/// The dispatcher supplies these captured effective settings to task hosts.
/// Model selection remains in dream_runner; requests supply no model chain.
pub struct CapturedConfig {
    pub activated: bool,
    pub route: McModuleConfig,
    pub effective: Value,
    pub harness: String,
    pub directory: PathBuf,
}

pub struct TaskContext {
    pub task: TaskName,
    pub scope: StoreScope,
    pub config: Arc<CapturedConfig>,
    pub domain_lease: DreamDomainLease,
    pub task_lease: DreamLease,
    pub cancellation: Cancellation,
    pub clock: Arc<dyn Clock>,
    pub deadline_ms: i64,
    pub control: Arc<dyn TaskControl>,
}

impl TaskContext {
    pub fn check_control(&self) -> Result<(), ControlError> {
        if self.cancellation.is_cancelled() {
            return Err(ControlError::Cancelled);
        }
        if self.now_ms() >= self.deadline_ms {
            return Err(ControlError::Deadline);
        }
        self.control.check_control()
    }

    pub fn now_ms(&self) -> i64 {
        self.clock.now_ms()
    }

    pub fn directory(&self) -> &Path {
        &self.config.directory
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolReceipt {
    pub tool: String,
    pub affected_ids: Vec<String>,
    pub details: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolResult {
    pub output: Value,
    pub receipt: Option<ToolReceipt>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolError {
    NotAdmitted(String),
    InvalidArguments(String),
    Control(ControlError),
    Store(String),
}

/// Carriers admit names against the child's descriptor before calling execute.
/// Routers validate arguments and fence any store effects within their transaction.
pub trait TaskToolRouter: Send + Sync {
    fn execute(&self, child: &str, tool: &str, arguments: &Value) -> Result<ToolResult, ToolError>;
}

#[derive(Debug, Clone, PartialEq)]
pub enum ChildEvent {
    Message {
        message_id: String,
        role: String,
        text: String,
    },
    Receipt(ToolReceipt),
    Usage {
        message_id: String,
        usage: Usage,
    },
    Closed {
        settled: bool,
    },
}

/// Events retain their real child identity, including separate fallback children.
pub trait ChildObserver: Send + Sync {
    fn observe(&self, child: &str, event: ChildEvent) -> Result<(), ToolError>;
}
