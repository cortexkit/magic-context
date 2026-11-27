/**
 * What clearing `kv.migration.v1-v2` does to a store OpenCode 2 has already
 * converted and then used.
 *
 * `magic-context doctor` 0.43.x told users to clear that key and restart the host
 * so OpenCode 2 would convert the OpenCode 1 rows again. This drives the real
 * hosts through that sequence on a throwaway root and pins the outcome: the
 * converter rebuilds every OpenCode 1 session from its v1 rows and deletes the
 * rows OpenCode 2 added after the first conversion. A session with no OpenCode 2
 * activity comes back byte-identical, which is why it looks untouched.
 *
 * It also pins doctor's post-conversion counter against real converted rows: the
 * rows it counts before the reconversion are exactly the rows the reconversion
 * deletes.
 */

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { OpenCode } from "@opencode/client";
import { checkOpenCodeCompactionMarkerConversion } from "../../../cli/src/commands/doctor-compaction-markers";
import { Database } from "../../../plugin/src/shared/sqlite";
import { MockProvider } from "../../src/mock-provider/server";
import {
    conversionFixture,
    SHARED_MOCK_MODEL_ID,
    SHARED_MOCK_PROVIDER_ID,
    spawnOpencode1,
} from "../../src/opencode2-runner/conversion-lane";
import { CLI, spawnOpencode2, waitForPluginActive } from "../../src/opencode2-runner/spawn";

interface V1Client {
    session: {
        create(opts: { query: { directory: string } }): Promise<{ data?: { id: string } }>;
        prompt(opts: {
            path: { id: string };
            body: {
                model: { providerID: string; modelID: string };
                parts: Array<Record<string, unknown>>;
            };
        }): Promise<{ data?: { info?: { error?: unknown } }; error?: unknown }>;
    };
}

interface Row {
    id: string;
    type: string;
    seq: number;
    time_created: number;
    data: string;
}

function read<T>(path: string, sql: string, ...params: unknown[]): T[] {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
        db.exec("PRAGMA busy_timeout = 5000");
        return db.prepare(sql).all(...params) as T[];
    } finally {
        db.close();
    }
}

function rows(path: string, sessionId: string): Row[] {
    return read<Row>(
        path,
        "SELECT id, type, seq, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq",
        sessionId,
    );
}

/** Rows with no v1 message at the same time_created: what OpenCode 2 wrote itself. */
function postConversionIds(path: string, sessionId: string): string[] {
    return read<{ id: string }>(
        path,
        `SELECT id FROM session_message converted
          WHERE session_id = ?
            AND NOT EXISTS (SELECT 1 FROM message source
                             WHERE source.session_id = converted.session_id
                               AND source.time_created = converted.time_created)
          ORDER BY seq`,
        sessionId,
    ).map((row) => row.id);
}

function migrationState(path: string): string | null {
    const found = read<{ value: string }>(
        path,
        "SELECT value FROM kv WHERE key = 'migration.v1-v2'",
    )[0];
    return found?.value ?? null;
}

/** The host's open files on the store, printed so the run log shows which file it used. */
function openStoreFiles(pid: number | undefined, dbPath: string): string[] {
    if (!pid) return [];
    const result = spawnSync("lsof", ["-p", String(pid), "-Fn"], { encoding: "utf8" });
    return result.stdout
        .split("\n")
        .filter((line) => line.startsWith("n") && line.slice(1).startsWith(dbPath))
        .map((line) => line.slice(1));
}

test("clearing kv.migration.v1-v2 deletes the rows OpenCode 2 added after the first conversion", async () => {
    const fixture = conversionFixture("issue-493-reconversion-e2e");
    const hostVersion = spawnSync(CLI, ["--version"], { encoding: "utf8" }).stdout.trim();
    console.log(`[reconversion] OpenCode 2 host: ${CLI} (${hostVersion})`);
    const mock = new MockProvider();
    const provider = await mock.start();
    mock.setDefault({ text: "ok", usage: { input_tokens: 1_200, output_tokens: 20 } });
    const magicContextConfig = {
        memory: { enabled: false },
        historian: { disable: true },
        dreamer: { disable: true },
    };
    let v1: Awaited<ReturnType<typeof spawnOpencode1>> | undefined;
    let v2: Awaited<ReturnType<typeof spawnOpencode2>> | undefined;
    const spawnV2 = () =>
        spawnOpencode2({
            existingIsolation: fixture,
            existingMock: { mock, baseURL: provider.baseURL },
            magicContextConfig,
        });
    try {
        v1 = await spawnOpencode1({
            fixture,
            mock,
            mockBaseURL: provider.baseURL,
            magicContextConfig,
            logLabel: "v1-reconversion",
        });
        const sdk = await import("@opencode-ai/sdk");
        const client1 = sdk.createOpencodeClient({ baseUrl: v1.url }) as unknown as V1Client;
        const sessions: string[] = [];
        for (const label of ["used-on-v2", "idle-on-v2"]) {
            const created = await client1.session.create({ query: { directory: fixture.cwd } });
            const id = created.data?.id;
            if (!id) throw new Error(`OpenCode 1 did not create session ${label}`);
            sessions.push(id);
            const result = await client1.session.prompt({
                path: { id },
                body: {
                    model: { providerID: SHARED_MOCK_PROVIDER_ID, modelID: SHARED_MOCK_MODEL_ID },
                    parts: [{ type: "text", text: `first turn on OpenCode 1 (${label})` }],
                },
            });
            if (!result.data || result.data.info?.error) {
                throw new Error(`OpenCode 1 turn failed: ${JSON.stringify(result)}`);
            }
        }
        const [used, idle] = sessions as [string, string];
        await v1.stop();
        v1 = undefined;

        // First OpenCode 2 boot converts the store; then OpenCode 2 is used.
        fixture.env.MAGIC_CONTEXT_LOG_PATH = fixture.logPath("v2-first");
        v2 = await spawnV2();
        console.log(`[reconversion] v2 first boot store files: ${JSON.stringify(openStoreFiles(v2.pid, fixture.openCodeDbPath))}`);
        const client2 = OpenCode.make({
            baseUrl: v2.url,
            headers: { authorization: `Basic ${btoa(`opencode:${v2.password}`)}` },
        });
        await waitForPluginActive(client2, fixture.cwd);
        expect(migrationState(fixture.openCodeDbPath)).toBe('{"phase":"completed"}');
        const converted = rows(fixture.openCodeDbPath, used);
        expect(postConversionIds(fixture.openCodeDbPath, used)).toEqual([]);
        for (const text of ["second turn, on OpenCode 2", "third turn, on OpenCode 2"]) {
            await client2.session.prompt({ sessionID: used, text });
            await client2.session.wait({ sessionID: used }, { signal: AbortSignal.timeout(120_000) });
        }
        await v2.stopHost();
        v2 = undefined;

        const usedBefore = rows(fixture.openCodeDbPath, used);
        const idleBefore = rows(fixture.openCodeDbPath, idle);
        const addedOnV2 = postConversionIds(fixture.openCodeDbPath, used);
        expect(usedBefore.length).toBeGreaterThan(converted.length);
        expect(addedOnV2.length).toBe(usedBefore.length - converted.length);
        expect(postConversionIds(fixture.openCodeDbPath, idle)).toEqual([]);

        const doctorDb = new Database(fixture.openCodeDbPath, { readonly: true, fileMustExist: true });
        doctorDb.exec("PRAGMA busy_timeout = 5000");
        let report: ReturnType<typeof checkOpenCodeCompactionMarkerConversion>;
        try {
            report = checkOpenCodeCompactionMarkerConversion(doctorDb);
        } finally {
            doctorDb.close();
        }
        expect(report.migrationCompleted).toBe(true);
        expect(report.postConversionMessages).toBe(addedOnV2.length);
        expect(report.postConversionSessions).toBe(1);
        const eventsBefore = read<{ count: number }>(fixture.openCodeDbPath, "SELECT COUNT(*) AS count FROM event")[0]!.count;

        // The recipe doctor 0.43.x printed.
        const writable = new Database(fixture.openCodeDbPath);
        try {
            writable.exec("PRAGMA busy_timeout = 5000");
            writable.prepare("DELETE FROM kv WHERE key = 'migration.v1-v2'").run();
        } finally {
            writable.close();
        }
        fixture.env.MAGIC_CONTEXT_LOG_PATH = fixture.logPath("v2-reconvert");
        v2 = await spawnV2();
        console.log(`[reconversion] v2 reconversion boot store files: ${JSON.stringify(openStoreFiles(v2.pid, fixture.openCodeDbPath))}`);
        const deadline = Date.now() + 120_000;
        while (migrationState(fixture.openCodeDbPath) !== '{"phase":"completed"}') {
            if (Date.now() > deadline) throw new Error("reconversion did not complete");
            await Bun.sleep(100);
        }
        await v2.stopHost();
        v2 = undefined;

        const usedAfter = rows(fixture.openCodeDbPath, used);
        const idleAfter = rows(fixture.openCodeDbPath, idle);
        const eventsAfter = read<{ count: number }>(fixture.openCodeDbPath, "SELECT COUNT(*) AS count FROM event")[0]!.count;
        const removed = usedBefore
            .map((row) => row.id)
            .filter((id) => !usedAfter.some((row) => row.id === id));
        console.log(
            `[reconversion] used session rows before=${usedBefore.length} after=${usedAfter.length} removed=${removed.length} (types ${JSON.stringify(usedBefore.filter((row) => removed.includes(row.id)).map((row) => row.type))}); idle session rows before=${idleBefore.length} after=${idleAfter.length}; doctor counted ${report.postConversionMessages}; events before=${eventsBefore} after=${eventsAfter}`,
        );

        // The used session is back to exactly its first conversion.
        expect(usedAfter).toEqual(converted);
        // Every row OpenCode 2 added is gone, and doctor counted exactly those rows.
        expect(removed).toEqual(addedOnV2);
        expect(removed.length).toBe(report.postConversionMessages);
        // A session with no OpenCode 2 activity is rewritten to identical rows.
        expect(idleAfter).toEqual(idleBefore);
    } finally {
        if (v2) await v2.stopHost().catch(() => undefined);
        if (v1) await v1.stop().catch(() => undefined);
        await mock.stop().catch(() => undefined);
    }
}, 600_000);
