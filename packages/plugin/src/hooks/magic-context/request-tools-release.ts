import {
    classifyRequestToolsChange,
    type RequestToolsChange,
    type RequestToolsFingerprint,
} from "../../features/magic-context/request-tool-definitions";
import {
    readReplayEnvelope,
    updateReplayDocument,
} from "../../features/magic-context/storage-replay-document";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";

/**
 * The tool list a prefix-bound model's signed thinking was last served behind.
 *
 * Claude 5.1 and later models bind every signed thinking block to the system
 * prompt, the `tools` array and the messages before it, so a request whose
 * tools changed (a tool added, removed, renamed, or its description or input
 * schema edited) must not resend thinking served behind the old list. The
 * session's replay document keeps the fingerprint of the last tool list served
 * on the session's current model; a pass whose tools differ releases every
 * signed block through the same path a rewrite of the request head uses.
 *
 * A model switch is not counted here: it has its own handling, so a fingerprint
 * recorded for another model is replaced silently, as is a missing one (the
 * session's first pass after this record existed).
 */
const NAMESPACE = "requestToolsRelease";

interface StoredRequestTools extends RequestToolsFingerprint {
    modelKey: string;
}

function parseStored(value: unknown): StoredRequestTools | null {
    if (typeof value !== "object" || value === null) return null;
    const record = value as Record<string, unknown>;
    if (
        typeof record.modelKey !== "string" ||
        typeof record.names !== "string" ||
        typeof record.descriptions !== "string" ||
        typeof record.schemas !== "string"
    )
        return null;
    return {
        modelKey: record.modelKey,
        names: record.names,
        descriptions: record.descriptions,
        schemas: record.schemas,
    };
}

function sameStored(left: StoredRequestTools | null, right: StoredRequestTools): boolean {
    return (
        left !== null &&
        left.modelKey === right.modelKey &&
        left.names === right.names &&
        left.descriptions === right.descriptions &&
        left.schemas === right.schemas
    );
}

export interface RequestToolsRelease {
    /**
     * What changed since the tool list last served on this model, or null when
     * nothing did or there was nothing to compare with.
     */
    change: RequestToolsChange | null;
    /**
     * Record this pass's tool list. Call once the pass has persisted the strip
     * its release required, so a pass that fails first is evaluated again.
     */
    commit(): void;
}

/**
 * Compare a prefix-bound model's request tools with the list last served on
 * the same model. Logs every release with what changed, so a host whose
 * schemas differ between otherwise identical requests shows up in the logs.
 */
export function evaluateRequestToolsRelease(args: {
    db: Database;
    sessionId: string;
    modelKey: string;
    fingerprint: RequestToolsFingerprint;
}): RequestToolsRelease {
    const current: StoredRequestTools = { modelKey: args.modelKey, ...args.fingerprint };
    let stored: StoredRequestTools | null = null;
    let readable = true;
    try {
        stored = parseStored(readReplayEnvelope(args.db, args.sessionId, "read")[NAMESPACE]);
    } catch (error) {
        readable = false;
        sessionLog(args.sessionId, "request tools record unreadable:", error);
    }
    const change =
        stored !== null && stored.modelKey === current.modelKey
            ? classifyRequestToolsChange(stored, current)
            : null;
    if (change !== null) {
        sessionLog(
            args.sessionId,
            `request tools changed (kind=${change === "schemas" ? "schema-only" : change}, model=${current.modelKey}, schemas ${stored?.schemas.slice(0, 12)}→${current.schemas.slice(0, 12)}): releasing signed thinking`,
        );
    } else if (readable && stored?.modelKey !== current.modelKey) {
        sessionLog(
            args.sessionId,
            `request tools fingerprint adopted for model=${current.modelKey}${stored ? ` (was ${stored.modelKey})` : ""}`,
        );
    }
    return {
        change,
        commit: () => {
            if (!readable || sameStored(stored, current)) return;
            try {
                const written = updateReplayDocument(args.db, args.sessionId, (doc) => {
                    if (sameStored(parseStored(doc[NAMESPACE]), current)) return false;
                    doc.version = 2;
                    doc[NAMESPACE] = current;
                    return true;
                });
                if (written) stored = current;
                else sessionLog(args.sessionId, "request tools record not written");
            } catch (error) {
                sessionLog(args.sessionId, "request tools record write failed:", error);
            }
        },
    };
}
