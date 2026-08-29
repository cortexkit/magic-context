// Test-isolation guard — runs ONCE before any test file is imported (wired via
// bunfig.toml `[test] preload`). It forces XDG_DATA_HOME to a throwaway temp dir
// for the whole test process.
//
// WHY THIS EXISTS: `openDatabase()` with no explicit path resolves the shared
// cortexkit DB through `getDataDir()` = `XDG_DATA_HOME ?? ~/.local/share`. Any
// test that calls bare `openDatabase()` without setting XDG_DATA_HOME therefore
// opens the user's REAL production database
// (~/.local/share/cortexkit/magic-context/context.db). That is harmless only
// while the DB's schema version already equals LATEST_SUPPORTED_VERSION — the
// moment LATEST advances, that test runs the new migration on the user's LIVE
// DB. 2026-06-01 incident: a long-dormant unisolated test migrated the
// production DB to v26 the instant LATEST hit 26, tripping the schema fence and
// fail-closing every running v25 binary.
//
// Redirecting the data home here makes it STRUCTURALLY impossible for any test —
// current or future, isolated or not — to read or migrate production storage.
// Tests that set their own XDG_DATA_HOME still work (they override per-test).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `bun test --parallel` launches separate worker processes. Include the PID so the
// storage root remains visibly process-scoped even if a future Bun version changes
// preload timing or environment inheritance.
const isolatedDataHome = mkdtempSync(join(tmpdir(), `mc-plugin-test-xdg-pid-${process.pid}-`));

// MAGIC_CONTEXT_TEST_DATA_DIR is the BULLETPROOF guard: resolveDatabasePath()
// (storage-db.ts) resolves the DB inside it with top priority. Unlike
// XDG_DATA_HOME it is never mutated by any test (some tests delete
// XDG_DATA_HOME to exercise path fallbacks), so it cannot be defeated and a
// bare openDatabase() can never reach the user's real shared DB.
process.env.MAGIC_CONTEXT_TEST_DATA_DIR = isolatedDataHome;
// Existing tests sometimes replace XDG_DATA_HOME with their own fixture root.
// The resolver uses this marker to distinguish that deliberate fixture switch
// from the untouched real-preload state, where test isolation remains first.
// XDG_DATA_HOME redirects everything ELSE (logs, embedding cache, etc.) for
// tests that don't manipulate it themselves.
process.env.XDG_DATA_HOME = isolatedDataHome;
