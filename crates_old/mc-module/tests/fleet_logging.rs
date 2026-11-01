use std::fs;
use std::path::Path;
use std::process::Command;

#[path = "support/executable.rs"]
mod executable_staging;

#[test]
fn module_start_writes_dated_segment_under_resolved_data_dir() {
    let scratch_parent = std::env::temp_dir().join("magic-context/mc-module-fleet-logging");
    fs::create_dir_all(&scratch_parent).expect("create isolated temp parent");
    let root = tempfile::tempdir_in(scratch_parent).expect("temp data home");
    let cargo_module = env!("CARGO_BIN_EXE_ck-mc");
    let module = executable_staging::stage_executable(Path::new(cargo_module), "ckdev-mc", "ck-mc")
        .expect("stage ck-mc with a dev process name");
    let mut command = Command::new(&module);
    command
        .env("XDG_DATA_HOME", root.path())
        .env("SUBC_MODULE_ID", "magic-context")
        .env("CK_LOG", "info")
        .arg("--subc")
        .arg(root.path().join("missing-connection-file"));
    let output = executable_staging::retry_spawn(|| command.output()).expect("start module");
    assert!(
        !output.status.success(),
        "missing connection file must fail startup"
    );
    let logs = root.path().join("cortexkit/magic-context/logs");
    let entries: Vec<_> = fs::read_dir(&logs)
        .expect("module log directory")
        .map(|entry| entry.expect("segment entry").path())
        .collect();
    assert_eq!(entries.len(), 1);
    let filename = entries[0].file_name().unwrap().to_string_lossy();
    assert!(filename.starts_with("magic-context.20") && filename.ends_with(".log"));
    let line = fs::read_to_string(&entries[0]).expect("segment content");
    assert!(
        line.contains(" INFO  magic-context: mc-module: logger initialized"),
        "{line}"
    );
}
