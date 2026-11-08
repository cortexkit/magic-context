import { afterEach, expect, spyOn, test } from "bun:test";
import { assertPiRefusedDispatch } from "./__tests__/dispatch-probe";
import {
	__test,
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import { PiContextBudget } from "./pi-context-budget";
import {
	clearPiContextReceipt,
	registerPiGuardedContext,
} from "./pi-context-refusal";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import * as schema from "./pi-tool-wire-schema";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";

const SESSION = "issue-680";
function deferred<T = void>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}
function snapshot(db: ReturnType<typeof createTestDb>) {
	return Object.fromEntries(
		(
			db
				.query(
					"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
				)
				.all() as { name: string }[]
		).map(({ name }) => [name, db.query(`SELECT * FROM "${name}"`).all()]),
	);
}
function hostContext(controller: AbortController) {
	return {
		...fakeContext(SESSION),
		signal: controller.signal,
		ui: {
			notify: () => {
				throw new Error("cancellation notified as refusal");
			},
		},
		abort: () => {
			throw new Error("cancellation aborted twice");
		},
	};
}
afterEach(() => {
	clearContextHandlerSession(SESSION);
	clearPiContextReceipt(SESSION);
	__setPiHarnessKindForTesting(undefined);
});

for (const stage of ["schema", "main pass"] as const) {
	for (const exposedSignal of [true, false]) {
		test(`issue 680: cancellation during ${stage} is quiet and late work writes nothing${exposedSignal ? "" : " (host without signal)"}`, async () => {
			const db = createTestDb();
			const held = deferred<schema.PiToolWireSchema | undefined>();
			const entered = deferred();
			const controller = new AbortController();
			const schemaSpy =
				stage === "schema"
					? spyOn(schema, "loadPiToolWireSchema").mockImplementation(() => {
							entered.resolve();
							return held.promise;
						})
					: undefined;
			const restorePause =
				stage === "main pass"
					? __test.setBeforePipelineForTests(() => {
							entered.resolve();
							return held.promise.then(() => {});
						})
					: () => {};
			const fake = createFakePi();
			const entries: unknown[] = [];
			const notifications: unknown[] = [];
			let aborts = 0;
			let pending: Promise<unknown> | undefined;
			try {
				registerPiContextHandler(
					{
						...fake.pi,
						appendEntry: (...args: unknown[]) => entries.push(args),
					} as never,
					{ db },
				);
				const ctx = {
					...hostContext(controller),
					signal: exposedSignal ? controller.signal : undefined,
					ui: { notify: (...args: unknown[]) => notifications.push(args) },
					abort: () => {
						aborts++;
					},
				};
				const run = fake.handlers.get("context") as (
					event: unknown,
					ctx: unknown,
				) => Promise<unknown>;
				pending = run({ messages: [userMessage("cancel this pass", 1)] }, ctx);
				await entered.promise;
				const atCancellation = snapshot(db);
				if (exposedSignal) controller.abort();
				else held.reject(new DOMException("session aborted", "AbortError"));
				// A signal-cancelled wait finishes without joining late schema/search work.
				expect(await pending).toBeUndefined();
				held.resolve(undefined);
				await new Promise((done) => setImmediate(done));
				expect({ aborts, entries, notifications }).toEqual({
					aborts: 0,
					entries: [],
					notifications: [],
				});
				expect(snapshot(db)).toEqual(atCancellation);
				expect(
					db.query("SELECT * FROM tags WHERE session_id=?").all(SESSION),
				).toEqual([]);
			} finally {
				held.resolve(undefined);
				await pending;
				schemaSpy?.mockRestore();
				restorePause();
				db.close();
			}
		});
	}
}

test("issue 680: an already cancelled post-tool context never starts its handler", async () => {
	const fake = createFakePi();
	const controller = new AbortController();
	let calls = 0;
	registerPiGuardedContext(fake.pi as never, async () => {
		calls++;
		throw new Error("must not run");
	});
	controller.abort();
	const run = fake.handlers.get("context") as (
		event: unknown,
		ctx: unknown,
	) => Promise<unknown>;
	expect(await run({ messages: [] }, hostContext(controller))).toBeUndefined();
	expect(calls).toBe(0);
});

test("issue 680: a rejected promise is owned even when the wait entry guard throws", async () => {
	const budget = new PiContextBudget();
	const controller = new AbortController();
	budget.signal = controller.signal;
	controller.abort();
	const pending = Promise.reject(controller.signal.reason);
	await expect(budget.waitMandatory(pending)).rejects.toBe(
		controller.signal.reason,
	);
	await new Promise((done) => setImmediate(done));
});

test("issue 680: cancellation at dispatch invalidates publication without a refusal or abort", async () => {
	__setPiHarnessKindForTesting("omp");
	const fake = createFakePi();
	const controller = new AbortController();
	let pass!: PiContextBudget;
	let failures = 0;
	const entries: unknown[] = [];
	registerPiGuardedContext(
		{
			...fake.pi,
			appendEntry: (...args: unknown[]) => entries.push(args),
		} as never,
		async (event, _ctx, budget) => {
			pass = budget;
			return { messages: event.messages };
		},
		{
			onRefusal: () => {
				failures++;
			},
		},
	);
	const ctx = hostContext(controller);
	const emit = (name: string, event: unknown = {}) =>
		(fake.handlers.get(name) as (event: unknown, ctx: unknown) => unknown)(
			event,
			ctx,
		);
	emit("agent_start");
	await emit("context", {
		messages: [userMessage("prepared but not sent", 1)],
	});
	expect(pass.completed).toBe(true);
	controller.abort();
	expect(() =>
		emit("before_provider_request", { payload: { messages: [] } }),
	).not.toThrow();
	expect(pass.completed).toBe(false);
	expect(pass.abandoned).toBe(true);
	expect(() => pass.assertDecisionPublication()).toThrow();
	expect({ failures, entries }).toEqual({ failures: 0, entries: [] });
});

test("issue 680: host AbortError without an exposed signal cancels rather than refusing", async () => {
	const fake = createFakePi();
	const entries: unknown[] = [];
	let pass!: PiContextBudget;
	let failures = 0;
	registerPiGuardedContext(
		{
			...fake.pi,
			appendEntry: (...args: unknown[]) => entries.push(args),
		} as never,
		async (_event, _ctx, budget) => {
			pass = budget;
			throw new DOMException("session aborted", "AbortError");
		},
		{
			onRefusal: () => {
				failures++;
			},
		},
	);
	const ctx = {
		...fakeContext(SESSION),
		signal: undefined,
		abort: () => {
			throw new Error("must not re-abort");
		},
	};
	const run = fake.handlers.get("context") as (
		event: unknown,
		ctx: unknown,
	) => Promise<unknown>;
	expect(await run({ messages: [] }, ctx)).toBeUndefined();
	expect(pass.abandoned).toBe(true);
	expect(pass.failureReason).toBeUndefined();
	expect({ failures, entries }).toEqual({ failures: 0, entries: [] });
});

test("issue 680: unrelated AbortError with a live turn signal remains a genuine refusal", async () => {
	const fake = createFakePi();
	const controller = new AbortController();
	const entries: unknown[] = [];
	let aborts = 0;
	let failures = 0;
	registerPiGuardedContext(
		{
			...fake.pi,
			appendEntry: (...args: unknown[]) => entries.push(args),
		} as never,
		async () => {
			throw new DOMException("unrelated operation aborted", "AbortError");
		},
		{
			onRefusal: () => {
				failures++;
			},
		},
	);
	const run = fake.handlers.get("context") as (
		event: unknown,
		ctx: unknown,
	) => Promise<unknown>;
	await run(
		{ messages: [] },
		{
			...hostContext(controller),
			ui: { notify: () => {} },
			abort: () => {
				aborts++;
			},
		},
	);
	expect(entries).toHaveLength(1);
	expect(aborts).toBe(1);
	expect(failures).toBe(1);
});

test("issue 680: cancelling an older pass does not revoke the replacement dispatch receipt", async () => {
	__setPiHarnessKindForTesting("omp");
	const fake = createFakePi();
	const older = new AbortController();
	const newer = new AbortController();
	const held = deferred();
	const entered = deferred();
	const entries: unknown[] = [];
	registerPiGuardedContext(
		{
			...fake.pi,
			appendEntry: (...args: unknown[]) => entries.push(args),
		} as never,
		async (event, ctx) => {
			if ((ctx as { signal?: AbortSignal }).signal === older.signal) {
				entered.resolve();
				await held.promise;
			}
			return { messages: event.messages };
		},
	);
	const emit = (name: string, ctx: unknown, event: unknown = {}) =>
		(fake.handlers.get(name) as (event: unknown, ctx: unknown) => unknown)(
			event,
			ctx,
		);
	const oldContext = hostContext(older);
	const newContext = hostContext(newer);
	emit("agent_start", oldContext);
	const pending = emit("context", oldContext, {
		messages: [userMessage("old", 1)],
	});
	await entered.promise;
	await emit("context", newContext, { messages: [userMessage("new", 2)] });
	older.abort();
	expect(await pending).toBeUndefined();
	held.resolve();
	expect(() =>
		emit("before_provider_request", newContext, {
			payload: { messages: [userMessage("new", 2)] },
		}),
	).not.toThrow();
	expect(entries).toEqual([]);
});

test("issue 680: a fresh live dispatch cannot reuse a cancelled pass", async () => {
	__setPiHarnessKindForTesting("omp");
	const fake = createFakePi();
	const older = new AbortController();
	const newer = new AbortController();
	const entries: unknown[] = [];
	let aborts = 0;
	registerPiGuardedContext(
		{
			...fake.pi,
			appendEntry: (...args: unknown[]) => entries.push(args),
		} as never,
		async (event) => ({ messages: event.messages }),
	);
	const emit = (name: string, ctx: unknown, event: unknown = {}) =>
		(fake.handlers.get(name) as (event: unknown, ctx: unknown) => unknown)(
			event,
			ctx,
		);
	const oldContext = hostContext(older);
	emit("agent_start", oldContext);
	await emit("context", oldContext, {
		messages: [userMessage("cancelled before dispatch", 1)],
	});
	older.abort();
	emit("before_provider_request", oldContext, { payload: { messages: [] } });
	expect(entries).toEqual([]);
	const refused = emit(
		"before_provider_request",
		{
			...hostContext(newer),
			ui: { notify: () => {} },
			abort: () => {
				aborts++;
			},
		},
		{ payload: { messages: [] } },
	);
	expect(entries).toHaveLength(1);
	assertPiRefusedDispatch(
		refused,
		(entries[0] as [unknown, { message: string }])[1].message,
	);
	expect(aborts).toBe(0);
});

test("issue 680: cancellation revokes an identity-matched receipt retained after an earlier run end", async () => {
	__setPiHarnessKindForTesting("omp");
	const fake = createFakePi();
	const controller = new AbortController();
	const raw = [
		userMessage("first", 1),
		assistantMessage("reply", 2),
		userMessage("continuation", 3),
	];
	const entries: unknown[] = [];
	let pass!: PiContextBudget;
	let aborts = 0;
	registerPiGuardedContext(
		{
			...fake.pi,
			appendEntry: (...args: unknown[]) => entries.push(args),
		} as never,
		async (event, _ctx, budget) => {
			pass = budget;
			return { messages: event.messages };
		},
	);
	const ctx = {
		...fakeContext(
			SESSION,
			process.cwd(),
			["first", "reply", "continuation"],
			raw,
		),
		signal: controller.signal,
		isIdle: () => false,
		ui: { notify: () => {} },
		abort: () => {
			aborts++;
		},
	};
	const emit = (name: string, event: unknown = {}, context: unknown = ctx) =>
		(fake.handlers.get(name) as (event: unknown, ctx: unknown) => unknown)(
			event,
			context,
		);
	const payload = { messages: structuredClone(raw) };
	emit("agent_start");
	emit("agent_start");
	await emit("context", { messages: structuredClone(raw) });
	emit("before_provider_request", { payload });
	expect({ entries, aborts }).toEqual({ entries: [], aborts: 0 });
	emit("agent_end", { messages: structuredClone(raw.slice(0, 2)) });
	emit("before_provider_request", { payload });
	expect({ entries, aborts, completed: pass.completed }).toEqual({
		entries: [],
		aborts: 0,
		completed: true,
	});
	controller.abort();
	expect(() => emit("before_provider_request", { payload })).not.toThrow();
	expect({
		entries,
		aborts,
		completed: pass.completed,
		abandoned: pass.abandoned,
	}).toEqual({ entries: [], aborts: 0, completed: false, abandoned: true });
	expect(() => pass.assertDecisionPublication()).toThrow();
	// Even an exact old payload cannot authorize a fresh live provider request.
	const refused = emit(
		"before_provider_request",
		{ payload },
		{ ...ctx, signal: new AbortController().signal },
	);
	expect(entries).toHaveLength(1);
	assertPiRefusedDispatch(
		refused,
		(entries[0] as [unknown, { message: string }])[1].message,
	);
	expect(aborts).toBe(0);
});
