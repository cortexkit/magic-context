/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    clearCompressionDepth,
    closeDatabase,
    getAverageCompressionDepth,
    getMaxCompressionDepth,
    incrementCompressionDepth,
    openDatabase,
} from "./storage";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

function useTempDataHome(prefix: string): void {
    process.env.XDG_DATA_HOME = makeTempDir(prefix);
}

afterEach(() => {
    closeDatabase();
    process.env.XDG_DATA_HOME = originalXdgDataHome;

    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
});

describe("compression-depth-storage", () => {
    it("increments depth across a range and treats missing ordinals as zero in averages", () => {
        useTempDataHome("compression-depth-range-");
        const db = openDatabase();

        incrementCompressionDepth(db, "ses-depth", 2, 4);

        expect(getAverageCompressionDepth(db, "ses-depth", 1, 4)).toBe(0.75);
        expect(getAverageCompressionDepth(db, "ses-depth", 2, 4)).toBe(1);
        expect(getMaxCompressionDepth(db, "ses-depth")).toBe(1);
    });

    it("accumulates repeated compression passes", () => {
        useTempDataHome("compression-depth-repeat-");
        const db = openDatabase();

        incrementCompressionDepth(db, "ses-depth", 1, 3);
        incrementCompressionDepth(db, "ses-depth", 2, 4);

        expect(getAverageCompressionDepth(db, "ses-depth", 1, 4)).toBe(1.5);
        expect(getMaxCompressionDepth(db, "ses-depth")).toBe(2);
    });

    it("clears session depth rows", () => {
        useTempDataHome("compression-depth-clear-");
        const db = openDatabase();

        incrementCompressionDepth(db, "ses-depth", 1, 5);
        clearCompressionDepth(db, "ses-depth");

        expect(getAverageCompressionDepth(db, "ses-depth", 1, 5)).toBe(0);
        expect(getMaxCompressionDepth(db, "ses-depth")).toBe(0);
    });
});
