import { afterAll, beforeAll, expect, test } from "bun:test";
import { rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";

let directory: string;
let entry: string;
beforeAll(async () => {
	directory = createTestTempDirFromPath(join(tmpdir(), "pi-fold-nesting-"));
	await symlink(
		join(import.meta.dir, "../node_modules"),
		join(directory, "node_modules"),
		"dir",
	);
	entry = join(directory, "runner.mjs");
	const build = await Bun.build({
		entrypoints: [
			new URL("__tests__/fold-nested-transaction-runner.mjs", import.meta.url)
				.pathname,
		],
		target: "node",
		format: "esm",
		external: [
			"bun:sqlite",
			"bun:ffi",
			"onnxruntime-node",
			"onnxruntime-web",
			"sharp",
		],
	});
	expect(build.success, build.logs.join("\n")).toBe(true);
	await writeFile(entry, await build.outputs[0].text());
});
afterAll(async () => {
	if (directory) await rm(directory, { recursive: true, force: true });
});

for (const reason of [
	"project_change",
	"model_change",
	"soft_refresh",
] as const) {
	test(`Pi ${reason} commits once inside paired_thinking_edit on node:sqlite`, async () => {
		const child = Bun.spawn(["node", entry, reason], {
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
			env: {
				...process.env,
				MAGIC_CONTEXT_STORAGE_DIR: directory,
				XDG_CONFIG_HOME: directory,
				XDG_DATA_HOME: directory,
				HOME: directory,
			},
		});
		const [stdout, stderr, exit] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(exit, stderr).toBe(0);
		const result = JSON.parse(stdout);
		expect(result).toMatchObject({
			reason,
			passes: 3,
			executions: 1,
			nested: true,
			rollbackPreservedPrefix: true,
		});
		console.log(JSON.stringify(result));
	}, 30_000);
}
