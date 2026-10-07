import {
	createDbLkgPersistence,
	saveLkgSlotToDb,
} from "@magic-context/core/hooks/magic-context/lkg-persist";
import { replayLkg } from "@magic-context/core/hooks/magic-context/lkg-replay";
import { recordServedCapture } from "@magic-context/core/hooks/magic-context/lkg-served-marker";
import {
	captureSlot,
	contentSnapshotValue,
	dropSlot,
	exactReusablePrefix,
	getSlot,
	incrementalLkgContentDigests,
	LKG_SNAPSHOT_ARRAY,
	LKG_SNAPSHOT_BOOLEAN,
	LKG_SNAPSHOT_KEY,
	LKG_SNAPSHOT_NULL,
	LKG_SNAPSHOT_NUMBER,
	LKG_SNAPSHOT_OBJECT,
	LKG_SNAPSHOT_STRING,
	LKG_SNAPSHOT_UNDEFINED,
	type LkgContentField,
	type LkgEntryNote,
	type LkgSlot,
	lkgContentDigestFromFields,
	lkgContentFields,
	registerLkgPersistence,
	signatureForFields,
} from "@magic-context/core/hooks/magic-context/lkg-slot";
import { moveMessageDigestFromFields } from "@magic-context/core/hooks/magic-context/move-inputs";
import type { MessageLike } from "@magic-context/core/hooks/magic-context/transform-operations";
import { piModelRefToCanonical } from "@magic-context/core/shared/harness-provider-map";
import { sessionLog } from "@magic-context/core/shared/logger";
import { isRecord } from "@magic-context/core/shared/record-type-guard";
import type { Database } from "@magic-context/core/shared/sqlite";
import type { PiMeasuredPrefixFit } from "./pi-raw-fallback";
import { isPiSystemEntry } from "./system-entry-pi";

interface PiLkgInputSnapshot {
	id: string;
	messageIndex: number;
	fields: readonly LkgContentField[];
}

export interface PiLkgPassSnapshot {
	systemEntries?: readonly string[];
	sessionId: string;
	inputs: PiLkgInputSnapshot[];
	preparationFailure: string | null;
	replayFailure: string | null;
	replayAnchorInputIndex: number | null;
	pristineTail: MessageLike[] | null;
	modelKey: string | null;
	providerKey: string | null;
}

export type PiLkgReplayResult =
	| { ok: true; messages: MessageLike[]; measuredPrefix?: PiMeasuredPrefixFit }
	| { ok: false; reason: string };

export interface PiLkgCaptureTiming {
	sessionId: string;
	elapsedMs: number;
	reusedPrefix: number;
}

/** Detached serialization of this pass's exact output, for same-pass observers. */
export interface PiLkgSerializedOutput {
	jsonMessages: readonly string[];
	json: string;
}

interface PiLkgSessionState {
	captureSequence: number;
	syncCaptureRequired: boolean;
	acceptedInputs: readonly PiLkgInputSnapshot[] | null;
	acceptedSlot: LkgSlot | null;
	outputSnapshot: {
		inputs: { id: string; fields: readonly LkgContentField[] }[];
		jsonMessages: string[];
		json: string;
	} | null;
	capturedRequest?: PiLkgCapturePlan & {
		envelopeSignature: string;
		usage?: { signature: string; inputTokens: number };
	};
}

interface PiLkgCapturePlan {
	servedCaptureId?: number;
	sessionId: string;
	inputs: PiLkgInputSnapshot[];
	jsonPrefix: string;
	modelKey: string | null;
	providerKey: string | null;
	capturedAt: number;
	captureSequence: number;
}

const piLkgSessionStates = new Map<string, PiLkgSessionState>();

function completedProviderUsage(message: unknown):
	| {
			signature: string;
			inputTokens: number;
			modelKey: string;
			providerKey: string;
			timestamp: number;
	  }
	| undefined {
	if (
		!isRecord(message) ||
		message.role !== "assistant" ||
		!["stop", "length", "toolUse"].includes(String(message.stopReason)) ||
		typeof message.provider !== "string" ||
		!message.provider ||
		typeof message.model !== "string" ||
		!message.model ||
		typeof message.timestamp !== "number" ||
		!Number.isFinite(message.timestamp) ||
		!isRecord(message.usage)
	)
		return;
	const usage = message.usage;
	const counts = [usage.input, usage.cacheRead, usage.cacheWrite];
	if (
		!counts.every(
			(count) =>
				typeof count === "number" && Number.isSafeInteger(count) && count >= 0,
		)
	)
		return;
	let inputTokens =
		(usage.input as number) +
		(usage.cacheRead as number) +
		(usage.cacheWrite as number);
	if (
		typeof usage.totalTokens === "number" &&
		Number.isSafeInteger(usage.totalTokens) &&
		typeof usage.output === "number" &&
		Number.isSafeInteger(usage.output) &&
		usage.output >= 0
	) {
		inputTokens = Math.max(inputTokens, usage.totalTokens - usage.output);
	}
	if (!Number.isSafeInteger(inputTokens) || inputTokens <= 0) return;
	return {
		inputTokens,
		modelKey: `${message.provider}/${message.model}`,
		providerKey: message.provider,
		timestamp: message.timestamp,
		signature: JSON.stringify([
			message.provider,
			message.model,
			message.timestamp,
			message.stopReason,
			usage.input,
			usage.cacheRead,
			usage.cacheWrite,
			usage.output,
			usage.totalTokens,
		]),
	};
}

/** Observe a terminal provider reply before Pi appends it to JSONL. The leaf must
 * still be the captured request's last real input, never an inferred position. */
export function notePiLkgProviderUsage(
	sessionId: string,
	parentInputId: string | null,
	message: unknown,
): boolean {
	try {
		const state = piLkgSessionStates.get(sessionId);
		const request = state?.capturedRequest;
		const usage = completedProviderUsage(message);
		if (
			!request ||
			request.usage ||
			!usage ||
			request.captureSequence !== state?.captureSequence ||
			!parentInputId ||
			parentInputId.startsWith("pi-lkg-unmapped:") ||
			parentInputId !== request.inputs.at(-1)?.id ||
			usage.timestamp < request.capturedAt ||
			usage.modelKey !== request.modelKey ||
			usage.providerKey !== request.providerKey
		)
			return false;
		request.usage = {
			signature: usage.signature,
			inputTokens: usage.inputTokens,
		};
		return true;
	} catch {
		return false;
	}
}

export function clearPiLkgSessionState(sessionId: string): void {
	const state = piLkgSessionStates.get(sessionId);
	if (state) state.captureSequence += 1;
	piLkgSessionStates.delete(sessionId);
}

export interface PiLkgCoordinator {
	beginPass(args: {
		sessionId: string;
		messages: readonly unknown[];
		entryIds: readonly (string | undefined)[] | null;
		modelKey: string | null;
		providerKey: string | null;
	}): PiLkgPassSnapshot;
	replay(
		snapshot: PiLkgPassSnapshot,
		parentOf?: (id: string) => string | null | undefined,
	): PiLkgReplayResult;
	/** Provider evidence for a healthy output, without performing a replay. */
	measureOutgoingPrefix(
		snapshot: PiLkgPassSnapshot,
		messages: readonly unknown[],
		parentOf?: (id: string) => string | null | undefined,
	): PiMeasuredPrefixFit | undefined;
	captureAppliedPass(args: {
		snapshot: PiLkgPassSnapshot;
		outputMessages: readonly unknown[];
		outputEntryIds?: readonly (string | null | undefined)[];
		cacheBusting: boolean;
		/** Native compaction owns the prompt when false; no move certification. */
		certify?: boolean;
		hostEnvelopeSignature?: string;
	}): PiLkgSerializedOutput | undefined;
}

export function isTransientPiStorageError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const candidate = error as { code?: unknown; message?: unknown };
	if (
		candidate.code === "SQLITE_BUSY" ||
		candidate.code === "SQLITE_LOCKED" ||
		candidate.code === "SQLITE_BUSY_SNAPSHOT"
	) {
		return true;
	}
	return (
		typeof candidate.message === "string" &&
		/database is locked|database table is locked|sqlite_(busy|locked)/i.test(
			candidate.message,
		)
	);
}

export function reconcilePiLkgEntryIds(
	resolved: readonly (string | undefined)[] | null,
	alignedProjection: readonly (string | undefined)[] | null,
): readonly (string | undefined)[] | null {
	if (!resolved || !alignedProjection || resolved.length === 0) return resolved;
	const result = [...resolved];
	const anchors: Array<{ messageIndex: number; projectionIndex: number }> = [];
	let projectionCursor = 0;
	for (
		let messageIndex = 0;
		messageIndex < resolved.length;
		messageIndex += 1
	) {
		const id = resolved[messageIndex];
		if (typeof id !== "string") continue;
		let projectionIndex = -1;
		for (
			let index = projectionCursor;
			index < alignedProjection.length;
			index += 1
		) {
			if (alignedProjection[index] === id) {
				projectionIndex = index;
				break;
			}
		}
		if (projectionIndex < 0) return resolved;
		anchors.push({ messageIndex, projectionIndex });
		projectionCursor = projectionIndex + 1;
	}
	if (anchors.length === 0) return resolved;

	const fillEqualSpan = (
		messageStart: number,
		messageEnd: number,
		projectionStart: number,
		projectionEnd: number,
	): void => {
		if (messageEnd - messageStart !== projectionEnd - projectionStart) return;
		for (let offset = 0; offset < messageEnd - messageStart; offset += 1) {
			result[messageStart + offset] ??=
				alignedProjection[projectionStart + offset];
		}
	};
	let previousMessageIndex = -1;
	let previousProjectionIndex = -1;
	for (const anchor of anchors) {
		fillEqualSpan(
			previousMessageIndex + 1,
			anchor.messageIndex,
			previousProjectionIndex + 1,
			anchor.projectionIndex,
		);
		previousMessageIndex = anchor.messageIndex;
		previousProjectionIndex = anchor.projectionIndex;
	}
	fillEqualSpan(
		previousMessageIndex + 1,
		resolved.length,
		previousProjectionIndex + 1,
		alignedProjection.length,
	);
	return result;
}

export function piStorageErrorReason(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (error && typeof error === "object") {
		const code = (error as { code?: unknown }).code;
		if (
			code === "SQLITE_BUSY" ||
			code === "SQLITE_LOCKED" ||
			code === "SQLITE_BUSY_SNAPSHOT"
		) {
			return code;
		}
	}
	if (/database is locked|database table is locked/i.test(message)) {
		return "SQLITE_BUSY_OR_LOCKED";
	}
	if (error && typeof error === "object") {
		const code = (error as { code?: unknown }).code;
		if (typeof code === "string" && code.length > 0) return code;
	}
	return message;
}

// JSON serializers on non-plain values (for example Date) are not represented
// by field tokens. Keep the original array serialization path for those values.
/** Validate JSON-visible data and detach exact field tokens in the same walk. */
function plainJsonFields(value: unknown): LkgContentField[] | null {
	const fields: LkgContentField[] = [];
	const seen = new WeakSet<object>();
	const visit = (child: unknown): boolean => {
		if (child === null) fields.push(LKG_SNAPSHOT_NULL);
		else if (typeof child === "string") fields.push(LKG_SNAPSHOT_STRING, child);
		else if (typeof child === "number") fields.push(LKG_SNAPSHOT_NUMBER, child);
		else if (typeof child === "boolean")
			fields.push(LKG_SNAPSHOT_BOOLEAN, child);
		else if (typeof child !== "object") fields.push(LKG_SNAPSHOT_UNDEFINED);
		else {
			if (seen.has(child)) return false;
			const array = Array.isArray(child);
			const prototype = Object.getPrototypeOf(child);
			if (
				(!array && prototype !== Object.prototype && prototype !== null) ||
				"toJSON" in child
			)
				return false;
			const keys = Object.keys(child);
			if (array && keys.length !== child.length) return false;
			seen.add(child);
			fields.push(array ? LKG_SNAPSHOT_ARRAY : LKG_SNAPSHOT_OBJECT);
			const countIndex = fields.length;
			fields.push(array ? child.length : 0);
			let count = 0;
			for (const key of keys) {
				const descriptor = Object.getOwnPropertyDescriptor(child, key);
				if (
					!descriptor ||
					!("value" in descriptor) ||
					(array && key !== String(count))
				)
					return false;
				const entry: unknown = descriptor.value;
				if (
					!array &&
					(entry === undefined ||
						typeof entry === "function" ||
						typeof entry === "symbol")
				)
					continue;
				count++;
				if (!array) fields.push(LKG_SNAPSHOT_KEY, key);
				if (!visit(entry)) return false;
			}
			if (!array) fields[countIndex] = count;
			seen.delete(child);
		}
		return true;
	};
	if (!visit(value)) return null;
	// The shared snapshot ignores an empty OpenCode diff summary. Native Pi
	// messages never carry that shape, but preserve compatibility for adapters.
	const normalized = contentSnapshotValue(value);
	return normalized === value ? fields : lkgContentFields(normalized);
}

function plainOutputFields(
	messages: readonly unknown[],
): { id: string; fields: readonly LkgContentField[] }[] | null {
	if ("toJSON" in messages || Object.keys(messages).length !== messages.length)
		return null;
	const outputs: { id: string; fields: readonly LkgContentField[] }[] = [];
	for (let index = 0; index < messages.length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(messages, String(index));
		if (!descriptor || !("value" in descriptor)) return null;
		const fields = plainJsonFields(descriptor.value);
		if (!fields) return null;
		outputs.push({ id: String(index), fields });
	}
	return outputs;
}

function snapshotInputs(
	messages: readonly unknown[],
	entryIds: readonly (string | undefined)[] | null,
): { inputs: PiLkgInputSnapshot[]; failure: string | null } {
	if (!entryIds || entryIds.length !== messages.length) {
		return { inputs: [], failure: "lkg_entry_ids_unavailable" };
	}
	const firstStableIndex = entryIds.findIndex(
		(id): id is string => typeof id === "string" && id.length > 0,
	);
	if (firstStableIndex < 0) {
		return { inputs: [], failure: "lkg_entry_ids_unavailable" };
	}
	const inputs: PiLkgInputSnapshot[] = [];
	const seen = new Set<string>();
	for (let index = 0; index < entryIds.length; index += 1) {
		const fields = lkgContentFields(messages[index]);
		if (!fields) return { inputs: [], failure: "lkg_content_snapshot_failed" };
		// Host extensions can inject entries absent from JSONL. A detached full-
		// content digest gives those entries a stable identity without guessing a
		// positional JSONL owner. Identical unknown entries remain ambiguous.
		const id =
			entryIds[index] ||
			`pi-lkg-unmapped:${lkgContentDigestFromFields(fields)}`;
		if (seen.has(id)) return { inputs: [], failure: "lkg_duplicate_entry_id" };
		seen.add(id);
		inputs.push({ id, messageIndex: index, fields });
	}
	return { inputs, failure: null };
}

/**
 * Adapt Pi's JSONL entry ids and native AgentMessage shape to the shared LKG
 * slot/replay implementation. FNV/SHA digest work and durable writes run from
 * setImmediate; only detached field tokens and the exact served JSON bytes are
 * captured synchronously, so a later pass cannot hash objects the handler has
 * already mutated.
 */
export function createPiLkgCoordinator(
	db: Database,
	scheduleCapture: (capture: () => void) => void = (capture) =>
		setImmediate(capture),
	onCaptureTiming?: (sample: PiLkgCaptureTiming) => void,
): PiLkgCoordinator {
	registerLkgPersistence(createDbLkgPersistence(db));
	const stateFor = (sessionId: string): PiLkgSessionState => {
		let state = piLkgSessionStates.get(sessionId);
		if (!state) {
			state = {
				captureSequence: 0,
				syncCaptureRequired: false,
				acceptedInputs: null,
				acceptedSlot: null,
				outputSnapshot: null,
			};
			piLkgSessionStates.set(sessionId, state);
		}
		return state;
	};

	const beginPass: PiLkgCoordinator["beginPass"] = (args) => {
		const snapped = snapshotInputs(args.messages, args.entryIds);
		const slot = getSlot(args.sessionId);
		if (snapped.failure || !slot) {
			return {
				sessionId: args.sessionId,
				inputs: snapped.inputs,
				preparationFailure: snapped.failure,
				replayFailure: snapped.failure ?? "lkg_miss",
				replayAnchorInputIndex: null,
				pristineTail: null,
				modelKey: args.modelKey,
				providerKey: args.providerKey,
			};
		}
		const stableAnchorIndex = snapped.inputs.findIndex(
			(input) => input.id === slot.lastInputMessageId,
		);
		if (stableAnchorIndex < 0) {
			return {
				sessionId: args.sessionId,
				inputs: snapped.inputs,
				preparationFailure: null,
				replayFailure: "lkg_invalidated_reshape",
				replayAnchorInputIndex: null,
				pristineTail: null,
				modelKey: args.modelKey,
				providerKey: args.providerKey,
			};
		}
		const messageAnchorIndex = snapped.inputs[stableAnchorIndex]?.messageIndex;
		if (messageAnchorIndex === undefined) {
			return {
				sessionId: args.sessionId,
				inputs: snapped.inputs,
				preparationFailure: null,
				replayFailure: "lkg_invalidated_reshape",
				replayAnchorInputIndex: null,
				pristineTail: null,
				modelKey: args.modelKey,
				providerKey: args.providerKey,
			};
		}
		try {
			return {
				sessionId: args.sessionId,
				inputs: snapped.inputs,
				preparationFailure: null,
				replayFailure: null,
				replayAnchorInputIndex: stableAnchorIndex,
				pristineTail: structuredClone(
					args.messages.slice(messageAnchorIndex + 1),
				) as MessageLike[],
				modelKey: args.modelKey,
				providerKey: args.providerKey,
			};
		} catch {
			return {
				sessionId: args.sessionId,
				inputs: snapped.inputs,
				preparationFailure: null,
				replayFailure: "lkg_tail_snapshot_failed",
				replayAnchorInputIndex: null,
				pristineTail: null,
				modelKey: args.modelKey,
				providerKey: args.providerKey,
			};
		}
	};

	const measuredPrefixFor = (
		snapshot: PiLkgPassSnapshot,
		slot: LkgSlot | undefined,
		parentOf?: (id: string) => string | null | undefined,
	): PiMeasuredPrefixFit | undefined => {
		const request = stateFor(snapshot.sessionId).capturedRequest;
		const anchor = snapshot.replayAnchorInputIndex;

		if (
			!request?.usage ||
			!slot ||
			!parentOf ||
			anchor === null ||
			!snapshot.pristineTail ||
			request.captureSequence !==
				stateFor(snapshot.sessionId).captureSequence ||
			request.captureSequence !== slot.captureSequence ||
			request.capturedAt !== slot.capturedAt ||
			request.jsonPrefix !== slot.jsonPrefix ||
			!request.modelKey ||
			request.modelKey !== slot.modelKey ||
			request.modelKey !== snapshot.modelKey ||
			request.providerKey !== slot.providerKey ||
			request.providerKey !== snapshot.providerKey ||
			slot.lastInputMessageId !== request.inputs.at(-1)?.id ||
			snapshot.inputs[anchor]?.id !== slot.lastInputMessageId
		)
			return;
		const assistantId = snapshot.inputs[anchor + 1]?.id;
		const usage = completedProviderUsage(snapshot.pristineTail[0]);
		if (
			!assistantId ||
			assistantId.startsWith("pi-lkg-unmapped:") ||
			usage?.signature !== request.usage.signature
		)
			return;
		try {
			if (parentOf(assistantId) !== slot.lastInputMessageId) return;
		} catch {
			return;
		}
		// The accepted assistant reply is new input on this replay, so it remains
		// in the tail priced above the provider's prior-request input count.
		return {
			modelKey: piModelRefToCanonical(request.modelKey).toLowerCase(),
			inputTokens: request.usage.inputTokens,
			envelopeSignature: request.envelopeSignature,
			appendedMessages: snapshot.pristineTail,
		};
	};
	const replay: PiLkgCoordinator["replay"] = (snapshot, parentOf) => {
		if (snapshot.replayFailure) {
			if (snapshot.replayFailure === "lkg_invalidated_reshape") {
				dropSlot(snapshot.sessionId, snapshot.replayFailure);
				stateFor(snapshot.sessionId).acceptedInputs = null;
			}
			return { ok: false, reason: snapshot.replayFailure };
		}
		if (
			snapshot.replayAnchorInputIndex === null ||
			snapshot.pristineTail === null
		) {
			return { ok: false, reason: "lkg_miss" };
		}
		const slot = getSlot(snapshot.sessionId);
		const start = slot?.inputIdSeq.indexOf(snapshot.inputs[0]?.id ?? "") ?? -1;
		if (slot && start > 0) {
			const ownership = slot.piOutputEntryIds;
			if (!ownership)
				return { ok: false, reason: "lkg_output_mapping_unavailable" };
			if (
				slot.modelKey !== snapshot.modelKey ||
				slot.providerKey !== snapshot.providerKey
			)
				return { ok: false, reason: "lkg_model_mismatch" };
			const surviving = snapshot.inputs.slice(
				0,
				snapshot.replayAnchorInputIndex + 1,
			);
			if (
				surviving.length !== slot.inputIdSeq.length - start ||
				surviving.some(
					(input, index) => input.id !== slot.inputIdSeq[start + index],
				)
			)
				return { ok: false, reason: "lkg_invalidated_reshape" };
			if (
				surviving.some(
					(input, index) =>
						lkgContentDigestFromFields(input.fields) !==
						slot.inputContentDigests[start + index],
				)
			)
				return { ok: false, reason: "lkg_content_mismatch" };
			const removed = new Set(slot.inputIdSeq.slice(0, start));
			const prefix = JSON.parse(slot.jsonPrefix) as MessageLike[];
			const measuredPrefix = measuredPrefixFor(snapshot, slot, parentOf);
			return {
				ok: true,
				...(measuredPrefix ? { measuredPrefix } : {}),
				messages: [
					...prefix.filter(
						(message, index) =>
							isPiSystemEntry(message) ||
							ownership[index] === null ||
							!removed.has(ownership[index] ?? ""),
					),
					...snapshot.pristineTail,
				],
			};
		}
		const entry: LkgEntryNote = {
			pristineTail: snapshot.pristineTail,
			entryInputIds: snapshot.inputs.map((input) => input.id),
			entryContentDigests: snapshot.inputs
				.slice(0, snapshot.replayAnchorInputIndex + 1)
				.map((input) => lkgContentDigestFromFields(input.fields)),
			anchorIndex: snapshot.replayAnchorInputIndex,
		};
		const result = replayLkg({
			sessionId: snapshot.sessionId,
			messages: [] as MessageLike[],
			modelKey: snapshot.modelKey,
			providerKey: snapshot.providerKey,
			entry,
			// The shared seam validator reads OpenCode part shapes. Pi's prefix is a
			// complete prior AgentMessage[] ending at a JSONL entry boundary, so its
			// stable-id/content fences are the applicable seam proof.
			skipSeamValidation: true,
		});
		if (!result.ok) stateFor(snapshot.sessionId).acceptedInputs = null;
		const measuredPrefix = result.ok
			? measuredPrefixFor(snapshot, slot, parentOf)
			: undefined;
		return result.ok && measuredPrefix ? { ...result, measuredPrefix } : result;
	};

	const captureAppliedPass: PiLkgCoordinator["captureAppliedPass"] = (args) => {
		const { snapshot } = args;
		if (snapshot.preparationFailure || snapshot.inputs.length === 0) return;
		const state = stateFor(snapshot.sessionId);
		let jsonPrefix: string;
		try {
			// Pi clones the host array between hooks, so reference identity cannot prove
			// an unchanged output. Detached field tokens also detect in-place rewrites.
			const detachedOutputs = plainOutputFields(args.outputMessages);
			const plainOutput = detachedOutputs !== null;
			const outputs = detachedOutputs ?? [];
			const priorOutput = plainOutput ? state.outputSnapshot : null;
			const prefix = exactReusablePrefix(outputs, priorOutput?.inputs ?? null);
			const jsonMessages = [
				...(priorOutput?.jsonMessages.slice(0, prefix) ?? []),
				...(plainOutput
					? args.outputMessages
							.slice(prefix)
							.map((message) => JSON.stringify(message) ?? "null")
					: []),
			];
			jsonPrefix = !plainOutput
				? JSON.stringify(args.outputMessages)
				: priorOutput &&
						prefix === outputs.length &&
						prefix === priorOutput.inputs.length
					? priorOutput.json
					: `[${jsonMessages.join(",")}]`;
			state.outputSnapshot = plainOutput
				? {
						inputs: outputs,
						jsonMessages,
						json: jsonPrefix,
					}
				: null;
		} catch (error) {
			dropSlot(
				snapshot.sessionId,
				"lkg_snapshot_serialize_failed",
				args.certify !== false,
			);
			const failedState = stateFor(snapshot.sessionId);
			failedState.syncCaptureRequired = true;
			failedState.acceptedInputs = null;
			sessionLog(
				snapshot.sessionId,
				"LKG SNAPSHOT PREPARATION FAILED; forcing synchronous capture on the next applied pass:",
				error,
			);
			return;
		}
		const idsByDigest = new Map<string, string | undefined>();
		if (!args.outputEntryIds)
			for (const input of snapshot.inputs) {
				const digest = lkgContentDigestFromFields(input.fields);
				idsByDigest.set(digest, idsByDigest.has(digest) ? undefined : input.id);
			}
		const inferredIds =
			args.outputEntryIds ??
			args.outputMessages.map((message) => {
				const fields = lkgContentFields(message);
				if (!fields) return undefined;
				const digest = lkgContentDigestFromFields(fields);
				return idsByDigest.get(digest);
			});
		const outputIds = args.outputEntryIds ?? inferredIds;
		const inputIds = new Set(snapshot.inputs.map((input) => input.id));
		const ownership =
			outputIds.length === args.outputMessages.length &&
			outputIds.every(
				(id) => id === null || (typeof id === "string" && inputIds.has(id)),
			)
				? ([...outputIds] as (string | null)[])
				: undefined;
		state.captureSequence += 1;
		const plan: PiLkgCapturePlan = {
			sessionId: snapshot.sessionId,
			inputs: snapshot.inputs,
			jsonPrefix,
			modelKey: snapshot.modelKey,
			providerKey: snapshot.providerKey,
			capturedAt: Date.now(),
			captureSequence: state.captureSequence,
		};
		state.capturedRequest = args.hostEnvelopeSignature
			? { ...plan, envelopeSignature: args.hostEnvelopeSignature }
			: undefined;
		const livePrior = getSlot(snapshot.sessionId);
		const unchanged =
			livePrior &&
			livePrior.modelKey === plan.modelKey &&
			livePrior.providerKey === plan.providerKey &&
			livePrior.jsonPrefix === plan.jsonPrefix &&
			livePrior.inputIdSeq.length === plan.inputs.length &&
			exactReusablePrefix(plan.inputs, state.acceptedInputs) ===
				plan.inputs.length &&
			JSON.stringify(livePrior.piOutputEntryIds) === JSON.stringify(ownership);
		if (unchanged && !state.syncCaptureRequired) {
			// Provider usage can arrive before the deferred commit. Refresh the
			// replay slot's identity in memory now without rewriting unchanged
			// durable bytes. The new capturedRequest has no usage, so previous
			// measurements remain superseded.
			const kept = {
				...livePrior,
				capturedAt: plan.capturedAt,
				captureSequence: plan.captureSequence,
			};
			if (captureSlot(plan.sessionId, kept)) state.acceptedSlot = kept;
			else state.syncCaptureRequired = true;
		}
		if (args.cacheBusting && !unchanged) {
			dropSlot(
				snapshot.sessionId,
				"lkg_cache_bust_pending_capture",
				args.certify !== false,
			);
			// Replay is invalidated immediately, but detached input fingerprints are
			// safe for a new capture after exact id/content validation.
		}
		// Only the small cross-process identity is synchronous. Unchanged bytes
		// retain their previous identity and do not rewrite either durable record.
		plan.servedCaptureId =
			args.certify === false
				? undefined
				: unchanged && !state.syncCaptureRequired
					? livePrior.servedCaptureId
					: recordServedCapture(db, snapshot.sessionId, true);
		// Keep all N stable inputs flattened before returning from this context handler.
		// Pi passes a structured clone through awaited extension handlers, so a later
		// extension in the same emitContext call may rewrite any returned entry before
		// this immediate runs. MC's own pipeline can also replace entries. The deferred
		// work therefore reads only detached primitive/symbol field tokens, never live
		// MessageLike objects. message_end appends/scrubs a newly completed entry and
		// streaming grows the in-flight assistant, neither of which belonged to this
		// pass's input set. A newer context pass supersedes this plan by captureSequence.
		// Fork/revert/switch are separate awaited host events; their next pass either
		// supersedes this callback or invalidates reuse at its first id/field mismatch,
		// while session cleanup increments and clears this session's capture state.
		const commit = (): void => {
			if (plan.captureSequence !== state.captureSequence) return;
			const startedAt = performance.now();
			let reusedPrefix = 0;
			try {
				const inputIdSeq = plan.inputs.map((input) => input.id);
				const prior = getSlot(plan.sessionId);
				const digestPrior = prior ?? state.acceptedSlot;
				const reusePrior =
					digestPrior?.inputContentSignatures !== undefined &&
					digestPrior.modelKey === plan.modelKey &&
					digestPrior.providerKey === plan.providerKey
						? {
								slot: digestPrior,
								signatures: digestPrior.inputContentSignatures,
							}
						: undefined;
				const reusablePrefix = reusePrior
					? exactReusablePrefix(plan.inputs, state.acceptedInputs)
					: 0;
				const inputContentSignatures = [
					...(reusePrior ? reusePrior.signatures.slice(0, reusablePrefix) : []),
					...plan.inputs
						.slice(reusablePrefix)
						.map((input) => signatureForFields(input.fields)),
				];
				const incremental = incrementalLkgContentDigests(
					plan.inputs.map((input, index) => ({
						id: input.id,
						signature: inputContentSignatures[index] ?? "",
						fields: input.fields,
					})),
					reusePrior
						? {
								ids: reusePrior.slot.inputIdSeq.slice(0, reusablePrefix),
								signatures: reusePrior.signatures.slice(0, reusablePrefix),
								digests: reusePrior.slot.inputContentDigests.slice(
									0,
									reusablePrefix,
								),
							}
						: undefined,
				);
				reusedPrefix = incremental.reusedPrefix;
				if (
					!state.syncCaptureRequired &&
					prior &&
					reusedPrefix === plan.inputs.length &&
					prior.inputIdSeq.length === plan.inputs.length &&
					prior.jsonPrefix === plan.jsonPrefix &&
					JSON.stringify(prior.piOutputEntryIds) === JSON.stringify(ownership)
				) {
					state.acceptedInputs = plan.inputs;
					return;
				}
				const slot = {
					jsonPrefix: plan.jsonPrefix,
					piOutputEntryIds: ownership,
					inputIdSeq,
					inputContentDigests: incremental.digests,
					inputContentSignatures,
					lastInputMessageId: plan.inputs.at(-1)?.id ?? "",
					modelKey: plan.modelKey,
					providerKey: plan.providerKey,
					capturedAt: plan.capturedAt,
					captureSequence: plan.captureSequence,
					servedCaptureId: plan.servedCaptureId,
					inputMoveDigests: plan.inputs.map((input) =>
						moveMessageDigestFromFields(input.fields),
					),
				};
				if (!captureSlot(plan.sessionId, slot)) {
					throw new Error("LKG slot rejected the Pi snapshot");
				}
				state.acceptedInputs = plan.inputs;
				state.acceptedSlot = slot;
				const persisted = saveLkgSlotToDb(db, plan.sessionId, slot);
				state.syncCaptureRequired = !persisted;
			} catch (error) {
				if (plan.captureSequence !== state.captureSequence) return;
				dropSlot(
					plan.sessionId,
					"lkg_async_capture_failed",
					args.certify !== false,
				);
				state.syncCaptureRequired = true;
				state.acceptedInputs = null;
				sessionLog(
					plan.sessionId,
					"LKG ASYNC CAPTURE FAILED; forcing synchronous capture on the next applied pass:",
					error,
				);
			} finally {
				try {
					onCaptureTiming?.({
						sessionId: plan.sessionId,
						elapsedMs: performance.now() - startedAt,
						reusedPrefix,
					});
				} catch {
					// Timing diagnostics cannot change LKG capture behavior.
				}
			}
		};
		if (state.syncCaptureRequired) {
			commit();
		} else {
			try {
				scheduleCapture(commit);
			} catch (error) {
				dropSlot(
					plan.sessionId,
					"lkg_capture_schedule_failed",
					args.certify !== false,
				);
				state.syncCaptureRequired = true;
				state.acceptedInputs = null;
				sessionLog(
					plan.sessionId,
					"LKG CAPTURE SCHEDULE FAILED; forcing synchronous capture on the next applied pass:",
					error,
				);
			}
		}
		return state.outputSnapshot ?? undefined;
	};

	return {
		beginPass(args) {
			return {
				...beginPass(args),
				systemEntries: args.messages
					.filter(isPiSystemEntry)
					.map((message) => JSON.stringify(message)),
			};
		},
		replay(snapshot, parentOf) {
			const result = replay(snapshot, parentOf);
			if (!result.ok) return result;
			const systems = result.messages
				.filter(isPiSystemEntry)
				.map((message) => JSON.stringify(message));
			let cursor = 0;
			for (const expected of snapshot.systemEntries ?? []) {
				const index = systems.indexOf(expected, cursor);
				if (index < 0)
					return { ok: false, reason: "lkg_system_state_mismatch" };
				cursor = index + 1;
			}
			return result;
		},
		captureAppliedPass,
		measureOutgoingPrefix(snapshot, messages, parentOf) {
			try {
				const slot = getSlot(snapshot.sessionId);
				const measured = measuredPrefixFor(snapshot, slot, parentOf);
				if (!slot || !measured) return;
				const prefix = JSON.parse(slot.jsonPrefix) as unknown[];
				// A healthy reclaim may have removed or rewritten the old prefix.
				// Usage belongs to those exact served bytes, never to their replacement.
				if (
					!Array.isArray(prefix) ||
					messages.length < prefix.length ||
					JSON.stringify(messages.slice(0, prefix.length)) !== slot.jsonPrefix
				)
					return;
				const appendedMessages = messages.slice(prefix.length);
				// Tagging/stripping can rewrite the new reply's content. Its usage
				// identity must still match; price the actual returned tail separately.
				if (
					completedProviderUsage(appendedMessages[0])?.signature !==
					completedProviderUsage(snapshot.pristineTail?.[0])?.signature
				)
					return;
				return { ...measured, appendedMessages };
			} catch {
				return;
			}
		},
	};
}

/** Synthetic todo results follow their assistant owner when a raw head is trimmed. */
export function resolvePiLkgOutputEntryIds(
	messages: readonly unknown[],
	syntheticLeadingCount: number,
	entryId: (message: object) => string | undefined,
): (string | null | undefined)[] {
	const ids = messages.map((message, index) =>
		index < syntheticLeadingCount && !isPiSystemEntry(message)
			? null
			: isRecord(message)
				? entryId(message)
				: undefined,
	);
	const syntheticOwners = new Map<string, string | undefined>();
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		const owner = ids[index];
		if (
			typeof owner !== "string" ||
			!isRecord(message) ||
			message.role !== "assistant" ||
			!Array.isArray(message.content)
		)
			continue;
		for (const part of message.content) {
			if (
				isRecord(part) &&
				part.type === "toolCall" &&
				part.syntheticTodoMarker === true &&
				typeof part.id === "string"
			)
				syntheticOwners.set(
					part.id,
					syntheticOwners.has(part.id) ? undefined : owner,
				);
		}
	}
	return ids.map((id, index) => {
		const message = messages[index];
		return id === undefined &&
			isRecord(message) &&
			message.role === "toolResult" &&
			message.syntheticTodoMarker === true &&
			typeof message.toolCallId === "string"
			? syntheticOwners.get(message.toolCallId)
			: id;
	});
}
