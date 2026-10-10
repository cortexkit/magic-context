import { afterEach, describe, expect, it } from "bun:test";
import { CheckoutClaimRefusalError } from "@magic-context/core/features/magic-context/checkout-claim";
import { resetLkgSlotsForTest } from "@magic-context/core/hooks/magic-context/lkg-slot";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";

import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import { registerPiGuardedContext } from "./pi-context-refusal";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import {
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";

type PiHandler = (
	event: { messages: never[] },
	ctx: never,
) => Promise<{ messages: never[] } | undefined>;

const REFUSAL = new CheckoutClaimRefusalError({
	agentId: "agent_7",
	holder: "bb22cc33",
	epoch: 9,
});

/** Session-scoped rows Magic Context writes on an ordinary Pi pass. */
function sessionRows(db: ReturnType<typeof createTestDb>, sessionId: string) {
	const count = (table: string) =>
		(
			db
				.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`)
				.get(sessionId) as { n: number }
		).n;
	return { session_meta: count("session_meta"), tags: count("tags") };
}

describe("Pi context handler: checkout claim", () => {
	const sessions = new Set<string>();
	afterEach(() => {
		for (const sessionId of sessions) clearContextHandlerSession(sessionId);
		sessions.clear();
		__setPiHarnessKindForTesting(undefined);
		resetLkgSlotsForTest();
	});

	async function pass(
		sessionId: string,
		refusal: CheckoutClaimRefusalError | null,
	) {
		const db = createTestDb();
		sessions.add(sessionId);
		const asked: string[] = [];
		try {
			const fake = createFakePi();
			registerPiContextHandler(
				fake.pi as never,
				{ db },
				{
					checkoutClaim: {
						refusal: async (id: string, projectRoot: string) => {
							asked.push(`${id}@${projectRoot}`);
							return refusal;
						},
					},
				},
			);
			const handler = fake.handlers.get("context") as PiHandler;
			const raw = [userMessage("hello", 1)];
			const ctx = fakeContext(
				sessionId,
				"/work/project",
				["entry-1"],
				raw as never,
			);
			const result = await handler(
				{ messages: raw as never[] },
				ctx as never,
			).then(
				(value) => ({ ok: true as const, value }),
				(error: unknown) => ({ ok: false as const, error }),
			);
			await new Promise<void>((resolve) => setImmediate(resolve));
			return { result, asked, rows: sessionRows(db, sessionId) };
		} finally {
			closeQuietly(db);
		}
	}

	it("refuses a held-elsewhere session before the pass writes anything", async () => {
		const { result, asked, rows } = await pass("pi-claim-moved", REFUSAL);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toBe(REFUSAL);
		expect(asked).toEqual(["pi-claim-moved@/work/project"]);
		expect(rows).toEqual({ session_meta: 0, tags: 0 });
	});

	it("writes as usual for an admitted session (the empty-store assertion above is not vacuous)", async () => {
		const { result, rows } = await pass("pi-claim-here", null);
		expect(result.ok).toBe(true);
		expect(rows.session_meta).toBe(1);
	});

	for (const harness of ["pi", "omp"] as const) {
		it(`held-elsewhere refusal never schedules diagnostic storage writes [${harness}]`, async () => {
			const db = createTestDb();
			const sessionId = `claim-no-diagnostic-${harness}`;
			sessions.add(sessionId);
			__setPiHarnessKindForTesting(harness);
			try {
				const fake = createFakePi();
				const entries: unknown[] = [];
				let aborted = false;
				registerPiContextHandler(
					{
						...fake.pi,
						appendEntry: (_type: string, data: unknown) => entries.push(data),
					} as never,
					{ db },
					{ checkoutClaim: { refusal: async () => REFUSAL } },
				);
				const raw = [userMessage("work on a moved checkout", 1)];
				const ctx = {
					...fakeContext(sessionId, "/work/project", ["u"], raw),
					abort: () => {
						aborted = true;
					},
				};
				await (fake.handlers.get("context") as PiHandler)(
					{ messages: raw as never[] },
					ctx as never,
				);
				// Persisting the refused-turn error used to create session_meta on the
				// next event-loop tick. Drain that callback before checking for writes.
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(aborted).toBe(true);
				expect(entries).toEqual([{ message: REFUSAL.message }]);
				expect(sessionRows(db, sessionId)).toEqual({
					session_meta: 0,
					tags: 0,
				});
			} finally {
				closeQuietly(db);
			}
		});
	}
});

describe("Pi guarded context: checkout-claim refusal", () => {
	it("aborts the turn and shows the claim message instead of the generic retry text", async () => {
		const handlers = new Map<string, (...args: never[]) => unknown>();
		const entries: Array<{ type: string; data: unknown }> = [];
		const notices: Array<{ message: string; level: string }> = [];
		let aborted = 0;
		const pi = {
			on: (event: string, handler: (...args: never[]) => unknown) => {
				handlers.set(event, handler);
			},
			appendEntry: (type: string, data: unknown) =>
				entries.push({ type, data }),
		};
		registerPiGuardedContext(pi as never, async () => {
			throw REFUSAL;
		});
		const event = { messages: [] as never[] };
		const result = await (handlers.get("context") as PiHandler)(event, {
			hasUI: true,
			ui: {
				notify: (message: string, level: string) =>
					notices.push({ message, level }),
			},
			abort: () => {
				aborted += 1;
			},
		} as never);
		expect(aborted).toBe(1);
		expect(result).toEqual({ messages: event.messages });
		expect(entries).toEqual([
			{
				type: "magic-context-turn-refused",
				data: { message: REFUSAL.message },
			},
		]);
		expect(notices).toEqual([{ message: REFUSAL.message, level: "error" }]);
	});
});
