import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

// Keeping the newest 16 read results makes this session exceed the model window.
// The changed prefix needs a shared calibrated estimate above that window, no
// active-turn signed blocks in the output, and actual rebuild permission.
test("held-head witness: over-window replay requires a stripped, permitted rebuild", () => {
	const root = resolve(import.meta.dir, "../../..");
	const env: NodeJS.ProcessEnv = {
		...process.env,
		BUN_JSC_useOMGJIT: "0",
		R2_SEEDS: "8",
		R2_PASSES: "69",
		R2_WINDOW: "100000",
		R2_REBUILD_EVIDENCE: "1",
		// Every step heavy and no synthetic continuations, so the seed's turns are
		// held below the cap. Half the steps are heavy by their stored thinking
		// text, which makes the wire larger than the usage reading: a held pass
		// below the cap whose replay no longer fits the window.
		R2_HEAVY_RATE: "1",
		R2_CONTINUATION_RATE: "0",
	};
	delete env.OPENCODE_DB;
	const result = spawnSync(
		process.execPath,
		[
			"test",
			"--preload",
			resolve(import.meta.dir, "__tests__/held-head-retained-tools.preload.ts"),
			resolve(import.meta.dir, "issue-665-hold-review-r2.test.ts"),
			"-t",
			"Pi held driver seed 8:",
			"--timeout",
			"180000",
		],
		{ cwd: root, env, encoding: "utf8", timeout: 180000, windowsHide: true },
	);
	expect(result.stderr).toContain("Pi held driver seed 8:");
	expect(result.status, result.stdout + result.stderr).toBe(0);
	const prefix = "PI_OVER_WINDOW_REBUILD ";
	const evidence = result.stdout
		.split("\n")
		.filter((line) => line.startsWith(prefix))
		.map((line) => JSON.parse(line.slice(prefix.length)));
	expect(evidence).toHaveLength(1);
	expect(evidence[0]).toMatchObject({
		// Includes the ctx_reduce definition the driver's tool list carries, so
		// the session can call the tool and keeps its tag prefixes.
		tokens: 101921,
		limit: 100000,
		activeSignedBlocks: 0,
		declaredRebuild: true,
		bustPermitted: true,
		bustedThisPass: true,
		signedPrefixRewritten: true,
	});
}, 180000);
