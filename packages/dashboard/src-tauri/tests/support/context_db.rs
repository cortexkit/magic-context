use std::path::Path;
use std::process::Command;

/// Build the shared schema through its TypeScript owner, in a throwaway test directory.
pub fn create_test_context_db(path: &Path) {
    let directory = path
        .parent()
        .expect("test database needs a parent directory");
    let output = Command::new("bun")
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../plugin"))
        .args([
            "--eval",
            "import { Database } from './src/shared/sqlite'; import { initializeDatabase } from './src/features/magic-context/storage-db'; import { runMigrations } from './src/features/magic-context/migrations'; const db = new Database(process.env.DASHBOARD_TEST_CONTEXT_DB); initializeDatabase(db); runMigrations(db); db.close();",
        ])
        .env("DASHBOARD_TEST_CONTEXT_DB", path)
        .env("HOME", directory)
        .env("XDG_DATA_HOME", directory)
        .env("XDG_CONFIG_HOME", directory)
        .env("XDG_STATE_HOME", directory)
        .env("MAGIC_CONTEXT_STORAGE_DIR", directory)
        .env_remove("OPENCODE_DB")
        .output()
        .expect("run the TypeScript schema fixture");
    assert!(
        output.status.success(),
        "schema fixture failed: {}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
