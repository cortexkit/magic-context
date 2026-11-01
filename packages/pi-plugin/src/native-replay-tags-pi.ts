import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import {
	readReplayEnvelope,
	updateReplayDocument,
} from "@magic-context/core/features/magic-context/storage-replay-document";
import { sessionLog } from "@magic-context/core/shared/logger";
import { isRecord } from "@magic-context/core/shared/record-type-guard";
import {
	nativeResponseTagStripKey,
	PI_NATIVE_TAG_STRIP_PROVENANCE,
} from "./native-replay-tag-provenance-pi";

const FIELD = "piResponsesTagStrips";
const TAG = /^§\d+§ /u;

function readDecisions(value: unknown): Set<string> {
	if (value === undefined) return new Set();
	if (
		!Array.isArray(value) ||
		!value.every(
			(key) => typeof key === "string" && /^[a-f0-9]{64}$/u.test(key),
		)
	)
		throw new Error("Invalid persisted Responses tag strips");
	return new Set(value);
}

function signature(part: unknown): { id: string; phase?: string } | undefined {
	if (!isRecord(part) || typeof part.textSignature !== "string") return;
	try {
		const value: unknown = JSON.parse(part.textSignature);
		if (
			isRecord(value) &&
			value.v === 1 &&
			typeof value.id === "string" &&
			value.id.length > 0 &&
			(value.phase === undefined ||
				value.phase === "commentary" ||
				value.phase === "final_answer")
		)
			return { id: value.id, phase: value.phase };
	} catch {}
}

/** Strip historical native ordinals on a rebuild, then replay only those exact decisions. */
export function applyNativeResponseTagReplayPi(args: {
	db: ContextDatabase;
	sessionId: string;
	messages: unknown[];
	canApply: boolean;
}): number {
	let saved: Set<string> | undefined;
	const added = new Set<string>();
	const pending = new Map<number, Record<string, unknown>>();
	for (const [index, message] of args.messages.entries()) {
		if (
			!isRecord(message) ||
			message.role !== "assistant" ||
			!Array.isArray(message.content) ||
			![
				"openai-responses",
				"azure-openai-responses",
				"openai-codex-responses",
			].includes(String(message.api))
		)
			continue;
		const payload = message.providerPayload;
		if (
			!isRecord(payload) ||
			payload.type !== "openaiResponsesHistory" ||
			payload.dt !== true ||
			!Array.isArray(payload.items)
		)
			continue;
		if (saved === undefined) {
			try {
				saved = readDecisions(
					readReplayEnvelope(args.db, args.sessionId)[FIELD],
				);
			} catch (error) {
				sessionLog(
					args.sessionId,
					`native tag replay unavailable; retaining native history: ${String(error)}`,
				);
				return 0;
			}
		}
		if (!args.canApply && saved.size === 0) return 0;
		const frozen = saved;
		const content = message.content;
		const nativeItems = payload.items;
		const decisions: Record<string, string> = {};
		let changed = false;
		const items = nativeItems.map((item) => {
			if (
				!isRecord(item) ||
				item.type !== "message" ||
				item.role !== "assistant" ||
				(item.phase !== undefined &&
					item.phase !== "commentary" &&
					item.phase !== "final_answer") ||
				!Array.isArray(item.content) ||
				item.content.length !== 1
			)
				return item;
			const output = item.content[0];
			if (
				!isRecord(output) ||
				output.type !== "output_text" ||
				typeof output.text !== "string" ||
				!TAG.test(output.text)
			)
				return item;
			if (
				nativeItems.filter(
					(other) =>
						isRecord(other) &&
						other.id === item.id &&
						other.phase === item.phase,
				).length !== 1
			)
				return item;
			// Bind replay to the native identity and original bytes, not an array
			// position or Magic Context number that can change after a fork or renumbering.
			const key = nativeResponseTagStripKey(item.id, item.phase, output.text);
			if (!frozen.has(key)) {
				if (!args.canApply) return item;
				// Only discovery needs the typed signature. A frozen native edit must
				// survive host rewrites that remove that signature from typed text.
				const blocks = content.filter((block) => {
					const identity = signature(block);
					return (
						identity && identity.id === item.id && identity.phase === item.phase
					);
				});
				const block = blocks[0];
				if (
					blocks.length !== 1 ||
					!isRecord(block) ||
					block.type !== "text" ||
					typeof block.text !== "string" ||
					block.text.replace(TAG, "") !== output.text.replace(TAG, "")
				)
					return item;
				added.add(key);
			}
			decisions[key] = output.text;
			changed = true;
			return {
				...item,
				content: [{ ...output, text: output.text.replace(TAG, "") }],
			};
		});
		if (changed)
			pending.set(index, {
				...message,
				[PI_NATIVE_TAG_STRIP_PROVENANCE]: decisions,
				providerPayload: { ...payload, items },
			});
	}
	// Persist before exposing any new wire bytes. Unknown envelope fields survive
	// the merge, including the independent native tool and reasoning decisions.
	if (added.size > 0) {
		const persisted = updateReplayDocument(args.db, args.sessionId, (doc) => {
			const decisions = readDecisions(doc[FIELD]);
			for (const key of added) decisions.add(key);
			doc.version = 2;
			doc[FIELD] = [...decisions];
			return true;
		});
		if (!persisted) throw new Error("Could not persist Responses tag strips");
	}
	for (const [index, message] of pending) args.messages[index] = message;
	return added.size;
}
