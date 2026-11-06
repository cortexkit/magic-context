import type { V2Context } from "./types";

type Storage = V2Context["storage"];
type SessionMemo = Map<string, boolean>;
interface AdmissionMemo {
    sessions: Map<string, SessionMemo>;
    revision: number;
    set: Storage["set"];
    remove: Storage["remove"];
    wrappedSet: Storage["set"];
    wrappedRemove: Storage["remove"];
}

const memos = new WeakMap<Storage, AdmissionMemo>();
const MAX_SESSIONS = 64;
const MAX_IDS = 50_000;

function admissionSession(key: string): string | undefined {
    if (!key.startsWith("synthetic/")) return undefined;
    const end = key.indexOf("/", "synthetic/".length);
    return end < 0 ? undefined : key.slice("synthetic/".length, end);
}

function memoFor(storage: Storage): AdmissionMemo {
    const prior = memos.get(storage);
    if (prior) return prior;
    const sessions = new Map<string, SessionMemo>();
    const set = storage.set;
    const remove = storage.remove;
    const invalidate = (key: string) => {
        const sessionID = admissionSession(key);
        if (sessionID !== undefined) {
            sessions.delete(sessionID);
            const current = memos.get(storage);
            if (current) {
                current.sessions.delete(sessionID);
                current.revision++;
            }
        }
    };
    // deliverSynthetic in channel2.ts is the only admission writer and uses this API.
    // Observe overwrites and removals as well as deliveries: positive and negative
    // answers must both expire. Invalidate on both sides of an async write so a
    // read racing it cannot keep the pre-write answer after the write completes.
    const wrappedSet: Storage["set"] = async (key, value) => {
        invalidate(key);
        try {
            await set.call(storage, key, value);
        } finally {
            invalidate(key);
        }
    };
    const wrappedRemove: Storage["remove"] =
        remove &&
        (async (key) => {
            invalidate(key);
            try {
                await remove.call(storage, key);
            } finally {
                invalidate(key);
            }
        });
    const memo = { sessions, revision: 0, set, remove, wrappedSet, wrappedRemove };
    storage.set = wrappedSet;
    if (wrappedRemove) storage.remove = wrappedRemove;
    memos.set(storage, memo);
    return memo;
}

export function forgetSyntheticAdmission(storage: Storage, sessionID: string): void {
    const memo = memoFor(storage);
    memo.sessions.delete(sessionID);
    memo.revision++;
}

export function clearSyntheticAdmissions(storage: Storage): void {
    const memo = memos.get(storage);
    if (!memo) return;
    memo.sessions.clear();
    if (storage.set === memo.wrappedSet) storage.set = memo.set;
    if (storage.remove === memo.wrappedRemove) storage.remove = memo.remove;
    memos.delete(storage);
}

export async function admittedSynthetic(
    storage: Storage,
    sessionID: string,
    id: string,
): Promise<boolean> {
    for (;;) {
        const memo = memoFor(storage);
        const session = memo.sessions.get(sessionID) ?? new Map<string, boolean>();
        memo.sessions.delete(sessionID);
        memo.sessions.set(sessionID, session);
        if (memo.sessions.size > MAX_SESSIONS)
            memo.sessions.delete(memo.sessions.keys().next().value!);
        const known = session.get(id);
        if (known !== undefined) return known;
        const revision = memo.revision;
        const record = await storage.get(`synthetic/${sessionID}/${id}`);
        // A write or lifecycle cleanup may have overtaken this read. Eviction alone
        // needs no retry: the answer is still current, just no longer worth keeping.
        if (memos.get(storage) !== memo || memo.revision !== revision) continue;
        const admitted =
            record !== null && typeof record === "object" && "id" in record && record.id === id;
        if (memo.sessions.get(sessionID) !== session) return admitted;
        if (session.size >= MAX_IDS) session.delete(session.keys().next().value!);
        session.set(id, admitted);
        return admitted;
    }
}
