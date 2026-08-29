import * as fs from "node:fs";
import * as path from "node:path";
import { getMagicContextLogPath } from "./data-path";
import { sanitizeConfigValue, sanitizeDiagnosticText } from "./redaction";

const isTestEnv = process.env.NODE_ENV === "test";

let buffer: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_INTERVAL_MS = 500;
const BUFFER_SIZE_LIMIT = 50;

export interface LoggerDiagnostics {
    swallowedWriteCount: number;
    lastErrorMessage: string | null;
    lastErrorTime: string | null;
}

let swallowedWriteCount = 0;
let lastErrorMessage: string | null = null;
let lastErrorTime: string | null = null;

function recordSwallowedWrite(error: unknown): void {
    try {
        swallowedWriteCount++;
        lastErrorMessage = sanitizeDiagnosticText(
            error instanceof Error ? error.message : String(error),
        );
        lastErrorTime = new Date().toISOString();
    } catch {
        // Diagnostics must not make the logger throw either.
    }
}

function ensureDir(filePath: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function flush(): void {
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    if (buffer.length === 0) return;
    const data = buffer.join("");
    buffer = [];
    try {
        const logFile = getMagicContextLogPath();
        ensureDir(logFile);
        fs.appendFileSync(logFile, data);
    } catch (error) {
        recordSwallowedWrite(error);
    }
}

function scheduleFlush(): void {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        flush();
    }, FLUSH_INTERVAL_MS);
}

export function log(message: string, data?: unknown): void {
    if (isTestEnv) return;
    try {
        const timestamp = new Date().toISOString();
        const serialized =
            data === undefined
                ? ""
                : data instanceof Error
                  ? ` ${sanitizeDiagnosticText(
                        `${data.message}${data.stack ? `\n${data.stack}` : ""}`,
                    )}`
                  : ` ${JSON.stringify(sanitizeConfigValue(data))}`;
        buffer.push(`[${timestamp}] ${sanitizeDiagnosticText(message)}${serialized}\n`);
        if (buffer.length >= BUFFER_SIZE_LIMIT) {
            flush();
        } else {
            scheduleFlush();
        }
    } catch {
        // Intentional: logging must never throw
    }
}

export function sessionLog(sessionId: string, message: string, data?: unknown): void {
    log(`[magic-context][${sessionId}] ${message}`, data);
}

export function getLoggerDiagnostics(): LoggerDiagnostics {
    return {
        swallowedWriteCount,
        lastErrorMessage,
        lastErrorTime,
    };
}

/** Flush buffered log entries immediately. Primarily useful to diagnostic readers and tests. */
export function flushLogger(): void {
    flush();
}

/**
 * Resolve the current log file path. The path is harness-aware (see
 * {@link getMagicContextLogPath}) and re-evaluated on every call, so callers
 * who format diagnostic output with this value always see the path the next
 * flush will actually use.
 */
export function getLogFilePath(): string {
    return getMagicContextLogPath();
}

// Flush remaining buffer on process exit
if (!isTestEnv) {
    process.on("exit", flush);
}
