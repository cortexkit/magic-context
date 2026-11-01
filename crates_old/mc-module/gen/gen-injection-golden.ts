import "./quiet-live-log";
/**
 * Generate the differential synthetic-todowrite injection golden for the Rust
 * mc-module port.
 *
 * The generator imports the real TypeScript todo-view helpers from packages/plugin
 * with Bun.resolveSync, feeds them a grid of todo-state shapes, and writes the
 * exact normalized state, call id, and result-state content that Rust must match.
 *
 * Run: bun crates/mc-module/gen/gen-injection-golden.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const pluginDir = join(import.meta.dir, "..", "..", "..", "packages", "plugin");
const resolve = (m: string) => Bun.resolveSync(m, pluginDir);

const todoViewPath = resolve("./src/hooks/magic-context/todo-view.ts");
const todoViewSource = readFileSync(todoViewPath, "utf8");
const todoView = await import(resolve("./src/hooks/magic-context/todo-view"));

const { normalizeTodoStateJson, computeSyntheticCallId, buildSyntheticTodoPart } =
    todoView as {
        normalizeTodoStateJson: (todos: unknown) => string | null;
        computeSyntheticCallId: (stateJson: string) => string;
        buildSyntheticTodoPart: (stateJson: string) => Record<string, unknown> | null;
    };

interface GoldenCaseInput {
    label: string;
    input: unknown;
}

interface GoldenCase {
    label: string;
    input_json: string;
    normalized: string | null;
    call_id: string | null;
    result_state_json: string | null;
}

function extractStringConst(name: string): string {
    const re = new RegExp(`const\\s+${name}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")`);
    const match = todoViewSource.match(re);
    if (!match) throw new Error(`missing string const ${name}`);
    return JSON.parse(match[1]);
}

function extractStringSetConst(name: string): string[] {
    const re = new RegExp(`const\\s+${name}\\s*=\\s*new Set\\(\\s*(\\[[\\s\\S]*?\\])\\s*\\)`);
    const match = todoViewSource.match(re);
    if (!match) throw new Error(`missing set const ${name}`);
    const value = JSON.parse(match[1]);
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        throw new Error(`set const ${name} is not a string array`);
    }
    return value;
}

function resultStateJson(part: Record<string, unknown> | null): string | null {
    if (part === null) return null;
    return JSON.stringify((part as { state: unknown }).state);
}

const statusValues = ["pending", "in_progress", "completed", "cancelled"];
const longUnicodeContent = `Unicode café 🚀\n${"long ".repeat(40)}終わり`;

const inputs: GoldenCaseInput[] = [
    {
        label: "minimal valid list",
        input: [{ content: "Plan work", status: "pending", priority: "high" }],
    },
    {
        label: "extra fields and id stripped",
        input: [
            {
                id: "todo-1",
                content: "Strip extras",
                status: "pending",
                priority: "low",
                ignored: { nested: true },
            },
        ],
    },
    {
        label: "id-less item defaults priority",
        input: [{ content: "Default priority", status: "in_progress" }],
    },
    {
        label: "all status values with cancelled counted in title",
        input: statusValues.map((status) => ({
            content: `Status ${status}`,
            status,
            priority: status === "completed" ? "low" : "medium",
        })),
    },
    {
        label: "empty list normalizes but builds no part",
        input: [],
    },
    {
        label: "all terminal todos normalize but build no part",
        input: [
            { content: "Done", status: "completed", priority: "high" },
            { content: "Cancelled", status: "cancelled", priority: "low" },
        ],
    },
    {
        label: "invalid non-array",
        input: { todos: [] },
    },
    {
        label: "invalid non-object item rejects whole state",
        input: [{ content: "Valid", status: "pending", priority: "high" }, "bad item"],
    },
    {
        label: "invalid missing content rejects whole state",
        input: [{ status: "pending", priority: "medium" }],
    },
    {
        label: "invalid missing status rejects whole state",
        input: [{ content: "Missing status", priority: "medium" }],
    },
    {
        label: "invalid non-string priority rejects whole state",
        input: [{ content: "Bad priority", status: "pending", priority: 7 }],
    },
    {
        label: "unicode and long content",
        input: [{ content: longUnicodeContent, status: "pending", priority: "medium" }],
    },
    {
        label: "key order scrambled canonicalization A",
        input: [{ content: "Scrambled", status: "pending", priority: "low", id: "drop-me" }],
    },
    {
        label: "key order scrambled canonicalization B",
        input: [{ id: "drop-me", priority: "low", status: "pending", content: "Scrambled" }],
    },
];

const constantProbeState = normalizeTodoStateJson([{ content: "Probe", status: "pending" }]);
if (constantProbeState === null) throw new Error("constant probe failed to normalize");
const constantProbePart = buildSyntheticTodoPart(constantProbeState) as {
    tool: string;
    state: { status: string; time: { start: number; end: number } };
} | null;
if (constantProbePart === null) throw new Error("constant probe failed to build a part");

const constants = {
    synthetic_call_id_prefix: extractStringConst("SYNTHETIC_CALL_ID_PREFIX"),
    terminal_statuses: extractStringSetConst("TERMINAL_STATUSES"),
    title_done_statuses: extractStringSetConst("TITLE_DONE_STATUSES"),
    default_priority: JSON.parse(constantProbeState)[0].priority,
    tool_name: constantProbePart.tool,
    completed_status: constantProbePart.state.status,
    synthetic_timestamp: constantProbePart.state.time.start,
};
if (constantProbePart.state.time.start !== constantProbePart.state.time.end) {
    throw new Error("synthetic timestamp start/end diverged");
}

const cases: GoldenCase[] = inputs.map((spec) => {
    const normalized = normalizeTodoStateJson(spec.input);
    const callId = normalized === null ? null : computeSyntheticCallId(normalized);
    const part = normalized === null ? null : buildSyntheticTodoPart(normalized);
    return {
        label: spec.label,
        input_json: JSON.stringify(spec.input),
        normalized,
        call_id: callId,
        result_state_json: resultStateJson(part),
    };
});

const golden = { constants, cases };
const outPath = join(import.meta.dir, "..", "testdata", "injection-golden.json");
writeFileSync(outPath, `${JSON.stringify(golden, null, 2)}\n`);
// eslint-disable-next-line no-console
console.log(`wrote ${cases.length} injection cases → ${outPath}`);
