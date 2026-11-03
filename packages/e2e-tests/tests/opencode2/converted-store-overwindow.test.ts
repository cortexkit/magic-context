import { openTestDb } from "../../src/test-db";
import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { estimateTokens } from "../../../plugin/src/hooks/magic-context/read-session-formatting";
import { Database } from "../../../plugin/src/shared/sqlite";
import { MockProvider } from "../../src/mock-provider/server";
import {
    conversionFixture,
    SHARED_MOCK_MODEL_ID,
    SHARED_MOCK_PROVIDER_ID,
    spawnOpencode1,
} from "../../src/opencode2-runner/conversion-lane";
import { spawnOpencode2, waitForPluginActive } from "../../src/opencode2-runner/spawn";

const CONTEXT_LIMIT = 1_048_576;
const OUTPUT_LIMIT = 1_024;
const OVERFLOW_MODEL_ID = "converted-overflow-model";

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

function contextRows<T>(path: string, sql: string, ...params: unknown[]): T[] {
    const db = openTestDb(path, { readonly: true, fileMustExist: true }, Database);
    try {
        return db.prepare(sql).all(...params) as T[];
    } finally {
        db.close();
    }
}

function convertedToolArcCount(path: string, sessionId: string, callIds: readonly string[]): number {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
        const placeholders = callIds.map(() => "?").join(",");
        const row = db
            .prepare(
                `SELECT COUNT(DISTINCT json_extract(part.value, '$.id')) AS count
                   FROM session_message AS message,
                        json_each(message.data, '$.content') AS part
                  WHERE message.session_id = ?
                    AND json_extract(part.value, '$.type') IN ('tool', 'tool-call', 'tool-result')
                    AND json_extract(part.value, '$.id') IN (${placeholders})`,
            )
            .get(sessionId, ...callIds) as { count: number };
        return row.count;
    } finally {
        db.close();
    }
}

function inflateConvertedToolOutputs(
    path: string,
    sessionId: string,
    outputs: ReadonlyMap<string, string>,
): number {
    const db = new Database(path);
    let changed = 0;
    try {
        const rows = db
            .prepare("SELECT id, data FROM session_message WHERE session_id = ?")
            .all(sessionId) as Array<{ id: string; data: string }>;
        const update = db.prepare("UPDATE session_message SET data = ? WHERE id = ?");
        db.transaction(() => {
            for (const row of rows) {
                const data = JSON.parse(row.data) as { content?: Array<Record<string, unknown>> };
                let rowChanged = false;
                for (const part of data.content ?? []) {
                    const callId =
                        typeof part.id === "string"
                            ? part.id
                            : typeof part.callID === "string"
                              ? part.callID
                              : undefined;
                    const output = callId ? outputs.get(callId) : undefined;
                    if (!output) continue;
                    if (part.type === "tool" && part.state && typeof part.state === "object") {
                        (part.state as Record<string, unknown>).content = [{ type: "text", text: output }];
                        rowChanged = true;
                    } else if (part.type === "tool-result") {
                        part.result = { type: "text", value: output };
                        rowChanged = true;
                    }
                }
                if (rowChanged) {
                    if (data.content?.some((part) => part.id === outputs.keys().next().value)) {
                        data.content.unshift({ type: "reasoning", text: "converted thinking" });
                    }
                    update.run(JSON.stringify(data), row.id);
                    changed += 1;
                }
            }
        })();
    } finally {
        db.close();
    }
    return changed;
}

function requestTokens(body: Record<string, unknown>): number {
    return estimateTokens(
        JSON.stringify({
            input: body.input ?? body.messages,
            instructions: body.instructions ?? body.system,
            tools: body.tools,
        }),
    );
}

test("the first priced pass reclaims an over-window converted-store tail", async () => {
    const fixture = conversionFixture("converted-store-overwindow-e2e");
    const mock = new MockProvider();
    const provider = await mock.start();
    let v1: Awaited<ReturnType<typeof spawnOpencode1>> | undefined;
    let v2: Awaited<ReturnType<typeof spawnOpencode2>> | undefined;
    try {
        const quiet = { text: "ok", usage: { input_tokens: 1_200, output_tokens: 20 } };
        mock.setDefault(quiet);
        const magicContextConfig = {
            execute_threshold_percentage: 40,
            history_budget_percentage: 0.15,
            memory: { enabled: false },
            historian: { disable: true },
            dreamer: { disable: true },
        };

        v1 = await spawnOpencode1({
            fixture,
            mock,
            mockBaseURL: provider.baseURL,
            magicContextConfig,
            modelContextLimit: CONTEXT_LIMIT,
            modelOutputLimit: OUTPUT_LIMIT,
            logLabel: "v1-overwindow",
        });
        const sdk = await import("@opencode-ai/sdk");
        const client1 = sdk.createOpencodeClient({ baseUrl: v1.url }) as unknown as V1Client;
        const created = await client1.session.create({ query: { directory: fixture.cwd } });
        const sessionId = created.data?.id;
        if (!sessionId) throw new Error("OpenCode 1 did not create the conversion fixture session");

        const callIds = [0, 1, 2].map((index) => `toolu_converted_overwindow_${index}`);
        const files = callIds.map((callId, index) => {
            const path = join(fixture.cwd, `overwindow-${index}.txt`);
            const lines = Array.from(
                { length: 1_200 },
                (_, line) => `${callId} line ${line} ${"payload ".repeat(10)}`,
            );
            writeFileSync(path, `${lines.join("\n")}\n`);
            return path;
        });
        let requestedTool: { callId: string; filePath: string; marker: string } | null = null;
        mock.addMatcher((body) => {
            const bodyText = JSON.stringify(body);
            if (
                !requestedTool ||
                !bodyText.includes(requestedTool.marker) ||
                !bodyText.includes('"name":"read"')
            ) {
                return null;
            }
            const next = requestedTool;
            requestedTool = null;
            return {
                content: [
                    {
                        type: "tool_use",
                        id: next.callId,
                        name: "read",
                        input: { filePath: next.filePath },
                    },
                ],
                stop_reason: "tool_use" as const,
                usage: { input_tokens: 1_200, output_tokens: 20 },
            };
        });

        for (let index = 0; index < callIds.length; index += 1) {
            const turnMarker = `capture converted tool output ${index}`;
            requestedTool = {
                callId: callIds[index]!,
                filePath: files[index]!,
                marker: turnMarker,
            };
            const result = await client1.session.prompt({
                path: { id: sessionId },
                body: {
                    model: {
                        providerID: SHARED_MOCK_PROVIDER_ID,
                        modelID: SHARED_MOCK_MODEL_ID,
                    },
                    parts: [{ type: "text", text: turnMarker }],
                },
            });
            if (!result.data || result.data.info?.error) {
                throw new Error(`OpenCode 1 tool turn failed: ${JSON.stringify(result)}`);
            }
            expect(requestedTool).toBeNull();
        }

        const settle = await client1.session.prompt({
            path: { id: sessionId },
            body: {
                model: {
                    providerID: SHARED_MOCK_PROVIDER_ID,
                    modelID: SHARED_MOCK_MODEL_ID,
                },
                parts: [{ type: "text", text: "settle converted tool tagging" }],
            },
        });
        if (!settle.data || settle.data.info?.error) {
            throw new Error(`OpenCode 1 settle turn failed: ${JSON.stringify(settle)}`);
        }

        const taggedBefore = contextRows<{ messageId: string; status: string }>(
            fixture.contextDbPath,
            `SELECT message_id AS messageId, status FROM tags
              WHERE session_id = ? AND type = 'tool' AND message_id IN (?, ?, ?)
              ORDER BY message_id`,
            sessionId,
            ...callIds,
        );
        expect(taggedBefore).toHaveLength(callIds.length);
        expect(taggedBefore.every((row) => row.status === "active")).toBe(true);

        await v1.stop();
        v1 = undefined;
        const inflatedOutputs = new Map(
            callIds.map((callId) => [callId, `${callId} ${"payload ".repeat(370_000)}`]),
        );
        const beforeTokens = [...inflatedOutputs.values()].reduce(
            (total, output) => total + estimateTokens(output),
            0,
        );
        expect(beforeTokens).toBeGreaterThan(CONTEXT_LIMIT);
        expect(beforeTokens).toBeGreaterThan(1_090_000);
        fixture.env.MAGIC_CONTEXT_LOG_PATH = fixture.logPath("v2-overwindow");
        v2 = await spawnOpencode2({
            existingIsolation: fixture,
            existingMock: { mock, baseURL: provider.baseURL },
            magicContextConfig,
            modelContextLimit: CONTEXT_LIMIT,
            modelOutputLimit: OUTPUT_LIMIT,
            additionalModelIDs: [OVERFLOW_MODEL_ID],
        });
        let client2 = OpenCode.make({
            baseUrl: v2.url,
            headers: { authorization: `Basic ${btoa(`opencode:${v2.password}`)}` },
        });
        await waitForPluginActive(client2, fixture.cwd);
        await v2.stopHost();
        v2 = undefined;
        expect(inflateConvertedToolOutputs(fixture.openCodeDbPath, sessionId, inflatedOutputs)).toBe(
            callIds.length,
        );
        v2 = await spawnOpencode2({
            existingIsolation: fixture,
            existingMock: { mock, baseURL: provider.baseURL },
            magicContextConfig,
            modelContextLimit: CONTEXT_LIMIT,
            modelOutputLimit: OUTPUT_LIMIT,
            additionalModelIDs: [OVERFLOW_MODEL_ID],
        });
        client2 = OpenCode.make({
            baseUrl: v2.url,
            headers: { authorization: `Basic ${btoa(`opencode:${v2.password}`)}` },
        });
        await waitForPluginActive(client2, fixture.cwd);

        await client2.session.switchModel({
            sessionID: sessionId,
            model: { providerID: SHARED_MOCK_PROVIDER_ID, id: OVERFLOW_MODEL_ID },
        });
        const requestStart = mock.requests().length;
        const marker = "first priced converted over-window pass";
        await client2.session.prompt({ sessionID: sessionId, text: marker });
        await client2.session.wait(
            { sessionID: sessionId },
            { signal: AbortSignal.timeout(120_000) },
        );

        expect(convertedToolArcCount(fixture.openCodeDbPath, sessionId, callIds)).toBe(
            callIds.length,
        );
        const served = mock
            .requests()
            .slice(requestStart)
            .filter((request) => JSON.stringify(request.body).includes(marker));
        expect(served).toHaveLength(1);
        for (const callId of callIds) expect(JSON.stringify(served[0]!.body)).not.toContain(callId);
        const afterTokens = requestTokens(served[0]!.body);
        expect(afterTokens).toBeLessThan(CONTEXT_LIMIT);
        expect(afterTokens).toBeLessThan(beforeTokens);

        const taggedAfter = contextRows<{ messageId: string; status: string }>(
            fixture.contextDbPath,
            `SELECT message_id AS messageId, status FROM tags
              WHERE session_id = ? AND type = 'tool' AND message_id IN (?, ?, ?)
              ORDER BY message_id`,
            sessionId,
            ...callIds,
        );
        const dropped = taggedAfter.filter((row) => row.status === "dropped");
        const dropModes = contextRows<{ messageId: string; dropMode: string }>(
            fixture.contextDbPath,
            "SELECT message_id AS messageId, drop_mode AS dropMode FROM tags WHERE session_id = ? AND type = 'tool' AND message_id IN (?, ?, ?)",
            sessionId, ...callIds,
        );
        // Above 95% usage, emergency cleanup removes even recent calls instead of
        // retaining skeletons. The host store still keeps the original tool arcs.
        expect(dropModes.map((row) => row.dropMode)).toEqual(["full", "full", "full"]);

        await v2.stopHost();
        v2 = undefined;
        const logPath = fixture.logPath("v2-overwindow");
        expect(existsSync(logPath)).toBe(true);
        const log = readFileSync(logPath, "utf8");
        expect(dropped.length).toBeGreaterThan(0);
        expect(log).toContain("pressure=stale-model-ignored");
        expect(log).toContain("using wire estimate for priced pass");
        expect(log).toContain("emergency tiered drop:");
        expect(log).not.toContain("emergency tiered drop skipped: unknown-usage");
        expect(log).not.toContain("emergency tiered drop skipped: reclaim<=min");
        const emergencyBatchSize = Number(
            log.match(/emergency tiered drop: tiered drop: (\d+) tags/)?.[1] ?? 0,
        );
        expect(emergencyBatchSize).toBeGreaterThan(0);

        console.log(
            `[converted-overwindow] before=${beforeTokens} after=${afterTokens} emergency_batch=${emergencyBatchSize} dropped=${dropped.length}/${callIds.length} provider_requests=${served.length}`,
        );
    } finally {
        if (v2) await v2.stopHost().catch(() => undefined);
        if (v1) await v1.stop().catch(() => undefined);
        await mock.stop().catch(() => undefined);
    }
}, 600_000);
