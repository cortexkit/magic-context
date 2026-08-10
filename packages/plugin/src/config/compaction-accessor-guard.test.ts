import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// isCompactionEnabled (config/agent-disable.ts) is the ONLY non-schema reader
// of the `compaction.enabled` config path. Every gate site (pi-plugin, cli,
// plugin boot, session hooks) must IMPORT it and never re-derive the value.
// This guard asserts no other source file reads `compaction.enabled` or
// `compaction?.enabled` directly. Precedent: the runMigrations import guard
// (packages/cli/src/lib/migration-import-guard.test.ts).
//
// The schema file (config/schema/magic-context.ts) is the single producer of
// the path and is excluded; the accessor file (config/agent-disable.ts) is the
// single consumer and is excluded. The storage helpers read a DB column
// (compaction_mode_record), not the config path, so they are not in scope.

const REPOSITORY_ROOT = resolve(import.meta.dir, "../../../..");
const SOURCE_ROOTS = ["packages/cli/src", "packages/plugin/src", "packages/pi-plugin/src"];

const ALLOWED_READERS = new Set<string>([
    // The accessor itself — the one permitted non-schema reader.
    "packages/plugin/src/config/agent-disable.ts",
    // The Zod schema that defines the path.
    "packages/plugin/src/config/schema/magic-context.ts",
    // project-security.ts references the path NAME in a warning string when it
    // strips the project-tier field; it never reads the parsed config path.
    // The strip operates on a raw Record<string, unknown> by key name, not on
    // a parsed MagicContextConfig.
    "packages/plugin/src/config/project-security.ts",
    // OMP's own setting key appears only as an external CLI string literal;
    // these files never read Magic Context's parsed compaction config.
    "packages/cli/src/lib/omp-helpers.ts",
    "packages/cli/src/commands/setup-omp.ts",
    "packages/cli/src/commands/doctor-omp.ts",
]);

function sourceFiles(directory: string): string[] {
    const result: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            result.push(...sourceFiles(path));
        } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
            result.push(path);
        }
    }
    return result;
}

// Conservatively matches the textual token `compaction.enabled` or
// `compaction?.enabled`, including string literals. False positives are
// allow-listed only after confirming they do not read Magic Context's parsed
// config path.
// It does NOT match the DB column `compaction_mode_record`, the accessor name
// `isCompactionEnabled`, or the schema's own `.object({ enabled: ... })`.
const COMPACTION_ENABLED_READ = /\bcompaction\??\s*\.\s*enabled\b(?!_)/;

describe("compaction.enabled accessor exclusivity (issue #266)", () => {
    it("no non-schema source file reads compaction.enabled directly", () => {
        const offenders: string[] = [];
        for (const root of SOURCE_ROOTS) {
            for (const path of sourceFiles(resolve(REPOSITORY_ROOT, root))) {
                const relativePath = relative(REPOSITORY_ROOT, path);
                if (ALLOWED_READERS.has(relativePath)) continue;
                const source = readFileSync(path, "utf8");
                if (COMPACTION_ENABLED_READ.test(source)) {
                    offenders.push(relativePath);
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it("isCompactionEnabled is exported from the accessor module", async () => {
        const mod = await import("../config/agent-disable");
        expect(typeof mod.isCompactionEnabled).toBe("function");
    });

    it("isCompactionEnabled resolves default-on for absent block and explicit true, off for false", async () => {
        const { isCompactionEnabled } = await import("../config/agent-disable");
        expect(isCompactionEnabled({})).toBe(true);
        expect(isCompactionEnabled({ compaction: {} })).toBe(true);
        expect(isCompactionEnabled({ compaction: { enabled: true } })).toBe(true);
        expect(isCompactionEnabled({ compaction: { enabled: false } })).toBe(false);
        expect(isCompactionEnabled({ compaction: null })).toBe(true);
    });
});
