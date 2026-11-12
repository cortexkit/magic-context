import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { SidebarSnapshot } from "../shared/rpc-types";
import { createTestTempDir } from "../shared/test-temp-dir";

const now = 1_800_000_000_000;
const older: SidebarSnapshot = {
    sessionId: "fixture",
    usagePercentage: 55,
    inputTokens: 483_000,
    contextLimit: 872_000,
    executeThreshold: 65,
    systemPromptTokens: 0,
    docsTokens: 0,
    compartmentCount: 491,
    memoryCount: 225,
    memoryBlockCount: 10,
    pendingOpsCount: 151,
    historianRunning: false,
    compartmentInProgress: false,
    sessionNoteCount: 4,
    readySmartNoteCount: 1,
    cacheTtl: "5m",
    lastTransformError: null,
    lastDreamerRunAt: now - 9_000_000,
    projectIdentity: null,
    compartmentTokens: 0,
    factTokens: 0,
    memoryTokens: 0,
    profileTokens: 0,
    conversationTokens: 0,
    toolCallTokens: 0,
    toolDefinitionTokens: 0,
};
const healthy: SidebarSnapshot = {
    ...older,
    proactiveFloor: 61,
    waitingMessages: 140,
    cachedM0MaterializedAt: now - 104_400_000,
    summariesSinceCache: 6,
    memoriesSinceCache: 7,
    queuedDropTokens: 49_000,
    queuedDropCount: 151,
    historianRun: {
        finishedAt: now - 6_900_000,
        outcome: "ok",
        model: "google/gemini-3.8-flash",
        primaryModel: "google/gemini-3.8-flash",
        fallback: false,
        primaryRejections: 0,
        primaryAttempts: 1,
        sinceLastClean: { primaryRejections: 0, primaryAttempts: 0, fallbackRuns: 0 },
    },
};
const incident: SidebarSnapshot = {
    ...healthy,
    historianRunning: true,
    waitingMessages: 28,
    historianRun: {
        ...healthy.historianRun!,
        finishedAt: now - 60_000,
        outcome: "fallback",
        model: "deepseek/deepseek-v4.1-flash",
        fallback: true,
        primaryRejections: 2,
        primaryAttempts: 2,
        sinceLastClean: { primaryRejections: 4, primaryAttempts: 4, fallbackRuns: 2 },
    },
};
const off = {
    ...incident,
    usagePercentage: 30,
    compaction_enabled: false,
    archivedCompartmentCount: 491,
};
const hidden = {
    "magic-context": {
        header: { label: "CUSTOM" },
        collapsed: true,
        sections: { historian: false, memory: false, status: false, dreamer: false },
    },
};
const cases = [
    { snapshot: healthy },
    { snapshot: incident },
    { snapshot: older },
    { snapshot: off },
    { snapshot: healthy, preferences: hidden },
    { snapshot: null },
    { snapshot: { ...healthy, usagePercentage: undefined, contextLimit: 0 } },
    { snapshot: { ...healthy, usagePercentage: 61, inputTokens: 531_920 } },
    {
        snapshot: {
            ...healthy,
            recompProgress: {
                kind: "upgrade",
                phase: "recomp",
                processedMessages: 25,
                totalMessages: 100,
                passCount: 1,
                compartmentsCreated: 2,
            },
        },
    },
    {
        snapshot: {
            ...healthy,
            historianFailureCount: 1,
            lastTransformError: "Fixture transform failure",
            configReloadFailure: { path: "fixture", message: "bad config" },
            hostLimitations: ["dream_task_needs_tool_loop"],
            dreamerFailures: [
                { task: "fixture", error: "Fixture failure", lastSucceededAt: null, retryCount: 1 },
                {
                    task: "fixture-two",
                    error: "Fixture failure",
                    lastSucceededAt: null,
                    retryCount: 1,
                },
            ],
        },
    },
    { snapshot: { ...healthy, usagePercentage: 65 } },
    { snapshot: { ...healthy, usagePercentage: 85 } },
    { snapshot: { ...healthy, compartmentInProgress: true }, width: 40 },
    {
        snapshot: healthy,
        toggleHeader: true,
        preferences: { "magic-context": { rememberCollapsed: false } },
    },
    { snapshot: { ...healthy, historianRun: { ...healthy.historianRun!, outcome: "failed" } } },
    { snapshot: healthy, matchingBadgeColors: true },
    { snapshot: healthy, preferences: { "magic-context": { startCollapsed: true } } },
    { snapshot: incident, preferences: { "magic-context": { startCollapsed: true } } },
    { snapshot: null, preferences: { "magic-context": { startCollapsed: true } } },
    { snapshot: off, preferences: { "magic-context": { startCollapsed: true } } },
    { snapshot: { ...off, native_context_usage_percentage: 41 } },
    { snapshot: { ...healthy, pendingOpsCount: 999, queuedDropCount: 3 } },
    {
        snapshot: { ...healthy, pendingOpsCount: 999, queuedDropCount: 3 },
        preferences: { "magic-context": { startCollapsed: true } },
    },
    {
        snapshot: {
            ...incident,
            historianRun: {
                ...incident.historianRun!,
                outcome: "ok",
                model: "google/gemini-3.8-flash",
                fallback: false,
            },
        },
    },
    ...(["failed", "skipped"] as const).map((phase) => ({
        snapshot: {
            ...healthy,
            recompProgress: {
                kind: "upgrade" as const,
                phase,
                processedMessages: 0,
                totalMessages: 100,
                passCount: 0,
                compartmentsCreated: 0,
                message: "Rebuild fixture reason",
            },
        },
    })),
    {
        snapshot: healthy,
        toggleHeader: true,
        preferences: { "magic-context": { rememberCollapsed: true } },
    },
    { snapshot: { ...healthy, queuedDropCount: 2, queuedDropTokens: undefined } },
];
type Result = {
    frame: string;
    error?: string;
    collapsed?: boolean;
    lines: Array<Array<{ text: string; fg: string; attributes: number }>>;
};
let results: Result[];
let rawResult: Result;
let wrotePreferences = false;
beforeAll(() => {
    const { dir } = createTestTempDir("sidebar-render-preferences-");
    const preferenceFile = join(dir, "preferences.json");
    const child = Bun.spawnSync(
        [
            process.execPath,
            "--conditions=browser",
            join(import.meta.dir, "../../scripts/render-compiled-sidebar.ts"),
        ],
        {
            stdin: new TextEncoder().encode(
                JSON.stringify(cases.map((entry) => ({ ...entry, now }))),
            ),
            stdout: "pipe",
            stderr: "pipe",
            env: { ...process.env, BUN_BE_BUN: "1", OPENCODE_TUI_PREFERENCES_FILE: preferenceFile },
            windowsHide: true,
        },
    );
    if (child.exitCode !== 0) throw new Error(child.stderr.toString());
    wrotePreferences = existsSync(preferenceFile);
    rmSync(dir, { recursive: true, force: true });
    results = JSON.parse(child.stdout.toString());
    for (const result of results) expect(result.error).toBeUndefined();
    const raw = Bun.spawnSync(
        [
            process.execPath,
            "--conditions=browser",
            join(import.meta.dir, "../../scripts/render-compiled-sidebar.ts"),
            "--raw-frame",
        ],
        {
            stdin: new TextEncoder().encode(JSON.stringify([{ snapshot: healthy, now }])),
            stdout: "pipe",
            stderr: "pipe",
            env: { ...process.env, BUN_BE_BUN: "1" },
            windowsHide: true,
        },
    );
    if (raw.exitCode !== 0) throw new Error(raw.stderr.toString());
    rawResult = JSON.parse(raw.stdout.toString())[0];
    expect(rawResult.error).toBeUndefined();
}, 60_000);

function row(index: number, label: string, value: string) {
    expect(
        results[index]!.frame.split("\n").some(
            (line) =>
                line.trim() ===
                `${label}${" ".repeat(Math.max(1, 42 - label.length - value.length))}${value}`,
        ),
    ).toBe(true);
}
function tone(index: number, text: string, color: string) {
    const spans = results[index]!.lines.flat().filter((span) => span.text.includes(text));
    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) expect(span.fg).toBe(color);
}

describe("option B sidebar", () => {
    test("render fixtures never persist remembered header toggles", () => {
        expect(wrotePreferences).toBe(false);
    });
    test("uses native-window pressure when supplied and retains the legacy fallback", () => {
        expect(results[20]!.frame).toContain("59% left");
        expect(results[3]!.frame).toContain("45% left");
    });
    test("labels only drop operations as queued drops", () => {
        row(21, "Queued drops", "3 · ≈49K at rebuild");
        row(22, "Cache", "3 drops queued ●");
    });
    test("shows the queued-drop count without a token estimate when none is reported", () => {
        row(cases.length - 1, "Queued drops", "2 · no reading");
    });
    test("does not credit a later primary model for cumulative fallback runs", () => {
        row(23, "Fallback", "finished 2 runs");
    });
    test("keeps failed and stopped rebuilds and their explanations visible", () => {
        row(24, "Upgrade", "✗ Upgrade failed");
        row(25, "Upgrade", "stopped");
        for (const index of [24, 25])
            expect(results[index]!.frame).toContain("Rebuild fixture reason");
    });
    test("preserves the expanded and incident render output", () => {
        expect(
            results.slice(0, 2).map((result) => ({ ...result, frame: result.frame.split("\n") })),
        ).toMatchSnapshot();
    });
    test("collapses an account-less panel to the Option B summary rows", () => {
        row(16, "Context", "45% left ●");
        row(16, "Historian", "idle · 1h55m ●");
        row(16, "Cache", "151 drops queued ●");
        expect(results[16]!.frame).toContain("▶ MAGIC CONTEXT");
        expect(results[16]!.frame).not.toMatch(
            /Health|Prompt cache|Knowledge|Dreamer|Next summary|█/,
        );
        expect(results[13]!.frame).toBe(results[16]!.frame);
        row(17, "Historian", "fallback · 1m ●");
        row(17, "Health", "2 issues ●");
        tone(17, "2 issues ●", "#ff8800");
        expect(results[17]!.frame).not.toMatch(/4\/4 rejected|shows details|Last run/);
        row(18, "Context", "no reading ●");
        row(18, "Historian", "no reading ●");
        row(18, "Cache", "no reading ●");
        row(19, "Context", "45% left ●");
        expect(results[19]!.frame).not.toMatch(/Historian|Cache|Health/);
    });
    test("draws the healthy expanded sections with actionable snapshot values", () => {
        for (const title of [
            "MAGIC CONTEXT",
            "Context",
            "History",
            "Prompt cache",
            "Knowledge",
            "Dreamer",
        ])
            expect(results[0]!.frame).toContain(title);
        row(0, "Next summary", "at 61% · +49K");
        row(0, "Historian", "idle");
        row(0, "Last run", "1h55m ago · ok");
        row(0, "Model", "Gemini 3.8 Flash");
        row(0, "Waiting", "140 msgs");
        row(0, "Cache built", "29h ago");
        row(0, "Since then", "6 summaries · 7 memories");
        row(0, "Queued drops", "151 · ≈49K at rebuild");
        row(0, "Memories", "225 · 7 new");
        row(0, "Notes", "4 · 1 smart waiting");
        row(0, "Last run", "2h30m ago · ok");
        expect(results[0]!.frame).toContain("ctx ██████░░░░ 45% left");
        expect(results[0]!.frame).toContain("483K/872K");
        expect(results[0]!.frame).not.toMatch(/Health|Hygiene|Total tokens|Conversation|⚠/);
        tone(0, "idle", "#ffffff");
        tone(0, "Historian", "#888888");
    });
    test("shows primary rejections and cumulative fallback runs in one Health section", () => {
        row(1, "Historian", "summarizing");
        row(1, "Last run", "1m ago · fallback");
        row(1, "Model", "DeepSeek V4.1 Flash");
        row(1, "Historian", "Gemini 4/4 rejected");
        row(1, "Fallback", "finished 2 runs");
        expect(results[1]!.frame).toContain("Health");
        expect(results[1]!.frame.match(/\/ctx-status shows details/g)).toHaveLength(1);
        tone(1, "4/4 rejected", "#ff8800");
        tone(1, "finished 2 runs", "#ff8800");
        tone(1, "/ctx-status shows details", "#888888");
    });
    test("uses dashes rather than fabricated values for older snapshots and the first read", () => {
        for (const index of [2, 5]) {
            for (const label of ["Next summary", "Last run", "Model", "Cache built", "Since then"])
                row(index, label, "—");
            row(index, "Waiting", "no reading");
            expect(results[index]!.frame).not.toContain("Health");
        }
    });
    test("keeps native context, memories, notes and archives when MC compaction is off", () => {
        expect(results[3]!.frame).toContain("native compaction");
        expect(results[3]!.frame).toContain("45% left");
        row(3, "Memories", "225");
        row(3, "Notes", "4");
        row(3, "Archived compartments", "491");
        expect(results[3]!.frame).not.toMatch(
            /History|Prompt cache|Next summary|4\/4 rejected|Fallback/,
        );
    });
    test("maps visibility preferences and restores the stored collapse value", () => {
        expect(results[4]!.frame).toContain("CUSTOM");
        expect(results[4]!.frame).toContain("Context");
        expect(results[4]!.frame).not.toMatch(/History|Prompt cache|Knowledge|Dreamer/);
        expect(results[4]!.collapsed).toBe(true);
    });
    test("unknown usage says no reading and does not show 100% left", () => {
        expect(results[6]!.frame).toContain("no reading");
        expect(results[5]!.frame).toContain("no reading");
        expect(results[6]!.frame).not.toContain("100% left");
    });
    test("shows due at the proactive floor and one active rebuild row", () => {
        row(7, "Next summary", "due");
        row(8, "Upgrade", "25%");
        expect(results[8]!.frame.match(/Upgrade/g)).toHaveLength(1);
    });
    test("renders errors and other warnings with only one muted hint", () => {
        row(9, "Historian", "last run failed");
        row(9, "Dreamer", "2 tasks failed");
        row(9, "Config", "reload failed");
        row(9, "Last run", "2h30m ago · failed");
        row(14, "Historian", "last run failed");
        tone(9, "last run failed", "#ff0000");
        tone(9, "Fixture transform failure", "#ff0000");
        tone(9, "2 tasks failed", "#ff8800");
        tone(9, "reload failed", "#ff8800");
        expect(results[9]!.frame).toContain("Host");
        expect(results[9]!.frame.match(/\/ctx-status shows details/g)).toHaveLength(1);
        expect(results[9]!.frame).not.toContain("⚠");
    });
    test("uses the execute threshold and force band for the gauge tone", () => {
        tone(0, "45% left", "#00ff00");
        tone(10, "35% left", "#ff8800");
        tone(11, "15% left", "#ff0000");
        expect(results[12]!.frame).toContain("summarizing");
    });
    test("the raw-source frame bundle draws the same expanded view", () => {
        expect(rawResult.frame).toBe(results[0]!.frame);
        expect(rawResult.lines).toEqual(results[0]!.lines);
    });
    test("keeps the badge readable when the host background matches its accent", () => {
        tone(15, "MAGIC CONTEXT", "#000000");
    });
});
