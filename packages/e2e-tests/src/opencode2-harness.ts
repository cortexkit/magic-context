import { openTestDb } from "./test-db";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import type { HostCapabilities, HostHarness } from "./host-harness";
import { assertHistorianMockRouting } from "./mock-routing";
import type { MockResponse } from "./mock-provider/server";
import {
    spawnOpencode2,
    waitForPluginActive,
    type OpenCode2SpawnOptions,
} from "./opencode2-runner/spawn";

type OpenCode2Host = Awaited<ReturnType<typeof spawnOpencode2>>;
type OpenCode2Client = ReturnType<typeof OpenCode.make>;

export interface OpenCode2TestHarnessOptions {
    mockModelID?: string;
    thinkingScope?: (body: Record<string, unknown>) => string | undefined;
    prefixBinding?: boolean;
    magicContextConfig?: Record<string, unknown>;
    openCodeConfigExtra?: Record<string, unknown>;
    modelContextLimit?: number;
    mockDefault?: MockResponse;
    expectMagicContext?: boolean;
    /** Absolute path to a second plugin, loaded after Magic Context so its own
     * session hooks observe the draft Magic Context hands back to the host. */
    probePlugin?: string;
    /** Pin the historian to a second mock-backed provider (see OpenCode2SpawnOptions). */
    historianProvider?: { providerID: string; modelID: string; package: string };
    /** models.dev catalogue copied into the throwaway host cache. */
    modelsCatalog?: string;
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

/** Host-contract adapter for the real GA OpenCode 2 process. */
export class OpenCode2TestHarness implements HostHarness {
    readonly host = "opencode2" as const;
    readonly harnessId = "opencode2" as const;
    readonly capabilities: HostCapabilities = {
        childSessions: true,
        nativeCompact: true,
        sessionRemove: true,
        steerDelivery: true,
    };

    private hostInstance: OpenCode2Host;
    private clientInstance: OpenCode2Client;
    private readonly spawnOptions: OpenCode2SpawnOptions;
    private readonly requestEvidence = new Map<string, { offset: number; prompt: string }>();
    private contextDbCached: Database | null = null;
    private readonly expectMagicContext: boolean;

    private constructor(
        host: OpenCode2Host,
        client: OpenCode2Client,
        spawnOptions: OpenCode2SpawnOptions,
        expectMagicContext: boolean,
    ) {
        this.hostInstance = host;
        this.clientInstance = client;
        this.spawnOptions = spawnOptions;
        this.expectMagicContext = expectMagicContext;
    }

    static async create(options: OpenCode2TestHarnessOptions = {}): Promise<OpenCode2TestHarness> {
        const spawnOptions: OpenCode2SpawnOptions = {
            defaultModelID: options.mockModelID,
            thinkingScope: options.thinkingScope,
            prefixBinding: options.prefixBinding,
            magicContextConfig: options.magicContextConfig ?? {},
            extraConfig: options.openCodeConfigExtra,
            modelContextLimit: options.modelContextLimit,
            // Use the other test hosts' output limit so context-pressure assertions
            // reserve the same number of output tokens on every host.
            modelOutputLimit: 8192,
            providerID: "anthropic",
            historianProvider: options.historianProvider,
            modelsCatalog: options.modelsCatalog,
            mockResponse: options.mockDefault ?? DEFAULT_MOCK_RESPONSE,
            probePlugin: options.probePlugin,
        };
        const host = await spawnOpencode2(spawnOptions);
        return new OpenCode2TestHarness(
            host,
            OpenCode2TestHarness.clientFor(host),
            spawnOptions,
            options.expectMagicContext !== false,
        );
    }

    get mock() {
        return this.hostInstance.mock;
    }

    get opencode() {
        return this.hostInstance;
    }

    get serverUrl(): string {
        return this.hostInstance.url;
    }

    get workdir(): string {
        return this.hostInstance.cwd;
    }

    get dataDir(): string {
        return this.hostInstance.env.XDG_DATA_HOME!;
    }

    private static clientFor(host: OpenCode2Host): OpenCode2Client {
        return OpenCode.make({
            baseUrl: host.url,
            headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
        });
    }

    async restart(): Promise<void> {
        this.closeContextDb();
        const previous = this.hostInstance;
        await previous.stopHost();
        this.hostInstance = await spawnOpencode2({
            ...this.spawnOptions,
            existingIsolation: {
                root: previous.root,
                env: previous.env,
                cwd: previous.cwd,
            },
            existingMock: { mock: previous.mock, baseURL: previous.mockBaseURL },
        });
        this.clientInstance = OpenCode2TestHarness.clientFor(this.hostInstance);
        this.requestEvidence.clear();
    }

    async reloadPlugin(): Promise<void> {
        await this.restart();
    }

    async createSession(): Promise<string> {
        const session = await this.clientInstance.session.create({
            location: { directory: this.hostInstance.cwd },
            model: {
                providerID: this.spawnOptions.providerID ?? "openai",
                id: this.spawnOptions.defaultModelID ?? "mock-model",
            },
        });
        await waitForPluginActive(this.clientInstance, this.hostInstance.cwd);
        return session.id;
    }

    async compactSession(sessionId: string): Promise<void> {
        await this.clientInstance.session.compact({ sessionID: sessionId });
        await this.clientInstance.session.wait({ sessionID: sessionId }, { signal: AbortSignal.timeout(60_000) });
    }

    async removeSession(sessionId: string): Promise<void> {
        await this.clientInstance.session.remove({ sessionID: sessionId });
    }

    async sendPrompt(
        sessionId: string,
        text: string,
        options: { timeoutMs?: number } = {},
    ): Promise<unknown> {
        const timeoutMs = options.timeoutMs ?? 180_000;
        this.requestEvidence.set(sessionId, {
            offset: this.mock.requests().length,
            prompt: text,
        });
        this.mock.newUserTurn();
        const prompt = await this.clientInstance.session.prompt({ sessionID: sessionId, text });
        await this.clientInstance.session.wait(
            { sessionID: sessionId },
            { signal: AbortSignal.timeout(timeoutMs) },
        );
        this.assertMagicContextProcessed(sessionId);
        return prompt;
    }

    ballast(tokens: number): string {
        const words = [
            "boundary", "historian", "compartment", "schedule", "pressure",
            "tokens", "window", "publish", "transform", "session", "marker",
            "budget", "eligible", "protected", "ordinal", "snapshot", "replay",
            "decision", "threshold", "baseline", "measure", "archive", "deliver",
        ];
        const target = Math.max(0, Math.round(tokens * 4));
        const parts: string[] = [];
        let length = 0;
        let index = 0;
        while (length < target) {
            const word = words[index % words.length]!;
            parts.push(`${word}${index % 17 === 0 ? "." : ""}`);
            length += word.length + 1;
            index += 1;
        }
        return parts.join(" ");
    }

    assertMagicContextProcessed(sessionId: string): void {
        if (!this.expectMagicContext) return;
        const evidence = this.requestEvidence.get(sessionId);
        if (!evidence) {
            throw new Error(`OpenCode 2 has no submitted prompt evidence for session ${sessionId}`);
        }
        const transformed = this.mock
            .requests()
            .slice(evidence.offset)
            .some((request) => {
                const body = JSON.stringify(request.body);
                const hasTransformedHead =
                    body.includes("<session-history>") || body.includes("<conversation-checkpoint>");
                const serializedPrompt = JSON.stringify(evidence.prompt).slice(1, -1);
                return hasTransformedHead && body.includes(serializedPrompt);
            });
        if (!transformed) {
            throw new Error(`OpenCode 2 Magic Context did not transform session ${sessionId}\n${this.hostInstance.stderr()}`);
        }
    }

    async waitForMockQuiescence(opts: { quietMs?: number; label?: string } = {}): Promise<void> {
        const quietMs = opts.quietMs ?? 250;
        let stableRequestCount: number | null = null;
        let quietSince = 0;
        await this.waitFor(
            () => {
                const requests = this.mock.requests();
                if (requests.some((request) => request.responseCompletedAt === undefined)) {
                    stableRequestCount = null;
                    return false;
                }
                if (stableRequestCount !== requests.length) {
                    stableRequestCount = requests.length;
                    quietSince = Date.now();
                    return false;
                }
                return Date.now() - quietSince >= quietMs;
            },
            { intervalMs: Math.min(50, quietMs), label: opts.label ?? "mock provider quiescence" },
        );
    }

    async waitFor<T>(
        predicate: () => T | null | undefined | false,
        opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
    ): Promise<T> {
        const timeoutMs = opts.timeoutMs ?? 60_000;
        const intervalMs = opts.intervalMs ?? 100;
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const value = predicate();
            if (value) return value as T;
            await Bun.sleep(intervalMs);
        }
        throw new Error(`waitFor timed out after ${timeoutMs}ms${opts.label ? ` (${opts.label})` : ""}`);
    }

    contextDbPath(): string {
        return join(
            this.dataDir,
            "cortexkit",
            "magic-context",
            "context.db",
        );
    }

    contextDb(): Database {
        if (this.contextDbCached) return this.contextDbCached;
        const path = this.contextDbPath();
        if (!existsSync(path)) throw new Error(`context.db not found at ${path}`);
        this.contextDbCached = openTestDb(path, { readonly: true });
        return this.contextDbCached;
    }

    hasContextDb(): boolean {
        return existsSync(this.contextDbPath());
    }

    countCompartments(sessionId: string): number {
        return this.countRows("compartments", sessionId);
    }

    countTags(sessionId: string): number {
        return this.countRows("tags", sessionId);
    }

    countTagsByStatus(sessionId: string, status: string): number {
        try {
            const row = this.contextDb()
                .prepare(
                    "SELECT COUNT(*) AS n FROM tags WHERE session_id = ? AND harness = ? AND status = ?",
                )
                .get(sessionId, this.harnessId, status) as { n: number } | null;
            return row?.n ?? 0;
        } catch {
            return 0;
        }
    }

    private countRows(table: "compartments" | "tags", sessionId: string): number {
        try {
            const row = this.contextDb()
                .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ? AND harness = ?`)
                .get(sessionId, this.harnessId) as { n: number } | null;
            return row?.n ?? 0;
        } catch {
            return 0;
        }
    }

    requests() {
        return this.mock.requests();
    }

    diagnostics(): string {
        return `stdout:\n${this.hostInstance.stdout()}\nstderr:\n${this.hostInstance.stderr()}`;
    }

    assertHistorianRequestsUseMock(): void {
        if (this.hasContextDb()) {
            const pinned = this.spawnOptions.historianProvider;
            assertHistorianMockRouting(
                this.contextDb(),
                this.harnessId,
                pinned
                    ? `${pinned.providerID}/${pinned.modelID}`
                    : `${this.spawnOptions.providerID ?? "openai"}/${this.spawnOptions.defaultModelID ?? "mock-model"}`,
            );
        }
    }

    private closeContextDb(): void {
        if (!this.contextDbCached) return;
        try {
            this.contextDbCached.close();
        } catch {
            // The host still needs cleanup if a cached test reader was already closed.
        }
        this.contextDbCached = null;
    }

    async dispose(): Promise<void> {
        try {
            this.assertHistorianRequestsUseMock();
        } finally {
            this.closeContextDb();
            await this.hostInstance.stop();
        }
    }
}
