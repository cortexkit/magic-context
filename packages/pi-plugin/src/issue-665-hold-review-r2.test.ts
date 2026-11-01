// Randomized multi-pass driver for Pi turns whose signed thinking binds every
// preceding provider-visible byte. Each run drives the real context
// handler with a seeded sequence of tool steps, user turns, queued drops,
// execute crossings, flushes, history refreshes, idle expiry, discarded
// m[0]/m[1] pairs (first renders), carried tag-identity repairs and restarts.
//
// After every pass it checks:
// - a held pass (unfinished signed thinking turn on a prefix-bound model whose
//   last 15 assistant steps include one with more than 1,500 reasoning tokens,
//   below the execute threshold plus 10 points, with nothing that rewrites the
//   prefix anyway) serves the previous array byte for byte, with only new raw
//   messages after it;
//   an actually rejected, calibrated over-window replay is exempt only after a
//   declared, permitted rebuild removes every active-turn signed block;
// - strict thinking binding: a signed thinking block served on two consecutive
//   passes must have identical provider-visible bytes before it on both;
// - no pass is refused for more than one user turn.
//
// With R2_TRACE set, every pass is also appended to that file as one JSON line,
// so two checkouts can be compared pass by pass without changing the driver.
import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import {
	getOrCreateSessionMeta,
	getPendingOps,
	getTagsBySession,
	queuePendingOp,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import {
	dropSlot,
	getSlot,
	resetLkgSlotsForTest,
} from "@magic-context/core/hooks/magic-context/lkg-slot";
import * as logger from "@magic-context/core/shared/logger";
import type { Database } from "@magic-context/core/shared/sqlite";
import {
	clearContextHandlerSession,
	__test as contextHandlerInternals,
	registerPiContextHandler,
	signalPiHistoryRefresh,
	signalPiPendingMaterialization,
} from "./context-handler";
import { clearM0M1PiCache } from "./inject-compartments-pi";
import * as piFit from "./pi-raw-fallback";
import {
	queuePiIdentityRebuild,
	readPiIdentityRebuilds,
} from "./pi-tag-identity-repair";
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

type Scenario =
	/** Prefix-bound model; every assistant step carries signed thinking. */
	| "held"
	/** Thinking model that is not prefix-bound: the hold never applies. */
	| "unheld-unbound"
	/**
	 * Prefix-bound model whose tool steps carry no thinking. Each turn's final
	 * answer carries signed thinking and is followed by the next user message in
	 * the same step, so no pass sees an unfinished thinking turn, while older
	 * signed thinking stays on the wire for the strip lane.
	 */
	| "unheld-bound";

interface PassRecord {
	pass: number;
	events: string[];
	held: boolean;
	unavoidable: string[];
	refused: string | null;
	hash: string;
	length: number;
	pending: number;
	pendingBefore: number;
	pair: string;
	carried: number;
	tags: string;
	/** SHA-256 of the served JSON text, including property order. */
	wireHash?: string;
	decision?: string;
	rawInputBytes?: number;
	overWindowRebuild?: {
		tokens: number;
		limit: number;
		activeSignedBlocks: number;
		declaredRebuild: boolean;
		bustPermitted: boolean;
		bustedThisPass: boolean;
		signedPrefixRewritten: boolean;
	};
}

interface RejectedReplay {
	tokens: number;
	limit: number;
	calibrated: boolean;
	replaysPrevious: boolean;
}

interface Violation {
	pass: number;
	kind:
		| "held-prefix-changed"
		| "strict-binding"
		| "refusal"
		| "m0m1-rerendered"
		| "m0m1-folded";
	detail: string;
	events: string[];
	unavoidable: string[];
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

/** The fields of a Pi message a provider request is built from. Envelope timestamps and usage are left out. */
function providerKey(message: unknown): string {
	const m = (message ?? {}) as Record<string, unknown>;
	return stable({
		role: m.role,
		content: m.content,
		toolCallId: m.toolCallId,
		toolName: m.toolName,
		isError: m.isError,
		provider: m.role === "assistant" ? m.provider : undefined,
		model: m.role === "assistant" ? m.model : undefined,
	});
}

/** For each thinking signature, a hash of the provider-visible bytes in front of that block. */
function signedPrefixes(messages: readonly unknown[]): Map<string, string> {
	const out = new Map<string, string>();
	const before: string[] = [];
	for (const message of messages) {
		const m = (message ?? {}) as Record<string, unknown>;
		if (Array.isArray(m.content)) {
			const parts: unknown[] = [];
			for (const part of m.content as Array<Record<string, unknown>>) {
				if (
					part &&
					(part.type === "thinking" || part.type === "redacted_thinking") &&
					typeof part.thinkingSignature === "string"
				) {
					out.set(
						part.thinkingSignature,
						createHash("sha256")
							.update(
								`${before.join("\n")}\n${stable({ ...m, content: parts, timestamp: undefined, usage: undefined })}`,
							)
							.digest("hex"),
					);
				}
				parts.push(part);
			}
		}
		before.push(providerKey(message));
	}
	return out;
}

function activeTurnSignedBlocks(messages: readonly unknown[]): number {
	let lastUser = -1;
	for (let index = 0; index < messages.length; index++) {
		if ((messages[index] as { role?: string })?.role === "user")
			lastUser = index;
	}
	return signedPrefixes(messages.slice(lastUser + 1)).size;
}

const PREFIX_BOUND = "claude-opus-5-5";
const UNBOUND = "claude-sonnet-5";
const BULK = "BULK const value = compute(input, options); // line\n".repeat(80);

export async function runPiHoldDriver(options: {
	scenario: Scenario;
	seed: number;
	passes: number;
	trace?: string;
	/** sessionLog spy calls, printed for passes that re-render m[0]/m[1] when R2_DEBUG is set. */
	logCalls?: unknown[][];
}): Promise<{ records: PassRecord[]; violations: Violation[] }> {
	const random = rng(options.seed);
	// Reasoning weight and synthetic continuations draw from their own stream,
	// so a seed keeps the event sequence it had before they were added.
	const shape = rng(options.seed ^ 0x729);
	const heavyRate = Number(process.env.R2_HEAVY_RATE ?? 0.12);
	const continuationRate = Number(process.env.R2_CONTINUATION_RATE ?? 0.12);
	const recordedRate = Number(process.env.R2_RECORDED_RATE ?? 0.5);
	const pick = <T>(items: readonly T[]): T =>
		items[Math.floor(random() * items.length)]!;
	const modelId =
		options.scenario === "unheld-unbound" ? UNBOUND : PREFIX_BOUND;
	const sessionId = `r2-pi-${options.scenario}-${options.seed}`;
	const contextWindow = Number(process.env.R2_WINDOW ?? 100000);
	const db: Database = createTestDb();
	getOrCreateSessionMeta(db, sessionId);
	updateSessionMeta(db, sessionId, {
		piStableIdScheme: 1,
		lastResponseTime: Date.now(),
		cacheTtl: "13h",
	});
	// Real Pi exposes its tool definitions; the last-known-good fit check needs
	// them, with the system prompt, to price a replay.
	const piHost = () => {
		const created = createFakePi();
		Object.assign(created.pi, {
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
		return created;
	};
	let fake = piHost();
	const handlerOptions = (): Parameters<
		typeof registerPiContextHandler
	>[1] => ({
		db,
		tagger: createTagger(),
		protectedTokens: 2000,
		injection: {
			injectionBudgetTokens: 1000,
			memoryEnabled: false,
			injectDocs: false,
		},
		heuristics: { keepReasoningTokens: Number(process.env.R2_KEEP ?? 2000) },
		scheduler: { executeThresholdPercentage: 65 },
	});
	registerPiContextHandler(fake.pi as never, handlerOptions());
	const source: PiMessage[] = [];
	const ids: string[] = [];
	let clock = 1;
	let callCounter = 0;
	let signature = 0;
	let percent = 20;
	let compartmentEnd = -1;
	let compartmentSequence = 0;
	let rejectedReplays: RejectedReplay[] = [];
	let pipelineProof:
		| {
				prefixBustPermitted: boolean;
				bustedThisPass: boolean;
				identityRebuilt: boolean;
				signedPrefixRewritten: boolean;
		  }
		| undefined;
	const assistantExtra = (content: unknown[]) => ({
		provider: "anthropic",
		model: modelId,
		api: "anthropic-messages",
		content,
	});
	const push = (message: PiMessage, id: string) => {
		source.push(message);
		ids.push(id);
	};
	// Steps mix light and heavy reasoning. A heavy step either carries Pi's
	// recorded count (usage.reasoning) or, with none recorded, enough stored
	// thinking text for the estimate to exceed 1,500 tokens.
	const thinking = (heavyText = false) => ({
		type: "thinking",
		thinking: heavyText
			? `signed thought ${++signature} ${"weighing the next step carefully ".repeat(400)}`
			: `signed thought ${++signature}`,
		thinkingSignature: `sig-${signature}`,
	});
	const userTurn = () => {
		if (options.scenario === "unheld-bound" && source.length > 0) {
			// Close the turn with a signed final answer, then start the next one in
			// the same step, so no pass sees the turn's thinking unfinished.
			push(
				assistantMessage(
					"final answer",
					clock++,
					assistantExtra([
						thinking(),
						{ type: "text", text: `final ${clock}` },
					]),
				),
				`final-${clock}`,
			);
		}
		push(userMessage(`task ${clock}`, clock++), `user-${clock}`);
	};
	// A todo continuation or background notice: a user message whose parts are
	// all synthetic. It does not end the turn.
	const syntheticContinuation = () => {
		push(
			{
				role: "user",
				content: [{ type: "text", text: `continue ${clock}`, synthetic: true }],
				timestamp: clock++,
			} as unknown as PiMessage,
			`continue-${clock}`,
		);
	};
	const toolStep = () => {
		const callId = `call-${++callCounter}`;
		const content: unknown[] = [];
		const heavy = options.scenario !== "unheld-bound" && shape() < heavyRate;
		const recorded = shape() < recordedRate;
		if (options.scenario !== "unheld-bound")
			content.push(thinking(heavy && !recorded));
		content.push({
			type: "toolCall",
			id: callId,
			name: "read",
			arguments: { path: `${callCounter}.ts` },
		});
		push(
			assistantMessage("", clock++, {
				...assistantExtra(content),
				...(heavy && recorded
					? { usage: heavyReasoningUsage(1_600 + Math.floor(shape() * 3_000)) }
					: {}),
			}),
			`assistant-${callId}`,
		);
		push(
			toolResultMessage(callId, `${callId} ${BULK}`, clock++),
			`result-${callId}`,
		);
	};
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
	// The bounded hold the handler should apply: a heavy step among the last
	// 15 assistant steps of the turn, and usage below 65% + 10.
	const recentHeavyReasoning = () => {
		let lastUser = -1;
		source.forEach((m, i) => {
			if (isRealUser(m)) lastUser = i;
		});
		return source
			.slice(lastUser + 1)
			.filter((m) => (m as { role?: string }).role === "assistant")
			.slice(-15)
			.some((m) => {
				const message = m as {
					usage?: { reasoning?: number };
					content?: Array<{ type?: string; thinking?: string }>;
				};
				const text = message.content?.find(
					(p) => p.type === "thinking",
				)?.thinking;
				return (
					(message.usage?.reasoning ?? 0) > 1_500 ||
					(typeof text === "string" && text.length > 6_000)
				);
			});
	};
	const activeTurnThinking = () => {
		let lastUser = -1;
		source.forEach((m, i) => {
			if (isRealUser(m)) lastUser = i;
		});
		return source
			.slice(lastUser + 1)
			.some(
				(m) =>
					(m as { role?: string }).role === "assistant" &&
					((m as { content?: unknown[] }).content ?? []).some(
						(p) => (p as { type?: string }).type === "thinking",
					),
			);
	};
	const serve = async (): Promise<unknown[]> => {
		const messages = structuredClone(source);
		const ctx = {
			...fakeContext(sessionId, process.cwd(), [...ids], messages),
			...(process.env.R2_HEADLESS ? { hasUI: false } : {}),
			// Real Pi always reports its system prompt; the last-known-good fit
			// check refuses a replay it cannot price without one.
			getSystemPrompt: () =>
				"You are a coding agent. Use read to inspect files for the current task.",
			model: {
				provider: "anthropic",
				id: modelId,
				api: "anthropic-messages",
				contextWindow,
			},
			getContextUsage: () => ({
				tokens: (percent * contextWindow) / 100,
				percent,
				contextWindow,
			}),
		};
		const handler = fake.handlers.get("context")!;
		rejectedReplays = [];
		pipelineProof = undefined;
		const restoreResultObserver =
			contextHandlerInternals.setPipelineResultObserverForTests(
				(observedSession, result) => {
					if (observedSession === sessionId)
						pipelineProof = {
							...result,
							identityRebuilt: result.identityRebuilt === true,
						};
				},
			);
		const assertFits = piFit.assertPiRawFallbackFits;
		const fitSpy = spyOn(piFit, "assertPiRawFallbackFits").mockImplementation(
			(...args) => {
				try {
					return assertFits(...args);
				} catch (error) {
					const [replayMessages, limit] = args;
					if (limit !== undefined && Number.isFinite(limit) && limit > 0) {
						const estimate = piFit.estimatePiOutgoingInputTokens(
							replayMessages,
							args[4],
							args[5],
							limit,
						);
						rejectedReplays.push({
							tokens: estimate.refusalTokens ?? estimate.tokens,
							limit,
							calibrated:
								estimate.trusted &&
								estimate.refusalGrade === true &&
								estimate.refusalBasis === "calibrated",
							replaysPrevious:
								previous !== null &&
								replayMessages.length >= previous.length &&
								previous.every(
									(message, index) =>
										providerKey(message) === providerKey(replayMessages[index]),
								),
						});
					}
					throw error;
				}
			},
		);
		try {
			const result = (await handler({ messages } as never, ctx as never)) as {
				messages: unknown[];
			};
			return result.messages;
		} finally {
			fitSpy.mockRestore();
			restoreResultObserver();
		}
	};

	// The cached m[0]/m[1] bytes and the system hash they were folded with.
	const pairState = () => {
		const meta = getOrCreateSessionMeta(db, sessionId);
		return {
			bytes:
				meta.cachedM0Bytes && meta.cachedM1Bytes
					? createHash("sha256")
							.update(String(meta.cachedM0Bytes))
							.update("\0")
							.update(String(meta.cachedM1Bytes))
							.digest("hex")
							.slice(0, 16)
					: "",
			system: String(meta.cachedM0SystemHash ?? ""),
		};
	};
	const records: PassRecord[] = [];
	const violations: Violation[] = [];
	let previous: unknown[] | null = null;
	let refusalTurns = 0;
	let refusalTurnOpen = false;
	userTurn();
	toolStep();
	for (let pass = 0; pass < options.passes; pass++) {
		const events: string[] = [];
		const unavoidable: string[] = [];
		let resetIdle = false;
		if (pass > 1) {
			let servedUserTail = false;
			if (random() < 0.15) {
				userTurn();
				events.push("user");
				refusalTurnOpen = false;
				// Sometimes serve the new user message as the tail: the turn has no
				// thinking yet, so this pass is not held and may apply queued work.
				servedUserTail = random() < 0.4;
			}
			if (!servedUserTail && shape() < continuationRate) {
				syntheticContinuation();
				events.push("continuation");
			}
			if (!servedUserTail) toolStep();
			if (random() < 0.3) {
				const tools = getTagsBySession(db, sessionId).filter(
					(tag) => tag.type === "tool" && tag.status === "active",
				);
				if (tools.length > 0) {
					queuePendingOp(db, sessionId, pick(tools).tagNumber, "drop");
					events.push("drop");
				}
			}
			if (random() < 0.25) {
				percent = pick([20, 40, 60, 66, 70, 80, 84]);
				if (options.scenario === "held" && random() < 0.08)
					percent = pick([86, 96]);
				events.push(`usage-${percent}`);
			}
			if (random() < 0.1) {
				signalPiPendingMaterialization(sessionId);
				events.push("flush");
			}
			if (random() < 0.06) {
				signalPiHistoryRefresh(sessionId);
				events.push("history-refresh");
			}
			if (random() < 0.06) {
				updateSessionMeta(db, sessionId, {
					lastResponseTime: Date.now() - 14 * 60 * 60 * 1000,
				});
				resetIdle = true;
				events.push("idle-expiry");
			}
			if (random() < 0.08) {
				// A new historian compartment over an older finished turn, with the
				// history-refresh signal the historian sends: any m[0] fold from here
				// on renders different bytes. A held pass must keep replaying the old pair.
				// Compartments end before real user messages only, so the served
				// window always starts a turn at a real user; a fold that summarizes
				// a turn's real user away is covered by its own test.
				let lastUser = -1;
				for (let index = 0; index < source.length; index++)
					if (isRealUser(source[index]!)) lastUser = index;
				const ends: number[] = [];
				for (let index = compartmentEnd + 2; index < lastUser - 1; index++)
					if (isRealUser(source[index + 1]!)) ends.push(index);
				if (ends.length > 0) {
					const end = pick(ends);
					const begin = compartmentEnd + 1;
					const startId = (() => {
						const index = begin;
						return ids[index];
					})();
					const endId = (() => {
						const index = end;
						return ids[index];
					})();
					appendCompartments(db, sessionId, [
						{
							sequence: compartmentSequence++,
							startMessage: begin + 1,
							endMessage: end + 1,
							startMessageId: startId,
							endMessageId: endId,
							title: `history ${pass}`,
							content: `U: summarized work up to pass ${pass}`,
						},
					]);
					compartmentEnd = end;
					signalPiHistoryRefresh(sessionId);
					events.push("compartment");
				}
			}
			if (random() < 0.05) {
				clearM0M1PiCache(db, sessionId, "r2-first-render");
				events.push("first-render");
			}
			if (random() < 0.06) {
				const tools = getTagsBySession(db, sessionId).filter(
					(tag) => tag.type === "tool",
				);
				if (tools.length > 0) {
					const tag = pick(tools);
					queuePiIdentityRebuild(db, sessionId, {
						key: `r2-carried-${tag.tagNumber}`,
						kept: tag.tagNumber,
						removed: [],
						kind: "tool",
					});
					events.push("carried-repair");
					if (random() < 0.5) {
						dropSlot(sessionId, "r2-no-lkg");
						events.push("no-lkg");
					}
				}
			}
			if (random() < 0.04) {
				clearContextHandlerSession(sessionId);
				clearPiServedArraySession(sessionId);
				resetLkgSlotsForTest();
				fake = piHost();
				registerPiContextHandler(fake.pi as never, handlerOptions());
				events.push("restart");
			}
		}
		const carriedBefore = readPiIdentityRebuilds(db, sessionId).length;
		const lkgBefore = getSlot(sessionId) !== undefined;
		if (carriedBefore > 0 && !events.includes("carried-repair"))
			events.push("carried-pending");
		const meta = getOrCreateSessionMeta(db, sessionId);
		const pairMissing = !(meta.cachedM0Bytes && meta.cachedM1Bytes);
		const heldModel = modelId === PREFIX_BOUND && activeTurnThinking();
		if (pairMissing) unavoidable.push("first-render");
		if (events.includes("idle-expiry")) unavoidable.push("idle-expiry");
		if (carriedBefore > 0 && !lkgBefore)
			unavoidable.push("carried-repair-no-lkg");
		if (percent >= 75) unavoidable.push("hold-cap");
		if (!recentHeavyReasoning()) unavoidable.push("no-recent-heavy-reasoning");
		const held = heldModel && unavoidable.length === 0 && previous !== null;
		const pendingBefore = getPendingOps(db, sessionId).length;
		const pairBefore = pairState();
		const logStart = options.logCalls?.length ?? 0;
		let served: unknown[] | null = null;
		let refused: string | null = null;
		let overWindowRebuild: PassRecord["overWindowRebuild"];
		try {
			served = await serve();
		} catch (error) {
			refused =
				error instanceof Error
					? `${error.name}: ${error.message}`
					: String(error);
		}
		if (resetIdle)
			updateSessionMeta(db, sessionId, { lastResponseTime: Date.now() });
		if (refused) {
			if (!refusalTurnOpen) {
				refusalTurns += 1;
				refusalTurnOpen = true;
			}
			violations.push({
				pass,
				kind: "refusal",
				detail: refused,
				events,
				unavoidable,
			});
		}
		if (served && previous) {
			if (held) {
				for (let index = 0; index < previous.length; index++) {
					if (providerKey(served[index]) !== providerKey(previous[index])) {
						const overWindow = rejectedReplays.find(
							(replay) =>
								replay.replaysPrevious &&
								replay.calibrated &&
								replay.tokens > replay.limit,
						);
						const declaredRebuild =
							pipelineProof?.identityRebuilt === true &&
							(options.logCalls?.slice(logStart) ?? []).some((call) => {
								const line = String(call[1]);
								return (
									line.startsWith(
										"Pi held identity rebuild: prior prefix cannot fit",
									) && line.endsWith("applying the declared rebuild")
								);
							});
						const bustPermitted =
							pipelineProof?.prefixBustPermitted === true &&
							pipelineProof.bustedThisPass;
						if (overWindow && declaredRebuild && bustPermitted) {
							// The real replay guard must reject a calibrated token count
							// above the same window; verify the outgoing strip and actual
							// rebuild permission before allowing any changed prefix.
							expect(overWindow.limit).toBe(contextWindow);
							expect(overWindow.tokens).toBeGreaterThan(overWindow.limit);
							expect(pipelineProof?.signedPrefixRewritten).toBe(true);
							const activeSignedBlocks = activeTurnSignedBlocks(served);
							expect(activeSignedBlocks).toBe(0);
							overWindowRebuild = {
								tokens: overWindow.tokens,
								limit: overWindow.limit,
								activeSignedBlocks,
								declaredRebuild,
								bustPermitted,
								bustedThisPass: pipelineProof?.bustedThisPass === true,
								signedPrefixRewritten:
									pipelineProof?.signedPrefixRewritten === true,
							};
							if (process.env.R2_REBUILD_EVIDENCE === "1")
								console.log(
									"PI_OVER_WINDOW_REBUILD",
									JSON.stringify({ pass, ...overWindowRebuild }),
								);
							break;
						}
						if (process.env.R2_DEBUG) {
							const a = providerKey(previous[index]);
							const b = providerKey(served[index]);
							let at = 0;
							while (at < a.length && a[at] === b[at]) at++;
							console.log(
								`held pass ${pass} message ${index} differs at ${at}`,
								JSON.stringify({
									before: a.slice(Math.max(0, at - 60), at + 140),
									after: b.slice(Math.max(0, at - 60), at + 140),
								}),
							);
						}
						violations.push({
							pass,
							kind: "held-prefix-changed",
							detail: `first changed message ${index} of ${previous.length}; over-window=${overWindow ? `${overWindow.tokens}/${overWindow.limit}` : "none"} declared=${declaredRebuild} permitted=${bustPermitted}`,
							events,
							unavoidable,
						});
						break;
					}
				}
			}
			const before = signedPrefixes(previous);
			const broken: string[] = [];
			for (const [sig, prefix] of signedPrefixes(served)) {
				const old = before.get(sig);
				if (old !== undefined && old !== prefix) broken.push(sig);
			}
			if (broken.length > 0 && modelId === PREFIX_BOUND) {
				const firstChanged = served.findIndex(
					(message, index) =>
						providerKey(message) !== providerKey(previous?.[index]),
				);
				if (process.env.R2_DEBUG) {
					const a = providerKey(previous[firstChanged]);
					const b = providerKey(served[firstChanged]);
					let at = 0;
					while (at < a.length && a[at] === b[at]) at++;
					console.log(
						`pass ${pass} message ${firstChanged} differs at char ${at} (lengths ${a.length}/${b.length})`,
						JSON.stringify({
							before: a.slice(Math.max(0, at - 80), at + 160),
							after: b.slice(Math.max(0, at - 80), at + 160),
						}),
					);
				}
				violations.push({
					pass,
					kind: "strict-binding",
					detail: `${held ? "held" : heldModel ? "held-model" : "unheld"}: ${broken.length} kept signed block(s) [${broken[0]}..${broken.at(-1)}] behind changed bytes; first changed message ${firstChanged} (${String((served[firstChanged] as { role?: string })?.role)})`,
					events,
					unavoidable,
				});
			}
		}
		const pairAfter = pairState();
		if (served && previous && heldModel && pairBefore.bytes !== "") {
			const before = signedPrefixes(previous);
			const kept = [...signedPrefixes(served).keys()].filter((key) =>
				before.has(key),
			);
			if (
				kept.length > 0 &&
				pairAfter.bytes !== pairBefore.bytes &&
				process.env.R2_DEBUG
			)
				for (const call of options.logCalls?.slice(logStart) ?? [])
					if (
						/m\[[01]\]|fold|refresh|materiali|clear|HARD|SOFT/i.test(
							String(call[1]),
						)
					)
						console.log(`pass ${pass} log:`, String(call[1]).slice(0, 240));
			if (kept.length > 0 && pairAfter.bytes !== pairBefore.bytes)
				violations.push({
					pass,
					kind: "m0m1-rerendered",
					detail: `cached pair ${pairBefore.bytes} -> ${pairAfter.bytes || "cleared"} with ${kept.length} kept signed block(s)`,
					events,
					unavoidable,
				});
			else if (kept.length > 0 && pairAfter.system !== pairBefore.system)
				violations.push({
					pass,
					kind: "m0m1-folded",
					detail: `fold ran (system ${pairBefore.system} -> ${pairAfter.system}) with identical bytes and ${kept.length} kept signed block(s)`,
					events,
					unavoidable,
				});
		}
		const record: PassRecord = {
			pass,
			events,
			held,
			unavoidable,
			refused,
			...(overWindowRebuild ? { overWindowRebuild } : {}),
			hash: served
				? createHash("sha256")
						.update(served.map(providerKey).join("\n"))
						.digest("hex")
						.slice(0, 16)
				: "refused",
			length: served?.length ?? 0,
			pending: getPendingOps(db, sessionId).length,
			pendingBefore,
			pair: pairAfter.bytes,
			carried: readPiIdentityRebuilds(db, sessionId).length,
			tags: createHash("sha256")
				.update(
					getTagsBySession(db, sessionId)
						.map((tag) => `${tag.tagNumber}:${tag.status}`)
						.join(","),
				)
				.digest("hex")
				.slice(0, 16),
			...(process.env.R2_LITERAL
				? {
						wireHash: createHash("sha256")
							.update(JSON.stringify(served))
							.digest("hex"),
						rawInputBytes: Buffer.byteLength(JSON.stringify(source)),
						decision: options.logCalls
							?.slice(logStart)
							.map((call) => String(call[1]))
							.find((line) => /transform:.*decision=/.test(line))
							?.match(/decision=(execute|defer)/)?.[1],
					}
				: {}),
		};
		records.push(record);
		if (options.trace)
			appendFileSync(options.trace, `${JSON.stringify(record)}\n`);
		if (served) previous = served;
	}
	clearContextHandlerSession(sessionId);
	clearPiServedArraySession(sessionId);
	db.close();
	expect(refusalTurns).toBeLessThanOrEqual(1);
	return { records, violations };
}

afterEach(() => {
	resetLkgSlotsForTest();
});

const SEEDS = (process.env.R2_SEEDS ?? "665,664,650,7")
	.split(",")
	.map((seed) => Number(seed));
const PASSES = Number(process.env.R2_PASSES ?? 150);

function summarize(violations: Violation[]) {
	return violations.map(
		(v) =>
			`pass ${v.pass} ${v.kind} [${v.events.join(" ")}] unavoidable=[${v.unavoidable.join(" ")}]: ${v.detail}`,
	);
}

// Held-driver violations by seed, read by the aggregate checks below.
const heldViolations = new Map<number, Violation[]>();

for (const seed of SEEDS) {
	test(`Pi held driver seed ${seed}: held passes replay byte for byte and nothing is refused`, async () => {
		const logs = spyOn(logger, "sessionLog").mockImplementation(() => {});
		try {
			const { violations, records } = await runPiHoldDriver({
				scenario: "held",
				seed,
				passes: PASSES,
				logCalls: logs.mock.calls,
				trace: process.env.R2_TRACE
					? `${process.env.R2_TRACE}.pi-held-${seed}`
					: undefined,
			});
			if (process.env.R2_DEBUG)
				for (const call of logs.mock.calls) {
					const line = String(call[1]);
					if (
						/identity|LKG|lkg|replay/i.test(line) &&
						!/stage=lkgCapture/.test(line)
					)
						console.log("log:", line.slice(0, 300));
				}
			if (process.env.R2_VERBOSE)
				console.log(
					JSON.stringify(
						{
							seed,
							held: records.filter((r) => r.held).length,
							violations: summarize(violations),
						},
						null,
						1,
					),
				);
			heldViolations.set(seed, violations);
			// The hold is bounded (recent heavy reasoning, below the cap), so only
			// part of the passes of a signed turn are held.
			expect(records.filter((r) => r.held).length).toBeGreaterThan(PASSES / 8);
			expect(
				summarize(
					violations.filter(
						(v) => v.kind === "held-prefix-changed" || v.kind === "refusal",
					),
				),
			).toEqual([]);
		} finally {
			logs.mockRestore();
		}
	}, 600_000);

	for (const scenario of ["unheld-unbound", "unheld-bound"] as const) {
		test(`Pi ${scenario} driver seed ${seed}: trace for the pre-revision differential`, async () => {
			const logs = spyOn(logger, "sessionLog").mockImplementation(() => {});
			try {
				const { records, violations } = await runPiHoldDriver({
					scenario,
					seed,
					logCalls: logs.mock.calls,
					passes: Number(process.env.R2_UNHELD_PASSES ?? PASSES),
					trace: process.env.R2_TRACE
						? `${process.env.R2_TRACE}.pi-${scenario}-${seed}`
						: undefined,
				});
				if (process.env.R2_VERBOSE)
					console.log(
						JSON.stringify(
							{ seed, scenario, violations: summarize(violations) },
							null,
							1,
						),
					);
				expect(records.some((r) => r.held)).toBe(false);
				expect(
					summarize(violations.filter((v) => v.kind === "refusal")),
				).toEqual([]);
			} finally {
				logs.mockRestore();
			}
		}, 600_000);
	}
}

// Thinking signatures bind all preceding prompt bytes. If a block is kept on
// consecutive passes, those bytes and m[0]/m[1] rendering must remain unchanged.
// Check every generated sequence, including first render, expiry and pending
// tag-identity repairs.
function aggregate(kind: Violation["kind"]): string[] {
	expect(heldViolations.size).toBeGreaterThan(0);
	return [...heldViolations].flatMap(([seed, violations]) =>
		summarize(violations.filter((v) => v.kind === kind)).map(
			(line) => `seed ${seed} ${line}`,
		),
	);
}
test("Pi held drivers: no kept signed thinking is served behind changed bytes", () => {
	expect(aggregate("strict-binding")).toEqual([]);
});
test("Pi held drivers: m[0]/m[1] is never re-rendered while signed thinking is kept", () => {
	expect(aggregate("m0m1-rerendered")).toEqual([]);
});

// Ruling for all three hosts. Every step of the signed turn below spent 1,600
// reasoning tokens, so the bounded hold applies below the cap (execute
// threshold 65% plus 10 points). There an idle-expired pass replays m[0]/m[1]
// byte for byte. At the force band (86%) and the 95% emergency the cap ends the
// hold: the pass rebuilds m[0]/m[1] mid-turn and strips every signed block of
// the turn. Earlier revisions held both cases until the next real user message
// (issue 729). Each case below loads a reason to rebuild m[0]/m[1] (a new
// compartment with its history-refresh signal, a changed system prompt hash,
// and optionally a carried tag-identity repair) before the held passes, then
// checks the cached pair and the served head. The release pass at the end is
// the positive control: once the turn ends the same inputs do rebuild the pair.
async function piRulingFixture(withCarriedRepair: boolean) {
	const sessionId = `r2-pi-ruling-${withCarriedRepair ? "carried" : "plain"}`;
	const db = createTestDb();
	getOrCreateSessionMeta(db, sessionId);
	updateSessionMeta(db, sessionId, {
		piStableIdScheme: 1,
		lastResponseTime: Date.now(),
		cacheTtl: "13h",
	});
	const fake = createFakePi();
	Object.assign(fake.pi, {
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
	registerPiContextHandler(fake.pi as never, {
		db,
		tagger: createTagger(),
		protectedTokens: 2000,
		injection: {
			injectionBudgetTokens: 1000,
			memoryEnabled: false,
			injectDocs: false,
		},
		heuristics: { keepReasoningTokens: 2000 },
		scheduler: { executeThresholdPercentage: 65 },
	});
	const extra = (content: unknown[]) => ({
		provider: "anthropic",
		model: PREFIX_BOUND,
		api: "anthropic-messages",
		content,
	});
	const source: PiMessage[] = [
		userMessage("first task", 1),
		assistantMessage(
			"first answer",
			2,
			extra([{ type: "text", text: "first answer" }]),
		),
		userMessage("second task", 3),
		assistantMessage(
			"second answer",
			4,
			extra([{ type: "text", text: "second answer" }]),
		),
		userMessage("current task", 5),
	];
	const ids = ["u1", "a1", "u2", "a2", "u3"];
	let percent = 40;
	const serve = async () => {
		const messages = structuredClone(source);
		const ctx = {
			...fakeContext(sessionId, process.cwd(), [...ids], messages),
			getSystemPrompt: () =>
				"You are a coding agent. Use read to inspect files for the current task.",
			model: {
				provider: "anthropic",
				id: PREFIX_BOUND,
				api: "anthropic-messages",
				contextWindow: 100000,
			},
			getContextUsage: () => ({
				tokens: percent * 1000,
				percent,
				contextWindow: 100000,
			}),
		};
		const handler = fake.handlers.get("context")!;
		return (
			(await handler({ messages } as never, ctx as never)) as {
				messages: unknown[];
			}
		).messages;
	};
	const pair = () => {
		const meta = getOrCreateSessionMeta(db, sessionId);
		return `${String(meta.cachedM0Bytes)}\u0000${String(meta.cachedM1Bytes)}`;
	};
	let step = 0;
	const heldStep = () => {
		step += 1;
		source.push(
			assistantMessage("", 10 + 2 * step, {
				...extra([
					{
						type: "thinking",
						thinking: `active thought ${step}`,
						thinkingSignature: `active-sig-${step}`,
					},
					{
						type: "toolCall",
						id: `active-call-${step}`,
						name: "read",
						arguments: { path: `${step}.ts` },
					},
				]),
				usage: heavyReasoningUsage(),
			}),
			toolResultMessage(
				`active-call-${step}`,
				`result ${step} ${BULK}`,
				11 + 2 * step,
			),
		);
		ids.push(`active-assistant-${step}`, `active-result-${step}`);
	};
	await serve();
	heldStep();
	await serve();
	appendCompartments(db, sessionId, [
		{
			sequence: 0,
			startMessage: 1,
			endMessage: 2,
			startMessageId: "u1",
			endMessageId: "a1",
			title: "first",
			content: "U: first task\nA: first answer",
		},
	]);
	signalPiHistoryRefresh(sessionId);
	updateSessionMeta(db, sessionId, {
		systemPromptHash: "system-after-the-turn-started",
	});
	if (withCarriedRepair) {
		const tool = getTagsBySession(db, sessionId).find(
			(tag) => tag.type === "tool",
		)!;
		queuePiIdentityRebuild(db, sessionId, {
			key: "r2-ruling",
			kept: tool.tagNumber,
			removed: [],
			kind: "tool",
		});
	}
	return {
		db,
		sessionId,
		serve,
		pair,
		heldStep,
		source,
		ids,
		setPercent: (value: number) => {
			percent = value;
		},
	};
}

function keptActiveSignatures(
	previous: unknown[],
	served: unknown[],
): string[] {
	const before = signedPrefixes(previous);
	return [...signedPrefixes(served).keys()].filter(
		(sig) => sig.startsWith("active-sig-") && before.has(sig),
	);
}

for (const withCarriedRepair of [false, true]) {
	for (const cause of [
		"idle expiry",
		"force band 86%",
		"emergency 96%",
	] as const) {
		const held = cause === "idle expiry";
		const name = `Pi ruling${withCarriedRepair ? " with a carried identity repair" : ""}: ${held ? `a held ${cause} pass keeps m[0]/m[1] frozen while signed thinking is kept` : `a ${cause} pass is above the hold cap: it rebuilds m[0]/m[1] mid-turn and strips every signed block`}`;
		const body = async () => {
			const logs = spyOn(logger, "sessionLog").mockImplementation(() => {});
			const fixture = await piRulingFixture(withCarriedRepair);
			try {
				fixture.heldStep();
				const previous = await fixture.serve();
				const pairBefore = fixture.pair();
				// The held pass above replayed its last-known-good prefix and left the repair pending.
				expect(
					readPiIdentityRebuilds(fixture.db, fixture.sessionId).length,
				).toBe(withCarriedRepair ? 1 : 0);
				fixture.heldStep();
				if (cause === "idle expiry")
					updateSessionMeta(fixture.db, fixture.sessionId, {
						lastResponseTime: Date.now() - 14 * 60 * 60 * 1000,
					});
				else {
					fixture.setPercent(cause === "force band 86%" ? 86 : 96);
					signalPiPendingMaterialization(fixture.sessionId);
				}
				const logStart = logs.mock.calls.length;
				const served = await fixture.serve();
				updateSessionMeta(fixture.db, fixture.sessionId, {
					lastResponseTime: Date.now(),
				});
				if (process.env.R2_DEBUG) {
					console.log(
						name,
						"pending after",
						readPiIdentityRebuilds(fixture.db, fixture.sessionId).length,
						"pair changed",
						fixture.pair() !== pairBefore,
					);
					for (const call of logs.mock.calls.slice(logStart))
						if (/m\[[01]\]|fold|identity|LKG|lkg|WILL/i.test(String(call[1])))
							console.log("  log:", String(call[1]).slice(0, 200));
				}
				if (!held) {
					// Above the cap the rebuild lands mid-turn, and no signed block
					// is served behind the changed head.
					expect(fixture.pair()).not.toBe(pairBefore);
					expect(signedPrefixes(served).size).toBe(0);
					const wire = JSON.stringify(served);
					for (const step of [1, 2, 3])
						expect(wire).toContain(`"active-call-${step}"`);
					return;
				}
				expect(keptActiveSignatures(previous, served).length).toBeGreaterThan(
					0,
				);
				expect(fixture.pair()).toBe(pairBefore);
				expect(providerKey(served[0])).toBe(providerKey(previous[0]));
				expect(providerKey(served[1])).toBe(providerKey(previous[1]));
				// Positive control: the turn ends and the same pending inputs rebuild the pair.
				fixture.source.push(userMessage("next task", 99));
				fixture.ids.push("u4");
				fixture.setPercent(70);
				signalPiPendingMaterialization(fixture.sessionId);
				await fixture.serve();
				expect(fixture.pair()).not.toBe(pairBefore);
			} finally {
				logs.mockRestore();
				clearContextHandlerSession(fixture.sessionId);
				clearPiServedArraySession(fixture.sessionId);
				fixture.db.close();
			}
		};
		// Pressure and expiry cannot invalidate retained signatures. Replay the
		// last served prefix until repair can omit all signed thinking safely.
		test(name, body, 60_000);
	}
}

// A tag-identity conflict must not interrupt every subsequent turn. Without a
// last-known-good prefix, pending repair rebuilds m[0]/m[1]; inject a cache-clear
// failure there. Count refused passes across two tool steps and two later users.
// A persistent clear failure may refuse once, then must serve with the repair
// still pending rather than interrupt every pass and every later user turn.
test("Pi carried identity repair: a failing declared rebuild refuses at most one turn", async () => {
	const logs = spyOn(logger, "sessionLog").mockImplementation(() => {});
	const fixture = await piRulingFixture(true);
	const refusedTurns = new Set<number>();
	let turn = 0;
	let servedPasses = 0;
	const serveCounting = async () => {
		try {
			await fixture.serve();
			servedPasses++;
		} catch (error) {
			refusedTurns.add(turn);
			if (process.env.R2_DEBUG)
				console.log("refused:", String(error).slice(0, 200));
		}
	};
	try {
		fixture.db.exec(
			"CREATE TRIGGER r2_fail_m0_clear BEFORE UPDATE OF cached_m0_bytes ON session_meta WHEN NEW.cached_m0_bytes IS NULL BEGIN SELECT RAISE(FAIL, 'injected m0 clear failure'); END",
		);
		dropSlot(fixture.sessionId, "r2-no-lkg");
		fixture.heldStep();
		await serveCounting();
		fixture.heldStep();
		await serveCounting();
		for (const n of [1, 2]) {
			turn = n;
			fixture.source.push(userMessage(`turn ${n}`, 200 + n));
			fixture.ids.push(`turn-${n}`);
			await serveCounting();
			fixture.heldStep();
			await serveCounting();
		}
		if (process.env.R2_DEBUG)
			console.log(
				"refused turns",
				[...refusedTurns],
				"pending",
				readPiIdentityRebuilds(fixture.db, fixture.sessionId).length,
			);
		expect(refusedTurns.size).toBeLessThanOrEqual(1);
		expect(servedPasses).toBeGreaterThanOrEqual(5);
		expect(readPiIdentityRebuilds(fixture.db, fixture.sessionId)).toHaveLength(
			1,
		);
		expect(
			logs.mock.calls.some((call) =>
				String(call[1]).includes("repair still pending"),
			),
		).toBe(true);
	} finally {
		logs.mockRestore();
		clearContextHandlerSession(fixture.sessionId);
		clearPiServedArraySession(fixture.sessionId);
		fixture.db.close();
	}
}, 60_000);
