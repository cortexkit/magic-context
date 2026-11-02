/// <reference types="bun-types" />

/**
 * Write `testdata/turn-one-anchor-ranges.json`: how the plugin parses and
 * resolves fact anchors that cite more than one message range
 * (`messages=A-B,C`), the cases the older shared anchor fixtures predate.
 * `summary::validate` tests the Rust parser and resolver against it.
 *
 *   bun crates/mc-module/gen/gen-turn-one-anchor-ranges.ts [plugin root] > crates/mc-module/testdata/turn-one-anchor-ranges.json
 *
 * The plugin root defaults to this repository's `packages/plugin`; pass the
 * root of a checkout whose parser accepts several ranges when this one does
 * not.
 */

import { resolve } from "node:path";

const root = resolve(process.argv[2] ?? resolve(import.meta.dir, "../../../packages/plugin"));
const { splitFactAnchorPrefix } = await import(`${root}/src/hooks/magic-context/compartment-parser.ts`);
const { resolveTurnOneFactAnchor } = await import(
    `${root}/src/features/magic-context/memory/turn-one-publication.ts`
);

// Two published compartments over one chunk, each line printed on its own.
const compartments = [
    { startMessage: 10, endMessage: 19 },
    { startMessage: 20, endMessage: 30 },
];
const blocks = [
    [10, 11],
    [12, 12],
    [13, 15],
    [16, 19],
    [20, 22],
    [23, 23],
    [24, 30],
].map(([startOrdinal, endOrdinal]) => ({ startOrdinal, endOrdinal }));
const chunk = { startOrdinal: 10, endOrdinal: 30 };

const lines = [
    "[at_compartment=1 messages=12] One line.",
    "[at_compartment=1 messages=10-11,13-15] Two ranges.",
    "[at_compartment=1 messages=10-11, 12 ,16-19] Three ranges with spaces.",
    "[at_compartment=1 messages=10-11,12,13-15,16-19] Four ranges reject the anchor.",
    "[at_compartment=1 messages=12,12] The same line twice.",
    "[at_compartment=1 messages=10-12,12] Overlapping ranges share a line.",
    "[at_compartment=1 messages=13-15,20-22] The second range leaves the compartment.",
    "[at_compartment=2 messages=24-30,20-22] Ranges out of order.",
    "[at_compartment=2 messages=21-22] A range starting inside a line.",
    "[at_compartment=1 messages=15-12] A backwards range.",
    "[at_compartment=1 messages=10-30] The whole chunk.",
    '[at_compartment="2" messages="23 - 23"] Quoted and spaced.',
    "[at_compartment=2 messages=23,] A trailing comma is not a range list.",
    "[at_compartment=unknown messages=12,13-15] Unknown compartment.",
    "[at_compartment=3 messages=12] A compartment past the published ones.",
];

const cases = lines.map((line) => {
    const parsed = splitFactAnchorPrefix(line);
    const anchor = parsed.anchor;
    const ranges = anchor
        ? (anchor.ranges ??
              (anchor.startOrdinal !== undefined
                  ? [{ startOrdinal: anchor.startOrdinal, endOrdinal: anchor.endOrdinal }]
                  : []))
        : [];
    const resolved = resolveTurnOneFactAnchor(anchor, compartments, blocks, chunk);
    return {
        line,
        content: parsed.content,
        compartment: anchor?.compartmentIndex ?? null,
        ranges: ranges.map((range: { startOrdinal: number; endOrdinal: number }) => [
            range.startOrdinal,
            range.endOrdinal,
        ]),
        resolved: resolved
            ? { compartment: resolved.compartmentIndex, blocks: resolved.blockIndexes }
            : null,
    };
});

process.stdout.write(
    `${JSON.stringify(
        {
            compartments: compartments.map((c) => [c.startMessage, c.endMessage]),
            blocks: blocks.map((b) => [b.startOrdinal, b.endOrdinal]),
            chunk: [chunk.startOrdinal, chunk.endOrdinal],
            cases,
        },
        null,
        2,
    )}\n`,
);
