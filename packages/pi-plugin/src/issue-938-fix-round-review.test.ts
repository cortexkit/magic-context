/**
 * Review witness for the Pi compaction marker's kept entry, as decided by the
 * shared history cut (pi-history-cut.ts).
 *
 * The cut reads the context event's messages, which include the messages Pi
 * builds from `custom_message` entries (an extension's `sendMessage`) and from
 * `branch_summary` entries (a `/tree` move that summarizes the branch left).
 * The marker reads only the branch's `message` entries. When such a message sits
 * between a summary that ends a finished turn and the next prompt, the request
 * keeps it, but the marker starts at the next prompt and Pi stops loading it
 * once the marker lands.
 *
 * Skipped: fails on this code. The marker drain as of 1aca29b4dc chooses the
 * same kept entry, so the gap predates the shared cut. The review report
 * .cortexkit/internal-docs/audits/issue-938-fix-round-review.md describes it.
 */
import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import {
	getPendingPiCompactionMarkerState,
	setPendingPiCompactionMarkerState,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
	signalPiDeferredHistoryRefresh,
	signalPiDeferredMaterialization,
} from "./context-handler";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	userMessage,
} from "./test-utils.test";

const EXTENSION_NOTE = "EXTENSION NOTE: the build server moved to ck-motor";
const BRANCH_SUMMARY = "BRANCH SUMMARY: the abandoned attempt changed nothing";

function physicalContext(
	sessionManager: SessionManager,
	contextTokens: number,
) {
	return {
		cwd: process.cwd(),
		hasUI: false,
		signal: new AbortController().signal,
		ui: { notify: () => undefined },
		model: {
			provider: "anthropic",
			id: "claude-sonnet-4-5",
			contextWindow: 100_000,
		},
		sessionManager,
		getContextUsage: () => ({
			tokens: contextTokens,
			percent: contextTokens / 1_000,
			contextWindow: 100_000,
		}),
	};
}

/**
 * A finished turn ends the newest summary (ordinal 10). Before the next prompt,
 * the branch gains a message with no `message` entry: an extension's custom
 * message, or the summary of a branch the person left with `/tree`. The
 * historian's marker is pending without a kept entry, as publication stages it
 * when nothing follows the summary yet. The next step's execute pass consumes
 * the publication and lands the marker; the pass after it adds one prompt.
 */
async function markerAfterFinishedTurn(between: "custom" | "branch-summary") {
	const sessionDir = join(tmpdir(), `mc-938-fix-review-${crypto.randomUUID()}`);
	const sessionId = `ses-938-fix-review-${between}`;
	const sessionManager = SessionManager.create(process.cwd(), sessionDir, {
		id: sessionId,
	});
	const db = createTestDb();
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, {
		db,
		protectedTags: 0,
		scheduler: { executeThresholdPercentage: 65 },
		injection: { injectionBudgetTokens: 10_000, temporalAwareness: false },
	});
	const handler = fake.handlers.get("context") as (
		event: { messages: unknown[] },
		ctx: unknown,
	) => Promise<{ messages: unknown[] }>;
	const pass = async (contextTokens: number) => {
		updateSessionMeta(db, sessionId, {
			lastResponseTime: Date.now(),
			cacheTtl: "59m",
			lastContextPercentage: contextTokens / 1_000,
			lastInputTokens: contextTokens,
		});
		const input = structuredClone(
			sessionManager.buildSessionContext().messages,
		) as unknown[];
		return (
			await handler(
				{ messages: input },
				physicalContext(sessionManager, contextTokens),
			)
		).messages;
	};
	const base = Date.UTC(2026, 0, 1);
	const at = (n: number) => base + n * 60_000;
	try {
		const ids: string[] = [];
		for (let ordinal = 1; ordinal <= 10; ordinal++) {
			ids.push(
				sessionManager.appendMessage(
					(ordinal % 2 === 1
						? userMessage(
								`older request ${ordinal} ${"u".repeat(400)}`,
								at(ordinal),
							)
						: assistantMessage(
								`older answer ${ordinal} ${"a".repeat(400)}`,
								at(ordinal),
							)) as never,
				),
			);
		}
		const boundaryId = ids[9] as string;
		if (between === "custom") {
			// pi.sendMessage(..., { triggerTurn: false }) on an idle session.
			sessionManager.appendCustomMessageEntry(
				"some-extension",
				EXTENSION_NOTE,
				true,
			);
		} else {
			// A turn the person then left with `/tree`, summarizing it.
			sessionManager.appendMessage(
				userMessage("abandoned request", at(11)) as never,
			);
			sessionManager.appendMessage(
				assistantMessage("abandoned answer", at(12)) as never,
			);
			sessionManager.branchWithSummary(boundaryId, BRANCH_SUMMARY);
		}
		sessionManager.appendMessage(
			userMessage("NEXT PROMPT: carry on", at(13)) as never,
		);
		// The first request of the new turn, before the summary publishes.
		await pass(10_000);

		appendCompartments(db, sessionId, [
			{
				sequence: 0,
				startMessage: 1,
				endMessage: 10,
				startMessageId: ids[0] as string,
				endMessageId: boundaryId,
				title: "History",
				content: `History ${"c".repeat(800)}`,
			},
		]);
		setPendingPiCompactionMarkerState(db, sessionId, {
			endMessageId: boundaryId,
			firstKeptEntryId: null,
			ordinal: 10,
			publishedAt: at(13),
			summary: "Magic Context compacted: History",
			tokensBefore: 10_000,
		});
		signalPiDeferredHistoryRefresh(sessionId);
		signalPiDeferredMaterialization(sessionId);

		sessionManager.appendMessage(
			assistantMessage("Carrying on.", at(14)) as never,
		);
		const rebuild = await pass(70_000);
		const landed = getPendingPiCompactionMarkerState(db, sessionId) === null;

		sessionManager.appendMessage(
			userMessage("another prompt", at(15)) as never,
		);
		const next = await pass(10_000);
		return { rebuild, next, landed };
	} finally {
		clearContextHandlerSession(sessionId);
		closeQuietly(db);
		rmSync(sessionDir, { recursive: true, force: true });
	}
}

describe("issue 938 fix-round review: a marker never hides a message the request keeps", () => {
	// The request serves the message between the summary and the next prompt;
	// the marker that lands on the execute pass starts at that prompt, so on the
	// pass after it Pi no longer loads the message: the request loses it (the
	// model never sees it again, and no summary covers it) and changes bytes
	// right after the history head. That later pass runs at 10% usage with no
	// publication or flush to ride, so it may not change any earlier byte: it
	// should only append the new prompt to what the execute pass sent.
	const variants = {
		custom: EXTENSION_NOTE,
		"branch-summary": BRANCH_SUMMARY,
	} as const;
	for (const [between, text] of Object.entries(variants) as Array<
		[keyof typeof variants, string]
	>) {
		test.skip(`WITNESS (${between}): the pass after the marker lands keeps the rebuild's bytes`, async () => {
			const { rebuild, next, landed } = await markerAfterFinishedTurn(between);
			expect(landed).toBe(true);
			expect(JSON.stringify(rebuild)).toContain(text);
			expect(JSON.stringify(next)).toContain(text);
			expect(next.slice(0, -1)).toEqual(rebuild);
		});
	}
});
