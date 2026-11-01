use mc_store::context_schema::fingerprints::{canonical_schema_sql, fingerprint, schema_snapshot};
use rusqlite::Connection;
use serde_json::Value;
use std::{path::Path, process::Command};

fn vectors() -> Value {
    serde_json::from_str(include_str!(
        "../../../packages/plugin/src/features/magic-context/schema-fingerprint-vectors.json"
    ))
    .unwrap()
}

fn digest(sql: &str) -> String {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(sql).unwrap();
    fingerprint(&schema_snapshot(&db).unwrap())
}

#[test]
fn shared_vectors_match_typescript_and_ignore_column_order() {
    let vectors = vectors();
    for vector in vectors["sql_vectors"].as_array().unwrap() {
        assert_eq!(
            canonical_schema_sql(vector["sql"].as_str().unwrap(), true),
            vector["canonical"].as_str().unwrap()
        );
    }
    for vector in vectors["order_vectors"].as_array().unwrap() {
        assert_eq!(
            digest(vector["sql"].as_str().unwrap()),
            digest(vector["equivalent"].as_str().unwrap())
        );
    }
    let expected = digest(vectors["sql"].as_str().unwrap());
    assert_eq!(digest(vectors["equivalent"].as_str().unwrap()), expected);
    let result = Command::new("bun").args(["-e", "import {Database} from './packages/plugin/src/shared/sqlite'; import {schemaSnapshot,schemaFingerprint} from './packages/plugin/src/features/magic-context/schema-fingerprint'; import v from './packages/plugin/src/features/magic-context/schema-fingerprint-vectors.json'; const db=new Database(':memory:'); db.exec(v.sql); console.log(schemaFingerprint(schemaSnapshot(db))); db.close();"])
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .output().expect("Bun is required for shared vectors");
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert_eq!(String::from_utf8(result.stdout).unwrap().trim(), expected);
}

macro_rules! difference_test {
    ($name:ident) => {
        #[test]
        fn $name() {
            let vectors = vectors();
            let sql = vectors["sql"].as_str().unwrap();
            let mutation = vectors["mutations"]
                .as_array()
                .unwrap()
                .iter()
                .find(|v| v["name"] == stringify!($name))
                .unwrap();
            let before = mutation["before"].as_str().unwrap();
            assert!(sql.contains(before));
            assert_ne!(
                digest(&sql.replacen(before, mutation["after"].as_str().unwrap(), 1)),
                digest(sql)
            );
        }
    };
}

difference_test!(missing_column);
difference_test!(wrong_type);
difference_test!(wrong_default);
difference_test!(missing_index);
difference_test!(missing_trigger);
difference_test!(wrong_notnull);
difference_test!(missing_foreign_key);
difference_test!(wrong_check);
difference_test!(wrong_index_direction);
