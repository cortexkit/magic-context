import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as applyOperations from "@magic-context/core/hooks/magic-context/apply-operations";
import { resetLkgSlotsForTest } from "@magic-context/core/hooks/magic-context/lkg-slot";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import * as tagTranscriptModule from "@magic-context/core/shared/tag-transcript";

import {
	clearContextHandlerSession,
	__test as contextHandlerInternals,
	registerPiContextHandler,
} from "./context-handler";
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

const MODEL = {
	provider: "openai-codex",
	id: "gpt-5.6-sol",
	contextWindow: 272000,
	maxTokens: 68000,
};

describe("Pi context handler never serves a degraded pass", () => {
	const sessions = new Set<string>();

	afterEach(() => {
		for (const sessionId of sessions) clearContextHandlerSession(sessionId);
		sessions.clear();
		resetLkgSlotsForTest();
	});

	async function runFailingPass(
		sessionId: string,
		options: Parameters<typeof registerPiContextHandler>[1] extends infer O
			? Omit<O, "db">
			: never,
		raw: unknown[],
	) {
		const db = createTestDb();
		sessions.add(sessionId);
		const logLines: string[] = [];
		const restoreLog =
			contextHandlerInternals.setLkgRecoveryLogObserverForTests((line) =>
				logLines.push(line),
			);
		try {
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, { db, ...options });
			const handler = fake.handlers.get("context") as PiHandler;
			const ctx = fakeContext(
				sessionId,
				process.cwd(),
				["entry-1"],
				raw as never,
			);
			Object.assign(ctx, { model: MODEL });
			const result = await handler(
				{ messages: raw as never[] },
				ctx as never,
			).then(
				(value) => ({ ok: true as const, value }),
				(error: unknown) => ({ ok: false as const, error }),
			);
			return { result, logLines };
		} finally {
			restoreLog();
			closeQuietly(db);
		}
	}

	for (const stage of ["tagging", "drop replay"] as const) {
		it(`refuses instead of falling through to Pi's messages when ${stage} fails`, async () => {
			const spy =
				stage === "tagging"
					? spyOn(tagTranscriptModule, "tagTranscript").mockImplementation(
							() => {
								throw new Error(
									"UNIQUE constraint failed: tags.session_id, tags.tag_number",
								);
							},
						)
					: spyOn(applyOperations, "applyFlushedStatuses").mockImplementation(
							() => {
								throw new Error("flushed status replay failed");
							},
						);
			try {
				const { result, logLines } = await runFailingPass(
					`pi-degraded-${stage.replace(" ", "-")}`,
					{},
					[userMessage("hello", 1)],
				);
				expect(spy).toHaveBeenCalled();
				expect(result.ok).toBe(false);
				if (!result.ok) {
					expect(result.error).toMatchObject({ name: "PiStorageBusyError" });
					expect((result.error as { cause?: unknown }).cause).toMatchObject({
						name: "PiDegradedPassError",
						site:
							stage === "tagging"
								? "tagging-persistence-failure"
								: "flushed-status-failure",
					});
				}
				expect(logLines.join("\n")).toContain("DEGRADED PASS");
			} finally {
				spy.mockRestore();
			}
		});
	}

	it("refuses an ordinary failure's raw fallthrough when the messages alone exceed the limit", async () => {
		const raw = [userMessage("word ".repeat(300000), 1)];
		const { result } = await runFailingPass(
			"pi-degraded-raw-over-limit",
			{
				resolveForProject: () => {
					throw new Error("ordinary transform defect");
				},
			},
			raw,
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toMatchObject({
				name: "PiStorageBusyError",
				cause: { name: "PiDegradedPassError", site: "context-handler-failed" },
			});
		}
	});

	it("refuses an ordinary failure even when the raw messages fit", async () => {
		const { result } = await runFailingPass(
			"pi-degraded-raw-fits",
			{
				resolveForProject: () => {
					throw new Error("ordinary transform defect");
				},
			},
			[userMessage("hello", 1)],
		);
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.error).toMatchObject({
				name: "PiStorageBusyError",
				cause: { name: "PiDegradedPassError", site: "context-handler-failed" },
			});
	});

	it("names the real cause when refusing an ordinary failure whose LKG is unavailable (issue #723)", async () => {
		const raw = [userMessage("hello", 1)];
		const { result } = await runFailingPass(
			"pi-degraded-named-cause",
			{
				resolveForProject: () => {
					throw new Error("ordinary transform defect");
				},
			},
			raw,
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toMatchObject({ name: "PiStorageBusyError" });
			const message = (result.error as { message?: string }).message ?? "";
			// The refusal must no longer claim a busy store when the store is fine:
			// a corrupt ledger surfaced as unexplainable "storage is busy" here.
			expect(message).toContain("could not safely prepare this turn");
			expect(message).toContain("ordinary transform defect");
			expect(message).not.toContain("storage is busy");
		}
	});

	it("passes through an ordinary failure when compaction is off", async () => {
		const { result } = await runFailingPass(
			"pi-degraded-off",
			{
				compactionOff: true,
				resolveForProject: () => {
					throw new Error("ordinary transform defect");
				},
			},
			[userMessage("hello", 1)],
		);
		expect(result).toEqual({ ok: true, value: undefined });
	});
});
