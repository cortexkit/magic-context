import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubcCallError, SubcClient } from "@cortexkit/subc-client";
import { getDefaultSubcConnectionFile } from "../../hooks/magic-context/module-transport";
import * as logger from "../../shared/logger";
import { Database } from "../../shared/sqlite";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { insertMemory } from "./memory";
import type { SynapseClientLike } from "./memory/embedding-synapse";
import { runMigrations } from "./migrations";
import { formatSearchResults, unifiedSearch } from "./search";
import { prepareReranker, RERANK_MODEL } from "./search-rerank";
import { initializeDatabase } from "./storage-db";

const catalog = {
    table_epoch: 2,
    models: [{ model_id: RERANK_MODEL, certified: true, fingerprints: ["a".repeat(64)] }],
};
const unknownModule = () => new SubcCallError("not_sent", "route refused", "unknown_module");
let directory: string;
let connectionFile: string;
let now: number;
let calls: number;
let failure: unknown;
let reply: unknown;
let service: SynapseClientLike;
let connected: ReturnType<typeof stubConnection>;
let logged: ReturnType<typeof muteLog>;
function stubConnection() {
    return spyOn(SubcClient, "connect").mockImplementation(async () => service as SubcClient);
}
function muteLog() {
    return spyOn(logger, "log").mockImplementation(() => {});
}

beforeEach(() => {
    directory = createTestTempDirFromPath(join(tmpdir(), "rerank-synapse-"));
    connectionFile = join(directory, "connection.json");
    now = 1_000_000;
    calls = 0;
    failure = unknownModule();
    reply = catalog;
    service = {
        async call<T>(module: string, method: string) {
            expect(module).toBe("synapse");
            expect(method).toBe("models.list");
            calls++;
            if (failure) throw failure;
            return reply as T;
        },
        close() {},
    };
    connected = stubConnection();
    logged = muteLog();
});
afterEach(() => {
    connected.mockRestore();
    logged.mockRestore();
    cleanupTestTempDir(directory);
});

function prepare(file = connectionFile, injected?: SynapseClientLike | null) {
    return prepareReranker("git:test", "s", file, injected, undefined, () => now);
}

describe("Synapse absence backoff", () => {
    test("escalates unknown_module from thirty seconds to ten minutes without reconnecting", async () => {
        expect(await prepare()).toBeNull();
        now += 10_000;
        expect(await prepare()).toBeNull();
        now += 19_999;
        expect(await prepare()).toBeNull();
        expect(calls).toBe(1);
        expect(connected).toHaveBeenCalledTimes(1);

        now++;
        expect(await prepare()).toBeNull();
        expect(calls).toBe(2);
        now += 600_000 - 1;
        expect(await prepare()).toBeNull();
        expect(calls).toBe(2);
        now++;
        expect(await prepare()).toBeNull();
        expect(calls).toBe(3);
        expect(
            logged.mock.calls.filter(([line]) => line.includes("rerank fallback (unknown_module)")),
        ).toHaveLength(1);
        now += 30_000;
        expect(await prepare()).toBeNull();
        expect(calls).toBe(3);
    });

    test("disables client route retries so unknown_module can reach the catalog bound", async () => {
        await prepare();
        expect(connected).toHaveBeenCalledWith({ connectionFile, routeOpenRetryDeadlineMs: 0 });
    });

    test.each([
        ["deadline", new SubcCallError("outcome_unknown", "deadline", "deadline_exceeded")],
        ["connection", Object.assign(new Error("unavailable"), { code: "ECONNREFUSED" })],
        ["message alone", new Error("unknown_module")],
    ])("does not remember %s failures", async (_name, error) => {
        failure = error;
        for (let i = 0; i < 3; i++) expect(await prepare()).toBeNull();
        expect(calls).toBe(3);
    });

    test("does not remember catalog validation or a missing lane", async () => {
        failure = undefined;
        for (const invalid of [null, { models: [] }]) {
            reply = invalid;
            for (let i = 0; i < 3; i++) expect(await prepare()).toBeNull();
        }
        expect(calls).toBe(6);
    });

    test("does not mistake a connection failure for a catalog refusal", async () => {
        connected.mockRejectedValueOnce(unknownModule());
        expect(await prepare()).toBeNull();
        expect(calls).toBe(0);
        expect(await prepare()).toBeNull();
        expect(calls).toBe(1);
        expect(connected).toHaveBeenCalledTimes(2);
    });

    test("an hour without searches resets the next absence to a thirty-second window", async () => {
        await prepare();
        expect(calls).toBe(1);
        now += 60 * 60_000;
        await prepare();
        expect(calls).toBe(2);
        now += 30_000 - 1;
        await prepare();
        expect(calls).toBe(2);
        now++;
        await prepare();
        expect(calls).toBe(3);
    });

    test("success after the window clears the entry and resets the next absence", async () => {
        await prepare();
        now += 30_000;
        await prepare();
        now += 600_000;
        failure = undefined;
        expect(await prepare()).not.toBeNull();
        failure = unknownModule();
        expect(await prepare()).toBeNull();
        expect(calls).toBe(4);
        now += 30_000 - 1;
        expect(await prepare()).toBeNull();
        expect(calls).toBe(4);
        now++;
        await prepare();
        expect(calls).toBe(5);
    });

    test("other failures after expiry neither extend nor reset the absence state", async () => {
        await prepare();
        now += 30_000;
        failure = new SubcCallError("outcome_unknown", "deadline", "deadline_exceeded");
        await prepare();
        await prepare();
        expect(calls).toBe(3);
        failure = unknownModule();
        await prepare();
        now += 30_000;
        await prepare();
        expect(calls).toBe(4);
        now += 570_000;
        await prepare();
        expect(calls).toBe(5);
    });

    test("keys absence by the resolved connection file, not project or session", async () => {
        const otherFile = join(directory, "other-connection.json");
        await prepare();
        await prepare(otherFile);
        expect(calls).toBe(2);
        await prepareReranker(
            "other-project",
            "other-session",
            connectionFile,
            undefined,
            undefined,
            () => now,
        );
        await prepare(otherFile);
        expect(calls).toBe(2);
        expect(connected).toHaveBeenCalledTimes(2);
    });

    test("uses the same key for default and explicit default connection files", async () => {
        await prepareReranker("git:test", "s", undefined, undefined, undefined, () => now);
        const defaultFile = getDefaultSubcConnectionFile();
        await prepare(defaultFile);
        expect(calls).toBe(1);
        expect(connected.mock.calls[0][0].connectionFile).toBe(defaultFile);
        now += 30_000;
        failure = undefined;
        await prepare(defaultFile);
    });

    test("injected clients neither read, clear nor write absence state", async () => {
        await prepare();
        failure = undefined;
        expect(await prepare(connectionFile, service)).not.toBeNull();
        expect(calls).toBe(2);
        expect(await prepare()).toBeNull();
        expect(calls).toBe(2);
        const otherFile = join(directory, "injected-connection.json");
        failure = unknownModule();
        for (let i = 0; i < 3; i++) await prepare(otherFile, service);
        await prepare(otherFile);
        expect(calls).toBe(6);
        expect(connected).toHaveBeenCalledTimes(2);
        now += 30_000;
        await prepare();
        expect(calls).toBe(7);
    });

    test("explicit prose searches preserve results while skipping absent Synapse", async () => {
        const database = new Database(":memory:");
        try {
            initializeDatabase(database);
            runMigrations(database);
            insertMemory(database, {
                projectPath: "git:test",
                category: "ARCHITECTURE",
                content: "prompt cache budget stable explanation",
            });
            const query = "why is prompt cache budget stable";
            const options = {
                explicitSearch: true,
                embeddingEnabled: false,
                countRetrievals: false,
                measurementDisabled: true,
                sources: ["memory" as const],
                rerankConnectionFile: connectionFile,
            };
            const baseline = await unifiedSearch(database, "s", "git:test", query, {
                ...options,
                rerank: false,
            });
            expect(baseline).toHaveLength(1);
            for (let i = 0; i < 3; i++) {
                const actual = await unifiedSearch(database, "s", "git:test", query, options);
                expect(actual).toEqual(baseline);
                expect(formatSearchResults(query, actual, "s")).toBe(
                    formatSearchResults(query, baseline, "s"),
                );
            }
            expect(calls).toBe(1);
        } finally {
            database.close();
        }
    });
});
