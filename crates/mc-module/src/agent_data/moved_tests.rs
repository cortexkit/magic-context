//! The moved-table guard: [`MOVED`] and [`NOT_MOVED`] against the
//! `context.db` schema ck-mc is built against. Every case the guard must
//! catch has a test that changes the schema or a list and expects it to.

use std::collections::{BTreeSet, HashSet};

use rusqlite::{params, Connection};

use super::moved::{Column, Install, Mark, NotMoved, Reassigned, Required, Scope, Table};
use super::moved::{MOVED, NOT_MOVED};

const SCHEMA: &str = include_str!("../../testdata/context-schema.sql");

/// The fresh schema in memory, with `extra` statements run after it.
fn schema(extra: &str) -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(&SCHEMA.replace(":applied_at", "0"))
        .unwrap();
    conn.execute_batch(extra).unwrap();
    conn
}

struct SchemaColumn {
    name: String,
    declared: String,
    not_null: bool,
    primary: i64,
}

fn tables(conn: &Connection) -> Vec<String> {
    conn.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .unwrap()
    .query_map([], |row| row.get(0))
    .unwrap()
    .collect::<Result<_, _>>()
    .unwrap()
}

fn columns(conn: &Connection, table: &str) -> Vec<SchemaColumn> {
    conn.prepare("SELECT name, type, \"notnull\", pk FROM pragma_table_info(?1) ORDER BY cid")
        .unwrap()
        .query_map(params![table], |row| {
            Ok(SchemaColumn {
                name: row.get(0)?,
                declared: row.get(1)?,
                not_null: row.get(2)?,
                primary: row.get(3)?,
            })
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

fn foreign_targets(conn: &Connection, table: &str) -> Vec<String> {
    conn.prepare("SELECT DISTINCT \"table\" FROM pragma_foreign_key_list(?1)")
        .unwrap()
        .query_map(params![table], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

/// The column sets of the table's UNIQUE constraints, unique indexes and
/// primary key.
fn unique_sets(conn: &Connection, table: &str) -> Vec<Vec<String>> {
    let indexes: Vec<String> = conn
        .prepare("SELECT name FROM pragma_index_list(?1) WHERE \"unique\" = 1")
        .unwrap()
        .query_map(params![table], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let mut sets: Vec<Vec<String>> = indexes
        .iter()
        .map(|index| {
            conn.prepare(
                "SELECT name FROM pragma_index_info(?1) WHERE name IS NOT NULL ORDER BY seqno",
            )
            .unwrap()
            .query_map(params![index], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
        })
        .collect();
    let mut primary: Vec<SchemaColumn> = columns(conn, table)
        .into_iter()
        .filter(|column| column.primary > 0)
        .collect();
    primary.sort_by_key(|column| column.primary);
    if !primary.is_empty() {
        sets.push(primary.into_iter().map(|column| column.name).collect());
    }
    sets
}

/// The identifiers each CHECK constraint of a table's SQL names, lowercase.
/// String literals and comments are skipped, so a word inside a literal is
/// never taken for a column.
fn checks(sql: &str) -> Vec<HashSet<String>> {
    #[derive(PartialEq)]
    enum Token {
        Word(String),
        Open,
        Close,
        Other,
    }
    let chars: Vec<char> = sql.chars().collect();
    let mut tokens = Vec::new();
    let mut at = 0;
    while at < chars.len() {
        let c = chars[at];
        match c {
            '\'' => {
                at += 1;
                while at < chars.len() {
                    if chars[at] == '\'' {
                        if chars.get(at + 1) == Some(&'\'') {
                            at += 2;
                            continue;
                        }
                        break;
                    }
                    at += 1;
                }
                at += 1;
                tokens.push(Token::Other);
            }
            '"' | '`' | '[' => {
                let close = if c == '[' { ']' } else { c };
                let start = at + 1;
                at = start;
                while at < chars.len() && chars[at] != close {
                    at += 1;
                }
                tokens.push(Token::Word(
                    chars[start..at.min(chars.len())]
                        .iter()
                        .collect::<String>()
                        .to_lowercase(),
                ));
                at += 1;
            }
            '-' if chars.get(at + 1) == Some(&'-') => {
                while at < chars.len() && chars[at] != '\n' {
                    at += 1;
                }
            }
            '/' if chars.get(at + 1) == Some(&'*') => {
                at += 2;
                while at + 1 < chars.len() && !(chars[at] == '*' && chars[at + 1] == '/') {
                    at += 1;
                }
                at += 2;
            }
            '(' => {
                tokens.push(Token::Open);
                at += 1;
            }
            ')' => {
                tokens.push(Token::Close);
                at += 1;
            }
            c if c.is_alphanumeric() || c == '_' => {
                let start = at;
                while at < chars.len() && (chars[at].is_alphanumeric() || chars[at] == '_') {
                    at += 1;
                }
                tokens.push(Token::Word(
                    chars[start..at].iter().collect::<String>().to_lowercase(),
                ));
            }
            c if c.is_whitespace() => at += 1,
            _ => {
                tokens.push(Token::Other);
                at += 1;
            }
        }
    }
    let mut found = Vec::new();
    for (index, token) in tokens.iter().enumerate() {
        if *token != Token::Word("check".to_owned()) || tokens.get(index + 1) != Some(&Token::Open)
        {
            continue;
        }
        let mut depth = 0;
        let mut names = HashSet::new();
        for token in &tokens[index + 1..] {
            match token {
                Token::Open => depth += 1,
                Token::Close => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                Token::Word(word) => {
                    names.insert(word.clone());
                }
                Token::Other => {}
            }
        }
        found.push(names);
    }
    found
}

/// SQLite's type affinity for a declared column type.
fn affinity(declared: &str) -> &'static str {
    let declared = declared.to_ascii_uppercase();
    if declared.contains("INT") {
        "INTEGER"
    } else if ["CHAR", "CLOB", "TEXT"]
        .iter()
        .any(|text| declared.contains(text))
    {
        "TEXT"
    } else if declared.is_empty() || declared.contains("BLOB") {
        "BLOB"
    } else if ["REAL", "FLOA", "DOUB"]
        .iter()
        .any(|real| declared.contains(real))
    {
        "REAL"
    } else {
        "NUMERIC"
    }
}

fn is_session_column(name: &str) -> bool {
    name == "session_id" || name.ends_with("_session_id")
}

/// Every way the two lists fail to cover the schema, one line each.
fn check(conn: &Connection, moved: &[Table], not_moved: &[NotMoved]) -> BTreeSet<String> {
    let mut problems = BTreeSet::new();
    let schema_tables = tables(conn);
    let known: HashSet<&str> = schema_tables.iter().map(String::as_str).collect();
    let moved_names: HashSet<&str> = moved.iter().map(|table| table.name).collect();
    let mut classified: HashSet<&str> = HashSet::new();
    for name in moved
        .iter()
        .map(|table| table.name)
        .chain(not_moved.iter().map(|table| table.name))
    {
        if !classified.insert(name) {
            problems.insert(format!("{name} is listed twice"));
        }
        if !known.contains(name) {
            problems.insert(format!("{name} is listed but the schema has no such table"));
        }
    }
    for entry in not_moved {
        if entry.reason.trim().is_empty() {
            problems.insert(format!("{} is not moved but gives no reason", entry.name));
        }
        match entry.install {
            Install::Untouched(reason) if reason.trim().is_empty() => {
                problems.insert(format!(
                    "{} does not say why the install leaves its rows",
                    entry.name
                ));
            }
            Install::DeletedWithCompartments
                if !columns(conn, entry.name)
                    .iter()
                    .any(|column| column.name == "compartment_id") =>
            {
                problems.insert(format!(
                    "{} is deleted with its summaries but has no compartment_id",
                    entry.name
                ));
            }
            _ => {}
        }
    }
    // Every table that holds session data or refers to a moved row.
    let id_names: Vec<(&str, &str)> = moved
        .iter()
        .flat_map(|table| table.id_names.iter().map(move |id| (table.name, *id)))
        .collect();
    for table in &schema_tables {
        if classified.contains(table.as_str()) {
            continue;
        }
        let schema_columns = columns(conn, table);
        if let Some(column) = schema_columns
            .iter()
            .find(|column| is_session_column(&column.name))
        {
            problems.insert(format!(
                "{table} holds session data ({}) but is in neither list",
                column.name
            ));
        }
        for target in foreign_targets(conn, table) {
            if moved_names.contains(target.as_str()) {
                problems.insert(format!(
                    "{table} has a foreign key to moved table {target} but is in neither list"
                ));
            }
        }
        for column in &schema_columns {
            for (owner, id) in &id_names {
                if column.name == *id && owner != table {
                    problems.insert(format!(
                        "{table}.{id} names a row of moved table {owner} but {table} is in neither list"
                    ));
                }
            }
        }
    }
    for (position, table) in moved.iter().enumerate() {
        check_table(conn, moved, position, table, &mut problems);
    }
    problems
}

fn check_table(
    conn: &Connection,
    moved: &[Table],
    position: usize,
    table: &Table,
    problems: &mut BTreeSet<String>,
) {
    let name = table.name;
    let schema_columns = columns(conn, name);
    if schema_columns.is_empty() {
        return;
    }
    let mut marked = HashSet::new();
    for column in table.columns {
        if !marked.insert(column.name) {
            problems.insert(format!("{name}.{} is marked twice", column.name));
        }
        if !schema_columns.iter().any(|known| known.name == column.name) {
            problems.insert(format!(
                "{name}.{} is marked but the table has no such column",
                column.name
            ));
        }
    }
    for column in &schema_columns {
        let Some(mark) = table.column(&column.name).map(|column| column.mark) else {
            problems.insert(format!("{name}.{} has no mark", column.name));
            continue;
        };
        if !matches!(mark, Mark::Excluded(_))
            && !matches!(affinity(&column.declared), "INTEGER" | "TEXT")
        {
            problems.insert(format!(
                "{name}.{} is moved but is {} ({}); the install's write plan carries only text, integer and null values",
                column.name,
                affinity(&column.declared),
                column.declared
            ));
        }
        if let Mark::Reference {
            table: target,
            required,
        } = mark
        {
            check_reference(moved, position, table, column, target, required, problems);
        }
    }
    let nullable = |column: &str| {
        schema_columns
            .iter()
            .any(|known| known.name == column && !known.not_null)
    };
    let sql: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1",
            params![name],
            |row| row.get(0),
        )
        .unwrap();
    for named in checks(&sql) {
        for column in table.columns {
            if let Mark::Reference { required, .. } = column.mark {
                if named.contains(column.name)
                    && nullable(column.name)
                    && !matches!(required, Required::When { .. })
                {
                    problems.insert(format!(
                        "{name}.{} is a nullable reference a CHECK names, but its mark records no condition",
                        column.name
                    ));
                }
            }
        }
    }
    for set in unique_sets(conn, name) {
        let scoped = set.iter().any(|column| {
            table.key.contains(&column.as_str())
                || matches!(
                    table.column(column).map(|column| column.mark),
                    Some(
                        Mark::Reference { .. }
                            | Mark::Reassigned(Reassigned::SessionId | Reassigned::Harness)
                    )
                )
        });
        if scoped {
            continue;
        }
        for column in &set {
            if table.column(column).map(|column| column.mark) == Some(Mark::Value) {
                problems.insert(format!(
                    "{name}.{column} is unique across the machine ({set:?}) but is not marked reassigned"
                ));
            }
        }
    }
    for key in table.key {
        if !table
            .column(key)
            .is_some_and(|column| column.mark.carried())
        {
            problems.insert(format!("{name}'s natural key column {key} is not carried"));
        }
    }
    if let Some(id) = table.id {
        if id != "rowid" && table.column(id).is_none() {
            problems.insert(format!("{name}'s id column {id} is not marked"));
        }
    }
    let marked_as = |column: &str, mark: Mark| table.column(column).map(|c| c.mark) == Some(mark);
    let scope_ok = match table.scope {
        Scope::Session(_) => {
            marked_as("session_id", Mark::Reassigned(Reassigned::SessionId))
                && marked_as("harness", Mark::Reassigned(Reassigned::Harness))
        }
        Scope::Compartment => matches!(
            table.column("compartment_id").map(|c| c.mark),
            Some(Mark::Reference {
                table: "compartments",
                ..
            })
        ),
        Scope::Publication(_) => {
            name == "memory_publications"
                || matches!(
                    table.column("publication_id").map(|c| c.mark),
                    Some(Mark::Reference {
                        table: "memory_publications",
                        ..
                    })
                )
        }
        Scope::PublicationFact => matches!(
            table.column("fact_id").map(|c| c.mark),
            Some(Mark::Reference {
                table: "memory_pending_facts",
                ..
            })
        ),
    };
    if !scope_ok {
        problems.insert(format!(
            "{name}'s scope {:?} does not match its columns",
            table.scope
        ));
    }
}

fn check_reference(
    moved: &[Table],
    position: usize,
    table: &Table,
    column: &SchemaColumn,
    target: &str,
    required: Required,
    problems: &mut BTreeSet<String>,
) {
    let name = table.name;
    let label = format!("{name}.{}", column.name);
    match moved.iter().position(|candidate| candidate.name == target) {
        None => {
            problems.insert(format!(
                "{label} refers to {target}, which the move does not carry, so it has no natural key"
            ));
        }
        Some(index) => {
            let parent = &moved[index];
            if parent.key.is_empty() || parent.id.is_none() {
                problems.insert(format!(
                    "{label} refers to {target}, which names no natural key"
                ));
            }
            if index >= position {
                problems.insert(format!(
                    "{label} refers to {target}, which is not listed before {name}"
                ));
            }
        }
    }
    match required {
        Required::Always if !column.not_null => {
            problems.insert(format!(
                "{label} is marked always required but the column may be null"
            ));
        }
        Required::Never | Required::When { .. } if column.not_null => {
            problems.insert(format!(
                "{label} is NOT NULL, so every row requires it, but its mark says otherwise"
            ));
        }
        Required::When {
            column: condition, ..
        } if table.column(condition).map(|c| c.mark) != Some(Mark::Value) => {
            problems.insert(format!(
                "{label}'s condition names {condition}, which is not a carried value of {name}"
            ));
        }
        _ => {}
    }
}

/// The moved list with one table's columns changed.
fn edited(table: &str, edit: impl FnOnce(&mut Vec<Column>)) -> Vec<Table> {
    let mut edit = Some(edit);
    MOVED
        .iter()
        .map(|candidate| {
            let mut candidate = *candidate;
            if candidate.name == table {
                let mut columns = candidate.columns.to_vec();
                (edit.take().unwrap())(&mut columns);
                candidate.columns = Box::leak(columns.into_boxed_slice());
            }
            candidate
        })
        .collect()
}

fn remark(columns: &mut [Column], name: &str, mark: Mark) {
    columns
        .iter_mut()
        .find(|column| column.name == name)
        .unwrap()
        .mark = mark;
}

#[track_caller]
fn assert_fails(problems: &BTreeSet<String>, expected: &[&str]) {
    assert!(
        problems
            .iter()
            .any(|problem| expected.iter().all(|part| problem.contains(part))),
        "expected a problem naming {expected:?}, got {problems:#?}"
    );
}

#[test]
fn the_lists_cover_the_schema_as_it_is() {
    let problems = check(&schema(""), MOVED, NOT_MOVED);
    assert!(problems.is_empty(), "{problems:#?}");
}

#[test]
fn an_unclassified_session_table_fails() {
    let conn = schema("CREATE TABLE session_widgets (session_id TEXT, harness TEXT, x TEXT);");
    assert_fails(
        &check(&conn, MOVED, NOT_MOVED),
        &["session_widgets", "session_id", "neither list"],
    );
    let conn = schema("CREATE TABLE widget_runs (parent_session_id TEXT, x TEXT);");
    assert_fails(
        &check(&conn, MOVED, NOT_MOVED),
        &["widget_runs", "parent_session_id", "neither list"],
    );
}

#[test]
fn an_unclassified_child_of_a_moved_table_fails() {
    let conn = schema("CREATE TABLE fact_votes (id INTEGER PRIMARY KEY, fact_id INTEGER);");
    assert_fails(
        &check(&conn, MOVED, NOT_MOVED),
        &["fact_votes.fact_id", "memory_pending_facts", "neither list"],
    );
    let conn = schema(
        "CREATE TABLE summary_marks (id INTEGER PRIMARY KEY, summary INTEGER REFERENCES compartments(id));",
    );
    assert_fails(
        &check(&conn, MOVED, NOT_MOVED),
        &["summary_marks", "foreign key", "compartments"],
    );
}

#[test]
fn a_new_column_on_a_moved_table_fails() {
    let conn = schema("ALTER TABLE compartments ADD COLUMN summary_kind TEXT;");
    assert_fails(
        &check(&conn, MOVED, NOT_MOVED),
        &["compartments.summary_kind", "no mark"],
    );
}

#[test]
fn a_moved_column_with_no_mark_or_a_mark_without_a_column_fails() {
    let unmarked = edited("notes", |columns| {
        columns.retain(|column| column.name != "anchor_ordinal")
    });
    assert_fails(
        &check(&schema(""), &unmarked, NOT_MOVED),
        &["notes.anchor_ordinal", "no mark"],
    );
    let stray = edited("session_facts", |columns| {
        columns.push(Column {
            name: "weight",
            mark: Mark::Value,
        })
    });
    assert_fails(
        &check(&schema(""), &stray, NOT_MOVED),
        &["session_facts.weight", "no such column"],
    );
}

#[test]
fn a_machine_wide_unique_column_not_reassigned_fails() {
    let carried = edited("memory_publications", |columns| {
        remark(columns, "commit_order", Mark::Value)
    });
    assert_fails(
        &check(&schema(""), &carried, NOT_MOVED),
        &[
            "memory_publications.commit_order",
            "unique across the machine",
        ],
    );
    let conn = schema("CREATE UNIQUE INDEX idx_session_facts_content ON session_facts(content);");
    assert_fails(
        &check(&conn, MOVED, NOT_MOVED),
        &["session_facts.content", "unique across the machine"],
    );
}

#[test]
fn a_real_or_blob_moved_column_fails() {
    let blob = edited("compartments", |columns| {
        remark(columns, "p1_embedding", Mark::Value)
    });
    assert_fails(
        &check(&schema(""), &blob, NOT_MOVED),
        &["compartments.p1_embedding", "BLOB"],
    );
    let conn = schema("ALTER TABLE session_facts ADD COLUMN weight REAL;");
    let real = edited("session_facts", |columns| {
        columns.push(Column {
            name: "weight",
            mark: Mark::Value,
        })
    });
    assert_fails(
        &check(&conn, &real, NOT_MOVED),
        &["session_facts.weight", "REAL"],
    );
}

#[test]
fn a_reference_without_a_natural_key_fails() {
    let keyless = edited("compartment_events", |columns| {
        remark(
            columns,
            "compartment_id",
            Mark::Reference {
                table: "session_facts",
                required: Required::Never,
            },
        )
    });
    assert_fails(
        &check(&schema(""), &keyless, NOT_MOVED),
        &[
            "compartment_events.compartment_id",
            "session_facts",
            "no natural key",
        ],
    );
    let unmoved = edited("memory_pending_facts", |columns| {
        remark(
            columns,
            "matched_memory_id",
            Mark::Reference {
                table: "memories",
                required: Required::Never,
            },
        )
    });
    assert_fails(
        &check(&schema(""), &unmoved, NOT_MOVED),
        &[
            "memory_pending_facts.matched_memory_id",
            "memories",
            "no natural key",
        ],
    );
}

#[test]
fn a_check_naming_a_nullable_reference_needs_its_condition() {
    let unconditional = edited("compartment_score_selections", |columns| {
        remark(
            columns,
            "revision_id",
            Mark::Reference {
                table: "compartment_score_revisions",
                required: Required::Never,
            },
        )
    });
    assert_fails(
        &check(&schema(""), &unconditional, NOT_MOVED),
        &[
            "compartment_score_selections.revision_id",
            "records no condition",
        ],
    );
}

#[test]
fn check_constraints_are_read_without_their_literals() {
    let found = checks(
        "CREATE TABLE t (a INTEGER CHECK (a > 0), b TEXT, -- CHECK (c)\n CHECK (b IN ('revision_id', 'x')) )",
    );
    assert_eq!(found.len(), 2);
    assert!(found[0].contains("a"));
    assert!(found[1].contains("b"));
    assert!(!found[1].contains("revision_id"));
    assert_eq!(affinity("INTEGER"), "INTEGER");
    assert_eq!(affinity("REAL"), "REAL");
    assert_eq!(affinity(""), "BLOB");
}
