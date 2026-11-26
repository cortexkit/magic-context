// Fixture for tests of the emergency tool drop when the provider's usage
// reading differs from our own count of the request: a session of tool steps served
// through the real context handler at a chosen usage reading. No tests of its
// own.
import { spyOn } from "bun:test";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import {
	getTagsBySession,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { resetEmergencyRecoveryRegistryForTest } from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import * as logger from "@magic-context/core/shared/logger";
import {
	clearContextHandlerSession,
	recordPiLiveModel,
	registerPiContextHandler,
	signalPiHistoryRefresh,
} from "./context-handler";
import { clearPiLkgSessionState } from "./pi-lkg";
import { clearPiServedArraySession } from "./served-array-ledger";
import {
	createFakePi,
	createTestDb,
	fakeContext,
	type PiMessage,
} from "./test-utils.test";

export const WINDOW = 40_000;
/** contextLimit × the default 65% execute threshold. */
export const CEILING = Math.floor(WINDOW * 0.65);

export const SYSTEM_PROMPT =
	"You are a careful coding agent. Read the project rules before you edit, run the tests after every change, and report what you changed.\n".repeat(
		45,
	);

export const TOOLS = [
	{
		name: "bash",
		description: `Run a shell command in the project directory. ${"Use it for builds, tests and git. ".repeat(70)}`,
		parameters: {
			type: "object",
			properties: { command: { type: "string" } },
		},
	},
	{
		name: "read",
		description: "Read a file from the project.",
		parameters: {
			type: "object",
			properties: { path: { type: "string" } },
		},
	},
];

export function bashOutput(step: number, lines = 85): string {
	const out: string[] = [];
	for (let line = 0; line < lines; line++)
		out.push(
			`[build ${step}] line ${line}: compiling module m${line} of package p${step} with 2 warnings`,
		);
	return out.join("\n");
}

export function readOutput(step: number): string {
	return `export const value${step} = ${step};\n`.repeat(20);
}

export interface StepShape {
	/** Every `readEvery`-th step is a small `read`; the others are `bash`. */
	readEvery?: number;
	bashLines?: number;
	/** Thinking before each tool call (unsigned unless a signature is given). */
	thinking?: (step: number) => { text: string; signature?: string } | undefined;
	/** Number of images in each tool result. */
	images?: (step: number) => number;
	assistant?: { provider: string; model: string; api: string };
	/**
	 * End on the last tool result, in the middle of the turn, instead of a
	 * closing assistant reply and a new user message.
	 */
	endWithToolResult?: boolean;
}

export interface Session {
	messages: () => PiMessage[];
	ids: string[];
	callIds: string[];
	toolOf: Map<string, "bash" | "read">;
}

/**
 * A user task followed by `steps` tool steps, then a short assistant reply
 * and a user follow-up, so only those two messages are newer than the
 * provider reading.
 */
export function buildSession(steps: number, shape: StepShape = {}): Session {
	const readEvery = shape.readEvery ?? 4;
	const template: PiMessage[] = [];
	const ids: string[] = [];
	const callIds: string[] = [];
	const toolOf = new Map<string, "bash" | "read">();
	const assistantExtra = shape.assistant ?? {
		provider: "mock",
		model: "mock",
		api: "test-api",
	};
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	template.push({
		role: "user",
		content: "Fix the build and keep the tests green.",
		timestamp: 1,
	} as PiMessage);
	ids.push("u-task");
	for (let step = 0; step < steps; step++) {
		const tool = step % readEvery === readEvery - 1 ? "read" : "bash";
		const callId = `call-${step}`;
		callIds.push(callId);
		toolOf.set(callId, tool);
		const thinking = shape.thinking?.(step);
		const content: unknown[] = [];
		if (thinking)
			content.push({
				type: "thinking",
				thinking: thinking.text,
				...(thinking.signature
					? { thinkingSignature: thinking.signature }
					: {}),
			});
		content.push({
			type: "toolCall",
			id: callId,
			name: tool,
			arguments:
				tool === "bash"
					? { command: `make step-${step}` }
					: { path: `src/f${step}.ts` },
		});
		template.push({
			role: "assistant",
			content,
			...assistantExtra,
			usage,
			stopReason: "toolUse",
			timestamp: 10 + step * 2,
		} as unknown as PiMessage);
		ids.push(`a-${step}`);
		const resultContent: unknown[] = [
			{
				type: "text",
				text:
					tool === "bash"
						? bashOutput(step, shape.bashLines)
						: readOutput(step),
			},
		];
		for (let image = 0; image < (shape.images?.(step) ?? 0); image++)
			resultContent.push({
				type: "image",
				mimeType: "image/png",
				data: `${"iVBORw0KGgo".repeat(40)}${step}-${image}`,
			});
		template.push({
			role: "toolResult",
			toolCallId: callId,
			toolName: tool,
			content: resultContent,
			isError: false,
			timestamp: 11 + step * 2,
		} as unknown as PiMessage);
		ids.push(`r-${step}`);
	}
	if (!shape.endWithToolResult) {
		template.push({
			role: "assistant",
			content: [{ type: "text", text: "The build still fails in one module." }],
			...assistantExtra,
			usage,
			stopReason: "stop",
			timestamp: 10 + steps * 2,
		} as unknown as PiMessage);
		ids.push("a-final");
		template.push({
			role: "user",
			content: "Keep going.",
			timestamp: 11 + steps * 2,
		} as PiMessage);
		ids.push("u-next");
	}
	return {
		messages: () => structuredClone(template),
		ids,
		callIds,
		toolOf,
	};
}

export interface HarnessOptions {
	sessionId: string;
	session: Session;
	/** Render the history head (m[0]/m[1]); off means no head, as for a subagent. */
	injection?: boolean;
	subagent?: boolean;
	/** Offer the tool registry, so the system prompt and tools can be sized. */
	tools?: boolean;
	systemPrompt?: string;
	model?: { provider: string; id: string; api?: string };
}

export interface Harness {
	db: ReturnType<typeof createTestDb>;
	lines: string[];
	pass: (tokens: number) => Promise<unknown[]>;
	/** Change the host's system prompt from the next pass on. */
	setSystemPrompt: (prompt: string) => void;
	/** Serve a longer version of the session (more steps) from the next pass on. */
	setSession: (next: Session) => void;
	/** Publish a compartment covering the session through `endId`. */
	publishThrough: (endId: string) => void;
	statuses: () => Map<string, string>;
	close: () => void;
}

export function createHarness(options: HarnessOptions): Harness {
	const { sessionId } = options;
	let session = options.session;
	const db = createTestDb();
	const lines: string[] = [];
	const log = spyOn(logger, "sessionLog").mockImplementation((id, ...parts) => {
		if (id === sessionId) lines.push(parts.map(String).join(" "));
	});
	updateSessionMeta(db, sessionId, {
		piStableIdScheme: 1,
		...(options.subagent ? { isSubagent: true } : {}),
	});
	const model = options.model ?? { provider: "mock", id: "mock" };
	const fake = createFakePi();
	if (options.tools !== false)
		Object.assign(fake.pi, {
			getAllTools: () => TOOLS,
			getActiveTools: () => TOOLS.map((tool) => tool.name),
		});
	registerPiContextHandler(
		fake.pi as never,
		{
			db,
			tagger: createTagger(),
			protectedTags: 0,
			heuristics: {},
			scheduler: { executeThresholdPercentage: 65 },
			...(options.injection
				? {
						injection: {
							injectionBudgetTokens: 1000,
							memoryEnabled: false,
							injectDocs: false,
						},
					}
				: {}),
		} as never,
	);
	const handler = fake.handlers.get("context") as (
		event: { messages: unknown[] },
		ctx: never,
	) => Promise<{ messages: unknown[] } | undefined>;
	let systemPrompt = options.systemPrompt ?? SYSTEM_PROMPT;
	return {
		db,
		lines,
		setSystemPrompt(prompt) {
			systemPrompt = prompt;
		},
		setSession(next) {
			session = next;
		},
		async pass(tokens) {
			const messages = session.messages();
			recordPiLiveModel(sessionId, `${model.provider}/${model.id}`);
			updateSessionMeta(db, sessionId, {
				lastResponseTime: Date.now(),
				cacheTtl: "59m",
				lastContextPercentage: (tokens / WINDOW) * 100,
				lastInputTokens: tokens,
			});
			const result = await handler({ messages }, {
				...fakeContext(sessionId, process.cwd(), session.ids, messages),
				model: { ...model, contextWindow: WINDOW },
				getSystemPrompt: () => systemPrompt,
				getContextUsage: () => ({
					tokens,
					percent: (tokens / WINDOW) * 100,
					contextWindow: WINDOW,
				}),
			} as never);
			return result?.messages ?? messages;
		},
		publishThrough(endId) {
			const end = session.ids.indexOf(endId);
			appendCompartments(db, sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: end + 1,
					startMessageId: session.ids[0] ?? "",
					endMessageId: endId,
					title: "the first build attempts",
					content: "U: fix the build\nA: ran the first builds; they failed",
				},
			] as never);
			signalPiHistoryRefresh(sessionId);
		},
		statuses() {
			const out = new Map<string, string>();
			for (const tag of getTagsBySession(db, sessionId))
				if (tag.type === "tool") out.set(tag.messageId, tag.status);
			return out;
		},
		close() {
			log.mockRestore();
			clearContextHandlerSession(sessionId);
			clearPiServedArraySession(sessionId);
			clearPiLkgSessionState(sessionId);
			resetEmergencyRecoveryRegistryForTest();
			db.close();
		},
	};
}

/** The planner's plan line (drop or skip), with the floor it reports. */
export function planLine(
	lines: readonly string[],
): { line: string; floor: number | undefined } | undefined {
	const line = lines.find((entry) =>
		/^emergency tiered drop( skipped)?:/.test(entry),
	);
	if (!line) return undefined;
	const floor = /floor ?≈([\d.]+)/.exec(line)?.[1];
	return { line, floor: floor === undefined ? undefined : Number(floor) };
}

export function droppedCalls(statuses: Map<string, string>): string[] {
	return [...statuses]
		.filter(([, status]) => status === "dropped")
		.map(([callId]) => callId)
		.sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
}
