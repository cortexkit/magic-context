//! Read-only views of the host's compartment score revisions and selections.
//! A revision applies only while the original compartment's content and identity
//! still match. The hash's field order and encoding are pinned by the same
//! golden vectors used by the TypeScript writer and Rust prompt renderer.

use rusqlite::{Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

#[derive(Default)]
pub struct Scores {
    pub selected: HashSet<i64>,
    pub effective: HashMap<i64, i64>,
    pub applied: HashMap<i64, i64>,
    pub rust_applied: Option<HashMap<i64, i64>>,
}

fn identity(row: &rusqlite::Row<'_>) -> rusqlite::Result<String> {
    fn integer(hash: &mut Sha256, value: Option<i64>) {
        match value {
            Some(value) => hash.update(format!("I{value};")),
            None => hash.update(b"N;"),
        }
    }
    fn string(hash: &mut Sha256, value: Option<String>) {
        match value {
            Some(value) => {
                hash.update(format!("S{}:", value.len()));
                hash.update(value.as_bytes());
                hash.update(b";");
            }
            None => hash.update(b"N;"),
        }
    }
    let mut hash = Sha256::new();
    hash.update(b"mc-rescore-source-v1\0");
    integer(&mut hash, Some(row.get(0)?));
    string(&mut hash, Some(row.get(1)?));
    integer(&mut hash, Some(row.get(2)?));
    string(&mut hash, Some(row.get(3)?));
    string(&mut hash, row.get(4)?);
    let legacy: i64 = row.get(5)?;
    integer(&mut hash, Some(legacy));
    string(
        &mut hash,
        if legacy != 0 { Some(row.get(6)?) } else { None },
    );
    for index in 7..=10 {
        string(&mut hash, if legacy == 0 { row.get(index)? } else { None });
    }
    for index in 11..=13 {
        integer(&mut hash, Some(row.get(index)?));
    }
    for index in 14..=15 {
        string(
            &mut hash,
            Some(row.get::<_, Option<String>>(index)?.unwrap_or_default()),
        );
    }
    for index in 16..=17 {
        integer(&mut hash, row.get(index)?);
    }
    integer(&mut hash, Some(row.get(18)?));
    Ok(format!("{:x}", hash.finalize()))
}

fn view(conn: &Connection, session: &str, watermark: i64) -> rusqlite::Result<HashMap<i64, i64>> {
    let mut stmt = conn.prepare(
        "SELECT c.id,c.session_id,c.created_at,c.title,c.episode_type,COALESCE(c.legacy,0),c.content,c.p1,c.p2,c.p3,c.p4,
            c.sequence,c.start_message,c.end_message,c.start_message_id,c.end_message_id,c.start_block_index,c.end_block_index,
            COALESCE(c.importance,50),r.source_identity,r.new_importance
         FROM compartments c JOIN compartment_score_selections s ON s.session_id=c.session_id AND s.compartment_id=c.id
            AND s.sequence=(SELECT MAX(a.sequence) FROM compartment_score_selections a WHERE a.session_id=c.session_id AND a.compartment_id=c.id AND a.sequence<=?2)
         JOIN compartment_score_revisions r ON r.id=s.revision_id AND r.session_id=c.session_id AND r.compartment_id=c.id
         WHERE c.session_id=?1")?;
    let rows = stmt.query_map(rusqlite::params![session, watermark], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            identity(row)?,
            row.get::<_, String>(19)?,
            row.get::<_, i64>(20)?,
        ))
    })?;
    let mut scores = HashMap::new();
    for row in rows {
        let (id, source, selected_source, importance) = row?;
        if source == selected_source && (1..=100).contains(&importance) {
            scores.insert(id, importance);
        }
    }
    Ok(scores)
}

pub fn rust_watermark(conn: &Connection, session: &str) -> rusqlite::Result<Option<i64>> {
    let path: String = conn.query_row("PRAGMA database_list", [], |row| row.get(2))?;
    if path.is_empty() {
        return Ok(None);
    }
    let path = std::path::Path::new(&path).with_file_name("store.db");
    if !path.exists() {
        return Ok(None);
    }
    let store = Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let meta: Option<String> = store
        .query_row(
            "SELECT meta FROM mc_cache_state WHERE session_id=?1",
            [session],
            |row| row.get(0),
        )
        .optional()?;
    Ok(meta.map(|meta| {
        serde_json::from_str::<serde_json::Value>(&meta)
            .ok()
            .and_then(|v| v["score_selection_watermark"].as_i64())
            .unwrap_or(0)
            .max(0)
    }))
}

pub fn read(
    conn: &Connection,
    session: &str,
    rust_watermark: Option<i64>,
) -> rusqlite::Result<Scores> {
    if !crate::db_capabilities::get(conn)?.compartment_scores {
        return Ok(Scores::default());
    }
    let mut stmt = conn.prepare(
        "SELECT DISTINCT compartment_id FROM compartment_score_selections WHERE session_id=?1",
    )?;
    let selected = stmt
        .query_map([session], |row| row.get::<_, i64>(0))?
        .collect::<rusqlite::Result<HashSet<_>>>()?;
    let latest: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sequence),0) FROM compartment_score_selections WHERE session_id=?1",
        [session],
        |row| row.get(0),
    )?;
    let applied = conn
        .query_row(
            "SELECT cached_m0_score_selection_watermark FROM session_meta WHERE session_id=?1",
            [session],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .unwrap_or(0);
    Ok(Scores {
        selected,
        effective: view(conn, session, latest)?,
        applied: view(conn, session, applied)?,
        rust_applied: rust_watermark
            .map(|watermark| view(conn, session, watermark))
            .transpose()?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE compartments(id INTEGER,session_id TEXT,created_at INTEGER,title TEXT,episode_type TEXT,legacy INTEGER,content TEXT,p1 TEXT,p2 TEXT,p3 TEXT,p4 TEXT,sequence INTEGER,start_message INTEGER,end_message INTEGER,start_message_id TEXT,end_message_id TEXT,start_block_index INTEGER,end_block_index INTEGER,importance INTEGER);
            CREATE TABLE compartment_score_selections(session_id TEXT,compartment_id INTEGER,sequence INTEGER,revision_id INTEGER);
            CREATE TABLE compartment_score_revisions(id INTEGER,session_id TEXT,compartment_id INTEGER,source_identity TEXT,new_importance INTEGER);
            CREATE TABLE session_meta(session_id TEXT,cached_m0_score_selection_watermark INTEGER);").unwrap();
        // Production openers discover features before any read-only operation.
        crate::db_capabilities::get(&conn).unwrap();
        conn
    }
    fn add(conn: &Connection, source: &serde_json::Value) {
        let fields = [
            "id",
            "sessionId",
            "createdAt",
            "title",
            "episodeType",
            "legacy",
            "content",
            "p1",
            "p2",
            "p3",
            "p4",
            "sequence",
            "startMessage",
            "endMessage",
            "startMessageId",
            "endMessageId",
            "startBlockIndex",
            "endBlockIndex",
            "importance",
        ];
        let expressions = fields
            .map(|field| format!("json_extract(?1,'$.{field}')"))
            .join(",");
        conn.execute(
            &format!("INSERT INTO compartments SELECT {expressions}"),
            [source.to_string()],
        )
        .unwrap();
    }
    fn goldens() -> serde_json::Value {
        serde_json::from_str(include_str!(
            "../../../plugin/src/features/magic-context/rescore-source-identity.goldens.json"
        ))
        .unwrap()
    }
    #[test]
    fn score_identity_matches_shared_goldens() {
        for vector in goldens()["vectors"].as_array().unwrap() {
            let conn = fixture();
            add(&conn, &vector["source"]);
            let actual = conn
                .query_row("SELECT * FROM compartments", [], identity)
                .unwrap();
            assert_eq!(actual, vector["sha256"].as_str().unwrap());
        }
    }
    #[test]
    fn score_reader_separates_rescored_and_original_rows_without_writes() {
        let conn = fixture();
        let vector = &goldens()["vectors"][0];
        add(&conn, &vector["source"]);
        let mut other = vector["source"].clone();
        other["id"] = 8.into();
        add(&conn, &other);
        conn.execute(
            "INSERT INTO compartment_score_revisions VALUES (1,'session-a',7,?1,10)",
            [vector["sha256"].as_str().unwrap()],
        )
        .unwrap();
        conn.execute_batch("INSERT INTO compartment_score_selections VALUES ('session-a',7,1,1); INSERT INTO session_meta VALUES ('session-a',0);").unwrap();
        let before = conn
            .query_row("SELECT total_changes()", [], |row| row.get::<_, i64>(0))
            .unwrap();
        let scores = read(&conn, "session-a", Some(1)).unwrap();
        assert!(scores.selected.contains(&7));
        assert!(!scores.selected.contains(&8));
        assert_eq!(scores.effective[&7], 10);
        assert!(!scores.applied.contains_key(&7));
        assert_eq!(scores.rust_applied.unwrap()[&7], 10);
        assert_eq!(
            conn.query_row("SELECT total_changes()", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            before
        );
        conn.execute_batch("UPDATE session_meta SET cached_m0_score_selection_watermark=1;")
            .unwrap();
        assert_eq!(read(&conn, "session-a", None).unwrap().applied[&7], 10);
        conn.execute_batch(
            "INSERT INTO compartment_score_selections VALUES ('session-a',7,2,NULL);",
        )
        .unwrap();
        let undone = read(&conn, "session-a", None).unwrap();
        assert!(!undone.effective.contains_key(&7));
        assert_eq!(undone.applied[&7], 10);
        conn.execute_batch("UPDATE compartments SET p1='changed' WHERE id=7;")
            .unwrap();
        assert!(!read(&conn, "session-a", None)
            .unwrap()
            .applied
            .contains_key(&7));
    }
}
