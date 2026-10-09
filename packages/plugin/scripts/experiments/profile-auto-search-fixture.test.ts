import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestTempDirFromPath } from "../../src/shared/test-temp-dir";

const root = join(tmpdir(), "magic-context", "auto-search-deadline");
mkdirSync(root, { recursive: true });
const outside = join(createTestTempDirFromPath(join(root, "log-guard-")), "outside.log");
const driver = fileURLToPath(new URL("./profile-auto-search-fixture.ts", import.meta.url));

test("synthetic profiler resolves its default logger inside the private fixture root", () => {
    const result = spawnSync(process.execPath, [driver, "--check-log-path"], { encoding: "utf8", timeout: 20000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("fixture-log-containment passed (1 check)");
});

test("synthetic profiler refuses a resolved logger outside its private fixture root", () => {
    const result = spawnSync(process.execPath, [driver, "--check-log-path", `--log-path=${outside}`], { encoding: "utf8", timeout: 20000 });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("fixture-log-containment: logger path must stay under its throwaway root");
});
