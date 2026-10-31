import { isRecord } from "../../shared/record-type-guard";
import type { Database } from "../../shared/sqlite";
import {
    type ReplayDocument,
    readReplayEnvelope,
    updateReplayDocument,
} from "./storage-replay-document";

const NATIVE_TOOL_INPUTS = "native tool inputs";
const NATIVE_REASONING_IDS = "native reasoning ids";

const nativeWriteBarriers = new WeakMap<Database, Map<string, () => void>>();

/** Publish earlier buffered native decisions before another native writer can insert keys. */
export function withNativeReplayWriteBarrier<T>(
    db: Database,
    sessionId: string,
    beforeWrite: () => void,
    edit: () => T,
): T {
    let sessions = nativeWriteBarriers.get(db);
    if (!sessions) {
        sessions = new Map();
        nativeWriteBarriers.set(db, sessions);
    }
    const prior = sessions.get(sessionId);
    sessions.set(sessionId, beforeWrite);
    try {
        return edit();
    } finally {
        if (prior) sessions.set(sessionId, prior);
        else sessions.delete(sessionId);
    }
}

export interface NativeReplayState {
    toolInputs: Map<string, string>;
    reasoningIds: Set<string>;
}

function invalidPersistedReplayState(lane: string, sessionId: string): Error {
    return new Error(`invalid persisted ${lane} state for session ${sessionId}`);
}

function assertNonEmptyId(
    value: unknown,
    lane: string,
    sessionId: string,
): asserts value is string {
    if (typeof value !== "string" || value.length === 0) {
        throw invalidPersistedReplayState(lane, sessionId);
    }
}

function assertSerializedToolInput(value: unknown, sessionId: string): asserts value is string {
    if (typeof value !== "string") {
        throw invalidPersistedReplayState(NATIVE_TOOL_INPUTS, sessionId);
    }
    try {
        if (!isRecord(JSON.parse(value))) {
            throw new SyntaxError("native tool input must be an object");
        }
    } catch {
        throw invalidPersistedReplayState(NATIVE_TOOL_INPUTS, sessionId);
    }
}

function parseNativeToolInputs(value: unknown, sessionId: string): Map<string, string> {
    if (!isRecord(value)) {
        throw invalidPersistedReplayState(NATIVE_TOOL_INPUTS, sessionId);
    }

    const inputs = new Map<string, string>();
    for (const [id, input] of Object.entries(value)) {
        assertNonEmptyId(id, NATIVE_TOOL_INPUTS, sessionId);
        assertSerializedToolInput(input, sessionId);
        inputs.set(id, input);
    }
    return inputs;
}

function parseNativeReasoningIds(value: unknown, sessionId: string): Set<string> {
    if (!Array.isArray(value)) {
        throw invalidPersistedReplayState(NATIVE_REASONING_IDS, sessionId);
    }

    const ids = new Set<string>();
    for (const id of value) {
        assertNonEmptyId(id, NATIVE_REASONING_IDS, sessionId);
        ids.add(id);
    }
    return ids;
}

function parseNativeReplayState(doc: ReplayDocument, sessionId: string): NativeReplayState {
    const native = doc.piNative;
    if (native === undefined) {
        return { toolInputs: new Map(), reasoningIds: new Set() };
    }
    if (!isRecord(native)) {
        throw invalidPersistedReplayState("native replay", sessionId);
    }

    return {
        toolInputs: parseNativeToolInputs(native.toolInputs, sessionId),
        reasoningIds: parseNativeReasoningIds(native.reasoningIds, sessionId),
    };
}

function replaceNativeReplayState(
    doc: ReplayDocument,
    state: NativeReplayState,
    sessionId: string,
): void {
    const prior = doc.piNative;
    let preserved: Record<string, unknown> = {};
    if (prior !== undefined) {
        if (!isRecord(prior)) {
            throw invalidPersistedReplayState("native replay", sessionId);
        }
        preserved = prior;
    }

    doc.version = 2;
    doc.piNative = {
        ...preserved,
        toolInputs: Object.fromEntries(state.toolInputs),
        reasoningIds: [...state.reasoningIds],
    };
}

/**
 * Read and validate both native replay lanes from one document snapshot. A
 * missing v1/native namespace is empty; a present namespace is all-or-nothing.
 */
export function getNativeReplayState(db: Database, sessionId: string): NativeReplayState {
    return parseNativeReplayState(readReplayEnvelope(db, sessionId), sessionId);
}

/**
 * Return frozen native tool inputs. Missing legacy state is empty; malformed
 * stored native state is rejected so replay never silently authorizes new bytes.
 */
export function getNativeToolInputs(db: Database, sessionId: string): Map<string, string> {
    return getNativeReplayState(db, sessionId).toolInputs;
}

/**
 * Atomically merge frozen native tool inputs. A supplied call id deliberately
 * replaces its prior serialized input on an authorized cache-busting pass;
 * values for every other call id remain intact.
 */
export function saveNativeToolInputs(
    db: Database,
    sessionId: string,
    inputs: ReadonlyMap<string, string>,
): void {
    const requested = new Map<string, string>();
    for (const [id, input] of inputs) {
        assertNonEmptyId(id, NATIVE_TOOL_INPUTS, sessionId);
        assertSerializedToolInput(input, sessionId);
        requested.set(id, input);
    }
    if (requested.size === 0) return;

    nativeWriteBarriers.get(db)?.get(sessionId)?.();
    const persisted = updateReplayDocument(db, sessionId, (doc) => {
        const current = parseNativeReplayState(doc, sessionId);
        let changed = false;
        for (const [id, input] of requested) {
            if (current.toolInputs.get(id) === input) continue;
            current.toolInputs.set(id, input);
            changed = true;
        }
        if (!changed) return false;
        replaceNativeReplayState(doc, current, sessionId);
        return true;
    });
    if (!persisted) {
        throw new Error(`failed to persist native replay state for session ${sessionId}`);
    }
}

/**
 * Return assistant entries whose native reasoning was cleared. Missing legacy
 * state is empty; malformed stored native state fails closed.
 */
export function getNativeReasoningIds(db: Database, sessionId: string): Set<string> {
    return getNativeReplayState(db, sessionId).reasoningIds;
}

/** Atomically union newly cleared native-reasoning entry ids into the replay set. */
export function addNativeReasoningIds(
    db: Database,
    sessionId: string,
    ids: Iterable<string>,
): void {
    const requested = new Set<string>();
    for (const id of ids) {
        assertNonEmptyId(id, NATIVE_REASONING_IDS, sessionId);
        requested.add(id);
    }
    if (requested.size === 0) return;

    nativeWriteBarriers.get(db)?.get(sessionId)?.();
    const persisted = updateReplayDocument(db, sessionId, (doc) => {
        const current = parseNativeReplayState(doc, sessionId);
        let changed = false;
        for (const id of requested) {
            if (current.reasoningIds.has(id)) continue;
            current.reasoningIds.add(id);
            changed = true;
        }
        if (!changed) return false;
        replaceNativeReplayState(doc, current, sessionId);
        return true;
    });
    if (!persisted) {
        throw new Error(`failed to persist native replay state for session ${sessionId}`);
    }
}
