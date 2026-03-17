import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const logFile = path.join(os.tmpdir(), "magic-context.log");

export function log(message: string, data?: unknown): void {
    try {
        const timestamp = new Date().toISOString();
        const serialized = data === undefined ? "" : ` ${JSON.stringify(data)}`;
        fs.appendFileSync(logFile, `[${timestamp}] ${message}${serialized}\n`);
    } catch (_error) {
        return;
    }
}

export function getLogFilePath(): string {
    return logFile;
}
