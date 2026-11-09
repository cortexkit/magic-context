#[test]
#[ignore = "supplemental interleaved release CPU experiment"]
#[allow(clippy::assertions_on_constants)]
fn notice_cost_fixed_interleaved() {
    assert!(!cfg!(debug_assertions));
    assert!(cfg!(feature = "notice-cost-timing"));
    // With no selector, retain OpenCode 2 and Pi, including a Pi session
    // imported from the standalone plugin. "only" selects Broca;
    // "opencode2" and "pi" each select sessions created directly in ck-mc.
    // "all" adds Broca and the missing native Pi sizes to the same round-robin.
    let broca = std::env::var("NOTICE_COST_BROCA").ok();
    let mut specifications = vec![
        (Shape::OpenCode2, 1_000, false),
        (Shape::OpenCode2, 150_000, false),
        (Shape::OpenCode2, 500_000, false),
        (Shape::Pi, 1_000, false),
        (Shape::Pi, 500_000, true),
    ];
    if broca.as_deref() == Some("only") {
        specifications.clear();
    }
    if broca.as_deref() == Some("opencode2") {
        specifications.retain(|(shape, _, _)| matches!(shape, Shape::OpenCode2));
    }
    if broca.as_deref() == Some("pi") {
        specifications = [1_000, 150_000, 500_000].map(|size| (Shape::Pi, size, false)).to_vec();
    }
    if broca.as_deref() == Some("all") {
        // The default compares a 1k session created in ck-mc with a 500k
        // session imported from the plugin. Also measure sessions created
        // directly in ck-mc at both larger sizes without replacing that row.
        specifications.extend([(Shape::Pi, 150_000, false), (Shape::Pi, 500_000, false)]);
    }
    if matches!(broca.as_deref(), Some("only" | "all")) {
        specifications.extend([1_000, 150_000, 500_000].map(|size| (Shape::Broca, size, false)));
    }
    let mut fixtures = Vec::new();
    for &(shape, size, moved) in &specifications {
        let start = Instant::now();
        fixtures.push(Fixture::with_corpus(shape, size, moved, 500_000));
        println!(
            "INTERLEAVED_PREP {}",
            json!({
                "shape":shape.harness(), "size":size, "moved":moved,
                "total_source_rows":500_000, "other_source_rows":500_000-size,
                "wall_us":start.elapsed().as_micros() as u64
            })
        );
    }
    println!("INTERLEAVED_FIXTURES_READY {}", fixtures.len());
    let rows = fixtures.len() * 2;
    let mut cpu = vec![Vec::new(); rows];
    let mut wall = vec![Vec::new(); rows];
    let mut background = vec![Vec::new(); rows];
    let mut background_wall = vec![Vec::new(); rows];
    let mut setup = vec![Vec::new(); rows];
    let mut warm = vec![Vec::new(); rows];
    let trials: usize = if broca.is_some() { 100 } else { 50 };
    let mut execution = 0usize;
    for trial_number in 1..=trials {
        if broca.is_some() && trial_number.is_multiple_of(10) {
            println!("INTERLEAVED_LOAD {}", json!({"trial":trial_number,"loadavg":std::fs::read_to_string("/proc/loadavg").unwrap()}));
        }
        // Each trial tests the sizes in the same order. Pi's moved row follows
        // its 1k reference for each path, rather than a later fixture block.
        for (path_index, threshold) in [false, true].into_iter().enumerate() {
            for (fixture_index, fixture) in fixtures.iter().enumerate() {
                if trial_number > 50 && fixture.entries.len() == 500_000 {
                    continue;
                }
                let row = path_index * fixtures.len() + fixture_index;
                let (c, w, ws, s, details) = trial(fixture, threshold);
                let bg = details["background_cpu_us"].as_u64().unwrap();
                let bg_wall = details["background_wall_us"].as_u64().unwrap();
                cpu[row].push(c);
                wall[row].push(w);
                background[row].push(bg);
                background_wall[row].push(bg_wall);
                setup[row].push(s);
                warm[row].extend_from_slice(&ws);
                println!(
                    "INTERLEAVED_SAMPLE {}",
                    json!({
                        "execution":execution, "row":row, "trial":trial_number,
                        "shape":fixture.shape.harness(), "size":fixture.entries.len(),
                        "moved":specifications[fixture_index].2,
                        "total_source_rows":fixture.table_rows,
                        "other_source_rows":fixture.table_rows-fixture.entries.len(),
                        "path":if threshold {"build_publish"} else {"quiet"},
                        "cpu_us":c, "wall_us":w,
                        "background_cpu_us":bg, "background_wall_us":bg_wall,
                        "setup_cpu_us":s, "warmup_steps_cpu_us":ws,
                        "foreground_gap_reads":0,
                        "background_batches":1,
                        "published_views":usize::from(threshold),
                        "stages":details["stages"]
                    })
                );
                execution += 1;
            }
        }
    }
    for (path_index, threshold) in [false, true].into_iter().enumerate() {
        for (fixture_index, fixture) in fixtures.iter().enumerate() {
            let row = path_index * fixtures.len() + fixture_index;
            let expected = if fixture.entries.len() == 500_000 { 50 } else { trials };
            assert_eq!(cpu[row].len(), expected);
            println!(
                "INTERLEAVED_ROW {}",
                json!({
                    "row":row, "shape":fixture.shape.harness(),
                    "size":fixture.entries.len(), "moved":specifications[fixture_index].2,
                    "total_source_rows":fixture.table_rows,
                    "other_source_rows":fixture.table_rows-fixture.entries.len(),
                    "path":if threshold {"build_publish"} else {"quiet"},
                    "cpu_us":stats(&cpu[row]), "wall_us":stats(&wall[row]),
                    "background_cpu_us":stats(&background[row]),
                    "background_wall_us":stats(&background_wall[row]),
                    "setup_cpu_us":stats(&setup[row]),
                    "warmup_cpu_us":stats(&warm[row]),
                    "steps_cpu_us":cpu[row], "steps_wall_us":wall[row],
                    "background_steps_cpu_us":background[row],
                    "background_steps_wall_us":background_wall[row],
                    "setup_steps_cpu_us":setup[row], "warmup_steps_cpu_us":warm[row],
                    "warmup_steps_per_trial":WARM_STEPS,
                    "foreground_gap_reads":0,
                    "background_batches_per_timed_step":1,
                    "published_views_per_timed_step":usize::from(threshold)
                })
            );
        }
    }
    assert_eq!(execution, specifications.iter().map(|(_, size, _)| if *size == 500_000 { 50 } else { trials }).sum::<usize>() * 2);
    let accepted = |samples: &[u64], reference: &[u64]| {
        let own = stats(samples);
        let base = stats(reference);
        let median = own["median"].as_f64().unwrap();
        let p95 = own["p95"].as_f64().unwrap();
        (median < 2_000.0 && p95 < 2_000.0)
            || (median / base["median"].as_f64().unwrap() <= 2.0
                && p95 / base["p95"].as_f64().unwrap() <= 2.0)
    };
    let mut profile = std::collections::BTreeSet::new();
    for row in 0..rows {
        let fixture_index = row % fixtures.len();
        let fixture = &fixtures[fixture_index];
        if specifications[fixture_index].1 == 1_000 {
            continue;
        }
        let reference = row / fixtures.len() * fixtures.len() + specifications.iter().position(|(shape, size, _)| shape.harness() == fixture.shape.harness() && *size == 1_000).unwrap();
        if !accepted(&cpu[row], &cpu[reference])
            || !accepted(&background[row], &background[reference])
        {
            profile.insert(reference);
            profile.insert(row);
            println!("INTERLEAVED_FAILED_ROW {row}");
        }
    }
    // A stage-instrumented sweep already records every measured step, so it
    // needs no second profiling block after the acceptance samples finish.
    if !profile.is_empty() && std::env::var_os("NOTICE_COST_STAGES").is_none() {
        // This diagnostic phase does not change or replace the samples used
        // by the acceptance check. Already-prepared fixtures profile the failing rows
        // and their references, still round-robin on the same allocated host.
        std::env::set_var("NOTICE_COST_STAGES", "1");
        for trial_number in 1..=20 {
            for &row in &profile {
                let fixture = &fixtures[row % fixtures.len()];
                let threshold = row >= fixtures.len();
                let (c, w, _, _, details) = trial(fixture, threshold);
                println!(
                    "INTERLEAVED_PROFILE {}",
                    json!({
                        "row":row, "trial":trial_number,
                        "shape":fixture.shape.harness(), "size":fixture.entries.len(),
                        "moved":specifications[row%fixtures.len()].2,
                        "path":if threshold {"build_publish"} else {"quiet"},
                        "cpu_us":c, "wall_us":w,
                        "background_cpu_us":details["background_cpu_us"],
                        "background_wall_us":details["background_wall_us"],
                        "stages":details["stages"]
                    })
                );
            }
        }
    }
}
