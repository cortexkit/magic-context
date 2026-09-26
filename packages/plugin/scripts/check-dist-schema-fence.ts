/// <reference types="bun-types" />

/**
 * Fail a release build whose bundled chunks carry a schema fence other than the one in
 * this source tree.
 *
 * The plugin and the Rust module agree on `context.db` through its migration lane, and
 * a restart that loads a stale bundle next to a newer module (or the reverse) opens the
 * file under the wrong fence. Every bundle carries `SCHEMA_FENCE_SENTINEL`
 * (`magic-context-schema-fence=<n>`), inlined once per independently bundled output
 * that reaches it. This check reads the chunk bytes and requires, in each dist
 * directory, at least one occurrence and every occurrence equal to the source
 * `LATEST_MIGRATION_VERSION`.
 *
 *   bun packages/plugin/scripts/check-dist-schema-fence.ts [distDir ...]
 *
 * With no arguments it checks the plugin and Pi plugin dists.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { LATEST_MIGRATION_VERSION } from "../src/features/magic-context/migrations";

const SENTINEL_PATTERN = /magic-context-schema-fence=(\d+)/g;

export interface DistSchemaFenceReport {
    ok: boolean;
    /** Occurrences found per dist directory, as `file: value`. */
    occurrences: Record<string, Array<{ file: string; value: number }>>;
    errors: string[];
}

function chunkFiles(dir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
            files.push(...chunkFiles(path));
        } else if (/\.(m?js)$/.test(entry) && !entry.endsWith(".d.ts")) {
            // Source maps (.map) and declarations are not executed, so they cannot
            // disagree with what runs.
            files.push(path);
        }
    }
    return files;
}

export function checkDistSchemaFence(
    distDirs: readonly string[],
    expected: number,
): DistSchemaFenceReport {
    const report: DistSchemaFenceReport = { ok: true, occurrences: {}, errors: [] };
    for (const dir of distDirs) {
        const found: Array<{ file: string; value: number }> = [];
        let files: string[];
        try {
            files = chunkFiles(dir);
        } catch (error) {
            report.errors.push(
                `${dir}: cannot read the dist directory (${error instanceof Error ? error.message : String(error)})`,
            );
            continue;
        }
        for (const file of files) {
            const text = readFileSync(file, "utf8");
            for (const match of text.matchAll(SENTINEL_PATTERN)) {
                found.push({ file, value: Number(match[1]) });
            }
        }
        report.occurrences[dir] = found;
        if (found.length === 0) {
            report.errors.push(`${dir}: no schema fence sentinel in any built chunk`);
        }
        for (const { file, value } of found) {
            if (value !== expected) {
                report.errors.push(
                    `${file}: built with schema fence ${value}, but this source tree's latest migration is ${expected}`,
                );
            }
        }
    }
    report.ok = report.errors.length === 0;
    return report;
}

if (import.meta.main) {
    const repoRoot = resolve(import.meta.dir, "../../..");
    const dirs =
        process.argv.length > 2
            ? process.argv.slice(2)
            : [join(repoRoot, "packages/plugin/dist"), join(repoRoot, "packages/pi-plugin/dist")];
    const report = checkDistSchemaFence(dirs, LATEST_MIGRATION_VERSION);
    if (!report.ok) {
        for (const error of report.errors) console.error(`dist schema fence: ${error}`);
        process.exit(1);
    }
    const counts = Object.entries(report.occurrences)
        .map(([dir, found]) => `${dir}=${found.length}`)
        .join(", ");
    console.log(`dist schema fence OK: v${LATEST_MIGRATION_VERSION} (${counts})`);
}
