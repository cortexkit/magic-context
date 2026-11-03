import { openTestDb } from "./test-db";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { MockProvider } from "./mock-provider/server";
import { awaitPluginActivation, type PluginEntry } from "./opencode2-runner/plugin-activation";

export interface PrimaryCaptureOptions {
    generation: 1 | 2;
    cli: string;
    plugin: string;
    /** A caller-owned directory created by createTestTempDirFromPath. */
    root: string;
    label: string;
}

export interface PrimaryCapture {
    version: string;
    processed: boolean;
    rawBodies: string[];
    agents: Array<{ id: string; hidden: boolean; mode?: string }>;
    databases: string[][];
}

/** Fixture prompts never name carriers, so any occurrence in the payload is a leak. */
export function assertNoZenCarrierLeak(body: unknown): void {
    if (JSON.stringify(body).includes("-zen-blocked-read")) {
        throw new Error("Ordinary primary request exposes a -zen-blocked-read carrier");
    }
}

function list(value: unknown): Array<Record<string, unknown>> {
    return (Array.isArray(value) ? value : (value as { data?: unknown })?.data) as Array<
        Record<string, unknown>
    >;
}

/** Boot each snapshot at the same paths so no request bytes need path normalization. */
export async function capturePrimaryRequests(
    options: PrimaryCaptureOptions,
): Promise<PrimaryCapture> {
    const { root, generation, label } = options;
    const runtime = join(root, "runtime");
    const cwd = join(root, "work");
    for (const path of [runtime, cwd]) {
        rmSync(path, { recursive: true, force: true });
        mkdirSync(path, { recursive: true, mode: 0o700 });
    }
    for (const path of ["home", "config", "data", "state", "cache", "xdg-runtime", "tmp", "mc"]) {
        mkdirSync(join(runtime, path), { recursive: true, mode: 0o700 });
    }
    const env: Record<string, string> = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: join(runtime, "home"),
        CFFIXED_USER_HOME: join(runtime, "home"),
        XDG_CONFIG_HOME: join(runtime, "config"),
        XDG_DATA_HOME: join(runtime, "data"),
        XDG_STATE_HOME: join(runtime, "state"),
        XDG_CACHE_HOME: join(runtime, "cache"),
        XDG_RUNTIME_DIR: join(runtime, "xdg-runtime"),
        TMPDIR: join(runtime, "tmp"),
        OPENCODE_CONFIG_DIR: join(runtime, "config"),
        OPENCODE_DB: "primary-probe.db",
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        OPENCODE_DISABLE_MODELS_FETCH: "true",
        MAGIC_CONTEXT_STORAGE_DIR: join(runtime, "mc"),
        MAGIC_CONTEXT_LOG_PATH: join(runtime, "mc.log"),
    };
    if (generation === 1) env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "true";
    const versionResult = spawnSync(options.cli, ["--version"], {
        env,
        encoding: "utf8",
        windowsHide: true,
    });
    const version = versionResult.stdout.trim();
    const expected = generation === 1 ? "1.19.3" : "opencode v2.0.31";
    if (versionResult.status !== 0 || version !== expected)
        throw new Error(`Expected ${expected}, got ${version}`);

    const mock = new MockProvider();
    mock.setDefault({
        text: "Ordinary primary fixture reply.",
        usage: { input_tokens: 100, output_tokens: 10 },
    });
    const { baseURL } = await mock.start();
    const providerID = generation === 1 ? "mock-anthropic" : "anthropic";
    const modelID = "mock-sonnet";
    const model = `${providerID}/${modelID}`;
    const modelSpec = { name: modelID, limit: { context: 200000, output: 8192 } };
    const agent = { title: { disable: true }, summary: { disable: true } };
    const config =
        generation === 1
            ? {
                  plugin: [`file://${options.plugin}`],
                  model,
                  small_model: model,
                  agent,
                  share: "disabled",
                  autoupdate: false,
                  compaction: { auto: false, prune: false },
                  provider: {
                      [providerID]: {
                          npm: "@ai-sdk/anthropic",
                          options: { baseURL: `${baseURL}/v1`, apiKey: "fixture-not-a-credential" },
                          models: { [modelID]: modelSpec },
                      },
                  },
              }
            : {
                  plugins: [options.plugin],
                  model,
                  compaction: { auto: false },
                  providers: {
                      [providerID]: {
                          settings: { baseURL, apiKey: "fixture-not-a-credential" },
                          models: { [modelID]: modelSpec },
                      },
                  },
              };
    writeFileSync(join(cwd, "opencode.json"), JSON.stringify(config));
    mkdirSync(join(runtime, "config", "cortexkit"), { recursive: true });
    writeFileSync(
        join(runtime, "config", "cortexkit", "magic-context.jsonc"),
        JSON.stringify({
            auto_update: false,
            embedding: { provider: "off" },
            dreamer: { disable: false },
            historian: { opencode: { model } },
        }),
    );

    const child = spawn(
        options.cli,
        ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"],
        {
            cwd,
            env,
            windowsHide: true,
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
        },
    );
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
    let stdout = "",
        stderr = "";
    child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
    });
    const databases: string[][] = [];
    const inventory = () => {
        const result = spawnSync(
            process.platform === "darwin" ? "/usr/sbin/lsof" : "/usr/bin/lsof",
            ["-p", String(child.pid)],
            { encoding: "utf8", windowsHide: true },
        );
        writeFileSync(join(root, `${label}-${databases.length}.lsof`), result.stdout);
        const paths = result.stdout.split("\n").filter((line) => /\.db(?:\b|[- ])/.test(line));
        if (result.status !== 0 || !paths.length || paths.some((line) => !line.includes(runtime)))
            throw new Error("Primary host database isolation failed");
        databases.push(paths);
    };
    try {
        const ready = await new Promise<{ url: string; password?: string }>((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error(`Primary host startup timed out: ${stderr}`)),
                60000,
            );
            child.stdout.on("data", (chunk) => {
                stdout += chunk.toString();
                const url = stdout.match(/https?:\/\/127\.0\.0\.1:\d+/)?.[0];
                const password = stdout.match(/server password (\S+)/)?.[1];
                if (url && (generation === 1 || password)) {
                    clearTimeout(timer);
                    resolve({ url, password });
                }
            });
            child.once("error", (error) => {
                clearTimeout(timer);
                reject(error);
            });
            child.once("close", () => {
                clearTimeout(timer);
                reject(new Error(`Primary host exited before capture: ${stderr}`));
            });
        });
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (ready.password) headers.authorization = `Basic ${btoa(`opencode:${ready.password}`)}`;
        const api = async (path: string, body?: unknown): Promise<unknown> => {
            const response = await fetch(
                `${ready.url}${path}?directory=${encodeURIComponent(cwd)}`,
                {
                    method: body ? "POST" : "GET",
                    headers,
                    body: body ? JSON.stringify(body) : undefined,
                    signal: AbortSignal.timeout(60000),
                },
            );
            if (!response.ok)
                throw new Error(
                    `Primary host API ${path} returned ${response.status}: ${await response.text()}`,
                );
            return response.json();
        };
        const location = { directory: cwd };
        const client =
            generation === 2 ? OpenCode.make({ baseUrl: ready.url, headers }) : undefined;
        if (client) await client.location.get({ location });
        const session = client
            ? await client.session.create({
                  location,
                  title: "primary visibility fixture",
                  model: { providerID, id: modelID },
              })
            : ((await api("/session", { title: "primary visibility fixture" })) as { id: string });
        if (client)
            await awaitPluginActivation(
                {
                    event: client.event,
                    plugin: {
                        list: async (input) => {
                            const entries = list(await client.plugin.list(input));
                            writeFileSync(
                                join(root, `${label}.plugins.json`),
                                JSON.stringify(entries, null, 2),
                            );
                            return { data: entries as unknown as PluginEntry[] };
                        },
                    },
                },
                cwd,
                "@cortexkit/opencode-magic-context",
            );
        const agentRows = list(
            client ? await client.agent.list({ location }) : await api("/agent"),
        );
        writeFileSync(join(root, `${label}.agents.json`), JSON.stringify(agentRows, null, 2));
        const agents = agentRows.map((agent) => ({
            id: String(agent.id ?? agent.name),
            hidden: agent.hidden === true,
            mode: typeof agent.mode === "string" ? agent.mode : undefined,
        }));
        if (!agents.some((agent) => agent.id === "historian" && agent.hidden))
            throw new Error("Magic Context hidden agents were not loaded");
        inventory();
        for (const text of [
            "Describe the available reviewer agents without calling a tool.",
            "Explain the @explore mention without delegating.",
        ]) {
            if (client) {
                await client.session.prompt({ sessionID: session.id, text });
                await client.session.wait(
                    { sessionID: session.id },
                    { signal: AbortSignal.timeout(60000) },
                );
            } else {
                await api(`/session/${session.id}/message`, {
                    agent: "build",
                    model: { providerID, modelID },
                    parts: [{ type: "text", text }],
                });
            }
        }
        inventory();
        if (!existsSync(join(runtime, "mc", "context.db")))
            throw new Error("Magic Context context database was not opened");
        const db = openTestDb(join(runtime, "mc", "context.db"), { readonly: true });
        try {
            if (!db.query("SELECT 1 FROM session_meta WHERE session_id = ?").get(session.id))
                throw new Error("Magic Context did not process the ordinary primary session");
        } finally {
            db.close();
        }
        const requests = mock.requests().filter((request) => request.body.model === modelID);
        if (requests.length !== 2)
            throw new Error(`Expected two ordinary primary requests, received ${requests.length}`);
        const rawBodies = requests.map((request) => {
            if (typeof request.rawBody !== "string")
                throw new Error("Mock did not preserve raw provider bytes");
            return request.rawBody;
        });
        const capture = { version, processed: true, rawBodies, agents, databases };
        writeFileSync(join(root, `${label}.json`), JSON.stringify(capture, null, 2));
        return capture;
    } finally {
        writeFileSync(join(root, `${label}.host.log`), `${stdout}\n${stderr}`);
        if (child.exitCode === null && child.signalCode === null) {
            const signalGroup = (signal: NodeJS.Signals) => {
                try {
                    if (child.pid !== undefined) process.kill(-child.pid, signal);
                    else child.kill(signal);
                } catch {
                    child.kill(signal);
                }
            };
            signalGroup("SIGTERM");
            const timer = setTimeout(() => signalGroup("SIGKILL"), 5000);
            await exited;
            clearTimeout(timer);
        } else await exited;
        await mock.stop();
    }
}

export function primarySurface(rawBody: string): {
    system: unknown;
    tools: unknown;
    messages: unknown;
} {
    const body = JSON.parse(rawBody) as Record<string, unknown>;
    return {
        system:
            body.system ??
            body.instructions ??
            (body.messages as Array<{ role: string }> | undefined)?.filter(
                (message) => message.role === "system",
            ),
        tools: body.tools,
        messages: body.messages ?? body.input,
    };
}
