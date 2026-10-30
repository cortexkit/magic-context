import "./quiet-live-log";
/**
 * Vendor the historian SYSTEM prompt from the TS source of truth.
 *
 * The TS side generates historian-prompt.generated.ts from historian-prompt.source.md;
 * this script re-exports that exact string as a committed text asset so the Rust
 * producer sends byte-identical system-prompt bytes. Never edit the .txt by hand.
 *
 * Run:         bun crates/mc-module/gen/gen-historian-system-prompt.ts
 * Drift check: bun crates/mc-module/gen/gen-historian-system-prompt.ts --check
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const pluginDir = join(import.meta.dir, "..", "..", "..", "packages", "plugin");
const resolve = (m: string) => Bun.resolveSync(m, pluginDir);
const mod = (await import(
    resolve("./src/hooks/magic-context/historian-prompt.generated")
)) as Record<string, unknown>;

for (const [name, artifact] of [
    ["COMPARTMENT_AGENT_SYSTEM_PROMPT", "historian-system-prompt.txt"],
    ["COMPARTMENT_AGENT_COMBINED_SYSTEM_PROMPT", "historian-system-prompt-combined.txt"],
]) {
    const prompt = mod[name];
    if (typeof prompt !== "string" || prompt.length < 10_000)
        throw new Error(`missing historian rendering: ${name}`);
    const path = join(import.meta.dir, "..", "testdata", artifact);
    if (process.argv.includes("--check")) {
        if (!existsSync(path) || readFileSync(path, "utf8") !== prompt) {
            throw new Error(
                `historian system prompt drift (${artifact}); run bun crates/mc-module/gen/gen-historian-system-prompt.ts`,
            );
        }
    } else {
        writeFileSync(path, prompt);
    }
}
console.log("historian system prompts: 2 renderings checked");
