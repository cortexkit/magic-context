/** PiTestHarness — facade for Pi Magic Context e2e tests. */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { MockProvider, type MockResponse } from "./mock-provider/server";
import { createPiIsolatedEnv, type PiIsolatedEnv, type PiRunResult } from "./pi-runner/spawn";
import {
  PiRpcClient,
  type PiMessage,
  type PiRpcEvent,
  type PiSessionStats,
  type PiState,
  requireSuccessfulResponse,
} from "./pi-runner/rpc-client";

export interface PiTestHarnessOptions {
  magicContextConfig?: Record<string, unknown>;
  piSettingsExtra?: Record<string, unknown>;
  modelContextLimit?: number;
  mockDefault?: MockResponse;
  /** Share the cortexkit DB with another harness. */
  sharedDataDir?: string;
  /** Optional working directory override before the persistent Pi process starts. */
  workdir?: string;
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

  private readonly rpc: PiRpcClient;
  private contextDbCached: Database | null = null;
  private turns: PiRunResult[] = [];

  private constructor(mock: MockProvider, rpc: PiRpcClient) {
    this.mock = mock;
    this.rpc = rpc;
    this.env = rpc.env;
  }

  static async create(options: PiTestHarnessOptions = {}): Promise<PiTestHarness> {
    const mock = new MockProvider();
    await mock.start();
    mock.setDefault(options.mockDefault ?? DEFAULT_MOCK_RESPONSE);
    const env = createPiIsolatedEnv(options.sharedDataDir);
    if (options.workdir) env.workdir = options.workdir;
    const rpc = new PiRpcClient({
      env,
      mockProviderURL: PiTestHarness.mockBaseURL(mock),
      magicContextConfig: options.magicContextConfig,
      piSettingsExtra: options.piSettingsExtra,
      modelContextLimit: options.modelContextLimit,
    });

    try {
      await rpc.start();
    } catch (error) {
      await mock.stop();
      throw error;
    }

    return new PiTestHarness(mock, rpc);
  }

  async sendPrompt(
    text: string,
    options: { timeoutMs?: number; continueSession?: boolean; images?: unknown[] } = {},
  ): Promise<PiRunResult> {
    const timeoutMs = options.timeoutMs ?? 60_000;
    const events: PiRpcEvent[] = [];
    let capturing = false;
    const unsubscribe = this.rpc.onEvent((event) => {
      if (event.type === "agent_start") capturing = true;
      if (capturing) events.push(event);
    });
    const agentEnd = this.rpc.waitForEvent(
      (event) => capturing && event.type === "agent_end",
      { timeoutMs, label: "agent_end" },
    );

    try {
      const promptResponse = await this.rpc.sendCommand(
        "prompt",
        { message: text, ...(options.images ? { images: options.images } : {}) },
        { timeoutMs, label: "prompt response" },
      );
      requireSuccessfulResponse(promptResponse);
      await agentEnd;
      const state = await this.getState();
      const result: PiRunResult = {
        sessionId: typeof state.sessionId === "string" ? state.sessionId : null,
        events: events as Array<Record<string, unknown>>,
        stdout: events.map((event) => JSON.stringify(event)).join("\n"),
        stderr: this.rpc.getStderr(),
        exitCode: null,
        signalCode: null,
      };
      this.turns.push(result);
      return result;
    } catch (error) {
      void agentEnd.catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}\n--- pi rpc stderr ---\n${this.rpc.getStderr()}`);
    } finally {
      unsubscribe();
    }
  }

  private static mockBaseURL(mock: MockProvider): string {
    const last = mock.requests()[0];
    if (last) return `http://${last.headers.host}`;
    // MockProvider doesn't expose baseURL after start; derive it from the Bun server by
    // reaching through the stable private field shape in tests.
    const server = (mock as unknown as { server?: { port?: number } }).server;
    const port = server?.port;
    if (!port) throw new Error("mock provider is not running");
    return `http://127.0.0.1:${port}`;
  }

  async getState(): Promise<PiState> {
    const response = await this.rpc.sendCommand<PiState>("get_state");
    return requireSuccessfulResponse(response);
  }

  async getMessages(): Promise<PiMessage[]> {
    const response = await this.rpc.sendCommand<{ messages: PiMessage[] }>("get_messages");
    return requireSuccessfulResponse(response).messages;
  }

  async getSessionStats(): Promise<PiSessionStats> {
    const response = await this.rpc.sendCommand<PiSessionStats>("get_session_stats");
    return requireSuccessfulResponse(response);
  }

  async compactNow(): Promise<void> {
    const response = await this.rpc.sendCommand("compact");
    requireSuccessfulResponse(response);
  }

  async newSession(): Promise<void> {
    const response = await this.rpc.sendCommand<{ cancelled?: boolean }>("new_session");
    const data = requireSuccessfulResponse(response);
    if (data?.cancelled) throw new Error("Pi new_session was cancelled by an extension");
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
    await this.rpc.shutdown();
    await this.mock.stop();
  }
}
