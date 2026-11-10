import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test.each([
    null,
    "dist/\r\n",
    ".cortexkit/magic-context/\n",
])("setup leaves repository gitignore untouched (%j)", async (existing) => {
    const dir = createTestTempDirFromPath(join(tmpdir(), "mc-setup-ignore-"));
    dirs.push(dir);
    const init = Bun.spawn(["git", "init", "-q"], {
        cwd: dir,
        windowsHide: true,
        stdout: "pipe",
        stderr: "pipe",
    });
    expect(await init.exited).toBe(0);
    const ignorePath = join(dir, ".gitignore");
    if (existing !== null) writeFileSync(ignorePath, existing);
    const source = fileURLToPath(new URL(".", import.meta.url));
    // Isolate module mocks so the real host setup tests keep their dependencies.
    const script = `
            import { mock } from "bun:test";
            const source = ${JSON.stringify(source)};
            const noop = () => {};
            mock.module(source + "../lib/prompts.ts", () => ({ intro: noop, outro: noop, note: noop,
                log: { info: noop, warn: noop, error: noop, step: noop } }));
            mock.module(source + "../lib/harness-select.ts", () => ({ resolveAdaptersForCommand: async () =>
                [{ kind: "pi", displayName: "Pi", pluginPackageName: "test-plugin" }] }));
            mock.module(source + "../lib/dashboard-install.ts", () => ({ offerDashboardInstall: async () => {} }));
            mock.module(source + "doctor-store.ts", () => ({ runDoctorStoreInit: () => 0 }));
            let configured = 0;
            for (const name of ["setup-pi", "setup-omp", "setup-opencode"]) {
                mock.module(source + name + ".ts", () => ({ runSetup: async () => { configured++; return 0; } }));
            }
            const { runSetup } = await import(source + "setup.ts");
            console.log("setup-result", await runSetup(["--harness", "pi", "--no-dashboard"]), configured);
        `;
    const child = Bun.spawn([process.execPath, "--eval", script], {
        cwd: dir,
        windowsHide: true,
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
    });
    const [output, errors, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]);
    expect(errors).toBe("");
    expect(code).toBe(0);
    expect(output).toContain("setup-result 0 1");
    if (existing === null) expect(existsSync(ignorePath)).toBe(false);
    else expect(readFileSync(ignorePath)).toEqual(Buffer.from(existing));
    expect(existsSync(join(dir, ".cortexkit"))).toBe(false);
});
