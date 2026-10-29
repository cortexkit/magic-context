//! Code-owned tool grants. Persona wording cannot widen a task's capabilities.

use mc_store::dream_scheduler::schedules::TaskName;

pub const CODE_READ: &str = "code.read/v1";
pub const MEMORY: &str = "mc.memory/v1";
pub const SEARCH: &str = "mc.search/v1";

#[derive(Debug, Clone, Copy)]
pub struct Grant {
    pub capability: &'static str,
    pub tools: &'static [&'static str],
}

const READ: Grant = Grant {
    capability: CODE_READ,
    tools: &[
        "read",
        "grep",
        "glob",
        "aft_outline",
        "aft_zoom",
        "aft_search",
    ],
};
const MEMORIES: Grant = Grant {
    capability: MEMORY,
    tools: &["ctx_memory"],
};
const SEARCHES: Grant = Grant {
    capability: SEARCH,
    tools: &["ctx_search"],
};

pub fn plan(task: TaskName) -> &'static [Grant] {
    match task {
        TaskName::Map | TaskName::Verify | TaskName::VerifyBroad | TaskName::MaintainDocs => {
            &[READ]
        }
        TaskName::Curate => &[MEMORIES],
        TaskName::Retrospective => &[SEARCHES],
        TaskName::RefreshPrimers => &[READ, SEARCHES],
        _ => &[],
    }
}

/// A child may use fewer tools than its task allows, never more. The resulting
/// grants drive both routing requirements and the runner's plan.
pub fn child_plan(task: TaskName, allowed_tools: &[&str]) -> Vec<Grant> {
    plan(task)
        .iter()
        .filter(|grant| grant.tools.iter().any(|tool| allowed_tools.contains(tool)))
        .copied()
        .collect()
}

/// A provider found by capability under the child's project scope. Module names
/// are transport targets only, not ck-mc's choice of a file-tool implementation.
#[derive(Debug, Clone)]
pub struct Provider {
    pub capability: String,
    pub module: String,
}
