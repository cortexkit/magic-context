import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as logger from "@magic-context/core/shared/logger";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import type { PiContextBudget } from "./pi-context-budget";
import {
	clearPiContextReceipt,
	PiContextSupersededError,
	registerPiGuardedContext,
} from "./pi-context-refusal";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import {
	capturePiServedArray,
	flushPiServedArrayLedger,
	getPiServedArrayBodyPath,
	getPiServedArrayLedgerPath,
	__test as ledger,
} from "./served-array-ledger";
import { createFakePi, fakeContext, userMessage } from "./test-utils.test";

const roots: string[] = [];
const session = "issue-698";
function root() {
	const directory = createTestTempDirFromPath(join(tmpdir(), "pi-issue-698-"));
	roots.push(directory);
	return directory;
}
afterEach(() => {
	ledger.reset();
	mock.restore();
	clearPiContextReceipt(session);
	__setPiHarnessKindForTesting(undefined);
	for (const directory of roots.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

for (const replacement of [
	"agent_end",
	"newer context pass",
	"new operation",
] as const) {
	test(`issue 698: queued served capture quietly discards ${replacement}`, async () => {
		__setPiHarnessKindForTesting("omp");
		const storageDir = root();
		const logs = spyOn(logger, "log").mockImplementation(() => {});
		const fake = createFakePi();
		const ctx = { ...fakeContext(session), abort: () => {} };
		let budget!: PiContextBudget;
		registerPiGuardedContext(fake.pi as never, async (event, _ctx, pass) => {
			budget = pass;
			return { messages: event.messages };
		});
		const emit = (name: string, event: unknown = {}) => {
			const handler = fake.handlers.get(name);
			if (!handler) throw new Error(`missing ${name}`);
			return handler(event as never, ctx as never);
		};
		emit("agent_start");
		await emit("context", {
			messages: [userMessage("<session-history>managed</session-history>", 1)],
		});
		const previous = budget;
		capturePiServedArray(session, [], {
			storageDir,
			fullBodyCapture: true,
			assertCurrentPass: previous.assertOutcome,
		});
		if (replacement === "agent_end") emit("agent_end");
		else if (replacement === "new operation") emit("agent_start");
		else await emit("context", { messages: [userMessage("replacement", 2)] });
		expect(() => previous.assertOwner()).toThrow(PiContextSupersededError);
		logs.mockClear();
		flushPiServedArrayLedger();
		expect(logs).not.toHaveBeenCalled();
		expect(existsSync(getPiServedArrayLedgerPath(session, storageDir))).toBe(
			false,
		);
		expect(existsSync(getPiServedArrayBodyPath(session, storageDir))).toBe(
			false,
		);
	});
}

test("issue 698: unexpected queued ownership errors remain visible and never publish", () => {
	const storageDir = root();
	const logs = spyOn(logger, "log").mockImplementation(() => {});
	const failure = new Error(
		"Pi context pass superseded: unexpected ownership failure",
	);
	let current = true;
	capturePiServedArray(session, [], {
		storageDir,
		assertCurrentPass: () => {
			if (!current) throw failure;
		},
	});
	current = false;
	flushPiServedArrayLedger();
	expect(logs).toHaveBeenCalledTimes(1);
	expect(logs).toHaveBeenCalledWith(
		"[magic-context][pi] DISCARDED CONTEXT RESULT: queued served capture",
		failure,
	);
	expect(existsSync(getPiServedArrayLedgerPath(session, storageDir))).toBe(
		false,
	);
});

test("issue 698: current queued captures still publish", () => {
	const storageDir = root();
	capturePiServedArray(session, [], {
		storageDir,
		assertCurrentPass: () => {},
	});
	flushPiServedArrayLedger();
	expect(
		JSON.parse(
			readFileSync(getPiServedArrayLedgerPath(session, storageDir), "utf8"),
		).session_id,
	).toBe(session);
});

// A fresh production-mode process exercises the real logger, not a mocked call.
const scenario = `
const { registerPiGuardedContext } = await import('./pi-context-refusal.ts');
const { __setPiHarnessKindForTesting } = await import('./pi-harness-kind.ts');
const { flushLogger, getLogFilePath } = await import('../../plugin/src/shared/logger.ts');
const { setHarness } = await import('../../plugin/src/shared/harness.ts');
setHarness('omp');
__setPiHarnessKindForTesting('omp');
const handlers = new Map();
const entries = [];
let aborts = 0;
let blocked = 0;
const ctx = { signal: new AbortController().signal, sessionManager: { getSessionId: () => '698-log', getBranch: () => [] }, abort: () => aborts++ };
const managed = [
 { role: 'user', content: '<session-history>PRIVATE_MESSAGE_TEXT</session-history>', timestamp: 1 },
 { role: 'assistant', content: [{ type: 'toolCall', id: 'PRIVATE_EXPECTED_ID', name: 'PRIVATE_TOOL_NAME', arguments: { value: 'PRIVATE_ARGUMENT' } }], timestamp: 2 },
 { role: 'toolResult', toolCallId: 'PRIVATE_EXPECTED_ID', toolName: 'PRIVATE_TOOL_NAME', content: 'PRIVATE_RESULT', timestamp: 3 },
];
registerPiGuardedContext({ on: (name, fn) => handlers.set(name, fn), appendEntry: (_type, value) => entries.push(value) }, async () => ({ messages: structuredClone(managed) }));
const emit = (name, event = {}) => {
 const result = handlers.get(name)(event, ctx);
 if (name === 'before_provider_request') {
  try { JSON.stringify(result); } catch (error) {
   if (error.message !== entries[0].message) throw error;
   blocked++;
   return;
  }
  throw new Error('refused payload reached mock provider');
 }
 return result;
};
emit('agent_start');
await emit('context', { messages: [{ role: 'user', content: 'PRIVATE_RAW', timestamp: 4 }] });
const changed = structuredClone(managed);
changed[1].content[0].id = 'PRIVATE_ACTUAL_ID';
emit('before_provider_request', { payload: { messages: changed } });
emit('before_provider_request', { payload: { messages: changed } });
flushLogger();
console.log(JSON.stringify({ path: getLogFilePath(), aborts, blocked, entries: entries.length }));
`;

test("issue 698: dispatch refusal persists one sanitized full divergence line to magic-context.log", async () => {
	const directory = root();
	const child = Bun.spawn({
		cmd: [process.execPath, "--eval", scenario],
		cwd: import.meta.dir,
		windowsHide: true,
		env: {
			...process.env,
			NODE_ENV: "production",
			HOME: directory,
			CFFIXED_USER_HOME: directory,
			TMPDIR: directory,
			TEMP: directory,
			TMP: directory,
			XDG_CONFIG_HOME: join(directory, "config"),
			XDG_DATA_HOME: join(directory, "data"),
			XDG_CACHE_HOME: join(directory, "cache"),
			XDG_STATE_HOME: join(directory, "state"),
			PI_CODING_AGENT_DIR: join(directory, ".omp/agent"),
			MAGIC_CONTEXT_STORAGE_DIR: directory,
			MAGIC_CONTEXT_LOG_PATH: join(
				directory,
				"omp/magic-context/magic-context.log",
			),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exit, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect(exit, stderr).toBe(0);
	const result = JSON.parse(stdout.trim());
	expect(result.aborts).toBe(0);
	expect(result.blocked).toBe(2);
	expect(result.entries).toBe(1);
	const lines = readFileSync(result.path, "utf8").trim().split("\n");
	const refusals = lines.filter((line) => line.includes("CONTEXT REFUSED"));
	expect(refusals).toHaveLength(1);
	expect(refusals[0]).toContain(
		"row=1 expectedRows=3 actualRows=3 expectedRole=assistant actualRole=assistant expectedCalls=1 actualCalls=1 expectedResults=0 actualResults=0 comparison=call id",
	);
	expect(lines.join("\n")).not.toContain("PRIVATE_");
});
