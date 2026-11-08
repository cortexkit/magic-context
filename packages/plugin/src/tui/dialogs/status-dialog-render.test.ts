/**
 * Renders the shipped, compiled `/ctx-status` dialog for every status payload
 * the dialog can receive, and checks that each one draws and none throws.
 *
 * Previously the dialog read the RPC reply unchecked: a reply without
 * `usagePercentage` (the server's `{ disabled: true }` answer for a home
 * directory or a paused project identity) threw inside the view memo, and
 * OpenCode's crash screen then reported the follow-on
 * "undefined is not an object (evaluating 'view().headline')".
 *
 * It also checks that the dialog stays inside the surface the host gives it.
 * The dialog sized its section grid from the terminal width instead of its own
 * laid-out width (it listened for an event plain boxes never emit), so inside
 * OpenCode's 60-column dialog the two fixed-width section columns ran past the
 * dialog's right edge (issue 605).
 *
 * The rendering happens in `scripts/render-compiled-status-dialog.ts`, a child
 * process, because it has to register OpenCode's runtime module registry and
 * that registration cannot be undone inside this test process. The child runs
 * with the `browser` condition so `solid-js` is the reactive build OpenCode
 * runs; the server build Bun picks by default never re-renders after layout.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { checkStatusDetailPayload, statusRpcFailure } from "../../shared/status-view-check";
import type { StatusDetailResult } from "../data/context-db";

const UI = "0.44.5";

const COMPLETE = {
    sessionId: "ses_complete",
    pluginVersion: UI,
    usagePercentage: 12.5,
    inputTokens: 25_000,
    contextLimit: 200_000,
    executeThreshold: 65,
    systemPromptTokens: 5_000,
    docsTokens: 0,
    compartmentTokens: 0,
    compartmentCount: 0,
    factTokens: 0,
    memoryTokens: 0,
    memoryBlockCount: 0,
    profileTokens: 0,
    conversationTokens: 20_000,
    toolCallTokens: 0,
    toolDefinitionTokens: 0,
    activeTags: 0,
    droppedTags: 0,
    totalTags: 0,
    activeBytes: 0,
    lastNudgeTokens: 0,
    pendingOpsCount: 0,
    protectedTagCount: 0,
    isSubagent: false,
    cacheTtl: "5m",
    lastResponseTime: 0,
    cacheRemainingMs: 0,
    cacheExpired: false,
    historyBlockTokens: 0,
    compressionBudget: null,
    compressionUsage: null,
    memoryCount: 0,
};
const { pluginVersion: _omitted, ...OLDER_SERVER } = COMPLETE;

const CASES: Array<{ name: string; status: StatusDetailResult; expected: string[] }> = [
    {
        name: "a complete snapshot",
        status: checkStatusDetailPayload(COMPLETE, UI),
        expected: ["Magic Context Status", "12.5% / 65%"],
    },
    {
        name: "an RPC transport failure",
        status: statusRpcFailure("connect ECONNREFUSED"),
        expected: ["Status unavailable", "server did not answer"],
    },
    {
        name: "an error envelope",
        status: checkStatusDetailPayload({ error: "unavailable" }, UI),
        expected: ["Status unavailable", "server did not answer"],
    },
    {
        name: "the home-directory reply",
        status: checkStatusDetailPayload({ sessionId: "s", disabled: true }, UI),
        expected: ["Status unavailable", "home directory"],
    },
    {
        name: "the paused-identity reply",
        status: checkStatusDetailPayload({ sessionId: "s", disabled: true, paused: true }, UI),
        expected: ["Status unavailable", "memory paused"],
    },
    {
        name: "an empty reply",
        status: checkStatusDetailPayload({}, UI),
        expected: ["Status unavailable", "incomplete status data"],
    },
    {
        name: "an older server's snapshot",
        status: checkStatusDetailPayload(OLDER_SERVER, UI),
        expected: ["12.5% / 65%", "An older Magic Context server"],
    },
];

/**
 * Layout cases: the dialog inside a host surface of `dialogWidth` columns on a
 * terminal of `terminalWidth` columns. OpenCode's dialog is 60 columns unless a
 * dialog asks to be wider, and never wider than the terminal minus 2; 88 is its
 * "large" size. The child process's stdout is a pipe, so the dialog sees no
 * terminal width at all, the same fallback it takes on a very wide terminal.
 */
type LayoutCase = {
    name: string;
    status: StatusDetailResult;
    terminalWidth: number;
    dialogWidth: number;
    expected: string[];
    /**
     * Label/value pairs that must each be drawn whole on one line, the label
     * followed by its complete value. A value cut off at a column edge fails.
     */
    rows?: Array<[label: string, value: string]>;
};

/** Rows of the complete snapshot drawn from both section columns. */
const COMPLETE_ROWS: Array<[string, string]> = [
    ["Active", "0 (~0 B)"],
    ["Execute threshold", "65%"],
    ["Last reduce anchor", "0 tok"],
    ["Subagent", "no"],
    ["History block", "~0 tok"],
    ["Auto-execute", "at ≥65%"],
];

const LONG_MODEL_KEY =
    "openrouter/anthropic/claude-sonnet-4.5-20250929-thinking-extended-context-preview";
const LONG_VALUE_STATUS = checkStatusDetailPayload(
    { ...COMPLETE, cacheTtlSource: "config", cacheTtlModelKey: LONG_MODEL_KEY },
    UI,
);

const LAYOUT_CASES: LayoutCase[] = [
    ...[80, 100, 120].map((terminalWidth) => ({
        name: `a complete snapshot in the default 60-column dialog, terminal ${terminalWidth} columns wide`,
        status: checkStatusDetailPayload(COMPLETE, UI),
        terminalWidth,
        dialogWidth: 60,
        expected: ["Magic Context Status", "Execute threshold", "History block", "Esc to close"],
        rows: COMPLETE_ROWS,
    })),
    ...[100, 120].map((terminalWidth) => ({
        name: `a complete snapshot in an 88-column dialog, terminal ${terminalWidth} columns wide`,
        status: checkStatusDetailPayload(COMPLETE, UI),
        terminalWidth,
        dialogWidth: 88,
        expected: ["Magic Context Status", "Execute threshold", "History block", "Esc to close"],
        rows: COMPLETE_ROWS,
    })),
    {
        // The value is longer than the dialog: it has to wrap inside the value
        // column, and its end still has to be drawn.
        name: "a long cache TTL model key in the default 60-column dialog, terminal 80 columns wide",
        status: LONG_VALUE_STATUS,
        terminalWidth: 80,
        dialogWidth: 60,
        expected: ["Configured", "your config)", "Execute threshold", "Esc to close"],
        rows: COMPLETE_ROWS,
    },
];

/**
 * The same dialog when its width update never lands: the first frame, drawn
 * before the dialog has measured itself, or a render (like a bare component
 * render on Bun's non-reactive `solid-js` build) where nothing re-runs after
 * layout. The section grid is then chosen against the terminal-width fallback,
 * and the columns still have to stay inside the dialog.
 */
const STALE_WIDTH_CASES: LayoutCase[] = [
    {
        name: "a complete snapshot laid out before the dialog measured itself",
        status: checkStatusDetailPayload(COMPLETE, UI),
        terminalWidth: 80,
        dialogWidth: 60,
        expected: ["Magic Context Status", "Tags", "Esc to close"],
    },
    {
        name: "a long cache TTL model key laid out before the dialog measured itself",
        status: LONG_VALUE_STATUS,
        terminalWidth: 80,
        dialogWidth: 60,
        expected: ["Magic Context Status", "Configured", "Esc to close"],
    },
];

/**
 * Lines of `frame` that draw anything at or past `rightEdge`, the first column
 * of the dialog's right padding. The dialog surface starts at column 0, so a
 * line that stays inside the dialog is blank from that column on.
 */
function linesPastEdge(frame: string, rightEdge: number): string[] {
    return frame.split("\n").filter((line) => line.slice(rightEdge).trim() !== "");
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Pairs from `rows` that no line of `frame` draws as `label  value` whole. */
function rowsNotDrawnWhole(frame: string, rows: Array<[string, string]>): string[] {
    const lines = frame.split("\n");
    return rows
        .filter(([label, value]) => {
            const pattern = new RegExp(`${escapeRegExp(label)} +${escapeRegExp(value)}(\\s|$)`);
            return !lines.some((line) => pattern.test(line));
        })
        .map(([label, value]) => `${label}: ${value}`);
}

type RenderResult = { frame?: string; error?: string };

/** Runs the render script on `input`, with extra Bun flags before the script. */
function renderInChild(input: unknown[], bunFlags: string[]): RenderResult[] {
    const script = join(import.meta.dir, "../../../scripts/render-compiled-status-dialog.ts");
    const child = Bun.spawnSync(["bun", ...bunFlags, script], {
        stdin: new TextEncoder().encode(JSON.stringify(input)),
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
    });
    if (child.exitCode !== 0) {
        throw new Error(`render script failed: ${child.stderr.toString()}`);
    }
    return JSON.parse(child.stdout.toString());
}

const layoutInput = (cases: LayoutCase[]) =>
    cases.map(({ status, terminalWidth, dialogWidth }) => ({ status, terminalWidth, dialogWidth }));

let results: RenderResult[] = [];
let staleResults: RenderResult[] = [];

beforeAll(() => {
    results = renderInChild(
        [...CASES.map((entry) => ({ status: entry.status })), ...layoutInput(LAYOUT_CASES)],
        ["--conditions=browser"],
    );
    // No `browser` condition: Bun's server build of solid-js, where the dialog
    // keeps the layout it chose before it knew its own width.
    staleResults = renderInChild(layoutInput(STALE_WIDTH_CASES), []);
}, 60_000);

describe("compiled /ctx-status dialog", () => {
    for (const [index, entry] of CASES.entries()) {
        test(`draws ${entry.name} without throwing`, () => {
            const result = results[index];
            expect(result?.error).toBeUndefined();
            for (const text of entry.expected) expect(result?.frame).toContain(text);
        });
    }
});

function expectInsideDialog(entry: LayoutCase, result: RenderResult | undefined): void {
    expect(result?.error).toBeUndefined();
    const frame = result?.frame ?? "";
    for (const text of entry.expected) expect(frame).toContain(text);
    // The dialog's own right padding is 2 columns, so its content ends 2
    // columns before the surface's edge.
    const surfaceWidth = Math.min(entry.dialogWidth, entry.terminalWidth - 2);
    expect(linesPastEdge(frame, surfaceWidth - 2)).toEqual([]);
    if (entry.rows) expect(rowsNotDrawnWhole(frame, entry.rows)).toEqual([]);
}

describe("compiled /ctx-status dialog layout", () => {
    for (const [index, entry] of LAYOUT_CASES.entries()) {
        test(`keeps ${entry.name} inside the dialog`, () => {
            expectInsideDialog(entry, results[CASES.length + index]);
        });
    }
    for (const [index, entry] of STALE_WIDTH_CASES.entries()) {
        test(`keeps ${entry.name} inside the dialog`, () => {
            expectInsideDialog(entry, staleResults[index]);
        });
    }
});
