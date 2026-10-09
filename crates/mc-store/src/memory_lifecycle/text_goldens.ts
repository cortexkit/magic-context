/// <reference types="bun-types" />

/**
 * Regenerate `text_goldens.json` from the TypeScript text rules, which are the reference
 * implementation the Rust port must match byte for byte:
 *
 *   bun crates/mc-store/src/memory_lifecycle/text_goldens.ts > crates/mc-store/src/memory_lifecycle/text_goldens.json
 *
 * Run with `--check` to compare the committed file against the TypeScript output without
 * writing anything; it exits non-zero on any difference. The Rust test
 * `memory_lifecycle::tests::text_goldens_match_the_typescript_reference` asserts the same
 * file, so a divergence on either side turns one of the two red.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
    extractEvidenceWindow,
    hasEvidenceMarker,
    matchFactEvidence,
    normalizeLifecycleText,
    scanConcreteTokens,
    splitMemoryClauses,
} from "../../../../packages/plugin/src/features/magic-context/memory/lifecycle-text";

// Source: docs/reports/historian-merge-turn-trial-v6-sonnet.md:71 (#17639).
const GAP_MEMORY =
    "Rust transform mode must not require Broca (or any other CK module) to be running: every module under CK/subc stays decoupled unless coupling is necessary. Historian and dreamer completions in rust mode run by default in the same harness as the parent session (the host runs the prompt, e.g. OpenCode/Pi child session or the v2 child carrier), and route to the Broca runner only when the user configures it (Ufuk ruling, 2026-09-17). Today `crates/mc-module/src/historian_producer.rs` opens a route straight to `broca` (DEFAULT_RUNNER_MODULE_ID) — that is the gap to close with a host-runner default.";

const splitInputs = [
    GAP_MEMORY,
    "e.g. A. Foo. Next!\n- One. Two.\n`x. y` — last.",
    "Version 1.5 is out. i.e. it works vs. the old one etc. Done? Yes!",
    "1) First item. Still first.\n2. Second item\n* star. item\n+ plus\nplain. Two.",
    "Dash—no split. Dash — split here.\n— leading dash line.",
    "``code. with` ticks`` stays. Next one.",
    "Trailing whitespace.   \n\n  Indented. Line.",
    "\uFEFF- not a list? Really. \u0085- list after NEL.",
    "A. B. C.D. ok. x.y z.",
    "",
    "   ",
];

const normalizeInputs = [
    "\u0085 A\t\u00a0B\u3000 ",
    "\uFEFF A \u180E",
    "a\u2028b\u2029c\u202fd\u205fe\u1680f\u200bg",
    "  lead and trail  ",
];

const tokenInputs = [
    "164 KiB >512 KiB 64 KiB 2026-09-17 12:10 50% memory.auto_promote REFUSAL_CODE src/file.rs `x` abc64 64suffix OTHER_REFUSAL_CODE",
    "164 KiB",
    "Limit is 64 KiB, not 164 KiB.",
    "≥5 seconds ≤10ms 3 tokens 12.5% 1.2.3 v2.0 config.json a.b.c A_B _x 9_9",
    "2026-09-17x 12:10:30 ``a ` b`` `unclosed 7 µs 7µs 5 secs 5 sec.",
    "(see docs/designs/memory-lifecycle.md). Ends with KEY_CODE.",
    "MAX_STAGE2_ATTEMPTS = 3 and NARROW_CHECK_WINDOW_MAX = 1200 units",
];

const markerInputs = [
    "literal user text  /  end",
    "a / b",
    "[42]",
    "[42-43]",
    "[42-]",
    "[N]",
    "Messages 42-43:",
    "Messages 42:",
    "...[truncated]",
    "[… tokens truncated by Magic Context to fit the historian window …]",
    "…",
    "… +3 more",
    "[dropped]",
    "[dropped §3§]",
    "[truncated §3§]",
    "<!-- +5m -->",
    "plain [text] with [a1] and Messages x-y:",
];

const longSentenceA = `${"a".repeat(500)}. `;
const longSentenceB = `${"b".repeat(500)}. `;
const longSentenceC = `${"c".repeat(400)}.`;
const astral = `${"x".repeat(800)}😀${"y".repeat(1199)}`;
const windowInputs: Array<{ name: string; part: string; start: number; end: number }> = [
    { name: "sentence boundary", part: "One. Two. Three. Four.", start: 10, end: 15 },
    { name: "two sentences", part: "One. Two. Three. Four.", start: 5, end: 20 },
    { name: "no terminator near end", part: "x".repeat(2000), start: 1950, end: 1999 },
    { name: "span over max", part: "x".repeat(2000), start: 0, end: 1201 },
    { name: "span at max", part: "x".repeat(2000), start: 0, end: 1200 },
    { name: "join separator", part: "a / b", start: 4, end: 5 },
    { name: "astral cut", part: astral, start: 1999, end: 2001 },
    {
        name: "preceding sentences within max",
        part: longSentenceA + longSentenceB + longSentenceC,
        start: 1004,
        end: 1010,
    },
    {
        name: "second preceding sentence over max",
        part: `${"p".repeat(300)}. ${"q".repeat(1000)}. ${"r".repeat(300)}. Target here.`,
        start: 1606,
        end: 1612,
    },
    {
        name: "core sentence over max",
        part: `${"z".repeat(1500)}. end.`,
        start: 1400,
        end: 1410,
    },
    { name: "span past the part", part: "Short. Text.", start: 7, end: 40 },
];

const repeatedParts = ["First   quote. Repeat quote. First quote.", "elsewhere"];
const spanningParts = ["Alpha one. Beta two. Gamma three.", "second part with Beta two."];
const markerParts = ["Before … after. Clean words here.", "x [7] y"];
const matchBlocks = [
    {
        startOrdinal: 42,
        endOrdinal: 42,
        role: "user",
        parts: repeatedParts,
        joinedText: repeatedParts.join(" / "),
    },
    {
        startOrdinal: 50,
        endOrdinal: 51,
        role: "tool",
        parts: spanningParts,
        joinedText: spanningParts.join(" / "),
    },
    {
        startOrdinal: 60,
        endOrdinal: 60,
        role: "assistant",
        parts: markerParts,
        joinedText: markerParts.join(" / "),
    },
];
const matchInputs: Array<{ ordinal: number; excerpt: string }> = [
    { ordinal: 42, excerpt: "First quote." },
    { ordinal: 42, excerpt: "Repeat\nquote." },
    { ordinal: 42, excerpt: "First paraphrase." },
    { ordinal: 42, excerpt: "First quote. elsewhere" },
    { ordinal: 43, excerpt: "First quote." },
    { ordinal: 50, excerpt: "one. Beta two" },
    { ordinal: 50, excerpt: "Beta two." },
    { ordinal: 50, excerpt: "second part" },
    { ordinal: 60, excerpt: "after. Clean" },
    { ordinal: 60, excerpt: "Clean words" },
    { ordinal: 60, excerpt: "x [7] y" },
    { ordinal: 60, excerpt: "   " },
];

export function buildGoldens() {
    return {
        split: splitInputs.map((input) => ({ input, expected: splitMemoryClauses(input) })),
        normalize: normalizeInputs.map((input) => ({
            input,
            expected: normalizeLifecycleText(input),
        })),
        tokens: tokenInputs.map((input) => ({ input, expected: scanConcreteTokens(input) })),
        markers: markerInputs.map((input) => ({ input, expected: hasEvidenceMarker(input) })),
        windows: windowInputs.map((input) => ({
            ...input,
            expected: extractEvidenceWindow(input.part, input.start, input.end),
        })),
        match: {
            blocks: matchBlocks,
            cases: matchInputs.map((input) => ({
                ...input,
                expected: matchFactEvidence(matchBlocks, input.ordinal, input.excerpt),
            })),
        },
    };
}

if (import.meta.main) {
    const rendered = `${JSON.stringify(buildGoldens(), null, 2)}\n`;
    if (process.argv.includes("--check")) {
        const committed = readFileSync(join(import.meta.dir, "text_goldens.json"), "utf8");
        if (committed !== rendered) {
            console.error("text_goldens.json differs from the TypeScript text rules");
            process.exit(1);
        }
        console.log("text_goldens.json matches the TypeScript text rules");
    } else {
        process.stdout.write(rendered);
    }
}
