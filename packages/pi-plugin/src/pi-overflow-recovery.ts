import {
	calibrationForModelKey,
	type DecisionCalibration,
	providerMass,
} from "@magic-context/core/hooks/magic-context/decision-calibration";
import { estimateTokens } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import { UNKNOWN_FIT_RATIO } from "@magic-context/core/hooks/magic-context/tokenizer-calibration";
import { resolveUnknownUsageFromWireEstimate } from "@magic-context/core/hooks/magic-context/transform-context-state";
import {
	estimatePiOutgoingInputTokens,
	type PiFitEnvelope,
} from "./pi-raw-fallback";
import { piMessagesWithWireImages } from "./strip-processed-images-pi";
import { PI_IMAGE_TOKENS, tokenizePiMessages } from "./tokenize-pi-messages";

export function piRecoveryFitCalibration(calibration: DecisionCalibration): {
	toolsRatio: number;
	proseRatio: number;
} {
	return calibration.seeded
		? calibration
		: { toolsRatio: UNKNOWN_FIT_RATIO, proseRatio: UNKNOWN_FIT_RATIO };
}

/**
 * Image mass of each tool result, by tool call id, as provider-overflow
 * recovery counts it: the serialized payload, the same units its whole-request
 * estimate uses (see estimatePiOverflowRecoveryInputTokens).
 */
export function piRecoveryToolImageTokens(
	messages: readonly unknown[],
): Map<string, number> {
	return piToolResultImageTokens(messages, (part) =>
		estimateTokens(JSON.stringify(part)),
	);
}

/**
 * Image mass of each tool result, by tool call id, at the fixed per-image token
 * cost the request's own token count uses (PI_IMAGE_TOKENS), whatever the
 * size of the base64 payload. The emergency planner uses it outside
 * provider-overflow recovery, where it is set against the provider's reading of
 * the previous request.
 */
export function piToolImageCostTokens(
	messages: readonly unknown[],
): Map<string, number> {
	return piToolResultImageTokens(messages, () => PI_IMAGE_TOKENS);
}

function piToolResultImageTokens(
	messages: readonly unknown[],
	priceImage: (part: unknown) => number,
): Map<string, number> {
	const counts = new Map<string, number>();
	const seen = new Set<string>();
	for (const value of messages) {
		const message = value as {
			role?: string;
			toolCallId?: string;
			content?: unknown;
		} | null;
		if (
			message?.role !== "toolResult" ||
			!message.toolCallId ||
			!Array.isArray(message.content)
		)
			continue;
		if (seen.has(message.toolCallId)) {
			// A reused call id makes it unclear which tool-result images this count belongs to.
			counts.delete(message.toolCallId);
			continue;
		}
		seen.add(message.toolCallId);
		for (const part of message.content) {
			if (part?.type === "image")
				counts.set(
					message.toolCallId,
					(counts.get(message.toolCallId) ?? 0) + priceImage(part),
				);
		}
	}
	return counts;
}

/** Recovery must share the planner's serialized-content units. Some Pi routes
 * charge inline image payloads as input text, unlike OpenCode's pixel-based images.
 * `fitEnvelope: false` counts with calibrated ratios only (an unseeded model
 * counts neutrally), the way OpenCode counts a served request; the default
 * applies the fit envelope's margin for unseeded models. */
export function estimatePiOverflowRecoveryInputTokens(
	servedMessages: readonly unknown[],
	envelope: PiFitEnvelope | undefined,
	options: { fitEnvelope?: boolean } = {},
): number | undefined {
	return countPiRequestTokens(servedMessages, envelope, {
		fitEnvelope: options.fitEnvelope ?? true,
		activeToolsOnly: false,
		serializedImages: true,
	});
}

/**
 * Our own count of a served Pi request (system prompt, tool definitions and
 * messages) in the units the emergency planner prices tags in on the same
 * pass: the tag calibration given, only the active tools (what the request
 * carries), and images at the price the planner's tags use (the serialized
 * size during provider-overflow recovery, the per-image cost otherwise).
 * Undefined when the envelope cannot be sized or a message holds content the
 * count does not know.
 */
export function countPiServedRequestTokens(
	servedMessages: readonly unknown[],
	envelope: PiFitEnvelope | undefined,
	options: {
		calibration: {
			systemRatio?: number;
			toolsRatio: number;
			proseRatio: number;
		};
		recovery: boolean;
	},
): number | undefined {
	return countPiRequestTokens(servedMessages, envelope, {
		fitEnvelope: false,
		activeToolsOnly: true,
		serializedImages: options.recovery,
		calibration: options.calibration,
	});
}

function countPiRequestTokens(
	servedMessages: readonly unknown[],
	envelope: PiFitEnvelope | undefined,
	options: {
		fitEnvelope: boolean;
		activeToolsOnly: boolean;
		serializedImages: boolean;
		calibration?: {
			systemRatio?: number;
			toolsRatio: number;
			proseRatio: number;
		};
	},
): number | undefined {
	if (!envelope || !estimatePiOutgoingInputTokens([], envelope).trusted) return;
	const toolDefinitionTokens = options.activeToolsOnly
		? envelope.refusalToolDefinitionTokens
		: envelope.toolDefinitionTokens;
	if (toolDefinitionTokens === undefined) return;
	// Images the model cannot take go out as a short note.
	const messages = piMessagesWithWireImages(servedMessages, {
		modelAcceptsImages: envelope.modelAcceptsImages !== false,
	});
	const raw = tokenizePiMessages([...messages]);
	for (const value of messages) {
		if (!value || typeof value !== "object") return;
		const message = value as { role?: string; content?: unknown };
		if (message.role === "system") {
			// The host envelope already counts the effective prompt and tool deltas.
			// Validate protocol rows without charging their content a second time.
			if (typeof message.content === "string") continue;
			if (
				!Array.isArray(message.content) ||
				!message.content.every(
					(part) => part?.type === "text" && typeof part.text === "string",
				)
			)
				return;
			continue;
		}
		if (
			!["user", "assistant", "toolResult", "custom"].includes(
				message.role ?? "",
			)
		)
			return;
		if (typeof message.content === "string") continue;
		if (!Array.isArray(message.content)) return;
		for (const value of message.content) {
			if (!value || typeof value !== "object") return;
			const part = value as { type?: string; data?: string };
			if (part.type === "image") {
				if (typeof part.data !== "string") return;
				if (!options.serializedImages) continue;
				const delta = estimateTokens(JSON.stringify(part)) - PI_IMAGE_TOKENS;
				if (message.role === "toolResult") raw.toolCall += delta;
				else raw.conversation += delta;
			} else if (
				!["text", "thinking", "redacted_thinking", "toolCall"].includes(
					part.type ?? "",
				)
			)
				return;
		}
	}
	const calibration =
		options.calibration ??
		envelope.calibration ??
		calibrationForModelKey(envelope.modelKey);
	return providerMass(
		{
			system: envelope.systemTokens,
			tools: toolDefinitionTokens + raw.toolCall,
			prose: raw.conversation,
		},
		{
			...calibration,
			// A recovery fit calibration carries one ratio for every part.
			systemRatio: calibration.systemRatio ?? calibration.proseRatio,
			seeded: (calibration as { seeded?: boolean }).seeded ?? true,
		} as DecisionCalibration,
		options.fitEnvelope,
	);
}

export function resolvePiOverflowRecoveryUsage(args: {
	usage: { inputTokens: number; percentage: number };
	pricedPass: boolean;
	providerOverflow: boolean;
	messages: readonly unknown[];
	envelope: PiFitEnvelope | undefined;
	usableHardLimit: number | undefined;
}): { inputTokens: number; percentage: number } {
	if (!args.pricedPass || !args.providerOverflow || args.usage.inputTokens > 0)
		return args.usage;
	return resolveUnknownUsageFromWireEstimate({
		usage: args.usage,
		pricedPass: args.pricedPass,
		wireEstimateTokens: estimatePiOverflowRecoveryInputTokens(
			args.messages,
			args.envelope,
		),
		windowTokens: args.usableHardLimit,
	});
}
