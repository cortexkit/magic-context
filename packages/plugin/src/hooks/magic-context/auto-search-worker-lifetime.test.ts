import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { runMigrations } from "../../features/magic-context/migrations";
import { resolveSessionCacheTtl } from "../../features/magic-context/session-cache-ttl";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { updateSessionMeta } from "../../features/magic-context/storage-meta";
import { Database } from "../../shared/sqlite";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { WORKER_CLOSE_MESSAGE } from "../../shared/worker-shutdown";
import {
    disposeIdleAutoSearchWorkers,
    getAutoSearchWorkerStats,
    searchAutoHint,
} from "./auto-search-worker-client";

const minute = 60_000;
const databases = new Map<Database, string>();

function idleClock() {
    let now = Date.parse("2026-07-01T00:00:00Z");
    const pending = new Map<ReturnType<typeof setTimeout>, { at: number; fire: () => void }>();
    const schedule = globalThis.setTimeout;
    const cancel = globalThis.clearTimeout;
    const time = spyOn(Date, "now").mockImplementation(() => now);
    // Only idle expiry is virtual. The worker's messages and shutdown still
    // run on the real event loop when the test advances the expiry clock.
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
        callback: (...args: unknown[]) => void,
        delay?: number,
        ...args: unknown[]
    ) => {
        if (delay === undefined || delay <= 2_000) return schedule(callback, delay, ...args);
        const handle = schedule(() => {}, 0);
        cancel(handle);
        pending.set(handle, { at: now + delay, fire: () => callback(...args) });
        return handle;
    }) as typeof setTimeout);
    const clear = spyOn(globalThis, "clearTimeout").mockImplementation((handle) => {
        if (!pending.delete(handle as ReturnType<typeof setTimeout>)) cancel(handle);
    });
    return {
        advance(delta: number) {
            const end = now + delta;
            for (;;) {
                const next = [...pending].sort((a, b) => a[1].at - b[1].at)[0];
                if (!next || next[1].at > end) break;
                const [handle, entry] = next;
                pending.delete(handle);
                now = entry.at;
                entry.fire();
            }
            now = end;
        },
        restore() {
            clear.mockRestore();
            timer.mockRestore();
            time.mockRestore();
        },
    };
}

let clock: ReturnType<typeof idleClock>;
beforeEach(() => {
    clock = idleClock();
});

afterEach(() => {
    disposeIdleAutoSearchWorkers();
    clock.restore();
    for (const [db, dir] of databases) {
        db.close();
        cleanupTestTempDir(dir);
    }
    databases.clear();
});

function fixture() {
    const dir = createTestTempDirFromPath(join(tmpdir(), "auto-search-worker-lifetime-"));
    const db = new Database(join(dir, "context.db"));
    databases.set(db, dir);
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

async function reused(db: Database, session = "session", project = "/synthetic") {
    const before = getAutoSearchWorkerStats().reused;
    await searchAutoHint(db, session, project, "history cache", {
        sources: ["message"],
        embedQuery: async () => new Float32Array([1, 0]),
        isEmbeddingRuntimeEnabled: () => true,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    return getAutoSearchWorkerStats().reused > before;
}

function setLifetime(db: Database, session: string, ttl: string) {
    resolveSessionCacheTtl(db, session, { default: "5m", "other/model": ttl }, "other/model", true);
}

function reply(db: Database, session = "session") {
    updateSessionMeta(db, session, { lastResponseTime: Date.now() });
}

test("a worker with a one-hour cache lifetime survives six idle minutes", async () => {
    const db = fixture();
    setLifetime(db, "session", "1h");
    expect(await reused(db)).toBe(false);
    reply(db);
    clock.advance(6 * minute);
    expect(await reused(db)).toBe(true);
});

test("a worker with the default cache lifetime is gone after six idle minutes", async () => {
    const db = fixture();
    expect(await reused(db)).toBe(false);
    clock.advance(4 * minute);
    reply(db);
    clock.advance(2 * minute);
    expect(await reused(db)).toBe(false);
});

test("a shared worker uses the last reply of each session, not the last search or the last lease holder", async () => {
    const db = fixture();
    setLifetime(db, "long", "1h");
    expect(await reused(db, "long")).toBe(false);
    clock.advance(3 * minute);
    expect(await reused(db, "short")).toBe(true);
    reply(db, "short");
    clock.advance(minute);
    reply(db, "long");
    // By now both searches were over an hour ago, but the long reply was not.
    clock.advance(59.5 * minute);
    expect(await reused(db, "short")).toBe(true);
    // A fresh lease always gets the original five-minute grace; it must not
    // renew the long session's hour when that session did not send a reply.
    clock.advance(5 * minute);
    expect(await reused(db, "short")).toBe(false);
});

test("a configured lifetime above one hour holds the worker until one hour after the reply, no longer", async () => {
    const db = fixture();
    setLifetime(db, "session", "never");
    expect(await reused(db)).toBe(false);
    reply(db);
    clock.advance(54 * minute);
    expect(await reused(db)).toBe(true);
    clock.advance(6 * minute);
    expect(await reused(db)).toBe(false);
});

test("only four idle workers are kept across database owners, with least recently used eviction", async () => {
    const db = fixture();
    const otherOwner = fixture();
    const ref = spyOn(Worker.prototype, "ref");
    const post = spyOn(Worker.prototype, "postMessage");
    try {
        expect(await reused(db, "session", "/a")).toBe(false);
        expect(await reused(db, "session", "/b")).toBe(false);
        const leastRecent = ref.mock.contexts[1];
        expect(await reused(db, "session", "/a")).toBe(true);
        for (const project of ["/c", "/d"]) {
            expect(await reused(db, "session", project)).toBe(false);
        }
        expect(post.mock.calls).not.toContainEqual([WORKER_CLOSE_MESSAGE]);
        expect(await reused(otherOwner, "session", "/e")).toBe(false);
        const closed = post.mock.calls.flatMap(([message], i) =>
            message === WORKER_CLOSE_MESSAGE ? [post.mock.contexts[i]] : [],
        );
        expect(closed).toHaveLength(1);
        expect(closed[0]).toBe(leastRecent);
    } finally {
        post.mockRestore();
        ref.mockRestore();
    }
});

test("explicit disposal stops a worker during its one-hour grace", async () => {
    const db = fixture();
    setLifetime(db, "session", "1h");
    expect(await reused(db)).toBe(false);
    reply(db);
    clock.advance(6 * minute);
    const ref = spyOn(Worker.prototype, "ref");
    try {
        expect(await reused(db)).toBe(true);
        const worker = ref.mock.contexts[0] as Worker;
        const exit = once(worker, "exit");
        disposeIdleAutoSearchWorkers();
        expect(await exit).toEqual([0]);
        expect(await reused(db)).toBe(false);
    } finally {
        ref.mockRestore();
    }
});
