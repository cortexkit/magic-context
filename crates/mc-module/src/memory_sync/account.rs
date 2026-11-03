use rusqlite::{params, Connection, OptionalExtension};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Account {
    pub account: String,
    pub device: String,
    pub state: String,
}

pub(super) fn cached(conn: &Connection) -> rusqlite::Result<Option<Account>> {
    conn.query_row(
        "SELECT account,device,enrollment_state FROM memory_sync_state ORDER BY rowid DESC LIMIT 1",
        [],
        |r| {
            Ok(Account {
                account: r.get::<_, Option<String>>(0)?.unwrap_or_default(),
                device: r.get(1)?,
                state: r.get(2)?,
            })
        },
    )
    .optional()
}

pub(super) fn refresh(
    conn: &Connection,
    answer: &Result<super::engram::Heads, String>,
) -> rusqlite::Result<()> {
    match answer {
        Ok(heads) => {
            conn.execute("DELETE FROM memory_sync_state WHERE device=''", [])?;
            conn.execute("INSERT INTO memory_sync_state(device,account,enrollment_state,next_local_id,hlc_wall_ms,hlc_logical) VALUES(?1,?2,'enrolled',1,0,0) ON CONFLICT(device) DO UPDATE SET account=excluded.account,enrollment_state='enrolled'", params![heads.device,heads.account])?;
        }
        Err(error) if matches!(error.as_str(), "key_unavailable" | "not_member") => {
            let state = if error == "key_unavailable" {
                "not_enrolled"
            } else {
                "credential_invalid"
            };
            if let Some(account) = cached(conn)? {
                conn.execute(
                    "UPDATE memory_sync_state SET enrollment_state=?1 WHERE device=?2",
                    params![state, account.device],
                )?;
            } else {
                conn.execute("INSERT INTO memory_sync_state(device,enrollment_state,next_local_id,hlc_wall_ms,hlc_logical) VALUES('',?1,1,0,0)",[state])?;
            }
        }
        // A stopped or unreachable cloud is not evidence that enrollment was revoked.
        _ => {}
    }
    Ok(())
}
