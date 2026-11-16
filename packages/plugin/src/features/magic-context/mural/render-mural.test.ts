import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { COMPRESS_CUES_SYSTEM_PROMPT } from "./compress-cues-prompt";
import { MURAL_FONT_GLYPHS, MURAL_FONT_REPLACEMENT_GLYPH } from "./mural-font.generated";
import {
    MURAL_CELL_WIDTH,
    MURAL_HEIGHT,
    MURAL_LINE_PITCH,
    MURAL_ROOM_WIDTH,
    MURAL_VISION_TILE,
    MURAL_WIDTH,
    type MuralRenderEntry,
    drawableMuralCue,
    muralImageTokenEstimateForDimensions,
    renderMural,
} from "./render-mural";

const CATEGORIES = ["PROJECT_RULES", "ARCHITECTURE", "CONSTRAINTS", "CONFIG_VALUES", "NAMING"];

function longestLine(text: string): number {
    return Math.max(...text.split("\n").map((line) => [...line.replace(/\s+$/, "")].length), 0);
}

function syntheticEntries(count: number): MuralRenderEntry[] {
    return Array.from({ length: count }, (_, index) => ({
        id: index + 1,
        category: CATEGORIES[index % CATEGORIES.length]!,
        importance: 80,
        cue: `cue ${index} anchor→target relation`,
    }));
}

describe("deterministic mural renderer", () => {
    test("renders every cue grammar symbol with its own glyph, not the fallback", () => {
        const symbols = COMPRESS_CUES_SYSTEM_PROMPT.match(/Use the symbols (.+?) when/)![1]!.split(
            " ",
        );
        expect(symbols).toEqual(["→", "←", "⊘", "∵", "≺", "≻", "∅", "∀"]);
        const images = new Set<string>();
        const render = (cue: string) =>
            Buffer.from(
                renderMural([{ id: 1, category: "PROJECT_RULES", importance: 80, cue: `⊘ ${cue}` }])
                    .png,
            ).toString("base64");
        const fallback = render("\uFFFD");
        for (const symbol of symbols) {
            expect(MURAL_FONT_GLYPHS[symbol]).toBeDefined();
            expect(MURAL_FONT_GLYPHS[symbol]!.rows).not.toEqual(MURAL_FONT_REPLACEMENT_GLYPH.rows);
            const image = render(symbol);
            expect(image).not.toBe(fallback);
            expect(images.has(image)).toBe(false);
            images.add(image);
        }
        expect(MURAL_FONT_GLYPHS["⊘"]!.rows).not.toEqual(MURAL_FONT_GLYPHS["@"]!.rows);
    });

    test("includes every printable ASCII glyph in the generated atlas", () => {
        for (let codepoint = 0x20; codepoint <= 0x7e; codepoint++) {
            const character = String.fromCodePoint(codepoint);
            expect(MURAL_FONT_GLYPHS[character]).toBeDefined();
        }
    });

    test("preserves case and leaves a blank column between consecutive M glyphs", () => {
        const upper = MURAL_FONT_GLYPHS.M!;
        const lower = MURAL_FONT_GLYPHS.a!;
        expect(lower.rows).not.toEqual(upper.rows);

        const pairColumns = Array.from({ length: upper.advance * 2 }, (_, column) =>
            upper.rows.some((row) => {
                const localColumn = column % upper.advance;
                return (
                    localColumn < upper.width &&
                    (row & (1 << (upper.width - localColumn - 1))) !== 0
                );
            }),
        );
        expect(pairColumns[upper.advance - 1]).toBe(false);
        expect(pairColumns[upper.advance]).toBe(true);
    });

    test("renders identical bytes for identical input (pure function)", () => {
        const entries: MuralRenderEntry[] = Array.from({ length: 40 }, (_, index) => ({
            id: index + 1,
            category: CATEGORIES[index % CATEGORIES.length]!,
            importance: 80 - (index % 30),
            cue: `synthetic cue ${index}`,
        }));
        const first = renderMural(entries);
        const second = renderMural(entries);
        expect(Buffer.from(first.png).equals(Buffer.from(second.png))).toBe(true);
        expect(first.sha256Input).toBe(second.sha256Input);
        expect(first.png.slice(0, 8)).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
        expect([MURAL_WIDTH, MURAL_HEIGHT]).toEqual([1092, 1092]);
    });

    test("uses Anthropic's exact 28px tile token formula", () => {
        // 1092x1092 is 39x39 patches; a 364x700 image is 13x25 patches.
        expect(muralImageTokenEstimateForDimensions(1092, 1092)).toBe(39 * 39);
        expect(muralImageTokenEstimateForDimensions(364, 700)).toBe(13 * 25);
    });

    test("fits the 7/50/200 size matrix while keeping full pools at the cap", () => {
        const expected = {
            // 40 chars × 5px = 200px → 224px = 8 tiles; 14 lines × 9px =
            // 126px → 140px = 5 tiles, for 8 × 5 = 40 image tiles.
            7: [224, 140, 40],
            // Three balanced columns make (3 × 40 + 2 gap chars) × 5px =
            // 610px → 616px = 22 tiles; 34 lines × 9px = 306px → 308px =
            // 11 tiles, for 22 × 11 = 242 image tiles.
            50: [616, 308, 242],
            // The capped three-column layout leaves 120 usable rows per column
            // after the never-orphan-header rule: 120 × 9px = 1080px → 1092px
            // = 39 tiles; 22 × 39 = 858 image tiles.
            200: [616, 1092, 858],
        } as const;

        for (const count of [7, 50, 200] as const) {
            const result = renderMural(syntheticEntries(count));
            expect(result.width % MURAL_VISION_TILE).toBe(0);
            expect(result.height % MURAL_VISION_TILE).toBe(0);
            expect([
                result.width,
                result.height,
                muralImageTokenEstimateForDimensions(result.width, result.height),
            ]).toEqual(expected[count]);
            if (count === 7 || count === 50) {
                expect(result.width).toBeLessThan(MURAL_WIDTH);
                expect(result.height).toBeLessThan(MURAL_HEIGHT);
            } else {
                // The full pool still reaches the 1092px height cap; fitted columns
                // leave its width at 616px rather than paying for blank side tiles.
                expect(result.height).toBe(MURAL_HEIGHT);
            }
        }
    });

    test("never costs more tiles than the legacy 72-character single-column fixture", () => {
        const entries = syntheticEntries(50);
        const result = renderMural(entries);
        // Alternating categories produce 50 banners + 50 body lines. The old
        // single-column layout was 72 chars × 5px = 360px → 364px = 13 tiles
        // wide and 100 × 9px = 900px → 924px = 33 tiles tall: 13 × 33 = 429.
        const legacyTiles = muralImageTokenEstimateForDimensions(
            Math.ceil((MURAL_ROOM_WIDTH * MURAL_CELL_WIDTH) / MURAL_VISION_TILE) *
                MURAL_VISION_TILE,
            Math.ceil((entries.length * 2 * MURAL_LINE_PITCH) / MURAL_VISION_TILE) *
                MURAL_VISION_TILE,
        );
        const newTiles = muralImageTokenEstimateForDimensions(result.width, result.height);
        expect(newTiles).toBeLessThanOrEqual(legacyTiles);
    });

    test("fills all three columns on a 300-cue fixture (>80% line occupancy)", () => {
        // 300 medium cues far exceed one column; with flat bands + full pool the
        // three-column flow should be densely filled.
        const entries: MuralRenderEntry[] = Array.from({ length: 300 }, (_, index) => ({
            id: index + 1,
            category: CATEGORIES[index % CATEGORIES.length]!,
            importance: 75,
            cue: `cue ${index} anchor→target relation`,
        }));
        const result = renderMural(entries);
        // All three columns are used.
        expect(result.layoutItems.some((item) => item.column === 0)).toBe(true);
        expect(result.layoutItems.some((item) => item.column === 1)).toBe(true);
        expect(result.layoutItems.some((item) => item.column === 2)).toBe(true);
        // Occupancy: filled content lines vs. total grid capacity > 80%.
        const rows = Math.floor(MURAL_HEIGHT / MURAL_LINE_PITCH);
        const capacity = 3 * rows;
        expect(result.filledLineCount / capacity).toBeGreaterThan(0.8);
    });

    test("word-wraps a long high-importance cue at the column width (never overruns 72)", () => {
        const longCue =
            "very long high importance cue that certainly exceeds one column and must wrap across multiple lines cleanly";
        const result = renderMural([
            { id: 1, category: "PROJECT_RULES", importance: 90, cue: longCue },
        ]);
        // No rendered line exceeds three legacy-width columns; the selected
        // content width is narrower and continuation lines use two spaces.
        expect(longestLine(result.muralText)).toBeLessThanOrEqual(
            MURAL_ROOM_WIDTH * 3 + 2, // three padded columns + 2 single-space gaps
        );
        for (const line of result.muralText.split("\n")) {
            for (const column of [0, 1, 2]) {
                const slice = line.slice(
                    column * (MURAL_ROOM_WIDTH + 1),
                    column * (MURAL_ROOM_WIDTH + 1) + MURAL_ROOM_WIDTH,
                );
                expect([...slice].length).toBeLessThanOrEqual(MURAL_ROOM_WIDTH);
            }
        }
        // The single entry still gets a placement (its first wrapped line).
        expect(result.renderedIds).toContain(1);
    });

    test("packs two short cues onto one shared line", () => {
        const result = renderMural([
            { id: 1, category: "NAMING", importance: 50, cue: "short a" },
            { id: 2, category: "NAMING", importance: 50, cue: "short b" },
        ]);
        // Both ids land on the SAME line (shared pair) → identical line number.
        const a = result.placements.get(1);
        const b = result.placements.get(2);
        expect(a).toBeDefined();
        expect(b).toBeDefined();
        expect(a!.line).toBe(b!.line);
        expect(a!.column).toBe(b!.column);
    });

    test("does not shared-pair a prohibition cue (⊘ carries its own line)", () => {
        const result = renderMural([
            { id: 1, category: "CONSTRAINTS", importance: 50, cue: "⊘x (break)" },
            { id: 2, category: "CONSTRAINTS", importance: 50, cue: "short b" },
        ]);
        const a = result.placements.get(1);
        const b = result.placements.get(2);
        expect(a!.line).not.toBe(b!.line);
    });

    test("prohibition ink: a ⊘ cue renders in the prohibition color, plain cues in body ink", () => {
        // Two murals differing ONLY in whether the cue is a prohibition must
        // produce different pixels (prohibition ink is a distinct color).
        const withProhibition = renderMural([
            { id: 1, category: "CONSTRAINTS", importance: 80, cue: "⊘cache write (ABI break)" },
        ]);
        const withoutProhibition = renderMural([
            { id: 1, category: "CONSTRAINTS", importance: 80, cue: "cache write ABI ok now yes" },
        ]);
        expect(Buffer.from(withProhibition.png).equals(Buffer.from(withoutProhibition.png))).toBe(
            false,
        );
    });

    test("empty entry list renders nothing placed (m0 omits the block)", () => {
        const result = renderMural([]);
        expect(result.renderedIds).toHaveLength(0);
        expect(result.filledLineCount).toBe(0);
        // Still produces a valid (blank) PNG rather than throwing.
        expect(result.png.slice(0, 8)).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    });

    test("emits one category banner per distinct category band", () => {
        const result = renderMural([
            { id: 1, category: "PROJECT_RULES", importance: 80, cue: "a b c" },
            { id: 2, category: "ARCHITECTURE", importance: 80, cue: "d e f" },
            { id: 3, category: "ARCHITECTURE", importance: 70, cue: "g h i" },
        ]);
        const banners = result.layoutItems.filter((item) => item.kind === "category");
        expect(banners).toHaveLength(2);
    });
});

/** Cues that draw with the font's own glyphs: the cue grammar symbols, arrows, an em
 *  dash, whitespace the renderer collapses, and a cue long enough to wrap. */
const DRAWABLE_TODAY_CUES = [
    "⊘cache write (ABI break)",
    "m[0] → frozen baseline — m[1] → delta",
    "∀ tool calls ≺ result ≻ pairing",
    "∅ historian veto ∵ disjoint DBs",
    "renderer ← cue pool • deterministic",
    "tabs\tand\nnewlines collapse",
    "non-breaking\u00a0space stays a space",
    "▰ bar ─ rule",
    "very long high importance cue that certainly exceeds one column and must wrap across multiple lines cleanly — with an em dash",
    "a",
    "b",
];

function drawableTodayPool(perCategory: number): MuralRenderEntry[] {
    const entries: MuralRenderEntry[] = [];
    for (const category of CATEGORIES) {
        for (let index = 0; index < perCategory; index++) {
            entries.push({
                id: entries.length + 1,
                category,
                importance: 90 - (index % 60),
                cue:
                    DRAWABLE_TODAY_CUES[index] ??
                    `cue ${category.toLowerCase()}-${index} anchor→target — relation`,
            });
        }
    }
    return entries;
}

function samePng(a: { png: Uint8Array }, b: { png: Uint8Array }): boolean {
    return Buffer.from(a.png).equals(Buffer.from(b.png));
}

describe("cues the mural font cannot draw", () => {
    test("a pool the font draws keeps the exact PNG bytes it rendered before", () => {
        // SHA-256 of the PNGs these pools rendered before the renderer started leaving
        // out cues it cannot draw. The mural sits in the cached prompt head, so a
        // changed hash means every session showing such a mural pays for new image
        // bytes on its next rebuild. The larger pool overflows the capped image, so
        // it also covers entries left out for space.
        const before = {
            24: "6461f862ddee6aca8ac40982d5e273f5d9de650d3f2b7e108527f3afc4275c5d",
            80: "d6be794d040dbc3bc209acd9e16be961680767b2f6e67b7fac2a072d0578f459",
        } as const;
        for (const perCategory of [24, 80] as const) {
            const result = renderMural(drawableTodayPool(perCategory));
            expect(result.undrawableIds).toEqual([]);
            expect(createHash("sha256").update(result.png).digest("hex")).toBe(
                before[perCategory],
            );
        }
        expect(renderMural(drawableTodayPool(80)).droppedIds.length).toBeGreaterThan(0);
    });

    test("a Chinese-only pool places nothing: no cue, no banner, no partial text", () => {
        const result = renderMural([
            { id: 1, category: "PROJECT_RULES", importance: 90, cue: "缓存写入会破坏 ABI" },
            { id: 2, category: "ARCHITECTURE", importance: 80, cue: "历史记录 → 压缩" },
            { id: 3, category: "NAMING", importance: 50, cue: "文件名使用 kebab-case" },
        ]);
        expect(result.renderedIds).toEqual([]);
        expect(result.undrawableIds).toEqual([1, 2, 3]);
        expect(result.droppedIds).toEqual([]);
        expect(result.layoutItems).toEqual([]);
        expect(result.filledLineCount).toBe(0);
    });

    test("a mixed pool draws only its drawable cues, and a band left empty loses its banner", () => {
        const drawable: MuralRenderEntry[] = [
            { id: 1, category: "PROJECT_RULES", importance: 90, cue: "⊘cache write (ABI break)" },
            { id: 3, category: "ARCHITECTURE", importance: 80, cue: "m[0] → frozen baseline" },
            { id: 5, category: "CONSTRAINTS", importance: 70, cue: "execute ≺ force band" },
        ];
        const mixed: MuralRenderEntry[] = [
            drawable[0]!,
            // Mostly drawable text still leaves the whole cue out, never part of it.
            { id: 2, category: "PROJECT_RULES", importance: 85, cue: "cache → ABI 破坏" },
            drawable[1]!,
            drawable[2]!,
            { id: 4, category: "NAMING", importance: 60, cue: "文件名使用 kebab-case" },
        ];
        const result = renderMural(mixed);
        expect(result.renderedIds).toEqual([1, 3, 5]);
        expect(result.undrawableIds).toEqual([2, 4]);
        expect(result.droppedIds).toEqual([]);
        expect(
            result.layoutItems
                .filter((item) => item.kind === "category")
                .map((item) => item.category),
        ).toEqual(["PROJECT_RULES", "ARCHITECTURE", "CONSTRAINTS"]);
        // Identical pixels to the drawable cues alone: no replacement boxes anywhere.
        expect(samePng(result, renderMural(drawable))).toBe(true);
    });

    test("normalization rescues accented Latin and typographic punctuation", () => {
        const entry = (cue: string): MuralRenderEntry[] => [
            { id: 1, category: "NAMING", importance: 50, cue },
        ];
        // Precomposed and already-decomposed accents, curly quotes, an en dash, an
        // ellipsis, fullwidth Latin and a narrow no-break space.
        const rescued = renderMural(
            entry("café “naïve” ‘re\u0301sumé’ – ＡＢＣ…\u202Fend"),
        );
        const ascii = renderMural(entry(`cafe "naive" 'resume' - ABC... end`));
        expect(rescued.renderedIds).toEqual([1]);
        expect(rescued.undrawableIds).toEqual([]);
        expect(rescued.muralText).toBe(ascii.muralText);
        expect(samePng(rescued, ascii)).toBe(true);
    });

    test("a character the font draws is never rewritten, and a negated symbol is left out", () => {
        // The em dash and arrows have their own glyphs, so they stay as written.
        expect(drawableMuralCue("a — b → c")).toBe("a — b → c");
        const entry = (cue: string): MuralRenderEntry[] => [
            { id: 1, category: "NAMING", importance: 50, cue },
        ];
        expect(samePng(renderMural(entry("a — b")), renderMural(entry("a - b")))).toBe(false);
        // Whitespace the renderer collapses never makes a cue undrawable.
        expect(drawableMuralCue("tabs\tand\nnewlines")).toBe("tabs\tand\nnewlines");
        // ≠ and ↛ decompose to = and → plus a negating overlay; dropping the overlay
        // would draw the opposite meaning, so the cue is left out instead.
        expect(drawableMuralCue("x ≠ y")).toBeNull();
        expect(drawableMuralCue("p ↛ q")).toBeNull();
        // A cue made only of combining marks has nothing left to draw.
        expect(drawableMuralCue("\u0301\u0308")).toBeNull();
        expect(drawableMuralCue("内存")).toBeNull();
    });
});
