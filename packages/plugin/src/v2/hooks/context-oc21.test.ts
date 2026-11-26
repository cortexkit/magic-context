import { expect, mock, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configLoader from "../../config";
import { MagicContextConfigSchema } from "../../config/schema/magic-context";
import { directoryFallback } from "../../features/magic-context/memory/project-identity";
import { recordSessionProjectIdentity } from "../../features/magic-context/session-project-storage";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage-db";
import { resetCtxReduceRegisteredGloballyForTest } from "../../hooks/magic-context/ctx-reduce-availability";
import { estimateFinalWireInputTokens } from "../../hooks/magic-context/final-wire-token-estimate";
import { resetLkgSlotsForTest } from "../../hooks/magic-context/lkg-slot";
import { estimateTokens } from "../../hooks/magic-context/read-session-formatting";
import { buildStatusDetail } from "../../plugin/rpc-handlers";
import { drainNotifications, registerNotificationSink } from "../../shared/rpc-notifications";
import { Database } from "../../shared/sqlite";
import { buildStatusViewFor } from "../../shared/status-view";
import { checkLocalStatusSource } from "../../shared/status-view-check";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { nativeFoldCache } from "../fold/memory-cache";
import {
    isAdmittedLocalCheckpoint,
    isLocalCheckpoint,
    NativeFoldReplay,
} from "../fold/native-replay";
import { FoldOwner } from "../fold/owner";
import type { StoreRow } from "../store-reader";
import * as readerModule from "../store-reader";
import { sidebarText, statusText } from "../tui";
import { registerContext } from "./context";
import { adaptPayload } from "./payload";
import * as storageGate from "./storage-gate";
import type { SessionContext, V2Context, V2Message } from "./types";

const model = { providerID: "p", id: "m", limit: { context: 200000 } };
const user = (id: string): V2Message => ({
    id,
    role: "user",
    content: [{ type: "text", text: id }],
});
const cut = (extra = {}): StoreRow<"compaction"> => ({
    id: "cut",
    session_id: "s",
    type: "compaction",
    seq: 5,
    data: { status: "completed", summary: "summary", ...extra },
});

async function fixture(checkpoint: StoreRow<"compaction">) {
    const parent = join(tmpdir(), "magic-context", "oc21b");
    mkdirSync(parent, { recursive: true });
    const dir = createTestTempDirFromPath(join(parent, "checkpoint-unit-"));
    const db = openDatabase(join(dir, "context.db"));
    if (!db) throw new Error("private fixture could not open");
    const source = new Database(join(dir, "opencode.db"));
    source.exec(`CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT,
        seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT)`);
    const insert = source.prepare("INSERT INTO session_message VALUES (?, 's', ?, ?, 100, 100, ?)");
    for (const [id, type, seq, data] of [
        ["u1", "user", 1, { text: "u1" }],
        ["a2", "assistant", 2, { model, content: [{ type: "text", text: "a2" }] }],
        ["u3", "user", 3, { text: "u3" }],
        ["a4", "assistant", 4, { model, content: [{ type: "text", text: "a4" }] }],
        ["cut", "compaction", 5, checkpoint.data],
        ["tail", "user", 6, { text: "tail" }],
    ] as const)
        insert.run(id, type, seq, JSON.stringify(data));
    const config = MagicContextConfigSchema.parse({
        historian: { disable: true },
        dreamer: { disable: true },
        memory: { enabled: false },
        cache_ttl: "never",
        subc: { connection_file: join(dir, "run", "subc-connection.json") },
    });
    const load = spyOn(configLoader, "loadPluginConfigDetailed").mockReturnValue({
        config,
    } as ReturnType<typeof configLoader.loadPluginConfigDetailed>);
    const gate = spyOn(storageGate, "createV2StorageGate").mockReturnValue({
        current: () => db,
        require: () => db,
        probe: async () => db,
        reason: () => null,
    });
    const path = spyOn(readerModule, "gaDatabasePath").mockReturnValue(join(dir, "opencode.db"));
    const restore = spyOn(NativeFoldReplay.prototype, "restore");
    const interrupt = mock(async () => ({ interrupted: true }));
    const synthetic = mock(async ({ id, text }: { id: string; text: string }) => {
        insert.run(id, "synthetic", 7, JSON.stringify({ text }));
    });
    let hook: (draft: SessionContext) => Promise<void>;
    let compaction: (draft: SessionContext) => Promise<void>;
    let servedDraft: SessionContext | undefined;
    const storage = new Map<string, unknown>();
    const hostStorage = {
        get: async (key: string) => storage.get(key),
        set: async (key: string, value: unknown) => {
            storage.set(key, value);
        },
    };
    const legacyOwner = new FoldOwner(hostStorage);
    resetLkgSlotsForTest();
    const duties = await registerContext({
        location: { directory: dir },
        agent: { transform: async () => {}, reload: async () => {} },
        model: { list: () => [] },
        storage: hostStorage,
        event: { subscribe: async function* () {} },
        tool: { hook: async () => {} },
        session: {
            remove: async () => {},
            compact: async () => {},
            wait: async () => {},
            interrupt,
            synthetic,
            hook: async (name: string, callback: typeof hook) => {
                if (name === "context") hook = callback;
                if (name === "compaction") compaction = callback;
            },
            get: async () => ({ location: { directory: dir } }),
        },
    } as unknown as V2Context);
    return {
        db,
        directory: dir,
        source,
        restore,
        interrupt,
        synthetic,
        reader: () => new readerModule.V2StoreReader(join(dir, "opencode.db")),
        async seedLegacy(row = checkpoint, recent?: string) {
            source
                .prepare("UPDATE session_message SET data=? WHERE id=?")
                .run(JSON.stringify({ ...row.data, status: "running" }), row.id);
            const unavailable = spyOn(NativeFoldReplay.prototype, "supply").mockResolvedValue(
                false,
            );
            const draft: SessionContext = {
                sessionID: "s",
                model,
                agent: "build",
                system: [],
                tools: {},
                options: {},
                messages: [],
            };
            try {
                // Exercise the registered legacy fallback writer, including its
                // materialization and serialization, rather than inventing KV bytes.
                await compaction(draft);
            } finally {
                unavailable.mockRestore();
            }
            if (!draft.result) throw new Error("legacy compaction did not supply a summary");
            row.data = {
                ...row.data,
                status: "completed",
                summary: draft.result.summary,
                ...(recent === undefined ? {} : { recent }),
            };
            source
                .prepare("UPDATE session_message SET data=? WHERE id=?")
                .run(JSON.stringify(row.data), row.id);
            const rendered: V2Message = {
                id: row.id,
                role: "user",
                metadata: row.data.metadata,
                content: [
                    {
                        type: "text",
                        text: `<conversation-checkpoint>\n<summary>\n${draft.result.summary}\n</summary>${recent === undefined ? "" : `\n<recent-context>${recent}</recent-context>`}\n</conversation-checkpoint>`,
                    },
                ],
            };
            await legacyOwner.observe({
                sessionID: "s",
                cutSeq: row.seq,
                summary: draft.result.summary,
                rendered,
                onHard: (reason) => {
                    throw new Error(`legacy writer seed diverged: ${reason}`);
                },
            });
            return rendered;
        },
        async legacyBytes() {
            return JSON.stringify(await legacyOwner.read("s"));
        },
        currentDraft() {
            if (!servedDraft) throw new Error("no context request has been served");
            return servedDraft;
        },
        async run(messages: V2Message[], target = model) {
            const draft: SessionContext = {
                sessionID: "s",
                model: target,
                agent: "build",
                system: [],
                tools: {},
                options: {},
                messages,
            };
            await hook(draft);
            servedDraft = draft;
            return draft.messages;
        },
        async close() {
            await duties?.dispose();
            restore.mockRestore();
            load.mockRestore();
            gate.mockRestore();
            path.mockRestore();
            source.close();
            closeDatabase();
            resetLkgSlotsForTest();
            resetCtxReduceRegisteredGloballyForTest();
            cleanupTestTempDir(dir);
        },
    };
}

test("keeps a project change off the OpenCode 2 wire and transcript while showing it in status", async () => {
    const run = async (mode: "unchanged" | "empty" | "left memories") => {
        const f = await fixture(cut());
        const toasts: string[] = [];
        const unregister = registerNotificationSink({
            protocol: 2,
            sessionId: "s",
            send: ({ type, payload }) => {
                if (
                    type === "toast" &&
                    typeof payload.message === "string" &&
                    payload.message.includes("changed projects")
                )
                    toasts.push(payload.message);
            },
        });
        const from = directoryFallback(join(f.directory, "former project"));
        const to = directoryFallback(f.directory);
        try {
            f.source.prepare("DELETE FROM session_message WHERE type = 'compaction'").run();
            recordSessionProjectIdentity(f.db, "s", mode === "unchanged" ? to : from);
            if (mode === "left memories") {
                f.db
                    .prepare(
                        "INSERT INTO memories(project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES (?, 'fact', 'old project fact', 'hash', 1, 1, 1, 1)",
                    )
                    .run(from);
            }
            const before = f.source.prepare("SELECT * FROM session_message ORDER BY seq").all();
            await f.run([user("tail")]);
            // Yield so an asynchronous attempt to append a notice would already be recorded.
            await Bun.sleep(0);
            expect(f.synthetic).not.toHaveBeenCalled();
            expect(f.source.prepare("SELECT * FROM session_message ORDER BY seq").all()).toEqual(
                before,
            );

            const guidance = `Review the merge first:\nnpx @cortexkit/magic-context@latest doctor merge-identities --from ${from} --to ${to}\nIt shows what would move. Add --apply to move them.`;
            const detail = buildStatusDetail(f.db, "s", f.directory);
            const status = buildStatusViewFor(checkLocalStatusSource(detail), { version: "test" });
            const warnings = status.warnings.filter(({ text }) =>
                text.includes("previous project"),
            );
            if (mode === "left memories") {
                expect(warnings).toEqual([
                    {
                        text: `1 memory stayed under this session's previous project. Nothing was moved.\n${guidance}`,
                        tone: "warning",
                    },
                ]);
                expect(toasts).toHaveLength(1);
                expect(toasts[0]).toContain(guidance);
                expect(sidebarText(detail)).toContain(guidance);
                expect(statusText(detail)).toContain(guidance);
            } else {
                expect(warnings).toEqual([]);
                expect(toasts).toEqual([]);
            }
            expect(
                drainNotifications(0, "s", { sessionOnly: true }).filter(
                    ({ type, payload }) =>
                        type === "toast" && String(payload.message).includes("changed projects"),
                ),
            ).toEqual([]);

            await f.run([user("tail"), user("next-turn")]);
            expect(toasts).toHaveLength(mode === "left memories" ? 1 : 0);
            expect(buildStatusDetail(f.db, "s", f.directory).projectBindingWarning).toBe(
                detail.projectBindingWarning,
            );
            const { messages, system, tools, options } = f.currentDraft();
            return JSON.stringify({ messages, system, tools, options });
        } finally {
            unregister();
            await f.close();
        }
    };

    const unchanged = await run("unchanged");
    expect(await run("left memories")).toBe(unchanged);
    expect(await run("empty")).toBe(unchanged);
});

test("provider windows stay host-owned and invisible replay requires a valid local admission", async () => {
    for (const data of [{ providerContext: { messages: [] } }, { native: { messages: [] } }]) {
        const checkpoint = cut(data);
        expect(isLocalCheckpoint(checkpoint)).toBe(false);
        const f = await fixture(checkpoint);
        try {
            for (const target of [
                model,
                { ...model, id: "changed" },
                { ...model, providerID: "changed" },
                model,
            ]) {
                // The final case represents an endpoint-only change: provider and model
                // ids are unchanged. Endpoint provenance is not a replay identity.
                const messages = await f.run([user("host-window"), user("tail")], target);
                expect(messages.some((m) => m.id === "host-window")).toBe(true);
                expect(messages.some((m) => m.id === "u1")).toBe(false);
                expect(f.restore).not.toHaveBeenCalled();
            }
            expect(f.interrupt).not.toHaveBeenCalled();
        } finally {
            await f.close();
        }
    }
    const f = await fixture(cut());
    try {
        const cache = nativeFoldCache(f.db);
        const checkpoint = cut();
        const payload = {
            source: cache.sourceID,
            sessionID: "s",
            admissionID: "cut",
            summary: "summary",
        };
        const valid = () => isAdmittedLocalCheckpoint(cache, "s", checkpoint);
        expect(valid()).toBe(false);
        for (const patch of [
            { source: "foreign" },
            { sessionID: "foreign" },
            { admissionID: "foreign" },
            { summary: "edited" },
        ]) {
            await cache.supply("s", "cut", JSON.stringify({ ...payload, ...patch }));
            expect(valid()).toBe(false);
        }
        await cache.supply("s", "cut", JSON.stringify(payload));
        expect(valid()).toBe(true);
        const admission = spyOn(cache, "admission").mockReturnValue({
            ...cache.admission("s", "cut")!,
            digest: "corrupt",
        });
        expect(valid()).toBe(false);
        admission.mockRestore();
        expect(isAdmittedLocalCheckpoint(nativeFoldCache(f.db), "s", checkpoint)).toBe(false);
        // Without a valid local admission, imported checkpoints, restarts, edits
        // and reverts must keep the host checkpoint rather than use the native-fold cache.
        for (const summary of ["summary", "edited", "reverted"]) {
            const messages = await f.run([
                { id: "cut", role: "user", content: [{ type: "text", text: summary }] },
                user("tail"),
            ]);
            expect(messages.some((m) => m.id === "u1")).toBe(true);
        }
        expect(f.restore).not.toHaveBeenCalled();
        const durable = new Map<string, unknown>();
        const provenance = {
            get: async (key: string) => durable.get(key),
            set: async (key: string, value: unknown) => {
                durable.set(key, value);
            },
        } as V2Context["storage"];
        const memory = nativeFoldCache(f.db);
        await memory.saveTail(
            "s",
            JSON.stringify({ model: "p/m", sourceSeq: -1, baseline: "summary" }),
            [],
        );
        f.source
            .prepare("UPDATE session_message SET data = ? WHERE id = 'cut'")
            .run(JSON.stringify({ status: "running" }));
        const reader = f.reader();
        try {
            const first = new NativeFoldReplay(memory, f.reader, provenance);
            await first.observeSource("s", reader);
            expect(
                await first.supply({
                    draft: { sessionID: "s", model } as SessionContext,
                    reader,
                    summary: "summary",
                }),
            ).toBe(true);
            expect(await first.admits("s", checkpoint, reader)).toBe(true);
            const restart = new NativeFoldReplay(nativeFoldCache(f.db), f.reader, provenance);
            expect(await restart.admits("s", checkpoint, reader)).toBe(true);
            expect(await restart.admits("s", cut({ summary: "edited" }), reader)).toBe(false);
            const imported = new NativeFoldReplay(nativeFoldCache(f.db), f.reader, provenance);
            expect(
                await imported.admits("s", checkpoint, {
                    hostIdentity: () => "other-store",
                } as readerModule.V2StoreReader),
            ).toBe(false);
            expect(JSON.stringify([...durable.values()])).not.toContain("u1");
            await first.forget("s");
            expect(await imported.admits("s", checkpoint, reader)).toBe(false);
        } finally {
            reader.close();
        }
    } finally {
        await f.close();
    }
}, 60_000);

test("keepID and legacy recent checkpoints restore missing rows before the host-kept tail exactly once", async () => {
    for (const metadata of [{ keepID: "u3" }, { recent: "u3 and a4" }]) {
        const f = await fixture(cut({ metadata }));
        try {
            const incoming = await f.seedLegacy();
            const input = [
                incoming,
                user("u3"),
                { id: "a4", role: "assistant", content: [{ type: "text", text: "a4" }] },
                user("tail"),
            ];
            const messages = await f.run(structuredClone(input));
            expect(
                messages
                    .map((m) => m.id)
                    .filter((id) => ["u1", "a2", "u3", "a4", "tail", "cut"].includes(id!)),
            ).toEqual(["cut", "u1", "a2", "u3", "a4", "tail"]);
            expect(messages.find((m) => m.id === "cut")?.metadata).toEqual(metadata);
            expect(f.interrupt).not.toHaveBeenCalled();
            const served = JSON.stringify(messages);
            const persisted = await f.legacyBytes();
            for (let pass = 0; pass < 2; pass++) {
                expect(JSON.stringify(await f.run(structuredClone(input)))).toBe(served);
                expect(await f.legacyBytes()).toBe(persisted);
            }
        } finally {
            await f.close();
        }
    }
}, 60_000);

function requestEstimate(draft: SessionContext): number {
    const toolDefinitionTokens = Object.values(draft.tools).reduce(
        (sum, tool) =>
            sum + estimateTokens(tool.description) + estimateTokens(JSON.stringify(tool.input)),
        0,
    );
    return estimateFinalWireInputTokens({
        messages: adaptPayload(draft, new Set()).messages,
        toolDefinitionTokens,
        systemPromptTokens: estimateTokens(JSON.stringify(draft.system)),
        providerID: draft.model.providerID,
        modelID: draft.model.id,
        agentName: draft.agent,
    }).tokens;
}

const oversizedRecent = "raw1 raw2 raw3 raw4 ".repeat(100_000);
const unknownCheckpoint = (): V2Message => ({
    id: "cut",
    role: "user",
    content: [
        {
            type: "text",
            text: `<conversation-checkpoint>\n<summary>\nsummary\n</summary>\n<recent-context>${oversizedRecent}</recent-context>\n</conversation-checkpoint>`,
        },
    ],
});

test("a nonmatching legacy record stays unchanged and cannot adopt an oversized current wrapper", async () => {
    const f = await fixture(cut());
    try {
        // Reverting removes a newer host checkpoint, but its plugin KV record
        // can remain. Produce that record through the real legacy writer first.
        const previous = { ...cut(), id: "old-cut", seq: 99 };
        f.source
            .prepare("INSERT INTO session_message VALUES (?, 's', 'compaction', ?, 100, 100, ?)")
            .run(previous.id, previous.seq, JSON.stringify(previous.data));
        await f.seedLegacy(previous, oversizedRecent);
        f.source.prepare("DELETE FROM session_message WHERE id=?").run(previous.id);
        const persisted = await f.legacyBytes();
        expect(estimateTokens(oversizedRecent)).toBeGreaterThan(model.limit.context);
        for (let pass = 0; pass < 3; pass++) {
            const messages = await f.run([unknownCheckpoint(), user("tail")]);
            expect(
                messages.some((message) => message.id === "cut" || message.id === "old-cut"),
            ).toBe(false);
            expect(JSON.stringify(messages)).not.toContain("<recent-context>");
            expect(await f.legacyBytes()).toBe(persisted);
            expect(requestEstimate(f.currentDraft())).toBeLessThan(model.limit.context);
            expect(Buffer.byteLength(JSON.stringify(f.currentDraft()))).toBeLessThan(50_000);
        }
        expect(f.interrupt).not.toHaveBeenCalled();
    } finally {
        await f.close();
    }
}, 60_000);

test("a fresh unadmitted checkpoint does not adopt recent-context on the default path", async () => {
    const f = await fixture(cut());
    try {
        expect(await f.legacyBytes()).toBeUndefined();
        expect(estimateTokens(oversizedRecent)).toBeGreaterThan(model.limit.context);
        const messages = await f.run([unknownCheckpoint(), user("tail")]);
        expect(
            messages
                .filter((message) => ["u1", "a2", "u3", "a4", "tail"].includes(message.id!))
                .map((message) => message.id),
        ).toEqual(["u1", "a2", "u3", "a4", "tail"]);
        expect(messages.some((message) => message.id === "cut")).toBe(false);
        expect(JSON.stringify(messages)).not.toContain("<recent-context>");
        expect(await f.legacyBytes()).toBeUndefined();
        expect(requestEstimate(f.currentDraft())).toBeLessThan(model.limit.context);
        expect(Buffer.byteLength(JSON.stringify(f.currentDraft()))).toBeLessThan(50_000);
        expect(f.interrupt).not.toHaveBeenCalled();
    } finally {
        await f.close();
    }
}, 60_000);
