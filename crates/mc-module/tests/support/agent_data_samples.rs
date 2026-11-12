//! Published bodies captured while real daemons carry a populated session.

use super::*;

#[path = "agent_data_sample_files.rs"]
mod files;

async fn capture(
    samples: &mut files::Samples,
    machine: &Machine,
    name: &str,
    op: &str,
    params: Value,
) -> Value {
    let name = format!("wire-{name}");
    let body = samples.request(&name, &format!("agent_data.{op}"), params);
    let Driven::Reply(text) = machine.drive(op, body["params"].clone()).await else {
        panic!("{name} was not a success");
    };
    let value = serde_json::from_str(&text).unwrap();
    samples.reply(&name, op, &value);
    value
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs the daemon and mock runner binaries; run through scripts/wire-gate.sh"]
async fn agent_data_samples_v1_wire() {
    let world = World::new();
    world.bind(&[MOVED, EMPTY]);
    let a_dir = prepare_machine(&world, "samples-a");
    let b_dir = prepare_machine(&world, "samples-b");
    seed_moved(&open(&context_db_of(&a_dir)), MOVED);
    // A snapshot larger than the door's page limit exercises several admits;
    // the public export reply still describes the whole cut, not a page.
    open(&context_db_of(&a_dir))
        .execute(
            "UPDATE notes SET content = ?1 WHERE session_id = ?2",
            params!["a deterministic session note. ".repeat(40_000), MOVED],
        )
        .unwrap();
    let conn = open(&context_db_of(&a_dir));
    conn.execute(
        "INSERT INTO tags(session_id, message_id, type, byte_size, tag_number, harness) VALUES (?1, 'sample-message', 'text', 12, 1, ?2)",
        params![MOVED, HARNESS],
    ).unwrap();
    conn.execute(
        "INSERT INTO pending_ops(session_id, tag_id, operation, queued_at, harness) VALUES (?1, ?2, 'drop', 100, ?3)",
        params![MOVED, conn.last_insert_rowid(), HARNESS],
    ).unwrap();
    let (a, b) = tokio::join!(
        start_machine(&world, &a_dir, "samples-a", true),
        start_machine(&world, &b_dir, "samples-b", true)
    );
    let mut samples = files::Samples::default();
    let params = json!({"refs": refs(&[MOVED, EMPTY]), "cutId": CUT});
    capture(
        &mut samples,
        &a,
        "describe-no-runner",
        "describe",
        json!({}),
    )
    .await;
    capture(
        &mut samples,
        &a,
        "busy-idle",
        "busy",
        json!({"refs": refs(&[MOVED])}),
    )
    .await;
    capture(&mut samples, &a, "status-none", "status", params.clone()).await;
    let prepared = capture(&mut samples, &a, "prepare", "prepare", params.clone()).await;
    assert!(item(&prepared, MOVED)["endOffset"].as_u64().unwrap() > 1_048_576);
    world.seal(CUT, &prepared);
    capture(
        &mut samples,
        &a,
        "status-prepared",
        "status",
        params.clone(),
    )
    .await;
    capture(&mut samples, &a, "export", "export", params.clone()).await;
    capture(
        &mut samples,
        &a,
        "status-exported",
        "status",
        params.clone(),
    )
    .await;
    capture(&mut samples, &b, "diverged", "diverged", params.clone()).await;
    let imported = capture(&mut samples, &b, "import", "import", params.clone()).await;
    let repeated = capture(&mut samples, &b, "import-repeat", "import", params.clone()).await;
    assert_eq!(imported, repeated);
    capture(
        &mut samples,
        &b,
        "status-imported",
        "status",
        params.clone(),
    )
    .await;
    let mut release = params.clone();
    release["holder"] = json!("machine-b");
    capture(&mut samples, &a, "release", "release", release).await;
    capture(
        &mut samples,
        &a,
        "status-released",
        "status",
        params.clone(),
    )
    .await;
    capture(&mut samples, &b, "activate", "activate", params.clone()).await;
    assert_eq!(
        a.conn()
            .query_row(
                "SELECT COUNT(*) FROM pending_ops WHERE session_id = ?1",
                [MOVED],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    assert_eq!(
        b.conn()
            .query_row(
                "SELECT COUNT(*) FROM pending_ops WHERE session_id = ?1",
                [MOVED],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    capture(
        &mut samples,
        &b,
        "status-activated",
        "status",
        params.clone(),
    )
    .await;

    samples.request("wire-invalid-state", "agent_data.abort", params.clone());
    let (_, refusal) = contract_refusal(b.drive("abort", params).await);
    assert_eq!(refusal["code"], "invalid_state");
    samples.refusal("wire-invalid-state", &refusal);

    let abort = json!({"refs": refs(&[MOVED, EMPTY]), "cutId": BACK});
    capture(
        &mut samples,
        &b,
        "prepare-to-abort",
        "prepare",
        abort.clone(),
    )
    .await;
    capture(&mut samples, &b, "abort", "abort", abort.clone()).await;
    capture(&mut samples, &b, "status-aborted", "status", abort).await;
    samples.finish("wire-");
}
