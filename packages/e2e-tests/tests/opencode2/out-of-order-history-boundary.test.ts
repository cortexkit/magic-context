import { openTestDb } from "../../src/test-db";
import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { appendCompartments } from "../../../plugin/src/features/magic-context/compartment-storage";
import { estimateTokens } from "../../../plugin/src/hooks/magic-context/read-session-formatting";
import { Database } from "../../../plugin/src/shared/sqlite";
import { RAW_MESSAGE_TYPES } from "../../../plugin/src/v2/store-reader";
import { inspectHostOpenFiles } from "../../src/host-open-files";
import { isolation, spawnOpencode2, waitForPluginActive } from "../../src/opencode2-runner/spawn";

// Moving a session or deleting unrelated rows need not hide its summary boundary.
// An earlier context hook removes the summary's end message from the array handed
// to Magic Context, not from SQLite. Older messages remain in that array. OpenCode
// still performs the move, persists ordering, and sends provider requests.
function windowProbe(root: string, omitted: string): string {
    const plugin = join(root, "window-probe");
    mkdirSync(plugin);
    writeFileSync(join(plugin, "server.js"), `import { existsSync, readFileSync, appendFileSync } from 'node:fs';
export default { id: 'stored-boundary-window', async setup(context) {
    await context.session.hook('context', draft => {
        if (!existsSync(${JSON.stringify(omitted)})) return;
        const id = readFileSync(${JSON.stringify(omitted)}, 'utf8');
        const index = draft.messages.findIndex(m => m.id === id);
        appendFileSync(${JSON.stringify(join(root, "windows.jsonl"))}, JSON.stringify({ session: draft.sessionID, boundary: id, index, ids: draft.messages.map(m => m.id) }) + '\\n');
        if (index >= 0) draft.messages.splice(index, 1);
    });
}};`);
    return plugin;
}

const CONFIG = { memory: { enabled: false }, dreamer: { disable: true }, historian: { disable: true } };
const SMALL_WINDOW = 20_000;
const tokens = (body: Record<string, unknown>) => estimateTokens(JSON.stringify({
    input: body.input ?? body.messages, instructions: body.instructions ?? body.system, tools: body.tools,
}));
type Row = { id: string; type: string; seq: number };

function rows(path: string, sessionId: string): Row[] {
    const db = new Database(path, { readonly: true });
    try { return db.prepare("SELECT id, type, seq FROM session_message WHERE session_id=? ORDER BY seq").all(sessionId) as Row[]; }
    finally { db.close(); }
}

function recordDatabases(pid: number, root: string): void {
    const paths = inspectHostOpenFiles(pid, root, join(root, "XDG_DATA_HOME", "opencode", "opencode2.db")).databases;
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(path.startsWith(`${root}/`)).toBe(true);
    console.log(`ISOLATION pid=${pid} databases=${JSON.stringify(paths)}`);
}

for (const operation of ["session_move", "offline row deletion"] as const) {
    test(`OpenCode 2 present out-of-order boundary after ${operation} trims on every replay without oversized wire`, async () => {
        const fixture = isolation();
        const omitted = join(fixture.root, "omitted-boundary");
        const probe = windowProbe(fixture.root, omitted);
        const destination = join(fixture.root, "destination");
        mkdirSync(destination);
        let host = await spawnOpencode2({ existingIsolation: fixture, prePlugin: probe, compactionAuto: false,
            modelContextLimit: 60_000, modelOutputLimit: 1024, magicContextConfig: CONFIG });
        const mock = host.mock;
        const mockBaseURL = host.mockBaseURL;
        const clientFor = () => OpenCode.make({ baseUrl: host.url, headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` } });
        let client = clientFor();
        const session = await client.session.create({ location: { directory: fixture.cwd }, model: { providerID: "openai", id: "mock-model" } });
        const store = join(fixture.env.XDG_DATA_HOME!, "opencode", fixture.env.OPENCODE_DB!);
        const context = join(fixture.env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db");
        const turn = async (text: string) => {
            await client.session.prompt({ sessionID: session.id, text });
            await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(60_000) });
        };
        try {
            await waitForPluginActive(client, fixture.cwd);
            recordDatabases(host.pid!, fixture.root);
            for (let index = 0; index < 3; index++) await turn(`COVERED-${index}: ${"durable history ".repeat(2500)}`);
            const before = rows(store, session.id);
            const raw = before.filter((row) => (RAW_MESSAGE_TYPES as readonly string[]).includes(row.type));
            const boundary = raw.at(-1)!;
            expect(boundary.type).toBe("assistant");
            await host.stopHost();
            const db = openTestDb(context, undefined, Database);
            try { appendCompartments(db, session.id, [{ sequence: 0, startMessage: 1, endMessage: raw.length,
                startMessageId: raw[0]!.id, endMessageId: boundary.id, title: "Recorded history", content: "Three older turns recorded durable history." }]); }
            finally { db.close(); }
            host = await spawnOpencode2({ existingIsolation: fixture, existingMock: { mock, baseURL: mockBaseURL }, prePlugin: probe,
                compactionAuto: false, modelContextLimit: 60_000, modelOutputLimit: 1024, magicContextConfig: CONFIG });
            client = clientFor();
            await client.session.command({ sessionID: session.id, name: "ctx-flush", text: "" });
            await turn("materialize the in-order baseline");
            if (operation === "session_move") {
                copyFileSync(join(fixture.cwd, "opencode.json"), join(destination, "opencode.json"));
                mock.enqueue({ openaiOutput: [{ type: "function_call", call_id: "move-session", name: "execute", arguments: JSON.stringify({
                    code: `await tools.opencode.session_move({ directory: ${JSON.stringify(destination)} });`,
                }) }], usage: { input_tokens: 100, output_tokens: 10 } });
                await turn("move the session to the destination directory");
                expect((await client.session.get({ sessionID: session.id })).location.directory).toBe(destination);
                const moved = rows(store, session.id);
                expect(moved.filter((row) => row.type === "location-switched")).toHaveLength(1);
                expect(moved.filter((row) => before.some((old) => old.id === row.id))).toEqual(before);
                // A real instruction change after the covered boundary is rendered
                // by the host as an ID-less system row in the next live window.
                writeFileSync(join(destination, "AGENTS.md"), "UNSUMMARIZED-MOVED-INSTRUCTION: never publish the private signing key.\n");
            }
            await host.stopHost();
            if (operation === "offline row deletion") {
                const db = new Database(store);
                try { db.prepare("DELETE FROM session_message WHERE session_id=? AND id=?").run(session.id, raw[1]!.id); }
                finally { db.close(); }
                const after = rows(store, session.id);
                expect(after.find((row) => row.id === boundary.id)).toEqual(boundary);
                expect(after.find((row) => row.id === raw[1]!.id)).toBeUndefined();
            }
            writeFileSync(omitted, boundary.id);
            const oversized: number[] = [];
            mock.addMatcher((body) => {
                const size = tokens(body);
                if (size <= SMALL_WINDOW) return null;
                oversized.push(size);
                return { error: { status: 400, type: "invalid_request_error", message: "fixture rejects oversized history" } };
            });
            host = await spawnOpencode2({ existingIsolation: fixture, existingMock: { mock, baseURL: mockBaseURL }, prePlugin: probe,
                compactionAuto: false, modelContextLimit: SMALL_WINDOW, modelOutputLimit: 1024, magicContextConfig: CONFIG });
            if (operation === "session_move") copyFileSync(join(fixture.cwd, "opencode.json"), join(destination, "opencode.json"));
            client = clientFor();
            const sizes: number[] = [];
            const heads: string[] = [];
            const instructions: string[] = [];
            for (let pass = 0; pass < 3; pass++) {
                const marker = `retained-tail-${operation}-${pass}`;
                const start = mock.requests().length;
                await turn(marker);
                const sent = mock.requests().slice(start).filter((request) => JSON.stringify(request.body).includes(marker));
                expect(sent).toHaveLength(1);
                sizes.push(tokens(sent[0]!.body));
                expect(sizes.at(-1)).toBeLessThan(SMALL_WINDOW);
                expect(JSON.stringify(sent[0]!.body)).not.toContain("COVERED-0");
                heads.push(JSON.stringify((sent[0]!.body.input as unknown[]).slice(0, 2)));
                if (operation === "session_move") {
                    const updates = (sent[0]!.body.input as unknown[]).map((item) => JSON.stringify(item))
                        .filter((item) => item.includes("UNSUMMARIZED-MOVED-INSTRUCTION"));
                    expect(updates).toHaveLength(1);
                    instructions.push(updates[0]!);
                }
            }
            expect(new Set(heads).size).toBe(1);
            if (operation === "session_move") {
                expect(new Set(instructions).size).toBe(1);
                const db = new Database(store, { readonly: true });
                try {
                    const updates = db.prepare("SELECT seq FROM session_message WHERE session_id=? AND type='system' AND data LIKE ?")
                        .all(session.id, "%UNSUMMARIZED-MOVED-INSTRUCTION%") as { seq: number }[];
                    expect(updates).toHaveLength(1);
                    expect(updates[0]!.seq).toBeGreaterThan(boundary.seq);
                } finally { db.close(); }
            }
            expect(oversized).toEqual([]);
            const windows = readFileSync(join(fixture.root, "windows.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
            expect(windows.some((window) => window.index > 0)).toBe(true);
            recordDatabases(host.pid!, fixture.root);
            console.log(`BOUNDARY operation=${operation} id=${boundary.id} seq=${boundary.seq} first=${before[0]!.id} sizes=${JSON.stringify(sizes)} oversized=${JSON.stringify(oversized)}`);
        } finally { await host.stop(); }
    }, 180_000);
}
