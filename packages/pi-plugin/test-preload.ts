// Test-isolation guard — runs ONCE before any test file is imported (wired via
// bunfig.toml `[test] preload`). Forces XDG data and config homes to one
// throwaway temp tree so NO test can read or migrate the user's real shared
// cortexkit DB (~/.local/share/cortexkit/magic-context/context.db), which
// pi-plugin shares with OpenCode via @magic-context/core's `getDataDir()` =
// `XDG_DATA_HOME ?? ~/.local/share`. See the OpenCode plugin's test-preload.ts
// for the full rationale: a 2026-06-01 unisolated test migrated the real DB,
// and #388 found a fixture-scoped test resolving the user's real embedding
// endpoint and model through the user config tier. Per-test XDG_DATA_HOME or XDG_CONFIG_HOME
// fixtures may replace this root, while MAGIC_CONTEXT_STORAGE_DIR can never
// escape test isolation. Do not remove.
import { afterAll, afterEach } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { __setLocalEmbeddingPoolingTestFallback } from "@magic-context/core/features/magic-context/memory/local-embedding-pooling";
import { resetReusableWorkersForTests } from "@magic-context/core/shared/reusable-worker";
import {
	createTestTempDir,
	installTestTempDirCleanup,
	sweepStaleTestTempDirs,
} from "@magic-context/core/shared/test-temp-dir";

// Pooled threads and idle timers must not outlive the test that created them.
afterEach(resetReusableWorkersForTests);

sweepStaleTestTempDirs();
installTestTempDirCleanup((cleanup) =>
	afterAll(async () => {
		await resetReusableWorkersForTests();
		cleanup();
	}),
);
const { dir: isolatedDataHome } = createTestTempDir("mc-pi-test-xdg-");

// Bulletproof DB guard (see @magic-context/core resolveDatabasePath): never
// mutated by any test, so a bare openDatabase() can never reach the real DB.
process.env.MAGIC_CONTEXT_TEST_DATA_DIR = isolatedDataHome;
process.env.XDG_DATA_HOME = isolatedDataHome;
process.env.XDG_CONFIG_HOME = isolatedDataHome;

// Provider fixtures in this package use fake model IDs and retain the legacy mean path.
__setLocalEmbeddingPoolingTestFallback({
	status: "ready",
	pooling: "mean",
	normalize: true,
	declared: false,
	reason: "test fixture has no sentence-transformers pooling metadata",
});

afterAll(() => {
	const packageDir = process.cwd();
	const violations: string[] = [];
	const scan = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "node_modules" || entry.name === ".git") continue;
				if (entry.name === "undefined") violations.push(path);
				scan(path);
			} else if (entry.isFile() && entry.name === "context.db") {
				violations.push(path);
			}
		}
	};
	scan(packageDir);
	if (violations.length > 0) {
		throw new Error(
			`Test storage leaked into the package directory:\n${violations.join("\n")}`,
		);
	}
});
