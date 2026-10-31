use super::*;

#[allow(clippy::type_complexity)]
fn async_rows(
    store: &McStore,
    reference: &str,
) -> (
    String,
    Vec<(u64, String, String)>,
    Vec<(u64, String)>,
    Vec<(String, String)>,
    Vec<(u64, String, Option<String>, bool)>,
    u64,
) {
    let rows = store
        .load_async_compaction_rows(reference)
        .unwrap()
        .unwrap();
    let (views, high) = store.load_async_compaction_views(reference).unwrap();
    (
        rows.state,
        rows.entries,
        rows.engine_views,
        rows.baselines,
        views,
        high,
    )
}

fn seed(store: &McStore, reference: &str, session: &str) {
    let key = format!("[\"runner\",\"{session}\",\"opencode\"]");
    let mut save = store.async_compaction_save(
        reference,
        &key,
        session,
        "{\"initial_stored\":true,\"initial_ready\":true,\"input_revision\":4}",
    );
    save.baseline(
        "setup-initial",
        Some("{\"answer\":\"ready\",\"exact\":\"prepared bytes\"}".into()),
    );
    save.baseline("frozen_edits", Some("[]".into()));
    for ordinal in 0..20 {
        save.append_entry(
            ordinal,
            format!("{{\"ordinal\":{ordinal},\"mid\":\"m{ordinal}\"}}"),
            "[]".into(),
        );
    }
    save.commit().unwrap();
    let version = store
        .reserve_async_compaction_version(reference, 0)
        .unwrap();
    store
        .save_async_compaction_view(
            reference,
            version,
            "exact published bytes",
            "exact engine bytes",
        )
        .unwrap();
}

#[test]
fn async_v2_move_preserves_every_byte_without_legacy_rows_or_foreign_session_groups() {
    let source = tempfile::tempdir().unwrap();
    let destination = tempfile::tempdir().unwrap();
    let src = open(source.path());
    seed(&src, "migrated-ref", "ses_move");
    seed(&src, "other-ref", "ses_other");
    let expected = async_rows(&src, "migrated-ref");
    let other = async_rows(&src, "other-ref");
    let legacy = src
        .inner
        .with_conn(|conn| {
            [
                "mc_async_compaction",
                "mc_async_compaction_entries",
                "mc_async_compaction_views",
                "mc_async_compaction_baselines",
            ]
            .iter()
            .map(|table| {
                conn.query_row(&format!("SELECT count(*) FROM main.{table}"), [], |row| {
                    row.get::<_, u64>(0)
                })
            })
            .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap();
    assert_eq!(legacy, vec![0, 0, 0, 0]);
    let staging = destination.path().join("async-staging");
    let _source_move = capture(&src, "async-cut", &staging);
    assert!(
        src.reserve_async_compaction_version("migrated-ref", 1)
            .is_err(),
        "v2 writer bypassed the moving-session fence"
    );
    let dst = open(destination.path());
    let mut mover = dst.move_store().unwrap();
    mover
        .reserve_install(&binding("async-cut"), "digest", &staging)
        .unwrap();
    install(&mut mover, "async-cut");
    assert_eq!(async_rows(&dst, "migrated-ref"), expected);
    assert!(dst.load_async_compaction("other-ref").unwrap().is_none());
    assert_eq!(async_rows(&src, "other-ref"), other);
    let actual_legacy = dst
        .inner
        .with_conn(|conn| {
            [
                "mc_async_compaction",
                "mc_async_compaction_entries",
                "mc_async_compaction_views",
                "mc_async_compaction_baselines",
            ]
            .iter()
            .map(|table| {
                conn.query_row(&format!("SELECT count(*) FROM main.{table}"), [], |row| {
                    row.get::<_, u64>(0)
                })
            })
            .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap();
    assert_eq!(actual_legacy, vec![0, 0, 0, 0]);
    discard(&mut mover, "async-cut");
    assert!(dst.load_async_compaction("migrated-ref").unwrap().is_none());
    let remaining = dst
        .inner
        .with_conn(|conn| {
            conn.query_row(
                "SELECT count(*) FROM mc_cache_sections WHERE session_id GLOB '__ckmc_async_v2_*'",
                [],
                |row| row.get::<_, u64>(0),
            )
        })
        .unwrap();
    assert_eq!(
        remaining, 0,
        "discard removed ownership headers before their dependent groups"
    );
}
