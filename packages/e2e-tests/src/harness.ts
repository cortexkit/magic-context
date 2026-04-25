/**
 * TestHarness — one-stop facade for end-to-end scenarios.
 *
 * Wraps the mock Anthropic server, the `opencode serve` subprocess, and the SDK client
 * into a single object. Also exposes helpers for inspecting both OpenCode's database
 * and magic-context's `context.db` so tests can assert on persisted state.
 *
 * Usage:
 *
 *   const h = await TestHarness.create({ magicContextConfig: { execute_threshold_percentage: 40 } });
 *   h.mock.script([{ text: "ok", usage: { input_tokens: 100, output_tokens: 10 } }]);
 *   const sessionId = await h.createSession();
 *   await h.sendPrompt(sessionId, "hello");
 *   expect(h.mock.requests().length).toBe(1);
 *   await h.dispose();
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { MockProvider, type MockResponse } from "./mock-provider/server";
import { spawnOpencode, type SpawnedOpencode, type SpawnOptions } from "./opencode-runner/spawn";

export interface TestHarnessOptions {
    /** magic-context config overrides. Merged onto test defaults. */
    magicContextConfig?: Record<string, unknown>;
    /** Extra opencode.json config. Merged onto test defaults. */
    openCodeConfigExtra?: Record<string, unknown>;
    /** Override the mock model's context token limit. Default 200000. */
    modelContextLimit?: number;
    /**
     * Default response used when the mock queue is empty. Lets tests send extra
     * prompts without worrying about scripting every one.
     */
    mockDefault?: MockResponse;
}

export interface SdkClient {
    session: {
        create: (opts: {
            query: { directory: string };
            body?: { parentID?: string; title?: string };
        }) => Promise<{ data?: { id: string } }>;
        prompt: (opts: {
            path: { id: string };
            body: {
                model: { providerID: string; modelID: string };
                parts: Array<{ type: "text"; text: string }>;
                agent?: string;
            };
        }) => Promise<{ data?: unknown }>;
    };
}

const DEFAULT_MOCK_RESPONSE: MockResponse = {
    text: "ok",
    usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 0,
    },
};

export class TestHarness {
    readonly mock: MockProvider;
    readonly opencode: SpawnedOpencode;
    readonly client: SdkClient;

    private contextDbCached: Database | null = null;

    private constructor(mock: MockProvider, opencode: SpawnedOpencode, client: SdkClient) {
        this.mock = mock;
        this.opencode = opencode;
        this.client = client;
    }

    static async create(options: TestHarnessOptions = {}): Promise<TestHarness> {
        const mock = new MockProvider();
        const { baseURL } = await mock.start();

        // Always install a default so unexpected extra requests don't 500.
        mock.setDefault(options.mockDefault ?? DEFAULT_MOCK_RESPONSE);

        const spawnOpts: SpawnOptions = {
            mockProviderURL: baseURL,
            magicContextConfig: options.magicContextConfig,
            openCodeConfigExtra: options.openCodeConfigExtra,
            modelContextLimit: options.modelContextLimit,
        };
        const opencode = await spawnOpencode(spawnOpts);

        const sdk = await import("@opencode-ai/sdk");
        const client = sdk.createOpencodeClient({ baseUrl: opencode.url }) as unknown as SdkClient;

        return new TestHarness(mock, opencode, client);
    }

    /** Create a session bound to the isolated workdir. Throws on failure. */
    async createSession(): Promise<string> {
        const res = await this.client.session.create({
            query: { directory: this.opencode.env.workdir },
        });
        if (!res.data) {
            throw new Error(
                `session.create failed. stderr:\n${this.opencode.stderr()}\nstdout:\n${this.opencode.stdout()}`,
            );
        }
        return res.data.id;
    }

    /**
     * Create a child session (subagent) with the given parent. Mirrors what
     * OpenCode's `task` tool does internally: posts to /session with a
     * `parentID` body. The plugin's event-handler reads `parentID` from the
     * `session.created` event and marks the row `isSubagent=true`.
     *
     * Use this to drive subagent-specific behavior: reduced feature mode,
     * heuristic cleanup without historian, no 85%/95% emergency paths, no
     * nudges, no §N§ prefix injection.
     */
    async createChildSession(parentId: string, title?: string): Promise<string> {
        const res = await this.client.session.create({
            query: { directory: this.opencode.env.workdir },
            body: { parentID: parentId, ...(title ? { title } : {}) },
        });
        if (!res.data) {
            throw new Error(
                `child session.create failed. stderr:\n${this.opencode.stderr()}\nstdout:\n${this.opencode.stdout()}`,
            );
        }
        return res.data.id;
    }

    /**
     * Read the persisted `isSubagent` flag for a session from context.db.
     * Returns null if the session_meta row doesn't exist yet (plugin may not
     * have processed the `session.created` event yet — wait with `waitFor`).
     */
    isSubagent(sessionId: string): boolean | null {
        try {
            const db = this.contextDb();
            const row = db
                .prepare("SELECT is_subagent FROM session_meta WHERE session_id = ?")
                .get(sessionId) as { is_subagent: number } | null;
            if (!row) return null;
            return row.is_subagent === 1;
        } catch {
            return null;
        }
    }

    /**
     * Count tags in a specific status for a session. Status is one of
     * "active" | "dropped" (magic-context's TagStatus). Useful for
     * verifying heuristic cleanup actually dropped tool tags.
     */
    countTagsByStatus(sessionId: string, status: string): number {
        try {
            const db = this.contextDb();
            const row = db
                .prepare(
                    "SELECT COUNT(*) AS n FROM tags WHERE session_id = ? AND status = ?",
                )
                .get(sessionId, status) as { n: number } | null;
            return row?.n ?? 0;
        } catch {
            return 0;
        }
    }

    /**
     * Send a user prompt. Returns the raw prompt response.
     * Default model routes to our mock-anthropic provider. Callers can override.
     */
    async sendPrompt(
        sessionId: string,
        text: string,
        options: {
            modelID?: string;
            providerID?: string;
            agent?: string;
            timeoutMs?: number;
        } = {},
    ): Promise<unknown> {
        const timeoutMs = options.timeoutMs ?? 30_000;
        const promptPromise = this.client.session.prompt({
            path: { id: sessionId },
            body: {
                model: {
                    providerID: options.providerID ?? "mock-anthropic",
                    modelID: options.modelID ?? "mock-sonnet",
                },
                parts: [{ type: "text", text }],
                ...(options.agent ? { agent: options.agent } : {}),
            },
        });
        const timeout = new Promise<null>((r) => setTimeout(() => r(null), timeoutMs));
        const result = await Promise.race([promptPromise, timeout]);
        if (result === null) {
            throw new Error(
                `sendPrompt did not complete within ${timeoutMs}ms. stderr:\n${this.opencode.stderr().slice(-2000)}`,
            );
        }
        return result;
    }

    /**
     * Open the magic-context SQLite database in read-only mode.
     * Cached per harness so repeated calls share the handle.
     */
    contextDb(): Database {
        if (this.contextDbCached) return this.contextDbCached;
        // Plugin v0.16+ uses the shared cortexkit/magic-context path so OpenCode
        // and Pi can share state. See packages/plugin/src/shared/data-path.ts.
        const dbPath = join(
            this.opencode.env.dataDir,
            "cortexkit",
            "magic-context",
            "context.db",
        );
        if (!existsSync(dbPath)) {
            throw new Error(`context.db not found at ${dbPath} — plugin may not have initialized yet.`);
        }
        this.contextDbCached = new Database(dbPath, { readonly: true });
        return this.contextDbCached;
    }

    /** Whether the plugin has created its database yet. */
    hasContextDb(): boolean {
        const dbPath = join(
            this.opencode.env.dataDir,
            "cortexkit",
            "magic-context",
            "context.db",
        );
        return existsSync(dbPath);
    }

    /** Poll until `predicate` returns true or `timeoutMs` elapses. */
    async waitFor<T>(
        predicate: () => T | null | undefined | false,
        opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
    ): Promise<T> {
        const timeoutMs = opts.timeoutMs ?? 10_000;
        const intervalMs = opts.intervalMs ?? 100;
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const value = predicate();
            if (value) return value as T;
            await Bun.sleep(intervalMs);
        }
        throw new Error(
            `waitFor timed out after ${timeoutMs}ms${opts.label ? ` (${opts.label})` : ""}`,
        );
    }

    /**
     * Count compartments for a session. Returns 0 if the table is empty or missing.
     */
    countCompartments(sessionId: string): number {
        try {
            const db = this.contextDb();
            const row = db
                .prepare("SELECT COUNT(*) AS n FROM compartments WHERE session_id = ?")
                .get(sessionId) as { n: number } | null;
            return row?.n ?? 0;
        } catch {
            return 0;
        }
    }

    /** Count tags for a session. Useful to verify the plugin ran at all. */
    countTags(sessionId: string): number {
        try {
            const db = this.contextDb();
            const row = db
                .prepare("SELECT COUNT(*) AS n FROM tags WHERE session_id = ?")
                .get(sessionId) as { n: number } | null;
            return row?.n ?? 0;
        } catch {
            return 0;
        }
    }

    /** All mock requests received in this session. */
    requests() {
        return this.mock.requests();
    }

    async dispose(): Promise<void> {
        if (this.contextDbCached) {
            try {
                this.contextDbCached.close();
            } catch {
                // ignore close errors
            }
            this.contextDbCached = null;
        }
        await this.opencode.kill();
        await this.mock.stop();
    }
}
