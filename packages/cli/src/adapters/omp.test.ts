import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OmpAdapter } from "./omp";

const original = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
};
const roots: string[] = [];

afterEach(() => {
    for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("OmpAdapter", () => {
    it("detects an enabled Magic Context plugin from omp plugin list", () => {
        const root = mkdtempSync(join(tmpdir(), "mc-omp-adapter-"));
        roots.push(root);
        const bin = join(root, "bin");
        mkdirSync(bin, { recursive: true });
        const omp = join(bin, "omp");
        writeFileSync(
            omp,
            `#!/bin/sh
if [ "$1 $2 $3" = "plugin list --json" ]; then
  printf '%s' '{"npm":[{"name":"@cortexkit/pi-magic-context","version":"0.33.0","enabled":true}],"marketplace":[]}'
fi
`,
            { mode: 0o755 },
        );
        process.env.PATH = bin;
        process.env.HOME = root;
        delete process.env.XDG_DATA_HOME;

        const adapter = new OmpAdapter();
        expect(adapter.isInstalled()).toBe(true);
        expect(adapter.hasPluginEntry()).toBe(true);
        expect(adapter.getInstalledPluginVersion()).toBe("0.33.0");
    });
});
