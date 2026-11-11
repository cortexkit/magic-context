//! The install of a snapshot on the receiver, as the offline mover's write
//! plan ([`crate::move_batches`]): staged in `schema_migrations_meta` under
//! a key for the cut and the session, then applied in short transactions
//! that each advance the plan's cursor, so a crash resumes where it stopped
//! and no batch is applied twice. A cut is one move attempt; its id comes
//! with every step of that move, so two attempts never share a plan.
//!
//! The plan first deletes the receiver's rows in the session's selection,
//! children before parents, then inserts the snapshot's rows, parents
//! before children. A reference is resolved when its row is inserted, by a
//! subquery on the receiver's rows for the session, so the plan binds no
//! row id of either machine. Publications are appended to the receiver's
//! backlog in their rank order. A fact waiting for a second turn is
//! inserted `in_flight` under the cut's reservation, so no second turn on
//! the receiver takes it before the move activates; every other fact keeps
//! its state and has no reservation.

use std::collections::HashMap;

use rusqlite::types::Value as SqlValue;
use rusqlite::{params, params_from_iter, Connection, ToSql};
use serde_json::{json, Map, Value};

use super::moved::{self, Install, Mark, Reassigned, Scope, Table, MOVED, NOT_MOVED};
use super::snapshot::{quoted, scope_sql, stored, Snapshot};
use crate::move_batches::{self, Plan};

/// The key the install's plan and progress are saved under.
pub fn key(cut: &str, harness: &str, session: &str) -> String {
    format!("agent_data_install:{}", json!([cut, harness, session]))
}

/// Stage the install of `incoming` for `cut` and apply it.
pub fn stage(conn: &mut Connection, incoming: &Snapshot, cut: &str) -> Result<(), String> {
    let steps = steps(conn, incoming, cut)?;
    let plan = Plan::default();
    for step in &steps {
        plan.phase(&step.phase);
        let args: Vec<&dyn ToSql> = step.args.iter().map(|arg| arg as &dyn ToSql).collect();
        plan.execute(&step.sql, &args)
            .map_err(|error| error.to_string())?;
    }
    let header = &incoming.header;
    plan.stage(
        conn,
        &key(cut, &header.harness, &header.session),
        json!({"cut": cut, "harness": header.harness, "session": header.session}),
    )
}

/// Apply what is left of a staged install. False when no plan is staged
/// under `key`, or its staging was interrupted: the caller stages it again
/// from the snapshot, which an interrupted staging pass leaves safe to do,
/// since it changed no session rows.
pub fn resume(conn: &mut Connection, key: &str) -> Result<bool, String> {
    move_batches::resume(conn, key)
}

/// Check that this store can hold every row of `incoming`: each carried
/// column exists, and none of the store's NOT NULL columns is null in the
/// body. The decoder already checked the rows against the moved list.
pub fn check_store(conn: &Connection, incoming: &Snapshot) -> Result<(), String> {
    for (table, rows) in MOVED.iter().zip(&incoming.rows.tables) {
        let not_null: HashMap<String, bool> = conn
            .prepare("SELECT name, \"notnull\" FROM pragma_table_info(?1)")
            .and_then(|mut statement| {
                statement
                    .query_map(params![table.name], |row| Ok((row.get(0)?, row.get(1)?)))?
                    .collect()
            })
            .map_err(|error| error.to_string())?;
        for column in table.carried() {
            let Some(required) = not_null.get(column.name) else {
                return Err(format!(
                    "{}.{} does not exist in this store",
                    table.name, column.name
                ));
            };
            if *required && rows.iter().any(|row| row[column.name].is_null()) {
                return Err(format!(
                    "a {} row has no {}, which this store requires",
                    table.name, column.name
                ));
            }
        }
    }
    Ok(())
}

/// One write of the plan.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Step {
    pub phase: String,
    pub sql: String,
    pub args: Vec<SqlValue>,
}

/// The plan's writes, in order.
pub(crate) fn steps(
    conn: &Connection,
    incoming: &Snapshot,
    cut: &str,
) -> Result<Vec<Step>, String> {
    check_store(conn, incoming)?;
    let harness = incoming.header.harness.as_str();
    let session = incoming.header.session.as_str();
    let mut steps = Vec::new();
    // The receiver's waiting publications of the session, read before any
    // delete: deleting their facts first would take them out of the
    // predicate that finds them.
    let publications: Vec<String> = conn
        .prepare(&format!(
            "SELECT publication_id FROM memory_publications
             WHERE publication_id IN ({}) ORDER BY commit_order",
            moved::publications()
        ))
        .and_then(|mut statement| {
            statement
                .query_map(params![session, harness], |row| row.get(0))?
                .collect()
        })
        .map_err(|error| error.to_string())?;
    for table in MOVED.iter().rev() {
        if table.name == "compartments" {
            // Rows of other tables that hang off the summaries about to go.
            for other in NOT_MOVED
                .iter()
                .filter(|other| other.install == Install::DeletedWithCompartments)
            {
                deletes(
                    conn,
                    &mut steps,
                    other.name,
                    &scope_sql(Scope::Compartment),
                    &[session, harness],
                )?;
            }
        }
        match table.scope {
            Scope::Session(_) | Scope::Compartment => deletes(
                conn,
                &mut steps,
                table.name,
                &scope_sql(table.scope),
                &[session, harness],
            )?,
            Scope::Publication(filter) => {
                let scope = if filter.is_empty() {
                    "publication_id = ?3".to_owned()
                } else {
                    format!("publication_id = ?3 AND {filter}")
                };
                for publication in &publications {
                    deletes(
                        conn,
                        &mut steps,
                        table.name,
                        &scope,
                        &[session, harness, publication.as_str()],
                    )?;
                }
            }
            Scope::PublicationFact => {
                for publication in &publications {
                    deletes(
                        conn,
                        &mut steps,
                        table.name,
                        "fact_id IN (SELECT id FROM memory_pending_facts WHERE publication_id = ?3)",
                        &[session, harness, publication.as_str()],
                    )?;
                }
            }
        }
    }
    for (table, rows) in MOVED.iter().zip(&incoming.rows.tables) {
        for row in rows {
            steps.push(insert(table, row, harness, session, cut));
        }
    }
    Ok(steps)
}

/// One delete per row in `scope`, each of one row, so a plan unit stays at
/// most one row write per statement like the inserts.
fn deletes(
    conn: &Connection,
    steps: &mut Vec<Step>,
    table: &str,
    scope: &str,
    args: &[&str],
) -> Result<(), String> {
    let quoted_table = quoted(table);
    let count: i64 = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM {quoted_table} WHERE {scope}"),
            params_from_iter(args),
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let sql = format!(
        "DELETE FROM {quoted_table} WHERE rowid IN (SELECT rowid FROM {quoted_table} WHERE {scope} LIMIT 1)"
    );
    for _ in 0..count {
        steps.push(Step {
            phase: format!("agent_data/delete/{table}"),
            sql: sql.clone(),
            args: args
                .iter()
                .map(|arg| SqlValue::Text((*arg).to_owned()))
                .collect(),
        });
    }
    Ok(())
}

fn insert(
    table: &Table,
    row: &Map<String, Value>,
    harness: &str,
    session: &str,
    cut: &str,
) -> Step {
    let state = table
        .columns
        .iter()
        .find(|column| column.mark == Mark::Reassigned(Reassigned::FactState))
        .and_then(|column| row.get(column.name))
        .and_then(Value::as_str);
    let waiting = state == Some("retryable");
    let mut columns = Vec::new();
    let mut values = Vec::new();
    let mut args = Vec::new();
    for column in table.columns {
        let value = match column.mark {
            Mark::Excluded(_) => continue,
            Mark::Value => {
                args.push(stored(&row[column.name]));
                "?".to_owned()
            }
            Mark::Reference { table: target, .. } => {
                let key = &row[column.name];
                if key.is_null() {
                    args.push(SqlValue::Null);
                    "?".to_owned()
                } else {
                    resolve(
                        moved::table(target).expect("references name moved tables"),
                        key,
                        harness,
                        session,
                        &mut args,
                    )
                }
            }
            Mark::Reassigned(Reassigned::SessionId) => {
                args.push(SqlValue::Text(session.to_owned()));
                "?".to_owned()
            }
            Mark::Reassigned(Reassigned::Harness) => {
                args.push(SqlValue::Text(harness.to_owned()));
                "?".to_owned()
            }
            // Appended after the receiver's own publications, in the order
            // the plan inserts them, which is their rank.
            Mark::Reassigned(Reassigned::CommitOrder) => {
                "(SELECT COALESCE(MAX(commit_order), 0) + 1 FROM memory_publications)".to_owned()
            }
            Mark::Reassigned(Reassigned::FactState) => {
                let state = if waiting {
                    "in_flight"
                } else {
                    state.expect("a decoded fact has a state")
                };
                args.push(SqlValue::Text(state.to_owned()));
                "?".to_owned()
            }
            Mark::Reassigned(Reassigned::Reservation) => {
                args.push(if waiting {
                    SqlValue::Text(moved::reservation(cut))
                } else {
                    SqlValue::Null
                });
                "?".to_owned()
            }
        };
        columns.push(quoted(column.name));
        values.push(value);
    }
    Step {
        phase: format!("agent_data/insert/{}", table.name),
        sql: format!(
            "INSERT INTO {} ({}) VALUES ({})",
            quoted(table.name),
            columns.join(", "),
            values.join(", ")
        ),
        args,
    }
}

/// The SQL that finds, on the receiver, the session's row of `target` with
/// natural key `key`, pushing its bound values onto `args` in the order
/// they appear.
fn resolve(
    target: &Table,
    key: &Value,
    harness: &str,
    session: &str,
    args: &mut Vec<SqlValue>,
) -> String {
    let id = target.id.expect("a referenced table names its id column");
    // A publication is named by its id on every machine.
    if target.key == [id] && target.column(id).map(|column| column.mark) == Some(Mark::Value) {
        args.push(stored(key));
        return "?".to_owned();
    }
    let parts: Vec<&Value> = match target.key {
        [_] => vec![key],
        _ => key
            .as_array()
            .expect("a decoded key of several columns is an array")
            .iter()
            .collect(),
    };
    let mut conditions = Vec::new();
    for column in target.columns {
        let bound = match column.mark {
            Mark::Reassigned(Reassigned::SessionId) => session,
            Mark::Reassigned(Reassigned::Harness) => harness,
            _ => continue,
        };
        conditions.push(format!("{} = ?", quoted(column.name)));
        args.push(SqlValue::Text(bound.to_owned()));
    }
    for (column, part) in target.key.iter().zip(parts) {
        let condition = match target.column(column).map(|column| column.mark) {
            Some(Mark::Reference { table: inner, .. }) => resolve(
                moved::table(inner).expect("references name moved tables"),
                part,
                harness,
                session,
                args,
            ),
            _ => {
                args.push(stored(part));
                "?".to_owned()
            }
        };
        conditions.push(format!("{} = {condition}", quoted(column)));
    }
    format!(
        "(SELECT {} FROM {} WHERE {})",
        quoted(id),
        quoted(target.name),
        conditions.join(" AND ")
    )
}
