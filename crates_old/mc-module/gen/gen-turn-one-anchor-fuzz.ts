/**
 * Generate a seeded TypeScript/Rust parity corpus for historian fact anchors, beyond
 * the hand-written goldens in tests/fixtures/turn-one-anchor-goldens.json.
 *
 * Two kinds of case, each recorded with the result of the production TypeScript code:
 * - `lines`: one fact bullet's text (after the `* ` marker), split by
 *   `splitFactAnchorPrefix` and resolved by `resolveTurnOneFactAnchor` against random
 *   compartment ranges and printed-line ranges;
 * - `documents`: a whole historian `<output>` whose `<facts>` block holds a few such
 *   bullets, parsed by `parseCompartmentOutput` (so the bullet regex, XML unescaping and
 *   the out-of-order anchor remap are part of the comparison).
 *
 * The lines are built from an adversarial alphabet: Unicode whitespace that JavaScript
 * and Rust classify differently (U+0085, U+FEFF), integers past 2^53 and past u64,
 * `unknown`, zero, reversed and partial `messages=` ranges, mismatched brackets and
 * line separators inside a bullet.
 *
 * `historian_validate::tests::turn_one_anchor_fuzz_matches_typescript` replays the
 * corpus through `split_fact_anchor_prefix`, `resolve_fact_anchor` and
 * `parse_compartment_output`. The TypeScript test turn-one-anchor-fuzz.test.ts checks
 * the committed corpus still matches the TypeScript code.
 *
 * Run: bun crates/mc-module/gen/gen-turn-one-anchor-fuzz.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const FUZZ_SEED = 0x5e5f00d;
export const LINE_CASES = 500;
export const DOCUMENT_CASES = 100;

const pluginDir = join(import.meta.dir, "..", "..", "..", "packages", "plugin");

interface TsAnchor {
    compartmentIndex: number;
    startOrdinal?: number;
    endOrdinal?: number;
}

function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const WHITESPACE = ["", " ", "  ", "\t", "\u00a0", "\u0085", "\ufeff", "\u3000", "\u2009"];
const OPENERS = ["[", "[", "[", "(", "{", ""];
const CLOSERS = ["]", "]", "]", ")", "}", ""];
const KEYS = [
    "at_compartment",
    "at_compartment",
    "origin_compartment",
    "AT_COMPARTMENT",
    "at_compartments",
];
const NUMBERS = [
    "1",
    "2",
    "3",
    "4",
    "5",
    "7",
    "9",
    "12",
    "0",
    "01",
    "9007199254740993",
    "18446744073709551615",
    "18446744073709551616",
    "99999999999999999999",
    "\u0661",
    "1.5",
    "-1",
    "",
];
const INDEXES = [...NUMBERS, "unknown", "unknown", "Unknown"];
const CONTENTS = [
    "Uploads are capped at 64 KiB.",
    "Route uploads through the gateway.",
    "x",
    "",
    " ",
    "[nested] bracket text",
    "text\u2028after a line separator",
    "a\rcarriage return",
    "ends with nel\u0085",
    "\ufeffstarts with a byte-order mark",
    "&lt;escaped&gt; &amp; text",
];

export interface LineCase {
    line: string;
    compartments: Array<[number, number]>;
    blocks: Array<[number, number]>;
    ts: {
        content: string;
        compartment: number | null;
        range: [number, number] | null;
        resolved: { compartment: number; blocks: Array<[number, number]> } | null;
    };
}

export interface DocumentCase {
    document: string;
    ts: Array<{
        category: string;
        content: string;
        compartment: number | null;
        range: [number, number] | null;
    }>;
}

function pick<T>(random: () => number, items: readonly T[]): T {
    return items[Math.floor(random() * items.length)] as T;
}

/**
 * A well-formed `[at_compartment=N messages=A-B] text` bullet with small values, then
 * zero to two of its fields swapped for an adversarial alternative, so most cases
 * stay close enough to the real format to reach the anchor and range logic.
 */
function randomLine(random: () => number): string {
    if (random() < 0.05) return pick(random, CONTENTS);
    const small = () => String(1 + Math.floor(random() * 12));
    const startValue = small();
    const field = {
        lead: "",
        open: "[",
        key: random() < 0.85 ? "at_compartment" : "origin_compartment",
        eq: "=",
        quote: random() < 0.15 ? '"' : "",
        index: random() < 0.15 ? "unknown" : String(1 + Math.floor(random() * 3)),
        separator: " ",
        messages: random() < 0.85,
        mquote: random() < 0.1 ? '"' : "",
        start: startValue,
        end: random() < 0.6 ? `-${small()}` : "",
        close: "]",
        gap: " ",
        content: random() < 0.85 ? CONTENTS[0]! : pick(random, CONTENTS),
    };
    const mutations: Array<() => void> = [
        () => (field.lead = pick(random, WHITESPACE)),
        () => (field.open = pick(random, OPENERS)),
        () => (field.key = pick(random, KEYS)),
        () => (field.eq = pick(random, ["=", ":", " = ", `${pick(random, WHITESPACE)}=`])),
        () => (field.index = pick(random, INDEXES)),
        () => (field.separator = pick(random, WHITESPACE)),
        () => (field.start = pick(random, NUMBERS)),
        () =>
            (field.end = `${pick(random, ["", " "])}-${pick(random, ["", " "])}${pick(random, NUMBERS)}`),
        () => (field.close = pick(random, CLOSERS)),
        () => (field.gap = pick(random, WHITESPACE)),
        () => (field.content = pick(random, CONTENTS)),
    ];
    const count = Math.floor(random() * 3);
    for (let at = 0; at < count; at += 1) pick(random, mutations)();
    const range = field.messages
        ? `${field.separator}messages=${field.mquote}${field.start}${field.end}${field.mquote}`
        : "";
    return `${field.lead}${field.open}${field.key}${field.eq}${field.quote}${field.index}${field.quote}${range}${field.close}${field.gap}${field.content}`;
}

/** Contiguous ranges that tile 1..12 at random cut points. */
function randomTiling(random: () => number, cuts: number): Array<[number, number]> {
    const points = new Set<number>();
    while (points.size < cuts) points.add(1 + Math.floor(random() * 11));
    const sorted = [...points].sort((a, b) => a - b);
    const ranges: Array<[number, number]> = [];
    let start = 1;
    for (const point of sorted) {
        ranges.push([start, point]);
        start = point + 1;
    }
    ranges.push([start, 12]);
    return ranges;
}

export async function generateCorpus(): Promise<{
    seed: number;
    lines: LineCase[];
    documents: DocumentCase[];
}> {
    const parser = (await import(
        Bun.resolveSync("./src/hooks/magic-context/compartment-parser", pluginDir)
    )) as {
        splitFactAnchorPrefix: (text: string) => { content: string; anchor?: TsAnchor };
        parseCompartmentOutput: (text: string) => {
            facts: Array<{ category: string; content: string; anchor?: TsAnchor }>;
        };
    };
    const publication = (await import(
        Bun.resolveSync("./src/features/magic-context/memory/turn-one-publication", pluginDir)
    )) as {
        resolveTurnOneFactAnchor: (
            anchor: TsAnchor | undefined,
            compartments: Array<{ startMessage: number; endMessage: number }>,
            blocks: Array<{ startOrdinal: number; endOrdinal: number }>,
        ) => { compartmentIndex: number; blockIndexes: number[] } | null;
    };
    const random = mulberry32(FUZZ_SEED);
    const anchorRange = (anchor: TsAnchor | undefined): [number, number] | null =>
        anchor?.startOrdinal === undefined || anchor.endOrdinal === undefined
            ? null
            : [anchor.startOrdinal, anchor.endOrdinal];

    const lines: LineCase[] = [];
    for (let index = 0; index < LINE_CASES; index += 1) {
        const line = randomLine(random);
        const compartments = randomTiling(random, Math.floor(random() * 3));
        const blocks = randomTiling(random, 2 + Math.floor(random() * 8));
        const { content, anchor } = parser.splitFactAnchorPrefix(line);
        const resolved = publication.resolveTurnOneFactAnchor(
            anchor,
            compartments.map(([startMessage, endMessage]) => ({ startMessage, endMessage })),
            blocks.map(([startOrdinal, endOrdinal]) => ({ startOrdinal, endOrdinal })),
        );
        lines.push({
            line,
            compartments,
            blocks,
            ts: {
                content,
                compartment: anchor?.compartmentIndex ?? null,
                range: anchorRange(anchor),
                resolved: resolved && {
                    compartment: resolved.compartmentIndex,
                    blocks: resolved.blockIndexes.map((at) => blocks[at] as [number, number]),
                },
            },
        });
    }

    const documents: DocumentCase[] = [];
    for (let index = 0; index < DOCUMENT_CASES; index += 1) {
        const compartments = randomTiling(random, 1 + Math.floor(random() * 2));
        const emitted = random() < 0.4 ? [...compartments].reverse() : compartments;
        const body = emitted
            .map(
                ([start, end], at) =>
                    `<compartment start="${start}" end="${end}" title="Part ${at + 1}"><p1>Body ${at + 1}</p1><p2>b</p2><p3>b</p3><p4/></compartment>`,
            )
            .join("\n");
        const newline = random() < 0.2 ? "\r\n" : "\n";
        const bullets = Array.from(
            { length: 1 + Math.floor(random() * 4) },
            () => `* ${randomLine(random)}`,
        ).join(newline);
        const category = pick(random, ["PROJECT_RULES", "CONSTRAINTS", "NAMING"]);
        const document = `<output><compartments>\n${body}\n</compartments>\n<facts>\n<${category}>${newline}${bullets}${newline}</${category}>\n</facts>\n<meta><unprocessed_from>13</unprocessed_from></meta>\n</output>`;
        const parsed = parser.parseCompartmentOutput(document);
        documents.push({
            document,
            ts: parsed.facts.map((fact) => ({
                category: fact.category,
                content: fact.content,
                compartment: fact.anchor?.compartmentIndex ?? null,
                range: anchorRange(fact.anchor),
            })),
        });
    }
    return { seed: FUZZ_SEED, lines, documents };
}

export const CORPUS_PATH = join(
    import.meta.dir,
    "..",
    "testdata",
    "turn-one-anchor-fuzz.json",
);

if (import.meta.main) {
    const corpus = await generateCorpus();
    writeFileSync(CORPUS_PATH, `${JSON.stringify(corpus)}\n`);
    console.log(
        `wrote ${corpus.lines.length} line cases and ${corpus.documents.length} document cases to ${CORPUS_PATH}`,
    );
}
