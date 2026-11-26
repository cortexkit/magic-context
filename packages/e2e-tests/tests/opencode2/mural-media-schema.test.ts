import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { openTestDb } from "../../src/test-db";
import {
    inspectOpenFiles,
    isolation,
    spawnOpencode2,
    waitForPluginActive,
    waitForPluginLog,
} from "../../src/opencode2-runner/spawn";
import { cleanupE2ETempDir } from "../../src/temp-dir";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function until(check: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        if (check()) return;
        await Bun.sleep(100);
    }
    throw new Error(`timed out waiting for ${label}`);
}

test("the first real turn caches image input for a project-local model", async () => {
    const fixture = isolation();
    fixture.env.OPENCODE_DISABLE_MODELS_FETCH = "1";
    const modelIDs = ["mock-model", "other-vision-model"];
    let host: Awaited<ReturnType<typeof spawnOpencode2>> | undefined;
    try {
        host = await spawnOpencode2({
            existingIsolation: fixture,
            visionModel: true,
            additionalModelIDs: modelIDs.slice(1),
            modelContextLimit: 200_000,
            modelInputLimit: 150_000,
            modelOutputLimit: 8192,
            compactionAuto: false,
            magicContextConfig: {
                historian: { disable: true },
                dreamer: { disable: true },
                mural: { enabled: true },
                compaction: { enabled: false },
            },
        });
        const client = OpenCode.make({ baseUrl: host.url,
            headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` } });
        const session = await client.session.create({ location: { directory: fixture.cwd },
            model: { providerID: "openai", id: "mock-model" } });
        await waitForPluginActive(client, fixture.cwd);
        const warm = "models-dev-cache: API layer loaded";
        expect(await waitForPluginLog(fixture.env, warm, 15_000)).toContain(warm);

        const cache = join(fixture.env.MAGIC_CONTEXT_STORAGE_DIR!, "model-context-limits-opencode2.json");
        const models = () => {
            const limits = JSON.parse(readFileSync(cache, "utf8"));
            return Object.fromEntries(modelIDs.map((id) => [id, limits[`openai/${id}`]]));
        };
        const before = models();
        expect(before).toEqual({ "mock-model": undefined, "other-vision-model": undefined });
        const catalog = await client.model.list({ location: { directory: fixture.cwd } });
        for (const id of modelIDs) {
            const model = catalog.data.find((row) => row.providerID === "openai" && row.id === id);
            expect(model?.capabilities.input).toContain("image");
        }

        await client.session.prompt({ sessionID: session.id, text: "First vision-model turn" });
        await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(30_000) });
        const usage = "v2 usage: inputTokens=";
        expect(await waitForPluginLog(fixture.env, usage, 15_000)).toContain(usage);
        expect(host.mock.requests().some(({ body }) => JSON.stringify(body).includes("First vision-model turn"))).toBe(true);

        const pid = host.pid!;
        const dbPaths = [...new Set(inspectOpenFiles(pid, fixture.root, fixture.env)
            .filter((path) => /\.db(?:-wal|-shm)?$/.test(path)))].sort();
        expect(dbPaths).toContain(join(fixture.env.XDG_DATA_HOME!, "opencode", fixture.env.OPENCODE_DB!));
        expect(dbPaths).toContain(join(fixture.env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db"));
        console.log(`lsof -p ${pid} (DB handles): ${JSON.stringify(dbPaths)}`);

        const after = models();
        console.log(`Project-local models in startup cache: ${Object.values(before).filter(Boolean).length}; after usage: ${JSON.stringify(after)}`);
        const expected = { limit: 200_000, contextLimit: 200_000, inputLimit: 150_000, outputLimit: 8192, vision: true };
        expect(after).toEqual({ "mock-model": expected, "other-vision-model": expected });
    } finally {
        try { await host?.stop(); } finally { cleanupE2ETempDir(fixture.root); }
    }
}, 180_000);

test("a persisted project mural reaches the vision-capable host as Media on priced and cached passes", async () => {
    const fixture = isolation();
    fixture.env.MAGIC_CONTEXT_LOG_PATH = join(fixture.root, "mural-transform.log");
    const options = {
        existingIsolation: fixture,
        defaultModelID: "gpt-4o",
        visionModel: true,
        modelContextLimit: 100_000,
        modelOutputLimit: 1024,
        compactionAuto: false,
        mockResponse: { text: "ok", usage: { input_tokens: 1000, output_tokens: 20 } },
        magicContextConfig: { historian: { disable: true }, dreamer: { disable: true },
            memory: { enabled: true }, mural: { enabled: true } },
    };
    let host: Awaited<ReturnType<typeof spawnOpencode2>> | undefined;
    try {
        host = await spawnOpencode2(options);
        let client = OpenCode.make({ baseUrl: host.url,
            headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` } });
        const session = await client.session.create({ location: { directory: fixture.cwd },
            model: { providerID: "openai", id: "gpt-4o" } });
        await waitForPluginActive(client, fixture.cwd);
        await client.session.prompt({ sessionID: session.id, text: "start the mural project" });
        await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(30_000) });
        await host.stopHost();
        host = undefined;
        const contextPath = join(fixture.env.XDG_DATA_HOME!, "cortexkit", "magic-context", "context.db");
        const db = openTestDb(contextPath);
        try {
            const metadata = db.prepare("SELECT cached_m0_upgrade_state AS upgrade FROM session_meta WHERE session_id = ?")
                .get(session.id) as { upgrade: string | null } | undefined;
            if (!metadata?.upgrade) throw new Error("mural session did not persist initial m0 fold");
            db.prepare(`INSERT OR REPLACE INTO mural_manifest
                (project_path, image, content_hash, rendered_at, memory_ids_json, width, height)
                VALUES (?, ?, ?, ?, '[]', 1, 1)`)
                .run(fixture.cwd, Buffer.from(png, "base64"), "fixture-mural-hash", Date.now());
            db.prepare("UPDATE session_meta SET cached_m0_mural_data_url = ?, cached_m0_mural_hash = ? WHERE session_id = ?")
                .run(`data:image/png;base64,${png}`, "fixture-mural-hash", session.id);
        } finally { db.close(); }
        host = await spawnOpencode2(options);
        client = OpenCode.make({ baseUrl: host.url,
            headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` } });
        await waitForPluginActive(client, fixture.cwd);
        await client.session.prompt({ sessionID: session.id, text: "read the persisted mural" });
        await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(30_000) });
        await client.session.prompt({ sessionID: session.id, text: "reuse the mural" });
        await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(30_000) });
        const muralRequests = () => host!.mock.requests().filter((request) => {
            const body = JSON.stringify(request.body);
            return body.includes('"model":"gpt-4o"') && body.includes(png);
        });
        await until(() => muralRequests().length >= 2, "project mural on priced and cached provider requests");
        const schemaTrace = readFileSync(join(fixture.root, "llm-schema-guard.jsonl"), "utf8");
        expect(schemaTrace.split("\n").filter((line) => line.startsWith(`PASS ${session.id} `)).length)
            .toBeGreaterThanOrEqual(3);
    } finally { if (host) await host.stopHost(); }
}, 180_000);
