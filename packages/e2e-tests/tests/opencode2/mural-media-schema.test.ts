import { openTestDb } from "../../src/test-db";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { isolation, spawnOpencode2, waitForPluginActive } from "../../src/opencode2-runner/spawn";
import { sessionMetaFieldSelect, writeSessionMetaField } from "../../src/session-meta-fields";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function until(check: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        if (check()) return;
        await Bun.sleep(100);
    }
    throw new Error(`timed out waiting for ${label}`);
}

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
            const metadata = db.prepare(`SELECT ${sessionMetaFieldSelect("cached_m0_upgrade_state", "upgrade")} FROM session_meta WHERE session_id = ?`)
                .get(session.id) as { upgrade: string | null } | undefined;
            if (!metadata?.upgrade) throw new Error("mural session did not persist initial m0 fold");
            db.prepare(`INSERT OR REPLACE INTO mural_manifest
                (project_path, image, content_hash, rendered_at, memory_ids_json, width, height)
                VALUES (?, ?, ?, ?, '[]', 1, 1)`)
                .run(fixture.cwd, Buffer.from(png, "base64"), "fixture-mural-hash", Date.now());
            writeSessionMetaField(db, session.id, "cached_m0_mural_data_url", `data:image/png;base64,${png}`);
            db.prepare("UPDATE session_meta SET cached_m0_mural_hash = ? WHERE session_id = ?")
                .run("fixture-mural-hash", session.id);
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
