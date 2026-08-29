// Test-isolation guard — runs ONCE before any test file is imported (wired via
// bunfig.toml `[test] preload`). Forces XDG_DATA_HOME to a throwaway temp dir
// for the whole test process so NO test can read or migrate the user's real
// shared cortexkit DB (~/.local/share/cortexkit/magic-context/context.db),
// which pi-plugin shares with OpenCode via @magic-context/core's
// `getDataDir()` = `XDG_DATA_HOME ?? ~/.local/share`. See the OpenCode plugin's
// test-preload.ts for the full rationale (2026-06-01 incident: a dormant
// unisolated test migrated the production DB to v26 and fail-closed every
// running v25 binary). Per-test XDG_DATA_HOME fixtures may replace this root,
// while MAGIC_CONTEXT_STORAGE_DIR can never escape test isolation. Do not remove.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const isolatedDataHome = mkdtempSync(join(tmpdir(), "mc-pi-test-xdg-"));

// Bulletproof DB guard (see @magic-context/core resolveDatabasePath): never
// mutated by any test, so a bare openDatabase() can never reach the real DB.
process.env.MAGIC_CONTEXT_TEST_DATA_DIR = isolatedDataHome;
process.env.XDG_DATA_HOME = isolatedDataHome;
