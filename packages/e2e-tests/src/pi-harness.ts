/** PiTestHarness — facade for Pi Magic Context e2e tests. */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { MockProvider, type MockResponse } from "./mock-provider/server";
import {
    createPiIsolatedEnv,
    type PiIsolatedEnv,
    type PiRunResult,
    spawnPiTurn,
} from "./pi-runner/spawn";

export interface PiTestHarnessOptions {
    magicContextConfig?: Record<string, unknown>;
    piSettingsExtra?: Record<string, unknown>;
    modelContextLimit?: number;
    mockDefault?: MockResponse;
    /** Share the cortexkit DB with another harness. */
    sharedDataDir?: string;
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

export class PiTestHarness {
    readonly mock: MockProvider;
    readonly env: PiIsolatedEnv;

    private readonly options: PiTestHarnessOptions;
    private contextDbCached: Database | null = null;
    private turns: PiRunResult[] = [];

    private constructor(mock: MockProvider, env: PiIsolatedEnv, options: PiTestHarnessOptions) {
        this.mock = mock;
        this.env = env;
        this.options = options;
    }

    static async create(options: PiTestHarnessOptions = {}): Promise<PiTestHarness> {
        const mock = new MockProvider();
        await mock.start();
        mock.setDefault(options.mockDefault ?? DEFAULT_MOCK_RESPONSE);
        const env = createPiIsolatedEnv(options.sharedDataDir);
        return new PiTestHarness(mock, env, options);
    }

    async sendPrompt(
        text: string,
        options: { timeoutMs?: number; continueSession?: boolean } = {},
    ): Promise<PiRunResult> {
        const { result } = await spawnPiTurn(text, {
            env: this.env,
            mockProviderURL: this.mockBaseURL(),
            magicContextConfig: this.options.magicContextConfig,
            piSettingsExtra: this.options.piSettingsExtra,
            modelContextLimit: this.options.modelContextLimit,
            timeoutMs: options.timeoutMs,
            continueSession: options.continueSession,
        });
        this.turns.push(result);
        return result;
    }

    private mockBaseURL(): string {
        const last = this.mock.requests()[0];
        if (last) return `http://${last.headers.host}`;
        // MockProvider doesn't expose baseURL after start; derive it from the Bun server by
        // making the first turn use the URL captured at creation time would add mutable
        // surface. Instead, reach through the stable private field shape in tests.
        const server = (this.mock as unknown as { server?: { port?: number } }).server;
        const port = server?.port;
        if (!port) throw new Error("mock provider is not running");
        return `http://127.0.0.1:${port}`;
    }

    get lastTurn(): PiRunResult | null {
        return this.turns[this.turns.length - 1] ?? null;
    }

    contextDbPath(): string {
        return join(this.env.dataDir, "cortexkit", "magic-context", "context.db");
    }

    contextDb(): Database {
        if (this.contextDbCached) return this.contextDbCached;
        const dbPath = this.contextDbPath();
        if (!existsSync(dbPath)) throw new Error(`context.db not found at ${dbPath}`);
        this.contextDbCached = new Database(dbPath, { readonly: true });
        return this.contextDbCached;
    }

    hasContextDb(): boolean {
        return existsSync(this.contextDbPath());
    }

    countTags(sessionId: string, harness = "pi"): number {
        try {
            const row = this.contextDb()
                .prepare("SELECT COUNT(*) AS n FROM tags WHERE session_id = ? AND harness = ?")
                .get(sessionId, harness) as { n: number } | null;
            return row?.n ?? 0;
        } catch {
            return 0;
        }
    }

    countPendingOps(sessionId: string, harness = "pi"): number {
        try {
            const row = this.contextDb()
                .prepare("SELECT COUNT(*) AS n FROM pending_ops WHERE session_id = ? AND harness = ?")
                .get(sessionId, harness) as { n: number } | null;
            return row?.n ?? 0;
        } catch {
            return 0;
        }
    }

    countDroppedTags(sessionId: string, harness = "pi"): number {
        try {
            const row = this.contextDb()
                .prepare("SELECT COUNT(*) AS n FROM tags WHERE session_id = ? AND harness = ? AND status = 'dropped'")
                .get(sessionId, harness) as { n: number } | null;
            return row?.n ?? 0;
        } catch {
            return 0;
        }
    }

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
        throw new Error(`waitFor timed out after ${timeoutMs}ms${opts.label ? ` (${opts.label})` : ""}`);
    }

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
        await this.mock.stop();
    }
}
