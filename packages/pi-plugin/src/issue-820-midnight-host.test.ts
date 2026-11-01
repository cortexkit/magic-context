import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

for (const name of [
	"issue 820: real OMP 18.13.2 replies after simulated local midnight",
	"issue 820: real OMP still refuses a non-reminder extra row after midnight",
]) {
	test(name, () => {
		// Bun reuses test workers, which can retain SQLite descriptors from earlier
		// files. Give the real host its own process so lsof proves its isolation.
		const result = spawnSync(
			process.execPath,
			[
				"test",
				"--timeout",
				"30000",
				new URL(
					"./__tests__/issue-820-midnight-host-runner.ts",
					import.meta.url,
				).pathname,
				"--test-name-pattern",
				name,
			],
			{ encoding: "utf8", env: process.env, windowsHide: true },
		);
		console.log(result.stdout);
		console.log(result.stderr);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
	}, 30000);
}
