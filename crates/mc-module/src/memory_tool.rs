//! `ctx_memory`: the agent saves, changes and reads project memories. The
//! argument rules and replies are the TypeScript tool's
//! (`packages/plugin/src/tools/ctx-memory`), so an agent reads the same in
//! both. The writes go through [`crate::memory_writes`].
//!
//! A session sees and changes only its own project's memories; memories a
//! workspace shares from other projects are not shown here yet.

use rusqlite::Connection;
use serde_json::Value;

use crate::memory_writes::{self, MutationError, Operation, Refused, Writer};

/// Categories a write may name.
const CATEGORIES: [&str; 5] = [
    "PROJECT_RULES",
    "ARCHITECTURE",
    "CONSTRAINTS",
    "CONFIG_VALUES",
    "NAMING",
];
const GET_MAX_IDS: usize = 20;

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

/// Run one `ctx_memory` call. `shows` says whether the session already
/// sees a memory with exactly a given text.
pub fn run(
    conn: &mut Connection,
    who: &Writer,
    input: &Value,
    shows: &dyn Fn(i64, &str) -> bool,
) -> Result<String, String> {
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
            let receipt =
                memory_writes::save(conn, who, category, content, shows).map_err(store)?;
            Ok(
                match (receipt.applied, receipt.inserted, receipt.memory_id) {
                    (false, _, _) => format!("{}: memory was not saved.", receipt.reason),
                    (true, false, Some(id)) => format!(
                        "Memory already exists [ID: {id}] in {category} (seen count incremented)."
                    ),
                    (true, _, id) => format!(
                        "Saved memory [ID: {}] in {category}.",
                        id.unwrap_or_default()
                    ),
                },
            )
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
                    Some(memory) if memory.project_path == who.project => format_list(&[memory]),
                    _ => format!("id {id}: not found or not visible from this project"),
                });
            }
            Ok(parts.join("\n\n"))
        }
        "update" | "archive" | "merge" => mutate(conn, who, action, input, shows),
        other => Err(format!(
            "Error: Action '{other}' is not allowed in this context."
        )),
    }
}

fn mutate(
    conn: &mut Connection,
    who: &Writer,
    action: &str,
    input: &Value,
    shows: &dyn Fn(i64, &str) -> bool,
) -> Result<String, String> {
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
    for id in &ids {
        let memory = memory_writes::get_memory(conn, *id).map_err(store)?;
        let Some(memory) = memory.filter(|memory| memory.project_path == who.project) else {
            return Err(if operation == Operation::Merge {
                "Error: One or more source memories were not found.".into()
            } else {
                format!("Error: Memory with ID {id} was not found.")
            });
        };
        if !memory.is_mutable() {
            return Err(inactive(*id, verb));
        }
        categories.insert(memory.category.clone());
        targets.push((memory.id, memory.revision));
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
    match memory_writes::mutate(conn, who, &change, shows) {
        Ok(receipt) => Ok(match operation {
            Operation::Update => format!("Updated memory [ID: {}] in {shown_category}.", ids[0]),
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
mod tests {
    use super::*;

    #[test]
    fn dates_print_as_javascript_iso_strings() {
        assert_eq!(iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso(1_790_789_964_781), "2026-09-30T17:39:24.781Z");
    }
}
