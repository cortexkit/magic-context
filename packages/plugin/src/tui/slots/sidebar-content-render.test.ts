import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { RenderCase, RenderResult } from "../../../scripts/render-compiled-sidebar";
import type { SidebarSnapshot } from "../data/context-db";

const BASE: SidebarSnapshot = {
    sessionId: "ses_sidebar",
    usagePercentage: 10,
    inputTokens: 1000,
    contextLimit: 10_000,
    systemPromptTokens: 500,
    compartmentCount: 0,
    memoryCount: 7,
    memoryBlockCount: 0,
    pendingOpsCount: 0,
    historianRunning: false,
    compartmentInProgress: false,
    sessionNoteCount: 0,
    readySmartNoteCount: 0,
    cacheTtl: "5m",
    lastTransformError: null,
    lastDreamerRunAt: null,
    projectIdentity: null,
    compartmentTokens: 0,
    factTokens: 0,
    memoryTokens: 0,
    docsTokens: 0,
    profileTokens: 0,
    conversationTokens: 500,
    toolCallTokens: 0,
    toolDefinitionTokens: 0,
    executeThreshold: 65,
};
const REFRESHED = {
    ...BASE,
    usagePercentage: 20,
    inputTokens: 2000,
    conversationTokens: 1500,
    memoryCount: 8,
};
const tailHygiene = {
    u: 250,
    t: 500,
    severity: 0.5,
    evaluable: true,
    generationInvalidated: false,
    baselineGeneration: 1,
    computedAt: 1,
};
const dreamerProgress = { task: "verify", processed: 2, total: 5, startedAt: 1 } as const;

function without(
    ...fields: Exclude<keyof SidebarSnapshot, "sessionId">[]
): RenderCase["snapshots"][0] {
    const reply: RenderCase["snapshots"][0] = { ...REFRESHED };
    for (const field of fields) delete reply[field];
    return reply;
}

type Removal = {
    name: string;
    render: RenderCase;
    present: RegExp;
    absent: RegExp;
    fresh?: RegExp;
};
const removals: Removal[] = [
    {
        name: "removes Hygiene without throwing when the third snapshot omits tailHygiene",
        // A second snapshot with Hygiene keeps the row active before the field goes away.
        render: {
            snapshots: [
                { ...BASE, tailHygiene },
                { ...BASE, usagePercentage: 15, tailHygiene },
                REFRESHED,
            ],
        },
        present: /Hygiene +50\.0% · 250\/500/,
        absent: /Hygiene/,
    },
    {
        name: "guards Dreamer progress removal when dreamerProgress is omitted",
        render: {
            snapshots: [
                { ...BASE, dreamerProgress },
                { ...BASE, usagePercentage: 15, dreamerProgress },
                REFRESHED,
            ],
        },
        present: /Dreamer verify: 2\/5 processed/,
        absent: /Dreamer/,
    },
    {
        name: "guards warning removal when lastTransformError is omitted",
        render: {
            snapshots: [
                { ...BASE, lastTransformError: "Transform failed" },
                without("lastTransformError"),
            ],
        },
        present: /Transform failed/,
        absent: /Transform failed/,
    },
    {
        name: "guards marker removal when executeThresholdClamped is omitted",
        render: { snapshots: [{ ...BASE, executeThresholdClamped: true }, REFRESHED] },
        present: /10\.0% \/ 65%\*/,
        absent: /65%\*/,
    },
    {
        name: "guards Stats removal when totalInputTokens is omitted",
        render: { snapshots: [{ ...BASE, totalInputTokens: 0 }, REFRESHED] },
        present: /Total tokens +0\b/,
        absent: /Total tokens/,
    },
    {
        name: "guards renderer mode when compaction_enabled is omitted",
        render: { snapshots: [{ ...BASE, compaction_enabled: false }, REFRESHED] },
        present: /native compaction/,
        absent: /native compaction/,
    },
    {
        name: "guards archived compartments removal when archivedCompartmentCount is omitted",
        render: {
            snapshots: [
                { ...BASE, compaction_enabled: false, archivedCompartmentCount: 3 },
                { ...REFRESHED, compaction_enabled: false },
            ],
        },
        present: /Archived compartments +3\b/,
        absent: /Archived compartments/,
    },
    {
        name: "guards the token breakdown when inputTokens is omitted",
        render: { snapshots: [BASE, without("inputTokens")] },
        present: /Conversation/,
        absent: /Conversation/,
    },
    {
        name: "guards the context summary when contextLimit is omitted",
        render: { snapshots: [BASE, without("contextLimit")] },
        present: /10\.0% \/ 65%/,
        absent: /65%/,
    },
    {
        name: "omits the usage percentage without throwing when usagePercentage is omitted",
        render: { snapshots: [BASE, without("usagePercentage")] },
        present: /10\.0% \/ 65%/,
        absent: /10\.0%|undefined|NaN/,
    },
    {
        name: "guards the threshold when executeThreshold is omitted",
        render: { snapshots: [BASE, without("executeThreshold")] },
        present: /65%/,
        absent: /65%|undefined|NaN/,
    },
    {
        name: "omits the Conversation row when conversationTokens is omitted",
        render: { snapshots: [BASE, without("conversationTokens")] },
        present: /Conversation +500 \(50%\)/,
        absent: /Conversation|NaN/,
    },
    {
        name: "leaves native-compaction counts empty when the counts are omitted",
        render: {
            snapshots: [
                { ...BASE, compaction_enabled: false, sessionNoteCount: 6 },
                { ...without("memoryCount", "sessionNoteCount"), compaction_enabled: false },
            ],
        },
        present: /Notes +6\b/,
        absent: /Notes +6\b|Memories +7\b|undefined|NaN/,
        fresh: /Context: 20\.0% · native compaction/,
    },
    {
        name: "guards Injected removal when memoryBlockCount is omitted",
        render: { snapshots: [{ ...BASE, memoryBlockCount: 3 }, without("memoryBlockCount")] },
        present: /Injected +3\b/,
        absent: /Injected/,
    },
    {
        name: "guards the collapsed Memories count when memoryBlockCount is omitted",
        render: {
            collapsed: true,
            snapshots: [{ ...BASE, memoryBlockCount: 3 }, without("memoryBlockCount")],
        },
        present: /Memories +3\/7\b/,
        absent: /3\/7|undefined|NaN/,
    },
    {
        name: "guards Queue removal when pendingOpsCount is omitted",
        render: {
            snapshots: [
                { ...BASE, pendingOpsCount: 3, sessionNoteCount: 1 },
                { ...without("pendingOpsCount"), sessionNoteCount: 1 },
            ],
        },
        present: /Queue +3 pending/,
        absent: /Queue/,
    },
    {
        name: "guards Notes removal when sessionNoteCount is omitted",
        render: {
            snapshots: [
                { ...BASE, sessionNoteCount: 4, pendingOpsCount: 1 },
                { ...without("sessionNoteCount"), pendingOpsCount: 1 },
            ],
        },
        present: /Notes +4\b/,
        absent: /Notes/,
    },
    {
        name: "guards Smart Notes removal when readySmartNoteCount is omitted",
        render: {
            snapshots: [
                { ...BASE, readySmartNoteCount: 4, pendingOpsCount: 1 },
                { ...without("readySmartNoteCount"), pendingOpsCount: 1 },
            ],
        },
        present: /Smart Notes +4 ready/,
        absent: /Smart Notes/,
    },
];

const updated: RenderCase = {
    snapshots: [
        { ...BASE, tailHygiene, dreamerProgress },
        {
            ...REFRESHED,
            tailHygiene: { ...tailHygiene, u: 125, severity: 0.25, evaluable: false },
            dreamerProgress: { ...dreamerProgress, processed: 4 },
        },
    ],
};
const forcedError: RenderCase = {
    snapshots: [
        { ...BASE, tailHygiene },
        { ...REFRESHED, tailHygiene },
    ],
    throwOnEvaluable: true,
};
const equalReply = { ...BASE, tailHygiene, dreamerProgress };
const unchanged = {
    snapshots: [equalReply, equalReply, equalReply],
    trackText: ["10.0% / 65%", "1K / 10K", "Dreamer verify: 2/5 processed", "Hygiene"],
} satisfies RenderCase;
let results: RenderResult[];

beforeAll(() => {
    const cases = [...removals.map(({ render }) => render), updated, forcedError, unchanged];
    const script = join(import.meta.dir, "../../../scripts/render-compiled-sidebar.ts");
    const child = Bun.spawnSync(["bun", "--conditions=browser", script], {
        stdin: new TextEncoder().encode(JSON.stringify(cases)),
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
    });
    if (child.exitCode !== 0)
        throw new Error(`sidebar render script failed: ${child.stderr.toString()}`);
    results = JSON.parse(child.stdout.toString());
}, 120_000);

describe("compiled sidebar refresh", () => {
    for (const [index, { name, render, present, absent, fresh }] of removals.entries()) {
        test(name, () => {
            const { frames, error } = results[index];
            expect(frames[0]).toMatch(present);
            if (render.snapshots.length === 3) {
                expect(frames[1]).toContain("15.0% / 65%");
                expect(frames[1]).toMatch(present);
            }
            expect(error).toBeUndefined();
            expect(frames).toHaveLength(render.snapshots.length);
            const after = frames[frames.length - 1];
            expect(after).not.toMatch(absent);
            expect(after).toMatch(fresh ?? /Memories +8\b/);
        });
    }

    test("guards the new Hygiene and Dreamer readings when both fields stay present", () => {
        const {
            frames: [before, after],
            error,
        } = results[removals.length];
        expect(error).toBeUndefined();
        expect(before).toMatch(/Hygiene +50\.0% · 250\/500/);
        expect(before).toContain("Dreamer verify: 2/5 processed");
        expect(after).toMatch(/Hygiene +25\.0% · 125\/500/);
        expect(after).toContain("Dreamer verify: 4/5 processed");
    });

    test("reports a forced slot error on refresh after a valid Hygiene frame", () => {
        const { frames, error } = results[removals.length + 1];
        expect(frames).toHaveLength(1);
        expect(frames[0]).toMatch(/Hygiene +50\.0% · 250\/500/);
        expect(error).toBe("forced error reading tailHygiene.evaluable during refresh");
    });

    test("retains the Context, Dreamer and Hygiene elements across equal refreshes", () => {
        const { frames, error, textIds } = results[removals.length + 2];
        expect(error).toBeUndefined();
        expect(frames).toHaveLength(3);
        expect(textIds).toHaveLength(3);
        expect(textIds?.map((frame) => frame.map((ids) => ids.length))).toEqual(
            frames.map(() => unchanged.trackText.map(() => 1)),
        );
        expect(textIds?.slice(1)).toEqual([textIds?.[0], textIds?.[0]]);
    });
});
