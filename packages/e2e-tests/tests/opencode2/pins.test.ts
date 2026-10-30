import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pins from "../../src/opencode2-runner/sha256-pins.json";

test("v1_untouched and captured fixture bytes remain sha256 pinned", () => {
	const root = resolve(import.meta.dir, "../../../..");
	// The server entry's version marker is part of host detection and stays pinned.
	// The v1 entry also registers background-only Zen agents. Native primary-request
	// tests verify that those registrations do not affect ordinary prompts or tools.
	// The entry also samples the default-off Rust background switch for the dreamer;
	// it does not select a different primary-request transform. It also passes
	// the moved-session check to the shared hook gate and the RPC guard, which
	// refuse only sessions moved to mode 3; every other session is unchanged.
	for (const [path, expected] of Object.entries(pins)) {
		let bytes = readFileSync(resolve(root, path), "utf8");
		if (path === "packages/plugin/src/index.ts") {
			// The v1 entry shares this file with three v2-only additions: a setup
			// import, a setup type on the plugin object, and its setup property.
			// Remove only those additions so the hash protects v1; retain its version
			// registration because host detection depends on it.
			bytes = bytes
				.replace('import { setup } from "./v2/server";\n', "")
				.replace("PluginModule & { setup: typeof setup }", "PluginModule")
				.replace("    server,\n    setup,", "    server,");
		}
		expect(createHash("sha256").update(bytes).digest("hex"), path).toBe(
			expected,
		);
	}
});


test("native session API release pins agree across CI, Docker and packages", () => {
    const root = resolve(import.meta.dir, "../../../..");
    const read = (path: string) => readFileSync(resolve(root, path), "utf8");
    const plugin = JSON.parse(read("packages/plugin/package.json")).devDependencies;
    const e2e = JSON.parse(read("packages/e2e-tests/package.json")).devDependencies;
    for (const name of ["@opencode/cli", "@opencode/plugin", "@opencode/ai", "@opencode/client"]) {
        expect(plugin[name], name).toBe("2.0.22");
    }
    for (const name of ["@opencode/ai", "@opencode/client"]) expect(e2e[name], name).toBe("2.0.22");
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain("version: [2.0.22, 2.1.0]");
    expect(ci).toContain("bash scripts/ci/e2e-host-opencode2-verify-the-ga-host-binary.sh");
    expect(read("scripts/ci/e2e-host-opencode2-verify-the-ga-host-binary.sh")).toContain("if (version !== 'opencode v' + process.env.MC_E2E_OPENCODE2_VERSION)");
    expect(ci).toContain('bash scripts/ci/e2e-host-opencode2-run-host-e2e-suite-opencode-2-tests-from-mode-manifest.sh "${{ matrix.shard }}"');
    expect(read("scripts/ci/e2e-host-opencode2-run-host-e2e-suite-opencode-2-tests-from-mode-manifest.sh")).toContain('select-host-shard.ts opencode2 "${1:?missing workflow argument}/2"');
    expect(ci).not.toContain("OpenCode 2.0.15");
    const docker = read("tests/docker/opencode2/Dockerfile");
    expect(docker).toContain("ARG OPENCODE2_VERSION=2.0.22");
    for (const name of ["@opencode/cli", "@opencode/cli-linux-x64", "@opencode/client"]) {
        expect(docker).toContain(`${name}@\${OPENCODE2_VERSION}`);
    }
    expect(read("tests/docker/opencode2/run.sh")).toContain("for version in 2.0.22 2.1.0");
    expect(e2e["@opencode/ai-2-1"]).toBe("npm:@opencode/ai@2.1.0");
});
