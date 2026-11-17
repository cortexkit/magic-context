import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";

const root = createTestTempDirFromPath(join(tmpdir(), "doctor-opencode-fresh-"));
const cli = resolve(import.meta.dir, "../index.ts");
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function doctor(name: string, config: string) {
    const home = join(root, name);
    const bin = join(home, "bin");
    const configDir = join(home, "config");
    // Doctor reads historian dumps and plugin logs under the temp directory.
    // A temp directory inside this test's root keeps it away from files other
    // tests or earlier runs left in the machine's temp directory.
    const tempDir = join(home, "tmp");
    mkdirSync(bin, { recursive: true });
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(configDir, "opencode"), { recursive: true });
    writeFileSync(join(configDir, "opencode", "opencode.json"), config);
    // Only installation discovery needs this executable; no host or provider starts.
    writeFileSync(join(bin, "opencode"), "#!/bin/sh\necho 1.18.31\n", { mode: 0o755 });
    const child = Bun.spawn([process.execPath, cli, "doctor", "--harness", "opencode", "--force"], {
        windowsHide: true,
        env: {
            PATH: `${bin}:${process.env.PATH}`,
            HOME: home,
            XDG_CONFIG_HOME: configDir,
            XDG_DATA_HOME: join(home, "data"),
            XDG_STATE_HOME: join(home, "state"),
            XDG_RUNTIME_DIR: join(home, "runtime"),
            XDG_CACHE_HOME: join(home, "cache"),
            MAGIC_CONTEXT_STORAGE_DIR: join(home, "mc"),
            TMPDIR: tempDir,
            TMP: tempDir,
            TEMP: tempDir,
            // Doctor asks the npm registry for the latest version. Point it at a closed
            // local port so the lookup fails at once: on a busy runner the real
            // registry round trip pushed this spawn past the test timeout.
            npm_config_registry: "http://127.0.0.1:9",
        },
        cwd: home,
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]);
    return { output: stdout + stderr, exitCode };
}

test("fresh unregistered OpenCode needs neither registration nor a first-session database", async () => {
    const result = await doctor("unregistered", "{}");
    expect(result.output).toContain("Magic Context is not installed there (run setup to add it)");
    expect(result.output).toContain("OpenCode session database not yet created");
    expect(result.output).not.toContain("FAIL OpenCode session database");
    expect(result.output).not.toContain("need manual attention");
    expect(result.exitCode).toBe(0);
});

test("registered OpenCode still fails for a missing session database", async () => {
    const result = await doctor(
        "registered",
        JSON.stringify({ plugin: ["@cortexkit/opencode-magic-context"] }),
    );
    expect(result.output).toContain("FAIL OpenCode session database");
    expect(result.output).not.toContain("OpenCode session database not yet created");
});

test("unreadable OpenCode registration still exposes a missing session database", async () => {
    const result = await doctor("unreadable", "{broken");
    expect(result.output).toContain("FAIL OpenCode session database");
    expect(result.output).not.toContain("OpenCode session database not yet created");
});
