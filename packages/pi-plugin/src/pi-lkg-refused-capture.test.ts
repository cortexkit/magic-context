import { afterEach, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import {
	createDbLkgPersistence,
	loadPersistedLkgSlot,
} from "@magic-context/core/hooks/magic-context/lkg-persist";
import { checkLkgDurability } from "@magic-context/core/hooks/magic-context/lkg-served-marker";
import {
	getSlot,
	resetLkgSlotsForTest,
} from "@magic-context/core/hooks/magic-context/lkg-slot";
import { createTestTempDir } from "../../plugin/src/shared/test-temp-dir";
import { assertPiRefusedDispatch } from "./__tests__/dispatch-probe";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import {
	clearPiContextReceipt,
	registerPiGuardedContext,
} from "./pi-context-refusal";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import { createPiLkgCoordinator } from "./pi-lkg";
import { publishPiServedNumbers } from "./pi-served-identities";
import { flushPiServedArrayLedger } from "./served-array-ledger";
import {
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";

// A Pi pass installs its capture in memory when its publication commits, before
// the request is dispatched. When the pass is then refused, that capture was never
// sent: the next replay, and the next pass, must work from the request that was
// last dispatched, never from the refused one.

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	resetLkgSlotsForTest();
	__setPiHarnessKindForTesting(undefined);
});

/** The replayed request starts with these saved bytes. */
const startsWith = (messages: unknown[], prefix: string) =>
	JSON.stringify(messages).startsWith(prefix.slice(0, -1));

test("plain Pi: after a pass refused once it captured, replay serves the previously dispatched request", async () => {
	const { dir: root, cleanup } = createTestTempDir("pi-refused-capture-");
	const dataHome = process.env.XDG_DATA_HOME;
	const configHome = process.env.XDG_CONFIG_HOME;
	process.env.XDG_DATA_HOME = root;
	process.env.XDG_CONFIG_HOME = root;
	const db = createTestDb(join(root, "context.db"));
	const sessionId = "pi-refused-capture-plain";
	cleanups.push(() => {
		flushPiServedArrayLedger();
		clearContextHandlerSession(sessionId);
		db.close();
		if (dataHome === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = dataHome;
		if (configHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = configHome;
		cleanup();
	});
	let now = 0;
	const clock = spyOn(performance, "now").mockImplementation(() => now);
	cleanups.push(() => clock.mockRestore());
	let refuseAtReturn = false;
	const fake = createFakePi();
	// The handler's last hook runs after its own deadline checks: crossing the
	// deadline there lets the handler return with its capture installed, and the
	// dispatch wrapper then refuses the request.
	registerPiContextHandler(fake.pi as never, {
		db,
		onPostprocess: () => {
			if (refuseAtReturn) now = 26_000;
		},
	});
	const handler = fake.handlers.get("context");
	if (!handler) throw new Error("context handler missing");
	// Fresh message objects per pass: the handler rewrites its input in place.
	const firstTurn = () => [userMessage("first turn", 1)];
	const secondTurn = () => [...firstTurn(), userMessage("second turn", 2)];
	const first = firstTurn();
	await handler(
		{ messages: first } as never,
		fakeContext(sessionId, root, ["entry-1"], first) as never,
	);
	const dispatched = getSlot(sessionId);
	expect(dispatched?.jsonPrefix).toContain("first turn");
	expect(checkLkgDurability(db, sessionId)).toEqual({
		durable: true,
		servedCaptureId: 1,
	});

	refuseAtReturn = true;
	const second = secondTurn();
	await expect(
		handler(
			{ messages: second } as never,
			fakeContext(sessionId, root, ["entry-1", "entry-2"], second) as never,
		),
	).rejects.toThrow("elapsed=26000ms");
	const refused = loadPersistedLkgSlot(db, sessionId)?.jsonPrefix;
	expect(refused).toContain("second turn");
	expect(refused).not.toBe(dispatched?.jsonPrefix);
	// Memory holds the dispatched request again, not the refused one.
	expect(getSlot(sessionId)?.jsonPrefix).toBe(dispatched?.jsonPrefix);
	expect(createDbLkgPersistence(db).load(sessionId)).toBeUndefined();

	const coordinator = createPiLkgCoordinator(db);
	const replay = coordinator.replay(
		coordinator.beginPass({
			sessionId,
			messages: secondTurn(),
			entryIds: ["entry-1", "entry-2"],
			modelKey: dispatched?.modelKey ?? null,
			providerKey: dispatched?.providerKey ?? null,
		}),
	);
	expect(replay.ok).toBe(true);
	if (replay.ok) {
		expect(startsWith(replay.messages, dispatched?.jsonPrefix ?? "")).toBe(
			true,
		);
		expect(startsWith(replay.messages, refused ?? "")).toBe(false);
	}
});

test("Oh My Pi: a request refused at the provider-dispatch fence is not replayed; the previously dispatched one is", async () => {
	__setPiHarnessKindForTesting("omp");
	const sessionId = "pi-refused-capture-omp";
	const db = createTestDb();
	cleanups.push(() => {
		clearPiContextReceipt(sessionId);
		db.close();
	});
	const coordinator = createPiLkgCoordinator(db, () => {
		throw new Error("managed publication must not defer");
	});
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const refusals: string[] = [];
	let aborts = 0;
	let managed: unknown[] = [];
	let outputs: unknown[] = [];
	let number = 0;
	registerPiGuardedContext(
		{
			on: (name: string, callback: (event: unknown, ctx: unknown) => unknown) =>
				handlers.set(name, callback),
			appendEntry: (_type: string, data: { message: string }) =>
				refusals.push(data.message),
		} as never,
		async (event, _ctx, budget) => {
			// A managed pass as the Pi context handler runs it: publish the output
			// with its served numbers, then hand the wrapper the certificate.
			const snapshot = coordinator.beginPass({
				sessionId,
				messages: event.messages,
				entryIds: event.messages.map((_, index) => `entry-${index + 1}`),
				modelKey: null,
				providerKey: null,
			});
			const served = ++number;
			coordinator.captureAppliedPass({
				snapshot,
				outputMessages: outputs,
				outputEntryIds: outputs.map((_, index) => `entry-${index + 1}`),
				cacheBusting: false,
				assertCurrentPass: budget.assertOutcome,
				publishServedNumbers: () =>
					publishPiServedNumbers(db, sessionId, [served]),
			});
			budget.dispatchCertificate = {
				confirm: () => coordinator.certifyDispatched(snapshot),
				refuse: () => coordinator.refuseDispatch(snapshot),
			};
			managed = structuredClone(outputs);
			return { messages: structuredClone(outputs) as never };
		},
	);
	const ctx = {
		...fakeContext(sessionId),
		isIdle: () => false,
		abort: () => aborts++,
	};
	const emit = (name: string, event: unknown = {}) => {
		const callback = handlers.get(name);
		if (!callback) throw new Error(`missing ${name}`);
		return callback(event, ctx);
	};
	const first = [userMessage("first turn", 1)];
	outputs = [userMessage("§1§ first turn", 1)];
	emit("agent_start");
	await emit("context", { messages: structuredClone(first) });
	emit("before_provider_request", {
		payload: { messages: structuredClone(managed) },
	});
	expect(refusals).toEqual([]);
	const dispatched = getSlot(sessionId);
	expect(dispatched?.jsonPrefix).toContain("§1§ first turn");
	expect(checkLkgDurability(db, sessionId)).toEqual({
		durable: true,
		servedCaptureId: 1,
	});

	const second = [...first, userMessage("second turn", 2)];
	outputs = [
		userMessage("§1§ first turn", 1),
		userMessage("§2§ second turn", 2),
	];
	await emit("context", { messages: structuredClone(second) });
	// The provider request does not match the prepared result: the fence refuses.
	assertPiRefusedDispatch(
		emit("before_provider_request", {
			payload: {
				messages: [userMessage("a request this pass never prepared", 9)],
			},
		}),
		"missing current receipt signature",
	);
	expect(aborts).toBe(0);
	expect(refusals).toHaveLength(1);
	expect(loadPersistedLkgSlot(db, sessionId)?.jsonPrefix).toContain(
		"§2§ second turn",
	);
	expect(checkLkgDurability(db, sessionId)).toEqual({
		durable: true,
		servedCaptureId: null,
		certified: false,
	});
	expect(getSlot(sessionId)?.jsonPrefix).toBe(dispatched?.jsonPrefix);

	const replay = coordinator.replay(
		coordinator.beginPass({
			sessionId,
			messages: second,
			entryIds: ["entry-1", "entry-2"],
			modelKey: null,
			providerKey: null,
		}),
	);
	expect(replay.ok).toBe(true);
	if (replay.ok) {
		expect(JSON.stringify(replay.messages)).not.toContain("§2§ second turn");
		expect(startsWith(replay.messages, dispatched?.jsonPrefix ?? "")).toBe(
			true,
		);
	}
});
