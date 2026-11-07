// Test-isolation guard — runs ONCE before any test file is imported (wired via
// bunfig.toml `[test] preload`). It forces XDG data and config homes to one
// throwaway temp tree for the whole test process.
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
// fail-closing every running v25 binary. Separately, #388 found that a
// fixture-scoped test could resolve the user's real embedding endpoint and
// model through the user config tier.
//
// Redirecting both homes here makes it STRUCTURALLY impossible for any test —
// current or future, isolated or not — to read production storage or user-tier
// config. Tests that set their own XDG_DATA_HOME or XDG_CONFIG_HOME still work
// because they override the preload root per test.
import { afterAll, afterEach } from "bun:test";
import { findTestStorageLeaks } from "./src/shared/test-storage-leak-guard";
import {
    createTestTempDir,
    installTestTempDirCleanup,
    sweepStaleTestTempDirs,
} from "./src/shared/test-temp-dir";
import { __setLocalEmbeddingPoolingTestFallback } from "./src/features/magic-context/memory/local-embedding-pooling";
import { resetReusableWorkersForTests } from "./src/shared/reusable-worker";

// Pooled threads and idle timers must not outlive the test that created them.
afterEach(resetReusableWorkersForTests);

// Retry cleanup from interrupted earlier runs before creating this process's root.
// `bun test --parallel` launches separate worker processes, so include the PID to
// keep each live storage root visibly process-scoped.
sweepStaleTestTempDirs();
installTestTempDirCleanup((cleanup) =>
    afterAll(async () => {
        await resetReusableWorkersForTests();
        cleanup();
    }),
);
const { dir: isolatedDataHome } = createTestTempDir("mc-plugin-test-xdg-pid-", `${process.pid}-`);

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
// Config resolution reads <XDG_CONFIG_HOME>/cortexkit/magic-context.jsonc.
// Keep it in the same throwaway tree so fixture-scoped loads cannot inherit a
// developer's embedding destination or credentials from the real user tier.
process.env.XDG_CONFIG_HOME = isolatedDataHome;
process.env.XDG_STATE_HOME = isolatedDataHome;

// Provider tests use fake model IDs; treat those fixtures as legacy mean models
// unless a test explicitly installs declared pooling metadata.
__setLocalEmbeddingPoolingTestFallback({
    status: "ready",
    pooling: "mean",
    normalize: true,
    declared: false,
    reason: "test fixture has no sentence-transformers pooling metadata",
});

afterAll(() => {
    const violations = findTestStorageLeaks(process.cwd());
    if (violations.length > 0) {
        throw new Error(`Test storage leaked into the package directory:\n${violations.join("\n")}`);
    }
});
