/**
 * Issue 889 on Pi. A pass in provider-overflow recovery that cannot reclaim
 * enough must not send a request over the model's window. Pi otherwise refuses
 * only a request whose byte count proves it is over the whole context window;
 * dense text (many tokens per byte) passes that check while its token count is
 * far over the window. Pi never arms recovery by itself when the person
 * switches to a smaller model (OpenCode does), so a provider overflow is the
 * recovery tested here.
 */

import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { updateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import {
	getOverflowState,
	recordOverflowDetected,
	resetEmergencyRecoveryRegistryForTest,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { EmergencyFailClosedError } from "@magic-context/core/hooks/magic-context/emergency-fail-closed";
import {
	_resetHarnessForTesting,
	setHarness,
} from "@magic-context/core/shared/harness";
import * as logger from "@magic-context/core/shared/logger";
import {
	clearContextHandlerSession,
	recordPiLiveModel,
	registerPiContextHandler,
} from "./context-handler";
import { resolvePiWindowGeometry } from "./pi-context-limit";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";
import { tokenizePiMessages } from "./tokenize-pi-messages";

beforeEach(() => {
	_resetHarnessForTesting();
	setHarness("pi");
});
afterEach(_resetHarnessForTesting);

const sessionId = "issue-889-pi-recovery";
const modelKey = "mock/mock";
const model = { provider: "mock", id: "mock", contextWindow: 100_000 };

/** Deterministic random words: several tokens per word, under four bytes per token. */
function denseText(seed: number, words: number): string {
	let state = seed;
	const out: string[] = [];
	for (let i = 0; i < words; i++) {
		state = (state * 1103515245 + 12345) % 2147483648;
		out.push(state.toString(36));
	}
	return out.join(" ");
}

function fixture(turns: number) {
	const db = createTestDb();
	updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
	const fake = createFakePi();
	const pi = {
		...fake.pi,
		getAllTools: () => [
			{
				name: "read",
				description: "Read a file",
				parameters: { type: "object" },
			},
		],
	};
	registerPiContextHandler(pi as never, {
		db,
		protectedTags: 0,
		heuristics: {},
		scheduler: { executeThresholdPercentage: 65 },
	});
	const handler = fake.handlers.get("context");
	if (!handler) throw new Error("missing context handler");
	const messages = [userMessage("Review the records", 1)];
	for (let i = 0; i < turns; i++)
		messages.push(
			assistantMessage(`Record ${i}: ${denseText(i + 1, 2_500)}`, i + 2),
		);
	messages.push(userMessage("Continue", turns + 2));
	return {
		db,
		async run(tokens: number) {
			const ids = messages.map((_, i) => `entry-${i}`);
			const base = fakeContext(sessionId, process.cwd(), ids, messages);
			const branch = base.sessionManager.getBranch().map((entry, i) => ({
				...entry,
				parentId: i ? `entry-${i - 1}` : null,
			}));
			const ctx = {
				...base,
				sessionManager: {
					...base.sessionManager,
					getBranch: () => branch,
					getEntry: (id: string) => branch.find((entry) => entry.id === id),
					getLeafId: () => branch.at(-1)?.id,
				},
				model,
				getSystemPrompt: () => "You are a helpful assistant.",
				getContextUsage: () => ({
					tokens,
					percent: (tokens / model.contextWindow) * 100,
					contextWindow: model.contextWindow,
				}),
			};
			recordPiLiveModel(sessionId, modelKey);
			return (await handler(
				{ messages: [...messages] } as never,
				ctx as never,
			)) as {
				messages: unknown[];
			};
		},
		close() {
			clearContextHandlerSession(sessionId);
			resetEmergencyRecoveryRegistryForTest();
			db.close();
		},
	};
}

const usableHard = () =>
	resolvePiWindowGeometry({ rawContextWindow: model.contextWindow, model })
		?.usableHard ?? 0;

/** Serve a provider-overflow recovery pass; returns its message tokens or the refusal. */
async function recoveryPass(f: ReturnType<typeof fixture>) {
	await f.run(40_000);
	// The provider rejected the next request as too long.
	recordOverflowDetected(
		f.db,
		sessionId,
		undefined,
		modelKey,
		"provider_overflow",
	);
	try {
		const result = await f.run(40_000);
		const counts = tokenizePiMessages(result.messages as never);
		return {
			served: counts.conversation + counts.toolCall,
			refusal: undefined,
		};
	} catch (error) {
		return { served: undefined, refusal: error };
	}
}

it("refuses a provider-overflow recovery pass whose request is still over the window (issue 889)", async () => {
	const f = fixture(16);
	const log = spyOn(logger, "sessionLog");
	try {
		const { served, refusal } = await recoveryPass(f);
		if (served !== undefined)
			console.log(
				`ISSUE889_PI sent a recovery request of about ${served} message tokens; 95% line ${Math.floor(usableHard() * 0.95)}, window ${model.contextWindow}`,
			);
		expect(served).toBeUndefined();
		expect(refusal).toBeInstanceOf(EmergencyFailClosedError);
		expect((refusal as Error).message).toBe(
			"Magic Context is still summarizing older history so this conversation fits the model's context window. Send your message again to continue.",
		);
		expect(
			log.mock.calls.some(([, line]) =>
				String(line).includes("recovery request still over the window"),
			),
		).toBe(true);
		const overflow = getOverflowState(f.db, sessionId);
		expect(overflow.needsEmergencyRecovery).toBe(true);
		expect(overflow.emergencyRecoveryOrigin).toBe("provider_overflow");
	} finally {
		log.mockRestore();
		f.close();
	}
});

it("sends a provider-overflow recovery request that fits under the 95% line", async () => {
	const f = fixture(3);
	try {
		const { served, refusal } = await recoveryPass(f);
		expect(refusal).toBeUndefined();
		expect(served ?? 0).toBeGreaterThan(0);
		expect(served ?? Number.POSITIVE_INFINITY).toBeLessThan(
			usableHard() * 0.95,
		);
	} finally {
		f.close();
	}
});
