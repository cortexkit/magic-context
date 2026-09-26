import {
	detectOverflow,
	detectThinkingBindingMismatch,
	isPrefixBoundThinkingModel,
} from "@magic-context/core/features/magic-context/overflow-detection";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import {
	addMergedReasoningStrippedIds,
	armThinkingBindingRecovery,
	getMergedReasoningStrippedIds,
	getThinkingBindingRecoveryTarget,
	recordOverflowDetected,
	THINKING_BINDING_RECOVERY_FROZEN_PREFIX,
	thinkingBindingRecoveryFrozenId,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { dropSlot } from "@magic-context/core/hooks/magic-context/lkg-slot";
import { log } from "@magic-context/core/shared/logger";

import { clearPiLkgSessionState } from "./pi-lkg";

function reportBindingRecovery(
	sessionId: string,
	report: ((message: string) => void) | undefined,
	message: string,
): void {
	if (report) report(message);
	else log(`[magic-context][${sessionId}] ${message}`);
}

export type PiProviderFailureResult =
	| { kind: "none" }
	| { kind: "thinking_binding"; armed: boolean }
	| {
			kind: "overflow";
			reportedLimit?: number;
			reportedLimitProvenance?: string;
			matchedPattern?: string;
	  };

/** Persist recovery state from Pi's assistant `message_end` error payload. */
export function handlePiProviderFailure(args: {
	db: ContextDatabase;
	sessionId: string;
	message: unknown;
	compactionOff?: boolean;
	thinkingBindingRecoveryEnabled?: boolean;
	report?: (message: string) => void;
}): PiProviderFailureResult {
	if (!args.message || typeof args.message !== "object")
		return { kind: "none" };
	const message = args.message as {
		role?: unknown;
		errorMessage?: unknown;
		provider?: unknown;
		model?: unknown;
	};
	if (
		message.role !== "assistant" ||
		typeof message.errorMessage !== "string" ||
		message.errorMessage.length === 0
	) {
		return { kind: "none" };
	}

	const provider =
		typeof message.provider === "string" ? message.provider : undefined;
	const model = typeof message.model === "string" ? message.model : undefined;
	const binding = detectThinkingBindingMismatch(message.errorMessage);
	if (binding.isBindingMismatch) {
		const enabled =
			args.thinkingBindingRecoveryEnabled !== false &&
			!args.compactionOff &&
			isPrefixBoundThinkingModel(provider, model);
		if (enabled) {
			// The 400 names only provider request-array paths. The next context
			// pass maps the flag onto stable branch entry ids and strips thinking
			// from every assistant that still carries it.
			armThinkingBindingRecovery(args.db, args.sessionId);
			clearPiLkgSessionState(args.sessionId);
			dropSlot(args.sessionId, "thinking-binding-recovery-arm");
			reportBindingRecovery(
				args.sessionId,
				args.report,
				`thinking-binding recovery armed from message_end (provider paths: failing=${binding.failingBlockPath ?? "?"} firstChanged=${binding.firstChangedPath ?? "?"})`,
			);
		}
		return { kind: "thinking_binding", armed: enabled };
	}

	if (args.compactionOff) return { kind: "none" };
	const overflow = detectOverflow(message.errorMessage);
	if (!overflow.isOverflow) return { kind: "none" };
	const modelKey = provider && model ? `${provider}/${model}` : undefined;
	recordOverflowDetected(
		args.db,
		args.sessionId,
		overflow.reportedLimit,
		modelKey,
		"provider_overflow",
		overflow.reportedLimitProvenance,
		overflow.reportedInputTokens,
	);
	return {
		kind: "overflow",
		...(overflow.reportedLimit !== undefined
			? { reportedLimit: overflow.reportedLimit }
			: {}),
		...(overflow.reportedLimitProvenance !== undefined
			? { reportedLimitProvenance: overflow.reportedLimitProvenance }
			: {}),
		...(overflow.matchedPattern !== undefined
			? { matchedPattern: overflow.matchedPattern }
			: {}),
	};
}

interface PiThinkingPart {
	type?: unknown;
}

interface PiAssistantMessage {
	role?: unknown;
	content?: unknown;
}

function hasThinkingPart(message: unknown): boolean {
	if (!message || typeof message !== "object") return false;
	const assistant = message as PiAssistantMessage;
	return (
		assistant.role === "assistant" &&
		Array.isArray(assistant.content) &&
		assistant.content.some((part) => {
			if (!part || typeof part !== "object") return false;
			const type = (part as PiThinkingPart).type;
			return (
				type === "thinking" ||
				type === "redactedThinking" ||
				type === "redacted_thinking"
			);
		})
	);
}

function stripThinkingParts(message: unknown): number {
	if (!message || typeof message !== "object") return 0;
	const assistant = message as PiAssistantMessage;
	const content = assistant.content;
	if (assistant.role !== "assistant" || !Array.isArray(content)) return 0;
	const before = content.length;
	const strippedContent = content.filter((part) => {
		if (!part || typeof part !== "object") return true;
		const type = (part as PiThinkingPart).type;
		return (
			type !== "thinking" &&
			type !== "redactedThinking" &&
			type !== "redacted_thinking"
		);
	});
	assistant.content = strippedContent;
	return before - strippedContent.length;
}

export interface PiThinkingBindingApplication {
	/** The flag value read, so the caller clears only that value. */
	flagTarget: string;
	/** Every branch entry whose thinking this pass removes. */
	entryIds: string[];
}

/**
 * Apply an armed thinking-binding recovery and replay earlier ones.
 *
 * An armed flag freezes every assistant entry that still carries thinking,
 * the newest one included even when its tool call waits on a pending tool
 * result: after a prefix edit all of those blocks are invalid, and removing
 * all of them is always valid, so one failed request is enough. The frozen
 * set is persisted before bytes change and replays on every later pass, so a
 * removed block never comes back; blocks produced afterwards are kept.
 */
export function applyPiThinkingBindingRecovery(args: {
	db: ContextDatabase;
	sessionId: string;
	messages: unknown[];
	entryIds: readonly (string | undefined)[];
	provider?: string;
	model?: string;
	report?: (message: string) => void;
}): PiThinkingBindingApplication | null {
	if (args.provider?.toLowerCase() !== "anthropic") return null;
	const frozenEntryIds = new Set<string>();
	for (const frozenId of getMergedReasoningStrippedIds(
		args.db,
		args.sessionId,
	)) {
		if (!frozenId.startsWith(THINKING_BINDING_RECOVERY_FROZEN_PREFIX)) continue;
		const entryId = frozenId.slice(
			THINKING_BINDING_RECOVERY_FROZEN_PREFIX.length,
		);
		if (entryId.length > 0) frozenEntryIds.add(entryId);
	}

	const flagTarget = isPrefixBoundThinkingModel(args.provider, args.model)
		? getThinkingBindingRecoveryTarget(args.db, args.sessionId)
		: null;
	let applied: PiThinkingBindingApplication | null = null;
	if (flagTarget) {
		const entryIds = new Set<string>();
		for (let index = 0; index < args.messages.length; index += 1) {
			const entryId = args.entryIds[index];
			if (entryId && hasThinkingPart(args.messages[index]))
				entryIds.add(entryId);
		}
		const newEntryIds = [...entryIds].filter((id) => !frozenEntryIds.has(id));
		if (
			newEntryIds.length === 0 ||
			addMergedReasoningStrippedIds(
				args.db,
				args.sessionId,
				newEntryIds.map(thinkingBindingRecoveryFrozenId),
			)
		) {
			for (const id of newEntryIds) frozenEntryIds.add(id);
			applied = { flagTarget, entryIds: [...entryIds] };
			reportBindingRecovery(
				args.sessionId,
				args.report,
				`thinking-binding recovery consumed on context pass target=${flagTarget} entries=${applied.entryIds.length} [${applied.entryIds.join(",")}]`,
			);
		}
	}

	for (let index = 0; index < args.messages.length; index += 1) {
		const entryId = args.entryIds[index];
		if (entryId && frozenEntryIds.has(entryId))
			stripThinkingParts(args.messages[index]);
	}
	return applied;
}
