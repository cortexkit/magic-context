//! The snapshot of one session's moved rows, and the fingerprint and
//! collision count a receiver compares it with.
//!
//! A snapshot is one byte string:
//!
//! - a 4-byte big-endian length of the header;
//! - the header, as RFC 8785 canonical JSON ([`Header`]);
//! - the body: each moved table in [`MOVED`] order, one line per row, each
//!   line the canonical JSON of `[table, row]` and a newline. Rows are in
//!   source row-id order, publications in their backlog order.
//!
//! A row leaves out its own row id and every column the receiver assigns,
//! writes each reference as the natural key of the row it names, a
//! publication's `commit_order` as its rank among the moved publications,
//! and a fact's logical state: a fact waiting for a second turn reads
//! `retryable` whether or not a move holds it reserved. So the body holds
//! nothing that differs between two machines holding the same rows, and
//! the fingerprint of a session, the SHA-256 of the body encoded from its
//! current rows, is the same before and after a move.

use std::collections::{BTreeMap, HashMap, HashSet};

use cortexkit_role_compaction::read::SessionRef;
use rusqlite::types::Value as SqlValue;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use super::moved::{self, Mark, Reassigned, Required, Scope, Table, MOVED};

/// The snapshot format this build writes and reads.
pub const FORMAT: &str = "mc-agent-data-session/1";

/// Why a row was left out of a snapshot: the publication's first turn
/// never committed, so it has no facts to carry.
pub const UNCOMMITTED_PUBLICATION: &str = "uncommitted_publication";
/// Why a row was left out of a snapshot: a reference it requires names a
/// row the move does not carry.
pub const DANGLING_REFERENCE: &str = "dangling_reference";

/// A fact's logical states a body may carry. A waiting fact reads
/// `retryable`; `in_flight` is a second-turn send's and never travels,
/// because `prepare` refuses while a send holds one of the session's facts.
const FACT_STATES: &[&str] = &["retryable", "applied", "covered", "decided_pending"];

/// The snapshot header.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Header {
    /// [`FORMAT`].
    pub format: String,
    pub runner: String,
    pub harness: String,
    pub session: String,
    /// The project id of the session's project link, when it has one.
    pub project: Option<String>,
    /// The `context.db` schema version the rows were read at.
    pub schema_version: i64,
    /// The number of rows the body holds, per moved table.
    pub rows: BTreeMap<String, u64>,
    /// Rows left out on purpose, per reason. The receiver reports them in
    /// its `import` reply, the only place the contract has for them.
    pub dropped: BTreeMap<String, u64>,
    /// The SHA-256 of the body, lowercase hex.
    pub body_sha256: String,
}

/// A session's moved rows as the body carries them: per moved table, in
/// [`MOVED`] order, its rows in body order.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Rows {
    pub tables: Vec<Vec<Map<String, Value>>>,
    /// Rows left out on purpose, per reason.
    pub dropped: BTreeMap<String, u64>,
}

impl Rows {
    /// The rows of the moved table named `name`.
    pub fn table(&self, name: &str) -> &[Map<String, Value>] {
        MOVED
            .iter()
            .position(|table| table.name == name)
            .and_then(|index| self.tables.get(index))
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    /// How many rows the body holds.
    pub fn count(&self) -> u64 {
        self.tables.iter().map(|rows| rows.len() as u64).sum()
    }

    /// The body: one line per row, each the canonical JSON of
    /// `[table, row]` and a newline.
    pub fn body(&self) -> Vec<u8> {
        let mut body = Vec::new();
        for (table, rows) in MOVED.iter().zip(&self.tables) {
            for row in rows {
                body.extend(line(table.name, row));
                body.push(b'\n');
            }
        }
        body
    }
}

fn line(table: &str, row: &Map<String, Value>) -> Vec<u8> {
    serde_jcs::to_vec(&(table, row)).expect("a row of text, integers and nulls serializes")
}

/// An encoded snapshot.
#[derive(Clone, Debug, PartialEq)]
pub struct Encoded {
    pub bytes: Vec<u8>,
    pub header: Header,
}

/// Read the session's moved rows and the store's schema version in one read
/// transaction, and encode them.
pub fn read(conn: &mut Connection, session: &SessionRef) -> Result<Encoded, String> {
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let version = crate::context_db::live_schema_version(&tx).map_err(|error| error.to_string())?;
    let rows = read_rows(&tx, &session.harness, &session.session)?;
    tx.finish().map_err(|error| error.to_string())?;
    Ok(encode(session, version, &rows))
}

/// Encode rows read for `session` at schema `version`.
pub fn encode(session: &SessionRef, version: i64, rows: &Rows) -> Encoded {
    let body = rows.body();
    let header = Header {
        format: FORMAT.to_owned(),
        runner: session.runner.clone(),
        harness: session.harness.clone(),
        session: session.session.clone(),
        project: rows
            .table("session_projects")
            .first()
            .and_then(|row| row.get("project_path"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        schema_version: version,
        rows: MOVED
            .iter()
            .zip(&rows.tables)
            .map(|(table, rows)| (table.name.to_owned(), rows.len() as u64))
            .collect(),
        dropped: rows.dropped.clone(),
        body_sha256: sha256_hex(&body),
    };
    let header_bytes = serde_jcs::to_vec(&header).expect("the header serializes");
    let mut bytes = Vec::with_capacity(4 + header_bytes.len() + body.len());
    bytes.extend((header_bytes.len() as u32).to_be_bytes());
    bytes.extend(header_bytes);
    bytes.extend(body);
    Encoded { bytes, header }
}

/// A session's local rows, as a receiver compares them with a baseline.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fingerprint {
    /// The SHA-256 of the body encoded from the rows, lowercase hex.
    pub digest: String,
    /// How many rows the body holds.
    pub rows: u64,
}

/// The fingerprint of the session's current rows. Run it inside a read
/// transaction when it must agree with another read.
pub fn fingerprint(conn: &Connection, harness: &str, session: &str) -> Result<Fingerprint, String> {
    let rows = read_rows(conn, harness, session)?;
    Ok(Fingerprint {
        digest: sha256_hex(&rows.body()),
        rows: rows.count(),
    })
}

/// What a receiver holds for a session an incoming snapshot would replace.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Local {
    pub fingerprint: Fingerprint,
    /// Rows outside the session's selection holding a key the install
    /// would insert ([`colliding`]).
    pub colliding: u64,
}

impl Local {
    /// Whether the receiver holds anything for the session: rows in its
    /// selection, or rows the install would collide with.
    pub fn any(&self) -> bool {
        self.fingerprint.rows > 0 || self.colliding > 0
    }
}

/// The session's fingerprint and its colliding rows for `incoming`, in one
/// read transaction.
pub fn local(conn: &mut Connection, incoming: &Snapshot) -> Result<Local, String> {
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let harness = &incoming.header.harness;
    let session = &incoming.header.session;
    let local = Local {
        fingerprint: fingerprint(&tx, harness, session)?,
        colliding: colliding(&tx, incoming)?,
    };
    tx.finish().map_err(|error| error.to_string())?;
    Ok(local)
}

/// Rows outside the session's selection that hold a key `incoming`'s
/// install would insert. They count as local rows: the install never
/// touches them, so a move must not go ahead over them.
///
/// - `compartments` and `compartment_score_selections` are unique on the
///   session id and a sequence without the harness, so another harness's
///   rows under the same session id collide.
/// - A publication id is unique across the machine, and so is the stage
///   key of its first turn, which embeds it.
pub fn colliding(conn: &Connection, incoming: &Snapshot) -> Result<u64, String> {
    let harness = incoming.header.harness.as_str();
    let session = incoming.header.session.as_str();
    let mut found = 0;
    let sequences = |name: &str| -> HashSet<i64> {
        incoming
            .rows
            .table(name)
            .iter()
            .filter_map(|row| row.get("sequence").and_then(Value::as_i64))
            .collect()
    };
    let compartments = sequences("compartments");
    if !compartments.is_empty() {
        found += count_in(
            conn,
            "SELECT sequence FROM compartments WHERE session_id = ?1 AND harness <> ?2",
            session,
            harness,
            &compartments,
        )?;
    }
    let selections = sequences("compartment_score_selections");
    if !selections.is_empty() {
        found += count_in(
            conn,
            "SELECT sequence FROM compartment_score_selections
             WHERE session_id = ?1
               AND compartment_id NOT IN (SELECT id FROM compartments WHERE session_id = ?1 AND harness = ?2)",
            session,
            harness,
            &selections,
        )?;
    }
    let publications = moved::publications();
    let mut present = conn
        .prepare(&format!(
            "SELECT COUNT(*) FROM memory_publications
             WHERE publication_id = ?3 AND publication_id NOT IN ({publications})"
        ))
        .map_err(|error| error.to_string())?;
    for row in incoming.rows.table("memory_publications") {
        if let Some(id) = row.get("publication_id").and_then(Value::as_str) {
            found += present
                .query_row(params![session, harness, id], |row| row.get::<_, i64>(0))
                .map_err(|error| error.to_string())? as u64;
        }
    }
    let mut staged = conn
        .prepare(&format!(
            "SELECT COUNT(*) FROM memory_stage_attempts
             WHERE stage_key = ?3
               AND NOT (publication_id IN ({publications}) AND stage = 'turn_one'
                        AND state = 'published' AND session_id = ?1 AND harness = ?2)"
        ))
        .map_err(|error| error.to_string())?;
    for row in incoming.rows.table("memory_stage_attempts") {
        if let Some(key) = row.get("stage_key").and_then(Value::as_str) {
            found += staged
                .query_row(params![session, harness, key], |row| row.get::<_, i64>(0))
                .map_err(|error| error.to_string())? as u64;
        }
    }
    Ok(found)
}

fn count_in(
    conn: &Connection,
    sql: &str,
    session: &str,
    harness: &str,
    wanted: &HashSet<i64>,
) -> Result<u64, String> {
    let mut statement = conn.prepare(sql).map_err(|error| error.to_string())?;
    let sequences: Vec<i64> = statement
        .query_map(params![session, harness], |row| row.get(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|error| error.to_string())?;
    Ok(sequences
        .iter()
        .filter(|sequence| wanted.contains(sequence))
        .count() as u64)
}

/// The SQL that selects a table's rows of the session, on `?1` (session id)
/// and `?2` (harness).
pub(crate) fn scope_sql(scope: Scope) -> String {
    match scope {
        Scope::Session("") => "session_id = ?1 AND harness = ?2".to_owned(),
        Scope::Session(filter) => format!("session_id = ?1 AND harness = ?2 AND {filter}"),
        Scope::Compartment => {
            "compartment_id IN (SELECT id FROM compartments WHERE session_id = ?1 AND harness = ?2)"
                .to_owned()
        }
        Scope::Publication(filter) => {
            let publications = moved::publications();
            if filter.is_empty() {
                format!("publication_id IN ({publications})")
            } else {
                format!("publication_id IN ({publications}) AND {filter}")
            }
        }
        Scope::PublicationFact => format!(
            "fact_id IN (SELECT id FROM memory_pending_facts WHERE publication_id IN ({}))",
            moved::publications()
        ),
    }
}

pub(crate) fn quoted(name: &str) -> String {
    crate::move_batches::quoted(name)
}

/// A row id, as references hold it.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum Id {
    Integer(i64),
    Text(String),
}

fn id(value: &SqlValue) -> Option<Id> {
    match value {
        SqlValue::Integer(id) => Some(Id::Integer(*id)),
        SqlValue::Text(id) => Some(Id::Text(id.clone())),
        _ => None,
    }
}

/// Whether the snapshot reader reads the column: everything carried, and a
/// fact's reservation, which decides its logical state.
fn read_by_snapshot(mark: Mark) -> bool {
    mark.carried() || mark == Mark::Reassigned(Reassigned::Reservation)
}

/// Whether a row needs the target of a reference, given the row's other
/// stored values.
fn required(table: &Table, required: Required, value_of: impl Fn(&str) -> Option<Value>) -> bool {
    match required {
        Required::Always => true,
        Required::Never => false,
        Required::When { column, value } => {
            debug_assert!(table.column(column).is_some());
            value_of(column).as_ref().and_then(Value::as_str) == Some(value)
        }
    }
}

/// A row's natural key, from its carried values: the one value of a
/// one-column key, an array otherwise.
pub(crate) fn natural_key(table: &Table, row: &Map<String, Value>) -> Value {
    match table.key {
        [column] => row.get(*column).cloned().unwrap_or(Value::Null),
        columns => Value::Array(
            columns
                .iter()
                .map(|column| row.get(*column).cloned().unwrap_or(Value::Null))
                .collect(),
        ),
    }
}

/// The session's moved rows. Tables are read in [`MOVED`] order, so every
/// row is judged after the rows it refers to: a reference whose target the
/// move does not carry is written as null when the row does not require
/// it, and a row whose required reference has no target is left out and
/// counted as a dangling reference.
pub fn read_rows(conn: &Connection, harness: &str, session: &str) -> Result<Rows, String> {
    let mut rows = Rows::default();
    let uncommitted: i64 = conn
        .query_row(
            &format!(
                "SELECT COUNT(*) FROM ({})",
                moved::uncommitted_publications()
            ),
            params![session, harness],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if uncommitted > 0 {
        rows.dropped
            .insert(UNCOMMITTED_PUBLICATION.to_owned(), uncommitted as u64);
    }
    // Per referenced table: this machine's id of each carried row, and the
    // natural key the body names that row by.
    let mut keys: HashMap<&str, HashMap<Id, Value>> = HashMap::new();
    for table in MOVED {
        let columns: Vec<&moved::Column> = table
            .columns
            .iter()
            .filter(|column| read_by_snapshot(column.mark))
            .collect();
        let mut select: Vec<String> = vec![quoted(table.id.unwrap_or("rowid"))];
        select.extend(columns.iter().map(|column| quoted(column.name)));
        let sql = format!(
            "SELECT {} FROM {} WHERE {} ORDER BY {}",
            select.join(", "),
            quoted(table.name),
            scope_sql(table.scope),
            table.order_by
        );
        let mut statement = conn.prepare(&sql).map_err(|error| error.to_string())?;
        let stored: Vec<Vec<SqlValue>> = statement
            .query_map(params![session, harness], |row| {
                (0..=columns.len()).map(|index| row.get(index)).collect()
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|error| error.to_string())?;
        let mut carried = Vec::with_capacity(stored.len());
        let mut own = HashMap::new();
        'rows: for values in stored {
            let value_of = |name: &str| {
                columns
                    .iter()
                    .position(|column| column.name == name)
                    .and_then(|index| plain(&values[index + 1]).ok())
            };
            let mut row = Map::new();
            let mut state = None;
            let mut reservation = None;
            for (column, value) in columns.iter().zip(&values[1..]) {
                match column.mark {
                    Mark::Value => {
                        row.insert(
                            column.name.to_owned(),
                            plain(value).map_err(|kind| {
                                format!(
                                    "{}.{} holds a {kind} value, which a move cannot carry",
                                    table.name, column.name
                                )
                            })?,
                        );
                    }
                    Mark::Reference {
                        table: target,
                        required: rule,
                    } => {
                        let found = id(value).and_then(|id| {
                            keys.get(target)
                                .and_then(|targets| targets.get(&id))
                                .cloned()
                        });
                        match found {
                            Some(key) => {
                                row.insert(column.name.to_owned(), key);
                            }
                            None if required(table, rule, value_of) => {
                                *rows
                                    .dropped
                                    .entry(DANGLING_REFERENCE.to_owned())
                                    .or_default() += 1;
                                continue 'rows;
                            }
                            None => {
                                row.insert(column.name.to_owned(), Value::Null);
                            }
                        }
                    }
                    Mark::Reassigned(Reassigned::CommitOrder) => {
                        row.insert(column.name.to_owned(), (carried.len() as i64 + 1).into());
                    }
                    Mark::Reassigned(Reassigned::FactState) => {
                        state = Some((column.name, value.clone()));
                    }
                    Mark::Reassigned(Reassigned::Reservation) => {
                        reservation = match value {
                            SqlValue::Text(key) => Some(key.clone()),
                            _ => None,
                        };
                    }
                    Mark::Reassigned(_) | Mark::Excluded(_) => {}
                }
            }
            if let Some((name, value)) = state {
                let SqlValue::Text(stored) = value else {
                    return Err(format!("{}.{name} is not text", table.name));
                };
                let logical = if moved::is_waiting(&stored, reservation.as_deref()) {
                    "retryable".to_owned()
                } else {
                    stored
                };
                row.insert(name.to_owned(), logical.into());
            }
            if table.id.is_some() {
                if let Some(source) = id(&values[0]) {
                    own.insert(source, natural_key(table, &row));
                }
            }
            carried.push(row);
        }
        if table.id.is_some() {
            keys.insert(table.name, own);
        }
        rows.tables.push(carried);
    }
    Ok(rows)
}

/// A stored value as the body carries it: text, an integer or null.
fn plain(value: &SqlValue) -> Result<Value, &'static str> {
    match value {
        SqlValue::Null => Ok(Value::Null),
        SqlValue::Integer(number) => Ok((*number).into()),
        SqlValue::Text(text) => Ok(text.clone().into()),
        SqlValue::Real(_) => Err("REAL"),
        SqlValue::Blob(_) => Err("BLOB"),
    }
}

/// A body value as SQLite stores it.
pub(crate) fn stored(value: &Value) -> SqlValue {
    match value {
        Value::Null => SqlValue::Null,
        Value::Number(number) => SqlValue::Integer(number.as_i64().expect("decoded integers fit")),
        Value::String(text) => SqlValue::Text(text.clone()),
        other => unreachable!("a decoded body value is text, an integer or null, not {other}"),
    }
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// A decoded snapshot.
#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot {
    pub header: Header,
    pub rows: Rows,
}

/// Decode a snapshot and check every row against [`MOVED`]: its columns,
/// the shape of its values, its references (each names a row of the body
/// that comes before it, and a required one is present) and the uniqueness
/// of natural keys. Every refusal names the table, and a caller refuses it
/// as `incompatible_version`: this build cannot install it as it is. The
/// format name is checked here; the schema version is the caller's to
/// compare, with both its build and its live store.
pub fn decode(bytes: &[u8]) -> Result<Snapshot, String> {
    let length = bytes
        .get(..4)
        .ok_or("the snapshot is shorter than its header length")?;
    let length = u32::from_be_bytes(length.try_into().expect("four bytes")) as usize;
    let header_bytes = bytes
        .get(4..4 + length)
        .ok_or("the snapshot is shorter than its header")?;
    let header: Header = serde_json::from_slice(header_bytes)
        .map_err(|error| format!("the snapshot header cannot be read: {error}"))?;
    if header.format != FORMAT {
        return Err(format!(
            "the snapshot format is {:?}; this build reads {FORMAT:?}",
            header.format
        ));
    }
    if serde_jcs::to_vec(&header).map_err(|error| error.to_string())? != header_bytes {
        return Err("the snapshot header is not canonical JSON".to_owned());
    }
    let body = &bytes[4 + length..];
    if sha256_hex(body) != header.body_sha256 {
        return Err("the snapshot body does not match its digest".to_owned());
    }
    let names: Vec<&str> = MOVED.iter().map(|table| table.name).collect();
    let mut sorted = names.clone();
    sorted.sort_unstable();
    if !header.rows.keys().map(String::as_str).eq(sorted) {
        return Err(format!(
            "the snapshot counts rows of tables {:?}; this build moves {names:?}",
            header.rows.keys().collect::<Vec<_>>()
        ));
    }
    if header.dropped.len() > 16 || header.dropped.values().any(|count| *count == 0) {
        return Err("the snapshot's dropped counts are malformed".to_owned());
    }
    let mut rows = Rows {
        tables: vec![Vec::new(); MOVED.len()],
        dropped: header.dropped.clone(),
    };
    let mut keys: HashMap<&str, HashSet<String>> = HashMap::new();
    let mut current = 0;
    if !body.is_empty() && body.last() != Some(&b'\n') {
        return Err("the snapshot body does not end with a newline".to_owned());
    }
    for line in body
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
    {
        let (name, row): (String, Map<String, Value>) = serde_json::from_slice(line)
            .map_err(|error| format!("a snapshot row cannot be read: {error}"))?;
        let index = names
            .iter()
            .position(|known| *known == name)
            .ok_or_else(|| {
                format!("the snapshot carries rows of {name}, which this build does not move")
            })?;
        if index < current {
            return Err(format!("the snapshot's {name} rows are out of order"));
        }
        current = index;
        let table = &MOVED[index];
        if self::line(&name, &row) != line {
            return Err(format!("a {name} row is not canonical JSON"));
        }
        check_row(table, &row, rows.tables[index].len(), &keys)?;
        if !table.key.is_empty()
            && !keys
                .entry(table.name)
                .or_default()
                .insert(natural_key(table, &row).to_string())
        {
            return Err(format!(
                "the snapshot carries two {name} rows with key {}",
                natural_key(table, &row)
            ));
        }
        rows.tables[index].push(row);
    }
    for (table, carried) in MOVED.iter().zip(&rows.tables) {
        if header.rows.get(table.name) != Some(&(carried.len() as u64)) {
            return Err(format!(
                "the snapshot header counts {} {} rows; the body holds {}",
                header.rows.get(table.name).copied().unwrap_or(0),
                table.name,
                carried.len()
            ));
        }
    }
    Ok(Snapshot { header, rows })
}

fn check_row(
    table: &Table,
    row: &Map<String, Value>,
    position: usize,
    keys: &HashMap<&str, HashSet<String>>,
) -> Result<(), String> {
    let name = table.name;
    let expected: Vec<&str> = table.carried().map(|column| column.name).collect();
    let mut found: Vec<&str> = row.keys().map(String::as_str).collect();
    let mut sorted = expected.clone();
    sorted.sort_unstable();
    found.sort_unstable();
    if found != sorted {
        return Err(format!(
            "a {name} row carries columns {found:?}; this build moves {expected:?}"
        ));
    }
    for column in table.carried() {
        let value = &row[column.name];
        let shape_ok = match column.mark {
            Mark::Value => is_plain(value),
            Mark::Reference {
                table: target,
                required: rule,
            } => {
                let target = moved::table(target).expect("references name moved tables");
                if value.is_null() {
                    if required(table, rule, |name| row.get(name).cloned()) {
                        return Err(format!(
                            "a {name} row has no {} though its other values require one",
                            column.name
                        ));
                    }
                    true
                } else {
                    if !keys
                        .get(target.name)
                        .is_some_and(|known| known.contains(&value.to_string()))
                    {
                        return Err(format!(
                            "a {name} row's {} names a {} row the snapshot does not carry",
                            column.name, target.name
                        ));
                    }
                    true
                }
            }
            Mark::Reassigned(Reassigned::CommitOrder) => {
                value.as_i64() == Some(position as i64 + 1)
            }
            Mark::Reassigned(Reassigned::FactState) => value
                .as_str()
                .is_some_and(|state| FACT_STATES.contains(&state)),
            Mark::Reassigned(_) | Mark::Excluded(_) => false,
        };
        if !shape_ok {
            return Err(format!(
                "a {name} row's {} holds {value}, which this build cannot install",
                column.name
            ));
        }
    }
    Ok(())
}

fn is_plain(value: &Value) -> bool {
    match value {
        Value::Null | Value::String(_) => true,
        Value::Number(number) => number.as_i64().is_some(),
        _ => false,
    }
}
