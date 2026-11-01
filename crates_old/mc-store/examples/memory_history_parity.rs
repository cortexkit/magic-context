use rusqlite::Connection;
use serde_json::{json, Value};
use std::io::Read;

fn main() {
    let mut raw = String::new();
    std::io::stdin().read_to_string(&mut raw).unwrap();
    let input: Value = serde_json::from_str(&raw).unwrap();
    let mut conn = Connection::open(input["database"].as_str().unwrap()).unwrap();
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    if let Some(path) = input["barrier"].as_str() {
        std::fs::write(format!("{path}.ready"), b"ready").unwrap();
        let started = std::time::Instant::now();
        while !std::path::Path::new(path).exists() {
            assert!(started.elapsed().as_secs() < 10, "barrier timed out");
            std::thread::yield_now();
        }
    }
    let receipt = mc_store::memory_history::local_write(
        &mut conn,
        &input["request"],
        input["now"].as_i64().unwrap(),
    )
    .unwrap();
    let mut state = json!({ "receipt": receipt });
    for (key, table, order) in [
        ("rows", "memories", "id"),
        ("history", "memory_history", "id"),
        ("journal", "memory_journal", "id"),
        ("receipts", "memory_decision_receipts", "decision_key"),
        ("links", "memory_successor_links", "source_id,successor_id"),
        ("epochs", "project_state", "project_path"),
    ] {
        let mut statement = conn
            .prepare(&format!("SELECT * FROM {table} ORDER BY {order}"))
            .unwrap();
        let names = statement
            .column_names()
            .iter()
            .map(|name| name.to_string())
            .collect::<Vec<_>>();
        let rows = statement
            .query_map([], |row| {
                let mut value = serde_json::Map::new();
                for (index, name) in names.iter().enumerate() {
                    use rusqlite::types::ValueRef;
                    value.insert(
                        name.clone(),
                        match row.get_ref(index)? {
                            ValueRef::Null => Value::Null,
                            ValueRef::Integer(n) => json!(n),
                            ValueRef::Text(text) => json!(String::from_utf8_lossy(text)),
                            ValueRef::Real(n) => json!(n),
                            ValueRef::Blob(_) => {
                                panic!("unexpected blob in canonical parity tables")
                            }
                        },
                    );
                }
                Ok(Value::Object(value))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        state[key] = json!(rows);
    }
    println!("{}", mc_store::memory_history::canonical_json(&state));
}
