//! Opt-in real-store cost gate. The writer is a separate process so its CPU is
//! excluded from the provider's process CPU measurement.
//! Run in the production profile: `cargo test -p mc-module --release --lib
//! --locked app_read::watch::cost_bench::context_watch_real_load_cost --
//! --ignored --exact --nocapture`. Debug-profile costs are diagnostic, not a
//! measurement of the optimized ck-mc process shipped to apps.
use super::*;
use crate::app_read::tests_support::open_store;
use cpu_time::ProcessTime;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::time::Instant;

const SECONDS: u64 = 60;
const HZ: u64 = 50;

fn fixture() -> (tempfile::TempDir, Arc<mc_store::McStore>) {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path());
    let conn = rusqlite::Connection::open(dir.path().join("context.db")).unwrap();
    conn.execute_batch("BEGIN").unwrap();
    for i in 0..4 {
        let session = format!("cost-{i}");
        conn.execute(
            "INSERT INTO session_meta(session_id,harness) VALUES(?1,'opencode')",
            [&session],
        )
        .unwrap();
        conn.execute("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<50000) INSERT INTO tags(session_id,tag_number,message_id,type,status,tool_name,tool_owner_message_id,byte_size,token_count,input_byte_size,input_token_count,drop_mode) SELECT ?1,x,'call-'||x,'tool','dropped','bash','message-'||x,2048,512,80,20,'skeleton_real' FROM n", [&session]).unwrap();
        conn.execute("WITH RECURSIVE n(x) AS (SELECT 50001 UNION ALL SELECT x+1 FROM n WHERE x<50200) INSERT INTO tags(session_id,tag_number,message_id,type,status,byte_size,token_count) SELECT ?1,x,'message-'||x||':p0','message','active',1024,256 FROM n", [&session]).unwrap();
        conn.execute("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<300) INSERT INTO pending_ops(session_id,tag_id,operation,queued_at,harness) SELECT ?1,CASE WHEN x<=200 THEN 50000+x ELSE x-200 END,'drop',1000+x,'opencode' FROM n", [&session]).unwrap();
        let shape = conn.query_row("SELECT (SELECT COUNT(*) FROM tags WHERE session_id=?1 AND status='dropped'),(SELECT COUNT(*) FROM tags WHERE session_id=?1 AND status='active' AND tag_number IN (SELECT tag_id FROM pending_ops WHERE session_id=?1 AND operation='drop')),(SELECT COUNT(*) FROM pending_ops WHERE session_id=?1)", [&session], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?))).unwrap();
        assert_eq!(shape, (50_000, 200, 300));
    }
    conn.execute_batch(
        "INSERT INTO session_meta(session_id,harness) VALUES('unrelated','opencode'); COMMIT",
    )
    .unwrap();
    drop(conn);
    (dir, store)
}

#[test]
#[ignore = "subprocess helper for context_watch_real_load_cost"]
fn writer_process() {
    let Some(path) = std::env::var_os("MC_WATCH_COST_WRITER_DB") else {
        return;
    };
    let conn = rusqlite::Connection::open(path).unwrap();
    conn.busy_timeout(Duration::from_secs(5)).unwrap();
    println!("WATCH_WRITER_READY");
    let start = Instant::now();
    for i in 0..SECONDS * HZ {
        let at = start + Duration::from_micros(i * 1_000_000 / HZ);
        std::thread::sleep(at.saturating_duration_since(Instant::now()));
        conn.execute("UPDATE session_meta SET counter=counter+1,last_input_tokens=?1 WHERE session_id='unrelated'", [i as i64]).unwrap();
    }
    std::thread::sleep(
        (start + Duration::from_secs(SECONDS)).saturating_duration_since(Instant::now()),
    );
    println!(
        "WATCH_WRITER_COMMITS={} elapsed_s={:.3}",
        SECONDS * HZ,
        start.elapsed().as_secs_f64()
    );
}

fn percentile(values: &mut [f64], percent: usize) -> f64 {
    values.sort_by(f64::total_cmp);
    values[(values.len() * percent).div_ceil(100).saturating_sub(1)]
}

#[tokio::test]
#[ignore = "60 s at 50 commits/s for both one and four large watched sessions"]
async fn context_watch_real_load_cost() {
    let (dir, store) = fixture();
    let mut results = Vec::new();
    for subscribers in [1, 4] {
        let hub = Arc::new(Hub::default());
        let ctx = AppReadContext::from_parts(
            Some(Arc::clone(&store)),
            Arc::default(),
            Vec::new(),
            crate::now_ms(),
        );
        let mut subscriptions = Vec::new();
        let mut admissions = Vec::new();
        for i in 0..subscribers {
            let params = json!({"sessions":[{"runner":"opencode","harness":"opencode","session":format!("cost-{i}")} ]});
            let start = Instant::now();
            let mut sub = hub
                .subscribe(
                    "cost".into(),
                    (i as u16, 1),
                    Request::parse(params.as_object().unwrap()).unwrap_or_else(|e| panic!("{e:?}")),
                    &ctx,
                )
                .unwrap_or_else(|e| panic!("{e:?}"));
            admissions.push(start.elapsed().as_secs_f64() * 1000.0);
            sub.rx.recv().await.unwrap();
            subscriptions.push(sub);
        }
        tokio::time::sleep(DEBOUNCE * 2).await;
        let mut times = Vec::new();
        for _ in 0..50 {
            let start = Instant::now();
            hub.refresh(Arc::clone(&store));
            times.push(start.elapsed().as_secs_f64() * 1000.0 / subscribers as f64);
            for sub in &mut subscriptions {
                while sub.rx.try_recv().is_ok() {}
            }
        }
        let p50 = percentile(&mut times, 50);
        let p95 = percentile(&mut times, 95);
        let mut full_times = Vec::new();
        let mut slow_ctx = AppReadContext::from_parts(
            Some(Arc::clone(&store)),
            Arc::default(),
            Vec::new(),
            crate::now_ms(),
        );
        slow_ctx.budget = Duration::from_secs(30);
        for _ in 0..10 {
            for i in 0..subscribers {
                let session = locator::SessionRef {
                    runner: "opencode".into(),
                    harness: "opencode".into(),
                    session: format!("cost-{i}"),
                };
                let start = Instant::now();
                slow_digest(&slow_ctx, &session).unwrap_or_else(|e| panic!("{e:?}"));
                full_times.push(start.elapsed().as_secs_f64() * 1000.0);
            }
        }
        let full_p50 = percentile(&mut full_times, 50);
        let full_p95 = percentile(&mut full_times, 95);
        let admission_max = admissions.iter().copied().fold(0.0, f64::max);
        println!("WATCH_LATENCY subscribers={subscribers} admission_ms={admissions:?} admission_max_ms={admission_max:.3} fast_batch_p50_ms={:.3} fast_batch_p95_ms={:.3} full_hash_per_session_p50_ms={full_p50:.3} full_hash_per_session_p95_ms={full_p95:.3} derived_interval_ms={}", p50 * subscribers as f64, p95 * subscribers as f64, slow_interval_ms(full_p95));
        let mut writer = Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "app_read::watch::cost_bench::writer_process",
                "--nocapture",
            ])
            .env("MC_WATCH_COST_WRITER_DB", dir.path().join("context.db"))
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut output = BufReader::new(writer.stdout.take().unwrap());
        loop {
            let mut line = String::new();
            assert!(
                output.read_line(&mut line).unwrap() > 0,
                "writer did not start"
            );
            if line.contains("WATCH_WRITER_READY") {
                break;
            }
        }
        let cpu = ProcessTime::now();
        let wall = Instant::now();
        tokio::time::sleep(Duration::from_secs(SECONDS)).await;
        let cpu_s = cpu.elapsed().as_secs_f64();
        let wall_s = wall.elapsed().as_secs_f64();
        assert!(writer.wait().unwrap().success());
        let mut rest = String::new();
        std::io::Read::read_to_string(&mut output, &mut rest).unwrap();
        print!("{rest}");
        let cpu_percent = cpu_s / wall_s * 100.0;
        let active = hub.state.lock().unwrap().subscribers.len();
        println!("WATCH_COST subscribers={subscribers} active_after_load={active} dropped_per_session=50000 stamped_per_session=200 pending_per_session=300 samples=50 refresh_per_session_p50_ms={p50:.3} refresh_per_session_p95_ms={p95:.3} wall_s={wall_s:.3} provider_cpu_s={cpu_s:.6} provider_cpu_ms_per_s={:.3} provider_one_core_percent={cpu_percent:.3}", cpu_s / wall_s * 1000.0);
        let intervals: Vec<_> = hub
            .state
            .lock()
            .unwrap()
            .slow
            .values()
            .map(|s| (s.hash_ms, slow_interval_ms(s.hash_ms)))
            .collect();
        println!("WATCH_SLOW_LAST subscribers={subscribers} hash_ms_and_interval_ms={intervals:?}");
        results.push((subscribers, p95, cpu_percent, active, admission_max));
        drop(subscriptions);
        drop(hub);
    }
    for (subscribers, p95, cpu, active, admission) in results {
        assert!(
            admission <= 250.0,
            "admission {admission:.3}ms exceeds 250ms"
        );
        assert_eq!(
            active, subscribers,
            "cost cannot pass by losing subscribers"
        );
        assert!(
            p95 <= 5.0,
            "{subscribers} subscribers: refresh p95 {p95:.3}ms exceeds 5ms/session"
        );
        if subscribers == 4 {
            assert!(
                cpu <= 2.0,
                "four subscribers: {cpu:.3}% exceeds 2% of one core"
            );
        }
    }
    let conn = rusqlite::Connection::open(dir.path().join("context.db")).unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT counter FROM session_meta WHERE session_id='unrelated'",
            [],
            |r| r.get::<_, u64>(0)
        )
        .unwrap(),
        2 * SECONDS * HZ
    );
}
