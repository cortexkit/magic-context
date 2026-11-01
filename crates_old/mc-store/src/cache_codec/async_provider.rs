//! Reserved provider KV rows share the section table, but never an engine owner.
use rusqlite::{params, Connection};

pub(crate) const HEADERS: &str = "__ckmc_async_v2_headers";
pub(crate) const KEYS: &str = "__ckmc_async_v2_keys";
pub(crate) const OUTBOX: &str = "__ckmc_async_v2_outbox";
pub(crate) const CHILDREN: &str = "__ckmc_async_v2_record:";

/// A section writer whose owner is proven to belong to the provider family.
/// It cannot address an engine namespace or modify an engine section index.
pub(crate) struct Sections<'a> {
    conn: &'a Connection,
    owner: &'a str,
}

impl<'a> Sections<'a> {
    pub(crate) fn new(conn: &'a Connection, owner: &'a str) -> rusqlite::Result<Self> {
        if ![HEADERS, KEYS, OUTBOX].contains(&owner)
            && !owner
                .strip_prefix(CHILDREN)
                .is_some_and(|reference| !reference.is_empty())
        {
            return Err(Self::wrong_owner());
        }
        Ok(Self { conn, owner })
    }

    fn wrong_owner() -> rusqlite::Error {
        rusqlite::Error::InvalidParameterName("not a reserved async provider owner".into())
    }

    fn require_record(&self) -> rusqlite::Result<()> {
        self.owner
            .starts_with(CHILDREN)
            .then_some(())
            .ok_or_else(Self::wrong_owner)
    }

    pub(crate) fn put(&self, slot: &str, raw: &str) -> rusqlite::Result<usize> {
        self.conn.execute("INSERT INTO main.mc_cache_sections(session_id,section,body) VALUES(?1,?2,?3) ON CONFLICT(session_id,section) DO UPDATE SET body=excluded.body", params![self.owner, slot, raw])
    }

    pub(crate) fn insert(&self, slot: &str, raw: &str) -> rusqlite::Result<usize> {
        self.conn.execute(
            "INSERT INTO main.mc_cache_sections(session_id,section,body) VALUES(?1,?2,?3)",
            params![self.owner, slot, raw],
        )
    }

    pub(crate) fn insert_if_absent(&self, slot: &str, raw: &str) -> rusqlite::Result<usize> {
        self.conn.execute("INSERT OR IGNORE INTO main.mc_cache_sections(session_id,section,body) VALUES(?1,?2,?3)", params![self.owner, slot, raw])
    }

    pub(crate) fn remove(&self, slot: &str) -> rusqlite::Result<usize> {
        self.conn.execute(
            "DELETE FROM main.mc_cache_sections WHERE session_id=?1 AND section=?2",
            params![self.owner, slot],
        )
    }

    pub(crate) fn clear_record(&self) -> rusqlite::Result<usize> {
        self.require_record()?;
        self.conn.execute(
            "DELETE FROM main.mc_cache_sections WHERE session_id=?1",
            [self.owner],
        )
    }

    pub(crate) fn remove_reference(&self, reference: &str) -> rusqlite::Result<usize> {
        if self.owner != KEYS {
            return Err(Self::wrong_owner());
        }
        self.conn.execute("DELETE FROM main.mc_cache_sections WHERE session_id=?1 AND CASE WHEN json_valid(body) THEN json_extract(body,'$.reference') END=?2", params![self.owner, reference])
    }

    pub(crate) fn remove_outbox_range(&self, from: &str, to: &str) -> rusqlite::Result<usize> {
        if self.owner != OUTBOX {
            return Err(Self::wrong_owner());
        }
        self.conn.execute(
            "DELETE FROM main.mc_cache_sections WHERE session_id=?1 AND section>=?2 AND section<?3",
            params![self.owner, from, to],
        )
    }

    pub(crate) fn remove_cut_facts(&self, active: Option<&str>) -> rusqlite::Result<usize> {
        self.require_record()?;
        self.conn.execute("DELETE FROM main.mc_cache_sections WHERE session_id=?1 AND section GLOB 'cut:*' AND (?2 IS NULL OR section<>?2)", params![self.owner, active])
    }

    pub(crate) fn replace_entry(
        &self,
        slot: &str,
        entry: &str,
        index: &str,
    ) -> rusqlite::Result<usize> {
        self.require_record()?;
        if !slot.starts_with("__ckmc_async_v2_entry:") {
            return Err(Self::wrong_owner());
        }
        self.conn.execute("UPDATE main.mc_cache_sections SET body=json_set(body,'$.entry_json',?3,'$.index_json',?4) WHERE session_id=?1 AND section=?2", params![self.owner, slot, entry, index])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_sections_cannot_address_engine_owners_or_cross_families() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE mc_cache_sections(session_id TEXT, section TEXT, body TEXT, PRIMARY KEY(session_id,section)); INSERT INTO mc_cache_sections VALUES('engine:async:0','tail_hygiene_baseline','engine bytes');").unwrap();
        for owner in [
            "engine:async:0",
            "__ckmc_async_v2_record:",
            "__ckmc_async_v2_other",
        ] {
            assert!(Sections::new(&conn, owner).is_err());
        }
        let a = Sections::new(&conn, "__ckmc_async_v2_record:a").unwrap();
        let b = Sections::new(&conn, "__ckmc_async_v2_record:b").unwrap();
        a.put("produced", "a baseline").unwrap();
        b.put("produced", "b baseline").unwrap();
        assert_eq!(
            a.insert_if_absent("produced", "not a replacement").unwrap(),
            0
        );
        assert!(a.insert("produced", "duplicate").is_err());
        assert!(a.remove_reference("b").is_err());
        assert!(a.remove_outbox_range("", "z").is_err());
        assert!(a
            .replace_entry("tail_hygiene_baseline", "{}", "[]")
            .is_err());
        let headers = Sections::new(&conn, HEADERS).unwrap();
        assert!(headers.clear_record().is_err());
        assert!(headers.remove_cut_facts(None).is_err());
        a.clear_record().unwrap();
        let kept: String = conn.query_row("SELECT body FROM mc_cache_sections WHERE session_id='__ckmc_async_v2_record:b' AND section='produced'", [], |row|row.get(0)).unwrap();
        assert_eq!(kept, "b baseline");
        let engine: String = conn.query_row("SELECT body FROM mc_cache_sections WHERE session_id='engine:async:0' AND section='tail_hygiene_baseline'", [], |row|row.get(0)).unwrap();
        assert_eq!(engine, "engine bytes");
    }
}
