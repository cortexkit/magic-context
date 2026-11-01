import "./quiet-live-log";
/**
 * Vendor the historian reference-seed corpus for the Rust prompt builder.
 *
 * Run:        bun crates/mc-module/gen/gen-reference-seeds.ts
 * Drift check: bun crates/mc-module/gen/gen-reference-seeds.ts --check
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const pluginDir = join(import.meta.dir, "..", "..", "..", "packages", "plugin");
const resolve = (m: string) => Bun.resolveSync(m, pluginDir);

const seedsMod = await import(resolve("./src/hooks/magic-context/reference-seeds.generated"));
const { REFERENCE_SEEDS } = seedsMod as {
    REFERENCE_SEEDS: ReadonlyArray<{ importance: number; block: string }>;
};

const vendored = REFERENCE_SEEDS.map((seed) => ({
    importance: seed.importance,
    block: seed.block,
}));
const rendered = `${JSON.stringify(vendored, null, 2)}\n`;
const outPath = join(import.meta.dir, "..", "testdata", "reference-seeds.json");

if (process.argv.includes("--check")) {
    if (!existsSync(outPath)) {
        console.error(`missing vendored reference seeds: ${outPath}`);
        process.exit(1);
    }
    const current = readFileSync(outPath, "utf8");
    if (current !== rendered) {
        console.error(`reference seed corpus drifted; regenerate ${outPath}`);
        process.exit(1);
    }
    console.log(`reference seed corpus up to date: ${outPath}`);
} else {
    writeFileSync(outPath, rendered);
    console.log(`wrote ${vendored.length} reference seeds → ${outPath}`);
}
