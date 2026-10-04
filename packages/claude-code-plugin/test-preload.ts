// Test-isolation guard — runs ONCE before any test file is imported (wired via
// bunfig.toml `[test] preload`). Forces XDG data and config homes to one
// throwaway temp tree so NO test can read or migrate the user's real shared
// cortexkit DB (~/.local/share/cortexkit/magic-context/context.db), which this
// plugin shares with OpenCode and Pi. See the OpenCode plugin's test-preload.ts
// for the full rationale (2026-06-01 incident). Do not remove.
//
// The isolated user config turns embeddings off: with the default local provider a
// test would load Transformers.js from node_modules and download a model.
//
// Claude Code specifics: the tests read transcripts from `CLAUDE_CONFIG_DIR`,
// which is pointed at the same temp tree so no test sees the user's real
// sessions under ~/.claude. The suite may itself run inside a Claude Code
// session, whose CLAUDE_CODE_SESSION_ID and CLAUDE_PROJECT_DIR would otherwise
// leak into every default-env code path.
import { afterAll } from "bun:test";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    createTestTempDir,
    installTestTempDirCleanup,
    sweepStaleTestTempDirs,
} from "@magic-context/core/shared/test-temp-dir";

sweepStaleTestTempDirs();
installTestTempDirCleanup(afterAll);
const { dir: isolatedHome } = createTestTempDir("mc-claude-code-test-xdg-");

// Bulletproof DB guard (see @magic-context/core resolveDatabasePath): never
// mutated by any test, so a bare openDatabase() can never reach the real DB.
process.env.MAGIC_CONTEXT_TEST_DATA_DIR = isolatedHome;
process.env.XDG_DATA_HOME = isolatedHome;
process.env.XDG_CONFIG_HOME = isolatedHome;
process.env.CLAUDE_CONFIG_DIR = join(isolatedHome, "claude");
mkdirSync(join(isolatedHome, "claude", "projects"), { recursive: true });
mkdirSync(join(isolatedHome, "cortexkit"), { recursive: true });
writeFileSync(
    join(isolatedHome, "cortexkit", "magic-context.jsonc"),
    '{ "embedding": { "provider": "off" } }\n',
);
// Session hand-off records and the log live under the OS temp dir.
process.env.TMPDIR = join(isolatedHome, "tmp");
mkdirSync(process.env.TMPDIR, { recursive: true });
delete process.env.MAGIC_CONTEXT_LOG_PATH;
delete process.env.MAGIC_CONTEXT_STORAGE_DIR;
delete process.env.CLAUDE_CODE_SESSION_ID;
delete process.env.CLAUDE_PROJECT_DIR;
delete process.env.CLAUDE_PID;

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
        throw new Error(`Test storage leaked into the package directory:\n${violations.join("\n")}`);
    }
});
