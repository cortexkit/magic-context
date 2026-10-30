import { expect, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configLoader from "../../config";
import { MagicContextConfigSchema } from "../../config/schema/magic-context";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage-db";
import { estimateTokens } from "../../hooks/magic-context/read-session-formatting";
import * as transformModule from "../../hooks/magic-context/transform";
import * as logger from "../../shared/logger";
import { Database } from "../../shared/sqlite";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { FoldOwner } from "../fold/owner";
import * as readerModule from "../store-reader";
import { registerContext } from "./context";
import { HEAD_IDS } from "./payload";
import * as storageGate from "./storage-gate";
import type { SessionContext, V2Context } from "./types";

async function fixture() {
    const parent = join(tmpdir(), "magic-context", "checkpoint-head");
    mkdirSync(parent, { recursive: true });
    const dir = createTestTempDirFromPath(join(parent, "fixture-"));
    const db = openDatabase(join(dir, "context.db"));
    if (!db) throw new Error("fixture database unavailable");
    const source = new Database(join(dir, "opencode.db"));
    source.exec(`CREATE TABLE session_message (
        id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
        time_created INTEGER, time_updated INTEGER, data TEXT
    ); INSERT INTO session_message VALUES ('u1','s','user',1,100,100,'{"text":"unarchived source"}');`);
    const summary = "<session-history>summary</session-history>";
    source
        .prepare("INSERT INTO session_message VALUES ('cut','s','compaction',2,200,200,?)")
        .run(JSON.stringify({ status: "completed", summary, mode: "local" }));
    const config = MagicContextConfigSchema.parse({
        historian: { disable: true },
        dreamer: { disable: true },
        memory: { enabled: false },
        cache_ttl: "never",
        subc: { connection_file: join(dir, "subc-connection.json") },
    });
    const load = spyOn(configLoader, "loadPluginConfigDetailed").mockReturnValue({
        config,
    } as never);
    const gate = spyOn(storageGate, "createV2StorageGate").mockReturnValue({
        current: () => db,
        require: () => db,
        probe: async () => db,
        reason: () => null,
    });
    const path = spyOn(readerModule, "gaDatabasePath").mockReturnValue(join(dir, "opencode.db"));
    const values = new Map<string, unknown>();
    const storage = {
        get: async (key: string) => structuredClone(values.get(key)),
        set: async (key: string, value: unknown) => {
            values.set(key, structuredClone(value));
        },
    };
    const hooks = new Map<string, (draft: SessionContext) => Promise<void>>();
    let permission = false;
    let insideTransformHadRecent = false;
    let insideHostEstimate: { tokens: number; pressureTokens: number } | undefined;
    const transform = spyOn(transformModule, "createTransform").mockImplementation((deps) => {
        const handler = async (_input: unknown, output: any) => {
            insideTransformHadRecent = JSON.stringify(await storage.get("fold/v1/s")).includes(
                "<recent-context>",
            );
            insideHostEstimate = deps.hostInputEstimate?.("s");
            output.messages.unshift(
                ...HEAD_IDS.map((id) => ({
                    info: { id, role: "user", sessionID: "s", syntheticHead: true },
                    parts: [
                        { type: "text", text: id === HEAD_IDS[0] ? "current baseline" : "delta" },
                    ],
                })),
            );
            deps.onPassPermission?.("s", permission);
        };
        return Object.assign(handler, {
            getRustReplayParticipant: () => null,
            disposeRust: () => {},
        }) as never;
    });
    const host = {
        location: { directory: dir },
        agent: { transform: async () => {}, reload: async () => {} },
        model: { list: () => [] },
        storage,
        event: { subscribe: async function* () {} },
        tool: { hook: async () => {} },
        session: {
            remove: async () => {},
            compact: async () => {},
            wait: async () => {},
            interrupt: async () => ({}),
            hook: async (name: string, callback: (draft: SessionContext) => Promise<void>) => {
                hooks.set(name, callback);
            },
            get: async () => ({ location: { directory: dir } }),
        },
    } as unknown as V2Context;
    const duties = await registerContext(host);
    const checkpoint = {
        id: "cut",
        role: "user",
        content: [
            {
                type: "text",
                text: `<conversation-checkpoint>\n<summary>\n${summary}\n</summary>\n<recent-context>RAW-HOST-TRANSCRIPT</recent-context>\n</conversation-checkpoint>`,
            },
        ],
    };
    const draft = (): SessionContext => ({
        sessionID: "s",
        agent: "build",
        model: { providerID: "p", id: "m", limit: { context: 32000 } },
        system: [],
        tools: {},
        options: {},
        messages: [structuredClone(checkpoint)],
    });
    await new FoldOwner(storage).supply({
        sessionID: "s",
        watermark: 1,
        runningCut: 2,
        materialize: () => summary,
    });
    return {
        hooks,
        draft,
        source,
        storage,
        setPermission: (next: typeof permission) => {
            permission = next;
        },
        insideTransformHadRecent: () => insideTransformHadRecent,
        insideHostEstimate: () => insideHostEstimate,
        async close() {
            await duties.dispose();
            transform.mockRestore();
            load.mockRestore();
            gate.mockRestore();
            path.mockRestore();
            source.close();
            closeDatabase();
            cleanupTestTempDir(dir);
        },
    };
}

test("checkpoint strip uses this pass's final permission, persists once, and replays on defers", async () => {
    const f = await fixture();
    try {
        const context = f.hooks.get("context")!;
        const deferred = f.draft();
        await context(deferred);
        expect(JSON.stringify(deferred.messages[0])).toContain("RAW-HOST-TRANSCRIPT");
        const originalHead = JSON.stringify(deferred.messages[0]);
        for (let pass = 0; pass < 3; pass++) {
            const replay = f.draft();
            await context(replay);
            expect(JSON.stringify(replay.messages[0])).toBe(originalHead);
        }
        f.setPermission(true);
        const rebuilding = f.draft();
        await context(rebuilding);
        expect(f.insideTransformHadRecent()).toBe(true);
        expect(JSON.stringify(rebuilding.messages[0])).not.toContain("<recent-context>");
        expect(JSON.stringify(await f.storage.get("fold/v1/s"))).not.toContain(
            "RAW-HOST-TRANSCRIPT",
        );
        const head = JSON.stringify(rebuilding.messages[0]);
        f.setPermission(false);
        for (let pass = 0; pass < 3; pass++) {
            const replay = f.draft();
            await context(replay);
            expect(JSON.stringify(replay.messages[0])).toBe(head);
            expect(JSON.stringify(replay.messages)).toContain("unarchived source");
        }
        f.source.prepare("DELETE FROM session_message WHERE id = 'cut'").run();
        const reverted = f.draft();
        reverted.messages = [
            { id: "u1", role: "user", content: [{ type: "text", text: "unarchived source" }] },
        ];
        await context(reverted);
        expect(reverted.messages.some((message) => message.id === "cut")).toBe(false);
    } finally {
        await f.close();
    }
});

test("compaction summary overrides the host keepID with an own undefined key", async () => {
    const f = await fixture();
    try {
        const draft = f.draft();
        await f.hooks.get("compaction")!(draft);
        expect(draft.result?.summary).toContain("session-history");
        expect(Object.hasOwn(draft.result?.metadata ?? {}, "keepID")).toBe(true);
        expect({ keepID: "host-default", ...draft.result?.metadata }.keepID).toBeUndefined();
        expect(JSON.parse(JSON.stringify(draft.result)).metadata).toEqual({});
    } finally {
        await f.close();
    }
});

test("an oversized deferred checkpoint is refused, then an overflow permission repairs it before egress", async () => {
    const f = await fixture();
    const logs = spyOn(logger, "sessionLog");
    try {
        const oversized = () => {
            const draft = f.draft();
            draft.messages[0]!.content[0]!.text = String(
                draft.messages[0]!.content[0]!.text,
            ).replace("RAW-HOST-TRANSCRIPT", "oversized raw transcript ".repeat(40000));
            return draft;
        };
        await expect(f.hooks.get("context")!(oversized())).rejects.toThrow("Context full");
        expect(
            logs.mock.calls.some(([, message]) => message.includes("arm=checkpoint-over-window")),
        ).toBe(true);
        expect(f.insideHostEstimate()!.tokens).toBeGreaterThan(32000);
        expect(JSON.stringify(await f.storage.get("fold/v1/s"))).toContain("<recent-context>");
        f.setPermission(true);
        const repaired = oversized();
        await f.hooks.get("context")!(repaired);
        expect(JSON.stringify(repaired.messages[0])).not.toContain("<recent-context>");
        expect(JSON.stringify(repaired.messages)).toContain("unarchived source");
    } finally {
        logs.mockRestore();
        await f.close();
    }
});

test("removing recent-context never permits an oversized remaining request", async () => {
    const f = await fixture();
    const logs = spyOn(logger, "sessionLog");
    try {
        f.source
            .prepare("UPDATE session_message SET data=? WHERE id='u1'")
            .run(JSON.stringify({ text: "unsummarized user content ".repeat(40000) }));
        f.setPermission(true);
        await expect(f.hooks.get("context")!(f.draft())).rejects.toThrow("Context full");
        expect(
            logs.mock.calls.some(([, message]) => message.includes("arm=checkpoint-over-window")),
        ).toBe(true);
        expect(JSON.stringify(await f.storage.get("fold/v1/s"))).not.toContain(
            "RAW-HOST-TRANSCRIPT",
        );
        expect(
            f.source.prepare("SELECT count(*) AS n FROM session_message WHERE id='u1'").get(),
        ).toEqual({ n: 1 });
    } finally {
        logs.mockRestore();
        await f.close();
    }
});

test("checkpoint review: oversized generate suffix is refused after a permitted strip", async () => {
    const f = await fixture();
    try {
        f.setPermission(true);
        const main = f.draft();
        await f.hooks.get("context")!(main);
        expect(JSON.stringify(main.messages[0])).not.toContain("<recent-context>");

        const side = f.draft();
        side.messages.push({
            role: "user",
            content: [{ type: "text", text: "side question beyond the window ".repeat(40000) }],
        });
        const generating = f.hooks.get("generate")!(side);
        await generating.then(
            () => {
                expect(JSON.stringify(side.messages[0])).not.toContain("<recent-context>");
                expect(estimateTokens(JSON.stringify(side.messages))).toBeGreaterThan(32000);
            },
            () => {},
        );
        await expect(generating).rejects.toThrow("Context full");
    } finally {
        await f.close();
    }
});

test("generate refuses an oversized checkpoint without a recent-context block or replay", async () => {
    const f = await fixture();
    const logs = spyOn(logger, "sessionLog");
    try {
        const side = f.draft();
        side.messages[0]!.content[0]!.text =
            `<conversation-checkpoint><summary>${"checkpoint summary ".repeat(40000)}</summary></conversation-checkpoint>`;
        await expect(f.hooks.get("generate")!(side)).rejects.toThrow("Context full");
        expect(
            logs.mock.calls.some(([, message]) => message.includes("arm=checkpoint-over-window")),
        ).toBe(true);
    } finally {
        logs.mockRestore();
        await f.close();
    }
});
