import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	closeDatabase,
	openDatabase,
} from "@magic-context/core/features/magic-context/storage";
import { runValidatedHistorianPass } from "@magic-context/core/hooks/magic-context/compartment-runner-historian";
import type { HiddenCompletionExecutor } from "@magic-context/core/hooks/magic-context/compartment-runner-types";
import { getHarness } from "@magic-context/core/shared/harness";
import {
	createTestTempDirFromPath,
	getOriginalTempDirForTests,
} from "@magic-context/core/shared/test-temp-dir";

const dirs: string[] = [];
afterEach(() => {
	closeDatabase();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

// CLI doctor tests count historian dumps in the machine's temp directory, so a
// Pi test that leaves one there changes their warning totals. The test preload
// moves os.tmpdir() to a throwaway root; this checks a failed pass's dump lands
// there and not in the temp directory the process started with.
test("a historian dump made by a Pi test stays out of the machine's temp directory", async () => {
	const project = createTestTempDirFromPath(
		join(tmpdir(), "mc-pi-dump-project-"),
	);
	dirs.push(project);
	const sessionId = `pi-dump-isolation-${process.pid}-${Date.now()}`;
	const historianDir = (tempDir: string) =>
		join(tempDir, getHarness(), "magic-context", "historian", sessionId);
	const dumpDir = historianDir(tmpdir());
	const machineDumpDir = historianDir(getOriginalTempDirForTests());
	dirs.push(dumpDir, machineDumpDir);
	const executor: HiddenCompletionExecutor = {
		capabilities: { tools: false, harness: "pi" },
		open: async () => ({ id: "pi-dump-child" }),
		attempt: async () => {},
		collect: async () => ({
			text: "invalid XML kept for diagnosis",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			lengthCapped: false,
		}),
		close: async () => {},
	};

	const result = await runValidatedHistorianPass({
		client: undefined,
		hiddenCompletionExecutor: executor,
		db: openDatabase(),
		parentSessionId: sessionId,
		sessionDirectory: project,
		prompt: "Messages 1-1:\n1: U: preserve this",
		chunk: {
			startIndex: 1,
			endIndex: 1,
			lines: [{ ordinal: 1, messageId: "message-1" }],
		},
		priorCompartments: [],
		sequenceOffset: 0,
		dumpLabelBase: "pi-isolation",
	});

	expect(result.ok).toBe(false);
	expect(readdirSync(dumpDir).some((name) => name.endsWith(".xml"))).toBe(true);
	expect(existsSync(machineDumpDir)).toBe(false);
});
