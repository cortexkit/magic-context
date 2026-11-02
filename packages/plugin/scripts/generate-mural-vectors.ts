// Writes the memory mural parity vectors the Rust module (ck-mc) checks its
// renderer against: for fixed cue lists, this plugin's layout text, image
// size, drawn and dropped memories, and a SHA-256 of the raw RGB pixels.
// The PNG bytes are left out on purpose: the two sides use different deflate
// encoders, so only the pixels are expected to match.
//
// Usage: bun packages/plugin/scripts/generate-mural-vectors.ts <output.json>
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

import {
    type MuralRenderEntry,
    planMuralRender,
    rasterMural,
} from "../src/features/magic-context/mural/render-mural";

const CATEGORIES = ["PROJECT_RULES", "ARCHITECTURE", "CONSTRAINTS", "CONFIG_VALUES", "NAMING"];

/** `count` cues spread over the five categories, with varied lengths. */
function generated(count: number): MuralRenderEntry[] {
    const entries: MuralRenderEntry[] = [];
    for (let id = 1; id <= count; id++) {
        const category = CATEGORIES[Math.floor(((id - 1) * CATEGORIES.length) / count)] ?? "NAMING";
        const words = 1 + ((id * 7) % 11);
        const cue = Array.from({ length: words }, (_, index) => `w${(id * 13 + index * 5) % 97}`)
            .join(" ")
            .concat(id % 9 === 0 ? ` → ⊘x${id} (why)` : "");
        entries.push({ id, category, importance: 90 - (id % 40), cue });
    }
    return entries;
}

const cases: { name: string; entries: MuralRenderEntry[] }[] = [
    { name: "empty", entries: [] },
    {
        name: "small",
        entries: [
            { id: 3, category: "PROJECT_RULES", importance: 90, cue: "⊘rm -rf scratch (symlinks)" },
            { id: 7, category: "PROJECT_RULES", importance: 80, cue: "bot speech ← checkout" },
            { id: 8, category: "PROJECT_RULES", importance: 70, cue: "gh close needs reason" },
            { id: 2, category: "ARCHITECTURE", importance: 85, cue: "m[0] frozen; m[1] delta" },
            { id: 9, category: "ARCHITECTURE", importance: 60, cue: "views ∵ runner applies" },
            { id: 11, category: "NAMING", importance: 50, cue: "ck-mc = module" },
        ],
    },
    {
        name: "wrapping",
        entries: [
            {
                id: 1,
                category: "CONFIG_VALUES",
                importance: 90,
                cue: "path ~/.local/share/cortexkit/magic-context/specimens/very-long-folder-name-that-will-not-fit-anywhere/file.db → evidence",
            },
            {
                id: 2,
                category: "CONFIG_VALUES",
                importance: 80,
                cue: "rocket 🚀 and <tag> and 日本語 mixed  with\ttabs\nand newlines",
            },
            {
                id: 3,
                category: "LEGACY_CATEGORY",
                importance: 40,
                cue: "an unknown category banner gets the grey colour and its own band",
            },
        ],
    },
    { name: "three_columns", entries: generated(300) },
    { name: "overflow", entries: generated(1500) },
];

const output = cases.map(({ name, entries }) => {
    const plan = planMuralRender(entries);
    const pixels = rasterMural(plan);
    return {
        name,
        entries,
        text: plan.layout.text,
        width: plan.width,
        height: plan.height,
        rendered_ids: plan.layout.renderedIds,
        dropped_ids: plan.layout.droppedIds,
        pixels_sha256: createHash("sha256").update(pixels).digest("hex"),
    };
});

const target = process.argv[2];
if (!target) throw new Error("usage: generate-mural-vectors.ts <output.json>");
writeFileSync(target, `${JSON.stringify(output, null, 2)}\n`);
