import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestTempDir } from "@magic-context/core/shared/test-temp-dir";

const preload = fileURLToPath(new URL("../test-preload.ts", import.meta.url));
const harness = import.meta.resolve("@magic-context/core/shared/harness");
const detection = new URL("./pi-harness-kind.ts", import.meta.url).href;

function runFiles(mutator: string, withOmpUtils = false) {
	const { dir, cleanup } = createTestTempDir("mc-pi-harness-isolation-");
	try {
		const home = join(dir, "home");
		mkdirSync(home);
		const first = join(dir, "01-mutator.test.ts");
		const victim = join(dir, "02-victim.test.ts");
		if (withOmpUtils) {
			const utils = join(dir, "node_modules", "@oh-my-pi", "pi-utils");
			mkdirSync(utils, { recursive: true });
			writeFileSync(
				join(utils, "package.json"),
				JSON.stringify({
					name: "@oh-my-pi/pi-utils",
					type: "module",
					exports: { ".": { import: "./index.js" } },
				}),
			);
			writeFileSync(
				join(utils, "index.js"),
				'export const APP_NAME = "omp";\n',
			);
		}
		writeFileSync(
			first,
			`import { afterAll, test } from "bun:test";
import { _resetHarnessForTesting, setHarness } from ${JSON.stringify(harness)};
import { __setPiHarnessKindForTesting } from ${JSON.stringify(detection)};
${mutator}
`,
		);
		writeFileSync(
			victim,
			`import { expect, test } from "bun:test";
import { setHarness } from ${JSON.stringify(harness)};
import { resolvePiHarnessKind } from ${JSON.stringify(detection)};
test("a later Pi file can select its harness", () => {
  setHarness("pi");
  expect(resolvePiHarnessKind()).toBe("pi");
});
`,
		);
		const child = spawnSync(
			process.execPath,
			["test", "--parallel=1", "--preload", preload, first, victim],
			{
				cwd: dir,
				env: {
					...process.env,
					HOME: home,
					XDG_DATA_HOME: home,
					XDG_CONFIG_HOME: home,
					XDG_STATE_HOME: home,
					XDG_CACHE_HOME: home,
					MAGIC_CONTEXT_TEST_DATA_DIR: home,
				},
				encoding: "utf8",
				timeout: 15_000,
				windowsHide: true,
			},
		);
		if (child.error) throw child.error;
		return { status: child.status, output: child.stdout + child.stderr };
	} finally {
		cleanup();
	}
}

test("entry imports stay Pi when OMP test dependencies are installed", () => {
	const entry = new URL("./index.ts", import.meta.url).href;
	const result = runFiles(
		`import { expect } from "bun:test";
import { getHarness } from ${JSON.stringify(harness)};
await import(${JSON.stringify(entry)});
test("entry captured the Pi harness", () => {
  expect(getHarness()).toBe("pi");
});`,
		true,
	);
	expect(result.output).not.toContain("Pi test harness isolation leak");
	expect(result.status).toBe(0);
	expect(result.output).toContain("2 pass");
});

test.each([
	"omp",
	"opencode",
	"opencode2",
] as const)("the file-boundary guard rejects a harness locked to %s", (kind) => {
	const result = runFiles(`test("leaks a harness lock", () => {
  setHarness(${JSON.stringify(kind)});
});`);
	expect(result.status).toBe(1);
	expect(result.output).toContain("Pi test harness isolation leak");
	expect(result.output).toContain(`harness locked to "${kind}"`);
	expect(result.output).toContain("01-mutator.test.ts:");
});

test("the file-boundary guard rejects an OMP memo even when the harness is Pi", () => {
	const result = runFiles(`test("leaks only the detection memo", () => {
  setHarness("pi");
  __setPiHarnessKindForTesting("omp");
});`);
	expect(result.status).toBe(1);
	expect(result.output).toContain("Pi test harness isolation leak");
	expect(result.output).toContain('detection memo is "omp"');
});

test("file cleanup restores an OMP lock and memo before the next Pi file", () => {
	const result = runFiles(`test("temporarily uses OMP", () => {
  setHarness("omp");
  __setPiHarnessKindForTesting("omp");
});
afterAll(() => {
  _resetHarnessForTesting();
  setHarness("pi");
  __setPiHarnessKindForTesting(undefined);
});`);
	// The preload must check the mutator fixture after its afterAll restores Pi.
	expect(result.output).not.toContain("Pi test harness isolation leak");
	expect(result.status).toBe(0);
	expect(result.output).toContain("2 pass");
});

test("the file-boundary guard permits an unused harness and a Pi memo", () => {
	const result = runFiles(`test("does not lock a harness", () => {
  __setPiHarnessKindForTesting("pi");
});`);
	expect(result.status).toBe(0);
	expect(result.output).toContain("2 pass");
});
