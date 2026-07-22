/**
 * Generate the differential SELECTION golden for the Rust mc-module port.
 *
 * Drives the REAL OpenCode TS selectors (supersession, edit-supersession,
 * emergency) over tag fixtures, extracts the DECISION set (which tool → drop vs
 * edit_marker), and emits (a) the equivalent flat typed-CK tail (SelItem[]) and (b)
 * the expected ARC-LEVEL decisions. The Rust `selection_golden` test runs
 * `select_reductions` over the same tail, projects its per-block output back to
 * arc-level, and asserts equality — proving the SELECTOR logic (keep-N, tier
 * ordering, reserve, headroom, file-supersession, ctx_note actions) is
 * bit-faithful to TS.
 *
 * SCOPE: the golden is DECISION-LEVEL (which arcs, what intent) — that is the
 * TS-faithfulness-critical logic. The CK-model ADDITIONS (arc expansion into
 * call/result/reasoning blocks, skeleton-window shaping, payload purity, the
 * cross-selector merge, and the frozen_keys/provider_executed filters) have no TS
 * equivalent and are proven by separate Rust unit tests in selection.rs.
 *
 * TS→CK mapping: one TS tool tag → one CK arc. tag.byteSize → ToolResult bytes,
 * tag.inputByteSize → ToolCall bytes, tag.reasoningByteSize → a Reasoning block.
 * tag.tagNumber → the block ordinal (age key). FlatBlock ids use the ingress
 * `mid#block_index` vocabulary for every block: ToolCall = `<mid>#0`, ToolResult =
 * `<mid>#1`, Reasoning = `<mid>#2`. arc_id is the paired ToolCall FlatBlock id, so
 * the arc's reclaim bytes (call+result+reasoning) == the TS tagReclaimBytes exactly.
 *
 * Run:  bun crates/mc-module/gen/gen-selection-golden.ts
 * (resolves the TS selectors from packages/plugin, like the tokenizer generators).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pluginDir = join(import.meta.dir, "..", "..", "..", "packages", "plugin");
const resolve = (m: string) => Bun.resolveSync(m, pluginDir);

const storage = await import(resolve("./src/features/magic-context/storage"));
const supersession = await import(resolve("./src/hooks/magic-context/supersession-reclaim"));
const emergency = await import(resolve("./src/hooks/magic-context/emergency-drop"));

const { openDatabase, closeDatabase, insertTag } = storage as {
    openDatabase: () => unknown;
    closeDatabase: () => void;
    insertTag: (...a: unknown[]) => number;
};

// --- fixture types ---

interface TagFixture {
    /** Fixture `mid`; the generated ToolCall id and arc_id are `${id}#0`. */
    id: string;
    toolName: string;
    /** age key (tag number → block ordinal). */
    n: number;
    /** ToolResult (output) bytes. */
    byteSize: number;
    /** ToolCall (input) bytes. */
    inputByteSize?: number;
    /** Reasoning bytes (0 = no reasoning block). */
    reasoningByteSize?: number;
    /** ToolCall.input JSON (filePath / action / diff keys / edit content). */
    input?: Record<string, unknown>;
    /** Mark this arc's blocks server-side (provider_executed=true → never targeted). */
    providerExecuted?: boolean;
}

type SelectorKind = "supersession" | "edit" | "emergency";

interface CaseSpec {
    label: string;
    selector: SelectorKind;
    tags: TagFixture[];
    /** pass class for the Rust ctx. */
    passClass: "Execute" | "EmergencyForce";
    smartDrops: boolean;
    /** emergency inputs. */
    emergency?: {
        currentTotalInputTokens: number;
        ceilingTokens: number;
        protectedTags: number;
        priorInputSample?: number;
        hasPriorDrop?: boolean;
    };
    /** ids already frozen (excluded). Flat block ids (e.g. "c2#1"). */
    frozen?: string[];
}

// --- the CK tail + expected decisions the Rust test consumes ---

interface SelItemJson {
    id: string;
    ordinal: number;
    kind: Record<string, unknown>;
    provider_executed: boolean;
    byte_size: number;
    arc_id: string | null;
}

interface GoldenCase {
    label: string;
    items: SelItemJson[];
    ctx: Record<string, unknown>;
    smart_drops: boolean;
    frozen: string[];
    /** arc_id → "drop" | "edit_marker" (the TS selector's decision). */
    expected: Record<string, string>;
}

/** A droppable target; readInput surfaces the arc's input (ctx_note action / filePath). */
function makeTarget(input: Record<string, unknown> | undefined) {
    return {
        setContent: () => true,
        drop: () => "removed",
        truncate: () => "truncated",
        editMarker: () => "truncated",
        canDrop: () => true,
        readInput: () => input ?? null,
    };
}

function callBlockId(arcId: string): string {
    return `${arcId}#0`;
}

function resultBlockId(arcId: string): string {
    return `${arcId}#1`;
}

function reasoningBlockId(arcId: string): string {
    return `${arcId}#2`;
}

function remapLegacyBlockId(id: string): string {
    if (id.endsWith("#call")) return `${id.slice(0, -"#call".length)}#0`;
    if (id.endsWith("#result")) return `${id.slice(0, -"#result".length)}#1`;
    if (id.endsWith("#reasoning")) return `${id.slice(0, -"#reasoning".length)}#2`;
    return id;
}

function remapExpectedArcs(expected: Record<string, string>): Record<string, string> {
    const remapped: Record<string, string> = {};
    for (const [legacyArc, kind] of Object.entries(expected)) {
        remapped[callBlockId(legacyArc)] = kind;
    }
    return remapped;
}

function assertDecisionSetIdentity(
    label: string,
    legacy: Record<string, string>,
    remapped: Record<string, string>,
) {
    for (const [legacyArc, kind] of Object.entries(legacy)) {
        const flatArc = callBlockId(legacyArc);
        if (remapped[flatArc] !== kind) {
            throw new Error(`${label}: remap changed decision for ${legacyArc} → ${flatArc}`);
        }
    }
    if (Object.keys(legacy).length !== Object.keys(remapped).length) {
        throw new Error(`${label}: remap changed decision count`);
    }
    if (Object.keys(legacy).length > 0 && JSON.stringify(legacy) === JSON.stringify(remapped)) {
        throw new Error(`${label}: remap was vacuous; arc ids did not change to FlatBlock ids`);
    }
}

/** Build the flat CK tail from the fixture: each tag → a ToolCall + ToolResult (+ Reasoning). */
function buildItems(tags: TagFixture[]): SelItemJson[] {
    const items: SelItemJson[] = [];
    for (const t of tags) {
        const providerExecuted = t.providerExecuted ?? false;
        // ToolCall block
        items.push({
            id: callBlockId(t.id),
            ordinal: t.n,
            kind: { ToolCall: { name: t.toolName, input: t.input ?? {} } },
            provider_executed: providerExecuted,
            byte_size: t.inputByteSize ?? 0,
            arc_id: callBlockId(t.id),
        });
        // ToolResult block
        items.push({
            id: resultBlockId(t.id),
            ordinal: t.n,
            kind: { ToolResult: { tool_name: t.toolName } },
            provider_executed: providerExecuted,
            byte_size: t.byteSize,
            arc_id: callBlockId(t.id),
        });
        // optional Reasoning block adjacent to the call
        if ((t.reasoningByteSize ?? 0) > 0) {
            items.push({
                id: reasoningBlockId(t.id),
                ordinal: t.n,
                kind: "Reasoning",
                provider_executed: false,
                byte_size: t.reasoningByteSize ?? 0,
                arc_id: callBlockId(t.id),
            });
        }
    }
    return items;
}

/** Run the real TS selector for the case → {arc_id → "drop"|"edit_marker"}. */
function runTsSelector(spec: CaseSpec): Record<string, string> {
    const expected: Record<string, string> = {};
    const targets = new Map<number, ReturnType<typeof makeTarget>>();
    // tagNumber → arc id, so we can map dropped tagIds back to arc ids.
    const tagNumberToArc = new Map<number, string>();

    if (spec.selector === "emergency") {
        // planEmergencyDrop is PURE — build the tag array directly.
        const tags = spec.tags.map((t) => ({
            tagNumber: t.n,
            type: "tool" as const,
            status: "active" as const,
            toolName: t.toolName,
            byteSize: t.byteSize,
            inputByteSize: t.inputByteSize ?? 0,
            reasoningByteSize: t.reasoningByteSize ?? 0,
        }));
        for (const t of spec.tags) tagNumberToArc.set(t.n, t.id);
        const maxTag = Math.max(...spec.tags.map((t) => t.n));
        const em = spec.emergency ?? { currentTotalInputTokens: 0, ceilingTokens: 0, protectedTags: 0 };
        const plan = emergency.planEmergencyDrop({
            tags,
            floorTags: tags,
            maxTag,
            protectedTags: em.protectedTags,
            currentTotalInputTokens: em.currentTotalInputTokens,
            ceilingTokens: em.ceilingTokens,
            priorInputSample: em.priorInputSample ?? 0,
            hasPriorDrop: em.hasPriorDrop ?? false,
        });
        for (const tagNum of plan.tagNumbers) {
            const arc = tagNumberToArc.get(tagNum);
            if (arc) expected[arc] = "drop";
        }
        return expected;
    }

    // DB-backed selectors: seed an isolated in-memory DB.
    process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), "sel-golden-"));
    const db = openDatabase();
    if (!db) throw new Error("db open failed");
    const SES = "ses-golden";
    try {
        for (const t of spec.tags) {
            insertTag(
                db,
                SES,
                t.id,
                "tool",
                t.byteSize,
                t.n,
                t.reasoningByteSize ?? 0,
                t.toolName,
                t.inputByteSize ?? 0,
            );
            targets.set(t.n, makeTarget(t.input));
            tagNumberToArc.set(t.n, t.id);
        }

        if (spec.selector === "supersession") {
            const ops = supersession.buildSupersessionReclaimOps({ db, sessionId: SES, targets });
            for (const op of ops) {
                const arc = tagNumberToArc.get(op.tagId);
                if (arc) expected[arc] = "drop";
            }
        } else if (spec.selector === "edit") {
            const res = supersession.buildEditSupersessionReclaim({ db, sessionId: SES, targets });
            for (const op of res.ops) {
                const arc = tagNumberToArc.get(op.tagId);
                if (arc) expected[arc] = "edit_marker";
            }
        }
    } finally {
        closeDatabase();
    }
    return expected;
}

function buildCtx(spec: CaseSpec): Record<string, unknown> {
    const maxN = spec.tags.length ? Math.max(...spec.tags.map((t) => t.n)) : 0;
    const em = spec.emergency;
    return {
        pass_class: spec.passClass,
        current_total_input_tokens: em?.currentTotalInputTokens ?? 0,
        ceiling_tokens: em?.ceilingTokens ?? 0,
        // protected tail cutoff = maxTag − protectedTags (ordinal space == tag space).
        protected_cutoff_ordinal: em ? Math.max(maxN - em.protectedTags, 0) : 0,
        prior_input_sample: em?.priorInputSample ?? 0,
        has_prior_drop: em?.hasPriorDrop ?? false,
        agent_drop_ids: [],
    };
}

// --- the corpus (each case exercises one selector's branches) ---

const cases: CaseSpec[] = [
    {
        label: "supersession: todowrite keep-1",
        selector: "supersession",
        smartDrops: true,
        passClass: "Execute",
        tags: [
            { id: "c1", toolName: "todowrite", n: 1, byteSize: 100 },
            { id: "c2", toolName: "todowrite", n: 2, byteSize: 100 },
            { id: "c3", toolName: "todowrite", n: 3, byteSize: 100 },
        ],
    },
    {
        label: "supersession: ctx_reduce keep-5",
        selector: "supersession",
        smartDrops: true,
        passClass: "Execute",
        tags: Array.from({ length: 7 }, (_, i) => ({
            id: `c${i + 1}`,
            toolName: "ctx_reduce",
            n: i + 1,
            byteSize: 40,
        })),
    },
    {
        label: "supersession: zero-value meta drop-all",
        selector: "supersession",
        smartDrops: true,
        passClass: "Execute",
        tags: [
            { id: "c1", toolName: "bash_status", n: 1, byteSize: 30 },
            { id: "c2", toolName: "bash_kill", n: 2, byteSize: 30 },
            { id: "c3", toolName: "bash", n: 3, byteSize: 30 },
        ],
    },
    {
        label: "supersession: ctx_note read+dismiss drop, write keep",
        selector: "supersession",
        smartDrops: true,
        passClass: "Execute",
        tags: [
            { id: "c1", toolName: "ctx_note", n: 1, byteSize: 50, input: { action: "read" } },
            { id: "c2", toolName: "ctx_note", n: 2, byteSize: 50, input: { action: "dismiss" } },
            { id: "c3", toolName: "ctx_note", n: 3, byteSize: 50, input: { action: "write", content: "x" } },
        ],
    },
    {
        label: "edit: older-per-file → edit_marker, newest full",
        selector: "edit",
        smartDrops: true,
        passClass: "Execute",
        tags: [
            { id: "c1", toolName: "edit", n: 1, byteSize: 500, input: { filePath: "a.ts", oldString: "x".repeat(80), newString: "y".repeat(80) } },
            { id: "c2", toolName: "edit", n: 2, byteSize: 500, input: { filePath: "a.ts", oldString: "p".repeat(80), newString: "q".repeat(80) } },
            { id: "c3", toolName: "write", n: 3, byteSize: 500, input: { filePath: "b.ts", content: "z".repeat(80) } },
        ],
    },
    {
        label: "edit: no filePath → skip (fail-safe)",
        selector: "edit",
        smartDrops: true,
        passClass: "Execute",
        tags: [
            { id: "c1", toolName: "edit", n: 1, byteSize: 500, input: { oldString: "x", newString: "y" } },
            { id: "c2", toolName: "edit", n: 2, byteSize: 500, input: { oldString: "p", newString: "q" } },
        ],
    },
    {
        label: "emergency: tier order T3→T2→T1 to headroom",
        selector: "emergency",
        smartDrops: false,
        passClass: "EmergencyForce",
        emergency: { currentTotalInputTokens: 200000, ceilingTokens: 160000, protectedTags: 0 },
        tags: [
            { id: "c1", toolName: "read", n: 1, byteSize: 40000 },   // T1
            { id: "c2", toolName: "grep", n: 2, byteSize: 40000 },   // T2
            { id: "c3", toolName: "bash", n: 3, byteSize: 40000 },   // T3
            { id: "c4", toolName: "web", n: 4, byteSize: 40000 },    // T3
        ],
    },
    {
        label: "emergency: protected tail excluded",
        selector: "emergency",
        smartDrops: false,
        passClass: "EmergencyForce",
        emergency: { currentTotalInputTokens: 200000, ceilingTokens: 160000, protectedTags: 2 },
        tags: [
            { id: "c1", toolName: "bash", n: 1, byteSize: 80000 },
            { id: "c2", toolName: "bash", n: 2, byteSize: 80000 },
            { id: "c3", toolName: "bash", n: 3, byteSize: 80000 },   // protected (n > max-2)
            { id: "c4", toolName: "bash", n: 4, byteSize: 80000 },   // protected
        ],
    },
    {
        label: "emergency: idempotence latch (same sample → noop)",
        selector: "emergency",
        smartDrops: false,
        passClass: "EmergencyForce",
        emergency: { currentTotalInputTokens: 200000, ceilingTokens: 160000, protectedTags: 0, priorInputSample: 200000, hasPriorDrop: true },
        tags: [{ id: "c1", toolName: "bash", n: 1, byteSize: 80000 }],
    },
    {
        // current just above ceiling with a small tail → reclaim <= EMERGENCY_REARM_MIN
        // (2000 tok) → no drop (not worth the cache bust).
        label: "emergency: reclaim below min → noop",
        selector: "emergency",
        smartDrops: false,
        passClass: "EmergencyForce",
        emergency: { currentTotalInputTokens: 160500, ceilingTokens: 160000, protectedTags: 0 },
        tags: [{ id: "c1", toolName: "bash", n: 1, byteSize: 8000 }],
    },
];

const golden: GoldenCase[] = cases.map((spec) => {
    const legacyExpected = runTsSelector(spec);
    const expected = remapExpectedArcs(legacyExpected);
    assertDecisionSetIdentity(spec.label, legacyExpected, expected);
    return {
        label: spec.label,
        items: buildItems(spec.tags),
        ctx: buildCtx(spec),
        smart_drops: spec.smartDrops,
        frozen: (spec.frozen ?? []).map(remapLegacyBlockId),
        expected,
    };
});

const outPath = join(import.meta.dir, "..", "testdata", "selection-golden.json");
writeFileSync(outPath, `${JSON.stringify(golden, null, 2)}\n`);
const totalDecisions = golden.reduce((n, g) => n + Object.keys(g.expected).length, 0);
// eslint-disable-next-line no-console
console.log(`wrote ${golden.length} selection cases (${totalDecisions} arc decisions) → ${outPath}`);
