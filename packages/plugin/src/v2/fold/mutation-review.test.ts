import { expect, test } from "bun:test";
import { runMigrations } from "../../features/magic-context/migrations";
import { getOrCreateSessionMeta, queueM0Mutation } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { clearInjectionCache, injectM0M1 } from "../../hooks/magic-context/inject-compartments";
import { Database } from "../../shared/sqlite";
import { adaptPayload } from "../hooks/payload";
import type { SessionContext, V2Message } from "../hooks/types";
import type { V2StoreReader } from "../store-reader";
import { nativeFoldCache } from "./memory-cache";
import { NativeFoldReplay } from "./native-replay";
import { foldDigest } from "./owner";

const model = { providerID: "p", id: "m" };
const user = (id: string, text: string): V2Message => ({
    id,
    role: "user",
    content: [{ type: "text", text }],
});
const context = (messages: V2Message[]): SessionContext => ({
    sessionID: "s",
    model,
    agent: "build",
    system: [],
    tools: {},
    options: {},
    messages,
});

test("review: a HARD fold after deleting a compartment recovers the same raw history with or without a host cut", async () => {
    const noCutDB = new Database(":memory:");
    const cutDB = new Database(":memory:");
    try {
        for (const db of [noCutDB, cutDB]) {
            initializeDatabase(db);
            runMigrations(db);
            getOrCreateSessionMeta(db, "s");
            db.prepare(`INSERT INTO compartments(session_id,sequence,start_message,end_message,
            start_message_id,end_message_id,title,content,p1,p2,p3,p4,created_at)
            VALUES ('s',0,1,1,'old','old','old history','old summary','old summary','old summary','old summary','old summary',1)`).run();
        }
        const native = [
            user("old", "RAW_HISTORY_NO_LONGER_IN_THE_SUMMARY"),
            user("tail", "current user"),
        ];
        const render = (db: Database, raw: V2Message[]) => {
            const draft = context(structuredClone(raw));
            const mapped = adaptPayload(draft);
            const result = injectM0M1({
                db,
                sessionId: "s",
                state: getOrCreateSessionMeta(db, "s"),
                messages: mapped.messages,
                injectDocs: false,
                memoryEnabled: false,
                temporalAwareness: false,
                isCacheBustingPass: true,
            });
            mapped.commit();
            return { draft, result };
        };
        const served = render(cutDB, native);
        const control = render(noCutDB, native);
        expect(JSON.stringify(served.draft.messages)).toBe(JSON.stringify(control.draft.messages));
        expect(served.result.m0RematerializedThisPass).toBe(true);
        expect(JSON.stringify(served.draft.messages)).not.toContain(
            "RAW_HISTORY_NO_LONGER_IN_THE_SUMMARY",
        );
        const source = native.map((message, index) => ({
            id: message.id!,
            seq: index + 1,
            session_id: "s",
            type: "user",
            data: { text: message.content[0]!.text },
            time_created: 0,
        }));
        const reader = {
            close() {},
            latestCompaction: () => undefined,
            rowStampsThrough: () => source,
            replayRowStamps: (_sid: string, through: number) =>
                new Map(
                    source
                        .filter((row) => row.seq <= through)
                        .map((row) => [row.seq, foldDigest(JSON.stringify(row.data))]),
                ),
            sequenceForId: (_sid: string, id: string) => source.find((row) => row.id === id)?.seq,
            latestSequence: () => 2,
            latestSequenceForIds: () => 2,
            latestRunningCompaction: () => ({ id: "cut" }),
            range: (_sid: string, after: number, through: number) =>
                source.filter((row) => row.seq > after && row.seq <= through),
        } as unknown as V2StoreReader;
        const storage = nativeFoldCache(cutDB);
        const replay = new NativeFoldReplay(storage, () => reader);
        await replay.capture(served.draft, native);
        const summary = await replay.baseline("s");
        expect(typeof summary).toBe("string");
        await replay.supply({ draft: context([]), reader, summary: summary! });
        const restored = await replay.restore(
            "s",
            {
                id: "cut",
                seq: 3,
                session_id: "s",
                type: "compaction",
                data: { status: "completed", summary },
            },
            "p/m",
        );
        expect(restored).toBeDefined();
        // Compartment deletion is an existing HARD trigger, not permission
        // invented by the host optimization. The host still retains the raw row
        // named old, so deleting its summary must expose that original text again.
        for (const db of [noCutDB, cutDB]) {
            db.prepare("DELETE FROM compartments WHERE session_id='s'").run();
            queueM0Mutation(db, {
                sessionId: "s",
                mutationType: "compartment_delete",
                queuedAt: 2,
            });
        }
        clearInjectionCache("s");
        const withoutCut = render(noCutDB, native);
        expect(withoutCut.result.m0RematerializedThisPass).toBe(true);
        expect(JSON.stringify(withoutCut.draft.messages)).toContain(
            "RAW_HISTORY_NO_LONGER_IN_THE_SUMMARY",
        );
        const withCut = render(cutDB, restored!);
        expect(withCut.result.m0RematerializedThisPass).toBe(true);
        expect(JSON.stringify(withCut.draft.messages)).toBe(
            JSON.stringify(withoutCut.draft.messages),
        );
    } finally {
        clearInjectionCache("s");
        noCutDB.close();
        cutDB.close();
    }
});
