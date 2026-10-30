import { openTestDb } from "../src/test-db";
/// <reference types="bun-types" />

import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { buildMockHistorianPayload, findHistorianOrdinalRange } from "../src/mock-historian";
import { MockProvider } from "../src/mock-provider/server";
import { createIsolatedEnv, spawnOpencode } from "../src/opencode-runner/spawn";
import { rpcPortDir, type RpcPortFileRecord } from "../../plugin/src/shared/rpc-utils";

const root = process.env.MC_ISSUE_570_ROOT;
if (!root || !resolve(root).startsWith(resolve(join(tmpdir(), "magic-context")) + "/")) {
    throw new Error("Set MC_ISSUE_570_ROOT under the throwaway TMPDIR/magic-context tree");
}
const originalHome = process.env.HOME;
afterAll(() => { process.env.HOME = originalHome; });

for (const allowHomeProject of [true, false]) {
    test(`OpenCode 1 home project with allow_home_project=${allowHomeProject}`, async () => {
        const mock = new MockProvider();
        const { baseURL } = await mock.start();
        const env = createIsolatedEnv();
        env.workdir = join(env.dataDir, "home");
        mkdirSync(env.workdir, { recursive: true });
        expect(existsSync(join(env.workdir, ".git"))).toBe(false);
        process.env.HOME = env.workdir;
        const logPath = join(env.dataDir, "cortexkit", "magic-context-e2e.log");
        let host: Awaited<ReturnType<typeof spawnOpencode>> | undefined;
        try {
            host = await spawnOpencode({
                mockProviderURL: baseURL,
                existingEnv: env,
                magicContextConfig: {
                    allow_home_project: allowHomeProject,
                    execute_threshold_percentage: 40,
                    dreamer: { disable: true },
                    memory: { auto_promote: false, auto_search: { enabled: false } },
                },
            });
            const userConfigPath = join(env.configDir, "cortexkit", "magic-context.jsonc");
            expect(JSON.parse(readFileSync(userConfigPath, "utf8")).allow_home_project).toBe(allowHomeProject);
            const opened = execFileSync("lsof", ["-Fn", "-p", String(host.pid)], { encoding: "utf8" });
            const dbPaths = opened.split("\n").filter((line) => line.startsWith("n/") && /\.db(?:-wal|-shm)?$/.test(line));
            console.log(`ISSUE570 lsof policy=${allowHomeProject} pid=${host.pid} db=${JSON.stringify(dbPaths)}`);
            expect(dbPaths.length).toBeGreaterThan(0);
            expect(dbPaths.every((line) => resolve(line.slice(1)).startsWith(realpathSync(env.dataDir) + "/"))).toBe(true);

            mock.setDefault({ text: "fill", usage: { input_tokens: 1000, output_tokens: 20, cache_creation_input_tokens: 1000 } });
            mock.addMatcher((body) => {
                if (!JSON.stringify(body.system ?? "").includes("the hippocampus of a long-running coding agent")) return null;
                const range = findHistorianOrdinalRange(body);
                if (!range) return null;
                return {
                    text: buildMockHistorianPayload({ ...range, title: "home historian", body: "Mock historian publishes a home project compartment." }),
                    usage: { input_tokens: 500, output_tokens: 200, cache_creation_input_tokens: 500 },
                };
            });
            const client = createOpencodeClient({ baseUrl: host.url });
            const created = await client.session.create({ query: { directory: env.workdir } });
            const sessionId = created.data?.id;
            if (!sessionId) throw new Error(`Session creation failed: ${JSON.stringify(created)}`);
            const prompt = async (text: string) => {
                const reply = await client.session.prompt({
                    path: { id: sessionId },
                    body: { model: { providerID: "mock-anthropic", modelID: "mock-sonnet" }, parts: [{ type: "text", text }] },
                });
                if (reply.error) throw new Error(JSON.stringify(reply.error));
            };
            const ballast = "durable conversation content ".repeat(500);
            for (let i = 0; i < 10; i++) await prompt(`turn ${i}: ${ballast}`);
            mock.setDefault({ text: "big", usage: { input_tokens: 90_000, output_tokens: 20, cache_creation_input_tokens: 90_000 } });
            await prompt("turn 11: trigger historian with meaningful content");
            mock.setDefault({ text: "after-trigger", usage: { input_tokens: 500, output_tokens: 10, cache_read_input_tokens: 500 } });
            await prompt("turn 12: next transform pass");

            const dbPath = join(env.dataDir, "cortexkit", "magic-context", "context.db");
            const db = openTestDb(dbPath, { readonly: true });
            const count = () => (db.prepare("SELECT COUNT(*) as count FROM compartments WHERE session_id = ?").get(sessionId) as { count: number }).count;
            try {
                if (allowHomeProject) {
                    const deadline = Date.now() + 30_000;
                    while (count() === 0 && Date.now() < deadline) await Bun.sleep(250);
                    expect(count()).toBeGreaterThan(0);
                } else {
                    await Bun.sleep(1500);
                    expect(count()).toBe(0);
                }
                console.log(`ISSUE570 compartment policy=${allowHomeProject} row=${JSON.stringify(db.prepare("SELECT session_id, sequence, title FROM compartments WHERE session_id = ? LIMIT 1").get(sessionId))}`);
            } finally { db.close(); }

            const portDirectory = rpcPortDir(join(env.dataDir, "cortexkit", "magic-context"), realpathSync(env.workdir));
            const deadline = Date.now() + 10_000;
            while (!existsSync(portDirectory) && Date.now() < deadline) await Bun.sleep(100);
            if (!existsSync(portDirectory)) throw new Error(`Sidebar RPC discovery directory absent: ${portDirectory}`);
            const file = readdirSync(portDirectory).find((name) => name.startsWith("port-") && name.endsWith(".json"));
            if (!file) throw new Error("Sidebar RPC discovery file absent");
            const discovery = JSON.parse(readFileSync(join(portDirectory, file), "utf8")) as RpcPortFileRecord;
            const response = await fetch(`http://127.0.0.1:${discovery.port}/rpc/sidebar-snapshot`, {
                method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${discovery.token}` },
                body: JSON.stringify({ sessionId, directory: env.workdir }),
            });
            const snapshot = await response.json() as Record<string, unknown>;
            expect(response.status).toBe(200);
            expect(snapshot.error).toBeUndefined();
            expect(snapshot.sessionId).toBe(sessionId);
            console.log(`ISSUE570 sidebar policy=${allowHomeProject} snapshot=${JSON.stringify({ sessionId: snapshot.sessionId, disabled: snapshot.disabled, compartmentCount: snapshot.compartmentCount })}`);
            await Bun.sleep(650);
            const lines = readFileSync(logPath, "utf8").split("\n");
            const errors = lines.filter((line) => line.includes("ProjectIdentityError"));
            const skips = lines.filter((line) => line.includes("home project memory disabled; skipping memory features"));
            console.log(`ISSUE570 log policy=${allowHomeProject} ProjectIdentityError=${errors.length} skips=${skips.length} excerpts=${JSON.stringify([...errors, ...skips])}`);
            expect(errors).toHaveLength(0);
            expect(skips.length).toBe(allowHomeProject ? 0 : 1);
        } finally {
            await host?.kill();
            await mock.stop();
            process.env.HOME = originalHome;
        }
    }, 180_000);
}
