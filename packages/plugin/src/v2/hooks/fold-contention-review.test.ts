import { expect, mock, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configLoader from "../../config";
import { MagicContextConfigSchema } from "../../config/schema/magic-context";
import {
    type FakeSubcDaemon,
    fakeFleetResponder,
    startFakeSubcDaemon,
} from "../../features/magic-context/checkout-claim-fake-subc.test-support";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage-db";
import { resetCtxReduceRegisteredGloballyForTest } from "../../hooks/magic-context/ctx-reduce-availability";
import { resetLkgSlotsForTest } from "../../hooks/magic-context/lkg-slot";
import { Database } from "../../shared/sqlite";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { NativeFoldReplay } from "../fold/native-replay";
import { HEAD_IDS } from "../hooks/payload";
import * as readerModule from "../store-reader";
import { registerContext } from "./context";
import * as storageGate from "./storage-gate";
import type { SessionContext, V2Context } from "./types";

test("re-review: a busy fold capture after successful transform never interrupts that turn", async () => {
    const parent = join(tmpdir(), "magic-context", "bg_dc7e65375fa3cfb1");
    mkdirSync(parent, { recursive: true });
    const dir = createTestTempDirFromPath(join(parent, "fold-context-"));
    const db = openDatabase(join(dir, "context.db"));
    if (!db) throw new Error("private context fixture could not open");
    const source = new Database(join(dir, "opencode.db"));
    source.exec(`CREATE TABLE session_message (
        id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
        time_created INTEGER, time_updated INTEGER, data TEXT
    ); INSERT INTO session_message VALUES ('u1','s','user',1,100,100,'{"text":"hello"}')`);
    const blocker = new Database(join(dir, "context.db"));
    const config = MagicContextConfigSchema.parse({
        historian: { disable: true },
        dreamer: { disable: true },
        memory: { enabled: false },
        cache_ttl: "never",
        subc: { connection_file: join(dir, "run", "subc-connection.json") },
    });
    let daemon: FakeSubcDaemon | undefined;
    let duties: Awaited<ReturnType<typeof registerContext>>;
    const oldFlag = process.env.MC_OC2_INVISIBLE_FOLD;
    process.env.MC_OC2_INVISIBLE_FOLD = "1";
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
    const interrupt = mock(async () => ({ interrupted: true }));
    let hook: ((draft: SessionContext) => Promise<void>) | undefined;
    let captureReached = false;
    let servedBeforeCapture = false;
    const capture = NativeFoldReplay.prototype.capture;
    const lockAtCapture = spyOn(NativeFoldReplay.prototype, "capture").mockImplementation(
        async function (this: NativeFoldReplay, draft, native) {
            captureReached = true;
            servedBeforeCapture = draft.messages.some((message) => message.id === HEAD_IDS[0]);
            // `blocker` is a second SQLite connection to context.db. It takes the
            // write lock only once capture is reached, after the synthetic-message
            // admission check and the context transform (with its last-known-good
            // request snapshot) have run unblocked. Only the optional fold-cache
            // capture and the steps after it run while that lock is held.
            blocker.exec("BEGIN IMMEDIATE");
            return capture.call(this, draft, native);
        },
    );
    try {
        resetLkgSlotsForTest();
        daemon = await startFakeSubcDaemon(
            join(dir, "run", "subc-connection.json"),
            fakeFleetResponder({ agents: {}, claims: {} }),
        );
        const context = {
            location: { directory: dir },
            agent: { transform: async () => {}, reload: async () => {} },
            model: { list: () => [] },
            storage: { get: async () => undefined, set: async () => {} },
            event: { subscribe: async function* () {} },
            tool: { hook: async () => {} },
            session: {
                remove: async () => {},
                compact: async () => {},
                wait: async () => {},
                interrupt,
                hook: async (name: string, callback: (draft: SessionContext) => Promise<void>) => {
                    if (name === "context") hook = callback;
                },
                get: async () => ({ location: { directory: dir } }),
            },
        } as unknown as V2Context;
        duties = await registerContext(context);
        const draft: SessionContext = {
            sessionID: "s",
            model: { providerID: "p", id: "m", limit: { context: 200000 } },
            agent: "build",
            system: [],
            tools: {},
            options: {},
            messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hello" }] }],
        };
        const failure = await hook!(draft).then(
            () => null,
            (error: unknown) => error,
        );
        expect(captureReached).toBe(true);
        expect(servedBeforeCapture).toBe(true);
        expect({ failure, interrupts: interrupt.mock.calls.length }).toEqual({
            failure: null,
            interrupts: 0,
        });
    } finally {
        if (captureReached) blocker.exec("ROLLBACK");
        lockAtCapture.mockRestore();
        await duties?.dispose();
        await daemon?.close();
        load.mockRestore();
        gate.mockRestore();
        path.mockRestore();
        if (oldFlag === undefined) delete process.env.MC_OC2_INVISIBLE_FOLD;
        else process.env.MC_OC2_INVISIBLE_FOLD = oldFlag;
        blocker.close();
        source.close();
        closeDatabase();
        resetLkgSlotsForTest();
        resetCtxReduceRegisteredGloballyForTest();
        cleanupTestTempDir(dir);
    }
}, 40_000);
