import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	setTimeout as nextTimer,
	setImmediate as nextTurn,
} from "node:timers/promises";
import vm from "node:vm";

const [, , sourcePath, mode] = process.argv;
const collectGarbage = globalThis.Bun ? () => Bun.gc(true) : globalThis.gc;
assert.equal(typeof collectGarbage, "function", "Node requires --expose-gc");
const callbacks = new Map();
const weakEvents = [];
const weakBudgets = [];
const weakSnapshots = [];
const retainedGuards = [];
const omp = mode === "omp" || mode === "side";
let sessionReads = 0;
const pi = {
	on(event, callback) {
		callbacks.set(event, callback);
	},
	registerEntryRenderer() {},
	appendEntry() {
		throw new Error("Unexpected refusal");
	},
};
const sandbox = {
	AsyncLocalStorage,
	createHash,
	// The fixture hashes only arrays of {type, text}; insertion order is already
	// canonical. Its random text contains no date reminder to strip.
	stableStringify: JSON.stringify,
	piDateReminderText: () => false,
	sessionLog() {},
	performance,
	setTimeout,
	clearTimeout,
	resolvePiHarnessKind: () => (omp ? "omp" : "pi"),
	isOmpDumpContext: () => false,
	withSqliteTransformPass: (callback) => callback(),
	guardSqliteTransformPass() {},
	loadPiToolWireSchema: async () => ({}),
	createTagger: () => ({}),
	createPiLkgCoordinator: () => ({}),
	// Claim a generation, then use the handler's no-session return before any
	// storage access. The refusal module still uses one stable session key.
	resolveSessionId: () =>
		++sessionReads % 2 ? "synthetic-session" : undefined,
	log() {},
	Text: class {},
	piManagedSignature: () => "synthetic-signature",
	preparePiDispatch: (messages) => ({ messages, structure: {} }),
	// The served check keeps only numbers per message; its own test proves a
	// committed request stays collectable (served-check.test.ts).
	beginServedRequest() {},
	commitServedRequest: () => null,
	countServedRefusal() {},
	lkgContentFields(message) {
		const fields = message.content.map((part) => part.text);
		weakSnapshots.push(new WeakRef(fields));
		return fields;
	},
};
vm.createContext(sandbox);
vm.runInContext(
	`${readFileSync(sourcePath, "utf8")}
	globalThis.register = registerPiContextHandler;
	globalThis.clearReceipt = clearPiContextReceipt;
	globalThis.registerGuarded = registerPiGuardedContext;`,
	sandbox,
);
// Keep the real handler's full lexical scope and installed guard, but supply
// an empty managed result after its no-session exit. No history cache or DB is
// involved in these successful context preparations.
const originalRegister = sandbox.registerGuarded;
sandbox.registerOverride = (api, handler, options) =>
	originalRegister(
		api,
		async (event, ctx, budget) => {
			weakBudgets.push(new WeakRef(budget));
			await handler(event, ctx, budget);
			if (mode === "retained-guards") retainedGuards.push(budget.assertOwner);
			return { messages: [] };
		},
		options,
	);
vm.runInContext(
	"registerPiGuardedContext = globalThis.registerOverride;",
	sandbox,
);
sandbox.register(pi, { db: {} });
const context = callbacks.get("context");
assert.equal(typeof context, "function");
const ctx = {
	sessionManager: { getSessionId: () => "synthetic-session" },
	abort() {
		throw new Error("Unexpected abort");
	},
};
const reminder =
	"<system-reminder>\nEphemeral side-channel turn; reuses current conversation context.\nTool catalog attached only to keep prompt cache warm; tools NOT available this turn.\nDo NOT emit tool calls; reply plain text only. Tool calls discarded without execution.\n</system-reminder>";

async function collect() {
	// WeakRef targets survive the job that creates or dereferences them.
	await nextTurn();
	for (let i = 0; i < 3; i++) {
		await nextTimer(1);
		collectGarbage();
		await nextTurn();
	}
}

async function request() {
	let event = {
		messages: [
			{
				role: "user",
				timestamp: weakEvents.length + 1,
				content: [
					{ type: "text", text: randomBytes(128 * 1024).toString("hex") },
				],
			},
		],
	};
	if (mode === "side") {
		event.messages.unshift({
			role: "developer",
			attribution: "agent",
			content: reminder,
		});
		event.messages.at(-1).attribution = "agent";
	}
	weakEvents.push(new WeakRef(event));
	if (mode === "omp") callbacks.get("agent_start")({}, ctx);
	const result = await context(event, ctx);
	assert.equal(result.messages.length, 0);
	let budget = weakBudgets.at(-1).deref();
	assert.equal(budget.completed, true);
	budget.assertOwner();
	if (mode === "omp")
		callbacks.get("agent_end")({ messages: event.messages }, ctx);
	budget = null;
	event = null;
}

// Side turns run beside a valid main operation and must not replace it.
if (mode === "side") {
	const result = await context({ messages: [] }, ctx);
	assert.equal(result.messages.length, 0);
	weakBudgets.length = 0;
}
const alive = (references) => references.filter((ref) => ref.deref()).length;
async function checkpoint(requests) {
	let counts;
	// JSC can conservatively retain stale stack slots for an extra collection.
	// Retry boundedly, without relaxing the latest-only liveness requirement.
	for (let attempt = 0; attempt < 10; attempt++) {
		await collect();
		counts = {
			requests,
			retained_events: alive(weakEvents),
			retained_historical_events: alive(weakEvents.slice(0, -1)),
			retained_budgets: alive(weakBudgets),
			retained_snapshots: alive(weakSnapshots),
		};
		if (
			counts.retained_events <= (mode === "retained-guards" ? 0 : 1) &&
			counts.retained_historical_events === 0 &&
			(mode === "retained-guards" || counts.retained_budgets <= 1) &&
			counts.retained_snapshots === 0
		)
			break;
	}
	return counts;
}
const checkpoints = [];
for (let n = 1; n <= 96; n++) {
	await request();
	if (n % 32) continue;
	checkpoints.push(await checkpoint(n));
}
sandbox.clearReceipt("synthetic-session");
retainedGuards.length = 0;
let retainedAfterCleanup;
for (let attempt = 0; attempt < 10; attempt++) {
	await collect();
	retainedAfterCleanup = alive(weakEvents);
	if (retainedAfterCleanup === 0) break;
}
console.log(
	JSON.stringify({
		runtime: globalThis.Bun ? `Bun ${Bun.version}` : process.version,
		checkpoints,
		retained_after_cleanup: retainedAfterCleanup,
	}),
);
