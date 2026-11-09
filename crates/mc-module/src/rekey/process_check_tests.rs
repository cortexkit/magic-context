use super::*;
use std::io;

struct ProcFixture {
    root: tempfile::TempDir,
    first: u32,
    second: u32,
}

impl ProcFixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("self")).unwrap();
        let first = std::process::id() + 1;
        let second = first + 1;
        for (pid, comm, cmdline) in [
            (first, "ssh-agent\n", "ssh-agent\0-s\0"),
            (second, "gpg-agent\n", "gpg-agent\0--daemon\0"),
        ] {
            let path = root.path().join(pid.to_string());
            std::fs::create_dir_all(path.join("fd")).unwrap();
            std::fs::write(path.join("fd/0"), "").unwrap();
            std::fs::write(path.join("comm"), comm).unwrap();
            std::fs::write(path.join("cmdline"), cmdline).unwrap();
        }
        Self {
            root,
            first,
            second,
        }
    }

    fn scan(
        &self,
        ignore: &[u32],
        read_link: impl Fn(&Path) -> io::Result<PathBuf>,
    ) -> Result<(), String> {
        scan_proc_at(
            self.root.path(),
            &[PathBuf::from("/store/mode3.db")],
            &ignore.iter().copied().collect(),
            read_link,
        )
    }
}

fn denied(_: &Path) -> io::Result<PathBuf> {
    Err(io::Error::from(io::ErrorKind::PermissionDenied))
}

#[test]
fn rekey_proc_unreadable_processes_fail_closed_with_identity() {
    let proc = ProcFixture::new();
    let error = proc.scan(&[], denied).unwrap_err();
    assert!(error.starts_with("store_check_incomplete:"), "{error}");
    for (pid, comm, cmdline) in [
        (proc.first, "ssh-agent", "ssh-agent -s"),
        (proc.second, "gpg-agent", "gpg-agent --daemon"),
    ] {
        assert!(
            error.contains(&format!("pid={pid} comm={comm:?} cmdline={cmdline:?}")),
            "{error}"
        );
    }
}

#[test]
fn rekey_proc_ignore_pid_waives_only_named_unreadable_process() {
    let proc = ProcFixture::new();
    let error = proc.scan(&[proc.first], denied).unwrap_err();
    assert!(error.starts_with("store_check_incomplete:"), "{error}");
    assert!(!error.contains("ssh-agent"), "{error}");
    assert!(error.contains("gpg-agent"), "{error}");
    assert!(proc.scan(&[proc.first, proc.second], denied).is_ok());
}

#[test]
fn rekey_proc_readable_holder_wins_over_incomplete_scan_and_ignore_pid() {
    let proc = ProcFixture::new();
    for ignore in [vec![], vec![proc.first], vec![proc.first, proc.second]] {
        let reads = std::cell::Cell::new(0);
        let error = proc
            .scan(&ignore, |fd| {
                reads.set(reads.get() + 1);
                if reads.get() == 1 {
                    denied(fd)
                } else {
                    Ok(PathBuf::from("/store/mode3.db"))
                }
            })
            .unwrap_err();
        assert!(error.starts_with("store_in_use:"), "{error}");
        assert_eq!(
            reads.get(),
            2,
            "scan must continue past the unreadable process"
        );
    }
}

#[test]
fn rekey_proc_ignored_pid_with_mixed_descriptor_access_still_refuses() {
    let proc = ProcFixture::new();
    std::fs::remove_dir_all(proc.root.path().join(proc.second.to_string())).unwrap();
    std::fs::write(proc.root.path().join(format!("{}/fd/1", proc.first)), "").unwrap();
    let reads = std::cell::Cell::new(0);
    let error = proc
        .scan(&[proc.first, proc.second], |fd| {
            reads.set(reads.get() + 1);
            if reads.get() == 1 {
                denied(fd)
            } else {
                Ok(PathBuf::from("/store/mode3.db"))
            }
        })
        .unwrap_err();
    assert!(error.starts_with("store_in_use:"), "{error}");
    assert_eq!(reads.get(), 2, "an ignored process must still be inspected");
}

#[test]
fn rekey_proc_other_errors_cannot_be_waived() {
    let proc = ProcFixture::new();
    let error = proc
        .scan(&[proc.first, proc.second], |_| {
            Err(io::Error::from(io::ErrorKind::InvalidData))
        })
        .unwrap_err();
    assert!(error.starts_with("process_check_failed:"), "{error}");
}
