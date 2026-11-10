import { expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHiddenSingleShotPrompt } from "../../features/magic-context/dreamer/hidden-single-shot";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import type { PluginContext } from "../../plugin/types";
import { hiddenModelCooldowns } from "../../shared/hidden-model-cooldown";
import type { PromptArgs } from "../../shared/model-suggestion-retry";
import { recordPromptSessionError } from "../../shared/prompt-async-transport";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import {
    createV1HiddenCompletionExecutor,
    runValidatedHistorianPass,
} from "./compartment-runner-historian";

function openTestDb(): Database {
    const db = new Database(":memory:");
    db.exec("PRAGMA busy_timeout=5000");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

const xml =
    '<output><compartment start="1" end="1" title="History"><p1>Keep the decision.</p1></compartment></output>';

for (const transport of ["stored-message", "session-event"] as const) {
    test(`historian and dreamer share structured cooldown from ${transport}, including the two-pass editor`, async () => {
        const directory = createTestTempDirFromPath(join(tmpdir(), "mc-hidden-quota-"));
        const db = openTestDb();
        let now = Date.parse("2026-10-08T00:00:00Z");
        const clock = spyOn(Date, "now").mockImplementation(() => now);
        const primary = `quota-${transport}/primary`;
        const fallback = `quota-${transport}/fallback`;
        const attempted: string[] = [];
        let nextChild = 0;
        let nextMessage = 0;
        const messages = new Map<string, unknown[]>();
        let refuse = true;
        const hostError = {
            name: "APIError",
            data: {
                statusCode: 412,
                isRetryable: false,
                responseHeaders: { "retry-after": "190000" },
                message: "Quota resets in 52h 38m",
            },
        };
        const prompt = async (request: PromptArgs) => {
            const model = request.body.model!;
            const key = `${model.providerID}/${model.modelID}`;
            attempted.push(key);
            const failed = refuse && key === primary;
            if (failed && transport === "session-event") {
                recordPromptSessionError(request.path.id, hostError);
            } else {
                messages.set(request.path.id, [
                    {
                        info: {
                            id: `message-${++nextMessage}`,
                            role: "assistant",
                            time: { created: nextMessage, completed: nextMessage },
                            ...(failed ? { error: hostError } : { finish: "stop" }),
                        },
                        parts: failed ? [] : [{ type: "text", text: xml }],
                    },
                ]);
            }
            return {};
        };
        const client = {
            session: {
                create: async () => ({ data: { id: `quota-child-${++nextChild}` } }),
                prompt,
                ...(transport === "session-event"
                    ? { promptAsync: prompt, status: async () => ({ data: {} }) }
                    : {}),
                messages: async (args: { path: { id: string } }) => ({
                    data: messages.get(args.path.id) ?? [],
                }),
                abort: async () => ({}),
                delete: async () => ({}),
                update: async () => ({}),
            },
        } as unknown as PluginContext["client"];
        const executor = createV1HiddenCompletionExecutor(client, db, directory);
        const historian = (twoPass = false) =>
            runValidatedHistorianPass({
                client,
                hiddenCompletionExecutor: executor,
                db,
                parentSessionId: `parent-${transport}`,
                sessionDirectory: directory,
                prompt: "Messages 1-1: keep the decision",
                model: primary,
                fallbackModels: [fallback],
                twoPass,
                timeoutMs: 5_000,
                chunk: {
                    startIndex: 1,
                    endIndex: 1,
                    lines: [{ ordinal: 1, messageId: "message-1" }],
                },
                priorCompartments: [],
                sequenceOffset: 0,
                dumpLabelBase: "quota",
            });
        try {
            expect((await historian()).ok).toBe(true);
            const dream = await runHiddenSingleShotPrompt({
                executor,
                parentSessionId: `parent-${transport}`,
                agent: "dreamer-classifier",
                title: "magic-context-dream-classify",
                system: "system",
                prompt: "classify",
                model: primary,
                fallbackModels: [fallback],
                timeoutMs: 5_000,
                sessionDirectory: directory,
                callContext: "dreamer:quota-test",
                parse: (text) => text,
            });
            expect(dream.validated).toBe(xml);
            expect((await historian(true)).ok).toBe(true);
            expect(attempted).toEqual([primary, fallback, fallback, fallback, fallback]);
            now += 190_000_000;
            refuse = false;
            expect((await historian(true)).ok).toBe(true);
            expect(attempted.slice(-2)).toEqual([primary, primary]);
            expect(hiddenModelCooldowns.live().some((entry) => entry.model === primary)).toBe(
                false,
            );
        } finally {
            hiddenModelCooldowns.succeeded(primary);
            clock.mockRestore();
            closeQuietly(db);
            rmSync(directory, { recursive: true, force: true });
        }
    });
}
