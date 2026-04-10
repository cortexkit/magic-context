import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const logFile = path.join(os.tmpdir(), "magic-context.log");
const isTestEnv = process.env.NODE_ENV === "test";

let buffer: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_INTERVAL_MS = 500;
const BUFFER_SIZE_LIMIT = 50;

function flush(): void {
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    if (buffer.length === 0) return;
    const data = buffer.join("");
    buffer = [];
    try {
        fs.appendFileSync(logFile, data);
    } catch {
        // Intentional: logging must never throw
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
                  ? ` ${data.message}${data.stack ? `\n${data.stack}` : ""}`
                  : ` ${JSON.stringify(data)}`;
        buffer.push(`[${timestamp}] ${message}${serialized}\n`);
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

export function getLogFilePath(): string {
    return logFile;
}

// Flush remaining buffer on process exit
if (!isTestEnv) {
    process.on("exit", flush);
}
