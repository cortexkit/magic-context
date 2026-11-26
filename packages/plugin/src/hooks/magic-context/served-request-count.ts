import { type DecisionCalibration, providerMass } from "./decision-calibration";
import type { SavedServedRequest } from "./final-wire-token-estimate";

/**
 * Our own count of the last request each session served, kept in memory for
 * the emergency tool drop.
 *
 * The drop infers the part of the request no tool drop can remove (the fixed
 * part) from a size of the whole request minus our count of its active tags.
 * The provider's usage reading is one such size, but it is in the provider's
 * units: every token by which it exceeds our count of the same request would
 * land in the fixed part. This count is in our units, so the planner caps the
 * size it infers the fixed part from by it.
 *
 * It describes a request that was already sent, never the one the current pass
 * is building. A pass reads the count of the pass before it, and only that:
 * `passStarted` moves the previous pass's record into place and clears it, so a
 * pass that ends without recording leaves the next pass with no count rather
 * than an older one.
 *
 * Counts are stored as raw local counts (system prompt, tool definitions plus
 * tool calls and results, prose) and priced with the caller's calibration, so
 * the whole and the tags it is compared with use the same ratios.
 */
export interface ServedRequestRecord {
    /** `providerID/modelID` the request was counted for. */
    modelKey?: string;
    /** The pass's own count, when it made one. */
    components?: { system: number; tools: number; prose: number };
    /** A saved copy to count on demand when the pass made no count. */
    saved?: SavedServedRequest;
    /** Text a host adds after the transform, already in provider units. */
    hostAddedTokens?: number;
}

const MAX_SESSIONS = 64;

/** One request's tool set as OpenCode 2 recorded it (`getSessionRequestToolSet`). */
export interface RequestToolSet {
    request: number;
    total: number;
}

export function createServedRequestCounts() {
    const previousPass = new Map<string, ServedRequestRecord>();
    const thisPass = new Map<string, ServedRequestRecord>();
    // OpenCode 2 records a request's tool set just before the transform pass
    // that builds that request. `seenRequest` is the request number the last
    // pass started with; `passTools` is the set the current pass started
    // with, kept only when it was recorded after the last pass started.
    const seenRequest = new Map<string, number>();
    const passTools = new Map<string, RequestToolSet>();
    const bounded = <T>(map: Map<string, T>) => {
        while (map.size > MAX_SESSIONS) {
            const oldest = map.keys().next().value;
            if (oldest === undefined) break;
            map.delete(oldest);
        }
    };
    return {
        /**
         * Start a pass: the last pass's record becomes the one to read.
         * `requestTools` is the session's recorded request tool set as the
         * pass starts (OpenCode 2 only).
         */
        passStarted(sessionId: string, requestTools?: RequestToolSet): void {
            const record = thisPass.get(sessionId);
            thisPass.delete(sessionId);
            previousPass.delete(sessionId);
            if (record) {
                previousPass.set(sessionId, record);
                bounded(previousPass);
            }
            passTools.delete(sessionId);
            if (requestTools) {
                const last = seenRequest.get(sessionId);
                seenRequest.delete(sessionId);
                seenRequest.set(sessionId, requestTools.request);
                bounded(seenRequest);
                if (requestTools.request !== last) {
                    passTools.set(sessionId, requestTools);
                    bounded(passTools);
                }
            }
        },
        /**
         * The tool set of the request this pass serves, or undefined when it
         * can't be tied to that request. It is that request's only when the
         * set was recorded after the previous pass started (a set a previous
         * pass already started with belongs to an earlier request) and no
         * other request was recorded while this pass ran (`requestTools` is
         * the session's recorded set read now).
         */
        requestToolSet(sessionId: string, requestTools?: RequestToolSet): RequestToolSet | undefined {
            const started = passTools.get(sessionId);
            if (!started || !requestTools || requestTools.request !== started.request)
                return undefined;
            return started;
        },
        /** Record the request this pass served. */
        record(sessionId: string, record: ServedRequestRecord): void {
            if (!record.components && !record.saved) return;
            thisPass.delete(sessionId);
            thisPass.set(sessionId, record);
            bounded(thisPass);
        },
        forget(sessionId: string): void {
            previousPass.delete(sessionId);
            thisPass.delete(sessionId);
            seenRequest.delete(sessionId);
            passTools.delete(sessionId);
        },
        /**
         * Our count of the last request served, priced with `calibration`, or
         * undefined when there is none or it was counted for another model.
         */
        tokens(
            sessionId: string,
            modelKey: string | undefined,
            calibration: DecisionCalibration,
        ): number | undefined {
            const record = previousPass.get(sessionId);
            if (!record || !modelKey) return undefined;
            if (!record.components && record.saved) {
                const counted = record.saved.count();
                record.saved = undefined;
                if (counted) {
                    record.components = counted.components;
                    record.modelKey = counted.modelKey;
                }
            }
            if (!record.components || record.modelKey !== modelKey) return undefined;
            const hostAdded =
                record.hostAddedTokens !== undefined &&
                Number.isFinite(record.hostAddedTokens) &&
                record.hostAddedTokens > 0
                    ? record.hostAddedTokens
                    : 0;
            const tokens = providerMass(record.components, calibration) + hostAdded;
            return Number.isFinite(tokens) && tokens > 0 ? tokens : undefined;
        },
    };
}

export type ServedRequestCounts = ReturnType<typeof createServedRequestCounts>;
