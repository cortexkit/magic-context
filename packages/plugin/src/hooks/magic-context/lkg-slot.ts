import { createHash } from "node:crypto";

import { BoundedSessionMap } from "../../shared/bounded-session-map";
import { sessionLog } from "../../shared/logger";
import { clearCapturedLkgMeasurement } from "./lkg-measured-request";
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
    clear(sessionId: string): void;
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

/**
 * The exact text {@link lkgContentDigestFromFields} hashes: each token as
 * `<type>:<length>:<value>\0`. Type and length prefixes make it unambiguous, so
 * two token lists with the same key always have the same digest.
 */
export function lkgContentKey(fields: readonly LkgContentField[]): string {
    let key = "";
    for (const field of fields) {
        const value = typeof field === "symbol" ? (field.description ?? "") : String(field);
        key += `${typeof field}:${value.length}:${value}\0`;
    }
    return key;
}

/**
 * sha256 of {@link lkgContentKey}. Hashing the joined text in one update gives
 * the same bytes as the three updates per token this used to make: every token
 * value is bracketed by ASCII, so no surrogate pair can straddle a boundary.
 */
export function lkgContentDigestFromFields(fields: readonly LkgContentField[]): string {
    return lkgContentDigestFromKey(lkgContentKey(fields));
}

function lkgContentDigestFromKey(key: string): string {
    lkgDigestsComputed += 1;
    return createHash("sha256").update(key).digest("base64url");
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

export function dropSlot(sessionId: string, _reason?: string): void {
    clearCapturedLkgMeasurement(sessionId);
    forgetInMemorySlot(sessionId);
    // The durable row must follow the drop: a slot invalidated in memory
    // (model change, reshape, recovery arm, deletion) is equally invalid after
    // a restart. Clear best-effort; a missed clear still meets the replay fences.
    const backend = persistenceBackend;
    if (!backend) return;
    try {
        backend.clear(sessionId);
    } catch (error) {
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
    // Digest the whole input, not only the prefix the slot needs: the entry
    // projection later in this pass reads the same messages from the same
    // cache, and a cache stored with only the prefix would make it flatten and
    // hash every message after the anchor again.
    const digests = sharedLkgEntryDigests.digests(sessionId, messages).digests;
    const entryContentDigests: string[] = [];
    for (let index = 0; index <= anchorIndex; index += 1) {
        const digest = digests[index];
        if (digest === null || digest === undefined) return null;
        entryContentDigests.push(digest);
    }
    const pristineTail = structuredClone(messages.slice(anchorIndex + 1)) as MessageLike[];
    return {
        pristineTail,
        entryInputIds,
        entryContentDigests,
        anchorIndex,
    };
}

/**
 * Whether `value` flattens to exactly `fields`, the tokens
 * {@link lkgContentFields} produced for it earlier, so the earlier digest is
 * the one a recompute would give.
 *
 * Walks the value the way {@link lkgContentFields} does but builds nothing: an
 * unchanged message costs one visit per token and one string comparison per
 * string, and a string the host hands over again as the same object compares in
 * constant time. A cyclic value never matches, because the walk runs past the
 * end of the finite token list; that and any other failure fall back to
 * flattening, which reports the cycle.
 *
 * Strings that compare equal are written back into `fields`, so the cache holds
 * the newest pass's string objects: the previous pass's copies can be freed,
 * and a second walk over the same messages in the same pass compares them by
 * identity.
 */
function contentMatchesFields(value: unknown, fields: LkgContentField[]): boolean {
    let cursor = 0;
    const visit = (child: unknown): boolean => {
        if (child === null) return fields[cursor++] === LKG_SNAPSHOT_NULL;
        switch (typeof child) {
            case "string": {
                if (fields[cursor] !== LKG_SNAPSHOT_STRING) return false;
                const prior = fields[cursor + 1];
                if (typeof prior !== "string" || prior.length !== child.length) return false;
                if (prior !== child) return false;
                lkgEntryWork.comparedChars += child.length;
                fields[cursor + 1] = child;
                cursor += 2;
                return true;
            }
            case "number":
                if (fields[cursor] !== LKG_SNAPSHOT_NUMBER) return false;
                if (!Object.is(fields[cursor + 1], child)) return false;
                cursor += 2;
                return true;
            case "boolean":
                if (fields[cursor] !== LKG_SNAPSHOT_BOOLEAN || fields[cursor + 1] !== child) {
                    return false;
                }
                cursor += 2;
                return true;
            case "object": {
                if (Array.isArray(child)) {
                    if (fields[cursor] !== LKG_SNAPSHOT_ARRAY) return false;
                    if (fields[cursor + 1] !== child.length) return false;
                    cursor += 2;
                    for (const item of child) {
                        if (!visit(item)) return false;
                    }
                    return true;
                }
                if (fields[cursor] !== LKG_SNAPSHOT_OBJECT) return false;
                // The same entries, in the same order, that Object.entries gives
                // lkgContentFields: own enumerable string keys.
                const keys = Object.keys(child);
                let entryCount = 0;
                for (const key of keys) {
                    if (isSnapshotObjectChild((child as Record<string, unknown>)[key])) {
                        entryCount += 1;
                    }
                }
                if (fields[cursor + 1] !== entryCount) return false;
                cursor += 2;
                for (const key of keys) {
                    const entry = (child as Record<string, unknown>)[key];
                    if (!isSnapshotObjectChild(entry)) continue;
                    if (fields[cursor] !== LKG_SNAPSHOT_KEY || fields[cursor + 1] !== key) {
                        return false;
                    }
                    cursor += 2;
                    if (!visit(entry)) return false;
                }
                return true;
            }
            default:
                // undefined, function, symbol and bigint all flatten to this marker.
                return fields[cursor++] === LKG_SNAPSHOT_UNDEFINED;
        }
    };
    try {
        return visit(contentSnapshotValue(value)) && cursor === fields.length;
    } catch {
        return false;
    } finally {
        lkgEntryWork.comparedFields += Math.min(cursor, fields.length);
    }
}

/**
 * Work the entry digest cache did since the last reset, for tests and the
 * issue 653 benchmark: how many messages were flattened and hashed (and how many
 * string characters that covered), and how many tokens and string characters
 * were compared against retained tokens.
 */
export interface LkgEntryWork {
    flattenedMessages: number;
    flattenedChars: number;
    hashedMessages: number;
    comparedMessages: number;
    comparedFields: number;
    comparedChars: number;
}

const lkgEntryWork: LkgEntryWork = {
    flattenedMessages: 0,
    flattenedChars: 0,
    hashedMessages: 0,
    comparedMessages: 0,
    comparedFields: 0,
    comparedChars: 0,
};

/** @internal */
export function getLkgEntryWorkForTest(): LkgEntryWork {
    return { ...lkgEntryWork };
}

interface LkgEntryCacheEntry {
    /** Exact tokens of the pristine message; never handed out. */
    fields: LkgContentField[];
    digest: string;
    bytes: number;
}

interface LkgEntrySession {
    entries: Map<string, LkgEntryCacheEntry>;
    bytes: number;
}

export interface LkgEntryDigestStats {
    reused: number;
    retained: number;
    retainedBytes: number;
}

/** Estimated heap bytes one retained entry holds, counting strings at two bytes per character. */
function lkgEntryBytes(id: string, fields: readonly LkgContentField[]): number {
    let bytes = id.length * 2 + 166;
    for (const field of fields) {
        bytes += 16;
        if (typeof field === "string") bytes += field.length * 2;
    }
    return bytes;
}

/**
 * Per-message pristine digests for each session, reused from one pass to the
 * next.
 *
 * Each retained message keeps its exact typed tokens. A message reuses its
 * digest only when it has the same id as a retained entry and its content still
 * flattens to that entry's tokens, checked by {@link contentMatchesFields}
 * without building anything; neither the id nor the object alone is trusted.
 * Anything else is flattened and hashed. So an ordinary pass flattens and hashes
 * only new or changed messages, and compares the rest at memory speed.
 *
 * Retention is per session. A session keeps entries in message order up to
 * its share of the total budget (the total divided by the number of sessions
 * retained, never more than the per-session cap); when a session joins,
 * sessions above the new share are trimmed rather than dropped. Two large
 * sessions served alternately therefore both keep their entries, instead of
 * evicting each other on every pass, and the total never exceeds its ceiling.
 * Messages beyond a session's share are hashed on every pass.
 */
export class LkgEntryDigestCache {
    private readonly sessions = new Map<string, LkgEntrySession>();
    private totalBytes = 0;

    constructor(
        private readonly limits: {
            sessionMaxBytes: number;
            totalMaxBytes: number;
            maxSessions: number;
        },
    ) {}

    digests(
        sessionId: string,
        messages: readonly MessageLike[],
    ): { digests: (string | null)[]; stats: LkgEntryDigestStats } {
        const prior = this.sessions.get(sessionId);
        const sessionCount = this.sessions.size + (prior ? 0 : 1);
        const share = Math.min(
            this.limits.sessionMaxBytes,
            Math.floor(this.limits.totalMaxBytes / Math.min(sessionCount, this.limits.maxSessions)),
        );
        const retained = new Map<string, LkgEntryCacheEntry>();
        const digests: (string | null)[] = [];
        let reused = 0;
        let size = 0;
        for (const message of messages) {
            const rawId = message.info?.id;
            const id = typeof rawId === "string" ? rawId : "";
            let entry = prior?.entries.get(id);
            if (entry) lkgEntryWork.comparedMessages += 1;
            if (entry && contentMatchesFields(message, entry.fields)) {
                reused += 1;
            } else {
                entry = undefined;
                const fields = lkgContentFields(message);
                lkgEntryWork.flattenedMessages += 1;
                if (fields) {
                    for (const field of fields) {
                        if (typeof field === "string") lkgEntryWork.flattenedChars += field.length;
                    }
                    lkgEntryWork.hashedMessages += 1;
                    entry = {
                        fields,
                        digest: lkgContentDigestFromFields(fields),
                        bytes: lkgEntryBytes(id, fields),
                    };
                }
            }
            digests.push(entry?.digest ?? null);
            if (!entry || retained.has(id) || size + entry.bytes > share) continue;
            retained.set(id, entry);
            size += entry.bytes;
        }
        this.store(sessionId, retained, size, share);
        return { digests, stats: { reused, retained: retained.size, retainedBytes: size } };
    }

    private store(
        sessionId: string,
        entries: Map<string, LkgEntryCacheEntry>,
        bytes: number,
        share: number,
    ): void {
        const prior = this.sessions.get(sessionId);
        if (prior) {
            this.totalBytes -= prior.bytes;
            this.sessions.delete(sessionId);
        }
        if (entries.size === 0) return;
        while (this.sessions.size >= this.limits.maxSessions) {
            const oldest = this.sessions.entries().next().value;
            if (!oldest) break;
            this.totalBytes -= oldest[1].bytes;
            this.sessions.delete(oldest[0]);
        }
        // Sessions retained when there were fewer of them may hold more than
        // the share now; keep the leading entries that fit.
        for (const other of this.sessions.values()) {
            if (other.bytes <= share) continue;
            let kept = 0;
            for (const [id, entry] of other.entries) {
                if (kept + entry.bytes > share) other.entries.delete(id);
                else kept += entry.bytes;
            }
            this.totalBytes -= other.bytes - kept;
            other.bytes = kept;
        }
        while (this.totalBytes + bytes > this.limits.totalMaxBytes) {
            const oldest = this.sessions.entries().next().value;
            if (!oldest) break;
            this.totalBytes -= oldest[1].bytes;
            this.sessions.delete(oldest[0]);
        }
        this.sessions.set(sessionId, { entries, bytes });
        this.totalBytes += bytes;
    }

    /** Retained bytes per session and in total, for tests and diagnostics. */
    stats(): { totalBytes: number; sessions: Array<{ sessionId: string; bytes: number }> } {
        return {
            totalBytes: this.totalBytes,
            sessions: [...this.sessions].map(([sessionId, session]) => ({
                sessionId,
                bytes: session.bytes,
            })),
        };
    }

    clear(): void {
        this.sessions.clear();
        this.totalBytes = 0;
    }
}

/**
 * Ceiling for the cache {@link noteEntry} and the transform's entry projection
 * share. One session may use up to half of it, so two large sessions served
 * alternately both stay resident; a 64 MiB total used to make two sessions of
 * over 32 MiB evict each other on every pass.
 */
export const LKG_ENTRY_CACHE_TOTAL_BYTES = 256 * 1024 * 1024;
export const LKG_ENTRY_CACHE_SESSION_BYTES = 128 * 1024 * 1024;
const LKG_ENTRY_CACHE_MAX_SESSIONS = 16;

export const sharedLkgEntryDigests = new LkgEntryDigestCache({
    sessionMaxBytes: LKG_ENTRY_CACHE_SESSION_BYTES,
    totalMaxBytes: LKG_ENTRY_CACHE_TOTAL_BYTES,
    maxSessions: LKG_ENTRY_CACHE_MAX_SESSIONS,
});

let lkgDigestsComputed = 0;

/** @internal sha256 digests computed since the last reset. */
export function getLkgDigestsComputedForTest(): number {
    return lkgDigestsComputed;
}

export function resetLkgSlotsForTest(): void {
    digestMemo.clear();
    digestMemoBytes = 0;
    sharedLkgEntryDigests.clear();
    for (const key of Object.keys(lkgEntryWork) as Array<keyof LkgEntryWork>) {
        lkgEntryWork[key] = 0;
    }
    lkgDigestsComputed = 0;
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
