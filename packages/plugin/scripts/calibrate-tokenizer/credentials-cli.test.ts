import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createTestTempDir } from "../../src/shared/test-temp-dir";

function cli(args: string[], env: NodeJS.ProcessEnv = {}) {
    const { dir, cleanup } = createTestTempDir("calibration-credentials-");
    try {
        return spawnSync(process.execPath, ["--preload", join(import.meta.dir, "test-support", "credential-guard.ts"), join(import.meta.dir, "index.ts"), ...args], {
            env: { PATH: process.env.PATH, HOME: dir, USERPROFILE: dir, ...env }, encoding: "utf8", timeout: 30_000, windowsHide: true,
        });
    } finally { cleanup(); }
}

it("never reads credential files under home when environment variables are missing", () => {
    const args = ["--providers", "anthropic,openai,moonshot,zai,xai,google,meta"];
    const result = cli(args);
    expect(result.stderr).not.toContain("credential file read under home");
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("TEST FETCH");
    for (const variable of ["ANTHROPIC_API_KEY or ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY", "MOONSHOT_API_KEY", "ZAI_API_KEY", "XAI_API_KEY", "GEMINI_API_KEY", "META_API_KEY"]) {
        expect(result.stdout.split(`SKIP: set ${variable}`)).toHaveLength(2);
    }
});

it("arms the home-read trap before the calibration entry point loads", () => {
    const probe = cli(["--only", "none"], { MC_TEST_PROBE_GUARD: "1" });
    expect(probe.status).not.toBe(0);
    expect(probe.stderr).toContain("credential file read under home");
});

for (const status of [401, 403, 404]) {
    it(`handles HTTP ${status} at the CLI without exposing provider data or generating`, () => {
        const result = cli(["--only", "claude-fable-5-2,claude-mythos-5-2", "--allow-generation"], { ANTHROPIC_OAUTH_TOKEN: "fake-token", MC_TEST_HTTP_STATUS: String(status) });
        const output = result.stdout + result.stderr;
        expect(output).not.toContain("secret-response");
        expect(output).not.toContain("fake-token");
        expect(result.stdout.match(/TEST FETCH/g)?.length).toBe(status === 404 ? 2 : 1);
        expect(result.status).toBe(status === 404 ? 0 : 1);
        if (status === 404) expect(output).toContain("model not found for this credential");
        else expect(output).toContain(`anthropic claude-fable-5-2 HTTP ${status}`);
        expect(output).not.toContain("https://api.anthropic.com/v1/messages?beta=true");
    });
}
