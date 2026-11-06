import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    readReplayEnvelope,
    updateReplayDocument,
} from "../../features/magic-context/storage-replay-document";
import { createTagger } from "../../features/magic-context/tagger";
import { Database } from "../../shared/sqlite";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { saveLkgSlotToDb } from "./lkg-persist";
import { buildLkgPrefix } from "./lkg-replay";
import {
    prepareStructuralSentinelChoices,
    projectStructuralSentinels,
} from "./project-structural-sentinels";
import { stripStructuralNoise } from "./strip-structural-noise";
import { type MessageLike, tagMessages } from "./tag-messages";

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
        expect(readReplayEnvelope(db, sessionId).structuralSentinelChoices).toEqual({
            served: "keep",
            "possibly-new": "keep",
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
    expect(readReplayEnvelope(db, sessionId).structuralSentinelChoices).toEqual({ first: "omit" });
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
    expect(readReplayEnvelope(db, sessionId).structuralSentinelChoices).toEqual({
        served: "keep",
        "new-after-restart": "omit",
    });
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
    expect(readReplayEnvelope(db, sessionId).structuralSentinelChoices).toEqual({
        served: "omit",
        "new-after-restart": "omit",
    });
});

test("an empty upgrade map is durable and does not reclassify the next reply after restart", () => {
    const directory = createTestTempDirFromPath(join(tmpdir(), "mc-sentinel-empty-"));
    directories.push(directory);
    const path = join(directory, "context.db");
    const sessionId = "empty-upgrade";
    let db = database(path);
    seedLegacyReplay(db, sessionId);
    prepareStructuralSentinelChoices({ db, sessionId, messages: [] });
    expect(readReplayEnvelope(db, sessionId).structuralSentinelChoices).toEqual({});
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
    expect(readReplayEnvelope(db, sessionId).structuralSentinelChoices).toEqual({
        omitted: "omit",
        "other-served": "keep",
    });
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
