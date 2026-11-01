#[path = "support/executable.rs"]
mod executable_staging;

#[test]
fn staging_root_uses_tmpdir_only_when_resolved_outside_var_folders() {
    use std::path::{Path, PathBuf};

    let fallback = Path::new("/tmp/magic-context-exec");
    assert_eq!(
        executable_staging::executable_root_for_tmpdir(None, None),
        fallback
    );
    assert_eq!(
        executable_staging::executable_root_for_tmpdir(
            Some(Path::new("/var/folders/abc")),
            Some(Path::new("/var/folders/abc")),
        ),
        fallback
    );
    assert_eq!(
        executable_staging::executable_root_for_tmpdir(
            Some(Path::new("/var/folders/abc")),
            Some(Path::new("/private/var/folders/abc")),
        ),
        fallback
    );
    assert_eq!(
        executable_staging::executable_root_for_tmpdir(
            Some(Path::new("/worker/task-tmp")),
            Some(Path::new("/worker/task-tmp")),
        ),
        PathBuf::from("/worker/task-tmp/magic-context-exec")
    );
}

#[test]
fn staged_executable_is_content_named_private_and_reused() {
    use sha2::{Digest, Sha256};
    use std::fs;
    #[cfg(target_os = "macos")]
    use std::path::Path;

    let scratch = tempfile::tempdir().expect("create binary fixture directory");
    #[cfg(not(target_os = "macos"))]
    let first_source = {
        let path = scratch.path().join("ck-mc");
        fs::write(&path, b"first binary contents").unwrap();
        path
    };
    #[cfg(target_os = "macos")]
    let first_source = std::env::current_exe().expect("test executable");

    let first = executable_staging::stage_executable(&first_source, "ckdev-mc", "ck-mc")
        .expect("stage first binary");
    let second = executable_staging::stage_executable(&first_source, "ckdev-mc", "ck-mc")
        .expect("reuse first binary");
    assert_eq!(first, second, "identical bytes reuse the same staged file");
    let first_digest = format!("{:x}", Sha256::digest(fs::read(&first_source).unwrap()));
    assert_eq!(
        first
            .parent()
            .unwrap()
            .file_name()
            .unwrap()
            .to_str()
            .unwrap(),
        first_digest
    );
    assert_eq!(
        first
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .file_name()
            .and_then(|name| name.to_str()),
        Some("magic-context-exec")
    );
    assert!(!first.starts_with(scratch.path()));

    #[cfg(not(target_os = "macos"))]
    let changed_source = {
        let path = scratch.path().join("changed-ck-mc");
        fs::write(&path, b"changed binary contents").unwrap();
        path
    };
    #[cfg(target_os = "macos")]
    let changed_source = Path::new("/bin/ls").to_path_buf();

    let changed = executable_staging::stage_executable(&changed_source, "ckdev-mc", "ck-mc")
        .expect("stage changed binary");
    let changed_digest = format!("{:x}", Sha256::digest(fs::read(&changed_source).unwrap()));
    assert_eq!(
        changed
            .parent()
            .unwrap()
            .file_name()
            .unwrap()
            .to_str()
            .unwrap(),
        changed_digest
    );
    assert_ne!(
        first.parent(),
        changed.parent(),
        "different bytes use a different SHA-256 directory"
    );
    #[cfg(not(target_os = "macos"))]
    {
        assert_eq!(
            fs::read(&changed).unwrap(),
            fs::read(&changed_source).unwrap()
        );
        fs::write(&first_source, b"changed binary contents").unwrap();
        let rebuilt = executable_staging::stage_executable(&first_source, "ckdev-mc", "ck-mc")
            .expect("stage a rebuild at the original source path");
        assert_eq!(
            rebuilt, changed,
            "cache identity follows bytes, not source paths"
        );
        assert_ne!(rebuilt, first);
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(first.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(changed.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&first).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&changed).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(first.parent().unwrap().parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
}

#[cfg(target_os = "linux")]
#[test]
fn concurrent_staging_and_spawning_share_one_published_executable() {
    use std::os::unix::fs::MetadataExt;
    use std::process::{Command, Stdio};
    use std::sync::{Arc, Barrier};

    let scratch = tempfile::tempdir().unwrap();
    let name = format!(
        "ckdev-parallel-{}",
        scratch.path().file_name().unwrap().to_string_lossy()
    );
    let barrier = Arc::new(Barrier::new(8));
    let observations = std::thread::scope(|scope| {
        let threads = (0..8)
            .map(|_| {
                let barrier = Arc::clone(&barrier);
                let name = &name;
                scope.spawn(move || {
                    barrier.wait();
                    (0..8)
                        .map(|_| {
                            let executable = executable_staging::stage_executable(
                                std::path::Path::new("/bin/true"),
                                name,
                                "parallel-test",
                            )
                            .expect("stage concurrent executable");
                            let inode = std::fs::metadata(&executable).unwrap().ino();
                            let mut command = Command::new(&executable);
                            command
                                .stdin(Stdio::null())
                                .stdout(Stdio::null())
                                .stderr(Stdio::null());
                            let mut child = executable_staging::retry_spawn(|| command.spawn())
                                .expect("spawn concurrently staged executable");
                            assert!(child.wait().unwrap().success());
                            (executable, inode)
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect::<Vec<_>>();
        threads
            .into_iter()
            .flat_map(|thread| thread.join().unwrap())
            .collect::<Vec<_>>()
    });
    assert_eq!(observations.len(), 64);
    assert!(
        observations.iter().all(|value| value == &observations[0]),
        "all callers must use the same path and published inode"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn spawn_recovers_when_a_writable_executable_handle_is_released() {
    use std::io::ErrorKind;
    use std::process::Command;
    use std::time::Duration;

    let scratch = tempfile::tempdir().unwrap();
    let name = format!(
        "ckdev-busy-{}",
        scratch.path().file_name().unwrap().to_string_lossy()
    );
    let executable =
        executable_staging::stage_executable(std::path::Path::new("/bin/true"), &name, "busy-test")
            .unwrap();
    let writer = std::fs::OpenOptions::new()
        .write(true)
        .open(&executable)
        .unwrap();
    let mut command = Command::new(executable);
    let error = command
        .spawn()
        .expect_err("an open writer must block Linux exec");
    assert_eq!(error.kind(), ErrorKind::ExecutableFileBusy);
    let release = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(125));
        drop(writer);
    });
    let mut child = executable_staging::retry_spawn(|| command.spawn())
        .expect("bounded retry waits for the writer to close");
    assert!(child.wait().unwrap().success());
    release.join().unwrap();
}

#[test]
fn executable_busy_retry_uses_fifty_millisecond_backoff_then_succeeds() {
    use std::io::{self, ErrorKind};
    use std::time::Duration;

    let mut attempts = 0;
    let mut waits = Vec::new();
    let result = executable_staging::retry_spawn_with_backoff(
        || {
            attempts += 1;
            if attempts < 4 {
                Err(io::Error::from(ErrorKind::ExecutableFileBusy))
            } else {
                Ok(42)
            }
        },
        |delay| waits.push(delay),
    );
    assert_eq!(result.unwrap(), 42);
    assert_eq!(attempts, 4);
    assert_eq!(waits, vec![Duration::from_millis(50); 3]);
}

#[test]
fn executable_busy_retry_fails_loudly_after_twenty_attempts() {
    use std::io::{self, ErrorKind};
    use std::time::Duration;

    let mut attempts = 0;
    let mut waits = Vec::new();
    let result: io::Result<()> = executable_staging::retry_spawn_with_backoff(
        || {
            attempts += 1;
            Err(io::Error::from(ErrorKind::ExecutableFileBusy))
        },
        |delay| waits.push(delay),
    );
    assert_eq!(result.unwrap_err().kind(), ErrorKind::ExecutableFileBusy);
    assert_eq!(attempts, 20);
    assert_eq!(waits, vec![Duration::from_millis(50); 19]);
}

#[test]
fn spawn_errors_other_than_executable_busy_are_not_retried() {
    use std::io::{self, ErrorKind};

    let mut attempts = 0;
    let mut waits = 0;
    let result: io::Result<()> = executable_staging::retry_spawn_with_backoff(
        || {
            attempts += 1;
            Err(io::Error::from(ErrorKind::NotFound))
        },
        |_| waits += 1,
    );
    assert_eq!(result.unwrap_err().kind(), ErrorKind::NotFound);
    assert_eq!(attempts, 1);
    assert_eq!(waits, 0);
}
