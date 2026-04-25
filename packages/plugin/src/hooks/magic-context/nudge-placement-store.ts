import {
    clearPersistedNudgePlacement,
    getPersistedNudgePlacement,
    setPersistedNudgePlacement,
} from "../../features/magic-context/storage";
import type { Database } from "../../shared/sqlite";

interface NudgePlacement {
    messageId: string;
    nudgeText: string;
}

export interface NudgePlacementStore {
    set(sessionId: string, messageId: string, nudgeText: string): void;
    get(sessionId: string): NudgePlacement | null;
    clear(sessionId: string, options?: { persist?: boolean }): void;
}

export function createNudgePlacementStore(db?: Database): NudgePlacementStore {
    const store = new Map<string, NudgePlacement>();
    const missingSessions = new Set<string>();
    return {
        set(sessionId, messageId, nudgeText) {
            const placement = { messageId, nudgeText };
            store.set(sessionId, placement);
            missingSessions.delete(sessionId);
            if (db) {
                setPersistedNudgePlacement(db, sessionId, messageId, nudgeText);
            }
        },
        get(sessionId) {
            const existing = store.get(sessionId);
            if (existing) return existing;
            if (!db || missingSessions.has(sessionId)) return null;
            const persisted = getPersistedNudgePlacement(db, sessionId);
            if (!persisted) {
                missingSessions.add(sessionId);
                return null;
            }
            store.set(sessionId, persisted);
            return persisted;
        },
        clear(sessionId, options) {
            store.delete(sessionId);
            missingSessions.add(sessionId);
            if (db && options?.persist !== false) {
                clearPersistedNudgePlacement(db, sessionId);
            }
        },
    };
}
