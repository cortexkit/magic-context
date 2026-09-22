/**
 * Vendor the four guidance assets from the TS source of truth.
 *
 * The TS side (packages/plugin/src/agents/magic-context-prompt.ts) composes the
 * primary-session guidance; this script re-exports those exact strings as
 * committed text assets so the Rust prompt surface serves byte-identical bytes.
 * Never edit the .txt files by hand.
 *
 * Run:         bun crates/mc-module/gen/gen-guidance.ts
 * Drift check: bun crates/mc-module/gen/gen-guidance.ts --check
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const pluginDir = join(import.meta.dir, "..", "..", "..", "packages", "plugin");
const resolve = (m: string) => Bun.resolveSync(m, pluginDir);
const mod = (await import(
    resolve("./src/agents/magic-context-prompt")
)) as Record<string, unknown>;

const build = mod.buildMagicContextSection as (
    agent: string | null,
    legacyProtectionCount: number,
    ctxReduceCallable?: boolean,
    dreamerEnabled?: boolean,
    temporalAwarenessEnabled?: boolean,
    cavemanTextCompressionEnabled?: boolean,
    subagentMode?: boolean,
    language?: string,
    memoryEnabled?: boolean,
    preset?: "full" | "light",
    primaryOverride?: string,
) => string;
if (typeof build !== "function") {
    throw new Error("buildMagicContextSection not found in magic-context-prompt");
}

// Asset flags mirror the committed Rust assets: primary session, memory +
// dreamer + temporal awareness on, no caveman warning, no language directive.
const assets: [file: string, text: string][] = [
    ["guidance_primary.txt", build(null, 0, true, true, true, false, false, undefined, true, "full")],
    ["guidance_no_reduce.txt", build(null, 0, false, true, true, false, false, undefined, true, "full")],
    ["guidance_light_primary.txt", build(null, 0, true, true, true, false, false, undefined, true, "light")],
    ["guidance_light_no_reduce.txt", build(null, 0, false, true, true, false, false, undefined, true, "light")],
];

const check = process.argv.includes("--check");
let drifted = false;
for (const [file, text] of assets) {
    const path = join(import.meta.dir, "..", "assets", file);
    if (check) {
        if (!existsSync(path) || readFileSync(path, "utf8") !== text) {
            console.error(`guidance asset drift: ${file}; run bun crates/mc-module/gen/gen-guidance.ts`);
            drifted = true;
        }
    } else {
        writeFileSync(path, text);
        console.log(`vendored ${file}`);
    }
}
if (drifted) process.exit(1);