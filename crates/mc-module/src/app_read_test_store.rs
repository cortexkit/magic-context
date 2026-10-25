//! Test-only throwaway stores for app read routing and counter checks.

use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
use rusqlite::{params, Connection, ToSql};
use serde_json::json;

pub(crate) struct TestStores {
    pub context: Connection,
    pub store: Connection,
    _root: tempfile::TempDir,
}

impl TestStores {
    pub fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let context_path = root.path().join("context.db");
        mc_store::single_store_domain::create_test_context_db(&context_path).unwrap();
        let descriptor = StorageDescriptor {
            module_id: "app-read-test".into(),
            storage_namespace: "mc_cache".into(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: root.path().join("store.db").to_string_lossy().into_owned(),
            },
        };
        drop(mc_store::McStore::open(&descriptor).unwrap());
        Self {
            context: Connection::open(context_path).unwrap(),
            store: Connection::open(root.path().join("store.db")).unwrap(),
            _root: root,
        }
    }

    pub fn standalone(&self, session: &str, harness: &str) {
        self.context
            .execute(
                "INSERT INTO session_meta(session_id,harness) VALUES(?1,?2)",
                params![session, harness],
            )
            .unwrap();
    }

    pub fn async_session(
        &self,
        runner: &str,
        harness: &str,
        session: &str,
        generation: u64,
        resync: bool,
    ) -> String {
        let key = crate::providers::Key {
            runner: runner.into(),
            harness: harness.into(),
            session: session.into(),
        };
        let state = json!({"key":key,"runner_module":runner,"generation":generation,"resync":resync,"frozen_edits_version":null,"applied":null});
        self.store.execute("INSERT INTO mc_async_compaction(session_ref,conversation_key,session,state_json) VALUES(?1,?2,?3,?4)", params![key.reference(),key.store_key().conversation_key(),session,state.to_string()]).unwrap();
        format!("{}:async:{generation}", key.engine_key())
    }

    pub fn context_sql(&self, sql: &str) {
        self.context.execute_batch(sql).unwrap();
    }

    pub fn store_sql(&self, sql: &str) {
        self.store.execute_batch(sql).unwrap();
    }

    pub fn tag(&self, session: &str) {
        self.context.execute("INSERT INTO tags(session_id,message_id,type,tag_number,harness) VALUES(?1,'m1','message',1,'pi')", [session]).unwrap();
    }

    pub fn tag_status(&self, session: &str, status: &str) {
        self.context
            .execute(
                "UPDATE tags SET status=?2 WHERE session_id=?1 AND tag_number=1",
                params![session, status],
            )
            .unwrap();
    }

    pub fn compartment(&self, session: &str) {
        self.context.execute("INSERT INTO compartments(session_id,sequence,start_message,end_message,title,content,created_at,harness) VALUES(?1,1,1,2,'title','summary',10,'pi')", [session]).unwrap();
    }

    pub fn revise_compartment(&self, session: &str) {
        self.context.execute("UPDATE compartments SET content='revised summary' WHERE session_id=?1 AND sequence=1", [session]).unwrap();
    }

    pub fn index_message(&self, session: &str, watermark: i64, dirty_floor: i64) {
        self.context.execute("INSERT INTO message_history_index(session_id,last_indexed_ordinal,dirty_floor_ordinal,updated_at,harness) VALUES(?1,?2,?3,10,'pi') ON CONFLICT(session_id) DO UPDATE SET last_indexed_ordinal=excluded.last_indexed_ordinal,dirty_floor_ordinal=excluded.dirty_floor_ordinal", params![session,watermark,dirty_floor]).unwrap();
    }

    pub fn indexed(conn: &Connection, sql: &str, args: &[&dyn ToSql]) {
        let details = conn
            .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
            .unwrap()
            .query_map(args, |r| r.get::<_, String>(3))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert!(!details.is_empty());
        assert!(
            details.iter().all(|p| p.contains("SEARCH")
                && (p.contains("USING INDEX")
                    || p.contains("USING COVERING INDEX")
                    || p.contains("USING INTEGER PRIMARY KEY"))),
            "{sql}: {details:?}"
        );
        assert!(
            !details.iter().any(|p| p.contains("SCAN")),
            "{sql}: {details:?}"
        );
    }
}

#[test]
fn fixture_module_is_test_only_and_unreferenced_by_production() {
    use quote::ToTokens;
    let source = syn::parse_file(include_str!("lib.rs")).unwrap();
    let declarations: Vec<_> = source
        .items
        .iter()
        .filter_map(|item| match item {
            syn::Item::Mod(module) if module.ident == "app_read_test_store" => Some(module),
            _ => None,
        })
        .collect();
    assert_eq!(declarations.len(), 1);
    assert!(declarations[0]
        .attrs
        .iter()
        .any(|attr| attr.to_token_stream().to_string() == "# [cfg (test)]"));

    fn test_only(attrs: &[syn::Attribute]) -> bool {
        attrs
            .iter()
            .any(|attr| attr.to_token_stream().to_string() == "# [cfg (test)]")
    }
    fn production_items(items: Vec<syn::Item>) {
        for item in items {
            if let syn::Item::Mod(module) = &item {
                if test_only(&module.attrs) {
                    continue;
                }
                if let Some((_, items)) = &module.content {
                    production_items(items.clone());
                    continue;
                }
            }
            let tokens = item.to_token_stream().to_string();
            assert!(
                !tokens
                    .split_whitespace()
                    .any(|word| word == "app_read_test_store"),
                "production item references test store: {tokens}"
            );
        }
    }
    fn sources(dir: &std::path::Path) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                sources(&path);
            } else if path.extension().is_some_and(|e| e == "rs")
                && path.file_name().unwrap() != "app_read_test_store.rs"
            {
                production_items(
                    syn::parse_file(&std::fs::read_to_string(path).unwrap())
                        .unwrap()
                        .items,
                );
            }
        }
    }
    sources(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"));
}
