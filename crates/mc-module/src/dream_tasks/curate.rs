//! Curate's non-served task and tool boundary. The dispatcher supplies a captured
//! activation value and a bound project/session; no served facade calls this code.

use std::{cell::RefCell, path::Path, time::Duration};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    config::McModuleConfig,
    dream_runner::{
        run_dream_task, Attempt, CarrierError, ChildRequest, Completion, DreamCarrier,
        DreamRequest, DreamRole, Failure, RunResult,
    },
    memory_actions::{MemoryActionContext, MemoryActions, MemoryRole},
};

pub use crate::memory_actions::{EmbeddingEffect, EmbeddingEffectKind, MemoryEmbeddingQueue};

pub const CATEGORIES: [&str; 5] = [
    "PROJECT_RULES",
    "ARCHITECTURE",
    "CONSTRAINTS",
    "CONFIG_VALUES",
    "NAMING",
];

/// Map current and legacy memory category names to the five `CATEGORIES` buckets.
pub fn category_bucket(category: &str) -> Option<&'static str> {
    match category {
        "PROJECT_RULES" | "USER_DIRECTIVES" | "USER_PREFERENCES" | "WORKFLOW_RULES" => {
            Some(CATEGORIES[0])
        }
        "ARCHITECTURE" | "ARCHITECTURE_DECISIONS" => Some(CATEGORIES[1]),
        "CONSTRAINTS" | "KNOWN_ISSUES" => Some(CATEGORIES[2]),
        "CONFIG_VALUES" | "CONFIG_DEFAULTS" | "ENVIRONMENT" => Some(CATEGORIES[3]),
        "NAMING" => Some(CATEGORIES[4]),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptMemory {
    pub id: i64,
    pub category: String,
    pub content: String,
    pub mapped_files: Vec<String>,
    pub has_no_file_sentinel: bool,
    pub importance: f64,
    pub retrieval_count: f64,
    pub seen_count: f64,
}

/// Read one project snapshot before opening a model child. The caller composes
/// the expiry task first; the cutoff also excludes expired rows from the prompt.
pub fn load_snapshot(
    conn: &mut Connection,
    project: &str,
    now_ms: i64,
) -> rusqlite::Result<Vec<PromptMemory>> {
    let tx = conn.transaction()?;
    // Match the TypeScript project reader's defaults and row validation, rather
    // than allowing malformed rows to enter a category's model-visible snapshot.
    let mut memories = tx.prepare(
        "SELECT id,category,content,COALESCE(importance,50),retrieval_count,seen_count
         FROM memories WHERE project_path=?1 AND status IN ('active','permanent')
         AND (expires_at IS NULL OR expires_at>?2)
         AND category IN ('PROJECT_RULES','ARCHITECTURE','CONSTRAINTS','CONFIG_VALUES','NAMING',
            'USER_DIRECTIVES','USER_PREFERENCES','WORKFLOW_RULES','ARCHITECTURE_DECISIONS',
            'CONFIG_DEFAULTS','ENVIRONMENT','KNOWN_ISSUES')
         AND COALESCE(scope,'project') IN ('project','ecosystem','universe')
         AND source_type IN ('historian','agent','dreamer','user')
         AND verification_status IN ('unverified','verified','stale','flagged')
         AND typeof(content)='text' AND typeof(normalized_hash)='text'
         AND typeof(COALESCE(importance,50)) IN ('integer','real')
         AND typeof(COALESCE(shareable,0)) IN ('integer','real')
         AND typeof(seen_count) IN ('integer','real') AND typeof(retrieval_count) IN ('integer','real')
         AND typeof(first_seen_at) IN ('integer','real') AND typeof(created_at) IN ('integer','real')
         AND typeof(updated_at) IN ('integer','real') AND typeof(last_seen_at) IN ('integer','real')
         AND typeof(source_session_id) IN ('null','text') AND typeof(merged_from) IN ('null','text')
         AND typeof(metadata_json) IN ('null','text')
         AND typeof(last_retrieved_at) IN ('null','integer','real')
         AND typeof(expires_at) IN ('null','integer','real') AND typeof(verified_at) IN ('null','integer','real')
         AND typeof(superseded_by_memory_id) IN ('null','integer','real')
         ORDER BY category ASC,updated_at DESC,id ASC",
    )?.query_map(params![project, now_ms], |row| Ok(PromptMemory {
        id: row.get(0)?, category: row.get(1)?, content: row.get(2)?,
        importance: row.get(3)?, retrieval_count: row.get(4)?, seen_count: row.get(5)?,
        mapped_files: Vec::new(), has_no_file_sentinel: false,
    }))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let mut files = tx.prepare(
        "SELECT file_path FROM memory_verifications WHERE memory_id=?1 ORDER BY file_path",
    )?;
    for memory in &mut memories {
        for file in files.query_map([memory.id], |row| row.get::<_, String>(0))? {
            let file = file?;
            if file.is_empty() {
                memory.has_no_file_sentinel = true;
            } else {
                memory.mapped_files.push(file);
            }
        }
    }
    drop(files);
    tx.commit()?;
    Ok(memories)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Chunk {
    pub memories: Vec<PromptMemory>,
    pub cross_chunk_candidates: Vec<String>,
}

fn render_memories(memories: &[PromptMemory]) -> String {
    memories.iter().map(|m| format!(
        "[{}] {} importance={} retrieval_count={} seen_count={}\nContent: {}\nMapped files: {}{}",
        m.id, m.category, m.importance, m.retrieval_count, m.seen_count, m.content,
        if m.mapped_files.is_empty() { "(none mapped yet)".into() } else { m.mapped_files.join(", ") },
        if m.has_no_file_sentinel { " (file-independent)" } else { "" },
    )).collect::<Vec<_>>().join("\n\n")
}

/// Character budgets use UTF-16 code units, as the TypeScript prompt does.
/// A single oversized memory is kept intact rather than silently truncated.
pub fn chunk_memories(memories: &[PromptMemory], max_characters: usize) -> Vec<Chunk> {
    let mut chunks = Vec::<Chunk>::new();
    let mut current = Vec::new();
    let mut size = 0;
    for memory in memories {
        let length = render_memories(std::slice::from_ref(memory))
            .encode_utf16()
            .count()
            + 2;
        if !current.is_empty() && size + length > max_characters {
            chunks.push(Chunk {
                memories: std::mem::take(&mut current),
                cross_chunk_candidates: Vec::new(),
            });
            size = 0;
        }
        current.push(memory.clone());
        size += length;
    }
    if !current.is_empty() {
        chunks.push(Chunk {
            memories: current,
            cross_chunk_candidates: Vec::new(),
        });
    }
    let normalizer = regex::Regex::new(r"[^\p{L}\p{N}]+").expect("literal regex");
    // Preserve first occurrence order; sorting these groups changes the prompt.
    let mut groups = Vec::<(String, Vec<(i64, usize)>)>::new();
    for (index, chunk) in chunks.iter().enumerate() {
        for memory in &chunk.memories {
            let key = normalizer
                .replace_all(&memory.content.to_lowercase(), " ")
                .trim()
                .to_string();
            if let Some((_, matches)) = groups.iter_mut().find(|(k, _)| *k == key) {
                matches.push((memory.id, index));
            } else {
                groups.push((key, vec![(memory.id, index)]));
            }
        }
    }
    for (index, chunk) in chunks.iter_mut().enumerate() {
        chunk.cross_chunk_candidates = groups
            .iter()
            .filter(|(_, matches)| {
                matches.iter().any(|(_, c)| *c == index) && matches.iter().any(|(_, c)| *c != index)
            })
            .map(|(_, matches)| {
                format!(
                    "IDs {}",
                    matches
                        .iter()
                        .map(|(id, _)| id.to_string())
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            })
            .collect();
    }
    chunks
}

#[derive(Debug, Clone)]
pub struct Plan {
    pub category: &'static str,
    pub memory_count: usize,
    pub chunks: Vec<Chunk>,
    /// Persist the selected category as in-progress before running, so an
    /// interrupted run retries that category instead of advancing the cursor.
    pub begin_state: Value,
    /// Apply only after all chunks succeed, preserving other tasks' state keys.
    pub success_state: Value,
}

fn task_state(raw: Option<&str>) -> Value {
    raw.and_then(|s| serde_json::from_str::<Value>(s).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}

fn cursor(state: &Value) -> usize {
    state["curate"]["cursor"]
        .as_f64()
        .filter(|n| n.is_finite() && *n >= 0.0 && n.fract() == 0.0)
        .map_or(0, |n| (n % CATEGORIES.len() as f64) as usize)
}

/// Select a populated category from `load_snapshot`'s memories, using the saved
/// category cursor or an interrupted run's active category. No state is written.
/// The dispatcher persists the returned states, holds the task lease and runs
/// expiry first. It supplies `max_characters` as twice the model's available
/// input-token budget, rounded down and with a 4000-character minimum.
pub fn prepare(
    raw_state: Option<&str>,
    memories: &[PromptMemory],
    max_characters: usize,
) -> Option<Plan> {
    let state = task_state(raw_state);
    let populated = |category: &str| {
        memories
            .iter()
            .any(|m| category_bucket(&m.category) == Some(category))
    };
    let start = state["curate"]["activeCategory"]
        .as_str()
        .and_then(|active| CATEGORIES.iter().position(|c| *c == active))
        .map_or_else(
            || cursor(&state),
            |i| {
                if populated(CATEGORIES[i]) {
                    i
                } else {
                    (i + 1) % CATEGORIES.len()
                }
            },
        );
    let index = (0..CATEGORIES.len())
        .map(|offset| (start + offset) % CATEGORIES.len())
        .find(|i| populated(CATEGORIES[*i]))?;
    let category = CATEGORIES[index];
    let memories: Vec<_> = memories
        .iter()
        .filter(|m| category_bucket(&m.category) == Some(category))
        .cloned()
        .collect();
    let mut begin_state = state.clone();
    begin_state["curate"] = json!({"cursor": cursor(&state), "activeCategory": category});
    let mut success_state = state;
    success_state["curate"] = json!({"cursor": (index + 1) % CATEGORIES.len()});
    Some(Plan {
        category,
        memory_count: memories.len(),
        chunks: chunk_memories(&memories, max_characters),
        begin_state,
        success_state,
    })
}

/// Trusted route inputs, never decoded from model tool arguments. The tool
/// adapter fixes Dreamer role and the category selected from scheduler state.
pub struct ToolContext<'a> {
    pub project_path: &'a str,
    pub session_id: &'a str,
    pub harness: &'a str,
    pub workspace_members: &'a [String],
    pub shared_categories: &'a [String],
    pub memory_enabled: bool,
}

pub struct Tools<'a> {
    context: ToolContext<'a>,
    category: &'static str,
    actions: MemoryActions,
    refused: usize,
}

impl Plan {
    pub fn tools<'a>(&self, context: ToolContext<'a>) -> Tools<'a> {
        Tools {
            context,
            category: self.category,
            actions: MemoryActions::default(),
            refused: 0,
        }
    }
}

impl Tools<'_> {
    /// Give each tool invocation a unique caller-generated decision key. Retrying
    /// delivery of that same invocation reuses its key, so the write is not applied
    /// twice. `MemoryActions` commits the memory, undo history and outbox together.
    pub fn execute(
        &mut self,
        conn: &mut Connection,
        queue: &impl MemoryEmbeddingQueue,
        decision_key: &str,
        now_ms: i64,
        args: &Value,
    ) -> rusqlite::Result<String> {
        let ctx = &self.context;
        let reply = self.actions.execute_value(
            conn,
            queue,
            &MemoryActionContext {
                project_path: ctx.project_path,
                session_id: ctx.session_id,
                harness: ctx.harness,
                role: MemoryRole::Dreamer,
                workspace_members: ctx.workspace_members,
                shared_categories: ctx.shared_categories,
                curate_category: Some(self.category),
                memory_enabled: ctx.memory_enabled,
                now_ms,
                decision_key,
            },
            args,
        )?;
        if let Some((_, count)) = reply
            .strip_prefix("Skipped ")
            .filter(|reply| reply.contains(": curate safety refusal ("))
            .and_then(|reply| reply.rsplit_once("; refused="))
        {
            if let Ok(count) = count.trim_end_matches('.').parse() {
                self.refused = count;
            }
        }
        Ok(reply)
    }

    pub fn safety_refusals(&self) -> usize {
        self.refused
    }
}

pub const SYSTEM_PROMPT: &str = r#"You are a memory-pool curator for the magic-context system. You run during a scheduled dream window to keep a project's cross-session memory store lean and well-formed.

## Memory operations
- The scoped category snapshot arrives in the first message. Do not list or get it again; track mutation deltas.
- `action="merge", ids=[N,M,...], content="...", category="..."` — consolidate duplicates into one canonical memory
- `action="update", ids=[N], content="...", superseded_by=M` — rewrite content; name where removed detail survives when cutting more than half
- `action="write", category="...", content="..."` — create a memory (SPLITS ONLY — never mint new facts)
- `action="archive", ids=[N], superseded_by=M, reason="..."` — consolidate a redundant memory into the named active same-category survivor

## Rules
1. **Assume the pool is accurate.** A separate verify task checks memories against code. You handle QUALITY only — duplicates, wording, low-value entries — never correctness, and you do NOT read the codebase.
2. **Work methodically.** Choose your own batch size.
3. **Be conservative with archives.** Use the task's archive criteria.
4. **Present-tense operational language.** "X uses Y" not "X was changed to use Y."
5. **One rule/fact per memory.**
6. **Never mint new facts** — that is the historian's job. `write` is for splitting a compound memory only.

## Memory taxonomy (5 categories)

Project memory uses exactly 5 categories. Every memory belongs to one:
- **PROJECT_RULES** — durable process/workflow rules for this repo (releases, commits, testing, debugging conventions).
- **ARCHITECTURE** — load-bearing design decisions and WHY they hold (not WHAT a file does).
- **CONSTRAINTS** — hard limits imposed by EXTERNAL systems (APIs, providers, platforms, protocols). Not our own code's behavior.
- **CONFIG_VALUES** — stable configuration keys/values and conventions. Not transient measurements (test counts, sizes, versions).
- **NAMING** — naming conventions and canonical names. Not inventories.

**Legacy categories during transition:** older memories may still carry pre-v2 category names. When you touch one, map it to its 5-category home with `action="update"` (or `merge`): WORKFLOW_RULES→PROJECT_RULES, ARCHITECTURE_DECISIONS→ARCHITECTURE, CONFIG_DEFAULTS→CONFIG_VALUES, ENVIRONMENT→CONFIG_VALUES (paths) or CONSTRAINTS, KNOWN_ISSUES→CONSTRAINTS only if it's an external-system limit. USER_DIRECTIVES / USER_PREFERENCES are NOT project categories. Do not compare project memories with the global user profile or use it to justify an archive."#;

pub fn build_prompt(
    project: &str,
    category: &str,
    chunk: &Chunk,
    injection_budget_tokens: f64,
) -> String {
    let candidates = if chunk.cross_chunk_candidates.is_empty() {
        "(none)".into()
    } else {
        chunk.cross_chunk_candidates.join("\n")
    };
    let snapshot = render_memories(&chunk.memories);
    format!(
        r#"## Task: Curate Project Memory Pool (hygiene)

**Project:** {project}

This run covers the whole of the `{category}` category (the other categories run in later windows).

The memories below are assumed ACCURATE (a separate verify task keeps them true). Your job is pool QUALITY: remove duplicates, tighten wording, and consolidate redundant entries that waste the {injection_budget_tokens}-token injection budget. Explain each action in one line first. Do NOT mint new facts (that is the historian's job).

Work ALL THREE phases below in order (A → B → C) over this category. Do NOT stop after consolidating — a run that only merges and never improves or archives is incomplete.

### Phase A — Consolidate duplicates
Group by category, then merge near-identical / superset-subset / same-fact-different-angle clusters into one canonical memory with `ctx_memory(action="merge", ids=[...], content="...", category="...")`. Preserve every unique detail; terse present tense; paths/keys verbatim. Every id in a merge MUST share the same category — the system rejects cross-category merges. If two similar memories sit in different categories they are NOT duplicates; do not archive either as a consolidation. One fact per memory.

### Phase B — Improve wording
Rewrite narrative/historical → operational present tense ("X uses Y because Z", not "we switched to Y"); drop session-local context and commit hashes (unless the hash is the point); add specifics where vague. A rewrite that removes more than half the content must name the active same-category memory preserving that detail with `superseded_by`. `write` is for SPLITS ONLY (update the original down to its first fact, write the second) — a healthy run is net-neutral or net-shrinking, never net-adds facts.

### Phase C — Archive only into a surviving project memory
Archive a redundant memory only when a better ACTIVE memory in the same project and category preserves its information; name that survivor with `superseded_by`. A bare "redundant" verdict is deletion and will be refused. Leave standalone low-value or stale entries unchanged for a human to review. The global user profile describes the operator and is never a substitute for project knowledge, so it cannot justify an archive.
KEEP (overrides archive): constraint/rule language (must/never/always) · explains WHY (because/so that/to prevent) · EXTERNAL-system limit (CONSTRAINTS: archive only if word-for-word duplicated) · path/config WITH context · retrieval_count>0 · priority/philosophy.

### Cross-chunk duplicate candidates (normalized content matches)
{candidates}

### Category snapshot (do not re-enumerate)
{snapshot}"#
    )
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryOperations {
    pub total_calls: usize,
    pub completed_actions: Vec<String>,
}

/// Inspect real assistant tool parts, not tool-shaped prose or user messages.
pub fn inspect_operations(messages: &Value) -> MemoryOperations {
    let mut summary = MemoryOperations::default();
    for message in messages.as_array().into_iter().flatten() {
        if message["info"]["role"] != "assistant" {
            continue;
        }
        for part in message["parts"].as_array().into_iter().flatten() {
            if part["type"] != "tool" {
                continue;
            }
            let name = if part["tool"].is_null() {
                &part["name"]
            } else {
                &part["tool"]
            };
            if name != "ctx_memory" {
                continue;
            }
            summary.total_calls += 1;
            if part["state"]["status"] != "completed" {
                continue;
            }
            let action = part["state"]["input"]["action"]
                .as_str()
                .unwrap_or_default();
            let output = part["state"]["output"].as_str().unwrap_or_default();
            let completed = matches!(action, "merge" | "archive" | "update")
                && output == "completed"
                || action == "merge" && output.starts_with("Merged memories")
                || action == "archive" && output.starts_with("Archived memor")
                || action == "update" && output.starts_with("Updated memory");
            if completed {
                summary.completed_actions.push(action.into());
            }
        }
    }
    summary
}

pub fn validate_output(text: &str, messages: &Value) -> Result<MemoryOperations, String> {
    const TEXTUAL_CALLS: [&str; 4] = [
        r"(?im)\[\s*historical tool call\s*\][\s\S]*?(?:^|\n)\s*name\s*:\s*ctx_memory\b[\s\S]*?(?:^|\n)\s*arguments\s*:",
        r"(?im)(?:^|\n)\s*name\s*:\s*ctx_memory\b[\s\S]*?(?:^|\n)\s*arguments\s*:",
        r"(?im)(?:^|\n)\s*(?:```[^\n]*\n\s*)?ctx_memory\s*\(\s*action\s*=",
        r#"(?i)["']name["']\s*:\s*["']ctx_memory["'][\s\S]*?["']arguments["']\s*:"#,
    ];
    if TEXTUAL_CALLS
        .iter()
        .any(|p| regex::Regex::new(p).expect("literal regex").is_match(text))
    {
        return Err("Curate returned an unresolved textual ctx_memory tool call.".into());
    }
    let operations = inspect_operations(messages);
    if operations.completed_actions.is_empty() {
        if text.is_empty() {
            return Err("Dreamer returned no assistant output.".into());
        }
        if operations.total_calls > 0 {
            return Err("Curate returned no completed ctx_memory tool result.".into());
        }
    }
    Ok(operations)
}

/// The carrier supplies the complete, untruncated message list for the child it
/// just ran. A completion's text alone cannot prove that a memory tool executed.
pub trait CurateCarrier: DreamCarrier {
    fn messages(&self, child: &str) -> Value;
    /// Number of memory IDs rejected by curate's mutation safety checks in this
    /// child's `Tools` instance; used to report skipped unsafe changes.
    fn safety_refusals(&self, _child: &str) -> usize {
        0
    }
}

struct CapturingCarrier<'a, C> {
    inner: &'a mut C,
    messages: &'a RefCell<Value>,
    refused: &'a RefCell<usize>,
}

impl<C: CurateCarrier> DreamCarrier for CapturingCarrier<'_, C> {
    async fn open(&mut self, request: &ChildRequest) -> Result<String, CarrierError> {
        *self.messages.borrow_mut() = Value::Null;
        *self.refused.borrow_mut() = 0;
        self.inner.open(request).await
    }
    async fn complete(
        &mut self,
        child: &str,
        request: &ChildRequest,
    ) -> Result<Completion, CarrierError> {
        let completion = self.inner.complete(child, request).await?;
        *self.messages.borrow_mut() = self.inner.messages(child);
        *self.refused.borrow_mut() = self.inner.safety_refusals(child);
        Ok(completion)
    }
    async fn close(&mut self, child: &str, settled: bool) -> Result<(), CarrierError> {
        self.inner.close(child, settled).await
    }
}

pub struct RunContext<'a> {
    pub harness: &'a str,
    pub project_path: &'a str,
    pub parent_session_id: &'a str,
    pub directory: &'a Path,
    pub timeout: Duration,
    pub token_budget: Option<u64>,
    pub language: Option<&'a str>,
    /// Number of expired memories archived before loading this run's snapshot.
    pub expired_archived: usize,
}

#[derive(Debug, Clone)]
pub struct Success {
    pub completed_actions: Vec<String>,
    pub detail: String,
    pub task_state: Option<Value>,
}

/// Run on the scheduler's worker after it acquires the task lease and persists
/// `Plan::begin_state` to remember the active category. Model calls hold no SQLite
/// transaction; the carrier routes ctx_memory to `Tools`. If a prompt fails,
/// already-applied writes remain, but the category cursor is not advanced.
/// All prompt-sized memory batches share the task's overall deadline.
pub async fn run(
    activated: bool,
    config: &McModuleConfig,
    trusted_config: &Value,
    context: &RunContext<'_>,
    plan: Option<&Plan>,
    carrier: &mut impl CurateCarrier,
) -> RunResult<Success> {
    if !activated {
        return RunResult {
            result: Err(Failure::Inactive),
            attempts: Vec::new(),
        };
    }
    let Some(plan) = plan else {
        return RunResult {
            result: Ok(Success {
                completed_actions: Vec::new(),
                detail: if context.expired_archived == 0 {
                    "curate: no populated project-memory category".into()
                } else {
                    expiry_progress(context.expired_archived)
                },
                task_state: None,
            }),
            attempts: Vec::new(),
        };
    };
    let system = crate::historian_prompt::with_content_language_directive(
        SYSTEM_PROMPT,
        context.language,
        Default::default(),
    );
    let task_timeout =
        crate::dream_runner::resolve_task_models(trusted_config, context.harness, "curate")
            .timeout_minutes
            .and_then(|n| Duration::try_from_secs_f64(n * 60.0).ok())
            .map_or(context.timeout, |timeout| timeout.min(context.timeout));
    let deadline = tokio::time::Instant::now() + task_timeout;
    let mut actions = Vec::new();
    let mut attempts = Vec::<Attempt>::new();
    let messages = RefCell::new(Value::Null);
    let refused = RefCell::new(0);
    let mut total_refused = 0;
    let mut carrier = CapturingCarrier {
        inner: carrier,
        messages: &messages,
        refused: &refused,
    };
    for chunk in &plan.chunks {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return RunResult {
                result: Err(Failure::Timeout),
                attempts,
            };
        }
        let prompt = build_prompt(
            context.project_path,
            plan.category,
            chunk,
            config.memory_budget_tokens,
        );
        let result = run_dream_task(
            activated,
            config,
            trusted_config,
            &DreamRequest {
                task: "curate",
                role: DreamRole::Curate,
                harness: context.harness,
                parent_session_id: context.parent_session_id,
                directory: context.directory,
                system: &system,
                prompt: &prompt,
                timeout: remaining,
                token_budget: context.token_budget,
                allow_empty: true,
            },
            &mut carrier,
            |completion| validate_output(&completion.text, &messages.borrow()),
        )
        .await;
        attempts.extend(result.attempts);
        match result.result {
            Ok(output) => {
                actions.extend(output.completed_actions);
                total_refused += *refused.borrow();
            }
            Err(failure) => {
                return RunResult {
                    result: Err(failure),
                    attempts,
                }
            }
        }
    }
    let mut detail = format!("curate: {} ({})", plan.category, plan.memory_count);
    if context.expired_archived > 0 {
        detail.push_str(&format!("; {}", expiry_progress(context.expired_archived)));
    }
    if !actions.is_empty() {
        let mut counts = Vec::<(&str, usize)>::new();
        for action in &actions {
            if let Some((_, count)) = counts.iter_mut().find(|(a, _)| *a == action) {
                *count += 1;
            } else {
                counts.push((action, 1));
            }
        }
        let action_detail = counts
            .iter()
            .map(|(a, n)| {
                if *n == 1 {
                    (*a).into()
                } else {
                    format!("{a} ×{n}")
                }
            })
            .collect::<Vec<_>>()
            .join(", ");
        detail.push_str(&format!(
            "; curate: {} memory {} applied ({action_detail})",
            actions.len(),
            if actions.len() == 1 {
                "operation"
            } else {
                "operations"
            }
        ));
    }
    if total_refused > 0 {
        detail.push_str(&format!(
            "; curate: refused {total_refused} unsafe mutation(s)"
        ));
    }
    RunResult {
        result: Ok(Success {
            completed_actions: actions,
            detail,
            task_state: Some(plan.success_state.clone()),
        }),
        attempts,
    }
}

fn expiry_progress(count: usize) -> String {
    format!(
        "curate: archived {count} expired {}",
        if count == 1 { "memory" } else { "memories" }
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::{types::ValueRef, Transaction};
    use sha2::{Digest, Sha256};
    use std::collections::VecDeque;

    const NOW: i64 = 1_700_000_000_000;

    fn memory(id: i64, category: &str, content: &str) -> PromptMemory {
        PromptMemory {
            id,
            category: category.into(),
            content: content.into(),
            mapped_files: vec!["src/core.ts".into()],
            has_no_file_sentinel: false,
            importance: 90.0,
            retrieval_count: 2.0,
            seen_count: 3.0,
        }
    }

    fn database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            &include_str!("../../../mc-store/testdata/context_schema/schema.sql")
                .replace(":applied_at", &NOW.to_string()),
        )
        .unwrap();
        conn.execute_batch("CREATE TABLE test_embedding_queue(effect_json TEXT NOT NULL);")
            .unwrap();
        conn
    }

    struct Queue;
    impl MemoryEmbeddingQueue for Queue {
        fn enqueue_tx(
            &self,
            tx: &Transaction<'_>,
            effect: &EmbeddingEffect,
        ) -> rusqlite::Result<()> {
            assert!(
                !tx.is_autocommit(),
                "effects must be in the tool transaction"
            );
            tx.execute(
                "INSERT INTO test_embedding_queue(effect_json) VALUES(?1)",
                [serde_json::to_string(effect).unwrap()],
            )?;
            Ok(())
        }
    }

    fn rows(conn: &Connection, sql: &str) -> Value {
        let mut stmt = conn.prepare(sql).unwrap();
        let names: Vec<_> = stmt.column_names().iter().map(|s| s.to_string()).collect();
        let rows = stmt
            .query_map([], |row| {
                let mut object = serde_json::Map::new();
                for (i, name) in names.iter().enumerate() {
                    let value = match row.get_ref(i)? {
                        ValueRef::Null => Value::Null,
                        ValueRef::Integer(v) => json!(v),
                        ValueRef::Real(v) => json!(v),
                        ValueRef::Text(v) => json!(std::str::from_utf8(v).unwrap()),
                        ValueRef::Blob(_) => panic!("unexpected fixture blob"),
                    };
                    object.insert(name.clone(), value);
                }
                Ok(Value::Object(object))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        json!(rows)
    }

    fn context() -> ToolContext<'static> {
        ToolContext {
            project_path: "project-a",
            session_id: "session-a",
            harness: "opencode",
            workspace_members: &[],
            shared_categories: &[],
            memory_enabled: true,
        }
    }

    fn plan(category: &str) -> Plan {
        prepare(None, &[memory(1, category, "fixture")], 10000).unwrap()
    }

    fn insert(conn: &Connection, id: i64, project: &str, category: &str, content: &str) {
        conn.execute("INSERT INTO memories(id,project_path,category,content,normalized_hash,importance,source_session_id,first_seen_at,created_at,updated_at,last_seen_at) VALUES(?1,?2,?3,?4,?5,90,'session-a',?6,?6,?6,?6)",
            params![id, project, category, content, mc_store::compute_normalized_memory_hash(content), NOW]).unwrap();
    }

    fn sha(text: &str) -> String {
        format!("{:x}", Sha256::digest(text.as_bytes()))
    }

    #[derive(Default)]
    struct FakeCarrier {
        replies: VecDeque<(String, Value)>,
        requests: Vec<ChildRequest>,
        latest_messages: Value,
        closed: Vec<bool>,
    }
    impl DreamCarrier for FakeCarrier {
        async fn open(&mut self, request: &ChildRequest) -> Result<String, CarrierError> {
            self.requests.push(request.clone());
            Ok(format!("child-{}", self.requests.len()))
        }
        async fn complete(
            &mut self,
            _: &str,
            _: &ChildRequest,
        ) -> Result<Completion, CarrierError> {
            let (text, messages) = self.replies.pop_front().expect("unexpected paid attempt");
            self.latest_messages = messages;
            Ok(Completion {
                text,
                ..Default::default()
            })
        }
        async fn close(&mut self, _: &str, settled: bool) -> Result<(), CarrierError> {
            self.closed.push(settled);
            Ok(())
        }
    }
    impl CurateCarrier for FakeCarrier {
        fn messages(&self, _: &str) -> Value {
            self.latest_messages.clone()
        }
    }
    fn run_context() -> RunContext<'static> {
        RunContext {
            harness: "opencode",
            project_path: "project-a",
            parent_session_id: "session-a",
            directory: Path::new("/fixture"),
            timeout: Duration::from_secs(60),
            token_budget: Some(5000),
            language: Some("tr"),
            expired_archived: 0,
        }
    }

    struct ApplyingCarrier {
        conn: Connection,
        tools: Tools<'static>,
        calls: Vec<Value>,
        messages: Value,
    }
    impl DreamCarrier for ApplyingCarrier {
        async fn open(&mut self, request: &ChildRequest) -> Result<String, CarrierError> {
            assert!(self.conn.is_autocommit());
            assert_eq!(request.allowed_tools, &["ctx_memory"]);
            Ok("curate-child".into())
        }
        async fn complete(
            &mut self,
            _: &str,
            _: &ChildRequest,
        ) -> Result<Completion, CarrierError> {
            let mut parts = Vec::new();
            for (i, args) in self.calls.iter().enumerate() {
                assert!(self.conn.is_autocommit());
                let reply = self
                    .tools
                    .execute(&mut self.conn, &Queue, &format!("task-{i}"), NOW, args)
                    .unwrap();
                parts.push(tool(args["action"].as_str().unwrap(), &reply, "completed"));
            }
            self.messages = messages(parts);
            Ok(Completion::default())
        }
        async fn close(&mut self, _: &str, settled: bool) -> Result<(), CarrierError> {
            assert!(settled);
            assert!(self.conn.is_autocommit());
            Ok(())
        }
    }
    impl CurateCarrier for ApplyingCarrier {
        fn messages(&self, _: &str) -> Value {
            self.messages.clone()
        }
        fn safety_refusals(&self, _: &str) -> usize {
            self.tools.safety_refusals()
        }
    }

    #[tokio::test]
    async fn task_applies_through_3f_with_history_and_refusal_progress() {
        let mut conn = database();
        for (id, content) in [
            (1, "Limit is 12."),
            (2, "Limit is 24."),
            (3, "Limit is 48."),
        ] {
            insert(&conn, id, "project-a", "CONFIG_VALUES", content);
        }
        let snapshot = load_snapshot(&mut conn, "project-a", NOW).unwrap();
        let plan = prepare(None, &snapshot, 10000).unwrap();
        let mut carrier = ApplyingCarrier {
            conn,
            tools: plan.tools(context()),
            calls: vec![
                json!({"action":"update","ids":[1],"content":"Limit is 16."}),
                json!({"action":"archive","ids":[2],"reason":"redundant"}),
                json!({"action":"merge","ids":[1,2],"content":"Combined limit is 24."}),
                json!({"action":"archive","ids":[3],"superseded_by":4,"reason":"canonical limit survives"}),
            ],
            messages: Value::Null,
        };
        let result = run(
            true,
            &McModuleConfig::default(),
            &json!({}),
            &RunContext {
                expired_archived: 1,
                ..run_context()
            },
            Some(&plan),
            &mut carrier,
        )
        .await;
        let success = result.result.unwrap();
        assert_eq!(
            success.completed_actions,
            vec!["update", "merge", "archive"]
        );
        assert_eq!(success.detail,"curate: CONFIG_VALUES (3); curate: archived 1 expired memory; curate: 3 memory operations applied (update, merge, archive); curate: refused 1 unsafe mutation(s)");
        assert_eq!(
            rows(
                &carrier.conn,
                "SELECT id,status,superseded_by_memory_id FROM memories ORDER BY id"
            ),
            json!([
                {"id":1,"status":"archived","superseded_by_memory_id":4},
                {"id":2,"status":"archived","superseded_by_memory_id":4},
                {"id":3,"status":"archived","superseded_by_memory_id":4},
                {"id":4,"status":"active","superseded_by_memory_id":null}
            ])
        );
        assert_eq!(
            rows(&carrier.conn, "SELECT COUNT(*) AS n FROM memory_history"),
            json!([{"n":5}])
        );
        assert_eq!(
            rows(
                &carrier.conn,
                "SELECT COUNT(*) AS n FROM test_embedding_queue"
            ),
            json!([{"n":5}])
        );
    }

    #[tokio::test]
    async fn runner_uses_scoped_chunks_locked_tools_and_real_completed_results() {
        let plan = prepare(
            None,
            &[
                memory(1, "CONFIG_VALUES", "Limit is 12."),
                memory(2, "CONFIG_VALUES", "Limit is 24."),
            ],
            1,
        )
        .unwrap();
        let mut carrier = FakeCarrier {
            replies: VecDeque::from([
                (
                    String::new(),
                    messages(vec![tool("update", "Updated memory [ID: 1].", "completed")]),
                ),
                (
                    String::new(),
                    messages(vec![tool("update", "Updated memory [ID: 2].", "completed")]),
                ),
            ]),
            ..Default::default()
        };
        let trusted =
            json!({"dreamer":{"opencode":{"tasks":{"curate":{"model":"synapse/curator"}}}}});
        let result = run(
            true,
            &McModuleConfig::default(),
            &trusted,
            &run_context(),
            Some(&plan),
            &mut carrier,
        )
        .await;
        let success = result.result.unwrap();
        assert_eq!(success.completed_actions, vec!["update", "update"]);
        assert_eq!(
            success.detail,
            "curate: CONFIG_VALUES (2); curate: 2 memory operations applied (update ×2)"
        );
        assert_eq!(success.task_state, Some(plan.success_state));
        assert_eq!(result.attempts.len(), 2);
        assert_eq!(carrier.closed, vec![true, true]);
        for (i, request) in carrier.requests.iter().enumerate() {
            assert_eq!(request.agent, "dreamer");
            assert_eq!(request.allowed_tools, &["ctx_memory"]);
            assert_eq!(request.max_steps, 150);
            assert_eq!(request.parent_session_id, "session-a");
            assert_eq!(request.directory, Path::new("/fixture"));
            assert_eq!(request.model.as_ref().unwrap().model, "synapse/curator");
            assert_eq!(request.temperature, None);
            assert_eq!(request.token_budget, Some(5000));
            assert_eq!(
                sha(&request.system),
                "a637e709ee1e7c25ea5e77829ce90b7dac9f511d8d188907f6a352757c8ffb74"
            );
            assert!(request
                .prompt
                .contains(&format!("[{}] CONFIG_VALUES", i + 1)));
            assert!(!request
                .prompt
                .contains(&format!("[{}] CONFIG_VALUES", 2 - i)));
            assert!(request.timeout <= Duration::from_secs(60));
        }
    }

    #[tokio::test]
    async fn curate_states_the_configured_injection_budget_and_pins_the_4000_default() {
        let plan = plan("CONFIG_VALUES");
        for configured in [None, Some(2750.0)] {
            let mut config = McModuleConfig::default();
            if let Some(budget) = configured {
                config.memory_budget_tokens = budget;
            }
            let mut carrier = FakeCarrier {
                replies: VecDeque::from([("No redundant memories found.".into(), Value::Null)]),
                ..Default::default()
            };
            let result = run(
                true,
                &config,
                &json!({"dreamer":{"opencode":{"tasks":{"curate":{"model":"synapse/curator"}}}}}),
                &run_context(),
                Some(&plan),
                &mut carrier,
            )
            .await;
            result.result.unwrap();
            assert_eq!(carrier.requests.len(), 1);
            let prompt = &carrier.requests[0].prompt;
            let expected = configured.unwrap_or(4000.0);
            assert!(prompt.contains(&format!("the {expected}-token injection budget")));
            assert!(!prompt.contains("6000-token"));
            assert!(
                !prompt.contains("5000-token"),
                "not the child output budget"
            );
        }
    }

    #[tokio::test]
    async fn inactive_empty_and_failed_runs_do_not_return_a_success_patch() {
        let plan = plan("CONFIG_VALUES");
        let config = McModuleConfig::default();
        let trusted = json!({});
        let mut carrier = FakeCarrier::default();
        let inactive = run(
            false,
            &config,
            &trusted,
            &run_context(),
            Some(&plan),
            &mut carrier,
        )
        .await;
        assert_eq!(inactive.result.unwrap_err(), Failure::Inactive);
        let empty = run(true, &config, &trusted, &run_context(), None, &mut carrier)
            .await
            .result
            .unwrap();
        assert_eq!(empty.detail, "curate: no populated project-memory category");
        assert!(empty.task_state.is_none());
        assert!(carrier.requests.is_empty());
        carrier.replies.push_back((
            "Finished".into(),
            messages(vec![tool(
                "archive",
                "Skipped archive: unsafe",
                "completed",
            )]),
        ));
        let failed = run(
            true,
            &config,
            &trusted,
            &run_context(),
            Some(&plan),
            &mut carrier,
        )
        .await;
        assert_eq!(
            failed.result.unwrap_err(),
            Failure::Validation("Curate returned no completed ctx_memory tool result.".into())
        );
        assert_eq!(carrier.closed, vec![false]);
        assert_eq!(
            plan.begin_state,
            json!({"curate":{"cursor":0,"activeCategory":"CONFIG_VALUES"}})
        );
    }

    #[tokio::test]
    async fn fallback_uses_fresh_messages_not_the_previous_attempts_tools() {
        let mut carrier = FakeCarrier {
            replies: VecDeque::from([
                (
                    "ctx_memory(action=\"archive\")".into(),
                    messages(vec![tool("update", "completed", "completed")]),
                ),
                (String::new(), Value::Null),
            ]),
            ..Default::default()
        };
        let config = json!({"dreamer":{"opencode":{"model":"synapse/primary","fallback_models":["synapse/fallback"]}}});
        let result = run(
            true,
            &McModuleConfig::default(),
            &config,
            &run_context(),
            Some(&plan("CONFIG_VALUES")),
            &mut carrier,
        )
        .await;
        assert_eq!(
            result.result.unwrap_err(),
            Failure::Validation("Dreamer returned no assistant output.".into())
        );
        assert_eq!(result.attempts.len(), 2);
        assert_eq!(carrier.closed, vec![false, false]);
        assert_eq!(
            carrier.requests[0].model.as_ref().unwrap().model,
            "synapse/primary"
        );
        assert_eq!(
            carrier.requests[1].model.as_ref().unwrap().model,
            "synapse/fallback"
        );
    }

    fn tool(action: &str, output: &str, status: &str) -> Value {
        json!({"type":"tool","tool":"ctx_memory","state":{"status":status,"input":{"action":action},"output":output}})
    }
    fn messages(parts: Vec<Value>) -> Value {
        json!([{"info":{"role":"assistant"},"parts":parts}])
    }

    #[test]
    fn pinned_ts_operation_inspection_and_textual_impostors_match() {
        let cases = [
            (Value::Null, json!({"totalCalls":0,"completedActions":[]})),
            (
                json!([{"info":{"role":"user"},"parts":[tool("update","completed","completed")]}]),
                json!({"totalCalls":0,"completedActions":[]}),
            ),
            (
                messages(vec![
                    tool("merge", "Merged memories [1, 2]", "completed"),
                    tool("archive", "Archived memory [ID: 3].", "completed"),
                    tool("update", "Updated memory [ID: 4].", "completed"),
                    tool("write", "Saved memory", "completed"),
                    tool("update", "Error: refused", "completed"),
                    tool("archive", "completed", "error"),
                    json!({"type":"text","text":"{\"name\":\"ctx_memory\",\"arguments\":{\"action\":\"archive\"}}"}),
                ]),
                json!({"totalCalls":6,"completedActions":["merge","archive","update"]}),
            ),
            (
                messages(vec![
                    tool("merge", "completed", "completed"),
                    tool("archive", "completed", "completed"),
                    tool("update", "completed", "completed"),
                    tool("list", "completed", "completed"),
                    json!({"type":"tool","tool":null,"name":"ctx_memory","state":{"status":"completed","input":{"action":"update"},"output":"Updated memory"}}),
                ]),
                json!({"totalCalls":5,"completedActions":["merge","archive","update","update"]}),
            ),
        ];
        for (messages, expected) in cases {
            assert_eq!(json!(inspect_operations(&messages)), expected);
        }
        for text in [
            "[historical tool call]\nname: ctx_memory\narguments: {}",
            "name: ctx_memory\narguments: {}",
            "```typescript\nctx_memory(action=\"archive\", ids=[1])\n```",
            "{\"name\":\"ctx_memory\",\"arguments\":{}}",
        ] {
            assert_eq!(
                validate_output(text, &Value::Null).unwrap_err(),
                "Curate returned an unresolved textual ctx_memory tool call."
            );
        }
        assert!(validate_output("No changes needed.", &Value::Null).is_ok());
        assert!(
            validate_output("", &messages(vec![tool("merge", "completed", "completed")])).is_ok()
        );
        assert_eq!(
            validate_output("", &Value::Null).unwrap_err(),
            "Dreamer returned no assistant output."
        );
        assert_eq!(
            validate_output(
                "Finished",
                &messages(vec![tool("archive", "Error: refused", "completed")])
            )
            .unwrap_err(),
            "Curate returned no completed ctx_memory tool result."
        );
    }

    #[test]
    fn dreamer_tools_match_ts_rows_history_replies_and_queued_effects() {
        let vectors: Vec<Value> =
            serde_json::from_str(include_str!("../../testdata/memory_actions/golden.json"))
                .unwrap();
        assert_eq!(vectors.len(), 34);
        let mut conn = database();
        let mut primary = MemoryActions::default();
        let mut tools = plan("CONFIG_VALUES").tools(context());
        for (i, vector) in vectors.iter().enumerate() {
            let key = format!("oracle-{i}");
            let reply = if vector["role"] == "dreamer" {
                tools.category = match i {
                    26 => "NAMING",
                    29..=30 => "PROJECT_RULES",
                    _ => "CONFIG_VALUES",
                };
                tools
                    .execute(&mut conn, &Queue, &key, NOW, &vector["args"])
                    .unwrap()
            } else {
                let ctx = context();
                primary
                    .execute_value(
                        &mut conn,
                        &Queue,
                        &MemoryActionContext {
                            project_path: ctx.project_path,
                            session_id: ctx.session_id,
                            harness: ctx.harness,
                            role: MemoryRole::Primary,
                            workspace_members: &[],
                            shared_categories: &[],
                            curate_category: None,
                            memory_enabled: true,
                            now_ms: NOW,
                            decision_key: &key,
                        },
                        &vector["args"],
                    )
                    .unwrap()
            };
            assert_eq!(reply, vector["reply"], "reply vector {i}");
            assert_eq!(
                rows(&conn, "SELECT * FROM memories ORDER BY id"),
                vector["memories"],
                "memories vector {i}"
            );
            assert_eq!(rows(&conn,"SELECT memory_id,revision,previous_text,after_text,before_json,after_json,applied_at,reason,evidence_json,source_ids_json FROM memory_history ORDER BY id"),vector["history"],"history vector {i}");
            let effects = rows(&conn, "SELECT effect_json FROM test_embedding_queue");
            let embedded: Vec<_> = effects
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|row| {
                    let effect: Value =
                        serde_json::from_str(row["effect_json"].as_str().unwrap()).unwrap();
                    (effect["kind"] == "embed").then(|| effect["content"].clone())
                })
                .collect();
            assert_eq!(
                json!(embedded),
                vector["embedCalls"],
                "queued embedding vector {i}"
            );
        }
    }

    /// Curate edits made in Rust leave the same audited rows as the TypeScript
    /// dreamer's for the same update, merge (sources plus survivor) and archive:
    /// memory revisions, status and successor links, and history rows carrying the
    /// before/after snapshots an undo restores from. The golden comes from the
    /// TypeScript tool (`gen/gen-curate-history-golden.ts`).
    #[test]
    fn curate_update_merge_archive_history_matches_the_typescript_dreamer() {
        let vectors: Vec<Value> = serde_json::from_str(include_str!(
            "../../testdata/memory_actions/curate_history.json"
        ))
        .unwrap();
        assert_eq!(vectors.len(), 7);
        let mut conn = database();
        let mut tools = plan("CONFIG_VALUES").tools(context());
        for (i, vector) in vectors.iter().enumerate() {
            let reply = tools
                .execute(
                    &mut conn,
                    &Queue,
                    &format!("curate-{i}"),
                    NOW,
                    &vector["args"],
                )
                .unwrap();
            assert_eq!(reply, vector["reply"], "reply {i}");
            assert_eq!(
                rows(&conn, "SELECT id,category,content,status,revision,superseded_by_memory_id FROM memories ORDER BY id"),
                vector["memories"],
                "memories {i}"
            );
            assert_eq!(
                rows(&conn, "SELECT memory_id,revision,previous_text,after_text,before_json,after_json,applied_at,reason,evidence_json,source_ids_json FROM memory_history ORDER BY id"),
                vector["history"],
                "history {i}"
            );
        }
    }

    #[test]
    fn tool_scope_and_workspace_preflight_refuse_without_writes() {
        let mut conn = database();
        insert(&conn, 1, "project-a", "CONFIG_VALUES", "Limit is 12.");
        insert(&conn, 2, "project-a", "NAMING", "Name is Alpha.");
        insert(&conn, 3, "project-b", "CONFIG_VALUES", "Limit is 24.");
        let mut tools = plan("CONFIG_VALUES").tools(context());
        let before = rows(&conn, "SELECT * FROM memories ORDER BY id");
        let requests = [
            json!({"action":"update","ids":[2],"content":"Name is Beta.","role":"primary"}),
            json!({"action":"write","category":"NAMING","content":"New naming fact."}),
            json!({"action":"archive","ids":[1],"superseded_by":2}),
            json!({"action":"merge","ids":[1,3],"content":"Combined limit."}),
            json!({"action":"update","ids":[3],"content":"Foreign rewrite.","project_path":"project-b"}),
        ];
        for (i, args) in requests.iter().enumerate() {
            let reply = tools
                .execute(&mut conn, &Queue, &format!("refuse-{i}"), NOW, args)
                .unwrap();
            assert!(
                reply.starts_with("Error:") || reply.starts_with("Skipped"),
                "{reply}"
            );
            assert_eq!(rows(&conn, "SELECT * FROM memories ORDER BY id"), before);
            for table in ["memory_history", "memory_journal", "test_embedding_queue"] {
                assert_eq!(rows(&conn, &format!("SELECT * FROM {table}")), json!([]));
            }
        }
        let listed = tools
            .execute(&mut conn, &Queue, "list", NOW, &json!({"action":"list"}))
            .unwrap();
        assert!(listed.contains("Limit is 12."));
        assert!(!listed.contains("Name is Alpha."));
        assert!(!listed.contains("Limit is 24."));
        let shared = vec!["project-b".into()];
        let cats = vec!["CONFIG_VALUES".into()];
        let mut shared_tools = plan("CONFIG_VALUES").tools(ToolContext {
            workspace_members: &shared,
            shared_categories: &cats,
            ..context()
        });
        assert_eq!(
            shared_tools
                .execute(
                    &mut conn,
                    &Queue,
                    "workspace-update",
                    NOW,
                    &json!({"action":"update","ids":[3],"content":"Limit is 48."})
                )
                .unwrap(),
            "Updated memory [ID: 3] in CONFIG_VALUES."
        );
    }

    #[test]
    fn snapshot_is_project_scoped_ordered_mapped_and_expiry_filtered() {
        let mut conn = database();
        for (id, project, category) in [
            (1, "project-a", "NAMING"),
            (2, "project-a", "ARCHITECTURE"),
            (3, "project-a", "ARCHITECTURE"),
            (4, "project-b", "ARCHITECTURE"),
            (5, "project-a", "NAMING"),
            (6, "project-a", "NAMING"),
        ] {
            insert(&conn, id, project, category, &format!("Fact {id}"));
        }
        conn.execute_batch("UPDATE memories SET updated_at=updated_at+1,status='permanent' WHERE id=3; UPDATE memories SET expires_at=1700000000000 WHERE id=5; UPDATE memories SET status='archived' WHERE id=6; INSERT INTO memory_verifications(memory_id,file_path,verified_at) VALUES(2,'z.rs',0),(2,'',0),(2,'a.rs',0);").unwrap();
        let snapshot = load_snapshot(&mut conn, "project-a", NOW).unwrap();
        assert_eq!(
            snapshot.iter().map(|m| m.id).collect::<Vec<_>>(),
            vec![3, 2, 1]
        );
        assert_eq!(snapshot[1].mapped_files, vec!["a.rs", "z.rs"]);
        assert!(snapshot[1].has_no_file_sentinel);
        assert_eq!(snapshot[1].importance, 90.0);
        assert!(conn.is_autocommit());
    }

    #[test]
    fn pinned_ts_snapshot_defaults_and_invalid_row_filter_match() {
        let mut conn = database();
        for id in 1..=8 {
            insert(
                &conn,
                id,
                "project-a",
                "CONFIG_VALUES",
                &format!("Fact {id}"),
            );
        }
        conn.execute_batch(
            "UPDATE memories SET importance=NULL WHERE id=1;
            UPDATE memories SET seen_count=NULL WHERE id=2;
            UPDATE memories SET source_type='invalid' WHERE id=3;
            UPDATE memories SET verification_status=NULL WHERE id=4;
            UPDATE memories SET category='UNKNOWN' WHERE id=5;
            UPDATE memories SET scope='invalid' WHERE id=6;
            UPDATE memories SET importance=25.5,seen_count=2.5,retrieval_count=0.5 WHERE id=7;
            UPDATE memories SET status='permanent' WHERE id=8;",
        )
        .unwrap();
        let snapshot = load_snapshot(&mut conn, "project-a", NOW).unwrap();
        let actual: Vec<_> = snapshot
            .iter()
            .map(|m| (m.id, m.importance, m.seen_count, m.retrieval_count))
            .collect();
        assert_eq!(
            actual,
            vec![
                (1, 50.0, 1.0, 0.0),
                (7, 25.5, 2.5, 0.5),
                (8, 90.0, 1.0, 0.0)
            ]
        );
        assert!(render_memories(&snapshot)
            .contains("importance=25.5 retrieval_count=0.5 seen_count=2.5"));
    }

    #[test]
    fn history_snapshots_and_merge_journal_retain_the_complete_undo_unit() {
        let mut conn = database();
        insert(&conn, 1, "project-a", "CONFIG_VALUES", "Limit is 12.");
        insert(&conn, 2, "project-a", "CONFIG_VALUES", "Limit is 24.");
        insert(&conn, 3, "project-a", "CONFIG_VALUES", "Limit is 48.");
        let before = rows(&conn, "SELECT * FROM memories ORDER BY id");
        let mut tools = plan("CONFIG_VALUES").tools(context());
        let update =
            json!({"action":"update","ids":[1],"content":"Limit is 16.","reason":"measured limit"});
        tools
            .execute(&mut conn, &Queue, "update", NOW, &update)
            .unwrap();
        let merge = json!({"action":"merge","ids":[1,2],"content":"Combined limit is 24.","reason":"duplicate facts"});
        tools
            .execute(&mut conn, &Queue, "merge", NOW, &merge)
            .unwrap();
        let archive = json!({"action":"archive","ids":[3],"superseded_by":4,"reason":"canonical limit survives"});
        tools
            .execute(&mut conn, &Queue, "archive", NOW, &archive)
            .unwrap();
        let after = rows(&conn, "SELECT * FROM memories ORDER BY id");
        let history = rows(&conn, "SELECT * FROM memory_history ORDER BY id");
        assert_eq!(history.as_array().unwrap().len(), 5);
        for (index, id, old, new, reason) in [
            (0, 1, "Limit is 12.", "Limit is 16.", "measured limit"),
            (1, 1, "Limit is 16.", "Limit is 16.", "duplicate facts"),
            (2, 2, "Limit is 24.", "Limit is 24.", "duplicate facts"),
            (
                4,
                3,
                "Limit is 48.",
                "Limit is 48.",
                "canonical limit survives",
            ),
        ] {
            let row = &history[index];
            assert_eq!(row["memory_id"], id);
            assert_eq!(row["previous_text"], old);
            assert_eq!(row["after_text"], new);
            assert_eq!(row["reason"], reason);
            let prior: Value = serde_json::from_str(row["before_json"].as_str().unwrap()).unwrap();
            let next: Value = serde_json::from_str(row["after_json"].as_str().unwrap()).unwrap();
            assert_eq!(prior["version"], 1);
            assert_eq!(next["version"], 1);
            let prior = &prior["snapshot"];
            let next = &next["snapshot"];
            assert_eq!(prior["id"], id);
            assert_eq!(next["id"], id);
            assert_eq!(prior["content"], old);
            assert_eq!(next["content"], new);
            assert_eq!(
                next["revision"].as_i64().unwrap(),
                prior["revision"].as_i64().unwrap() + 1
            );
        }
        let journal = rows(&conn, "SELECT * FROM memory_journal ORDER BY id");
        assert_eq!(journal.as_array().unwrap().len(), 3);
        let merge_before: Value =
            serde_json::from_str(journal[1]["before_json"].as_str().unwrap()).unwrap();
        let merge_after: Value =
            serde_json::from_str(journal[1]["after_json"].as_str().unwrap()).unwrap();
        assert_eq!(journal[1]["operation"], "curate_merge");
        assert_eq!(merge_before["rows"].as_array().unwrap().len(), 3);
        assert_eq!(merge_before["rows"][0]["before"]["content"], "Limit is 16.");
        assert_eq!(
            merge_before["rows"][1]["before"],
            mc_store::memory_history::normalize_snapshot(&before[1], None).unwrap()
        );
        assert!(
            merge_before["rows"][2]["before"].is_null(),
            "the new survivor did not exist before this unit"
        );
        assert_eq!(merge_after, merge_before);
        for (index, row) in [0, 1, 3].into_iter().enumerate() {
            assert_eq!(
                merge_after["rows"][index]["after"],
                mc_store::memory_history::normalize_snapshot(&after[row], None).unwrap()
            );
        }
        assert_eq!(history[3]["memory_id"], 4);
        assert_eq!(history[3]["revision"], 0);
        let survivor_before: Value =
            serde_json::from_str(history[3]["before_json"].as_str().unwrap()).unwrap();
        assert!(survivor_before["snapshot"].is_null());
        let effects = rows(&conn, "SELECT effect_json FROM test_embedding_queue");
        assert_eq!(effects.as_array().unwrap().len(), 5);
        let effect_kinds: Vec<_> = effects
            .as_array()
            .unwrap()
            .iter()
            .map(|row| {
                serde_json::from_str::<Value>(row["effect_json"].as_str().unwrap()).unwrap()["kind"]
                    .clone()
            })
            .collect();
        assert_eq!(
            json!(effect_kinds),
            json!(["embed", "invalidate", "invalidate", "embed", "invalidate"])
        );
        assert_eq!(
            tools
                .execute(&mut conn, &Queue, "archive", NOW, &archive)
                .unwrap(),
            "Archived memory [ID: 3] (canonical limit survives)."
        );
        assert_eq!(
            rows(&conn, "SELECT * FROM memory_history ORDER BY id"),
            history,
            "transport retry is effect-free"
        );
        assert_eq!(
            rows(&conn, "SELECT effect_json FROM test_embedding_queue"),
            effects
        );
    }

    #[test]
    fn failed_embedding_queue_rolls_back_history_journal_and_memory() {
        struct FailingQueue;
        impl MemoryEmbeddingQueue for FailingQueue {
            fn enqueue_tx(
                &self,
                tx: &Transaction<'_>,
                effect: &EmbeddingEffect,
            ) -> rusqlite::Result<()> {
                Queue.enqueue_tx(tx, effect)?;
                Err(rusqlite::Error::InvalidQuery)
            }
        }
        let mut conn = database();
        insert(&conn, 1, "project-a", "CONFIG_VALUES", "Limit is 12.");
        let before = rows(&conn, "SELECT * FROM memories");
        let result = plan("CONFIG_VALUES").tools(context()).execute(
            &mut conn,
            &FailingQueue,
            "failed",
            NOW,
            &json!({"action":"update","ids":[1],"content":"Limit is 24."}),
        );
        assert!(result.is_err());
        assert_eq!(rows(&conn, "SELECT * FROM memories"), before);
        for table in [
            "memory_history",
            "memory_journal",
            "memory_decision_receipts",
            "test_embedding_queue",
        ] {
            assert_eq!(rows(&conn, &format!("SELECT * FROM {table}")), json!([]));
        }
    }

    #[test]
    fn background_writes_leave_cache_epoch_and_ts_authority_unchanged() {
        let mut conn = database();
        conn.execute(
            "INSERT INTO project_state(project_path,project_memory_epoch) VALUES('project-a',7)",
            [],
        )
        .unwrap();
        let state = rows(&conn, "SELECT * FROM project_state");
        let mut tools = plan("CONFIG_VALUES").tools(context());
        tools
            .execute(
                &mut conn,
                &Queue,
                "write",
                NOW,
                &json!({"action":"write","category":"CONFIG_VALUES","content":"Limit is 12."}),
            )
            .unwrap();
        tools
            .execute(
                &mut conn,
                &Queue,
                "update",
                NOW,
                &json!({"action":"update","ids":[1],"content":"Limit is 24."}),
            )
            .unwrap();
        assert_eq!(rows(&conn, "SELECT * FROM project_state"), state);
        for table in [
            "authority_managed",
            "authority_repair_pending",
            "memory_pending_facts",
            "memory_agent_fragments",
        ] {
            assert_eq!(rows(&conn, &format!("SELECT * FROM {table}")), json!([]));
        }
        assert_eq!(
            rows(&conn, "SELECT COUNT(*) AS n FROM memories"),
            json!([{"n":1}])
        );
    }

    // The existing TypeScript curator splits snapshots and renders child prompts
    // with task-prompts.ts. The hashes pin its 4,000-token default and require
    // identical Rust batches and prompt bytes without copying the TS template
    // into the expected values.
    #[test]
    fn pinned_ts_chunks_and_prompt_bytes_match() {
        let mut memories = vec![
            memory(1, "PROJECT_RULES", "Keep the rule"),
            memory(2, "PROJECT_RULES", "A distinct rule 😀"),
            memory(3, "PROJECT_RULES", "keep THE rule!"),
            memory(4, "PROJECT_RULES", "İx Ⅷ"),
            memory(5, "PROJECT_RULES", "i̇x ⅷ"),
        ];
        memories[3].has_no_file_sentinel = true;
        memories[4].mapped_files.clear();
        let expected = json!([
            {"max":110,"chunks":[
                {"ids":[1],"candidates":["IDs 1, 3"],"sha":"1b68c3193bfb53b2b7940ad72b40ee3ad0719d68081f08032981b3b8cbedd3eb"},
                {"ids":[2],"candidates":[],"sha":"954401b74314f6e41cd5649f3b9cced92b937150ed37e8747297edf626b8e298"},
                {"ids":[3],"candidates":["IDs 1, 3"],"sha":"d58a7460e37704dc766ce95ca3479b1c8ee0583a94256cc3b7d06b4f54685ddf"},
                {"ids":[4],"candidates":["IDs 4, 5"],"sha":"82fa62d224a6cd8aa8fb612cc9dac7af91116dff074e91e9b34abc546d7f0ebf"},
                {"ids":[5],"candidates":["IDs 4, 5"],"sha":"9212a91032df21dcc69483a0d4f0fa6484553e179747f870bfde604b9c2adb2a"}]},
            {"max":280,"chunks":[
                {"ids":[1,2],"candidates":["IDs 1, 3"],"sha":"5d012f519019e78d7a00363c273f75727cb5978cae3860014b00a9e8b60b4a27"},
                {"ids":[3,4],"candidates":["IDs 1, 3","IDs 4, 5"],"sha":"6867610cbd7090d207ee6d4731eb3fc92ca59a040e03c9646d73ec185c0f4ab7"},
                {"ids":[5],"candidates":["IDs 4, 5"],"sha":"9212a91032df21dcc69483a0d4f0fa6484553e179747f870bfde604b9c2adb2a"}]},
            {"max":10000,"chunks":[{"ids":[1,2,3,4,5],"candidates":[],"sha":"13d97bb6cfc321199e8d1f218398757c4308fb76a46c406cd30547522d5d9371"}]}
        ]);
        for case in expected.as_array().unwrap() {
            let actual: Vec<_> = chunk_memories(&memories, case["max"].as_u64().unwrap() as usize)
                .iter()
                .map(|chunk| {
                    json!({
                        "ids":chunk.memories.iter().map(|m|m.id).collect::<Vec<_>>(),
                        "candidates":chunk.cross_chunk_candidates,
                        "sha":sha(&build_prompt("/repo","PROJECT_RULES",chunk,McModuleConfig::default().memory_budget_tokens)),
                    })
                })
                .collect();
            assert_eq!(json!(actual), case["chunks"]);
        }
        assert_eq!(
            sha(SYSTEM_PROMPT),
            "31cb8223887fd5fedb6968cb5d49cde5841f59235a85349ecba80fe487036eb3"
        );
        let localized = crate::historian_prompt::with_content_language_directive(
            SYSTEM_PROMPT,
            Some("tr"),
            Default::default(),
        );
        assert_eq!(
            sha(&localized),
            "a637e709ee1e7c25ea5e77829ce90b7dac9f511d8d188907f6a352757c8ffb74"
        );
    }

    // The existing TypeScript curator selects a populated category, resumes it on
    // interruption and advances only after success. Running beginCurateCategoryRun
    // and curateTaskStateAfterSuccess against a throwaway database at revision
    // 282d9c08bce490346583a3b8c145c402499f980f recorded these state transitions,
    // which the Rust task must preserve.
    #[test]
    fn pinned_ts_category_rotation_and_retry_state_match() {
        let cases = json!([
            [null,[[7,"NAMING"],[8,"WORKFLOW_RULES"]],"PROJECT_RULES",[8],{"curate":{"cursor":0,"activeCategory":"PROJECT_RULES"}},{"curate":{"cursor":1}}],
            ["{\"curate\":{\"cursor\":3},\"other\":{\"keep\":true}}",[[7,"NAMING"],[8,"WORKFLOW_RULES"]],"NAMING",[7],{"curate":{"cursor":3,"activeCategory":"NAMING"},"other":{"keep":true}},{"curate":{"cursor":0},"other":{"keep":true}}],
            ["{\"curate\":{\"cursor\":4,\"activeCategory\":\"ARCHITECTURE\"},\"other\":1}",[[1,"ARCHITECTURE_DECISIONS"],[2,"NAMING"]],"ARCHITECTURE",[1],{"curate":{"cursor":4,"activeCategory":"ARCHITECTURE"},"other":1},{"curate":{"cursor":2},"other":1}],
            ["{\"curate\":{\"cursor\":0,\"activeCategory\":\"CONSTRAINTS\"}}",[[2,"NAMING"]],"NAMING",[2],{"curate":{"cursor":0,"activeCategory":"NAMING"}},{"curate":{"cursor":0}}],
            ["{\"curate\":{\"cursor\":-1}}",[[2,"UNKNOWN"],[3,"CONFIG_DEFAULTS"]],"CONFIG_VALUES",[3],{"curate":{"cursor":0,"activeCategory":"CONFIG_VALUES"}},{"curate":{"cursor":4}}],
            ["{\"curate\":{\"cursor\":1.5}}",[[3,"ENVIRONMENT"],[4,"KNOWN_ISSUES"]],"CONSTRAINTS",[4],{"curate":{"cursor":0,"activeCategory":"CONSTRAINTS"}},{"curate":{"cursor":3}}],
            ["{\"curate\":{\"cursor\":12}}",[[3,"ENVIRONMENT"],[4,"KNOWN_ISSUES"]],"CONSTRAINTS",[4],{"curate":{"cursor":2,"activeCategory":"CONSTRAINTS"}},{"curate":{"cursor":3}}],
            ["[]",[[1,"NAMING"]],"NAMING",[1],{"curate":{"cursor":0,"activeCategory":"NAMING"}},{"curate":{"cursor":0}}],
            ["not JSON",[[1,"USER_PREFERENCES"]],"PROJECT_RULES",[1],{"curate":{"cursor":0,"activeCategory":"PROJECT_RULES"}},{"curate":{"cursor":1}}],
            [null,[[1,"UNKNOWN"]],null,[],null,null]
        ]);
        for case in cases.as_array().unwrap() {
            let memories: Vec<_> = case[1]
                .as_array()
                .unwrap()
                .iter()
                .map(|m| {
                    memory(
                        m[0].as_i64().unwrap(),
                        m[1].as_str().unwrap(),
                        "Keep the rule",
                    )
                })
                .collect();
            let plan = prepare(case[0].as_str(), &memories, 10000);
            if case[2].is_null() {
                assert!(plan.is_none());
                continue;
            }
            let plan = plan.unwrap();
            assert_eq!(plan.category, case[2]);
            assert_eq!(
                json!(plan
                    .chunks
                    .iter()
                    .flat_map(|c| c.memories.iter().map(|m| m.id))
                    .collect::<Vec<_>>()),
                case[3]
            );
            assert_eq!(plan.begin_state, case[4]);
            assert_eq!(plan.success_state, case[5]);
            let retry = prepare(Some(&plan.begin_state.to_string()), &memories, 10000).unwrap();
            assert_eq!(retry.category, plan.category);
        }
    }
}
