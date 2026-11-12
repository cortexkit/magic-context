// Randomized served-byte differential of the bounded signed-thinking hold
// against a base revision, for Pi (Oh My Pi shares this handler).
//
// It needs two source snapshots and is skipped without them:
//   MC_HOLD_DIFF_BASE  a checkout of the base revision (node_modules linked)
//   MC_HOLD_DIFF_HEAD  a checkout of this revision (node_modules linked)
// Each snapshot is imported as its own module graph, so its process-local state
// is separate from this file's. Neither may be the checkout running this file:
// the snapshot's graph would then be this file's own.
// Optional:
//   MC_HOLD_DIFF_EXPECT     "identical" (default): no pass may differ; or
//                           "differing": at least one pass must differ (a change
//                           that is meant to bust where base held)
//   MC_HOLD_DIFF_THRESHOLD  the execute threshold percentage (default 65)
//   MC_HOLD_DIFF_PASSES, MC_HOLD_DIFF_SEED
//
// One seeded session runs here, warm, through this checkout's handler. Before
// every pass the session database is copied twice, and the same input runs
// through a fresh base handler and a fresh head handler on those copies: both
// see identical state and differ only by code. Each pass checks:
// - D1: a warm pass that permitted no prefix change serves its predecessor
//   byte for byte (new messages only at the end);
// - D2: a pass where head and base serve different bytes is a pass base held
//   (an open signed turn on the prefix-bound model) and head busted, and head
//   serves no signed thinking block while keeping every other part of the
//   steps;
// - D3: the warm pass serves what the fresh head handler served on the same
//   state (restart determinism), counted and reported;
// - D4: a signed block the warm session serves on two consecutive passes has
//   identical provider-visible bytes in front of it on both.
import { afterAll, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import {
	getOrCreateSessionMeta,
	getTagsBySession,
	queuePendingOp,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { resetLkgSlotsForTest } from "@magic-context/core/hooks/magic-context/lkg-slot";
import * as logger from "@magic-context/core/shared/logger";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import {
	clearContextHandlerSession,
	__test as contextHandlerInternals,
	registerPiContextHandler,
	signalPiHistoryRefresh,
	signalPiPendingMaterialization,
} from "./context-handler";
import { clearM0M1PiCache } from "./inject-compartments-pi";
import { clearPiServedArraySession } from "./served-array-ledger";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	heavyReasoningUsage,
	type PiMessage,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

const BASE = process.env.MC_HOLD_DIFF_BASE;
const HEAD = process.env.MC_HOLD_DIFF_HEAD;
const PASSES = Number(process.env.MC_HOLD_DIFF_PASSES ?? 420);
const SEED = Number(process.env.MC_HOLD_DIFF_SEED ?? 729);
const EXPECT = process.env.MC_HOLD_DIFF_EXPECT ?? "identical";
const THRESHOLD = Number(process.env.MC_HOLD_DIFF_THRESHOLD ?? 65);
// This file's own checkout (packages/pi-plugin/src -> root).
const RUNNING_CHECKOUT = join(import.meta.dir, "../../..");

function snapshotRoot(name: string, root: string): string {
	const resolved = realpathSync(root);
	if (resolved === realpathSync(RUNNING_CHECKOUT))
		throw new Error(
			`${name} is the checkout running this test; point it at a separate snapshot (for example a git archive of the revision with node_modules linked)`,
		);
	return resolved;
}
const MODEL = "claude-opus-5-5";

type Graph = {
	registerPiContextHandler: typeof registerPiContextHandler;
	clearContextHandlerSession: typeof clearContextHandlerSession;
	clearPiServedArraySession: typeof clearPiServedArraySession;
	signalPiHistoryRefresh: typeof signalPiHistoryRefresh;
	signalPiPendingMaterialization: typeof signalPiPendingMaterialization;
	internals: typeof contextHandlerInternals;
	createFakePi: typeof createFakePi;
	createTestDb: typeof createTestDb;
	createTagger: typeof createTagger;
	resetLkgSlotsForTest: typeof resetLkgSlotsForTest;
	hasActiveAnthropicThinkingTurn: (
		messages: readonly unknown[],
		provider?: string,
		model?: string,
	) => boolean;
	logger: typeof logger;
};

async function loadGraph(root: string): Promise<Graph> {
	const pi = join(root, "packages/pi-plugin/src");
	const core = join(root, "packages/plugin/src");
	const [handler, served, utils, tagger, lkg, turn, log] = await Promise.all([
		import(join(pi, "context-handler.ts")),
		import(join(pi, "served-array-ledger.ts")),
		import(join(pi, "test-utils.test.ts")),
		import(join(core, "features/magic-context/tagger.ts")),
		import(join(core, "hooks/magic-context/lkg-slot.ts")),
		import(join(core, "hooks/magic-context/latest-assistant-turn.ts")),
		import(join(core, "shared/logger.ts")),
	]);
	return {
		registerPiContextHandler: handler.registerPiContextHandler,
		clearContextHandlerSession: handler.clearContextHandlerSession,
		clearPiServedArraySession: served.clearPiServedArraySession,
		signalPiHistoryRefresh: handler.signalPiHistoryRefresh,
		signalPiPendingMaterialization: handler.signalPiPendingMaterialization,
		internals: handler.__test,
		createFakePi: utils.createFakePi,
		createTestDb: utils.createTestDb,
		createTagger: tagger.createTagger,
		resetLkgSlotsForTest: lkg.resetLkgSlotsForTest,
		hasActiveAnthropicThinkingTurn: turn.hasActiveAnthropicThinkingTurn,
		logger: log,
	};
}

function rng(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function stable(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.filter((key) => record[key] !== undefined)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/** Provider-visible fields of one Pi message; empty thinking is dropped by Pi's serializers. */
function providerKey(message: unknown): string {
	const m = (message ?? {}) as { content?: unknown };
	const content = Array.isArray(m.content)
		? (m.content as Array<Record<string, unknown>>).filter(
				(p) =>
					!(
						p.type === "thinking" &&
						(p.thinking === "" || p.thinking === undefined)
					),
			)
		: m.content;
	return stable({ ...m, content, timestamp: undefined, usage: undefined });
}

/** For each signed thinking block, a hash of the provider-visible bytes in front of it. */
function signedPrefixes(messages: unknown[]): Map<string, string> {
	const out = new Map<string, string>();
	const before: string[] = [];
	for (const message of messages) {
		const content = (message as { content?: unknown }).content;
		if (Array.isArray(content)) {
			const parts: unknown[] = [];
			for (const part of content as Array<Record<string, unknown>>) {
				if (
					part.type === "thinking" &&
					typeof part.thinkingSignature === "string" &&
					typeof part.thinking === "string" &&
					part.thinking !== ""
				)
					out.set(
						part.thinkingSignature,
						createHash("sha256")
							.update(
								`${before.join("\n")}\n${providerKey({ ...(message as object), content: parts })}`,
							)
							.digest("hex"),
					);
				parts.push(part);
			}
		}
		before.push(providerKey(message));
	}
	return out;
}

const digest = (messages: unknown[]) =>
	createHash("sha256")
		.update(messages.map(providerKey).join("\n"))
		.digest("hex");

const signedBlocks = (messages: unknown[]) =>
	messages.flatMap((message) => {
		const content = (message as { content?: unknown }).content;
		if (!Array.isArray(content)) return [];
		return (content as Array<Record<string, unknown>>).filter(
			(p) =>
				p.type === "thinking" &&
				typeof p.thinkingSignature === "string" &&
				typeof p.thinking === "string" &&
				p.thinking !== "",
		);
	});

/** Part kinds of a step other than its thinking, in order. */
const unsignedShape = (message: unknown) => {
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return [];
	return (content as Array<Record<string, unknown>>)
		.filter((p) => p.type !== "thinking" && p.type !== "redacted_thinking")
		.map((p) =>
			p.type === "toolCall" ? `toolCall:${String(p.id)}` : String(p.type),
		);
};

const report: string[] = [];
afterAll(() => {
	if (report.length > 0) console.log(report.join("\n"));
});

test.skipIf(!BASE || !HEAD)(
	`Pi: bounded hold differential against base over ${PASSES} passes`,
	async () => {
		if (EXPECT !== "identical" && EXPECT !== "differing")
			throw new Error(
				`MC_HOLD_DIFF_EXPECT must be identical or differing, not ${EXPECT}`,
			);
		const base = await loadGraph(snapshotRoot("MC_HOLD_DIFF_BASE", BASE!));
		const headCold = await loadGraph(snapshotRoot("MC_HOLD_DIFF_HEAD", HEAD!));
		const quiet = (module: typeof logger) =>
			spyOn(module, "sessionLog").mockImplementation(() => {});
		const spies = [quiet(logger), quiet(base.logger), quiet(headCold.logger)];
		const random = rng(SEED);
		const pick = <T>(items: readonly T[]): T =>
			items[Math.floor(random() * items.length)]!;
		const sessionId = "pi-hold-diff";
		const root = createTestTempDirFromPath(join(tmpdir(), "pi-hold-diff-"));
		const db = createTestDb(join(root, "warm.db"));
		const counts = {
			passes: 0,
			identical: 0,
			differing: 0,
			differingBaseHeld: 0,
			differingHeadStrippedAll: 0,
			differingUnsignedKept: 0,
			warmUnchangedPrefixPasses: 0,
			warmUnchangedPrefixStable: 0,
			warmKeptBlocksChecked: 0,
			warmMatchesCold: 0,
			heavySteps: 0,
			lightSteps: 0,
			continuations: 0,
			users: 0,
			drops: 0,
			flushes: 0,
			compartments: 0,
			restarts: 0,
			firstRenders: 0,
			idle: 0,
		};
		const failures: string[] = [];
		const handlerOptions = (graph: Graph | null, database: unknown) => ({
			db: database as never,
			tagger: (graph?.createTagger ?? createTagger)(),
			protectedTokens: 2000,
			injection: {
				injectionBudgetTokens: 1000,
				memoryEnabled: false,
				injectDocs: false,
			},
			heuristics: { keepReasoningTokens: 2000 },
			scheduler: { executeThresholdPercentage: THRESHOLD },
		});
		const tools = () => ({
			getAllTools: () => [
				{
					name: "read",
					description: "Read a file",
					parameters: {
						type: "object",
						properties: { path: { type: "string" } },
					},
				},
			],
			getActiveTools: () => ["read"],
		});
		try {
			getOrCreateSessionMeta(db, sessionId);
			updateSessionMeta(db, sessionId, {
				piStableIdScheme: 1,
				lastResponseTime: Date.now(),
				cacheTtl: "13h",
			});
			let warmPi = createFakePi();
			Object.assign(warmPi.pi, tools());
			registerPiContextHandler(warmPi.pi as never, handlerOptions(null, db));
			const source: PiMessage[] = [];
			const ids: string[] = [];
			let clock = 1;
			let call = 0;
			let percent = 30;
			let compartmentEnd = -1;
			let compartmentSequence = 0;
			const isRealUser = (m: PiMessage) => {
				const message = m as { role?: string; content?: unknown };
				if (message.role !== "user") return false;
				return !(
					Array.isArray(message.content) &&
					message.content.every(
						(p) => (p as { synthetic?: boolean }).synthetic === true,
					)
				);
			};
			const extra = (content: unknown[]) => ({
				provider: "anthropic",
				model: MODEL,
				api: "anthropic-messages",
				content,
			});
			const user = (synthetic = false) => {
				if (synthetic) {
					source.push({
						role: "user",
						content: [
							{
								type: "text",
								text: "Continue with the todo list.",
								synthetic: true,
							},
						],
						timestamp: clock++,
					} as unknown as PiMessage);
					ids.push(`continue-${clock}`);
				} else {
					source.push(userMessage(`task ${clock}`, clock++));
					ids.push(`user-${clock}`);
				}
			};
			const toolStep = () => {
				const callId = `call-${++call}`;
				const heavy = random() < 0.15;
				const recorded = random() < 0.5;
				if (heavy) counts.heavySteps++;
				else counts.lightSteps++;
				source.push(
					assistantMessage("", clock++, {
						...extra([
							{
								type: "thinking",
								thinking:
									heavy && !recorded
										? `thought ${call} ${"weighing the next step carefully ".repeat(400)}`
										: `thought ${call}`,
								thinkingSignature: `sig-${call}`,
							},
							{
								type: "toolCall",
								id: callId,
								name: "read",
								arguments: { path: `${call}.ts` },
							},
						]),
						...(heavy && recorded
							? {
									usage: heavyReasoningUsage(
										1_600 + Math.floor(random() * 2_000),
									),
								}
							: {}),
					}),
					toolResultMessage(
						callId,
						`${callId} ${"const value = compute(input); // line\n".repeat(60)}`,
						clock++,
					),
				);
				ids.push(`assistant-${callId}`, `result-${callId}`);
			};
			const serveWith = async (
				graph: Graph | null,
				fake: ReturnType<typeof createFakePi>,
			) => {
				const messages = structuredClone(source);
				const ctx = {
					...fakeContext(sessionId, process.cwd(), [...ids], messages),
					getSystemPrompt: () =>
						"You are a coding agent. Use read to inspect files for the current task.",
					model: {
						provider: "anthropic",
						id: MODEL,
						api: "anthropic-messages",
						contextWindow: 200_000,
					},
					getContextUsage: () => ({
						tokens: percent * 2000,
						percent,
						contextWindow: 200_000,
					}),
				};
				let bust = false;
				const restore = (
					graph?.internals ?? contextHandlerInternals
				).setPipelineResultObserverForTests((observed, result) => {
					if (observed === sessionId) bust ||= result.prefixBustPermitted;
				});
				try {
					const handler = fake.handlers.get("context")!;
					const result = (await handler(
						{ messages } as never,
						ctx as never,
					)) as {
						messages: unknown[];
					};
					return { messages: result.messages, bust };
				} finally {
					restore();
				}
			};
			user();
			toolStep();
			let previous: unknown[] | null = null;
			let pendingFlush = false;
			let pendingHistory = false;
			for (let pass = 0; pass < PASSES; pass++) {
				if (pass > 1) {
					if (random() < 0.08) {
						user();
						counts.users++;
					} else if (random() < 0.1) {
						user(true);
						counts.continuations++;
					}
					toolStep();
					if (random() < 0.25) {
						const active = getTagsBySession(db, sessionId).filter(
							(tag) => tag.type === "tool" && tag.status === "active",
						);
						if (active.length > 0) {
							queuePendingOp(db, sessionId, pick(active).tagNumber, "drop");
							counts.drops++;
						}
					}
					if (random() < 0.25)
						percent = pick([20, 40, 60, 66, 70, 74, 76, 80, 84, 86, 90, 96]);
					if (random() < 0.08) {
						pendingFlush = true;
						counts.flushes++;
					}
					if (random() < 0.06) {
						const ends: number[] = [];
						for (let i = compartmentEnd + 2; i < source.length - 6; i++)
							if (isRealUser(source[i + 1]!)) ends.push(i);
						if (ends.length > 0) {
							const end = pick(ends);
							appendCompartments(db, sessionId, [
								{
									sequence: compartmentSequence++,
									startMessage: compartmentEnd + 2,
									endMessage: end + 1,
									startMessageId: ids[compartmentEnd + 1]!,
									endMessageId: ids[end]!,
									title: `history ${pass}`,
									content: `U: summarized work up to pass ${pass}`,
								},
							]);
							compartmentEnd = end;
							pendingHistory = true;
							counts.compartments++;
						}
					}
					if (random() < 0.04) {
						updateSessionMeta(db, sessionId, {
							lastResponseTime: Date.now() - 14 * 60 * 60 * 1000,
						});
						counts.idle++;
					}
					if (random() < 0.03) {
						clearM0M1PiCache(db, sessionId, "diff-first-render");
						counts.firstRenders++;
					}
					if (random() < 0.03) {
						clearContextHandlerSession(sessionId);
						clearPiServedArraySession(sessionId);
						resetLkgSlotsForTest();
						warmPi = createFakePi();
						Object.assign(warmPi.pi, tools());
						registerPiContextHandler(
							warmPi.pi as never,
							handlerOptions(null, db),
						);
						counts.restarts++;
					}
				}
				const flush = pendingFlush;
				const history = pendingHistory;
				pendingFlush = false;
				pendingHistory = false;
				// One snapshot of the state, copied for both runs, so a write that
				// lands between two snapshots cannot give them different states.
				const snapshot = join(root, `snapshot-${pass}.db`);
				db.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`);
				const run = async (graph: Graph, name: string) => {
					const path = join(root, `${name}-${pass}.db`);
					copyFileSync(snapshot, path);
					graph.resetLkgSlotsForTest();
					graph.clearContextHandlerSession(sessionId);
					graph.clearPiServedArraySession(sessionId);
					const copy = graph.createTestDb(path);
					const fake = graph.createFakePi();
					Object.assign(fake.pi, tools());
					graph.registerPiContextHandler(
						fake.pi as never,
						handlerOptions(graph, copy) as never,
					);
					if (flush)
						graph.signalPiPendingMaterialization(sessionId, "user_flush");
					if (history) graph.signalPiHistoryRefresh(sessionId);
					try {
						return await serveWith(graph, fake);
					} finally {
						graph.clearContextHandlerSession(sessionId);
						copy.close();
						for (const suffix of ["", "-wal", "-shm"])
							rmSync(`${path}${suffix}`, { force: true });
					}
				};
				const baseHeld = base.hasActiveAnthropicThinkingTurn(
					source,
					"anthropic",
					MODEL,
				);
				const baseServed = await run(base, "base");
				const headServed = await run(headCold, "head");
				rmSync(snapshot, { force: true });
				if (flush) signalPiPendingMaterialization(sessionId, "user_flush");
				if (history) signalPiHistoryRefresh(sessionId);
				const warmServed = await serveWith(null, warmPi);
				updateSessionMeta(db, sessionId, { lastResponseTime: Date.now() });
				counts.passes++;
				if (digest(headServed.messages) === digest(baseServed.messages))
					counts.identical++;
				else {
					counts.differing++;
					if (baseHeld) counts.differingBaseHeld++;
					const signed = signedBlocks(headServed.messages);
					if (signed.length === 0) counts.differingHeadStrippedAll++;
					const steps = new Map(
						source
							.filter((m) => (m as { role?: string }).role === "assistant")
							.map((m) => [stable((m as { content?: unknown }).content), m]),
					);
					const unsignedKept = [...steps.values()].every((step) => {
						const shape = JSON.stringify(unsignedShape(step));
						const callId = unsignedShape(step).find((kind) =>
							kind.startsWith("toolCall:"),
						);
						if (!callId) return true;
						const servedStep = headServed.messages.find((m) =>
							unsignedShape(m).includes(callId),
						);
						// A step the fold summarized is gone as a whole, not stripped.
						return (
							!servedStep || JSON.stringify(unsignedShape(servedStep)) === shape
						);
					});
					if (unsignedKept) counts.differingUnsignedKept++;
					if (
						!baseHeld ||
						!headServed.bust ||
						signed.length > 0 ||
						!unsignedKept
					)
						failures.push(
							`pass ${pass}: head differs from base (baseHeld=${baseHeld} headBusted=${headServed.bust} signedServed=${signed.length} unsignedKept=${unsignedKept} usage=${percent}%)`,
						);
				}
				if (digest(warmServed.messages) === digest(headServed.messages))
					counts.warmMatchesCold++;
				if (!warmServed.bust && previous) {
					counts.warmUnchangedPrefixPasses++;
					const stablePrefix = previous.every(
						(message, index) =>
							providerKey(warmServed.messages[index]) === providerKey(message),
					);
					if (stablePrefix) counts.warmUnchangedPrefixStable++;
					else
						failures.push(
							`pass ${pass}: a pass without bust permission changed its predecessor's bytes`,
						);
				}
				if (previous) {
					// D4: a signed block the warm session serves on two consecutive
					// passes has identical bytes in front of it.
					const before = signedPrefixes(previous);
					for (const [signature, prefix] of signedPrefixes(
						warmServed.messages,
					)) {
						const old = before.get(signature);
						if (old === undefined) continue;
						counts.warmKeptBlocksChecked++;
						if (old !== prefix)
							failures.push(
								`pass ${pass}: kept signed block ${signature} behind changed bytes`,
							);
					}
				}
				previous = warmServed.messages;
			}
			report.push(
				`pi differential (seed ${SEED}, threshold ${THRESHOLD}%, expect ${EXPECT}): ${JSON.stringify(counts)}`,
			);
			expect(failures).toEqual([]);
			expect(counts.passes).toBe(PASSES);
			if (EXPECT === "differing") expect(counts.differing).toBeGreaterThan(0);
			else expect(counts.differing).toBe(0);
			expect(counts.warmUnchangedPrefixPasses).toBeGreaterThan(0);
		} finally {
			for (const spy of spies) spy.mockRestore();
			clearContextHandlerSession(sessionId);
			clearPiServedArraySession(sessionId);
			resetLkgSlotsForTest();
			db.close();
			rmSync(root, { recursive: true, force: true });
		}
	},
	3_600_000,
);
