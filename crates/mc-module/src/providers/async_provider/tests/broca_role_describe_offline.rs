use super::super::setup_checkpoint::broca_role_describe::{
    capture_logs, captures as historical_captures,
};
use super::*;

fn captures() -> Vec<(&'static str, bool, Value)> {
    historical_captures()
        .into_iter()
        .map(|(name, writer, mut describe)| {
            // Historical releases predate message_checkpoint. These positive
            // offline fixtures model the same descriptions after that capability
            // is added; the raw captures remain covered by Setup refusal tests.
            if writer {
                describe["capabilities"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!("message_checkpoint"));
            }
            (name, writer, describe)
        })
        .collect()
}

async fn prepare_capture(
    store: &Path,
    project: &Path,
    description: Value,
) -> Result<Prepared, command::RunError> {
    let (paths, session, served) = moved_stores(store, fixture_stores);
    pin_history_generation(&paths.context_db, &session, &[0, 1]);
    let work = tempfile::tempdir().unwrap();
    let mut setup = setup_file(project, &setup_request(&session, "fixture"));
    setup["runner_describe"] = description;
    let args = command_args(
        work.path(),
        &paths,
        &session,
        &export(&served, LINEAGE, 3),
        &setup,
    );
    first_pass(&args, project, &fixture::NoHolders).await?;
    Ok(Prepared {
        _work: work,
        paths,
        session,
        served,
        args,
    })
}

#[tokio::test]
async fn broca_role_describe_offline_cli_and_matching_first_notice() {
    let _clock = crate::tests::fixed_clock();
    for (name, writer, description) in captures() {
        let (store, project) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let result = prepare_capture(store.path(), project.path(), description.clone()).await;
        if !writer {
            let error = match result {
                Err(error) => error,
                Ok(_) => panic!("{name}: reader accepted a checkpoint"),
            };
            assert!(
                format!("{error:?}").contains("tag_checkpoint_unsupported"),
                "{name}: {error:?}"
            );
            continue;
        }
        let prep = result.unwrap_or_else(|error| panic!("{name}: {error:?}"));
        let runner = Served::new(prep.served.clone(), 7);
        *runner.describe.lock().unwrap() = description;
        let arm = Arm::open(
            store.path(),
            project.path(),
            &prep.session,
            runner,
            config(),
        );
        assert!(arm.state().offline_first_pass.is_some(), "{name}");
        assert_eq!(arm.notice(1, 0, None, Vec::new()).await, "ok", "{name}");
        assert!(
            super::super::super::offline_first_pass::adopted(&arm.state()),
            "{name}"
        );
        assert_eq!(
            arm.state().generation,
            0,
            "{name}: matching receipt adopted"
        );
    }
}

#[tokio::test]
async fn broca_role_describe_first_notice_decodes_every_capture() {
    let _clock = crate::tests::fixed_clock();
    for (name, writer, description) in captures() {
        let (store, project) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let prepared_description = if writer {
            description.clone()
        } else {
            captures()[0].2.clone()
        };
        let prep = prepare_capture(store.path(), project.path(), prepared_description)
            .await
            .unwrap();
        let runner = Served::new(prep.served.clone(), 7);
        *runner.describe.lock().unwrap() = description;
        let arm = Arm::open(
            store.path(),
            project.path(),
            &prep.session,
            runner,
            config(),
        );
        assert_eq!(arm.notice(1, 0, None, Vec::new()).await, "ok", "{name}");
        assert!(
            super::super::super::offline_first_pass::adopted(&arm.state()),
            "{name}"
        );
        assert_eq!(arm.state().generation, if writer { 0 } else { 1 }, "{name}");
        assert_eq!(arm.state().entries.len(), prep.served.len(), "{name}");
    }
}

#[tokio::test]
async fn broca_role_describe_offline_rerun_pins_the_description_without_writing() {
    let _clock = crate::tests::fixed_clock();
    for (name, writer, description) in captures() {
        let (store, project) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let prepared_description = if writer {
            description.clone()
        } else {
            captures()[0].2.clone()
        };
        let prep = prepare_capture(store.path(), project.path(), prepared_description)
            .await
            .unwrap();
        let before = store_rows(&prep.paths);
        let mut setup = setup_file(project.path(), &setup_request(&prep.session, "fixture"));
        setup["runner_describe"] = description;
        std::fs::write(&prep.args.setup, setup.to_string()).unwrap();
        let result = first_pass(&prep.args, project.path(), &fixture::NoHolders).await;
        if writer {
            assert!(
                matches!(result, Ok(OfflineOutcome::Unchanged(_))),
                "{name}: {result:?}"
            );
            setup["runner_describe"] = if name.ends_with("before") {
                captures()[1].2.clone()
            } else {
                captures()[0].2.clone()
            };
            std::fs::write(&prep.args.setup, setup.to_string()).unwrap();
            assert_eq!(
                refusal_code(first_pass(&prep.args, project.path(), &fixture::NoHolders).await),
                "offline_state_differs",
                "{name}: an upgrade or downgrade cannot reuse a different receipt"
            );
        } else {
            assert_eq!(refusal_code(result), "offline_state_differs", "{name}");
        }
        assert!(
            store_rows(&prep.paths) == before,
            "{name}: neither unchanged nor refused reruns write"
        );
    }
}

#[tokio::test]
async fn broca_role_describe_upgrade_discards_receipt_once_at_setup_or_notice() {
    const CHILD: &str = "MC_BROCA_DESCRIBE_LOG_CHILD";
    const TEST: &str = "providers::async_provider::tests::offline_first_pass::broca_role_describe::broca_role_describe_upgrade_discards_receipt_once_at_setup_or_notice";
    if std::env::var_os(CHILD).is_none() {
        // Isolate the process-wide subscriber from parallel tests, while
        // capturing the discard log regardless of which thread emits it.
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", TEST, "--nocapture"])
            .env(CHILD, "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            String::from_utf8_lossy(&output.stdout).contains("1 passed; 0 failed"),
            "the isolated test must run: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        return;
    }
    let _clock = crate::tests::fixed_clock();
    let before = captures()[0].2.clone();
    let after = captures()[1].2.clone();
    let (subscriber, logs) = capture_logs();
    tracing::subscriber::set_global_default(subscriber).unwrap();
    for at_setup in [true, false] {
        logs.0.lock().unwrap().clear();
        let (store, project) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let prep = prepare_capture(store.path(), project.path(), before.clone())
            .await
            .unwrap();
        let runner = Served::new(prep.served.clone(), 7);
        *runner.describe.lock().unwrap() = after.clone();
        let arm = Arm::open(
            store.path(),
            project.path(),
            &prep.session,
            runner,
            config(),
        );
        if at_setup {
            let answer = arm.setup(setup_request(&prep.session, "fixture")).await;
            assert_eq!(answer["code"], "moved_session_unprepared", "{answer}");
            assert_eq!(arm.state().entries.len(), prep.served.len());
            assert!(!super::super::super::offline_first_pass::adopted(
                &arm.state()
            ));
        }
        assert_eq!(arm.notice(1, 0, None, Vec::new()).await, "ok");
        assert!(super::super::super::offline_first_pass::adopted(
            &arm.state()
        ));
        assert_eq!(arm.state().generation, 1);
        assert_eq!(
            arm.state().entries.len(),
            prep.served.len(),
            "normal first pass reads the transcript"
        );
        assert_eq!(arm.notice(2, 0, None, Vec::new()).await, "ok");
        assert_eq!(arm.state().generation, 1, "invalidation never repeats");
        let output = String::from_utf8(logs.0.lock().unwrap().clone()).unwrap();
        let discards: Vec<_> = output
            .lines()
            .filter(|line| {
                line.contains("offline_first_pass_discarded")
                    && line.contains("runner_describe_differs")
            })
            .collect();
        assert_eq!(discards.len(), 1, "at_setup={at_setup}: {output}");
    }
}
