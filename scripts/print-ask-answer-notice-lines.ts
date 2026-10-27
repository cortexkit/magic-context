#!/usr/bin/env bun
/**
 * Print the rendered ask-answer lines for every vendored Prefrontal notice
 * vector, plus one user message that mixes an answer notice with real text, so
 * the Rust lane can compare its own output against them.
 *
 * Run from the repository root:
 *
 *   bun scripts/print-ask-answer-notice-lines.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
    extractAskAnswerNotices,
    formatAskAnswerNotice,
} from "../packages/plugin/src/hooks/magic-context/ask-answer-notice";
import { cleanUserText } from "../packages/plugin/src/hooks/magic-context/read-session-chunk";

const fixtureDir = join(import.meta.dir, "..", "testdata", "prefrontal-ask-answer-notice-v1");
const cases = [
    "batch",
    "clarification",
    "dismissal",
    "form",
    "single-option",
    "two-round-follow-up",
    "typed",
    "drift-header",
    "drift-trailer",
];

const single = JSON.parse(readFileSync(join(fixtureDir, "single-option.json"), "utf8")) as string;
// Written text plus the notice, and text after it inside the same envelope.
const mixed = [`Use staging.`, single, `Please confirm before the release.`].join("\n\n");
const insideEnvelope = single.replace(
    "\nAnswer: Use the project route\n",
    "\nAnswer: Use the project route\nPlease confirm before the release.\n",
);

const rows = [
    ...cases.map((name) => [
        name,
        JSON.parse(readFileSync(join(fixtureDir, `${name}.json`), "utf8")) as string,
    ]),
    ["mixed-text-and-notice", mixed],
    ["text-inside-notice-envelope", insideEnvelope],
];

for (const [name, text] of rows) {
    const answer = extractAskAnswerNotices(text!) as { question: string; answer: string }[];
    console.log(
        [
            name,
            JSON.stringify({
                answers: answer.map(formatAskAnswerNotice),
                remainder: cleanUserText(text!),
            }),
        ].join("\t"),
    );
}
