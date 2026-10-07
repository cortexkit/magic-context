import { createHash } from "node:crypto";

import { BoundedSessionMap } from "../../shared/bounded-session-map";
import { sessionLog } from "../../shared/logger";
import { clearCapturedLkgMeasurement } from "./lkg-measured-request";
import { ServedMarkerWriteError } from "./lkg-served-marker";
import type { MessageLike } from "./transform-operations";

export interface LkgSlot {
    jsonPrefix: string;
    /** Pi output ownership; null denotes a synthetic entry independent of raw-head trims. */
    piOutputEntryIds?: readonly (string | null)[];
    inputIdSeq: string[];
    inputContentDigests: string[];
    /** Cheap content signatures aligned with `inputIdSeq`, used to reuse digests. */
    inputContentSignatures?: string[];
    lastInputMessageId: string;
    modelKey: string | null;
    providerKey: string | null;
    capturedAt: number;
    rowVersion?: number;
    captureSequence?: number;
    /** Cross-process capture identity; unrelated to the adapter's cancel counter. */
    servedCaptureId?: number;
    /** RFC 8785 message digests for the portable hostCut frontier. */
    inputMoveDigests?: string[];
}

export interface LkgEntryNote {
    pristineTail: MessageLike[];
    entryInputIds: string[];
    entryContentDigests: string[];
    anchorIndex: number;
}

const LKG_TOTAL_BYTES = 64 * 1024 * 1024;
const LKG_SINGLE_SLOT_BYTES = 24 * 1024 * 1024;
const LKG_METADATA_BYTES = 256;

class MagicContextLkgHeapHolder {
    readonly entries = new Map<string, { slot: LkgSlot; bytes: number }>();
}

const lkgHeapHolder = new MagicContextLkgHeapHolder();
let totalBytes = 0;
const hydrationPassBySession = new BoundedSessionMap<number>(1_000);
const hydrationAttemptBySession = new BoundedSessionMap<number>(1_000);

/**
 * Optional durable backing for slots. Registered by the hook once its database
 * is open; drops clear the durable row and in-memory misses try to hydrate
 * from it, so an applied pass's snapshot survives a process restart. Capture
 * sites write the row themselves (they hold the db handle and must keep the
 * capture path's single-stringify discipline), so the backend only needs
 * load/clear.
 */
export interface LkgPersistenceBackend {
    load(sessionId: string): LkgSlot | undefined;
    clear(sessionId: string, reason?: string): void;
}

let persistenceBackend: LkgPersistenceBackend | undefined;

export function registerLkgPersistence(backend: LkgPersistenceBackend | undefined): void {
    persistenceBackend = backend;
    hydrationPassBySession.clear();
    hydrationAttemptBySession.clear();
}

/** Start a transform pass; a durable miss may be retried only after this event. */
export function beginLkgPass(sessionId: string): void {
    const next = (hydrationPassBySession.peek(sessionId) ?? 0) + 1;
    hydrationPassBySession.set(sessionId, next);
}

function slotBytes(slot: LkgSlot): number {
    const digestBytes = slot.inputContentDigests.reduce(
        (total, digest) => total + 2 * digest.length,
        0,
    );
    const ownershipBytes =
        slot.piOutputEntryIds?.reduce((total, id) => total + (id?.length ?? 0) * 2 + 8, 0) ?? 0;
    return 2 * slot.jsonPrefix.length + digestBytes + ownershipBytes + LKG_METADATA_BYTES;
}

export type LkgContentField = string | number | boolean | symbol;

export const LKG_SNAPSHOT_ARRAY = Symbol("array");
export const LKG_SNAPSHOT_OBJECT = Symbol("object");
export const LKG_SNAPSHOT_KEY = Symbol("key");
export const LKG_SNAPSHOT_STRING = Symbol("string");
export const LKG_SNAPSHOT_NUMBER = Symbol("number");
export const LKG_SNAPSHOT_BOOLEAN = Symbol("boolean");
export const LKG_SNAPSHOT_NULL = Symbol("null");
export const LKG_SNAPSHOT_UNDEFINED = Symbol("undefined");

export interface MessageContentSnapshot {
    signature: string;
    fields: LkgContentField[];
}

const FNV1A_32_OFFSET = 0x811c9dc5;
const FNV1A_32_PRIME = 0x01000193;

function updateFnv1a32(hash: number, value: string): number {
    let next = hash;
    for (let index = 0; index < value.length; index += 1) {
        next ^= value.charCodeAt(index);
        next = Math.imul(next, FNV1A_32_PRIME) >>> 0;
    }
    return next;
}

interface MessageContentFieldVisitor {
    field(value: LkgContentField): boolean;
    beginObject(): number | undefined;
    endObject(token: number, entryCount: number): boolean;
}

function isSnapshotObjectChild(value: unknown): boolean {
    return value !== undefined && typeof value !== "function" && typeof value !== "symbol";
}

export function visitMessageContentFields(
    value: unknown,
    visitor: MessageContentFieldVisitor,
): boolean {
    if (value === null) return visitor.field(LKG_SNAPSHOT_NULL);
    if (typeof value === "string") {
        return visitor.field(LKG_SNAPSHOT_STRING) && visitor.field(value);
    }
    if (typeof value === "number") {
        return visitor.field(LKG_SNAPSHOT_NUMBER) && visitor.field(value);
    }
    if (typeof value === "boolean") {
        return visitor.field(LKG_SNAPSHOT_BOOLEAN) && visitor.field(value);
    }
    if (value === undefined || typeof value === "function" || typeof value === "symbol") {
        return visitor.field(LKG_SNAPSHOT_UNDEFINED);
    }
    if (Array.isArray(value)) {
        if (!visitor.field(LKG_SNAPSHOT_ARRAY) || !visitor.field(value.length)) return false;
        for (const item of value) {
            if (!visitMessageContentFields(item, visitor)) return false;
        }
        return true;
    }
    if (typeof value === "object") {
        if (!visitor.field(LKG_SNAPSHOT_OBJECT)) return false;
        const objectToken = visitor.beginObject();
        if (objectToken === undefined) return false;
        let entryCount = 0;
        for (const key in value) {
            if (!Object.hasOwn(value, key)) continue;
            const child = (value as Record<string, unknown>)[key];
            if (!isSnapshotObjectChild(child)) continue;
            entryCount += 1;
            if (
                !visitor.field(LKG_SNAPSHOT_KEY) ||
                !visitor.field(key) ||
                !visitMessageContentFields(child, visitor)
            ) {
                return false;
            }
        }
        return visitor.endObject(objectToken, entryCount);
    }
    return visitor.field(LKG_SNAPSHOT_UNDEFINED);
}

export function contentSnapshotValue(value: unknown): unknown {
    if (!value || typeof value !== "object") return value;
    const message = value as Partial<MessageLike>;
    const info = message.info as Record<string, unknown> | undefined;
    const summary = info?.summary;
    // OpenCode may attach an empty diff summary to an already-served user message.
    // It does not change provider content. Preserve every nonempty or extended
    // summary so a substantive change still invalidates the captured prefix.
    if (
        !Array.isArray(message.parts) ||
        info?.role !== "user" ||
        summary === null ||
        typeof summary !== "object" ||
        Array.isArray(summary) ||
        Object.keys(summary).length !== 1 ||
        !Array.isArray((summary as { diffs?: unknown }).diffs) ||
        (summary as { diffs: unknown[] }).diffs.length !== 0
    )
        return value;
    return {
        ...message,
        info: Object.fromEntries(Object.entries(info).filter(([key]) => key !== "summary")),
    };
}

export function messageContentFields(message: MessageLike): LkgContentField[] {
    const fields: LkgContentField[] = [];
    const complete = visitMessageContentFields(contentSnapshotValue(message), {
        field(value) {
            fields.push(value);
            return true;
        },
        beginObject() {
            const countIndex = fields.length;
            fields.push(0);
            return countIndex;
        },
        endObject(countIndex, entryCount) {
            fields[countIndex] = entryCount;
            return true;
        },
    });
    if (!complete) throw new Error("message content snapshot traversal stopped unexpectedly");
    return fields;
}

export function signatureForFields(fields: readonly LkgContentField[]): string {
    let hash = FNV1A_32_OFFSET;
    for (const field of fields) {
        const value = typeof field === "symbol" ? (field.description ?? "") : String(field);
        hash = updateFnv1a32(hash, `${typeof field}:${value.length}:`);
        hash = updateFnv1a32(hash, value);
        hash = updateFnv1a32(hash, "\0");
    }
    return hash.toString(16).padStart(8, "0");
}

/** Capture an exact field snapshot plus its compact content-sensitive rolling hash. */
export function messageContentSnapshot(message: MessageLike): MessageContentSnapshot {
    const fields = messageContentFields(message);
    return { signature: signatureForFields(fields), fields };
}

/** Flatten a value into typed tokens while retaining strings without deep copies. */
export function lkgContentFields(value: unknown): LkgContentField[] | null {
    const fields: LkgContentField[] = [];
    const seen = new WeakSet<object>();
    const visit = (child: unknown): void => {
        if (child === null) fields.push(LKG_SNAPSHOT_NULL);
        else if (typeof child === "string") fields.push(LKG_SNAPSHOT_STRING, child);
        else if (typeof child === "number") fields.push(LKG_SNAPSHOT_NUMBER, child);
        else if (typeof child === "boolean") fields.push(LKG_SNAPSHOT_BOOLEAN, child);
        else if (child === undefined || typeof child === "function" || typeof child === "symbol") {
            fields.push(LKG_SNAPSHOT_UNDEFINED);
        } else if (Array.isArray(child)) {
            if (seen.has(child)) throw new Error("cyclic message");
            seen.add(child);
            fields.push(LKG_SNAPSHOT_ARRAY, child.length);
            for (const item of child) visit(item);
            seen.delete(child);
        } else if (typeof child === "object") {
            if (seen.has(child)) throw new Error("cyclic message");
            seen.add(child);
            const entries = Object.entries(child).filter(
                ([, entry]) =>
                    entry !== undefined && typeof entry !== "function" && typeof entry !== "symbol",
            );
            fields.push(LKG_SNAPSHOT_OBJECT, entries.length);
            for (const [key, entry] of entries) {
                fields.push(LKG_SNAPSHOT_KEY, key);
                visit(entry);
            }
            seen.delete(child);
        } else fields.push(LKG_SNAPSHOT_UNDEFINED);
    };
    try {
        visit(contentSnapshotValue(value));
        return fields;
    } catch {
        return null;
    }
}

export function lkgContentDigestFromFields(fields: readonly LkgContentField[]): string {
    const hash = createHash("sha256");
    for (const field of fields) {
        const value = typeof field === "symbol" ? (field.description ?? "") : String(field);
        hash.update(`${typeof field}:${value.length}:`)
            .update(value)
            .update("\0");
    }
    return hash.digest("base64url");
}

export interface LkgInputSnapshot {
    id: string;
    fields: readonly LkgContentField[];
}

const digestMemo = new Map<
    string,
    { fields: readonly LkgContentField[]; digest: string; bytes: number }
>();
const DIGEST_MEMO_MAX_BYTES = 16 * 1024 * 1024;
let digestMemoBytes = 0;

/** Share pristine digests across entry capture and projection after exact typed-field comparison. */
export function memoizedLkgContentDigestFromFields(
    id: string,
    fields: readonly LkgContentField[],
): string {
    const prior = digestMemo.get(id);
    if (prior && equalContentFields(fields, prior.fields)) {
        digestMemo.delete(id);
        digestMemo.set(id, prior);
        return prior.digest;
    }
    const digest = lkgContentDigestFromFields(fields);
    if (prior) {
        digestMemo.delete(id);
        digestMemoBytes -= prior.bytes;
    }
    const bytes =
        128 +
        id.length * 2 +
        fields.reduce<number>(
            (sum, field) => sum + 16 + (typeof field === "string" ? field.length * 2 : 0),
            0,
        );
    if (bytes <= DIGEST_MEMO_MAX_BYTES) {
        while (digestMemoBytes + bytes > DIGEST_MEMO_MAX_BYTES || digestMemo.size >= 20_000) {
            const oldest = digestMemo.entries().next().value;
            if (!oldest) break;
            digestMemo.delete(oldest[0]);
            digestMemoBytes -= oldest[1].bytes;
        }
        digestMemo.set(id, { fields: [...fields], digest, bytes });
        digestMemoBytes += bytes;
    }
    return digest;
}

function equalContentFields(
    left: readonly LkgContentField[],
    right: readonly LkgContentField[],
): boolean {
    // OpenCode retains immutable token arrays for the unchanged prefix of a tail-only
    // request. Reusing the same array needs no element-by-element comparison.
    if (left === right) return true;
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
        if (!Object.is(left[index], right[index])) return false;
    }
    return true;
}

/** Compare captured tokens before reusing digests: a message can change without changing its id. */
export function exactReusablePrefix(
    current: readonly LkgInputSnapshot[],
    prior: readonly LkgInputSnapshot[] | null,
): number {
    if (!prior) return 0;
    let prefix = 0;
    while (
        prefix < current.length &&
        prefix < prior.length &&
        current[prefix]?.id === prior[prefix]?.id &&
        equalContentFields(current[prefix]?.fields ?? [], prior[prefix]?.fields ?? [])
    ) {
        prefix += 1;
    }
    return prefix;
}

export interface LkgDigestEntry {
    id: string;
    signature: string;
    fields: readonly LkgContentField[];
}

export interface LkgDigestPrior {
    ids: readonly string[];
    signatures: readonly string[];
    digests: readonly string[];
}

/**
 * Reuse prior digests for the unchanged id+signature prefix and hash only from
 * the first changed entry. Digest values must match a full recompute.
 */
export function incrementalLkgContentDigests(
    entries: readonly LkgDigestEntry[],
    prior?: LkgDigestPrior,
): { digests: string[]; reusedPrefix: number } {
    const aligned =
        prior !== undefined &&
        prior.ids.length === prior.signatures.length &&
        prior.signatures.length === prior.digests.length;
    let reusedPrefix = 0;
    if (aligned && prior) {
        while (
            reusedPrefix < entries.length &&
            reusedPrefix < prior.ids.length &&
            entries[reusedPrefix]?.id === prior.ids[reusedPrefix] &&
            entries[reusedPrefix]?.signature === prior.signatures[reusedPrefix]
        ) {
            reusedPrefix += 1;
        }
    }
    const digests: string[] = [];
    if (aligned && prior) {
        for (let index = 0; index < reusedPrefix; index += 1) {
            digests.push(prior.digests[index] as string);
        }
    }
    for (let index = reusedPrefix; index < entries.length; index += 1) {
        digests.push(lkgContentDigestFromFields(entries[index]?.fields ?? []));
    }
    return { digests, reusedPrefix };
}

/** Digest the full message tree to detect input drift before an LKG replay. */
export function lkgContentDigest(message: MessageLike): string | null {
    const fields = lkgContentFields(message);
    return fields ? lkgContentDigestFromFields(fields) : null;
}

function touch(sessionId: string, entry: { slot: LkgSlot; bytes: number }): void {
    lkgHeapHolder.entries.delete(sessionId);
    lkgHeapHolder.entries.set(sessionId, entry);
}

/**
 * Why {@link captureSlot} would refuse `slot` for `sessionId`, or null when it would
 * take it (subject only to the total heap budget). Kept next to the checks it names so
 * a refusal can say which one fired.
 */
export function lkgSlotRejection(sessionId: string, slot: LkgSlot): string | null {
    if (slot.inputContentDigests.length !== slot.inputIdSeq.length)
        return `digest_count=${slot.inputContentDigests.length} inputs=${slot.inputIdSeq.length}`;
    const emptyDigest = slot.inputContentDigests.findIndex((digest) => digest.length === 0);
    if (emptyDigest >= 0) return `empty_digest_at=${emptyDigest}`;
    if (slot.inputContentSignatures !== undefined) {
        if (slot.inputContentSignatures.length !== slot.inputIdSeq.length)
            return `signature_count=${slot.inputContentSignatures.length} inputs=${slot.inputIdSeq.length}`;
        const emptySignature = slot.inputContentSignatures.findIndex(
            (signature) => signature.length === 0,
        );
        if (emptySignature >= 0) return `empty_signature_at=${emptySignature}`;
    }
    const bytes = slotBytes(slot);
    if (bytes > LKG_SINGLE_SLOT_BYTES) return `slot_bytes=${bytes}`;
    const prior = lkgHeapHolder.entries.get(sessionId);
    if (
        prior?.slot.rowVersion !== undefined &&
        slot.rowVersion !== undefined &&
        (slot.rowVersion < prior.slot.rowVersion ||
            (slot.rowVersion === prior.slot.rowVersion &&
                (slot.captureSequence ?? 0) < (prior.slot.captureSequence ?? 0)))
    ) {
        return `stale row_version=${slot.rowVersion}/${prior.slot.rowVersion} capture_sequence=${slot.captureSequence ?? 0}/${prior.slot.captureSequence ?? 0}`;
    }
    return null;
}

export function captureSlot(sessionId: string, slot: LkgSlot): boolean {
    if (lkgSlotRejection(sessionId, slot) !== null) return false;
    const bytes = slotBytes(slot);
    const prior = lkgHeapHolder.entries.get(sessionId);
    if (prior) totalBytes -= prior.bytes;
    lkgHeapHolder.entries.delete(sessionId);
    while (totalBytes + bytes > LKG_TOTAL_BYTES) {
        const oldest = lkgHeapHolder.entries.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        const evicted = lkgHeapHolder.entries.get(oldest);
        lkgHeapHolder.entries.delete(oldest);
        if (evicted) totalBytes -= evicted.bytes;
    }
    if (totalBytes + bytes > LKG_TOTAL_BYTES) {
        if (prior) {
            lkgHeapHolder.entries.set(sessionId, prior);
            totalBytes += prior.bytes;
        }
        return false;
    }
    const entry = {
        slot: {
            ...slot,
            ...(slot.piOutputEntryIds ? { piOutputEntryIds: [...slot.piOutputEntryIds] } : {}),
            inputIdSeq: [...slot.inputIdSeq],
            inputContentDigests: [...slot.inputContentDigests],
            inputMoveDigests: slot.inputMoveDigests ? [...slot.inputMoveDigests] : undefined,
            inputContentSignatures: slot.inputContentSignatures
                ? [...slot.inputContentSignatures]
                : undefined,
        },
        bytes,
    };
    lkgHeapHolder.entries.set(sessionId, entry);
    totalBytes += bytes;
    hydrationAttemptBySession.delete(sessionId);
    return true;
}

/** Install a slot loaded from durable storage, applying the same size bounds. */
function installHydratedSlot(sessionId: string, slot: LkgSlot): boolean {
    const bytes = slotBytes(slot);
    if (bytes > LKG_SINGLE_SLOT_BYTES) return false;
    const prior = lkgHeapHolder.entries.get(sessionId);
    if (prior) totalBytes -= prior.bytes;
    lkgHeapHolder.entries.delete(sessionId);
    while (totalBytes + bytes > LKG_TOTAL_BYTES) {
        const oldest = lkgHeapHolder.entries.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        const evicted = lkgHeapHolder.entries.get(oldest);
        lkgHeapHolder.entries.delete(oldest);
        if (evicted) totalBytes -= evicted.bytes;
    }
    if (totalBytes + bytes > LKG_TOTAL_BYTES) {
        if (prior) {
            lkgHeapHolder.entries.set(sessionId, prior);
            totalBytes += prior.bytes;
        }
        return false;
    }
    const entry = {
        slot: {
            ...slot,
            ...(slot.piOutputEntryIds ? { piOutputEntryIds: [...slot.piOutputEntryIds] } : {}),
            inputIdSeq: [...slot.inputIdSeq],
            inputContentDigests: [...slot.inputContentDigests],
            inputMoveDigests: slot.inputMoveDigests ? [...slot.inputMoveDigests] : undefined,
            inputContentSignatures: slot.inputContentSignatures
                ? [...slot.inputContentSignatures]
                : undefined,
        },
        bytes,
    };
    lkgHeapHolder.entries.set(sessionId, entry);
    totalBytes += bytes;
    return true;
}

function hydrateSlotFromPersistence(sessionId: string): LkgSlot | undefined {
    const backend = persistenceBackend;
    if (!backend) return undefined;
    let loaded: LkgSlot | undefined;
    try {
        loaded = backend.load(sessionId);
    } catch (error) {
        sessionLog(sessionId, "LKG durable hydration failed:", error);
        return undefined;
    }
    if (!loaded) return undefined;
    // Hydration only restores the snapshot. Replay still runs every validity
    // fence a live process would apply, so stale durable bytes are rejected
    // exactly like stale in-memory bytes.
    if (!installHydratedSlot(sessionId, loaded)) return undefined;
    sessionLog(sessionId, "lkg_hydrated_from_disk");
    const entry = lkgHeapHolder.entries.get(sessionId);
    return entry ? copySlotForRead(entry.slot) : undefined;
}

function copySlotForRead(slot: LkgSlot): LkgSlot {
    return {
        ...slot,
        ...(slot.piOutputEntryIds ? { piOutputEntryIds: [...slot.piOutputEntryIds] } : {}),
        inputIdSeq: [...slot.inputIdSeq],
        inputContentDigests: [...slot.inputContentDigests],
        inputMoveDigests: slot.inputMoveDigests ? [...slot.inputMoveDigests] : undefined,
        inputContentSignatures: slot.inputContentSignatures
            ? [...slot.inputContentSignatures]
            : undefined,
    };
}

export function getInMemorySlot(sessionId: string): LkgSlot | undefined {
    const entry = lkgHeapHolder.entries.get(sessionId);
    return entry ? copySlotForRead(entry.slot) : undefined;
}

export function getSlot(sessionId: string): LkgSlot | undefined {
    const entry = lkgHeapHolder.entries.get(sessionId);
    if (!entry) {
        const pass = hydrationPassBySession.peek(sessionId);
        if (pass !== undefined) {
            if (hydrationAttemptBySession.peek(sessionId) === pass) return undefined;
            // Mark before loading so thrown/backing-store failures coalesce too.
            hydrationAttemptBySession.set(sessionId, pass);
        }
        return hydrateSlotFromPersistence(sessionId);
    }
    touch(sessionId, entry);
    return copySlotForRead(entry.slot);
}

/** Evict only the process copy; durable replay authority is unchanged. */
export function forgetInMemorySlot(sessionId: string): void {
    const entry = lkgHeapHolder.entries.get(sessionId);
    if (entry) {
        lkgHeapHolder.entries.delete(sessionId);
        totalBytes -= entry.bytes;
    }
}

export function dropSlot(sessionId: string, _reason?: string, certify = true): void {
    clearCapturedLkgMeasurement(sessionId);
    forgetInMemorySlot(sessionId);
    // The durable row must follow the drop: a slot invalidated in memory
    // (model change, reshape, recovery arm, deletion) is equally invalid after
    // a restart. Clear best-effort; a missed clear still meets the replay fences.
    const backend = persistenceBackend;
    if (!backend) return;
    try {
        backend.clear(sessionId, certify ? _reason : undefined);
    } catch (error) {
        if (error instanceof ServedMarkerWriteError) throw error;
        sessionLog(sessionId, "LKG durable clear failed:", error);
    }
    const pass = hydrationPassBySession.peek(sessionId);
    if (pass !== undefined) hydrationAttemptBySession.set(sessionId, pass);
}

export function noteEntry(sessionId: string, messages: MessageLike[]): LkgEntryNote | null {
    const slot = getSlot(sessionId);
    if (!slot) return null;
    const entryInputIds = messages.map((message) => {
        const id = (message.info as { id?: unknown } | undefined)?.id;
        return typeof id === "string" ? id : "";
    });
    const anchorIndex = entryInputIds.indexOf(slot.lastInputMessageId);
    if (anchorIndex < 0) return null;
    const entryContentDigests = messages.slice(0, anchorIndex + 1).map((message, index) => {
        const fields = lkgContentFields(message);
        return fields
            ? memoizedLkgContentDigestFromFields(entryInputIds[index] ?? "", fields)
            : null;
    });
    if (entryContentDigests.some((digest) => digest === null)) return null;
    const pristineTail = structuredClone(messages.slice(anchorIndex + 1)) as MessageLike[];
    return {
        pristineTail,
        entryInputIds,
        entryContentDigests: entryContentDigests as string[],
        anchorIndex,
    };
}

export function resetLkgSlotsForTest(): void {
    digestMemo.clear();
    digestMemoBytes = 0;
    lkgHeapHolder.entries.clear();
    totalBytes = 0;
    persistenceBackend = undefined;
    hydrationPassBySession.clear();
    hydrationAttemptBySession.clear();
}

export interface LkgSlotHeapStats {
    count: number;
    totalBytes: number;
    sessions: Array<{ sessionId: string; bytes: number }>;
}

/** Live process-resident LKG ownership used by the opt-in heap diagnostic RPC. */
export function getLkgSlotHeapStats(): LkgSlotHeapStats {
    return {
        count: lkgHeapHolder.entries.size,
        totalBytes,
        sessions: [...lkgHeapHolder.entries].map(([sessionId, entry]) => ({
            sessionId,
            bytes: entry.bytes,
        })),
    };
}

export function getLkgSlotStatsForTest(): { totalBytes: number; count: number } {
    const { totalBytes: bytes, count } = getLkgSlotHeapStats();
    return { totalBytes: bytes, count };
}

export const __resetLkgSlotStoreForTest = resetLkgSlotsForTest;
