//! Owner-only files and permission tightening without following symlinks.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Default)]
pub struct TightenReport {
    pub tightened: usize,
    pub failures: usize,
}

/// Publish through a private sibling so readers never see a partial descriptor.
pub fn write_file_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(parent)?;
    }
    let name = path
        .file_name()
        .unwrap_or_else(|| std::ffi::OsStr::new("storage"))
        .to_string_lossy();
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    for attempt in 0..16u8 {
        let temporary = path.with_file_name(format!(
            ".{name}.{}.{stamp}.{attempt}.tmp",
            std::process::id()
        ));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = match options.open(&temporary) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        };
        let result = file.write_all(bytes).and_then(|()| file.sync_all());
        drop(file);
        let result = result.and_then(|()| fs::rename(&temporary, path));
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        return result;
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not allocate a private temporary file",
    ))
}

/// Tighten an existing log tree to 0700 directories and 0600 files on Unix.
pub fn tighten_tree(root: &Path) -> TightenReport {
    let mut report = TightenReport::default();
    #[cfg(unix)]
    visit(root, &mut report);
    #[cfg(not(unix))]
    let _ = root;
    report
}

#[cfg(unix)]
fn visit(path: &Path, report: &mut TightenReport) {
    use std::os::unix::fs::PermissionsExt;
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => {
            report.failures += 1;
            return;
        }
    };
    if metadata.file_type().is_symlink() {
        return;
    }
    let mode = if metadata.is_dir() { 0o700 } else { 0o600 };
    if metadata.permissions().mode() & 0o777 != mode {
        match fs::set_permissions(path, fs::Permissions::from_mode(mode)) {
            Ok(()) => report.tightened += 1,
            Err(_) => report.failures += 1,
        }
    }
    if metadata.is_dir() {
        match fs::read_dir(path) {
            Ok(entries) => {
                for entry in entries {
                    match entry {
                        Ok(entry) => visit(&entry.path(), report),
                        Err(_) => report.failures += 1,
                    }
                }
            }
            Err(_) => report.failures += 1,
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    #[test]
    fn logs_are_tightened_without_following_symlinks() {
        let root = tempfile::tempdir().unwrap();
        let logs = root.path().join("logs");
        fs::create_dir(&logs).unwrap();
        fs::set_permissions(&logs, fs::Permissions::from_mode(0o755)).unwrap();
        let log = logs.join("log.jsonl");
        fs::write(&log, b"private").unwrap();
        fs::set_permissions(&log, fs::Permissions::from_mode(0o644)).unwrap();
        let outside = root.path().join("outside");
        fs::write(&outside, b"untouched").unwrap();
        fs::set_permissions(&outside, fs::Permissions::from_mode(0o644)).unwrap();
        symlink(&outside, logs.join("link")).unwrap();
        let report = tighten_tree(&logs);
        assert_eq!((report.tightened, report.failures), (2, 0));
        assert_eq!(
            fs::metadata(log).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(logs).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(outside).unwrap().permissions().mode() & 0o777,
            0o644
        );
    }
}
