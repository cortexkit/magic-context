//! Review checks for store migration 68 (bounded provider policy summaries):
//! the step from a populated version-67 store, the change triggers' row-level
//! semantics, the version fence against older binaries, and the writer guards
//! on the two new session tables.
use super::*;
use crate::{Migration, LATEST_MIGRATION_VERSION, MIGRATIONS};
use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};

fn descriptor(dir: &std::path::Path) -> StorageDescriptor {
    StorageDescriptor {
        module_id: "magic-context".into(),
        storage_namespace: crate::NS.into(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: dir.join("store.db").to_string_lossy().into_owned(),
        },
    }
}

fn key() -> ProviderSessionKey {
    ProviderSessionKey {
        project_root: "/review".into(),
        session: "s".into(),
        harness: "opencode".into(),
    }
}

fn lineage() -> ProviderLineage {
    ProviderLineage {
        lineage_id: "L".into(),
        first_ordinal: 1,
        descends_from: None,
        through_ordinal: None,
    }
}

fn part(mid: &str, ordinal: u64, index: i64, tag: Option<i64>) -> ProviderPolicyPart {
    let block_id = format!("{mid}#{index}");
    ProviderPolicyPart {
        mid: mid.into(),
        ordinal,
        block_id: block_id.clone(),
        block_index: index,
        kind: if tag.is_some() { "tool_result" } else { "text" }.into(),
        role: "assistant".into(),
        measurement: crate::TailHygienePartMeasurement {
            key: format!("{block_id}\0text"),
            content_hash: format!("h-{block_id}"),
            kind: crate::TailHygienePartKind::Text,
            tokens: 40,
            u_tokens: 0,
            tag_number: None,
            tag_status: None,
            protected: false,
            queued_for_drop: false,
        },
        tag_kind: tag.map(|_| "tool_result".into()),
        tag_number: tag,
        tag_tokens: 40,
        tool_name: "read".into(),
        arc_id: tag.map(|n| format!("arc{n}")),
        subject_part: String::new(),
        active: true,
        served: false,
        reduced: false,
        queued: false,
        real_user: false,
        created_at_ms: None,
        completed_at_ms: None,
    }
}

fn scalar<T: rusqlite::types::FromSql>(store: &McStore, sql: &str) -> T {
    store
        .inner
        .with_conn(|conn| conn.query_row(sql, [], |row| row.get(0)))
        .unwrap()
}

fn count(store: &McStore, sql: &str) -> i64 {
    scalar(store, sql)
}

/// Writes through the public provider APIs a version-67 binary offers: a
/// conversation, an admitted pass with messages and policy parts, and a hook.
fn populate(store: &McStore) {
    store
        .save_provider_conversation(
            &key(),
            &ProviderConversation {
                lineage_id: "L".into(),
                engine_namespace: "s".into(),
                ..Default::default()
            },
        )
        .unwrap();
    let messages = (1..=3)
        .map(|ordinal| ProviderMessage {
            mid: format!("m{ordinal}"),
            ordinal,
            message_bytes: b"{}".to_vec(),
        })
        .collect::<Vec<_>>();
    let parts = (1..=3u64)
        .flat_map(|ordinal| {
            [
                part(&format!("m{ordinal}"), ordinal, 0, None),
                part(&format!("m{ordinal}"), ordinal, 1, Some(ordinal as i64)),
            ]
        })
        .collect::<Vec<_>>();
    store
        .admit_provider_pass(
            &key(),
            &lineage(),
            &messages,
            &parts,
            &json!({"pass_id":"seed","lineage_id":"L","appended_ids":[]}),
        )
        .unwrap();
    hook(store, None);
}

/// One hook that stores `summary` (or keeps the stored one when `None`).
fn hook(store: &McStore, summary: Option<&str>) {
    let lineage = lineage();
    store
        .commit_provider_hook(
            &key(),
            ProviderHookRequest {
                lineage: &lineage,
                message: None,
                served_through_ordinal: None,
                unserved_subjects: &[],
                repeat_subject: None,
            },
            |ctx| {
                Ok((
                    ProviderHookWrite {
                        answer: None,
                        counters: ctx.counters.clone(),
                        policy_summary: summary.map(str::to_string),
                    },
                    (),
                ))
            },
        )
        .unwrap();
}

fn provider_rows(store: &McStore) -> String {
    scalar(
        store,
        "SELECT json_group_array(json_array(t, r)) FROM (
            SELECT 'part' t, json_array(conv_key,lineage_id,ordinal,block_id,policy_json,session) r FROM mc_provider_policy_parts_v1
            UNION ALL SELECT 'message', json_array(conv_key,lineage_id,ordinal,mid,hex(message_bytes),session) FROM mc_provider_messages_v1
            UNION ALL SELECT 'lineage', json_array(conv_key,lineage_id,first_ordinal,descends_from,through_ordinal) FROM mc_provider_lineages_v1
            UNION ALL SELECT 'conversation', json_array(conv_key,lineage_id,engine_namespace,hook_counters_json,last_answer_json) FROM mc_provider_conversations_v2
            ORDER BY 1, 2)",
    )
}

const UPDATE_SERVED: &str = "UPDATE mc_provider_policy_parts_v1 SET policy_json=json_set(policy_json,'$.served',json('true')) WHERE json_extract(policy_json,'$.tag_number')=";

#[test]
fn migration_68_steps_a_populated_v67_provider_store_and_fences_v67() {
    let dir = tempfile::tempdir().unwrap();
    let descriptor = descriptor(dir.path());
    let chain_67: Vec<Migration> = MIGRATIONS
        .iter()
        .filter(|migration| migration.version <= 67)
        .cloned()
        .collect();
    let before = {
        let older = McStore::open_with_migrations(&descriptor, false, &chain_67).unwrap();
        assert_eq!(older.module_store_schema_version().unwrap(), 67);
        populate(&older);
        assert_eq!(
            count(&older, "SELECT count(*) FROM sqlite_master WHERE name LIKE 'mc_provider_policy_summar%' OR name LIKE 'mc_provider_policy_change%'"),
            0
        );
        provider_rows(&older)
    };
    assert!(before.contains("m3#1"), "the v67 store holds policy rows");

    let current = McStore::open_for_test(&descriptor).unwrap();
    assert_eq!(LATEST_MIGRATION_VERSION, 68);
    assert_eq!(current.module_store_schema_version().unwrap(), 68);
    assert_eq!(
        provider_rows(&current),
        before,
        "migration 68 moves no rows"
    );
    for (kind, names) in [
        (
            "table",
            &[
                "mc_provider_policy_summaries_v1",
                "mc_provider_policy_changes_v1",
            ][..],
        ),
        (
            "trigger",
            &[
                "mc_provider_policy_parts_change_insert",
                "mc_provider_policy_parts_change_update",
                "mc_provider_policy_parts_change_delete",
                "mc_provider_consumed_tags_change",
                "mc_provider_conversations_policy_summary_delete",
            ][..],
        ),
        (
            "index",
            &[
                "mc_provider_policy_parts_tag",
                "mc_provider_policy_parts_arc",
                "mc_provider_policy_parts_unserved",
                "mc_provider_answers_cadence",
                "mc_provider_answers_cadence_fire",
            ][..],
        ),
    ] {
        for name in names {
            assert_eq!(
                count(
                    &current,
                    &format!(
                        "SELECT count(*) FROM sqlite_master WHERE type='{kind}' AND name='{name}'"
                    )
                ),
                1,
                "{kind} {name}"
            );
        }
    }
    assert_eq!(
        count(
            &current,
            "SELECT count(*) FROM mc_provider_policy_summaries_v1"
        ),
        0
    );

    // Without a summary the triggers log nothing.
    current
        .execute_tag_sql_for_test(&format!("{UPDATE_SERVED}1"))
        .unwrap();
    current
        .execute_tag_sql_for_test("INSERT INTO mc_provider_consumed_tags_v1 VALUES ('s',2,'s')")
        .unwrap();
    assert_eq!(
        count(
            &current,
            "SELECT count(*) FROM mc_provider_policy_changes_v1"
        ),
        0
    );

    // A summary stored by a hook turns logging on; the first pre-change copy is kept.
    hook(&current, Some(r#"{"probe":true}"#));
    assert_eq!(
        count(
            &current,
            "SELECT count(*) FROM mc_provider_policy_summaries_v1"
        ),
        1
    );
    let original: String = scalar(
        &current,
        "SELECT policy_json FROM mc_provider_policy_parts_v1 WHERE block_id='m3#1'",
    );
    current
        .execute_tag_sql_for_test(&format!("{UPDATE_SERVED}3"))
        .unwrap();
    current
        .execute_tag_sql_for_test("INSERT INTO mc_provider_consumed_tags_v1 VALUES ('s',3,'s')")
        .unwrap();
    assert_eq!(
        count(
            &current,
            "SELECT count(*) FROM mc_provider_policy_changes_v1"
        ),
        1
    );
    let logged: String = scalar(
        &current,
        "SELECT previous_json FROM mc_provider_policy_changes_v1 WHERE block_id='m3#1'",
    );
    assert_eq!(logged, original);
    // Deleting a part cannot be replayed: the summary and its log go.
    current
        .execute_tag_sql_for_test("DELETE FROM mc_provider_policy_parts_v1 WHERE block_id='m1#0'")
        .unwrap();
    assert_eq!(
        count(
            &current,
            "SELECT count(*) FROM mc_provider_policy_summaries_v1"
        ),
        0
    );
    assert_eq!(
        count(
            &current,
            "SELECT count(*) FROM mc_provider_policy_changes_v1"
        ),
        0
    );
    drop(current);

    // A version-67 binary refuses the upgraded store without touching it.
    let db_path = dir.path().join("store.db");
    let bytes = std::fs::read(&db_path).unwrap();
    let Err(refusal) = McStore::open_with_migrations(&descriptor, false, &chain_67) else {
        panic!("a version 67 binary must not open a version 68 store");
    };
    assert!(
        matches!(
            refusal,
            McStoreError::StoreAheadOfBinary {
                db_version: 68,
                binary_max: 67
            }
        ),
        "{refusal:?}"
    );
    assert_eq!(std::fs::read(&db_path).unwrap(), bytes);
}

/// The admission upsert (`ON CONFLICT DO UPDATE`) fires the update trigger and
/// keeps the first pre-change copy. `INSERT OR REPLACE` (no shipped writer uses
/// it) logs the row as new, losing the pre-change copy; the replay only stays
/// exact because a "new" row at or before the newest known position rebuilds.
#[test]
fn upsert_keeps_the_first_copy_and_replace_logs_a_new_row() {
    let dir = tempfile::tempdir().unwrap();
    let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
    populate(&store);
    hook(&store, Some(r#"{"probe":true}"#));
    let original: String = scalar(
        &store,
        "SELECT policy_json FROM mc_provider_policy_parts_v1 WHERE block_id='m2#1'",
    );
    for value in ["true", "false"] {
        store
            .execute_tag_sql_for_test(&format!(
                "INSERT INTO mc_provider_policy_parts_v1 SELECT conv_key,lineage_id,ordinal,block_id,json_set(policy_json,'$.queued',json('{value}')),session FROM mc_provider_policy_parts_v1 WHERE block_id='m2#1' ON CONFLICT(conv_key,lineage_id,block_id) DO UPDATE SET policy_json=excluded.policy_json"
            ))
            .unwrap();
    }
    assert_eq!(
        count(&store, "SELECT count(*) FROM mc_provider_policy_changes_v1"),
        1
    );
    let logged: Option<String> = scalar(
        &store,
        "SELECT previous_json FROM mc_provider_policy_changes_v1 WHERE block_id='m2#1'",
    );
    assert_eq!(logged.as_deref(), Some(original.as_str()));

    store
        .execute_tag_sql_for_test("INSERT OR REPLACE INTO mc_provider_policy_parts_v1 SELECT conv_key,lineage_id,ordinal,block_id,json_set(policy_json,'$.served',json('true')),session FROM mc_provider_policy_parts_v1 WHERE block_id='m3#1'")
        .unwrap();
    assert_eq!(
        count(
            &store,
            "SELECT count(*) FROM mc_provider_policy_summaries_v1"
        ),
        1
    );
    let replaced: Option<String> = scalar(
        &store,
        "SELECT previous_json FROM mc_provider_policy_changes_v1 WHERE block_id='m3#1'",
    );
    assert_eq!(replaced, None, "REPLACE is logged as a new row");
}

/// Partner of the recorded failure below: on an intact latest store both new
/// session tables get the INSERT, UPDATE and DELETE move guards.
#[test]
fn an_intact_latest_store_guards_both_summary_tables() {
    let dir = tempfile::tempdir().unwrap();
    let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
    assert_eq!(
        count(&store, "SELECT count(*) FROM sqlite_temp_master WHERE type='trigger' AND (name LIKE 'mc_move_guard_mc_provider_policy_summaries_v1_%' OR name LIKE 'mc_move_guard_mc_provider_policy_changes_v1_%')"),
        6
    );
}

/// The writer-guard installer skips a missing inventory table only when the
/// store's recorded version predates the migration that creates it. A
/// latest-version store missing a session table fails to open while creating
/// that table's guard (review F4).
#[test]
fn a_latest_store_missing_an_inventory_table_refuses_to_open() {
    let dir = tempfile::tempdir().unwrap();
    let descriptor = descriptor(dir.path());
    {
        let store = McStore::open_for_test(&descriptor).unwrap();
        store
            .execute_tag_sql_for_test("DROP TABLE mc_provider_policy_changes_v1")
            .unwrap();
    }
    assert!(
        McStore::open_for_test(&descriptor).is_err(),
        "a version-68 store without mc_provider_policy_changes_v1 opened"
    );
}

/// The guard installer decides whether a missing table is expected from the
/// migration that creates it, so every guarded session table must be found in
/// some migration's SQL. A table it cannot place is never skipped.
#[test]
fn every_guarded_inventory_table_names_its_creating_migration() {
    use crate::move_inventory::{tables, Class, RowSelector, Store};
    for table in tables(Store::Module) {
        if !matches!(table.rows, RowSelector::Predicate(_)) || table.class == Class::NotSession {
            continue;
        }
        assert!(
            crate::migration_creating_table(table.table).is_some(),
            "{} has no creating migration",
            table.table
        );
    }
    assert_eq!(
        crate::migration_creating_table("mc_provider_policy_parts_v1"),
        Some(66)
    );
    assert_eq!(
        crate::migration_creating_table("mc_provider_policy_summaries_v1"),
        Some(68)
    );
    assert_eq!(
        crate::migration_creating_table("mc_provider_policy_changes_v1"),
        Some(68)
    );
    assert_eq!(crate::migration_creating_table("no_such_table"), None);
}

/// Releasing a consumed tag number would reactivate parts the summary counts
/// as inactive. No writer does it, but if one did, the summaries of that
/// namespace are dropped rather than replayed stale; renumbering does the same.
#[test]
fn releasing_or_renumbering_a_consumed_tag_drops_the_namespace_summary() {
    let dir = tempfile::tempdir().unwrap();
    let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
    populate(&store);
    for release in [
        "DELETE FROM mc_provider_consumed_tags_v1 WHERE tag_number=2",
        "UPDATE mc_provider_consumed_tags_v1 SET tag_number=9 WHERE tag_number=2",
    ] {
        store
            .execute_tag_sql_for_test(
                "INSERT INTO mc_provider_consumed_tags_v1 VALUES ('s',2,'s') ON CONFLICT DO NOTHING",
            )
            .unwrap();
        hook(&store, Some(r#"{"probe":true}"#));
        assert_eq!(
            count(
                &store,
                "SELECT count(*) FROM mc_provider_policy_summaries_v1"
            ),
            1
        );
        store.execute_tag_sql_for_test(release).unwrap();
        assert_eq!(
            count(
                &store,
                "SELECT count(*) FROM mc_provider_policy_summaries_v1"
            ),
            0,
            "{release}"
        );
        assert_eq!(
            count(&store, "SELECT count(*) FROM mc_provider_policy_changes_v1"),
            0,
            "{release}"
        );
        store
            .execute_tag_sql_for_test("DELETE FROM mc_provider_consumed_tags_v1")
            .unwrap();
    }
}

/// `INSERT OR REPLACE` deletes the old row without firing the delete trigger,
/// so its change is logged as a new row and the pre-change copy is lost (see
/// `upsert_keeps_the_first_copy_and_replace_logs_a_new_row`). The replay is
/// exact only through its newest-position fallback, so no shipped writer may
/// replace policy rows: writers use `ON CONFLICT DO UPDATE` instead.
#[test]
fn no_shipped_writer_replaces_policy_rows() {
    let crates = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let mut pending = vec![crates];
    let mut offenders = Vec::new();
    let mut scanned = 0;
    while let Some(dir) = pending.pop() {
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            if path.is_dir() {
                if name != "target" && !name.starts_with('.') {
                    pending.push(path);
                }
                continue;
            }
            // Test sources may replace rows on purpose to pin this behaviour.
            if !(name.ends_with(".rs") || name.ends_with(".sql")) || name.contains("test") {
                continue;
            }
            let text = std::fs::read_to_string(&path).unwrap().to_ascii_uppercase();
            scanned += 1;
            let compact = text.split_whitespace().collect::<Vec<_>>().join(" ");
            for statement in [
                "REPLACE INTO MC_PROVIDER_POLICY_PARTS_V1",
                "REPLACE INTO \"MC_PROVIDER_POLICY_PARTS_V1\"",
            ] {
                if compact.contains(statement) {
                    offenders.push(path.display().to_string());
                }
            }
        }
    }
    assert!(scanned > 100, "scanned only {scanned} source files");
    assert!(
        offenders.is_empty(),
        "policy rows replaced in {offenders:?}"
    );
}
