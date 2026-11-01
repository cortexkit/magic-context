import type { V2MessageTimeVersion, V2StoreReader } from "./store-reader";

type Times = { created?: number; completed?: number };
type Entry = { version: V2MessageTimeVersion; time: Times };
type SessionTimes = { identity?: string; entries: Map<string, Entry> };

function isSettled(entry: Entry, readAt: number): boolean {
    // OpenCode stamps writes with Date.now(), not a unique revision. Only cache
    // writes at least 1s before this read; a backward wall-clock step over 1s
    // can still hide a rewrite with the same timestamp.
    return (
        (entry.version.type === "user" || entry.time.completed !== undefined) &&
        typeof entry.version.updated === "number" &&
        Number.isFinite(entry.version.updated) &&
        entry.version.updated <= readAt - 1000
    );
}

function sameVersion(a: V2MessageTimeVersion, b: V2MessageTimeVersion): boolean {
    return (
        a.type === b.type && a.seq === b.seq && a.created === b.created && a.updated === b.updated
    );
}

/** Reuse settled times, but check current membership before returning a cached value. */
export class V2MessageTimesCache {
    private readonly sessions = new Map<string, SessionTimes>();

    constructor(private readonly capacity = 64) {}

    delete(sessionID: string): void {
        this.sessions.delete(sessionID);
    }

    deleteMessage(sessionID: string, messageID: string): void {
        this.sessions.get(sessionID)?.entries.delete(messageID);
    }

    clear(): void {
        this.sessions.clear();
    }

    pass(sessionID: string) {
        const previous = this.sessions.get(sessionID);
        const current: SessionTimes = { entries: new Map() };
        this.sessions.delete(sessionID);
        this.sessions.set(sessionID, current);
        while (this.sessions.size > this.capacity) {
            const oldest = this.sessions.keys().next().value;
            if (oldest === undefined) break;
            this.sessions.delete(oldest);
        }
        const passTimes = new Map<string, Times | null>();
        return (reader: V2StoreReader, ids: readonly string[]): Map<string, Times> => {
            const missing = [...new Set(ids)].filter((id) => !passTimes.has(id));
            if (missing.length > 0) {
                const readAt = Date.now();
                const identity = reader.hostIdentity();
                current.identity = identity;
                const reusable = previous?.identity === identity ? previous.entries : undefined;
                const known: string[] = [];
                const refresh: string[] = [];
                let first = Infinity;
                let last = -Infinity;
                for (const id of missing) {
                    const entry = reusable?.get(id);
                    if (entry && isSettled(entry, readAt)) {
                        known.push(id);
                        first = Math.min(first, entry.version.seq);
                        last = Math.max(last, entry.version.seq);
                    } else refresh.push(id);
                }
                const versions = reader.messageTimeVersions(sessionID, known, { first, last });
                for (const id of known) {
                    const version = versions.get(id);
                    const cached = reusable?.get(id);
                    if (!version) {
                        passTimes.set(id, null);
                    } else if (
                        cached &&
                        sameVersion(cached.version, version) &&
                        (version.type === "user" || cached.time.completed !== undefined)
                    ) {
                        current.entries.set(id, cached);
                        passTimes.set(id, cached.time);
                    } else refresh.push(id);
                }
                // Fresh reads return their revisions too: cold and incomplete
                // rows need no separate metadata lookup before reading times.
                const times = reader.messageTimes(sessionID, refresh, versions);
                for (const id of refresh) {
                    const time = times.get(id);
                    const version = versions.get(id);
                    passTimes.set(id, time ?? null);
                    if (time && version) {
                        const entry = { version, time };
                        if (isSettled(entry, readAt)) current.entries.set(id, entry);
                    }
                }
            }
            const result = new Map<string, Times>();
            for (const id of ids) {
                const time = passTimes.get(id);
                if (time) result.set(id, { ...time });
            }
            return result;
        };
    }
}
