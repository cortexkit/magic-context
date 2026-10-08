/** PiTestHarness — facade for Pi Magic Context e2e tests. */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HostCapabilities, PiHostHarness } from "./host-harness";
import { assertHistorianMockRouting } from "./mock-routing";
import {
  type CapturedRequest,
  MockProvider,
  type MockResponse,
} from "./mock-provider/server";
import { prepareContextDatabase } from "./prepare-context-db";
import {
  createPiIsolatedEnv,
  type PiIsolatedEnv,
  type PiRunnerHost,
  type PiRunResult,
} from "./pi-runner/spawn";
import {
  PiRpcClient,
  type PiMessage,
  type PiRpcEvent,
  type PiSessionStats,
  type PiState,
  requireSuccessfulResponse,
} from "./pi-runner/rpc-client";

export interface PiTestHarnessOptions {
  host?: PiRunnerHost;
  magicContextConfig?: Record<string, unknown>;
  piSettingsExtra?: Record<string, unknown>;
  modelContextLimit?: number;
  mockDefault?: MockResponse;
  extensionsBeforeMagicContext?: string[];
  /** Share the cortexkit DB with another harness. */
  sharedDataDir?: string;
  /** Optional working directory override before the persistent Pi process starts. */
  workdir?: string;
  /** Start Pi in its (throwaway) HOME directory instead of a project folder. */
  workdirIsHome?: boolean;
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

const RPC_EVENT_DIAGNOSTIC_TAIL = 12;

/**
 * Text OMP uses when it refuses a prompt because a run already owns the agent.
 * `AgentSession.prompt` reaches `throw new AgentBusyError()` and that class
 * carries this message with no machine-readable code alongside it
 * (@oh-my-pi/pi-agent-core 18.2.6, src/agent.ts), so the text is the only
 * signal an RPC client gets.
 */
const OMP_AGENT_BUSY_ERROR = "Agent is already processing";

/** How often to re-read OMP's streaming flag while waiting for it to clear. */
const OMP_IDLE_POLL_INTERVAL_MS = 25;

/** What a prompt submission did, once OMP has had its say about it. */
type PromptSubmission =
  | { kind: "admitted" }
  | { kind: "refused"; refusal: OmpPromptRefusal };

interface OmpPromptRefusal {
  /** OMP's own refusal text, carried into the harness failure verbatim. */
  error: string;
  /**
   * Terminal agent_end count observed when the refusal arrived. The run that
   * owns the agent has not reported its end yet, so the retry waits for the
   * count to move past this before submitting again.
   */
  terminalAgentEndsSeen: number;
}

/**
 * OMP ends a continuation that is still part of the same turn with
 * `isTerminal: false`; only an end without that marker means the agent is done.
 */
function isTerminalAgentEnd(event: PiRpcEvent): boolean {
  return event.type === "agent_end" && event.isTerminal !== false;
}

/**
 * OMP answers a `prompt` command as soon as it has handed the text to the
 * session, before the agent run starts, and reports a later refusal as a
 * second response record for the same command. By then nothing is waiting on
 * that id, so it reaches the harness through the event stream rather than as
 * the command's result.
 */
function isAgentBusyPromptRejection(event: PiRpcEvent): boolean {
  return event.type === "response" &&
    event.command === "prompt" &&
    event.success === false &&
    typeof event.error === "string" &&
    event.error.includes(OMP_AGENT_BUSY_ERROR);
}

/** The refusal text when a `prompt` command itself came back refused, else null. */
function agentBusyResponseError(response: { success: boolean; error?: string }): string | null {
  if (response.success) return null;
  const error = response.error;
  return typeof error === "string" && error.includes(OMP_AGENT_BUSY_ERROR) ? error : null;
}

/**
 * Whether a failure is one the RPC event tail and last provider request explain.
 * Both waiting failures and a refusal are caused by something visible there.
 */
function needsRpcWaitDiagnostics(message: string): boolean {
  return message.includes("waiting for Pi RPC event") ||
    message.includes("waiting for the OMP agent to go idle") ||
    message.includes(OMP_AGENT_BUSY_ERROR);
}

function summarizeContent(content: unknown): { characters: number; preview: string } | { kind: string } {
  let text: string | undefined;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .filter((part): part is { type?: string; text: string } =>
        typeof part === "object" && part !== null && "text" in part && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
  }
  if (text !== undefined) {
    return { characters: text.length, preview: text.slice(0, 160) };
  }
  return { kind: content === null ? "null" : typeof content };
}

function summarizeMessage(message: unknown): Record<string, unknown> {
  if (typeof message !== "object" || message === null) return { kind: typeof message };
  const record = message as Record<string, unknown>;
  return {
    ...(typeof record.role === "string" ? { role: record.role } : {}),
    ...(typeof record.customType === "string" ? { customType: record.customType } : {}),
    ...(typeof record.stopReason === "string" ? { stopReason: record.stopReason } : {}),
    ...(Object.hasOwn(record, "content") ? { content: summarizeContent(record.content) } : {}),
  };
}

function summarizeRpcEvent(event: PiRpcEvent): string {
  const messages = Array.isArray(event.messages) ? event.messages : undefined;
  return JSON.stringify({
    type: event.type ?? "unknown",
    ...(typeof event.isTerminal === "boolean" ? { isTerminal: event.isTerminal } : {}),
    ...(messages
      ? { messageCount: messages.length, messageTail: messages.slice(-3).map(summarizeMessage) }
      : {}),
    ...(Object.hasOwn(event, "message") ? { message: summarizeMessage(event.message) } : {}),
    ...(typeof event.error === "string" ? { error: event.error.slice(0, 240) } : {}),
  });
}

function summarizeLastMockRequest(request: CapturedRequest | null | undefined): string {
  if (!request) return "(none)";
  const messages = Array.isArray(request.body.messages) ? request.body.messages : [];
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  let bodyBytes: number | "unserializable" = "unserializable";
  try {
    bodyBytes = Buffer.byteLength(JSON.stringify(request.body));
  } catch {
    // Keep timeout reporting best-effort even if a test supplied a cyclic body.
  }
  return JSON.stringify({
    path: request.path,
    model: request.body.model ?? null,
    bodyBytes,
    messageCount: messages.length,
    roles: messages.map((message) => message.role),
    lastUser: lastUser ? summarizeMessage(lastUser) : null,
    response: request.responseCompletedAt === undefined ? "pending" : "completed",
  });
}

export class PiTestHarness implements PiHostHarness {
  readonly host: PiRunnerHost;
  readonly harnessId: PiRunnerHost;
  readonly capabilities: HostCapabilities = {
    childSessions: false,
    nativeCompact: true,
    sessionRemove: false,
    steerDelivery: true,
  };
  readonly mock: MockProvider;
  readonly env: PiIsolatedEnv;

  private readonly rpc: PiRpcClient;
  private readonly expectMagicContext: boolean;
  private contextDbCached: Database | null = null;
  private turns: PiRunResult[] = [];

  private constructor(
    host: PiRunnerHost,
    mock: MockProvider,
    rpc: PiRpcClient,
    expectMagicContext: boolean,
  ) {
    this.host = host;
    this.harnessId = host;
    this.mock = mock;
    this.rpc = rpc;
    this.env = rpc.env;
    this.expectMagicContext = expectMagicContext;
  }

  static async create(options: PiTestHarnessOptions = {}): Promise<PiTestHarness> {
    const mock = new MockProvider();
    await mock.start();
    mock.setDefault(options.mockDefault ?? DEFAULT_MOCK_RESPONSE);
    const host = options.host ?? "pi";
    const env = createPiIsolatedEnv(options.sharedDataDir, host);
    if (options.workdir) env.workdir = options.workdir;
    if (options.workdirIsHome) env.workdir = env.baseDir;
    // A released plugin build under MC_E2E_PI_PLUGIN_ROOT owns an older schema
    // and refuses a database this checkout migrated ahead of it.
    if (options.magicContextConfig?.enabled !== false && !process.env.MC_E2E_PI_PLUGIN_ROOT) {
      try {
        prepareContextDatabase(env.dataDir);
      } catch (error) {
        await mock.stop();
        throw error;
      }
    }
    const rpc = new PiRpcClient({
      host,
      env,
      mockProviderURL: PiTestHarness.mockBaseURL(mock),
      magicContextConfig: options.magicContextConfig,
      piSettingsExtra: options.piSettingsExtra,
      modelContextLimit: options.modelContextLimit,
      extensionsBeforeMagicContext: options.extensionsBeforeMagicContext,
    });

    try {
      await rpc.start();
    } catch (error) {
      await Promise.allSettled([rpc.shutdown(), mock.stop()]);
      throw error;
    }

    return new PiTestHarness(host, mock, rpc, options.magicContextConfig?.enabled !== false);
  }

  get serverUrl(): null {
    return null;
  }

  get workdir(): string {
    return this.env.workdir;
  }

  /** Process id of the running Pi host, for inspecting what it has open. */
  get hostPid(): number | undefined {
    return this.rpc.pid;
  }

  get dataDir(): string {
    return this.env.dataDir;
  }

  /**
   * Generate ~`tokens` tokens of varied prose ballast. Mirror of
   * TestHarness.ballast (see harness.ts): the v3 protected-tail boundary
   * measures TRUE-RAW content, not mock usage numbers, so pressure-driving
   * turns must carry real content mass or the boundary resolves no eligible
   * head and the historian (correctly) never starts.
   */
  ballast(tokens: number): string {
    const words = [
      "boundary", "historian", "compartment", "schedule", "pressure",
      "tokens", "window", "publish", "transform", "session", "marker",
      "budget", "eligible", "protected", "ordinal", "snapshot", "replay",
      "decision", "threshold", "baseline", "measure", "archive", "deliver",
    ];
    const target = Math.max(0, Math.round(tokens * 4)); // ~4 chars/token
    const parts: string[] = [];
    let length = 0;
    let i = 0;
    while (length < target) {
      const w = words[i % words.length];
      parts.push(`${w}${i % 17 === 0 ? "." : ""}`);
      length += w.length + 1;
      i += 1;
    }
    return parts.join(" ");
  }

  async createSession(): Promise<string> {
    const state = await this.getState();
    if (state.sessionId) return state.sessionId;
    await this.newSession();
    const nextState = await this.getState();
    if (!nextState.sessionId) throw new Error(`${this.host} did not report a session id`);
    return nextState.sessionId;
  }

  async removeSession(_sessionId: string): Promise<void> {
    throw new Error(`${this.host} does not expose terminal session removal`);
  }

  async sendPrompt(
    text: string,
    options?: { timeoutMs?: number; continueSession?: boolean; images?: unknown[] },
  ): Promise<PiRunResult>;
  async sendPrompt(
    sessionId: string,
    text: string,
    options?: { timeoutMs?: number; continueSession?: boolean; images?: unknown[] },
  ): Promise<PiRunResult>;
  async sendPrompt(
    sessionOrText: string,
    textOrOptions: string | { timeoutMs?: number; continueSession?: boolean; images?: unknown[] } = {},
    contractOptions: { timeoutMs?: number; continueSession?: boolean; images?: unknown[] } = {},
  ): Promise<PiRunResult> {
    const contractCall = typeof textOrOptions === "string";
    const text = contractCall ? textOrOptions : sessionOrText;
    const options = contractCall ? contractOptions : textOrOptions;
    if (contractCall) {
      const state = await this.getState();
      if (state.sessionId !== sessionOrText) {
        throw new Error(
          `${this.host} prompt targeted session ${sessionOrText}, but the active session is ${state.sessionId ?? "missing"}`,
        );
      }
    }
    // Default bumped from 60s → 180s. Pi historian + ctx_search work spawn a
    // `pi --print` subprocess that calls the mock provider over HTTP, which on
    // GitHub-hosted ubuntu runners is ~3-5x slower than local hardware. 180s
    // covers the slowest known Pi paths (historian + compartment publish chain)
    // while still bounding tests. Individual call sites can pass smaller values.
    const timeoutMs = options.timeoutMs ?? 180_000;
    // Everything below — the idle wait, the submission, one retry, and the wait
    // for the turn to end — shares this single per-turn budget.
    const deadline = Date.now() + timeoutMs;
    const remainingMs = () => Math.max(1, deadline - Date.now());
    const events: PiRpcEvent[] = [];
    const recentEvents: PiRpcEvent[] = [];
    let capturing = false;
    let submittedTurnEnded = false;
    let terminalAgentEnds = 0;
    const terminalAgentEndWaiters = new Set<() => void>();
    let notifyRefusal: ((refusal: OmpPromptRefusal) => void) | undefined;
    const unsubscribe = this.rpc.onEvent((event) => {
      recentEvents.push(event);
      if (recentEvents.length > RPC_EVENT_DIAGNOSTIC_TAIL) recentEvents.shift();
      if (event.type === "agent_start") capturing = true;
      if (capturing) events.push(event);
      if (isTerminalAgentEnd(event)) {
        terminalAgentEnds++;
        for (const waiter of [...terminalAgentEndWaiters]) waiter();
      }
      if (event.type === "agent_end" && Array.isArray(event.messages)) {
        submittedTurnEnded ||= event.messages.some((message: { role?: string; content?: unknown }) => {
          if (message.role !== "user") return false;
          const content = typeof message.content === "string"
            ? message.content
            : Array.isArray(message.content)
              ? message.content.filter((part) => part.type === "text").map((part) => part.text).join("")
              : undefined;
          return content === text;
        });
      }
      if (isAgentBusyPromptRejection(event)) {
        notifyRefusal?.({ error: String(event.error), terminalAgentEndsSeen: terminalAgentEnds });
      }
    });
    // Pi signals that a turn is fully finished with agent_settled, including after
    // an extension starts another continuation. OMP has no agent_settled event and
    // can emit a non-terminal agent_end before that continuation finishes, so wait
    // for a terminal agent_end before allowing the next prompt.
    const agentEnd = this.rpc.waitForEvent(
      (event) =>
        submittedTurnEnded &&
        event.type === (this.host === "omp" ? "agent_end" : "agent_settled") &&
        (this.host !== "omp" || event.isTerminal !== false),
      {
        timeoutMs,
        label: this.host === "omp" ? "submitted turn terminal agent_end" : "submitted turn agent_settled",
      },
    );

    // Resolve once a terminal agent_end arrives beyond the `seen` count. A
    // refusal and the end of the run that caused it can reach the harness in one
    // synchronous burst of stdout lines, so this compares counts instead of
    // subscribing after the refusal has already been handled.
    const waitForTerminalAgentEndAfter = (seen: number, label: string): Promise<void> => {
      if (terminalAgentEnds > seen) return Promise.resolve();
      const waitMs = remainingMs();
      return new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        const check = () => {
          if (terminalAgentEnds <= seen) return;
          clearTimeout(timer);
          terminalAgentEndWaiters.delete(check);
          resolve();
        };
        timer = setTimeout(() => {
          terminalAgentEndWaiters.delete(check);
          reject(new Error(`Timed out after ${waitMs}ms waiting for Pi RPC event (${label})`));
        }, waitMs);
        terminalAgentEndWaiters.add(check);
      });
    };

    const submitPrompt = async (label: string): Promise<PromptSubmission> => {
      if (this.host === "omp") await this.waitForOmpIdle(deadline, label);
      const refused = new Promise<OmpPromptRefusal>((resolve) => { notifyRefusal = resolve; });
      const promptResponse = await this.rpc.sendCommand(
        "prompt",
        { message: text, ...(options.images ? { images: options.images } : {}) },
        { timeoutMs: remainingMs(), label: "prompt response" },
      );
      const directRefusal = agentBusyResponseError(promptResponse);
      if (directRefusal) {
        return { kind: "refused", refusal: { error: directRefusal, terminalAgentEndsSeen: terminalAgentEnds } };
      }
      requireSuccessfulResponse(promptResponse);
      // The command is acknowledged before the run starts, so a refusal can still
      // be on its way. Whichever of the two arrives first decides this attempt.
      return await Promise.race<PromptSubmission>([
        agentEnd.then(() => ({ kind: "admitted" as const })),
        refused.then((refusal) => ({ kind: "refused" as const, refusal })),
      ]);
    };

    try {
      let submission = await submitPrompt("OMP idle before prompt submission");
      if (submission.kind === "refused") {
        // Magic Context delivers its Channel-2 ceiling nudge as a steer, which
        // starts a run of its own after the previous turn already reported a
        // terminal agent_end. This prompt landed inside that run. Let the run
        // finish and submit once more — one retry only, so a host that stays busy
        // surfaces as a failure instead of spinning.
        await waitForTerminalAgentEndAfter(
          submission.refusal.terminalAgentEndsSeen,
          "terminal agent_end of the run that refused the prompt",
        );
        submission = await submitPrompt("OMP idle before prompt resubmission");
        if (submission.kind === "refused") {
          throw new Error(`OMP refused the resubmitted prompt: ${submission.refusal.error}`);
        }
      }
      await agentEnd;
      const extensionErrors = this.rpc.getExtensionErrors();
      if (extensionErrors.length > 0) {
        throw new Error(`Pi extension error: ${JSON.stringify(extensionErrors)}`);
      }
      const state = await this.getState();
      const sessionId = typeof state.sessionId === "string" ? state.sessionId : null;
      // Extension diagnostics may arrive before this turn's event listener, so
      // require the durable session row rather than trusting a successful model reply.
      if (!sessionId && this.expectMagicContext) {
        throw new Error(`${this.host} did not report a session id for Magic Context verification`);
      }
      if (sessionId) this.assertMagicContextProcessed(sessionId);
      const result: PiRunResult = {
        sessionId,
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
      const timeoutDiagnostics = needsRpcWaitDiagnostics(message)
        ? `\n--- pi rpc event tail ---\n${recentEvents.length > 0 ? recentEvents.map(summarizeRpcEvent).join("\n") : "(empty)"}` +
          `\n--- last mock provider request body summary ---\n${summarizeLastMockRequest(this.mock?.lastRequest())}`
        : "";
      throw new Error(`${message}${timeoutDiagnostics}\n--- pi rpc stderr ---\n${this.rpc.getStderr()}`);
    } finally {
      unsubscribe();
    }
  }

  /**
   * Block until OMP reports that no run owns the agent.
   *
   * OMP refuses a prompt when `AgentSession.isStreaming` holds
   * (`if (this.isStreaming) { ... throw new AgentBusyError(); }` in
   * agent-session.ts) and `get_state` reports that very getter
   * (`isStreaming: session.isStreaming` in the RPC mode's `get_state` handler,
   * @oh-my-pi/pi-coding-agent 18.2.6). Reading it asks the host the same
   * question the host asks itself instead of inferring idleness from events.
   * The flag can still flip between this read and OMP handling the prompt, so
   * callers must also handle a refusal.
   */
  private async waitForOmpIdle(deadline: number, label: string): Promise<void> {
    const startedAt = Date.now();
    while (true) {
      const state = await this.getState();
      if (!state.isStreaming) return;
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out after ${Date.now() - startedAt}ms waiting for the OMP agent to go idle (${label})`,
        );
      }
      await Bun.sleep(OMP_IDLE_POLL_INTERVAL_MS);
    }
  }

  assertMagicContextProcessed(sessionId: string): void {
    if (!this.expectMagicContext) return;
    const processed = this
      .contextDb()
      .prepare("SELECT 1 FROM session_meta WHERE session_id = ? AND harness = ?")
      .get(sessionId, this.harnessId);
    if (!processed) throw new Error(`${this.host} Magic Context did not process session ${sessionId}`);
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

  async compactNowExpectCancelled(): Promise<void> {
    const response = await this.rpc.sendCommand("compact");
    if (response.success || !response.error?.includes("Compaction cancelled")) {
      throw new Error(`Expected Pi compaction cancellation, received ${JSON.stringify(response)}`);
    }
  }

  async invokeExtensionCommand(command: string): Promise<void> {
    const response = await this.rpc.sendCommand("prompt", { message: `/${command}` });
    requireSuccessfulResponse(response);
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = await this.getState();
      if (!state.isStreaming && !state.isCompacting) return;
      await Bun.sleep(20);
    }
    throw new Error(`Pi extension command /${command} did not settle`);
  }

  async newSession(): Promise<void> {
    const response = await this.rpc.sendCommand<{ cancelled?: boolean }>("new_session");
    const data = requireSuccessfulResponse(response);
    if (data?.cancelled) throw new Error("Pi new_session was cancelled by an extension");
  }

  /** Exercise Pi's in-process extension/resource reload without replacing the RPC process. */
  async reloadExtensions(): Promise<void> {
    const response = await this.rpc.sendCommand(
      "prompt",
      { message: "/e2e-reload-extensions" },
      { timeoutMs: 60_000, label: "Pi extension reload" },
    );
    requireSuccessfulResponse(response);
    const extensionErrors = this.rpc.getExtensionErrors();
    if (extensionErrors.length > 0) {
      throw new Error(`Pi extension reload error: ${JSON.stringify(extensionErrors)}`);
    }
  }

  async hasNativeCompactionMarker(ordinal: number): Promise<boolean> {
    const state = await this.getState();
    if (!state.sessionFile) return false;
    // Applied Pi markers live in the host session JSONL, not OpenCode's SQL column.
    return readFileSync(state.sessionFile, "utf8").split("\n").filter(Boolean).some((line) => {
      const entry = JSON.parse(line) as {
        type?: string;
        details?: { source?: string; lastCompactedOrdinal?: number };
      };
      return entry.type === "compaction" &&
        entry.details?.source === "magic-context" &&
        entry.details.lastCompactedOrdinal === ordinal;
    });
  }

  async reloadPlugin(): Promise<void> {
    // OMP's RPC mode leaves ExtensionCommandContext.reload as a no-op.
    // Restart and resume to reload resources without losing the active session.
    if (this.host === "omp") await this.restart();
    else await this.reloadExtensions();
  }

  /** Restart Pi and explicitly resume the same saved session. */
  async restart(): Promise<void> {
    const beforeRestart = await this.getState();
    this.closeContextDb();
    await this.rpc.restart();

    if (!beforeRestart.sessionFile) return;
    const response = await this.rpc.sendCommand<{ cancelled?: boolean }>(
      "switch_session",
      { sessionPath: beforeRestart.sessionFile },
      { timeoutMs: 60_000, label: "resume Pi session after restart" },
    );
    const resumed = requireSuccessfulResponse(response);
    if (resumed.cancelled) throw new Error("Pi session resume was cancelled by an extension");

    const afterRestart = await this.getState();
    if (beforeRestart.sessionId && afterRestart.sessionId !== beforeRestart.sessionId) {
      throw new Error(
        `Pi restart resumed session ${afterRestart.sessionId ?? "missing"}, expected ${beforeRestart.sessionId}`,
      );
    }
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

  closeContextDb(): void {
    if (!this.contextDbCached) return;
    try {
      this.contextDbCached.close();
    } catch {
      // ignore close errors in test polling helpers
    }
    this.contextDbCached = null;
  }

  hasContextDb(): boolean {
    return existsSync(this.contextDbPath());
  }

  countCompartments(sessionId: string, harness = this.harnessId): number {
    try {
      const row = this.contextDb()
        .prepare("SELECT COUNT(*) AS n FROM compartments WHERE session_id = ? AND harness = ?")
        .get(sessionId, harness) as { n: number } | null;
      return row?.n ?? 0;
    } catch {
      return 0;
    }
  }

  countTags(sessionId: string, harness = this.harnessId): number {
    try {
      const row = this.contextDb()
        .prepare("SELECT COUNT(*) AS n FROM tags WHERE session_id = ? AND harness = ?")
        .get(sessionId, harness) as { n: number } | null;
      return row?.n ?? 0;
    } catch {
      return 0;
    }
  }

  countPendingOps(sessionId: string, harness = this.harnessId): number {
    try {
      const row = this.contextDb()
        .prepare("SELECT COUNT(*) AS n FROM pending_ops WHERE session_id = ? AND harness = ?")
        .get(sessionId, harness) as { n: number } | null;
      return row?.n ?? 0;
    } catch {
      return 0;
    }
  }

  countTagsByStatus(sessionId: string, status: string, harness = this.harnessId): number {
    try {
      const row = this.contextDb()
        .prepare("SELECT COUNT(*) AS n FROM tags WHERE session_id = ? AND harness = ? AND status = ?")
        .get(sessionId, harness, status) as { n: number } | null;
      return row?.n ?? 0;
    } catch {
      return 0;
    }
  }

  countDroppedTags(sessionId: string, harness = this.harnessId): number {
    return this.countTagsByStatus(sessionId, "dropped", harness);
  }

  async waitFor<T>(
    predicate: () => T | null | undefined | false,
    opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
  ): Promise<T> {
    // Default bumped from 10s → 60s for CI. waitFor polls for DB rows /
    // queued ops to appear; on CI shared runners there can be material
    // latency between an event firing and the SQLite row being visible.
    // Individual call sites can pass a smaller timeoutMs.
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

  requests() {
    return this.mock.requests();
  }

  diagnostics(): string {
    return this.rpc.getStderr();
  }

  assertHistorianRequestsUseMock(): void {
    if (this.expectMagicContext && this.hasContextDb()) {
      const model = this.host === "omp" ? "mock/mock-model" : "anthropic/claude-haiku-4-5";
      assertHistorianMockRouting(this.contextDb(), this.harnessId, model);
    }
  }

  async dispose(): Promise<void> {
    try {
      this.assertHistorianRequestsUseMock();
    } finally {
      this.closeContextDb();
      await this.rpc.shutdown();
      await this.mock.stop();
    }
  }
}
