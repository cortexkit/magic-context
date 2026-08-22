import type {
	ModelInput,
	ResolvedModelEntry,
} from "@magic-context/core/shared/model-resolution";
import type { SubagentRunner } from "@magic-context/core/shared/subagent-runner";

/**
 * Shared OpenCode-client emulation backed by a Pi `SubagentRunner`.
 *
 * `executeContextRecompWithResult` is harness-agnostic but expects an
 * OpenCode-shaped `client.session.{create,prompt,messages,delete}`. This wraps
 * the Pi subagent runner into that shape so recomp (and session-upgrade) can
 * reuse the exact shared runner. Extracted from ctx-recomp.ts so both
 * /ctx-recomp and /ctx-session-upgrade share one implementation.
 */
export function createPiHistorianClient(args: {
	runner: SubagentRunner;
	model: string;
	systemPrompt: string;
	fallbackModels?: readonly ModelInput[];
	timeoutMs?: number;
	thinkingLevel?: string;
	directory: string;
	accountingSessionId: string;
	signal?: AbortSignal;
	notify: (text: string) => void;
}) {
	const sessions = new Map<string, unknown[]>();
	let counter = 0;
	async function prompt(input: unknown): Promise<Record<string, never>> {
		if (args.signal?.aborted)
			throw new Error("prompt aborted by external signal");
		const body = readBody(input);
		const sessionId = readPathId(input);
		if (body.noReply) {
			const text = extractPromptText(body.parts);
			if (text.length > 0) args.notify(text);
			return {};
		}
		const promptText = extractPromptText(body.parts);
		// Honor the per-attempt model override. The shared recomp/historian chain
		// (promptSyncWithModelSuggestionRetry) drives fallbacks by rewriting
		// body.model = { providerID, modelID } on each attempt and passing
		// fallbackModels: undefined for override attempts. If we ignored body.model
		// and always ran args.model, every "fallback" attempt would silently re-run
		// the SAME primary — so an empty/invalid-but-200 primary could never
		// escalate to the configured fallbacks or the session model. When an
		// override is present, let the override own the model and disable the
		// runner-level chain for this call (the shared layer owns iteration).
		const modelOverride = readBodyModel(body);
		const result = await args.runner.run({
			agent: "magic-context-historian",
			systemPrompt: args.systemPrompt,
			userMessage: promptText,
			model: modelOverride?.model ?? args.model,
			fallbackModels: modelOverride ? undefined : args.fallbackModels,
			timeoutMs: args.timeoutMs,
			cwd: args.directory,
			// An override is one active attempt. Its missing qualifier deliberately
			// clears the primary level rather than inheriting it on a bare fallback.
			thinkingLevel: modelOverride
				? modelOverride.qualifier
				: args.thinkingLevel,
			accountingSessionId: args.accountingSessionId,
			accountingSubagent: "recomp",
			signal: args.signal,
		});
		if (args.signal?.aborted)
			throw new Error("prompt aborted by external signal");
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
				if (args.signal?.aborted)
					throw new Error("prompt aborted by external signal");
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

function readBody(input: unknown): {
	noReply?: boolean;
	parts?: unknown;
	model?: unknown;
	variant?: unknown;
} {
	if (typeof input !== "object" || input === null) return {};
	const body = (input as { body?: unknown }).body;
	return typeof body === "object" && body !== null
		? (body as {
				noReply?: boolean;
				parts?: unknown;
				model?: unknown;
				variant?: unknown;
			})
		: {};
}

/**
 * Read a per-attempt model override from the prompt body as the
 * `"provider/modelID"` string the Pi SubagentRunner expects. The shared chain
 * passes `body.model = { providerID, modelID }`. Returns undefined when no
 * usable override is present (fall back to the client's primary model).
 */
function readBodyModel(body: {
	model?: unknown;
	variant?: unknown;
}): ResolvedModelEntry | undefined {
	const model = body.model;
	if (typeof model !== "object" || model === null) return undefined;
	const { providerID, modelID } = model as {
		providerID?: unknown;
		modelID?: unknown;
	};
	if (
		typeof providerID === "string" &&
		providerID.length > 0 &&
		typeof modelID === "string" &&
		modelID.length > 0
	) {
		const qualifier =
			typeof body.variant === "string" && body.variant.length > 0
				? body.variant
				: undefined;
		return qualifier
			? { model: `${providerID}/${modelID}`, qualifier }
			: { model: `${providerID}/${modelID}` };
	}
	return undefined;
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
