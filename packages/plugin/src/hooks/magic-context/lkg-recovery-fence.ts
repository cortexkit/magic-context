import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { BoundedSessionMap } from "../../shared/bounded-session-map";
import { getMagicContextStorageDir } from "../../shared/data-path";
import { getHarness } from "../../shared/harness";
import { withStorageFileMutex } from "../../shared/storage-file-mutex";
import {
    syncStorageDirectorySync,
    writeStorageFileDurableAtomicSync,
} from "../../shared/storage-permissions";
import type { LkgSlot } from "./lkg-slot";

interface Fence {
    version: 1;
    sessionId: string;
    host: string;
    modelKey: string | null;
    providerKey: string | null;
    slotKey: string;
    servedDigest: string;
    revision: string;
    state: "clean" | "dirty";
    checksum: string;
}
export class LkgRecoveryFenceError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "LkgRecoveryFenceError";
    }
}
let platform: NodeJS.Platform = process.platform;
let observer: ((phase: "dirty" | "committed" | "temp-synced" | "clean") => void) | undefined;
// Mark dirty before returning replay recovery tails, untagged or raw content,
// failed snapshot preparation, Pi numbers-only publication, or Rust output that
// is uncommitted by design: a later healthy pass could otherwise change its bytes.
// Deliberately do not mark ordinary fully-tagged nonfatal-degraded TypeScript
// passes, including directory fallback and declined optional work. They retain
// base's deferred-save window, where restart may replay a valid earlier request.
type KnownFence = { state: "clean" | "dirty" | "invalid"; record: Fence | null };
const knownFences = new BoundedSessionMap<KnownFence>(1000);
let ioObserver: ((operation: "read" | "write" | "mutex") => void) | undefined;
const cacheKey = (sessionId: string) =>
    `${getMagicContextStorageDir()}\0${getHarness()}\0${sessionId}`;
function remember(sessionId: string, value: KnownFence): KnownFence {
    knownFences.set(cacheKey(sessionId), value);
    return value;
}
function known(sessionId: string): KnownFence {
    const prior = knownFences.get(cacheKey(sessionId));
    if (prior) return prior;
    const record = read(sessionId);
    if (record) return remember(sessionId, { state: record.state, record });
    try {
        lstatSync(lkgRecoveryFencePath(sessionId));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return remember(sessionId, { state: "clean", record: null });
    }
    return remember(sessionId, { state: "invalid", record: null });
}
export function clearLkgFenceProcessState(sessionId?: string): void {
    if (sessionId) knownFences.delete(cacheKey(sessionId));
    else knownFences.clear();
}

// Node has no proven Windows directory-fsync primitive. Never trust a restart
// certificate there: retain process-local BUSY replay, then refuse after restart
// until a healthy rebuild. No best-effort dirty or clean files are published.
const durableFencesSupported = () => platform !== "win32";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const lkgServedArrayDigest = hash;
export function lkgRecoveryFencePath(sessionId: string): string {
    return join(getMagicContextStorageDir(), "lkg-recovery-fences", `${hash(sessionId)}.json`);
}

function metadata(slot: LkgSlot) {
    return [
        slot.inputIdSeq,
        slot.inputContentDigests,
        slot.inputContentSignatures ?? null,
        slot.piOutputEntryIds ?? null,
        slot.lastInputMessageId,
        slot.modelKey,
        slot.providerKey,
    ];
}
function representationKey(slot: LkgSlot): string {
    return createHash("sha256")
        .update(slot.jsonPrefix)
        .update(JSON.stringify(metadata(slot)))
        .digest("hex");
}
export function lkgRecoverySlotKey(slot: LkgSlot): string {
    return hash(
        JSON.stringify([
            representationKey(slot),
            slot.capturedAt,
            slot.rowVersion ?? null,
            slot.captureSequence ?? null,
        ]),
    );
}
function payload(record: Omit<Fence, "checksum">) {
    return [
        record.version,
        record.sessionId,
        record.host,
        record.modelKey,
        record.providerKey,
        record.slotKey,
        record.servedDigest,
        record.revision,
        record.state,
    ];
}
function publishRecord(record: Omit<Fence, "checksum">): void {
    ioObserver?.("write");
    try {
        // Reject a failed clean notification while the durable dirty mark still exists.
        if (record.state === "clean") observer?.("clean");
        writeStorageFileDurableAtomicSync(
            lkgRecoveryFencePath(record.sessionId),
            JSON.stringify({ ...record, checksum: hash(JSON.stringify(payload(record))) }),
            () => observer?.("temp-synced"),
        );
        if (record.state === "dirty") observer?.("dirty");
        remember(record.sessionId, {
            state: record.state,
            record: { ...record, checksum: hash(JSON.stringify(payload(record))) },
        });
    } catch (error) {
        const visible = read(record.sessionId);
        if (
            record.state === "clean" &&
            visible?.state === "clean" &&
            visible.revision === record.revision &&
            visible.slotKey === record.slotKey
        ) {
            const dirty = { ...record, state: "dirty" as const };
            writeStorageFileDurableAtomicSync(
                lkgRecoveryFencePath(record.sessionId),
                JSON.stringify({ ...dirty, checksum: hash(JSON.stringify(payload(dirty))) }),
            );
        }
        remember(record.sessionId, { state: "invalid", record: null });
        throw error;
    }
}
function read(sessionId: string): Fence | null {
    ioObserver?.("read");
    try {
        const path = lkgRecoveryFencePath(sessionId);
        const stat = lstatSync(path);
        const directory = lstatSync(dirname(path));
        if (
            !stat.isFile() ||
            stat.size > 4096 ||
            !directory.isDirectory() ||
            directory.isSymbolicLink() ||
            (process.platform !== "win32" &&
                ((stat.mode & 0o077) !== 0 ||
                    (directory.mode & 0o077) !== 0 ||
                    (process.getuid && stat.uid !== process.getuid())))
        )
            return null;
        const value = JSON.parse(readFileSync(path, "utf8")) as Fence;
        if (
            value.version !== 1 ||
            value.sessionId !== sessionId ||
            value.host !== getHarness() ||
            (value.modelKey !== null && typeof value.modelKey !== "string") ||
            (value.providerKey !== null && typeof value.providerKey !== "string") ||
            !/^[a-f0-9]{64}$/.test(value.slotKey) ||
            !/^[a-f0-9]{64}$/.test(value.servedDigest) ||
            typeof value.revision !== "string" ||
            !["clean", "dirty"].includes(value.state) ||
            value.checksum !== hash(JSON.stringify(payload(value)))
        )
            return null;
        return value;
    } catch {
        return null;
    }
}
function publish(sessionId: string, slot: LkgSlot, state: Fence["state"], revision: string): void {
    const record: Omit<Fence, "checksum"> = {
        version: 1,
        sessionId,
        host: getHarness(),
        modelKey: slot.modelKey,
        providerKey: slot.providerKey,
        slotKey: lkgRecoverySlotKey(slot),
        servedDigest: hash(slot.jsonPrefix),
        revision,
        state,
    };
    publishRecord(record);
}
function locked<T>(sessionId: string, work: () => T): T {
    ioObserver?.("mutex");
    return withStorageFileMutex(`${lkgRecoveryFencePath(sessionId)}.locks`, () => {
        const path = lkgRecoveryFencePath(sessionId);
        for (const name of readdirSync(dirname(path))) {
            if (name.startsWith(`${basename(path)}.`) && name.endsWith(".tmp"))
                rmSync(join(dirname(path), name), { force: true });
        }
        return work();
    });
}

/** A missing file at startup means no recovery obligation was recorded. */
export function hasCleanLkgRecoveryFence(sessionId: string, _slot: LkgSlot): boolean {
    if (!durableFencesSupported()) return false;
    const state = known(sessionId);
    // A clean mark is not a generation or route certificate: later ordinary saves
    // may advance either without touching it. The slot's own replay rules validate
    // the current model and content; read() validates the file's host/session scope.
    return state.state === "clean";
}
export function lkgFenceRequiresRebuild(
    sessionId: string,
    slot: LkgSlot,
    processLocalProof: boolean,
): boolean {
    return (
        !processLocalProof &&
        (durableFencesSupported() ? !hasCleanLkgRecoveryFence(sessionId, slot) : true)
    );
}
/** A declined capture can leave a recovery obligation even when no LKG row exists. */
export function lkgRecoveryFenceUnclean(sessionId: string): boolean {
    return durableFencesSupported() && known(sessionId).state !== "clean";
}
export function dirtyLkgRecoveryRevision(sessionId: string, _slot: LkgSlot): string | undefined {
    if (!durableFencesSupported()) return undefined;
    const record = known(sessionId).record;
    return record?.state === "dirty" ? record.revision : undefined;
}
export function ownsLkgDirtyFence(sessionId: string, revision: string | undefined): boolean {
    if (!durableFencesSupported()) return revision === "process-local";
    const record = known(sessionId).record;
    return revision !== undefined && record?.state === "dirty" && record.revision === revision;
}

/** An uncaptured output must not leave an older request certified as current. */
export function invalidateCleanLkgRecoveryFence(
    sessionId: string,
    load: () => LkgSlot | undefined,
    ownRevision?: string,
): string | undefined {
    if (!durableFencesSupported()) return load() ? "process-local" : undefined;
    const prior = known(sessionId);
    if (prior.state === "dirty")
        return prior.record?.revision === ownRevision ? ownRevision : undefined;
    return locked(sessionId, () => {
        // write a dirty tombstone only when an LKG exists that it would supersede
        const slot = load();
        if (!slot) return undefined;
        const record = read(sessionId);
        if (record?.state !== "dirty") {
            const revision = randomUUID();
            publish(sessionId, slot, "dirty", revision);
            return revision;
        }
        return record?.state === "dirty" && record.revision === ownRevision
            ? ownRevision
            : undefined;
    });
}

/** Reserve an uncertified healthy output without needing the busy SQLite writer. */
export function prepareLkgCaptureFence(args: {
    sessionId: string;
    slot: LkgSlot;
    previousSlot?: LkgSlot;
    ownDirtyRevision?: string;
    rebuild?: boolean;
}): string {
    if (!durableFencesSupported()) return "process-local";
    return locked(args.sessionId, () => {
        const before = read(args.sessionId);
        const owns = before?.state === "dirty" && before.revision === args.ownDirtyRevision;
        const unchangedBytes =
            before?.state === "clean" && before.servedDigest === hash(args.slot.jsonPrefix);
        if (!args.rebuild && before && !owns && !unchangedBytes && before.state !== "clean")
            throw new LkgRecoveryFenceError(
                `A concurrent recovery requires a declared prefix rebuild (state=${before?.state}, owned=${owns}, previous=${!!args.previousSlot}, bytes=${unchangedBytes})`,
            );
        const revision = randomUUID();
        if (before) publishRecord({ ...before, state: "dirty", revision });
        else publish(args.sessionId, args.previousSlot ?? args.slot, "dirty", revision);
        return revision;
    });
}

/** Complete a previously committed capture only if no later publisher superseded it. */
export function certifyCommittedLkgCapture(args: {
    sessionId: string;
    slot: LkgSlot;
    revision: string;
    latestServedDigest: string;
    load: () => LkgSlot | undefined;
}): boolean {
    if (!durableFencesSupported()) return false;
    const state = known(args.sessionId);
    if (state.state !== "dirty" || state.record?.revision !== args.revision) return false;
    return locked(args.sessionId, () => {
        const before = read(args.sessionId);
        if (before?.state !== "dirty" || before.revision !== args.revision) return false;
        const saved = args.load();
        if (
            !saved ||
            representationKey(saved) !== representationKey(args.slot) ||
            hash(saved.jsonPrefix) !== args.latestServedDigest
        )
            return false;
        publish(args.sessionId, saved, "clean", args.revision);
        return true;
    });
}

/** Mark dirty before the caller can hand recovery bytes back to its host. */
export function markLkgRecoveryDirty(args: {
    sessionId: string;
    slot: LkgSlot;
    ownDirtyRevision?: string;
    processLocalProof: boolean;
}): string {
    if (!durableFencesSupported()) {
        if (!args.processLocalProof)
            throw new LkgRecoveryFenceError("Restart replay requires a healthy rebuild on Windows");
        return "process-local";
    }
    const state = known(args.sessionId);
    if (
        state.state === "dirty" &&
        args.processLocalProof &&
        state.record &&
        state.record.revision === args.ownDirtyRevision
    )
        return state.record.revision;
    if (state.state === "invalid")
        throw new LkgRecoveryFenceError("No clean durable recovery certificate");
    return locked(args.sessionId, () => {
        const slot = args.slot;
        const before = read(args.sessionId);
        if (before?.state === "dirty") {
            if (!args.processLocalProof || before.revision !== args.ownDirtyRevision)
                throw new LkgRecoveryFenceError(
                    `Recovery superseded this process's last-good request (local=${args.processLocalProof}, owned=${before.revision === args.ownDirtyRevision})`,
                );
            return before.revision;
        }
        if (before && before.state !== "clean")
            throw new LkgRecoveryFenceError("No clean durable recovery certificate");
        const revision = randomUUID();
        publish(args.sessionId, slot, "dirty", revision);
        return revision;
    });
}

/** Publish clean only after this process observed dirty and saved the matching last-good output. */
export function commitLkgWithRecoveryFence(args: {
    sessionId: string;
    slot: LkgSlot;
    load: () => LkgSlot | undefined;
    commit: () => boolean;
    rebuild?: boolean;
    retainDirtyRevision?: string;
    ownDirtyRevision?: string;
    requiredRevision?: string;
    cleanDigest?: string;
}): boolean {
    if (!durableFencesSupported()) return args.commit();
    const state = known(args.sessionId);
    // Once this process knows its fence is clean, it does not read or clear
    // another process's dirty mark. The fence does not guarantee byte stability
    // when two processes serve the same session concurrently. Deferred publishers
    // still compare revisions and saved generations before publishing clean.
    // Ordinary TypeScript saves retain their pre-existing setImmediate timing.
    // If the process crashes before that save, a clean fence can remain alongside
    // a valid earlier last-good request. The fence does not prevent that ordinary
    // healthy-pass crash window; recovery writes dirty before returning any tail.
    if (state.state === "clean" && !args.requiredRevision && !args.retainDirtyRevision) {
        const committed = args.commit();
        if (committed) {
            observer?.("committed");
            remember(args.sessionId, { state: "clean", record: null });
        }
        return committed;
    }
    if (state.state === "invalid" && !args.rebuild)
        throw new LkgRecoveryFenceError("Unproven prior request requires a prefix rebuild");
    return locked(args.sessionId, () => {
        const before = read(args.sessionId);
        if (args.requiredRevision && before?.revision !== args.requiredRevision)
            throw new LkgRecoveryFenceError("A later publisher superseded the rollback snapshot");
        const ownsDirty =
            before?.state === "dirty" &&
            (before.revision === args.retainDirtyRevision ||
                before.revision === args.ownDirtyRevision);
        if (before?.state === "dirty" && !ownsDirty && !args.rebuild)
            throw new LkgRecoveryFenceError(
                "A concurrent recovery requires a declared prefix rebuild",
            );
        if (before?.state !== "dirty" && state.state === "invalid")
            publish(args.sessionId, args.load() ?? args.slot, "dirty", randomUUID());
        if (!args.commit()) return false;
        observer?.("committed");
        const saved = args.load();
        if (!saved || representationKey(saved) !== representationKey(args.slot))
            throw new LkgRecoveryFenceError("Last-good commit did not match its certificate");
        if (
            args.retainDirtyRevision ||
            (args.cleanDigest !== undefined && hash(saved.jsonPrefix) !== args.cleanDigest)
        )
            return true;
        // Only a process which knew dirty before the commit may remove that
        // obligation. Re-read under the mutex to fence superseded deferred work.
        const dirty = read(args.sessionId);
        if (dirty?.state === "dirty") publish(args.sessionId, saved, "clean", dirty.revision);
        else remember(args.sessionId, { state: "clean", record: null });
        return true;
    });
}

export function clearLkgRecoveryFence<T = void>(
    sessionId: string,
    remove?: () => T,
    shouldClear?: (value: T | undefined) => boolean,
): T | undefined {
    if (!durableFencesSupported()) return remove?.();
    const path = lkgRecoveryFencePath(sessionId);
    const missing = (file: string): boolean => {
        try {
            lstatSync(file);
            return false;
        } catch (error) {
            return (error as NodeJS.ErrnoException).code === "ENOENT";
        }
    };
    if (!remove && !shouldClear && missing(path) && missing(`${path}.locks`)) {
        clearLkgFenceProcessState(sessionId);
        return undefined;
    }
    try {
        return locked(sessionId, () => {
            const result = remove?.();
            if (shouldClear && !shouldClear(result)) return result;
            rmSync(lkgRecoveryFencePath(sessionId), { force: true });
            syncStorageDirectorySync(dirname(lkgRecoveryFencePath(sessionId)));
            clearLkgFenceProcessState(sessionId);
            return result;
        });
    } finally {
        try {
            rmdirSync(`${path}.locks`);
        } catch {
            /* A live contender's ticket must never be removed. */
        }
    }
}
export const __test = {
    setPlatform(value: NodeJS.Platform) {
        const prior = platform;
        platform = value;
        return () => {
            platform = prior;
        };
    },
    setObserver(value: typeof observer) {
        observer = value;
        return () => {
            observer = undefined;
        };
    },
    setIoObserver(value: typeof ioObserver) {
        ioObserver = value;
        return () => {
            ioObserver = undefined;
        };
    },
};
