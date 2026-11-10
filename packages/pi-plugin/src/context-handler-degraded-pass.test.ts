import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as applyOperations from "@magic-context/core/hooks/magic-context/apply-operations";
import { resetLkgSlotsForTest } from "@magic-context/core/hooks/magic-context/lkg-slot";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import * as tagTranscriptModule from "@magic-context/core/shared/tag-transcript";
import { IssuePrivacy } from "../../cli/src/lib/issue-privacy";

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
					expect(result.error).toMatchObject({
						name: "PiDegradedPassError",
						site:
							stage === "tagging"
								? "tagging-persistence-failure"
								: "flushed-status-failure",
					});
					expect((result.error as Error).message).not.toContain(
						"storage is busy",
					);
					expect((result.error as Error).message).not.toContain(
						"send your message again",
					);
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
				name: "PiDegradedPassError",
				site: "context-handler-failed",
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
		if (!result.ok) {
			expect(result.error).toMatchObject({
				name: "PiDegradedPassError",
				site: "context-handler-failed",
			});
			expect((result.error as Error).message).toContain(
				"ordinary transform defect",
			);
			expect((result.error as Error).message).not.toContain("storage is busy");
			expect((result.error as Error).message).not.toContain(
				"send your message again",
			);
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

	it("issue output keeps Pi failure wording without prompt, tool or provider canaries", async () => {
		const canary =
			"PRIVATE_PI_PROMPT PRIVATE_PI_FILE PRIVATE_PI_TOOL /home/PRIVATE_PI_HOME/private.env API_KEY=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
		const { result, logLines } = await runFailingPass(
			"ses_PRIVATE_PI_SESSION",
			{
				resolveForProject: () => {
					throw new TypeError(canary);
				},
			},
			[userMessage(canary, 1)],
		);
		expect(result.ok).toBe(false);
		expect(logLines.join("\n")).toContain("DEGRADED PASS");
		const privacy = new IssuePrivacy({});
		const output = logLines
			.map((line) =>
				privacy.logLine(
					`[2026-09-05T10:41:07.130Z] [magic-context][ses_PRIVATE_PI_SESSION] ${line}`,
				),
			)
			.join("\n");
		expect(output).toContain("DEGRADED PASS");
		for (const token of [
			"PRIVATE_PI_PROMPT",
			"PRIVATE_PI_FILE",
			"PRIVATE_PI_TOOL",
			"PRIVATE_PI_HOME",
			"PRIVATE_PI_SESSION",
			"ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
		])
			expect(output).not.toContain(token);
	});
});
