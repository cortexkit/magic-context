import { expect, test } from "bun:test";
import { Media } from "@opencode/ai/media";
import { Message } from "@opencode/ai/schema/messages";
import { runMigrations } from "../../features/magic-context/migrations";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { getTagsBySession, insertTag } from "../../features/magic-context/storage-tags";
import { createTagger } from "../../features/magic-context/tagger";
import { Database } from "../../shared/sqlite";
import { rememberHostMedia, resetHostMediaForTests } from "../../v2/fold/host-media";
import { adaptPayload } from "../../v2/hooks/payload";
import { estimateMessageTokens } from "./final-wire-token-estimate";
import {
    resolveBoundaryContext,
    resolveProtectedTailBoundary,
    resolveWrapupProtectedTailBoundary,
} from "./protected-tail-boundary";
import { withRawMessageProvider } from "./read-session-chunk";
import type { RawMessage } from "./read-session-raw";
import {
    buildTrueRawTokenIndex,
    estimateTrueRawMessageTokens,
} from "./read-session-true-raw-tokens";
import { stripProcessedImages } from "./strip-content";
import { type MessageLike, tagMessages } from "./tag-messages";
import { createTransform } from "./transform";

const sessionId = "visible-file-tags";
const image = `data:image/png;base64,${Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d4948445200000064000000640806000000", "hex"), Buffer.alloc(30000)]).toString("base64")}`;
function openDb() {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}
function user(): MessageLike {
    return {
        info: { id: "user", role: "user", sessionID: sessionId },
        parts: [
            { type: "text", text: "inspect the attachment" },
            { type: "file", mime: "image/png", url: image },
            { type: "file", mime: "application/pdf", url: "data:application/pdf;base64,UERG" },
        ],
    };
}
for (const host of ["oc1", "oc2"] as const) {
    test(`${host}: text plus files leaves the next visible number consecutive`, () => {
        const db = openDb();
        try {
            const tagger = createTagger();
            let messages = [
                user(),
                {
                    info: { id: "reply", role: "assistant", sessionID: sessionId },
                    parts: [{ type: "text", text: "§2§ I can see it" }],
                },
            ];
            const draft: Parameters<typeof adaptPayload>[0] = {
                sessionID: sessionId,
                model: { providerID: "anthropic", id: "test" },
                agent: "build",
                messages: [
                    {
                        id: "user",
                        role: "user",
                        content: [
                            { type: "text", text: "inspect the attachment" },
                            { type: "file", mime: "image/png", url: image },
                        ],
                    },
                    {
                        id: "reply",
                        role: "assistant",
                        content: [{ type: "text", text: "§2§ I can see it" }],
                    },
                ],
                system: [],
                tools: {},
                options: {},
            };
            if (host === "oc2")
                rememberHostMedia([
                    Message.make({
                        role: "user",
                        content: [
                            {
                                type: "media",
                                media: Media.base64(image.split(",")[1]!, "image/png"),
                            },
                        ],
                    }),
                ]);
            const mapped = host === "oc2" ? adaptPayload(draft) : undefined;
            if (mapped) messages = mapped.messages;
            tagMessages(sessionId, messages, tagger, db);
            expect(messages[0]!.parts[0]).toMatchObject({ text: "§1§ inspect the attachment" });
            expect(messages[1]!.parts[0]).toMatchObject({ text: "§2§ I can see it" });
            expect(getTagsBySession(db, sessionId).map((tag) => tag.type)).toEqual([
                "message",
                "message",
            ]);
            mapped?.commit();
            if (mapped)
                expect(draft.messages[0]!.content[1]).toMatchObject({
                    type: "media",
                    media: {
                        source: {
                            type: "base64",
                            data: image.split(",")[1],
                            mediaType: "image/png",
                        },
                    },
                });
        } finally {
            resetHostMediaForTests();
            db.close();
        }
    });
}

test("historical file rows retain their numbers and drop targets without new file allocations", () => {
    const db = openDb();
    try {
        insertTag(db, sessionId, "user:p0", "message", 22, 1);
        insertTag(db, sessionId, "user:file1", "file", image.length, 2);
        const before = getTagsBySession(db, sessionId).find((tag) => tag.type === "file");
        const message = user();
        const result = tagMessages(sessionId, [message], createTagger(), db);
        expect(getTagsBySession(db, sessionId).filter((tag) => tag.type === "file")).toEqual([
            before!,
        ]);
        expect([...result.targets.keys()]).toEqual([1, 2]);
        expect(result.targets.get(2)!.setContent("[dropped]")).toBe(true);
        expect(message.parts[1]).toEqual({ type: "text", text: "[dropped]" });
        expect(message.parts[2]).toMatchObject({ type: "file" });
    } finally {
        db.close();
    }
});

test("protected-tail stored totals fall back for unnumbered attachments but retain legacy totals", () => {
    const db = openDb();
    const message: RawMessage = { id: "user", ordinal: 1, role: "user", parts: user().parts };
    try {
        insertTag(db, sessionId, "user:p0", "message", 22, 1, 0, null, 0, null, null, {
            tokenCount: 5,
            inputTokenCount: null,
            reasoningTokenCount: null,
        });
        withRawMessageProvider(sessionId, { readMessages: () => [message] }, () => {
            const ctx = resolveBoundaryContext({
                db,
                sessionId,
                mode: "trigger",
                contextLimit: 64000,
                executeThresholdPercentage: 65,
                protectedTailMeta: { priorBoundaryOrdinal: 1, protectedTailPolicyVersion: 3 },
            });
            let observedParts: readonly unknown[] | undefined;
            resolveProtectedTailBoundary({
                ...ctx,
                storedTokenTotalsForMessages: (ids, raw) => {
                    observedParts = raw?.[0]?.parts;
                    return ctx.storedTokenTotalsForMessages!(ids, raw);
                },
            });
            expect(observedParts).toEqual(message.parts);
            const totals = ctx.storedTokenTotalsForMessages!([message.id], [message])!.totals;
            expect(totals.has(message.id)).toBe(false);
            const options = {
                providerShapeVersion: "opencode-v1" as const,
                cacheNamespace: "file-tag-coverage",
            };
            const index = buildTrueRawTokenIndex(sessionId, [message], {
                ...options,
                storedTotalForMessage: (m) => totals.get(m.id) ?? null,
            });
            expect(index.tokenForOrdinal(1)).toBe(
                estimateTrueRawMessageTokens(message, options).total,
            );
            insertTag(
                db,
                sessionId,
                "user:file1",
                "file",
                image.length,
                2,
                0,
                null,
                0,
                null,
                null,
                { tokenCount: 17, inputTokenCount: null, reasoningTokenCount: null },
            );
            insertTag(db, sessionId, "user:file2", "file", 32, 3, 0, null, 0, null, null, {
                tokenCount: 11,
                inputTokenCount: null,
                reasoningTokenCount: null,
            });
            expect(
                ctx.storedTokenTotalsForMessages!([message.id], [message])!.totals.get(message.id),
            ).toBe(33);
        });
    } finally {
        db.close();
    }
});

test("cold sidebar token accounting includes unnumbered attachments", async () => {
    const db = openDb();
    try {
        const message = user();
        const transform = createTransform({
            db,
            tagger: createTagger(),
            scheduler: { shouldExecute: () => "defer" },
            contextUsageMap: new Map(),
            historyRefreshSessions: new Set(),
            pendingMaterializationSessions: new Set(),
            lastHeuristicsTurnId: new Map(),
            clearReasoningAge: 1000,
            protectedTokens: 0,
            historianRunnable: false,
        });
        await transform({}, { messages: [message] } as never);
        expect(getOrCreateSessionMeta(db, sessionId).conversationTokens).toBe(
            estimateMessageTokens(message).conversation,
        );
        expect(getTagsBySession(db, sessionId).filter((tag) => tag.type === "file")).toEqual([]);
    } finally {
        db.close();
    }
});

for (const withText of [true, false]) {
    test(`processed images still strip without file tags (${withText ? "mixed" : "image-only"})`, () => {
        const db = openDb();
        try {
            const message = user();
            if (!withText) message.parts.shift();
            const reply: MessageLike = {
                info: { id: "reply", role: "assistant", sessionID: sessionId },
                parts: [{ type: "text", text: "image processed" }],
            };
            const messages = [message, reply];
            const result = tagMessages(sessionId, messages, createTagger(), db);
            const stripped = stripProcessedImages(messages, new Set(), {
                detect: true,
                watermark: 1,
                messageTagNumbers: result.messageTagNumbers,
                replacementText: "[image stripped]",
            });
            expect(stripped.stripped).toBe(1);
            expect(message.parts).toContainEqual(
                expect.objectContaining({ type: "text", text: "[image stripped]" }),
            );
            expect(message.parts).toContainEqual(
                expect.objectContaining({ type: "file", mime: "application/pdf" }),
            );
            expect(getTagsBySession(db, sessionId).every((tag) => tag.type !== "file")).toBe(true);
        } finally {
            db.close();
        }
    });
}

test("wrapup token boundary includes unnumbered attachments", () => {
    const db = openDb();
    const liveDb = openDb();
    const messages: RawMessage[] = Array.from({ length: 8 }, (_, i) => ({
        id: i === 0 ? "user" : `wrap-${i}`,
        ordinal: i + 1,
        role: i % 2 === 0 ? "user" : "assistant",
        parts: i === 0 ? user().parts : [{ type: "text", text: `message ${i}` }],
    }));
    try {
        insertTag(db, sessionId, "user:p0", "message", 22, 1, 0, null, 0, null, null, {
            tokenCount: 5,
            inputTokenCount: null,
            reasoningTokenCount: null,
        });
        withRawMessageProvider(sessionId, { readMessages: () => messages }, () => {
            const args = {
                sessionId,
                mode: "manual-wrapup" as const,
                contextLimit: 64000,
                executeThresholdPercentage: 65,
                messagesToKeep: 2,
            };
            const actual = resolveWrapupProtectedTailBoundary({ ...args, db });
            const live = resolveWrapupProtectedTailBoundary({ ...args, db: liveDb });
            expect(actual.snapshot.trueRawEligibleTokens).toBeGreaterThan(100);
            expect(actual.snapshot.trueRawEligibleTokens).toBe(live.snapshot.trueRawEligibleTokens);
        });
    } finally {
        db.close();
        liveDb.close();
    }
});
