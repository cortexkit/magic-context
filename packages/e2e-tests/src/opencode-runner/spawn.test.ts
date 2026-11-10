/// <reference types="bun-types" />
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadPluginConfigDetailed } from "../../../plugin/src/config";
import { migrateConfigFile } from "../../../plugin/src/config/migrate-config-location";
import { createIsolatedEnv, waitForReady, writeConfigs } from "./spawn";

let server: ReturnType<typeof Bun.serve> | undefined;
const tempDirs: string[] = [];

function readyProviderConfig(): Response {
    return Response.json({
        providers: [
            {
                id: "mock-anthropic",
                models: { "mock-sonnet": { id: "mock-sonnet" } },
            },
        ],
    });
}

function newPluginLogPath(): string {
    const directory = createTestTempDirFromPath(join(tmpdir(), "mc-opencode-readiness-"));
    tempDirs.push(directory);
    return join(directory, "magic-context.log");
}

afterEach(() => {
    server?.stop(true);
    server = undefined;
    for (const directory of tempDirs.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

describe("opencode configuration", () => {
    it("registers extra mock models at the primary window without rerouting the historian", () => {
        const env = createIsolatedEnv();
        tempDirs.push(dirname(env.dataDir));
        writeConfigs(env, "http://127.0.0.1:12345", {
            mockProviderURL: "http://127.0.0.1:12345",
            modelContextLimit: 100_000,
            additionalModelIDs: ["mock-model-hard-fold"],
        });
        const config = JSON.parse(readFileSync(join(env.configDir, "opencode.json"), "utf8"));
        const models = config.provider["mock-anthropic"].models;
        expect(models["mock-model-hard-fold"].limit).toEqual({ context: 100_000, output: 8192 });
        expect(models["mock-model-hard-fold"].limit).toEqual(models["mock-sonnet"].limit);
        expect(config.model).toBe("mock-anthropic/mock-sonnet");
        const policy = JSON.parse(readFileSync(join(env.configDir, "cortexkit", "magic-context.jsonc"), "utf8"));
        expect(policy.historian.opencode.model).toBe("mock-anthropic/mock-sonnet");
    });

    it("restart config edits replace the authoritative CortexKit user policy", () => {
        const env = createIsolatedEnv();
        tempDirs.push(dirname(env.dataDir));
        const previousConfigHome = process.env.XDG_CONFIG_HOME;
        process.env.XDG_CONFIG_HOME = env.configDir;
        try {
            const options = {
                mockProviderURL: "http://127.0.0.1:12345",
                magicContextConfig: { cache_ttl: "0" },
            };
            const authoritative = join(env.configDir, "cortexkit", "magic-context.jsonc");
            const legacy = join(env.configDir, "opencode", "magic-context.jsonc");
            writeConfigs(env, options.mockProviderURL, options);
            // Simulate the first host boot: an old harness writer gets migrated here.
            // The next write must update the target rather than recreate the old source.
            migrateConfigFile({
                scope: "user",
                targetPath: authoritative,
                legacySources: [{ path: legacy, label: "OpenCode user" }],
            });
            expect(loadPluginConfigDetailed(env.workdir, false).config.cache_ttl).toBe("0");
            writeConfigs(env, options.mockProviderURL, {
                ...options,
                magicContextConfig: { cache_ttl: "5m" },
                openCodeGlobalConfigExtra: { compaction: { auto: false } },
            });
            expect(loadPluginConfigDetailed(env.workdir, false).config.cache_ttl).toBe("5m");
            expect(JSON.parse(readFileSync(authoritative, "utf8")).cache_ttl).toBe("5m");
            expect(existsSync(legacy)).toBe(false);
            const globalHostConfig = JSON.parse(
                readFileSync(join(env.configDir, "opencode", "opencode.json"), "utf8"),
            );
            expect(globalHostConfig.compaction).toEqual({ auto: false });
        } finally {
            if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
            else process.env.XDG_CONFIG_HOME = previousConfigHome;
        }
    });
});

describe("opencode readiness", () => {
    it("waits for the session API after the documentation endpoint responds", async () => {
        let sessionAttempts = 0;
        let toolAttempts = 0;
        let providerAttempts = 0;
        const observedDirectories: string[] = [];
        server = Bun.serve({
            port: 0,
            fetch(request) {
                const requestUrl = new URL(request.url);
                if (requestUrl.pathname === "/doc") return new Response("ready");
                if (requestUrl.pathname === "/experimental/tool/ids") {
                    toolAttempts += 1;
                    return Response.json(["ctx_search"]);
                }
                if (requestUrl.pathname === "/config/providers") {
                    providerAttempts += 1;
                    return readyProviderConfig();
                }
                if (requestUrl.pathname !== "/session") return new Response(null, { status: 404 });

                sessionAttempts += 1;
                observedDirectories.push(requestUrl.searchParams.get("directory") ?? "");
                if (sessionAttempts === 1) return new Response(null, { status: 503 });
                if (sessionAttempts === 2) return Response.json({ warming: true });
                return Response.json([]);
            },
        });

        const url = `http://127.0.0.1:${server.port}`;
        expect((await fetch(`${url}/doc`)).ok).toBe(true);

        await waitForReady(url, "/isolated/workdir", 2_000);

        expect(sessionAttempts).toBe(3);
        expect(toolAttempts).toBe(1);
        expect(providerAttempts).toBe(1);
        expect(observedDirectories).toEqual([
            "/isolated/workdir",
            "/isolated/workdir",
            "/isolated/workdir",
        ]);
    });

    it("waits for Magic Context hooks before probing the configured model", async () => {
        let sessionAttempts = 0;
        let toolAttempts = 0;
        let providerAttempts = 0;
        const observedDirectories = new Set<string>();
        server = Bun.serve({
            port: 0,
            fetch(request) {
                const requestUrl = new URL(request.url);
                observedDirectories.add(requestUrl.searchParams.get("directory") ?? "");
                if (requestUrl.pathname === "/session") {
                    sessionAttempts += 1;
                    return Response.json([]);
                }
                if (requestUrl.pathname === "/experimental/tool/ids") {
                    toolAttempts += 1;
                    return Response.json(toolAttempts >= 2 ? ["ctx_search"] : []);
                }
                if (requestUrl.pathname === "/config/providers") {
                    providerAttempts += 1;
                    return providerAttempts >= 3
                        ? readyProviderConfig()
                        : Response.json({ providers: [] });
                }
                return new Response(null, { status: 404 });
            },
        });

        await waitForReady(`http://127.0.0.1:${server.port}`, "/isolated/workdir", 2_000);

        expect(sessionAttempts).toBe(1);
        expect(toolAttempts).toBe(2);
        expect(providerAttempts).toBe(3);
        expect([...observedDirectories]).toEqual(["/isolated/workdir"]);
    });

    it("rejects session-only readiness when Magic Context hooks never register", async () => {
        let providerAttempts = 0;
        server = Bun.serve({
            port: 0,
            fetch(request) {
                const requestUrl = new URL(request.url);
                if (requestUrl.pathname === "/session") return Response.json([]);
                if (requestUrl.pathname === "/experimental/tool/ids") return Response.json([]);
                if (requestUrl.pathname === "/config/providers") {
                    providerAttempts += 1;
                    return readyProviderConfig();
                }
                return new Response(null, { status: 404 });
            },
        });

        await expect(
            waitForReady(`http://127.0.0.1:${server.port}`, "/isolated/workdir", 20),
        ).rejects.toThrow("Magic Context tool registry is not ready");
        expect(providerAttempts).toBe(0);
    });

    it("uses the conflict-disable verdict instead of waiting for absent tools", async () => {
        let toolAttempts = 0;
        let providerAttempts = 0;
        const pluginLogPath = newPluginLogPath();
        server = Bun.serve({
            port: 0,
            fetch(request) {
                const requestUrl = new URL(request.url);
                if (requestUrl.pathname === "/session") return Response.json([]);
                if (requestUrl.pathname === "/experimental/tool/ids") {
                    toolAttempts += 1;
                    return Response.json([]);
                }
                if (requestUrl.pathname === "/config/providers") {
                    providerAttempts += 1;
                    return readyProviderConfig();
                }
                return new Response(null, { status: 404 });
            },
        });

        let ready = false;
        const readiness = waitForReady(
            `http://127.0.0.1:${server.port}`,
            "/isolated/workdir",
            2_000,
            {
                expectedMagicContextState: "conflict-disabled",
                pluginLogPath,
            },
        ).then(() => {
            ready = true;
        });
        await Bun.sleep(50);
        expect(ready).toBe(false);

        writeFileSync(
            pluginLogPath,
            "[2026-08-17T00:00:00.000Z] [magic-context] disabled due to conflicts: OpenCode auto-compaction is enabled\n",
        );
        await readiness;

        expect(toolAttempts).toBe(0);
        expect(providerAttempts).toBe(1);
    });

    it("ignores conflict-disable verdicts written before the current boot", async () => {
        const pluginLogPath = newPluginLogPath();
        writeFileSync(
            pluginLogPath,
            "[2026-08-16T00:00:00.000Z] [magic-context] disabled due to conflicts: stale boot\n",
        );
        const pluginLogStartOffset = statSync(pluginLogPath).size;
        server = Bun.serve({
            port: 0,
            fetch(request) {
                const requestUrl = new URL(request.url);
                if (requestUrl.pathname === "/session") return Response.json([]);
                if (requestUrl.pathname === "/config/providers") return readyProviderConfig();
                return new Response(null, { status: 404 });
            },
        });

        await expect(
            waitForReady(
                `http://127.0.0.1:${server.port}`,
                "/isolated/workdir",
                20,
                {
                    expectedMagicContextState: "conflict-disabled",
                    pluginLogPath,
                    pluginLogStartOffset,
                },
            ),
        ).rejects.toThrow("Magic Context conflict-disable verdict is not ready");
    });
});
