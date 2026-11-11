//! One throwaway home for every integration test in this folder.
//!
//! The dashboard library finds its stores (Magic Context's `context.db`, the
//! user's OpenCode store, the CortexKit runner's `roots.json`, the user
//! config, Pi and Claude Code session folders) from `XDG_*` variables,
//! `MAGIC_CONTEXT_STORAGE_DIR` and, when those are unset, the home folder.
//! Integration tests link the library as it is built for normal use, so the
//! library's own test-only guards (`cfg!(test)`) are off here. Without this
//! helper a test would read the stores of whoever runs it.
//!
//! Every test calls `isolated_home()` as its first statement (the
//! `home_isolation` test checks this). The first call in the test process
//! creates one temporary folder and points every variable the library reads
//! at it. Calls from other test threads wait for that and get the same
//! folder. A test may still set its own folders on top and restore them
//! afterwards; what it restores to is this throwaway home.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Variables that would point the library at a real folder; they are cleared.
const CLEARED: &[&str] = &[
    "OPENCODE_DB",
    "OPENCODE_CHANNEL",
    "OPENCODE_DISABLE_CHANNEL_DB",
    "PI_CODING_AGENT_DIR",
    "PI_CONFIG_DIR",
    "PI_PACKAGE_DIR",
    "PI_PROFILE",
    "OMP_PROFILE",
    "BROCA_STATE_ROOT",
    "BROCA_WAL_COPY_ROOT",
    "MAGIC_CONTEXT_LOG_PATH",
    // Unset, Magic Context's store is looked for under XDG_DATA_HOME.
    "MAGIC_CONTEXT_STORAGE_DIR",
];

/// The throwaway home every test in this process runs in.
pub fn isolated_home() -> &'static Path {
    static HOME: OnceLock<PathBuf> = OnceLock::new();
    HOME.get_or_init(|| {
        // Kept until the machine clears its temporary folder: tests run on
        // threads that may still read it while the process exits.
        let root = tempfile::Builder::new()
            .prefix("mc-dashboard-test-home-")
            .tempdir()
            .expect("create the throwaway test home")
            .keep();
        let folder = |name: &str| {
            let path = root.join(name);
            std::fs::create_dir_all(&path).expect("create a throwaway test folder");
            path
        };
        for (variable, path) in [
            ("HOME", root.clone()),
            ("USERPROFILE", root.clone()),
            ("APPDATA", folder("appdata")),
            ("LOCALAPPDATA", folder("localappdata")),
            ("XDG_DATA_HOME", folder("data")),
            ("XDG_CONFIG_HOME", folder("config")),
            ("XDG_STATE_HOME", folder("state")),
        ] {
            std::env::set_var(variable, path);
        }
        for variable in CLEARED {
            std::env::remove_var(variable);
        }
        root
    })
}
