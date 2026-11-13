//! `ctx_memory`: the agent saves, changes and reads the memories of its
//! project and of its project's workspace. The argument rules and replies
//! began as the TypeScript tool's (`packages/plugin/src/tools/ctx-memory`);
//! the `level` argument and its replies are the module's own. The writes go
//! through [`crate::memory_writes`].
//!
//! A write goes to the session's project unless `level` names another
//! level. `workspace` files it for every project in the session's workspace,
//! when the session's memory profile allows the category there. `global`
//! saves no memory: global memories have one writer, the review that keeps
//! the user profile, so the fact is passed to that review as an observation.
//! Update, archive, merge and get take ids of the project's memories and of
//! the workspace's; any other memory is not the session's to read or change.

use rusqlite::Connection;
use serde_json::Value;

use crate::app_read::Change;
use crate::memory_writes::{self, MutationError, Operation, Refused, SaveLevel, Writer};

/// Categories a write may name.
const CATEGORIES: [&str; 12] = [
    "PROJECT_RULES",
    "ARCHITECTURE",
    "CONSTRAINTS",
    "CONFIG_VALUES",
    "NAMING",
    "ARCHITECTURE_DECISIONS",
    "CONFIG_DEFAULTS",
    "USER_PREFERENCES",
    "USER_DIRECTIVES",
    "ENVIRONMENT",
    "WORKFLOW_RULES",
    "KNOWN_ISSUES",
];
const GET_MAX_IDS: usize = 20;

/// Why a global write saves nothing and a global memory can't be changed
/// here; both replies say it.
const GLOBAL_NOTE: &str =
    "global memories are written only by the review that keeps the user profile";

/// Where a write goes, as its `level` argument names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Level {
    Project,
    Workspace,
    Global,
}

/// A write's level: the project when the argument is absent or empty.
fn level(input: &Value) -> Result<Level, String> {
    match text(input, "level") {
        None | Some("project") => Ok(Level::Project),
        Some("workspace") => Ok(Level::Workspace),
        Some("global") => Ok(Level::Global),
        Some(other) => Err(format!(
            "Error: Unknown memory level '{other}'. Use project, workspace or global."
        )),
    }
}

/// The apps' reload hint for the memories of `memory`'s owner.
fn owner_changed(memory: &memory_writes::MemoryRow) -> Change {
    Change::Memories {
        level: memory.level.clone(),
        owner: memory.owner_id.clone(),
    }
}

fn text<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    input
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
}

/// `ids`, when every entry is an integer.
fn ids(input: &Value) -> Option<Vec<i64>> {
    input
        .get("ids")?
        .as_array()?
        .iter()
        .map(|id| {
            id.as_i64()
                .or_else(|| id.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64))
        })
        .collect()
}

fn inactive(id: i64, verb: &str) -> String {
    format!("Error: Memory with ID {id} is archived or superseded; restore it before {verb}.")
}

fn iso(ms: i64) -> String {
    let seconds = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = seconds.div_euclid(86_400);
    let secs = seconds.rem_euclid(86_400);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        secs / 3600,
        secs % 3600 / 60,
        secs % 60
    )
}

/// The `get` table, as the TypeScript tool lays it out.
fn format_list(memories: &[memory_writes::MemoryRow]) -> String {
    if memories.is_empty() {
        return "No active memories found.".into();
    }
    let rows: Vec<[String; 6]> = memories
        .iter()
        .map(|memory| {
            [
                memory.id.to_string(),
                memory.category.clone(),
                memory.status.clone(),
                memory.verification_status.clone(),
                iso(memory.updated_at),
                memory
                    .content
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" "),
            ]
        })
        .collect();
    let headers = ["ID", "CATEGORY", "STATUS", "VERIFY", "UPDATED", "CONTENT"].map(str::to_owned);
    let widths: Vec<usize> = (0..5)
        .map(|column| {
            rows.iter()
                .map(|row| row[column].chars().count())
                .chain([headers[column].len()])
                .max()
                .unwrap_or(0)
        })
        .collect();
    let format_row = |row: &[String; 6]| {
        let mut cells: Vec<String> = (0..5)
            .map(|column| format!("{:<width$}", row[column], width = widths[column]))
            .collect();
        cells.push(row[5].clone());
        cells.join(" | ")
    };
    let all_active = memories.iter().all(|memory| memory.status == "active");
    let mut lines = vec![
        format!(
            "Found {} {}{}:",
            rows.len(),
            if all_active { "active " } else { "" },
            if rows.len() == 1 {
                "memory"
            } else {
                "memories"
            }
        ),
        String::new(),
        format_row(&headers),
        widths
            .iter()
            .map(|width| "-".repeat(*width))
            .chain(["-------".to_owned()])
            .collect::<Vec<_>>()
            .join("-+-"),
    ];
    lines.extend(rows.iter().map(format_row));
    lines.join("\n")
}

/// One `ctx_memory` call's reply, and the owners whose memories or pending
/// observations it may have changed, for the apps' reload hints.
#[derive(Debug)]
pub(crate) struct Reply {
    pub text: String,
    pub changed: Vec<Change>,
}

impl Reply {
    fn read(text: String) -> Self {
        Self {
            text,
            changed: Vec::new(),
        }
    }
}

/// Run one `ctx_memory` call.
pub fn run(conn: &mut Connection, who: &Writer, input: &Value) -> Result<String, String> {
    call(conn, who, input, None).map(|reply| reply.text)
}

/// Run one `ctx_memory` call. `ordinal` is the newest message the session
/// had seen when the agent called the tool: a fact passed to the user-profile
/// review names it as its source.
pub(crate) fn call(
    conn: &mut Connection,
    who: &Writer,
    input: &Value,
    ordinal: Option<u64>,
) -> Result<Reply, String> {
    let store = |error: rusqlite::Error| error.to_string();
    let action = input.get("action").and_then(Value::as_str).unwrap_or("");
    match action {
        "write" => {
            let content = text(input, "content")
                .ok_or("Error: 'content' is required when action is 'write'.")?;
            let category = text(input, "category")
                .ok_or("Error: 'category' is required when action is 'write'.")?;
            if !CATEGORIES.contains(&category) {
                return Err(format!("Error: Unknown memory category '{category}'."));
            }
            match level(input)? {
                Level::Project => {
                    let receipt =
                        memory_writes::save(conn, who, category, content).map_err(store)?;
                    Ok(Reply {
                        text: saved(&receipt, category, Level::Project),
                        changed: vec![Change::project_memories(who.project)],
                    })
                }
                Level::Workspace => write_workspace(conn, who, category, content),
                Level::Global => {
                    memory_writes::observe(conn, who, category, content, ordinal).map_err(store)?;
                    // The apps' global page counts the review's pending
                    // observations, so its reload hint covers this one.
                    Ok(Reply {
                        text: format!(
                            "Not saved as a memory: {GLOBAL_NOTE}. The fact was passed to that review."
                        ),
                        changed: vec![Change::global_memories()],
                    })
                }
            }
        }
        "get" => {
            let requested = ids(input).filter(|ids| !ids.is_empty()).ok_or(
                "Error: 'ids' must contain at least one integer memory ID when action is 'get'.",
            )?;
            if requested.len() > GET_MAX_IDS {
                return Err(format!(
                    "Error: 'ids' must contain at most {GET_MAX_IDS} memory IDs when action is 'get' (got {}).",
                    requested.len()
                ));
            }
            let mut seen = std::collections::HashSet::new();
            let mut parts = Vec::new();
            for id in requested.into_iter().filter(|id| seen.insert(*id)) {
                parts.push(match memory_writes::get_memory(conn, id).map_err(store)? {
                    Some(memory) if who.owns(&memory) => format_list(&[memory]),
                    _ => format!("id {id}: not found or not visible from this project"),
                });
            }
            Ok(Reply::read(parts.join("\n\n")))
        }
        "update" | "archive" | "merge" => mutate(conn, who, action, input),
        other => Err(format!(
            "Error: Action '{other}' is not allowed in this context."
        )),
    }
}

/// A save's reply. A workspace memory says so; a project memory's reply is
/// the one the tool always gave.
fn saved(receipt: &memory_writes::Receipt, category: &str, level: Level) -> String {
    let (exists, saved) = match level {
        Level::Workspace => ("Workspace memory already exists", "Saved workspace memory"),
        _ => ("Memory already exists", "Saved memory"),
    };
    match (receipt.applied, receipt.inserted, receipt.memory_id) {
        (false, _, _) => format!("{}: memory was not saved.", receipt.reason),
        (true, false, Some(id)) => {
            format!("{exists} [ID: {id}] in {category} (seen count incremented).")
        }
        (true, _, id) => format!("{saved} [ID: {}] in {category}.", id.unwrap_or_default()),
    }
}

/// Whether the session's memory profile lets a memory under `category` (a
/// tag) be filed at the workspace level.
fn workspace_allows(who: &Writer, category: &str) -> bool {
    let category_id = crate::memory_levels::category_id(category, who.authority);
    who.authority
        .is_some_and(|authority| authority.allows(&category_id, "workspace"))
}

fn not_allowed_at_workspace(category: &str) -> String {
    format!("Error: This session's memory profile does not allow {category} memories at the workspace level.")
}

/// Save a memory for the session's workspace: owned by the workspace, with
/// the session's project as its source.
fn write_workspace(
    conn: &mut Connection,
    who: &Writer,
    category: &str,
    content: &str,
) -> Result<Reply, String> {
    let Some(workspace) = who.workspace() else {
        return Err(
            "Error: This session's project is in no workspace; memory was not saved.".into(),
        );
    };
    // The memory context's project is the one whose membership makes the
    // workspace the session's, so a context that names none can't vouch for
    // the workspace either.
    let project = !who.project.trim().is_empty()
        && who
            .authority
            .is_some_and(|authority| authority.project_id.is_some());
    if !project {
        return Err(
            "Error: A workspace memory needs the session's project, and this session has none; memory was not saved."
                .into(),
        );
    }
    if !workspace_allows(who, category) {
        return Err(not_allowed_at_workspace(category));
    }
    let changed = Change::Memories {
        level: "workspace".into(),
        owner: workspace.to_owned(),
    };
    let receipt = memory_writes::save_at(conn, who, SaveLevel::Workspace, category, content)
        .map_err(|error| error.to_string())?;
    Ok(Reply {
        text: saved(&receipt, category, Level::Workspace),
        changed: vec![changed],
    })
}

fn mutate(
    conn: &mut Connection,
    who: &Writer,
    action: &str,
    input: &Value,
) -> Result<Reply, String> {
    let store = |error: rusqlite::Error| error.to_string();
    let content = text(input, "content");
    let reason = text(input, "reason");
    let category = text(input, "category").filter(|category| CATEGORIES.contains(category));
    let requested = ids(input);
    let (operation, ids, verb) = match action {
        "update" => {
            let ids = requested.filter(|ids| ids.len() == 1).ok_or(
                "Error: 'ids' must contain exactly one integer memory ID when action is 'update'.",
            )?;
            if content.is_none() {
                return Err("Error: 'content' is required when action is 'update'.".into());
            }
            (Operation::Update, ids, "updating")
        }
        "merge" => {
            let ids = requested.filter(|ids| ids.len() >= 2).ok_or(
                "Error: 'ids' must include at least two integer memory IDs when action is 'merge'.",
            )?;
            if ids.iter().collect::<std::collections::HashSet<_>>().len() != ids.len() {
                return Err("Error: 'ids' must include at least two distinct memory IDs when action is 'merge'.".into());
            }
            if content.is_none() {
                return Err("Error: 'content' is required when action is 'merge'.".into());
            }
            (Operation::Merge, ids, "merging")
        }
        _ => {
            let ids = requested
                .filter(|ids| !ids.is_empty())
                .ok_or("Error: 'ids' must contain at least one integer memory ID when action is 'archive'.")?;
            let mut seen = std::collections::HashSet::new();
            (
                Operation::Archive,
                ids.into_iter().filter(|id| seen.insert(*id)).collect(),
                "archiving",
            )
        }
    };
    let mut targets = Vec::new();
    let mut categories = std::collections::BTreeSet::new();
    let mut changed = Vec::new();
    for id in &ids {
        let memory = memory_writes::get_memory(conn, *id).map_err(store)?;
        if memory
            .as_ref()
            .is_some_and(|memory| memory.level == "global")
        {
            return Err(format!(
                "Error: Memory with ID {id} is a global memory, and {GLOBAL_NOTE}."
            ));
        }
        let Some(memory) = memory.filter(|memory| who.owns(memory)) else {
            return Err(if operation == Operation::Merge {
                "Error: One or more source memories were not found.".into()
            } else {
                format!("Error: Memory with ID {id} was not found.")
            });
        };
        if !memory.is_mutable() {
            return Err(inactive(*id, verb));
        }
        // A workspace memory moved to another category must still be
        // allowed at the workspace level.
        if let Some(category) = category {
            if memory.level == "workspace" && !workspace_allows(who, category) {
                return Err(not_allowed_at_workspace(category));
            }
        }
        categories.insert(memory.category.clone());
        targets.push((memory.id, memory.revision));
        let owner = owner_changed(&memory);
        if !changed.contains(&owner) {
            changed.push(owner);
        }
    }
    if operation == Operation::Merge && categories.len() > 1 {
        return Err(format!(
            "Error: Cannot merge memories from different categories ({}). If they are genuine duplicates, one is miscategorized — archive the redundant one instead of merging across categories.",
            categories.into_iter().collect::<Vec<_>>().join(", ")
        ));
    }
    let shown_category = category
        .map(str::to_owned)
        .unwrap_or_else(|| categories.into_iter().next().unwrap_or_default());
    let joined = ids
        .iter()
        .map(i64::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    let change = memory_writes::Change {
        operation,
        targets: &targets,
        content,
        category,
        reason,
    };
    match memory_writes::mutate(conn, who, &change) {
        Ok(receipt) => Ok(Reply {
            text: match operation {
                Operation::Update => {
                    format!("Updated memory [ID: {}] in {shown_category}.", ids[0])
                }
                Operation::Merge => format!(
                    "Merged memories [{joined}] into canonical memory [ID: {}] in {shown_category}; superseded [{}].",
                    receipt.memory_id.unwrap_or_default(),
                    receipt.superseded_ids.iter().map(i64::to_string).collect::<Vec<_>>().join(", ")
                ),
                Operation::Archive => {
                    let plural = if ids.len() > 1 { "memories" } else { "memory" };
                    match reason {
                        Some(reason) => format!("Archived {plural} [ID: {joined}] ({reason})."),
                        None => format!("Archived {plural} [ID: {joined}]."),
                    }
                }
            },
            changed,
        }),
        Err(MutationError::Refused(Refused::Duplicate(id))) => Err(match operation {
            Operation::Merge => format!(
                "Error: Memory content already exists as ID {id}; update or archive existing duplicates instead."
            ),
            _ => format!("Error: Memory content already exists as ID {id}; merge or archive duplicates instead."),
        }),
        Err(MutationError::Refused(Refused::Pending(reason))) => Err(match operation {
            Operation::Update => format!("Error: {reason}; memory [ID: {}] is unchanged.", ids[0]),
            _ => format!("Error: {reason}; memories [{joined}] are unchanged."),
        }),
        Err(MutationError::Store(error)) => Err(error),
    }
}

#[cfg(test)]
#[path = "memory_tool_level_tests.rs"]
mod level_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_required_placeholder_arguments_for_write_get_and_archive() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("context.db");
        drop(crate::context_db::ContextDb::create_for_tests(&path).unwrap());
        let mut conn = Connection::open(path).unwrap();
        let who = Writer {
            harness: "mode3",
            session: "placeholder-session",
            project: "dir:placeholder-project",
            authority: None,
        };
        for category in CATEGORIES {
            let content = format!("Placeholder arguments preserve the Rust fact for {category}.");
            let write = run(
                &mut conn,
                &who,
                &json!({"action": "write", "content": content, "category": "PROJECT_RULES", "ids": []}),
            )
            .unwrap();
            assert!(write.starts_with("Saved memory [ID:"), "{write}");
            let id: i64 = conn
                .query_row(
                    "SELECT id FROM memories WHERE content=?",
                    [&content],
                    |row| row.get(0),
                )
                .unwrap();
            let before = memory_writes::get_memory(&conn, id).unwrap().unwrap();
            let get = run(
                &mut conn,
                &who,
                &json!({"action": "get", "content": "", "category": category, "ids": [id]}),
            )
            .unwrap();
            assert!(get.contains(&content), "{get}");
            let after_get = memory_writes::get_memory(&conn, id).unwrap().unwrap();
            assert_eq!(after_get.content, before.content);
            assert_eq!(after_get.category, before.category);
            let archive = run(
                &mut conn,
                &who,
                &json!({"action": "archive", "content": "", "category": category, "ids": [id]}),
            )
            .unwrap();
            assert!(archive.starts_with("Archived memory [ID:"), "{archive}");
            let archived = memory_writes::get_memory(&conn, id).unwrap().unwrap();
            assert_eq!(archived.status, "archived");
            assert_eq!(archived.content, before.content);
            assert_eq!(archived.category, before.category);
        }
    }

    #[test]
    fn dates_print_as_javascript_iso_strings() {
        assert_eq!(iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso(1_790_789_964_781), "2026-09-30T17:39:24.781Z");
    }
}
