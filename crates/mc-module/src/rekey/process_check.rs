use std::path::{Path, PathBuf};

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn store_paths(path: &Path) -> Result<Vec<PathBuf>, String> {
    let mut paths = vec![path.to_owned()];
    for suffix in ["-wal", "-shm", ".lock"] {
        let mut name = path.as_os_str().to_owned();
        name.push(suffix);
        let sidecar = PathBuf::from(name);
        if sidecar
            .try_exists()
            .map_err(|error| format!("process_check_failed: {error}"))?
        {
            paths.push(
                sidecar
                    .canonicalize()
                    .map_err(|error| format!("process_check_failed: {error}"))?,
            );
        }
    }
    Ok(paths)
}

// The sidecar fences new binaries for the entire operation. The platform scan
// also catches older modules, whose idle SQLite connections hold no transaction lock.
pub(super) fn refuse_open_store(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let paths = store_paths(path)?;
        // A process of our own user can refuse /proc reads for a moment, for
        // example while it runs execve. Such a refusal is retried a few
        // times; one that persists still refuses the re-key.
        let mut attempt = 0;
        loop {
            match scan_proc(&paths) {
                Err(error) if error.starts_with(DENIED) && attempt < 4 => {
                    attempt += 1;
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                result => return result,
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        let paths = store_paths(path)?;
        let output = std::process::Command::new("lsof")
            .args(["-F", "p", "--"])
            .args(&paths)
            .output()
            .map_err(|error| format!("process_check_failed: lsof is required: {error}"))?;
        parse_lsof(
            output.status.code(),
            &output.stdout,
            &output.stderr,
            &paths,
            std::process::id(),
        )
    }
    #[cfg(target_os = "windows")]
    {
        // No ck-mc build without the sidecar interlock has shipped on Windows,
        // so there are no older, nonparticipating module processes to detect.
        let _ = path;
        Ok(())
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = path;
        Err("process_check_failed: unsupported operating system".into())
    }
}

#[cfg(target_os = "linux")]
const DENIED: &str = "process_check_failed: permission denied";

#[cfg(target_os = "linux")]
fn scan_proc(paths: &[PathBuf]) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    let fail = |path: &Path, error: std::io::Error| {
        if error.kind() == std::io::ErrorKind::PermissionDenied {
            format!("{DENIED}: {}: {error}", path.display())
        } else {
            format!("process_check_failed: {}: {error}", path.display())
        }
    };
    // A process can exit, or close a descriptor, while the scan walks /proc.
    // What has gone holds nothing open, so its entries are skipped, not
    // treated as a failed check.
    let gone = |error: &std::io::Error| {
        // 3 is ESRCH: the process has exited.
        error.kind() == std::io::ErrorKind::NotFound || error.raw_os_error() == Some(3)
    };
    let own_uid = std::fs::metadata("/proc/self")
        .map_err(|error| fail(Path::new("/proc/self"), error))?
        .uid();
    let processes = std::fs::read_dir("/proc").map_err(|error| fail(Path::new("/proc"), error))?;
    for process in processes {
        let process = process.map_err(|error| fail(Path::new("/proc"), error))?;
        let Some(pid) = process
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<u32>().ok())
        else {
            continue;
        };
        if pid == std::process::id() {
            continue;
        }
        let path = process.path();
        let owner = match std::fs::metadata(&path) {
            Ok(metadata) => metadata.uid(),
            Err(error) if gone(&error) => continue,
            Err(error) => return Err(fail(&path, error)),
        };
        let fd_path = path.join("fd");
        let descriptors = match std::fs::read_dir(&fd_path) {
            Ok(descriptors) => descriptors,
            Err(error) if gone(&error) => continue,
            Err(error)
                if error.kind() == std::io::ErrorKind::PermissionDenied && owner != own_uid =>
            {
                continue
            }
            Err(error) => return Err(fail(&fd_path, error)),
        };
        for descriptor in descriptors {
            let descriptor = match descriptor {
                Ok(descriptor) => descriptor.path(),
                Err(error) if gone(&error) => continue,
                Err(error) => return Err(fail(&fd_path, error)),
            };
            let target = match std::fs::read_link(&descriptor) {
                Ok(target) => target,
                Err(error) if gone(&error) => continue,
                Err(error)
                    if error.kind() == std::io::ErrorKind::PermissionDenied && owner != own_uid =>
                {
                    continue
                }
                Err(error) => return Err(fail(&descriptor, error)),
            };
            if paths.contains(&target) {
                return Err(format!(
                    "store_in_use: {} is open by process {pid}; stop ck-mc first",
                    target.display()
                ));
            }
        }
    }
    Ok(())
}

#[cfg(any(target_os = "macos", test))]
fn parse_lsof(
    status: Option<i32>,
    stdout: &[u8],
    stderr: &[u8],
    paths: &[PathBuf],
    own_pid: u32,
) -> Result<(), String> {
    let detail = String::from_utf8_lossy(stderr);
    let stdout = std::str::from_utf8(stdout)
        .map_err(|error| format!("process_check_failed: invalid lsof output: {error}; {detail}"))?;
    let mut pids = std::collections::BTreeSet::new();
    for line in stdout.lines().filter(|line| !line.is_empty()) {
        // `-F p` still prints an `f<fd>` line for each open file under its
        // process line; the pid lines alone say who has the store open.
        if line
            .strip_prefix('f')
            .is_some_and(|fd| !fd.is_empty() && fd.chars().all(|c| c.is_ascii_alphanumeric()))
        {
            continue;
        }
        let pid = line
            .strip_prefix('p')
            .and_then(|pid| pid.parse::<u32>().ok())
            .ok_or_else(|| {
                format!("process_check_failed: unexpected lsof output {line}; {detail}")
            })?;
        if pid != own_pid {
            pids.insert(pid);
        }
    }
    if !pids.is_empty() {
        return Err(format!(
            "store_in_use: store is open by process(es) {pids:?}; stop ck-mc first; {detail}"
        ));
    }
    let target_warning = paths
        .iter()
        .any(|path| detail.contains(path.to_string_lossy().as_ref()));
    // lsof exits 1 whenever any named file is open by no process, which is
    // the normal case here (an absent -wal, or every file but our own lock),
    // so 0 and 1 both mean it ran; the pid lines above decide the answer.
    if target_warning || !matches!(status, Some(0) | Some(1)) {
        return Err(format!(
            "process_check_failed: lsof exit {status:?}: {detail}"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rekey_lsof_parser_handles_pids_and_unrelated_mount_warnings() {
        let paths = vec![PathBuf::from("/store/mode3.db")];
        let warning = b"lsof: WARNING: can't stat() xfs file system /unrelated/lower\nOutput information may be incomplete.\n";
        assert!(parse_lsof(Some(1), b"", b"", &paths, 10).is_ok());
        assert!(parse_lsof(Some(1), b"", warning, &paths, 10).is_ok());
        assert!(parse_lsof(Some(0), b"p10\n", warning, &paths, 10).is_ok());
        // Real macOS output: our own lock file, with its fd line.
        assert!(parse_lsof(Some(0), b"p10\nf3\n", b"", &paths, 10).is_ok());
        assert!(parse_lsof(Some(1), b"p10\nf3\n", b"", &paths, 10).is_ok());
        assert!(parse_lsof(Some(0), b"p20\nf7\nfcwd\n", b"", &paths, 10)
            .unwrap_err()
            .starts_with("store_in_use"));
        let error = parse_lsof(Some(0), b"p10\np20\n", warning, &paths, 10).unwrap_err();
        assert!(error.starts_with("store_in_use"));
        assert!(error.contains("unrelated/lower"));
        for (status, stdout, stderr) in [
            (Some(2), b"".as_slice(), warning.as_slice()),
            (None, b"".as_slice(), b"".as_slice()),
            (Some(3), b"p10\n".as_slice(), b"".as_slice()),
            (Some(0), b"garbled\n".as_slice(), b"".as_slice()),
            (
                Some(1),
                b"".as_slice(),
                b"lsof: can't stat /store/mode3.db\n".as_slice(),
            ),
        ] {
            assert!(parse_lsof(status, stdout, stderr, &paths, 10)
                .unwrap_err()
                .starts_with("process_check_failed"));
        }
    }
}
