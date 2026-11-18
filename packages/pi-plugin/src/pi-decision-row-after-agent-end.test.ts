import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { openDatabase } from "@magic-context/core/features/magic-context/storage-db";
import {
	__test as decisions,
	recordPendingPiTransformDecision,
	schedulePiTransformDecisionResolve,
} from "@magic-context/core/features/magic-context/transform-decision-log";
import { createTestTempDir } from "../../plugin/src/shared/test-temp-dir";
import { clearPiContextReceipt, registerPiGuardedContext } from "./pi-context-refusal";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import { assistantMessage, fakeContext, userMessage } from "./test-utils.test";

// A busting pass's transform_decisions row is written late: the next context
// pass finds the assistant that answered it and queues the write on a 0 ms
// timer. Bun runs I/O callbacks before due timers, so with a fast provider the
// next pass's request can be answered and its run can end before that timer
// fires. Seen on a real Oh My Pi CI host: the `/ctx-flush` rebuild's row was
// discarded as "queued Pi transform decision" 2 ms after the next run's
// agent_end, and it was never written.

const SESSION = "ses-pi-decision-after-agent-end";
const flushDecision = {
	tsMs: 1,
	decision: "defer" as const,
	materialized: false,
	materializeReason: "explicit_flush" as const,
	systemHashPrev: null,
	systemHashNew: null,
	m0ModelKeyPrev: null,
	m0ModelKeyNew: null,
	emergency: false,
	droppedTokens: 0,
	droppedCount: 1,
	inputTokens: 10_000,
	bustedThisPass: true,
};

type BranchEntry = { type: "message"; id: string; message: unknown };

afterEach(() => {
	decisions.reset();
	clearPiContextReceipt(SESSION);
	__setPiHarnessKindForTesting(undefined);
});

/**
 * Oh My Pi's guarded context wrapper, with a handler that stages and resolves
 * the decision row the way the Pi context handler does. `holdPass` keeps that
 * pass running after it queued the write, until the returned release is called.
 */
function guardedHost(
	db: NonNullable<ReturnType<typeof openDatabase>>,
	branch: BranchEntry[],
	holdPass?: number,
) {
	__setPiHarnessKindForTesting("omp");
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const ctx = {
		...fakeContext(SESSION),
		isIdle: () => false,
		sessionManager: {
			getSessionId: () => SESSION,
			getBranch: () => branch,
		},
		abort: () => {},
	};
	let pass = 0;
	let release = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let markQueued = () => {};
	const queued = new Promise<void>((resolve) => {
		markQueued = resolve;
	});
	registerPiGuardedContext(
		{
			on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) =>
				handlers.set(name, handler),
			appendEntry: () => {},
		} as never,
		async (event, _ctx, budget) => {
			pass++;
			// The same guards the context handler passes: the resolve runs at the
			// start of a pass, and the record once the pass has decided.
			schedulePiTransformDecisionResolve({
				db,
				sessionId: SESSION,
				branchEntries: branch,
				assertCurrentPass: budget.assert,
				assertQueuedWrite: budget.assertDecisionPublication,
			});
			if (pass === 1)
				recordPendingPiTransformDecision(
					SESSION,
					flushDecision,
					"a-before",
					budget.assertDecisionPublication,
				);
			if (pass === holdPass) {
				markQueued();
				await held;
				budget.assert();
			}
			return { messages: event.messages };
		},
	);
	const emit = (name: string, event: unknown = {}) => {
		const handler = handlers.get(name);
		if (!handler) throw new Error(`missing ${name}`);
		return handler(event, ctx);
	};
	return {
		emit,
		queued,
		release: () => release(),
		context: (messages: unknown[]) =>
			emit("context", { messages: structuredClone(messages) }) as Promise<unknown>,
		dispatch: (messages: unknown[]) =>
			emit("before_provider_request", {
				payload: { messages: structuredClone(messages) },
			}),
	};
}

async function withDecisionRows(
	label: string,
	run: (
		db: NonNullable<ReturnType<typeof openDatabase>>,
		written: string[],
	) => Promise<void>,
): Promise<void> {
	const { dir, cleanup } = createTestTempDir(label);
	const db = openDatabase(join(dir, "context.db"));
	if (!db) throw new Error("throwaway database unavailable");
	const written: string[] = [];
	decisions.setWriterForTests((_path, row) => {
		written.push(`${row.harness}:${row.messageId}:${row.materializeReason}`);
	});
	try {
		await run(db, written);
	} finally {
		db.close();
		cleanup();
	}
}

const before = assistantMessage("before", 5);
const prompt = userMessage("flush me", 10);
const flushAnswer = assistantMessage("after the flush", 20);
const next = userMessage("warm after the flush", 30);
const nextInput = [before, prompt, flushAnswer, next];

/** The flush run: its pass busts and stages the row for the answer it gets. */
async function runFlushTurn(
	host: ReturnType<typeof guardedHost>,
	branch: BranchEntry[],
) {
	host.emit("agent_start");
	await host.context([before, prompt]);
	host.dispatch([before, prompt]);
	branch.push({ type: "message", id: "a-flush", message: flushAnswer });
	host.emit("agent_end", { messages: [before, prompt, flushAnswer] });
}

const startBranch = (): BranchEntry[] => [
	{ type: "message", id: "a-before", message: before },
	{ type: "message", id: "u-flush", message: prompt },
];

test("a busting pass keeps its decision row when the next run ends before the queued write runs", async () => {
	await withDecisionRows("mc-pi-decision-agent-end-", async (db, written) => {
		const branch = startBranch();
		const host = guardedHost(db, branch);
		await runFlushTurn(host, branch);

		// The next run's pass names "a-flush" and queues the write; its request
		// is answered and the run ends before the event loop reaches the timer.
		host.emit("agent_start");
		await host.context(nextInput);
		host.dispatch(nextInput);
		host.emit("agent_end", {
			messages: [...nextInput, assistantMessage("answer", 40)],
		});
		expect(written).toEqual([]);

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(written).toEqual(["pi:a-flush:explicit_flush"]);
	});
});

test("a resolving pass superseded before the queued write runs still discards the row", async () => {
	await withDecisionRows("mc-pi-decision-superseded-", async (db, written) => {
		const branch = startBranch();
		const host = guardedHost(db, branch, 2);
		await runFlushTurn(host, branch);

		// The next run's pass queues the write and is still running when a newer
		// pass takes over the session, before the event loop reaches the timer.
		host.emit("agent_start");
		const superseded = host.context(nextInput).catch((error) => error);
		await host.queued;
		await host.context(nextInput);
		host.release();
		expect(String(await superseded)).toContain("superseded");

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(written).toEqual([]);
	});
});
