import { expect, it } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { restoreEnvironmentVariable } from "./root-environment";
import { cleanupE2ETempDir, createE2ETempDir } from "./temp-dir";

it("removes e2e fixtures by default and retains them only on explicit request", () => {
    const previous = process.env.MC_E2E_KEEP;
    const root = createE2ETempDir("mc-e2e-cleanup-test-");
    const retained = createE2ETempDir("mc-e2e-keep-test-");
    try {
        delete process.env.MC_E2E_KEEP;
        cleanupE2ETempDir(root);
        expect(existsSync(root)).toBe(false);
        process.env.MC_E2E_KEEP = "1";
        cleanupE2ETempDir(retained);
        expect(existsSync(retained)).toBe(true);
    } finally {
        if (previous === undefined) delete process.env.MC_E2E_KEEP;
        else process.env.MC_E2E_KEEP = previous;
        cleanupE2ETempDir(root);
        rmSync(retained, { recursive: true, force: true });
    }
});

it("rejects missing or stringified TMPDIR before creating a fixture", () => {
    const previous = process.env.TMPDIR;
    try {
        for (const value of [undefined, "undefined"]) {
            restoreEnvironmentVariable("TMPDIR", value);
            expect(() => createE2ETempDir("must-not-exist-")).toThrow(/TMPDIR.*earlier test file/);
        }
    } finally {
        restoreEnvironmentVariable("TMPDIR", previous);
    }
});

it("restores an unset variable without stringifying undefined", () => {
    const env: NodeJS.ProcessEnv = { TMPDIR: "/current" };
    restoreEnvironmentVariable("TMPDIR", undefined, env);
    expect(Object.hasOwn(env, "TMPDIR")).toBe(false);
    restoreEnvironmentVariable("TMPDIR", "/previous", env);
    expect(env.TMPDIR).toBe("/previous");
});

it("attributes a root leak to its file after cleanup and protects the next file", () => {
    const root = createE2ETempDir("mc-e2e-per-file-guard-");
    const files = ["a-restored.test.ts", "b-leak.test.ts", "c-next.test.ts"];
    try {
        writeFileSync(join(root, files[0]!), `
import { afterAll, test } from "bun:test";
const previous = process.env.TMPDIR;
process.env.TMPDIR = "undefined";
afterAll(() => { process.env.TMPDIR = previous; });
test("file restores its roots in cleanup", () => {});
`);
        writeFileSync(join(root, files[1]!), `
import { test } from "bun:test";
process.env.TMPDIR = "undefined";
delete process.env.XDG_DATA_HOME;
test("file leaks two roots at module scope", () => {});
`);
        writeFileSync(join(root, files[2]!), `
import { expect, test } from "bun:test";
test("next file still has its original roots", () => {
    expect(process.env.TMPDIR).toBe(${JSON.stringify(root)});
    expect(process.env.XDG_DATA_HOME).toBe(${JSON.stringify(root)});
});
`);
        const child = Bun.spawnSync([
            process.execPath, "test", "--preload", join(import.meta.dir, "test-preload.ts"), ...files,
        ], { cwd: root, env: { ...process.env, TMPDIR: root, XDG_DATA_HOME: root, GITHUB_ACTIONS: "" } });
        const out = child.stderr.toString();
        expect(child.exitCode).toBe(1);
        expect(out).toContain("b-leak.test.ts did not restore E2E root environment: TMPDIR, XDG_DATA_HOME");
        expect(out).not.toContain("a-restored.test.ts did not restore");
        expect(out).toContain("(pass) next file still has its original roots");
    } finally {
        cleanupE2ETempDir(root);
    }
});
