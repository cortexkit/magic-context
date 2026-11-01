use mc_module::host_store::{HostStore, DOMAIN_TABLES};
use mc_store::context_schema::{
    fingerprints::{fingerprint, schema_snapshot},
    migrations_legacy::upgrade,
};
use rusqlite::Connection;
use std::{fs, path::Path, process::Command};

#[test]
fn both_upgrade_paths_match_and_runtime_accepts_upgraded_stores() {
    let temp = tempfile::tempdir().unwrap();
    let generator = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../mc-store/testdata/context_schema_legacy/generate.ts");
    let output = Command::new("bun")
        .arg(generator)
        .arg(temp.path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let reference =
        schema_snapshot(&Connection::open(temp.path().join("expected-v95.db")).unwrap()).unwrap();
    let expected = fingerprint(&reference);
    let rust = temp.path().join("rust.db");
    fs::copy(temp.path().join("v95.db"), &rust).unwrap();
    upgrade(&mut Connection::open(&rust).unwrap(), 1_800_000_000_000).unwrap();
    for path in [temp.path().join("expected-v95.db"), rust] {
        let db = Connection::open(&path).unwrap();
        let actual = schema_snapshot(&db).unwrap();
        if actual != reference {
            for row in actual
                .master
                .iter()
                .filter(|row| !reference.master.contains(row))
                .take(3)
            {
                eprintln!("different master: {row:?}");
            }
            for table in actual
                .tables
                .iter()
                .filter(|row| !reference.tables.contains(row))
                .take(3)
            {
                eprintln!("different table: {table:?}");
            }
            if actual.migrations != reference.migrations {
                eprintln!("migration ledger differs");
            }
        }
        assert_eq!(fingerprint(&actual), expected, "{}", path.display());
        drop(db);
        let mut host = HostStore::open(&path).unwrap();
        assert_eq!(
            host.writable_tables().len(),
            DOMAIN_TABLES.len(),
            "{}",
            host.health_value()
        );
        let mut reached = false;
        host.with_domain_transaction(DOMAIN_TABLES, &mut |_| {
            reached = true;
            Ok(())
        })
        .unwrap();
        assert!(
            reached,
            "runtime transaction fence must admit the upgraded schema"
        );
    }
}
