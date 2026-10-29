#[cfg(test)]
mod tests {
    use super::super::*;
    use crate::app_read::tests_support::{caller, open_store, response};
    use crate::app_read_test_store::TestStores;
    use std::cell::Cell;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use std::time::Duration;

    thread_local! {
        static STATEMENTS_RUN: Cell<usize> = const { Cell::new(0) };
    }

    fn count_statement(_: &str) {
        STATEMENTS_RUN.with(|count| count.set(count.get() + 1));
    }

    fn fixture() -> TestStores {
        let stores = TestStores::new();
        stores.context_sql(include_str!("../../testdata/app-read-g/large-head.sql"));
        stores
    }

    fn target() -> crate::app_read::locator::LocatedSession {
        crate::app_read::locator::LocatedSession {
            session: crate::app_read::locator::SessionRef {
                runner: "opencode".into(),
                harness: "opencode".into(),
                session: "large-head".into(),
            },
            source: crate::app_read::locator::SessionSource::Standalone,
        }
    }

    fn measure_fields(conn: &rusqlite::Connection) {
        for field in [
            "session_id",
            "last_response_time",
            "cache_ttl",
            "counter",
            "last_nudge_tokens",
            "last_nudge_band",
            "is_subagent",
            "last_context_percentage",
            "last_input_tokens",
            "compartment_in_progress",
            "system_prompt_hash",
            "memory_block_count",
            "new_work_tokens",
            "total_input_tokens",
            "historian_failure_count",
            "historian_last_error",
        ] {
            let started = Instant::now();
            conn.query_row(
                &format!("SELECT {field} FROM session_meta WHERE session_id=?1"),
                ["large-head"],
                |r| r.get::<_, rusqlite::types::Value>(0),
            )
            .unwrap();
            eprintln!("large-head meta field {field}: {:?}", started.elapsed());
        }
        for (field, sql) in [
            (
                "compartment_count",
                "SELECT COUNT(*) FROM compartments WHERE session_id=?1",
            ),
            (
                "newest_compartment_at_ms",
                "SELECT MAX(created_at) FROM compartments WHERE session_id=?1",
            ),
        ] {
            let started = Instant::now();
            conn.query_row(sql, ["large-head"], |r| r.get::<_, i64>(0))
                .unwrap();
            eprintln!("large-head meta field {field}: {:?}", started.elapsed());
        }
        let started = Instant::now();
        let stamps =
            crate::app_read::context_states::standalone_queued_stamps(conn, &target(), &|| false)
                .unwrap();
        eprintln!(
            "large-head meta field queued_stamp_count: {:?} ({stamps} stamps)",
            started.elapsed()
        );
    }

    #[test]
    fn large_head_meta_is_bounded_and_matches_stamped_parts() {
        let mut stores = fixture();
        measure_fields(&stores.context);
        let mut candidates = stores
            .context
            .prepare(crate::app_read::context_states::STAMPED_TAGS)
            .unwrap();
        let rows = candidates
            .query_map(["large-head"], |_| Ok(()))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(rows.len(), 287);
        let steps = candidates.get_status(rusqlite::StatementStatus::VmStep);
        eprintln!(
            "large-head queued tag lookup: {} rows, {steps} VM instructions",
            rows.len()
        );
        assert!(
            steps < 20_000,
            "queued tag lookup scanned unrelated tags: {steps}"
        );
        drop(candidates);

        let dir = tempfile::tempdir().unwrap();
        STATEMENTS_RUN.with(|count| count.set(0));
        stores.context.trace(Some(count_statement));
        let ctx = AppReadContext::for_test(open_store(dir.path()), 1_700_000_000_000);
        let ctx = ctx.borrowed(&stores.context, &stores.store);
        let instructions = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&instructions);
        // Count SQLite VM instructions, including indexed row visits in nested
        // queries. A session-prefix tag scan is not a SQLite "full scan", so the
        // full-scan statement statistic alone would miss the expensive regression.
        stores.context.progress_handler(
            1000,
            Some(move || counter.fetch_add(1000, Ordering::Relaxed) >= 200_000),
        );
        let started = Instant::now();
        let outcome = read(
        &caller(),
        &ctx,
        json!({"session": {"runner":"opencode","harness":"opencode","session":"large-head"},"section":"meta"})
            .as_object()
            .unwrap(),
    );
        let elapsed = started.elapsed();
        stores.context.progress_handler(0, None::<fn() -> bool>);
        let instructions = instructions.load(Ordering::Relaxed);
        let statements_run = STATEMENTS_RUN.with(Cell::get);
        drop(ctx);
        stores.context.trace(None);
        eprintln!("large-head meta total: {elapsed:?}, {statements_run} SQL statements, {instructions} SQLite VM instructions");
        let reply = response(&outcome);
        assert_eq!(reply["row"]["compartment_count"], 3000);
        assert_eq!(
            reply["row"]["newest_compartment_at_ms"],
            1_700_000_003_000_i64
        );
        assert!(elapsed < Duration::from_millis(125), "{elapsed:?}");
        assert!(instructions < 200_000, "{instructions} VM instructions");
        assert!(statements_run < 400, "{statements_run} SQL statements");

        let mut stamped = 0;
        // Name the fixture's queued messages independently of the counter's SQL,
        // including summarized, before-first, boundary, and unrelated messages.
        let ids: Vec<_> = [1, 12001, 25000]
            .into_iter()
            .chain(2..=101)
            .chain(12102..=12301)
            .map(|i| format!("m{i}"))
            .collect();
        for ids in ids.chunks(100) {
            let page = response(&crate::app_read::context_states::context_states(
                &stores.context,
                &stores.store,
                &caller(),
                &json!({"session": {"runner":"opencode","harness":"opencode","session":"large-head"},"message_ids":ids}),
            ));
            stamped += page["messages"]
                .as_array()
                .unwrap()
                .iter()
                .map(|message| message["stamped_parts"].as_array().unwrap().len())
                .sum::<usize>();
        }
        assert_eq!(stamped, 190);
        assert_eq!(reply["row"]["queued_stamp_count"], json!(stamped));
    }
}
