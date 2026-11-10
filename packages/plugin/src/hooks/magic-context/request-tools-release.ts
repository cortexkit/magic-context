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
 * session's replay document keeps, for each prefix-bound model the session
 * used, the fingerprint of the last tool list served on that model; a pass
 * whose tools differ from its own model's record releases every signed block
 * through the same path a rewrite of the request head uses.
 *
 * The record is kept per model because a session can switch between two
 * prefix-bound models and back: the returning model's own thinking from
 * before the switch is still bound to the list that model last saw, so the
 * return pass must compare with that list, not with the other model's. A model
 * with no record yet adopts its list silently: the session's first pass on that
 * model, including the first pass after an upgrade to a build that keeps these
 * records. A model switch has its own handling.
 */
const NAMESPACE = "requestToolsRelease";

/**
 * How many models' records a session keeps. The least recently served model's
 * record is dropped first; a session that returns to a model after more than
 * this many other prefix-bound models adopts that model's list again.
 */
const MAX_MODEL_RECORDS = 8;

interface StoredRequestTools extends RequestToolsFingerprint {
    modelKey: string;
}

function parseEntry(value: unknown): StoredRequestTools | null {
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

/** The session's records, least recently served model first. */
function parseStored(value: unknown): StoredRequestTools[] {
    const models = (value as { models?: unknown } | null | undefined)?.models;
    if (!Array.isArray(models)) return [];
    const entries: StoredRequestTools[] = [];
    for (const item of models) {
        const entry = parseEntry(item);
        if (entry) entries.push(entry);
    }
    return entries;
}

function sameEntry(left: StoredRequestTools | undefined, right: StoredRequestTools): boolean {
    return (
        left !== undefined &&
        left.modelKey === right.modelKey &&
        left.names === right.names &&
        left.descriptions === right.descriptions &&
        left.schemas === right.schemas
    );
}

/** True when `current` is already the most recently served model's record. */
function isLatest(entries: readonly StoredRequestTools[], current: StoredRequestTools): boolean {
    return sameEntry(entries.at(-1), current);
}

/** `entries` with `current` as the most recently served model, bounded. */
function withLatest(
    entries: readonly StoredRequestTools[],
    current: StoredRequestTools,
): StoredRequestTools[] {
    const next = entries.filter((entry) => entry.modelKey !== current.modelKey);
    next.push(current);
    return next.slice(-MAX_MODEL_RECORDS);
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
    let entries: StoredRequestTools[] = [];
    let readable = true;
    try {
        entries = parseStored(readReplayEnvelope(args.db, args.sessionId, "read")[NAMESPACE]);
    } catch (error) {
        readable = false;
        sessionLog(args.sessionId, "request tools record unreadable:", error);
    }
    const stored = entries.find((entry) => entry.modelKey === current.modelKey);
    const change = stored ? classifyRequestToolsChange(stored, current) : null;
    if (change !== null) {
        sessionLog(
            args.sessionId,
            `request tools changed (kind=${change === "schemas" ? "schema-only" : change}, model=${current.modelKey}, schemas ${stored?.schemas.slice(0, 12)}→${current.schemas.slice(0, 12)}): releasing signed thinking`,
        );
    } else if (readable && !stored) {
        sessionLog(
            args.sessionId,
            `request tools fingerprint adopted for model=${current.modelKey}${entries.length > 0 ? ` (records kept for ${entries.map((entry) => entry.modelKey).join(",")})` : ""}`,
        );
    }
    return {
        change,
        commit: () => {
            if (!readable || isLatest(entries, current)) return;
            try {
                let next = entries;
                const written = updateReplayDocument(args.db, args.sessionId, (doc) => {
                    const latest = parseStored(doc[NAMESPACE]);
                    if (isLatest(latest, current)) return false;
                    next = withLatest(latest, current);
                    doc.version = 2;
                    doc[NAMESPACE] = { models: next };
                    return true;
                });
                if (written) entries = next;
                else sessionLog(args.sessionId, "request tools record not written");
            } catch (error) {
                sessionLog(args.sessionId, "request tools record write failed:", error);
            }
        },
    };
}
