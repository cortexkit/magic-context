import { afterEach, describe, expect, it } from "bun:test";
import {
	getOrCreateSessionMeta,
	getTagsBySession,
	queuePendingOp,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { readReplayEnvelope } from "@magic-context/core/features/magic-context/storage-replay-document";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import type { Database } from "@magic-context/core/shared/sqlite";
import { handlePiCloneSessionStart } from "./clone-inheritance";
import {
	clearContextHandlerSession,
	__test as handlerTest,
	registerPiContextHandler,
} from "./context-handler";
import { clearPiChannel1State } from "./ctx-reduce-nudge-pi";
import { recordPiSpawnedSession } from "./pi-agent-identity";
import { clearPiSystemPromptSession } from "./system-prompt";
import {
	assistantMessage,
	assistantToolCall,
	createFakePi,
	createTestDb,
	type PiMessage,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

// Two guards on how Pi and Oh My Pi sessions follow whether ctx_reduce is in
// the request's tool list. A request whose tool list did not change gets no
// rebuild, even when storing which answer the last request was built with
// failed. And an Oh My Pi session forked from another one (it runs as a
// spawned session) keeps the history it inherited from its source session.
// Each test's comment says what must hold, not how the code achieves it.

const WINDOW = 200_000;
const TOOLS = [
	{
		name: "bash",
		description: "Run a command",
		parameters: { type: "object", properties: { command: { type: "string" } } },
	},
	{
		name: "ctx_reduce",
		description: "Mark tags for dropping",
		parameters: { type: "object", properties: { drop: { type: "string" } } },
	},
];
const WITH_REDUCE = ["bash", "ctx_reduce"];
const WITHOUT_REDUCE = ["bash"];

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

interface Pass {
	bytes: string;
	permitted: boolean;
}

/**
 * One Pi session behind the real context handler, with a host tool list the
 * test can change between requests. The system prompt never changes, so a
 * rebuild can only come from the tool list.
 */
function session(
	db: Database,
	sessionId: string,
	messages: PiMessage[],
	ids: string[],
) {
	let active = [...WITH_REDUCE];
	const fake = createFakePi();
	Object.assign(fake.pi, {
		getAllTools: () => TOOLS,
		getActiveTools: () => [...active],
		sendMessage: () => undefined,
	});
	registerPiContextHandler(fake.pi as never, {
		db,
		tagger: createTagger(),
		protectedTokens: 4000,
		injection: {
			injectionBudgetTokens: 1000,
			memoryEnabled: false,
			injectDocs: false,
		},
		scheduler: { executeThresholdPercentage: 65 },
	});
	const handler = fake.handlers.get("context") as (
		event: { messages: PiMessage[] },
		ctx: never,
	) => Promise<{ messages: PiMessage[] } | undefined>;
	cleanups.push(() => {
		clearContextHandlerSession(sessionId);
		clearPiSystemPromptSession(sessionId);
		clearPiChannel1State(sessionId);
	});
	const serve = async (percent = 10): Promise<Pass> => {
		updateSessionMeta(db, sessionId, {
			lastResponseTime: Date.now(),
			lastContextPercentage: percent,
			lastInputTokens: Math.round((WINDOW * percent) / 100),
		});
		const request = structuredClone(messages);
		const branch = ids.map((id, index) => ({
			type: "message",
			id,
			parentId: ids[index - 1] ?? null,
			message: request[index],
		}));
		const ctx = {
			cwd: process.cwd(),
			hasUI: true,
			signal: new AbortController().signal,
			ui: { notify: () => undefined },
			sessionManager: {
				getSessionId: () => sessionId,
				getLeafId: () => ids.at(-1),
				getBranch: () => branch,
				getEntries: () => branch,
			},
			getSystemPrompt: () => "Synthetic host prompt for the issue 904 review.",
			model: {
				provider: "openai",
				id: "gpt-4.1",
				api: "openai-completions",
				contextWindow: WINDOW,
			},
			getContextUsage: () => ({
				tokens: Math.round((WINDOW * percent) / 100),
				percent,
				contextWindow: WINDOW,
			}),
		};
		let permitted = false;
		const restore = handlerTest.setPipelineResultObserverForTests(
			(id, result) => {
				if (id === sessionId) permitted = result.prefixBustPermitted;
			},
		);
		try {
			const result = await handler({ messages: request }, ctx as never);
			return {
				bytes: JSON.stringify(result?.messages ?? request),
				permitted,
			};
		} finally {
			restore();
		}
	};
	return {
		serve,
		setActive: (next: string[]) => {
			active = [...next];
		},
	};
}

/** Tag prefixes the request carries, such as `§3§ `. */
function prefixes(bytes: string): string[] {
	return bytes.match(/§\d+§ /g) ?? [];
}

describe("issue 904 review: the served ctx_reduce record", () => {
	// ctx-reduce-callable-pi.ts, recordServedPiCtxReduceCallable: the
	// in-memory answer advances only after updateReplayDocument returns. When
	// the write throws (a locked or failing database), context-handler.ts's
	// afterCapture swallows the error and the in-memory answer still names the
	// old tool list, so the next request, whose tool list did not change, is
	// treated as a change again: one more rebuild that queued drops and
	// cleanup ride. On a model whose signed thinking is only valid behind an
	// unchanged request prefix (isPrefixBoundThinkingModel), that rebuild also
	// strips the thinking the pass would otherwise have kept. Fixed when a
	// request whose tool list did not change after a served change gets no
	// rebuild, whatever happened to the stored record.
	it("a failed record write does not make the next unchanged request a rebuild", async () => {
		const db = createTestDb();
		cleanups.push(() => db.close());
		const sessionId = "issue-904-review-record-write";
		getOrCreateSessionMeta(db, sessionId);
		updateSessionMeta(db, sessionId, {
			piStableIdScheme: 1,
			lastResponseTime: Date.now(),
			cacheTtl: "never",
		});
		// One large old tool output, then enough newer tool output to fill the
		// protected window (4,000 tokens of tool output), so a queued drop of
		// the old output can land on any pass with rebuild permission.
		const messages: PiMessage[] = [
			userMessage("read the big log", 1),
			assistantToolCall("old-call", "bash", { command: "cat big.log" }, 2),
			{
				...toolResultMessage("old-call", "log line ".repeat(4_000), 3),
				toolName: "bash",
			} as PiMessage,
		];
		const ids = ["first", "old-assistant", "old-result"];
		for (let index = 0; index < 10; index++) {
			messages.push(
				assistantToolCall(
					`step-call-${index}`,
					"bash",
					{ command: `step ${index}` },
					40 + index * 2,
				),
				{
					...toolResultMessage(
						`step-call-${index}`,
						`step ${index}: ${"detail ".repeat(600)}`,
						41 + index * 2,
					),
					toolName: "bash",
				} as PiMessage,
			);
			ids.push(`step-assistant-${index}`, `step-result-${index}`);
		}
		messages.push(userMessage("continue", 70));
		ids.push("continue");
		const s = session(db, sessionId, messages, ids);
		await s.serve();
		const before = await s.serve();
		expect(before.permitted).toBe(false);
		expect(prefixes(before.bytes).length).toBeGreaterThan(0);

		// The database refuses only the write that would record the new answer.
		db.exec(`CREATE TRIGGER issue_904_review_record_write
			BEFORE UPDATE OF trailing_blank_decisions ON session_meta
			WHEN NEW.trailing_blank_decisions LIKE '%piCtxReduceCallable%'
			BEGIN SELECT RAISE(ABORT, 'database is locked'); END`);
		s.setActive(WITHOUT_REDUCE);
		const removed = await s.serve();
		db.exec("DROP TRIGGER issue_904_review_record_write");
		expect(removed.permitted).toBe(true);
		expect(prefixes(removed.bytes)).toEqual([]);
		// The record was not written.
		expect(
			readReplayEnvelope(db, sessionId, "read").piCtxReduceCallable,
		).toBeUndefined();

		// A drop queued after the change must wait for a real rebuild.
		const old = getTagsBySession(db, sessionId).find(
			(row) => row.type === "tool" && row.messageId === "old-call",
		);
		if (!old) throw new Error("the old tool output has no tag");
		queuePendingOp(db, sessionId, old.tagNumber, "drop");
		const next = await s.serve();
		expect(next.permitted).toBe(false);
		expect(next.bytes).toBe(removed.bytes);
		expect(
			getTagsBySession(db, sessionId).find(
				(row) => row.tagNumber === old.tagNumber,
			)?.status,
		).toBe("active");
	});
});

describe("issue 904 review: Oh My Pi spawned sessions", () => {
	// pi-agent-identity.ts records every session whose first event has
	// ctx.agent.kind "sub" as a subagent, and context-handler.ts then gives a
	// subagent no history head. Oh My Pi also runs forks of a session as
	// "sub": a `/tan` clone (SessionManager.forkFrom of the current session)
	// and a seance task child (forkFrom of an earlier session). Magic Context's
	// clone inheritance copies the source session's compartments into the fork
	// at session_start, right before the record (index.ts session_start). Before
	// this change the fork rendered those compartments in its history head;
	// now the fork's request carries none of them, so the history it was
	// forked to work from is gone (Pi's own compaction entry holds only up to
	// five compartment titles). Fixed when a fork that inherited compartments
	// still renders them, the same as a fork recorded as "main" does.
	it("a forked child keeps the history it inherited from its source session", async () => {
		const db = createTestDb();
		cleanups.push(() => db.close());
		const source = "019f0000-1111-7000-8000-000000000904";
		db.prepare(
			`INSERT INTO compartments
			 (session_id, sequence, start_message, end_message, start_message_id,
			  end_message_id, title, content, p1, p2, p3, p4, importance,
			  episode_type, legacy, created_at, harness)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			source,
			1,
			1,
			2,
			"u1",
			"a1",
			"Inherited compartment",
			"FORKED-HISTORY-MARKER full content",
			"FORKED-HISTORY-MARKER p1",
			"FORKED-HISTORY-MARKER p2",
			null,
			null,
			73,
			"feature",
			0,
			1001,
			"pi",
		);
		const render = async (
			child: string,
			agent: { kind: "main" | "sub" },
		): Promise<string> => {
			const messages: PiMessage[] = [
				userMessage("u1 the work the parent did", 1),
				assistantMessage("a1 the parent's answer", 2),
				userMessage("u2 the fork's own request", 3),
			];
			const ids = ["u1", "a1", "u2"];
			const branch = ids.map((id, index) => ({
				type: "message",
				id,
				parentId: ids[index - 1] ?? null,
				message: messages[index],
			}));
			// index.ts session_start: inherit, then record the spawned session.
			const inherited = await handlePiCloneSessionStart(
				{},
				{
					sessionManager: {
						getSessionId: () => child,
						getHeader: () => ({ parentSession: source }),
						getBranch: () => branch,
					},
				},
				{ db, signalPendingMarker: () => {}, writeLog: () => {} },
			);
			expect(inherited?.kind).toBe("migrated");
			recordPiSpawnedSession(db, child, {
				agent: {
					...agent,
					id: agent.kind === "sub" ? "Tan-1" : "Main",
					name: agent.kind === "sub" ? "sub" : "main",
					depth: 0,
				},
			});
			updateSessionMeta(db, child, {
				piStableIdScheme: 1,
				lastResponseTime: Date.now(),
				cacheTtl: "never",
			});
			const s = session(db, child, messages, ids);
			return (await s.serve()).bytes;
		};

		// Control: the same fork run as "main" renders the inherited history.
		const asMain = await render("issue-904-review-fork-main", {
			kind: "main",
		});
		expect(asMain).toContain("<session-history");
		expect(asMain).toContain("FORKED-HISTORY-MARKER");

		const asSub = await render("issue-904-review-fork-sub", { kind: "sub" });
		expect(asSub).toContain("FORKED-HISTORY-MARKER");
	});
});
