import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import packageJson from "../package.json";

test("declares the OpenTUI minimum required by the shared sidebar", () => {
    const sidebar = JSON.parse(
        readFileSync(
            join(
                dirname(Bun.resolveSync("@cortexkit/opencode-sidebar", import.meta.dir)),
                "../package.json",
            ),
            "utf8",
        ),
    ) as { peerDependencies: Record<string, string> };
    for (const name of ["@opentui/core", "@opentui/solid"] as const) {
        expect(packageJson.peerDependencies[name]).toMatch(/^>=\d+\.\d+\.\d+$/);
        expect(
            Bun.semver.satisfies(
                packageJson.peerDependencies[name].slice(2),
                sidebar.peerDependencies[name],
            ),
        ).toBe(true);
        expect(
            Bun.semver.satisfies(
                packageJson.devDependencies[name].slice(1),
                sidebar.peerDependencies[name],
            ),
        ).toBe(true);
    }
});

test("removes obsolete generated JavaScript without removing the current sidebar bundle", () => {
    const stale = join(import.meta.dir, "../src/tui-compiled/obsolete-sidebar.js");
    writeFileSync(stale, "export {};\n");
    try {
        const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "build-tui.ts")], {
            env: { ...process.env, BUN_BE_BUN: "1" },
            stdout: "pipe",
            stderr: "pipe",
        });
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        expect(existsSync(stale)).toBe(false);
        expect(existsSync(join(import.meta.dir, "../src/tui-compiled/quota-sidebar.js"))).toBe(
            true,
        );
    } finally {
        rmSync(stale, { force: true });
    }
}, 120_000);
