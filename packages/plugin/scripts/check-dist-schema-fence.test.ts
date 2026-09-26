/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LATEST_MIGRATION_VERSION } from "../src/features/magic-context/migrations";
import { checkDistSchemaFence } from "./check-dist-schema-fence";

function dist(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "mc-dist-fence-"));
    for (const [name, text] of Object.entries(files)) {
        const path = join(root, name);
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, text);
    }
    return root;
}

const current = `magic-context-schema-fence=${LATEST_MIGRATION_VERSION}`;

describe("dist schema fence check", () => {
    test("passes when every bundled chunk carries the source fence", () => {
        const plugin = dist({
            "index.js": `log("boot (${current})")`,
            "v2/server.js": `const s = "${current}";`,
            // Source maps quote the source, stale or not; they are never executed.
            "index.js.map": `"magic-context-schema-fence=1"`,
            "index.d.ts": `// magic-context-schema-fence=1`,
        });
        const pi = dist({ "index.mjs": `x("${current}")` });
        try {
            const report = checkDistSchemaFence([plugin, pi], LATEST_MIGRATION_VERSION);
            expect(report.errors).toEqual([]);
            expect(report.ok).toBe(true);
            expect(report.occurrences[plugin]).toHaveLength(2);
        } finally {
            rmSync(plugin, { recursive: true, force: true });
            rmSync(pi, { recursive: true, force: true });
        }
    });

    test("fails a dist with no sentinel at all", () => {
        const plugin = dist({ "index.js": "no fence here" });
        try {
            const report = checkDistSchemaFence([plugin], LATEST_MIGRATION_VERSION);
            expect(report.ok).toBe(false);
            expect(report.errors[0]).toContain("no schema fence sentinel");
        } finally {
            rmSync(plugin, { recursive: true, force: true });
        }
    });

    test("fails when any one chunk disagrees, including a dist built from the previous lane", () => {
        const mixed = dist({
            "index.js": current,
            "chunk-stale.js": "magic-context-schema-fence=91",
        });
        const stale = dist({ "index.js": "magic-context-schema-fence=91" });
        try {
            expect(checkDistSchemaFence([mixed], LATEST_MIGRATION_VERSION).ok).toBe(false);
            const report = checkDistSchemaFence([stale], LATEST_MIGRATION_VERSION);
            expect(report.ok).toBe(false);
            expect(report.errors[0]).toContain("built with schema fence 91");
        } finally {
            rmSync(mixed, { recursive: true, force: true });
            rmSync(stale, { recursive: true, force: true });
        }
    });

    test("fails a missing dist directory rather than skipping it", () => {
        const report = checkDistSchemaFence(
            [join(tmpdir(), "mc-dist-fence-does-not-exist")],
            LATEST_MIGRATION_VERSION,
        );
        expect(report.ok).toBe(false);
    });
});
