//! Staged replacements for compressed session history, stored in context.db.
//! Saving candidates never replaces the compartments served to a conversation.

use std::collections::BTreeMap;

use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::{McStore, McStoreError};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Compartment {
    pub sequence: u64,
    pub start_message: u64,
    pub end_message: u64,
    pub start_message_id: String,
    pub end_message_id: String,
    pub start_block_index: Option<u64>,
    pub end_block_index: Option<u64>,
    pub title: String,
    pub content: String,
    pub p1: Option<String>,
    pub p2: Option<String>,
    pub p3: Option<String>,
    pub p4: Option<String>,
    pub importance: i32,
    pub episode_type: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Fact {
    pub category: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StagedCompartment {
    pub compartment: Compartment,
    pub pass_number: u64,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rows {
    pub compartments: BTreeMap<u64, StagedCompartment>,
    pub facts: Vec<Fact>,
}

fn load(db: &rusqlite::Connection, harness: &str, session: &str) -> rusqlite::Result<Rows> {
    let mut statement = db.prepare(
        "SELECT sequence,start_message,end_message,start_message_id,end_message_id,
                start_block_index,end_block_index,title,content,p1,p2,p3,p4,importance,
                episode_type,pass_number FROM recomp_compartments
          WHERE harness=?1 AND session_id=?2 ORDER BY sequence",
    )?;
    let compartments = statement
        .query_map(params![harness, session], |row| {
            let c = Compartment {
                sequence: row.get(0)?,
                start_message: row.get(1)?,
                end_message: row.get(2)?,
                start_message_id: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                end_message_id: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                start_block_index: row.get(5)?,
                end_block_index: row.get(6)?,
                title: row.get(7)?,
                content: row.get(8)?,
                p1: row.get(9)?,
                p2: row.get(10)?,
                p3: row.get(11)?,
                p4: row.get(12)?,
                importance: row.get(13)?,
                episode_type: row.get(14)?,
            };
            Ok((
                c.sequence,
                StagedCompartment {
                    compartment: c,
                    pass_number: row.get(15)?,
                },
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut statement = db.prepare(
        "SELECT category,content FROM recomp_facts WHERE harness=?1 AND session_id=?2 ORDER BY id",
    )?;
    let facts = statement
        .query_map(params![harness, session], |row| {
            Ok(Fact {
                category: row.get(0)?,
                content: row.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(Rows {
        compartments,
        facts,
    })
}

impl McStore {
    pub fn load_recomp_staging(&self, harness: &str, session: &str) -> Result<Rows, McStoreError> {
        self.context_read(|db| load(db, harness, session))
    }

    /// The lease check, candidate replacement and fact replacement share one write
    /// transaction. A row with a different harness label but the same session and
    /// sequence is refused, not overwritten: the legacy unique key omits harness.
    pub fn update_recomp_staging<T>(
        &self,
        harness: &str,
        session: &str,
        holder: &str,
        now: i64,
        change: impl FnOnce(&mut Rows) -> rusqlite::Result<T>,
    ) -> Result<T, McStoreError> {
        self.context_write(&["recomp_compartments", "recomp_facts"], |tx| {
            if !crate::background_state::lease_held(tx, session, holder, now)? {
                return Err(rusqlite::Error::InvalidQuery);
            }
            let mut rows = load(tx, harness, session)?;
            let previous_sequences: Vec<_> = rows.compartments.keys().copied().collect();
            let value = change(&mut rows)?;
            for sequence in previous_sequences {
                if !rows.compartments.contains_key(&sequence) {
                    tx.execute("DELETE FROM recomp_compartments WHERE harness=?1 AND session_id=?2 AND sequence=?3", params![harness, session, sequence])?;
                }
            }
            tx.execute("DELETE FROM recomp_facts WHERE harness=?1 AND session_id=?2", params![harness, session])?;
            let mut statement = tx.prepare(
                "INSERT INTO recomp_compartments
                    (harness,session_id,sequence,start_message,end_message,start_message_id,
                     end_message_id,start_block_index,end_block_index,title,content,p1,p2,p3,p4,
                     importance,episode_type,pass_number,created_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)
                 ON CONFLICT(session_id,sequence) DO UPDATE SET
                    start_message=excluded.start_message,end_message=excluded.end_message,
                    start_message_id=excluded.start_message_id,end_message_id=excluded.end_message_id,
                    start_block_index=excluded.start_block_index,end_block_index=excluded.end_block_index,
                    title=excluded.title,content=excluded.content,p1=excluded.p1,p2=excluded.p2,
                    p3=excluded.p3,p4=excluded.p4,importance=excluded.importance,
                    episode_type=excluded.episode_type,pass_number=excluded.pass_number
                 WHERE recomp_compartments.harness=excluded.harness",
            )?;
            for (sequence, staged) in &rows.compartments {
                let c = &staged.compartment;
                if *sequence != c.sequence {
                    return Err(rusqlite::Error::InvalidQuery);
                }
                // Upsert only the stager-owned columns so row identity, creation time
                // and coordinate-rebase metadata survive a resumed save.
                let written = statement.execute(params![harness,session,c.sequence,c.start_message,c.end_message,
                    c.start_message_id,c.end_message_id,c.start_block_index,c.end_block_index,
                    c.title,c.content,c.p1,c.p2,c.p3,c.p4,c.importance,c.episode_type,
                     staged.pass_number,now])?;
                if written != 1 {
                    return Err(rusqlite::Error::InvalidQuery);
                }
            }
            let pass = rows.compartments.values().map(|c| c.pass_number).max().unwrap_or(0);
            for fact in &rows.facts {
                tx.execute(
                    "INSERT INTO recomp_facts (harness,session_id,category,content,pass_number,created_at)
                     VALUES (?1,?2,?3,?4,?5,?6)",
                    params![harness,session,fact.category,fact.content,pass,now],
                )?;
            }
            Ok(value)
        })
    }
}
