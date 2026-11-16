import { deflateSync } from "node:zlib";

import {
    MURAL_FONT_CELL_HEIGHT,
    MURAL_FONT_CELL_WIDTH,
    MURAL_FONT_GLYPHS,
    MURAL_FONT_LINE_PITCH,
    MURAL_FONT_REPLACEMENT_GLYPH,
    type MuralFontGlyph,
} from "./mural-font.generated";

/** Maximum canvas extent; sparse renders use only the needed snapped extent. */
export const MURAL_WIDTH = 1_092;
export const MURAL_HEIGHT = 1_092;
/** Anthropic vision image-token tiles are 28 pixels on each side. */
export const MURAL_VISION_TILE = 28;
export const MURAL_FONT = "spleen-5x8";
/** Spleen's 5px cell includes its own blank right-side column for letter spacing. */
export const MURAL_CELL_WIDTH = MURAL_FONT_CELL_WIDTH;
export const MURAL_CELL_HEIGHT = MURAL_FONT_CELL_HEIGHT;
export const MURAL_LINE_PITCH = MURAL_FONT_LINE_PITCH;
export const MURAL_COLUMNS = 3;
export const MURAL_COLUMN_GAP = 1;
/** Width bounds keep sparse murals compact without making their columns unreadably narrow. */
const MURAL_MIN_ROOM_WIDTH = 40;
/** Keep the historical 72-character maximum so murals remain compatible with the prior single-column layout and its line-width limit. */
export const MURAL_ROOM_WIDTH = 72;
export const MURAL_ROWS = Math.floor(MURAL_HEIGHT / MURAL_LINE_PITCH);
export const MURAL_LINE_CAPACITY = MURAL_COLUMNS * MURAL_ROWS;

export type MuralCategory = string;

/** A flat mural entry to render. No rooms, no merges — resolveMural produces a
 *  pre-ordered flat list (category band → importance DESC → id ASC) and the
 *  renderer packs it deterministically into the capped image. */
export interface MuralRenderEntry {
    id: number;
    category: MuralCategory;
    importance: number;
    cue: string;
}

export interface MuralLayoutItem {
    kind: "category" | "entry";
    category: MuralCategory;
    column: number;
    startLine: number;
    endLine: number;
}

export interface MuralRenderResult {
    png: Uint8Array;
    dataUrl: string;
    muralText: string;
    sha256Input: string;
    placements: Map<number, { category: MuralCategory; column: number; line: number }>;
    layoutItems: MuralLayoutItem[];
    renderedIds: number[];
    /** Entries trimmed because the capped image filled before reaching them. */
    droppedIds: number[];
    /** Entries left out because their cue has a character the font cannot draw,
     *  even after normalization (see drawableMuralCue). They never reach the layout,
     *  so they are not counted in droppedIds. */
    undrawableIds: number[];
    categoryLineUsage: Record<string, number>;
    /** Content lines actually placed in the grid (excludes blank cells). Used to
     *  assert the three-column fill occupancy. */
    filledLineCount: number;
    /** PNG dimensions after content cropping and vision-tile snapping. */
    width: number;
    height: number;
}

const CATEGORY_COLORS: Record<string, readonly [number, number, number]> = {
    PROJECT_RULES: [24, 58, 112],
    ARCHITECTURE: [0, 88, 92],
    CONSTRAINTS: [126, 76, 16],
    CONFIG_VALUES: [88, 52, 132],
    NAMING: [28, 98, 58],
};
const BODY_INK: readonly [number, number, number] = [18, 20, 24];
const PROHIBITION_INK: readonly [number, number, number] = [148, 28, 35];

function codepoints(value: string): number {
    return [...value].length;
}

function escapeText(value: string): string {
    return value
        .replace(/[\r\n]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Typographic punctuation the font has no glyph for, mapped to the ASCII it does
 * draw. A character is looked up here only when the font lacks it, so the em dash,
 * which the font draws, keeps its own glyph. Some entries never fire today (the
 * whitespace cleanup already turns non-breaking spaces into plain ones, and NFKD
 * alone would expand the ellipsis); they are listed so the mapping reads whole.
 */
const PUNCTUATION_FALLBACKS: Readonly<Record<string, string>> = {
    "\u2018": "'", // left single quotation mark
    "\u2019": "'", // right single quotation mark
    "\u201A": "'", // single low-9 quotation mark
    "\u201B": "'", // single high-reversed-9 quotation mark
    "\u201C": '"', // left double quotation mark
    "\u201D": '"', // right double quotation mark
    "\u201E": '"', // double low-9 quotation mark
    "\u201F": '"', // double high-reversed-9 quotation mark
    "\u2013": "-", // en dash
    "\u2014": "-", // em dash
    "\u2026": "...", // horizontal ellipsis
    "\u00A0": " ", // no-break space
    "\u2007": " ", // figure space
    "\u202F": " ", // narrow no-break space
};

/**
 * Combining marks removed after NFKD, so é (e + U+0301) draws as e. The overlay
 * marks U+0334-U+0338 are kept: they negate the symbol under them (≠ is = with
 * U+0338, ↛ is → with U+0338), and removing one would draw the opposite meaning.
 * Kept, they have no glyph, so a cue containing one is left out instead.
 */
const REMOVABLE_COMBINING_MARK = /(?![\u0334-\u0338])\p{M}/gu;

function hasGlyph(character: string): boolean {
    return MURAL_FONT_GLYPHS[character] !== undefined;
}

/**
 * The text the mural draws for a cue, or null when the font cannot draw it.
 *
 * A character the font has a glyph for is kept exactly as written, so a cue that
 * draws today keeps the same bytes. Any other character gets one rescue:
 * typographic punctuation maps to ASCII, and everything else goes through NFKD
 * with combining marks removed (é becomes e, fullwidth Ａ becomes A). If a
 * character still has no glyph (Chinese text, for example), the whole cue is left
 * out: drawing it in part, or as replacement boxes, would show the model nothing
 * useful while still costing image tokens.
 */
export function drawableMuralCue(cue: string): string | null {
    const text = escapeText(cue);
    let normalized = "";
    let changed = false;
    for (const character of text) {
        if (hasGlyph(character)) {
            normalized += character;
            continue;
        }
        changed = true;
        const replacement =
            PUNCTUATION_FALLBACKS[character] ??
            character.normalize("NFKD").replace(REMOVABLE_COMBINING_MARK, "");
        for (const part of replacement) {
            if (!hasGlyph(part)) return null;
        }
        normalized += replacement;
    }
    // Unchanged cues go back verbatim so the layout sees exactly today's input.
    if (!changed) return cue;
    // A decomposition can add spaces (¨ becomes a space plus a mark), and a cue
    // made only of marks normalizes to nothing, which leaves nothing to draw.
    const result = escapeText(normalized);
    return result.length > 0 ? result : null;
}

/** Split entries into those the font can draw, with their normalized cues, and the
 *  ids of those it cannot. Order is preserved, so category bands stay intact and a
 *  band whose every cue is undrawable gets no banner. */
function partitionDrawableEntries(entries: readonly MuralRenderEntry[]): {
    drawable: MuralRenderEntry[];
    undrawableIds: number[];
} {
    const drawable: MuralRenderEntry[] = [];
    const undrawableIds: number[] = [];
    for (const entry of entries) {
        const cue = drawableMuralCue(entry.cue);
        if (cue === null) undrawableIds.push(entry.id);
        else drawable.push(cue === entry.cue ? entry : { ...entry, cue });
    }
    return { drawable, undrawableIds };
}

function banner(category: MuralCategory, roomWidth: number): string {
    const label = ` <${category}> `;
    if (codepoints(label) > roomWidth) {
        // A category name longer than a column is degenerate; hard-truncate the
        // banner rather than throw — the deterministic renderer must never fail
        // the m0 injection over a label width.
        return [...label].slice(0, roomWidth).join("");
    }
    const remaining = roomWidth - codepoints(label);
    return `${"─".repeat(Math.floor(remaining / 2))}${label}${"─".repeat(Math.ceil(remaining / 2))}`;
}

/** Hard-break a single token wider than the column into column-width slices, so
 *  a long verbatim path/hash in a cue can never overrun a line (word-wrap alone
 *  can't split an unbreakable token). */
function breakLongToken(token: string, width: number): string[] {
    const chars = [...token];
    if (chars.length <= width) return [token];
    const slices: string[] = [];
    for (let i = 0; i < chars.length; i += width) {
        slices.push(chars.slice(i, i + width).join(""));
    }
    return slices;
}

/**
 * Word-wrap one cue into bullet lines that fit the selected column width. The
 * first line is bulleted; continuations are indented two spaces so wrapped
 * cues remain visually distinct from the category bars.
 */
function wrapCue(cue: string, width: number): string[] {
    const continuationIndent = "  ";
    const words = escapeText(cue)
        .split(/\s+/)
        .filter(Boolean)
        .flatMap((word) => breakLongToken(word, Math.max(1, width - continuationIndent.length)));
    if (words.length === 0) return ["•"];
    const lines: string[] = [];
    let line = "•";
    for (const word of words) {
        const separator = line === "•" ? "" : " ";
        const candidate = `${line}${separator}${word}`;
        if (codepoints(candidate) <= width) {
            line = candidate;
            continue;
        }
        lines.push(line);
        line = `${continuationIndent}${word}`;
    }
    lines.push(line);
    return lines;
}

interface PlannedLine {
    text: string;
    /** Entry ids whose body starts on this line (two for a shared pair). */
    entryIds: number[];
    isBanner: boolean;
    category: MuralCategory;
}

function canShareCues(cue: string, nextCue: string, roomWidth: number): boolean {
    const shortEntryLimit = Math.floor((roomWidth - 4) / 2);
    const shared = `•${cue} • ${nextCue}`;
    return (
        !cue.includes("⊘") &&
        !nextCue.includes("⊘") &&
        codepoints(cue) <= shortEntryLimit &&
        codepoints(nextCue) <= shortEntryLimit &&
        codepoints(shared) <= roomWidth
    );
}

/**
 * Measure the unwrapped lines for a possible width. Category labels participate
 * in the measurement, while their decorative bars are sized to that width.
 */
function naturalLineLengths(entries: readonly MuralRenderEntry[], roomWidth: number): number[] {
    const lengths: number[] = [];
    let currentCategory: string | null = null;
    for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        if (!entry) continue;
        if (entry.category !== currentCategory) {
            currentCategory = entry.category;
            lengths.push(codepoints(` <${entry.category}> `));
        }

        const cue = escapeText(entry.cue);
        const next = entries[index + 1];
        const sameCategoryNext = next && next.category === entry.category;
        const nextCue = sameCategoryNext ? escapeText(next.cue) : "";
        if (sameCategoryNext && canShareCues(cue, nextCue, roomWidth)) {
            lengths.push(codepoints(`•${cue} • ${nextCue}`));
            index++;
        } else {
            lengths.push(1 + codepoints(cue));
        }
    }
    return lengths;
}

/** Choose the smallest bounded width that leaves only the longest ~5% wrapped. */
function chooseRoomWidth(entries: readonly MuralRenderEntry[]): number {
    for (let width = MURAL_MIN_ROOM_WIDTH; width <= MURAL_ROOM_WIDTH; width++) {
        const lengths = naturalLineLengths(entries, width);
        const allowedWrappedLines = Math.ceil(lengths.length * 0.05);
        const wrappedLines = lengths.filter((length) => length > width).length;
        if (wrappedLines <= allowedWrappedLines) return width;
    }
    return MURAL_ROOM_WIDTH;
}

/**
 * Build the flat line plan for the pre-ordered entries: a category banner at
 * each band boundary, then the entries' cue lines with shared-pair packing (two
 * short non-prohibition cues on one line — a density win) and word-wrap for the
 * rest.
 */
function planLines(entries: readonly MuralRenderEntry[], roomWidth: number): PlannedLine[] {
    const lines: PlannedLine[] = [];
    let currentCategory: string | null = null;
    for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        if (!entry) continue;
        if (entry.category !== currentCategory) {
            currentCategory = entry.category;
            lines.push({
                text: banner(entry.category, roomWidth),
                entryIds: [],
                isBanner: true,
                category: entry.category,
            });
        }

        const cue = escapeText(entry.cue);
        const next = entries[index + 1];
        const sameCategoryNext = next && next.category === entry.category;
        const nextCue = sameCategoryNext ? escapeText(next.cue) : "";
        if (sameCategoryNext && canShareCues(cue, nextCue, roomWidth)) {
            lines.push({
                text: `•${cue} • ${nextCue}`,
                entryIds: [entry.id, next.id],
                isBanner: false,
                category: entry.category,
            });
            index++;
            continue;
        }

        const wrapped = wrapCue(cue, roomWidth);
        wrapped.forEach((text, wrappedIndex) => {
            lines.push({
                text,
                // Only the first wrapped line anchors the entry's placement.
                entryIds: wrappedIndex === 0 ? [entry.id] : [],
                isBanner: false,
                category: entry.category,
            });
        });
    }
    return lines;
}

function splitPlan(plan: readonly PlannedLine[], columnCount: number): PlannedLine[][] {
    const columns: PlannedLine[][] = Array.from({ length: columnCount }, () => []);
    let offset = 0;
    for (let column = 0; column < columnCount && offset < plan.length; column++) {
        const remainingLines = plan.length - offset;
        const remainingColumns = columnCount - column;
        let take = Math.min(MURAL_ROWS, Math.ceil(remainingLines / remainingColumns));

        // Keep a category banner with at least one following body line when a
        // balanced split would otherwise leave the banner at the bottom.
        while (
            offset + take < plan.length &&
            take < MURAL_ROWS &&
            plan[offset + take - 1]?.isBanner
        ) {
            take++;
        }
        // If the cap itself lands on a banner, preserve the old behavior: leave
        // that final row blank instead of rendering an orphaned category header.
        if (take === MURAL_ROWS && plan[offset + take - 1]?.isBanner) take--;
        if (take <= 0) break;

        columns[column] = plan.slice(offset, offset + take);
        offset += take;
    }
    return columns;
}

interface LayoutResult {
    text: string;
    grid: string[][];
    placements: MuralRenderResult["placements"];
    layoutItems: MuralLayoutItem[];
    renderedIds: number[];
    droppedIds: number[];
    usage: Record<string, number>;
    filledLineCount: number;
    columnCount: number;
    rowCount: number;
}

function renderLayout(
    entries: readonly MuralRenderEntry[],
    plan: readonly PlannedLine[],
    roomWidth: number,
    columnCount: number,
): LayoutResult {
    const grid = Array.from({ length: columnCount }, () =>
        Array.from({ length: MURAL_ROWS }, () => ""),
    );
    const placements: MuralRenderResult["placements"] = new Map();
    const layoutItems: MuralLayoutItem[] = [];
    const renderedIds: number[] = [];
    const placedIds = new Set<number>();
    const usage: Record<string, number> = {};
    let filledLineCount = 0;

    for (const [column, columnPlan] of splitPlan(plan, columnCount).entries()) {
        const columnGrid = grid[column];
        if (!columnGrid) continue;
        for (const [row, line] of columnPlan.entries()) {
            columnGrid[row] = line.text;
            filledLineCount += 1;
            usage[line.category] = (usage[line.category] ?? 0) + 1;
            const placementLine = row + 1;
            if (line.isBanner) {
                layoutItems.push({
                    kind: "category",
                    category: line.category,
                    column,
                    startLine: placementLine,
                    endLine: placementLine,
                });
            }
            for (const id of line.entryIds) {
                placements.set(id, {
                    category: line.category,
                    column,
                    line: placementLine,
                });
                if (!placedIds.has(id)) {
                    placedIds.add(id);
                    renderedIds.push(id);
                }
                layoutItems.push({
                    kind: "entry",
                    category: line.category,
                    column,
                    startLine: placementLine,
                    endLine: placementLine,
                });
            }
        }
    }

    const droppedIds = entries.filter((entry) => !placedIds.has(entry.id)).map((entry) => entry.id);
    const usedColumnCount = grid.reduce(
        (last, column, index) => (column.some(Boolean) ? index + 1 : last),
        0,
    );
    const rowCount = grid.reduce((last, column) => {
        for (let row = column.length - 1; row >= 0; row--) {
            if (column[row]) return Math.max(last, row + 1);
        }
        return last;
    }, 0);
    const textLines = Array.from({ length: rowCount }, (_, row) =>
        Array.from({ length: usedColumnCount }, (_, column) =>
            (grid[column]?.[row] ?? "").padEnd(roomWidth),
        ).join(" "),
    );
    return {
        text: `${textLines.join("\n")}\n`,
        grid,
        placements,
        layoutItems,
        renderedIds,
        droppedIds,
        usage,
        filledLineCount,
        columnCount: usedColumnCount,
        rowCount,
    };
}

function crc32(bytes: Uint8Array): number {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
    const typeBytes = new TextEncoder().encode(type);
    const output = new Uint8Array(12 + data.length);
    const view = new DataView(output.buffer);
    view.setUint32(0, data.length);
    output.set(typeBytes, 4);
    output.set(data, 8);
    view.setUint32(8 + data.length, crc32(output.subarray(4, 8 + data.length)));
    return output;
}

function encodeRgbPng(pixels: Uint8Array, width: number, height: number): Uint8Array {
    const raw = new Uint8Array((width * 3 + 1) * height);
    for (let y = 0; y < height; y++) {
        const rawStart = y * (width * 3 + 1);
        raw[rawStart] = 0;
        raw.set(pixels.subarray(y * width * 3, (y + 1) * width * 3), rawStart + 1);
    }
    const ihdr = new Uint8Array(13);
    const header = new DataView(ihdr.buffer);
    header.setUint32(0, width);
    header.setUint32(4, height);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const compressed = new Uint8Array(deflateSync(raw, { level: 9 }));
    const chunks = [
        signature,
        pngChunk("IHDR", ihdr),
        pngChunk("IDAT", compressed),
        pngChunk("IEND", new Uint8Array()),
    ];
    const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.length;
    }
    return output;
}

/** The generated atlas provides real Spleen pixels. Cues with characters outside
 * it are left out before layout (drawableMuralCue); the visible, deterministic
 * replacement glyph remains only as a backstop for banner labels. */
function glyph(character: string): MuralFontGlyph {
    return MURAL_FONT_GLYPHS[character] ?? MURAL_FONT_REPLACEMENT_GLYPH;
}

function drawGlyph(
    pixels: Uint8Array,
    width: number,
    height: number,
    x: number,
    y: number,
    character: string,
    color: readonly [number, number, number],
): void {
    const glyphData = glyph(character);
    const [red, green, blue] = color;
    for (let row = 0; row < MURAL_CELL_HEIGHT; row++) {
        const pattern = glyphData.rows[row] ?? 0;
        for (let column = 0; column < glyphData.width; column++) {
            if ((pattern & (1 << (glyphData.width - column - 1))) === 0) continue;
            const px = x + column;
            const py = y + row;
            if (px < 0 || py < 0 || px >= width || py >= height) continue;
            const offset = (py * width + px) * 3;
            pixels[offset] = red;
            pixels[offset + 1] = green;
            pixels[offset + 2] = blue;
        }
    }
}

function drawText(
    pixels: Uint8Array,
    width: number,
    height: number,
    x: number,
    y: number,
    text: string,
    color: readonly [number, number, number],
): void {
    let offset = 0;
    for (const character of [...text]) {
        drawGlyph(pixels, width, height, x + offset, y, character, color);
        offset += glyph(character).advance;
    }
}

function fillRect(
    pixels: Uint8Array,
    canvasWidth: number,
    canvasHeight: number,
    x: number,
    y: number,
    width: number,
    height: number,
    color: readonly [number, number, number],
): void {
    const [red, green, blue] = color;
    const left = Math.max(0, x);
    const top = Math.max(0, y);
    const right = Math.min(canvasWidth, x + width);
    const bottom = Math.min(canvasHeight, y + height);
    for (let py = top; py < bottom; py++) {
        for (let px = left; px < right; px++) {
            const offset = (py * canvasWidth + px) * 3;
            pixels[offset] = red;
            pixels[offset + 1] = green;
            pixels[offset + 2] = blue;
        }
    }
}

/** Round a content extent up to a complete vision tile without exceeding the cap. */
function snapDimensionToVisionTile(contentPixels: number, maximum: number): number {
    return Math.min(
        maximum,
        Math.max(
            MURAL_VISION_TILE,
            Math.ceil(contentPixels / MURAL_VISION_TILE) * MURAL_VISION_TILE,
        ),
    );
}

/**
 * Plan the deterministic mural layout from a pre-ordered flat entry list without
 * rasterizing or encoding an image. Category bands, bullet lines,
 * shared-pair packing, fitted word-wrap, balanced columns, and prohibition ink
 * are all preserved from the author-era renderer; rooms and merges are gone.
 */
export function planMuralRender(entries: readonly MuralRenderEntry[]) {
    const { drawable, undrawableIds } = partitionDrawableEntries(entries);
    const roomWidth = chooseRoomWidth(drawable);
    const plan = planLines(drawable, roomWidth);
    const candidates = Array.from({ length: MURAL_COLUMNS }, (_, index) => {
        const requestedColumnCount = index + 1;
        const layout = renderLayout(drawable, plan, roomWidth, requestedColumnCount);
        const contentWidth =
            layout.columnCount === 0
                ? 0
                : layout.columnCount * roomWidth * MURAL_CELL_WIDTH +
                  MURAL_COLUMN_GAP * (layout.columnCount - 1) * MURAL_CELL_WIDTH;
        const contentHeight = layout.rowCount * MURAL_LINE_PITCH;
        const width = snapDimensionToVisionTile(contentWidth, MURAL_WIDTH);
        const height = snapDimensionToVisionTile(contentHeight, MURAL_HEIGHT);
        return {
            requestedColumnCount,
            layout,
            width,
            height,
            tileArea: muralImageTokenEstimateForDimensions(width, height),
        };
    });

    // A smaller canvas must not win by silently dropping entries. When no layout
    // can fit the full plan under the hard cap, keep as many entries as possible
    // and then apply the same tile-area optimization.
    const fittingCandidates = candidates.filter(
        (candidate) => candidate.layout.droppedIds.length === 0,
    );
    const candidatesToCompare = fittingCandidates.length > 0 ? fittingCandidates : candidates;
    const firstCandidate = candidatesToCompare[0];
    if (!firstCandidate) throw new Error("mural layout candidate list is empty");
    const selected = candidatesToCompare.reduce((best, candidate) => {
        if (!best) return candidate;
        if (
            fittingCandidates.length === 0 &&
            candidate.layout.renderedIds.length !== best.layout.renderedIds.length
        ) {
            return candidate.layout.renderedIds.length > best.layout.renderedIds.length
                ? candidate
                : best;
        }
        if (candidate.tileArea !== best.tileArea) {
            return candidate.tileArea < best.tileArea ? candidate : best;
        }
        return candidate.requestedColumnCount < best.requestedColumnCount ? candidate : best;
    }, firstCandidate);

    return {
        roomWidth,
        layout: selected.layout,
        width: selected.width,
        height: selected.height,
        undrawableIds,
    };
}

export function rasterMural(plan: ReturnType<typeof planMuralRender>): Uint8Array {
    const { roomWidth, layout, width, height } = plan;
    const pixels = new Uint8Array(width * height * 3).fill(255);
    const contentWidth =
        layout.columnCount === 0
            ? 0
            : layout.columnCount * roomWidth * MURAL_CELL_WIDTH +
              MURAL_COLUMN_GAP * (layout.columnCount - 1) * MURAL_CELL_WIDTH;
    const left = Math.floor((width - contentWidth) / 2);
    for (let column = 0; column < layout.columnCount; column++) {
        for (let row = 0; row < layout.rowCount; row++) {
            const text = layout.grid[column]?.[row] ?? "";
            const isCategory = text.includes("<") && text.includes(">");
            const category = isCategory ? text.match(/<([^>]+)>/)?.[1] : undefined;
            if (isCategory)
                fillRect(
                    pixels,
                    width,
                    height,
                    left + column * (roomWidth + MURAL_COLUMN_GAP) * MURAL_CELL_WIDTH,
                    row * MURAL_LINE_PITCH,
                    roomWidth * MURAL_CELL_WIDTH,
                    MURAL_CELL_HEIGHT,
                    CATEGORY_COLORS[category ?? ""] ?? [72, 78, 86],
                );
            const ink = isCategory
                ? ([255, 255, 255] as const)
                : text.includes("⊘")
                  ? PROHIBITION_INK
                  : BODY_INK;
            drawText(
                pixels,
                width,
                height,
                left + column * (roomWidth + MURAL_COLUMN_GAP) * MURAL_CELL_WIDTH,
                row * MURAL_LINE_PITCH,
                text,
                ink,
            );
        }
    }
    return pixels;
}

export function encodeMuralPng(pixels: Uint8Array, width: number, height: number): Uint8Array {
    return encodeRgbPng(pixels, width, height);
}

export function renderPlannedMural(plan: ReturnType<typeof planMuralRender>): MuralRenderResult {
    const { layout, width, height } = plan;
    const png = encodeMuralPng(rasterMural(plan), width, height);
    const dataUrl = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
    return {
        png,
        dataUrl,
        muralText: layout.text,
        sha256Input: layout.text,
        placements: layout.placements,
        layoutItems: layout.layoutItems,
        renderedIds: layout.renderedIds,
        droppedIds: layout.droppedIds,
        undrawableIds: plan.undrawableIds,
        categoryLineUsage: layout.usage,
        filledLineCount: layout.filledLineCount,
        width,
        height,
    };
}

export function renderMural(entries: readonly MuralRenderEntry[]): MuralRenderResult {
    return renderPlannedMural(planMuralRender(entries));
}

/** Anthropic charges one visual token per 28x28 image patch. */
export function muralImageTokenEstimateForDimensions(width: number, height: number): number {
    return Math.ceil(width / MURAL_VISION_TILE) * Math.ceil(height / MURAL_VISION_TILE);
}

export const muralImageTokenEstimate = muralImageTokenEstimateForDimensions(
    MURAL_WIDTH,
    MURAL_HEIGHT,
);
