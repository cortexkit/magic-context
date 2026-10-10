import { expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { OpenCode } from "@opencode/client";
import { RustTestHarness, stableSerialize } from "./rust-harness";
import { CLI, isolation, spawnOpencode2, waitForPluginActive } from "./opencode2-runner/spawn";
import { buildHermeticBinaries, HermeticSubcStack, detectRustModePrereqs } from "./rust-runner/hermetic-subc";
import { cleanupE2ETempDir } from "./temp-dir";

const config = { transform_mode: "rust", rust_pipeline: "provider", execute_threshold_percentage: 90,
    historian: { disable: true }, dreamer: { disable: true }, memory: { enabled: false }, embedding: { provider: "off" } };

function assertRecord(db: Database, session: string, harness: string) {
    const row = db.query("SELECT plan_json, pipeline_exit_json FROM host_runner_state WHERE session_id = ? AND harness = ?").get(session, harness) as { plan_json: string; pipeline_exit_json: string | null } | null;
    expect(row).not.toBeNull();
    expect(row!.plan_json).toContain("opencode-aisdk");
    expect(row!.pipeline_exit_json).toBeNull();
    expect((db.query("SELECT COUNT(*) AS n FROM host_runner_entries WHERE session_id = ? AND harness = ?").get(session, harness) as { n: number }).n).toBeGreaterThan(0);
}

export async function providerHostLane(host: "opencode" | "opencode2") {
    expect(process.env.MC_E2E_CK_SUBC_BIN, "use a prebuilt daemon; do not build from an operator checkout").toBeTruthy();
    expect(process.env.MC_E2E_CK_MC_PREBUILT_BIN, "the module and daemon must be a complete prebuilt pair").toBeTruthy();
    expect(process.env.MC_E2E_CK_MC_DRIVE_FAULT_BIN, "the hermetic prerequisite checker also requires its fault variant").toBeTruthy();
    expect(detectRustModePrereqs().ok).toBe(true);
    const version = execFileSync(host === "opencode" ? "opencode" : CLI, ["--version"], { encoding: "utf8", timeout: 10000 }).trim();
    expect(version).toMatch(host === "opencode" ? /^1\.18\.\d+$/ : /^2\.0\.\d+$/);
    console.log(`provider lane ${host} ${version}; Bun ${Bun.version}`);
    if (host === "opencode") {
        const h = await RustTestHarness.create({ startHistorianProducer: false, magicContextConfig: config });
        try {
            const inventory = execFileSync("lsof", ["-nP", "-p", String(h.opencode.pid), "-Fn"], { encoding: "utf8", timeout: 10000 });
            const paths = inventory.split("\n").filter(line => /^n.*\.(db|sqlite)(-(wal|shm))?$/.test(line)).map(line => line.slice(1));
            expect(paths.length).toBeGreaterThan(0);
            expect(paths.every(path => path.startsWith(dirname(h.env.dataDir) + "/"))).toBe(true);
            const id = await h.createSession();
            await h.sendPrompt(id, "PROVIDER_LANE first");
            const first = h.lastMainMessages().map(stableSerialize);
            await h.sendPrompt(id, "PROVIDER_LANE second");
            expect(h.lastMainMessages().slice(0, first.length).map(stableSerialize)).toEqual(first);
            assertRecord(h.contextDb(), id, host);
            expect(first.some(m => /§\d+§/.test(m))).toBe(true);
        } finally { await h.dispose(); }
        return;
    }
    const binaries = await buildHermeticBinaries();
    const fixture = isolation();
    let stack: HermeticSubcStack | undefined;
    let h: Awaited<ReturnType<typeof spawnOpencode2>> | undefined;
    try {
        stack = await HermeticSubcStack.start({ dataDir: fixture.env.XDG_DATA_HOME!, ...binaries, startProducer: false });
        h = await spawnOpencode2({ existingIsolation: fixture, providerID: "anthropic", modelOutputLimit: 8192, magicContextConfig: { ...config, subc: { connection_file: stack.connectionFile } } });
        const client = OpenCode.make({ baseUrl: h.url, headers: { authorization: `Basic ${btoa(`opencode:${h.password}`)}` } });
        await waitForPluginActive(client, h.cwd);
        const session = await client.session.create({ title: "provider lane", location: { directory: h.cwd }, model: { providerID: "anthropic", id: "mock-model" } });
        const id = session.id;
        const turn = async (text: string) => {
            await client.session.prompt({ sessionID: id, text });
            await client.session.wait({ sessionID: id }, { signal: AbortSignal.timeout(60000) });
        };
        await turn("PROVIDER_LANE first");
        const main = () => h!.mock.requests().filter(r => JSON.stringify(r.body.messages).includes("PROVIDER_LANE") && JSON.stringify(r.body).includes("## Magic Context"));
        const first = main().at(-1)!.body.messages!.map(stableSerialize);
        await turn("PROVIDER_LANE second");
        expect(main().at(-1)!.body.messages!.slice(0, first.length).map(stableSerialize)).toEqual(first);
        const db = new Database(join(fixture.env.XDG_DATA_HOME!, "cortexkit/magic-context/context.db"), { readonly: true });
        try { assertRecord(db, id, host); } finally { db.close(); }
        expect(first.some(m => /§\d+§/.test(m))).toBe(true);
    } finally { try { await h?.stop(); } finally { try { await stack?.stop(); } finally { cleanupE2ETempDir(fixture.root); } } }
}
