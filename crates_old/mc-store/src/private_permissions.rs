//! Owner-only filesystem operations for MC-owned persistent files.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct TightenReport {
    pub tightened: usize,
    pub failures: usize,
}

/// Create a directory hierarchy with 0700 creation modes when private storage is enabled.
pub fn ensure_directory(path: &Path, private: bool) -> io::Result<()> {
    if !private {
        return fs::create_dir_all(path);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true).mode(0o700).create(path)
    }
    #[cfg(not(unix))]
    {
        fs::create_dir_all(path)
    }
}

/// Create one new directory, refusing to adopt an existing path.
pub fn create_directory(path: &Path, private: bool) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    if private {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)
}

/// Create a new file without following an existing path, with 0600 from creation.
pub fn create_file(path: &Path, private: bool) -> io::Result<File> {
    if let Some(parent) = path.parent() {
        ensure_directory(parent, private)?;
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    if private {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// Replace a file's bytes, creating a new destination with an owner-only mode.
pub fn write_file(path: &Path, bytes: &[u8], private: bool) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        ensure_directory(parent, private)?;
    }
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    if private {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?.write_all(bytes)
}

/// Write a file through a private sibling and publish it by rename.
pub fn write_file_atomic(path: &Path, bytes: &[u8], private: bool) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        ensure_directory(parent, private)?;
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
            ".{name}.{}.{}.{}.tmp",
            std::process::id(),
            stamp,
            attempt
        ));
        let mut file = match create_file(&temporary, private) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        };
        if let Err(error) = file.write_all(bytes).and_then(|()| file.sync_all()) {
            drop(file);
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
        drop(file);
        match fs::rename(&temporary, path) {
            Ok(()) => return Ok(()),
            Err(error) => {
                let _ = fs::remove_file(&temporary);
                return Err(error);
            }
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not allocate a private temporary file",
    ))
}

/// Tighten one storage root to owner-only without changing its children.
pub fn tighten_directory(path: &Path, private: bool) -> TightenReport {
    if !private || !cfg!(unix) {
        return TightenReport::default();
    }
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => {
            return TightenReport {
                tightened: 0,
                failures: 1,
            }
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return TightenReport {
            tightened: 0,
            failures: 1,
        };
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o777 != 0o700 {
            return match fs::set_permissions(path, fs::Permissions::from_mode(0o700)) {
                Ok(()) => TightenReport {
                    tightened: 1,
                    failures: 0,
                },
                Err(_) => TightenReport {
                    tightened: 0,
                    failures: 1,
                },
            };
        }
    }
    TightenReport::default()
}

/// Tighten an existing private storage tree without following symlinks.
pub fn tighten_tree(root: &Path, private: bool) -> TightenReport {
    if !private || !cfg!(unix) {
        return TightenReport::default();
    }
    let mut report = TightenReport::default();
    visit(root, &mut report);
    report
}

fn visit(path: &Path, report: &mut TightenReport) {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => {
            report.failures += 1;
            return;
        }
    };
    let kind = metadata.file_type();
    if kind.is_symlink() {
        return;
    }
    let mode = if kind.is_dir() { 0o700 } else { 0o600 };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o777 != mode {
            match fs::set_permissions(path, fs::Permissions::from_mode(mode)) {
                Ok(()) => report.tightened += 1,
                Err(_) => report.failures += 1,
            }
        }
    }
    if !kind.is_dir() {
        return;
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn permissions(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[cfg(unix)]
    #[test]
    fn storage_creators_and_startup_tightening_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let root = std::env::temp_dir()
            .join("magic-context")
            .join(format!("owner-only-rust-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let storage = root.join("data/cortexkit/magic-context");
        ensure_directory(&storage, true).unwrap();
        let file = storage.join("new-state.json");
        create_file(&file, true).unwrap();
        let atomic = storage.join("atomic-state.json");
        write_file_atomic(&atomic, b"private\n", true).unwrap();
        assert_eq!(permissions(&storage), 0o700);
        assert_eq!(permissions(&file), 0o600);
        assert_eq!(permissions(&atomic), 0o600);

        let wide_dir = storage.join("legacy");
        fs::create_dir(&wide_dir).unwrap();
        fs::set_permissions(&wide_dir, fs::Permissions::from_mode(0o755)).unwrap();
        let wide_file = wide_dir.join("old.txt");
        fs::write(&wide_file, b"fixture").unwrap();
        fs::set_permissions(&wide_file, fs::Permissions::from_mode(0o644)).unwrap();
        let report = tighten_tree(&storage, true);

        assert_eq!(permissions(&wide_dir), 0o700);
        assert_eq!(permissions(&wide_file), 0o600);
        assert_eq!(report.tightened, 2);
        assert_eq!(report.failures, 0);
        fs::remove_dir_all(root).unwrap();
    }
}
