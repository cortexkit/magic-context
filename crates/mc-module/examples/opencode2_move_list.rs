//! Build the message list `ck-mc move-in` needs for a session moved from
//! OpenCode 1 to OpenCode 2: the OpenCode 1 rows from a copy of the
//! OpenCode 1 store, lined up by id with the runner's list of the converted
//! session ([`mc_module::move_renumber::opencode1_to_2`]).
//!
//! ```text
//! cargo run -p mc-module --example opencode2_move_list -- <opencode.db copy> <session> <converted.jsonl> > messages.json
//! ```
//!
//! `converted.jsonl` has one `{"id", "number", "compaction"}` line per row of
//! the converted session, in OpenCode 2 order. The store is opened
//! read-only; never point it at a live store.

use mc_module::move_renumber::{opencode1_to_2, OpenCode1Row, OpenCode2Row};
use rusqlite::{Connection, OpenFlags};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [store, session, converted] = args.as_slice() else {
        return Err(
            "usage: opencode2_move_list <opencode.db copy> <session> <converted.jsonl>".into(),
        );
    };
    let conn = Connection::open_with_flags(store, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    // The standalone plugin's order and its finished-summary rule.
    let mut statement = conn.prepare(
        "SELECT id,
                CASE WHEN json_valid(data) THEN COALESCE(json_extract(data, '$.summary'), 0) = 1
                     AND COALESCE(json_extract(data, '$.finish'), '') = 'stop' ELSE 0 END
         FROM message WHERE session_id = ?1 ORDER BY time_created ASC, id ASC",
    )?;
    let rows = statement
        .query_map([session], |row| {
            Ok(OpenCode1Row {
                mid: row.get(0)?,
                finished_summary: row.get(1)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let converted = std::fs::read_to_string(converted)?
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(serde_json::from_str::<OpenCode2Row>)
        .collect::<Result<Vec<_>, _>>()?;
    let messages = opencode1_to_2(&rows, &converted)?;
    eprintln!(
        "{} OpenCode 1 rows, {} converted rows, {} in the list ({} added, {} with an entry)",
        rows.len(),
        converted.len(),
        messages.len(),
        messages.iter().filter(|m| m.added).count(),
        messages.iter().filter(|m| m.entry.is_some()).count()
    );
    println!("{}", serde_json::to_string(&messages)?);
    Ok(())
}
