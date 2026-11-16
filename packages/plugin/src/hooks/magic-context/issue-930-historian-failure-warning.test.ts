/// <reference types="bun-types" />

/**
 * Issue 930: the early warning when history summary runs keep failing.
 *
 * Before usage reaches 95%, where a turn waits for a summary and may be
 * refused, the person is told that summaries keep failing: at the third
 * failed run in a row, then again only while failures continue, at the next
 * multiple of three and at most once per 30 minutes. A successful run resets
 * the count. The warning goes through the status-notice channel (a TUI toast
 * on OpenCode), never into the model's prompt.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireCompartmentLease } from "../../features/magic-context/compartment-lease";
import { replaceAllCompartmentState } from "../../features/magic-context/compartment-storage";
import { runMigrations } from "../../features/magic-context/migrations";
import {
    type ContextDatabase,
    closeDatabase,
    getHistorianFailureState,
    openDatabase,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { createTagger } from "../../features/magic-context/tagger";
import type { PluginContext } from "../../plugin/types";
import { clearModelsDevCache, refreshModelLimitsFromApi } from "../../shared/models-dev-cache";
import {
    __resetNotificationStateForTests,
    type RpcNotification,
    registerNotificationSink,
} from "../../shared/rpc-notifications";
import { Database } from "../../shared/sqlite";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { runCompartmentAgent } from "./compartment-runner-incremental";
import {
    clearRepeatedHistorianFailureWarning,
    formatHistorianClockTime,
    REPEATED_HISTORIAN_FAILURE_WARNING_INTERVAL_MS,
    shouldWarnRepeatedHistorianFailures,
} from "./historian-failure-report";
import { createDefaultBoundarySnapshotForTests } from "./protected-tail-boundary";
import { setRawMessageProvider } from "./read-session-chunk";
import type { RawMessage } from "./read-session-raw";
import { createTransform } from "./transform";

const WARNING_TITLE = "Magic Context — History summaries keep failing";
const HISTORIAN_MODEL = "test/fixture-historian";
const ACTIONS =
    "What to do: run /ctx-status for detail; change the historian model or its fallback models in magic-context.jsonc; or run /ctx-recomp to rebuild the history.";

const cleanups: Array<() => void> = [];
afterEach(() => {
    for (const cleanup of cleanups.reverse()) cleanup();
    cleanups.length = 0;
    __resetNotificationStateForTests();
    clearModelsDevCache();
});

function message(ordinal: number): RawMessage {
    return {
        ordinal,
        id: `m${ordinal}`,
        role: ordinal % 2 === 1 ? "user" : "assistant",
        parts: [
            {
                type: "text",
                text: `Message ${ordinal}: investigate why the summary of older history keeps failing.`,
            },
        ],
    };
}

/** The stored compartment's own range, as the model wrongly copies it back. */
const COPIED_RANGE_OUTPUT =
    '<compartment start="1" end="4" title="Earlier work"><p1>Copied the earlier summary.</p1></compartment>';

/** Status toasts pushed for one session, through the channel the TUI reads. */
function captureToasts(sessionId: string): RpcNotification[] {
    const toasts: RpcNotification[] = [];
    cleanups.push(
        registerNotificationSink({
            sessionId,
            protocol: 2,
            send: (notification) => {
                if (notification.type === "toast") toasts.push(notification);
            },
        }),
    );
    return toasts;
}

function warnings(toasts: RpcNotification[]): string[] {
    return toasts
        .filter((toast) => toast.payload.title === WARNING_TITLE)
        .map((toast) => String(toast.payload.message));
}

/**
 * A historian client for one session. It answers with `output()`, and
 * records every prompt it receives, by the session it was sent to.
 */
function historianClient(output: () => string) {
    const prompts: Array<{ sessionId: string | undefined; text: string }> = [];
    const client = {
        session: {
            get: mock(async () => ({ data: { directory: process.cwd() } })),
            create: mock(async () => ({ data: { id: "historian-child" } })),
            prompt: mock(
                async (args: {
                    path?: { id?: string };
                    body?: { parts?: Array<{ text?: string }> };
                }) => {
                    prompts.push({
                        sessionId: args.path?.id,
                        text: args.body?.parts?.[0]?.text ?? "",
                    });
                    return {};
                },
            ),
            messages: mock(async () => ({
                data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: output() }] }],
            })),
            delete: mock(async () => ({})),
        },
    } as unknown as PluginContext["client"];
    return { client, prompts };
}

/** One incremental historian run over the raw messages `messages()` lists. */
async function runHistorian(args: {
    db: ContextDatabase;
    sessionId: string;
    holder: string;
    client: PluginContext["client"];
    messages: () => RawMessage[];
}): Promise<void> {
    const unregister = setRawMessageProvider(args.sessionId, { readMessages: args.messages });
    try {
        await runCompartmentAgent({
            db: args.db,
            sessionId: args.sessionId,
            client: args.client,
            directory: process.cwd(),
            historianChunkTokens: 20_000,
            boundarySnapshot: createDefaultBoundarySnapshotForTests(args.sessionId),
            compartmentLeaseHolderId: args.holder,
            memoryEnabled: false,
            model: HISTORIAN_MODEL,
            // Every run here reads the same chunk; the per-window drain quota
            // would otherwise turn later runs into no-ops.
            forceDrainQuota: true,
        });
    } finally {
        unregister();
    }
}

async function observeHistorianModel(
    extra: Record<string, Record<string, unknown>> = {},
): Promise<void> {
    await refreshModelLimitsFromApi({
        config: {
            providers: async () => ({
                data: {
                    providers: [
                        {
                            id: "test",
                            models: {
                                "fixture-historian": {
                                    limit: { context: 1_000_000, output: 32_000 },
                                },
                            },
                        },
                        ...Object.entries(extra).map(([id, models]) => ({ id, models })),
                    ],
                },
            }),
        },
    });
}

describe("issue 930: early warning when summary runs keep failing", () => {
    it("is due at the 3rd failure, not the 2nd or 4th, at the 6th only 30 minutes after the last, and again after a reset", () => {
        const sessionId = `issue-930-gate-${crypto.randomUUID()}`;
        cleanups.push(() => clearRepeatedHistorianFailureWarning(sessionId));
        const start = 1_800_000_000_000;
        const interval = REPEATED_HISTORIAN_FAILURE_WARNING_INTERVAL_MS;

        expect(shouldWarnRepeatedHistorianFailures(sessionId, 1, start)).toBe(false);
        expect(shouldWarnRepeatedHistorianFailures(sessionId, 2, start)).toBe(false);
        expect(shouldWarnRepeatedHistorianFailures(sessionId, 3, start)).toBe(true);
        expect(shouldWarnRepeatedHistorianFailures(sessionId, 4, start + 1)).toBe(false);
        expect(shouldWarnRepeatedHistorianFailures(sessionId, 5, start + 2)).toBe(false);
        // The next multiple of three within 30 minutes of the last warning.
        expect(shouldWarnRepeatedHistorianFailures(sessionId, 6, start + interval - 1)).toBe(false);
        // Failures continue: the next multiple of three after 30 minutes.
        expect(shouldWarnRepeatedHistorianFailures(sessionId, 9, start + interval)).toBe(true);
        expect(shouldWarnRepeatedHistorianFailures(sessionId, 12, start + interval + 1)).toBe(
            false,
        );
        // A success reset the count; the new streak's 3rd failure is due
        // even within 30 minutes of the last warning.
        expect(shouldWarnRepeatedHistorianFailures(sessionId, 1, start + interval + 2)).toBe(false);
        expect(shouldWarnRepeatedHistorianFailures(sessionId, 3, start + interval + 3)).toBe(true);

        const other = `issue-930-gate-${crypto.randomUUID()}`;
        cleanups.push(() => clearRepeatedHistorianFailureWarning(other));
        expect(shouldWarnRepeatedHistorianFailures(other, 3, start)).toBe(true);
        expect(shouldWarnRepeatedHistorianFailures(other, 6, start + interval)).toBe(true);
    });

    it("shows the warning with its facts at the 3rd failed run in a row, not before or after, and again after a successful run resets the count", async () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);
        cleanups.push(() => db.close());
        const sessionId = `issue-930-warning-${crypto.randomUUID()}`;
        cleanups.push(() => clearRepeatedHistorianFailureWarning(sessionId));
        const messages = Array.from({ length: 24 }, (_, index) => message(index + 1));
        replaceAllCompartmentState(
            db,
            sessionId,
            [
                {
                    sequence: 0,
                    startMessage: 1,
                    endMessage: 4,
                    startMessageId: "m1",
                    endMessageId: "m4",
                    title: "Earlier work",
                    content: "Summarized the first four messages.",
                    p1: "Summarized the first four messages.",
                    p2: "First four messages.",
                    p3: "Earlier work.",
                    p4: "earlier",
                },
            ],
            [],
        );
        // The provider's last reading, before the 95% band.
        updateSessionMeta(db, sessionId, { lastContextPercentage: 82, lastInputTokens: 82_000 });
        const holder = "issue-930-warning";
        expect(acquireCompartmentLease(db, sessionId, holder)).not.toBeNull();
        await observeHistorianModel();
        const { client, prompts } = historianClient(() => COPIED_RANGE_OUTPUT);
        const toasts = captureToasts(sessionId);
        const run = () => runHistorian({ db, sessionId, holder, client, messages: () => messages });
        const chunkRows = () =>
            db
                .prepare(
                    "SELECT chunk_start_ordinal AS start, chunk_end_ordinal AS end FROM historian_runs WHERE session_id = ? AND status = 'failed' ORDER BY id",
                )
                .all(sessionId) as Array<{ start: number; end: number }>;

        await run();
        await run();
        expect(getHistorianFailureState(db, sessionId).failureCount).toBe(2);
        expect(warnings(toasts)).toEqual([]);

        await run();
        const state = getHistorianFailureState(db, sessionId);
        expect(state.failureCount).toBe(3);
        const [first] = warnings(toasts);
        expect(warnings(toasts)).toHaveLength(1);
        const [chunk] = chunkRows();
        const firstFailedRunEnded = (
            db
                .prepare(
                    "SELECT created_at FROM historian_runs WHERE session_id = ? AND status = 'failed' ORDER BY id LIMIT 1",
                )
                .get(sessionId) as { created_at: number }
        ).created_at;
        expect(first).toBe(
            [
                `## ${WARNING_TITLE}`,
                "",
                `Summary runs failed in a row: 3, since ${formatHistorianClockTime(firstFailedRunEnded)}. Last chunk: messages ${chunk!.start}-${chunk!.end}. Last error: ${state.lastError}. Now context is at 82% of the window; at 95% a turn waits for a summary and is not sent if none finishes in time.`,
                "",
                ACTIONS,
            ].join("\n"),
        );
        expect(state.lastError).toContain(
            "Compartment range 1-4 does not map to raw session lines 5-",
        );

        // Not repeated at 4 or 5, nor at 6 within 30 minutes of the last one.
        await run();
        await run();
        await run();
        expect(getHistorianFailureState(db, sessionId).failureCount).toBe(6);
        expect(warnings(toasts)).toHaveLength(1);

        // A successful run publishes the chunk and resets the count.
        const succeeding: ReturnType<typeof historianClient> = historianClient(() => {
            const range = /Messages (\d+)-(\d+):\n/.exec(succeeding.prompts.at(-1)?.text ?? "");
            return `<compartment start="${range?.[1]}" end="${range?.[2]}" title="Recovered"><p1>Summarized the chunk.</p1></compartment>`;
        });
        await runHistorian({
            db,
            sessionId,
            holder,
            client: succeeding.client,
            messages: () => messages,
        });
        expect(getHistorianFailureState(db, sessionId).failureCount).toBe(0);

        // A new streak warns again at its 3rd failure, within 30 minutes.
        messages.push(...Array.from({ length: 24 }, (_, index) => message(index + 25)));
        await run();
        await run();
        expect(warnings(toasts)).toHaveLength(1);
        await run();
        expect(getHistorianFailureState(db, sessionId).failureCount).toBe(3);
        expect(warnings(toasts)).toHaveLength(2);
        expect(warnings(toasts)[1]).toContain("Summary runs failed in a row: 3, since ");

        // The warning was never written into the session itself.
        expect(
            [...prompts, ...succeeding.prompts].filter((prompt) => prompt.sessionId === sessionId),
        ).toEqual([]);
    });

    it("touches no prompt bytes: the transform's output is byte-identical with and without the warning", async () => {
        const dir = createTestTempDirFromPath(join(tmpdir(), "issue-930-warning-bytes-"));
        const originalXdgDataHome = process.env.XDG_DATA_HOME;
        const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
        process.env.XDG_DATA_HOME = dir;
        process.env.XDG_CACHE_HOME = dir;
        cleanups.push(() => {
            closeDatabase();
            if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
            else process.env.XDG_DATA_HOME = originalXdgDataHome;
            if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
            else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
            rmSync(dir, { recursive: true, force: true });
        });
        const sessionId = `ses-issue-930-warning-bytes-${crypto.randomUUID()}`;
        cleanups.push(() => clearRepeatedHistorianFailureWarning(sessionId));
        await observeHistorianModel({
            "issue-930-provider": {
                "issue-930-model": { limit: { context: 100_000, output: 32_000 } },
            },
        });
        const db = openDatabase();
        const holder = "issue-930-warning-bytes";
        expect(acquireCompartmentLease(db, sessionId, holder)).not.toBeNull();
        const rawHistory = Array.from({ length: 24 }, (_, index) => message(index + 1));
        const { client } = historianClient(
            () =>
                '<compartment start="900" end="950" title="Elsewhere"><p1>Not this chunk.</p1></compartment>',
        );
        const toasts = captureToasts(sessionId);
        const transform = createTransform({
            tagger: createTagger(),
            scheduler: { shouldExecute: mock(() => "defer" as const) },
            contextUsageMap: new Map([
                [
                    sessionId,
                    { usage: { percentage: 40, inputTokens: 40_000 }, updatedAt: Date.now() },
                ],
            ]),
            db,
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTokens: 0,
            client: {
                session: {
                    get: mock(async () => ({ data: { directory: "/tmp", title: "Issue 930" } })),
                    prompt: mock(async () => ({})),
                },
            } as unknown as PluginContext["client"],
            directory: "/tmp",
            liveModelBySession: new Map([
                [sessionId, { providerID: "issue-930-provider", modelID: "issue-930-model" }],
            ]),
            getModelKey: () => "issue-930-provider/issue-930-model",
            getNotificationParams: () => ({
                agent: "build",
                providerId: "issue-930-provider",
                modelId: "issue-930-model",
            }),
        });
        const conversation = () => [
            {
                info: { id: "m-user-1", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "Summarize why the history keeps failing." }],
            },
            {
                info: { id: "m-assistant-1", role: "assistant", sessionID: sessionId },
                parts: [{ type: "text", text: "Looking at the historian runs now." }],
            },
            {
                info: { id: "m-user-2", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "continue" }],
            },
        ];
        const pass = async (): Promise<string> => {
            const messages = conversation();
            await transform({}, { messages });
            return JSON.stringify(messages);
        };
        const fail = () =>
            runHistorian({ db, sessionId, holder, client, messages: () => rawHistory });

        await pass();
        await fail();
        await fail();
        const withoutWarning = await pass();
        expect(warnings(toasts)).toEqual([]);

        await fail();
        expect(getHistorianFailureState(db, sessionId).failureCount).toBe(3);
        expect(warnings(toasts)).toHaveLength(1);
        const withWarning = await pass();

        expect(withWarning).toBe(withoutWarning);
        expect(withWarning).not.toContain("keep failing");
    });
});
