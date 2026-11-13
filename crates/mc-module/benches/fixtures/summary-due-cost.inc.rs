fn allocation_totals() -> (u64, u64) {
    (COUNT.load(Relaxed), BYTES.load(Relaxed))
}

fn compact_cycle(shape: Shape, n: u64, offset: usize, estimated: bool) -> Entry {
    let original = cycle(shape, n, offset);
    let parts = original.parts.into_iter().map(|mut part| {
        if let PartBody::Text { text } = &mut part.body {
            *text = "Preserve the cache and review src/component.rs.".into();
        }
        mc_mock_runner::transcript::part(part.id, part.tag, part.seal, part.body)
    }).collect();
    let role = if estimated { Role::Assistant } else { original.role };
    let mut rebuilt = Entry::new(n, original.mid, role, original.written_at, parts);
    rebuilt.notice = original.notice;
    if matches!(shape, Shape::Broca) && offset.is_multiple_of(90) { rebuilt.notice = None; }
    rebuilt
}

async fn due_sample(shape: Shape, size: usize, legacy: bool, estimated: bool, profile: bool) -> Value {
    let original = Arc::new((1..=size).map(|n| compact_cycle(shape, n as u64, n - 1, estimated)).collect());
    let client = WireClient(Client(Arc::new(Mutex::new(RunnerState {
        original, added: vec![], view: View::seal(0, vec![]), offered: 0, views: vec![], record_views: false,
        foreground_reads: 0, background_reads: 0,
    }))));
    let route = Route { session: SessionRef::new("runner", shape.harness(), "summary-cost"), project: None, workdir: None, agent_id: None };
    let model = if estimated { ModelRef::new("test", "unknown") } else { ModelRef::new("anthropic", "claude-opus-5-5") };
    let setup = SetupRequest::new("head", model, 100_000_000, RESERVE, rules(), vec![], 1).with_newest(client.0.newest());
    let settings = Settings::default();
    let features = mc_module::preset::features("head").unwrap();
    let mut session = Session::new(&route, &setup, features, None);
    session.use_legacy_summary_scan(legacy);
    session.setup(&client, &settings, &route, &setup, features).await;
    for seq in 1..=3 {
        let latest = client.0.0.lock().unwrap().original.last().unwrap().clone();
        let mut notice = request(&client.0, seq, vec![latest], false);
        notice.conditions = serde_json::from_value(json!({"model": setup.model, "context_window": 100_000_000, "output_reserve": RESERVE, "rules": rules(), "now":2_000_000, "last_prompt_tokens":10_000})).unwrap();
        assert!(session.notice(&client, &settings, notice).await.is_none());
    }
    let added: Vec<_> = (0..3).map(|offset| compact_cycle(shape, size as u64 + offset as u64 + 1, size + offset, estimated)).collect();
    client.0.0.lock().unwrap().added.extend(added.clone());
    let mut notice = request(&client.0, 4, added, false);
    notice.conditions = serde_json::from_value(json!({"model": setup.model, "context_window": 100_000_000, "output_reserve": RESERVE, "rules": rules(), "now":2_000_000, "last_prompt_tokens":10_000})).unwrap();
    let offered = client.0.0.lock().unwrap().offered;
    let sends = SENDS.load(Relaxed);
    let reads = client.0.0.lock().unwrap().foreground_reads;
    if profile {
        mc_module::notice_cost_timing::allocation_reader(allocation_totals);
        mc_module::notice_cost_timing::begin();
    }
    COUNT.store(0, Relaxed); BYTES.store(0, Relaxed);
    let cpu = cpu_us();
    ACTIVE.store(true, Relaxed);
    let summary = session.notice(&client, &settings, notice).await;
    ACTIVE.store(false, Relaxed);
    let elapsed = cpu_us() - cpu;
    let (calls, bytes) = allocation_totals();
    let samples = if profile { mc_module::notice_cost_timing::take() } else { vec![] };
    let mut stages = std::collections::BTreeMap::<_, (u64,u64,u64,u64,u64)>::new();
    for sample in samples {
        let total = stages.entry(sample.stage).or_default();
        total.0 += sample.allocations; total.1 += sample.bytes;
        total.2 += sample.exclusive_allocations; total.3 += sample.exclusive_bytes;
        total.4 += sample.cpu_us;
    }
    assert!(summary.is_none(), "the measured notice must leave no summary outstanding");
    assert_eq!(client.0.0.lock().unwrap().offered, offered, "no view publication");
    assert_eq!(SENDS.load(Relaxed), sends, "no reminder");
    assert_eq!(client.0.0.lock().unwrap().foreground_reads, reads, "no gap read");
    json!({"shape":shape.harness(), "entries":size, "legacy":legacy, "estimated":estimated,
        "calls":calls, "bytes":bytes, "cpu_us":elapsed, "stages":stages})
}

#[test]
fn summary_due_notice_allocations_are_bounded() {
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    runtime.block_on(async {
        let report = std::env::var_os("SUMMARY_DUE_REPORT").is_some();
        for shape in [Shape::OpenCode2, Shape::Pi, Shape::Broca] {
            let mut measured = Vec::new();
            for size in if report { vec![1000, 2000, 5000] } else { vec![1000, 5000] } {
                if report {
                    let old = due_sample(shape, size, true, false, false).await;
                    println!("SUMMARY_DUE_SAMPLE {old}");
                }
                if report {
                    let new = due_sample(shape, size, false, false, false).await;
                    println!("SUMMARY_DUE_SAMPLE {new}");
                }
                let profile = due_sample(shape, size, false, false, true).await;
                println!("SUMMARY_DUE_PROFILE {profile}");
                measured.push(profile["stages"]["trigger.summary_due"][0].as_u64().unwrap());
            }
            assert!(measured.last().unwrap().abs_diff(measured[0]) <= 100, "allocation count must not scale with the window: {measured:?}");
            assert!(*measured.last().unwrap() < 1500, "ordinary notices must not rebuild full-window trigger inputs");
        }
        if report {
            for size in [1000, 5000] {
                let estimated = due_sample(Shape::Broca, size, false, true, false).await;
                println!("SUMMARY_DUE_ESTIMATED {estimated}");
                let estimated = due_sample(Shape::Broca, size, false, true, true).await;
                println!("SUMMARY_DUE_ESTIMATED_PROFILE {estimated}");
            }
            for legacy in [true, false] {
                let sample = due_sample(Shape::Pi, 2000, legacy, false, true).await;
                println!("SUMMARY_DUE_PROFILE {sample}");
            }
        }
    });
}
