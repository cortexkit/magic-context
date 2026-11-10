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
import { PI_IMAGE_TOKENS, tokenizePiMessages } from "./tokenize-pi-messages";

export function piRecoveryFitCalibration(calibration: DecisionCalibration): {
	toolsRatio: number;
	proseRatio: number;
} {
	return calibration.seeded
		? calibration
		: { toolsRatio: UNKNOWN_FIT_RATIO, proseRatio: UNKNOWN_FIT_RATIO };
}

export function piRecoveryToolImageTokens(
	messages: readonly unknown[],
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
					(counts.get(message.toolCallId) ?? 0) +
						estimateTokens(JSON.stringify(part)),
				);
		}
	}
	return counts;
}

/** Recovery must share the planner's serialized-content units. Some Pi routes
 * charge inline image payloads as input text, unlike OpenCode's pixel-based images. */
export function estimatePiOverflowRecoveryInputTokens(
	messages: readonly unknown[],
	envelope: PiFitEnvelope | undefined,
): number | undefined {
	if (!envelope || !estimatePiOutgoingInputTokens([], envelope).trusted) return;
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
	return providerMass(
		{
			system: envelope.systemTokens,
			tools: envelope.toolDefinitionTokens + raw.toolCall,
			prose: raw.conversation,
		},
		envelope.calibration ?? calibrationForModelKey(envelope.modelKey),
		true,
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
