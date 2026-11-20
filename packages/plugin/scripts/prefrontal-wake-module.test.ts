import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../src/shared/test-temp-dir";

import { type CacheBustEvent, type SubcWakeClient, SubcWakeEventTransport } from "./cache-bust-sentinel";
import { runFailureSentinel } from "./subagent-failure-sentinel";
import { runLatencySentinel } from "./transform-latency-sentinel";

const directories: string[] = [];
afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function temporaryDirectory(label: string): string {
    const directory = createTestTempDirFromPath(join(tmpdir(), label));
    directories.push(directory);
    return directory;
}

/** A stand-in for the CortexKit daemon (subc) client that rejects unnecessary catalog reads. */
function fakeClient() {
    const calls: string[] = [];
    let catalogReads = 0;
    const client = {
        async catalogList() {
            catalogReads += 1;
            throw new Error("catalog must not be read");
        },
        async call(moduleId: string) {
            calls.push(moduleId);
            return { result: { disposition: "delivered", committed_order: calls.length } };
        },
        close() {},
    };
    return { client, calls, catalogReads: () => catalogReads };
}

const event: CacheBustEvent = {
    source_module: "magic-context", kind: "cache_bust", vendor_event_id: "fixture-event",
    session_id: "ses_fixture", directory: "/nonexistent-fixture-directory", occurred_at_ms: 1,
    payload: { session: "ses_fixture", at: "1970-01-01T00:00:00.001Z", rewritten_tokens: 1,
        divergence_class: "unaccounted_rewrite", first_divergence: "message[1]", analyzer_cmd: "fixture" },
};

describe("cache-bust sentinel wake module", () => {
    const transport = (client: SubcWakeClient, moduleId?: string) =>
        new SubcWakeEventTransport("fixture-connection.json", moduleId, "agent_fixture", "sentinel", async () => client);

    test("the default delivers to prefrontal without reading the catalog", async () => {
        const fake = fakeClient();
        const wake = transport(fake.client);
        await wake.record(event);
        await wake.recordLag({ deliveryId: "fixture-lag", content: "behind" });
        expect(fake.calls).toEqual(["prefrontal", "prefrontal"]);
        expect(fake.catalogReads()).toBe(0);
    });

    test("an explicit module id is used as given without reading the catalog", async () => {
        const fake = fakeClient();
        await transport(fake.client, "fixture-module").record(event);
        expect(fake.calls).toEqual(["fixture-module"]);
        expect(fake.catalogReads()).toBe(0);
    });

});

describe("subagent failure sentinel wake module", () => {
    const NOW = 2_000_000_000_000;
    async function sendOneAlert(client: SubcWakeClient, wakeModuleId?: string) {
        const root = temporaryDirectory("prefrontal-wake-failure-");
        const db = new Database(join(root, "context.db"));
        try {
            db.exec(readFileSync(join(import.meta.dir, "../../../crates/mc-module/tests/fixtures/context-db-schema.sql"), "utf8"));
            db.query("INSERT INTO subagent_invocations (session_id, harness, subagent, task, started_at, ended_at, status, error) VALUES ('ses_a', 'opencode', 'historian', 'historian', ?, ?, 'failed', 'permission denied 17')")
                .run(NOW - 1_100, NOW - 1_000);
        } finally { db.close(false); }
        const result = await runFailureSentinel({
            db: join(root, "context.db"), stateFile: join(root, "state.json"), connectionFile: join(root, "none"),
            send: true, settleMs: 0, now: () => NOW, stdout: () => {}, stderr: () => {},
            connect: async () => client, ...(wakeModuleId ? { wakeModuleId } : {}),
        });
        expect(result.alerts).toHaveLength(1);
    }

    test("the default delivers to prefrontal without reading the catalog", async () => {
        const fake = fakeClient();
        await sendOneAlert(fake.client);
        expect(fake.calls).toEqual(["prefrontal"]);
        expect(fake.catalogReads()).toBe(0);
    });

    test("an explicit module id is used as given without reading the catalog", async () => {
        const fake = fakeClient();
        await sendOneAlert(fake.client, "fixture-module");
        expect(fake.calls).toEqual(["fixture-module"]);
        expect(fake.catalogReads()).toBe(0);
    });
});

describe("transform latency sentinel wake module", () => {
    const BASE = Date.parse("2026-09-28T18:00:00Z");
    async function sendOneAlert(client: SubcWakeClient, wakeModuleId?: string) {
        const root = temporaryDirectory("prefrontal-wake-latency-");
        const log = join(root, "log");
        // One render step slower than the single-pass threshold raises one alert.
        writeFileSync(log, `${new Date(BASE).toISOString()} INFO  thalamus-harness: step render session=ses_slow elapsed_ms=13500 wait_ms=13000 entries=421 view=3 cached=false\n`);
        const result = await runLatencySentinel({
            files: [log], stateFile: join(root, "state.json"), db: join(root, "absent.db"), connectionFile: join(root, "none"),
            send: true, now: () => BASE + 100_000, load: () => [1, 2, 3], stdout: () => {}, stderr: () => {},
            connect: async () => client, ...(wakeModuleId ? { wakeModuleId } : {}),
        });
        expect(result.alerts).toHaveLength(1);
    }

    test("the default delivers to prefrontal without reading the catalog", async () => {
        const fake = fakeClient();
        await sendOneAlert(fake.client);
        expect(fake.calls).toEqual(["prefrontal"]);
        expect(fake.catalogReads()).toBe(0);
    });

    test("an explicit module id is used as given without reading the catalog", async () => {
        const fake = fakeClient();
        await sendOneAlert(fake.client, "fixture-module");
        expect(fake.calls).toEqual(["fixture-module"]);
        expect(fake.catalogReads()).toBe(0);
    });
});
