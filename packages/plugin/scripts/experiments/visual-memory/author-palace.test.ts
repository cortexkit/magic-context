import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
    authorPalace,
    renderPalace,
    validate,
    ROOM_HEADER_MARKER,
    type SourceMemory,
    type SpecEntry,
} from "./author-palace.ts";

function source(importance: number): SourceMemory[] {
    return [{ id: 1, category: "PROJECT_RULES", importance }];
}

function specs(cue: string, importance = 50): SpecEntry[] {
    return [
        {
            id: 1,
            category: "PROJECT_RULES",
            room: "Hub",
            cue,
            importance,
        },
    ];
}

describe("palace cue budgets", () => {
    test("reports a 200-character cue as a warning", () => {
        expect(validate(source(50), specs("x".repeat(200)))).toEqual([
            "cue over budget for 1: 200 chars (max 50)",
        ]);
    });

    test("uses the source importance to select the cue warning limit", () => {
        expect(validate(source(70), specs("x".repeat(90), 1))).toEqual([]);
        expect(validate(source(69), specs("x".repeat(51), 100))).toEqual([
            "cue over budget for 1: 51 chars (max 50)",
        ]);
    });

    test("allows selected manifests to omit source memories", () => {
        expect(
            validate(
                [
                    { id: 1, category: "PROJECT_RULES", importance: 50 },
                    { id: 2, category: "PROJECT_RULES", importance: 40 },
                ],
                specs("selected"),
            ),
        ).toEqual([]);
    });

    test("keeps duplicate ids hard", () => {
        expect(() =>
            validate(source(50), [
                ...specs("first"),
                { ...specs("second")[0]!, cue: "second" },
            ]),
        ).toThrow("duplicate spec id");
    });
});

describe("single-page newspaper flow", () => {
    test("fills one fixed page with a continuous three-column stream", () => {
        const rendered = renderPalace(
            [...Array(10)].flatMap((_, roomIndex) =>
                [...Array(150)].map((__, entryIndex) => ({
                    id: roomIndex * 150 + entryIndex + 1,
                    category: "PROJECT_RULES" as const,
                    room: `Room ${roomIndex + 1}`,
                    cue: `value-${roomIndex * 150 + entryIndex + 1}`,
                    importance: 100 - roomIndex,
                })),
            ),
        );
        const lines = rendered.palace.trimEnd().split("\n");
        const width = rendered.layoutItems[0] ? 72 : 0;
        const pitch = width + 1;
        expect(rendered.pages).toHaveLength(1);
        expect(lines).toHaveLength(121);
        expect(rendered.layoutItems.filter((item) => item.kind === "category")).toHaveLength(1);
        const occupied = [0, 1, 2].map((column) =>
            lines.filter((line) => line.slice(column * pitch, column * pitch + width).trim()).length,
        );
        expect(occupied.every((count) => count > 0 && count < 121)).toBe(true);
        expect([0, 1, 2].every((column) =>
            lines.at(-1)?.slice(column * pitch, column * pitch + width).trim(),
        )).toBe(true);
    });

    test("never leaves a room header as the last line of a column", () => {
        const rendered = renderPalace(
            [...Array(13)].map((_, index) => ({
                id: index + 1,
                category: "PROJECT_RULES" as const,
                room: `Room ${index + 1}`,
                cue: "`cmd` → ⊘ ∵",
                importance: 50,
            })),
        );
        const lines = rendered.palace.trimEnd().split("\n");
        const width = 72;
        const pitch = width + 1;
        for (const item of rendered.layoutItems) {
            if (item.kind !== "room" || item.continuation) continue;
            expect(item.startLine).toBeLessThan(121);
            const current = lines[item.startLine - 1]?.slice(item.column * pitch, item.column * pitch + width);
            expect(current?.startsWith(ROOM_HEADER_MARKER)).toBe(true);
            const previous =
                item.startLine > 1
                    ? lines[item.startLine - 2]?.slice(item.column * pitch, item.column * pitch + width)
                    : undefined;
            const previousIsCategoryBanner = previous?.includes(`<${item.category}>`) ?? false;
            if (!previousIsCategoryBanner && item.startLine > 1) {
                expect(previous?.trim()).toBe("");
                const beforeGap =
                    item.startLine > 2
                        ? lines[item.startLine - 3]?.slice(item.column * pitch, item.column * pitch + width)
                        : undefined;
                expect(beforeGap?.trim()).not.toBe("");
            }
            const next = lines[item.startLine]?.slice(item.column * pitch, item.column * pitch + width);
            expect(next?.trim()).not.toBe("");
        }
        expect(rendered.palace).not.toMatch(/[╔╗╚╝┌┐└┘│═]{2,}/);
    });

    test("splits a room across columns without dropping its entries", () => {
        const entries = [...Array(300)].map((_, index) => ({
            id: index + 1,
            category: "PROJECT_RULES" as const,
            room: "Long room",
            cue: `value-${index + 1}`,
            importance: 50,
        }));
        const rendered = renderPalace(entries);
        expect(rendered.placements.size).toBe(entries.length);
        expect(rendered.layoutItems.filter((item) => item.kind === "room" && item.continuation).length).toBeGreaterThan(0);
        expect(rendered.palace).toContain("— Long room —");
    });

    test("keeps category-major placement despite a higher-importance later category", () => {
        const rendered = renderPalace([
            { id: 1, category: "PROJECT_RULES", room: "Early low", cue: "policy", importance: 10 },
            { id: 2, category: "ARCHITECTURE", room: "Later high", cue: "policy", importance: 90 },
        ]);
        expect(rendered.layoutItems.find((item) => item.kind === "room")?.category).toBe("PROJECT_RULES");
        expect(rendered.layoutItems.filter((item) => item.kind === "room").map((item) => item.category)).toEqual([
            "PROJECT_RULES",
            "ARCHITECTURE",
        ]);
    });

    test("caps a dominant category at its share plus spill while keeping a small category whole", () => {
        // Only 716 dominant entries fit beside the small category. Four extra
        // entries exercise the same overflow trim without rebuilding hundreds of shorter room layouts.
        const rendered = renderPalace([
            ...Array.from({ length: 720 }, (_, index) => ({
                id: index + 1,
                category: "PROJECT_RULES" as const,
                room: "Dominant",
                cue: `dominant-${index + 1}`,
                importance: 100,
            })),
            ...Array.from({ length: 2 }, (_, index) => ({
                id: 2_000 + index,
                category: "ARCHITECTURE" as const,
                room: "Small",
                cue: `small-${index + 1}`,
                importance: 50,
            })),
        ]);
        const capacity = rendered.pages[0]?.heightCells ? rendered.pages[0].heightCells * 3 : 0;
        const dominantRoomLines = rendered.layoutItems
            .filter((item) => item.kind === "room" && item.category === "PROJECT_RULES")
            .reduce((total, item) => total + item.endLine - item.startLine + 1, 0);
        const smallRoomLines = rendered.layoutItems
            .filter((item) => item.kind === "room" && item.category === "ARCHITECTURE")
            .reduce((total, item) => total + item.endLine - item.startLine + 1, 0);
        expect(rendered.placements.size).toBe(718);
        expect(rendered.droppedByTrimIds).toEqual([717, 718, 719, 720]);
        expect(rendered.droppedBySkipIds).toEqual([]);
        expect(smallRoomLines).toBe(2);
        expect(dominantRoomLines + 1).toBe(capacity - 3);
        expect(rendered.layoutItems.filter((item) => item.kind === "category").map((item) => item.category)).toEqual([
            "PROJECT_RULES",
            "ARCHITECTURE",
        ]);
        expect(rendered.palace.trimEnd().split("\n").at(-1)?.trim()).not.toBe("");
    });

    test("keeps trim and skip sidecar coverage distinct", () => {
        const directory = mkdtempSync(join(tmpdir(), "palace-knapsack-"));
        try {
            const sourceMemories = Array.from({ length: 6 }, (_, index) => ({
                id: index + 1,
                category: "PROJECT_RULES" as const,
                importance: index < 3 ? 90 : 10,
            }));
            const rendered = authorPalace({
                source: sourceMemories,
                specs: [
                    ...[1, 2, 3].map((id) => ({
                        id,
                        category: "PROJECT_RULES" as const,
                        room: "High",
                        cue: "filler ".repeat(1_300),
                        importance: 90,
                    })),
                    ...[4, 5].map((id) => ({
                        id,
                        category: "PROJECT_RULES" as const,
                        room: "Low",
                        cue: "filler ".repeat(2_000),
                        importance: 10,
                    })),
                    { id: 6, category: "PROJECT_RULES" as const, room: "Tiny", cue: "small", importance: 1 },
                ],
                palaceOutput: join(directory, "palace.txt"),
                coverageOutput: join(directory, "coverage.json"),
            });
            const coverage = JSON.parse(readFileSync(join(directory, "coverage.json"), "utf8")) as {
                renderedIds: number[];
                droppedByTrimIds: number[];
                droppedBySkipIds: number[];
                renderedMemoryCount: number;
                droppedMemoryCount: number;
                memories: Record<string, unknown>;
            };
            expect(rendered.coverage.layout.pages).toHaveLength(1);
            expect(coverage.renderedIds).toEqual([1, 2, 6]);
            expect(coverage.droppedByTrimIds).toEqual([3]);
            expect(coverage.droppedBySkipIds).toEqual([4, 5]);
            expect(coverage.renderedMemoryCount).toBe(3);
            expect(coverage.droppedMemoryCount).toBe(3);
            expect(Object.keys(coverage.memories).map(Number).sort((a, b) => a - b)).toEqual([1, 2, 6]);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
