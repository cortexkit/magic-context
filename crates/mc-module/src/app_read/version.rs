//! Opaque versions over indexed counters, never transcript contents or wall time.
#![cfg_attr(
    not(test),
    expect(dead_code, reason = "consumed by the session read operations")
)]

use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::locator::{AsyncHeader, LocatedSession, SessionSource};

pub(crate) const TAGS: &str = "SELECT tags_version FROM session_meta WHERE session_id=?1";
pub(crate) const COMPARTMENTS: &str = "SELECT generation,version,rewrite_version FROM compartment_history_versions WHERE session_id=?1";
pub(crate) const MESSAGES: &str = "SELECT last_indexed_ordinal,dirty_floor_ordinal FROM message_history_index WHERE session_id=?1";
pub(crate) const STAMPS: &str =
    "SELECT COALESCE(MAX(rowid),0),COUNT(*) FROM pending_ops WHERE session_id=?1";
pub(crate) const ASYNC_RECORD: &str =
    "SELECT version_high_water,state_json FROM mc_async_compaction WHERE session_ref=?1";
pub(crate) const TAG_CACHE: &str =
    "SELECT generation FROM mc_tag_cache_generations WHERE session_id=?1";
pub(crate) const AGENT_DROPS: &str =
    "SELECT COALESCE(MAX(id),0),COUNT(*) FROM pending_agent_drops WHERE session_id=?1";
pub(crate) const PUBLISHED: &str = "SELECT COALESCE(MAX(version),0),COUNT(*) FROM mc_async_compaction_views WHERE session_ref=?1 AND version>?2";

pub(crate) enum VersionRequest<'a> {
    States(&'a [String]),
    Compartment(&'a str),
}

impl VersionRequest<'_> {
    fn identity(&self) -> (&'static str, Value) {
        match self {
            Self::States(ids) => {
                let mut ids = ids.to_vec();
                ids.sort();
                ("cs", json!(ids))
            }
            Self::Compartment(id) => ("cc", json!(id)),
        }
    }
}

/// Both connections must be held in read transactions spanning resolution,
/// counter reads and the operation's data reads. No target or version is cached.
pub(crate) fn session_version(
    context: &Connection,
    store: &Connection,
    target: &LocatedSession,
    request: VersionRequest<'_>,
) -> rusqlite::Result<String> {
    let key = target.context_session_id();
    let compartments = context
        .query_row(COMPARTMENTS, [key], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })
        .optional()?;
    let counters = match &target.source {
        SessionSource::Standalone => {
            let tags: Option<i64> = context.query_row(TAGS, [key], |r| r.get(0)).optional()?;
            let messages = context
                .query_row(MESSAGES, [key], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, Option<i64>>(1)?))
                })
                .optional()?;
            let stamps = context.query_row(STAMPS, [key], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
            })?;
            json!(["standalone", tags, compartments, messages, stamps])
        }
        SessionSource::Async {
            reference,
            namespace,
            ..
        } => {
            let (high_water, state) = store.query_row(ASYNC_RECORD, [reference], |r| {
                Ok((r.get::<_, u64>(0)?, r.get::<_, String>(1)?))
            })?;
            let header: AsyncHeader = serde_json::from_str(&state).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    1,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            // A resync between resolution and this read must not silently read
            // counters from the old namespace. Callers should hold a snapshot.
            if header.namespace() != *namespace {
                return Err(rusqlite::Error::InvalidQuery);
            }
            let tag_cache: Option<i64> =
                store.query_row(TAG_CACHE, [key], |r| r.get(0)).optional()?;
            let drops = store.query_row(AGENT_DROPS, [key], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
            })?;
            // Published views are immutable. Their maximum version and count
            // newer than the runner's last acknowledged version track publication
            // and acknowledgement; announcing a view on the bus changes neither.
            let published = store.query_row(
                PUBLISHED,
                rusqlite::params![reference, header.applied.unwrap_or(0)],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
            )?;
            json!([
                "async",
                reference,
                namespace,
                high_water,
                header.frozen_edits_version,
                tag_cache,
                compartments,
                drops,
                header.applied,
                published
            ])
        }
    };
    let (prefix, identity) = request.identity();
    let tuple = json!(["mc-app-read", 1, prefix, target.session, identity, counters]);
    let digest = Sha256::digest(serde_json::to_vec(&tuple).expect("version tuple serializes"));
    Ok(format!("{prefix}1:{digest:x}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_read::locator::{locate, SessionRef};
    use crate::app_read_test_store::TestStores;

    fn reference(runner: &str, session: &str) -> SessionRef {
        SessionRef {
            runner: runner.into(),
            harness: "pi".into(),
            session: session.into(),
        }
    }

    fn version(db: &TestStores, runner: &str, session: &str) -> String {
        let target = locate(&db.context, &db.store, &reference(runner, session)).unwrap();
        session_version(
            &db.context,
            &db.store,
            &target,
            VersionRequest::States(&["m1".into()]),
        )
        .unwrap()
    }

    fn standalone() -> TestStores {
        let db = TestStores::new();
        db.standalone("s", "pi");
        db
    }

    #[test]
    fn tag_status_change_invalidates_version() {
        let db = standalone();
        db.tag("s");
        let before = version(&db, "pi", "s");
        db.tag_status("s", "dropped");
        assert_ne!(before, version(&db, "pi", "s"));
    }

    #[test]
    fn compartment_insert_invalidates_version() {
        let db = standalone();
        let before = version(&db, "pi", "s");
        db.compartment("s");
        assert_ne!(before, version(&db, "pi", "s"));
    }

    #[test]
    fn compartment_update_invalidates_version() {
        let db = standalone();
        db.compartment("s");
        let before = version(&db, "pi", "s");
        db.revise_compartment("s");
        assert_ne!(before, version(&db, "pi", "s"));
    }

    #[test]
    fn message_indexing_and_dirty_floor_invalidate_version() {
        let db = standalone();
        let before = version(&db, "pi", "s");
        db.index_message("s", 5, 0);
        let indexed = version(&db, "pi", "s");
        assert_ne!(before, indexed);
        db.index_message("s", 5, 3);
        assert_ne!(indexed, version(&db, "pi", "s"));
    }

    #[test]
    fn stamp_queue_insert_remove_and_replacement_invalidate_version() {
        let db = standalone();
        let before = version(&db, "pi", "s");
        db.context_sql("INSERT INTO pending_ops(session_id,tag_id,operation,queued_at,harness) VALUES('s','t1','drop',10,'pi')");
        let stamped = version(&db, "pi", "s");
        assert_ne!(before, stamped);
        db.context_sql("DELETE FROM pending_ops WHERE session_id='s'; INSERT INTO pending_ops(session_id,tag_id,operation,queued_at,harness) VALUES('s','t2','drop',11,'pi')");
        let replaced = version(&db, "pi", "s");
        assert_ne!(stamped, replaced);
        db.context_sql("DELETE FROM pending_ops WHERE session_id='s'");
        assert_ne!(replaced, version(&db, "pi", "s"));
    }

    #[test]
    fn unrelated_writes_timestamps_and_repeated_reads_do_not_invalidate_version() {
        let db = standalone();
        db.tag("s");
        db.index_message("s", 5, 0);
        db.compartment("s");
        let before = version(&db, "pi", "s");
        db.standalone("elsewhere", "pi");
        db.tag("elsewhere");
        db.compartment("elsewhere");
        db.index_message("elsewhere", 8, 2);
        db.context_sql("UPDATE session_meta SET counter=counter+1,last_response_time=200 WHERE session_id='s'; UPDATE message_history_index SET updated_at=999 WHERE session_id='s'");
        assert_eq!(before, version(&db, "pi", "s"));
        assert_eq!(before, version(&db, "pi", "s"));
    }

    #[test]
    fn versions_are_scoped_to_session_op_and_sorted_request_identity() {
        let db = standalone();
        db.standalone("other", "pi");
        let target = locate(&db.context, &db.store, &reference("pi", "s")).unwrap();
        let compute = |request: VersionRequest<'_>| {
            session_version(&db.context, &db.store, &target, request).unwrap()
        };
        let states = compute(VersionRequest::States(&["m1".into(), "m2".into()]));
        assert!(states.starts_with("cs1:"));
        assert_eq!(states.len(), 68);
        assert_eq!(
            states,
            compute(VersionRequest::States(&["m2".into(), "m1".into()]))
        );
        assert_ne!(states, compute(VersionRequest::States(&["m1".into()])));
        let compartment = compute(VersionRequest::Compartment("1"));
        assert!(compartment.starts_with("cc1:"));
        assert_ne!(compartment, compute(VersionRequest::Compartment("2")));
        assert_ne!(states, compartment);
        assert_ne!(version(&db, "pi", "s"), version(&db, "pi", "other"));
    }

    #[test]
    fn async_counters_drops_publication_and_acknowledgement_invalidate_version() {
        let db = TestStores::new();
        let namespace = db.async_session("runner", "pi", "s", 1, false);
        let mut previous = version(&db, "runner", "s");
        for sql in [
            "UPDATE mc_async_compaction SET version_high_water=1".to_owned(),
            "UPDATE mc_async_compaction SET state_json=json_set(state_json,'$.frozen_edits_version',1)".to_owned(),
            format!("INSERT INTO mc_tag_cache_generations(session_id,generation) VALUES('{namespace}',1)"),
            format!("INSERT INTO pending_agent_drops(session_id,target_id,queued_at) VALUES('{namespace}','t1',10)"),
            "INSERT INTO mc_async_compaction_views(session_ref,session,version,view_json) SELECT session_ref,session,1,'{}' FROM mc_async_compaction".to_owned(),
            "UPDATE mc_async_compaction SET state_json=json_set(state_json,'$.applied',1)".to_owned(),
        ] {
            db.store_sql(&sql);
            let current = version(&db, "runner", "s");
            assert_ne!(previous, current, "{sql}");
            previous = current;
        }
        db.compartment(&namespace);
        let compartment = version(&db, "runner", "s");
        assert_ne!(previous, compartment);
        db.revise_compartment(&namespace);
        let revised = version(&db, "runner", "s");
        assert_ne!(compartment, revised);
        db.store_sql("UPDATE mc_async_compaction_views SET announced=1; UPDATE mc_async_compaction SET state_json=json_set(state_json,'$.seq',500)");
        assert_eq!(revised, version(&db, "runner", "s"));
        db.store_sql(
            "UPDATE mc_async_compaction SET state_json=json_set(state_json,'$.generation',2)",
        );
        assert_ne!(revised, version(&db, "runner", "s"));
    }

    #[test]
    fn every_version_query_searches_an_index() {
        let db = standalone();
        db.tag("s");
        db.compartment("s");
        db.index_message("s", 5, 0);
        for query in [TAGS, COMPARTMENTS, MESSAGES, STAMPS] {
            TestStores::indexed(&db.context, query, &[&"s"]);
        }
        let namespace = db.async_session("runner", "pi", "async-s", 1, false);
        let target = locate(&db.context, &db.store, &reference("runner", "async-s")).unwrap();
        let SessionSource::Async { reference, .. } = target.source else {
            panic!("expected async")
        };
        TestStores::indexed(&db.store, ASYNC_RECORD, &[&reference]);
        TestStores::indexed(&db.store, TAG_CACHE, &[&namespace]);
        TestStores::indexed(&db.store, AGENT_DROPS, &[&namespace]);
        TestStores::indexed(&db.store, PUBLISHED, &[&reference, &0_i64]);
    }
}
