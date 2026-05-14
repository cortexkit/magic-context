/**
 * Persistent Pi RPC client for e2e tests.
 *
 * Pi's `--mode rpc` protocol is strict JSONL over stdio: commands are JSON
 * objects written to stdin and delimited only by LF (`\n`); stdout emits JSONL
 * responses (`type: "response"`, with the caller-provided `id`) interleaved
 * with asynchronous agent events (`agent_start`, `agent_end`, `message_end`,
 * extension UI requests, etc.). This client keeps one Pi subprocess alive for a
 * whole `PiTestHarness`, correlates command responses by `id`, and exposes an
 * event registry for per-turn collection. It intentionally does not use Node's
 * `readline` because that treats U+2028/U+2029 as line separators even though
 * they are valid inside JSON strings.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  childEnv,
  createPiIsolatedEnv,
  PI_CLI,
  type PiIsolatedEnv,
  type PiRunnerOptions,
  writeConfigs,
} from "./spawn";

export type PiRpcEvent = Record<string, unknown> & { type?: string };

export interface PiRpcResponse<T = unknown> {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: T;
  error?: string;
}

export interface PiRpcWaitOptions {
  timeoutMs?: number;
  label?: string;
}

interface PendingRequest {
  method: string;
  resolve: (response: PiRpcResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function serializeRpcMessage(value: Record<string, unknown>): string {
  return `${JSON.stringify(value)}\n`;
}

export function attachStrictJsonlReader(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
): () => void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  const emitLine = (line: string) => {
    onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  };
  const onData = (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) return;
      emitLine(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
    }
  };
  const onEnd = () => {
    buffer += decoder.end();
    if (buffer.length > 0) {
      emitLine(buffer);
      buffer = "";
    }
  };
  stream.on("data", onData);
  stream.on("end", onEnd);
  return () => {
    stream.off("data", onData);
    stream.off("end", onEnd);
  };
}

export class PiRpcProtocol {
  private nextId = 0;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly eventListeners = new Set<(event: PiRpcEvent) => void>();

  onEvent(listener: (event: PiRpcEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  sendCommand<T = unknown>(
    writeLine: (line: string) => void,
    method: string,
    params: Record<string, unknown> = {},
    opts: PiRpcWaitOptions = {},
  ): Promise<PiRpcResponse<T>> {
    const id = `pi-e2e-${++this.nextId}`;
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const command = { ...params, id, type: method };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for Pi RPC response to ${method}`));
      }, timeoutMs);
      this.pendingRequests.set(id, {
        method,
        timer,
        resolve: (response) => resolve(response as PiRpcResponse<T>),
        reject,
      });
      try {
        writeLine(serializeRpcMessage(command));
      } catch (error) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  waitForEvent(
    predicate: (event: PiRpcEvent) => boolean,
    opts: PiRpcWaitOptions = {},
  ): Promise<PiRpcEvent> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const label = opts.label ? ` (${opts.label})` : "";
    return new Promise((resolve, reject) => {
      const unsubscribe = this.onEvent((event) => {
        try {
          if (!predicate(event)) return;
          clearTimeout(timer);
          unsubscribe();
          resolve(event);
        } catch (error) {
          clearTimeout(timer);
          unsubscribe();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for Pi RPC event${label}`));
      }, timeoutMs);
    });
  }

  dispatchLine(line: string): void {
    let message: PiRpcEvent | PiRpcResponse;
    try {
      message = JSON.parse(line) as PiRpcEvent | PiRpcResponse;
    } catch (error) {
      this.dispatchEvent({
        type: "rpc_parse_error",
        line,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (message.type === "response") {
      const id = typeof message.id === "string" ? message.id : undefined;
      const pending = id ? this.pendingRequests.get(id) : undefined;
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(id!);
        pending.resolve(message as PiRpcResponse);
        return;
      }
    }

    this.dispatchEvent(message as PiRpcEvent);
  }

  rejectPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingRequests.delete(id);
    }
  }

  private dispatchEvent(event: PiRpcEvent): void {
    for (const listener of [...this.eventListeners]) {
      listener(event);
    }
  }
}

export interface PiRpcClientOptions extends PiRunnerOptions {
  env?: PiIsolatedEnv;
}

export interface PiState extends Record<string, unknown> {
  sessionId?: string;
  sessionFile?: string;
  isStreaming?: boolean;
  isCompacting?: boolean;
  messageCount?: number;
}

export type PiMessage = Record<string, unknown>;
export type PiSessionStats = Record<string, unknown>;

export class PiRpcClient {
  readonly env: PiIsolatedEnv;
  readonly protocol = new PiRpcProtocol();

  private readonly options: PiRpcClientOptions;
  private process: ChildProcess | null = null;
  private stopReadingStdout: (() => void) | null = null;
  private stderr = "";

  constructor(options: PiRpcClientOptions) {
    this.env = options.env ?? createPiIsolatedEnv();
    this.options = { ...options, env: this.env };
  }

  async start(): Promise<void> {
    if (this.process) throw new Error("Pi RPC client already started");
    writeConfigs(this.env, this.options);

    this.process = spawn(
      "bun",
      [
        PI_CLI,
        "--mode",
        "rpc",
        "--no-extensions",
        "--extension",
        this.env.pluginDir,
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--model",
        "anthropic/claude-haiku-4-5",
        "--api-key",
        "test-key-not-real",
      ],
      { cwd: this.env.workdir, env: childEnv(this.env), stdio: ["pipe", "pipe", "pipe"] },
    );

    this.process.stderr?.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });
    this.stopReadingStdout = attachStrictJsonlReader(this.process.stdout!, (line) => {
      this.protocol.dispatchLine(line);
    });
    this.process.once("exit", (code, signal) => {
      this.protocol.rejectPending(
        new Error(`Pi RPC process exited with code ${code ?? "null"} signal ${signal ?? "null"}\n${this.stderr}`),
      );
    });

    await Bun.sleep(100);
    if (this.process.exitCode !== null) {
      throw new Error(`Pi RPC process exited during startup with code ${this.process.exitCode}\n${this.stderr}`);
    }
  }

  onEvent(listener: (event: PiRpcEvent) => void): () => void {
    return this.protocol.onEvent(listener);
  }

  waitForEvent(
    predicate: (event: PiRpcEvent) => boolean,
    opts: PiRpcWaitOptions = {},
  ): Promise<PiRpcEvent> {
    return this.protocol.waitForEvent(predicate, opts);
  }

  async sendCommand<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    opts: PiRpcWaitOptions = {},
  ): Promise<PiRpcResponse<T>> {
    if (!this.process?.stdin || this.process.killed) {
      throw new Error("Pi RPC process is not running");
    }
    return this.protocol.sendCommand<T>(
      (line) => this.process!.stdin!.write(line),
      method,
      params,
      opts,
    );
  }

  getStderr(): string {
    return this.stderr;
  }

  async shutdown(timeoutMs = 2_000): Promise<void> {
    if (!this.process) return;
    const child = this.process;
    this.stopReadingStdout?.();
    this.stopReadingStdout = null;
    this.process = null;

    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        resolve();
      }, timeoutMs);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

export function requireSuccessfulResponse<T>(response: PiRpcResponse<T>): T {
  if (!response.success) {
    throw new Error(response.error ?? `Pi RPC ${response.command} failed`);
  }
  return response.data as T;
}
