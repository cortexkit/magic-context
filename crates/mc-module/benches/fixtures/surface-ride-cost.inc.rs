// Compact protocol entries omit tool-output bodies. The fixture therefore
// supplies last_prompt_tokens separately, using the provider's reported input
// token usage to exercise the same reclaim thresholds as a large prompt.
fn surface_settings() -> Settings {
    Settings {
        mural_enabled: true,
        ..Settings::default()
    }
}

fn surface_model() -> ModelRef {
    ModelRef::new("anthropic", "claude-opus-5-5")
}

fn surface_route(fixture: &Fixture) -> Route {
    Route {
        session: fixture.key.clone(),
        project: Some(mc_module::route::Project {
            id: "surface-cost-project".into(),
            root: fixture.dir.path().to_string_lossy().into_owned(),
        }),
        workdir: None,
        agent_id: None,
    }
}

fn surface_conditions() -> Conditions {
    serde_json::from_value(json!({
        "model":surface_model(), "context_window":WINDOW, "output_reserve":RESERVE,
        "rules":rules(), "now":2_000_000, "last_prompt_tokens":558_000,
        "accepts_images":true
    }))
    .unwrap()
}

fn surface_fixture(summaries: usize, memories: usize, tier_repeat: usize) -> Fixture {
    use sha2::Digest as _;
    let dir = tempfile::tempdir().unwrap();
    let key = SessionRef::new(Shape::OpenCode2.runner(), "opencode2", "surface-cost");
    let cut = summaries * 3;
    let entries: Vec<_> = (1..=cut + 283)
        .map(|n| {
            cycle(
                Shape::OpenCode2,
                n as u64,
                if n > cut { n - cut - 1 } else { n - 1 },
            )
        })
        .collect();
    let db = ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
    let source: Value =
        serde_json::from_str(include_str!("../../testdata/decay-store-shape.json")).unwrap();
    let rows = source["compartments"].as_array().unwrap();
    db.with_connection(|conn| {
        let tx = conn.transaction().unwrap();
        for sequence in 0..summaries {
            // This existing corpus has synthetic, length-preserving tier text.
            // Cycling it keeps the size sweep's tier distribution comparable.
            let row = &rows[sequence % rows.len()];
            let start = sequence * 3 + 1;
            let end = start + 2;
            tx.execute(
                "INSERT INTO compartments (session_id,harness,sequence,start_message,end_message,
                 start_message_id,end_message_id,title,content,p1,p2,p3,p4,importance,legacy,created_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,1)",
                params![key.session,key.harness,sequence as i64,start as i64,end as i64,
                    entries[start-1].mid,entries[end-1].mid,row["title"].as_str().unwrap_or(""),
                    row["content"].as_str().unwrap_or("").repeat(tier_repeat),row["p1"].as_str().map(|s| s.repeat(tier_repeat)),row["p2"].as_str().map(|s| s.repeat(tier_repeat)),
                    row["p3"].as_str().map(|s| s.repeat(tier_repeat)),row["p4"].as_str().map(|s| s.repeat(tier_repeat)),row["importance"].as_i64(),row["legacy"].as_i64()],
            ).unwrap();
        }
        for id in 1..=memories {
            let content = format!("Rule {id}: preserve stable prompt prefixes, inspect the component implementation, and run focused tests before publishing compatible changes. {}", "Cache boundaries are part of the public contract. ".repeat(3));
            let hash = format!("{:x}", sha2::Sha256::digest(content.as_bytes()));
            tx.execute(
                "INSERT INTO memories (id,project_path,category,content,normalized_hash,importance,
                 first_seen_at,created_at,updated_at,last_seen_at,mural_cue,mural_cue_hash)
                 VALUES (?1,'surface-cost-project','PROJECT_RULES',?2,?3,80,1,1,1,1,?4,?3)",
                params![id as i64,content,hash,format!("stable prefixes; focused checks {id}")],
            ).unwrap();
        }
        tx.commit().unwrap();
        mc_module::search::messages::index(conn, &key.harness, &key.session, &entries).unwrap();
    });
    let store = Store::open(&dir.path().join("mode3.db")).unwrap();
    let route = Route {
        session: key.clone(),
        project: Some(mc_module::route::Project {
            id: "surface-cost-project".into(),
            root: dir.path().to_string_lossy().into_owned(),
        }),
        workdir: None,
        agent_id: None,
    };
    let mut setup = SetupRequest::new("head", surface_model(), WINDOW, RESERVE, rules(), vec![], 1)
        .with_newest(cursor(&entries[cut - 1]));
    setup.accepts_images = Some(true);
    // Seed the frozen history head, m[0], without the last summary. A warm ride
    // that preserves that prefix puts the newest summary in m[1], the appended
    // history delta. The measured cache-loss ride folds both into a new m[0].
    db.with_connection(|conn| conn.execute_batch(&format!(
        "CREATE TEMP TABLE pending_summary AS SELECT * FROM compartments WHERE sequence={}; DELETE FROM compartments WHERE sequence={};", summaries-1, summaries-1
    )).unwrap());
    let db = Arc::new(db);
    let mut session = Session::new(
        &route,
        &setup,
        mc_module::preset::features("head").unwrap(),
        Some(db.clone()),
    );
    session.load_summaries();
    db.with_connection(|conn| {
        conn.execute_batch(
            "INSERT INTO compartments SELECT * FROM pending_summary; DROP TABLE pending_summary;",
        )
        .unwrap()
    });
    let view = session
        .first_view_after_move(&surface_settings(), &cursor(&entries[cut - 4]))
        .unwrap();
    let durable = session.durable();
    store.save(&key, &durable).unwrap();
    Fixture {
        dir,
        key,
        entries: Arc::new(entries),
        durable,
        view,
        cut,
        shape: Shape::OpenCode2,
        shared_table: false,
        table_rows: cut + 283,
    }
}

#[test]
#[ignore = "opt-in Linux release SurfaceChange ride stage measurement"]
#[allow(
    clippy::assertions_on_constants,
    reason = "refuse debug timing while retaining test compilation"
)]
fn surface_ride_cost() {
    use cortexkit_role_compaction::ride::{RideAnswer, RideCause, RideRequest};
    use sha2::Digest as _;
    assert!(!cfg!(debug_assertions), "run with --release");
    if std::env::var_os("SURFACE_TRACE").is_some() {
        let _ = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::DEBUG)
            .try_init();
    }
    let sizes: Vec<usize> = std::env::var("SURFACE_SUMMARIES")
        .unwrap_or_else(|_| "100,389,1000".into())
        .split(',')
        .map(|s| s.parse().unwrap())
        .collect();
    let memory_sizes: Vec<usize> = std::env::var("SURFACE_MEMORIES")
        .unwrap_or_else(|_| "400,1300".into())
        .split(',')
        .map(|s| s.parse().unwrap())
        .collect();
    assert!(
        mc_module::count::Counter::for_model(Some("anthropic/claude-opus-5-5"))
            .family()
            .is_some(),
        "the benchmark requires the exact Claude tokenizer"
    );
    let tier_repeat: usize = std::env::var("SURFACE_TIER_REPEAT")
        .unwrap_or_else(|_| "1".into())
        .parse()
        .unwrap();
    let mut results = Vec::new();
    for summaries in sizes {
        for &memories in &memory_sizes {
            let fixture = surface_fixture(summaries, memories, tier_repeat);
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            let row = runtime.block_on(async {
                let client = Client(Arc::new(Mutex::new(RunnerState { original:fixture.entries.clone(),added:vec![],view:fixture.view.clone(),offered:0,views:vec![],record_views:false,foreground_reads:0,background_reads:0 })));
                let route = surface_route(&fixture);
                let module = Module::new(client.clone(),surface_settings(),Some(ContextDb::open(&fixture.path("context.db")).unwrap()),Some(Store::open(&fixture.path("mode3.db")).unwrap()));
                let mut setup = SetupRequest::new("head",surface_model(),WINDOW,RESERVE,rules(),vec![],1).with_newest(client.newest());
                setup.accepts_images = Some(true);
                setup.applied_view = Some(client.applied());
                module.setup(route.clone(),setup).unwrap();
                drain(&module,&fixture.key).await;
                module.search_idle(&fixture.key).await.unwrap();
                let warm_candidate = fixture.entries[fixture.cut+4].parts[0].tag.unwrap();
                let answer = module.tool(&route,"ctx_reduce",json!({"drop":warm_candidate.to_string()})).await.unwrap();
                assert!(!answer.starts_with("Error"),"{answer}");
                drain(&module,&fixture.key).await;
                let make_ride = || {
                    let mut ride = RideRequest::new(vec![RideCause::SurfaceChange],120_000,surface_conditions());
                    ride.applied_view = Some(client.applied());
                    ride
                };
                let mut warm_ride = make_ride();
                warm_ride.causes = vec![RideCause::OverLimit];
                let RideAnswer::View { view } = module.ride(&fixture.key,warm_ride).await.unwrap() else { panic!("warm ride returned no view") };
                let warm_json = serde_json::to_string(&view).unwrap();
                assert!(warm_json.contains("<new-compartments>"), "warm soft ride must show m[1] history");
                client.0.lock().unwrap().view = view;
                drain(&module,&fixture.key).await;
                assert_eq!(client.applied().version,2);
                let candidate = fixture.entries[fixture.cut+1].parts[0].tag.unwrap();
                let answer = module.tool(&route,"ctx_reduce",json!({"drop":candidate.to_string()})).await.unwrap();
                assert!(!answer.starts_with("Error"),"{answer}");
                drain(&module,&fixture.key).await;
                module.search_idle(&fixture.key).await.unwrap();
                let before = Store::open(&fixture.path("mode3.db")).unwrap().load(&fixture.key).unwrap();
                assert!(!before.queued.is_empty(), "prepare a drop that has not already landed in view 2");
                let cold_mural = std::env::var_os("SURFACE_COLD_MURAL").is_some();
                if cold_mural {
                    ContextDb::open(&fixture.path("context.db")).unwrap().with_connection(|conn| {
                        conn.execute("DELETE FROM mural_manifest", []).unwrap();
                    });
                }
                module.pause_search_measurement(true);
                let reads = client.0.lock().unwrap().foreground_reads;
                mc_module::notice_cost_timing::begin();
                let before_cpu = cpu_us();
                let before_wall = Instant::now();
                let RideAnswer::View { view } = module.ride(&fixture.key,make_ride()).await.unwrap() else { panic!("measured ride returned no view") };
                let wall_us = before_wall.elapsed().as_micros() as u64;
                let process_cpu_us = cpu_us()-before_cpu;
                let stages = mc_module::notice_cost_timing::take();
                let mirrored = serde_json::to_value(&stages).unwrap()[0].get("parent").is_some();
                assert_eq!(mirrored, std::env::var_os("SURFACE_EXPECT_MIRROR").is_some(), "the unchanged and mirrored builds must not share a Cargo artifact");
                assert_eq!(view.version,3);
                assert_eq!(client.0.lock().unwrap().foreground_reads,reads);
                assert!(stages.iter().any(|s| s.stage=="head.fold"));
                let saved = Store::open(&fixture.path("mode3.db")).unwrap().load(&fixture.key).unwrap();
                assert!(saved.queued.is_empty(), "the SurfaceChange ride must land queued drops");
                assert_eq!(saved.baseline.as_ref().unwrap().through_sequence, summaries as i64-1);
                let view_json = serde_json::to_vec(&view).unwrap();
                let row = json!({"summaries":summaries,"memories":memories,"tier_repeat":tier_repeat,"mirrored":mirrored,"cold_mural":cold_mural,"active_entries":283,"applied_before":2,"published_version":view.version,"wall_us":wall_us,"process_cpu_us":process_cpu_us,"foreground_reads":0,"view_bytes":view_json.len(),"view_sha256":format!("{:x}",sha2::Sha256::digest(&view_json)),"stages":stages});
                module.pause_search_measurement(false);
                drain(&module,&fixture.key).await;
                row
            });
            println!("SURFACE_RIDE_ROW {row}");
            results.push(row);
        }
    }
    if let Some(path) = std::env::var_os("SURFACE_OUTPUT") {
        std::fs::write(path, serde_json::to_vec_pretty(&results).unwrap()).unwrap();
    }
}
