import { describe, expect, spyOn, test } from "bun:test";
import {
    getMemoriesByProject,
    insertMemory,
} from "../../features/magic-context/memory/storage-memory";
import type { Memory } from "../../features/magic-context/memory/types";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { buildCompartmentAgentPrompt, COMPARTMENT_AGENT_SYSTEM_PROMPT } from "./compartment-prompt";
import { calibrationForModelKey, providerMass } from "./decision-calibration";
import { fitHistorianPrompt, type HistorianPromptFitArgs } from "./historian-prompt-fit";
import { materializeM0 } from "./inject-compartments";
import {
    PRODUCER_WINDOW_REFUSAL_MARGIN,
    producerInputTokenLimit,
    producerPromptFailureReason,
} from "./producer-window-guard";
import * as formatting from "./read-session-formatting";
import { estimateTokens } from "./read-session-formatting";
import { buildReferenceBlocks, type ReferenceCompartment } from "./reference-retrieval";

const MODEL = "test/unknown-historian";

function memory(index: number, words = 40): Memory {
    return {
        id: index + 1,
        projectPath: "/project",
        category: index % 2 === 0 ? "ARCHITECTURE" : "CONSTRAINTS",
        content: `Fact ${index}: ${"the ledger keeps every decision ".repeat(words / 5)}`,
    } as Memory;
}

function compartment(index: number): ReferenceCompartment {
    return {
        startMessage: index * 10 + 1,
        endMessage: index * 10 + 10,
        title: `Compartment ${index}`,
        content: `Summary ${index}`,
        p1: `Detailed narrative ${index}: ${"work continued on the module ".repeat(60)}`,
        p2: `Condensed ${index}`,
        p3: `Outcome ${index}`,
        p4: `Anchor ${index}`,
        importance: 50,
    };
}

function args(overrides: Partial<HistorianPromptFitArgs>): HistorianPromptFitArgs {
    return {
        window: { modelKey: MODEL, contextLimitTokens: 1_000_000, maxOutputTokens: 8_000 },
        systemPrompt: COMPARTMENT_AGENT_SYSTEM_PROMPT,
        requestedChunkTokens: 10_000,
        sessionId: "ses-fit",
        chunkStart: 61,
        lastOrdinal: 400,
        sessionCompartments: Array.from({ length: 6 }, (_, index) => compartment(index)),
        memories: Array.from({ length: 300 }, (_, index) => memory(index)),
        // Most fit tests isolate producer trimming from the injection cap.
        memoryInjectionBudgetTokens: 100_000,
        memoryEnabled: true,
        ...overrides,
    };
}

/** Calibrated size of the prompt a fit would send with a chunk of `chunkTokens`. */
function sentMass(input: HistorianPromptFitArgs, fit: ReturnType<typeof fitHistorianPrompt>) {
    if (!fit.ok) throw new Error(fit.reason);
    const user = buildCompartmentAgentPrompt({
        seedExamples: fit.seedExamples,
        sessionReferences: fit.sessionReferences,
        projectMemory: fit.projectMemory,
        inputSource: `Messages ${input.chunkStart}-${input.lastOrdinal}:\n\n`,
        memoryEnabled: input.memoryEnabled,
    });
    return providerMass(
        {
            prose: estimateTokens(user) + fit.chunkTokens,
            system: estimateTokens(input.systemPrompt),
        },
        calibrationForModelKey(input.window.modelKey),
        true,
    );
}

function limitOf(input: HistorianPromptFitArgs): number {
    const limit = producerInputTokenLimit(
        input.window.contextLimitTokens,
        input.window.maxOutputTokens,
        input.window.inputLimitTokens,
    );
    if (limit === undefined) throw new Error("window unknown");
    return limit;
}

describe("fitHistorianPrompt", () => {
    test("memory facts match the main project-memory block under its configured budget", () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-memory-budget";
        const projectPath = "/historian-fixture";
        const memoryInjectionBudgetTokens = 600;
        try {
            for (let i = 0; i < 80; i += 1) {
                insertMemory(db, {
                    projectPath,
                    category: "ARCHITECTURE",
                    content: memory(i).content,
                });
            }
            const main = materializeM0({
                db,
                sessionId,
                projectPath,
                projectDirectory: "",
                state: getOrCreateSessionMeta(db, sessionId),
                memoryInjectionBudgetTokens,
            });
            const input = {
                ...args({
                    sessionId,
                    memories: () => getMemoriesByProject(db, projectPath, ["active", "permanent"]),
                }),
                memoryInjectionBudgetTokens,
                memoryProject: { db, projectPath },
            };
            const fit = fitHistorianPrompt(input);
            if (!fit.ok) throw new Error(fit.reason);
            const mainBlock = main.m0Text.match(
                /<project-memory>\n([\s\S]+?)\n<\/project-memory>/,
            )?.[1];
            expect(mainBlock).toBeDefined();
            const mainFacts = [...mainBlock!.matchAll(/^#\d+: (.+)$/gm)].map((match) => match[1]);
            expect(mainFacts.length).toBeGreaterThan(0);
            expect(mainFacts.length).toBeLessThan(80);
            const historianFacts = [...fit.projectMemory.matchAll(/^- (Fact \d+: .+)$/gm)].map(
                (match) => match[1],
            );
            expect(historianFacts).toHaveLength(mainFacts.length);
            expect(historianFacts.sort()).toEqual(mainFacts.sort());
        } finally {
            db.close();
        }
    });

    test("the three historian seeds stay byte-identical across starts in one session", () => {
        const results = [5107, 5113, 5124].map((chunkStart) =>
            fitHistorianPrompt(args({ chunkStart, lastOrdinal: chunkStart + 5, memories: [] })),
        );
        const seedBlocks = results.map((fit) => {
            if (!fit.ok) throw new Error(fit.reason);
            expect(fit.kept.seeds).toBe(3);
            return fit.seedExamples;
        });
        expect(new Set(seedBlocks).size).toBe(1);
    });

    test("memory-on loads the lazy pool once and preserves the supplied-array fit", () => {
        const memories = [memory(0), memory(1)];
        const input = args({ memories });
        let reads = 0;
        const fit = fitHistorianPrompt({
            ...input,
            memories: () => {
                reads += 1;
                return memories;
            },
        });
        expect(reads).toBe(1);
        expect(fit).toEqual(fitHistorianPrompt(input));
        if (!fit.ok) throw new Error(fit.reason);
        expect(fit.projectMemory).toContain("Fact 0:");
    });

    test("memory-off never loads project memories for fitting, even with an unknown window", () => {
        for (const window of [args({}).window, { maxOutputTokens: 8_000 }]) {
            const fit = fitHistorianPrompt(
                args({
                    window,
                    memoryEnabled: false,
                    memories: () => {
                        throw new Error("project memories were read");
                    },
                }),
            );
            if (!fit.ok) throw new Error(fit.reason);
            expect(fit.projectMemory).toBe("");
            expect(fit.kept.memories).toBe(0);
        }
    });

    test("memory-off final prompt rejects a supplied project-memory block", () => {
        const prompt = buildCompartmentAgentPrompt({
            seedExamples: "seed examples",
            sessionReferences: "session references",
            projectMemory: "<project-memory>private memory</project-memory>",
            inputSource: "session transcript",
            memoryEnabled: false,
        });
        expect(prompt).not.toContain("private memory");
        expect(prompt).not.toContain("<project-memory>");
        expect(prompt).toContain("session transcript");
    });

    test("render review: memory-off historian request must not contain project memories", () => {
        const input = args({ memoryEnabled: false, memories: [memory(0)] });
        const fit = fitHistorianPrompt(input);
        if (!fit.ok) throw new Error(fit.reason);
        const prompt = buildCompartmentAgentPrompt({
            seedExamples: fit.seedExamples,
            sessionReferences: fit.sessionReferences,
            projectMemory: fit.projectMemory,
            inputSource: "Messages 61-62:\n\nA new task.",
            memoryEnabled: false,
        });
        expect(prompt).not.toContain("Fact 0:");
        expect(prompt).not.toContain("<project-memory>");
    });

    test("fit drops diverse examples before recent, and oldest recent first", () => {
        const input = args({
            memories: [],
            sessionCompartments: Array.from({ length: 12 }, (_, i) => compartment(i)),
        });
        const full = buildReferenceBlocks(input);
        const units = full.sessionReferences.match(/<compartment [\s\S]*?<\/compartment>/g) ?? [];
        expect(units).toHaveLength(7);
        for (const remaining of [6, 4, 3]) {
            const expected = `<session_references>\n${units.slice(-remaining).join("\n\n")}\n</session_references>`;
            const fixed = buildCompartmentAgentPrompt({
                seedExamples: full.seedExamples,
                sessionReferences: expected,
                projectMemory: "",
                inputSource: `Messages ${input.chunkStart}-${input.lastOrdinal}:\n\n`,
                memoryEnabled: true,
            });
            const inputLimitTokens = Math.ceil(
                providerMass(
                    {
                        system: estimateTokens(input.systemPrompt),
                        prose: estimateTokens(fixed) + input.requestedChunkTokens + 64,
                    },
                    calibrationForModelKey(MODEL),
                    true,
                ) /
                    (1 - PRODUCER_WINDOW_REFUSAL_MARGIN),
            );
            const fit = fitHistorianPrompt({
                ...input,
                window: { modelKey: MODEL, inputLimitTokens, maxOutputTokens: 8_000 },
            });
            if (!fit.ok) throw new Error(fit.reason);
            expect(fit.kept.sessionReferences).toBe(remaining);
            expect(fit.sessionReferences).toBe(expected);
            expect(fit.kept.seeds).toBe(3);
            for (let i = 12 - Math.min(4, remaining); i < 12; i++)
                expect(fit.sessionReferences).toContain(`title="Compartment ${i}"`);
            if (remaining === 3)
                expect(fit.sessionReferences).not.toContain('title="Compartment 8"');
        }
    });
    test("repeated fixed historian prompts reuse exact token counts without changing fit bytes", () => {
        const input = args({
            sessionId: "fit-token-reuse",
            systemPrompt: `${COMPARTMENT_AGENT_SYSTEM_PROMPT}\nunique-token-reuse`,
        });
        const first = fitHistorianPrompt(input);
        const estimate = spyOn(formatting, "estimateTokens");
        // The memory selector counts individual candidates separately from the
        // producer fitter's cached system and assembled fixed user prompts.
        const systemPrefix = COMPARTMENT_AGENT_SYSTEM_PROMPT.slice(0, 100);
        const fixedPromptCounts = () =>
            estimate.mock.calls.filter(
                ([text]) =>
                    text.startsWith(systemPrefix) || text.includes("\n\n<new_messages>\n\n"),
            );
        try {
            const repeated = fitHistorianPrompt(structuredClone(input));
            expect(fixedPromptCounts()).toHaveLength(0);
            expect(JSON.stringify(repeated)).toBe(JSON.stringify(first));
            const edited = fitHistorianPrompt({ ...input, systemPrompt: `${input.systemPrompt}!` });
            expect(fixedPromptCounts().length).toBeGreaterThan(0);
            expect(edited.ok).toBe(true);
        } finally {
            estimate.mockRestore();
        }
    });
    test("keeps every block and the requested chunk when the window has room", () => {
        const input = args({});
        const fit = fitHistorianPrompt(input);
        expect(fit.ok && fit.trimmed).toBe(false);
        expect(fit.ok && fit.chunkTokens).toBe(10_000);
        expect(fit.ok && fit.kept.memories).toBe(300);
        expect(sentMass(input, fit)).toBeLessThanOrEqual(limitOf(input));
    });

    test("trims recent compartments first, then memory lines, so the requested chunk fits", () => {
        // Large enough for the system prompt, seeds and the chunk, but not for the
        // 300-line memory block on top.
        const input = args({
            window: { modelKey: MODEL, contextLimitTokens: 80_000, maxOutputTokens: 8_000 },
        });
        const fit = fitHistorianPrompt(input);
        if (!fit.ok) throw new Error(fit.reason);
        expect(fit.chunkTokens).toBe(10_000);
        expect(fit.trimmed).toBe(true);
        expect(fit.kept.sessionReferences).toBe(0);
        expect(fit.kept.memories).toBeGreaterThan(0);
        expect(fit.kept.memories).toBeLessThan(300);
        expect(fit.kept.seeds).toBe(fit.kept.seedsTotal);
        expect(sentMass(input, fit)).toBeLessThanOrEqual(limitOf(input));
        // The kept lines are the highest-priority prefix of the full block.
        expect(fit.projectMemory).toContain("Fact 0:");
    });

    test("drops the seed examples and shrinks the chunk when nothing else is left", () => {
        // Only a few thousand tokens fit next to the system prompt.
        const input = args({
            window: { modelKey: MODEL, contextLimitTokens: 41_000, maxOutputTokens: 4_000 },
        });
        const fit = fitHistorianPrompt(input);
        if (!fit.ok) throw new Error(fit.reason);
        expect(fit.kept.memories).toBe(0);
        expect(fit.kept.sessionReferences).toBe(0);
        expect(fit.chunkTokens).toBeLessThan(10_000);
        expect(fit.chunkTokens).toBeGreaterThanOrEqual(1_000);
        expect(sentMass(input, fit)).toBeLessThanOrEqual(limitOf(input));
    });

    test("refuses with the same reason wherever the chunk starts when the fixed parts alone overflow", () => {
        const small = { modelKey: MODEL, contextLimitTokens: 16_000, maxOutputTokens: 4_000 };
        const early = fitHistorianPrompt(args({ window: small, chunkStart: 1, lastOrdinal: 9 }));
        const late = fitHistorianPrompt(
            args({ window: small, chunkStart: 12_345, lastOrdinal: 99_999, memories: [] }),
        );
        expect(early.ok).toBe(false);
        expect(late.ok).toBe(false);
        if (early.ok || late.ok) return;
        expect(early.reason).toContain("producer_prompt_unfit");
        expect(early.reason).toBe(late.reason);
        // A larger window is a different outcome, so a caller backing off on the
        // reason retries once the window changes.
        const larger = fitHistorianPrompt(
            args({ window: { ...small, contextLimitTokens: 1_000_000 } }),
        );
        expect(larger.ok).toBe(true);
    });

    test("sends the full prompt unguarded when the window is unknown", () => {
        const fit = fitHistorianPrompt(
            args({ window: { modelKey: MODEL, maxOutputTokens: 8_000 } }),
        );
        expect(fit.ok && fit.guarded).toBe(false);
        expect(fit.ok && fit.chunkTokens).toBe(10_000);
        expect(fit.ok && fit.kept.memories).toBe(300);
    });
});

/**
 * The pre-send refusal each attempt applies, for a prompt carrying a chunk of
 * exactly `fit.chunkTokens` local tokens.
 */
function refusalFor(
    input: HistorianPromptFitArgs,
    fit: ReturnType<typeof fitHistorianPrompt>,
    window: HistorianPromptFitArgs["window"],
): string | null {
    if (!fit.ok) throw new Error(fit.reason);
    const user = buildCompartmentAgentPrompt({
        seedExamples: fit.seedExamples,
        sessionReferences: fit.sessionReferences,
        projectMemory: fit.projectMemory,
        inputSource: `Messages ${input.chunkStart}-${input.lastOrdinal}:\n\n`,
        memoryEnabled: input.memoryEnabled,
    });
    return producerPromptFailureReason({
        sourceLocal: estimateTokens(user) + fit.chunkTokens,
        systemLocal: estimateTokens(input.systemPrompt),
        toolsLocal: 0,
        modelKey: window.modelKey,
        contextLimitTokens: window.contextLimitTokens,
        inputLimitTokens: window.inputLimitTokens,
        maxOutputTokens: window.maxOutputTokens,
    });
}

describe("fitHistorianPrompt across the attempt chain", () => {
    // A 200,000-token window with a 32,000-token output reserve and the 3%
    // estimator margin leaves the small model an input limit of 162,960 tokens.
    const small = {
        modelKey: "opencode/small-free",
        contextLimitTokens: 200_000,
        maxOutputTokens: 32_000,
    };
    const large = {
        modelKey: "google/large-flash",
        contextLimitTokens: 1_000_000,
        maxOutputTokens: 32_000,
    };
    // A chunk request the small window cannot hold.
    const oversized = { requestedChunkTokens: 400_000, memories: [] };

    test("a small primary gets a chunk that fits it ahead of a large fallback", () => {
        const input = args({ ...oversized, window: small, fallbackWindows: [large] });
        const fit = fitHistorianPrompt(input);
        if (!fit.ok) throw new Error(fit.reason);
        expect(limitOf(input)).toBe(162_960);
        expect(fit.chunkTokens).toBeLessThan(400_000);
        expect(refusalFor(input, fit, small)).toBeNull();
        expect(refusalFor(input, fit, large)).toBeNull();
    });

    test("a large primary's chunk is also sized for a smaller fallback", () => {
        const input = args({ ...oversized, window: large, fallbackWindows: [small] });
        const fit = fitHistorianPrompt(input);
        if (!fit.ok) throw new Error(fit.reason);
        expect(fit.chunkTokens).toBeLessThan(400_000);
        expect(refusalFor(input, fit, large)).toBeNull();
        expect(refusalFor(input, fit, small)).toBeNull();
        // Control: fitted for the primary alone, the fallback refuses the prompt.
        const primaryOnly = fitHistorianPrompt({ ...input, fallbackWindows: [] });
        expect(refusalFor(input, primaryOnly, small)).toContain("producer_prompt_exceeds_window");
    });

    test("a chain whose windows all hold the requested chunk keeps the fit unchanged", () => {
        const input = args({ window: small, fallbackWindows: [large] });
        expect(JSON.stringify(fitHistorianPrompt(input))).toBe(
            JSON.stringify(fitHistorianPrompt({ ...input, fallbackWindows: undefined })),
        );
    });

    test("a fallback too small for any prompt does not shrink the chunk", () => {
        const tiny = { modelKey: "tiny/model", contextLimitTokens: 4_000, maxOutputTokens: 1_000 };
        const input = args({ window: large, fallbackWindows: [tiny] });
        expect(JSON.stringify(fitHistorianPrompt(input))).toBe(
            JSON.stringify(fitHistorianPrompt({ ...input, fallbackWindows: [] })),
        );
    });

    test("a known fallback window guards the chunk when the primary's window is unknown", () => {
        const input = args({
            ...oversized,
            window: { modelKey: MODEL, maxOutputTokens: 8_000 },
            fallbackWindows: [small],
        });
        const fit = fitHistorianPrompt(input);
        if (!fit.ok) throw new Error(fit.reason);
        expect(fit.guarded).toBe(true);
        expect(fit.chunkTokens).toBeLessThan(400_000);
        expect(refusalFor(input, fit, small)).toBeNull();
    });
});
