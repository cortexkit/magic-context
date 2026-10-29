import { expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TOKEN_BUDGET_TOOL_REFUSAL } from "@magic-context/core/features/magic-context/dreamer/token-budget";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import { OMP_RETAINED_NO_TOOLS_ENV } from "./omp-retained-rpc";
import extension from "./subagent-entry";

test("OMP retained guard registers no tools before budget finalization", () => {
	const root = createTestTempDirFromPath(join(tmpdir(), "omp-tool-guard-"));
	const guard = join(root, "budget");
	const oldPolicy = process.env[OMP_RETAINED_NO_TOOLS_ENV];
	const oldGuard = process.env.MAGIC_CONTEXT_SUBAGENT_BUDGET_GUARD_FILE;
	process.env[OMP_RETAINED_NO_TOOLS_ENV] = "1";
	process.env.MAGIC_CONTEXT_SUBAGENT_BUDGET_GUARD_FILE = guard;
	writeFileSync(guard, "");
	const tools: string[] = [];
	const handlers = new Map<string, () => unknown>();
	try {
		extension({
			registerFlag() {},
			registerTool(tool: { name: string }) {
				tools.push(tool.name);
			},
			on(name: string, callback: () => unknown) {
				handlers.set(name, callback);
			},
		} as unknown as ExtensionAPI);
		expect(tools).toEqual([]);
		expect([...handlers.keys()]).toEqual(["tool_call"]);
		expect(handlers.get("tool_call")!()).toMatchObject({ block: true });
		writeFileSync(guard, "finalize");
		expect(handlers.get("tool_call")!()).toEqual({
			block: true,
			reason: TOKEN_BUDGET_TOOL_REFUSAL,
		});
		rmSync(guard);
		expect(handlers.get("tool_call")!()).toEqual({
			block: true,
			reason: TOKEN_BUDGET_TOOL_REFUSAL,
		});
	} finally {
		if (oldPolicy === undefined) delete process.env[OMP_RETAINED_NO_TOOLS_ENV];
		else process.env[OMP_RETAINED_NO_TOOLS_ENV] = oldPolicy;
		if (oldGuard === undefined)
			delete process.env.MAGIC_CONTEXT_SUBAGENT_BUDGET_GUARD_FILE;
		else process.env.MAGIC_CONTEXT_SUBAGENT_BUDGET_GUARD_FILE = oldGuard;
		rmSync(root, { recursive: true, force: true });
	}
});
