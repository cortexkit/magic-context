import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isPidAlive, readProcessStartTime } from "./rpc-utils";
import {
    ensurePrivateStorageDirectorySync,
    writeStorageFileAtomicSync,
    writeStorageFileSync,
} from "./storage-permissions";

interface Ticket {
    choosing: boolean;
    number: number;
    birth: string | null;
    checksum: string;
}
const ticketChecksum = (name: string, ticket: Ticket) =>
    createHash("sha256")
        .update(JSON.stringify([name, ticket.choosing, ticket.number, ticket.birth]))
        .digest("hex");
function processBirth(pid: number): string | null {
    if (process.platform === "linux") {
        try {
            const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
            const ticks = stat
                .slice(stat.lastIndexOf(")") + 2)
                .trim()
                .split(/\s+/)[19];
            if (!ticks || !/^\d+$/.test(ticks)) return null;
            return `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${ticks}`;
        } catch {
            return null;
        }
    }
    if (process.platform === "darwin") {
        try {
            return (
                execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
                    encoding: "utf8",
                    timeout: 1000,
                    windowsHide: true,
                    env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
                    stdio: ["ignore", "pipe", "pipe"],
                }).trim() || null
            );
        } catch {
            return null;
        }
    }
    const start = readProcessStartTime(pid);
    return start === null ? null : String(start);
}
const pause = new Int32Array(new SharedArrayBuffer(4));

/**
 * Lamport's bakery mutex using unique contender files on a local filesystem.
 * Exclusive creation and atomic replacement work on POSIX and Windows. A dead
 * owner is removed by PID/start-time evidence, never by age: a paused live
 * publisher must not lose its lock. Uncertain liveness refuses after the budget.
 * Unique names mean reclaiming a dead ticket cannot unlink a successor's lock.
 */
export function withStorageFileMutex<T>(directory: string, work: () => T, timeoutMs = 1000): T {
    ensurePrivateStorageDirectorySync(directory);
    const name = `${process.pid}-${randomUUID()}.lock`;
    const ownPath = join(directory, name);
    const birth = processBirth(process.pid);
    const ticket: Ticket = { choosing: true, number: 0, birth, checksum: "" };
    const encodedTicket = () =>
        JSON.stringify({ ...ticket, checksum: ticketChecksum(name, ticket) });
    for (let attempt = 0; ; attempt++) {
        try {
            writeStorageFileSync(ownPath, encodedTicket(), { flag: "wx", forcePrivate: true });
            break;
        } catch (error) {
            // A session cleanup can remove an empty directory between mkdir and
            // ticket creation. No ticket exists yet, so retry before contending.
            if ((error as NodeJS.ErrnoException).code !== "ENOENT" || attempt >= 2) throw error;
            ensurePrivateStorageDirectorySync(directory);
        }
    }
    const deadline = performance.now() + timeoutMs;
    const peers = (): [string, Ticket | null][] => {
        const found: [string, Ticket | null][] = [];
        for (const other of readdirSync(directory)) {
            if (other === name || !/^\d+-[\da-f-]+\.lock$/.test(other)) continue;
            const pid = Number(other.split("-")[0]);
            const otherPath = join(directory, other);
            let value: Ticket | null = null;
            try {
                const parsed = JSON.parse(readFileSync(otherPath, "utf8")) as Ticket;
                if (
                    typeof parsed.choosing === "boolean" &&
                    Number.isSafeInteger(parsed.number) &&
                    parsed.number >= 0 &&
                    (parsed.birth === null || typeof parsed.birth === "string") &&
                    parsed.checksum === ticketChecksum(other, parsed)
                )
                    value = parsed;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            }
            const alive = isPidAlive(pid);
            const actualBirth = alive === "alive" && value?.birth ? processBirth(pid) : null;
            if (
                alive === "dead" ||
                (actualBirth !== null && value?.birth && actualBirth !== value.birth)
            ) {
                rmSync(otherPath, { force: true });
                continue;
            }
            found.push([other, value]);
        }
        return found;
    };
    try {
        ticket.number = 1 + Math.max(0, ...peers().map(([, value]) => value?.number ?? 0));
        ticket.choosing = false;
        writeStorageFileAtomicSync(ownPath, encodedTicket(), true);
        while (
            peers().some(
                ([other, value]) =>
                    !value ||
                    value.choosing ||
                    value.number < ticket.number ||
                    (value.number === ticket.number && other < name),
            )
        ) {
            if (performance.now() >= deadline)
                throw new Error("Storage safety publication lock is unavailable");
            Atomics.wait(pause, 0, 0, 10);
        }
        const result = work();
        if (result && typeof (result as { then?: unknown }).then === "function")
            throw new TypeError("Storage publication mutex requires synchronous work");
        return result;
    } finally {
        rmSync(ownPath, { force: true });
        try {
            rmdirSync(directory);
        } catch {
            // Do not remove a live contender's ticket.
        }
    }
}
