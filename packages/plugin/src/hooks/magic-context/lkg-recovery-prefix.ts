import {
    readReplayEnvelope,
    updateReplayDocument,
} from "../../features/magic-context/storage-replay-document";
import { BoundedSessionMap } from "../../shared/bounded-session-map";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import { loadPersistedLkgSlot } from "./lkg-persist";
import {
    clearLkgFenceProcessState,
    lkgFenceRequiresRebuild,
    lkgRecoveryFenceUnclean,
    ownsLkgDirtyFence,
} from "./lkg-recovery-fence";
import { type LkgEntryProjection, resolveLkgModelKeys } from "./lkg-replay";
import { getSlot, type LkgEntryNote, lkgContentDigest, lkgInputIdentity } from "./lkg-slot";
import type { MessageLike } from "./transform-operations";

interface RecoveryPrefix {
    inputs: { id: string; digest: string }[];
    json: string;
    untaggedInputIds: ReadonlySet<string>;
    modelKey: string | null;
    providerKey: string | null;
}

// If the in-memory served-output record is lost, the stored last-good request
// may predate raw messages sent while SQLite's writer was unavailable. Refuse
// recovery until a successful transform explicitly rebuilds the request;
// those older stored bytes cannot prove what the provider has cached.
const sessions = new BoundedSessionMap<{
    prefix?: RecoveryPrefix;
    fenceRevision?: string;
    uncertifiedNormal?: boolean;
}>(1000);
export function noteUncertifiedNormalLkg(sessionId: string, revision: string | undefined): void {
    sessions.set(sessionId, {
        ...sessions.get(sessionId),
        fenceRevision: revision,
        uncertifiedNormal: true,
    });
}

export function hasProcessLocalLkgProof(sessionId: string): boolean {
    return sessions.has(sessionId) && !sessions.get(sessionId)?.uncertifiedNormal;
}
export function lkgDirtyRevision(sessionId: string): string | undefined {
    return sessions.get(sessionId)?.fenceRevision;
}
export function rememberLkgDirtyRevision(sessionId: string, revision: string): void {
    sessions.set(sessionId, { ...sessions.get(sessionId), fenceRevision: revision });
}

export function clearLkgRecoveryPrefixes(): void {
    sessions.clear();
    clearLkgFenceProcessState();
}

export function clearLkgRecoverySession(sessionId: string): void {
    sessions.delete(sessionId);
    clearLkgFenceProcessState(sessionId);
}

export function noteLkgCapturedPrefix(sessionId: string): void {
    if (!sessions.has(sessionId)) sessions.set(sessionId, {});
}

/**
 * The host messages a last-good replay served without tags, kept in the
 * session's replay document (`lkgUntaggedInputIds`) so a restart keeps serving
 * them untagged. The in-memory recovery prefix holds the same set, but it dies
 * with the process; without this record the first pass after a restart would
 * tag those messages, a change in front of every signed thinking block served
 * after the replay, even on a pass that must not change served bytes.
 */
export function readPersistedLkgUntaggedInputIds(db: Database, sessionId: string): string[] {
    try {
        const saved = readReplayEnvelope(db, sessionId, "read").lkgUntaggedInputIds;
        return Array.isArray(saved)
            ? saved.filter((id): id is string => typeof id === "string" && id.length > 0)
            : [];
    } catch (error) {
        sessionLog(sessionId, "LKG untagged-input record unreadable:", error);
        return [];
    }
}

/** Replace the record (an empty set removes it). Returns false when it could not be written. */
export function persistLkgUntaggedInputIds(
    db: Database,
    sessionId: string,
    ids: Iterable<string>,
): boolean {
    const next = [...new Set(ids)].sort();
    try {
        return updateReplayDocument(db, sessionId, (doc) => {
            const saved = Array.isArray(doc.lkgUntaggedInputIds) ? doc.lkgUntaggedInputIds : [];
            if (JSON.stringify(saved) === JSON.stringify(next)) return false;
            doc.version = 2;
            if (next.length > 0) doc.lkgUntaggedInputIds = next;
            else delete doc.lkgUntaggedInputIds;
            return true;
        });
    } catch (error) {
        sessionLog(sessionId, "LKG untagged-input record write failed:", error);
        return false;
    }
}

export function noteLkgRecoveryPrefix(args: {
    sessionId: string;
    entry: LkgEntryNote;
    messages: MessageLike[];
    modelKey: string | null;
    providerKey: string | null;
    /** Also record the untagged messages durably (best effort; the next pass retries). */
    db?: Database;
}): boolean {
    const digests = [
        ...args.entry.entryContentDigests,
        ...args.entry.pristineTail.map(lkgContentDigest),
    ];
    if (digests.length !== args.entry.entryInputIds.length || digests.some((value) => !value))
        return false;
    const ids = args.entry.entryInputIds;
    if (ids.some((id) => !id) || new Set(ids).size !== ids.length) return false;
    const untaggedInputIds = new Set([
        ...(sessions.get(args.sessionId)?.prefix?.untaggedInputIds ?? []),
        ...(args.db ? readPersistedLkgUntaggedInputIds(args.db, args.sessionId) : []),
        ...ids.slice(args.entry.anchorIndex + 1),
    ]);
    sessions.set(args.sessionId, {
        fenceRevision: sessions.get(args.sessionId)?.fenceRevision,
        prefix: {
            inputs: ids.map((id, index) => ({ id, digest: digests[index] as string })),
            json: JSON.stringify(args.messages),
            untaggedInputIds,
            modelKey: args.modelKey,
            providerKey: args.providerKey,
        },
    });
    // A replay often follows a busy database, so this write may fail; the next
    // pass that serves the replayed messages untagged writes it before it returns.
    if (args.db) persistLkgUntaggedInputIds(args.db, args.sessionId, untaggedInputIds);
    return true;
}

export function readLkgRecoveryPrefix(
    sessionId: string,
    inputs: (Pick<LkgEntryProjection, "id" | "contentDigest"> & { role?: string })[],
    messages: MessageLike[],
    db?: Database,
): { prefix?: RecoveryPrefix; rebuildReason?: string } {
    return readRecoveryIdentityPrefix(
        sessionId,
        inputs.map((input, index) => ({
            id: lkgInputIdentity(input.id, input.role, index),
            contentDigest: input.contentDigest,
        })),
        messages,
        db,
    );
}

function readRecoveryIdentityPrefix(
    sessionId: string,
    inputs: Pick<LkgEntryProjection, "id" | "contentDigest">[],
    messages: MessageLike[],
    db?: Database,
): { prefix?: RecoveryPrefix; rebuildReason?: string } {
    const state = sessions.get(sessionId);
    const slot =
        db && (!state || state.prefix || state.uncertifiedNormal)
            ? (loadPersistedLkgSlot(db, sessionId, true) ?? getSlot(sessionId))
            : getSlot(sessionId);
    const prefix = state?.prefix;
    if (!prefix && state?.uncertifiedNormal && ownsLkgDirtyFence(sessionId, state.fenceRevision))
        return {};
    if (!prefix)
        return (!state && lkgRecoveryFenceUnclean(sessionId)) ||
            (slot && lkgFenceRequiresRebuild(sessionId, slot, !!state))
            ? { rebuildReason: "lkg_restart_rebuild" }
            : {};
    const keys = resolveLkgModelKeys(messages);
    if (
        (state?.fenceRevision !== undefined &&
            (!slot || !ownsLkgDirtyFence(sessionId, state.fenceRevision))) ||
        prefix.modelKey !== keys.modelKey ||
        prefix.providerKey !== keys.providerKey ||
        inputs.length < prefix.inputs.length ||
        prefix.inputs.some(
            (input, index) =>
                input.id !== inputs[index]?.id || input.digest !== inputs[index]?.contentDigest?.(),
        )
    )
        return { rebuildReason: "lkg_recovery_input_rebuild" };
    return { prefix };
}

/** Extend the immutable provider-output record only after saving the successful transformed request. */
export function noteLkgHealthyPrefix(
    sessionId: string,
    inputs: LkgEntryProjection[],
    messages: MessageLike[],
    release: boolean,
): void {
    const prefix = sessions.get(sessionId)?.prefix;
    sessions.set(sessionId, {
        fenceRevision: sessions.get(sessionId)?.fenceRevision,
        prefix:
            prefix && !release
                ? {
                      ...prefix,
                      inputs: inputs.map((input, index) => ({
                          id: lkgInputIdentity(input.id, input.role, index) ?? "",
                          digest: input.contentDigest?.() ?? "",
                      })),
                      json: JSON.stringify(messages),
                  }
                : undefined,
    });
}

export function lkgRecoveryReplayUnproven(sessionId: string): boolean {
    const slot = getSlot(sessionId);
    return !!slot && !sessions.has(sessionId) && lkgFenceRequiresRebuild(sessionId, slot, false);
}

export function lkgRecoveryEntryUnproven(
    sessionId: string,
    entry: LkgEntryNote,
    messages: MessageLike[],
): boolean {
    if (!sessions.get(sessionId)?.prefix) return false;
    const digests = [...entry.entryContentDigests, ...entry.pristineTail.map(lkgContentDigest)];
    const inputs = entry.entryInputIds.map((id, index) => ({
        id,
        contentDigest: () => digests[index] ?? null,
    }));
    return !!readRecoveryIdentityPrefix(sessionId, inputs, messages).rebuildReason;
}
