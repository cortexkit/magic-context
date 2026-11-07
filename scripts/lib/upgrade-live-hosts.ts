import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { assertHostPasses } from "./upgrade-contract";
import { integrity, version } from "./upgrade-audit";
import type { MockProvider } from "../../packages/e2e-tests/src/mock-provider/server";

// Set TMPDIR before loading the OpenCode/Pi E2E drivers so any module-level
// temporary paths, as well as their per-host homes and stores, stay in this rehearsal.
const [release, root, report, upgraded] = process.argv.slice(2).map((p) => resolve(p));
if (
    process.platform !== "linux" ||
    !root.startsWith(process.env.TMPDIR! + "/") ||
    !root.includes("/magic-context/rehearsal-early/run-")
)
    throw new Error("Live rehearsal requires a throwaway Linux rehearsal-early root");
mkdirSync(root, { recursive: true });
process.env.TMPDIR = root;
process.env.HOME = join(root, "home");
process.env.XDG_CONFIG_HOME = join(root, "config");
process.env.XDG_DATA_HOME = join(root, "data");
process.env.XDG_CACHE_HOME = join(root, "cache");
process.env.XDG_STATE_HOME = join(root, "state");
process.env.MC_E2E_KEEP = "1";
process.env.NODE_ENV = "";
delete process.env.MC_E2E_MODE;
const repo = resolve(import.meta.dir, "../..");
const hostPackages = join(repo, "packages/e2e-tests");
const response = {
    content: [
        {
            type: "thinking",
            thinking: "Preserve the migration boundary and exact reasoning.",
            signature: "rehearsal-signed-thinking",
        },
        { type: "text", text: "Migration plan recorded 東京." },
    ],
    usage: { input_tokens: 500, output_tokens: 80 },
};
const config = { memory: { enabled: true, embeddings: { enabled: false } }, auto_update: false };
type Host = {
    root: string;
    db: string;
    workdir: string;
    mock: MockProvider;
    session(): Promise<string>;
    prompt(session: string, text: string): Promise<void>;
    stop(): Promise<void>;
};
const results: {
    host: string;
    status: string;
    version: number;
    requests: number;
    tagged: boolean;
    [key: string]: unknown;
}[] = [];

async function boot(kind: string, tree: string, previous?: Host): Promise<Host> {
    if (kind === "opencode") {
        process.env.MC_E2E_PLUGIN_ENTRY = join(tree, "packages/plugin/dist/index.js");
        const { TestHarness } = await import("../../packages/e2e-tests/src/harness");
        // TestHarness.restart reuses the config/data/cache/work directories and mock, then reconnects its SDK client.
        const h = previous
            ? (previous as Host & { harness: Awaited<ReturnType<typeof TestHarness.create>> })
                  .harness
            : await TestHarness.create({
                  prepareContextDatabase: false,
                  magicContextConfig: config,
                  mockDefault: response,
              });
        if (previous) await h.restart();
        return {
            root: dirname(h.dataDir),
            db: h.contextDbPath(),
            workdir: h.workdir,
            mock: h.mock,
            harness: h,
            session: () => h.createSession(),
            prompt: async (id: string, text: string) => {
                await h.sendPrompt(id, text);
            },
            stop: () => h.opencode.kill({ root: "keep" }),
        } as Host;
    }
    if (kind === "opencode2") {
        const { spawnOpencode2, waitForPluginActive } = await import(
            "../../packages/e2e-tests/src/opencode2-runner/spawn"
        );
        const { OpenCode } = await import(Bun.resolveSync("@opencode/client", hostPackages));
        const prev = previous as
            | (Host & { running: Awaited<ReturnType<typeof spawnOpencode2>> })
            | undefined;
        const running = await spawnOpencode2({
            providerID: "anthropic",
            magicContextPlugin: join(tree, "packages/plugin"),
            prepareContextDatabase: false,
            magicContextConfig: config,
            mockResponse: response,
            ...(prev
                ? {
                      existingIsolation: {
                          root: prev.running.root,
                          env: prev.running.env,
                          cwd: prev.running.cwd,
                      },
                      existingMock: { mock: prev.mock, baseURL: prev.running.mockBaseURL },
                  }
                : {}),
        });
        const client = OpenCode.make({
            baseUrl: running.url,
            headers: { authorization: `Basic ${btoa(`opencode:${running.password}`)}` },
        });
        if (previous) {
            // OpenCode 2 activates plugins lazily. An auxiliary session opens the workspace before auditing the original session's store.
            await client.session.create({
                location: { directory: running.cwd },
                model: { providerID: "anthropic", id: "mock-model" },
            });
            await waitForPluginActive(client, running.cwd);
        }
        return {
            root: running.root,
            db: join(
                running.env.MAGIC_CONTEXT_STORAGE_DIR ??
                    join(running.env.XDG_DATA_HOME!, "cortexkit/magic-context"),
                "context.db",
            ),
            workdir: running.cwd,
            mock: running.mock,
            running,
            session: async () => {
                const s = await client.session.create({
                    location: { directory: running.cwd },
                    model: { providerID: "anthropic", id: "mock-model" },
                });
                await waitForPluginActive(client, running.cwd);
                return s.id;
            },
            prompt: async (id: string, text: string) => {
                await client.session.prompt({ sessionID: id, text });
                await client.session.wait(
                    { sessionID: id },
                    { signal: AbortSignal.timeout(90_000) },
                );
            },
            stop: () => running.stopHost(),
        } as Host;
    }
    process.env.MC_E2E_PI_PLUGIN_ROOT = join(tree, "packages/pi-plugin");
    const { MockProvider } = await import("../../packages/e2e-tests/src/mock-provider/server");
    const { PiRpcClient, requireSuccessfulResponse } = await import(
        "../../packages/e2e-tests/src/pi-runner/rpc-client"
    );
    const prev = previous as
        | (Host & { rpc: InstanceType<typeof PiRpcClient>; baseURL: string; sessionFile?: string })
        | undefined;
    const mock = prev?.mock ?? new MockProvider();
    const baseURL = prev?.baseURL ?? (await mock.start()).baseURL;
    mock.setDefault(response);
    if (prev) {
        const pluginDir = prev.rpc.env.pluginDir;
        rmSync(pluginDir, { recursive: true, force: true });
        symlinkSync(join(tree, "packages/pi-plugin"), pluginDir, "dir");
    }
    const rpc = new PiRpcClient({
        mockProviderURL: baseURL,
        env: prev?.rpc.env,
        magicContextConfig: config,
    });
    await rpc.start();
    if (prev?.sessionFile)
        requireSuccessfulResponse(
            await rpc.sendCommand("switch_session", { sessionPath: prev.sessionFile }),
        );
    const host = {
        root: rpc.env.baseDir,
        db: join(rpc.env.dataDir, "cortexkit/magic-context/context.db"),
        workdir: rpc.env.workdir,
        mock,
        rpc,
        baseURL,
        sessionFile: prev?.sessionFile,
        session: async () => {
            const state = requireSuccessfulResponse(
                await rpc.sendCommand<{ sessionId: string; sessionFile: string }>("get_state"),
            );
            host.sessionFile = state.sessionFile;
            return state.sessionId;
        },
        prompt: async (_id: string, text: string) => {
            const end = rpc.waitForEvent((e) => e.type === "agent_end", { timeoutMs: 90_000 });
            requireSuccessfulResponse(await rpc.sendCommand("prompt", { message: text }));
            await end;
            const state = requireSuccessfulResponse(
                await rpc.sendCommand<{ sessionFile: string }>("get_state"),
            );
            host.sessionFile = state.sessionFile;
        },
        stop: () => rpc.shutdown(2000, true),
    };
    return host;
}

for (const kind of ["opencode", "opencode2", "pi"]) {
    let host: Host | undefined;
    const result = {
        host: kind,
        status: "FAIL",
        version: 0,
        requests: 0,
        tagged: false,
    } as (typeof results)[number];
    results.push(result);
    try {
        host = await boot(kind, release);
        if (!host.root.startsWith(root + "/"))
            throw new Error(`Host escaped throwaway root: ${host.root}`);
        const session = await host.session();
        await host.prompt(
            session,
            "Record the migration boundary and retain the original reasoning.",
        );
        await host.stop();
        result.releasedVersion = version(host.db);
        if (result.releasedVersion !== 95) throw new Error("Released host did not write schema 95");
        // Stop the host before replacing its store; WAL sidecars must not refer to the previous file.
        for (const suffix of ["", "-wal", "-shm"]) rmSync(`${host.db}${suffix}`, { force: true });
        copyFileSync(join(upgraded, "context.db"), host.db);
        host = await boot(kind, repo, host);
        const marker =
            "UPGRADE_REHEARSAL_FIRST_PASS: preserve Unicode 東京 and continue the migration review.";
        const offset = host.mock.requests().length;
        await host.prompt(session, marker);
        const requests = host.mock
            .requests()
            .slice(offset)
            .filter((r) =>
                r.body.messages?.some(
                    (m) => m.role === "user" && JSON.stringify(m.content).includes(marker),
                ),
            );
        result.requests = requests.length;
        const body = JSON.stringify(requests[0]?.body.messages);
        result.tagged = /§\d+§/.test(body ?? "");
        result.rawBodyBytes = Buffer.byteLength(requests[0]?.rawBody ?? "");
        await host.stop();
        result.version = version(host.db);
        result.integrity = integrity(host.db);
        if (existsSync(join(dirname(host.db), "store.db")))
            throw new Error("Retired store.db was created by candidate host");
        result.status =
            result.version === 105 && result.requests === 1 && result.tagged ? "PASS" : "FAIL";
    } catch (error) {
        result.error = String(error);
    } finally {
        if (host) {
            await host.stop().catch((e) => {
                result.stopError = String(e);
            });
            await host.mock.stop();
        }
        mkdirSync(dirname(report), { recursive: true });
        writeFileSync(report, JSON.stringify(results, null, 2));
        console.log(JSON.stringify(result));
    }
}
assertHostPasses(results);
