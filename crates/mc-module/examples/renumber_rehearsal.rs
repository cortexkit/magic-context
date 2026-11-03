//! Rehearse a move-in's renumbering on a copy of `context.db`, before a real
//! move: runs only the conversion of the session's stored message numbers,
//! on whatever database it is given, and prints the outcome.
//!
//! ```text
//! cargo run -p mc-module --example renumber_rehearsal -- <context.db copy> <harness> <session> <messages.json>
//! ```
//!
//! `messages.json` is the list the runner's move tool would send: every
//! message row of the session's active path in host order, each
//! `{mid, entry, finished_summary}`. Never point it at the live database.

use cortexkit_role_compaction::read::Cursor;
use mc_module::move_renumber::{renumber, HostMessage, Numbering};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [db, harness, session, messages] = args.as_slice() else {
        return Err(
            "usage: renumber_rehearsal <context.db copy> <harness> <session> <messages.json>"
                .into(),
        );
    };
    let messages: Vec<HostMessage> = serde_json::from_reader(std::fs::File::open(messages)?)?;
    let newest = messages
        .iter()
        .rev()
        .find_map(|message| message.entry.map(|entry| (message.mid.clone(), entry)))
        .ok_or("no message has an entry")?;
    let numbering = Numbering::opencode(&messages, &Cursor::new(newest.1, &newest.0, ""))?;
    let mut conn = rusqlite::Connection::open(db)?;
    renumber(&mut conn, harness, session, &numbering)?;
    println!(
        "renumbered {session}: newest entry {} ({})",
        newest.1, newest.0
    );
    Ok(())
}
