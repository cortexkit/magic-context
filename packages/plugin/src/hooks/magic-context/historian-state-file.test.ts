import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
    cleanupHistorianStateFile,
    HISTORIAN_STATE_INLINE_THRESHOLD,
    maybeWriteHistorianStateFile,
} from "./historian-state-file";

let tempProjectDir: string;

beforeEach(() => {
    tempProjectDir = mkdtempSync(path.join(os.tmpdir(), "mc-historian-state-test-"));
});

afterEach(() => {
    rmSync(tempProjectDir, { recursive: true, force: true });
});

describe("maybeWriteHistorianStateFile", () => {
    test("returns undefined when state is small enough to inline", () => {
        // Below threshold means caller should inline, not offload. Avoids
        // unnecessary FS writes for short prompts that fit comfortably in the
        // HTTP body.
        const small = "x".repeat(HISTORIAN_STATE_INLINE_THRESHOLD - 1);
        expect(maybeWriteHistorianStateFile("ses_abc", small, tempProjectDir)).toBeUndefined();
    });

    test("returns undefined exactly at threshold (only larger triggers offload)", () => {
        const atThreshold = "x".repeat(HISTORIAN_STATE_INLINE_THRESHOLD);
        expect(
            maybeWriteHistorianStateFile("ses_abc", atThreshold, tempProjectDir),
        ).toBeUndefined();
    });

    test("writes large state to <project>/.opencode/magic-context/historian/", () => {
        // The whole point of the project-local move: OpenCode's
        // external_directory permission system trusts paths inside the project
        // boundary. Confirm the file lands under .opencode/magic-context/historian/.
        const big = "y".repeat(HISTORIAN_STATE_INLINE_THRESHOLD + 1);
        const stateFile = maybeWriteHistorianStateFile("ses_abc", big, tempProjectDir);
        expect(stateFile).toBeDefined();
        expect(stateFile!).toContain(
            path.join(tempProjectDir, ".opencode", "magic-context", "historian"),
        );
        expect(stateFile!).toContain("state-ses_abc-");
        expect(stateFile!).toMatch(/\.xml$/);
        expect(existsSync(stateFile!)).toBe(true);
        expect(readFileSync(stateFile!, "utf8")).toBe(big);
    });

    test("creates .opencode/magic-context/historian/ recursively on fresh project", () => {
        // Fresh projects have no .opencode/ subtree at all. The helper must
        // mkdir -p so it works without any prior setup.
        expect(existsSync(path.join(tempProjectDir, ".opencode"))).toBe(false);
        const big = "z".repeat(HISTORIAN_STATE_INLINE_THRESHOLD + 1);
        const stateFile = maybeWriteHistorianStateFile("ses_def", big, tempProjectDir);
        expect(stateFile).toBeDefined();
        expect(
            existsSync(path.join(tempProjectDir, ".opencode", "magic-context", "historian")),
        ).toBe(true);
    });

    test("returns undefined when directory is not writable (degrades gracefully)", () => {
        // Caller falls back to inline when offload fails. Tests with a path
        // that cannot be created — using a non-existent parent under a
        // read-only ancestor would be unreliable across OSes, so we instead
        // pass a path that fails on mkdir by using a regular file as the
        // project directory.
        const fileAsProject = path.join(tempProjectDir, "not-a-dir.txt");
        require("node:fs").writeFileSync(fileAsProject, "");
        const big = "w".repeat(HISTORIAN_STATE_INLINE_THRESHOLD + 1);
        expect(maybeWriteHistorianStateFile("ses_xyz", big, fileAsProject)).toBeUndefined();
    });
});

describe("cleanupHistorianStateFile", () => {
    test("removes the file when present", () => {
        const big = "a".repeat(HISTORIAN_STATE_INLINE_THRESHOLD + 1);
        const stateFile = maybeWriteHistorianStateFile("ses_ghi", big, tempProjectDir)!;
        expect(existsSync(stateFile)).toBe(true);
        cleanupHistorianStateFile(stateFile);
        expect(existsSync(stateFile)).toBe(false);
    });

    test("is safe to call with undefined", () => {
        expect(() => cleanupHistorianStateFile(undefined)).not.toThrow();
    });

    test("is safe to call when the file does not exist", () => {
        // Best-effort cleanup — race between two concurrent runs or a manually
        // deleted file must not crash the finally{} block in callers.
        expect(() =>
            cleanupHistorianStateFile(path.join(tempProjectDir, "nonexistent.xml")),
        ).not.toThrow();
    });
});
