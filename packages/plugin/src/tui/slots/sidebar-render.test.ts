/**
 * Golden frames for the sidebar panel, drawn by the shipped compiled component
 * through `scripts/render-compiled-sidebar.ts`.
 *
 * The four `approved-*` frames are the Magic Context rows of the approved
 * sidebar mockup, copied cell for cell; the panel must draw them exactly from a
 * snapshot carrying the mockup's values. The `state-*` frames cover the states
 * the mockup does not show. Run with `UPDATE_SIDEBAR_FRAMES=1` to rewrite the
 * state frames after an intended change; approved frames are never rewritten.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SidebarSnapshot } from "../../shared/rpc-types";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";

const FRAMES = join(import.meta.dir, "__fixtures__", "sidebar-frames");
const SCRIPT = join(import.meta.dir, "../../../scripts/render-compiled-sidebar.ts");
const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const VERSION = "v0.49.35";
const GOLDEN = { text: "#f0f0f0", success: "#00cc55", warning: "#ffaa00", error: "#ff0055" };

/** The fields every server has sent, at an empty session's values. */
function legacySnapshot(overrides: Partial<SidebarSnapshot> = {}): SidebarSnapshot {
    return {
        sessionId: "ses_sidebar_golden",
        usagePercentage: 0,
        inputTokens: 0,
        contextLimit: 0,
        systemPromptTokens: 0,
        compartmentCount: 0,
        memoryCount: 0,
        memoryBlockCount: 0,
        pendingOpsCount: 0,
        historianRunning: false,
        compartmentInProgress: false,
        sessionNoteCount: 0,
        readySmartNoteCount: 0,
        cacheTtl: "5m",
        lastTransformError: null,
        lastDreamerRunAt: null,
        projectIdentity: "git:golden",
        compartmentTokens: 0,
        factTokens: 0,
        memoryTokens: 0,
        docsTokens: 0,
        profileTokens: 0,
        conversationTokens: 0,
        toolCallTokens: 0,
        toolDefinitionTokens: 0,
        executeThreshold: 65,
        ...overrides,
    };
}

/** The approved mockup's values: 483K of an 872K window, summary due at 61%. */
function mockupSnapshot(overrides: Partial<SidebarSnapshot> = {}): SidebarSnapshot {
    return legacySnapshot({
        usagePercentage: (483_000 / 872_000) * 100,
        inputTokens: 483_000,
        contextLimit: 872_000,
        compaction_enabled: true,
        executeThreshold: 63,
        nextSummaryPercentage: 61,
        historianFailureCount: 0,
        historianLastRun: {
            at: NOW - (HOUR + 55 * MINUTE),
            outcome: "ok",
            model: "Gemini 3.8 Flash",
        },
        cacheBuiltAt: NOW - 29 * HOUR,
        memoryCount: 225,
        newMemoryCount: 7,
        ...overrides,
    });
}

type PanelCase = {
    name: string;
    width: number;
    collapsed: boolean;
    snapshot: SidebarSnapshot | null;
};

const APPROVED: PanelCase[] = [36, 42].flatMap((width) =>
    [false, true].map((collapsed) => ({
        name: `approved-${width}-${collapsed ? "collapsed" : "expanded"}`,
        width,
        collapsed,
        snapshot: mockupSnapshot(),
    })),
);

const STATES: PanelCase[] = [
    {
        name: "state-no-reading-42",
        width: 42,
        collapsed: false,
        snapshot: mockupSnapshot({
            usagePercentage: 0,
            inputTokens: 0,
            historianLastRun: null,
            cacheBuiltAt: null,
            newMemoryCount: undefined,
            memoryCount: 12,
        }),
    },
    {
        name: "state-summarizer-running-42",
        width: 42,
        collapsed: false,
        snapshot: mockupSnapshot({ historianRunning: true, compartmentInProgress: true }),
    },
    {
        name: "state-compaction-off-42",
        width: 42,
        collapsed: false,
        snapshot: mockupSnapshot({
            compaction_enabled: false,
            nextSummaryPercentage: undefined,
            native_context_usage_percentage: 41,
            sessionNoteCount: 2,
            archivedCompartmentCount: 3,
        }),
    },
    {
        name: "state-recomp-42",
        width: 42,
        collapsed: false,
        snapshot: mockupSnapshot({
            historianRunning: true,
            recompProgress: {
                kind: "recomp",
                phase: "recomp",
                processedMessages: 270,
                totalMessages: 450,
                passCount: 3,
                compartmentsCreated: 14,
                note: "Starting pass 4…",
            },
        }),
    },
    {
        name: "state-recomp-done-42",
        width: 42,
        collapsed: false,
        snapshot: mockupSnapshot({
            recompProgress: {
                kind: "recomp",
                phase: "done",
                processedMessages: 450,
                totalMessages: 450,
                passCount: 4,
                compartmentsCreated: 18,
            },
        }),
    },
    {
        name: "state-embed-42",
        width: 42,
        collapsed: false,
        snapshot: mockupSnapshot({
            recompProgress: {
                kind: "embed",
                phase: "recomp",
                processedMessages: 270,
                totalMessages: 450,
                passCount: 1,
                compartmentsCreated: 0,
            },
        }),
    },
    {
        name: "state-over-execute-42",
        width: 42,
        collapsed: false,
        snapshot: mockupSnapshot({
            usagePercentage: (601_000 / 872_000) * 100,
            inputTokens: 601_000,
        }),
    },
    {
        name: "state-over-force-42",
        width: 42,
        collapsed: false,
        snapshot: mockupSnapshot({
            usagePercentage: (750_000 / 872_000) * 100,
            inputTokens: 750_000,
        }),
    },
    {
        name: "state-old-server-42",
        width: 42,
        collapsed: false,
        snapshot: legacySnapshot({
            usagePercentage: (483_000 / 872_000) * 100,
            inputTokens: 483_000,
            contextLimit: 872_000,
            memoryCount: 225,
        }),
    },
    { name: "state-before-first-snapshot-42", width: 42, collapsed: false, snapshot: null },
    {
        name: "state-before-first-snapshot-42-collapsed",
        width: 42,
        collapsed: true,
        snapshot: null,
    },
    {
        name: "state-compaction-off-42-collapsed",
        width: 42,
        collapsed: true,
        snapshot: mockupSnapshot({ compaction_enabled: false, nextSummaryPercentage: undefined }),
    },
];

type Rendered = {
    frame?: string;
    spans?: Array<Array<[string, string, string | null, 0 | 1]>>;
    error?: string;
};

function render(cases: unknown[], env: Record<string, string> = {}): Rendered[] {
    const child = Bun.spawnSync(["bun", "--conditions=browser", SCRIPT], {
        stdin: new TextEncoder().encode(JSON.stringify(cases)),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...env },
        windowsHide: true,
    });
    if (child.exitCode !== 0) throw new Error(`render script failed: ${child.stderr.toString()}`);
    return JSON.parse(child.stdout.toString());
}

function panelInput(entry: PanelCase) {
    return {
        kind: "panel",
        width: entry.width,
        collapsed: entry.collapsed,
        theme: "golden",
        snapshot: entry.snapshot,
        now: NOW,
        version: VERSION,
    };
}

function expectedFrame(name: string): string {
    return readFileSync(join(FRAMES, `${name}.txt`), "utf8").replace(/\n$/, "");
}

/** The foreground colour of the cells drawing `text` on the row that starts with `prefix`. */
function colourOf(result: Rendered, prefix: string, text: string): string | undefined {
    const rows = result.frame?.split("\n") ?? [];
    const index = rows.findIndex((row) => row.startsWith(prefix));
    return result.spans?.[index]?.find(([spanText]) => spanText.includes(text))?.[1];
}

let results = new Map<string, Rendered>();

beforeAll(() => {
    const cases = [...APPROVED, ...STATES];
    const rendered = render(cases.map(panelInput));
    results = new Map(cases.map((entry, index) => [entry.name, rendered[index] ?? {}]));
    if (process.env.UPDATE_SIDEBAR_FRAMES === "1") {
        for (const entry of STATES) {
            const frame = results.get(entry.name)?.frame;
            if (frame !== undefined) writeFileSync(join(FRAMES, `${entry.name}.txt`), `${frame}\n`);
        }
    }
}, 60_000);

describe("compiled sidebar panel", () => {
    for (const entry of [...APPROVED, ...STATES]) {
        test(`draws ${entry.name} cell for cell`, () => {
            const result = results.get(entry.name);
            expect(result?.error).toBeUndefined();
            const frame = result?.frame ?? "";
            expect(frame).toBe(expectedFrame(entry.name));
            for (const row of frame.split("\n")) expect(Bun.stringWidth(row)).toBe(entry.width);
        });
    }

    test("colours the context gauge by this session's thresholds, not the frame defaults", () => {
        // 55% used against a 63% execute threshold is healthy, although the
        // frame's default warning starts at 50%.
        expect(colourOf(results.get("approved-42-expanded")!, "ctx", "45% left")).toBe(
            GOLDEN.success,
        );
        expect(colourOf(results.get("state-over-execute-42")!, "ctx", "% left")).toBe(
            GOLDEN.warning,
        );
        expect(colourOf(results.get("state-over-force-42")!, "ctx", "% left")).toBe(GOLDEN.error);
    });

    test("ends the collapsed summary in a success dot", () => {
        const collapsed = results.get("approved-42-collapsed")!;
        expect(colourOf(collapsed, "ctx", "●")).toBe(GOLDEN.success);
    });
});

describe("sidebar mounts on both host entries", () => {
    let mounted: Rendered[] = [];

    beforeAll(() => {
        const root = createTestTempDirFromPath(join(tmpdir(), "mc-sidebar-mount-"));
        const env = {
            XDG_DATA_HOME: join(root, "data"),
            XDG_CONFIG_HOME: join(root, "config"),
            XDG_STATE_HOME: join(root, "state"),
            XDG_CACHE_HOME: join(root, "cache"),
            MAGIC_CONTEXT_STORAGE_DIR: join(root, "storage"),
            OPENCODE_TUI_PREFERENCES_FILE: join(root, "tui-preferences.jsonc"),
        };
        mounted = render(
            [
                { kind: "mount-v1", width: 42, directory: root },
                { kind: "mount-v2", width: 42, directory: root },
            ],
            env,
        );
    }, 60_000);

    for (const [index, host] of ["OpenCode 1", "OpenCode 2"].entries()) {
        test(`${host} draws the panel in its sidebar slot`, () => {
            const result = mounted[index];
            expect(result?.error).toBeUndefined();
            const rows = result?.frame?.split("\n") ?? [];
            expect(rows[0]).toMatch(/^ ▼ MAGIC CONTEXT +v\d+\.\d+\.\d+/);
            // No server answers here, so the gauge has no reading yet.
            expect(rows).toContain(`ctx no reading${" ".repeat(42 - "ctx no reading".length)}`);
        });
    }
});
