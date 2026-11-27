/// <reference types="bun-types" />

/**
 * Status-notice ordering against OpenCode 1.18.x runLoop.
 *
 * OpenCode's MessageV2.latest is role-based and does not skip noReply/ignored
 * user rows. The loop-exit check is `lastAssistant.parentID === lastUser.id`.
 * A notice that is the chronologically newest user row when that check runs
 * is treated as an unanswered prompt and can fire a phantom generation.
 *
 * These scenarios drive a real `opencode serve` (ts:opencode harness) and the
 * same `session.prompt({ noReply: true, ignored })` append Magic Context uses.
 */

import { afterAll, beforeAll, expect, it } from "bun:test";
import { join } from "node:path";
import { TestHarness } from "../src/harness";
import { forEachHost } from "../src/scenario-hosts";
import { openTestDb } from "../src/test-db";

const NOTICE_TEXT = "## Magic Context status notice (e2e)";
const REAL_PROMPT = "please answer this real user prompt";

interface NoticeClient {
    session: {
        prompt: (opts: {
            path: { id: string };
            body: {
                noReply?: boolean;
                model?: { providerID: string; modelID: string };
                parts: Array<{ type: "text"; text: string; ignored?: boolean }>;
            };
        }) => Promise<{ data?: unknown; error?: unknown }>;
    };
}

interface OcMessageRow {
    id: string;
    role: string | null;
    parentID: string | null;
    finish: string | null;
    timeCreated: number;
}

interface OcPartRow {
    messageId: string;
    type: string | null;
    text: string | null;
    ignored: number | string | null;
}

let h: TestHarness;



function noticeClient(): NoticeClient {
    return h.client as unknown as NoticeClient;
}

function ocDbPath(): string {
    return join(h.opencode.env.dataDir, "opencode", "opencode.db");
}

function readMessages(sessionId: string): OcMessageRow[] {
    const db = openTestDb(ocDbPath(), { readonly: true });
    try {
        return db
            .prepare(
                `SELECT id,
                        json_extract(data, '$.role') AS role,
                        json_extract(data, '$.parentID') AS parentID,
                        json_extract(data, '$.finish') AS finish,
                        time_created AS timeCreated
                 FROM message
                 WHERE session_id = ?
                 ORDER BY time_created ASC, id ASC`,
            )
            .all(sessionId) as OcMessageRow[];
    } finally {
        db.close();
    }
}

function readParts(sessionId: string): OcPartRow[] {
    const db = openTestDb(ocDbPath(), { readonly: true });
    try {
        return db
            .prepare(
                `SELECT message_id AS messageId,
                        json_extract(data, '$.type') AS type,
                        json_extract(data, '$.text') AS text,
                        json_extract(data, '$.ignored') AS ignored
                 FROM part
                 WHERE session_id = ?
                 ORDER BY time_created ASC, id ASC`,
            )
            .all(sessionId) as OcPartRow[];
    } finally {
        db.close();
    }
}

function formatObservedRows(sessionId: string): string {
    const partsByMessage = new Map<string, OcPartRow[]>();
    for (const part of readParts(sessionId)) {
        const list = partsByMessage.get(part.messageId) ?? [];
        list.push(part);
        partsByMessage.set(part.messageId, list);
    }
    return readMessages(sessionId)
        .map((row) => {
            const parts = (partsByMessage.get(row.id) ?? [])
                .map((part) => {
                    const ignored = part.ignored === 1 || part.ignored === "true" || part.ignored === "1";
                    const preview = (part.text ?? "").slice(0, 60).replace(/\n/g, "\\n");
                    return `${part.type ?? "?"}${ignored ? "[ignored]" : ""}=${preview}`;
                })
                .join(" || ");
            return `${row.role}/${row.id} parent=${row.parentID ?? "null"} finish=${row.finish ?? "null"} parts: ${parts}`;
        })
        .join("\n");
}

async function appendIgnoredNotice(sessionId: string, text: string): Promise<void> {
    const result = await noticeClient().session.prompt({
        path: { id: sessionId },
        body: {
            noReply: true,
            model: { providerID: "mock-anthropic", modelID: "mock-sonnet" },
            parts: [{ type: "text", text, ignored: true }],
        },
    });
    if (result.data === undefined && result.error !== undefined) {
        throw new Error(`ignored notice prompt failed: ${JSON.stringify(result.error)}`);
    }
}

function findIgnoredNotice(sessionId: string, text: string): OcMessageRow | undefined {
    const parts = readParts(sessionId);
    const noticeIds = new Set(
        parts
            .filter(
                (part) =>
                    (part.ignored === 1 || part.ignored === "true" || part.ignored === "1") &&
                    (part.text ?? "").includes(text),
            )
            .map((part) => part.messageId),
    );
    return readMessages(sessionId).find((row) => row.role === "user" && noticeIds.has(row.id));
}

function findUserByText(sessionId: string, text: string): OcMessageRow | undefined {
    const parts = readParts(sessionId);
    const ids = new Set(
        parts
            .filter((part) => (part.text ?? "").includes(text) && part.ignored !== 1 && part.ignored !== "true")
            .map((part) => part.messageId),
    );
    return readMessages(sessionId).find((row) => row.role === "user" && ids.has(row.id));
}

forEachHost(import.meta.url, "status-notice loop-exit ordering", () => {
    beforeAll(async () => {
        h = await TestHarness.create({
            magicContextConfig: {
                memory: { auto_search: { enabled: false } },
            },
        });
    });

    afterAll(async () => {
        await h?.dispose();
    });
    it("idle notice then a real prompt produces one assistant whose parentID is the real user", async () => {
        h.mock.reset();
        h.mock.setDefault({
            text: "ok",
            usage: { input_tokens: 100, output_tokens: 10 },
        });

        const sessionId = await h.createSession();
        await h.sendPrompt(sessionId, "title this session");
        const requestsAfterTitle = h.mock.requests().length;

        await appendIgnoredNotice(sessionId, NOTICE_TEXT);
        const notice = findIgnoredNotice(sessionId, NOTICE_TEXT);
        expect(notice).toBeDefined();

        await h.sendPrompt(sessionId, REAL_PROMPT);
        const observed = formatObservedRows(sessionId);
        console.error(`[notice-loop-race idle] observed rows:\n${observed}`);

        const realUser = findUserByText(sessionId, REAL_PROMPT);
        expect(realUser).toBeDefined();
        const assistants = readMessages(sessionId).filter((row) => row.role === "assistant");
        const answeringReal = assistants.filter((row) => row.parentID === realUser?.id);
        const answeringNotice = assistants.filter((row) => row.parentID === notice?.id);

        expect(answeringReal.length).toBe(1);
        expect(answeringNotice.length).toBe(0);
        expect(h.mock.requests().length - requestsAfterTitle).toBe(1);
    });

    it("records what OpenCode does when a notice is forced in while a run is active", async () => {
        h.mock.reset();
        h.mock.setDefault({
            text: "ok",
            usage: { input_tokens: 100, output_tokens: 10 },
        });
        h.mock.addMatcher((body) => {
            const messages = body.messages;
            if (!Array.isArray(messages) || messages.length === 0) {
                return {
                    error: {
                        status: 400,
                        type: "invalid_request_error",
                        message: "prefill: empty messages",
                    },
                };
            }
            const hasUserText = messages.some((message) => {
                if (!message || typeof message !== "object") return false;
                const role = (message as { role?: unknown }).role;
                const content = (message as { content?: unknown }).content;
                if (role !== "user") return false;
                if (typeof content === "string") return content.trim().length > 0;
                if (!Array.isArray(content)) return false;
                return content.some((block) => {
                    if (!block || typeof block !== "object") return false;
                    const text = (block as { text?: unknown }).text;
                    return typeof text === "string" && text.trim().length > 0;
                });
            });
            if (!hasUserText) {
                return {
                    error: {
                        status: 400,
                        type: "invalid_request_error",
                        message: "prefill: empty user prompt",
                    },
                };
            }
            return null;
        });

        const sessionId = await h.createSession();
        await h.sendPrompt(sessionId, "title this session");

        let releaseReply!: () => void;
        const untilNoticeIsStored = new Promise<void>((resolve) => {
            releaseReply = resolve;
        });
        let held = false;
        h.mock.addMatcher((body) => {
            // Hold the real turn's first request, not a title or follow-up request.
            if (
                held ||
                !Array.isArray(body.messages) ||
                !JSON.stringify(body.messages.at(-1))?.includes(REAL_PROMPT)
            )
                return null;
            held = true;
            return {
                text: "slow turn",
                usage: { input_tokens: 100, output_tokens: 10 },
                until: untilNoticeIsStored,
            };
        });

        const requestsBeforeRun = h.mock.requests().length;
        const inFlight = h.sendPrompt(sessionId, REAL_PROMPT, { timeoutMs: 60_000 }).then(
            () => undefined,
            (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
        let noticeDuringRun: ReturnType<typeof findIgnoredNotice>;
        try {
            await h.waitFor(() => held, {
                timeoutMs: 15_000,
                intervalMs: 50,
                label: "in-flight provider request",
            });
            await appendIgnoredNotice(sessionId, NOTICE_TEXT);
            noticeDuringRun = findIgnoredNotice(sessionId, NOTICE_TEXT);
            expect(noticeDuringRun).toBeDefined();
        } finally {
            releaseReply();
        }

        const promptError = await inFlight;

        const observed = formatObservedRows(sessionId);
        const realUser = findUserByText(sessionId, REAL_PROMPT);
        const assistants = readMessages(sessionId).filter((row) => row.role === "assistant");
        const answeringNotice = assistants.filter((row) => row.parentID === noticeDuringRun?.id);
        const answeringReal = assistants.filter((row) => row.parentID === realUser?.id);
        const mockDelta = h.mock.requests().length - requestsBeforeRun;
        console.error(
            `[notice-loop-race busy] promptError=${promptError ?? "none"} mockDelta=${mockDelta} answeringReal=${answeringReal.length} answeringNotice=${answeringNotice.length}\n${observed}`,
        );

        expect(noticeDuringRun).toBeDefined();
        expect(realUser).toBeDefined();
        // Forced append while a run is in flight: OpenCode 1.18.x treats the
        // notice as lastUser, so the loop-exit parentID check fails and a
        // second assistant is generated against the ignored row.
        expect(answeringNotice.length).toBeGreaterThan(0);
        expect(mockDelta).toBeGreaterThan(1);
    });
});
