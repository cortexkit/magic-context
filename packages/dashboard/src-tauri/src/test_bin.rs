//! Test-only helper for fake executables (shell stubs standing in for opencode,
//! omp, ...).
//!
//! macOS runs a malware assessment the first time any new executable file is
//! launched. Writing a fresh stub into a fresh temp directory for every test
//! therefore triggers one assessment per test per run. Instead, each distinct
//! stub lives at a fixed, content-addressed path and is written only once;
//! later tests and later runs reuse the same file.
//!
//! Callers must never delete these files and must never modify one in place: a
//! test that needs a stub to "change" between steps asks for a second stub with
//! different content, which lands at a different path. The TypeScript suites
//! share the same root through `writeTestExecutable`.

use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Directory name under the OS temp dir that holds every shared fake executable.
pub const TEST_EXECUTABLE_ROOT_NAME: &str = "magic-context-test-bin";

pub fn test_executable_root() -> PathBuf {
    std::env::temp_dir().join(TEST_EXECUTABLE_ROOT_NAME)
}

fn assert_single_segment(label: &str, value: &str, allow_empty: bool) {
    assert!(
        (allow_empty || !value.is_empty()) && value != "." && value != "..",
        "write_test_executable: invalid {label} {value:?}"
    );
    assert!(
        !value.contains(['/', '\\', '\0']),
        "write_test_executable: {label} must be a single path segment"
    );
}

fn has_expected_content(path: &Path, content: &str) -> bool {
    match fs::read(path) {
        Ok(bytes) if bytes == content.as_bytes() => is_executable(path),
        _ => false,
    }
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path)
        .map(|meta| meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(_path: &Path) -> bool {
    // Windows has no executable bit, so content alone decides there.
    true
}

#[cfg(unix)]
fn make_executable(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Writes `content` to the new file `path` without this process ever holding a
/// handle open for writing on it.
///
/// Linux refuses to execute a file that any process has open for writing
/// ("Text file busy"). Tests run on parallel threads, and a thread that spawns
/// a subprocess while another thread is writing a stub passes a copy of that
/// write handle to its child, which keeps it until the child's own exec. The
/// writing thread can close the file, rename it and try to run it inside that
/// window, and the run fails. A helper process does the writing instead, so
/// no thread of this process has a write handle to leak.
#[cfg(unix)]
fn write_staged(path: &Path, content: &str) -> std::io::Result<()> {
    use std::process::{Command, Stdio};
    let mut writer = Command::new("/bin/sh")
        .args(["-c", "cat > \"$1\"", "sh"])
        .arg(path)
        .stdin(Stdio::piped())
        .spawn()?;
    let mut input = writer.stdin.take().expect("piped stdin");
    input.write_all(content.as_bytes())?;
    // Closing the pipe ends `cat`; the file is closed when the helper exits.
    drop(input);
    let status = writer.wait()?;
    if !status.success() {
        return Err(std::io::Error::other(format!(
            "stub writer exited with {status}"
        )));
    }
    Ok(())
}

#[cfg(not(unix))]
fn write_staged(path: &Path, content: &str) -> std::io::Result<()> {
    let mut file = fs::File::create(path)?;
    file.write_all(content.as_bytes())?;
    file.sync_all()
}

/// Returns the path of an executable named `name` whose bytes are `content`,
/// creating it only when no identical file exists yet. The path is
/// `<temp>/magic-context-test-bin/<dir_prefix><first 16 hex of sha256(name, content)>/<name>`,
/// so each directory holds exactly one executable.
///
/// The file is written to a unique temporary name in the same directory and
/// then renamed into place, so concurrent test processes never observe a
/// half-written stub.
pub fn write_test_executable(name: &str, content: &str, dir_prefix: &str) -> PathBuf {
    assert_single_segment("name", name, false);
    assert_single_segment("dir_prefix", dir_prefix, true);

    // The NUL separator keeps ("ab", "c") and ("a", "bc") from sharing a hash;
    // it matches the TypeScript helper so both languages agree on paths.
    let mut hasher = Sha256::new();
    hasher.update(name.as_bytes());
    hasher.update([0u8]);
    hasher.update(content.as_bytes());
    let hash: String = hasher
        .finalize()
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect();

    let dir = test_executable_root().join(format!("{dir_prefix}{hash}"));
    let target = dir.join(name);
    if has_expected_content(&target, content) {
        return target;
    }

    fs::create_dir_all(&dir).expect("create test executable dir");
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.subsec_nanos())
        .unwrap_or(0);
    let staging = dir.join(format!(
        ".{name}.{}.{}.{nanos}.tmp",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let written = (|| -> std::io::Result<()> {
        write_staged(&staging, content)?;
        make_executable(&staging)?;
        fs::rename(&staging, &target)
    })();
    if let Err(error) = written {
        let _ = fs::remove_file(&staging);
        // Another process may have won the race with identical bytes (Windows
        // refuses to rename over a file that is currently open).
        assert!(
            has_expected_content(&target, content),
            "write test executable {}: {error}",
            target.display()
        );
    }
    target
}

#[cfg(test)]
mod tests {
    use super::*;

    const STUB: &str = "#!/bin/sh\necho test-bin-helper\n";

    // Each test uses its own stub name: cargo runs tests on parallel threads,
    // and two threads creating the same stub for the first time would both
    // write it, which is harmless but would break the mtime assertion.

    #[test]
    fn reuses_the_same_file_for_the_same_name_and_content() {
        let first = write_test_executable("reuse-stub", STUB, "");
        let before = fs::metadata(&first).unwrap().modified().unwrap();
        let second = write_test_executable("reuse-stub", STUB, "");
        assert_eq!(first, second);
        assert_eq!(fs::metadata(&second).unwrap().modified().unwrap(), before);
        assert_eq!(fs::read_to_string(&first).unwrap(), STUB);
        assert!(is_executable(&first));
        assert_eq!(
            first.parent().unwrap().parent().unwrap(),
            test_executable_root()
        );
        let entries: Vec<_> = fs::read_dir(first.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(entries, vec![std::ffi::OsString::from("reuse-stub")]);
    }

    #[test]
    fn distinct_content_or_prefix_gives_a_distinct_directory() {
        let base = write_test_executable("helper-stub", STUB, "");
        let other = write_test_executable("helper-stub", "#!/bin/sh\nexit 0\n", "");
        let prefixed = write_test_executable("helper-stub", STUB, "prefix & dir ");
        assert_ne!(base.parent(), other.parent());
        let dir_name = prefixed
            .parent()
            .unwrap()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert!(dir_name.starts_with("prefix & dir "));
        assert_eq!(
            dir_name.trim_start_matches("prefix & dir "),
            base.parent()
                .unwrap()
                .file_name()
                .unwrap()
                .to_string_lossy()
        );
    }
}
