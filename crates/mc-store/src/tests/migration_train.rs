//! Populated, single-increment upgrades, including rollback and older-binary fences.
use super::*;
use crate::provider_records::ProviderSessionKey;
use rusqlite::types::Value as SqlValue;
use std::collections::BTreeMap;

fn chain(version: u32) -> Vec<Migration> {
    MIGRATIONS
        .iter()
        .filter(|m| m.version <= version)
        .cloned()
        .collect()
}

// Limit the opener's migration ceiling so a successful step cannot silently run later migrations.
fn open_at(descriptor: &StorageDescriptor, version: u32) -> McStore {
    let store = McStore::open_with_migrations(descriptor, false, &chain(version)).unwrap();
    assert_eq!(store.module_store_schema_version().unwrap(), version);
    store
}

#[derive(Debug, PartialEq)]
struct TableRows {
    columns: Vec<String>,
    rows: Vec<Vec<SqlValue>>,
}

#[derive(Debug, PartialEq)]
struct Snapshot {
    schema: Vec<(String, String, Option<String>)>,
    tables: BTreeMap<String, TableRows>,
}

fn sorted(mut rows: Vec<Vec<SqlValue>>) -> Vec<Vec<SqlValue>> {
    rows.sort_by_cached_key(|row| format!("{row:?}"));
    rows
}

fn snapshot(conn: &rusqlite::Connection) -> rusqlite::Result<Snapshot> {
    let schema = conn
        .prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<Vec<(String, String, Option<String>)>>>()?;
    let mut tables = BTreeMap::new();
    for (_, name, _) in schema.iter().filter(|(kind, _, _)| kind == "table") {
        let mut stmt = conn.prepare(&format!("SELECT * FROM \"{name}\""))?;
        let columns = stmt.column_names().iter().map(|s| s.to_string()).collect();
        let width = stmt.column_count();
        let rows = stmt
            .query_map([], |r| {
                (0..width)
                    .map(|i| r.get(i))
                    .collect::<rusqlite::Result<Vec<_>>>()
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        tables.insert(
            name.clone(),
            TableRows {
                columns,
                rows: sorted(rows),
            },
        );
    }
    Ok(Snapshot { schema, tables })
}

fn store_snapshot(store: &McStore) -> Snapshot {
    store.inner.with_conn(snapshot).unwrap()
}

fn provider_key(harness: &str) -> ProviderSessionKey {
    ProviderSessionKey {
        project_root: "/populated".into(),
        session: format!("provider-{harness}"),
        harness: harness.into(),
        generation: None,
    }
}

fn record() -> serde_json::Value {
    serde_json::json!({
        "catalog":{"compacting":true,"tools":["ctx_reduce"]},
        "setup":{"request":{"lineage_id":"L","params":{"serializer_profile":"owned-broca"}},
            "state":{"compaction_id":"c","version_high_water":9,"rebuild_epoch":2,
                "last_produced":{"version":9,"range":{"lineage_id":"L","from":4,"to":5},"replacement":[{"content":"frozen"}]},
                "last_applied":{"version":8,"range":{"lineage_id":"L","from":4,"to":5},"replacement":[{"content":"applied"}]}}},
        "hook":{"high_water":12,"answers":[{"subject":"digest","lineage":"L","answer":{"ops":[{"op":"prepend","text":"§12§ "}]},"rendered":["§12§ payload"],"tags":[12],"cadence":true,"observed":false,"tool_call_id":"repeat"}],
            "live":{"10":{"lineage":"L","ordinal":4,"block_id":"m4#0","kind":"text","source":"payload"}},"burned":[11]},
        "messages":{"L":{"4":{"ordinal":4,"mid":"m4","message":{"role":"user","content":"résumé"}}},"empty":{}},
        "pending_drops":[10,12],"last_answer":{"request_id":"r","answer":"noop"},
        "future_field":{"keep":true}
    })
}

/// The populated record without its view bodies. The current record writer
/// takes views only as version references with v2 recipes and refuses a
/// record that carries a whole view body.
fn record_without_views() -> serde_json::Value {
    let mut record = record();
    let state = record["setup"]["state"].as_object_mut().unwrap();
    state.remove("last_produced");
    state.remove("last_applied");
    record
}

/// Both legacy-keyed runner conversations own rows in the retired
/// mc_provider_views_v1 table, so migration 73 resets exactly these two.
const VIEWED_V1: [&str; 2] = ["broca", "claude-code"];

const HARNESS: [&str; 4] = ["broca", "claude-code", "opencode", "opencode2"];

/// Harnesses whose populated conversations still exist at `version`: migration
/// 72 reset the two OpenCode ledgers; 73 retired all remaining v1 view owners.
fn seeded_harnesses(version: u32) -> impl Iterator<Item = &'static str> {
    HARNESS
        .into_iter()
        .filter(move |_| version < 73)
        .filter(move |harness| version < 72 || !harness.starts_with("opencode"))
}

fn native_key() -> ProviderSessionKey {
    ProviderSessionKey {
        generation: Some(crate::provider_records::ProviderGeneration {
            profile: "profile-1".into(),
            provider: "provider-1".into(),
        }),
        ..provider_key("claude-code")
    }
}

fn scalar<T: rusqlite::types::FromSql>(store: &McStore, sql: &str) -> T {
    store
        .inner
        .with_conn(|conn| conn.query_row(sql, [], |r| r.get(0)))
        .unwrap()
}

fn sql(store: &McStore, statements: &str) {
    store
        .inner
        .with_conn_fenced(|conn| conn.execute_batch(statements))
        .unwrap();
}

fn freeze_fixture(store: &McStore, mover: &mut crate::move_store::MoveStore, cut: &str) {
    if scalar::<u32>(
        store,
        "SELECT count(*) FROM sqlite_master WHERE name='mc_provider_conversations_v2'",
    ) == 0
    {
        // These historical schemas predate provider launch records. Seed their frozen
        // phase directly; the current freeze API checks tables introduced later.
        store
            .inner
            .with_conn(|conn| {
                conn.execute(
                    "UPDATE mc_move_fences SET phase='frozen' WHERE cut_id=?1 AND phase='draining'",
                    [cut],
                )?;
                Ok(())
            })
            .unwrap();
    } else {
        mover.freeze(cut).unwrap();
    }
}

fn core() -> CoreState {
    let mut core = CoreState::default();
    core.frozen_units.push(FrozenUnit {
        key: "m0".into(),
        kind: "synth-region".into(),
        durability_class: DurabilityClass::Lineage,
        frozen_payload: "frozen populated prefix — unchanged".into(),
        reset_rule: String::new(),
    });
    core
}

fn seed(descriptor: &StorageDescriptor, version: u32) -> Snapshot {
    let inner = open_sqlite(descriptor).unwrap();
    inner.with_conn(register_legacy_trigger_functions).unwrap();
    // Historical writers cannot name the split cache or normalized provider columns.
    // Populate their real older layouts, then use the bundled migration chain to reach N.
    inner.migrate(NS, &chain(62)).unwrap();
    inner.with_conn(|conn| {
        conn.execute("INSERT INTO mc_cache_state(session_id,row_version,core_state,meta) VALUES('legacy',7,?1,?2)",
            params![serde_json::to_string(&core()).unwrap(), serde_json::to_string(&ModuleMeta::default()).unwrap()])?;
        conn.execute("INSERT INTO mc_tags(session_id,tag_number,block_id,kind,token_count,created_at_ms,source_bytes) VALUES('legacy',11,'m4#0','tool_result',4,10,x'7061796c6f6164')", [])?;
        conn.execute("INSERT INTO pending_agent_drops(session_id,target_id,queued_at) VALUES('legacy','m4#0',10)", [])?;
        conn.execute("UPDATE mc_privilege_state SET single_store=1,single_store_set_at_ms=123,single_store_set_by='populated-migration-test' WHERE id=1", [])?;
        Ok(())
    }).unwrap();
    inner.migrate(NS, &chain(version.min(65))).unwrap();
    if version >= 65 {
        inner
            .with_conn(|conn| {
                for harness in HARNESS {
                    let key = provider_key(harness);
                    conn.execute(
                        "INSERT INTO mc_provider_sessions_v1 VALUES(?1,?2,?3,?4)",
                        params![
                            key.project_root,
                            key.session,
                            key.harness,
                            record().to_string()
                        ],
                    )?;
                    conn.execute(
                        "INSERT INTO mc_provider_catalogs_v1 VALUES(?1,?2,?3)",
                        params![
                            key.project_root,
                            key.session,
                            r#"{ "tools": ["ctx_reduce"], "kept": true }"#
                        ],
                    )?;
                }
                Ok(())
            })
            .unwrap();
        inner.migrate(NS, &chain(version)).unwrap();
    }
    if version == 63 {
        return inner.with_conn(snapshot).unwrap();
    }
    drop(inner);
    let store = open_at(descriptor, version);
    for session in
        std::iter::once("legacy".to_string()).chain(HARNESS.map(|h| provider_key(h).session))
    {
        let loaded = store.load(&session).unwrap();
        let mut meta = ModuleMeta::default();
        if version >= 67 {
            meta.held_release = Some(serde_json::json!({"reason":"flush","obligations":["flush"]}));
            meta.score_selection_watermark = 19;
        }
        if version >= 69 {
            meta.memory_projection = Some(memory_projection::AppliedProjection {
                legacy: true,
                hard_memory_block: "shown delta".into(),
                generation: 1,
                ..Default::default()
            });
        }
        store
            .commit(&session, loaded.row_version, &core(), &meta)
            .unwrap();
    }
    if version >= 66 {
        store.inner.with_conn_fenced(|conn| {
            for harness in seeded_harnesses(version) {
                let key = provider_key(harness);
                let conv = key.conversation_key();
                let policy = r#"{"tag_number":10,"tag_kind":"tool_result","arc_id":"arc","served":false,"measurement":{"tokens":40}}"#;
                conn.execute("INSERT INTO mc_provider_policy_parts_v1 VALUES(?1,'L',4,'m4#0',?2,?3)", params![conv,policy,key.session])?;
                let namespace: String = conn.query_row("SELECT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key=?1", [&conv], |r| r.get(0))?;
                conn.execute("INSERT INTO mc_provider_consumed_tags_v1 VALUES(?1,12,?2)", params![namespace,key.session])?;
                if version >= 68 {
                    conn.execute("INSERT INTO mc_provider_policy_summaries_v1 VALUES(?1,'{\"kept\":true}',?2)",params![conv,key.session])?;
                }
            }
            Ok(())
        }).unwrap();
    }
    if version >= 70 {
        let key = native_key();
        store
            .save_provider_conversation(
                &key,
                &crate::provider_log::ProviderConversation {
                    engine_namespace: "explicit-engine".into(),
                    lineage_id: "G".into(),
                    native_pins_json: Some(
                        r#"{"profile_generation":"profile-1","provider_generation":"provider-1"}"#
                            .into(),
                    ),
                    native_plan_json: Some("{}".into()),
                    ..Default::default()
                },
            )
            .unwrap();
    }
    if version >= 71 {
        for harness in seeded_harnesses(version) {
            assert!(store
                .prepare_provider_policy(&provider_key(harness), |_, _| Ok(Some(
                    crate::provider_preparation::ProviderPreparationWrite {
                        settings_key: "prepared-settings".into(),
                        original_baseline_json: "{}".into(),
                        newest_ordinal: 4,
                        prepared_json: "{\"prepared\":true}".into(),
                    }
                )))
                .unwrap());
        }
    }
    let mut mover = store.move_store().unwrap();
    mover
        .acquire_fence(&crate::move_store::CutBinding {
            cut_id: "populated-cut".into(),
            session_ref: "0123456789abcdef".into(),
            host_session_id: "legacy".into(),
            host_end_offset: 42,
            host_cut: serde_json::json!({"lastMessageId":"m4"}),
            mc_start_offset: 100,
        })
        .unwrap();
    freeze_fixture(&store, &mut mover, "populated-cut");
    store_snapshot(&store)
}

fn assert_preserved(before: &Snapshot, after: &Snapshot, target: u32) {
    // Conversation keys and engine namespaces that migration 73 resets.
    let reset: Vec<(String, String)> = if target == 73 {
        let conversations = &before.tables["mc_provider_conversations_v2"];
        let ki = conversations
            .columns
            .iter()
            .position(|c| c == "conv_key")
            .unwrap();
        let ni = conversations
            .columns
            .iter()
            .position(|c| c == "engine_namespace")
            .unwrap();
        let keys: Vec<String> = VIEWED_V1
            .iter()
            .map(|h| provider_key(h).conversation_key())
            .collect();
        conversations
            .rows
            .iter()
            .filter_map(|row| match (&row[ki], &row[ni]) {
                (SqlValue::Text(k), SqlValue::Text(n)) if keys.contains(k) => {
                    Some((k.clone(), n.clone()))
                }
                _ => None,
            })
            .collect()
    } else {
        Vec::new()
    };
    if target == 73 {
        assert_eq!(reset.len(), 2, "both v1-owning conversations are seeded");
    }
    for (name, old) in &before.tables {
        if target == 73 && name == "mc_provider_views_v1" {
            assert!(
                !after.tables.contains_key(name),
                "migration 73 drops {name}"
            );
            continue;
        }
        let new = after
            .tables
            .get(name)
            .unwrap_or_else(|| panic!("migration {target} dropped {name}"));
        let indices: Vec<_> = old
            .columns
            .iter()
            .map(|column| {
                new.columns
                    .iter()
                    .position(|c| c == column)
                    .unwrap_or_else(|| panic!("migration {target} lost {name}.{column}"))
            })
            .collect();
        let mut expected = old.rows.clone();
        let mut actual: Vec<Vec<SqlValue>> = new
            .rows
            .iter()
            .map(|row| indices.iter().map(|&i| row[i].clone()).collect())
            .collect();
        if name == "cortexkit_schema_version" {
            let vi = old.columns.iter().position(|c| c == "version").unwrap();
            actual.retain(|row| row[vi] != SqlValue::Integer(i64::from(target)));
        }
        if target == 72 {
            // The recipe cutover deletes only the two native OpenCode ledgers.
            // Their namespace revision advances as each policy input is retired.
            if name == "mc_provider_policy_revisions_v1" {
                let si = old.columns.iter().position(|c| c == "session").unwrap();
                let ri = old.columns.iter().position(|c| c == "revision").unwrap();
                for row in &mut expected {
                    if matches!(&row[si], SqlValue::Text(s) if s == "provider-opencode" || s == "provider-opencode2")
                    {
                        let SqlValue::Integer(revision) = &mut row[ri] else {
                            panic!("integer revision")
                        };
                        *revision += 11;
                    }
                }
            } else if name.starts_with("mc_provider_")
                && name != "mc_provider_catalogs_v1"
                && name != "mc_provider_consumed_tags_v1"
            {
                let si = old.columns.iter().position(|c| c == "session").unwrap();
                expected.retain(|row| !matches!(&row[si], SqlValue::Text(s) if s == "provider-opencode" || s == "provider-opencode2"));
            }
        }
        if target == 73 {
            let column = |c: &str| old.columns.iter().position(|n| n == c);
            if name == "mc_provider_policy_revisions_v1" {
                // Deleting a reset conversation's policy inputs advances its
                // namespace revision; every other namespace is untouched.
                let ni = column("engine_namespace").unwrap();
                let ri = column("revision").unwrap();
                for row in &mut expected {
                    if reset
                        .iter()
                        .any(|(_, n)| matches!(&row[ni], SqlValue::Text(s) if s == n))
                    {
                        let current = actual
                            .iter()
                            .find(|a| a[ni] == row[ni])
                            .expect("reset namespace keeps its revision row");
                        assert!(
                            matches!((&current[ri], &row[ri]), (SqlValue::Integer(a), SqlValue::Integer(b)) if a > b),
                            "migration 73 did not fence the reset namespace's revision"
                        );
                        row[ri] = current[ri].clone();
                    }
                }
            } else if name == "mc_provider_sessions_v1" {
                let si = column("session").unwrap();
                let hi = column("harness").unwrap();
                expected.retain(|row| {
                    !VIEWED_V1.iter().any(|h| {
                        row[hi] == SqlValue::Text((*h).into())
                            && row[si] == SqlValue::Text(provider_key(h).session)
                    })
                });
            } else if let Some(ki) = column("conv_key") {
                expected.retain(|row| {
                    !reset
                        .iter()
                        .any(|(k, _)| matches!(&row[ki], SqlValue::Text(s) if s == k))
                });
            }
        }
        assert_eq!(
            sorted(actual),
            sorted(expected),
            "migration {target} changed preserved rows in {name}"
        );
    }
}

fn assert_metadata_and_inventory(store: &McStore, version: u32) {
    assert_eq!(store.module_store_schema_version().unwrap(), version);
    let recorded: Vec<u32> = store
        .inner
        .with_conn(|conn| {
            conn.prepare(
                "SELECT version FROM cortexkit_schema_version WHERE namespace=?1 ORDER BY version",
            )?
            .query_map([NS], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap();
    assert_eq!(recorded, (1..=version).collect::<Vec<_>>());
    let snap = store_snapshot(store);
    for (name, table) in &snap.tables {
        // The retired view table exists only below 73; the current inventory
        // no longer classifies it, and migration 73 removes it.
        if name.starts_with("sqlite_") || (version < 73 && name == "mc_provider_views_v1") {
            continue;
        }
        let entry = crate::move_inventory::tables(crate::move_inventory::Store::Module)
            .find(|t| t.table == name)
            .unwrap_or_else(|| panic!("unclassified table {name}"));
        assert!(
            table
                .columns
                .iter()
                .all(|c| entry.columns.contains(&c.as_str())),
            "unclassified column in {name}"
        );
        if let Some(created) = migration_creating_table(name) {
            assert!(
                created <= version,
                "future table {name} leaked into version {version}"
            );
        }
        if entry.session_column().is_some()
            && entry.class != crate::move_inventory::Class::NotSession
        {
            for action in ["insert", "update", "delete"] {
                let guard = format!("mc_move_guard_{name}_{action}");
                assert_eq!(scalar::<u32>(store, &format!("SELECT count(*) FROM sqlite_temp_master WHERE type='trigger' AND name='{guard}'")), 1, "{guard}");
            }
        }
    }
    if version == LATEST_MIGRATION_VERSION {
        store
            .inner
            .with_conn(|conn| {
                crate::move_inventory::validate_schema(conn, crate::move_inventory::Store::Module)
                    .unwrap();
                Ok(())
            })
            .unwrap();
        assert_eq!(crate::move_inventory::INVENTORY_VERSION, 9);
        assert_eq!(
            crate::move_inventory::STORE_SCHEMA_VERSION,
            LATEST_MIGRATION_VERSION
        );
    }
}

fn assert_fault_rolls_back(descriptor: &StorageDescriptor, before: &Snapshot, target: u32) {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    let inner = open_sqlite(descriptor).unwrap();
    inner.with_conn(register_legacy_trigger_functions).unwrap();
    let reached = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let hit = reached.clone();
    inner
        .with_conn(|conn| {
            conn.authorizer(Some(move |context: AuthContext<'_>| {
                let deny = match context.action {
                    AuthAction::CreateTable { table_name } => {
                        table_name
                            == match target {
                                64 => "mc_move_installs",
                                65 => "mc_provider_catalogs_v1",
                                66 => "mc_provider_messages_v1",
                                68 => "mc_provider_policy_changes_v1",
                                71 => "mc_provider_policy_preparations_v1",
                                72 => "mc_provider_policy_cuts_v1",
                                74 => "mc_async_compaction_baselines",
                                _ => "",
                            }
                    }
                    AuthAction::CreateIndex { index_name, .. } => {
                        target == 70 && index_name == "mc_provider_conversations_session"
                    }
                    // Migration 73 creates no table. Deny its last statement, the
                    // table drop, so every reset before it must roll back too.
                    AuthAction::DropTable { table_name } => {
                        target == 73 && table_name == "mc_provider_views_v1"
                    }
                    // Fence-only migrations have one no-op statement: fail their durable stamp.
                    AuthAction::Insert { table_name } => {
                        matches!(target, 67 | 69) && table_name == "cortexkit_schema_version"
                    }
                    _ => false,
                };
                if deny {
                    hit.store(true, std::sync::atomic::Ordering::SeqCst);
                    Authorization::Deny
                } else {
                    Authorization::Allow
                }
            }));
            Ok(())
        })
        .unwrap();
    let error = inner.migrate(NS, &chain(target)).unwrap_err();
    assert!(
        reached.load(std::sync::atomic::Ordering::SeqCst),
        "fault was not reached in migration {target}"
    );
    assert!(error.to_string().contains("not authorized"), "{error}");
    inner
        .with_conn(|conn| {
            conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>);
            assert_eq!(
                snapshot(conn)?,
                *before,
                "migration {target} did not roll back schema, rows and stamps"
            );
            assert_eq!(
                single_store_schema::recorded_store_version(conn)?,
                target - 1
            );
            Ok(())
        })
        .unwrap();
    drop(inner);
    if target == 64 {
        // The v63 schema has no mc_move_fences table. Today's limited-chain opener
        // installs session-transfer write guards that query it, so use only the
        // SQLite migrator to reopen the schema a v63 binary understands.
        let reopened = open_sqlite(descriptor).unwrap();
        reopened
            .with_conn(register_legacy_trigger_functions)
            .unwrap();
        let outcome = reopened.migrate(NS, &chain(63)).unwrap();
        assert_eq!(outcome.recorded, 63);
        assert_eq!(reopened.with_conn(snapshot).unwrap(), *before);
    } else {
        let reopened = open_at(descriptor, target - 1);
        assert_eq!(
            store_snapshot(&reopened),
            *before,
            "failed upgrade must reopen unchanged at the old ceiling"
        );
    }
}

fn seed_context(path: &std::path::Path) -> Snapshot {
    // Since store v61, authority and LKG belong to the paired host context.db.
    // Use the public test bootstrap, not replacement domain tables in store.db.
    single_store_domain::create_test_context_db(path).unwrap();
    let conn = rusqlite::Connection::open(path).unwrap();
    conn.execute_batch(
        "UPDATE single_store_state SET migrated_at=123,migrated_by='populated-migration-test' WHERE id=1;
         INSERT INTO memories(project_path,category,content,normalized_hash,first_seen_at,created_at,updated_at,last_seen_at)
             VALUES('/populated','fact','preserved memory','memory-hash',10,10,10,10);
         INSERT INTO notes(project_path,content,created_at,updated_at) VALUES('/populated','preserved note',10,10);
         INSERT INTO authority_managed VALUES('/populated','paired-store-uuid',10);
         INSERT INTO authority_repair_pending VALUES('/repair-pending',11);
         INSERT INTO authority_capture_bounds VALUES('/populated','memories',1,1,10,0);
         INSERT INTO lkg_slots(session_id,json_prefix_chars,json_prefix_chunks,json_prefix_hash,input_id_seq,input_content_digests,last_input_message_id,captured_at,row_version,capture_sequence,served_capture_id,input_move_digests)
             VALUES('provider-opencode',20,1,'prefix-hash','[\"m4\"]','[\"digest\"]','m4',10,7,9,9,'[\"move-digest\"]');
         INSERT INTO lkg_slot_chunks VALUES('provider-opencode',0,'chunk-hash','opaque last-known-good body');
         INSERT INTO lkg_served_markers(session_id,served_capture_id,full_coverage,slot_state) VALUES('provider-opencode',9,1,'served');
         INSERT INTO host_runner_state(session_id,harness,lineage_id,ancestry_json,next_ordinal,cursor,served_through_ordinal,unserved_json)
             VALUES('provider-opencode','opencode','L','[]',5,5,4,'[]');
         INSERT INTO host_runner_views(session_id,harness,lineage_id,compaction_id,version,range_from,range_to,replacement_json,state,applied_at)
             VALUES('provider-opencode','opencode','L','c',8,4,5,'[{\"content\":\"applied\"}]','applied',10);"
    ).unwrap();
    snapshot(&conn).unwrap()
}

fn assert_context(path: &std::path::Path, before: &Snapshot) {
    let conn = rusqlite::Connection::open(path).unwrap();
    assert_eq!(
        snapshot(&conn).unwrap(),
        *before,
        "module upgrade must not rewrite host authority, LKG or runner ledgers"
    );
    for (table, insert, update) in [
        ("memories", "INSERT INTO memories(project_path,category,content,normalized_hash,first_seen_at,created_at,updated_at,last_seen_at) VALUES('/populated','fact','new','new-hash',10,10,10,10)", "UPDATE memories SET content='changed' WHERE project_path='/populated'"),
        ("notes", "INSERT INTO notes(project_path,content,created_at,updated_at) VALUES('/populated','new',10,10)", "UPDATE notes SET content='changed' WHERE project_path='/populated'"),
    ] {
        for statement in [insert.to_string(), update.to_string(), format!("DELETE FROM {table} WHERE project_path='/populated'")] {
            let error = conn.execute(&statement, []).unwrap_err();
            assert!(error.to_string().contains("managed by the Rust module"), "{statement}: {error}");
        }
    }
    let tx = conn.unchecked_transaction().unwrap();
    tx.execute(
        "UPDATE context_privilege_state SET enabled=1 WHERE id=1",
        [],
    )
    .unwrap();
    assert_eq!(
        tx.execute(
            "UPDATE memories SET content='authorized' WHERE project_path='/populated'",
            []
        )
        .unwrap(),
        1
    );
    assert_eq!(
        tx.execute(
            "UPDATE notes SET content='authorized' WHERE project_path='/populated'",
            []
        )
        .unwrap(),
        1
    );
    tx.rollback().unwrap();
    assert_eq!(snapshot(&conn).unwrap(), *before);
}

fn assert_intent(store: &McStore, target: u32) {
    assert_eq!(store.load("legacy").unwrap().core, core());
    assert_eq!(
        store.load_tags_for_session("legacy").unwrap()[0]
            .source_bytes
            .to_vec(),
        b"payload"
    );
    for table in single_store_schema::SINGLE_STORE_DROPPED_TABLES {
        assert_eq!(
            scalar::<u32>(
                store,
                &format!(
                    "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='{table}'"
                )
            ),
            0
        );
    }
    match target {
        64 => {
            for table in [
                "mc_move_fences",
                "mc_move_cuts",
                "mc_move_installs",
                "mc_move_key_map",
                "mc_move_tag_epochs",
            ] {
                assert_eq!(scalar::<u32>(store, &format!("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='{table}'")), 1);
            }
        }
        65 => {
            assert_eq!(
                scalar::<u32>(store, "SELECT count(*) FROM mc_provider_sessions_v1"),
                0
            );
            assert_eq!(
                scalar::<u32>(store, "SELECT count(*) FROM mc_provider_catalogs_v1"),
                0
            );
        }
        66 => {
            for harness in HARNESS {
                let conv = provider_key(harness).conversation_key();
                store.inner.with_conn(|conn| {
                    let (watermark, epoch): (u64,u64) = conn.query_row("SELECT version_high_water,rebuild_epoch FROM mc_provider_conversations_v2 WHERE conv_key=?1", [&conv], |r| Ok((r.get(0)?,r.get(1)?)))?;
                    assert_eq!((watermark,epoch), (9,2));
                    let bytes: Vec<u8> = conn.query_row("SELECT message_bytes FROM mc_provider_messages_v1 WHERE conv_key=?1", [&conv], |r| r.get(0))?;
                    assert_eq!(bytes, "{\"content\":\"résumé\",\"role\":\"user\"}".as_bytes());
                    let first: u64 = conn.query_row("SELECT first_ordinal FROM mc_provider_lineages_v1 WHERE conv_key=?1 AND lineage_id='empty'", [&conv], |r| r.get(0))?;
                    assert_eq!(first, 0);
                    let view: String = conn.query_row("SELECT replacement_json FROM mc_provider_views_v1 WHERE conv_key=?1 AND version=9", [&conv], |r| r.get(0))?;
                    assert_eq!(view, r#"[{"content":"frozen"}]"#);
                    let policy: String = conn.query_row("SELECT policy_json FROM mc_provider_hook_answers_v1 WHERE conv_key=?1", [&conv], |r| r.get(0))?;
                    assert_eq!(policy, "{}");
                    let drops: u32 = conn.query_row("SELECT count(*) FROM mc_provider_pending_drops_v1 WHERE conv_key=?1", [&conv], |r| r.get(0))?;
                    assert_eq!(drops, 2);
                    let tags: Vec<(i64,String,Option<String>)> = conn.prepare("SELECT tag_number,state,tag_json FROM mc_provider_legacy_tags_v1 WHERE conv_key=?1 ORDER BY tag_number")?
                        .query_map([&conv], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?.collect::<rusqlite::Result<_>>()?;
                    assert_eq!(tags.len(), 2);
                    assert_eq!((tags[0].0,tags[0].1.as_str()), (10,"live"));
                    assert_eq!(serde_json::from_str::<serde_json::Value>(tags[0].2.as_ref().unwrap()).unwrap(), record()["hook"]["live"]["10"]);
                    assert_eq!(tags[1], (11,"burned".into(),None));
                    let answer: (String,String,String) = conn.query_row("SELECT state,ops_json,tags_json FROM mc_provider_hook_answers_v1 WHERE conv_key=?1", [&conv], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
                    assert_eq!(answer.0, "pending");
                    assert_eq!(serde_json::from_str::<serde_json::Value>(&answer.1).unwrap(), record()["hook"]["answers"][0]["answer"]);
                    assert_eq!(answer.2, "[12]");
                    let applied: (String,String) = conn.query_row("SELECT state,replacement_json FROM mc_provider_views_v1 WHERE conv_key=?1 AND version=8", [&conv], |r| Ok((r.get(0)?,r.get(1)?)))?;
                    assert_eq!(applied, ("applied".into(), r#"[{"content":"applied"}]"#.into()));
                    let pending: Vec<i64> = conn.prepare("SELECT tag_number FROM mc_provider_pending_drops_v1 WHERE conv_key=?1 ORDER BY tag_number")?
                        .query_map([&conv], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
                    assert_eq!(pending, [10,12]);
                    let small: String = conn.query_row("SELECT record_json FROM mc_provider_conversations_v2 WHERE conv_key=?1", [&conv], |r| r.get(0))?;
                    assert_eq!(serde_json::from_str::<serde_json::Value>(&small).unwrap()["future_field"], serde_json::json!({"keep":true}));
                    Ok(())
                }).unwrap();
            }
        }
        67 | 69 => {
            let mut meta = ModuleMeta {
                held_release: Some(serde_json::json!({"reason":"flush"})),
                ..Default::default()
            };
            if target == 69 {
                meta.memory_projection = Some(memory_projection::AppliedProjection {
                    legacy: true,
                    hard_memory_block: "shown delta".into(),
                    generation: 1,
                    ..Default::default()
                });
            }
            store
                .commit("metadata-probe", None, &core(), &meta)
                .unwrap();
            assert_eq!(
                serde_json::to_value(store.load("metadata-probe").unwrap().meta).unwrap(),
                serde_json::to_value(meta).unwrap()
            );
        }
        68 => {
            assert_eq!(
                scalar::<u32>(
                    store,
                    "SELECT count(*) FROM mc_provider_policy_summaries_v1"
                ),
                0
            );
            assert_eq!(
                scalar::<u32>(store, "SELECT count(*) FROM mc_provider_policy_changes_v1"),
                0
            );
        }
        70 => {
            assert_eq!(scalar::<u32>(store, "SELECT count(*) FROM mc_provider_conversations_v2 WHERE profile_generation='' AND provider_generation='' AND native_pins_json IS NULL AND native_plan_json IS NULL"), 4);
        }
        71 => {
            let actual: Vec<(String,u64,String)> = store.inner.with_conn(|conn| {
                conn.prepare("SELECT engine_namespace,revision,session FROM mc_provider_policy_revisions_v1 ORDER BY engine_namespace")?
                    .query_map([], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?.collect::<rusqlite::Result<Vec<_>>>()
            }).unwrap();
            let expected: Vec<(String,u64,String)> = store.inner.with_conn(|conn| {
                conn.prepare("SELECT engine_namespace,0,min(session) FROM mc_provider_conversations_v2 GROUP BY engine_namespace ORDER BY engine_namespace")?
                    .query_map([], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?.collect::<rusqlite::Result<Vec<_>>>()
            }).unwrap();
            assert_eq!(actual.len(), 5);
            assert_eq!(
                actual, expected,
                "seed every existing engine namespace at revision zero"
            );
            assert_eq!(
                scalar::<u32>(
                    store,
                    "SELECT count(*) FROM mc_provider_policy_preparations_v1"
                ),
                0
            );
        }
        72 => {
            for harness in ["opencode", "opencode2"] {
                assert!(store
                    .load_provider_record(&provider_key(harness))
                    .unwrap()
                    .is_none());
                assert!(store
                    .load_provider_conversation(&provider_key(harness))
                    .unwrap()
                    .is_none());
            }
            assert_eq!(scalar::<u32>(store, "SELECT count(*) FROM mc_provider_messages_v1 WHERE frozen_policy_format=0 AND frozen_policy_raw_bytes=0 AND frozen_policy_parts=0 AND frozen_policy_bytes IS NULL"), 2);
            for table in [
                "mc_provider_policy_cuts_v1",
                "mc_provider_policy_overrides_v1",
                "mc_provider_views_v2",
                "mc_provider_view_overrides_v1",
            ] {
                assert_eq!(
                    scalar::<u32>(store, &format!("SELECT count(*) FROM {table}")),
                    0
                );
            }
        }
        73 => {
            for harness in VIEWED_V1 {
                assert!(store
                    .load_provider_record(&provider_key(harness))
                    .unwrap()
                    .is_none());
                assert!(store
                    .load_provider_conversation(&provider_key(harness))
                    .unwrap()
                    .is_none());
            }
            // The generation-keyed native conversation never owned a v1 view.
            assert!(store
                .load_provider_conversation(&native_key())
                .unwrap()
                .is_some());
            assert_eq!(
                scalar::<u32>(
                    store,
                    "SELECT count(*) FROM sqlite_master WHERE name='mc_provider_views_v1'"
                ),
                0
            );
            assert_eq!(
                scalar::<u32>(store, "SELECT count(*) FROM mc_provider_messages_v1"),
                0
            );
            assert_eq!(
                scalar::<u32>(store, "SELECT count(*) FROM mc_provider_catalogs_v1"),
                4
            );
        }
        74 => {
            for table in [
                "mc_async_compaction",
                "mc_async_compaction_entries",
                "mc_async_compaction_views",
                "mc_async_compaction_baselines",
            ] {
                assert_eq!(
                    scalar::<u32>(store, &format!("SELECT count(*) FROM {table}")),
                    0
                );
            }
        }
        v if v == LATEST_MIGRATION_VERSION => {
            let key = "[\"project\",\"async-owner\",\"opencode\"]";
            let mut save =
                store.async_compaction_save("async-ref", key, "async-owner", "{\"cursor\":7}");
            save.append_entry(0, "{\"m\":0}".into(), "[]".into())
                .append_entry(1, "{\"m\":1}".into(), "[]".into())
                .baseline("applied", Some("{\"initial\":true}".into()));
            save.commit().unwrap();
            assert_eq!(
                store.load_async_compaction("async-ref").unwrap().as_deref(),
                Some("{\"cursor\":7}")
            );
            // A later save rewrites only the small record, cuts the held
            // transcript after ordinal 0 and appends past the cut.
            let mut save =
                store.async_compaction_save("async-ref", key, "async-owner", "{\"cursor\":8}");
            save.truncate_entries(Some(0))
                .append_entry(1, "{\"m\":\"1b\"}".into(), "[]".into());
            save.commit().unwrap();
            let rows = store
                .load_async_compaction_rows("async-ref")
                .unwrap()
                .unwrap();
            assert_eq!(rows.state, "{\"cursor\":8}");
            assert_eq!(
                rows.entries,
                vec![
                    (0, "{\"m\":0}".to_string(), "[]".to_string()),
                    (1, "{\"m\":\"1b\"}".to_string(), "[]".to_string())
                ]
            );
            assert_eq!(
                rows.baselines,
                vec![("applied".to_string(), "{\"initial\":true}".to_string())]
            );
            // Held entries are immutable: appending a stored ordinal refuses.
            let mut save =
                store.async_compaction_save("async-ref", key, "async-owner", "{\"cursor\":9}");
            save.append_entry(1, "{}".into(), "[]".into());
            assert!(save.commit().is_err());
            let version = store
                .reserve_async_compaction_version("async-ref", 0)
                .unwrap();
            assert_eq!(version, 1);
            for version in 1..=3 {
                store
                    .save_async_compaction_view(
                        "async-ref",
                        version,
                        &format!("{{\"immutable\":{version}}}"),
                        "{\"engine\":true}",
                    )
                    .unwrap();
            }
            assert_eq!(
                store
                    .load_async_compaction_view("async-ref", 1)
                    .unwrap()
                    .as_deref(),
                Some("{\"immutable\":1}")
            );
            // Acknowledging version 2 evicts version 1 in the same transaction;
            // a floor past every version still keeps the newest one.
            let mut save =
                store.async_compaction_save("async-ref", key, "async-owner", "{\"cursor\":9}");
            save.retain_views_from(2);
            save.commit().unwrap();
            assert_eq!(
                store.load_async_compaction_view("async-ref", 1).unwrap(),
                None
            );
            assert!(store
                .load_async_compaction_view("async-ref", 2)
                .unwrap()
                .is_some());
            let mut save =
                store.async_compaction_save("async-ref", key, "async-owner", "{\"cursor\":9}");
            save.retain_views_from(10).clear_engine_views();
            save.commit().unwrap();
            let rows = store
                .load_async_compaction_rows("async-ref")
                .unwrap()
                .unwrap();
            assert!(rows.engine_views.is_empty());
            assert_eq!(
                scalar::<u32>(
                    store,
                    "SELECT count(*) FROM mc_async_compaction_views WHERE version=3"
                ),
                1
            );
            assert_eq!(
                scalar::<u32>(store, "SELECT count(*) FROM mc_async_compaction_views"),
                1
            );
            assert_eq!(
                store
                    .reserve_async_compaction_version("async-ref", 50)
                    .unwrap(),
                51
            );
        }
        _ => unreachable!(),
    }
}

fn database_bytes(dir: &std::path::Path) -> Vec<Option<Vec<u8>>> {
    [
        "store.db",
        "store.db-wal",
        "store.db-shm",
        "context.db",
        "context.db-wal",
        "context.db-shm",
    ]
    .iter()
    .map(|name| match std::fs::read(dir.join(name)) {
        Ok(bytes) => Some(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => panic!("{name}: {e}"),
    })
    .collect()
}

fn assert_tag_and_native_triggers(store: &McStore, target: u32) {
    store
        .mint_or_get_tags(
            "tag-probe",
            &[TagMintInput {
                block_id: "probe#0".into(),
                kind: "tool_result".into(),
                token_count: 4,
                source_bytes: b"original".to_vec(),
            }],
            10,
        )
        .unwrap();
    let inserted = store.tag_cache_summary("tag-probe").unwrap();
    assert_eq!(inserted.count, 1);
    assert_eq!(inserted.max_tag_number, 1);
    store
        .execute_tag_sql_for_test(
            "UPDATE mc_tags SET source_bytes=x'02' WHERE session_id='tag-probe'",
        )
        .unwrap();
    let updated = store.tag_cache_summary("tag-probe").unwrap();
    assert_eq!(updated.generation, inserted.generation + 2);
    store
        .execute_tag_sql_for_test("DELETE FROM mc_tags WHERE session_id='tag-probe'")
        .unwrap();
    let deleted = store.tag_cache_summary("tag-probe").unwrap();
    assert_eq!(deleted.generation, updated.generation + 1);
    assert_eq!((deleted.count, deleted.max_tag_number), (0, 0));

    let marker = store_snapshot(store)
        .tables
        .remove("mc_privilege_state")
        .unwrap();
    assert!(store
        .inner
        .with_conn(|conn| conn.execute(
            "UPDATE mc_privilege_state SET single_store=2 WHERE id=1",
            []
        ))
        .is_err());
    assert_eq!(store_snapshot(store).tables["mc_privilege_state"], marker);

    if target >= 70 {
        let key = native_key();
        if store.load_provider_conversation(&key).unwrap().is_none() {
            store.save_provider_conversation(&key, &crate::provider_log::ProviderConversation {
                engine_namespace: "explicit-engine".into(), lineage_id: "G".into(),
                native_pins_json: Some(r#"{"profile_generation":"profile-1","provider_generation":"provider-1"}"#.into()),
                native_plan_json: Some("{}".into()), ..Default::default()
            }).unwrap();
        }
        let before = store_snapshot(store);
        let mut c = store.load_provider_conversation(&key).unwrap().unwrap();
        c.engine_namespace = "forbidden-namespace".into();
        let error = store.save_provider_conversation(&key, &c).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("native provider contract is immutable"),
            "{error}"
        );
        assert_eq!(store_snapshot(store), before);
        // Runner records are read through mc_provider_views_v2, which exists
        // from 72; the current binary cannot read an older schema's record.
        for harness in seeded_harnesses(target).filter(|_| target >= 72) {
            if target >= 73 && VIEWED_V1.contains(&harness) {
                continue;
            }
            let actual: serde_json::Value = serde_json::from_str(
                &store
                    .load_provider_record(&provider_key(harness))
                    .unwrap()
                    .unwrap(),
            )
            .unwrap();
            // This binary reads view bodies only from v2 recipes. Bodies left in
            // the retired v1 table of an older schema read as absent.
            let mut expected = record();
            expected["setup"]["state"]["last_produced"] = serde_json::Value::Null;
            expected["setup"]["state"]["last_applied"] = serde_json::Value::Null;
            assert_eq!(
                actual, expected,
                "{harness} legacy record must reconstruct after the upgrade"
            );
        }
    }
}

fn assert_move_guards(store: &McStore) {
    let snap = store_snapshot(store);
    let mut samples = Vec::new();
    for entry in crate::move_inventory::tables(crate::move_inventory::Store::Module) {
        if entry.class == crate::move_inventory::Class::NotSession {
            continue;
        }
        let Some(owner) = entry.session_column() else {
            continue;
        };
        let Some(rows) = snap.tables.get(entry.table) else {
            continue;
        };
        let Some(row) = rows.rows.first() else {
            continue;
        };
        let owner_index = rows.columns.iter().position(|c| c == owner).unwrap();
        let SqlValue::Text(session) = &row[owner_index] else {
            panic!("non-text owner in {}", entry.table)
        };
        samples.push((
            entry.table,
            owner,
            session.clone(),
            rows.columns.clone(),
            row.clone(),
        ));
    }
    let mut mover = store.move_store().unwrap();
    for session in samples
        .iter()
        .map(|(_, _, session, _, _)| session)
        .collect::<std::collections::BTreeSet<_>>()
    {
        if session == "legacy"
            && scalar::<u32>(
                store,
                "SELECT count(*) FROM mc_move_fences WHERE session_id='legacy'",
            ) != 0
        {
            continue;
        }
        let cut = format!("guard-{session}");
        mover
            .acquire_fence(&crate::move_store::CutBinding {
                cut_id: cut.clone(),
                session_ref: "0123456789abcdef".into(),
                host_session_id: session.clone(),
                host_end_offset: 42,
                host_cut: serde_json::json!({"lastMessageId":"m4"}),
                mc_start_offset: 100,
            })
            .unwrap();
        freeze_fixture(store, &mut mover, &cut);
    }
    let before = store_snapshot(store);
    assert!(samples
        .iter()
        .any(|(table, _, _, _, _)| *table == "mc_cache_state"));
    assert!(samples
        .iter()
        .any(|(table, _, _, _, _)| *table == "mc_tags"));
    for (table, owner, session, columns, row) in samples {
        let columns = columns
            .iter()
            .map(|c| format!("\"{c}\""))
            .collect::<Vec<_>>()
            .join(",");
        let placeholders = vec!["?"; row.len()].join(",");
        for (statement, bindings) in [
            (
                format!("INSERT OR REPLACE INTO \"{table}\" ({columns}) VALUES({placeholders})"),
                row,
            ),
            (
                format!("UPDATE \"{table}\" SET \"{owner}\"=\"{owner}\" WHERE \"{owner}\"=?"),
                vec![SqlValue::Text(session.clone())],
            ),
            (
                format!("DELETE FROM \"{table}\" WHERE \"{owner}\"=?"),
                vec![SqlValue::Text(session.clone())],
            ),
        ] {
            let error = store
                .inner
                .with_conn_fenced(|conn| {
                    conn.execute(&statement, rusqlite::params_from_iter(bindings))
                })
                .unwrap_err();
            assert!(
                error.to_string().contains("session_moving"),
                "{statement}: {error}"
            );
            assert_eq!(
                store_snapshot(store),
                before,
                "refused move write had side effects: {statement}"
            );
        }
    }
}

fn assert_policy_triggers(store: &McStore, target: u32) {
    if target < 68 {
        return;
    }
    for name in [
        "mc_provider_policy_parts_change_insert",
        "mc_provider_policy_parts_change_update",
        "mc_provider_policy_parts_change_move",
        "mc_provider_policy_parts_change_delete",
        "mc_provider_consumed_tags_change",
        "mc_provider_consumed_tags_change_delete",
        "mc_provider_consumed_tags_change_update",
        "mc_provider_conversations_policy_namespace_change",
        "mc_provider_conversations_policy_summary_delete",
    ] {
        assert_eq!(
            scalar::<u32>(
                store,
                &format!(
                    "SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name='{name}'"
                )
            ),
            1,
            "{name}"
        );
    }
    let key = provider_key("broca");
    let conv = key.conversation_key();
    if target >= 73 {
        // Migration 73 reset the seeded Broca conversation. Recreate it through
        // the current writer, with the seed's policy rows, for the probes below.
        store
            .save_provider_record(
                &key,
                &record_without_views().to_string(),
                "reseeded-broca-engine",
                &[],
                &[],
            )
            .unwrap();
        store.inner.with_conn_fenced(|conn| {
            let policy = r#"{"tag_number":10,"tag_kind":"tool_result","arc_id":"arc","served":false,"measurement":{"tokens":40}}"#;
            conn.execute("INSERT INTO mc_provider_policy_parts_v1 VALUES(?1,'L',4,'m4#0',?2,?3)", params![conv, policy, key.session])?;
            conn.execute("INSERT INTO mc_provider_consumed_tags_v1 VALUES('reseeded-broca-engine',12,?1)", params![key.session])?;
            conn.execute("INSERT INTO mc_provider_policy_summaries_v1 VALUES(?1,'{\"kept\":true}',?2)", params![conv, key.session])?;
            Ok(())
        }).unwrap();
    }
    let namespace: String = store
        .inner
        .with_conn(|conn| {
            conn.query_row(
                "SELECT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key=?1",
                [&conv],
                |r| r.get(0),
            )
        })
        .unwrap();
    store
        .inner
        .with_conn_fenced(|conn| {
            conn.execute(
                "INSERT OR IGNORE INTO mc_provider_policy_summaries_v1 VALUES(?1,'{}',?2)",
                params![conv, key.session],
            )?;
            Ok(())
        })
        .unwrap();
    if target >= 71 {
        for name in [
            "mc_provider_conversations_revision_replace",
            "mc_provider_preparation_namespace_change",
            "mc_provider_preparation_conversation_delete",
            "mc_provider_preparation_part_move",
            "mc_provider_preparation_part_delete",
        ] {
            assert_eq!(
                scalar::<u32>(
                    store,
                    &format!(
                        "SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name='{name}'"
                    )
                ),
                1,
                "{name}"
            );
        }
        assert!(store
            .prepare_provider_policy(&key, |_, _| Ok(Some(
                crate::provider_preparation::ProviderPreparationWrite {
                    settings_key: "trigger-settings".into(),
                    original_baseline_json: "{}".into(),
                    newest_ordinal: 4,
                    prepared_json: "{\"trigger\":true}".into(),
                }
            )))
            .unwrap());
    }
    for (statement, invalidates) in [
        ("INSERT INTO mc_provider_policy_parts_v1 SELECT conv_key,lineage_id,ordinal,'new-block',policy_json,session FROM mc_provider_policy_parts_v1 WHERE conv_key=?1", false),
        ("UPDATE mc_provider_policy_parts_v1 SET policy_json=json_set(policy_json,'$.served',json('true')) WHERE conv_key=?1", false),
        ("INSERT INTO mc_provider_consumed_tags_v1 SELECT engine_namespace,10,session FROM mc_provider_conversations_v2 WHERE conv_key=?1", false),
        ("UPDATE mc_provider_policy_parts_v1 SET block_id='moved-block' WHERE conv_key=?1", true),
        ("DELETE FROM mc_provider_policy_parts_v1 WHERE conv_key=?1", true),
        ("DELETE FROM mc_provider_consumed_tags_v1 WHERE engine_namespace=(SELECT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key=?1)", true),
        ("UPDATE mc_provider_consumed_tags_v1 SET tag_number=13 WHERE engine_namespace=(SELECT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key=?1)", true),
        ("UPDATE mc_provider_conversations_v2 SET engine_namespace='changed-engine' WHERE conv_key=?1", true),
        ("DELETE FROM mc_provider_conversations_v2 WHERE conv_key=?1", true),
    ] {
        store.inner.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            assert!(tx.execute(statement, [&conv])? > 0);
            let count: u32 = tx.query_row("SELECT count(*) FROM mc_provider_policy_summaries_v1 WHERE conv_key=?1", [&conv], |r| r.get(0))?;
            assert_eq!(count, u32::from(!invalidates), "summary trigger did not fire: {statement}");
            let changes: u32 = tx.query_row("SELECT count(*) FROM mc_provider_policy_changes_v1 WHERE conv_key=?1", [&conv], |r| r.get(0))?;
            assert_eq!(changes, u32::from(!invalidates), "change trigger did not fire: {statement}");
            if target >= 71 {
                let preparation_deleted = statement.starts_with("UPDATE mc_provider_policy_parts_v1 SET block_id")
                    || statement.starts_with("DELETE FROM mc_provider_policy_parts_v1")
                    || statement.starts_with("UPDATE mc_provider_conversations_v2")
                    || statement.starts_with("DELETE FROM mc_provider_conversations_v2");
                let remaining: u32 = tx.query_row("SELECT count(*) FROM mc_provider_policy_preparations_v1 WHERE conv_key=?1", [&conv], |r| r.get(0))?;
                assert_eq!(remaining, u32::from(!preparation_deleted), "preparation invalidation trigger: {statement}");
            }
            tx.rollback()
        }).unwrap();
        if target >= 71 && !invalidates {
            // The replacement triggers must also log with preparation alone.
            store.inner.with_conn(|conn| {
                let tx = conn.unchecked_transaction()?;
                tx.execute("DELETE FROM mc_provider_policy_summaries_v1 WHERE conv_key=?1", [&conv])?;
                assert_eq!(tx.query_row("SELECT count(*) FROM mc_provider_policy_preparations_v1 WHERE conv_key=?1", [&conv], |r| r.get::<_,u32>(0))?, 1);
                tx.execute(statement, [&conv])?;
                assert_eq!(tx.query_row("SELECT count(*) FROM mc_provider_policy_changes_v1 WHERE conv_key=?1", [&conv], |r| r.get::<_,u32>(0))?, 1, "preparation-only trigger: {statement}");
                tx.rollback()
            }).unwrap();
        }
    }
    let original: String = scalar(
        store,
        "SELECT policy_json FROM mc_provider_policy_parts_v1 WHERE session='provider-broca'",
    );
    sql(store, "UPDATE mc_provider_policy_parts_v1 SET policy_json=json_set(policy_json,'$.served',json('true')) WHERE session='provider-broca';
                UPDATE mc_provider_policy_parts_v1 SET policy_json=json_set(policy_json,'$.reduced',json('true')) WHERE session='provider-broca';");
    assert_eq!(scalar::<String>(store, "SELECT previous_json FROM mc_provider_policy_changes_v1 WHERE session='provider-broca'"), original);
    assert_eq!(
        scalar::<u32>(
            store,
            "SELECT count(*) FROM mc_provider_policy_changes_v1 WHERE session='provider-broca'"
        ),
        1
    );
    sql(
        store,
        "DELETE FROM mc_provider_policy_changes_v1 WHERE session='provider-broca'",
    );
    store
        .inner
        .with_conn_fenced(|conn| {
            conn.execute(
                "INSERT INTO mc_provider_consumed_tags_v1 VALUES(?1,10,?2)",
                params![namespace, key.session],
            )
            .map(|_| ())
        })
        .unwrap();
    assert_eq!(scalar::<u32>(store, "SELECT previous_consumed FROM mc_provider_policy_changes_v1 WHERE session='provider-broca'"), 0);
    sql(
        store,
        "DELETE FROM mc_provider_policy_parts_v1 WHERE session='provider-broca'",
    );
    assert_eq!(
        scalar::<u32>(
            store,
            "SELECT count(*) FROM mc_provider_policy_summaries_v1 WHERE session='provider-broca'"
        ),
        0
    );
    assert_eq!(
        scalar::<u32>(
            store,
            "SELECT count(*) FROM mc_provider_policy_changes_v1 WHERE session='provider-broca'"
        ),
        0
    );
}

fn assert_revision_and_frontier_triggers(store: &McStore, target: u32) {
    if target < 71 {
        return;
    }
    let key = ProviderSessionKey {
        session: "trigger-session".into(),
        ..provider_key("broca")
    };
    let conv = key.conversation_key();
    let namespace = "trigger-engine";
    store
        .commit(namespace, None, &core(), &ModuleMeta::default())
        .unwrap();
    store
        .save_provider_record(
            &key,
            &record_without_views().to_string(),
            namespace,
            &[McTagRow {
                tag_number: 1,
                block_id: "tagged#0".into(),
                kind: "tool_result".into(),
                token_count: 2,
                created_at_ms: 10,
                source_bytes: b"verbatim".as_slice().into(),
            }],
            &[],
        )
        .unwrap();
    store.inner.with_conn_fenced(|conn| {
        conn.execute("INSERT INTO mc_provider_policy_parts_v1 VALUES(?1,'L',4,'m4#0','{}','trigger-session')", [&conv])?;
        conn.execute("INSERT INTO mc_provider_policy_summaries_v1 VALUES(?1,'{}','trigger-session')", [&conv])?;
        conn.execute("INSERT INTO mc_provider_policy_changes_v1 VALUES(?1,'L','m4#0',NULL,0,'trigger-session')", [&conv])?;
        conn.execute("INSERT INTO mc_provider_consumed_tags_v1 VALUES('trigger-engine',1,'trigger-session')", [])?;
        Ok(())
    }).unwrap();
    for (table, field, owner, identity) in [
        (
            "mc_provider_lineages_v1",
            "first_ordinal",
            "conv_key",
            conv.as_str(),
        ),
        (
            "mc_provider_messages_v1",
            "message_bytes",
            "conv_key",
            conv.as_str(),
        ),
        (
            "mc_provider_hook_answers_v1",
            "policy_json",
            "conv_key",
            conv.as_str(),
        ),
        (
            "mc_provider_policy_parts_v1",
            "policy_json",
            "conv_key",
            conv.as_str(),
        ),
        (
            "mc_provider_policy_summaries_v1",
            "summary_json",
            "conv_key",
            conv.as_str(),
        ),
        (
            "mc_provider_policy_changes_v1",
            "previous_consumed",
            "conv_key",
            conv.as_str(),
        ),
        (
            "mc_provider_pending_drops_v1",
            "tag_number",
            "conv_key",
            conv.as_str(),
        ),
        (
            "mc_provider_legacy_tags_v1",
            "tag_json",
            "conv_key",
            conv.as_str(),
        ),
        (
            "mc_provider_conversations_v2",
            "params_json",
            "conv_key",
            conv.as_str(),
        ),
        (
            "mc_provider_consumed_tags_v1",
            "tag_number",
            "engine_namespace",
            namespace,
        ),
        ("mc_tags", "token_count", "session_id", namespace),
        ("mc_cache_state", "meta", "session_id", namespace),
    ] {
        for action in ["insert", "update", "delete"] {
            let name = format!("{table}_revision_{action}");
            assert_eq!(
                scalar::<u32>(
                    store,
                    &format!(
                        "SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name='{name}'"
                    )
                ),
                1,
                "{name}"
            );
            let statement = match action {
                "insert" => {
                    format!("INSERT OR REPLACE INTO {table} SELECT * FROM {table} WHERE {owner}=?1")
                }
                "update" => format!("UPDATE {table} SET {field}={field} WHERE {owner}=?1"),
                _ => format!("DELETE FROM {table} WHERE {owner}=?1"),
            };
            let before = store.provider_policy_revision(namespace).unwrap();
            store
                .inner
                .with_conn(|conn| {
                    let tx = conn.unchecked_transaction()?;
                    assert!(
                        tx.execute(&statement, [identity])? > 0,
                        "trigger fixture has no row for {statement} ({identity})"
                    );
                    let after = crate::provider_preparation::policy_revision_tx(&tx, namespace)?;
                    assert!(after > before, "{name} did not advance the revision");
                    tx.rollback()
                })
                .unwrap();
        }
    }
    store.inner.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        tx.execute("PRAGMA recursive_triggers=OFF", [])?;
        let before = crate::provider_preparation::policy_revision_tx(&tx, namespace)?;
        tx.execute("INSERT OR REPLACE INTO mc_provider_conversations_v2(conv_key,project_root,session,harness,engine_namespace) VALUES(?1,'/populated','trigger-session','broca','replacement-engine')", [&conv])?;
        assert!(crate::provider_preparation::policy_revision_tx(&tx, namespace)? > before, "replacement must fence the old namespace");
        assert!(crate::provider_preparation::policy_revision_tx(&tx, "replacement-engine")? > 0);
        tx.rollback()
    }).unwrap();
    if target == 72 {
        assert_eq!(scalar::<u32>(store, "SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name='mc_provider_native_delete_frontier'"), 1);
        store.inner.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            tx.execute("UPDATE mc_provider_conversations_v2 SET cursor_frontier=10 WHERE conv_key=?1", [&conv])?;
            tx.execute("DELETE FROM mc_provider_messages_v1 WHERE conv_key=?1", [&conv])?;
            assert_eq!(tx.query_row("SELECT cursor_frontier FROM mc_provider_conversations_v2 WHERE conv_key=?1", [&conv], |r| r.get::<_,u64>(0))?, 4);
            tx.rollback()
        }).unwrap();
        // New native rows written after cutover must survive reopening at v72.
        let fresh = ProviderSessionKey {
            session: "fresh-opencode".into(),
            ..provider_key("opencode")
        };
        store
            .save_provider_conversation(
                &fresh,
                &crate::provider_log::ProviderConversation {
                    engine_namespace: "fresh-native-engine".into(),
                    ..Default::default()
                },
            )
            .unwrap();
    }
}

fn populated_increment(previous: u32) {
    let target = previous + 1;
    let dir = tempfile::tempdir().unwrap();
    let descriptor = descriptor(dir.path());
    let context_path = dir.path().join("context.db");
    let host_before = seed_context(&context_path);
    let before = seed(&descriptor, previous);
    assert_fault_rolls_back(&descriptor, &before, target);
    assert_context(&context_path, &host_before);

    let upgraded = open_at(&descriptor, target);
    assert_preserved(&before, &store_snapshot(&upgraded), target);
    assert_metadata_and_inventory(&upgraded, target);
    assert_intent(&upgraded, target);
    let after = store_snapshot(&upgraded);
    drop(upgraded);
    let reopened = open_at(&descriptor, target);
    assert_eq!(
        store_snapshot(&reopened),
        after,
        "migration {target} re-ran on restart"
    );
    assert_context(&context_path, &host_before);
    assert_tag_and_native_triggers(&reopened, target);
    assert_revision_and_frontier_triggers(&reopened, target);
    assert_policy_triggers(&reopened, target);
    assert_move_guards(&reopened);
    let after_probes = store_snapshot(&reopened);
    drop(reopened);

    let bytes = database_bytes(dir.path());
    let Err(error) = McStore::open_with_migrations(&descriptor, false, &chain(previous)) else {
        panic!("a version {previous} binary accepted version {target}");
    };
    assert!(
        matches!(error, McStoreError::StoreAheadOfBinary { db_version, binary_max } if db_version == target && binary_max == previous)
    );
    assert!(
        error.to_string().contains("store_ahead_of_binary"),
        "{error}"
    );
    assert_eq!(
        database_bytes(dir.path()),
        bytes,
        "refused open wrote a paired database or sidecar"
    );
    // Replace the recorded batch with a failing statement on this reopen. Row
    // comparisons alone cannot detect replay of SELECT-only fence migrations.
    let mut replay_probe = chain(target);
    replay_probe.last_mut().unwrap().statements = "SELECT * FROM migration_must_not_replay";
    let reopened = McStore::open_with_migrations(&descriptor, false, &replay_probe).unwrap();
    assert_eq!(reopened.module_store_schema_version().unwrap(), target);
    assert_eq!(store_snapshot(&reopened), after_probes);
}

#[test]
fn released_63_to_head_preserves_data_and_fences_the_old_binary() {
    let dir = tempfile::tempdir().unwrap();
    let descriptor = descriptor(dir.path());
    // Build the released schema from its DDL, without creating any later tables.
    let before = seed(&descriptor, 63);
    assert!(!before.tables.contains_key("mc_async_compaction"));
    let upgraded = McStore::open(&descriptor).unwrap();
    // The move inventory's context.db pin must match the context schema this binary
    // ships (the plugin's LATEST_SUPPORTED_VERSION, read at compile time), so the
    // expectation moves with each new context migration instead of being a literal.
    assert_eq!(
        crate::move_inventory::CONTEXT_SCHEMA_VERSION,
        crate::context_schema::BOOTSTRAP_VERSION
    );
    assert_metadata_and_inventory(&upgraded, LATEST_MIGRATION_VERSION);
    let after = store_snapshot(&upgraded);
    for table in ["mc_tags", "pending_agent_drops"] {
        assert_eq!(after.tables[table], before.tables[table], "{table}");
    }
    assert_eq!(
        upgraded.load("legacy").unwrap().core.frozen_units[0].frozen_payload,
        core().frozen_units[0].frozen_payload
    );
    drop(upgraded);
    let bytes = database_bytes(dir.path());
    let Err(error) = McStore::open_with_migrations(&descriptor, false, &chain(63)) else {
        panic!("a version 63 binary accepted the current head");
    };
    assert!(matches!(
        error,
        McStoreError::StoreAheadOfBinary {
            db_version,
            binary_max: 63
        } if db_version == LATEST_MIGRATION_VERSION
    ));
    assert_eq!(database_bytes(dir.path()), bytes);
}

macro_rules! increment {
    ($name:ident, $version:literal) => {
        #[test]
        fn $name() {
            populated_increment($version);
        }
    };
}

increment!(populated_63_to_64, 63);
increment!(populated_64_to_65, 64);
increment!(populated_65_to_66, 65);
increment!(populated_66_to_67, 66);
increment!(populated_67_to_68, 67);
increment!(populated_68_to_69, 68);
increment!(populated_69_to_70, 69);
increment!(populated_70_to_71, 70);
increment!(populated_71_to_72, 71);
increment!(populated_72_to_73, 72);
increment!(populated_73_to_74, 73);

#[test]
fn app_read_indexes_upgrade_populated_entries_and_roll_back_on_failure() {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    let dir = tempfile::tempdir().unwrap();
    let descriptor = descriptor(dir.path());
    seed_context(&dir.path().join("context.db"));
    seed(&descriptor, 74);
    let old = open_at(&descriptor, 74);
    old.inner.with_conn(|conn| {
        conn.execute_batch(r#"
            INSERT INTO mc_async_compaction VALUES('legacy-ref','["/p","held-session","pi"]','held-session','{}',4);
            INSERT INTO mc_async_compaction_entries VALUES
                ('legacy-ref','held-session',0,'{"mid":"runner-m0","content":"kept"}','[]'),
                ('legacy-ref','held-session',1,'{"mid":"runner-m1"}','[]'),
                ('legacy-ref','held-session',2,'{}','[]'),
                ('legacy-ref','held-session',3,'legacy opaque entry','[]');
        "#)
    }).unwrap();
    let before = store_snapshot(&old);
    drop(old);
    let inner = open_sqlite(&descriptor).unwrap();
    let reached = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let hit = reached.clone();
    inner
        .with_conn(|conn| {
            conn.authorizer(Some(move |ctx: AuthContext<'_>| {
                if matches!(ctx.action, AuthAction::CreateIndex { index_name, .. }
                if index_name == "idx_mc_async_compaction_entries_mid")
                {
                    hit.store(true, std::sync::atomic::Ordering::SeqCst);
                    Authorization::Deny
                } else {
                    Authorization::Allow
                }
            }));
            Ok(())
        })
        .unwrap();
    assert!(inner.migrate(NS, &chain(LATEST_MIGRATION_VERSION)).is_err());
    assert!(reached.load(std::sync::atomic::Ordering::SeqCst));
    inner
        .with_conn(|conn| {
            conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>);
            assert_eq!(
                snapshot(conn)?,
                before,
                "failed backfill must roll back DDL, rows and stamps"
            );
            Ok(())
        })
        .unwrap();
    drop(inner);

    let upgraded = McStore::open(&descriptor).unwrap();
    assert_metadata_and_inventory(&upgraded, LATEST_MIGRATION_VERSION);
    upgraded.inner.with_conn(|conn| {
        let rows = conn.prepare("SELECT ordinal,mid,entry_json FROM mc_async_compaction_entries WHERE session_ref='legacy-ref' ORDER BY ordinal")?
            .query_map([], |r| Ok((r.get::<_,u64>(0)?, r.get::<_,Option<String>>(1)?, r.get::<_,String>(2)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        assert_eq!(rows.iter().map(|r| r.1.as_deref()).collect::<Vec<_>>(), vec![Some("runner-m0"),Some("runner-m1"),None,None]);
        assert_eq!(rows[0].2, r#"{"mid":"runner-m0","content":"kept"}"#);
        assert_eq!(rows[3].2, "legacy opaque entry");
        for (sql, index) in [
            ("SELECT state_json FROM mc_async_compaction WHERE session='held-session'", "idx_mc_async_compaction_session"),
            ("SELECT entry_json FROM mc_async_compaction_entries WHERE session_ref='legacy-ref' AND mid='runner-m0'", "idx_mc_async_compaction_entries_mid"),
        ] {
            let details = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?.query_map([], |r| r.get::<_,String>(3))?.collect::<rusqlite::Result<Vec<_>>>()?;
            assert!(details.iter().any(|p| p.contains("SEARCH") && p.contains(index)), "{details:?}");
            assert!(!details.iter().any(|p| p.contains("SCAN")), "{details:?}");
        }
        Ok(())
    }).unwrap();
    assert_intent(&upgraded, LATEST_MIGRATION_VERSION);
    let after = store_snapshot(&upgraded);
    drop(upgraded);
    let reopened = McStore::open(&descriptor).unwrap();
    assert_eq!(store_snapshot(&reopened), after);
    drop(reopened);
    assert!(
        matches!(McStore::open_with_migrations(&descriptor, false, &chain(74)), Err(McStoreError::StoreAheadOfBinary { db_version, binary_max: 74 }) if db_version == LATEST_MIGRATION_VERSION)
    );
}

#[test]
fn app_read_indexes_fresh_schema_and_new_entry_mid() {
    let dir = tempfile::tempdir().unwrap();
    let store = McStore::open(&descriptor(dir.path())).unwrap();
    assert_metadata_and_inventory(&store, LATEST_MIGRATION_VERSION);
    store
        .async_compaction_save("mid-ref", "[\"/p\",\"s\",\"pi\"]", "s", "{}")
        .append_entry(0, r#"{"mid":"new-mid"}"#.into(), "[]".into())
        .commit()
        .unwrap();
    assert_eq!(
        scalar::<String>(
            &store,
            "SELECT mid FROM mc_async_compaction_entries WHERE session_ref='mid-ref' AND ordinal=0"
        ),
        "new-mid"
    );
}
