import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { recordDetectedContextLimit } from "../../features/magic-context/storage-meta-persisted";
import {
    __resetToolDefinitionMeasurements,
    recordToolDefinition,
} from "../../features/magic-context/tool-definition-tokens";
import { clearModelsDevCache, refreshModelLimitsFromApi } from "../../shared/models-dev-cache";
import { Database } from "../../shared/sqlite";
import { resolveContextWindowGeometry, resolveTrustedContextLimit } from "./event-resolvers";
import { wireContentBytes } from "./final-wire-token-estimate";
import {
    beginV2LkgRequest,
    clearLkgMeasuredRequest,
    noteLkgProviderResponse,
} from "./lkg-measured-request";
import { captureLkgSlot } from "./lkg-replay";
import { lkgReplayFits, lkgReplayLimit } from "./lkg-replay-fit";
import { captureSlot, getSlot, resetLkgSlotsForTest } from "./lkg-slot";
import type { MessageLike } from "./transform-operations";

// A model whose usable hard limit (the window less the output it requests) is
// above its trusted limit (the window less its output reserve), so the two
// limits differ. A declared input limit would not do: it caps both limits.
const MODEL = { providerID: "openai-codex", modelID: "fit-model" };
const SESSION = "lkg-replay-fit-session";

function freshDb() {
    const db = new Database(":memory:");
    initializeDatabase(db as never);
    runMigrations(db as never);
    return db as never;
}

const messages: MessageLike[] = [
    {
        info: { id: "m1", role: "user", sessionID: SESSION },
        parts: [{ type: "text", text: "hello" }],
    } as MessageLike,
];

/** An estimator reporting a fixed, trusted token count. */
const estimateOf =
    (tokens: number, trusted = true) =>
    () => ({
        tokens,
        trusted,
        messageTokens: { conversation: tokens, toolCall: 0 },
        systemTokens: 0,
        toolDefinitionTokens: 0,
    });

describe("one admission limit for every last-known-good replay", () => {
    beforeEach(async () => {
        await refreshModelLimitsFromApi({
            config: {
                providers: async () => ({
                    data: {
                        providers: [
                            {
                                id: MODEL.providerID,
                                models: {
                                    [MODEL.modelID]: {
                                        limit: {
                                            context: 272_000,
                                            output: 128_000,
                                        },
                                    },
                                },
                            },
                        ],
                    },
                }),
            },
        });
    });
    afterEach(() => clearModelsDevCache());

    it("admits every replay against the trusted limit, never the larger usable hard limit", () => {
        const db = freshDb();
        const ctx = { db, sessionID: SESSION };
        const usableHard = resolveContextWindowGeometry(MODEL.providerID, MODEL.modelID, ctx)
            ?.usableHard as number;
        const trusted = resolveTrustedContextLimit(MODEL.providerID, MODEL.modelID, ctx) as number;
        expect(trusted).toBe(204_000);
        expect(usableHard).toBeGreaterThan(trusted);
        expect(lkgReplayLimit({ db, sessionId: SESSION, model: MODEL, modelKey: null })).toBe(
            trusted,
        );

        const fits = (tokens: number) =>
            lkgReplayFits({
                db,
                sessionId: SESSION,
                messages,
                model: MODEL,
                modelKey: null,
                systemPromptTokens: 0,
                estimator: estimateOf(tokens),
            });
        // No replay is admitted between the trusted limit and the usable hard
        // limit.
        expect(fits(trusted).fits).toBe(true);
        expect(fits(trusted + 1).fits).toBe(false);
        expect(fits(usableHard).fits).toBe(false);
    });

    it("the byte proxy counts what the request carries, not OpenCode's own tool metadata", () => {
        const fileText = "x".repeat(100_000);
        const editing: MessageLike = {
            info: { id: "a1", role: "assistant", sessionID: SESSION },
            parts: [
                {
                    type: "tool",
                    tool: "edit",
                    callID: "call-a1",
                    state: {
                        status: "completed",
                        input: { filePath: "/tmp/big.ts" },
                        output: "ok",
                        metadata: { filediff: { before: fileText, after: fileText } },
                    },
                },
                { type: "text", text: "done" },
            ],
        } as MessageLike;
        const measured = wireContentBytes([editing], Number.POSITIVE_INFINITY, 4);
        // The tool input and output, serialized, and the text part; not the file copies.
        expect(measured).toEqual({
            bytes: JSON.stringify({ filePath: "/tmp/big.ts" }).length + "ok".length + "done".length,
            aborted: false,
        });
    });

    it("declines an untrusted estimate", () => {
        const db = freshDb();
        const fit = lkgReplayFits({
            db,
            sessionId: SESSION,
            messages,
            model: MODEL,
            modelKey: null,
            systemPromptTokens: 0,
            estimator: estimateOf(10, false),
        });
        expect(fit).toEqual({ fits: false, detail: expect.stringContaining("lkg_fit_untrusted") });
    });

    it("declines from the byte proxy without tokenizing", () => {
        const db = freshDb();
        let estimates = 0;
        const huge: MessageLike[] = [
            {
                info: { id: "m1", role: "user", sessionID: SESSION },
                parts: [{ type: "text", text: "word ".repeat(400_000) }],
            } as MessageLike,
        ];
        const fit = lkgReplayFits({
            db,
            sessionId: SESSION,
            messages: huge,
            model: MODEL,
            modelKey: null,
            systemPromptTokens: 0,
            estimator: () => {
                estimates += 1;
                return estimateOf(10)();
            },
        });
        expect(fit.fits).toBe(false);
        expect(estimates).toBe(0);
    });
});

describe("provider-measured LKG prefix plus only the appended tail", () => {
    const model = { providerID: "measured-test", modelID: "unknown-tokenizer" };
    const modelKey = `${model.providerID}/${model.modelID}`;
    const sessionId = "measured-lkg-fit";
    const systemPromptTokens = 100;
    let db: ReturnType<typeof freshDb>;
    const prefix: MessageLike[] = [
        {
            info: { id: "input", role: "user", sessionID: sessionId, model },
            parts: [{ type: "text", text: "x ".repeat(500_000) }],
        } as MessageLike,
    ];
    const tail = (text = "small new tail"): MessageLike[] => [
        {
            info: { id: "reply", role: "assistant", sessionID: sessionId },
            parts: [{ type: "text", text: "accepted reply" }],
        } as MessageLike,
        {
            info: { id: "next", role: "user", sessionID: sessionId, model },
            parts: [{ type: "text", text }],
        } as MessageLike,
    ];
    const fit = (messages = [...prefix, ...tail()]) =>
        lkgReplayFits({
            db,
            sessionId,
            messages,
            model,
            modelKey,
            systemPromptTokens,
        });
    function capture(host: "v1" | "v2") {
        if (host === "v1")
            noteLkgProviderResponse({ sessionId, modelKey, responseId: "reply", inputTokens: 0 });
        else beginV2LkgRequest(sessionId, modelKey, "previous-reply");
        expect(
            captureLkgSlot({
                sessionId,
                input: prefix,
                output: prefix,
                modelKey,
                providerKey: model.providerID,
                systemPromptTokens,
            }),
        ).toBe(true);
    }
    function usage(inputTokens: number, host: "v1" | "v2", responseId = "reply") {
        noteLkgProviderResponse({
            sessionId,
            modelKey,
            responseId,
            inputTokens,
            finish: "stop",
            completedAt: Date.now() + 1,
            ...(host === "v2" ? { v2: true, createdAt: Date.now() + 1 } : {}),
        });
    }
    beforeEach(() => {
        db = freshDb();
        resetLkgSlotsForTest();
        clearLkgMeasuredRequest(sessionId);
        recordDetectedContextLimit(db, sessionId, 872_000, modelKey);
        recordToolDefinition(
            model.providerID,
            model.modelID,
            undefined,
            "read",
            "read fixture",
            {},
        );
    });
    afterEach(() => {
        clearLkgMeasuredRequest(sessionId);
        resetLkgSlotsForTest();
        __resetToolDefinitionMeasurements();
        (db as any).close();
    });
    for (const host of ["v1", "v2"] as const) {
        it(`${host}: admits measured 633258 plus a small tail despite the inflated full estimate`, () => {
            capture(host);
            // The real full estimator and unknown-model fit calibration refuse this
            // fixture, not a stub that returns the answer asserted below.
            expect(fit().fits).toBe(false);
            usage(633_258, host);
            expect(fit()).toEqual({ fits: true });
        });
        it(`${host}: refuses measured near-limit input plus a large appended tail`, () => {
            capture(host);
            usage(871_000, host);
            expect(fit([...prefix, ...tail("big tail ".repeat(20_000))])).toEqual({
                fits: false,
                detail: expect.stringContaining("lkg_over_context_limit"),
            });
        });
        it(`${host}: another response's measurement retains the old full estimate`, () => {
            capture(host);
            usage(633_258, host, host === "v1" ? "unrelated-reply" : "previous-reply");
            expect(fit().fits).toBe(false);
        });
    }
    it("a replaced slot cannot borrow the previous capture's usage even with identical bytes", () => {
        capture("v1");
        usage(633_258, "v1");
        const slot = getSlot(sessionId)!;
        expect(captureSlot(sessionId, { ...slot, capturedAt: slot.capturedAt + 1 })).toBe(true);
        expect(fit().fits).toBe(false);
    });
    it("tail token calibration refuses a replay whose tail byte proxy alone fits", () => {
        capture("v1");
        usage(871_000, "v1");
        expect(fit([...prefix, ...tail("x ".repeat(700))])).toEqual({
            fits: false,
            detail: expect.stringContaining("lkg_over_context_limit estimated=872"),
        });
    });
    it("measured input already includes system and tool definitions", () => {
        capture("v1");
        usage(871_900, "v1");
        expect(fit()).toEqual({ fits: true });
    });
    it("a model change cannot use another model's accepted input", () => {
        capture("v1");
        usage(633_258, "v1");
        const otherModel = { ...model, modelID: "other-model" };
        recordDetectedContextLimit(
            db,
            sessionId,
            872_000,
            `${otherModel.providerID}/${otherModel.modelID}`,
        );
        expect(
            lkgReplayFits({
                db,
                sessionId,
                messages: [...prefix, ...tail()],
                model: otherModel,
                modelKey: `${otherModel.providerID}/${otherModel.modelID}`,
                systemPromptTokens,
            }).fits,
        ).toBe(false);
    });
    it("a new envelope cannot borrow the prior envelope's measured input", () => {
        capture("v1");
        usage(633_258, "v1");
        expect(
            lkgReplayFits({
                db,
                sessionId,
                messages: [...prefix, ...tail()],
                model,
                modelKey,
                systemPromptTokens: systemPromptTokens + 1,
            }).fits,
        ).toBe(false);
    });
    it("a recapture without a new request identity cannot consume a duplicate old usage event", () => {
        capture("v1");
        usage(633_258, "v1");
        capture("v1");
        usage(633_258, "v1");
        expect(fit().fits).toBe(false);
    });
    it("v2 cannot attribute a late old reply to a new request", () => {
        capture("v2");
        noteLkgProviderResponse({
            sessionId,
            modelKey,
            responseId: "reply",
            inputTokens: 633_258,
            finish: "stop",
            v2: true,
            createdAt: 1,
            completedAt: Date.now(),
        });
        expect(fit().fits).toBe(false);
    });
    it("a changed replay prefix cannot borrow the old request's usage", () => {
        capture("v1");
        usage(633_258, "v1");
        const changed = structuredClone(prefix);
        changed[0]!.parts.push({ type: "text", text: "changed prefix" } as never);
        expect(fit([...changed, ...tail()]).fits).toBe(false);
    });
    it("a reply not at the prefix seam cannot borrow the measured usage", () => {
        capture("v1");
        usage(633_258, "v1");
        const changedTail = tail();
        changedTail[0]!.info.id = "different-reply";
        expect(fit([...prefix, ...changedTail]).fits).toBe(false);
    });
    it("an unknown appended part remains unproven with measured input", () => {
        capture("v1");
        usage(633_258, "v1");
        const changedTail = tail();
        changedTail[1]!.parts.push({ type: "future-provider-part" } as never);
        expect(fit([...prefix, ...changedTail])).toEqual({
            fits: false,
            detail: expect.stringContaining("lkg_fit_untrusted"),
        });
    });
});
