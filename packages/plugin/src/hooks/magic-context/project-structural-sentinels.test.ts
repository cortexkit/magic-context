import { afterEach, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertToModelMessages, type UIMessage } from "ai";
import { convertToLanguageModelPrompt } from "ai/internal";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    readReplayEnvelope,
    updateReplayDocument,
} from "../../features/magic-context/storage-replay-document";
import { createTagger } from "../../features/magic-context/tagger";
import { createMessagesTransformHandler } from "../../plugin/messages-transform";
import { Database } from "../../shared/sqlite";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { saveLkgSlotToDb } from "./lkg-persist";
import { buildLkgPrefix } from "./lkg-replay";
import { getSlot } from "./lkg-slot";
import {
    prepareStructuralSentinelChoices,
    projectStructuralSentinels,
} from "./project-structural-sentinels";
import { stripStructuralNoise } from "./strip-structural-noise";
import { type MessageLike, tagMessages } from "./tag-messages";
import { createTransform } from "./transform";

const databases: Database[] = [];
const directories: string[] = [];
afterEach(() => {
    for (const db of databases) db.close();
    databases.length = 0;
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
    directories.length = 0;
});

function database(path = ":memory:"): Database {
    const db = new Database(path);
    databases.push(db);
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function seedLegacyReplay(db: Database, sessionId: string): void {
    expect(
        updateReplayDocument(db, sessionId, (document) => {
            document.version = 2;
            return true;
        }),
    ).toBe(true);
}

function reply(id: string): MessageLike {
    return {
        info: { id, role: "assistant" },
        parts: [
            { type: "step-start" },
            {
                type: "reasoning",
                text: "signed thinking",
                metadata: { anthropic: { signature: "unchanged-signature" } },
            },
            { type: "text", text: "" },
            { type: "text", text: "reply" },
            { type: "step-finish" },
        ],
    };
}

function rejectUpgradeWrites(db: Database): () => number {
    db.exec(`
        CREATE TEMP TABLE rejected_upgrade_writes (attempt INTEGER);
        CREATE TEMP TRIGGER reject_structural_upgrade
        BEFORE UPDATE OF trailing_blank_decisions ON session_meta
        WHEN instr(NEW.trailing_blank_decisions, '"structuralSentinelUpgrade"') > 0
        BEGIN
            INSERT INTO rejected_upgrade_writes VALUES (1);
            SELECT RAISE(FAIL, 'upgrade write unavailable');
        END;
    `);
    return () =>
        (
            db.prepare("SELECT count(*) AS count FROM rejected_upgrade_writes").get() as {
                count: number;
            }
        ).count;
}

for (const priorState of ["replay document", "tags", "last-good slot"] as const) {
    test(`sentinel upgrade keeps signed replies with prior ${priorState}`, () => {
        const db = database();
        const sessionId = `prior-${priorState}`;
        if (priorState === "replay document") {
            seedLegacyReplay(db, sessionId);
        } else if (priorState === "tags") {
            const tagger = createTagger();
            tagger.initFromDb(sessionId, db);
            tagMessages(sessionId, [reply("previous")], tagger, db).batch?.finalize();
        } else {
            const user: MessageLike = {
                info: { id: "user", role: "user" },
                parts: [{ type: "text", text: "question" }],
            };
            const slot = buildLkgPrefix([user], [user]);
            expect(slot).not.toBeNull();
            expect(
                saveLkgSlotToDb(db, sessionId, {
                    ...slot!,
                    lastInputMessageId: slot!.anchorMessageId,
                    modelKey: null,
                    providerKey: null,
                    capturedAt: 1,
                }),
            ).toBe(true);
        }
        const messages = [reply("served"), reply("possibly-new")];
        prepareStructuralSentinelChoices({ db, sessionId, messages });
        stripStructuralNoise(messages);
        const before = JSON.stringify(messages);
        expect(projectStructuralSentinels({ db, sessionId, messages, rebuilding: false })).toBe(0);
        expect(JSON.stringify(messages)).toBe(before);
        expect(readReplayEnvelope(db, sessionId).structuralSentinelUpgrade).toEqual({
            keep: ["served", "possibly-new"],
        });
        const later = [reply("served"), reply("possibly-new"), reply("later")];
        stripStructuralNoise(later);
        expect(
            projectStructuralSentinels({ db, sessionId, messages: later, rebuilding: false }),
        ).toBe(2);
        expect(later.slice(0, 2)).toEqual(messages);
        expect(later[2].parts).toEqual(reply("later").parts.slice(1, -1));
    });
}

test("a fresh session records omissions before its first tags and preserves native empty text", () => {
    const db = database();
    const sessionId = "fresh";
    const messages = [reply("first")];
    prepareStructuralSentinelChoices({ db, sessionId, messages });
    const tagger = createTagger();
    tagger.initFromDb(sessionId, db);
    tagMessages(sessionId, messages, tagger, db).batch?.finalize();
    stripStructuralNoise(messages);
    expect(projectStructuralSentinels({ db, sessionId, messages, rebuilding: false })).toBe(2);
    expect(messages[0].parts[0]).toEqual(reply("first").parts[1]);
    expect(messages[0].parts[1]).toEqual({ type: "text", text: "" });
    expect(readReplayEnvelope(db, sessionId).structuralSentinelUpgrade).toEqual({ keep: [] });
    expect(readReplayEnvelope(db, sessionId).structuralSentinelOmissions).toBeUndefined();
});

test("legacy keep choices survive reopen while later replies omit on a defer pass", () => {
    const directory = createTestTempDirFromPath(join(tmpdir(), "mc-sentinel-upgrade-"));
    directories.push(directory);
    const path = join(directory, "context.db");
    const sessionId = "restart";
    let db = database(path);
    seedLegacyReplay(db, sessionId);
    prepareStructuralSentinelChoices({ db, sessionId, messages: [reply("served")] });
    db.close();
    databases.pop();
    db = database(path);
    const messages = [reply("served"), reply("new-after-restart")];
    stripStructuralNoise(messages);
    expect(projectStructuralSentinels({ db, sessionId, messages, rebuilding: false })).toBe(2);
    expect(readReplayEnvelope(db, sessionId).structuralSentinelUpgrade).toEqual({
        keep: ["served"],
    });
    expect(readReplayEnvelope(db, sessionId).structuralSentinelOmissions).toBeUndefined();
    const before = JSON.stringify(messages);
    db.close();
    databases.pop();
    db = database(path);
    const replay = [reply("served"), reply("new-after-restart")];
    stripStructuralNoise(replay);
    expect(projectStructuralSentinels({ db, sessionId, messages: replay, rebuilding: false })).toBe(
        2,
    );
    expect(JSON.stringify(replay)).toBe(before);
    const rebuilt = [reply("served"), reply("new-after-restart")];
    stripStructuralNoise(rebuilt);
    expect(projectStructuralSentinels({ db, sessionId, messages: rebuilt, rebuilding: true })).toBe(
        4,
    );
    expect(readReplayEnvelope(db, sessionId).structuralSentinelUpgrade).toEqual({
        keep: ["served"],
    });
    expect(readReplayEnvelope(db, sessionId).structuralSentinelOmissions).toEqual(["served"]);
});

test("an empty upgrade keep set is durable and does not reclassify the next reply after restart", () => {
    const directory = createTestTempDirFromPath(join(tmpdir(), "mc-sentinel-empty-"));
    directories.push(directory);
    const path = join(directory, "context.db");
    const sessionId = "empty-upgrade";
    let db = database(path);
    seedLegacyReplay(db, sessionId);
    prepareStructuralSentinelChoices({ db, sessionId, messages: [] });
    expect(readReplayEnvelope(db, sessionId).structuralSentinelUpgrade).toEqual({ keep: [] });
    db.close();
    databases.pop();
    db = database(path);
    const messages = [reply("later")];
    stripStructuralNoise(messages);
    expect(projectStructuralSentinels({ db, sessionId, messages, rebuilding: false })).toBe(2);
});

test("upgrade preserves omissions already frozen by the previous code", () => {
    const db = database();
    const sessionId = "old-omission";
    expect(
        updateReplayDocument(db, sessionId, (document) => {
            document.version = 2;
            document.structuralSentinelOmissions = ["omitted"];
            return true;
        }),
    ).toBe(true);
    const messages = [reply("omitted"), reply("other-served")];
    stripStructuralNoise(messages);
    expect(projectStructuralSentinels({ db, sessionId, messages, rebuilding: false })).toBe(2);
    expect(readReplayEnvelope(db, sessionId).structuralSentinelUpgrade).toEqual({
        keep: ["omitted", "other-served"],
    });
    expect(readReplayEnvelope(db, sessionId).structuralSentinelOmissions).toEqual(["omitted"]);
});

test("first-seen choices are recorded even before a signed reply has structural markers", () => {
    const db = database();
    const sessionId = "no-markers-yet";
    seedLegacyReplay(db, sessionId);
    const early = reply("served");
    early.parts = early.parts.slice(1, -1);
    prepareStructuralSentinelChoices({ db, sessionId, messages: [early] });
    const later = [reply("served")];
    stripStructuralNoise(later);
    expect(projectStructuralSentinels({ db, sessionId, messages: later, rebuilding: false })).toBe(
        0,
    );
});

test("50 new signed replies after upgrade leave the replay document byte-identical", () => {
    const db = database();
    const sessionId = "fixed-upgrade-set";
    seedLegacyReplay(db, sessionId);
    prepareStructuralSentinelChoices({ db, sessionId, messages: [reply("served")] });
    const stored = () =>
        (
            db
                .prepare("SELECT trailing_blank_decisions FROM session_meta WHERE session_id = ?")
                .get(sessionId) as { trailing_blank_decisions: string }
        ).trailing_blank_decisions;
    const changes = () =>
        (db.prepare("SELECT total_changes() AS count").get() as { count: number }).count;
    const before = stored();
    const writesBefore = changes();
    for (let pass = 0; pass < 50; pass++) {
        const messages = [reply("served"), reply(`new-${pass}`)];
        prepareStructuralSentinelChoices({ db, sessionId, messages });
        stripStructuralNoise(messages);
        expect(projectStructuralSentinels({ db, sessionId, messages, rebuilding: false })).toBe(2);
        expect(messages[0].parts).toHaveLength(5);
        expect(messages[1].parts).toEqual(reply(`new-${pass}`).parts.slice(1, -1));
        expect(stored()).toBe(before);
        expect(changes()).toBe(writesBefore);
    }
});

test("an unsigned reply outside the upgrade keep set retains its sentinels and serves identical bytes", async () => {
    const db = database();
    const sessionId = "unsigned-after-upgrade";
    seedLegacyReplay(db, sessionId);
    prepareStructuralSentinelChoices({ db, sessionId, messages: [reply("served")] });
    let memoryBefore: string | undefined;
    let servedBefore: string | undefined;
    for (let pass = 0; pass < 2; pass++) {
        const messages: MessageLike[] = [
            {
                info: { id: "unsigned", role: "assistant" },
                parts: [
                    { type: "step-start" },
                    { type: "text", text: "unsigned reply" },
                    { type: "step-finish" },
                ],
            },
        ];
        stripStructuralNoise(messages);
        expect(projectStructuralSentinels({ db, sessionId, messages, rebuilding: false })).toBe(0);
        expect(messages[0].parts).toEqual([
            { type: "text", text: "" },
            { type: "text", text: "unsigned reply" },
            { type: "text", text: "" },
        ]);
        const memoryBytes = JSON.stringify(messages);
        const servedBytes = JSON.stringify(
            await convertToLanguageModelPrompt({
                prompt: {
                    messages: await convertToModelMessages([
                        {
                            id: "unsigned",
                            role: "assistant",
                            parts: messages[0].parts as UIMessage["parts"],
                        },
                    ]),
                },
                supportedUrls: {},
                download: undefined,
            }),
        );
        expect(servedBytes).toBe(
            JSON.stringify([
                { role: "assistant", content: [{ type: "text", text: "unsigned reply" }] },
            ]),
        );
        if (pass === 0) {
            memoryBefore = memoryBytes;
            servedBefore = servedBytes;
        } else {
            expect(memoryBytes).toBe(memoryBefore);
            expect(servedBytes).toBe(servedBefore);
        }
    }
    const structuralOnly: MessageLike[] = [
        {
            info: { id: "unsigned-structural-only", role: "assistant" },
            parts: [{ type: "step-start" }, { type: "step-finish" }],
        },
    ];
    stripStructuralNoise(structuralOnly);
    expect(
        projectStructuralSentinels({ db, sessionId, messages: structuralOnly, rebuilding: true }),
    ).toBe(0);
    expect(structuralOnly[0].parts).toEqual([
        { type: "text", text: "" },
        { type: "text", text: "" },
    ]);
});

test("a failed upgrade preserves new sentinels until tags make the next upgrade conservative", () => {
    const db = database();
    const sessionId = "failed-fresh-upgrade";
    const attempts = rejectUpgradeWrites(db);
    const messages = [reply("served-during-failure")];
    const prepared = prepareStructuralSentinelChoices({ db, sessionId, messages });
    expect(prepared.structuralSentinelUpgrade).toBeUndefined();
    const tagger = createTagger();
    tagger.initFromDb(sessionId, db);
    tagMessages(sessionId, messages, tagger, db).batch?.finalize();
    stripStructuralNoise(messages);
    const before = JSON.stringify(messages);
    expect(
        projectStructuralSentinels({
            db,
            sessionId,
            messages,
            rebuilding: true,
            deferUpgrade: true,
        }),
    ).toBe(0);
    expect(JSON.stringify(messages)).toBe(before);
    expect(attempts()).toBe(1);
    expect(readReplayEnvelope(db, sessionId).structuralSentinelUpgrade).toBeUndefined();
    db.exec("DROP TRIGGER reject_structural_upgrade");
    const next = [reply("served-during-failure")];
    stripStructuralNoise(next);
    expect(projectStructuralSentinels({ db, sessionId, messages: next, rebuilding: false })).toBe(
        0,
    );
    expect(readReplayEnvelope(db, sessionId).structuralSentinelUpgrade).toEqual({
        keep: ["served-during-failure"],
    });
    const later = [reply("served-during-failure"), reply("new-after-success")];
    stripStructuralNoise(later);
    expect(projectStructuralSentinels({ db, sessionId, messages: later, rebuilding: false })).toBe(
        2,
    );
    expect(later[0].parts).toEqual(next[0].parts);
});

test("a failed upgrade still replays old omissions without authorizing a new one", () => {
    const db = database();
    const sessionId = "failed-legacy-upgrade";
    expect(
        updateReplayDocument(db, sessionId, (document) => {
            document.version = 2;
            document.structuralSentinelOmissions = ["omitted"];
            return true;
        }),
    ).toBe(true);
    const attempts = rejectUpgradeWrites(db);
    const messages = [reply("omitted"), reply("not-omitted")];
    stripStructuralNoise(messages);
    expect(projectStructuralSentinels({ db, sessionId, messages, rebuilding: true })).toBe(2);
    expect(messages[0].parts).toEqual(reply("omitted").parts.slice(1, -1));
    expect(messages[1].parts).toHaveLength(5);
    expect(attempts()).toBe(1);
    expect(readReplayEnvelope(db, sessionId).structuralSentinelOmissions).toEqual(["omitted"]);
    expect(readReplayEnvelope(db, sessionId).structuralSentinelUpgrade).toBeUndefined();
});

test("an upgrade write failure never sends a healthy transform through last-good replay", async () => {
    const db = database();
    const sessionId = "healthy-failed-upgrade";
    seedLegacyReplay(db, sessionId);
    const signed = reply("signed");
    signed.info = { ...signed.info, sessionID: sessionId, time: { created: 2 }, finish: "stop" };
    const raw = (): MessageLike[] => [
        {
            info: { id: "user", role: "user", sessionID: sessionId, time: { created: 1 } },
            parts: [{ type: "text", text: "question" }],
        },
        structuredClone(signed),
        {
            info: { id: "tail", role: "user", sessionID: sessionId, time: { created: 3 } },
            parts: [{ type: "text", text: "next question" }],
        },
    ];
    const transform = createTransform({
        db,
        storeGeneration: "v1",
        tagger: createTagger(),
        scheduler: { shouldExecute: () => "defer" as const },
        contextUsageMap: new Map([
            [sessionId, { usage: { percentage: 40, inputTokens: 80_000 }, updatedAt: Date.now() }],
        ]),
        historyRefreshSessions: new Set(),
        pendingMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
        clearReasoningAge: 50,
        protectedTokens: 0,
        historianRunnable: false,
    });
    const onLkgReplay = mock(() => undefined);
    const handler = createMessagesTransformHandler({
        magicContext: { "experimental.chat.messages.transform": transform },
        onLkgReplay,
    });
    type Output = Parameters<typeof handler>[1];
    const first = { messages: raw() } as unknown as Output;
    await handler({}, first);
    expect(onLkgReplay).not.toHaveBeenCalled();
    const warm = { messages: raw() } as unknown as Output;
    await handler({}, warm);
    expect(getSlot(sessionId)).toBeDefined();
    expect(
        updateReplayDocument(db, sessionId, (document) => {
            delete document.structuralSentinelUpgrade;
            return true;
        }),
    ).toBe(true);
    const attempts = rejectUpgradeWrites(db);
    const second = { messages: raw() } as unknown as Output;
    await handler({}, second);
    expect(onLkgReplay).not.toHaveBeenCalled();
    expect(attempts()).toBe(1);
    expect(JSON.stringify(second.messages)).toBe(JSON.stringify(warm.messages));
});
