//! Synthetic-todowrite injection producer: canonical todo-state normalization,
//! the deterministic `mc_synthetic_todo_<hash>` call id, the byte-exact injected
//! pair, and the bust-only freeze / defer-replay transition.
//!
//! The functions that build the deterministic call id and byte-exact injected pair, and
//! the transition logic, are deliberately pure: the caller supplies the persisted todo
//! state and the currently frozen synthetic unit. The capture helper mutates only the
//! caller-owned [`mc_store::ModuleMeta`] so the change can be committed in the same pass
//! as the cache-state transition.

#[cfg(test)]
use crate::selection::SelMessageRole;
use crate::selection::{SelItem, SelKind};
use mc_store::{
    CkKind, CkOutputKind, CkToolOutput, CkWireBlock, CkWireMessage, FrozenSyntheticTodoPair,
    HarnessMeta, ModuleMeta, ProviderExtras,
};
use serde::Serialize;
#[cfg(test)]
use serde_json::Value;
use sha2::{Digest, Sha256};

const SYNTHETIC_CALL_ID_PREFIX: &str = "mc_synthetic_todo_";
const TODO_TOOL_NAME: &str = "todowrite";
const DEFAULT_PRIORITY: &str = "medium";
const COMPLETED_STATUS: &str = "completed";
const TERMINAL_STATUSES: &[&str] = &["completed", "cancelled"];
const TITLE_DONE_STATUSES: &[&str] = &["completed"];
pub(crate) const SYNTHETIC_TIMESTAMP: i64 = 0;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct TodoItem {
    content: String,
    status: String,
    priority: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct TodoInput {
    todos: Vec<TodoItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct TodoMetadata {
    todos: Vec<TodoItem>,
    truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct SyntheticTime {
    start: i64,
    end: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct SyntheticState {
    status: &'static str,
    input: TodoInput,
    output: String,
    title: String,
    metadata: TodoMetadata,
    time: SyntheticTime,
}

/// The CK-native synthetic todowrite pair produced from one normalized todo state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyntheticTodo {
    /// Shared synthetic tool-call id used by both halves of the injected pair.
    pub call_id: String,
    /// Canonical todo-state JSON that was hashed to produce [`Self::call_id`].
    pub state_json: String,
    /// Frozen assistant-role CK ToolCall message.
    pub assistant_msg: CkWireMessage,
    /// Frozen tool-role CK ToolResult message.
    pub tool_msg: CkWireMessage,
}

impl SyntheticTodo {
    /// Attach the tail message id present when this todo was composed to produce
    /// the persisted frozen pair.
    pub fn freeze_at(self, anchor_mid: Option<String>) -> FrozenSyntheticTodoPair {
        FrozenSyntheticTodoPair {
            call_id: self.call_id,
            anchor_mid,
            assistant_msg: self.assistant_msg,
            tool_msg: self.tool_msg,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InjectionOutcome {
    /// Keep replaying the currently frozen unit byte-for-byte.
    Keep,
    /// Freeze this newly built unit and replay its bytes from now on.
    Replace(Box<SyntheticTodo>),
    /// Remove the currently frozen unit because the current todo state no longer produces synthetic bytes.
    Clear,
    /// No valid state exists, or no frozen unit exists for a no-op transition.
    None,
}

/// Normalize raw `todowrite` todos JSON into the stable state string used for hashing.
///
/// The accepted input is a JSON array. Each item must be an object with string
/// `content` and `status`; `priority` is optional and defaults to `"medium"`.
/// Extra fields are stripped, and the output field order is always
/// `content`, `status`, then `priority`. If any item is malformed, the whole
/// state is rejected.
pub fn normalize_todo_state_json(todos_json: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(todos_json).ok()?;
    let todos = value.as_array()?;
    let mut normalized = Vec::with_capacity(todos.len());
    for todo in todos {
        normalized.push(read_todo_item(todo)?);
    }
    serde_json::to_string(&normalized).ok()
}

/// Compute the deterministic `mc_synthetic_todo_<sha256[:16]>` call id.
pub fn synthetic_call_id(state_json: &str) -> String {
    let digest = Sha256::digest(state_json.as_bytes());
    let hex = format!("{digest:x}");
    format!("{}{}", SYNTHETIC_CALL_ID_PREFIX, &hex[..16])
}

/// Build the byte-complete synthetic todowrite pair for a normalized state JSON.
///
/// Returns [`None`] when the state is invalid, empty, or every todo is terminal
/// (`completed` or `cancelled`). Completed todos are excluded from the title's
/// active count, while cancelled todos are still counted there, matching the
/// real todowrite result title.
pub fn build_synthetic_todo_pair(state_json: &str) -> Option<SyntheticTodo> {
    let todos = parse_todo_state(state_json)?;
    if todos.is_empty() || todos.iter().all(|todo| is_terminal_status(&todo.status)) {
        return None;
    }

    let call_id = synthetic_call_id(state_json);
    let active_count = todos
        .iter()
        .filter(|todo| !is_title_done_status(&todo.status))
        .count();
    let output = serde_json::to_string_pretty(&todos).ok()?;
    let title = format!("{active_count} todos");
    let state = synthetic_state(todos.clone(), output, title);
    let input = serde_json::to_value(TodoInput {
        todos: todos.clone(),
    })
    .ok()?;
    let result_value = serde_json::to_value(state).ok()?;

    let assistant_msg = CkWireMessage::from_parts(
        "assistant",
        vec![CkWireBlock::bare(CkKind::ToolCall {
            id: call_id.clone(),
            name: TODO_TOOL_NAME.to_string(),
            input,
            provider_executed: false,
        })],
        None,
        ProviderExtras::new(),
        HarnessMeta {
            synthetic: true,
            ..Default::default()
        },
    );
    let tool_msg = CkWireMessage::from_parts(
        "tool",
        vec![CkWireBlock::bare(CkKind::ToolResult {
            id: call_id.clone(),
            tool_name: TODO_TOOL_NAME.to_string(),
            output: CkToolOutput::bare(CkOutputKind::Json {
                value: result_value,
            }),
            provider_executed: false,
        })],
        None,
        ProviderExtras::new(),
        HarnessMeta {
            synthetic: true,
            ..Default::default()
        },
    );

    Some(SyntheticTodo {
        call_id,
        state_json: state_json.to_string(),
        assistant_msg,
        tool_msg,
    })
}

/// Return true when an id belongs to the synthetic-todowrite namespace.
pub fn is_synthetic_todo_id(id: &str) -> bool {
    id.starts_with(SYNTHETIC_CALL_ID_PREFIX)
}

/// Capture the newest `todowrite` ToolCall from the visible tail into session metadata.
///
/// Capture happens only on bust passes while the native tool is available. If no valid
/// todowrite call is present, the previous metadata value is left intact because an older
/// todowrite may already be saved in this session. An explicit empty or all-terminal todowrite
/// is still captured so the next step can clear any frozen synthetic unit when the real todo
/// state is terminal. A missing availability verdict fails open for legacy senders.
pub fn capture_todo_state_on_bust(
    meta: &mut ModuleMeta,
    tail: &[SelItem],
    is_bust_pass: bool,
    todo_tool_present: Option<bool>,
) -> bool {
    if !is_bust_pass || todo_tool_present == Some(false) {
        return false;
    }
    let Some((owner_message_id, state_json)) = newest_todowrite_state_json(tail) else {
        return false;
    };
    meta.last_todo_state = Some(state_json.clone());
    meta.last_todo_state_owner_message_id = Some(owner_message_id);
    meta.last_todo_state_hash = Some(todo_state_hash(&state_json));
    true
}

/// Compose the synthetic-todo transition from [`ModuleMeta::last_todo_state`].
///
/// The metadata is per-session durable state, so an aged-out todowrite continues to inject until
/// another bust captures a new view. Defer passes ignore the metadata and replay the frozen unit
/// verbatim. A frozen unavailable verdict makes the state effectively empty only on a bust.
pub fn advance_injection_from_meta(
    meta: &ModuleMeta,
    frozen: Option<&FrozenSyntheticTodoPair>,
    is_bust_pass: bool,
    todo_tool_present: Option<bool>,
) -> InjectionOutcome {
    advance_injection(
        meta.last_todo_state.as_deref(),
        frozen,
        is_bust_pass,
        todo_tool_present,
    )
}

/// Return whether the next eligible bust would replace or clear the frozen todo pair.
///
/// This predicate computes only the normalized state and call id. It deliberately avoids building
/// provider-visible tool messages before the pass classifier grants a bust. A visible real
/// `todowrite` takes precedence over older state-sync metadata when the tool is available. An
/// unavailable verdict reports only a pending clear for an existing pair; it never creates a bust.
pub fn injection_pending_after_capture(
    meta: &ModuleMeta,
    tail: &[SelItem],
    frozen: Option<&FrozenSyntheticTodoPair>,
    todo_tool_present: Option<bool>,
) -> bool {
    if todo_tool_present == Some(false) {
        return frozen.is_some();
    }

    let visible_state = newest_todowrite_state_json(tail).map(|(_, state_json)| state_json);
    let persisted_state = visible_state.as_deref().or(meta.last_todo_state.as_deref());
    let Some(normalized) = persisted_state.and_then(normalize_todo_state_json) else {
        return false;
    };
    let Some(todos) = parse_todo_state(&normalized) else {
        return false;
    };
    let next_call_id = (!todos.is_empty()
        && !todos.iter().all(|todo| is_terminal_status(&todo.status)))
    .then(|| synthetic_call_id(&normalized));

    match (next_call_id.as_deref(), frozen) {
        (Some(call_id), Some(current)) => current.call_id != call_id,
        (Some(_), None) | (None, Some(_)) => true,
        (None, None) => false,
    }
}

/// Capture (if this is a bust pass and the native tool is available) before composing the
/// synthetic-todo transition.
///
/// This ordering lets a first-ever todowrite be captured and injected in the same cache bust
/// instead of lagging one pass behind.
pub fn advance_injection_after_capture(
    meta: &mut ModuleMeta,
    tail: &[SelItem],
    frozen: Option<&FrozenSyntheticTodoPair>,
    is_bust_pass: bool,
    todo_tool_present: Option<bool>,
) -> InjectionOutcome {
    capture_todo_state_on_bust(meta, tail, is_bust_pass, todo_tool_present);
    advance_injection_from_meta(meta, frozen, is_bust_pass, todo_tool_present)
}

/// Advance the frozen synthetic-todo unit for one pass without mutating storage.
///
/// Bust passes may replace or clear the frozen unit. Defer passes never build from the current
/// state and never clear: if a unit is already frozen they return [`InjectionOutcome::Keep`],
/// otherwise there is no unit to replay. A frozen unavailable verdict is treated as an empty todo
/// state on busts, while an absent verdict fails open for legacy senders.
pub fn advance_injection(
    persisted_state_json: Option<&str>,
    frozen: Option<&FrozenSyntheticTodoPair>,
    is_bust_pass: bool,
    todo_tool_present: Option<bool>,
) -> InjectionOutcome {
    if !is_bust_pass {
        return if frozen.is_some() {
            InjectionOutcome::Keep
        } else {
            InjectionOutcome::None
        };
    }

    let effective_state_json = if todo_tool_present == Some(false) {
        Some("[]")
    } else {
        persisted_state_json
    };
    let Some(state_json) = effective_state_json else {
        return InjectionOutcome::None;
    };
    let Some(normalized) = normalize_todo_state_json(state_json) else {
        return InjectionOutcome::None;
    };
    let Some(next) = build_synthetic_todo_pair(&normalized) else {
        return if frozen.is_some() {
            InjectionOutcome::Clear
        } else {
            InjectionOutcome::None
        };
    };

    if frozen
        .map(|unit| unit.call_id.as_str() == next.call_id.as_str())
        .unwrap_or(false)
    {
        InjectionOutcome::Keep
    } else {
        InjectionOutcome::Replace(Box::new(next))
    }
}

fn synthetic_state(todos: Vec<TodoItem>, output: String, title: String) -> SyntheticState {
    SyntheticState {
        status: COMPLETED_STATUS,
        input: TodoInput {
            todos: todos.clone(),
        },
        output,
        title,
        metadata: TodoMetadata {
            todos,
            truncated: false,
        },
        time: SyntheticTime {
            start: SYNTHETIC_TIMESTAMP,
            end: SYNTHETIC_TIMESTAMP,
        },
    }
}

#[cfg(test)]
fn synthetic_result_state_value(state_json: &str) -> Option<Value> {
    let todos = parse_todo_state(state_json)?;
    if todos.is_empty() || todos.iter().all(|todo| is_terminal_status(&todo.status)) {
        return None;
    }
    let active_count = todos
        .iter()
        .filter(|todo| !is_title_done_status(&todo.status))
        .count();
    let output = serde_json::to_string_pretty(&todos).ok()?;
    let title = format!("{active_count} todos");
    serde_json::to_value(synthetic_state(todos, output, title)).ok()
}

fn parse_todo_state(state_json: &str) -> Option<Vec<TodoItem>> {
    if state_json.is_empty() {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(state_json).ok()?;
    let items = value.as_array()?;
    let mut todos = Vec::with_capacity(items.len());
    for item in items {
        if let Some(todo) = read_todo_item(item) {
            todos.push(todo);
        }
    }
    Some(todos)
}

fn read_todo_item(value: &serde_json::Value) -> Option<TodoItem> {
    let obj = value.as_object()?;
    let content = obj.get("content")?.as_str()?.to_string();
    let status = obj.get("status")?.as_str()?.to_string();
    let priority = match obj.get("priority") {
        None => DEFAULT_PRIORITY.to_string(),
        Some(serde_json::Value::String(priority)) => priority.clone(),
        Some(_) => return None,
    };
    Some(TodoItem {
        content,
        status,
        priority,
    })
}

fn is_terminal_status(status: &str) -> bool {
    TERMINAL_STATUSES.contains(&status)
}

fn is_title_done_status(status: &str) -> bool {
    TITLE_DONE_STATUSES.contains(&status)
}

fn newest_todowrite_state_json(tail: &[SelItem]) -> Option<(String, String)> {
    let mut latest: Option<(u64, usize, String, String)> = None;
    for (index, item) in tail.iter().enumerate() {
        let SelKind::ToolCall { name, input } = &item.kind else {
            continue;
        };
        if !name.eq_ignore_ascii_case(TODO_TOOL_NAME) {
            continue;
        }
        let Some(state_json) = todo_state_from_input(input) else {
            continue;
        };
        let replace = latest
            .as_ref()
            .map(|(ordinal, seen_index, _, _)| {
                item.ordinal > *ordinal || (item.ordinal == *ordinal && index > *seen_index)
            })
            .unwrap_or(true);
        if replace {
            let owner_message_id = item
                .id
                .split_once('#')
                .map(|(mid, _)| mid.to_string())
                .unwrap_or_else(|| item.id.clone());
            latest = Some((item.ordinal, index, owner_message_id, state_json));
        }
    }
    latest.map(|(_, _, owner_message_id, state_json)| (owner_message_id, state_json))
}

fn todo_state_hash(state_json: &str) -> String {
    let digest = Sha256::digest(state_json.as_bytes());
    format!("{digest:x}")
}

/// Normalize the todo list a `todowrite` call carries, either as `{todos: [...]}`
/// or as the bare array.
pub(crate) fn todo_state_from_input(input: &serde_json::Value) -> Option<String> {
    let todos = input.get("todos").unwrap_or(input);
    let todos_json = serde_json::to_string(todos).ok()?;
    normalize_todo_state_json(&todos_json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Deserialize)]
    struct GoldenFile {
        constants: GoldenConstants,
        cases: Vec<GoldenCase>,
    }

    #[derive(Debug, Deserialize)]
    struct GoldenConstants {
        synthetic_call_id_prefix: String,
        terminal_statuses: Vec<String>,
        title_done_statuses: Vec<String>,
        default_priority: String,
        tool_name: String,
        completed_status: String,
        synthetic_timestamp: i64,
    }

    #[derive(Debug, Deserialize)]
    struct GoldenCase {
        label: String,
        input_json: String,
        normalized: Option<String>,
        call_id: Option<String>,
        result_state_json: Option<String>,
    }

    fn load_golden() -> GoldenFile {
        let raw = include_str!("../testdata/injection-golden.json");
        serde_json::from_str(raw).expect("parse injection-golden.json")
    }

    fn active_state(label: &str) -> String {
        normalize_todo_state_json(&format!(
            r#"[{{"content":"{label}","status":"in_progress","priority":"high"}}]"#
        ))
        .expect("active state normalizes")
    }

    fn terminal_state() -> String {
        normalize_todo_state_json(
            r#"[
                {"content":"Done","status":"completed","priority":"high"},
                {"content":"Cancelled","status":"cancelled","priority":"low"}
            ]"#,
        )
        .expect("terminal state normalizes")
    }

    fn frozen_for(state_json: &str) -> FrozenSyntheticTodoPair {
        build_synthetic_todo_pair(state_json)
            .expect("state builds synthetic todo")
            .freeze_at(Some("anchor".to_string()))
    }

    fn todowrite_tail_item(id: &str, ordinal: u64, state_json: &str) -> SelItem {
        let todos: serde_json::Value = serde_json::from_str(state_json).expect("todo state JSON");
        SelItem {
            user_answer: false,
            served_token_count: None,
            id: id.to_string(),
            ordinal,
            message_role: SelMessageRole::Assistant,
            kind: SelKind::ToolCall {
                name: TODO_TOOL_NAME.to_string(),
                input: serde_json::json!({ "todos": todos }),
            },
            provider_executed: false,
            byte_size: 0,
            token_count: None,
            arc_id: Some(id.to_string()),
        }
    }

    #[test]
    fn constants_match_ts_golden() {
        let constants = load_golden().constants;
        assert_eq!(constants.synthetic_call_id_prefix, SYNTHETIC_CALL_ID_PREFIX);
        assert_eq!(constants.terminal_statuses, TERMINAL_STATUSES);
        assert_eq!(constants.title_done_statuses, TITLE_DONE_STATUSES);
        assert_eq!(constants.default_priority, DEFAULT_PRIORITY);
        assert_eq!(constants.tool_name, TODO_TOOL_NAME);
        assert_eq!(constants.completed_status, COMPLETED_STATUS);
        assert_eq!(constants.synthetic_timestamp, SYNTHETIC_TIMESTAMP);
    }

    #[test]
    fn injection_golden_matches_ts_todo_view() {
        let golden = load_golden();
        assert!(!golden.cases.is_empty(), "empty injection golden");

        for case in golden.cases {
            let normalized = normalize_todo_state_json(&case.input_json);
            assert_eq!(normalized, case.normalized, "normalize: {}", case.label);

            if let Some(state_json) = normalized {
                assert_eq!(
                    Some(synthetic_call_id(&state_json)),
                    case.call_id,
                    "call id: {}",
                    case.label
                );
                let result_state = synthetic_result_state_value(&state_json);
                let expected_state = case
                    .result_state_json
                    .as_deref()
                    .map(|raw| serde_json::from_str::<Value>(raw).expect("golden result state"));
                assert_eq!(result_state, expected_state, "result state: {}", case.label);
                assert_eq!(
                    build_synthetic_todo_pair(&state_json).is_some(),
                    case.result_state_json.is_some(),
                    "CK pair build/no-build: {}",
                    case.label
                );
            } else {
                assert_eq!(case.call_id, None, "invalid state call id: {}", case.label);
                assert_eq!(
                    case.result_state_json, None,
                    "invalid result state: {}",
                    case.label
                );
            }
        }
    }

    #[test]
    fn defer_never_replaces_but_bust_does() {
        let old_state = active_state("old");
        let new_state = active_state("new");
        let frozen = frozen_for(&old_state);

        assert_eq!(
            advance_injection(Some(&new_state), Some(&frozen), false, None),
            InjectionOutcome::Keep
        );
        assert!(matches!(
            advance_injection(Some(&new_state), Some(&frozen), true, None),
            InjectionOutcome::Replace(todo) if todo.call_id == synthetic_call_id(&new_state)
        ));
    }

    #[test]
    fn defer_never_clears_but_bust_does() {
        let frozen = frozen_for(&active_state("active"));
        let terminal = terminal_state();

        assert_eq!(
            advance_injection(Some(&terminal), Some(&frozen), false, None),
            InjectionOutcome::Keep
        );
        assert_eq!(
            advance_injection(Some(&terminal), Some(&frozen), true, None),
            InjectionOutcome::Clear
        );
    }

    #[test]
    fn same_state_bust_is_idempotent() {
        let state = active_state("same");
        let frozen = frozen_for(&state);

        assert_eq!(
            advance_injection(Some(&state), Some(&frozen), true, None),
            InjectionOutcome::Keep
        );
    }

    #[test]
    fn provisional_verdict_keeps_capture_and_composition_fail_open() {
        let older = active_state("older visible todo");
        let newest = active_state("newest visible todo");
        let mut meta = ModuleMeta::default();
        let tail = vec![
            todowrite_tail_item("m-old#0", 1, &older),
            todowrite_tail_item("m-new#0", 2, &newest),
        ];

        let outcome = advance_injection_after_capture(&mut meta, &tail, None, true, None);

        assert_eq!(meta.last_todo_state.as_deref(), Some(newest.as_str()));
        assert!(matches!(
            outcome,
            InjectionOutcome::Replace(todo)
                if todo.state_json == newest && todo.call_id == synthetic_call_id(&newest)
        ));
    }

    #[test]
    fn enabled_verdict_keeps_capture_and_composition_behavior() {
        let state = active_state("enabled visible todo");
        let mut meta = ModuleMeta::default();
        let tail = vec![todowrite_tail_item("m-enabled#0", 1, &state)];

        let outcome = advance_injection_after_capture(&mut meta, &tail, None, true, Some(true));

        assert_eq!(meta.last_todo_state.as_deref(), Some(state.as_str()));
        assert!(matches!(
            outcome,
            InjectionOutcome::Replace(todo) if todo.state_json == state
        ));
    }

    #[test]
    fn disabled_verdict_replays_until_bust_then_clears_without_recapture() {
        let persisted = active_state("persisted before disable");
        let visible = active_state("visible pre-disable call");
        let frozen = frozen_for(&persisted);
        let frozen_before = frozen.clone();
        let mut meta = ModuleMeta {
            last_todo_state: Some(persisted.clone()),
            ..Default::default()
        };
        let tail = vec![todowrite_tail_item("m-visible#0", 9, &visible)];

        assert_eq!(
            advance_injection_after_capture(&mut meta, &tail, Some(&frozen), false, Some(false)),
            InjectionOutcome::Keep
        );
        assert_eq!(
            frozen, frozen_before,
            "defer must keep the frozen pair byte-stable"
        );
        assert_eq!(meta.last_todo_state.as_deref(), Some(persisted.as_str()));
        assert!(injection_pending_after_capture(
            &meta,
            &tail,
            Some(&frozen),
            Some(false),
        ));

        assert_eq!(
            advance_injection_after_capture(&mut meta, &tail, Some(&frozen), true, Some(false)),
            InjectionOutcome::Clear
        );
        assert_eq!(
            meta.last_todo_state.as_deref(),
            Some(persisted.as_str()),
            "disabled capture must not overwrite metadata from the visible tail"
        );
        assert!(!injection_pending_after_capture(
            &meta,
            &tail,
            None,
            Some(false),
        ));
    }

    #[test]
    fn aged_out_todowrite_injects_from_module_meta() {
        let state = active_state("aged out but persisted");
        let mut meta = ModuleMeta {
            last_todo_state: Some(state.clone()),
            ..Default::default()
        };

        let outcome = advance_injection_after_capture(&mut meta, &[], None, true, None);

        assert_eq!(meta.last_todo_state.as_deref(), Some(state.as_str()));
        assert!(matches!(
            outcome,
            InjectionOutcome::Replace(todo) if todo.state_json == state
        ));
    }

    #[test]
    fn explicit_empty_todowrite_clears_terminal_state() {
        let active = active_state("will be cleared");
        let frozen = frozen_for(&active);
        let mut meta = ModuleMeta {
            last_todo_state: Some(active),
            ..Default::default()
        };
        let tail = vec![todowrite_tail_item("m-clear#0", 9, "[]")];

        let outcome = advance_injection_after_capture(&mut meta, &tail, Some(&frozen), true, None);

        assert_eq!(meta.last_todo_state.as_deref(), Some("[]"));
        assert_eq!(outcome, InjectionOutcome::Clear);
    }

    #[test]
    fn defer_after_capture_replays_frozen_bytes() {
        let captured = active_state("captured before defer");
        let mut meta = ModuleMeta::default();
        let first = advance_injection_after_capture(
            &mut meta,
            &[todowrite_tail_item("m-first#0", 1, &captured)],
            None,
            true,
            None,
        );
        let InjectionOutcome::Replace(todo) = first else {
            panic!("first bust should freeze a synthetic todo");
        };
        let frozen = (*todo).clone().freeze_at(Some("m-first".to_string()));
        let frozen_before = frozen.clone();
        let defer_visible = active_state("visible only on defer");

        let outcome = advance_injection_after_capture(
            &mut meta,
            &[todowrite_tail_item("m-defer#0", 2, &defer_visible)],
            Some(&frozen),
            false,
            None,
        );

        assert_eq!(outcome, InjectionOutcome::Keep);
        assert_eq!(meta.last_todo_state.as_deref(), Some(captured.as_str()));
        assert_eq!(
            frozen, frozen_before,
            "defer must replay frozen bytes verbatim"
        );
    }

    #[test]
    fn persisted_last_todo_state_survives_restart_without_tail() {
        let state = active_state("persisted across restart");
        let meta_json = serde_json::to_string(&ModuleMeta {
            last_todo_state: Some(state.clone()),
            ..Default::default()
        })
        .expect("serialize meta");
        let mut restarted: ModuleMeta = serde_json::from_str(&meta_json).expect("load meta");

        let outcome = advance_injection_after_capture(&mut restarted, &[], None, true, None);

        assert_eq!(restarted.last_todo_state.as_deref(), Some(state.as_str()));
        assert!(matches!(
            outcome,
            InjectionOutcome::Replace(todo) if todo.state_json == state
        ));
    }

    #[test]
    fn empty_and_all_terminal_bust_clear_only_when_frozen() {
        let frozen = frozen_for(&active_state("active"));
        let empty = "[]";
        let terminal = terminal_state();

        assert_eq!(
            advance_injection(Some(empty), Some(&frozen), true, None),
            InjectionOutcome::Clear
        );
        assert_eq!(
            advance_injection(Some(empty), None, true, None),
            InjectionOutcome::None
        );
        assert_eq!(
            advance_injection(Some(&terminal), Some(&frozen), true, None),
            InjectionOutcome::Clear
        );
        assert_eq!(
            advance_injection(Some(&terminal), None, true, None),
            InjectionOutcome::None
        );
    }

    #[test]
    fn none_state_does_not_first_apply_until_next_bust() {
        let state = active_state("appears later");

        assert_eq!(
            advance_injection(None, None, true, None),
            InjectionOutcome::None
        );
        assert_eq!(
            advance_injection(Some(&state), None, false, None),
            InjectionOutcome::None
        );
        assert!(matches!(
            advance_injection(Some(&state), None, true, None),
            InjectionOutcome::Replace(todo) if todo.call_id == synthetic_call_id(&state)
        ));
    }

    #[test]
    fn transition_is_deterministic() {
        let old_state = active_state("old deterministic");
        let new_state = active_state("new deterministic");
        let frozen = frozen_for(&old_state);

        let first = advance_injection(Some(&new_state), Some(&frozen), true, None);
        let second = advance_injection(Some(&new_state), Some(&frozen), true, None);
        assert_eq!(first, second);

        let InjectionOutcome::Replace(todo) = first else {
            panic!("expected replacement");
        };
        let rebuilt = build_synthetic_todo_pair(&new_state).expect("new state builds");
        assert_eq!(*todo, rebuilt);
    }

    #[test]
    fn key_order_scrambling_keeps_call_id_stable() {
        let a = normalize_todo_state_json(
            r#"[{"content":"Scrambled","status":"pending","priority":"low","id":"drop-me"}]"#,
        )
        .expect("first shape normalizes");
        let b = normalize_todo_state_json(
            r#"[{"id":"drop-me","priority":"low","status":"pending","content":"Scrambled"}]"#,
        )
        .expect("second shape normalizes");

        assert_eq!(a, b);
        assert_eq!(synthetic_call_id(&a), synthetic_call_id(&b));
    }

    #[test]
    fn ck_pair_byte_determinism_golden() {
        let state = active_state("byte deterministic");
        let same = active_state("byte deterministic");
        let changed = active_state("byte changed");

        let first = build_synthetic_todo_pair(&state).expect("state builds");
        let second = build_synthetic_todo_pair(&same).expect("same state builds");
        let third = build_synthetic_todo_pair(&changed).expect("changed state builds");

        let first_bytes = (
            serde_json::to_vec(&first.assistant_msg).unwrap(),
            serde_json::to_vec(&first.tool_msg).unwrap(),
        );
        let second_bytes = (
            serde_json::to_vec(&second.assistant_msg).unwrap(),
            serde_json::to_vec(&second.tool_msg).unwrap(),
        );
        let third_bytes = (
            serde_json::to_vec(&third.assistant_msg).unwrap(),
            serde_json::to_vec(&third.tool_msg).unwrap(),
        );

        assert_eq!(first.call_id, second.call_id);
        assert_eq!(first_bytes, second_bytes);
        assert_ne!(first.call_id, third.call_id);
        assert_ne!(first_bytes, third_bytes);
        assert!(first.assistant_msg.meta.synthetic);
        assert!(first.tool_msg.meta.synthetic);
        assert!(matches!(
            first.assistant_msg.content.first().map(|block| &block.kind),
            Some(CkKind::ToolCall { name, provider_executed: false, .. }) if name == TODO_TOOL_NAME
        ));
        assert!(matches!(
            first.tool_msg.content.first().map(|block| &block.kind),
            Some(CkKind::ToolResult { tool_name, output, provider_executed: false, .. })
                if tool_name == TODO_TOOL_NAME && matches!(output.kind, CkOutputKind::Json { .. })
        ));
    }

    #[test]
    fn synthetic_id_detection_is_prefix_only() {
        assert!(is_synthetic_todo_id("mc_synthetic_todo_0123456789abcdef"));
        assert!(!is_synthetic_todo_id("toolu_0123456789abcdef"));
    }
}
