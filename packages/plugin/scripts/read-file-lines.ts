import { closeSync, openSync, readSync } from "node:fs";

export class FileLineReadError extends Error {}

/** Decode only complete lines, preserving UTF-8 characters that span read boundaries. */
export function* readFileLines(filePath: string, bufferBytes = 8 * 1024 * 1024): Generator<string> {
    if (!Number.isSafeInteger(bufferBytes) || bufferBytes < 1) {
        throw new RangeError("Read buffer size must be a positive safe integer");
    }
    let fd: number;
    try {
        fd = openSync(filePath, "r");
    } catch (cause) {
        throw new FileLineReadError(`Cannot open ${filePath}`, { cause });
    }
    try {
        const buffer = Buffer.allocUnsafe(bufferBytes);
        let carry: Buffer | undefined;
        let carryLength = 0;
        const append = (part: Buffer): Buffer => {
            const needed = carryLength + part.length;
            if (!carry || carry.length < needed) {
                // Geometric growth keeps copying linear even for a very long line.
                const grown = Buffer.allocUnsafe(Math.max(needed, (carry?.length ?? 0) * 2));
                carry?.copy(grown, 0, 0, carryLength);
                carry = grown;
            }
            part.copy(carry, carryLength);
            carryLength = needed;
            return carry;
        };
        while (true) {
            let bytesRead: number;
            try {
                bytesRead = readSync(fd, buffer, 0, buffer.length, null);
            } catch (cause) {
                throw new FileLineReadError(`Cannot read ${filePath}`, { cause });
            }
            if (bytesRead === 0) break;
            const chunk = buffer.subarray(0, bytesRead);
            let start = 0;
            while (start < bytesRead) {
                const newline = chunk.indexOf(0x0a, start);
                if (newline < 0) break;
                const part = chunk.subarray(start, newline);
                if (carryLength > 0) {
                    yield append(part).toString("utf8", 0, carryLength);
                    carry = undefined;
                    carryLength = 0;
                } else {
                    yield part.toString("utf8");
                }
                start = newline + 1;
            }
            if (start < bytesRead) append(chunk.subarray(start));
        }
        if (carry) yield carry.toString("utf8", 0, carryLength);
    } finally {
        closeSync(fd);
    }
}
