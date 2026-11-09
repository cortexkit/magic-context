//! Exempt unrelated host processes without exempting any test-owned process.

use std::collections::BTreeSet;
use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;

fn gone(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::NotFound || error.raw_os_error() == Some(3)
}

pub fn unreadable_same_user(pid: u32) -> Option<bool> {
    let path = PathBuf::from(format!("/proc/{pid}"));
    let owner = match std::fs::metadata(&path) {
        Ok(metadata) => metadata.uid(),
        Err(error) if gone(&error) => return None,
        Err(error) => panic!("{}: {error}", path.display()),
    };
    if owner != std::fs::metadata("/proc/self").unwrap().uid() {
        return Some(false);
    }
    let descriptors = match std::fs::read_dir(path.join("fd")) {
        Ok(descriptors) => descriptors,
        Err(error) if gone(&error) => return None,
        Err(error) if error.kind() == io::ErrorKind::PermissionDenied => return Some(true),
        Err(error) => panic!("{}: {error}", path.display()),
    };
    for descriptor in descriptors {
        let descriptor = match descriptor {
            Ok(descriptor) => descriptor,
            Err(error) if gone(&error) => continue,
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => return Some(true),
            Err(error) => panic!("{}: {error}", path.display()),
        };
        match std::fs::read_link(descriptor.path()) {
            Ok(_) => (),
            Err(error) if gone(&error) => (),
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => return Some(true),
            Err(error) => panic!("{}: {error}", descriptor.path().display()),
        }
    }
    Some(false)
}

fn is_descendant(mut pid: u32) -> Option<bool> {
    let mut seen = BTreeSet::new();
    while pid != 0 {
        if pid == std::process::id() {
            return Some(true);
        }
        assert!(seen.insert(pid), "cycle in process ancestry at pid {pid}");
        let status = match std::fs::read_to_string(format!("/proc/{pid}/status")) {
            Ok(status) => status,
            Err(error) if gone(&error) => return None,
            Err(error) => panic!("cannot establish ancestry of pid {pid}: {error}"),
        };
        pid = status
            .lines()
            .find_map(|line| line.strip_prefix("PPid:"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
    }
    Some(false)
}

pub fn unrelated_unreadable_pids() -> Vec<u32> {
    let mut ignored = Vec::new();
    for entry in std::fs::read_dir("/proc").unwrap() {
        let entry = entry.unwrap();
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse().ok())
        else {
            continue;
        };
        if unreadable_same_user(pid) == Some(true) {
            let descendant = is_descendant(pid);
            if descendant != Some(false) {
                continue;
            }
            // Never waive an unreadable helper: it is part of the property
            // under test. Only unrelated host processes may be exempted.
            assert_eq!(
                descendant,
                Some(false),
                "ignored pid must be outside the test process tree"
            );
            ignored.push(pid);
        }
    }
    ignored
}
