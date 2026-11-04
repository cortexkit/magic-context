#[test]
#[ignore = "supplemental interleaved release CPU experiment"]
#[allow(clippy::assertions_on_constants)]
fn notice_cost_fixed_interleaved() {
    assert!(!cfg!(debug_assertions));
    assert!(cfg!(feature = "notice-cost-timing"));
    let specifications = [
        (Shape::OpenCode2, 1_000, false),
        (Shape::OpenCode2, 150_000, false),
        (Shape::OpenCode2, 500_000, false),
        (Shape::Pi, 1_000, false),
        (Shape::Pi, 500_000, true),
    ];
    let mut fixtures = Vec::new();
    for (shape, size, moved) in specifications {
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
    let mut cpu = vec![Vec::new(); 10];
    let mut wall = vec![Vec::new(); 10];
    let mut background = vec![Vec::new(); 10];
    let mut background_wall = vec![Vec::new(); 10];
    let mut setup = vec![Vec::new(); 10];
    let mut warm = vec![Vec::new(); 10];
    let mut execution = 0usize;
    for trial_number in 1..=50usize {
        // Each trial tests the sizes in the same order. Pi's moved row follows
        // its 1k reference for each path, rather than a later fixture block.
        for (path_index, threshold) in [false, true].into_iter().enumerate() {
            for (fixture_index, fixture) in fixtures.iter().enumerate() {
                let row = path_index * 5 + fixture_index;
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
                        "published_views":usize::from(threshold)
                    })
                );
                execution += 1;
            }
        }
    }
    for (path_index, threshold) in [false, true].into_iter().enumerate() {
        for (fixture_index, fixture) in fixtures.iter().enumerate() {
            let row = path_index * 5 + fixture_index;
            let expected = 50;
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
    assert_eq!(execution, 500);
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
    for row in 0..10 {
        let fixture_index = row % 5;
        if fixture_index == 0 || fixture_index == 3 {
            continue;
        }
        let reference = row / 5 * 5 + if fixture_index < 3 { 0 } else { 3 };
        if !accepted(&cpu[row], &cpu[reference])
            || !accepted(&background[row], &background[reference])
        {
            profile.insert(reference);
            profile.insert(row);
            println!("INTERLEAVED_FAILED_ROW {row}");
        }
    }
    if !profile.is_empty() {
        // This diagnostic phase does not change or replace the samples used
        // by the acceptance check. Already-prepared fixtures profile the failing rows
        // and their references, still round-robin on the same allocated host.
        std::env::set_var("NOTICE_COST_STAGES", "1");
        for trial_number in 1..=20 {
            for &row in &profile {
                let fixture = &fixtures[row % 5];
                let threshold = row >= 5;
                let (c, w, _, _, details) = trial(fixture, threshold);
                println!(
                    "INTERLEAVED_PROFILE {}",
                    json!({
                        "row":row, "trial":trial_number,
                        "shape":fixture.shape.harness(), "size":fixture.entries.len(),
                        "moved":specifications[row%5].2,
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
