import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../src/shared/test-temp-dir";

import { type CacheBustEvent, type SubcWakeClient, SubcWakeEventTransport } from "./cache-bust-sentinel";
import { LEGACY_PREFRONTAL_MODULE_ID, PREFRONTAL_MODULE_ID, resolvePrefrontalModuleId } from "./prefrontal-wake-module";
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

/** A subc client stand-in whose catalog lists `modules` and which accepts every delivery. */
function fakeClient(modules: string[] | Error) {
    const calls: string[] = [];
    let catalogReads = 0;
    const client: SubcWakeClient = {
        async catalogList() {
            catalogReads += 1;
            if (modules instanceof Error) throw modules;
            return modules.map((module_id) => ({ module_id }));
        },
        async call(moduleId) {
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

describe("resolvePrefrontalModuleId", () => {
    test("prefers prefrontal when the catalog lists both names", async () => {
        const { client } = fakeClient(["prefrontal-core", "prefrontal", "astrocyte"]);
        expect(await resolvePrefrontalModuleId(client)).toBe(PREFRONTAL_MODULE_ID);
    });

    test("uses prefrontal-core when the catalog lacks prefrontal", async () => {
        const { client } = fakeClient(["prefrontal-core", "astrocyte"]);
        expect(await resolvePrefrontalModuleId(client)).toBe(LEGACY_PREFRONTAL_MODULE_ID);
    });
});

describe("cache-bust sentinel wake module", () => {
    const transport = (client: SubcWakeClient, moduleId?: string) =>
        new SubcWakeEventTransport("fixture-connection.json", moduleId, "agent_fixture", "sentinel", async () => client);

    test("the default reaches prefrontal when the daemon has it and reads the catalog once per run", async () => {
        const fake = fakeClient(["prefrontal", "prefrontal-core"]);
        const wake = transport(fake.client);
        await wake.record(event);
        await wake.recordLag({ deliveryId: "fixture-lag", content: "behind" });
        expect(fake.calls).toEqual(["prefrontal", "prefrontal"]);
        expect(fake.catalogReads()).toBe(1);
    });

    test("the default falls back to prefrontal-core when only that is present", async () => {
        const fake = fakeClient(["prefrontal-core"]);
        const wake = transport(fake.client);
        await wake.record(event);
        await wake.recordLag({ deliveryId: "fixture-lag", content: "behind" });
        expect(fake.calls).toEqual(["prefrontal-core", "prefrontal-core"]);
        expect(fake.catalogReads()).toBe(1);
    });

    test("an explicit module id is used as given without reading the catalog", async () => {
        const fake = fakeClient(["prefrontal"]);
        await transport(fake.client, "prefrontal-core").record(event);
        expect(fake.calls).toEqual(["prefrontal-core"]);
        expect(fake.catalogReads()).toBe(0);
    });

    test("a failed catalog read fails the delivery and is read again by the next one", async () => {
        const fake = fakeClient(new Error("catalog unavailable"));
        const wake = transport(fake.client);
        await expect(wake.record(event)).rejects.toThrow("catalog unavailable");
        await expect(wake.recordLag({ deliveryId: "fixture-lag", content: "behind" })).rejects.toThrow("catalog unavailable");
        expect(fake.calls).toEqual([]);
        expect(fake.catalogReads()).toBe(2);
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

    test("the default reaches prefrontal when the daemon has it", async () => {
        const fake = fakeClient(["prefrontal-core", "prefrontal"]);
        await sendOneAlert(fake.client);
        expect(fake.calls).toEqual(["prefrontal"]);
    });

    test("the default falls back to prefrontal-core when only that is present", async () => {
        const fake = fakeClient(["prefrontal-core"]);
        await sendOneAlert(fake.client);
        expect(fake.calls).toEqual(["prefrontal-core"]);
    });

    test("an explicit module id is used as given without reading the catalog", async () => {
        const fake = fakeClient(["prefrontal"]);
        await sendOneAlert(fake.client, "prefrontal-core");
        expect(fake.calls).toEqual(["prefrontal-core"]);
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

    test("the default reaches prefrontal when the daemon has it", async () => {
        const fake = fakeClient(["prefrontal", "prefrontal-core"]);
        await sendOneAlert(fake.client);
        expect(fake.calls).toEqual(["prefrontal"]);
    });

    test("the default falls back to prefrontal-core when only that is present", async () => {
        const fake = fakeClient(["prefrontal-core"]);
        await sendOneAlert(fake.client);
        expect(fake.calls).toEqual(["prefrontal-core"]);
    });

    test("an explicit module id is used as given without reading the catalog", async () => {
        const fake = fakeClient(["prefrontal"]);
        await sendOneAlert(fake.client, "prefrontal-core");
        expect(fake.calls).toEqual(["prefrontal-core"]);
        expect(fake.catalogReads()).toBe(0);
    });
});
