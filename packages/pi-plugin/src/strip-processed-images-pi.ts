import {
	addProcessedImageStrippedIds,
	type ContextDatabase,
	getProcessedImageStrippedIds,
} from "@magic-context/core/features/magic-context/storage";
import { estimateTokens } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import { sessionLog } from "@magic-context/core/shared/logger";
import { PI_IMAGE_TOKENS } from "./tokenize-pi-messages";

interface PiImagePart {
	type: "image";
	data: string;
	mimeType: string;
}

export interface StripPiProcessedImagesResult {
	stripped: number;
	newlyStrippedIds: string[];
}

// A non-empty marker preserves user/tool-result boundaries and keeps Anthropic
// tool_result content valid after Pi removes the image bytes.
export const STRIPPED_IMAGE_MARKER = "[image stripped]";

/** Whether the processed-image strip replaces this block in a message whose id it froze. */
export function isLargeImagePart(value: unknown): value is PiImagePart {
	if (!value || typeof value !== "object") return false;
	const part = value as Record<string, unknown>;
	return (
		part.type === "image" &&
		typeof part.mimeType === "string" &&
		part.mimeType.startsWith("image/") &&
		typeof part.data === "string" &&
		part.data.length > 200
	);
}

/**
 * What Pi's provider layer (pi-ai) sends for a tool-result image when the
 * session's model takes no image input. Oh My Pi sends a similar short note.
 */
export const PI_NON_VISION_TOOL_IMAGE_PLACEHOLDER =
	"(tool image omitted: model does not support images)";

/**
 * Whether the session's model takes image input, read from the `input` list
 * Pi's model descriptors carry. A model without that list is assumed to take
 * images, as before this check existed.
 */
export function piModelAcceptsImages(model: unknown): boolean {
	const input = (model as { input?: unknown } | null | undefined)?.input;
	return !Array.isArray(input) || input.includes("image");
}

/**
 * Token cost of a tool-result image block as the request carries it. An image
 * counts at the per-image cost only while it is sent. In a message whose id the
 * processed-image strip froze (`stripped`), a large image is replaced by the
 * strip's marker; for a model without image input the host replaces every
 * image with a short note. Either way the block counts as its placeholder text.
 * (pi-ai merges consecutive images into one note; each is counted here, a few
 * tokens over.)
 */
export function piToolImageWireTokens(args: {
	block: unknown;
	stripped: boolean;
	modelAcceptsImages: boolean;
}): number {
	if (args.stripped && isLargeImagePart(args.block))
		return estimateTokens(STRIPPED_IMAGE_MARKER);
	if (!args.modelAcceptsImages)
		return estimateTokens(PI_NON_VISION_TOOL_IMAGE_PLACEHOLDER);
	return PI_IMAGE_TOKENS;
}

interface StripPiProcessedImagesArgs {
	db: ContextDatabase;
	sessionId: string;
	messages: unknown[];
	detect: boolean;
	watermark: number;
	messageIdToMaxTag: ReadonlyMap<string, number>;
	protectedCutoff?: number | null;
	usagePercentage?: number;
	/** Keys combine the assistant message id and call id; ownerless tags use just the call id. */
	protectedToolKeys?: ReadonlySet<string>;
	stableId: (message: unknown, index: number) => string | undefined;
	addIds?: typeof addProcessedImageStrippedIds;
	onFirstApplication?: (
		message: unknown,
		messageIndex: number,
		partIndex: number,
	) => void;
}

/**
 * 1. Position tag: the image's message's own maximum positive tag; if it has
 *    none, the first positive tag of any LATER message; if neither exists, the
 *    image is INELIGIBLE (retained, never age 0, never a preceding-tag fallback).
 * 2. Age gate (unchanged): eligible only if position tag ≤ dropped-tag watermark
 *    (watermark > 0), plus the existing answered-by-a-later-assistant,
 *    admitted-bust, no-protected-signed-prefix, stable-id and persist-first rules.
 * 3. Protected range: if position tag ≥ the protected cutoff (the same
 *    newest-tag token window cutoff drops use, not just set membership), no new
 *    strip, below 95%.
 * 4. At ≥95%: waive ONLY the protected-range check, exactly as the emergency
 *    drop does (emergency-drop.ts:206-207,239-247). Every other exclusion stays:
 *    protected tool tags, open or incomplete tools, signed prefix.
 *
 * The watermark is the highest durably dropped tag number. The caller enables
 * `detect` only when a prefix rewrite is already permitted and no retained
 * signed thinking binds the earlier image bytes. Saved message ids replay even
 * when those conditions no longer permit discovering new omissions.
 */
function planPiProcessedImageIds(
	args: StripPiProcessedImagesArgs,
	frozenIds: ReadonlySet<string>,
): string[] {
	if (!args.detect || args.watermark <= 0) return [];
	const ids = args.messages.map(args.stableId);
	const ownTags = ids.map((id) =>
		id ? (args.messageIdToMaxTag.get(id) ?? 0) : 0,
	);
	const completeToolResults = new Set<number>();
	const openCalls = new Map<string, string>();
	for (let i = 0; i < args.messages.length; i++) {
		const message = args.messages[i] as {
			role?: string;
			content?: unknown;
			toolCallId?: string;
		} | null;
		if (!message || typeof message !== "object") continue;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content) {
				if (part?.type === "toolCall" && typeof part.id === "string") {
					openCalls.set(part.id, `${ids[i] ?? ""}\x00${part.id}`);
				}
			}
		} else if (message.role === "toolResult" && message.toolCallId) {
			const key = openCalls.get(message.toolCallId);
			if (
				key !== undefined &&
				!args.protectedToolKeys?.has(key) &&
				!args.protectedToolKeys?.has(message.toolCallId)
			) {
				completeToolResults.add(i);
			}
			openCalls.delete(message.toolCallId);
		}
	}

	const selected: string[] = [];
	let hasAssistantResponse = false;
	let nextTag: number | undefined;
	for (let i = args.messages.length - 1; i >= 0; i--) {
		const ownTag = ownTags[i];
		const positionTag = ownTag > 0 ? ownTag : nextTag;
		if (ownTag > 0) nextTag = ownTag;
		const raw = args.messages[i];
		if (!raw || typeof raw !== "object") continue;
		const message = raw as { role?: unknown; content?: unknown };
		if (message.role === "assistant") {
			hasAssistantResponse = true;
			continue;
		}
		if (
			(message.role !== "user" && message.role !== "toolResult") ||
			(message.role === "toolResult" && !completeToolResults.has(i)) ||
			!hasAssistantResponse ||
			!Array.isArray(message.content) ||
			!message.content.some(isLargeImagePart)
		)
			continue;
		const id = ids[i];
		if (
			!id ||
			frozenIds.has(id) ||
			positionTag === undefined ||
			positionTag > args.watermark
		)
			continue;
		if (
			(args.usagePercentage ?? 0) < 95 &&
			positionTag >= (args.protectedCutoff ?? Infinity)
		)
			continue;
		selected.push(id);
	}
	return selected;
}

/** Persist newly selected image-strip ids before editing; replay saved ids without rechecking eligibility. */
export function stripPiProcessedImages(
	args: StripPiProcessedImagesArgs,
): StripPiProcessedImagesResult {
	const frozenIds = getProcessedImageStrippedIds(args.db, args.sessionId);
	const newlyStrippedIds = planPiProcessedImageIds(args, frozenIds);

	if (newlyStrippedIds.length > 0) {
		const persisted = (args.addIds ?? addProcessedImageStrippedIds)(
			args.db,
			args.sessionId,
			newlyStrippedIds,
		);
		if (persisted) {
			for (const id of newlyStrippedIds) frozenIds.add(id);
		} else {
			newlyStrippedIds.length = 0;
			sessionLog(
				args.sessionId,
				"processed-image strip: persistence failed; leaving newly detected images intact",
			);
		}
	}

	let stripped = 0;
	for (let i = 0; i < args.messages.length; i++) {
		const raw = args.messages[i];
		if (!raw || typeof raw !== "object") continue;
		const id = args.stableId(raw, i);
		if (!id || !frozenIds.has(id)) continue;
		const message = raw as { content?: unknown };
		if (!Array.isArray(message.content)) continue;
		for (let partIndex = 0; partIndex < message.content.length; partIndex++) {
			if (!isLargeImagePart(message.content[partIndex])) continue;
			if (newlyStrippedIds.includes(id))
				args.onFirstApplication?.(raw, i, partIndex);
			message.content[partIndex] = {
				type: "text",
				text: STRIPPED_IMAGE_MARKER,
			};
			stripped++;
		}
	}

	return { stripped, newlyStrippedIds };
}
