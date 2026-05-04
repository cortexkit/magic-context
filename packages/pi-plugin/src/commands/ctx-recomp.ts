import { getCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { COMPARTMENT_AGENT_SYSTEM_PROMPT } from "@magic-context/core/hooks/magic-context/compartment-prompt";
import { executeContextRecomp } from "@magic-context/core/hooks/magic-context/compartment-runner";
import {
	type PartialRecompRange,
	snapRangeToCompartments,
} from "@magic-context/core/hooks/magic-context/compartment-runner-partial-recomp";
import type { RawMessageProvider } from "@magic-context/core/hooks/magic-context/read-session-chunk";
import { setRawMessageProvider } from "@magic-context/core/hooks/magic-context/read-session-chunk";
import { describeError } from "@magic-context/core/shared/error-message";
import type { SubagentRunner } from "@magic-context/core/shared/subagent-runner";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	signalPiHistoryRefresh,
	signalPiPendingMaterialization,
} from "../context-handler";
import { clearPiCompressorState } from "../pi-compressor-runner";
import { readPiSessionMessages } from "../read-session-pi";
import { setMagicContextRecompActive, updateStatusLine } from "../status-line";
import { resolveSessionId, sendCtxStatusMessage } from "./pi-command-utils";

interface RecompConfirmation {
	timestamp: number;
	argsKey: string;
}

const confirmationBySession = new Map<string, RecompConfirmation>();
const RECOMP_CONFIRMATION_WINDOW_MS = 60_000;

export function registerCtxRecompCommand(
	pi: ExtensionAPI,
	deps: {
		db: ContextDatabase;
		runner: SubagentRunner;
		historianModel: string | undefined;
		historianChunkTokens: number;
		historianFallbacks?: readonly string[];
		historianTimeoutMs?: number;
		historianThinkingLevel?: string;
		memoryEnabled: boolean;
		autoPromote: boolean;
	},
): void {
	pi.registerCommand("ctx-recomp", {
		description:
			"Rebuild Magic Context compartments from raw Pi session history",
		handler: async (args, ctx) => {
			const sessionId = resolveSessionId(ctx);
			if (!sessionId) {
				sendCtxStatusMessage(pi, {
					title: "/ctx-recomp",
					text: "## Magic Recomp\n\nNo active Pi session is available.",
					level: "error",
				});
				return;
			}

			if (!deps.historianModel) {
				sendCtxStatusMessage(pi, {
					title: "/ctx-recomp",
					text: "## Magic Recomp\n\n/ctx-recomp is unavailable because `historian.model` is not configured.",
					level: "error",
				});
				return;
			}

			const parsed = parseRecompArgs(args);
			if (parsed.kind === "error") {
				sendCtxStatusMessage(pi, {
					title: "/ctx-recomp",
					text: `## Magic Recomp — Invalid Arguments\n\n${parsed.message}`,
					level: "error",
				});
				return;
			}

			const argsKey =
				parsed.kind === "partial"
					? `${parsed.range.start}-${parsed.range.end}`
					: "";
			const now = Date.now();
			const confirmation = confirmationBySession.get(sessionId);
			const confirmed =
				confirmation !== undefined &&
				now - confirmation.timestamp < RECOMP_CONFIRMATION_WINDOW_MS &&
				confirmation.argsKey === argsKey;

			if (!confirmed) {
				const warning = buildConfirmationWarning(deps.db, sessionId, parsed);
				if (!warning.confirmable) confirmationBySession.delete(sessionId);
				else confirmationBySession.set(sessionId, { timestamp: now, argsKey });
				sendCtxStatusMessage(pi, {
					title: "/ctx-recomp",
					text: warning.text,
					level: warning.confirmable ? "warning" : "error",
				});
				return;
			}

			confirmationBySession.delete(sessionId);
			sendCtxStatusMessage(pi, {
				title: "/ctx-recomp",
				text:
					parsed.kind === "partial"
						? `## Magic Recomp\n\nPartial recomp started for range ${parsed.range.start}-${parsed.range.end}.`
						: "## Magic Recomp\n\nHistorian recomp started. Rebuilding compartments and facts from raw Pi session history now.",
				level: "info",
			});

			const provider = {
				readMessages: () => readPiSessionMessages(ctx),
			} satisfies RawMessageProvider;
			const unregister = setRawMessageProvider(sessionId, provider);
			setMagicContextRecompActive(sessionId, true);
			updateStatusLine(ctx, {
				db: deps.db,
				projectIdentity: ctx.cwd,
			});
			try {
				const result = await executeContextRecomp(
					{
						client: createPiRecompClient({
							runner: deps.runner,
							model: deps.historianModel,
							fallbackModels: deps.historianFallbacks,
							timeoutMs: deps.historianTimeoutMs,
							thinkingLevel: deps.historianThinkingLevel,
							directory: ctx.cwd,
							notify: (text) => {
								sendCtxStatusMessage(pi, {
									title: "/ctx-recomp",
									text,
									level: inferLevel(text),
								});
							},
						}) as never,
						db: deps.db,
						sessionId,
						historianChunkTokens: deps.historianChunkTokens,
						directory: ctx.cwd,
						historianTimeoutMs: deps.historianTimeoutMs,
						memoryEnabled: deps.memoryEnabled,
						autoPromote: deps.autoPromote,
					},
					parsed.kind === "partial" ? { range: parsed.range } : {},
				);
				sendCtxStatusMessage(pi, {
					title: "/ctx-recomp",
					text: result,
					level: inferLevel(result),
				});
				// Mirrors OpenCode `hook.ts:477-480`: recomp publishes
				// fresh compartments + queues drops for the rebuilt
				// range. Without these signals the next pass would
				// render stale `<session-history>` until usage crossed
				// execute, and the queued drops would sit in
				// `pending_ops` until 85% force-materialization.
				//
				// We do NOT signal these on the catch path — a failed
				// recomp didn't publish anything, so there's nothing
				// for the next pass to refresh.
				signalPiHistoryRefresh(sessionId);
				signalPiPendingMaterialization(sessionId);
				// Compressor-cooldown reset: the freshly rebuilt
				// compartments may legitimately need compression on the
				// next opportunity, but the in-memory cooldown timer
				// would block the compressor from picking them up
				// inside its 10-min window. Clearing the timer lets
				// the compressor re-evaluate as if it had never run
				// for this session.
				clearPiCompressorState(sessionId);
			} catch (error) {
				sendCtxStatusMessage(pi, {
					title: "/ctx-recomp",
					text: `## Magic Recomp — Failed\n\n${describeError(error).brief}`,
					level: "error",
				});
			} finally {
				setMagicContextRecompActive(sessionId, false);
				updateStatusLine(ctx, {
					db: deps.db,
					projectIdentity: ctx.cwd,
				});
				unregister();
			}
		},
	});
}

function parseRecompArgs(
	raw: string,
):
	| { kind: "full" }
	| { kind: "partial"; range: PartialRecompRange }
	| { kind: "error"; message: string } {
	const trimmed = raw.trim();
	if (trimmed.length === 0) return { kind: "full" };
	const match = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
	if (!match) {
		return {
			kind: "error",
			message:
				"Usage:\n- `/ctx-recomp` — full rebuild from message 1 to the protected tail\n- `/ctx-recomp <start>-<end>` — partial rebuild of a message range",
		};
	}
	const start = Number.parseInt(match[1], 10);
	const end = Number.parseInt(match[2], 10);
	if (start < 1)
		return { kind: "error", message: `Start must be >= 1 (got ${start}).` };
	if (end < start)
		return {
			kind: "error",
			message: `End must be >= start (got ${start}-${end}).`,
		};
	return { kind: "partial", range: { start, end } };
}

function buildConfirmationWarning(
	db: ContextDatabase,
	sessionId: string,
	parsed: { kind: "full" } | { kind: "partial"; range: PartialRecompRange },
): { text: string; confirmable: boolean } {
	const compartments = getCompartments(db, sessionId);
	if (parsed.kind === "partial") {
		const snap = snapRangeToCompartments(compartments, parsed.range);
		if ("error" in snap)
			return {
				text: `## Magic Recomp — Failed\n\n${snap.error}`,
				confirmable: false,
			};
		return {
			confirmable: true,
			text: [
				"## ⚠️ Partial Recomp Confirmation Required",
				"",
				`Requested range: \`${parsed.range.start}-${parsed.range.end}\``,
				`Snapped to compartment boundaries: **messages ${snap.snapStart}-${snap.snapEnd}**`,
				`This will rebuild ${snap.rangeCompartments.length} compartment(s).`,
				`Preserved outside range: ${snap.priorCompartments.length + snap.tailCompartments.length} compartment(s).`,
				"Facts will not be re-extracted.",
				"",
				`**To confirm, run \`/ctx-recomp ${parsed.range.start}-${parsed.range.end}\` again within 60 seconds.**`,
			].join("\n"),
		};
	}

	return {
		confirmable: true,
		text: [
			"## ⚠️ Recomp Confirmation Required",
			"",
			`You currently have **${compartments.length}** compartments.`,
			"Running /ctx-recomp will **regenerate all compartments and facts** from raw session history.",
			"",
			"This operation may take a long time and will consume historian-model tokens.",
			"",
			"**To confirm, run `/ctx-recomp` again within 60 seconds.**",
		].join("\n"),
	};
}

function createPiRecompClient(args: {
	runner: SubagentRunner;
	model: string;
	fallbackModels?: readonly string[];
	timeoutMs?: number;
	thinkingLevel?: string;
	directory: string;
	notify: (text: string) => void;
}) {
	const sessions = new Map<string, unknown[]>();
	let counter = 0;
	async function prompt(input: unknown): Promise<Record<string, never>> {
		const body = readBody(input);
		const sessionId = readPathId(input);
		if (body.noReply) {
			const text = extractPromptText(body.parts);
			if (text.length > 0) args.notify(text);
			return {};
		}
		const promptText = extractPromptText(body.parts);
		const result = await args.runner.run({
			agent: "magic-context-historian",
			systemPrompt: COMPARTMENT_AGENT_SYSTEM_PROMPT,
			userMessage: promptText,
			model: args.model,
			fallbackModels: args.fallbackModels,
			timeoutMs: args.timeoutMs,
			cwd: args.directory,
			thinkingLevel: args.thinkingLevel,
		});
		if (!result.ok) {
			throw new Error(
				`Pi recomp historian failed (${result.reason}): ${result.error}`,
			);
		}
		sessions.set(sessionId, [makeMessage("assistant", result.assistantText)]);
		return {};
	}
	return {
		session: {
			get: async () => ({ directory: args.directory }),
			create: async () => {
				const id = `magic-context-pi-recomp-${++counter}`;
				sessions.set(id, []);
				return { id };
			},
			prompt,
			promptAsync: prompt,
			messages: async (input: unknown) => ({
				data: sessions.get(readPathId(input)) ?? [],
			}),
			delete: async (input: unknown) => {
				sessions.delete(readPathId(input));
				return {};
			},
		},
	};
}

function readPathId(input: unknown): string {
	if (typeof input !== "object" || input === null) return "";
	const path = (input as { path?: { id?: unknown } }).path;
	return typeof path?.id === "string" ? path.id : "";
}

function readBody(input: unknown): { noReply?: boolean; parts?: unknown } {
	if (typeof input !== "object" || input === null) return {};
	const body = (input as { body?: unknown }).body;
	return typeof body === "object" && body !== null
		? (body as { noReply?: boolean; parts?: unknown })
		: {};
}

function extractPromptText(parts: unknown): string {
	if (!Array.isArray(parts)) return "";
	return parts
		.map((part) =>
			typeof part === "object" && part !== null
				? (part as { text?: unknown }).text
				: undefined,
		)
		.filter(
			(text): text is string => typeof text === "string" && text.length > 0,
		)
		.join("\n");
}

function makeMessage(role: "assistant", text: string): unknown {
	return {
		info: { role, time: { created: Date.now() } },
		parts: [{ type: "text", text }],
		role,
		content: [{ type: "text", text }],
	};
}

function inferLevel(text: string): "info" | "success" | "warning" | "error" {
	const lower = text.toLowerCase();
	if (lower.includes("failed") || lower.includes("error")) return "error";
	if (lower.includes("confirmation") || lower.includes("⚠️")) return "warning";
	if (lower.includes("complete")) return "success";
	return "info";
}
